import type { CogneeError } from "../helpers/errors";

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export interface RecallItem {
	source?: string;
	text?: string;
	content?: string;
	question?: string;
	answer?: string;
	[key: string]: unknown;
}

export interface RecallParams {
	query: string;
	sessionId?: string;
	dataset?: string;
	datasetIds?: string[];
	topK?: number;
	/** Pinning avoids the server auto-router (plugins pin HYBRID_COMPLETION on completion recalls). */
	searchType?: string;
	onlyContext?: boolean;
	scope?: string[];
	codeQuery?: Record<string, unknown>;
	/** Caller already sanitized/derived this name (code lane): skip the 100-char
	 *  re-sanitize — codeDatasetName() output is charset-clean by construction and
	 *  truncating it breaks cross-plugin dataset identity for long repo names. */
	datasetPresanitized?: boolean;
	timeoutMs?: number;
	externalSignal?: AbortSignal;
}

export interface RecallResult {
	ok: boolean;
	items: RecallItem[];
	/** 404 on graph scope = dataset has no graph yet (authoritative empty). */
	noGraph?: boolean;
	error?: CogneeError;
}

export interface RememberParams {
	content: string;
	filename?: string;
	nodeSet?: "user_context" | "project_docs" | "agent_actions";
	dataset?: string;
	datasetId?: string;
	/** Defaults to cfg.rememberBackground (COGNEE_REMEMBER_BACKGROUND, default true). */
	background?: boolean;
	timeoutMs?: number;
	externalSignal?: AbortSignal;
}

/** How a remember() call landed. "stored" = plain POST add (or fallback after a
 *  discovery failure); "updated" = the existing data item was PATCHed (delta
 *  re-ingestion, chunk-level diff server-side); "unchanged" = content hash-
 *  identical to the stored copy — nothing was sent. Only the explicit-filename
 *  (real file upload) lane can produce "updated"/"unchanged"; prose memories
 *  use timestamped synthetic names and stay append-only by design. */
type RememberOutcome = "stored" | "updated" | "unchanged";

/** Structured outcome of the update path (PATCH /api/v1/update). */
interface RememberUpdateInfo {
	/** Server status: incremental | unchanged | full_rebuild ("failed" returns ok:false). */
	status: string;
	/** One compact line for humans: "+3/−1 chunks, 12 kept" / "memory dropped and rebuilt (fallback: …)". */
	detail: string;
}

export interface RememberResult {
	ok: boolean;
	status?: number;
	outcome?: RememberOutcome;
	datasetId?: string;
	/** The data item's UUID (update/unchanged paths) — the handle for a targeted forget. */
	dataId?: string;
	pipelineRunId?: string;
	update?: RememberUpdateInfo;
	error?: CogneeError;
}

export interface QaEntry {
	type: "qa";
	question: string;
	answer: string;
	context?: string;
}

/** OpenAPI TraceEntry moved to helpers/tracing (next to buildTraceEntry) —
 *  re-exported here for compatibility with client-side consumers. */
export type { TraceEntry } from "../helpers/tracing";

export type ImproveOutcome = "ok" | "busy" | "unsupported" | "error";

export interface DatasetInfo {
	name: string;
	id: string;
	owner_id?: string;
	ownerId?: string;
	/** Creation timestamp (newest spelling wins; used for canonical pick). */
	created_at?: string;
}

export interface DataItemInfo {
	id: string;
	name?: string;
	created_at?: string;
}

export interface SessionQaRow {
	question?: string;
	answer?: string;
	context?: string;
	[key: string]: unknown;
}

/** A trace row of `GET /api/v1/sessions/{id}` — the server echoes the stored
 *  TraceEntry fields (v0.4: verify-before-replay fingerprints traces too). */
export interface SessionTraceRow {
	origin_function?: string;
	status?: string;
	method_params?: Record<string, unknown>;
	method_return_value?: unknown;
	error_message?: string;
	[key: string]: unknown;
}

/** openapi capability verdict (§2.2): `probed: false` = unreachable/unparseable. */
export interface CapabilityVerdict {
	probed: boolean;
	/** Provision POST advertises the create_only contract. */
	provisioning: boolean;
	/** remember/entry carries x-cognee-session-dataset-ids: true. */
	typedDatasetIds: boolean;
}

/** ~/.cognee-plugin/pi/agent-key.json (spec §3.2; the reference's agent_key.json). */
export interface AgentKeyRecord {
	base_url: string;
	api_key: string;
	agent_id: string;
	plugin_key: string;
	/** sha256(principal key) — binds the identity to the principal that minted it. */
	principal_fingerprint: string;
	updated_at: string;
	/** Stamped when the server rejects the key; never auto-re-provisioned. */
	blocked?: boolean;
}

export interface CachedApiKeyFile {
	base_url?: unknown;
	api_key?: unknown;
}

export interface RawFetchOptions {
	method: string;
	headers?: Record<string, string>;
	body?: string | FormData;
	timeoutMs: number;
	externalSignal?: AbortSignal;
	/** Single small retry on connect errors — idempotent requests only (writes never retry). */
	retryOnConnect?: boolean;
}
