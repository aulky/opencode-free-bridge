"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

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
