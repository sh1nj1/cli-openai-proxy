import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const readScript = (name: string) =>
  readFile(new URL(`../../scripts/${name}`, import.meta.url), "utf8");

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
