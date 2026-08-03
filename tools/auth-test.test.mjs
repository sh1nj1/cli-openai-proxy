import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("./auth-test.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const engineDescriptors = [
  { engine: "claude", flow: "paste-code", flows: ["paste-code"] },
  { engine: "codex", flow: "api-key", flows: ["api-key", "device-code"] },
];
const elementIds = [
  "baseUrl", "adminKey", "loadEngines", "engine", "flow", "checkStatus",
  "forgetCredential", "createSession", "sessionInfo", "userCodeInfo", "userCode",
  "submissionControls", "codeInput", "submitCode", "pollSession", "cancelSession",
  "apiKey", "model", "testCompletion", "resultStatus", "result",
];

class FakeElement {
  value = "";
  hidden = false;
  textContent = "";
  className = "";
  disabled = false;
  children = [];

  replaceChildren(...children) {
    this.children = children;
    if (children[0] instanceof FakeOption) this.value = children[0].value;
  }

  append(child) {
    this.children.push(child);
  }
}

class FakeOption {
  constructor(text, value) {
    this.text = text;
    this.value = value;
  }
}

function response(status, payload) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function loadPage(fetch, location = { protocol: "file:", origin: "null", search: "" }) {
  assert.ok(script, "inline test-page script exists");
  const elements = Object.fromEntries(elementIds.map((id) => [id, new FakeElement()]));
  elements.baseUrl.value = "http://localhost:3456";
  elements.adminKey.value = "admin-test";
  vm.runInNewContext(script, {
    document: {
      getElementById: (id) => elements[id],
      createElement: () => new FakeElement(),
    },
    fetch,
    Option: FakeOption,
    URLSearchParams,
    window: { location },
    JSON,
  });
  return elements;
}

test("served page uses its own origin and preselects only a returned engine", async () => {
  const elements = loadPage(async () => enginesResponse(), {
    protocol: "https:", origin: "https://proxy.example", search: "?engine=codex",
  });

  assert.equal(elements.baseUrl.value, "https://proxy.example");
  await elements.loadEngines.onclick();
  assert.equal(elements.engine.value, "codex");
});

test("unknown engine query is never reflected into the selector", async () => {
  const elements = loadPage(async () => enginesResponse(), {
    protocol: "https:", origin: "https://proxy.example", search: "?engine=%3Cscript%3E",
  });

  await elements.loadEngines.onclick();
  assert.equal(elements.engine.value, "claude");
  assert.equal(elements.engine.children.some(({ value }) => value === "<script>"), false);
});

const enginesResponse = () => response(200, { object: "list", data: engineDescriptors });
const sessionResponse = (id, userCode) => response(201, {
  sessionId: id,
  engine: "codex",
  flow: "device-code",
  status: "pending",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode,
  instructions: "Open the URL and enter the code.",
});

async function selectDeviceCode(elements) {
  await elements.loadEngines.onclick();
  elements.engine.value = "codex";
  elements.engine.onchange();
  elements.flow.value = "device-code";
  elements.flow.onchange();
}

test("auth test page drives the codex subscription device-code flow", async () => {
  const requests = [];
  const responses = [
    enginesResponse(),
    sessionResponse("session-1", "ABCD-EFGH"),
    response(200, { sessionId: "session-1", engine: "codex", flow: "device-code", status: "authorized" }),
  ];
  const elements = loadPage(async (url, init = {}) => {
    requests.push({ url, init });
    return responses.shift();
  });

  await selectDeviceCode(elements);
  assert.deepEqual(elements.flow.children.map(({ value }) => value), ["api-key", "device-code"]);
  assert.equal(elements.model.value, "paperclip/codex_local");
  assert.equal(elements.submissionControls.hidden, true);
  await elements.createSession.onclick({ target: elements.createSession });

  assert.deepEqual(JSON.parse(requests[1].init.body), { flow: "device-code" });
  assert.equal(elements.userCode.textContent, "ABCD-EFGH");
  assert.equal(elements.userCodeInfo.hidden, false);
  assert.equal(elements.sessionInfo.children[1].href, "https://auth.openai.com/codex/device");

  await elements.pollSession.onclick();
  assert.match(requests[2].url, /\/v1\/auth\/codex\/sessions\/session-1$/);
  assert.equal(elements.userCodeInfo.hidden, true);

  elements.flow.value = "api-key";
  elements.flow.onchange();
  assert.equal(elements.submissionControls.hidden, false, "terminal poll releases the device-code controls");
});

test("a stale terminal poll cannot clear a replacement device-code session", async () => {
  let finishOldPoll;
  const oldPoll = new Promise((resolve) => { finishOldPoll = resolve; });
  const responses = [
    enginesResponse(),
    sessionResponse("old-session", "OLD-CODE"),
    oldPoll,
    sessionResponse("new-session", "NEW-CODE"),
  ];
  const elements = loadPage(async () => responses.shift());

  await selectDeviceCode(elements);
  await elements.createSession.onclick({ target: elements.createSession });
  const polling = elements.pollSession.onclick();
  await elements.createSession.onclick({ target: elements.createSession });
  finishOldPoll(response(200, {
    sessionId: "old-session", engine: "codex", flow: "device-code", status: "authorized",
  }));
  await polling;

  assert.equal(elements.userCode.textContent, "NEW-CODE");
  assert.equal(elements.userCodeInfo.hidden, false);
  assert.match(elements.sessionInfo.children[0], /new-session/);
});
