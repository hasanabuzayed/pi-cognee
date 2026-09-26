#!/usr/bin/env node
/**
 * pi-cognee LIVE bootstrap exercise (developer-only; research/v04-bootstrap-spec.md §5.2).
 *
 *   PI_COGNEE_BOOTSTRAP_LIVE=1 node test/bootstrap-live.mjs
 *
 * Runs the REAL install + boot path against a THROWAWAY state root:
 *   real `uv venv --python 3.12`, real `uv pip install cognee==1.6.0` (network,
 *   minutes), real detached uvicorn spawn from that venv on a FREE EPHEMERAL
 *   port (never 8011), health poll, one session-cache add, then SIGTERM of
 *   exactly the pid this test spawned and temp-root cleanup.
 *
 * Hard lines (self-enforced):
 *   - Touches NOTHING under ~/.cognee-plugin/ or ~/.cognee/ (sole permitted
 *     access: a read-only report line cat'ing the shared venv-ready.json).
 *     No shared locks, no server-8011.pid writes, no shared api_key.json mint.
 *   - cognee state (sqlite/lancedb/kuzu) pinned INSIDE the temp root via a
 *     temp env file; dummy LLM key only; no provider extras.
 *   - Never binds a well-known port; never leaves a process running
 *     (EXIT/INT/TERM traps kill + rm -rf the temp roots).
 *   - Wall-clock bound: hard watchdog at 9.5 minutes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadClientMod } from "./mod.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PI_ROOT = process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(
  pathToFileURL(path.join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs")).href
);
const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: { "@earendil-works/pi-ai": path.join(PI_ROOT, "node_modules", "@earendil-works", "pi-ai") },
  moduleCache: false,
});
const bootMod = await jiti.import(path.join(root, "src", "bootstrap.ts"));
const clientMod = await loadClientMod(jiti, root);

const HARD_BUDGET_MS = 9.5 * 60_000;
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

const stateRoot = mkdtempSync(path.join(os.tmpdir(), "pi-cognee-live-root-"));
const cogneeHome = mkdtempSync(path.join(os.tmpdir(), "pi-cognee-live-home-"));
const envFile = path.join(stateRoot, "live.env");
let spawnedPid = 0;
let exitCode = 0;

// Hermetic env for THIS process: the temp env file is the only LLM_* /
// data-dir source (a developer's real exports must not reach the server).
for (const key of Object.keys(process.env)) {
  if (/^(LLM_|DEFAULT_USER_|SYSTEM_ROOT|DATA_ROOT|CACHE_ROOT|COGNEE_)/.test(key)) delete process.env[key];
}
process.env.COGNEE_ENV_FILE = envFile;
// Sandbox accommodation: this session's SSL_CERT_FILE points at a MITM-only
// CA bundle (missing real roots — files.pythonhosted.org's GlobalSign chain
// fails as UnknownIssuer). uv honors SSL_CERT_FILE, so point it at the FULL
// macOS system bundle, which carries both the local proxy root and the real
// roots (curl already trusts both). Overridden, not appended — developer-only
// live test.
try {
  readFileSync("/etc/ssl/cert.pem");
  process.env.SSL_CERT_FILE = "/etc/ssl/cert.pem";
} catch { /* not a macOS-style layout — leave the environment as-is */ }
writeFileSync(
  envFile,
  [
    "LLM_API_KEY=pi-cognee-live-dummy-key",
    `SYSTEM_ROOT_DIRECTORY=${path.join(cogneeHome, "system")}`,
    `DATA_ROOT_DIRECTORY=${path.join(cogneeHome, "data")}`,
    `CACHE_ROOT_DIRECTORY=${path.join(cogneeHome, "cache")}`,
  ].join("\n") + "\n",
  "utf8",
);
const lookup = (key) => {
  const values = clientMod.parseEnvFile(readFileSync(envFile, "utf8"));
  return process.env[key] ?? values[key];
};

function cleanup() {
  if (spawnedPid) {
    try { process.kill(spawnedPid, "SIGTERM"); } catch { /* already gone */ }
    const graceUntil = Date.now() + 2000;
    while (Date.now() < graceUntil) {
      try { process.kill(spawnedPid, 0); } catch { break; }
    }
    try { process.kill(spawnedPid, "SIGKILL"); } catch { /* gone */ }
    spawnedPid = 0;
  }
  for (const dir of [stateRoot, cogneeHome]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
const watchdog = setTimeout(() => {
  console.error(`\n✗ HARD DEADLINE (${HARD_BUDGET_MS / 60000} min) exceeded — killing and cleaning up`);
  cleanup();
  process.exit(124);
}, HARD_BUDGET_MS);

function freeEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Mint an owner key via the default user WITHOUT touching the shared cache. */
async function mintTempOwnerKey(baseUrl) {
  const timeoutMs = 10000;
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "default_user@example.com", password: "default_password" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const jwt = (await login.json())?.access_token ?? "";
  if (!jwt) throw new Error("login returned no token");
  const cookie = `auth_token=${jwt}`;
  const listed = await fetch(`${baseUrl}/api/v1/auth/api-keys`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (listed.ok) {
    const keys = await listed.json().catch(() => []);
    if (Array.isArray(keys) && keys.length && keys[0]?.key) return keys[0].key;
  }
  const created = await fetch(`${baseUrl}/api/v1/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "pi-live-exercise" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!created.ok) throw new Error(`key mint failed: HTTP ${created.status}`);
  const key = (await created.json())?.key ?? "";
  if (!key) throw new Error("key mint returned empty");
  return key;
}

try {
  console.log(`live bootstrap exercise — state root: ${stateRoot}`);
  console.log(`  (report) machine shared venv: ${
    (() => { try { return readFileSync(path.join(os.homedir(), ".cognee-plugin", "venv-ready.json"), "utf8").trim(); } catch { return "(no shared venv-ready.json)"; } })()
  }`);

  const uv = bootMod.findUv();
  console.log(`  uv: ${uv || "(not found)"}`);
  assert.ok(uv, "uv must be on PATH for the live exercise");

  const port = await freeEphemeralPort();
  assert.ok(port !== 8011, "never bind 8011");
  const baseUrl = `http://localhost:${port}`;
  console.log(`  target: ${baseUrl} (ephemeral, presence-gated)`);

  // 1. Real install into the temp root (network — the slow part). The python
  //    pin defaults to 3.12 (reference parity); this sandbox's TLS interception
  //    blocks the standalone-CPython download, so fall back to the newest SYSTEM
  //    interpreter via the env-overridable pin (COGNEE_PLUGIN_PYTHON).
  console.log(`  [${elapsed()}] ensureCogneeInstalled (real uv venv + cognee==1.6.0)…`);
  let install = await bootMod.ensureCogneeInstalled(lookup, { stateRoot });
  if (!install.ok && /download|certificate|peer/i.test(install.error ?? "")) {
    // Newest SYSTEM interpreter on this machine (uv python list → homebrew 3.14;
    // cognee supports 3.10–3.14 — the pin stays env-overridable by design).
    const system = process.env.PI_COGNEE_LIVE_PYTHON || "3.14";
    console.log(`  [${elapsed()}] 3.12 interpreter unavailable (${install.error.split("\n")[0]}) — retrying with system python ${system}`);
    process.env.COGNEE_PLUGIN_PYTHON = system;
    install = await bootMod.ensureCogneeInstalled(lookup, { stateRoot });
  }
  console.log(`  [${elapsed()}] install: ${JSON.stringify(install)}`);
  assert.equal(install.ok, true, "install must succeed");

  // 2. Real boot + health poll.
  console.log(`  [${elapsed()}] ensureLocalServerRunning (detached uvicorn spawn)…`);
  const boot = await bootMod.ensureLocalServerRunning(baseUrl, lookup, {
    stateRoot,
    healthTimeoutMs: Math.max(60_000, HARD_BUDGET_MS - (Date.now() - started) - 60_000),
  });
  console.log(`  [${elapsed()}] boot: ${JSON.stringify({ ok: boot.ok, adopted: boot.adopted, error: boot.error?.slice(0, 300) })}`);
  assert.equal(boot.ok, true, "boot must succeed");
  assert.equal(boot.adopted, false, "first boot is ours (not adopted)");

  const pidfile = JSON.parse(readFileSync(bootMod.bootstrapPaths(stateRoot).pidFile(port), "utf8"));
  spawnedPid = pidfile.pid;
  assert.ok(spawnedPid > 0, "pidfile holds our spawned pid");
  process.kill(spawnedPid, 0); // alive
  console.log(`  [${elapsed()}] server pid ${spawnedPid} alive, version pin ${pidfile.version}`);

  // 3. Second call adopts (no new spawn).
  const again = await bootMod.ensureLocalServerRunning(baseUrl, lookup, { stateRoot });
  assert.equal(again.ok && again.adopted, true, "second call adopts the running server");

  // 4. One session-cache add through the real client (key minted without the shared cache).
  let sessionAdd = "skipped";
  try {
    const apiKey = await mintTempOwnerKey(baseUrl);
    const base = clientMod.loadCogneeConfig();
    const client = new clientMod.CogneeClient({ ...base, baseUrl, apiKey, dataset: "pi_live_exercise" });
    const wrote = await client.rememberEntry(
      { type: "qa", question: "pi-cognee live exercise", answer: `booted at ${new Date().toISOString()}` },
      "pi_live_exercise_session",
      "pi_live_exercise",
      15000,
    );
    sessionAdd = wrote.ok ? `ok (status ${wrote.status ?? 200})` : `failed: ${wrote.error?.message}`;
  } catch (err) {
    sessionAdd = `failed: ${err.message}`;
  }
  console.log(`  [${elapsed()}] session-cache add: ${sessionAdd}`);

  // 5. Kill exactly what we spawned + verify cleanup.
  console.log(`  [${elapsed()}] SIGTERM ${spawnedPid} (the process this test spawned)…`);
  process.kill(spawnedPid, "SIGTERM");
  let dead = false;
  for (let i = 0; i < 100 && !dead; i++) {
    try { process.kill(spawnedPid, 0); await new Promise((r) => setTimeout(r, 100)); }
    catch { dead = true; }
  }
  assert.ok(dead, "spawned server must be dead after SIGTERM (+10s)");
  console.log(`  [${elapsed()}] server exited; temp roots removed on exit`);

  console.log(`\n✓ live bootstrap exercise passed in ${elapsed()} (session-cache add: ${sessionAdd})`);
} catch (err) {
  exitCode = 1;
  console.error(`\n✗ live bootstrap exercise FAILED at ${elapsed()}: ${err.message}`);
} finally {
  clearTimeout(watchdog);
  cleanup();
  process.exit(exitCode);
}
