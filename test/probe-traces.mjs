#!/usr/bin/env node
/**
 * LIVE probe — tool-call trace capture end-to-end (research/v04-traces-spec.md).
 *
 *   COGNEE_LIVE_BASE_URL=https://cognee.apps.jazm.dev node test/probe-traces.mjs
 *
 * Drives the REAL `tool_result` handler (jiti-loaded production factory + a
 * stub pi host surface — host glue only; no capture logic stubbed) against a
 * real cognee server: a bash trace lands via POST /api/v1/remember/entry and
 * is read back from the session cache, redaction is verified on the STORED
 * copy (not just the wire), and deny-list/allowlist refusals are verified by
 * row-count stability.
 *
 * Hermetic: COGNEE_PI_STATE_DIR + COGNEE_ENV_FILE point at throwaway temp
 * dirs BEFORE the factory loads (the real ~/.cognee-plugin state is never
 * touched). Server-side writes touch ONLY the disposable dataset
 * "pi-cognee-traces-selftest" (forgotten in cleanup + pre-cleaned at startup,
 * so a crashed run can be re-run). Secrets are never printed. Every call has
 * an explicit timeout; global wall budget < 3 min.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIVE = process.env.COGNEE_LIVE_BASE_URL;
if (!LIVE) {
  console.error("probe-traces.mjs: set COGNEE_LIVE_BASE_URL (e.g. https://cognee.apps.jazm.dev) — refusing to run blind.");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { join } = path;

/* ---------- hermetic state BEFORE any jiti import (config runs at factory time) ---------- */

const stateDir = mkdtempSync(join(os.tmpdir(), "pi-cognee-trprobe-state-"));
const envFileDir = mkdtempSync(join(os.tmpdir(), "pi-cognee-trprobe-env-"));
const workDir = mkdtempSync(join(os.tmpdir(), "pi-cognee-trprobe-cwd-")); // NOT a git repo → no auto-index noise
process.env.COGNEE_PI_STATE_DIR = stateDir;
process.env.COGNEE_ENV_FILE = join(envFileDir, ".env"); // absent — never read ~/.cognee/.env
process.env.COGNEE_BASE_URL = LIVE;
process.env.COGNEE_LOCAL_BOOTSTRAP = "off";
process.env.COGNEE_PLUGIN_DATASET = "pi-cognee-traces-selftest"; // disposable
delete process.env.COGNEE_PLUGIN_READ_DATASET_IDS; // no federation noise
delete process.env.COGNEE_CAPTURE_TOOLS; // default matcher under test

const SELFTEST_DS = "pi-cognee-traces-selftest";
const HOST_SESSION = "traces-live"; // → cognee session id pi_traces-live

const PI_ROOT =
  process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(
  pathToFileURL(join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs")).href
);
const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: {
    "@earendil-works/pi-ai": join(PI_ROOT, "node_modules", "@earendil-works", "pi-ai"),
  },
  moduleCache: false,
});

const clientMod = await jiti.import(join(root, "src", "client.ts"));
const ext = await jiti.import(join(root, "src", "index.ts"));
const { CogneeClient, loadCogneeConfig, describeError, redactSecrets, truncateText } = clientMod;

/* ---------- harness: bounded steps, PASS/FAIL/SKIP (live.mjs discipline) ---------- */

const START = Date.now();
const BUDGET_MS = 170_000;
const CLEANUP_RESERVE_MS = 30_000;
const leftMs = () => BUDGET_MS - (Date.now() - START);
const elapsed = () => ((Date.now() - START) / 1000).toFixed(1) + "s";
const results = [];
const safeDetail = (text) =>
  truncateText(redactSecrets(String(text ?? "")).replace(/\s+/g, " ").trim(), 220);

async function withTimeout(promiseFactory, ms) {
  let timer;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`step timed out after ${ms}ms`);
          err.stepTimeout = true;
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function step(name, fn, { timeoutMs = 20_000 } = {}) {
  if (leftMs() < CLEANUP_RESERVE_MS) {
    results.push({ name, status: "SKIP", detail: `global budget exhausted at ${elapsed()}` });
    console.log(`SKIP  ${name} — global budget exhausted at ${elapsed()}`);
    return { status: "SKIP" };
  }
  const cap = Math.max(Math.min(timeoutMs, leftMs() - (CLEANUP_RESERVE_MS - 20_000)), 5_000);
  try {
    const outcome = await withTimeout(fn, cap);
    const status = outcome?.status ?? "PASS";
    const detail = safeDetail(outcome?.detail ?? "");
    results.push({ name, status, detail });
    console.log(`${status}  ${name}${detail ? ` — ${detail}` : ""}`);
    return outcome ?? { status: "PASS" };
  } catch (err) {
    const message = err?.stepTimeout ? err.message : describeError(err);
    const detail = safeDetail(message);
    results.push({ name, status: "FAIL", detail });
    console.log(`FAIL  ${name} — ${detail}`);
    return { status: "FAIL", detail };
  }
}

const pass = (detail) => ({ status: "PASS", detail });

/* ---------- stub pi host surface (smoke.mjs makeStubApi, verbatim) ---------- */

function makeStubApi() {
  const recorded = { tools: [], commands: [], events: new Map(), messages: [], entries: [] };
  const pi = {
    registerTool(tool) {
      recorded.tools.push(tool);
    },
    registerCommand(name, options) {
      recorded.commands.push({ name, ...options });
    },
    on(event, handler) {
      if (!recorded.events.has(event)) recorded.events.set(event, []);
      recorded.events.get(event).push(handler);
      return () => {};
    },
    sendMessage() {},
    sendUserMessage() {},
    appendEntry(customType, data) {
      recorded.entries.push({ customType, data });
    },
    getActiveTools() {
      return recorded.tools.map((t) => t.name);
    },
    setActiveTools() {},
    getCommands() {
      return recorded.commands.map((c) => c.name);
    },
  };
  return { pi, recorded };
}

/* ---------- driver-side client + helpers ---------- */

const cfg = loadCogneeConfig();
const client = new CogneeClient(cfg);
if (cfg.baseUrl !== LIVE.replace(/\/+$/, "")) {
  console.error(`probe-traces.mjs: baseUrl resolved to '${cfg.baseUrl}' — expected '${LIVE}'`);
  process.exit(2);
}

async function findDatasetId(name, timeoutMs = 8000) {
  const listed = await client.listDatasets(timeoutMs);
  if (!listed.ok) throw new Error(`listDatasets failed: ${listed.error?.message}`);
  return listed.datasets.find((d) => d.name === name)?.id || "";
}

async function cleanupDataset(name) {
  try {
    const id = await findDatasetId(name, 5000);
    if (!id) return `cleanup: dataset '${name}' not found (already gone — ok)`;
    const r = await client.forget(id, undefined, 20_000);
    return r.ok ? `cleanup: deleted dataset '${name}' (${id})` : `cleanup: forget('${name}') failed: ${safeDetail(r.error?.message)}`;
  } catch (err) {
    return `cleanup: '${name}' best-effort failed: ${safeDetail(describeError(err))}`;
  }
}

/** All session-cache trace rows (the server returns them under `traces`, not `qas`). */
async function traceRows(sessionId, timeoutMs = 8000) {
  const res = await fetch(`${cfg.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    headers: cfg.apiKey ? { "X-Api-Key": cfg.apiKey } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`GET /api/v1/sessions/${sessionId} → HTTP ${res.status}: ${truncateText(await res.text(), 160)}`);
  }
  const data = await res.json();
  return (Array.isArray(data.traces) ? data.traces : []).filter(
    (row) => typeof row?.origin_function === "string",
  );
}

/** Poll the session cache until a trace row matching pred appears (drain wait). */
async function waitTraceRow(pred, { sessionId, tries = 20, intervalMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const rows = await traceRows(sessionId);
    const hit = rows.find(pred);
    if (hit) return { hit, rows };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { hit: undefined, rows: await traceRows(sessionId) };
}

/* ================================================================== */
/* Steps                                                               */
/* ================================================================== */

const { pi, recorded } = makeStubApi();
ext.default(pi); // production factory — reads env at construction
const statuses = [];
const ctx = {
  hasUI: true,
  ui: { notify() {}, setStatus: (_k, v) => statuses.push(v) },
  cwd: workDir,
  sessionManager: { getSessionId: () => HOST_SESSION },
};
const fire = (ev) =>
  recorded.events.get("tool_result")[0]({ toolCallId: "probe-1", ...ev }, ctx);

let harnessError = null;
try {
  await step("0. pre-clean the selftest dataset (crashed-run recovery)", async () => {
    const note = await cleanupDataset(SELFTEST_DS);
    return pass(note);
  }, { timeoutMs: 25_000 });

  await step("1. health() reachable", async () => {
    const h = await client.health(8000);
    assert.ok(h.reachable, `unreachable: ${h.error}`);
    return pass(`status=${h.status} latency=${h.latencyMs}ms version=${h.version ?? "(unreported)"}`);
  }, { timeoutMs: 12_000 });

  await step("2. session_start → healthy (statusline ●, dataset ensured)", async () => {
    recorded.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    for (let i = 0; i < 60 && !statuses.some((s) => s.startsWith("● cognee:")); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(statuses.some((s) => s.startsWith("● cognee:")), `never reached healthy: ${statuses.at(-1) ?? "(no status)"}`);
    return pass(`statusline: ${statuses.find((s) => s.startsWith("● cognee:"))}`);
  }, { timeoutMs: 20_000 });

  await step("3. bash tool_result → trace row lands in the session cache (wire + read-back)", async () => {
    fire({
      toolName: "bash",
      input: { command: "ls -la /probe-marker" },
      content: [{ type: "text", text: "probe-marker-file-a" }, { type: "text", text: "probe-marker-file-b" }],
      isError: false,
    });
    const { hit, rows } = await waitTraceRow((row) => row.method_params?.command === "ls -la /probe-marker", { sessionId: `pi_${HOST_SESSION}` });
    assert.ok(hit, `trace row never appeared (${rows.length} trace rows: ${safeDetail(JSON.stringify(rows))})`);
    assert.equal(hit.origin_function, "bash");
    assert.equal(hit.status, "success");
    const ret = String(hit.method_return_value ?? "");
    assert.ok(ret.includes("probe-marker-file-a") && ret.includes("probe-marker-file-b"), `joined blocks stored: ${safeDetail(ret)}`);
    return pass(`stored: origin=${hit.origin_function} status=${hit.status} return=${ret.length}B`);
  }, { timeoutMs: 25_000 });

  await step("4. error status + 500B error_message survive the round-trip", async () => {
    fire({
      toolName: "read",
      input: { path: "/tmp/probe-missing.ts" },
      content: [{ type: "text", text: `E${"probe-error ".repeat(60)}` }],
      isError: true,
    });
    const { hit } = await waitTraceRow((row) => row.method_params?.path === "/tmp/probe-missing.ts", { sessionId: `pi_${HOST_SESSION}` });
    assert.ok(hit, "error trace row never appeared");
    assert.equal(hit.status, "error");
    const msg = String(hit.error_message ?? "");
    assert.ok(Buffer.byteLength(msg, "utf8") <= 500, `error_message ≤ 500B (got ${Buffer.byteLength(msg)})`);
    assert.ok(msg.endsWith("..."), "over-cap error text truncated");
    return pass(`status=error error_message=${Buffer.byteLength(msg)}B (ends …)`);
  }, { timeoutMs: 25_000 });

  await step("5. redaction on the STORED copy (secret input key + PEM output)", async () => {
    fire({
      toolName: "read",
      input: { path: "/probe/cfg", api_key: "probe-secret-value-0123456789" },
      content: [{ type: "text", text: "config: -----BEGIN PRIVATE KEY-----\nprobePEM\n-----END PRIVATE KEY-----" }],
      isError: false,
    });
    const { hit } = await waitTraceRow((row) => row.method_params?.path === "/probe/cfg", { sessionId: `pi_${HOST_SESSION}` });
    assert.ok(hit, "secret-bearing trace row never appeared");
    const stored = JSON.stringify(hit);
    assert.ok(!stored.includes("probe-secret-value"), "secret input value never stored");
    assert.ok(String(hit.method_params.api_key).includes("[redacted:credential]"), `dict secret-key redacted: ${safeDetail(String(hit.method_params.api_key))}`);
    assert.ok(String(hit.method_return_value).includes("[redacted:private-key]"), "PEM output redacted");
    assert.ok(!stored.includes("probePEM"), "PEM material never stored");
    return pass("stored copy carries [redacted:credential] + [redacted:private-key], no material");
  }, { timeoutMs: 25_000 });

  await step("6. deny list + allowlist refusals never reach the server (row-count stable)", async () => {
    const before = (await traceRows(`pi_${HOST_SESSION}`)).length;
    fire({ toolName: "read", input: { path: "/probe/.env" }, content: [{ type: "text", text: "X=1" }], isError: false });
    fire({ toolName: "write", input: { path: "/probe/secrets.yaml" }, content: [], isError: false });
    fire({ toolName: "mcp__probe__tool", input: { q: 1 }, content: [{ type: "text", text: "custom" }], isError: false });
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await traceRows(`pi_${HOST_SESSION}`)).length;
    assert.equal(after, before, `refused entries must not write (before=${before}, after=${after})`);
    return pass(`row count stable at ${after}`);
  }, { timeoutMs: 25_000 });

  await step("7. self-reference skip live (cognee shell line writes nothing)", async () => {
    const before = (await traceRows(`pi_${HOST_SESSION}`)).length;
    fire({ toolName: "bash", input: { command: "cognee search probe" }, content: [{ type: "text", text: "r" }], isError: false });
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await traceRows(`pi_${HOST_SESSION}`)).length;
    assert.equal(after, before, "self-referencing bash line must not write");
    return pass(`row count stable at ${after}`);
  }, { timeoutMs: 25_000 });
} catch (err) {
  harnessError = err;
} finally {
  try {
    const shutdown = recorded.events.get("session_shutdown")?.[0];
    if (shutdown) await shutdown({ type: "session_shutdown", reason: "quit" });
  } catch {
    /* best-effort */
  }
  console.log(await cleanupDataset(SELFTEST_DS));
}

/* ---------- summary ---------- */

const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
console.log(`\nprobe-traces: ${counts.PASS ?? 0} PASS · ${counts.FAIL ?? 0} FAIL · ${counts.SKIP ?? 0} SKIP in ${elapsed()}`);
if (harnessError) {
  console.error(`HARNESS ERROR: ${safeDetail(describeError(harnessError))}`);
  process.exit(2);
}
process.exit(counts.FAIL ? 1 : 0);
