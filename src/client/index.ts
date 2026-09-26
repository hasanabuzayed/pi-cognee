/**
 * pi-cognee — HTTP client for the cognee memory server.
 *
 * Node 18+ only: global fetch / FormData / Blob. No npm dependencies.
 *
 * Contract source: research/codex-api-brief.md (byte-identical HTTP layer shared by
 * the official Claude Code and Codex cognee plugins).
 */

import { createHash } from "node:crypto";
import type { CogneeConfig } from "../config/types";
import {
	canonicalUuid,
	datasetKeyFingerprint,
	isLoopbackUrl,
	isUuid,
	logPluginEvent,
	principalFingerprint,
	rowStr,
	sanitizeDatasetName,
	sleep,
} from "../helpers";
import {
	CogneeError,
	describeError,
	errorStringFromUpdateBody,
	wrapAsCogneeError,
} from "../helpers/errors";
import { loadSharedMemoryMarker, saveSharedMemoryMarker } from "../state/shared_memory";
import type { HealthResult } from "../helpers/types";
import {
	AGENT_ROLE_NAME,
	type DatasetRow,
	GRANT_DENIED_RETRY_SECONDS,
	PLUGIN_KEY,
	type ProvisionResult,
	parseOpenapiCapabilities,
	pickCanonical,
	type SharedMemoryMarker,
	type SharedMemoryOutcome,
	separatedOutcome,
	validateProvisionResponse,
	type WritableDatasetsListing,
} from "../contract";
import { blockAgentKeyRecord, loadAgentKeyRecord } from "../state/agent_key";
import { loadCachedApiKey, saveCachedApiKey } from "../state/api_key";
import { updateSummaryLine } from "./helpers";
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

	/** Key minted by the lazy local owner bootstrap (session-lifetime fallback). */
	private mintedKey: string | undefined;
	private mintFailed = false;
	private mintPromise: Promise<void> | undefined;

	/* ----- v0.4 shared-agent-memory identity (spec §3.3) -----
	 * After the existing env → cached-owner (→ lazy mint) principal resolution,
	 * a cached plugin identity (agent-key.json) may take over the DATA plane.
	 * Usable exactly when: the record loads ∧ mode ≠ disabled ∧ a principal is
	 * known ∧ principal_fingerprint matches. The principal is retained for the
	 * CONTROL plane (owner-only server-side); strict-mode obstacles are surfaced
	 * as `identityProblem` (a one-line warning — pi never hard-fails startup,
	 * fail-soft divergence from the reference's raise). */
	private agentKey: string | undefined;
	private agentId: string | undefined;
	/** Reference-verbatim obstacle text for a cached-but-unusable identity. */
	identityProblem: string | undefined;
	/** Machine kind of the obstacle ("blocked" | "principal_mismatch" | "not_connected"). */
	identityProblemKind: string | undefined;
	/** openapi capability cache — one probe per session start + 60 s TTL (§2.2). */
	private capabilityCache:
		{ at: number; verdict: CapabilityVerdict } | undefined;

	constructor(cfg: CogneeConfig) {
		this.cfg = cfg;
		this.refreshAgentIdentity();
	}

	/** Re-evaluate the cached plugin identity against the current principal.
	 *  Sync + fail-soft (file read); called at construction and again after the
	 *  lazy local owner-key mint resolves a principal. */
	refreshAgentIdentity(): void {
		this.agentKey = undefined;
		this.agentId = undefined;
		this.identityProblem = undefined;
		this.identityProblemKind = undefined;
		if (this.cfg.pluginIdentity === "disabled") return;
		const record = loadAgentKeyRecord(this.cfg.baseUrl);
		if (!record) {
			if (this.cfg.pluginIdentity === "enabled") {
				this.identityProblem =
					"Plugin identity is enabled but not connected; run a session start to provision";
				this.identityProblemKind = "not_connected";
			}
			return;
		}
		const principal = this.cfg.apiKey ?? this.mintedKey;
		let problem = "";
		let kind = "";
		if (record.blocked) {
			problem =
				"Plugin identity was rejected; reconnect explicitly (no automatic rotation)";
			kind = "blocked";
		} else if (
			!principal ||
			record.principal_fingerprint !== principalFingerprint(principal)
		) {
			problem =
				"Plugin identity belongs to another or unverified principal; run a session start";
			kind = "principal_mismatch";
		}
		if (!problem) {
			this.agentKey = record.api_key;
			this.agentId = record.agent_id;
			return;
		}
		// A rejected or foreign identity is never used; `enabled` makes that an
		// error (pi: warning), `auto` keeps the plugin working as the principal.
		this.identityProblem = problem;
		this.identityProblemKind = kind;
	}

	/** The cached plugin identity's key when it is the credential in force. */
	get activeAgentKey(): string | undefined {
		return this.agentKey;
	}

	/** The cached plugin identity's agent id (shared memory wires BY id). */
	get activeAgentId(): string | undefined {
		return this.agentId;
	}

	/** Drop the in-memory identity (after revert/block) — subsequent calls run
	 *  as the principal for the rest of this process. */
	dropAgentIdentity(): void {
		this.agentKey = undefined;
		this.agentId = undefined;
	}

	/** The PARENT user's key, for control-plane calls — never the agent key
	 *  (reference principal_key_for_control_plane: an env key equal to the
	 *  cached agent key is the agent's, not the user's). */
	principalKey(): string | undefined {
		const agentKey = this.agentKey;
		for (const candidate of [this.cfg.apiKey, this.mintedKey]) {
			if (candidate && candidate !== agentKey) return candidate;
		}
		return undefined;
	}

	/** Effective DATA-plane key: agent identity wins over the principal. */
	private effectiveKey(): string | undefined {
		return this.agentKey ?? this.cfg.apiKey ?? this.mintedKey;
	}

	private authHeaders(): Record<string, string> {
		const key = this.effectiveKey();
		return key ? { "X-Api-Key": key } : {};
	}

	/** The server+identity fingerprint under which a persisted dataset switch is
	 *  stored for this client. Deliberately keyed on the PRINCIPAL (never the
	 *  agent key — spec §3.2): flipping to a plugin identity must not orphan the
	 *  persisted switch. */
	keyFingerprint(): string {
		return datasetKeyFingerprint(this.cfg.baseUrl, this.principalKey());
	}

	/** Effective key source for display, including the plugin identity and the
	 *  lazy local bootstrap mint. */
	authSummary(): string {
		if (this.agentKey)
			return "plugin identity (~/.cognee-plugin/pi/agent-key.json)";
		if (this.cfg.apiKey) return this.cfg.apiKeySource;
		if (this.mintedKey)
			return "auto-minted owner key (~/.cognee-plugin/api_key.json)";
		return this.mintFailed
			? "not set (local owner-key bootstrap failed — run /cognee-doctor)"
			: "not set";
	}

	/** Cache an env-provided principal into the shared ~/.cognee-plugin/api_key.json
	 *  when nothing is cached yet (reference: detached workers can still act as
	 *  the parent after provisioning). */
	ensurePrincipalCached(): void {
		const principal = this.principalKey();
		if (principal && !loadCachedApiKey(this.cfg.baseUrl)) {
			saveCachedApiKey(this.cfg.baseUrl, principal);
		}
	}

	/** A 401/403 while authenticating AS the agent key: the provisioned key was
	 *  revoked out-of-band. Blocked so no later call reuses it — and never
	 *  auto-re-provisioned (create-only refuses an existing agent; rotating
	 *  would revoke another machine's key). Never throws. */
	private rejectAgentKey(usedKey: string | undefined): void {
		if (!usedKey || usedKey !== this.agentKey) return;
		blockAgentKeyRecord(usedKey);
		this.agentKey = undefined;
		this.agentId = undefined;
		this.identityProblem =
			"Plugin identity was rejected; reconnect explicitly (no automatic rotation)";
		this.identityProblemKind = "blocked";
		logPluginEvent({
			event: "plugin_identity_rejected_fallback",
			agent_key_blocked: true,
		});
	}

	/**
	 * Lazy owner-key bootstrap for loopback servers with auth enforced (cognee ≥ 1.2.2
	 * authenticates even localhost): login as the default user, reuse-or-mint an owner
	 * API key, cache it in the shared ~/.cognee-plugin/api_key.json. Never throws;
	 * runs at most once per process (a failed mint is not retried this session).
	 */
	async ensureAuth(): Promise<void> {
		if (this.cfg.apiKey || this.mintedKey || this.mintFailed) {
			// A principal that appeared since the last identity check (env key set at
			// construction) needs no re-check; one minted just now does.
			if (this.mintedKey && !this.agentKey && !this.identityProblem)
				this.refreshAgentIdentity();
			return;
		}
		if (!isLoopbackUrl(this.cfg.baseUrl)) return; // cloud/remote servers need an explicit key
		if (!this.mintPromise) {
			this.mintPromise = this.mintOwnerKey()
				.then((key) => {
					this.mintedKey = key;
					saveCachedApiKey(this.cfg.baseUrl, key);
					// The mint resolved a principal — re-evaluate the cached plugin
					// identity against it (fingerprint may now match).
					this.refreshAgentIdentity();
				})
				.catch(() => {
					this.mintFailed = true;
				})
				.finally(() => {
					this.mintPromise = undefined;
				});
		}
		await this.mintPromise;
	}

	private async mintOwnerKey(): Promise<string> {
		const timeoutMs = this.cfg.healthTimeoutMs; // localhost mint — short bound
		const login = await this.rawFetch(
			`${this.cfg.baseUrl}/api/v1/auth/login`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					username: this.cfg.authEmail ?? "default_user@example.com",
					password: this.cfg.authPassword ?? "default_password",
				}).toString(),
				timeoutMs,
			},
		);
		const loginText = await login.readText();
		if (!login.ok) {
			throw new CogneeError(
				`default-user login failed (HTTP ${login.status})`,
			);
		}
		let jwt = "";
		try {
			jwt = String(
				(JSON.parse(loginText) as { access_token?: unknown })
					.access_token ?? "",
			);
		} catch {
			/* non-JSON body — treated as an empty token below */
		}
		if (!jwt)
			throw new CogneeError(
				"default-user login returned no access token",
			);
		const cookie = `auth_token=${jwt}`;
		// Reuse an existing owner key when the server has one (keys minted by the
		// official plugins count) — minting would needlessly multiply credentials.
		const listed = await this.rawFetch(
			`${this.cfg.baseUrl}/api/v1/auth/api-keys`,
			{
				method: "GET",
				headers: { Cookie: cookie },
				timeoutMs,
			},
		);
		const listedText = await listed.readText();
		if (listed.ok && listedText) {
			try {
				const keys: unknown = JSON.parse(listedText);
				if (Array.isArray(keys) && keys.length > 0) {
					const first = keys[0] as { key?: unknown } | undefined;
					const firstKey =
						first && typeof first.key === "string" ? first.key : "";
					if (firstKey) return firstKey;
				}
			} catch {
				/* fall through to mint */
			}
		}
		const created = await this.rawFetch(
			`${this.cfg.baseUrl}/api/v1/auth/api-keys`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ name: "pi-owner-bootstrap" }),
				timeoutMs,
			},
		);
		const createdText = await created.readText();
		if (!created.ok) {
			throw new CogneeError(
				`owner API key creation failed (HTTP ${created.status})`,
			);
		}
		let key = "";
		try {
			key = String(
				(JSON.parse(createdText) as { key?: unknown }).key ?? "",
			);
		} catch {
			/* empty key below */
		}
		if (!key)
			throw new CogneeError("owner API key creation returned empty key");
		return key;
	}

	private async rawFetch(
		url: string,
		opts: RawFetchOptions,
	): Promise<Response & { readText(): Promise<string> }> {
		const attempt = async (): Promise<
			Response & { readText(): Promise<string> }
		> => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
			const onExternalAbort = () => controller.abort();
			opts.externalSignal?.addEventListener("abort", onExternalAbort, {
				once: true,
			});
			let cleaned = false;
			const cleanup = () => {
				if (cleaned) return;
				cleaned = true;
				clearTimeout(timer);
				opts.externalSignal?.removeEventListener(
					"abort",
					onExternalAbort,
				);
			};
			try {
				const resp = await fetch(url, {
					method: opts.method,
					headers: opts.headers,
					body: opts.body,
					signal: controller.signal,
				});
				// Abort wiring stays alive until the body is consumed: a server that sends
				// headers and then stalls must not hang the body read past the timeout.
				// Body-read failures get the same classification as connect failures.
				return Object.assign(resp, {
					readText: async (): Promise<string> => {
						try {
							return await resp.text();
						} catch (err) {
							if (opts.externalSignal?.aborted) {
								throw new CogneeError("request aborted", {
									aborted: true,
								});
							}
							if (
								err instanceof Error &&
								err.name === "AbortError"
							) {
								throw new CogneeError(
									`request timed out after ${opts.timeoutMs}ms`,
									{
										transient: true,
									},
								);
							}
							throw new CogneeError(
								`cannot read response body: ${describeError(err)}`,
								{
									unreachable: true,
								},
							);
						} finally {
							cleanup();
						}
					},
				});
			} catch (err) {
				cleanup();
				if (opts.externalSignal?.aborted) {
					throw new CogneeError("request aborted", { aborted: true });
				}
				if (err instanceof Error && err.name === "AbortError") {
					throw new CogneeError(
						`request timed out after ${opts.timeoutMs}ms`,
						{ transient: true },
					);
				}
				throw new CogneeError(
					`cannot reach cognee server: ${describeError(err)}`,
					{
						unreachable: true,
					},
				);
			}
		};
		try {
			return await attempt();
		} catch (err) {
			// ponytail: one 300ms-backoff retry on positively-absent servers, reads only —
			// writes never retry (no server-side idempotency; a retried write could duplicate).
			if (
				opts.retryOnConnect &&
				err instanceof CogneeError &&
				err.unreachable
			) {
				await sleep(300);
				return await attempt();
			}
			throw err;
		}
	}

	private async jsonRequest<T>(
		method: string,
		path: string,
		opts: {
			json?: unknown;
			timeoutMs?: number;
			externalSignal?: AbortSignal;
			retryOnConnect?: boolean;
		} = {},
	): Promise<
		| { ok: true; status: number; data: T }
		| { ok: false; status: number; error: CogneeError }
	> {
		try {
			await this.ensureAuth(); // no-op once a key is resolved (or off-loopback)
			const usedKey = this.effectiveKey();
			const headers = this.authHeaders();
			let body: string | undefined;
			if (opts.json !== undefined) {
				headers["Content-Type"] = "application/json";
				body = JSON.stringify(opts.json);
			}
			const resp = await this.rawFetch(this.cfg.baseUrl + path, {
				method,
				headers,
				body,
				timeoutMs: opts.timeoutMs ?? this.cfg.requestTimeoutMs,
				externalSignal: opts.externalSignal,
				retryOnConnect: opts.retryOnConnect,
			});
			const text = await resp.readText();
			let data: unknown;
			if (text) {
				try {
					data = JSON.parse(text);
				} catch {
					data = text;
				}
			}
			if (!resp.ok) {
				if (resp.status === 401 || resp.status === 403)
					this.rejectAgentKey(usedKey);
				const detail =
					data &&
					typeof data === "object" &&
					typeof (data as { error?: unknown }).error === "string"
						? (data as { error: string }).error
						: String(text).slice(0, 300);
				return {
					ok: false,
					status: resp.status,
					error: new CogneeError(
						`HTTP ${resp.status} ${method} ${path}: ${detail}`,
						{
							status: resp.status,
						},
					),
				};
			}
			return { ok: true, status: resp.status, data: data as T };
		} catch (err) {
			return { ok: false, status: 0, error: wrapAsCogneeError(err) };
		}
	}

	/** Liveness probe. Any status < 500 counts as reachable (per the server contract). */
	async health(
		timeoutMs: number = this.cfg.healthTimeoutMs,
	): Promise<HealthResult> {
		const started = Date.now();
		try {
			const resp = await this.rawFetch(`${this.cfg.baseUrl}/health`, {
				method: "GET",
				timeoutMs,
				retryOnConnect: true,
			});
			const latencyMs = Date.now() - started;
			const text = await resp.readText();
			let version: string | undefined;
			try {
				const parsed = JSON.parse(text) as { version?: unknown };
				if (parsed && typeof parsed.version === "string")
					version = parsed.version;
			} catch {
				/* non-JSON health body is fine */
			}
			if (resp.status < 500)
				return {
					reachable: true,
					latencyMs,
					status: resp.status,
					version,
				};
			return {
				reachable: false,
				latencyMs,
				status: resp.status,
				error: `HTTP ${resp.status}`,
			};
		} catch (err) {
			return {
				reachable: false,
				latencyMs: Date.now() - started,
				error: describeError(err),
			};
		}
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
			await this.ensureAuth(); // no-op once a key is resolved (or off-loopback)
			const usedKey = this.effectiveKey();
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
					headers: this.authHeaders(),
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
					this.rejectAgentKey(usedKey);
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
			await this.ensureAuth();
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
					headers: this.authHeaders(),
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
			await this.ensureAuth();
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
					headers: this.authHeaders(),
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

	/* ================================================================ */
	/* Shared-agent-memory provisioning (v0.4 — spec §3.3)                */
	/* Ported field-for-field from reference _plugin_common.py: same      */
	/* routes, bodies, verdicts, log events, marker/memoization           */
	/* semantics. All control-plane calls as the PRINCIPAL; only          */
	/* tenants/select runs as the agent.                                  */
	/* ================================================================ */

	/** `_json_http_request` that reports instead of raising: 200 for any 2xx,
	 *  the HTTP status otherwise, 0 when the request never got an HTTP answer. */
	private async controlPlaneRequest(
		path: string,
		opts: {
			method?: string;
			json?: unknown;
			key?: string;
			timeoutMs?: number;
		} = {},
	): Promise<{ status: number; body: unknown }> {
		const key = opts.key ?? this.principalKey() ?? "";
		try {
			const headers: Record<string, string> = key
				? { "X-Api-Key": key }
				: {};
			let body: string | undefined;
			if (opts.json !== undefined) {
				headers["Content-Type"] = "application/json";
				body = JSON.stringify(opts.json);
			}
			const resp = await this.rawFetch(this.cfg.baseUrl + path, {
				method: opts.method ?? "POST",
				headers,
				body,
				timeoutMs: opts.timeoutMs ?? 15_000,
			});
			const text = await resp.readText();
			let data: unknown;
			if (text) {
				try {
					data = JSON.parse(text);
				} catch {
					data = text;
				}
			}
			return resp.ok
				? { status: 200, body: data }
				: { status: resp.status, body: data };
		} catch (err) {
			logPluginEvent({
				event: "control_plane_request_failed",
				path,
				error: describeError(err).slice(0, 200),
			});
			return { status: 0, body: undefined };
		}
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
			const key = this.principalKey();
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

	/** Create this plugin's identity without rotating an existing key (§1.1).
	 *  Verifies the advertised create-only contract BEFORE POSTing — older
	 *  servers ignore unknown query params and rotate keys. 404/405 →
	 *  "unsupported" (a capability verdict, not a fault); any other HTTP/network
	 *  error → "failed"; bad response bodies → "failed" (logged
	 *  plugin_provision_bad_response). Unsupported/failed fail closed in the
	 *  caller — never a partial identity. */
	async provisionPluginAgent(
		timeoutMs: number = 20_000,
	): Promise<ProvisionResult> {
		const principal = (this.principalKey() ?? "").trim();
		if (!principal) return { status: "failed" };
		try {
			const capabilities = await this.probeCapabilities(
				Math.min(timeoutMs, 10_000),
			);
			if (!capabilities.probed) return { status: "failed" };
			if (!capabilities.provisioning) return { status: "unsupported" };
			const resp = await this.rawFetch(
				`${this.cfg.baseUrl}/api/v1/integrations/plugins/${PLUGIN_KEY}/provision?create_only=true`,
				{
					method: "POST",
					headers: {
						"X-Api-Key": principal,
						"Content-Type": "application/json",
					},
					body: "{}",
					timeoutMs,
				},
			);
			const text = await resp.readText();
			if (!resp.ok) {
				if (resp.status === 404 || resp.status === 405)
					return { status: "unsupported" };
				logPluginEvent({
					event: "plugin_provision_failed",
					status: resp.status,
				});
				return { status: "failed" };
			}
			let data: unknown;
			try {
				data = text ? JSON.parse(text) : undefined;
			} catch {
				data = undefined;
			}
			const verdict = validateProvisionResponse(data, principal);
			if (verdict.ok) {
				return {
					status: "provisioned",
					apiKey: verdict.apiKey,
					agentId: verdict.agentId,
				};
			}
			logPluginEvent({
				event: "plugin_provision_bad_response",
				reason: verdict.reason,
				keys: verdict.keys,
			});
			return { status: "failed" };
		} catch {
			logPluginEvent({
				event: "plugin_provision_failed",
				error: "network",
			});
			return { status: "failed" };
		}
	}

	/** DELETE /api/v1/integrations/plugins/{PLUGIN_KEY} as the principal — revoke
	 *  this plugin's agent keys (the agent user + its data stay; re-provisioning
	 *  later revives the same identity with a fresh key). Best-effort. */
	async disconnectPluginAgent(timeoutMs: number = 20_000): Promise<boolean> {
		const principal = (this.principalKey() ?? "").trim();
		if (!principal) return false;
		const r = await this.controlPlaneRequest(
			`/api/v1/integrations/plugins/${PLUGIN_KEY}`,
			{
				method: "DELETE",
				key: principal,
				timeoutMs,
			},
		);
		if (r.status !== 200)
			logPluginEvent({
				event: "plugin_disconnect_failed",
				status: r.status,
			});
		return r.status === 200;
	}

	/** `{id, tenant_id}` for the key's user, or `{id: ""}` (absent /users/me is
	 *  tolerated by the caller — §1.3 step 3). */
	private async usersMe(
		key: string | undefined,
		timeoutMs = 10_000,
	): Promise<{ id: string; tenant_id: string }> {
		const r = await this.controlPlaneRequest("/api/v1/users/me", {
			method: "GET",
			key,
			timeoutMs,
		});
		if (
			r.status !== 200 ||
			!r.body ||
			typeof r.body !== "object" ||
			Array.isArray(r.body)
		) {
			return { id: "", tenant_id: "" };
		}
		const body = r.body as Record<string, unknown>;
		return {
			id: rowStr(body, "id"),
			tenant_id: rowStr(body, "tenant_id", "tenantId"),
		};
	}

	/** Does this server expose the permissions API? Probed on the one endpoint
	 *  that cannot 404 for any other reason (a missing tenant 404s elsewhere). */
	private async permissionsSupported(
		principal: string,
		timeoutMs = 10_000,
	): Promise<boolean> {
		const r = await this.controlPlaneRequest(
			"/api/v1/permissions/tenants/me",
			{
				method: "GET",
				key: principal,
				timeoutMs,
			},
		);
		return r.status !== 404 && r.status !== 405;
	}

	/** Every dataset the key can READ, as the wiring code sees it (§1.3 step 4). */
	private async listDatasetsAs(
		key: string | undefined,
		timeoutMs = 15_000,
	): Promise<DatasetRow[]> {
		const r = await this.controlPlaneRequest("/api/v1/datasets", {
			method: "GET",
			key,
			timeoutMs,
		});
		if (r.status !== 200 || !Array.isArray(r.body)) return [];
		const rows: DatasetRow[] = [];
		for (const item of r.body) {
			if (!item || typeof item !== "object") continue;
			const d = item as Record<string, unknown>;
			const id = rowStr(d, "id");
			const name = rowStr(d, "name");
			if (id && name) {
				rows.push({
					id,
					name,
					owner_id: rowStr(d, "owner_id", "ownerId"),
					created_at: rowStr(d, "created_at", "createdAt"),
				});
			}
		}
		return rows;
	}

	/** POST /api/v1/datasets/ as the given key — the (new or existing) row. The
	 *  trailing slash is reference parity (servers disagree about this route). */
	private async createDatasetAs(
		key: string,
		name: string,
		timeoutMs = 30_000,
	): Promise<{ id: string; name: string }> {
		const r = await this.controlPlaneRequest("/api/v1/datasets/", {
			json: { name },
			key,
			timeoutMs,
		});
		if (
			r.status !== 200 ||
			!r.body ||
			typeof r.body !== "object" ||
			Array.isArray(r.body)
		) {
			return { id: "", name };
		}
		const body = r.body as Record<string, unknown>;
		const id = rowStr(body, "id");
		return id
			? { id, name: rowStr(body, "name") || name }
			: { id: "", name };
	}

	/** Resolve the tenant the shared role lives in: (tenantId, reason). A
	 *  tenant-less parent gets one created — but only when it can read ZERO
	 *  datasets (activating a tenant re-scopes visibility and would hide
	 *  no-tenant data → `tenantless_with_data`). */
	private async ensureTenant(
		principal: string,
		parent: { id: string; tenant_id: string },
		datasets: DatasetRow[],
		timeoutMs = 15_000,
	): Promise<{ tenantId: string; reason: string }> {
		if (parent.tenant_id) return { tenantId: parent.tenant_id, reason: "" };
		const parentId = parent.id;
		if (datasets.length > 0)
			return { tenantId: "", reason: "tenantless_with_data" };
		const tenantName = `cognee-${parentId.slice(0, 8)}`;
		const r = await this.controlPlaneRequest(
			`/api/v1/permissions/tenants?tenant_name=${encodeURIComponent(tenantName)}`,
			{ key: principal, timeoutMs },
		);
		if (
			r.status !== 200 ||
			!r.body ||
			typeof r.body !== "object" ||
			Array.isArray(r.body)
		) {
			logPluginEvent({
				event: "shared_memory_tenant_create_failed",
				status: r.status,
			});
			return { tenantId: "", reason: "tenant_create_failed" };
		}
		return {
			tenantId: rowStr(
				r.body as Record<string, unknown>,
				"tenant_id",
				"tenantId",
			),
			reason: "",
		};
	}

	/** Get-or-create AGENT_ROLE_NAME in the tenant: (roleId, reason). */
	private async ensureRole(
		principal: string,
		tenantId: string,
		timeoutMs = 15_000,
	): Promise<{ roleId: string; reason: string }> {
		const find = async (): Promise<string> => {
			const r = await this.controlPlaneRequest(
				`/api/v1/permissions/tenants/${encodeURIComponent(tenantId)}/roles`,
				{
					method: "GET",
					key: principal,
					timeoutMs: Math.min(timeoutMs, 10_000),
				},
			);
			if (r.status === 200 && Array.isArray(r.body)) {
				for (const row of r.body) {
					if (
						row &&
						typeof row === "object" &&
						rowStr(row as Record<string, unknown>, "name") ===
							AGENT_ROLE_NAME
					) {
						return rowStr(row as Record<string, unknown>, "id");
					}
				}
			}
			return "";
		};
		const existing = await find();
		if (existing) return { roleId: existing, reason: "" };
		const r = await this.controlPlaneRequest(
			`/api/v1/permissions/roles?role_name=${encodeURIComponent(AGENT_ROLE_NAME)}`,
			{ key: principal, timeoutMs },
		);
		if (
			r.status === 200 &&
			r.body &&
			typeof r.body === "object" &&
			!Array.isArray(r.body)
		) {
			const roleId = rowStr(
				r.body as Record<string, unknown>,
				"role_id",
				"roleId",
			);
			if (roleId) return { roleId, reason: "" };
		}
		if (r.status === 409) return { roleId: await find(), reason: "" };
		if (r.status === 401 || r.status === 403) {
			// Only the tenant owner may create roles — stay separated rather than fail.
			return { roleId: "", reason: "not_tenant_owner" };
		}
		logPluginEvent({
			event: "shared_memory_role_create_failed",
			status: r.status,
		});
		return { roleId: "", reason: "role_create_failed" };
	}

	/** Membership wiring for one agent; a failure reason or "" (§1.3 step 7). */
	private async addAgentToTenantAndRole(
		principal: string,
		agentKey: string,
		agentId: string,
		tenantId: string,
		roleId: string,
		timeoutMs = 15_000,
	): Promise<string> {
		const accepted = (status: number): boolean =>
			status === 200 || status === 409;
		let r = await this.controlPlaneRequest(
			`/api/v1/permissions/users/${encodeURIComponent(agentId)}/tenants?tenant_id=${encodeURIComponent(tenantId)}`,
			{ key: principal, timeoutMs },
		);
		if (!accepted(r.status)) {
			return r.status === 401 || r.status === 403
				? "not_tenant_owner"
				: "tenant_membership_failed";
		}
		// The agent selects the tenant ITSELF (as the agent): membership alone
		// doesn't set its active tenant, and the dataset-visibility filter compares
		// against that — without it every grant that follows is invisible to the agent.
		r = await this.controlPlaneRequest(
			"/api/v1/permissions/tenants/select",
			{
				json: { tenant_id: tenantId },
				key: agentKey,
				timeoutMs,
			},
		);
		if (r.status !== 200) {
			logPluginEvent({
				event: "shared_memory_agent_select_tenant_failed",
				status: r.status,
			});
			return "agent_tenant_select_failed";
		}
		r = await this.controlPlaneRequest(
			`/api/v1/permissions/users/${encodeURIComponent(agentId)}/roles?role_id=${encodeURIComponent(roleId)}`,
			{ key: principal, timeoutMs },
		);
		if (!accepted(r.status)) {
			return r.status === 401 || r.status === 403
				? "not_tenant_owner"
				: "role_membership_failed";
		}
		return "";
	}

	/** Take the agent out of the shared role (opt-out). True when it is no longer
	 *  a member — including when it already wasn't (404). Runs as the principal. */
	private async removeAgentFromRole(
		principal: string | undefined,
		agentId: string,
		roleId: string,
		timeoutMs = 15_000,
	): Promise<boolean> {
		if (!(principal && agentId && roleId)) return false;
		const r = await this.controlPlaneRequest(
			`/api/v1/permissions/users/${encodeURIComponent(agentId)}/roles?role_id=${encodeURIComponent(roleId)}`,
			{ method: "DELETE", key: principal, timeoutMs },
		);
		if (r.status !== 200 && r.status !== 404) {
			logPluginEvent({
				event: "shared_memory_leave_role_failed",
				status: r.status,
			});
			return false;
		}
		return true;
	}

	/** Give the role read+write on each dataset (one call per dataset, so a single
	 *  unshareable one cannot fail the batch). Outcomes memoized in
	 *  marker.granted: "ok" never retried; {denied_at} retried after the hourly
	 *  window (logged once per dataset); anything else transient → retried next
	 *  time. Returns the ids the role holds read+write on. */
	private async grantRoleOnDatasets(
		principal: string,
		roleId: string,
		datasetIds: string[],
		marker: SharedMemoryMarker,
		timeoutMs = 15_000,
	): Promise<Set<string>> {
		if (!marker.granted || typeof marker.granted !== "object")
			marker.granted = {};
		const granted = marker.granted;
		const now = Date.now() / 1000; // epoch seconds, reference parity (denied_at)
		for (const datasetId of datasetIds) {
			if (!datasetId) continue;
			const prior = granted[datasetId];
			if (prior === "ok") continue;
			if (
				prior &&
				typeof prior === "object" &&
				now - Number(prior.denied_at || 0) < GRANT_DENIED_RETRY_SECONDS
			) {
				continue;
			}
			let outcome: "ok" | { denied_at: number } | null = "ok";
			for (const permission of ["read", "write"] as const) {
				const r = await this.controlPlaneRequest(
					`/api/v1/permissions/datasets/${encodeURIComponent(roleId)}?permission_name=${permission}`,
					{ json: [datasetId], key: principal, timeoutMs },
				);
				if (r.status === 401 || r.status === 403) {
					outcome = { denied_at: now };
					if (!(prior && typeof prior === "object")) {
						// Typically a dataset shared to the user read-only by someone else:
						// said once per dataset, not once per hour.
						logPluginEvent({
							event: "shared_memory_grant_denied",
							dataset_id: datasetId,
							permission,
							status: r.status,
						});
					}
					break;
				}
				if (r.status !== 200) {
					outcome = null; // transient: retry next time
					break;
				}
			}
			if (outcome === null) {
				delete granted[datasetId];
				continue;
			}
			granted[datasetId] = outcome;
		}
		return new Set(
			Object.entries(granted)
				.filter(([, v]) => v === "ok")
				.map(([k]) => k),
		);
	}

	/** Wire (or refresh) shared agent memory (§1.3). Returns the outcome every
	 *  caller consumes; every step degrades to `separated/<reason>` — nothing
	 *  here can fail a session. `allowSetup: false` (the refresh/switch path)
	 *  only re-resolves the canonical dataset and backfills grants against
	 *  wiring a session start already completed — never creates tenants/roles. */
	async ensureSharedMemory(
		opts: {
			dataset?: string;
			allowSetup?: boolean;
			agentKey?: string;
			agentId?: string;
			timeoutMs?: number;
		} = {},
	): Promise<SharedMemoryOutcome> {
		const timeoutMs = opts.timeoutMs ?? 15_000;
		try {
			await this.ensureAuth();
			const principal = this.principalKey();
			const agentKey = opts.agentKey ?? this.agentKey ?? "";
			const agentId = opts.agentId ?? this.agentId ?? "";
			const baseUrl = this.cfg.baseUrl;

			if (!this.cfg.sharedAgentMemory) {
				// Opting out is a real boundary: the agent LEAVES the shared role. The
				// marker is demoted (nothing keeps treating the wiring as active) but
				// the tenant/role/parent ids are kept — re-enabling rejoins the same
				// role. Runs as the principal; retried on the next session start.
				const marker = loadSharedMemoryMarker(baseUrl);
				if (marker.mode === "shared") {
					const removed = await this.removeAgentFromRole(
						principal,
						String(marker.agent_id || agentId),
						String(marker.role_id || ""),
						timeoutMs,
					);
					if (removed) {
						saveSharedMemoryMarker({
							...marker,
							mode: "separated",
							reason: "opt_out",
							role_member: false,
						});
					}
					logPluginEvent({
						event: "shared_memory_opted_out",
						role_id: marker.role_id,
						left_role: removed,
					});
				}
				return separatedOutcome("opt_out");
			}
			if (!(principal && agentKey && agentId))
				return separatedOutcome("no_agent_identity");

			let marker = loadSharedMemoryMarker(baseUrl);
			const wired =
				marker.mode === "shared" &&
				marker.agent_id === agentId &&
				Boolean(marker.role_id) &&
				Boolean(marker.parent_user_id);
			if (!wired && !opts.allowSetup)
				return separatedOutcome(String(marker.reason || "not_wired"));

			let datasets: DatasetRow[] | undefined;
			if (!wired) {
				if (!(await this.permissionsSupported(principal, timeoutMs))) {
					saveSharedMemoryMarker({
						base_url: baseUrl,
						mode: "separated",
						reason: "unsupported",
					});
					logPluginEvent({
						event: "shared_memory_skipped",
						reason: "unsupported",
					});
					return separatedOutcome("unsupported");
				}
				const capabilities = await this.probeCapabilities(
					Math.min(timeoutMs, 10_000),
				);
				if (!(capabilities.probed && capabilities.typedDatasetIds)) {
					saveSharedMemoryMarker({
						base_url: baseUrl,
						mode: "separated",
						reason: "typed_dataset_unsupported",
					});
					logPluginEvent({
						event: "shared_memory_skipped",
						reason: "typed_dataset_unsupported",
					});
					return separatedOutcome("typed_dataset_unsupported");
				}
				const parent = await this.usersMe(principal, timeoutMs);
				if (!parent.id) return separatedOutcome("principal_unresolved");
				datasets = await this.listDatasetsAs(principal, timeoutMs);
				const tenant = await this.ensureTenant(
					principal,
					parent,
					datasets,
					timeoutMs,
				);
				let roleId = "";
				let reason = tenant.reason;
				if (!reason) {
					const role = await this.ensureRole(
						principal,
						tenant.tenantId,
						timeoutMs,
					);
					roleId = role.roleId;
					reason = role.reason;
				}
				if (!reason) {
					reason = await this.addAgentToTenantAndRole(
						principal,
						agentKey,
						agentId,
						tenant.tenantId,
						roleId,
						timeoutMs,
					);
				}
				if (reason) {
					saveSharedMemoryMarker({
						base_url: baseUrl,
						mode: "separated",
						reason,
					});
					logPluginEvent({ event: "shared_memory_skipped", reason });
					return separatedOutcome(reason);
				}
				marker = {
					base_url: baseUrl,
					mode: "shared",
					reason: "",
					tenant_id: tenant.tenantId,
					role_id: roleId,
					parent_user_id: parent.id,
					agent_id: agentId,
					granted: {},
					canonical: {},
				};
				logPluginEvent({
					event: "shared_memory_wired",
					tenant_id: tenant.tenantId,
					role_id: roleId,
					agent_id: agentId,
				});
			}

			const parentId = String(marker.parent_user_id || "");
			const roleId = String(marker.role_id || "");
			if (datasets === undefined)
				datasets = await this.listDatasetsAs(principal, timeoutMs);

			// Backfill: the role gets read+write on everything the parent can share.
			// Datasets a sibling agent creates are auto-shared to the parent, so this
			// is also how they reach every other agent — no per-plugin coordination.
			const roleHolds = await this.grantRoleOnDatasets(
				principal,
				roleId,
				datasets.map((row) => row.id),
				marker,
				timeoutMs,
			);

			// The launch's dataset: a canonical copy every agent writes to, plus other
			// same-named copies for recall. Only datasets the role actually holds (or
			// the parent owns) qualify — a read-only-shared same-named dataset is
			// neither the write target nor part of the recall set. With no eligible
			// copy the parent creates its own (creating as the agent would fork an
			// agent-owned copy nobody sees).
			let writeId = "";
			let readIds: string[] = [];
			const dataset = (opts.dataset ?? "").trim();
			if (dataset) {
				let sameName = datasets.filter((row) => row.name === dataset);
				let eligible = sameName.filter(
					(row) => row.owner_id === parentId || roleHolds.has(row.id),
				);
				if (eligible.length === 0) {
					const created = await this.createDatasetAs(
						principal,
						dataset,
						timeoutMs,
					);
					if (!created.id) {
						// The wiring itself is fine (the marker keeps its grants), but this
						// launch has no canonical UUID to address — report that rather than
						// "shared" with an empty dataset_id (name addressing would quietly
						// write to an agent-owned copy nobody else can see).
						saveSharedMemoryMarker(marker);
						logPluginEvent({
							event: "shared_memory_skipped",
							reason: "dataset_create_failed",
							dataset,
						});
						return separatedOutcome("dataset_create_failed");
					}
					const row: DatasetRow = {
						id: created.id,
						name: created.name || dataset,
						owner_id: parentId,
						created_at: "",
					};
					sameName = [...sameName, row];
					datasets.push(row);
					for (const id of await this.grantRoleOnDatasets(
						principal,
						roleId,
						[row.id],
						marker,
						timeoutMs,
					)) {
						roleHolds.add(id);
					}
					eligible = [row];
				}
				if (eligible.length > 0) {
					writeId = pickCanonical(eligible, parentId).id;
					if (
						!marker.canonical ||
						typeof marker.canonical !== "object"
					)
						marker.canonical = {};
					marker.canonical[dataset] = writeId;
					readIds = [
						writeId,
						...sameName
							.filter(
								(row) =>
									row.id !== writeId &&
									(roleHolds.has(row.id) ||
										row.owner_id === agentId),
							)
							.map((row) => row.id),
					];
				}
			}
			saveSharedMemoryMarker(marker);
			return {
				mode: "shared",
				reason: "",
				dataset_id: writeId,
				dataset_ids: readIds,
				role_id: roleId,
			};
		} catch {
			return separatedOutcome("wiring_failed"); // fail-soft — retried at the next session start
		}
	}

	/** `ensureSharedMemory` for an already-wired agent, from any caller (§1.3):
	 *  resolves the keys itself, so the dataset switch can re-resolve a dataset's
	 *  canonical UUIDs and backfill grants without the session-start context. */
	async resolveSharedDataset(
		dataset: string,
		timeoutMs: number = 15_000,
	): Promise<SharedMemoryOutcome> {
		if (!this.cfg.sharedAgentMemory) return separatedOutcome("opt_out");
		await this.ensureAuth().catch(() => {});
		const principal = this.principalKey();
		const agentKey = this.agentKey;
		const agentId = this.agentId;
		if (!(principal && agentKey && agentId)) {
			return separatedOutcome(
				!agentKey ? "no_agent_identity" : "no_principal_key",
			);
		}
		return this.ensureSharedMemory({
			dataset,
			allowSetup: false,
			timeoutMs,
		});
	}

	/** Use effective permissions to classify the readable set (§1.5):
	 *  GET /permissions/principals/{user}/datasets?permission_name=write lists
	 *  DIRECT write grants — a role-held grant does not appear there, so under a
	 *  live shared-memory marker the parent's datasets count as writable only
	 *  once the grant memo says "ok" (via_role). Without the route (404/405)
	 *  `filtered` is false and writability degrades to the owner match (null =
	 *  unverifiable). Throws on transport/other HTTP failure — callers fall back
	 *  to the every-readable heuristic. */
	async listWritableDatasets(
		timeoutMs: number = 15_000,
	): Promise<WritableDatasetsListing> {
		await this.ensureAuth();
		const listed = await this.listDatasets(timeoutMs);
		if (!listed.ok)
			throw listed.error ?? new CogneeError("cannot list datasets");
		const me = await this.usersMe(this.effectiveKey(), timeoutMs);
		const userId = me.id;
		let writableIds: Set<string> | null = null;
		if (userId) {
			const r = await this.controlPlaneRequest(
				`/api/v1/permissions/principals/${encodeURIComponent(userId)}/datasets?permission_name=write`,
				{ method: "GET", key: this.effectiveKey(), timeoutMs },
			);
			if (r.status === 200 && Array.isArray(r.body)) {
				writableIds = new Set(
					r.body
						.filter(
							(row): row is Record<string, unknown> =>
								Boolean(row) && typeof row === "object",
						)
						.map((row) => rowStr(row, "id"))
						.filter(Boolean),
				);
			} else if (r.status !== 404 && r.status !== 405) {
				throw new CogneeError(
					`HTTP ${r.status} GET /permissions/principals/.../datasets`,
					{
						status: r.status,
					},
				);
			}
		}
		const shared = loadSharedMemoryMarker(this.cfg.baseUrl);
		let sharedParent = "";
		let roleGranted: Record<string, unknown> = {};
		if (this.cfg.sharedAgentMemory && shared.mode === "shared") {
			sharedParent = String(shared.parent_user_id || "");
			roleGranted = (shared.granted ?? {}) as Record<string, unknown>;
		}
		const rows = listed.datasets.map((item) => {
			const owner = item.owner_id ?? item.ownerId ?? "";
			const ident = item.id;
			// Writable through the shared role only once the grant is confirmed — a
			// transient failure leaves a parent-owned dataset ungranted until the
			// next refresh; it must not be offered as writable meanwhile.
			const viaRole =
				Boolean(sharedParent) &&
				owner === sharedParent &&
				roleGranted[ident] === "ok";
			let writable: boolean | null;
			if (writableIds !== null)
				writable = writableIds.has(ident) || viaRole;
			else
				writable = owner && (owner === userId || viaRole) ? true : null;
			return { name: item.name, id: ident, owner_id: owner, writable };
		});
		return {
			datasets: rows.filter((row) => row.writable !== false),
			readonly: rows
				.filter((row) => row.writable === false)
				.map((row) => row.name),
			readonly_ids: rows
				.filter((row) => row.writable === false)
				.map((row) => row.id),
			hidden_readonly: rows.filter((row) => row.writable === false)
				.length,
			filtered: writableIds !== null,
		};
	}
}
