import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@monarch/shared';

process.env.MONARCH_HOME = mkdtempSync(join(tmpdir(), 'monarch-skill-learn-'));
const { taskSignature, lastTurn, countSuccess, parseDraft, draftSkill } = await import('./skill-learn.ts');
const { listSkills, readSkill, approveSkill, skillsPromptContext } = await import('../extensions/index.ts');

const ts = new Date().toISOString();
const tool = (name: string, status = 'ok'): ChatItem => ({ kind: 'tool', id: name + Math.random(), ts, toolCallId: 'c', name, input: { q: 'x' }, status, output: 'done' }) as ChatItem;
const user = (text: string): ChatItem => ({ kind: 'user', id: 'u' + Math.random(), ts, text }) as ChatItem;

test('signature: sorted unique task tools of the last turn, meta tools and failures ignored', () => {
  const items = [user('old'), tool('gh_pr_list'), user('add the invoice from mail'), tool('skill_read'), tool('mail_search'), tool('mail_search'), tool('ledger_add'), tool('web_fetch', 'error')];
  assert.equal(taskSignature('chat', lastTurn(items)), 'chat:ledger_add+mail_search');
  assert.equal(taskSignature('chat', [tool('mail_search')]), null, 'one call is not a task');
});

test('repeat detection: drafts on the 2nd success, then never again', () => {
  assert.equal(countSuccess('chat:a+b'), false);
  assert.equal(countSuccess('chat:a+b'), true);
});

test('parseDraft + draft lifecycle: hidden until approved', async () => {
  assert.equal(parseDraft('NONE'), null);
  const out = 'NAME: Log mailed invoice\nWHEN: User asks to record an invoice from email\n## Steps\n1. mail_search for it\n2. ledger_add\n## Pitfalls\n- check currency';
  const rec = { id: 's1', kind: 'chat', items: [user('log invoice'), tool('mail_search'), tool('ledger_add')] } as never;
  const id = await draftSkill(rec, 'chat:a+b', async () => out);
  assert.equal(id, 'log-mailed-invoice');
  assert.equal(listSkills().find((s) => s.id === id)?.draft, true);
  assert.equal(skillsPromptContext(), '');
  assert.throws(() => readSkill(id!));
  assert.equal(countSuccess('chat:a+b'), false, 'already drafted');
  approveSkill(id!);
  assert.match(skillsPromptContext(), /log-mailed-invoice/);
});
