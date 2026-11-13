/**
 * pi engine: pi-agent-core `Agent` over the shared pi-ai `Models` collection (any provider).
 *
 * One Agent per session is kept in memory. Its transcript (pi's own AgentMessage[] minus system
 * messages) is persisted in the session file after every turn (`engineState.piMessages`) and used to
 * rebuild the Agent after a restart, so tool calls/results and thinking survive exactly.
 * The system prompt is set when the Agent is (re)built and then kept stable for prompt caching.
 * Auth: resolved by pi-ai through our secrets-backed CredentialStore (OAuth → stored key → env),
 * see pi-models.ts — no `getApiKey` hook needed.
 */
import { z } from 'zod';
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import { clampThinkingLevel, cleanupSessionResources, type Api, type Model, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { Usage } from '@monarch/shared';
import { truncate, type ToolDef } from '../../kernel.ts';
import { getSettings } from '../../settings.ts';
import { emptyUsage, addUsage } from '../sessions.ts';
import { errorText, piToolDefs, runToolDef, toolSummary } from '../toolset.ts';
import { piModels, resolvePiModel } from '../pi-models.ts';
import type { Engine, TurnContext, TurnResult } from './types.ts';

interface TurnState {
  ctx: TurnContext;
  usage: Usage;
  byModel: Record<string, Usage>;
  model?: string;
  error?: string;
}

interface Entry {
  agent: Agent;
  turn: TurnState | null;
}

const agents = new Map<string, Entry>();

/** JSON schema for a ToolDef's zod schema, as plain JSON (pi validates plain JSON Schema) */
function jsonSchema(def: ToolDef): Record<string, unknown> {
  const js = z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== 'object') return { type: 'object', properties: {}, ...js };
  return js;
}

function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof result === 'string') return result;
  return result == null ? '' : JSON.stringify(result);
}

function toolsFor(entry: Entry, sessionId: string, kind: TurnContext['session']['kind']): AgentTool<any>[] {
  return piToolDefs(kind).map(
    (def): AgentTool<any> => ({
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: jsonSchema(def),
      executionMode: 'sequential',
      async execute(toolCallId, params, signal) {
        const turn = entry.turn;
        if (!turn) throw new Error('No active turn');
        const ok = await turn.ctx.approve({
          callId: toolCallId,
          name: def.name,
          input: params,
          risk: def.risk,
          summary: toolSummary(def, params),
        });
        if (!ok) throw new Error('The user declined this action. Do not retry it; ask how to proceed instead.');
        const text = await runToolDef(def, params, {
          sessionId,
          cwd: turn.ctx.cwd,
          signal: signal ?? turn.ctx.signal,
          progress: (t) => turn.ctx.progress(toolCallId, def.name, t),
        });
        return { content: [{ type: 'text', text }], details: {} };
      },
    }),
  );
}

function onEvent(entry: Entry, ev: AgentEvent): void {
  const turn = entry.turn;
  if (!turn) return;
  const emit = turn.ctx.emit;
  switch (ev.type) {
    case 'message_update': {
      const a = ev.assistantMessageEvent;
      if (a.type === 'text_delta' && a.delta) emit({ type: 'text', delta: a.delta });
      else if (a.type === 'thinking_delta' && a.delta) emit({ type: 'thinking', delta: a.delta });
      break;
    }
    case 'message_end': {
      const m = ev.message as AgentMessage;
      if ((m as any).role !== 'assistant') break;
      const am = m as Extract<AgentMessage, { role: 'assistant' }>;
      if (am.model) {
        turn.model = am.model;
        emit({ type: 'model', model: am.model });
      }
      const u = am.usage;
      if (u) {
        const usage: Usage = {
          inputTokens: u.input || 0,
          outputTokens: u.output || 0,
          cacheReadTokens: u.cacheRead || 0,
          cacheWriteTokens: u.cacheWrite || 0,
          costUsd: u.cost?.total || 0,
        };
        turn.usage = addUsage(turn.usage, usage);
        const key = am.model || 'unknown';
        turn.byModel[key] = addUsage(turn.byModel[key] ?? emptyUsage(), usage);
      }
      if (am.stopReason === 'error' || am.stopReason === 'aborted') turn.error = am.errorMessage || am.stopReason;
      emit({ type: 'assistant-end' });
      break;
    }
    case 'tool_execution_start': {
      const def = piToolDefs(turn.ctx.session.kind).find((d) => d.name === ev.toolName);
      emit({ type: 'tool-start', callId: ev.toolCallId, name: ev.toolName, input: ev.args, risk: def?.risk });
      break;
    }
    case 'tool_execution_end': {
      emit({
        type: 'tool-end',
        callId: ev.toolCallId,
        ok: !ev.isError,
        output: truncate(resultText(ev.result), 8000),
        durationMs: ev.durationMs,
      });
      break;
    }
    default:
      break;
  }
}

function thinkingFor(model: Model<Api>): ModelThinkingLevel {
  const level = getSettings().pi.thinkingLevel;
  if (!model.reasoning || level === 'off') return 'off';
  try {
    return clampThinkingLevel(model, level);
  } catch {
    return 'off';
  }
}

export const piEngine: Engine = {
  id: 'pi',
  async runTurn(ctx: TurnContext): Promise<TurnResult> {
    const settings = getSettings().pi;
    const rec = ctx.session;
    const providerId = rec.engineState.piProvider || settings.provider;
    const modelSpec = rec.model || settings.model;
    const { provider, model } = resolvePiModel(providerId, modelSpec);
    if (!model) {
      return { usage: emptyUsage(), error: `Unknown model "${modelSpec}" for provider "${providerId}". Pick a model in Config.` };
    }
    if (provider !== rec.engineState.piProvider) {
      rec.engineState.piProvider = provider;
      ctx.save();
    }

    const models = piModels();
    try {
      const auth = await models.checkAuth(provider);
      if (!auth) {
        return {
          usage: emptyUsage(),
          model: model.id,
          error: `No credentials for provider "${provider}". Add an API key or sign in under Config → Providers.`,
        };
      }
    } catch (e) {
      return { usage: emptyUsage(), model: model.id, error: `Credential check failed for "${provider}": ${errorText(e)}` };
    }

    let entry = agents.get(rec.id);
    if (!entry) {
      const fresh: Entry = { agent: null as unknown as Agent, turn: null };
      const restored = (rec.engineState.piMessages ?? []) as AgentMessage[];
      fresh.agent = new Agent({
        initialState: {
          systemPrompt: ctx.systemPrompt,
          model,
          thinkingLevel: thinkingFor(model),
          tools: toolsFor(fresh, rec.id, rec.kind),
          messages: restored,
        },
        streamFn: (m, c, o) => models.streamSimple(m, c, o),
        sessionId: rec.id,
        toolExecution: 'sequential',
        identity: { attribution: null, userAgent: 'short' },
      });
      fresh.agent.subscribe((ev) => onEvent(fresh, ev));
      agents.set(rec.id, fresh);
      entry = fresh;
    } else {
      entry.agent.state.model = model;
      entry.agent.state.thinkingLevel = thinkingFor(model);
      entry.agent.state.tools = toolsFor(entry, rec.id, rec.kind);
    }

    if (entry.agent.state.isStreaming) {
      return { usage: emptyUsage(), model: model.id, error: 'This session is still busy.' };
    }

    const turn: TurnState = { ctx, usage: emptyUsage(), byModel: {}, model: model.id };
    entry.turn = turn;
    ctx.emit({ type: 'model', model: model.id });

    const agent = entry.agent;
    const onAbort = () => agent.abort();
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await agent.prompt(ctx.text);
    } catch (e) {
      turn.error = turn.error ?? errorText(e);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      entry.turn = null;
      rec.engineState.piMessages = agent.state.messages.filter((m) => (m as any).role !== 'system');
      ctx.save();
    }

    if (ctx.signal.aborted) return { usage: turn.usage, byModel: turn.byModel, model: turn.model, error: 'aborted' };
    return { usage: turn.usage, byModel: turn.byModel, model: turn.model, error: turn.error };
  },
  dispose(sessionId: string) {
    const e = agents.get(sessionId);
    if (!e) return;
    try {
      e.agent.abort();
    } catch {
      /* ignore */
    }
    agents.delete(sessionId);
    try {
      cleanupSessionResources(sessionId);
    } catch {
      /* ignore */
    }
  },
};

/** forget all cached agents (e.g. after provider/model settings changed) */
export function resetPiAgents(): void {
  for (const id of [...agents.keys()]) if (!agents.get(id)?.turn) piEngine.dispose!(id);
}
