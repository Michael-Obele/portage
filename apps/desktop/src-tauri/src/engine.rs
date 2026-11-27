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

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
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

/// Remembers `line` as the last frame of its type when that type is one of the 18 known types (R5.3, R5.4).
/// Leaves `last` unchanged for any other input. Reads only the top-level `type` (R5.2).
fn remember_frame(last: &mut HashMap<&'static str, Box<RawValue>>, line: &str) {
    let Ok(raw) = serde_json::from_str::<Box<RawValue>>(line) else {
        return;
    };
    let Ok(peek) = serde_json::from_str::<TypePeek>(raw.get()) else {
        return;
    };
    let Some(Ok(name)) = peek
        .0
        .map(|kind| serde_json::from_str::<String>(kind.get()))
    else {
        return;
    };
    if let Some(kind) = known_type(&name) {
        last.insert(kind, raw);
    }
}

/// The known type that `kind` names.
fn known_type(kind: &str) -> Option<&'static str> {
    FRAME_TYPES.iter().copied().find(|known| *known == kind)
}

/// The top-level `type` as raw JSON. Every other field is skipped unread, so the
/// peek does not build a tree for a frame it only needs to label.
struct TypePeek(Option<Box<RawValue>>);

impl<'de> Deserialize<'de> for TypePeek {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Peek;

        impl<'de> Visitor<'de> for Peek {
            type Value = TypePeek;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<TypePeek, A::Error> {
                let mut kind = None;
                while let Some(key) = map.next_key::<Cow<'de, str>>()? {
                    if key == "type" {
                        kind = Some(map.next_value::<Box<RawValue>>()?);
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(TypePeek(kind))
            }
        }

        deserializer.deserialize_map(Peek)
    }
}

/// The whole of Rust's state about the engine.
#[derive(Default)]
pub struct EngineState {
    child: Mutex<Option<CommandChild>>,
    /// The last frame of each type, so a webview that mounted late still sees
    /// `ready` and the last `state` without a replay protocol (D37).
    last: Mutex<HashMap<&'static str, Box<RawValue>>>,
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
    last: HashMap<String, Box<RawValue>>,
}

/// The status keys carry the type name only at this edge (DV-17).
fn status_last(last: &HashMap<&'static str, Box<RawValue>>) -> HashMap<String, Box<RawValue>> {
    last.iter()
        .map(|(kind, frame)| ((*kind).to_string(), frame.clone()))
        .collect()
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
            .args(["run", "src/serve/main.ts", "serve"])
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
    let last = status_last(&lock(&state.last));
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
    remember_frame(&mut lock(&app.state::<EngineState>().last), &line);
    emit(app, EVENT_FRAME, line);
}

#[cfg(test)]
mod tests {
    use super::one_line;
    use super::{remember_frame, status_last};
    use serde_json::Value;
    use serde_json::value::RawValue;
    use std::collections::HashMap;

    fn remembered(lines: &[&str]) -> HashMap<&'static str, Box<RawValue>> {
        let mut last = HashMap::new();
        for line in lines {
            remember_frame(&mut last, line);
        }
        last
    }

    #[test]
    fn frame_memory_remembers_a_known_type() {
        let last = remembered(&[r#"{"type":"plan","n":1}"#]);
        assert_eq!(last["plan"].get(), r#"{"type":"plan","n":1}"#);
    }

    #[test]
    fn frame_memory_last_line_of_a_type_wins() {
        let last = remembered(&[r#"{"type":"plan","n":1}"#, r#"{"type":"plan","n":2}"#]);
        assert_eq!(last["plan"].get(), r#"{"type":"plan","n":2}"#);
    }

    #[test]
    fn frame_memory_ignores_an_unknown_type() {
        assert!(remembered(&[r#"{"type":"nope"}"#]).is_empty());
    }

    #[test]
    fn frame_memory_ignores_a_line_that_is_not_an_object() {
        for line in ["[1,2]", "\"plan\"", "plan", "{\"type\":", ""] {
            assert!(remembered(&[line]).is_empty(), "remembered {line:?}");
        }
    }

    #[test]
    fn frame_memory_status_is_the_stored_json() {
        let last = remembered(&[r#"{"type":"scan", "x": [1, 2]}"#]);
        let json = serde_json::to_string(&status_last(&last)).unwrap();
        assert_eq!(json, r#"{"scan":{"type":"scan", "x": [1, 2]}}"#);
    }

    #[test]
    fn one_line_leaves_exactly_one_terminating_newline() {
        assert_eq!(one_line("x"), b"x\n");
        assert_eq!(one_line("x\n"), b"x\n");
        assert_eq!(one_line("x\r\n\r\n"), b"x\n");
        assert_eq!(one_line(""), b"\n");
    }

    /// Reference: the `Value`-based implementation this change replaces (R5.5).
    fn legacy_last(lines: &[String]) -> HashMap<String, Value> {
        let mut last = HashMap::new();
        for line in lines {
            if let Ok(value) = serde_json::from_str::<Value>(line)
                && let Some(kind) = value.get("type").and_then(Value::as_str)
                && let Some(kind) = super::FRAME_TYPES.iter().copied().find(|k| *k == kind)
            {
                last.insert(kind.to_string(), value);
            }
        }
        last
    }

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn random_line(rng: &mut Rng) -> String {
        let kind = super::FRAME_TYPES[rng.below(super::FRAME_TYPES.len())];
        match rng.below(5) {
            0 => format!(r#"{{"type":"{kind}","n":{}}}"#, rng.below(1000)),
            1 => format!(
                r#"{{ "type" : "{kind}", "items": [{{"a": {}}}], "s": "x\"y" }}"#,
                rng.below(9)
            ),
            2 => {
                let other = ["\"other\"", "7", "null", "true", "[\"plan\"]", "{}"];
                format!(r#"{{"type":{},"n":1}}"#, other[rng.below(other.len())])
            }
            3 => ["[1,2]", "42", "null", "\"plan\"", "true"][rng.below(5)].to_string(),
            _ => [
                "{\"type\":\"plan\"",
                "{",
                "",
                "not json",
                "{\"type\":\"plan\"} x",
            ][rng.below(5)]
            .to_string(),
        }
    }

    /// Property 5: the remembered frames and the status JSON match the `Value`-based reference.
    #[test]
    fn frame_memory_property() {
        for seed in 1..=120u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let lines: Vec<String> = (0..60).map(|_| random_line(&mut rng)).collect();

            let mut last = HashMap::new();
            for line in &lines {
                remember_frame(&mut last, line);
            }

            let reference = legacy_last(&lines);
            let status: HashMap<String, Value> =
                serde_json::from_str(&serde_json::to_string(&status_last(&last)).unwrap()).unwrap();
            assert_eq!(status, reference, "seed {seed}");
            for kind in super::FRAME_TYPES {
                let got = last
                    .get(kind)
                    .map(|raw| serde_json::from_str::<Value>(raw.get()).unwrap());
                assert_eq!(got.as_ref(), reference.get(kind), "seed {seed} type {kind}");
            }
        }
    }

    /// Resident peak, in kB, from the kernel's own counter.
    fn vm_hwm_kb() -> u64 {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("VmHWM:"))
            .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
            .unwrap_or(0)
    }

    /// One dupes-shaped frame of `files` entries, from a fixed seed.
    fn bench_frame(files: usize) -> String {
        let mut rng = Rng(0x005E_EDE5);
        let mut out = String::from(r#"{"type":"dupes","files":["#);
        for i in 0..files {
            if i > 0 {
                out.push(',');
            }
            let size = 1_000_000 + rng.below(1_000_000_000);
            let hash = rng.next();
            out.push_str(&format!(
                r#"{{"path":"/media/node/2TB/Videos/clip-{i:05}.mp4","size":{size},"hash":"{hash:016x}"}}"#
            ));
        }
        out.push_str("]}");
        out
    }

    /// E5 (bench): cost of `remember_frame` against the legacy `Value` path, in
    /// one process, alternating five times. Run by scripts/bench/e5-frames.ts.
    #[test]
    #[ignore = "bench: run through scripts/bench/e5-frames.ts"]
    fn remember_frame_bench() {
        let frame = bench_frame(33_000);
        let lines = vec![frame.clone()];
        println!("E5 frame_bytes={}", frame.len());
        for run in 1..=5 {
            let before = vm_hwm_kb();
            let start = std::time::Instant::now();
            let mut last = HashMap::new();
            remember_frame(&mut last, &frame);
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            println!(
                "E5 run={run} impl=remember_frame ms={ms:.3} hwm_before_kb={before} hwm_after_kb={} kept={}",
                vm_hwm_kb(),
                last.len()
            );

            let before = vm_hwm_kb();
            let start = std::time::Instant::now();
            let kept = legacy_last(&lines).len();
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            println!(
                "E5 run={run} impl=legacy_value ms={ms:.3} hwm_before_kb={before} hwm_after_kb={} kept={kept}",
                vm_hwm_kb()
            );
        }
    }
}
