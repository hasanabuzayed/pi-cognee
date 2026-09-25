## Changelog

### v0.4.0

- **Rich statusline + idle/exit watchers + persisted improve-cooldown + disk-backed write
  bridge** (README gaps 5–7; research/v04-resilience-spec.md) — the resilience/UX cluster,
  mapped from the reference `cognee_statusline_render.py` / `idle-watcher.py` /
  `exit-watcher.py` / spillway under pi's in-process constraints:
  - **Statusline**: `renderStatusline()` subsumes every `setStatus` literal —
    `<glyph>cognee: <backend> · <dataset>[ · N awaiting replay][ · N memory hits[ · X/Y
    turns had hits this session]][ · credits: …]` — refreshed at health completion, each
    recall, each drain tick, improve settle, and dataset switch (no timers; reads in-memory
    state + the one shared credits marker). Glyph slot keeps the reference precedence
    (connection failure > llm-key verdict > ready): `●` / `✕ offline` / `✕ auth failed` /
    `✕ server error` / `✕ llm key not set` (new, static: local backend with `LLM_API_KEY`
    unset — the reference's real litellm ping is a documented skip). A successful recall
    restores the glyph (positive evidence clears a fail verdict). Recall counters now count
    every injected scope (graph + code facts — code-only hit turns finally count toward
    `turns_with_hits`, the reference rule), with the `memory warming up (N turns)` zero-hit
    form, `COGNEE_STATUSLINE_COUNTS=full` diagnostic strip (`recall <graph>g/<code>c`) and
    `false|0|off` hiding. `· N awaiting replay` reports the durable bridge count. Credits:
    render-only over the shared `~/.cognee-plugin/claude-code/credits.json` (never written by
    pi; epoch-seconds markers tolerated — verified against live reference state files) —
    cloud mode + matching `base_url` + numeric balance + ≤ 7 d freshness +
    `COGNEE_STATUSLINE_CREDITS` opt-out; `≤ $1 → top up: <COGNEE_BILLING_URL|default>`,
    `> 15 m → (Nm/Nh/Nd ago)`, `· last <label> ~$<cost>`. Divergences: plain text (no ANSI —
    pi's footer renders plain, glyphs carry the semantics), a 120-visible-char soft cap that
    sheds pieces in the reference's reverse priority order (age hint → last-op → credits →
    cumulative turns → per-turn hits; the reference never truncates), no update segment /
    self-eviction (no plugin marketplace), no per-session marker files (`conn-state/`,
    `llm-state/`, `recall/<sid>.json` — one process per terminal holds state in memory;
    recall totals reset on restart).
  - **Idle bridge**: the detached watcher maps to `agent_settled` + `message_end(user)`
    re-arming ONE timer (`COGNEE_IDLE_THRESHOLD_MS`, default 60 s — the timer IS the activity
    touch; no `activity.ts`, no pidfile, no respawn). On fire: at most one improve attempt
    per arm; a `cooldown`/`backoff` verdict re-arms exactly once at the persisted expiry (a
    quiet stretch that outlasts the cooldown still gets exactly one bridge); `no_new_entries`
    does nothing (the next stored write re-arms); `session_shutdown` clears the timers and
    never improves on the way out (parity with the reference watcher's stop rule — the final
    sync owns promotion). `COGNEE_IDLE_IMPROVE=false` disarms the trigger alone.
  - **Persisted improve-cooldown** (`src/improve-state.ts`): `improve-state/<sha1(sid)>.json`
    + the `improve-counter.json` stored-write map, field-for-field with the reference
    (`last_improved_at` [ms in pi's tree], `turn_count_at_improve`, `trigger`; failure merges
    keep the last success and add `last_failed_at`/`last_failure_reason[:120]`/
    `failure_count`). The in-memory `lastAutoImproveAt` gate is REPLACED: both automatic paths
    (idle + every-N) consult `improveThrottleReason()` — `cooldown` / `backoff` /
    `no_new_entries` / `""` — so a session improved 10 min ago stays quiet across a relaunch,
    a failed improve gets one auto attempt per window, and a session with no new stored
    writes is skipped (the persisted counter is what makes that meaningful). The counter
    bumps once per successfully SENT entry (the analog of the reference's per-trace/qa bump).
    All five triggers flow through one `submitImprove()` wrapper — only confirmed outcomes
    stamp the state (`ok`/`busy` → success, `error`/`unsupported` → failure with a
    `timeout`/`unreachable`/`HTTP <n>` token); the final/manual/switch syncs stay ungated
    (parity).
  - **Disk-backed write bridge** (`src/bridge.ts`): `state.writeQueue` becomes the in-memory
    view of `~/.cognee-plugin/pi/bridge/<sha1(sid)>.json` — one flat `{entries, fail_count,
    fail_at}` per cognee session id (documented divergence from the reference's per-host-scope
    `(dataset, session_id)` map: pi's switch mints a new session id so a session never spans
    datasets, and per-session files eliminate the cross-terminal read-modify-write race;
    `buffer.lock`/`drain.lock` unnecessary — atomic rename suffices). Spill policy: capture
    while the server is unusable → immediate spill (never sent → never ambiguous); first
    failed retryable drain → that entry plus everything queued behind it spills in order,
    the failed one stamped `_replay_ambiguous` per the reference §1.5 classification
    (`writeOutcomeAmbiguous`: 503 + positively-refused/DNS = unambiguous; timeouts, aborts,
    500/502/504, unknown transport = may-have-committed — `/remember/entry` has no
    idempotency, so a blind replay would duplicate); permanent 4xx still drops loudly from
    memory and, for a buffered head, enters the file's doubling 60 s → 3600 s drain backoff
    (any progress resets; the forced final-sync pass never stamps backoff so a relaunch
    always replays). Replay is strictly head-first over the merged view (the session's file
    first, then the memory tail, then other sessions' oldest spill — retired/stranded
    sessions drain under their own binding), verify-before-replay for ambiguous QA AND trace
    heads (one `GET /api/v1/sessions/{id}` read; a fingerprint match consumes the entry WITHOUT
    re-sending — `deduped`; QA = `(type, question, answer, context)`, trace = `(type,
    origin_function, status, method_params, method_return_value, error_message)` with
    JSON params canonicalized by sorted keys, exactly the reference field set; a detail failure
    replays, fail-open), background drains time-boxed
    by `COGNEE_DRAIN_BUDGET_MS` (20 s; per-request timeouts clamp to the remainder), and
    `COGNEE_BUFFER_LIMIT` (100) now bounds the file with drop-oldest. Session start sweeps
    files older than 7 d and the post-health drain replays the backlog BEFORE any new capture
    lands (FIFO holds — head-first); the bounded final sync naturally drains the file and
    whatever remains stays spilled for the next launch — the documented replacement for the
    reference's detached `--detached-final` worker. Buffered turns now SURVIVE a pi exit
    while the server is down (previously lost); the crash-window divergence that remains (a
    write in flight at the instant the host dies) exists in the reference too. `/cognee` and
    `/cognee-doctor` surface `spilled`/`deduped` counts and the idle-sync setting.
  - **Live format verification** (read-only, against this machine's real Claude Code plugin
    state): the reference's `improve-state/*.json` fields and `counter.json` map shape match
    pi's implementation exactly (unit divergence noted: reference stores epoch seconds, pi
    stores ms — separate trees, self-consistent; the shared credits reader tolerates both).
  - **Test coverage** — 8 new hermetic offline checks in `test/smoke.mjs` (spec §4): spill/
    replay crash round-trip across two factory instances (500 → ambiguous spill → relaunch →
    exactly one replay + counter bump + file unlink + one verify read), verify-before-replay
    for BOTH kinds (fingerprint match consumes without send — QA rows and trace rows with
    reordered `method_params` keys alike; detail 500 replays fail-open; the fingerprint unit
    table covers the reference's trace field set and key-order canonicalization), the ambiguity
    classification unit table, the cooldown-file semantics unit table (cooldown/backoff/
    no_new_entries ordering, failure-merge preservation), the idle bridge (one attempt per
    arm, trigger logged, cooldown re-arm at the exact expiry, `session_shutdown` clears
    timers), render snapshots (all five glyphs, hits + cumulative, warming-up, awaiting
    replay, credits normal/aged/low+top-up/seconds-unit/hidden, `COGNEE_STATUSLINE_COUNTS`
    modes, the 120-char cap shedding order), the counter/improve interplay across a restart
    (`no_new_entries` until a new stored write), and the drain backoff (401 streak grows
    `fail_count`, window skips all fetches, past-timestamp re-attempt, progress reset).
- **Shared-agent-memory provisioning** (README gap 4; research/v04-provisioning-spec.md) —
  the write/grant side of the cross-agent memory model, ported field-for-field from the
  official plugins' `_plugin_common.py`/`session-start.py`: plugin identity provisioning
  (`POST /api/v1/integrations/plugins/pi/provision?create_only=true` as the principal —
  create-only contract verified against `/openapi.json` BEFORE any POST, because older
  servers ignore unknown query params and rotate keys; response validation in the reference
  order `not_an_object` → `incomplete` → `missing_agent_id` → `agent_key_equals_principal`;
  404/405 → `unsupported`, anything else → `failed`; both fail closed), the `agent-key.json`
  identity cache (0600, atomic, principal-fingerprint-bound, `blocked` stamped on a 401/403
  and never auto-re-provisioned), and the `ensureSharedMemory` wiring (permissions probe →
  typed-dataset-ids capability → parent/tenant resolution with the tenantless-with-data
  guard → `cognee-agent` role get-or-create → agent membership + tenants/select **as the
  agent** + role membership → read-then-write grant backfill per dataset memoized in the
  `shared-memory.json` marker (`"ok"` never retried, denials retried hourly) → canonical
  parent-owned dataset resolution with create-as-parent and the deterministic oldest-copy
  pick). Session start runs the whole flow once after health resolves (≤10 s budget,
  fail-soft): `COGNEE_PLUGIN_IDENTITY` × `COGNEE_SHARED_AGENT_MEMORY` mode matrix with the
  structural-reason memo keyed on the plugin version, revert-after-provision rollback
  (auto mode: revoke the fresh key server-side, clear the cache, run as the principal),
  and the canonical UUIDs pinned into the persisted switch record (`dataset_id`/
  `dataset_ids` — keyed on the **principal** fingerprint so an identity flip never orphans
  the switch). Data plane: `remember/entry` writes and `improve` promotions address the
  canonical UUID; graph recall widens to the read set with precedence env federation >
  shared-memory ids > explicit dataset (session binding dropped on that lane like
  federation). Switcher: writability narrowing via
  `GET /permissions/principals/{user}/datasets?permission_name=write` + `via_role` from the
  live marker (read-only rows hidden with the reference's `(N read-only dataset(s) not
  shown)` note; `(write access could not be verified — showing every readable dataset)`
  when the route is absent; read-only/unresolvable-UUID targets refused when verified —
  unverifiable targets stay permissive, pi's fail-soft divergence), switches resolve as the
  principal under a live marker, and opting out leaves the role and demotes the marker
  keeping the ids. Doctor: **Memory** and **Provisioning** rows (reference strings) + the
  plugin-identity API-key label. **Graceful degradation on cognee 1.6.0** (verified live,
  read-only): the server advertises neither `create_only` nor `x-cognee-session-dataset-ids`,
  so the client verdict is `unsupported` and **zero** provisioning/tenant/role/grant calls
  are issued — the single-principal key chain of v0.3 is kept byte-for-byte, and the full
  flow lights up the moment a server catches up. Deliberate skips: no idle-watcher 60 s
  refresh, no interactive identity reconnect, no conn-handle register/unregister dance
  (gap-3 divergence stands), no statusline identity/credits segments, no cross-process file
  lock (in-process single-flight; the create-only contract makes the race benign).
- **Tool-call trace capture** (README gap 2; research/v04-traces-spec.md) — the `PostToolUse`
  equivalent: a `tool_result` handler stores every ALLOWED tool call as an OpenAPI `TraceEntry`
  in the session cache (`POST /api/v1/remember/entry`, same tier as the QA pairs; promoted into
  the graph by the shared improve cadence and final sync). Reference capture policy verbatim:
  `COGNEE_CAPTURE_TOOLS` allowlist (default = the reference matcher translated to pi tool names
  `bash|powershell|read|write|edit|grep|find|ls`; a user value replaces it), compiled-in
  sensitive-path deny list + `COGNEE_CAPTURE_DENY_PATHS` extras (entry-level refusal — a hit
  drops the whole trace, never partially redacted; only path-ish keys tested, basename or
  normalized full path, backslash/case normalized), recursive redaction BEFORE truncation
  (`redactForCapture`: secret-ish dict keys wholesale → `[redacted:credential]`; the shared
  string-rule set aligned to the reference superset — `sk-ant-`, `github_pat_`, bcrypt added,
  tags renamed to `[redacted:private-key]`-style; `COGNEE_CAPTURE_REDACT_PATTERNS` custom regexes
  → `[redacted:custom]` with newline separators; `COGNEE_CAPTURE_REDACT=false` opt-out), and the
  hard self-reference skip (`cognee_*` tools and shell lines mentioning `cognee`, even when the
  allowlist admits them). Caps byte-exact per the reference (4000B params / 8000B return / 500B
  error, multibyte-safe, lone surrogates round-tripped to U+FFFD so binary tool output cannot
  500 the server's session endpoints); `generate_feedback_with_llm` always `false`. Traces ride
  the existing bounded write queue with capture-time session+dataset binding (a mid-turn
  `/cognee-datasets` switch can never mis-attribute them), drop-oldest at `COGNEE_BUFFER_LIMIT`,
  and the shared `capturedCount` drives `COGNEE_AUTO_IMPROVE_EVERY`. `/cognee`'s Queue line counts
  them automatically; `/cognee-doctor` gained a *Capture pol* row surfacing malformed-knob
  errors and skipped invalid regexes (never fatal). Divergences: no per-trace toast (silent
  success — at per-tool-call volume the reference's per-store notices are noise), no Claude
  `Agent`-tool analog (no pi builtin; the user allowlist covers custom tool names).
- **Local server bootstrap** (README gap 1; research/v04-bootstrap-spec.md) — pi-cognee now boots
  the local cognee server the way the official Claude Code / Codex plugins do, against the same
  shared state (`~/.cognee-plugin`): a per-process-gated trigger (session start or an unreachable
  health probe) runs a ~2.5s presence probe first — a running server is **adopted as-is** (never
  restarted, never version-checked), a busy/unknown one is refused (log line
  `boot_refused_server_present`; installing under a busy server corrupts its databases), and only
  a positively-absent server is installed over: self-managed/PATH/auto-installed `uv`,
  `uv venv --python 3.12` (`COGNEE_PLUGIN_PYTHON`), `uv pip install cognee==1.6.0` (hardcoded
  pin) + provider extras detected from the effective env, skip-at-pin when the shared venv
  already satisfies the pin (the install-lock loser probes the venv at every 0.5 s poll and
  short-circuits at a satisfied pin instead of stalling behind another plugin's install), then a
  detached localhost-only uvicorn on the configured port with console capture through a
  detached pump process (`server-console-<port>.log`, first 1 MiB per boot, previous boot
  rotated to `.1` — the server never holds the file fd, so a chatty server cannot grow the
  capture past one boot's worth), pidfile presence evidence, and a
  `COGNEE_SERVER_BOOT_DEADLINE`-bounded health wait. Cross-process single-flight via the shared
  O_EXCL JSON locks (`venv-install.lock`, `server-bootstrap.lock`) with reference-format stale
  reaping — pi, Claude Code, and Codex mutually exclude on one machine-wide server. Status
  surface: `◐ cognee: starting` while booting, one-time notice, then the existing health path;
  `/cognee-doctor` gained *Local runtime* (uv/venv/pin/bootstrap state) and *Server pidfile* rows;
  events append to `~/.cognee-plugin/pi/bootstrap.log` (JSON lines, rotated). Deliberate
  divergences: `COGNEE_AGENT_MODE` is not set (a pi-booted server persists), the bootstrap is an
  in-process task (no detached worker, `COGNEE_LAZY_BOOTSTRAP` not read), no `python3 -m venv`
  fallback, posix only. Opt out with `COGNEE_LOCAL_BOOTSTRAP=off` (v0.3 behavior exactly).
- **Test coverage** — 17 new hermetic offline checks in `test/smoke.mjs` for the trace cluster
  (spec §6: pure-helper suites for the glob translator / list parser / allowlist + deny
  semantics / redaction / byte-exact truncation / entry construction; wire-level harness driving
  the recorded `tool_result` handler through a healthy stub session — entry shape, error status,
  allowlist widening + case sensitivity + master switch, deny-list refusals incl. nesting and
  backslashes, redaction incl. comma-bearing custom patterns and the off switch, caps with a
  secret straddling the cut (redact-before-truncate), self-reference skips, capture-time binding
  across a live `/cognee-datasets` switch, non-JSON-safe inputs / lone surrogates / handler
  throw-path fail-soft, and the doctor row) — plus the developer-only live exercise
  `COGNEE_LIVE_BASE_URL=… node test/probe-traces.mjs` (real factory against a real server:
  trace rows read back from the session cache with redaction verified on the STORED copy,
  refusals verified by row-count stability; disposable `pi-cognee-traces-selftest` dataset,
  pre-cleaned and forgotten). 16 further hermetic offline checks cover the bootstrap cluster
  (spec §5.1: install-spec
  mapping, findUv/installUv with stubbed curl, version/extras probes, lock semantics incl.
  dead-pid/aged reaping, skip-at-pin, the install-lock loser's in-wait skip-at-pin
  short-circuit (probe at every poll; negative control proves an off-pin venv keeps waiting),
  adopt, all four presence verdicts + pidfile reaping, full
  stubbed boot, the console pump (a >1 MiB chatty boot stays capped for the server's lifetime;
  the next boot rotates the previous capture to `.1`, both files bounded),
  child-exit-before-healthy (incl. late-claimer adoption), deadline bound,
  buildServerEnv precedence/denylist/no-agent-mode, fail-soft end-to-end through the factory,
  once-guard, factory purity under a patched `spawn`), plus the developer-only live exercise
  `PI_COGNEE_BOOTSTRAP_LIVE=1 node test/bootstrap-live.mjs` (real uv install + detached uvicorn on
  an ephemeral port inside a throwaway state root; kills exactly what it spawned).

### v0.3.0

- **Stale `last_status` fixed (code-graph state)** — `/cognee-index --wait` now writes the
  poll's terminal status back into the repo's index-state file (`last_status: COMPLETED /
  ERRORED`, plus `last_status_at` stamped at observation time); v0.2 left the
  submission-time value (`running`/`submitted`) in the file forever after the server
  finished. A defensive `FAILED` suffix class is now terminal too (stops polling with the
  same message shape as `ERRORED` instead of burning the wait budget). Fail-soft: abort /
  budget-expiry keep the submission value (still accurate), and an unwritable state dir
  never fails the command.
- **Update-when-changed for `--file` memories (`PATCH /api/v1/update`, cognee ≥ 1.6.0)** —
  re-ingesting a file previously stored via `cognee_remember file=` / `/cognee-remember
  --file` no longer adds a duplicate data item. The client discovers the stored item by
  exact filename (latest `createdAt` on same-name twins), compares content hashes
  statelessly, no-ops on identical bytes ("unchanged — nothing sent": zero POST/PATCH — the
  read-only discovery GETs still run), and PATCHes changed
  content under the same `data_id` — the server re-ingests only affected chunks and
  transparently falls back to a delete+re-ingest under the same id (the fallback reason is
  surfaced). Discovery failures degrade to today's plain add; a **failed** update never
  falls back to an add (the document still exists — a duplicate would corrupt identity);
  a 404 race with `forget` re-adds. Prose memories stay append-only; `/cognee-index` is
  untouched (whole-repo specs hold no per-file `data_id` — research/v03-update-spec.md §4).
- **Switcher live driver** — `test/probe-switcher.mjs` drives the real `/cognee-datasets`
  handler closure (jiti-loaded factory + stub host surface, zero production refactor —
  research/v03-fixes-spec.md §B.2) end-to-end against a live server: seed→record
  precedence, create-on-switch, ordinal session mint, record persistence +
  cross-process affinity, capture/recall re-pointing, switch-back, and disposable-dataset
  cleanup with a pre-clean pass (21 PASS / 0 FAIL / 1 characterized SKIP on cognee
  1.6.0-local, ~45 s).
- **Live finding — server recall is not dataset-isolated (cognee 1.6.0-local, verified
  2026-09-24)** — `/api/v1/recall` retrieval matches across the whole user memory even
  when the payload scopes `datasets` (name) or `dataset_ids` (UUID), including pure
  `CHUNKS` retrieval (no LLM involved); cross-dataset content can surface in a scoped
  query's context/completions. pi-cognee keeps sending the scoped reference payload, so
  dataset isolation remains a server-side property until the server enforces its filters.

### v0.2.0

- **Auto code-recall lane fix** — the lane was verified reference-identical on the wire
  (research/findings-codelane.md), but its discharge counted the server's *empty-result
  envelope* (`{"operation": "query_facts", "facts": [], "total": 0}`) as a hit and injected
  the raw JSON into the prompt — the "empty code facts" bug. Empty envelopes are now
  filtered before counting hits (`codeItemHasData`), in both the auto lane and the explicit
  `cognee_code` tool/command (which now falls through to its "No code facts for X" warning).
  The lane also now sends the reference's literal request shape (full prompt as query,
  session id attached on the code scope, `top_k=5`, repo dataset from index state,
  `code_query` attached) and renders the code section **before** the memory block, matching
  the reference's order. Documented: closure-nested symbols are invisible to the enola graph.
- **Dataset switcher** — `/cognee-datasets` lists datasets (reference picker format) and
  `/cognee-datasets <name>` switches: strict pre-switch sync (abort unless `--force`),
  validate/ensure the target (ambiguous names refused; unlisted names created on switch),
  ordinal session-id minting (`pi_<session>__2`, `__3`, …), atomic persist + read-back verify
  with rollback ("nothing was changed"), and a record at
  `~/.cognee-plugin/pi/active-dataset.json` keyed by server URL + key fingerprint that wins
  over the `COGNEE_PLUGIN_DATASET` seed across restarts (session affinity). Switch provenance
  shows in `/cognee`, `/cognee-doctor` (source + state-file path), and the statusline. The
  code lane and federated reads stay independent of the session dataset.
- Parity triage of cognee 1.6's new endpoints (research/v02-spec.md §2): none are
  reference-parity-relevant — all parked.

### v0.1.0

Initial release: two-tier memory, auto capture/recall, federation, code graph, forget flow,
circuit breaker, pre-compact anchor, per-file code ingestion.
