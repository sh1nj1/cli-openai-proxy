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
    /systemctl is-active --quiet cli-openai-proxy-gateway\.service; then\s+systemctl restart cli-openai-proxy-gateway\.service/,
  );
  assert.doesNotMatch(script, /systemctl enable --now cli-openai-proxy-gateway\.service/);
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
