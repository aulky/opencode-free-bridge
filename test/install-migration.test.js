"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const INSTALLER = path.join(__dirname, "..", "install.sh");

function hasInstaller() {
  return fs.existsSync(INSTALLER);
}

test("installer requires Bun and refuses to fall back silently", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // A silent fallback to Node is what made old installs unfixable.
  assert.match(src, /Bun is required but not found/);
  assert.match(src, /ALLOW_NODE/);
  // Every runtime invocation must go through $RUNTIME, not a hardcoded node.
  const hardcoded = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .filter((l) => /\bnode\s+["']?\$?BINDIR/.test(l) || /nohup node /.test(l));
  assert.deepEqual(hardcoded, [], "installer still hardcodes node for execution");
});

test("installer fetches every file the runtime needs", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  for (const f of [
    "server.js",
    "identity.js",
    "token-budget.js",
    "verify.js",
    "gate-drill.js",
    "transport-fingerprint.js",
    "transport-baseline.json",
  ]) {
    assert.match(src, new RegExp(`fetch ${f.replace(".", "\\.")}`), `installer does not fetch ${f}`);
  }
});

test("installer backs up an existing install before overwriting", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /\.backup-v/);
  assert.match(src, /cp -p/);
});

test("installer rewrites a service unit that points at node", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /migrate_service_runtime/);
  assert.match(src, /ExecStart=/);
  assert.match(src, /\.bak/);
});

test("server refuses to start on Node without ALLOW_NODE", () => {
  // This is a Node-specific behaviour, so it needs a real `node` binary — under
  // Bun, process.execPath is Bun and the server would (correctly) start.
  let nodeBin = null;
  for (const candidate of ["/usr/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(candidate)) {
      nodeBin = candidate;
      break;
    }
  }
  if (!nodeBin) {
    try {
      nodeBin = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim() || null;
    } catch {
      nodeBin = null;
    }
  }
  if (!nodeBin) return; // no Node on this machine; nothing to assert

  const server = path.join(__dirname, "..", "server.js");
  const env = { ...process.env, PORT: "0" };
  delete env.ALLOW_NODE;
  let code = 0;
  let stderr = "";
  try {
    execFileSync(nodeBin, [server], { env, stdio: "pipe", timeout: 5000 });
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr || "");
  }
  assert.equal(code, 1, "Node must exit non-zero");
  assert.match(stderr, /requires Bun/);
  assert.match(stderr, /0\/6[\s\S]*6\/6/, "the message must cite the measurement");
});
