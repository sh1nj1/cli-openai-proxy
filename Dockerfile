# Single production/integration-test image. The default target `runtime` boots
# systemd and installs the per-user Linux worker services on first boot, so
# macOS/Windows hosts get the same multi-user isolation via Docker Desktop.
# Integration tests build this exact image and inject test-only assets at run
# time (tools/linux-worker-integration/run.sh) — never bake test assets here.
FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates xz-utils \
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


FROM base AS build

# python3/make/g++ let npm fall back to source builds for native deps (node-pty).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app

COPY package.json package-lock.json tsconfig.json ./
COPY scripts/fix-node-pty-permissions.mjs scripts/fix-node-pty-permissions.mjs
RUN npm ci

COPY src src
COPY tools/clean.mjs tools/clean.mjs
RUN npm run build

# The runtime image must ship no devDependencies; reinstall prod-only.
RUN rm -rf node_modules && npm ci --omit=dev


FROM base AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus passwd \
    && rm -rf /var/lib/apt/lists/*

# Optional system-wide real CLIs for production, e.g.
#   --build-arg INSTALL_CLIS="@anthropic-ai/claude-code @openai/codex"
# Left empty for integration tests, which inject a stub CLI instead.
ARG INSTALL_CLIS=""
RUN if [ -n "${INSTALL_CLIS}" ]; then \
      npm install -g ${INSTALL_CLIS}; \
      chown -R root:root /usr/local/lib/node_modules /usr/local/bin; \
      chmod -R go-w /usr/local/lib/node_modules /usr/local/bin; \
    fi

WORKDIR /opt/app

COPY --from=build /opt/app/dist dist
COPY --from=build /opt/app/node_modules node_modules
COPY package.json package-lock.json ./
COPY scripts scripts
COPY tools/auth-test.html tools/auth-test.html
COPY deploy/linux deploy/linux
COPY deploy/docker/first-boot-install.sh /usr/local/lib/cli-openai-proxy/first-boot-install.sh
COPY deploy/docker/cli-openai-proxy-first-boot.service /etc/systemd/system/cli-openai-proxy-first-boot.service
RUN chmod 0755 /usr/local/lib/cli-openai-proxy/first-boot-install.sh \
    && systemctl enable cli-openai-proxy-first-boot.service

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
