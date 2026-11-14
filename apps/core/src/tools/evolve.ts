/**
 * Self-evolution tools (group 'evolve'): write/test/manage extensions, skills and proposals.
 * All deferred (found via tool search) except skill_read — the system prompt lists skills, so reading one must be cheap.
 */
import { z } from 'zod';
import { defineTool, recentActivity, type ToolContext, type ToolDef } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { getSession, listSessions } from '../agent/sessions.ts';
import {
  addProposal,
  deleteSkill,
  extensionApiDocs,
  extensionDetail,
  extensionLogs,
  listExtensions,
  listSkills,
  readSkill,
  recordEvolution,
  removeExtension,
  rollbackExtension,
  saveExtension,
  skillIdFrom,
  testExtensionTool,
  toggleExtension,
  writeSkill,
} from '../extensions/index.ts';

const PERMS = ['network', 'shell', 'fs', 'secrets'] as const;

function requireEvolution(): void {
  if (!getSettings().evolution?.enabled)
    throw new Error('Self-evolution is turned off (Settings → Evolution). Ask the user to enable it before changing extensions or skills.');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const sid = (ctx: ToolContext) => ctx.sessionId || undefined;

/* ─────────────── extensions ─────────────── */

const apiDocs = defineTool({
  name: 'extension_api_docs',
  description: 'Authoring reference for Monarch extensions (manifest, permissions, the full `api`, a complete example). Read before writing an extension.',
  risk: 'safe',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extension', 'plugin', 'api', 'docs', 'build tool', 'self-evolve', 'capability'],
  schema: z.object({}),
  summarize: () => 'Read extension API docs',
  run: () => extensionApiDocs(),
});

const extList = defineTool({
  name: 'extension_list',
  description: 'List installed extensions with status, permissions, tools, panels and jobs.',
  risk: 'safe',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extensions', 'plugins', 'installed', 'capabilities'],
  schema: z.object({}),
  summarize: () => 'List extensions',
  run: () => {
    const list = listExtensions();
    if (!list.length) return 'No extensions installed.';
    return list
      .map((e) =>
        [
          `● ${e.name} (${e.id}) v${e.version} r${e.revision} — ${e.status}${e.error ? ` (${clip(e.error.split('\n')[0], 120)})` : ''} · origin=${e.origin} · calls=${e.calls}`,
          `  ${e.description}`,
          `  permissions: ${e.permissions.join(', ') || 'none'}${e.secrets.length ? ` · secrets: ${e.secrets.map((s) => `${s.name}${s.set ? '✓' : '✗'}`).join(', ')}` : ''}`,
          e.tools.length ? `  tools: ${e.tools.map((t) => `${t.name} [${t.risk}]`).join(', ')}` : '  tools: none',
          e.panels.length ? `  panels: ${e.panels.map((p) => p.id).join(', ')}` : null,
          e.jobs.length ? `  jobs: ${e.jobs.map((j) => `${j.id} every ${j.everyMinutes}m${j.lastError ? ' (last run failed)' : ''}`).join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');
  },
});

const extRead = defineTool({
  name: 'extension_read',
  description: 'Read one extension: manifest, full index.mjs source, status, recent logs and revision history.',
  risk: 'safe',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extension', 'source', 'code', 'inspect'],
  schema: z.object({ id: z.string().describe('Extension id (kebab-case).') }),
  summarize: ({ id }) => `Read extension ${id}`,
  run: ({ id }) => {
    const d = extensionDetail(id, 30);
    return [
      `# ${d.name} (${d.id}) — ${d.status}${d.enabled ? '' : ' (disabled)'} · r${d.revision}`,
      d.error ? `Error:\n${d.error}` : null,
      `Manifest:\n${JSON.stringify(d.manifest, null, 2)}`,
      `Tools: ${d.tools.map((t) => t.name).join(', ') || 'none'}`,
      `Source (index.mjs):\n\`\`\`js\n${d.source}\n\`\`\``,
      `Recent logs:\n${d.logs.map((l) => `${l.ts} [${l.level}] ${l.text}`).join('\n') || '(none)'}`,
      `History: ${d.history.slice(0, 10).map((h) => `r${h.revision} ${h.actor}: ${h.note}`).join(' | ')}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  },
});

const extWrite = defineTool({
  name: 'extension_write',
  description:
    'Create or replace an extension (manifest + full index.mjs source). Saves a new revision, dry-activates it in the sandbox and returns activation errors, logs and registered tools — iterate until it activates. Read extension_api_docs first.',
  risk: 'dangerous',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extension', 'write', 'create', 'build', 'plugin', 'new tool', 'code', 'self-evolve'],
  schema: z.object({
    id: z.string().describe('kebab-case id, e.g. "github-issues". Same id = update.'),
    name: z.string().describe('Human name.'),
    description: z.string().describe('One sentence: what the extension does.'),
    version: z.string().optional().describe('semver, default "0.1.0".'),
    permissions: z.array(z.enum(PERMS)).default([]).describe('Fewest needed: network | shell | fs | secrets.'),
    secrets: z.array(z.string()).optional().describe('Names of secrets the user must provide (e.g. ["API_TOKEN"]).'),
    source: z.string().describe('Complete index.mjs: `export default function activate(api) { ... }`.'),
    note: z.string().describe('What changed and why (revision note).'),
  }),
  summarize: ({ id, permissions, note }) => `Write extension ${id} [${(permissions ?? []).join(', ') || 'no permissions'}] — ${clip(note ?? '', 80)}`,
  run: async ({ id, name, description, version, permissions, secrets, source, note }, ctx) => {
    requireEvolution();
    ctx.progress('saving + activating in sandbox…');
    const { detail, activation, created } = await saveExtension(
      { manifest: { id, name, description, version: version ?? '0.1.0', permissions, secrets }, source, note },
      { actor: 'agent', sessionId: sid(ctx) },
    );
    const lines = [
      `${created ? 'Created' : 'Updated'} ${detail.name} (${detail.id}) → r${detail.revision}.`,
      activation.ok
        ? `Activation OK${activation.probe ? ' (dry run — extension saved DISABLED, waiting for the user to enable it in Evolve)' : ' — extension is active'}.`
        : `Activation FAILED${activation.probe ? ' (dry run)' : ''}:\n${activation.error}`,
      `Tools: ${activation.tools.length ? activation.tools.map((t) => `${id.replace(/-/g, '_')}_${t}`).join(', ') : 'none'}`,
      activation.panels.length ? `Panels: ${activation.panels.join(', ')}` : null,
      activation.jobs.length ? `Jobs: ${activation.jobs.join(', ')}` : null,
      activation.logs.length ? `Log tail:\n${activation.logs.slice(-12).join('\n')}` : null,
      activation.ok && !activation.probe ? 'Next: test each tool with extension_test.' : activation.ok ? '' : 'Fix the error and call extension_write again.',
    ];
    return lines.filter(Boolean).join('\n');
  },
});

const extToggle = defineTool({
  name: 'extension_toggle',
  description: 'Enable or disable an extension (restarts its sandbox).',
  risk: 'sensitive',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extension', 'enable', 'disable', 'turn on', 'turn off'],
  schema: z.object({ id: z.string(), enabled: z.boolean() }),
  summarize: ({ id, enabled }) => `${enabled ? 'Enable' : 'Disable'} extension ${id}`,
  run: async ({ id, enabled }, ctx) => {
    requireEvolution();
    if (enabled && !getSettings().evolution.autoEnable)
      throw new Error('Auto-enable is off: the user reviews and enables extensions in Evolve (#/evolve). Ask them to enable it.');
    const s = await toggleExtension(id, enabled, 'agent', sid(ctx));
    return `${s.name} is now ${s.status}${s.error ? `: ${s.error}` : ''}.`;
  },
});

const extRemove = defineTool({
  name: 'extension_remove',
  description: 'Remove an extension (stops it, moves its folder to the trash, forgets its secrets).',
  risk: 'dangerous',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extension', 'delete', 'remove', 'uninstall'],
  schema: z.object({ id: z.string() }),
  summarize: ({ id }) => `Remove extension ${id}`,
  run: async ({ id }, ctx) => {
    requireEvolution();
    await removeExtension(id, 'agent', sid(ctx));
    return `Removed ${id}.`;
  },
});

const extRollback = defineTool({
  name: 'extension_rollback',
  description: 'Restore an earlier revision of an extension (saved as a new revision). See extension_read for history.',
  risk: 'sensitive',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extension', 'rollback', 'revert', 'undo', 'history', 'revision'],
  schema: z.object({ id: z.string(), revision: z.number().int().min(1) }),
  summarize: ({ id, revision }) => `Roll back ${id} to r${revision}`,
  run: async ({ id, revision }, ctx) => {
    requireEvolution();
    const d = await rollbackExtension(id, revision, 'agent', sid(ctx));
    return `${d.name} restored from r${revision} → now r${d.revision} (${d.status}${d.error ? `: ${d.error}` : ''}).`;
  },
});

const extLogs = defineTool({
  name: 'extension_logs',
  description: "An extension's recent log lines (api.log, console, crashes, failed calls).",
  risk: 'safe',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extension', 'logs', 'debug', 'errors'],
  schema: z.object({ id: z.string(), limit: z.number().int().min(1).max(200).default(50) }),
  summarize: ({ id }) => `Logs of ${id}`,
  run: ({ id, limit }) => {
    const logs = extensionLogs(id, limit);
    return logs.length ? logs.map((l) => `${l.ts} [${l.level}] ${l.text}`).join('\n') : 'No log lines.';
  },
});

const extTest = defineTool({
  name: 'extension_test',
  description: 'Call one tool of an extension with arguments and return its output or error (for testing after extension_write).',
  risk: 'sensitive',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['extension', 'test', 'try', 'run tool', 'verify'],
  schema: z.object({
    id: z.string().describe('Extension id.'),
    tool: z.string().describe('Tool name (local "top_stories" or full "hacker_news_top_stories").'),
    args: z.record(z.string(), z.any()).default({}).describe('Tool input object.'),
  }),
  summarize: ({ id, tool, args }) => `Test ${id}.${tool} ${clip(JSON.stringify(args ?? {}), 80)}`,
  run: async ({ id, tool, args }) => {
    const r = await testExtensionTool(id, tool, args);
    return `${r.ok ? 'OK' : 'FAILED'} in ${r.durationMs}ms\n${r.output}`;
  },
});

/* ─────────────── skills ─────────────── */

const skillList = defineTool({
  name: 'skill_list',
  description: 'List learned skills (reusable procedures) with descriptions and use counts.',
  risk: 'safe',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['skills', 'procedures', 'playbooks', 'how-to'],
  schema: z.object({}),
  summarize: () => 'List skills',
  run: () => {
    const list = listSkills();
    return list.length ? list.map((s) => `- ${s.name} (${s.id}) — ${s.description} [${s.origin}, used ${s.uses}×]`).join('\n') : 'No skills yet.';
  },
});

const skillRead = defineTool({
  name: 'skill_read',
  description: 'Read a skill (a learned step-by-step procedure) by id before doing the task it describes.',
  risk: 'safe',
  tag: 'EVO',
  group: 'evolve',
  loading: 'always',
  keywords: ['skill', 'procedure', 'playbook', 'how to'],
  schema: z.object({ id: z.string().describe('Skill id, e.g. "weekly-review".') }),
  summarize: ({ id }) => `Read skill ${id}`,
  run: ({ id }) => {
    const s = readSkill(id);
    return `# ${s.name}\n${s.description}\n\n${s.body}`;
  },
});

const skillWrite = defineTool({
  name: 'skill_write',
  description:
    'Create or update a skill: a concise markdown procedure naming the exact tools to use. The description must say WHEN to use it (it is listed in your prompt).',
  risk: 'sensitive',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['skill', 'write', 'learn', 'remember procedure', 'playbook'],
  schema: z.object({
    id: z.string().optional().describe('kebab-case id (default: derived from name). Same id = update.'),
    name: z.string(),
    description: z.string().describe('One line: what + when to use.'),
    body: z.string().describe('Markdown procedure.'),
  }),
  summarize: ({ id, name }) => `Write skill ${id ?? skillIdFrom(name)}`,
  run: ({ id, name, description, body }, ctx) => {
    requireEvolution();
    const { skill, created } = writeSkill(id ?? skillIdFrom(name), { name, description, body }, 'agent');
    recordEvolution(created ? 'skill.created' : 'skill.updated', `${created ? 'Learned' : 'Updated'} skill: ${skill.name}`, {
      detail: skill.description,
      actor: 'agent',
      sessionId: sid(ctx),
      ref: skill.id,
    });
    return `${created ? 'Saved new' : 'Updated'} skill "${skill.name}" (${skill.id}).`;
  },
});

const skillDelete = defineTool({
  name: 'skill_delete',
  description: 'Delete a skill.',
  risk: 'sensitive',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['skill', 'delete', 'forget'],
  schema: z.object({ id: z.string() }),
  summarize: ({ id }) => `Delete skill ${id}`,
  run: ({ id }, ctx) => {
    requireEvolution();
    const s = deleteSkill(id);
    recordEvolution('skill.removed', `Removed skill: ${s.name}`, { actor: 'agent', sessionId: sid(ctx), ref: s.id });
    return `Deleted skill ${s.id}.`;
  },
});

/* ─────────────── proposals / introspection ─────────────── */

const propose = defineTool({
  name: 'evolution_propose',
  description:
    'Propose a self-improvement for the user to review in Evolve (they can accept → a build session implements it). Use for new extensions or skills you think would help.',
  risk: 'safe',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['propose', 'suggest', 'improvement', 'idea', 'self-evolve', 'reflection'],
  schema: z.object({
    title: z.string().describe('Short imperative title, e.g. "Track package deliveries".'),
    rationale: z.string().describe('The friction/opportunity observed (cite evidence).'),
    plan: z.string().describe('What to build — precise enough for another agent to implement.'),
    kind: z.enum(['extension', 'skill']),
  }),
  summarize: ({ title, kind }) => `Propose ${kind}: ${title}`,
  run: ({ title, rationale, plan, kind }, ctx) => {
    const p = addProposal({ title: title.slice(0, 120), rationale, plan, kind, sessionId: sid(ctx) }, 'agent');
    return `Proposal saved (${p.id}). The user can review it in Evolve.`;
  },
});

const activityRecent = defineTool({
  name: 'activity_recent',
  description: "Recent Monarch activity log plus recent failed/denied tool calls across sessions (for self-reflection and debugging).",
  risk: 'safe',
  tag: 'EVO',
  group: 'evolve',
  loading: 'deferred',
  keywords: ['activity', 'log', 'history', 'errors', 'failed tools', 'reflection'],
  schema: z.object({
    limit: z.number().int().min(1).max(300).default(80).describe('Activity entries to return.'),
    days: z.number().int().min(1).max(30).default(7).describe('Look-back window for failed tool calls.'),
  }),
  summarize: () => 'Read recent activity',
  run: ({ limit, days }) => {
    const acts = recentActivity(limit)
      .map((a) => `${a.ts} ${a.tag} ${a.level !== 'info' ? `[${a.level}] ` : ''}${a.text}`)
      .join('\n');
    const since = Date.now() - days * 86400e3;
    const failures: string[] = [];
    const sessions = listSessions()
      .filter((s) => Date.parse(s.updatedAt) >= since)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 40);
    for (const s of sessions) {
      const rec = getSession(s.id);
      for (const it of rec?.items ?? []) {
        if (it.kind !== 'tool' || (it.status !== 'error' && it.status !== 'denied') || Date.parse(it.ts) < since) continue;
        failures.push(`${it.ts} [${it.status}] ${it.name} in "${clip(s.title, 40)}": ${clip((it.output ?? '').replace(/\s+/g, ' '), 200)}`);
        if (failures.length >= 60) break;
      }
      if (failures.length >= 60) break;
    }
    return `## Activity (latest ${limit})\n${acts || '(empty)'}\n\n## Failed / denied tool calls (last ${days}d)\n${failures.join('\n') || '(none)'}`;
  },
});

export const tools: ToolDef[] = [
  apiDocs,
  extList,
  extRead,
  extWrite,
  extToggle,
  extRemove,
  extRollback,
  extLogs,
  extTest,
  skillList,
  skillRead,
  skillWrite,
  skillDelete,
  propose,
  activityRecent,
] as ToolDef[];
