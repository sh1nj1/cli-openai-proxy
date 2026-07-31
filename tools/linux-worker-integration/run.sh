#!/usr/bin/env bash
# Linux per-user worker integration test. Builds a systemd-enabled Ubuntu image,
# boots it, installs the services with the real installer, and asserts the
# isolation properties end to end. Requires Docker; takes a few minutes.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${CLI_OPENAI_PROXY_ITEST_IMAGE:-cli-openai-proxy-linux-worker-itest}"
CONTAINER="cli-openai-proxy-itest-$$"

docker build \
  -t "${IMAGE}" \
  -f "${REPO_ROOT}/tools/linux-worker-integration/Dockerfile" \
  "${REPO_ROOT}"

cleanup() { docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# systemd as PID 1 needs a writable cgroup tree and its own /run tmpfs.
docker run -d --name "${CONTAINER}" \
  --privileged \
  --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  "${IMAGE}" >/dev/null

docker exec "${CONTAINER}" /opt/src/tools/linux-worker-integration/container-test.sh
