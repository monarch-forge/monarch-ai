/** Self-evolution routes: extensions, skills, evolution (timeline/proposals/reflect/forge), tool catalog. */
import type { Hono } from 'hono';
import type { ToolCatalogEntry } from '@monarch/shared';
import { HttpError, isAlwaysLoaded, type ToolDef } from '../kernel.ts';
import { readJson } from '../services/http.ts';
import { assistantTools, codingTools } from '../tools/index.ts';
import { tools as system } from '../tools/system.ts';
import { tools as productivity } from '../tools/productivity.ts';
import { tools as web } from '../tools/web.ts';
import { tools as coding } from '../tools/coding.ts';
import { tools as mail } from '../tools/mail.ts';
import { tools as slack } from '../tools/slack.ts';
import { tools as memory } from '../tools/memory.ts';
import { tools as evolve } from '../tools/evolve.ts';
import {
  acceptProposal,
  deleteSkill,
  dismissProposal,
  evolutionStats,
  evolutionTimeline,
  extensionApiDocs,
  extensionDetail,
  extensionPanel,
  forge,
  getSkill,
  listExtensions,
  listProposals,
  listSkills,
  recordEvolution,
  reloadExtension,
  removeExtension,
  rollbackExtension,
  runReflection,
  saveExtension,
  setExtensionSecret,
  testExtensionTool,
  toggleExtension,
  writeSkill,
} from '../extensions/index.ts';

const MODULES: [string, ToolDef[]][] = [
  ['system', system],
  ['productivity', productivity],
  ['web', web],
  ['coding', coding],
  ['mail', mail],
  ['slack', slack],
  ['memory', memory],
  ['evolve', evolve],
];

function moduleOf(name: string): string | undefined {
  for (const [m, list] of MODULES) if (list?.some((t) => t.name === name)) return m;
  return undefined;
}

export function toolCatalog(): ToolCatalogEntry[] {
  const seen = new Set<string>();
  const out: ToolCatalogEntry[] = [];
  for (const t of [...assistantTools(), ...codingTools()]) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({
      name: t.name,
      description: t.description,
      risk: t.risk,
      source: t.extensionId ? 'extension' : 'core',
      ...(t.extensionId ? { extensionId: t.extensionId } : {}),
      loading: isAlwaysLoaded(t) ? 'always' : 'deferred',
      group: t.group ?? (t.extensionId ? `ext:${t.extensionId}` : moduleOf(t.name) ?? 'core'),
    });
  }
  return out;
}

export function register(app: Hono): void {
  /* extensions */
  app.get('/api/extensions', (c) => c.json(listExtensions()));
  app.get('/api/extensions/:id', (c) => c.json(extensionDetail(c.req.param('id'))));
  app.put('/api/extensions/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readJson<{ manifest?: unknown; source?: unknown; note?: string }>(c);
    const manifest = body.manifest && typeof body.manifest === 'object' ? { ...(body.manifest as object), id } : { id };
    const { detail } = await saveExtension({ manifest, source: body.source, note: body.note || 'Edited by user' }, { id, actor: 'user' });
    return c.json(detail);
  });
  app.post('/api/extensions/:id/toggle', async (c) => {
    const { enabled } = await readJson<{ enabled?: boolean }>(c);
    if (typeof enabled !== 'boolean') throw new HttpError(400, '"enabled" (boolean) is required');
    return c.json(await toggleExtension(c.req.param('id'), enabled, 'user'));
  });
  app.post('/api/extensions/:id/reload', async (c) => c.json(await reloadExtension(c.req.param('id'))));
  app.post('/api/extensions/:id/rollback', async (c) => {
    const { revision } = await readJson<{ revision?: number }>(c);
    return c.json(await rollbackExtension(c.req.param('id'), Number(revision), 'user'));
  });
  app.put('/api/extensions/:id/secrets', async (c) => {
    const { name, value } = await readJson<{ name?: string; value?: string }>(c);
    if (!name) throw new HttpError(400, '"name" is required');
    return c.json(await setExtensionSecret(c.req.param('id'), name, typeof value === 'string' ? value : ''));
  });
  app.delete('/api/extensions/:id', async (c) => {
    await removeExtension(c.req.param('id'), 'user');
    return c.json({ ok: true });
  });
  app.get('/api/extensions/:id/panels/:panelId', async (c) => c.json(await extensionPanel(c.req.param('id'), c.req.param('panelId'))));
  app.post('/api/extensions/:id/tools/:tool/test', async (c) => {
    const text = await c.req.text();
    let args: unknown = {};
    if (text.trim()) {
      try {
        const b = JSON.parse(text);
        args = b && typeof b === 'object' && 'args' in b ? b.args : {};
      } catch {
        throw new HttpError(400, 'invalid JSON body');
      }
    }
    return c.json(await testExtensionTool(c.req.param('id'), c.req.param('tool'), args ?? {}));
  });
  app.get('/api/extension-api', (c) => c.json({ markdown: extensionApiDocs() }));

  /* skills */
  app.get('/api/skills', (c) => c.json(listSkills()));
  app.get('/api/skills/:id', (c) => c.json(getSkill(c.req.param('id'))));
  app.put('/api/skills/:id', async (c) => {
    const body = await readJson<{ name?: string; description?: string; body?: string }>(c);
    const { skill, created } = writeSkill(c.req.param('id'), body, 'user');
    recordEvolution(created ? 'skill.created' : 'skill.updated', `${created ? 'Added' : 'Edited'} skill: ${skill.name}`, { actor: 'user', ref: skill.id });
    return c.json(skill);
  });
  app.delete('/api/skills/:id', (c) => {
    const s = deleteSkill(c.req.param('id'));
    recordEvolution('skill.removed', `Removed skill: ${s.name}`, { actor: 'user', ref: s.id });
    return c.json({ ok: true });
  });

  /* evolution */
  app.get('/api/evolution/stats', async (c) => c.json(await evolutionStats()));
  app.get('/api/evolution/timeline', (c) => c.json(evolutionTimeline(Number(c.req.query('limit')) || 100)));
  app.get('/api/evolution/proposals', (c) => c.json(listProposals()));
  app.post('/api/evolution/proposals/:id/accept', async (c) => c.json(await acceptProposal(c.req.param('id'))));
  app.post('/api/evolution/proposals/:id/dismiss', (c) => {
    dismissProposal(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/evolution/reflect', async (c) => c.json(await runReflection('manual')));
  app.post('/api/evolution/forge', async (c) => {
    const { text } = await readJson<{ text?: string }>(c);
    return c.json(await forge(text ?? ''));
  });

  /* tools */
  app.get('/api/tools/catalog', (c) => c.json(toolCatalog()));
}
