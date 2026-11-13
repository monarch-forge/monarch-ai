/** Engine contract: run one turn for a session and emit normalized events. */
import type { AgentPhase, EngineId, ToolRisk, Usage } from '@monarch/shared';
import type { SessionRecord } from '../sessions.ts';

export type EngineEvent =
  /** assistant text delta (orchestrator opens a streaming assistant item lazily) */
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  /** the current assistant message ended; the next text opens a new item */
  | { type: 'assistant-end' }
  /** resolved model id for the assistant items that follow */
  | { type: 'model'; model: string }
  /** a tool call appeared (idempotent: re-emitting updates the input) */
  | { type: 'tool-start'; callId: string; name: string; input: unknown; risk?: ToolRisk }
  | { type: 'tool-running'; callId: string }
  | { type: 'tool-end'; callId: string; ok: boolean; output: string; durationMs?: number }
  | { type: 'phase'; phase: AgentPhase; detail?: string };

export interface ApprovalAsk {
  callId: string;
  name: string;
  input: unknown;
  risk: ToolRisk;
  summary: string;
}

export interface TurnContext {
  session: SessionRecord;
  text: string;
  systemPrompt: string;
  /** effective working directory (coding: session cwd; otherwise default workspace) */
  cwd: string;
  signal: AbortSignal;
  emit(ev: EngineEvent): void;
  /** approval gate; updates the tool item status (pending-approval → running | denied) */
  approve(ask: ApprovalAsk): Promise<boolean>;
  /** tool progress text (shown in the tool card) */
  progress(callId: string | undefined, toolName: string, text: string): void;
  /** persist engine-private state changes */
  save(): void;
}

export interface TurnResult {
  usage: Usage;
  /** per-model split for usage accounting (recordUsage) */
  byModel?: Record<string, Usage>;
  model?: string;
  error?: string;
}

export interface Engine {
  id: EngineId;
  runTurn(ctx: TurnContext): Promise<TurnResult>;
  /** drop in-memory state for a session (deleted / settings changed) */
  dispose?(sessionId: string): void;
}
