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

if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'

  ✗ node is not on PATH.

  Almost always nvm not being loaded in this shell rather than a missing
  install. nvm is initialised from ~/.zshrc, which only runs for INTERACTIVE
  shells, so a stale terminal or a non-interactive one has no node.

  Try, in order:

    source ~/.zshrc            # a terminal opened before nvm was configured
    ls ~/.nvm/versions/node    # is nvm installed at all?
    nvm install --lts          # if that directory is empty

  Nothing else can be checked until node runs, so this stops here.

EOF
  exit 1
fi

exec node "$repo_root/scripts/check-local-env.mjs" "$@"
