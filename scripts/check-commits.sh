#!/usr/bin/env bash
# Reject a commit that can never produce a release.
#
# release-please decides the next version from the commit types it understands.
# A `docs:`, `chore:`, `ci:` or `test:` subject is parsed, listed in the log, and
# then bumps nothing, which breaks the rule this repo runs on:
#
#   every commit bumps a patch, and only a breaking change bumps a minor.
#
# So the rule is enforced here instead: a commit that lands must be a type
# release-please acts on. That makes the promise true rather than aspirational,
# and it costs one second per push.
#
# Usage: check-commits.sh <from-sha> <to-sha>
set -euo pipefail

from="${1:?usage: check-commits.sh <from-sha> <to-sha>}"
to="${2:?usage: check-commits.sh <from-sha> <to-sha>}"

# Types release-please bumps on. `feat` bumps (patch while pre-1.0), `fix`,
# `perf`, `deps` and `revert` bump, and anything with `!` bumps a minor.
allowed='^(feat|fix|perf|deps|revert)(\([a-z0-9._-]+\))?!?: .+'

failed=0
count=0

while IFS= read -r line; do
	[ -z "$line" ] && continue
	sha="${line%% *}"
	subject="${line#* }"

	# Merge commits are created by GitHub itself and carry no version meaning.
	case "$subject" in
	"Merge "*)
		continue
		;;
	esac

	count=$((count + 1))

	if ! printf '%s' "$subject" | grep -Eq "$allowed"; then
		echo "::error::$sha is not a releasable commit: \"$subject\""
		echo "           Use feat, fix, perf, deps or revert, with an optional scope,"
		echo "           and add ! before the colon for a breaking change."
		failed=1
	fi

	# The convention is 50; CI allows 72 so a long scope is not punished twice.
	length=${#subject}
	if [ "$length" -gt 72 ]; then
		echo "::error::$sha subject is $length characters (max 72): \"$subject\""
		failed=1
	fi
done < <(git log --format='%h %s' "$from..$to")

echo "Checked $count commit(s) between $from and $to."
exit "$failed"
