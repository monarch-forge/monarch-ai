/** Ledger tools: personal finance entries, summaries and monthly category budgets. */
import { z } from 'zod';
import type { LedgerEntry } from '@monarch/shared';
import { defineTool, type ToolDef } from '../kernel.ts';
import { parseWhen } from '../services/dates.ts';
import type { LedgerAccountView } from '@monarch/shared';
import {
  addLedgerEntry,
  deleteAccount,
  findAccount,
  listAccounts,
  upsertAccount,
  deleteLedgerEntry,
  findByRef,
  getLedgerEntry,
  ledgerMeta,
  ledgerSummary,
  listLedger,
  monthRange,
  setBudget,
  updateLedgerEntry,
} from '../services/ledger.ts';

const KW = ['finance', 'money', 'expense', 'spending', 'income', 'transaction', 'payment', 'budget', 'ledger', 'bank'];
const DATE = 'ISO date "2026-11-13" or datetime with offset; also "today", "in 2d" style relative dates.';
const TYPE = z.enum(['expense', 'income', 'transfer']);

const fmt = (e: LedgerEntry): string =>
  [
    `${e.date.slice(0, 10)} ${e.type === 'income' ? '+' : e.type === 'expense' ? '-' : '⇄'}${e.amount} ${e.currency}  ${e.description}`,
    `id=${e.id}`,
    e.merchant && e.merchant !== e.description ? `merchant=${e.merchant}` : null,
    e.category ? `category=${e.category}` : null,
    e.account ? `account=${e.account}${e.toAccount ? ` → ${e.toAccount}` : ''}` : null,
    e.tags.length ? `tags=${e.tags.join(',')}` : null,
    e.sourceRef ? `ref=${e.sourceRef}` : null,
    e.notes ? `notes=${JSON.stringify(e.notes.slice(0, 160))}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

const date = (v: string | undefined): Date | undefined => (v ? (parseWhen(v) ?? undefined) : undefined);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const entryFields = {
  date: z.string().optional().describe(`When it happened. ${DATE} Default: now.`),
  type: TYPE.optional().describe('expense (default), income or transfer.'),
  amount: z.union([z.number(), z.string()]).describe('Positive amount; formatted strings like "Rp 1.250.000" or "1,250.50" are parsed.'),
  currency: z.string().optional().describe('ISO 4217 code like "IDR" or "USD". Default: the most used currency in the ledger.'),
  description: z.string().optional().describe('What it was. Required unless merchant is given.'),
  merchant: z.string().optional(),
  category: z.string().optional().describe('Free-form category, e.g. "Food", "Transport". See ledger_meta for existing ones.'),
  account: z.string().optional().describe('Account or card used, e.g. "BCA debit", "Visa 4411".'),
  toAccount: z.string().optional().describe('Destination account (transfers only).'),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  sourceRef: z.string().optional().describe('Unique external reference used to detect duplicates, e.g. "mail:<accountId>:<messageId>" or a bank reference number. Adding an entry with an existing sourceRef is rejected.'),
};

const ledgerList = defineTool({
  name: 'ledger_list',
  group: 'ledger',
  keywords: KW,
  description: 'List ledger entries (newest first) with optional filters. Totals for the listed entries are appended.',
  risk: 'safe',
  schema: z.object({
    from: z.string().optional().describe(`Start (inclusive). ${DATE}`),
    to: z.string().optional().describe(`End (exclusive). ${DATE}`),
    type: TYPE.optional(),
    category: z.string().optional(),
    account: z.string().optional(),
    currency: z.string().optional(),
    tag: z.string().optional(),
    query: z.string().optional().describe('Text search over description, merchant, notes, category, account, ref.'),
    sourceRef: z.string().optional().describe('Exact sourceRef match.'),
    limit: z.number().int().min(1).max(500).optional().describe('Default 50.'),
  }),
  summarize: (i) => `Ledger${i.query ? `: ${i.query}` : ''}${i.from ? ` from ${i.from}` : ''}`,
  run: (i) => {
    const all = listLedger({ from: date(i.from), to: date(i.to), type: i.type, category: i.category, account: i.account, currency: i.currency, tag: i.tag, q: i.query, sourceRef: i.sourceRef });
    if (!all.length) return 'No matching ledger entries.';
    const shown = all.slice(0, i.limit ?? 50);
    const sums = new Map<string, { in: number; out: number }>();
    for (const e of all) {
      const s = sums.get(e.currency) ?? { in: 0, out: 0 };
      if (e.type === 'income') s.in += e.amount;
      if (e.type === 'expense') s.out += e.amount;
      sums.set(e.currency, s);
    }
    const tot = [...sums].map(([c, s]) => `${c}: income ${Math.round(s.in * 100) / 100}, expense ${Math.round(s.out * 100) / 100}`).join('; ');
    return `${all.length} entr${all.length === 1 ? 'y' : 'ies'}${all.length > shown.length ? ` (showing ${shown.length})` : ''}. Totals — ${tot}\n${shown.map(fmt).join('\n')}`;
  },
});

const ledgerAdd = defineTool({
  name: 'ledger_add',
  group: 'ledger',
  keywords: KW,
  description: 'Record one or more transactions in the ledger. Pass a single entry\'s fields, or `entries` for several at once. Entries whose sourceRef already exists are skipped and reported.',
  risk: 'sensitive',
  tag: 'FIN',
  schema: z
    .object(entryFields)
    .partial()
    .extend({ entries: z.array(z.object(entryFields)).max(200).optional().describe('Several entries to add in one call.') }),
  summarize: (i) => (Array.isArray(i.entries) && i.entries.length ? `Add ${i.entries.length} ledger entries` : `Add ledger entry: ${i.description ?? i.merchant ?? ''} ${i.amount ?? ''} ${i.currency ?? ''}`.trim()),
  run: (i) => {
    const { entries, ...one } = i;
    const items = entries?.length ? entries : [one];
    const lines: string[] = [];
    let added = 0;
    for (const it of items) {
      try {
        const e = addLedgerEntry(it, 'agent');
        added++;
        lines.push(`added: ${fmt(e)}`);
      } catch (err) {
        const dup = it.sourceRef ? findByRef(String(it.sourceRef)) : undefined;
        lines.push(dup ? `skipped (duplicate ref): ${fmt(dup)}` : `failed: ${it.description ?? it.merchant ?? '?'} — ${errText(err)}`);
      }
    }
    return `${added}/${items.length} added.\n${lines.join('\n')}`;
  },
});

const ledgerUpdate = defineTool({
  name: 'ledger_update',
  group: 'ledger',
  keywords: KW,
  description: 'Change fields of a ledger entry by id. Pass "" to clear an optional text field.',
  risk: 'sensitive',
  tag: 'FIN',
  schema: z.object(entryFields).partial().extend({ id: z.string() }),
  summarize: (i) => {
    try {
      return `Update ledger: ${getLedgerEntry(String(i.id)).description}`;
    } catch {
      return `Update ledger entry ${i.id}`;
    }
  },
  run: (i) => {
    const { id, ...rest } = i;
    return `Updated: ${fmt(updateLedgerEntry(String(id), rest))}`;
  },
});

const ledgerDelete = defineTool({
  name: 'ledger_delete',
  group: 'ledger',
  keywords: KW,
  description: 'Permanently delete ledger entries by id.',
  risk: 'dangerous',
  tag: 'FIN',
  schema: z.object({ ids: z.array(z.string()).min(1).describe('Entry ids.') }),
  bulkCount: (i) => i.ids.length,
  summarize: (i) => {
    const names = i.ids.slice(0, 3).map((id) => {
      try {
        const e = getLedgerEntry(id);
        return `${e.description} ${e.amount} ${e.currency}`;
      } catch {
        return id;
      }
    });
    return `Delete ${i.ids.length} ledger entr${i.ids.length === 1 ? 'y' : 'ies'}: ${names.join(', ')}${i.ids.length > 3 ? '…' : ''}`;
  },
  run: ({ ids }) =>
    ids
      .map((id) => {
        try {
          return `deleted: ${fmt(deleteLedgerEntry(id))}`;
        } catch (e) {
          return `failed ${id}: ${errText(e)}`;
        }
      })
      .join('\n'),
});

const ledgerSummaryTool = defineTool({
  name: 'ledger_summary',
  group: 'ledger',
  keywords: KW,
  description: 'Totals for a period: income/expense/net per currency, breakdown by category and by account, and monthly budgets with what was spent. Default period: the current month.',
  risk: 'safe',
  schema: z.object({
    from: z.string().optional().describe(`Start (inclusive). ${DATE}`),
    to: z.string().optional().describe(`End (exclusive). ${DATE}`),
  }),
  summarize: (i) => `Ledger summary${i.from ? ` ${i.from}–${i.to ?? 'now'}` : ' (this month)'}`,
  run: (i) => {
    const r = i.from ? { from: date(i.from) ?? monthRange().from, to: date(i.to) ?? new Date() } : monthRange();
    const s = ledgerSummary(r.from, r.to);
    const lines = [`Period ${s.from.slice(0, 10)} – ${s.to.slice(0, 10)} (end exclusive): ${s.count} entries.`];
    for (const t of s.totals) lines.push(`${t.currency}: income ${t.income}, expense ${t.expense}, net ${t.net}${t.transfer ? `, transfers ${t.transfer}` : ''}`);
    if (s.byCategory.length) lines.push('By category:', ...s.byCategory.map((c) => `- ${c.category} (${c.currency}): expense ${c.expense}${c.income ? `, income ${c.income}` : ''} [${c.count}]`));
    if (s.byAccount.length) lines.push('By account:', ...s.byAccount.map((c) => `- ${c.account} (${c.currency}): expense ${c.expense}${c.income ? `, income ${c.income}` : ''} [${c.count}]`));
    if (s.budgets.length) lines.push('Budgets (monthly limit):', ...s.budgets.map((b) => `- ${b.category}: ${b.spent} / ${b.limit} ${b.currency} (${b.limit ? Math.round((b.spent / b.limit) * 100) : 0}%)`));
    return lines.join('\n');
  },
});

const ledgerMetaTool = defineTool({
  name: 'ledger_meta',
  group: 'ledger',
  keywords: KW,
  description: 'Categories, accounts, currencies and tags already used in the ledger, plus the default currency.',
  risk: 'safe',
  schema: z.object({}),
  summarize: () => 'Ledger categories and accounts',
  run: () => {
    const m = ledgerMeta();
    return [
      `default currency: ${m.defaultCurrency}`,
      `categories: ${m.categories.join(', ') || '(none)'}`,
      `accounts: ${m.accounts.join(', ') || '(none)'}`,
      `currencies: ${m.currencies.join(', ') || '(none)'}`,
      `tags: ${m.tags.join(', ') || '(none)'}`,
    ].join('\n');
  },
});

const ledgerBudget = defineTool({
  name: 'ledger_budget_set',
  group: 'ledger',
  keywords: KW,
  description: 'Set a monthly spending limit for a category (limit 0 removes it). Returns all budgets.',
  risk: 'sensitive',
  tag: 'FIN',
  schema: z.object({
    category: z.string(),
    limit: z.union([z.number(), z.string()]).describe('Monthly limit; 0 removes the budget.'),
    currency: z.string().optional(),
  }),
  summarize: (i) => `Budget ${i.category}: ${i.limit}${i.currency ? ` ${i.currency}` : ''}/month`,
  run: (i) => {
    const all = setBudget(i);
    return all.length ? all.map((b) => `${b.category}: ${b.limit} ${b.currency}/month`).join('\n') : 'No budgets set.';
  },
});

/* ─────────────── accounts ─────────────── */

const d10 = (iso?: string) => iso?.slice(0, 10);
const fmtAccount = (a: LedgerAccountView): string =>
  [
    `${a.archived ? '(archived) ' : ''}${a.name} [${a.type}]`,
    `id=${a.id}`,
    a.type === 'credit' ? `owed=${a.owed} ${a.currency}` : `balance=${a.balance} ${a.currency}`,
    a.creditLimit ? `limit=${a.creditLimit} available=${a.available}` : null,
    a.amountDue !== undefined ? `amountDue=${a.amountDue}` : null,
    a.nextDue ? `nextDue=${d10(a.nextDue)}${a.amountDue && new Date(`${a.nextDue}T23:59:59`).getTime() < Date.now() ? ' (OVERDUE)' : ''}` : null,
    a.lastStatement ? `lastStatement=${d10(a.lastStatement)} nextStatement=${d10(a.nextStatement)}` : null,
    a.cycleSpend !== undefined ? `cycleSpend=${a.cycleSpend}` : null,
    a.aliases.length ? `aliases=${a.aliases.join(',')}` : null,
    `entries=${a.entryCount}`,
    a.notes ? `notes=${JSON.stringify(a.notes.slice(0, 120))}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

const ledgerAccounts = defineTool({
  name: 'ledger_accounts',
  group: 'ledger',
  keywords: [...KW, 'credit card', 'balance', 'due date', 'statement', 'account'],
  description:
    'List money accounts (bank, cash, e-wallet, credit card, investment) with computed balances. Credit cards also show amount owed, available credit, last/next statement, the unpaid statement amount and the next due date. Entries belong to an account when their `account` (or transfer `toAccount`) equals its name or an alias.',
  risk: 'safe',
  schema: z.object({ includeArchived: z.boolean().optional() }),
  summarize: () => 'Ledger accounts',
  run: ({ includeArchived }) => {
    const list = listAccounts(includeArchived ?? false);
    return list.length ? list.map(fmtAccount).join('\n') : 'No accounts defined yet.';
  },
});

const ledgerAccountSet = defineTool({
  name: 'ledger_account_set',
  group: 'ledger',
  keywords: [...KW, 'credit card', 'account', 'limit', 'due date'],
  description: 'Create a money account, or update one matched by id or name/alias. Only the fields given are changed.',
  risk: 'sensitive',
  tag: 'FIN',
  schema: z.object({
    id: z.string().optional(),
    name: z.string().optional().describe('Account name; entries use it in their `account` field.'),
    aliases: z.array(z.string()).optional().describe('Other names entries may use, e.g. card last digits "4411". Replaces the list.'),
    type: z.enum(['bank', 'cash', 'credit', 'ewallet', 'investment', 'other']).optional(),
    currency: z.string().optional(),
    openingBalance: z.union([z.number(), z.string()]).optional().describe('Balance at openingDate. For credit cards: the amount owed then (positive).'),
    openingDate: z.string().optional().describe(`Entries before this date are not counted. ${DATE}`),
    creditLimit: z.union([z.number(), z.string()]).optional(),
    statementDay: z.number().int().min(1).max(31).optional().describe('Day of month the card statement closes.'),
    dueDay: z.number().int().min(1).max(31).optional().describe('Day of month the card payment is due.'),
    archived: z.boolean().optional(),
    notes: z.string().optional(),
  }),
  summarize: (i) => `${i.id || (i.name && findAccount(i.name)) ? 'Update' : 'Create'} account ${i.name ?? i.id}`,
  run: (i) => fmtAccount(upsertAccount(i)),
});

const ledgerAccountDelete = defineTool({
  name: 'ledger_account_delete',
  group: 'ledger',
  keywords: [...KW, 'account'],
  description: 'Delete an account definition by id. Its entries are kept (they still carry the account name).',
  risk: 'dangerous',
  tag: 'FIN',
  schema: z.object({ id: z.string() }),
  summarize: (i) => `Delete account ${findAccount(i.id)?.name ?? i.id}`,
  run: ({ id }) => `Deleted account ${deleteAccount(id).name}`,
});

export const tools: ToolDef[] = [ledgerList, ledgerAdd, ledgerUpdate, ledgerDelete, ledgerSummaryTool, ledgerMetaTool, ledgerBudget, ledgerAccounts, ledgerAccountSet, ledgerAccountDelete];
