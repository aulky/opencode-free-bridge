# AGENTS.md: AI Agent Playbook for `opencode-free-bridge`

This file gives AI coding agents (OpenCode, Claude Code, Cursor, Codex, Cline, Aider, etc.) exact instructions for installing, running, connecting, troubleshooting, and modifying `opencode-free-bridge`.

---

## 1. Critical Rules (Read First)

1. **Runtime MUST be Bun (`bun server.js`).**
   - Do **not** run the production server under Node.js (`node server.js` intentionally exits with code `1`).
   - Reason: the official OpenCode CLI is compiled with Bun (BoringSSL). Upstream's free-tier gate inspects the TLS `ClientHello` fingerprint (17 ciphers, 12 extensions). Node.js (OpenSSL) offers 52 ciphers and is rejected with `403 FreeTierError`.
   - `ALLOW_NODE=1` is strictly for offline unit tests with mocked `fetch`, never for live traffic.
2. **Zero external dependencies.**
   - Do not run `npm install` or add packages to `package.json`. The bridge uses only built-in runtime modules.
3. **Never hardcode model IDs or aliases.**
   - Model availability changes frequently upstream. Always query `GET http://127.0.0.1:20129/v1/models` to see active free models.
   - Retired models (such as `cat-jam-free`, `muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free`, `step-5-preview-free`) return HTTP `404` by design.

---

## 2. Installing & Starting the Bridge for a User

### Option A: Standard system install (recommended for persistent background service)

Run the installer script. It installs `bun` if missing, places files in `~/.opencode-free-bridge`, migrates any legacy `node` service units to `bun`, and starts the `opencode-free-bridge` service (`systemd` on Linux, `launchd` on macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
```

If you are already inside a local clone of this repository, you can also run:

```bash
bash install.sh
```

Custom port or install directory:

```bash
PORT=20129 HOST=127.0.0.1 BINDIR="$HOME/.opencode-free-bridge" bash install.sh
```

### Option B: Run directly from this repository (foreground or custom process manager)

```bash
# Ensure bun is on PATH (check ~/.bun/bin/bun or ~/.local/bin/bun if not in default PATH)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun server.js
```

### Verify the server is healthy

```bash
# 1. Check health and derived OpenCode CLI identity
curl -s http://127.0.0.1:20129/health

# 2. List currently active free models
curl -s http://127.0.0.1:20129/v1/models

# 3. Verify Bun TLS ClientHello matches the OpenCode CLI baseline
bun transport-fingerprint.js --check

# 4. Send a test chat completion request
curl -s http://127.0.0.1:20129/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Reply with OK"}]}'
```

---

## 3. Connecting Clients & Gateways

Use these connection details in any OpenAI-compatible tool:

- **Base URL:** `http://127.0.0.1:20129/v1`
- **API Key:** `public` (or any non-empty string)
- **Chat Completions Endpoint:** `POST http://127.0.0.1:20129/v1/chat/completions`
- **Models Endpoint:** `GET http://127.0.0.1:20129/v1/models`

### Current active free models (also supports family shorthands)

Always verify via `GET /v1/models`. As of catalog sync `v2.3.10`:
- `mimo-v2.6-flash-free` (shorthand: `mimo`)
- `big-pickle` (shorthand: `big-pickle`)
- `beam-free` (shorthand: `beam`)
- `nemotron-3-ultra-free` (shorthand: `nemotron-free`)
- `nemotron-3.5-lightning-free`
- `nemotron-3.5-super-vl-free`
- `longcat-2.5-preview-free` (shorthand: `longcat`)
- `deepseek-v4.1-flash-free` (shorthand: `deepseek-flash`)
- `glm-5.3-flash-free` (shorthand: `glm-flash`)
- `space-bunny-free`

### Multi-host / VPS SSH tunnel setup (to bypass single-IP rate limits)

If the user has another machine or VPS running `opencode-free-bridge` on port `20129`, forward a local port via SSH and register both ports in their router (such as 9Router or LiteLLM):

```bash
ssh -N -L 127.0.0.1:20130:127.0.0.1:20129 user@remote-vps
```

---

## 4. Troubleshooting Guide for Agents

When a user reports an error, diagnose it using this decision table before changing any code or configuration:

| Symptom | Root Cause | Action to Take |
|---|---|---|
| `node server.js` exits with `opencode-free-bridge requires Bun` | Server was launched with Node.js instead of Bun | Launch with `bun server.js` (or run `bash install.sh` to rewrite the systemd/launchd service unit to use `bun`). |
| `HTTP 403 FreeTierError` returned to client **after** logs show `refreshing identity and retrying once with full tool set` | Upstream per-IP free-tier quota is temporarily exhausted on this network | **Do not modify headers or code.** Confirm by running `bun gate-drill.js`: if `upstream control` says `HTTP 403 -> gate CLOSED`, the IP itself is throttled by `opencode.ai` (the official `opencode` CLI binary fails with the exact same 403 on this IP). Wait for cooldown or use another IP/VPS tunnel. |
| `HTTP 429` or `BUSY` in `verify.js` | Upstream model capacity limit | Switch to another model ID from `GET /v1/models`. |
| `HTTP 404 Model '<id>' has been retired upstream` | Client requested a deprecated model (e.g. `cat-jam-free`, `muse-spark-*`, `step-5-preview-free`) | Fetch `GET /v1/models` and update the client configuration to use an active model ID. |
| `HTTP 404 Model '<id>' is not on OpenCode's free tier` | Client requested a paid model (e.g. `gpt-5.4`, `claude-sonnet-4-5`) | The bridge only serves zero-cost models (`cost.input === 0`). Pick a model from `GET /v1/models`. |
| Old `opencode-bridge.service` conflict on port `20129` | A legacy pre-v2 service unit is still running Node.js on port `20129` | Stop and remove the legacy unit (`systemctl --user disable --now opencode-bridge.service`), then run `bash install.sh`. |

---

## 5. Repository Architecture & Codebase Guide (For Contributors)

| File | Responsibility |
|---|---|
| `server.js` | HTTP server (`/v1/chat/completions`, `/v1/models`, `/health`), Bun runtime guard, session affinity cache, client tool aliasing (`read` -> `read_client`), SSE stream normalization (`reasoning_content`, `usage`, `finish_reason`), 403/426/404 reactive retry loop, and 6-hour self-updater (`checkAndApplyUpdate`). |
| `identity.js` | Adaptive OpenCode CLI synchronization: release handshake (`opencode.ai/update/api`), GitHub source fetcher (`identifier.ts`, `session-id.ts`, `app.ts`, `model-request.ts`, `tool/plugin/*.ts`, `codemode/tool.ts`), Effect Schema AST parser (`extractToolFromSource`), provider catalog parser & disk cache (`~/.opencode-free-bridge/cache/catalog.json`), and pooled CSPRNG session ID generator (`createSessionId`). |
| `token-budget.js` | Additive token budget calculation (`max(requested, 1024) + 4096` for reasoning models, `max(requested, 512)` for standard models), driven by catalog `modelFacts`. |
| `transport-fingerprint.js` | Captures the runtime's raw TLS `ClientHello` bytes against a local TCP listener and compares cipher suites and extension order against `transport-baseline.json`. |
| `gate-drill.js` | End-to-end self-healing drill suite (4 live drills + 6 deterministic offline drills including `full-corrupt`). |
| `verify.js` | Live model readiness checker (`bun verify.js` / `bun verify.js --quick`). |
| `install.sh` | Cross-platform installer and `node` -> `bun` service unit migrator for Linux (`systemd`) and macOS (`launchd`). |

### Mandatory verification before committing changes

Any code change in this repository must pass all three checks:

```bash
bun test test/*.test.js
bun transport-fingerprint.js --check
bun gate-drill.js
```
