/**
 * Token/cost usage accounting. Contract (signatures fixed): recordUsage(), usageReport().
 * Each completed turn is folded into an hourly per-model bucket (data/usage.json), kept for 35 days.
 * Reports: 24h → 24 hourly points; 7d / 30d → daily points (local days).
 */
import type { Usage, UsagePoint, UsageReport } from '@monarch/shared';
import { serviceStore } from './persist.ts';

interface Bucket {
  /** bucket start (ms, UTC hour boundary) */
  t: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
}

const HOUR = 3600e3;
const RETAIN_MS = 35 * 86400e3;
const store = serviceStore<Bucket[]>('usage', []);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** record one completed model turn (called by the agent orchestrator after each chat.done) */
export function recordUsage(model: string, usage: Usage): void {
  if (!usage) return;
  const now = Date.now();
  const t = Math.floor(now / HOUR) * HOUR;
  const m = model || 'unknown';
  store.update((arr) => {
    let b = arr.find((x) => x.t === t && x.model === m);
    if (!b) {
      b = { t, model: m, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 };
      arr.push(b);
    }
    b.inputTokens += num(usage.inputTokens);
    b.outputTokens += num(usage.outputTokens);
    b.cacheReadTokens += num(usage.cacheReadTokens);
    b.cacheWriteTokens += num(usage.cacheWriteTokens);
    b.costUsd += num(usage.costUsd);
    b.requests += 1;
    const cutoff = now - RETAIN_MS;
    if (arr.length && arr[0].t < cutoff) return arr.filter((x) => x.t >= cutoff);
  });
}

const emptyPoint = (ts: number): UsagePoint => ({ ts: new Date(ts).toISOString(), inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0 });

export function usageReport(range: UsageReport['range']): UsageReport {
  const r: UsageReport['range'] = range === '7d' || range === '30d' ? range : '24h';
  const now = new Date();
  // bucket starts, oldest first
  const starts: number[] = [];
  if (r === '24h') {
    const cur = Math.floor(now.getTime() / HOUR) * HOUR;
    for (let i = 23; i >= 0; i--) starts.push(cur - i * HOUR);
  } else {
    const days = r === '7d' ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) starts.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime());
  }
  const points = starts.map(emptyPoint);
  const from = starts[0];
  const byModel = new Map<string, { model: string; tokens: number; costUsd: number }>();
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0 };

  for (const b of store.get()) {
    if (b.t < from) continue;
    // last bucket whose start <= b.t
    let idx = starts.length - 1;
    while (idx > 0 && starts[idx] > b.t) idx--;
    const p = points[idx];
    p.inputTokens += b.inputTokens;
    p.outputTokens += b.outputTokens;
    p.costUsd += b.costUsd;
    p.requests += b.requests;
    totals.inputTokens += b.inputTokens;
    totals.outputTokens += b.outputTokens;
    totals.costUsd += b.costUsd;
    totals.requests += b.requests;
    const m = byModel.get(b.model) ?? { model: b.model, tokens: 0, costUsd: 0 };
    m.tokens += b.inputTokens + b.outputTokens;
    m.costUsd += b.costUsd;
    byModel.set(b.model, m);
  }
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  for (const p of points) p.costUsd = round(p.costUsd);
  totals.costUsd = round(totals.costUsd);
  return {
    range: r,
    points,
    totals,
    byModel: [...byModel.values()].map((m) => ({ ...m, costUsd: round(m.costUsd) })).sort((a, b) => b.tokens - a.tokens),
  };
}
