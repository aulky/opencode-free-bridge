# Changelog

## [2.1.0] — 2026-10-17

### Wire values derived from the same sources the CLI reads

v2.0.0 derived the *identity* (session shape, UA, headers, two tool schemas).
v2.1.0 closes the remaining wire layers so a path or tool-set migration
upstream no longer needs a bridge release.

- **Endpoints from the provider catalog (`identity.extractCatalog`)**: The
  `opencode` entry in `models.opencode.ai/api.json` — the same file the real CLI
  reads at boot — carries the live inference base (`api`). The bridge derives
  `chatUrl`/`responsesUrl` from it and reads them **per request**
  (`server.resolveEndpoints`), so the `/zen/v1` → `/inference/v1` move (and any
  future one) applies on the next request without a restart. `OPENCODE_CHAT_URL`
  / `OPENCODE_RESPONSES_URL` still pin the value when set.
- **Tool allowlist from every tool plugin source**: Extraction now reads all
  eleven `packages/core/src/tool/plugin/*.ts` files (`read`, `shell`, `glob`,
  `edit`, `write`, `grep`, `question`, `skill`, `subagent`, `webfetch`,
  `websearch`) instead of only `read.ts`/`shell.ts`. The extractor understands
  the three description forms upstream uses (array joined with `" "` or `"\n"`,
  exported template literal, `editor.add` literal) and single-quoted strings.
- **`full` tool scope on self-heal**: `getToolList(flat, "full")` sends every
  name derived from the release's tool sources. The gate-rejection retry now
  always uses it, so a renamed or newly-required tool is picked up without a
  bridge release. The default `core` scope still sends the minimal proven set.
- **A gate rejection is always retried once, with fresh values**: The session id
  and the tool set are minted per request, so the retry is a genuinely different
  request even when the recipe did not change. Previously a `no-change` verdict
  skipped the retry and surfaced the 403.
- **Self-update (`update: auto`, in miniature)**: Polls this repo's
  `package.json` at most every 6h, downloads the shipped files, syntax-checks
  them, then renames them into place and exits for the service manager to
  restart. `AUTO_UPDATE=0` disables it. A failed check or partial download
  leaves the running install untouched.
- **The retry re-resolves the endpoint after refreshing**: A refresh can learn a
  new endpoint from the catalog. Reusing the URL captured before the refresh
  would send the healed request to the stale path, defeating the derivation.
- **Per-model endpoint overrides**: The catalog can pin a model to its own base.
  OpenAI-SDK models are routed to their pinned base; anthropic-only routes are
  left alone rather than silently misrouted (this bridge speaks the OpenAI
  protocols only).
- **Drills**: `routing` proves the endpoint is read per request (a fake server
  started *after* boot receives the request); `allowlist` proves a renamed tool
  reaches the wire in `full` scope; `retry-endpoint` proves the self-heal retry
  lands on the endpoint learned by the refresh. `npm run drill` is now 7/7.
- **Budget rejections no longer carry the update hint**: when the retry already
  used the freshest derived identity, a repeated `403 FreeTierError` is the
  per-IP allowance, not a stale bridge. Measured: identical, byte-for-byte CLI
  requests alternate between `200` and `403` within seconds on the same host.
  The error is surfaced verbatim instead of pointing at `install.sh`.

### Cross-host validation (m1, different IP)

The adaptive bridge was deployed beside the v1.5.3 bridge on a second host and
staged with the **old** v1.5.3 wire pattern (UA `2.0.29`, `read`+`shell` tools,
and a broken session prefix). Upstream rejected the staged request with
`403 FreeTierError`; the bridge refreshed from the handshake + source + catalog,
re-minted the session id, escalated to the full derived tool set, retried, and
the client received `200 "ok"`. The v1.5.3 bridge on the same host, which has no
refresh path, returned `403` at the same moment.

The same host also produced a useful negative result: once its per-IP allowance
was exhausted, byte-identical CLI requests alternated `200`/`403`, which is how
the budget gate was distinguished from a shape gate.

### What is still not self-healing

| Layer | Why |
|---|---|
| Gate *semantics* | If upstream adds a check that is not expressed in the endpoint, headers, session shape, or tool names, nothing in the release source reveals it. The bridge fails honestly: it forwards the real `403` with an update hint rather than looping. |
| Header *values* | Names are derived; values are mapped by hand (`buildGateHeaders`). A new header whose value is not derivable shows up in `identity.unsentHeaders` instead of being sent empty. |
| Non-OpenAI protocols | A model routed through the anthropic protocol needs a translation layer this bridge does not have. |
| Rate limits | The per-IP free-tier budget is upstream policy, not an identity problem. |

### Measured: what the gate does and does not check

| Condition | Result |
|---|---|
| `stream: true` | required — `stream: false` returns `403 FreeTierError` |
| a tool named `read` present in `tools` | required |
| tool *schemas* | not compared — `read` with `parameters: {}` is accepted |
| exact header set, `b3`/`traceparent`, TLS fingerprint | not checked |
| session id shape | must be minted by the client's generator; a hand-written string of the same shape is rejected |
| `/inference/v1/*` vs `/inference/openai/v1/*` | both accepted today; catalog value used |

## [2.0.0] — 2026-10-17

### Lean adaptive identity — handshake + source derivation in a single module

v1.6.0 made the *headers* self-healing from the Atom feed, but left the tool
definitions static. v2.0.0 unifies release resolution, `reactive`/`always` update
modes, and source-derived tool schemas into `identity.js` without any external
dependencies or background bloat.

- **Authoritative update handshake (`identity.resolveRelease`)**: Queries
  `GET https://opencode.ai/update/api/<channel>/cli/npm?current=<version>` to
  obtain `version`, `metadata.github.sha`, and `minimum`, with automatic fallback
  to the GitHub `releases.atom` feed. Removes the hardcoded `2.` major filter.
- **`UPDATE_MODE` (`reactive` default, `always` opt-in)**: In `reactive` mode,
  the bridge only switches versions and fetches source when upstream rejects a
  request (`403 FreeTierError` / `426 UpgradeRequired`) or flags `minimum: true`,
  replaying the rejected request once transparently. In `always` mode, it follows
  every new release lazily when `IDENTITY_TTL_MS` expires.
- **Source-derived recipe & tool schemas (`identity.extractRecipe`)**: Reads
  `identifier.ts`, `session-id.ts`, `app.ts`, `model-request.ts`, `read.ts`, and
  `shell.ts` at the immutable release commit SHA to keep the session-id format,
  User-Agent, headers, and `read`/`shell` tool fingerprint schemas in sync.
- **Pooled CSPRNG session IDs**: Preserves the zero-allocation `crypto.randomFillSync`
  buffer pool inside `identity.createId` (10,000 IDs in <15ms).
- **Clean `/health` inspection**: Reports `identity.userAgent`, `updateMode`,
  `sourceTag`, `versionFloor`, `release`, `available`, `headers`,
  `optionalHeaders`, `unsentHeaders`, and `tools` status.
- **Gate path fixes found by the live drill**:
  - A gate rejection is now identified from the error **body** (`type`/`message`)
    rather than the status line. The old check passed empty strings, so the
    self-heal branch was unreachable for `403 FreeTierError` — only `426`
    (which matches on status alone) ever healed.
  - An empty tool profile no longer wins over the shipped fallback: `{}` is
    truthy, so the bridge used to send `tools: []` and get `403`.
  - The header set is derived from upstream's request builder and actually sent;
    conditional headers (parent-session lineage) are separated so their absence
    is not reported as a gap.
  - The periodic CLI poll (`recheck`) no longer forces adoption, so `reactive`
    really is reactive.
  - The retry after a gate rejection now **re-mints the session id**. The id is
    derived from the recipe, so one minted before the refresh encodes the shape
    that was just rejected; replaying it failed identically. The stale id is also
    evicted from the session cache, otherwise every later request from that
    client would reuse it and stay stuck at 403.
- **`gate-drill.js` (`npm run drill`)**: live, unmocked proof of the self-heal —
  stages a rejected identity, sends one request, asserts the client gets a real
  answer. Four drills: `version-floor` (426), `empty-tools` (403), `session-shape`
  (the `FreeTierError` above) and `legacy-shape` as a control.

### What the free-tier gate actually checks (measured)

| Condition | Result |
|---|---|
| `ses_` + 12 lowercase hex + 14 base62 (30 chars) | accepted |
| prefix without `_`, uppercase hex, other lengths, counter `>= 64` | `403 FreeTierError` |
| no `tools` in the request body | `403 FreeTierError` |
| User-Agent below 1.18.0 | `426 UpgradeRequired` |
| `/zen/v1` endpoint, old ai-sdk User-Agent, old tool *names* | accepted — **not** checked |

The pre-1.5.0 access pattern therefore still works today. The gate is about the
session id shape, the presence of tools, and the version floor — not the endpoint
or the version string in the User-Agent.

**Tool profiles now replace instead of merge, and are sent whole.** A hardcoded
core-name filter would record a renamed tool from source but keep sending the old
name, and a merge would never drop a removed tool. Either way the wire shape
could not converge on the release.

**What is not derived:** the inference endpoint (it lives in the CLI's model
routing config, not the files read here — overridable via `OPENCODE_CHAT_URL` /
`OPENCODE_RESPONSES_URL`) and header *values* (the name-to-value mapping is code).
Both are reported rather than silently assumed.

## [1.6.0] — 2026-10-17

### Self-healing identity — the bridge stops needing manual updates

Upstream moved the free-tier gate three times in three days (see 9router#4837:
`/zen/*` → `/inference/v1`, headers → headers + body tools, then a version
floor). Each move previously meant a code change and a release here. The bridge
now derives its identity the same way the OpenCode CLI does, so it adapts on
its own.

**Root cause, corrected.** The gate is not a wall to be reverse-engineered — it
is a *version contract*. Upstream answers `426 UpgradeRequired` with the exact
minimum client version (`"OpenCode 1.18.0 or newer is required"`), and the CLI
passes because it auto-updates to stay above that floor. The protocol itself is
stable: `packages/schema/src/identifier.ts` is byte-identical across v2.0.28 →
v2.0.32, and `model-request.ts` differs by one keyword. Only the version moves.

**`identity.js` (new).** Derives the mask from opencode's public source instead
of hardcoding it:

- Reads the release feed for the current tag, then extracts the session-id
  shape, user-agent template and header names from
  `packages/schema/src/identifier.ts`, `packages/schema/src/session-id.ts`,
  `packages/core/src/app.ts` and
  `packages/core/src/session/model-request.ts` — ~22 KB fetched, ~305 bytes of
  recipe actually used. The agentic half of the CLI (TUI, LSP, MCP, session
  store, tool execution) is never downloaded and never needed.
- **Extraction completeness is reported, not assumed.** A successful source
  read lists any recipe field a regex failed to fill; a non-empty
  `identity.missingFields` in `/health` (plus a warning log) means upstream
  renamed something and the next gate move may not be followed. This is not
  fatal — the previous values stay in use and the version still advances — but
  it turns a silent degradation into a visible one.
- **Lazy, not scheduled.** No timer. The request path kicks a refresh only when
  the cached identity is older than `IDENTITY_TTL_MS` (15 min), and that refresh
  runs in the background — a request never waits on GitHub. An idle bridge makes
  zero network calls.
- **Reactive self-heal.** On `403 FreeTierError` or `426 UpgradeRequired` the
  identity refreshes immediately, adopts an advertised version floor verbatim,
  and the request is replayed once. The client never sees the rejection.
- **Monotonic and fail-safe.** The version never moves backwards, a partially
  parsed recipe is discarded, and an unreachable feed keeps the last known-good
  mask. A retry is only issued when the refresh actually learned something, so
  a persistent rejection surfaces as a real error instead of a retry loop.
- Steady state costs one feed read per TTL: the three source files are re-read
  only when the version moves, or when a gate rejection forces a re-derivation.

**`426 UpgradeRequired` handled (`server.js`).** `isFreeTierCliGateError` now
recognises the version-floor handshake and the `UpgradeRequired` error type —
previously a raised floor produced an opaque error with no recovery path.

**`/health` reports the mask in use.** `identity.userAgent`, `sourceTag`,
`versionFloor`, `lastCheckAgeMs` and a `drift` block comparing the header set
upstream sends against the one we send. First thing to check when upstream
starts rejecting requests.

**Behaviour notes**

- `refreshCliVersion()` is kept as a thin wrapper for compatibility; it now also
  refreshes the session-id shape, not just the version.
- The identity TTL is separate from model discovery: the model list still
  refreshes hourly on a timer because upstream rotates models on its own
  schedule.

## [1.5.3] — 2026-10-15

### Pruned, Hardened & Deep-Optimized

- **Removed runtime self-updater bloat (`FIND-02`)**: deleted `checkAndApplyUpdate()`,
  `isNewerVersion()`, `fs`/`path`/`child_process`/`vm` imports, and `AUTO_UPDATE`
  from `server.js`. Updating is handled cleanly by `install.sh` or `git pull`.
- **Zero-allocation hot paths**:
  - Pre-computed and froze `CANONICAL_TOOLS_CHAT`, `CANONICAL_TOOLS_RESPONSES`,
    `FINGERPRINT_PARAM_STRINGS`, and `DEFAULT_PLACEHOLDER_NOTE` at module load so
    tool-less or standard requests allocate zero tool objects/maps.
  - Pooled `crypto.randomFillSync` (3.5 KB buffer, 256 IDs per syscall) in
    `createId()`.
  - Pre-serialized `/health` and `/v1/models` JSON payloads on discovery change
    and replaced `new URL()` + regex path parsing with direct string indexing.
  - Added zero-split `consumeSseLines()` scanner and zero-parse SSE passthrough
    fast path when no tool aliases or `reasoning` field normalization are needed.
- **Responses API system/developer instructions & multimodal inputs (`FIND-01`, `FIND-04`)**:
  extracts `system` and `developer` messages from `body.messages` into
  `upstreamBody.instructions` alongside `placeholderNote`, preserves multimodal
  `image_url` / `input_image` / `input_file` parts, and forwards `temperature`,
  `top_p`, `stop`, `response_format`, and `reasoning_effort`.
- **Chunked 413 stream cleanup (`FIND-03`)**: when a streaming request body
  exceeds `MAX_BODY_BYTES`, `readRequestBody` detaches listeners, pauses the
  stream immediately, and destroys the socket without calling `req.resume()`.
- **Localhost-scoped CORS (`FIND-05`)**: restricts `Access-Control-Allow-Origin`
  to `localhost` / `127.0.0.1` / `[::1]` by default (configurable via
  `CORS_ORIGIN`) so arbitrary third-party websites cannot drain local IP quota.
- **Collision-resistant headerless session hashing (`FIND-06`)**: samples both
  head and tail plus total length (`messageSignatureSample`) so conversations
  sharing a long (>1000 char) system prompt prefix do not collide.
- **Reasoning hint & installer quoting (`FIND-04`, `FIND-07`)**: added
  `deepseek` to `REASONING_MODEL_HINTS` in `token-budget.js` and hardened path
  quoting in `install.sh`.

## [1.5.2] — 2026-10-15

### Performance — 4 hot-path optimizations (zero-deps, all covered by `test/optimizations.test.js`)

- **Single-flight discovery**: 50 parallel `/v1/models` hits after TTL expiry
  share one upstream fetch (was: 50 parallel fetches = thundering herd).
- **Discovery no longer waits on the CLI version feed**: feed refreshes in
  parallel fire-and-forget and is cached 6h (was: every hourly discovery
  blocked up to 5s on the Atom feed).
- **Session fast path**: requests carrying a session header skip message
  hashing entirely; headerless fallback slices *before* stringify via new
  `shortText()` so a multi-MB system prompt is never serialized for a hash.
- **Early 413 reject**: bodies declaring `content-length` over the limit are
  refused without buffering a byte.

Measured: 50 parallel GETs served in 0.22s with 1 upstream fetch;
header-path session lookups with 5MB messages in ~6ms.

## [1.5.1] — 2026-10-15

### Removed — hardcoded model fallback

- **No more `FALLBACK_MODELS` / built-in list.** `server.js` starts with an
  empty model list and serves only live discovery results. An empty
  `/v1/models` honestly means "upstream not reached yet", so gateways and
  harnesses apply their own fallback instead of being served a stale list.
- Removed retired `ling-3.1-flash-free` aliases (upstream retired the model),
  removed its hint from `token-budget.js`, and replaced it with
  `deepseek-v4.1-flash-free` in `README.md`.
- Added `deepseek` / `big-pickle` shorthand aliases to `MODEL_MAP`.
- Unified log prefix to `[opencode-free-bridge]`, fixed stale comments
  referencing the removed cache/fallback.
- Boot no longer blocks on network: `server.listen` first, discovery runs in
  background and refreshes hourly.

## [1.5.0] — 2026-10-14

### Fixed — OpenCode v2 `/inference/v1` gate migration (`403 FreeTierError`, 9router#4837)

OpenCode v2 migrated free-tier inference from `/zen/v1/*` to `/inference/v1/*`
and added multi-layer request verification:

- **Endpoints**: moved responses, chat completions, and model discovery to
  `https://opencode.ai/inference/v1/{responses,chat/completions,models}`.
- **User-Agent**: updated to the v2 CLI format (`opencode/latest/2.0.29/cli`)
  with automatic version refresh from the upstream GitHub release Atom feed.
- **Session headers & counter gate**: sends the required session header mirrors
  (`x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`,
  `x-session-id`), removes `x-opencode-request` (rejected by v2), and clamps the
  12-bit inverted session counter to `1..16` per millisecond in `createId`.
- **Canonical tool fingerprint & conflict aliasing**: injects verbatim `read`
  and `shell` schemas required by upstream, omits `tool_choice: "none"`,
  aliases conflicting client `read`/`shell` tools (`read_client`,
  `shell_client`) with transparent response restoration, and appends a
  placeholder system instruction so injected fingerprint tools are not invoked.

### Fixed — token budget, `usage`, and `finish_reason`

- **Unified additive token budget**: `server.js` now calls
  `effectiveMaxTokens` from `token-budget.js` (`max(requested, 1024) + 4096` for
  reasoning models including `longcat-2.5-preview-free` and `cat-jam-free`),
  removing the duplicate flat `Math.max` logic and handling `max_tokens: 0` and
  numeric strings without jumping to `131072`.
- **Non-streaming `usage` in Chat Completions**: sends
  `stream_options: { include_usage: true }` upstream so `prompt_tokens`,
  `completion_tokens`, and `total_tokens` are populated instead of `{0, 0, 0}`.
- **Real `finish_reason` propagation**: propagates upstream `finish_reason`
  (`"length"`, `"content_filter"`, `"tool_calls"`, `"stop"`) across both Chat
  Completions and Responses API (`response.incomplete`).

### Changed — reliability, validation, and unit test suite

- Added `AbortController` upstream timeout (`UPSTREAM_TIMEOUT_MS`, default 120s),
  automatic upstream cancellation on client disconnect, and `req`/`res` stream
  error handlers.
- Added 10 MiB request body limit (`413 payload_too_large`) and `400` validation
  for missing/empty `model`, missing `messages`, or malformed JSON.
- Fixed `sessionCache` eviction to true $O(1)$ LRU instead of FIFO.
- Single-sourced `VERSION` from `package.json` in `server.js` and `install.sh`.
- Added automatic protocol fallback & caching when upstream returns
  `400 ModelProtocolUnsupported`.
- Added zero-network unit & HTTP integration tests (`npm test` via `node:test`)
  and GitHub Actions CI (`.github/workflows/ci.yml`).

---

## [1.4.0] — 2026-10-13

### Fixed — reasoning models returned empty answers on short requests

Reasoning models on the free tier (Muse Spark, MiMo, Nemotron, LongCat,
cat-jam, big-pickle) emit chain-of-thought tokens that count against the
**same** output budget as the visible answer. A client asking for a small
`max_tokens` — a probe, a title, a one-word reply — had the entire budget
consumed by reasoning, and the bridge returned `content: null` with
`finish_reason: "stop"`. No error, no content, tokens still billed.

Measured against the live upstream gateway:

| `max_tokens` | Result |
|---|---|
| 50 | empty for Muse Spark |
| 100 | empty for Muse Spark and cat-jam |
| 256 | empty for big-pickle; longcat finished exactly on the cap |
| 512 | content returned, truncated on long answers |
| 2048 + headroom | complete answers |

The bridge now enforces a floor, using the additive budget the wider ecosystem
settled on (OpenRouter documents the shared-budget behaviour; goose#11142
adopts the pi coding agent's formula):

```
reasoning model : max_tokens = max(requested, 1024) + 4096
plain model     : max_tokens = max(requested, 512)
both clamped to 131072
```

The client's value is only ever raised, never lowered. Reasoning detection
also honours `reasoning_effort`, so a client asking for thinking on an
unlisted model still gets headroom. See `token-budget.js`.

### Added — one-line installer

`install.sh` installs the bridge, registers a boot service (systemd on Linux,
launchd on macOS), starts it, and runs the self-check. No manual steps.

### Added — `verify.js` self-check

`node verify.js` probes every discovered model with a real prompt and prints a
summary. It distinguishes "rate-limited" (upstream throttling this IP, not a
misconfiguration) from "not answering", so a new user can tell whether their
setup is correct without reading logs.

### Added — `token-budget.js`

The token budgeting logic, extracted and documented with the measurements it
is based on, so the numbers can be re-derived rather than taken on faith.

### Changed — README rewritten around the default path

The first thing a reader sees is now: install, add one local connection,
done. Multi-host setups moved to their own section, since they are optional
and only useful for spreading upstream rate limits.

### Changed — package.json

Version corrected (was `1.0.0` while the server reported `1.3.0`), `verify`
and `test` scripts added, `files` list added so `npm publish` ships the right
set.

---

## [1.3.0] — 2026-10-13

### Added — real-time auto-discovery of upstream free models

The model list is fetched from the upstream gateway on startup and refreshed
hourly. New free models appear without a code change; retired ones disappear.
Falls back to a built-in list when upstream is unreachable.

---

## [1.0.0] — 2026-10-13

### Added — initial release

OpenAI-compatible bridge for OpenCode free-tier models. Dual-protocol routing
(Responses API for Muse, Chat Completions for the rest), desktop identity
headers to avoid `FreeTierError`, `reasoning_content` normalization, and a
persistent session cache so upstream prompt caching survives across turns.
