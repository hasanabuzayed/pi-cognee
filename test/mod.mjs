/**
 * Shared module surface for test scripts.
 *
 * The v0.6 restructure deleted the monolithic src/client.ts; the modules it
 * became are merged here so `clientMod.*` references in live/probe tests keep
 * working. smoke.mjs uses the same list — one place to update when modules
 * move again.
 *
 * NOTE: call loadClientMod() AFTER setting hermetic env vars — the config
 * module reads them at evaluation time (jiti moduleCache:false per script).
 */
import path from "node:path";

export const SRC_MODULES = [
	"src/client/index.ts",
	"src/client/agent_key_record.ts",
	"src/client/helpers.ts",
	"src/config/index.ts",
	"src/config/active_dataset_record.ts",
	"src/config/env_file.ts",
	"src/constants.ts",
	"src/helpers/index.ts",
	"src/helpers/code_graph.ts",
	"src/helpers/errors.ts",
	"src/helpers/fingerprint.ts",
	"src/helpers/git.ts",
	"src/helpers/log.ts",
	"src/helpers/remember_file.ts",
	"src/helpers/shared_breaker.ts",
	"src/helpers/shared_memory_marker.ts",
	"src/helpers/tracing.ts",
	"src/provisioning.ts",
];

/** Merge every split module's exports into one clientMod-style surface. */
export async function loadClientMod(jiti, root) {
	const mods = await Promise.all(
		SRC_MODULES.map((rel) => jiti.import(path.join(root, ...rel.split("/")))),
	);
	return Object.assign({}, ...mods);
}
