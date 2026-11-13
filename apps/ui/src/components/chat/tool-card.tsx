/**
 * Compact tool-call row with an expandable detail view. Special renderers for shell / edit / write / read style tools
 * (Claude Code names and Monarch/pi lowercase names), generic JSON for everything else.
 */
import { useState } from 'preact/hooks';
import type { ChatItem, ToolStatus } from '@monarch/shared';
import { ChevronRight, Copy } from 'lucide-preact';
import { approvals } from '../../lib/store.ts';
import { displayToolName, findApproval, respondApproval } from '../approvals.tsx';
import { copyText } from './markdown.tsx';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}
function pick(o: Rec, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const s = str(o[k]);
    if (s !== undefined && s !== '') return s;
  }
  return undefined;
}
function json(v: unknown): string {
  if (v === undefined) return '';
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

type Family = 'shell' | 'edit' | 'write' | 'read' | 'search' | 'web' | 'todo' | 'generic';

function family(name: string): Family {
  const n = displayToolName(name).toLowerCase();
  if (/^(bash|shell|run_?command|exec|terminal|run_shell|bashoutput)$/.test(n)) return 'shell';
  if (/^(edit|multiedit|multi_edit|str_replace|str_replace_editor|edit_file|apply_patch|notebookedit)$/.test(n)) return 'edit';
  if (/^(write|write_file|create_file)$/.test(n)) return 'write';
  if (/^(read|read_file|view|cat)$/.test(n)) return 'read';
  if (/^(grep|glob|find|ls|search_files|list_dir|list_files)$/.test(n)) return 'search';
  if (/^(webfetch|websearch|web_fetch|web_search|fetch_url|browse)$/.test(n)) return 'web';
  if (/^(todowrite|todo_write)$/.test(n)) return 'todo';
  return 'generic';
}

function filePath(o: Rec): string | undefined {
  return pick(o, 'file_path', 'path', 'filePath', 'filename', 'notebook_path', 'file');
}

export { family as toolFamily };

/** one-line human summary of a tool input */
export function toolSummary(name: string, input: unknown): string {
  const o = rec(input);
  switch (family(name)) {
    case 'shell':
      return pick(o, 'command', 'cmd', 'script') ?? pick(o, 'description') ?? '';
    case 'edit':
    case 'write':
    case 'read':
      return filePath(o) ?? '';
    case 'search':
      return [pick(o, 'pattern', 'query', 'glob'), pick(o, 'path', 'dir', 'cwd')].filter(Boolean).join('  in  ');
    case 'web':
      return pick(o, 'url', 'query', 'q') ?? '';
    case 'todo': {
      const todos = Array.isArray(o.todos) ? o.todos : [];
      return `${todos.length} item${todos.length === 1 ? '' : 's'}`;
    }
    default: {
      if (typeof input === 'string') return input;
      const first = pick(o, 'query', 'q', 'command', 'path', 'url', 'title', 'subject', 'to', 'text', 'name', 'id', 'channel');
      if (first) return first;
      const keys = Object.keys(o);
      return keys.length ? keys.map((k) => `${k}=${typeof o[k] === 'object' ? '…' : String(o[k])}`).join(' ') : '';
    }
  }
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  'pending-approval': 'awaiting approval',
  running: 'running',
  ok: 'ok',
  error: 'error',
  denied: 'denied',
};

function StatusDot(props: { status: ToolStatus }) {
  const s = props.status;
  const cls =
    s === 'running' ? 'bg-red hud-blink' : s === 'ok' ? 'bg-success/70' : s === 'pending-approval' ? 'bg-warning hud-blink' : 'bg-red';
  return <span class={`inline-block w-1.5 h-1.5 shrink-0 ${cls}`} title={STATUS_LABEL[s]} />;
}

const PRE = 'bg-[#121213] border border-line p-2 font-mono text-[11.5px] leading-[1.55] text-fg-2 overflow-auto max-h-80 whitespace-pre-wrap break-all';

function Section(props: { label: string; copy?: string; children: any }) {
  return (
    <div class="mt-2 first:mt-0">
      <div class="flex items-center gap-2 mb-1">
        <span class="hud-label text-[10px]">{props.label}</span>
        {props.copy !== undefined && props.copy !== '' && (
          <button class="text-fg-3 hover:text-fg-2" title="Copy" onClick={() => void copyText(props.copy!)}>
            <Copy size={10} strokeWidth={1.5} />
          </button>
        )}
      </div>
      {props.children}
    </div>
  );
}

function Diff(props: { oldText: string; newText: string }) {
  const oldLines = props.oldText ? props.oldText.split('\n') : [];
  const newLines = props.newText ? props.newText.split('\n') : [];
  return (
    <div class="bg-[#121213] border border-line py-1 font-mono text-[11.5px] leading-[1.55] overflow-auto max-h-80 whitespace-pre">
      {oldLines.map((l, i) => (
        <div key={`o${i}`} class="px-2 min-w-max bg-red/[0.07] text-[#d9a0a2]">
          <span class="select-none text-red/70 mr-2">-</span>
          {l}
        </div>
      ))}
      {newLines.map((l, i) => (
        <div key={`n${i}`} class="px-2 min-w-max bg-success/[0.07] text-[#a8d4b9]">
          <span class="select-none text-success/70 mr-2">+</span>
          {l}
        </div>
      ))}
      {!oldLines.length && !newLines.length && <div class="px-2 py-1 text-fg-3">(empty edit)</div>}
    </div>
  );
}

function Truncated(props: { text: string; maxLines?: number }) {
  const [all, setAll] = useState(false);
  const lines = props.text.split('\n');
  const max = props.maxLines ?? 40;
  const cut = !all && lines.length > max;
  return (
    <div>
      <pre class={PRE}>{cut ? lines.slice(0, max).join('\n') : props.text}</pre>
      {cut && (
        <button class="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3 hover:text-fg-2" onClick={() => setAll(true)}>
          show {lines.length - max} more lines
        </button>
      )}
    </div>
  );
}

function Details(props: { item: ToolItem }) {
  const { item } = props;
  const o = rec(item.input);
  const fam = family(item.name);
  const out = item.output ?? '';
  const outputBlock = out ? (
    <Section label={item.status === 'error' ? 'error' : 'output'} copy={out}>
      <Truncated text={out} maxLines={60} />
    </Section>
  ) : item.status === 'running' ? (
    <div class="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">waiting for output…</div>
  ) : null;

  if (fam === 'shell') {
    const cmd = pick(o, 'command', 'cmd', 'script') ?? '';
    const desc = pick(o, 'description');
    const extra = Object.keys(o).filter((k) => !['command', 'cmd', 'script', 'description'].includes(k));
    return (
      <>
        {desc && <div class="text-[12px] text-fg-2 mb-2">{desc}</div>}
        <Section label="command" copy={cmd}>
          <pre class={`${PRE} text-fg`}>
            <span class="select-none text-fg-3">$ </span>
            {cmd}
          </pre>
        </Section>
        {extra.length > 0 && (
          <div class="mt-1.5 font-mono text-[10px] text-fg-3">{extra.map((k) => `${k}: ${typeof o[k] === 'object' ? json(o[k]) : String(o[k])}`).join(' · ')}</div>
        )}
        {outputBlock}
      </>
    );
  }

  if (fam === 'edit') {
    const path = filePath(o);
    const edits: { old: string; new: string }[] = Array.isArray(o.edits)
      ? (o.edits as unknown[]).map((e) => {
          const r = rec(e);
          return { old: pick(r, 'old_string', 'oldText', 'old_str', 'old') ?? '', new: pick(r, 'new_string', 'newText', 'new_str', 'new') ?? '' };
        })
      : [{ old: pick(o, 'old_string', 'oldText', 'old_str', 'old') ?? '', new: pick(o, 'new_string', 'newText', 'new_str', 'new', 'new_source') ?? '' }];
    const patch = pick(o, 'patch', 'diff');
    return (
      <>
        {path && <div class="font-mono text-[12px] text-fg mb-2 break-all">{path}{o.replace_all ? <span class="text-fg-3"> · replace all</span> : null}</div>}
        {patch ? (
          <Section label="patch" copy={patch}>
            <pre class={PRE}>{patch}</pre>
          </Section>
        ) : (
          edits.map((e, i) => (
            <Section key={i} label={edits.length > 1 ? `edit ${i + 1}/${edits.length}` : 'change'}>
              <Diff oldText={e.old} newText={e.new} />
            </Section>
          ))
        )}
        {outputBlock}
      </>
    );
  }

  if (fam === 'write') {
    const path = filePath(o);
    const content = pick(o, 'content', 'text', 'contents', 'data') ?? '';
    return (
      <>
        {path && (
          <div class="font-mono text-[12px] text-fg mb-2 break-all">
            {path} <span class="text-fg-3">· {content.split('\n').length} lines</span>
          </div>
        )}
        <Section label="content" copy={content}>
          <Truncated text={content} maxLines={40} />
        </Section>
        {outputBlock}
      </>
    );
  }

  if (fam === 'read') {
    const path = filePath(o);
    const range = [pick(o, 'offset'), pick(o, 'limit')].some(Boolean) ? `lines ${pick(o, 'offset') ?? 1}+${pick(o, 'limit') ?? ''}` : '';
    return (
      <>
        <div class="font-mono text-[12px] text-fg mb-2 break-all">
          {path} {range && <span class="text-fg-3">· {range}</span>}
        </div>
        {outputBlock}
      </>
    );
  }

  if (fam === 'todo' && Array.isArray(o.todos)) {
    return (
      <>
        <ul class="space-y-0.5">
          {(o.todos as unknown[]).map((t, i) => {
            const r = rec(t);
            const st = pick(r, 'status') ?? '';
            return (
              <li key={i} class="flex gap-2 text-[12px]">
                <span class="font-mono text-fg-3 w-5 shrink-0">{st === 'completed' ? '[x]' : st === 'in_progress' ? '[~]' : '[ ]'}</span>
                <span class={st === 'completed' ? 'text-fg-3 line-through' : st === 'in_progress' ? 'text-fg' : 'text-fg-2'}>{pick(r, 'content', 'text', 'title') ?? json(t)}</span>
              </li>
            );
          })}
        </ul>
        {outputBlock}
      </>
    );
  }

  const inputJson = json(item.input);
  return (
    <>
      {inputJson && inputJson !== '{}' && (
        <Section label="input" copy={inputJson}>
          <pre class={PRE}>{inputJson}</pre>
        </Section>
      )}
      {outputBlock}
    </>
  );
}

export function ToolCard(props: { item: ToolItem; sessionId?: string | null; defaultOpen?: boolean }) {
  const { item } = props;
  const [open, setOpen] = useState(!!props.defaultOpen);
  const name = displayToolName(item.name);
  const summary = toolSummary(item.name, item.input);
  const pendingApproval = item.status === 'pending-approval';
  const approval = pendingApproval ? findApproval(props.sessionId, item.name, item.input, approvals.value) : undefined;
  const bad = item.status === 'error' || item.status === 'denied';
  const fam = family(item.name);

  return (
    <div
      class={`border bg-[#18181a] rounded-[2px] ${pendingApproval ? 'border-warning/50' : bad ? 'border-red/40' : 'border-line'}`}
      data-tool-status={item.status}
    >
      <button
        class="w-full flex items-center gap-2.5 px-2.5 h-8 text-left hover:bg-white/[0.02] min-w-0"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ChevronRight size={12} strokeWidth={1.5} class={`text-fg-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <StatusDot status={item.status} />
        <span class="font-mono text-[12px] text-fg shrink-0">{name}</span>
        <span class={`font-mono text-[11.5px] truncate min-w-0 flex-1 ${fam === 'shell' ? 'text-fg-2' : 'text-fg-3'}`} title={summary}>
          {fam === 'shell' && summary ? `$ ${summary.split('\n')[0]}` : summary.split('\n')[0]}
        </span>
        {item.risk && item.risk !== 'safe' && (
          <span class="hud-tag shrink-0 hidden sm:inline-flex" data-tone={item.risk === 'dangerous' ? 'red' : 'warn'}>
            {item.risk}
          </span>
        )}
        {bad && <span class="font-mono text-[10px] uppercase tracking-[0.12em] text-red shrink-0">{item.status}</span>}
        {item.status === 'running' && <span class="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3 shrink-0">running</span>}
        {item.durationMs !== undefined && item.status !== 'running' && (
          <span class="font-mono text-[10px] text-fg-3 tabular-nums shrink-0">{fmtDuration(item.durationMs)}</span>
        )}
      </button>
      {pendingApproval && (
        <div class="flex items-center gap-2 px-2.5 pb-2 -mt-0.5 flex-wrap">
          <span class="font-mono text-[10px] uppercase tracking-[0.12em] text-warning">Awaiting approval</span>
          <div class="ml-auto flex gap-1.5">
            {approval ? (
              <>
                <button class="btn btn-xs btn-ghost rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px] text-fg-2" onClick={() => respondApproval(approval.id, false)}>
                  Deny
                </button>
                <button
                  class="btn btn-xs btn-outline rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px] border-line text-fg-2 hover:bg-subtle hover:text-fg"
                  onClick={() => respondApproval(approval.id, true, true)}
                >
                  Always
                </button>
                <button class="btn btn-xs btn-primary rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px]" onClick={() => respondApproval(approval.id, true)}>
                  Approve
                </button>
              </>
            ) : (
              <span class="font-mono text-[10px] text-fg-3">see approval dock</span>
            )}
          </div>
        </div>
      )}
      {open && (
        <div class="px-2.5 pb-2.5 pt-1 border-t border-line">
          <Details item={item} />
        </div>
      )}
    </div>
  );
}
