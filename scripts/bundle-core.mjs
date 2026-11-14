#!/usr/bin/env node
/**
 * bundle-core.mjs — stage the Node core for the Tauri bundle.
 *
 *   1. builds the core (`npm run build --workspace @monarch/core` → apps/core/dist/core.mjs)
 *   2. copies apps/core/dist into src-tauri/resources/core/
 *   3. finds every bare import the bundle leaves external (static/dynamic import, require) and copies
 *      those packages + their dependency closure into src-tauri/resources/core/node_modules/
 *   4. verifies each external specifier resolves from the staged dir, then swaps it into place
 *
 * Tauri maps src-tauri/resources/core/ → <resource_dir>/core/ and the shell runs `node core/core.mjs`.
 *
 * Deliberately NOT bundled: the Claude Agent SDK platform packages
 * (@anthropic-ai/claude-agent-sdk-<os>-<arch>, ~200 MB+ native `claude` binary each). Monarch uses the
 * user's installed `claude` executable (settings.claudeSdk.executablePath / auto-detect) instead.
 *
 * Usage:  node scripts/bundle-core.mjs [--skip-build] [--keep-maps] [--include <pkg>]... [--exclude <pkg>]...
 *                                      [--dist <dir>] [--out <dir>]
 * Env:    MONARCH_BUNDLE_INCLUDE / MONARCH_BUNDLE_EXCLUDE  (comma-separated package names)
 *
 * Idempotent: everything is staged in a temp dir and swapped in only after verification succeeds.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = join(ROOT, 'apps/core');

/* ───────────── args ───────────── */

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const multi = (f) => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]] : []));
const opt = (f) => multi(f).at(-1);

/** --dist / --out exist mainly for testing the script against a scratch build */
const DIST = resolve(opt('--dist') ?? join(CORE_DIR, 'dist'));
const ENTRY = join(DIST, 'core.mjs');
const OUT = resolve(opt('--out') ?? join(ROOT, 'src-tauri/resources/core'));
const STAGE = `${OUT}.staging`;
const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const SKIP_BUILD = flag('--skip-build');
const KEEP_MAPS = flag('--keep-maps');
const INCLUDE = [...multi('--include'), ...csv(process.env.MONARCH_BUNDLE_INCLUDE)];
const EXCLUDE = new Set([...multi('--exclude'), ...csv(process.env.MONARCH_BUNDLE_EXCLUDE)]);
/** platform binaries of the Agent SDK: never bundled (see header) */
const EXCLUDE_RE = [/^@anthropic-ai\/claude-agent-sdk-/];

const log = (...a) => console.log('[bundle-core]', ...a);
function die(msg) {
  console.error(`\n[bundle-core] ERROR: ${msg}\n`);
  try {
    rmSync(STAGE, { recursive: true, force: true });
  } catch {}
  process.exit(1);
}

/* ───────────── 1. build ───────────── */

if (!SKIP_BUILD) {
  if (!existsSync(join(CORE_DIR, 'scripts/build.mjs'))) {
    die(
      'apps/core/scripts/build.mjs does not exist yet, so `npm run build --workspace @monarch/core` cannot produce ' +
        'apps/core/dist/core.mjs. Add the core build script (esbuild → dist/core.mjs, platform node, format esm), ' +
        'or pass --skip-build if dist/ is already built.',
    );
  }
  log('building core: npm run build --workspace @monarch/core');
  const r = spawnSync('npm', ['run', 'build', '--workspace', '@monarch/core'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.error) die(`could not run npm: ${r.error.message}`);
  if (r.status !== 0) die(`core build failed (exit ${r.status}).`);
}
if (!existsSync(ENTRY)) die(`expected ${relative(ROOT, ENTRY)} after the core build — not found.`);

/* ───────────── 2. stage dist ───────────── */

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const skipFile = (p) => {
  const b = basename(p);
  if (!KEEP_MAPS && b.endsWith('.map')) return true;
  return false;
};
cpSync(DIST, STAGE, { recursive: true, dereference: true, filter: (src) => !skipFile(src) });
log(`copied ${relative(ROOT, DIST)} → ${relative(ROOT, OUT)}`);

/* ───────────── 3. find externals ───────────── */

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const PKG_NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walkFiles(p, out);
    } else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

function pkgNameOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || /^[a-z]+:/i.test(spec)) return null;
  if (BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return PKG_NAME_RE.test(name) ? name : null;
}

const SPEC_RES = [
  /\bfrom\s*["']([^"'\n]+)["']/g, // import x from 'y' / export * from 'y'
  /\bimport\s*["']([^"'\n]+)["']/g, // import 'y'
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g, // import('y')
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g, // require('y')  (esbuild createRequire shim)
];

// esbuild metafile, if the core build writes one, is authoritative for externals.
// Without it, fall back to scanning the built files (can yield false positives from string literals).
const META = join(DIST, 'meta.json');
/** spec → files that reference it */
const externalSpecs = new Map();
if (!existsSync(META)) {
for (const f of walkFiles(STAGE)) {
  const src = readFileSync(f, 'utf8');
  for (const re of SPEC_RES) {
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (!pkgNameOf(spec)) continue;
      if (!externalSpecs.has(spec)) externalSpecs.set(spec, new Set());
      externalSpecs.get(spec).add(relative(STAGE, f));
    }
  }
}
}
if (existsSync(META)) {
  try {
    const meta = JSON.parse(readFileSync(META, 'utf8'));
    for (const out of Object.values(meta.outputs ?? {})) {
      for (const imp of out.imports ?? []) {
        if (imp.external && pkgNameOf(imp.path)) {
          if (!externalSpecs.has(imp.path)) externalSpecs.set(imp.path, new Set());
          externalSpecs.get(imp.path).add('meta.json');
        }
      }
    }
  } catch (e) {
    log(`warning: could not parse ${relative(ROOT, META)}: ${e.message}`);
  }
}
for (const name of INCLUDE) if (!externalSpecs.has(name)) externalSpecs.set(name, new Set(['--include']));

const isExcluded = (name) => EXCLUDE.has(name) || EXCLUDE_RE.some((re) => re.test(name));

/* ───────────── 4. copy dependency closure ───────────── */

function findPkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const cand = join(dir, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return realpathSync(cand);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const NM = join(STAGE, 'node_modules');
/** realpath(source pkg dir) → staged dir */
const placed = new Map();
/** staged top-level name → realpath it came from */
const topLevel = new Map();
const missing = [];
const skipped = new Set();
const copiedPkgs = [];

function copyFilter(src) {
  const rel = src.split(sep).join('/');
  // nested platform binaries / bins of excluded packages
  if (/\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(\/|$)/.test(rel)) return false;
  if (/\/node_modules\/\.bin(\/|$)/.test(rel)) return false;
  if (/\/node_modules\/\.cache(\/|$)/.test(rel)) return false;
  const b = basename(src);
  if (!KEEP_MAPS && b.endsWith('.map')) return false;
  if (/\.d\.[cm]?ts$/.test(b) || b.endsWith('.tsbuildinfo')) return false;
  return true;
}

/**
 * Place `name` (as resolved from `fromSrcDir`) so that it resolves from `fromStagedDir`.
 * Mirrors Node's lookup: first try hoisting to STAGE/node_modules; on a version clash nest it under the
 * requiring package's node_modules.
 */
function place(name, fromSrcDir, fromStagedDir, optional) {
  if (isExcluded(name)) {
    skipped.add(name);
    return;
  }
  const src = findPkgDir(name, fromSrcDir);
  if (!src) {
    if (!optional) missing.push(`${name} (needed from ${relative(ROOT, fromSrcDir) || '.'})`);
    return;
  }
  if (placed.has(src)) return;

  // already shipped inside the requiring package's own nested node_modules?
  if (fromStagedDir && src.startsWith(fromSrcDir + sep)) {
    placed.set(src, join(fromStagedDir, relative(fromSrcDir, src)));
    return follow(src, placed.get(src));
  }

  let dest;
  const clash = topLevel.get(name);
  if (!clash) {
    dest = join(NM, name);
    topLevel.set(name, src);
  } else if (clash === src) {
    return;
  } else {
    if (!fromStagedDir) die(`conflicting top-level versions of ${name}`);
    dest = join(fromStagedDir, 'node_modules', name);
    if (existsSync(dest)) return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true, filter: copyFilter });
  placed.set(src, dest);
  const pj = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  copiedPkgs.push({ name, version: pj.version, dest });
  follow(src, dest, pj);
}

function follow(srcDir, stagedDir, pj = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'))) {
  for (const d of Object.keys(pj.dependencies ?? {})) place(d, srcDir, stagedDir, false);
  for (const d of Object.keys(pj.optionalDependencies ?? {})) place(d, srcDir, stagedDir, true);
  for (const d of Object.keys(pj.peerDependencies ?? {})) place(d, srcDir, stagedDir, true); // peers: best effort; the resolve check below catches real gaps
}

const roots = [...new Set([...externalSpecs.keys()].map(pkgNameOf))].sort();
for (const name of roots) place(name, CORE_DIR, null, false);

/* ───────────── 5. write metadata + verify ───────────── */

writeFileSync(
  join(STAGE, 'package.json'),
  JSON.stringify({ name: 'monarch-core-bundle', private: true, type: 'module', main: 'core.mjs' }, null, 2) + '\n',
);

const resolvable = [...externalSpecs.keys()].filter((s) => !isExcluded(pkgNameOf(s)));
const checkFile = join(STAGE, '__resolve_check.mjs');
writeFileSync(
  checkFile,
  `const specs = ${JSON.stringify(resolvable)};\nconst bad = [];\n` +
    `for (const s of specs) { try { import.meta.resolve(s); } catch (e) { bad.push(s + ': ' + e.code); } }\n` +
    `if (bad.length) { console.error(bad.join('\\n')); process.exit(1); }\n`,
);
const check = spawnSync(process.execPath, [checkFile], { cwd: STAGE, encoding: 'utf8' });
rmSync(checkFile, { force: true });
const unresolved = check.status === 0 ? [] : (check.stderr || check.stdout || '').trim().split('\n').filter(Boolean);

function dirSize(p) {
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const q = join(p, e.name);
    n += e.isDirectory() ? dirSize(q) : statSync(q).size;
  }
  return n;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const manifest = {
  generatedAt: new Date().toISOString(),
  entry: 'core.mjs',
  externals: Object.fromEntries([...externalSpecs].map(([k, v]) => [k, [...v]])),
  packages: copiedPkgs.map((p) => ({ name: p.name, version: p.version, path: relative(STAGE, p.dest) })),
  skipped: [...skipped],
  missing,
  unresolved,
};
writeFileSync(join(STAGE, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (missing.length) log(`warning: ${missing.length} dependency(ies) not found in node_modules:\n  - ${missing.join('\n  - ')}`);
// Externals that don't resolve from the source tree either are optional (try/catch requires such as
// bufferutil, utf-8-validate, supports-color, macOS sensors) — warn instead of failing.
{
  const coreDir = join(ROOT, 'apps', 'core');
  const optional = unresolved.filter((u) => {
    const spec = u.split(':')[0].trim();
    try {
      createRequire(join(coreDir, 'package.json')).resolve(spec);
      return false;
    } catch {
      return true;
    }
  });
  if (optional.length) log(`note: optional imports not installed (fine): ${optional.map((u) => u.split(':')[0]).join(', ')}`);
  unresolved.splice(0, unresolved.length, ...unresolved.filter((u) => !optional.includes(u)));
}
if (unresolved.length) {
  die(
    `these imports do not resolve from the staged bundle (run \`npm install\`, or add them with --include):\n  - ${unresolved.join('\n  - ')}`,
  );
}

/* ───────────── 6. swap into place ───────────── */

rmSync(OUT, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
renameSync(STAGE, OUT);

const total = dirSize(OUT);
const sizes = existsSync(join(OUT, 'node_modules'))
  ? readdirSync(join(OUT, 'node_modules'))
      .flatMap((n) =>
        n.startsWith('@')
          ? readdirSync(join(OUT, 'node_modules', n)).map((m) => `${n}/${m}`)
          : [n],
      )
      .map((n) => [n, dirSize(join(OUT, 'node_modules', n))])
      .sort((a, b) => b[1] - a[1])
  : [];

log(`externals: ${roots.length ? roots.join(', ') : '(none — fully bundled)'}`);
if (skipped.size) log(`skipped (by design): ${[...skipped].join(', ')}`);
log(`node_modules: ${copiedPkgs.length} package(s)`);
for (const [n, s] of sizes.slice(0, 10)) log(`  ${mb(s).padStart(9)}  ${n}`);
log(`total ${mb(total)} → ${relative(ROOT, OUT)}`);
