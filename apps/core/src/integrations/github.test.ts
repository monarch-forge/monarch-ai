import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInbox } from './github.ts';

const node = (n: number, state?: string) => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  isDraft: n === 2,
  updatedAt: '2026-11-01T00:00:00Z',
  repository: { nameWithOwner: 'o/r' },
  author: { login: 'me' },
  commits: { nodes: state ? [{ commit: { statusCheckRollup: { state } } }] : [{ commit: { statusCheckRollup: null } }] },
});

test('parseInbox flattens buckets, dedupes by url, reads CI rollup', () => {
  const prs = parseInbox({ data: { review: { nodes: [node(1, 'FAILURE')] }, mine: { nodes: [node(2, 'SUCCESS'), node(1)] }, assigned: { nodes: [{}, node(3)] } } });
  assert.deepEqual(prs.map((p) => [p.number, p.reason, p.ci, p.draft]), [
    [1, 'review', 'FAILURE', false],
    [2, 'mine', 'SUCCESS', true],
    [3, 'assigned', null, false],
  ]);
  assert.deepEqual(parseInbox({ errors: [] }), []);
});
