import { readFileSync } from "node:fs";
import { activeDatasetPath } from "../helpers/paths";
import { describeError } from "../helpers/errors";
import { atomicWriteJson } from "./atomic";

/* ------------------------------------------------------------------- */
/* Persisted dataset switch (~/.cognee-plugin/pi/active-dataset.json)  */
/* The pi analog of the reference launch record: a switch must survive */
/* restarts and resumes. pi has no stable host session id across       */
/* processes, so this record IS the session affinity.                  */
/* ------------------------------------------------------------------- */

export interface ActiveDatasetRecord {
	/** Server the switch was recorded for — never served to another backend. */
	base_url: string;
	/** sha256(baseUrl + effective api key) — same discipline as the reference's
	 *  readable-datasets cache: an active dataset minted for one identity is
	 *  never served to another. Keys on the PRINCIPAL key (never the agent key —
	 *  flipping to a plugin identity must not orphan the persisted switch). */
	key_fp: string;
	dataset: string;
	/** Ordinal-suffixed session id minted by the switch (adopted on restart). */
	session_id: string;
	/** Canonical write UUID under shared memory (v0.4; "" → name addressing). */
	dataset_id?: string;
	/** Shared-memory recall read set (v0.4; write UUID + same-named copies). */
	dataset_ids?: string[];
	/** The retired triple (the reference keeps these in `touched`). */
	previous?: { dataset: string; session_id: string; synced: boolean };
	switched_at: string;
}

/** Read the persisted active-dataset record; undefined unless it exists, parses,
 *  and belongs to exactly this backend (base_url + key fingerprint). Fail-soft:
 *  an absent or corrupt record leaves the env seed in charge, never a crash. */
export function loadActiveDatasetRecord(
	baseUrl: string,
	keyFp: string,
): ActiveDatasetRecord | undefined {
	try {
		const raw = JSON.parse(
			readFileSync(activeDatasetPath(), "utf8"),
		) as ActiveDatasetRecord;
		if (!raw || typeof raw !== "object") return undefined;
		if (raw.base_url !== baseUrl || raw.key_fp !== keyFp) return undefined;
		if (typeof raw.dataset !== "string" || !raw.dataset) return undefined;
		if (typeof raw.session_id !== "string" || !raw.session_id)
			return undefined;
		return raw;
	} catch {
		return undefined;
	}
}

/** Atomically persist the active-dataset record (tmp + rename, same pattern as
 *  the other state writers). Unlike them this one REPORTS failure: the switcher
 *  must roll back when the record cannot be persisted ("nothing was changed").
 *  Never throws. */
export function saveActiveDatasetRecord(record: ActiveDatasetRecord): {
	ok: boolean;
	error?: string;
} {
	try {
		atomicWriteJson(activeDatasetPath(), record);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: describeError(err) };
	}
}
