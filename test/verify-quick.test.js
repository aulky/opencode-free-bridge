"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const VERIFY = path.join(__dirname, "..", "verify.js");
const INSTALLER = path.join(__dirname, "..", "install.sh");

test("--quick stops at the first success instead of probing every model", () => {
  const src = fs.readFileSync(VERIFY, "utf8");
  // Regression: the installer called --quick and then waited on all nine models,
  // each with a 120s timeout. Worst case made `install.sh` look hung.
  assert.match(src, /if \(QUICK && r\.state === "ok"\) break;/, "quick mode must break on first success");
  assert.match(src, /QUICK \? models\.slice\(0, 3\)/, "quick mode must cap how many models it probes");
});

test("--quick uses a shorter per-request timeout", () => {
  const src = fs.readFileSync(VERIFY, "utf8");
  assert.match(src, /timeoutMs = QUICK \? 25000 : 120000/, "quick mode must not inherit the 120s timeout");
});

test("installer bounds its self-check with a timeout", () => {
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /timeout 120/, "installer must not wait forever on a throttled upstream");
  // The installer used to print "did not finish in 120s" for every non-zero
  // exit, including a fast, correct "this IP is throttled". It now reports the
  // actual outcome and only names a timeout for exit 124.
  assert.match(src, /124\)/, "installer must explain a genuinely timed-out self-check");
  assert.match(src, /CHECK_RC/, "installer must inspect the self-check exit code");
  assert.doesNotMatch(
    src,
    /verify\.js" --quick \|\| \\\n\s+warn "self-check did not finish/,
    "installer must not report every failure as a timeout"
  );
});

test("installer detaches the bridge without a subshell", () => {
  const src = fs.readFileSync(INSTALLER, "utf8");
  // Regression: `( cd ... && nohup ... & )` leaves bash waiting on the child, so
  // a piped installer blocked until the bridge exited. Measured 70s in a minimal
  // repro and 102s on a real install; the pushd+setsid form finishes in 0.004s.
  assert.doesNotMatch(
    src,
    /\(\s*cd[^)]*&\s*\)/,
    "installer must not background the bridge inside a subshell"
  );
  assert.match(src, /pushd "\$BINDIR"/, "installer must change directory without forking");
  assert.match(src, /setsid env PORT=/, "installer must detach into a new session");
  assert.match(src, /<\/dev\/null/, "detached bridge must not inherit the caller's stdin");
});

test("verify maps a labeled abuse block to GATE (exit 2) and a shape rejection to FAIL (exit 1)", async () => {
  const abuse =
    "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account.";

  const runAgainst = (gateHeader) =>
    new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const pathname = String(req.url || "").split("?")[0];
        if (pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ status: "ok", version: "2.0.2", runtime: "bun/1.4.2", discoveredModels: 1 }));
        }
        if (pathname === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "fake-free" }] }));
        }
        if (req.method === "POST" && pathname === "/v1/chat/completions") {
          const headers = { "Content-Type": "application/json" };
          if (gateHeader) headers["x-opencode-gate"] = gateHeader;
          res.writeHead(403, headers);
          return res.end(JSON.stringify({ error: { type: "FreeTierError", message: abuse } }));
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        const child = spawn(process.execPath, [VERIFY, "--quick"], {
          env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (err) => {
          server.close();
          reject(err);
        });
        child.on("close", (code) => {
          server.close();
          resolve({ code, stdout, stderr });
        });
      });
    });

  // The bridge labels the refusal, so the verdict does not depend on wording.
  const labeled = await runAgainst("ip-abuse");
  assert.equal(labeled.code, 2, labeled.stdout + labeled.stderr);
  assert.match(labeled.stdout, /GATE/);
  assert.match(labeled.stdout, /Bridge is healthy, but upstream refused this IP/);

  // A bridge predating the header must still be classified by the message.
  const unlabeled = await runAgainst(null);
  assert.equal(unlabeled.code, 2, unlabeled.stdout + unlabeled.stderr);
  assert.match(unlabeled.stdout, /GATE/);

  // The same message with a shape-rejected label is a bridge bug, not the IP.
  const shape = await runAgainst("shape-rejected");
  assert.equal(shape.code, 1, shape.stdout + shape.stderr);
  assert.match(shape.stdout, /FAIL/);
  assert.doesNotMatch(shape.stdout, /Bridge is healthy/);
});
