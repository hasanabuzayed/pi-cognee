#!/usr/bin/env node
/**
 * LIVE probe — code-recall lane shapes (READ-ONLY: only POST /api/v1/recall).
 *
 *   node test/probe-codelane.mjs
 *
 * Reproduces the empty query_facts lane and tests the reference auto-lane
 * shape against the live server. Never prints secrets.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIVE = "https://cognee.apps.jazm.dev";
const DATASET = "pi-cognee";

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

const clientMod = await jiti.import(path.join(root, "src", "client.ts"));
const { CogneeClient, loadCogneeConfig, buildCodeQuery, redactSecrets, truncateText } = clientMod;

process.env.COGNEE_BASE_URL = LIVE;
const cfg = loadCogneeConfig();
const client = new CogneeClient(cfg);

const safe = (s) => truncateText(redactSecrets(String(s ?? "")).replace(/\s+/g, " ").trim(), 300);

function describe(r) {
  if (!r.ok) return `ERROR: ${safe(r.error?.message)}`;
  const texts = r.items.map((it) => String(it?.text ?? ""));
  const parsed = texts.map((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  });
  return `${r.items.length} item(s): ${safe(JSON.stringify(parsed))}`;
}

async function probe(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`\n### ${label}  [${Date.now() - t0}ms]`);
    console.log(describe(r));
    return r;
  } catch (err) {
    console.log(`\n### ${label}  [${Date.now() - t0}ms]`);
    console.log(`THREW: ${safe(err?.message ?? err)}`);
    return null;
  }
}

const SYM = process.env.PROBE_SYMBOL || "loadCogneeConfig";
const PROMPT = `where is ${SYM} defined and how does it load config?`;

// A. OUR current auto-lane shape: codeSearch(seed=identifier, codeQuery=query_facts+name)
await probe(`A. ours: query_facts+name (identifier seed) — current lane`, () =>
  client.codeSearch({
    seed: SYM,
    codeQuery: buildCodeQuery(SYM),
    dataset: DATASET,
    topK: 5,
    timeoutMs: 15_000,
  }),
);

// B. reference auto-lane literal shape: query=FULL PROMPT + code_query=query_facts+name
await probe(`B. reference literal: query=prompt + code_query=query_facts+name`, () =>
  client.recall({
    query: PROMPT,
    topK: 5,
    onlyContext: true,
    scope: ["code"],
    dataset: DATASET,
    datasetPresanitized: true,
    codeQuery: buildCodeQuery(SYM),
    timeoutMs: 15_000,
  }),
);

// C. NO code_query: default explore with the query text as seed
await probe(`C. no code_query (default explore, seed=${SYM})`, () =>
  client.codeSearch({ seed: SYM, dataset: DATASET, topK: 5, timeoutMs: 15_000 }),
);

// C2. no code_query with full-prompt seed
await probe(`C2. no code_query (default explore, seed=full prompt)`, () =>
  client.codeSearch({ seed: PROMPT, dataset: DATASET, topK: 5, timeoutMs: 15_000 }),
);

// D. sanity: explore WITH name — symbol exists?
await probe(`D. explore+name (${SYM}, max_depth 1) — sanity`, () =>
  client.codeSearch({
    seed: SYM,
    codeQuery: { operation: "explore", name: SYM, max_depth: 1 },
    dataset: DATASET,
    topK: 5,
    timeoutMs: 15_000,
  }),
);

// E. query_facts WITHOUT name — kind-filtered listing (total > 0 means the dataset HAS facts)
await probe(`E. query_facts (no name, limit 5) — listing sanity`, () =>
  client.codeSearch({
    seed: SYM,
    codeQuery: { operation: "query_facts", limit: 5 },
    dataset: DATASET,
    topK: 5,
    timeoutMs: 15_000,
  }),
);

// F. second symbol with our shape and no-code-query shape, for robustness
const SYM2 = process.env.PROBE_SYMBOL2 || "CogneeClient";
await probe(`F1. ours: query_facts+name (${SYM2})`, () =>
  client.codeSearch({
    seed: SYM2,
    codeQuery: buildCodeQuery(SYM2),
    dataset: DATASET,
    topK: 5,
    timeoutMs: 15_000,
  }),
);
await probe(`F2. no code_query (default explore, seed=${SYM2})`, () =>
  client.codeSearch({ seed: SYM2, dataset: DATASET, topK: 5, timeoutMs: 15_000 }),
);
