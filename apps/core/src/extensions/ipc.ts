/**
 * IPC protocol between the core (ExtensionManager) and an extension host child process.
 * Types only — imported by both sides (host.ts is bundled separately, so keep this dependency-free).
 *
 * Everything the host sends is UNTRUSTED (extension code shares the host process and can call
 * process.send itself): the core validates every field and only answers ids it issued.
 */
import type { ExtensionPermission, ToolRisk } from '@monarch/shared';

export interface HostToolInfo {
  /** local name as registered by the extension ("top_stories") */
  name: string;
  description: string;
  risk: ToolRisk;
  /** JSON Schema of the input object (z.toJSONSchema) */
  schema: Record<string, unknown>;
}

export interface HostPanelInfo {
  id: string;
  title: string;
}

export interface HostJobInfo {
  id: string;
  everyMinutes: number;
}

export interface HostRegistry {
  tools: HostToolInfo[];
  panels: HostPanelInfo[];
  jobs: HostJobInfo[];
}

/** core → host */
export type CoreToHost =
  | { t: 'call'; id: number; tool: string; args: unknown }
  | { t: 'panel'; id: number; panel: string }
  | { t: 'job'; id: number; job: string }
  | { t: 'cancel'; id: number }
  /** answer to a host request (secrets) */
  | { t: 'res'; id: number; ok: boolean; value?: unknown; error?: string };

/** host → core */
export type HostToCore =
  | { t: 'ready'; registry: HostRegistry }
  /** registrations made after activation finished */
  | { t: 'registry'; registry: HostRegistry }
  /** activation failed (import error, activate() threw) */
  | { t: 'fatal'; error: string }
  | { t: 'result'; id: number; ok: boolean; output?: unknown; error?: string }
  | { t: 'progress'; id: number; text: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'notify'; title: string; body: string }
  | { t: 'req'; id: number; op: 'secret'; name: string };

/** passed to the host via env MONARCH_EXT_BOOT (JSON) */
export interface HostBoot {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: ExtensionPermission[];
  secrets: string[];
  /** absolute path of index.mjs */
  entry: string;
  /** absolute path of the private writable data dir */
  dataDir: string;
  /** probe = activate, report the registry, exit (dry run) */
  probe: boolean;
  /** whether the Node permission model enforces network access in this runtime */
  netEnforced: boolean;
}
