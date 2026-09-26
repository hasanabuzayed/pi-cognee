#!/usr/bin/env node
/**
 * LIVE probe — shared-agent-memory provisioning discovery (READ-ONLY).
 *
 *   COGNEE_LIVE_BASE_URL=https://cognee.apps.jazm.dev node test/probe-provisioning.mjs
 *
 * Discovery only, no writes: GET /health + GET /openapi.json, then asserts
 * the capability verdicts the v0.4 client would reach on this server
 * (research/v04-provisioning-spec.md §4 live probe):
 *   - the provision path EXISTS,
 *   - `create_only` is ABSENT → client verdict "unsupported" (never POSTs),
 *   - the permissions suite is present,
 *   - `x-cognee-session-dataset-ids` is ABSENT → "typed_dataset_unsupported".
 * Guard: the script asserts its own fetch log contains ONLY GETs — no
 * /provision POST, no tenant/role/grant calls, no dataset creation.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadClientMod } from "./mod.mjs";

const LIVE = process.env.COGNEE_LIVE_BASE_URL || "https://cognee.apps.jazm.dev";

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
const provMod = await jiti.import(path.join(root, "src", "provisioning.ts"));

/* ---------- instrumented fetch: record method+url, refuse non-GETs ---------- */

const fetchLog = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const method = opts?.method ?? "GET";
  fetchLog.push({ method, url: String(url) });
  if (method !== "GET") {
    throw new Error(`probe guard: non-GET request attempted (${method} ${url}) — aborting before any write`);
  }
  return realFetch(url, opts);
};

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok  ${name}`);
}

try {
  // 1. GET /health — reachability + version.
  const healthResp = await fetch(`${LIVE}/health`);
  const health = await healthResp.json().catch(() => ({}));
  ok(`GET /health → ${healthResp.status} (version ${health.version ?? "?"})`);

  // 2. GET /openapi.json — raw discovery.
  const specResp = await fetch(`${LIVE}/openapi.json`);
  assert.equal(specResp.status, 200, "openapi.json reachable");
  const spec = await specResp.json();
  const paths = Object.keys(spec.paths ?? {});
  ok(`GET /openapi.json → ${specResp.status} (${paths.length} paths)`);

  // 3. Provision path present.
  const provisionPath = "/api/v1/integrations/plugins/{plugin_key}/provision";
  assert.ok(paths.includes(provisionPath), `provision path present: ${provisionPath}`);
  ok("provision path PRESENT in openapi");

  // 4. create_only query param ABSENT → client verdict "unsupported" (no POST).
  const provisionPost = spec.paths[provisionPath]?.post ?? {};
  const createOnly = (provisionPost.parameters ?? []).some(
    (p) => p?.name === "create_only" && p?.in === "query",
  );
  assert.equal(createOnly, false, "create_only query param absent on the live server");
  ok("create_only query param ABSENT (older contract — client must never POST)");

  // 5. Permissions suite present (the routes shared memory would use).
  for (const route of [
    "/api/v1/permissions/tenants",
    "/api/v1/permissions/tenants/me",
    "/api/v1/permissions/tenants/select",
    "/api/v1/permissions/roles",
    "/api/v1/permissions/users/{user_id}/tenants",
    "/api/v1/permissions/users/{user_id}/roles",
    "/api/v1/permissions/datasets/{principal_id}",
    "/api/v1/permissions/principals/{principal_id}/datasets",
    "/api/v1/users/me",
  ]) {
    assert.ok(paths.includes(route), `permissions route present: ${route}`);
  }
  ok("permissions suite PRESENT (all 9 shared-memory routes)");

  // 6. x-cognee-session-dataset-ids ABSENT → "typed_dataset_unsupported".
  const entryPost = spec.paths["/api/v1/remember/entry"]?.post ?? {};
  assert.notEqual(entryPost["x-cognee-session-dataset-ids"], true, "x-cognee-session-dataset-ids absent");
  ok("x-cognee-session-dataset-ids ABSENT on remember/entry post");

  // 7. The CLIENT-side helper classifications match the fixture tests.
  const caps = provMod.parseOpenapiCapabilities(spec);
  assert.deepEqual(caps, { createOnlyProvision: false, typedDatasetIds: false });
  ok("parseOpenapiCapabilities(live spec) → both unsupported (matches the offline fixtures)");

  process.env.COGNEE_BASE_URL = LIVE;
  process.env.COGNEE_API_KEY = process.env.COGNEE_API_KEY ?? "probe-readonly";
  const cfg = clientMod.loadCogneeConfig();
  const client = new clientMod.CogneeClient({ ...cfg, baseUrl: LIVE, apiKey: "probe-readonly" });
  const verdict = await client.probeCapabilities(10_000);
  assert.deepEqual(verdict, { probed: true, provisioning: false, typedDatasetIds: false });
  ok("client probeCapabilities(live) → probed, both unsupported (verdict 'unsupported', zero POSTs)");

  // 8. The provisioning verdict itself is "unsupported" WITHOUT any POST.
  const provision = await client.provisionPluginAgent(10_000);
  assert.equal(provision.status, "unsupported", "client verdict on the live server");
  ok("provisionPluginAgent(live) → 'unsupported' (capability verdict, not a fault)");

  // Guard: read-only discipline — only GETs left the process.
  const nonGets = fetchLog.filter((c) => c.method !== "GET");
  assert.deepEqual(nonGets, [], `fetch log must contain ONLY GETs: ${JSON.stringify(fetchLog)}`);
  ok(`fetch log contains ONLY GETs (${fetchLog.length} request(s): ${[...new Set(fetchLog.map((c) => c.url))].join(", ")})`);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nprovisioning live probe: ${passed} checks passed ✅ (server ${LIVE}, read-only)`);
