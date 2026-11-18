import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, Pairing, tokenMatches } from './remote-auth.ts';

test('token hash + verify', () => {
  const h = hashToken('secret-token');
  assert.equal(h.length, 64);
  assert.ok(tokenMatches('secret-token', h));
  assert.ok(!tokenMatches('secret-tokeN', h));
  assert.ok(!tokenMatches('secret-token', 'abcd'));
});

test('pairing code: one-time, expires after 5 min, rate-limited', () => {
  const p = new Pairing();
  const t0 = 1_000_000;
  const a = p.create(t0);
  assert.ok(p.redeem(a.code, t0 + 1000));
  assert.ok(!p.redeem(a.code, t0 + 2000), 'second use fails');

  const b = p.create(t0);
  assert.ok(!p.redeem(b.code, t0 + 5 * 60_000 + 1), 'expired');

  const q = new Pairing();
  const c = q.create(t0);
  for (let i = 0; i < 5; i++) assert.ok(!q.redeem('wrong', t0));
  assert.throws(() => q.redeem(c.code, t0), /Too many/);
  assert.ok(q.redeem(c.code, t0 + 61_000), 'limit window passes');
});
