import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One atomic JSON write for every ~/.cognee-plugin state file (tmp + rename,
 *  pretty + trailing newline). Was four copies with drifting atomicity.
 *  Throws on IO failure — callers decide fail-soft vs report. */
export function atomicWriteJson(
	path: string,
	data: unknown,
	opts: { mode?: number } = {},
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", {
		encoding: "utf8",
		mode: opts.mode,
	});
	renameSync(tmp, path);
}
