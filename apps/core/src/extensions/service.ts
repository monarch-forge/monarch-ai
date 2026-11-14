/** High-level extension operations shared by REST routes and the evolve tools. */
import type { ExtensionDetail, ExtensionManifest, ExtensionRevision, ExtensionSummary } from '@monarch/shared';
import { activity, changed, HttpError, notify, secrets } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import {
  callTool,
  getExtensionSecret,
  probeExtension,
  renderPanel,
  resetCrashes,
  runtimeOf,
  startExtension,
  statusOf,
  stopAll,
  stopExtension,
} from './manager.ts';
import {
  discoverIds,
  ensureState,
  exists,
  getLogs,
  getState,
  ID_RE,
  listHistory,
  normalizeManifest,
  patchState,
  readManifest,
  readRevision,
  readSource,
  removeFromDisk,
  stateStore,
  validateSource,
  writeRevision,
} from './store.ts';
import { record } from './timeline.ts';
import { fullToolName } from './tooldefs.ts';
import { seedBuiltins } from './seeds.ts';

type Actor = ExtensionRevision['actor'];

function checkId(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, `invalid extension id "${id}"`);
  if (!exists(id)) throw new HttpError(404, `extension "${id}" not found`);
  return id;
}

/* ─────────────── views ─────────────── */

export function extensionSummary(id: string): ExtensionSummary {
  checkId(id);
  const manifest = readManifest(id);
  const st = getState(id) ?? ensureState(id, 'user');
  const rt = runtimeOf(id);
  const registry = (rt?.status === 'active' ? rt.registry : null) ?? st.registry ?? { tools: [], panels: [], jobs: [] };
  const { status, error } = st.enabled ? statusOf(id) : { status: 'disabled' as const, error: undefined };
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    origin: st.origin,
    enabled: st.enabled,
    status,
    ...(error ? { error } : {}),
    permissions: manifest.permissions ?? [],
    tools: registry.tools.map((t) => ({ name: fullToolName(id, t.name), description: t.description, risk: t.risk })),
    panels: registry.panels,
    jobs: registry.jobs.map((j) => ({ ...j, ...(st.jobs[j.id] ?? {}) })),
    secrets: (manifest.secrets ?? []).map((name) => ({ name, set: !!getExtensionSecret(id, name) })),
    revision: st.revision,
    createdAt: st.createdAt,
    updatedAt: st.updatedAt,
    calls: st.calls ?? 0,
  };
}

export function listExtensions(): ExtensionSummary[] {
  return discoverIds().flatMap((id) => {
    try {
      return [extensionSummary(id)];
    } catch (e) {
      console.error(`[ext] summary of ${id} failed:`, e);
      return [];
    }
  });
}

export function extensionDetail(id: string, logLimit = 200): ExtensionDetail {
  const s = extensionSummary(id);
  return { ...s, manifest: readManifest(id), source: readSource(id), logs: getLogs(id, logLimit), history: listHistory(id) };
}

export function extensionLogs(id: string, limit = 50) {
  checkId(id);
  return getLogs(id, limit);
}

/* ─────────────── writes ─────────────── */

export interface ActivationReport {
  ok: boolean;
  status: ExtensionSummary['status'];
  error?: string;
  tools: string[];
  panels: string[];
  jobs: string[];
  logs: string[];
  /** dry activation in a throwaway sandbox (extension saved disabled) */
  probe: boolean;
}

export async function saveExtension(
  input: { manifest: unknown; source: unknown; note?: string },
  opts: { id?: string; actor: Actor; sessionId?: string },
): Promise<{ detail: ExtensionDetail; activation: ActivationReport; created: boolean }> {
  const manifest: ExtensionManifest = normalizeManifest(input.manifest, opts.id);
  const source = validateSource(input.source);
  const id = manifest.id;
  const created = !exists(id);
  const prev = getState(id);
  const origin = prev?.origin ?? (opts.actor === 'agent' ? 'agent' : 'user');
  const note = (input.note ?? '').trim() || (created ? 'Created' : 'Updated');
  const st = writeRevision(manifest, source, { actor: opts.actor, note, origin });

  const evo = getSettings().evolution;
  const holdForReview = opts.actor === 'agent' && !evo.autoEnable;
  const enabled = holdForReview ? false : created ? true : (prev?.enabled ?? true);
  patchState(id, (s) => (s.enabled = enabled));
  resetCrashes(id);

  let activation: ActivationReport;
  if (enabled) {
    const r = await startExtension(id);
    const rt = runtimeOf(id);
    activation = report(r.status === 'active', r.status, r.error, rt?.registry ?? null, getLogs(id, 15).map((l) => `[${l.level}] ${l.text}`), false);
  } else {
    await stopExtension(id);
    const p = await probeExtension(id).catch((e) => ({ ok: false, error: (e as Error).message, logs: [] as string[], registry: undefined }));
    if (p.ok && p.registry) patchState(id, (s) => (s.registry = p.registry));
    activation = report(p.ok, 'disabled', p.error, p.registry ?? null, p.logs, true);
  }

  record(created ? 'extension.created' : 'extension.updated', `${created ? 'Created' : 'Updated'} ${manifest.name} (r${st.revision})`, {
    detail: `${note}${activation.ok ? '' : `\nActivation failed: ${activation.error?.split('\n')[0]}`}`,
    actor: opts.actor,
    sessionId: opts.sessionId,
    ref: id,
  });
  activity('EVO', `${created ? 'Created' : 'Updated'} extension ${manifest.name} r${st.revision}${activation.ok ? '' : ' (activation failed)'}`, activation.ok ? 'info' : 'warn', opts.sessionId);
  if (holdForReview)
    notify('Extension waiting for review', `${manifest.name} (r${st.revision}) was written by Monarch and is disabled until you enable it.`, 'info', '#/evolve');
  changed('extensions');
  return { detail: extensionDetail(id), activation, created };
}

function report(
  ok: boolean,
  status: ExtensionSummary['status'],
  error: string | undefined,
  registry: { tools: { name: string }[]; panels: { id: string }[]; jobs: { id: string }[] } | null,
  logs: string[],
  probe: boolean,
): ActivationReport {
  return {
    ok,
    status,
    ...(error ? { error } : {}),
    tools: registry?.tools.map((t) => t.name) ?? [],
    panels: registry?.panels.map((p) => p.id) ?? [],
    jobs: registry?.jobs.map((j) => j.id) ?? [],
    logs,
    probe,
  };
}

export async function toggleExtension(id: string, enabled: boolean, actor: Actor, sessionId?: string): Promise<ExtensionSummary> {
  checkId(id);
  const manifest = readManifest(id);
  patchState(id, (s) => (s.enabled = enabled));
  resetCrashes(id);
  if (enabled) await startExtension(id);
  else await stopExtension(id);
  record(enabled ? 'extension.enabled' : 'extension.disabled', `${enabled ? 'Enabled' : 'Disabled'} ${manifest.name}`, { actor, sessionId, ref: id });
  activity('EXT', `${enabled ? 'Enabled' : 'Disabled'} ${manifest.name}`, 'info', sessionId);
  changed('extensions');
  return extensionSummary(id);
}

export async function reloadExtension(id: string): Promise<ExtensionSummary> {
  checkId(id);
  resetCrashes(id);
  if (getState(id)?.enabled) await startExtension(id);
  activity('EXT', `Reloaded ${readManifest(id).name}`);
  return extensionSummary(id);
}

export async function rollbackExtension(id: string, revision: number, actor: Actor, sessionId?: string): Promise<ExtensionDetail> {
  checkId(id);
  if (!Number.isInteger(revision) || revision < 1) throw new HttpError(400, 'revision must be a positive integer');
  const { manifest, source } = readRevision(id, revision);
  const st = getState(id)!;
  writeRevision(normalizeManifest(manifest, id), source, { actor, note: `Rollback to r${revision}`, origin: st.origin });
  resetCrashes(id);
  if (st.enabled) await startExtension(id);
  record('extension.rollback', `Rolled back ${manifest.name} to r${revision} (now r${getState(id)!.revision})`, { actor, sessionId, ref: id });
  activity('EVO', `Rolled back ${manifest.name} to r${revision}`, 'info', sessionId);
  changed('extensions');
  return extensionDetail(id);
}

export async function removeExtension(id: string, actor: Actor, sessionId?: string): Promise<void> {
  checkId(id);
  const name = readManifest(id).name;
  await stopExtension(id);
  removeFromDisk(id);
  const all = (secrets.get() as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
  if (all?.[id]) {
    delete all[id];
    secrets.save();
  }
  record('extension.removed', `Removed ${name}`, { actor, sessionId, ref: id });
  activity('EVO', `Removed extension ${name}`, 'info', sessionId);
  changed('extensions');
}

export async function setExtensionSecret(id: string, name: string, value: string): Promise<ExtensionSummary> {
  checkId(id);
  const manifest = readManifest(id);
  if (!(manifest.secrets ?? []).includes(name)) throw new HttpError(400, `"${name}" is not declared in ${id}'s manifest.secrets`);
  secrets.update((s) => {
    const root = ((s as Record<string, unknown>).extensions ??= {}) as Record<string, Record<string, string>>;
    const bucket = (root[id] ??= {});
    if (value) bucket[name] = value;
    else delete bucket[name];
  });
  activity('EXT', `${value ? 'Set' : 'Cleared'} secret ${name} for ${manifest.name}`);
  changed('extensions');
  return extensionSummary(id);
}

export async function testExtensionTool(id: string, tool: string, args: unknown): Promise<{ ok: boolean; output: string; durationMs: number }> {
  checkId(id);
  // accept both the local name ("top_stories") and the full name ("hacker_news_top_stories")
  const prefix = `${id.replace(/-/g, '_')}_`;
  const rt = runtimeOf(id);
  const local = rt?.registry?.tools.some((t) => t.name === tool) ? tool : tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
  const t0 = Date.now();
  try {
    const out = await callTool(id, local, args ?? {});
    return { ok: true, output: typeof out === 'string' ? out : JSON.stringify(out, null, 2), durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, output: (e as Error).message, durationMs: Date.now() - t0 };
  }
}

export async function extensionPanel(id: string, panel: string) {
  checkId(id);
  try {
    return await renderPanel(id, panel);
  } catch (e) {
    throw new HttpError(502, (e as Error).message);
  }
}

/* ─────────────── lifecycle ─────────────── */

export async function startExtensions(): Promise<void> {
  seedBuiltins();
  const ids = discoverIds();
  const items = stateStore.get().items;
  for (const id of ids) ensureState(id, 'user'); // dropped in by hand
  for (const id of Object.keys(items)) if (!ids.includes(id)) delete items[id];
  stateStore.save();
  const enabled = ids.filter((id) => items[id]?.enabled);
  const results = await Promise.all(enabled.map(async (id) => [id, await startExtension(id)] as const));
  const failed = results.filter(([, r]) => r.status !== 'active').map(([id]) => id);
  activity('EXT', `Extensions: ${results.length - failed.length} active${failed.length ? `, failed: ${failed.join(', ')}` : ''} (${ids.length} installed)`, failed.length ? 'warn' : 'info');
  changed('extensions');
}

export async function stopExtensions(): Promise<void> {
  await stopAll();
}
