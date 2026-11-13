/**
 * claude-sdk engine: runs each turn as one Claude Code process (Claude Agent SDK `query()` in
 * streaming-input mode with a single user message), resuming the stored Claude Code session id
 * on follow-up turns. Uses the user's Claude subscription login unless settings say otherwise.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Usage } from '@monarch/shared';
import { truncate, type ToolDef } from '../../kernel.ts';
import { getSettings } from '../../settings.ts';
import { cacheSupportedModels, claudeEnv, hasFreshSdkModels, invalidateClaudeStatus, resolveClaudeExecutable } from '../claude.ts';
import { emptyUsage, addUsage } from '../sessions.ts';
import {
  SDK_CHAT_BUILTINS,
  SDK_CODING_BUILTINS,
  builtinRisk,
  builtinSummary,
  errorText,
  runToolDef,
  sdkToolDefs,
  toolSummary,
} from '../toolset.ts';
import type { Engine, TurnContext, TurnResult } from './types.ts';

const MCP_KEY = 'monarch';
const MCP_PREFIX = `mcp__${MCP_KEY}__`;

const displayName = (name: string) => (name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name);

function usableDir(p: string | undefined): string {
  try {
    if (p && existsSync(p) && statSync(p).isDirectory()) return p;
  } catch {
    /* fall through */
  }
  return homedir();
}

function toolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function usageFromModel(m: any): Usage {
  return {
    inputTokens: m?.inputTokens ?? 0,
    outputTokens: m?.outputTokens ?? 0,
    cacheReadTokens: m?.cacheReadInputTokens ?? 0,
    cacheWriteTokens: m?.cacheCreationInputTokens ?? 0,
    costUsd: m?.costUSD ?? 0,
  };
}

export const claudeSdkEngine: Engine = {
  id: 'claude-sdk',
  async runTurn(ctx: TurnContext): Promise<TurnResult> {
    const first = await runOnce(ctx, true);
    // resumable session vanished (e.g. Claude Code history cleaned) → start fresh once
    if (first.resumeFailed) {
      ctx.session.engineState.sdkSessionId = undefined;
      ctx.save();
      return runOnce(ctx, false);
    }
    return first;
  },
};

async function runOnce(ctx: TurnContext, allowResume: boolean): Promise<TurnResult & { resumeFailed?: boolean }> {
  const settings = getSettings();
  const rec = ctx.session;
  const coding = rec.kind === 'coding';
  const exe = resolveClaudeExecutable();
  const defs = sdkToolDefs();
  const defByName = new Map<string, ToolDef>(defs.map((d) => [d.name, d]));

  // MCP handlers don't receive the tool_use id; match them FIFO per tool name.
  const mcpQueue = new Map<string, string[]>();
  const takeCallId = (name: string) => mcpQueue.get(name)?.shift();

  const abort = new AbortController();
  let finishInput!: () => void;
  const inputDone = new Promise<void>((r) => (finishInput = r));
  const input: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'user', message: { role: 'user', content: ctx.text }, parent_tool_use_id: null };
      await inputDone;
    },
  };

  let mcpServer: McpSdkServerConfigWithInstance | undefined;
  if (defs.length) {
    mcpServer = createSdkMcpServer({
      name: MCP_KEY,
      version: '0.1.0',
      alwaysLoad: true,
      tools: defs.map((def) =>
        tool(
          def.name,
          def.description,
          def.schema.shape,
          async (args: Record<string, unknown>) => {
            const callId = takeCallId(def.name);
            try {
              const text = await runToolDef(def, args, {
                sessionId: rec.id,
                cwd: ctx.cwd,
                signal: ctx.signal,
                progress: (t) => ctx.progress(callId, def.name, t),
              });
              return { content: [{ type: 'text' as const, text }] };
            } catch (e) {
              return { content: [{ type: 'text' as const, text: errorText(e) }], isError: true };
            }
          },
          { annotations: { readOnlyHint: def.risk === 'safe', destructiveHint: def.risk === 'dangerous' } },
        ),
      ),
    });
  }

  /**
   * Monarch's approval policy is authoritative. Claude Code's own `default` mode silently allows
   * calls it considers read-only (e.g. `Bash(echo …)`), which would bypass canUseTool, so the
   * decision is made in a PreToolUse hook for every call; canUseTool remains as a fallback.
   * Each call id is decided once (hook and canUseTool may both fire).
   */
  const decisions = new Map<string, Promise<boolean>>();
  const gate = (toolName: string, toolInput: Record<string, unknown>, callId: string): Promise<boolean> => {
    const prev = decisions.get(callId);
    if (prev) return prev;
    const name = displayName(toolName);
    const def = defByName.get(name);
    const risk = def ? def.risk : builtinRisk(toolName);
    const summary = def ? toolSummary(def, toolInput) : builtinSummary(toolName, toolInput);
    ctx.emit({ type: 'tool-start', callId, name, input: toolInput, risk });
    const p = ctx.approve({ callId, name, input: toolInput, risk, summary });
    decisions.set(callId, p);
    return p;
  };
  const DENY_MSG = 'The user declined this action. Do not retry it; ask how to proceed instead.';

  const canUseTool: CanUseTool = async (toolName, toolInput, opts) => {
    const ok = await gate(toolName, toolInput, opts.toolUseID);
    return ok ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: DENY_MSG };
  };

  const preToolUse: HookCallback = async (hookInput, toolUseID) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const callId = hookInput.tool_use_id || toolUseID || '';
    const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
    const ok = await gate(hookInput.tool_name, toolInput, callId);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: ok ? 'allow' : 'deny',
        permissionDecisionReason: ok ? 'Approved by Monarch policy' : DENY_MSG,
      },
    };
  };

  const resume = allowResume ? rec.engineState.sdkSessionId : undefined;
  const cwd = usableDir(resume ? (rec.engineState.sdkCwd ?? ctx.cwd) : ctx.cwd);
  let stderrTail = '';

  const options: Options = {
    model: rec.model || settings.claudeSdk.model,
    effort: settings.claudeSdk.effort,
    cwd,
    pathToClaudeCodeExecutable: exe.forSdk,
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'default',
    includePartialMessages: true,
    env: claudeEnv(),
    abortController: abort,
    maxTurns: coding ? 200 : 40,
    tools: coding ? SDK_CODING_BUILTINS : SDK_CHAT_BUILTINS,
    systemPrompt: coding ? { type: 'preset', preset: 'claude_code', append: ctx.systemPrompt } : ctx.systemPrompt,
    mcpServers: mcpServer ? { [MCP_KEY]: mcpServer } : {},
    canUseTool,
    // approvals can wait on the user for a long time; a failing hook blocks the call
    hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: 24 * 3600, onFailure: 'block' }] },
    resume,
    stderr: (d: string) => {
      stderrTail = (stderrTail + d).slice(-2000);
    },
  };

  const q = query({ prompt: input, options });

  const onAbort = () => {
    q.interrupt().catch(() => {});
    finishInput();
    setTimeout(() => abort.abort(), 3000).unref?.();
  };
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener('abort', onAbort, { once: true });

  let usage: Usage = emptyUsage();
  let byModel: Record<string, Usage> | undefined;
  let model: string | undefined;
  let error: string | undefined;
  let assistantError: string | undefined;
  let gotResult = false;
  let curMsgId: string | undefined;
  const streamed = new Set<string>();

  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      switch (m.type) {
        case 'system': {
          if (m.subtype === 'init') {
            if (m.session_id && m.session_id !== rec.engineState.sdkSessionId) {
              rec.engineState.sdkSessionId = m.session_id;
              rec.engineState.sdkCwd = cwd;
              ctx.save();
            }
            model = m.model;
            ctx.emit({ type: 'model', model: m.model });
            if (!hasFreshSdkModels()) q.supportedModels().then(cacheSupportedModels).catch(() => {});
          }
          break;
        }
        case 'stream_event': {
          if (m.parent_tool_use_id) break; // subagent internals
          const ev: any = m.event;
          if (ev.type === 'message_start') {
            curMsgId = ev.message?.id;
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text) {
              if (curMsgId) streamed.add(curMsgId);
              ctx.emit({ type: 'text', delta: ev.delta.text });
            } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              if (curMsgId) streamed.add(curMsgId);
              ctx.emit({ type: 'thinking', delta: ev.delta.thinking });
            }
          }
          break;
        }
        case 'assistant': {
          if (m.parent_tool_use_id) break;
          if (m.error) assistantError = String(m.error);
          const msgId: string | undefined = (m.message as any)?.id;
          for (const b of (m.message?.content ?? []) as any[]) {
            if (b.type === 'text' && b.text && !(msgId && streamed.has(msgId))) {
              ctx.emit({ type: 'text', delta: b.text });
            } else if (b.type === 'thinking' && b.thinking && !(msgId && streamed.has(msgId))) {
              ctx.emit({ type: 'thinking', delta: b.thinking });
            } else if (b.type === 'tool_use') {
              ctx.emit({ type: 'assistant-end' });
              const name = displayName(b.name);
              const def = defByName.get(name);
              if (def) {
                const list = mcpQueue.get(name) ?? [];
                list.push(b.id);
                mcpQueue.set(name, list);
              }
              ctx.emit({
                type: 'tool-start',
                callId: b.id,
                name,
                input: b.input,
                risk: def ? def.risk : builtinRisk(b.name),
              });
            }
          }
          break;
        }
        case 'user': {
          if (m.parent_tool_use_id) break;
          const content = (m.message as any)?.content;
          if (!Array.isArray(content)) break;
          for (const b of content) {
            if (b?.type !== 'tool_result') continue;
            ctx.emit({
              type: 'tool-end',
              callId: b.tool_use_id,
              ok: !b.is_error,
              output: truncate(toolResultOutput(b.content), 8000),
            });
          }
          break;
        }
        case 'result': {
          gotResult = true;
          const mu = (m as any).modelUsage as Record<string, unknown> | undefined;
          if (mu && Object.keys(mu).length) {
            byModel = {};
            for (const [k, v] of Object.entries(mu)) {
              const u = usageFromModel(v);
              byModel[k] = u;
              usage = addUsage(usage, u);
            }
          } else {
            const u: any = m.usage ?? {};
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
              costUsd: m.total_cost_usd ?? 0,
            };
          }
          if (typeof m.total_cost_usd === 'number') usage.costUsd = m.total_cost_usd;
          if (m.subtype === 'success') {
            if (m.is_error) error = m.result || assistantError || 'Claude Code reported an error';
          } else {
            error = (m as any).errors?.join('; ') || m.subtype;
          }
          finishInput();
          break;
        }
        default:
          break;
      }
    }
  } catch (e) {
    if (!gotResult || !error) error = error ?? errorText(e);
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    finishInput();
  }

  if (ctx.signal.aborted) return { usage, byModel, model, error: 'aborted' };
  if (!gotResult && !error) error = stderrTail.trim().split('\n').slice(-3).join(' ') || 'Claude Code exited without a result';
  if (error && resume && /no conversation found/i.test(error + stderrTail)) {
    return { usage, byModel, model, error, resumeFailed: true };
  }
  if (error && (assistantError === 'authentication_failed' || /not logged in|\/login/i.test(error))) {
    invalidateClaudeStatus();
    error = `${error} — run \`claude auth login\` in a terminal (or switch Claude to API-key mode in Config).`;
  }
  return { usage, byModel, model, error };
}
