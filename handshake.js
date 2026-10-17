#!/usr/bin/env node
/**
 * handshake.js — resolve "which OpenCode release is authoritative right now",
 * the same way the CLI itself does.
 *
 * The CLI does not read the GitHub release feed to decide whether it is current.
 * It asks a purpose-built endpoint:
 *
 *   GET https://opencode.ai/update/api/<channel>/<artifact>/<distribution>?current=<version>
 *   → { channel, version, active, minimum,
 *       metadata: { package, github: { sha, run_id, ... } } }
 *
 * Two fields matter to us:
 *
 *   version   the release the CLI would move to.
 *   metadata.github.sha
 *             the exact commit that produced that release. A git tag can be
 *             moved; a commit cannot. Fetching source at the SHA is what makes
 *             derivation reproducible — the bridge reads the same bytes the
 *             shipped CLI was built from.
 *
 * `minimum` is upstream's own statement that older clients are no longer
 * accepted. When it is true, waiting for a rejection before updating is wrong:
 * the answer is already known, so the update is applied immediately regardless
 * of UPDATE_MODE.
 *
 * The Atom feed is kept as a fallback for the case where the update service is
 * unreachable (offline mirror, proxy, outage). It only carries a version, not a
 * SHA — enough to keep the version floor moving, not enough to re-derive the
 * recipe. Callers can tell the difference by `source`.
 */

const UPDATE_API_BASE =
  process.env.OPENCODE_UPDATE_API_BASE || "https://opencode.ai/update/api";
const ATOM_URL =
  process.env.OPENCODE_RELEASES_ATOM_URL ||
  "https://github.com/anomalyco/opencode/releases.atom";
const TIMEOUT_MS = parseInt(process.env.HANDSHAKE_TIMEOUT_MS || "8000", 10);

// Matches the shape the CLI uses. "latest" is the stable channel; "dev" and
// "beta" exist upstream but are not what a free-tier gate is calibrated against.
const CHANNEL = process.env.OPENCODE_CHANNEL || "latest";
const ARTIFACT = "cli";
// The bridge does not install via npm — this only selects which release record
// to read, and npm is the distribution every platform shares.
const DISTRIBUTION = process.env.OPENCODE_DISTRIBUTION || "npm";

let lastResult = null;
let lastError = null;

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Parse versions out of an Atom release feed. Mirrors identity.js's parser but
 * is kept here so handshake has no dependency on the identity module (which
 * depends on handshake's output — a cycle would make both harder to test).
 */
function parseVersions(text) {
  const found = [];
  const re = /<title>v?(\d+\.\d+\.\d+)<\/title>/gi;
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  const seen = new Set();
  return found
    .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
    .sort((a, b) => {
      const [a1, a2, a3] = a.split(".").map(Number);
      const [b1, b2, b3] = b.split(".").map(Number);
      return b1 - a1 || b2 - a2 || b3 - a3;
    });
}

/**
 * The previous implementation hardcoded `versions.find(v => v.startsWith("2."))`.
 * That is a time bomb: the day opencode ships 3.0.0 the filter matches nothing,
 * the fallback silently keeps the newest 2.x, and the bridge freezes one major
 * version behind with no error. The channel is the right selector — "latest"
 * means latest, whatever the major.
 *
 * `OPENCODE_MAJOR` lets an operator pin a major line deliberately (e.g. a fork
 * that only tracks 2.x). Unset means "no pin".
 */
function selectVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const pinned = process.env.OPENCODE_MAJOR;
  if (pinned && /^\d+$/.test(pinned)) {
    return versions.find((v) => v.split(".")[0] === pinned) || null;
  }
  return versions[0];
}

/**
 * Ask the update service. Returns the authoritative record or throws.
 */
async function fetchRelease(currentVersion) {
  const url =
    `${UPDATE_API_BASE}/${encodeURIComponent(CHANNEL)}/${encodeURIComponent(ARTIFACT)}` +
    `/${encodeURIComponent(DISTRIBUTION)}?current=${encodeURIComponent(currentVersion || "0.0.0")}`;
  const data = await fetchJson(url);
  const version = typeof data.version === "string" ? data.version : null;
  if (!version) throw new Error("update service returned no version");
  const github = data.metadata && data.metadata.github ? data.metadata.github : {};
  return {
    version,
    sha: typeof github.sha === "string" && /^[0-9a-f]{7,40}$/i.test(github.sha) ? github.sha : null,
    // Upstream's own statement that the floor has moved. Absent means false:
    // never infer "required" from a missing field.
    minimum: data.minimum === true,
    active: data.active !== false,
    channel: data.channel || CHANNEL,
    source: "update-api",
  };
}

/**
 * Fallback: the release feed carries a version but no commit SHA.
 */
async function fetchReleaseFromFeed() {
  const text = await fetchText(ATOM_URL);
  const version = selectVersion(parseVersions(text));
  if (!version) throw new Error("no version found in release feed");
  return {
    version,
    sha: null,
    minimum: false,
    active: true,
    channel: CHANNEL,
    source: "atom-feed",
  };
}

/**
 * Resolve the authoritative release. Never throws: a total failure returns the
 * last known-good result with `stale: true`, so the caller can decide whether
 * that is good enough rather than handling an exception on the request path.
 */
async function resolve(currentVersion = "0.0.0") {
  try {
    const release = await fetchRelease(currentVersion);
    lastResult = { ...release, resolvedAt: Date.now(), stale: false };
    lastError = null;
    return lastResult;
  } catch (primaryErr) {
    try {
      const release = await fetchReleaseFromFeed();
      lastResult = {
        ...release,
        resolvedAt: Date.now(),
        stale: false,
        degraded: `update-api: ${primaryErr.message}`,
      };
      lastError = null;
      return lastResult;
    } catch (feedErr) {
      lastError = `update-api: ${primaryErr.message}; atom-feed: ${feedErr.message}`;
      if (lastResult) return { ...lastResult, stale: true, error: lastError };
      return {
        version: null,
        sha: null,
        minimum: false,
        active: true,
        channel: CHANNEL,
        source: "none",
        resolvedAt: null,
        stale: true,
        error: lastError,
      };
    }
  }
}

/**
 * Where to read source for a resolved release.
 *
 * Prefer the commit SHA: it is immutable and is exactly what the released
 * binary was built from. Fall back to the tag, which is mutable but usually
 * correct, and only then to the default branch.
 */
function sourceRef(release) {
  if (release && release.sha) return release.sha;
  if (release && release.version) return `v${release.version}`;
  return process.env.OPENCODE_SOURCE_REF || "dev";
}

function getState() {
  return { lastResult, lastError, channel: CHANNEL };
}

function __reset() {
  lastResult = null;
  lastError = null;
}

module.exports = {
  CHANNEL,
  ARTIFACT,
  DISTRIBUTION,
  parseVersions,
  selectVersion,
  fetchRelease,
  fetchReleaseFromFeed,
  resolve,
  sourceRef,
  getState,
  __reset,
};
