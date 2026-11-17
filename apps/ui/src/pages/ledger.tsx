/** Ledger — personal finance: entries by month, totals, categories, budgets; manual add/edit (route #/ledger). */
import { useMemo, useState } from 'preact/hooks';
import type { LedgerBudget, LedgerEntry, LedgerMeta, LedgerSummary, LedgerType } from '@monarch/shared';
import { ChevronLeft, ChevronRight, Plus, Pencil, Trash2, Search, Bot } from 'lucide-preact';
import { api } from '../lib/api.ts';
import { toast, useResource } from '../lib/store.ts';
import { Btn, Empty, Panel, SegBar, Spinner, Stat, Tag } from '../components/ui.tsx';
import { Modal, useConfirm } from '../components/mail/kit.tsx';
import { Field, INPUT, TEXTAREA } from '../components/config/fields.tsx';

const enc = encodeURIComponent;

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch {
    return `${n.toLocaleString()} ${currency}`;
  }
}

const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const SIGN: Record<LedgerType, string> = { expense: '−', income: '+', transfer: '⇄' };

export default function LedgerPage() {
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const [q, setQ] = useState('');
  const [type, setType] = useState<'' | LedgerType>('');
  const [editing, setEditing] = useState<LedgerEntry | 'new' | null>(null);
  const [dialog, confirm] = useConfirm();

  const from = ymd(month);
  const to = ymd(addMonths(month, 1));
  const entries = useResource<LedgerEntry[]>(`/ledger?from=${from}&to=${to}`, ['ledger']);
  const summary = useResource<LedgerSummary>(`/ledger/summary?from=${from}&to=${to}`, ['ledger']);
  const meta = useResource<LedgerMeta>('/ledger/meta', ['ledger']);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (entries.data ?? []).filter(
      (e) => (!type || e.type === type) && (!s || [e.description, e.merchant, e.category, e.account, e.notes, ...e.tags].some((x) => x?.toLowerCase().includes(s))),
    );
  }, [entries.data, q, type]);

  const remove = async (e: LedgerEntry) => {
    if (!(await confirm({ title: 'Delete entry?', body: `${e.description} · ${money(e.amount, e.currency)}`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/ledger/${enc(e.id)}`);
    } catch (err: any) {
      toast(`Delete failed: ${err?.message ?? err}`, 'error');
    }
  };

  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const isCurrent = monthStart(new Date()).getTime() === month.getTime();

  return (
    <div class="h-full overflow-y-auto lg:overflow-hidden p-3 sm:p-4 lg:p-5 flex flex-col lg:flex-row gap-4 min-h-0">
      {dialog}
      <div class="flex flex-col gap-4 min-w-0 lg:flex-1 min-h-0">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-[20px] font-semibold tracking-[-0.01em] text-fg mr-2">Ledger</h1>
          <div class="flex items-center gap-1">
            <button class="btn btn-ghost btn-xs" title="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
              <ChevronLeft size={14} />
            </button>
            <span class="text-[13px] text-fg-2 min-w-[120px] text-center">{monthLabel}</span>
            <button class="btn btn-ghost btn-xs" title="Next month" onClick={() => setMonth(addMonths(month, 1))}>
              <ChevronRight size={14} />
            </button>
            {!isCurrent && (
              <button class="btn btn-ghost btn-xs text-fg-3" onClick={() => setMonth(monthStart(new Date()))}>
                Today
              </button>
            )}
          </div>
          <div class="ml-auto">
            <Btn variant="primary" onClick={() => setEditing('new')}>
              <Plus size={13} /> Add entry
            </Btn>
          </div>
        </div>

        <Totals summary={summary.data} />

        <Panel
          title="Transactions"
          class="flex-1 min-h-[320px] lg:min-h-0 flex flex-col"
          noPad
          right={
            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1.5 h-7 px-2 rounded-md bg-[#121213] border border-line">
                <Search size={11} class="text-fg-3" />
                <input class="bg-transparent outline-none text-[12px] w-28 sm:w-40" placeholder="Search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
              </label>
              <select class="select select-xs bg-[#121213] border-line rounded-md text-[12px]" value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value as any)}>
                <option value="">All</option>
                <option value="expense">Expenses</option>
                <option value="income">Income</option>
                <option value="transfer">Transfers</option>
              </select>
            </div>
          }
        >
          <div class="overflow-y-auto flex-1 min-h-0">
            {entries.loading && !entries.data ? (
              <div class="p-6 flex justify-center">
                <Spinner />
              </div>
            ) : !shown.length ? (
              <Empty>{entries.data?.length ? 'No entries match.' : `Nothing recorded for ${monthLabel}. Add an entry, or ask Chat to record transactions from your email.`}</Empty>
            ) : (
              <ul class="divide-y divide-line">
                {shown.map((e) => (
                  <EntryRow key={e.id} e={e} onEdit={() => setEditing(e)} onDelete={() => void remove(e)} />
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </div>

      <div class="lg:w-[340px] xl:w-[380px] shrink-0 flex flex-col gap-4 min-h-0 lg:overflow-y-auto">
        <Categories summary={summary.data} />
        <Budgets summary={summary.data} meta={meta.data} />
      </div>

      {editing && <EntryModal entry={editing === 'new' ? null : editing} meta={meta.data} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Totals(props: { summary?: LedgerSummary }) {
  const t = props.summary?.totals ?? [];
  if (!props.summary) return <div class="h-[68px]" />;
  if (!t.length)
    return (
      <div class="hud-panel px-4 py-3 grid grid-cols-3 gap-4">
        <Stat label="Income" value="—" />
        <Stat label="Expenses" value="—" />
        <Stat label="Net" value="—" />
      </div>
    );
  return (
    <div class="flex flex-col gap-2">
      {t.map((x) => (
        <div key={x.currency} class="hud-panel px-4 py-3 grid grid-cols-3 gap-4">
          <Stat label={`Income · ${x.currency}`} value={<span class="text-success">{money(x.income, x.currency)}</span>} />
          <Stat label="Expenses" value={money(x.expense, x.currency)} sub={x.transfer ? `${money(x.transfer, x.currency)} transferred` : undefined} />
          <Stat label="Net" value={<span class={x.net < 0 ? 'text-red' : 'text-fg'}>{money(x.net, x.currency)}</span>} />
        </div>
      ))}
    </div>
  );
}

function EntryRow(props: { e: LedgerEntry; onEdit: () => void; onDelete: () => void }) {
  const e = props.e;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? new Date(`${e.date}T00:00:00`) : new Date(e.date);
  return (
    <li class="group flex items-center gap-3 px-3.5 py-2.5 hover:bg-white/[0.02]">
      <div class="w-10 shrink-0 text-center">
        <div class="text-[15px] text-fg leading-none">{d.getDate()}</div>
        <div class="text-[10px] text-fg-3 uppercase mt-0.5">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-[13px] text-fg truncate" title={e.notes || e.description}>
            {e.description}
          </span>
          {e.source === 'agent' && (
            <span title={`Recorded by the agent${e.sourceRef ? ` · ${e.sourceRef}` : ''}`} class="text-fg-3 shrink-0">
              <Bot size={11} />
            </span>
          )}
        </div>
        <div class="flex flex-wrap items-center gap-1.5 mt-0.5 text-[11.5px] text-fg-3">
          {e.category && <Tag>{e.category}</Tag>}
          {e.account && (
            <span>
              {e.account}
              {e.toAccount ? ` → ${e.toAccount}` : ''}
            </span>
          )}
          {e.merchant && e.merchant !== e.description && <span>· {e.merchant}</span>}
          {e.tags.map((t) => (
            <span key={t}>#{t}</span>
          ))}
        </div>
      </div>
      <div class={`text-[13.5px] tabular-nums shrink-0 ${e.type === 'income' ? 'text-success' : e.type === 'transfer' ? 'text-fg-2' : 'text-fg'}`}>
        {SIGN[e.type]}
        {money(e.amount, e.currency)}
      </div>
      <div class="flex gap-0.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <button class="btn btn-ghost btn-xs px-1.5" title="Edit" onClick={props.onEdit}>
          <Pencil size={11} />
        </button>
        <button class="btn btn-ghost btn-xs px-1.5 hover:text-red" title="Delete" onClick={props.onDelete}>
          <Trash2 size={11} />
        </button>
      </div>
    </li>
  );
}

function Categories(props: { summary?: LedgerSummary }) {
  const cats = (props.summary?.byCategory ?? []).filter((c) => c.expense > 0);
  const max = Math.max(1, ...cats.map((c) => c.expense));
  return (
    <Panel title="Spending by category">
      {!cats.length ? (
        <div class="text-[12.5px] text-fg-3">No expenses this month.</div>
      ) : (
        <ul class="flex flex-col gap-2.5">
          {cats.map((c) => (
            <li key={`${c.category}-${c.currency}`}>
              <div class="flex items-baseline justify-between gap-2 text-[12.5px]">
                <span class="text-fg-2 truncate">{c.category}</span>
                <span class="tabular-nums text-fg">{money(c.expense, c.currency)}</span>
              </div>
              <div class="h-1 mt-1 rounded-full bg-raised overflow-hidden">
                <div class="h-full bg-fg-3 rounded-full" style={{ width: `${(c.expense / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Budgets(props: { summary?: LedgerSummary; meta?: LedgerMeta }) {
  const [adding, setAdding] = useState(false);
  const [cat, setCat] = useState('');
  const [limit, setLimit] = useState('');
  const [cur, setCur] = useState('');
  const list = props.summary?.budgets ?? [];

  const save = async (b: Partial<LedgerBudget>) => {
    try {
      await api.put('/ledger/budgets', b);
      setAdding(false);
      setCat('');
      setLimit('');
    } catch (e: any) {
      toast(`Budget not saved: ${e?.message ?? e}`, 'error');
    }
  };

  return (
    <Panel
      title="Monthly budgets"
      right={
        !adding && (
          <button class="btn btn-ghost btn-xs text-fg-3 hover:text-fg" onClick={() => setAdding(true)}>
            <Plus size={11} /> Add
          </button>
        )
      }
    >
      {adding && (
        <form
          class="flex flex-col gap-2 mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ category: cat, limit: Number(limit), currency: cur || props.meta?.defaultCurrency });
          }}
        >
          <input class={INPUT} list="ledger-cats" placeholder="Category" value={cat} onInput={(e) => setCat((e.target as HTMLInputElement).value)} required />
          <div class="flex gap-2">
            <input class={INPUT} type="number" min="0" step="any" placeholder="Monthly limit" value={limit} onInput={(e) => setLimit((e.target as HTMLInputElement).value)} required />
            <input class={`${INPUT} !w-24`} placeholder={props.meta?.defaultCurrency ?? 'USD'} value={cur} onInput={(e) => setCur((e.target as HTMLInputElement).value.toUpperCase())} />
          </div>
          <div class="flex gap-2 justify-end">
            <Btn type="button" variant="ghost" size="xs" onClick={() => setAdding(false)}>
              Cancel
            </Btn>
            <Btn type="submit" variant="primary" size="xs">
              Save
            </Btn>
          </div>
        </form>
      )}
      {!list.length && !adding ? (
        <div class="text-[12.5px] text-fg-3">No budgets yet.</div>
      ) : (
        <ul class="flex flex-col gap-3">
          {list.map((b) => {
            const pct = b.limit ? (b.spent / b.limit) * 100 : 0;
            return (
              <li key={`${b.category}-${b.currency}`} class="group">
                <div class="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span class="text-fg-2 truncate">{b.category}</span>
                  <span class="tabular-nums text-fg-3">
                    <span class={pct > 100 ? 'text-red' : 'text-fg'}>{money(b.spent, b.currency)}</span> / {money(b.limit, b.currency)}
                  </span>
                  <button class="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-red" title="Remove budget" onClick={() => void save({ category: b.category, currency: b.currency, limit: 0 })}>
                    <Trash2 size={10} />
                  </button>
                </div>
                <SegBar value={pct} segments={20} tone={pct > 100 ? 'red' : pct > 80 ? 'warn' : 'default'} class="mt-1" />
              </li>
            );
          })}
        </ul>
      )}
      <datalist id="ledger-cats">
        {(props.meta?.categories ?? []).map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </Panel>
  );
}

function EntryModal(props: { entry: LedgerEntry | null; meta?: LedgerMeta; onClose: () => void }) {
  const e = props.entry;
  const [f, setF] = useState({
    type: (e?.type ?? 'expense') as LedgerType,
    date: e ? e.date.slice(0, 10) : ymd(new Date()),
    amount: e ? String(e.amount) : '',
    currency: e?.currency ?? props.meta?.defaultCurrency ?? '',
    description: e?.description ?? '',
    merchant: e?.merchant ?? '',
    category: e?.category ?? '',
    account: e?.account ?? '',
    toAccount: e?.toAccount ?? '',
    tags: e?.tags.join(', ') ?? '',
    notes: e?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (ev: Event) => setF({ ...f, [k]: (ev.target as HTMLInputElement).value });

  const submit = async () => {
    setBusy(true);
    const body = {
      ...f,
      // keep the original time of day when the date is unchanged
      date: e && e.date.slice(0, 10) === f.date ? e.date : f.date,
      currency: f.currency.trim().toUpperCase() || undefined,
      tags: f.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      toAccount: f.type === 'transfer' ? f.toAccount : '',
    };
    try {
      if (e) await api.patch(`/ledger/${enc(e.id)}`, body);
      else await api.post('/ledger', body);
      props.onClose();
    } catch (err: any) {
      toast(`Not saved: ${err?.message ?? err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={props.onClose}
      title={e ? 'Edit entry' : 'Add entry'}
      width="max-w-lg"
      footer={
        <>
          <Btn variant="ghost" onClick={props.onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" loading={busy} disabled={!f.amount || !(f.description || f.merchant)} onClick={() => void submit()}>
            {e ? 'Save' : 'Add'}
          </Btn>
        </>
      }
    >
      <form
        class="flex flex-col gap-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          void submit();
        }}
      >
        <div class="flex gap-1 p-0.5 rounded-md bg-[#121213] border border-line self-start">
          {(['expense', 'income', 'transfer'] as LedgerType[]).map((t) => (
            <button
              type="button"
              key={t}
              class={`px-3 h-7 rounded text-[12.5px] capitalize ${f.type === t ? 'bg-raised text-fg' : 'text-fg-3 hover:text-fg-2'}`}
              onClick={() => setF({ ...f, type: t })}
            >
              {t}
            </button>
          ))}
        </div>
        <div class="grid grid-cols-[1fr_96px] gap-2">
          <Field label="Amount">
            <input class={INPUT} type="number" min="0" step="any" value={f.amount} onInput={set('amount')} autoFocus required />
          </Field>
          <Field label="Currency">
            <input class={INPUT} list="ledger-curs" placeholder="USD" value={f.currency} onInput={set('currency')} />
          </Field>
        </div>
        <Field label="Description">
          <input class={INPUT} value={f.description} onInput={set('description')} placeholder="e.g. Groceries" />
        </Field>
        <div class="grid grid-cols-2 gap-2">
          <Field label="Date">
            <input class={INPUT} type="date" value={f.date} onInput={set('date')} />
          </Field>
          <Field label="Category">
            <input class={INPUT} list="ledger-cats-m" value={f.category} onInput={set('category')} />
          </Field>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <Field label={f.type === 'transfer' ? 'From account' : 'Account'}>
            <input class={INPUT} list="ledger-accs" value={f.account} onInput={set('account')} placeholder="e.g. BCA debit" />
          </Field>
          {f.type === 'transfer' ? (
            <Field label="To account">
              <input class={INPUT} list="ledger-accs" value={f.toAccount} onInput={set('toAccount')} />
            </Field>
          ) : (
            <Field label="Merchant">
              <input class={INPUT} value={f.merchant} onInput={set('merchant')} />
            </Field>
          )}
        </div>
        <Field label="Tags" hint="Comma separated">
          <input class={INPUT} value={f.tags} onInput={set('tags')} />
        </Field>
        <Field label="Notes">
          <textarea class={TEXTAREA} rows={2} value={f.notes} onInput={set('notes')} />
        </Field>
        <button type="submit" class="hidden" />
        <datalist id="ledger-cats-m">
          {(props.meta?.categories ?? []).map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <datalist id="ledger-accs">
          {(props.meta?.accounts ?? []).map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <datalist id="ledger-curs">
          {(props.meta?.currencies ?? []).map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </form>
    </Modal>
  );
}

