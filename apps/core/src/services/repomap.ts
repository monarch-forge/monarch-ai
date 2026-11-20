/**
 * Repo map (Aider-style, lightweight): tracked files + their key symbols (regex per language), so small coding
 * models can find where things live instead of wandering. Cached per repo in Monarch's data dir (never in the
 * repo); rebuilt when HEAD changes, re-parsing only files whose git blob changed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { paths } from '../kernel.ts';

/** [symbol, 1-based line] */
export type Sym = [string, number];
export interface MapFile {
  p: string;
  sha: string;
  s: Sym[];
}
export interface RepoMap {
  repo: string;
  head: string;
  builtAt: string;
  files: MapFile[];
  /** recently changed paths, most recent first */
  recent: string[];
  /** true when the file list was cut at MAX_FILES */
  truncated?: boolean;
}

const MAX_FILES = 8000; // files listed; beyond this the map is cut (recent + matching paths still work)
const MAX_PARSE_BYTES = 256 * 1024;
const BUILD_BUDGET_MS = 8000;
const MAX_SYMS_PER_FILE = 40;

const SKIP_DIR = /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.next|\.nuxt|coverage|__pycache__|\.venv|venv|Pods|generated|gen)\//;
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$|\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tgz|bz2|xz|7z|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|flac|psd|sqlite|db|pyc)$/i;

/* ─────────────── symbol extraction ─────────────── */

type Rule = RegExp[];
const TS: Rule = [
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/,
  /^(?:const|let)\s+([A-Z][\w$]*)\s*[:=]/, // top-level PascalCase consts (React components)
];
const PY: Rule = [/^(?:async\s+)?def\s+(\w+)/, /^class\s+(\w+)/];
const GO: Rule = [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/];
const RS: Rule = [
  /^\s*pub(?:\([^)]*\))?\s+(?:const\s+|async\s+|unsafe\s+)*(?:fn|struct|enum|trait|type|mod|const|static)\s+(\w+)/,
  /^impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([\w]+)/,
];
const JAVA: Rule = [
  /^\s*(?:public\s+|protected\s+|private\s+|internal\s+)?(?:abstract\s+|final\s+|sealed\s+|data\s+|open\s+|static\s+|enum\s+(?=class))*(?:class|interface|enum|object|record)\s+(\w+)/,
  /^\s+public\s+(?:static\s+|final\s+|synchronized\s+|abstract\s+)*[\w<>[\],.? ]+\s+(\w+)\s*\(/,
  /^\s*(?:public\s+|override\s+|suspend\s+|internal\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/,
];
const RULES: Record<string, Rule> = { ts: TS, tsx: TS, js: TS, jsx: TS, mjs: TS, cjs: TS, mts: TS, cts: TS, py: PY, go: GO, rs: RS, java: JAVA, kt: JAVA, kts: JAVA };

/** key symbols of one file (by extension); unknown languages → none */
export function extractSymbols(path: string, src: string): Sym[] {
  const rules = RULES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
  if (!rules) return [];
  const out: Sym[] = [];
  const seen = new Set<string>();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_SYMS_PER_FILE; i++) {
    const l = lines[i];
    if (!l || l.length > 400) continue;
    for (const re of rules) {
      const m = re.exec(l);
      if (m?.[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push([m[1], i + 1]);
        break;
      }
    }
  }
  return out;
}

/* ─────────────── build + cache ─────────────── */

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((res) => {
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => res(err ? null : out));
  });
}

const cacheDir = () => join(paths.data, 'repomap');
const cacheFile = (repo: string) => join(cacheDir(), `${createHash('sha1').update(repo).digest('hex').slice(0, 16)}.json`);
const mem = new Map<string, RepoMap>();
const inflight = new Map<string, Promise<RepoMap | null>>();

function loadCache(repo: string): RepoMap | null {
  const m = mem.get(repo);
  if (m) return m;
  try {
    const f = cacheFile(repo);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RepoMap) : null;
  } catch {
    return null;
  }
}

/**
 * Map of the git repo at `repo` (its root). Cached until HEAD moves; unchanged blobs are reused.
 * shortcut: reflects committed blobs' paths but parses the working-tree file; uncommitted new files are not listed until committed.
 */
export async function getRepoMap(repo: string): Promise<RepoMap | null> {
  const head = (await git(repo, ['rev-parse', 'HEAD']))?.trim();
  if (!head) return null;
  const prev = loadCache(repo);
  if (prev && prev.head === head) return mem.set(repo, prev), prev;
  let p = inflight.get(repo);
  if (!p) {
    p = build(repo, head, prev).finally(() => inflight.delete(repo));
    inflight.set(repo, p);
  }
  return p;
}

async function build(repo: string, head: string, prev: RepoMap | null): Promise<RepoMap | null> {
  const ls = await git(repo, ['ls-files', '-s', '-z']);
  if (ls == null) return null;
  const old = new Map((prev?.files ?? []).map((f) => [f.p, f]));
  const started = Date.now();
  const entries = ls
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf('\t');
      const [mode, sha] = e.slice(0, tab).split(' ');
      return { p: e.slice(tab + 1), sha, mode };
    })
    .filter((e) => e.mode !== '160000' && !SKIP_DIR.test(e.p) && !SKIP_FILE.test(e.p));
  const truncated = entries.length > MAX_FILES;
  const files: MapFile[] = [];
  for (const e of entries.slice(0, MAX_FILES)) {
    const o = old.get(e.p);
    if (o && o.sha === e.sha) {
      files.push(o);
      continue;
    }
    let s: Sym[] = [];
    if (RULES[e.p.slice(e.p.lastIndexOf('.') + 1).toLowerCase()] && Date.now() - started < BUILD_BUDGET_MS) {
      const buf = await readFile(join(repo, e.p)).catch(() => null);
      if (buf && buf.length > MAX_PARSE_BYTES) continue; // huge (likely generated): leave it out
      if (buf) s = extractSymbols(e.p, buf.toString('utf8'));
    }
    files.push({ p: e.p, sha: e.sha, s });
  }
  const log = (await git(repo, ['log', '-n', '40', '--name-only', '--format=']))?.split('\n').filter(Boolean) ?? [];
  const map: RepoMap = { repo, head, builtAt: new Date().toISOString(), files, recent: [...new Set(log)].slice(0, 60), ...(truncated ? { truncated } : {}) };
  mem.set(repo, map);
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile(repo), JSON.stringify(map));
  } catch {
    /* cache is best-effort */
  }
  return map;
}

/* ─────────────── ranking + slices ─────────────── */

const STOP = new Set('the and for with that this from into when then than make makes add adds use using fix fixes should would could have has not but are was were will can all any its our your you some more also file files code new please want need like just only into out about which what where there their them they does done each very via set get run runs main app api test tests type types data util utils index page item list show start'.split(' '));

/** lowercase search terms from free text: words + camelCase/snake parts, ≥3 chars, no stop words */
export function terms(text: string): string[] {
  // whole identifiers (runCheck → runcheck) plus their camelCase/snake parts (run, check)
  const words = text.split(/[^A-Za-z0-9]+/).flatMap((w) => [w.toLowerCase(), ...w.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ')]);
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 30);
}

const ENTRY = /^(index|main|app|server|cli|kernel|mod|lib|__main__|__init__|manage|program|application)\.[a-z]+$/i;
const TESTY = /(^|\/)(tests?|__tests__|spec|fixtures?)\/|\.(test|spec)\.[a-z]+$|_test\.go$/;

export interface Ranked {
  f: MapFile;
  score: number;
  /** symbols that matched the query (shown first) */
  hits: Sym[];
}

export function rankFiles(map: Pick<RepoMap, 'files' | 'recent'>, query: string): Ranked[] {
  const q = terms(query);
  const recent = new Map(map.recent.map((p, i) => [p, i]));
  const out: Ranked[] = [];
  for (const f of map.files) {
    const lp = f.p.toLowerCase();
    let score = 0;
    const hits: Sym[] = [];
    for (const t of q) {
      if (lp.includes(t)) score += basename(lp).includes(t) ? 4 : 2;
    }
    if (q.length) {
      for (const sym of f.s) {
        const ls = sym[0].toLowerCase();
        const parts = terms(sym[0]);
        if (q.includes(ls)) {
          score += 6;
          hits.push(sym);
        } else if (parts.some((p) => q.includes(p))) {
          score += 1.5;
          hits.push(sym);
        }
      }
    }
    const r = recent.get(f.p);
    if (r !== undefined) score += 2 * (1 - r / Math.max(60, map.recent.length));
    if (ENTRY.test(basename(f.p))) score += 1.5;
    if (f.s.length) score += 0.3;
    if (TESTY.test(f.p)) score *= 0.6;
    if (score > 0) out.push({ f, score, hits });
  }
  return out.sort((a, b) => b.score - a.score || a.f.p.localeCompare(b.f.p));
}

/** ≈ tokens for budget checks (4 chars/token) */
export const estTokens = (s: string) => Math.ceil(s.length / 4);

/** compact "path: sym1, sym2, …" lines for the best files, within `budgetTokens` */
export function mapSlice(map: Pick<RepoMap, 'files' | 'recent'>, query: string, budgetTokens = 600): string {
  const lines: string[] = [];
  let used = 0;
  for (const r of rankFiles(map, query)) {
    const hitNames = new Set(r.hits.map((h) => h[0]));
    const syms = [...r.hits, ...r.f.s.filter((s) => !hitNames.has(s[0]))].slice(0, 8).map((s) => s[0]);
    const more = r.f.s.length > syms.length ? ', …' : '';
    const line = syms.length ? `${r.f.p}: ${syms.join(', ')}${more}` : r.f.p;
    const t = estTokens(line) + 1;
    if (used + t > budgetTokens) {
      if (used > budgetTokens * 0.9) break;
      continue; // a shorter line may still fit
    }
    lines.push(line);
    used += t;
    if (lines.length >= 40) break;
  }
  return lines.join('\n');
}

/** repo_map tool: files/symbols matching `query` (and/or under `path`), with line numbers */
export function searchMap(map: RepoMap, opts: { query?: string; path?: string; limit?: number }): string {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 60);
  const pfx = opts.path?.replace(/^\.\//, '').replace(/\/+$/, '');
  const scoped = pfx ? { files: map.files.filter((f) => f.p === pfx || f.p.startsWith(`${pfx}/`)), recent: map.recent } : map;
  if (!scoped.files.length) return `No tracked files under "${opts.path}".`;
  const q = opts.query?.trim() ?? '';
  // exact symbol definitions first: the usual question is "where is X defined"
  const exact: string[] = [];
  if (q && !/\s/.test(q)) {
    const lq = q.toLowerCase();
    for (const f of scoped.files) for (const [n, l] of f.s) if (n.toLowerCase() === lq) exact.push(`${f.p}:${l} ${n}`);
  }
  const ranked = q ? rankFiles(scoped, q) : rankFiles(scoped, '').concat(pfx ? scoped.files.map((f) => ({ f, score: 0, hits: [] })) : []);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of ranked) {
    if (seen.has(r.f.p)) continue;
    seen.add(r.f.p);
    const hitNames = new Set(r.hits.map((h) => h[0]));
    const syms = [...r.hits, ...r.f.s.filter((s) => !hitNames.has(s[0]))].slice(0, 12).map(([n, l]) => `${n}:${l}`);
    lines.push(syms.length ? `${r.f.p} — ${syms.join(', ')}` : r.f.p);
    if (lines.length >= limit) break;
  }
  if (!lines.length && !exact.length) return `Nothing in the repo map matches "${q}". Try other words, or grep for text inside files.`;
  const head = exact.length ? [`Defined at: ${exact.slice(0, 10).join('; ')}`, ''] : [];
  return [...head, ...lines, ...(map.truncated ? ['(map cut at 8000 files)'] : [])].join('\n');
}
