/**
 * Route registry. OWNED BY THE ORCHESTRATOR. Each module exports `register(app: Hono): void`
 * and mounts handlers under /api/... (see packages/shared/src/protocol.ts for the REST surface).
 *  - system.ts         (Core-A) settings, briefing, activity, notifications, system/*, weather, geocode, usage, fs/dirs, coding/git
 *  - productivity.ts   (Core-A) tasks, events, automations
 *  - agent.ts          (Core-B) providers, models, oauth, sessions, approvals
 *  - integrations.ts   (Core-C) google, mail, slack, memory
 *  - extensions.ts     (Evo)    extensions, skills, evolution, tool catalog, extension-api
 */
import type { Hono } from 'hono';
import { register as system } from './system.ts';
import { register as productivity } from './productivity.ts';
import { register as agent } from './agent.ts';
import { register as integrations } from './integrations.ts';
import { register as extensions } from './extensions.ts';

export function registerRoutes(app: Hono): void {
  system(app);
  productivity(app);
  agent(app);
  integrations(app);
  extensions(app);
}
