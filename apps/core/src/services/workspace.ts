/** Workspace picker directory listing + git summary for coding sessions. */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HttpError } from '../kernel.ts';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export async function listDirs(path?: string, opts: { hidden?: boolean } = {}): Promise<{ path: string; parent: string | null; dirs: string[] }> {
  const raw = expandHome(path?.trim() || homedir());
  const abs = resolve(isAbsolute(raw) ? raw : join(homedir(), raw));
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new HttpError(404, `No such directory: ${abs}`);
  }
  if (!st.isDirectory()) throw new HttpError(400, `Not a directory: ${abs}`);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    throw new HttpError(403, `Cannot read ${abs}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const dirs: string[] = [];
  for (const e of entries) {
    if (!opts.hidden && e.name.startsWith('.')) continue;
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isSymbolicLink()) {
      try {
        if ((await stat(join(abs, e.name))).isDirectory()) dirs.push(e.name);
      } catch {
        /* dangling link */
      }
    }
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const parent = dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, dirs };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile('git', args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || err.message).trim()));
      else res(stdout);
    });
  });
}

export type GitSummary =
  | { branch: string | null; dirty: number; ahead: number; behind: number; recent: { hash: string; subject: string; date: string }[] }
  | { error: string };

export async function gitSummary(cwd?: string): Promise<GitSummary> {
  if (!cwd?.trim()) return { error: 'cwd is required' };
  const dir = resolve(expandHome(cwd.trim()));
  try {
    if (!(await stat(dir)).isDirectory()) return { error: `Not a directory: ${dir}` };
  } catch {
    return { error: `No such directory: ${dir}` };
  }
  try {
    await git(dir, ['rev-parse', '--is-inside-work-tree']);
  } catch (e) {
    const msg = (e as Error).message;
    return { error: /ENOENT/.test(msg) ? 'git is not installed' : `Not a git repository: ${dir}` };
  }
  const [branchOut, status, counts, log] = await Promise.all([
    git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
    git(dir, ['status', '--porcelain']).catch(() => ''),
    git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).catch(() => ''),
    git(dir, ['log', '-8', '--pretty=format:%h%x1f%s%x1f%cI']).catch(() => ''),
  ]);
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
  return {
    branch: branchOut.trim() || null,
    dirty: status.split('\n').filter((l) => l.trim()).length,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    recent: log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, subject, date] = l.split('\x1f');
        return { hash, subject, date };
      }),
  };
}
