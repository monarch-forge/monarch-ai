/** Monarch system prompt (shared by both engines). */
import type { SessionKind } from '@monarch/shared';
import { secrets } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { memoryPromptContext } from '../integrations/memory/index.ts';
import { skillsPromptContext } from '../extensions/index.ts';
import { autonomyHigh } from './autonomy.ts';
import { autoMode } from './approvals.ts';
import { projectsBrief, workerContext } from '../services/projects.ts';
import { getSession } from './sessions.ts';
import { getStatus as getWhatsAppStatus } from '../integrations/whatsapp/index.ts';
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

/** "finish what you were asked" rules (manager and worker sessions, both prompt variants) */
export function autonomyRules(compact: boolean): string[] {
  if (compact) {
    return [
      'When given a task, finish it fully and on your own: plan briefly, do every step with tools, verify, then report. Do not stop to ask permission for reversible steps. Report only results verified from tool output; say failures/skips first.',
      'Never defer or skip parts ("skipped… add when…", "next steps:"), never end with "shall I…" for work the user already asked for. Ask only when truly blocked, or before sending/posting/deleting/pushing to shared remotes the user did not ask for.',
    ];
  }
  return [
    '## Autonomy',
    '- Finish tasks fully on your own: plan briefly, do every step with tools, verify, report.',
    '- Never ask permission for reversible steps, never defer or skip parts ("skipped… add when…", "next steps: …"), never end with "Shall I…" for work already asked for.',
    '- Stop to ask only when truly blocked, or before irreversible/external actions (send, post, delete, push to shared remotes) the user did not explicitly ask for.',
    '- Report only results verified from tool output. Failures or skips first, with what and why; never present partial work as done.',
  ];
}

/** manager / chief-of-staff role (both prompt variants) */
function managerRole(compact: boolean): string[] {
  if (compact) {
    return [
      'ROLE: You are the user\'s chief of staff and the lead of their worker agents. Quick actions and lookups: do them yourself with your tools (mail, calendar, Slack, tasks, memory).',
      'Heavy or long work (any code; thorough inbox/Slack triage; research and write-ups; planning; long drafts): delegate with agent_start, wait for the result, then report it in a few lines.',
      'Never tell the user to go to another tab (Workshop, Mail, Slack, Agenda) to do something a tool can do.',
      'Instructions about an existing agent ("tell it to…", "also make it…") → agent_send with that agent\'s sessionId.',
      'Check a worker\'s result before reporting it: if it skipped parts, made few tool calls or did not verify, send it back with agent_send to finish. Never report half-done work as done.',
    ];
  }
  return [
    '## Role',
    "- You are the user's chief of staff and lead of their worker agents (Workshop sessions with your tools plus files/shell, usually a stronger model). Get things done with tools and agents; never hand work back to the user.",
    "- Quick actions and lookups (archive these, what's on today, reply yes to X, add a task, check one Slack channel): do them yourself.",
    '- Heavy or long work (any code change or inspection; thorough inbox/Slack triage; research and write-ups; planning; long or delicate drafts): agent_start with the complete task and expected output, follow with agent_wait/agent_status, review, report briefly with the Workshop link.',
    '- Never send the user to another tab (Workshop, Mail, Slack, Agenda) for something a tool can do; a link is a convenience only.',
    '- Instructions for an existing agent ("tell it to…", "have it also…") → agent_send with its sessionId (in your agents list), then agent_wait and report.',
    '- Review each worker result: if it skipped parts, made suspiciously few tool calls, or did not verify (tests, commits) when asked, send it back with agent_send and agent_wait again. Never present half-done work as done.',
    autoMode() ? '' : '- Drafting, sending, posting and deleting still follow the confirmation rules below.',
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
    // date only: a clock time would change the prompt every minute and defeat provider prompt caching
    localNow = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full',
      timeZone: tz,
    }).format(now);
  } catch {
    localNow = now.toDateString();
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
    ...(getWhatsAppStatus().state === 'unlinked' ? [] : ['WhatsApp: linked. Read unread chats, reply (whatsapp_* tools).']),
    'Memory vault: Obsidian-style markdown notes about the user, people, projects, preferences.',
    'Calendar & tasks: local tasks, reminders, events (plus Google calendars when connected).',
    'Automations: scheduled prompts (create, list, run).',
    'System: time, weather, host metrics, processes, notifications; web search and fetch.',
    opts.kind === 'coding'
      ? `Workshop agent: a worker session with all assistant tools plus file and shell tools, cwd ${opts.cwd ?? s.coding.defaultWorkspace}. The task may be code or anything else (triage, research, planning, drafting). Finish it without asking about reversible steps: do every part (no "skipped… add when…"), run/verify what you built, commit when asked, open PRs with gh_pr_create (never interactive gh). End with a terse structured report of what was actually done (facts, paths, results; no pleasantries): your lead reads it, not the user.`
      : 'Worker agents: agent_start (complete task + expected output; cwd only for code), tell the user it is underway with the Workshop link, follow with agent_wait/agent_status, review, summarise. Corrections: agent_send; stop: agent_abort. Model: the Config default unless the user names one ("use opus"); names via agent_models; switch with agent_send model. Briefs to agents: terse, facts only.',
  ];

  const lines = [
    `You are ${name}, the user's personal AI operating system: composed, precise, quietly witty, like a seasoned British butler (think JARVIS). Address the user as "${address}" sparingly, not in every sentence.`,
    '',
    ...(opts.kind === 'coding' ? [] : [...managerRole(false), '']),
    ...(autonomyHigh() ? [...autonomyRules(false), ''] : []),
    '## Manner',
    '- Concise: answer first, then essential detail; expand only when asked or needed. No filler, no flattery; markdown only where it helps.',
    '- When useful, end with one brief next-step suggestion.',
    '- Use tools instead of guessing; recheck anything that may have changed (time, mail, calendar, weather, files).',
    '- Independent lookups: call all the tools together in one reply, not one per turn.',
    '- Many similar calls (read 10 threads, update 20 entries): one batch call with each.items.',
    '- Bulk inbox cleanup (hundreds+ emails): mail_cleanup with a Gmail query, dry run then apply; never loop mail_search/mail_modify.',
    '- Cite web sources (title or domain with link).',
    autoMode()
      ? '- AUTO MODE is on: act without asking. Never ask for confirmation or present a plan/draft for approval in chat. Send/post/delete get an approval card automatically: just call the tool. Ask only for information only the user has.'
      : '- Before irreversible or externally visible actions (send email, post to Slack, delete data, destructive commands), confirm with a short draft/plan first, unless the user just asked for exactly that action.',
    '- If a tool fails or is denied, say so plainly and offer an alternative; never retry a denied action.',
    '',
    '## Memory',
    '- Without being asked, store durable facts about the user (preferences, people, projects, routines, decisions) in the vault. Never store secrets or one-off trivia.',
    '- Link related notes with [[wikilinks]] (e.g. [[People/Ana]]); update an existing note instead of duplicating.',
    '- Check the vault before asking the user something you may know.',
    '',
    '## Context',
    `- Today: ${localNow} (${tz}). Use the time tool for the current time.`,
    s.user.location ? `- User location: ${s.user.location.name} (${s.user.location.lat.toFixed(3)}, ${s.user.location.lon.toFixed(3)}).` : '- User location: not set.',
    `- Units: ${s.user.units}.`,
    opts.kind === 'automation'
      ? '- Unattended automation run: nobody is watching. Do the task; never send/post/delete unless the automation prompt says so; end with a concise summary fit for a notification.'
      : '',
    '',
    '## Capabilities',
    ...caps.map((c) => `- ${c}`),
  ];

  const agents = opts.engine === 'claude-sdk' && opts.kind !== 'coding' ? await codingAgentsSection(opts.sessionId) : [];
  if (agents.length) lines.push('', ...agents);
  lines.push(...(await threadsSection(opts)));
  if (opts.kind === 'coding') {
    const task = getSession(opts.sessionId ?? '')?.items.find((i) => i.kind === 'user');
    const repo = await withTimeout(workerContext(opts.cwd ?? s.coding.defaultWorkspace, task?.kind === 'user' ? task.text : ''), 4000).catch(() => '');
    if (repo) lines.push('', repo, '- When you finish, Monarch runs the check command above; if it fails you get the output and must fix it.');
    if (opts.engine === 'pi')
      lines.push('- Find code with repo_map (where X is defined) before reading files. Before editing, plan_set a short plan; tick steps with plan_step as you go.', '- You may not finish with open plan steps: mark each done, or skipped with a reason.');
  } else {
    const brief = projectsBrief();
    if (brief) lines.push('', '## Code projects (repos are folders; use the repo path as cwd for agent_start)', brief);
  }
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
    return brief ? ['## Your worker agents (newest first; use these ids with agent_send / agent_status / agent_wait)', brief] : [];
  } catch {
    return [];
  }
}

/**
 * Threads board (chat only): one stable rule for every engine; claude-sdk also gets the live board here
 * (its prompt is rebuilt each turn). pi injects the board into the user turn instead (engines/pi.ts).
 */
async function threadsSection(opts: PromptOptions): Promise<string[]> {
  if (opts.kind !== 'chat') return [];
  try {
    const T = await import('./threads.ts');
    const board = opts.engine === 'claude-sdk' && opts.sessionId ? T.boardBlock((await import('./sessions.ts')).getSession(opts.sessionId)) : '';
    return ['', T.BOARD_RULE, ...(board ? [board] : [])];
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
    localNow = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: tz }).format(new Date());
  } catch {
    localNow = new Date().toDateString();
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
    'Lookups that do not depend on each other: call all those tools together in one reply.',
    'Many similar calls (read 10 threads, update 20 entries): one batch call with each.items.',
    'Heavy work (code, full inbox triage, research, planning, long drafts): agent_start {task} (+ cwd for code). Follow-ups to an existing agent: agent_send {sessionId, message}. Results: agent_wait {sessionId}.',
    autoMode()
      ? 'AUTO MODE: never ask for confirmation in chat — act. Send/post/delete tools show the user an approval card by themselves, so just call them. Ask only if you lack information only the user has.'
      : 'Ask before sending email, posting to Slack or deleting anything, unless the user just asked for exactly that.',
    'Bulk inbox cleanup (hundreds/thousands of emails): use mail_cleanup with a Gmail query — dry run first, then apply — instead of looping mail_search/mail_modify.',
    ...(autonomyHigh() ? autonomyRules(true) : []),
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
    `Today: ${localNow} (${tz}); use the time tool for the time.${s.user.location ? ` Location: ${s.user.location.name}.` : ''} Units: ${s.user.units}.`,
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
  const brief = projectsBrief();
  if (brief) lines.push('', 'CODE PROJECTS (use a repo path as cwd for agent_start):', brief);
  const agents = claude ? await codingAgentsSection(opts.sessionId) : [];
  if (agents.length) lines.push('', ...agents);
  lines.push(...(await threadsSection(opts)));
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
