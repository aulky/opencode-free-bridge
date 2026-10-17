const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const probe = require("../probe");

const origFetch = global.fetch;
const origEnabled = process.env.PROBE_ENABLED;

beforeEach(() => {
  probe.__reset();
  process.env.PROBE_ENABLED = "1";
});

afterEach(() => {
  global.fetch = origFetch;
  probe.__reset();
  if (origEnabled === undefined) delete process.env.PROBE_ENABLED;
  else process.env.PROBE_ENABLED = origEnabled;
});

function baseline(overrides = {}) {
  return {
    url: "https://opencode.ai/inference/v1/chat/completions",
    headers: {
      authorization: "Bearer public",
      "x-opencode-client": "cli",
      "x-opencode-session": "ses_abc",
      "x-opencode-session-id": "ses_abc",
      "x-session-affinity": "ses_abc",
      "x-session-id": "ses_abc",
      "x-opencode-project": "global",
    },
    body: { model: "m", messages: [], stream: true, tools: [{ type: "function" }] },
    ...overrides,
  };
}

describe("probe: safety gates", () => {
  it("is disabled unless explicitly enabled", async () => {
    delete process.env.PROBE_ENABLED;
    const r = await probe.run(baseline());
    assert.equal(r.ran, false);
    assert.equal(r.reason, "disabled");
  });

  it("enters cooldown after a failed batch and refuses to run again", async () => {
    global.fetch = async () => ({ ok: false, status: 403, text: async () => "{}" });

    const base = baseline({ body: { model: "m", messages: [] } });
    const first = await probe.run(base, {}, { cooldownMs: 60_000 });
    assert.equal(first.ran, true);
    assert.equal(first.learned, null);
    assert.ok(first.cooldownUntil > Date.now());

    const second = await probe.run(base, {}, { cooldownMs: 60_000 });
    assert.equal(second.ran, false);
    assert.match(second.reason, /^cooldown:/);
  });

  it("never exceeds the attempt budget", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 403, text: async () => "{}" };
    };

    const base = baseline({ body: { model: "m", messages: [] } });
    const r = await probe.run(base, { tools: [{ type: "function" }] }, { maxAttempts: 2 });
    assert.equal(r.ran, true);
    assert.ok(calls <= 2, `expected at most 2 upstream calls, made ${calls}`);
  });

  it("stops on a 429 rather than blaming the request shape", async () => {
    global.fetch = async () => ({ ok: false, status: 429, text: async () => "rate limited" });

    const base = baseline({ body: { model: "m", messages: [] } });
    const r = await probe.run(base, { tools: [{ type: "function" }] }, { maxAttempts: 6 });
    // First attempt gets 429 and stops the run.
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[1].note, "upstream-unavailable-stopping");
  });
});

describe("probe: candidate generation", () => {
  it("offers only the dimensions that are actually missing", () => {
    const candidates = probe.buildCandidates(baseline(), { tools: [{ type: "function" }] });
    // The only remaining axis for an otherwise-complete chat baseline is the
    // protocol lane: some models only answer on /responses.
    assert.deepEqual(
      candidates.map((c) => c.label),
      ["endpoint.responses"]
    );
  });

  it("offers tools when the body has none", () => {
    const base = baseline({ body: { model: "m", messages: [], stream: true } });
    const labels = probe.buildCandidates(base, { tools: [{ type: "function" }] }).map((c) => c.label);
    assert.ok(labels.includes("body.tools"));
  });

  it("offers the endpoint lane move for a /zen URL", () => {
    const base = baseline({ url: "https://opencode.ai/zen/v1/chat/completions" });
    const labels = probe.buildCandidates(base, {}).map((c) => c.label);
    assert.ok(labels.includes("endpoint.inference"));
  });

  it("offers streaming when the body disables it", () => {
    const base = baseline({ body: { model: "m", messages: [], stream: false } });
    const labels = probe.buildCandidates(base, {}).map((c) => c.label);
    assert.ok(labels.includes("body.stream"));
  });
});

describe("probe: single-variable discipline", () => {
  it("changes exactly one dimension per attempt", async () => {
    const seen = [];
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      seen.push({ url, body });
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    };

    // Baseline with no tools at all: the first candidate must be body.tools.
    const base = baseline({
      body: { model: "m", messages: [], stream: true },
    });
    const r = await probe.run(base, {
      tools: [{ type: "function", function: { name: "read" } }],
    });

    assert.equal(r.learned, "body.tools");
    assert.equal(seen.length, 1, "the first candidate passed, so probing stops");

    // The sent body differs from the baseline by exactly one key: `tools`.
    const stripTools = (b) => {
      const { tools, ...rest } = b;
      return rest;
    };
    assert.deepEqual(stripTools(seen[0].body), stripTools(base.body));
    assert.equal(base.body.tools, undefined, "the baseline itself had no tools");
    assert.ok(Array.isArray(seen[0].body.tools), "the attempt adds them");
    assert.equal(seen[0].url, base.url, "the endpoint must not move as well");
  });
});
