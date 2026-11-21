/**
 * Linux process list read straight from /proc: no `ps` child process (which pinned a core on every refresh).
 * CPU % is the change in a process's CPU time between two calls, like `top` (100% = one full core).
 */
import { readdir, readFile } from 'node:fs/promises';
import type { ProcessInfo } from '@monarch/shared';

const TICKS = 100; // USER_HZ: 100 on every mainstream Linux kernel config
const PAGE = 4096;

type Stat = { name: string; ticks: number; rssPages: number };

/** parse /proc/<pid>/stat; the name sits in parentheses and may itself contain spaces or ")" */
export function parseStat(text: string): Stat | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = text.slice(close + 2).split(' '); // f[0] = field 3 (state)
  const utime = Number(f[11]); // field 14
  const stime = Number(f[12]); // field 15
  const rss = Number(f[21]); // field 24
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { name: text.slice(open + 1, close), ticks: utime + stime, rssPages: Number.isFinite(rss) ? rss : 0 };
}

let users: Map<number, string> | null = null;
async function userName(uid: number): Promise<string | undefined> {
  if (!users) {
    users = new Map();
    try {
      for (const line of (await readFile('/etc/passwd', 'utf8')).split('\n')) {
        const [name, , id] = line.split(':');
        if (name && id) users.set(Number(id), name);
      }
    } catch {
      /* no passwd: uids stay unnamed */
    }
  }
  return users.get(uid);
}

let prev = new Map<number, number>(); // pid -> ticks at the last call
let prevAt = 0;

async function snapshot(): Promise<{ pid: number; stat: Stat }[]> {
  const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d)).map(Number);
  const out: { pid: number; stat: Stat }[] = [];
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const stat = parseStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
        if (stat) out.push({ pid, stat });
      } catch {
        /* process exited while we read */
      }
    }),
  );
  return out;
}

export async function procList(limit: number, sortBy: 'cpu' | 'mem'): Promise<ProcessInfo[]> {
  let snap = await snapshot();
  let now = Date.now();
  // first call (or a long gap): take a short second sample so CPU % means something
  if (!prevAt || now - prevAt > 60_000) {
    prev = new Map(snap.map((p) => [p.pid, p.stat.ticks]));
    prevAt = now;
    await new Promise((r) => setTimeout(r, 300));
    snap = await snapshot();
    now = Date.now();
  }
  const secs = Math.max(0.05, (now - prevAt) / 1000);
  const rows = snap.map(({ pid, stat }) => {
    const before = prev.get(pid);
    const cpu = before === undefined ? 0 : Math.max(0, ((stat.ticks - before) / TICKS / secs) * 100);
    return { pid, stat, cpu: Math.round(cpu * 10) / 10, memBytes: stat.rssPages * PAGE };
  });
  prev = new Map(snap.map((p) => [p.pid, p.stat.ticks]));
  prevAt = now;
  rows.sort((a, b) => (sortBy === 'mem' ? b.memBytes - a.memBytes : b.cpu - a.cpu || b.memBytes - a.memBytes));
  const top = rows.slice(0, Math.max(1, Math.min(limit, 200)));
  // details only for the rows we return
  return Promise.all(
    top.map(async (r): Promise<ProcessInfo> => {
      let command: string | undefined;
      let user: string | undefined;
      try {
        command = (await readFile(`/proc/${r.pid}/cmdline`, 'utf8')).replace(/\0+$/, '').replace(/\0/g, ' ').slice(0, 300) || undefined;
        const uid = /^Uid:\s+(\d+)/m.exec(await readFile(`/proc/${r.pid}/status`, 'utf8'))?.[1];
        if (uid) user = await userName(Number(uid));
      } catch {
        /* exited */
      }
      return { pid: r.pid, name: r.stat.name, cpu: r.cpu, memBytes: r.memBytes, user, command };
    }),
  );
}
