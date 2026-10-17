const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const pkg = require("../package.json");
const {
  VERSION,
  MAX_SESSIONS,
  CANONICAL_TOOLS_CHAT,
  CANONICAL_TOOLS_RESPONSES,
  sessionCache,
  createId,
  normalizeModel,
  isResponsesModel,
  markProtocolSupport,
  prepareToolsWithFingerprint,
  buildUpstreamHeaders,
  buildUpstreamPayload,
  getPersistentSessionId,
  readRequestBody,
  server,
  identity,
} = require("../server");
function sseStreamFromLines(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

function httpRequest(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? null
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload !== null
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("server unit & integration tests", () => {
  beforeEach(() => {
    sessionCache.clear();
  });

  it("keeps VERSION synced with package.json", () => {
    assert.equal(VERSION, pkg.version);
  });
  it("normalizeModel rejects empty/missing models and strips provider prefixes", () => {
    assert.equal(normalizeModel(undefined), "");
    assert.equal(normalizeModel(null), "");
    assert.equal(normalizeModel(""), "");
    assert.equal(normalizeModel("   "), "");
    assert.equal(normalizeModel("oc/"), "");
    assert.equal(normalizeModel("zen/mimo"), "mimo-v2.6-flash-free");
    assert.equal(normalizeModel("opencode/longcat"), "longcat-2.5-preview-free");
    assert.equal(normalizeModel("cat-jam"), "cat-jam-free");
  });

  it("createId never overflows the 12-bit counter into timestamp bits and keeps counter <= 16", () => {
    const ts = 1_760_000_000_000;
    const seen = new Set();
    for (let i = 0; i < 64; i++) {
      const id = createId(true, ts);
      assert.match(id, /^[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      seen.add(id);
      const invertedPrefix = BigInt(`0x${id.slice(0, 12)}`);
      const decoded = ~invertedPrefix & ((1n << 48n) - 1n);
      const counterBits = Number(decoded & 0xfffn);
      const decodedTs = decoded >> 12n;
      const expectedTs36 = BigInt(ts + Math.floor(i / 16)) & ((1n << 36n) - 1n);
      assert.ok(counterBits >= 1 && counterBits <= 16, `counter ${counterBits} out of 1..16`);
      assert.equal(decodedTs, expectedTs36);
    }
    assert.equal(seen.size, 64);
  });

  it("getPersistentSessionId evicts least-recently-used (LRU) session instead of FIFO", () => {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      getPersistentSessionId({ headers: { "x-session-id": `s-${i}` } }, {});
    }
    assert.equal(sessionCache.size, MAX_SESSIONS);

    // Touch s-0 so it becomes most-recently-used; s-1 is now LRU
    const s0Before = getPersistentSessionId({ headers: { "x-session-id": "s-0" } }, {});
    // Insert a new session beyond capacity
    getPersistentSessionId({ headers: { "x-session-id": "s-new" } }, {});

    assert.equal(sessionCache.has("hdr:s-0"), true, "Touched session s-0 must not be evicted");
    assert.equal(sessionCache.has("hdr:s-1"), false, "Oldest untouched session s-1 must be evicted");
    const s0After = getPersistentSessionId({ headers: { "x-session-id": "s-0" } }, {});
    assert.equal(s0After, s0Before);
  });

  it("buildUpstreamHeaders and buildUpstreamPayload satisfy OpenCode v2 /inference/v1 gate", () => {
    const sessionId = "ses_" + createId(true);
    const headers = buildUpstreamHeaders({ headers: { "user-agent": "OpenAI/Python" } }, sessionId);
    assert.match(headers["User-Agent"], /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/);
    assert.equal(headers["x-opencode-client"], "cli");
    assert.equal(headers["x-opencode-session"], sessionId);
    assert.equal(headers["x-opencode-session-id"], sessionId);
    assert.equal(headers["x-session-affinity"], sessionId);
    assert.equal(headers["x-session-id"], sessionId);
    assert.equal("x-opencode-request" in headers, false);

    // Chat payload with client 'read' tool conflict + max_tokens: 50 on longcat
    const { upstreamBody, aliasToOriginal } = buildUpstreamPayload(
      {
        model: "longcat-2.5-preview-free",
        max_tokens: 50,
        tool_choice: "none",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Custom client read tool",
              parameters: { type: "object", properties: { file: { type: "string" } } },
            },
          },
        ],
      },
      "longcat-2.5-preview-free",
      false
    );

    // Additive budget: max(50, 1024) + 4096 = 5120
    assert.equal(upstreamBody.max_tokens, 5120);
    assert.deepEqual(upstreamBody.stream_options, { include_usage: true });
    assert.equal("tool_choice" in upstreamBody, false, "tool_choice: 'none' must be omitted");

    const toolNames = upstreamBody.tools.map((t) => t.function.name);
    assert.deepEqual(toolNames, ["read_client", "read", "shell"]);
    assert.equal(aliasToOriginal.get("read_client"), "read");

    // Responses payload extracts system/developer messages into instructions, preserves images, and forwards temperature/top_p
    const { upstreamBody: respBody } = buildUpstreamPayload(
      {
        model: "muse-spark-1.3-contributor-free",
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: "system", content: "You are a concise assistant." },
          { role: "developer", content: "Always answer in Indonesian." },
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            ],
          },
        ],
      },
      "muse-spark-1.3-contributor-free",
      true
    );
    assert.match(respBody.instructions, /You are a concise assistant\./);
    assert.match(respBody.instructions, /Always answer in Indonesian\./);
    assert.match(respBody.instructions, /Do not call the `read` or `shell` tools/);
    assert.equal(respBody.input.length, 1);
    assert.equal(respBody.input[0].role, "user");
    assert.deepEqual(respBody.input[0].content, [
      { type: "input_text", text: "What is in this image?" },
      { type: "input_image", image_url: "https://example.com/cat.png" },
    ]);
    assert.equal(respBody.temperature, 0.2);
    assert.equal(respBody.top_p, 0.9);
  });

  it("avoids session hash collisions when headerless requests share a >1000-char prefix", () => {
    const sharedPrefix = "S".repeat(2000);
    const bodyA = {
      messages: [
        { role: "system", content: sharedPrefix },
        { role: "user", content: sharedPrefix + "::conversation-A" },
      ],
    };
    const bodyB = {
      messages: [
        { role: "system", content: sharedPrefix },
        { role: "user", content: sharedPrefix + "::conversation-B" },
      ],
    };
    const sA = getPersistentSessionId({ headers: {} }, bodyA);
    const sB = getPersistentSessionId({ headers: {} }, bodyB);
    assert.notEqual(sA, sB, "Different tails after a shared 2000-char prefix must not collide");
    assert.equal(getPersistentSessionId({ headers: {} }, bodyA), sA);
  });

  it("detaches listeners and pauses stream immediately when chunked body exceeds maxBytes", async () => {
    const { EventEmitter } = require("node:events");
    const fakeReq = new EventEmitter();
    fakeReq.headers = {};
    let paused = false;
    fakeReq.pause = () => {
      paused = true;
    };
    const p = readRequestBody(fakeReq, 10);
    fakeReq.emit("data", Buffer.from("0123456789ABCDEF"));
    await assert.rejects(p, /exceeds limit/);
    assert.equal(paused, true);
    assert.equal(fakeReq.listenerCount("data"), 0);
    assert.equal(fakeReq.listenerCount("end"), 0);
    assert.equal(fakeReq.listenerCount("error"), 0);
  });

  it("returns the fingerprint tools on zero-tool requests, shaped per protocol lane", () => {
    const chat = prepareToolsWithFingerprint([], false);
    const responses = prepareToolsWithFingerprint([], true);

    // The definitions are resolved from the live profile, so compare against
    // what identity reports rather than a frozen module constant.
    const names = identity.getToolList(false).map((t) => t.function.name);
    assert.deepEqual(
      chat.tools.map((t) => t.function.name),
      names
    );
    assert.deepEqual(
      responses.tools.map((t) => t.name),
      names
    );
    assert.equal(chat.aliasToOriginal.size, 0);
    // Chat nests the definition under `function`; Responses puts it flat.
    assert.ok(chat.tools.every((t) => t.function && t.type === "function"));
    assert.ok(responses.tools.every((t) => !t.function && t.type === "function"));
  });

  it("generates 10,000 session IDs using pooled random bytes in <25ms", () => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) {
      createId(true, 1_760_000_000_000 + i);
    }
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(dtMs < 50, `10k createId calls took ${dtMs.toFixed(2)}ms`);
  });
  describe("HTTP endpoint behavior (mocked upstream fetch)", () => {
    let port;
    let originalFetch;
    let mockFetchImpl;

    before(async () => {
      originalFetch = global.fetch;
      global.fetch = async (...args) => mockFetchImpl(...args);
      await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    // The identity layer refreshes lazily from the request path. These tests
    // assert on the exact upstream calls the bridge makes, so the identity is
    // marked fresh before each case: a background refresh would otherwise show
    // up as an extra fetch and make call-count assertions ambiguous.
    beforeEach(() => {
      identity.__reset();
      identity.__setLastCheckTime(Date.now());
    });

    after(async () => {
      global.fetch = originalFetch;
      await new Promise((resolve) => server.close(resolve));
    });

    it("returns 400 when model is missing or empty, and 400 on invalid JSON", async () => {
      const rMissing = await httpRequest(port, "POST", "/v1/chat/completions", {
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rMissing.status, 400);
      assert.equal(rMissing.body.error.code, "model_required");

      const rEmpty = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "   ",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rEmpty.status, 400);
      assert.equal(rEmpty.body.error.code, "model_required");

      const rBadJson = await httpRequest(port, "POST", "/v1/chat/completions", "{bad json");
      assert.equal(rBadJson.status, 400);
      assert.equal(rBadJson.body.error.code, "invalid_json");
    });

    it("propagates real usage and finish_reason='length' in non-streaming Chat Completions", async () => {
      let capturedBody = null;
      mockFetchImpl = async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"choices":[{"index":0,"delta":{"reasoning":"thinking...","content":"partial answer"},"finish_reason":null}],"usage":null}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":null}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":512,"total_tokens":632}}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "cat-jam-free",
        max_tokens: 0,
        stream: false,
        messages: [{ role: "user", content: "Tell a story" }],
      });

      assert.equal(res.status, 200);
      assert.equal(capturedBody.max_tokens, 5120);
      assert.deepEqual(capturedBody.stream_options, { include_usage: true });
      assert.equal(res.body.choices[0].message.content, "partial answer");
      assert.equal(res.body.choices[0].message.reasoning_content, "thinking...");
      assert.equal(res.body.choices[0].finish_reason, "length");
      assert.deepEqual(res.body.usage, {
        prompt_tokens: 120,
        completion_tokens: 512,
        total_tokens: 632,
      });
    });

    it("propagates finish_reason='length' on Responses API incomplete and restores aliased client tool names", async () => {
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","call_id":"call_abc","type":"function_call","name":"read_client"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"file\\":\\"a.txt\\"}"}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":15,"total_tokens":65}}}\n\n',
        ]),
      });

      const toolRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "muse-spark-1.3-contributor-free",
        stream: false,
        messages: [{ role: "user", content: "read a.txt" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "client read",
              parameters: { type: "object", properties: { file: { type: "string" } } },
            },
          },
        ],
      });

      assert.equal(toolRes.status, 200);
      assert.equal(toolRes.body.choices[0].finish_reason, "tool_calls");
      assert.equal(toolRes.body.choices[0].message.tool_calls[0].function.name, "read");
      assert.equal(
        toolRes.body.choices[0].message.tool_calls[0].function.arguments,
        '{"file":"a.txt"}'
      );
      assert.deepEqual(toolRes.body.usage, {
        prompt_tokens: 50,
        completion_tokens: 15,
        total_tokens: 65,
      });

      // Now test response.incomplete -> finish_reason: "length"
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"type":"response.output_text.delta","delta":"truncated"}\n\n',
          'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":10,"output_tokens":100,"total_tokens":110}}}\n\n',
        ]),
      });

      const truncRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "muse-spark-1.3-contributor-free",
        stream: false,
        messages: [{ role: "user", content: "long text" }],
      });
      assert.equal(truncRes.status, 200);
      assert.equal(truncRes.body.choices[0].finish_reason, "length");
      assert.equal(truncRes.body.choices[0].message.content, "truncated");
    });

    it("automatically retries on the opposite protocol lane when upstream returns ModelProtocolUnsupported", async () => {
      const urlsCalled = [];
      mockFetchImpl = async (url) => {
        urlsCalled.push(url);
        if (url.endsWith("/chat/completions")) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: {
                  type: "ModelProtocolUnsupported",
                  message: "Model does not support this protocol.",
                },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"type":"response.output_text.delta","delta":"OK from responses"}\n\n',
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}\n\n',
          ]),
        };
      };

      const newModel = "future-responses-model-free";
      assert.equal(isResponsesModel(newModel), false);

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: newModel,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.choices[0].message.content, "OK from responses");
      assert.equal(urlsCalled.length, 2);
      assert.match(urlsCalled[0], /\/inference\/v1\/chat\/completions$/);
      assert.match(urlsCalled[1], /\/inference\/v1\/responses$/);
      assert.equal(isResponsesModel(newModel), true);
      markProtocolSupport(newModel, false);
    });

    it("restricts CORS to localhost origins by default and rejects external websites", async () => {
      const localRes = await httpRequest(port, "GET", "/health", undefined, {
        Origin: "http://localhost:3000",
      });
      assert.equal(localRes.status, 200);
      assert.equal(localRes.headers["access-control-allow-origin"], "http://localhost:3000");

      const evilRes = await httpRequest(port, "GET", "/health", undefined, {
        Origin: "https://evil.example.com",
      });
      assert.equal(evilRes.status, 200);
      assert.equal(evilRes.headers["access-control-allow-origin"], undefined);
    });

    it("appends update hint only when upstream returns OpenCode CLI / FreeTierError gate rejection", async () => {
      mockFetchImpl = async () => ({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            error: {
              type: "FreeTierError",
              message: "Free models are only available in OpenCode CLI.",
            },
          }),
      });

      const gateRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(gateRes.status, 403);
      assert.match(gateRes.body.error.message, /Free models are only available in OpenCode CLI/);
      assert.match(gateRes.body.error.message, /install\.sh \| bash/);

      // Non-gate error (e.g. 429 rate limit) must NOT include update hint
      mockFetchImpl = async () => ({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            error: { type: "RateLimitError", message: "Endpoint is unavailable" },
          }),
      });

      const rateRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rateRes.status, 429);
      assert.equal(rateRes.body.error.message, "Endpoint is unavailable");
    });
  });
});
