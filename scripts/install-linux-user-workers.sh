#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

MIN_NODE_VERSION="22.13.0"
READINESS_TIMEOUT="${INSTALL_READINESS_TIMEOUT:-30}"
ROTATE_KEYS="${INSTALL_ROTATE_KEYS:-0}"
USE_PREBUILT="${INSTALL_USE_PREBUILT:-0}"
START_GATEWAY="${INSTALL_START_GATEWAY:-1}"
PRINT_KEYS="${INSTALL_PRINT_KEYS:-1}"
TENANT_ID="${INSTALL_TENANT_ID:-default}"
USER_ID="${INSTALL_USER_ID:-default}"
SINGLE_SERVICE_NAME="${INSTALL_SINGLE_SERVICE_NAME:-com.cli-openai-proxy}"
SINGLE_USER="${INSTALL_SINGLE_USER:-${SUDO_USER:-}}"

SERVICE_ACCOUNT="cli-openai-proxy"
BUILD_ACCOUNT_PREFIX="cli-openai-proxy-bld-"
BUILD_ACCOUNT=""
BUILD_ACCOUNT_CREATED=0
BUILD_GROUP_CREATED=0
CONFIG_DIR="/etc/cli-openai-proxy"
STATE_DIR="/var/lib/cli-openai-proxy"
RUNTIME_BASE="/opt/cli-openai-proxy/releases"
UNIT_TARGET="/etc/systemd/system"
TMPFILES_TARGET="/etc/tmpfiles.d"
GATEWAY_ENV="${CONFIG_DIR}/gateway.env"
BUILD_ROOT=""
RELEASE_STAGING=""

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ "$EUID" -eq 0 && -n "$BUILD_ACCOUNT" ]] \
      && id "$BUILD_ACCOUNT" >/dev/null 2>&1; then
    kill_build_processes || printf '[install] WARNING: build-account processes survived cleanup\n' >&2
  fi
  case "$BUILD_ROOT" in
    /var/tmp/cli-openai-proxy-build.*) rm -rf -- "$BUILD_ROOT" ;;
  esac
  case "$RELEASE_STAGING" in
    /opt/cli-openai-proxy/releases/.install.*) rm -rf -- "$RELEASE_STAGING" ;;
  esac
  if [[ "$EUID" -eq 0 && "$BUILD_ACCOUNT_CREATED" == "1" ]]; then
    userdel "$BUILD_ACCOUNT" 2>/dev/null \
      || printf '[install] WARNING: unable to remove transient build account\n' >&2
  fi
  if [[ "$EUID" -eq 0 && "$BUILD_GROUP_CREATED" == "1" ]]; then
    if getent group "$BUILD_ACCOUNT" >/dev/null; then
      groupdel "$BUILD_ACCOUNT" 2>/dev/null \
      || printf '[install] WARNING: unable to remove transient build group\n' >&2
    fi
  fi
}
trap cleanup EXIT

validate_boolean() {
  local name="$1"
  local value="$2"
  [[ "$value" == "0" || "$value" == "1" ]] || die "$name must be 0 or 1"
}

random_key() {
  local prefix="$1"
  local random
  random="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  [[ ${#random} -eq 64 ]] || die "Unable to generate a random key"
  printf 'cop_%s_%s' "$prefix" "$random"
}

path_tree_is_root_trusted() {
  local root="$1"
  local entry metadata owner mode target

  [[ "$root" == /* && -e "$root" ]] || return 1
  while IFS= read -r -d '' entry; do
    if [[ -L "$entry" ]]; then
      target="$(readlink -f -- "$entry" 2>/dev/null)" || return 1
      [[ "$target" == "$root/"* ]] || return 1
      continue
    fi
    [[ -f "$entry" || -d "$entry" ]] || return 1
    metadata="$(stat -Lc '%u %a' -- "$entry")" || return 1
    read -r owner mode <<<"$metadata"
    [[ "$owner" == "0" && "$mode" =~ ^[0-7]+$ ]] || return 1
    (( (8#$mode & 8#022) == 0 )) || return 1
  done < <(find "$root" -xdev -print0)
}

run_npm_as_service() {
  local name value
  local -a build_env=(
    "HOME=$BUILD_ROOT/home"
    "PATH=$(dirname -- "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin"
  )
  for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
    value="${!name-}"
    [[ -z "$value" ]] || build_env+=("$name=$value")
  done
  runuser -u "$BUILD_ACCOUNT" -- env -i \
    "${build_env[@]}" \
    "$NPM_BIN" \
    --userconfig="$BUILD_ROOT/.npmrc.user" \
    --globalconfig="$BUILD_ROOT/.npmrc.global" \
    --script-shell=/bin/sh \
    "$@"
}

kill_build_processes() {
  local build_uid attempt process owner found

  build_uid="$(id -u "$BUILD_ACCOUNT")"
  for attempt in 1 2 3 4 5; do
    found=0
    for process in /proc/[0-9]*; do
      owner="$(stat -c '%u' "$process" 2>/dev/null || true)"
      [[ "$owner" == "$build_uid" ]] || continue
      found=1
      kill -KILL "${process##*/}" 2>/dev/null || true
    done
    [[ "$found" == "1" ]] || return 0
    sleep 1
  done
  return 1
}

terminate_build_processes() {
  kill_build_processes \
    || die "Build account still owns running processes after npm completed"
}

ensure_build_account() {
  local attempt build_gid build_uid candidate matching_uid_count passwd_entry
  local shadow_entry build_home build_shell build_password random

  random="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$random" =~ ^[0-9a-f]{12}$ ]] \
    || die "Unable to generate a transient build account name"
  for attempt in 1 2 3 4 5; do
    candidate="${BUILD_ACCOUNT_PREFIX}${random:0:8}-${attempt}"
    if ! getent group "$candidate" >/dev/null \
      && ! getent passwd "$candidate" >/dev/null; then
      BUILD_ACCOUNT="$candidate"
      break
    fi
  done
  [[ -n "$BUILD_ACCOUNT" ]] || die "Unable to reserve a transient build account name"

  groupadd --system "$BUILD_ACCOUNT" \
    || die "Unable to create transient build group"
  BUILD_GROUP_CREATED=1
  useradd --system --gid "$BUILD_ACCOUNT" --home-dir /nonexistent \
    --no-create-home --shell /usr/sbin/nologin "$BUILD_ACCOUNT" \
    || die "Unable to create transient build account"
  BUILD_ACCOUNT_CREATED=1
  usermod --lock --home /nonexistent --shell /usr/sbin/nologin "$BUILD_ACCOUNT" \
    || die "Unable to disable login for $BUILD_ACCOUNT"

  build_gid="$(getent group "$BUILD_ACCOUNT" | awk -F: '{print $3}')"
  build_uid="$(id -u "$BUILD_ACCOUNT")"
  matching_uid_count="$(getent passwd \
    | awk -F: -v uid="$build_uid" '$3 == uid { count++ } END { print count + 0 }')"
  passwd_entry="$(getent passwd "$BUILD_ACCOUNT")" \
    || die "Unable to read passwd entry for $BUILD_ACCOUNT"
  shadow_entry="$(getent shadow "$BUILD_ACCOUNT")" \
    || die "Unable to read shadow entry for $BUILD_ACCOUNT"
  IFS=: read -r _ _ _ _ _ build_home build_shell <<<"$passwd_entry"
  IFS=: read -r _ build_password _ <<<"$shadow_entry"
  [[ "$build_uid" != "0" \
      && "$matching_uid_count" == "1" \
      && "$(id -g "$BUILD_ACCOUNT")" == "$build_gid" \
      && "$(id -G "$BUILD_ACCOUNT")" == "$build_gid" \
      && "$build_home" == "/nonexistent" \
      && "$build_shell" == "/usr/sbin/nologin" \
      && ( "$build_password" == '!'* || "$build_password" == '*'* ) ]] \
    || die "$BUILD_ACCOUNT must be unprivileged, login-disabled, and have no supplementary groups"
}

retire_build_account() {
  terminate_build_processes
  userdel "$BUILD_ACCOUNT" || die "Unable to remove transient build account"
  BUILD_ACCOUNT_CREATED=0
  if getent group "$BUILD_ACCOUNT" >/dev/null; then
    groupdel "$BUILD_ACCOUNT" || die "Unable to remove transient build group"
  fi
  BUILD_GROUP_CREATED=0
}

install_native_build_tools() {
  if command -v make >/dev/null 2>&1 \
    && command -v g++ >/dev/null 2>&1 \
    && command -v python3 >/dev/null 2>&1; then
    return
  fi
  command -v apt-get >/dev/null 2>&1 \
    || die "Native build tools are required. On Ubuntu: apt-get install -y build-essential python3"
  log "Installing Ubuntu native build prerequisites"
  apt-get update
  apt-get install -y build-essential python3
}

prepare_build() {
  local input
  local -a inputs=(package.json package-lock.json tsconfig.json src scripts tools)

  if [[ "$USE_PREBUILT" == "1" ]]; then
    BUILD_ROOT="$SOURCE_ROOT"
    path_tree_is_root_trusted "$BUILD_ROOT" \
      || die "INSTALL_USE_PREBUILT requires a root-owned, non-writable source tree"
    log "Using the root-owned prebuilt container bundle"
    return
  fi

  install_native_build_tools
  ensure_build_account
  # A prior failed lifecycle script may have daemonized under this fixed UID.
  # Clear it before exposing a new writable staging path to that account.
  terminate_build_processes
  BUILD_ROOT="$(mktemp -d /var/tmp/cli-openai-proxy-build.XXXXXX)"
  chown "$BUILD_ACCOUNT:$BUILD_ACCOUNT" "$BUILD_ROOT"
  chmod 0700 "$BUILD_ROOT"
  for input in "${inputs[@]}"; do
    [[ -e "$SOURCE_ROOT/$input" && ! -L "$SOURCE_ROOT/$input" ]] \
      || die "Required build input is missing or is a symlink: $input"
    cp -a -- "$SOURCE_ROOT/$input" "$BUILD_ROOT/"
  done
  chown -R "$BUILD_ACCOUNT:$BUILD_ACCOUNT" "$BUILD_ROOT"
  install -d -o "$BUILD_ACCOUNT" -g "$BUILD_ACCOUNT" -m 0700 "$BUILD_ROOT/home"
  install -o "$BUILD_ACCOUNT" -g "$BUILD_ACCOUNT" -m 0600 /dev/null \
    "$BUILD_ROOT/.npmrc.user"
  install -o "$BUILD_ACCOUNT" -g "$BUILD_ACCOUNT" -m 0600 /dev/null \
    "$BUILD_ROOT/.npmrc.global"

  log "Installing dependencies as $BUILD_ACCOUNT"
  (cd "$BUILD_ROOT" && run_npm_as_service ci)
  log "Building production files as $BUILD_ACCOUNT"
  (cd "$BUILD_ROOT" && run_npm_as_service run build)
  log "Removing development-only dependencies"
  (cd "$BUILD_ROOT" && run_npm_as_service prune --omit=dev)

  # Lifecycle scripts may daemonize and retain writable file descriptors. The
  # build-only UID has no runtime/config access and must have no process left
  # before root freezes and validates its output.
  terminate_build_processes
  chown -R root:root "$BUILD_ROOT"
  chmod -R go-w "$BUILD_ROOT"
  retire_build_account
}

validate_build() {
  local entry
  local -a entrypoints=(
    dist/server/standalone.js
    dist/server/worker-standalone.js
    dist/server/provisioner-standalone.js
  )
  for entry in "${entrypoints[@]}"; do
    [[ -f "$BUILD_ROOT/$entry" && ! -L "$BUILD_ROOT/$entry" ]] \
      || die "Validated build is missing $entry"
  done
  [[ -d "$BUILD_ROOT/node_modules" && ! -L "$BUILD_ROOT/node_modules" ]] \
    || die "Validated build is missing node_modules"
  [[ -f "$BUILD_ROOT/tools/auth-test.html" && ! -L "$BUILD_ROOT/tools/auth-test.html" ]] \
    || die "Validated build is missing tools/auth-test.html"

  (cd "$BUILD_ROOT" && "$NODE_BIN" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    for (const dependency of Object.keys(pkg.dependencies || {})) {
      try {
	import.meta.resolve(dependency);
      } catch {
	console.error(`Missing runtime dependency: ${dependency}`);
	process.exit(1);
      }
    }
  ') || die "Runtime dependency validation failed"
  [[ ! -e "$BUILD_ROOT/node_modules/typescript" ]] \
    || die "Development dependencies remain in the production build"
}

promote_release() {
  local link target

  RUNTIME_ROOT="${RUNTIME_BASE}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  RELEASE_STAGING="${RUNTIME_BASE}/.install.$$"
  install -d -o root -g root -m 0755 "$RUNTIME_BASE" "$RELEASE_STAGING"
  install -d -o root -g root -m 0755 "$RELEASE_STAGING/bin" "$RELEASE_STAGING/tools"
  install -o root -g root -m 0755 "$NODE_BIN" "$RELEASE_STAGING/bin/node"
  install -o root -g root -m 0644 "$BUILD_ROOT/tools/auth-test.html" \
    "$RELEASE_STAGING/tools/auth-test.html"
  cp -a -- "$BUILD_ROOT/dist" "$BUILD_ROOT/node_modules" "$BUILD_ROOT/package.json" \
    "$RELEASE_STAGING/"
  chown -R root:root "$RELEASE_STAGING"
  chmod -R go-w "$RELEASE_STAGING"

  while IFS= read -r -d '' link; do
    target="$(readlink -f -- "$link" 2>/dev/null)" \
      || die "Refusing a dangling runtime symlink: $link"
    [[ "$target" == "$RELEASE_STAGING/"* ]] \
      || die "Refusing runtime symlink outside the immutable release: $link -> $target"
  done < <(find "$RELEASE_STAGING" -type l -print0)
  linux_node_runtime_path_is_trusted "$RELEASE_STAGING/bin/node" root \
    || die "Promoted Node.js runtime is not root trusted"

  mv "$RELEASE_STAGING" "$RUNTIME_ROOT"
  RELEASE_STAGING=""
  RUNTIME_NODE="$RUNTIME_ROOT/bin/node"
}

gateway_env_has() {
  local name="$1"
  grep -q "^${name}=" "$GATEWAY_ENV" 2>/dev/null
}

rotate_user_mappings() {
  "$NODE_BIN" --input-type=commonjs -e '
    const { randomBytes } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const line = readFileSync(process.argv[1], "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("USER_API_KEYS="));
    if (!line) process.exit(2);
    let value = line.slice("USER_API_KEYS=".length).trim();
    if (value.startsWith("\u0027") && value.endsWith("\u0027")) {
      value = value.slice(1, -1);
    } else if (value.startsWith("\u0022") && value.endsWith("\u0022")) {
      value = value.slice(1, -1).replace(/\\([\\\u0022])/g, "$1");
    }
    const mappings = JSON.parse(value);
    if (!Array.isArray(mappings) || mappings.length === 0) process.exit(3);
    const rotated = mappings.map((mapping) => {
      if (!mapping || typeof mapping !== "object"
	  || typeof mapping.tenantId !== "string" || typeof mapping.userId !== "string") {
	process.exit(4);
      }
      return { ...mapping, key: `cop_user_${randomBytes(32).toString("hex")}` };
    });
    const result = JSON.stringify(rotated);
    if (result.includes("\u0027")) process.exit(5);
    process.stdout.write(result);
  ' "$GATEWAY_ENV"
}

prepare_gateway_config() {
  local replace_user=0 replace_admin=0 add_port=0 add_host=0
  local temp line user_value admin_value

  if [[ -e "$GATEWAY_ENV" || -L "$GATEWAY_ENV" ]]; then
    [[ -f "$GATEWAY_ENV" && ! -L "$GATEWAY_ENV" ]] \
      || die "Refusing a non-regular gateway config: $GATEWAY_ENV"
    [[ "$(stat -Lc '%u' "$GATEWAY_ENV")" == "0" ]] \
      || die "Gateway config must be root-owned: $GATEWAY_ENV"
    (( (8#$(stat -Lc '%a' "$GATEWAY_ENV") & 8#022) == 0 )) \
      || die "Gateway config must not be group/world writable: $GATEWAY_ENV"
  else
    install -o root -g "$SERVICE_ACCOUNT" -m 0640 /dev/null "$GATEWAY_ENV"
  fi

  if [[ "$ROTATE_KEYS" == "1" ]] && gateway_env_has USER_API_KEYS; then
    GENERATED_USER_MAPPINGS="$(rotate_user_mappings)" \
      || die "Unable to rotate USER_API_KEYS while preserving tenant/user mappings"
    user_value="'${GENERATED_USER_MAPPINGS}'"
    replace_user=1
  elif ! gateway_env_has USER_API_KEYS; then
    GENERATED_USER_KEY="$(random_key user)"
    GENERATED_USER_MAPPINGS="[{\"key\":\"${GENERATED_USER_KEY}\",\"tenantId\":\"${TENANT_ID}\",\"userId\":\"${USER_ID}\"}]"
    user_value="'${GENERATED_USER_MAPPINGS}'"
    replace_user=1
  fi
  if [[ "$ROTATE_KEYS" == "1" ]] || ! gateway_env_has AUTH_ADMIN_KEYS; then
    GENERATED_ADMIN_KEY="$(random_key admin)"
    admin_value="$GENERATED_ADMIN_KEY"
    replace_admin=1
  fi
  gateway_env_has PORT || add_port=1
  gateway_env_has HOST || add_host=1

  if ((replace_user || replace_admin || add_port || add_host)); then
    temp="$(mktemp "$CONFIG_DIR/.gateway.env.XXXXXX")"
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$replace_user" == "1" && "$line" == USER_API_KEYS=* ]]; then
	continue
      fi
      if [[ "$replace_admin" == "1" && "$line" == AUTH_ADMIN_KEYS=* ]]; then
	continue
      fi
      printf '%s\n' "$line"
    done < "$GATEWAY_ENV" > "$temp"
    [[ "$replace_user" == "0" ]] || printf 'USER_API_KEYS=%s\n' "$user_value" >> "$temp"
    [[ "$replace_admin" == "0" ]] || printf 'AUTH_ADMIN_KEYS=%s\n' "$admin_value" >> "$temp"
    [[ "$add_port" == "0" ]] || printf 'PORT=3456\n' >> "$temp"
    [[ "$add_host" == "0" ]] || printf 'HOST=127.0.0.1\n' >> "$temp"
    install -o root -g "$SERVICE_ACCOUNT" -m 0640 "$temp" "$GATEWAY_ENV"
    rm -f -- "$temp"
  else
    chown root:"$SERVICE_ACCOUNT" "$GATEWAY_ENV"
    chmod 0640 "$GATEWAY_ENV"
    log "Keeping existing gateway keys and configuration: $GATEWAY_ENV"
  fi
}

stop_single_user_service() {
  local uid runtime_dir home user_systemctl

  [[ -n "$SINGLE_USER" && "$SINGLE_USER" != "root" ]] || return 0
  id "$SINGLE_USER" >/dev/null 2>&1 || die "Single-user service account does not exist: $SINGLE_USER"
  uid="$(id -u "$SINGLE_USER")"
  runtime_dir="/run/user/$uid"
  home="$(getent passwd "$SINGLE_USER" | awk -F: '{print $6}')"
  user_systemctl=(runuser -u "$SINGLE_USER" -- env
    "XDG_RUNTIME_DIR=$runtime_dir"
    "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime_dir/bus"
    systemctl --user)

  if [[ -d "$runtime_dir" ]] && "${user_systemctl[@]}" show-environment >/dev/null 2>&1; then
    if "${user_systemctl[@]}" is-active --quiet "$SINGLE_SERVICE_NAME.service" \
      || "${user_systemctl[@]}" is-enabled --quiet "$SINGLE_SERVICE_NAME.service"; then
      log "Stopping and disabling the conflicting single-user service for $SINGLE_USER"
      "${user_systemctl[@]}" disable --now "$SINGLE_SERVICE_NAME.service"
    fi
    return 0
  fi

  if [[ -e "$home/.config/systemd/user/$SINGLE_SERVICE_NAME.service" ]]; then
    die "Unable to reach $SINGLE_USER's systemd user manager; stop and disable $SINGLE_SERVICE_NAME.service before converting"
  fi
}

install_units() {
  local unit temp
  local -a units=(
    cli-openai-proxy-provisioner.service
    cli-openai-proxy-provisioner.socket
    cli-openai-proxy-worker@.service
    cli-openai-proxy-worker@.socket
    cli-openai-proxy-gateway.service
  )

  for unit in "${units[@]}"; do
    temp="$(mktemp "$UNIT_TARGET/.${unit}.XXXXXX")"
    sed -e "s|@NODE@|${RUNTIME_NODE}|g" -e "s|@APP_ROOT@|${RUNTIME_ROOT}|g" \
      "$UNIT_SOURCE/$unit" > "$temp"
    install -o root -g root -m 0644 "$temp" "$UNIT_TARGET/$unit"
    rm -f -- "$temp"
  done
  install -o root -g root -m 0644 "$UNIT_SOURCE/cli-openai-proxy-tmpfiles.conf" \
    "$TMPFILES_TARGET/cli-openai-proxy.conf"
}

health_check() {
  "$RUNTIME_NODE" -e '
    const http = require("node:http");
    const request = http.get({
      hostname: process.argv[1],
      port: Number(process.argv[2]),
      path: "/health",
      timeout: 1000,
    }, (response) => {
      response.resume();
      response.on("end", () => process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => process.exit(1));
  ' "$1" "$2"
}

listener_belongs_to_pid() {
  "$RUNTIME_NODE" -e '
    const fs = require("node:fs");
    const pid = process.argv[1];
    const expectedPort = Number(process.argv[2]);

    try {
      const socketInodes = new Set();
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
	let target;
	try {
	  target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
	} catch {
	  continue;
	}
	const match = /^socket:\[(\d+)\]$/.exec(target);
	if (match) socketInodes.add(match[1]);
      }

      for (const table of [`/proc/${pid}/net/tcp`, `/proc/${pid}/net/tcp6`]) {
	let rows;
	try {
	  rows = fs.readFileSync(table, "utf8").trim().split("\n").slice(1);
	} catch {
	  continue;
	}
	for (const row of rows) {
	  const fields = row.trim().split(/\s+/);
	  if (fields.length < 10 || fields[3] !== "0A") continue;
	  const separator = fields[1].lastIndexOf(":");
	  const port = Number.parseInt(fields[1].slice(separator + 1), 16);
	  if (port === expectedPort && socketInodes.has(fields[9])) {
	    process.exit(0);
	  }
	}
      }
    } catch {
      // The unit may be between restart attempts; let the caller retry.
    }
    process.exit(1);
  ' "$1" "$2"
}

read_effective_listener() {
  local pid="$1"
  local env_entry value

  [[ -r "/proc/$pid/environ" ]] || return 1
  EFFECTIVE_HOST="127.0.0.1"
  EFFECTIVE_PORT="3456"
  while IFS= read -r -d '' env_entry; do
    case "$env_entry" in
    HOST=*)
      value="${env_entry#HOST=}"
      [[ -z "$value" ]] || EFFECTIVE_HOST="$value"
      ;;
    PORT=*)
      value="${env_entry#PORT=}"
      [[ -z "$value" ]] || EFFECTIVE_PORT="$value"
      ;;
    esac
  done < "/proc/$pid/environ"

  [[ -n "$EFFECTIVE_HOST" ]]
  [[ "$EFFECTIVE_PORT" =~ ^[0-9]+$ ]] \
    && ((EFFECTIVE_PORT >= 1 && EFFECTIVE_PORT <= 65535))
}

start_and_verify_services() {
  local ready=0 deadline worker_unit main_pid current_main_pid probe_host

  systemd-tmpfiles --create "$TMPFILES_TARGET/cli-openai-proxy.conf"
  systemctl daemon-reload
  systemctl enable --now cli-openai-proxy-provisioner.socket

  systemctl list-units --type=service --state=active --no-legend --plain \
    'cli-openai-proxy-worker@*.service' |
    while read -r worker_unit _; do
      [[ -z "$worker_unit" ]] || systemctl restart "$worker_unit"
    done
  systemctl restart cli-openai-proxy-provisioner.service
  systemctl is-active --quiet cli-openai-proxy-provisioner.socket \
    || die "Provisioner socket is not active"
  systemctl is-active --quiet cli-openai-proxy-provisioner.service \
    || die "Provisioner service is not active"

  systemctl enable cli-openai-proxy-gateway.service
  [[ "$START_GATEWAY" == "1" ]] || return 0
  systemctl restart cli-openai-proxy-gateway.service
  deadline=$((SECONDS + READINESS_TIMEOUT))
  log "Waiting up to ${READINESS_TIMEOUT}s for the gateway health endpoint"
  while ((SECONDS < deadline)); do
    main_pid="$(systemctl show cli-openai-proxy-gateway.service \
      --property=MainPID --value 2>/dev/null || true)"
    if systemctl is-active --quiet cli-openai-proxy-gateway.service \
      && [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] \
      && read_effective_listener "$main_pid"; then
      probe_host="$EFFECTIVE_HOST"
      case "$probe_host" in
	0.0.0.0) probe_host="127.0.0.1" ;;
	:: | "[::]") probe_host="::1" ;;
      esac

      current_main_pid=""
      if listener_belongs_to_pid "$main_pid" "$EFFECTIVE_PORT" \
	&& health_check "$probe_host" "$EFFECTIVE_PORT"; then
	current_main_pid="$(systemctl show cli-openai-proxy-gateway.service \
	  --property=MainPID --value 2>/dev/null || true)"
      fi
      if [[ "$current_main_pid" == "$main_pid" ]] \
	&& listener_belongs_to_pid "$main_pid" "$EFFECTIVE_PORT"; then
	ready=1
	break
      fi
    fi
    sleep 1
  done
  if [[ "$ready" == "0" ]]; then
    systemctl --no-pager --full status cli-openai-proxy-gateway.service || true
    die "Gateway did not become healthy within ${READINESS_TIMEOUT}s"
  fi
}

main() {
[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux only"
[[ "$EUID" -eq 0 ]] || die "Run as root: sudo $0"
command -v flock >/dev/null 2>&1 || die "flock is required to serialize installation"
exec 9>/run/cli-openai-proxy-install.lock \
  || die "Unable to open the installation lock"
flock --nonblock 9 || die "Another cli-openai-proxy installation is running"
validate_boolean INSTALL_ROTATE_KEYS "$ROTATE_KEYS"
validate_boolean INSTALL_USE_PREBUILT "$USE_PREBUILT"
validate_boolean INSTALL_START_GATEWAY "$START_GATEWAY"
validate_boolean INSTALL_PRINT_KEYS "$PRINT_KEYS"
[[ "$READINESS_TIMEOUT" =~ ^[0-9]+$ ]] \
  && ((READINESS_TIMEOUT >= 1 && READINESS_TIMEOUT <= 300)) \
  || die "INSTALL_READINESS_TIMEOUT must be between 1 and 300 seconds"
[[ "$TENANT_ID" =~ ^[A-Za-z0-9._:@/-]{1,128}$ ]] || die "Invalid INSTALL_TENANT_ID"
[[ "$USER_ID" =~ ^[A-Za-z0-9._:@/-]{1,128}$ ]] || die "Invalid INSTALL_USER_ID"
[[ "$SINGLE_SERVICE_NAME" =~ ^[A-Za-z0-9_.][A-Za-z0-9_.@-]*$ ]] \
  || die "Invalid INSTALL_SINGLE_SERVICE_NAME"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
UNIT_SOURCE="$SOURCE_ROOT/deploy/linux"
NODE_RUNTIME_SCRIPT="$SCRIPT_DIR/linux-node-runtime.sh"
[[ -f "$NODE_RUNTIME_SCRIPT" ]] || die "Node.js runtime helper is missing: $NODE_RUNTIME_SCRIPT"
# shellcheck source=linux-node-runtime.sh
source "$NODE_RUNTIME_SCRIPT"

linux_node_runtime_prepare root "$MIN_NODE_VERSION" \
  || die "Unable to prepare a root-trusted Node.js runtime"
NODE_BIN="$LINUX_NODE_BIN"
NPM_BIN="$LINUX_NPM_BIN"

if ! getent group "$SERVICE_ACCOUNT" >/dev/null; then
  groupadd --system "$SERVICE_ACCOUNT"
fi
if ! id "$SERVICE_ACCOUNT" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_ACCOUNT" --home-dir "$STATE_DIR/gateway" \
    --create-home --shell /usr/sbin/nologin "$SERVICE_ACCOUNT"
fi

install -d -o root -g root -m 0755 "$CONFIG_DIR" "$RUNTIME_BASE" "$TMPFILES_TARGET"
install -d -o root -g root -m 0700 "$STATE_DIR/provisioner"
install -d -o root -g root -m 0755 "$STATE_DIR/users"
install -d -o "$SERVICE_ACCOUNT" -g "$SERVICE_ACCOUNT" -m 0700 "$STATE_DIR/gateway"

prepare_build
validate_build
promote_release
prepare_gateway_config

if [[ ! -e "$CONFIG_DIR/provisioner-identity.key" ]]; then
  random_key identity > "$CONFIG_DIR/provisioner-identity.key"
fi
[[ -f "$CONFIG_DIR/provisioner-identity.key" && ! -L "$CONFIG_DIR/provisioner-identity.key" ]] \
  || die "Refusing a non-regular provisioner identity key"
chown root:root "$CONFIG_DIR/provisioner-identity.key"
chmod 0600 "$CONFIG_DIR/provisioner-identity.key"

stop_single_user_service
if systemctl is-active --quiet cli-openai-proxy-gateway.service; then
  systemctl stop cli-openai-proxy-gateway.service
fi
install_units
start_and_verify_services

log "Installation complete"
printf '\n  Runtime: %s\n' "$RUNTIME_ROOT"
printf '  Config:  %s\n' "$GATEWAY_ENV"
printf '  Status:  systemctl status cli-openai-proxy-gateway.service cli-openai-proxy-provisioner.service\n'
if [[ "$PRINT_KEYS" == "1" ]]; then
  if [[ -n "${GENERATED_USER_MAPPINGS:-}" ]]; then
    printf "  USER_API_KEYS='%s'\n" "$GENERATED_USER_MAPPINGS"
  fi
  if [[ -n "${GENERATED_ADMIN_KEY:-}" ]]; then
    printf '  Admin API key: %s\n' "$GENERATED_ADMIN_KEY"
  fi
fi
printf '\nExisting Single-user CLI credentials are not copied.\n'
printf 'Run Codex device login and agent provisioning again for each mapped user.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
