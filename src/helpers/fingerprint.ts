import { createHash } from "node:crypto";

/** sha256 of the principal key (reference _principal_fingerprint). */
export function principalFingerprint(key: string): string {
	return key ? createHash("sha256").update(key, "utf8").digest("hex") : "";
}

/** The server+identity fingerprint a persisted switch is keyed by. */
export function datasetKeyFingerprint(
	baseUrl: string,
	apiKey?: string,
): string {
	return createHash("sha256")
		.update(`${baseUrl}\n${apiKey ?? ""}`, "utf8")
		.digest("hex");
}
