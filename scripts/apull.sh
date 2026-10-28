#!/usr/bin/env bash
#
# apull.sh — pull files and folders off an Android device with adb.
#
#     apull.sh --from /sdcard/Movies/Foo --to /media/you/2TB/Videos
#     apull.sh --from /sdcard/Movies/Foo --to-phone /sdcard/Movies --from-device SRC --to-device DST
#     apull.sh --tree /sdcard/Download           # find the path instead of guessing
#     apull.sh --list /sdcard/Download/Move
#     apull.sh --devices                         # what phones AND drives are here
#     apull.sh --drives                          # where can this copy to?
#
# Two modes, both copy-only: the source copy is never touched and nothing is
# deleted. A pull is incremental by default — a file already at the destination
# under the same name *and the same size* is skipped.
#
# Why size is enough to be safe here: adb writes a pulled file sequentially, so
# a transfer that was killed or that failed is always SHORTER than the source.
# Equal size therefore means every byte landed — a half-written file from an
# interrupted run can never masquerade as complete. It is NOT a content check:
# a same-size, different-bytes file is skipped untouched. When bytes must be
# proven, use `portage`, not this — proving bytes is portage's whole job.
#
# Exit codes follow the repo's documented scheme (minus verification, which
# this tool does not do):
#   0  success
#   1  usage error
#   2  precondition failed (no adb, no device, bad destination, bad path)
#   3  transfer error (adb pull itself failed)
#   5  interrupted (Ctrl-C)

set -uo pipefail

VERSION="2.3.0"
PROG="${0##*/}"

# The adb binary; override with ADB=/path/to/adb (as portage does).
ADB="${ADB:-adb}"

FROM=""
TO="."
TO_GIVEN=0
TO_PHONE=""
SERIAL=""       # source device (legacy -s/--device writes here)
DST_SERIAL=""   # destination device for phone-to-phone
PRESERVE=1   # -a: keep timestamps and mode; the archive-friendly default
QUIET=0
DRY_RUN=0
LIST_ONLY=0    # --devices: phones + drives, then exit
DRIVES_ONLY=0  # --drives: drives only, then exit (needs no phone and no adb)
COMPRESS=""  # "" = adb's default, "none" = -Z, anything else = -z <alg>

MODE="pull"        # pull | list | tree
BROWSE_ROOT="/sdcard"
TREE_DEPTH=2
PICK=0
SKIP=1             # incremental: do not re-copy a file whose name and size match

usage() {
  cat <<'EOF'
Usage: $PROG --from <device-path> [--to <local-dir>] [options]
       $PROG --from <device-path> --to-phone <device-path> --from-device <id> --to-device <id>
       $PROG --list [device-path] [--device <id> | --pick]
       $PROG --tree [device-path] [--depth N] [--device <id> | --pick]
       $PROG --devices
       $PROG --drives

Copy a file or folder from an Android device to this computer or an external
drive, using adb. Copy-only: the phone copy is never touched and nothing is
deleted. A pull is incremental by default — a file already present under the
same name *and size* is skipped. That is not a content check; use portage when
bytes must be verified.

Phone-to-phone streams bytes through this host's memory (both phones stay
plugged in here) and never writes a temp copy to the laptop disk. There is no
USB-direct phone-to-phone path in adb, so a host hop is unavoidable — this
mode just keeps it off disk: source `exec-out tar -c` piped into destination
`exec-in tar -x`. Same copy-only, same skip-on-same-size rule.

Finding the path (stop guessing):
  --list [path]         list one level of a device path (default /sdcard):
                        names, sizes, and which entries are folders
  --tree [path]         shallow tree of a device path (default /sdcard)
      --depth N         how deep --tree goes (default 2, capped at 4)
  --devices             list attached phones AND mounted drives, then exit
  --drives              list mounted drives only (needs no phone, no adb)
      --pick            choose a device from a numbered list (reads the terminal)

Choosing a destination (so --to stops being guesswork):
  --drives prints every mounted filesystem with its size, free space,
  filesystem type and whether it is writable, and ends with a ready-to-edit
  command. Snap/loop/pseudo filesystems are dropped, so a drive you could not
  copy to is not offered as if it were one. A drive whose writability could not
  be probed says "unknown" — it is never assumed writable.

Arguments:
  --from <path>         path on the source phone (required for a pull), e.g. /sdcard/Movies/Foo
  --to <path>           destination directory on this computer (default: .). Always
                        treated as a directory, and created if it does not exist, so
                        the pulled item always lands *inside* it — unlike plain
                        adb, which renames a missing destination after the source.
                        Mutually exclusive with --to-phone.
  --to-phone <path>     destination directory on the second phone (phone-to-phone
                        mode). Same directory semantics as --to, but on the
                        destination phone; created with mkdir -p if missing.

Device:
  -s, --device <id>     source device when several are attached (alias for --from-device)
      --from-device <id> source device (phone-to-phone, or an explicit source)
      --to-device <id>   destination device (required with --to-phone)

Transfer:
  -a, --preserve        keep file timestamps and mode (default)
      --no-preserve     do not pass -a; adb decides timestamps
      --overwrite       copy every file, even ones already there (no skipping)
  -z, --compress <alg>  enable compression, e.g. zlib, lz4, brotli, zstd
  -Z, --no-compress     disable compression for this transfer
  -q, --quiet           suppress progress and the summary line

Other:
      --dry-run         run every check, print what would happen, copy nothing
  -h, --help            show this help and exit
  -V, --version         show version and exit

Exit codes: 0 success, 1 usage, 2 precondition, 3 transfer, 5 interrupted.

Examples:
  $PROG --drives                                # which drive can I copy to?
  $PROG --devices                               # phones + drives in one list
  $PROG --tree /sdcard/Download                 # see what is there before pulling
  $PROG --from /sdcard/Movies/Frieren --to /media/you/2TB/Videos
  $PROG --from /sdcard/Download --to /mnt/backup --device 0a388e93 --quiet
  $PROG --from '/sdcard/Download/Move/Platinum End' --to-phone /sdcard/Download/Move/Platinum --from-device 57041FDCQ006HS --to-device ab6d2637
  $PROG --from /sdcard/DCIM --to-phone /sdcard/DCIM --from-device SRC --to-device DST --dry-run
  ADB=~/android/platform-tools/adb $PROG --list /sdcard
EOF
}

die() {
  local code=$1
  shift
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit "$code"
}

require_value() { # <flag> <remaining-argc>
  [[ $# -ge 2 && -n ${2:-} ]] || die 1 "$1 requires a value (see --help)"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --from)         require_value "$1" "$@"; FROM=$2; shift 2 ;;
    --from=*)       FROM=${1#*=}; shift ;;
    --to)           require_value "$1" "$@"; TO=$2; TO_GIVEN=1; shift 2 ;;
    --to=*)         TO=${1#*=}; TO_GIVEN=1; shift ;;
    --to-phone)     require_value "$1" "$@"; TO_PHONE=$2; shift 2 ;;
    --to-phone=*)   TO_PHONE=${1#*=}; shift ;;
    --from-device)  require_value "$1" "$@"; SERIAL=$2; shift 2 ;;
    --from-device=*) SERIAL=${1#*=}; shift ;;
    --to-device)    require_value "$1" "$@"; DST_SERIAL=$2; shift 2 ;;
    --to-device=*)  DST_SERIAL=${1#*=}; shift ;;
    -s|--device)    require_value "$1" "$@"; SERIAL=$2; shift 2 ;;
    --device=*)     SERIAL=${1#*=}; shift ;;
    --list)         MODE=list; shift
                    if [[ $# -gt 0 && -n ${1:-} && ${1:0:1} != - ]]; then BROWSE_ROOT=$1; shift; fi ;;
    --list=*)       MODE=list; BROWSE_ROOT=${1#*=}; shift ;;
    --tree)         MODE=tree; shift
                    if [[ $# -gt 0 && -n ${1:-} && ${1:0:1} != - ]]; then BROWSE_ROOT=$1; shift; fi ;;
    --tree=*)       MODE=tree; BROWSE_ROOT=${1#*=}; shift ;;
    --depth)        require_value "$1" "$@"; TREE_DEPTH=$2; shift 2 ;;
    --depth=*)      TREE_DEPTH=${1#*=}; shift ;;
    --pick)         PICK=1; shift ;;
    -a|--preserve)  PRESERVE=1; shift ;;
    --no-preserve)  PRESERVE=0; shift ;;
    --overwrite)    SKIP=0; shift ;;
    -z|--compress)  require_value "$1" "$@"; COMPRESS=$2; shift 2 ;;
    --compress=*)   COMPRESS=${1#*=}; shift ;;
    -Z|--no-compress) COMPRESS=none; shift ;;
    -q|--quiet)     QUIET=1; shift ;;
    --devices)      LIST_ONLY=1; shift ;;
    --drives)       DRIVES_ONLY=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    -V|--version)   printf '%s %s\n' "$PROG" "$VERSION"; exit 0 ;;
    --)             shift; [[ $# -eq 0 ]] || die 1 "unexpected argument after --: $1"; break ;;
    -*)             die 1 "unknown option: $1 (see --help)" ;;
    *)              die 1 "unexpected argument: $1 — this tool is flag-based: use --from/--to (see --help)" ;;
  esac
done

trap 'printf "\n%s: interrupted\n" "$PROG" >&2; exit 5' INT TERM
trap 'bar_restore' EXIT

# ---- helpers ---------------------------------------------------------------

# Single-quote a path for the device's shell (spaces, brackets, quotes and all).
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Run a shell command on a device (no -s passthrough kept for single-device use).
dsh_on() { # <serial> <command>
  if [[ -n $1 ]]; then "$ADB" -s "$1" shell "$2" </dev/null
  else "$ADB" shell "$2" </dev/null; fi
}

# Run a shell command on the source device.
dsh() {
  dsh_on "$SERIAL" "$1"
}

# Run a shell command on the destination phone (phone-to-phone mode).
dsh_dst() {
  dsh_on "$DST_SERIAL" "$1"
}

# dir | file | none, for a path as the device sees it.
browse_kind_on() { # <serial> <path>
  local s=$1 p=$2 q; q=$(sq "$p")
  dsh_on "$s" "if [ -d $q ]; then echo dir; elif [ -e $q ]; then echo file; else echo none; fi" \
    | tr -d '\r'
}

browse_kind() {
  browse_kind_on "$SERIAL" "$1"
}

# Bytes of one remote file on a given device (blank when it cannot be read).
remote_size_on() { # <serial> <path>
  dsh_on "$1" "stat -c '%s' $(sq "$2")" 2>/dev/null | tr -d '\r' \
    | awk 'NR == 1 { print; exit }'
}

remote_size() {
  remote_size_on "$SERIAL" "$1"
}

# Stream one file-or-tree phone -> phone with no laptop-disk copy.
# Bytes flow source `exec-out tar -c` -> host RAM -> dest `exec-in tar -x`.
# Args: <src-full-path> <dst-parent-dir-on-dest-phone>.
phone_stream() {
  local src_full=$1 dparent=$2
  local sparent=${src_full%/*} sbase=${src_full##*/}
  [[ -n $sparent && -n $sbase ]] || die 1 "bad phone-to-phone path: $src_full"
  local xflag=""; [[ $PRESERVE -eq 0 ]] && xflag=" -m"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'dry-run:'
    printf ' %q' "$ADB" -s "$SERIAL" exec-out "tar -c -C $(sq "$sparent") $(sq "$sbase")"
    printf ' |'
    printf ' %q' "$ADB" -s "$DST_SERIAL" exec-in "tar -x$xflag -C $(sq "$dparent")"
    printf '\n'
    return 0
  fi
  "$ADB" -s "$SERIAL" exec-out "tar -c -C $(sq "$sparent") $(sq "$sbase") 2>/dev/null" 2>/dev/null \
    | "$ADB" -s "$DST_SERIAL" exec-in "tar -x$xflag -C $(sq "$dparent")"
  return $?
}

# Live progress: a single updating line on a terminal, plain lines otherwise ----
# (so pipes and logs stay clean). --quiet disables everything but errors.
tty_out() { [[ -t 1 && $QUIET -eq 0 && ${TERM:-} != dumb ]]; }

bar_rate() { # <start_seconds> <done_bytes> -> e.g. "12.3 MB/s"
  local el=$(( SECONDS - $1 )); (( el < 1 )) && el=1
  printf '%s/s' "$(human $(( $2 / el )))"
}

bar_eta() { # <start_seconds> <done_bytes> <total_bytes> -> mm:ss
  local el=$(( SECONDS - $1 )); (( el < 1 )) && el=1
  (( el < 2 )) && { printf -- '--:--'; return; }
  local rate=$(( $2 / el ))
  (( rate > 0 )) || { printf -- '--:--'; return; }
  local left=$(( ($3 - $2) / rate )); (( left < 0 )) && left=0
  (( left > 5999 )) && { printf -- '--:--'; return; }
  printf '%02d:%02d' $(( left / 60 )) $(( left % 60 ))
}

bar_begin() { # once per transfer: fix width, hide cursor (trap/bar_end restores)
  BAR_COLS=${COLUMNS:-}
  [[ $BAR_COLS =~ ^[0-9]+$ ]] || BAR_COLS=$(tput cols 2>/dev/null || printf '80')
  (( BAR_COLS >= 20 )) || BAR_COLS=20
  if [[ ${BAR_HIDDEN:-0} -eq 0 ]]; then
    printf '[?25l'; BAR_HIDDEN=1
  fi
}

bar_restore() { # show cursor again; safe anywhere, also runs from EXIT trap
  if [[ ${BAR_HIDDEN:-0} -eq 1 ]]; then
    printf '[?25h' 2>/dev/null
    BAR_HIDDEN=0
  fi
}

bar_end() { # finish a transfer line: newline first, then cursor back
  printf '\n'
  bar_restore
}

bar_draw() { # <done> <total> <rate> <eta> <label> -- one line, fits $BAR_COLS
  local done=$1 total=$2 rate=$3 eta=$4 label=$5 pct=0
  [[ $done =~ ^[0-9]+$ ]] || done=0
  [[ $total =~ ^[0-9]+$ && $total -gt 0 ]] || total=0
  (( total > 0 )) && pct=$(( done * 100 / total ))
  (( pct > 100 )) && pct=100
  local cols=${BAR_COLS:-80} bar_w=24 use_eta=1 use_rate=1
  local sizes head try_rate try_eta label_budget clean bar filled
  [[ $cols =~ ^[0-9]+$ ]] || cols=80
  sizes=$(human "$done")/$(human "$total")
  while :; do
    try_rate=''; (( use_rate )) && try_rate=" $rate"
    try_eta=''; (( use_eta )) && try_eta=" ETA $eta"
    printf -v bar '%*s' "$bar_w" ''
    if (( bar_w > 0 )); then
      printf -v head '%s: [%s] %3d%% %s' "$PROG" "$bar" "$pct" "$sizes"
    else
      printf -v head '%s: %3d%% %s' "$PROG" "$pct" "$sizes"
    fi
    label_budget=$(( cols - ${#head} - ${#try_rate} - ${#try_eta} - 2 ))
    (( label_budget >= 12 )) && break
    if (( bar_w > 0 )); then bar_w=$(( bar_w - 8 )); (( bar_w < 0 )) && bar_w=0
    elif (( use_eta )); then use_eta=0
    elif (( use_rate )); then use_rate=0
    else break; fi
  done
  (( label_budget < 0 )) && label_budget=0
  clean=${label//[[:cntrl:]]/ }
  if [[ $clean =~ [^[:ascii:]] ]]; then label_budget=$(( label_budget / 2 )); fi
  (( label_budget > 0 )) && clean=${clean:0:label_budget}
  filled=$(( pct * bar_w / 100 ))
  (( filled > bar_w )) && filled=bar_w
  (( filled < 0 )) && filled=0
  printf -v bar '%*s' "$filled" ''; bar=${bar// /#}
  printf -v bar '%-*s' "$bar_w" "$bar"
  if (( bar_w > 0 && filled < bar_w )); then bar=${bar:0:filled}'>'${bar:$((filled+1))}; fi
  if (( bar_w > 0 )); then
    printf -v head '%s: [%s] %3d%% %s' "$PROG" "$bar" "$pct" "$sizes"
  else
    printf -v head '%s: %3d%% %s' "$PROG" "$pct" "$sizes"
  fi
  frame="$head$try_rate$try_eta  $clean"
  (( ${#frame} > cols )) && frame=${frame:0:cols}
  printf '\r[K%s' "$frame"
}

# Bytes already landed on the destination phone (0 when unknown).
probe_size() { # <probe_path> <is_dir:0|1>
  local out
  if (( $2 )); then
    out=$(dsh_dst "du -sb $(sq "$1") 2>/dev/null" 2>/dev/null | tr -d '\r' | awk 'NR==1{print $1; exit}')
  else
    out=$(remote_size_on "$DST_SERIAL" "$1")
  fi
  [[ $out =~ ^[0-9]+$ ]] && printf '%s' "$out" || printf '0'
}

# Stream one pipe with a live bar on a terminal, plain lines otherwise.
# Args: <label> <src_full> <dst_parent> <total_bytes> <probe_path> <probe_is_dir>
phone_stream_bar() {
  local label=$1 src_full=$2 dparent=$3 total=$4 probe=$5 probedir=$6
  if [[ $DRY_RUN -eq 1 ]]; then phone_stream "$src_full" "$dparent"; return 0; fi
  if ! tty_out || ! [[ $total =~ ^[0-9]+$ ]] || (( total <= 0 )); then
    [[ $QUIET -eq 0 ]] && printf '%s: streaming %s ...\n' "$PROG" "$label"
    phone_stream "$src_full" "$dparent"; return $?
  fi
  bar_begin
  phone_stream "$src_full" "$dparent" &
  local ppid=$! start=$SECONDS done_now=0 st
  while kill -0 $ppid 2>/dev/null; do
    sleep 0.5
    done_now=$(probe_size "$probe" "$probedir")
    bar_draw "$done_now" "$total" "$(bar_rate "$start" "$done_now")" \
      "$(bar_eta "$start" "$done_now" "$total")" "$label"
  done
  wait $ppid; st=$?
  done_now=$(probe_size "$probe" "$probedir")
  bar_draw "$done_now" "$total" "$(bar_rate "$start" "$done_now")" \
    "$(bar_eta "$start" "$done_now" "$total")" "$label"
  bar_end
  return $st
}

# Human-readable byte count.
human() {
  awk -v b="$1" 'BEGIN{ split("B KB MB GB TB", u, " "); i = 1;
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    printf (i == 1 ? "%.0f %s" : "%.1f %s"), b, u[i] }'
}

# ---- drives (read-only: nothing is mounted, written or unmounted) ----------

# Filesystems that are never a copy destination. Mirrors JUNK_FILESYSTEMS in
# src/device/volumes.ts so `apull --drives` and `portage drives` agree on what
# counts as a real drive. Deliberately duplicated: apull installs by copying one
# file onto PATH, so it cannot import the TypeScript.
is_junk_fs() {
  case $1 in
    squashfs|overlay|tmpfs|devtmpfs|proc|sysfs|cgroup|cgroup2|autofs) return 0 ;;
    ramfs|debugfs|tracefs|securityfs|configfs|fusectl|mqueue|hugetlbfs) return 0 ;;
    pstore|bpf|binfmt_misc|nsfs|efivarfs|devfs|fdescfs) return 0 ;;
  esac
  return 1
}

# Mount points nobody archives to: snap/container mounts, kernel interfaces, and
# the macOS system volumes that just mirror `/`.
is_junk_path() {
  case $1 in
    /snap/*|/var/snap/*|/run/snapd/*) return 0 ;;
    /dev|/dev/*|/proc|/proc/*|/sys|/sys/*) return 0 ;;
    /System/Volumes/*|/private/var/vm) return 0 ;;
  esac
  return 1
}

# `lsblk -P` output -> `name|label|fstype|mountpoint|rm|tran|type`, one line per
# block device. portage uses `--json` because it is TypeScript; this is bash, so
# -P is the right form: one KEY="value" pair per field on a single line, which
# awk can read with no JSON parser and no reliance on field positions (a label
# may contain spaces).
parse_lsblk_pairs() {
  awk '
    {
      N = ""; L = ""; T = ""; M = ""; R = ""; TR = ""; TY = ""
      line = $0
      while (match(line, /[A-Z]+="[^"]*"/)) {
        tok = substr(line, RSTART, RLENGTH)
        eq = index(tok, "=")
        k = substr(tok, 1, eq - 1)
        v = substr(tok, eq + 2, length(tok) - eq - 2)
        if (k == "NAME") N = v
        else if (k == "LABEL") L = v
        else if (k == "FSTYPE") T = v
        else if (k == "MOUNTPOINT") M = v
        else if (k == "RM") R = v
        else if (k == "TRAN") TR = v
        else if (k == "TYPE") TY = v
        line = substr(line, RSTART + RLENGTH)
      }
      printf "%s|%s|%s|%s|%s|%s|%s\n", N, L, T, M, R, TR, TY
    }'
}

# writable | read-only | unknown, for a mount point. "unknown" is deliberate: a
# probe that failed must never be rendered as writable. A read-only NTFS mount
# offered as a copy target is the classic failure this exists to catch — the
# same rule as Volume.readOnly in src/device/volumes.ts.
mount_access() {
  local opts
  command -v findmnt >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  opts=$(findmnt -no OPTIONS --target "$1" 2>/dev/null) || { printf 'unknown'; return 0; }
  [[ -n $opts ]] || { printf 'unknown'; return 0; }
  # Match whole comma-separated options, so `errors=remount-ro` is not read as ro.
  case ",$opts," in
    *,ro,*) printf 'read-only' ;;
    *,rw,*) printf 'writable' ;;
    *)      printf 'unknown' ;;
  esac
}

# One line per real mounted volume, then a ready-to-paste example command.
print_drives() {
  local records rows="" count=0 maxw=24 example="" ro_count=0 hint=0
  local name label fs mp rm tran typ total avail access kind notes descr tsize fsize
  local disk_rm="" disk_tran=""

  if command -v lsblk >/dev/null 2>&1; then
    records=$(lsblk -P -o NAME,LABEL,FSTYPE,MOUNTPOINT,RM,TRAN,TYPE 2>/dev/null \
      | parse_lsblk_pairs)
  else
    # No lsblk (macOS, minimal systems): df knows the mount table but nothing
    # about transport or removability, so those columns read "-" and the kind is
    # left unknown rather than guessed.
    records=$(df -PkT 2>/dev/null | awk 'NR > 1 {
      mp = $7
      for (i = 8; i <= NF; i++) mp = mp " " $i
      printf "%s||%s|%s||-|-\n", $1, $2, mp
    }')
    hint=1
  fi

  while IFS='|' read -r name label fs mp rm tran typ; do
    # A disk row carries RM and TRAN; its partitions usually carry neither, so
    # remember the disk and let a silent partition inherit from it. Without this
    # a USB drive's /dev/sda1 looks internal and never becomes the example.
    if [[ $typ == disk ]]; then
      disk_rm=$rm
      disk_tran=$tran
    fi
    [[ -n $rm ]] || rm=$disk_rm
    [[ -n $tran ]] || tran=$disk_tran

    [[ -n $mp ]] || continue
    [[ $typ != loop && $name != loop* ]] || continue
    is_junk_fs "$fs" && continue
    is_junk_path "$mp" && continue

    # Free space comes from df, not lsblk: lsblk knows the partition size, df
    # knows what is actually left, and that is the number people need. A failed
    # probe stays -1 so it prints as "?"; unknown must never render as "0 B",
    # the same rule Volume.readOnly/diskSpace follow in src/device/.
    read -r total avail <<< "$(df -Pk "$mp" 2>/dev/null | awk 'NR == 2 { print $2, $4 }')"
    case ${total:-} in ''|*[!0-9]*) total=-1 ;; esac
    case ${avail:-} in ''|*[!0-9]*) avail=-1 ;; esac

    access=$(mount_access "$mp")

    case $tran in
      usb)                kind="external (usb)" ;;
      nvme|sata|ata|scsi) kind="internal ($tran)" ;;
      -|"")
        if [[ $rm == 1 ]]; then
          kind="external"
        else
          # No transport reported: fall back to where the system conventionally
          # mounts removable media. Labelled as a path guess, never as fact.
          case $mp in
            /Volumes/*|/media/*|/mnt/*|/run/media/*) kind="external (path)" ;;
            *) kind="-" ;;
          esac
        fi ;;
      *)                  kind="internal ($tran)" ;;
    esac

    notes=""
    [[ -n $label ]] && notes="label \"$label\""
    [[ -d $mp/.portage ]] && notes="${notes:+$notes · }portage drive"
    if [[ $access == read-only ]]; then
      notes="${notes:+$notes · }cannot be a --to"
      ro_count=$((ro_count + 1))
    fi

    [[ ${#mp} -gt $maxw ]] && maxw=${#mp}
    descr=$kind
    [[ -n $notes ]] && descr="${kind} · ${notes}"
    rows="${rows}${mp}|${total}|${avail}|${fs}|${access}|${descr}"$'\n'
    count=$((count + 1))
    # The first writable external drive becomes the worked example.
    if [[ -z $example && $access == writable ]]; then
      case $kind in external*) example=$mp ;; esac
    fi
  done <<< "$records"

  if [[ $count -eq 0 ]]; then
    printf 'Drives on this computer: none found.\n'
    printf '  no mounted filesystem looked like a real drive — check with: df -hT\n'
    return 0
  fi

  printf 'Drives on this computer — pass the PATH as --to:\n\n'
  printf '  %-*s  %-8s  %-8s  %-9s  %-11s  %s\n' \
    "$maxw" "PATH" "SIZE" "FREE" "FS" "ACCESS" "KIND"
  while IFS='|' read -r mp total avail fs access descr; do
    [[ -n $mp ]] || continue
    if [[ $total == -1 ]]; then tsize="?"; else tsize=$(human $((total * 1024))); fi
    if [[ $avail == -1 ]]; then fsize="?"; else fsize=$(human $((avail * 1024))); fi
    printf '  %-*s  %-8s  %-8s  %-9s  %-11s  %s\n' \
      "$maxw" "$mp" "$tsize" "$fsize" \
      "${fs:--}" "$access" "$descr"
  done <<< "$rows"

  printf '\n'
  if [[ -n $example ]]; then
    printf '  copy to that drive with:\n'
    printf '    %s --from <path-on-phone> --to "%s"\n' "$PROG" "$example"
  else
    printf '  no writable external drive found — plug one in, or use --to with a path you know\n'
  fi
  if [[ $ro_count -gt 0 ]]; then
    printf '  ! %d drive(s) above are read-only — copying to them will fail\n' "$ro_count"
  fi
  if [[ $hint -eq 1 ]]; then
    printf '  (lsblk is unavailable: bus and removability are inferred from the mount path)\n'
  fi
}

# Attached phones, one readable line each: serial, state, model.
print_phones() {
  local raw
  printf 'Phones attached (adb)\n'
  if ! command -v "$ADB" >/dev/null 2>&1; then
    printf '  adb not found — install the Android platform-tools, or set ADB=/path/to/adb\n'
    printf '  (drives are still listed below)\n'
    return 0
  fi
  raw=$("$ADB" devices -l 2>/dev/null | sed -n '2,$p' | sed '/^[[:space:]]*$/d')
  if [[ -z $raw ]]; then
    printf '  none — plug the phone in, enable USB debugging, accept the RSA prompt\n'
    return 0
  fi
  printf '%s\n' "$raw" | awk '{
    model = ""; usb = ""
    for (i = 3; i <= NF; i++) {
      if ($i ~ /^model:/) model = substr($i, 7)
      if ($i ~ /^usb:/)   usb   = substr($i, 5)
    }
    gsub(/_/, " ", model)
    printf "  %-20s %-10s %s%s\n", $1, $2,
      (model != "" ? model : "-"),
      (usb   != "" ? "  (usb " usb ")" : "")
  }'
  if grep -q 'unauthorized' <<< "$raw"; then
    printf '  ! a phone is unauthorized — unlock it and accept the USB debugging prompt\n'
  fi
}

# ---- preconditions (exit 2) ------------------------------------------------

# Listings come first, and before the adb check: a drive is not an Android
# device, so `--drives` must work on a machine with no phone and no adb, and
# `--devices` must still show the drives when adb is missing.
if [[ $DRIVES_ONLY -eq 1 ]]; then
  print_drives
  exit 0
fi

if [[ $LIST_ONLY -eq 1 ]]; then
  print_phones
  printf '\n'
  print_drives
  exit 0
fi

command -v "$ADB" >/dev/null 2>&1 \
  || die 2 "adb not found on PATH — install the Android platform-tools, or set ADB=/path/to/adb"

devices_raw="$("$ADB" devices -l)"
attached="$(awk 'NR > 1 && $2 == "device" { print $1 }' <<< "$devices_raw")"
count=0
while IFS= read -r line; do
  [[ -n $line ]] && count=$((count + 1))
done <<< "$attached"

no_device() {
  if grep -q 'unauthorized' <<< "$devices_raw"; then
    die 2 "a device is attached but unauthorized — unlock the phone and accept the USB debugging (RSA) prompt, then retry"
  fi
  die 2 "no device attached — plug the phone in, enable USB debugging, then check '$ADB devices'"
}

is_attached() { # <serial>
  grep -qx "$1" <<< "$attached"
}

PHONE_MODE=0
[[ -n $TO_PHONE ]] && PHONE_MODE=1

if [[ $PHONE_MODE -eq 1 ]]; then
  [[ $PICK -eq 0 ]] || die 1 "--pick selects one device; phone-to-phone needs explicit --from-device and --to-device"
  [[ $LIST_ONLY -eq 0 ]] || die 1 "--devices lists devices; it does not combine with --to-phone"
  [[ $TO_GIVEN -eq 0 ]] || die 1 "--to (this computer) and --to-phone (second phone) are mutually exclusive"
  [[ -n $FROM ]] || die 1 "--from is required with --to-phone (see --help)"
  [[ $FROM != / ]] || die 1 "--from / is refused in phone-to-phone mode (too broad for a tar stream)"
  [[ $TO_PHONE != / ]] || die 1 "--to-phone / is refused (too broad for a tar stream)"
  [[ $count -gt 0 ]] || no_device
  [[ -n $SERIAL ]] || die 2 "phone-to-phone needs --from-device <id> (run '$PROG --devices' to see ids)"
  [[ -n $DST_SERIAL ]] || die 2 "phone-to-phone needs --to-device <id> (run '$PROG --devices' to see ids)"
  is_attached "$SERIAL" \
    || die 2 "source device '$SERIAL' is not attached and authorized. adb says:
$devices_raw"
  is_attached "$DST_SERIAL" \
    || die 2 "destination device '$DST_SERIAL' is not attached and authorized. adb says:
$devices_raw"
  if [[ $PICK -eq 0 && $MODE != pull ]]; then
    : # --list/--tree with --to-phone is handled below
  fi
elif [[ $PICK -eq 1 ]]; then
  [[ $count -gt 0 ]] || no_device
  if [[ $count -eq 1 ]]; then
    SERIAL="$(printf '%s\n' "$attached" | awk 'NR == 1 { print; exit }')"
  else
    devs=()
    while IFS= read -r line; do
      [[ -n $line ]] && devs+=("$line")
    done < <(printf '%s\n' "$devices_raw" | awk 'NR > 1 && $2 == "device"')
    printf '%s: attached devices:\n' "$PROG" >&2
    i=1
    for line in "${devs[@]}"; do
      printf '  %d) %s\n' "$i" "$line" >&2
      i=$((i + 1))
    done
    printf 'select [1-%d]: ' "${#devs[@]}" >&2
    read -r choice || choice=""
    if [[ ! ${choice:-} =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#devs[@]} )); then
      die 1 "invalid device selection: '${choice:-}' (expected 1-${#devs[@]})"
    fi
    SERIAL="$(awk '{ print $1 }' <<< "${devs[$((choice - 1))]}")"
  fi
elif [[ -n $SERIAL ]]; then
  grep -qx "$SERIAL" <<< "$attached" \
    || die 2 "device '$SERIAL' is not attached and authorized. adb says:
$devices_raw"
elif [[ $count -eq 0 ]]; then
  no_device
elif [[ $count -gt 1 ]]; then
  { printf '%s: several devices attached — choose one with --device <id>, or use --pick:\n' "$PROG"
    printf '  %s\n' $attached
  } >&2
  exit 2
fi

# ---- browse: --list / --tree (read-only, exit 0) ---------------------------

# In browse mode there is no source/dest split: --to-device is accepted as a
# convenience alias so `--tree PATH --to-device X` browses X.
if [[ $MODE != pull && -n $DST_SERIAL && -z $SERIAL ]]; then
  SERIAL="$DST_SERIAL"
elif [[ $MODE != pull && -n $DST_SERIAL && -n $SERIAL ]]; then
  die 1 "--from-device and --to-device are both set; browse with one --device <id> (see --help)"
fi

browse_list() {
  local root=$1 q
  q=$(sq "$root")
  printf '%s\n' "$root"
  # -H: /sdcard is a symlink to /storage/self/primary; without it find lists
  # only the link itself and --tree/--list show a lone `/sdcard` line.
  dsh "find -H $q -maxdepth 1 -mindepth 1 -type d -printf '%f\n'" 2>/dev/null \
    | tr -d '\r' | LC_ALL=C sort \
    | while IFS= read -r n; do [[ -n $n ]] && printf '  %s/\n' "$n"; done
  dsh "find -H $q -maxdepth 1 -mindepth 1 -type f -printf '%s\t%f\n'" 2>/dev/null \
    | tr -d '\r' | LC_ALL=C sort -t"$(printf '\t')" -k2 \
    | while IFS="$(printf '\t')" read -r s n; do
        [[ -n ${n:-} ]] && printf '  %-56s %s\n' "$n" "$(human "${s:-0}")"
      done
  printf 'copy a full path into --from, e.g. --from %s/<name>\n' "$root"
}

browse_tree() {
  local root=$1 depth=$2 q
  q=$(sq "$root")
  # -H: see browse_list; without it a /sdcard root never descends.
  dsh "find -H $q -maxdepth $depth \( -type d -printf '%p/\n' -o -printf '%p\n' \)" 2>/dev/null \
    | tr -d '\r' | LC_ALL=C sort \
    | awk -v root="$root" '
        { p = $0
          isdir = (substr(p, length(p), 1) == "/")
          if (isdir) p = substr(p, 1, length(p) - 1)
          if (p == root) { print root (isdir ? "/" : ""); next }
          rel = p
          if (index(p, root "/") == 1) rel = substr(p, length(root) + 2)
          n = split(rel, seg, "/")
          ind = ""
          for (i = 1; i < n; i++) ind = ind "  "
          print ind seg[n] (isdir ? "/" : "")
        }'
  printf 'copy a full path into --from, e.g. --from %s/<name>\n' "$root"
}

case $MODE in
  list)
    [[ "$(browse_kind "$BROWSE_ROOT")" == none ]] \
      && die 2 "no such path on the device: $BROWSE_ROOT (try: $PROG --list /sdcard)"
    browse_list "$BROWSE_ROOT"
    exit 0 ;;
  tree)
    [[ "$(browse_kind "$BROWSE_ROOT")" == none ]] \
      && die 2 "no such path on the device: $BROWSE_ROOT (try: $PROG --tree /sdcard)"
    (( TREE_DEPTH < 1 )) && TREE_DEPTH=1
    (( TREE_DEPTH > 4 )) && TREE_DEPTH=4
    browse_tree "$BROWSE_ROOT" "$TREE_DEPTH"
    exit 0 ;;
esac

# ---- phone-to-phone (streamed, no laptop copy) -------------------------------

if [[ $PHONE_MODE -eq 1 ]]; then
  [[ $FROM != / ]] && while [[ $FROM == */ ]]; do FROM=${FROM%/}; done
  [[ $TO_PHONE != / ]] && while [[ $TO_PHONE == */ ]]; do TO_PHONE=${TO_PHONE%/}; done
  [[ -z $COMPRESS || $QUIET -eq 1 ]] \
    || printf '%s: note: --compress is ignored in phone-to-phone mode (uncompressed tar stream)\n' "$PROG" >&2

  from_kind="$(browse_kind_on "$SERIAL" "$FROM")"
  [[ $from_kind == none ]] \
    && die 2 "no such path on source $SERIAL: $FROM (use '$PROG --tree /sdcard --from-device $SERIAL' to find the real path)"

  if [[ $DRY_RUN -eq 0 ]]; then
    dsh_dst "mkdir -p $(sq "$TO_PHONE")" >/dev/null 2>&1 \
      || die 2 "cannot create destination dir on $DST_SERIAL: $TO_PHONE"
    [[ "$(browse_kind_on "$DST_SERIAL" "$TO_PHONE")" == dir ]] \
      || die 2 "destination is not a directory on $DST_SERIAL: $TO_PHONE"
    dsh_dst "touch $(sq "$TO_PHONE/.apull-write-test") && rm -f $(sq "$TO_PHONE/.apull-write-test")" >/dev/null 2>&1 \
      || die 2 "--to-phone is not writable on $DST_SERIAL: $TO_PHONE"
  fi

  base="${FROM##*/}"
  dstbase="$TO_PHONE/$base"

  # --- single file: stream it into the destination directory ---
  if [[ $from_kind == file ]]; then
    if [[ $SKIP -eq 1 ]]; then
      rsize="$(remote_size_on "$SERIAL" "$FROM")"
      dsize="$(remote_size_on "$DST_SERIAL" "$dstbase")"
      if [[ -n $rsize && -n $dsize && $dsize -eq $rsize ]]; then
        [[ $QUIET -eq 0 ]] && printf '%s: have %s (%s bytes) — skipped\n' "$PROG" "$base" "$rsize"
        exit 0
      fi
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
      rsize="$(remote_size_on "$SERIAL" "$FROM")"
      printf 'dry-run: would stream %s (%s bytes) %s -> %s (phone-to-phone, no laptop copy)\n' \
        "$FROM" "${rsize:-?}" "$SERIAL" "$dstbase on $DST_SERIAL"
      phone_stream "$FROM" "$TO_PHONE"
      exit 0
    fi
    rsize="$(remote_size_on "$SERIAL" "$FROM")"
    phone_stream_bar "$base" "$FROM" "$TO_PHONE" "${rsize:-0}" "$dstbase" 0; st=$?
    [[ $st -eq 0 ]] || die 3 "phone-to-phone stream failed (exit $st) — source untouched; re-run to retry"
    rsize="$(remote_size_on "$SERIAL" "$FROM")"
    dsize="$(remote_size_on "$DST_SERIAL" "$dstbase")"
    [[ -n $rsize && -n $dsize && $dsize -eq $rsize ]] \
      || die 3 "phone-to-phone size mismatch after '$base' (src=${rsize:-?} dst=${dsize:-?}) — re-run to retry"
    [[ $QUIET -eq 0 ]] && printf '%s: streamed %s (%s) -> %s (%s), no laptop copy\n' \
      "$PROG" "$FROM" "$SERIAL" "$dstbase" "$DST_SERIAL"
    exit 0
  fi

  # --- directory ---
  dst_is_dir=""; [[ $DRY_RUN -eq 0 ]] && dst_is_dir="$(browse_kind_on "$DST_SERIAL" "$dstbase")"
  if [[ $SKIP -eq 0 || ( $DRY_RUN -eq 0 && $dst_is_dir != dir ) ]]; then
    # Fast path: one tar stream for the whole tree. A sizes-only walk up front
    # gives the bar its total (skipped when there is no terminal to draw on).
    tree_total=0
    if tty_out; then
      tree_total=$(dsh "find -H $(sq "$FROM") -type f -printf '%s\n'" 2>/dev/null | tr -d '\r' \
        | awk '{s+=$1} END{print s+0}')
      [[ $tree_total =~ ^[0-9]+$ ]] || tree_total=0
    fi
    phone_stream_bar "$base" "$FROM" "$TO_PHONE" "$tree_total" "$dstbase" 1; st=$?
    [[ $st -eq 0 ]] || die 3 "phone-to-phone stream failed (exit $st) — source untouched; re-run to retry"
    [[ $QUIET -eq 0 && $DRY_RUN -eq 0 ]] && printf '%s: streamed %s (%s) -> %s (%s), no laptop copy\n' \
      "$PROG" "$FROM" "$SERIAL" "$dstbase" "$DST_SERIAL"
    exit 0
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    # Dry-run still walks the source so the preview is exact; nothing is written.
    phone_would=0; phone_would_bytes=0
    while IFS="$(printf '\t')" read -r rsize rpath; do
      [[ -n ${rpath:-} ]] || continue
      rel=${rpath#"$FROM"/}
      dsize="$(remote_size_on "$DST_SERIAL" "$dstbase/$rel")"
      if [[ -n $rsize && -n $dsize && $dsize -eq $rsize ]]; then continue; fi
      phone_would=$((phone_would + 1)); phone_would_bytes=$((phone_would_bytes + ${rsize:-0}))
      printf 'dry-run: would stream %s (%s bytes)\n' "$rel" "$rsize"
    done < <(dsh "find -H $(sq "$FROM") -type f -printf '%s\t%p\n'" 2>/dev/null | tr -d '\r')
    printf 'dry-run: %d file(s) (%s bytes) %s -> %s (phone-to-phone, no laptop copy)\n' \
      "$phone_would" "$phone_would_bytes" "$FROM" "$dstbase"
    exit 0
  fi

  # Incremental path: mirror the skeleton, then stream only missing/changed files.
  qfrom="$(sq "$FROM")"
  dsh "find -H $qfrom -type d -printf '%p\n'" 2>/dev/null | tr -d '\r' \
    | while IFS= read -r dpath; do
        [[ -n $dpath ]] || continue
        rel=${dpath#"$FROM"}; rel=${rel#/}
        [[ -n $rel ]] && dsh_dst "mkdir -p $(sq "$dstbase/$rel")" >/dev/null 2>&1
      done

  # Buffer the walk so totals (and [i/N]) are exact before anything streams.
  phonewalk="$(dsh "find -H $qfrom -type f -printf '%s\t%p\n'" 2>/dev/null | tr -d '\r')"
  grand=0; total_n=0
  while IFS= read -r wline; do
    [[ -n $wline ]] || continue
    total_n=$((total_n + 1))
    wsz=${wline%%$'\t'*}; [[ $wsz =~ ^[0-9]+$ ]] && grand=$((grand + wsz))
  done <<<"$phonewalk"
  if (( total_n == 0 )); then
    [[ $QUIET -eq 0 ]] && printf '%s: nothing to stream — empty directory %s\n' "$PROG" "$FROM"
    exit 0
  fi
  showbar=0; if tty_out && (( grand > 0 )); then showbar=1; fi
  bar_start=$SECONDS
  (( showbar )) && bar_begin
  copied=0; skipped=0; bytes=0; cumdone=0; idx=0
  while IFS="$(printf '\t')" read -r rsize rpath; do
    [[ -n ${rpath:-} ]] || continue
    nrsize=0; [[ $rsize =~ ^[0-9]+$ ]] && nrsize=$rsize
    rel=${rpath#"$FROM"/}
    ddest="$dstbase/$rel"; dparent=${ddest%/*}
    idx=$((idx + 1))
    dsize="$(remote_size_on "$DST_SERIAL" "$ddest")"
    if [[ -n $rsize && -n $dsize && $dsize -eq $rsize ]]; then
      skipped=$((skipped + 1)); cumdone=$((cumdone + nrsize))
      if (( showbar )); then
        bar_draw "$cumdone" "$grand" "$(bar_rate "$bar_start" "$cumdone")" "$(bar_eta "$bar_start" "$cumdone" "$grand")" "[$idx/$total_n] $rel"
      else
        [[ $QUIET -eq 0 ]] && printf '%s: [%d/%d] have %s\n' "$PROG" "$idx" "$total_n" "$rel"
      fi
      continue
    fi
    copied=$((copied + 1)); bytes=$((bytes + nrsize))
    dsh_dst "mkdir -p $(sq "$dparent")" >/dev/null 2>&1 \
      || die 2 "cannot create destination dir on $DST_SERIAL: $dparent"
    (( showbar )) && bar_draw "$cumdone" "$grand" "$(bar_rate "$bar_start" "$cumdone")" "$(bar_eta "$bar_start" "$cumdone" "$grand")" "[$idx/$total_n] $rel"
    phone_stream "$rpath" "$dparent"; st=$?
    [[ $st -eq 0 ]] || { (( showbar )) && bar_end; die 3 "phone-to-phone stream failed (exit $st) on '$rel' — re-run to retry; source unchanged"; }
    dsize="$(remote_size_on "$DST_SERIAL" "$ddest")"
    [[ -n $rsize && -n $dsize && $dsize -eq $rsize ]] \
      || { (( showbar )) && bar_end; die 3 "phone-to-phone size mismatch on '$rel' (src=${rsize:-?} dst=${dsize:-?}) — re-run to retry"; }
    cumdone=$((cumdone + nrsize))
    if (( showbar )); then
      bar_draw "$cumdone" "$grand" "$(bar_rate "$bar_start" "$cumdone")" "$(bar_eta "$bar_start" "$cumdone" "$grand")" "[$idx/$total_n] $rel"
    else
      [[ $QUIET -eq 0 ]] && printf '%s: [%d/%d] streamed %s\n' "$PROG" "$idx" "$total_n" "$rel"
    fi
  done <<<"$phonewalk"
  (( showbar )) && bar_end

  [[ $QUIET -eq 0 ]] \
    && printf '%s: %d streamed, %d skipped (%s bytes) %s -> %s, no laptop copy\n' \
         "$PROG" "$copied" "$skipped" "$bytes" "$FROM" "$dstbase"
  exit 0
fi

# ---- pull ------------------------------------------------------------------

[[ -n $FROM ]] || die 1 "--from is required (see --help)"

# Normalise trailing slashes so the pulled basename is right (`/sdcard/Download/`).
[[ $FROM != / ]] && while [[ $FROM == */ ]]; do FROM=${FROM%/}; done
[[ $TO   != / ]] && while [[ $TO   == */ ]]; do TO=${TO%/};   done

# Destination: --to is always a directory. If it exists it must be a directory
# and writable; if it does not, it is created (not in dry-run).
if [[ -e $TO ]]; then
  [[ -d $TO ]] || die 2 "--to exists but is not a directory: $TO"
  [[ -w $TO ]] || die 2 "--to is not writable: $TO"
elif [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$TO" || die 2 "cannot create destination directory: $TO"
fi

from_kind="$(browse_kind "$FROM")"
[[ $from_kind == none ]] \
  && die 2 "no such path on the device: $FROM (use '$PROG --tree /sdcard' to find the real path)"

base="${FROM##*/}"
dest="$TO/$base"

build_pull_args() {
  PULL_ARGS=(pull)
  [[ $PRESERVE -eq 1 ]] && PULL_ARGS+=(-a)
  case $COMPRESS in
    none) PULL_ARGS+=(-Z) ;;
    "")   ;;
    *)    PULL_ARGS+=(-z "$COMPRESS") ;;
  esac
  [[ $QUIET -eq 1 ]] && PULL_ARGS+=(-q)
}

# Copy one remote item into a local directory. Returns adb's exit status.
adb_pull() { # <remote> <local-dir>
  build_pull_args
  PULL_ARGS+=("$1" "$2")
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'dry-run:'
    printf ' %q' "$ADB"
    [[ -n $SERIAL ]] && printf ' %q' -s "$SERIAL"
    printf ' %q' "${PULL_ARGS[@]}"
    printf '\n'
    return 0
  fi
  if [[ -n $SERIAL ]]; then "$ADB" -s "$SERIAL" "${PULL_ARGS[@]}" </dev/null
  else "$ADB" "${PULL_ARGS[@]}" </dev/null; fi
}


# ---- local pull (phone -> this computer) -------------------------------------

# --- a single file ----------------------------------------------------------
if [[ $from_kind == file ]]; then
  if [[ $SKIP -eq 1 && -f $dest ]]; then
    rsize="$(remote_size "$FROM")"
    lsize="$(wc -c < "$dest" 2>/dev/null || printf '%s' -1)"
    if [[ -n $rsize && $lsize -eq $rsize ]]; then
      [[ $QUIET -eq 0 ]] && printf '%s: have %s (%s bytes) — skipped\n' "$PROG" "$base" "$rsize"
      exit 0
    fi
  fi
  adb_pull "$FROM" "$TO"; st=$?
  [[ $st -eq 0 ]] || die 3 "adb pull failed (exit $st) — the phone's copy is untouched; re-run to retry"
  [[ $QUIET -eq 0 && $DRY_RUN -eq 0 ]] && printf '%s: pulled %s -> %s\n' "$PROG" "$FROM" "$dest"
  exit 0
fi

# --- a directory ------------------------------------------------------------
localbase="$dest"

# Fast path: nothing local to compare against (or skipping is off) — one pull,
# exactly like the old apull. Incremental only kicks in when there is an
# existing tree to compare against.
if [[ $SKIP -eq 0 || ! -d $localbase ]]; then
  adb_pull "$FROM" "$TO"; st=$?
  [[ $st -eq 0 ]] || die 3 "adb pull failed (exit $st) — the phone's copy is untouched; re-run to retry"
  [[ $QUIET -eq 0 && $DRY_RUN -eq 0 ]] && printf '%s: pulled %s -> %s\n' "$PROG" "$FROM" "$localbase"
  exit 0
fi

# Incremental path: walk the device, copy only what is missing or a new size.
qfrom="$(sq "$FROM")"

# 1) Mirror the directory skeleton first, so empty folders survive too.
if [[ $DRY_RUN -eq 0 ]]; then
  dsh "find -H $qfrom -type d -printf '%p\n'" 2>/dev/null | tr -d '\r' \
    | while IFS= read -r dpath; do
        [[ -n $dpath ]] || continue
        rel=${dpath#"$FROM"}; rel=${rel#/}
        [[ -n $rel ]] && mkdir -p "$localbase/$rel"
      done
fi

# 2) One find gives every file with its size; compare, then copy the stragglers.
copied=0; skipped=0; bytes=0
while IFS="$(printf '\t')" read -r rsize rpath; do
  [[ -n ${rpath:-} ]] || continue
  rel=${rpath#"$FROM"/}
  dest="$localbase/$rel"
  if [[ -f $dest ]]; then
    lsize="$(wc -c < "$dest" 2>/dev/null || printf '%s' -1)"
    if [[ $lsize -eq $rsize ]]; then
      skipped=$((skipped + 1))
      [[ $QUIET -eq 0 && $DRY_RUN -eq 0 ]] && printf '%s: have %s\n' "$PROG" "$rel"
      continue
    fi
  fi
  copied=$((copied + 1)); bytes=$((bytes + ${rsize:-0}))
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'dry-run: would copy %s (%s bytes)\n' "$rel" "$rsize"
    continue
  fi
  mkdir -p "${dest%/*}"
  adb_pull "$rpath" "${dest%/*}"; st=$?
  [[ $st -eq 0 ]] || die 3 "adb pull failed (exit $st) on '$rel' — re-run to retry; nothing on the phone was changed"
done < <(dsh "find -H $qfrom -type f -printf '%s\t%p\n'" 2>/dev/null | tr -d '\r')

[[ $QUIET -eq 0 && $DRY_RUN -eq 0 ]] \
  && printf '%s: %d copied, %d skipped (%s bytes) -> %s\n' \
       "$PROG" "$copied" "$skipped" "$bytes" "$localbase"
exit 0
