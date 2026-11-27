#!/usr/bin/env bash
# Prints the commit where a CI run's range starts. The commits job and the
# frozen-file check share it, so both judge the same range.
set -u
if [ -n "${BASE_SHA:-}" ]; then
  echo "$BASE_SHA"
elif [ -n "${BEFORE:-}" ] && [ "$BEFORE" != "0000000000000000000000000000000000000000" ]; then
  echo "$BEFORE"
else
  # A brand-new branch: compare against the default branch instead.
  git merge-base HEAD origin/master || git rev-list --max-parents=0 HEAD | tail -1
fi
