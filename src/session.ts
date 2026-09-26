/**
 * pi-cognee — in-memory session state (volatile; distinct from the persisted
 * records in src/state/). Shape + initial derivation extracted from the
 * extension factory so health.ts and future extractions can share the type.
 */
import type { CogneeConfig } from "./config/types";
import type { QaEntry, TraceEntry } from "./client/types";
import { loadSharedMemoryMarker } from "./state/shared_memory";

/** A captured QA entry BOUND to the session+dataset it was captured under.
 *  Binding happens at capture time so a later dataset switch can never
 *  mis-attribute buffered writes into the new dataset (the reference binds
 *  pending entries to the retired triple the same way). The binding is
 *  plugin-internal — it is stripped before the wire payload is built. */
export type BoundQaEntry = QaEntry & { sessionId: string; dataset: string };

/** A captured tool-call trace entry with the same capture-time binding. */
export type BoundTraceEntry = TraceEntry & {
	sessionId: string;
	dataset: string;
};

/** Any queued entry as seen by the drain: bound + the bridge's replay meta. */
export type PendingEntry = (BoundQaEntry | BoundTraceEntry) & {
	_replay_ambiguous?: true;
	_buffered_at?: number;
};

export interface SessionState {
	stopped: boolean;
	healthy: boolean;
	lastError: string;
	lastCheckAt: number;
	failureTimestamps: number[];
	breakerOpenUntil: number;
	breakerFileSyncedAt: number;
	degradedNotified: boolean;
	datasetEnsured: boolean;
	sessionId: string;
	dataset: string;
	/* switch provenance — set from the persisted record, updated on a live switch */
	datasetSource: string;
	datasetSwitchedFrom: string | null;
	datasetSwitchedAt: string | null;
	pendingQuestion: string | null;
	pendingAnswer: string | null;
	writeQueue: (BoundQaEntry | BoundTraceEntry)[];
	draining: boolean;
	/* connection verdict for the statusline glyph slot (single left slot,
	 * reference precedence: connection failure > llm-key > server signal) */
	connState: "unknown" | "ok" | "offline" | "auth" | "server-error";
	/* last recall turn's hit counts (statusline recall segment, spec §2.1) */
	lastRecallHits: number;
	lastGraphHits: number;
	lastCodeHits: number;
	/* idle bridge (spec §2.2): the single arm timer + its one re-arm */
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/* per-target improve re-entry guard (server busy-locks per session) */
	improvesInFlight: Set<string>;
	/* verify-before-replay consumptions (surfaced by /cognee) */
	dedupedCount: number;
	/* re-entry guard for the dataset-switch command (in-process analog of the reference .switch.lock) */
	switching: boolean;
	/* sessions retired by a --force switch past a failed sync: finalSync promotes them too */
	retiredSessions: { sessionId: string; dataset: string }[];
	capturedCount: number;
	droppedCount: number;
	lastImprovedCount: number;
	totalRecallTurns: number;
	turnsWithHits: number;
	finalSyncDone: boolean;
	timers: Set<ReturnType<typeof setTimeout>>;
	hasUI: boolean;
	ui: ExtensionUIContextLike | undefined;
	/* code-graph (enola) state */
	cwd: string;
	autoIndexTried: boolean;
	lastCodeSubmitAt: number;
	codeReindexTimer: ReturnType<typeof setTimeout> | undefined;
	/* local server bootstrap (v0.4) — once per pi process */
	bootstrapStarted: boolean;
	bootstrapStatus: "idle" | "running" | "done" | "failed";
	bootstrapError: string | undefined;
	/* shared-agent-memory provisioning (v0.4) — once per session, after health */
	provisioningDone: boolean;
	sharedDatasetId: string;
	sharedDatasetIds: string[];
}

/** The slice of pi's ExtensionAPI the statusline/notify path touches
 *  (structural — the real type comes from pi, this keeps session.ts
 *  import-clean of the pi SDK). */
export interface ExtensionUIContextLike {
	notify(message: string, type: "info" | "warning" | "error"): void;
	setStatus(component: string, text: string | undefined): void;
	setStatusline?(parts: unknown): void;
}

export function createSessionState(cfg: CogneeConfig): SessionState {
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

	return {
		stopped: false,
		healthy: false,
		lastError: "",
		lastCheckAt: 0,
		failureTimestamps: [],
		breakerOpenUntil: 0,
		breakerFileSyncedAt: 0,
		degradedNotified: false,
		datasetEnsured: false,
		sessionId: "",
		dataset: cfg.dataset,
		datasetSource: cfg.datasetSource,
		datasetSwitchedFrom: cfg.datasetSwitchedFrom ?? null,
		datasetSwitchedAt: cfg.datasetSwitchedAt ?? null,
		pendingQuestion: null,
		pendingAnswer: null,
		writeQueue: [],
		draining: false,
		connState: "unknown",
		lastRecallHits: 0,
		lastGraphHits: 0,
		lastCodeHits: 0,
		idleTimer: undefined,
		improvesInFlight: new Set<string>(),
		dedupedCount: 0,
		switching: false,
		retiredSessions: [],
		capturedCount: 0,
		droppedCount: 0,
		lastImprovedCount: 0,
		totalRecallTurns: 0,
		turnsWithHits: 0,
		finalSyncDone: false,
		timers: new Set<ReturnType<typeof setTimeout>>(),
		hasUI: false,
		ui: undefined,
		cwd: "",
		autoIndexTried: false,
		lastCodeSubmitAt: 0,
		codeReindexTimer: undefined,
		bootstrapStarted: false,
		bootstrapStatus: "idle",
		bootstrapError: undefined,
		provisioningDone: false,
		sharedDatasetId: initialSharedDatasetId,
		sharedDatasetIds: initialSharedDatasetIds,
	};
}
