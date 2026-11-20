import type { AgentRole, EngineId, SessionKind, Settings } from '@monarch/shared';

type Pick = { engine?: EngineId; model?: string };
type AgentSettings = { agent?: Settings['agent'] };

/** which role a new session plays: top-level by its kind, spawned by its parent's kind */
export function roleOf(kind: SessionKind | undefined, parentKind?: SessionKind): AgentRole {
  if (parentKind) return parentKind === 'coding' ? 'workshopSub' : 'chatSub';
  return kind === 'coding' ? 'workshop' : 'chat';
}

/** configured default for a role; chatSub falls back to the legacy workerModel. undefined = global default */
export function roleDefault(s: AgentSettings, role: AgentRole): { engine: EngineId; model: string } | undefined {
  const rm = s.agent?.roleModels;
  const r = rm && role in rm ? rm[role] : role === 'chatSub' ? s.agent?.workerModel : undefined;
  return r?.model ? { engine: r.engine, model: r.model } : undefined;
}

/** explicit spawner/UI choice > role default > {} (caller applies the global default) */
export function resolveRoleModel(s: AgentSettings, role: AgentRole, explicit: Pick): Pick {
  if (explicit.engine || explicit.model?.trim()) return explicit;
  return roleDefault(s, role) ?? {};
}
