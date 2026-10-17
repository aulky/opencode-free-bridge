const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../identity");

const origFetch = global.fetch;

afterEach(() => {
  global.fetch = origFetch;
  identity.__reset();
});

/**
 * Minimal stand-ins for the three opencode source files, shaped like the real
 * ones so the extractor is exercised on realistic input.
 */
const SOURCE = {
  identifier: `
export * as Identifier from "./identifier.js"
const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
export function create(descending: boolean, timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
}
`,
  sessionId: `
export const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(
  Schema.annotate({ identifier: "Session.ID" }),
  statics((schema) => {
    const create = () => schema.make("ses_" + descending())
    return { create }
  }),
)
`,
  app: `
export function useragent(app: Info) {
  return \`opencode/\${app.channel}/\${app.version}/\${app.name}\`
}
`,
  modelRequest: `
      const base = LLM.request({
        model: model.model,
        http: {
          headers: {
            "x-opencode-session-id": session.id,
            "x-session-affinity": affinity,
            "X-Session-Id": affinity,
            "User-Agent": App.useragent(app),
            "x-opencode-project": session.projectID,
            "x-opencode-session": affinity,
            "x-opencode-client": app.name,
          },
        },
      })
`,
};

function mockUpstream({
  versions = ["2.0.32"],
  source = SOURCE,
  failSource = false,
  failUpdateApi = false,
  minimum = false,
  sha = "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad",
} = {}) {
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);

    // The CLI's own update handshake (handshake.js asks this first).
    // It always answers with the newest release, so sort like the real service.
    if (u.includes("/update/api/")) {
      if (failUpdateApi) return { ok: false, status: 503 };
      const newest = versions.slice().sort((a, b) => {
        const [a1, a2, a3] = a.split(".").map(Number);
        const [b1, b2, b3] = b.split(".").map(Number);
        return b1 - a1 || b2 - a2 || b3 - a3;
      })[0];
      return {
        ok: true,
        json: async () => ({
          channel: "latest",
          version: newest,
          active: true,
          minimum,
          metadata: { package: "@opencode/cli", github: { sha } },
        }),
      };
    }

    if (u.includes("releases.atom")) {
      return {
        ok: true,
        text: async () => versions.map((v) => `<title>v${v}</title>`).join("\n"),
      };
    }
    if (u.includes("raw.githubusercontent.com")) {
      if (failSource) return { ok: false, status: 404 };
      const key = u.includes("session-id.ts")
        ? "sessionId"
        : u.includes("identifier.ts")
          ? "identifier"
          : u.includes("app.ts")
            ? "app"
            : "modelRequest";
      return { ok: true, text: async () => source[key] };
    }
    // The tool-profile artifact download: make it fail so tests exercise the
    // DEFAULT_TOOLS fallback rather than hitting the network.
    if (u.includes("registry.npmjs.org")) return { ok: false, status: 404 };
    return { ok: false, status: 404 };
  };
  return calls;
}

describe("identity: version parsing", () => {
  it("sorts versions newest-first and dedupes", () => {
    assert.deepEqual(identity.sortVersions(["1.9.0", "2.0.1", "2.0.10", "2.0.1"]), [
      "2.0.10",
      "2.0.1",
      "1.9.0",
    ]);
  });

  it("parses versions out of an atom feed", () => {
    const feed = "<title>Release notes</title><title>v2.0.32</title><title>v1.19.3</title>";
    assert.deepEqual(identity.parseVersions(feed), ["2.0.32", "1.19.3"]);
  });

  it("compares versions numerically, not lexically", () => {
    assert.ok(identity.compareVersions("2.0.10", "2.0.9") > 0);
    assert.ok(identity.compareVersions("1.18.0", "1.19.0") < 0);
    assert.equal(identity.compareVersions("2.0.1", "2.0.1"), 0);
  });

  it("reads the version floor out of an UpgradeRequired message", () => {
    assert.equal(
      identity.parseVersionFloor("OpenCode 1.18.0 or newer is required to use the free tier"),
      "1.18.0"
    );
    assert.equal(identity.parseVersionFloor("something else"), null);
    assert.equal(identity.parseVersionFloor(undefined), null);
  });
});

describe("identity: recipe extraction", () => {
  it("extracts session id shape, UA template and header names from source", () => {
    const r = identity.extractRecipe(SOURCE);
    assert.equal(r.sessionCharset.length, 62);
    assert.equal(r.sessionLength, 26);
    assert.equal(r.sessionMultiplier, 0x1000);
    assert.equal(r.sessionPrefix, "ses_");
    assert.equal(r.userAgentTemplate, "opencode/${app.channel}/${app.version}/${app.name}");
    assert.ok(r.headers.includes("x-session-affinity"));
    assert.ok(r.headers.includes("x-opencode-client"));
  });

  it("returns a partial recipe instead of throwing on malformed source", () => {
    const r = identity.extractRecipe({ identifier: "nothing useful here", app: "", modelRequest: "" });
    assert.deepEqual(r, {});
  });

  it("ignores an implausible session length", () => {
    const r = identity.extractRecipe({ identifier: 'const length = 3\nconst chars = "ab"' });
    assert.equal(r.sessionLength, undefined);
  });
});

describe("identity: applying a recipe", () => {
  beforeEach(() => identity.__reset());

  it("applies a complete update and reports what changed", () => {
    const changed = identity.applyRecipe({ version: "2.0.99" }, "v2.0.99");
    assert.deepEqual(changed, ["version"]);
    assert.equal(identity.getRecipe().version, "2.0.99");
  });

  it("rejects a UA template that does not render a plausible OpenCode UA", () => {
    const before = identity.getUserAgent();
    identity.applyRecipe({ userAgentTemplate: "not-an-opencode-agent" });
    assert.equal(identity.getUserAgent(), before);
  });

  it("accepts a UA template that renders a valid OpenCode UA", () => {
    identity.applyRecipe({ userAgentTemplate: "opencode/${app.channel}/${app.version}/desktop" });
    assert.equal(identity.getUserAgent(), `opencode/latest/${identity.getRecipe().version}/desktop`);
  });

  it("rejects a UA template that renders a malformed UA", () => {
    const before = identity.getUserAgent();
    // Missing the trailing name segment, so the gate would reject it.
    identity.applyRecipe({ userAgentTemplate: "opencode/${app.version}" });
    assert.equal(identity.getUserAgent(), before);
  });

  it("ignores an invalid version string", () => {
    const before = identity.getRecipe().version;
    identity.applyRecipe({ version: "not-a-version" });
    assert.equal(identity.getRecipe().version, before);
  });
});

describe("identity: session id generation", () => {
  beforeEach(() => identity.__reset());

  it("matches the upstream format: 12 hex + 14 base62", () => {
    const id = identity.createId(true);
    assert.match(id, /^[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(id.length, 26);
  });

  it("keeps the decoded counter within 1..16 under burst load", () => {
    const ts = 1_760_000_000_000;
    for (let i = 0; i < 64; i++) {
      const id = identity.createId(true, ts);
      const prefix = BigInt(`0x${id.slice(0, 12)}`);
      const decoded = ~prefix & ((1n << 48n) - 1n);
      const counter = Number(decoded & 0xfffn);
      assert.ok(counter >= 1 && counter <= 16, `counter ${counter} out of range`);
    }
  });

  it("follows the recipe when the upstream format changes", () => {
    // Simulate upstream shortening the random suffix.
    identity.applyRecipe({ sessionLength: 20 });
    const id = identity.createId(true);
    assert.equal(id.length, 20);
    assert.match(id, /^[0-9a-f]{12}[0-9A-Za-z]{8}$/);
  });
});

describe("identity: refresh", () => {
  beforeEach(() => identity.__reset());

  it("adopts the newest release and derives the recipe", async () => {
    mockUpstream({ versions: ["1.19.3", "2.0.32", "2.0.31"] });
    const res = await identity.refresh({ force: true });
    assert.equal(res.version, "2.0.32");
    assert.equal(identity.getUserAgent(), "opencode/latest/2.0.32/cli");
    // Source is read at the release's commit SHA, not a movable tag: that is
    // what makes derivation reproducible.
    assert.equal(identity.getState().lastSourceTag, "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad");
  });

  it("prefers the release the handshake names over a newer-looking feed tag", async () => {
    // Start below both candidates so the choice is actually exercised; from the
    // default 2.0.32 the monotonic guard would (correctly) refuse to move down.
    identity.__reset();
    identity.applyRecipe({ version: "1.0.0" });
    // The handshake is authoritative: it names 2.0.5 even though the feed
    // carries 1.99.0 as well.
    mockUpstream({ versions: ["2.0.5"] });
    await identity.refresh({ force: true });
    assert.equal(identity.getRecipe().version, "2.0.5");
  });

  it("still adopts the version when the source files are unavailable", async () => {
    mockUpstream({ versions: ["2.0.40"], failSource: true });
    const res = await identity.refresh({ force: true });
    assert.equal(res.version, "2.0.40");
    // Recipe shape stays at the last known-good values.
    assert.equal(identity.getRecipe().sessionLength, 26);
  });

  it("never moves backwards to an older tag", async () => {
    mockUpstream({ versions: ["2.0.32"] });
    await identity.refresh({ force: true });
    const v = identity.getRecipe().version;

    mockUpstream({ versions: ["2.0.10"] });
    identity.__setLastCheckTime(0);
    await identity.refresh({ force: true });
    assert.equal(identity.getRecipe().version, v);
  });

  it("keeps the previous recipe when the feed is unreachable", async () => {
    global.fetch = async () => {
      throw new Error("network down");
    };
    const before = identity.getRecipe();
    const res = await identity.refresh({ force: true });
    assert.equal(res.updated, false);
    assert.equal(identity.getRecipe().version, before.version);
    assert.ok(identity.getState().lastRefreshError);
  });

  it("does not fetch source files when the version has not moved", async () => {
    const calls = mockUpstream({ versions: ["2.0.32"] });
    // First (forced) refresh settles the recipe from source.
    await identity.refresh({ force: true });
    const afterFirst = calls.length;

    // A later NON-forced check finds the same version: only the handshake is
    // read (one cheap JSON request). This is the steady-state path, so it must
    // stay cheap and must never re-read the four source files.
    identity.__setLastCheckTime(0);
    const res = await identity.refresh();
    assert.equal(res.reason, "up-to-date");
    const second = calls.slice(afterFirst);
    const sourceReads = second.filter((u) => u.includes("raw.githubusercontent.com"));
    assert.equal(sourceReads.length, 0, `expected no source reads, got ${sourceReads.length}`);
    assert.ok(
      second.some((u) => u.includes("/update/api/")),
      "expected the handshake to be consulted"
    );
  });

  it("re-derives the recipe on a forced refresh even when the version is unchanged", async () => {
    // A gate rejection means the recipe may have changed without a version
    // bump, so a forced refresh must re-read everything rather than trusting
    // the cached shape.
    const calls = mockUpstream({ versions: ["2.0.32"] });
    await identity.refresh({ force: true });
    const afterFirst = calls.length;

    identity.__setLastCheckTime(0);
    await identity.refresh({ force: true });
    const second = calls.slice(afterFirst);

    // One handshake + four source files. The tool profile is served from cache
    // (or the fallback) and must not trigger a package download here.
    const handshakeCalls = second.filter((u) => u.includes("/update/api/"));
    const sourceCalls = second.filter((u) => u.includes("raw.githubusercontent.com"));
    assert.equal(handshakeCalls.length, 1, `expected one handshake, got ${handshakeCalls.length}`);
    assert.equal(sourceCalls.length, 4, `expected four source reads, got ${sourceCalls.length}`);
  });

  it("reports which recipe fields a partial source read could not derive", async () => {
    // Simulate upstream renaming the variables our regexes look for.
    const renamed = {
      identifier: "const size = 26\nconst alphabet = \"abc\"\n",
      app: "export function ua(x) { return `opencode/${x}` }",
      modelRequest: "http: { headerSet: { \"x-new-gate\": 1 } }",
    };
    mockUpstream({ versions: ["2.0.33"], source: renamed });
    const res = await identity.refresh({ force: true });

    assert.equal(res.sourceRead, true, "the files were fetched");
    assert.ok(res.missing.includes("sessionCharset"), "charset regex should have missed");
    assert.ok(res.missing.includes("sessionLength"), "length regex should have missed");
    assert.ok(res.missing.includes("headers"), "header regex should have missed");
  });

  it("keeps the previous recipe when extraction comes back empty", async () => {
    const before = identity.getRecipe();
    mockUpstream({
      versions: ["2.0.33"],
      source: { identifier: "x", app: "x", modelRequest: "x" },
    });
    await identity.refresh({ force: true });

    const after = identity.getRecipe();
    assert.equal(after.sessionCharset, before.sessionCharset);
    assert.equal(after.sessionLength, before.sessionLength);
    assert.equal(after.sessionPrefix, before.sessionPrefix);
    // The version still advances: that is the part that actually gates.
    assert.equal(after.version, "2.0.33");
  });

  it("reports no missing fields for a healthy extraction", async () => {
    mockUpstream({ versions: ["2.0.34"] });
    const res = await identity.refresh({ force: true });
    assert.deepEqual(res.missing, []);
    assert.deepEqual(identity.getState().missingFields, []);
  });

  it("does not flag missing fields when the source was never read", async () => {
    mockUpstream({ versions: ["2.0.35"], failSource: true });
    const res = await identity.refresh({ force: true });
    assert.equal(res.sourceRead, false);
    // Unreachable source is a transport failure, not a parsing failure — it
    // must not be reported as "regex stopped matching".
    assert.deepEqual(res.missing, []);
  });

  it("honours the operator-pinned user agent", async () => {
    process.env.OPENCODE_USER_AGENT = "opencode/latest/9.9.9/cli";
    try {
      const res = await identity.refresh({ force: true });
      assert.equal(res.reason, "pinned");
    } finally {
      delete process.env.OPENCODE_USER_AGENT;
    }
  });
});

describe("identity: ensureFresh is non-blocking", () => {
  beforeEach(() => identity.__reset());

  it("does nothing while the cached identity is fresh", () => {
    identity.__setLastCheckTime(Date.now());
    let fetched = 0;
    global.fetch = async () => {
      fetched++;
      return { ok: true, text: async () => "" };
    };
    const res = identity.ensureFresh();
    assert.equal(res.reason, "fresh");
    assert.equal(fetched, 0);
  });

  it("kicks off a background refresh without awaiting it", async () => {
    identity.__setLastCheckTime(0);
    let resolveFetch;
    const gate = new Promise((r) => {
      resolveFetch = r;
    });
    global.fetch = async () => {
      await gate; // never resolves during this test
      return { ok: true, text: async () => "<title>v2.0.32</title>" };
    };
    const res = identity.ensureFresh();
    // The call returns immediately with a "background" verdict rather than the
    // refresh result — that is the whole point: no request waits on GitHub.
    assert.equal(res.reason, "refreshing-in-background");
    resolveFetch();
  });
});

describe("identity: self-healing on gate rejection", () => {
  beforeEach(() => identity.__reset());

  it("adopts an advertised version floor and asks for a retry", async () => {
    mockUpstream({ versions: ["2.0.32"] });
    identity.__setLastCheckTime(Date.now());
    const verdict = await identity.onGateRejection(
      426,
      "UpgradeRequired",
      "OpenCode 2.5.0 or newer is required to use the free tier"
    );
    assert.equal(verdict.retry, true);
    assert.match(verdict.reason, /version-floor:2\.5\.0/);
    assert.equal(identity.getState().versionFloor, "2.5.0");
    assert.ok(identity.compareVersions(identity.getRecipe().version, "2.5.0") >= 0);
  });

  it("does not ask for a retry when nothing was learned", async () => {
    // Settle the recipe AND the tool profile first, so a second refresh against
    // the same upstream state genuinely teaches nothing.
    mockUpstream({ versions: [identity.getRecipe().version] });
    await identity.refresh({ force: true });
    await identity.loadToolProfile(identity.getRecipe().version, { force: true });

    identity.__setLastCheckTime(Date.now());
    const verdict = await identity.onGateRejection(403, "FreeTierError", "free tier");
    assert.equal(verdict.retry, false);
    assert.equal(verdict.reason, "no-change");
  });

  it("refuses to retry a second time (no retry loops)", async () => {
    const verdict = await identity.onGateRejection(403, "FreeTierError", "x", true);
    assert.equal(verdict.retry, false);
    assert.equal(verdict.reason, "already-retried");
  });

  it("recovers when the feed names a newer version", async () => {
    mockUpstream({ versions: ["2.0.99"] });
    identity.__setLastCheckTime(Date.now());
    const verdict = await identity.onGateRejection(403, "FreeTierError", "free tier");
    assert.equal(verdict.retry, true);
    assert.equal(identity.getRecipe().version, "2.0.99");
  });
});

describe("identity: drift reporting", () => {
  beforeEach(() => identity.__reset());

  it("reports upstream headers the bridge does not send", () => {
    identity.applyRecipe({ headers: ["x-opencode-session-id", "x-brand-new-gate-header"] });
    const drift = identity.detectDrift();
    assert.ok(drift.missing.includes("x-brand-new-gate-header"));
    assert.ok(drift.extra.includes("x-session-id"));
  });

  it("reports no missing headers for the canonical set", () => {
    const drift = identity.detectDrift();
    assert.deepEqual(drift.missing, []);
  });
});

describe("identity: tool profile", () => {
  it("falls back to the shipped definitions when both sources fail", async () => {
    // Point the cache at an empty dir and reject every network call, so neither
    // a saved capture nor a package download can satisfy the profile.
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-tools-"));
    const prevCache = process.env.OPENCODE_BRIDGE_CACHE;
    process.env.OPENCODE_BRIDGE_CACHE = tmp;
    try {
      mockUpstream({ versions: ["2.0.32"] });
      await identity.loadToolProfile("2.0.32", { force: true });
      const tools = identity.getTools();
      assert.ok(tools.read, "read must always be available");
      assert.ok(tools.shell, "shell must always be available");
      assert.equal(identity.getState().toolProfile.source, "default");
    } finally {
      if (prevCache === undefined) delete process.env.OPENCODE_BRIDGE_CACHE;
      else process.env.OPENCODE_BRIDGE_CACHE = prevCache;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shapes the list for both protocol lanes", () => {
    identity.__setToolProfile(
      {
        read: { description: "r", parameters: { type: "object", properties: {} } },
        shell: { description: "s", parameters: { type: "object", properties: {} } },
        glob: { description: "g", parameters: { type: "object", properties: {} } },
      },
      "test"
    );

    const chat = identity.getToolList(false);
    assert.deepEqual(
      chat.map((t) => t.function.name),
      ["read", "shell"],
      "core scope keeps only the fingerprinted tools"
    );
    assert.ok(chat.every((t) => t.type === "function" && t.function));

    const responses = identity.getToolList(true);
    assert.deepEqual(
      responses.map((t) => t.name),
      ["read", "shell"]
    );
    assert.ok(responses.every((t) => t.type === "function" && !t.function && t.strict === false));
  });

  it("trims to the fingerprinted core by default", () => {
    identity.__setToolProfile(
      {
        read: { description: "r", parameters: { type: "object", properties: {} } },
        bash: { description: "b", parameters: { type: "object", properties: {} } },
        glob: { description: "g", parameters: { type: "object", properties: {} } },
        write: { description: "w", parameters: { type: "object", properties: {} } },
      },
      "capture"
    );
    // A capture carries everything the CLI sends (~10 tools, ~20 KB of JSON).
    // The gate only fingerprints a small core, so the rest is prompt-token
    // waste and is not sent by default.
    assert.deepEqual(
      identity.getToolList(false).map((t) => t.function.name),
      ["read", "bash"]
    );
  });

  it("exposes the profile in getState for /health", () => {
    identity.__setToolProfile(
      { read: { description: "r", parameters: { type: "object", properties: {} } } },
      "capture"
    );
    const state = identity.getState();
    assert.equal(state.toolProfile.source, "capture");
    assert.deepEqual(state.toolProfile.toolNames, ["read"]);
    assert.equal(state.updateMode, "reactive");
  });
});
