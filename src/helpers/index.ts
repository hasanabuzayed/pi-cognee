import { join } from "node:path";
import { DEFAULT_PI_STATE_DIR } from "../constants";
import { datasetKeyFingerprint, principalFingerprint } from "./fingerprint";
import { createHash } from "node:crypto";

export { logPluginEvent } from "./log";

/** Local-mode quickstart servers live on the loopback interface. Same predicate as the
 *  official plugins' service_url_is_local: consent for auto-index = the code never
 *  leaves this machine, which is a property of the URL host, not the backend label. */
export function isLoopbackUrl(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "::1" ||
			host === "0.0.0.0"
		);
	} catch {
		return false;
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** pi-side state dir (~/.cognee-plugin/pi), override for tests/embedding. */
export function piStateDir(): string {
	return process.env.COGNEE_PI_STATE_DIR ?? DEFAULT_PI_STATE_DIR;
}

export function activeDatasetPath(): string {
	return join(piStateDir(), "active-dataset.json");
}

/* ------------------------------------------------------------------ */
/* Naming helpers                                                      */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const UUID32_RE = /^[0-9a-f]{32}$/i;

/**
 * `dataset_id(value)` from the reference `_dataset_access.py`, verbatim semantics:
 * `str(UUID(str(value)))` — accepts UUIDs with or without hyphens, case-insensitively,
 * canonicalizes to the lowercase-hyphenated form, and returns "" for anything else
 * ("Dataset UUIDs are authoritative; names are only for owned datasets.").
 * Unlike Python's UUID constructor, brace-wrapped (`{…}`) and URN (`urn:uuid:…`)
 * forms are not accepted — practically irrelevant for the JSON env array and the
 * dataset arguments this feeds.
 */
export function canonicalUuid(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  if (UUID_RE.test(raw)) return raw.toLowerCase();
  if (UUID32_RE.test(raw)) {
    return [
      raw.slice(0, 8),
      raw.slice(8, 12),
      raw.slice(12, 16),
      raw.slice(16, 20),
      raw.slice(20, 32),
    ]
      .join("-")
      .toLowerCase();
  }
  return "";
}

export function sanitizeDatasetName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9-_.]/g, "-").slice(0, 100);
  return cleaned || "agent_sessions";
}

export function sanitizeSessionId(id: string): string {
	return id.replace(/[^A-Za-z0-9-_.]/g, "-").slice(0, 120);
}

/** First non-empty of several spellings (OutDTOs answer camelCase — reference
 *  _row_str). */
export function rowStr(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * `mint_switch_session_id` from the reference, ported: a switch never reuses
 * a session id — it mints the next ordinal suffix (`pi_x`, `pi_x__2`, `__3`, …),
 * so the new session never collides while staying readable in the dashboard.
 */
export function mintSwitchSessionId(current: string): string {
  const m = current.match(/^(.*)__(\d+)$/);
  return m ? `${m[1]}__${Number(m[2]) + 1}` : `${current}__2`;
}

/**
 * Match a user-given switch target against readable dataset rows: exact name,
 * or UUID (canonicalized — "Dataset UUIDs are authoritative"). More than one
 * row → ambiguous ("select its UUID"); zero → not listed (create-on-switch is
 * the picker's free-typed "Other" behavior, decided by the caller).
 */
export function matchDatasets(
  target: string,
  rows: { name: string; id: string }[],
): { status: "ok" | "ambiguous" | "missing"; matches: { name: string; id: string }[] } {
  const uuid = canonicalUuid(target);
  const matches = rows.filter((d) => (uuid ? canonicalUuid(d.id) === uuid : d.name === target));
  return {
    status: matches.length === 0 ? "missing" : matches.length > 1 ? "ambiguous" : "ok",
    matches,
  };
}

export { datasetKeyFingerprint, principalFingerprint };
