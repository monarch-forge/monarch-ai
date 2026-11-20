# Developing Monarch

Building from source, the desktop build, releasing, and how the pieces fit together. For installing a release, see the [README](../README.md#install).

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

### Releasing

The version lives in one place, the root `package.json`. One command sets it and syncs every other file: workspace `package.json`s, `package-lock.json`, `Cargo.toml`/`Cargo.lock`, the PKGBUILD and the README links. `tauri.conf.json` reads `package.json` directly.

```bash
npm run set-version 0.4.2        # or: patch | minor | major
git commit -am "Release v0.4.2" && git tag v0.4.2 && git push origin HEAD v0.4.2
```

`npm run set-version 0.4.2 -- --tag` commits all changes to tracked files as the release and tags it (it doesn't push; `git add` new files first). If you edit `package.json` by hand, run `npm run set-version` with no argument to sync the rest. CI refuses to build when the tag and `package.json` disagree or a file is out of sync.

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds Linux, macOS (arm64 and x64) and Windows
with Tauri, publishes a GitHub release, and then `.github/workflows/arch.yml` attaches the Arch package and
its PKGBUILD. To add the Arch package to an existing release, run the **Arch package** workflow by hand with
that tag.

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
