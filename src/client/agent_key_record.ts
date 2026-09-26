import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { piStateDir } from "../helpers";
import { PLUGIN_KEY } from "../provisioning";
import type { AgentKeyRecord } from "./types";

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
		mkdirSync(piStateDir(), { recursive: true });
		const tmp = `${agentKeyPath()}.${process.pid}.tmp`;
		writeFileSync(
			tmp,
			JSON.stringify(
				{ ...record, updated_at: new Date().toISOString() },
				null,
				2,
			) + "\n",
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		renameSync(tmp, agentKeyPath());
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
