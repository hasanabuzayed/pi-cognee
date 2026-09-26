import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeDatasetPath, piStateDir } from "../helpers";
import { describeError } from "../helpers/errors";
import type { ActiveDatasetRecord } from "./types";

/* ------------------------------------------------------------------- */
/* Persisted dataset switch (~/.cognee-plugin/pi/active-dataset.json)  */
/* The pi analog of the reference launch record: a switch must survive */
/* restarts and resumes. pi has no stable host session id across       */
/* processes, so this record IS the session affinity.                  */
/* ------------------------------------------------------------------- */

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
		const dir = piStateDir();
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "active-dataset.json");
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
		renameSync(tmp, path);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: describeError(err) };
	}
}
