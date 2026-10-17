#!/usr/bin/env node
/**
 * verify.js — self-check for opencode-free-bridge.
 *
 * Answers the only question a new user has: "does this actually work?"
 *
 *   node verify.js          full check: every discovered model, real prompt
 *   node verify.js --quick  one probe per model, faster
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
const HOST = process.env.HOST || "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const QUICK = process.argv.includes("--quick");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};
const ok = (s) => `${C.green}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;

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
  const res = await request("POST", "/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: QUICK ? "Say OK" : "Write a Python function `add(a,b)` that returns their sum. Output only code." }],
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
  });
  const ms = Date.now() - started;

  if (res.status === 429) return { state: "ratelimited", ms };
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
    console.log(`\n  Start it first:  ${C.cyan}node server.js${C.reset}`);
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

  console.log(`\n${C.bold}Summary${C.reset}`);
  console.log(`  ${ok(String(usable))} usable, ${counts.ratelimited || 0} rate-limited, ` +
              `${(counts["thinking-only"] || 0) + (counts.empty || 0) + (counts.failed || 0)} not answering`);

  if (usable === 0) {
    console.log(`\n  ${bad("No model answered.")}`);
    console.log(`  ${C.dim}If every line says BUSY, the upstream free tier is throttling this IP.${C.reset}`);
    console.log(`  ${C.dim}Running the bridge from another host (a VPS, a laptop) changes the IP seen upstream.${C.reset}\n`);
    process.exit(1);
  }

  console.log(`\n  ${ok("Bridge is working.")} Point any OpenAI-compatible client at ${C.cyan}${BASE}/v1${C.reset}\n`);
  process.exit(0);
})();
