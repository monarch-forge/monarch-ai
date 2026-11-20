/** Ledger — personal finance: entries by month, totals, categories, budgets; manual add/edit (route #/ledger). */
import type { ComponentChildren } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import type { LedgerAccountType, LedgerAccountView, LedgerBudget, LedgerEntry, LedgerMeta, LedgerSeriesPoint, LedgerSummary, LedgerType } from '@monarch/shared';
import { ChevronLeft, ChevronRight, Plus, Pencil, Trash2, Search, Bot } from 'lucide-preact';
import { api } from '../lib/api.ts';
import { toast, useResource } from '../lib/store.ts';
import { Btn, DotText, EmptyState, Glyph, ListRow, Panel, Pills, Skeleton, Stat, Tag } from '../components/ui.tsx';
import { askMonarch, Modal, useConfirm } from '../components/mail/kit.tsx';
import { Field, INPUT, SELECT, TEXTAREA } from '../components/config/fields.tsx';

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
    <div class="h-full overflow-y-auto">
      <div class="p-3 sm:p-4 lg:p-5 flex flex-col lg:flex-row gap-4 items-start">
        {dialog}
        <div class="flex flex-col gap-4 min-w-0 w-full lg:flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="ds-dot uppercase text-[30px] leading-none text-fg mr-2">Ledger</h1>
            <div class="flex items-center gap-1">
              <Btn pill variant="ghost" size="xs" title="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
                <ChevronLeft size={14} />
              </Btn>
              <span class="text-[13px] text-fg-2 min-w-[120px] text-center">{monthLabel}</span>
              <Btn pill variant="ghost" size="xs" title="Next month" onClick={() => setMonth(addMonths(month, 1))}>
                <ChevronRight size={14} />
              </Btn>
              {!isCurrent && (
                <Btn pill variant="ghost" size="xs" class="text-fg-3" onClick={() => setMonth(monthStart(new Date()))}>
                  Today
                </Btn>
              )}
            </div>
            <div class="ml-auto">
              <Btn pill variant="primary" onClick={() => setEditing('new')}>
                <Plus size={13} /> Add entry
              </Btn>
            </div>
          </div>

          <Totals summary={summary.data} />

          <Charts month={month} currency={meta.data?.defaultCurrency} />

          <Collapsible
            id="transactions"
            title={`Transactions${entries.data ? ` · ${entries.data.length}` : ''}`}
            right={
              <div class="flex items-center gap-2">
                <label class="flex items-center gap-1.5 h-7 px-3 rounded-full bg-base-200 border border-line">
                  <Search size={11} class="text-fg-3" />
                  <input class="bg-transparent outline-none text-[12px] w-24 sm:w-40" placeholder="Search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
                </label>
                <select class="select select-xs bg-base-200 border-line rounded-[var(--radius-control)] text-[12px]" value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value as any)}>
                  <option value="">All</option>
                  <option value="expense">Expenses</option>
                  <option value="income">Income</option>
                  <option value="transfer">Transfers</option>
                </select>
              </div>
            }
          >
            {entries.loading && !entries.data ? (
              <Skeleton lines={6} class="p-4" />
            ) : !shown.length ? (
              entries.data?.length ? (
                <EmptyState title="No entries match" hint="Try another search or type filter." actions={<Btn pill onClick={() => { setQ(''); setType(''); }}>Clear filters</Btn>} />
              ) : (
                <EmptyState
                  icon={<Bot size={18} strokeWidth={1.5} />}
                  title={`Nothing recorded for ${monthLabel}`}
                  hint="Add an entry by hand, or let Monarch pull transactions out of your email receipts."
                  actions={
                    <>
                      <Btn pill variant="primary" onClick={() => setEditing('new')}>
                        <Plus size={13} /> Add entry
                      </Btn>
                      <Btn pill onClick={() => askMonarch(`Import my transactions for ${monthLabel} from my email (receipts, bank and card notifications) into the ledger. Skip duplicates.`)}>Import from email</Btn>
                    </>
                  }
                />
              )
            ) : (
              <ul class="flex flex-col gap-0.5 p-1.5">
                {shown.map((e) => (
                  <EntryRow key={e.id} e={e} onEdit={() => setEditing(e)} onDelete={() => void remove(e)} />
                ))}
              </ul>
            )}
          </Collapsible>
        </div>

        <div class="w-full lg:w-[340px] xl:w-[380px] shrink-0 flex flex-col gap-4 lg:sticky lg:top-0">
          <Accounts meta={meta.data} />
          <Categories summary={summary.data} />
          <Budgets summary={summary.data} meta={meta.data} />
        </div>

        {editing && <EntryModal entry={editing === 'new' ? null : editing} meta={meta.data} onClose={() => setEditing(null)} />}
      </div>
    </div>
  );
}

/** card with a header that folds the body; open state remembered per id */
function Collapsible(props: { id: string; title: string; right?: ComponentChildren; children: ComponentChildren }) {
  const key = `ledger.open.${props.id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== '0';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? '0' : '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <section class="hud-panel">
      <header class="hud-head">
        <button class="flex items-center gap-1.5 text-left" onClick={toggle} aria-expanded={open}>
          <ChevronRight size={13} class={`text-fg-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          <h2 class="hud-title">{props.title}</h2>
        </button>
        {open && <div class="ml-auto flex items-center gap-2">{props.right}</div>}
      </header>
      {open && <div>{props.children}</div>}
    </section>
  );
}

function Totals(props: { summary?: LedgerSummary }) {
  const t = props.summary?.totals ?? [];
  if (!props.summary) return <Skeleton h={68} class="rounded-[var(--radius-card)]" />;
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
          <Stat label={`Income · ${x.currency}`} value={<DotText class="text-success">{money(x.income, x.currency)}</DotText>} />
          <Stat label="Expenses" value={<DotText>{money(x.expense, x.currency)}</DotText>} sub={x.transfer ? `${money(x.transfer, x.currency)} transferred` : undefined} />
          <Stat label="Net" value={<DotText class={x.net < 0 ? 'text-red' : 'text-fg'}>{money(x.net, x.currency)}</DotText>} />
        </div>
      ))}
    </div>
  );
}

function EntryRow(props: { e: LedgerEntry; onEdit: () => void; onDelete: () => void }) {
  const e = props.e;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? new Date(`${e.date}T00:00:00`) : new Date(e.date);
  return (
    <li>
      <ListRow outline
        class="px-3.5"
        lead={
          <span class="block w-10 text-center">
            <DotText class="block text-[15px] text-fg leading-none">{d.getDate()}</DotText>
            <span class="block text-[10px] text-fg-3 uppercase mt-0.5">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
          </span>
        }
        title={
          <span class="flex items-center gap-1.5 min-w-0 text-[13px]">
            <span class="truncate" title={e.notes || e.description}>
              {e.description}
            </span>
            {e.source === 'agent' && (
              <span title={`Recorded by the agent${e.sourceRef ? ` · ${e.sourceRef}` : ''}`} class="text-fg-3 shrink-0">
                <Bot size={11} />
              </span>
            )}
          </span>
        }
        sub={
          <span class="flex flex-wrap items-center gap-1.5 text-[11.5px]">
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
          </span>
        }
        trail={
          <>
            <span class={`text-[13.5px] tabular-nums ${e.type === 'income' ? 'text-success' : e.type === 'transfer' ? 'text-fg-2' : 'text-fg'}`}>
              {SIGN[e.type]}
              {money(e.amount, e.currency)}
            </span>
            <span class="flex gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
              <Btn pill variant="ghost" size="xs" class="px-1.5" title="Edit" onClick={props.onEdit}>
                <Pencil size={11} />
              </Btn>
              <Btn pill variant="ghost" size="xs" class="px-1.5 hover:text-red" title="Delete" onClick={props.onDelete}>
                <Trash2 size={11} />
              </Btn>
            </span>
          </>
        }
      />
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
          <Btn pill variant="ghost" size="xs" class="text-fg-3 hover:text-fg" onClick={() => setAdding(true)}>
            <Plus size={11} /> Add
          </Btn>
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
            <Btn pill type="button" variant="ghost" size="xs" onClick={() => setAdding(false)}>
              Cancel
            </Btn>
            <Btn pill type="submit" variant="primary" size="xs">
              Save
            </Btn>
          </div>
        </form>
      )}
      {!list.length && !adding ? (
        <EmptyState
          class="!py-4"
          title="No budgets yet"
          hint="Set a monthly limit per category and watch it fill up."
          actions={
            <Btn pill size="xs" onClick={() => setAdding(true)}>
              <Plus size={11} /> Add budget
            </Btn>
          }
        />
      ) : (
        <ul class="flex flex-col gap-0.5 -mx-3">
          {list.map((b) => {
            const pct = b.limit ? (b.spent / b.limit) * 100 : 0;
            return (
              <li key={`${b.category}-${b.currency}`}>
                <ListRow outline
                  class="py-2"
                  title={<span class="text-[12.5px] text-fg-2">{b.category}</span>}
                  sub={<Glyph value={Math.min(100, pct) / 10} of={10} tone={pct > 100 ? 'red' : pct > 80 ? 'warn' : 'fg'} class="mt-1" title={`${Math.round(pct)}% used`} />}
                  trail={
                    <>
                      <span class="tabular-nums text-[12.5px]">
                        <span class={pct > 100 ? 'text-red' : 'text-fg'}>{money(b.spent, b.currency)}</span> / {money(b.limit, b.currency)}
                      </span>
                      <Btn pill variant="ghost" size="xs" class="px-1 h-5 min-h-0 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red" title="Remove budget" aria-label={`Remove ${b.category} budget`} onClick={() => void save({ category: b.category, currency: b.currency, limit: 0 })}>
                        <Trash2 size={10} />
                      </Btn>
                    </>
                  }
                />
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
          <Btn pill variant="ghost" onClick={props.onClose}>
            Cancel
          </Btn>
          <Btn pill variant="primary" loading={busy} disabled={!f.amount || !(f.description || f.merchant)} onClick={() => void submit()}>
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
        <Pills
          class="self-start"
          size="md"
          value={f.type}
          onChange={(t) => setF({ ...f, type: t })}
          options={(['expense', 'income', 'transfer'] as LedgerType[]).map((t) => ({ value: t, label: <span class="capitalize">{t}</span> }))}
        />
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


/* ─────────────── charts ─────────────── */

// validated pair (dataviz validator, dark surface #1c1c1e): all checks pass
const INCOME = '#4e9a6c';
const EXPENSE = '#d71921';

function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(600);
  const ref = useRef<ResizeObserver | null>(null);
  const attach = (el: HTMLDivElement | null) => {
    ref.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    ref.current = ro;
  };
  return [attach, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

function Charts(props: { month: Date; currency?: string }) {
  const [view, setView] = useState<'daily' | 'monthly'>('daily');
  const from = view === 'daily' ? ymd(props.month) : ymd(addMonths(props.month, -5));
  const to = ymd(addMonths(props.month, 1));
  const series = useResource<LedgerSeriesPoint[]>(`/ledger/series?from=${from}&to=${to}&bucket=${view === 'daily' ? 'day' : 'month'}`, ['ledger']);
  const currencies = [...new Set((series.data ?? []).map((p) => p.currency))];
  const [cur, setCur] = useState<string | null>(null);
  const currency = cur && currencies.includes(cur) ? cur : currencies.includes(props.currency ?? '') ? props.currency! : currencies[0];
  const points = (series.data ?? []).filter((p) => p.currency === currency);

  return (
    <Panel
      title="Income and spending"
      right={
        <div class="flex items-center gap-2">
          {currencies.length > 1 && (
            <select class="select select-xs bg-base-200 border-line rounded-[var(--radius-control)] text-[12px]" value={currency} onChange={(e) => setCur((e.target as HTMLSelectElement).value)}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
          <Pills
            value={view}
            onChange={setView}
            options={[
              { value: 'daily', label: 'This month' },
              { value: 'monthly', label: '6 months' },
            ]}
          />
        </div>
      }
    >
      {!points.length || points.every((p) => !p.income && !p.expense) ? (
        <div class="h-[180px] grid place-items-center text-[12.5px] text-fg-3">{series.loading && !series.data ? <Skeleton h={160} class="w-full" /> : 'No income or spending in this period.'}</div>
      ) : (
        <BarChart points={points} currency={currency!} daily={view === 'daily'} />
      )}
    </Panel>
  );
}

function BarChart(props: { points: LedgerSeriesPoint[]; currency: string; daily: boolean }) {
  const [attach, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = 180;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const pts = props.points;
  const max = niceMax(Math.max(...pts.map((p) => Math.max(p.income, p.expense))));
  const iw = width - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / pts.length;
  const gap = 2;
  const bw = Math.max(1.5, Math.min(18, (slot - 6) / 2 - gap / 2));
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const label = (k: string) => {
    const d = new Date(`${k}T00:00:00`);
    return props.daily ? String(d.getDate()) : d.toLocaleDateString(undefined, { month: 'short' });
  };
  const every = props.daily ? Math.ceil(pts.length / Math.max(1, Math.floor(iw / 34))) : 1;
  // rounded data end (4px), square at the baseline
  const bar = (x: number, v: number, fill: string) => {
    if (v <= 0) return null;
    const top = y(v);
    const h = pad.t + ih - top;
    const r = Math.min(4, bw / 2, h);
    return <path d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`} fill={fill} />;
  };
  const hp = hover !== null ? pts[hover] : null;

  return (
    <div>
      <div class="flex items-center gap-4 text-[11.5px] text-fg-2 mb-2">
        <span class="flex items-center gap-1.5">
          <i class="inline-block w-2.5 h-2.5 rounded-[2px]" style={{ background: INCOME }} /> Income
        </span>
        <span class="flex items-center gap-1.5">
          <i class="inline-block w-2.5 h-2.5 rounded-[2px]" style={{ background: EXPENSE }} /> Spending
        </span>
        <span class="ml-auto text-fg-3">{props.currency}</span>
      </div>
      <div ref={attach} class="relative" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={H} role="img" aria-label={`Income and spending per ${props.daily ? 'day' : 'month'} in ${props.currency}`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={width - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="#2a2a2d" stroke-width="1" />
              <text x={pad.l - 6} y={y(max * f) + 3.5} text-anchor="end" font-size="10" fill="#6a6a70">
                {compact(max * f)}
              </text>
            </g>
          ))}
          {pts.map((p, i) => {
            const cx = pad.l + slot * i + slot / 2;
            return (
              <g key={p.key}>
                {hover === i && <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="rgb(244 244 246 / 0.04)" />}
                {bar(cx - bw - gap / 2, p.income, INCOME)}
                {bar(cx + gap / 2, p.expense, EXPENSE)}
                {i % every === 0 && (
                  <text x={cx} y={H - 6} text-anchor="middle" font-size="10" fill="#6a6a70">
                    {label(p.key)}
                  </text>
                )}
                <rect x={pad.l + slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {hp && (
          <div
            class="absolute pointer-events-none z-10 rounded-[var(--radius-control)] border border-line bg-[#262629] px-2.5 py-1.5 text-[11.5px] shadow-lg whitespace-nowrap"
            style={{ left: `${Math.min(width - 150, Math.max(0, pad.l + slot * hover! + slot / 2 - 70))}px`, top: '0px' }}
          >
            <div class="text-fg-2 mb-0.5">{new Date(`${hp.key}T00:00:00`).toLocaleDateString(undefined, props.daily ? { weekday: 'short', day: 'numeric', month: 'short' } : { month: 'long', year: 'numeric' })}</div>
            <div class="flex items-center gap-1.5 text-fg">
              <i class="inline-block w-2 h-2 rounded-[2px]" style={{ background: INCOME }} /> Income <span class="ml-auto pl-3 tabular-nums">{money(hp.income, props.currency)}</span>
            </div>
            <div class="flex items-center gap-1.5 text-fg">
              <i class="inline-block w-2 h-2 rounded-[2px]" style={{ background: EXPENSE }} /> Spending <span class="ml-auto pl-3 tabular-nums">{money(hp.expense, props.currency)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────── accounts ─────────────── */

const ACCOUNT_LABEL: Record<LedgerAccountType, string> = { bank: 'Bank', cash: 'Cash', credit: 'Credit card', ewallet: 'E-wallet', investment: 'Investment', other: 'Other' };
const shortDate = (day?: string) => (day ? new Date(`${day.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
/** ms until the end of a local "YYYY-MM-DD" day (negative = past) */
const untilEndOf = (day: string) => new Date(`${day.slice(0, 10)}T23:59:59`).getTime() - Date.now();

function Accounts(props: { meta?: LedgerMeta }) {
  const list = useResource<LedgerAccountView[]>('/ledger/accounts', ['ledger']);
  const [editing, setEditing] = useState<LedgerAccountView | 'new' | null>(null);
  const shown = (list.data ?? []).filter((a) => !a.archived);
  // net worth per currency: assets minus card debt
  const net = new Map<string, number>();
  for (const a of shown) net.set(a.currency, (net.get(a.currency) ?? 0) + a.balance);

  return (
    <Panel
      title="Accounts"
      right={
        <Btn pill variant="ghost" size="xs" class="text-fg-3 hover:text-fg" onClick={() => setEditing('new')}>
          <Plus size={11} /> Add
        </Btn>
      }
    >
      {list.data === undefined && list.loading ? (
        <Skeleton lines={3} />
      ) : !shown.length ? (
        <EmptyState
          class="!py-4"
          title="No accounts yet"
          hint="Add your bank accounts and cards to track balances, card limits and due dates."
          actions={
            <Btn pill size="xs" onClick={() => setEditing('new')}>
              <Plus size={11} /> Add account
            </Btn>
          }
        />
      ) : (
        <ul class="flex flex-col gap-0.5 -mx-3">
          {shown.map((a) => (
            <li key={a.id}>
              <ListRow outline
                top
                class="py-2"
                onClick={() => setEditing(a)}
                title={
                  <span class="flex items-baseline gap-2 text-[12.5px]">
                    <span class="truncate">{a.name}</span>
                    <span class="text-[11px] text-fg-3">{ACCOUNT_LABEL[a.type]}</span>
                  </span>
                }
                sub={
                  a.type === 'credit' ? (
                      <div class="mt-1">
                        {a.creditLimit ? (
                          <Glyph value={Math.min(1, (a.owed ?? 0) / a.creditLimit) * 10} of={10} tone={(a.owed ?? 0) / a.creditLimit > 0.9 ? 'red' : (a.owed ?? 0) / a.creditLimit > 0.7 ? 'warn' : 'fg'} title={`${Math.round(((a.owed ?? 0) / a.creditLimit) * 100)}% of limit used`} />
                        ) : null}
                        <div class="flex flex-wrap gap-x-3 mt-1 text-[11px] text-fg-3">
                          {a.creditLimit ? <span>{money(a.available ?? 0, a.currency)} available</span> : null}
                          {a.nextDue && (a.amountDue ?? 0) > 0 ? (
                            untilEndOf(a.nextDue) < 0 ? (
                              <span class="text-red">
                                {money(a.amountDue!, a.currency)} overdue since {shortDate(a.nextDue)}
                              </span>
                            ) : (
                              <span class={untilEndOf(a.nextDue) < 3 * 86400e3 ? 'text-warning' : ''}>
                                {money(a.amountDue!, a.currency)} due {shortDate(a.nextDue)}
                              </span>
                            )
                          ) : a.nextDue ? (
                            <span>Statement paid · next closes {shortDate(a.nextStatement)}</span>
                          ) : null}
                        </div>
                      </div>
                  ) : undefined
                }
                trail={
                  <>
                    <span class="tabular-nums text-[12.5px] text-fg">
                      {a.type === 'credit' ? (
                        <>
                          <span class="text-fg-3 text-[11px] mr-1">owed</span>
                          {money(a.owed ?? 0, a.currency)}
                        </>
                      ) : (
                        money(a.balance, a.currency)
                      )}
                    </span>
                    <Pencil size={10} class="text-fg-3 opacity-0 group-hover:opacity-100 shrink-0" />
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {shown.length > 1 && (
        <div class="mt-3 pt-2.5 border-t border-dashed border-line flex flex-col gap-0.5">
          {[...net].map(([c, v]) => (
            <div key={c} class="flex justify-between text-[12px]">
              <span class="text-fg-3">Net {c}</span>
              <span class={`tabular-nums ${v < 0 ? 'text-red' : 'text-fg-2'}`}>{money(v, c)}</span>
            </div>
          ))}
        </div>
      )}
      {editing && <AccountModal account={editing === 'new' ? null : editing} meta={props.meta} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function AccountModal(props: { account: LedgerAccountView | null; meta?: LedgerMeta; onClose: () => void }) {
  const a = props.account;
  const [f, setF] = useState({
    name: a?.name ?? '',
    type: (a?.type ?? 'bank') as LedgerAccountType,
    currency: a?.currency ?? props.meta?.defaultCurrency ?? '',
    openingBalance: a ? String(a.openingBalance) : '0',
    openingDate: a?.openingDate?.slice(0, 10) ?? '',
    aliases: a?.aliases.join(', ') ?? '',
    creditLimit: a?.creditLimit ? String(a.creditLimit) : '',
    statementDay: a?.statementDay ? String(a.statementDay) : '',
    dueDay: a?.dueDay ? String(a.dueDay) : '',
    notes: a?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();
  const set = (k: keyof typeof f) => (ev: Event) => setF({ ...f, [k]: (ev.target as HTMLInputElement).value });
  const credit = f.type === 'credit';

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/ledger/accounts', {
        id: a?.id,
        name: f.name,
        type: f.type,
        currency: f.currency.trim().toUpperCase() || undefined,
        openingBalance: f.openingBalance || '0',
        openingDate: f.openingDate || null,
        aliases: f.aliases
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        creditLimit: credit && f.creditLimit ? f.creditLimit : null,
        statementDay: credit && f.statementDay ? Number(f.statementDay) : null,
        dueDay: credit && f.dueDay ? Number(f.dueDay) : null,
        notes: f.notes || null,
      });
      props.onClose();
    } catch (e: any) {
      toast(`Not saved: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!a || !(await confirm({ title: `Delete ${a.name}?`, body: 'The account definition is removed. Its transactions are kept.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/ledger/accounts/${enc(a.id)}`);
      props.onClose();
    } catch (e: any) {
      toast(`Delete failed: ${e?.message ?? e}`, 'error');
    }
  };

  return (
    <Modal
      open
      onClose={props.onClose}
      title={a ? 'Edit account' : 'Add account'}
      width="max-w-lg"
      footer={
        <>
          {a && (
            <Btn pill variant="ghost" class="mr-auto hover:!text-red" onClick={() => void remove()}>
              <Trash2 size={12} /> Delete
            </Btn>
          )}
          <Btn pill variant="ghost" onClick={props.onClose}>
            Cancel
          </Btn>
          <Btn pill variant="primary" loading={busy} disabled={!f.name.trim()} onClick={() => void save()}>
            {a ? 'Save' : 'Add'}
          </Btn>
        </>
      }
    >
      {dialog}
      <form
        class="flex flex-col gap-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        <div class="grid grid-cols-[1fr_150px] gap-2">
          <Field label="Name">
            <input class={INPUT} value={f.name} onInput={set('name')} placeholder="e.g. BCA Visa" autoFocus />
          </Field>
          <Field label="Type">
            <select class={SELECT} value={f.type} onChange={set('type')}>
              {(Object.keys(ACCOUNT_LABEL) as LedgerAccountType[]).map((t) => (
                <option key={t} value={t}>
                  {ACCOUNT_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div class="grid grid-cols-[1fr_96px] gap-2">
          <Field label={credit ? 'Amount owed at start' : 'Opening balance'} hint={credit ? 'What you owed on the card on the start date' : undefined}>
            <input class={INPUT} type="number" step="any" value={f.openingBalance} onInput={set('openingBalance')} />
          </Field>
          <Field label="Currency">
            <input class={INPUT} value={f.currency} onInput={set('currency')} placeholder="USD" />
          </Field>
        </div>
        <Field label="Start date" hint="Transactions before this date don't count toward the balance. Leave empty to count everything.">
          <input class={INPUT} type="date" value={f.openingDate} onInput={set('openingDate')} />
        </Field>
        {credit && (
          <div class="grid grid-cols-3 gap-2">
            <Field label="Credit limit">
              <input class={INPUT} type="number" min="0" step="any" value={f.creditLimit} onInput={set('creditLimit')} />
            </Field>
            <Field label="Statement day">
              <input class={INPUT} type="number" min="1" max="31" value={f.statementDay} onInput={set('statementDay')} placeholder="e.g. 20" />
            </Field>
            <Field label="Due day">
              <input class={INPUT} type="number" min="1" max="31" value={f.dueDay} onInput={set('dueDay')} placeholder="e.g. 5" />
            </Field>
          </div>
        )}
        <Field label="Other names" hint={'Comma separated names transactions may use for this account, e.g. card digits "4411"'}>
          <input class={INPUT} value={f.aliases} onInput={set('aliases')} />
        </Field>
        <Field label="Notes">
          <textarea class={TEXTAREA} rows={2} value={f.notes} onInput={set('notes')} />
        </Field>
        <button type="submit" class="hidden" />
      </form>
    </Modal>
  );
}
