// Bundle the core into a single ESM file: apps/core/dist/core.mjs  (run: npm run build --workspace @monarch/core)
// Everything is inlined except packages that spawn binaries / load files relative to their own package dir;
// those stay as runtime node_modules deps (resolved from apps/core or the repo root node_modules).
import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist', 'core.mjs');

const external = [
  // spawns the bundled `claude` CLI binary resolved relative to its own package
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-agent-sdk/*',
  ...(process.env.MONARCH_BUNDLE_EXTERNAL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(join(root, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
  external,
  // CJS deps bundled into ESM still call require()/__dirname — provide them.
  banner: {
    js: [
      "import { createRequire as __monarchCreateRequire } from 'node:module';",
      "import { fileURLToPath as __monarchFileURLToPath } from 'node:url';",
      "import { dirname as __monarchDirname } from 'node:path';",
      'const require = __monarchCreateRequire(import.meta.url);',
      'const __filename = __monarchFileURLToPath(import.meta.url);',
      'const __dirname = __monarchDirname(__filename);',
    ].join('\n'),
  },
});

// Extension host: a second, fully self-contained entry (zod inlined, no externals). The core spawns it as
// `node --permission … dist/extension-host.mjs` — the sandboxed child may only read this one file.
const hostOutfile = join(root, 'dist', 'extension-host.mjs');
const hostResult = await build({
  entryPoints: [join(root, 'src', 'extensions', 'host.ts')],
  outfile: hostOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
});

// builtin example extensions + skills, seeded on first run (read at runtime from dist/builtin-extensions)
cpSync(join(root, 'src', 'extensions', 'builtin'), join(root, 'dist', 'builtin-extensions'), { recursive: true });

// one metafile covering both outputs (scripts/bundle-core.mjs reads outputs[*].imports for externals)
const meta = {
  inputs: { ...result.metafile.inputs, ...hostResult.metafile.inputs },
  outputs: { ...result.metafile.outputs, ...hostResult.metafile.outputs },
};
writeFileSync(join(dirname(outfile), 'meta.json'), JSON.stringify(meta));
const kb = (statSync(outfile).size / 1024).toFixed(0);
const hostKb = (statSync(hostOutfile).size / 1024).toFixed(0);
console.log(`[build] ${outfile} (${kb} KB) + extension-host.mjs (${hostKb} KB), externals: ${external.join(', ')}`);
if (process.argv.includes('--analyze')) {
  const { analyzeMetafile } = await import('esbuild');
  console.log(await analyzeMetafile(meta, { verbose: false }));
}
