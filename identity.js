#!/usr/bin/env node
/**
 * identity.js — the OpenCode "mask" layer.
 *
 * The bridge must present itself as the OpenCode client. Rather than freezing
 * that identity in code (which goes stale every time upstream moves a gate),
 * this module derives it from the same place the CLI does: the published
 * opencode release, resolved through the CLI's own update handshake.
 *
 * Design rules (learned from upstream behaviour, see CHANGELOG):
 *
 *  1. LAZY — nothing runs on a timer. Identity is checked when a request is
 *     about to be made, and only if the cached copy is older than TTL. An idle
 *     bridge performs zero network calls.
 *  2. REACTIVE — if upstream rejects us (403 FreeTierError / 426
 *     UpgradeRequired), we refresh immediately, ignore TTL, and let the caller
 *     retry the request once. The user never sees the intermediate failure.
 *  3. SOURCE-DERIVED — the recipe (session id format, user-agent template,
 *     header names) is extracted from opencode's public source, read at the
 *     exact commit the release was built from (see handshake.js).
 *  4. FAIL-SAFE — extraction that does not yield a complete recipe is
 *     discarded; the last known-good recipe stays in use. A parsing change
 *     upstream can never break a working bridge.
 *  5. PINNABLE — `UPDATE_MODE=always` follows every release; `reactive` (the
 *     default) only moves when a gate rejects us. An upstream `minimum: true`
 *     overrides both, because that is upstream stating the floor has moved.
 *
 * Zero dependencies, Node.js >= 18.
 */

const handshake = require("./handshake");
const artifact = require("./artifact");
const capture = require("./capture");

const SOURCE_BASE =
  process.env.OPENCODE_SOURCE_BASE || "https://raw.githubusercontent.com/anomalyco/opencode";

// Recipe files in the opencode repo, and what each one tells us.
const SOURCE_FILES = {
  identifier: "packages/schema/src/identifier.ts",
  sessionId: "packages/schema/src/session-id.ts",
  app: "packages/core/src/app.ts",
  modelRequest: "packages/core/src/session/model-request.ts",
};

/**
 * UPDATE_MODE controls how eagerly the bridge follows a new release.
 *
 *   reactive  (default) only move when a gate rejection forces it, or when
 *             upstream marks the release `minimum: true`
 *   always    follow every release as soon as the TTL expires
 *
 * The distinction matters because most releases do not touch the gate. Following
 * every one costs a source read per release for no benefit; following none
 * leaves the bridge stuck the moment a gate does move.
 */
const UPDATE_MODE = (process.env.UPDATE_MODE || "reactive").toLowerCase();

// How long a checked identity is trusted before the next request re-checks it.
// Only consulted when a request arrives — no background timer.
const IDENTITY_TTL_MS = parseInt(
  process.env.IDENTITY_TTL_MS || String(15 * 60 * 1000),
  10
);
const FEED_TIMEOUT_MS = parseInt(process.env.IDENTITY_FETCH_TIMEOUT_MS || "5000", 10);
const SOURCE_TIMEOUT_MS = parseInt(process.env.IDENTITY_SOURCE_TIMEOUT_MS || "8000", 10);
// Tool profiles come from a 1.3 MB package download: check them far less often
// than the version, and only when the version has actually moved.
const TOOL_PROFILE_TTL_MS = parseInt(
  process.env.TOOL_PROFILE_TTL_MS || String(6 * 60 * 60 * 1000),
  10
);

/**
 * Last known-good recipe. Every field here is used by the request path, so a
 * partial update is never applied — see `applyRecipe`.
 */
const DEFAULT_RECIPE = Object.freeze({
  channel: "latest",
  version: "2.0.32",
  client: "cli",
  // Session ID: `ses_` + 12 hex (timestamp) + 14 base62 (random) = 26 chars.
  sessionPrefix: "ses_",
  sessionCharset: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  sessionLength: 26,
  sessionMultiplier: 0x1000,
  // Names the CLI sends on model requests. Used for drift reporting only.
  headers: Object.freeze([
    "x-opencode-session-id",
    "x-session-affinity",
    "X-Session-Id",
    "x-opencode-session",
    "x-opencode-project",
    "x-opencode-client",
  ]),
});

let recipe = { ...DEFAULT_RECIPE };
let lastCheckTime = 0;
let refreshInFlight = null;
// Lowest client version upstream has told us it will accept.
let versionFloor = null;
let lastRefreshError = null;
// Diagnostics for /health and drift reporting.
let lastSourceTag = null;
let lastDrift = null;
// Recipe fields a healthy source read should be able to derive. Anything left
// in `lastMissingFields` means a regex stopped matching upstream's source.
const RECIPE_FIELDS = [
  "sessionCharset",
  "sessionLength",
  "sessionMultiplier",
  "sessionPrefix",
  "userAgentTemplate",
  "headers",
];
let lastMissingFields = [];

// --- Tool profile -----------------------------------------------------------
// The `tools` array in the request body is the layer that moved most often
// (9router#4837: headers → +tools → exact schemas within days). It is therefore
// the layer that must never be hardcoded.
//
// Resolution order, best evidence first:
//   1. capture.json  — recorded from a real CLI (exact bytes, ground truth)
//   2. artifact      — extracted from the published @opencode/core bundle
//   3. DEFAULT_TOOLS — the last known-good definitions, used only until one of
//                      the above succeeds
let toolProfile = null;
let toolProfileSource = null;
let toolProfileVersion = null;
let toolProfileFetchedAt = 0;
let toolProfileError = null;
let toolProfileInFlight = null;

/**
 * Last-known-good definitions. These are the definitions the bridge shipped
 * with; they remain the fallback so a cold start with no network still works.
 * They are NOT the source of truth — `artifact.js` reproduces them byte-for-byte
 * from the published package, which is how we know the extractor is correct.
 */
const DEFAULT_TOOLS = Object.freeze({
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        },
        background: {
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
});

/**
 * The tool names the gate has required so far, in the order they appeared.
 * `read` is the one constant across every observed gate; `shell` replaced `bash`
 * in the v2 line. Kept as a preference list rather than a hard requirement, so
 * a profile that names different tools still wins.
 */
const REQUIRED_TOOL_HINTS = ["read", "shell", "bash", "glob", "grep"];

/**
 * Key-order-independent JSON, for comparing two tool profiles by content.
 * Property order in a JSON Schema carries no meaning, so a profile that only
 * reorders keys must not be treated as a change worth retrying for.
 */
function stableStringify(val) {
  if (!val || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(val[k])).join(",") + "}";
}

function clampString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/**
 * Parse a release feed (atom or JSON-ish text) for version tags.
 * Returns versions sorted newest-first.
 */
function parseVersions(text) {
  const found = [];
  const re = /<title>v?(\d+\.\d+\.\d+)<\/title>/gi;
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  return sortVersions(found);
}

function sortVersions(list) {
  const seen = new Set();
  return list
    .filter((v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
    .sort((a, b) => {
      const [a1, a2, a3] = a.split(".").map(Number);
      const [b1, b2, b3] = b.split(".").map(Number);
      return b1 - a1 || b2 - a2 || b3 - a3;
    });
}

function compareVersions(a, b) {
  const [a1, a2, a3] = String(a).split(".").map(Number);
  const [b1, b2, b3] = String(b).split(".").map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

/**
 * Pull the version floor out of an UpgradeRequired message, e.g.
 * "OpenCode 1.18.0 or newer is required to use the free tier".
 */
function parseVersionFloor(message) {
  const m = String(message || "").match(/(\d+\.\d+\.\d+)\s+or newer/i);
  return m ? m[1] : null;
}

/**
 * Extract a recipe from opencode source files. Pure function: takes the file
 * bodies, returns a partial recipe. Missing pieces are simply absent, and
 * `applyRecipe` refuses to apply an incomplete result.
 */
function extractRecipe(files = {}) {
  const out = {};

  // --- session id format ---
  const identifier = files.identifier;
  if (typeof identifier === "string") {
    const charset = identifier.match(/const\s+chars\s*=\s*"([^"]+)"/);
    if (charset && charset[1].length >= 2) out.sessionCharset = charset[1];

    const length = identifier.match(/const\s+length\s*=\s*(\d+)/);
    if (length) {
      const n = parseInt(length[1], 10);
      if (n >= 16 && n <= 64) out.sessionLength = n;
    }

    const multiplier = identifier.match(
      /BigInt\(timestamp\)\s*\*\s*0x([0-9a-fA-F]+)n/
    );
    if (multiplier) {
      const n = parseInt(multiplier[1], 16);
      if (Number.isSafeInteger(n) && n > 0) out.sessionMultiplier = n;
    }
  }

  // The `ses_` prefix lives in session-id.ts, not identifier.ts — the id
  // generator is prefix-agnostic.
  const sessionId = files.sessionId;
  if (typeof sessionId === "string") {
    const prefix = sessionId.match(/make\(\s*"([a-z]+_)"\s*\+\s*descending/);
    if (prefix) out.sessionPrefix = prefix[1];
  }

  // --- user-agent template ---
  const app = files.app;
  if (typeof app === "string") {
    const tpl = app.match(/return\s+`(opencode\/[^`]+)`/);
    if (tpl) out.userAgentTemplate = tpl[1];
  }

  // --- header names sent on model requests ---
  const modelRequest = files.modelRequest;
  if (typeof modelRequest === "string") {
    const block = modelRequest.match(/headers:\s*\{([\s\S]{0,2000}?)\n\s{8}\}/);
    if (block) {
      const names = [...block[1].matchAll(/"([A-Za-z][A-Za-z0-9-]*)":/g)].map(
        (m) => m[1]
      );
      const unique = [...new Set(names)].filter((n) => n.length < 64);
      if (unique.length > 0) out.headers = unique;
    }
  }

  return out;
}

/**
 * Render a user-agent from the CLI's template shape
 * (`opencode/${channel}/${version}/${name}`) plus the release version.
 */
function buildUserAgent(next = recipe) {
  const tpl = next.userAgentTemplate;
  if (typeof tpl === "string") {
    return tpl
      .replace("${app.channel}", next.channel)
      .replace("${app.version}", next.version)
      .replace("${app.name}", next.client);
  }
  return `opencode/${next.channel}/${next.version}/${next.client}`;
}

function getUserAgent() {
  return buildUserAgent(recipe);
}

/**
 * Validate then apply a recipe update. Rejects updates that would leave the
 * identity incomplete, so a half-parsed source file can never take the bridge
 * down. Returns the list of changed fields (empty when nothing moved).
 */
function applyRecipe(update = {}, sourceTag = null) {
  const next = { ...recipe };
  const changed = [];

  const version = clampString(update.version, 32);
  if (version && /^\d+\.\d+\.\d+$/.test(version) && version !== next.version) {
    next.version = version;
    changed.push("version");
  }

  const charset = clampString(update.sessionCharset, 128);
  if (charset && charset.length >= 2 && charset !== next.sessionCharset) {
    next.sessionCharset = charset;
    changed.push("sessionCharset");
  }

  if (
    Number.isInteger(update.sessionLength) &&
    update.sessionLength >= 16 &&
    update.sessionLength <= 64 &&
    update.sessionLength !== next.sessionLength
  ) {
    next.sessionLength = update.sessionLength;
    changed.push("sessionLength");
  }

  if (
    Number.isInteger(update.sessionMultiplier) &&
    update.sessionMultiplier > 0 &&
    update.sessionMultiplier !== next.sessionMultiplier
  ) {
    next.sessionMultiplier = update.sessionMultiplier;
    changed.push("sessionMultiplier");
  }

  const prefix = clampString(update.sessionPrefix, 16);
  if (prefix && prefix !== next.sessionPrefix) {
    next.sessionPrefix = prefix;
    changed.push("sessionPrefix");
  }

  if (typeof update.userAgentTemplate === "string") {
    // Only accept a template that still renders a plausible OpenCode UA.
    const probe = buildUserAgent({ ...next, userAgentTemplate: update.userAgentTemplate });
    if (/^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/.test(probe)) {
      next.userAgentTemplate = update.userAgentTemplate;
      if (probe !== buildUserAgent(recipe)) changed.push("userAgentTemplate");
    }
  }

  if (Array.isArray(update.headers) && update.headers.length > 0) {
    const same =
      update.headers.length === next.headers.length &&
      update.headers.every((h, i) => h === next.headers[i]);
    if (!same) {
      next.headers = update.headers;
      changed.push("headers");
    }
  }

  if (changed.length > 0) {
    recipe = next;
  }
  // The source tag records where the recipe was last read from, not whether it
  // changed. Two consecutive releases with identical schema still need the tag
  // to advance, or /health would report a stale reference forever.
  if (sourceTag) lastSourceTag = sourceTag;
  return changed;
}

/**
 * Compare what upstream sends against what we send. Reporting only.
 *
 * Two headers are excluded because they are conditional upstream, not part of
 * the baseline mask: `x-opencode-parent-session-id` / `x-parent-session-id` are
 * only attached when a request belongs to a subagent session. The bridge has no
 * subagents, so their absence is correct rather than drift — reporting them
 * would be a permanent false alarm that trains the reader to ignore this field.
 */
const CONDITIONAL_HEADERS = new Set(["x-opencode-parent-session-id", "x-parent-session-id"]);

function detectDrift() {
  const ours = new Set([
    "x-opencode-session-id",
    "x-opencode-session",
    "x-session-affinity",
    "x-session-id",
    "x-opencode-project",
    "x-opencode-client",
    "user-agent",
  ]);
  const theirs = new Set(
    recipe.headers.map((h) => h.toLowerCase()).filter((h) => !CONDITIONAL_HEADERS.has(h))
  );
  const missing = [...theirs].filter((h) => !ours.has(h));
  const extra = [...ours].filter((h) => !theirs.has(h));
  lastDrift = { missing, extra, checkedAgainst: lastSourceTag };
  return lastDrift;
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Load the tool profile for a release, best evidence first.
 *
 * Order matters and is deliberate:
 *   1. A saved capture is exact — it is literally what a CLI sent.
 *   2. The published package is authoritative but inferred — it is the code the
 *      release was built from, read statically.
 *   3. DEFAULT_TOOLS is the shipped fallback, used only when both fail.
 *
 * Never throws: a failure keeps the previous profile in place.
 */
async function loadToolProfile(version, { force = false } = {}) {
  if (!version) return { updated: false, reason: "no-version" };
  if (toolProfileInFlight) return toolProfileInFlight;

  const fresh =
    toolProfile &&
    toolProfileVersion === version &&
    Date.now() - toolProfileFetchedAt < TOOL_PROFILE_TTL_MS;
  if (fresh && !force) return { updated: false, reason: "fresh" };

  toolProfileInFlight = (async () => {
    try {
      // 1. Recorded from a real CLI: exact bytes, no inference.
      const captured = capture.loadProfile();
      if (captured && captured.tools && Object.keys(captured.tools).length > 0) {
        toolProfile = captured.tools;
        toolProfileSource = "capture";
        toolProfileVersion = version;
        toolProfileFetchedAt = Date.now();
        toolProfileError = null;
        return {
          updated: true,
          source: "capture",
          tools: Object.keys(captured.tools),
          capturedAt: captured.capturedAt,
        };
      }

      // 2. Extract from the published package at this exact version.
      const profile = await artifact.load(version);
      if (profile && profile.tools && Object.keys(profile.tools).length > 0) {
        toolProfile = profile.tools;
        toolProfileSource = "artifact";
        toolProfileVersion = version;
        toolProfileFetchedAt = Date.now();
        toolProfileError = null;
        if (Array.isArray(profile.partial) && profile.partial.length > 0) {
          console.warn(
            `[opencode-free-bridge] Tool profile ${version} partially resolved: ` +
              profile.partial.map((p) => `${p.tool}(${p.unresolved.join("|")})`).join(", ")
          );
        }
        return {
          updated: true,
          source: "artifact",
          tools: Object.keys(profile.tools),
          missing: profile.missing,
          partial: profile.partial,
        };
      }
      throw new Error("artifact extraction yielded no tools");
    } catch (err) {
      toolProfileError = err.message || String(err);
      // Keep whatever profile we already have; DEFAULT_TOOLS covers a cold start.
      if (!toolProfile) {
        toolProfile = { ...DEFAULT_TOOLS };
        toolProfileSource = "default";
      }
      return { updated: false, error: toolProfileError, source: toolProfileSource };
    } finally {
      toolProfileInFlight = null;
    }
  })();

  return toolProfileInFlight;
}

/**
 * Refresh the identity from upstream. Single-flight: concurrent callers share
 * one round of network calls. Never throws — a failed refresh keeps the
 * existing recipe in place.
 *
 * Version resolution goes through `handshake.js`, which asks the same endpoint
 * the CLI asks. That gives us two things the Atom feed cannot:
 *
 *   - the commit SHA the release was built from, so source is read at an
 *     immutable reference rather than a movable tag;
 *   - `minimum: true`, upstream's own statement that the floor has moved.
 *     That is acted on immediately, in both UPDATE_MODEs, because waiting for a
 *     rejection when the answer is already known only costs a failed request.
 *
 * The three source files are only fetched when the version actually moves (or
 * a rejection forces a re-derivation), keeping steady-state traffic minimal.
 */
async function refresh({ force = false } = {}) {
  if (process.env.OPENCODE_USER_AGENT) {
    // Operator pinned the UA: nothing to derive.
    return { updated: false, reason: "pinned" };
  }
  if (!force && Date.now() - lastCheckTime < IDENTITY_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      // 1. Which release is authoritative? Ask the CLI's own endpoint.
      const release = await handshake.resolve(recipe.version);
      const latest = release.version;
      if (!latest) throw new Error(release.error || "handshake resolved no version");

      lastCheckTime = Date.now();
      lastRefreshError = release.stale ? release.error || "handshake stale" : null;

      // `force` means "ignore the TTL and look now" — it does NOT mean "trust
      // whatever upstream says". Version only ever moves forward:
      //
      //   upstream < ours   → ignore. An older release would drop us below the
      //                       floor upstream enforces (and below any floor
      //                       learned from an UpgradeRequired).
      //   upstream == ours  → re-derive only when forced: a gate can move
      //                       without a version bump.
      //   upstream > ours   → adopt, unless UPDATE_MODE=reactive and nothing
      //                       indicates the gate moved.
      const cmp = compareVersions(latest, recipe.version);

      if (cmp < 0) {
        return { updated: false, version: recipe.version, reason: `newer-local:${recipe.version}` };
      }

      const forcedByUpstream = release.minimum === true;
      const shouldAdopt = cmp > 0 && (force || UPDATE_MODE === "always" || forcedByUpstream);

      if (cmp === 0 && !force) {
        // Same version: still make sure a tool profile exists for it.
        const tools = await loadToolProfile(recipe.version);
        return {
          updated: false,
          version: recipe.version,
          reason: "up-to-date",
          tools: tools.updated ? tools : undefined,
        };
      }
      if (cmp > 0 && !shouldAdopt) {
        return {
          updated: false,
          version: recipe.version,
          available: latest,
          reason: `available-not-adopted:${UPDATE_MODE}`,
        };
      }

      // 2. Version moved (or forced): derive the rest of the recipe from that
      //    exact commit. This is the only place the 4-file read happens.
      const ref = handshake.sourceRef(release);
      const update = { version: latest };
      let sourceRead = false;
      try {
        const bodies = await Promise.all(
          Object.entries(SOURCE_FILES).map(async ([key, path]) => [
            key,
            await fetchText(`${SOURCE_BASE}/${ref}/${path}`, SOURCE_TIMEOUT_MS),
          ])
        );
        Object.assign(update, extractRecipe(Object.fromEntries(bodies)));
        sourceRead = true;
      } catch {
        // Source unavailable (offline, renamed path, rate limit): the version
        // alone is still worth adopting — it is the part that actually gates.
      }

      const changed = applyRecipe(update, ref);

      // 3. Tool definitions for this version. Fetched in the same pass because
      //    a version bump is the only event that can change them.
      const tools = await loadToolProfile(latest, { force: true });

      // Extraction completeness. A regex that no longer matches upstream's
      // source is NOT fatal — the previous recipe keeps working and the version
      // still advances. But it is the early warning that the next gate move
      // will not be followed, so it must be visible rather than silent.
      if (sourceRead) {
        lastMissingFields = RECIPE_FIELDS.filter((f) => update[f] === undefined);
        if (lastMissingFields.length > 0) {
          console.warn(
            `[opencode-free-bridge] Identity extraction incomplete at ${ref}: ` +
              `could not derive ${lastMissingFields.join(", ")}. ` +
              `Previous values are still in use, but a gate change may not be followed.`
          );
        }
      }

      detectDrift();
      return {
        updated: changed.length > 0 || tools.updated,
        changed,
        version: recipe.version,
        tag: ref,
        sourceRead,
        missing: lastMissingFields,
        release: {
          version: release.version,
          sha: release.sha,
          source: release.source,
          minimum: release.minimum,
        },
        tools: tools.updated ? tools : undefined,
      };
    } catch (err) {
      lastRefreshError = err.message || String(err);
      // Keep the old recipe; retry on the next lazy check.
      return { updated: false, error: lastRefreshError };
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Lazy freshness check for the request path.
 *
 * Deliberately NON-BLOCKING: the refresh runs in the background and the current
 * request proceeds with the identity already in hand. A request must never wait
 * on GitHub to be served — the mask only changes between releases, so serving
 * one request with the previous mask is harmless, and the next request picks up
 * the new one. Real gate rejections are handled reactively by
 * `onGateRejection`, which does block because at that point we have no choice.
 */
function ensureFresh() {
  if (Date.now() - lastCheckTime < IDENTITY_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  // Fire and forget: never awaited by the request path.
  refresh().catch(() => {});
  return { updated: false, reason: "refreshing-in-background" };
}

/**
 * Upstream rejected our identity. Refresh immediately, ignoring TTL, and tell
 * the caller whether a single retry is worth attempting.
 *
 * `attempted` is the caller's own "already retried once" flag so a persistent
 * rejection cannot loop.
 */
async function onGateRejection(status, errType, errMsg, attempted = false) {
  if (attempted) return { retry: false, reason: "already-retried" };

  const before = recipe.version;
  // Snapshot the profile *content*, not just its label: a reload that returns
  // the same definitions has taught us nothing, and retrying would burn quota.
  const toolsBefore = stableStringify(toolProfile || DEFAULT_TOOLS);

  // An UpgradeRequired response tells us the exact floor. Adopt it even if the
  // handshake is unreachable, so we stay above the gate.
  const floor = parseVersionFloor(errMsg);
  if (floor) {
    versionFloor = floor;
    if (compareVersions(recipe.version, floor) < 0) {
      applyRecipe({ version: floor }, lastSourceTag);
    }
  }

  const result = await refresh({ force: true });

  // The tool layer can move without a version bump, so a rejection always
  // re-reads the tool profile too — that is the whole point of this path.
  await loadToolProfile(recipe.version, { force: true });

  const toolsAfter = stableStringify(toolProfile || DEFAULT_TOOLS);

  // Retry only when we actually learned something: a newer version, an adopted
  // floor, changed recipe fields, or tool definitions that differ from what we
  // were sending. A blind retry on an unchanged mask would burn quota and delay
  // the real error.
  const learned =
    recipe.version !== before ||
    toolsAfter !== toolsBefore ||
    (result && Array.isArray(result.changed) && result.changed.length > 0);

  return {
    retry: learned,
    reason: floor
      ? `version-floor:${floor}`
      : learned
        ? `updated:${[result?.reason, toolProfileSource].filter(Boolean).join("+")}`
        : "no-change",
    status,
    errType,
    toolSource: toolProfileSource,
  };
}

/**
 * Build a session id in the format upstream currently expects.
 *
 * The 48-bit prefix encodes `timestamp * multiplier + counter`. Upstream
 * decodes it and expects the counter to stay small, so we wrap into the next
 * millisecond once it fills the multiplier space — otherwise a burst of ids in
 * one millisecond pushes counter bits into the timestamp field and upstream
 * rejects the request.
 */
let lastTimestamp = 0;
let counter = 0;
const MAX_COUNTER_PER_MS = 16;

function createId(descending = true, timestamp = Date.now()) {
  const {
    sessionCharset: chars,
    sessionLength: length,
    sessionMultiplier: mult,
    sessionPrefix: prefix,
  } = recipe;

  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const extraMs = Math.floor((counter - 1) / MAX_COUNTER_PER_MS);
  const effectiveCounter = ((counter - 1) % MAX_COUNTER_PER_MS) + 1;

  const current = BigInt(timestamp + extraMs) * BigInt(mult) + BigInt(effectiveCounter);
  const value = descending ? ~current : current;
  const mask = (1n << 48n) - 1n;

  const hexChars = 12;
  const hex = (value & mask).toString(16).padStart(hexChars, "0");

  const randomChars = Math.max(0, length - hexChars);
  let out = "";
  for (let i = 0; i < randomChars; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return hex + out;
}

function getRecipe() {
  return { ...recipe };
}

function getState() {
  return {
    recipe: getRecipe(),
    userAgent: getUserAgent(),
    lastCheckTime,
    ttlMs: IDENTITY_TTL_MS,
    versionFloor,
    lastRefreshError,
    lastSourceTag,
    lastDrift,
    // Non-empty means the last successful source read could not derive these
    // fields — the early warning that a regex no longer matches upstream.
    missingFields: lastMissingFields,
    inFlight: Boolean(refreshInFlight),
    updateMode: UPDATE_MODE,
    toolProfile: {
      source: toolProfileSource,
      version: toolProfileVersion,
      fetchedAt: toolProfileFetchedAt,
      ageMs: toolProfileFetchedAt ? Date.now() - toolProfileFetchedAt : null,
      ttlMs: TOOL_PROFILE_TTL_MS,
      toolNames: toolProfile ? Object.keys(toolProfile) : null,
      error: toolProfileError,
    },
  };
}

/** The tool definitions currently in use. */
function getTools() {
  return toolProfile || DEFAULT_TOOLS;
}

/**
 * How many tools to send upstream.
 *
 * A capture records everything a real CLI sends — around ten definitions,
 * ~20 KB of JSON, which costs real prompt tokens on every request. The gate
 * only fingerprints a small core, so sending the whole set is waste.
 *
 *   core    (default) only the tools the gate is known to check
 *   full    every tool in the profile, exactly as a CLI would send it
 *
 * `TOOL_PROFILE_SCOPE=full` is the escape hatch: if a gate ever starts
 * requiring a tool outside the core set, sending the full captured list is the
 * faithful reproduction.
 */
const TOOL_SCOPE = (process.env.TOOL_PROFILE_SCOPE || "core").toLowerCase();

/**
 * Tools the gate has been observed to fingerprint. `read` has been present in
 * every variant; `shell` replaced `bash` in the v2 line, so both are kept and
 * whichever the profile provides is used.
 */
const CORE_TOOL_NAMES = ["read", "shell", "bash"];

/**
 * Tool definitions shaped for the wire, in the order the gate expects them.
 *
 * `read` leads because it is the one tool present in every observed gate
 * variant. Any additional tools follow in the profile's own order.
 */
function getToolList(flat = false) {
  const profile = getTools();
  const available = Object.keys(profile);

  let ordered;
  if (TOOL_SCOPE === "full") {
    ordered = [
      ...REQUIRED_TOOL_HINTS.filter((n) => profile[n]),
      ...available.filter((n) => !REQUIRED_TOOL_HINTS.includes(n)),
    ];
  } else {
    // Core scope: only the fingerprinted names the profile actually has. If it
    // has none of them (a malformed capture), fall back to everything rather
    // than sending an empty array, which the gate rejects outright.
    ordered = CORE_TOOL_NAMES.filter((n) => profile[n]);
    if (ordered.length === 0) ordered = available;
  }

  return ordered.map((name) => {
    const def = profile[name];
    return flat
      ? {
          type: "function",
          name,
          description: def.description,
          parameters: def.parameters,
          strict: false,
        }
      : {
          type: "function",
          function: {
            name,
            description: def.description,
            parameters: def.parameters,
          },
        };
  });
}

/** Test hooks — not used by the server. */
function __reset() {
  recipe = { ...DEFAULT_RECIPE };
  lastCheckTime = 0;
  refreshInFlight = null;
  versionFloor = null;
  lastRefreshError = null;
  lastSourceTag = null;
  lastDrift = null;
  lastMissingFields = [];
  lastTimestamp = 0;
  counter = 0;
  toolProfile = null;
  toolProfileSource = null;
  toolProfileVersion = null;
  toolProfileFetchedAt = 0;
  toolProfileError = null;
  toolProfileInFlight = null;
}

function __setLastCheckTime(v) {
  lastCheckTime = v;
}

function __setToolProfile(tools, source = "test") {
  toolProfile = tools;
  toolProfileSource = source;
  toolProfileVersion = recipe.version;
  toolProfileFetchedAt = Date.now();
  toolProfileError = null;
}

module.exports = {
  IDENTITY_TTL_MS,
  TOOL_PROFILE_TTL_MS,
  UPDATE_MODE,
  DEFAULT_RECIPE,
  DEFAULT_TOOLS,
  REQUIRED_TOOL_HINTS,
  SOURCE_FILES,
  parseVersions,
  sortVersions,
  compareVersions,
  parseVersionFloor,
  extractRecipe,
  buildUserAgent,
  applyRecipe,
  detectDrift,
  refresh,
  loadToolProfile,
  ensureFresh,
  onGateRejection,
  createId,
  getUserAgent,
  getRecipe,
  getTools,
  getToolList,
  getState,
  __reset,
  __setLastCheckTime,
  __setToolProfile,
};
