#!/usr/bin/env bash
# Start `bulig serve` with the Telegram token taken from the macOS Keychain.
# The token goes into this process's environment only. It is never printed or written to a file.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! BULIG_TELEGRAM_TOKEN="$(security find-generic-password -s bulig-telegram-bot -w 2>/dev/null)" || [ -z "$BULIG_TELEGRAM_TOKEN" ]; then
  echo "serve-with-keychain: no Keychain item named bulig-telegram-bot." >&2
  echo "Add it with: security add-generic-password -s bulig-telegram-bot -a bulig -w" >&2
  exit 1
fi
export BULIG_TELEGRAM_TOKEN

# Keep GitHub and Claude Code credentials out of this script too. gh and claude use their own sign-in.
exec pnpm bulig serve "$@"
