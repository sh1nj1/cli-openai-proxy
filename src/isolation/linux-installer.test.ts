import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const readScript = (name: string) =>
  readFile(new URL(`../../scripts/${name}`, import.meta.url), "utf8");

const readUnit = (name: string) =>
  readFile(new URL(`../../deploy/linux/${name}`, import.meta.url), "utf8");

// The CLIs (claude/codex) are npm-global installs next to the trusted Node
// runtime; a unit PATH without that directory makes every spawn fail ENOENT.
test("Multi-mode units put the trusted Node runtime's bin directory on PATH", async () => {
  const [multi, worker, gateway] = await Promise.all([
    readScript("install-linux-user-workers.sh"),
    readUnit("cli-openai-proxy-worker@.service"),
    readUnit("cli-openai-proxy-gateway.service"),
  ]);

  const unitPath = /^Environment=PATH=@NODE_DIR@:@CLI_DIR@:\/usr\/local\/bin:\/usr\/bin:\/bin$/m;
  assert.match(worker, unitPath);
  assert.match(gateway, unitPath);
  assert.match(multi, /node_dir="\$\(dirname -- "\$NODE_BIN"\)"/);
  assert.match(multi, /s\|@NODE_DIR@\|\$\{node_dir\}\|g/);
  assert.match(multi, /s\|@CLI_DIR@\|\$\{CLI_ROOT\}\/bin\|g/);
});

test("Multi-user install stages engine CLIs unprivileged and freezes them under /opt", async () => {
  const [multi, firstBoot] = await Promise.all([
    readScript("install-linux-user-workers.sh"),
    readFile(new URL("../../deploy/docker/first-boot-install.sh", import.meta.url), "utf8"),
  ]);

  assert.match(multi, /INSTALL_CLIS="\$\{INSTALL_CLIS-@anthropic-ai\/claude-code @openai\/codex\}"/);
  assert.match(multi, /CLI_ROOT="\/opt\/cli-openai-proxy\/clis"/);
  const installClis = multi.indexOf(
    'run_npm_as_service install -g --prefix "$BUILD_ROOT/clis" $INSTALL_CLIS',
  );
  const freezeClis = multi.indexOf('chown -R root:root "$BUILD_ROOT/clis"');
  const validateClis = multi.indexOf('validate_relocatable_symlinks "$CLI_STAGING" "CLI"');
  const replaceClis = multi.indexOf('rm -rf -- "$CLI_ROOT"');
  const promoteClis = multi.indexOf('mv "$CLI_STAGING" "$CLI_ROOT"');
  // A rejected staging tree must never replace the known-good CLI_ROOT that
  // active workers already have on PATH: validate strictly before the swap.
  assert.ok(installClis >= 0 && installClis < freezeClis);
  assert.ok(validateClis >= 0 && freezeClis < validateClis);
  assert.ok(replaceClis >= 0 && validateClis < replaceClis && replaceClis < promoteClis);
  assert.match(multi, /normalize_release_permissions "\$BUILD_ROOT\/clis"/);
  assert.match(multi, /validate_relocatable_symlinks "\$RELEASE_STAGING" "runtime"/);
  assert.match(multi, /cleanup\(\)[\s\S]*\.clis\.install\.\*\) rm -rf -- "\$CLI_STAGING"/);
  // Containers install CLIs at image build time; boot must stay offline-safe.
  assert.match(firstBoot, /^INSTALL_CLIS="" \\$/m);
});

test("INSTALL_CLIS rejects anything that is not a bare npm package spec", () => {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/install-linux-user-workers.sh", import.meta.url),
  );
  const validate = (packages: string) => execFileSync("bash", ["-c", `
    source "$1"
    validate_cli_packages $2
  `, "bash", scriptPath, packages], { stdio: "pipe" });

  validate("@anthropic-ai/claude-code @openai/codex");
  validate("codex@0.42.0");
  for (const invalid of ["--registry=https://evil.example", "-g", "../etc", "a;b", "@scope/"]) {
    assert.throws(() => validate(invalid), Error, `accepted: ${invalid}`);
  }
});

test("Staged tree symlink validation only accepts links that survive relocation", () => {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/install-linux-user-workers.sh", import.meta.url),
  );
  const validate = (setup: string) => execFileSync("bash", ["-c", `
    set -euo pipefail
    source "$1"
    # Canonicalize: on macOS mktemp returns a path under the /var symlink.
    root="$(cd "$(mktemp -d)" && pwd -P)"
    trap 'rm -rf -- "$root"' EXIT
    mkdir -p "$root/bin" "$root/lib"
    echo target > "$root/lib/real"
    eval "$2"
    validate_relocatable_symlinks "$root" "CLI"
  `, "bash", scriptPath, setup], { stdio: "pipe" });

  // Relative in-tree links relocate with the mv and stay valid.
  validate('ln -s ../lib/real "$root/bin/ok"');
  // Absolute links keep pointing at the deleted staging path after promotion.
  assert.throws(() => validate('ln -s "$root/lib/real" "$root/bin/abs"'), /absolute CLI symlink/);
  assert.throws(() => validate('ln -s /etc/passwd "$root/bin/escape"'), /absolute CLI symlink/);
  assert.throws(() => validate('ln -s ../.. "$root/bin/out"'), /outside the frozen tree/);
  // readlink -f tolerates a missing final component; a missing intermediate
  // directory is what makes resolution itself fail.
  assert.throws(() => validate('ln -s ../missing-dir/bin/x "$root/bin/gone"'), /dangling CLI symlink/);
});

test("Single-user install provisions engine CLIs into a managed prefix on the service PATH", async () => {
  const single = await readScript("install-linux-single-user.sh");

  assert.match(single, /INSTALL_CLIS="\$\{INSTALL_CLIS-@anthropic-ai\/claude-code @openai\/codex\}"/);
  assert.match(single, /INSTALL_CLIS entries must be plain npm package names/);
  const installClis = single.indexOf('run_npm install -g "--prefix=$CLI_PREFIX" $INSTALL_CLIS');
  const appendPath = single.indexOf('append_service_path "$CLI_PREFIX/bin"');
  const writeUnit = single.indexOf('"PATH=$SERVICE_PATH"');
  assert.ok(installClis >= 0 && installClis < appendPath);
  assert.ok(appendPath < single.indexOf("validate_service_cli_resolution claude"));
  assert.ok(writeUnit >= 0 && appendPath < writeUnit);
});

test("Linux installers share one minimum Node.js runtime policy", async () => {
  const [runtime, single, multi] = await Promise.all([
    readScript("linux-node-runtime.sh"),
    readScript("install-linux-single-user.sh"),
    readScript("install-linux-user-workers.sh"),
  ]);

  assert.match(runtime, /LINUX_NODE_RUNTIME_DEFAULT_VERSION="22\.13\.0"/);
  assert.match(runtime, /linux_node_runtime_find_existing "\$minimum" "\$trust_mode"/);
  assert.match(runtime, /linux_node_runtime_install "\$minimum"/);
  assert.match(runtime, /SHASUMS256\.txt/);
  assert.match(single, /source "\$NODE_RUNTIME_SCRIPT"/);
  assert.match(single, /linux_node_runtime_prepare service "\$MIN_NODE_VERSION"/);
  assert.match(multi, /source "\$NODE_RUNTIME_SCRIPT"/);
  assert.match(multi, /linux_node_runtime_prepare root "\$MIN_NODE_VERSION"/);
});

test("Node runtime preparation propagates an installation validation failure", () => {
  const runtimePath = fileURLToPath(
    new URL("../../scripts/linux-node-runtime.sh", import.meta.url),
  );
  assert.throws(() => execFileSync("bash", ["-c", `
    source "$1"
    linux_node_runtime_find_existing() { return 1; }
    linux_node_runtime_prepare_install_root() { return 0; }
    linux_node_runtime_install() { return 1; }
    linux_node_runtime_prepare root 22.13.0
  `, "bash", runtimePath], { stdio: "pipe" }));
});

test("Node runtime preparation reuses an installer-managed runtime", () => {
  const runtimePath = fileURLToPath(
    new URL("../../scripts/linux-node-runtime.sh", import.meta.url),
  );
  const selected = execFileSync("bash", ["-c", `
    set -e
    source "$1"
    runtime_root="$(mktemp -d)"
    trap 'rm -rf -- "$runtime_root"' EXIT
    mkdir -p "$runtime_root/v22.13.0/bin"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$runtime_root/v22.13.0/bin/node"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$runtime_root/v22.13.0/bin/npm"
    chmod 0755 "$runtime_root/v22.13.0/bin/node" "$runtime_root/v22.13.0/bin/npm"

    LINUX_NODE_RUNTIME_INSTALL_ROOT="$runtime_root"
    LINUX_NODE_RUNTIME_READLINK_BIN="$(command -v readlink)"
    LINUX_NODE_RUNTIME_DIRNAME_BIN="$(command -v dirname)"
    resolved_root="$(readlink -f -- "$runtime_root")"
    linux_node_runtime_path_is_trusted() {
      [[ "$2" == root ]] && { [[ "$1" == "$runtime_root"/* ]] || [[ "$1" == "$resolved_root"/* ]]; }
    }
    linux_node_runtime_version_supported() { return 0; }

    linux_node_runtime_find_existing 22.13.0 service
    printf '%s\\n%s\\n' "$LINUX_NODE_BIN" "$LINUX_NPM_BIN"
  `, "bash", runtimePath], { encoding: "utf8" });

  assert.match(selected, /\/v22\.13\.0\/bin\/node\n.*\/v22\.13\.0\/bin\/npm\n$/s);
});

test("Root-trusted Node runtimes must be usable by unprivileged accounts", () => {
  const runtimePath = fileURLToPath(
    new URL("../../scripts/linux-node-runtime.sh", import.meta.url),
  );
  execFileSync("bash", ["-c", `
    set -e
    source "$1"
    scratch="$(mktemp -d)"
    trap 'rm -rf -- "$scratch"' EXIT
    runtime_root="$scratch/private/v22.13.0"
    mkdir -p "$runtime_root/bin"
    private_root="$(readlink -f -- "$scratch/private")"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$runtime_root/bin/node"
    chmod 0755 "$runtime_root/bin/node"

    LINUX_NODE_RUNTIME_READLINK_BIN="$(command -v readlink)"
    LINUX_NODE_RUNTIME_DIRNAME_BIN="$(command -v dirname)"
    fake_stat() {
      case "\${*: -1}" in
	"$private_root") printf '0 700\\n' ;;
	*) printf '0 755\\n' ;;
      esac
    }
    LINUX_NODE_RUNTIME_STAT_BIN=fake_stat

    if linux_node_runtime_path_is_trusted "$runtime_root/bin/node" root; then
      exit 9
    fi
    fake_stat() { printf '0 755\\n'; }
    linux_node_runtime_path_is_trusted "$runtime_root/bin/node" root
  `, "bash", runtimePath], { stdio: "pipe" });
});

test("Managed Node runtime parents are made traversable without trusting writable paths", () => {
  const runtimePath = fileURLToPath(
    new URL("../../scripts/linux-node-runtime.sh", import.meta.url),
  );
  execFileSync("bash", ["-c", `
    set -e
    source "$1"
    scratch="$(mktemp -d)"
    trap 'rm -rf -- "$scratch"' EXIT
    install_parent="$scratch/managed"
    LINUX_NODE_RUNTIME_INSTALL_ROOT="$install_parent/node"
    mkdir -p "$LINUX_NODE_RUNTIME_INSTALL_ROOT"
    LINUX_NODE_RUNTIME_DIRNAME_BIN="$(command -v dirname)"
    LINUX_NODE_RUNTIME_INSTALL_BIN=fake_install
    parent_mode=700
    child_owner=0
    install_called=0
    fake_stat() {
      case "\${*: -1}" in
	"$install_parent") printf '0 %s\\n' "$parent_mode" ;;
	*) printf '%s 755\\n' "$child_owner" ;;
      esac
    }
    fake_install() {
      [[ "$1" == -d && "$2" == -o && "$3" == root
	&& "$4" == -g && "$5" == root && "$6" == -m && "$7" == 0755 ]] || exit 8
      install_called=$((install_called + 1))
      if [[ "$install_called" == 1 ]]; then
	[[ "$8" == "$install_parent" && "$#" == 8 ]] || exit 8
      else
	[[ "$8" == "$LINUX_NODE_RUNTIME_INSTALL_ROOT" && "$#" == 8 ]] || exit 8
      fi
    }
    linux_node_runtime_as_root() { "$@"; }
    LINUX_NODE_RUNTIME_STAT_BIN=fake_stat

    linux_node_runtime_prepare_install_root
    [[ "$install_called" == 2 ]]

    parent_mode=770
    install_called=0
    if linux_node_runtime_prepare_install_root; then
      exit 9
    fi
    [[ "$install_called" == 0 ]]

    parent_mode=700
    child_owner=501
    install_called=0
    if linux_node_runtime_prepare_install_root; then
      exit 10
    fi
    [[ "$install_called" == 1 ]]

    child_owner=0
    install_called=0
    rm -rf -- "$LINUX_NODE_RUNTIME_INSTALL_ROOT"
    ln -s "$scratch" "$LINUX_NODE_RUNTIME_INSTALL_ROOT"
    if linux_node_runtime_prepare_install_root; then
      exit 11
    fi
    [[ "$install_called" == 1 ]]
  `, "bash", runtimePath], { stdio: "pipe" });
});

test("Managed Node runtime version directories are safely made traversable", () => {
  const runtimePath = fileURLToPath(
    new URL("../../scripts/linux-node-runtime.sh", import.meta.url),
  );
  execFileSync("bash", ["-c", `
    set -e
    source "$1"
    scratch="$(mktemp -d)"
    trap 'rm -rf -- "$scratch"' EXIT
    runtime_dir="$scratch/v22.23.2"
    mkdir -m 0700 "$runtime_dir"
    LINUX_NODE_RUNTIME_CHMOD_BIN=fake_chmod
    chmod_calls=0
    fake_stat() { printf '0 700\\n'; }
    fake_chmod() {
      [[ "$1" == 0755 && "$2" == "$runtime_dir" && "$#" == 2 ]] || exit 8
      chmod_calls=$((chmod_calls + 1))
    }
    linux_node_runtime_as_root() { "$@"; }
    LINUX_NODE_RUNTIME_STAT_BIN=fake_stat

    linux_node_runtime_make_install_directory_traversable "$runtime_dir"
    [[ "$chmod_calls" == 1 ]]

    fake_stat() { printf '501 700\\n'; }
    if linux_node_runtime_make_install_directory_traversable "$runtime_dir"; then
      exit 9
    fi
    [[ "$chmod_calls" == 1 ]]

    mv "$runtime_dir" "$scratch/target"
    ln -s "$scratch/target" "$runtime_dir"
    fake_stat() { printf '0 700\\n'; }
    if linux_node_runtime_make_install_directory_traversable "$runtime_dir"; then
      exit 10
    fi
    [[ "$chmod_calls" == 1 ]]
  `, "bash", runtimePath], { stdio: "pipe" });
});

test("Node runtime preparation repairs roots before root-mode reuse and retries service-mode reuse", () => {
  const runtimePath = fileURLToPath(
    new URL("../../scripts/linux-node-runtime.sh", import.meta.url),
  );
  execFileSync("bash", ["-c", `
    set -e
    source "$1"
    linux_node_runtime_log() { :; }
    linux_node_runtime_install() { exit 9; }

    events=""
    linux_node_runtime_prepare_install_root() { events="\${events}prepare "; }
    linux_node_runtime_find_existing() {
      events="\${events}find "
      LINUX_NODE_BIN=/bin/true
      LINUX_NPM_BIN=/bin/true
    }
    linux_node_runtime_prepare root 22.13.0
    [[ "$events" == "prepare find " ]]

    events=""
    find_calls=0
    linux_node_runtime_find_existing() {
      events="\${events}find "
      find_calls=$((find_calls + 1))
      [[ "$find_calls" == 2 ]] || return 1
      LINUX_NODE_BIN=/bin/true
      LINUX_NPM_BIN=/bin/true
    }
    linux_node_runtime_prepare service 22.13.0
    [[ "$events" == "find prepare find " ]]
  `, "bash", runtimePath], { stdio: "pipe" });
});

test("Node runtime installation never promotes failed extraction or staging", () => {
  const runtimePath = fileURLToPath(
    new URL("../../scripts/linux-node-runtime.sh", import.meta.url),
  );
  execFileSync("bash", ["-c", `
    source "$1"
    scratch="$(mktemp -d)"
    trap 'rm -rf -- "$scratch"' EXIT
    runtime_root="$scratch/runtime"
    marker="$scratch/mv-called"
    printf '#!/usr/bin/env bash\\nprintf x86_64\\n' > "$scratch/uname"
    printf '#!/usr/bin/env bash\\n[[ "$FAIL_EXTRACT" == 1 ]] && exit 1\\nexit 0\\n' > "$scratch/tar"
    chmod 0755 "$scratch/uname" "$scratch/tar"

    LINUX_NODE_RUNTIME_INSTALL_ROOT="$runtime_root"
    LINUX_NODE_RUNTIME_UNAME_BIN="$scratch/uname"
    LINUX_NODE_RUNTIME_MKDIR_BIN="$(command -v mkdir)"
    LINUX_NODE_RUNTIME_AWK_BIN="$(command -v awk)"
    LINUX_NODE_RUNTIME_INSTALL_BIN="$(command -v install)"
    LINUX_NODE_RUNTIME_CP_BIN="$(command -v cp)"
    LINUX_NODE_RUNTIME_CHOWN_BIN="$(command -v chown)"
    LINUX_NODE_RUNTIME_CHMOD_BIN="$(command -v chmod)"
    LINUX_NODE_RUNTIME_MV_BIN="$(command -v mv)"
    LINUX_NODE_RUNTIME_READLINK_BIN="$(command -v readlink)"

    linux_node_runtime_ensure_download_tools() { return 0; }
    linux_node_runtime_prepare_install_root() { return 0; }
    linux_node_runtime_command() {
      case "$1" in
      tar) printf '%s\\n' "$scratch/tar" ;;
      *) command -v "$1" ;;
      esac
    }
    linux_node_runtime_download() {
      if [[ "$1" == */SHASUMS256.txt ]]; then
      checksum="$(printf archive | sha256sum | awk '{ print $1 }')"
      printf '%s  node-v22.13.0-linux-x64.tar.xz\\n' "$checksum" > "$2"
      else
      printf archive > "$2"
      fi
    }
    linux_node_runtime_as_root() {
      command_path="$1"
      shift
      if [[ "$command_path" == "$LINUX_NODE_RUNTIME_INSTALL_BIN" ]]; then
      for argument in "$@"; do
      [[ "$argument" == "$runtime_root"* ]] && mkdir -p "$argument"
      done
      return 0
      fi
      if [[ "$command_path" == "$LINUX_NODE_RUNTIME_CP_BIN" ]]; then
      return 1
      fi
      if [[ "$command_path" == "$LINUX_NODE_RUNTIME_MV_BIN" ]]; then
      touch "$marker"
      fi
      "$command_path" "$@"
    }

    if FAIL_EXTRACT=1 linux_node_runtime_install 22.13.0; then
      exit 9
    fi
    [[ ! -e "$marker" ]]
    [[ ! -e "$runtime_root/v22.13.0" ]]

    if linux_node_runtime_install 22.13.0; then
      exit 10
    fi
    [[ ! -e "$marker" ]]
    [[ ! -e "$runtime_root/v22.13.0" ]]
  `, "bash", runtimePath], { stdio: "pipe" });
});

test("Node runtime installation fixes fresh and existing version directory access", async () => {
  const script = await readScript("linux-node-runtime.sh");
  const copy = script.indexOf('"$extract_dir/." "$staging_dir/"');
  const removeWrites = script.indexOf('"$LINUX_NODE_RUNTIME_CHMOD_BIN" -R go-w "$staging_dir"');
  const makeTraversable = script.indexOf(
    'linux_node_runtime_make_install_directory_traversable "$staging_dir"',
  );
  const publish = script.indexOf('"$LINUX_NODE_RUNTIME_MV_BIN" "$staging_dir" "$final_dir"');

  assert.ok(copy >= 0 && copy < removeWrites);
  assert.ok(removeWrites < makeTraversable && makeTraversable < publish);
  assert.match(
    script,
    /elif ! linux_node_runtime_make_install_directory_traversable "\$final_dir"/,
  );
  assert.match(script, /\[\[ ! -e "\$final_dir" && ! -L "\$final_dir" \]\]/);
});

test("Multi-user install builds as an unprivileged account before promotion", async () => {
  const script = await readScript("install-linux-user-workers.sh");
  const installDependencies = script.indexOf("run_npm_as_service ci");
  const build = script.indexOf("run_npm_as_service run build");
  const prune = script.indexOf("run_npm_as_service prune --omit=dev");
  const freeze = script.indexOf('chown -R root:root "$BUILD_ROOT"');
  const validate = script.indexOf("validate_build\n");
  const promote = script.indexOf("promote_release\n");

  assert.match(script, /runuser -u "\$BUILD_ACCOUNT" -- env -i/);
  assert.ok(installDependencies >= 0 && installDependencies < build);
  assert.ok(build < prune && prune < freeze);
  assert.match(script, /Missing runtime dependency: \$\{dependency\}/);
  assert.doesNotMatch(script, /await import\("express"\)/);
  assert.match(script, /terminate_build_processes/);
  assert.match(script, /cleanup\(\)[\s\S]*kill_build_processes[\s\S]*BUILD_ROOT/);
  assert.match(script, /ensure_build_account\s+[^]*terminate_build_processes\s+BUILD_ROOT=/);
  assert.ok(validate >= 0 && validate < promote);
});

test("Multi-user releases are readable by service accounts after a private build", () => {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/install-linux-user-workers.sh", import.meta.url),
  );
  execFileSync("bash", ["-c", `
    set -e
    source "$1"
    scratch="$(mktemp -d)"
    trap 'rm -rf -- "$scratch"' EXIT
    release="$scratch/release"
    outside="$scratch/outside"
    mkdir -m 0700 -p "$release/dist/server" "$release/node_modules/example/bin"
    printf 'server\n' > "$release/dist/server/standalone.js"
    printf '#!/bin/sh\n' > "$release/node_modules/example/bin/tool"
    printf 'outside\n' > "$outside"
    chmod 0600 "$release/dist/server/standalone.js" "$outside"
    chmod 0700 "$release/node_modules/example/bin/tool"
    ln -s "$outside" "$release/node_modules/example/outside"
    mode() {
      if [[ "$(uname -s)" == Darwin ]]; then
	stat -f %Lp "$1"
      else
	stat -c %a "$1"
      fi
    }

    normalize_release_permissions "$release"

    [[ "$(mode "$release/dist/server")" == 755 ]]
    [[ "$(mode "$release/dist/server/standalone.js")" == 644 ]]
    [[ "$(mode "$release/node_modules/example/bin/tool")" == 755 ]]
    [[ "$(mode "$outside")" == 600 ]]
  `, "bash", scriptPath], { stdio: "pipe" });
});

test("Multi-user release promotion rejects special files", () => {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/install-linux-user-workers.sh", import.meta.url),
  );
  assert.throws(() => execFileSync("bash", ["-c", `
    source "$1"
    scratch="$(mktemp -d)"
    trap 'rm -rf -- "$scratch"' EXIT
    mkfifo "$scratch/untrusted-fifo"
    normalize_release_permissions "$scratch"
  `, "bash", scriptPath], { stdio: "pipe" }));
});

test("Multi-user install isolates and retires an invocation-scoped build account", () => {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/install-linux-user-workers.sh", import.meta.url),
  );
  execFileSync("bash", ["-c", `
source "$1"
existing="\${BUILD_ACCOUNT_PREFIX}00112233-1"
selected="\${BUILD_ACCOUNT_PREFIX}00112233-2"
group_created=0
user_created=0
user_retired=0
group_retired=0
od() { printf ' 00 11 22 33 44 55\\n'; }
getent() {
  case "$1" in
    group)
      if [[ "$2" == "$existing" ]]; then
      printf '%s:x:400:\\n' "$existing"
      elif [[ "$2" == "$selected" && "$group_created" == 1 ]]; then
      printf '%s:x:456:\\n' "$selected"
      else
      return 2
      fi
      ;;
    passwd)
      if [[ $# == 1 ]]; then
      [[ "$user_created" == 0 ]] || printf '%s:x:123:456::/nonexistent:/usr/sbin/nologin\\n' "$selected"
      printf 'unrelated:x:999:999::/nonexistent:/usr/sbin/nologin\\n'
      elif [[ "$2" == "$selected" && "$user_created" == 1 ]]; then
      printf '%s:x:123:456::/nonexistent:/usr/sbin/nologin\\n' "$selected"
      else
      return 2
      fi
      ;;
    shadow)
      [[ "$2" == "$selected" && "$user_created" == 1 ]] || return 2
      printf '%s:!locked:1:0:99999:7::::\\n' "$selected"
      ;;
  esac
}
id() {
  [[ "$user_created" == 1 && "\${*: -1}" == "$selected" ]] || return 1
  case "$1" in
    -u) printf '123\\n' ;;
    -g|-G) printf '456\\n' ;;
    *) return 0 ;;
  esac
}
groupadd() {
  [[ "\${*: -1}" == "$selected" ]]
  group_created=1
}
useradd() {
  [[ "\${*: -1}" == "$selected" ]]
  user_created=1
}
usermod() { [[ "\${*: -1}" == "$selected" ]]; }
kill_build_processes() { return 0; }
userdel() {
  [[ "$1" == "$selected" ]]
  user_created=0
  group_created=0
  user_retired=1
}
groupdel() { [[ "$1" == "$selected" ]]; group_created=0; group_retired=1; }

ensure_build_account
[[ "$BUILD_ACCOUNT" == "$selected" && "$BUILD_ACCOUNT" != "$existing" ]]
retire_build_account
[[ "$user_retired" == 1 && "$group_retired" == 0 ]]
[[ "$BUILD_ACCOUNT_CREATED" == 0 && "$BUILD_GROUP_CREATED" == 0 ]]
  `, "bash", scriptPath], { stdio: "pipe" });

  return readScript("install-linux-user-workers.sh").then((script) => {
    assert.match(script, /flock --nonblock 9/);
    assert.match(script, /matching_uid_count/);
    assert.match(script, /retire_build_account/);
  });
});

test("Multi-user runtime and services use only a root-owned Node copy", async () => {
  const script = await readScript("install-linux-user-workers.sh");

  assert.match(script, /linux_node_runtime_prepare root/);
  assert.match(
    script,
    /install -o root -g root -m 0755 "\$NODE_BIN" "\$RELEASE_STAGING\/bin\/node"/,
  );
  assert.match(script, /linux_node_runtime_path_is_trusted "\$RELEASE_STAGING\/bin\/node" root/);
  assert.match(script, /s\|@NODE@\|\$\{RUNTIME_NODE\}\|g/);
});

test("Multi-user config creates separate keys and preserves them unless rotation is explicit", async () => {
  const script = await readScript("install-linux-user-workers.sh");

  assert.match(script, /ROTATE_KEYS="\$\{INSTALL_ROTATE_KEYS:-0\}"/);
  assert.match(script, /GENERATED_USER_KEY="\$\(random_key user\)"/);
  assert.match(script, /GENERATED_ADMIN_KEY="\$\(random_key admin\)"/);
  assert.match(script, /rotate_user_mappings/);
  assert.match(script, /return \{ \.\.\.mapping, key:/);
  assert.match(script, /GENERATED_USER_MAPPINGS=.*tenantId.*userId/);
  assert.match(script, /Keeping existing gateway keys and configuration/);
  assert.match(script, /chmod 0640 "\$GATEWAY_ENV"/);
});

test("USER_API_KEYS rotation preserves every tenant/user mapping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linux-installer-keys-"));
  const environmentFile = join(directory, "gateway.env");
  const scriptPath = fileURLToPath(
    new URL("../../scripts/install-linux-user-workers.sh", import.meta.url),
  );
  const original = [
    { key: "old-key-a", tenantId: "tenant-a", userId: "user-a" },
    { key: "old-key-b", tenantId: "tenant-b", userId: "user-b" },
  ];
  await writeFile(environmentFile, `USER_API_KEYS='${JSON.stringify(original)}'\n`);

  try {
    const output = execFileSync("bash", ["-c", `
      source "$1"
      NODE_BIN="$2"
      GATEWAY_ENV="$3"
      rotate_user_mappings
    `, "bash", scriptPath, process.execPath, environmentFile], { encoding: "utf8" });
    const rotated = JSON.parse(output) as typeof original;
    assert.deepEqual(
      rotated.map(({ tenantId, userId }) => ({ tenantId, userId })),
      original.map(({ tenantId, userId }) => ({ tenantId, userId })),
    );
    assert.equal(new Set(rotated.map(({ key }) => key)).size, original.length);
    for (let index = 0; index < rotated.length; index += 1) {
      assert.notEqual(rotated[index].key, original[index].key);
      assert.match(rotated[index].key, /^cop_user_[0-9a-f]{64}$/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gateway config recognizes indentation and rotates the last effective mapping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linux-installer-env-"));
  const environmentFile = join(directory, "gateway.env");
  const scriptPath = fileURLToPath(
    new URL("../../scripts/install-linux-user-workers.sh", import.meta.url),
  );
  const stale = [{ key: "stale-key", tenantId: "stale-tenant", userId: "stale-user" }];
  const active = [{ key: "active-key", tenantId: "active-tenant", userId: "active-user" }];
  const original = [
    `  USER_API_KEYS='${JSON.stringify(stale)}'`,
    `\tUSER_API_KEYS='${JSON.stringify(active)}'`,
    "  AUTH_ADMIN_KEYS=old-admin-key",
    "\tPORT=3457",
    "  HOST=127.0.0.1",
    "",
  ].join("\n");
  await writeFile(environmentFile, original);

  try {
    const preserved = execFileSync("bash", ["-c", `
      source "$1"
      NODE_BIN="$2"
      CONFIG_DIR="$3"
      GATEWAY_ENV="$4"
      SERVICE_ACCOUNT=test-service
      ROTATE_KEYS=0
      stat() { [[ "$2" == %u ]] && printf '0\\n' || printf '640\\n'; }
      chown() { :; }
      chmod() { :; }
      prepare_gateway_config >/dev/null
      cat "$GATEWAY_ENV"
    `, "bash", scriptPath, process.execPath, directory, environmentFile], { encoding: "utf8" });
    assert.equal(preserved, original);

    execFileSync("bash", ["-c", `
      source "$1"
      NODE_BIN="$2"
      CONFIG_DIR="$3"
      GATEWAY_ENV="$4"
      SERVICE_ACCOUNT=test-service
      ROTATE_KEYS=1
      stat() { [[ "$2" == %u ]] && printf '0\\n' || printf '640\\n'; }
      install() {
	local source="" destination="" current=""
	for current in "$@"; do source="$destination"; destination="$current"; done
	cp "$source" "$destination"
      }
      chown() { :; }
      chmod() { :; }
      prepare_gateway_config >/dev/null
    `, "bash", scriptPath, process.execPath, directory, environmentFile], { stdio: "pipe" });

    const rotatedLines = (await readFile(environmentFile, "utf8")).trim().split(/\r?\n/);
    const userAssignments = rotatedLines.filter((line) => /^\s*USER_API_KEYS=/.test(line));
    const adminAssignments = rotatedLines.filter((line) => /^\s*AUTH_ADMIN_KEYS=/.test(line));
    assert.equal(userAssignments.length, 1);
    assert.equal(adminAssignments.length, 1);
    assert.equal(rotatedLines.filter((line) => /^\s*PORT=/.test(line)).length, 1);
    assert.equal(rotatedLines.filter((line) => /^\s*HOST=/.test(line)).length, 1);
    const rotated = JSON.parse(userAssignments[0].slice("USER_API_KEYS=".length + 1, -1)) as typeof active;
    assert.deepEqual(
      rotated.map(({ tenantId, userId }) => ({ tenantId, userId })),
      active.map(({ tenantId, userId }) => ({ tenantId, userId })),
    );
    assert.match(rotated[0].key, /^cop_user_[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Multi-user conversion disables the conflicting Single service and verifies both services", async () => {
  const script = await readScript("install-linux-user-workers.sh");
  const stopSingle = script.lastIndexOf("stop_single_user_service\n");
  const installUnits = script.lastIndexOf("install_units\n");
  const startServices = script.lastIndexOf("start_and_verify_services\n");

  assert.match(script, /disable --now "\$SINGLE_SERVICE_NAME\.service"/);
  assert.ok(stopSingle >= 0 && stopSingle < installUnits && installUnits < startServices);
  assert.match(script, /systemctl is-active --quiet cli-openai-proxy-provisioner\.service/);
  assert.match(script, /systemctl is-active --quiet cli-openai-proxy-gateway\.service/);
  assert.match(script, /health_check "\$probe_host" "\$EFFECTIVE_PORT"/);
  assert.match(script, /Run Codex device login and agent provisioning again for each mapped user/);
});

test("Multi-user readiness probes the effective gateway listener", async () => {
  const script = await readScript("install-linux-user-workers.sh");

  assert.match(script, /read_effective_listener\(\)[\s\S]*\/proc\/\$pid\/environ/);
  assert.match(script, /HOST=\*\)[\s\S]*EFFECTIVE_HOST/);
  assert.match(script, /PORT=\*\)[\s\S]*EFFECTIVE_PORT/);
  assert.match(script, /health_check "\$probe_host" "\$EFFECTIVE_PORT"/);
  assert.match(script, /listener_belongs_to_pid "\$main_pid" "\$EFFECTIVE_PORT"/);
  assert.doesNotMatch(script, /http\.get\(\{ hostname: "127\.0\.0\.1", port: 3456/);
});

test("container first-boot restarts a previously active gateway without a seed", async () => {
  const script = await readFile(
    new URL("../../deploy/docker/first-boot-install.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /GATEWAY_WAS_ACTIVE=0/);
  assert.match(script, /systemctl is-active --quiet cli-openai-proxy-gateway\.service/);
  assert.match(
    script,
    /No seed mounted[\s\S]*GATEWAY_WAS_ACTIVE[\s\S]*systemctl restart --no-block cli-openai-proxy-gateway\.service/,
  );
  const invalidSeed = script.indexOf('if [[ -L "${SEED}"');
  const stopGateway = script.indexOf(
    "systemctl stop cli-openai-proxy-gateway.service",
    invalidSeed,
  );
  const rejectSeed = script.indexOf("seed gateway.env is not a regular file", invalidSeed);
  assert.ok(invalidSeed >= 0 && invalidSeed < stopGateway && stopGateway < rejectSeed);
});

test("Linux runtime socket directories remain traversable after reboot", async () => {
  const [script, tmpfiles] = await Promise.all([
    readScript("install-linux-user-workers.sh"),
    readFile(new URL("../../deploy/linux/cli-openai-proxy-tmpfiles.conf", import.meta.url), "utf8"),
  ]);

  assert.match(tmpfiles, /^d \/run\/cli-openai-proxy 0750 root cli-openai-proxy -$/m);
  assert.match(tmpfiles, /^d \/run\/cli-openai-proxy\/workers 0750 root cli-openai-proxy -$/m);
  const createDirectories = script.indexOf("systemd-tmpfiles --create");
  const enableSocket = script.indexOf("systemctl enable --now cli-openai-proxy-provisioner.socket");
  assert.ok(createDirectories >= 0 && createDirectories < enableSocket);
});

test("Linux immutable releases include the auth UI runtime asset", async () => {
  const script = await readScript("install-linux-user-workers.sh");
  assert.match(script, /Validated build is missing tools\/auth-test\.html/);
  assert.match(script, /"\$RELEASE_STAGING\/tools\/auth-test\.html"/);
});
