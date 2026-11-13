/**
 * Tool registry. OWNED BY THE ORCHESTRATOR. Each module exports `tools: ToolDef[]`.
 *  - system.ts        (Core-A) time, weather, system status, processes, notify
 *  - productivity.ts  (Core-A) tasks, reminders, local calendar (+google via integrations), automations
 *  - web.ts           (Core-A) web_search, web_fetch, open_url
 *  - coding.ts        (Core-B) fs_read/fs_write/fs_edit/fs_list/grep/shell_exec/git (pi engine; claude-sdk uses Claude Code built-ins)
 *  - mail.ts          (Core-C) gmail across accounts
 *  - slack.ts         (Core-C) slack across workspaces
 *  - memory.ts        (Core-C) vault notes: search/read/write/link
 */
import type { ToolDef } from '../kernel.ts';
import { tools as system } from './system.ts';
import { tools as productivity } from './productivity.ts';
import { tools as web } from './web.ts';
import { tools as coding } from './coding.ts';
import { tools as mail } from './mail.ts';
import { tools as slack } from './slack.ts';
import { tools as memory } from './memory.ts';

/** tools available to every session */
export function assistantTools(): ToolDef[] {
  return [...system, ...productivity, ...web, ...mail, ...slack, ...memory];
}

/** file/shell tools for the pi engine (claude-sdk engine uses Claude Code's own Read/Write/Edit/Bash/Grep/Glob instead) */
export function codingTools(): ToolDef[] {
  return coding;
}

export function findTool(name: string): ToolDef | undefined {
  return [...assistantTools(), ...codingTools()].find((t) => t.name === name);
}
