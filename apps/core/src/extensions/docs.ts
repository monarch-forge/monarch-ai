/** Extension authoring reference — returned by extension_api_docs and GET /api/extension-api. Keep in sync with host.ts. */
import { readBuiltinSource } from './seeds.ts';
import { sandboxInfo } from './manager.ts';

const MINIMAL = `export default function activate(api) {
  const { z } = api;

  api.tool({
    name: 'word_count',                       // agent sees "<extension_id_snake>_word_count"
    description: 'Count words and characters in a text.',
    risk: 'safe',                             // 'safe' | 'sensitive' (default) | 'dangerous'
    input: z.object({
      text: z.string().describe('The text to analyse.'),
    }),
    run: async ({ text }, ctx) => {
      const words = text.trim().split(/\\s+/).filter(Boolean).length;
      return \`\${words} words, \${text.length} characters\`;   // string or JSON-able value
    },
  });
}`;

export function extensionApiDocs(): string {
  const sb = sandboxInfo();
  const example = readBuiltinSource('focus-timer');
  return `# Monarch extension API

An extension is a small ES module that adds **tools** (callable by the agent), **panels** (shown in the
Evolve page) and **jobs** (background work on an interval). Each extension runs in its **own sandboxed
Node ${process.versions.node.split('.')[0]} process**.

## Files
- \`extension.json\` — the manifest (written for you by extension_write):
  \`{ "id": "kebab-case", "name": "Human name", "version": "0.1.0", "description": "…", "permissions": [], "secrets": [] }\`
- \`index.mjs\` — ESM source. It MUST \`export default function activate(api) { … }\` (may be \`async\`).
  Only \`node:\` builtins can be imported (no npm packages; there is no node_modules). Everything else comes via \`api\`.

## Permissions (manifest.permissions)
| permission | grants |
|---|---|
| (none) | pure computation; read the extension's own dir; read/write \`api.dataDir\` |
| \`network\` | outbound HTTP with global \`fetch\` / \`api.fetch\` (and node:http/net)${sb.net ? '' : ' — NOTE: this Node version cannot enforce it, treat it as declarative'} |
| \`shell\` | spawn processes (node:child_process). Effectively unsandboxed — avoid unless essential |
| \`fs\` | read/write the user's home dir and tmp (beyond \`api.dataDir\`). High trust: that includes Monarch's own data dir — request only when essential |
| \`secrets\` | read user-provided secrets named in \`manifest.secrets\` via \`api.secrets.get(name)\` (implied by declaring secrets) |

Ask for the fewest permissions possible. Anything not granted fails with \`ERR_ACCESS_DENIED\`.
Sandbox: ${sb.flag ? `Node permission model (${sb.flag})` : 'process isolation only (permission model unavailable on this Node)'}; memory capped at 256 MB.

## The \`api\` object
- \`api.z\` — zod v4 (use it for every tool input).
- \`api.tool({ name, description, risk?, input?, run })\`
  - \`name\`: snake_case, unique in the extension. Exposed to the agent as \`<id with - → _>_<name>\` (e.g. \`hacker_news_top_stories\`).
  - \`description\`: one or two sentences — what it does and returns.
  - \`risk\`: \`'safe'\` (read-only), \`'sensitive'\` (default; changes local state / sends data), \`'dangerous'\` (destructive / irreversible). Non-safe tools may need user approval.
  - \`input\`: \`z.object({...})\` (or a plain shape \`{ q: z.string() }\`). Omit for no input. Validated before \`run\`; defaults applied. Use \`.describe()\` on fields.
  - \`run(input, ctx)\` → \`string\` (preferred) or JSON-able value. Throw an \`Error\` to fail with a message.
    \`ctx.signal\` (AbortSignal — pass it to fetch), \`ctx.progress(text)\` (live progress line).
  - Timeout: 60 s per call.
- \`api.panel({ id, title, render })\` — \`render()\` (may be async, 15 s timeout) returns
  \`{ title?, markdown?, stats?: [{ label, value, hint? }], items?: [{ title, sub?, href? }] }\` (href: https://… or #/route).
- \`api.job({ id, everyMinutes, run })\` — \`run()\` every N minutes (≥ 1) while the extension is enabled (5 min timeout). Errors are logged and shown on the job.
- \`api.store\` — persistent JSON key/value in the data dir: \`get(key, fallback?)\`, \`set(key, value)\`, \`delete(key)\`, \`all()\`. Synchronous.
- \`api.secrets.get(name)\` → \`Promise<string | undefined>\` — only names listed in \`manifest.secrets\`; the user enters values in Evolve. Never log them.
- \`api.notify(title, body)\` — desktop/UI notification (max 5 per minute).
- \`api.log.info|warn|error(...args)\` — extension log (also \`console.*\`), visible via extension_logs.
- \`api.fetch\` — same as global \`fetch\`; throws without the \`network\` permission.
- \`api.dataDir\` — absolute path of the private writable directory. \`api.manifest\` — the manifest.

Registrations normally happen inside \`activate\`; activation must finish within 10 s (don't await long work there).
Module-level state lives as long as the process; use \`api.store\` for anything that must survive restarts.
A crashing extension is restarted (3 quick retries) then marked \`error\`.

## Workflow for the agent
1. \`extension_api_docs\` (this) → design the smallest useful extension.
2. \`extension_write\` with \`{ id, name, description, permissions, source, note }\` — it validates and dry-activates the
   code in the sandbox and returns activation errors + registered tools. Fix and re-write until it activates.
3. \`extension_test\` each tool with realistic args; check \`extension_logs\` on failure.
4. Every write is a revision — \`extension_rollback\` restores an earlier one.

## Minimal example
\`\`\`js
${MINIMAL}
\`\`\`

${example ? `## Complete example — builtin \`focus-timer\` (tools + store + job + notify + panel)
\`\`\`js
${example.trim()}
\`\`\`` : ''}
`;
}
