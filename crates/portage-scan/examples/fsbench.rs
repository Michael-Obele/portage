//! Bench-only candidates for E2 and E3. Not shipped: nothing in `src/` uses it.
//! Each command prints one JSON line. Every descent is one segment at a time
//! through a directory handle, so ntfs-3g never resolves a long path.

use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Component, Path};
use std::process::ExitCode;
use std::time::Instant;

const USAGE: &str = "fsbench: bench-only candidates for E2 and E3\n\
usage:\n  \
fsbench build <root> deep|shallow [--files N]   (untimed fixture setup)\n  \
fsbench remove <dir>\n  \
fsbench move <from-dir> <to-dir> [--files N]\n  \
fsbench stat <dir> [--files N]\n\
move and stat name files f0000.bin, f0001.bin, ... as the bench fixtures do (default N 1000)";

const DEFAULT_FILES: usize = 1000;
const DEEP_SEGMENTS: usize = 462;
const FILE_BYTES: usize = 4096;

fn cstr(s: &std::ffi::OsStr) -> Result<CString, String> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(s.as_bytes()).map_err(|e| e.to_string())
}

fn openat_dir(parent: i32, name: &CString) -> Result<OwnedFd, String> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
    // SAFETY: name is NUL-terminated; a negative result is handled below.
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(format!(
            "openat {:?}: {}",
            name,
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: fd is open and owned by nobody else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Opens `path` one segment at a time, from `/` or from the current directory.
fn open_dir_walk(path: &Path) -> Result<OwnedFd, String> {
    let start = if path.is_absolute() { c"/" } else { c"." };
    let mut cur = openat_dir(libc::AT_FDCWD, &CString::from(start))?;
    for part in path.components() {
        if let Component::Normal(seg) = part {
            cur = openat_dir(cur.as_raw_fd(), &cstr(seg)?)?;
        }
    }
    Ok(cur)
}

fn names(files: usize) -> Vec<CString> {
    (0..files)
        .map(|i| CString::new(format!("f{i:04}.bin")).expect("no NUL in a formatted name"))
        .collect()
}

fn files_flag(args: &[String]) -> Result<usize, String> {
    match args {
        [] => Ok(DEFAULT_FILES),
        [flag, n] if flag == "--files" => n.parse().map_err(|_| format!("bad --files {n}")),
        _ => Err(USAGE.to_string()),
    }
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Builds a bench fixture the way `scripts/bench/fixtures.ts` names it, but one
/// segment at a time, so setup does not cost minutes per file on ntfs-3g.
fn build(args: &[String]) -> Result<(), String> {
    let [root, kind, rest @ ..] = args else {
        return Err(USAGE.to_string());
    };
    let files = files_flag(rest)?;
    let segments = match kind.as_str() {
        "deep" => DEEP_SEGMENTS,
        "shallow" => 0,
        _ => return Err(USAGE.to_string()),
    };
    let mut cur = open_dir_walk(Path::new(root))?;
    for i in std::iter::once(None).chain((0..segments).map(Some)) {
        let name = match i {
            None => CString::new(kind.as_str()),
            Some(n) => CString::new(format!("d{n}")),
        }
        .map_err(|e| e.to_string())?;
        // SAFETY: the handle is open and the name is NUL-terminated.
        if unsafe { libc::mkdirat(cur.as_raw_fd(), name.as_ptr(), 0o755) } != 0 {
            return Err(format!(
                "mkdirat {:?}: {}",
                name,
                std::io::Error::last_os_error()
            ));
        }
        cur = openat_dir(cur.as_raw_fd(), &name)?;
    }
    let payload = [0x61u8; FILE_BYTES];
    for name in names(files) {
        let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC;
        // SAFETY: as above; the new descriptor is owned right away.
        let fd = unsafe { libc::openat(cur.as_raw_fd(), name.as_ptr(), flags, 0o644) };
        if fd < 0 {
            return Err(format!(
                "create {:?}: {}",
                name,
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: fd is open and owned by nobody else.
        let file = unsafe { OwnedFd::from_raw_fd(fd) };
        // SAFETY: payload is a live buffer of FILE_BYTES bytes.
        let n = unsafe { libc::write(file.as_raw_fd(), payload.as_ptr().cast(), FILE_BYTES) };
        if n != FILE_BYTES as isize {
            return Err(format!(
                "write {:?}: {}",
                name,
                std::io::Error::last_os_error()
            ));
        }
    }
    println!("{{\"op\":\"build\",\"kind\":\"{kind}\",\"files\":{files}}}");
    Ok(())
}

fn remove(args: &[String]) -> Result<(), String> {
    let [dir] = args else {
        return Err(USAGE.to_string());
    };
    let start = Instant::now();
    std::fs::remove_dir_all(dir).map_err(|e| format!("remove {dir}: {e}"))?;
    println!("{{\"op\":\"remove\",\"ms\":{:.3}}}", ms(start));
    Ok(())
}

fn move_files(args: &[String]) -> Result<(), String> {
    let [from, to, rest @ ..] = args else {
        return Err(USAGE.to_string());
    };
    let files = files_flag(rest)?;
    let from_fd = open_dir_walk(Path::new(from))?;
    let to_fd = open_dir_walk(Path::new(to))?;
    let list = names(files);
    let start = Instant::now();
    for name in &list {
        // SAFETY: both handles are open; the names are NUL-terminated.
        let rc = unsafe {
            libc::renameat(
                from_fd.as_raw_fd(),
                name.as_ptr(),
                to_fd.as_raw_fd(),
                name.as_ptr(),
            )
        };
        if rc != 0 {
            return Err(format!(
                "renameat {:?}: {}",
                name,
                std::io::Error::last_os_error()
            ));
        }
    }
    println!(
        "{{\"op\":\"move\",\"files\":{files},\"ms\":{:.3}}}",
        ms(start)
    );
    Ok(())
}

fn stat_group(args: &[String]) -> Result<(), String> {
    let [dir, rest @ ..] = args else {
        return Err(USAGE.to_string());
    };
    let files = files_flag(rest)?;
    let dir_fd = open_dir_walk(Path::new(dir))?;
    let list = names(files);
    let start = Instant::now();
    let mut found = 0usize;
    for name in &list {
        // SAFETY: zeroed stat is a valid out-buffer; the handle and name are valid.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::fstatat(
                dir_fd.as_raw_fd(),
                name.as_ptr(),
                &mut st,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if rc == 0 {
            found += 1;
        } else if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
            return Err(format!(
                "fstatat {:?}: {}",
                name,
                std::io::Error::last_os_error()
            ));
        }
    }
    println!(
        "{{\"op\":\"stat\",\"files\":{files},\"found\":{found},\"ms\":{:.3}}}",
        ms(start)
    );
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.split_first() {
        Some((cmd, rest)) if cmd == "build" => build(rest),
        Some((cmd, rest)) if cmd == "remove" => remove(rest),
        Some((cmd, rest)) if cmd == "move" => move_files(rest),
        Some((cmd, rest)) if cmd == "stat" => stat_group(rest),
        Some((flag, _)) if flag == "--help" || flag == "-h" => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("{msg}");
            ExitCode::from(2)
        }
    }
}
