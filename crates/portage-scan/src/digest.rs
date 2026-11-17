//! The digester: sha256 of a list of files, on more than one core.
//!
//! Two modes, and the difference is the whole safety argument:
//!
//! * `full` reads every byte. It is the only thing that may CONFIRM two files
//!   are the same.
//! * `sample` reads the first, middle and last 64 KiB. It may only REJECT a
//!   non-duplicate: two 1 MiB files differing in exactly one byte outside those
//!   three windows produce an equal sample and an unequal full digest.
//!
//! The sample digest is byte-for-byte the one `src/util/hash.ts` produces — the
//! file's size as a decimal string, then the three windows in ascending offset
//! order — because a scan that switches engines must not change its answer.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::MAX_ERRORS;

fn default_window() -> u64 {
    64 * 1024
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DigestMode {
    /// Every byte. The only mode that can confirm identity.
    #[default]
    Full,
    /// First, middle and last window. Rejects only.
    Sample,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestRequest {
    pub root: String,
    pub relatives: Vec<String>,
    #[serde(default)]
    pub mode: DigestMode,
    /// `null` means "as many as the machine offers", capped at 32.
    #[serde(default)]
    pub threads: Option<usize>,
    #[serde(default = "default_window")]
    pub window_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Digested {
    pub relative: String,
    pub size: u64,
    pub digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestError {
    pub relative: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestBody {
    pub command: &'static str,
    pub elapsed_ms: u64,
    pub mode: DigestMode,
    pub root: String,
    pub digests: Vec<Digested>,
    pub errors: Vec<DigestError>,
    pub error_count: u64,
    /// How many cores actually did work, so a caller can tell a one-thread run
    /// from a throttled one.
    pub threads: usize,
}

/// Never more than this, however many cores the machine claims. The work is
/// sequential reads; past this the drive is the bottleneck and extra threads
/// only add memory pressure.
const MAX_THREADS: usize = 32;

fn hex(bytes: [u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn digest_full(relative: &str) -> Result<Digested, String> {
    let mut file = File::open(relative).map_err(|err| err.to_string())?;
    let size = file.metadata().map_err(|err| err.to_string())?.len();
    let mut hasher = Sha256::new();
    // 1 MiB chunks: a 600 MB episode must never be fully resident, and a tiny
    // buffer turns a 2 TB scan into millions of FUSE round trips.
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(Digested {
        relative: relative.to_string(),
        size,
        digest: hex(hasher.finalize().into()),
    })
}

fn digest_sample(relative: &str, window: u64) -> Result<Digested, String> {
    let mut file = File::open(relative).map_err(|err| err.to_string())?;
    let size = file.metadata().map_err(|err| err.to_string())?.len();
    if size == 0 {
        // The engine's empty-file answer, reproduced exactly: the digest of
        // nothing, with no size prefix.
        return Ok(Digested {
            relative: relative.to_string(),
            size,
            digest: hex(Sha256::new().finalize().into()),
        });
    }

    let mut hasher = Sha256::new();
    // The JS writes the size as ASCII first, then the windows.
    hasher.update(size.to_string().as_bytes());

    let mut offsets: BTreeSet<u64> = BTreeSet::new();
    offsets.insert(0);
    offsets.insert((size / 2).saturating_sub(window / 2));
    offsets.insert(size.saturating_sub(window));

    for offset in offsets {
        let length = window.min(size - offset);
        let mut buffer = vec![0u8; length as usize];
        file.seek(SeekFrom::Start(offset))
            .map_err(|err| err.to_string())?;
        file.read_exact(&mut buffer)
            .map_err(|err| err.to_string())?;
        hasher.update(&buffer);
    }

    Ok(Digested {
        relative: relative.to_string(),
        size,
        digest: hex(hasher.finalize().into()),
    })
}

fn digest_one(relative: &str, mode: DigestMode, window: u64) -> Result<Digested, String> {
    match mode {
        DigestMode::Full => digest_full(relative),
        DigestMode::Sample => digest_sample(relative, window),
    }
}

pub fn run(request: DigestRequest, started: Instant) -> Result<DigestBody, String> {
    if request.relatives.is_empty() {
        return Err("digest needs at least one relative path".into());
    }
    if !std::path::Path::new(&request.root).is_dir() {
        // "Not a directory" covers the drive being unplugged mid-scan, which is
        // the common case on a USB archive. Say both, because they send a person
        // to different places.
        return Err(format!(
            "{} is not a directory — it is missing, or the drive holding it is no longer mounted",
            request.root
        ));
    }

    // One chdir for the whole process, before any thread starts: every later
    // open is relative, so a deep path resolves its own depth only.
    let origin = std::env::current_dir().map_err(|err| format!("no working directory: {err}"))?;
    std::env::set_current_dir(&request.root)
        .map_err(|err| format!("could not enter {}: {err}", request.root))?;

    let jobs = request.relatives.len();
    let wanted = request.threads.unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
    });
    let threads = wanted.clamp(1, MAX_THREADS).min(jobs);
    let window = request.window_bytes;
    let mode = request.mode;

    // Contiguous chunks, one per thread, and results come back in input order
    // because each thread returns its own slice in order. No lock, no channel.
    let chunk = jobs.div_ceil(threads);
    let mut results: Vec<Result<Digested, String>> = Vec::with_capacity(jobs);
    std::thread::scope(|scope| {
        let handles: Vec<_> = request
            .relatives
            .chunks(chunk)
            .map(|slice| {
                scope.spawn(move || {
                    slice
                        .iter()
                        .map(|relative| digest_one(relative, mode, window))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for handle in handles {
            match handle.join() {
                Ok(mut chunk) => results.append(&mut chunk),
                Err(_) => results.push(Err("a digest thread stopped unexpectedly".into())),
            }
        }
    });

    let _ = std::env::set_current_dir(&origin);

    let mut digests = Vec::with_capacity(results.len());
    let mut errors = Vec::new();
    let mut error_count = 0u64;
    for (relative, result) in request.relatives.iter().zip(results) {
        match result {
            Ok(digested) => digests.push(digested),
            Err(reason) => {
                error_count += 1;
                if errors.len() < MAX_ERRORS {
                    errors.push(DigestError {
                        relative: relative.clone(),
                        reason,
                    });
                }
            }
        }
    }

    Ok(DigestBody {
        command: "digest",
        elapsed_ms: started.elapsed().as_millis() as u64,
        mode,
        root: request.root,
        digests,
        errors,
        error_count,
        threads,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::cwd_lock;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::MutexGuard;

    /// A throwaway tree that also holds the working-directory lock: the digester
    /// `chdir`s to its root, and a process has one cwd.
    struct TempTree {
        path: PathBuf,
        _cwd: MutexGuard<'static, ()>,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let guard = cwd_lock();
            let n = NEXT.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "portage-digest-test-{}-{}-{}",
                std::process::id(),
                tag,
                n
            ));
            fs::create_dir_all(&path).expect("temp root");
            TempTree { path, _cwd: guard }
        }

        fn bytes(&self, relative: &str, contents: &[u8]) {
            let path = self.path.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            let mut file = File::create(&path).expect("create");
            file.write_all(contents).expect("write");
        }

        fn path(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn digest(tree: &TempTree, relatives: Vec<String>, mode: DigestMode) -> DigestBody {
        run(
            DigestRequest {
                root: tree.path(),
                relatives,
                mode,
                threads: Some(2),
                window_bytes: default_window(),
            },
            Instant::now(),
        )
        .expect("digest runs")
    }

    #[test]
    fn a_full_digest_is_the_sha256_of_the_file() {
        let tree = TempTree::new("empty");
        tree.bytes("empty.bin", b"");
        let body = digest(&tree, vec!["empty.bin".into()], DigestMode::Full);
        assert_eq!(
            body.digests[0].digest,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn the_known_answer_for_abc_matches() {
        let tree = TempTree::new("abc");
        tree.bytes("abc.bin", b"abc");
        let body = digest(&tree, vec!["abc.bin".into()], DigestMode::Full);
        assert_eq!(
            body.digests[0].digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(body.digests[0].size, 3);
    }

    #[test]
    fn identical_files_digest_identically_in_both_modes() {
        let tree = TempTree::new("same");
        tree.bytes("one.bin", &vec![7u8; 200_000]);
        tree.bytes("two.bin", &vec![7u8; 200_000]);
        for mode in [DigestMode::Full, DigestMode::Sample] {
            let body = digest(&tree, vec!["one.bin".into(), "two.bin".into()], mode);
            assert_eq!(body.digests.len(), 2);
            assert_eq!(body.digests[0].digest, body.digests[1].digest);
        }
    }

    #[test]
    fn a_sample_can_match_while_the_full_digest_differs() {
        // The documented hazard, pinned: the difference sits at 128 KiB, which
        // is outside the first, middle and last 64 KiB windows of a 1 MiB file.
        let tree = TempTree::new("hazard");
        let mut one = vec![0u8; 1024 * 1024];
        let mut two = one.clone();
        one[128 * 1024] = 1;
        two[128 * 1024] = 2;
        tree.bytes("one.bin", &one);
        tree.bytes("two.bin", &two);

        let sampled = digest(
            &tree,
            vec!["one.bin".into(), "two.bin".into()],
            DigestMode::Sample,
        );
        assert_eq!(
            sampled.digests[0].digest, sampled.digests[1].digest,
            "the sample cannot see this difference — that is why it never confirms"
        );

        let full = digest(
            &tree,
            vec!["one.bin".into(), "two.bin".into()],
            DigestMode::Full,
        );
        assert_ne!(full.digests[0].digest, full.digests[1].digest);
    }

    #[test]
    fn an_empty_file_hashes_to_the_empty_digest_in_sample_mode_too() {
        // The JS special-cases size 0 before prefixing the size; matching it
        // keeps one scan's answer equal to another's.
        let tree = TempTree::new("empty-sample");
        tree.bytes("none.bin", b"");
        let body = digest(&tree, vec!["none.bin".into()], DigestMode::Sample);
        assert_eq!(
            body.digests[0].digest,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn a_missing_file_is_an_error_and_the_others_still_digest() {
        let tree = TempTree::new("missing");
        tree.bytes("here.bin", b"abc");
        let body = digest(
            &tree,
            vec!["gone.bin".into(), "here.bin".into()],
            DigestMode::Full,
        );
        assert_eq!(body.digests.len(), 1);
        assert_eq!(body.digests[0].relative, "here.bin");
        assert_eq!(body.error_count, 1);
        assert_eq!(body.errors[0].relative, "gone.bin");
    }

    #[test]
    fn a_nested_relative_path_is_resolved_from_the_root() {
        let tree = TempTree::new("nested");
        tree.bytes("a/b/c.bin", b"deep");
        let body = digest(&tree, vec!["a/b/c.bin".into()], DigestMode::Full);
        assert_eq!(body.digests[0].size, 4);
        assert_eq!(body.error_count, 0);
    }

    #[test]
    fn results_come_back_in_the_order_they_were_asked_for() {
        let tree = TempTree::new("order");
        for name in ["a.bin", "b.bin", "c.bin", "d.bin", "e.bin"] {
            tree.bytes(name, name.as_bytes());
        }
        let asked: Vec<String> = vec!["e.bin", "c.bin", "a.bin", "d.bin", "b.bin"]
            .into_iter()
            .map(String::from)
            .collect();
        let body = digest(&tree, asked.clone(), DigestMode::Full);
        let got: Vec<String> = body.digests.iter().map(|d| d.relative.clone()).collect();
        assert_eq!(got, asked);
    }

    #[test]
    fn an_empty_list_is_rejected_rather_than_answered_with_nothing() {
        let tree = TempTree::new("none");
        let result = run(
            DigestRequest {
                root: tree.path(),
                relatives: Vec::new(),
                mode: DigestMode::Full,
                threads: None,
                window_bytes: default_window(),
            },
            Instant::now(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn a_root_that_is_not_a_directory_is_rejected() {
        let tree = TempTree::new("bad-root");
        tree.bytes("file.bin", b"x");
        let result = run(
            DigestRequest {
                root: format!("{}/file.bin", tree.path()),
                relatives: vec!["file.bin".into()],
                mode: DigestMode::Full,
                threads: None,
                window_bytes: default_window(),
            },
            Instant::now(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn the_digest_leaves_the_process_where_it_found_it() {
        let tree = TempTree::new("cwd");
        tree.bytes("file.bin", b"x");
        let before = std::env::current_dir().expect("cwd");
        digest(&tree, vec!["file.bin".into()], DigestMode::Full);
        assert_eq!(before, std::env::current_dir().expect("cwd"));
    }
}
