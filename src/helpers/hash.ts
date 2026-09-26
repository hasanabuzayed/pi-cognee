import { createHash } from "node:crypto";

/** One-line digests — the only hashing implementations in the codebase
 *  (was three copies: fingerprint.ts, helpers/index.ts, improve-state.ts). */
export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha1Hex(value: string): string {
	return createHash("sha1").update(value, "utf8").digest("hex");
}

/** sha256 of the principal key (reference _principal_fingerprint). */
export function principalFingerprint(key: string): string {
	return key ? sha256Hex(key) : "";
}

/** The server+identity fingerprint a persisted switch is keyed by. */
export function datasetKeyFingerprint(
	baseUrl: string,
	apiKey?: string,
): string {
	return sha256Hex(`${baseUrl}\n${apiKey ?? ""}`);
}
