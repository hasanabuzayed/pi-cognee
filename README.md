<div align="center">
  <a href="https://www.cognee.ai">
    <img src="https://raw.githubusercontent.com/topoteretes/cognee-integrations/main/assets/cognee-logo.svg" alt="Cognee" width="260">
  </a>
  <p><strong>Cognee memory for the pi coding agent</strong> — persistent knowledge-graph memory with automatic capture of prompts and answers, and relevant recall on every turn.</p>
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
- auto-captured turns are buffered in memory while the server is down and replayed on
  reconnect (buffered turns are lost if pi exits before the server returns — there is
  no disk bridge yet; shutdown makes one last bounded flush attempt first).

## How it works — two memory tiers

1. **Session cache (server-side).** Each finalized user prompt is paired with the assistant's
   final answer into one `qa` entry and written to `POST /api/v1/remember/entry` under a
   per-session cognee session id (`pi_<pi-session-id>`). Secrets are redacted and huge payloads
   skipped before anything leaves the process (see [Capture policy](#capture-policy)).
2. **Permanent knowledge graph (per dataset).** The session cache is promoted into the graph via
   `POST /api/v1/improve` — automatically every `COGNEE_AUTO_IMPROVE_EVERY` captured turns, on
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

**Requirements.** A cognee API server the extension can reach (see below — pi-cognee is a pure
HTTP client and never installs or starts a server itself), and Node 18+.

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

Start the server yourself (pi-cognee never does):

```bash
pip install cognee
DEFAULT_USER_PASSWORD=default_password uvicorn cognee.api.client:app --port 8011
```

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

Unlike the official plugins, forced-local does **not** scrub `COGNEE_API_KEY` (pi-cognee never
boots a server, so an explicit key for your local server is honored); `COGNEE_BASE_URL` is
effectively ignored on the forced-local path — only `COGNEE_LOCAL_API_URL` is read.

### Local vs cloud

| | Local | Cloud / remote |
|---|---|---|
| Configure | `LLM_API_KEY` in `~/.cognee/.env` (server-side) | `COGNEE_BASE_URL` + `COGNEE_API_KEY` |
| Server URL | `http://localhost:8011` (`COGNEE_LOCAL_API_URL`) | your instance URL |
| Who runs the server | you (`uvicorn cognee.api.client:app`) | Cognee |
| `COGNEE_API_KEY` | optional — auto-minted on loopback servers when unset | required |
| Data location | your machine | Cognee Cloud |

## Commands

| Command | What it does |
|---|---|
| `/cognee` | Status: health + latency, mode, dataset, session, API key source, capture/auto settings, recall hits, queue, breaker, code-graph state |
| `/cognee-doctor` | Diagnose: mode + why, env file and shell overrides, API key source, reachability + latency + version, dataset list, breaker, timeouts, code graph |
| `/cognee-remember <text>` | Store text in the graph. `--file <path>` ingests one file (≤200 KB, text-only) **verbatim under its real filename** — code extensions route down the zero-LLM code-graph path (single file, no cross-file edges; use `/cognee-index` for those). `--node-set user_context\|project_docs\|agent_actions` picks the memory category. Waits briefly for cognify |
| `/cognee-search <query>` | Explicit graph search. `--top-k N`, `--dataset <name>` |
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
`=== Code graph facts ===` section (1000-char hard cap). The lane runs concurrently with the
graph recall inside the same recall budget, so it can never add latency beyond it.

## Tools (model-facing)

| Tool | Use when… |
|---|---|
| `cognee_remember(content \| file, node_set?, dataset?)` | The user states a lasting preference, decision, convention, or fact — or asks you to remember something. `file` uploads one file from disk under its real filename (code extensions → zero-LLM code-graph route) |
| `cognee_recall(query, search_type?, session_only?, top_k?)` | Targeted memory lookup mid-task; `session_only=true` reads this session's raw Q&A cache |
| `cognee_search(query, top_k?, dataset?, search_type?)` | Broad/exploratory graph search, cross-dataset (incl. memories written by the Claude Code / Codex plugins) |
| `cognee_code(seed?, operation?, name?/start?/source?+target?/targets?/kind?/limit?/max_depth?/direction?, repo?, dataset?, top_k?)` | Structural code questions naming a symbol/file: callers of a seed, `impact_analysis` (what breaks if X changes), `find_path` (how A reaches B), `query_facts kind:"route"` (all endpoints), `explore`/`traverse`, `delta` (what the last index changed) — exact, instant, no tokens. Conceptual questions → `cognee_search` |
| `cognee_forget(dataset, data_id?, entire_dataset?)` | The user explicitly asks to remove wrong/outdated/sensitive memories (irreversible) |
| `cognee_sync(dataset?)` | The user asks to save this session's memory to the graph |

All tool output is truncated at 4000 chars. Tool descriptions teach the model *when* to reach
for memory, so you should not need to prompt for it.

## Capture policy

Auto-capture (prompts + answers into the session cache) follows the official plugins' rules:

- `COGNEE_CAPTURE=false` disables all automation (auto-capture **and** auto-recall); explicit
  tools and commands keep working,
- secrets are **redacted before truncation** (so a clipped key cannot escape): private-key
  blocks, database URIs, bearer/basic tokens, `sk-…` / `gh[pousr]_` / `xox…` / `whsec_…` vendor
  keys, and `key: value` credential pairs → `[redacted:<kind>]`,
- huge payloads are skipped (prompts capped at 4000 bytes, answers at 8000; oversized prompts
  dropped rather than clipped), prompts under 5 chars and slash commands are ignored.

Explicit remember of **inline text** (`cognee_remember`, `/cognee-remember`) goes through the
same redaction — a deliberate hardening beyond the official plugins, which leave explicit
remember unfiltered: once stored, a secret is durable, cross-session, and shared with
other agents. `--file` / `file=` uploads are stored **verbatim under the real filename**
(like the official plugins' `--file` path): the filename extension is the server's
loader-routing signal, and redacting code would corrupt what the zero-LLM code path
ingests — point the tool at code, not at secrets.

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
| `COGNEE_PLUGIN_DATASET` | `agent_sessions` | Graph dataset — set per project for scoped memory; the default is shared with the Claude Code/Codex plugins |
| `COGNEE_SESSION_PREFIX` / `COGNEE_SESSION_ID` | `pi` / auto | Cognee session id (`pi_<pi session id>`) |
| `COGNEE_CAPTURE` | `true` | Master switch for auto-capture + auto-recall |
| `COGNEE_CONTEXT_MAX_CHARS` | `2000` | Cap for the injected recall block |
| `COGNEE_AUTO_IMPROVE_EVERY` | `150` | Auto-sync session→graph every N writes (0 = off) |
| `COGNEE_IMPROVE_COOLDOWN_MS` | `1800000` | Minimum spacing between auto-syncs |
| `COGNEE_FINAL_SYNC` | `true` | Bounded shutdown flush (1s probe + ≤4s write drain + ≤4s improve) |
| `COGNEE_RECALL_TIMEOUT_MS` | `4000` | Per-prompt recall budget |
| `COGNEE_REQUEST_TIMEOUT_MS` | `10000` | General request timeout |
| `COGNEE_HEALTH_TIMEOUT_MS` | `2500` | Health probe timeout |
| `COGNEE_IMPROVE_SUBMIT_TIMEOUT_MS` | `60000` | Improve submit timeout |
| `COGNEE_REMEMBER_WAIT_SECONDS` | `8` | Bounded wait for graph queryability after `/cognee-remember` |
| `COGNEE_REMEMBER_BACKGROUND` | `true` | `run_in_background` default for explicit remember writes — set `false` for a synchronous, immediately-queryable write |
| `COGNEE_BUFFER_LIMIT` | `100` | In-memory write buffer size while server is down |
| `COGNEE_BREAKER_THRESHOLD/WINDOW_MS/COOLDOWN_MS` | `5` / `300000` / `120000` | Circuit breaker (only unreachable/5xx count) |
| `COGNEE_BREAKER_FILE` | `~/.cognee-plugin/pi/breaker.json` | Cross-process breaker state file (open-until + consecutive-failure count, keyed by server URL) |
| `COGNEE_CODE_STATE_DIR` | `~/.cognee-plugin/pi/code-graph/` | Per-repo index-state directory (dataset + fingerprint + last status; override for tests) |
| `COGNEE_CODE_AUTOINDEX` | `auto` | Code-graph auto-indexing of new repos: `auto` (loopback server only), `always` (any server), `off`. `COGNEE_CAPTURE=false` disables it as part of all automation |
| `COGNEE_CODE_INDEX_TIMEOUT_MS` | `120000` | Repo-index submit timeout (background pipelines confirm slowly; a timeout is not retried blindly — the submission may have landed) |

## Parity with the Claude Code / Codex cognee plugins

| Feature | Claude Code / Codex | pi-cognee |
|---|---|---|
| HTTP contract (`/health`, `/recall`, `/remember`, `/remember/entry`, `/improve`, `/datasets`, `/forget`, `/sessions/{id}`) | ✅ | ✅ same wire format |
| Two-tier memory (session cache → graph via improve) | ✅ | ✅ |
| Auto-recall per prompt (`HYBRID_COMPLETION`, graph scope, `top_k=5`, `only_context`) | ✅ | ✅ bounded 4s |
| Prompt+answer pairing into one QA entry | ✅ | ✅ |
| Secret redaction + size limits before capture | ✅ | ✅ text-level |
| Config: `~/.cognee/.env` shared file, shell > file, `COGNEE_BACKEND` pinning | ✅ | ✅ |
| Shared default dataset `agent_sessions` (cross-agent memory) | ✅ | ✅ |
| Explicit remember with node_sets + background cognify wait | ✅ | ✅ |
| Forget (doc / whole dataset, irreversible, confirmed, data-item discovery) | ✅ | ✅ |
| Manual sync skill/command | ✅ | ✅ `/cognee-sync` + `cognee_sync` |
| Doctor (mode, env, reachability, latency, datasets) | ✅ | ✅ `/cognee-doctor` |
| Circuit breaker on recall | ✅ file-shared | ✅ file-shared (`~/.cognee-plugin/pi/breaker.json`, in-memory fast path, stale-read tolerant) |
| Code graph: repo indexing (`content_type="code"`, `codebase-<repo>-<digest>` datasets, `--index-vectors`, `--wait` poll) | ✅ | ✅ same wire format |
| Code graph: deterministic queries (query_facts, explore, traverse, find_path, impact_analysis, delta) | ✅ | ✅ via `cognee_code` / `/cognee-code` (POST `/api/v1/recall` scope `code` + `code_query`) |
| Code graph: session-start auto-index + 3000-file cap + freshness fingerprint/re-index | ✅ detached hooks | ✅ in-process, debounced, fail-soft |
| Code graph: identifier-shaped code recall lane (`=== Code graph facts ===`) | ✅ | ✅ concurrent lane, 1000-char cap, same recall budget |
| Per-file code ingestion (`--file`, real filename → zero-LLM code route, no cross-file edges) | ✅ `cognee-remember --file` | ✅ `cognee_remember file=` param + `/cognee-remember --file` (verbatim, guarded: exists/size/text-only/credential-path refusal) |
| Pre-compact memory anchor (session-scoped graph recall + recent turns preserved) | ✅ PreCompact hook | ✅ `session_before_compact` → anchor stored into the session-cache tier |
| Server bootstrap (uv venv, uvicorn, pinned version) | ✅ | ❌ deferred — run the server yourself |
| Status text (`●/✕ cognee: mode · dataset` in pi's footer, health glyph + backend + dataset in every state) | ✅ | ✅ mode-guarded `ui.setStatus` at the health-probe points |
| Rich statusline renderer (hit counts, credits, update glyph) | ✅ | ❌ deferred |
| cognee-recall subagent | ✅ | ❌ deferred |
| Dataset switcher | ✅ | ❌ deferred (per-call `dataset` overrides cover the basics) |
| Idle watcher / exit watcher / detached final-sync worker | ✅ | ➖ bounded in-process equivalents |
| Shared-agent-memory provisioning (`/provision`, tenants, roles) | ✅ | ❌ deferred — single principal key |

**Consciously deferred** (v0.1.0) — see
[Differences from the Claude Code/Codex plugins](#differences-from-the-claude-codecodex-plugins)
below for the full list of accepted gaps and deliberate behavioral divergences.

## Differences from the Claude Code / Codex plugins

pi-cognee speaks the same wire protocol and shares `~/.cognee/.env` (and the local owner-key
cache) with the official plugins, so all three agents can share one memory. The gaps below are
**accepted** for v0.1.0 — not implemented by design:

1. **Local server bootstrap** (uv venv, pinned cognee, detached uvicorn, single-flight locks,
   boot deadline) — run the server yourself; pi-cognee never starts or installs one.
2. **Tool-call trace capture** (`PostToolUse` → trace entries, `COGNEE_CAPTURE_TOOLS` allowlist,
   sensitive-path deny list, `COGNEE_CAPTURE_REDACT_PATTERNS` extension) — capture is QA-pairs
   only; text-level redaction of prompts/answers **is** implemented.
3. **Dataset switcher** (register-then-unregister session re-pointing); per-call `dataset`
   overrides on remember/search/forget partially cover it.
4. **Shared-agent-memory provisioning** (plugin identity `/provision`, tenant/role grants,
   `COGNEE_PLUGIN_IDENTITY` × `COGNEE_SHARED_AGENT_MEMORY`) — single principal key only.
5. **Rich statusline renderer** (glyph states beyond the implemented ones, hit counts, credits
   segment, update marker, per-terminal propagation).
6. **Idle watcher / exit watcher / detached retrying final-sync worker** — replaced by bounded
   in-process equivalents (auto-every-N improve, ≤9s final sync, 60s re-probe); the persisted
   improve-cooldown (`improve-state/`) is also deferred (cooldown is in-memory).
7. **Disk-backed write bridge** (`bridge/` spill + verify-before-replay) — in-memory buffer of
   `COGNEE_BUFFER_LIMIT` (100) entries with drop-oldest; buffered turns are lost if pi exits
   before the server returns.
8. **Misc**: credits/billing refresh, `cognee-cli` offline fallback, cognee-recall subagent,
    session-companion datasets / `COGNEE_PROJECT_NODE_SET`, `~/.cognee/.env` template creation,
    usage metrics rollup (`cognee-plugin metrics`), other-readable-datasets hint on empty recall
    (`COGNEE_RECALL_DATASET_HINT`), `/clear` transcript handling, update check, log rotation.

Deliberate behavioral differences (implemented differently on purpose):

- **Forced-local keeps `COGNEE_API_KEY`** — the official plugins scrub it (they auto-mint a
  local key); pi-cognee never boots a server, so an explicit key is honored.
- **Explicit remember is redacted** like auto-capture — the official plugins leave explicit
  remember unfiltered (prevention beats cleanup via forget).
- **Owner-key mint is lazy** (first authenticated call / first successful health probe, at most
  once per process) rather than a synchronous session-start bootstrap.
- **Buffering and final sync are in-process and bounded** — the official plugins use detached
  workers and cross-process files; the recall breaker, by contrast, **is** file-shared
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
  In local mode, start it (`uvicorn cognee.api.client:app --port 8011`); the extension
  reconnects on its own within ~60s.
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

## Development

```bash
node test/smoke.mjs    # registration + pure-helper checks; no network, no server
```

`tsconfig.json` is strict, `noEmit`, types-only — editors check `src/` against the real pi
extension types.

## License

MIT — same as [cognee](https://github.com/topoteretes/cognee).
