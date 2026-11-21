import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStat, procList } from './procs.ts';

test('parseStat reads name, cpu ticks and rss, even with ") " in the name', () => {
  const s = parseStat('1234 (Web Content) (x)) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 5000 123456789 2048 18446744073709551615');
  assert.deepEqual(s, { name: 'Web Content) (x)', ticks: 300, rssPages: 2048 });
  assert.equal(parseStat('garbage'), null);
});

test('procList lists this process from /proc', { skip: process.platform !== 'linux' }, async () => {
  const list = await procList(200, 'mem');
  const me = list.find((p) => p.pid === process.pid);
  assert.ok(me, 'own pid present');
  assert.ok(me.memBytes > 0);
  assert.ok(me.cpu >= 0);
});
