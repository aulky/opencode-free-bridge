"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseClientHello, capture } = require("../transport-fingerprint.js");

test("parseClientHello reads ciphers and extension order from raw bytes", async () => {
  // Use the runtime's own ClientHello: this asserts the parser against a real
  // record rather than a hand-built fixture, which is the only way the offsets
  // are actually verified.
  const fp = await capture();
  assert.ok(fp.ciphers.length > 0, "expected at least one cipher");
  assert.ok(fp.extensions.length > 0, "expected at least one extension");
  for (const c of fp.ciphers) assert.match(c, /^[0-9a-f]{4}$/);
  for (const e of fp.extensions) assert.match(e, /^[0-9a-f]{4}$/);
  assert.equal(fp.legacyVersion, "0x303", "TLS 1.2 legacy version in ClientHello");
});

test("parseClientHello rejects non-TLS input", () => {
  assert.throws(() => parseClientHello(Buffer.from("GET / HTTP/1.1\r\n\r\n")), /not a TLS handshake/);
});

test("the supported runtime's fingerprint matches the recorded baseline", async () => {
  // Bun is the supported runtime; Node is refused by the live gate. Under Node
  // this test documents the difference rather than failing, because CI runs the
  // suite on both to catch API breakage.
  const fs = require("fs");
  const path = require("path");
  const baselinePath = path.join(__dirname, "..", "transport-baseline.json");
  if (!fs.existsSync(baselinePath)) return;
  const base = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const fp = await capture();
  if (process.versions.bun) {
    assert.deepEqual(fp.ciphers, base.ciphers, "Bun's cipher list drifted from the baseline");
    assert.deepEqual(fp.extensions, base.extensions, "Bun's extension order drifted from the baseline");
  } else {
    assert.notDeepEqual(
      fp.ciphers,
      base.ciphers,
      "Node is expected to differ from the Bun baseline; if this passes, re-measure the gate"
    );
  }
});
