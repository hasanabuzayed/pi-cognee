/**
 * pi-cognee — health check orchestration (v0.7 extraction from index.ts).
 *
 * The probe itself lives in client/transport (healthCheck); this module owns
 * the session-side choreography around a result: breaker accounting, dataset
 * ensure, write-queue drain, provisioning trigger, code-graph auto-index,
 * T2 bootstrap trigger, statusline + degraded-notify policy. Fail-soft by
 * design — a health probe must never take the extension down.
 */
import type { CogneeClient } from "./client";
import type { CogneeConfig } from "./config/types";
import type { HealthResult } from "./helpers/types";
import type { SessionState } from "./session";

/** The factory closures runHealthCheck orchestrates (threaded as a deps
 *  object so the extension entry keeps owning UI + wiring glue). */
export interface HealthDeps {
	client: CogneeClient;
	cfg: CogneeConfig;
	state: SessionState;
	notifySafe(message: string, type?: "info" | "warning" | "error"): void;
	renderStatusline(): void;
	recordSuccess(): void;
	drainWriteQueue(): Promise<void>;
	runProvisioningFlow(): Promise<void>;
	autoIndexOnStart(cwd: string): Promise<void>;
	maybeBootstrap(): Promise<void>;
}

export async function runHealthCheck(
	deps: HealthDeps,
	opts: { notify: boolean },
): Promise<HealthResult> {
	const { client, cfg, state } = deps;
	if (state.stopped)
		return { reachable: false, latencyMs: 0, error: "extension stopped" };
	const result = await client.health();
	state.lastCheckAt = Date.now();
	if (result.reachable) {
		state.healthy = true;
		state.lastError = "";
		deps.recordSuccess();
		// Loopback server with no key yet — start the owner-key bootstrap in the
		// background so the first authenticated call rarely waits for it.
		void client.ensureAuth().catch(() => {});
		if (!state.datasetEnsured) {
			state.datasetEnsured = true;
			void client.ensureDataset(state.dataset).catch(() => {
				/* best-effort; the server creates datasets implicitly on write */
			});
		}
		void deps.drainWriteQueue().catch(() => {});
		// Shared-agent-memory provisioning runs after health resolves — once per
		// session, bounded, fail-soft (never blocks this probe's caller).
		void deps.runProvisioningFlow().catch(() => {});
		// Code-graph auto-index: one background attempt per session, only after the
		// server is confirmed healthy (never blocks startup; never fires when down).
		if (!state.autoIndexTried && state.cwd) {
			state.autoIndexTried = true;
			const timer = setTimeout(() => {
				state.timers.delete(timer);
				void deps.autoIndexOnStart(state.cwd).catch(() => {});
			}, 100);
			state.timers.add(timer);
		}
		state.connState = "ok";
		deps.renderStatusline();
		if (opts.notify || state.degradedNotified) {
			state.degradedNotified = false;
			deps.notifySafe("Cognee Memory Connected", "info");
		}
		return result;
	}
	state.healthy = false;
	state.lastError = result.error ?? "unreachable";
	state.connState = "offline";
	// T2 bootstrap trigger: an unreachable local server may be bootable (the
	// once-guard inside maybeBootstrap makes this cheap after the first time).
	void deps.maybeBootstrap().catch(() => {});
	// Same information set as the official statusline (health · backend · dataset).
	deps.renderStatusline();
	if (opts.notify && !state.degradedNotified) {
		state.degradedNotified = true;
		deps.notifySafe(
			`Cognee memory offline (${cfg.missingBaseUrl ? "COGNEE_BASE_URL missing for forced cloud mode" : state.lastError}). ` +
				"Memory features are disabled; everything else works normally. Run /cognee-doctor to diagnose.",
			"warning",
		);
	}
	return result;
}

export type { HealthResult };
