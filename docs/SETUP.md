# Setting up models and accounts

Connect a model provider first, then any accounts you want Monarch to work with. For a step-by-step guide with troubleshooting per service, see [INTEGRATIONS.md](INTEGRATIONS.md).

## Models and accounts

### Claude, through your Claude subscription (Agent SDK)

The `claude-sdk` engine runs the **Claude Agent SDK**, which drives the Claude Code CLI on your machine. With *Use subscription* turned on (the default), it uses whatever account `claude` is logged into:

```bash
claude auth login      # once; opens the browser
claude auth status     # check
```

To bill an API key instead, turn *Use subscription* off and store an `ANTHROPIC_API_KEY` in Config → Providers.

> **About terms.** Monarch is a personal tool you run yourself. Using *your own* Claude subscription through the Agent SDK on
> your own machine is personal use. Anthropic's terms do **not** allow a product you distribute to others to offer
> claude.ai / subscription login on their behalf. If you ship Monarch to other people, have them use their own API keys
> (Claude Console) or another provider. Check Anthropic's current Consumer Terms and Usage Policy yourself; this note
> is not legal advice.

### pi engine (any provider)

The `pi` engine (`@earendil-works/pi-ai` and `pi-agent-core`) works with many providers. Configure them in **Config → Providers**:

- **API keys:** Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, xAI, Mistral and others. Keys are stored in `~/.monarch-ai/secrets.json`, or read from the usual environment variables (`OPENAI_API_KEY`, …).
- **OAuth logins:** providers that pi supports through device or browser login, such as GitHub Copilot. Press *Login* and follow the flow.
- **Custom OpenAI-compatible providers:** in **Config → Providers → + Custom provider**, add as many as you like (OpenRouter, Together, Groq, a vLLM box, Ollama at `http://localhost:11434/v1`, LM Studio at `http://localhost:1234/v1`…). Each one has its own name, base URL and API key (optional for local servers). **Discover models** reads the endpoint's `/models` list so you can add models in one click.
- **Switching models:** the engine badge at the top right is a dropdown. Pick any model from any configured provider to make it the default for new sessions. Each chat also has its own model picker.

## Integrations

For a step-by-step guide with troubleshooting, see [docs/INTEGRATIONS.md](INTEGRATIONS.md).

### Google (Gmail and Calendar, several accounts)

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create (or pick) a project.
2. Under **APIs & Services → Library**, enable the **Gmail API** and the **Google Calendar API**.
3. Under **OAuth consent screen**, choose type *External* and leave publishing status at *Testing*. Add every Gmail address you'll connect as a **test user**.
4. Under **Credentials → Create credentials → OAuth client ID**, choose application type **Desktop app**. Copy the client ID and secret.
5. In Monarch, open **Config → Accounts**, paste the client ID and secret (**Save client**), then use **Connect** once per account.

Sign-in happens in your browser. It redirects back to the core at `http://127.0.0.1:7717/oauth/google/callback`. Desktop-app clients accept any loopback redirect, so you don't need to register that URI.

> While the app is in *Testing*, Google expires refresh tokens after 7 days, so you will need to reconnect each account weekly. Publishing the app for personal use removes this limit, though Google may show an "unverified app" warning.

### Slack

1. Go to <https://api.slack.com/apps>, choose **Create New App → From scratch**, and pick your workspace.
2. Under **OAuth & Permissions → User Token Scopes**, add:
   `channels:history channels:read groups:history groups:read im:history im:read mpim:history mpim:read users:read search:read chat:write channels:write groups:write im:write mpim:write reactions:read reactions:write users:read.email`
3. Press **Install to Workspace** and approve.
4. Copy the **User OAuth Token** (`xoxp-…`) into **Config → Accounts → Slack**.

Messages are posted as you, and every send goes through approval.

### Memory vault

The default vault is `~/.monarch-ai/vault`. To use an existing Obsidian vault, point **Config → Memory → Vault directory** at it. Notes stay plain markdown with frontmatter, `[[links]]` and `#tags`, so Obsidian and Monarch can both edit them.

### Extensions and skills

An extension is a folder `~/.monarch-ai/extensions/<id>/` holding `extension.json` (manifest) and `index.mjs`, which exports `activate(api)`. With `api.tool`, `api.panel`, `api.job`, `api.store`, `api.secrets`, `api.notify` and `api.z` (zod) it adds tools the agent can call, panels for the Evolve page, and interval jobs. The full reference is in **Evolve → New → API reference**, and the agent reads it before writing one. One builtin extension is seeded: **Follow-ups**, which tracks what you owe people and what you are waiting on, with due dates, a morning digest notification and a panel. It needs no permissions and doubles as the reference example the agent learns from.

Each extension runs in its own Node child process under Node's permission model:

- **Default:** it can read only its own folder, write only its `data/` dir, and has no network, child processes, or environment secrets.
- **Opt-in permissions:** the manifest can grant `network`, `shell` (effectively unsandboxed), `fs` (your home dir, which includes Monarch's data, so treat it as high trust) and `secrets` (values you enter in Evolve).
- **Node versions:** network blocking needs Node 25 or newer; on older Node it falls back to a `fetch` guard.

Agent-written extensions go through the normal approval gates. With **Config → Evolution → Auto-enable** off, they wait in Evolve for your review. Turning off **Self-modification** blocks agent writes completely.

Skills are markdown files in `~/.monarch-ai/skills/`. Their names are listed in the system prompt, and the agent reads one before doing that task.
