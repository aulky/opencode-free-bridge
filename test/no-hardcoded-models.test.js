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
