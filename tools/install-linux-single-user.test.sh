#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Skipping Linux installer trust tests on %s\n' "$(uname -s)"
  exit 0
fi

ROOT="$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P)"
# Load only the installer helpers; running the installer itself requires systemd.
source <(sed -n '1,/^prepare_trusted_directory()/p' "$ROOT/scripts/install-linux-single-user.sh" | sed '$d')

STAT_BIN=/usr/bin/stat
REALPATH_BIN=/usr/bin/realpath
DIRNAME_BIN=/usr/bin/dirname

TEST_DIR="$ROOT/.install-trust-test-$RANDOM"
trap 'chmod -R u+rwX -- "$TEST_DIR" 2>/dev/null || true; rm -rf -- "$TEST_DIR"' EXIT
mkdir "$TEST_DIR"
chmod 770 "$TEST_DIR"

if path_metadata_is_trusted "$TEST_DIR" directory; then
  printf 'expected group-writable directory to be rejected\n' >&2
  exit 1
fi
[[ "$TRUST_FAILURE" == *': mode 770 permits group or other users to write '* ]]

CONTROL_PATH="$TEST_DIR/"$'hostile\n[install] ERROR: forged'
mkdir "$CONTROL_PATH"
chmod 770 "$CONTROL_PATH"
if path_metadata_is_trusted "$CONTROL_PATH" directory; then
  printf 'expected control-character path to be rejected\n' >&2
  exit 1
fi
[[ "$TRUST_FAILURE" != *$'\n'* ]]
[[ "$TRUST_FAILURE" == *'\n'* ]]

TRUST_FAILURE="stale failure"
if service_path_is_trusted relative/path; then
  printf 'expected relative path to be rejected\n' >&2
  exit 1
fi
[[ "$TRUST_FAILURE" == 'relative/path: expected an absolute path' ]]

REALPATH_BIN=/bin/false
TRUST_FAILURE="stale failure"
if service_path_is_trusted /usr/bin; then
  printf 'expected realpath failure to be rejected\n' >&2
  exit 1
fi
[[ "$TRUST_FAILURE" == '/usr/bin: unable to resolve the existing path' ]]

for installer in \
  "$ROOT/scripts/install-linux-single-user.sh" \
  "$ROOT/scripts/install-linux-user-workers.sh"; do
  source <(sed -n '/^read_effective_listener()/,/^}$/p' "$installer")

  ENVIRON_FIXTURE="$TEST_DIR/environ"
  printf 'HOST=0.0.0.0\0PORT=4567\0' >"$ENVIRON_FIXTURE"
  read_effective_listener 0 "$ENVIRON_FIXTURE"
  [[ "$EFFECTIVE_HOST" == "0.0.0.0" ]]
  [[ "$EFFECTIVE_PORT" == "4567" ]]

  READ_ERROR=""
  if READ_ERROR="$(read_effective_listener 0 "$TEST_DIR/missing-environ" 2>&1)"; then
    printf 'expected an unavailable process environment to be rejected\n' >&2
    exit 1
  fi
  [[ -z "$READ_ERROR" ]]
done
