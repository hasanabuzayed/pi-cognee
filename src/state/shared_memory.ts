/* ------------------------------------------------------------------ */
/* Shared-agent-memory provisioning state (v0.4 — spec §3.2)          */
/* ~/.cognee-plugin/pi/shared-memory.json, alongside agent-key.json    */
/* and active-dataset.json. Fail-soft + atomic like every state writer. */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVISIONING_PLUGIN_VERSION, type SharedMemoryMarker } from "../contract";
import { piStateDir } from "../helpers/paths";
import { atomicWriteJson } from "./atomic";

export function sharedMemoryMarkerPath(): string {
	return join(piStateDir(), "shared-memory.json");
}

/** The wiring marker for this server, or {} — base_url mismatch (or a foreign/
 *  corrupt file) is treated as absent (per-server marker, §1.1). */
export function loadSharedMemoryMarker(baseUrl: string): SharedMemoryMarker {
	try {
		const raw = JSON.parse(readFileSync(sharedMemoryMarkerPath(), "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const marker = raw as SharedMemoryMarker;
		const cachedUrl = (
			typeof marker.base_url === "string" ? marker.base_url : ""
		)
			.trim()
			.replace(/\/+$/, "");
		const wanted = baseUrl.replace(/\/+$/, "");
		if (wanted && cachedUrl && cachedUrl !== wanted) return {};
		return marker;
	} catch {
		return {};
	}
}

/** Persist the marker, stamping updated_at + the plugin version (a structural
 *  reason is only structural for THIS version — §2.4). Never throws. */
export function saveSharedMemoryMarker(marker: SharedMemoryMarker): void {
	try {
		atomicWriteJson(sharedMemoryMarkerPath(), {
			...marker,
			updated_at: new Date().toISOString(),
			plugin_version: PROVISIONING_PLUGIN_VERSION,
		});
	} catch {
		/* fail-soft — wiring state is re-derived at the next session start */
	}
}
