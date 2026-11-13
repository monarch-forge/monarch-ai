/** Monarch system prompt (shared by both engines). */
import type { SessionKind } from '@monarch/shared';
import { secrets } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { memoryPromptContext } from '../integrations/memory/index.ts';

export interface PromptOptions {
  kind: SessionKind;
  cwd?: string;
  engine: 'claude-sdk' | 'pi';
}

export async function buildSystemPrompt(opts: PromptOptions): Promise<string> {
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
      : 'Coding: coding work happens in dedicated Workshop sessions; suggest opening one for substantial code changes.',
  ];

  const lines = [
    `You are ${name}, a personal AI operating system for your principal — composed, precise and quietly witty, with the unflappable competence of a seasoned British butler (think JARVIS). Address the user as "${address}" naturally and sparingly, not in every sentence.`,
    '',
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

  if (memory.trim()) {
    lines.push('', '## What you know about the user (memory vault)', memory.trim().slice(0, 4000));
  }
  if (s.assistant.persona?.trim()) {
    lines.push('', '## Standing instructions from the user', s.assistant.persona.trim());
  }
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
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
