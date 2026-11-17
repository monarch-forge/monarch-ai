/** Ledger routes — see protocol.ts "/api/ledger" lines. */
import type { Hono } from 'hono';
import type { LedgerType } from '@monarch/shared';
import { readJson } from '../services/http.ts';
import { parseWhen } from '../services/dates.ts';
import { addLedgerEntry, deleteLedgerEntry, ledgerMeta, ledgerSummary, listBudgets, listLedger, setBudget, updateLedgerEntry, type LedgerInput } from '../services/ledger.ts';

const when = (v: string | undefined): Date | undefined => (v ? (parseWhen(v) ?? undefined) : undefined);

export function register(app: Hono): void {
  app.get('/api/ledger', (c) => {
    const q = c.req.query();
    return c.json(
      listLedger({
        from: when(q.from),
        to: when(q.to),
        type: (q.type as LedgerType) || undefined,
        category: q.category || undefined,
        account: q.account || undefined,
        currency: q.currency || undefined,
        tag: q.tag || undefined,
        q: q.q || undefined,
        sourceRef: q.sourceRef || undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });
  app.get('/api/ledger/summary', (c) => c.json(ledgerSummary(when(c.req.query('from')), when(c.req.query('to')))));
  app.get('/api/ledger/meta', (c) => c.json(ledgerMeta()));
  app.get('/api/ledger/budgets', (c) => c.json(listBudgets()));
  app.put('/api/ledger/budgets', async (c) => c.json(setBudget(await readJson(c))));
  app.post('/api/ledger', async (c) => c.json(addLedgerEntry(await readJson<LedgerInput>(c), 'manual'), 201));
  app.patch('/api/ledger/:id', async (c) => c.json(updateLedgerEntry(c.req.param('id'), await readJson<LedgerInput>(c))));
  app.delete('/api/ledger/:id', (c) => {
    deleteLedgerEntry(c.req.param('id'));
    return c.json({ ok: true });
  });
}
