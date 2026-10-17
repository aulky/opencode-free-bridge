const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const capture = require("../capture");

describe("capture: profile distillation", () => {
  it("normalises the nested chat shape into one tool form", () => {
    const profile = capture.toProfile({
      url: "/v1/chat/completions",
      headers: { "user-agent": "opencode/1.19.0", "x-opencode-session-id": "ses_abc" },
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      },
    });

    assert.deepEqual(profile.toolNames, ["read"]);
    assert.equal(profile.tools.read.description, "Read a file");
    assert.deepEqual(Object.keys(profile.tools.read.parameters.properties), ["path"]);
  });

  it("normalises the flat Responses shape the same way", () => {
    const profile = capture.toProfile({
      url: "/v1/responses",
      headers: {},
      body: {
        tools: [
          {
            type: "function",
            name: "shell",
            description: "Run a command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        ],
      },
    });

    assert.deepEqual(profile.toolNames, ["shell"]);
    assert.equal(profile.tools.shell.description, "Run a command");
  });

  it("drops transport headers but keeps the identity ones", () => {
    const profile = capture.toProfile({
      url: "/v1/chat/completions",
      headers: {
        host: "127.0.0.1:1234",
        "content-length": "99",
        "content-type": "application/json",
        "accept-encoding": "gzip",
        connection: "keep-alive",
        "user-agent": "opencode/1.19.0",
        "x-opencode-session-id": "ses_abc",
      },
      body: { tools: [] },
    });

    assert.deepEqual(profile.headerNames, ["user-agent", "x-opencode-session-id"]);
    assert.ok(profile.headerSamples["user-agent"]);
  });

  it("survives a capture with no tools at all", () => {
    const profile = capture.toProfile({
      url: "/v1/chat/completions",
      headers: {},
      body: { messages: [] },
    });
    assert.deepEqual(profile.toolNames, []);
    assert.deepEqual(profile.tools, {});
  });

  it("ignores malformed tool entries instead of throwing", () => {
    const profile = capture.toProfile({
      url: "/v1/chat/completions",
      headers: {},
      body: { tools: [null, {}, { type: "function", function: {} }, { name: 42 }] },
    });
    assert.deepEqual(profile.toolNames, []);
  });
});

describe("capture: saved profile", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  let tmp;

  afterEach(() => {
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
    delete process.env.OPENCODE_BRIDGE_CACHE;
  });

  it("loads a saved capture and reports it through getState", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-test-"));
    process.env.OPENCODE_BRIDGE_CACHE = tmp;
    fs.writeFileSync(
      path.join(tmp, "capture.json"),
      JSON.stringify({
        capturedAt: 123,
        toolNames: ["read"],
        tools: { read: { name: "read", description: "d", parameters: {} } },
        cli: "/usr/bin/opencode",
      })
    );

    const p = capture.loadProfile();
    assert.equal(p.toolNames[0], "read");

    const state = capture.getState();
    assert.equal(state.available, true);
    assert.equal(state.capturedAt, 123);
    assert.deepEqual(state.toolNames, ["read"]);
  });

  it("reports unavailable rather than throwing when no capture exists", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-test-"));
    process.env.OPENCODE_BRIDGE_CACHE = tmp;
    assert.equal(capture.loadProfile(), null);
    assert.equal(capture.getState().available, false);
  });
});
