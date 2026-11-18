import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MONARCH_HOME = mkdtempSync(join(tmpdir(), 'monarch-approvals-'));
const { updateSettings } = await import('../settings.ts');
const { needsApproval, requestApproval, respondApproval, pendingApprovals } = await import('./approvals.ts');
const { mergeFacts, parseProfile, renderProfile } = await import('./profile-learn.ts');

test('auto mode: new target asks once, approved target runs; bulk always asks', async () => {
  updateSettings({ permissions: { mode: 'auto' } });
  const repo = { target: 'repo:/x' };
  assert.equal(needsApproval('s1', 'shell_exec', 'dangerous', repo), true);
  assert.equal(needsApproval('s1', 'fs_edit', 'sensitive', repo), true);
  assert.equal(needsApproval('s1', 'fs_read', 'safe', repo), false);
  const p = requestApproval('s1', 'shell_exec', {}, 'dangerous', 'run', undefined, repo);
  respondApproval(pendingApprovals()[0].id, true);
  assert.equal(await p, true);
  assert.equal(needsApproval('s2', 'shell_exec', 'dangerous', repo), false); // global, any session
  assert.equal(needsApproval('s2', 'fs_edit', 'sensitive', repo), false);
  assert.equal(needsApproval('s2', 'shell_exec', 'dangerous', { target: 'repo:/y' }), true);
  assert.equal(needsApproval('s2', 'mail_modify', 'sensitive', { bulk: 26 }), true);
  assert.equal(needsApproval('s2', 'mail_modify', 'sensitive', { bulk: 25 }), false);
  updateSettings({ permissions: { mode: 'ask' } });
  assert.equal(needsApproval('s2', 'fs_edit', 'sensitive', repo), true); // ask mode unchanged
});

test('profile merge dedupes and keeps sections', () => {
  const p = parseProfile('## Preferences\n- Short replies\n\n## People\n- Ana is my manager\n');
  assert.equal(mergeFacts(p, 'Preferences: short replies.\nWork: Uses the monarch-ai repo\nnoise\n- People: Bob is a teammate'), 2);
  assert.deepEqual(parseProfile(renderProfile(p)), { Preferences: ['Short replies'], People: ['Ana is my manager', 'Bob is a teammate'], Work: ['Uses the monarch-ai repo'], Personal: [] });
});
