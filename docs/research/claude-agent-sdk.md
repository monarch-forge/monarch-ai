# Claude Agent SDK (TypeScript) — research notes

Package: `@anthropic-ai/claude-agent-sdk@0.3.323` (bundles Claude Code `2.1.323`). Researched 2026-11-13.

Legend:
- **[typings]**: read from `sdk.d.ts` in 0.3.323.
- **[live]**: run on this machine against the user's Pro login, using `~/.local/bin/claude` 2.1.323 via `pathToClaudeCodeExecutable`, Node 26.
- **[docs]**: code.claude.com/docs/en/agent-sdk/* or support.claude.com.
- **[unverified]**: inferred and not tested.

---

## 0. Package shape and runtime (gotchas first)

- **ESM only.** `"type": "module"`, `main: sdk.mjs`. The package defines `exports` for `.`, `./core` (a slimmer entry that does not inline zod/MCP), `./extract`, `./browser`, `./bridge` and `./sdk-tools`. **[typings]**
- **Node `>=18.14.0`** per `engines`. Our root package requires `>=22`, so we're fine. **[typings]**
- **Peer deps:** `zod ^4.0.0`, `@modelcontextprotocol/sdk ^1.29.0` and `@anthropic-ai/sdk >=0.93.0`. npm 7+ installs them automatically. The CHANGELOG says yarn classic users need to add them by hand. **[typings][docs]**
- **The SDK does not need the user's installed `claude`.** It brings its own **native binary** through a platform optionalDependency (`@anthropic-ai/claude-agent-sdk-linux-x64` and the other platforms). It finds that binary with `require.resolve`. If the binary is missing, it throws `Native CLI binary for linux-x64 not found. Reinstall ... without --omit=optional, or set options.pathToClaudeCodeExecutable.` **[typings + sdk.mjs]**
  - The binary is **~362 MB per platform** according to `manifest.json`. That matters for a Tauri bundle. One option is `npm i --omit=optional` plus `pathToClaudeCodeExecutable: ~/.local/bin/claude`, which reuses the user's install. A bare `"claude"` resolves through PATH (CHANGELOG fix). Keep the versions close: the SDK speaks a control protocol, and an old CLI triggers `cli_version_too_old`.
  - `executable: 'bun'|'deno'|'node'` and `executableArgs` are still present, but they only matter for a JS CLI entrypoint. They don't apply to the native binary. **[unverified]**
- **Process per `query()`.** Every `query()` spawns one CLI subprocess and talks stream-json over stdio. **[live]** Measured: the `system/init` message arrived **~355 ms** after `query()`, and a 2-turn tool round trip on haiku took ~8.5 s. Ways to cut spawn cost:
  - `startup({options})` returns a `WarmQuery` with `.query(prompt)`.
  - `prewarm({options})` returns a `SpareProcess` with `.claim(...)` (@alpha).
  - Best for a chat UI: keep **one long-lived streaming-input query per conversation**.
- **`settingSources` default changed.** According to the current typings, when it's omitted **all** sources (`user`, `project`, `local`) are loaded, matching the CLI. Older 0.1.x docs said "none". For an embedded assistant, pass **`settingSources: []`** so the user's `~/.claude/settings.json` hooks, permissions, CLAUDE.md, plugins and MCP config don't leak in. You need `'project'` to load CLAUDE.md. **[typings + sdk.mjs: the `--setting-sources` flag is only sent when the option is defined]**
  - `strictMcpConfig: true` ignores `.mcp.json`, user, and plugin MCP servers. **[typings]**
  - Managed (enterprise) settings always apply.
- **`env` REPLACES `process.env`** for the subprocess. It is not merged. If you omit `env`, the subprocess inherits `process.env`. Always pass `env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'monarch-ai/0.1' }`. **[typings + CHANGELOG "Breaking"]**
  - Inherited `ANTHROPIC_API_KEY` silently wins over the subscription (see §5).
- **Single-prompt mode throws on error results.** With a string prompt, the async iterator first **yields** the error `result` and then **throws** `Error("Claude Code returned an error result: ...")`. **[docs][live]**
  - The same thing happened in streaming mode once the input iterable finished after an error result. That case was an interrupt, which produced `error_during_execution`. **[live]**
  - Always wrap `for await` in try/catch.
- **Generator errors are masked.** If your input generator throws, the stream ends with `Claude Code process aborted by user`, and a huge minified source line is printed to stderr. **[docs][live: we saw the minified dump]**
- **MCP servers connect in the background.** `init` may show `status: "pending"`. Use `alwaysLoad: true` to require a server on turn 1. **[CHANGELOG 0.3.x breaking]**
- **Tool search is on by default.** SDK MCP tools are deferred, and the model may call `ToolSearch` first. Set `alwaysLoad: true` on `createSdkMcpServer` or on `tool()` to keep schemas in the prompt. **[docs]**
- **Sessions are written to disk** at `~/.claude/projects/<cwd with non-alphanumerics replaced by '->/<id>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`). Use `persistSession: false` to disable that. **[docs]**

---

## 1. `query({ prompt, options })` — the important `Options` fields [typings]

```ts
query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query
```

| Field | Type / semantics |
|---|---|
| `model` | `string`. Accepts aliases like `'haiku' \| 'sonnet' \| 'opus' \| 'fable' \| 'default'` or full ids. **[live]** `supportedModels()` returned aliases plus `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-haiku-4-5-20251001` and others. `'haiku'` resolved to `claude-haiku-5-5` in init. Related: `fallbackModel?: string` (comma list). |
| `systemPrompt` | One of: `string`, `string[]` (put `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` between the cacheable prefix and the dynamic suffix), `{type:'custom', prompt, snapshot?}`, or `{type:'preset', preset:'claude_code', append?, excludeDynamicSections?, snapshot?}`. A plain string **replaces** Claude Code's prompt. The preset plus `append` keeps the CC prompt. `snapshot` (default true) records the prompt on first request; a later change to `append` is **ignored on resume** until compaction. |
| `cwd` | Defaults to `process.cwd()`. Related: `additionalDirectories?: string[]`. |
| `tools` | Controls which built-ins are **available**. `string[]` lists them, `[]` removes **all built-ins** (MCP tools are unaffected), and `{type:'preset',preset:'claude_code'}` gives the defaults. `BUILTIN_TOOL_NAMES` is exported. |
| `allowedTools` | **Permission** layer: auto-approved names or rules (`'mcp__monarch__*'`, `'Bash(git status)'`). It does NOT restrict availability. |
| `disallowedTools` | A bare name removes the tool from context. A scoped rule (`'Bash(rm *)'`) denies only matching calls. |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'`. **If omitted**, it uses settings `defaultMode`, else `'auto'` (a classifier) where available. **Pass `'default'` so non-allowed calls reach `canUseTool`.** `bypassPermissions` also needs `allowDangerouslySkipPermissions: true`. Related: `permissionPrompts?: 'host' \| 'none'`. |
| `canUseTool` | See §1a. |
| `mcpServers` | `Record<string, McpStdioServerConfig \| McpSSEServerConfig \| McpHttpServerConfig \| McpSdkServerConfigWithInstance>` |
| `resume` | `string` session id. Combine with `forkSession?: boolean` to branch to a new id. `resumeSessionAt?: uuid` truncates. |
| `continue` | `boolean`: the most recent session in `cwd`. Mutually exclusive with `resume`. |
| `sessionId` | A UUID for a **new** session. It can't be combined with `resume`/`continue` unless `forkSession` is set. |
| `includePartialMessages` | `boolean`: emits `stream_event` messages (see §3). |
| `abortController` | `AbortController`: abort kills the query and cleans up. Related: `Query.close()`. |
| `maxTurns` | `number`. Related: `maxBudgetUsd` (gives `error_max_budget_usd`), `taskBudget` (@alpha). |
| `pathToClaudeCodeExecutable` | Defaults to the bundled native binary (see §0). |
| `executable` / `executableArgs` | `'bun' \| 'deno' \| 'node'`. Legacy (see §0). |
| `env` | **Replaces** the env (see §0). |
| `settingSources` | `('user' \| 'project' \| 'local')[]`. **Omitted means all.** `[]` gives isolation. Related: `settings?: string \| Settings` (flag layer), `managedSettings`. |
| `thinking` | `{type:'adaptive', display?} \| {type:'enabled', budgetTokens?, display?} \| {type:'disabled'}`. Adaptive is the default where the model supports it. `display` is `'summarized' \| 'omitted'`. |
| `maxThinkingTokens` | **@deprecated**. Use `thinking`. |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` (`EffortLevel`). The effective value is echoed in `init.effort`. |
| Other useful fields | `persistSession`, `hooks` (`Partial<Record<HookEvent, HookCallbackMatcher[]>>`), `agents`, `outputFormat` (`{type:'json_schema', schema}` puts the result in `structured_output`), `stderr: (d)=>void`, `debug`, `debugFile`, `title`, `plugins`, `skills`, `sandbox`, `enableFileCheckpointing`, `promptSuggestions`, `verbatimPrompts` (no `@file`/slash expansion; good for assembled prompts), `toolAliases`, `spawnClaudeCodeProcess` (custom spawn for VM/container). |

### 1a. `canUseTool` [typings][live]

```ts
type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];   // return as updatedPermissions for "always allow"
  blockedPath?: string;
  decisionReason?: string;
  title?: string; displayName?: string; description?: string; // ready-made prompt strings
  toolUseID: string; agentID?: string; requestId: string;
  mcpServer?: { name: string; source: string };  // source 'sdk' = our in-process server; trust on this
  defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean;
  matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
}) => Promise<PermissionResult | null>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[];
      toolUseID?: string; decisionClassification?: 'user_temporary'|'user_permanent'|'user_reject' }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string; decisionClassification?: ... };
```

- The callback only runs for calls that rules or mode didn't already decide. **[live]** An SDK MCP tool that was not in `allowedTools`, with `permissionMode:'default'`, reached `canUseTool` with `mcpServer.source === 'sdk'`.
- `updatedInput` is optional; if you omit it, the original input is used (CHANGELOG fix).
- `deny` with `interrupt: true` also stops the turn.
- What returning `null` means is undocumented in the typings. It looks like "no answer from this client" (multi-client). Don't return `null`. **[unverified]**
- You can force a prompt even when a tool is allowed. Spread the config returned by `createSdkMcpServer()` and add `tools: [{ name, permission_policy: 'always_ask' }]`. This is TS-only and needs SDK ≥0.3.301. **[docs]**

---

## 2. Input modes and `Query` control methods [typings][docs][live]

- **String prompt** (single-message mode): the process exits after the turn. It has no images and no mid-session control. Use `continue`/`resume` for follow-ups.
- **`AsyncIterable<SDKUserMessage>`** (streaming input, which the docs recommend):
  - One long-lived process; each yielded message is a new user turn.
  - Images go in content blocks.
  - All control methods work.
  - The process stays alive until your iterable **returns**. To end the session, finish the generator, call `q.close()`, or abort.
  - `SDKUserMessage` minimum: `{ type:'user', message:{ role:'user', content: string | ContentBlockParam[] }, parent_tool_use_id: null }`. `session_id` and `uuid` are optional. `shouldQuery:false` appends to the transcript without starting a turn. `priority: 'now'|'next'|'later'`.
- `Query extends AsyncGenerator<SDKMessage, void>`. The control methods ("only supported in streaming input mode") are:
  - `interrupt(): Promise<SDKControlInterruptResponse | undefined>`. **[live]** It returned `{ still_queued: [] }`. The partial assistant message then arrives with `aborted: true` and `stop_reason: null`, followed by `result{subtype:'error_during_execution', terminal_reason:'aborted_streaming'}`.
  - `setModel(model?: string)`, `setPermissionMode(mode)`, `setMaxThinkingTokens(n|null, display?)` (deprecated), `applyFlagSettings({...})` (for example `effortLevel`).
  - Introspection:
    - `initializationResult()`: commands, agents, models, account, and output styles.
    - `supportedModels(): ModelInfo[]` gives `value`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels` and `supportsAdaptiveThinking`.
    - `supportedCommands()`, `supportedAgents()`, `mcpServerStatus()`, `getContextUsage()`.
    - `accountInfo(): AccountInfo` gives `{email?, organization?, subscriptionType?, tokenSource?, apiKeySource?, apiProvider?}`.
    - `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` reports plan rate-limit windows.
  - Runtime changes: `setMcpServers(record)`, `toggleMcpServer`, `reconnectMcpServer`, `streamInput(iterable)`, `stopTask(id)`, `rewindFiles(uuid)`, `close()`.

---

## 3. `SDKMessage` union — what we handle [typings][live]

`SDKMessage` is a union of about 40 types, discriminated by `type` and then `subtype`. Ignore the ones you don't know. The ones that matter:

| `type` / `subtype` | TS type | Key fields |
|---|---|---|
| `'system'` / `'init'` | `SDKSystemMessage` | `session_id`, `model`, `tools: string[]`, `mcp_servers: {name,status,source?}[]`, `apiKeySource`, `permissionMode`, `cwd`, `claude_code_version`, `slash_commands`, `skills`, `effort?`, `capabilities?` |
| `'assistant'` | `SDKAssistantMessage` | `message: BetaMessage` (content blocks: `text`, `thinking`, `redacted_thinking`, `tool_use{id,name,input}`); `parent_tool_use_id` (non-null means a subagent); `error?: SDKAssistantMessageError` (`'authentication_failed' \| 'rate_limit' \| 'billing_error' \| ...`); `aborted?: true`; `uuid`; `session_id`. Each **block arrives as its own assistant message** sharing `message.id`. |
| `'user'` | `SDKUserMessage` / `SDKUserMessageReplay` | `message.content` holds `tool_result` blocks; `tool_use_result?: unknown` is the structured tool output. |
| `'stream_event'` | `SDKPartialAssistantMessage` | `event: BetaRawMessageStreamEvent` (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`). For text: `event.type==='content_block_delta' && event.delta.type==='text_delta'` gives `event.delta.text`. Thinking arrives as `thinking_delta`; tool input arrives as `input_json_delta`. `ttft_ms?`. |
| `'result'` / `'success'` | `SDKResultSuccess` | `result: string`, `is_error` (can be **true even with subtype success**, e.g. "Not logged in" **[live]**), `total_cost_usd`, `usage` (main loop only), `modelUsage: Record<string, ModelUsage>` (use this for accounting), `duration_ms`, `duration_api_ms`, `num_turns`, `stop_reason`, `terminal_reason?`, `structured_output?`, `permission_denials`, `credential_expires_at?`, `session_id` |
| `'result'` / `'error_during_execution' \| 'error_max_turns' \| 'error_max_budget_usd' \| 'error_max_structured_output_retries'` | `SDKResultError` | `errors: string[]` plus the same cost and usage fields |
| `'rate_limit_event'` | `SDKRateLimitEvent` | `rate_limit_info{status:'allowed'\|'allowed_warning'\|'rejected', rateLimitType:'five_hour'\|'seven_day'\|..., resetsAt?, utilization?}`. This is **subscription-specific** and useful for UI. **[live: emitted on Pro]** |
| `'system'` / `'status'`, `'api_retry'`, `'compact_boundary'`, task_*, hook_* ... | various | Informational. |
| `'auth_status'` | `SDKAuthStatusMessage` | `isAuthenticating`, `output[]`, `error?` |

- `result` is the turn-complete signal: there is exactly one per turn.
- In streaming mode, `total_cost_usd` and `modelUsage` are **cumulative**. Read the latest values; don't sum them.
- With a subscription, `total_cost_usd` is an API-price *estimate*, not a charge. **[live]** We saw `$0.0004` on Pro.

---

## 4. Custom tools: in-process MCP [typings][docs][live]

```ts
tool<Schema extends AnyZodRawShape>(name, description, inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean }): SdkMcpToolDefinition<Schema>
createSdkMcpServer({ name, version?, instructions?, tools?, alwaysLoad?, timeout? /*ms*/ }): McpSdkServerConfigWithInstance
```

- **Zod:** the peer dependency is `zod ^4`. `AnyZodRawShape = ZodRawShape (zod/v3) | ZodRawShape (zod/v4)`, so the types accept a **raw shape object** (`{ a: z.string() }`), not `z.object(...)`.
  - Use `import { z } from "zod"` with zod 4 (verified with 4.6.7).
  - A zod 3 shape through the `zod/v3` subpath type-checks, but we did not run it. **[unverified at runtime]**
  - `.describe()` on a field reaches the model.
- **Tool name** is `mcp__<serverKey>__<toolName>`. `serverKey` is the **key in `mcpServers`**, not `name`; characters like `.` and spaces become `_`. Wildcard: `mcp__monarch__*`. **[docs][live: `mcp__monarch__get_time`]**
- **Handler return** is MCP `CallToolResult`: `{ content: Array<{type:'text',text} | {type:'image',data(base64),mimeType} | {type:'audio',...} | {type:'resource',resource:{uri,text|blob,mimeType?}} | {type:'resource_link',...}>, isError?: boolean, structuredContent?: object }`.
  - A thrown exception becomes an error result, and the loop continues.
  - If `structuredContent` is set, the text blocks are **not** sent to the model.
- `annotations.readOnlyHint: true` allows parallel calls. Set `destructiveHint: true` explicitly on tools that should always prompt.
- In-process (`type:'sdk'`) servers run in our Node process; the CLI proxies them over the control channel.
- `timeout` is per server and must be ≥1000 ms. The default is effectively unbounded, or `MCP_TOOL_TIMEOUT`.
- The old docs said SDK MCP servers require streaming input. **[live]** A streaming-input session worked. We did not test them with a string prompt in this version. **[unverified]**

---

## 5. Authentication and subscription use

**Precedence** (Claude Code, which the SDK spawns) **[docs: code.claude.com/docs/en/authentication]**:

1. Cloud provider env (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`)
2. `ANTHROPIC_AUTH_TOKEN` (bearer, for gateways)
3. `ANTHROPIC_API_KEY`. In non-interactive (SDK/`-p`) mode it is **always used when present**.
4. `apiKeyHelper` script
5. `CLAUDE_CODE_OAUTH_TOKEN`, a 1-year token from `claude setup-token`. That command prints the token and doesn't store it. It needs a Pro/Max/Ultra/Team/Enterprise plan and is model-requests only.
6. Anthropic profile / federation credentials
7. **Subscription OAuth from `/login`**, stored in `~/.claude/.credentials.json` (mode 0600, Linux) or `$CLAUDE_CONFIG_DIR/.credentials.json`. It auto-refreshes.

**How we get the subscription:**
- Do nothing. The spawned CLI reads the same `~/.claude/.credentials.json` that the user's `claude` login wrote. **[live]** `init.apiKeySource === 'none'` and `accountInfo()` returned `{subscriptionType:'Claude Pro', apiProvider:'firstParty'}`. This worked with both the installed binary and SDK defaults.
- **Make sure `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are not inherited** if you want the subscription: build `env` without them.
- `--bare` mode does not read `CLAUDE_CODE_OAUTH_TOKEN`.
- Caveat: our live test ran inside an environment with `ANTHROPIC_BASE_URL` set (the host harness's proxy), so the network path was not fully stock. **[note]**

**Detecting auth status programmatically:**
- **`claude auth status`** (JSON by default, `--text` for text). Exit code 0 when logged in, **1 when not**. **[live]** Output: `{loggedIn, authMethod:'claude.ai'|'none'|..., apiProvider, subscriptionType:'pro', planTier, loginExpiresAt, email, orgId, orgName, configDirectory}`. This is the cheapest pre-flight check because it doesn't run a model call. Use the SDK's bundled binary path or `~/.local/bin/claude`.
- In-session:
  - `await q.accountInfo()`. Logged out, it gives `{tokenSource:'none', apiProvider:'firstParty'}` with no `subscriptionType`. **[live]**
  - `init.apiKeySource`.
  - An assistant message with `error === 'authentication_failed'`, followed by `result{subtype:'success', is_error:true, result:'Not logged in · Please run /login'}`. The iterator then **throws** in single-prompt mode. **[live, using `CLAUDE_CONFIG_DIR` pointed at an empty dir]**
- `result.credential_expires_at` and `SDKRateLimitEvent` show login expiry and plan-limit state. The SDK also exports `USAGE_LIMIT_ERROR_PREFIXES` for matching limit errors.
- Login cannot be done through the SDK; the user runs `claude auth login` / `/login`.

**Terms (read carefully) [docs]:**
- Agent SDK overview: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."*
- Legal and compliance:
  - OAuth is intended for subscribers' *"ordinary use of Claude Code and other native Anthropic applications"*.
  - Developers building products should use API keys.
  - Developers must not *"collect, store, or intermediate Claude.ai credentials or session tokens"*.
  - It also says *"Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK"*.
  - It does not prevent *"an end user from signing in to the unmodified Claude Code binary with their own Claude subscription"*.
- Our reading: a personal, self-used tool that spawns the unmodified CLI under the user's *own* login is the grey-but-tolerated "individual usage" case. Shipping monarch-ai to other people with claude.ai login as a feature is not allowed without approval. Do **not** have monarch read, copy, or store `.credentials.json` or OAuth tokens itself; let the CLI own them. Offer API-key auth as the supported path. **[interpretation, not legal advice]**
- Billing **[docs: support article 15036540]**:
  - The planned June 15, 2026 "Agent SDK credit" change was **paused**.
  - Plan-signed-in SDK and `claude -p` usage draws from normal subscription limits.
  - An Oct 2026 update adds monthly API credits on Max/Ultra/Team for API-key usage from a linked Console org.
  - This is still changing, so re-check before relying on it.

---

## 6. Verified snippet: streaming chat + partials + in-process tool + approval + resume

Type-checked with `tsc --strict --module nodenext` and run live (output trimmed). Run results:
- init: `tools:['mcp__monarch__get_time']`, `mcp:[{name:'monarch',status:'connected',source:'sdk'}]`
- canUseTool called once for `mcp__monarch__get_time` (src=sdk)
- result: `success`, `"TIME OK"`, `num_turns` 2
- resume: same `session_id`, and the model recalled "TIME OK"

```ts
import { query, tool, createSdkMcpServer, type SDKUserMessage, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod"; // zod 4

const getTime = tool(
  "get_time",
  "Return the current local time as ISO string",
  { tz: z.string().optional().describe("IANA timezone, optional") },
  async (args) => ({ content: [{ type: "text", text: `now=${new Date().toISOString()} tz=${args.tz ?? "local"}` }] }),
  { annotations: { readOnlyHint: true } },
);
const monarch = createSdkMcpServer({ name: "monarch", version: "0.1.0", tools: [getTime] });

const canUseTool: CanUseTool = async (toolName, input, opts) => {
  // route to UI here; opts.title / opts.description are ready-made prompt strings
  if (opts.mcpServer?.source === "sdk" && toolName.startsWith("mcp__monarch__"))
    return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: "User declined" };
};

// push-queue usable as AsyncIterable<SDKUserMessage>
function makeInput() {
  const queue: SDKUserMessage[] = []; let wake: (() => void) | null = null; let closed = false;
  return {
    push(text: string) { queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (wake = r)); wake = null;
      }
    },
  };
}

const { ANTHROPIC_API_KEY: _drop, ...baseEnv } = process.env; // keep subscription auth
const input = makeInput();
input.push("Call the get_time tool once, then reply with exactly: TIME OK");

const q = query({
  prompt: input,
  options: {
    model: "haiku",
    systemPrompt: "You are a terse test assistant.",  // replaces CC prompt; or {type:'preset',preset:'claude_code',append}
    tools: [],                                       // no built-ins
    mcpServers: { monarch },                         // key "monarch" => mcp__monarch__*
    canUseTool,
    permissionMode: "default",                       // don't let 'auto' classifier decide
    includePartialMessages: true,
    settingSources: [],                              // isolate from ~/.claude settings
    maxTurns: 4,
    env: { ...baseEnv, CLAUDE_AGENT_SDK_CLIENT_APP: "monarch-ai/0.1.0" },
    // pathToClaudeCodeExecutable: `${process.env.HOME}/.local/bin/claude`,
  },
});

let sessionId = "";
try {
  for await (const m of q) {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") { sessionId = m.session_id; console.log(m.model, m.tools, await q.accountInfo()); }
        break;
      case "stream_event":
        if (m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") process.stdout.write(m.event.delta.text);
        break;
      case "assistant":
        for (const b of m.message.content) if (b.type === "tool_use") console.log("\n[tool]", b.name, b.input);
        if (m.error) console.error("assistant error:", m.error); // e.g. 'authentication_failed'
        break;
      case "result":
        console.log("\n", m.subtype, m.is_error, m.total_cost_usd, m.subtype === "success" ? m.result : m.errors);
        input.close(); // end session (or input.push(...) for the next turn; q.interrupt() to stop mid-turn)
        break;
    }
  }
} catch (e) { console.error("query failed:", e); }

// Later / after restart: resume by id (string prompt = one-shot)
for await (const m of query({
  prompt: "What exact phrase did you reply with last time?",
  options: { model: "haiku", resume: sessionId, tools: [], settingSources: [], maxTurns: 1 },
})) {
  if (m.type === "result" && m.subtype === "success") console.log(m.result, m.session_id === sessionId); // "TIME OK" true
}
```

This exact block was re-run live, with only `pathToClaudeCodeExecutable` uncommented. Output: `[tool] mcp__monarch__get_time {}`, streamed `TIME OK`, `success false 0.0002 TIME OK`, then `"TIME OK" true` from the resume. To fork instead of continuing, add `forkSession: true` and read the new id from `init.session_id`.

---

## 7. Recommendations for monarch-ai's provider adapter

1. Run one long-lived streaming `query()` per conversation and map our turn API to `input.push()`. Use `q.interrupt()` for "stop" and `q.setModel()` / `applyFlagSettings({effortLevel})` for live switches. Persist `session_id` and `resume` it after a restart.
2. Always pass:
   - `settingSources: []`
   - `strictMcpConfig: true`
   - an explicit `permissionMode: 'default'`
   - `tools: [...]` (an explicit allowlist, or `[]` with only our MCP tools)
   - an explicit `env` without `ANTHROPIC_API_KEY` when "use subscription" is selected
3. Before the first query, run `claude auth status --json` (exit code plus `subscriptionType`) as a pre-flight check, and show "run `claude auth login`" when it fails. Never touch the credentials file ourselves.
4. Keep the SDK, and bundling the 362 MB binary, optional. Default `pathToClaudeCodeExecutable` to the user's installed `claude` and check `claude --version` against `package.json#claudeCodeVersion`.
5. Treat `modelUsage` and `rate_limit_event` as telemetry. Treat cost as an estimate under a subscription.

Sources:
- code.claude.com/docs/en/agent-sdk/{overview,custom-tools,sessions,streaming-vs-single-mode}.md
- code.claude.com/docs/en/authentication.md
- code.claude.com/docs/en/legal-and-compliance.md
- support.claude.com/en/articles/15036540
- github.com/anthropics/claude-agent-sdk-typescript CHANGELOG.md
- `sdk.d.ts` from @anthropic-ai/claude-agent-sdk@0.3.323
