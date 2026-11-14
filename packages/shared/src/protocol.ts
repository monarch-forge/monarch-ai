/**
 * Monarch AI — shared wire protocol between `apps/core` (Node backend) and `apps/ui` (Preact/Tauri).
 *
 * Transport:
 *  - REST:      http://127.0.0.1:7717/api/*   (JSON in / JSON out, errors => { error: string } + non-2xx)
 *  - WebSocket: ws://127.0.0.1:7717/ws        (JSON frames: ServerEvent from core, ClientCommand from UI)
 *
 * This file is the single source of truth. Both sides import from "@monarch/shared".
 * Keep it dependency-free and type-only (plus a few constants).
 */

export const CORE_PORT = 7717;
export const CORE_HOST = '127.0.0.1';
export const PROTOCOL_VERSION = 1;

/* ────────────────────────────── primitives ────────────────────────────── */

export type ISODate = string; // ISO-8601 timestamp
export type ID = string;

export type EngineId = 'claude-sdk' | 'pi';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';
export type PermissionMode = 'ask' | 'auto-safe' | 'auto-all';
export type ToolRisk = 'safe' | 'sensitive' | 'dangerous';

/** Agent orb / core visualization state. */
export type AgentPhase = 'idle' | 'thinking' | 'tool' | 'responding' | 'awaiting-approval' | 'error';

/* ────────────────────────────── settings ────────────────────────────── */

export interface GeoLocation {
  name: string; // "Malibu, CA"
  lat: number;
  lon: number;
  timezone?: string;
}

export interface CustomModel {
  /** id used in requests, e.g. "llama3.1:8b" */
  id: string;
  name: string;
  /** per-model base URL override ('' = the provider's base URL) */
  baseUrl: string;
  /** optional API key (stored server side) */
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/** an OpenAI-compatible endpoint the user added (several allowed); its API key lives in secrets under its id */
export interface CustomProvider {
  /** provider id used in model specs ("<id>/<model>"): "custom" or "custom-<slug>" */
  id: string;
  name: string;
  /** e.g. https://api.together.xyz/v1 or http://localhost:11434/v1 */
  baseUrl: string;
  models: CustomModel[];
}

export interface Settings {
  user: {
    name: string; // "Tony"
    honorific: string; // "sir" — how Monarch addresses the user
    location: GeoLocation | null;
    units: 'metric' | 'imperial';
  };
  assistant: {
    name: string; // "Monarch"
    /** extra persona / standing instructions appended to the system prompt */
    persona: string;
    voice: { speak: boolean; listen: boolean; voiceName?: string; rate: number };
  };
  /** which model loop runs chats by default */
  engine: EngineId;
  claudeSdk: {
    /** model alias or full id: "opus" | "sonnet" | "haiku" | "claude-opus-5-5" ... */
    model: string;
    /** absolute path to the `claude` executable; empty = auto-detect */
    executablePath: string;
    /** true = rely on Claude Code subscription login (OAuth). false = use stored ANTHROPIC_API_KEY. */
    useSubscription: boolean;
    effort: 'low' | 'medium' | 'high' | 'max';
  };
  pi: {
    provider: string; // pi-ai provider id, e.g. "anthropic", "openai", "google", "openrouter", "custom"
    model: string; // pi-ai model id
    thinkingLevel: ThinkingLevel;
    /** OpenAI-compatible providers added by the user */
    customProviders: CustomProvider[];
    /** @deprecated pre-0.3.2 single custom provider; migrated into customProviders on startup */
    customModels?: CustomModel[];
    /** @deprecated see customModels */
    customBaseUrl?: string;
  };
  permissions: {
    mode: PermissionMode; // ask = approve sensitive+dangerous; auto-safe = approve dangerous only; auto-all = never ask
  };
  coding: {
    /** default working directory for coding sessions */
    defaultWorkspace: string;
    /** remembered workspaces shown in Workshop */
    workspaces: string[];
  };
  memory: {
    /** Obsidian-compatible vault directory with markdown notes */
    vaultDir: string;
  };
  /** self-evolution: extensions, skills, reflection, deferred tools */
  evolution: {
    /** the agent may write/modify its own extensions and skills (still approval-gated by risk) */
    enabled: boolean;
    /** extensions the agent writes are enabled immediately (false = they wait for the user in Evolve) */
    autoEnable: boolean;
    /** periodic self-review that turns friction into proposals */
    reflect: 'off' | 'daily' | 'weekly';
    /** only core tools are loaded up front; the rest are discovered with tool search (keeps the context lean) */
    deferTools: boolean;
  };
}

/* ────────────────────────────── providers / auth ────────────────────────────── */

export type ProviderAuthKind = 'api-key' | 'oauth' | 'subscription' | 'local';

export interface ProviderStatus {
  id: string; // "claude-sdk" | pi-ai provider id ("anthropic", "openai", "github-copilot", ...)
  name: string; // human name
  engine: EngineId;
  /** auth methods this provider supports */
  authKinds: ProviderAuthKind[];
  configured: boolean;
  /** where the credential comes from, if configured */
  source?: 'env' | 'stored-key' | 'oauth' | 'claude-code' | 'none';
  /** account label if known (e.g. subscription email / plan) */
  account?: string;
  modelCount: number;
  /** last measured round-trip in ms (from /api/providers/:id/ping), if any */
  latencyMs?: number;
  error?: string;
  /** user-added OpenAI-compatible provider (editable / removable) */
  custom?: boolean;
  /** custom providers: base URL */
  baseUrl?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  engine: EngineId;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  /** USD per 1M tokens */
  cost?: { input: number; output: number };
}

/** progress of an interactive OAuth login (LLM providers via pi-ai, or Google accounts) */
export interface OAuthFlowState {
  flowId: ID;
  provider: string;
  status: 'starting' | 'awaiting-browser' | 'awaiting-code' | 'working' | 'done' | 'error';
  /** URL the user must open in a browser */
  url?: string;
  /** human instructions to show */
  instructions?: string;
  /** device-code style user code to display, if any */
  userCode?: string;
  message?: string;
  error?: string;
}

/* ────────────────────────────── chat ────────────────────────────── */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export type SessionKind = 'chat' | 'coding' | 'automation';

export interface SessionSummary {
  id: ID;
  title: string;
  kind: SessionKind;
  engine: EngineId;
  model: string;
  /** working directory (coding sessions) */
  cwd?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  itemCount: number;
  usage: Usage;
  running: boolean;
}

export type ToolStatus = 'pending-approval' | 'running' | 'ok' | 'error' | 'denied';

export type ChatItem =
  | { kind: 'user'; id: ID; ts: ISODate; text: string }
  | {
      kind: 'assistant';
      id: ID;
      ts: ISODate;
      text: string;
      thinking?: string;
      model?: string;
      streaming?: boolean;
    }
  | {
      kind: 'tool';
      id: ID;
      ts: ISODate;
      toolCallId: string;
      /** display name without mcp__ prefix, e.g. "gmail_search" or "Bash" */
      name: string;
      input: unknown;
      status: ToolStatus;
      /** truncated textual result (<= 8 KB) */
      output?: string;
      risk?: ToolRisk;
      durationMs?: number;
    }
  | { kind: 'error'; id: ID; ts: ISODate; message: string }
  | { kind: 'system'; id: ID; ts: ISODate; text: string };

export interface SessionDetail extends SessionSummary {
  items: ChatItem[];
}

export interface ApprovalRequest {
  id: ID;
  sessionId: ID;
  tool: string;
  input: unknown;
  risk: ToolRisk;
  /** one-line human summary, e.g. "Run shell: rm -rf build" */
  summary: string;
  ts: ISODate;
}

/* ────────────────────────────── productivity ────────────────────────────── */

export interface Task {
  id: ID;
  title: string;
  notes?: string;
  due?: ISODate | null;
  /** fire a reminder notification at this time */
  remindAt?: ISODate | null;
  priority: 'low' | 'normal' | 'high';
  done: boolean;
  tags: string[];
  createdAt: ISODate;
  completedAt?: ISODate | null;
}

export interface CalendarEvent {
  id: ID; // for google events: `${accountId}:${eventId}`
  source: 'local' | 'google';
  accountId?: ID;
  calendarId?: string;
  title: string;
  start: ISODate;
  end?: ISODate | null;
  allDay?: boolean;
  location?: string;
  notes?: string;
  /** joinable meeting link if any */
  link?: string;
}

export interface Automation {
  id: ID;
  name: string;
  /**
   * schedule expression. Either a 5-field cron string ("0 8 * * 1-5")
   * or shorthand: "every 30m" | "every 2h" | "daily 08:00".
   */
  schedule: string;
  /** prompt Monarch runs on schedule (in its own automation session) */
  prompt: string;
  enabled: boolean;
  /** post result to the notification feed */
  notify: boolean;
  lastRunAt?: ISODate | null;
  nextRunAt?: ISODate | null;
  lastStatus?: 'ok' | 'error' | null;
  lastResult?: string | null;
  createdAt: ISODate;
}

/* ────────────────────────────── integrations ────────────────────────────── */

export interface GoogleAccount {
  id: ID; // stable id (google sub or email)
  email: string;
  name?: string;
  picture?: string;
  scopes: string[];
  connectedAt: ISODate;
  /** short color/label for UI */
  label?: string;
  error?: string;
}

export interface GoogleClientConfig {
  /** OAuth "Desktop app" client from Google Cloud console */
  clientId: string;
  /** masked on GET */
  clientSecret: string;
  configured: boolean;
}

export interface MailThreadSummary {
  id: string; // gmail thread id
  accountId: ID;
  subject: string;
  from: string;
  snippet: string;
  date: ISODate;
  unread: boolean;
  labels: string[];
  messageCount: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  accountId: ID;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: ISODate;
  /** plain-text body (html stripped) */
  text: string;
  /** sanitized html, if present */
  html?: string;
  labels: string[];
  messageIdHeader?: string;
}

export interface MailThread {
  id: string;
  accountId: ID;
  subject: string;
  messages: MailMessage[];
}

export interface MailDraft {
  accountId: ID;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** reply to this thread */
  threadId?: string;
  inReplyTo?: string;
}

export interface SlackWorkspace {
  id: ID; // team id
  name: string;
  /** user the token belongs to */
  user?: string;
  tokenType: 'user' | 'bot';
  connectedAt: ISODate;
  error?: string;
}

export interface SlackChannel {
  id: string;
  workspaceId: ID;
  name: string;
  kind: 'channel' | 'private' | 'dm' | 'group-dm';
  unread?: number;
  topic?: string;
  memberCount?: number;
}

export interface SlackMessage {
  ts: string;
  channelId: string;
  workspaceId: ID;
  user: string; // display name if resolved
  userId?: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
  date: ISODate;
  permalink?: string;
}

/* ────────────────────────────── memory vault (Obsidian-like) ────────────────────────────── */

export interface MemoryNote {
  /** relative path inside the vault without extension, e.g. "People/Pepper Potts" */
  id: string;
  title: string;
  /** markdown body (without frontmatter) */
  body: string;
  tags: string[];
  /** outgoing [[wikilinks]] (target note ids/titles as written) */
  links: string[];
  /** note ids linking to this note */
  backlinks: string[];
  createdAt: ISODate;
  updatedAt: ISODate;
  source: 'user' | 'agent';
}

export interface MemoryNoteSummary {
  id: string;
  title: string;
  tags: string[];
  excerpt: string;
  updatedAt: ISODate;
  linkCount: number;
}

export interface MemoryGraph {
  nodes: { id: string; title: string; tags: string[]; degree: number; kind: 'note' | 'tag' | 'ghost' }[];
  edges: { source: string; target: string; kind: 'link' | 'tag' }[];
}

/* ────────────────────────────── system / dashboard ────────────────────────────── */

export interface SystemInfo {
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalMemBytes: number;
  bootTime: ISODate;
  nodeVersion: string;
  coreVersion: string;
}

export interface SystemMetrics {
  ts: ISODate;
  cpu: { load: number; perCore: number[]; tempC?: number | null }; // 0..100
  mem: { usedBytes: number; totalBytes: number; percent: number };
  swap?: { usedBytes: number; totalBytes: number; percent: number };
  disk: { mount: string; usedBytes: number; totalBytes: number; percent: number }[];
  net: { rxBytesPerSec: number; txBytesPerSec: number; iface?: string };
  battery?: { percent: number; charging: boolean } | null;
  uptimeSec: number;
  loadAvg: [number, number, number];
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number; // percent
  memBytes: number;
  user?: string;
  command?: string;
}

export interface Weather {
  location: GeoLocation;
  current: {
    tempC: number;
    feelsLikeC: number;
    humidity: number;
    windKph: number;
    windDir: string; // "WSW"
    visibilityKm?: number;
    code: number; // WMO weather code
    summary: string; // "Clear"
    isDay: boolean;
  };
  hourly: { time: ISODate; tempC: number; code: number; precipProb?: number }[];
  daily: { date: string; minC: number; maxC: number; code: number; sunrise?: ISODate; sunset?: ISODate }[];
  fetchedAt: ISODate;
}

export type LogTag = 'SYS' | 'AGT' | 'CAL' | 'TSK' | 'MEM' | 'MAIL' | 'SLK' | 'NET' | 'CODE' | 'AUTO' | 'EVO' | 'EXT' | 'ERR';

export interface ActivityEntry {
  id: ID;
  ts: ISODate;
  tag: LogTag;
  text: string;
  level: 'info' | 'warn' | 'error';
  sessionId?: ID;
}

export interface Notification {
  id: ID;
  ts: ISODate;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warn' | 'error';
  /** optional deep link inside the UI, e.g. "#/agenda" */
  href?: string;
  read: boolean;
}

export interface Briefing {
  greeting: string; // "Good evening, sir."
  headline: string; // "All systems nominal. Three items flagged for your attention."
  flags: { tag: LogTag; text: string; href?: string; level: 'info' | 'warn' | 'error' }[];
  nextEvent?: CalendarEvent | null;
  unreadMail: number;
  openTasks: number;
}

export interface UsagePoint {
  /** bucket start */
  ts: ISODate;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requests: number;
}

export interface UsageReport {
  range: '24h' | '7d' | '30d';
  points: UsagePoint[];
  totals: { inputTokens: number; outputTokens: number; costUsd: number; requests: number };
  byModel: { model: string; tokens: number; costUsd: number }[];
}

export interface HealthInfo {
  ok: true;
  version: string;
  protocol: number;
  startedAt: ISODate;
  engine: EngineId;
  model: string;
}


/* ────────────────────────────── self-evolution ──────────────────────────────
 *
 * Monarch extends itself at runtime:
 *  - Extensions: ~/.monarch-ai/extensions/<id>/{extension.json,index.mjs}. Each runs in its own
 *    sandboxed Node child process (Node permission model) and contributes tools, panels and jobs.
 *    Every write is versioned (revision history + rollback).
 *  - Skills: ~/.monarch-ai/skills/<id>.md — learned procedures (markdown + frontmatter) the agent
 *    reads on demand; their names/descriptions are listed in the system prompt.
 *  - Proposals: ideas from reflection runs or the agent, reviewed by the user.
 *  - Timeline: an audit log of every self-modification.
 * Tools are split into always-loaded core tools and deferred tools found via tool search.
 */

export type ExtensionPermission =
  /** outbound HTTP (fetch) */
  | 'network'
  /** spawn processes */
  | 'shell'
  /** read/write files outside the extension's own data dir */
  | 'fs'
  /** read secrets the user stored for this extension (api.secrets) */
  | 'secrets';

export type ExtensionOrigin = 'builtin' | 'user' | 'agent';
export type ExtensionStatus = 'active' | 'disabled' | 'error' | 'starting';

export interface ExtensionManifest {
  /** kebab-case, unique: "hacker-news" */
  id: string;
  name: string;
  version: string; // semver-ish "0.1.0"
  description: string;
  permissions: ExtensionPermission[];
  /** names of secrets the extension expects (user fills them in Evolve; read via api.secrets.get) */
  secrets?: string[];
}

export interface ExtensionToolInfo {
  /** full tool name as the agent sees it: "<id_snake>_<tool>" */
  name: string;
  description: string;
  risk: ToolRisk;
}

export interface ExtensionPanelInfo {
  id: string;
  title: string;
}

export interface ExtensionJobInfo {
  id: string;
  /** interval in minutes */
  everyMinutes: number;
  lastRunAt?: ISODate;
  lastError?: string;
}

export interface ExtensionSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  origin: ExtensionOrigin;
  enabled: boolean;
  status: ExtensionStatus;
  error?: string;
  permissions: ExtensionPermission[];
  tools: ExtensionToolInfo[];
  panels: ExtensionPanelInfo[];
  jobs: ExtensionJobInfo[];
  /** secret names declared in the manifest and whether each is set (values never leave the core) */
  secrets: { name: string; set: boolean }[];
  revision: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** total tool calls served */
  calls: number;
}

export interface ExtensionLogLine {
  ts: ISODate;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface ExtensionRevision {
  revision: number;
  ts: ISODate;
  actor: 'agent' | 'user' | 'system';
  note: string;
}

export interface ExtensionDetail extends ExtensionSummary {
  manifest: ExtensionManifest;
  /** index.mjs source */
  source: string;
  logs: ExtensionLogLine[];
  history: ExtensionRevision[];
}

/** what a panel's render() returns; the UI draws it in the Evolve page */
export interface PanelContent {
  title?: string;
  markdown?: string;
  stats?: { label: string; value: string; hint?: string }[];
  items?: { title: string; sub?: string; href?: string }[];
  updatedAt: ISODate;
}

export interface SkillSummary {
  /** kebab-case file stem */
  id: string;
  name: string;
  description: string;
  origin: 'user' | 'agent';
  updatedAt: ISODate;
  /** how often the agent read it */
  uses: number;
}

export interface Skill extends SkillSummary {
  /** markdown body (without frontmatter) */
  body: string;
}

export type EvolutionKind =
  | 'extension.created'
  | 'extension.updated'
  | 'extension.removed'
  | 'extension.enabled'
  | 'extension.disabled'
  | 'extension.rollback'
  | 'extension.error'
  | 'skill.created'
  | 'skill.updated'
  | 'skill.removed'
  | 'proposal.created'
  | 'proposal.accepted'
  | 'proposal.dismissed'
  | 'reflection';

export interface EvolutionEntry {
  id: ID;
  ts: ISODate;
  kind: EvolutionKind;
  title: string;
  detail?: string;
  actor: 'agent' | 'user' | 'system';
  sessionId?: ID;
  /** extension id / skill id / proposal id */
  ref?: string;
}

export interface EvolutionProposal {
  id: ID;
  ts: ISODate;
  title: string;
  /** why: the friction or opportunity observed */
  rationale: string;
  /** what to build, precise enough for an agent to implement */
  plan: string;
  kind: 'extension' | 'skill';
  status: 'open' | 'accepted' | 'dismissed';
  /** session that created it, and the build session after acceptance */
  sessionId?: ID;
  buildSessionId?: ID;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  risk: ToolRisk;
  source: 'core' | 'extension';
  extensionId?: string;
  /** always = in every prompt; deferred = found via tool search */
  loading: 'always' | 'deferred';
  group: string;
}

export interface EvolutionStats {
  extensions: { total: number; active: number; error: number };
  tools: { always: number; deferred: number };
  skills: number;
  openProposals: number;
  /** self-modifications in the last 7 days */
  changes7d: number;
  lastReflectionAt?: ISODate;
}

/* ────────────────────────────── WebSocket frames ────────────────────────────── */

export type ServerEvent =
  | { type: 'hello'; health: HealthInfo; phase: AgentPhase }
  | { type: 'agent.phase'; phase: AgentPhase; sessionId?: ID; detail?: string }
  /** clientRef echoes ClientCommand chat.send.clientRef on the first update of a newly created session */
  | { type: 'session.updated'; session: SessionSummary; clientRef?: string }
  | { type: 'session.deleted'; sessionId: ID }
  /** a brand-new item appended to a session */
  | { type: 'chat.item'; sessionId: ID; item: ChatItem }
  /** streaming append to an existing assistant item */
  | { type: 'chat.delta'; sessionId: ID; itemId: ID; text?: string; thinking?: string }
  /** full replacement of an existing item (tool status/output, end of streaming) */
  | { type: 'chat.item.update'; sessionId: ID; item: ChatItem }
  | { type: 'chat.done'; sessionId: ID; usage?: Usage; durationMs?: number; error?: string }
  | { type: 'approval.request'; request: ApprovalRequest }
  | { type: 'approval.resolved'; id: ID; allowed: boolean }
  | { type: 'oauth.progress'; flow: OAuthFlowState }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'notification'; notification: Notification }
  | { type: 'metrics'; metrics: SystemMetrics }
  /** hint that a REST collection changed; UI should refetch */
  | {
      type: 'data.changed';
      collection:
        | 'settings'
        | 'providers'
        | 'sessions'
        | 'tasks'
        | 'events'
        | 'automations'
        | 'memory'
        | 'mail'
        | 'slack'
        | 'google'
        | 'notifications'
        | 'extensions'
        | 'skills'
        | 'evolution';
    }
  | { type: 'pong'; t: number };

export type ClientCommand =
  | {
      type: 'chat.send';
      /** omit to create a new session; core replies with session.updated then chat.item(user) */
      sessionId?: ID;
      text: string;
      /** override for a new session; for an existing session `model` switches its model (same engine only) */
      kind?: SessionKind;
      engine?: EngineId;
      model?: string;
      cwd?: string;
      /** client correlation id echoed in the first session.updated */
      clientRef?: string;
    }
  | { type: 'chat.abort'; sessionId: ID }
  | { type: 'approval.respond'; id: ID; allow: boolean; /** remember for this session */ always?: boolean }
  | { type: 'ping'; t: number };

/* ────────────────────────────── REST surface (documentation) ──────────────────────────────
 *
 * GET    /api/health                         -> HealthInfo
 * GET    /api/settings                       -> Settings
 * PUT    /api/settings   (Partial<Settings>, deep-merged) -> Settings
 * GET    /api/briefing                       -> Briefing
 * GET    /api/activity?limit=50              -> ActivityEntry[]
 * GET    /api/notifications                  -> Notification[]
 * POST   /api/notifications/read             -> { ok }           (marks all read)
 *
 * GET    /api/providers                      -> ProviderStatus[]
 * PUT    /api/providers/:id/key  {apiKey}    -> ProviderStatus
 * DELETE /api/providers/:id/key              -> ProviderStatus
 * POST   /api/providers/:id/ping             -> ProviderStatus (latencyMs filled)
 * POST   /api/providers/:id/login            -> OAuthFlowState  (progress via ws 'oauth.progress')
 * POST   /api/oauth/:flowId/code {code}      -> OAuthFlowState  (paste-code step)
 * POST   /api/oauth/:flowId/cancel           -> { ok }
 * DELETE /api/providers/:id/login            -> ProviderStatus  (logout)
 * POST   /api/custom-providers {name, baseUrl} -> ProviderStatus      (adds an OpenAI-compatible provider)
 * PATCH  /api/custom-providers/:id {name?, baseUrl?, models?} -> ProviderStatus
 * DELETE /api/custom-providers/:id          -> { ok }   (also forgets its API key)
 * GET    /api/providers/:id/discover?baseUrl= -> { id: string; ownedBy?: string }[]  (custom providers: GET <baseUrl>/models with its key)
 * GET    /api/models?engine=pi&provider=x    -> ModelInfo[]
 * GET    /api/models/available           -> ModelInfo[]  (all models of every configured provider)
 *
 * GET    /api/sessions?kind=chat             -> SessionSummary[]
 * GET    /api/sessions/:id                   -> SessionDetail
 * PATCH  /api/sessions/:id {title}           -> SessionSummary
 * DELETE /api/sessions/:id                   -> { ok }
 * GET    /api/approvals                      -> ApprovalRequest[]  (pending)
 *
 * GET/POST        /api/tasks                 -> Task[] / Task
 * PATCH/DELETE    /api/tasks/:id
 * GET    /api/events?from=ISO&to=ISO         -> CalendarEvent[] (local + all google accounts)
 * POST   /api/events  (CalendarEvent w/o id; accountId => google) -> CalendarEvent
 * PATCH/DELETE    /api/events/:id
 * GET/POST        /api/automations
 * PATCH/DELETE    /api/automations/:id
 * POST   /api/automations/:id/run            -> { sessionId }
 *
 * GET    /api/google/client                  -> GoogleClientConfig
 * PUT    /api/google/client {clientId, clientSecret} -> GoogleClientConfig
 * GET    /api/google/accounts                -> GoogleAccount[]
 * POST   /api/google/accounts/connect        -> OAuthFlowState (opens browser; loopback callback at /oauth/google/callback)
 * DELETE /api/google/accounts/:id            -> { ok }
 *
 * GET    /api/mail/threads?accountId=&q=&label=INBOX&max=30 -> MailThreadSummary[] (accountId omitted => all accounts merged)
 * GET    /api/mail/threads/:accountId/:threadId -> MailThread
 * POST   /api/mail/send  MailDraft           -> { id }
 * POST   /api/mail/drafts MailDraft          -> { id }
 * POST   /api/mail/threads/:accountId/:threadId/modify {addLabels?, removeLabels?} -> { ok }
 *
 * GET    /api/slack/workspaces               -> SlackWorkspace[]
 * POST   /api/slack/workspaces {token}       -> SlackWorkspace
 * DELETE /api/slack/workspaces/:id           -> { ok }
 * GET    /api/slack/:workspaceId/channels    -> SlackChannel[]
 * GET    /api/slack/:workspaceId/channels/:channelId/messages?limit=50 -> SlackMessage[]
 * GET    /api/slack/:workspaceId/search?q=   -> SlackMessage[]
 * POST   /api/slack/:workspaceId/post {channelId, text, threadTs?} -> SlackMessage
 *
 * GET    /api/memory/notes?q=                -> MemoryNoteSummary[]
 * GET    /api/memory/notes/:id               -> MemoryNote        (id is URL-encoded relative path)
 * PUT    /api/memory/notes/:id {title?, body, tags?} -> MemoryNote (create or replace)
 * DELETE /api/memory/notes/:id               -> { ok }
 * GET    /api/memory/graph                   -> MemoryGraph
 *
 * GET    /api/system/info                    -> SystemInfo
 * GET    /api/system/metrics                 -> SystemMetrics
 * GET    /api/system/processes?limit=15      -> ProcessInfo[]
 * GET    /api/weather                        -> Weather   (404 if no location set)
 * GET    /api/geocode?q=                     -> GeoLocation[]
 * GET    /api/usage?range=24h                -> UsageReport
 *
 * GET    /api/fs/dirs?path=                  -> { path: string; parent: string | null; dirs: string[] } (workspace picker)
 * GET    /api/coding/git?cwd=                -> { branch: string | null; dirty: number; ahead: number; behind: number; recent: { hash: string; subject: string; date: ISODate }[] } | { error }
 *
 * GET    /api/extensions                     -> ExtensionSummary[]
 * GET    /api/extensions/:id                 -> ExtensionDetail
 * PUT    /api/extensions/:id {manifest, source, note?} -> ExtensionDetail   (create or update; user edit)
 * POST   /api/extensions/:id/toggle {enabled} -> ExtensionSummary
 * POST   /api/extensions/:id/reload          -> ExtensionSummary
 * POST   /api/extensions/:id/rollback {revision} -> ExtensionDetail
 * PUT    /api/extensions/:id/secrets {name, value} -> ExtensionSummary   (value '' clears)
 * DELETE /api/extensions/:id                 -> { ok }
 * GET    /api/extensions/:id/panels/:panelId -> PanelContent
 * POST   /api/extensions/:id/tools/:tool/test {args} -> { ok: boolean; output: string; durationMs: number }
 * GET    /api/extension-api                  -> { markdown: string }   (extension authoring reference)
 * GET    /api/skills                         -> SkillSummary[]
 * GET    /api/skills/:id                     -> Skill
 * PUT    /api/skills/:id {name, description, body} -> Skill
 * DELETE /api/skills/:id                     -> { ok }
 * GET    /api/evolution/stats                -> EvolutionStats
 * GET    /api/evolution/timeline?limit=100   -> EvolutionEntry[]
 * GET    /api/evolution/proposals            -> EvolutionProposal[]
 * POST   /api/evolution/proposals/:id/accept -> { sessionId }   (starts a build session)
 * POST   /api/evolution/proposals/:id/dismiss -> { ok }
 * POST   /api/evolution/reflect              -> { sessionId }   (run a reflection now)
 * POST   /api/evolution/forge {text}         -> { sessionId }   (ask the agent to build a capability)
 * GET    /api/tools/catalog                  -> ToolCatalogEntry[]
 */
