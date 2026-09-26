/**
 * pi-cognee — Cognee persistent memory for the pi coding agent.
 *
 * Native TypeScript extension (no MCP, no extra npm deps, Node 18+ global fetch).
 * Resilience contract: the extension must never break or slow down pi when the
 * cognee server is missing, slow, or erroring — every network path is bounded by
 * a short timeout, wrapped in fail-soft try/catch, and gated by a circuit breaker.
 */

import { readFileSync } from "node:fs";
import {
	dirname as pathDirname,
	join as pathJoin,
	resolve as pathResolve,
} from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	bootstrapPaths,
	cogneeEnvLookup,
	ensureLocalServerRunning,
	findUv,
	logBootstrapEvent,
	PINNED_COGNEE_VERSION,
	serverPidfileStatus,
	serverPort,
	serverPresence,
	venvCogneeVersion,
} from "./bootstrap";
import {
	appendBridge,
	bridgeBackoffOpen,
	entryFingerprint,
	loadBridge,
	markBridgeHeadAmbiguous,
	oldestPendingBridgeHead,
	recordBridgeFailure,
	resetBridgeFailures,
	type SpilledEntry,
	serverFingerprints,
	sweepOldBridgeFiles,
	trimBridgeHead,
	writeOutcomeAmbiguous,
} from "./bridge";
import { CogneeClient } from "./client";
import {
	clearAgentKeyRecord,
	saveAgentKeyRecord,
} from "./state/agent_key";
import type { QaEntry, RecallItem, TraceEntry } from "./client/types";
import { loadCogneeConfig } from "./config";
import {
	loadActiveDatasetRecord,
	saveActiveDatasetRecord,
	type ActiveDatasetRecord,
} from "./state/active_dataset";
import type { CogneeConfig } from "./config/types";
import { DEFAULT_CAPTURE_TOOLS } from "./constants";
import {
	activeDatasetPath,
	isLoopbackUrl,
	isUuid,
	logPluginEvent,
	matchDatasets,
	mintSwitchSessionId,
	piStateDir,
	principalFingerprint,
	sanitizeDatasetName,
	sanitizeSessionId,
} from "./helpers";
import {
	buildCodeQuery,
	codeDatasetName,
	extractIdentifiers,
} from "./helpers/code_graph";
import {
	CogneeError,
	describeError,
	wrapAsCogneeError,
} from "./helpers/errors";
import {
	canonicalRepoSpec,
	countSourceFiles,
	findIndexedRepo,
	gitFingerprint,
	gitRepoRoot,
	isRemoteRepoSpec,
	loadRepoStates,
	saveRepoState,
} from "./helpers/git";
import {
	REMEMBER_FILE_MAX_BYTES,
	readRememberFile,
} from "./helpers/remember_file";
import {
	loadSharedBreaker,
	saveSharedBreaker,
	sharedBreakerPath,
} from "./helpers/shared_breaker";
import { loadSharedMemoryMarker } from "./state/shared_memory";
import {
	buildTraceEntry,
	extractText,
	redactSecrets,
	truncateText,
} from "./helpers/tracing";
import type { CodeRepoState, HealthResult } from "./helpers/types";
import {
	bumpStoredCounter,
	improveThrottleReason,
	readImproveState,
	readStoredCounter,
	recordImproveFailure,
	recordImproveSuccess,
} from "./state/improve_state";
import {
	AGENT_ROLE_NAME,
	PROVISIONING_PLUGIN_VERSION,
	type SharedMemoryOutcome,
	STRUCTURAL_SHARED_MEMORY_FAILURES,
} from "./contract";

/** A captured QA entry BOUND to the session+dataset it was captured under.
 *  Binding happens at capture time so a later dataset switch can never
 *  mis-attribute buffered writes into the new dataset (the reference binds
 *  pending entries to the retired triple the same way). The binding is
 *  plugin-internal — it is stripped before the wire payload is built. */
type BoundQaEntry = QaEntry & { sessionId: string; dataset: string };

/** A captured tool-call trace entry with the same capture-time binding. */
type BoundTraceEntry = TraceEntry & { sessionId: string; dataset: string };

/** Any queued entry as seen by the drain: bound + the bridge's replay meta. */
type PendingEntry = (BoundQaEntry | BoundTraceEntry) & {
  _replay_ambiguous?: true;
  _buffered_at?: number;
};

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

/* Statusline (v0.4 resilience spec §2.1) — plain text, no ANSI (pi's footer
 * renders plain; glyphs carry the semantics — documented divergence). */
/** Soft visible-char cap; segments drop in reverse priority order before any mid-segment cut. */
const STATUSLINE_MAX_CHARS = 120;
/** Credits marker freshness horizons (reference parity: 7 d max, 15 m age hint). */
const CREDITS_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CREDITS_AGE_HINT_SECONDS = 15 * 60;
/** Low-balance threshold that appends the top-up hint (reference _CREDITS_LOW_USD). */
const CREDITS_LOW_USD = 1.0;
const DEFAULT_BILLING_URL = "https://platform.cognee.ai/billing";

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

/**
 * True when a code item carries data: non-envelope text, or an envelope with a
 * non-empty result array (mirrors test/live.mjs codeHasData). The server does
 * NOT return "no results" for an unresolvable code seed — it returns ONE entry
 * whose text IS the raw envelope ("{\"operation\": \"query_facts\", \"facts\": [], …}").
 * The reference dodges this only via its server-contract assumption; on this
 * server version the empty envelope must be filtered out before counting hits,
 * or the lane injects `{"facts":[],"total":0}` as if it were a fact.
 */
export function codeItemHasData(item: RecallItem): boolean {
  const text = String(item.text ?? item.content ?? "").trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "operation" in parsed) {
      return Object.values(parsed).some((v) => Array.isArray(v) && v.length > 0);
    }
    return true;
  } catch {
    return true; // non-JSON prose hit
  }
}

/**
 * List rendering for /cognee-datasets — mirrors the reference picker format:
 * `Current dataset: X (session Y)` header, one row per readable dataset with the
 * active one starred (` * name (id8…)`), plus the reference's guidance that a
 * one-off LOOK in another dataset needs no switch (per-call dataset overrides).
 * `extraLines` carries the writability notes the reference prints verbatim:
 * `(N read-only dataset(s) not shown)` / `(write access could not be
 * verified — showing every readable dataset)` (v0.4, spec §3.6).
 */
export function renderDatasetList(
  currentDataset: string,
  sessionId: string,
  datasets: { name: string; id: string }[],
  extraLines: string[] = [],
): string {
  const rows = datasets.length
    ? datasets.map((d) => {
        const id8 = d.id ? ` (${d.id.slice(0, 8)}…)` : "";
        return `${d.name === currentDataset ? " * " : "   "}${d.name}${id8}`;
      })
    : ["   (no readable datasets)"];
  return [
    `Current dataset: ${currentDataset} (session ${sessionId || "(not started)"})`,
    ...rows,
    ...extraLines,
    "",
    "Switch: /cognee-datasets <name> — syncs the current session, mints a new session id,",
    "and re-points capture/recall/sync (unlisted names are created on switch; --force",
    "skips a failed pre-switch sync). Recall is scoped to the active dataset — context",
    "from the previous one is no longer injected until you switch back.",
    "One-off look in another dataset (no switch): /cognee-search <query> --dataset <name>.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Extension factory                                                   */
/* ------------------------------------------------------------------ */

export default function cogneeExtension(pi: ExtensionAPI): void {
  const cfg: CogneeConfig = loadCogneeConfig();
  const client = new CogneeClient(cfg);

  /* Shared-memory addressing seed (v0.4): the persisted record's UUIDs win
   * (a dataset match is implied — the record's dataset IS cfg.dataset), else
   * the live marker's canonical map (the reference's launch-record →
   * marker-canonical precedence, dataset_id_for). Empty → name addressing. */
  const initialMarker = loadSharedMemoryMarker(cfg.baseUrl);
  const initialCanonicalId =
    cfg.sharedAgentMemory && initialMarker.mode === "shared"
      ? initialMarker.canonical?.[cfg.dataset] ?? ""
      : "";
  const initialSharedDatasetId = cfg.sharedDatasetId || initialCanonicalId;
  const initialSharedDatasetIds = cfg.sharedDatasetIds?.length
    ? cfg.sharedDatasetIds
    : initialSharedDatasetId
      ? [initialSharedDatasetId]
      : [];

  /** Suffix for graph-read tool descriptions when federated reads are configured
   *  (the reference teaches the model about the widened read set only when set). */
  const federatedReadNote = cfg.readDatasetIds?.length
    ? ` Federated reads are configured (COGNEE_PLUGIN_READ_DATASET_IDS): graph recall searches ` +
      `${cfg.readDatasetIds.length} dataset${cfg.readDatasetIds.length === 1 ? "" : "s"} by UUID — ` +
      "read-only federation; an explicit dataset argument cannot narrow it; writes and session " +
      "memory stay on the session dataset."
    : "";

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
    /* switch provenance — set from the persisted record, updated on a live switch */
    datasetSource: cfg.datasetSource,
    datasetSwitchedFrom: cfg.datasetSwitchedFrom ?? null,
    datasetSwitchedAt: cfg.datasetSwitchedAt ?? null,
    pendingQuestion: null as string | null,
    pendingAnswer: null as string | null,
    writeQueue: [] as (BoundQaEntry | BoundTraceEntry)[],
    draining: false,
    /* connection verdict for the statusline glyph slot (single left slot,
     * reference precedence: connection failure > llm-key > server signal) */
    connState: "unknown" as "unknown" | "ok" | "offline" | "auth" | "server-error",
    /* last recall turn's hit counts (statusline recall segment, spec §2.1) */
    lastRecallHits: 0,
    lastGraphHits: 0,
    lastCodeHits: 0,
    /* idle bridge (spec §2.2): the single arm timer + its one re-arm */
    idleTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    /* per-target improve re-entry guard (server busy-locks per session) */
    improvesInFlight: new Set<string>(),
    /* verify-before-replay consumptions (surfaced by /cognee) */
    dedupedCount: 0,
    /* re-entry guard for the dataset-switch command (in-process analog of the reference .switch.lock) */
    switching: false,
    /* sessions retired by a --force switch past a failed sync: finalSync promotes them too */
    retiredSessions: [] as { sessionId: string; dataset: string }[],
    capturedCount: 0,
    droppedCount: 0,
    lastImprovedCount: 0,
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
    /* local server bootstrap (v0.4) — once per pi process */
    bootstrapStarted: false,
    bootstrapStatus: "idle" as "idle" | "running" | "done" | "failed",
    bootstrapError: undefined as string | undefined,
    /* shared-agent-memory provisioning (v0.4) — once per session, after health */
    provisioningDone: false,
    sharedDatasetId: initialSharedDatasetId,
    sharedDatasetIds: initialSharedDatasetIds,
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

  /* ----- Rich statusline (v0.4 resilience spec §2.1) -----
   *
   * One plain-text line (no ANSI — pi's footer renders plain, glyphs carry the
   * semantics; documented divergence from the reference's bold/color policy):
   *
   *   <glyph>cognee: <backend> · <dataset>[ · N awaiting replay][ · N memory
   *   hits[ · X/Y turns had hits this session]][ · credits: …]
   *
   * Reads ONLY in-memory state + the one shared credits marker; never throws;
   * refreshed at the spec's points (health completion, recall, drain tick,
   * improve settle, dataset switch) — no timers. */

  /** Statusline opt-out probe (reference env names): false|0|no|off hides. */
  function statuslineEnvOff(name: string): boolean {
    const raw = (process.env[name] ?? "").trim().toLowerCase();
    return raw !== "" && ["false", "0", "no", "off"].includes(raw);
  }

  function statuslineCountsFull(): boolean {
    return (process.env.COGNEE_STATUSLINE_COUNTS ?? "").trim().toLowerCase() === "full";
  }

  /** The shared credits marker written by the Claude Code/Codex plugin (pi
   *  never writes it — render-only, spec §2.1). Honors an explicit
   *  COGNEE_CREDITS_FILE; otherwise sits beside piStateDir()'s parent like the
   *  reference layout (~/.cognee-plugin/claude-code/credits.json). */
  function creditsFilePath(): string {
    return (
      process.env.COGNEE_CREDITS_FILE ||
      pathJoin(pathDirname(piStateDir()), "claude-code", "credits.json")
    );
  }

  interface CreditsView {
    remainingUsd: number;
    ageSeconds: number;
    lastOpLabel?: string;
    lastOpCost?: number;
  }

  /** Render-only read of the shared credits map (gating: cloud mode, matching
   *  base_url, numeric balance, age ≤ 7 d). Never throws. */
  function readCreditsView(): CreditsView | undefined {
    try {
      if (cfg.backend !== "cloud") return undefined;
      if (statuslineEnvOff("COGNEE_STATUSLINE_CREDITS")) return undefined;
      const raw = JSON.parse(readFileSync(creditsFilePath(), "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      for (const entry of Object.values(raw)) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const baseUrl = typeof e.base_url === "string" ? e.base_url.replace(/\/+$/, "") : "";
        if (baseUrl !== cfg.baseUrl) continue;
        const remaining = Number(e.remaining_usd);
        const checkedAtRaw = Number(e.checked_at);
        if (!Number.isFinite(remaining) || !Number.isFinite(checkedAtRaw)) continue;
        // The reference markers carry epoch SECONDS (verified against live
        // conn-state/improve-state files); tolerate either unit.
        const checkedAt = checkedAtRaw < 1e11 ? checkedAtRaw * 1000 : checkedAtRaw;
        const ageSeconds = Math.max(0, (Date.now() - checkedAt) / 1000);
        if (ageSeconds > CREDITS_MAX_AGE_SECONDS) continue;
        const lastOp =
          e.last_op && typeof e.last_op === "object" ? (e.last_op as Record<string, unknown>) : undefined;
        return {
          remainingUsd: remaining,
          ageSeconds,
          lastOpLabel: typeof lastOp?.label === "string" && lastOp.label ? lastOp.label : undefined,
          lastOpCost: Number.isFinite(Number(lastOp?.cost_usd)) ? Number(lastOp?.cost_usd) : undefined,
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  function creditsAgeHint(ageSeconds: number): string {
    if (ageSeconds < 60) return "0m ago";
    if (ageSeconds < 3600) return `${Math.max(1, Math.round(ageSeconds / 60))}m ago`;
    if (ageSeconds < 24 * 3600) return `${Math.round(ageSeconds / 3600)}h ago`;
    return `${Math.round(ageSeconds / (24 * 3600))}d ago`;
  }

  /** Compose the full statusline from state (+ the credits marker). Never throws. */
  function composeStatusline(): string {
    try {
      const base = `${cfg.backend} · ${state.dataset}`;
      let head: string;
      if (state.connState === "ok") {
        // Reference precedence note: the static llm-key verdict sits BELOW a
        // connection failure but ABOVE the ready signal (§1.1 glyph slot).
        head =
          cfg.backend === "local" && !cfg.llmApiKeyConfigured
            ? `✕ cognee: llm key not set (${base})`
            : `● cognee: ${base}`;
      } else if (state.connState === "offline") {
        head = `✕ cognee: offline (${base})`;
      } else if (state.connState === "auth") {
        head = `✕ cognee: auth failed (${base})`;
      } else if (state.connState === "server-error") {
        head = `✕ cognee: server error (${base})`;
      } else {
        head = `cognee: ${base}`; // unknown — no glyph yet (reference: no marker, no glyph)
      }

      // Segments; each entry carries whether it may be dropped at the width cap.
      const segments: { text: string; drop: boolean }[] = [];
      const pending = pendingWriteCount();
      if (pending > 0) segments.push({ text: `${pending} awaiting replay`, drop: false });
      if (!statuslineEnvOff("COGNEE_STATUSLINE_COUNTS")) {
        if (statuslineCountsFull()) {
          if (state.totalRecallTurns > 0) {
            segments.push({ text: `recall ${state.lastGraphHits}g/${state.lastCodeHits}c`, drop: true });
          }
        } else if (state.totalRecallTurns > 0) {
          segments.push({ text: `${state.lastRecallHits} memory hits`, drop: false });
          if (state.turnsWithHits === 0) {
            segments.push({ text: `memory warming up (${state.totalRecallTurns} turns)`, drop: true });
          } else {
            segments.push({
              text: `${state.turnsWithHits}/${state.totalRecallTurns} turns had hits this session`,
              drop: true,
            });
          }
        }
      }
      // Credits pieces are assembled separately so the width cap can shed them
      // in the spec's order: age hint → last-op → whole segment.
      const credits = readCreditsView();
      const creditsBits = { base: "", age: "", lastOp: "", topUp: "" };
      if (credits) {
        creditsBits.base = `credits: $${credits.remainingUsd.toFixed(2)}`;
        if (credits.ageSeconds > CREDITS_AGE_HINT_SECONDS) {
          creditsBits.age = ` (${creditsAgeHint(credits.ageSeconds)})`;
        }
        if (credits.lastOpLabel && credits.lastOpCost !== undefined) {
          creditsBits.lastOp = ` · last ${credits.lastOpLabel} ~$${credits.lastOpCost.toFixed(2)}`;
        }
        if (credits.remainingUsd <= CREDITS_LOW_USD) {
          creditsBits.topUp = ` · top up: ${process.env.COGNEE_BILLING_URL || DEFAULT_BILLING_URL}`;
        }
      }

      const assemble = (): string =>
        head +
        segments.filter((s) => s.text).map((s) => ` · ${s.text}`).join("") +
        (creditsBits.base
          ? ` · ${creditsBits.base}${creditsBits.age}${creditsBits.lastOp}${creditsBits.topUp}`
          : "");
      // Soft cap 120 visible chars — shed pieces in the spec's reverse priority
      // order (age hint → last op → credits → cumulative turns → per-turn hits)
      // before ever truncating mid-segment.
      const cumulativeIdx = segments.findIndex((s) => s.drop && /turns|warming/.test(s.text));
      const perTurnIdx = segments.findIndex((s) => s.text.endsWith("memory hits"));
      const removals: Array<() => void> = [
        () => (creditsBits.age = ""),
        () => (creditsBits.lastOp = ""),
        () => ((creditsBits.base = ""), (creditsBits.age = ""), (creditsBits.lastOp = ""), (creditsBits.topUp = "")),
      ];
      if (cumulativeIdx >= 0) removals.push(() => (segments[cumulativeIdx].text = ""));
      if (perTurnIdx >= 0) removals.push(() => (segments[perTurnIdx].text = ""));
      let line = assemble();
      for (const removal of removals) {
        if (line.length <= STATUSLINE_MAX_CHARS) break;
        removal();
        line = assemble();
      }
      return line.length > STATUSLINE_MAX_CHARS ? line.slice(0, STATUSLINE_MAX_CHARS) : line;
    } catch {
      return `cognee: ${cfg.backend} · ${state.dataset}`; // never throw from a render path
    }
  }

  function renderStatusline(): void {
    setStatusSafe(composeStatusline());
  }

  /** Durable pending-write count (memory queue + the session's spill file). */
  function pendingWriteCount(): number {
    try {
      return state.writeQueue.length + loadBridge(state.sessionId).length;
    } catch {
      return state.writeQueue.length;
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

  /** Shared-venv cognee version for the doctor's Local runtime row ("" → not built). */
  async function localRuntimeVersion(): Promise<string> {
    try {
      return (await venvCogneeVersion(bootstrapPaths().venvPython, 5000)) || "not built";
    } catch {
      return "unavailable";
    }
  }

  /** Switch provenance for the /cognee Dataset line: `agent_sessions (switched from X at HH:MM)`. */
  function datasetSwitchSuffix(): string {
    if (!state.datasetSwitchedFrom || state.datasetSwitchedFrom === state.dataset) return "";
    const when = state.datasetSwitchedAt ? new Date(state.datasetSwitchedAt) : undefined;
    const whenText = when && !Number.isNaN(when.getTime()) ? ` at ${when.toLocaleTimeString()}` : "";
    return ` (switched from ${state.datasetSwitchedFrom}${whenText})`;
  }

  /** Dataset source label for /cognee-doctor: default | COGNEE_PLUGIN_DATASET | persisted switch. */
  function datasetSourceLabel(): string {
    switch (state.datasetSource) {
      case "persisted switch":
        return `persisted switch (wins over the COGNEE_PLUGIN_DATASET seed until you switch back; record: ${activeDatasetPath()})`;
      case "COGNEE_PLUGIN_DATASET":
        return "custom via COGNEE_PLUGIN_DATASET";
      default:
        return "default, shared with the Claude Code/Codex plugins";
    }
  }

  /** Federation state for /cognee and /cognee-doctor: count + source, or the exact
   *  validation error (config warning surfaced at load — never a crash). */
  function federationStatusLine(): string {
    try {
      if (cfg.readDatasetIdsError) {
        return `✕ ${cfg.readDatasetIdsError} — federation off, graph reads stay on '${state.dataset}'`;
      }
      const ids = cfg.readDatasetIds ?? [];
      return ids.length
        ? `${ids.length} read dataset${ids.length === 1 ? "" : "s"} via COGNEE_PLUGIN_READ_DATASET_IDS (${cfg.readDatasetIdsSource}) — graph reads only; writes stay on '${state.dataset}'`
        : "off (set COGNEE_PLUGIN_READ_DATASET_IDS to federate graph recall)";
    } catch {
      return "unavailable";
    }
  }

  /** Capture-policy summary for /cognee-doctor (v0.4 traces): tool allowlist,
   *  deny extras, redaction state, custom patterns — plus the exact parse
   *  errors for any malformed COGNEE_CAPTURE_* value (never fatal). */
  function capturePolicySummary(): string {
    try {
      const isDefaultToolSet =
        cfg.captureTools.length === DEFAULT_CAPTURE_TOOLS.length &&
        DEFAULT_CAPTURE_TOOLS.every((t, i) => t === cfg.captureTools[i]);
      const warn: string[] = [];
      if (cfg.captureToolsError) warn.push(`✕ ${cfg.captureToolsError} — using the default tool set`);
      if (cfg.captureDenyPathsError) warn.push(`✕ ${cfg.captureDenyPathsError} — extra deny patterns ignored`);
      if (cfg.captureRedactPatternsError) warn.push(`✕ ${cfg.captureRedactPatternsError} — custom redaction patterns ignored`);
      if (cfg.captureRedactPatternsSkipped?.length) {
        warn.push(
          `✕ skipped invalid regex${cfg.captureRedactPatternsSkipped.length === 1 ? "" : "es"}: ${cfg.captureRedactPatternsSkipped.join(", ")}`,
        );
      }
      const line =
        `traces: ${cfg.captureTools.length} tool pattern${cfg.captureTools.length === 1 ? "" : "s"}${isDefaultToolSet ? " (default set)" : ""}` +
        ` · deny extras: ${cfg.captureDenyPaths.length}` +
        ` · redact ${cfg.captureRedact ? "on" : "off (COGNEE_CAPTURE_REDACT=false)"}` +
        ` · custom patterns: ${cfg.captureRedactPatterns.length}`;
      const pad = " ".repeat(15); // align under the row label
      return warn.length ? `${line}\n${pad}${warn.join(`\n${pad}`)}` : line;
    } catch {
      return "unavailable";
    }
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

  /* ----- Local server bootstrap (v0.4) -----
   *
   * Fires at most once per pi process, only from async trigger points (never
   * the factory, never a tool's synchronous path): T1 = session_start's
   * background timer, T2 = runHealthCheck reporting unreachable (which the
   * 60s re-probe loop keeps hitting while unhealthy). A quick presence probe
   * (~2.5s budget) decides: ready/busy → nothing (the normal health path
   * covers ready; a busy server must never be booted over), absent/unknown →
   * the bootstrap task runs un-awaited. All internal gates re-apply inside
   * ensureLocalServerRunning (adopt-first, presence licensing, boot lock). */

  function bootstrapStateSuffix(): string {
    if (state.bootstrapStatus === "idle") return "";
    const err = state.bootstrapError ? ` — ${truncateText(state.bootstrapError.split("\n")[0], 160)}` : "";
    return ` · bootstrap: ${state.bootstrapStatus}${err}`;
  }

  async function maybeBootstrap(): Promise<void> {
    try {
      if (!cfg.localBootstrap) return; // COGNEE_LOCAL_BOOTSTRAP=off → v0.3 behavior
      // Forced-cloud-missing-URL never boots (parity with session-start.py:2003-2007).
      if (cfg.backend !== "local" || cfg.missingBaseUrl || !isLoopbackUrl(cfg.baseUrl)) return;
      if (state.bootstrapStarted) return; // once per pi process — synchronous guard
      state.bootstrapStarted = true;
      const presence = await serverPresence(cfg.baseUrl, { confirmAbsent: false });
      if (presence.verdict === "ready" || presence.verdict === "busy") {
        logBootstrapEvent({ event: "bootstrap_skipped_server_present", verdict: presence.verdict });
        return;
      }
      await runBootstrapTask();
    } catch (err) {
      state.bootstrapStatus = "failed";
      state.bootstrapError = describeError(err);
    }
  }

  async function runBootstrapTask(): Promise<void> {
    state.bootstrapStatus = "running";
    setStatusSafe(`◐ cognee: starting (local · ${state.dataset})`);
    notifySafe(
      "Cognee local server starting — first run may take a few minutes (uv venv + install). " +
        "Prompts work normally; memory activates when it's up.",
      "info",
    );
    try {
      const result = await ensureLocalServerRunning(cfg.baseUrl, cogneeEnvLookup(), {
        healthTimeoutMs: cfg.serverBootDeadlineS * 1000,
      });
      state.bootstrapStatus = result.ok ? "done" : "failed";
      state.bootstrapError = result.ok ? undefined : result.error;
    } catch (err) {
      state.bootstrapStatus = "failed";
      state.bootstrapError = describeError(err);
    } finally {
      // The existing health path takes it from here: ●/✕ status, owner-key mint,
      // dataset ensure, write-queue drain (the guard makes this re-entry a no-op).
      void runHealthCheck({ notify: true }).catch(() => {});
    }
  }

  /* ----- Shared-agent-memory provisioning flow (v0.4, spec §3.4) -----
   *
   * Fires once per session AFTER the background health check resolves
   * (never the factory, never a tool's synchronous path), bounded by a ≤10 s
   * budget, entirely fail-soft: capability probe → ensurePluginIdentity (mode
   * matrix of §1.2, structural-reason memo keyed on the plugin version) →
   * ensureSharedMemory(dataset) → on `shared`, pin the canonical UUIDs into
   * the in-memory lanes and the persisted active-dataset record; on
   * `separated`, pin empty ids. Rollback paths of §1.6 (revert-after-provision,
   * rejected key) implemented with the same log events. */

  /** The canonical UUID to WRITE a dataset name under (reference dataset_id_for):
   *  the in-memory shared state when it names the active dataset, else the live
   *  marker's canonical map (only while shared memory is live — after an opt-out
   *  the plugin writes name-addressed). "" → address by name. */
  function datasetIdFor(name: string): string {
    if (!name) return "";
    if (name === state.dataset && state.sharedDatasetId) return state.sharedDatasetId;
    if (!cfg.sharedAgentMemory) return "";
    const marker = loadSharedMemoryMarker(cfg.baseUrl);
    if (marker.mode !== "shared") return "";
    return marker.canonical?.[name] ?? "";
  }

  /** The shared-memory recall read set for the session dataset (precedence #2
   *  after env federation — the client handles the ordering). */
  function sharedReadIds(): string[] | undefined {
    return state.sharedDatasetIds.length ? state.sharedDatasetIds : undefined;
  }

  function applySharedOutcome(shared: SharedMemoryOutcome): void {
    if (shared.mode === "shared" && shared.dataset_id) {
      state.sharedDatasetId = shared.dataset_id;
      state.sharedDatasetIds = shared.dataset_ids.length ? shared.dataset_ids : [shared.dataset_id];
      persistSharedIdsIntoRecord();
    } else {
      state.sharedDatasetId = "";
      state.sharedDatasetIds = [];
    }
  }

  /** Merge the resolved UUIDs into the persisted active-dataset record when one
   *  exists and still names this dataset (the reference serializes against the
   *  switch lock and pins by dataset name — our in-process analog). Fail-soft. */
  function persistSharedIdsIntoRecord(): void {
    try {
      if (state.switching) return;
      const fp = client.keyFingerprint();
      const record = loadActiveDatasetRecord(cfg.baseUrl, fp);
      if (!record || record.dataset !== state.dataset) return;
      const ids = state.sharedDatasetIds;
      if (record.dataset_id === state.sharedDatasetId && sameIds(record.dataset_ids, ids)) return;
      saveActiveDatasetRecord({ ...record, dataset_id: state.sharedDatasetId, dataset_ids: ids });
    } catch {
      /* fail-soft */
    }
  }

  function sameIds(a: string[] | undefined, b: string[]): boolean {
    return (a ?? []).length === b.length && (a ?? []).every((v, i) => v === b[i]);
  }

  async function runProvisioningFlow(): Promise<void> {
    try {
      if (state.provisioningDone || state.stopped || !state.healthy || cfg.missingBaseUrl) return;
      state.provisioningDone = true;
      const deadline = Date.now() + 10_000;
      const remaining = () => Math.max(1000, Math.min(10_000, deadline - Date.now()));
      await client.ensureAuth().catch(() => {});
      const principal = client.principalKey();
      if (!principal) return; // no principal → no provisioning, no wiring (§1.2)
      // Re-read the identity cache like the reference does under its lock at
      // session start: another process may have provisioned since construction.
      client.refreshAgentIdentity();
      const strict = cfg.pluginIdentity === "enabled";

      // A cached key that passes its checks ALWAYS wins — provisioning again
      // would rotate it out from under every other machine of this user.
      let agentKey = client.activeAgentKey;
      let provisionedNow = false;
      if (!agentKey) {
        const problemKind = client.identityProblemKind;
        if (problemKind === "blocked" || problemKind === "principal_mismatch") {
          // A rejected or foreign cached identity is never used — and never
          // re-provisioned past (create-only refuses an existing agent;
          // rotating would revoke another machine's key). Strict → one-line
          // warning; auto → skip + log (the launch runs as the principal).
          if (strict) {
            notifySafe(`Cognee plugin identity: ${client.identityProblem}`, "warning");
          } else {
            logPluginEvent({ event: "plugin_identity_skipped", reason: problemKind });
          }
          return;
        }
        if (!strict) {
          if (!cfg.sharedAgentMemory) return; // identity in auto mode serves shared memory only
          const marker = loadSharedMemoryMarker(cfg.baseUrl);
          const prior = String(marker.reason ?? "");
          if (STRUCTURAL_SHARED_MEMORY_FAILURES.has(prior)) {
            // Structural for the plugin version that recorded it; after an update
            // the limitation may be gone — try once more instead of never again.
            if (marker.plugin_version === PROVISIONING_PLUGIN_VERSION) {
              logPluginEvent({ event: "plugin_provision_skipped", status: `shared_memory_${prior}` });
              return;
            }
            logPluginEvent({ event: "plugin_provision_retry_after_update", prior_reason: prior });
          }
        }
        const result = await client.provisionPluginAgent(remaining());
        if (result.status !== "provisioned") {
          if (strict) {
            notifySafe(
              `Cognee plugin provisioning ${result.status}; owner fallback is disabled — safe create-only SDK support is required.`,
              "warning",
            );
          } else {
            // auto: no identity on this server — the principal sees everything
            // anyway, so shared memory has nothing to add.
            logPluginEvent({ event: "plugin_provision_skipped", status: result.status });
          }
          return;
        }
        saveAgentKeyRecord({
          base_url: cfg.baseUrl,
          api_key: result.apiKey!,
          agent_id: result.agentId!,
          plugin_key: "pi",
          principal_fingerprint: principalFingerprint(principal),
          updated_at: new Date().toISOString(),
        });
        client.refreshAgentIdentity();
        // Keep the PRINCIPAL reachable for later control-plane work: an
        // env-provided key only lives in this process's environment.
        client.ensurePrincipalCached();
        provisionedNow = true;
        logPluginEvent({
          event: "plugin_agent_provisioned",
          agent_id: result.agentId,
          created: true,
          reason: strict ? "explicit" : "shared_memory",
        });
        agentKey = result.apiKey;
      }
      if (!agentKey) return;

      let shared = await client.ensureSharedMemory({ dataset: state.dataset, allowSetup: true, timeoutMs: remaining() });
      if (shared.mode !== "shared" && provisionedNow && cfg.pluginIdentity !== "enabled") {
        // Under `auto` the agent was provisioned only on the promise that shared
        // memory keeps the principal's datasets reachable — honour the promise by
        // staying on the principal (the fresh key is revoked server-side; the
        // agent user stays for a later, successful migration). `enabled` keeps it.
        logPluginEvent({ event: "plugin_identity_reverted", reason: shared.reason, detail: "shared memory unavailable" });
        await client.disconnectPluginAgent(remaining()).catch(() => {});
        clearAgentKeyRecord();
        client.dropAgentIdentity();
        shared = {
          mode: "separated",
          reason: shared.reason,
          dataset_id: "",
          dataset_ids: [],
          role_id: "",
        };
      }
      applySharedOutcome(shared);
    } catch {
      /* fail-soft — provisioning must never disturb the session */
    }
  }

  /** /cognee-doctor Memory line — the reference Memory Sharing strings (§1.6). */
  function memorySharingLine(): string {
    try {
      if (!cfg.sharedAgentMemory) return "separated (opt-out)";
      const marker = loadSharedMemoryMarker(cfg.baseUrl);
      if (!client.activeAgentKey) {
        const reason = String(marker.reason ?? "").replace(/_/g, " ");
        return reason
          ? `principal (shared memory unavailable: ${reason})`
          : "principal (no agent identity)";
      }
      if (marker.mode === "shared") return `shared (role: ${AGENT_ROLE_NAME})`;
      return `separated (${String(marker.reason ?? "not wired yet").replace(/_/g, " ")})`;
    } catch {
      return "unavailable";
    }
  }

  /** /cognee-doctor Provisioning line (§3.7): capability verdict or opt-out. */
  async function provisioningDoctorLine(): Promise<string> {
    if (cfg.pluginIdentity === "disabled") return "disabled (COGNEE_PLUGIN_IDENTITY=false)";
    const capabilities = await client.probeCapabilities(3000);
    if (!capabilities.probed) return "not probed (server unreachable)";
    return capabilities.provisioning
      ? "supported (create_only advertised)"
      : "server does not support provisioning";
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
      // Shared-agent-memory provisioning runs after health resolves — once per
      // session, bounded, fail-soft (never blocks this probe's caller).
      void runProvisioningFlow().catch(() => {});
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
      state.connState = "ok";
      renderStatusline();
      if (opts.notify || state.degradedNotified) {
        state.degradedNotified = false;
        notifySafe("Cognee Memory Connected", "info");
      }
      return result;
    }
    state.healthy = false;
    state.lastError = result.error ?? "unreachable";
    state.connState = "offline";
    // T2 bootstrap trigger: an unreachable local server may be bootable (the
    // once-guard inside maybeBootstrap makes this cheap after the first time).
    void maybeBootstrap().catch(() => {});
    // Same information set as the official statusline (health · backend · dataset).
    renderStatusline();
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
    // Remote servers can't read local paths — an auto re-submit would always fail
    // server-side in the background (and leave a zombie "running" repo-state entry).
    if (cfg.backend !== "local") return;
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
   * (same gate as the official plugins' auto_code_lane). The payload is the
   * reference's build_code_query() — query_facts + the first identifier +
   * limit 5 — resolved against the repo's own index-state dataset.
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

  /* ----- Session-cache writes (tier 1): memory view over the disk bridge -----
   *
   * state.writeQueue stays the in-memory view; the durable bridge file
   * (<stateDir>/bridge/<sha1(sid)>.json, spec §2.5) is the single source of
   * truth across restarts. Capture spills straight to the file when the server
   * is known-unusable (never sent → never ambiguous); otherwise entries ride
   * memory and spill on the first failed retryable drain attempt. */

  function queueQa(entry: QaEntry): void {
    queueBound({ ...entry, sessionId: state.sessionId, dataset: state.dataset });
  }

  /** Queue one captured tool-call trace (v0.4) — the same bounded buffer and
   *  capture-time binding as queueQa: a trace drains into the session+dataset
   * active when it was captured, never whichever one is active at drain time. */
  function queueTrace(entry: TraceEntry): void {
    queueBound({ ...entry, sessionId: state.sessionId, dataset: state.dataset });
  }

  function queueBound(bound: BoundQaEntry | BoundTraceEntry): void {
    if (!state.healthy) {
      // Server-unusable-at-capture: spill immediately with ambiguous:false —
      // the entry was never sent, so replay can never duplicate it (§2.5).
      state.droppedCount += appendBridge(bound.sessionId, bound as unknown as SpilledEntry, {
        ambiguous: false,
        maxEntries: cfg.bufferLimit,
      });
      renderStatusline();
      return;
    }
    if (state.writeQueue.length >= cfg.bufferLimit) {
      state.writeQueue.shift();
      state.droppedCount++;
    }
    state.writeQueue.push(bound);
    void drainWriteQueue().catch(() => {});
  }

  /** The drain's head: the merged view — the bridge FILE first (older, possibly
   *  pre-crash), then the memory-only tail. The file consulted is the session
   * owning the current memory head (FIFO per session); when memory is empty,
   * the active session's file, and finally any other session's oldest spill
   * (retired/stranded sessions drain under their own binding). Backoff-open
   * files are skipped. */
  function mergedHeadEntry(): { entry: PendingEntry; source: "file" | "memory" } | undefined {
    try {
      const memSid = state.writeQueue[0]?.sessionId ?? state.sessionId;
      if (memSid) {
        const spilled = loadBridge(memSid);
        if (spilled.length > 0 && !bridgeBackoffOpen(memSid)) {
          return { entry: spilled[0] as unknown as PendingEntry, source: "file" };
        }
      }
    } catch {
      /* fail-soft — memory path below */
    }
    if (state.writeQueue.length > 0) return { entry: state.writeQueue[0], source: "memory" };
    try {
      const own = loadBridge(state.sessionId);
      if (own.length > 0 && !bridgeBackoffOpen(state.sessionId)) {
        return { entry: own[0] as unknown as PendingEntry, source: "file" };
      }
    } catch {
      /* fail-soft */
    }
    try {
      const other = oldestPendingBridgeHead(state.sessionId);
      if (other) return { entry: other.entry as unknown as PendingEntry, source: "file" };
    } catch {
      /* fail-soft */
    }
    return undefined;
  }

  /** Spill the whole memory queue on the first failed retryable attempt: the
   *  failed entry keeps the ambiguity verdict; the never-attempted tail does
   *  not (§2.5 spill policy). Order is preserved per session file. */
  function spillMemoryQueue(failedAmbiguous: boolean): void {
    const spilledCount = state.writeQueue.length;
    let first = true;
    for (const bound of state.writeQueue) {
      state.droppedCount += appendBridge(bound.sessionId, bound as unknown as SpilledEntry, {
        ambiguous: first && failedAmbiguous,
        maxEntries: cfg.bufferLimit,
      });
      first = false;
    }
    state.writeQueue = [];
    logPluginEvent({ event: "bridge_spilled", count: spilledCount });
  }

  async function drainWriteQueue(opts: { force?: boolean; deadline?: number } = {}): Promise<void> {
    if (state.draining || !state.healthy || (!opts.force && state.stopped) || !state.sessionId) return;
    state.draining = true;
    // Background drains are time-boxed by COGNEE_DRAIN_BUDGET_MS (reference
    // COGNEE_DRAIN_BUDGET=20 s); a caller's explicit deadline (final sync 4 s) wins.
    const deadline = opts.deadline ?? Date.now() + cfg.drainBudgetMs;
    try {
      while (state.healthy && (opts.force || !state.stopped)) {
        if (Date.now() >= deadline) break;
        const head = mergedHeadEntry();
        if (!head) break;
        const next = head.entry;
        // Bound at capture: each entry drains into the session/dataset it was
        // captured under — never whichever one happens to be active at drain time.
        const { sessionId, dataset, _replay_ambiguous, _buffered_at, ...entry } = next;
        void _replay_ambiguous;
        void _buffered_at;
        // Bounded per-request timeout clamped to the remaining budget.
        const timeoutMs = Math.max(1000, Math.min(cfg.requestTimeoutMs, deadline - Date.now()));
        // Verify-before-replay (§2.5): an ambiguous head — QA or trace — is
        // checked against the server's recent rows; a fingerprint match
        // consumes the entry WITHOUT re-sending (dedup). Detail failure →
        // replay (fail-open: a rare duplicate beats a lost turn). Entry kinds
        // with no fingerprint (session detail never exposes them) replay.
        if (head.source === "file" && _replay_ambiguous) {
          const fingerprint = entryFingerprint(entry);
          const detail = await client.getSessionDetail(sessionId, timeoutMs);
          if (
            fingerprint &&
            detail.ok &&
            serverFingerprints(detail.qas, detail.traces).has(fingerprint)
          ) {
            trimBridgeHead(sessionId, 1);
            state.dedupedCount++;
            renderStatusline();
            continue;
          }
        }
        // Under shared memory the resolved canonical UUID addresses the write
        // (§3.5): a name only resolves among the CALLER's own datasets.
        const result = await client.rememberEntry(
          entry,
          sessionId,
          dataset,
          timeoutMs,
          datasetIdFor(dataset),
        );
        if (result.ok) {
          if (head.source === "file") {
            trimBridgeHead(sessionId, 1);
            resetBridgeFailures(sessionId);
          } else {
            state.writeQueue.shift();
          }
          bumpStoredCounter(sessionId);
          state.capturedCount++;
          renderStatusline();
          continue;
        }
        const err = result.error;
        const status = err?.status ?? 0;
        const retryable = !err || status === 0 || status >= 500;
        if (retryable) {
          if (head.source === "memory") {
            // First failed retryable attempt: spill that entry (plus any queued
            // behind it) — ambiguity per the §1.5 classification.
            spillMemoryQueue(writeOutcomeAmbiguous(err));
          } else {
            if (writeOutcomeAmbiguous(err)) markBridgeHeadAmbiguous(sessionId);
            // HTTP-status streak → backoff — but never from a FORCED pass: the
            // final sync's bounded last-chance retry already leaves the tail
            // spilled, and stamping backoff would delay the next launch's
            // replay (§2.3's crash-tolerance promise).
            if (status > 0 && !opts.force) recordBridgeFailure(sessionId);
          }
          state.lastError = err?.message ?? "write failed";
          break;
        }
        // Permanent 4xx: memory entries drop loudly (existing behavior); a
        // FILE head stays buffered and enters the drain backoff instead — a
        // poisoned buffered head must not be silently destroyed (reference
        // parity: 4xx is never buffered at capture, only via a retryable spill).
        if (head.source === "memory") {
          state.writeQueue.shift();
          state.droppedCount++;
        } else if (!opts.force) {
          recordBridgeFailure(sessionId);
        }
        state.lastError = err?.message ?? "write rejected";
      }
    } finally {
      state.draining = false;
    }
  }

  /* ----- Graph promotion (tier 2) ----- */

  /** Short reason token for the persisted failure record (reference caps at 120). */
  function improveReasonToken(err?: CogneeError): string {
    if (err?.unreachable) return "unreachable";
    if (err?.transient || err?.aborted) return "timeout";
    if ((err?.status ?? 0) > 0) return `HTTP ${err?.status}`;
    return "error";
  }

  /** The improve wrapper (spec §2.4): every trigger goes through here so only
   *  CONFIRMED outcomes stamp the persisted cooldown state — ok/busy record a
   *  success (busy = the server is already improving this session, goal
   *  achieved), error/unsupported record a failure with a reason token. */
  async function submitImprove(
    trigger: "idle" | "auto" | "final" | "manual" | "switch",
    opts: { sessionId?: string; dataset?: string; timeoutMs?: number } = {},
  ): Promise<{ outcome: "ok" | "busy" | "unsupported" | "error"; error?: CogneeError }> {
    const sessionId = opts.sessionId ?? state.sessionId;
    const dataset = opts.dataset ?? state.dataset;
    if (!sessionId || state.improvesInFlight.has(sessionId)) {
      return { outcome: "error", error: new CogneeError("improve already in flight") };
    }
    state.improvesInFlight.add(sessionId);
    try {
      logPluginEvent({ event: "improve_submitted", trigger, session_id: sessionId });
      const result = await client.improve(sessionId, datasetIdFor(dataset) || dataset, opts.timeoutMs);
      if (result.outcome === "ok" || result.outcome === "busy") {
        recordImproveSuccess(sessionId, dataset, trigger, readStoredCounter(sessionId));
        if (sessionId === state.sessionId) state.lastImprovedCount = state.capturedCount;
      } else {
        recordImproveFailure(sessionId, dataset, trigger, improveReasonToken(result.error));
      }
      return result;
    } catch (err) {
      const wrapped = wrapAsCogneeError(err);
      recordImproveFailure(sessionId, dataset, trigger, improveReasonToken(wrapped));
      return { outcome: "error", error: wrapped };
    } finally {
      state.improvesInFlight.delete(sessionId);
      renderStatusline();
    }
  }

  function maybeAutoImprove(): void {
    const every = cfg.autoImproveEvery;
    if (!every || state.capturedCount === 0 || state.stopped) return;
    // Fire when the stored-write counter CROSSES the threshold — capturedCount can
    // jump past a modulo target when several queued entries drain at once.
    if (state.capturedCount - state.lastImprovedCount < every) return;
    // The persisted gate replaces the in-memory cooldown timestamp (spec §2.4):
    // both auto paths (every-N and idle) consult improveThrottleReason(), so a
    // session improved 10 min ago stays quiet across a relaunch, a failed
    // improve gets one attempt per window, and a session with nothing new
    // stored since the last success is skipped.
    if (improveThrottleReason(state.sessionId, cfg.improveCooldownMs)) return;
    state.lastImprovedCount = state.capturedCount;
    void submitImprove("auto").catch(() => {
      /* fail-soft */
    });
  }

  /* ----- Idle bridge (spec §2.2): agent_settled + one bounded timer -----
   *
   * The reference's detached idle watcher maps to an event-driven arm: every
   * user message / settled turn re-arms ONE timer; when it fires without new
   * activity, at most one improve attempt runs (the analog of "one attempt per
   * watcher life, next prompt respawns"). A throttled fire re-arms exactly
   * once at the persisted cooldown's expiry — a quiet stretch that outlasts
   * the cooldown still gets exactly one bridge, without a poll loop. */

  function armIdleBridge(): void {
    try {
      if (!cfg.idleImprove || !cfg.capture || state.stopped || !state.sessionId) return;
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.timers.delete(state.idleTimer);
        state.idleTimer = undefined;
      }
      const timer = setTimeout(() => {
        state.idleTimer = undefined;
        state.timers.delete(timer);
        void fireIdleBridge(false).catch(() => {});
      }, cfg.idleThresholdMs);
      state.idleTimer = timer;
      state.timers.add(timer);
    } catch {
      /* fail-soft */
    }
  }

  async function fireIdleBridge(rearmed: boolean): Promise<void> {
    try {
      if (!cfg.capture || state.stopped || !state.sessionId) return;
      const reason = improveThrottleReason(state.sessionId, cfg.improveCooldownMs);
      if (reason === "") {
        void submitImprove("idle").catch(() => {});
        return;
      }
      if (reason === "cooldown" || reason === "backoff") {
        if (rearmed) return; // one re-arm per arm — next activity re-arms fresh
        const st = readImproveState(state.sessionId);
        const anchor = Number(reason === "cooldown" ? st.last_improved_at : st.last_failed_at) || 0;
        const delay = Math.max(0, anchor + cfg.improveCooldownMs - Date.now());
        logPluginEvent({ event: "improve_throttled", reason, rearm_ms: delay });
        const timer = setTimeout(() => {
          state.idleTimer = undefined;
          state.timers.delete(timer);
          void fireIdleBridge(true).catch(() => {});
        }, delay);
        state.idleTimer = timer;
        state.timers.add(timer);
        return;
      }
      // "no_new_entries" → do nothing: the next stored write re-arms via agent_settled.
    } catch {
      /* fail-soft */
    }
  }

  async function finalSync(): Promise<void> {
    if (state.finalSyncDone) return;
    state.finalSyncDone = true;
    if (!cfg.finalSync || !state.sessionId) return;
    // Bounded in-process final sync (spec §2.3): the exit-watcher's detached
    // worker maps to crash tolerance via the bridge — anything this 4 s pass
    // cannot flush stays in the spill file and replays at the next launch.
    try {
      if (pendingWriteCount() > 0 && !state.healthy) {
        state.healthy = (await client.health(1000)).reachable;
      }
      if (state.healthy) {
        await drainWriteQueue({ force: true, deadline: Date.now() + FINAL_SYNC_TIMEOUT_MS });
      }
      if (state.capturedCount > 0) {
        await submitImprove("final", { timeoutMs: FINAL_SYNC_TIMEOUT_MS });
      }
      // Sessions retired by a --force switch past a failed sync get their own
      // promotion pass: their buffered writes were bound at capture time and
      // drained above (or stayed spilled under their own binding), so the graph
      // promote remains (our analog of the reference's `touched` retry).
      for (const retired of state.retiredSessions) {
        try {
          await submitImprove("final", {
            sessionId: retired.sessionId,
            dataset: retired.dataset,
            timeoutMs: FINAL_SYNC_TIMEOUT_MS,
          });
        } catch {
          /* fail-soft per retired session */
        }
      }
    } catch {
      /* fail-soft */
    }
  }

  function stopWatchers(): void {
    state.stopped = true;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
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
    /** Invoked exactly once, right before returning, when the poll observed a
     *  terminal status (suffix-matched, case-insensitive — servers report
     *  prefixed forms). Never invoked on abort/stop/budget-expiry (non-terminal:
     *  the pipeline is still running). Fail-soft: a throwing callback cannot
     *  change the poll's return value. */
    onTerminal?: (status: "COMPLETED" | "ERRORED" | "FAILED") => void,
  ): Promise<string> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline && !signal?.aborted && !state.stopped) {
      const result = await client.datasetStatus(datasetId, pipeline, 3000);
      if (result.ok) {
        // Case-insensitive, suffix match (same as the reference pollers): servers
        // report "completed"/"COMPLETED"/prefixed forms alike.
        const s = (result.status ?? "").toUpperCase();
        if (s.endsWith("COMPLETED")) {
          try { onTerminal?.("COMPLETED"); } catch { /* fail-soft */ }
          return "graph is queryable";
        }
        if (s.endsWith("ERRORED")) {
          try { onTerminal?.("ERRORED"); } catch { /* fail-soft */ }
          return "pipeline ERRORED — data stored, but graph build failed";
        }
        if (s.endsWith("FAILED")) {
          // Defensive terminal class: not in the 1.6.0 PipelineRunStatus enum, but
          // a FAILED pipeline is just as terminal as an ERRORED one — polling on
          // can only burn the budget.
          try { onTerminal?.("FAILED"); } catch { /* fail-soft */ }
          return "pipeline FAILED — data stored, but graph build failed";
        }
      }
      // Abort-aware poll sleep, registered in state.timers so shutdown clears
      // it. The abort listener is named and removed on the normal timeout path
      // so poll iterations never accumulate listeners on the same signal.
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(t);
          state.timers.delete(t);
          resolve();
        };
        const t = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          state.timers.delete(t);
          resolve();
        }, intervalMs);
        state.timers.add(t);
        signal?.addEventListener("abort", onAbort, { once: true });
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
      "(single file only, no cross-file edges — index the repo for those). Re-ingesting a file whose content " +
      "changed UPDATES the stored item (chunk-level diff, same data_id) instead of adding a duplicate; identical " +
      "content sends nothing. The file must exist, be text, fit the size cap, and not look like a credential " +
      "(~/.ssh, *.pem, .env, id_rsa*, credentials* are refused). " +
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
          // Update-when-changed (v0.3): identical content sends nothing; a changed
          // file PATCHes the stored data item instead of adding a duplicate.
          if (result.outcome === "unchanged") {
            return textResult(
              `File '${read.basename}' unchanged (identical to the stored copy, data_id ${result.dataId}) — nothing sent.`,
              { dataset, nodeSet, filename: read.basename, outcome: "unchanged", dataId: result.dataId },
            );
          }
          let suffix = "";
          if (result.datasetId) {
            suffix = ` ${await waitForCognify(result.datasetId, cfg.rememberWaitMs, signal)}`;
          }
          if (result.outcome === "updated") {
            const note = result.update
              ? `${result.update.status}${result.update.detail ? `: ${result.update.detail}` : ""}`
              : "update sent";
            return textResult(
              `Updated file '${read.basename}' in dataset '${dataset}' (node_set: ${nodeSet}) — ${note} — ` +
                `the data item kept its identity (no duplicate created).${suffix}`,
              {
                dataset,
                nodeSet,
                filename: read.basename,
                outcome: "updated",
                dataId: result.dataId,
                datasetId: result.datasetId,
              },
            );
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
      "(recent question/answer pairs) instead of the graph. Output is truncated at 4000 chars." + federatedReadNote,
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
          datasetIds: sharedReadIds(),
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
      "Output is truncated at 4000 chars." + federatedReadNote,
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
        const dataset = params.dataset ?? state.dataset;
        const result = await client.recall({
          query: params.query,
          topK: params.top_k ?? 5,
          dataset,
          // An explicit dataset argument targets that dataset by name; the
          // shared-memory read set applies only to the session dataset.
          datasetIds: params.dataset ? undefined : sharedReadIds(),
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
          if (!seed) seed = params.name ?? params.start ?? params.source ?? params.targets?.[0] ?? (op === "delta" ? "" : op); // delta's server-side query is a repo-name filter — an op-name seed would filter everything out
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
        // Empty envelopes (facts: [], total: 0) are "no such symbol", not hits —
        // filtered so they fall through to the no-facts warning instead of
        // reporting raw {"facts":[],"total":0} JSON as the body.
        const hits = result.items.filter(codeItemHasData);
        const body = renderCodeItems(hits);
        return textResult(
          body ||
            (result.noGraph
              ? `Code dataset '${resolved.dataset}' has no graph yet — indexing may still be running (check /cognee-index --wait).`
              : codeQuery?.operation === "delta"
                ? `Delta: no repository records in dataset '${resolved.dataset}'s graph — nothing indexed or stamped yet.`
                : `No code facts for '${seed}' — the graph has no such symbol (an empty result, not an error).`),
          { hits: hits.length, dataset: resolved.dataset, resolvedVia: resolved.how },
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
        const target = params.dataset ?? state.dataset;
        const { outcome, error } = await submitImprove("manual", {
          dataset: target,
          timeoutMs: cfg.improveSubmitTimeoutMs,
        });
        void signal;
        const messages: Record<string, string> = {
          ok: `Session cache promoted into the graph (dataset '${target}').`,
          busy: "The server is already improving this session — it will sync on its own; nothing to do.",
          unsupported:
            "This cognee server does not support /api/v1/improve (older than the plugin-pinned version) — session not synced.",
        };
        if (outcome === "error") return errResult("cognee_sync failed", error);
        return textResult(messages[outcome], { outcome });
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
          `  Dataset:   ${state.dataset}${datasetSwitchSuffix()}`,
          `  Federation: ${federationStatusLine()}`,
          `  Session:   ${state.sessionId || "(not started)"}`,
          `  API key:   ${client.authSummary()}`,
          `  Auto:      capture ${cfg.capture ? "on" : "off (COGNEE_CAPTURE=false)"} · auto-recall ${cfg.capture ? "on" : "off"} · auto-sync every ${cfg.autoImproveEvery || "∞"} writes`,
          `  Recall:    ${state.turnsWithHits}/${state.totalRecallTurns} turns had hits this session`,
          `  Queue:     ${state.writeQueue.length} buffered · ${loadBridge(state.sessionId).length} spilled · ${state.capturedCount} stored this session${state.droppedCount ? ` · ${state.droppedCount} dropped` : ""}${state.dedupedCount ? ` · ${state.dedupedCount} deduped` : ""}${cfg.idleImprove ? ` · idle sync every ${Math.round(cfg.idleThresholdMs / 1000)}s quiet` : " · idle sync off (COGNEE_IDLE_IMPROVE=false)"}`,
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
          `  ${pad("Dataset")}${state.dataset} — ${datasetSourceLabel()}`,
          `  ${pad("Federation")}${federationStatusLine()}`,
          `  ${pad("Memory")}${memorySharingLine()}`,
          `  ${pad("Provisioning")}${await provisioningDoctorLine()}`,
          `  ${pad("Session")}${state.sessionId || "(not started)"}`,
          `  ${pad("Datasets")}${datasets.ok && datasets.datasets.length ? datasets.datasets.slice(0, 10).map((d) => `${d.name}${d.id ? ` (${d.id.slice(0, 8)}…)` : ""}`).join(", ") : datasets.ok ? "(none readable)" : `unavailable (${describeError(datasets.error)})`}`,
          `  ${pad("Capture")}${cfg.capture ? "on" : "off (COGNEE_CAPTURE=false)"} · stored this session: ${state.capturedCount} · buffered: ${state.writeQueue.length} · spilled: ${loadBridge(state.sessionId).length}${state.dedupedCount ? ` · deduped: ${state.dedupedCount}` : ""}`,
          `  ${pad("Capture pol")}${capturePolicySummary()}`,
          `  ${pad("Breaker")}${breakerOpen() ? `OPEN until ${new Date(state.breakerOpenUntil).toLocaleTimeString()}` : `closed (${state.failureTimestamps.length}/${cfg.breakerThreshold} recent failures)`} · shared: ${sharedBreakerSummary()}`,
          `  ${pad("Timeouts")}recall ${cfg.recallTimeoutMs}ms · request ${cfg.requestTimeoutMs}ms · health ${cfg.healthTimeoutMs}ms`,
          `  ${pad("Code graph")}${codeGraphStatusLine()}`,
          `  ${pad("Local runtime")}uv: ${findUv() || "not found"} · venv: ${await localRuntimeVersion()} · pin: ${PINNED_COGNEE_VERSION}${cfg.localBootstrap ? bootstrapStateSuffix() : " · bootstrap off (COGNEE_LOCAL_BOOTSTRAP=off)"}`,
          `  ${pad("Server pidfile")}${serverPidfileStatus(serverPort(cfg.baseUrl))}`,
        ];
        if (cfg.backend === "local" && keySummary.startsWith("not set")) {
          lines.push(
            `             cognee ≥1.2.2 enforces auth even on localhost — pi-cognee auto-mints an owner key when the server's default user can log in: start it with DEFAULT_USER_PASSWORD set to the same value as COGNEE_USER_PASSWORD (defaults: default_user@example.com / default_password), or set COGNEE_API_KEY explicitly.`,
          );
        }
        if (cfg.pluginIdentityError) {
          lines.push(
            `             ✕ ${cfg.pluginIdentityError} — identity behaves as auto (fail-soft).`,
          );
        }
        if (client.identityProblem) {
          lines.push(`             ✕ ${client.identityProblem}`);
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
        // Update-when-changed (v0.3, file uploads only): identical content sends
        // nothing; a changed file PATCHes the stored data item (no duplicate).
        if (result.outcome === "unchanged") {
          report(ctx, `File '${filename}' unchanged (identical to the stored copy, data_id ${result.dataId}) — nothing sent.`);
          return;
        }
        let suffix = "";
        if (result.datasetId) suffix = ` ${await waitForCognify(result.datasetId, cfg.rememberWaitMs)}`;
        if (result.outcome === "updated") {
          const note = result.update
            ? `${result.update.status}${result.update.detail ? `: ${result.update.detail}` : ""}`
            : "update sent";
          report(
            ctx,
            `Updated file '${filename}' in '${state.dataset}' (node_set ${nodeSet}) — ${note} — the data item kept its identity (no duplicate created).${suffix}`,
          );
          return;
        }
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
          datasetIds: dataset ? undefined : sharedReadIds(),
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
            `✕ Cloud/remote servers cannot read local paths — '${spec}' was NOT submitted. Pass a git URL instead (the server clones it; freshness then follows pushed commits).`,
            "error",
          );
          return;
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
            (status) => {
              // Fail-soft terminal write-back (stale-last_status fix): the poll
              // is dataset-scoped, so join on the dataset this submission just
              // recorded — NOT findIndexedRepo (cwd containment), which
              // /cognee-index <anywhere> need not satisfy. Prefer the state
              // file whose spec is this repo — a deliberate --dataset reuse
              // across two repos must not land the terminal status on the
              // other repo's file (same-dataset fallback: most recent index).
              try {
                const canonical = canonicalRepoSpec(resolvedSpec);
                const sameDataset = loadRepoStates().filter((r) => r.dataset === usedDataset);
                const repo =
                  sameDataset.find((r) => r.spec === canonical) ??
                  sameDataset.reduce<CodeRepoState | undefined>(
                    (latest, r) =>
                      !latest || (r.last_index_at ?? 0) >= (latest.last_index_at ?? 0) ? r : latest,
                    undefined,
                  );
                if (!repo) return;
                repo.last_status = status;
                repo.last_status_at = Date.now();
                saveRepoState(repo);
              } catch {
                /* fail-soft — state is an optimization, never a source of truth */
              }
            },
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
        if (!codeQuery && /^delta$/i.test(trimmed)) codeQuery = { operation: "delta" }; // bare "delta" is documented as an operation
        if (codeQuery?.operation === "delta" && !codeQuery.name && !codeQuery.repo) seed = ""; // the server uses the query as a repo-name filter — don't poison it
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
        // Same empty-envelope filter as the tool path: facts: [] is "no such symbol".
        const hits = result.items.filter(codeItemHasData);
        const body = renderCodeItems(hits);
        report(
          ctx,
          body ||
            (result.noGraph
              ? `Code dataset '${resolved.dataset}' has no graph yet — indexing may still be running.`
              : codeQuery?.operation === "delta"
                ? `Delta: no repository records in dataset '${resolved.dataset}'s graph — nothing indexed or stamped yet.`
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
        // Manual sync is ungated by the cooldown (parity) but still records its
        // confirmed outcome through the wrapper (spec §2.4).
        const { outcome, error } = await submitImprove("manual", {
          timeoutMs: cfg.improveSubmitTimeoutMs,
        });
        if (outcome === "ok") {
          report(ctx, `Session cache promoted into the graph (dataset '${state.dataset}').`);
        } else if (outcome === "busy") {
          report(ctx, "The server is already improving this session — nothing to do.", "warning");
        } else if (outcome === "unsupported") {
          report(ctx, "This server does not support /api/v1/improve — session not synced.", "warning");
        } else {
          report(ctx, `Sync failed: ${error?.message ?? "unknown error"}`, "error");
        }
      } catch (err) {
        report(ctx, `Sync failed: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("cognee-datasets", {
    description:
      "List memory datasets / switch the active one: /cognee-datasets [<name>] [--force]",
    handler: async (args, ctx) => {
      // Re-entry guard (in-process analog of the reference .switch.lock): two
      // overlapping invocations must not both mint __2 from the same base session.
      if (state.switching) {
        report(ctx, "A dataset switch is already in progress — wait for it to finish.", "warning");
        return;
      }
      state.switching = true;
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const force = tokens.includes("--force");
        const positional = tokens.filter((t) => t !== "--force");
        if (positional.length > 1) {
          report(ctx, "Usage: /cognee-datasets [<name>] [--force] — dataset names never contain spaces.", "warning");
          return;
        }
        const target = positional[0] ?? "";
        // Re-read the identity cache (the reference's resolve_shared_dataset
        // loads it itself): another process may have provisioned since we were
        // constructed, and the shared-resolution path below depends on it.
        client.refreshAgentIdentity();
        // Opt-out (COGNEE_SHARED_AGENT_MEMORY=false with a live shared marker):
        // the agent leaves the shared role as the principal and the marker is
        // demoted keeping the tenant/role/parent ids (re-enabling rejoins).
        // No-op when unwired/unsupported (§3.6). Runs once per command — cheap
        // after the first demotion (the marker is no longer shared).
        if (!cfg.sharedAgentMemory && client.activeAgentKey) {
          await client.ensureSharedMemory({ allowSetup: false, timeoutMs: 8000 }).catch(() => {});
        }
        const listed = await client.listDatasets();
        if (!listed.ok) {
          report(
            ctx,
            `Cannot list datasets: ${listed.error?.message ?? "unknown error"}` +
              (listed.error?.unreachable || listed.error?.status === 0
                ? " — server unreachable, run /cognee-doctor"
                : ""),
            "error",
          );
          return;
        }
        // Writability narrowing (v0.4, §3.6): when the permissions route answers
        // (probe once per command), narrow the listing to writable rows and print
        // the reference's notes. Route absent/unreachable → today's every-readable
        // heuristic, and say so — pi's fail-soft divergence from the reference's
        // refusal of unverifiable targets.
        let writableListing: Awaited<ReturnType<CogneeClient["listWritableDatasets"]>> | undefined;
        try {
          writableListing = await client.listWritableDatasets(5000);
        } catch {
          /* permissions route absent — permissive fallback below */
        }
        if (!target) {
          const extra: string[] = [];
          if (writableListing) {
            if (writableListing.hidden_readonly > 0) {
              extra.push(`(${writableListing.hidden_readonly} read-only dataset(s) not shown)`);
            }
            if (!writableListing.filtered) {
              extra.push("(write access could not be verified — showing every readable dataset)");
            }
          }
          report(
            ctx,
            renderDatasetList(
              state.dataset,
              state.sessionId,
              writableListing ? writableListing.datasets : listed.datasets,
              extra,
            ),
          );
          return;
        }
        // A Cognee session never spans two datasets: switching means syncing the
        // session being left, minting a NEW session id for the target dataset,
        // and repointing every lane (mirror of the reference switch-dataset flow,
        // minus the agent-registry conn handles — accepted gap #3 divergence).
        if (target === state.dataset) {
          report(
            ctx,
            `Already active: '${target}' (session ${state.sessionId || "(not started)"}) — nothing to do.`,
          );
          return;
        }
        const match = matchDatasets(target, writableListing ? writableListing.datasets : listed.datasets);
        if (match.status === "ambiguous") {
          report(
            ctx,
            `Ambiguous: '${target}' matches ${match.matches.length} datasets ` +
              `(${match.matches.map((m) => `${m.name} ${m.id}`).join("; ")}) — select its UUID.`,
            "error",
          );
          return;
        }
        // Read-only / unresolvable-UUID targets are refused up front when the
        // permissions route positively judged writability (reference exit-5). In
        // unverified mode (no route) the heuristic stays permissive.
        if (writableListing?.filtered) {
          const matched = match.status === "ok";
          if ((!matched && writableListing.readonly.includes(target)) || (isUuid(target) && !matched)) {
            report(
              ctx,
              `Dataset '${target}' is not writable — pick a writable dataset from the list: /cognee-datasets`,
              "error",
            );
            return;
          }
        }
        // Under a live shared marker the target is resolved AS THE PARENT later
        // (canonical UUID + grant backfill, create-as-parent when absent);
        // otherwise an unlisted name is CREATED on switch (the picker's
        // free-typed "Other") for the effective identity by name.
        const sharedLive = cfg.sharedAgentMemory && Boolean(client.activeAgentKey);
        let datasetName = match.status === "ok" ? match.matches[0].name || target : target;
        if (match.status === "missing" && !sharedLive) {
          const ensured = await client.ensureDataset(target);
          if (!ensured.ok) {
            report(
              ctx,
              `Cannot switch to '${target}': not in the readable set and could not be created ` +
                `(${ensured.error?.message ?? "unknown error"}) — pick from the list: /cognee-datasets`,
              "error",
            );
            return;
          }
        }
        datasetName = sanitizeDatasetName(datasetName);

        // 1. Strict sync of the session being left — bounded (≤4s drain + ≤4s
        //    improve, same budget as the final sync). Failure aborts unless
        //    --force; the buffered queue is preserved either way and the
        //    auto-sync/final-sync paths retry it (our analog of `touched`).
        let synced = true;
        let syncError = "";
        if (state.sessionId) {
          try {
            if (pendingWriteCount() > 0) {
              await drainWriteQueue({ force: true, deadline: Date.now() + FINAL_SYNC_TIMEOUT_MS });
            }
            if (state.capturedCount > 0) {
              // Switch sync is ungated by the cooldown (parity); the confirmed
              // outcome still lands in the persisted state via the wrapper.
              const improved = await submitImprove("switch", { timeoutMs: FINAL_SYNC_TIMEOUT_MS });
              if (improved.outcome === "error") {
                synced = false;
                syncError = improved.error?.message ?? "improve failed";
              }
            }
          } catch (err) {
            synced = false;
            syncError = describeError(err);
          }
        }
        if (!synced && !force) {
          report(
            ctx,
            [
              `Switch aborted: syncing the current session into '${state.dataset}' failed (${syncError}).`,
              "The switch did NOT happen; buffered writes stay queued and the auto/final syncs retry.",
              "Re-run with --force to switch anyway — the retired session keeps its own session-end sync.",
            ].join("\n"),
            "error",
          );
          return;
        }

        // 1b. Resolve the target under shared memory (reference _ensure_dataset):
        //     the canonical parent-owned UUID every agent writes to, granted to
        //     the shared role — created as the PARENT when absent. Failure on an
        //     unlisted target aborts (nothing was created for us); on a listed
        //     target the switch proceeds name-addressed (wiring retried later).
        let writeId = "";
        let readIds: string[] = [];
        if (sharedLive) {
          const shared = await client.resolveSharedDataset(datasetName, 8000);
          if (shared.mode === "shared" && shared.dataset_id) {
            writeId = shared.dataset_id;
            readIds = shared.dataset_ids;
          } else if (match.status === "missing") {
            report(
              ctx,
              `Cannot switch to '${target}': shared-memory resolution failed (${shared.reason.replace(/_/g, " ")}) — pick from the list: /cognee-datasets`,
              "error",
            );
            return;
          }
        }

        // 2. Mint the next ordinal session id (never collides, stays readable).
        const newSessionId = sanitizeSessionId(
          mintSwitchSessionId(state.sessionId || `${cfg.sessionPrefix}_${randomId()}`),
        );
        // 3. Repoint in memory …
        const previous = { dataset: state.dataset, session_id: state.sessionId, synced };
        const prevEnsured = state.datasetEnsured;
        const prevSwitchFrom = state.datasetSwitchedFrom;
        const prevSwitchAt = state.datasetSwitchedAt;
        const prevSharedDatasetId = state.sharedDatasetId;
        const prevSharedDatasetIds = state.sharedDatasetIds;
        state.dataset = datasetName;
        state.sessionId = newSessionId;
        state.datasetEnsured = false;
        state.datasetSource = "persisted switch";
        state.datasetSwitchedFrom = previous.dataset;
        state.datasetSwitchedAt = new Date().toISOString();
        state.sharedDatasetId = writeId;
        state.sharedDatasetIds = readIds.length ? readIds : writeId ? [writeId] : [];

        // 4. … persist atomically (tmp + rename), then read back and verify —
        //    mismatch rolls back: "switch was not persisted; nothing was changed".
        //    The record carries the shared-memory UUIDs when wiring resolved
        //    them (empty → name addressing, the pre-v0.4 behavior).
        const record: ActiveDatasetRecord = {
          base_url: cfg.baseUrl,
          key_fp: client.keyFingerprint(),
          dataset: datasetName,
          session_id: newSessionId,
          dataset_id: writeId,
          dataset_ids: readIds,
          previous,
          switched_at: state.datasetSwitchedAt,
        };
        const saved = saveActiveDatasetRecord(record);
        const verify = saved.ok
          ? loadActiveDatasetRecord(cfg.baseUrl, client.keyFingerprint())
          : undefined;
        if (!saved.ok || !verify || verify.dataset !== record.dataset || verify.session_id !== record.session_id) {
          state.dataset = previous.dataset;
          state.sessionId = previous.session_id;
          state.datasetEnsured = prevEnsured;
          state.datasetSource = cfg.datasetSource;
          state.datasetSwitchedFrom = prevSwitchFrom;
          state.datasetSwitchedAt = prevSwitchAt;
          state.sharedDatasetId = prevSharedDatasetId;
          state.sharedDatasetIds = prevSharedDatasetIds;
          report(
            ctx,
            `Switch was not persisted${saved.error ? ` (${saved.error})` : ""} — nothing was changed; the previous session remains active.`,
            "error",
          );
          return;
        }

        // 4b. A --force switch past a failed sync retired an unsynced session —
        //     remember it so the session-end sync promotes its cache too (the
        //     reference retries it via `touched`; ours retries at final sync).
        if (!synced && previous.session_id) {
          const alreadyTracked = state.retiredSessions.some((r) => r.sessionId === previous.session_id);
          if (!alreadyTracked) {
            state.retiredSessions.push({ sessionId: previous.session_id, dataset: previous.dataset });
          }
        }

        // 5. Lanes re-pointed (capture/recall/sync/statusline read state.dataset);
        //    the code lane and federation stay independent of the session dataset.
        renderStatusline();
        void runHealthCheck({ notify: false }).catch(() => {}); // ensure + refresh state
        report(
          ctx,
          [
            `Switched to dataset '${state.dataset}' (session ${newSessionId}).`,
            synced
              ? `Previous session ${previous.session_id} synced into '${previous.dataset}'.`
              : `Previous session NOT synced (--force) — its buffered writes stay bound to it and its session-end sync will retry.`,
            `Recall is scoped to the active dataset: context from '${previous.dataset}' is no longer injected (switch back to see it again).`,
          ].join("\n"),
        );
      } catch (err) {
        report(ctx, `Dataset switch failed: ${describeError(err)}`, "error");
      } finally {
        state.switching = false;
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
        cfg.sessionIdOverride ??
          // A persisted switch is the session affinity: pi has no stable host
          // session id across processes, so the record's session id is adopted
          // and a resumed conversation keeps bridging into the switched session.
          cfg.switchSessionId ??
          `${cfg.sessionPrefix}_${hostId || randomId()}`,
      );
      state.dataset = cfg.dataset;
      state.datasetSource = cfg.datasetSource;
      state.datasetSwitchedFrom = cfg.datasetSwitchedFrom ?? null;
      state.datasetSwitchedAt = cfg.datasetSwitchedAt ?? null;
      state.hasUI = ctx.hasUI;
      state.ui = ctx.ui;
      state.cwd = ctx.cwd || process.cwd();
      state.autoIndexTried = false; // one auto-index attempt per session
      // Config warning (exact reference error string): a malformed
      // COGNEE_PLUGIN_READ_DATASET_IDS disabled federation — surfaced, never fatal.
      if (cfg.readDatasetIdsError) {
        notifySafe(`Cognee federation disabled: ${cfg.readDatasetIdsError}`, "warning");
      }
      // Same surface for a malformed COGNEE_PLUGIN_IDENTITY (behaves as auto).
      if (cfg.pluginIdentityError) {
        notifySafe(`Cognee plugin identity: ${cfg.pluginIdentityError} (behaving as auto)`, "warning");
      }
      state.provisioningDone = false; // one shared-memory provisioning pass per session
      // Disk bridge (spec §2.5): sweep files older than 7 d (bounded disk), then
      // surface this session's spill — the entries stay FILE-resident and the
      // drain's file-first merged view replays them in order once the post-health
      // drain fires, BEFORE any new capture lands (new captures append after;
      // FIFO holds because the drain is strictly head-first). This is the
      // crash-tolerance replacement for the reference's detached final-sync worker.
      try {
        sweepOldBridgeFiles();
        const spilled = loadBridge(state.sessionId);
        if (spilled.length > 0) {
          logPluginEvent({ event: "bridge_loaded", session_id: state.sessionId, count: spilled.length });
          renderStatusline(); // · N awaiting replay from the durable count
        }
      } catch {
        /* fail-soft — a missed replay just waits for the next drain */
      }
      // Background health check — startup is never blocked by the server.
      // T1 bootstrap trigger runs first (fast when the server is present:
      // a ~2.5s presence verdict; the cold-install path keeps the "◐ starting"
      // status up until the health check takes over).
      const timer = setTimeout(() => {
        state.timers.delete(timer);
        void maybeBootstrap()
          .catch(() => {})
          .finally(() => {
            void runHealthCheck({ notify: true })
              .catch(() => {})
              .finally(() => scheduleReprobe());
          });
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
    const buffered = pendingWriteCount() ? ` · ${pendingWriteCount()} awaiting replay` : "";
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
          // Precedence #2 after env federation (§3.5): the shared-memory read set
          // addresses the recall by UUID — the client drops the session binding
          // exactly as the federation lane already does.
          datasetIds: sharedReadIds(),
          topK: 5,
          searchType: "HYBRID_COMPLETION",
          onlyContext: true,
          scope: ["graph"],
          timeoutMs: cfg.recallTimeoutMs,
        }),
        lane
          ? client.codeSearch({
              // Reference wire shape (session-context-lookup.py _dispatch, verified
              // against the live server — research/findings-codelane.md §1): the FULL
              // prompt is the query (the default-explore fallback seed — NOT the
              // identifier), the identifier rides in code_query.name, top_k is the
              // reference TOP_K=5, the dataset is the repo's own from index state,
              // and the session id is attached on the code scope too.
              seed: redactSecrets(prompt),
              codeQuery: lane.codeQuery,
              dataset: lane.dataset,
              topK: 5,
              sessionId: state.sessionId,
              timeoutMs: Math.min(2000, cfg.recallTimeoutMs),
            })
          : Promise.resolve(null),
      ]);
      // The server does not answer "no results" for an unresolvable code seed —
      // it returns ONE entry whose text IS the raw envelope
      // ("{\"operation\": \"query_facts\", \"facts\": [], …}"). Filter empty
      // envelopes before counting hits, or the lane injects that JSON as a
      // "fact" (the observed empty-lane bug). Non-JSON prose hits pass through.
      const codeFacts = codeResult?.ok ? codeResult.items.filter(codeItemHasData) : [];
      const codeSection =
        codeFacts.length > 0 ? renderCodeFacts(codeFacts, CODE_LANE_MAX_CHARS) : "";
      if (!result.ok) {
        recordFailure(result.error);
        if (result.error?.status === 401 || result.error?.status === 403) {
          state.connState = "auth";
        } else if (result.error && !result.error.transient && result.error.status !== 0) {
          state.healthy = false;
          state.connState = "server-error";
        }
        renderStatusline();
        const skipped = recallSkipped(recallSkipReason(result.error)); // turn proceeds normally
        if (codeSection && skipped.message && typeof skipped.message.content === "string") {
          skipped.message.content += `\n\n${codeSection}`;
        }
        return skipped;
      }
      recordSuccess();
      // A successful recall is positive connection evidence — it restores the
      // glyph (the fail verdicts are recall-path observations, §2.1).
      if (state.connState !== "ok") state.connState = "ok";
      // Recall-segment counters (spec §2.1): the per-turn hit number sums every
      // scope that returned something and was injected — graph items + code
      // facts (exactly the reference's turns_with_hits rule), feeding the
      // statusline's compact same-numbers view.
      const turnHits = result.items.length + codeFacts.length;
      state.lastRecallHits = turnHits;
      state.lastGraphHits = result.items.length;
      state.lastCodeHits = codeFacts.length;
      if (turnHits > 0) state.turnsWithHits++;
      renderStatusline();
      if (result.noGraph && !codeSection) return; // authoritative empty — nothing built yet
      if (result.items.length > 0 || codeSection) {
        const statsLine = `Cognee memory: ${turnHits} memory hits · ${state.turnsWithHits}/${state.totalRecallTurns} turns had hits this session`;
        const block = renderContextBlock(result.items, cfg.contextMaxChars, statsLine);
        // Reference order: the code section renders FIRST, before the memory block.
        const content = [codeSection, block].filter(Boolean).join("\n\n");
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
        // New user activity resets the idle window (spec §2.2 — the timer IS
        // the touch; no activity.ts file, no pidfile, no respawn).
        armIdleBridge();
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
      // Idle bridge: one arm per quiet gap (spec §2.2) — the timer fires at most
      // one improve attempt; the next user activity re-arms.
      armIdleBridge();
      // Code-graph freshness: a turn may have changed the working tree — check
      // (debounced, off the turn's critical path) and re-index in the background.
      scheduleChangeCheck();
    } catch {
      /* fail-soft */
    }
  });

  /* ----- Tool-call trace capture (v0.4) — the PostToolUse equivalent -----
   *
   * Every ALLOWED tool result becomes a TraceEntry in the session cache
   * (research/v04-traces-spec.md): master switch → self-reference skip (hard,
   * before the allowlist — the reference's plugin-CLI rule) → allowlist +
   * sensitive-path deny (entry-level refusal) → redact input/output → truncate
   * → queue. Pure observer: returns void, never mutates the event; sibling
   * tool calls from one assistant message run in parallel, so each event is
   * self-contained (the input travels with the result — capture only ever
   * happens from tool_result, never tool_call). */
  pi.on("tool_result", (event): void => {
    try {
      if (!cfg.capture || state.stopped || !state.sessionId) return;
      const toolName = String(event.toolName ?? "");
      // Self-reference skip: this extension's own registered tools, and shell
      // lines mentioning "cognee" (the plugin CLI talking to itself — it would
      // recurse), never feed the graph — even when the allowlist admits them.
      if (toolName.startsWith("cognee_")) return;
      const input = event.input ?? {};
      if (
        (toolName === "bash" || toolName === "powershell") &&
        typeof input.command === "string" &&
        input.command.includes("cognee")
      ) {
        return;
      }
      const entry = buildTraceEntry(
        {
          toolName,
          input,
          content: event.content,
          isError: Boolean(event.isError),
        },
        {
          allowTools: cfg.captureTools,
          denyPaths: cfg.captureDenyPaths,
          redact: cfg.captureRedact,
          redactPatterns: cfg.captureRedactPatterns,
        },
      );
      if (entry) queueTrace(entry); // allowlist/deny refusal drops silently (reference parity)
    } catch {
      /* fail-soft — capture must never disturb the tool path */
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
          datasetIds: sharedReadIds(),
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
