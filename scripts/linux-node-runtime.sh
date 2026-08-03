#!/usr/bin/env bash

# Shared Node.js runtime preparation for the Linux installers. This file is
# sourced by both installers; it intentionally does not change shell options.

LINUX_NODE_RUNTIME_DEFAULT_VERSION="22.13.0"
LINUX_NODE_RUNTIME_INSTALL_ROOT="/opt/cli-openai-proxy/node"

linux_node_runtime_log() {
  printf '[node-runtime] %s\n' "$*"
}

linux_node_runtime_error() {
  printf '[node-runtime] ERROR: %s\n' "$*" >&2
}

linux_node_runtime_command() {
  local name="$1"
  local candidate

  for candidate in "/usr/bin/$name" "/usr/sbin/$name" "/bin/$name" "/sbin/$name" "/usr/local/bin/$name"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

linux_node_runtime_version_supported() {
  local node_bin="$1"
  local minimum="$2"

  "$node_bin" -e '
    const current = process.versions.node.split(".").map(Number);
    const minimum = process.argv[1].split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (current[index] > minimum[index]) process.exit(0);
      if (current[index] < minimum[index]) process.exit(1);
    }
  ' "$minimum" >/dev/null 2>&1
}

linux_node_runtime_version_string_supported() {
  local current="$1"
  local minimum="$2"
  local index
  local -a current_parts minimum_parts

  IFS=. read -r -a current_parts <<<"$current"
  IFS=. read -r -a minimum_parts <<<"$minimum"
  for index in 0 1 2; do
    [[ "${current_parts[$index]:-}" =~ ^[0-9]+$ \
	&& "${minimum_parts[$index]:-}" =~ ^[0-9]+$ ]] || return 1
    if ((current_parts[index] > minimum_parts[index])); then
      return 0
    fi
    if ((current_parts[index] < minimum_parts[index])); then
      return 1
    fi
  done
  return 0
}

linux_node_runtime_path_is_trusted() {
  local candidate="$1"
  local trust_mode="$2"
  local resolved current metadata owner mode parent

  [[ "$candidate" == /* && -f "$candidate" && -x "$candidate" ]] || return 1
  resolved="$("$LINUX_NODE_RUNTIME_READLINK_BIN" -f -- "$candidate" 2>/dev/null)" || return 1
  [[ "$resolved" == /* && -f "$resolved" && -x "$resolved" ]] || return 1

  current="$resolved"
  while true; do
    metadata="$(LC_ALL=C "$LINUX_NODE_RUNTIME_STAT_BIN" -Lc '%u %a' -- "$current" 2>/dev/null)" || return 1
    read -r owner mode <<<"$metadata"
    [[ "$mode" =~ ^[0-7]+$ ]] || return 1
    (( (8#$mode & 8#022) == 0 )) || return 1
    if [[ "$trust_mode" == "root" ]]; then
      [[ "$owner" == "0" ]] || return 1
      if [[ "$current" == "$resolved" ]]; then
	(( (8#$mode & 8#005) == 8#005 )) || return 1
      else
	(( (8#$mode & 8#001) == 8#001 )) || return 1
      fi
    else
      [[ "$owner" == "0" || "$owner" == "$EUID" ]] || return 1
    fi
    [[ "$current" != "/" ]] || break
    parent="$("$LINUX_NODE_RUNTIME_DIRNAME_BIN" -- "$current")"
    [[ "$parent" != "$current" ]] || break
    current="$parent"
  done
}

linux_node_runtime_validate_install_directory() {
  local directory="$1"
  local metadata owner mode

  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || {
      linux_node_runtime_error "Managed Node.js path is not a regular directory: $directory"
      return 1
    }
    metadata="$(LC_ALL=C "$LINUX_NODE_RUNTIME_STAT_BIN" -Lc '%u %a' -- "$directory" 2>/dev/null)" \
      || return 1
    read -r owner mode <<<"$metadata"
    [[ "$owner" == "0" && "$mode" =~ ^[0-7]+$ ]] \
      && (( (8#$mode & 8#022) == 0 )) || {
      linux_node_runtime_error "Managed Node.js path has untrusted ownership or permissions: $directory"
      return 1
    }
  fi
}

linux_node_runtime_prepare_install_root() {
  local install_parent

  install_parent="$($LINUX_NODE_RUNTIME_DIRNAME_BIN -- "$LINUX_NODE_RUNTIME_INSTALL_ROOT")"
  linux_node_runtime_validate_install_directory "$install_parent" || return 1

  # Make only the trusted parent traversable before inspecting a child that a
  # previous private parent may have hidden from the invoking account.
  linux_node_runtime_as_root "$LINUX_NODE_RUNTIME_INSTALL_BIN" -d -o root -g root -m 0755 \
    "$install_parent" || return 1

  linux_node_runtime_validate_install_directory "$LINUX_NODE_RUNTIME_INSTALL_ROOT" || return 1
  linux_node_runtime_as_root "$LINUX_NODE_RUNTIME_INSTALL_BIN" -d -o root -g root -m 0755 \
    "$LINUX_NODE_RUNTIME_INSTALL_ROOT"
}

linux_node_runtime_find_npm() {
  local node_bin="$1"
  local trust_mode="$2"
  local candidate resolved
  local -a candidates=(
    "$("$LINUX_NODE_RUNTIME_DIRNAME_BIN" -- "$node_bin")/npm"
    "/usr/local/bin/npm"
    "/usr/bin/npm"
    "/bin/npm"
  )

  if command -v npm >/dev/null 2>&1; then
    candidates+=("$(command -v npm)")
  fi
  for candidate in "${candidates[@]}"; do
    linux_node_runtime_path_is_trusted "$candidate" "$trust_mode" || continue
    resolved="$("$LINUX_NODE_RUNTIME_READLINK_BIN" -f -- "$candidate")"
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

linux_node_runtime_find_existing() {
  local minimum="$1"
  local trust_mode="$2"
  local candidate resolved npm_bin
  local -a candidates=()

  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  candidates+=("/usr/local/bin/node" "/usr/bin/node" "/bin/node")

  for candidate in "${candidates[@]}"; do
    linux_node_runtime_path_is_trusted "$candidate" "$trust_mode" || continue
    resolved="$("$LINUX_NODE_RUNTIME_READLINK_BIN" -f -- "$candidate")"
    linux_node_runtime_version_supported "$resolved" "$minimum" || continue
    npm_bin="$(linux_node_runtime_find_npm "$resolved" "$trust_mode")" || continue
    LINUX_NODE_BIN="$resolved"
    LINUX_NPM_BIN="$npm_bin"
    return 0
  done

  # Installer-managed runtimes are shared by both service modes, but must
  # always satisfy the stricter root trust boundary.
  for candidate in "$LINUX_NODE_RUNTIME_INSTALL_ROOT"/v*/bin/node; do
    linux_node_runtime_path_is_trusted "$candidate" root || continue
    resolved="$("$LINUX_NODE_RUNTIME_READLINK_BIN" -f -- "$candidate")"
    linux_node_runtime_version_supported "$resolved" "$minimum" || continue
    npm_bin="$(linux_node_runtime_find_npm "$resolved" root)" || continue
    LINUX_NODE_BIN="$resolved"
    LINUX_NPM_BIN="$npm_bin"
    return 0
  done
  return 1
}

linux_node_runtime_as_root() {
  if [[ "$EUID" -eq 0 ]]; then
    "$@"
  else
    [[ -n "${LINUX_NODE_RUNTIME_SUDO:-}" ]] || {
      linux_node_runtime_error "sudo is required to install Node.js"
      return 1
    }
    "$LINUX_NODE_RUNTIME_SUDO" "$@"
  fi
}

linux_node_runtime_download() {
  local url="$1"
  local destination="$2"
  local curl_bin wget_bin

  curl_bin="$(linux_node_runtime_command curl || true)"
  if [[ -n "$curl_bin" ]]; then
    "$curl_bin" --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --output "$destination" "$url"
    return
  fi
  wget_bin="$(linux_node_runtime_command wget || true)"
  if [[ -n "$wget_bin" ]]; then
    "$wget_bin" --https-only --secure-protocol=TLSv1_2 --quiet \
      --output-document="$destination" "$url"
    return
  fi
  linux_node_runtime_error "curl or wget is required to install Node.js"
  return 1
}

linux_node_runtime_ensure_download_tools() {
  local apt_bin

  if [[ -n "$(linux_node_runtime_command curl || true)$(linux_node_runtime_command wget || true)" ]] \
    && [[ -n "$(linux_node_runtime_command sha256sum || true)" ]] \
    && [[ -n "$(linux_node_runtime_command tar || true)" ]] \
    && [[ -n "$(linux_node_runtime_command xz || true)" ]]; then
    return 0
  fi
  apt_bin="$(linux_node_runtime_command apt-get || true)"
  [[ -n "$apt_bin" ]] || {
    linux_node_runtime_error "curl or wget, ca-certificates, sha256sum, tar, and xz are required"
    return 1
  }
  linux_node_runtime_log "Installing Node.js download prerequisites"
  linux_node_runtime_as_root "$apt_bin" update
  linux_node_runtime_as_root "$apt_bin" install -y ca-certificates curl xz-utils coreutils tar
}

linux_node_runtime_install() {
  local minimum="$1"
  local major version architecture archive_name base_url temp_dir archive sums expected actual
  local extract_dir final_dir staging_dir staging_error
  local sha_bin tar_bin mktemp_bin rm_bin

  linux_node_runtime_prepare_install_root || return 1
  linux_node_runtime_ensure_download_tools || return 1

  case "$("$LINUX_NODE_RUNTIME_UNAME_BIN" -m)" in
    x86_64 | amd64) architecture="x64" ;;
    aarch64 | arm64) architecture="arm64" ;;
    *)
      linux_node_runtime_error "Unsupported Linux architecture: $("$LINUX_NODE_RUNTIME_UNAME_BIN" -m)"
      return 1
      ;;
  esac

  sha_bin="$(linux_node_runtime_command sha256sum || true)"
  tar_bin="$(linux_node_runtime_command tar || true)"
  mktemp_bin="$(linux_node_runtime_command mktemp || true)"
  rm_bin="$(linux_node_runtime_command rm || true)"
  [[ -n "$sha_bin" && -n "$tar_bin" && -n "$mktemp_bin" && -n "$rm_bin" ]] || {
    linux_node_runtime_error "sha256sum, tar, mktemp, and rm are required to install Node.js"
    return 1
  }

  major="${minimum%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  base_url="https://nodejs.org/dist/latest-v${major}.x"
  temp_dir="$($mktemp_bin -d /tmp/cli-openai-proxy-node.XXXXXX)" || return 1
  sums="$temp_dir/SHASUMS256.txt"
  extract_dir="$temp_dir/extract"
  if ! "$LINUX_NODE_RUNTIME_MKDIR_BIN" -m 0700 "$extract_dir"; then
    linux_node_runtime_error "Failed to create the Node.js extraction directory"
    "$rm_bin" -rf -- "$temp_dir"
    return 1
  fi

  linux_node_runtime_log "Discovering the latest supported Node.js ${major}.x runtime"
  if ! linux_node_runtime_download "$base_url/SHASUMS256.txt" "$sums"; then
    "$rm_bin" -rf -- "$temp_dir"
    return 1
  fi
  archive_name="$("$LINUX_NODE_RUNTIME_AWK_BIN" -v suffix="linux-${architecture}.tar.xz" '
    index($2, "node-v") == 1 && substr($2, length($2) - length(suffix) + 1) == suffix {
      print $2;
      exit;
    }
  ' "$sums")"
  version="${archive_name#node-v}"
  version="${version%-linux-*}"
  if [[ -z "$archive_name" ]] || ! linux_node_runtime_version_string_supported "$version" "$minimum"; then
    linux_node_runtime_error "The latest Node.js ${major}.x archive does not meet minimum $minimum"
    "$rm_bin" -rf -- "$temp_dir"
    return 1
  fi
  archive="$temp_dir/$archive_name"
  linux_node_runtime_log "Downloading Node.js v${version} for linux-${architecture}"
  if ! linux_node_runtime_download "$base_url/$archive_name" "$archive"; then
    "$rm_bin" -rf -- "$temp_dir"
    return 1
  fi
  expected="$("$LINUX_NODE_RUNTIME_AWK_BIN" -v name="$archive_name" '$2 == name { print $1; exit }' "$sums")"
  actual="$($sha_bin "$archive" | "$LINUX_NODE_RUNTIME_AWK_BIN" '{ print $1 }')"
  if [[ -z "$expected" || "$actual" != "$expected" ]]; then
    linux_node_runtime_error "Node.js archive checksum verification failed"
    "$rm_bin" -rf -- "$temp_dir"
    return 1
  fi
  if ! "$tar_bin" -xJf "$archive" -C "$extract_dir" --strip-components=1; then
    linux_node_runtime_error "Failed to extract the Node.js archive"
    "$rm_bin" -rf -- "$temp_dir"
    return 1
  fi

  final_dir="$LINUX_NODE_RUNTIME_INSTALL_ROOT/v${version}"
  staging_dir="$LINUX_NODE_RUNTIME_INSTALL_ROOT/.v${version}.install.$$"
  if [[ ! -e "$final_dir" ]]; then
    staging_error=""
    if ! linux_node_runtime_as_root "$LINUX_NODE_RUNTIME_INSTALL_BIN" -d -o root -g root -m 0755 \
      "$staging_dir"; then
      staging_error="create the Node.js staging directory"
    elif ! linux_node_runtime_as_root "$LINUX_NODE_RUNTIME_CP_BIN" -a \
      "$extract_dir/." "$staging_dir/"; then
      staging_error="copy the Node.js runtime into staging"
    elif ! linux_node_runtime_as_root "$LINUX_NODE_RUNTIME_CHOWN_BIN" -R root:root "$staging_dir"; then
      staging_error="set Node.js staging ownership"
    elif ! linux_node_runtime_as_root "$LINUX_NODE_RUNTIME_CHMOD_BIN" -R go-w "$staging_dir"; then
      staging_error="remove write access from the Node.js staging tree"
    elif ! linux_node_runtime_as_root "$LINUX_NODE_RUNTIME_MV_BIN" "$staging_dir" "$final_dir"; then
      staging_error="publish the Node.js runtime"
    fi
    if [[ -n "$staging_error" ]]; then
      linux_node_runtime_error "Failed to $staging_error"
      linux_node_runtime_as_root "$rm_bin" -rf -- "$staging_dir" >/dev/null 2>&1 || true
      "$rm_bin" -rf -- "$temp_dir"
      return 1
    fi
  fi
  "$rm_bin" -rf -- "$temp_dir"

  LINUX_NODE_BIN="$("$LINUX_NODE_RUNTIME_READLINK_BIN" -f -- "$final_dir/bin/node")"
  LINUX_NPM_BIN="$("$LINUX_NODE_RUNTIME_READLINK_BIN" -f -- "$final_dir/bin/npm")"
  linux_node_runtime_path_is_trusted "$LINUX_NODE_BIN" root \
    && linux_node_runtime_path_is_trusted "$LINUX_NPM_BIN" root \
    && linux_node_runtime_version_supported "$LINUX_NODE_BIN" "$minimum" || {
      linux_node_runtime_error "Installed Node.js runtime failed trust or version validation"
      return 1
    }
}

linux_node_runtime_prepare() {
  local trust_mode="$1"
  local minimum="${2:-$LINUX_NODE_RUNTIME_DEFAULT_VERSION}"

  LINUX_NODE_RUNTIME_READLINK_BIN="$(linux_node_runtime_command readlink || true)"
  LINUX_NODE_RUNTIME_STAT_BIN="$(linux_node_runtime_command stat || true)"
  LINUX_NODE_RUNTIME_DIRNAME_BIN="$(linux_node_runtime_command dirname || true)"
  LINUX_NODE_RUNTIME_UNAME_BIN="$(linux_node_runtime_command uname || true)"
  LINUX_NODE_RUNTIME_MKDIR_BIN="$(linux_node_runtime_command mkdir || true)"
  LINUX_NODE_RUNTIME_AWK_BIN="$(linux_node_runtime_command awk || true)"
  LINUX_NODE_RUNTIME_INSTALL_BIN="$(linux_node_runtime_command install || true)"
  LINUX_NODE_RUNTIME_CP_BIN="$(linux_node_runtime_command cp || true)"
  LINUX_NODE_RUNTIME_CHOWN_BIN="$(linux_node_runtime_command chown || true)"
  LINUX_NODE_RUNTIME_CHMOD_BIN="$(linux_node_runtime_command chmod || true)"
  LINUX_NODE_RUNTIME_MV_BIN="$(linux_node_runtime_command mv || true)"
  [[ -n "$LINUX_NODE_RUNTIME_READLINK_BIN" && -n "$LINUX_NODE_RUNTIME_STAT_BIN" \
      && -n "$LINUX_NODE_RUNTIME_DIRNAME_BIN" && -n "$LINUX_NODE_RUNTIME_UNAME_BIN" \
      && -n "$LINUX_NODE_RUNTIME_MKDIR_BIN" && -n "$LINUX_NODE_RUNTIME_AWK_BIN" \
      && -n "$LINUX_NODE_RUNTIME_INSTALL_BIN" && -n "$LINUX_NODE_RUNTIME_CP_BIN" \
      && -n "$LINUX_NODE_RUNTIME_CHOWN_BIN" && -n "$LINUX_NODE_RUNTIME_CHMOD_BIN" \
      && -n "$LINUX_NODE_RUNTIME_MV_BIN" ]] || {
    linux_node_runtime_error "Required system utilities are missing"
    return 1
  }
  [[ "$trust_mode" == "service" || "$trust_mode" == "root" ]] || {
    linux_node_runtime_error "Trust mode must be 'service' or 'root'"
    return 1
  }
  if [[ "$trust_mode" == "root" ]]; then
    linux_node_runtime_prepare_install_root || return 1
  fi
  if linux_node_runtime_find_existing "$minimum" "$trust_mode"; then
    linux_node_runtime_log "Using trusted Node.js $($LINUX_NODE_BIN --version): $LINUX_NODE_BIN"
    return 0
  fi
  if [[ "$trust_mode" == "service" ]]; then
    linux_node_runtime_prepare_install_root || return 1
    if linux_node_runtime_find_existing "$minimum" "$trust_mode"; then
      linux_node_runtime_log "Using trusted Node.js $($LINUX_NODE_BIN --version): $LINUX_NODE_BIN"
      return 0
    fi
  fi
  linux_node_runtime_install "$minimum" || return 1
  linux_node_runtime_log "Installed trusted Node.js $($LINUX_NODE_BIN --version): $LINUX_NODE_BIN"
}
