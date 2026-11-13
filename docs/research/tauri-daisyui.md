# Research: Tailwind v4 + daisyUI v5 + Vite/Preact + Tauri v2 (monarch-ai)

Researched 2026-11-13. Sources: daisyui.com (docs/install/vite, docs/themes, docs/config, docs/upgrade, llms.txt),
tailwindcss.com/docs, preactjs.com/guide/v11, github.com/preactjs/preset-vite, v2.tauri.app (start/frontend/vite,
develop/sidecar, learn/sidecar-nodejs, develop/resources, security/csp, security/capabilities, learn/window-customization,
start/prerequisites, reference/config), docs.rs/tauri, nodejs.org SEA docs, create-tauri-app template.
Legend: **[V]** verified against the official docs or registry today. **[U]** unverified or inferred, so check before relying on it.

## 0. Current versions (npm / crates.io, checked today) [V]

| package | version | note |
|---|---|---|
| tailwindcss, @tailwindcss/vite | 4.3.5 | plugin peer: vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8 |
| daisyui | 5.8.0 | exports `daisyui`, `daisyui/theme` |
| vite | 8.3.8 | |
| preact | 11.2.0 | v11 is current |
| @preact/preset-vite | 2.10.6 | peer: vite 2–8 **and `@babel/core` 7.x** (install it) |
| @preact/signals | 2.11.4 | peer preact >=10.25 \|\| >=11 |
| @tauri-apps/cli, @tauri-apps/api | 2.12.4 | |
| @tauri-apps/plugin-shell | 2.6.0 | only needed for sidecar route |
| crate tauri / tauri-plugin-shell | 2.12.5 / 2.6.0 | use `"2"` semver in Cargo.toml |

## 1. Tailwind v4 + daisyUI v5 with Vite

Install [V]:
```bash
npm i -D tailwindcss @tailwindcss/vite daisyui
```
Add `tailwindcss()` from `@tailwindcss/vite` to Vite `plugins` (no postcss config and no tailwind.config.js). The CSS entry
needs only `@import "tailwindcss"; @plugin "daisyui";` [V].

**Source scanning [V]:** v4 scans the whole project except `.gitignore`d files, node_modules, binaries, CSS and lockfiles.
This repo is **not a git repo**, so `src-tauri/target` would be scanned (slow). Pin the base with
`@import "tailwindcss" source("../src");` or add `@source not "../src-tauri";`. Paths are relative to the CSS file.

**daisyUI plugin options [V]:** `themes` (default `light --default, dark --prefersdark`; `all`; `false`), `root` (":root"),
`include`, `exclude`, `prefix` (""), `logs` (true). The docs say to use `themes: false` "to disable all themes and add custom themes using
`@plugin "daisyui/theme"`".

**Custom theme. All variables [V]:**
- Meta: `name`, `default`, `prefersdark`, `color-scheme`, `themecontroller` (the last is optional. It adds the `:has(input.theme-controller…)` selector).
- Colors: `--color-base-100/200/300`, `--color-base-content`, and `--color-{primary,secondary,accent,neutral,info,success,warning,error}`,
  each with a `-content` pair.
- Radius: `--radius-selector` (checkbox/toggle/badge), `--radius-field` (btn/input/select/tab), `--radius-box` (card/modal/alert).
- Size: `--size-selector`, `--size-field` (base unit, typically `0.25rem`).
- `--border` (e.g. `1px`), `--depth` (0|1, adds 3D shadow), `--noise` (0|1, adds grain texture).
- Typical values: radius-selector 1rem, field 0.25rem, box 0.5rem; sizes 0.25rem; border 1px; depth 1; noise 0. The values come from
  general knowledge because the generator page had no export **[U]**. A theme is selected by `[data-theme="name"]`. A theme with
  `name: "dark"` overrides a built-in one and inherits any variables it doesn't set.

### `src/index.css` (complete)
```css
@import "tailwindcss" source("../src");

@plugin "daisyui" {
  themes: false;          /* only our custom theme(s) below */
  logs: false;
}

@plugin "daisyui/theme" {
  name: "monarch";
  default: true;
  prefersdark: true;
  color-scheme: dark;

  --color-base-100: oklch(20% 0.015 260);
  --color-base-200: oklch(17% 0.015 260);
  --color-base-300: oklch(14% 0.015 260);
  --color-base-content: oklch(92% 0.01 260);
  --color-primary: oklch(72% 0.18 50);          /* monarch orange */
  --color-primary-content: oklch(18% 0.03 50);
  --color-secondary: oklch(68% 0.14 300);
  --color-secondary-content: oklch(15% 0.03 300);
  --color-accent: oklch(78% 0.13 190);
  --color-accent-content: oklch(18% 0.03 190);
  --color-neutral: oklch(28% 0.02 260);
  --color-neutral-content: oklch(88% 0.01 260);
  --color-info: oklch(72% 0.13 240);
  --color-info-content: oklch(15% 0.03 240);
  --color-success: oklch(74% 0.16 150);
  --color-success-content: oklch(16% 0.03 150);
  --color-warning: oklch(82% 0.16 85);
  --color-warning-content: oklch(20% 0.04 85);
  --color-error: oklch(66% 0.2 25);
  --color-error-content: oklch(15% 0.03 25);

  --radius-selector: 0.5rem;
  --radius-field: 0.375rem;
  --radius-box: 0.75rem;
  --size-selector: 0.25rem;
  --size-field: 0.25rem;
  --border: 1px;
  --depth: 0;
  --noise: 0;
}

html, body, #app { height: 100%; }
```
Put `<html data-theme="monarch">` in index.html, which is optional when `default: true`.

### daisyUI v5 classes useful for dashboard and chat [V]
`{color}` = neutral|primary|secondary|accent|info|success|warning|error; `{size}` = xs|sm|md|lg|xl.
- **btn**: `btn-{color}`, styles `btn-outline btn-dash btn-soft btn-ghost btn-link`, `btn-active btn-disabled`, `btn-{size}`,
  `btn-wide btn-block btn-square btn-circle`.
- **card**: `card-body card-title card-actions`, `card-border card-dash`, `card-{size}`, `card-side image-full`.
- **badge**: `badge-{color}`, `badge-outline badge-dash badge-soft badge-ghost`, `badge-{size}`.
- **tabs**: `<div role="tablist" class="tabs tabs-box">` with `tab`, `tab-active`, `tab-disabled`, `tab-content`; styles `tabs-box tabs-border tabs-lift`.
- **menu**: `menu menu-title menu-{size} menu-vertical|horizontal`, item states `menu-active menu-disabled menu-focus`.
- **chat**: `chat chat-start|chat-end`, with `chat-image chat-header chat-bubble chat-footer` and `chat-bubble-{color}`.
- **progress** `<progress class="progress progress-primary" value max>`. **radial-progress** uses `style="--value:70; --size:3rem; --thickness:4px"`.
- **toggle** `<input type=checkbox class="toggle toggle-{color} toggle-{size}">`.
- **input / select / textarea** are bordered by default. `*-ghost` removes the border; add `*-{color}` and `*-{size}`. The default width is 20rem, so add `w-full`.
  `input` can also be a `<label class="input">` wrapper holding an icon plus a bare `<input>`.
- **fieldset**: `<fieldset class="fieldset"><legend class="fieldset-legend">…</legend><input class="input"><p class="label">help</p></fieldset>`;
  `floating-label` is also available.
- **modal**: `<dialog id="m" class="modal"><div class="modal-box">…<div class="modal-action">…</div></div><form method="dialog" class="modal-backdrop"><button>close</button></form></dialog>`,
  opened with `ref.current.showModal()`. Also `modal-open`, and `modal-top|middle|bottom|start|end`.
- **toast**: `toast toast-end toast-bottom` (also start/center/top/middle) wrapping `alert alert-{info|success|warning|error}` (`alert-soft|outline|dash`).
- **kbd** `kbd kbd-sm`. **loading** `loading loading-spinner|dots|ring|ball|bars|infinity loading-{size}`.
- **tooltip** `<div class="tooltip tooltip-bottom tooltip-primary" data-tip="…">`. Also `tooltip-content` for rich content, and `tooltip-open`.
- **stats**: `stats stats-horizontal|vertical` with `stat stat-title stat-value stat-desc stat-figure stat-actions`. The background is now transparent, so add `bg-base-100`.
- **collapse**: `collapse collapse-arrow|plus` with `collapse-title collapse-content`, plus `collapse-open|close`. It also works on `<details>`.
- **join**: `join join-vertical|horizontal` with `join-item` children.
- **dropdown**: `<details class="dropdown dropdown-end"><summary class="btn">…</summary><ul class="dropdown-content menu …">`.
- **steps** `steps steps-vertical` with `step step-primary` and `step-icon`. **status** `<span class="status status-success status-sm">` (a dot, new in v5).
- Others: `navbar(-start|center|end)`, `drawer`, `table table-zebra table-pin-rows`, `list list-row`, `skeleton`, `indicator`, `divider`, `alert`.

### v4 → v5 renames and removals [V]
`card-bordered`→`card-border`, `card-compact`→`card-sm`; `tabs-bordered|lifted|boxed`→`tabs-border|lift|box`;
`bottom-nav`/`btm-nav-*`→`dock`/`dock-*`; menu `active|disabled|focus`→`menu-active|menu-disabled|menu-focus`;
avatar `online|offline|placeholder`→`avatar-online|avatar-offline|avatar-placeholder`; **removed**: `input-bordered`,
`select-bordered`, `textarea-bordered`, `file-input-bordered` (bordered is now the default, so use `*-ghost` for none), `form-control`,
`label-text`, `label-text-alt` (use `fieldset`/`legend`/`label`), `btn-group`, `input-group` (use `join`), `artboard`, `phone-*`,
table `hover`; footer is now vertical by default (`footer-horizontal`). Theme config moved from tailwind.config.js to CSS `@plugin`.

## 2. Vite + Preact

```bash
npm i preact @preact/signals
npm i -D vite @preact/preset-vite @babel/core typescript
```
`@preact/preset-vite` options [V]: `devToolsEnabled` (true), `devtoolsInProd` (false), `prefreshEnabled` (true, HMR),
`reactAliasesEnabled` (true: react/react-dom→preact/compat), `prerender{enabled,renderTarget}`, `babel{plugins,presets}`.

### `vite.config.ts` (Tauri-recommended dev settings + Preact + Tailwind)
```ts
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  clearScreen: false,                       // don't hide Rust errors
  server: {
    port: 5173,
    strictPort: true,                       // Tauri devUrl needs a fixed port
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri docs use chrome105/safari13. Tailwind v4 needs Safari 16.4+/Chrome 111+ anyway [U: deviation]
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome111" : "safari16",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
```

### tsconfig (relevant parts) [V]
```jsonc
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "jsxImportSource": "preact",
    "skipLibCheck": true, "strict": true, "noEmit": true,
    "types": ["vite/client"],
    // only if using React libs via compat:
    "paths": { "react": ["./node_modules/preact/compat/"], "react-dom": ["./node_modules/preact/compat/"],
               "react/jsx-runtime": ["./node_modules/preact/jsx-runtime"] }
  }
}
```

### Hooks and signals [V]
```tsx
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { signal, computed, effect, batch, useSignal, useComputed, useSignalEffect } from "@preact/signals";

export const messages = signal<{ role: string; text: string }[]>([]);   // global store
export const count = computed(() => messages.value.length);

function Chat() {
  const draft = useSignal("");                    // component-local signal
  const dlg = useRef<HTMLDialogElement>(null);
  return (
    <div class="flex flex-col gap-2">
      <span class="badge badge-primary">{count}</span>  {/* signal in JSX: text node updates without re-render */}
      <textarea class="textarea w-full" value={draft} onInput={e => (draft.value = e.currentTarget.value)} />
      <button class="btn btn-primary" onClick={() => { messages.value = [...messages.value, { role: "user", text: draft.value }]; draft.value = ""; }}>Send</button>
      <button class="btn" onClick={() => dlg.current?.showModal()}>Info</button>
      <dialog ref={dlg} class="modal"><div class="modal-box">…</div><form method="dialog" class="modal-backdrop"><button>close</button></form></dialog>
    </div>
  );
}
render(<Chat />, document.getElementById("app")!);
```
Reading `.value` inside a component body subscribes and re-renders the component. Use `.peek()` to read without subscribing.
`Show`, `For`, `useLiveSignal` and `useSignalRef` live in `@preact/signals/utils` [V].

## 3. Tauri v2 around the existing Vite frontend

Linux deps [V]. On Arch:
`sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool`.
On Debian/Ubuntu: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.
On Fedora: `webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel` plus the `c-development` group.
libsoup3 is pulled in by webkit2gtk-4.1 [U: transitive, not listed explicitly]. **Note:** this machine has no default rustup toolchain,
so run `rustup default stable` first. Then `npm i -D @tauri-apps/cli && npx tauri init` (or write the files below) and `npx tauri dev`.

Layout: `src-tauri/{Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, icons/, src/main.rs, src/lib.rs}`.
`gen/schemas/*` is generated by tauri-build. Generate icons with `npx tauri icon path/to/1024.png`.

### `src-tauri/Cargo.toml` (based on the create-tauri-app v2 template [V])
```toml
[package]
name = "monarch-ai"
version = "0.1.0"
edition = "2024"

[lib]
name = "monarch_ai_lib"            # _lib suffix avoids bin/lib name clash on Windows
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"          # open external links in the system browser
# tauri-plugin-shell = "2"         # only for the sidecar route (b)
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
codegen-units = 1
lto = true
opt-level = 3
panic = "abort"
strip = true
```

### `src-tauri/build.rs` [V]
```rust
fn main() { tauri_build::build() }
```

### `src-tauri/src/main.rs` [V template]
```rust
// Prevents an extra console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() { monarch_ai_lib::run() }
```

### `src-tauri/tauri.conf.json`
`$schema` URL is from the template, not the reference page [U]. `devCsp` exists ("injected on all HTML files on development") [V].
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Monarch AI",
  "version": "0.1.0",
  "identifier": "io.monarch-ai.desktop",
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build && npm run build:core",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{
      "label": "main", "title": "Monarch AI",
      "width": 1280, "height": 820, "minWidth": 900, "minHeight": 600,
      "center": true, "resizable": true, "decorations": true
    }],
    "security": {
      "csp": {
        "default-src": "'self'",
        "connect-src": "'self' ipc: http://ipc.localhost http://127.0.0.1:7717 ws://127.0.0.1:7717",
        "img-src": "'self' data: blob: asset: http://asset.localhost",
        "style-src": "'self' 'unsafe-inline'",
        "font-src": "'self' data:"
      },
      "devCsp": {
        "default-src": "'self'",
        "connect-src": "'self' ipc: http://ipc.localhost http://127.0.0.1:7717 ws://127.0.0.1:7717 ws://localhost:5173 http://localhost:5173",
        "img-src": "'self' data: blob:",
        "style-src": "'self' 'unsafe-inline'"
      }
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "resources": { "../apps/core/dist/": "core/" }
  }
}
```
**Repo layout note:** the config above assumes `src-tauri/` at the repo root (next to `apps/`). In that case set
`frontendDist: "../apps/ui/dist"`, `beforeDevCommand: "npm run dev:ui"`, and `beforeBuildCommand: "npm run build"` (the root script builds core and ui).
If `src-tauri/` lives in `apps/ui/`, use `../dist` and the paths shown. Commands run from the `tauri` CLI's cwd [U: verify the cwd].
CSP notes. Tauri appends its own nonces and hashes at compile time [V]. `ipc: http://ipc.localhost` comes from the official example [V] and
is needed for `invoke()` [U: the docs don't say it is strictly required, but keep it]. CSP host matching is literal, so use `127.0.0.1`
in both the CSP and the client code (not `localhost`), and bind core to `127.0.0.1`.
**CORS/WS origin [U]:** the webview origin is `tauri://localhost` (Linux and macOS), `http://tauri.localhost` (Windows), and
`http://localhost:5173` in dev, so core's CORS allow-list and WebSocket `Origin` check must accept those. Adjust the `resources`
path to wherever core's bundled `core.mjs` lands. Map form: key is the source (relative to src-tauri), value is the target dir [V].

### `src-tauri/capabilities/default.json` [V format]
Every file in `capabilities/` is auto-enabled unless `app.security.capabilities` lists some explicitly.
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "core:window:default",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close"
  ]
}
```
The `core:window:allow-*` entries are only needed for the custom titlebar (section 4). For a sidecar, add
`{ "identifier": "shell:allow-spawn", "allow": [{ "name": "binaries/monarch-core", "sidecar": true }] }`, but only if JS spawns it.
Spawning from Rust needs no capability.

### Option (a): Rust spawns `node core.mjs` (recommended for now)
`src-tauri/src/lib.rs`. APIs are verified (`Manager`, `path().resolve(…, BaseDirectory::Resource)`, `Builder::build().run()`,
`RunEvent::Exit`/`ExitRequested`, and RunEvent is non-exhaustive). The full file is not compiled yet [U].
```rust
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{path::BaseDirectory, AppHandle, Manager, RunEvent};

/// Holds the core process. Its stdin pipe doubles as a "parent alive" signal:
/// core should do `process.stdin.on("end", () => process.exit(0))` so it also
/// exits if the Tauri process crashes or is SIGKILLed (no RunEvent::Exit then).
struct Core(Mutex<Option<(Child, ChildStdin)>>);

fn core_script(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        // dev: use the workspace build directly
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../apps/core/dist/core.mjs"))
    } else {
        Ok(app.path().resolve("core/core.mjs", BaseDirectory::Resource)?)
    }
}

fn spawn_core(app: &AppHandle) -> Result<(Child, ChildStdin), Box<dyn std::error::Error>> {
    // GUI launches may not inherit a shell PATH (nvm/fnm), so allow an override.
    let node = std::env::var("MONARCH_NODE").unwrap_or_else(|_| "node".into());
    let mut child = Command::new(node)
        .arg(core_script(app)?)
        .env("MONARCH_HOST", "127.0.0.1")
        .env("MONARCH_PORT", "7717")
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    Ok((child, stdin))
}

fn stop_core(app: &AppHandle) {
    if let Some(state) = app.try_state::<Core>() {
        if let Some((mut child, stdin)) = state.0.lock().unwrap().take() {
            drop(stdin);                 // EOF lets core shut down gracefully
            std::thread::sleep(std::time::Duration::from_millis(300));
            if let Ok(None) = child.try_wait() {
                let _ = child.kill();    // SIGKILL / TerminateProcess fallback
            }
            let _ = child.wait();        // reap, no zombie
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Let `npm run dev:core` (tsx watch) own the process in dev if desired
            let external = std::env::var("MONARCH_CORE_EXTERNAL").is_ok();
            let proc = if external { None } else { Some(spawn_core(app.handle())?) };
            app.manage(Core(Mutex::new(proc)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| match event {
        RunEvent::Exit => stop_core(handle),
        _ => {}
    });
}
```
Notes: `setup` returns `Result<(), Box<dyn Error>>`, so `?` works for io and tauri errors. `RunEvent::Exit` fires when the event loop
ends, including the last window closing. It does **not** fire on a crash or SIGKILL, which is what the stdin-EOF trick covers. `kill()` is
SIGKILL on Unix, so grandchildren of core (spawned tools) should be cleaned up by core on stdin `end`/SIGTERM.
Requires Node 26 on the target machine, which is fine for a personal Arch box.

### Option (b): sidecar via `externalBin` + tauri-plugin-shell [V]
- `"bundle": { "externalBin": ["binaries/monarch-core"] }`. The file must exist as
  `src-tauri/binaries/monarch-core-<triple>` (get the triple with `rustc --print host-tuple`, Rust ≥1.84; e.g. `x86_64-unknown-linux-gnu`).
- Rust: `.plugin(tauri_plugin_shell::init())`, then `use tauri_plugin_shell::ShellExt;`, then
  `let (mut rx, child) = app.shell().sidecar("monarch-core")?.spawn()?;`. Pass only the filename. Read `rx` (CommandEvent::Stdout/…)
  in `tauri::async_runtime::spawn`, store `child` (CommandChild) in state, and call `child.kill()` on `RunEvent::Exit`.
- Building the single binary: the official Tauri Node guide uses `@yao-pkg/pkg` plus a rename script [V]. Alternatives: Node SEA
  (`node --build-sea sea-config.json`; ESM entry via `"mainFormat": "module"` in v26 docs [U: confirm on the exact 26.x], and it requires a bundled
  single file such as esbuild/rolldown output) or `bun build --compile` (Bun runtime, not Node [U: compat with our deps]).
  Native addons (e.g. better-sqlite3) complicate every single-binary route.

**Recommendation:** use **(a)** now. There is no packaging step, the real Node 26 runtime runs, native modules work, and it's easy to point at a watch-mode
core in dev (`MONARCH_CORE_EXTERNAL=1`). Bundle `core.mjs` (esbuild/rolldown single file) as a resource. Move to **(b)** with Node SEA
only if the app is distributed to machines without Node. The Rust lifecycle code barely changes.

## 4. Frameless window / custom titlebar (optional) [V]
- `"decorations": false` on the window, plus the `core:window:*` permissions listed above.
- Put `data-tauri-drag-region` on the titlebar element. It applies **only to that element, not to its children**, so add it to inner
  spacer/text elements too. Buttons and inputs keep working.
- On Windows, the docs suggest CSS `[data-tauri-drag-region]{ app-region: drag; }` for touch and pen.
```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";   // npm i @tauri-apps/api
const win = getCurrentWindow();
<header data-tauri-drag-region class="navbar min-h-10 h-10 bg-base-200 px-2 select-none">
  <span data-tauri-drag-region class="flex-1 text-sm opacity-70">Monarch AI</span>
  <div class="join">
    <button class="btn btn-ghost btn-xs join-item" onClick={() => win.minimize()}>–</button>
    <button class="btn btn-ghost btn-xs join-item" onClick={() => win.toggleMaximize()}>□</button>
    <button class="btn btn-ghost btn-xs join-item hover:btn-error" onClick={() => win.close()}>✕</button>
  </div>
</header>
```
Double-click-to-maximize: the docs' manual example uses `onMouseDown` with `e.detail === 2 ? toggleMaximize() : startDragging()`.
Whether the attribute alone does this is not stated [U]. On Linux/Wayland, frameless windows lose native resize-edge shadows on some
compositors [U]. Keeping `decorations: true` is the low-risk default.
