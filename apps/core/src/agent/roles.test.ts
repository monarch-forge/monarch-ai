import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoleModel, roleDefault, roleOf } from './roles.ts';

const opus = { engine: 'claude-sdk' as const, model: 'opus' };
const gpt = { engine: 'pi' as const, model: 'openai/gpt-5' };

test('roleOf maps kind and parent kind to a role', () => {
  assert.equal(roleOf('chat'), 'chat');
  assert.equal(roleOf(undefined), 'chat');
  assert.equal(roleOf('coding'), 'workshop');
  assert.equal(roleOf('coding', 'chat'), 'chatSub');
  assert.equal(roleOf('coding', 'coding'), 'workshopSub');
});

test('explicit > role default > global ({})', () => {
  const s = { agent: { roleModels: { workshop: opus } } } as never;
  assert.deepEqual(resolveRoleModel(s, 'workshop', { model: 'haiku' }), { model: 'haiku' });
  assert.deepEqual(resolveRoleModel(s, 'workshop', { engine: 'pi' }), { engine: 'pi' });
  assert.deepEqual(resolveRoleModel(s, 'workshop', {}), opus);
  assert.deepEqual(resolveRoleModel(s, 'chat', {}), {});
});

test('chatSub falls back to legacy workerModel unless roleModels.chatSub is set (null = global)', () => {
  assert.deepEqual(roleDefault({ agent: { workerModel: gpt } } as never, 'chatSub'), gpt);
  assert.equal(roleDefault({ agent: { workerModel: gpt } } as never, 'workshopSub'), undefined);
  assert.deepEqual(roleDefault({ agent: { workerModel: gpt, roleModels: { chatSub: opus } } } as never, 'chatSub'), opus);
  assert.equal(roleDefault({ agent: { workerModel: gpt, roleModels: { chatSub: null } } } as never, 'chatSub'), undefined);
  assert.equal(roleDefault({} as never, 'chatSub'), undefined);
});
