/** Config → MCP: Model Context Protocol servers whose tools the agent can use (add / import / test / tune risk). */
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { McpServer, McpServerInput, McpToolInfo, McpTransport, ToolRisk } from '@monarch/shared';
import { ChevronRight, Plus, FileJson, RefreshCw, Pencil, Trash2, Play, Plug, X, KeyRound, LogOut } from 'lucide-preact';
import { api, openExternal } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { Panel, Tag, Spinner, Empty, Btn, EmptyState, Skeleton, Glyph } from '../ui.tsx';
import { Modal, useConfirm } from '../mail/kit.tsx';
import { Field, INPUT, SELECT, TEXTAREA, TOGGLE, ToggleRow, SEL_XS } from '../config/fields.tsx';

const RISKS: ToolRisk[] = ['safe', 'sensitive', 'dangerous'];

const STATUS_TONE: Record<McpServer['status'], 'ok' | 'warn' | 'red' | 'plain'> = { connected: 'ok', connecting: 'warn', error: 'red', disabled: 'plain' };

const enc = encodeURIComponent;
const errMsg = (e: any) => e?.message ?? String(e);

function target(s: McpServer): string {
  return s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ') : s.url ?? '';
}

/* ─────────── section ─────────── */

const EXAMPLES: { label: string; hint: string; draft: Partial<Draft> }[] = [
  { label: 'Filesystem', hint: 'read/write files in a folder', draft: { name: 'Filesystem', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-filesystem\n~/Documents' } },
  { label: 'Everything (demo)', hint: 'reference server with sample tools', draft: { name: 'Everything', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-everything', risk: 'safe' } },
  { label: 'Remote (http)', hint: 'a hosted MCP endpoint', draft: { name: 'Remote server', transport: 'http', url: 'https://example.com/mcp', headers: [{ key: 'Authorization', value: '', stored: false }] } },
];

export function McpSection() {
  const [poll, setPoll] = useState(false);
  const res = useResource<McpServer[]>('/mcp/servers', ['mcp'], { intervalMs: poll ? 3000 : undefined });
  const list = res.data ?? [];
  const anyConnecting = list.some((s) => s.status === 'connecting');
  if (anyConnecting !== poll) setPoll(anyConnecting);

  const [open, setOpen] = useState<string | null>(null);
  const [editor, setEditor] = useState<null | { server?: McpServer; preset?: Partial<Draft> }>(null);
  const [importing, setImporting] = useState(false);

  const replace = (s: McpServer) => res.setData(list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]);
  const connected = list.filter((s) => s.status === 'connected').length;
  const tools = list.reduce((n, s) => n + s.tools.filter((t) => t.enabled).length, 0);
  const unavailable = !!res.error && !res.data;

  return (
    <>
      <Panel
        title="MCP servers"
        right={
          <>
            {res.data && (
              <>
                <Tag tone={connected ? 'ok' : 'plain'}>
                  {connected}/{list.length} connected
                </Tag>
                <Tag>{tools} tools</Tag>
              </>
            )}
            <button class="text-fg-3 hover:text-fg-2" title="Refresh" onClick={() => void res.reload()}>
              <RefreshCw size={12} strokeWidth={1.5} class={res.loading ? 'animate-spin' : ''} />
            </button>
          </>
        }
      >
        <div class="flex flex-wrap items-center gap-3">
          <p class="text-[12.5px] text-fg-2 leading-snug flex-1 min-w-[220px]">
            MCP servers are local commands or remote endpoints that give Monarch extra tools. Their tools are deferred behind tool search and follow your approval policy by risk.
          </p>
          <div class="flex gap-2">
            <Btn size="xs" onClick={() => setImporting(true)} disabled={unavailable}>
              <FileJson size={11} /> Import JSON
            </Btn>
            <Btn size="xs" variant="primary" onClick={() => setEditor({})} disabled={unavailable}>
              <Plus size={11} /> Add server
            </Btn>
          </div>
        </div>
      </Panel>

      <Panel title="Servers" noPad>
        {res.loading && !res.data ? (
          <Skeleton lines={3} class="p-4" />
        ) : unavailable ? (
          <Empty>MCP service unavailable</Empty>
        ) : list.length === 0 ? (
          <div class="p-4 flex flex-col gap-3">
            <EmptyState
              class="!py-4"
              icon={<Plug size={18} strokeWidth={1.5} />}
              title="No MCP servers yet"
              hint="Servers give Monarch extra tools. Add one, paste a config you already use, or start from a preset below."
              actions={
                <>
                  <Btn variant="primary" size="sm" onClick={() => setEditor({})}>
                    <Plus size={13} /> Add server
                  </Btn>
                  <Btn size="sm" onClick={() => setImporting(true)}>
                    <FileJson size={13} /> Import JSON
                  </Btn>
                </>
              }
            />
            <div class="hud-label text-[10px]">Quick add</div>
            <div class="grid gap-2 sm:grid-cols-3">
              {EXAMPLES.map((ex) => (
                <button key={ex.label} class="text-left border border-line rounded-[var(--radius-control)] p-3 hover:border-fg-3 hover:bg-subtle/50" onClick={() => setEditor({ preset: ex.draft })}>
                  <div class="flex items-center gap-2 text-[13px] text-fg">
                    <Plug size={12} class="text-fg-3" /> {ex.label}
                  </div>
                  <div class="text-[11.5px] text-fg-3 mt-1">{ex.hint}</div>
                  <div class="font-mono text-[10.5px] text-fg-2 mt-2 truncate">
                    {ex.draft.transport === 'stdio' ? `${ex.draft.command} ${ex.draft.args?.split('\n').join(' ')}` : ex.draft.url}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div class="divide-y divide-line">
            {list.map((s) => (
              <ServerRow
                key={s.id}
                server={s}
                open={open === s.id}
                onToggle={() => setOpen(open === s.id ? null : s.id)}
                onReplace={replace}
                onRemoved={() => res.setData(list.filter((x) => x.id !== s.id))}
                onEdit={() => setEditor({ server: s })}
              />
            ))}
          </div>
        )}
      </Panel>

      {editor && (
        <ServerEditor
          server={editor.server}
          preset={editor.preset}
          onClose={() => setEditor(null)}
          onSaved={(s) => {
            replace(s);
            setOpen(s.id);
            setEditor(null);
          }}
        />
      )}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void res.reload();
          }}
        />
      )}
    </>
  );
}

/* ─────────── one server ─────────── */

function ServerRow(props: { server: McpServer; open: boolean; onToggle: () => void; onReplace: (s: McpServer) => void; onRemoved: () => void; onEdit: () => void }) {
  const s = props.server;
  const [busy, setBusy] = useState<string | null>(null);
  const [showInstr, setShowInstr] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [dialog, confirm] = useConfirm();

  const patch = async (p: Partial<McpServerInput>, key = 'patch') => {
    setBusy(key);
    try {
      props.onReplace(await api.patch<McpServer>(`/mcp/servers/${enc(s.id)}`, p));
    } catch (e) {
      toast(`Update failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const reconnect = async () => {
    setBusy('reconnect');
    try {
      const n = await api.post<McpServer>(`/mcp/servers/${enc(s.id)}/reconnect`, {});
      props.onReplace(n);
      if (n.status === 'error') toast(`${n.name}: ${n.error ?? 'connection failed'}`, 'warn');
    } catch (e) {
      toast(`Reconnect failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const signIn = async () => {
    setBusy('auth');
    try {
      const r = await api.post<{ url: string | null; server: McpServer }>(`/mcp/servers/${enc(s.id)}/auth`, {});
      props.onReplace(r.server);
      if (r.url) {
        setAuthUrl(r.url);
        void openExternal(r.url);
      } else toast(`${s.name}: already authorized`, 'success');
    } catch (e) {
      toast(`Sign-in failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const signOut = async () => {
    if (!(await confirm({ title: `Sign out of ${s.name}?`, body: 'The stored OAuth tokens are forgotten. You can sign in again any time.', confirmLabel: 'Sign out', danger: true }))) return;
    setBusy('auth');
    try {
      props.onReplace(await api.del<McpServer>(`/mcp/servers/${enc(s.id)}/auth`));
    } catch (e) {
      toast(`Sign-out failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Remove ${s.name}?`, body: 'The server is disconnected and its stored env values and headers are forgotten.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api.del(`/mcp/servers/${enc(s.id)}`);
      props.onRemoved();
      toast(`Removed ${s.name}`, 'success');
    } catch (e) {
      toast(`Remove failed: ${errMsg(e)}`, 'error');
    }
  };
  const setToolRisk = (t: McpToolInfo, r: ToolRisk) => {
    const next = { ...s.toolRisks };
    if (r === s.risk) delete next[t.name];
    else next[t.name] = r;
    void patch({ toolRisks: next }, `risk:${t.name}`);
  };
  const setToolEnabled = (t: McpToolInfo, on: boolean) => {
    const set = new Set(s.disabledTools);
    if (on) set.delete(t.name);
    else set.add(t.name);
    void patch({ disabledTools: [...set] }, `tool:${t.name}`);
  };

  const enabledTools = s.tools.filter((t) => t.enabled).length;

  return (
    <div>
      {dialog}
      <div class={`flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-white/[0.02] ${props.open ? 'bg-subtle/50' : ''}`} onClick={props.onToggle}>
        <ChevronRight size={12} class={`text-fg-3 shrink-0 transition-transform ${props.open ? 'rotate-90' : ''}`} />
        <Glyph
          of={3}
          value={s.status === 'connected' ? 3 : s.status === 'connecting' ? 2 : s.status === 'error' ? 3 : 0}
          tone={s.status === 'error' ? 'red' : 'fg'}
          live={s.status === 'connecting'}
          title={s.status}
          class="shrink-0"
        />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[13px] text-fg">{s.name}</span>
            <Tag tone={s.authRequired ? 'warn' : STATUS_TONE[s.status]}>{s.authRequired ? 'sign-in needed' : s.status}</Tag>
            <Tag>{s.transport}</Tag>
            {s.oauth && !s.authRequired && <Tag>oauth</Tag>}
          </div>
          <div class="font-mono text-[11px] text-fg-3 truncate mt-0.5" title={target(s)}>
            {target(s) || '—'}
          </div>
        </div>
        <div class="hidden sm:flex flex-col items-end text-[12px] text-fg-3 shrink-0">
          <span>
            <span class="text-fg-2">{enabledTools}</span>
            {enabledTools !== s.tools.length ? `/${s.tools.length}` : ''} tools
          </span>
          <span>
            <span class="text-fg-2">{s.calls}</span> calls
          </span>
        </div>
        {s.authRequired && s.enabled && (
          <Btn size="xs" variant="primary" class="shrink-0"
            disabled={busy === 'auth'}
            onClick={(e) => {
              e.stopPropagation();
              void signIn();
            }}
          >
            {busy === 'auth' ? <span class="loading loading-spinner loading-xs" /> : <KeyRound size={10} />} Sign in
          </Btn>
        )}
        <input
          type="checkbox"
          class={TOGGLE}
          checked={s.enabled}
          disabled={busy === 'enabled'}
          title={s.enabled ? 'Disable server' : 'Enable server'}
          aria-label={`Enable ${s.name}`}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => void patch({ enabled: (e.target as HTMLInputElement).checked }, 'enabled')}
        />
      </div>

      {authUrl && s.authRequired && (
        <div class="mx-3.5 mb-2.5 flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-line bg-[#121213] px-3 py-2 text-[12px] text-fg-2">
          <span class="flex-1 min-w-[180px]">Finish signing in to {s.name} in your browser. If no tab opened, use the button.</span>
          <Btn size="xs" variant="primary" onClick={() => void openExternal(authUrl)}>
            <KeyRound size={10} /> Open sign-in page
          </Btn>
          <Btn size="xs"
            onClick={() => {
              void navigator.clipboard?.writeText(authUrl).then(
                () => toast('Sign-in link copied', 'success'),
                () => toast('Could not copy the link', 'warn'),
              );
            }}
          >
            Copy link
          </Btn>
          <Btn size="xs" title="Dismiss" onClick={() => setAuthUrl(null)}>
            <X size={10} />
          </Btn>
        </div>
      )}
      {props.open && (
        <div class="px-3.5 pb-4 pt-1 flex flex-col gap-3 bg-subtle/20">
          {s.error && <div class="text-xs font-mono text-red break-words">{s.error}</div>}
          <div class="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-fg-3">
            <span>
              id <span class="text-fg-2">{s.id}</span>
            </span>
            {s.serverInfo && (
              <span>
                server <span class="text-fg-2">{s.serverInfo.name}</span> <span class="text-fg-2">v{s.serverInfo.version}</span>
              </span>
            )}
            {s.cwd && (
              <span>
                cwd <span class="text-fg-2">{s.cwd}</span>
              </span>
            )}
            {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
              <span>
                {s.transport === 'stdio' ? 'env' : 'headers'} <span class="text-fg-2">{(s.transport === 'stdio' ? s.envKeys : s.headerKeys).join(', ')}</span>
              </span>
            )}
          </div>

          {s.instructions && (
            <div>
              <button class="hud-label text-[10px] flex items-center gap-1 hover:text-fg-2" onClick={() => setShowInstr(!showInstr)}>
                <ChevronRight size={10} class={showInstr ? 'rotate-90' : ''} /> Server instructions
              </button>
              {showInstr && <div class="mt-1.5 text-[12px] text-fg-2 whitespace-pre-wrap leading-relaxed border-l border-line pl-3">{s.instructions}</div>}
            </div>
          )}

          <div class="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)] items-start">
            <Field label="Default risk" hint="Applies to tools without an override">
              <select class={SELECT} value={s.risk} disabled={busy === 'risk'} onChange={(e) => void patch({ risk: (e.target as HTMLSelectElement).value as ToolRisk }, 'risk')}>
                {RISKS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <ToggleRow
              label="Load tools in every prompt"
              hint="Off keeps prompts lean: the agent finds these tools through tool search when it needs them."
              checked={s.alwaysLoad}
              disabled={busy === 'alwaysLoad'}
              onChange={(v) => void patch({ alwaysLoad: v }, 'alwaysLoad')}
            />
          </div>

          <div>
            <div class="hud-label text-[10px] mb-1.5">Tools ({s.tools.length})</div>
            {s.tools.length === 0 ? (
              <div class="text-[12px] text-fg-3">{s.status === 'connected' ? 'This server exposes no tools.' : 'Tools appear once the server is connected.'}</div>
            ) : (
              <div class="border border-line rounded-[var(--radius-control)] overflow-x-auto">
                <table class="table table-sm">
                  <thead>
                    <tr class="border-line text-[12px] text-fg-3">
                      <th class="w-8">On</th>
                      <th>Tool</th>
                      <th class="w-32">Risk</th>
                      <th class="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {s.tools.map((t) => (
                      <Fragment key={t.name}>
                        <tr class={`border-line align-top ${t.enabled ? '' : 'opacity-50'}`}>
                          <td>
                            <input
                              type="checkbox"
                              class="checkbox checkbox-xs rounded-[var(--radius-control)] border-line checked:bg-red checked:border-red checked:text-fg"
                              checked={t.enabled}
                              disabled={busy === `tool:${t.name}`}
                              aria-label={`Enable ${t.name}`}
                              onChange={(e) => setToolEnabled(t, (e.target as HTMLInputElement).checked)}
                            />
                          </td>
                          <td class="min-w-0">
                            <div class="font-mono text-[11.5px] text-fg break-all">{t.fullName}</div>
                            {t.description && <div class="text-[11.5px] text-fg-3 leading-snug mt-0.5 line-clamp-2" title={t.description}>{t.description}</div>}
                          </td>
                          <td>
                            <select class={`${SEL_XS} w-full min-w-[7.5rem]`} value={t.risk} disabled={busy === `risk:${t.name}`} onChange={(e) => setToolRisk(t, (e.target as HTMLSelectElement).value as ToolRisk)}>
                              {RISKS.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td class="text-right">
                            <Btn size="xs" disabled={s.status !== 'connected'} onClick={() => setTesting(testing === t.name ? null : t.name)}>
                              <Play size={10} /> Test
                            </Btn>
                          </td>
                        </tr>
                        {testing === t.name && (
                          <tr class="border-line">
                            <td colSpan={4} class="bg-[#121213]/60">
                              <ToolTester serverId={s.id} tool={t} onClose={() => setTesting(null)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {s.logs.length > 0 && (
            <div>
              <button class="hud-label text-[10px] flex items-center gap-1 hover:text-fg-2" onClick={() => setShowLogs(!showLogs)}>
                <ChevronRight size={10} class={showLogs ? 'rotate-90' : ''} /> Stderr ({s.logs.length})
              </button>
              {showLogs && (
                <pre class="mt-1.5 max-h-48 overflow-auto bg-[#121213] border border-line rounded-[var(--radius-control)] p-2 font-mono text-[10.5px] text-fg-2 whitespace-pre-wrap break-all">
                  {s.logs.join('\n')}
                </pre>
              )}
            </div>
          )}

          <div class="flex flex-wrap gap-2 pt-1">
            <Btn size="xs" disabled={!s.enabled || busy === 'reconnect'} onClick={() => void reconnect()}>
              {busy === 'reconnect' ? <span class="loading loading-spinner loading-xs" /> : <RefreshCw size={10} />} Reconnect
            </Btn>
            {s.transport !== 'stdio' && (s.oauth ? (
              <Btn size="xs" disabled={busy === 'auth'} onClick={() => void signOut()}>
                <LogOut size={10} /> Sign out
              </Btn>
            ) : (
              <Btn size="xs" disabled={!s.enabled || busy === 'auth'} onClick={() => void signIn()}>
                {busy === 'auth' ? <span class="loading loading-spinner loading-xs" /> : <KeyRound size={10} />} Sign in
              </Btn>
            ))}
            <Btn size="xs" onClick={props.onEdit}>
              <Pencil size={10} /> Edit
            </Btn>
            <Btn size="xs" class="hover:!text-red hover:!border-red ml-auto" onClick={() => void remove()}>
              <Trash2 size={10} /> Remove
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────── tool tester ─────────── */

function emptyFor(schema: any): unknown {
  if (!schema || typeof schema !== 'object') return '';
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== 'null') : schema.type;
  switch (t) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return schema.properties ? prefill(schema) : {};
    default:
      return '';
  }
}
function prefill(schema: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = schema && typeof schema === 'object' ? schema.properties : undefined;
  if (props && typeof props === 'object') for (const [k, v] of Object.entries(props)) out[k] = emptyFor(v);
  return out;
}

function ToolTester(props: { serverId: string; tool: McpToolInfo; onClose: () => void }) {
  const [args, setArgs] = useState(() => JSON.stringify(prefill(props.tool.inputSchema), null, 2));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<null | { ok: boolean; output: string; durationMs: number }>(null);
  let parseErr: string | undefined;
  try {
    const v = JSON.parse(args || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) parseErr = 'Arguments must be a JSON object';
  } catch (e: any) {
    parseErr = e?.message ?? 'Invalid JSON';
  }
  const required: string[] = Array.isArray((props.tool.inputSchema as any)?.required) ? (props.tool.inputSchema as any).required : [];

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      setResult(await api.post(`/mcp/servers/${enc(props.serverId)}/tools/${enc(props.tool.name)}/test`, { args: JSON.parse(args || '{}') }));
    } catch (e) {
      setResult({ ok: false, output: errMsg(e), durationMs: 0 });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div class="flex flex-col gap-2 py-1">
      <div class="flex items-center gap-2">
        <span class="hud-label text-[10px]">Arguments</span>
        {required.length > 0 && <span class="text-[11px] text-fg-3">required: {required.join(', ')}</span>}
        <button class="ml-auto text-fg-3 hover:text-fg" onClick={props.onClose} aria-label="Close tester">
          <X size={12} />
        </button>
      </div>
      <textarea
        class={`${TEXTAREA} font-mono !text-[11.5px]`}
        rows={Math.min(10, Math.max(3, args.split('\n').length))}
        value={args}
        spellcheck={false}
        onInput={(e) => setArgs((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !parseErr) void run();
        }}
      />
      <div class="flex items-center gap-2">
        {parseErr ? <span class="text-[11px] font-mono text-red flex-1">{parseErr}</span> : <span class="text-[11px] text-fg-3 flex-1">Runs the tool directly, without approval. Ctrl+Enter to run.</span>}
        <Btn size="xs" variant="primary" disabled={!!parseErr || running} onClick={() => void run()}>
          {running ? <span class="loading loading-spinner loading-xs" /> : <Play size={10} />} Run
        </Btn>
      </div>
      {result && (
        <div class="border border-line rounded-[var(--radius-control)]">
          <div class="flex items-center gap-2 px-2 py-1 border-b border-line">
            <Tag tone={result.ok ? 'ok' : 'red'}>{result.ok ? 'ok' : 'error'}</Tag>
            {result.durationMs > 0 && <span class="font-mono text-[10px] text-fg-3">{result.durationMs} ms</span>}
          </div>
          <pre class="max-h-72 overflow-auto p-2 font-mono text-[11px] text-fg-2 whitespace-pre-wrap break-words">{result.output || '(empty)'}</pre>
        </div>
      )}
    </div>
  );
}

/* ─────────── add / edit ─────────── */

type KV = { key: string; value: string; stored: boolean };
interface Draft {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  cwd: string;
  env: KV[];
  url: string;
  headers: KV[];
  risk: ToolRisk;
  enabled: boolean;
}

function toDraft(s?: McpServer, preset?: Partial<Draft>): Draft {
  return {
    name: s?.name ?? '',
    transport: s?.transport ?? 'stdio',
    command: s?.command ?? '',
    args: (s?.args ?? []).join('\n'),
    cwd: s?.cwd ?? '',
    env: (s?.envKeys ?? []).map((key) => ({ key, value: '', stored: true })),
    url: s?.url ?? '',
    headers: (s?.headerKeys ?? []).map((key) => ({ key, value: '', stored: true })),
    risk: s?.risk ?? 'sensitive',
    enabled: s?.enabled ?? true,
    ...preset,
  };
}

function kvToRecord(rows: KV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value;
  return out;
}

function ServerEditor(props: { server?: McpServer; preset?: Partial<Draft>; onClose: () => void; onSaved: (s: McpServer) => void }) {
  const editing = !!props.server;
  const [d, setD] = useState<Draft>(() => toDraft(props.server, props.preset));
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  const errors: Partial<Record<'name' | 'command' | 'url' | 'env' | 'headers', string>> = {};
  if (!d.name.trim()) errors.name = 'Name is required';
  if (d.transport === 'stdio') {
    if (!d.command.trim()) errors.command = 'Command is required';
    else if (/\s/.test(d.command.trim())) errors.command = 'Only the executable here; put arguments below, one per line';
  } else {
    try {
      const u = new URL(d.url.trim());
      if (!/^https?:$/.test(u.protocol)) errors.url = 'URL must start with http:// or https://';
    } catch {
      errors.url = 'Enter a valid URL';
    }
  }
  const dupes = (rows: KV[]) => {
    const keys = rows.map((r) => r.key.trim()).filter(Boolean);
    return keys.length !== new Set(keys).size ? 'Duplicate names' : rows.some((r) => !r.key.trim() && r.value) ? 'A value has no name' : undefined;
  };
  if (d.transport === 'stdio') errors.env = dupes(d.env);
  else errors.headers = dupes(d.headers);
  const valid = !Object.values(errors).some(Boolean);
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);

  const save = async () => {
    setTried(true);
    if (!valid) return;
    const body: McpServerInput = { name: d.name.trim(), transport: d.transport, risk: d.risk, enabled: d.enabled };
    if (d.transport === 'stdio') {
      body.command = d.command.trim();
      body.args = d.args.split('\n').map((a) => a.trim()).filter(Boolean);
      body.cwd = d.cwd.trim() || undefined;
      body.env = kvToRecord(d.env);
    } else {
      body.url = d.url.trim();
      body.headers = kvToRecord(d.headers);
    }
    setSaving(true);
    try {
      const s = editing ? await api.patch<McpServer>(`/mcp/servers/${enc(props.server!.id)}`, body) : await api.post<McpServer>('/mcp/servers', body);
      toast(editing ? `Saved ${s.name}` : `Added ${s.name}`, 'success');
      props.onSaved(s);
    } catch (e) {
      toast(`Save failed: ${errMsg(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={props.onClose}
      title={editing ? `Edit ${props.server!.name}` : 'Add MCP server'}
      width="max-w-xl"
      footer={
        <>
          <Btn variant="ghost" onClick={props.onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" loading={saving} onClick={() => void save()}>
            {editing ? 'Save' : 'Add server'}
          </Btn>
        </>
      }
    >
      <form
        class="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" hint={editing ? undefined : 'The id (used in tool names) is derived from it.'}>
          <input class={INPUT} value={d.name} placeholder="e.g. Filesystem" onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
          <FieldErr text={show('name')} />
        </Field>

        <Field label="Transport">
          <div class="flex border border-line rounded-[var(--radius-control)] w-fit" role="radiogroup">
            {(['stdio', 'http', 'sse'] as McpTransport[]).map((t) => (
              <button
                type="button"
                key={t}
                role="radio"
                aria-checked={d.transport === t}
                class={`px-3 py-1 text-[12px] border-r border-line last:border-r-0 ${d.transport === t ? 'bg-subtle text-fg' : 'text-fg-3 hover:text-fg-2'}`}
                onClick={() => set({ transport: t })}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        {d.transport === 'stdio' ? (
          <>
            <Field label="Command" hint="Executable on your PATH, e.g. npx, uvx, docker, node">
              <input class={`${INPUT} font-mono`} value={d.command} placeholder="npx" onInput={(e) => set({ command: (e.target as HTMLInputElement).value })} />
              <FieldErr text={show('command')} />
            </Field>
            <Field label="Arguments" hint="One per line">
              <textarea
                class={`${TEXTAREA} font-mono !text-[12px]`}
                rows={Math.min(8, Math.max(3, d.args.split('\n').length + 1))}
                value={d.args}
                spellcheck={false}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n~/Documents'}
                onInput={(e) => set({ args: (e.target as HTMLTextAreaElement).value })}
              />
            </Field>
            <Field label="Working directory (optional)">
              <input class={`${INPUT} font-mono`} value={d.cwd} placeholder="~" onInput={(e) => set({ cwd: (e.target as HTMLInputElement).value })} />
            </Field>
            <KVRows label="Environment" addLabel="Add variable" keyPlaceholder="API_KEY" rows={d.env} onChange={(env) => set({ env })} error={show('env')} />
          </>
        ) : (
          <>
            <Field label="URL" hint={d.transport === 'sse' ? 'Legacy SSE endpoint, usually ending in /sse' : 'Streamable HTTP endpoint, usually ending in /mcp'}>
              <input class={`${INPUT} font-mono`} value={d.url} placeholder="https://example.com/mcp" onInput={(e) => set({ url: (e.target as HTMLInputElement).value })} />
              <FieldErr text={show('url')} />
            </Field>
            <KVRows label="Headers" addLabel="Add header" keyPlaceholder="Authorization" rows={d.headers} onChange={(headers) => set({ headers })} error={show('headers')} />
          </>
        )}

        <div class="grid gap-3 sm:grid-cols-2 items-end">
          <Field label="Default risk" hint="Sensitive and dangerous tools ask for approval per your policy">
            <select class={SELECT} value={d.risk} onChange={(e) => set({ risk: (e.target as HTMLSelectElement).value as ToolRisk })}>
              {RISKS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <ToggleRow label="Enabled" hint="Connect now and offer its tools" checked={d.enabled} onChange={(enabled) => set({ enabled })} />
        </div>
        <button type="submit" class="hidden" />
      </form>
    </Modal>
  );
}

function FieldErr(props: { text?: string }) {
  return props.text ? <div class="text-[11.5px] font-mono text-red">{props.text}</div> : null;
}

function KVRows(props: { label: string; addLabel: string; keyPlaceholder: string; rows: KV[]; onChange: (rows: KV[]) => void; error?: string }) {
  const upd = (i: number, p: Partial<KV>) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Field label={props.label} hint={props.rows.some((r) => r.stored) ? 'Values are secret and never shown. Leave a stored value empty to keep it.' : 'Values are stored as secrets and never shown again.'}>
      <div class="flex flex-col gap-1.5">
        {props.rows.map((r, i) => (
          <div key={i} class="flex gap-1.5 items-center">
            <input
              class={`${INPUT} font-mono !w-[40%]`}
              value={r.key}
              placeholder={props.keyPlaceholder}
              readOnly={r.stored}
              title={r.stored ? 'Stored — remove the row to delete it' : undefined}
              onInput={(e) => upd(i, { key: (e.target as HTMLInputElement).value })}
            />
            <input
              class={`${INPUT} font-mono flex-1`}
              type="password"
              autocomplete="new-password"
              value={r.value}
              placeholder={r.stored ? '•••• stored — leave empty to keep' : 'value'}
              onInput={(e) => upd(i, { value: (e.target as HTMLInputElement).value })}
            />
            <button type="button" class="text-fg-3 hover:text-red p-1" aria-label="Remove row" onClick={() => props.onChange(props.rows.filter((_, j) => j !== i))}>
              <X size={12} />
            </button>
          </div>
        ))}
        <Btn type="button" size="xs" class="w-fit" onClick={() => props.onChange([...props.rows, { key: '', value: '', stored: false }])}>
          <Plus size={10} /> {props.addLabel}
        </Btn>
        <FieldErr text={props.error} />
      </div>
    </Field>
  );
}

/* ─────────── import ─────────── */

const IMPORT_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}`;

function ImportModal(props: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  let err: string | undefined;
  if (text.trim()) {
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) err = 'Expected a JSON object';
    } catch (e: any) {
      err = e?.message ?? 'Invalid JSON';
    }
  }
  const run = async () => {
    setBusy(true);
    try {
      const out = await api.post<McpServer[]>('/mcp/import', { json: text });
      const n = Array.isArray(out) ? out.length : 0;
      toast(`Imported ${n} server${n === 1 ? '' : 's'}`, n ? 'success' : 'warn');
      props.onDone();
    } catch (e) {
      toast(`Import failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={props.onClose}
      title="Import MCP servers"
      width="max-w-xl"
      footer={
        <>
          <Btn variant="ghost" onClick={props.onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" loading={busy} disabled={!text.trim() || !!err} onClick={() => void run()}>
            Import
          </Btn>
        </>
      }
    >
      <div class="flex flex-col gap-2">
        <p class="text-[12.5px] text-fg-2 leading-snug">
          Paste an <code class="font-mono text-[11.5px]">mcpServers</code> block from Claude Desktop, Claude Code or Cursor. Env values and headers are stored as secrets.
        </p>
        <textarea
          class={`${TEXTAREA} font-mono !text-[11.5px]`}
          rows={14}
          spellcheck={false}
          value={text}
          placeholder={IMPORT_EXAMPLE}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
        <FieldErr text={err} />
      </div>
    </Modal>
  );
}
