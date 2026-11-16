/**
 * Builtin examples, each seeded once per install (seededIds in extensions-state.json, skillsSeeded in
 * evolution.json — removing a builtin never brings it back). Sources live as real files:
 *   dev:    src/extensions/builtin/<id>/{extension.json,index.mjs}, builtin/skills/<id>.md
 *   bundle: dist/builtin-extensions/…  (copied by scripts/build.mjs)
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activity, paths } from '../kernel.ts';
import {
  exists,
  getState,
  normalizeManifest,
  readManifest,
  readSource,
  removeFromDisk,
  stateStore,
  validateSource,
  writeRevision,
} from './store.ts';
import { evoStore, record } from './timeline.ts';

export function builtinDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, 'builtin-extensions'), join(here, 'builtin')]) if (existsSync(d)) return d;
  return null;
}

export function readBuiltinSource(id: string): string | null {
  const dir = builtinDir();
  if (!dir) return null;
  try {
    return readFileSync(join(dir, id, 'index.mjs'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Example extensions shipped up to v0.8.0 and since retired. Their exact shipped index.mjs hashes let us tell
 * an untouched seed (safe to remove) from one the user or agent has edited (kept).
 */
const RETIRED_EXAMPLES: Record<string, string> = {
  'hacker-news': '864bde12dec723ba40172fae02d2660274d0a94ce24c47fa8f5872673efbbf04',
  'unit-convert': 'f30c4f5ebff04a3867c0651a461f8284a883c62224d7cfedfbfafada85cac740',
  'focus-timer': '19a5e5126c4d7d6d52d340158b097805d4a7eec0276862bb8c9c06372483c41d',
};

/** one-time: move unmodified retired examples to .trash (same as a normal remove); keep edited ones */
function retireOldExamples(): void {
  const st = stateStore.get();
  if (st.retiredExamples) return;
  for (const [id, hash] of Object.entries(RETIRED_EXAMPLES)) {
    if (!exists(id)) continue;
    const s = getState(id);
    if (s?.origin !== 'builtin') continue; // user/agent-created extension that happens to share the id
    const pristine = s.revision === 1 && createHash('sha256').update(readSource(id)).digest('hex') === hash;
    if (!pristine) {
      console.log(`[ext] keeping modified example extension "${id}" (revision ${s.revision})`);
      continue;
    }
    try {
      const name = readManifest(id).name;
      removeFromDisk(id);
      record('extension.removed', `Removed old example extension ${name}`, {
        detail: 'Unmodified builtin example retired in favour of Follow-ups; recoverable from extensions/.trash.',
        ref: id,
      });
    } catch (err) {
      console.error(`[ext] retiring ${id} failed:`, err);
    }
  }
  st.retiredExamples = true;
  stateStore.save();
}

export function seedBuiltins(): void {
  const dir = builtinDir();
  if (!dir) {
    console.warn('[ext] builtin examples not found — skipping seed');
    return;
  }
  retireOldExamples();
  const st = stateStore.get();
  // Each builtin is offered exactly once per install: removing it never brings it back, and a builtin
  // shipped in a later version is added to existing installs once (never overwriting a same-id extension).
  const offered = new Set(st.seededIds ?? []);
  const seeded: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'skills' || offered.has(e.name)) continue;
    offered.add(e.name);
    try {
      const manifest = normalizeManifest(JSON.parse(readFileSync(join(dir, e.name, 'extension.json'), 'utf8')), e.name);
      if (exists(manifest.id)) continue;
      const source = validateSource(readFileSync(join(dir, e.name, 'index.mjs'), 'utf8'));
      writeRevision(manifest, source, { actor: 'system', note: 'Builtin example', origin: 'builtin' });
      seeded.push(manifest.name);
    } catch (err) {
      console.error(`[ext] seeding ${e.name} failed:`, err);
    }
  }
  if (!st.seeded || offered.size !== (st.seededIds?.length ?? 0)) {
    st.seeded = true;
    st.seededIds = [...offered].sort();
    stateStore.save();
  }
  if (seeded.length) activity('EVO', `Installed example extensions: ${seeded.join(', ')}`);
  const evo = evoStore.get();
  if (!evo.skillsSeeded) {
    const sdir = join(dir, 'skills');
    if (existsSync(sdir)) {
      for (const f of readdirSync(sdir)) {
        if (!f.endsWith('.md') || existsSync(join(paths.skills, f))) continue;
        try {
          copyFileSync(join(sdir, f), join(paths.skills, f));
        } catch (err) {
          console.error(`[ext] seeding skill ${f} failed:`, err);
        }
      }
    }
    evo.skillsSeeded = true;
    evoStore.save();
  }
}
