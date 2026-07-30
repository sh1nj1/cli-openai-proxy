#!/usr/bin/env bash
# Publish the version already committed to main.
# Run: ./publish.sh

set -Eeuo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

fail() {
  echo -e "${RED}Error: $*${NC}" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

step() {
  echo ""
  echo -e "${YELLOW}[$1/8] $2${NC}"
}

for command in git gh node npm; do
  require_command "$command"
done

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) ||
  fail "Run this script inside the cli-openai-proxy repository."
cd "$REPO_ROOT"

PACKAGE_NAME=$(node -p "require('./package.json').name")
PACKAGE_VERSION=$(node -p "require('./package.json').version")
LOCK_VERSION=$(node -p "require('./package-lock.json').version")
TAG="v${PACKAGE_VERSION}"
BRANCH=$(git branch --show-current)
CURRENT_COMMIT=$(git rev-parse HEAD)
TAG_EXISTS=false
PUBLISHED=false
RELEASE_EXISTS=false

echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo -e "${CYAN}  ${PACKAGE_NAME} — Publish Pipeline${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════${NC}"

step 1 "Validating release state..."
[ "$PACKAGE_VERSION" = "$LOCK_VERSION" ] ||
  fail "package.json (${PACKAGE_VERSION}) and package-lock.json (${LOCK_VERSION}) versions differ."
[ "$BRANCH" = "main" ] || fail "Releases must run from main (current: ${BRANCH:-detached HEAD})."
[ -z "$(git status --porcelain)" ] || fail "Working tree must be clean."
git remote get-url origin >/dev/null 2>&1 || fail "The origin remote is not configured."
git fetch --quiet origin main --tags
[ "$CURRENT_COMMIT" = "$(git rev-parse origin/main)" ] ||
  fail "Local main must exactly match origin/main."
if git show-ref --verify --quiet "refs/tags/$TAG"; then
  TAG_COMMIT=$(git rev-list -n 1 "$TAG")
  [ "$TAG_COMMIT" = "$CURRENT_COMMIT" ] ||
    fail "Git tag $TAG points to $TAG_COMMIT instead of the current commit."
  TAG_EXISTS=true
fi
echo -e "${GREEN}  ✓ main is clean and matches origin/main${NC}"

step 2 "Checking npm registry..."
set +e
REGISTRY_RESULT=$(npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" gitHead 2>&1)
REGISTRY_STATUS=$?
set -e
if [ "$REGISTRY_STATUS" -eq 0 ]; then
  [ -n "$REGISTRY_RESULT" ] ||
    fail "${PACKAGE_NAME}@${PACKAGE_VERSION} is published without verifiable gitHead metadata."
  [ "$REGISTRY_RESULT" = "$CURRENT_COMMIT" ] ||
    fail "${PACKAGE_NAME}@${PACKAGE_VERSION} was published from a different commit ($REGISTRY_RESULT)."
  PUBLISHED=true
  echo -e "${GREEN}  ✓ npm package already matches this commit; missing release steps can resume${NC}"
else
  if [[ "$REGISTRY_RESULT" != *"E404"* ]] && [[ "$REGISTRY_RESULT" != *"is not in this registry"* ]]; then
    fail "Could not verify the npm version is unpublished:\n${REGISTRY_RESULT}"
  fi
  [ "$TAG_EXISTS" = false ] ||
    fail "Git tag $TAG exists, but ${PACKAGE_NAME}@${PACKAGE_VERSION} is not published."
  echo -e "${GREEN}  ✓ ${PACKAGE_NAME}@${PACKAGE_VERSION} is available${NC}"
fi

step 3 "Linting and auditing production dependencies..."
npm run lint
npm audit --omit=dev --audit-level=high
echo -e "${GREEN}  ✓ Lint and audit successful${NC}"

step 4 "Building..."
npm run build
echo -e "${GREEN}  ✓ Build successful${NC}"

step 5 "Testing..."
npm test
echo -e "${GREEN}  ✓ Tests successful${NC}"

step 6 "Checking package contents..."
node tools/check-package-contents.mjs
npm pack --dry-run

step 7 "Checking credentials and confirming..."
gh auth status >/dev/null 2>&1 || fail "Authenticate GitHub CLI with: gh auth login"
if [ "$PUBLISHED" = false ]; then
  npm whoami >/dev/null 2>&1 || fail "Authenticate npm with: npm login"
fi
[ "$(git rev-parse HEAD)" = "$CURRENT_COMMIT" ] ||
  fail "HEAD changed while release checks were running."
[ -z "$(git status --porcelain)" ] ||
  fail "Working tree changed while release checks were running."
REPOSITORY_URL=$(gh repo view --json url --jq .url)
if gh release view "$TAG" >/dev/null 2>&1; then
  RELEASE_EXISTS=true
fi
[ "$PUBLISHED" = true ] || [ "$RELEASE_EXISTS" = false ] ||
  fail "GitHub Release $TAG exists, but the npm package is not published."
if [ "$PUBLISHED" = true ] && [ "$TAG_EXISTS" = true ] && [ "$RELEASE_EXISTS" = true ]; then
  echo -e "${GREEN}  ✓ ${PACKAGE_NAME}@${PACKAGE_VERSION}, ${TAG}, and its GitHub Release already exist${NC}"
  exit 0
fi
echo ""
echo "  Package:    ${PACKAGE_NAME}@${PACKAGE_VERSION}"
echo "  Git tag:    ${TAG}"
echo "  Repository: ${REPOSITORY_URL}"
echo ""
if [ "$PUBLISHED" = true ]; then
  EXPECTED_CONFIRMATION="finalize ${PACKAGE_NAME}@${PACKAGE_VERSION}"
else
  EXPECTED_CONFIRMATION="publish ${PACKAGE_NAME}@${PACKAGE_VERSION}"
fi
if ! read -r -p "Type '${EXPECTED_CONFIRMATION}' to continue: " CONFIRMATION; then
  fail "Interactive confirmation is required."
fi
[ "$CONFIRMATION" = "$EXPECTED_CONFIRMATION" ] || fail "Publish cancelled."

step 8 "Publishing and creating the GitHub release..."
if [ "$PUBLISHED" = false ]; then
  if npm publish --access public; then
    PUBLISHED=true
  else
    # npm can report a network error after the registry accepted the package.
    RECOVERED_GIT_HEAD=$(npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" gitHead 2>/dev/null || true)
    [ "$RECOVERED_GIT_HEAD" = "$CURRENT_COMMIT" ] ||
      fail "npm publish failed and the registry does not contain this commit."
    PUBLISHED=true
    echo -e "${YELLOW}  ! npm publish returned an error, but the registry contains this commit; resuming${NC}"
  fi
fi
if [ "$TAG_EXISTS" = false ]; then
  git tag -a "$TAG" -m "${PACKAGE_NAME} ${PACKAGE_VERSION}"
fi
git push origin "$TAG"
if [ "$RELEASE_EXISTS" = false ]; then
  gh release create "$TAG" --verify-tag --generate-notes --title "$TAG"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Published ${PACKAGE_NAME}@${PACKAGE_VERSION}${NC}"
echo -e "${GREEN}  npm: https://www.npmjs.com/package/${PACKAGE_NAME}${NC}"
echo -e "${GREEN}  release: ${REPOSITORY_URL}/releases/tag/${TAG}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
