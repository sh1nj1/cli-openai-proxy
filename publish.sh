#!/bin/bash
# One-step publish script for cli-openai-proxy
# Run: bash publish.sh
# Prerequisites: Node.js, npm, gh CLI installed

set -e
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo -e "${CYAN}  cli-openai-proxy — Publish Pipeline${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo ""

# Step 0: Build
echo -e "${YELLOW}[1/5] Building...${NC}"
npm run build
echo -e "${GREEN}  ✓ Build successful${NC}"
echo ""

# Step 1: Fail before touching GitHub/npm if scratch files would ship
echo -e "${YELLOW}[2/5] Checking package contents...${NC}"
node tools/check-package-contents.mjs
echo ""

# Step 2: GitHub auth
echo -e "${YELLOW}[3/5] GitHub auth...${NC}"
if gh auth status &>/dev/null; then
  echo -e "${GREEN}  ✓ Already logged into GitHub${NC}"
else
  echo -e "${CYAN}  Opening GitHub login (just follow the prompts)...${NC}"
  gh auth login --web --git-protocol https
fi
echo ""

# Step 3: Push to GitHub
echo -e "${YELLOW}[4/5] Pushing to GitHub...${NC}"
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
if [ -z "$REMOTE_URL" ]; then
  echo -e "${CYAN}  Creating GitHub repo...${NC}"
  gh repo create cli-openai-proxy --public --source=. --push
else
  git push origin main
fi
echo -e "${GREEN}  ✓ Pushed to GitHub${NC}"
echo ""

# Step 4: Publish to npm
echo -e "${YELLOW}[5/5] Publishing to npm...${NC}"
if npm whoami &>/dev/null; then
  echo -e "${GREEN}  ✓ Already logged into npm${NC}"
else
  echo -e "${CYAN}  Opening npm login...${NC}"
  npm login
fi
npm publish --access public
echo -e "${GREEN}  ✓ Published to npm!${NC}"
echo ""

echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Done! Package is live:${NC}"
echo -e "${GREEN}  npm: https://www.npmjs.com/package/cli-openai-proxy${NC}"
echo -e "${GREEN}  GitHub: https://github.com/$(gh api user -q .login)/cli-openai-proxy${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
