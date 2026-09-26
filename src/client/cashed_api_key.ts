import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { API_KEY_CACHE_PATH } from "../constants";
import type { CachedApiKeyFile } from "./types";

/* ------------------------------------------------------------------ */
/* Owner-key cache (~/.cognee-plugin/api_key.json)                      */
/* Shared with the Claude Code / Codex cognee plugins.                  */
/* ------------------------------------------------------------------ */

/** Read the cached owner key; only honored when it was minted for this server. */
export function loadCachedApiKey(baseUrl: string): string | undefined {
	try {
		const data = JSON.parse(
			readFileSync(API_KEY_CACHE_PATH, "utf8"),
		) as CachedApiKeyFile;
		const key = typeof data.api_key === "string" ? data.api_key.trim() : "";
		if (!key) return undefined;
		const cachedUrl = (
			typeof data.base_url === "string" ? data.base_url : ""
		)
			.trim()
			.replace(/\/+$/, "");
		if (cachedUrl && cachedUrl !== baseUrl) return undefined; // key belongs to another server
		return key;
	} catch {
		return undefined; // absent or unreadable — fine
	}
}

export function saveCachedApiKey(baseUrl: string, key: string): void {
	try {
		mkdirSync(dirname(API_KEY_CACHE_PATH), { recursive: true });
		writeFileSync(
			API_KEY_CACHE_PATH,
			JSON.stringify(
				{
					base_url: baseUrl,
					api_key: key,
					updated_at: new Date().toISOString(),
				},
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);
	} catch {
		/* fail-soft — the key stays in memory for this session */
	}
}
