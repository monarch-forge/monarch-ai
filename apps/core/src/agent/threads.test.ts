import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MONARCH_HOME = mkdtempSync(join(tmpdir(), 'monarch-threads-'));
const T = await import('./threads.ts');
const { withThreadsNote } = T;
type Rec = import('./sessions.ts').SessionRecord;

const rec = (over: Partial<Rec> = {}): Rec =>
  ({ id: 'c1', title: 'Chat', kind: 'chat', engine: 'pi', model: '', createdAt: '', updatedAt: '', itemCount: 0, usage: {} as never, running: false, items: [], engineState: {}, ...over }) as Rec;

test('upsert creates, matches by title, merges links, close via status', () => {
  const list: import('@monarch/shared').ChatThread[] = [];
  const a = T.upsertThread(list, { title: 'Fix login bug', area: 'repo:backend', next: 'review PR' }, '2026-01-01');
  const b = T.upsertThread(list, { title: 'fix LOGIN bug', links: [{ kind: 'pr', ref: 'https://x/1' }] }, '2026-01-02');
  T.upsertThread(list, { id: a.id, links: [{ kind: 'pr', ref: 'https://x/1' }] }, '2026-01-03');
  assert.equal(a, b);
  assert.equal(list.length, 1);
  assert.equal(a.links.length, 1);
  assert.equal(a.area, 'repo:backend');
  T.upsertThread(list, { id: a.id, status: 'done' });
  assert.equal(T.boardSummary(list), '');
  assert.throws(() => T.upsertThread(list, { id: 'nope' }));
  assert.equal(T.upsertThread(list, { id: 'made-up', title: 'New one' }).title, 'New one'); // invented id + title creates
  assert.throws(() => T.upsertThread(list, {}));
});

test('board summary: open only, newest first, capped lines and chars', () => {
  const list: import('@monarch/shared').ChatThread[] = [];
  for (let i = 0; i < 20; i++) T.upsertThread(list, { title: `t${i} ${'x'.repeat(200)}`, area: 'work', next: 'y'.repeat(200) }, `2026-01-${String(i + 1).padStart(2, '0')}`);
  const s = T.boardSummary(list);
  const lines = s.split('\n');
  assert.ok(lines.length <= 9, `${lines.length} lines`);
  assert.ok(s.length <= 1300, `${s.length} chars`);
  assert.match(lines[0], /\] \(work\) t19 /);
  assert.match(lines[lines.length - 1], /more open/);
});

test('pi note: injected once, re-sent only on change, reset after compaction', () => {
  const r = rec();
  assert.equal(withThreadsNote(r, 'hi'), 'hi'); // empty board → nothing
  T.upsertThread(T.threadsOf(r), { title: 'Reply to Andi', area: 'person:Andi' });
  assert.match(withThreadsNote(r, 'hi'), /<context>[\s\S]*Reply to Andi[\s\S]*<\/context>\n\nhi$/);
  assert.equal(withThreadsNote(r, 'hi'), 'hi');
  r.engineState.threadsNote = undefined; // what compaction does
  assert.match(withThreadsNote(r, 'hi'), /Reply to Andi/);
  assert.equal(T.boardBlock(rec({ kind: 'coding' })), '');
});

test('worker follow-up: once per completion, only when parent idle, loop-guarded', () => {
  const parent = rec();
  T.upsertThread(T.threadsOf(parent), { title: 'Triage work inbox', area: 'work', links: [{ kind: 'worker', ref: 'w1' }] });
  const worker = rec({ id: 'w1', kind: 'coding', parentSessionId: 'c1', items: [{ kind: 'user', id: '1', ts: '', text: 'go' }] });
  const sent: string[] = [];
  let running = false;
  const deps = {
    getSession: (id: string) => (id === 'c1' ? parent : undefined),
    isRunning: () => running,
    send: (_: string, t: string) => {
      sent.push(t);
      parent.items.push({ kind: 'user', id: String(sent.length), ts: '', text: t });
    },
    save: () => {},
  };
  T.onWorkerFinished(worker, 'Done: 3 mails need replies', undefined, false, deps);
  T.onWorkerFinished(worker, 'Done again', undefined, false, deps); // same completion
  assert.equal(sent.length, 1);
  assert.match(sent[0], /thread 'Triage work inbox' finished: Done: 3 mails/);
  assert.equal(T.threadsOf(parent)[0].needsReport, true);
  assert.match(T.boardSummary(T.threadsOf(parent)), /NEEDS REPORT/);

  // aborted → nothing; busy parent → marked but not sent
  worker.items.push({ kind: 'assistant', id: 'a', ts: '', text: 'x' });
  T.onWorkerFinished(worker, '', undefined, true, deps);
  assert.equal(sent.length, 1);
  running = true;
  T.onWorkerFinished(worker, 'r2', undefined, false, deps);
  assert.equal(sent.length, 1);
  running = false;
  T.flushNudge(parent, deps.send); // parked nudge sent after the parent's turn
  assert.equal(sent.length, 2);
  assert.equal(T.flushNudge(parent, deps.send), undefined); // only once
  worker.items.push({ kind: 'assistant', id: 'c', ts: '', text: 'x' });
  running = true;
  T.onWorkerFinished(worker, 'r3', undefined, false, deps);
  running = false;
  T.upsertThread(T.threadsOf(parent), { title: 'Triage work inbox', status: 'waiting' }); // agent handled it itself
  assert.equal(T.flushNudge(parent, deps.send), undefined);

  // loop guard: after 3 auto follow-ups in a row, stop
  for (let i = 0; i < 5; i++) {
    worker.items.push({ kind: 'assistant', id: `b${i}`, ts: '', text: 'x' });
    T.onWorkerFinished(worker, `r${i}`, undefined, false, deps);
  }
  assert.equal(sent.length, 3);

  // unlinked worker → nothing
  const other = rec({ id: 'w2', kind: 'coding', parentSessionId: 'c1' });
  assert.equal(T.onWorkerFinished(other, 'x', undefined, false, deps), undefined);
});
