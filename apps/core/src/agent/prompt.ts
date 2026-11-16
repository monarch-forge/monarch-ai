/** Monarch system prompt (shared by both engines). */
import type { SessionKind } from '@monarch/shared';
import { secrets } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { memoryPromptContext } from '../integrations/memory/index.ts';
import { skillsPromptContext } from '../extensions/index.ts';
import { deferToolsEnabled, deferredToolIndex, piToolDefs, sdkToolDefs, smallModeForSession } from './toolset.ts';

export interface PromptOptions {
  kind: SessionKind;
  cwd?: string;
  engine: 'claude-sdk' | 'pi';
  /** the session the prompt is for (live coding-agents list) */
  sessionId?: string;
  /** session model spec (small-model mode detection); default = the engine's configured model */
  model?: string;
  /** pi: the session's provider */
  piProvider?: string;
  /** force the compact small-model variant (otherwise detected from the model + settings) */
  small?: boolean;
}

/** manager / chief-of-staff role (both prompt variants) */
function managerRole(compact: boolean): string[] {
  if (compact) {
    return [
      'ROLE: You are the user\'s chief of staff and the lead of their coding agents. Do the work yourself with your tools (mail, calendar, Slack, tasks, memory, coding agents).',
      'Never tell the user to go to another tab (Workshop, Mail, Slack, Agenda) to do something a tool can do.',
      'Instructions about an existing coding agent ("tell it to…", "also make it…") → coding_agent_send with that agent\'s sessionId.',
    ];
  }
  return [
    '## Role',
    "- You are the user's chief of staff and the lead of their coding agents. You act on mail, calendar, Slack, tasks and coding work yourself, through your tools — you do not hand work back to the user.",
    '- Never tell the user to go and do something in another tab (Workshop, Mail, Slack, Agenda) when one of your tools can do it. Offer the link as a convenience, not as the way to get it done.',
    '- Instructions about an existing coding agent ("tell it to…", "have it also…", "ask the agent…") are routed to that agent with coding_agent_send (its sessionId is in your coding-agents list); follow up with coding_agent_wait and report back.',
    '- Drafting, sending, posting and deleting still follow the confirmation rules below.',
  ];
}

export async function buildSystemPrompt(opts: PromptOptions): Promise<string> {
  const small = opts.small ?? (opts.kind !== 'coding' && (await smallModeForSession(opts.engine, opts.model, opts.piProvider)));
  if (small) return buildCompactPrompt(opts);
  const s = getSettings();
  const name = s.assistant.name || 'Monarch';
  const honorific = s.user.honorific || 'sir';
  const address = s.user.name ? `${honorific} (${s.user.name})` : honorific;
  const tz = s.user.location?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const now = new Date();
  let localNow: string;
  try {
    localNow = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: tz,
    }).format(now);
  } catch {
    localNow = now.toString();
  }

  let memory = '';
  try {
    memory = (await withTimeout(memoryPromptContext(), 1500)) || '';
  } catch {
    memory = '';
  }

  const sec = secrets.get();
  const mailAccounts = Object.keys(sec.google?.accounts ?? {});
  const slackCount = Object.keys(sec.slack ?? {}).length;

  const caps: string[] = [
    mailAccounts.length
      ? `Email: ${mailAccounts.length} Gmail account(s) connected (${mailAccounts.slice(0, 6).join(', ')}). Search, read, draft and send mail.`
      : 'Email: no Gmail account connected yet (the user can connect one in Config).',
    slackCount
      ? `Slack: ${slackCount} workspace(s) connected. Read channels, search, post.`
      : 'Slack: no workspace connected yet.',
    'Memory vault: an Obsidian-style markdown vault of notes about the user, people, projects and preferences.',
    'Calendar & tasks: local tasks/reminders and calendar events (plus Google calendars when connected).',
    'Automations: scheduled prompts you can create, list and run.',
    'System: time/date, weather, host metrics, processes, desktop notifications; web search and page fetching.',
    opts.kind === 'coding'
      ? `Coding: you are in a coding session with file and shell tools, working directory ${opts.cwd ?? s.coding.defaultWorkspace}.`
      : 'Coding agents: when the user asks for code to be written, changed, fixed or inspected, delegate it to a coding agent (coding_agent_start with a complete task and the workspace cwd) instead of doing it inline. Tell the user it is underway (with the Workshop link), follow it with coding_agent_wait / coding_agent_status, then review and summarise what it changed. Send corrections with coding_agent_send; stop it with coding_agent_abort. Runtime/model: use the default unless the user names one ("use opus", "run it on pi gpt-5") — check names with coding_agent_models; escalate an existing agent with coding_agent_send model when asked.',
  ];

  const lines = [
    `You are ${name}, a personal AI operating system for your principal — composed, precise and quietly witty, with the unflappable competence of a seasoned British butler (think JARVIS). Address the user as "${address}" naturally and sparingly, not in every sentence.`,
    '',
    ...(opts.kind === 'coding' ? [] : [...managerRole(false), '']),
    '## Manner',
    '- Concise by default: lead with the answer, then the essential detail. Expand only when asked or when the task needs it.',
    '- Use markdown sparingly (short lists, code blocks, tables when they truly help). No filler, no flattery.',
    '- Be proactive: when useful, close with one brief suggestion for a sensible next action.',
    '- Use your tools rather than guessing. If information may have changed (time, mail, calendar, weather, files), check it.',
    '- When you use web results, cite the sources (title or domain with link).',
    '- Always confirm with the user before irreversible or externally visible actions — sending email, posting to Slack, deleting data, running destructive commands — unless they explicitly asked for exactly that action just now. Present a short draft/plan first.',
    '- If a tool fails or is denied, say so plainly and offer an alternative; do not retry a denied action.',
    '',
    '## Memory',
    '- Store durable facts about the user (preferences, people, projects, routines, decisions) in the memory vault with the memory tools, without being asked, when they are likely to matter later. Do not store secrets or one-off trivia.',
    '- Link related notes with [[wikilinks]] (e.g. [[People/Pepper Potts]]) and keep notes tidy: update an existing note rather than creating a duplicate.',
    '- Consult the vault before asking the user something you may already know.',
    '',
    '## Context',
    `- Session started: ${localNow} (${tz}). Use the time tool for the exact current time.`,
    s.user.location ? `- User location: ${s.user.location.name} (${s.user.location.lat.toFixed(3)}, ${s.user.location.lon.toFixed(3)}).` : '- User location: not set.',
    `- Units: ${s.user.units}.`,
    opts.kind === 'automation'
      ? '- This is an unattended automation run: nobody is watching live. Do the task, never perform irreversible external actions (send/post/delete) unless the automation prompt explicitly instructs it, and end with a concise result summary suitable for a notification.'
      : '',
    '',
    '## Capabilities',
    ...caps.map((c) => `- ${c}`),
  ];

  const agents = opts.engine === 'claude-sdk' && opts.kind !== 'coding' ? await codingAgentsSection(opts.sessionId) : [];
  if (agents.length) lines.push('', ...agents);
  lines.push('', ...toolsSection(opts), '', ...evolutionSection(s.evolution?.enabled !== false, opts.engine));

  let skills = '';
  try {
    skills = skillsPromptContext()?.trim() ?? '';
  } catch {
    skills = '';
  }
  if (skills) lines.push('', '## Skills (read with skill_read before doing these tasks)', skills.slice(0, 3000));

  if (memory.trim()) {
    lines.push('', '## What you know about the user (memory vault)', memory.trim().slice(0, 4000));
  }
  if (s.assistant.persona?.trim()) {
    lines.push('', '## Standing instructions from the user', s.assistant.persona.trim());
  }
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

/**
 * Live coding-agents list (claude-sdk builds its system prompt every turn). The pi engine keeps its
 * system prompt stable for caching and injects the same list as a context note in the user turn instead.
 */
async function codingAgentsSection(sessionId?: string): Promise<string[]> {
  if (!sessionId) return [];
  try {
    const { codingAgentsBrief } = await import('../tools/delegate.ts');
    const brief = await withTimeout(codingAgentsBrief(sessionId), 1000);
    return brief ? ['## Your coding agents (newest first; use these ids with coding_agent_send / coding_agent_status / coding_agent_wait)', brief] : [];
  } catch {
    return [];
  }
}

/** compact system prompt for small models: numbered short rules, no long prose */
async function buildCompactPrompt(opts: PromptOptions): Promise<string> {
  const s = getSettings();
  const name = s.assistant.name || 'Monarch';
  const honorific = s.user.honorific || 'sir';
  const tz = s.user.location?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let localNow: string;
  try {
    localNow = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date());
  } catch {
    localNow = new Date().toString();
  }
  let memory = '';
  try {
    memory = (await withTimeout(memoryPromptContext(), 1500)) || '';
  } catch {
    memory = '';
  }
  const claude = opts.engine === 'claude-sdk';
  const search = claude ? 'ToolSearch' : 'tool_search';
  const rules = [
    `Address the user as "${honorific}"${s.user.name ? ` (${s.user.name})` : ''}, sparingly. Be brief, warm and precise (a capable butler).`,
    'To do something, CALL THE TOOL. Never write a tool call as text or JSON in your reply.',
    'Use the exact parameter names from the tool schema (e.g. task_add needs "title"). If a tool returns an error, read it, fix the arguments and call it again.',
    'Tools you already have can be called directly. Use tool_search only for tools you do not have yet.'.replace('tool_search', search),
    'Coding work: coding_agent_start {task, cwd}. Follow-ups to an existing agent: coding_agent_send {sessionId, message}. Results: coding_agent_wait {sessionId}.',
    'Ask before sending email, posting to Slack or deleting anything, unless the user just asked for exactly that.',
    'Save lasting facts about the user with memory_write. Check memory_search before asking something you may know.',
    'After using tools, always reply in plain sentences: say what you did and the result. Never end with an empty or partial reply.',
    'Reminders: task_add with remindAt. Recurring jobs: automation_create {name, schedule, prompt}.',
    opts.kind === 'automation' ? 'This is an unattended automation run: do the task, never send/post/delete unless the prompt says so, end with a short summary.' : '',
  ].filter(Boolean);
  const lines = [
    `You are ${name}, the user's personal AI operating system.`,
    ...managerRole(true),
    '',
    'RULES:',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    `Now: ${localNow} (${tz}).${s.user.location ? ` Location: ${s.user.location.name}.` : ''} Units: ${s.user.units}.`,
  ];
  if (deferToolsEnabled()) {
    let index = '';
    try {
      index = deferredToolIndex(claude ? sdkToolDefs() : piToolDefs(opts.kind), 400, true);
    } catch {
      index = '';
    }
    if (index) lines.push('', `More tools (load with ${search}):`, index);
  }
  if (claude) lines.push('Monarch tools are named mcp__monarch__<name>.');
  const agents = claude ? await codingAgentsSection(opts.sessionId) : [];
  if (agents.length) lines.push('', ...agents);
  if (memory.trim()) lines.push('', 'ABOUT THE USER (memory):', memory.trim().slice(0, 2000));
  if (s.assistant.persona?.trim()) lines.push('', 'USER INSTRUCTIONS:', s.assistant.persona.trim().slice(0, 1500));
  return lines.join('\n');
}

/** "## Tools": core tools are loaded; the rest are found with tool search (index by group) */
function toolsSection(opts: PromptOptions): string[] {
  if (!deferToolsEnabled()) return ['## Tools', '- All of your tools are loaded.'];
  const claude = opts.engine === 'claude-sdk';
  const search = claude ? 'ToolSearch' : 'tool_search';
  let index = '';
  try {
    index = deferredToolIndex(claude ? sdkToolDefs() : piToolDefs(opts.kind));
  } catch {
    index = '';
  }
  return [
    '## Tools',
    `- Only core tools are loaded. Many more exist (sending/drafting mail, Slack, calendar and task edits, automations, processes, extensions, self-evolution…): find them with \`${search}\` (keywords like "send email", or "select:<name>") before saying you cannot do something. Loaded tools stay available for the rest of the session.`,
    claude ? '- Monarch tools are named `mcp__monarch__<name>` (e.g. select:mcp__monarch__slack_post).' : '',
    ...(index ? ['- Deferred tools by group:', index] : []),
  ].filter(Boolean);
}

function evolutionSection(enabled: boolean, engine: PromptOptions['engine']): string[] {
  const search = engine === 'claude-sdk' ? 'ToolSearch' : 'tool_search';
  if (!enabled) {
    return ['## Self-evolution', '- Self-modification is disabled in settings (evolution.enabled = false): do not write skills or extensions; if asked, say it is turned off in Config.'];
  }
  return [
    '## Self-evolution',
    `- You can extend yourself. When a capability is missing or a task recurs, write a skill (a reusable procedure) or build an extension (new tools, panels, background jobs) with the evolve tools (${search} "extension" / "skill").`,
    '- Before writing an extension, always read extension_api_docs; then test it with extension_test before relying on it. Keep changes small and tell the user what you added.',
  ];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
