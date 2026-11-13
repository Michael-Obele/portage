//! The engine bridge: one child process, three events, three commands.
//!
//! Rust owns the process and the pipes, and nothing else. It never calls adb,
//! never opens the database, never reads the config, and never interprets a
//! frame beyond its top-level `type`. See `docs/plans/2026-11-08-desktop-app/
//! architecture.md`, "Why stdio and not a socket" and "Rust's job, exactly".
//!
//! One protocol in, one protocol out: a stdout line becomes `engine://frame`
//! verbatim, a stderr line becomes `engine://stderr`, the exit becomes
//! `engine://exit`. `engine_send` writes exactly one line to the child's stdin.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};

/// A stdout line, verbatim: the frame exactly as the engine wrote it.
pub const EVENT_FRAME: &str = "engine://frame";
/// A stderr line. Diagnostics only; the wire is stdout.
pub const EVENT_STDERR: &str = "engine://stderr";
/// The child ended. Payload is the exit code, `null` when none was reported.
pub const EVENT_EXIT: &str = "engine://exit";

/// One automatic restart after a crash, then the UI offers a manual one (D37).
const MAX_AUTO_RESTARTS: u32 = 1;
const RESTART_BACKOFF: Duration = Duration::from_millis(500);

/// Set `PORTAGE_DEV_ENGINE=<repo root>` to run the engine from source instead of
/// the packaged sidecar. Same wire, a different executable behind it.
const DEV_ENGINE_ENV: &str = "PORTAGE_DEV_ENGINE";

/// A lock that survives a poisoned mutex: a panic in one thread must not turn
/// every later call into a panic. Nothing here panics while holding the lock.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Emit and forget. A failed emit means no webview is listening.
fn emit<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    let _ = app.emit(event, payload);
}

/// The shell's own diagnostics. A window launched from a desktop entry has no
/// console, so these are appended to a file as well as written to stderr (which
/// only a terminal sees). Best effort: a failure to log never stops the app.
pub fn note(message: &str) {
    eprintln!("{message}");
    if let Some(path) = log_path()
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    {
        let _ = writeln!(file, "{message}");
    }
}

/// `$XDG_STATE_HOME/portage/desktop.log`, or `~/.local/state/...` when unset.
fn log_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
        })?;
    let dir = base.join("portage");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("desktop.log"))
}

/// Every frame type the engine can write.
///
/// The buffer is keyed by `&'static str` so no String is leaked per frame, which
/// means a parsed `type` is mapped onto this table. Anything not listed is
/// forwarded but not remembered.
const FRAME_TYPES: [&str; 18] = [
    "ready",
    "notice",
    "log",
    "config",
    "devices",
    "volumes",
    "scan",
    "plan",
    "state",
    "run",
    "dupes",
    "purgePlan",
    "doctor",
    "status",
    "browse",
    "needsConfirm",
    "answer",
    "bye",
];

/// The whole of Rust's state about the engine.
#[derive(Default)]
pub struct EngineState {
    child: Mutex<Option<CommandChild>>,
    /// The last frame of each type, so a webview that mounted late still sees
    /// `ready` and the last `state` without a replay protocol (D37).
    last: Mutex<HashMap<&'static str, Value>>,
    /// Set once the app is going away: no restart may follow.
    shutdown: AtomicBool,
    /// Automatic restarts used since the last successful start.
    restarts: AtomicU32,
    /// Bumped by every spawn. A `Terminated` event carrying an older generation
    /// is a stale report about a child already replaced, and is ignored.
    generation: AtomicU64,
}

#[derive(Serialize)]
pub struct EngineStatus {
    running: bool,
    /// The last frame per type, keyed by the frame's own `type` string.
    last: HashMap<String, Value>,
}

/// The repo root when `PORTAGE_DEV_ENGINE` names one, else `None` so the
/// packaged sidecar is used. A path that is not a directory is reported and
/// ignored rather than quietly swapping which engine runs.
fn dev_engine_root() -> Option<PathBuf> {
    let raw = std::env::var(DEV_ENGINE_ENV).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let root = PathBuf::from(trimmed);
    if root.is_dir() {
        Some(root)
    } else {
        note(&format!(
            "portage: {DEV_ENGINE_ENV}=\"{trimmed}\" is not a directory; using the sidecar"
        ));
        None
    }
}

/// The child command: the packaged sidecar, or Bun running the engine from
/// source when the dev override is set. `kill_on_drop` is the last-resort
/// anti-zombie net behind the explicit `shutdown`.
fn build_command(app: &AppHandle) -> Result<Command, String> {
    let command = match dev_engine_root() {
        Some(root) => app
            .shell()
            .command("bun")
            .args(["run", "src/cli/index.ts", "serve"])
            .current_dir(root),
        None => app
            .shell()
            .sidecar("portage")
            .map_err(|err| err.to_string())?
            .args(["serve"]),
    };
    Ok(command.kill_on_drop(true))
}

/// Spawn the engine and pump its output. Replaces any child already running.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<EngineState>();
    if state.shutdown.load(Ordering::SeqCst) {
        return Err("the app is shutting down".into());
    }

    // Supersede the previous child BEFORE the new one starts: the old child's
    // `Terminated` event then carries an older generation and cannot be read as
    // this child's exit.
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(previous) = lock(&state.child).take() {
        let _ = previous.kill();
    }

    let (mut events, child) = build_command(app)?.spawn().map_err(|err| err.to_string())?;
    *lock(&state.child) = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => on_stdout(&handle, &bytes),
                CommandEvent::Stderr(bytes) => {
                    emit(
                        &handle,
                        EVENT_STDERR,
                        String::from_utf8_lossy(&bytes).into_owned(),
                    );
                }
                CommandEvent::Error(message) => emit(&handle, EVENT_STDERR, message),
                CommandEvent::Terminated(payload) => {
                    if handle
                        .state::<EngineState>()
                        .generation
                        .load(Ordering::SeqCst)
                        != generation
                    {
                        continue; // a child this session already replaced
                    }
                    emit(&handle, EVENT_EXIT, payload.code);
                    on_terminated(&handle, payload.code);
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Bring the engine back on demand, resetting the automatic-restart budget.
#[tauri::command]
pub fn engine_restart(app: AppHandle) -> Result<(), String> {
    let state = app.state::<EngineState>();
    state.restarts.store(0, Ordering::SeqCst);
    start(&app)
}

/// Exactly one terminating newline, whatever the caller sent. The wire is one
/// frame per line, so a caller that supplies its own newline must not make two.
fn one_line(line: &str) -> Vec<u8> {
    let mut payload = line.as_bytes().to_vec();
    while matches!(payload.last().copied(), Some(b'\n' | b'\r')) {
        payload.pop();
    }
    payload.push(b'\n');
    payload
}

/// Write exactly one line to the engine's stdin.
#[tauri::command]
pub fn engine_send(app: AppHandle, line: String) -> Result<(), String> {
    let payload = one_line(&line);

    let state = app.state::<EngineState>();
    let mut guard = lock(&state.child);
    let child = guard.as_mut().ok_or("the engine is not running")?;
    child.write(&payload).map_err(|err| err.to_string())
}

/// Liveness plus the buffered frames, so a late-mounted UI can catch up.
#[tauri::command]
pub fn engine_status(app: AppHandle) -> EngineStatus {
    let state = app.state::<EngineState>();
    let running = !state.shutdown.load(Ordering::SeqCst) && lock(&state.child).is_some();
    let last = lock(&state.last)
        .iter()
        .map(|(kind, frame)| ((*kind).to_string(), frame.clone()))
        .collect();
    EngineStatus { running, last }
}

/// Kill the child. Idempotent, and safe to call from every exit path.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<EngineState>();
    state.shutdown.store(true, Ordering::SeqCst);
    // Invalidate any in-flight `Terminated` event: it must not schedule a restart.
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(child) = lock(&state.child).take() {
        let _ = child.kill();
    }
}

/// Tell the UI the engine never came up. It lands on the same screen a crash
/// leaves behind: a stopped engine with a manual restart on offer.
pub fn report_start_failure(app: &AppHandle, reason: &str) {
    emit(app, EVENT_STDERR, format!("engine did not start: {reason}"));
    emit(app, EVENT_EXIT, Option::<i32>::None);
}

/// The child ended. Clear the handle and decide whether it comes back.
fn on_terminated(app: &AppHandle, code: Option<i32>) {
    let state = app.state::<EngineState>();
    // The child has already exited; this only empties the slot before a restart
    // can fill it.
    let _ = lock(&state.child).take();

    if state.shutdown.load(Ordering::SeqCst) {
        return; // the app is going away; nothing to resurrect
    }
    if code == Some(0) {
        state.restarts.store(0, Ordering::SeqCst);
        return; // a clean exit (`bye`), not a crash
    }
    if state.restarts.fetch_add(1, Ordering::SeqCst) < MAX_AUTO_RESTARTS {
        restart_later(app.clone());
    }
}

/// One restart after a short backoff, on a plain thread: a single 500 ms delay
/// is not worth pulling an async timer into this crate.
///
/// A manual `engine_restart` landing inside this window is harmless: whichever
/// start wins supersedes the other, and the engine still ends up running.
fn restart_later(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(RESTART_BACKOFF);
        if let Err(err) = start(&app) {
            emit(&app, EVENT_STDERR, format!("engine restart failed: {err}"));
            emit(&app, EVENT_EXIT, Option::<i32>::None);
        }
    });
}

/// Forward one stdout line verbatim, and remember it when it is a whole frame.
fn on_stdout(app: &AppHandle, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes).into_owned();

    // Parse before forwarding so the line need not be cloned (`emit` takes
    // ownership). The only field Rust ever reads is the type. Everything else in
    // the frame is opaque to it, which is the point: the payload's meaning lives
    // in the engine, in one codebase, next to the tests that pin it.
    if let Ok(value) = serde_json::from_str::<Value>(&line)
        && let Some(kind) = value.get("type").and_then(Value::as_str)
        && let Some(kind) = FRAME_TYPES.iter().copied().find(|known| *known == kind)
    {
        lock(&app.state::<EngineState>().last).insert(kind, value);
    }

    emit(app, EVENT_FRAME, line);
}

#[cfg(test)]
mod tests {
    use super::one_line;

    #[test]
    fn one_line_leaves_exactly_one_terminating_newline() {
        assert_eq!(one_line("x"), b"x\n");
        assert_eq!(one_line("x\n"), b"x\n");
        assert_eq!(one_line("x\r\n\r\n"), b"x\n");
        assert_eq!(one_line(""), b"\n");
    }
}
