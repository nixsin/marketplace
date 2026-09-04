#!/bin/sh
# Bootstrap for `node scripts/check-local-env.mjs`.
#
# Exists because that script cannot report the one failure people actually
# hit: node missing from PATH. It is a node script, so it does not run at all
# — the shell prints `command not found` and the checker never gets a say.
#
# This is the entry point that survives that. It checks for node, says
# something useful when it is absent, and hands off for everything else.
#
# POSIX sh, no bashisms: it has to run before we know anything about the
# machine, which is the whole point.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# --export: print the PATH this script would need, for the CALLER to adopt.
#
#   eval "$(sh scripts/check-local-env.sh --export)"
#
# A child process cannot change its parent's environment -- the environment is
# copied at exec and there is no way back -- so this is the same idiom
# `brew shellenv` and `ssh-agent` use: the child prints assignments and the
# parent evaluates them in its own shell.
#
# The alternative, making dev.sh itself sourceable, is deliberately NOT
# offered: it runs `set -euo pipefail`, and in a sourced script that exits the
# USER'S TERMINAL on the first failure. A setup script that can close your
# terminal is worse than one that asks you to run one more command.
#
# Prints nothing when the PATH is already correct, so it is safe to eval
# unconditionally from a shell profile or by hand.
if [ "${1:-}" = "--export" ]; then
  # Gate on CAPABILITY, not on whether PATH changed. Sourcing ~/.zshenv
  # prepends the same directory again, so a string comparison always reports
  # a difference -- it emitted an assignment on every call, and evaluating
  # that repeatedly grows PATH with duplicates.
  if command -v node >/dev/null 2>&1; then
    exit 0
  fi

  if [ -r "$HOME/.zshenv" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.zshenv" 2>/dev/null || true
  fi
  if command -v node >/dev/null 2>&1; then
    # Single-quoted, with embedded quotes closed and re-opened, so a path
    # containing a quote cannot end the assignment early.
    escaped=$(printf '%s' "$PATH" | sed "s/'/'\\\\''/g")
    printf "export PATH='%s'\n" "$escaped"
  fi
  exit 0
fi

# A stale terminal is the common case: ~/.zshenv gained the PATH line after
# this shell started, so the file is right and the session is old. Sourcing it
# repairs THIS script's environment, which is enough for the run to proceed.
#
# It cannot repair the CALLER's shell -- a child process cannot alter its
# parent's environment -- so the message below still says what to run, and
# says why rather than implying the script could have done it.
if ! command -v node >/dev/null 2>&1 && [ -r "$HOME/.zshenv" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.zshenv" 2>/dev/null || true
fi

if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'

  ✗ node is not on PATH.

  Almost always nvm not being loaded in this shell rather than a missing
  install. nvm is initialised from ~/.zshrc, which only runs for INTERACTIVE
  shells, so a stale terminal or a non-interactive one has no node.

  This script already tried sourcing ~/.zshenv for its own run and still
  found nothing. It cannot fix your shell either way -- a child process
  cannot change its parent's environment -- so run one of these yourself:

    source ~/.zshenv           # a terminal opened before the PATH line
    eval "$(sh scripts/check-local-env.sh --export)"   # same, from this repo
    source ~/.zshrc            # a terminal opened before nvm was configured
    ls ~/.nvm/versions/node    # is nvm installed at all?
    nvm alias default 22       # `nvm current` says none -> nothing activated
    nvm install --lts          # if that directory is empty

  Nothing else can be checked until node runs, so this stops here.

EOF
  exit 1
fi

exec node "$repo_root/scripts/check-local-env.mjs" "$@"
