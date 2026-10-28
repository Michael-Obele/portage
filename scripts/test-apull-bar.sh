#!/usr/bin/env bash
#
# Tests for apull.sh's terminal progress bar.
#
#   ./scripts/test-apull-bar.sh          # unit + static: no phone, no adb
#   ./scripts/test-apull-bar.sh --live   # + live loopback transfer (needs a device)
#
# Part 1 drives bar_draw() directly across percentages and widths and checks
# the two things users actually see: the # count matches the percent, and the
# frame never exceeds the terminal width (overflow = wrapped ghosts).
# Part 2 captures a real transfer under a pty and checks the fill trajectory.

set -uo pipefail
cd "$(dirname "$0")/.."
APULL=scripts/apull.sh
LIVE=0; [[ ${1:-} == --live ]] && LIVE=1
pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'ok: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1"; }

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

# ---- Part 1: bar_draw() behavior ----
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
sed -n '/^human() {/,/^}$/p;/^bar_draw() {/,/^}$/p' "$APULL" > "$TMP/bar.sh"
# shellcheck disable=SC1090
source "$TMP/bar.sh" || { bad 'extracted bar functions do not parse'; }

# The regression tripwire for the always-full bar: the fill line must derive
# the count from the percent, not from the allocated width.
if grep -q 'pct \* bar_w' "$APULL"; then ok 'fill derives from percent'; else bad 'fill line lost (want: pct * bar_w)'; fi

PROG=apull QUIET=0
# wide terminal: exact fill counts, including the 4%-shows-full regression
for spec in '0 100 0' '1 100 0' '4 100 0' '33 100 7' '50 100 12' '99 100 23' '100 100 24'; do
  set -- $spec
  BAR_COLS=120
  out=$(bar_draw "$1" "$2" r e L)
  hashes=${out//[^#]/}
  if [[ ${#hashes} -eq $3 ]]; then ok "wide fill $1/$2 -> $3"; else bad "wide fill $1/$2: want $3 hashes, got ${#hashes}"; fi
done

# the exact numbers from the bug report: 4% must not render a full bar
BAR_COLS=120
out=$(bar_draw 205520000 4724464025 r e L)
hashes=${out//[^#]/}
if [[ ${#hashes} -eq 0 && $out == *'4%'* ]]; then ok 'bug-report case: 4% renders empty bar'; else bad "bug-report case: got [$out]"; fi

# head marker: motion cue while incomplete, gone at 100%
BAR_COLS=120
if [[ $(bar_draw 50 100 r e L) == *'>'* ]]; then ok 'head marker present mid-flight'; else bad 'head marker missing at 50%'; fi
if [[ $(bar_draw 100 100 r e L) != *'>'* ]]; then ok 'head marker gone at 100%'; else bad 'head marker still there at 100%'; fi

# narrow terminals: frames must fit (the ghost contract), percent must show
for cols in 80 40 28; do
  for spec in '0 100' '4 100' '50 100' '100 100'; do
    set -- $spec
    BAR_COLS=$cols
    out=$(bar_draw "$1" "$2" r e 'a-quite-long-filename [1080p] [ABCDEF12].mkv')
    if [[ ${#out} -le $((cols + 4)) ]]; then ok "width $cols pct $1 fits"; else bad "width $cols pct $1: ${#out} cells > $cols"; fi
  done
  BAR_COLS=$cols
  out=$(bar_draw 50 100 r e L)
  [[ $out == *'50%'* ]] && ok "width $cols shows percent" || bad "width $cols hides percent"
done

# wide chars: budget halves, frame still fits
BAR_COLS=80
out=$(bar_draw 50 100 r e 'Ep02-鬼滅の刃.mkv')
[[ ${#out} -le 84 ]] && ok 'CJK label fits' || bad "CJK label overflows: ${#out}"

# single physical line each (a newline inside a frame is a ghost by definition)
BAR_COLS=120
out=$(bar_draw 50 100 r e L)
if [[ $(printf '%s' "$out" | wc -l) -eq 0 ]]; then ok 'frame is one line'; else bad 'frame contains newline'; fi

# ---- Part 2: live trajectory (needs a device) ----
if (( LIVE )); then
  serial=$(adb devices 2>/dev/null | awk '$2 == "device" { print $1; exit }')
  if [[ -z ${serial:-} ]]; then
    bad 'live: no attached authorized device'
  else
    ok "live: using device $serial"
    adb -s "$serial" shell 'mkdir -p /sdcard/Download/bartest/src; head -c 30000000 /dev/urandom > /sdcard/Download/bartest/src/slow30.bin; echo x > /sdcard/Download/bartest/src/small.txt; rm -rf /sdcard/Download/bartest/dst' >/dev/null 2>&1
    transcript=$(script -qec "$APULL --from /sdcard/Download/bartest/src --to-phone /sdcard/Download/bartest/dst --from-device $serial --to-device $serial" /dev/null </dev/null 2>&1)
    marks=$(printf '%s' "$transcript" | grep -o '%' | wc -l)
    (( marks >= 3 )) && ok "live: $marks progress frames drew" || bad 'live: too few progress frames'
    [[ $transcript == *'100%'* ]] && ok 'live: reached 100%' || bad 'live: never reached 100%'
    partial=0
    while read -r p; do
      n=${p%'%'}
      if [[ $n =~ ^[0-9]+$ ]] && (( n < 100 )); then partial=1; break; fi
    done < <(printf '%s' "$transcript" | grep -o '[0-9][0-9]*%')
    (( partial )) && ok 'live: partial states visible' || bad 'live: only full-bar states seen'
    sizes=$(adb -s "$serial" shell 'stat -c %s /sdcard/Download/bartest/src/slow30.bin; stat -c %s /sdcard/Download/bartest/dst/src/slow30.bin' 2>/dev/null | tr -d '\r')
    [[ $(printf '%s' "$sizes" | sort -u | wc -l) -eq 1 ]] && ok 'live: bytes landed intact' || bad "live: size mismatch [$sizes]"
    adb -s "$serial" shell 'rm -rf /sdcard/Download/bartest' >/dev/null 2>&1
  fi
fi

printf '\nbar tests: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
