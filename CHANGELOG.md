# Changelog

## [2.0.0] — 2026-10-17

### Adaptive identity — the bridge follows the gate instead of chasing it

v1.6.0 made the *headers* self-healing but left the tool definitions hardcoded.
That was the wrong place to stop: the `tools` array is the layer upstream moves
most often (9router#4837: headers → +tools → exact schemas → endpoint, all within
three days). This release removes the last hardcoded assumption and adds a
four-tier resolution chain.

**The version handshake is the real contract.** The CLI does not read the GitHub
release feed to decide what is current — it asks a purpose-built endpoint:

```
GET https://opencode.ai/update/api/latest/cli/npm?current=<version>
→ { version, active, minimum, metadata: { github: { sha } } }
```

`metadata.github.sha` is the commit the release was built from. A tag can be
moved; a commit cannot, so source is now read at the SHA. `minimum: true` is
upstream saying the floor has moved — adopted immediately in every update mode.

**`handshake.js` (new).** Resolves the authoritative release: version, commit
SHA, and the `minimum` flag. Falls back to the Atom feed when the update service
is unreachable, and reports the degradation (`source: "atom-feed"`, `sha: null`)
rather than pretending the result is equivalent. Never throws — a total failure
returns the last known-good record marked `stale`.

**`artifact.js` (new).** Reads the tool definitions from the published
`@opencode/core` package, which ships the compiled bundle with
`// src/tool/plugin/<name>.ts` markers and literal `description:` strings. This
avoids re-implementing Effect's `Schema.toJsonSchemaDocument` / `$defs` inlining
/ `allOf` flattening — the package has already done it. A minimal tar reader
(gzip + ustar, no dependencies) plus a brace-aware JS scanner resolves:

- tool-level descriptions, including builders like `(shell) => [...]` whose
  `${OS}` / `${shell}` holes are evaluated for the Linux+bash context the gate
  is calibrated on;
- parameter schemas, including fields inherited from another chunk
  (`PageInput2.fields.offset`), which is what makes `offset`/`limit` come out as
  optional integers rather than required unknowns;
- one level of variable aliasing (`var Input9 = LocationInput`).

Verified byte-identical to the previously hardcoded `read` and `shell`
definitions, which is how the extractor was validated.

**`capture.js` (new).** Records what a real CLI actually sends, by starting a
loopback server that speaks enough OpenAI protocol to satisfy it and pointing an
isolated CLI at it via `OPENCODE_CONFIG`. The recording is ground truth: no
inference, and a direct answer to "what changed?" when diffed against the
previous capture. Exposed as `POST /capture`; the user's own config is never
touched and no traffic leaves the machine. Prefers the npm CLI on `PATH` — the
standalone v2 binary resolves models differently and rejects a config-only
provider.

**`probe.js` (new).** Differential diagnosis for a rejection the derived profile
does not explain. Off unless `PROBE_ENABLED=1`, capped at `PROBE_MAX_ATTEMPTS`
(default 6), and silent for `PROBE_COOLDOWN_MS` (default 15 min) after a failed
batch — because upstream applies a per-IP cooldown after a burst of failures,
which masks the real error. Each attempt changes exactly one dimension against
the last known-good baseline, so a success names its own cause.

**`identity.js` — rewritten resolution.** Version now comes from the handshake
rather than the feed, and the `versions.find(v => v.startsWith("2."))` filter is
gone. That filter was a time bomb: the day opencode shipped 3.0.0 it would match
nothing, the fallback would keep the newest 2.x, and the bridge would freeze one
major version behind with no error. `UPDATE_MODE` (`reactive` default,
`always` opt-in) decides how eagerly a new release is adopted. Tool profiles are
resolved through `capture → artifact → default` and reloaded on every gate
rejection, since that layer can move without a version bump.

**`server.js` — no hardcoded tool definitions.** `FINGERPRINT_TOOL_DEFINITIONS`
and the frozen `CANONICAL_TOOLS_*` arrays are gone; the fingerprint is resolved
per request from the live profile, so an update takes effect on the next request
without a restart. A gate retry now rebuilds the request body as well as the
headers, and the probe is wired in after the normal self-heal fails. The
exports `FINGERPRINT_TOOL_NAMES` / `FINGERPRINT_TOOL_DEFINITIONS` /
`CANONICAL_TOOLS_CHAT` / `CANONICAL_TOOLS_RESPONSES` remain as live getters for
backwards compatibility.

**Token cost of a capture.** A capture carries everything the CLI sends — about
ten definitions, ~20 KB of JSON — and every one of those bytes is billed as
prompt tokens on every request. The gate only fingerprints a small core, so
`TOOL_PROFILE_SCOPE=core` (default) sends just `read` plus whichever of
`shell`/`bash` the profile provides. Measured on a live request: 5224 → 1885
prompt tokens, same answer. `TOOL_PROFILE_SCOPE=full` restores the complete set
if a gate ever requires a tool outside the core.

**Observability.** `/health` now reports `update.release` (version, SHA, source,
`minimum`), `tools` (source, version, tool names, error), `probe` (enabled,
cooldown) and `capture` (available, path, captured tool names). `/profile`
returns the exact tool definitions on the wire.

**Tests.** 105 total (was 61): new suites for handshake, artifact extraction,
capture normalisation and probe safety. `npm test` remains offline — the
artifact suite builds real tar bytes in memory rather than downloading.

### Behaviour notes

- `refreshCliVersion()` still exists and still delegates to `identity.refresh`.
- Steady state costs one handshake request per `IDENTITY_TTL_MS`; the 1.3 MB
  package is fetched once per version and cached in
  `~/.opencode-free-bridge/cache`.
- A `tools.source` of `default` in `/health` means both real sources failed; the
  bridge keeps working on the shipped definitions but is not adapting.

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
