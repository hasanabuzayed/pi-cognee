<div align="center">
  <a href="https://www.cognee.ai">
    <img src="https://raw.githubusercontent.com/topoteretes/cognee-integrations/main/assets/cognee-logo.svg" alt="Cognee" width="260">
  </a>
  <p><strong>Cognee memory for the pi coding agent</strong> — persistent knowledge-graph memory with automatic capture of prompts, answers, and tool calls, and relevant recall on every turn.</p>
  <p>
    <a href="https://docs.cognee.ai">Docs</a> ·
    <a href="https://discord.gg/NQPKmU5CCg">Discord</a> ·
    <a href="https://github.com/topoteretes/cognee">Cognee core</a>
  </p>
</div>

# pi-cognee

A native TypeScript extension for [pi](https://github.com/earendil-works/pi-coding-agent) that adds
[Cognee](https://github.com/topoteretes/cognee) persistent memory. No MCP, no extra npm
dependencies — a self-contained HTTP client (Node 18+ global `fetch`) speaking the same
server API as the official Claude Code and Codex cognee plugins, so all three agents can share
one memory.

**Resilience is a core requirement.** The extension must never break or slow down pi when the
cognee server is missing, slow, or erroring:

- every network call is bounded by a short timeout (recall 4s, health 2.5s, requests 10s),
- every hook, tool, and command body is fail-soft — server down means a one-time quiet
  "offline" notice and tools returning a helpful error string, never a crash or a hang,
- a circuit breaker pauses auto-recall after repeated failures (file-shared across pi
  processes via `~/.cognee-plugin/pi/breaker.json`) and a background probe
  reconnects automatically when the server comes back,
- auto-captured turns and tool traces are buffered while the server is down and replayed on
  reconnect — buffered on DISK (`~/.cognee-plugin/pi/bridge/<session>.json`) once a send fails
  retryably, so they survive a pi exit and replay at the next launch (verify-before-replay
  dedupes sends that may have committed; shutdown makes one last bounded flush attempt first).

## How it works — two memory tiers

1. **Session cache (server-side).** Each finalized user prompt is paired with the assistant's
   final answer into one `qa` entry, and (v0.4) every allowed tool call lands as a `trace` entry
   (`origin_function`, status, redacted params/return) — both written to
   `POST /api/v1/remember/entry` under a per-session cognee session id
   (`pi_<pi-session-id>`). Secrets are redacted and huge payloads
   skipped before anything leaves the process (see [Capture policy](#capture-policy)).
2. **Permanent knowledge graph (per dataset).** The session cache is promoted into the graph via
   `POST /api/v1/improve` — automatically every `COGNEE_AUTO_IMPROVE_EVERY` captured entries
   (QA turns + traces), on
   shutdown (one bounded flush: a 1s health re-probe, a ≤4s buffered-write drain, a ≤4s improve
   submit), or manually with `/cognee-sync` or the `cognee_sync` tool. Explicit knowledge goes
   straight to the graph via `/cognee-remember` or `cognee_remember`.

3. **Code graph (per repository).** `POST /api/v1/remember` with `content_type="code"` submits a
   repository to cognee's enola pipeline (requires cognee ≥ 1.5.4) — a deterministic graph of
   symbols, calls, imports, endpoints and dependencies, **no LLM or embedding calls** (fast,
   token-free). Each repo gets its own narrow dataset `codebase-<repo-name>-<digest>` (the digest
   is the indexed path, so two checkouts sharing a basename never land in one graph). See
   [Code graph](#code-graph).

On every user prompt, before the model runs, the extension recalls relevant graph memory
(`scope=["graph"]`, `search_type=HYBRID_COMPLETION`, `only_context=true`, `top_k=5` — the same
pinned request the official plugins send), only while the server is healthy. When the prompt
contains an identifier-shaped token (`process_payment`, `UserService`, `billing/api.py`) and the
cwd sits inside an indexed repo, a **code recall lane** runs concurrently (same recall budget,
never sequential) and its hits are appended as a bounded `=== Code graph facts ===` section.
Hits are injected as a bounded context block that opens with `=== Cognee memory ===` and a stats
line (`Cognee memory: 3 memory hits · 2/5 turns had hits this session`), capped at
`COGNEE_CONTEXT_MAX_CHARS` (default 2000) — individual memories are injected whole (no per-item
cap, matching the official plugins since 1.6.0). When recall is skipped or fails, the model
instead sees a one-line outage header so consulted-and-failed memory is never silent:
`=== Cognee memory: recall skipped (server unreachable|auth failed|server error|server not
responding|circuit breaker open) · N awaiting replay ===`.

When the context window is about to be compacted (`session_before_compact`), the extension
stores a **memory anchor** into the session-cache tier first: one session-scoped graph recall
(`top_k=3`, seeded by a keyword query built from the transcript being compacted) verbatim
(capped at 8000 chars — it is stored as a session-cache QA answer), falling back to the recent
turns themselves when the graph has nothing — so post-compact
auto-recall keeps continuity. Detached and fail-soft: compaction itself is never blocked.

## Install

**Requirements.** A cognee API server the extension can reach (in local mode pi-cognee
[boots one automatically](#local-server-bootstrap) since v0.4 — or you run your own), and
Node 18+ (the extension itself stays a pure HTTP client; only the bootstrap spawns processes,
strictly from the session-start/health-reprobe background paths).

**Try it once, no persistence:**

```bash
pi --extension ./src/index.ts        # from a checkout of this repo
```

**Dev / personal use** — drop this repo (or a `pi-cognee/` directory containing `index.ts`)
into `~/.pi/agent/extensions/`, or use the explicit flag in your launch alias.

**As a package:**

```bash
pi install ./local-pi-cognee         # local directory
pi install npm:pi-cognee             # from npm (once published)
pi install git:github.com/topoteretes/cognee-integrations@main
```

Manage with `pi list`, `pi remove`, `pi update --extensions`.

## Quickstart

Configure once in `~/.cognee/.env` — the file is shared with the official Claude Code and
Codex cognee plugins, so one configuration covers every agent. Shell exports always override
the file. Re-pasting a block is safe: when a key appears more than once, the **last value wins**.

**Local mode** (default when `COGNEE_BASE_URL` is not set) — the extension talks to a local
cognee API at `http://localhost:8011`. `LLM_API_KEY` is required by the *server* (pass-through),
not by this extension. Cognee ≥1.2.2 enforces auth even on localhost, so a data-plane key is
needed too — when `COGNEE_API_KEY` is not set, pi-cognee logs into the local server as the
default user and auto-mints an owner API key (reusing an existing one when present), cached in
`~/.cognee-plugin/api_key.json` — the same shared cache the official plugins use. For the mint
to succeed, start the server with `DEFAULT_USER_PASSWORD` set to the same value as
`COGNEE_USER_PASSWORD` (defaults: `default_user@example.com` / `default_password`), or set
`COGNEE_API_KEY` explicitly:

```bash
mkdir -p ~/.cognee
cat >> ~/.cognee/.env <<'EOF'
LLM_API_KEY="sk-..."
# Optional — only if you disable/replace the auto-mint:
# COGNEE_USER_PASSWORD="default_password"
# COGNEE_API_KEY="ck_..."
EOF
chmod 600 ~/.cognee/.env
```

Start the server (pi-cognee **boots it automatically** since v0.4 — see
[Local server bootstrap](#local-server-bootstrap); to run one yourself instead:
`DEFAULT_USER_PASSWORD=default_password uvicorn cognee.api.client:app --port 8011`).

On startup you should see a **"Cognee Memory Connected"** notification. If the server is not
running, you get a one-time quiet notice instead — pi keeps working normally and the extension
reconnects automatically once the server is up.

**Cognee Cloud or a remote server** — set both:

```bash
mkdir -p ~/.cognee
cat >> ~/.cognee/.env <<'EOF'
COGNEE_BASE_URL="https://your-instance.cognee.ai"
COGNEE_API_KEY="ck_..."
EOF
chmod 600 ~/.cognee/.env
```

### Which mode wins, and how to switch

1. A `COGNEE_BACKEND` export wins (`local` / `native` / `sdk`, or `cloud` / `http` / `api` /
   `server`; `COGNEE_PI_BACKEND` beats the shared name). Pinned cloud with no URL never falls
   back to local — the status line shows the missing URL.
2. Otherwise, cloud wins when `COGNEE_BASE_URL` is set (file or shell).
3. Otherwise, local at `http://localhost:8011` (`COGNEE_LOCAL_API_URL` overrides).

Unlike the official plugins, forced-local does **not** scrub `COGNEE_API_KEY` (an explicit key
for your local server is honored — pi-cognee's bootstrap only installs/spawns when the server is
positively absent, so a key never conflicts with it); `COGNEE_BASE_URL` is effectively ignored on
the forced-local path — only `COGNEE_LOCAL_API_URL` is read.

### Local vs cloud

| | Local | Cloud / remote |
|---|---|---|
| Configure | `LLM_API_KEY` in `~/.cognee/.env` (server-side) | `COGNEE_BASE_URL` + `COGNEE_API_KEY` |
| Server URL | `http://localhost:8011` (`COGNEE_LOCAL_API_URL`) | your instance URL |
| Who runs the server | pi-cognee boots it automatically ([bootstrap](#local-server-bootstrap)) or you do (`uvicorn cognee.api.client:app`) | Cognee |
| `COGNEE_API_KEY` | optional — auto-minted on loopback servers when unset | required |
| Data location | your machine | Cognee Cloud |

### Local server bootstrap

Since v0.4, pi-cognee boots the local cognee server for you — the same way the official Claude
Code / Codex plugins do, against the **same shared state** (`~/.cognee-plugin`), so all three
agents single-flight one machine-wide server (shared venv, shared locks, shared pidfile; pi's
own logs live under `~/.cognee-plugin/pi/`). With `LLM_API_KEY` in `~/.cognee/.env`, a fresh
machine needs zero setup: start pi, and memory activates a few minutes later.

- **Trigger** — at most once per pi process, from the session-start background path or an
  unreachable health probe: a ~2.5s presence probe (`/health`, loopback TCP handshake, pidfile)
  runs first; `ready`/`busy` → nothing (a running server is **adopted as-is, never restarted,
  never version-checked**), only a positively-absent server is ever installed over. Busy/unknown
  servers are refused with a log line — upgrading under a busy server corrupts its databases.
- **Install** — self-managed `uv` (or any `uv` on PATH; auto-installed otherwise),
  `uv venv --python 3.12` (`COGNEE_PLUGIN_PYTHON`), `uv pip install cognee==1.6.0` — the pin is
  a hardcoded constant, env-overridable never (parity). Provider extras are detected from the
  effective env (`postgres`/`pgvector` → `postgres-binary`, `neo4j`, `fastembed`, `ollama`).
  A venv already at the pin is never reinstalled (skip-at-pin).
- **Boot** — detached `uvicorn cognee.api.client:app --port <port>` (localhost-only, port from
  `COGNEE_LOCAL_API_URL`), console output piped into a detached capture-pump process that keeps
  the first 1 MiB of each boot in `~/.cognee-plugin/pi/server-console-<port>.log` (previous
  boot in `.1`; the server never holds the file fd, so the cap holds for its whole lifetime),
  pidfile written as presence evidence, `/health`
  polled until `COGNEE_SERVER_BOOT_DEADLINE` (600s). Single-flighted by the shared
  `server-bootstrap.lock` (stale 60s, wait 35s; losers poll health and adopt).
- **Divergences from the reference** (deliberate, see
  [Differences](#differences-from-the-claude-codecodex-plugins)):
  `COGNEE_AGENT_MODE` is **not** set (pi has no agent registration — an agent-mode server's
  zero-connections teardown would kill the shared server when the last Claude Code session
  unregisters; a pi-booted server persists until you stop it), the bootstrap is an in-process
  task (no detached worker surviving pi; a pi-kill mid-install self-heals via stale-lock reap
  + version probe on next launch), and there is no `python3 -m venv` fallback when uv is
  unavailable (a clear "install uv" error instead).
- **Opt out** — `COGNEE_LOCAL_BOOTSTRAP=off` restores v0.3 behavior exactly: never install,
  never spawn ("run the server yourself"). `/cognee-doctor` shows the local runtime row
  (uv path, venv version vs pin, bootstrap state) and the server pidfile verdict.

## Commands

| Command | What it does |
|---|---|
| `/cognee` | Status: health + latency, mode, dataset, federation state, session, API key source, capture/auto settings, recall hits, queue, breaker, code-graph state |
| `/cognee-doctor` | Diagnose: mode + why, env file and shell overrides, API key source (incl. plugin identity), reachability + latency + version, dataset list, federation state, memory sharing + provisioning verdicts, capture policy, breaker, timeouts, code graph, local runtime (uv/venv/pin + bootstrap state), server pidfile |
| `/cognee-remember <text>` | Store text in the graph. `--file <path>` ingests one file (≤200 KB, text-only) **verbatim under its real filename** — code extensions route down the zero-LLM code-graph path (single file, no cross-file edges; use `/cognee-index` for those). Re-ingesting a changed file **updates** the stored item (chunk-level diff, same `data_id`) instead of duplicating it; identical content sends nothing. `--node-set user_context\|project_docs\|agent_actions` picks the memory category. Waits briefly for cognify |
| `/cognee-search <query>` | Explicit graph search. `--top-k N`, `--dataset <name>` |
| `/cognee-datasets [name] [--force]` | List memory datasets (reference picker format, active one starred; v0.4 hides read-only rows behind `(N read-only dataset(s) not shown)` when the permissions route answers, or notes `(write access could not be verified — showing every readable dataset)` when it does not) or **switch the active dataset**: syncs the current session into the dataset being left (abort on failure unless `--force`), validates/creates the target (read-only and unresolvable-UUID targets refused when writability was verified), mints a new session id (`pi_<session>__2`, `__3`…), re-points capture/recall/sync/statusline, and persists the switch to `~/.cognee-plugin/pi/active-dataset.json` so it survives restarts and beats the `COGNEE_PLUGIN_DATASET` seed — under shared memory the target resolves as the principal (canonical UUID + grant backfill, created as the parent when absent) and the record carries `dataset_id`/`dataset_ids`. Unlisted names are created on switch; recall is scoped to the active dataset (context from the previous one stops being injected — switch back to see it; isolation is enforced by the server's `/recall` filters — see the v0.3.0 changelog note). A one-off *look* in another dataset needs no switch: `/cognee-search <query> --dataset <name>` |
| `/cognee-index [path\|git-url]` | Index a repo into the code graph (cognee ≥ 1.5.4). `--dataset <name>`, `--index-vectors` (embed code facts for semantic search), `--wait <seconds>` (poll until queryable). Default dataset `codebase-<repo>-<digest>`, printed on success. Local paths need a server sharing this filesystem (cloud servers reject them — pass a git URL; the command warns) |
| `/cognee-code <seed> \| '<operation-json>'` | Query the current repo's code graph: a plain word is a seed (exact/suffix/substring); or an exact operation — `{"operation":"impact_analysis","targets":["process_payment"]}`, `query_facts` (e.g. `kind:"route"` lists endpoints), `explore`, `traverse`, `find_path`, `delta` (what the last index changed). `--dataset <name>`, `--top-k N` |
| `/cognee-sync` | Promote this session's cache into the permanent graph (manual, ignores nothing) |
| `/cognee-forget [dataset] [dataId]` | Irreversible delete. No args lists datasets. With a dataset and no dataId it lists that dataset's stored data items and lets you pick one to delete (UI picker; non-UI prints data_ids to re-run with). Asks for confirmation with a content preview (add `--yes` in non-UI modes) |

## Code graph

Structural questions about a codebase — *what calls X, what breaks if X changes, how does A
reach B, list all endpoints* — are answered by a **code graph** built per repository, not by
semantic memory. Indexing runs cognee's enola pipeline server-side (deterministic, no
LLM/embedding calls); querying is exact and instant.

```
/cognee-index .                          # index the cwd's repo (local server)
/cognee-index https://github.com/o/r --wait 60   # cloud server: git URL, poll until queryable
cognee_code(operation="impact_analysis", targets=["process_payment"])   # from the model
/cognee-code '{"operation":"delta"}'   # what the last (re-)index changed
```

**Which search when:** a structural question naming a symbol/file → `cognee_code` / `/cognee-code`.
A conceptual question naming nothing ("how does auth work here?") → `cognee_search` /
`/cognee-search` — but note code-graph facts are invisible to it unless the repo was indexed
with `--index-vectors`. Chain them: hybrid search discovers the name, code search gives the
exact structure. Treat code-graph results as a map, not ground truth — verify against files.

**Automatic indexing.** Opening pi inside a git repository indexes it automatically in the
background (after the first successful health probe — never blocking startup) when the repo has
1–3000 source files. `COGNEE_CODE_AUTOINDEX` controls it:

| Value | New repos | Notes |
|---|---|---|
| `auto` (default) | indexed only when the server URL is **loopback** (`localhost` / `127.0.0.1` / `::1` / `0.0.0.0`) — the code never leaves the machine | any other server (cloud, or a `COGNEE_LOCAL_API_URL` pointed at a LAN host) is skipped: shipping a private checkout off-machine needs explicit consent |
| `always` | indexed against any server | opt-in for remote servers |
| `off` | never auto-indexed | explicit indexing still works |

Already-indexed repos are always refreshed when the tree changed — regardless of the setting
(the index command was the consent). Not a git repo, no code files, or >3000 source files →
skipped; index explicitly if you want it (no size cap on explicit indexing).

**Freshness.** After any agent turn that changed the working tree, a git fingerprint (HEAD +
dirty paths + diff + untracked stats; `.enola/` excluded) triggers a debounced background
re-index. What the graph can reflect depends on where the server runs — both are normal, but
the results look identical:

| Server | Graph reflects | Stays current via |
|---|---|---|
| **Local** | the working tree, **uncommitted and untracked changes included** | automatic re-index after turns that change the tree |
| **Cloud / remote** | the **last pushed commit** (the server clones the repo; local paths are rejected) | pushing, then re-indexing |

On a cloud server, local edits are invisible until pushed — say so when answering from a
cloud-indexed graph during in-progress work; `{"operation":"delta"}` shows what the graph
actually knows. `~/.pi`-side state lives in `~/.cognee-plugin/pi/code-graph/`; re-indexing an
unchanged repo is skipped server-side (content hashes), so re-running `/cognee-index` is safe.

**`.enola/` snapshot.** Indexing writes enola's snapshot to `<repo>/.enola/` (untracked). Add it
to `.gitignore` or global excludes — the extension's change detection already ignores it:

```bash
printf '\n.enola/\n' >> .gitignore
```

**Code recall lane.** Once a repo is indexed from its checkout, the per-prompt memory recall
adds a `code` lane automatically when the prompt mentions an identifier-shaped token
(`process_payment`, `UserService`, `billing/api.py`) — the facts appear as a bounded
`=== Code graph facts ===` section (1000-char hard cap) rendered **before** the memory block.
The lane sends exactly what the official plugins' auto lane sends (verified against the
reference source and a live server): `scope=["code"]`, `top_k=5`, the full prompt as the
query, `code_query = {operation: "query_facts", name: <identifier>, limit: 5}`, the session
id, and the repo's own dataset from index state. It runs concurrently with the graph recall
inside the same recall budget, so it can never add latency beyond it. Two behaviors worth
knowing:

- **Empty results are never injected.** For a symbol the graph cannot resolve, the server
  returns a single envelope entry (`{"operation": "query_facts", "facts": [], …}`) — it is
  filtered out before counting hits, so the lane stays silent instead of injecting raw JSON
  (v0.1 injected it; fixed in v0.2). The explicit `cognee_code` tool applies the same filter.
- **Closure-nested symbols are invisible to the graph.** The enola indexer records
  module-level declarations and class members — a function nested *inside* another function
  (like the helpers inside this extension's factory) has no fact, so prompts naming one
  legitimately find nothing. Flat files and classes are the coverage unit.

## Tools (model-facing)

| Tool | Use when… |
|---|---|
| `cognee_remember(content \| file, node_set?, dataset?)` | The user states a lasting preference, decision, convention, or fact — or asks you to remember something. `file` uploads one file from disk under its real filename (code extensions → zero-LLM code-graph route); a changed re-upload updates the stored item instead of duplicating it |
| `cognee_recall(query, search_type?, session_only?, top_k?)` | Targeted memory lookup mid-task; `session_only=true` reads this session's raw Q&A cache |
| `cognee_search(query, top_k?, dataset?, search_type?)` | Broad/exploratory graph search, cross-dataset (incl. memories written by the Claude Code / Codex plugins; federated reads apply when `COGNEE_PLUGIN_READ_DATASET_IDS` is set) |
| `cognee_code(seed?, operation?, name?/start?/source?+target?/targets?/kind?/limit?/max_depth?/direction?, repo?, dataset?, top_k?)` | Structural code questions naming a symbol/file: callers of a seed, `impact_analysis` (what breaks if X changes), `find_path` (how A reaches B), `query_facts kind:"route"` (all endpoints), `explore`/`traverse`, `delta` (what the last index changed) — exact, instant, no tokens. Conceptual questions → `cognee_search` |
| `cognee_forget(dataset, data_id?, entire_dataset?)` | The user explicitly asks to remove wrong/outdated/sensitive memories (irreversible) |
| `cognee_sync(dataset?)` | The user asks to save this session's memory to the graph |

All tool output is truncated at 4000 chars. Tool descriptions teach the model *when* to reach
for memory, so you should not need to prompt for it.

## Capture policy

Auto-capture follows the official plugins' rules. **QA pairs** (prompts + answers into the session
cache) and **tool-call traces** (v0.4 — every allowed tool result as a `TraceEntry` in the same
session cache, the `PostToolUse` equivalent on pi's `tool_result` event) share one policy:

- `COGNEE_CAPTURE=false` disables all automation (QA capture, tool traces, **and** auto-recall);
  explicit tools and commands keep working,
- secrets are **redacted before truncation** (so a clipped key cannot escape): private-key
  blocks, database URIs, bearer/basic tokens, `key: value` credential pairs, `sk-…` / `sk-ant-…` /
  `gh[pousr]_` / `github_pat_` / `xox…` / `whsec_…` vendor keys, bcrypt hashes, and — traces only —
  dict values under secret-ish keys (`authorization`, `x-api-key`, `*secret`, `*token`,
  `*password`, `*api_key`, …) replaced wholesale → `[redacted:<kind>]`,
- the **tool allowlist** (`COGNEE_CAPTURE_TOOLS`) defaults to the reference matcher translated to
  pi tool names (`bash|powershell|read|write|edit|grep|find|ls`); a custom value replaces it —
  widen to custom/MCP tools (`mcp__*`) or narrow at will; case-sensitive fnmatch globs,
- the **sensitive-path deny list** refuses the WHOLE trace when a path-ish input key
  (`path`/`paths`/`file_path`/`filepath`/`notebook_path`/`filename`) carries a credential-looking
  file (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, `*/.aws/credentials`, `*/.ssh/*`,
  `*.p12`, `*.pfx`, `secrets.*`, `credentials.*` + `COGNEE_CAPTURE_DENY_PATHS` extras) — never
  partially redacted; non-path keys (e.g. a `grep` pattern) are not denied,
- **self-reference is skipped** even when the allowlist admits it: this extension's own
  `cognee_*` tools and shell lines mentioning `cognee` never feed the graph,
- trace caps match the reference: 4000 bytes per param value, 8000 for the return value, 500 for
  error text (byte-exact, multibyte-safe, lone surrogates round-tripped to U+FFFD), and
  `generate_feedback_with_llm` is always `false` (per-step LLM feedback deferred),
- huge QA payloads are skipped (prompts capped at 4000 bytes, answers at 8000; oversized prompts
  dropped rather than clipped), prompts under 5 chars and slash commands are ignored.

Explicit remember of **inline text** (`cognee_remember`, `/cognee-remember`) goes through the
same redaction — a deliberate hardening beyond the official plugins, which leave explicit
remember unfiltered: once stored, a secret is durable, cross-session, and shared with
other agents. `--file` / `file=` uploads are stored **verbatim under the real filename**
(like the official plugins' `--file` path): the filename extension is the server's
loader-routing signal, and redacting code would corrupt what the zero-LLM code path
ingests — point the tool at code, not at secrets.

**Update-when-changed on `--file` (v0.3).** A file upload is keyed by its basename in the
target dataset: re-ingesting a file whose content changed PATCHes the stored data item
(`PATCH /api/v1/update`, cognee ≥ 1.6.0) under the same `data_id` — the server re-ingests
only the affected chunks and transparently falls back to a delete+re-ingest (same id) when
chunk-level preconditions fail, so no duplicate items accumulate. Identical bytes are an
authoritative no-op ("unchanged — nothing sent": no POST/PATCH is issued; the stateless
content-hash compare against the stored text still performs its read-only discovery GETs —
datasets, items, raw). Discovery is by exact filename match (latest `createdAt`
wins on same-name twins — same-named files from different directories are a documented
limitation); any discovery failure degrades to a plain add. A failed/errored update does
**not** fall back to an add (the document still exists — a duplicate would corrupt its
identity); a 404 (someone forgot the item mid-flight) does re-add. Prose memories
(`content`) stay append-only — their synthetic names are timestamped by design. Repo
code-graph indexing (`/cognee-index`) never uses this path: it submits whole-repo specs
with no per-file `data_id` to update.

## Environment variables

Shell exports > `~/.cognee/.env` (path override: `COGNEE_ENV_FILE`) > defaults. The file also
passes through `LLM_API_KEY` / `LLM_MODEL` for a local server (reported by `/cognee-doctor`).

| Variable | Default | Meaning |
|---|---|---|
| `COGNEE_BASE_URL` | — | Cloud/remote server URL; setting it selects cloud mode |
| `COGNEE_API_KEY` | — | API key (sent as `X-Api-Key`); auto-minted on loopback servers when unset |
| `COGNEE_USER_EMAIL` / `COGNEE_USER_PASSWORD` | `default_user@example.com` / `default_password` | Login credentials for the local owner-key auto-mint (must match the server's `DEFAULT_USER_*`) |
| `COGNEE_BACKEND` / `COGNEE_PI_BACKEND` | auto | Pin `local` or `cloud` |
| `COGNEE_LOCAL_API_URL` | `http://localhost:8011` | Local server URL |
| `COGNEE_PLUGIN_DATASET` | `agent_sessions` | **Seed** for the graph dataset — set per project for scoped memory; the default is shared with the Claude Code/Codex plugins. Once `/cognee-datasets <name>` switched datasets, the persisted record wins over this seed (switch back or delete `~/.cognee-plugin/pi/active-dataset.json` to re-seed) |
| `COGNEE_PLUGIN_READ_DATASET_IDS` | — | JSON array of dataset **UUIDs** for federated **graph recall** (read-only federation; see [Federated reads](#federated-reads-cognee_plugin_read_dataset_ids)) |
| `COGNEE_PLUGIN_IDENTITY` | `auto` | Plugin-identity policy for [shared agent memory](#shared-agent-memory-cognee_plugin-identity--cognee_shared_agent_memory): `auto` (provision only to enable shared memory; fall back to the principal on any obstacle), `true`/`1`/`yes`/`on` (explicit identity — obstacles become errors/warnings), `false`/`0`/`no`/`off` (principal only). Invalid values surface the exact reference error and behave as `auto` |
| `COGNEE_SHARED_AGENT_MEMORY` | `true` | Shared agent memory wiring (tenant + `cognee-agent` role + grant backfill + canonical datasets); off exactly on `0`/`false`/`no`/`off` — the agent then *leaves* the shared role and writes its own private dataset (re-enabling rejoins the same role) |
| `COGNEE_SESSION_PREFIX` / `COGNEE_SESSION_ID` | `pi` / auto | Cognee session id (`pi_<pi session id>`) |
| `COGNEE_CAPTURE` | `true` | Master switch for auto-capture + auto-recall (gates QA pairs, tool traces, and the code lanes) |
| `COGNEE_CAPTURE_TOOLS` | `bash\|powershell\|read\|write\|edit\|grep\|find\|ls` | Tool-trace allowlist — pipe-separated globs or a JSON array; a set value REPLACES the default (the reference PostToolUse matcher translated to pi tool names; widen to custom/MCP tools or narrow). Case-sensitive fnmatch-style match |
| `COGNEE_CAPTURE_DENY_PATHS` | — | Comma-separated globs or a JSON array EXTENDING the compiled-in sensitive-path deny list (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, `*/.aws/credentials`, `*/.ssh/*`, `*.p12`, `*.pfx`, `secrets.*`, `credentials.*`); a hit refuses the whole trace entry. Only values under path-ish keys (`path`, `paths`, `file_path`, `filepath`, `notebook_path`, `filename`) are tested — basename or `/`-prefixed normalized full path, backslashes and case normalized |
| `COGNEE_CAPTURE_REDACT` | `true` | Trace redaction master switch (`false` passes input/output through — not advised). The QA pair path stays unconditionally redacted (one-line follow-up) |
| `COGNEE_CAPTURE_REDACT_PATTERNS` | — | Newline-separated regexes (or a JSON array) replacing matches with `[redacted:custom]` — newlines keep commas valid regex syntax. Invalid regexes are skipped with a `/cognee-doctor` warning (fail-soft) |
| `COGNEE_CONTEXT_MAX_CHARS` | `2000` | Cap for the injected recall block |
| `COGNEE_AUTO_IMPROVE_EVERY` | `150` | Auto-sync session→graph every N writes (0 = off) — gated (with the idle trigger) by the persisted improve-cooldown |
| `COGNEE_IMPROVE_COOLDOWN_MS` | `1800000` | Minimum spacing between AUTOMATIC syncs — persisted in `~/.cognee-plugin/pi/improve-state/`, honored across restarts (final/manual/switch syncs are ungated) |
| `COGNEE_IDLE_IMPROVE` | `true` | Arms/disarms the idle improve trigger alone (`agent_settled` + one bounded timer; the every-N path keeps running) |
| `COGNEE_IDLE_THRESHOLD_MS` | `60000` | Quiet time after a settled turn before the idle improve fires (one attempt per arm; a throttled fire re-arms once at the cooldown's expiry) |
| `COGNEE_DRAIN_BUDGET_MS` | `20000` | Time box for a background write-queue drain (per-request timeouts clamp to the remaining budget) |
| `COGNEE_STATUSLINE_COUNTS` | — | Statusline recall segment: `full` = diagnostic strip (`recall <graph>g/<code>c`); `false`/`0`/`off` hides the segment; unset = `· N memory hits · X/Y turns had hits this session` |
| `COGNEE_STATUSLINE_CREDITS` | — | Set `false`/`0`/`off` to hide the render-only credits segment (cloud mode; read from the shared `~/.cognee-plugin/claude-code/credits.json`) |
| `COGNEE_BILLING_URL` | `https://platform.cognee.ai/billing` | Top-up URL appended when the shared credits marker shows ≤ $1 |
| `COGNEE_CREDITS_FILE` | `<pi-state-parent>/claude-code/credits.json` | Explicit override for the shared credits marker path (render-only) |
| `COGNEE_FINAL_SYNC` | `true` | Bounded shutdown flush (1s probe + ≤4s write drain + ≤4s improve); anything unflushed stays in the disk bridge and replays at the next launch |
| `COGNEE_RECALL_TIMEOUT_MS` | `4000` | Per-prompt recall budget |
| `COGNEE_REQUEST_TIMEOUT_MS` | `10000` | General request timeout |
| `COGNEE_HEALTH_TIMEOUT_MS` | `2500` | Health probe timeout |
| `COGNEE_IMPROVE_SUBMIT_TIMEOUT_MS` | `60000` | Improve submit timeout |
| `COGNEE_REMEMBER_WAIT_SECONDS` | `8` | Bounded wait for graph queryability after `/cognee-remember` |
| `COGNEE_REMEMBER_BACKGROUND` | `true` | `run_in_background` default for explicit remember writes — set `false` for a synchronous, immediately-queryable write |
| `COGNEE_BUFFER_LIMIT` | `100` | Write buffer bound — now enforced on the DISK bridge file too (drop-oldest) as well as the in-memory queue |
| `COGNEE_BREAKER_THRESHOLD/WINDOW_MS/COOLDOWN_MS` | `5` / `300000` / `120000` | Circuit breaker (only unreachable/5xx count) |
| `COGNEE_BREAKER_FILE` | `~/.cognee-plugin/pi/breaker.json` | Cross-process breaker state file (open-until + consecutive-failure count, keyed by server URL) |
| `COGNEE_API_KEY_CACHE` | `~/.cognee-plugin/api_key.json` | Owner-key cache path (parity-shared with the official plugins; override for tests/isolation) |
| `COGNEE_CODE_STATE_DIR` | `~/.cognee-plugin/pi/code-graph/` | Per-repo index-state directory (dataset + fingerprint + last status; override for tests) |
| `COGNEE_PI_STATE_DIR` | `~/.cognee-plugin/pi` | Directory holding the persisted dataset-switch record (`active-dataset.json`, keyed by server URL + API-key fingerprint), the disk write bridge (`bridge/<sha1(sid)>.json`), the persisted improve-cooldown (`improve-state/` + `improve-counter.json`), and the cross-process breaker; override for tests. Its **parent** is the shared bootstrap root (venv/locks/pidfile — and the shared credits marker at `<parent>/claude-code/credits.json`), so overriding it also relocates the whole bootstrap cluster |
| `COGNEE_CODE_AUTOINDEX` | `auto` | Code-graph auto-indexing of new repos: `auto` (loopback server only), `always` (any server), `off`. `COGNEE_CAPTURE=false` disables it as part of all automation |
| `COGNEE_CODE_INDEX_TIMEOUT_MS` | `120000` | Repo-index submit timeout (background pipelines confirm slowly; a timeout is not retried blindly — the submission may have landed) |
| `COGNEE_LOCAL_BOOTSTRAP` | `on` | Master switch for the [local server bootstrap](#local-server-bootstrap): `off` = v0.3 behavior exactly (never install, never spawn) |
| `COGNEE_SERVER_BOOT_DEADLINE` | `600` (s) | Overall boot deadline — health wait after the uvicorn spawn |
| `COGNEE_INSTALL_TIMEOUT` | `600` (s) | Per `uv` subprocess timeout; the install lock's stale/wait window is this + 60 s |
| `COGNEE_PLUGIN_PYTHON` | `3.12` | Python pin for `uv venv` (uv downloads a standalone CPython when absent) |
| `COGNEE_PRESENCE_REPROBE_DELAY` | `3` (s) | Delay before the absence-confirming presence re-probe (`pre_install` stage only) |
| `COGNEE_PLUGIN_LOG_MAX_BYTES` | `20971520` (20 MiB) | `~/.cognee-plugin/pi/bootstrap.log` rotation cap |

### Federated reads (`COGNEE_PLUGIN_READ_DATASET_IDS`)

Set `COGNEE_PLUGIN_READ_DATASET_IDS` to a JSON array of dataset **UUIDs** to widen **graph
recall** across datasets you granted yourself — the same read-only federation the official
plugins ship (shell export or `~/.cognee/.env`, shell wins):

```bash
COGNEE_PLUGIN_READ_DATASET_IDS='["3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f", "01234567-89ab-cdef-0123-456789abcdef"]'
```

Find dataset UUIDs with `/cognee-forget` (it lists datasets with their ids) or the server UI.

- **Graph reads only.** Auto-recall per prompt, `/cognee-search`, `cognee_recall` /
  `cognee_search`, and the pre-compact anchor recall address the read set by UUID
  (`dataset_ids`) — the federated payload drops both the dataset name and the session
  binding ("session history remains bound to ONE dataset; federated graph recall is a
  separate read"). Writes, `/cognee-sync`, and session-cache memory **never federate**:
  they always target the single session dataset.
- **Precedence.** The env read set beats an explicit `dataset` / `--dataset` argument on the
  graph lane and beats UUID addressing passed per call; the code lane (`cognee_code`,
  `scope=["code"]`) is never federated.
- **UUID-only.** Entries must be UUIDs (hyphens optional, case-insensitive); they are
  canonicalized to lowercase-hyphenated form and deduped preserving first-seen order. A
  malformed value (non-JSON, non-list, empty list, non-UUID entry) disables federation and
  surfaces the exact validation error — as a load-time config warning in `/cognee` and
  `/cognee-doctor` plus a one-time session-start notice, never a crash (the reference
  raises the same strings at recall time).
- **Cross-agent caution.** The variable only *selects among* datasets your API key can
  already read — server-side RBAC is still enforced, and a UUID you have no read grant on
  simply fails recall (`DatasetNotFoundError`). Grants flow child→parent only: your user
  sees what the agent writes, but the agent sees nothing your user (or another plugin's
  agent) owns. Use dataset UUIDs for shared read targets; never as a way to widen writes.

## Shared agent memory (`COGNEE_PLUGIN_IDENTITY` × `COGNEE_SHARED_AGENT_MEMORY`)

A provisioned plugin agent is its own user — and cognee's grants flow **child→parent only**:
the parent sees what the agent creates, the agent sees nothing the parent or a sibling owns.
Left alone, per-plugin identities would silo memory (pi could not recall what Claude Code
stored). Shared agent memory (on by default) closes that loop with the server's existing
permission model, no core changes: the parent owns a tenant and a role named `cognee-agent`;
every plugin agent joins that role; the role holds read+write on the parent's datasets
(backfilled at every wiring/refresh, so datasets created later converge); and the launch
dataset is addressed by UUID — one canonical, parent-owned copy per name that every agent
writes to, plus other readable same-named copies for recall. Every control-plane call
authenticates as the **principal** (owner-only server-side — an agent key can never widen
its own access); only `tenants/select` runs as the agent, on itself.

**Capability gating (graceful degradation).** Before any provisioning POST, the client
verifies the server's advertised **create-only contract** (`create_only` query param on the
provision route in `/openapi.json` — one probe per session start, 60 s TTL): older servers
ignore unknown query params and would *rotate* the key out from under other machines, so
without the contract the verdict is `unsupported` and **zero** provisioning/tenant/role/grant
calls are issued — pi keeps the single-principal key chain of today byte-for-byte. Wiring
additionally requires the `x-cognee-session-dataset-ids` extension on `remember/entry`
(else `typed_dataset_unsupported`). **cognee 1.6.0 advertises neither** — on it, pi runs as
the principal and `/cognee-doctor` reports `Provisioning: server does not support
provisioning` / `Memory: principal (no agent identity)`; the full flow is implemented once
and lights up the moment a server catches up. Structural verdicts (`unsupported`,
`typed_dataset_unsupported`, `not_tenant_owner`, `tenantless_with_data`) are recorded in the
marker with the plugin version and suppress re-probing until the plugin updates.

**Policy matrix** (`COGNEE_PLUGIN_IDENTITY` tri-state `auto|true|false`; sharing default on,
off on `0|false/no/off`):

| `IDENTITY` \ `SHARED` | `true` (default) | `false` |
|---|---|---|
| `auto` (default) | **Shared, graceful** — provision when possible, wire the role, fall back to the principal whenever that cannot be done (older server, not tenant owner, tenant-less user with data) | **Principal unless already provisioned** — never provisions; a cached identity is kept, *leaves* the shared role, writes its own private dataset |
| `true` | **Shared, strict** — same wiring; every obstacle is an **error** (pi: one-line warning, never a silent fall back) | **Separated, strict** — per-plugin isolation mode |
| `false` | **Principal only** (sharing irrelevant) | **Principal only** (identical) |

A malformed `COGNEE_PLUGIN_IDENTITY` surfaces the exact reference error
(`COGNEE_PLUGIN_IDENTITY must be auto, true, or false`) as a load-time config warning and
behaves as `auto` — never a crash.

**State files** (under `~/.cognee-plugin/pi/`, honoring `COGNEE_PI_STATE_DIR`):

- `agent-key.json` — the provisioned identity: `{base_url, api_key, agent_id, plugin_key: "pi",
  principal_fingerprint (sha256 of the principal key), updated_at, blocked?}`; 0600, atomic
  tmp+rename. A cached key that passes its checks always wins (provisioning again would
  rotate it); a **blocked** key (server rejected it with 401/403 — stamped automatically) is
  never re-provisioned: create-only refuses an existing agent and rotating would revoke
  another machine's key.
- `shared-memory.json` — the wiring marker: `{base_url, mode: shared|separated, reason,
  tenant_id, role_id, parent_user_id, agent_id, granted: {<dataset UUID>: "ok" | {denied_at}},
  canonical: {<name>: <write UUID>}, updated_at, plugin_version}`. `base_url` mismatch →
  treated as absent (per-server marker). Grants memoized `"ok"` are never re-POSTed; denials
  (401/403 — typically a dataset someone shared to you read-only) are retried hourly.

**Behavior when wired.** Writes address the resolved canonical UUID (`remember/entry`
`dataset_id`, `improve` `dataset_id`); graph recall widens to the read set
(`dataset_ids` — precedence: env federation > shared-memory ids > explicit dataset, session
binding dropped on that lane exactly like federation). The switcher narrows its listing via
the permissions route (`GET /permissions/principals/{user}/datasets?permission_name=write` +
`via_role` from the live marker), hides read-only rows with the reference's
`(N read-only dataset(s) not shown)` note, refuses read-only/unresolvable-UUID targets when
the route answers (unverifiable targets stay permissive — pi's fail-soft divergence), and
resolves switches **as the principal** (canonical UUID + grant backfill, create-as-parent).
Opting out (`COGNEE_SHARED_AGENT_MEMORY=false`) makes the agent *leave* the shared role and
demotes the marker keeping the ids — re-enabling rejoins the same role. Under `auto`, a
wiring failure right after provisioning reverts the fresh identity (server-side revoke;
the agent user stays). The persisted dataset-switch record gains `dataset_id`/
`dataset_ids` fields and stays keyed on the **principal** fingerprint — flipping to a plugin
identity never orphans the persisted switch. `/cognee-doctor` gains the **Memory** line
(`shared (role: cognee-agent)` | `separated (opt-out)` | `principal (shared memory
unavailable: <reason>)` | `principal (no agent identity)` | `separated (<reason>)`) and the
**Provisioning** line (`supported (create_only advertised)` | `server does not support
provisioning` | `not probed (server unreachable)` | `disabled (COGNEE_PLUGIN_IDENTITY=false)`);
the API-key row labels the plugin-identity source. No surface shows raw keys.

## Parity with the Claude Code / Codex cognee plugins

| Feature | Claude Code / Codex | pi-cognee |
|---|---|---|
| HTTP contract (`/health`, `/recall`, `/remember`, `/remember/entry`, `/improve`, `/datasets`, `/forget`, `/sessions/{id}`) | ✅ | ✅ same wire format |
| Two-tier memory (session cache → graph via improve) | ✅ | ✅ |
| Auto-recall per prompt (`HYBRID_COMPLETION`, graph scope, `top_k=5`, `only_context`) | ✅ | ✅ bounded 4s |
| Prompt+answer pairing into one QA entry | ✅ | ✅ |
| Secret redaction + size limits before capture | ✅ | ✅ text-level; tool-call traces too (v0.4 — reference `_capture_policy.py` verbatim: allowlist, sensitive-path deny, recursive redaction with secret-key rule + custom patterns, 4000/8000/500B caps) |
| Tool-call trace capture (`PostToolUse` → trace entries in the session cache) | ✅ | ✅ v0.4 — `tool_result` handler → `TraceEntry` via `POST /api/v1/remember/entry`; default matcher translated (`bash\|powershell\|read\|write\|edit\|grep\|find\|ls` + documented `ls` divergence), `COGNEE_CAPTURE_TOOLS` / `COGNEE_CAPTURE_DENY_PATHS` / `COGNEE_CAPTURE_REDACT` / `COGNEE_CAPTURE_REDACT_PATTERNS`; no per-trace toast (divergence), no `Agent`-tool analog (user allowlist covers custom tools) |
| Config: `~/.cognee/.env` shared file, shell > file, `COGNEE_BACKEND` pinning | ✅ | ✅ |
| Shared default dataset `agent_sessions` (cross-agent memory) | ✅ | ✅ |
| Federated graph recall (`COGNEE_PLUGIN_READ_DATASET_IDS` — JSON UUID array; `dataset_ids`-only payload that drops the session binding; env read set beats explicit datasets; code lane and writes never federate) | ✅ | ✅ same semantics, exact reference error strings (surfaced as a load-time config warning instead of a recall-time raise) |
| Explicit remember with node_sets + background cognify wait | ✅ | ✅ |
| Forget (doc / whole dataset, irreversible, confirmed, data-item discovery) | ✅ | ✅ |
| Manual sync skill/command | ✅ | ✅ `/cognee-sync` + `cognee_sync` |
| Doctor (mode, env, reachability, latency, datasets) | ✅ | ✅ `/cognee-doctor` |
| Circuit breaker on recall | ✅ file-shared | ✅ file-shared (`~/.cognee-plugin/pi/breaker.json`, in-memory fast path, stale-read tolerant) |
| Code graph: repo indexing (`content_type="code"`, `codebase-<repo>-<digest>` datasets, `--index-vectors`, `--wait` poll) | ✅ | ✅ same wire format |
| Code graph: deterministic queries (query_facts, explore, traverse, find_path, impact_analysis, delta) | ✅ | ✅ via `cognee_code` / `/cognee-code` (POST `/api/v1/recall` scope `code` + `code_query`) |
| Code graph: session-start auto-index + 3000-file cap + freshness fingerprint/re-index | ✅ detached hooks | ✅ in-process, debounced, fail-soft |
| Code graph: identifier-shaped code recall lane (`=== Code graph facts ===`) | ✅ | ✅ reference wire shape (code_query attached, prompt as query, session id, top_k 5), empty-result envelopes filtered, 1000-char cap, same recall budget |
| Per-file code ingestion (`--file`, real filename → zero-LLM code route, no cross-file edges) | ✅ `cognee-remember --file` | ✅ `cognee_remember file=` param + `/cognee-remember --file` (verbatim, guarded: exists/size/text-only/credential-path refusal) |
| Delta re-ingestion of changed files (`PATCH /api/v1/update`, chunk-level diff under a stable `data_id`) | ➖ not used by the reference | ✅ v0.3 — same-hash no-op, changed-hash update, exact-filename discovery; failed updates never duplicate-add |
| Pre-compact memory anchor (session-scoped graph recall + recent turns preserved) | ✅ PreCompact hook | ✅ `session_before_compact` → anchor stored into the session-cache tier |
| Server bootstrap (uv venv, pinned cognee, detached uvicorn, single-flight locks, presence gating, boot deadline) | ✅ | ✅ v0.4 — same shared root (`~/.cognee-plugin`), locks, pidfile and venv, so pi single-flights with Claude Code/Codex; divergences: no `COGNEE_AGENT_MODE` teardown, in-process task (no detached worker), no `python3 -m venv` fallback, `COGNEE_LOCAL_BOOTSTRAP=off` opt-out |
| Status text (`●/✕ cognee: mode · dataset` in pi's footer, health glyph + backend + dataset in every state) | ✅ | ✅ mode-guarded `ui.setStatus` at the health-probe points |
| Rich statusline renderer (hit counts, credits, update glyph) | ✅ | ✅ v0.4 — glyph precedence + recall/awaiting-replay/credits segments over shared markers; divergences: plain text (no ANSI), 120-char soft cap, no update marker (no marketplace), render-only credits (no billing refresh — gap 8) |
| cognee-recall subagent | ✅ | ❌ deferred |
| Dataset switcher | ✅ | ✅ `/cognee-datasets` — persisted record at `~/.cognee-plugin/pi/active-dataset.json` wins over the `COGNEE_PLUGIN_DATASET` seed across restarts; v0.4 adds the permissions-route writability narrowing (read-only rows hidden + noted, unverifiable targets permissive), shared-memory switch resolution as the principal (canonical UUID + grant backfill, create-as-parent), and the `dataset_id`/`dataset_ids` record fields |
| Shared-agent-memory provisioning (`/provision`, tenants, roles, grants) | ✅ | ✅ v0.4 — full client-side parity gated by an openapi capability probe; on servers without the `create_only` contract (incl. cognee 1.6.0) it degrades to today's single-principal behavior with zero provisioning/wiring calls; see [Shared agent memory](#shared-agent-memory-cognee_plugin-identity--cognee_shared_agent_memory) |
| Idle watcher / exit watcher / detached final-sync worker | ✅ | ➖ in-process equivalents with persisted semantics: `agent_settled` + one bounded timer (one improve per arm, cooldown re-arm at expiry, `COGNEE_IDLE_IMPROVE`), persisted improve-cooldown (`improve-state/` + `improve-counter.json` — replaces the in-memory timestamp across restarts), and crash-tolerant final sync via the disk bridge |
| Idle-watcher 60 s shared-memory refresh (`COGNEE_SHARED_MEMORY_REFRESH`) | ✅ | ➖ re-resolution at session start and on `/cognee-datasets` switch (deliberate skip — pi has no watcher) |
| Disk-backed write bridge (`bridge/` spill + verify-before-replay + drain backoff) | ✅ | ✅ v0.4 — per-session flat file under `~/.cognee-plugin/pi/bridge/`, ambiguity classification, fingerprint dedupe, doubling backoff, drop-oldest `COGNEE_BUFFER_LIMIT`, 7 d sweep; buffered turns survive a pi exit while the server is down |

**Consciously deferred** (v0.2.0) — see
[Differences from the Claude Code/Codex plugins](#differences-from-the-claude-codecodex-plugins)
below for the full list of accepted gaps and deliberate behavioral divergences.

## Differences from the Claude Code / Codex plugins

pi-cognee speaks the same wire protocol and shares `~/.cognee/.env` (and the local owner-key
cache) with the official plugins, so all three agents can share one memory. The gaps below are
**accepted** — not implemented by design:

1. **Local server bootstrap — implemented in v0.4** (uv venv, pinned cognee 1.6.0, detached
   uvicorn, single-flight locks, boot deadline; see
   [Local server bootstrap](#local-server-bootstrap)) with four documented divergences:
   **no agent-mode server lifetime** (`COGNEE_AGENT_MODE` is deliberately not set — pi has no
   agent registration until shared-agent-memory lands, and an agent-mode server's
   zero-connections teardown would kill the shared server under pi when the last Claude Code
   session unregisters; a pi-booted server persists until the user/machine stops it — revisit
   with gap 4), **no detached bootstrap worker surviving pi exit** (the package ships TS loaded
   by pi's runtime; a pi-kill mid-install self-heals via stale-lock reap + version probe on the
   next launch, which also makes `COGNEE_LAZY_BOOTSTRAP` meaningless — not read), **no
   `python3 -m venv` fallback** when uv is unavailable (a clear "install uv" error instead),
   and **no Windows support** (posix first). A pi-specific master switch `COGNEE_LOCAL_BOOTSTRAP=off`
   restores the pre-v0.4 "run the server yourself" contract.
2. **Tool-call trace capture — implemented in v0.4** (README gap 2; research/v04-traces-spec.md):
   the `PostToolUse` → trace-entry pipeline as a `tool_result` handler — every ALLOWED tool call
   lands in the session cache as an OpenAPI `TraceEntry` (`origin_function`, `status`, redacted
   `method_params`/`method_return_value`, 4000/8000/500-byte caps), with the reference capture
   policy verbatim: `COGNEE_CAPTURE_TOOLS` allowlist (default = the reference matcher translated
   to pi tool names: `bash|powershell|read|write|edit|grep|find|ls` — `ls` is a documented
   divergence, the same navigation family the reference's Glob covers; a user value REPLACES the
   default and can widen to custom/MCP tools), the compiled-in sensitive-path deny list plus
   `COGNEE_CAPTURE_DENY_PATHS` extras (entry-level refusal, never partial redaction), redaction
   before truncation (recursive `redactForCapture`: secret-ish dict keys wholesale, PEM/connection/
   bearer/credential/vendor/bcrypt string rules, `COGNEE_CAPTURE_REDACT_PATTERNS` custom regexes →
   `[redacted:custom]`, `COGNEE_CAPTURE_REDACT=false` opt-out), and the hard self-reference skip
   (`cognee_*` tools; shell lines mentioning `cognee`). Divergences: no per-trace toast (per-tool-
   call volume would be noise — silent success + buffered-failure counts), no Claude `Agent`-tool
   analog (no pi builtin; the user allowlist covers custom tool names), and the shared
   `redactSecrets` rule set was aligned to the reference superset (`sk-ant-`, `github_pat_`, bcrypt;
   tags renamed to the reference's `[redacted:private-key]` style).
3. **Dataset switcher — implemented in v0.2.0** with two documented divergences: single
   principal (every readable dataset is owned, hence writable — no permissions route until
   shared-agent-memory lands, gap 4), and no conn-handle register-then-unregister dance (that
   exists only for the reference's agent-mode server-count problem). Per-call `dataset`
   overrides still cover one-off reads without switching.
4. **Shared-agent-memory provisioning — implemented in v0.4** (README gap 4;
   research/v04-provisioning-spec.md): the write/grant side that decides *which
   identity writes* and *which UUID it writes to* — plugin identity
   `/provision` (create-only contract, capability-gated), tenant/role grants
   (`cognee-agent` role, read+write backfill, canonical parent-owned datasets),
   `COGNEE_PLUGIN_IDENTITY` × `COGNEE_SHARED_AGENT_MEMORY` policy,
   `agent-key.json`/`shared-memory.json` state, doctor Memory/Provisioning rows,
   and switcher writability narrowing. On servers without the `create_only`
   contract (cognee 1.6.0 today) everything degrades to the single-principal
   behavior with **zero** provisioning/tenant/role/grant calls — the client side
   is at parity so it lights up the moment a server catches up. Divergences:
   pi never hard-fails on strict-mode obstacles (one-line warning, principal
   fallback — fail-soft posture), no idle-watcher 60 s refresh (re-resolution at
   session start and on switch), no interactive identity reconnect (blocked
   identities surface a doctor warning; automatic re-provision stays disabled),
   and no cross-process file lock on the identity cache (benign race —
   create-only refuses rotation). See
   [Shared agent memory](#shared-agent-memory-cognee_plugin-identity--cognee_shared_agent_memory).
5. **Rich statusline renderer — implemented in v0.4** (README gap 5; research/v04-resilience-spec.md
   §2.1): `renderStatusline()` composes one plain-text line for pi's footer —
   `<glyph>cognee: <backend> · <dataset>[ · N awaiting replay][ · N memory hits[ · X/Y
   turns had hits this session]][ · credits: …]` — from in-memory state plus the one shared
   credits marker, refreshed at the spec's points (health completion, each recall, each drain
   tick, improve settle, dataset switch; no timers). Glyph slot keeps the reference precedence
   (connection failure > llm-key verdict > ready signal): `●` / `✕ offline` / `✕ auth failed` /
   `✕ server error` / `✕ llm key not set` (static local-mode verdict — the reference's real
   litellm ping is skipped, §5). Recall segment counts every scope that returned something and
   was injected (graph items + code facts — the reference's `turns_with_hits` rule), with the
   `memory warming up (N turns)` zero-hit form, the `COGNEE_STATUSLINE_COUNTS=full` diagnostic
   strip (`recall <graph>g/<code>c`), and `false|0|off` hiding. `· N awaiting replay` surfaces
   the durable bridge count. The credits segment is render-only over the shared
   `~/.cognee-plugin/claude-code/credits.json` (pi never writes it): cloud mode, matching
   `base_url`, numeric balance, ≤ 7 d freshness (epoch-seconds markers tolerated),
   `COGNEE_STATUSLINE_CREDITS` opt-out, `≤ $1 → top up: <COGNEE_BILLING_URL|default>`,
   `> 15 m → (Nm/Nh/Nd ago)`, `· last <label> ~$<cost>`. Divergences: no ANSI colors (pi's
   footer is plain text — glyphs carry the semantics), a 120-visible-char soft cap that sheds
   pieces in the reference's reverse priority order (age hint → last-op → credits → cumulative
   turns → per-turn hits) where the reference never truncates, and no update segment /
   self-eviction (no plugin marketplace to check). Per-session marker files
   (`conn-state/`, `llm-state/`, `recall/<sid>.json`) are skipped — one process per terminal
   holds the state in memory (recall totals reset on restart; accepted).
6. **Idle watcher / exit watcher / detached final-sync worker — replaced in v0.4** (README gap 6)
   by in-process equivalents with the reference's exact semantics where they matter: the idle
   watcher maps to `agent_settled` + one bounded timer (`COGNEE_IDLE_THRESHOLD_MS`, default
   60 s; every user message re-arms = the activity touch) — one improve attempt per arm,
   `COGNEE_IDLE_IMPROVE=false` disarms it, a throttled fire re-arms exactly once at the
   persisted cooldown's expiry (a quiet stretch that outlasts the cooldown still gets exactly
   one bridge), and `session_shutdown` clears the timers without improving on the way out (the
   final sync owns promotion). The exit watcher's detached worker maps to crash tolerance via
   the disk bridge (gap 7): anything the bounded 4 s final sync cannot flush stays spilled and
   replays at the next launch. The persisted improve-cooldown
   (`~/.cognee-plugin/pi/improve-state/<sha1(sid)>.json` + the `improve-counter.json` map —
   field-for-field with the reference: `last_improved_at`, `turn_count_at_improve`, `trigger`,
   failure merge fields) **replaces** the in-memory timestamp: both automatic paths (idle and
   every-N `COGNEE_AUTO_IMPROVE_EVERY`) consult `improveThrottleReason()` — `cooldown`
   (success younger than `COGNEE_IMPROVE_COOLDOWN_MS`), `backoff` (one auto attempt per window
   after a failure), `no_new_entries` (persisted counter did not advance) — while the
   final/manual/switch syncs stay ungated (parity). Only confirmed outcomes of the
   `submitImprove` wrapper stamp the state; the counter bumps once per successfully sent
   entry, which is what makes `no_new_entries` meaningful across restarts.
7. **Disk-backed write bridge — implemented in v0.4** (README gap 7; spec §2.5):
   `~/.cognee-plugin/pi/bridge/<sha1(sid)>.json` — one flat file per cognee session id
   (`{entries, fail_count, fail_at}`; documented divergence from the reference's per-host-scope
   `(dataset, session_id)` map — pi's switch mints a new session id, so a session never spans
   datasets and per-session files kill the cross-terminal write race). Spill policy: a capture
   while the server is unusable spills immediately (never sent → never ambiguous); the first
   failed retryable drain attempt spills the entry plus whatever is queued behind it
   (order preserved), stamped `_replay_ambiguous` per the §1.5 classification (503 and
   positively-refused are unambiguous; timeouts/aborts/500/502/504 may have committed —
   `/remember/entry` has no idempotency, so a blind replay would duplicate); permanent 4xx
   stays drop-loudly for memory entries and enters the file's doubling 60 s → 3600 s drain
   backoff (any progress resets; the forced final-sync pass never stamps backoff, so a
   relaunch always replays). Replay is strictly head-first from the merged view (file first,
   then the memory tail, then other sessions' oldest spill), verify-before-replay for
   ambiguous QA and trace heads (one `GET /api/v1/sessions/{id}` fingerprint read — a match
   consumes the entry without re-sending; a detail failure replays, fail-open), time-boxed by
   `COGNEE_DRAIN_BUDGET_MS` (default 20 s), and `COGNEE_BUFFER_LIMIT` now bounds the file with
   drop-oldest. Entries replay at the next launch before any new capture lands (the
   session-start health drain is head-first); files older than 7 d are swept; buffered turns
   now SURVIVE a pi exit while the server is down — the crash-window divergence that remains
   (an entry whose HTTP write is in flight at the moment the host dies) exists in the reference
   too.
8. **Misc**: credits/billing refresh, `cognee-cli` offline fallback, cognee-recall subagent,
    session-companion datasets / `COGNEE_PROJECT_NODE_SET`, `~/.cognee/.env` template creation,
    usage metrics rollup (`cognee-plugin metrics`), other-readable-datasets hint on empty recall
    (`COGNEE_RECALL_DATASET_HINT`), `/clear` transcript handling, update check, log rotation.

Deliberate behavioral differences (implemented differently on purpose):

- **Forced-local keeps `COGNEE_API_KEY`** — the official plugins scrub it (they auto-mint a
  local key); pi-cognee's bootstrap only installs/spawns when the server is positively absent,
  so an explicit key never conflicts with it and is honored.
- **Explicit remember is redacted** like auto-capture — the official plugins leave explicit
  remember unfiltered (prevention beats cleanup via forget).
- **Owner-key mint is lazy** (first authenticated call / first successful health probe, at most
  once per process) rather than a synchronous session-start bootstrap.
- **Buffering is disk-backed and draining is bounded in-process** — the write bridge
  (`~/.cognee-plugin/pi/bridge/`, one flat file per session) makes buffered turns survive a pi
  exit while the server is down; the official plugins use detached workers and cross-process
  lock files (pi's per-session files + atomic rename make `buffer.lock`/`drain.lock`
  unnecessary — the residual same-session two-terminal race is accepted, bounded); the recall
  breaker, by contrast, **is** file-shared
  (`~/.cognee-plugin/pi/breaker.json`) with an in-memory fast path, so concurrent pi
  processes share outage state.
- **Code-graph state is pi-scoped** (`~/.cognee-plugin/pi/code-graph/`, mirroring the official
  plugins' per-integration dirs) while dataset names are the same pure function of the repo
  path — so a repo indexed from pi, Claude Code, or Codex resolves to the same graph, and each
  integration refreshes it independently.
- **Explicit code queries resolve the dataset deterministically** from the git root when no
  index state exists (the official tools require their own state file), so `cognee_code` / `/cognee-code`
  also work on repos indexed by the other plugins.

Ask in a GitHub issue if you need one of the gaps.

## Troubleshooting

Run `/cognee-doctor`. It prints the resolved mode and why, the env file state, shell overrides,
API key source, server reachability + latency + version, readable datasets, session id, breaker
state, and all timeouts. Common cases:

- **"offline (cannot reach cognee server …)"** — the server is not running at the expected URL.
  In local mode the [bootstrap](#local-server-bootstrap) starts one automatically within the
  session (first run takes a few minutes: uv venv + install — the status shows
  `◐ cognee: starting`); with `COGNEE_LOCAL_BOOTSTRAP=off`, start it yourself
  (`uvicorn cognee.api.client:app --port 8011`). Either way the extension reconnects on its own
  within ~60s.
- **"uv not found and automatic install failed"** (bootstrap) — install uv
  ([docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/)) and restart pi;
  `/cognee-doctor`'s *Local runtime* row shows what was found. The bootstrap never touches a
  server that is present (`ready`/`busy`/`unknown` → adopt or refuse with a log line in
  `~/.cognee-plugin/pi/bootstrap.log`).
- **"server present but not serving (verdict=busy…)"** — something holds the port without
  answering `/health` (a busy server still holds the graph store's file lock); pi refuses to
  install or boot over it. Free the port or point `COGNEE_LOCAL_API_URL` elsewhere.
- **auth failed (401/403)** — `COGNEE_API_KEY` missing or wrong for cloud mode. In local mode it
  means the owner-key auto-mint failed or was never attempted: start the server with
  `DEFAULT_USER_PASSWORD` matching `COGNEE_USER_PASSWORD` (defaults:
  `default_user@example.com` / `default_password`) and restart pi, or set `COGNEE_API_KEY`.
- **"COGNEE_BASE_URL missing"** — `COGNEE_BACKEND=cloud` is pinned but no URL is configured.
- **`LLM_API_KEY` missing** — only matters for a *local* server (it needs an LLM); the extension
  itself never calls an LLM.
- **"server rejected content_type='code'"** (indexing) — the server predates cognee 1.5.4;
  upgrade it and re-run `/cognee-index`.
- **Code queries return empty on a cloud server** — the graph reflects the last *pushed* commit;
  push, then re-run `/cognee-index <git-url>` (see [Code graph](#code-graph)).

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

## Development

```bash
node test/smoke.mjs    # registration + pure-helper checks; no network, no server

# Live checks (disposable selftest datasets, deleted on exit; secrets never printed):
COGNEE_LIVE_BASE_URL=https://cognee.example node test/live.mjs
COGNEE_LIVE_BASE_URL=https://cognee.example node test/probe-switcher.mjs   # switcher end-to-end

# Read-only capability discovery against a real server (GETs only — asserts the
# provisioning verdicts and that no write ever leaves the process):
COGNEE_LIVE_BASE_URL=https://cognee.apps.jazm.dev node test/probe-provisioning.mjs

# ONE bounded real bootstrap (uv venv + cognee==1.6.0 + uvicorn on an ephemeral
# port, inside a throwaway state root; kills exactly what it spawned; ~10 min cap):
PI_COGNEE_BOOTSTRAP_LIVE=1 node test/bootstrap-live.mjs
```

`tsconfig.json` is strict, `noEmit`, types-only — editors check `src/` against the real pi
extension types.

## License

MIT — same as [cognee](https://github.com/topoteretes/cognee).
