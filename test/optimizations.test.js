const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  discoverModels,
  refreshCliVersion,
  shortText,
  readRequestBody,
  getPersistentSessionId,
  sessionCache,
  __setLastDiscoveryTime,
  __getDiscoveryState,
  __setLastCliVersionCheckTime,
  __getCliVersionState,
} = require("../server");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origFetch = global.fetch;

afterEach(() => {
  global.fetch = origFetch;
  sessionCache.clear();
});

describe("v1.5.2 optimizations", () => {
  it("single-flights 50 parallel discoverModels into 1 upstream fetch", async () => {
    let modelHits = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("raw.githubusercontent.com")) return { ok: false, status: 404 };
      if (u.includes("releases.atom")) return { ok: true, text: async () => "<title>v2.0.29</title>" };
      if (u.endsWith("/models")) {
        modelHits++;
        await sleep(120);
        return {
          ok: true,
          json: async () => ({ data: [{ id: "big-pickle" }, { id: "cat-jam-free" }] }),
        };
      }
      return { ok: false, status: 404 };
    };
    // Skip the CLI feed so the count isolates model discovery.
    __setLastCliVersionCheckTime(Date.now());
    __setLastDiscoveryTime(0);
    await Promise.all(Array.from({ length: 50 }, () => discoverModels()));
    assert.equal(modelHits, 1, `expected 1 upstream fetch, got ${modelHits} (pre-fix: 50)`);
    assert.equal(__getDiscoveryState().inFlight, false);
  });

  it("discoverModels never waits for a slow CLI version feed", async () => {
    let feedHits = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("raw.githubusercontent.com")) return { ok: false, status: 404 };
      if (u.includes("releases.atom")) {
        feedHits++;
        await sleep(400);
        return { ok: true, text: async () => "<title>v2.0.29</title>" };
      }
      if (u.endsWith("/models")) {
        await sleep(30);
        return { ok: true, json: async () => ({ data: [{ id: "big-pickle" }] }) };
      }
      return { ok: false, status: 404 };
    };
    __setLastCliVersionCheckTime(0); // force a feed refresh
    const t0 = Date.now();
    await discoverModels();
    const dt = Date.now() - t0;
    assert.equal(feedHits, 1);
    assert.ok(dt < 300, `discovery took ${dt}ms — pre-fix it waited 400ms+ for the feed`);
    await sleep(500); // let the background feed fetch settle before restoring fetch
  });

  it("caches the CLI version feed for 6h (2nd call = no fetch)", async () => {
    // The refresh now reads the release feed AND (only when the version moves)
    // the three recipe source files. Counting only the feed keeps the assertion
    // about caching, not about how many files the recipe needs.
    let feedHits = 0;
    global.fetch = async (url) => {
      if (String(url).includes("releases.atom")) feedHits++;
      return { ok: true, text: async () => "<title>v2.0.29</title>" };
    };
    __setLastCliVersionCheckTime(0);
    await refreshCliVersion();
    const afterFirst = feedHits;
    await refreshCliVersion();
    assert.equal(feedHits, afterFirst, `expected no extra feed fetch, got ${feedHits - afterFirst}`);
    assert.ok(afterFirst >= 1, "first call must read the feed");
    assert.ok(Date.now() - __getCliVersionState().lastCliVersionCheckTime < 60_000);
  });

  it("shortText slices without serializing huge payloads", () => {
    assert.equal(shortText("abcdef", 3), "abc");
    assert.equal(shortText([{ type: "text", text: "hello world" }], 5), "hello");
    assert.equal(shortText(null), "");
    // 20k-part array (~10MB): old extractContent joined ALL of it; shortText stops at the limit.
    const parts = Array.from({ length: 20000 }, (_, i) => ({ type: "text", text: "x".repeat(500) + i }));
    const t0 = process.hrtime.bigint();
    const s = shortText(parts, 1000);
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(s.length, 1000);
    assert.ok(dtMs < 100, `shortText took ${dtMs.toFixed(1)}ms`);
  });

  it("header session path skips message hashing entirely", () => {
    const huge = "x".repeat(5_000_000);
    const body = { messages: [{ role: "system", content: huge }, { role: "user", content: "hi" }] };
    const req = { headers: { "x-session-id": "hdr-bench-1" } };
    const t0 = process.hrtime.bigint();
    const a = getPersistentSessionId(req, body);
    const b = getPersistentSessionId(req, body);
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(a, b, "same header must map to the same session");
    assert.ok(dtMs < 50, `2 header-path lookups took ${dtMs.toFixed(1)}ms despite 5MB messages`);
  });

  it("rejects declared-huge bodies without buffering a byte", async () => {
    const { EventEmitter } = require("node:events");
    const fake = new EventEmitter();
    fake.headers = { "content-length": String(20 * 1024 * 1024) };
    let dataSeen = false;
    fake.on("data", () => (dataSeen = true));
    const t0 = Date.now();
    await assert.rejects(readRequestBody(fake), /exceeds limit/);
    assert.ok(Date.now() - t0 < 100, "early reject must be instant");
    assert.equal(dataSeen, false);
    // Normal path still works.
    const fake2 = new EventEmitter();
    fake2.headers = {};
    setImmediate(() => {
      fake2.emit("data", Buffer.from("hello "));
      fake2.emit("data", Buffer.from("world"));
      fake2.emit("end");
    });
    assert.equal(await readRequestBody(fake2), "hello world");
  });
});
