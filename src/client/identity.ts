/**
 * pi-cognee — client identity + principal resolution.
 *
 * v0.4 shared-agent-memory identity (spec §3.3): after the env → cached-owner
 * (→ lazy mint) principal resolution, a cached plugin identity (agent-key.json)
 * may take over the DATA plane. Usable exactly when: the record loads ∧
 * mode ≠ disabled ∧ a principal is known ∧ principal_fingerprint matches. The
 * principal is retained for the CONTROL plane (owner-only server-side);
 * strict-mode obstacles are surfaced as `identityProblem` (a one-line warning —
 * pi never hard-fails startup, fail-soft divergence from the reference's raise).
 */
import type { CogneeConfig } from "../config/types";
import {
	datasetKeyFingerprint,
	isLoopbackUrl,
	logPluginEvent,
	principalFingerprint,
} from "../helpers";
import { CogneeError } from "../helpers/errors";
import { blockAgentKeyRecord, loadAgentKeyRecord } from "../state/agent_key";
import { loadCachedApiKey, saveCachedApiKey } from "../state/api_key";
import { rawFetch } from "./transport";

export class ClientIdentity {
	readonly cfg: CogneeConfig;

	/** Key minted by the lazy local owner bootstrap (session-lifetime fallback). */
	private mintedKey: string | undefined;
	private mintFailed = false;
	private mintPromise: Promise<void> | undefined;

	private agentKey: string | undefined;
	private agentId: string | undefined;
	/** Reference-verbatim obstacle text for a cached-but-unusable identity. */
	identityProblem: string | undefined;
	/** Machine kind of the obstacle ("blocked" | "principal_mismatch" | "not_connected"). */
	identityProblemKind: string | undefined;

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
	effectiveKey(): string | undefined {
		return this.agentKey ?? this.cfg.apiKey ?? this.mintedKey;
	}

	authHeaders(): Record<string, string> {
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
	rejectAgentKey(usedKey: string | undefined): void {
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
		const login = await rawFetch(
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
		const listed = await rawFetch(
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
		const created = await rawFetch(
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
}
