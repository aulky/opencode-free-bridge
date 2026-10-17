"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const IDENTITY = path.join(ROOT, "identity.js");

test("no hardcoded model-name table exists in the shipped code", () => {
  // Regression: MODEL_MAP was a 17-entry table of shorthands ("pickle" ->
  // "big-pickle"). A name written by hand outlives the model it points at, so
  // aliases now derive from the catalog's own `family` field or from the
  // on-disk catalog cache. This test keeps the table from coming back.
  const src = fs.readFileSync(SERVER, "utf8");
  assert.doesNotMatch(src, /const\s+MODEL_MAP\s*=/, "MODEL_MAP must not return");
  assert.doesNotMatch(src, /"pickle"\s*:/, "no hand-written model shorthand may return");
});

test("aliases resolve from the catalog, not from the source", () => {
  const src = fs.readFileSync(IDENTITY, "utf8");
  // The only alias source is the catalog's family map.
  assert.match(src, /modelFamilies/, "catalog-derived family map must exist");
  // And the catalog must be cached to disk, so a cold start still resolves.
  assert.match(src, /CATALOG_CACHE_FILE/, "catalog must be cached on disk");
  assert.match(src, /readCachedCatalog/, "a cached catalog must be readable offline");
  assert.match(src, /writeCachedCatalog/, "the catalog must be written after a fetch");
});

test("offline start still resolves aliases from the cache", () => {
  // This is the behaviour the hardcoded table used to provide. It is now
  // provided by the cache, so assert the cache path exists and is used when the
  // network fetch fails.
  const src = fs.readFileSync(IDENTITY, "utf8");
  assert.match(
    src,
    /catch\s*\{[\s\S]{0,200}readCachedCatalog\(\)/,
    "extractCatalog must fall back to the cached catalog when the fetch fails"
  );
});

test("token-budget.js contains no hardcoded model-name hints", () => {
  const tb = fs.readFileSync(path.join(ROOT, "token-budget.js"), "utf8");
  const { REASONING_MODEL_HINTS } = require("../token-budget");
  assert.deepEqual(REASONING_MODEL_HINTS, []);
  assert.doesNotMatch(tb, /"cat-jam"|"pickle"/, "retired/conversational model hints must not return");
});

test("parseCatalogData rejects untrusted endpoint hosts and accepts opencode.ai", () => {
  const identity = require("../identity");
  const untrusted = identity.parseCatalogData({
    opencode: {
      api: "https://evil.example.com/v1",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "m-1": {
          cost: { input: 0, output: 0 },
          provider: { api: "https://evil.example.com/v1", npm: "@ai-sdk/openai-compatible" },
        },
      },
    },
  });
  assert.equal(untrusted.chatUrl, undefined, "untrusted catalog api host must be ignored");
  assert.equal(untrusted.modelEndpoints, undefined, "untrusted per-model api host must be ignored");

  const trusted = identity.parseCatalogData({
    opencode: {
      api: "https://opencode.ai/inference/openai/v1",
      npm: "@ai-sdk/openai-compatible",
      models: {},
    },
  });
  assert.equal(trusted.chatUrl, "https://opencode.ai/inference/openai/v1/chat/completions");
  assert.equal(trusted.responsesUrl, "https://opencode.ai/inference/openai/v1/responses");
});

test("refresh populates catalog when freeModels is empty even if CLI version is unchanged", async () => {
  const identity = require("../identity");
  const origFetch = global.fetch;
  identity.__reset();
  try {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/update/api/")) {
        return {
          ok: true,
          json: async () => ({
            version: identity.DEFAULT_RECIPE.version,
            minimum: false,
            active: true,
            metadata: { github: { sha: "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad" } },
          }),
        };
      }
      if (u.includes("api.json")) {
        return {
          ok: true,
          json: async () => ({
            opencode: {
              api: "https://opencode.ai/inference/openai/v1",
              models: {
                "mimo-v2.6-flash-free": {
                  cost: { input: 0, output: 0 },
                  family: "mimo-flash",
                  reasoning: true,
                  limit: { output: 32000 },
                },
              },
            },
          }),
        };
      }
      return { ok: false, status: 404 };
    };
    const prevCacheDir = process.env.OPENCODE_CACHE_DIR;
    const tmpCacheDir = path.join(require("os").tmpdir(), `ofb-test-${process.pid}-${Date.now()}`);
    process.env.OPENCODE_CACHE_DIR = tmpCacheDir;
    try {
      const res = await identity.refresh({ recheck: true });
      assert.equal(res.reason, "up-to-date");
      assert.deepEqual(identity.getFreeModels(), ["mimo-v2.6-flash-free"]);
      assert.equal(identity.resolveModelAlias("mimo"), "mimo-v2.6-flash-free");
      assert.equal(fs.existsSync(path.join(tmpCacheDir, "catalog.json")), true);

      // OPENCODE_CACHE_DIR=off disables disk writes without creating "./off"
      process.env.OPENCODE_CACHE_DIR = "off";
      await identity.extractCatalog();
      assert.equal(fs.existsSync(path.join(process.cwd(), "off")), false);
    } finally {
      try {
        fs.rmSync(tmpCacheDir, { recursive: true, force: true });
      } catch {}
      if (prevCacheDir === undefined) delete process.env.OPENCODE_CACHE_DIR;
      else process.env.OPENCODE_CACHE_DIR = prevCacheDir;
    }
  } finally {
    global.fetch = origFetch;
    identity.__reset();
  }
});

test("refresh({ force: true }) upgrades an in-flight non-forced reactive refresh so cold-boot 403s still self-heal", async () => {
  const identity = require("../identity");
  const origFetch = global.fetch;
  identity.__reset();
  identity.applyRecipe({ version: "0.9.9" });
  identity.__setLastCheckTime(0);
  try {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/update/api/")) {
        await new Promise((r) => setTimeout(r, 30));
        return {
          ok: true,
          json: async () => ({
            version: "2.0.99",
            minimum: false,
            active: true,
            metadata: { github: { sha: "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad" } },
          }),
        };
      }
      if (u.includes("session-id.ts")) {
        return {
          ok: true,
          text: async () => 'export const create = () => schema.make("ses_" + descending())',
        };
      }
      return { ok: false, status: 404 };
    };
    // Start a non-forced refresh (as ensureFresh() does on cold boot), then
    // immediately call refresh({ force: true }) (as onGateRejection() does).
    const pBg = identity.refresh({ force: false });
    const pForced = identity.refresh({ force: true });
    const [rBg, rForced] = await Promise.all([pBg, pForced]);
    assert.equal(rForced.updated, true);
    assert.equal(identity.getRecipe().version, "2.0.99");
    assert.equal(rBg.version, "2.0.99");
  } finally {
    global.fetch = origFetch;
    identity.__reset();
  }
});
