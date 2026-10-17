#!/usr/bin/env node
/**
 * probe.js — find out *what* the gate wants, when it rejects a request and
 * nothing we already know explains why.
 *
 * This is the last resort, and it is deliberately the most restricted module in
 * the bridge. Upstream counts failures per IP and applies a temporary cooldown
 * after a burst (the 9router#4837 thread documents this explicitly: "repeated
 * failures from one IP also trigger a temporary cooldown that masks the real
 * error, so don't panic-test 50 times in a row"). A probe loop that fires every
 * combination would therefore make the problem worse and hide the answer.
 *
 * The design follows from that:
 *
 *   - A hard budget: at most MAX_ATTEMPTS requests per invocation.
 *   - A cooldown after a failed batch: no probing again for COOLDOWN_MS.
 *   - A single-variable discipline: each attempt changes exactly one thing
 *     against the last known-good baseline, so a success names its own cause.
 *   - Success is adopted, failure is recorded. The result is a *diagnosis*
 *     first and a fix second.
 *
 * The candidate dimensions are the ones the gate has actually moved on, in the
 * order the 9router timeline showed them moving:
 *
 *   1. endpoint   /zen → /inference
 *   2. headers    x-opencode-client, then the session mirrors
 *   3. body       tools must be present
 *   4. tools      the exact definitions
 *   5. version    a raised floor (426, handled by identity.js before probing)
 *
 * Probing is off unless explicitly enabled (`PROBE_ENABLED=1`), because a bridge
 * that silently hammers a rate-limited upstream is worse than one that reports
 * "the gate moved, here is what I know".
 */

const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.PROBE_MAX_ATTEMPTS || "6", 10);
const DEFAULT_COOLDOWN_MS = parseInt(process.env.PROBE_COOLDOWN_MS || String(15 * 60 * 1000), 10);
const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || "30000", 10);

let cooldownUntil = 0;
let lastRun = null;
let attemptsThisWindow = 0;
let windowStart = 0;

function isEnabled() {
  return process.env.PROBE_ENABLED === "1";
}

function inCooldown(now = Date.now()) {
  return now < cooldownUntil;
}

/**
 * The baseline is the last request shape known to work: captured from a real
 * CLI when available, otherwise the profile the bridge is currently sending.
 */
function makeAttempt(baseline, change) {
  const attempt = {
    url: baseline.url,
    headers: { ...baseline.headers },
    body: JSON.parse(JSON.stringify(baseline.body)),
    label: change.label,
  };
  change.apply(attempt);
  return attempt;
}

/**
 * Build the ordered candidate list. Each entry changes exactly one dimension
 * relative to the baseline, so a PASS identifies its own cause.
 *
 * `available` describes what the caller already knows (a captured profile, the
 * current tool set), letting the list skip dimensions that are already correct.
 */
function buildCandidates(baseline, available = {}) {
  const candidates = [];
  const body = baseline.body || {};
  const headers = baseline.headers || {};

  // 1. Tools present at all.
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    if (available.tools && available.tools.length > 0) {
      candidates.push({
        label: "body.tools",
        apply: (a) => {
          a.body.tools = available.tools;
        },
      });
    }
  }

  // 2. The `x-opencode-client` header, which appeared in the first gate move.
  if (!headers["x-opencode-client"]) {
    candidates.push({
      label: "header.x-opencode-client",
      apply: (a) => {
        a.headers["x-opencode-client"] = "cli";
      },
    });
  }

  // 3. The session mirrors, added in the same move.
  const sessionHeaders = [
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
  ];
  const missingSession = sessionHeaders.filter((h) => !headers[h]);
  if (missingSession.length > 0) {
    candidates.push({
      label: `headers.session-mirrors:${missingSession.join(",")}`,
      apply: (a) => {
        const id = a.headers["x-opencode-session-id"] || available.sessionId || "ses_00000000000000000000000000";
        for (const h of missingSession) a.headers[h] = id;
      },
    });
  }

  // 4. The project header.
  if (!headers["x-opencode-project"]) {
    candidates.push({
      label: "header.x-opencode-project",
      apply: (a) => {
        a.headers["x-opencode-project"] = "global";
      },
    });
  }

  // 5. The endpoint lane.
  const url = String(baseline.url || "");
  if (url.includes("/zen/")) {
    candidates.push({
      label: "endpoint.inference",
      apply: (a) => {
        a.url = url.replace("/zen/", "/inference/");
      },
    });
  } else if (url.includes("/chat/completions")) {
    candidates.push({
      label: "endpoint.responses",
      apply: (a) => {
        a.url = url.replace("/chat/completions", "/responses");
      },
    });
  }

  // 6. Streaming, required on the free lane.
  if (body.stream !== true) {
    candidates.push({
      label: "body.stream",
      apply: (a) => {
        a.body.stream = true;
      },
    });
  }

  return candidates;
}

/**
 * Issue one attempt. Returns { ok, status, errorType, errorMessage }.
 * Never throws: a network error is a result like any other.
 */
async function send(attempt) {
  try {
    const res = await fetch(attempt.url, {
      method: "POST",
      headers: attempt.headers,
      body: JSON.stringify(attempt.body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      // Drain a little so the connection can be reused, then discard.
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      return { ok: true, status: res.status };
    }
    const text = await res.text().catch(() => "");
    let errorType = "";
    let errorMessage = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      errorType = j.error?.type || "";
      errorMessage = j.error?.message || errorMessage;
    } catch {
      // non-JSON body
    }
    return { ok: false, status: res.status, errorType, errorMessage };
  } catch (err) {
    return { ok: false, status: 0, errorType: "network", errorMessage: err.message };
  }
}

/**
 * Run the differential probe.
 *
 * Returns a report:
 *   { ran, reason, attempts: [{label, status, ok}], learned: {...}|null }
 *
 * `learned` is present only when an attempt passed — it names the single
 * dimension that fixed it, which the caller can then adopt permanently.
 */
async function run(baseline, available = {}, options = {}) {
  const now = Date.now();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  if (!isEnabled()) {
    return { ran: false, reason: "disabled", attempts: [], learned: null };
  }
  if (inCooldown(now)) {
    return {
      ran: false,
      reason: `cooldown:${Math.ceil((cooldownUntil - now) / 1000)}s`,
      attempts: [],
      learned: null,
    };
  }

  // Reset the attempt counter once per cooldown window.
  if (now - windowStart > cooldownMs) {
    windowStart = now;
    attemptsThisWindow = 0;
  }

  const candidates = buildCandidates(baseline, available).slice(0, maxAttempts);
  if (candidates.length === 0) {
    return { ran: false, reason: "nothing-to-vary", attempts: [], learned: null };
  }

  const attempts = [];
  let learned = null;

  for (const candidate of candidates) {
    if (attemptsThisWindow >= maxAttempts) {
      attempts.push({ label: candidate.label, skipped: "budget" });
      break;
    }
    const attempt = makeAttempt(baseline, candidate);
    const result = await send(attempt);
    attemptsThisWindow++;
    attempts.push({ label: candidate.label, ...result });

    if (result.ok) {
      learned = { dimension: candidate.label, attempt };
      break;
    }
    // A 429 or a 5xx is not a verdict on the shape — stop rather than attribute
    // someone else's failure to this dimension.
    if (result.status === 429 || result.status >= 500) {
      attempts.push({ label: candidate.label, note: "upstream-unavailable-stopping" });
      break;
    }
  }

  if (!learned) {
    // Failed batch: back off before anyone tries again.
    cooldownUntil = Date.now() + cooldownMs;
  }

  lastRun = {
    at: now,
    attempts,
    learned: learned ? learned.dimension : null,
    cooldownUntil: learned ? null : cooldownUntil,
  };

  return {
    ran: true,
    reason: learned ? "learned" : "no-candidate-worked",
    attempts,
    learned: learned ? learned.dimension : null,
    learnedAttempt: learned ? learned.attempt : null,
    cooldownUntil: learned ? null : cooldownUntil,
  };
}

function getState() {
  return {
    enabled: isEnabled(),
    cooldownUntil,
    cooldownRemainingMs: Math.max(0, cooldownUntil - Date.now()),
    attemptsThisWindow,
    lastRun,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
  };
}

function __reset() {
  cooldownUntil = 0;
  lastRun = null;
  attemptsThisWindow = 0;
  windowStart = 0;
}

module.exports = {
  isEnabled,
  inCooldown,
  buildCandidates,
  makeAttempt,
  send,
  run,
  getState,
  __reset,
};
