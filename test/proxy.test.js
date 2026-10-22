const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-proxy-test-"));
process.env.OPENCODE_BRIDGE_STATE_DIR = tmpDir;
delete process.env.UPSTREAM_PROXY_URL;

const proxy = require("../proxy");
const panel = require("../panel");
const srv = require("../server");

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function emptyStateDir() {
  // Describes run in order and each one's `after` cleans up, so this recreates
  // the directory instead of assuming an earlier suite left it in place.
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true });
}

describe("egress proxy", () => {
  beforeEach(() => {
    emptyStateDir();
    proxy.__reload();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts http and https proxies with optional percent-encoded credentials", () => {
    assert.deepEqual(proxy.parseProxyUrl("http://127.0.0.1:8080"), { ok: true, url: "http://127.0.0.1:8080" });
    assert.deepEqual(proxy.parseProxyUrl(" https://proxy.example.com:3128 "), {
      ok: true,
      url: "https://proxy.example.com:3128",
    });
    // Credentials keep their encoding: Bun decodes them for Proxy-Authorization.
    assert.equal(proxy.parseProxyUrl("http://us%40er:p%3Ass@host:8080").url, "http://us%40er:p%3Ass@host:8080");
    assert.equal(proxy.parseProxyUrl("http://user@host:8080").url, "http://user@host:8080");
    // Empty means direct egress, which is how the panel clears the setting.
    assert.deepEqual(proxy.parseProxyUrl("   "), { ok: true, url: "" });
  });

  it("refuses SOCKS and malformed URLs with a reason instead of failing inside a request", () => {
    const socks = proxy.parseProxyUrl("socks5://127.0.0.1:1080");
    assert.equal(socks.ok, false);
    assert.match(socks.error, /SOCKS5/);

    for (const bad of ["not a url", "http://", "http://host:8080/some/path", "ftp://host:21"]) {
      const parsed = proxy.parseProxyUrl(bad);
      assert.equal(parsed.ok, false, `${bad} must be refused`);
      assert.ok(parsed.error);
    }
  });

  it("persists the proxy to disk with owner-only permissions and never echoes credentials", () => {
    const saved = proxy.setProxyUrl("http://user:secret@10.0.0.5:8080");
    assert.equal(saved.ok, true);
    assert.equal(saved.mode, "proxy");
    assert.equal(saved.proxy, "10.0.0.5:8080");
    assert.equal(saved.hasCredentials, true);
    assert.equal(JSON.stringify(saved).includes("secret"), false, "describe() must not leak the password");

    const file = proxy.configFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).url, "http://user:secret@10.0.0.5:8080");

    // A fresh process reads the same file.
    proxy.__reload();
    assert.equal(proxy.getProxyUrl(), "http://user:secret@10.0.0.5:8080");
    assert.equal(proxy.describe().source, "file");
  });

  it("clearing the URL returns to direct egress and removes the file", () => {
    proxy.setProxyUrl("http://127.0.0.1:8080");
    const cleared = proxy.setProxyUrl("");
    assert.equal(cleared.ok, true);
    assert.equal(cleared.mode, "direct");
    assert.equal(proxy.getProxyUrl(), "");
    assert.equal(fs.existsSync(proxy.configFile()), false);
  });

  it("ignores a corrupt config file instead of refusing to boot", () => {
    fs.writeFileSync(proxy.configFile(), "{not json", "utf8");
    proxy.__reload();
    assert.equal(proxy.getProxyUrl(), "");
    assert.match(proxy.describe().error, /proxy\.json/);
  });

  it("lets UPSTREAM_PROXY_URL win and refuses runtime edits while it is set", () => {
    process.env.UPSTREAM_PROXY_URL = "http://env-proxy:9000";
    proxy.__reload();
    try {
      assert.equal(proxy.getProxyUrl(), "http://env-proxy:9000");
      assert.equal(proxy.describe().locked, true);
      const attempt = proxy.setProxyUrl("http://other:1");
      assert.equal(attempt.ok, false);
      assert.match(attempt.error, /UPSTREAM_PROXY_URL/);
      assert.equal(proxy.getProxyUrl(), "http://env-proxy:9000");
    } finally {
      delete process.env.UPSTREAM_PROXY_URL;
      proxy.__reload();
    }
  });

  it("injects proxy: into every fetch init, and only when one is configured", () => {
    assert.deepEqual(proxy.withProxy({ headers: { a: "b" } }), { headers: { a: "b" } });

    proxy.setProxyUrl("http://127.0.0.1:8080");
    assert.equal(proxy.withProxy({ signal: "s" }).proxy, "http://127.0.0.1:8080");
    // A caller that pins its own proxy keeps it.
    assert.equal(proxy.withProxy({ proxy: "http://pinned:1" }).proxy, "http://pinned:1");

    let seen = null;
    const original = global.fetch;
    global.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({}) };
    };
    try {
      proxy.netFetch("https://example.com/x", { method: "GET" });
    } finally {
      global.fetch = original;
    }
    assert.equal(seen.init.proxy, "http://127.0.0.1:8080");
    assert.equal(seen.init.method, "GET");
  });

  it("reports a proxy that cannot reach upstream, and the exit IP when it can", async () => {
    const original = global.fetch;
    try {
      global.fetch = async (url, init) => {
        if (String(url).includes("cdn-cgi/trace")) return { ok: true, text: async () => "ip=203.0.113.9\nloc=SG\n" };
        assert.equal(init.proxy, "http://127.0.0.1:8080");
        return { ok: true, status: 200 };
      };
      const ok = await proxy.testProxy("http://127.0.0.1:8080");
      assert.equal(ok.ok, true);
      assert.equal(ok.apiStatus, 200);
      assert.equal(ok.exitIp, "203.0.113.9");

      global.fetch = async (url) => {
        if (String(url).includes("cdn-cgi/trace")) throw new Error("tunnel refused");
        return { ok: false, status: 403 };
      };
      const refused = await proxy.testProxy("http://127.0.0.1:8080");
      assert.equal(refused.ok, false);
      assert.equal(refused.apiStatus, 403);
      assert.match(refused.error, /403/);
    } finally {
      global.fetch = original;
    }
  });
});

describe("proxy HTTP surface", () => {
  let port;
  let server;

  before(async () => {
    await new Promise((resolve) => {
      server = srv.server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("serves the panel at / and keeps /health as JSON", async () => {
    const page = await request(port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.raw, /<title>Proxy egress/);
    assert.match(page.raw, /id="proxy-url"/);
    assert.match(page.raw, /id="save"/);
    assert.match(page.raw, /aria-live="polite"/);

    const health = await request(port, "GET", "/health");
    assert.equal(health.status, 200);
    const body = JSON.parse(health.raw);
    assert.equal(body.status, "ok");
    assert.ok(body.egress.proxy);
    assert.equal(body.egress.proxy.mode, "direct");
  });

  it("round-trips the setting through /api/proxy without returning credentials", async () => {
    emptyStateDir();
    proxy.__reload();

    const saved = await request(port, "POST", "/api/proxy", { url: "http://u:p@127.0.0.1:3128" });
    assert.equal(saved.status, 200);
    const savedBody = JSON.parse(saved.raw);
    assert.equal(savedBody.mode, "proxy");
    assert.equal(savedBody.proxy, "127.0.0.1:3128");
    assert.equal(saved.raw.includes('"p"'), false);

    const read = await request(port, "GET", "/api/proxy");
    assert.equal(read.status, 200);
    assert.equal(JSON.parse(read.raw).mode, "proxy");

    const health = JSON.parse((await request(port, "GET", "/health")).raw);
    assert.equal(health.egress.proxy.mode, "proxy");
    assert.equal(health.egress.proxy.proxy, "127.0.0.1:3128");

    const cleared = await request(port, "POST", "/api/proxy", { url: "" });
    assert.equal(cleared.status, 200);
    assert.equal(JSON.parse(cleared.raw).mode, "direct");

    const bad = await request(port, "POST", "/api/proxy", { url: "socks5://127.0.0.1:1080" });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.raw).error, /SOCKS5/);

    const noUrl = await request(port, "POST", "/api/proxy", { proxy: "x" });
    assert.equal(noUrl.status, 400);
  });

  it("answers /api/proxy/test with the probe verdict", async () => {
    const original = global.fetch;
    try {
      global.fetch = async (url) => {
        if (String(url).includes("cdn-cgi/trace")) return { ok: true, text: async () => "ip=198.51.100.7\n" };
        return { ok: true, status: 200 };
      };
      const res = await request(port, "POST", "/api/proxy/test", { url: "http://127.0.0.1:3128" });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.raw);
      assert.equal(body.ok, true);
      assert.equal(body.exitIp, "198.51.100.7");
    } finally {
      global.fetch = original;
    }
  });
});

describe("panel document", () => {
  it("escapes config values so a crafted proxy string cannot inject markup", () => {
    const html = panel.renderPanel(
      { mode: "proxy", proxy: '<img src=x onerror="alert(1)">', source: "file", configPath: "/tmp/x", error: null },
      { version: "2.0.3", port: 20129 }
    );
    assert.equal(html.includes("<img src=x"), false);
    assert.match(html, /&lt;img src=x/);
  });

  it("ships no dead controls: every button has a matching listener", () => {
    const html = panel.renderPanel({ mode: "direct" });
    for (const id of ["save", "test", "direct"]) {
      assert.match(html, new RegExp(`id="${id}"`), `button ${id} missing`);
    }
    assert.match(html, /\$\("save"\)/);
    assert.match(html, /saveBtn\.addEventListener\("click"/);
    assert.match(html, /testBtn\.addEventListener\("click"/);
    assert.match(html, /directBtn\.addEventListener\("click"/);
    assert.match(html, /form\.addEventListener\("submit"/);
  });
});
