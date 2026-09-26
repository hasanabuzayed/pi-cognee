/**
 * pi-cognee — HTTP client for the cognee memory server (data plane).
 *
 * Node 18+ only: global fetch / FormData / Blob. No npm dependencies.
 * Composition: transport.ts (HTTP), identity.ts (principal/agent key policy),
 * provisioning.ts (shared-agent-memory control plane) — this class keeps the
 * memory/dataset API methods and delegates the rest.
 *
 * Contract source: research/codex-api-brief.md (byte-identical HTTP layer shared by
 * the official Claude Code and Codex cognee plugins).
 */

import { createHash } from "node:crypto";
import type { CogneeConfig } from "../config/types";
import { canonicalUuid, isUuid, sanitizeDatasetName } from "../helpers";
import {
	CogneeError,
	errorStringFromUpdateBody,
	wrapAsCogneeError,
} from "../helpers/errors";
import type { HealthResult } from "../helpers/types";
import {
	parseOpenapiCapabilities,
	type ProvisionResult,
	type SharedMemoryOutcome,
	type WritableDatasetsListing,
} from "../contract";
import { ClientIdentity } from "./identity";
import { SharedMemoryProvisioner } from "./provisioning";
import { healthCheck, jsonRequest, rawFetch } from "./transport";
import type {
	CapabilityVerdict,
	DataItemInfo,
	DatasetInfo,
	ImproveOutcome,
	QaEntry,
	RawFetchOptions,
	RecallItem,
	RecallParams,
	RecallResult,
	RememberParams,
	RememberResult,
	SessionQaRow,
	SessionTraceRow,
	TraceEntry,
} from "./types";

export class CogneeClient {
	readonly cfg: CogneeConfig;
	/** Principal/agent-key policy (env → cached owner → lazy mint → plugin identity). */
	readonly identity: ClientIdentity;
	/** Shared-agent-memory control plane (composed — delegates below). */
	readonly sharedMemory: SharedMemoryProvisioner;

	/** openapi capability cache — one probe per session start + 60 s TTL (§2.2). */
	private capabilityCache:
		| { at: number; verdict: CapabilityVerdict }
		| undefined;

	constructor(cfg: CogneeConfig) {
		this.cfg = cfg;
		this.identity = new ClientIdentity(cfg);
		this.sharedMemory = new SharedMemoryProvisioner(this);
	}

	/* ----- transport delegation (implementation in ./transport) ----- */

	/** Raw HTTP with timeout/abort/classification — public for the provisioner. */
	rawFetch(
		url: string,
		opts: RawFetchOptions,
	): Promise<Response & { readText(): Promise<string> }> {
		return rawFetch(url, opts);
	}

	private jsonRequest<T>(
		method: string,
		path: string,
		opts: {
			json?: unknown;
			timeoutMs?: number;
			externalSignal?: AbortSignal;
			retryOnConnect?: boolean;
		} = {},
	) {
		return jsonRequest<T>(this.identity, this.cfg, method, path, opts);
	}

	/** Liveness probe. Any status < 500 counts as reachable (per the server contract). */
	async health(
		timeoutMs: number = this.cfg.healthTimeoutMs,
	): Promise<HealthResult> {
		return healthCheck(this.cfg, timeoutMs);
	}

	/* ----- identity delegation (implementation in ./identity) ----- */

	get activeAgentKey(): string | undefined {
		return this.identity.activeAgentKey;
	}
	get activeAgentId(): string | undefined {
		return this.identity.activeAgentId;
	}
	get identityProblem(): string | undefined {
		return this.identity.identityProblem;
	}
	get identityProblemKind(): string | undefined {
		return this.identity.identityProblemKind;
	}
	refreshAgentIdentity(): void {
		this.identity.refreshAgentIdentity();
	}
	dropAgentIdentity(): void {
		this.identity.dropAgentIdentity();
	}
	principalKey(): string | undefined {
		return this.identity.principalKey();
	}
	keyFingerprint(): string {
		return this.identity.keyFingerprint();
	}
	authSummary(): string {
		return this.identity.authSummary();
	}
	ensurePrincipalCached(): void {
		this.identity.ensurePrincipalCached();
	}
	ensureAuth(): Promise<void> {
		return this.identity.ensureAuth();
	}

	/* ----- shared-memory provisioning delegation (./provisioning) ----- */

	provisionPluginAgent(timeoutMs: number = 20_000): Promise<ProvisionResult> {
		return this.sharedMemory.provisionPluginAgent(timeoutMs);
	}
	disconnectPluginAgent(timeoutMs: number = 20_000): Promise<boolean> {
		return this.sharedMemory.disconnectPluginAgent(timeoutMs);
	}
	ensureSharedMemory(
		opts: {
			dataset?: string;
			allowSetup?: boolean;
			agentKey?: string;
			agentId?: string;
			timeoutMs?: number;
		} = {},
	): Promise<SharedMemoryOutcome> {
		return this.sharedMemory.ensureSharedMemory(opts);
	}
	resolveSharedDataset(
		dataset: string,
		timeoutMs: number = 15_000,
	): Promise<SharedMemoryOutcome> {
		return this.sharedMemory.resolveSharedDataset(dataset, timeoutMs);
	}
	listWritableDatasets(
		timeoutMs: number = 15_000,
	): Promise<WritableDatasetsListing> {
		return this.sharedMemory.listWritableDatasets(timeoutMs);
	}

	/**
	 * POST /api/v1/recall. Dataset addressing mirrors _dataset_access.py
	 * recall_fields(): a UUID-shaped dataset value → dataset_ids (canonicalized —
	 * "Dataset UUIDs are authoritative; names are only for owned datasets"), a
	 * plain name → datasets, neither → server default. The session binding stays
	 * attached outside the federated path (only federation drops it, like the
	 * reference). 404 on graph scope = authoritative empty (no graph yet) and is
	 * returned as ok with noGraph=true.
	 *
	 * Federation (research/federation-brief.md, mirroring _dataset_access.py):
	 * on an EXACT ["graph"] scope with COGNEE_PLUGIN_READ_DATASET_IDS configured, the
	 * payload addresses the federated read set via dataset_ids ONLY — dataset/datasets
	 * and session_id are dropped ("session history remains bound to ONE dataset.
	 * Federated graph recall is a separate read"). Precedence: env federation >
	 * explicit datasetIds > dataset name; the code lane (scope=["code"]) never
	 * federates. Writes never consult the federation config.
	 *
	 * Renamed body keys are dual-spelled (snake_case for cognee ≤ 1.5.x, camelCase per
	 * the 1.6.0 RecallPayloadDTO schema) — each server version reads the spelling it
	 * knows and ignores the other; query/scope/datasets never changed casing.
	 */
	async recall(params: RecallParams): Promise<RecallResult> {
		const scope = params.scope ?? ["graph"];
		const topK = Math.max(1, params.topK ?? 5);
		const onlyContext = params.onlyContext ?? true;
		const body: Record<string, unknown> = {
			query: params.query,
			top_k: topK,
			topK,
			only_context: onlyContext,
			onlyContext,
			scope,
		};
		if (params.searchType) {
			body.search_type = params.searchType;
			body.searchType = params.searchType;
		}
		// Exact ["graph"]-scope gate only — any other scope (e.g. ["graph","session"],
		// ["code"]) keeps normal name addressing and the session binding.
		const graphOnly = scope.length === 1 && scope[0] === "graph";
		if (graphOnly && this.cfg.readDatasetIds?.length) {
			body.dataset_ids = this.cfg.readDatasetIds;
			body.datasetIds = this.cfg.readDatasetIds;
		} else if (params.datasetIds?.length) {
			body.dataset_ids = params.datasetIds;
			body.datasetIds = params.datasetIds;
		} else {
			// Reference recall_fields(): a UUID-shaped dataset value is authoritative —
			// address dataset_ids (canonicalized); a plain name addresses datasets. The
			// session binding stays attached in both cases (only federation drops it).
			const ident = canonicalUuid(params.dataset);
			if (ident) {
				body.dataset_ids = [ident];
				body.datasetIds = [ident];
			} else if (params.dataset) {
				body.datasets = [
					params.datasetPresanitized
						? params.dataset
						: sanitizeDatasetName(params.dataset),
				];
			}
			if (params.sessionId) {
				body.session_id = params.sessionId;
				body.sessionId = params.sessionId;
			}
		}
		if (params.codeQuery && scope.includes("code")) {
			body.code_query = params.codeQuery;
			body.codeQuery = params.codeQuery;
		}

		const r = await this.jsonRequest<unknown>("POST", "/api/v1/recall", {
			json: body,
			timeoutMs: params.timeoutMs ?? this.cfg.requestTimeoutMs,
			externalSignal: params.externalSignal,
		});
		if (!r.ok) {
			if (r.error.status === 404)
				return { ok: true, items: [], noGraph: true };
			return { ok: false, items: [], error: r.error };
		}
		const items = Array.isArray(r.data) ? (r.data as RecallItem[]) : [];
		return { ok: true, items };
	}

	/**
	 * POST /api/v1/remember — multipart. The file part keeps a real .txt basename so the
	 * server routes it through the prose LLM pipeline (code extensions go the zero-LLM route).
	 * run_in_background defaults to cfg.rememberBackground (COGNEE_REMEMBER_BACKGROUND —
	 * set false for a synchronous, immediately-queryable write, like the reference).
	 *
	 * Update-when-changed (v0.3): when `filename` is EXPLICITLY set (a real file upload,
	 * never the synthetic prose timestamp), the client first discovers the data item
	 * previously ingested under that basename and either no-ops (identical bytes) or
	 * PATCHes it (chunk-level diff server-side) instead of adding a duplicate. Every
	 * discovery failure degrades to the plain add below — see updateExistingFileIfChanged.
	 */
	async remember(params: RememberParams): Promise<RememberResult> {
		try {
			await this.identity.ensureAuth(); // no-op once a key is resolved (or off-loopback)
			const usedKey = this.identity.effectiveKey();
			if (params.filename) {
				const delta = await this.updateExistingFileIfChanged(params);
				if (delta) return delta; // handled (unchanged / updated / hard error)
			}
			const form = new FormData();
			form.set("node_set", params.nodeSet ?? "user_context");
			form.set(
				"run_in_background",
				String(params.background ?? this.cfg.rememberBackground),
			);
			if (params.datasetId) form.set("datasetId", params.datasetId);
			else if (params.dataset) {
				// Reference write_fields(): a UUID-shaped dataset value addresses
				// datasetId (canonicalized — UUIDs are authoritative), a plain name
				// addresses datasetName.
				const ident = canonicalUuid(params.dataset);
				if (ident) form.set("datasetId", ident);
				else
					form.set(
						"datasetName",
						sanitizeDatasetName(params.dataset),
					);
			}
			const filename =
				params.filename ??
				`pi-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
			form.set(
				"data",
				new Blob([params.content], { type: "text/plain" }),
				filename,
			);

			const resp = await this.rawFetch(
				`${this.cfg.baseUrl}/api/v1/remember`,
				{
					method: "POST",
					headers: this.identity.authHeaders(),
					body: form,
					timeoutMs: params.timeoutMs ?? this.cfg.requestTimeoutMs,
					externalSignal: params.externalSignal,
				},
			);
			const text = await resp.readText();
			let data:
				| {
						error?: unknown;
						dataset_id?: string;
						datasetId?: string;
						pipeline_run_id?: string;
				  }
				| undefined;
			try {
				data = text ? (JSON.parse(text) as typeof data) : undefined;
			} catch {
				data = undefined;
			}
			if (!resp.ok) {
				if (resp.status === 401 || resp.status === 403)
					this.identity.rejectAgentKey(usedKey);
				return {
					ok: false,
					status: resp.status,
					error: new CogneeError(
						`HTTP ${resp.status} POST /api/v1/remember: ${String(text).slice(0, 300)}`,
						{ status: resp.status },
					),
				};
			}
			// The server may report errors inside a 2xx body.
			if (data && typeof data.error === "string") {
				return {
					ok: false,
					status: resp.status,
					error: new CogneeError(`server error: ${data.error}`),
				};
			}
			return {
				ok: true,
				status: resp.status,
				outcome: "stored",
				datasetId: data?.dataset_id ?? data?.datasetId,
				pipelineRunId: data?.pipeline_run_id,
			};
		} catch (err) {
			return { ok: false, error: wrapAsCogneeError(err) };
		}
	}

	/**
	 * Update-when-changed for an explicit-filename remember (v0.3): discover the
	 * data item previously ingested under this basename (exact `name` match,
	 * latest `createdAt` on same-name twins), compare content hashes statelessly,
	 * and either no-op (identical), PATCH /api/v1/update (changed — chunk-level
	 * diff server-side), or signal the caller to fall back to a plain add
	 * (returns undefined: dataset/item listing failed, name never ingested, or
	 * the item vanished mid-flight — the 404 race with forget). A FAILED update
	 * returns ok:false WITHOUT a plain-add fallback: the document still exists,
	 * and a duplicate add would corrupt its identity. Never throws.
	 */
	private async updateExistingFileIfChanged(
		params: RememberParams,
	): Promise<RememberResult | undefined> {
		try {
			if (!params.filename) return undefined;
			// 1. Dataset UUID — the data-item routes are UUID-addressed. A UUID-shaped
			//    dataset value (datasetId or dataset) is used as-is; a plain name is
			//    resolved via one extra GET. A NAME-shaped datasetId addresses
			//    datasetName — the explicit dataset param wins over it (mirrors
			//    write_fields()' routing; no caller mixes them today, defensive).
			const dsParam = canonicalUuid(params.datasetId ?? "")
				? params.datasetId
				: (params.dataset ?? params.datasetId);
			let datasetId = canonicalUuid(dsParam ?? "");
			if (!datasetId && dsParam) {
				const listed = await this.listDatasets();
				if (!listed.ok) return undefined; // discovery failed → fail open to a plain add
				const hit = listed.datasets.find(
					(d) => d.name === sanitizeDatasetName(dsParam!),
				);
				if (!hit?.id) return undefined; // name not on the server yet → plain add creates it
				datasetId = canonicalUuid(hit.id);
			}
			if (!datasetId) return undefined;
			// 2. Exact basename match; latest createdAt wins on same-name twins (the
			//    hash compare below is the safety net — identical content no-ops
			//    regardless of which twin matched).
			const items = await this.listDataItems(datasetId);
			if (!items.ok) return undefined;
			const matches = items.items.filter(
				(i) => i.name === params.filename && canonicalUuid(i.id),
			);
			if (matches.length === 0) return undefined; // never ingested under this name → plain add
			let item = matches[0];
			for (const m of matches) {
				if ((m.created_at ?? "") >= (item.created_at ?? "")) item = m; // ISO sort, ties → last
			}
			const dataId = canonicalUuid(item.id);
			// 3. Stateless content compare: identical bytes → authoritative no-op
			//    (nothing sent). Raw unreadable/shape-mismatch → treat as changed; the
			//    server-side "unchanged" status is the backstop.
			const localHash = createHash("sha256")
				.update(params.content, "utf8")
				.digest("hex");
			const raw = await this.getDataItemRaw(datasetId, dataId);
			if (
				raw.ok &&
				createHash("sha256").update(raw.text, "utf8").digest("hex") ===
					localHash
			) {
				return {
					ok: true,
					outcome: "unchanged",
					dataId,
					update: {
						status: "unchanged",
						detail: "identical to the stored copy",
					},
				};
			}
			// 4. Changed → PATCH under the same data_id (server diffs chunks; falls
			//    back to a delete+re-ingest transparently, also under the same id).
			const update = await this.updateDataItem({
				datasetId,
				dataId,
				content: params.content,
				filename: params.filename,
				externalSignal: params.externalSignal,
			});
			if (update.ok) {
				return {
					ok: true,
					outcome: "updated",
					datasetId: update.datasetId || datasetId,
					dataId,
					pipelineRunId: update.pipelineRunId,
					update: {
						status: update.status ?? "update",
						detail: update.detail ?? "",
					},
				};
			}
			if (update.vanished) return undefined; // raced with forget → plain add re-creates it
			return { ok: false, outcome: "updated", error: update.error };
		} catch {
			return undefined; // discovery itself failed → plain add (fail open)
		}
	}

	/**
	 * PATCH /api/v1/update — replace the stored content of one data item under
	 * its stable `data_id` (cognee 1.6.0): chunk_level_diff defaults true server-
	 * side, so the server diffs the new content against the stored text and
	 * either replaces only the affected chunks or transparently falls back to a
	 * full delete+re-ingest — both keep the data_id. `node_set` and
	 * `chunk_level_diff` are deliberately omitted (the document already belongs
	 * to its node set; the default diff behavior is what we want). Both ids are
	 * canonicalized BEFORE the request — a non-UUID never leaves the client (the
	 * 422 guard). No retry (a write). A 404 means the item vanished since
	 * discovery (race with forget) and is reported as vanished:true so the caller
	 * can fall back to a plain add. A 500 carries either an UpdateResult with
	 * status:"failed" or an ErrorResponse — parsed leniently either way.
	 */
	async updateDataItem(params: {
		datasetId: string;
		dataId: string;
		content: string;
		filename: string;
		timeoutMs?: number;
		externalSignal?: AbortSignal;
	}): Promise<{
		ok: boolean;
		status?: string;
		datasetId?: string;
		pipelineRunId?: string;
		/** Compact human summary of the chunk counters / rebuild fallback. */
		detail?: string;
		/** 404 — data_id resolves to no document: fall back to a plain add. */
		vanished?: boolean;
		error?: CogneeError;
	}> {
		const dataId = canonicalUuid(params.dataId);
		const datasetId = canonicalUuid(params.datasetId);
		if (!dataId || !datasetId) {
			return {
				ok: false,
				error: new CogneeError(
					`update needs UUID data_id and dataset_id (got data_id '${params.dataId}', dataset_id '${params.datasetId}')`,
				),
			};
		}
		try {
			await this.identity.ensureAuth();
			const form = new FormData();
			// Same Blob+basename construction as the remember file lane: the part's
			// filename is the loader-routing signal (code extensions stay code).
			form.set(
				"data",
				new Blob([params.content], { type: "text/plain" }),
				params.filename,
			);
			const resp = await this.rawFetch(
				`${this.cfg.baseUrl}/api/v1/update?data_id=${dataId}&dataset_id=${datasetId}`,
				{
					method: "PATCH",
					headers: this.identity.authHeaders(),
					body: form,
					timeoutMs: params.timeoutMs ?? this.cfg.requestTimeoutMs,
					externalSignal: params.externalSignal,
				},
			);
			const text = await resp.readText();
			let data: Record<string, unknown> | undefined;
			try {
				data = text
					? (JSON.parse(text) as Record<string, unknown>)
					: undefined;
			} catch {
				data = undefined;
			}
			if (data && typeof data === "object" && data.status === "failed") {
				// "failed" rides a 200 OR a 500 body (the spec documents both) — the
				// rebuild's cognify run errored; retryable, and the document still exists.
				const errObj = data.error as { message?: unknown } | undefined;
				const message =
					errObj &&
					typeof errObj === "object" &&
					typeof errObj.message === "string" &&
					errObj.message
						? errObj.message
						: "the rebuild's cognify run errored";
				return {
					ok: false,
					error: new CogneeError(
						`update failed server-side: ${message} — retryable; the document still exists (re-run the same remember to retry)`,
					),
				};
			}
			if (resp.status === 404) {
				return {
					ok: false,
					vanished: true,
					error: new CogneeError(
						`HTTP 404 PATCH /api/v1/update: ${String(text).slice(0, 200) || "data item no longer exists"}`,
						{
							status: 404,
						},
					),
				};
			}
			if (!resp.ok) {
				const detail =
					(data && typeof data === "object"
						? errorStringFromUpdateBody(data)
						: undefined) ?? String(text).slice(0, 300);
				return {
					ok: false,
					error: new CogneeError(
						`HTTP ${resp.status} PATCH /api/v1/update: ${detail}`,
						{
							status: resp.status,
						},
					),
				};
			}
			if (
				!data ||
				typeof data !== "object" ||
				typeof data.status !== "string" ||
				!data.status
			) {
				// A 2xx the caller cannot parse is NOT success — the outcome is unknown,
				// and the document may already be updated (never silently re-add).
				return {
					ok: false,
					error: new CogneeError(
						"malformed JSON response from PATCH /api/v1/update",
					),
				};
			}
			const status = data.status;
			const known =
				status === "incremental" ||
				status === "unchanged" ||
				status === "full_rebuild";
			return {
				ok: true,
				status,
				datasetId:
					typeof data.dataset_id === "string"
						? data.dataset_id
						: datasetId,
				pipelineRunId:
					typeof data.pipeline_run_id === "string"
						? data.pipeline_run_id
						: undefined,
				detail: known ? updateSummaryLine(data) : String(status),
			};
		} catch (err) {
			return { ok: false, error: wrapAsCogneeError(err) };
		}
	}

	/**
	 * POST /api/v1/remember with content_type="code" — submits one repository
	 * for code-graph (enola) indexing. Mirrors _code_graph.py field-for-field:
	 * datasetName, content_type=code, raw_data=<repo-spec>, run_in_background,
	 * index_vectors. Requires cognee >= 1.5.4 (1.5.4 renamed `repositories` →
	 * `raw_data`; only the new name is sent). No LLM/embedding calls — fast and
	 * deterministic. A timeout is surfaced transient (the submission may have
	 * landed); unreachable means positively absent, nothing was submitted.
	 */
	async indexCodeRepo(params: {
		repoSpec: string;
		dataset: string;
		indexVectors?: boolean;
		background?: boolean;
		timeoutMs?: number;
	}): Promise<{
		ok: boolean;
		status?: number;
		datasetId?: string;
		pipelineRunId?: string;
		serverStatus?: string;
		items?: unknown;
		error?: CogneeError;
	}> {
		try {
			await this.identity.ensureAuth();
			const form = new FormData();
			// No re-sanitize: callers pass either an already-sanitized explicit name or a
			// codeDatasetName() product (charset-clean by construction) — the 100-char cap
			// would truncate long-repo names and desync from the official plugins.
			form.set("datasetName", params.dataset);
			form.set("content_type", "code");
			form.set("raw_data", String(params.repoSpec));
			form.set("run_in_background", String(params.background ?? true));
			form.set("index_vectors", String(params.indexVectors ?? false));
			const resp = await this.rawFetch(
				`${this.cfg.baseUrl}/api/v1/remember`,
				{
					method: "POST",
					headers: this.identity.authHeaders(),
					body: form,
					timeoutMs: params.timeoutMs ?? this.cfg.codeIndexTimeoutMs,
				},
			);
			const text = await resp.readText();
			let data:
				| {
						error?: unknown;
						detail?: unknown;
						dataset_id?: unknown;
						pipeline_run_id?: unknown;
						status?: unknown;
						items?: unknown;
				  }
				| undefined;
			try {
				data = text ? (JSON.parse(text) as typeof data) : undefined;
			} catch {
				data = undefined;
			}
			const detail = String(
				(data &&
					typeof data === "object" &&
					(data.detail ?? data.error)) ||
					text ||
					"",
			).slice(0, 300);
			if (!resp.ok) {
				let message = `HTTP ${resp.status} POST /api/v1/remember (code): ${detail}`;
				if (resp.status === 401 || resp.status === 403) {
					message = `unauthorized (HTTP ${resp.status}) — check COGNEE_API_KEY / credentials`;
				} else if (
					resp.status === 400 &&
					detail.toLowerCase().includes("unsupported content_type")
				) {
					// Matching on the full phrase only: a current server's code-branch 400s
					// all name the field and must fall through as contract errors.
					message =
						"server rejected content_type='code' — repo indexing requires cognee >= 1.5.4; " +
						`upgrade the server. Detail: ${detail}`;
				}
				return {
					ok: false,
					status: resp.status,
					error: new CogneeError(message, { status: resp.status }),
				};
			}
			// A 2xx the caller cannot parse is NOT success — callers advance the repo's
			// stored fingerprint on ok, so an unparseable body would mark edits indexed.
			if (!data || typeof data !== "object") {
				return {
					ok: false,
					status: resp.status,
					error: new CogneeError(
						"malformed JSON response from /api/v1/remember (code)",
					),
				};
			}
			if (typeof data.error === "string" && data.error) {
				return {
					ok: false,
					status: resp.status,
					error: new CogneeError(
						`server error: ${data.error.slice(0, 200)}`,
					),
				};
			}
			return {
				ok: true,
				status: resp.status,
				datasetId:
					typeof data.dataset_id === "string"
						? data.dataset_id
						: undefined,
				pipelineRunId:
					typeof data.pipeline_run_id === "string"
						? data.pipeline_run_id
						: undefined,
				serverStatus:
					typeof data.status === "string" ? data.status : undefined,
				items: data.items,
			};
		} catch (err) {
			return { ok: false, error: wrapAsCogneeError(err) };
		}
	}

	/** GET /api/v1/datasets/status?dataset=<id>&pipeline=code_graph_pipeline (poll helper). */
	async codeGraphStatus(
		datasetId: string,
		timeoutMs?: number,
	): Promise<{ ok: boolean; status?: string; error?: CogneeError }> {
		return this.datasetStatus(datasetId, "code_graph_pipeline", timeoutMs);
	}

	/**
	 * Deterministic code-graph search — POST /api/v1/recall with scope=["code"]
	 * (the exact endpoint cognee-search.sh --code uses). Without `codeQuery` the
	 * seed text is the query (exact/suffix/substring match); with it, one exact
	 * operation runs (query_facts, explore, traverse, find_path, impact_analysis,
	 * delta). session_id is optional and, when given, attached exactly like the
	 * reference auto lane does ("session_id attached on the code scope too" — the
	 * server keeps the binding to the session dataset, not the code one).
	 * No CLI fallback exists for this route — unreachable means "not run".
	 */
	async codeSearch(params: {
		seed: string;
		codeQuery?: Record<string, unknown>;
		dataset: string;
		topK?: number;
		/** Attached on the code scope too (the reference's auto lane sends it); the
		 *  server binds session ids to the session dataset, never to the code one. */
		sessionId?: string;
		timeoutMs?: number;
		externalSignal?: AbortSignal;
	}): Promise<RecallResult> {
		return this.recall({
			query: params.seed,
			sessionId: params.sessionId,
			topK: params.topK ?? 5,
			onlyContext: true,
			scope: ["code"],
			dataset: params.dataset,
			datasetPresanitized: true,
			codeQuery: params.codeQuery,
			timeoutMs: params.timeoutMs ?? this.cfg.requestTimeoutMs,
			externalSignal: params.externalSignal,
		});
	}

	/** POST /api/v1/remember/entry — writes one typed entry into the server-side
	 *  session cache. The server dispatches on entry.type ("qa" | "trace").
	 *  Under shared memory the resolved canonical UUID (datasetId) addresses the
	 *  write instead of the name (§3.5 — a name only resolves among the CALLER's
	 *  own datasets, so an agent writing by name would fork a private copy). */
	async rememberEntry(
		entry: QaEntry | TraceEntry,
		sessionId: string,
		dataset: string,
		timeoutMs?: number,
		datasetId?: string,
	): Promise<{ ok: boolean; error?: CogneeError }> {
		const ident = datasetId ? canonicalUuid(datasetId) : "";
		const body: Record<string, unknown> = ident
			? { entry, session_id: sessionId, dataset_id: ident }
			: {
					entry,
					session_id: sessionId,
					dataset_name: sanitizeDatasetName(dataset),
				};
		const r = await this.jsonRequest<unknown>(
			"POST",
			"/api/v1/remember/entry",
			{
				json: body,
				timeoutMs,
			},
		);
		return r.ok ? { ok: true } : { ok: false, error: r.error };
	}

	/**
	 * POST /api/v1/improve — promotes the server-side session cache into the permanent graph.
	 * cognee 1.6.0 answers with a typed ImproveResult whose REQUIRED status enum maps to
	 * outcomes: running → busy, errored → error, completed/skipped → ok. The legacy
	 * pre-1.6 signals stay honored: empty-object body = per-session improve lock held
	 * (busy, never retried); 404/405/422 = improve_unsupported. Body keys are
	 * dual-spelled (snake_case ≤ 1.5.x, camelCase per ImprovePayloadDTO in 1.6.0).
	 */
	async improve(
		sessionId: string,
		dataset: string | undefined,
		timeoutMs: number = this.cfg.improveSubmitTimeoutMs,
		externalSignal?: AbortSignal,
	): Promise<{ outcome: ImproveOutcome; error?: CogneeError }> {
		const body: Record<string, unknown> = {
			session_ids: [sessionId],
			sessionIds: [sessionId],
			run_in_background: true,
			runInBackground: true,
		};
		if (dataset) {
			if (isUuid(dataset)) {
				body.dataset_id = dataset;
				body.datasetId = dataset;
			} else {
				const name = sanitizeDatasetName(dataset);
				body.dataset_name = name;
				body.datasetName = name;
			}
		}
		const r = await this.jsonRequest<unknown>("POST", "/api/v1/improve", {
			json: body,
			timeoutMs,
			externalSignal,
		});
		if (!r.ok) {
			const status = r.error.status ?? 0;
			if (status === 404 || status === 405 || status === 422) {
				return { outcome: "unsupported", error: r.error };
			}
			return { outcome: "error", error: r.error };
		}
		const data = r.data;
		if (data && typeof data === "object" && !Array.isArray(data)) {
			const result = data as { status?: unknown; error?: unknown };
			if (result.status === "running") return { outcome: "busy" };
			if (result.status === "errored") {
				const detail =
					typeof result.error === "string" && result.error
						? result.error
						: "pipeline errored";
				return {
					outcome: "error",
					error: new CogneeError(`improve errored: ${detail}`),
				};
			}
			if (result.status === "completed" || result.status === "skipped")
				return { outcome: "ok" };
			// Unknown or absent status: pre-1.6 untyped body — keep the legacy signals.
			if (Object.keys(result).length === 0) return { outcome: "busy" };
		}
		return { outcome: "ok" };
	}

	/** GET /api/v1/datasets — the caller's full read set. */
	async listDatasets(
		timeoutMs?: number,
	): Promise<{ ok: boolean; datasets: DatasetInfo[]; error?: CogneeError }> {
		const r = await this.jsonRequest<unknown>("GET", "/api/v1/datasets", {
			timeoutMs,
			retryOnConnect: true,
		});
		if (!r.ok) return { ok: false, datasets: [], error: r.error };
		const data = r.data;
		const list = Array.isArray(data)
			? data
			: data &&
				  typeof data === "object" &&
				  Array.isArray((data as { datasets?: unknown[] }).datasets)
				? (data as { datasets: unknown[] }).datasets
				: [];
		const datasets = list
			.filter(
				(d): d is Record<string, unknown> =>
					Boolean(d) && typeof d === "object",
			)
			.map((d) => ({
				name: String(d.name ?? ""),
				id: String(d.id ?? ""),
				owner_id:
					typeof d.owner_id === "string" ? d.owner_id : undefined,
				ownerId: typeof d.ownerId === "string" ? d.ownerId : undefined,
				created_at:
					typeof d.created_at === "string"
						? d.created_at
						: typeof d.createdAt === "string"
							? d.createdAt
							: undefined,
			}))
			.filter((d) => d.name || d.id);
		return { ok: true, datasets };
	}

	/** POST /api/v1/datasets — idempotent ensure. */
	async ensureDataset(
		name: string,
		timeoutMs?: number,
	): Promise<{ ok: boolean; error?: CogneeError }> {
		const r = await this.jsonRequest<unknown>("POST", "/api/v1/datasets", {
			json: { name: sanitizeDatasetName(name) },
			timeoutMs,
		});
		return r.ok ? { ok: true } : { ok: false, error: r.error };
	}

	/** One stored data item (forget-flow discovery). */
	async listDataItems(
		datasetId: string,
		timeoutMs?: number,
	): Promise<{ ok: boolean; items: DataItemInfo[]; error?: CogneeError }> {
		const r = await this.jsonRequest<unknown>(
			"GET",
			`/api/v1/datasets/${encodeURIComponent(datasetId)}/data`,
			{
				timeoutMs,
				retryOnConnect: true,
			},
		);
		if (!r.ok) return { ok: false, items: [], error: r.error };
		const data = r.data;
		const list = Array.isArray(data)
			? data
			: data &&
				  typeof data === "object" &&
				  Array.isArray((data as { data?: unknown[] }).data)
				? (data as { data: unknown[] }).data
				: [];
		const items = list
			.filter(
				(d): d is Record<string, unknown> =>
					Boolean(d) && typeof d === "object",
			)
			.map((d) => ({
				id: String(d.id ?? d.data_id ?? ""),
				name: typeof d.name === "string" ? d.name : undefined,
				// 1.6.0 renamed created_at → createdAt in DataDTO; probe both spellings.
				created_at:
					typeof d.created_at === "string"
						? d.created_at
						: typeof d.createdAt === "string"
							? d.createdAt
							: undefined,
			}))
			.filter((d) => d.id);
		return { ok: true, items };
	}

	/** GET /api/v1/datasets/{uuid}/data/{dataId}/raw — raw stored text (delete preview). */
	async getDataItemRaw(
		datasetId: string,
		dataId: string,
		timeoutMs?: number,
	): Promise<{ ok: boolean; text: string; error?: CogneeError }> {
		const r = await this.jsonRequest<unknown>(
			"GET",
			`/api/v1/datasets/${encodeURIComponent(datasetId)}/data/${encodeURIComponent(dataId)}/raw`,
			{ timeoutMs, retryOnConnect: true },
		);
		if (!r.ok) return { ok: false, text: "", error: r.error };
		const data = r.data;
		const text =
			typeof data === "string"
				? data
				: data && typeof data === "object"
					? String(
							(data as Record<string, unknown>).content ??
								(data as Record<string, unknown>).text ??
								(data as Record<string, unknown>).raw ??
								JSON.stringify(data),
						)
					: "";
		return { ok: true, text };
	}

	/** GET /api/v1/datasets/status?dataset=<uuid>&pipeline=cognify_pipeline */
	async datasetStatus(
		datasetId: string,
		pipeline = "cognify_pipeline",
		timeoutMs?: number,
	): Promise<{ ok: boolean; status?: string; error?: CogneeError }> {
		const r = await this.jsonRequest<Record<string, unknown>>(
			"GET",
			`/api/v1/datasets/status?dataset=${encodeURIComponent(datasetId)}&pipeline=${encodeURIComponent(pipeline)}`,
			{ timeoutMs, retryOnConnect: true },
		);
		if (!r.ok) return { ok: false, error: r.error };
		const map = r.data;
		if (!map || typeof map !== "object") return { ok: true };
		const entry = map[datasetId] ?? Object.values(map)[0];
		if (entry && typeof entry === "object") {
			return {
				ok: true,
				status: String(
					(entry as Record<string, unknown>)[pipeline] ?? "",
				),
			};
		}
		if (typeof entry === "string") return { ok: true, status: entry };
		return { ok: true };
	}

	/** GET /api/v1/sessions/{id} — last ~20 QA/trace rows of the server-side
	 *  session cache (both kinds feed the bridge's verify-before-replay
	 *  fingerprints; `qas` stays first for existing callers). */
	async getSessionDetail(
		sessionId: string,
		timeoutMs?: number,
	): Promise<{
		ok: boolean;
		qas: SessionQaRow[];
		traces: SessionTraceRow[];
		error?: CogneeError;
	}> {
		const r = await this.jsonRequest<{ qas?: unknown; traces?: unknown }>(
			"GET",
			`/api/v1/sessions/${encodeURIComponent(sessionId)}`,
			{ timeoutMs, retryOnConnect: true },
		);
		if (!r.ok) return { ok: false, qas: [], traces: [], error: r.error };
		const qas = Array.isArray(r.data?.qas)
			? (r.data.qas as SessionQaRow[])
			: Array.isArray(r.data)
				? (r.data as unknown as SessionQaRow[])
				: [];
		const traces = Array.isArray(r.data?.traces)
			? (r.data.traces as SessionTraceRow[])
			: [];
		return { ok: true, qas, traces };
	}

	/** POST /api/v1/forget — irreversible. dataId omitted ⇒ whole-dataset scope. */
	async forget(
		datasetId: string,
		dataId?: string,
		timeoutMs?: number,
	): Promise<{ ok: boolean; error?: CogneeError }> {
		const json: Record<string, unknown> = dataId
			? { datasetId, dataId }
			: { datasetId };
		const r = await this.jsonRequest<unknown>("POST", "/api/v1/forget", {
			json,
			timeoutMs,
		});
		return r.ok ? { ok: true } : { ok: false, error: r.error };
	}
	/** GET /openapi.json capability verdict, cached for 60 s (one probe per
	 *  session start — §2.2). `probed: false` = unreachable/unparseable — never
	 *  blocks or fails startup; callers treat it conservatively. */
	async probeCapabilities(
		timeoutMs: number = 5000,
	): Promise<CapabilityVerdict> {
		const now = Date.now();
		if (this.capabilityCache && now - this.capabilityCache.at < 60_000) {
			return this.capabilityCache.verdict;
		}
		let verdict: CapabilityVerdict = {
			probed: false,
			provisioning: false,
			typedDatasetIds: false,
		};
		try {
			const key = this.identity.principalKey();
			const resp = await this.rawFetch(
				`${this.cfg.baseUrl}/openapi.json`,
				{
					method: "GET",
					headers: key ? { "X-Api-Key": key } : {},
					timeoutMs,
					retryOnConnect: true,
				},
			);
			const text = await resp.readText();
			if (resp.ok) {
				let spec: unknown;
				try {
					spec = text ? JSON.parse(text) : undefined;
				} catch {
					spec = undefined;
				}
				const parsed = parseOpenapiCapabilities(spec);
				if (parsed) {
					verdict = {
						probed: true,
						provisioning: parsed.createOnlyProvision,
						typedDatasetIds: parsed.typedDatasetIds,
					};
				}
			} else {
				// A server without an openapi document advertises neither capability
				// (the reference classifies 404/405 on openapi → provisioning unsupported).
				verdict = {
					probed: true,
					provisioning: false,
					typedDatasetIds: false,
				};
			}
		} catch {
			/* unreachable → not probed */
		}
		this.capabilityCache = { at: now, verdict };
		return verdict;
	}
}

/** One compact human line for an UpdateResult: "+3/−1 chunks, 12 kept"
 *  (incremental), "no content change" (unchanged), or "memory dropped and
 *  rebuilt (fallback: <reason>)" — counters are null on a rebuild by contract.
 *  (Was client/helpers.ts — single caller above.) */
function updateSummaryLine(data: Record<string, unknown>): string {
	const status = String(data.status ?? "");
	const num = (key: string): number | null => {
		const v = data[key];
		return typeof v === "number" && Number.isFinite(v) ? v : null;
	};
	const fallback = data.fallback;
	const reason =
		fallback &&
		typeof fallback === "object" &&
		typeof (fallback as { reason?: unknown }).reason === "string"
			? (fallback as { reason: string }).reason
			: "";
	if (status === "unchanged") return "no content change";
	if (status === "full_rebuild") {
		return `memory dropped and rebuilt${reason ? ` (fallback: ${reason})` : ""}`;
	}
	const parts: string[] = [];
	const added = num("added_chunks");
	const deleted = num("deleted_chunks");
	if (added !== null || deleted !== null)
		parts.push(`+${added ?? 0}/−${deleted ?? 0} chunks`);
	const kept = num("kept_chunks");
	if (kept !== null) parts.push(`${kept} kept`);
	const reused = num("reused_chunks");
	if (reused !== null && reused > 0) parts.push(`${reused} reused`);
	if (reason) parts.push(`fallback: ${reason}`);
	return parts.join(", ") || status;
}
