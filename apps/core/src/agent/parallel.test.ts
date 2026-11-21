import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@earendil-works/pi-agent-core';
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall, streamSimple } from '@earendil-works/pi-ai/compat';
import { canRunParallel } from './parallel.ts';

test('read-only safe tools may run in parallel; approvals and ordered writes may not', () => {
  assert.equal(canRunParallel({ name: 'mail_search', risk: 'safe' }), true);
  assert.equal(canRunParallel({ name: 'calendar_list', risk: 'safe' }), true);
  assert.equal(canRunParallel({ name: 'plan_set', risk: 'safe' }), false);
  assert.equal(canRunParallel({ name: 'memory_write', risk: 'safe' }), false);
  assert.equal(canRunParallel({ name: 'thread_upsert', risk: 'safe' }), false);
  assert.equal(canRunParallel({ name: 'send_notification', risk: 'safe' }), false);
  assert.equal(canRunParallel({ name: 'mail_send', risk: 'dangerous' }), false);
  assert.equal(canRunParallel({ name: 'fs_edit', risk: 'sensitive' }), false);
});

async function batchTime(modeA: 'parallel' | 'sequential', modeB: 'parallel' | 'sequential'): Promise<number> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxToolCall('a', {}), fauxToolCall('b', {})], { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
  const slow = (name: string, executionMode: 'parallel' | 'sequential') => ({
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    executionMode,
    execute: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { content: [{ type: 'text' as const, text: name }], details: {} };
    },
  });
  const agent = new Agent({ initialState: { model: faux.getModel(), tools: [slow('a', modeA), slow('b', modeB)] as any }, toolExecution: 'parallel', streamFn: streamSimple } as any);
  const t0 = Date.now();
  await agent.prompt('go');
  return Date.now() - t0;
}

test('pi overlaps a batch of parallel tools, and a sequential one keeps the batch in order', async () => {
  const par = await batchTime('parallel', 'parallel');
  const seq = await batchTime('parallel', 'sequential');
  assert.ok(par < 500, `parallel batch took ${par}ms`);
  assert.ok(seq >= 600, `mixed batch took ${seq}ms`);
});
