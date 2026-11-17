import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closestBlock } from './coding.ts';

const file = 'import x\n\nfunction add(a, b) {\n    return a + b;\n}\n\nexport default add;\n';

test('closestBlock points at the block the model meant, despite whitespace drift', () => {
  const hint = closestBlock(file, 'function add(a, b) {\n  return a + b;\n}');
  assert.match(hint, /3\| function add\(a, b\) \{/);
  assert.match(hint, /4\|     return a \+ b;/);
});

test('closestBlock says so when nothing is similar', () => {
  assert.match(closestBlock(file, 'zzz qqq'), /No similar lines/);
});
