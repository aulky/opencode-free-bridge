#!/usr/bin/env node
/**
 * capture.js — record what the real OpenCode CLI sends, by pretending to be a
 * model provider.
 *
 * The static extraction in artifact.js reads the shipped package and derives a
 * tool profile from it. That is accurate, but it is still an inference: it
 * assumes the CLI sends the definitions verbatim, and it cannot see values the
 * CLI computes at runtime.
 *
 * This module removes the inference. It starts a local HTTP server that speaks
 * just enough of the OpenAI protocol to keep the CLI happy, points an isolated
 * CLI instance at it with `OPENCODE_CONFIG`, and records the request the CLI
 * actually emits:
 *
 *   { url, headers, body: { tools: [...], ... } }
 *
 * That recording is ground truth. It is also the fastest way to answer "what
 * changed?" after a gate move: diff the capture against the previous one and the
 * delta is exactly the new requirement.
 *
 * Safety:
 *   - The CLI runs with a throwaway config file, so the user's own config is
 *     never modified.
 *   - The provider is a loopback address, so no credentials or traffic leave
 *     the machine.
 *   - The fake response is a minimal SSE stream; the CLI stops after it.
 *   - A hard timeout kills the child if it hangs.
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const CAPTURE_TIMEOUT_MS = parseInt(process.env.CAPTURE_TIMEOUT_MS || "120000", 10);
const CAPTURE_PROVIDER_ID = "bridge-capture";
const CAPTURE_MODEL_ID = "capture";

function cacheDir() {
  return (
    process.env.OPENCODE_BRIDGE_CACHE ||
    path.join(os.homedir(), ".opencode-free-bridge", "cache")
  );
}

function profilePath() {
  return path.join(cacheDir(), "capture.json");
}

/**
 * A minimal SSE chat-completion response. The CLI only needs a well-formed
 * stream that ends with [DONE]; it discards the content.
 */
function writeFakeCompletion(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "capture-0",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: CAPTURE_MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.write(chunk({ role: "assistant", content: "ok" }, null));
  res.write(chunk({}, "stop"));
  res.write(
    `data: ${JSON.stringify({
      id: "capture-0",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: CAPTURE_MODEL_ID,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Start the capture server on an ephemeral loopback port.
 * Resolves with { server, port, captured } where `captured` is a promise that
 * settles with the first recorded POST body.
 */
function startCaptureServer() {
  let settle;
  let reject;
  const captured = new Promise((resolve, rejectFn) => {
    settle = resolve;
    reject = rejectFn;
  });

  const server = http.createServer((req, res) => {
    // Model discovery: the CLI lists models before the first completion.
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: CAPTURE_MODEL_ID,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: "capture",
              name: "Capture",
            },
          ],
        })
      );
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }

      // Only the first completion request is the capture target. Later requests
      // (retries, follow-ups) are answered but not recorded.
      if (parsed && parsed.tools) {
        settle({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: parsed,
          capturedAt: Date.now(),
        });
      }

      writeFakeCompletion(res);
    });
  });

  return new Promise((resolve, rejectFn) => {
    server.on("error", rejectFn);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, captured });
    });
  });
}

/**
 * Write an isolated CLI config that routes one provider at the capture server.
 * `OPENCODE_CONFIG` makes the CLI read this instead of the user's config, so
 * nothing global is touched.
 */
function writeCaptureConfig(dir, port) {
  const configPath = path.join(dir, "opencode.json");
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [CAPTURE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bridge Capture",
        options: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "capture",
        },
        models: {
          [CAPTURE_MODEL_ID]: { name: "Capture" },
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Locate the CLI binary.
 *
 * Two installs commonly coexist and they are NOT interchangeable:
 *   - the npm package (`opencode-ai`) on PATH, which reads `OPENCODE_CONFIG`
 *   - the standalone v2 binary in `~/.opencode/bin`, which resolves models
 *     through a different path and rejects a config-only provider
 *
 * PATH comes first for that reason: it is the install the user actually runs,
 * and the one whose request shape we want to copy. `OPENCODE_BIN` overrides.
 */
function findCli() {
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) return explicit;

  // Resolve the first `opencode` on PATH.
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "opencode");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }

  const fallback = path.join(os.homedir(), ".opencode", "bin", "opencode");
  try {
    fs.accessSync(fallback, fs.constants.X_OK);
    return fallback;
  } catch {
    return "opencode";
  }
}

/**
 * Run the CLI once against the capture server.
 * Resolves with the captured request, or throws with a readable reason.
 */
async function runCapture({ cli, timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
  const bin = cli || findCli();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-capture-"));
  const { server, port, captured } = await startCaptureServer();
  const configPath = writeCaptureConfig(dir, port);

  const child = spawn(
    bin,
    ["run", "--model", `${CAPTURE_PROVIDER_ID}/${CAPTURE_MODEL_ID}`, "hi"],
    {
      env: {
        ...process.env,
        OPENCODE_CONFIG: configPath,
        // Keep the child from reaching out to the update service or telemetry
        // while we only want the request shape.
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, timeoutMs);

  const closed = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(-1));
  });

  try {
    // Whichever comes first: a capture, or the child exiting.
    const result = await Promise.race([
      captured,
      closed.then((code) => {
        throw new Error(
          `CLI exited (code ${code}) before sending a request. ` +
            `stderr: ${stderr.trim().slice(0, 400) || "(empty)"}`
        );
      }),
    ]);
    return { ...result, cli: bin, stderr: stderr.trim().slice(0, 400) };
  } finally {
    clearTimeout(timer);
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Distil a raw capture into the profile the bridge consumes: the tool list,
 * the header set, and the endpoint path — the three things the gate checks.
 */
function toProfile(capture) {
  const body = capture.body || {};
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const headers = capture.headers || {};

  // Normalise both wire shapes into one: chat-completions nests the definition
  // under `function`, the Responses API puts it at the top level.
  const normalised = tools
    .map((t) => {
      const def = t && t.function && typeof t.function === "object" ? t.function : t;
      if (!def || typeof def.name !== "string") return null;
      return {
        name: def.name,
        description: def.description || "",
        parameters: def.parameters || def.inputSchema || { type: "object", properties: {} },
      };
    })
    .filter(Boolean);

  // Headers the CLI actually sends, minus the ones that are per-request noise.
  const IGNORED = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "content-type",
  ]);
  const headerNames = Object.keys(headers).filter((h) => !IGNORED.has(h.toLowerCase()));

  return {
    capturedAt: capture.capturedAt || Date.now(),
    cli: capture.cli || null,
    endpoint: capture.url || null,
    toolNames: normalised.map((t) => t.name),
    tools: Object.fromEntries(normalised.map((t) => [t.name, t])),
    headerNames,
    // Sample values for the headers whose shape the gate validates. Values are
    // kept only where they are structural (a session id), never credentials.
    headerSamples: Object.fromEntries(
      headerNames
        .filter((h) => /session|user-agent|client|project|affinity/i.test(h))
        .map((h) => [h, String(headers[h]).slice(0, 128)])
    ),
  };
}

/**
 * Capture and persist. Returns { profile, path }.
 * On failure, returns { error } instead of throwing — a missing CLI must not
 * take the bridge down.
 */
async function captureAndSave(options = {}) {
  try {
    const capture = await runCapture(options);
    const profile = toProfile(capture);
    const target = profilePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(profile, null, 2));
    return { profile, path: target };
  } catch (err) {
    return { error: err.message };
  }
}

/** Read the saved capture profile, or null. */
function loadProfile() {
  try {
    return JSON.parse(fs.readFileSync(profilePath(), "utf8"));
  } catch {
    return null;
  }
}

function getState() {
  const p = loadProfile();
  return {
    available: Boolean(p),
    path: profilePath(),
    capturedAt: p ? p.capturedAt : null,
    toolNames: p ? p.toolNames : null,
    cli: p ? p.cli : null,
  };
}

module.exports = {
  CAPTURE_PROVIDER_ID,
  CAPTURE_MODEL_ID,
  profilePath,
  startCaptureServer,
  writeCaptureConfig,
  findCli,
  runCapture,
  toProfile,
  captureAndSave,
  loadProfile,
  getState,
};
