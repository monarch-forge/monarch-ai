/**
 * Builtin examples, seeded once on first run (marker in extensions-state.json / evolution.json — removing
 * a builtin never brings it back). Sources live as real files:
 *   dev:    src/extensions/builtin/<id>/{extension.json,index.mjs}, builtin/skills/<id>.md
 *   bundle: dist/builtin-extensions/…  (copied by scripts/build.mjs)
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activity, paths } from '../kernel.ts';
import { exists, normalizeManifest, stateStore, validateSource, writeRevision } from './store.ts';
import { evoStore } from './timeline.ts';

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

export function seedBuiltins(): void {
  const dir = builtinDir();
  if (!dir) {
    console.warn('[ext] builtin examples not found — skipping seed');
    return;
  }
  const st = stateStore.get();
  if (!st.seeded) {
    const seeded: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'skills') continue;
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
    st.seeded = true;
    stateStore.save();
    if (seeded.length) activity('EVO', `Installed example extensions: ${seeded.join(', ')}`);
  }
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
