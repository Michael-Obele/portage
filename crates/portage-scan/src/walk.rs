//! The walker: enumerate regular files under one or more roots.
//!
//! The one rule that matters is in `descend`: every path this module resolves is
//! relative to the directory it is standing in. See the crate docs for the
//! measurement that makes this worth a hand-written walker.

use std::fs;
use std::path::Path;
use std::time::{Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::{DEPTH_BACKSTOP, MAX_ERRORS};

fn default_min_size() -> u64 {
    // Zero-byte files are not candidates for anything Portage does, and a tree
    // of empty placeholders is common. The caller can ask for them anyway.
    1
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkRequest {
    pub roots: Vec<String>,
    #[serde(default = "default_min_size")]
    pub min_size: u64,
    /// `null`/absent means unlimited (up to the backstop).
    #[serde(default)]
    pub max_depth: Option<usize>,
    #[serde(default = "default_true")]
    pub skip_hidden: bool,
    /// Directory names to skip. An entry containing `/` is matched as a path
    /// SUFFIX, so `Android/data` excludes that pair wherever it appears.
    #[serde(default)]
    pub exclude_dirs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkedFile {
    /// Index into the response's `roots`.
    pub root: usize,
    /// Path relative to that root, with `/` separators.
    pub relative: String,
    pub size: u64,
    /// Seconds since the Unix epoch, or `null` when the platform will not say.
    pub mtime: Option<i64>,
    pub depth: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkError {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deepest {
    pub relative: String,
    pub depth: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkBody {
    pub command: &'static str,
    pub elapsed_ms: u64,
    pub roots: Vec<String>,
    pub dirs: u64,
    pub files: Vec<WalkedFile>,
    pub bytes: u64,
    pub errors: Vec<WalkError>,
    /// Every failure, including the ones past `MAX_ERRORS` that `errors` omits.
    pub error_count: u64,
    pub deepest: Option<Deepest>,
    /// Directories not descended because they were deeper than the caller asked
    /// for (or than the backstop allows). Never silent.
    pub depth_limited: u64,
}

/// One directory's contents, read in a single sweep and detached from the
/// handle before anything is entered.
type Listing = (Vec<(String, u64, Option<i64>)>, Vec<String>);

struct Walker<'a> {
    request: &'a WalkRequest,
    root_index: usize,
    /// Names from the root down to the directory we are standing in. Its length
    /// IS the depth, which is why no separate counter is needed.
    trail: Vec<String>,
    files: Vec<WalkedFile>,
    errors: Vec<WalkError>,
    error_count: u64,
    dirs: u64,
    bytes: u64,
    deepest: Option<Deepest>,
    depth_limited: u64,
}

impl<'a> Walker<'a> {
    fn relative(&self) -> String {
        self.trail.join("/")
    }

    fn note_error(&mut self, path: &str, reason: impl Into<String>) {
        self.error_count += 1;
        if self.errors.len() < MAX_ERRORS {
            self.errors.push(WalkError {
                path: path.to_string(),
                reason: reason.into(),
            });
        }
    }

    fn excluded(&self, name: &str) -> bool {
        self.request.exclude_dirs.iter().any(|pattern| {
            if !pattern.contains('/') {
                return pattern == name;
            }
            // Whole segments only: `Android/data` must not match `MyAndroid/data`.
            let segments: Vec<&str> = pattern.split('/').collect();
            let Some(skip) = (self.trail.len() + 1).checked_sub(segments.len()) else {
                return false;
            };
            segments.iter().enumerate().all(|(i, segment)| {
                let at = skip + i;
                let dir = if at < self.trail.len() {
                    self.trail[at].as_str()
                } else {
                    name
                };
                dir == *segment
            })
        })
    }

    /// Read the directory we are standing in. Errors are recorded, never raised:
    /// one unreadable folder must not end a scan of two terabytes.
    fn read_current(&mut self) -> Listing {
        let here = self.relative();
        let mut files: Vec<(String, u64, Option<i64>)> = Vec::new();
        let mut dirs: Vec<String> = Vec::new();

        let entries = match fs::read_dir(".") {
            Ok(entries) => entries,
            Err(err) => {
                self.note_error(&here, err.to_string());
                return (files, dirs);
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    self.note_error(&here, err.to_string());
                    continue;
                }
            };
            let raw = entry.file_name();
            let name = match raw.to_str() {
                Some(name) => name.to_owned(),
                None => {
                    // A name that is not valid UTF-8 cannot cross the JSON wire
                    // intact, so it is REPORTED rather than mangled: a lossy name
                    // produces a path that does not exist, and a silently dropped
                    // file is the \"0 duplicates\" lie this app is built against.
                    // The JS walker drops these too; the difference is that this
                    // one says so.
                    self.note_error(&raw.to_string_lossy(), "the name is not valid UTF-8");
                    continue;
                }
            };
            if self.request.skip_hidden && name.starts_with('.') {
                continue;
            }
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(err) => {
                    self.note_error(&name, err.to_string());
                    continue;
                }
            };
            if kind.is_dir() {
                if !self.excluded(&name) {
                    dirs.push(name);
                }
                continue;
            }
            if !kind.is_file() {
                // A symlink is deliberately neither: `is_file()` is false for
                // one, so nothing outside the root can be reached through a
                // link. This is §6 rule 6, enforced at discovery.
                continue;
            }
            match entry.metadata() {
                Ok(meta) => {
                    if meta.len() >= self.request.min_size {
                        files.push((name, meta.len(), mtime_of(&meta)));
                    }
                }
                // A file that vanished between listing and stat is worth
                // saying, and is not worth failing a scan over.
                Err(err) => self.note_error(&name, err.to_string()),
            }
        }

        (files, dirs)
    }

    /// Record one directory's files. `depth` is the directory's own depth.
    fn record(&mut self, files: Vec<(String, u64, Option<i64>)>, depth: usize) {
        let parent = self.relative();
        for (name, size, mtime) in files {
            self.bytes = self.bytes.saturating_add(size);
            let relative = if parent.is_empty() {
                name.clone()
            } else {
                format!("{parent}/{name}")
            };
            if self
                .deepest
                .as_ref()
                .is_none_or(|deepest| depth > deepest.depth)
            {
                self.deepest = Some(Deepest {
                    relative: relative.clone(),
                    depth,
                });
            }
            self.files.push(WalkedFile {
                root: self.root_index,
                relative,
                size,
                mtime,
                depth,
            });
        }
    }

    /// Enter `name`, record what is inside, leave. Always restores the cwd, so a
    /// failure halfway down a tree cannot leave the walker somewhere else.
    fn descend(&mut self, name: &str) {
        let depth = self.trail.len() + 1;
        let limit = self.request.max_depth.unwrap_or(usize::MAX);
        if depth > limit || depth > DEPTH_BACKSTOP {
            self.depth_limited += 1;
            return;
        }

        if let Err(err) = std::env::set_current_dir(name) {
            self.note_error(&format!("{}/{}", self.relative(), name), err.to_string());
            return;
        }
        self.trail.push(name.to_string());
        self.dirs += 1;

        // Read the whole directory BEFORE entering any child, and drop the
        // handle first: an open `ReadDir` held across a `chdir` lists the wrong
        // directory.
        let (files, dirs) = self.read_current();
        // A file's depth counts its own name, so `a/b/c.mkv` is depth 3. That is
        // the number a person means by "how deep is this path", and it is the
        // number the engine reports back on Doctor.
        self.record(files, depth + 1);

        for dir in dirs {
            self.descend(&dir);
        }

        self.trail.pop();
        if let Err(err) = std::env::set_current_dir("..") {
            // The trail is already popped, so the walk is no longer where it
            // thinks it is. Stop rather than attribute files to the wrong folder.
            self.note_error(
                &self.relative(),
                format!("could not leave the directory: {err}"),
            );
            self.trail.clear();
        }
    }
}

fn mtime_of(meta: &fs::Metadata) -> Option<i64> {
    let modified = meta.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_secs() as i64)
}

pub fn run(request: WalkRequest, started: Instant) -> Result<WalkBody, String> {
    if request.roots.is_empty() {
        return Err("walk needs at least one root".into());
    }

    // The walker chdirs, so it must start from a known place and put it back.
    let origin = std::env::current_dir().map_err(|err| format!("no working directory: {err}"))?;

    let mut files = Vec::new();
    let mut errors = Vec::new();
    let mut error_count = 0u64;
    let mut dirs = 0u64;
    let mut bytes = 0u64;
    let mut deepest: Option<Deepest> = None;
    let mut depth_limited = 0u64;

    for (root_index, root) in request.roots.iter().enumerate() {
        if !Path::new(root).is_dir() {
            error_count += 1;
            if errors.len() < MAX_ERRORS {
                errors.push(WalkError {
                    path: root.clone(),
                    reason: "not a directory — it is missing, or the drive holding it is no longer mounted"
                        .into(),
                });
            }
            continue;
        }
        if let Err(err) = std::env::set_current_dir(root) {
            error_count += 1;
            if errors.len() < MAX_ERRORS {
                errors.push(WalkError {
                    path: root.clone(),
                    reason: err.to_string(),
                });
            }
            continue;
        }

        let mut walker = Walker {
            request: &request,
            root_index,
            trail: Vec::new(),
            files: Vec::new(),
            errors: Vec::new(),
            error_count: 0,
            dirs: 0,
            bytes: 0,
            deepest: None,
            depth_limited: 0,
        };

        // The root itself is depth 0; a file sitting directly in it is depth 1,
        // which is what a caller asking "how deep is this" means.
        let (root_files, root_dirs) = walker.read_current();
        walker.record(root_files, 1);
        for name in root_dirs {
            walker.descend(&name);
        }

        files.append(&mut walker.files);
        errors.append(&mut walker.errors);
        error_count += walker.error_count;
        dirs += walker.dirs;
        bytes = bytes.saturating_add(walker.bytes);
        depth_limited += walker.depth_limited;
        if let Some(found) = walker.deepest {
            deepest = Some(match deepest {
                Some(current) if current.depth >= found.depth => current,
                _ => found,
            });
        }

        let _ = std::env::set_current_dir(&origin);
    }

    let _ = std::env::set_current_dir(&origin);

    Ok(WalkBody {
        command: "walk",
        elapsed_ms: started.elapsed().as_millis() as u64,
        roots: request.roots,
        dirs,
        files,
        bytes,
        errors,
        error_count,
        deepest,
        depth_limited,
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
    use std::time::SystemTime;

    /// A throwaway tree that also holds the working-directory lock: the walker
    /// `chdir`s, and a process has one cwd, so tests run one at a time.
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
                "portage-scan-test-{}-{}-{}",
                std::process::id(),
                tag,
                n
            ));
            fs::create_dir_all(&path).expect("temp root");
            TempTree { path, _cwd: guard }
        }

        fn file(&self, relative: &str, bytes: usize) {
            let path = self.path.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            let mut file = File::create(&path).expect("create");
            file.write_all(&vec![b'x'; bytes]).expect("write");
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

    fn request() -> WalkRequest {
        WalkRequest {
            roots: Vec::new(),
            min_size: 1,
            max_depth: None,
            skip_hidden: true,
            exclude_dirs: Vec::new(),
        }
    }

    fn walk(tree: &TempTree, mut req: WalkRequest) -> WalkBody {
        if req.roots.is_empty() {
            req.roots = vec![tree.path()];
        }
        run(req, Instant::now()).expect("walk runs")
    }

    fn relatives(body: &WalkBody) -> Vec<String> {
        let mut found: Vec<String> = body.files.iter().map(|f| f.relative.clone()).collect();
        found.sort();
        found
    }

    #[test]
    fn it_reports_every_file_with_its_relative_path_and_size() {
        let tree = TempTree::new("basic");
        tree.file("a.mkv", 10);
        tree.file("one/b.mkv", 20);
        tree.file("one/two/c.mkv", 30);

        let body = walk(&tree, request());
        assert_eq!(
            relatives(&body),
            vec!["a.mkv", "one/b.mkv", "one/two/c.mkv"]
        );
        assert_eq!(body.bytes, 60);
        assert_eq!(body.dirs, 2);
        assert_eq!(body.error_count, 0);
        assert_eq!(body.depth_limited, 0);
    }

    #[test]
    fn empty_files_are_skipped_at_the_default_floor() {
        let tree = TempTree::new("empty");
        tree.file("hollow.mkv", 0);
        tree.file("real.mkv", 1);

        let body = walk(&tree, request());
        assert_eq!(relatives(&body), vec!["real.mkv"]);
    }

    #[test]
    fn a_hidden_directory_is_not_entered() {
        let tree = TempTree::new("hidden");
        tree.file(".cache/buried.mkv", 5);
        tree.file("kept.mkv", 5);

        let body = walk(&tree, request());
        assert_eq!(relatives(&body), vec!["kept.mkv"]);
    }

    #[test]
    fn excluded_directory_names_are_not_entered() {
        let tree = TempTree::new("excluded");
        tree.file(".portage/trash/old.mkv", 5);
        tree.file("Videos/keep.mkv", 5);

        let mut req = request();
        req.exclude_dirs = vec![".portage".into(), "System Volume Information".into()];
        let body = walk(&tree, req);
        assert_eq!(relatives(&body), vec!["Videos/keep.mkv"]);
    }

    #[test]
    fn a_multi_segment_exclusion_matches_as_a_path_suffix() {
        let tree = TempTree::new("suffix");
        tree.file("Android/data/com.app/cache.bin", 5);
        tree.file("Android/media/com.app/keep.mkv", 5);

        let mut req = request();
        req.exclude_dirs = vec!["Android/data".into()];
        let body = walk(&tree, req);
        assert_eq!(relatives(&body), vec!["Android/media/com.app/keep.mkv"]);
    }

    #[test]
    fn exclusion_matches_whole_segments_only() {
        let tree = TempTree::new("segments");
        tree.file("Videos/Android/data/com.app/cache.bin", 5);
        tree.file("Videos/MyAndroid/data/com.app/keep.mkv", 5);

        let mut req = request();
        req.exclude_dirs = vec!["Android/data".into()];
        let body = walk(&tree, req);
        assert_eq!(
            relatives(&body),
            vec!["Videos/MyAndroid/data/com.app/keep.mkv"]
        );
    }

    #[test]
    fn exclusion_without_a_slash_matches_that_name_at_any_depth() {
        let tree = TempTree::new("anydepth");
        tree.file("a/b/cache/x.bin", 5);
        tree.file("a/b/cachex/keep.mkv", 5);

        let mut req = request();
        req.exclude_dirs = vec!["cache".into()];
        let body = walk(&tree, req);
        assert_eq!(relatives(&body), vec!["a/b/cachex/keep.mkv"]);
    }

    /// Reference: the directory path must equal the pattern, or end with `/`
    /// plus the pattern. A pattern without `/` is a directory name.
    fn reference_excluded(pattern: &str, dirs: &[String]) -> bool {
        let path = dirs.join("/");
        if pattern.contains('/') {
            path == pattern || path.ends_with(&format!("/{pattern}"))
        } else {
            dirs.last().is_some_and(|name| name == pattern)
        }
    }

    #[test]
    fn exclusion_agrees_with_the_reference_matcher() {
        const SEED: u64 = 0x5eed_0004;
        const WORDS: [&str; 5] = ["Android", "data", "MyAndroid", "x", "cache"];
        let mut state = SEED;
        let mut next = |bound: usize| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((state >> 33) as usize) % bound
        };
        for iteration in 0..500 {
            let pick = |n: usize, next: &mut dyn FnMut(usize) -> usize| -> Vec<String> {
                (0..n)
                    .map(|_| WORDS[next(WORDS.len())].to_string())
                    .collect()
            };
            let depth = 1 + next(5);
            let mut dirs = pick(depth, &mut next);
            let name = dirs.pop().expect("one name");
            let segs = 1 + next(3);
            let pattern = pick(segs, &mut next).join("/");
            let mut req = request();
            req.exclude_dirs = vec![pattern.clone()];
            let walker = Walker {
                request: &req,
                root_index: 0,
                trail: dirs.clone(),
                files: Vec::new(),
                errors: Vec::new(),
                error_count: 0,
                dirs: 0,
                bytes: 0,
                deepest: None,
                depth_limited: 0,
            };
            dirs.push(name.clone());
            assert_eq!(
                walker.excluded(&name),
                reference_excluded(&pattern, &dirs),
                "seed {SEED:#x} iteration {iteration} pattern {pattern:?} path {dirs:?}"
            );
        }
    }

    #[test]
    fn the_deepest_directory_is_reported() {
        let tree = TempTree::new("deep");
        tree.file("a.mkv", 1);
        tree.file("one/two/three/deep.mkv", 1);

        let body = walk(&tree, request());
        let deepest = body.deepest.expect("a deepest entry");
        assert_eq!(deepest.depth, 4);
        assert!(deepest.relative.ends_with("deep.mkv"));
    }

    #[test]
    fn a_depth_limit_stops_the_descent_and_says_so() {
        let tree = TempTree::new("limit");
        tree.file("one/two/three/deep.mkv", 1);
        tree.file("shallow.mkv", 1);

        let mut req = request();
        req.max_depth = Some(2);
        let body = walk(&tree, req);
        assert_eq!(
            relatives(&body),
            vec!["shallow.mkv"],
            "only the shallow file is reachable"
        );
        assert_eq!(body.depth_limited, 1, "the cut is counted, not hidden");
    }

    #[test]
    fn a_missing_root_is_an_error_not_a_panic() {
        let tree = TempTree::new("missing");
        let mut req = request();
        req.roots = vec!["/definitely/not/here".into()];
        let body = walk(&tree, req);
        assert!(body.files.is_empty());
        assert_eq!(body.error_count, 1);
        assert!(body.errors[0].reason.contains("not a directory"));
    }

    #[test]
    fn several_roots_are_walked_and_attributed_by_index() {
        // One tree, two roots: `TempTree` holds the process-wide cwd lock, so a
        // test must never hold two of them at once.
        let tree = TempTree::new("roots");
        tree.file("first/a.mkv", 1);
        tree.file("second/b.mkv", 2);

        let mut req = request();
        req.roots = vec![
            format!("{}/first", tree.path()),
            format!("{}/second", tree.path()),
        ];
        let body = walk(&tree, req);
        assert_eq!(body.files.len(), 2);
        let a = body
            .files
            .iter()
            .find(|f| f.relative == "a.mkv")
            .expect("a");
        let b = body
            .files
            .iter()
            .find(|f| f.relative == "b.mkv")
            .expect("b");
        assert_eq!(a.root, 0);
        assert_eq!(b.root, 1);
    }

    #[test]
    fn a_deep_chain_is_walked_instead_of_overflowing() {
        // The real archive has a 462-segment chain. Build a short version and
        // assert the walker reaches the bottom of it.
        let tree = TempTree::new("chain");
        let mut relative = String::from("images");
        for _ in 0..40 {
            relative.push_str("/images");
        }
        tree.file(&format!("{relative}/bottom.mkv"), 7);

        let body = walk(&tree, request());
        assert_eq!(relatives(&body).len(), 1);
        assert_eq!(body.files[0].size, 7);
        let expected = relative.split('/').count() + 1;
        assert_eq!(body.files[0].depth, expected);
    }

    #[test]
    fn the_walk_leaves_the_process_where_it_found_it() {
        let tree = TempTree::new("cwd");
        tree.file("a/b/c.mkv", 1);
        let before = std::env::current_dir().expect("cwd");
        walk(&tree, request());
        let after = std::env::current_dir().expect("cwd");
        assert_eq!(before, after);
    }

    #[test]
    fn a_root_that_is_a_file_reports_what_it_is_instead_of_walking_it() {
        let tree = TempTree::new("file-root");
        tree.file("real.mkv", 3);
        let mut req = request();
        req.roots = vec![format!("{}/real.mkv", tree.path())];
        let body = walk(&tree, req);
        assert_eq!(body.error_count, 1);
        assert!(body.files.is_empty());
    }

    #[test]
    fn a_name_that_is_not_utf8_is_reported_rather_than_mangled() {
        // A lossy name would produce a path that does not exist, so the file is
        // skipped AND counted. The JS walker silently drops these too; the
        // difference is that this one says so, which keeps "0 duplicates" from
        // being a claim about a tree it did not fully read.
        use std::os::unix::ffi::OsStringExt;
        let tree = TempTree::new("nonutf8");
        let name =
            std::ffi::OsString::from_vec(vec![b'b', b'a', b'd', 0xff, b'.', b'm', b'k', b'v']);
        std::fs::write(tree.path.join(&name), b"xxxx").expect("write");

        let body = walk(&tree, request());
        assert!(body.files.is_empty());
        assert_eq!(body.error_count, 1);
        assert!(body.errors[0].reason.contains("UTF-8"));
    }

    #[test]
    fn mtimes_are_seconds_and_are_present_for_a_real_file() {
        let tree = TempTree::new("mtime");
        tree.file("a.mkv", 1);
        let body = walk(&tree, request());
        let mtime = body.files[0].mtime.expect("an mtime");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("now")
            .as_secs() as i64;
        assert!(
            (now - mtime).abs() < 86_400,
            "mtime {mtime} is not near now {now}"
        );
    }
}
