# Monarch

**Monarch AI** is a personal "agentic OS" in the style of Jarvis: a calm heads-up dashboard plus an AI agent that
can chat, write code, triage several Gmail accounts and Slack, keep notes in an Obsidian-compatible vault, run your
calendar, tasks and automations, and watch your machine. Risky actions go through approval gates.

It runs as a local web app (`http://localhost:5173`) or as a native desktop app built with Tauri v2.

## Features

- **HUD dashboard.** Clock, weather, agenda, unread counts, system telemetry, an activity log and the agent's state, laid out on a dense, low-key grid (no neon).
- **Chat.** Responses stream in. Tool calls show up as cards you can expand, risky tools pause for your approval, and you can choose the engine per session.
- **Coding workshop.** Point the agent at a workspace. It uses Claude Code's own tools (Claude Agent SDK) or pi's coding tools: read, edit, bash, grep and so on.
- **Mail.** Several Gmail accounts in one place, with read, search, draft and send. Sending always needs approval.
- **Slack.** Read channels and DMs, search, and post as yourself with a user token.
- **Memory.** An Obsidian-compatible markdown vault with `[[wikilinks]]`, tags, backlinks and a graph view. The agent reads and writes it.
- **Agenda.** Google Calendar, plus local tasks, reminders and cron-style automations.
- **Systems.** Live CPU, memory, disk, network, battery and process telemetry.
- **Voice.** Cloud speech in and out: the mic in the console and in Comms records your request, which is transcribed by OpenAI, Groq or any OpenAI-compatible endpoint. Replies are spoken by OpenAI, ElevenLabs or any OpenAI-compatible text-to-speech service. Set it up in **Config → Voice**: pick a provider and add its API key. On Linux the core records with `pw-record` (or `parecord` or `arecord`), stops when you go quiet, and plays replies with `pw-play`, so it doesn't depend on the webview.
- **Self-evolution.** Monarch extends itself. Ask it (or use **Evolve → Forge**) for a capability it lacks and it writes, sandboxes and tests a new extension (tools, dashboard panels, background jobs) or a skill (a learned procedure). Every change is versioned with rollback and logged on a timeline. An optional daily or weekly self-reflection turns friction into proposals you approve.
- **Lean prompts.** Only about 14 core tools load into each prompt. The rest, including every extension tool, are found on demand through tool search (Claude Code's native ToolSearch, or `tool_search` on pi). That roughly halves the prompt.
- **Command palette.** Press `Ctrl/⌘+K` for everything.

## Architecture

```
┌──────────────────────────── Monarch.app (Tauri v2, src-tauri/) ─────────────────────────────┐
│                                                                                             │
│   WebView ── apps/ui (Vite 8 + Preact 10 + Tailwind 4 + daisyUI 5)                          │
│      │  REST  http://127.0.0.1:7717/api/*                                                   │
│      │  WS    ws://127.0.0.1:7717/ws      (ServerEvent ⇄ ClientCommand, packages/shared)    │
│      ▼                                                                                      │
│   Rust shell (lib.rs) ── spawns ──►  Node core  apps/core  (Hono + ws, 127.0.0.1:7717)      │
│      • stdin pipe = "parent alive"     ├─ agent/      engines: Claude Agent SDK │ pi        │
│      • open_external / core_status     ├─ tools/      system, productivity, web, coding,    │
│      • logs → ~/.monarch-ai/logs/          │              mail, slack, memory  (approval gates) │
│                                        ├─ integrations/ google (Gmail+Calendar), slack,     │
│                                        │                memory vault                        │
│                                        └─ services/   scheduler, usage, telemetry, …        │
│                                                │                                            │
└────────────────────────────────────────────────┼────────────────────────────────────────────┘
                                                 ▼
                     ~/.monarch-ai/  settings · secrets.json · sessions · vault · logs
                     claude CLI (your Claude Code login) · LLM providers · Google · Slack APIs
```

- `packages/shared/src/protocol.ts` defines every REST and WebSocket type. It is the contract between UI and core.
- In a browser, the UI talks to the core directly. In the desktop app the Rust shell starts the core first, unless one is already listening on `:7717`.
- `docs/ARCHITECTURE.md` lists module ownership, and `docs/research/` holds the verified API notes.

## Install

Prebuilt installers for every platform are attached to each
[GitHub release](https://github.com/monarch-forge/monarch-ai/releases). Two things are needed at runtime:

- **Node.js ≥ 22.19** on your `PATH`. The app runs its core with your local `node`.
- **Claude Code**, logged in with `claude auth login`. Only needed for the Claude engine, which uses your Claude subscription.

The builds are unsigned, so macOS and Windows warn the first time you open the app.

### Arch Linux

Download the `monarch-ai-bin` package from the release, then install the local file. `pacman` pulls in
`webkit2gtk-4.1`, `gtk3` and `nodejs`:

```bash
curl -LO https://github.com/monarch-forge/monarch-ai/releases/download/v0.3.3/monarch-ai-bin-0.3.3-1-x86_64.pkg.tar.zst
sudo pacman -U ./monarch-ai-bin-0.3.3-1-x86_64.pkg.tar.zst
```

Don't pass the URL straight to `pacman -U`. The package isn't GPG-signed, and pacman's default
`RemoteFileSigLevel = Required` rejects unsigned remote packages (a 404 on the `.sig` file). Local files only need
an optional signature.

Optional extras for desktop notifications, opening links and OAuth pages in your browser, and faster code search:

```bash
sudo pacman -S --needed libnotify xdg-utils ripgrep
```

Monarch then appears in your application menu, or you can run `monarch`. To build the package yourself instead,
use the PKGBUILD (it repackages the release `.deb`; set `pkgver` to the release you want):

```bash
cd packaging/arch && makepkg -si
```

Uninstall with `sudo pacman -R monarch-ai-bin`. Your data in `~/.monarch-ai` is kept.

### Debian / Ubuntu

```bash
sudo apt install ./Monarch_0.3.3_amd64.deb
```

### Fedora / openSUSE

```bash
sudo dnf install ./Monarch-0.3.3-1.x86_64.rpm
```

### Any Linux (AppImage)

```bash
chmod +x Monarch_0.3.3_amd64.AppImage && ./Monarch_0.3.3_amd64.AppImage
```

### macOS

Open `Monarch_0.3.3_aarch64.dmg` (Apple Silicon) or `Monarch_0.3.3_x64.dmg` (Intel) and drag Monarch to
Applications. The app is unsigned: on first launch, right-click it and choose **Open**, or run
`xattr -dr com.apple.quarantine /Applications/Monarch.app`.

### Windows

Run `Monarch_0.3.3_x64-setup.exe`, or `Monarch_0.3.3_x64_en-US.msi`. If SmartScreen appears, choose **More info → Run anyway**.

### Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds Linux, macOS (arm64 and x64) and Windows
with Tauri, publishes a GitHub release, and then `.github/workflows/arch.yml` attaches the Arch package and
its PKGBUILD. To add the Arch package to an existing release, run the **Arch package** workflow by hand with
that tag.

## Requirements (building from source)

| | |
|---|---|
| **Node** | ≥ 22.19 (developed on 26.x). The desktop app runs your system `node` |
| **Claude Code** | Needed for the Claude engine: `npm i -g @anthropic-ai/claude-code`, then `claude auth login` |
| **Rust** (desktop only) | Install via [rustup](https://rustup.rs). Any stable ≥ 1.90 works (edition 2024; Tauri 2.12 needs 1.90) |
| **System libraries** (desktop only, Linux) | See below |

**Rust toolchain.** If `cargo` reports *"no default toolchain configured"*, pick one:

```bash
rustup default stable        # or pin the one already installed, e.g.  rustup default 1.99.1
```

**Linux packages for Tauri:**

```bash
# Arch
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel && sudo dnf group install c-development
```

macOS needs Xcode Command Line Tools (`xcode-select --install`). Windows needs the MSVC build tools and WebView2, which is preinstalled on Windows 11.

## Development

```bash
npm install

# Browser: core on :7717 (tsx watch) + UI on http://localhost:5173
npm run dev

# or each half on its own
npm run dev:core
npm run dev:ui

# Desktop: Tauri window around the Vite dev server
npm run tauri:dev
```

How `tauri:dev` handles the core:

- In debug builds the shell runs the core straight from TypeScript (`node --import tsx apps/core/src/index.ts`) and restarts it with each new app launch. That run does not hot-reload.
- For hot reload, start `npm run dev:core` in another terminal first. The shell sees that `127.0.0.1:7717` is taken, uses that core, and leaves it running when you quit.
- Set `MONARCH_EXTERNAL_CORE=1` to stop the shell from ever spawning the core.

Typecheck with `npm run typecheck`. `.claude/launch.json` defines `core` (port 7717) and `ui` (port 5173) for the Claude desktop preview.

### Desktop build

```bash
npm run tauri:build
```

The `beforeBuildCommand` builds the UI (`apps/ui/dist`) and runs `npm run bundle:core`, which:

1. builds the core into a single ESM file (`npm run build --workspace @monarch/core` → `apps/core/dist/core.mjs`),
2. copies it to `src-tauri/resources/core/`,
3. finds the imports the bundle leaves external, copies those packages and their dependency closure into `resources/core/node_modules/`, checks that every one resolves, and writes `bundle-manifest.json`.

Tauri ships `resources/core/` as `<resources>/core/`. The release shell runs `node <resources>/core/core.mjs`.

**Size tradeoffs.**

- The Claude Agent SDK's optional per-platform package (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`) is **deliberately not bundled**. It is a native `claude` binary of roughly 200–360 MB. Monarch uses the `claude` you already have installed instead, found automatically or set in *Config → Claude → executable path*. The JS part of the SDK is only about 5 MB.
- Everything else that stays external is usually 20–40 MB of plain JS. `bundle-manifest.json` and the script's output list each package and its size. Inline more of it in the core's esbuild config to shrink the bundle, or pass `--exclude <pkg>` to drop something you know is unused.
- Node itself is **not** bundled. The app needs a system Node ≥ 22.19 at runtime. To ship to machines without Node, switch to a Tauri sidecar built with Node SEA; see `docs/research/tauri-daisyui.md` §3(b).

**Finding `node` from a GUI launch.** Desktop launchers often skip your shell's `PATH`. The shell appends `~/.local/bin`, `~/.nvm/versions/node/*/bin` (the nvm default alias first), the fnm directories, `~/.volta/bin`, `~/.bun/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. If that still misses, set `MONARCH_NODE=/abs/path/to/node`. The core inherits the extended `PATH`, so it also finds `claude`, `git` and the rest.

**Frameless window (optional).** The window keeps native decorations because that is the most reliable choice on Wayland, GNOME and KDE. To go frameless:

1. Set `"decorations": false` in `src-tauri/tauri.conf.json`.
2. Render a titlebar that has `data-tauri-drag-region` on the bar and on its text and spacer children.
3. Wire minimize, maximize and close buttons to `getCurrentWindow()` from `@tauri-apps/api/window`.

The needed `core:window:*` permissions are already in `src-tauri/capabilities/default.json`. Some Linux compositors drop resize shadows and edges on undecorated windows.

**Icons.** Regenerate them from the logo with:

```bash
rsvg-convert -w 1024 -h 1024 apps/ui/public/monarch.svg -o src-tauri/icons/source-1024.png
npx tauri icon src-tauri/icons/source-1024.png -o src-tauri/icons
```

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

### Google (Gmail and Calendar, several accounts)

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create (or pick) a project.
2. Under **APIs & Services → Library**, enable the **Gmail API** and the **Google Calendar API**.
3. Under **OAuth consent screen**, choose type *External* and leave publishing status at *Testing*. Add every Gmail address you'll connect as a **test user**.
4. Under **Credentials → Create credentials → OAuth client ID**, choose application type **Desktop app**. Copy the client ID and secret.
5. In Monarch, open **Config → Google**, paste the client ID and secret, then use **Connect account** once per account.

Sign-in happens in your browser. It redirects back to the core at `http://127.0.0.1:7717/oauth/google/callback`. Desktop-app clients accept any loopback redirect, so you don't need to register that URI.

> While the app is in *Testing*, Google expires refresh tokens after 7 days, so you will need to reconnect each account weekly. Publishing the app for personal use removes this limit, though Google may show an "unverified app" warning.

### Slack

1. Go to <https://api.slack.com/apps>, choose **Create New App → From scratch**, and pick your workspace.
2. Under **OAuth & Permissions → User Token Scopes**, add:
   `channels:history channels:read groups:history groups:read im:history im:read mpim:history mpim:read users:read search:read chat:write`
3. Press **Install to Workspace** and approve.
4. Copy the **User OAuth Token** (`xoxp-…`) into **Config → Slack**.

Messages are posted as you, and every send goes through approval.

### Memory vault

The default vault is `~/.monarch-ai/vault`. To use an existing Obsidian vault, point **Config → Memory → Vault directory** at it. Notes stay plain markdown with frontmatter, `[[links]]` and `#tags`, so Obsidian and Monarch can both edit them.

### Extensions and skills

An extension is a folder `~/.monarch-ai/extensions/<id>/` holding `extension.json` (manifest) and `index.mjs`, which exports `activate(api)`. With `api.tool`, `api.panel`, `api.job`, `api.store`, `api.secrets`, `api.notify` and `api.z` (zod) it adds tools the agent can call, panels for the Evolve page, and interval jobs. The full reference is in **Evolve → New → API reference**, and the agent reads it before writing one. Three builtin examples are seeded on first run: Hacker News, Unit Convert and Focus Timer.

Each extension runs in its own Node child process under Node's permission model:

- **Default:** it can read only its own folder, write only its `data/` dir, and has no network, child processes, or environment secrets.
- **Opt-in permissions:** the manifest can grant `network`, `shell` (effectively unsandboxed), `fs` (your home dir, which includes Monarch's data, so treat it as high trust) and `secrets` (values you enter in Evolve).
- **Node versions:** network blocking needs Node 25 or newer; on older Node it falls back to a `fetch` guard.

Agent-written extensions go through the normal approval gates. With **Config → Evolution → Auto-enable** off, they wait in Evolve for your review. Turning off **Self-modification** blocks agent writes completely.

Skills are markdown files in `~/.monarch-ai/skills/`. Their names are listed in the system prompt, and the agent reads one before doing that task.

## Data locations

Everything lives under `~/.monarch-ai`. Set `MONARCH_HOME` to put it somewhere else.

| path | contents |
|---|---|
| `data/*.json` | settings, tasks, reminders, automations, accounts and other stores |
| `secrets.json` | API keys, OAuth tokens, Slack token (file mode `600`). Never sent to the UI |
| `sessions/` | one JSON file per chat session |
| `vault/` | default memory vault |
| `extensions/` | extensions (with `.history/` revisions and per-extension `data/`) |
| `skills/` | skills (markdown procedures) |
| `logs/core.log` | core output when it was started by the desktop app (rotated at 5 MB) |

## Security model

- **Localhost only.** The core binds `127.0.0.1:7717`. CORS and the WebSocket `Origin` check accept only the UI's origins: `http://localhost:5173`, `tauri://localhost` and `http://tauri.localhost`.
- **Approval gates.** Every tool has a risk level (`safe`, `sensitive` or `dangerous`), and you pick a mode in Config:
  - `ask` (the default) asks for approval on sensitive and dangerous tools.
  - `auto-safe` asks only for dangerous ones.
  - `auto-all` never asks. Use it only for throwaway sessions.

  Approvals can be remembered for the rest of a session.
- **Secrets stay in the core.** Secrets are stored with mode `600` in `secrets.json`. The UI only ever sees masked values.
- **Desktop shell.**
  - Content Security Policy: scripts load only from the app, network access is limited to the core, and email bodies render in sandboxed `srcdoc` iframes.
  - The shell exposes just two commands: `open_external`, limited to `http`, `https` and `mailto`, and `core_status`.
  - The webview gets no filesystem or shell permissions.
- **Lifecycle.** The core shuts down when the desktop app does. Its stdin pipe closes, and if the core hasn't exited by then the shell sends SIGTERM and finally SIGKILL. The stdin pipe also covers a crashed shell.

## Troubleshooting

| symptom | fix |
|---|---|
| `cargo`: *no default toolchain configured* | `rustup default stable` |
| build fails in `webkit2gtk-sys` / `javascriptcore-rs-sys` / *`webkit2gtk-4.1.pc` not found* | install the Linux packages above |
| desktop window says core is offline | check `~/.monarch-ai/logs/core.log`. Run `invoke('core_status')` in devtools to see the spawn error. Set `MONARCH_NODE` if `node` isn't found |
| *port 7717 in use* / the app uses an old core | another core is running (`npm run dev:core`, or an orphan). The shell reuses it. Stop it with `fuser -k 7717/tcp` |
| blank window under Wayland / NVIDIA | try `WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri:dev` (or `WEBKIT_DISABLE_COMPOSITING_MODE=1`) |
| Claude engine: *not logged in* / *executable not found* | `claude auth status`. Set *Config → Claude → executable path* (output of `which claude`) |
| Google: `access_denied` / *app not verified* | add the account as a test user on the consent screen. While testing, click *Continue* past the warning |
| Google stops working after a week | Testing-mode refresh tokens expire after 7 days. Reconnect, or publish the consent screen |
| Slack `missing_scope` | add the scope under *User Token Scopes*, **reinstall** the app, and paste the new `xoxp-` token |
| `npm run bundle:core` fails on unresolved imports | `npm install`, then rerun. Add packages loaded by computed specifiers with `--include <pkg>` |
