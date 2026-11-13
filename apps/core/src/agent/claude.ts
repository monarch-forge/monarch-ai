/**
 * Claude Code / Claude Agent SDK helpers: executable discovery, subprocess env, login status
 * (`claude auth status`), and the model list (aliases + lazily cached `supportedModels()`).
 * Monarch never reads Claude Code's credential files itself; the CLI owns the login.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelInfo } from '@monarch/shared';
import { query, type ModelInfo as SdkModelInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { secrets } from '../kernel.ts';
import { getSettings } from '../settings.ts';

export const MONARCH_CLIENT_APP = 'monarch-ai/0.1.0';

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichClaude(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'claude');
    if (isExecutable(p)) return p;
  }
  return undefined;
}

function bundledClaude(): string | undefined {
  try {
    const sdkMain = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const ext = process.platform === 'win32' ? '.exe' : '';
    const p = join(dirname(sdkMain), '..', `claude-agent-sdk-${process.platform}-${process.arch}`, `claude${ext}`);
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

export interface ClaudeExecutable {
  /** path to pass as pathToClaudeCodeExecutable (undefined = let the SDK use its bundled binary) */
  forSdk?: string;
  /** path usable for `claude auth status` etc. */
  path?: string;
  source: 'settings' | 'path' | 'local' | 'bundled' | 'none';
}

export function resolveClaudeExecutable(): ClaudeExecutable {
  const configured = getSettings().claudeSdk.executablePath?.trim();
  if (configured && isExecutable(configured)) return { forSdk: configured, path: configured, source: 'settings' };
  const onPath = whichClaude();
  if (onPath) return { forSdk: onPath, path: onPath, source: 'path' };
  const local = join(homedir(), '.local', 'bin', 'claude');
  if (isExecutable(local)) return { forSdk: local, path: local, source: 'local' };
  const bundled = bundledClaude();
  if (bundled) return { path: bundled, source: 'bundled' };
  return { source: 'none' };
}

/** env vars a parent Claude Code session injects into its children; they must not leak into ours */
const HOST_SESSION_VAR = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_DESKTOP_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_)/;
/** user-level auth/config vars that are legitimate and must be kept */
const KEEP_VAR = /^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|CLAUDE_CODE_MAX_OUTPUT_TOKENS|CLAUDE_CODE_SKIP_.*)$/;

/** subprocess env for the Claude Code CLI (the SDK's `env` replaces process.env entirely) */
export function claudeEnv(): Record<string, string | undefined> {
  const s = getSettings().claudeSdk;
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (HOST_SESSION_VAR.test(k) && !KEEP_VAR.test(k)) continue;
    env[k] = v;
  }
  if (s.useSubscription) {
    // an inherited key silently wins over the subscription login in non-interactive mode
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  } else {
    const stored = secrets.get().apiKeys['anthropic'];
    if (stored) env.ANTHROPIC_API_KEY = stored;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = MONARCH_CLIENT_APP;
  return env;
}

/* ─────────────── auth status ─────────────── */

export interface ClaudeStatus {
  installed: boolean;
  executable?: string;
  executableSource: ClaudeExecutable['source'];
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  /** display label, e.g. "user@example.com · pro" */
  account?: string;
  latencyMs: number;
  error?: string;
}

let statusCache: { at: number; value: ClaudeStatus } | null = null;
let statusInflight: Promise<ClaudeStatus> | null = null;

export function invalidateClaudeStatus(): void {
  statusCache = null;
}

/** `claude auth status` (JSON; exit 1 = logged out). Cached 30s unless `fresh`. */
export function claudeStatus(fresh = false): Promise<ClaudeStatus> {
  if (!fresh && statusCache && Date.now() - statusCache.at < 30_000) return Promise.resolve(statusCache.value);
  if (statusInflight) return statusInflight;
  statusInflight = runClaudeStatus()
    .then((v) => {
      statusCache = { at: Date.now(), value: v };
      return v;
    })
    .finally(() => {
      statusInflight = null;
    });
  return statusInflight;
}

function runClaudeStatus(): Promise<ClaudeStatus> {
  const exe = resolveClaudeExecutable();
  const t0 = Date.now();
  if (!exe.path) {
    return Promise.resolve({
      installed: false,
      executableSource: 'none',
      loggedIn: false,
      latencyMs: 0,
      error: 'Claude Code executable not found. Install Claude Code or set its path in Config.',
    });
  }
  return new Promise((resolve) => {
    execFile(
      exe.path!,
      ['auth', 'status'],
      { timeout: 10_000, env: claudeEnv() as NodeJS.ProcessEnv, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        const latencyMs = Date.now() - t0;
        const base = { installed: true, executable: exe.path, executableSource: exe.source, latencyMs };
        let j: any = null;
        try {
          j = JSON.parse(String(stdout || '').trim() || 'null');
        } catch {
          j = null;
        }
        if (j && typeof j === 'object') {
          const loggedIn = !!j.loggedIn;
          const plan = j.subscriptionType || j.planTier;
          resolve({
            ...base,
            loggedIn,
            authMethod: j.authMethod,
            email: j.email,
            subscriptionType: plan,
            account: loggedIn ? [j.email, plan].filter(Boolean).join(' · ') || j.authMethod : undefined,
            error: loggedIn ? undefined : 'Not logged in. Run `claude auth login` in a terminal.',
          });
          return;
        }
        const msg = (err as any)?.killed
          ? 'claude auth status timed out'
          : String(stderr || (err as Error | null)?.message || 'unexpected output').trim().slice(0, 300);
        resolve({ ...base, loggedIn: false, latencyMs, error: msg });
      },
    );
  });
}

/* ─────────────── models ─────────────── */

const ALIASES: ModelInfo[] = [
  { id: 'opus', name: 'Opus (latest)', provider: 'anthropic', engine: 'claude-sdk', reasoning: true, input: ['text', 'image'] },
  { id: 'sonnet', name: 'Sonnet (latest)', provider: 'anthropic', engine: 'claude-sdk', reasoning: true, input: ['text', 'image'] },
  { id: 'haiku', name: 'Haiku (latest)', provider: 'anthropic', engine: 'claude-sdk', reasoning: true, input: ['text', 'image'] },
];

let sdkModels: { at: number; list: SdkModelInfo[] } | null = null;
let sdkModelsInflight: Promise<void> | null = null;
const MODELS_TTL = 6 * 3600_000;

export function cacheSupportedModels(list: SdkModelInfo[]): void {
  if (list?.length) sdkModels = { at: Date.now(), list };
}

export function hasFreshSdkModels(): boolean {
  return !!sdkModels && Date.now() - sdkModels.at < MODELS_TTL;
}

/** spawn the CLI without sending a prompt and ask it for its model list (no model call) */
async function fetchSupportedModels(): Promise<void> {
  const exe = resolveClaudeExecutable();
  const abort = new AbortController();
  const input: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((r) => abort.signal.addEventListener('abort', () => r(), { once: true }));
    },
  };
  const q = query({
    prompt: input,
    options: {
      abortController: abort,
      pathToClaudeCodeExecutable: exe.forSdk,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      persistSession: false,
      env: claudeEnv(),
    },
  });
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    // drain in the background so the transport keeps flowing
    const drain = (async () => {
      try {
        for await (const _m of q) {
          /* nothing */
        }
      } catch {
        /* closed */
      }
    })();
    const list = await q.supportedModels();
    cacheSupportedModels(list);
    abort.abort();
    await drain;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

export function refreshSdkModels(): Promise<void> {
  if (sdkModelsInflight) return sdkModelsInflight;
  sdkModelsInflight = fetchSupportedModels()
    .catch(() => {})
    .finally(() => {
      sdkModelsInflight = null;
    });
  return sdkModelsInflight;
}

/** aliases + (cached) supportedModels(); triggers a background refresh when stale */
export async function claudeModels(opts: { wait?: boolean } = {}): Promise<ModelInfo[]> {
  if (!hasFreshSdkModels()) {
    const p = refreshSdkModels();
    if (opts.wait) await Promise.race([p, new Promise((r) => setTimeout(r, 15_000))]);
  }
  const out: ModelInfo[] = [...ALIASES];
  const seen = new Set(out.map((m) => m.id));
  for (const m of sdkModels?.list ?? []) {
    if (!m.value || m.value === 'default' || seen.has(m.value)) {
      // enrich the alias row with the display name the CLI reports
      const alias = out.find((a) => a.id === m.value);
      if (alias && m.displayName) alias.name = m.resolvedModel ? `${m.displayName} (${m.resolvedModel})` : m.displayName;
      continue;
    }
    seen.add(m.value);
    out.push({
      id: m.value,
      name: m.displayName || m.value,
      provider: 'anthropic',
      engine: 'claude-sdk',
      reasoning: !!(m.supportsAdaptiveThinking || m.supportsEffort),
      input: ['text', 'image'],
    });
  }
  return out;
}

export function claudeModelCount(): number {
  return ALIASES.length + (sdkModels?.list.filter((m) => !ALIASES.some((a) => a.id === m.value) && m.value !== 'default').length ?? 0);
}
