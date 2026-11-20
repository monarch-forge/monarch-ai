import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// kernel creates its data dirs on import: point it at a throwaway home first
process.env.MONARCH_HOME = mkdtempSync(join(tmpdir(), 'monarch-repomap-'));
const { extractSymbols, mapSlice, rankFiles, searchMap, estTokens, getRepoMap } = await import('./repomap.ts');

test('extracts TS/TSX symbols', () => {
  const src = [
    'import x from "y";',
    'export function getRepoProfile(p: string) {}',
    'export const MAX = 3;',
    'export interface RepoMap {}',
    'export type Sym = [string, number];',
    'export default class Kernel {}',
    'const Panel = (props) => <div />;',
    'function helper() {}',
    '  export const nested = 1;',
  ].join('\n');
  assert.deepEqual(extractSymbols('a.tsx', src), [
    ['getRepoProfile', 2],
    ['MAX', 3],
    ['RepoMap', 4],
    ['Sym', 5],
    ['Kernel', 6],
    ['Panel', 7],
    ['helper', 8],
  ]);
});

test('extracts Python top-level defs/classes only', () => {
  const src = 'import os\n\nclass Store:\n    def get(self):\n        pass\n\nasync def main():\n    pass\ndef _priv(): pass\n';
  assert.deepEqual(extractSymbols('x.py', src), [
    ['Store', 3],
    ['main', 7],
    ['_priv', 9],
  ]);
});

test('extracts Go funcs, methods and types', () => {
  const src = 'package x\n\ntype Server struct {}\n\nfunc (s *Server) Start() error {\n}\n\nfunc New() *Server {}\n';
  assert.deepEqual(extractSymbols('s.go', src), [
    ['Server', 3],
    ['Start', 5],
    ['New', 8],
  ]);
});

test('unknown languages get no symbols', () => {
  assert.deepEqual(extractSymbols('README.md', '# export function x'), []);
});

const map = {
  recent: ['apps/ui/src/app.tsx'],
  files: [
    { p: 'apps/core/src/services/projects.ts', sha: '1', s: [['getRepoProfile', 286], ['workerContext', 402]] as [string, number][] },
    { p: 'apps/core/src/agent/orchestrator.ts', sha: '2', s: [['runCheck', 511], ['startTurn', 300]] as [string, number][] },
    { p: 'apps/ui/src/app.tsx', sha: '3', s: [['App', 10]] as [string, number][] },
    { p: 'apps/core/src/index.ts', sha: '4', s: [] },
    ...Array.from({ length: 300 }, (_, i) => ({ p: `src/gen/module${i}/very/long/path/name/file${i}.ts`, sha: `x${i}`, s: [['someSymbolName', 1], ['anotherSymbol', 2]] as [string, number][] })),
  ],
};

test('ranking puts symbol and path matches first', () => {
  const r = rankFiles(map, 'fix the check loop in runCheck');
  assert.equal(r[0].f.p, 'apps/core/src/agent/orchestrator.ts');
  assert.deepEqual(r[0].hits[0], ['runCheck', 511]);
  const r2 = rankFiles(map, 'repo profile for projects');
  assert.equal(r2[0].f.p, 'apps/core/src/services/projects.ts');
});

test('generic slice (no task) falls back to recent + entry points', () => {
  const s = mapSlice(map, '');
  const first = s.split('\n').slice(0, 2);
  assert.ok(first.includes('apps/ui/src/app.tsx: App'), s);
  assert.ok(first.includes('apps/core/src/index.ts'), s);
});

test('slice stays within the token budget', () => {
  const s = mapSlice(map, 'some symbol name module', 600);
  assert.ok(estTokens(s) <= 600, `${estTokens(s)} tokens`);
  assert.ok(s.split('\n').length > 5);
  assert.ok(estTokens(mapSlice(map, 'some symbol', 50)) <= 50);
});

test('searchMap reports exact definitions with line numbers', () => {
  const out = searchMap({ ...map, repo: '/r', head: 'h', builtAt: '' }, { query: 'workerContext' });
  assert.match(out, /^Defined at: apps\/core\/src\/services\/projects\.ts:402 workerContext/);
  assert.match(searchMap({ ...map, repo: '/r', head: 'h', builtAt: '' }, { path: 'apps/ui' }), /apps\/ui\/src\/app\.tsx — App:10/);
});

test('builds a map of this repo', async () => {
  const t = Date.now();
  const m = await getRepoMap(resolve(import.meta.dirname, '../../../..'));
  assert.ok(m && m.files.some((f) => f.p === 'apps/core/src/services/projects.ts' && f.s.some((s) => s[0] === 'getRepoProfile')));
  assert.ok(!m!.files.some((f) => /package-lock\.json$|node_modules\//.test(f.p)));
  console.log(`repomap: ${m!.files.length} files, ${m!.files.reduce((n, f) => n + f.s.length, 0)} symbols, ${Date.now() - t}ms`);
});
