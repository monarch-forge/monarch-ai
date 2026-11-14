/**
 * Coding tools (Core-B) — used by the pi engine in coding sessions (the claude-sdk engine uses
 * Claude Code's own Read/Write/Edit/Bash/Grep/Glob). Relative paths resolve against ctx.cwd.
 */
import { spawn, execFile } from 'node:child_process';
import { promises as fsp, constants as fsc } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { defineTool, type ToolContext, type ToolDef } from '../kernel.ts';

const MAX_READ_BYTES = 512 * 1024;
const MAX_OUT = 30_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', '.venv', '__pycache__', '.cache']);

function abs(ctx: ToolContext, p: string | undefined): string {
  const raw = (p ?? '.').trim() || '.';
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.cwd || process.cwd(), expanded);
}

function capText(s: string, max = MAX_OUT): string {
  return s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more chars truncated]` : s;
}

function run(cmd: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, signal, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as any).code === 'ENOENT') return rej(err);
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      res({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let rgAvailable: boolean | null = null;
async function hasRg(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await run('rg', ['--version'], process.cwd(), AbortSignal.timeout(5000), 5000);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/* ─────────────── fs_list ─────────────── */

const fsList = defineTool({
  name: 'fs_list',
  loading: 'always',
  group: 'coding',
  keywords: ['ls', 'directory', 'files'],
  description: 'List files and directories (directories end with "/"). Skips .git/node_modules and similar. depth 1-4.',
  risk: 'safe',
  tag: 'CODE',
  schema: z.object({
    path: z.string().optional().describe('Directory (relative to the session working directory). Default "."'),
    depth: z.number().int().min(1).max(4).optional().describe('Recursion depth, default 1'),
  }),
  summarize: (i) => `List ${i.path ?? '.'}`,
  async run(input, ctx) {
    const root = abs(ctx, input.path);
    const depth = input.depth ?? 1;
    const out: string[] = [];
    const LIMIT = 1000;
    async function walk(dir: string, level: number) {
      if (out.length >= LIMIT) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (level === 0) throw e;
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= LIMIT) return;
        const rel = relative(root, join(dir, e.name));
        if (e.isDirectory()) {
          out.push(`${rel}/`);
          if (level + 1 < depth && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), level + 1);
        } else out.push(rel);
      }
    }
    await walk(root, 0);
    return `${root}\n${out.join('\n')}${out.length >= LIMIT ? `\n… (truncated at ${LIMIT} entries)` : ''}`;
  },
});

/* ─────────────── fs_read ─────────────── */

const fsRead = defineTool({
  name: 'fs_read',
  loading: 'always',
  group: 'coding',
  keywords: ['cat', 'open file'],
  description: 'Read a text file with line numbers. Use offset/limit (1-based lines) for large files.',
  risk: 'safe',
  tag: 'CODE',
  schema: z.object({
    path: z.string().describe('File path'),
    offset: z.number().int().min(1).optional().describe('First line to read (1-based), default 1'),
    limit: z.number().int().min(1).max(5000).optional().describe('Number of lines, default 600'),
  }),
  summarize: (i) => `Read ${i.path}${i.offset ? `:${i.offset}` : ''}`,
  async run(input, ctx) {
    const file = abs(ctx, input.path);
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new Error(`${file} is a directory; use fs_list`);
    const fh = await fsp.open(file, 'r');
    let text: string;
    try {
      const len = Math.min(st.size, MAX_READ_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      if (buf.subarray(0, Math.min(len, 8000)).includes(0)) throw new Error(`${file} looks like a binary file`);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
    const lines = text.split('\n');
    const start = (input.offset ?? 1) - 1;
    const count = input.limit ?? 600;
    const slice = lines.slice(start, start + count);
    const width = String(start + slice.length).length;
    const body = slice.map((l, i) => `${String(start + i + 1).padStart(width, ' ')}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join('\n');
    const notes: string[] = [];
    if (start + count < lines.length) notes.push(`(showing lines ${start + 1}-${start + slice.length} of ${lines.length}${st.size > MAX_READ_BYTES ? '+' : ''})`);
    if (st.size > MAX_READ_BYTES) notes.push(`(file is ${st.size} bytes; only the first ${MAX_READ_BYTES} were read)`);
    return capText(`${body}${notes.length ? `\n${notes.join(' ')}` : ''}`, 60_000);
  },
});

/* ─────────────── fs_write ─────────────── */

const fsWrite = defineTool({
  name: 'fs_write',
  loading: 'always',
  group: 'coding',
  keywords: ['create file', 'save file'],
  description: 'Create or overwrite a file with the given content (creates parent directories).',
  risk: 'sensitive',
  tag: 'CODE',
  schema: z.object({
    path: z.string().describe('File path'),
    content: z.string().describe('Full file content'),
  }),
  summarize: (i) => `Write file ${i.path} (${i.content.length} chars)`,
  async run(input, ctx) {
    const file = abs(ctx, input.path);
    let existed = true;
    try {
      await fsp.access(file, fsc.F_OK);
    } catch {
      existed = false;
    }
    await fsp.mkdir(dirname(file), { recursive: true });
    await fsp.writeFile(file, input.content, 'utf8');
    return `${existed ? 'Overwrote' : 'Created'} ${file} (${input.content.split('\n').length} lines)`;
  },
});

/* ─────────────── fs_edit ─────────────── */

const fsEdit = defineTool({
  name: 'fs_edit',
  loading: 'always',
  group: 'coding',
  keywords: ['replace', 'patch', 'modify file'],
  description:
    'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.',
  risk: 'sensitive',
  tag: 'CODE',
  schema: z.object({
    path: z.string().describe('File path'),
    old_string: z.string().min(1).describe('Exact text to replace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().optional().describe('Replace every occurrence'),
  }),
  summarize: (i) => `Edit file ${i.path}`,
  async run(input, ctx) {
    const file = abs(ctx, input.path);
    const text = await fsp.readFile(file, 'utf8');
    if (input.old_string === input.new_string) throw new Error('old_string and new_string are identical');
    const count = text.split(input.old_string).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${file}`);
    if (count > 1 && !input.replace_all) throw new Error(`old_string matches ${count} times in ${file}; add context to make it unique or set replace_all`);
    const next = input.replace_all ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string);
    await fsp.writeFile(file, next, 'utf8');
    return `Edited ${file} (${input.replace_all ? count : 1} replacement${(input.replace_all ? count : 1) === 1 ? '' : 's'})`;
  },
});

/* ─────────────── grep ─────────────── */

async function jsGrep(root: string, pattern: RegExp, glob: RegExp | null, max: number, signal: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= max || signal.aborted) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max || signal.aborted) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(p);
        continue;
      }
      if (!e.isFile() || (glob && !glob.test(e.name))) continue;
      let text: string;
      try {
        const st = await fsp.stat(p);
        if (st.size > 2 * 1024 * 1024) continue;
        const buf = await fsp.readFile(p);
        if (buf.subarray(0, 4000).includes(0)) continue;
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < max; i++) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[i])) out.push(`${relative(root, p)}:${i + 1}:${lines[i].slice(0, 300)}`);
      }
    }
  }
  await walk(root);
  return out;
}

function globToRegex(glob: string): RegExp {
  const g = glob.replace(/^\*\*\//, '');
  const src = g
    .split('')
    .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '.' : /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch))
    .join('');
  return new RegExp(`^${src.replace(/\\\{([^}]*)\\\}/g, (_m, alts: string) => `(${alts.split(',').join('|')})`)}$`);
}

const grep = defineTool({
  name: 'grep',
  loading: 'always',
  group: 'coding',
  keywords: ['search code', 'ripgrep', 'find text'],
  description: 'Search file contents with a regular expression (ripgrep when available). Returns path:line:text matches.',
  risk: 'safe',
  tag: 'CODE',
  schema: z.object({
    pattern: z.string().min(1).describe('Regular expression'),
    path: z.string().optional().describe('Directory or file to search, default "."'),
    glob: z.string().optional().describe('Filename glob filter, e.g. "*.ts"'),
    ignore_case: z.boolean().optional(),
    max_results: z.number().int().min(1).max(1000).optional().describe('Default 200'),
  }),
  summarize: (i) => `Search for /${i.pattern}/ in ${i.path ?? '.'}`,
  async run(input, ctx) {
    const root = abs(ctx, input.path);
    const max = input.max_results ?? 200;
    if (await hasRg()) {
      const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-count', String(max)];
      if (input.ignore_case) args.push('-i');
      if (input.glob) args.push('--glob', input.glob);
      args.push('--', input.pattern, root);
      const r = await run('rg', args, ctx.cwd || process.cwd(), ctx.signal, 60_000);
      if (r.code > 1) throw new Error(r.stderr.trim() || `rg exited with ${r.code}`);
      const lines = r.stdout.split('\n').filter(Boolean).slice(0, max).map((l) => (l.startsWith(root) ? relative(root, l.slice(0, l.indexOf(':'))) + l.slice(l.indexOf(':')) : l));
      return lines.length ? lines.join('\n') + (lines.length >= max ? `\n… (limited to ${max})` : '') : 'No matches.';
    }
    const re = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
    const st = await fsp.stat(root);
    if (st.isFile()) {
      const lines = (await fsp.readFile(root, 'utf8')).split('\n');
      const hits = lines.flatMap((l, i) => (re.test(l) ? [`${i + 1}:${l.slice(0, 300)}`] : [])).slice(0, max);
      return hits.length ? hits.join('\n') : 'No matches.';
    }
    const hits = await jsGrep(root, re, input.glob ? globToRegex(input.glob) : null, max, ctx.signal);
    return hits.length ? hits.join('\n') : 'No matches.';
  },
});

/* ─────────────── shell_exec ─────────────── */

const shellExec = defineTool({
  name: 'shell_exec',
  loading: 'always',
  group: 'coding',
  keywords: ['bash', 'terminal', 'command', 'run'],
  description:
    'Run a shell command (bash -lc) in the session working directory. Output (stdout+stderr) is captured and capped. Default timeout 120s, max 1800s. Avoid interactive commands.',
  risk: 'dangerous',
  tag: 'CODE',
  schema: z.object({
    command: z.string().min(1).describe('Shell command'),
    timeout_sec: z.number().int().min(1).max(1800).optional().describe('Timeout in seconds, default 120'),
    cwd: z.string().optional().describe('Working directory override (relative to the session directory)'),
  }),
  summarize: (i) => `Run shell: ${i.command.length > 160 ? `${i.command.slice(0, 159)}…` : i.command}`,
  run(input, ctx) {
    const cwd = abs(ctx, input.cwd);
    const timeoutMs = (input.timeout_sec ?? 120) * 1000;
    return new Promise<string>((res, rej) => {
      const child = spawn('bash', ['-lc', input.command], {
        cwd,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let out = '';
      let dropped = 0;
      let killedBy: 'timeout' | 'abort' | null = null;
      let pendingProgress = '';
      let progressTimer: NodeJS.Timeout | null = null;
      const flushProgress = () => {
        progressTimer = null;
        if (pendingProgress) ctx.progress(pendingProgress.replace(/\n$/, ''));
        pendingProgress = '';
      };
      const onData = (d: Buffer) => {
        const s = d.toString('utf8');
        if (out.length < MAX_OUT) out += s;
        else dropped += s.length;
        pendingProgress += s;
        if (pendingProgress.length > 4000) pendingProgress = pendingProgress.slice(-4000);
        if (!progressTimer) progressTimer = setTimeout(flushProgress, 250);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const kill = (why: 'timeout' | 'abort') => {
        killedBy = why;
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }, 2000).unref();
      };
      const timer = setTimeout(() => kill('timeout'), timeoutMs);
      const onAbort = () => kill('abort');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        rej(e);
      });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        if (progressTimer) clearTimeout(progressTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        const tail = dropped ? `\n… [${dropped} more chars truncated]` : '';
        const body = `${out}${tail}`.trimEnd() || '(no output)';
        if (killedBy === 'abort') return rej(new Error(`aborted\n${body}`));
        if (killedBy === 'timeout') return rej(new Error(`timed out after ${timeoutMs / 1000}s\n${body}`));
        const status = code === 0 ? 'exit 0' : `exit ${code ?? sig}`;
        if (code !== 0) return rej(new Error(`${status}\n${body}`));
        res(`${body}\n[${status}]`);
      });
    });
  },
});

/* ─────────────── git ─────────────── */

const gitStatus = defineTool({
  name: 'git_status',
  loading: 'always',
  group: 'coding',
  keywords: ['git', 'branch', 'changes'],
  description: 'Show git branch and working tree status (porcelain) for the session directory.',
  risk: 'safe',
  tag: 'CODE',
  schema: z.object({ path: z.string().optional().describe('Repository directory, default "."') }),
  summarize: () => 'git status',
  async run(input, ctx) {
    const r = await run('git', ['status', '--short', '--branch'], abs(ctx, input.path), ctx.signal);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'git status failed');
    return r.stdout.trim() || 'clean';
  },
});

const gitDiff = defineTool({
  name: 'git_diff',
  loading: 'always',
  group: 'coding',
  keywords: ['git', 'changes', 'patch'],
  description: 'Show git diff (unstaged by default; staged=true for the index). Optionally limit to a path.',
  risk: 'safe',
  tag: 'CODE',
  schema: z.object({
    staged: z.boolean().optional(),
    path: z.string().optional().describe('Limit to this file/directory'),
    stat: z.boolean().optional().describe('Only show --stat summary'),
  }),
  summarize: (i) => `git diff${i.staged ? ' --staged' : ''}${i.path ? ` ${i.path}` : ''}`,
  async run(input, ctx) {
    const args = ['--no-pager', 'diff', '--no-color'];
    if (input.staged) args.push('--staged');
    if (input.stat) args.push('--stat');
    if (input.path) args.push('--', abs(ctx, input.path));
    const r = await run('git', args, ctx.cwd || process.cwd(), ctx.signal);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'git diff failed');
    return capText(r.stdout.trim() || 'No changes.', 60_000);
  },
});

export const tools: ToolDef[] = [fsList, fsRead, fsWrite, fsEdit, grep, shellExec, gitStatus, gitDiff] as ToolDef[];
