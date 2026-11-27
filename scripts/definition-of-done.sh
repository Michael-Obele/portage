#!/usr/bin/env bash
# Runs every check AGENTS.md's definition of done names, in order, and writes the
# evidence to bench/results/<date>-definition-of-done.txt. Exits non-zero when any
# step fails. Every step runs even after a failure, so the file shows them all.
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
day="$(date -u +%F)"
out="$repo/bench/results/$day-definition-of-done.txt"
mkdir -p "$repo/bench/results"
: >"$out"
failed=0

step() {
  local name="$1" dir="$2"
  shift 2
  local log code counts
  log="$(mktemp)"
  (cd "$repo/$dir" && "$@") >"$log" 2>&1
  code=$?
  counts="$(grep -E '^ *[0-9]+ (pass|fail|skip|todo)$|test result:|Finished|errors?,|warnings?' "$log" | tail -8)"
  {
    echo "=== $name ==="
    echo "dir: ${dir:-.}"
    echo "cmd: $*"
    echo "exit: $code"
    [ -n "$counts" ] && echo "$counts"
    echo
  } >>"$out"
  rm -f "$log"
  [ "$code" -eq 0 ] || failed=1
}

{
  echo "definition of done, $day UTC"
  echo "commit: $(git -C "$repo" rev-parse HEAD 2>/dev/null)"
  echo "branch: $(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo
} >>"$out"

step "engine typecheck" "" bun run typecheck
step "engine tests" "" bun run test
step "desktop svelte-check" "apps/desktop" bun run check
step "desktop tests" "apps/desktop" bun run test
step "desktop a11y contrast" "apps/desktop" bun run a11y
step "scanner cargo test" "crates/portage-scan" cargo test
step "scanner clippy" "crates/portage-scan" cargo clippy --all-targets -- -D warnings
step "scanner fmt" "crates/portage-scan" cargo fmt --check
step "shell cargo test" "apps/desktop/src-tauri" cargo test
step "shell clippy" "apps/desktop/src-tauri" cargo clippy --all-targets -- -D warnings
step "shell fmt" "apps/desktop/src-tauri" cargo fmt --check
step "desktop build" "apps/desktop" bun run build
step "desktop headless journey" "apps/desktop" bun run ui:sweep

{
  if [ "$failed" -eq 0 ]; then echo "RESULT: pass"; else echo "RESULT: fail"; fi
} >>"$out"

echo "$out"
exit "$failed"
