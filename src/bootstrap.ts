/**
 * pi-cognee — local server bootstrap (v0.4).
 *
 * Boots a local cognee API server the way the official Claude Code / Codex
 * plugins do: uv venv, pinned cognee, detached uvicorn, single-flight locks,
 * boot deadline — ported from reference/claude-code/scripts/session-start.py
 * (research/v04-bootstrap-spec.md is the contract).
 *
 * Constraints honored:
 * - No MCP, no npm deps; node builtins only (plus client.ts helpers).
 * - This module defines functions and spawns NOTHING at import time. Every
 *   spawn happens inside ensureLocalServerRunning()/ensureCogneeInstalled(),
 *   which are only ever called from the session_start handler or the health
 *   re-probe path (index.ts maybeBootstrap).
 * - Fail-soft everywhere: every public entry returns a result object; nothing
 *   throws out of the exported functions.
 * - The shared root (~/.cognee-plugin) single-flights pi against the official
 *   plugins: same lock files, same pidfile, same venv (spec §4).
 * - Never kill an adopted server; a pi-booted server is spawned detached and
 *   persists (no COGNEE_AGENT_MODE — deliberate divergence, spec §2.2/§6.1).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
	accessSync,
	appendFileSync,
	closeSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isLoopbackUrl, piStateDir, sleep } from "./helpers";
import { type EnvLookup, loadCogneeEnvFile } from "./config/env_file";
import { describeError } from "./helpers/errors";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Constants (reference parity, spec §1.1)                             */
/* ------------------------------------------------------------------ */

/** Hardcoded install pin — NOT env-overridable (parity with session-start.py:120). */
export const PINNED_COGNEE_VERSION = "1.6.0";
export const DEFAULT_PYTHON_PIN = "3.12";

const HEALTH_PROBE_TIMEOUT_MS = 2000;
const PRESENCE_REPROBE_TIMEOUT_MS = 5000;
const TCP_PROBE_TIMEOUT_MS = 500;
const BOOT_LOCK_STALE_MS = 60_000; // 2 × 30s health timeout (reference)
const BOOT_LOCK_WAIT_MS = 35_000; // 30s + 5 (reference)
const BOOT_LOCK_POLL_MS = 200;
const INSTALL_LOCK_POLL_MS = 500;
const VERSION_PROBE_TIMEOUT_MS = 30_000;
const UV_INSTALL_TIMEOUT_MS = 120_000;
const CONSOLE_LOG_CAP_BYTES = 1024 * 1024; // 1 MiB per boot (reference pump cap)

/** Extra → sentinel dist proving the extra's drivers are installed (#232). */
const EXTRA_SENTINEL_DISTS: Readonly<Record<string, string>> = {
	"postgres-binary": "asyncpg",
	neo4j: "neo4j",
	fastembed: "fastembed",
	ollama: "transformers",
};

/** Keys never sourced from the env file when building the server env
 *  (parseEnvFile already drops them; re-checked here for direct callers). */
const SERVER_ENV_FILE_DENYLIST =
	/^(PATH|HOME|SHELL|USER|PYTHON\w*|LD_.+|DYLD_.+)$/;

const VERSION_PROBE_SCRIPT =
	"import importlib.metadata as m; print(m.version('cognee'))";
const EXTRAS_PROBE_SCRIPT =
	"import importlib.metadata as m, sys\n" +
	"for d in sys.argv[1:]:\n" +
	"    try:\n" +
	"        m.version(d)\n" +
	"    except Exception:\n" +
	"        print(d)";

/** Env knob honoring shell > ~/.cognee/.env like the reference's os.environ. */
function envValue(key: string): string | undefined {
	const shell = process.env[key];
	if (shell !== undefined && shell !== "") return shell;
	return loadCogneeEnvFile().values[key];
}

function envNumber(key: string, fallback: number): number {
	const raw = envValue(key);
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Effective shell > env-file lookup (rebuilt per call — cheap, test-friendly). */
export function cogneeEnvLookup(): EnvLookup {
	const values = loadCogneeEnvFile().values;
	return (key: string) => process.env[key] ?? values[key];
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export interface BootstrapPaths {
	/** Shared plugin root — the SAME root the Claude Code/Codex plugins use. */
	stateRoot: string;
	uvDir: string;
	uvBin: string;
	uvPythonDir: string;
	venvDir: string;
	venvPython: string;
	venvReady: string;
	installLock: string;
	bootLock: string;
	pidFile: (port: number) => string;
	/** JSON-lines bootstrap event log (pi-scoped). */
	bootstrapLog: string;
	/** Server console capture (pi-scoped, rotated to `.1`). */
	consoleLog: (port?: number) => string;
}

/**
 * All bootstrap paths under one root. Default root = the parent of pi's state
 * dir (`~/.cognee-plugin` — the shared root), so honoring COGNEE_PI_STATE_DIR
 * relocates the whole bootstrap cluster for tests. The `stateRoot` parameter
 * overrides directly (tests only).
 */
export function bootstrapPaths(stateRoot?: string): BootstrapPaths {
	const root = stateRoot ?? dirname(piStateDir());
	return {
		stateRoot: root,
		uvDir: join(root, "uv"),
		uvBin: join(root, "uv", "uv"),
		uvPythonDir: join(root, "python"),
		venvDir: join(root, "venv"),
		venvPython: join(root, "venv", "bin", "python"),
		venvReady: join(root, "venv-ready.json"),
		installLock: join(root, "venv-install.lock"),
		bootLock: join(root, "server-bootstrap.lock"),
		pidFile: (port: number) => join(root, `server-${port}.pid`),
		bootstrapLog: join(root, "pi", "bootstrap.log"),
		consoleLog: (port?: number) =>
			join(root, "pi", `server-console${port ? `-${port}` : ""}.log`),
	};
}

/** Port of a service URL (default 8011 on parse failure — reference default). */
export function serverPort(baseUrl: string): number {
	try {
		const parsed = new URL(baseUrl);
		const port = Number(parsed.port);
		if (Number.isInteger(port) && port > 0) return port;
		return parsed.protocol === "https:" ? 443 : 80;
	} catch {
		return 8011;
	}
}

/* ------------------------------------------------------------------ */
/* Bootstrap event log (JSON lines, rotated) — fail-soft               */
/* ------------------------------------------------------------------ */

export function logBootstrapEvent(
	event: Record<string, unknown>,
	stateRoot?: string,
): void {
	try {
		const paths = bootstrapPaths(stateRoot);
		mkdirSync(dirname(paths.bootstrapLog), { recursive: true });
		const maxBytes = envNumber(
			"COGNEE_PLUGIN_LOG_MAX_BYTES",
			20 * 1024 * 1024,
		);
		try {
			const st = statSync(paths.bootstrapLog);
			if (st.size >= maxBytes) {
				try {
					unlinkSync(`${paths.bootstrapLog}.1`);
				} catch {
					/* no previous rotation */
				}
				renameSync(paths.bootstrapLog, `${paths.bootstrapLog}.1`);
			}
		} catch {
			/* absent — first line */
		}
		appendFileSync(
			paths.bootstrapLog,
			`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
			"utf8",
		);
	} catch {
		/* fail-soft — logging must never break the boot */
	}
}

/* ------------------------------------------------------------------ */
/* Pid helpers                                                         */
/* ------------------------------------------------------------------ */

/** pid 0 signal test: ESRCH = dead, EPERM = alive (exists, not ours). */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Best-effort pid-reuse guard: does the pid's command line still look like the
 * cognee server? Probe failure = looks-alive (pidfile evidence is veto-only;
 * a wrong true costs a delayed boot and self-heals — reference parity).
 */
async function pidLooksLikeServer(pid: number): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"ps",
			["-p", String(pid), "-o", "command="],
			{
				timeout: 5000,
				windowsHide: true,
			},
		);
		const command = stdout.trim().toLowerCase();
		if (!command) return false;
		return command.includes("uvicorn") || command.includes("cognee");
	} catch {
		return true;
	}
}

interface ServerPidRecord {
	pid: number;
	port: number;
	version?: string;
	created_at?: number;
}

/** Write the spawn-evidence pidfile (NOT a kill handle — presence only). */
function writeServerPidfile(
	port: number,
	pid: number,
	stateRoot?: string,
): void {
	try {
		const paths = bootstrapPaths(stateRoot);
		mkdirSync(paths.stateRoot, { recursive: true });
		writeFileSync(
			paths.pidFile(port),
			JSON.stringify({
				pid: Number(pid),
				port: Number(port),
				version: PINNED_COGNEE_VERSION,
				created_at: Date.now() / 1000,
			}),
			"utf8",
		);
	} catch (err) {
		logBootstrapEvent(
			{ event: "server_pidfile_write_failed", error: describeError(err) },
			stateRoot,
		);
	}
}

function clearServerPidfile(port: number, stateRoot?: string): void {
	try {
		unlinkSync(bootstrapPaths(stateRoot).pidFile(port));
	} catch {
		/* absent — fine */
	}
}

/**
 * Live server pid for a port, or undefined. Stale records (dead pid, reused
 * pid whose command no longer matches, unparseable) are reaped so they can
 * never veto boots forever (reference `_live_server_pid`).
 */
async function liveServerPid(
	port: number,
	stateRoot?: string,
): Promise<number> {
	const path = bootstrapPaths(stateRoot).pidFile(port);
	let pid = 0;
	try {
		pid = Number(JSON.parse(readFileSync(path, "utf8"))?.pid);
	} catch {
		pid = 0;
	}
	if (
		Number.isInteger(pid) &&
		pid > 0 &&
		pidAlive(pid) &&
		(await pidLooksLikeServer(pid))
	) {
		return pid;
	}
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
	return 0;
}

/** Doctor row: `server-<port>.pid: <pid, alive|stale|absent>` (no reaping). */
export function serverPidfileStatus(port: number, stateRoot?: string): string {
	const path = bootstrapPaths(stateRoot).pidFile(port);
	try {
		const record = JSON.parse(
			readFileSync(path, "utf8"),
		) as ServerPidRecord;
		const pid = Number(record?.pid);
		if (Number.isInteger(pid) && pid > 0) {
			return `${path.split("/").pop()}: ${pid}, ${pidAlive(pid) ? "alive" : "stale"}`;
		}
		return `${path.split("/").pop()}: stale (unparseable)`;
	} catch {
		return `${path.split("/").pop()}: absent`;
	}
}

/* ------------------------------------------------------------------ */
/* Probes                                                              */
/* ------------------------------------------------------------------ */

async function httpHealth(
	baseUrl: string,
	timeoutMs: number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
			signal: controller.signal,
		});
		if (resp.body) void resp.body.cancel().catch(() => {});
		return { ok: resp.status === 200, status: resp.status };
	} catch (err) {
		const aborted = err instanceof Error && err.name === "AbortError";
		return { ok: false, error: aborted ? "timeout" : describeError(err) };
	} finally {
		clearTimeout(timer);
	}
}

async function httpHealthOk(
	baseUrl: string,
	timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<boolean> {
	return (await httpHealth(baseUrl, timeoutMs)).ok;
}

/** Loopback TCP handshake: "listening" | "refused" | "no_verdict". */
function tcpProbe(
	host: string,
	port: number,
	timeoutMs = TCP_PROBE_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (verdict: string): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(verdict);
		};
		const socket = net.connect({ host, port });
		socket.setTimeout(timeoutMs, () => done("no_verdict"));
		socket.once("connect", () => done("listening"));
		socket.once("error", (err) => {
			done(
				(err as NodeJS.ErrnoException).code === "ECONNREFUSED"
					? "refused"
					: "no_verdict",
			);
		});
	});
}

/* ------------------------------------------------------------------ */
/* Presence (evidence triangle — absence is never concluded from a      */
/* timeout; reference _plugin_common.server_presence)                   */
/* ------------------------------------------------------------------ */

export type PresenceVerdict = "ready" | "busy" | "absent" | "unknown";

export interface PresenceOptions {
	probeTimeoutMs?: number;
	confirmAbsent?: boolean;
	reprobeDelayMs?: number;
	stateRoot?: string;
}

export async function serverPresence(
	baseUrl: string,
	opts: PresenceOptions = {},
): Promise<{ verdict: PresenceVerdict; evidence: Record<string, unknown> }> {
	const probeTimeoutMs = opts.probeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
	const evidence: Record<string, unknown> = { base_url: baseUrl };
	try {
		// 1. HTTP /health — 200 is the only "ready".
		const http = await httpHealth(baseUrl, probeTimeoutMs);
		evidence.http = http.ok ? "ready" : (http.status ?? http.error);
		if (http.ok) return { verdict: "ready", evidence };

		// 2. Local evidence (TCP, pidfile) applies to loopback hosts only; a
		//    non-ready remote is UNKNOWN — never absent.
		let host = "localhost";
		let port = 8011;
		try {
			const parsed = new URL(baseUrl);
			host = parsed.hostname || "localhost";
			port = serverPort(baseUrl);
		} catch {
			/* defaults above */
		}
		if (!isLoopbackUrl(baseUrl)) return { verdict: "unknown", evidence };

		// 3. TCP: a live listener answers in microseconds — busy even when the
		//    health probe missed (busy servers still hold the graph store lock).
		const tcp = await tcpProbe(host, port);
		evidence.tcp = tcp;
		if (tcp === "listening") return { verdict: "busy", evidence };

		// 4. Pidfile: spawned but not yet bound (spawn-to-bind window) — busy.
		const pid = await liveServerPid(port, opts.stateRoot);
		if (pid) {
			evidence.pid = pid;
			return { verdict: "busy", evidence };
		}

		// 5. Only a positive refusal may contribute to absence.
		if (tcp !== "refused") return { verdict: "unknown", evidence };

		// 6. Confirming re-probe: give a just-starting server one more chance
		//    before licensing an install over the port.
		if (opts.confirmAbsent) {
			const delayMs =
				opts.reprobeDelayMs ??
				envNumber("COGNEE_PRESENCE_REPROBE_DELAY", 3) * 1000;
			await sleep(delayMs);
			const retryHttp = await httpHealth(
				baseUrl,
				PRESENCE_REPROBE_TIMEOUT_MS,
			);
			evidence.http_retry = retryHttp.ok
				? "ready"
				: (retryHttp.status ?? retryHttp.error);
			if (retryHttp.ok) return { verdict: "ready", evidence };
			const retryTcp = await tcpProbe(host, port);
			if (retryTcp === "listening") {
				evidence.tcp_retry = retryTcp;
				return { verdict: "busy", evidence };
			}
		}
		return { verdict: "absent", evidence };
	} catch (err) {
		evidence.error = describeError(err);
		return { verdict: "unknown", evidence };
	}
}

/* ------------------------------------------------------------------ */
/* JSON locks (O_EXCL, stale-reap — reference parity, spec §4)          */
/* ------------------------------------------------------------------ */

export interface JsonLock {
	release(): void;
}

export interface JsonLockOptions {
	/** Holder pid dead, or lock older than this → reap and retake. */
	staleMs: number;
	/** Give up after this long (0 = single attempt + stale-reap retries). */
	waitMs: number;
	pollMs: number;
	owner: string;
	/** Escape hatch while a foreign holder keeps the lock: consulted after
	 *  each failed create attempt, BEFORE sleeping. A truthy resolve returns
	 *  "probe-shortcut" — the caller may proceed WITHOUT the lock. This is the
	 *  reference's install-lock loser path (session-start.py:445-456): the
	 *  waiter probes the venv at EVERY poll and returns as soon as the pin +
	 *  extras are satisfied, instead of stalling the whole lock window behind
	 *  a winner that will never produce anything better. */
	probe?: () => boolean | Promise<boolean>;
}

function lockIsStale(lockPath: string, staleMs: number): boolean {
	let raw: string;
	try {
		raw = readFileSync(lockPath, "utf8");
	} catch {
		return true; // unreadable = stale
	}
	try {
		const parsed = JSON.parse(raw) as {
			pid?: unknown;
			created_at?: unknown;
		};
		const pid = Number(parsed?.pid);
		if (!Number.isInteger(pid) || pid <= 0) return true;
		if (!pidAlive(pid)) return true; // ESRCH = dead; EPERM = alive
		const createdAt = Number(parsed?.created_at); // epoch SECONDS (reference format)
		if (!Number.isFinite(createdAt)) return true;
		if (Date.now() / 1000 - createdAt > staleMs / 1000) return true;
		return false;
	} catch {
		return true; // unparseable = stale
	}
}

/**
 * Acquire a single-flight JSON lock: `fs.openSync(path, "wx")` (O_CREAT|O_EXCL)
 * writing `{owner, pid, created_at}` (epoch seconds — the SAME format the
 * reference plugins write, so pi reaps their stale locks and vice versa).
 * Returns "probe-shortcut" when the configured `probe` fired while a foreign
 * holder kept the lock, or null when the lock stays held past `waitMs`.
 * Never throws.
 */
export async function acquireJsonLock(
	lockPath: string,
	opts: JsonLockOptions,
): Promise<JsonLock | "probe-shortcut" | null> {
	try {
		mkdirSync(dirname(lockPath), { recursive: true });
	} catch {
		return null;
	}
	const deadline = Date.now() + Math.max(0, opts.waitMs);
	for (;;) {
		let created = false;
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(
					fd,
					JSON.stringify({
						owner: opts.owner,
						pid: process.pid,
						created_at: Date.now() / 1000,
					}),
				);
				created = true;
			} finally {
				closeSync(fd);
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null; // unwritable — fail-soft
		}
		if (created) {
			let released = false;
			return {
				release: (): void => {
					if (released) return;
					released = true;
					try {
						unlinkSync(lockPath);
					} catch {
						/* already gone */
					}
				},
			};
		}
		if (lockIsStale(lockPath, opts.staleMs)) {
			try {
				unlinkSync(lockPath);
			} catch {
				/* raced — retry below */
			}
			continue; // immediate re-attempt after reaping
		}
		if (opts.probe && (await opts.probe())) return "probe-shortcut";
		if (Date.now() >= deadline) return null;
		await sleep(opts.pollMs);
	}
}

/* ------------------------------------------------------------------ */
/* Install (uv venv + pinned cognee, spec §1.5)                        */
/* ------------------------------------------------------------------ */

/** Install requirement: pinned cognee + provider extras from the effective env. */
export function cogneeInstallSpec(env: EnvLookup): string {
	const extras: string[] = [];
	const add = (extra: string): void => {
		if (!extras.includes(extra)) extras.push(extra);
	};
	const db = (env("DB_PROVIDER") ?? "").trim().toLowerCase();
	if (db === "postgres" || db === "postgresql") add("postgres-binary");
	if ((env("VECTOR_DB_PROVIDER") ?? "").trim().toLowerCase() === "pgvector")
		add("postgres-binary");
	if ((env("GRAPH_DATABASE_PROVIDER") ?? "").trim().toLowerCase() === "neo4j")
		add("neo4j");
	if ((env("EMBEDDING_PROVIDER") ?? "").trim().toLowerCase() === "fastembed")
		add("fastembed");
	if ((env("LLM_PROVIDER") ?? "").trim().toLowerCase() === "ollama")
		add("ollama");
	return extras.length
		? `cognee[${extras.join(",")}]==${PINNED_COGNEE_VERSION}`
		: `cognee==${PINNED_COGNEE_VERSION}`;
}

function requiredExtras(spec: string): string[] {
	const m = spec.match(/^cognee\[([^\]]+)\]/);
	return m
		? m[1]
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
}

/** Locate uv: self-managed copy first, then a no-spawn PATH scan. */
export function findUv(stateRoot?: string): string {
	const paths = bootstrapPaths(stateRoot);
	try {
		accessSync(paths.uvBin, fsConstants.X_OK);
		return paths.uvBin;
	} catch {
		/* not self-managed (yet) */
	}
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "uv");
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			/* keep scanning */
		}
	}
	return "";
}

/** Install standalone uv into <stateRoot>/uv (no PATH edits). Returns bin or "". */
export async function installUv(
	stateRoot?: string,
	timeoutMs = UV_INSTALL_TIMEOUT_MS,
): Promise<string> {
	const paths = bootstrapPaths(stateRoot);
	try {
		await execFileAsync(
			"sh",
			["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
			{
				env: { ...process.env, UV_UNMANAGED_INSTALL: paths.uvDir },
				timeout: timeoutMs,
				windowsHide: true,
			},
		);
	} catch (err) {
		logBootstrapEvent(
			{ event: "uv_install_failed", error: describeError(err) },
			stateRoot,
		);
		return "";
	}
	const uv = findUv(stateRoot);
	if (!uv)
		logBootstrapEvent(
			{ event: "uv_install_not_found_after_install" },
			stateRoot,
		);
	return uv;
}

/** cognee version inside the venv, or "" when unimportable/absent. */
export async function venvCogneeVersion(
	venvPython: string,
	timeoutMs = VERSION_PROBE_TIMEOUT_MS,
	stateRoot?: string,
): Promise<string> {
	if (!existsSync(venvPython)) return "";
	try {
		const { stdout } = await execFileAsync(
			venvPython,
			["-c", VERSION_PROBE_SCRIPT],
			{
				timeout: timeoutMs,
				windowsHide: true,
			},
		);
		return stdout.trim();
	} catch (err) {
		logBootstrapEvent(
			{ event: "cognee_version_probe_failed", error: describeError(err) },
			stateRoot,
		);
		return "";
	}
}

/**
 * Which required extras' driver packages are absent from the venv (sentinel
 * dists). Fails soft to [] on probe errors — reference parity: a venv broken
 * enough to fail this probe also fails the version probe, and the install
 * path handles that. Absent interpreter → all extras missing.
 */
export async function venvMissingExtras(
	venvPython: string,
	extras: string[],
	timeoutMs = VERSION_PROBE_TIMEOUT_MS,
): Promise<string[]> {
	if (!extras.length) return [];
	if (!existsSync(venvPython)) return [...extras];
	const dists = extras
		.map((extra) => EXTRA_SENTINEL_DISTS[extra])
		.filter(Boolean);
	if (!dists.length) return [];
	try {
		const { stdout } = await execFileAsync(
			venvPython,
			["-c", EXTRAS_PROBE_SCRIPT, ...dists],
			{
				timeout: timeoutMs,
				windowsHide: true,
			},
		);
		const missingDists = new Set(stdout.split(/\s+/).filter(Boolean));
		return extras.filter((extra) =>
			missingDists.has(EXTRA_SENTINEL_DISTS[extra]),
		);
	} catch (err) {
		logBootstrapEvent({
			event: "extras_probe_failed",
			error: describeError(err),
		});
		return [];
	}
}

/** Atomic venv-ready marker — the reference's exact shape (python = venv path). */
function writeVenvReady(paths: BootstrapPaths, version: string): void {
	try {
		const tmp = `${paths.venvReady}.tmp`;
		writeFileSync(
			tmp,
			JSON.stringify({
				cognee_version: version,
				python: paths.venvPython,
				updated_at: Date.now() / 1000,
			}),
			"utf8",
		);
		renameSync(tmp, paths.venvReady);
	} catch (err) {
		logBootstrapEvent(
			{ event: "venv_ready_write_failed", error: describeError(err) },
			paths.stateRoot,
		);
	}
}

export interface InstallResult {
	ok: boolean;
	version?: string;
	skippedAtPin?: boolean;
	error?: string;
}

export interface InstallOptions {
	timeoutMs?: number;
	stateRoot?: string;
}

/**
 * Ensure the shared venv exists and holds the pinned cognee (+ provider
 * extras). Single-flighted on venv-install.lock; loser short-circuits at a
 * satisfied pin, else waits then reports the best-effort version. Never
 * reinstalls over a satisfied pin (skip-at-pin). Never throws.
 */
export async function ensureCogneeInstalled(
	env: EnvLookup,
	opts: InstallOptions = {},
): Promise<InstallResult> {
	const paths = bootstrapPaths(opts.stateRoot);
	const timeoutMs =
		opts.timeoutMs ?? envNumber("COGNEE_INSTALL_TIMEOUT", 600) * 1000;
	const lockMs = timeoutMs + 60_000;

	// Data-dir pins: effective env > ~/.cognee/{system,data,cache} (apply_cognee_env).
	const home = homedir();
	const dataDirs = [
		env("SYSTEM_ROOT_DIRECTORY") ?? join(home, ".cognee", "system"),
		env("DATA_ROOT_DIRECTORY") ?? join(home, ".cognee", "data"),
		env("CACHE_ROOT_DIRECTORY") ?? join(home, ".cognee", "cache"),
	];
	try {
		for (const dir of dataDirs) mkdirSync(dir, { recursive: true });
	} catch (err) {
		return {
			ok: false,
			error: `cannot create cognee data dirs: ${describeError(err)}`,
		};
	}

	const spec = cogneeInstallSpec(env);
	const extras = requiredExtras(spec);
	const pythonPin =
		(envValue("COGNEE_PLUGIN_PYTHON") || DEFAULT_PYTHON_PIN).trim() ||
		DEFAULT_PYTHON_PIN;

	const lock = await acquireJsonLock(paths.installLock, {
		staleMs: lockMs,
		waitMs: lockMs,
		pollMs: INSTALL_LOCK_POLL_MS,
		owner: `pi-install:${process.pid}`,
		// Loser short-circuit (reference session-start.py:445-456): probe the
		// venv at EVERY poll — a pin-satisfying venv behind a live holder (another
		// plugin's extras-aware reinstall, the #232 path) needs no install; take
		// the shortcut at the next poll instead of stalling the whole window.
		probe: async () => {
			const version = await venvCogneeVersion(
				paths.venvPython,
				VERSION_PROBE_TIMEOUT_MS,
				opts.stateRoot,
			);
			if (version !== PINNED_COGNEE_VERSION) return false;
			const missing = await venvMissingExtras(paths.venvPython, extras);
			return missing.length === 0;
		},
	});
	if (lock === "probe-shortcut") {
		logBootstrapEvent(
			{
				event: "install_lock_lost_skip_at_pin",
				version: PINNED_COGNEE_VERSION,
				via: "wait_probe",
			},
			opts.stateRoot,
		);
		return { ok: true, version: PINNED_COGNEE_VERSION, skippedAtPin: true };
	}
	if (!lock) {
		// Loser: the winner is installing. Skip-at-pin short-circuit, else the
		// best-effort version after having waited out the lock window.
		const version = await venvCogneeVersion(
			paths.venvPython,
			VERSION_PROBE_TIMEOUT_MS,
			opts.stateRoot,
		);
		const missing = await venvMissingExtras(paths.venvPython, extras);
		if (version === PINNED_COGNEE_VERSION && missing.length === 0) {
			logBootstrapEvent(
				{ event: "install_lock_lost_skip_at_pin", version },
				opts.stateRoot,
			);
			return { ok: true, version, skippedAtPin: true };
		}
		logBootstrapEvent(
			{ event: "install_lock_lost_best_effort", version },
			opts.stateRoot,
		);
		return { ok: Boolean(version), version: version || undefined };
	}
	try {
		// Skip-at-pin (under the lock): never reinstall over a satisfied pin —
		// two plugins with different pins used to flip the shared venv endlessly.
		const version = await venvCogneeVersion(
			paths.venvPython,
			VERSION_PROBE_TIMEOUT_MS,
			opts.stateRoot,
		);
		if (version === PINNED_COGNEE_VERSION) {
			const missing = await venvMissingExtras(paths.venvPython, extras);
			if (missing.length === 0) {
				writeVenvReady(paths, version);
				logBootstrapEvent(
					{ event: "cognee_install_skipped_at_pin", version, spec },
					opts.stateRoot,
				);
				return { ok: true, version, skippedAtPin: true };
			}
			logBootstrapEvent(
				{ event: "cognee_install_missing_extras", missing },
				opts.stateRoot,
			);
		}

		// uv resolution: self-managed → PATH → install once.
		let uv = findUv(opts.stateRoot);
		if (!uv) {
			logBootstrapEvent(
				{ event: "uv_not_found_installing" },
				opts.stateRoot,
			);
			uv = await installUv(opts.stateRoot);
		}
		if (!uv) {
			return {
				ok: false,
				error: "uv not found and automatic install failed — install uv (https://docs.astral.sh/uv/getting-started/installation/) and restart pi",
			};
		}

		const uvEnv = {
			...process.env,
			UV_PYTHON_INSTALL_DIR: paths.uvPythonDir,
		};
		try {
			if (!existsSync(paths.venvPython)) {
				await execFileAsync(
					uv,
					["venv", paths.venvDir, "--python", pythonPin],
					{
						env: uvEnv,
						cwd: paths.stateRoot,
						timeout: timeoutMs,
						windowsHide: true,
					},
				);
			}
			await execFileAsync(
				uv,
				[
					"pip",
					"install",
					"--upgrade",
					"--python",
					paths.venvPython,
					spec,
				],
				{
					env: uvEnv,
					cwd: paths.stateRoot,
					timeout: timeoutMs,
					windowsHide: true,
				},
			);
		} catch (err) {
			logBootstrapEvent(
				{
					event: "cognee_install_failed",
					via: "uv",
					spec,
					error: describeError(err),
				},
				opts.stateRoot,
			);
			return {
				ok: false,
				error: `uv install failed: ${describeError(err)}`,
			};
		}

		const finalVersion = await venvCogneeVersion(
			paths.venvPython,
			VERSION_PROBE_TIMEOUT_MS,
			opts.stateRoot,
		);
		if (!finalVersion) {
			return {
				ok: false,
				error: "venv unusable after install (cognee not importable)",
			};
		}
		writeVenvReady(paths, finalVersion);
		logBootstrapEvent(
			{ event: "cognee_install_ready", version: finalVersion, spec },
			opts.stateRoot,
		);
		return { ok: true, version: finalVersion };
	} finally {
		lock.release();
	}
}

/* ------------------------------------------------------------------ */
/* Server env (precedence + pins, spec §2.2)                           */
/* ------------------------------------------------------------------ */

/**
 * Environment for a booted server: `process.env` copy (shell truth) + env-file
 * values with setdefault semantics (denylisted keys never sourced from the
 * file) + the reference's data-dir/quality pins. `LLM_API_KEY`/`LLM_MODEL`
 * ride the plain passthrough untouched. **`COGNEE_AGENT_MODE` is deliberately
 * NOT set** — pi has no agent registration, so an agent-mode server's
 * zero-connections teardown would either never trigger (pi-only machine) or
 * kill the shared server under pi when the last Claude Code session
 * unregisters (mixed machine). A pi-booted server persists until the user or
 * machine stops it (README divergence note).
 */
export function buildServerEnv(
	envFileValues: Record<string, string>,
): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(envFileValues)) {
		if (SERVER_ENV_FILE_DENYLIST.test(key)) continue;
		if (out[key] === undefined) out[key] = value;
	}
	const home = homedir();
	const pins: ReadonlyArray<readonly [string, string]> = [
		["SYSTEM_ROOT_DIRECTORY", join(home, ".cognee", "system")],
		["DATA_ROOT_DIRECTORY", join(home, ".cognee", "data")],
		["CACHE_ROOT_DIRECTORY", join(home, ".cognee", "cache")],
		["CACHING", "true"],
		["AUTO_FEEDBACK", "true"],
		["LLM_INSTRUCTOR_MODE", "json_schema_mode"],
		["DEFAULT_USER_EMAIL", "default_user@example.com"],
		["DEFAULT_USER_PASSWORD", "default_password"],
	];
	for (const [key, value] of pins) {
		if (out[key] === undefined) out[key] = value;
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Console capture (first 1 MiB per boot, rotated to .1)               */
/* ------------------------------------------------------------------ */

/** The capture pump (reference `_logfiles.py` `_CONSOLE_PUMP_SOURCE`): a
 *  detached stdlib-only child that owns the FILE fd. It rotates the previous
 *  boot's capture to `.1` unconditionally at start, copies the FIRST cap
 *  bytes of this boot from its stdin into the file, stamps the cap marker,
 *  then keeps draining the pipe and discarding the rest until EOF — so the
 *  cap holds for the server's WHOLE lifetime (a chatty server cannot grow
 *  the capture past one boot's worth) and the server never blocks on a full
 *  pipe. Node `-e` runs CommonJS; argv[1]/argv[2] are path/cap. */
const CONSOLE_PUMP_SOURCE = `
const fs = require("node:fs");
const p = require("node:path");
const logPath = process.argv[1];
const cap = Number(process.argv[2]);
if (!logPath || !Number.isFinite(cap) || cap < 0) process.exit(0);
try { fs.mkdirSync(p.dirname(logPath), { recursive: true }); } catch (e) {}
try { fs.renameSync(logPath, logPath + ".1"); } catch (e) {}
let out = -1;
try { out = fs.openSync(logPath, "a"); } catch (e) { process.exit(0); }
let written = 0;
process.stdin.on("data", (chunk) => {
  if (written >= cap) return;
  const take = chunk.subarray(0, cap - written);
  try {
    fs.writeSync(out, take);
    written += take.length;
  } catch (e) {
    process.exit(0);
  }
  if (written >= cap) {
    try {
      fs.writeSync(out, "\\n[pi-cognee: console capture cap reached; the rest of this boot's output is discarded]\\n");
    } catch (e) {}
  }
});
process.stdin.on("end", () => { try { fs.closeSync(out); } catch (e) {} process.exit(0); });
process.stdin.on("error", () => {});
process.stdin.resume();
`;

/** The fd of a spawned child's stdin pipe, for handing to ANOTHER child's
 *  stdio (dup'd by spawn). Node's stdio sockets are socketpairs without a
 *  public `.fd` property, so the handle's fd is the only access point —
 *  undefined when somehow inaccessible (never observed). */
function stdinFd(child: ChildProcess | undefined): number | undefined {
	const stdin = child?.stdin as
		{ _handle?: { fd?: unknown } } | null | undefined;
	const fd = stdin?._handle?.fd;
	return typeof fd === "number" && fd >= 0 ? fd : undefined;
}

function consoleTail(path: string, maxChars: number): string {
	for (const candidate of [path, `${path}.1`]) {
		try {
			const text = readFileSync(candidate, "utf8");
			if (text) return text.slice(-maxChars);
		} catch {
			/* try the rotation */
		}
	}
	return "";
}

/** Start the capture pump (reference `start_console_capture`): a detached,
 *  unref'd `node -e` child whose stdin pipe is handed to the server as its
 *  stdout/stderr. The server never holds the file fd — the pump enforces the
 *  cap — and the pump outlives this process (EOF only when the server exits).
 *  Returns the pump child, or undefined when it could not be started (the
 *  server's output is then discarded — the reference's DEVNULL fallback). */
function startConsolePump(
	consolePath: string,
	capBytes: number,
	stateRoot?: string,
): ChildProcess | undefined {
	try {
		const pump = spawn(
			process.execPath,
			["-e", CONSOLE_PUMP_SOURCE, consolePath, String(capBytes)],
			{ stdio: ["pipe", "ignore", "ignore"], detached: true },
		);
		pump.unref();
		// A pump that fails to start/exit never breaks the boot (EMFILE-class
		// races degrade to no capture, exactly like the reference's None return).
		pump.on("error", () => {});
		return pump;
	} catch (err) {
		logBootstrapEvent(
			{ event: "console_pump_start_failed", error: describeError(err) },
			stateRoot,
		);
		return undefined;
	}
}

/* ------------------------------------------------------------------ */
/* Boot (adopt-first, presence-licensed, single-flight, spec §1.4)      */
/* ------------------------------------------------------------------ */

export interface BootResult {
	ok: boolean;
	adopted: boolean;
	error?: string;
}

export interface BootOptions {
	healthTimeoutMs?: number;
	stateRoot?: string;
}

/**
 * Ensure a cognee server is serving at `baseUrl`: adopt a running one as-is
 * (never restart, never version-check — parity), else install and boot ours.
 * Presence licensing: only a positively-absent server may be installed/booted
 * over; busy/unknown → refusal (a busy server still holds the graph store's
 * file lock — upgrading under it corrupts DBs). Never throws.
 */
export async function ensureLocalServerRunning(
	baseUrl: string,
	env: EnvLookup,
	opts: BootOptions = {},
): Promise<BootResult> {
	const paths = bootstrapPaths(opts.stateRoot);
	const port = serverPort(baseUrl);
	const healthTimeoutMs =
		opts.healthTimeoutMs ??
		envNumber("COGNEE_SERVER_BOOT_DEADLINE", 600) * 1000;

	// 1. Adopt-first: a running server is never restarted or version-checked.
	if (await httpHealthOk(baseUrl)) return { ok: true, adopted: true };

	// 2-4. Presence licensing + install (only ever under positive absence).
	const pre = await requireAbsent(baseUrl, "pre_install", opts.stateRoot);
	if (pre) return pre;

	const install = await ensureCogneeInstalled(env, {
		stateRoot: opts.stateRoot,
	});
	if (!install.ok) {
		return {
			ok: false,
			adopted: false,
			error: `cognee runtime unavailable (${install.error ?? "install/upgrade failed"})`,
		};
	}

	// A cold install can take minutes — re-verify the premise.
	const post = await requireAbsent(baseUrl, "post_install", opts.stateRoot);
	if (post) return post;

	// 5. Boot lock (stale 60s, wait 35s, poll 0.2s). A loser polls /health and
	//    adopts; the boot lock is the correctness boundary between processes.
	const bootDeadline = Date.now() + BOOT_LOCK_WAIT_MS;
	let lock = await acquireJsonLock(paths.bootLock, {
		staleMs: BOOT_LOCK_STALE_MS,
		waitMs: 0,
		pollMs: BOOT_LOCK_POLL_MS,
		owner: `pi-bootstrap:${process.pid}`,
	});
	// No probe is ever configured for the boot lock, so "probe-shortcut" is
	// unreachable here — the guard exists purely to keep the union honest.
	while (!lock || lock === "probe-shortcut") {
		if (await httpHealthOk(baseUrl)) return { ok: true, adopted: true };
		if (Date.now() >= bootDeadline) {
			return {
				ok: false,
				adopted: false,
				error: `server bootstrap lock timeout (another bootstrap held ${paths.bootLock} and the server never became healthy within ${BOOT_LOCK_WAIT_MS / 1000}s)`,
			};
		}
		await sleep(BOOT_LOCK_POLL_MS);
		lock = await acquireJsonLock(paths.bootLock, {
			staleMs: BOOT_LOCK_STALE_MS,
			waitMs: 0,
			pollMs: BOOT_LOCK_POLL_MS,
			owner: `pi-bootstrap:${process.pid}`,
		});
	}
	try {
		// Final re-check under the lock: waiting may have taken a while.
		const inLock = await requireAbsent(baseUrl, "in_lock", opts.stateRoot);
		if (inLock) return inLock;

		// 6-7. Server env + console capture: the server's stdout/stderr flow into
		//      the detached pump's pipe — the pump keeps the FIRST 1 MiB of the
		//      boot in server-console-<port>.log (previous boot's capture → .1)
		//      and discards the rest; the server never holds the file fd, so the
		//      cap holds for its whole lifetime (reference `_logfiles.py` pump).
		const serverEnv = buildServerEnv(loadCogneeEnvFile().values);
		const consolePath = paths.consoleLog(port);
		const pump = startConsolePump(
			consolePath,
			CONSOLE_LOG_CAP_BYTES,
			opts.stateRoot,
		);
		const pumpFd = stdinFd(pump);
		if (pump && pumpFd === undefined) {
			pump.stdin?.destroy(); // EOF — the idle pump exits instead of lingering
			logBootstrapEvent(
				{
					event: "server_console_capture_unavailable",
					path: consolePath,
					error: "pump stdin fd unavailable",
				},
				opts.stateRoot,
			);
		}

		// 8. Spawn detached uvicorn (no --host: uvicorn defaults to 127.0.0.1).
		//    stdio dups the pump's stdin write end for stdout+stderr — the uvicorn
		//    child never touches the capture FILE (the pump owns it).
		let spawnErrorMessage = "";
		const child = spawn(
			paths.venvPython,
			["-m", "uvicorn", "cognee.api.client:app", "--port", String(port)],
			{
				cwd: paths.venvDir,
				env: serverEnv,
				detached: true,
				stdio:
					pumpFd !== undefined
						? ["ignore", pumpFd, pumpFd]
						: "ignore",
				windowsHide: true,
			},
		);
		// The server holds the socketpair's write end now — close OUR copy so the
		// pump sees EOF exactly when the server exits (reference:
		// pump.stdin.close()). destroy(), never end(): end() shuts the socket
		// down for the child's dup too, instantly EOF-ing the pump.
		if (pumpFd !== undefined) pump?.stdin?.destroy();
		child.on("error", (err) => {
			// ENOENT/EACCES degrade here instead of crashing; the health wait reports.
			spawnErrorMessage = describeError(err);
		});
		child.unref();
		if (typeof child.pid === "number" && child.pid > 0) {
			writeServerPidfile(port, child.pid, opts.stateRoot);
			logBootstrapEvent(
				{
					event: "server_spawned",
					pid: child.pid,
					port,
					version: PINNED_COGNEE_VERSION,
				},
				opts.stateRoot,
			);
		} else {
			logBootstrapEvent(
				{
					event: "server_spawn_failed_no_pid",
					error: spawnErrorMessage,
				},
				opts.stateRoot,
			);
		}

		// 9. Health wait (1s cadence). Child exit before healthy → clear the
		//    pidfile, re-probe (someone else may have claimed the port and be
		//    serving → adopt), else fail with the console tail.
		const deadline = Date.now() + healthTimeoutMs;
		for (;;) {
			await sleep(1000);
			if (await httpHealthOk(baseUrl)) {
				logBootstrapEvent(
					{ event: "server_healthy", port, pid: child.pid ?? null },
					opts.stateRoot,
				);
				return { ok: true, adopted: false };
			}
			if (spawnErrorMessage || child.exitCode !== null) {
				clearServerPidfile(port, opts.stateRoot);
				// Bounded re-probe: an immediate exit is usually a failed port bind —
				// if that something is serving, connect to it instead of failing.
				const readoptDeadline = Date.now() + 2000;
				while (Date.now() < readoptDeadline) {
					if (await httpHealthOk(baseUrl, 500))
						return { ok: true, adopted: true };
					await sleep(250);
				}
				const tail = consoleTail(consolePath, 4000);
				const reason = spawnErrorMessage
					? `spawn failed: ${spawnErrorMessage}`
					: `server process exited (rc=${child.exitCode}) before becoming healthy`;
				logBootstrapEvent(
					{
						event: "server_exited_before_healthy",
						reason,
						console_tail: tail.slice(-600),
					},
					opts.stateRoot,
				);
				return {
					ok: false,
					adopted: false,
					error: `${reason} at ${baseUrl}; console: ${consolePath}${tail ? `\n${tail}` : ""}`,
				};
			}
			if (Date.now() >= deadline) {
				const tail = consoleTail(consolePath, 4000);
				logBootstrapEvent(
					{
						event: "server_health_deadline",
						port,
						console_tail: tail.slice(-600),
					},
					opts.stateRoot,
				);
				return {
					ok: false,
					adopted: false,
					error:
						`cognee server did not become healthy at ${baseUrl} within ${Math.round(healthTimeoutMs / 1000)}s; ` +
						`console: ${consolePath}; server log: newest file in ${join(homedir(), ".cognee", "logs")}${tail ? `\n${tail}` : ""}`,
				};
			}
		}
	} finally {
		lock.release();
	}
}

/** Presence gate: null = positively absent (proceed); a result = adopt/refuse. */
async function requireAbsent(
	baseUrl: string,
	stage: "pre_install" | "post_install" | "in_lock",
	stateRoot?: string,
): Promise<BootResult | null> {
	const presence = await serverPresence(baseUrl, {
		confirmAbsent: stage === "pre_install",
		stateRoot,
	});
	if (presence.verdict === "ready") return { ok: true, adopted: true };
	if (presence.verdict === "absent") return null;
	logBootstrapEvent(
		{
			event: "boot_refused_server_present",
			stage,
			verdict: presence.verdict,
			...presence.evidence,
		},
		stateRoot,
	);
	return {
		ok: false,
		adopted: false,
		error: `server at ${baseUrl} is present but not serving (verdict=${presence.verdict}, stage=${stage}); refusing to install or boot over it`,
	};
}
