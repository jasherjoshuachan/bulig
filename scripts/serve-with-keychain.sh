#!/usr/bin/env bash
# Start `bulig serve` with the Telegram and GitHub tokens taken from the macOS Keychain.
# The token goes into this process's environment only. It is never printed or written to a file.
set -euo pipefail
cd "$(dirname "$0")/.."

# The database module is built for one Node major. Use the pinned one when fnm is installed.
if [[ -f .node-version ]] && command -v fnm >/dev/null; then
  if ! fnm_env="$(fnm env --shell bash)"; then
    echo "serve-with-keychain: 'fnm env' failed, so the pinned Node version could not be set up." >&2
    exit 1
  fi
  eval "$fnm_env"
  fnm use --install-if-missing --silent-if-unchanged >/dev/null
fi

if ! BULIG_TELEGRAM_TOKEN="$(security find-generic-password -s bulig-telegram-bot -w 2>/dev/null)" || [ -z "$BULIG_TELEGRAM_TOKEN" ]; then
  echo "serve-with-keychain: no Keychain item named bulig-telegram-bot." >&2
  echo "Add it with: security add-generic-password -s bulig-telegram-bot -a bulig -w" >&2
  exit 1
fi
export BULIG_TELEGRAM_TOKEN

# The GitHub token belongs to the bot account, so PRs and merges happen as the bot and never as you.
if ! BULIG_GH_TOKEN="$(security find-generic-password -s bulig-github-bot -w 2>/dev/null)" || [ -z "$BULIG_GH_TOKEN" ]; then
  echo "serve-with-keychain: no Keychain item named bulig-github-bot." >&2
  echo "Add it with: security add-generic-password -U -s bulig-github-bot -a <bot-username> -w" >&2
  exit 1
fi
export BULIG_GH_TOKEN

# Claude Code uses its own sign-in.
exec pnpm bulig serve "$@"
