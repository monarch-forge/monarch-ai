//! Monarch desktop shell.
//!
//! The UI is the Vite/Preact app (apps/ui); the brain is the Node core (apps/core) listening on
//! http://127.0.0.1:7717. This shell:
//!   1. spawns the core with Node (unless one is already listening, or MONARCH_EXTERNAL_CORE=1),
//!   2. hands it a piped stdin as a "parent alive" signal (MONARCH_PARENT_STDIN=1: core exits on EOF,
//!      which also covers the shell crashing or being SIGKILLed),
//!   3. logs core stdout/stderr to ~/.monarch-ai/logs/core.log,
//!   4. stops it (EOF → SIGTERM → SIGKILL) and reaps it on exit,
//!   5. exposes `open_external(url)` and `core_status()` to the UI.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_opener::OpenerExt;

const CORE_ADDR: &str = "127.0.0.1:7717";
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/* ───────────────────────── state ───────────────────────── */

struct CoreProc {
    child: Child,
    /// Held open for the lifetime of the core; dropping it sends EOF.
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct CoreInner {
    proc: Option<CoreProc>,
    external: bool,
    error: Option<String>,
    log_path: Option<PathBuf>,
}

struct CoreState(Mutex<CoreInner>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    /// the shell spawned the core and it is still running
    spawned: bool,
    pid: Option<u32>,
    /// the core is managed outside the shell (MONARCH_EXTERNAL_CORE=1 or port already in use at startup)
    external: bool,
    /// whether 127.0.0.1:7717 is accepting connections right now
    reachable: bool,
    /// spawn failure / exit status, if any
    error: Option<String>,
    log_path: Option<String>,
}

/* ───────────────────────── helpers ───────────────────────── */

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Mirrors `paths.home` in apps/core/src/kernel.ts (MONARCH_HOME override).
fn monarch_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("MONARCH_HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(h));
    }
    home_dir().map(|h| h.join(".monarch-ai"))
}

fn port_open() -> bool {
    let addr: SocketAddr = CORE_ADDR.parse().expect("valid core addr");
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref().map(str::trim),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

fn unix_ts() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Open (append) the core log, rotating once it grows past LOG_ROTATE_BYTES.
fn open_log() -> Option<(File, PathBuf)> {
    let dir = monarch_home()?.join("logs");
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("core.log");
    if fs::metadata(&path).map(|m| m.len() > LOG_ROTATE_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("core.log.1"));
    }
    let file = OpenOptions::new().create(true).append(true).open(&path).ok()?;
    Some((file, path))
}

fn log_line(path: Option<&Path>, msg: &str) {
    eprintln!("[monarch] {msg}");
    if let Some(p) = path {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "[shell {}] {msg}", unix_ts());
        }
    }
}

/// GUI launches (desktop entry, Finder, …) don't inherit the login shell's PATH, so nvm / fnm /
/// volta installs of node (and the `claude` CLI the core shells out to) would be invisible.
/// Append the usual locations after the inherited PATH.
fn augmented_path() -> OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    let mut extra: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        extra.push(home.join(".local/bin"));
        extra.push(home.join(".volta/bin"));
        extra.push(home.join(".bun/bin"));
        extra.push(home.join(".claude/local"));
        extra.push(home.join(".npm-global/bin"));
        // nvm: honour the `default` alias first, then newest installed version.
        let nvm = std::env::var_os("NVM_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".nvm"));
        if let Ok(alias) = fs::read_to_string(nvm.join("alias/default")) {
            let v = alias.trim();
            let v = if v.starts_with('v') { v.to_string() } else { format!("v{v}") };
            extra.push(nvm.join("versions/node").join(v).join("bin"));
        }
        extra.extend(sorted_subdirs_desc(&nvm.join("versions/node"), "bin"));
        // fnm (Linux default and macOS default data dirs)
        for fnm in [home.join(".local/share/fnm"), home.join("Library/Application Support/fnm"), home.join(".fnm")] {
            extra.push(fnm.join("aliases/default/bin"));
            extra.extend(sorted_subdirs_desc(&fnm.join("node-versions"), "installation/bin"));
        }
    }
    extra.push(PathBuf::from("/usr/local/bin"));
    extra.push(PathBuf::from("/opt/homebrew/bin"));
    extra.push(PathBuf::from("/usr/bin"));

    for d in extra {
        if d.is_dir() && !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// `<dir>/*/<suffix>` sorted by (numeric-ish) version, newest first.
fn sorted_subdirs_desc(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut entries: Vec<(Vec<u64>, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let key = name
                .trim_start_matches('v')
                .split(|c: char| !c.is_ascii_digit())
                .filter_map(|s| s.parse().ok())
                .collect::<Vec<u64>>();
            (key, e.path().join(suffix))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.into_iter().map(|(_, p)| p).collect()
}

fn which_in(path: &OsString, bin: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{bin}.exe"), format!("{bin}.cmd"), bin.to_string()]
    } else {
        vec![bin.to_string()]
    };
    for dir in std::env::split_paths(path) {
        for n in &names {
            let cand = dir.join(n);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// What to run: (node args, working dir).
fn core_launch(app: &AppHandle) -> Result<(Vec<OsString>, PathBuf), String> {
    if cfg!(debug_assertions) {
        // Dev: run the TypeScript sources directly through the tsx loader in a single process
        // (no `npx`, no extra wrapper process — so stdin EOF and kill reach the real core).
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let root = root.canonicalize().unwrap_or(root);
        let core_dir = root.join("apps/core");
        let entry = core_dir.join("src/index.ts");
        let tsx = [root.join("node_modules/tsx/dist/loader.mjs"), core_dir.join("node_modules/tsx/dist/loader.mjs")]
            .into_iter()
            .find(|p| p.is_file());
        if let (Some(tsx), true) = (tsx, entry.is_file()) {
            let url = file_url(&tsx);
            return Ok((vec!["--import".into(), url.into(), entry.into_os_string()], core_dir));
        }
        let dist = core_dir.join("dist/core.mjs");
        if dist.is_file() {
            return Ok((vec![dist.into_os_string()], core_dir));
        }
        return Err(format!(
            "core entry not found (looked for {} with tsx, and {}). Run `npm install` at the repo root.",
            entry.display(),
            dist.display()
        ));
    }
    let script = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir unavailable: {e}"))?
        .join("core")
        .join("core.mjs");
    if !script.is_file() {
        return Err(format!(
            "bundled core missing at {} — build with `npm run tauri:build` (runs `npm run bundle:core`).",
            script.display()
        ));
    }
    let dir = script.parent().map(Path::to_path_buf).unwrap_or_default();
    Ok((vec![script.into_os_string()], dir))
}

fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.replace(' ', "%20").replace('#', "%23").replace('?', "%3F");
    if s.starts_with('/') { format!("file://{s}") } else { format!("file:///{s}") }
}

fn spawn_core(app: &AppHandle, log: Option<(File, PathBuf)>) -> Result<CoreProc, String> {
    let path = augmented_path();
    let node: PathBuf = match std::env::var_os("MONARCH_NODE").filter(|v| !v.is_empty()) {
        Some(n) => PathBuf::from(n),
        None => which_in(&path, "node").ok_or_else(|| {
            "`node` not found on PATH (or in nvm/fnm/volta dirs). Install Node >= 22.19 or set MONARCH_NODE=/path/to/node."
                .to_string()
        })?,
    };
    let (args, cwd) = core_launch(app)?;

    let (stdout, stderr) = match &log {
        Some((f, _)) => match (f.try_clone(), f.try_clone()) {
            (Ok(a), Ok(b)) => (Stdio::from(a), Stdio::from(b)),
            _ => (Stdio::inherit(), Stdio::inherit()),
        },
        None => (Stdio::inherit(), Stdio::inherit()),
    };

    let mut cmd = Command::new(&node);
    cmd.args(&args)
        .current_dir(&cwd)
        .env("PATH", &path)
        .env("MONARCH_PARENT_STDIN", "1")
        .env("MONARCH_HOST", "127.0.0.1")
        .env("MONARCH_PORT", "7717")
        .env("MONARCH_SHELL", "tauri")
        .stdin(Stdio::piped())
        .stdout(stdout)
        .stderr(stderr);
    if !cfg!(debug_assertions) {
        cmd.env("NODE_ENV", "production");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    log_line(
        log.as_ref().map(|(_, p)| p.as_path()),
        &format!("spawning core: {} {:?} (cwd {})", node.display(), args, cwd.display()),
    );
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn {}: {e}", node.display()))?;
    let stdin = child.stdin.take();
    Ok(CoreProc { child, stdin })
}

/// Graceful stop: close stdin (core exits on EOF) → SIGTERM → SIGKILL, then reap.
fn stop_core(app: &AppHandle) {
    let Some(state) = app.try_state::<CoreState>() else { return };
    let (proc, log_path) = {
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        (inner.proc.take(), inner.log_path.clone())
    };
    let Some(mut proc) = proc else { return };
    drop(proc.stdin.take());
    if wait_exit(&mut proc.child, Duration::from_millis(1500)) {
        log_line(log_path.as_deref(), "core exited after stdin EOF");
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(proc.child.id().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if wait_exit(&mut proc.child, Duration::from_millis(1500)) {
            log_line(log_path.as_deref(), "core exited after SIGTERM");
            return;
        }
    }
    let _ = proc.child.kill();
    let _ = proc.child.wait();
    log_line(log_path.as_deref(), "core killed");
}

fn wait_exit(child: &mut Child, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => return false,
            Err(_) => return true,
        }
    }
}

/* ───────────────────────── commands ───────────────────────── */

/// Open a URL in the system browser / mail client. Only http(s) and mailto are allowed.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let scheme = trimmed.split_once(':').map(|(s, _)| s.to_ascii_lowercase()).unwrap_or_default();
    let ok = match scheme.as_str() {
        "http" | "https" => trimmed[scheme.len()..].starts_with("://") && trimmed.len() > scheme.len() + 3,
        "mailto" => trimmed.len() > "mailto:".len(),
        _ => false,
    };
    if !ok || trimmed.chars().any(|c| c.is_control()) {
        return Err(format!("refusing to open URL with unsupported scheme: {scheme:?}"));
    }
    app.opener().open_url(trimmed, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn core_status(state: State<'_, CoreState>) -> CoreStatus {
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut exited: Option<String> = None;
    let (spawned, pid) = match inner.proc.as_mut() {
        Some(p) => match p.child.try_wait() {
            Ok(None) => (true, Some(p.child.id())),
            Ok(Some(status)) => {
                exited = Some(format!("core exited: {status}"));
                (false, None)
            }
            Err(e) => {
                exited = Some(format!("core state unknown: {e}"));
                (false, None)
            }
        },
        None => (false, None),
    };
    if let Some(msg) = exited {
        inner.proc = None;
        inner.error = Some(msg);
    }
    CoreStatus {
        spawned,
        pid,
        external: inner.external,
        reachable: port_open(),
        error: inner.error.clone(),
        log_path: inner.log_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
    }
}

/* ───────────────────────── entry ───────────────────────── */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(CoreState(Mutex::new(CoreInner::default())))
        .invoke_handler(tauri::generate_handler![open_external, core_status])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<CoreState>();
            let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());

            if env_flag("MONARCH_EXTERNAL_CORE") {
                inner.external = true;
                eprintln!("[monarch] MONARCH_EXTERNAL_CORE=1 — not spawning core");
                return Ok(());
            }
            if port_open() {
                inner.external = true;
                eprintln!("[monarch] core already listening on {CORE_ADDR} — using it");
                return Ok(());
            }

            let log = open_log();
            inner.log_path = log.as_ref().map(|(_, p)| p.clone());
            match spawn_core(&handle, log) {
                Ok(proc) => inner.proc = Some(proc),
                // Never abort the window: the UI shows "core offline" and core_status() carries the reason.
                Err(e) => {
                    log_line(inner.log_path.as_deref(), &format!("core not started: {e}"));
                    inner.error = Some(e);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Monarch application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_core(handle);
        }
    });
}
