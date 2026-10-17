#!/usr/bin/env node
/**
 * identity.js — adaptive OpenCode CLI identity & security-layer sync.
 *
 * Keeps the bridge aligned with the official OpenCode CLI when upstream adjusts
 * its free-tier gate (User-Agent version floor, session ID format, headers, or
 * core tool fingerprint definitions).
 *
 * How it works:
 *  1. HANDSHAKE — Queries the same update endpoint the OpenCode CLI uses:
 *       GET https://opencode.ai/update/api/<channel>/cli/npm?current=<version>
 *       -> { version, minimum, metadata: { github: { sha } } }
 *     Falls back to GitHub's releases.atom feed if the update API is unreachable.
 *
 *  2. UPDATE MODES (`UPDATE_MODE`):
 *     - `reactive` (default): Uses the current identity until upstream rejects a
 *       request (403 FreeTierError / 426 UpgradeRequired) or flags `minimum: true`,
 *       then refreshes immediately and retries the request once.
 *     - `always`: Proactively adopts every new OpenCode release when the lazy
 *       TTL expires.
 *
 *  3. SOURCE SYNC — When moving to a new release (or forced by a gate error),
 *     fetches the lightweight source files at the release's exact commit SHA
 *     to update the session ID recipe, User-Agent template, and `read`/`shell`
 *     tool fingerprint schemas. Incomplete parses fall back safely to the last
 *     known-good values.
 */

const crypto = require("crypto");

const UPDATE_API_BASE =
  process.env.OPENCODE_UPDATE_API_BASE || "https://opencode.ai/update/api";
const ATOM_URL =
  process.env.OPENCODE_RELEASES_ATOM_URL ||
  "https://github.com/anomalyco/opencode/releases.atom";
const SOURCE_BASE =
  process.env.OPENCODE_SOURCE_BASE ||
  "https://raw.githubusercontent.com/anomalyco/opencode";

const CHANNEL = process.env.OPENCODE_CHANNEL || "latest";
const ARTIFACT = "cli";
const DISTRIBUTION = process.env.OPENCODE_DISTRIBUTION || "npm";

const IDENTITY_TTL_MS = parseInt(
  process.env.IDENTITY_TTL_MS || String(15 * 60 * 1000),
  10
);
const HANDSHAKE_TIMEOUT_MS = parseInt(
  process.env.HANDSHAKE_TIMEOUT_MS || process.env.IDENTITY_FETCH_TIMEOUT_MS || "6000",
  10
);
const SOURCE_TIMEOUT_MS = parseInt(
  process.env.IDENTITY_SOURCE_TIMEOUT_MS || "8000",
  10
);

function getUpdateMode() {
  const mode = (process.env.UPDATE_MODE || "reactive").toLowerCase().trim();
  return mode === "always" ? "always" : "reactive";
}

const SOURCE_FILES = Object.freeze({
  identifier: "packages/schema/src/identifier.ts",
  sessionId: "packages/schema/src/session-id.ts",
  app: "packages/core/src/app.ts",
  modelRequest: "packages/core/src/session/model-request.ts",
  readTool: "packages/core/src/tool/plugin/read.ts",
  shellTool: "packages/core/src/tool/plugin/shell.ts",
});

const DEFAULT_RECIPE = Object.freeze({
  channel: "latest",
  version: "2.0.32",
  client: "cli",
  sessionPrefix: "ses_",
  sessionCharset: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  sessionLength: 26,
  sessionMultiplier: 0x1000,
  userAgentTemplate: "opencode/${app.channel}/${app.version}/${app.name}",
  // The header names upstream's own request builder sets, in its order. This is
  // the fallback when the source read fails, so it must be the complete set —
  // a partial list would silently stop sending a header the gate checks.
  headers: Object.freeze([
    "x-opencode-session-id",
    "x-session-affinity",
    "X-Session-Id",
    "User-Agent",
    "x-opencode-project",
    "x-opencode-session",
    "x-opencode-client",
  ]),
});

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

const CORE_TOOL_NAMES = ["read", "shell", "bash"];

let recipe = { ...DEFAULT_RECIPE };
let toolProfile = null;
let toolProfileSource = "default";
let toolProfileVersion = DEFAULT_RECIPE.version;
let lastRelease = null;
let lastAvailable = null;
let lastCheckTime = 0;
let refreshInFlight = null;
let versionFloor = null;
let lastRefreshError = null;
let lastSourceTag = null;
let optionalHeaders = [];

function stableStringify(val) {
  if (!val || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(val[k])).join(",") + "}";
}

function clampString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

// --- Version & Handshake Helpers ---------------------------------------------

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

function parseVersions(text) {
  const found = [];
  const re = /<title>v?(\d+\.\d+\.\d+)<\/title>/gi;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) found.push(m[1]);
  return sortVersions(found);
}

function selectVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const pinned = process.env.OPENCODE_MAJOR;
  if (pinned && /^\d+$/.test(pinned)) {
    return versions.find((v) => v.split(".")[0] === pinned) || null;
  }
  return versions[0];
}

function compareVersions(a, b) {
  const [a1, a2, a3] = String(a).split(".").map(Number);
  const [b1, b2, b3] = String(b).split(".").map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

function parseVersionFloor(message) {
  const m = String(message || "").match(/(\d+\.\d+\.\d+)\s+or newer/i);
  return m ? m[1] : null;
}

function sourceRef(release) {
  if (release && release.sha) return release.sha;
  if (release && release.version) return `v${release.version}`;
  return process.env.OPENCODE_SOURCE_REF || "dev";
}

async function fetchJson(url, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = SOURCE_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Resolve the current authoritative CLI release via OpenCode's update handshake,
 * falling back to the GitHub Atom feed when the update API is unreachable.
 */
async function resolveRelease(currentVersion = recipe.version) {
  const channel = process.env.OPENCODE_CHANNEL || CHANNEL;
  const url =
    `${UPDATE_API_BASE}/${encodeURIComponent(channel)}/${encodeURIComponent(ARTIFACT)}` +
    `/${encodeURIComponent(DISTRIBUTION)}?current=${encodeURIComponent(currentVersion || "0.0.0")}`;
  try {
    const data = await fetchJson(url, HANDSHAKE_TIMEOUT_MS);
    const version = typeof data?.version === "string" ? data.version : null;
    if (!version) throw new Error("update service returned no version");
    const github = data?.metadata?.github || {};
    const sha =
      typeof github.sha === "string" && /^[0-9a-f]{7,40}$/i.test(github.sha)
        ? github.sha
        : null;
    lastRelease = {
      version,
      sha,
      minimum: data.minimum === true,
      active: data.active !== false,
      channel: data.channel || channel,
      source: "update-api",
      resolvedAt: Date.now(),
      stale: false,
    };
    return lastRelease;
  } catch (primaryErr) {
    try {
      const text = await fetchText(ATOM_URL, HANDSHAKE_TIMEOUT_MS);
      const version = selectVersion(parseVersions(text));
      if (!version) throw new Error("no version found in release feed");
      lastRelease = {
        version,
        sha: null,
        minimum: false,
        active: true,
        channel,
        source: "atom-feed",
        resolvedAt: Date.now(),
        stale: false,
        degraded: `update-api: ${primaryErr.message}`,
      };
      return lastRelease;
    } catch (feedErr) {
      const error = `update-api: ${primaryErr.message}; atom-feed: ${feedErr.message}`;
      if (lastRelease) return { ...lastRelease, stale: true, error };
      return {
        version: null,
        sha: null,
        minimum: false,
        active: true,
        channel,
        source: "none",
        resolvedAt: null,
        stale: true,
        error,
      };
    }
  }
}

// --- Source Extraction (Recipe + Tool Definitions) ---------------------------

function interpolateTemplate(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const key = expr.trim();
    return vars[key] !== undefined ? String(vars[key]) : `
${key}`;
  });
}

/**
 * Extract a single tool's wire definition (`description` + JSON Schema `parameters`)
 * directly from its TypeScript plugin source (`read.ts` or `shell.ts`).
 */
function extractToolFromSource(source, fallbackName) {
  if (typeof source !== "string" || !source.trim()) return null;

  const nameMatch = source.match(/export\s+const\s+name\s*=\s*"([a-z][a-z0-9_-]*)"/i);
  const name = nameMatch ? nameMatch[1] : fallbackName;
  if (!name) return null;

  const vars = { OS: "Linux", shell: "bash" };
  for (const m of source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*([0-9][0-9_*\s+]*)/g)) {
    const clean = m[2].replace(/_/g, "").trim();
    if (/^[0-9*\s+]+$/.test(clean)) {
      const val = clean
        .split("+")
        .map((part) => part.split("*").reduce((acc, n) => acc * Number(n.trim()), 1))
        .reduce((a, b) => a + b, 0);
      if (Number.isFinite(val)) vars[m[1]] = val;
    }
  }

  // 1. Tool description: either an array builder `const description = (...) => [ ... ].join(" ")`
  //    or a string literal `description: "..."` inside `editor.add({ ... })`.
  let description = null;
  const builderMatch = source.match(
    /const\s+description\s*=\s*\([^)]*\)\s*=>\s*\[([\s\S]*?)\]\.join\(\s*" "\s*\)/m
  );
  if (builderMatch) {
    const parts = [];
    const litRe = /"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
    let lm;
    while ((lm = litRe.exec(builderMatch[1])) !== null) {
      const raw = lm[1] !== undefined ? lm[1] : interpolateTemplate(lm[2], vars);
      if (raw) parts.push(raw);
    }
    if (parts.length > 0) description = parts.join(" ");
  } else {
    const addBlock = source.match(/editor\.add\(\{([\s\S]*?)\binput\s*:/);
    if (addBlock) {
      const descMatch = addBlock[1].match(/description\s*:\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/);
      if (descMatch) {
        description =
          descMatch[1] !== undefined
            ? descMatch[1]
            : interpolateTemplate(descMatch[2], vars);
      }
    }
  }
  if (!description || description.length < 20) return null;

  // 2. Input Schema.Struct({ ... }) before Output definition.
  const beforeOutput = source.split(/const\s+(?:Structured)?Output\b/)[0] || source;
  const structMatch = beforeOutput.match(/Schema\.Struct\(\{([\s\S]*?)\}\)\s*(?:\n|;|$)/);
  if (!structMatch) return null;

  const properties = {};
  const required = [];
  const fieldRe =
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([\s\S]*?\.annotate\(\{\s*description\s*:\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*,?\s*\}\))/g;
  let fm;
  while ((fm = fieldRe.exec(structMatch[1])) !== null) {
    const key = fm[1];
    const expr = fm[2];
    const fieldDesc =
      fm[3] !== undefined ? fm[3] : interpolateTemplate(fm[4] || "", vars);

    const isOptional =
      expr.includes("Schema.optionalKey") ||
      expr.includes(".fields.offset") ||
      expr.includes(".fields.limit");

    const prop = {};
    if (/Boolean/.test(expr)) {
      prop.type = "boolean";
    } else if (/NonNegativeInt|\.fields\.(?:offset|limit)/.test(expr)) {
      prop.type = "integer";
      prop.minimum = 0;
    } else if (/PositiveInt/.test(expr)) {
      prop.type = "integer";
      prop.minimum = 1;
    } else if (/Schema\.(?:Int|Number)/.test(expr)) {
      prop.type = "integer";
    } else {
      prop.type = "string";
    }
    if (fieldDesc) prop.description = fieldDesc;

    properties[key] = prop;
    if (!isOptional) required.push(key);
  }

  if (Object.keys(properties).length === 0) return null;

  return {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/**
 * Extract session ID, User-Agent template, headers, and tool schemas from
 * upstream source files.
 */
function extractRecipe(files = {}) {
  const out = {};

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

  const sessionId = files.sessionId;
  if (typeof sessionId === "string") {
    const prefix = sessionId.match(/make\(\s*"([a-z]+_)"\s*\+\s*descending/);
    if (prefix) out.sessionPrefix = prefix[1];
  }

  const app = files.app;
  if (typeof app === "string") {
    const tpl = app.match(/return\s+`(opencode\/[^`]+)`/);
    if (tpl) out.userAgentTemplate = tpl[1];
  }

  const modelRequest = files.modelRequest;
  if (typeof modelRequest === "string") {
    const block = modelRequest.match(/headers:\s*\{([\s\S]{0,2000}?)\n\s{8}\}/);
    if (block) {
      // Split by line so a conditional spread can be told apart from a header
      // that is always sent. Upstream writes parent-session headers as
      // `...(session.parentID ? { "x-parent": ... } : {})`, which this bridge
      // has no value for — reporting those as missing would be a false alarm.
      const required = [];
      const optional = [];
      const seen = new Set();
      for (const line of block[1].split("\n")) {
        const nameMatch = line.match(/"([A-Za-z][A-Za-z0-9-]*)":/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        const key = name.toLowerCase();
        if (key.length === 0 || key.length >= 64 || seen.has(key)) continue;
        seen.add(key);
        // A spread guarded by a ternary is conditional.
        if (line.trim().startsWith("...") && line.includes("?")) optional.push(name);
        else required.push(name);
      }
      if (required.length > 0) out.headers = required;
      if (optional.length > 0) out.optionalHeaders = optional;
    }
  }

  const extractedTools = {};
  const readDef = extractToolFromSource(files.readTool, "read");
  if (readDef) {
    extractedTools[readDef.name] = {
      description: readDef.description,
      parameters: readDef.parameters,
    };
  }
  const shellDef = extractToolFromSource(files.shellTool, "shell");
  if (shellDef) {
    extractedTools[shellDef.name] = {
      description: shellDef.description,
      parameters: shellDef.parameters,
    };
  }
  if (Object.keys(extractedTools).length > 0) {
    out.tools = extractedTools;
  }

  return out;
}

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

function applyRecipe(update = {}, tag = null) {
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
    const probe = buildUserAgent({ ...next, userAgentTemplate: update.userAgentTemplate });
    if (/^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/.test(probe)) {
      if (probe !== buildUserAgent(recipe)) changed.push("userAgentTemplate");
      next.userAgentTemplate = update.userAgentTemplate;
    }
  }

  if (Array.isArray(update.headers) && update.headers.length > 0) {
    const incoming = update.headers.map(String);
    const same =
      incoming.length === next.headers.length &&
      incoming.every((h, i) => h.toLowerCase() === next.headers[i].toLowerCase());
    if (!same) {
      next.headers = incoming;
      changed.push("headers");
    }
  }

  if (Array.isArray(update.optionalHeaders)) {
    optionalHeaders = update.optionalHeaders.map(String);
  }

  if (update.tools && typeof update.tools === "object") {
    // The extracted set *replaces* the previous one rather than merging into
    // it. Merging would keep a tool upstream has renamed or removed forever,
    // so the wire shape could never converge on what the release actually
    // ships — the opposite of adapting.
    const nextTools = { ...update.tools };
    if (Object.keys(nextTools).length > 0) {
      if (stableStringify(nextTools) !== stableStringify(getTools())) {
        changed.push("tools");
      }
      toolProfile = nextTools;
      toolProfileSource = "source";
      toolProfileVersion = next.version;
    }
  }

  if (changed.length > 0) {
    recipe = next;
  }
  if (tag) lastSourceTag = tag;
  return changed;
}

// --- Refresh & Reactive Self-Heal --------------------------------------------

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.force]    Adopt whatever the handshake reports, even in
 *                                  reactive mode and even when the version has
 *                                  not moved (the gate can move without a bump).
 *                                  Used by the gate-rejection self-heal.
 * @param {boolean} [opts.recheck]  Skip the freshness guard and consult the
 *                                  handshake now, but still respect UPDATE_MODE
 *                                  when deciding whether to adopt. Used by the
 *                                  periodic CLI-version poll.
 */
async function refresh({ force = false, recheck = false } = {}) {
  if (process.env.OPENCODE_USER_AGENT) {
    return { updated: false, reason: "pinned" };
  }
  if (!force && !recheck && Date.now() - lastCheckTime < IDENTITY_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const release = await resolveRelease(recipe.version);
      const latest = release.version;
      if (!latest) throw new Error(release.error || "handshake resolved no version");

      lastCheckTime = Date.now();
      lastRefreshError = release.stale ? release.error || "handshake stale" : null;

      const cmp = compareVersions(latest, recipe.version);
      if (cmp < 0) {
        return {
          updated: false,
          version: recipe.version,
          reason: `newer-local:${recipe.version}`,
        };
      }

      const updateMode = getUpdateMode();
      const forcedByUpstream = release.minimum === true;
      const shouldAdopt = cmp > 0 && (force || updateMode === "always" || forcedByUpstream);

      if (cmp === 0 && !force) {
        return {
          updated: false,
          version: recipe.version,
          reason: "up-to-date",
        };
      }
      if (cmp > 0 && !shouldAdopt) {
        // Reactive mode: remember that a release exists without adopting it.
        // The next gate rejection forces a refresh, which flips shouldAdopt.
        lastAvailable = latest;
        return {
          updated: false,
          version: recipe.version,
          available: latest,
          reason: `available-not-adopted:${updateMode}`,
        };
      }
      lastAvailable = null;

      const ref = sourceRef(release);
      const update = { version: latest };
      let sourceRead = false;

      const settled = await Promise.allSettled(
        Object.entries(SOURCE_FILES).map(async ([key, filePath]) => [
          key,
          await fetchText(`${SOURCE_BASE}/${ref}/${filePath}`, SOURCE_TIMEOUT_MS),
        ])
      );
      const fetchedFiles = {};
      for (const item of settled) {
        if (item.status === "fulfilled") {
          fetchedFiles[item.value[0]] = item.value[1];
          sourceRead = true;
        }
      }
      if (sourceRead) {
        Object.assign(update, extractRecipe(fetchedFiles));
      }

      const changed = applyRecipe(update, ref);
      return {
        updated: changed.length > 0,
        changed,
        version: recipe.version,
        tag: ref,
        sourceRead,
        release: {
          version: release.version,
          sha: release.sha,
          source: release.source,
          minimum: release.minimum,
        },
      };
    } catch (err) {
      lastRefreshError = err.message || String(err);
      return { updated: false, error: lastRefreshError };
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Non-blocking freshness check on the request path.
 * - In `always` mode: kicks off a background handshake check after TTL expiry.
 * - In `reactive` mode: stays silent after initial check until a gate error occurs.
 */
function ensureFresh() {
  if (Date.now() - lastCheckTime < IDENTITY_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  if (getUpdateMode() === "reactive" && lastCheckTime > 0) {
    return { updated: false, reason: "reactive-idle" };
  }
  refresh().catch(() => {});
  return { updated: false, reason: "refreshing-in-background" };
}

/**
 * Reactive self-heal when upstream rejects our request with a CLI gate error
 * (403 FreeTierError or 426 UpgradeRequired).
 */
async function onGateRejection(status, errType, errMsg, attempted = false) {
  if (attempted) return { retry: false, reason: "already-retried" };

  const versionBefore = recipe.version;
  const toolsBefore = stableStringify(getTools());

  const floor = parseVersionFloor(errMsg);
  if (floor) {
    versionFloor = floor;
    if (compareVersions(recipe.version, floor) < 0) {
      applyRecipe({ version: floor }, lastSourceTag);
    }
  }

  const result = await refresh({ force: true });
  const toolsAfter = stableStringify(getTools());

  const learned =
    recipe.version !== versionBefore ||
    toolsAfter !== toolsBefore ||
    (result && Array.isArray(result.changed) && result.changed.length > 0);

  return {
    retry: learned,
    reason: floor
      ? `version-floor:${floor}`
      : learned
        ? `updated:${result?.version || recipe.version}`
        : "no-change",
    status,
    errType,
  };
}

// --- Fast Session ID Generator (Pooled CSPRNG) -------------------------------

let lastTimestamp = 0;
let counter = 0;
const MAX_COUNTER_PER_MS = 16;
const RAND_POOL_SIZE = 14 * 256;
const randPool = Buffer.allocUnsafe(RAND_POOL_SIZE);
let randPoolOffset = RAND_POOL_SIZE;

function nextRandomChars(chars, count) {
  if (randPoolOffset + count > RAND_POOL_SIZE) {
    crypto.randomFillSync(randPool);
    randPoolOffset = 0;
  }
  const len = chars.length;
  let out = "";
  for (let i = 0; i < count; i++) {
    out += chars[randPool[randPoolOffset + i] % len];
  }
  randPoolOffset += count;
  return out;
}

function createId(descending = true, timestamp = Date.now()) {
  const {
    sessionCharset: chars,
    sessionLength: length,
    sessionMultiplier: mult,
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
  return hex + nextRandomChars(chars, randomChars);
}

// --- Accessors & Tool Formatting ---------------------------------------------

function getRecipe() {
  return { ...recipe };
}

function getTools() {
  // An empty profile is not a profile. Without this guard `toolProfile || ...`
  // lets `{}` win (objects are truthy) and the bridge sends `tools: []`, which
  // upstream rejects with 403 — the exact failure the fingerprint exists to
  // avoid. An empty or malformed profile falls back to the shipped set.
  if (toolProfile && Object.keys(toolProfile).length > 0) return toolProfile;
  return DEFAULT_TOOLS;
}

/**
 * The upstream header names currently in force, in upstream's own order.
 * `server.js` builds its header object from this, so a header added upstream
 * starts being sent on the next request after a refresh.
 */
function getHeaderNames() {
  return Array.isArray(recipe.headers) ? recipe.headers.slice() : DEFAULT_RECIPE.headers.slice();
}

function getToolList(flat = false) {
  const profile = getTools();
  const available = Object.keys(profile);

  // A source-derived profile is sent whole. Filtering it through a hardcoded
  // name list would defeat the point of deriving it: if upstream renames
  // `shell`, the extractor records the new name but a fixed list would keep
  // sending the old one — adapting the recipe while silently dropping the
  // change from the wire. The core filter exists only for oversized profiles
  // (the retired capture path), where the extra tools cost prompt tokens.
  const ordered =
    toolProfileSource === "source" || available.length <= CORE_TOOL_NAMES.length
      ? available
      : CORE_TOOL_NAMES.filter((n) => profile[n]).length > 0
        ? CORE_TOOL_NAMES.filter((n) => profile[n])
        : available;

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

/**
 * Resolve the header names upstream's client sends to concrete values.
 *
 * Returns `{ headers, unsent }`. `unsent` lists names we know upstream sends
 * but whose value this bridge cannot derive — reported in `/health` instead of
 * being sent empty, because an empty required header is worse than a missing
 * one.
 */
const GATE_HEADER_VALUES = [
  "user-agent",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
];

function buildGateHeaders(ctx = {}) {
  const values = {
    "user-agent": ctx.userAgent,
    "x-opencode-client": ctx.client,
    "x-opencode-project": ctx.project,
    "x-opencode-session": ctx.sessionId,
    "x-opencode-session-id": ctx.sessionId,
    "x-session-affinity": ctx.sessionId,
    "x-session-id": ctx.sessionId,
  };
  const headers = {};
  const unsent = [];
  for (const name of getHeaderNames()) {
    const lower = String(name).toLowerCase();
    const value = values[lower];
    // Header names are case-insensitive. Emit one canonical spelling per name
    // so a change of case upstream cannot produce a duplicate key: `User-Agent`
    // keeps its conventional form, every `x-opencode-*` header stays lowercase.
    if (value === undefined) unsent.push(name);
    else headers[lower === "user-agent" ? "User-Agent" : lower] = value;
  }
  return { headers, unsent };
}

/**
 * Header names the current recipe asks for that this bridge has no value for.
 * Non-empty means upstream added a header whose value is not derivable from
 * the release source — the alert that a manual mapping is needed, since the
 * request will be sent without it.
 */
function getUnsentHeaders() {
  const known = new Set(GATE_HEADER_VALUES);
  const conditional = new Set(optionalHeaders.map((n) => String(n).toLowerCase()));
  return getHeaderNames().filter((n) => {
    const key = String(n).toLowerCase();
    // Conditional headers (parent-session lineage) are only sent by the CLI
    // when the session has a parent. This bridge never creates nested
    // sessions, so their absence is expected, not a gap to report.
    return !known.has(key) && !conditional.has(key);
  });
}

function getSessionPrefix() {
  return recipe.sessionPrefix || DEFAULT_RECIPE.sessionPrefix;
}

/** Session id with upstream's prefix, e.g. `ses_<12 hex><14 base62>`. */
function createSessionId(descending = true, timestamp = Date.now()) {
  return getSessionPrefix() + createId(descending, timestamp);
}

function getState() {
  return {
    recipe: getRecipe(),
    userAgent: getUserAgent(),
    updateMode: getUpdateMode(),
    lastCheckTime,
    ttlMs: IDENTITY_TTL_MS,
    versionFloor,
    lastRefreshError,
    lastSourceTag,
    release: lastRelease,
    available: lastAvailable,
    headers: getHeaderNames(),
    optionalHeaders: optionalHeaders.slice(),
    unsentHeaders: getUnsentHeaders(),
    inFlight: Boolean(refreshInFlight),
    tools: {
      source: toolProfileSource,
      version: toolProfileVersion,
      toolNames: Object.keys(getTools()),
    },
  };
}

function __reset() {
  recipe = { ...DEFAULT_RECIPE };
  toolProfile = null;
  toolProfileSource = "default";
  toolProfileVersion = DEFAULT_RECIPE.version;
  lastRelease = null;
  lastAvailable = null;
  lastCheckTime = 0;
  refreshInFlight = null;
  versionFloor = null;
  lastRefreshError = null;
  lastSourceTag = null;
  optionalHeaders = [];
  lastTimestamp = 0;
  counter = 0;
}

function __setLastCheckTime(v) {
  lastCheckTime = v;
}

/** Test hook: stage a session prefix without going through recipe validation. */
function __setSessionPrefix(prefix) {
  recipe = { ...recipe, sessionPrefix: String(prefix) };
}

function __setToolProfile(tools, source = "test") {
  toolProfile = tools;
  toolProfileSource = source;
  toolProfileVersion = recipe.version;
}

module.exports = {
  IDENTITY_TTL_MS,
   get UPDATE_MODE() {
    return getUpdateMode();
  },
  DEFAULT_RECIPE,
  DEFAULT_TOOLS,
  SOURCE_FILES,
  parseVersions,
  sortVersions,
  selectVersion,
  compareVersions,
  parseVersionFloor,
  sourceRef,
  resolveRelease,
  extractToolFromSource,
  extractRecipe,
  buildUserAgent,
  applyRecipe,
  refresh,
  ensureFresh,
  onGateRejection,
  createId,
  getUserAgent,
  getRecipe,
  getTools,
  getHeaderNames,
  getUnsentHeaders,
  buildGateHeaders,
  getSessionPrefix,
  createSessionId,
  getToolList,
  getState,
  __reset,
  __setLastCheckTime,
  __setSessionPrefix,
  __setToolProfile,
};
