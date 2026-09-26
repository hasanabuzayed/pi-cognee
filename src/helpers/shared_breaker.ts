import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piStateDir } from "./paths";

/* ----- Circuit breaker (recall path) ----- */
// File-shared like the official plugins: the in-memory window stays the fast
// path, but open-until/failure-count also live in ~/.cognee-plugin/pi/breaker.json
// so concurrent pi processes share outage state instead of each hammering a
// down server. All file IO is guarded, atomic (tmp+rename), and never throws.

export function sharedBreakerPath(): string {
	return process.env.COGNEE_BREAKER_FILE || join(piStateDir(), "breaker.json");
}

/*
 * ------------------------------------------------------------------
 * File-shared circuit breaker (~/.cognee-plugin/pi/breaker.json)
 * ------------------------------------------------------------------ */

export interface SharedBreakerEntry {
	/** Epoch ms — recall is paused until then (0/absent = closed). */
	open_until?: number;
	/** Consecutive outage-classified failures seen across processes. */
	consecutive_failures?: number;
	updated_at?: string;
}

/** { "<base_url>": { open_until, consecutive_failures, updated_at } } */
export type SharedBreakerFile = Record<string, SharedBreakerEntry>;

/**
 * Read the shared breaker entry for one server. Stale-read tolerant: a missing,
 * corrupt, or non-object file is an empty entry (never throws), so a half-written
 * or foreign file degrades to per-process behavior instead of breaking recall.
 */
export function loadSharedBreaker(
	baseUrl: string,
	filePath: string = sharedBreakerPath(),
): SharedBreakerEntry {
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const entry = (raw as SharedBreakerFile)[baseUrl];
		if (!entry || typeof entry !== "object") return {};
		return entry;
	} catch {
		return {};
	}
}

/**
 * Persist the shared breaker entry for one server. Best-effort atomic write
 * (temp file + rename, same pattern as the official plugins' state markers):
 * other entries in the file are preserved, and any failure is swallowed — the
 * in-memory breaker keeps working when the disk does not.
 */
export function saveSharedBreaker(
	baseUrl: string,
	entry: SharedBreakerEntry,
	filePath: string = sharedBreakerPath(),
): void {
	try {
		let all: SharedBreakerFile = {};
		try {
			const raw = JSON.parse(readFileSync(filePath, "utf8"));
			if (raw && typeof raw === "object" && !Array.isArray(raw))
				all = raw as SharedBreakerFile;
		} catch {
			/* unreadable/absent — start from an empty map */
		}
		all[baseUrl] = { ...entry, updated_at: new Date().toISOString() };
		mkdirSync(dirname(filePath), { recursive: true });
		const tmp = `${filePath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(all), "utf8");
		renameSync(tmp, filePath);
	} catch {
		/* fail-soft — shared-state propagation is an optimization */
	}
}
