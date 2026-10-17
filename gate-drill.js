#!/usr/bin/env node
/**
 * gate-drill.js — prove the reactive self-heal against the *real* upstream gate.
 *
 * This is not a unit test. It deliberately starts the bridge in a state that
 * upstream rejects, sends one client request, and checks that the bridge heals
 * itself and the client still gets an answer. Nothing is mocked.
 *
 * Two drills, each mapped to a gate layer that was measured live:
 *
 *   version-floor   A User-Agent below the floor upstream advertises gets
 *                   `426 UpgradeRequired` naming the minimum version. The
 *                   bridge adopts that floor, refreshes from the handshake, and
 *                   replays the request.
 *
 *   legacy-shape    The v1.5.0 fingerprint — old ai-sdk User-Agent, old tool
 *                   names, old session prefix — is replayed through the current
 *                   bridge to confirm the access pattern is *not* what gates
 *                   the free tier. It is kept as the control: it proves the
 *                   bridge did not "fix" something that was never broken.
 *
 *   empty-tools     A profile that resolves to no tools makes upstream answer
 *                   `403 FreeTierError`. The bridge must fall back to the
 *                   shipped fingerprint instead of sending `tools: []`.
 *
 *   session-shape   The error this drill exists for:
 *                   `403 {"type":"error","error":{"type":"FreeTierError",
 *                    "message":"OpenCode's free tier can only be used from
 *                    within OpenCode. Download it at https://opencode.ai ..."}}`
 *                   Upstream reads that as "this is not the OpenCode client".
 *                   Measured cause: the session id's shape. `ses_` + 12 lowercase
 *                   hex + 14 base62 (exactly 30 chars) is accepted; a different
 *                   prefix, length, or case is not. A stale recipe mints the
 *                   wrong shape, so the bridge must re-mint after refreshing —
 *                   replaying the stale id fails identically.
 *
 * What this drill does NOT do: fuzz the gate. Every failing request is one the
 * bridge is about to heal, and the drills run sequentially with a small pause,
 * because upstream applies a per-IP cooldown after a burst of failures.
 *
 * Usage:
 *   node gate-drill.js            # both drills
 *   node gate-drill.js version    # one drill
 */

const http = require("http");

const DRILLS = [
  "version-floor",
  "legacy-shape",
  "empty-tools",
  "session-shape",
  "routing",
  "allowlist",
];

function ask(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(180000, () => req.destroy(new Error("client timeout")));
    req.write(payload);
    req.end();
  });
}

function content(res) {
  const msg = res.json?.choices?.[0]?.message;
  return (msg?.content || "").trim();
}

function line(ok, label, detail = "") {
  const mark = ok ? "OK  " : "FAIL";
  console.log(`  ${mark} ${label}${detail ? "  " + detail : ""}`);
}

async function waitHealthy(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await ask(port, { model: "big-pickle", messages: [{ role: "user", content: "ping" }] });
      if (res.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function drillVersionFloor({ identity, __syncUserAgent }) {
  console.log("\nversion-floor — UA below the advertised floor (426 UpgradeRequired)");
  const floorBefore = identity.getState().versionFloor;

  // Pretend this bridge predates the floor. The request path stays reactive, so
  // no proactive refresh is allowed to hide the rejection.
  identity.applyRecipe({ version: "1.0.0" });
  __syncUserAgent();
  identity.__setLastCheckTime(Date.now());

  const uaBefore = identity.getUserAgent();
  console.log(`  staged UA: ${uaBefore}`);
  console.log("  sending one request (upstream should reject it)…");

  const res = await ask(port(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });

  const state = identity.getState();
  const uaAfter = identity.getUserAgent();
  const healed = state.versionFloor && state.versionFloor !== floorBefore;

  console.log(`  upstream floor: ${state.versionFloor || "(none)"}`);
  console.log(`  UA after    : ${uaAfter}`);
  console.log(`  client saw  : HTTP ${res.status} ${JSON.stringify(content(res))}`);

  line(res.status === 200, "client received 200, not the gate error");
  line(content(res).length > 0, "client received real content");
  line(healed, "version floor was learned from the rejection");
  line(uaAfter !== uaBefore, "User-Agent moved off the rejected version");
  line(
    uaAfter.startsWith("opencode/latest/") && !uaAfter.includes("/1.0.0/"),
    "identity now follows the current release"
  );

  return res.status === 200 && content(res).length > 0 && healed;
}

async function drillLegacyShape({ identity, __syncUserAgent }) {
  console.log("\nlegacy-shape — the v1.5.0 access pattern, through the current bridge");
  console.log("  (control: this shape is accepted upstream, so it must keep working)");

  // v1.5.0 sent this User-Agent and these tool names. Replaying them proves the
  // current bridge is not relying on the *new* shape to pass — and that an old
  // shape does not need "healing" it never needed.
  const LEGACY_UA = "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
  process.env.OPENCODE_USER_AGENT = LEGACY_UA;
  __syncUserAgent();

  const res = await ask(port(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ],
  });

  delete process.env.OPENCODE_USER_AGENT;
  __syncUserAgent();

  console.log(`  legacy UA   : ${LEGACY_UA}`);
  console.log(`  client saw  : HTTP ${res.status} ${JSON.stringify(content(res))}`);

  line(res.status === 200, "legacy access pattern still accepted");
  line(content(res).length > 0, "legacy pattern returns real content");

  return res.status === 200 && content(res).length > 0;
}

async function drillEmptyTools({ identity }) {
  console.log("\nempty-tools — profile resolves to nothing (upstream 403 FreeTierError)");
  const before = identity.getToolList(false).map((t) => t.function.name);

  // An empty profile used to win over the shipped fallback (objects are
  // truthy), so the bridge sent `tools: []` and upstream answered 403.
  identity.__setToolProfile({}, "test");
  identity.__setLastCheckTime(Date.now());

  const res = await ask(port(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
  const after = identity.getToolList(false).map((t) => t.function.name);

  console.log(`  tools before: ${JSON.stringify(before)}`);
  console.log(`  tools after : ${JSON.stringify(after)}`);
  console.log(`  client saw  : HTTP ${res.status} ${JSON.stringify(content(res))}`);

  line(after.length > 0, "an empty profile falls back to the shipped tools");
  line(res.status === 200, "client received 200, not 403");
  line(content(res).length > 0, "client received real content");

  return after.length > 0 && res.status === 200 && content(res).length > 0;
}

async function drillSessionShape({ identity, __syncUserAgent, sessionCache }) {
  console.log("\nsession-shape — id upstream reads as \"not OpenCode\" (403 FreeTierError)");
  console.log("  measured rule: `ses_` + 12 lowercase hex + 14 base62 (30 chars)");

  // Drop the underscore from the prefix. Upstream rejects that deterministically
  // with the FreeTierError, while a correct id passes — the two differ only in
  // the prefix, so the drill isolates exactly the layer it claims to.
  const goodPrefix = identity.getSessionPrefix();
  identity.__setSessionPrefix("ses");
  __syncUserAgent();
  identity.__setLastCheckTime(Date.now());

  const staged = identity.createSessionId(true);
  console.log(`  staged id   : ${staged} (len ${staged.length}, prefix "ses")`);
  console.log("  sending one request (upstream should reject it as not-OpenCode)…");

  const res = await ask(port(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });

  const after = identity.createSessionId(true);
  const cached = [...sessionCache.values()].map((e) => e.sessionId);

  console.log(`  id after    : ${after} (len ${after.length}, prefix "${identity.getSessionPrefix()}")`);
  console.log(`  client saw  : HTTP ${res.status} ${JSON.stringify(content(res))}`);

  line(res.status === 200, "client received 200, not the FreeTierError");
  line(content(res).length > 0, "client received real content");
  line(identity.getSessionPrefix() === goodPrefix, "prefix restored by the refresh");
  line(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(after), "re-minted id matches the accepted shape");
  line(
    cached.every((id) => /^ses_/.test(id)),
    "no rejected id left in the session cache"
  );

  return (
    res.status === 200 &&
    content(res).length > 0 &&
    identity.getSessionPrefix() === goodPrefix
  );
}

/**
 * routing — the wire endpoint is read per request from the derived value.
 *
 * The whole point of deriving endpoints from the upstream catalog is that a
 * path migration upstream (the /zen/v1 → /inference/v1 move) must not need a
 * bridge release. This drill proves the read happens on the request path, not
 * at boot: it repoints the chat endpoint at a local fake *after* the bridge is
 * up, sends a request, and checks the fake received it.
 */
async function drillRouting({ identity }) {
  console.log("\nrouting — endpoint derived at request time, not frozen at boot");

  const received = [];
  const fake = http.createServer((req, res) => {
    received.push(req.url);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const fakePort = fake.address().port;

  const before = identity.getEndpoints().chatUrl;
  identity.applyRecipe({ chatUrl: `http://127.0.0.1:${fakePort}/inference/openai/v1/chat/completions` });

  const res = await ask(port(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });

  identity.applyRecipe({ chatUrl: before });
  await new Promise((resolve) => fake.close(resolve));

  console.log(`  endpoint before : ${before}`);
  console.log(`  endpoint staged : http://127.0.0.1:${fakePort}/inference/openai/v1/chat/completions`);
  console.log(`  fake received   : ${JSON.stringify(received)}`);
  console.log(`  client saw      : HTTP ${res.status} ${JSON.stringify(content(res))}`);

  line(received.length === 1, "the request went to the newly derived endpoint");
  line(
    received[0] === "/inference/openai/v1/chat/completions",
    "the full derived path was used, not the boot-time one"
  );
  line(res.status === 200, "client received 200");
  line(identity.getEndpoints().chatUrl === before, "endpoint restored after the drill");

  return received.length === 1 && res.status === 200;
}

/**
 * allowlist — tool names are derived from the release's tool sources.
 *
 * The gate validates which tools are present; the schemas are not compared.
 * This checks that a name learned from source reaches the wire in `full` scope
 * (the scope the gate-rejection retry uses) even when everything else is
 * unchanged, which is what makes an upstream rename self-healing.
 */
async function drillAllowlist({ identity }) {
  console.log("\nallowlist — source-derived tool names reach the wire");

  const before = identity.getState().toolNames;
  // Simulate upstream renaming `shell` → `run` in its tool sources.
  identity.applyRecipe({
    tools: {
      read: { description: "r".repeat(30), parameters: { type: "object", properties: {} } },
      run: { description: "x".repeat(30), parameters: { type: "object", properties: {} } },
    },
    toolNames: ["read", "run"],
  });

  const core = identity.getToolList(false).map((t) => t.function.name);
  const full = identity.getToolList(false, "full").map((t) => t.function.name);

  console.log(`  allowlist       : ${JSON.stringify(identity.getState().toolNames)}`);
  console.log(`  core scope wire : ${JSON.stringify(core)}`);
  console.log(`  full scope wire : ${JSON.stringify(full)}`);

  line(core.length > 0, "core scope still sends a gate anchor");
  line(full.includes("run"), "the renamed tool reaches the wire in full scope");
  line(!full.includes("shell"), "the retired name is not kept alive");

  identity.__setToolProfile(null, "default");
  identity.applyRecipe({ toolNames: before });

  return full.includes("run") && core.length > 0;
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const drills = wanted.length > 0 ? wanted : DRILLS;
  const unknown = drills.filter((d) => !DRILLS.includes(d));
  if (unknown.length > 0) {
    console.error(`unknown drill(s): ${unknown.join(", ")}\nknown: ${DRILLS.join(", ")}`);
    process.exit(2);
  }

  const srv = require("./server");
  const { server, identity, discoverModels, __syncUserAgent, sessionCache } = srv;

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const boundPort = server.address().port;
  port = () => boundPort;

  console.log(`gate drill — bridge v${srv.VERSION} on http://127.0.0.1:${boundPort}`);
  console.log("  live upstream, no mocks, sequential (upstream rate-limits failures)");

  await discoverModels();
  const models = srv.__getDiscoveryState().activeModels;
  console.log(`  discovered ${models.length} free models`);

  const results = [];
  for (const name of drills) {
    const DRILL_FNS = {
      "version-floor": drillVersionFloor,
      "legacy-shape": drillLegacyShape,
      "empty-tools": drillEmptyTools,
      "session-shape": drillSessionShape,
      routing: drillRouting,
      allowlist: drillAllowlist,
    };
    const fn = DRILL_FNS[name];
    // A cached session id from a previous drill would be reused for an
    // identical message and hide the condition being staged.
    sessionCache.clear();
    const ctx = { identity, __syncUserAgent, sessionCache };
    try {
      results.push([name, await fn(ctx)]);
    } catch (err) {
      console.log(`  FAIL ${name} threw: ${err.message}`);
      results.push([name, false]);
    }
    // Upstream cools down after bursts of failures; keep the drill gentle.
    await new Promise((r) => setTimeout(r, 3000));
  }

  server.close();

  console.log("\nSummary");
  for (const [name, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
}

let port = () => 0;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
