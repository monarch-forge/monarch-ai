# pi (pi-mono) API notes: `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` @ 0.73.1

Researched 2026-11-13. Sources: the published 0.73.1 tarballs (`dist/*.d.ts`, `dist/*.js`, READMEs),
a runtime probe, `tsc --strict` on every snippet below, and a live Agent run against pi-ai's built-in
"faux" provider. Upstream changelog: `badlogic/pi-mono/packages/ai/CHANGELOG.md`.
**[V]** = verified against typings or runtime. **[U]** = not verified (docs only, or needs a real account).

> **Heads-up, read first [V]:** `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` **0.73.1 is the
> final release under the `@mariozechner` scope** (published 2026-05-07). npm marks both as deprecated:
> "please use @earendil-works/pi-ai instead going forward". The current version is `@earendil-works/pi-ai` /
> `@earendil-works/pi-agent-core` **1.5.2**. Breaking changes after 0.73, from the changelog:
> 0.75.0 needs Node >= 22.19; 0.75.5 makes `OAuthLoginCallbacks` require `onDeviceCode` and `onSelect`;
> 0.78.0 makes direct provider stream fns require an explicit `options.apiKey`; 0.80.0 makes the root
> entry core-only (the old global API moved to `/compat`, `Provider` became `ProviderId`, APIs moved to
> `/api/*`); 0.80.8 removes the global OAuth registry in favour of `Provider.auth.oauth`; 1.5.0 stops
> re-exporting TypeBox. Everything below describes **0.73.1** as requested. Consider pinning it behind an
> adapter, or retargeting to the new scope.

## 0. Packaging gotchas [V]
- **ESM only.** `"type": "module"`, and the `exports` map has only `import` conditions. From a CJS TS
  file, tsc fails with TS1479. Use `"type":"module"` plus `module/moduleResolution: NodeNext`.
- `engines.node >= 20` in 0.73.1. Tested on Node 26.
- Entry points: `@mariozechner/pi-ai` (main), `@mariozechner/pi-ai/oauth`, and per-API
  `@mariozechner/pi-ai/{anthropic,openai-completions,openai-responses,openai-codex-responses,google,google-vertex,mistral,azure-openai-responses}`,
  plus `/bedrock-provider`. The agent package has only its main entry.
- Schemas use the **`typebox` 1.x** package, not `@sinclair/typebox` (changed in 0.69). pi-ai re-exports
  `Type`, plus the types `Static` and `TSchema`. `StringEnum([...])` helper: use it for enums because
  Google rejects `anyOf/const`.
- Ships a CLI: `npx @mariozechner/pi-ai login [provider]` writes `./auth.json`.

## 1. pi-ai

### Providers and models [V]
```ts
getProviders(): KnownProvider[]                       // 31 at 0.73.1
getModels(provider): Model<Api>[]                    // typed per provider
getModel(provider, modelId): Model<Api>              // both args are literal-typed (autocomplete)
calculateCost(model, usage); getSupportedThinkingLevels(model); clampThinkingLevel(model, level); modelsAreEqual(a,b)
```
Providers: amazon-bedrock, anthropic, azure-openai-responses, cerebras, cloudflare-ai-gateway,
cloudflare-workers-ai, deepseek, fireworks, github-copilot, google, google-vertex, groq, huggingface,
kimi-coding, minimax(-cn), mistral, moonshotai(-cn), openai, **openai-codex**, opencode(-go), openrouter,
vercel-ai-gateway, xai, xiaomi, xiaomi-token-plan-{ams,cn,sgp}, zai. The model list is static and generated
at build time (`models.generated.js`): 23 anthropic models, up to `claude-opus-4-7` and `claude-sonnet-4-6`.
There is no live discovery.

```ts
interface Model<TApi extends Api> {
  id: string; name: string; api: TApi; provider: string; baseUrl: string;
  reasoning: boolean; thinkingLevelMap?: Partial<Record<"off"|ThinkingLevel, string|null>>;
  input: ("text"|"image")[];
  cost: { input; output; cacheRead; cacheWrite };      // $ per 1M tokens
  contextWindow: number; maxTokens: number; headers?: Record<string,string>;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat; // by api
}
type KnownApi = "openai-completions"|"openai-responses"|"azure-openai-responses"|"openai-codex-responses"
  |"anthropic-messages"|"bedrock-converse-stream"|"google-generative-ai"|"google-vertex"|"mistral-conversations";
type ThinkingLevel = "minimal"|"low"|"medium"|"high"|"xhigh";
```

### Calling models [V]
```ts
stream(model, context, options?: StreamOptions & Record<string,unknown>): AssistantMessageEventStream
complete(model, context, options?): Promise<AssistantMessage>
streamSimple(model, context, options?: SimpleStreamOptions): AssistantMessageEventStream  // unified reasoning
completeSimple(model, context, options?): Promise<AssistantMessage>
```
- `StreamOptions`: `temperature, maxTokens, signal, apiKey, transport ("sse"|"websocket"|"websocket-cached"|"auto"),
  cacheRetention ("none"|"short"|"long"), sessionId, onPayload(payload, model) => replacement|undefined,
  onResponse({status, headers}), headers, timeoutMs, maxRetries, maxRetryDelayMs (default 60000), metadata`.
- `SimpleStreamOptions` adds `reasoning?: ThinkingLevel` and `thinkingBudgets?`. `stream()` instead takes
  provider-specific options such as `AnthropicOptions` and `OpenAICompletionsOptions`.
- Per-API functions are also exported: `streamAnthropic`, `streamSimpleAnthropic`, `streamOpenAICompletions`, and so on.
- `AssistantMessageEventStream` is an `AsyncIterable<AssistantMessageEvent>` with `.result(): Promise<AssistantMessage>`.
- **Errors do not reject the promise.** They end the stream with an `error` event, `stopReason: "error"|"aborted"`
  and `errorMessage`. One exception: `streamSimple*` **throws synchronously** if no API key resolves
  ("No API key for provider: X").

### Event stream (`AssistantMessageEvent`) [V]
Every event except `done`/`error` carries `partial: AssistantMessage`.
`start` | `text_start{contentIndex}` | `text_delta{contentIndex, delta}` | `text_end{contentIndex, content}` |
`thinking_start` | `thinking_delta{delta}` | `thinking_end{content}` | `toolcall_start` |
`toolcall_delta{delta}` (raw partial JSON) | `toolcall_end{toolCall: ToolCall}` |
`done{reason: "stop"|"length"|"toolUse", message}` | `error{reason: "aborted"|"error", error: AssistantMessage}`.

### Messages and context [V]
```ts
interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }
type Message = UserMessage | AssistantMessage | ToolResultMessage;
UserMessage       { role:"user"; content: string | (TextContent|ImageContent)[]; timestamp: number }
AssistantMessage  { role:"assistant"; content:(TextContent|ThinkingContent|ToolCall)[]; api; provider; model;
                    responseModel?; responseId?; usage: Usage; stopReason: "stop"|"length"|"toolUse"|"error"|"aborted";
                    errorMessage?; diagnostics?; timestamp }
ToolResultMessage { role:"toolResult"; toolCallId; toolName; content:(TextContent|ImageContent)[]; details?; isError; timestamp }
TextContent {type:"text"; text; textSignature?}  ThinkingContent {type:"thinking"; thinking; thinkingSignature?; redacted?}
ImageContent {type:"image"; data /*base64*/; mimeType}  ToolCall {type:"toolCall"; id; name; arguments: Record<string,any>; thoughtSignature?}
Usage { input; output; cacheRead; cacheWrite; totalTokens; cost:{input; output; cacheRead; cacheWrite; total} }  // cost in $
interface Tool<P extends TSchema> { name; description; parameters: P }
```
- `timestamp` is **required** on every message.
- Context is plain JSON, so it is serialisable. Cross-provider handoff works: foreign thinking blocks get transformed.
- Helpers: `validateToolCall(tools, toolCall)`, `validateToolArguments(tool, toolCall)`,
  `isContextOverflow(msg, contextWindow?)`, `parseStreamingJson`.

### API keys [V]
- Resolution order inside providers: `options.apiKey` → `getEnvApiKey(model.provider)` → otherwise throw.
- `getEnvApiKey(provider)` returns the value. `findEnvKeys(provider)` returns the names of env vars that are set, or `undefined`.
- Env vars: OPENAI_API_KEY; **ANTHROPIC_OAUTH_TOKEN (wins) or ANTHROPIC_API_KEY**; GEMINI_API_KEY;
  GOOGLE_CLOUD_API_KEY or ADC + GOOGLE_CLOUD_PROJECT/LOCATION (vertex); MISTRAL_API_KEY; GROQ_API_KEY;
  CEREBRAS_API_KEY; XAI_API_KEY; OPENROUTER_API_KEY; AI_GATEWAY_API_KEY; ZAI_API_KEY; DEEPSEEK_API_KEY;
  FIREWORKS_API_KEY; MINIMAX_API_KEY; OPENCODE_API_KEY; KIMI_API_KEY; XIAOMI_*; CLOUDFLARE_API_KEY +
  CLOUDFLARE_ACCOUNT_ID (+ CLOUDFLARE_GATEWAY_ID); AZURE_OPENAI_API_KEY + AZURE_OPENAI_BASE_URL or
  AZURE_OPENAI_RESOURCE_NAME; COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN (github-copilot);
  Bedrock uses AWS SDK credentials.

### Custom / OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, LiteLLM) [V types, U live]
Build a `Model<"openai-completions">` literal with any `provider` string and your `baseUrl`. You **must** pass
some `apiKey`, even a dummy one, because `streamSimple` throws without one. Use `compat` to override the
URL-based auto-detection. The ones that matter for local servers:
`supportsDeveloperRole:false` (send `system` instead of `developer`), `supportsReasoningEffort:false`,
`supportsStore:false`, `supportsUsageInStreaming`, `maxTokensField:"max_tokens"`, `supportsStrictMode:false`,
`thinkingFormat: "openai"|"openrouter"|"deepseek"|"zai"|"qwen"|"qwen-chat-template"`, `requiresThinkingAsText`.
Use `thinkingLevelMap` (with `null` meaning unsupported) to map reasoning levels. Anthropic-compatible proxies:
`api:"anthropic-messages"` plus your `baseUrl` and `headers`.
Advanced: `registerApiProvider({api, stream, streamSimple}, sourceId)` adds an entirely new wire API.

## 2. OAuth / subscription logins (import from `@mariozechner/pi-ai/oauth`) [V types; U live login]

Built-in providers at 0.73.1: `getOAuthProviders().map(p => p.id)` gives
**`anthropic`** ("Anthropic (Claude Pro/Max)", local callback server), **`github-copilot`** (device code,
has `modifyModels`), and **`openai-codex`** ("ChatGPT Plus/Pro (Codex Subscription)", local callback server).
**Google Gemini CLI and Antigravity are NOT available.** They were removed in 0.71.0 ("Removed built-in
Google Gemini CLI and Google Antigravity support": provider, models, OAuth, exports). The README still
lists `loginGeminiCli`, but that is stale; the export does not exist in 0.73.1.

Exports: `loginAnthropic, refreshAnthropicToken, anthropicOAuthProvider, loginGitHubCopilot,
refreshGitHubCopilotToken, githubCopilotOAuthProvider, getGitHubCopilotBaseUrl, normalizeDomain,
loginOpenAICodex, refreshOpenAICodexToken, openaiCodexOAuthProvider, getOAuthProvider(id),
getOAuthProviders(), registerOAuthProvider(p), unregisterOAuthProvider(id), resetOAuthProviders(),
getOAuthApiKey(id, credsMap), refreshOAuthToken (deprecated), getOAuthProviderInfoList (deprecated)`.
The OAuth types are also re-exported from the main entry; the functions are not.

```ts
type OAuthCredentials = { refresh: string; access: string; expires: number /* ms epoch */; [k: string]: unknown };
//  copilot adds `enterpriseUrl?`; codex adds `accountId` (from the JWT). Persist the whole object as-is.
interface OAuthLoginCallbacks {               // generic interface, used by provider.login()
  onAuth(info: { url: string; instructions?: string }): void;
  onPrompt(p: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
  onProgress?(msg: string): void;
  onManualCodeInput?(): Promise<string>;     // races the local callback server; first one wins
  onSelect?(p: { message; options: {id,label}[] }): Promise<string|undefined>;
  signal?: AbortSignal;
}
interface OAuthProviderInterface { id; name; usesCallbackServer?; login(cb): Promise<OAuthCredentials>;
  refreshToken(c): Promise<OAuthCredentials>; getApiKey(c): string; modifyModels?(models, c): Model[] }
```
- `loginAnthropic({onAuth, onPrompt, onProgress?, onManualCodeInput?})`: PKCE flow. Authorize URL
  `https://claude.ai/oauth/authorize`, token URL `https://platform.claude.com/v1/oauth/token`. It starts an HTTP
  server on `127.0.0.1:53692/callback` (override the host with `PI_OAUTH_CALLBACK_HOST`). If that fails, it
  falls back to `onPrompt("Paste the authorization code or full redirect URL:")`. Node/Bun only.
- `loginOpenAICodex({..., originator?="pi"})`: same pattern with callback `localhost:1455/auth/callback`.
- **`loginGitHubCopilot` has a different `onAuth` signature: `(url: string, instructions?: string)`.** It first
  calls `onPrompt` for an optional GitHub Enterprise domain (empty means github.com), then runs the device flow
  (`instructions` = "Enter code: XXXX"), and auto-enables all Copilot models. The generic
  `githubCopilotOAuthProvider.login(callbacks)` adapts it to `onAuth({url, instructions})`.
- `expires` already has a 5-minute safety margin subtracted (anthropic, copilot).
- **Turning creds into a key:** `getOAuthApiKey(providerId, { [providerId]: creds })` returns
  `{ apiKey, newCredentials } | null`. It refreshes if `Date.now() >= expires` (throws
  "Failed to refresh OAuth token for X" on failure). **Always persist `newCredentials`.** `apiKey` is
  `creds.access` for all three providers.
- Copilot: call `githubCopilotOAuthProvider.modifyModels(getModels("github-copilot"), creds)` to set the
  right `baseUrl` (it is derived from the token / enterprise domain).

### How the Anthropic subscription path works (from `providers/anthropic.js`) [V]
Detection is purely by key shape: an apiKey containing `sk-ant-oat` is treated as OAuth. pi-ai then:
- uses Bearer auth, with headers `anthropic-beta: claude-code-20250219,oauth-2025-04-20,...`,
  `user-agent: claude-cli/2.1.75`, `x-app: cli`;
- **prepends a system block "You are Claude Code, Anthropic's official CLI for Claude."**, with your
  `systemPrompt` as a second block (you cannot opt out);
- renames tools whose names case-insensitively match Claude Code tools (`read`, `write`, `edit`, `bash`, `grep`,
  `glob`, `webfetch`, `websearch`, `todowrite`, `task`, ...) to CC casing on the wire, and maps them back on the
  response.

So nothing extra is needed in monarch: pass the OAuth access token as `apiKey`, or set `ANTHROPIC_OAUTH_TOKEN`.
**[U] Policy risk:** using Claude Pro/Max OAuth from third-party apps relies on impersonating Claude Code
and may break or violate Anthropic's terms at any time. Treat it as an opt-in, best-effort provider.

## 3. pi-agent-core

### `new Agent(options?: AgentOptions)` [V]
```ts
interface AgentOptions {
  initialState?: Partial<{ systemPrompt: string; model: Model<any>; thinkingLevel: "off"|ThinkingLevel;
                           tools: AgentTool<any>[]; messages: AgentMessage[] }>;
  convertToLlm?(msgs: AgentMessage[]): Message[] | Promise<Message[]>;  // default: keep user/assistant/toolResult
  transformContext?(msgs: AgentMessage[], signal?): Promise<AgentMessage[]>; // runs BEFORE convertToLlm, each LLM call
  streamFn?: StreamFn;                    // default streamSimple; swap in for proxies (streamProxy) or tests
  getApiKey?(provider: string): Promise<string|undefined> | string | undefined; // called before EVERY LLM call
  onPayload?; onResponse?;
  beforeToolCall?(ctx:{assistantMessage, toolCall, args, context}, signal?): Promise<{block?: boolean; reason?: string}|undefined>;
  afterToolCall?(ctx:{..., result, isError}, signal?): Promise<{content?, details?, isError?, terminate?}|undefined>;
  steeringMode?: "all"|"one-at-a-time"; followUpMode?: "all"|"one-at-a-time";  // default one-at-a-time
  sessionId?; thinkingBudgets?; transport? /*default "auto"*/; maxRetryDelayMs?;
  toolExecution?: "sequential"|"parallel"   // default "parallel"
}
```
- Defaults: `systemPrompt ""`, `thinkingLevel "off"`, and model is a placeholder `{id:"unknown", api:"unknown"}`,
  so **always set a model**.
- `thinkingLevel` other than `"off"` is passed as `reasoning` to `streamSimple`.
- `getApiKey` result is used when truthy; otherwise the provider falls back to env vars. Contract: never throw.
  This is the hook for OAuth auto-refresh (call `getOAuthApiKey` inside it).
- All hooks (`convertToLlm`, `transformContext`, `getApiKey`, ...) must not throw.

### State and methods [V]
- `agent.state`: `systemPrompt`, `model`, `thinkingLevel`, `tools`, `messages` are mutable. Assigning `tools` or
  `messages` copies the array. Read-only: `isStreaming`, `streamingMessage`, `pendingToolCalls: ReadonlySet`,
  `errorMessage`. Switch model or system prompt between runs by assigning `agent.state.model = ...`.
  Restore a session with `agent.state.messages = saved`.
- `prompt(text, images?)` or `prompt(msg | msg[])`: resolves when the run (and awaited listeners) finish.
  **Throws if a run is already active**; use `steer()` / `followUp()` instead. LLM errors **do not reject**.
  They append an assistant message with `stopReason:"error"` and set `state.errorMessage`
  (verified: a missing key gives "No API key for provider: anthropic").
- `continue()`: retries from the current transcript (last message must be user/toolResult). If the last
  message is assistant, it drains the steering, then follow-up queues, or throws.
- `abort()`, `signal`, `waitForIdle()`, `reset()` (clears messages, runtime state, and queues).
- `steer(msg)`: injected after the current turn's tool calls finish, before the next LLM call.
  `followUp(msg)`: runs only when the agent would otherwise stop.
  `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`, `hasQueuedMessages()`.
- `subscribe((event, signal) => void|Promise<void>)` returns an unsubscribe function. **Listeners are awaited
  in order** (back-pressure). The agent is idle only after `agent_end` listeners settle.
- Custom message types: `declare module "@mariozechner/pi-agent-core" { interface CustomAgentMessages { note: {role:"note"; ...} } }`,
  then filter or convert them in `convertToLlm`.
- Low level: `agentLoop(prompts, context, config, signal?, streamFn?)`, which returns an `EventStream` and does
  not apply back-pressure. Also `agentLoopContinue`, `runAgentLoop`, `runAgentLoopContinue`, and
  `streamProxy(model, ctx, {...opts, authToken, proxyUrl})`. `AgentLoopConfig` adds `shouldStopAfterTurn`.

### `AgentTool<TParams, TDetails>` [V]
`Tool` plus `label: string`, `execute(toolCallId, params: Static<TParams>, signal?, onUpdate?) => Promise<{content:(Text|Image)[]; details: TDetails; terminate?: boolean}>`,
optional `prepareArguments(raw)` (a shim run before validation) and `executionMode`. Args are validated against
the TypeBox schema before `execute`. **Throw to signal failure.** The loop turns the error into a
`toolResult` with `isError: true`. `onUpdate(partial)` emits `tool_execution_update`.

### Events (`AgentEvent`) [V, sequence observed live]
`agent_start` · `turn_start` · `message_start{message}` · `message_update{message, assistantMessageEvent}` ·
`message_end{message}` · `tool_execution_start{toolCallId, toolName, args}` ·
`tool_execution_update{toolCallId, toolName, args, partialResult}` ·
`tool_execution_end{toolCallId, toolName, result, isError}` · `turn_end{message, toolResults}` · `agent_end{messages}`.

Observed for one tool round-trip:
`agent_start turn_start message_start/end(user) message_start message_update×N message_end tool_execution_start tool_execution_update tool_execution_end message_start/end(toolResult) turn_end turn_start message_start message_update×N message_end turn_end agent_end`.
User and toolResult messages also get `message_start` and `message_end`, so filter on `message.role`.

## 4. Verified snippets (type-checked with `tsc --strict`, NodeNext, ESM)

```ts
import { getProviders, getModels, getModel, getEnvApiKey, Type, complete, type Model, type Static } from "@mariozechner/pi-ai";
import { Agent, type AgentTool, type AgentEvent } from "@mariozechner/pi-agent-core";
import { loginAnthropic, getOAuthApiKey, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

// --- list models
for (const provider of getProviders()) {
  const hasKey = !!getEnvApiKey(provider);
  for (const m of getModels(provider))
    console.log(`${m.provider}/${m.id} api=${m.api} ctx=${m.contextWindow} reasoning=${m.reasoning} key=${hasKey}`);
}
const sonnet = getModel("anthropic", "claude-sonnet-4-5");

// --- Agent with one tool + streaming (run end-to-end against registerFauxProvider())
const WeatherParams = Type.Object({ city: Type.String({ description: "City name" }) });
const weatherTool: AgentTool<typeof WeatherParams, { city: string }> = {
  name: "get_weather", label: "Weather", description: "Get current weather for a city",
  parameters: WeatherParams,
  async execute(_id, params: Static<typeof WeatherParams>, signal, onUpdate) {
    onUpdate?.({ content: [{ type: "text", text: "looking up..." }], details: { city: params.city } });
    if (signal?.aborted) throw new Error("aborted");
    return { content: [{ type: "text", text: `Sunny in ${params.city}` }], details: { city: params.city } };
  },
};
const agent = new Agent({
  initialState: { systemPrompt: "You are monarch.", model: sonnet, thinkingLevel: "off", tools: [weatherTool] },
  getApiKey: resolveKey,                       // OAuth-aware, see below
});
agent.subscribe((e: AgentEvent) => {
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") process.stdout.write(e.assistantMessageEvent.delta);
  if (e.type === "tool_execution_start") console.log("\n[tool]", e.toolName, e.args);
  if (e.type === "message_end" && e.message.role === "assistant")
    console.log("\n[usage]", e.message.usage.totalTokens, e.message.usage.cost.total, e.message.stopReason, e.message.errorMessage ?? "");
});
await agent.prompt("What's the weather in Paris?");

// --- Anthropic (Claude Pro/Max) OAuth login + stored creds with auto-refresh
const AUTH = "auth.json";  // monarch: put in a 0600 file under the user's config dir / keychain
type AuthFile = Record<string, OAuthCredentials>;
async function anthropicLogin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const creds = await loginAnthropic({
    onAuth: ({ url, instructions }) => console.log(`Open: ${url}\n${instructions ?? ""}`),
    onPrompt: async ({ message }) => rl.question(`${message} `),   // fallback paste of code/redirect URL
    onProgress: (m) => console.log(m),
  });
  rl.close();
  const auth: AuthFile = existsSync(AUTH) ? JSON.parse(readFileSync(AUTH, "utf8")) : {};
  auth.anthropic = creds;
  writeFileSync(AUTH, JSON.stringify(auth, null, 2), { mode: 0o600 });
}
async function resolveKey(provider: string): Promise<string | undefined> {
  const auth: AuthFile = existsSync(AUTH) ? JSON.parse(readFileSync(AUTH, "utf8")) : {};
  if (auth[provider]) {
    const r = await getOAuthApiKey(provider, auth);   // refreshes when expired; can throw -> catch in prod
    if (r) { auth[provider] = r.newCredentials; writeFileSync(AUTH, JSON.stringify(auth, null, 2), { mode: 0o600 }); return r.apiKey; }
  }
  return getEnvApiKey(provider);
}

// --- custom OpenAI-compatible model (Ollama; LM Studio = http://localhost:1234/v1)
const ollama: Model<"openai-completions"> = {
  id: "qwen3:8b", name: "Qwen3 8B (Ollama)", api: "openai-completions", provider: "ollama",
  baseUrl: "http://localhost:11434/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192,
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
};
const reply = await complete(ollama, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey: "ollama" });
// With Agent: initialState.model = ollama and getApiKey: p => p === "ollama" ? "ollama" : resolveKey(p)
```
Note: `resolveKey` must not throw (Agent hook contract), so wrap the `getOAuthApiKey` refresh in try/catch.

## 5. Gotchas checklist
1. **Deprecated scope**: 0.73.1 is the last `@mariozechner` release. New work happens in `@earendil-works/*` 1.x,
   which has breaking API changes. [V]
2. **ESM-only**, `typebox` 1.x (not `@sinclair/typebox`). [V]
3. **No Gemini CLI / Antigravity** OAuth in 0.73.1 (removed in 0.71.0). Only anthropic, github-copilot and openai-codex. [V]
4. Anthropic OAuth tokens (`sk-ant-oat...`) force a Claude Code identity system prompt and CC headers, and
   rename CC-like tool names on the wire. Avoid tool names like `bash`/`read` if you need exact names in raw
   payloads; they round-trip correctly in pi messages. [V] ToS risk. [U]
5. A missing API key makes `streamSimple` **throw synchronously**. Inside `Agent`, it becomes an error assistant
   message and `prompt()` still resolves. Local servers still need a dummy `apiKey`. [V]
6. Stream and agent errors are data (`stopReason` / `errorMessage`), not exceptions. Check `agent.state.errorMessage`
   after `prompt()`. Use `isContextOverflow()` for compaction triggers. [V]
7. `prompt()` while streaming throws. Queue with `steer()` / `followUp()`. Listeners are awaited, so a slow
   subscriber slows the loop. [V]
8. Tool calls run in **parallel by default**. Set `executionMode:"sequential"` on tools that mutate shared state. [V]
9. Copilot's `onAuth` has a positional `(url, instructions)` signature, unlike the others. Copilot also needs
   `modifyModels` for `baseUrl`. [V]
10. OAuth login opens a local HTTP server: Anthropic on port 53692, Codex on 1455. Run it in the Node main
    process, not a browser or renderer. Set `PI_OAUTH_CALLBACK_HOST` for containers. [V]
11. The model catalog is static per release. New models need a package bump or a hand-built `Model` object. [V]
12. The `CustomAgentMessages` JSDoc says `declare module "@mariozechner/agent"`; the correct name is
    `"@mariozechner/pi-agent-core"` (README). [V]
