# opencode-free-bridge

OpenAI-compatible API bridge for [OpenCode](https://opencode.ai) free-tier models — no account, no API key required.

Exposes a local `/v1/chat/completions` endpoint that any OpenAI-compatible client (9Router, Cursor, Continue, VS Code, the OpenAI SDK) can use directly.

## Features

- **Self-healing client identity** — the free tier only serves requests from the OpenCode client, and that check keeps moving. The bridge derives its mask from OpenCode's public source at the current release tag, re-checks lazily on request, and heals itself when upstream rejects it. No manual update when the gate moves.
- **Automatic model discovery** — the free-model list is fetched from the upstream gateway at startup and refreshed hourly. New models appear without a code change; retired ones disappear.
- **Dual-protocol routing** — Meta Muse models are routed to the Responses API, everything else to Chat Completions.
- **Reasoning-aware token budgeting** — reasoning tokens count against the output budget. The bridge enforces a floor so short requests still return content instead of an empty response.
- **Reasoning content support** — thinking models preserve their reasoning in `reasoning_content` for both streaming and non-streaming clients.
- **Zero dependencies** — Node.js standard library only.

## Requirements

- Node.js >= 18

## Install & Update

```bash
curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
```

The installer places the bridge in `~/.opencode-free-bridge`, registers a boot service (systemd on Linux, launchd on macOS), starts it, and runs a self-check.

To update to the latest release at any time, re-run the install command above (or `git pull && systemctl restart opencode-free-bridge`).
Options:

```bash
PORT=3000 BINDIR=/opt/opencode-free-bridge bash install.sh   # different port or location
NO_SERVICE=1 bash install.sh                                 # skip the boot service
```

### Manual

```bash
git clone https://github.com/azrinaldi/opencode-free-bridge
cd opencode-free-bridge
node server.js
```

The bridge listens on `http://127.0.0.1:20129` by default.

## Test & Verify

```bash
npm test                # offline unit & HTTP contract tests (no network)
node verify.js          # live check: every model, real prompt
node verify.js --quick  # live check: one short probe per model
npm run drill           # live gate drill: prove the self-heal actually heals
```

`npm run drill` deliberately starts the bridge in a state upstream rejects, sends
one request, and checks the client still gets an answer. It is the only test
that exercises the gate path against the real service:

| Drill | What it stages | What it proves |
|---|---|---|
| `version-floor` | a User-Agent below the advertised floor | `426 UpgradeRequired` → floor learned → identity refreshed → request replayed |
| `empty-tools` | a tool profile that resolves to nothing | the bridge falls back to the shipped fingerprint instead of sending `tools: []` |
| `session-shape` | a session-id prefix upstream does not recognise | `403 FreeTierError` → recipe re-derived → **fresh** id minted → stale id evicted from cache |
| `legacy-shape` | the pre-1.5.0 access pattern (control) | the old shape is *accepted* — the gate is not about the endpoint or version string |

```
  OK  bridge v1.5.0, 9 free models discovered

  Probing 9 models (quick)...

  OK   big-pickle                             1.5s  2 chars, 2 tokens
  OK   cat-jam-free                           1.0s  2 chars, 30 tokens
  OK   mimo-v2.6-flash-free                   2.8s  2 chars, 16 tokens
  OK   muse-spark-1.2-contributor-free        1.7s  2 chars, 156 tokens
  OK   muse-spark-1.3-contributor-free        1.4s  2 chars, 160 tokens
  OK   nemotron-3.5-lightning-free            2.9s  2 chars, 33 tokens
  OK   step-5-preview-free                    1.5s  2 chars, 18 tokens
  OK   longcat-2.5-preview-free               2.6s  2 chars, 23 tokens
  OK   space-bunny-free                       1.6s  2 chars, 23 tokens

Summary
  9 usable, 0 rate-limited, 0 not answering
```

`BUSY` indicates upstream throttling for the current IP, not a configuration problem.
## Usage

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:20129/v1` |
| API key | `public` (any value is accepted) |
| Model | any id returned by `/v1/models` |

### Via a gateway (recommended) — bridge = one connection

The bridge is a plain OpenAI-compatible upstream. In any gateway you add it
as a custom provider/connection, import `/v1/models`, and let the gateway own
fallback / load-balance / billing. The bridge itself holds no fallback list:
when upstream is unreachable `/v1/models` is honestly empty — retry the
import after discovery completes.

#### 9Router

1. Add a custom OpenAI-compatible provider:
   - **Base URL:** `http://127.0.0.1:20129/v1`
   - **API key:** `public` (any value is accepted)
   - **Prefix:** `zen`
   - **Model IDs:** leave empty, then **Import from /models endpoint**
2. Models appear as `zen/big-pickle`, `zen/muse-spark-1.3-contributor-free`, etc.
3. Optional but recommended: register each bridge host (laptop, VPS) as a
   separate connection, then set gateway fallback `zen/*` → your paid
   provider so a `BUSY` (upstream 429 on one IP) fails over automatically.

If the import returns zero models, the bridge hasn't reached upstream yet —
wait a minute and import again (`curl -s http://127.0.0.1:20129/v1/models`
shows the live list).

#### Other gateways (LiteLLM, Open WebUI, AnythingLLM, …)

Same three fields everywhere — base URL + `public` key + import models:

```yaml
# LiteLLM config.yaml example
model_list:
  - model_name: zen-big-pickle
    litellm_params:
      model: openai/big-pickle
      api_base: http://127.0.0.1:20129/v1
      api_key: public
```

In Open WebUI: Settings → Connections → `+` → Base URL
`http://127.0.0.1:20129/v1`, key `public`, fetch models.

### Direct in an agent / harness (no gateway)

Any harness that speaks OpenAI-compatible (Hermes, coding agents, your own
scripts) can point straight at the bridge — no gateway needed:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:20129/v1"
export OPENAI_API_KEY="public"   # any value works
export MODEL="big-pickle"        # any id from /v1/models
```

Own your fallback in the harness: on `BUSY` / 429 (upstream throttling this
IP) retry another model id, and on an empty `/v1/models` wait for discovery
instead of failing over to a stale list.

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20129/v1", api_key="public")

response = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "Write a Python palindrome checker."}],
)
print(response.choices[0].message.content)
```

### curl

```bash
curl http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"Say OK"}]}'
```

## Models

The list is discovered from upstream at runtime. As of the last update:

| Model ID | Notes |
|---|---|
| `muse-spark-1.3-contributor-free` | Meta Muse Spark 1.3 (Responses API) |
| `muse-spark-1.2-contributor-free` | Meta Muse Spark 1.2 |
| `big-pickle` | Reasoning model |
| `mimo-v2.6-flash-free` | Xiaomi MiMo V2.6 Flash |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |
| `cat-jam-free` | — |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview |
| `space-bunny-free` | Space Bunny Preview |
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash |
| `step-5-preview-free` | Frequently rate-limited upstream |

Fetch the live list:

```bash
curl -s http://127.0.0.1:20129/v1/models
```

## Reasoning models and token budgets

Reasoning tokens count against the same output budget as the visible answer. A
client requesting a small `max_tokens` can have the entire budget consumed by
reasoning, producing an empty response with `finish_reason: "length"`.

The bridge enforces a floor on the output budget:

| Request targets | Effective `max_tokens` |
|---|---|
| Reasoning model (Muse, MiMo, Nemotron, LongCat, cat-jam, big-pickle, step) | `max(requested, 1024) + 4096` |
| Any model with `reasoning_effort` set | same as above |
| All other models | `max(requested, 512)` |

The client's value is only raised, never lowered, and the result is clamped to
131072. The measurements behind these numbers are documented in
[`token-budget.js`](token-budget.js).

## Multiple hosts

Upstream rate-limits per IP. Running the bridge on more than one machine and
registering each as a separate connection spreads that load and provides a
fallback when one host is throttled.

To reach a bridge on another network from a single location, forward the port
over SSH:

```bash
ssh -N -L 127.0.0.1:20130:127.0.0.1:20129 user@remote-host
```

Then register `http://127.0.0.1:20130/v1` as an additional connection.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `20129` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to expose on the network — only behind a firewall, the endpoint has no authentication. |
| `CORS_ORIGIN` | `""` (localhost only) | Allowed CORS origin(s) (comma-separated, or `*` to allow all origins) |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream request timeout in milliseconds |
| `MAX_BODY_BYTES` | `10485760` | Maximum request payload size in bytes (10 MiB) |
| `IDENTITY_TTL_MS` | `900000` | How long the derived client identity is trusted before a request triggers a background re-check (15 min). No timer — an idle bridge makes no network calls. |
| `UPDATE_MODE` | `reactive` | `reactive` moves only on a gate rejection or `minimum: true`; `always` follows every release. |
| `OPENCODE_CHANNEL` | `latest` | Update channel to follow (`latest`, `beta`, `dev`). |
| `OPENCODE_MAJOR` | _(none)_ | Pin a major version line, e.g. `2`. Unset follows the newest release of any major. |
| `OPENCODE_USER_AGENT` | _(derived)_ | Pin the client user-agent and disable identity derivation entirely. |
| `OPENCODE_SOURCE_BASE` | GitHub raw | Override where the identity recipe is read from. |
| `OPENCODE_CATALOG_URL` | `models.opencode.ai/api.json` | Provider catalog the endpoints are derived from. |
| `OPENCODE_CHAT_URL` / `OPENCODE_RESPONSES_URL` | _(derived)_ | Pin the wire endpoints, bypassing catalog derivation. |
| `AUTO_UPDATE` | on | Poll this repo for a newer bridge release and self-update. Set `0` to disable. |
| `TOOL_PROFILE_SCOPE` | `core` | `core` sends the minimal proven tool set; `full` sends every name derived from the release. |

## Client identity

The free tier only serves requests that come from the OpenCode client, and that
check is a moving target. It has changed repeatedly — endpoint, headers, request
body, exact tool schemas, minimum client version — and the changes have arrived
within hours of each other (see [9router#4837](https://github.com/decolua/9router/issues/4837)).

Hardcoding the mask means a code change every time. Instead, `identity.js` resolves
it directly from the same sources the CLI itself uses:

1. **Update handshake** (`opencode.ai/update/api/latest/cli/npm`) — resolves the
   authoritative version, exact **commit SHA** (`metadata.github.sha`), and
   `minimum` flag (with fallback to GitHub's `releases.atom` feed).
2. **Source derivation at the commit SHA** — extracts the session-id recipe,
   User-Agent template, required headers, and the tool **name allowlist** from
   all eleven `packages/core/src/tool/plugin/*.ts` files at that immutable
   commit, falling back safely to the last known-good definitions.
3. **Provider catalog** (`models.opencode.ai/api.json`) — the same file the real
   CLI reads at boot. Its `opencode.api` field is the live inference base; the
   bridge derives `chatUrl`/`responsesUrl` from it and reads them **per
   request**, so a path migration (`/zen/v1` → `/inference/v1`) applies without
   a restart or a bridge release.

### What actually gates the free tier (measured)

Probing the live gate with byte-identical CLI requests isolated the checks:

| Condition | Result |
|---|---|
| `stream: true` | **required** — `stream: false` returns `403 FreeTierError` |
| a tool named `read` in `tools` | **required** |
| tool schemas | not compared — `read` with `parameters: {}` is accepted |
| exact headers, `b3`/`traceparent`, TLS fingerprint | not checked |
| session id | must come from the client's generator, not a hand-written lookalike |
| endpoint path | both `/inference/v1/*` and `/inference/openai/v1/*` accepted today |

That is why the bridge always sends `stream: true` upstream and buffers the SSE
into one JSON object when the client asked for a non-streamed reply, and why the
tool layer derives **names** rather than freezing schemas.

### Self-update

Like the CLI's `update: auto`, the bridge polls its own `package.json` at most
every 6 hours. When a newer release exists it downloads the shipped files,
syntax-checks them, renames them into place, and exits so the service manager
restarts it. A failed check or partial download leaves the running install
untouched. Disable with `AUTO_UPDATE=0`.

### Why the handshake, not the release feed

The CLI does not read GitHub's Atom feed to decide what is current. It asks:

```
GET https://opencode.ai/update/api/latest/cli/npm?current=2.0.29
→ { "version": "2.0.32", "active": true, "minimum": false,
    "metadata": { "github": { "sha": "d4a6223d…" } } }
```

Two fields matter:

- **`version`** — the release the CLI would move to.
- **`metadata.github.sha`** — the exact commit it was built from. A tag can be
  moved; a commit cannot. Source is read at the SHA, so derivation is
  reproducible.

`minimum: true` is upstream stating that older clients are no longer accepted.
When it appears, the bridge adopts the release immediately in **both** update
modes — there is nothing to wait for.

The Atom feed is kept as a fallback for when the update service is unreachable.
It carries a version but no SHA, so `identity.release.source` reads `atom-feed`
and `identity.release.sha` is `null`. That is a degraded mode, not a failure.

### Update modes

| `UPDATE_MODE` | Behaviour |
|---|---|
| `reactive` *(default)* | Move only when a gate rejects a request, or when upstream sets `minimum: true`. Most releases do not touch the gate, so following them all costs source reads for nothing. |
| `always` | Follow every release as soon as the TTL expires. Use this if you would rather pay a little bandwidth than ever see a rejection. |

Either way, a `426 UpgradeRequired` is handled immediately: the floor named in
the error is adopted verbatim, even if the handshake is unreachable.

In `reactive` mode a release that has not moved the gate is recorded but not
adopted — `/health` reports it as `identity.available`. The periodic CLI poll
(`CLI_VERSION_TTL_MS`, 6 h) also respects the mode: it refreshes the *knowledge*
of what is current, not the identity in use.

### What actually updates

A refresh replaces exactly these, and nothing else:

| Field | Read from | Fallback |
|---|---|---|
| `version` (User-Agent) | handshake `version` | last known-good |
| `sessionCharset` / `sessionLength` / `sessionMultiplier` | `packages/schema/src/identifier.ts` | last known-good |
| `sessionPrefix` | `packages/schema/src/session-id.ts` | `ses_` |
| `userAgentTemplate` | `packages/core/src/app.ts` | `opencode/${channel}/${version}/${cli}` |
| header names | `packages/core/src/session/model-request.ts` | the shipped set |
| `read` / `shell` schemas | `packages/core/src/tool/plugin/{read,shell}.ts` | `DEFAULT_TOOLS` |

Six plain TypeScript files, **~45 KB total**, fetched from
`raw.githubusercontent.com/anomalyco/opencode/<sha>/<path>`. No npm tarball, no
CLI binary, no local process, no disk cache.

Header names are split into two sets during extraction: headers upstream sends
unconditionally, and conditional ones (parent-session lineage, written as
`...(session.parentID ? {...} : {})`). The bridge sends the first set and reports
the second under `identity.optionalHeaders` — it never creates nested sessions,
so their absence is correct, not a gap.

If upstream adds a required header whose value this bridge cannot derive, it
appears in `identity.unsentHeaders` rather than being sent empty.

### Inspecting state

```bash
curl -s http://127.0.0.1:20129/health
```

```json
{
  "status": "ok",
  "provider": "opencode-free-bridge",
  "version": "2.0.0",
  "discoveredModels": 9,
  "identity": {
    "userAgent": "opencode/latest/2.0.32/cli",
    "updateMode": "reactive",
    "sourceTag": "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad",
    "versionFloor": null,
    "lastCheckAgeMs": 1240,
    "ttlMs": 900000,
    "lastError": null,
    "available": null,
    "headers": [
      "x-opencode-session-id", "x-session-affinity", "X-Session-Id",
      "User-Agent", "x-opencode-project", "x-opencode-session", "x-opencode-client"
    ],
    "unsentHeaders": [],
    "release": {
      "version": "2.0.32",
      "sha": "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad",
      "minimum": false,
      "source": "update-api"
    },
    "tools": {
      "source": "source",
      "version": "2.0.32",
      "toolNames": ["read", "shell"]
    }
  }
}
```
## Troubleshooting

**All models report `BUSY`**
The upstream free tier is throttling the current IP. Retry later, or run the bridge from a different host.

### What the `403 FreeTierError` actually checks

The error:

```
HTTP 403 {"type":"error","error":{"type":"FreeTierError",
  "message":"OpenCode's free tier can only be used from within OpenCode.
             Download it at https://opencode.ai and keep building."}}
```

Measured against the live service, the trigger is the **session id shape**:

| Session id | Result |
|---|---|
| `ses_` + 12 lowercase hex + 14 base62 (30 chars) | accepted |
| missing `_` (`ses<hex>…`) | `403 FreeTierError` |
| uppercase hex | `403 FreeTierError` |
| other lengths (26, 34) | `403 FreeTierError` |
| counter field `>= 64` | `403 FreeTierError` |
| no `tools` in the body | `403 FreeTierError` |

The endpoint (`/zen/v1` vs `/inference/v1`), the User-Agent string, and the tool
*names* are **not** checked — the pre-1.5.0 pattern passes unchanged. Only the
version *floor* is enforced separately, via `426 UpgradeRequired`.

This is why a stale recipe is the dangerous case: the id is derived from the
recipe, so a wrong `sessionPrefix` / `sessionLength` / `sessionCharset` mints an
id upstream reads as "not OpenCode". The self-heal therefore re-mints the id
after refreshing — replaying the old one would fail identically — and evicts it
from the session cache so later requests do not reuse it.

The same applies to the tool profile: an extracted profile **replaces** the
previous one and is sent whole. Merging would keep a renamed tool forever, and a
hardcoded name filter would record the new name but keep sending the old one —
either way the wire shape could never converge on what the release ships.

### What is derived vs. what is fixed

| Layer | Derived at runtime? | If upstream moves it |
|---|---|---|
| session-id shape | yes (`identifier.ts`, `session-id.ts`) | followed on refresh |
| User-Agent template + version | yes (`app.ts`, handshake) | followed on refresh |
| header names | yes (`model-request.ts`) | followed; unknown values reported in `unsentHeaders` |
| `read` / `shell` schemas and names | yes (`read.ts`, `shell.ts`) | followed; the set replaces the old one |
| inference endpoint | **no** — `OPENCODE_CHAT_URL` / `OPENCODE_RESPONSES_URL` | must be updated in config |
| header *values* | **no** — mapping in `buildGateHeaders` | must be added in code |
| tool *parameter* semantics | partly — types/minimums/descriptions derived | a brand-new field type falls back to `string` |

The endpoint is the one layer that cannot be read from the release source: it
lives in the CLI's model routing config, not in the files this bridge reads. It
is overridable by env var for exactly that case.

**`403 FreeTierError` / `426 UpgradeRequired`**
Normally self-healing: the bridge refreshes its identity and retries once. If it
persists, check `/health` — look at `identity.userAgent`, `identity.versionFloor`
and `identity.lastError`. A gate rejection is recognised from the error **body**
(`type` / `message`), not the status alone, so the body is read before the
decision. To force a fresh derivation:

```bash
IDENTITY_TTL_MS=0 node ~/.opencode-free-bridge/server.js
```

**`THINK` (thinking-only response)**
A model produced reasoning but no visible answer. The token floor should prevent this; report the model id if it occurs.

**Client reports "model not found"**
Model ids are case-sensitive. Fetch the current list from `/v1/models`.

**Service not running**
```bash
# systemd
journalctl -u opencode-free-bridge -n 50

# launchd
tail -50 ~/Library/Logs/opencode-free-bridge.log

# manual
node ~/.opencode-free-bridge/server.js
```

## How it works

```
client ──▶ bridge :20129 ──▶ opencode.ai/inference/v1/...
              │
              ├─ derives client identity (UA, session-id shape, headers) from
              │  opencode's public source at the current release tag
              ├─ re-checks that identity lazily — on request, never on a timer
              ├─ on 403/426: refreshes identity, adopts any version floor, retries once
              ├─ discovers free models & latest CLI version hourly
              ├─ routes Responses models to /inference/v1/responses (auto-learns on protocol mismatch)
              ├─ routes Chat models to /inference/v1/chat/completions
              ├─ injects canonical v2 tool/session fingerprints with client tool aliasing
              ├─ applies additive token budget floor for reasoning models
              └─ normalizes reasoning into reasoning_content and propagates usage & finish_reason
```

The bridge always streams from upstream and reassembles for non-streaming
clients, keeping a single code path for both.

### Why the identity is derived, not hardcoded

Upstream's free-tier check is a **version contract**, not a fixed wall. When the
client is too old it answers `426 UpgradeRequired` naming the minimum version:

```
HTTP 426  {"error":{"type":"UpgradeRequired",
           "message":"OpenCode 1.18.0 or newer is required to use the free tier"}}
```

The OpenCode CLI passes because it auto-updates to stay above that floor — not
because it holds a secret. The wire protocol itself is stable: between v2.0.28
and v2.0.32, `identifier.ts` is byte-identical and `model-request.ts` differs by
a single keyword. Only the version moves.

So the bridge reads the version, derives the rest of the recipe from source, and
keeps the last known-good mask whenever anything is unavailable. Hardcoding a
mask is what makes a bridge need maintenance; deriving it is what removes it.

## License

MIT
