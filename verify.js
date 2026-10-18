#!/usr/bin/env bun
/**
 * verify.js — self-check for opencode-free-bridge.
 *
 * Answers the only question a new user has: "does this actually work?"
 *
 *   bun verify.js          full check: every discovered model, real prompt
 *   bun verify.js --quick  one probe per model, faster
 *
 * Exit code is 0 when at least one model answers, 1 otherwise, so it can be
 * wired into CI or a post-install step.
 *
 * Upstream rate-limits individual models (HTTP 429, "Endpoint is
 * unavailable"), so a single failure is not fatal — the summary separates
 * "rate-limited" from "broken" and the exit code only depends on whether
 * anything worked.
 */

const http = require("http");

const PORT = parseInt(process.env.PORT || "20129", 10);
const RAW_HOST = process.env.HOST || "127.0.0.1";
const HOST = RAW_HOST === "0.0.0.0" || RAW_HOST === "::" ? "127.0.0.1" : RAW_HOST;
const BASE = `http://${HOST}:${PORT}`;
const QUICK = process.argv.includes("--quick");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};
const ok = (s) => `${C.green}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;

/**
 * Fold an SSE stream from the bridge into one Chat Completions object.
 *
 * Only the fields the verdict logic reads are rebuilt: `choices[0].message`
 * (content plus reasoning_content) and `usage`. Tool-call deltas are not needed
 * by a readiness probe, so they are ignored rather than reconstructed.
 */
function assembleSse(raw) {
  let content = "";
  let reasoning = "";
  let finish = null;
  let usage = null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const chunk = line.slice(5).trim();
    if (!chunk || chunk === "[DONE]") continue;
    let ev = null;
    try { ev = JSON.parse(chunk); } catch { continue; }
    // The bridge forwards an in-stream failure as an SSE error event.
    if (ev?.error) return { error: ev.error };
    const choice = ev?.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (ev?.usage) usage = ev.usage;
  }
  return {
    choices: [{ message: { role: "assistant", content, reasoning_content: reasoning }, finish_reason: finish }],
    usage,
  };
}

function request(method, path, body, timeoutMs = QUICK ? 25000 : 120000) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* non-JSON body */ }
          // The bridge always streams upstream, so a `stream: true` probe comes
          // back as SSE. Fold it into the same shape a non-streaming call would
          // return, so the verdict logic below reads one form only.
          if (!parsed && /^\s*data:/.test(data)) parsed = assembleSse(data);
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on("error", (err) => resolve({ status: 0, error: err.code || err.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// A reasoning model needs room to think before it answers. This mirrors the
// floor token-budget.js enforces, so the check exercises the real path.
const PROBE_MAX_TOKENS = QUICK ? 50 : 2000;

async function checkHealth() {
  const res = await request("GET", "/health", null, 10000);
  if (res.status !== 200 || !res.body) {
    return { ok: false, detail: res.error || `HTTP ${res.status}` };
  }
  return {
    ok: true,
    version: res.body.version,
    runtime: res.body.runtime || null,
    models: res.body.discoveredModels,
  };
}

async function listModels() {
  const res = await request("GET", "/v1/models", null, 15000);
  if (res.status !== 200 || !res.body?.data) return [];
  return res.body.data.map((m) => m.id);
}

async function probe(model) {
  const started = Date.now();
  // `stream: true` is not cosmetic. Measured from one IP, one process, one
  // header set: an upstream request without `stream` is refused with 403
  // FreeTierError while the identical request with `stream: true` succeeds
  // (6/6 vs 0/6, interleaved). Upstream treats a non-streaming call as
  // "not the real client". A probe that omits it therefore measures nothing
  // and reports the IP as blocked. The bridge always streams upstream and
  // normalises the SSE back to JSON for non-streaming clients, so this
  // matches what the bridge actually sends.
  const res = await request("POST", "/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: QUICK ? "Say OK" : "Write a Python function `add(a,b)` that returns their sum. Output only code." }],
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
  });
  const ms = Date.now() - started;

  if (res.status === 429) return { state: "ratelimited", ms };
  if (res.status === 403) {
    const msg = String(res.body?.error?.message || res.error || "");
    // The gateway refuses a perfectly healthy request with the same
    // `403 FreeTierError` when this IP's allowance is spent. Reporting that as
    // "FAIL / not answering" tells a new user their install is broken when it
    // is not, so it gets its own state and its own exit code.
    if (/free tier can only be used|FreeTierError/i.test(msg)) {
      return { state: "gate-closed", ms, detail: String(msg).slice(0, 90) };
    }
  }
  if (res.status === 426) {
    const msg = res.body?.error?.message || res.error || "HTTP 426";
    return { state: "upgrade-required", ms, detail: String(msg).slice(0, 90) };
  }
  if (res.status !== 200) {
    const msg = res.body?.error?.message || res.error || `HTTP ${res.status}`;
    return { state: "failed", ms, detail: String(msg).slice(0, 70) };
  }

  const message = res.body?.choices?.[0]?.message;
  const content = (message?.content || "").trim();
  const reasoning = (message?.reasoning_content || "").trim();

  if (!content && reasoning) {
    return { state: "thinking-only", ms, detail: `${reasoning.length} chars of reasoning, no answer` };
  }
  if (!content) return { state: "empty", ms };
  return { state: "ok", ms, chars: content.length, outTokens: res.body?.usage?.completion_tokens };
}

(async () => {
  console.log(`\n${C.bold}opencode-free-bridge — self check${C.reset}`);
  console.log(`${C.dim}${BASE}${C.reset}\n`);

  const health = await checkHealth();
  if (!health.ok) {
    console.log(`  ${bad("FAIL")} bridge not reachable: ${health.detail}`);
    console.log(`\n  Start it first:  ${C.cyan}bun server.js${C.reset}`);
    console.log(`  Or install it:   ${C.cyan}bash install.sh${C.reset}\n`);
    process.exit(1);
  }
  console.log(`  ${ok("OK")}  bridge v${health.version}, ${health.models} free models discovered\n`);

  const models = await listModels();
  if (models.length === 0) {
    console.log(`  ${warn("WARN")} no models listed at /v1/models — upstream may be unreachable`);
    console.log(`  ${C.dim}wait for discovery to complete, then try again${C.reset}\n`);
    process.exit(1);
  }

  // --quick answers one question: does this bridge work right now? The first
  // model that answers settles it. Probing all nine costs up to 120s each when
  // upstream is throttling, which made `install.sh` look hung for minutes.
  const toProbe = QUICK ? models.slice(0, 3) : models;
  console.log(
    `  Probing ${toProbe.length}${QUICK && models.length > toProbe.length ? " of " + models.length : ""} models${
      QUICK ? " (quick — stops at the first success)" : ""
    }...\n`
  );
  const results = [];
  for (const model of toProbe) {
    const r = await probe(model);
    results.push({ model, ...r });
    if (QUICK && r.state === "ok") break;
    const time = `${(r.ms / 1000).toFixed(1)}s`.padStart(6);
    if (r.state === "ok") {
      console.log(`  ${ok("OK")}   ${model.padEnd(36)} ${time}  ${C.dim}${r.chars} chars, ${r.outTokens} tokens${C.reset}`);
    } else if (r.state === "ratelimited") {
      console.log(`  ${warn("BUSY")} ${model.padEnd(36)} ${time}  ${C.dim}upstream rate limit, retry later${C.reset}`);
    } else if (r.state === "gate-closed") {
      console.log(`  ${warn("GATE")} ${model.padEnd(36)} ${time}  ${C.dim}this IP is outside the free-tier allowance${C.reset}`);
    } else if (r.state === "upgrade-required") {
      console.log(`  ${bad("UPGR")} ${model.padEnd(36)} ${time}  ${C.dim}${r.detail}${C.reset}`);
    } else if (r.state === "thinking-only") {
      console.log(`  ${bad("THINK")} ${model.padEnd(36)} ${time}  ${C.dim}${r.detail}${C.reset}`);
    } else if (r.state === "empty") {
      console.log(`  ${bad("EMPTY")} ${model.padEnd(36)} ${time}`);
    } else {
      console.log(`  ${bad("FAIL")} ${model.padEnd(36)} ${time}  ${C.dim}${r.detail}${C.reset}`);
    }
  }

  const counts = results.reduce((acc, r) => ((acc[r.state] = (acc[r.state] || 0) + 1), acc), {});
  const usable = counts.ok || 0;
  const blocked = (counts["gate-closed"] || 0) + (counts.ratelimited || 0);
  const broken = (counts["thinking-only"] || 0) + (counts.empty || 0) + (counts.failed || 0) + (counts["upgrade-required"] || 0);

  console.log(`\n${C.bold}Summary${C.reset}`);
  console.log(`  ${ok(String(usable))} usable, ${blocked} blocked by upstream (${counts["gate-closed"] || 0} gate-closed, ${counts.ratelimited || 0} rate-limited), ${broken} broken`);

  if (usable > 0) {
    console.log(`\n  ${ok("Bridge is working.")} Point any OpenAI-compatible client at ${C.cyan}${BASE}/v1${C.reset}\n`);
    process.exit(0);
  }

  if (blocked > 0 && broken === 0) {
    if (counts["gate-closed"] > 0) {
      if (typeof health.runtime === "string" && health.runtime.startsWith("node/")) {
        console.log(`\n  ${bad("Server is running on Node.js, not Bun.")}`);
        console.log(`  ${C.dim}The bridge reported runtime ${health.runtime}. Upstream rejects Node's TLS ClientHello with 403 FreeTierError.${C.reset}`);
        console.log(`  ${C.dim}Restart the bridge with Bun: ${C.reset}${C.cyan}bun server.js${C.reset}\n`);
        process.exit(1);
      }
      if (process.versions.bun) {
        let tlsDrift = null;
        try {
          const fs = require("fs");
          const path = require("path");
          const basePath = path.join(__dirname, "transport-baseline.json");
          if (fs.existsSync(basePath)) {
            const { capture, describe } = require("./transport-fingerprint");
            const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
            const now = describe(await capture());
            const sameCiphers = JSON.stringify(base.ciphers) === JSON.stringify(now.ciphers);
            const sameExts = JSON.stringify(base.extensions) === JSON.stringify(now.extensions);
            if (!sameCiphers || !sameExts) tlsDrift = { now, base };
          }
        } catch {}
        if (tlsDrift) {
          console.log(`\n  ${bad("TLS fingerprint drift detected.")}`);
          console.log(`  ${C.dim}This Bun runtime (${tlsDrift.now.runtime}) does not match the recorded OpenCode CLI baseline (${tlsDrift.base.runtime}).${C.reset}`);
          console.log(`  ${C.dim}Inspect: ${C.reset}${C.cyan}bun transport-fingerprint.js --check${C.reset}\n`);
          process.exit(1);
        }
      }
    }
    // Exit 2 is deliberately distinct from 1: the install is correct, the IP
    // is not currently allowed. The installer and CI can tell these apart.
    console.log(`\n  ${warn("Bridge is healthy, but upstream refused this IP.")}`);
    console.log(`  ${C.dim}The gateway answered every probe with its own free-tier refusal, not a bridge error.${C.reset}`);
    console.log(`  ${C.dim}The official OpenCode CLI gets the same answer from this network right now.${C.reset}`);
    console.log(`  ${C.dim}Wait for the allowance window to reset, or run the bridge on another host.${C.reset}`);
    console.log(`  ${C.dim}Re-check later: ${C.reset}${C.cyan}bun verify.js --quick${C.reset}\n`);
    process.exit(2);
  }

  console.log(`\n  ${bad("No model answered.")}`);
  console.log(`  ${C.dim}Check the bridge log for the upstream error, then retry.${C.reset}\n`);
  process.exit(1);
})();
