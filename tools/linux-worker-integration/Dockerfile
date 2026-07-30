# systemd-enabled Ubuntu image for the per-user Linux worker integration test.
# Build context is the repository root: run via tools/linux-worker-integration/run.sh.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# python3/make/g++ let npm ci fall back to source builds for native deps (node-pty).
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus curl ca-certificates xz-utils passwd \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# The installer refuses a node binary whose path has non-root owners or
# group/world-writable parents, so normalize ownership after extracting.
ARG NODE_VERSION=22.17.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) node_arch=arm64 ;; \
      amd64) node_arch=x64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1; \
    chown -R root:root /usr/local; \
    chmod -R go-w /usr/local/bin /usr/local/lib /usr/local/include /usr/local/share; \
    node --version

WORKDIR /opt/src

COPY package.json package-lock.json ./
COPY scripts/fix-node-pty-permissions.mjs scripts/fix-node-pty-permissions.mjs
RUN npm ci

COPY . .
RUN npm run build

# Stand-in Claude CLI: emits stream-json that reports the OS identity it ran as,
# so the test can prove CLI runs happen inside the caller's dedicated account.
RUN install -o root -g root -m 0755 \
      tools/linux-worker-integration/fake-claude /usr/local/bin/claude

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
