/** Ledger: personal finance entries + monthly category budgets (local, data/ledger.json + data/ledger-budgets.json). */
import type { LedgerBudget, LedgerEntry, LedgerMeta, LedgerSummary, LedgerType } from '@monarch/shared';
import { changed, HttpError, newId, nowIso } from '../kernel.ts';
import { serviceStore } from './persist.ts';
import { parseWhen } from './dates.ts';

const store = serviceStore<LedgerEntry[]>('ledger', []);
const budgets = serviceStore<LedgerBudget[]>('ledger-budgets', []);

const TYPES: LedgerType[] = ['expense', 'income', 'transfer'];

export interface LedgerInput {
  date?: string;
  type?: LedgerType;
  amount?: number | string;
  currency?: string;
  description?: string;
  merchant?: string | null;
  category?: string | null;
  account?: string | null;
  toAccount?: string | null;
  tags?: string[];
  notes?: string | null;
  sourceRef?: string | null;
}

export interface LedgerFilter {
  from?: Date;
  to?: Date;
  type?: LedgerType;
  category?: string;
  account?: string;
  currency?: string;
  tag?: string;
  /** substring over description/merchant/notes/category/account */
  q?: string;
  sourceRef?: string;
  limit?: number;
}

const eq = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();
const opt = (v: unknown): string | undefined => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || undefined;
};

/** "1.250.000,50", "1,250,000.50", "Rp 50.000", -20 → positive number */
export function parseAmount(v: unknown): number {
  if (typeof v === 'number') return Math.abs(v);
  let t = String(v ?? '').replace(/[^\d.,-]/g, '');
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // the later separator is the decimal one
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "50,00" decimal vs "1,250" thousands
    t = /,\d{1,2}$/.test(t) && (t.match(/,/g) ?? []).length === 1 ? t.replace(',', '.') : t.replace(/,/g, '');
  } else if (lastDot >= 0 && ((t.match(/\./g) ?? []).length > 1 || /\.\d{3}$/.test(t))) {
    t = t.replace(/\./g, ''); // "50.000" / "1.250.000" thousands
  }
  const n = Math.abs(Number(t));
  if (!Number.isFinite(n)) throw new HttpError(400, `invalid amount: ${String(v)}`);
  return Math.round(n * 100) / 100;
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean))];
}

function cleanDate(v: unknown): string {
  if (v === undefined || v === null || v === '') return nowIso();
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = parseWhen(s);
  if (!d) throw new HttpError(400, `invalid date: ${s}`);
  return d.toISOString();
}

/** start-of-day for date-only values so "2026-11-01" sorts/filters as local midnight */
const timeOf = (date: string): number => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`).getTime() : Date.parse(date));

export function defaultCurrency(): string {
  const counts = new Map<string, number>();
  for (const e of store.get().slice(-200)) counts.set(e.currency, (counts.get(e.currency) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';
}

export function listLedger(f: LedgerFilter = {}): LedgerEntry[] {
  const q = f.q?.toLowerCase();
  const from = f.from?.getTime();
  const to = f.to?.getTime();
  const out = store
    .get()
    .filter((e) => {
      const t = timeOf(e.date);
      if (from !== undefined && t < from) return false;
      if (to !== undefined && t >= to) return false;
      if (f.type && e.type !== f.type) return false;
      if (f.category && !eq(e.category, f.category)) return false;
      if (f.account && !eq(e.account, f.account) && !eq(e.toAccount, f.account)) return false;
      if (f.currency && !eq(e.currency, f.currency)) return false;
      if (f.tag && !e.tags.some((x) => eq(x, f.tag!))) return false;
      if (f.sourceRef && e.sourceRef !== f.sourceRef) return false;
      if (q && ![e.description, e.merchant, e.notes, e.category, e.account, e.toAccount, e.sourceRef].some((x) => x?.toLowerCase().includes(q))) return false;
      return true;
    })
    .sort((a, b) => timeOf(b.date) - timeOf(a.date) || b.createdAt.localeCompare(a.createdAt));
  return f.limit ? out.slice(0, f.limit) : out;
}

export function getLedgerEntry(id: string): LedgerEntry {
  const e = store.get().find((x) => x.id === id);
  if (!e) throw new HttpError(404, `Ledger entry ${id} not found`);
  return e;
}

export function findByRef(sourceRef: string): LedgerEntry | undefined {
  return store.get().find((e) => e.sourceRef === sourceRef);
}

export function addLedgerEntry(input: LedgerInput, source: LedgerEntry['source'] = 'manual'): LedgerEntry {
  const type = input.type ?? 'expense';
  if (!TYPES.includes(type)) throw new HttpError(400, `type must be one of ${TYPES.join(', ')}`);
  if (input.amount === undefined || input.amount === '') throw new HttpError(400, 'amount is required');
  const description = opt(input.description) ?? opt(input.merchant);
  if (!description) throw new HttpError(400, 'description (or merchant) is required');
  const sourceRef = opt(input.sourceRef);
  if (sourceRef) {
    const dup = findByRef(sourceRef);
    if (dup) throw new HttpError(409, `already recorded: ${dup.description} (id=${dup.id}, sourceRef=${sourceRef})`);
  }
  const now = nowIso();
  const e: LedgerEntry = {
    id: newId(),
    date: cleanDate(input.date),
    type,
    amount: parseAmount(input.amount),
    currency: (opt(input.currency) ?? defaultCurrency()).toUpperCase(),
    description,
    merchant: opt(input.merchant),
    category: opt(input.category),
    account: opt(input.account),
    toAccount: type === 'transfer' ? opt(input.toAccount) : undefined,
    tags: cleanTags(input.tags),
    notes: opt(input.notes),
    source,
    sourceRef,
    createdAt: now,
    updatedAt: now,
  };
  for (const k of Object.keys(e) as (keyof LedgerEntry)[]) if (e[k] === undefined) delete e[k];
  store.update((a) => {
    a.push(e);
  });
  changed('ledger');
  return e;
}

export function updateLedgerEntry(id: string, input: LedgerInput): LedgerEntry {
  const cur = getLedgerEntry(id);
  const next: LedgerEntry = { ...cur };
  if (input.type !== undefined) {
    if (!TYPES.includes(input.type)) throw new HttpError(400, `type must be one of ${TYPES.join(', ')}`);
    next.type = input.type;
  }
  if (input.amount !== undefined) next.amount = parseAmount(input.amount);
  if (input.date !== undefined) next.date = cleanDate(input.date);
  if (input.currency !== undefined) next.currency = (opt(input.currency) ?? cur.currency).toUpperCase();
  if (input.description !== undefined) next.description = opt(input.description) ?? cur.description;
  if (input.tags !== undefined) next.tags = cleanTags(input.tags);
  for (const k of ['merchant', 'category', 'account', 'toAccount', 'notes', 'sourceRef'] as const) {
    if (input[k] !== undefined) {
      const v = opt(input[k]);
      if (v) next[k] = v;
      else delete next[k];
    }
  }
  if (next.sourceRef && next.sourceRef !== cur.sourceRef) {
    const dup = findByRef(next.sourceRef);
    if (dup && dup.id !== id) throw new HttpError(409, `sourceRef already used by ${dup.id}`);
  }
  if (next.type !== 'transfer') delete next.toAccount;
  next.updatedAt = nowIso();
  store.update((a) => {
    const i = a.findIndex((x) => x.id === id);
    if (i >= 0) a[i] = next;
  });
  changed('ledger');
  return next;
}

export function deleteLedgerEntry(id: string): LedgerEntry {
  const e = getLedgerEntry(id);
  store.update((a) => {
    const i = a.findIndex((x) => x.id === id);
    if (i >= 0) a.splice(i, 1);
  });
  changed('ledger');
  return e;
}

/* ─────────────── summaries ─────────────── */

export function monthRange(d = new Date()): { from: Date; to: Date } {
  return { from: new Date(d.getFullYear(), d.getMonth(), 1), to: new Date(d.getFullYear(), d.getMonth() + 1, 1) };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function ledgerSummary(from?: Date, to?: Date): LedgerSummary {
  const range = from && to ? { from, to } : from ? { from, to: new Date(8.64e15) } : monthRange();
  const entries = listLedger(range);
  const totals = new Map<string, LedgerSummary['totals'][number]>();
  const byCat = new Map<string, LedgerSummary['byCategory'][number]>();
  const byAcc = new Map<string, LedgerSummary['byAccount'][number]>();
  for (const e of entries) {
    const t = totals.get(e.currency) ?? { currency: e.currency, income: 0, expense: 0, transfer: 0, net: 0 };
    t[e.type] += e.amount;
    totals.set(e.currency, t);
    if (e.type === 'transfer') continue;
    const ck = `${e.category ?? 'Uncategorized'}\u0000${e.currency}`;
    const c = byCat.get(ck) ?? { category: e.category ?? 'Uncategorized', currency: e.currency, expense: 0, income: 0, count: 0 };
    c[e.type] += e.amount;
    c.count++;
    byCat.set(ck, c);
    const ak = `${e.account ?? 'Unspecified'}\u0000${e.currency}`;
    const ac = byAcc.get(ak) ?? { account: e.account ?? 'Unspecified', currency: e.currency, expense: 0, income: 0, count: 0 };
    ac[e.type] += e.amount;
    ac.count++;
    byAcc.set(ak, ac);
  }
  const tot = [...totals.values()].map((t) => ({ ...t, income: r2(t.income), expense: r2(t.expense), transfer: r2(t.transfer), net: r2(t.income - t.expense) }));
  const cats = [...byCat.values()].map((c) => ({ ...c, expense: r2(c.expense), income: r2(c.income) })).sort((a, b) => b.expense - a.expense || b.income - a.income);
  const accs = [...byAcc.values()].map((c) => ({ ...c, expense: r2(c.expense), income: r2(c.income) })).sort((a, b) => b.expense + b.income - (a.expense + a.income));
  const bud = budgets.get().map((b) => ({ ...b, spent: r2(byCat.get(`${b.category}\u0000${b.currency}`)?.expense ?? cats.find((c) => eq(c.category, b.category) && c.currency === b.currency)?.expense ?? 0) }));
  return { from: range.from.toISOString(), to: range.to.toISOString(), count: entries.length, totals: tot, byCategory: cats, byAccount: accs, budgets: bud };
}

export function ledgerMeta(): LedgerMeta {
  const cats = new Set<string>();
  const accs = new Set<string>();
  const curs = new Set<string>();
  const tags = new Set<string>();
  for (const e of store.get()) {
    if (e.category) cats.add(e.category);
    if (e.account) accs.add(e.account);
    if (e.toAccount) accs.add(e.toAccount);
    curs.add(e.currency);
    for (const t of e.tags) tags.add(t);
  }
  for (const b of budgets.get()) cats.add(b.category);
  const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { categories: sort(cats), accounts: sort(accs), currencies: sort(curs), tags: sort(tags), defaultCurrency: defaultCurrency() };
}

/* ─────────────── budgets ─────────────── */

export const listBudgets = (): LedgerBudget[] => budgets.get();

/** upsert by category+currency; limit 0 removes */
export function setBudget(input: { category?: string; currency?: string; limit?: number | string }): LedgerBudget[] {
  const category = opt(input.category);
  if (!category) throw new HttpError(400, 'category is required');
  const currency = (opt(input.currency) ?? defaultCurrency()).toUpperCase();
  const limit = parseAmount(input.limit ?? 0);
  budgets.update((a) => {
    const i = a.findIndex((b) => eq(b.category, category) && b.currency === currency);
    if (limit <= 0) {
      if (i >= 0) a.splice(i, 1);
    } else if (i >= 0) a[i] = { category: a[i].category, currency, limit };
    else a.push({ category, currency, limit });
  });
  changed('ledger');
  return budgets.get();
}
