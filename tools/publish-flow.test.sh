#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REAL_NODE=$(command -v node)
TEST_ROOT=$(mktemp -d)
FAKE_BIN="$TEST_ROOT/bin"
STATE_DIR="$TEST_ROOT/state"
REPO_DIR="$TEST_ROOT/repo"
CURRENT_SHA=1111111111111111111111111111111111111111

cleanup() {
  if [ -n "${TEST_ROOT:-}" ] && [ -d "$TEST_ROOT" ]; then
    rm -rf "$TEST_ROOT"
  fi
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN" "$STATE_DIR" "$REPO_DIR"

printf '%s\n' '{"name":"cli-openai-proxy","version":"0.1.0"}' >"$REPO_DIR/package.json"
printf '%s\n' '{"version":"0.1.0"}' >"$REPO_DIR/package-lock.json"

cat >"$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >>"$STATE_DIR/calls"
case "${1:-} ${2:-}" in
  "rev-parse --show-toplevel") printf '%s\n' "$REPO_DIR" ;;
  "rev-parse HEAD"|"rev-parse origin/main") printf '%s\n' "$CURRENT_SHA" ;;
  "branch --show-current") printf '%s\n' main ;;
  "status --porcelain")
    STATUS_CALLS=$(( $(/bin/cat "$STATE_DIR/status-calls" 2>/dev/null || printf 0) + 1 ))
    printf '%s' "$STATUS_CALLS" >"$STATE_DIR/status-calls"
    if [ -f "$STATE_DIR/dirty-status-from" ] &&
      [ "$STATUS_CALLS" -ge "$(/bin/cat "$STATE_DIR/dirty-status-from")" ]; then
      printf ' M src/app.ts\n'
    fi
    ;;
  "remote get-url") printf '%s\n' git@github.com:sh1nj1/cli-openai-proxy.git ;;
  "fetch --quiet") ;;
  "show-ref --verify")
    [ -f "$STATE_DIR/tag" ]
    ;;
  "rev-list -n")
    if [ -f "$STATE_DIR/tag-target" ]; then
      /bin/cat "$STATE_DIR/tag-target"
    else
      printf '%s\n' "$CURRENT_SHA"
    fi
    ;;
  "tag -a")
    : >"$STATE_DIR/tag"
    printf '%s\n' "$CURRENT_SHA" >"$STATE_DIR/tag-target"
    ;;
  "push origin")
    if [ -f "$STATE_DIR/fail-git-push" ]; then
      /bin/rm "$STATE_DIR/fail-git-push"
      exit 1
    fi
    ;;
  *) printf 'Unexpected git command: %s\n' "$*" >&2; exit 91 ;;
esac
EOF

cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >>"$STATE_DIR/calls"
case "${1:-}" in
  view)
    if [ -f "$STATE_DIR/published" ]; then
      if [ -f "$STATE_DIR/published-head" ]; then
        /bin/cat "$STATE_DIR/published-head"
      else
        printf '%s\n' "$CURRENT_SHA"
      fi
    else
      printf 'npm error code E404\n' >&2
      exit 1
    fi
    ;;
  run|test|audit) ;;
  whoami)
    [ ! -f "$STATE_DIR/fail-npm-whoami" ]
    ;;
  pack)
    if [[ " $* " == *" --json "* ]]; then
      printf '%s\n' '[{"files":[]}]'
    fi
    ;;
  publish)
    case "$NPM_PUBLISH_MODE" in
      success)
        : >"$STATE_DIR/published"
        ;;
      accepted_with_error)
        : >"$STATE_DIR/published"
        exit 1
        ;;
      failure)
        exit 1
        ;;
      *)
        printf 'Unknown NPM_PUBLISH_MODE: %s\n' "$NPM_PUBLISH_MODE" >&2
        exit 92
        ;;
    esac
    ;;
  *) printf 'Unexpected npm command: %s\n' "$*" >&2; exit 93 ;;
esac
EOF

cat >"$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >>"$STATE_DIR/calls"
case "${1:-} ${2:-}" in
  "auth status") ;;
  "repo view") printf '%s\n' https://github.com/sh1nj1/cli-openai-proxy ;;
  "release view") [ -f "$STATE_DIR/release" ] ;;
  "release create")
    if [ -f "$STATE_DIR/fail-release-create" ]; then
      /bin/rm "$STATE_DIR/fail-release-create"
      exit 1
    fi
    : >"$STATE_DIR/release"
    ;;
  *) printf 'Unexpected gh command: %s\n' "$*" >&2; exit 94 ;;
esac
EOF

cat >"$FAKE_BIN/node" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "tools/check-package-contents.mjs" ]; then
  exit 0
fi
exec "$REAL_NODE" "\$@"
EOF

chmod +x "$FAKE_BIN/git" "$FAKE_BIN/npm" "$FAKE_BIN/gh" "$FAKE_BIN/node"

reset_state() {
  find "$STATE_DIR" -mindepth 1 -maxdepth 1 -type f -delete
}

run_publish() {
  local confirmation=$1
  set +e
  OUTPUT=$(
    printf '%s\n' "$confirmation" |
      PATH="$FAKE_BIN:$PATH" \
      STATE_DIR="$STATE_DIR" \
      REPO_DIR="$REPO_DIR" \
      CURRENT_SHA="$CURRENT_SHA" \
      NPM_PUBLISH_MODE="${NPM_PUBLISH_MODE:-success}" \
      "$PROJECT_ROOT/publish.sh" 2>&1
  )
  EXIT_CODE=$?
  set -e
}

assert_success() {
  [ "$EXIT_CODE" -eq 0 ] || {
    printf 'Expected success, got %s:\n%s\n' "$EXIT_CODE" "$OUTPUT" >&2
    exit 1
  }
}

assert_failure() {
  [ "$EXIT_CODE" -ne 0 ] || {
    printf 'Expected failure:\n%s\n' "$OUTPUT" >&2
    exit 1
  }
}

assert_called() {
  local expected=$1
  grep -Fq "$expected" "$STATE_DIR/calls" || {
    printf 'Expected call not found: %s\n' "$expected" >&2
    exit 1
  }
}

assert_not_called() {
  local unexpected=$1
  if grep -Fq "$unexpected" "$STATE_DIR/calls"; then
    printf 'Unexpected call found: %s\n' "$unexpected" >&2
    exit 1
  fi
}

reset_state
NPM_PUBLISH_MODE=success
run_publish "publish cli-openai-proxy@0.1.0"
assert_success
assert_called "npm publish --access public"
assert_called "git tag -a v0.1.0"
assert_called "git push origin v0.1.0"
assert_called "gh release create v0.1.0"

reset_state
NPM_PUBLISH_MODE=accepted_with_error
run_publish "publish cli-openai-proxy@0.1.0"
assert_success
assert_called "npm publish --access public"
assert_called "gh release create v0.1.0"
grep -Fq "registry contains this commit; resuming" <<<"$OUTPUT"

reset_state
: >"$STATE_DIR/published"
NPM_PUBLISH_MODE=failure
: >"$STATE_DIR/fail-npm-whoami"
run_publish "finalize cli-openai-proxy@0.1.0"
assert_success
assert_not_called "npm publish"
assert_not_called "npm whoami"
assert_called "git tag -a v0.1.0"
assert_called "gh release create v0.1.0"

reset_state
: >"$STATE_DIR/published"
: >"$STATE_DIR/tag"
printf '%s\n' "$CURRENT_SHA" >"$STATE_DIR/tag-target"
: >"$STATE_DIR/release"
run_publish ""
assert_success
assert_not_called "npm publish"
assert_not_called "gh release create"

reset_state
: >"$STATE_DIR/published"
printf '%s\n' 2222222222222222222222222222222222222222 >"$STATE_DIR/published-head"
run_publish ""
assert_failure
grep -Fq "published from a different commit" <<<"$OUTPUT"
assert_not_called "npm publish"

reset_state
: >"$STATE_DIR/tag"
printf '%s\n' 2222222222222222222222222222222222222222 >"$STATE_DIR/tag-target"
run_publish ""
assert_failure
grep -Fq "points to" <<<"$OUTPUT"
assert_not_called "npm publish"

reset_state
: >"$STATE_DIR/fail-git-push"
NPM_PUBLISH_MODE=success
run_publish "publish cli-openai-proxy@0.1.0"
assert_failure
assert_called "npm publish --access public"
[ -f "$STATE_DIR/published" ]
[ -f "$STATE_DIR/tag" ]
[ ! -f "$STATE_DIR/release" ]
: >"$STATE_DIR/fail-npm-whoami"
: >"$STATE_DIR/calls"
NPM_PUBLISH_MODE=failure
run_publish "finalize cli-openai-proxy@0.1.0"
assert_success
assert_not_called "npm publish"
assert_not_called "npm whoami"
assert_called "git push origin v0.1.0"
assert_called "gh release create v0.1.0"

reset_state
: >"$STATE_DIR/fail-release-create"
NPM_PUBLISH_MODE=success
run_publish "publish cli-openai-proxy@0.1.0"
assert_failure
assert_called "npm publish --access public"
[ -f "$STATE_DIR/published" ]
[ -f "$STATE_DIR/tag" ]
[ ! -f "$STATE_DIR/release" ]
: >"$STATE_DIR/fail-npm-whoami"
: >"$STATE_DIR/calls"
NPM_PUBLISH_MODE=failure
run_publish "finalize cli-openai-proxy@0.1.0"
assert_success
assert_not_called "npm publish"
assert_not_called "npm whoami"
assert_not_called "git tag -a"
assert_called "gh release create v0.1.0"

# The tree can change while the script waits at the confirmation prompt, so the
# third status check (after confirmation) must abort before npm publish runs.
reset_state
printf '%s\n' 3 >"$STATE_DIR/dirty-status-from"
NPM_PUBLISH_MODE=success
run_publish "publish cli-openai-proxy@0.1.0"
assert_failure
grep -Fq "while waiting for confirmation" <<<"$OUTPUT"
assert_not_called "npm publish"

echo "publish flow tests passed"
