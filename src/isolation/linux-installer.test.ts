import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Linux installer restarts active services after replacing their runtime", async () => {
  const script = await readFile(new URL("../../scripts/install-linux-user-workers.sh", import.meta.url), "utf8");
  assert.match(
    script,
    /systemctl is-active --quiet cli-openai-proxy-provisioner\.service; then\s+systemctl restart cli-openai-proxy-provisioner\.service/,
  );
  assert.match(
    script,
    /systemctl is-active --quiet cli-openai-proxy-gateway\.service; then\s+GATEWAY_WAS_ACTIVE=true\s+systemctl stop cli-openai-proxy-gateway\.service/,
  );
  assert.match(
    script,
    /'cli-openai-proxy-worker@\*\.service' \|\s+while read -r worker_unit _; do\s+if \[\[ -n "\$\{worker_unit\}" \]\]; then\s+systemctl restart "\$\{worker_unit\}"/,
  );
  assert.match(
    script,
    /if \[\[ "\$\{GATEWAY_WAS_ACTIVE\}" == true \]\]; then\s+systemctl start cli-openai-proxy-gateway\.service/,
  );
  assert.doesNotMatch(script, /systemctl enable --now cli-openai-proxy-gateway\.service/);

  const stopGateway = script.indexOf("systemctl stop cli-openai-proxy-gateway.service");
  const restartWorkers = script.indexOf('systemctl restart "${worker_unit}"');
  const restartProvisioner = script.indexOf("systemctl restart cli-openai-proxy-provisioner.service");
  const startGateway = script.indexOf("systemctl start cli-openai-proxy-gateway.service");
  assert.ok(stopGateway >= 0 && stopGateway < restartWorkers);
  assert.ok(restartWorkers < restartProvisioner);
  assert.ok(restartProvisioner < startGateway);
});

test("Linux runtime socket directories remain traversable after reboot", async () => {
  const script = await readFile(new URL("../../scripts/install-linux-user-workers.sh", import.meta.url), "utf8");
  const tmpfiles = await readFile(
    new URL("../../deploy/linux/cli-openai-proxy-tmpfiles.conf", import.meta.url),
    "utf8",
  );
  assert.match(tmpfiles, /^d \/run\/cli-openai-proxy 0750 root cli-openai-proxy -$/m);
  assert.match(tmpfiles, /^d \/run\/cli-openai-proxy\/workers 0750 root cli-openai-proxy -$/m);
  const createDirectories = script.indexOf("systemd-tmpfiles --create");
  const enableSocket = script.indexOf("systemctl enable --now cli-openai-proxy-provisioner.socket");
  assert.ok(createDirectories >= 0 && createDirectories < enableSocket);
});

test("Linux installer protects the privileged Node executable path", async () => {
  const script = await readFile(new URL("../../scripts/install-linux-user-workers.sh", import.meta.url), "utf8");
  assert.match(
    script,
    /for component in "\$\{components\[@\]\}"; do[\s\S]*stat -Lc '%u' -- "\$\{current\}"[\s\S]*8#\$\{mode\} & 8#022/,
  );
  assert.match(script, /validate_privileged_path "\$\{NODE_PATH\}"/);
  assert.match(
    script,
    /install -o root -g root -m 0755 "\$\{NODE_PATH\}" "\$\{RUNTIME_NODE\}"/,
  );
  assert.match(script, /validate_privileged_path "\$\{RUNTIME_NODE\}"/);
  assert.match(script, /s\|@NODE@\|\$\{RUNTIME_NODE\}\|g/);
  assert.doesNotMatch(script, /s\|@NODE@\|\$\{NODE_PATH\}\|g/);
});

test("Linux immutable releases include the auth UI runtime asset", async () => {
  const script = await readFile(new URL("../../scripts/install-linux-user-workers.sh", import.meta.url), "utf8");
  assert.match(script, /if \[\[ ! -f "\$\{SOURCE_ROOT\}\/tools\/auth-test\.html" \]\]/);
  assert.match(script, /install -d -o root -g root -m 0755 "\$\{RUNTIME_ROOT\}\/tools"/);
  assert.match(
    script,
    /install -o root -g root -m 0644 \\\s+"\$\{SOURCE_ROOT\}\/tools\/auth-test\.html" \\\s+"\$\{RUNTIME_ROOT\}\/tools\/auth-test\.html"/,
  );
});
