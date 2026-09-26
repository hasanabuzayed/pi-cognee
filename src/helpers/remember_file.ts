/*
 * ------------------------------------------------------------------
 * Per-file ingestion (cognee-remember --file) — guarded disk read
 * ------------------------------------------------------------------ */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { describeError } from "./errors";

/** Hard cap for a --file upload (same as the official plugins' practical limit). */
export const REMEMBER_FILE_MAX_BYTES = 200_000;

/** Obvious secret-carrier paths, refused before any disk read. The reference
 *  --file route uploads any user-given path verbatim (parity), but pi-cognee
 *  refuses credential-looking files (~/.ssh, *.pem, .env, id_rsa*, credentials*)
 *  with a helpful error — hardening beyond parity. */
const SENSITIVE_REMEMBER_PATH_RE =
	/(?:^|[\\/])\.ssh(?:[\\/]|$)|(?:^|[\\/])\.env(?:[\\/.]|$)|(?:^|[\\/])id_(?:rsa|dsa|ecdsa|ed25519)|(?:^|[\\/])credentials[^\\/]*$|\.pem$/i;

interface RememberFileResult {
	ok: boolean;
	/** File text (utf-8) — verbatim, NOT redacted (code must route as code). */
	text?: string;
	/** Real basename — the server's loader-routing signal (payments.py → code route). */
	basename?: string;
	bytes?: number;
	error?: string;
}

/**
 * Read one file for /api/v1/remember file ingestion. Mirrors cognee-remember.sh
 * --file + _remember_http.do_remember: the file must exist, is capped in size,
 * and must be text (NUL bytes / control-char-heavy content is rejected — the
 * prose and code pipelines are text-only). Never throws; failures come back as
 * { ok: false, error } so callers can surface a helpful message.
 */
export function readRememberFile(
	filePath: string,
	maxBytes: number = REMEMBER_FILE_MAX_BYTES,
): RememberFileResult {
	try {
		const trimmed = String(filePath).replace(/\/+$/, "");
		if (SENSITIVE_REMEMBER_PATH_RE.test(trimmed)) {
			return {
				ok: false,
				error: `refusing likely-secret file '${filePath}' — remember the non-secret part as content instead`,
			};
		}
		const st = statSync(trimmed);
		if (!st.isFile())
			return { ok: false, error: `not a file: ${filePath}` };
		if (st.size > maxBytes) {
			return {
				ok: false,
				error: `file too large (${st.size} bytes; limit ${maxBytes}) — remember a summary instead`,
			};
		}
		const buf = readFileSync(trimmed);
		// Text-only guard: a NUL byte or a control-char-heavy head means binary —
		// uploading it would corrupt the graph and route nowhere useful.
		const probe = buf.subarray(0, 8192);
		let control = 0;
		for (const byte of probe) {
			if (byte === 0)
				return {
					ok: false,
					error: `binary file rejected (NUL byte): ${filePath}`,
				};
			if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)
				control++;
		}
		if (probe.length > 0 && control / probe.length > 0.1) {
			return {
				ok: false,
				error: `binary file rejected (too many control characters): ${filePath}`,
			};
		}
		return {
			ok: true,
			text: buf.toString("utf8"),
			basename: basename(trimmed) || "upload.txt",
			bytes: st.size,
		};
	} catch (err) {
		const message = describeError(err);
		return {
			ok: false,
			error: /ENOENT/.test(message)
				? `file not found: ${filePath}`
				: `cannot read ${filePath}: ${message}`,
		};
	}
}
