#!/usr/bin/env bash
# Linux per-user worker integration test. Builds the production image from the
# root Dockerfile, boots it, injects the test-only stub CLI and assertion
# script, and asserts the isolation properties end to end. Requires Docker.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${CLI_OPENAI_PROXY_ITEST_IMAGE:-cli-openai-proxy-linux-worker-itest}"
CONTAINER="cli-openai-proxy-itest-$$"

docker build -t "${IMAGE}" "${REPO_ROOT}"

cleanup() { docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# systemd as PID 1 needs a writable cgroup tree and its own /run tmpfs.
docker run -d --name "${CONTAINER}" \
  --privileged \
  --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  "${IMAGE}" >/dev/null

# The production image must ship no CLI or integration-test assets; prove it,
# then inject the stub CLI and the assertion script into the running container. Stage at
# /root, not /tmp: Ubuntu's tmp.conf clears /tmp during early boot
# (systemd-tmpfiles-setup.service runs `D /tmp ...`), which races docker cp
# into /tmp. No tmpfiles.d directive touches /root, so this sidesteps the
# race entirely; container-test.sh already has its own internal boot wait.
docker exec "${CONTAINER}" test ! -e /usr/local/bin/claude \
  || { echo "FAIL: production image ships a claude binary" >&2; exit 1; }
docker cp "${REPO_ROOT}/tools/linux-worker-integration/fake-claude" \
  "${CONTAINER}:/root/fake-claude"
docker cp "${REPO_ROOT}/tools/linux-worker-integration/container-test.sh" \
  "${CONTAINER}:/root/container-test.sh"
docker exec "${CONTAINER}" install -o root -g root -m 0755 \
  /root/fake-claude /usr/local/bin/claude
docker exec "${CONTAINER}" install -o root -g root -m 0755 \
  /root/container-test.sh /usr/local/bin/container-test.sh

docker exec "${CONTAINER}" /usr/local/bin/container-test.sh
