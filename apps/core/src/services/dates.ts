/** Date parsing/formatting helpers shared by routes and tools. */
import { HttpError } from '../kernel.ts';

const REL = /^in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i;
const UNIT_MS: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };

/**
 * Parse a user/model supplied datetime.
 * Accepts ISO-8601 with or without offset ("2026-11-13T15:00:00+07:00", "2026-11-13T15:00" = local time),
 * date only ("2026-11-13" = local midnight), "YYYY-MM-DD HH:MM", "now", and relative "in 30m" / "in 2 hours" / "in 1d".
 * Returns null for empty input; throws HttpError(400) when unparseable.
 */
export function parseWhen(input: string | null | undefined, now: Date = new Date()): Date | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^now$/i.test(s)) return new Date(now);
  const rel = REL.exec(s);
  if (rel) {
    const unit = rel[2].toLowerCase();
    const key = unit.startsWith('mi') || unit === 'm' ? 'm' : unit[0];
    return new Date(now.getTime() + Number(rel[1]) * (UNIT_MS[key] ?? 60e3));
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  const normalized = /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Unrecognized date/time "${s}". Use ISO-8601, e.g. 2026-11-13T15:00:00+07:00`);
  return d;
}

/** parseWhen → ISO string (UTC) or null; undefined passes through (meaning "unchanged") */
export function isoOrNull(input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  const d = parseWhen(input);
  return d ? d.toISOString() : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO-8601 in local time with numeric offset, e.g. 2026-11-13T15:00:00+07:00 */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

/** short human local time, e.g. "Fri 13 Nov 15:00" */
export function fmtLocal(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function startOfDay(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
