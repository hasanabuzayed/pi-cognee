/**
 * pi-cognee — shared-agent-memory provisioning control plane (v0.4 — spec §3.3).
 *
 * Ported field-for-field from reference _plugin_common.py: same routes, bodies,
 * verdicts, log events, marker/memoization semantics. All control-plane calls
 * run as the PRINCIPAL; only tenants/select runs as the agent.
 *
 * Composed by CogneeClient (delegates its five public methods) so the data
 * plane in client/index.ts stays free of provisioning wiring.
 */
import { logPluginEvent, rowStr } from "../helpers";
import { CogneeError, describeError } from "../helpers/errors";
import { loadSharedMemoryMarker, saveSharedMemoryMarker } from "../state/shared_memory";
import {
	AGENT_ROLE_NAME,
	type DatasetRow,
	GRANT_DENIED_RETRY_SECONDS,
	PLUGIN_KEY,
	type ProvisionResult,
	pickCanonical,
	type SharedMemoryMarker,
	type SharedMemoryOutcome,
	separatedOutcome,
	validateProvisionResponse,
	type WritableDatasetsListing,
} from "../contract";
import type { CogneeClient } from "./index";

export class SharedMemoryProvisioner {
	constructor(private readonly client: CogneeClient) {}

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
		const key = opts.key ?? this.client.identity.principalKey() ?? "";
		try {
			const headers: Record<string, string> = key
				? { "X-Api-Key": key }
				: {};
			let body: string | undefined;
			if (opts.json !== undefined) {
				headers["Content-Type"] = "application/json";
				body = JSON.stringify(opts.json);
			}
			const resp = await this.client.rawFetch(
				this.client.cfg.baseUrl + path,
				{
					method: opts.method ?? "POST",
					headers,
					body,
					timeoutMs: opts.timeoutMs ?? 15_000,
				},
			);
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
		const principal = (
			this.client.identity.principalKey() ?? ""
		).trim();
		if (!principal) return { status: "failed" };
		try {
			const capabilities = await this.client.probeCapabilities(
				Math.min(timeoutMs, 10_000),
			);
			if (!capabilities.probed) return { status: "failed" };
			if (!capabilities.provisioning) return { status: "unsupported" };
			const resp = await this.client.rawFetch(
				`${this.client.cfg.baseUrl}/api/v1/integrations/plugins/${PLUGIN_KEY}/provision?create_only=true`,
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
		const principal = (
			this.client.identity.principalKey() ?? ""
		).trim();
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
			await this.client.identity.ensureAuth();
			const principal = this.client.identity.principalKey();
			const agentKey =
				opts.agentKey ?? this.client.identity.activeAgentKey ?? "";
			const agentId =
				opts.agentId ?? this.client.identity.activeAgentId ?? "";
			const baseUrl = this.client.cfg.baseUrl;

			if (!this.client.cfg.sharedAgentMemory) {
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
				const capabilities = await this.client.probeCapabilities(
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
		if (!this.client.cfg.sharedAgentMemory) return separatedOutcome("opt_out");
		await this.client.identity.ensureAuth().catch(() => {});
		const principal = this.client.identity.principalKey();
		const agentKey = this.client.identity.activeAgentKey;
		const agentId = this.client.identity.activeAgentId;
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
		await this.client.identity.ensureAuth();
		const listed = await this.client.listDatasets(timeoutMs);
		if (!listed.ok)
			throw listed.error ?? new CogneeError("cannot list datasets");
		const me = await this.usersMe(
			this.client.identity.effectiveKey(),
			timeoutMs,
		);
		const userId = me.id;
		let writableIds: Set<string> | null = null;
		if (userId) {
			const r = await this.controlPlaneRequest(
				`/api/v1/permissions/principals/${encodeURIComponent(userId)}/datasets?permission_name=write`,
				{ method: "GET", key: this.client.identity.effectiveKey(), timeoutMs },
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
		const shared = loadSharedMemoryMarker(this.client.cfg.baseUrl);
		let sharedParent = "";
		let roleGranted: Record<string, unknown> = {};
		if (this.client.cfg.sharedAgentMemory && shared.mode === "shared") {
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
