import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_KEY } from "../contract";
import { piStateDir } from "../helpers/paths";
import { atomicWriteJson } from "./atomic";

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

function agentKeyPath(): string {
	return join(piStateDir(), "agent-key.json");
}

/** The cached plugin identity, or undefined — only honored when its base_url
 *  matches this server. Never throws. */
export function loadAgentKeyRecord(
	baseUrl: string,
): AgentKeyRecord | undefined {
	try {
		const raw = JSON.parse(
			readFileSync(agentKeyPath(), "utf8"),
		) as AgentKeyRecord;
		if (!raw || typeof raw !== "object") return undefined;
		const key = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
		if (!key) return undefined;
		const cachedUrl = (typeof raw.base_url === "string" ? raw.base_url : "")
			.trim()
			.replace(/\/+$/, "");
		if (cachedUrl && cachedUrl !== baseUrl.replace(/\/+$/, ""))
			return undefined;
		return {
			base_url: typeof raw.base_url === "string" ? raw.base_url : "",
			api_key: key,
			agent_id: typeof raw.agent_id === "string" ? raw.agent_id : "",
			plugin_key:
				typeof raw.plugin_key === "string"
					? raw.plugin_key
					: PLUGIN_KEY,
			principal_fingerprint:
				typeof raw.principal_fingerprint === "string"
					? raw.principal_fingerprint
					: "",
			updated_at:
				typeof raw.updated_at === "string" ? raw.updated_at : "",
			blocked: raw.blocked === true ? true : undefined,
		};
	} catch {
		return undefined;
	}
}

/** Atomically persist the plugin identity (0600, tmp + rename). Never throws. */
export function saveAgentKeyRecord(record: AgentKeyRecord): void {
	try {
		atomicWriteJson(
			agentKeyPath(),
			{ ...record, updated_at: new Date().toISOString() },
			{ mode: 0o600 },
		);
	} catch {
		/* fail-soft — the key stays in memory for this session */
	}
}

/** Stamp `blocked` on the cached identity when it is still the expected key
 *  (a concurrent reconnect may have replaced it) — reads the raw file, no
 *  base_url gate. Never throws. */
export function blockAgentKeyRecord(expectedKey: string): boolean {
	try {
		const raw = JSON.parse(
			readFileSync(agentKeyPath(), "utf8"),
		) as AgentKeyRecord;
		if (!raw || typeof raw !== "object") return false;
		const key = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
		if (!key || key !== expectedKey) return false;
		saveAgentKeyRecord({ ...raw, api_key: key, blocked: true });
		return true;
	} catch {
		return false;
	}
}

/** Drop the cached identity (revoked key / post-provision revert). */
export function clearAgentKeyRecord(): void {
	try {
		unlinkSync(agentKeyPath());
	} catch {
		/* absent — fine */
	}
}
