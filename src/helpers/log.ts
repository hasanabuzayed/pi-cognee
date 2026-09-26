import {
	appendFileSync,
	mkdirSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { piStateDir } from "./paths";

/** Rotation cap for plugin event logs — env override, 20 MiB default. */
export function pluginLogMaxBytes(): number {
	const raw = process.env.COGNEE_PLUGIN_LOG_MAX_BYTES;
	if (raw) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return 20 * 1024 * 1024;
}

/** One JSON-lines append with size-capped rotation (path → path.1). Fail-soft:
 *  the single rotation implementation shared by the plugin and bootstrap event
 *  logs (was two drifting copies). */
export function appendRotatedJsonl(
	path: string,
	event: Record<string, unknown>,
	maxBytes: number = pluginLogMaxBytes(),
): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		try {
			if (statSync(path).size >= maxBytes) {
				try {
					unlinkSync(`${path}.1`);
				} catch {
					/* no previous rotation */
				}
				renameSync(path, `${path}.1`);
			}
		} catch {
			/* absent — first line */
		}
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, "utf8");
	} catch {
		/* fail-soft — logging must never break the caller */
	}
}

/** Provisioning event log — same JSON-lines bootstrap.log the v0.4 bootstrap
 *  cluster writes. Path matches bootstrapPaths().bootstrapLog exactly
 *  (`<stateRoot>/pi/bootstrap.log`, root = parent of pi's state dir) so both
 *  writers hit one file even when COGNEE_PI_STATE_DIR is overridden. */
export function logPluginEvent(event: Record<string, unknown>): void {
	appendRotatedJsonl(
		join(dirname(piStateDir()), "pi", "bootstrap.log"),
		event,
	);
}
