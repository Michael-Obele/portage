//! `portage-scan` — the filesystem half of Portage's scans, in Rust.
//!
//! The engine owns every DECISION (what is a duplicate, what may move, what is
//! safe to delete). This binary owns only the two things that are expensive and
//! that JavaScript cannot do at all: a directory walk that survives a FUSE
//! mount, and hashing that uses more than one core.
//!
//! # Why the walk is written by hand
//!
//! Measured on the real 2 TB archive (ntfs-3g, 33 347 files, 4 612 directories):
//!
//! | walker                                  | time    |
//! |-----------------------------------------|---------|
//! | `Bun.Glob("**/*")`                      | 178.5 s |
//! | `std::fs::read_dir` by absolute path    | 175.3 s |
//! | this walker (relative descent)          |   4.1 s |
//!
//! All three read the same tree. The difference is the PATH LENGTH, not the
//! language: one folder on that drive contains a real 462-segment chain
//! (`Docs/1stroundNET/images/images/…`), and ntfs-3g resolves every path
//! component per syscall. A stat of that deepest directory costs **621 ms by
//! absolute path** and **3 ms as `.` from inside it**.
//!
//! So the walker `chdir`s into each directory and opens children by name, which
//! is what GNU `find` (fts) does and why `find` finishes the same tree in 2.5 s.
//! JavaScript has no `openat` and cannot do this, which is the whole reason this
//! binary exists.
//!
//! # Protocol
//!
//! One JSON request on stdin, one JSON response on stdout, then exit:
//!
//! ```json
//! {"command":"walk","roots":["/media/archive"],"minSize":1,"maxDepth":null,
//!  "skipHidden":true,"excludeDirs":[".portage","$RECYCLE.BIN"]}
//! {"command":"digest","root":"/media/archive","mode":"full",
//!  "relatives":["a.mkv","b.mkv"],"threads":8}
//! ```
//!
//! Exit codes: 0 answered, 2 the request was rejected, 1 the binary broke.
//! A rejected request still writes `{"ok":false,…}` so the caller never has to
//! parse stderr to find out what it did wrong.

mod digest;
mod walk;

use std::io::Read;
use std::process::ExitCode;
use std::time::Instant;

use serde::{Deserialize, Serialize};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The largest path depth this binary will descend, as a backstop only.
///
/// The real archive contains a legitimate 462-segment chain, so a small cap
/// would silently hide files. A tree deeper than this is a corrupt structure or
/// a symlink loop that `file_type()` failed to see, and either way the honest
/// answer is to stop and say so rather than to recurse until the stack dies.
const DEPTH_BACKSTOP: usize = 4096;

/// The backstop must be deeper than any real tree. The archive this was
/// measured against has a legitimate 462-segment chain, so a cap in the low
/// hundreds would silently hide files; this asserts the intent at COMPILE time.
const _: () = assert!(DEPTH_BACKSTOP > 1024);

/// How many read failures are carried in a response. A tree where every
/// directory refuses permission would otherwise produce a response bigger than
/// the one the caller asked for.
pub const MAX_ERRORS: usize = 50;

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase")]
enum Request {
    /// Enumerate every regular file under each root.
    Walk(walk::WalkRequest),
    /// Hash a known list of files relative to one root.
    Digest(digest::DigestRequest),
}

#[derive(Debug, Serialize)]
struct Response<T> {
    ok: bool,
    version: &'static str,
    #[serde(flatten)]
    body: T,
}

#[derive(Debug, Serialize)]
struct Rejection {
    error: String,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("portage-scan {VERSION}");
        return ExitCode::SUCCESS;
    }

    let mut raw = String::new();
    if let Err(err) = std::io::stdin().read_to_string(&mut raw) {
        return reject(&format!("could not read the request from stdin: {err}"));
    }
    let raw = raw.trim();
    if raw.is_empty() {
        return reject("the request was empty; send one JSON object on stdin");
    }

    let started = Instant::now();
    let request: Request = match serde_json::from_str(raw) {
        Ok(request) => request,
        Err(err) => return reject(&format!("the request is not valid: {err}")),
    };

    match request {
        Request::Walk(request) => match walk::run(request, started) {
            Ok(body) => emit(&Response {
                ok: true,
                version: VERSION,
                body,
            }),
            Err(err) => reject(&err),
        },
        Request::Digest(request) => match digest::run(request, started) {
            Ok(body) => emit(&Response {
                ok: true,
                version: VERSION,
                body,
            }),
            Err(err) => reject(&err),
        },
    }
}

fn emit<T: Serialize>(response: &Response<T>) -> ExitCode {
    match serde_json::to_string(response) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("portage-scan: could not encode the response: {err}");
            ExitCode::FAILURE
        }
    }
}

fn reject(message: &str) -> ExitCode {
    let body = Rejection {
        error: message.to_string(),
    };
    match serde_json::to_string(&Response {
        ok: false,
        version: VERSION,
        body,
    }) {
        Ok(json) => {
            println!("{json}");
            ExitCode::from(2)
        }
        Err(_) => {
            eprintln!("portage-scan: {message}");
            ExitCode::from(2)
        }
    }
}

/// A process-wide lock for tests that change the working directory.
///
/// The walker and digester `chdir` on purpose — that is the fix, not a shortcut
/// — and a process has exactly one working directory. So any test that calls
/// `run` holds this lock for its whole body, which is why `cargo test` needs no
/// special flags to be correct here.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    pub fn cwd_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_walk_request_round_trips_from_the_documented_shape() {
        let json = r#"{"command":"walk","roots":["/tmp"],"minSize":1,
            "maxDepth":null,"skipHidden":true,"excludeDirs":[".portage"]}"#;
        let request: Request = serde_json::from_str(json).expect("parses");
        match request {
            Request::Walk(walk) => {
                assert_eq!(walk.roots, vec!["/tmp".to_string()]);
                assert_eq!(walk.min_size, 1);
                assert_eq!(walk.max_depth, None);
                assert!(walk.skip_hidden);
                assert_eq!(walk.exclude_dirs, vec![".portage".to_string()]);
            }
            Request::Digest(_) => panic!("parsed as the wrong command"),
        }
    }

    #[test]
    fn a_digest_request_round_trips_from_the_documented_shape() {
        let json = r#"{"command":"digest","root":"/tmp","mode":"full",
            "relatives":["a"],"threads":4}"#;
        let request: Request = serde_json::from_str(json).expect("parses");
        match request {
            Request::Digest(digest) => {
                assert_eq!(digest.root, "/tmp");
                assert_eq!(digest.mode, digest::DigestMode::Full);
                assert_eq!(digest.relatives, vec!["a".to_string()]);
                assert_eq!(digest.threads, Some(4));
            }
            Request::Walk(_) => panic!("parsed as the wrong command"),
        }
    }

    #[test]
    fn an_unknown_command_is_a_rejection_not_a_panic() {
        let request: Result<Request, _> = serde_json::from_str(r#"{"command":"nope"}"#);
        assert!(request.is_err());
    }
}
