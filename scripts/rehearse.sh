#!/usr/bin/env bash
#
# End-to-end rehearsal against the fake device.
#
# Proves the whole pipeline — scan → plan → pull → status → purge — without a
# phone or a drive, including the failure paths that matter: a corrupt
# destination, and a `--keep-source` run that leaves the phone copy alone.

set -uo pipefail
cd "$(dirname "$0")/.."

PORTAGE="./dist/portage"
FAKE_ADB="$PWD/test/fixtures/fake-adb"

WORK="$(mktemp -d)"
DEST="$WORK/Anime"
mkdir -p "$DEST"
export PORTAGE_ADB_PATH="$FAKE_ADB"
export FAKE_ADB_REMOVED_LOG="$WORK/removed.log"

DEVICE_ID="$(bun -e 'import {deviceId} from "./src/device/adb.ts"; console.log(deviceId("fakeserial"))')"
CONFIG="$WORK/config.toml"

cat > "$CONFIG" <<EOF
dest_root     = "$DEST"
quiet_seconds = 1
delete_source = "never"

[devices."$DEVICE_ID"]
label = "Pixel 10 Pro XL"
roots = ["/sdcard/Movies"]
EOF

OLD=$(( $(date +%s) - 86400 ))
export FAKE_ADB_FILES=$'1048576\t'"$OLD"$'\t/sdcard/Movies/Frieren/S01/ep01.mkv\n1048576\t'"$((OLD + 10))"$'\t/sdcard/Movies/Frieren/S01/ep02.mkv\n524288\t'"$(date +%s)"$'\t/sdcard/Download/ep03.mkv.part\n'
export FAKE_ADB_MODE=ok
# The fake pulls zeroed bytes, so this is the phone's honest hash for them.
export FAKE_ADB_HASH="$(bun -e 'console.log(new Bun.CryptoHasher("sha256").update(new Uint8Array(1048576).fill(0)).digest("hex"))')"

step() { printf '\n\033[1m-- %s\033[0m\n' "$1"; }

step "scan: the .part file must be refused, the two old episodes must be new"
"$PORTAGE" scan --config "$CONFIG" --plain

step "plan: what would move"
"$PORTAGE" plan --config "$CONFIG" --plain

step "pull --keep-source: copy and verify, never delete"
"$PORTAGE" pull --config "$CONFIG" --plain --keep-source

step "status: verified on the drive, still on the phone"
"$PORTAGE" status --config "$CONFIG" --plain

step "the corrupt-destination case: a wrong phone hash must be rejected"
# A fresh workspace, and a phone hash that deliberately does not match the bytes
# the fake wrote. This is the exact silent-loss scenario: same size, same name,
# different content.
WORK2="$(mktemp -d)"
DEST2="$WORK2/Anime"
mkdir -p "$DEST2"
CONFIG2="$WORK2/config.toml"
export FAKE_ADB_REMOVED_LOG="$WORK2/removed.log"
cat > "$CONFIG2" <<EOF
dest_root     = "$DEST2"
quiet_seconds = 1

[devices."$DEVICE_ID"]
label = "Pixel 10 Pro XL"
roots = ["/sdcard/Movies"]
EOF
FAKE_ADB_HASH="$(bun -e 'console.log(new Bun.CryptoHasher("sha256").update(new Uint8Array(1048576).fill(0x41)).digest("hex"))')" \
  "$PORTAGE" pull --config "$CONFIG2" --plain; echo "  exit code = $?"

if [[ -s "$WORK2/removed.log" ]]; then
  echo "  !! A DELETE WAS ATTEMPTED — this is the bug the gate exists to prevent"
  cat "$WORK2/removed.log"
else
  echo "  ✓ nothing was deleted from the phone"
fi
rm -rf "$WORK2"
export FAKE_ADB_REMOVED_LOG="$WORK/removed.log"

step "purge --dry-run: nothing may be deleted"
"$PORTAGE" purge --config "$CONFIG" --plain --dry-run

step "purge: only proven files may go"
"$PORTAGE" purge --config "$CONFIG" --plain

step "what the phone was actually asked to delete"
if [[ -s "$WORK/removed.log" ]]; then
  cat "$WORK/removed.log"
else
  echo "(nothing was deleted -- correct)"
fi

rm -rf "$WORK"