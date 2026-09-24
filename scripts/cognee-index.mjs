#!/usr/bin/env node
// scripts/cognee-index.mjs — index a repo into the cognee code graph from the
// CLI, via the extension's own client (identical code path to /cognee-index).
// Usage: node scripts/cognee-index.mjs <repo-path-or-git-url> [--dataset <name>] [--wait <sec>] [--vectors]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PI_ROOT =
  process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(
  pathToFileURL(path.join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs")).href
);
const jiti = createJiti(fileURLToPath(import.meta.url));
const { CogneeClient, loadCogneeConfig } = await jiti.import(path.join(root, "src", "client.ts"));

const argv = process.argv.slice(2);
const spec = argv.find((a) => !a.startsWith("--"));
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const dataset = flag("--dataset");
const waitMs = (Number(flag("--wait")) || 120) * 1000;
const queryJson = flag("--query");

if (queryJson && dataset) {
  // Query-only mode: node scripts/cognee-index.mjs --query '<operation-json>' --dataset <name> [seed]
  const cfg0 = loadCogneeConfig();
  const c0 = new CogneeClient(cfg0);
  const res0 = await c0.codeSearch({ seed: spec ?? "query", codeQuery: JSON.parse(queryJson), dataset, topK: 8, timeoutMs: 10_000 });
  console.log(res0.ok ? JSON.stringify(res0.items ?? res0, null, 1).slice(0, 2000) : `ERROR: ${res0.error?.message}`);
  process.exit(res0.ok ? 0 : 1);
}

if (!spec) {
  console.error("usage: cognee-index.mjs <repo-path-or-git-url> [--dataset <name>] [--wait <sec>] [--vectors]");
  process.exit(2);
}

const cfg = loadCogneeConfig();
const client = new CogneeClient(cfg);
const ds = dataset ?? "(auto)";
console.log(`[cognee-index] server=${cfg.baseUrl} dataset=${ds} spec=${spec}`);

const r = await client.indexCodeRepo({
  repoSpec: spec,
  dataset: dataset ?? "",
  indexVectors: argv.includes("--vectors"),
  background: true,
  timeoutMs: 30_000,
});
if (!r.ok) {
  console.error(`[cognee-index] submit failed: ${r.error?.message ?? "(no message)"}`);
  process.exit(1);
}
let datasetId = r.datasetId ?? "";
console.log(`[cognee-index] submitted dataset_id=${datasetId || "?"} status=${r.serverStatus ?? "?"}`);

if (!datasetId && dataset) {
  const listed = await client.listDatasets(8_000);
  if (listed.ok) datasetId = listed.datasets.find((d) => d.name === dataset)?.id ?? "";
}

const deadline = Date.now() + waitMs;
let status = "(unknown)";
while (Date.now() < deadline) {
  if (datasetId) {
    const st = await client.codeGraphStatus(datasetId, 8_000);
    if (!st.ok) { console.error(`[cognee-index] status poll failed: ${st.error?.message}`); process.exit(1); }
    status = st.status ?? "(none)";
    process.stdout.write(`\r[cognee-index] pipeline status: ${status}        `);
    if (/COMPLETED|ERRORED|FAILED/.test(status)) break;
  }
  await new Promise((res) => setTimeout(res, 3000));
}
console.log();
if (!/COMPLETED/.test(status)) {
  console.error(`[cognee-index] pipeline did not complete within ${waitMs / 1000}s (last: ${status})`);
  process.exit(1);
}
console.log("[cognee-index] graph ready ✅");

// Proof queries on the fresh graph (truncated)
const queries = [
  { label: "explore loadCogneeConfig", seed: "loadCogneeConfig", codeQuery: { operation: "explore", name: "loadCogneeConfig", max_depth: 1 } },
  { label: "query_facts (symbols)", seed: "loadCogneeConfig", codeQuery: { operation: "query_facts", kind: "symbol", limit: 8 } },
  { label: "delta (what this index changed)", seed: "delta", codeQuery: { operation: "delta" } },
];
for (const q of queries) {
  const res = await client.codeSearch({ seed: q.seed, codeQuery: q.codeQuery, dataset: dataset ?? "", topK: 8, timeoutMs: 10_000 });
  const body = res.ok ? JSON.stringify(res.items ?? res).slice(0, 600) : `ERROR: ${res.error?.message}`;
  console.log(`\n=== ${q.label} ===\n${body}`);
}
