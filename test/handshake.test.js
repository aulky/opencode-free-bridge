const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const handshake = require("../handshake");

const origFetch = global.fetch;

afterEach(() => {
  global.fetch = origFetch;
  handshake.__reset();
  delete process.env.OPENCODE_MAJOR;
});

function mockFetch(handler) {
  global.fetch = async (url, opts) => handler(String(url), opts);
  return null;
}

describe("handshake: version selection", () => {
  it("parses and sorts versions newest-first", () => {
    const feed = "<title>v2.0.9</title><title>v2.0.10</title><title>v1.19.0</title>";
    assert.deepEqual(handshake.parseVersions(feed), ["2.0.10", "2.0.9", "1.19.0"]);
  });

  it("selects the newest version regardless of major", () => {
    // The old implementation hardcoded a `2.` prefix, which would silently
    // freeze the bridge on the last 2.x the day 3.0.0 shipped.
    assert.equal(handshake.selectVersion(["3.0.0", "2.9.9"]), "3.0.0");
    assert.equal(handshake.selectVersion(["2.0.32", "1.19.0"]), "2.0.32");
    assert.equal(handshake.selectVersion([]), null);
  });

  it("honours an explicit major pin", () => {
    process.env.OPENCODE_MAJOR = "2";
    assert.equal(handshake.selectVersion(["3.0.0", "2.9.9"]), "2.9.9");
  });
});

describe("handshake: release resolution", () => {
  it("reads version, commit SHA and the minimum flag from the update API", async () => {
    mockFetch((url) => {
      assert.match(url, /\/update\/api\/latest\/cli\/npm\?current=2\.0\.0/);
      return {
        ok: true,
        json: async () => ({
          channel: "latest",
          version: "2.0.32",
          active: true,
          minimum: true,
          metadata: { github: { sha: "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad" } },
        }),
      };
    });

    const r = await handshake.resolve("2.0.0");
    assert.equal(r.version, "2.0.32");
    assert.equal(r.sha, "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad");
    assert.equal(r.minimum, true);
    assert.equal(r.source, "update-api");
    assert.equal(r.stale, false);
  });

  it("treats a missing minimum flag as false rather than inferring it", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ version: "2.0.32", metadata: {} }),
    }));
    const r = await handshake.resolve("2.0.0");
    assert.equal(r.minimum, false);
    assert.equal(r.sha, null);
  });

  it("rejects an implausible SHA instead of passing it through", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ version: "2.0.32", metadata: { github: { sha: "not-a-sha!" } } }),
    }));
    const r = await handshake.resolve("2.0.0");
    assert.equal(r.sha, null);
  });

  it("falls back to the release feed when the update API is down", async () => {
    mockFetch((url) => {
      if (url.includes("/update/api/")) return { ok: false, status: 503 };
      return { ok: true, text: async () => "<title>v2.0.32</title><title>v1.19.0</title>" };
    });

    const r = await handshake.resolve("2.0.0");
    assert.equal(r.version, "2.0.32");
    assert.equal(r.source, "atom-feed");
    assert.equal(r.sha, null, "the feed carries no commit SHA");
    assert.match(r.degraded, /update-api/);
  });

  it("returns a stale result rather than throwing when everything is down", async () => {
    mockFetch((url) => {
      if (url.includes("/update/api/")) return { ok: false, status: 503 };
      return { ok: false, status: 500 };
    });

    const r = await handshake.resolve("2.0.0");
    assert.equal(r.version, null);
    assert.equal(r.stale, true);
    assert.ok(r.error);
  });
});

describe("handshake: source reference", () => {
  it("prefers the immutable commit SHA over a movable tag", () => {
    const ref = handshake.sourceRef({
      version: "2.0.32",
      sha: "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad",
    });
    assert.equal(ref, "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad");
  });

  it("falls back to the tag when no SHA is known", () => {
    assert.equal(handshake.sourceRef({ version: "2.0.32", sha: null }), "v2.0.32");
  });

  it("falls back to the default branch when nothing is known", () => {
    assert.equal(handshake.sourceRef(null), "dev");
  });
});
