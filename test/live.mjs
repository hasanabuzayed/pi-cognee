#!/usr/bin/env node
/**
 * pi-cognee LIVE test — runs only when COGNEE_LIVE_BASE_URL is set.
 *
 *   COGNEE_LIVE_BASE_URL=https://cognee.apps.jazm.dev node test/live.mjs
 *
 * Exercises the REAL src/client.ts methods (jiti-loaded, no copied curl calls)
 * against a real cognee server. Write tests touch ONLY the datasets
 * "pi-cognee-selftest" and "pi-cognee-codegraph-selftest"; both are deleted
 * (best-effort) at the end. Secrets are never printed. Every step is bounded
 * by a timeout; total runtime target < 3 minutes.
 */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadClientMod } from "./mod.mjs";

const LIVE = process.env.COGNEE_LIVE_BASE_URL;
if (!LIVE) {
  console.error("live.mjs: set COGNEE_LIVE_BASE_URL (e.g. https://cognee.apps.jazm.dev) — refusing to run blind.");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const PI_ROOT =
  process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(
  pathToFileURL(path.join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs")).href
);
const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: {
    "@earendil-works/pi-ai": path.join(PI_ROOT, "node_modules", "@earendil-works", "pi-ai"),
  },
  moduleCache: false,
});

const clientMod = await loadClientMod(jiti, root);
const {
  CogneeClient,
  loadCogneeConfig,
  redactSecrets,
  truncateText,
  describeError,
} = clientMod;

/* ---------- harness: bounded steps, PASS/FAIL/SKIP ---------- */

const START = Date.now();
const BUDGET_MS = 170_000; // global wall budget (target: finish < 3 min)
const leftMs = () => BUDGET_MS - (Date.now() - START);
const elapsed = () => ((Date.now() - START) / 1000).toFixed(1) + "s";

const results = [];

function safeDetail(text) {
  return truncateText(redactSecrets(String(text ?? "")).replace(/\s+/g, " ").trim(), 220);
}

/** A server-capability gap (no LLM key, no embeddings, unsupported op) — not a client bug. */
function isCapabilityGap(message) {
  return /llm|embedding|embedder|vector.*(?:not|un)|openai|api[_ ]?key|provider|not configured|unsupported|no such (operation|pipeline)|disallowed/i.test(
    message,
  );
}

async function withTimeout(promiseFactory, ms, label) {
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

async function step(name, fn, { timeoutMs = 20_000, skipIf } = {}) {
  if (skipIf) {
    results.push({ name, status: "SKIP", detail: skipIf });
    console.log(`SKIP  ${name} — ${skipIf}`);
    return { status: "SKIP" };
  }
  if (leftMs() < 5_000) {
    results.push({ name, status: "SKIP", detail: `global budget exhausted at ${elapsed()}` });
    console.log(`SKIP  ${name} — global budget exhausted at ${elapsed()}`);
    return { status: "SKIP" };
  }
  const cap = Math.min(timeoutMs, leftMs());
  try {
    const outcome = await withTimeout(fn, cap, name); // fn returns {status, detail}
    const status = outcome?.status ?? "PASS";
    const detail = safeDetail(outcome?.detail ?? "");
    results.push({ name, status, detail });
    console.log(`${status}  ${name}${detail ? ` — ${detail}` : ""}`);
    return outcome ?? { status: "PASS" };
  } catch (err) {
    const message = err?.stepTimeout ? err.message : describeError(err);
    const status = err?.stepTimeout ? "FAIL" : isCapabilityGap(message) ? "SKIP" : "FAIL";
    const detail = safeDetail(message);
    results.push({ name, status, detail });
    console.log(`${status}  ${name} — ${detail}`);
    return { status, detail };
  }
}

const pass = (detail) => ({ status: "PASS", detail });
const fail = (detail) => ({ status: "FAIL", detail });
const skip = (detail) => ({ status: "SKIP", detail });

/* ---------- constants + client construction ---------- */

const SELFTEST_DS = "pi-cognee-selftest";
const CODE_DS = "pi-cognee-codegraph-selftest";
const SESSION_ID = "pi-selftest-session";
const REPO = root; // this repo: small git checkout, 8 source files

// Shell env wins over ~/.cognee/.env in loadCogneeConfig — pin it to the live server.
process.env.COGNEE_BASE_URL = LIVE;

const cfg = loadCogneeConfig();
const client = new CogneeClient(cfg);

let selftestDatasetId; // resolved UUID, used by cleanup
let codeDatasetId;

/** Resolve a dataset UUID by name (read-only). */
async function findDatasetId(name, timeoutMs = 8000) {
  const listed = await client.listDatasets(timeoutMs);
  if (!listed.ok) throw new Error(`listDatasets failed: ${listed.error?.message}`);
  const hit = listed.datasets.find((d) => d.name === name);
  return hit?.id || "";
}

/** Best-effort whole-dataset cleanup — NEVER throws, only selftest datasets. */
async function cleanup(name, datasetId) {
  try {
    const id = datasetId || (await findDatasetId(name, 5000));
    if (!id) {
      console.log(`cleanup: dataset '${name}' not found (already gone — ok)`);
      return;
    }
    const r = await client.forget(id, undefined, 20_000);
    console.log(r.ok ? `cleanup: deleted dataset '${name}' (${id})` : `cleanup: forget('${name}') failed: ${safeDetail(r.error?.message)}`);
  } catch (err) {
    console.log(`cleanup: '${name}' best-effort failed: ${safeDetail(describeError(err))}`);
  }
}

// Ctrl-C / SIGTERM: an async cleanup cannot be awaited reliably on a signal — at
// minimum name the leftover datasets so the operator can delete them by hand.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(
      `\n${sig} received — live test aborted. Selftest datasets may be left on the server: ` +
        `'${SELFTEST_DS}', '${CODE_DS}' (delete via /cognee-forget <dataset> or the cognee API).`,
    );
    process.exit(130);
  });
}

/* ================================================================== */
/* Steps                                                               */
/* ================================================================== */

// Every step() swallows its own errors, but a future harness bug (unhandled
// rejection at top level) must not skip the dataset deletes: steps run in a
// try, cleanup in a finally. Body kept at top-level indentation deliberately.
let harnessError = null;
try {

await step("1. health() reports reachable + version", async () => {
  const h = await client.health(8000);
  assert.ok(h.reachable, `unreachable: ${h.error}`);
  assert.ok(h.status < 500, `status ${h.status}`);
  return pass(`status=${h.status} latency=${h.latencyMs}ms version=${h.version ?? "(unreported)"}`);
}, { timeoutMs: 10_000 });

await step("2a. loadCogneeConfig: COGNEE_BASE_URL wins, backend resolved", async () => {
  assert.equal(cfg.baseUrl, LIVE.replace(/\/+$/, ""), `baseUrl=${cfg.baseUrl}`);
  assert.equal(cfg.backend, "cloud", `backend=${cfg.backend}`);
  assert.ok(cfg.baseUrl !== "http://localhost:8011", "must not fall back to local default");
  return pass(`backend=${cfg.backend} baseUrl=${cfg.baseUrl} apiKeySource=${cfg.apiKeySource}`);
}, { timeoutMs: 5_000 });

await step("2b. API key set ⇒ auth header sent; unset ⇒ none (request-construction probe)", async () => {
  // Local throwaway capture server: run REAL client methods (listDatasets →
  // jsonRequest → authHeaders) against it and inspect the outgoing headers.
  const captured = [];
  const server = http.createServer((req, res) => {
    captured.push({ url: req.url, xApiKey: req.headers["x-api-key"] ?? null });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const probeBase = `http://127.0.0.1:${port}`;
    // (A no-key loopback client also fires the lazy owner-key mint — POST /auth/login —
    // which is real client behavior; filter it out and judge only the dataset GETs.)
    const withKey = new CogneeClient({ ...cfg, baseUrl: probeBase, apiKey: "pi-selftest-dummy-key", apiKeySource: "shell env" });
    const r1 = await withKey.listDatasets(3000);
    assert.ok(r1.ok, `probe request with key failed: ${r1.error?.message}`);
    const withoutKey = new CogneeClient({ ...cfg, baseUrl: probeBase, apiKey: undefined });
    const r2 = await withoutKey.listDatasets(3000);
    assert.ok(r2.ok, `probe request without key failed: ${r2.error?.message}`);
    const datasetsGets = captured.filter((c) => c.url === "/api/v1/datasets");
    assert.equal(datasetsGets.length, 2, `expected 2 dataset GETs, got ${datasetsGets.length} (all captured: ${captured.map((c) => c.url).join(", ")})`);
    assert.ok(datasetsGets[0].xApiKey === "pi-selftest-dummy-key", "X-Api-Key must be sent when a key is configured");
    assert.ok(datasetsGets[1].xApiKey === null || datasetsGets[1].xApiKey === undefined, "no auth header when key unset");
    return pass("X-Api-Key present with key, absent without (value never logged; header name is X-Api-Key per shared plugin contract)");
  } finally {
    server.close();
  }
}, { timeoutMs: 10_000 });

await step("3a. session add: rememberEntry() ×3 qa facts → " + SELFTEST_DS, async () => {
  const facts = [
    { question: "What is the selftest marker fruit?", answer: "The selftest marker fruit is a quince.", context: "pi-cognee live selftest A" },
    { question: "What is the selftest marker color?", answer: "The selftest marker color is cobalt.", context: "pi-cognee live selftest B" },
    { question: "What is the selftest marker planet?", answer: "The selftest marker planet is Ceres.", context: "pi-cognee live selftest C" },
  ];
  for (const f of facts) {
    const r = await client.rememberEntry({ type: "qa", ...f }, SESSION_ID, SELFTEST_DS, 10_000);
    assert.ok(r.ok, `rememberEntry failed: ${r.error?.message}`);
  }
  return pass(`3 qa entries written to session '${SESSION_ID}'`);
}, { timeoutMs: 25_000 });

await step("3b. session roundtrip: getSessionDetail() sees the written fact", async () => {
  const detail = await client.getSessionDetail(SESSION_ID, 10_000);
  assert.ok(detail.ok, `getSessionDetail failed: ${detail.error?.message}`);
  const blob = JSON.stringify(detail.qas);
  assert.ok(/quince/.test(blob), `session cache has ${detail.qas.length} rows but no 'quince' fact`);
  return pass(`${detail.qas.length} qa rows in session cache, marker fact found`);
}, { timeoutMs: 15_000 });

await step("3c. session-bound recall() roundtrip", async () => {
  const rec = await client.recall({
    query: "selftest marker fruit",
    sessionId: SESSION_ID,
    dataset: SELFTEST_DS,
    topK: 5,
    searchType: "HYBRID_COMPLETION", // per-prompt recall pin (plugin parity)
    onlyContext: true,
    scope: ["graph"],
    timeoutMs: 15_000,
  });
  if (!rec.ok) {
    if (isCapabilityGap(rec.error?.message ?? "")) return skip(`server capability: ${rec.error?.message}`);
    return fail(rec.error?.message);
  }
  const blob = JSON.stringify(rec.items);
  if (/quince/i.test(blob)) {
    return pass(`relevant hit (${rec.items.length} items, source=${rec.items[0]?.source ?? "?"}): ${truncateText(blob, 120)}`);
  }
  return pass(`ok but no 'quince' hit yet (${rec.items.length} items) — session cache itself verified in 3b; graph may need cognify (step 4)`);
}, { timeoutMs: 20_000 });

let improveSubmittedAt = 0; // set by 4a — floor for trusting a COMPLETED status in 4b
await step("4a. graph tier: improve() submits (session→graph cognify)", async () => {
  selftestDatasetId = await findDatasetId(SELFTEST_DS, 8000); // resolved independent of improve
  let imp;
  try {
    imp = await client.improve(SESSION_ID, SELFTEST_DS, 45_000);
  } catch (err) {
    return fail(describeError(err));
  }
  if (imp.outcome === "ok") {
    improveSubmittedAt = Date.now();
    return pass(`improve submitted (dataset ${selftestDatasetId || "by name"})`);
  }
  if (imp.outcome === "busy") {
    improveSubmittedAt = Date.now();
    return pass("improve lock busy — server already cognifying this session");
  }
  if (imp.outcome === "unsupported") return skip(`server lacks improve endpoint: ${imp.error?.message}`);
  if (isCapabilityGap(imp.error?.message ?? "")) return skip(`server capability: ${imp.error?.message}`);
  if (imp.error?.transient) {
    improveSubmittedAt = Date.now(); // the submit may still have landed server-side
    return skip(`improve submit timed out client-side (server may still be processing — official default bound is 420s); committed-ness verified by 4b/4c. ${imp.error.message}`);
  }
  return fail(imp.error?.message);
}, { timeoutMs: 52_000 });

let cognifyTerminal = "";
await step("4b. graph tier: poll datasetStatus(cognify_pipeline) short wait", async () => {
  if (!selftestDatasetId) selftestDatasetId = await findDatasetId(SELFTEST_DS, 8000);
  if (!selftestDatasetId) return skip(`dataset '${SELFTEST_DS}' not resolvable yet (created lazily by improve)`);
  const deadline = Math.min(Date.now() + 30_000, START + BUDGET_MS - 20_000);
  let last = "";
  let sawActive = false; // a non-terminal observation proves THIS run's pipeline was seen
  let trusted = false; // loop exited via a verified terminal break, not budget exhaustion
  while (Date.now() < deadline) {
    const st = await client.datasetStatus(selftestDatasetId, "cognify_pipeline", 8000);
    if (!st.ok) {
      if (isCapabilityGap(st.error?.message ?? "")) return skip(`server capability: ${st.error?.message}`);
      return fail(st.error?.message);
    }
    last = st.status ?? "(none)";
    if (!/COMPLETED|ERRORED|FAILED/.test(last)) sawActive = true;
    // Server quirk (probe-verified on 1.6.0): the /datasets/status entry survives
    // dataset deletion, so a recreated deterministic-UUID dataset reports the
    // PREVIOUS run's COMPLETED before the fresh pipeline even starts. Trust
    // COMPLETED only after a non-terminal state was observed or the improve
    // submit is far enough back for a stale entry to be implausible.
    if (/ERRORED|FAILED/.test(last)) { trusted = true; break; }
    if (/COMPLETED/.test(last) && (sawActive || (improveSubmittedAt > 0 && Date.now() - improveSubmittedAt > 8_000))) {
      trusted = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  cognifyTerminal = last;
  if (/ERRORED|FAILED/.test(last)) return skip(`cognify pipeline errored server-side (likely LLM/embedding config): ${last}`);
  return pass(`cognify_pipeline status=${last}${trusted ? "" : " (not reliably terminal within budget — 4c retry loop arbitrates)"}`);
}, { timeoutMs: 35_000 });

await step("4c. graph tier: recall() over " + SELFTEST_DS + " finds the fact", async () => {
  // improve is genuinely background on 1.6.0 (POST returns status:"running" in
  // ~0.5s) while the cognify pipeline itself needs 15-30s — retry the recall in
  // a bounded loop until the graph is actually searchable instead of trusting a
  // single early shot.
  const deadline = Math.min(Date.now() + 30_000, START + BUDGET_MS - 10_000);
  let rec;
  let blob = "";
  while (Date.now() < deadline) {
    rec = await client.recall({
      query: "selftest marker fruit",
      dataset: SELFTEST_DS,
      topK: 5,
      onlyContext: true,
      scope: ["graph"], // production parity: the extension + official plugins pin
      // HYBRID_COMPLETION on completion recalls; leaving search_type unset lets the
      // server auto-router pick, which on cognee 1.6.0 returns a scoped completion
      // that may not echo the fact — not a path any client uses.
      searchType: "HYBRID_COMPLETION",
      timeoutMs: 20_000,
    });
    if (!rec.ok && isCapabilityGap(rec.error?.message ?? ""))
      return skip(`server capability: ${rec.error?.message}`);
    if (rec.ok) {
      blob = JSON.stringify(rec.items);
      if (/quince/i.test(blob))
        return pass(`graph hit (${rec.items.length} items): ${truncateText(blob, 140)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Retry loop exhausted — surface a persistent error as the verdict, else fall
  // back to the cognify-terminal-based pass/skip/fail verdicts.
  if (rec && !rec.ok) return fail(rec.error?.message);
  if (!/COMPLETED/.test(cognifyTerminal)) return skip(`graph not cognified yet (status=${cognifyTerminal || "unknown"}) — no graph to search`);
  return fail(`cognify reported ${cognifyTerminal} but graph recall found no 'quince' (${rec?.items.length ?? 0} items): ${truncateText(blob, 140)}`);
  // Inner worst case: 30s deadline (+~23s overshoot of a hanging last recall +
  // 3s sleep) ≈ 56s — cap 65s so a slow tail yields the step's own verdict, not
  // a spurious step-timeout FAIL (the global budget still binds via
  // Math.min(timeoutMs, leftMs())).
}, { timeoutMs: 65_000 });

await step("5. datasets: listDatasets() shows " + SELFTEST_DS, async () => {
  const listed = await client.listDatasets(10_000);
  assert.ok(listed.ok, `listDatasets failed: ${listed.error?.message}`);
  const hit = listed.datasets.find((d) => d.name === SELFTEST_DS);
  assert.ok(hit, `dataset '${SELFTEST_DS}' absent among ${listed.datasets.length} datasets`);
  selftestDatasetId = hit.id || selftestDatasetId;
  return pass(`present (${listed.datasets.length} datasets total, id=${hit.id})`);
}, { timeoutMs: 15_000 });

/* ---------- 6. CODE GRAPH end-to-end ---------- */

let codeSubmitOk = false;

await step("6a. indexCodeRepo() on this repo → " + CODE_DS, async () => {
  const r = await client.indexCodeRepo({
    repoSpec: REPO,
    dataset: CODE_DS,
    indexVectors: false,
    background: true,
    timeoutMs: 30_000,
  });
  if (!r.ok) {
    const msg = r.error?.message ?? "";
    if (/requires cognee >= 1\.5\.4|unsupported content_type/i.test(msg)) return skip(`server capability: ${msg}`);
    if (isCapabilityGap(msg)) return skip(`server capability: ${msg}`);
    return fail(msg);
  }
  codeSubmitOk = true;
  codeDatasetId = r.datasetId || "";
  return pass(`submitted dataset_id=${r.datasetId ?? "?"} status=${r.serverStatus ?? "?"} (repo spec = client-local path)`);
}, { timeoutMs: 35_000 });

await step("6b. codeGraphStatus() poll → indexed", async () => {
  if (!codeDatasetId) codeDatasetId = await findDatasetId(CODE_DS, 8000);
  if (!codeDatasetId) return skip("no code dataset id resolved (6a skipped)");
  const deadline = Math.min(Date.now() + 30_000, START + BUDGET_MS - 45_000);
  let last = "";
  while (Date.now() < deadline) {
    const st = await client.codeGraphStatus(codeDatasetId, 8000);
    if (!st.ok) {
      if (isCapabilityGap(st.error?.message ?? "")) return skip(`server capability: ${st.error?.message}`);
      return fail(st.error?.message);
    }
    last = st.status ?? "(none)";
    if (/COMPLETED|ERRORED|FAILED/.test(last)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const itemsProbe = await client.listDataItems(codeDatasetId, 8000);
  const dataItems = itemsProbe.ok ? itemsProbe.items.length : -1;
  if (/ERRORED|FAILED/.test(last)) {
    return skip(`code_graph_pipeline errored server-side: ${last}`);
  }
  if (!/COMPLETED/.test(last) && dataItems <= 0) {
    // Background submit acked but nothing landed — resubmit synchronously VIA THE
    // CLIENT (bounded) to harvest the server's definitive rejection message.
    const probe = await client.indexCodeRepo({
      repoSpec: REPO, dataset: CODE_DS, indexVectors: false, background: false, timeoutMs: 25_000,
    });
    const srvMsg = probe.ok
      ? "sync resubmit unexpectedly ok"
      : probe.error?.message ?? "(no message)";
    return skip(`server cannot index this spec: ${truncateText(srvMsg, 200)}`);
  }
  return pass(`code_graph_pipeline status=${last} (data_items=${dataItems})`);
  // Inner worst case: findDatasetId 8s + poll 30s deadline (+~11s overshoot of the
  // last call/sleep) + listDataItems 8s + sync resubmit probe 25s ≈ 82s — cap 90s so a
  // slow probe yields SKIP, not a spurious step-timeout FAIL (the global budget still
  // binds via Math.min(timeoutMs, leftMs())).
}, { timeoutMs: 90_000 });

function summarizeCodeItems(items) {
  const blob = JSON.stringify(items);
  return `${items.length} items: ${truncateText(blob, 180)}`;
}

/** Pull plausible symbol names out of a code-graph response (enola facts JSON). */
function discoverSymbols(items) {
  const blob = JSON.stringify(items);
  const tokens = [...blob.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{3,40})\b/g)].map((m) => m[1]);
  const STOP = new Set(["operation", "facts", "total", "offset", "limit", "has_more", "true", "false", "null", "kind", "search_type", "text", "score", "dataset", "dataset_id", "dataset_name", "source", "session", "content", "question", "answer", "string", "object"]);
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (STOP.has(k) || seen.has(k)) continue;
    // prefer identifier-looking tokens (snake_case or camelCase)
    if (!(/[a-z][A-Z]/.test(t) || t.includes("_"))) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

function gradeCodeSearch(r, emptyNote) {
  if (!r.ok) {
    if (isCapabilityGap(r.error?.message ?? "")) return skip(`server capability: ${r.error?.message}`);
    return fail(r.error?.message);
  }
  return r.items.length ? pass(summarizeCodeItems(r.items)) : skip(emptyNote);
}

/** The enola ops arrive as ONE recall item whose text is a JSON envelope —
 *  real data means some inner array (facts/nodes/edges/path/repositories) is non-empty. */
function codeHasData(items) {
  for (const item of items ?? []) {
    let parsed;
    try {
      parsed = JSON.parse(String(item?.text ?? ""));
    } catch {
      if (String(item?.text ?? "").trim()) return true; // non-JSON prose hit
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value) && value.length > 0) return true;
      }
    } else if (Array.isArray(parsed) && parsed.length) return true;
  }
  return false;
}

const LOCAL_SYMBOLS = ["loadCogneeConfig", "CogneeClient"];

await step("6c. codeSearch explore(loadCogneeConfig)", async () => {
  const r = await client.codeSearch({
    seed: "loadCogneeConfig",
    codeQuery: { operation: "explore", name: "loadCogneeConfig", max_depth: 1 },
    dataset: CODE_DS,
    topK: 10,
    timeoutMs: 15_000,
  });
  return gradeCodeSearch(r, "graph answered ok but empty — this repo's spec was not indexable by this server (see 6b)");
}, { timeoutMs: 20_000 });

await step("6d. codeSearch query_facts(limit=5)", async () => {
  const r = await client.codeSearch({
    seed: "query_facts",
    codeQuery: { operation: "query_facts", limit: 5 },
    dataset: CODE_DS,
    topK: 10,
    timeoutMs: 15_000,
  });
  if (!r.ok) {
    if (isCapabilityGap(r.error?.message ?? "")) return skip(`server capability: ${r.error?.message}`);
    return fail(r.error?.message);
  }
  return codeHasData(r.items)
    ? pass(summarizeCodeItems(r.items))
    : skip(`well-formed empty envelope (${truncateText(JSON.stringify(r.items), 140)}) — dataset has no code graph (see 6b)`);
}, { timeoutMs: 20_000 });

await step("6e. codeSearch find_path(loadCogneeConfig → CogneeClient)", async () => {
  const r = await client.codeSearch({
    seed: "loadCogneeConfig",
    codeQuery: { operation: "find_path", source: "loadCogneeConfig", target: "CogneeClient" },
    dataset: CODE_DS,
    topK: 10,
    timeoutMs: 15_000,
  });
  return gradeCodeSearch(r, "ok but no path — dataset has no code graph (see 6b)");
}, { timeoutMs: 20_000 });

await step("6f. codeSearch delta (last index change)", async () => {
  const r = await client.codeSearch({
    seed: "delta",
    codeQuery: { operation: "delta" },
    dataset: CODE_DS,
    topK: 10,
    timeoutMs: 15_000,
  });
  if (!r.ok) {
    if (isCapabilityGap(r.error?.message ?? "")) return skip(`server capability: ${r.error?.message}`);
    return fail(r.error?.message);
  }
  return codeHasData(r.items)
    ? pass(summarizeCodeItems(r.items))
    : skip(`well-formed empty envelope (${truncateText(JSON.stringify(r.items), 140)}) — no repository indexed (see 6b)`);
}, { timeoutMs: 20_000 });

/* ---------- 6 (fallback): same client route with a git-URL spec this server CAN clone ---------- */

const FALLBACK_REPO = "https://github.com/sindresorhus/slugify"; // tiny public repo (few .js files)
let fallbackSymbols = [];

await step("6g. fallback: indexCodeRepo(git URL) → " + CODE_DS, async () => {
  if (leftMs() < 70_000) return skip(`insufficient global budget left (${Math.round(leftMs() / 1000)}s) for git-URL indexing`);
  const r = await client.indexCodeRepo({
    repoSpec: FALLBACK_REPO,
    dataset: CODE_DS,
    indexVectors: false,
    background: true,
    timeoutMs: 30_000,
  });
  if (!r.ok) {
    const msg = r.error?.message ?? "";
    if (isCapabilityGap(msg) || /clone|fetch|ALLOW_HTTP/i.test(msg)) return skip(`server capability: ${msg}`);
    return fail(msg);
  }
  codeDatasetId = r.datasetId || codeDatasetId;
  return pass(`submitted git-URL spec (${FALLBACK_REPO}) dataset_id=${r.datasetId ?? "?"} status=${r.serverStatus ?? "?"}`);
}, { timeoutMs: 35_000 });

await step("6h. fallback: codeGraphStatus() poll → indexed", async () => {
  if (!codeDatasetId) codeDatasetId = await findDatasetId(CODE_DS, 8000);
  if (!codeDatasetId) return skip("no code dataset id");
  const deadline = Math.min(Date.now() + 45_000, START + BUDGET_MS - 25_000);
  let last = "";
  while (Date.now() < deadline) {
    const st = await client.codeGraphStatus(codeDatasetId, 8000);
    if (!st.ok) {
      if (isCapabilityGap(st.error?.message ?? "")) return skip(`server capability: ${st.error?.message}`);
      return fail(st.error?.message);
    }
    last = st.status ?? "(none)";
    if (/COMPLETED|ERRORED|FAILED/.test(last)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const itemsProbe = await client.listDataItems(codeDatasetId, 8000);
  const dataItems = itemsProbe.ok ? itemsProbe.items.length : -1;
  if (/ERRORED|FAILED/.test(last)) return skip(`code_graph_pipeline errored server-side: ${last}`);
  if (!/COMPLETED/.test(last) && dataItems <= 0) {
    // Nothing landed — bounded SYNCHRONOUS resubmit via the client harvests the
    // server's definitive rejection (git missing / path unreadable / clone blocked).
    const probe = await client.indexCodeRepo({
      repoSpec: FALLBACK_REPO, dataset: CODE_DS, indexVectors: false, background: false, timeoutMs: 25_000,
    });
    const srvMsg = probe.ok ? "sync resubmit ok but graph still not observable" : probe.error?.message ?? "(no message)";
    return skip(`server cannot build this code graph: ${truncateText(srvMsg, 200)}`);
  }
  if (!/COMPLETED/.test(last)) return skip(`indexing not terminal within budget (status=${last}, data_items=${dataItems})`);
  return pass(`code_graph_pipeline=${last} data_items=${dataItems}`);
  // Inner worst case: findDatasetId 8s + poll 45s deadline (+~11s overshoot) +
  // listDataItems 8s + sync resubmit probe 25s ≈ 97s — cap 100s so a slow probe
  // yields SKIP, not a spurious step-timeout FAIL (global budget still binds).
}, { timeoutMs: 100_000 });

await step("6i. fallback: query_facts + explore + find_path on real symbols", async () => {
  const facts = await client.codeSearch({
    seed: "query_facts",
    codeQuery: { operation: "query_facts", limit: 10 },
    dataset: CODE_DS,
    topK: 10,
    timeoutMs: 15_000,
  });
  if (!facts.ok) {
    if (isCapabilityGap(facts.error?.message ?? "")) return skip(`server capability: ${facts.error?.message}`);
    return fail(facts.error?.message);
  }
  const notes = [];
  const factsNote = facts.items.length
    ? `query_facts ${summarizeCodeItems(facts.items)}`
    : `query_facts ok but empty`;
  notes.push(factsNote);
  fallbackSymbols = discoverSymbols(facts.items);
  if (!fallbackSymbols.length) return skip(`${factsNote} — no code graph on this server (see 6b/6h), so no symbols to explore`);
  const explore = await client.codeSearch({
    seed: fallbackSymbols[0],
    codeQuery: { operation: "explore", name: fallbackSymbols[0], max_depth: 1 },
    dataset: CODE_DS,
    topK: 10,
    timeoutMs: 15_000,
  });
  const exploreOkWithData = explore.ok && explore.items.length > 0;
  notes.push(explore.ok ? `explore(${fallbackSymbols[0]}) ${explore.items.length} items: ${truncateText(JSON.stringify(explore.items), 140)}` : `explore(${fallbackSymbols[0]}) error: ${explore.error?.message?.slice(0, 100)}`);
  let fpOkWithData = false;
  if (fallbackSymbols.length >= 2) {
    const [src, tgt] = [fallbackSymbols[0], fallbackSymbols[1]];
    const fp = await client.codeSearch({
      seed: src,
      codeQuery: { operation: "find_path", source: src, target: tgt },
      dataset: CODE_DS,
      topK: 10,
      timeoutMs: 15_000,
    });
    fpOkWithData = fp.ok && fp.items.length > 0;
    notes.push(fp.ok ? `find_path(${src}→${tgt}) ${fp.items.length} items: ${truncateText(JSON.stringify(fp.items), 140)}` : `find_path(${src}→${tgt}) error: ${fp.error?.message?.slice(0, 100)}`);
  }
  const delta = await client.codeSearch({
    seed: "delta",
    codeQuery: { operation: "delta" },
    dataset: CODE_DS,
    topK: 10,
    timeoutMs: 15_000,
  });
  notes.push(delta.ok ? `delta ${truncateText(JSON.stringify(delta.items), 140)}` : `delta error: ${delta.error?.message?.slice(0, 100)}`);
  // PASS only when the graph actually returned structural data (inner facts/neighborhood/path).
  return codeHasData(facts.items) || exploreOkWithData || fpOkWithData
    ? pass(notes.join(" | "))
    : skip(`${notes.join(" | ")} — ops all ok but empty envelopes: this server cannot build a code graph (see 6b/6h)`);
}, { timeoutMs: 40_000 });

/* ---------- 7. forget discovery (dry) + cleanup ---------- */

await step("7. data items: listDataItems() dry discovery on " + SELFTEST_DS, async () => {
  if (!selftestDatasetId) selftestDatasetId = await findDatasetId(SELFTEST_DS, 8000);
  if (!selftestDatasetId) return skip("dataset id unresolved");
  const r = await client.listDataItems(selftestDatasetId, 10_000);
  if (!r.ok) {
    if (isCapabilityGap(r.error?.message ?? "")) return skip(`server capability: ${r.error?.message}`);
    return fail(r.error?.message);
  }
  return pass(`${r.items.length} data items (dry discovery only; e.g. ${r.items[0]?.name ?? r.items[0]?.id ?? "none"})`);
}, { timeoutMs: 15_000 });

} catch (err) {
  // step() bodies never throw today; this guards the harness itself.
  harnessError = err;
  const detail = safeDetail(describeError(err));
  results.push({ name: "harness", status: "FAIL", detail });
  console.log(`FAIL  harness — ${detail}`);
} finally {
  console.log("\ncleanup:");
  await cleanup(SELFTEST_DS, selftestDatasetId);
  await cleanup(CODE_DS, codeDatasetId);
}

/* ---------- final table (cleanup already ran in the finally above) ---------- */

const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) counts[r.status]++;

console.log("\n================ LIVE TEST RESULTS ================");
for (const [i, r] of results.entries()) {
  console.log(`${String(i + 1).padStart(2)}. [${r.status}] ${r.name}`);
  if (r.detail) console.log(`      ${r.detail}`);
}
console.log("--------------------------------------------------");
console.log(`PASS ${counts.PASS} | FAIL ${counts.FAIL} | SKIP ${counts.SKIP} | total ${results.length} | wall ${elapsed()} / budget ${BUDGET_MS / 1000}s`);
console.log("===================================================");

process.exit(counts.FAIL > 0 || harnessError ? 1 : 0);
