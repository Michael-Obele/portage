#!/usr/bin/env bash
#
# Tests for apull.sh's drive awareness (--drives / --devices).
#
#   ./scripts/test-apull-drives.sh
#
# Needs no phone and no adb: that is the point. Part 1 unit-tests the pure
# filters and the lsblk parser against fixtures; Part 2 proves `--drives` and
# `--devices` still run on a machine with no adb at all, which is the bug the
# change fixed (the adb precondition used to fire before the listing).

set -uo pipefail
cd "$(dirname "$0")/.."
APULL=scripts/apull.sh
pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'ok: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---- Part 0: byte hygiene (the file has been bitten by stray bytes before) ----
if command -v python3 >/dev/null 2>&1; then
  if python3 - "$APULL" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
problems = []
if chr(9) in src:
    problems.append('TAB bytes present')
if chr(13) in src:
    problems.append('CR bytes present')
for i, line in enumerate(src.split(chr(10)), 1):
    if 'sq()' in line:
        continue  # the original quote-escaping idiom legitimately doubles
    if chr(92) + chr(92) in line:
        problems.append('double backslash on line %d' % i)
if problems:
    print('; '.join(problems))
    sys.exit(1)
PYEOF
  then ok 'byte hygiene (no TAB/CR/stray doubles)'
  else bad 'byte hygiene problems (see line above)'
  fi
else
  printf 'skip: python3 missing, byte hygiene unchecked\n'
fi

# ---- Part 1: the pure helpers, extracted the same way the bar test does ----
sed -n '/^is_junk_fs() {/,/^}$/p;/^is_junk_path() {/,/^}$/p;/^parse_lsblk_pairs() {/,/^}$/p' \
  "$APULL" > "$TMP/drives.sh"
# shellcheck disable=SC1090
source "$TMP/drives.sh" || { bad 'extracted drive helpers do not parse'; }

check_pred() { # <label> <expected 0|1> <fn> <arg>
  "$3" "$4"
  local got=$?
  if [[ $got -eq $2 ]]; then ok "$1"; else bad "$1 (want $2, got $got)"; fi
}

# Filesystems that must never be offered as a destination.
for fs in squashfs overlay tmpfs devtmpfs proc sysfs cgroup2 efivarfs; do
  check_pred "junk fs: $fs" 0 is_junk_fs "$fs"
done
# Real filesystems must survive the filter.
for fs in ext4 fuseblk ntfs vfat exfat apfs btrfs xfs; do
  check_pred "real fs kept: $fs" 1 is_junk_fs "$fs"
done
# Mount points nobody archives to.
for mp in /snap/core22/2437 /dev /proc /sys/fs/cgroup /System/Volumes/Data; do
  check_pred "junk path: $mp" 0 is_junk_path "$mp"
done
for mp in / /media/node/2TB /mnt/backup /Volumes/Archive; do
  check_pred "usable path kept: $mp" 1 is_junk_path "$mp"
done

# lsblk -P parsing, including a label with spaces and a stale-key trap: the
# loop device below omits nothing, but the parser must reset per line, so a
# missing LABEL on line 3 must not inherit line 2's.
cat > "$TMP/lsblk.txt" <<'EOF'
NAME="sda" LABEL="" FSTYPE="" MOUNTPOINT="" RM="0" TRAN="usb" TYPE="disk"
NAME="sda1" LABEL="My Old Acer" FSTYPE="ntfs" MOUNTPOINT="/media/node/2TB" RM="0" TRAN="" TYPE="part"
NAME="loop0" LABEL="" FSTYPE="squashfs" MOUNTPOINT="/snap/core22/2437" RM="0" TRAN="" TYPE="loop"
EOF
cat > "$TMP/lsblk.want" <<'EOF'
sda||||0|usb|disk
sda1|My Old Acer|ntfs|/media/node/2TB|0||part
loop0||squashfs|/snap/core22/2437|0||loop
EOF
parse_lsblk_pairs < "$TMP/lsblk.txt" > "$TMP/lsblk.got" 2>&1
if diff -u "$TMP/lsblk.want" "$TMP/lsblk.got" > "$TMP/lsblk.diff"; then
  ok 'parse_lsblk_pairs (spaces in label, per-line reset)'
else
  bad 'parse_lsblk_pairs output differs:'
  sed 's/^/    /' "$TMP/lsblk.diff"
fi

# ---- Part 2: usable with no adb (the regression this change fixes) ----------
# A listing must not depend on a phone being installed. ADB is pointed at a
# path that cannot exist, so any accidental adb call would fail loudly.

set +e
out=$(ADB=/nonexistent/adb "$APULL" --drives 2>"$TMP/err"); rc=$?
set -e
if [[ $rc -eq 0 ]]; then ok '--drives exits 0 with no adb'
else bad "--drives exited $rc with no adb (stderr: $(cat "$TMP/err"))"; fi
if grep -q 'Drives on this computer' <<< "$out"; then ok '--drives prints the drive table'
else bad '--drives did not print the drive table'; fi
if [[ ! -s $TMP/err ]]; then ok '--drives writes nothing to stderr'
else bad "--drives wrote to stderr: $(cat "$TMP/err")"; fi

set +e
out=$(ADB=/nonexistent/adb "$APULL" --devices 2>"$TMP/err"); rc=$?
set -e
if [[ $rc -eq 0 ]]; then ok '--devices exits 0 with no adb'
else bad "--devices exited $rc with no adb (want 0; it used to die 2)"; fi
if grep -q 'Drives on this computer' <<< "$out"; then ok '--devices still lists drives without adb'
else bad '--devices dropped the drive list when adb was missing'; fi
if grep -q 'adb not found' <<< "$out"; then ok '--devices explains the missing adb'
else bad '--devices did not explain the missing adb'; fi

# A real pull still refuses to run without adb — the check moved, it did not go.
set +e
out=$(ADB=/nonexistent/adb "$APULL" --from /sdcard/DCIM --to "$TMP/dest" 2>&1); rc=$?
set -e
if [[ $rc -eq 2 ]]; then ok 'a pull without adb still exits 2'
else bad "a pull without adb exited $rc (want 2)"; fi

# ---- Part 3: the table is honest -------------------------------------------
# This machine's own mounts are used; only the invariants are asserted, so the
# test does not depend on one particular disk layout.
set +e
out=$("$APULL" --drives 2>/dev/null); rc=$?
set -e
if [[ $rc -eq 0 ]]; then ok '--drives exits 0 on this machine'
else bad "--drives exited $rc"; fi
if grep -qE '^  /' <<< "$out"; then ok 'at least one drive row is printed'
else bad 'no drive rows printed'; fi
if grep -qE '/snap/|type-loop|squashfs|tmpfs|overlay' <<< "$out"; then
  bad 'a snap/loop/pseudo filesystem leaked into the table'
else ok 'no snap/loop/pseudo filesystem in the table'
fi
if grep -q -- '--from <path-on-phone> --to "' <<< "$out"; then
  ok 'a ready-to-edit command is printed'
else
  bad 'no example command printed (is there no writable external drive?)'
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]] || exit 1
