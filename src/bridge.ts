/**
 * pi-cognee — disk-backed write bridge, the "warmup spillway" (v0.4 resilience
 * spec §2.5). Ported from the reference `_plugin_common.py` spillway with one
 * documented layout divergence: one file per COGNEE session id with a flat
 * `{entries, fail_count, fail_at}` — not the reference's per-host-scope file
 * keyed by `(dataset, session_id)`. Justification: pi's dataset switch mints a
 * new session id, so one session's entries never span datasets, and per-session
 * files eliminate cross-terminal read-modify-write races for different sessions
 * (the residual same-session two-terminal race is bounded by the atomic rename).
 *
 * What spills (parity with the reference):
 *   1. Server unusable at capture → spilled immediately, never sent → never
 *      ambiguous.
 *   2. A send failed retryably (transport / HTTP ≥ 500) → spilled; stamped
 *      `_replay_ambiguous` when the failure may have committed (see
 *      writeOutcomeAmbiguous — `/remember/entry` has no idempotency, so a blind
 *      replay of a committed write duplicates the entry into the next improve).
 *   3. Permanent 4xx → dropped loudly by the caller, never buffered (a poisoned
 *      head entry would block the drain forever).
 *
 * Replay is in order, stops at first failure (tail stays buffered), verify-
 * before-replay for ambiguous QA AND trace heads (one `GET /api/v1/sessions/{id}`
 * supplies server fingerprints for both kinds; a match consumes the entry
 * WITHOUT re-sending). A detail read failure replays everything — a rare
 * duplicate beats a lost turn.
 *
 * Backoff: consecutive HTTP-status drain failures skip the file entirely,
 * doubling 60 s → 3600 s cap; any progress resets.
 *
 * Pure functions over piStateDir() (~/.cognee-plugin/pi, COGNEE_PI_STATE_DIR
 * honored): no timers, no spawns, all IO fail-soft with atomic writes.
 */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SessionQaRow, SessionTraceRow } from "./client/types";
import { piStateDir } from "./helpers";
import type { CogneeError } from "./helpers/errors";

/** Same policy as today's memory queue (COGNEE_BUFFER_LIMIT), now bounding the file. */
export const DEFAULT_BRIDGE_LIMIT = 100;

/** Backoff window for consecutive HTTP-status drain failures (reference parity). */
export const DRAIN_BACKOFF_BASE_MS = 60_000;
export const DRAIN_BACKOFF_MAX_MS = 3_600_000;

/** A captured entry (QA or trace) as spilled to disk: capture-time binding + replay meta. */
export interface SpilledEntry {
	type: "qa" | "trace";
	/** Capture-time session binding — a replay never re-derives it. */
	sessionId: string;
	/** Capture-time dataset binding. */
	dataset: string;
	/** Stamped when the failing send may have committed (verify-before-replay). */
	_replay_ambiguous?: true;
	/** Spill time (epoch ms) — also the oldest-first ordering key. */
	_buffered_at?: number;
	[key: string]: unknown;
}

/** File layout: flat per-session (documented divergence from the reference's scope map). */
export interface BridgeFile {
	entries: SpilledEntry[];
	/** Consecutive HTTP-status drain failures (backoff). */
	fail_count?: number;
	/** Epoch ms of the last recorded failure. */
	fail_at?: number;
}

function sha1Hex(value: string): string {
	return createHash("sha1").update(value, "utf8").digest("hex");
}

function bridgeDir(): string {
	return join(piStateDir(), "bridge");
}

/** <stateDir>/bridge/<sha1(sessionId)>.json */
export function bridgePath(sessionId: string): string {
	return join(bridgeDir(), `${sha1Hex(sessionId)}.json`);
}

function readBridgeFile(sessionId: string): BridgeFile {
	try {
		const raw = JSON.parse(
			readFileSync(bridgePath(sessionId), "utf8"),
		) as BridgeFile;
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			return { entries: [] };
		if (!Array.isArray(raw.entries)) return { entries: [] };
		return raw;
	} catch {
		return { entries: [] }; // absent/corrupt — fail-soft
	}
}

function writeBridgeFile(sessionId: string, file: BridgeFile): void {
	const path = bridgePath(sessionId);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(file), "utf8");
	renameSync(tmp, path);
}

/** The session's spilled entries; [] on absent/corrupt (never throws). */
export function loadBridge(sessionId: string): SpilledEntry[] {
	return readBridgeFile(sessionId).entries.filter(
		(e) => e && typeof e === "object" && typeof e.sessionId === "string",
	);
}

/**
 * Append one entry (read-modify-write + atomic rename). The optional limit
 * bounds the FILE with drop-oldest — the durable twin of the memory queue's
 * policy; returns the number of dropped entries (0 when nothing fell off).
 */
export function appendBridge(
	sessionId: string,
	entry: SpilledEntry,
	opts: { ambiguous?: boolean; maxEntries?: number } = {},
): number {
	try {
		const file = readBridgeFile(sessionId);
		const spilled: SpilledEntry = { ...entry, _buffered_at: Date.now() };
		if (opts.ambiguous) spilled._replay_ambiguous = true;
		file.entries.push(spilled);
		const max = opts.maxEntries ?? DEFAULT_BRIDGE_LIMIT;
		let dropped = 0;
		while (file.entries.length > max) {
			file.entries.shift();
			dropped++;
		}
		writeBridgeFile(sessionId, file);
		return dropped;
	} catch {
		return 0; // fail-soft — the memory path/next append retries
	}
}

/**
 * Drop the head prefix (drained entries leave the file). The file is unlinked
 * when it empties — "N awaiting replay" goes to zero and no stub file remains.
 */
export function trimBridgeHead(sessionId: string, count: number): void {
	if (count <= 0) return;
	try {
		const file = readBridgeFile(sessionId);
		if (file.entries.length === 0) return;
		file.entries = file.entries.slice(count);
		if (file.entries.length === 0) {
			try {
				unlinkSync(bridgePath(sessionId));
			} catch {
				/* already gone */
			}
		} else {
			writeBridgeFile(sessionId, file);
		}
	} catch {
		/* fail-soft — a stale drained head re-sends at worst */
	}
}

/** Stamp the head entry ambiguous (a retry failed in a way that may have committed). */
export function markBridgeHeadAmbiguous(sessionId: string): void {
	try {
		const file = readBridgeFile(sessionId);
		const head = file.entries[0];
		if (head && !head._replay_ambiguous) {
			head._replay_ambiguous = true;
			writeBridgeFile(sessionId, file);
		}
	} catch {
		/* fail-soft — the entry replays (fail-open) without the stamp */
	}
}

/* ------------------------------------------------------------------ */
/* Ambiguity classification + fingerprints                              */
/* ------------------------------------------------------------------ */

/**
 * Whether a failed write may have COMMITTED server-side. Unambiguous (never
 * committed) only for positively-absent transport causes (refused / DNS /
 * unroutable — the reference's connection-refused/DNS/EHOSTUNREACH/ENETUNREACH
 * set) and HTTP 503; everything else (timeouts, aborts, resets, 500/502/504,
 * unknown transport causes) is ambiguous — `/remember/entry` has no
 * idempotency, so a blind replay of a committed write duplicates the entry.
 */
export function writeOutcomeAmbiguous(err: CogneeError | undefined): boolean {
	if (!err) return true; // unknown failure — assume the worst
	if (err.unreachable) return false; // positively absent — never committed
	const status = err.status ?? 0;
	if (status === 503) return false; // explicit service-unavailable — not committed
	if (status >= 500) return true; // 500/502/504 — may have committed mid-exchange
	if (status > 0) return false; // definitive 4xx answer — rejected, not committed
	return true; // timeout / abort / unknown transport — ambiguous
}

/** json.dumps(sort_keys=True, default=str) analog: recursively key-sorted
 *  JSON with a String() fallback for unserializable values. Both fingerprint
 *  sides (the spilled entry and the server-echoed row) run through this one
 *  function, so the exact byte format only needs to agree with itself — what
 *  matters is that key ORDER never distinguishes two logically equal payloads
 *  (the reference canonicalizes for the same reason). */
export function stableStringify(value: unknown): string {
	try {
		const out = JSON.stringify(value, (_k, v) => {
			if (typeof v === "function" || typeof v === "bigint")
				return String(v);
			if (v && typeof v === "object" && !Array.isArray(v)) {
				return Object.keys(v as Record<string, unknown>)
					.sort()
					.reduce<Record<string, unknown>>((acc, key) => {
						acc[key] = (v as Record<string, unknown>)[key];
						return acc;
					}, {});
			}
			return v;
		});
		return out === undefined ? "null" : out;
	} catch {
		return String(value);
	}
}

/** Content identity of a spilled entry as the server would echo it back —
 *  the reference `_entry_fingerprint` field-for-field, for BOTH entry kinds:
 *  qa = `qa\0<question>\0<answer>\0<context>`; trace = `trace\0<origin_function>
 *  \0<status>\0<canonical method_params>\0<canonical method_return_value>
 *  \0<error_message>`. Server-generated fields (ids, time, feedback) are
 *  deliberately excluded. Undefined for kinds the session detail never
 *  exposes — those cannot be verified and replay unconditionally. */
export function entryFingerprint(entry: {
	type?: unknown;
	question?: unknown;
	answer?: unknown;
	context?: unknown;
	origin_function?: unknown;
	status?: unknown;
	method_params?: unknown;
	method_return_value?: unknown;
	error_message?: unknown;
	[key: string]: unknown;
}): string | undefined {
	const etype = String(entry.type ?? "");
	if (etype === "trace") {
		return [
			"trace",
			String(entry.origin_function ?? ""),
			String(entry.status ?? ""),
			stableStringify(entry.method_params ?? {}),
			stableStringify(entry.method_return_value),
			String(entry.error_message ?? ""),
		].join("\0");
	}
	if (etype === "qa") {
		return [
			"qa",
			String(entry.question ?? ""),
			String(entry.answer ?? ""),
			String(entry.context ?? ""),
		].join("\0");
	}
	return undefined;
}

/** Fingerprints of a server session's recent rows (verify-before-replay):
 *  the union of every QA and trace row the detail read exposed — the type is
 *  forced per list (the reference does the same), so a row missing its type
 *  still fingerprints against its own lane. */
export function serverFingerprints(
	qas: SessionQaRow[],
	traces: SessionTraceRow[] = [],
): Set<string> {
	const set = new Set<string>();
	for (const row of traces ?? []) {
		const fp = entryFingerprint({ ...row, type: "trace" });
		if (fp) set.add(fp);
	}
	for (const row of qas ?? []) {
		const fp = entryFingerprint({ ...row, type: "qa" });
		if (fp) set.add(fp);
	}
	return set;
}

/* ------------------------------------------------------------------ */
/* Drain backoff                                                       */
/* ------------------------------------------------------------------ */

/** Doubling backoff window for `failCount` consecutive HTTP-status failures. */
export function bridgeBackoffMs(failCount: number): number {
	if (failCount <= 0) return 0;
	return Math.min(
		DRAIN_BACKOFF_BASE_MS * 2 ** (failCount - 1),
		DRAIN_BACKOFF_MAX_MS,
	);
}

/** True while the session's file sits inside its failure backoff window. */
export function bridgeBackoffOpen(
	sessionId: string,
	nowMs: number = Date.now(),
): boolean {
	const file = readBridgeFile(sessionId);
	const failAt = Number(file.fail_at) || 0;
	if (!file.fail_count || failAt <= 0) return false;
	return nowMs < failAt + bridgeBackoffMs(file.fail_count);
}

/** Record one HTTP-status drain failure (fail_count++, fail_at = now). */
export function recordBridgeFailure(sessionId: string): void {
	try {
		const file = readBridgeFile(sessionId);
		file.fail_count = (Number(file.fail_count) || 0) + 1;
		file.fail_at = Date.now();
		writeBridgeFile(sessionId, file);
	} catch {
		/* fail-soft */
	}
}

/** Any progress resets the streak (fail_count/fail_at cleared). */
export function resetBridgeFailures(sessionId: string): void {
	try {
		const file = readBridgeFile(sessionId);
		if (file.fail_count || file.fail_at) {
			file.fail_count = 0;
			file.fail_at = 0;
			writeBridgeFile(sessionId, file);
		}
	} catch {
		/* fail-soft */
	}
}

/* ------------------------------------------------------------------ */
/* Cross-file helpers                                                  */
/* ------------------------------------------------------------------ */

function fileBackoffOpen(file: BridgeFile, nowMs: number): boolean {
	const failAt = Number(file.fail_at) || 0;
	if (!file.fail_count || failAt <= 0) return false;
	return nowMs < failAt + bridgeBackoffMs(file.fail_count);
}

/**
 * The oldest pending spilled head across ALL bridge files (backoff-open files
 * skipped), excluding `excludeSessionId`'s file — the drain's last resort so a
 * retired/stranded session's spill still drains under its own binding.
 */
export function oldestPendingBridgeHead(
	excludeSessionId?: string,
	nowMs: number = Date.now(),
): { sessionId: string; entry: SpilledEntry } | undefined {
	let dir: string[];
	try {
		dir = readdirSync(bridgeDir());
	} catch {
		return undefined;
	}
	let best:
		{ sessionId: string; entry: SpilledEntry; at: number } | undefined;
	for (const name of dir) {
		if (!name.endsWith(".json")) continue;
		try {
			const file = JSON.parse(
				readFileSync(join(bridgeDir(), name), "utf8"),
			) as BridgeFile;
			if (!file || !Array.isArray(file.entries)) continue;
			if (fileBackoffOpen(file, nowMs)) continue;
			const head = file.entries[0];
			if (!head || typeof head.sessionId !== "string") continue;
			if (excludeSessionId && head.sessionId === excludeSessionId)
				continue;
			const at = Number(head._buffered_at) || 0;
			if (!best || at < best.at)
				best = { sessionId: head.sessionId, entry: head, at };
		} catch {
			/* foreign/corrupt file — skip */
		}
	}
	return best ? { sessionId: best.sessionId, entry: best.entry } : undefined;
}

/** Unlink bridge files older than `maxAgeMs` (default 7 d) — bounded disk usage. */
export function sweepOldBridgeFiles(
	maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): void {
	let dir: string[];
	try {
		dir = readdirSync(bridgeDir());
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of dir) {
		if (!name.endsWith(".json")) continue;
		try {
			if (now - statSync(join(bridgeDir(), name)).mtimeMs > maxAgeMs) {
				unlinkSync(join(bridgeDir(), name));
			}
		} catch {
			/* fail-soft per file */
		}
	}
}
