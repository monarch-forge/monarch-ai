/** Welcome & guides — first-launch orientation and how-to notes (route #/welcome). */
import type { ComponentChildren } from 'preact';
import { Cpu, Link2, FolderGit2, Zap, ArrowRight } from 'lucide-preact';
import { navigate } from '../lib/store.ts';
import { Btn, Disclosure, PageHeader, Panel } from '../components/ui.tsx';

const STEPS: { icon: typeof Cpu; title: string; body: string; actions: [string, string][] }[] = [
  {
    icon: Cpu,
    title: 'Pick a model',
    body: 'Choose the models Monarch uses. Custom OpenAI-compatible providers work too, including local Ollama or LM Studio.',
    actions: [['Models', 'config/models'], ['Providers', 'config/providers']],
  },
  {
    icon: Link2,
    title: 'Connect Google & Slack',
    body: 'Sign in so Monarch can read and manage your mail, calendar and Slack.',
    actions: [['Accounts', 'config/accounts']],
  },
  {
    icon: FolderGit2,
    title: 'Add your code projects',
    body: 'Point Monarch at a folder holding your repos. It detects how to build and test each repo, no AGENTS.md needed.',
    actions: [['Projects', 'config/projects']],
  },
  {
    icon: Zap,
    title: 'Turn on Auto mode',
    body: 'Use the ⚡ Auto button in the top bar. The agent works on its own; only send, post and delete ask first. It notifies you when it needs you.',
    actions: [['Open Chat', 'chat']],
  },
];

const GUIDES: [string, ComponentChildren[]][] = [
  ['Chat is your main channel', [
    'Ask anything. Quick things it does itself; heavy work goes to worker agents.',
    'Side "btw" questions are fine mid-task.',
    'Steer workers from Chat: "tell the backend agent to also …".',
  ]],
  ['Coding across repos', [
    'Add the project folder in Config → Projects, then ask Chat for a feature.',
    'It writes a short spec and starts one worker per repo (backend first, frontend last), each with the repo as its working folder.',
    'Each worker gets the repo profile automatically.',
    'After file edits Monarch runs the repo\'s check command and sends failures back, up to 2 fix rounds. "Done" means the check passed.',
    'Edit the check command per repo in Config → Projects.',
    'Small/fast models (e.g. Gemini Flash): one repo and one concern per task, name the files, paste errors exactly. For heavy refactors switch the worker to Claude (Config → Models → Worker agents).',
  ]],
  ['Workshop', [
    'Watch or steer a worker live and read its transcript.',
    'You rarely need it; Chat covers most of this.',
  ]],
  ['Ledger', [
    'Track spending and income, accounts and credit cards, and budgets.',
    'Cards take a limit, statement day and due day; you get a reminder 3 days before the due date.',
    'Ask Chat to record transactions from bank emails. It de-duplicates.',
  ]],
  ['Mail & Slack', [
    'Triage, bulk cleanup (always previewed first), mark read, reply.',
  ]],
  ['Agenda & automations', [
    'Tasks and reminders: "remind me at 5".',
    'Recurring automations: "every weekday 8am summarize my inbox".',
  ]],
  ['Memory', [
    'An Obsidian-style vault the agent reads and writes.',
    'Tell it facts to remember and it will keep them.',
  ]],
  ['Evolve & MCP', [
    'Monarch can write its own extensions; you review them first.',
    'Connect MCP servers, with OAuth sign-in supported.',
  ]],
  ['Keyboard', [
    'Ctrl K opens the command palette: search pages, run actions, reopen this guide.',
    'Type /compact in a chat to shrink its context.',
  ]],
];

export default function WelcomePage(_props: { params: string[] }) {
  return (
    <div class="h-full overflow-y-auto">
      <div class="mx-auto max-w-[960px] px-6 py-8 flex flex-col gap-6">
        <PageHeader
          title="Welcome to Monarch"
          description="Your personal workspace for work and life: chat with one agent that manages mail, Slack, calendar, tasks, money and code for you."
          right={<Btn variant="primary" onClick={() => navigate('chat')}>Start chatting <ArrowRight size={14} /></Btn>}
        />

        <Panel title="Get started">
          <ol class="flex flex-col divide-y divide-line">
            {STEPS.map((s, i) => (
              <li key={s.title} class="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <s.icon size={16} class="mt-0.5 shrink-0 text-fg-3" />
                <div class="min-w-0 flex-1">
                  <div class="text-[13.5px] font-medium text-fg">{i + 1}. {s.title}</div>
                  <p class="mt-0.5 text-[12.5px] text-fg-2 leading-relaxed">{s.body}</p>
                </div>
                <div class="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {s.actions.map(([label, path]) => (
                    <Btn key={path} size="xs" onClick={() => navigate(path)}>{label}</Btn>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </Panel>

        <Panel title="Guides">
          <div class="flex flex-col divide-y divide-line">
            {GUIDES.map(([title, items]) => (
              <Disclosure key={title} label={<span class="text-[13px] text-fg">{title}</span>} class="py-1.5" bodyClass="pt-1 pb-2 pl-4">
                <ul class="list-disc pl-4 flex flex-col gap-1 text-[12.5px] text-fg-2 leading-relaxed">
                  {items.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </Disclosure>
            ))}
          </div>
        </Panel>

        <p class="text-[12px] text-fg-3">Reopen this page any time from Ctrl K → Welcome &amp; guides.</p>
      </div>
    </div>
  );
}
