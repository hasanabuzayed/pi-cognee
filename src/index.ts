/**
 * pi-cognee — Cognee persistent memory for the pi coding agent.
 *
 * Native TypeScript extension (no MCP, no extra npm deps, Node 18+ global fetch).
 * Resilience contract: the extension must never break or slow down pi when the
 * cognee server is missing, slow, or erroring — every network path is bounded by
 * a short timeout, wrapped in fail-soft try/catch, and gated by a circuit breaker.
 */
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { resolve as pathResolve } from "node:path";
import {
  CogneeClient,
  CogneeError,
  DEFAULT_BREAKER_FILE,
  REMEMBER_FILE_MAX_BYTES,
  buildCodeQuery,
  canonicalRepoSpec,
  codeDatasetName,
  countSourceFiles,
  describeError,
  extractIdentifiers,
  findIndexedRepo,
  gitFingerprint,
  gitRepoRoot,
  isLoopbackUrl,
  isRemoteRepoSpec,
  isUuid,
  loadCogneeConfig,
  loadSharedBreaker,
  readRememberFile,
  redactSecrets,
  sanitizeDatasetName,
  sanitizeSessionId,
  saveRepoState,
  saveSharedBreaker,
  truncateText,
  wrapAsCogneeError,
  type CogneeConfig,
  type CodeRepoState,
  type HealthResult,
  type QaEntry,
  type RecallItem,
} from "./client";

/* ------------------------------------------------------------------ */
/* Limits (aligned with the official plugins' capture policy)          */
/* ------------------------------------------------------------------ */

const LIMITS = {
  promptBytes: 4000,
  assistantBytes: 8000,
  toolOutputChars: 4000,
  recallItemChars: 600,
} as const;

/* Code-graph (enola) freshness + auto-index constants — same policy as the official plugins. */
const AUTOINDEX_MAX_FILES = 3000;
/** Hard char cap for the auto-injected code-facts block (like the memory block's contextMaxChars). */
const CODE_LANE_MAX_CHARS = 1000;
/** Debounce between an agent turn settling and the fingerprint check. */
const REINDEX_DEBOUNCE_MS = 5000;
/** Minimum spacing between two background re-index submissions. */
const REINDEX_MIN_INTERVAL_MS = 20000;
const RETRY_BACKOFF_BASE_S = 30;
const RETRY_BACKOFF_MAX_S = 900;
const CODE_OPS = [
  "query_facts",
  "explore",
  "traverse",
  "find_path",
  "impact_analysis",
  "delta",
] as const;
type CodeOp = (typeof CODE_OPS)[number];

const REPROBE_INTERVAL_MS = 60_000;
const FINAL_SYNC_TIMEOUT_MS = 4000;
/** Min spacing between cross-process breaker-file reads on the hot path. */
const BREAKER_FILE_SYNC_MS = 5000;
/** Per-item cap for the pre-compact anchor's fallback section (same as pre-compact.py). */
const ANCHOR_TURN_CHARS = 300;
/** Whole-anchor cap — the anchor is a session-cache QA answer, keep it bounded. */
const ANCHOR_MAX_CHARS = 8000;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text?: string } =>
        Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text",
      )
      .map((block) => block.text ?? "")
      .join("\n");
  }
  return "";
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: truncateText(text, LIMITS.toolOutputChars) }],
    details: details ?? undefined,
  };
}

function errResult(prefix: string, err?: CogneeError): AgentToolResult<unknown> {
  let help: string | undefined;
  if (err?.unreachable) {
    help = "start the cognee server or check COGNEE_BASE_URL, then retry. pi itself is unaffected.";
  } else if (err?.status === 401 || err?.status === 403) {
    help = "authentication failed — check COGNEE_API_KEY (run /cognee-doctor).";
  } else if (err?.transient) {
    help = "the server was too slow to answer — try again in a moment.";
  }
  return {
    content: [
      {
        type: "text",
        text: `⚠ ${prefix}: ${err?.message ?? describeError(err)}${help ? ` — ${help}` : ""}`,
      },
    ],
    details: { error: err?.message, status: err?.status },
  };
}

function renderRecallItems(items: RecallItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const text = String(item.text ?? item.content ?? "").trim();
    const q = typeof item.question === "string" ? item.question.trim() : "";
    const a = typeof item.answer === "string" ? item.answer.trim() : "";
    if (text) {
      lines.push(`[${item.source ?? "memory"}] ${truncateText(text, LIMITS.recallItemChars)}`);
    } else if (q || a) {
      lines.push(`[${item.source ?? "memory"}] Q: ${q}\nA: ${truncateText(a, LIMITS.recallItemChars)}`);
    }
  }
  return lines.join("\n");
}

/** Render code-graph query results: fact text when present, compact JSON otherwise. */
function renderCodeItems(items: RecallItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const text = String(item.text ?? item.content ?? "").trim();
    if (text) {
      lines.push(truncateText(text, LIMITS.recallItemChars));
    } else if (Object.keys(item).length) {
      lines.push(truncateText(JSON.stringify(item), LIMITS.recallItemChars));
    }
  }
  return lines.join("\n");
}

function renderContextBlock(items: RecallItem[], maxChars: number, statsLine?: string): string {
  const parts: string[] = [];
  let used = 0;
  for (const item of items) {
    const text = String(item.text ?? item.content ?? "").trim();
    if (!text) continue;
    // Graph memory text is injected whole (official policy since 1.6.0) — the
    // block's total maxChars budget below is the only cap.
    if (used + text.length > maxChars) break;
    parts.push(text);
    used += text.length;
  }
  if (parts.length === 0) return "";
  return [
    "=== Cognee memory ===",
    ...(statsLine ? [statsLine] : []),
    ...parts,
    "=== End Cognee memory ===",
  ].join("\n");
}

/** Bounded `=== Code graph facts ===` block for the auto-recall code lane. */
function renderCodeFacts(items: RecallItem[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    const text = String(item.text ?? item.content ?? "").trim() ||
      (Object.keys(item).length ? JSON.stringify(item) : "");
    if (!text) continue;
    const line = truncateText(text, 400);
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return "";
  return ["=== Code graph facts ===", ...lines, "=== End code graph facts ==="].join("\n");
}

/* ------------------------------------------------------------------ */
/* Extension factory                                                   */
/* ------------------------------------------------------------------ */

export default function cogneeExtension(pi: ExtensionAPI): void {
  const cfg: CogneeConfig = loadCogneeConfig();
  const client = new CogneeClient(cfg);

  const state = {
    stopped: false,
    healthy: false,
    lastError: "" as string,
    lastCheckAt: 0,
    failureTimestamps: [] as number[],
    breakerOpenUntil: 0,
    breakerFileSyncedAt: 0,
    degradedNotified: false,
    datasetEnsured: false,
    sessionId: "",
    dataset: cfg.dataset,
    pendingQuestion: null as string | null,
    pendingAnswer: null as string | null,
    writeQueue: [] as QaEntry[],
    draining: false,
    capturedCount: 0,
    droppedCount: 0,
    lastImprovedCount: 0,
    lastAutoImproveAt: 0,
    totalRecallTurns: 0,
    turnsWithHits: 0,
    finalSyncDone: false,
    timers: new Set<ReturnType<typeof setTimeout>>(),
    hasUI: false,
    ui: undefined as ExtensionUIContext | undefined,
    /* code-graph (enola) state */
    cwd: "",
    autoIndexTried: false,
    lastCodeSubmitAt: 0,
    codeReindexTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };

  /* ----- UI helpers (mode-guarded, fail-soft) ----- */

  function notifySafe(message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      if (state.hasUI) state.ui?.notify(message, type);
    } catch {
      /* fail-soft */
    }
  }

  function setStatusSafe(text: string | undefined): void {
    try {
      if (state.hasUI) state.ui?.setStatus("cognee", text);
    } catch {
      /* fail-soft */
    }
  }

  function report(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      if (ctx.hasUI) ctx.ui.notify(message, type);
      else console.log(message);
    } catch {
      /* fail-soft */
    }
  }

  /** One-line code-graph summary for /cognee and /cognee-doctor. Fail-soft by construction. */
  function codeGraphStatusLine(): string {
    try {
      const repo = state.cwd ? findIndexedRepo(state.cwd) : undefined;
      const when = repo?.last_index_at ? ` · indexed ${new Date(repo.last_index_at).toLocaleTimeString()}` : "";
      return `autoindex ${cfg.codeAutoindex}${repo?.dataset ? ` · ${repo.dataset} (${repo.spec_kind})${when}` : " · no indexed repo for cwd"}`;
    } catch {
      return "unavailable";
    }
  }

  /* ----- Circuit breaker (recall path) ----- */
  // File-shared like the official plugins: the in-memory window stays the fast
  // path, but open-until/failure-count also live in ~/.cognee-plugin/pi/breaker.json
  // so concurrent pi processes share outage state instead of each hammering a
  // down server. All file IO is guarded, atomic (tmp+rename), and never throws.

  function sharedBreakerPath(): string {
    return process.env.COGNEE_BREAKER_FILE || DEFAULT_BREAKER_FILE;
  }

  function recordSuccess(): void {
    state.failureTimestamps = [];
    const wasOpen = state.breakerOpenUntil > 0;
    state.breakerOpenUntil = 0;
    // A definitive success is evidence the server is back for everyone sharing
    // it — clear the shared state only when it actually holds something.
    try {
      const shared = loadSharedBreaker(cfg.baseUrl, sharedBreakerPath());
      if (wasOpen || (Number(shared.open_until) || 0) > 0 || (Number(shared.consecutive_failures) || 0) > 0) {
        saveSharedBreaker(cfg.baseUrl, { open_until: 0, consecutive_failures: 0 }, sharedBreakerPath());
      }
    } catch {
      /* fail-soft */
    }
  }

  function recordFailure(err?: CogneeError): void {
    // Only positively-unreachable and 5xx failures count; 4xx is config/auth,
    // timeouts are "no verdict" (same classification as the official plugins).
    if (err && !(err.unreachable || (err.status ?? 0) >= 500)) return;
    const now = Date.now();
    state.failureTimestamps.push(now);
    state.failureTimestamps = state.failureTimestamps.filter((t) => now - t <= cfg.breakerWindowMs);
    try {
      const shared = loadSharedBreaker(cfg.baseUrl, sharedBreakerPath());
      const sharedOpen = Number(shared.open_until) || 0;
      const sharedCount = Number(shared.consecutive_failures) || 0;
      if (state.failureTimestamps.length >= cfg.breakerThreshold) {
        state.breakerOpenUntil = now + cfg.breakerCooldownMs;
        state.failureTimestamps = [];
        saveSharedBreaker(
          cfg.baseUrl,
          {
            open_until: Math.max(state.breakerOpenUntil, sharedOpen),
            consecutive_failures: 0,
          },
          sharedBreakerPath(),
        );
      } else {
        // Carry the cross-process count: another terminal's failures count
        // toward the same outage (max, not sum — windows are per-process).
        saveSharedBreaker(
          cfg.baseUrl,
          {
            open_until: sharedOpen,
            consecutive_failures: Math.max(state.failureTimestamps.length, sharedCount),
          },
          sharedBreakerPath(),
        );
      }
    } catch {
      /* fail-soft — in-memory breaker still applied */
    }
  }

  function breakerOpen(): boolean {
    if (Date.now() < state.breakerOpenUntil) return true;
    // Cross-process check, rate-limited so the per-prompt hot path stays in-memory.
    const now = Date.now();
    if (now - state.breakerFileSyncedAt < BREAKER_FILE_SYNC_MS) return false;
    state.breakerFileSyncedAt = now;
    try {
      const openUntil = Number(loadSharedBreaker(cfg.baseUrl, sharedBreakerPath()).open_until) || 0;
      if (openUntil > now) {
        // Adopt the shared outage window, capped at one cooldown — a stale or
        // clock-skewed future timestamp must not pin recall open forever.
        state.breakerOpenUntil = Math.min(openUntil, now + cfg.breakerCooldownMs);
        return true;
      }
    } catch {
      /* fail-soft */
    }
    return false;
  }

  /** One-line file-shared breaker summary for /cognee and /cognee-doctor. */
  function sharedBreakerSummary(): string {
    try {
      const shared = loadSharedBreaker(cfg.baseUrl, sharedBreakerPath());
      const openUntil = Number(shared.open_until) || 0;
      const count = Number(shared.consecutive_failures) || 0;
      return openUntil > Date.now()
        ? `open until ${new Date(openUntil).toLocaleTimeString()}`
        : `${count} consecutive failure${count === 1 ? "" : "s"} on record`;
    } catch {
      return "unavailable";
    }
  }

  /* ----- Health check + background re-probe ----- */

  async function runHealthCheck(opts: { notify: boolean }): Promise<HealthResult> {
    if (state.stopped) return { reachable: false, latencyMs: 0, error: "extension stopped" };
    const result = await client.health();
    state.lastCheckAt = Date.now();
    if (result.reachable) {
      state.healthy = true;
      state.lastError = "";
      recordSuccess();
      // Loopback server with no key yet — start the owner-key bootstrap in the
      // background so the first authenticated call rarely waits for it.
      void client.ensureAuth().catch(() => {});
      if (!state.datasetEnsured) {
        state.datasetEnsured = true;
        void client.ensureDataset(state.dataset).catch(() => {
          /* best-effort; the server creates datasets implicitly on write */
        });
      }
      void drainWriteQueue().catch(() => {});
      // Code-graph auto-index: one background attempt per session, only after the
      // server is confirmed healthy (never blocks startup; never fires when down).
      if (!state.autoIndexTried && state.cwd) {
        state.autoIndexTried = true;
        const timer = setTimeout(() => {
          state.timers.delete(timer);
          void autoIndexOnStart(state.cwd).catch(() => {});
        }, 100);
        state.timers.add(timer);
      }
      setStatusSafe(`● cognee: ${cfg.backend} · ${state.dataset}`);
      if (opts.notify || state.degradedNotified) {
        state.degradedNotified = false;
        notifySafe("Cognee Memory Connected", "info");
      }
      return result;
    }
    state.healthy = false;
    state.lastError = result.error ?? "unreachable";
    // Same information set as the official statusline (health · backend · dataset).
    setStatusSafe(`✕ cognee: offline (${cfg.backend} · ${state.dataset})`);
    if (opts.notify && !state.degradedNotified) {
      state.degradedNotified = true;
      notifySafe(
        `Cognee memory offline (${cfg.missingBaseUrl ? "COGNEE_BASE_URL missing for forced cloud mode" : state.lastError}). ` +
          "Memory features are disabled; everything else works normally. Run /cognee-doctor to diagnose.",
        "warning",
      );
    }
    return result;
  }

  function scheduleReprobe(): void {
    if (state.stopped || state.healthy) return;
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      void runHealthCheck({ notify: false })
        .catch(() => {})
        .finally(() => scheduleReprobe());
    }, REPROBE_INTERVAL_MS);
    state.timers.add(timer);
  }

  /* ----- Code graph (enola): indexing, freshness, auto-index ----- */

  function retryBackoffSeconds(errorCount: number): number {
    if (errorCount <= 0) return 0;
    return Math.min(RETRY_BACKOFF_BASE_S * 2 ** (errorCount - 1), RETRY_BACKOFF_MAX_S);
  }

  /** Whether a failing repo is still inside its escalating backoff window. */
  function retrySuppressed(repo: CodeRepoState, now: number): boolean {
    const count = repo.error_count ?? 0;
    const lastAt = repo.last_error_at ?? 0;
    if (count <= 0 || lastAt <= 0) return false;
    if (now < lastAt) return false; // clock moved backwards — treat as due
    return now - lastAt < retryBackoffSeconds(count) * 1000;
  }

  function recordRetryFailure(repo: CodeRepoState, error: string, now: number): void {
    repo.error_count = (repo.error_count ?? 0) + 1;
    repo.last_error_at = now;
    repo.last_error = error.slice(0, 200);
    saveRepoState(repo);
  }

  function clearRetryFailure(repo: CodeRepoState): void {
    delete repo.error_count;
    delete repo.last_error_at;
    delete repo.last_error;
  }

  /**
   * Submit one repository for code-graph indexing and record its state file
   * (the opt-in the freshness loop and the code recall lane honor). Local
   * paths are fingerprinted; URL specs record none — a server-side clone only
   * ever sees pushed commits, so re-submitting after a local edit would change
   * nothing (the graph advances when the user pushes and re-indexes).
   */
  async function indexRepoAndRecord(
    spec: string,
    opts: { dataset?: string; indexVectors?: boolean } = {},
  ): Promise<{ dataset: string; result: Awaited<ReturnType<CogneeClient["indexCodeRepo"]>> }> {
    const canonical = canonicalRepoSpec(spec);
    const remote = isRemoteRepoSpec(canonical);
    const dataset = opts.dataset ? sanitizeDatasetName(opts.dataset) : codeDatasetName(canonical);
    const result = await client.indexCodeRepo({
      repoSpec: canonical,
      dataset,
      indexVectors: opts.indexVectors,
    });
    if (result.ok) {
      saveRepoState({
        spec: canonical,
        spec_kind: remote ? "url" : "path",
        repo_root: remote ? "" : canonical,
        dataset,
        index_vectors: Boolean(opts.indexVectors),
        fingerprint: remote ? "" : await gitFingerprint(canonical),
        last_index_at: Date.now(),
        last_status: result.serverStatus ?? "submitted",
      });
      state.lastCodeSubmitAt = Date.now();
    }
    return { dataset, result };
  }

  /**
   * Freshness pass: re-submit the cwd's indexed repo in the background when the
   * working tree changed since the last index. Never throws, never blocks the
   * turn (called from a debounced agent_settled timer). A failed submission
   * keeps the old fingerprint (edits stay pending) and advances the backoff.
   */
  async function reingestIfChanged(cwd: string): Promise<void> {
    if (!cfg.capture || state.stopped || !state.healthy || breakerOpen()) return;
    const repo = findIndexedRepo(cwd);
    if (!repo || repo.spec_kind !== "path" || !repo.repo_root || !repo.dataset) return;
    const now = Date.now();
    if (retrySuppressed(repo, now)) return;
    const fingerprint = await gitFingerprint(repo.repo_root);
    if (!fingerprint || fingerprint === repo.fingerprint) return;
    if (now - state.lastCodeSubmitAt < REINDEX_MIN_INTERVAL_MS) return;
    const result = await client.indexCodeRepo({
      repoSpec: repo.spec || repo.repo_root,
      dataset: repo.dataset,
      indexVectors: repo.index_vectors,
    });
    if (result.ok) {
      repo.fingerprint = fingerprint;
      repo.last_index_at = Date.now();
      repo.last_status = result.serverStatus ?? "submitted";
      clearRetryFailure(repo);
      saveRepoState(repo);
      state.lastCodeSubmitAt = Date.now();
    } else {
      recordRetryFailure(repo, result.error?.message ?? "index failed", now);
    }
  }

  /** Debounced post-turn change check (fires once per quiet gap after agent_settled). */
  function scheduleChangeCheck(): void {
    try {
      if (!cfg.capture || state.stopped || !state.cwd) return;
      if (state.codeReindexTimer) clearTimeout(state.codeReindexTimer);
      state.codeReindexTimer = setTimeout(() => {
        state.codeReindexTimer = undefined;
        void reingestIfChanged(state.cwd).catch(() => {});
      }, REINDEX_DEBOUNCE_MS);
    } catch {
      /* fail-soft */
    }
  }

  /**
   * Session-start auto-indexing: opening pi inside a git repository indexes it
   * in the background — no setup step. An already-indexed repo is always
   * refreshed (the index command was the consent); a NEW repo only when
   * COGNEE_CODE_AUTOINDEX allows it (default "auto" = local server only,
   * because indexing means shipping the checkout to wherever the server runs).
   * Runs after the first successful health probe; never blocks startup.
   */
  async function autoIndexOnStart(cwd: string): Promise<void> {
    try {
      if (!cfg.capture || state.stopped || !state.healthy) return;
      const root = await gitRepoRoot(cwd);
      if (!root) return; // not a git repo — skipped
      const indexed = findIndexedRepo(root);
      if (indexed?.dataset) {
        // A session start is the gesture after fixing whatever broke indexing
        // (corrected key, restarted server) — one attempt, not a backoff wait.
        if (indexed.error_count) {
          clearRetryFailure(indexed);
          saveRepoState(indexed);
        }
        await reingestIfChanged(cwd);
        return;
      }
      if (cfg.codeAutoindex === "off") return;
      // Locality is decided by the URL host (loopback), not the backend label — a
      // COGNEE_LOCAL_API_URL pointed at a LAN host still ships the checkout off-machine.
      if (cfg.codeAutoindex === "auto" && !isLoopbackUrl(cfg.baseUrl)) return; // remote server — explicit opt-in only
      const count = countSourceFiles(root, AUTOINDEX_MAX_FILES);
      if (count === 0 || count > AUTOINDEX_MAX_FILES) return; // no code files / too large
      const { dataset, result } = await indexRepoAndRecord(root);
      if (result.ok) {
        notifySafe(
          `Cognee code graph: indexing "${root.split("/").pop() ?? root}" in the background (dataset ${dataset})`,
          "info",
        );
      }
    } catch {
      /* never break startup */
    }
  }

  /**
   * Arm the per-prompt code recall lane: fires only when the prompt carries an
   * identifier-shaped token AND the cwd sits inside a repo this extension
   * indexed — never on conversational prompts, never on unindexed repos
   * (same gate as the official plugins' auto_code_lane).
   */
  function armCodeLane(prompt: string): { dataset: string; identifier: string; codeQuery: Record<string, unknown> } | undefined {
    try {
      if (!cfg.capture || !state.cwd) return undefined;
      const identifiers = extractIdentifiers(prompt);
      if (identifiers.length === 0) return undefined;
      const repo = findIndexedRepo(state.cwd);
      if (!repo?.dataset) return undefined;
      return { dataset: repo.dataset, identifier: identifiers[0], codeQuery: buildCodeQuery(identifiers[0]) };
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the code dataset for an explicit query: explicit dataset > index
   * state for the repo path > deterministic name derived from the git root
   * (works for repos indexed by the Claude Code / Codex plugins too — the
   * name is a pure function of the canonical path).
   */
  async function resolveCodeDataset(
    explicitDataset: string | undefined,
    repoArg: string | undefined,
  ): Promise<{ dataset: string; how: string } | { error: string }> {
    if (explicitDataset) return { dataset: sanitizeDatasetName(explicitDataset), how: "explicit dataset" };
    const base = repoArg ? pathResolve(state.cwd || process.cwd(), repoArg) : state.cwd || process.cwd();
    if (isRemoteRepoSpec(repoArg ?? "")) {
      return { dataset: codeDatasetName(repoArg!), how: "derived from git URL" };
    }
    const indexed = findIndexedRepo(base);
    if (indexed?.dataset) return { dataset: indexed.dataset, how: "index state" };
    const root = await gitRepoRoot(base);
    if (root) return { dataset: codeDatasetName(root), how: "derived from repo path" };
    return {
      error:
        `no git repository at ${base} and no indexed code dataset — run /cognee-index <path-or-git-url> first, ` +
        "or pass dataset/repo explicitly",
    };
  }

  /* ----- Session-cache writes (tier 1) with bounded in-memory buffer ----- */

  function queueQa(entry: QaEntry): void {
    if (state.writeQueue.length >= cfg.bufferLimit) {
      state.writeQueue.shift();
      state.droppedCount++;
      // ponytail: drop-oldest silently — bounded memory beats unbounded growth;
      // the official plugins spill to a disk bridge instead (deferred).
    }
    state.writeQueue.push(entry);
    void drainWriteQueue().catch(() => {});
  }

  async function drainWriteQueue(opts: { force?: boolean; deadline?: number } = {}): Promise<void> {
    if (state.draining || !state.healthy || (!opts.force && state.stopped) || !state.sessionId) return;
    state.draining = true;
    try {
      while (state.writeQueue.length > 0 && state.healthy && (opts.force || !state.stopped)) {
        if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
        const next = state.writeQueue[0];
        // Bounded per-request timeout when a deadline is in force (final sync).
        const timeoutMs =
          opts.deadline !== undefined
            ? Math.max(1000, Math.min(cfg.requestTimeoutMs, opts.deadline - Date.now()))
            : undefined;
        const result = await client.rememberEntry(next, state.sessionId, state.dataset, timeoutMs);
        if (result.ok) {
          state.writeQueue.shift();
          state.capturedCount++;
          continue;
        }
        const err = result.error;
        // Retriable (network/5xx): keep buffered for the next drain. Permanent 4xx: drop loudly.
        if (err && ((err.status ?? 0) === 0 || err.status! >= 500)) {
          state.lastError = err.message;
          break;
        }
        state.writeQueue.shift();
        state.droppedCount++;
        state.lastError = err?.message ?? "write rejected";
      }
    } finally {
      state.draining = false;
    }
  }

  /* ----- Graph promotion (tier 2) ----- */

  function maybeAutoImprove(): void {
    const every = cfg.autoImproveEvery;
    if (!every || state.capturedCount === 0 || state.stopped) return;
    // Fire when the stored-write counter CROSSES the threshold — capturedCount can
    // jump past a modulo target when several queued entries drain at once.
    if (state.capturedCount - state.lastImprovedCount < every) return;
    const now = Date.now();
    if (now - state.lastAutoImproveAt < cfg.improveCooldownMs) return;
    state.lastAutoImproveAt = now;
    state.lastImprovedCount = state.capturedCount;
    void client.improve(state.sessionId, state.dataset).catch(() => {
      /* fail-soft */
    });
  }

  async function finalSync(): Promise<void> {
    if (state.finalSyncDone) return;
    state.finalSyncDone = true;
    if (!cfg.finalSync || !state.sessionId) return;
    // ponytail: bounded in-process final sync instead of the official detached
    // retrying worker — a slow server must not stall pi's shutdown. One late
    // health re-probe gives a server that came back during the session a final
    // chance to receive the buffered writes before the graph promote; anything
    // still buffered when pi exits is lost (no disk bridge yet).
    try {
      if (state.writeQueue.length > 0 && !state.healthy) {
        state.healthy = (await client.health(1000)).reachable;
      }
      if (state.healthy) {
        await drainWriteQueue({ force: true, deadline: Date.now() + FINAL_SYNC_TIMEOUT_MS });
      }
      if (state.capturedCount === 0) return;
      await client.improve(state.sessionId, state.dataset, FINAL_SYNC_TIMEOUT_MS);
    } catch {
      /* fail-soft */
    }
  }

  function stopWatchers(): void {
    state.stopped = true;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    if (state.codeReindexTimer) {
      clearTimeout(state.codeReindexTimer);
      state.codeReindexTimer = undefined;
    }
  }

  async function waitForCognify(
    datasetId: string,
    budgetMs: number,
    signal?: AbortSignal,
    pipeline: "cognify_pipeline" | "code_graph_pipeline" = "cognify_pipeline",
    intervalMs = 1500,
  ): Promise<string> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline && !signal?.aborted && !state.stopped) {
      const result = await client.datasetStatus(datasetId, pipeline, 3000);
      if (result.ok) {
        // Case-insensitive, suffix match (same as the reference pollers): servers
        // report "completed"/"COMPLETED"/prefixed forms alike.
        const s = (result.status ?? "").toUpperCase();
        if (s.endsWith("COMPLETED")) return "graph is queryable";
        if (s.endsWith("ERRORED")) return "pipeline ERRORED — data stored, but graph build failed";
      }
      // Abort-aware poll sleep, registered in state.timers so shutdown clears it.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          state.timers.delete(t);
          resolve();
        }, intervalMs);
        state.timers.add(t);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            state.timers.delete(t);
            resolve();
          },
          { once: true },
        );
      });
    }
    return "still processing in background";
  }

  /* ================================================================ */
  /* TOOLS                                                              */
  /* ================================================================ */

  pi.registerTool({
    name: "cognee_remember",
    label: "Cognee Remember",
    description:
      "Store durable knowledge in the cognee persistent memory graph (survives across sessions). " +
      "WHEN to use: the user states a lasting preference, decision, project convention, correction, or fact " +
      "worth recalling in future sessions — or asks you to remember/save/note something. " +
      "Per-file ingestion: pass file=<path> (instead of content) to upload one file from disk under its REAL " +
      "filename — a .py/.ts/... upload routes down the server's zero-LLM code path into the code graph " +
      "(single file only, no cross-file edges — index the repo for those). The file must exist, be text, " +
      "fit the size cap, and not look like a credential (~/.ssh, *.pem, .env, id_rsa*, credentials* are refused). " +
      "WHEN NOT to use: ordinary conversation turns are auto-captured into session memory already; " +
      "do not remember transient details or secrets. " +
      "Choose node_set: user_context (preferences, instructions about the user), project_docs (architecture, " +
      "conventions, domain knowledge, code files), agent_actions (operational notes about how to work here). " +
      "Ingestion into the graph is asynchronous; the tool briefly waits for the graph to become queryable. " +
      "Output is truncated at 4000 chars.",
    promptSnippet: "Store durable facts, preferences and decisions in cognee persistent memory.",
    parameters: Type.Object({
      content: Type.Optional(
        Type.String({
          description:
            "The knowledge to persist, written as self-contained prose (it will be read without this conversation's context). Provide this or file.",
        }),
      ),
      file: Type.Optional(
        Type.String({
          description:
            "Path to a single file on disk to ingest under its real filename (routes code extensions down the zero-LLM code-graph path; no cross-file edges). Takes precedence over content. Must exist, be text, ≤200 KB.",
        }),
      ),
      node_set: Type.Optional(
        Type.Union(
          [
            Type.Literal("user_context"),
            Type.Literal("project_docs"),
            Type.Literal("agent_actions"),
          ],
          { description: "Memory category. Default: user_context." },
        ),
      ),
      dataset: Type.Optional(
        Type.String({ description: "Target dataset name. Default: the session dataset." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const dataset = params.dataset ?? state.dataset;
        const nodeSet = params.node_set ?? "user_context";
        if (params.file) {
          // Per-file ingestion (mirror of cognee-remember.sh --file): read from
          // disk guarded, upload VERBATIM under the real basename — the filename
          // extension is the server's loader-routing signal (code extensions →
          // zero-LLM code route), so no redaction, no synthetic .txt rename.
          const read = readRememberFile(params.file, REMEMBER_FILE_MAX_BYTES);
          if (!read.ok || !read.text || !read.basename) {
            return textResult(`⚠ cognee_remember file rejected: ${read.error}`, { error: "file" });
          }
          const result = await client.remember({
            content: read.text,
            filename: read.basename,
            nodeSet,
            dataset,
            externalSignal: signal,
          });
          if (!result.ok) return errResult("cognee_remember failed", result.error);
          let suffix = "";
          if (result.datasetId) {
            suffix = ` ${await waitForCognify(result.datasetId, cfg.rememberWaitMs, signal)}`;
          }
          return textResult(
            `Stored file '${read.basename}' (${read.bytes} bytes) in dataset '${dataset}' (node_set: ${nodeSet}) — ` +
              `code extensions route into the code graph without LLM calls.${suffix}`,
            { dataset, nodeSet, filename: read.basename, datasetId: result.datasetId },
          );
        }
        if (!params.content || !params.content.trim()) {
          return textResult("⚠ Provide content (prose) or file (a path on disk) — one of the two is required.", {
            error: "bad params",
          });
        }
        const result = await client.remember({
          // Explicit memory is durable and cross-session — redact secrets on the
          // way in (hardening beyond the official plugins, which only redact
          // auto-capture; prevention beats cleanup via forget).
          content: redactSecrets(params.content),
          nodeSet,
          dataset,
          externalSignal: signal,
        });
        if (!result.ok) return errResult("cognee_remember failed", result.error);
        let suffix = "";
        if (result.datasetId) {
          suffix = ` ${await waitForCognify(result.datasetId, cfg.rememberWaitMs, signal)}`;
        }
        return textResult(`Stored in dataset '${dataset}' (node_set: ${nodeSet}).${suffix}`, {
          dataset,
          nodeSet,
          datasetId: result.datasetId,
        });
      } catch (err) {
        return errResult("cognee_remember failed", wrapAsCogneeError(err));
      }
    },
  });

  pi.registerTool({
    name: "cognee_recall",
    label: "Cognee Recall",
    description:
      "Recall relevant memories for a query from cognee persistent memory — the prompt-scoped twin of " +
      "cognee_search, including session-bound context. WHEN to use: at the start of a task, when the user " +
      "refers to earlier decisions/preferences ('like last time', 'as we decided'), or to check what is " +
      "already known about a topic before re-deriving it. Auto-recall already runs on each user prompt; " +
      "use this for targeted follow-up queries. Set session_only=true to read this session's raw cache " +
      "(recent question/answer pairs) instead of the graph. Output is truncated at 4000 chars.",
    promptSnippet: "Recall previously stored cognee memories relevant to a query.",
    parameters: Type.Object({
      query: Type.String({ description: "What to remember — a natural-language query." }),
      search_type: Type.Optional(
        Type.String({
          description:
            "Server search type. Default HYBRID_COMPLETION (BM25 + vector + graph). Alternatives: GRAPH_COMPLETION, RAG_COMPLETION, CHUNKS.",
        }),
      ),
      session_only: Type.Optional(
        Type.Boolean({
          description: "Read only this session's cache (recent Q&A pairs) instead of the permanent graph.",
        }),
      ),
      top_k: Type.Optional(
        Type.Number({ minimum: 1, maximum: 20, description: "Maximum number of memories. Default 5." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        if (params.session_only) {
          const detail = await client.getSessionDetail(state.sessionId || "unknown", 5000);
          if (!detail.ok) return errResult("cognee_recall failed", detail.error);
          const rows = detail.qas.slice(-10).map((qa) => {
            const q = truncateText(String(qa.question ?? ""), LIMITS.recallItemChars);
            const a = truncateText(String(qa.answer ?? ""), LIMITS.recallItemChars);
            return `Q: ${q}\nA: ${a}`;
          });
          return textResult(
            rows.length ? rows.join("\n---\n") : "Session cache is empty (no captured turns yet).",
            { mode: "session_only", rows: rows.length },
          );
        }
        const result = await client.recall({
          query: params.query,
          sessionId: state.sessionId || undefined,
          dataset: state.dataset,
          topK: params.top_k ?? 5,
          searchType: params.search_type ?? "HYBRID_COMPLETION",
          onlyContext: true,
          scope: ["graph"],
          externalSignal: signal,
        });
        if (!result.ok) return errResult("cognee_recall failed", result.error);
        const body = renderRecallItems(result.items);
        return textResult(
          body || (result.noGraph ? "No graph memory yet for this dataset — remember something first." : "No relevant memories found."),
          { hits: result.items.length, noGraph: result.noGraph ?? false },
        );
      } catch (err) {
        return errResult("cognee_recall failed", wrapAsCogneeError(err));
      }
    },
  });

  pi.registerTool({
    name: "cognee_search",
    label: "Cognee Search",
    description:
      "Explicit knowledge-graph search over cognee memory datasets. Unlike cognee_recall (which is bound to " +
      "the current session dataset), this searches the graph with the server's default routing and can target " +
      "any dataset by name — including datasets written by the Claude Code or Codex cognee plugins. " +
      "WHEN to use: broad or exploratory memory queries ('what do we know about the billing service'), " +
      "cross-project lookups, or when the user explicitly asks to search memory. " +
      "Output is truncated at 4000 chars.",
    promptSnippet: "Search cognee memory datasets (graph search, any dataset).",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language search query." }),
      top_k: Type.Optional(
        Type.Number({ minimum: 1, maximum: 20, description: "Maximum results. Default 5." }),
      ),
      dataset: Type.Optional(
        Type.String({ description: "Dataset to search. Default: the session dataset." }),
      ),
      search_type: Type.Optional(
        Type.String({
          description: "Optional server search type pin (e.g. GRAPH_COMPLETION, CHUNKS). Omit for server default routing.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await client.recall({
          query: params.query,
          topK: params.top_k ?? 5,
          dataset: params.dataset ?? state.dataset,
          searchType: params.search_type, // undefined → server default routing (explicit-search parity)
          onlyContext: true,
          scope: ["graph"],
          externalSignal: signal,
        });
        if (!result.ok) return errResult("cognee_search failed", result.error);
        const body = renderRecallItems(result.items);
        return textResult(
          body || (result.noGraph ? "Dataset has no graph yet — cognify has not run." : "No results found."),
          { hits: result.items.length, dataset: params.dataset ?? state.dataset },
        );
      } catch (err) {
        return errResult("cognee_search failed", wrapAsCogneeError(err));
      }
    },
  });

  pi.registerTool({
    name: "cognee_code",
    label: "Cognee Code",
    description:
      "Deterministic query over the current repository's cognee CODE GRAPH (symbols, calls, imports, " +
      "endpoints) — exact, instant, no tokens. WHEN to use: STRUCTURAL questions that name a symbol or file — " +
      "'what calls process_payment' (seed), 'what breaks if I change X' (operation=impact_analysis, targets), " +
      "'how does AuthMiddleware reach Database' (find_path, source+target), 'list all endpoints' (query_facts, " +
      "kind=route), 'explore around UserService' (explore, name, max_depth), 'follow calls from main' (traverse, " +
      "start, direction, max_depth), 'what did the last re-index change' (delta). WHEN NOT to use: conceptual " +
      "questions naming nothing ('how does auth work here?') — use cognee_search for those (code facts are " +
      "invisible to it unless the repo was indexed with --index-vectors). Chain them: hybrid search discovers the " +
      "name, this tool gives the exact structure around it. Requires the repo to be indexed (run /cognee-index " +
      "<path-or-git-url>; automatic at session start for local servers, COGNEE_CODE_AUTOINDEX). Treat results as " +
      "a map, not ground truth — verify against the actual files before editing. Output is truncated at 4000 chars.",
    promptSnippet: "Query the repo's code graph: callers, impact, paths, endpoints (exact, no tokens).",
    parameters: Type.Object({
      seed: Type.Optional(
        Type.String({
          description:
            "Seed node name (exact/suffix/substring match), e.g. 'process_payment' or 'UserService'. Either this or operation is required; an ambiguous seed errors listing candidates, an unresolved one returns empty.",
        }),
      ),
      operation: Type.Optional(
        Type.Union(
          CODE_OPS.map((op) => Type.Literal(op)),
          {
            description:
              "Exact operation instead of a seed match: query_facts (filtered listing, kind/name/limit), explore (neighborhood of name), traverse (start/direction/max_depth), find_path (source→target), impact_analysis (targets: what breaks), delta (what the last index changed).",
          },
        ),
      ),
      name: Type.Optional(Type.String({ description: "explore/query_facts: node name to look at." })),
      start: Type.Optional(Type.String({ description: "traverse: seed node to start from." })),
      source: Type.Optional(Type.String({ description: "find_path: start node." })),
      target: Type.Optional(Type.String({ description: "find_path: end node." })),
      targets: Type.Optional(
        Type.Array(Type.String(), { description: "impact_analysis: symbols whose dependents you want." }),
      ),
      kind: Type.Optional(
        Type.String({ description: "query_facts: filter by node kind — one of: association, dependency, extraction, file_ref, insight, intent, lint, module, route, service, storage, symbol, test_ref (e.g. 'route' for API endpoints, 'symbol' for functions/classes)." }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "query_facts: max facts. Default 50." })),
      max_depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "explore/traverse: edge hops." })),
      direction: Type.Optional(
        Type.String({ description: "traverse: 'forward' | 'backward' | 'both' edge direction." }),
      ),
      repo: Type.Optional(
        Type.String({ description: "Repository path (or git URL) to resolve the code dataset from, when not the cwd." }),
      ),
      dataset: Type.Optional(Type.String({ description: "Explicit code dataset name override." })),
      top_k: Type.Optional(
        Type.Number({ minimum: 1, maximum: 50, description: "Server-side result cap. Default 10." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        // Build the code query: either an exact operation or a seed match.
        let codeQuery: Record<string, unknown> | undefined;
        let seed = params.seed ?? "";
        if (params.operation) {
          const op = params.operation as CodeOp;
          const missing: Record<CodeOp, string> = {
            query_facts: "",
            explore: params.name ? "" : "explore needs 'name'",
            traverse: params.start ? "" : "traverse needs 'start'",
            find_path: params.source && params.target ? "" : "find_path needs 'source' and 'target'",
            impact_analysis: params.targets?.length ? "" : "impact_analysis needs 'targets'",
            delta: "",
          };
          if (missing[op]) return textResult(`⚠ ${missing[op]}`, { error: "bad params" });
          codeQuery = { operation: op };
          for (const field of ["name", "start", "source", "target", "kind", "direction"] as const) {
            const value = params[field];
            if (typeof value === "string" && value) codeQuery[field] = value;
          }
          if (params.targets?.length) codeQuery.targets = params.targets;
          if (params.limit) codeQuery.limit = params.limit;
          if (params.max_depth) codeQuery.max_depth = params.max_depth;
          if (!seed) seed = params.name ?? params.start ?? params.source ?? params.targets?.[0] ?? op;
        } else if (!seed) {
          return textResult(
            "⚠ Provide a seed (node name) or an operation (query_facts, explore, traverse, find_path, impact_analysis, delta). " +
              "Examples: seed='process_payment' (what calls it); operation='impact_analysis', targets=['process_payment']; " +
              "operation='query_facts', kind='route' (all endpoints).",
            { error: "bad params" },
          );
        }
        const resolved = await resolveCodeDataset(params.dataset, params.repo);
        if ("error" in resolved) return textResult(`⚠ ${resolved.error}`, { error: "no dataset" });
        const result = await client.codeSearch({
          seed,
          codeQuery,
          dataset: resolved.dataset,
          topK: params.top_k ?? 10,
          externalSignal: signal,
        });
        if (!result.ok) return errResult("cognee_code failed", result.error);
        const body = renderCodeItems(result.items);
        return textResult(
          body ||
            (result.noGraph
              ? `Code dataset '${resolved.dataset}' has no graph yet — indexing may still be running (check /cognee-index --wait).`
              : `No code facts for '${seed}' — the graph has no such symbol (an empty result, not an error).`),
          { hits: result.items.length, dataset: resolved.dataset, resolvedVia: resolved.how },
        );
      } catch (err) {
        return errResult("cognee_code failed", wrapAsCogneeError(err));
      }
    },
  });

  pi.registerTool({
    name: "cognee_forget",
    label: "Cognee Forget",
    description:
      "Delete memories from a cognee dataset. IRREVERSIBLE. Delete one document with its data_id, or the " +
      "entire dataset with entire_dataset=true (only on explicit user request). " +
      "WHEN to use: the user asks to remove wrong/outdated/sensitive memories. Always confirm the scope with " +
      "the user first — there is no undo. Run `/cognee-forget <dataset>` (no dataId) to list that dataset's " +
      "data items and find data_id values.",
    parameters: Type.Object({
      dataset: Type.String({ description: "Dataset name (or UUID) holding the memory." }),
      data_id: Type.Optional(
        Type.String({ description: "UUID of the single stored data item to delete." }),
      ),
      entire_dataset: Type.Optional(
        Type.Boolean({
          description: "Delete the WHOLE dataset. Irreversible. Only on explicit user request.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        if (!params.data_id && !params.entire_dataset) {
          return textResult(
            "Nothing deleted. Provide data_id to forget one document, or entire_dataset=true to delete the whole dataset (irreversible).",
            { deleted: false },
          );
        }
        let datasetId = isUuid(params.dataset) ? params.dataset : "";
        if (!datasetId) {
          const listed = await client.listDatasets();
          if (!listed.ok) return errResult("cognee_forget could not list datasets", listed.error);
          const match = listed.datasets.find(
            (d) => d.name === params.dataset || d.id === params.dataset,
          );
          if (!match?.id) {
            return textResult(
              `Dataset '${params.dataset}' not found. Available: ${listed.datasets.map((d) => d.name).join(", ") || "(none)"}`,
              { deleted: false },
            );
          }
          datasetId = match.id;
        }
        const result = await client.forget(datasetId, params.data_id, undefined);
        if (!result.ok) return errResult("cognee_forget failed", result.error);
        if (!params.data_id) {
          // Audit trail for the broadest delete scope (durable, excluded from model context).
          try {
            pi.appendEntry("cognee_forget", {
              scope: "entire_dataset",
              dataset: params.dataset,
              datasetId,
              at: new Date().toISOString(),
            });
          } catch {
            /* audit is best-effort */
          }
        }
        return textResult(
          params.data_id
            ? `Deleted data item ${params.data_id} from dataset '${params.dataset}'.`
            : `Deleted entire dataset '${params.dataset}' (${datasetId}).`,
          { deleted: true, datasetId, dataId: params.data_id ?? null },
        );
      } catch (err) {
        return errResult("cognee_forget failed", wrapAsCogneeError(err));
      }
    },
  });

  pi.registerTool({
    name: "cognee_sync",
    label: "Cognee Sync",
    description:
      "Promote this session's cached prompts/answers into the permanent knowledge graph (runs the server-side " +
      "improve pipeline: QA persist, distillation, enrichment). WHEN to use: the user asks to save/sync this " +
      "session's memory to the graph, or before ending an important session. Normally automatic (idle-based " +
      "auto-sync and session shutdown); 'busy' means the server is already improving this session.",
    parameters: Type.Object({
      dataset: Type.Optional(
        Type.String({ description: "Target dataset. Default: the session dataset." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await client.improve(
          state.sessionId || "unknown",
          params.dataset ?? state.dataset,
          cfg.improveSubmitTimeoutMs,
          signal,
        );
        const messages: Record<string, string> = {
          ok: `Session cache promoted into the graph (dataset '${params.dataset ?? state.dataset}').`,
          busy: "The server is already improving this session — it will sync on its own; nothing to do.",
          unsupported:
            "This cognee server does not support /api/v1/improve (older than the plugin-pinned version) — session not synced.",
        };
        if (result.outcome === "error") return errResult("cognee_sync failed", result.error);
        return textResult(messages[result.outcome], { outcome: result.outcome });
      } catch (err) {
        return errResult("cognee_sync failed", wrapAsCogneeError(err));
      }
    },
  });

  /* ================================================================ */
  /* COMMANDS                                                           */
  /* ================================================================ */

  pi.registerCommand("cognee", {
    description: "Cognee memory: status, health, and config summary",
    handler: async (_args, ctx) => {
      try {
        // Full health path (breaker reset, dataset ensure, queue drain, status text)
        // — never mutate state.healthy by hand.
        const health = await runHealthCheck({ notify: false });
        const lines = [
          `Cognee Memory — ${health.reachable ? "connected" : "offline"}`,
          `  Mode:      ${cfg.backend}${cfg.backendForced ? ` (forced by COGNEE_BACKEND=${cfg.backend})` : ""}${cfg.missingBaseUrl ? " — ✕ COGNEE_BASE_URL missing" : ""}`,
          `  Server:    ${cfg.baseUrl}${health.reachable ? ` — reachable in ${health.latencyMs}ms${health.version ? ` (v${health.version})` : ""}` : ` — unreachable: ${health.error ?? "unknown error"}`}`,
          `  Dataset:   ${state.dataset}`,
          `  Session:   ${state.sessionId || "(not started)"}`,
          `  API key:   ${client.authSummary()}`,
          `  Auto:      capture ${cfg.capture ? "on" : "off (COGNEE_CAPTURE=false)"} · auto-recall ${cfg.capture ? "on" : "off"} · auto-sync every ${cfg.autoImproveEvery || "∞"} writes`,
          `  Recall:    ${state.turnsWithHits}/${state.totalRecallTurns} turns had hits this session`,
          `  Queue:     ${state.writeQueue.length} buffered · ${state.capturedCount} stored this session${state.droppedCount ? ` · ${state.droppedCount} dropped` : ""}`,
          `  Breaker:   ${breakerOpen() ? `open until ${new Date(state.breakerOpenUntil).toLocaleTimeString()} (recall paused)` : "closed"} · file-shared (${sharedBreakerSummary()})`,
          codeGraphStatusLine(),
        ];
        report(ctx, lines.join("\n"), health.reachable ? "info" : "warning");
      } catch (err) {
        report(ctx, `Cognee status failed: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("cognee-doctor", {
    description: "Diagnose cognee memory: env, server reachability, latency, datasets",
    handler: async (_args, ctx) => {
      try {
        const health = await client.health(3000);
        const datasets = health.reachable
          ? await client.listDatasets(5000)
          : { ok: false as const, datasets: [], error: new CogneeError("server unreachable") };
        const pad = (label: string) => label.padEnd(13);
        const keySummary = client.authSummary();
        const lines = [
          "Cognee Doctor",
          `  ${pad("Mode")}${cfg.backend}${cfg.backendForced ? ` — forced by COGNEE_BACKEND=${cfg.backend}` : ""}`,
          `  ${pad("Server URL")}${cfg.baseUrl}${cfg.missingBaseUrl ? "  ✕ missing COGNEE_BASE_URL (cloud pinned, no URL configured)" : ""}`,
          `  ${pad("Reachable")}${health.reachable ? `yes — ${health.latencyMs}ms${health.version ? `, server v${health.version}` : ""}` : `NO — ${health.error ?? "unknown error"}`}`,
          `  ${pad("API key")}${keySummary}`,
          `  ${pad("Env file")}${cfg.envFilePath}${cfg.envFileExists ? ` (found, ${cfg.envFileKeys.length} keys${cfg.envFileKeys.length ? `: ${cfg.envFileKeys.join(", ")}` : ""})` : " (not found — created by the official plugins on first run, or add one yourself)"}`,
          `  ${pad("Shell env")}${cfg.shellOverrides.length ? cfg.shellOverrides.join(", ") : "(no COGNEE_*/LLM_* overrides)"}`,
          `  ${pad("LLM_API_KEY")}${cfg.llmApiKeyConfigured ? `configured${cfg.llmModel ? ` (model ${cfg.llmModel})` : ""} — required by a local cognee server` : "missing — required in local mode (the server, not this extension, needs it)"}`,
          `  ${pad("Dataset")}${state.dataset}${cfg.dataset !== "agent_sessions" ? " (custom via COGNEE_PLUGIN_DATASET)" : " (default, shared with Claude Code/Codex plugins)"}`,
          `  ${pad("Session")}${state.sessionId || "(not started)"}`,
          `  ${pad("Datasets")}${datasets.ok && datasets.datasets.length ? datasets.datasets.slice(0, 10).map((d) => `${d.name}${d.id ? ` (${d.id.slice(0, 8)}…)` : ""}`).join(", ") : datasets.ok ? "(none readable)" : `unavailable (${describeError(datasets.error)})`}`,
          `  ${pad("Capture")}${cfg.capture ? "on" : "off (COGNEE_CAPTURE=false)"} · stored this session: ${state.capturedCount} · buffered: ${state.writeQueue.length}`,
          `  ${pad("Breaker")}${breakerOpen() ? `OPEN until ${new Date(state.breakerOpenUntil).toLocaleTimeString()}` : `closed (${state.failureTimestamps.length}/${cfg.breakerThreshold} recent failures)`} · shared: ${sharedBreakerSummary()}`,
          `  ${pad("Timeouts")}recall ${cfg.recallTimeoutMs}ms · request ${cfg.requestTimeoutMs}ms · health ${cfg.healthTimeoutMs}ms`,
          `  ${pad("Code graph")}${codeGraphStatusLine()}`,
        ];
        if (cfg.backend === "local" && keySummary.startsWith("not set")) {
          lines.push(
            `             cognee ≥1.2.2 enforces auth even on localhost — pi-cognee auto-mints an owner key when the server's default user can log in: start it with DEFAULT_USER_PASSWORD set to the same value as COGNEE_USER_PASSWORD (defaults: default_user@example.com / default_password), or set COGNEE_API_KEY explicitly.`,
          );
        }
        report(ctx, lines.join("\n"), health.reachable ? "info" : "warning");
      } catch (err) {
        report(ctx, `Cognee doctor failed: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("cognee-remember", {
    description: "Remember text (or --file <path>) in the cognee graph [--node-set user_context|project_docs|agent_actions]",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        let nodeSet: "user_context" | "project_docs" | "agent_actions" = "user_context";
        let file: string | undefined;
        const rest: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === "--node-set" && tokens[i + 1]) nodeSet = tokens[++i] as typeof nodeSet;
          else if (tokens[i] === "--file" && tokens[i + 1]) file = tokens[++i];
          else rest.push(tokens[i]);
        }
        let content = rest.join(" ");
        let filename: string | undefined;
        let isFileUpload = false;
        if (file) {
          // Per-file ingestion (mirror of cognee-remember.sh --file): guarded
          // read, uploaded VERBATIM under the real basename so the filename
          // extension routes code files down the zero-LLM code path.
          const read = readRememberFile(file, REMEMBER_FILE_MAX_BYTES);
          if (!read.ok || !read.text || !read.basename) {
            report(ctx, `Remember failed: ${read.error}`, "error");
            return;
          }
          content = read.text;
          filename = read.basename;
          isFileUpload = true;
        }
        if (!content.trim()) {
          report(ctx, "Usage: /cognee-remember <text> [--file <path>] [--node-set user_context|project_docs|agent_actions]", "warning");
          return;
        }
        // Durable cross-session memory — redact secrets on the way in for prose;
        // file uploads stay verbatim (code must route as code, same as the
        // official plugins' --file path).
        if (!isFileUpload) content = redactSecrets(content);
        const result = await client.remember({ content, nodeSet, dataset: state.dataset, filename });
        if (!result.ok) {
          report(ctx, `Remember failed: ${result.error?.message ?? "unknown error"}${result.error?.unreachable ? ` — is the cognee server running at ${cfg.baseUrl}?` : ""}`, "error");
          return;
        }
        let suffix = "";
        if (result.datasetId) suffix = ` ${await waitForCognify(result.datasetId, cfg.rememberWaitMs)}`;
        report(
          ctx,
          isFileUpload
            ? `Stored file '${filename}' (${content.length} chars) in '${state.dataset}' (node_set ${nodeSet}) — code extensions route into the code graph without LLM calls.${suffix}`
            : `Remembered ${content.length} chars into '${state.dataset}' (node_set ${nodeSet}).${suffix}`,
        );
      } catch (err) {
        report(ctx, `Remember failed: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("cognee-search", {
    description: "Search the cognee memory graph: /cognee-search <query> [--top-k N] [--dataset <name>]",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        let topK = 5;
        let dataset: string | undefined;
        const rest: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === "--top-k" && tokens[i + 1]) topK = Number(tokens[++i]) || 5;
          else if (tokens[i] === "--dataset" && tokens[i + 1]) dataset = tokens[++i];
          else rest.push(tokens[i]);
        }
        const query = rest.join(" ");
        if (!query) {
          report(ctx, "Usage: /cognee-search <query> [--top-k N] [--dataset <name>]", "warning");
          return;
        }
        const result = await client.recall({
          query,
          topK,
          dataset: dataset ?? state.dataset,
          onlyContext: true,
          scope: ["graph"],
          timeoutMs: cfg.requestTimeoutMs,
        });
        if (!result.ok) {
          report(ctx, `Search failed: ${result.error?.message ?? "unknown error"}`, "error");
          return;
        }
        const body = renderRecallItems(result.items);
        report(ctx, body || (result.noGraph ? "Dataset has no graph yet — nothing remembered/cognified." : "No results."), body ? "info" : "warning");
      } catch (err) {
        report(ctx, `Search failed: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("cognee-index", {
    description:
      "Index a repo into the cognee code graph: /cognee-index [path|git-url] [--dataset <name>] [--index-vectors] [--wait <seconds>]",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        let dataset: string | undefined;
        let indexVectors = false;
        let waitSeconds = 0;
        const rest: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === "--dataset" && tokens[i + 1]) dataset = tokens[++i];
          else if (tokens[i] === "--index-vectors") indexVectors = true;
          else if (tokens[i] === "--wait" && tokens[i + 1]) waitSeconds = Math.max(0, Number(tokens[++i]) || 0);
          else rest.push(tokens[i]);
        }
        const spec = rest[0] ?? ".";
        const isLocalSpec = !isRemoteRepoSpec(spec);
        const resolvedSpec = isLocalSpec ? pathResolve(ctx.cwd, spec) : spec;
        if (isLocalSpec && cfg.backend !== "local") {
          report(
            ctx,
            `⚠ Cloud/remote servers cannot read local paths — '${spec}' will likely be rejected. Pass a git URL instead (the server clones it; freshness then follows pushed commits).`,
            "warning",
          );
        }
        const { dataset: usedDataset, result } = await indexRepoAndRecord(resolvedSpec, { dataset, indexVectors });
        if (!result.ok) {
          report(
            ctx,
            `Index failed: ${result.error?.message ?? "unknown error"}${result.error?.unreachable ? ` — nothing was submitted (is the cognee server running at ${cfg.baseUrl}?). pi itself is unaffected.` : ""}`,
            "error",
          );
          return;
        }
        const lines = [
          `Submitted '${resolvedSpec}' for code-graph indexing (cognee >= 1.5.4 required; no LLM/embedding calls — deterministic).`,
          `  Dataset:         ${usedDataset}`,
          result.datasetId ? `  Dataset ID:      ${result.datasetId}` : "",
          result.pipelineRunId ? `  Pipeline run:    ${result.pipelineRunId}` : "",
          indexVectors ? "  Vectors:         embedded (--index-vectors; code facts now visible to semantic search)" : "  Vectors:         off (code facts reachable ONLY via code search — /cognee-code, cognee_code)",
          "  Freshness:       local-path repos are re-indexed automatically after turns that change the tree; git-URL repos follow pushed commits (re-run after pushing).",
          "  Note:            indexing writes an enola snapshot to <repo>/.enola/ (untracked) — add it to .gitignore.",
        ].filter(Boolean);
        if (waitSeconds > 0 && result.datasetId) {
          const outcome = await waitForCognify(
            result.datasetId,
            waitSeconds * 1000,
            undefined,
            "code_graph_pipeline",
            3000,
          );
          lines.push(`  Wait:            ${outcome}`);
        } else {
          lines.push("  Background:      pipeline runs server-side; query with /cognee-code once built (add --wait <seconds> to poll here).");
        }
        report(ctx, lines.join("\n"));
      } catch (err) {
        report(ctx, `Index failed: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("cognee-code", {
    description:
      "Query the repo's cognee code graph: /cognee-code <seed> | /cognee-code '<operation-json>' [--dataset <name>] [--top-k N]",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        let dataset: string | undefined;
        let topK = 10;
        const rest: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === "--dataset" && tokens[i + 1]) dataset = tokens[++i];
          else if (tokens[i] === "--top-k" && tokens[i + 1]) topK = Number(tokens[++i]) || 10;
          else rest.push(tokens[i]);
        }
        const query = rest.join(" ");
        if (!query) {
          report(
            ctx,
            [
              "Usage: /cognee-code <seed> | /cognee-code '<operation-json>' [--dataset <name>] [--top-k N]",
              "",
              "Operations:",
              '  {"operation":"query_facts","kind":"route","limit":50}   — e.g. all API endpoints',
              '  {"operation":"explore","name":"UserService","max_depth":1}',
              '  {"operation":"traverse","start":"main","direction":"forward","max_depth":3}',
              '  {"operation":"find_path","source":"AuthMiddleware","target":"Database"}',
              '  {"operation":"impact_analysis","targets":["process_payment"]}',
              '  {"operation":"delta"}                                        — what the last index changed',
              "",
              "A plain word is a seed (exact/suffix/substring match). Index a repo first with /cognee-index.",
            ].join("\n"),
            "warning",
          );
          return;
        }
        let codeQuery: Record<string, unknown> | undefined;
        let seed = query;
        const trimmed = query.trim();
        if (trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (parsed && typeof parsed === "object" && typeof parsed.operation === "string") {
              codeQuery = parsed;
              seed = String(parsed.name ?? parsed.start ?? parsed.source ?? parsed.operation);
            }
          } catch {
            report(ctx, "That looks like operation JSON but does not parse — check the quoting.", "error");
            return;
          }
        }
        const resolved = await resolveCodeDataset(dataset, undefined);
        if ("error" in resolved) {
          report(ctx, resolved.error, "warning");
          return;
        }
        const result = await client.codeSearch({ seed, codeQuery, dataset: resolved.dataset, topK });
        if (!result.ok) {
          report(ctx, `Code query failed: ${result.error?.message ?? "unknown error"}`, "error");
          return;
        }
        const body = renderCodeItems(result.items);
        report(
          ctx,
          body ||
            (result.noGraph
              ? `Code dataset '${resolved.dataset}' has no graph yet — indexing may still be running.`
              : `No code facts for '${seed}' — the graph has no such symbol.`),
          body ? "info" : "warning",
        );
      } catch (err) {
        report(ctx, `Code query failed: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("cognee-sync", {
    description: "Promote this session's cache into the permanent cognee graph",
    handler: async (_args, ctx) => {
      try {
        if (!state.sessionId) {
          report(ctx, "No session yet — nothing to sync.", "warning");
          return;
        }
        const result = await client.improve(state.sessionId, state.dataset, cfg.improveSubmitTimeoutMs);
        if (result.outcome === "ok") {
          state.lastAutoImproveAt = Date.now();
          state.lastImprovedCount = state.capturedCount;
          report(ctx, `Session cache promoted into the graph (dataset '${state.dataset}').`);
        } else if (result.outcome === "busy") {
          report(ctx, "The server is already improving this session — nothing to do.", "warning");
        } else if (result.outcome === "unsupported") {
          report(ctx, "This server does not support /api/v1/improve — session not synced.", "warning");
        } else {
          report(ctx, `Sync failed: ${result.error?.message ?? "unknown error"}`, "error");
        }
      } catch (err) {
        report(ctx, `Sync failed: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("cognee-forget", {
    description: "Delete memories: /cognee-forget <dataset> [dataId] | /cognee-forget (list datasets)",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const forced = tokens.includes("--yes");
        const positional = tokens.filter((t) => t !== "--yes");
        if (positional.length === 0) {
          const listed = await client.listDatasets();
          if (!listed.ok) {
            report(ctx, `Could not list datasets: ${listed.error?.message ?? "unknown error"}`, "error");
            return;
          }
          const rows = listed.datasets.map((d) => `  ${d.name}${d.id ? `  (${d.id})` : ""}`);
          report(
            ctx,
            ["Datasets:", ...(rows.length ? rows : "  (none)"), "", "Usage: /cognee-forget <dataset> [dataId] — with no dataId it lists the dataset's data items and lets you pick one (or delete the whole dataset). IRREVERSIBLE."].join("\n"),
          );
          return;
        }
        const [datasetName, dataIdArg] = positional;
        const listed = await client.listDatasets();
        if (!listed.ok) {
          report(ctx, `Could not list datasets: ${listed.error?.message ?? "unknown error"}`, "error");
          return;
        }
        const match = listed.datasets.find((d) => d.name === datasetName || d.id === datasetName);
        if (!match?.id) {
          report(ctx, `Dataset '${datasetName}' not found. Available: ${listed.datasets.map((d) => d.name).join(", ") || "(none)"}`, "error");
          return;
        }
        // Discovery: with no dataId, browse the dataset's stored data items and
        // let the user pick the one to delete (the official 4-step forget flow).
        let dataId = dataIdArg;
        if (!dataId) {
          const items = await client.listDataItems(match.id, 5000);
          if (!items.ok) {
            report(ctx, `Could not list data items for '${match.name}': ${items.error?.message ?? "unknown error"}`, "error");
            return;
          }
          if (items.items.length === 0) {
            report(ctx, `Dataset '${match.name}' has no stored data items — only the empty dataset itself can be deleted.`);
          } else if (ctx.hasUI) {
            const options = [
              ...items.items.slice(0, 20).map((d) => {
                const label = d.name || "(unnamed)";
                const when = d.created_at ? ` · ${d.created_at.slice(0, 10)}` : "";
                return `${d.id} — ${label}${when}`;
              }),
              "▸ delete the ENTIRE dataset",
            ];
            const picked = await ctx.ui.select(`Cognee Forget — data items in '${match.name}'`, options, { timeout: 60000 });
            if (picked === undefined) {
              report(ctx, "Cancelled — nothing deleted.", "warning");
              return;
            }
            if (picked.startsWith("▸")) {
              /* whole-dataset scope — dataId stays undefined */
            } else {
              dataId = picked.split(" — ")[0].trim();
            }
          } else {
            const rows = items.items.map(
              (d) => `  ${d.id} — ${d.name || "(unnamed)"}${d.created_at ? ` (${d.created_at.slice(0, 10)})` : ""}`,
            );
            report(
              ctx,
              [
                `Data items in '${match.name}':`,
                ...rows.slice(0, 30),
                "",
                `Re-run as /cognee-forget ${datasetName} <dataId> to delete one item, or add --yes to delete the ENTIRE dataset.`,
              ].join("\n"),
            );
            return;
          }
        }
        const scope = dataId ? `data item ${dataId}` : `the ENTIRE dataset '${match.name}'`;
        let detail = "";
        if (dataId) {
          // Short content preview in the confirmation so the user sees WHAT is deleted.
          const raw = await client.getDataItemRaw(match.id, dataId, 5000);
          if (raw.ok && raw.text.trim()) {
            const firstLine = raw.text.trim().split(/\r?\n/).find((l) => l.trim()) ?? "";
            detail = `\n\nContent preview: ${truncateText(redactSecrets(firstLine), 160)}`;
          }
        }
        let confirmed = forced;
        if (!confirmed && ctx.hasUI) {
          confirmed = await ctx.ui.confirm("Cognee Forget", `Permanently delete ${scope}? This cannot be undone.${detail}`, { timeout: 30000 });
        }
        if (!confirmed) {
          report(ctx, "Cancelled — nothing deleted.", "warning");
          return;
        }
        const result = await client.forget(match.id, dataId || undefined);
        if (!result.ok) {
          report(ctx, `Forget failed: ${result.error?.message ?? "unknown error"}`, "error");
          return;
        }
        report(ctx, `Deleted ${scope}.`);
      } catch (err) {
        report(ctx, `Forget failed: ${describeError(err)}`, "error");
      }
    },
  });

  /* ================================================================ */
  /* EVENTS                                                             */
  /* ================================================================ */

  pi.on("session_start", (event, ctx): void => {
    try {
      state.stopped = false;
      state.finalSyncDone = false;
      let hostId = "";
      try {
        hostId = ctx.sessionManager.getSessionId() ?? "";
      } catch {
        /* no host session id yet — fall back to a random suffix */
      }
      state.sessionId = sanitizeSessionId(
        cfg.sessionIdOverride ?? `${cfg.sessionPrefix}_${hostId || randomId()}`,
      );
      state.dataset = cfg.dataset;
      state.hasUI = ctx.hasUI;
      state.ui = ctx.ui;
      state.cwd = ctx.cwd || process.cwd();
      state.autoIndexTried = false; // one auto-index attempt per session
      // Background health check — startup is never blocked by the server.
      const timer = setTimeout(() => {
        state.timers.delete(timer);
        void runHealthCheck({ notify: true })
          .catch(() => {})
          .finally(() => scheduleReprobe());
      }, 0);
      state.timers.add(timer);
      void event; // reason unused; every start reason gets the same wiring
    } catch {
      /* fail-soft */
    }
  });

  /** Official outage-header reasons — recall-and-failed must never be silent. */
  function recallSkipReason(err?: CogneeError): string {
    if (err?.status === 401 || err?.status === 403) return "auth failed";
    if ((err?.status ?? 0) >= 500) return "server error";
    if (err?.transient) return "server not responding";
    return "server unreachable"; // unreachable / status 0 / unknown
  }

  function recallSkipped(reason: string): BeforeAgentStartEventResult {
    const buffered = state.writeQueue.length
      ? ` · ${state.writeQueue.length} awaiting replay`
      : "";
    return {
      message: {
        customType: "cognee_memory",
        display: false,
        content: `=== Cognee memory: recall skipped (${reason})${buffered} ===`,
      },
    };
  }

  pi.on("before_agent_start", async (event): Promise<BeforeAgentStartEventResult | void> => {
    try {
      if (!cfg.capture || state.stopped || !state.sessionId) return;
      const prompt = (event.prompt ?? "").trim();
      if (prompt.length < 5 || prompt.startsWith("/")) return;
      state.totalRecallTurns++;
      if (breakerOpen()) return recallSkipped("circuit breaker open");
      if (!state.healthy) {
        // Bounded background re-entry probe; never blocks this turn.
        void runHealthCheck({ notify: false }).catch(() => {});
        return recallSkipped("server unreachable");
      }
      // Code recall lane: armed only when the prompt carries an identifier-shaped
      // token AND the cwd sits in an indexed repo. Runs concurrently with the graph
      // recall (never sequentially) and inside the same recall budget, so the
      // combined latency can never exceed the graph recall's own bound.
      const lane = armCodeLane(prompt);
      const [result, codeResult] = await Promise.all([
        client.recall({
          query: redactSecrets(prompt),
          sessionId: state.sessionId,
          dataset: state.dataset,
          topK: 5,
          searchType: "HYBRID_COMPLETION",
          onlyContext: true,
          scope: ["graph"],
          timeoutMs: cfg.recallTimeoutMs,
        }),
        lane
          ? client.codeSearch({
              seed: lane.identifier,
              codeQuery: lane.codeQuery,
              dataset: lane.dataset,
              topK: 5,
              timeoutMs: Math.min(2000, cfg.recallTimeoutMs),
            })
          : Promise.resolve(null),
      ]);
      const codeSection =
        codeResult && codeResult.ok && codeResult.items.length > 0
          ? renderCodeFacts(codeResult.items, CODE_LANE_MAX_CHARS)
          : "";
      if (!result.ok) {
        recordFailure(result.error);
        if (result.error?.status === 401 || result.error?.status === 403) {
          setStatusSafe(`✕ cognee: auth failed (${cfg.backend} · ${state.dataset})`);
        } else if (result.error && !result.error.transient && result.error.status !== 0) {
          state.healthy = false;
          setStatusSafe(`✕ cognee: server error (${cfg.backend} · ${state.dataset})`);
        }
        const skipped = recallSkipped(recallSkipReason(result.error)); // turn proceeds normally
        if (codeSection && skipped.message && typeof skipped.message.content === "string") {
          skipped.message.content += `\n\n${codeSection}`;
        }
        return skipped;
      }
      recordSuccess();
      if (result.noGraph && !codeSection) return; // authoritative empty — nothing built yet
      if (result.items.length > 0 || codeSection) {
        if (result.items.length > 0) state.turnsWithHits++;
        const statsLine = `Cognee memory: ${result.items.length} memory hits · ${state.turnsWithHits}/${state.totalRecallTurns} turns had hits this session`;
        const block = renderContextBlock(result.items, cfg.contextMaxChars, statsLine);
        const content = [block, codeSection].filter(Boolean).join("\n\n");
        if (content) {
          return { message: { customType: "cognee_memory", content, display: false } };
        }
      }
    } catch {
      /* never break the turn */
    }
  });

  pi.on("message_end", (event): void => {
    try {
      if (!cfg.capture || state.stopped) return;
      const message = event.message as { role?: string; content?: unknown };
      if (message.role === "user") {
        const text = extractText(message.content).trim();
        if (text.length >= 5 && !text.startsWith("/")) {
          // Skip huge payloads; redact secrets before truncation (policy order per the brief).
          if (Buffer.byteLength(text, "utf8") <= LIMITS.promptBytes * 4) {
            state.pendingQuestion = truncateText(redactSecrets(text), LIMITS.promptBytes);
          } else {
            state.pendingQuestion = null;
          }
        }
      } else if (message.role === "assistant") {
        const text = extractText(message.content).trim();
        if (text) {
          state.pendingAnswer = truncateText(redactSecrets(text), LIMITS.assistantBytes);
        }
      }
    } catch {
      /* fail-soft */
    }
  });

  pi.on("agent_settled", (): void => {
    try {
      const question = state.pendingQuestion;
      const answer = state.pendingAnswer;
      state.pendingQuestion = null;
      state.pendingAnswer = null;
      if (cfg.capture && !state.stopped && state.sessionId && (question || answer)) {
        queueQa({
          type: "qa",
          question: question ?? "",
          answer: answer ?? "",
          context: `pi · dataset ${state.dataset}`,
        });
      }
      maybeAutoImprove();
      // Code-graph freshness: a turn may have changed the working tree — check
      // (debounced, off the turn's critical path) and re-index in the background.
      scheduleChangeCheck();
    } catch {
      /* fail-soft */
    }
  });

  /* ----- Pre-compact memory anchor (mirror of pre-compact.py) ----- */

  /** Keyword-dense query from recent turns (same shape as _extract_query_words). */
  function anchorQueryWords(recentText: string, maxWords = 20): string {
    const words: string[] = [];
    for (const match of recentText.toLowerCase().matchAll(/\b\w+\b/g)) {
      if (match[0].length >= 3) {
        words.push(match[0]);
        if (words.length >= maxWords) break;
      }
    }
    return words.join(" ");
  }

  /** `- Q:/A: <300 chars>` lines — the fallback section pre-compact.py stores. */
  function anchorSessionSection(turns: { question: string; answer: string }[]): string {
    const lines: string[] = [];
    for (const turn of turns.slice(-5)) {
      for (const [prefix, text] of [
        ["Q:", turn.question],
        ["A:", turn.answer],
      ] as const) {
        if (!text.trim()) continue;
        lines.push(`- ${prefix} ${truncateText(text.trim(), ANCHOR_TURN_CHARS)}`);
      }
    }
    return lines.length ? ["### Session Memory (recent turns)", ...lines].join("\n") : "";
  }

  /**
   * Build and store the compaction anchor. Scoping mirrors pre-compact.py: one
   * graph recall (top_k=3, HYBRID_COMPLETION, only_context, scoped to this
   * session + dataset) seeded by a keyword query built from the transcript
   * being compacted; when memory has nothing, the raw recent turns stand in.
   * The anchor is stored as a QA entry in the SESSION CACHE tier (via the same
   * bounded write queue), so post-compact auto-recall — which is session-scoped —
   * keeps continuity. Detached and fail-soft: compaction is never blocked.
   */
  async function storeCompactAnchor(messages: { role?: string; content?: unknown }[]): Promise<void> {
    try {
      if (!cfg.capture || state.stopped || !state.sessionId) return;
      // What the transcript held: the user/assistant text about to be summarized away.
      const recent: { question: string; answer: string }[] = [];
      for (const message of messages.slice(-12)) {
        const text = extractText(message.content).trim();
        if (!text || text.startsWith("/")) continue;
        if (message.role === "user") recent.push({ question: truncateText(redactSecrets(text), LIMITS.promptBytes), answer: "" });
        else if (message.role === "assistant" && recent.length) {
          const last = recent[recent.length - 1];
          last.answer = truncateText(redactSecrets(text), LIMITS.assistantBytes);
        }
      }
      const seedText = recent
        .slice(-3)
        .map((t) => `${t.question} ${t.answer}`)
        .join(" ");

      const sections: string[] = [];
      if (seedText && state.healthy && !breakerOpen()) {
        // Primary section, verbatim like the reference (top_k bounds it server-side).
        const recalled = await client.recall({
          query: anchorQueryWords(seedText),
          sessionId: state.sessionId,
          dataset: state.dataset,
          topK: 3,
          searchType: "HYBRID_COMPLETION",
          onlyContext: true,
          scope: ["graph"],
          timeoutMs: cfg.recallTimeoutMs,
        });
        if (recalled.ok) {
          const memoryLines = recalled.items
            .map((item) => String(item.text ?? item.content ?? "").trim())
            .filter(Boolean);
          if (memoryLines.length) sections.push(["### Cognee Memory", ...memoryLines].join("\n"));
        }
      }
      if (!sections.length) {
        // Memory has nothing yet — the recent turns themselves keep the anchor useful.
        const fallback = anchorSessionSection(recent);
        if (fallback) sections.push(fallback);
      }
      if (!sections.length) return; // precompact_empty — nothing to preserve

      const anchor = truncateText(
        "## Cognee Memory Anchor\n" +
          "Preserved context from Cognee memory (session history, knowledge graph, guidance):\n\n" +
          sections.join("\n\n"),
        ANCHOR_MAX_CHARS,
      );
      queueQa({
        type: "qa",
        question: "Context compaction anchor — what the compacted transcript held",
        answer: anchor,
        context: `pi · compaction anchor · dataset ${state.dataset}`,
      });
    } catch {
      /* fail-soft — a compaction is never disturbed */
    }
  }

  pi.on("session_before_compact", (event): void => {
    // Background-safe: detach immediately; compaction proceeds regardless.
    try {
      const messages =
        (event.preparation?.messagesToSummarize as { role?: string; content?: unknown }[] | undefined) ?? [];
      void storeCompactAnchor(messages).catch(() => {});
    } catch {
      /* fail-soft */
    }
  });

  pi.on("session_shutdown", async (): Promise<void> => {
    // Idempotent: quit, reload, session replacement and exit all converge here.
    stopWatchers();
    await finalSync();
  });
}
