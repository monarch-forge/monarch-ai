/**
 * Obsidian-compatible memory vault: markdown files under settings.memory.vaultDir.
 *  - note id = relative path without ".md" (subfolders allowed), title = frontmatter title || basename
 *  - in-memory index (rebuilt at startup, refreshed by a debounced recursive fs.watch for external edits)
 *  - wikilinks resolve by id, then case-insensitive id / basename / title
 *  - deletes move files to <vault>/.trash (Obsidian's own trash folder), never hard-delete
 */
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MemoryGraph, MemoryNote, MemoryNoteSummary } from '@monarch/shared';
import { HttpError, activity, changed, dataStore, nowIso, paths } from '../../kernel.ts';
import { getSettings, onSettingsChanged } from '../../settings.ts';
import {
  extractInlineTags,
  extractLinks,
  frontmatterTags,
  normalizeTag,
  parseFrontmatter,
  plainText,
  stringifyNote,
  uniqTags,
  type Frontmatter,
} from './markdown.ts';

/* ─────────────── state ─────────────── */

interface Indexed {
  id: string;
  title: string;
  body: string;
  tags: string[];
  links: string[];
  createdAt: string;
  updatedAt: string;
  source: 'user' | 'agent';
  mtimeMs: number;
  size: number;
  fm: Frontmatter;
}

const notes = new Map<string, Indexed>();
let dir = '';
let watcher: FSWatcher | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let ready: Promise<void> | null = null;
let version = 0;
let settingsUnsub: (() => void) | null = null;

const meta = dataStore<{ seeded: string[] }>('memory-meta', { seeded: [] });

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.stfolder']);

/* ─────────────── paths & ids ─────────────── */

export function configuredVaultDir(): string {
  let d = getSettings().memory?.vaultDir?.trim() || paths.vault;
  if (d === '~' || d.startsWith('~/')) d = join(homedir(), d.slice(1));
  return resolve(d);
}

export function currentVaultDir(): string {
  return dir || configuredVaultDir();
}

/** normalize & validate a note id (relative path without .md). Throws HttpError(400) on traversal / bad input. */
export function normalizeId(raw: string): string {
  let s = String(raw ?? '').normalize('NFC').replace(/\\/g, '/').trim();
  if (s.includes('\0')) throw new HttpError(400, 'Invalid note id');
  s = s.replace(/\.md$/i, '').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s) throw new HttpError(400, 'Note id is required');
  const segs = s.split('/').map((x) => x.trim());
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') throw new HttpError(400, `Invalid note path "${raw}" (no "." or ".." segments)`);
    if (seg.startsWith('.')) throw new HttpError(400, `Invalid note path "${raw}" (hidden files/folders are not allowed)`);
  }
  const clean = segs.map((seg) => seg.replace(/[:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ')).join('/');
  if (clean.length > 200) throw new HttpError(400, 'Note path is too long');
  return clean;
}

function fileFor(id: string): string {
  const root = currentVaultDir();
  const p = resolve(root, `${id}.md`);
  const rel = relative(root, p);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new HttpError(400, 'Note path escapes the vault');
  return p;
}

/** guard against symlinked folders that point outside the vault */
async function assertRealInside(p: string): Promise<void> {
  const root = await realpath(currentVaultDir());
  let d = dirname(p);
  while (!existsSync(d)) d = dirname(d);
  const real = await realpath(d);
  if (real !== root && !real.startsWith(root + sep)) throw new HttpError(400, 'Note path escapes the vault');
}

const idFromFile = (root: string, file: string) => relative(root, file).split(sep).join('/').replace(/\.md$/i, '');

/* ─────────────── parse / index ─────────────── */

function validIso(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function indexFromSource(id: string, src: string, st: { mtimeMs: number; birthtimeMs: number; size: number }): Indexed {
  const { data, body } = parseFrontmatter(src);
  const fmTitle = typeof data.title === 'string' ? data.title.trim() : '';
  const mtimeIso = new Date(st.mtimeMs).toISOString();
  const fmUpdated = validIso(data.updated ?? data.modified);
  const created = validIso(data.created ?? data.date) ?? new Date(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs).toISOString();
  return {
    id,
    title: fmTitle || basename(id),
    body,
    tags: uniqTags([...frontmatterTags(data), ...extractInlineTags(body)]),
    links: extractLinks(body),
    createdAt: created,
    // trust our own `updated` stamp unless the file was modified well after it (external edit, e.g. Obsidian);
    // fs mtimes use a coarse clock, so tiny differences are noise
    updatedAt: fmUpdated && st.mtimeMs - Date.parse(fmUpdated) < 2000 ? fmUpdated : mtimeIso,
    source: data.source === 'agent' ? 'agent' : 'user',
    mtimeMs: st.mtimeMs,
    size: st.size,
    fm: data,
  };
}

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(join(root, r));
  }
  return out;
}

/**
 * (re)scan the vault; re-reads files whose mtime/size changed, plus any ids in `force`
 * (paths reported by the watcher — fs mtimes are coarse, so a quick rewrite may keep the same mtime).
 * Returns true if the index changed.
 */
export async function scan(force?: Set<string>): Promise<boolean> {
  const root = currentVaultDir();
  const files = await walk(root);
  const seen = new Set<string>();
  let dirty = false;
  for (const f of files) {
    const id = idFromFile(root, f);
    seen.add(id);
    try {
      const st = await stat(f);
      const cur = notes.get(id);
      if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size && !force?.has(id)) continue;
      const next = indexFromSource(id, await readFile(f, 'utf8'), st);
      if (cur && cur.body === next.body && cur.mtimeMs === next.mtimeMs && JSON.stringify(cur.fm) === JSON.stringify(next.fm)) continue;
      notes.set(id, next);
      dirty = true;
    } catch {
      /* vanished mid-scan */
    }
  }
  for (const id of [...notes.keys()]) {
    if (!seen.has(id)) {
      notes.delete(id);
      dirty = true;
    }
  }
  if (dirty) version++;
  return dirty;
}

/* ─────────────── link resolution ─────────────── */

let lookupVersion = -1;
let byLowerId = new Map<string, string>();
let byLowerName = new Map<string, string[]>();
let backlinkMap = new Map<string, Set<string>>();

function buildLookups(): void {
  if (lookupVersion === version) return;
  byLowerId = new Map();
  byLowerName = new Map();
  const addName = (k: string, id: string) => {
    const arr = byLowerName.get(k);
    if (arr) {
      if (!arr.includes(id)) arr.push(id);
    } else byLowerName.set(k, [id]);
  };
  for (const n of notes.values()) {
    byLowerId.set(n.id.toLowerCase(), n.id);
    addName(basename(n.id).toLowerCase(), n.id);
    addName(n.title.toLowerCase(), n.id);
  }
  // prefer shortest path for ambiguous basenames (Obsidian behaviour)
  for (const arr of byLowerName.values()) arr.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  backlinkMap = new Map();
  for (const n of notes.values()) {
    for (const l of n.links) {
      const t = resolveLinkRaw(l);
      if (!t || t === n.id) continue;
      let s = backlinkMap.get(t);
      if (!s) backlinkMap.set(t, (s = new Set()));
      s.add(n.id);
    }
  }
  lookupVersion = version;
}

function resolveLinkRaw(target: string): string | undefined {
  const t = target.trim().replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\/+/, '');
  if (!t) return undefined;
  if (notes.has(t)) return t;
  const lower = t.toLowerCase();
  return byLowerId.get(lower) ?? byLowerName.get(lower)?.[0] ?? byLowerName.get(basename(lower))?.[0];
}

/** resolve a link target / id / title to an existing note id */
export function resolveLink(target: string): string | undefined {
  buildLookups();
  return resolveLinkRaw(target);
}

function backlinksOf(id: string): string[] {
  buildLookups();
  return [...(backlinkMap.get(id) ?? [])].sort();
}

/* ─────────────── conversion ─────────────── */

function toNote(n: Indexed): MemoryNote {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    tags: n.tags,
    links: n.links,
    backlinks: backlinksOf(n.id),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    source: n.source,
  };
}

function excerptOf(n: Indexed, terms: string[] = []): string {
  const text = plainText(n.body);
  if (!text) return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || at < 60) return text.length > 180 ? `${text.slice(0, 180).trimEnd()}…` : text;
  const start = Math.max(0, at - 60);
  const s = text.slice(start, start + 180).trim();
  return `…${s}${start + 180 < text.length ? '…' : ''}`;
}

function toSummary(n: Indexed, terms?: string[]): MemoryNoteSummary {
  return { id: n.id, title: n.title, tags: n.tags, excerpt: excerptOf(n, terms), updatedAt: n.updatedAt, linkCount: n.links.length };
}

/* ─────────────── lifecycle ─────────────── */

const touched = new Set<string>();

function startWatcher(): void {
  stopWatcher();
  const schedule = () => {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const force = new Set(touched);
      touched.clear();
      scan(force)
        .then((dirtied) => {
          if (dirtied) changed('memory');
        })
        .catch((e) => console.warn('[memory] rescan failed', e));
    }, 300);
    scanTimer.unref?.();
  };
  try {
    watcher = watch(dir, { recursive: true, persistent: false }, (_ev, file) => {
      const f = String(file ?? '');
      if (f && (f.split(/[\\/]/).some((seg) => seg.startsWith('.')) || !(f.toLowerCase().endsWith('.md') || !f.includes('.')))) return;
      if (f.toLowerCase().endsWith('.md')) touched.add(f.split(sep).join('/').replace(/\.md$/i, ''));
      schedule();
    });
    watcher.on('error', (e) => {
      console.warn('[memory] watcher error, falling back to polling', e);
      stopWatcher();
      pollTimer = setInterval(schedule, 15_000);
      pollTimer.unref?.();
    });
  } catch (e) {
    console.warn('[memory] fs.watch unavailable, polling every 15s', e);
    pollTimer = setInterval(schedule, 15_000);
    pollTimer.unref?.();
  }
}

function stopWatcher(): void {
  watcher?.close();
  watcher = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function openVault(target: string): Promise<void> {
  stopWatcher();
  dir = target;
  mkdirSync(dir, { recursive: true });
  notes.clear();
  version++;
  await scan();
  if (notes.size === 0 && !meta.get().seeded.includes(dir)) {
    await seedVault();
    meta.update((m) => {
      m.seeded.push(dir);
    });
  }
  startWatcher();
}

/** initialize once (idempotent); subsequent calls await the same promise */
export function ensureVault(): Promise<void> {
  if (!ready) {
    ready = openVault(configuredVaultDir()).catch((e) => {
      ready = null;
      throw e;
    });
    settingsUnsub ??= onSettingsChanged(() => {
      const next = configuredVaultDir();
      if (next !== dir) {
        ready = openVault(next)
          .then(() => {
            changed('memory');
            activity('MEM', `Memory vault switched to ${next}`);
          })
          .catch((e) => {
            console.error('[memory] could not open vault', e);
            activity('ERR', `Could not open memory vault ${next}: ${(e as Error).message}`, 'error');
          });
      }
    });
  }
  return ready;
}

/** stop watching (tests / shutdown) */
export function closeVault(): void {
  stopWatcher();
  if (scanTimer) clearTimeout(scanTimer);
  settingsUnsub?.();
  settingsUnsub = null;
  ready = null;
}

/* ─────────────── seed ─────────────── */

async function seedVault(): Promise<void> {
  const now = nowIso();
  const seeds: { id: string; tags: string[]; body: string }[] = [
    {
      id: 'Monarch/About Monarch',
      tags: ['monarch'],
      body: `# About Monarch

This folder is Monarch's **long-term memory** — a plain-markdown vault you can also open in [Obsidian](https://obsidian.md).

- Every note is a \`.md\` file; folders become note paths (e.g. \`People/Me\`).
- Link notes with \`[[wikilinks]]\` (also \`[[Note|alias]]\` and \`[[Note#Heading]]\`) and tag them with \`#tags\` or frontmatter \`tags\`.
- Monarch reads [[People/Me|your profile]] and any note tagged \`#pinned\` before every conversation, and remembers new facts here on its own.
- Edit freely — changes you make in Obsidian or any editor are picked up automatically.

See also: [[Memory conventions]].
`,
    },
    {
      id: 'People/Me',
      tags: ['person', 'profile'],
      body: `# Me

Fill this in — Monarch reads it at the start of every conversation. Keep it short and factual.

## Basics
- Name:
- Location / timezone:
- Work / role:

## Preferences
- How I like answers:
- Tools & stack I use:

## People
- (e.g. \`[[People/Pepper Potts]]\` — partner)

## Ongoing
- (projects, goals, things to keep in mind)

Related: [[About Monarch]]
`,
    },
    {
      id: 'Monarch/Memory conventions',
      tags: ['monarch'],
      body: `# Memory conventions

How Monarch organises this vault:

- \`People/<Name>\` — one note per person (tag \`#person\`), linked from [[People/Me]].
- \`Projects/<Name>\` — goals, status, decisions (tag \`#project\`).
- \`Notes/<Topic>\` — anything else worth remembering.
- \`#pinned\` — always included in Monarch's context; use sparingly.
- Frontmatter \`source: agent\` marks notes Monarch wrote; \`source: user\` notes are yours.

Back to [[About Monarch]].
`,
    },
  ];
  for (const s of seeds) {
    const fm: Frontmatter = { tags: s.tags, created: now, updated: now, source: 'agent' };
    const file = fileFor(s.id);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, stringifyNote(fm, s.body), 'utf8');
  }
  await scan();
  activity('MEM', 'Memory vault initialised with starter notes');
}

/* ─────────────── queries ─────────────── */

export async function getNote(ref: string): Promise<MemoryNote> {
  await ensureVault();
  const id = notes.has(ref) ? ref : resolveLink(ref) ?? (() => {
    try {
      return resolveLink(normalizeId(ref));
    } catch {
      return undefined;
    }
  })();
  const n = id ? notes.get(id) : undefined;
  if (!n) throw new HttpError(404, `Memory note not found: ${ref}`);
  return toNote(n);
}

export async function noteExists(ref: string): Promise<string | undefined> {
  await ensureVault();
  return resolveLink(ref);
}

export async function recentNotes(limit = 10): Promise<MemoryNoteSummary[]> {
  await ensureVault();
  return [...notes.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((n) => toSummary(n));
}

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < 50; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** scored full-text search. `#tag` terms filter by tag. Empty query → most recently updated. */
export async function searchNotes(q: string | undefined, limit = 30): Promise<MemoryNoteSummary[]> {
  await ensureVault();
  const query = (q ?? '').trim();
  if (!query) return recentNotes(limit);
  const tokens = query.toLowerCase().match(/"[^"]+"|\S+/g) ?? [];
  const tagFilters = tokens.filter((t) => t.startsWith('#') && t.length > 1).map((t) => normalizeTag(t).toLowerCase());
  const terms = tokens.filter((t) => !t.startsWith('#')).map((t) => t.replace(/^"|"$/g, '')).filter(Boolean);
  const phrase = terms.join(' ');
  const scored: { n: Indexed; score: number }[] = [];
  for (const n of notes.values()) {
    const tagsLower = n.tags.map((t) => t.toLowerCase());
    if (tagFilters.length && !tagFilters.every((f) => tagsLower.some((t) => t === f || t.startsWith(`${f}/`)))) continue;
    const title = n.title.toLowerCase();
    const idLower = n.id.toLowerCase();
    const body = n.body.toLowerCase();
    let score = tagFilters.length ? 1 : 0;
    let matched = 0;
    for (const t of terms) {
      let s = 0;
      if (title === t) s += 25;
      else if (title.includes(t)) s += title.split(/[\s/_-]+/).some((w) => w.startsWith(t)) ? 12 : 8;
      if (tagsLower.some((x) => x === t)) s += 8;
      else if (tagsLower.some((x) => x.includes(t))) s += 4;
      if (idLower.includes(t) && !title.includes(t)) s += 3;
      const c = count(body, t);
      if (c) s += 1 + Math.min(c, 10) * 0.8;
      if (s > 0) matched++;
      score += s;
    }
    if (terms.length && matched === 0) continue;
    if (terms.length > 1) {
      score *= matched / terms.length; // favour notes matching every term
      if (phrase && (body.includes(phrase) || title.includes(phrase))) score += 10;
    }
    // light recency tie-break (≤ 1 point within ~30 days)
    const ageDays = (Date.now() - Date.parse(n.updatedAt)) / 86_400_000;
    score += Math.max(0, 1 - ageDays / 30);
    if (score > 0) scored.push({ n, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.n.updatedAt.localeCompare(a.n.updatedAt))
    .slice(0, limit)
    .map(({ n }) => toSummary(n, terms));
}

export async function getGraph(): Promise<MemoryGraph> {
  await ensureVault();
  buildLookups();
  const nodes = new Map<string, MemoryGraph['nodes'][number]>();
  const edges: MemoryGraph['edges'] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (source: string, target: string, kind: 'link' | 'tag') => {
    const k = kind === 'link' ? [source, target].sort().join('\u0000') + kind : `${source}\u0000${target}${kind}`;
    if (source === target || edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ source, target, kind });
  };
  for (const n of notes.values()) nodes.set(n.id, { id: n.id, title: n.title, tags: n.tags, degree: 0, kind: 'note' });
  for (const n of notes.values()) {
    for (const l of n.links) {
      const t = resolveLinkRaw(l);
      if (t) addEdge(n.id, t, 'link');
      else {
        const gid = `ghost:${l.toLowerCase()}`;
        if (!nodes.has(gid)) nodes.set(gid, { id: gid, title: l, tags: [], degree: 0, kind: 'ghost' });
        addEdge(n.id, gid, 'link');
      }
    }
    for (const tag of n.tags) {
      const tid = `tag:${tag.toLowerCase()}`;
      if (!nodes.has(tid)) nodes.set(tid, { id: tid, title: `#${tag}`, tags: [], degree: 0, kind: 'tag' });
      addEdge(n.id, tid, 'tag');
    }
  }
  for (const e of edges) {
    nodes.get(e.source)!.degree++;
    nodes.get(e.target)!.degree++;
  }
  return { nodes: [...nodes.values()], edges };
}

/* ─────────────── writes ─────────────── */

export interface WriteNoteInput {
  title?: string;
  body: string;
  tags?: string[];
  source?: 'user' | 'agent';
}

async function persist(id: string, fm: Frontmatter, body: string): Promise<Indexed> {
  const file = fileFor(id);
  await assertRealInside(file);
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  await writeFile(tmp, stringifyNote(fm, body), 'utf8');
  await rename(tmp, file);
  const st = await stat(file);
  const src = await readFile(file, 'utf8');
  const n = indexFromSource(id, src, st);
  notes.set(id, n);
  version++;
  return n;
}

function buildFrontmatter(existing: Indexed | undefined, id: string, input: { title?: string; tags?: string[]; source?: 'user' | 'agent' }): Frontmatter {
  const now = nowIso();
  const fm: Frontmatter = existing ? { ...existing.fm } : {};
  const title = input.title?.trim();
  if (title && title !== basename(id)) fm.title = title;
  else if (title && fm.title) delete fm.title;
  if (input.tags) fm.tags = uniqTags(input.tags);
  else if (!existing) fm.tags = [];
  if (fm.tag !== undefined && input.tags) delete fm.tag;
  fm.created = typeof fm.created === 'string' && validIso(fm.created) ? fm.created : (existing?.createdAt ?? now);
  fm.updated = now;
  fm.source = typeof fm.source === 'string' && fm.source ? fm.source : (input.source ?? 'user');
  return fm;
}

/** create or replace a note's body (frontmatter extra keys and created date are preserved) */
export async function putNote(rawId: string, input: WriteNoteInput): Promise<MemoryNote> {
  await ensureVault();
  const id = normalizeId(rawId);
  if (typeof input.body !== 'string') throw new HttpError(400, 'body (string) is required');
  const existing = notes.get(id) ?? (() => {
    const r = resolveLink(id);
    return r && r.toLowerCase() === id.toLowerCase() ? notes.get(r) : undefined;
  })();
  const targetId = existing?.id ?? id;
  const n = await persist(targetId, buildFrontmatter(existing, targetId, input), input.body);
  changed('memory');
  activity('MEM', `${existing ? 'Updated' : 'Created'} note "${n.title}"${input.source === 'agent' ? ' (agent)' : ''}`);
  return toNote(n);
}

/** append text to a note (creating it if needed) */
export async function appendNote(rawRef: string, text: string, opts: { tags?: string[]; title?: string; source?: 'user' | 'agent' } = {}): Promise<MemoryNote> {
  await ensureVault();
  const existingId = notes.has(rawRef) ? rawRef : resolveLink(rawRef);
  const existing = existingId ? notes.get(existingId) : undefined;
  if (!existing) return putNote(rawRef, { title: opts.title, body: text.trim() + '\n', tags: opts.tags, source: opts.source });
  const body = `${existing.body.replace(/\s+$/, '')}\n\n${text.trim()}\n`;
  const tags = opts.tags?.length ? uniqTags([...(frontmatterTags(existing.fm)), ...opts.tags]) : undefined;
  const n = await persist(existing.id, buildFrontmatter(existing, existing.id, { tags, source: opts.source }), body);
  changed('memory');
  activity('MEM', `Appended to note "${n.title}"`);
  return toNote(n);
}

/** move a note to <vault>/.trash (recoverable, Obsidian-compatible) */
export async function deleteNote(ref: string): Promise<{ id: string; trashedTo: string }> {
  await ensureVault();
  const id = notes.has(ref) ? ref : resolveLink(ref);
  if (!id) throw new HttpError(404, `Memory note not found: ${ref}`);
  const file = fileFor(id);
  await assertRealInside(file);
  const trashDir = join(currentVaultDir(), '.trash');
  await mkdir(trashDir, { recursive: true });
  let dest = join(trashDir, basename(file));
  if (existsSync(dest)) dest = join(trashDir, `${basename(file, '.md')} ${Date.now()}.md`);
  await rename(file, dest);
  const title = notes.get(id)?.title ?? id;
  notes.delete(id);
  version++;
  changed('memory');
  activity('MEM', `Deleted note "${title}" (moved to .trash)`);
  return { id, trashedTo: relative(currentVaultDir(), dest).split(sep).join('/') };
}

/** the shortest unambiguous wikilink text for a note id */
export function linkTextFor(id: string): string {
  buildLookups();
  const base = basename(id);
  const owners = byLowerName.get(base.toLowerCase()) ?? [];
  return owners.length <= 1 || owners[0] === id ? base : id;
}

/** append `- [[to]] — context` under a "## Related" section of `from` */
export async function linkNotes(fromRef: string, toRef: string, context?: string, source: 'user' | 'agent' = 'agent'): Promise<{ note: MemoryNote; alreadyLinked: boolean; targetExists: boolean }> {
  await ensureVault();
  const fromId = notes.has(fromRef) ? fromRef : resolveLink(fromRef);
  if (!fromId) throw new HttpError(404, `Memory note not found: ${fromRef}`);
  const from = notes.get(fromId)!;
  const toId = resolveLink(toRef);
  if (toId === fromId) throw new HttpError(400, 'Cannot link a note to itself');
  if (toId && from.links.some((l) => resolveLink(l) === toId)) return { note: toNote(from), alreadyLinked: true, targetExists: true };
  const linkText = toId ? linkTextFor(toId) : normalizeId(toRef);
  const line = `- [[${linkText}]]${context?.trim() ? ` — ${context.trim().replace(/\s*\n\s*/g, ' ')}` : ''}`;
  const lines = from.body.replace(/\s+$/, '').split('\n');
  const hIdx = lines.findIndex((l) => /^##\s+related\s*$/i.test(l.trim()));
  let body: string;
  if (hIdx < 0) {
    body = `${lines.join('\n')}\n\n## Related\n${line}\n`;
  } else {
    let end = lines.findIndex((l, i) => i > hIdx && /^#{1,2}\s/.test(l));
    if (end < 0) end = lines.length;
    let ins = end;
    while (ins > hIdx + 1 && !lines[ins - 1].trim()) ins--;
    lines.splice(ins, 0, line);
    body = `${lines.join('\n')}\n`;
  }
  const n = await persist(from.id, buildFrontmatter(from, from.id, { source }), body);
  changed('memory');
  activity('MEM', `Linked "${from.title}" → [[${linkText}]]`);
  return { note: toNote(n), alreadyLinked: false, targetExists: !!toId };
}

/* ─────────────── prompt context ─────────────── */

function compact(body: string, max: number): string {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*[-*]\s*[^:]{1,40}:\s*$/.test(l)) // empty template fields "- Name:"
    .filter((l) => !/^\s*[-*]\s*\(.*\)\s*$/.test(l)) // placeholder bullets "- (e.g. …)"
    .filter((l) => !/^\s*fill this in/i.test(l))
    .filter((l) => !/^\s*related:/i.test(l))
    .join('\n')
    .replace(/^#{1,6}\s+(.*)$/gm, '$1:')
    .replace(/\n{2,}/g, '\n')
    .trim();
  // drop headings that ended up with nothing under them
  const lines = cleaned.split('\n');
  const kept = lines.filter((l, i) => !(l.endsWith(':') && (i === lines.length - 1 || lines[i + 1].endsWith(':'))));
  const s = kept.join('\n').trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

export async function promptContext(maxChars = 2000): Promise<string> {
  await ensureVault();
  if (!notes.size) return '';
  const parts: string[] = [];
  let budget = maxChars - 120;
  const meId = resolveLink('People/Me');
  if (meId) {
    const me = compact(notes.get(meId)!.body, Math.min(800, budget));
    if (me) {
      parts.push(`About the user (from [[${meId}]]):\n${me}`);
      budget -= me.length + 40;
    }
  }
  const pinned = [...notes.values()]
    .filter((n) => n.id !== meId && n.tags.some((t) => t.toLowerCase() === 'pinned'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const p of pinned) {
    if (budget < 150) break;
    const c = compact(p.body, Math.min(400, budget - 40));
    parts.push(`Pinned — ${p.title} [[${p.id}]]:\n${c}`);
    budget -= c.length + p.title.length + 20;
  }
  const recent = [...notes.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  if (recent.length && budget > 80) {
    const lines: string[] = [];
    for (const r of recent) {
      const l = `- ${r.title}${r.id !== r.title ? ` (${r.id})` : ''}${r.tags.length ? ` #${r.tags.slice(0, 3).join(' #')}` : ''}`;
      if (budget - l.length < 0) break;
      lines.push(l);
      budget -= l.length + 1;
    }
    if (lines.length) parts.push(`Recently updated notes:\n${lines.join('\n')}`);
  }
  const out = `Memory vault (${notes.size} notes; use memory_search / memory_read for details, memory_write to remember new facts):\n\n${parts.join('\n\n')}`;
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

export function noteCount(): number {
  return notes.size;
}
