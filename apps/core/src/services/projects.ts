/**
 * Projects (folders holding several repos) and repo profiles: stack, commands, CI commands, layout, ports,
 * env keys — detected from the repo's own files (no AGENTS.md needed) and rebuilt whenever git HEAD moves.
 * Profiles live in Monarch's data dir; nothing is written into the repos.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Project, ProjectView, RepoCommands, RepoProfile } from '@monarch/shared';
import { changed, HttpError, newId, nowIso } from '../kernel.ts';
import { serviceStore } from './persist.ts';
import { expandHome } from './workspace.ts';
import { getRepoMap, mapSlice } from './repomap.ts';

const projects = serviceStore<Project[]>('projects', []);
const profiles = serviceStore<Record<string, RepoProfile>>('repo-profiles', {});
/** user-chosen check commands by repo path (survive rescans) */
const checkOverrides = serviceStore<Record<string, string>>('repo-checks', {});

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', 'coverage']);

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((res) => execFile('git', args, { cwd, timeout: 5000 }, (err, out) => res(err ? null : out.trim())));
}

const read = (p: string, max = 200_000) =>
  readFile(p, 'utf8')
    .then((t) => t.slice(0, max))
    .catch(() => null);

/** repo root containing `p` (nearest .git), or null */
/** approval target key for the git repo containing p (undefined outside a repo) */
export function repoTarget(p: string): string | undefined {
  const root = repoRootOf(p);
  return root ? `repo:${root}` : undefined;
}

export function repoRootOf(p: string): string | null {
  let cur = resolve(expandHome(p));
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** git repos at `root` or up to two levels below it */
async function discoverRepos(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number) {
    if (existsSync(join(dir, '.git'))) {
      out.push(dir);
      if (depth > 0) return; // nested repos inside a repo are its own business
    }
    if (depth >= 2) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), depth + 1);
  }
  await walk(root, 0);
  return out.sort();
}

/* ─────────────── detection ─────────────── */

const CI_SKIP = /\b(install|ci\b|checkout|upload|download|deploy|publish|login|docker (build|push)|cache|setup-|echo|cd |export |mkdir|curl|wget|apt|brew|chmod|git (config|fetch|tag))\b/i;
const CI_KEEP = /\b(test|lint|check|typecheck|tsc|vet|clippy|build|fmt|format|pytest|ruff|mypy|eslint|jest|vitest|go test|cargo|gradle|mvn|make)\b/i;

/** `run:` / `script:` lines from GitHub Actions and GitLab CI that look like checks */
async function ciCommands(repo: string): Promise<string[]> {
  const files: string[] = [];
  const wf = join(repo, '.github', 'workflows');
  try {
    for (const f of await readdir(wf)) if (/\.ya?ml$/.test(f)) files.push(join(wf, f));
  } catch {
    /* none */
  }
  if (existsSync(join(repo, '.gitlab-ci.yml'))) files.push(join(repo, '.gitlab-ci.yml'));
  const cmds: string[] = [];
  for (const f of files.slice(0, 10)) {
    const text = (await read(f, 100_000)) ?? '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(?:-\s*)?run:\s*(.*)$/) ?? lines[i].match(/^\s*-\s+(?!name:|uses:|with:)(.+)$/);
      if (!m) continue;
      let cmd = m[1].trim();
      if (cmd === '|' || cmd === '>') {
        // block scalar: take the indented lines that follow
        const indent = (lines[i + 1]?.match(/^\s*/)?.[0].length ?? 0) || 1;
        const block: string[] = [];
        for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || (lines[j].match(/^\s*/)?.[0].length ?? 0) >= indent); j++) block.push(lines[j].trim());
        for (const b of block) if (b) cmds.push(b);
        continue;
      }
      cmd = cmd.replace(/^["']|["']$/g, '');
      if (cmd) cmds.push(cmd);
    }
  }
  return [...new Set(cmds.filter((c) => CI_KEEP.test(c) && !CI_SKIP.test(c) && !c.includes('${{')))].slice(0, 12);
}

function pmRun(pm: string, script: string): string {
  return pm === 'npm' ? (script === 'test' ? 'npm test' : `npm run ${script}`) : `${pm} ${script}`;
}

async function detect(repo: string): Promise<Omit<RepoProfile, 'head' | 'branch' | 'scannedAt' | 'check' | 'checkSource'>> {
  const stack = new Set<string>();
  const commands: RepoCommands = {};
  let packageManager: string | undefined;
  const has = (f: string) => existsSync(join(repo, f));

  const pkgText = await read(join(repo, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
      if (typeof pkg.packageManager === 'string') packageManager = pkg.packageManager.split('@')[0] || packageManager;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      stack.add(deps.typescript || has('tsconfig.json') ? 'TypeScript' : 'JavaScript');
      for (const [dep, label] of [
        ['next', 'Next.js'],
        ['react', 'React'],
        ['vue', 'Vue'],
        ['svelte', 'Svelte'],
        ['@angular/core', 'Angular'],
        ['preact', 'Preact'],
        ['express', 'Express'],
        ['@nestjs/core', 'NestJS'],
        ['fastify', 'Fastify'],
        ['hono', 'Hono'],
        ['vite', 'Vite'],
        ['prisma', 'Prisma'],
        ['jest', 'Jest'],
        ['vitest', 'Vitest'],
      ] as const)
        if (deps[dep]) stack.add(label);
      const scripts: Record<string, string> = pkg.scripts ?? {};
      const pick = (...names: string[]) => names.find((n) => scripts[n]);
      const pm = packageManager ?? 'npm';
      commands.install = pm === 'npm' ? (has('package-lock.json') ? 'npm ci' : 'npm install') : `${pm} install`;
      for (const [k, names] of [
        ['build', ['build']],
        ['test', ['test', 'test:unit']],
        ['lint', ['lint']],
        ['typecheck', ['typecheck', 'type-check', 'tsc', 'check-types', 'check']],
        ['dev', ['dev', 'start:dev', 'start']],
      ] as const) {
        const n = pick(...names);
        // npm's placeholder test script fails on purpose: not a real test command
        if (n && !(k === 'test' && /no test specified/.test(scripts[n]))) commands[k] = pmRun(pm, n);
      }
    } catch {
      /* invalid package.json */
    }
  }
  if (has('go.mod')) {
    stack.add('Go');
    commands.build ??= 'go build ./...';
    commands.test ??= 'go test ./...';
    commands.lint ??= 'go vet ./...';
  }
  if (has('Cargo.toml')) {
    stack.add('Rust');
    commands.build ??= 'cargo build';
    commands.test ??= 'cargo test';
    commands.lint ??= 'cargo clippy';
  }
  const py = has('pyproject.toml') || has('requirements.txt') || has('setup.py');
  if (py) {
    stack.add('Python');
    const pyproject = (await read(join(repo, 'pyproject.toml'))) ?? '';
    const reqs = (await read(join(repo, 'requirements.txt'))) ?? '';
    const all = pyproject + reqs;
    if (/\bdjango\b/i.test(all)) stack.add('Django');
    if (/\bfastapi\b/i.test(all)) stack.add('FastAPI');
    if (/\bflask\b/i.test(all)) stack.add('Flask');
    const runner = has('uv.lock') ? 'uv run ' : has('poetry.lock') ? 'poetry run ' : '';
    commands.install ??= has('uv.lock') ? 'uv sync' : has('poetry.lock') ? 'poetry install' : has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .';
    if (/pytest/i.test(all) || has('pytest.ini') || has('tests')) commands.test ??= `${runner}pytest`;
    if (/\bruff\b/i.test(all)) commands.lint ??= `${runner}ruff check .`;
    if (/\bmypy\b/i.test(all)) commands.typecheck ??= `${runner}mypy .`;
  }
  if (has('pom.xml')) {
    stack.add('Java (Maven)');
    commands.build ??= 'mvn -q package -DskipTests';
    commands.test ??= 'mvn -q test';
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    stack.add('Gradle');
    const gw = has('gradlew') ? './gradlew' : 'gradle';
    commands.build ??= `${gw} build -x test`;
    commands.test ??= `${gw} test`;
  }
  if (has('Gemfile')) {
    stack.add('Ruby');
    commands.test ??= has('spec') ? 'bundle exec rspec' : 'bundle exec rake test';
  }
  if (has('composer.json')) stack.add('PHP');
  if (has('Dockerfile')) stack.add('Docker');

  const make = await read(join(repo, 'Makefile'));
  if (make) {
    const targets = new Set([...make.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)].map((m) => m[1]));
    for (const k of ['test', 'lint', 'build'] as const) if (targets.has(k)) commands[k] ??= `make ${k}`;
    if (targets.has('check')) commands.typecheck ??= 'make check';
  }

  // docker compose: services + host ports
  const services: string[] = [];
  const ports = new Set<string>();
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const t = await read(join(repo, f));
    if (!t) continue;
    const block = t.split(/^services:\s*$/m)[1] ?? '';
    for (const m of block.matchAll(/^ {2}([a-zA-Z0-9_.-]+):\s*$/gm)) services.push(m[1]);
    for (const m of t.matchAll(/["']?(\d{2,5}):\d{2,5}["']?/g)) ports.add(m[1]);
  }

  // env keys from the example file (names only)
  const envKeys: string[] = [];
  for (const f of ['.env.example', '.env.sample', '.env.template', 'example.env']) {
    const t = await read(join(repo, f), 50_000);
    if (!t) continue;
    for (const m of t.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)) envKeys.push(m[1]);
    for (const m of t.matchAll(/^\s*(?:PORT|[A-Z_]*_PORT)\s*=\s*(\d{2,5})/gm)) ports.add(m[1]);
    break;
  }

  let layout: string[] = [];
  try {
    layout = (await readdir(repo, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => `${e.name}/`)
      .sort()
      .slice(0, 30);
  } catch {
    /* unreadable */
  }

  let readme: string | undefined;
  for (const f of ['README.md', 'readme.md', 'README.rst', 'README']) {
    const t = await read(join(repo, f), 20_000);
    if (!t) continue;
    // first prose paragraph(s), without badges/headings/html
    const prose = t
      .split('\n')
      .filter((l) => l.trim() && !/^\s*(#|!\[|\[!\[|<|```|---|===)/.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 500);
    if (prose) readme = prose;
    break;
  }

  return {
    path: repo,
    name: basename(repo),
    stack: [...stack],
    packageManager,
    commands,
    ciCommands: await ciCommands(repo),
    layout,
    ports: [...ports].slice(0, 12),
    envKeys: [...new Set(envKeys)].slice(0, 40),
    services: [...new Set(services)].slice(0, 20),
    readme,
  };
}

/** fast, local commands a worker can run after every change (tests included when they exist) */
function detectedCheck(c: RepoCommands): string | undefined {
  const parts = [c.typecheck ?? c.lint, c.test].filter(Boolean) as string[];
  return parts.length ? parts.join(' && ') : c.build;
}

/* ─────────────── profiles ─────────────── */

const inflight = new Map<string, Promise<RepoProfile>>();

/** profile for the repo at (or containing) `path`; rebuilt when HEAD moved (or daily without git). `force` always rebuilds. */
export async function getRepoProfile(path: string, force = false): Promise<RepoProfile | null> {
  const repo = repoRootOf(path);
  if (!repo) return null;
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const cur = profiles.get()[repo];
  const fresh = cur && !force && cur.head === head && (head || Date.now() - Date.parse(cur.scannedAt) < 86400e3);
  if (fresh) return withCheck(cur);
  let p = inflight.get(repo);
  if (!p) {
    p = (async () => {
      const d = await detect(repo);
      const prof: RepoProfile = { ...d, head, branch: (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? undefined, scannedAt: nowIso() };
      profiles.update((m) => {
        m[repo] = prof;
      });
      changed('projects');
      return prof;
    })().finally(() => inflight.delete(repo));
    inflight.set(repo, p);
  }
  return withCheck(await p);
}

function withCheck(p: RepoProfile): RepoProfile {
  const user = checkOverrides.get()[p.path];
  if (user) return { ...p, check: user, checkSource: 'user' };
  const d = detectedCheck(p.commands);
  return d ? { ...p, check: d, checkSource: 'detected' } : { ...p, check: undefined, checkSource: undefined };
}

export function setRepoCheck(path: string, check: string): RepoProfile {
  const repo = repoRootOf(path);
  if (!repo) throw new HttpError(404, `not a git repo: ${path}`);
  checkOverrides.update((m) => {
    if (check.trim()) m[repo] = check.trim();
    else delete m[repo];
  });
  changed('projects');
  const cur = profiles.get()[repo];
  if (!cur) throw new HttpError(404, 'repo not scanned yet');
  return withCheck(cur);
}

/* ─────────────── projects ─────────────── */

export async function listProjects(): Promise<ProjectView[]> {
  return Promise.all(projects.get().map((p) => projectView(p)));
}

async function projectView(p: Project, force = false): Promise<ProjectView> {
  const repos = await discoverRepos(p.root);
  const profs = (await Promise.all(repos.map((r) => getRepoProfile(r, force).catch(() => null)))).filter(Boolean) as RepoProfile[];
  return { ...p, repos: profs };
}

export async function addProject(input: { name?: string; root?: string }): Promise<ProjectView> {
  const raw = input.root?.trim();
  if (!raw) throw new HttpError(400, 'root folder is required');
  const root = resolve(expandHome(raw));
  try {
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, `not a folder: ${root}`);
  }
  if (projects.get().some((p) => p.root === root)) throw new HttpError(409, `already added: ${root}`);
  const p: Project = { id: newId(), name: input.name?.trim() || basename(root), root, createdAt: nowIso() };
  const view = await projectView(p);
  if (!view.repos.length) throw new HttpError(400, `no git repositories found in ${root} (looked two levels deep)`);
  projects.update((a) => {
    a.push(p);
  });
  changed('projects');
  return view;
}

export function removeProject(id: string): void {
  if (!projects.get().some((p) => p.id === id)) throw new HttpError(404, `project ${id} not found`);
  projects.update((a) => {
    const i = a.findIndex((p) => p.id === id);
    if (i >= 0) a.splice(i, 1);
  });
  changed('projects');
}

export async function rescanProject(id: string): Promise<ProjectView> {
  const p = projects.get().find((x) => x.id === id);
  if (!p) throw new HttpError(404, `project ${id} not found`);
  return projectView(p, true);
}

/** project whose root contains `path` */
export function projectOf(path: string): Project | undefined {
  const abs = resolve(expandHome(path));
  return projects.get().find((p) => abs === p.root || abs.startsWith(`${p.root}/`));
}

/* ─────────────── prompt text ─────────────── */

export function formatProfile(p: RepoProfile, full = true): string {
  const cmds = Object.entries(p.commands)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: \`${v}\``)
    .join(' · ');
  const lines = [`${p.name} (${p.path})${p.stack.length ? ` — ${p.stack.join(', ')}` : ''}${p.branch ? ` · branch ${p.branch}` : ''}`];
  if (full && p.readme) lines.push(`About: ${p.readme.slice(0, 300)}`);
  if (cmds) lines.push(`Commands: ${cmds}`);
  if (full && p.ciCommands.length) lines.push(`CI runs: ${p.ciCommands.map((c) => `\`${c}\``).join(', ')}`);
  if (p.check) lines.push(`Check before done: \`${p.check}\``);
  if (full && p.layout.length) lines.push(`Top-level dirs: ${p.layout.join(' ')}`);
  if (full && p.services.length) lines.push(`Compose services: ${p.services.join(', ')}`);
  if (full && p.ports.length) lines.push(`Ports: ${p.ports.join(', ')}`);
  if (full && p.envKeys.length) lines.push(`Env vars (.env example): ${p.envKeys.slice(0, 25).join(', ')}`);
  return lines.join('\n');
}

/** prompt section for a worker in `cwd`: its repo profile + the other repos of its project */
export async function workerContext(cwd: string, task = ''): Promise<string> {
  const out: string[] = [];
  const prof = await getRepoProfile(cwd).catch(() => null);
  const proj = projectOf(cwd);
  if (prof) out.push('## This repository (detected by Monarch from its files; may be incomplete)', formatProfile(prof));
  // repo map slice for the task (deterministic per task + HEAD, so the prompt stays cache-stable); a slow first build is skipped
  const map = prof ? await Promise.race([getRepoMap(prof.path).catch(() => null), new Promise<null>((r) => setTimeout(r, 2500, null))]) : null;
  const slice = map ? mapSlice(map, task, 600) : '';
  if (slice) out.push('', '## Repo map (likely relevant files: key symbols)', slice);
  if (proj) {
    const view = await projectView(proj).catch(() => null);
    const others = (view?.repos ?? []).filter((r) => r.path !== prof?.path);
    if (others.length) out.push('', `## Other repos in project "${proj.name}" (${proj.root})`, ...others.map((r) => `- ${formatProfile(r, false).replace(/\n/g, ' · ')}`));
  }
  return out.join('\n');
}

/** one-line-per-repo list of projects for the manager prompt */
export function projectsBrief(): string {
  const map = profiles.get();
  return projects
    .get()
    .map((p) => {
      const repos = Object.values(map).filter((r) => r.path === p.root || r.path.startsWith(`${p.root}/`));
      return `- ${p.name} (${p.root}): ${repos.map((r) => `${r.name}${r.stack.length ? ` [${r.stack.slice(0, 3).join(', ')}]` : ''} = ${r.path}`).join('; ') || 'no repos scanned yet'}`;
    })
    .join('\n');
}
