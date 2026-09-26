/**
 * pi-cognee — HTTP transport for the cognee memory server.
 *
 * The byte-identical HTTP layer shared by the official Claude Code and Codex
 * cognee plugins (research/codex-api-brief.md): timeout+abort wiring, error
 * classification, one connect-retry for reads, and the JSON request/response
 * envelope. No identity policy beyond auth headers supplied by the caller.
 */
import type { CogneeConfig } from "../config/types";
import { sleep } from "../helpers";
import {
	CogneeError,
	describeError,
	wrapAsCogneeError,
} from "../helpers/errors";
import type { HealthResult } from "../helpers/types";
import type { RawFetchOptions } from "./types";

/** The identity surface jsonRequest needs (implemented by ClientIdentity). */
export interface TransportIdentity {
	ensureAuth(): Promise<void>;
	effectiveKey(): string | undefined;
	authHeaders(): Record<string, string>;
	rejectAgentKey(usedKey: string | undefined): void;
}

export async function rawFetch(
	url: string,
	opts: RawFetchOptions,
): Promise<Response & { readText(): Promise<string> }> {
	const attempt = async (): Promise<
		Response & { readText(): Promise<string> }
	> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
		const onExternalAbort = () => controller.abort();
		opts.externalSignal?.addEventListener("abort", onExternalAbort, {
			once: true,
		});
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			clearTimeout(timer);
			opts.externalSignal?.removeEventListener(
				"abort",
				onExternalAbort,
			);
		};
		try {
			const resp = await fetch(url, {
				method: opts.method,
				headers: opts.headers,
				body: opts.body,
				signal: controller.signal,
			});
			// Abort wiring stays alive until the body is consumed: a server that sends
			// headers and then stalls must not hang the body read past the timeout.
			// Body-read failures get the same classification as connect failures.
			return Object.assign(resp, {
				readText: async (): Promise<string> => {
					try {
						return await resp.text();
					} catch (err) {
						if (opts.externalSignal?.aborted) {
							throw new CogneeError("request aborted", {
								aborted: true,
							});
						}
						if (
							err instanceof Error &&
							err.name === "AbortError"
						) {
							throw new CogneeError(
								`request timed out after ${opts.timeoutMs}ms`,
								{
									transient: true,
								},
							);
						}
						throw new CogneeError(
							`cannot read response body: ${describeError(err)}`,
							{
								unreachable: true,
							},
						);
					} finally {
						cleanup();
					}
				},
			});
		} catch (err) {
			cleanup();
			if (opts.externalSignal?.aborted) {
				throw new CogneeError("request aborted", { aborted: true });
			}
			if (err instanceof Error && err.name === "AbortError") {
				throw new CogneeError(
					`request timed out after ${opts.timeoutMs}ms`,
					{ transient: true },
				);
			}
			throw new CogneeError(
				`cannot reach cognee server: ${describeError(err)}`,
				{
					unreachable: true,
				},
			);
		}
	};
	try {
		return await attempt();
	} catch (err) {
		// ponytail: one 300ms-backoff retry on positively-absent servers, reads only —
		// writes never retry (no server-side idempotency; a retried write could duplicate).
		if (
			opts.retryOnConnect &&
			err instanceof CogneeError &&
			err.unreachable
		) {
			await sleep(300);
			return await attempt();
		}
		throw err;
	}
}

export async function jsonRequest<T>(
	identity: TransportIdentity,
	cfg: CogneeConfig,
	method: string,
	path: string,
	opts: {
		json?: unknown;
		timeoutMs?: number;
		externalSignal?: AbortSignal;
		retryOnConnect?: boolean;
	} = {},
): Promise<
	| { ok: true; status: number; data: T }
	| { ok: false; status: number; error: CogneeError }
> {
	try {
		await identity.ensureAuth(); // no-op once a key is resolved (or off-loopback)
		const usedKey = identity.effectiveKey();
		const headers = identity.authHeaders();
		let body: string | undefined;
		if (opts.json !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(opts.json);
		}
		const resp = await rawFetch(cfg.baseUrl + path, {
			method,
			headers,
			body,
			timeoutMs: opts.timeoutMs ?? cfg.requestTimeoutMs,
			externalSignal: opts.externalSignal,
			retryOnConnect: opts.retryOnConnect,
		});
		const text = await resp.readText();
		let data: unknown;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = text;
			}
		}
		if (!resp.ok) {
			if (resp.status === 401 || resp.status === 403)
				identity.rejectAgentKey(usedKey);
			const detail =
				data &&
				typeof data === "object" &&
				typeof (data as { error?: unknown }).error === "string"
					? (data as { error: string }).error
					: String(text).slice(0, 300);
			return {
				ok: false,
				status: resp.status,
				error: new CogneeError(
					`HTTP ${resp.status} ${method} ${path}: ${detail}`,
					{
						status: resp.status,
					},
				),
			};
		}
		return { ok: true, status: resp.status, data: data as T };
	} catch (err) {
		return { ok: false, status: 0, error: wrapAsCogneeError(err) };
	}
}

/** Liveness probe. Any status < 500 counts as reachable (per the server contract). */
export async function healthCheck(
	cfg: CogneeConfig,
	timeoutMs: number = cfg.healthTimeoutMs,
): Promise<HealthResult> {
	const started = Date.now();
	try {
		const resp = await rawFetch(`${cfg.baseUrl}/health`, {
			method: "GET",
			timeoutMs,
			retryOnConnect: true,
		});
		const latencyMs = Date.now() - started;
		const text = await resp.readText();
		let version: string | undefined;
		try {
			const parsed = JSON.parse(text) as { version?: unknown };
			if (parsed && typeof parsed.version === "string")
				version = parsed.version;
		} catch {
			/* non-JSON health body is fine */
		}
		if (resp.status < 500)
			return {
				reachable: true,
				latencyMs,
				status: resp.status,
				version,
			};
		return {
			reachable: false,
			latencyMs,
			status: resp.status,
			error: `HTTP ${resp.status}`,
		};
	} catch (err) {
		return {
			reachable: false,
			latencyMs: Date.now() - started,
			error: describeError(err),
		};
	}
}
