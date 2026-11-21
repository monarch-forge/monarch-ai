import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { batchTool, fill, innerCaller, trim } from './batch.ts';
import type { ToolDef } from '../kernel.ts';

const tool = (name: string, risk: ToolDef['risk'], run: (i: any) => unknown): ToolDef => ({ name, description: name, risk, schema: z.object({ id: z.string().optional() }).passthrough(), run });

const defs = new Map<string, ToolDef>([
  ['read', tool('read', 'safe', async (i) => { await new Promise((r) => setTimeout(r, 100)); return `thread ${i.id}\nsubject: hello ${i.id}\nbody: long text`; })],
  ['update', tool('update', 'sensitive', (i) => `updated ${i.id}`)],
  ['mail_send', tool('mail_send', 'dangerous', () => 'sent')],
  ['boom', tool('boom', 'safe', () => { throw new Error('bad id'); })],
]);
const runAsync = async (d: ToolDef, input: unknown) => String(await d.run(input as any, {} as any));

function ctx(approvals: string[], approve = true) {
  const caller = innerCaller((n) => defs.get(n), async (a) => (approvals.push(a.name), approve), runAsync, 'c1');
  return { sessionId: 's', cwd: '/', signal: new AbortController().signal, progress: () => {}, callTool: caller } as any;
}

test('fill replaces $item and $item.field, leaves other values', () => {
  assert.deepEqual(fill({ id: '$item.id', x: 'keep', n: ['$item'] }, { id: 'a' }), { id: 'a', x: 'keep', n: [{ id: 'a' }] });
});

test('trim keeps grep lines and caps length', () => {
  assert.equal(trim('a\nsubject: x\nb', ['SUBJECT'], 100), 'subject: x');
  assert.match(trim('x'.repeat(50), undefined, 10), /^x{10}… \[\+40 chars\]$/);
});

test('each runs read-only calls in parallel, every call approved, results trimmed', async () => {
  const approvals: string[] = [];
  const b = batchTool((n) => defs.get(n));
  const t0 = Date.now();
  const out = String(await b.run({ each: { tool: 'read', items: ['1', '2', '3', '4'], args: { id: '$item' } }, grep: ['subject'] }, ctx(approvals)));
  assert.ok(Date.now() - t0 < 300, 'overlapped');
  assert.equal(approvals.length, 4);
  assert.match(out, /^4 calls, 4 ok\./);
  assert.match(out, /subject: hello 3/);
  assert.doesNotMatch(out, /body: long text/);
});

test('dangerous tools, unknown tools and errors are reported per call, not thrown', async () => {
  const out = String(await batchTool((n) => defs.get(n)).run({ calls: [{ tool: 'mail_send' }, { tool: 'nope' }, { tool: 'boom' }, { tool: 'update', args: { id: 'x' } }] }, ctx([])));
  assert.match(out, /4 calls, 1 ok, 3 failed/);
  assert.match(out, /mail_send: ERROR .*call it directly/);
  assert.match(out, /nope: ERROR Unknown tool/);
  assert.match(out, /boom: ERROR bad id/);
  assert.match(out, /updated x/);
});

test('a declined approval fails that call only', async () => {
  const out = String(await batchTool((n) => defs.get(n)).run({ calls: [{ tool: 'update', args: { id: 'x' } }] }, ctx([], false)));
  assert.match(out, /declined/);
});
