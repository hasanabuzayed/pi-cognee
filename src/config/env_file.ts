import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalUuid } from "../helpers";
import { describeError } from "../helpers/errors";

/* ------------------------------------------------------------------ */
/* Env file (~/.cognee/.env) — shared with the Claude Code / Codex plugins */
/* ------------------------------------------------------------------ */

type EnvLookup = (key: string) => string | undefined;

export type { EnvLookup };

/* ------------------------------------------------------------------ */
/* Federated read datasets (COGNEE_PLUGIN_READ_DATASET_IDS)            */
/* Mirrors reference _dataset_access.py recall_fields' env lane.       */
/* ------------------------------------------------------------------ */

interface ReadDatasetIdsResult {
	/** Canonical UUIDs, deduped preserving first-seen order; absent when unset/blank/invalid. */
	datasetIds?: string[];
	/** Exact reference error string when the value is present but malformed. */
	error?: string;
}

/** Keys we never import from the env file (same denylist as the official plugins). */
const ENV_FILE_DENYLIST = /^(PATH|HOME|SHELL|USER|PYTHON\w*|LD_.+|DYLD_.+)$/;

export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const stripped = line.startsWith("export ")
			? line.slice(7).trim()
			: line;
		const eq = stripped.indexOf("=");
		if (eq <= 0) continue;
		const key = stripped.slice(0, eq).trim();
		let value = stripped.slice(eq + 1).trim();
		if (
			(value.startsWith('"') &&
				value.endsWith('"') &&
				value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		if (!key || ENV_FILE_DENYLIST.test(key)) continue;
		out[key] = value; // last wins
	}
	return out;
}

interface EnvFileResult {
	path: string;
	exists: boolean;
	values: Record<string, string>;
}

export function loadCogneeEnvFile(): EnvFileResult {
	const path =
		process.env.COGNEE_ENV_FILE || join(homedir(), ".cognee", ".env");
	try {
		const text = readFileSync(path, "utf8");
		return { path, exists: true, values: parseEnvFile(text) };
	} catch {
		return { path, exists: false, values: {} };
	}
}

export function num(
	effective: EnvLookup,
	key: string,
	fallback: number,
): number {
	const raw = effective(key);
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function bool(
	effective: EnvLookup,
	key: string,
	fallback: boolean,
): boolean {
	const raw = effective(key);
	if (raw === undefined || raw === "") return fallback;
	return !/^(false|0|no|off)$/i.test(raw);
}

/** Reference `_list_env`: unset/blank → []; a leading `[` switches to JSON-array
 *  mode (must be an array of strings — the exact reference error otherwise);
 *  anything else splits on `separator`, parts trimmed, empties dropped. */
export function parseListEnv(
	raw: string | undefined,
	opts: { separator: string; label: string },
): { values: string[]; error?: string } {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return { values: [] };
	if (trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (
				!Array.isArray(parsed) ||
				!parsed.every((v) => typeof v === "string")
			) {
				return {
					values: [],
					error: `${opts.label} must be an array of strings`,
				};
			}
			return { values: parsed };
		} catch (err) {
			return {
				values: [],
				error: `${opts.label} is not valid JSON: ${describeError(err)}`,
			};
		}
	}
	return {
		values: trimmed
			.split(opts.separator)
			.map((part) => part.trim())
			.filter(Boolean),
	};
}

/** COGNEE_CODE_AUTOINDEX semantics (same values as the official plugins). */
export function autoindexMode(effective: EnvLookup): "auto" | "always" | "off" {
	const value = (effective("COGNEE_CODE_AUTOINDEX") || "")
		.trim()
		.toLowerCase();
	if (["off", "0", "false", "no"].includes(value)) return "off";
	if (["always", "1", "true", "yes", "on"].includes(value)) return "always";
	return "auto";
}

/**
 * COGNEE_PLUGIN_READ_DATASET_IDS — a JSON array of dataset UUIDs that widens
 * GRAPH recall (read-only federation; writes never consult it). Parsing mirrors
 * the reference field-for-field: unset or whitespace-only → off; invalid JSON →
 * the exact error with the parser's message appended verbatim; non-list / empty
 * list / any non-UUID entry → the exact shape error; entries canonicalized via
 * dataset_id (hyphens optional, case-insensitive) then deduped preserving
 * first-seen order (dict.fromkeys). The reference raises these errors at recall
 * time; pi-cognee surfaces the same exact strings at config load instead —
 * fail-soft: a bad value disables federation, it never crashes the recall path.
 */
export function parseReadDatasetIds(
	raw: string | undefined,
): ReadDatasetIdsResult {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return {}; // unset or whitespace-only → no federation
	let values: unknown;
	try {
		values = JSON.parse(trimmed);
	} catch (err) {
		return {
			error: `COGNEE_PLUGIN_READ_DATASET_IDS is not valid JSON: ${describeError(err)}`,
		};
	}
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		!values.every((v) => canonicalUuid(v) !== "")
	) {
		return {
			error: "COGNEE_PLUGIN_READ_DATASET_IDS must be a nonempty JSON list of UUIDs",
		};
	}
	// Dedupe AFTER canonicalization, first-seen order preserved (dict.fromkeys).
	return { datasetIds: [...new Set(values.map((v) => canonicalUuid(v)))] };
}
