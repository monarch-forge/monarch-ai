#!/usr/bin/env node
/**
 * Monarch's version lives in ONE place: the root package.json "version".
 * This script copies it everywhere else that needs a literal version.
 *
 *   npm run set-version 0.4.1          set the version and sync every file
 *   npm run set-version patch|minor|major
 *   npm run set-version                re-sync from package.json (after editing it by hand)
 *   npm run set-version -- --check     exit 1 if any file is out of sync (used by CI)
 *   npm run set-version 0.4.1 -- --tag also commit "Release v0.4.1" and create tag v0.4.1 (not pushed)
 *
 * Synced: workspace package.json files, package-lock.json (Monarch's own entries only),
 * src-tauri/Cargo.toml + Cargo.lock (the monarch_ai package only), packaging/arch/PKGBUILD,
 * README.md download names. src-tauri/tauri.conf.json reads ../package.json directly.
 * Every edit is targeted at Monarch's own fields: dependency versions are never touched.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (f) => join(root, f);
const args = process.argv.slice(2);
const check = args.includes('--check');
const tag = args.includes('--tag');
const want = args.find((a) => !a.startsWith('--'));

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const WORKSPACES = ['apps/core/package.json', 'apps/ui/package.json', 'packages/shared/package.json'];
const LOCK_KEYS = ['', 'apps/core', 'apps/ui', 'packages/shared'];

const rootPkg = JSON.parse(readFileSync(p('package.json'), 'utf8'));
const current = rootPkg.version;

function next(v, kind) {
  const [maj, min, pat] = v.split('-')[0].split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

let version = current;
if (want) {
  version = ['patch', 'minor', 'major'].includes(want) ? next(current, want) : want.replace(/^v/, '');
  if (!SEMVER.test(version)) {
    console.error(`Not a version: ${want} (expected e.g. 0.4.1, patch, minor or major)`);
    process.exit(2);
  }
}

/** [file, transform(text) → text]; transforms must only touch Monarch's own version fields */
// replace only the top-level "version" value, keeping the file's own formatting
const jsonVersion = (text) => {
  if (JSON.parse(text).version === version) return text;
  return text.replace(/^(\s{2}"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
};
const edits = [
  ['package.json', jsonVersion],
  ...WORKSPACES.map((f) => [f, jsonVersion]),
  [
    'package-lock.json',
    (text) => {
      const j = JSON.parse(text);
      j.version = version;
      for (const k of LOCK_KEYS) if (j.packages?.[k]) j.packages[k].version = version;
      return JSON.stringify(j, null, 2) + '\n';
    },
  ],
  // [package] version only (first `version =` line, before any [dependencies] table)
  ['src-tauri/Cargo.toml', (t) => t.replace(/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${version}"`)],
  ['src-tauri/Cargo.lock', (t) => t.replace(/(name = "monarch_ai"\nversion = )"[^"]*"/, `$1"${version}"`)],
  ['packaging/arch/PKGBUILD', (t) => t.replace(/^pkgver=.*$/m, `pkgver=${version}`).replace(/^pkgrel=.*$/m, 'pkgrel=1')],
  [
    'README.md',
    (t) =>
      t
        .replace(/releases\/download\/v\d+\.\d+\.\d+\//g, `releases/download/v${version}/`)
        .replace(/monarch-ai-bin-\d+\.\d+\.\d+-1-/g, `monarch-ai-bin-${version}-1-`)
        .replace(/Monarch([_-])\d+\.\d+\.\d+(?=[_-])/g, `Monarch$1${version}`),
  ],
];

const stale = [];
for (const [file, fn] of edits) {
  let before;
  try {
    before = readFileSync(p(file), 'utf8');
  } catch {
    continue; // optional file
  }
  const after = fn(before);
  if (after === before) continue;
  stale.push(file);
  if (!check) writeFileSync(p(file), after);
}

// tauri.conf.json must point at package.json (no literal version to keep in sync)
const tauriConf = JSON.parse(readFileSync(p('src-tauri/tauri.conf.json'), 'utf8'));
if (tauriConf.version !== '../package.json') {
  stale.push('src-tauri/tauri.conf.json');
  if (!check) {
    const t = readFileSync(p('src-tauri/tauri.conf.json'), 'utf8');
    writeFileSync(p('src-tauri/tauri.conf.json'), t.replace(/("version"\s*:\s*)"[^"]*"/, '$1"../package.json"'));
  }
}

if (check) {
  if (stale.length) {
    console.error(`Version ${version} is not synced in: ${stale.join(', ')}\nRun: npm run set-version`);
    process.exit(1);
  }
  console.log(`version ${version}: all files in sync`);
  process.exit(0);
}

console.log(version === current ? `version ${version}` : `version ${current} → ${version}`);
console.log(stale.length ? `updated: ${stale.join(', ')}` : 'everything already in sync');

if (tag) {
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'inherit' });
  const files = ['package.json', ...WORKSPACES, 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'packaging/arch/PKGBUILD', 'README.md'];
  git('add', ...files);
  git('commit', '-m', `Release v${version}`);
  git('tag', `v${version}`);
  console.log(`\ncommitted and tagged v${version}. Publish with:\n  git push origin HEAD v${version}`);
} else if (version !== current) {
  console.log(`\nnext: commit, then  git tag v${version} && git push origin HEAD v${version}`);
}
