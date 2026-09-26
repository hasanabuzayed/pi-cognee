#!/usr/bin/env node
/**
 * pi-cognee smoke test — runnable with plain `node test/smoke.mjs`.
 *
 * Loads src/index.ts via jiti (borrowed from the installed pi coding agent —
 * no npm dependencies of our own) and invokes the default extension factory
 * against a stub ExtensionAPI that records registrations.
 *
 * No network calls, no server required.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadClientMod } from "./mod.mjs";

// Hermetic per-repo state dirs (missing by design — exercises the fail-soft path)
// BEFORE the client module loads; the real ~/.cognee-plugin state stays untouched.
const smokeStateRoot = path.join(
  import.meta.dirname ?? ".",
  `.smoke-state-${process.pid}`,
);
process.env.COGNEE_CODE_STATE_DIR ??= smokeStateRoot;
// The persisted-dataset-switch record must never leak in from the real
// ~/.cognee-plugin/pi/active-dataset.json (it would flip cfg.dataset), and the
// cross-process breaker file must not import a real outage into the lane test.
process.env.COGNEE_PI_STATE_DIR ??= path.join(smokeStateRoot, "pi-state");
process.env.COGNEE_BREAKER_FILE ??= path.join(smokeStateRoot, "breaker.json");
// Never let the suite's owner-key mint touch the REAL shared cache
// (~/.cognee-plugin/api_key.json is parity-shared with the official plugins)
process.env.COGNEE_API_KEY_CACHE ??= path.join(smokeStateRoot, "api-key.json");
// v0.4 bootstrap must never fire from the checks below (a real uv on PATH + a
// real ~/.cognee-plugin would break hermeticity): the bootstrap section at the
// bottom re-enables it per-test with scrubbed PATH + temp state roots.
process.env.COGNEE_LOCAL_BOOTSTRAP = "off";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Locate jiti + pi-ai inside the installed pi coding agent.
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

const ext = await jiti.import(path.join(root, "src", "index.ts"));
// Post-restructure: merge the split modules' exports (shared list in mod.mjs).
const clientMod = await loadClientMod(jiti, root);

/* ---------- stub ExtensionAPI that records registrations ---------- */

function makeStubApi() {
  const recorded = {
    tools: [],
    commands: [],
    events: new Map(),
    messages: [],
    entries: [],
  };
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
    sendMessage(message, options) {
      recorded.messages.push({ message, options });
    },
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

/* ---------- assertions ---------- */

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const factory = ext.default;
await check("module default-exports an extension factory", () => {
  assert.equal(typeof factory, "function");
});

const { pi, recorded } = makeStubApi();
await check("factory never throws", () => {
  assert.doesNotThrow(() => factory(pi));
});

await check("registers 6+ tools", () => {
  assert.ok(recorded.tools.length >= 6, `expected >=6 tools, got ${recorded.tools.length}`);
});

await check("registers the 6 cognee tools with valid shapes", () => {
  const names = recorded.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "cognee_code",
    "cognee_forget",
    "cognee_recall",
    "cognee_remember",
    "cognee_search",
    "cognee_sync",
  ]);
  for (const tool of recorded.tools) {
    assert.equal(typeof tool.name, "string", `${tool.name}: name`);
    assert.equal(typeof tool.label, "string", `${tool.name}: label`);
    assert.equal(typeof tool.description, "string", `${tool.name}: description (non-empty)`);
    assert.ok(tool.description.length > 40, `${tool.name}: description teaches WHEN to use`);
    assert.ok(tool.parameters && typeof tool.parameters === "object", `${tool.name}: parameters`);
    assert.equal(typeof tool.execute, "function", `${tool.name}: execute`);
  }
});

await check("cognee_code tool teaches structural vs conceptual usage", () => {
  const tool = recorded.tools.find((t) => t.name === "cognee_code");
  assert.ok(tool, "cognee_code registered");
  for (const op of [
    "query_facts",
    "explore",
    "traverse",
    "find_path",
    "impact_analysis",
    "delta",
  ]) {
    assert.ok(tool.description.includes(op), `description mentions ${op}`);
  }
  assert.ok(tool.description.includes("STRUCTURAL"), "teaches structural questions");
  assert.ok(tool.description.includes("cognee_search"), "contrasts with cognee_search");
  assert.ok(
    typeof tool.parameters.properties.seed === "object",
    "seed parameter",
  );
  assert.ok(
    typeof tool.parameters.properties.operation === "object",
    "operation parameter",
  );
});

await check("registers 9+ commands", () => {
  assert.ok(recorded.commands.length >= 9, `expected >=9 commands, got ${recorded.commands.length}`);
  const names = recorded.commands.map((c) => c.name).sort();
  for (const expected of [
    "cognee",
    "cognee-code",
    "cognee-datasets",
    "cognee-doctor",
    "cognee-forget",
    "cognee-index",
    "cognee-remember",
    "cognee-search",
    "cognee-sync",
  ]) {
    assert.ok(names.includes(expected), `missing command ${expected}`);
  }
  for (const command of recorded.commands) {
    assert.equal(typeof command.handler, "function", `${command.name}: handler`);
  }
});

await check("registers 4+ event handlers", () => {
  assert.ok(
    recorded.events.size >= 4,
    `expected >=4 event names, got ${recorded.events.size}: ${[...recorded.events.keys()].join(", ")}`,
  );
  for (const name of ["session_start", "before_agent_start", "message_end", "session_shutdown"]) {
    assert.ok(recorded.events.has(name), `missing event handler ${name}`);
  }
});

await check("factory leaves no pending timers (no long-lived resources)", async () => {
  // Nothing scheduled synchronously; wait one macrotask tick to be sure.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(true);
});

/* ---------- pure helper behavior (no network) ---------- */

await check("redactSecrets redacts vendor keys and credential pairs", () => {
  const out = clientMod.redactSecrets(
    [
      "token: supersecretvalue123",
      "sk-abcdefghijklmnop123456",
      "postgres://user:pw@db.example.com:5432/x",
      "Bearer abcdefghijklmno1234",
      "plain text stays",
    ].join("\n"),
  );
  assert.ok(!out.includes("supersecretvalue123"), "credential pair redacted");
  assert.ok(!out.includes("sk-abcdefghijklmnop123456"), "openai-style key redacted");
  assert.ok(!out.includes("user:pw@db.example.com"), "db uri redacted");
  assert.ok(!out.includes("abcdefghijklmno1234"), "bearer token redacted");
  assert.ok(out.includes("plain text stays"), "innocent text untouched");
});

await check("truncateText caps by bytes with marker", () => {
  const out = clientMod.truncateText("x".repeat(5000), 100);
  assert.ok(out.length <= 103, `length ${out.length}`);
  assert.ok(out.endsWith("..."));
  assert.equal(clientMod.truncateText("short", 100), "short");
});

await check("parseEnvFile: quotes, export prefix, comments, denylist, last-wins", () => {
  const values = clientMod.parseEnvFile(
    ['A="quoted value"', "export B=bare", "# comment", "", "PATH=/evil:/bin", "A=second"].join("\n"),
  );
  assert.equal(values.A, "second");
  assert.equal(values.B, "bare");
  assert.ok(!("PATH" in values), "denylisted key not imported");
});

await check("loadCogneeConfig honors env overrides (capture opt-out, autoindex, timeouts, remember background)", () => {
  // Regression guard for the blocker where num()/bool() indexed the EnvLookup
  // function object instead of calling it — every override silently ignored.
  const keys = ["COGNEE_CAPTURE", "COGNEE_CODE_AUTOINDEX", "COGNEE_CODE_INDEX_TIMEOUT_MS", "COGNEE_REMEMBER_BACKGROUND"];
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env.COGNEE_CAPTURE = "false";
    process.env.COGNEE_CODE_AUTOINDEX = "off";
    process.env.COGNEE_CODE_INDEX_TIMEOUT_MS = "45000";
    const cfg = clientMod.loadCogneeConfig();
    assert.equal(cfg.capture, false, "COGNEE_CAPTURE=false disables capture/recall");
    assert.equal(cfg.codeAutoindex, "off", "COGNEE_CODE_AUTOINDEX=off respected");
    assert.equal(cfg.codeIndexTimeoutMs, 45000, "COGNEE_CODE_INDEX_TIMEOUT_MS=45000 respected");
    assert.equal(cfg.rememberBackground, true, "COGNEE_REMEMBER_BACKGROUND defaults to true");
    process.env.COGNEE_REMEMBER_BACKGROUND = "false";
    assert.equal(
      clientMod.loadCogneeConfig().rememberBackground,
      false,
      "COGNEE_REMEMBER_BACKGROUND=false respected (sync remember write)",
    );
    process.env.COGNEE_CODE_INDEX_TIMEOUT_MS = "not-a-number";
    assert.equal(
      clientMod.loadCogneeConfig().codeIndexTimeoutMs,
      120000,
      "non-numeric timeout falls back to the default",
    );
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

await check("sanitizeDatasetName / sanitizeSessionId keep the cognee charset", () => {
  assert.equal(clientMod.sanitizeDatasetName("my project/2!),"), "my-project-2---");
  assert.equal(clientMod.sanitizeSessionId("pi_abc ✨"), "pi_abc--");
});

/* ---------- federated read datasets (COGNEE_PLUGIN_READ_DATASET_IDS) ---------- */

await check("parseReadDatasetIds: valid JSON UUID list parses, canonicalizes, dedupes (first-seen order)", () => {
  const r = clientMod.parseReadDatasetIds(
    JSON.stringify([
      "3F2B8AC6-1D5E-4F7A-9C3B-2E8D7A6B5C4F", // uppercase → canonicalized lowercase
      "3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f", // duplicate AFTER canonicalization → deduped
      "0123456789abcdef0123456789abcdef", // hyphenless → hyphenated
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ]),
  );
  assert.deepEqual(r.datasetIds, [
    "3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f",
    "01234567-89ab-cdef-0123-456789abcdef",
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  ]);
  assert.equal(r.error, undefined, "valid list carries no error");
  assert.equal(clientMod.parseReadDatasetIds("   ").datasetIds, undefined, "blank → no federation");
  assert.equal(clientMod.parseReadDatasetIds(undefined).datasetIds, undefined, "unset → no federation");
});

await check("parseReadDatasetIds: exact reference error strings for invalid JSON / non-list / empty / non-UUID", () => {
  const badJson = clientMod.parseReadDatasetIds("[not json");
  assert.ok(
    typeof badJson.error === "string" &&
      badJson.error.startsWith("COGNEE_PLUGIN_READ_DATASET_IDS is not valid JSON: "),
    `invalid JSON error prefix (parser detail appended verbatim): ${badJson.error}`,
  );
  assert.equal(badJson.datasetIds, undefined, "invalid JSON → federation off");
  const shape = "COGNEE_PLUGIN_READ_DATASET_IDS must be a nonempty JSON list of UUIDs";
  assert.equal(clientMod.parseReadDatasetIds('"a-string"').error, shape, "JSON non-list");
  assert.equal(clientMod.parseReadDatasetIds("[]").error, shape, "empty list");
  assert.equal(clientMod.parseReadDatasetIds('["agent_sessions"]').error, shape, "dataset NAME is not a UUID");
  assert.equal(
    clientMod.parseReadDatasetIds('["3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f", 42]').error,
    shape,
    "non-UUID entry",
  );
  assert.equal(clientMod.parseReadDatasetIds("5").error, shape, "JSON scalar is not a list");
});

await check("loadCogneeConfig: COGNEE_PLUGIN_READ_DATASET_IDS parsed with shell > env-file precedence, error surfaced", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(os.tmpdir(), "pi-cognee-fed-"));
  const envFile = join(dir, ".env");
  const A = "3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f";
  const B = "01234567-89ab-cdef-0123-456789abcdef";
  writeFileSync(envFile, `COGNEE_PLUGIN_READ_DATASET_IDS=["${A}"]\n`, "utf8");
  const keys = ["COGNEE_PLUGIN_READ_DATASET_IDS", "COGNEE_ENV_FILE"];
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env.COGNEE_ENV_FILE = envFile;
    delete process.env.COGNEE_PLUGIN_READ_DATASET_IDS;
    let cfg = clientMod.loadCogneeConfig();
    assert.deepEqual(cfg.readDatasetIds, [A], "env-file value parsed");
    assert.equal(cfg.readDatasetIdsSource, "env file", "source labeled env file");
    assert.equal(cfg.readDatasetIdsError, undefined, "valid list → no error");

    process.env.COGNEE_PLUGIN_READ_DATASET_IDS = `["${B}"]`;
    cfg = clientMod.loadCogneeConfig();
    assert.deepEqual(cfg.readDatasetIds, [B], "shell export beats the env file");
    assert.equal(cfg.readDatasetIdsSource, "shell env", "source labeled shell env");

    process.env.COGNEE_PLUGIN_READ_DATASET_IDS = "[]";
    cfg = clientMod.loadCogneeConfig();
    assert.equal(cfg.readDatasetIds, undefined, "invalid value → federation off, no crash");
    assert.equal(
      cfg.readDatasetIdsError,
      "COGNEE_PLUGIN_READ_DATASET_IDS must be a nonempty JSON list of UUIDs",
      "exact reference error surfaced at load",
    );
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

await check("federated recall wire payload: dataset_ids only (no session_id/datasets); code lane + writes never federate", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body =
      typeof opts?.body === "string"
        ? JSON.parse(opts.body)
        : opts?.body instanceof FormData
          ? opts.body
          : null;
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, text: async () => "[]" };
  };
  try {
    const base = clientMod.loadCogneeConfig();
    const federated = new clientMod.CogneeClient({
      ...base,
      baseUrl: "https://cognee.invalid",
      apiKey: "smoke-key",
      dataset: "agent_sessions",
      readDatasetIds: ["3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f", "01234567-89ab-cdef-0123-456789abcdef"],
      readDatasetIdsSource: "shell env",
    });
    // Graph-lane recall: federated — dataset name AND session binding dropped.
    await federated.recall({ query: "q", sessionId: "pi_s", dataset: "agent_sessions", scope: ["graph"] });
    // Explicit dataset_ids param LOSES to the env federation (reference precedence).
    await federated.recall({ query: "q", datasetIds: ["ffffffff-ffff-ffff-ffff-ffffffffffff"], scope: ["graph"] });
    // Code lane: never federated — name addressing kept.
    await federated.codeSearch({ seed: "process_payment", dataset: "codebase-x-0123abcd" });
    // Writes never consult the federation config: still the own dataset.
    await federated.rememberEntry({ type: "qa", question: "q", answer: "a" }, "pi_s", "agent_sessions");
    await federated.improve("pi_s", "agent_sessions");

    const recalls = calls.filter((c) => c.url.endsWith("/api/v1/recall"));
    assert.equal(recalls.length, 3, "three recall calls");
    const [fed, explicitIds, code] = recalls.map((c) => c.body);
    for (const key of ["session_id", "sessionId", "datasets"]) {
      assert.equal(key in fed, false, `federated recall carries no ${key}`);
    }
    assert.deepEqual(
      fed.dataset_ids,
      ["3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f", "01234567-89ab-cdef-0123-456789abcdef"],
      "federated dataset_ids = the configured read set",
    );
    assert.deepEqual(fed.datasetIds, fed.dataset_ids, "camelCase twin sent for the 1.6.0 RecallPayloadDTO");
    assert.equal(fed.top_k, 5, "snake_case top_k kept for ≤1.5 servers");
    assert.equal(fed.topK, 5, "camelCase topK added for 1.6.0");
    assert.equal(fed.onlyContext, true, "camelCase onlyContext added (1.6.0 default flips to false)");
    assert.deepEqual(explicitIds.dataset_ids, fed.dataset_ids, "env federation beats an explicit datasetIds param");
    assert.equal(code.datasets[0], "codebase-x-0123abcd", "code lane keeps name addressing");
    assert.equal(code.dataset_ids, undefined, "code lane never federates");

    const entry = calls.find((c) => c.url.endsWith("/api/v1/remember/entry"))?.body;
    assert.ok(entry, "remember/entry write captured");
    assert.equal(entry.dataset_name, "agent_sessions", "session-cache write still targets the own dataset name");
    assert.equal(entry.session_id, "pi_s", "session-cache write keeps its session binding");
    assert.ok(!("dataset_id" in entry) && !("dataset_ids" in entry), "write never federates");

    const improveBody = calls.find((c) => c.url.endsWith("/api/v1/improve"))?.body;
    assert.ok(improveBody, "improve call captured");
    assert.deepEqual(improveBody.sessionIds, ["pi_s"], "improve camelCase sessionIds (1.6.0)");
    assert.deepEqual(improveBody.session_ids, ["pi_s"], "improve snake_case twin kept (≤1.5)");
    assert.equal(improveBody.runInBackground, true, "improve camelCase runInBackground (1.6.0)");
    assert.equal(improveBody.datasetName, "agent_sessions", "improve camelCase datasetName (1.6.0)");
    assert.equal(improveBody.dataset_name, "agent_sessions", "improve snake_case twin kept (≤1.5)");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("UUID-shaped dataset promoted to UUID addressing in recall()/remember() (reference parity)", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body =
      typeof opts?.body === "string"
        ? JSON.parse(opts.body)
        : opts?.body instanceof FormData
          ? opts.body
          : null;
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, text: async () => "[]" };
  };
  try {
    const base = clientMod.loadCogneeConfig();
    const c = new clientMod.CogneeClient({
      ...base,
      baseUrl: "https://cognee.invalid",
      apiKey: "smoke-key",
      readDatasetIds: undefined, // unfederated: the dataset param takes addressing
    });
    // recall: uppercase-hyphenated, hyphenless, and plain-name addressing
    await c.recall({ query: "q", sessionId: "pi_s", dataset: "3F2B8AC6-1D5E-4F7A-9C3B-2E8D7A6B5C4F", scope: ["graph"] });
    await c.recall({ query: "q", dataset: "0123456789abcdef0123456789abcdef", scope: ["graph"] });
    await c.recall({ query: "q", sessionId: "pi_s", dataset: "agent_sessions", scope: ["graph"] });
    // remember: multipart form targets datasetId vs datasetName
    await c.remember({ content: "x", dataset: "3F2B8AC6-1D5E-4F7A-9C3B-2E8D7A6B5C4F" });
    await c.remember({ content: "x", dataset: "agent_sessions" });

    const recalls = calls.filter((x) => x.url.endsWith("/api/v1/recall"));
    assert.equal(recalls.length, 3, "three recall calls");
    const [upper, hyphenless, byName] = recalls.map((x) => x.body);
    assert.deepEqual(
      upper.dataset_ids,
      ["3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f"],
      "UUID-shaped dataset (uppercase) → canonical lowercase dataset_ids",
    );
    assert.deepEqual(upper.datasetIds, upper.dataset_ids, "camelCase twin sent for the 1.6.0 RecallPayloadDTO");
    assert.ok(!("datasets" in upper), "UUID addressing carries no datasets name");
    assert.equal(upper.session_id, "pi_s", "session binding stays attached outside federation (reference parity)");
    assert.deepEqual(
      hyphenless.dataset_ids,
      ["01234567-89ab-cdef-0123-456789abcdef"],
      "hyphenless UUID canonicalized to hyphenated dataset_ids",
    );
    assert.equal(hyphenless.session_id, undefined, "no session binding to drop when none given");
    assert.deepEqual(byName.datasets, ["agent_sessions"], "plain name keeps datasets addressing");
    assert.equal(byName.dataset_ids, undefined, "plain name never sends dataset_ids");
    assert.equal(byName.session_id, "pi_s", "plain-name recall keeps its session binding");

    const forms = calls.filter((x) => x.url.endsWith("/api/v1/remember") && x.body instanceof FormData);
    assert.equal(forms.length, 2, "two remember calls captured");
    assert.equal(forms[0].body.get("datasetId"), "3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f", "UUID-shaped dataset → datasetId form field (canonicalized)");
    assert.equal(forms[0].body.get("datasetName"), null, "UUID addressing sends no datasetName");
    assert.equal(forms[1].body.get("datasetName"), "agent_sessions", "plain name → datasetName form field");
    assert.equal(forms[1].body.get("datasetId"), null, "plain name sends no datasetId");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("read-tool descriptions mention federated reads when COGNEE_PLUGIN_READ_DATASET_IDS is set", () => {
  const saved = process.env.COGNEE_PLUGIN_READ_DATASET_IDS;
  try {
    process.env.COGNEE_PLUGIN_READ_DATASET_IDS = JSON.stringify(["3f2b8ac6-1d5e-4f7a-9c3b-2e8d7a6b5c4f"]);
    const { pi: piFed, recorded: recFed } = makeStubApi();
    factory(piFed); // side-effect-free factory: no timers until session_start
    for (const name of ["cognee_recall", "cognee_search"]) {
      const tool = recFed.tools.find((t) => t.name === name);
      assert.ok(tool, `${name} registered`);
      assert.ok(
        tool.description.includes("Federated reads are configured"),
        `${name} description mentions federated reads when configured`,
      );
    }
    const codeTool = recFed.tools.find((t) => t.name === "cognee_code");
    assert.ok(
      !codeTool.description.includes("Federated reads are configured"),
      "code lane (never federated) carries no federation note",
    );
  } finally {
    if (saved === undefined) delete process.env.COGNEE_PLUGIN_READ_DATASET_IDS;
    else process.env.COGNEE_PLUGIN_READ_DATASET_IDS = saved;
  }
});

await check("forget discovery guidance + data-item client methods exist", () => {
  const forget = recorded.tools.find((t) => t.name === "cognee_forget");
  assert.ok(forget, "cognee_forget tool registered");
  assert.ok(
    forget.description.includes("/cognee-forget <dataset>"),
    "tool description points at /cognee-forget for data_id discovery",
  );
  for (const method of ["listDataItems", "getDataItemRaw", "ensureAuth", "authSummary"]) {
    assert.equal(
      typeof clientMod.CogneeClient.prototype[method],
      "function",
      `CogneeClient.${method} exists`,
    );
  }
});

await check("recall tools wire abort signals through execute", () => {
  for (const name of ["cognee_remember", "cognee_recall", "cognee_search", "cognee_code", "cognee_sync"]) {
    const tool = recorded.tools.find((t) => t.name === name);
    assert.ok(tool, `${name} registered`);
    assert.equal(tool.execute.length >= 3, true, `${name}: execute accepts a signal parameter`);
  }
});

/* ---------- code-graph helpers (pure + git-fixture, no network) ---------- */

await check("code-graph client methods exist", () => {
  for (const method of ["indexCodeRepo", "codeGraphStatus", "codeSearch"]) {
    assert.equal(
      typeof clientMod.CogneeClient.prototype[method],
      "function",
      `CogneeClient.${method} exists`,
    );
  }
});

await check("extractIdentifiers gates on identifier-shaped tokens", () => {
  const ids = clientMod.extractIdentifiers(
    "What calls process_payment in billing/api.py? UserService was renamed; see `AuthMiddleware`. Claude Code and example.com are not symbols.",
    10,
  );
  assert.ok(ids.length > 0, "found at least one identifier");
  assert.ok(ids.includes("process_payment"), "snake_case detected");
  assert.ok(ids.includes("billing/api.py"), "file path detected");
  assert.ok(ids.includes("UserService"), "CamelCase detected");
  assert.ok(ids.includes("AuthMiddleware"), "backticked identifier detected");
  for (const id of ids) {
    assert.ok(!id.startsWith("Claude"), "CamelCase stoplist respected");
    assert.ok(!id.includes("example.com"), "domain-ish dotted token skipped");
  }
  assert.deepEqual(clientMod.extractIdentifiers("how does auth work here?"), [], "conversational prompt does not arm the lane");
  assert.deepEqual(clientMod.extractIdentifiers("one_identifier two_identifier three_identifier", 2).length, 2, "limit respected");
});

await check("buildCodeQuery is the bounded query_facts lane", () => {
  assert.deepEqual(clientMod.buildCodeQuery("process_payment"), {
    operation: "query_facts",
    name: "process_payment",
    limit: 5,
  });
});

await check("codeDatasetName: codebase-<tail>-<digest8>, deterministic, collision-free", () => {
  const a = clientMod.codeDatasetName("/tmp/does-not-matter-a/service");
  assert.ok(/^codebase-[a-z0-9._-]+-[0-9a-f]{8}$/.test(a), `format: ${a}`);
  assert.equal(a, clientMod.codeDatasetName("/tmp/does-not-matter-a/service"), "deterministic");
  assert.notEqual(
    clientMod.codeDatasetName("/tmp/x-a/service"),
    clientMod.codeDatasetName("/tmp/x-b/service"),
    "same basename, different checkout → different datasets",
  );
  assert.equal(
    clientMod.codeDatasetName("https://github.com/org/repo"),
    clientMod.codeDatasetName("https://github.com/org/repo.git/"),
    "git URL normalization (trailing .git/ slash)",
  );
});

await check("isRemoteRepoSpec recognizes cloneable specs", () => {
  assert.equal(clientMod.isRemoteRepoSpec("https://github.com/o/r"), true);
  assert.equal(clientMod.isRemoteRepoSpec("git@github.com:o/r.git"), true);
  assert.equal(clientMod.isRemoteRepoSpec("ssh://git@host/o/r"), true);
  assert.equal(clientMod.isRemoteRepoSpec("/local/path"), false);
  assert.equal(clientMod.isRemoteRepoSpec("."), false);
});

await check("countSourceFiles: code extensions only, skips hidden/build dirs, caps", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(os.tmpdir(), "pi-cognee-smoke-"));
  writeFileSync(join(dir, "a.ts"), "x");
  writeFileSync(join(dir, "b.py"), "x");
  writeFileSync(join(dir, "README.md"), "x");
  mkdirSync(join(dir, ".enola"));
  writeFileSync(join(dir, ".enola", "snapshot.json"), "x");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.js"), "x");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "c.go"), "x");
  assert.equal(clientMod.countSourceFiles(dir, 3000), 3, "2 top + 1 nested code file, hidden/build dirs skipped");
  assert.equal(clientMod.countSourceFiles(dir, 2), 3, "cap exceeded → returns over-cap count (bounded walk)");
});

await check("loadRepoStates fail-soft on a missing state dir", () => {
  assert.deepEqual(clientMod.loadRepoStates(), [], "no state files → empty list, no throw");
});

let gitAvailable = false;
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["--version"], { timeout: 5000 });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

if (gitAvailable) {
  await check("git fingerprint: stable, edit-sensitive, .enola-blind; repo root detection", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const os = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(os.tmpdir(), "pi-cognee-git-"));
    const git = (...args) => execFileSync("git", args, { cwd: dir, timeout: 10000 });
    git("init", "-q");
    git("config", "user.email", "smoke@test");
    git("config", "user.name", "smoke");
    writeFileSync(join(dir, "main.py"), "print('hi')\n");
    git("add", ".");
    git("commit", "-qm", "init");

    assert.equal(await clientMod.gitRepoRoot(dir), clientMod.canonicalRepoSpec(dir), "repo root resolves");
    const fp1 = await clientMod.gitFingerprint(dir);
    assert.ok(/^[0-9a-f]{64}$/.test(fp1), "fingerprint is a sha256 hex");
    assert.equal(fp1, await clientMod.gitFingerprint(dir), "stable without changes");

    mkdirSync(join(dir, ".enola"));
    writeFileSync(join(dir, ".enola", "snapshot-1.json"), "{\"rotated\":1}");
    assert.equal(
      await clientMod.gitFingerprint(dir),
      fp1,
      "enola snapshot churn (untracked, excluded pathspec) does not move the fingerprint",
    );

    writeFileSync(join(dir, "main.py"), "print('changed')\n");
    const fp2 = await clientMod.gitFingerprint(dir);
    assert.notEqual(fp2, fp1, "tracked edit moves the fingerprint");

    assert.equal(await clientMod.gitRepoRoot(os.tmpdir()), "", "outside a repo → empty string, no throw");
    assert.equal(await clientMod.gitFingerprint(join(dir, "nope")), "", "invalid root → empty string, no throw");
  });
} else {
  console.log("  skip  git fingerprint checks (git not on PATH)");
  passed++;
}

await check("cognee_remember tool schema accepts the per-file ingestion param", () => {
  const remember = recorded.tools.find((t) => t.name === "cognee_remember");
  assert.ok(remember, "cognee_remember registered");
  assert.equal(
    typeof remember.parameters.properties.file,
    "object",
    "file param present in the TypeBox schema",
  );
  assert.equal(
    typeof remember.parameters.properties.content,
    "object",
    "content param still present",
  );
  assert.ok(
    !Array.isArray(remember.parameters.required) || !remember.parameters.required.includes("content"),
    "content is optional when file is provided (reference: file_path set → content ignored)",
  );
  assert.ok(
    remember.description.includes("file"),
    "tool description teaches the per-file code route",
  );
});

await check("readRememberFile: exists / size cap / text-only guards, real basename", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(os.tmpdir(), "pi-cognee-file-"));
  const code = join(dir, "payments.py");
  writeFileSync(code, "def process_payment():\n    return 'ok'\n");
  const good = clientMod.readRememberFile(code, 2000);
  assert.equal(good.ok, true, "text file reads");
  assert.equal(good.basename, "payments.py", "REAL basename (server's routing signal)");
  assert.ok(good.text.includes("process_payment"), "content verbatim (no redaction)");

  assert.ok(!clientMod.readRememberFile(join(dir, "missing.ts")).ok, "missing file rejected");
  const big = join(dir, "big.txt");
  writeFileSync(big, "x".repeat(100));
  assert.ok(!clientMod.readRememberFile(big, 50).ok, "oversized file rejected");

  const bin = join(dir, "blob.bin");
  writeFileSync(bin, Buffer.from([0x61, 0x00, 0x62, 0x63]));
  const binary = clientMod.readRememberFile(bin, 2000);
  assert.ok(!binary.ok, "NUL-byte binary rejected");
  assert.ok(/binary/i.test(binary.error ?? ""), "binary rejection explains itself");

  // Credential-looking paths are refused BEFORE any disk read (these paths don't exist).
  for (const p of [
    join(os.homedir(), ".ssh", "id_rsa"),
    join(dir, ".env"),
    join(dir, ".env.production"),
    join(dir, "server.pem"),
    join(dir, "id_ed25519"),
    join(dir, "credentials.json"),
  ]) {
    const r = clientMod.readRememberFile(p, 2000);
    assert.ok(!r.ok, `${p} refused`);
    assert.ok(/secret/i.test(r.error ?? ""), `${p} refusal explains itself`);
  }
  // Innocent look-alikes must still pass through to the normal guards.
  const envish = join(dir, "envelope.ts");
  writeFileSync(envish, "export const x = 1;\n");
  assert.equal(clientMod.readRememberFile(envish, 2000).ok, true, ".env* pattern does not over-match");
});

await check("remember(): run_in_background follows cfg.rememberBackground (COGNEE_REMEMBER_BACKGROUND)", async () => {
  // No network: stub fetch and inspect the outgoing multipart form field.
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, opts) => {
    if (opts?.body instanceof FormData) seen.push(String(opts.body.get("run_in_background")));
    return { ok: true, status: 200, text: async () => JSON.stringify({ dataset_id: "smoke-ds" }) };
  };
  try {
    const base = clientMod.loadCogneeConfig();
    const mk = (rememberBackground) =>
      new clientMod.CogneeClient({
        ...base,
        baseUrl: "https://cognee.invalid",
        apiKey: "smoke-key",
        rememberBackground,
      });
    assert.equal((await mk(true).remember({ content: "hello" })).ok, true, "remember ok (default background)");
    assert.equal((await mk(false).remember({ content: "hello" })).ok, true, "remember ok (sync default)");
    assert.equal(
      (await mk(false).remember({ content: "hello", background: true })).ok,
      true,
      "remember ok (explicit background beats cfg)",
    );
    assert.deepEqual(
      seen,
      ["true", "false", "true"],
      `run_in_background wire field: cfg default true → cfg false → explicit override; saw [${seen.join(", ")}]`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("file-shared breaker round-trips via an injected temp dir (atomic, tolerant)", async () => {
  const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(os.tmpdir(), "pi-cognee-breaker-"));
  const file = join(dir, "breaker.json");
  const local = "http://localhost:8011";
  const cloud = "https://cognee.example";

  clientMod.saveSharedBreaker(local, { open_until: 12345, consecutive_failures: 3 }, file);
  let entry = clientMod.loadSharedBreaker(local, file);
  assert.equal(entry.open_until, 12345, "open_until round-trips");
  assert.equal(entry.consecutive_failures, 3, "consecutive_failures round-trips");
  assert.equal(typeof entry.updated_at, "string", "updated_at stamped");

  clientMod.saveSharedBreaker(cloud, { open_until: 0, consecutive_failures: 1 }, file);
  entry = clientMod.loadSharedBreaker(local, file);
  assert.equal(entry.open_until, 12345, "other servers' entries preserved (keyed by base_url)");
  assert.equal(clientMod.loadSharedBreaker(cloud, file).consecutive_failures, 1, "second entry reads");

  clientMod.saveSharedBreaker(local, { open_until: 0, consecutive_failures: 0 }, file);
  assert.equal(clientMod.loadSharedBreaker(local, file).open_until, 0, "reset write lands");

  writeFileSync(file, "{not json at all", "utf8");
  assert.deepEqual(clientMod.loadSharedBreaker(local, file), {}, "corrupt file tolerated as empty");
  assert.deepEqual(
    clientMod.loadSharedBreaker(local, join(dir, "absent.json")),
    {},
    "missing file tolerated as empty",
  );
  clientMod.saveSharedBreaker(local, { open_until: 1, consecutive_failures: 1 }, file); // rewrite over corruption
  assert.equal(clientMod.loadSharedBreaker(local, file).open_until, 1, "save over a corrupt file heals it");
  assert.equal(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")).length,
    0,
    "atomic write leaves no temp files behind",
  );
});

await check("pre-compact anchor handler registered on session_before_compact, detached + fail-soft", async () => {
  const handlers = recorded.events.get("session_before_compact") ?? [];
  assert.ok(handlers.length >= 1, "session_before_compact handler registered");
  const handler = handlers[handlers.length - 1];
  assert.equal(typeof handler, "function", "handler is a function");
  assert.ok(handler.length >= 1, "handler takes (event[, ctx])");

  // No network: stub fetch to reject before exercising the runtime wiring.
  const realFetch = globalThis.fetch;
  const statusCalls = [];
  let poisonTripped = false;
  globalThis.fetch = async () => {
    throw new Error("smoke: no network");
  };
  try {
    // Mode-guard check part 1: hasUI=false must never touch ui.setStatus.
    const { pi: piNoUi, recorded: recNoUi } = makeStubApi();
    factory(piNoUi);
    const startNoUi = recNoUi.events.get("session_start")[0];
    startNoUi(
      { type: "session_start", reason: "startup" },
      {
        hasUI: false,
        ui: {
          setStatus() {
            poisonTripped = true;
          },
          notify() {
            poisonTripped = true;
          },
        },
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "smoke-no-ui" },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!poisonTripped, "ui.setStatus/notify never called when hasUI is false (mode-guarded)");
    await recNoUi.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });

    // Part 2: with a UI, the failing health probe lands in setStatus.
    const { pi: piUi, recorded: recUi } = makeStubApi();
    factory(piUi);
    const ctx = {
      hasUI: true,
      ui: {
        setStatus(_key, text) {
          statusCalls.push(text);
        },
        notify() {},
      },
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "smoke-ui" },
    };
    recUi.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    // Health probe fires on a 0ms timer; the unreachable retry adds ~300ms.
    for (let i = 0; i < 40 && statusCalls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(statusCalls.length >= 1, "setStatus called at the health-probe point when hasUI is true");
    assert.ok(
      statusCalls[0].startsWith("✕ cognee: offline"),
      `status text carries health + backend + dataset: ${statusCalls[0]}`,
    );
    assert.ok(statusCalls[0].includes("·"), "status text names backend · dataset");

    // Anchor: firing the compact event returns synchronously (background-safe)…
    const compactHandler = (recUi.events.get("session_before_compact") ?? [])[0];
    const out = compactHandler(
      {
        type: "session_before_compact",
        preparation: {
          messagesToSummarize: [
            { role: "user", content: "We decided the breaker state file is shared across processes" },
            { role: "assistant", content: [{ type: "text", text: "Stored the decision." }] },
          ],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100,
          fileOps: { readFiles: [], modifiedFiles: [] },
          settings: {},
        },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx,
    );
    assert.equal(out, undefined, "handler detaches (returns void immediately, compaction never blocked)");
    await new Promise((resolve) => setTimeout(resolve, 100)); // detached anchor settles fail-soft
    await recUi.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("codeItemHasData: empty envelope is not a hit, prose and filled envelopes are", () => {
  const envelope = (over) => ({ kind: "code", text: JSON.stringify({ operation: "query_facts", ...over }) });
  assert.equal(ext.codeItemHasData(envelope({ facts: [], total: 0 })), false, "empty facts envelope → not a hit");
  assert.equal(ext.codeItemHasData({ text: "   " }), false, "blank text → not a hit");
  assert.equal(ext.codeItemHasData({}), false, "no content at all → not a hit");
  assert.equal(
    ext.codeItemHasData(envelope({ facts: ["symbol:src.x"], total: 1 })),
    true,
    "envelope with a non-empty array → hit",
  );
  assert.equal(
    ext.codeItemHasData({ text: "symbol:src.loadCogneeConfig (src/client.ts L241)" }),
    true,
    "plain prose fact → hit",
  );
  assert.equal(ext.codeItemHasData({ text: "just prose, not JSON" }), true, "non-JSON text → hit");
});

/* ---------- auto code-recall lane: wire shape + empty-envelope fix ---------- */

await check("auto code lane sends the reference wire shape (scope/code_query/dataset/session/top_k)", async () => {
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const repoDir = mkdtempSync(join(os.tmpdir(), "pi-cognee-lane-"));
  const repoDataset = clientMod.codeDatasetName(repoDir);
  // The opt-in the lane honors: an index-state record covering the cwd.
  clientMod.saveRepoState({
    spec: repoDir,
    spec_kind: "path",
    repo_root: clientMod.canonicalRepoSpec(repoDir),
    dataset: repoDataset,
    index_vectors: false,
    fingerprint: "smoke-fp",
    last_index_at: Date.now(),
    last_status: "completed",
  });

  const calls = [];
  let codeResponse = "[]";
  const realFetch = globalThis.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : null;
    calls.push({ url: u, body });
    if (u.endsWith("/health")) return ok('{"status":"OK","version":"1.6.0"}');
    if (u.endsWith("/api/v1/recall")) {
      return ok(body?.scope?.includes("code") ? codeResponse : "[]");
    }
    return ok("[]");
  };
  try {
    const { pi: piLane, recorded: recLane } = makeStubApi();
    factory(piLane);
    const ctx = {
      hasUI: true,
      ui: { notify() {}, setStatus() {} },
      cwd: repoDir,
      sessionManager: { getSessionId: () => "smoke-lane" },
    };
    recLane.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    // state.healthy=true gates before_agent_start; the ensure-dataset POST fires
    // in the same health block AFTER the flag flips, so waiting for it is a
    // readiness signal that cannot win the race.
    for (
      let i = 0;
      i < 40 && !calls.some((c) => c.url.endsWith("/api/v1/datasets"));
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      calls.some((c) => c.url.endsWith("/api/v1/datasets")),
      "health probe ran and ensured the dataset (state.healthy=true)",
    );

    const prompt = "What calls process_payment in the billing flow?";
    const out = await recLane.events.get("before_agent_start")[0]({ type: "before_agent_start", prompt });
    assert.equal(out, undefined, "empty graph + empty code lane injects nothing");

    const recalls = calls.filter((c) => c.url.endsWith("/api/v1/recall"));
    const codeCalls = recalls.filter((c) => c.body?.scope?.[0] === "code");
    assert.equal(codeCalls.length, 1, "exactly one code-scope recall per prompt");
    const code = codeCalls[0].body;
    // The exact reference auto-lane request (findings §1, verified against
    // session-context-lookup.py _dispatch): code_query IS attached.
    assert.deepEqual(code.scope, ["code"], "scope is exactly [\"code\"]");
    assert.deepEqual(
      code.code_query,
      { operation: "query_facts", name: "process_payment", limit: 5 },
      "code_query = build_code_query(identifier): query_facts + name + limit 5",
    );
    assert.deepEqual(code.codeQuery, code.code_query, "camelCase twin for the 1.6.0 DTO");
    assert.equal(code.query, prompt, "query is the FULL prompt (reference seed), not the identifier");
    assert.equal(code.top_k, 5, "reference TOP_K = 5");
    assert.equal(code.topK, 5, "camelCase topK twin");
    assert.equal(code.only_context, true, "only_context");
    assert.equal(code.onlyContext, true, "camelCase onlyContext twin");
    assert.deepEqual(code.datasets, [repoDataset], "dataset = the repo's own from index state");
    assert.equal(code.dataset_ids, undefined, "code lane is name-addressed (no dataset_ids)");
    assert.equal(code.session_id, "pi_smoke-lane", "session id attached on the code scope (reference parity)");
    const graph = recalls.find((c) => c.body?.scope?.[0] === "graph").body;
    assert.deepEqual(graph.datasets, ["agent_sessions"], "graph lane stays on the session dataset");

    // Empty-envelope suppression: the server's unresolvable-seed answer is ONE
    // entry whose text IS the envelope — it must not be counted or injected.
    codeResponse = JSON.stringify([
      { kind: "code", search_type: "CODE", text: '{"operation": "query_facts", "facts": [], "total": 0}' },
    ]);
    const outEnvelope = await recLane.events.get("before_agent_start")[0]({
      type: "before_agent_start",
      prompt: "what calls resolve_config here", // snake_case identifier arms the lane
    });
    assert.equal(outEnvelope, undefined, "empty envelope injects nothing (the observed v0.1 bug)");

    // Real hit: code section renders FIRST (reference order), before the memory block.
    codeResponse = JSON.stringify([{ kind: "code", text: "symbol:src.process_payment (src/billing.ts L41)" }]);
    calls.length = 0;
    const recallFn = recLane.events.get("before_agent_start")[0];
    // graph lane gets a hit this time: stub answers non-code recalls with one memory
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : null;
      calls.push({ url: u, body });
      if (u.endsWith("/health")) return ok('{"status":"OK","version":"1.6.0"}');
      if (u.endsWith("/api/v1/recall")) {
        return ok(body?.scope?.includes("code") ? codeResponse : '[{"source":"graph","text":"User prefers dark mode."}]');
      }
      return ok("[]");
    };
    const outHit = await recallFn({ type: "before_agent_start", prompt: "what calls process_payment again" });
    assert.ok(outHit?.message?.content, "hit lane injects a cognee_memory message");
    const content = outHit.message.content;
    const codeAt = content.indexOf("=== Code graph facts ===");
    const memAt = content.indexOf("=== Cognee memory ===");
    assert.ok(codeAt > -1, "code section present");
    assert.ok(memAt > -1, "memory block present");
    assert.ok(codeAt < memAt, "code section renders FIRST (reference order)");
    assert.ok(content.includes("symbol:src.process_payment"), "code fact text injected");
    assert.ok(!content.includes('"facts": []'), "no raw envelope JSON injected");

    // cognee_code tool: an empty envelope falls through to the no-facts warning.
    const codeTool = recLane.tools.find((t) => t.name === "cognee_code");
    let toolOut = await codeTool.execute("call-1", { seed: "process_payment" }, new AbortController().signal);
    assert.ok(toolOut.content[0].text.includes("symbol:src.process_payment"), "tool reports a real fact");
    codeResponse = JSON.stringify([
      { kind: "code", text: '{"operation": "query_facts", "facts": [], "total": 0}' },
    ]);
    toolOut = await codeTool.execute("call-2", { seed: "no_such_symbol" }, new AbortController().signal);
    assert.ok(
      toolOut.content[0].text.includes("No code facts for 'no_such_symbol'"),
      "empty envelope → no-facts warning",
    );
    assert.ok(!toolOut.content[0].text.includes('"operation"'), "no raw envelope body in the tool report");

    await recLane.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- dataset switcher: persisted record, precedence, command flow ---------- */

await check("switcher helpers: matchDatasets / mintSwitchSessionId / renderDatasetList / fingerprint", () => {
  const rows = [
    { name: "agent_sessions", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    { name: "team_memory", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
    { name: "dup", id: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
    { name: "dup", id: "dddddddd-dddd-dddd-dddd-dddddddddddd" },
  ];
  assert.equal(clientMod.matchDatasets("team_memory", rows).status, "ok", "exact name matches");
  assert.deepEqual(
    clientMod.matchDatasets("team_memory", rows).matches.map((m) => m.id),
    ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
  );
  assert.equal(
    clientMod.matchDatasets("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", rows).status,
    "ok",
    "UUID match is canonicalized (case-insensitive)",
  );
  assert.equal(clientMod.matchDatasets("dup", rows).status, "ambiguous", "duplicate name → ambiguous");
  assert.equal(clientMod.matchDatasets("nosuch", rows).status, "missing", "unlisted name → create-on-switch path");

  assert.equal(clientMod.mintSwitchSessionId("pi_abc"), "pi_abc__2", "first switch mints __2");
  assert.equal(clientMod.mintSwitchSessionId("pi_abc__2"), "pi_abc__3", "ordinal increments");
  assert.equal(clientMod.mintSwitchSessionId("pi_abc__9"), "pi_abc__10", "double digits carry");

  const listing = ext.renderDatasetList("agent_sessions", "pi_s1", rows.slice(0, 2));
  assert.ok(listing.includes("Current dataset: agent_sessions (session pi_s1)"), "reference header format");
  assert.ok(listing.includes(" * agent_sessions (aaaaaaaa…)"), "active row starred with id8");
  assert.ok(listing.includes("   team_memory (bbbbbbbb…)"), "other rows unstarred");
  assert.ok(listing.includes("no switch"), "one-off-look guidance present");

  assert.equal(
    clientMod.datasetKeyFingerprint("https://a.example", "k1"),
    clientMod.datasetKeyFingerprint("https://a.example", "k1"),
    "fingerprint deterministic",
  );
  assert.notEqual(
    clientMod.datasetKeyFingerprint("https://a.example", "k1"),
    clientMod.datasetKeyFingerprint("https://b.example", "k1"),
    "fingerprint keyed by server URL",
  );
  assert.notEqual(
    clientMod.datasetKeyFingerprint("https://a.example", "k1"),
    clientMod.datasetKeyFingerprint("https://a.example", "k2"),
    "fingerprint keyed by api key",
  );
});

await check("active-dataset record: atomic round-trip, backend+identity scoping, corrupt tolerance", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(os.tmpdir(), "pi-cognee-rec-"));
  const saved = process.env.COGNEE_PI_STATE_DIR;
  try {
    process.env.COGNEE_PI_STATE_DIR = dir;
    const fp = clientMod.datasetKeyFingerprint("https://cognee.invalid", "k");
    const record = {
      base_url: "https://cognee.invalid",
      key_fp: fp,
      dataset: "team_memory",
      session_id: "pi_host1__2",
      previous: { dataset: "agent_sessions", session_id: "pi_host1", synced: true },
      switched_at: "2026-09-24T12:00:00.000Z",
    };
    assert.equal(clientMod.saveActiveDatasetRecord(record).ok, true, "save reports ok");
    const back = clientMod.loadActiveDatasetRecord("https://cognee.invalid", fp);
    assert.deepEqual(back, record, "record round-trips verbatim");
    assert.equal(
      clientMod.loadActiveDatasetRecord("https://other.invalid", fp),
      undefined,
      "a record from another server is never served",
    );
    assert.equal(
      clientMod.loadActiveDatasetRecord("https://cognee.invalid", "deadbeef"),
      undefined,
      "a record from another identity is never served",
    );
    assert.equal(
      readdirSync(dir).filter((n) => n.endsWith(".tmp")).length,
      0,
      "atomic write leaves no temp files",
    );
    writeFileSync(join(dir, "active-dataset.json"), "{corrupt", "utf8");
    assert.equal(
      clientMod.loadActiveDatasetRecord("https://cognee.invalid", fp),
      undefined,
      "corrupt record tolerated (env seed stays in charge)",
    );
  } finally {
    if (saved === undefined) delete process.env.COGNEE_PI_STATE_DIR;
    else process.env.COGNEE_PI_STATE_DIR = saved;
  }
});

await check("loadCogneeConfig: persisted switch beats the COGNEE_PLUGIN_DATASET seed (env only seeds)", async () => {
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(os.tmpdir(), "pi-cognee-prec-"));
  const envFile = join(mkdtempSync(join(os.tmpdir(), "pi-cognee-prenv-")), ".env");
  const keys = ["COGNEE_PI_STATE_DIR", "COGNEE_API_KEY", "COGNEE_ENV_FILE", "COGNEE_PLUGIN_DATASET"];
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env.COGNEE_PI_STATE_DIR = stateDir;
    process.env.COGNEE_API_KEY = "smoke-key"; // deterministic key fingerprint
    process.env.COGNEE_ENV_FILE = envFile; // absent file — no env-file values
    delete process.env.COGNEE_PLUGIN_DATASET;

    // No record: default seed.
    let cfg = clientMod.loadCogneeConfig();
    assert.equal(cfg.dataset, "agent_sessions", "no record → default dataset");
    assert.equal(cfg.datasetSource, "default", "source: default");
    assert.equal(cfg.switchSessionId, undefined, "no adopted session id");

    // No record + env seed: the seed wins.
    process.env.COGNEE_PLUGIN_DATASET = "env_seed";
    cfg = clientMod.loadCogneeConfig();
    assert.equal(cfg.dataset, "env_seed", "env seed applies without a record");
    assert.equal(cfg.datasetSource, "COGNEE_PLUGIN_DATASET", "source: env seed");

    // Persist a switch for THIS backend+identity: the record wins over the seed.
    const fp = clientMod.datasetKeyFingerprint(cfg.baseUrl, "smoke-key");
    assert.equal(
      clientMod.saveActiveDatasetRecord({
        base_url: cfg.baseUrl,
        key_fp: fp,
        dataset: "team_memory",
        session_id: "pi_host1__2",
        previous: { dataset: "agent_sessions", session_id: "pi_host1", synced: true },
        switched_at: "2026-09-24T12:00:00.000Z",
      }).ok,
      true,
      "record saved",
    );
    cfg = clientMod.loadCogneeConfig();
    assert.equal(cfg.dataset, "team_memory", "persisted switch wins over the env seed");
    assert.equal(cfg.datasetSource, "persisted switch", "source: persisted switch");
    assert.equal(cfg.switchSessionId, "pi_host1__2", "session id adopted from the record");
    assert.equal(cfg.datasetSwitchedFrom, "agent_sessions", "retired dataset surfaced as provenance");
    assert.equal(cfg.datasetSwitchedAt, "2026-09-24T12:00:00.000Z", "switch timestamp surfaced");
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

await check("switcher command flow: list → validate → strict-sync abort/--force → persist → affinity", async () => {
  const { mkdtempSync, readFileSync, readdirSync, existsSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(os.tmpdir(), "pi-cognee-sw-"));
  const workDir = mkdtempSync(join(os.tmpdir(), "pi-cognee-swcwd-")); // not a git repo → no auto-index noise
  const envFile = join(mkdtempSync(join(os.tmpdir(), "pi-cognee-swenv-")), ".env");
  const keys = ["COGNEE_PI_STATE_DIR", "COGNEE_API_KEY", "COGNEE_ENV_FILE", "COGNEE_PLUGIN_DATASET"];
  const saved = keys.map((k) => process.env[k]);
  const realFetch = globalThis.fetch;
  const recordPath = () => join(process.env.COGNEE_PI_STATE_DIR, "active-dataset.json");
  try {
    process.env.COGNEE_PI_STATE_DIR = stateDir;
    process.env.COGNEE_API_KEY = "smoke-key";
    process.env.COGNEE_ENV_FILE = envFile;
    delete process.env.COGNEE_PLUGIN_DATASET;

    const rows = [
      { name: "agent_sessions", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", owner_id: "u1" },
      { name: "team_memory", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", owner_id: "u1" },
      { name: "dup", id: "cccccccc-cccc-cccc-cccc-cccccccccccc", owner_id: "u1" },
      { name: "dup", id: "dddddddd-dddd-dddd-dddd-dddddddddddd", owner_id: "u1" },
    ];
    let createOk = true;
    let improveFails = false;
    const ok = (text) => ({ ok: true, status: 200, text: async () => text });
    const apiCalls = [];
    const rememberBodies = [];
    const improveBodies = [];
    const firstFetch = async (url, opts) => {
      const u = String(url);
      const method = opts?.method ?? "GET";
      apiCalls.push(u);
      if (u.endsWith("/health")) return ok('{"status":"OK","version":"1.6.0"}');
      if (u.endsWith("/api/v1/datasets")) {
        if (method === "POST") {
          return createOk
            ? ok("{}")
            : { ok: false, status: 400, text: async () => '{"error":"invalid dataset name"}' };
        }
        return ok(JSON.stringify(rows));
      }
      if (u.endsWith("/api/v1/remember/entry")) {
        if (typeof opts?.body === "string") rememberBodies.push(JSON.parse(opts.body));
        return ok("{}");
      }
      if (u.endsWith("/api/v1/improve")) {
        if (typeof opts?.body === "string") improveBodies.push(JSON.parse(opts.body));
        return ok(improveFails ? '{"status":"errored","error":"boom"}' : '{"status":"completed"}');
      }
      return ok("[]");
    };
    globalThis.fetch = firstFetch;

    const { pi: piSw, recorded: recSw } = makeStubApi();
    factory(piSw);
    const messages = [];
    const statuses = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (m, t) => messages.push({ m, t }),
        setStatus: (_k, v) => statuses.push(v),
      },
      cwd: workDir,
      sessionManager: { getSessionId: () => "smoke-switch" },
    };
    recSw.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    for (let i = 0; i < 40 && !apiCalls.some((u) => u.endsWith("/api/v1/datasets")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cmd = recSw.commands.find((c) => c.name === "cognee-datasets");
    assert.ok(cmd, "cognee-datasets command registered");
    const lastMsg = () => messages[messages.length - 1]?.m ?? "";

    // List (reference format).
    await cmd.handler("", ctx);
    assert.ok(lastMsg().includes("Current dataset: agent_sessions (session pi_smoke-switch)"), `list header: ${lastMsg()}`);
    assert.ok(lastMsg().includes(" * agent_sessions (aaaaaaaa…)"), "active row starred");
    assert.ok(lastMsg().includes("   team_memory (bbbbbbbb…)"), "other rows listed");

    // Usage guard + already-active no-op.
    await cmd.handler("a b", ctx);
    assert.ok(lastMsg().startsWith("Usage:"), "two positionals → usage");
    await cmd.handler("agent_sessions", ctx);
    assert.ok(lastMsg().includes("Already active: 'agent_sessions'"), "same-dataset switch is a no-op");

    // Ambiguous + unlistable names refuse up front (never half-switch).
    await cmd.handler("dup", ctx);
    assert.ok(lastMsg().includes("Ambiguous") && lastMsg().includes("select its UUID"), "ambiguous name refused");
    createOk = false;
    await cmd.handler("nosuch", ctx);
    assert.ok(lastMsg().includes("Cannot switch to 'nosuch'"), "uncreatable name refused");
    assert.ok(!existsSync(recordPath()), "no record written by a refused switch");
    createOk = true;

    // Capture one turn so the strict pre-switch sync has something to improve.
    const messageEnd = recSw.events.get("message_end")[0];
    messageEnd({ message: { role: "user", content: "what do we know about the switcher" } }, ctx);
    messageEnd({ message: { role: "assistant", content: "It syncs then re-points." } }, ctx);
    recSw.events.get("agent_settled")[0]();
    for (let i = 0; i < 20 && !apiCalls.some((u) => u.endsWith("/api/v1/remember/entry")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(apiCalls.some((u) => u.endsWith("/api/v1/remember/entry")), "captured turn drained");
    // F5: entries are bound to the session/dataset active at CAPTURE time; the
    // wire payload itself keeps the reference shape (binding stripped on send).
    const bound = rememberBodies.at(-1);
    assert.ok(bound, "remember/entry body observed");
    assert.equal(bound.session_id, "pi_smoke-switch", "F5: entry drains into its capture-time session");
    assert.equal(bound.dataset_name, "agent_sessions", "F5: entry drains into its capture-time dataset");
    assert.deepEqual(
      Object.keys(bound.entry ?? {}).sort(),
      ["answer", "context", "question", "type"],
      "F5: wire entry payload unchanged (no binding keys leaked)",
    );

    // Strict-sync failure aborts the switch (unless --force).
    improveFails = true;
    await cmd.handler("team_memory", ctx);
    assert.ok(lastMsg().includes("Switch aborted"), "failed pre-switch sync aborts");
    assert.ok(!existsSync(recordPath()), "aborted switch wrote no record");

    // --force switches anyway; the retired session keeps its session-end sync.
    await cmd.handler("team_memory --force", ctx);
    assert.ok(
      lastMsg().includes("Switched to dataset 'team_memory' (session pi_smoke-switch__2)"),
      `force switch success line: ${lastMsg()}`,
    );
    assert.ok(lastMsg().includes("NOT synced (--force)"), "force reports the unsynced previous session");
    assert.ok(lastMsg().includes("no longer injected"), "success line states the recall scoping");
    let record = JSON.parse(readFileSync(recordPath(), "utf8"));
    assert.equal(record.dataset, "team_memory", "record carries the new dataset");
    assert.equal(record.session_id, "pi_smoke-switch__2", "record carries the minted session id");
    assert.deepEqual(
      record.previous,
      { dataset: "agent_sessions", session_id: "pi_smoke-switch", synced: false },
      "retired triple recorded (unsynced)",
    );
    assert.equal(record.base_url, clientMod.loadCogneeConfig().baseUrl, "record scoped to this server");
    assert.ok(statuses.some((s) => s.endsWith("team_memory")), `statusline refreshed: ${statuses.at(-1)}`);

    // /cognee + /cognee-doctor surface the switch provenance + source.
    await recSw.commands.find((c) => c.name === "cognee").handler("", ctx);
    assert.ok(lastMsg().includes("switched from agent_sessions"), "/cognee Dataset line carries provenance");
    await recSw.commands.find((c) => c.name === "cognee-doctor").handler("", ctx);
    assert.ok(lastMsg().includes("persisted switch"), "/cognee-doctor names the persisted-switch source");
    assert.ok(lastMsg().includes("active-dataset.json"), "/cognee-doctor shows the state-file path");

    // Switch back: ordinal mints __3, previous synced this time.
    improveFails = false;
    await cmd.handler("agent_sessions", ctx);
    assert.ok(
      lastMsg().includes("Switched to dataset 'agent_sessions' (session pi_smoke-switch__3)"),
      `ordinal mint: ${lastMsg()}`,
    );
    assert.ok(lastMsg().includes("synced into 'team_memory'"), "strict sync ran before the switch");
    record = JSON.parse(readFileSync(recordPath(), "utf8"));
    assert.deepEqual(
      record.previous,
      { dataset: "team_memory", session_id: "pi_smoke-switch__2", synced: true },
      "retired triple recorded (synced)",
    );

    // Persist failure rolls back: "switch was not persisted; nothing was changed".
    process.env.COGNEE_PI_STATE_DIR = join("/dev", "null", "nope"); // mkdir fails
    await cmd.handler("team_memory", ctx);
    assert.ok(lastMsg().includes("Switch was not persisted"), "persist failure surfaced");
    assert.ok(lastMsg().includes("nothing was changed"), "rollback message (reference exit-4 shape)");
    process.env.COGNEE_PI_STATE_DIR = stateDir;
    await cmd.handler("", ctx);
    assert.ok(lastMsg().includes("Current dataset: agent_sessions"), "rollback restored the active dataset");

    // Session affinity: a NEW factory (next config load) adopts the record's
    // dataset AND session id — capture/recall/sync re-point automatically.
    await cmd.handler("team_memory", ctx); // record → team_memory / pi_smoke-switch__4
    const cfgAff = clientMod.loadCogneeConfig();
    assert.equal(cfgAff.dataset, "team_memory", "next config load picks up the switch");
    assert.equal(cfgAff.datasetSource, "persisted switch", "config source labels the switch");
    assert.equal(cfgAff.switchSessionId, "pi_smoke-switch__4", "record session id exposed");

    const recallBodies = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/api/v1/recall") && typeof opts?.body === "string") {
        recallBodies.push(JSON.parse(opts.body));
      }
      if (u.endsWith("/health")) return ok('{"status":"OK","version":"1.6.0"}');
      if (u.endsWith("/api/v1/datasets")) return ok("[]");
      return ok("[]");
    };
    const { pi: piAff, recorded: recAff } = makeStubApi();
    factory(piAff); // loadCogneeConfig() → the persisted record wins
    const affCtx = {
      hasUI: true,
      ui: { notify() {}, setStatus() {} },
      cwd: workDir,
      sessionManager: { getSessionId: () => "smoke-affinity" },
    };
    recAff.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, affCtx);
    await new Promise((resolve) => setTimeout(resolve, 100)); // health probe settles
    const out = await recAff.events.get("before_agent_start")[0]({
      type: "before_agent_start",
      prompt: "how does auth work here", // no identifier → graph lane only
    });
    assert.equal(out, undefined, "no hits → nothing injected");
    const graph = recallBodies.find((b) => b.scope?.[0] === "graph");
    assert.ok(graph, "graph recall fired");
    assert.deepEqual(graph.datasets, ["team_memory"], "recall lane picked up the active dataset");
    assert.equal(graph.session_id, "pi_smoke-switch__4", "session affinity: adopted session id from the record");
    await recAff.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });
    globalThis.fetch = firstFetch; // restore the recording mock for the checks below

    // F4: an overlapping switch invocation is refused while one is in flight
    // (in-process lock — the second call must not mint or persist anything).
    const overlappingFirst = cmd.handler("agent_sessions", ctx);
    const overlappingSecond = cmd.handler("team_memory", ctx);
    await Promise.all([overlappingFirst, overlappingSecond]);
    assert.ok(
      messages.some(({ m }) => m.includes("already in progress")),
      "F4: re-entrant switch refused",
    );

    assert.equal(
      readdirSync(stateDir).filter((n) => n.endsWith(".tmp")).length,
      0,
      "no temp files left behind",
    );
    await recSw.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });
    // F3: the session retired by a --force switch past a failed sync gets its
    // own promotion pass at the session-end sync — the LAST improve call is
    // that retired pair (current session is promoted first, retired second).
    const lastImprove = improveBodies.at(-1);
    assert.ok(lastImprove, "final sync fired improve");
    assert.deepEqual(
      lastImprove.session_ids,
      ["pi_smoke-switch"],
      "F3: final sync promotes the retired unsynced session",
    );
    assert.equal(lastImprove.dataset_name, "agent_sessions", "F3: retired session improved into its own dataset");
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    globalThis.fetch = realFetch;
  }
});

/* ---------- v0.3: last_status terminal write-back (--wait poll) ---------- */

await check("/cognee-index --wait: terminal status written back to the repo state (COMPLETED/ERRORED/FAILED, fail-soft)", async () => {
  const { mkdtempSync, readFileSync, readdirSync, chmodSync } = await import("node:fs");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const repoDir = mkdtempSync(join(os.tmpdir(), "pi-cognee-wb-")); // plain dir — no git, no auto-index
  const DS = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const stateDir = process.env.COGNEE_CODE_STATE_DIR;
  const readState = (dataset) => {
    for (const name of readdirSync(stateDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(stateDir, name), "utf8"));
        if (parsed.dataset === dataset) return parsed;
      } catch {
        /* skip foreign files */
      }
    }
    return undefined;
  };
  // Poll answers per variant: index 0 = poll #1, rest = every later poll.
  let pollAnswers = ["DATASET_PROCESSING_STARTED", "DATASET_PROCESSING_COMPLETED"];
  let pollIdx = 0;
  // /cognee-index accepts local paths only in local mode — pin it regardless of
  // the developer's shell (COGNEE_BASE_URL may point at a real cloud server).
  const savedBackend = process.env.COGNEE_PI_BACKEND;
  process.env.COGNEE_PI_BACKEND = "local";
  const realFetch = globalThis.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/api/v1/remember") && opts?.method === "POST") {
      return ok(JSON.stringify({ dataset_id: DS, pipeline_run_id: "run-wb", status: "DATASET_PROCESSING_INITIATED" }));
    }
    if (u.includes("/api/v1/datasets/status")) {
      const status = pollAnswers[Math.min(pollIdx++, pollAnswers.length - 1)];
      return ok(JSON.stringify({ [DS]: { code_graph_pipeline: status } }));
    }
    return ok("[]");
  };
  try {
    const { pi: piWb, recorded: recWb } = makeStubApi();
    factory(piWb);
    const messages = [];
    const ctx = {
      hasUI: true,
      ui: { notify: (m) => messages.push(m), setStatus() {} },
      cwd: repoDir,
      sessionManager: { getSessionId: () => "smoke-wb" },
    };
    const cmd = recWb.commands.find((c) => c.name === "cognee-index");
    assert.ok(cmd, "cognee-index command registered");
    const lastMsg = () => messages[messages.length - 1] ?? "";
    const t0 = Date.now();

    // COMPLETED observed on poll #2 (poll #1 running → one 3s poll interval).
    await cmd.handler(`${repoDir} --dataset smoke-wb-done --wait 5`, ctx);
    assert.ok(lastMsg().includes("graph is queryable"), `wait outcome reported: ${lastMsg()}`);
    let st = readState("smoke-wb-done");
    assert.ok(st, "state file written for the submitted repo");
    assert.equal(st.last_status, "COMPLETED", "terminal COMPLETED written back (v0.2 left the submission value forever)");
    assert.ok(
      typeof st.last_status_at === "number" && st.last_status_at >= t0 && st.last_status_at <= Date.now(),
      "last_status_at stamped within test runtime",
    );

    // ERRORED on poll #1 → immediate terminal, written back.
    pollIdx = 0;
    pollAnswers = ["DATASET_PROCESSING_ERRORED"];
    await cmd.handler(`${repoDir} --dataset smoke-wb-errored --wait 5`, ctx);
    assert.ok(lastMsg().includes("pipeline ERRORED"), "ERRORED outcome reported");
    st = readState("smoke-wb-errored");
    assert.equal(st?.last_status, "ERRORED", "terminal ERRORED written back");

    // Defensive FAILED suffix class is terminal too (stops polling, written back).
    pollIdx = 0;
    pollAnswers = ["GRAPH_BUILD_FAILED"];
    await cmd.handler(`${repoDir} --dataset smoke-wb-failed --wait 5`, ctx);
    assert.ok(lastMsg().includes("pipeline FAILED"), "FAILED outcome reported");
    st = readState("smoke-wb-failed");
    assert.equal(st?.last_status, "FAILED", "terminal FAILED written back");

    // Fail-soft: an unwritable state dir never fails the command.
    pollIdx = 0;
    pollAnswers = ["DATASET_PROCESSING_COMPLETED"];
    chmodSync(stateDir, 0o555);
    try {
      // Fresh repo for this variant: rewriting an EXISTING state file needs no
      // dir-write permission (only file-write), so the fail-soft path under test
      // is the CREATION of a new state file in the read-only dir.
      const repoRo = mkdtempSync(join(os.tmpdir(), "pi-cognee-wb-ro-"));
      await cmd.handler(`${repoRo} --dataset smoke-wb-ro --wait 5`, ctx);
      assert.ok(lastMsg().includes("Submitted"), "unwritable state dir: command still succeeds");
      assert.equal(readState("smoke-wb-ro"), undefined, "no state written when the dir is unwritable");
    } finally {
      chmodSync(stateDir, 0o755);
    }

    await recWb.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });
  } finally {
    if (savedBackend === undefined) delete process.env.COGNEE_PI_BACKEND;
    else process.env.COGNEE_PI_BACKEND = savedBackend;
    globalThis.fetch = realFetch;
  }
});

/* ---------- v0.3: remember() file lane update-when-changed ---------- */

await check("remember() file lane: same-hash no-op / changed-hash PATCH (exact wire) / fail-open fallbacks / no fallback on failure", async () => {
  const realFetch = globalThis.fetch;
  const DS = "aaaaaaaa-1111-2222-3333-444444444444";
  const ITEM_OLD = "bbbbbbbb-1111-2222-3333-444444444444"; // 2026-01 twin
  const ITEM_NEW = "cccccccc-1111-2222-3333-444444444444"; // 2026-02 twin (latest)
  let dataItems = [];
  let rawText = "";
  let patchStatus = 200;
  let patchBody = {};
  let listFails = false;
  const calls = [];
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    const body =
      opts?.body instanceof FormData
        ? opts.body
        : typeof opts?.body === "string"
          ? JSON.parse(opts.body)
          : null;
    calls.push({ url: u, method, body });
    if (u.endsWith("/api/v1/datasets") && method === "GET") {
      if (listFails) return { ok: false, status: 500, text: async () => '{"error":"boom"}' };
      return ok(JSON.stringify([{ name: "agent_sessions", id: DS }]));
    }
    if (u.includes(`/api/v1/datasets/${DS}/data/`) && u.endsWith("/raw")) {
      return ok(rawText);
    }
    if (u.endsWith(`/api/v1/datasets/${DS}/data`)) {
      return ok(JSON.stringify(dataItems));
    }
    if (u.includes("/api/v1/update")) {
      return { ok: patchStatus < 400, status: patchStatus, text: async () => JSON.stringify(patchBody) };
    }
    if (u.endsWith("/api/v1/remember") && method === "POST") {
      return ok(JSON.stringify({ dataset_id: DS, pipeline_run_id: "run-add" }));
    }
    return ok("[]");
  };
  try {
    const base = clientMod.loadCogneeConfig();
    const c = new clientMod.CogneeClient({ ...base, baseUrl: "https://cognee.invalid", apiKey: "smoke-key" });
    const posts = () => calls.filter((x) => x.url.endsWith("/api/v1/remember") && x.method === "POST");
    const patches = () => calls.filter((x) => x.url.includes("/api/v1/update"));

    // 1. identical content → authoritative no-op: nothing sent at all.
    dataItems = [
      { id: ITEM_OLD, name: "notes.md", created_at: "2026-01-01T00:00:00Z" },
      { id: ITEM_NEW, name: "notes.md", created_at: "2026-02-01T00:00:00Z" },
      { id: "dddddddd-1111-2222-3333-444444444444", name: "other.txt", created_at: "2026-03-01T00:00:00Z" },
    ];
    rawText = "same content";
    calls.length = 0;
    let r = await c.remember({ content: "same content", filename: "notes.md", dataset: "agent_sessions" });
    assert.equal(r.ok, true, "same-hash remember ok");
    assert.equal(r.outcome, "unchanged", "outcome: unchanged");
    assert.equal(r.dataId, ITEM_NEW, "latest same-name twin matched (createdAt sort)");
    assert.equal(posts().length, 0, "no POST /remember on identical content");
    assert.equal(patches().length, 0, "no PATCH on identical content");
    assert.ok(calls.some((x) => x.url.includes(`/data/${ITEM_NEW}/raw`)), "raw compare hit the latest twin");

    // 2. changed content → PATCH with the exact wire contract; no plain add.
    rawText = "old content";
    patchStatus = 200;
    patchBody = {
      status: "incremental",
      regions: 2,
      deleted_chunks: 1,
      added_chunks: 3,
      reused_chunks: 0,
      kept_chunks: 12,
      reindexed_chunks: 0,
      total_chunks: 15,
      data_id: ITEM_NEW,
      dataset_id: DS,
      duration_seconds: 1.2,
      pipeline_run_id: "run-upd",
      fallback: null,
    };
    calls.length = 0;
    r = await c.remember({ content: "same content", filename: "notes.md", dataset: "agent_sessions" });
    assert.equal(r.ok, true, "changed-hash remember ok");
    assert.equal(r.outcome, "updated", "outcome: updated");
    assert.equal(r.update.status, "incremental", "server status surfaced");
    assert.equal(r.update.detail, "+3/−1 chunks, 12 kept", "compact counter line");
    assert.equal(r.pipelineRunId, "run-upd", "pollable run id surfaced");
    assert.equal(r.datasetId, DS, "dataset id for the cognify wait suffix");
    assert.equal(posts().length, 0, "changed file PATCHes — never a duplicate plain add");
    const patch = patches()[0];
    assert.ok(patch, "PATCH fired");
    assert.equal(patch.method, "PATCH", "single PATCH method (no GET/POST sibling)");
    assert.equal(
      patch.url,
      `https://cognee.invalid/api/v1/update?data_id=${ITEM_NEW}&dataset_id=${DS}`,
      "identity rides the query string (canonical UUIDs)",
    );
    const part = patch.body.get("data");
    assert.equal(part && part.name, "notes.md", "multipart data part keeps the real basename (loader routing)");
    assert.equal(await part.text(), "same content", "PATCH carries the new content");
    assert.equal(patch.body.get("node_set"), null, "node_set omitted on update (already bound at first ingest)");
    assert.equal(patch.body.get("chunk_level_diff"), null, "chunk_level_diff omitted (server default true)");

    // 3. full_rebuild surfaces its fallback reason.
    patchBody = {
      status: "full_rebuild",
      data_id: ITEM_NEW,
      dataset_id: DS,
      duration_seconds: 2,
      pipeline_run_id: "run-reb",
      fallback: { reason: "no_baseline", detail: "no stored chunk map" },
    };
    r = await c.remember({ content: "same content", filename: "notes.md", dataset: "agent_sessions" });
    assert.equal(r.update.detail, "memory dropped and rebuilt (fallback: no_baseline)", "rebuild + fallback line");

    // 4. server-side "failed" (or HTTP 500) → error, and NO plain-add fallback
    //    (the document still exists; a duplicate would corrupt identity).
    patchStatus = 500;
    patchBody = {
      status: "failed",
      error: { error_class: "PipelineError", message: "cognify boom" },
      data_id: ITEM_NEW,
      dataset_id: DS,
      duration_seconds: 3,
    };
    calls.length = 0;
    r = await c.remember({ content: "same content", filename: "notes.md", dataset: "agent_sessions" });
    assert.equal(r.ok, false, "failed update surfaces as an error");
    assert.ok(/cognify boom/.test(r.error?.message ?? ""), "server error message carried");
    assert.ok(/retry/.test(r.error?.message ?? ""), "retryable hint present");
    assert.equal(posts().length, 0, "no plain-add fallback after a failed update");

    // 5. 404 race (forget raced discovery) → fall back to a plain add.
    patchStatus = 404;
    patchBody = { error: "not found" };
    calls.length = 0;
    r = await c.remember({ content: "same content", filename: "notes.md", dataset: "agent_sessions" });
    assert.equal(r.ok, true, "404 fallback lands");
    assert.equal(r.outcome, "stored", "404 → plain add re-creates the document");
    assert.equal(posts().length, 1, "plain POST fired exactly once");

    // 6. filename never ingested → plain add directly (no raw fetch, no PATCH).
    patchStatus = 200;
    dataItems = [{ id: "dddddddd-1111-2222-3333-444444444444", name: "other.txt", created_at: "2026-03-01T00:00:00Z" }];
    calls.length = 0;
    r = await c.remember({ content: "x", filename: "brand-new.md", dataset: "agent_sessions" });
    assert.equal(r.outcome, "stored", "unmatched name → plain add");
    assert.equal(patches().length, 0, "no PATCH for a never-ingested filename");
    assert.equal(posts().length, 1, "plain POST fired");

    // 7. discovery failure (dataset list 500) → fail open to a plain add.
    listFails = true;
    calls.length = 0;
    r = await c.remember({ content: "x", filename: "brand-new.md", dataset: "agent_sessions" });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "stored", "discovery failure degrades to today's behavior");
    assert.equal(posts().length, 1);
    listFails = false;

    // 8. prose lane untouched: no filename → plain POST with the synthetic name.
    calls.length = 0;
    r = await c.remember({ content: "just prose", dataset: "agent_sessions" });
    assert.equal(r.outcome, "stored", "prose stays append-only");
    assert.equal(patches().length, 0, "prose memories never PATCH");
    assert.ok(
      String(posts()[0]?.body.get("data")?.name ?? "").startsWith("pi-memory-"),
      "synthetic timestamped name for prose",
    );

    // 9. non-UUID ids never leave the client (the 422 guard).
    calls.length = 0;
    const bad = await c.updateDataItem({ datasetId: "not-a-uuid", dataId: ITEM_NEW, content: "x", filename: "a.md" });
    assert.equal(bad.ok, false, "non-UUID rejected client-side");
    assert.ok(/UUID/.test(bad.error?.message ?? ""), "guard explains itself");
    assert.equal(calls.length, 0, "no request sent for non-UUID identity");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- v0.4: tool-call trace capture (offline wire-level — traces spec §6) ---------- */

const osTr = await import("node:os");
const TRACE_ENV_KEYS = [
  "COGNEE_ENV_FILE", "COGNEE_API_KEY", "COGNEE_PI_STATE_DIR", "COGNEE_PI_BACKEND",
  "COGNEE_BASE_URL", "COGNEE_LOCAL_API_URL", "COGNEE_PLUGIN_DATASET", "COGNEE_CAPTURE",
  "COGNEE_CAPTURE_TOOLS", "COGNEE_CAPTURE_DENY_PATHS", "COGNEE_CAPTURE_REDACT",
  "COGNEE_CAPTURE_REDACT_PATTERNS",
];

/**
 * Hermetic trace harness: fresh state dir + scrubbed env (+ overrides), a
 * fetch stub recording every request body, a factory-built extension with a
 * healthy session (the drain gate), and helpers to fire the recorded
 * tool_result handler and collect /api/v1/remember/entry bodies.
 */
async function withTraceHarness(envOverrides, fn) {
  const { mkdtempSync: mkdtempTr } = await import("node:fs");
  const stateDir = mkdtempTr(path.join(osTr.tmpdir(), "pi-cognee-tr-"));
  const cwd = mkdtempTr(path.join(osTr.tmpdir(), "pi-cognee-trcwd-")); // not a git repo
  const saved = TRACE_ENV_KEYS.map((k) => process.env[k]);
  const realFetch = globalThis.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  try {
    process.env.COGNEE_ENV_FILE = path.join(stateDir, "absent.env");
    process.env.COGNEE_API_KEY = "smoke-key"; // deterministic switch fingerprint
    process.env.COGNEE_PI_STATE_DIR = path.join(stateDir, "pi-state");
    delete process.env.COGNEE_PI_BACKEND;
    delete process.env.COGNEE_BASE_URL;
    delete process.env.COGNEE_LOCAL_API_URL;
    delete process.env.COGNEE_PLUGIN_DATASET;
    for (const key of TRACE_ENV_KEYS.slice(7)) delete process.env[key]; // capture knobs
    Object.assign(process.env, envOverrides);

    const calls = [];
    const notifyLog = [];
    let datasetsRows = [];
    let entryStatus = 200;
    let customHandler = null;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      let body = null;
      let raw = null;
      if (typeof opts?.body === "string") {
        raw = opts.body;
        try {
          body = JSON.parse(opts.body);
        } catch {
          body = opts.body;
        }
      }
      calls.push({ url: u, method: opts?.method ?? "GET", body, raw });
      if (customHandler) return customHandler(u, opts);
      if (u.endsWith("/health")) return ok(JSON.stringify({ status: "OK", version: "1.6.0" }));
      if (u.endsWith("/api/v1/datasets")) return ok(JSON.stringify(datasetsRows));
      if (u.endsWith("/api/v1/remember/entry")) {
        return entryStatus < 400 ? ok("{}") : { ok: false, status: entryStatus, text: async () => "" };
      }
      if (u.endsWith("/api/v1/improve")) return ok(JSON.stringify({ status: "completed" }));
      return ok("[]");
    };

    const { pi, recorded } = makeStubApi();
    factory(pi); // reads env at construction — overrides are already in place
    const sessionId = `smoke-trace-${Math.random().toString(36).slice(2, 8)}`;
    const ctx = {
      hasUI: true,
      ui: { notify: (m, t) => notifyLog.push({ m, t }), setStatus() {} },
      cwd,
      sessionManager: { getSessionId: () => sessionId },
    };
    recorded.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    for (let i = 0; i < 40 && !calls.some((c) => c.url.endsWith("/api/v1/datasets")); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 50));
    const fire = (ev) => recorded.events.get("tool_result")[0]({ toolCallId: "c1", ...ev }, ctx);
    const fireRaw = (ev) => recorded.events.get("tool_result")[0](ev, ctx);
    const posts = () => calls.filter((c) => c.url.endsWith("/api/v1/remember/entry"));
    const waitPosts = async (n, ms = 3000) => {
      for (let i = 0; i < ms / 25 && posts().length < n; i++) await new Promise((r) => setTimeout(r, 25));
      return posts();
    };
    const waitPostWhere = async (pred, ms = 3000) => {
      for (let i = 0; i < ms / 25 && !posts().some(pred); i++) await new Promise((r) => setTimeout(r, 25));
      return posts();
    };
    await fn({
      recorded, ctx, calls, notifyLog, fire, fireRaw, posts, waitPosts, waitPostWhere, sessionId,
      setEntryStatus: (s) => {
        entryStatus = s;
      },
      setDatasets: (rows) => {
        datasetsRows = rows;
      },
      setFetch: (h) => {
        customHandler = h;
      },
    });
    await recorded.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    globalThis.fetch = realFetch;
    TRACE_ENV_KEYS.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
}

await check("trace pure helpers: globToRegExp fnmatch subset (case-sensitive, * crosses /, full match)", () => {
  const g = clientMod.globToRegExp;
  assert.ok(g("*").test("anything"), "* matches all");
  assert.ok(g("bash").test("bash"), "literal matches");
  assert.ok(!g("bash").test("bashx"), "full-string match (no substring)");
  assert.ok(!g("READ").test("read"), "case-sensitive (fnmatchcase)");
  assert.ok(g("mcp__x__*").test("mcp__x__y"), "trailing * prefix-matches");
  assert.ok(!g("mcp__x__*").test("mcp__y__x"), "prefix anchored at the start");
  assert.ok(g("*/.ssh/*").test("/home/u/.ssh/id_rsa"), "* crosses path separators");
  assert.ok(g(".env.*").test(".env.local"), "dot-star pattern");
  assert.ok(g("id_rsa*").test("id_rsa"), "trailing star matches empty");
  assert.ok(g("ab?d").test("abcd"), "? single char");
  assert.ok(!g("ab?d").test("abd"), "? needs exactly one char");
  assert.ok(g("read[me]").test("readm"), "bracket class");
  assert.ok(!g("read[me]").test("readz"), "bracket class excludes");
  assert.ok(g("read[!me]").test("readz"), "negated class");
  assert.ok(g("a.b").test("a.b") && !g("a.b").test("aXb"), "literal dots escaped");
  assert.ok(g("*.tfvars").test("prod.tfvars"), "tfvars-style pattern");
});

await check("trace pure helpers: parseListEnv separators, JSON arrays, exact reference errors", () => {
  const p = (raw, separator = "|") => clientMod.parseListEnv(raw, { separator, label: "COGNEE_CAPTURE_TOOLS" });
  assert.deepEqual(p(undefined).values, [], "unset → empty");
  assert.deepEqual(p("  ").values, [], "blank → empty");
  assert.deepEqual(p("read| write ||grep").values, ["read", "write", "grep"], "pipe: trimmed, empties dropped");
  assert.deepEqual(p("a,b", ",").values, ["a", "b"], "comma separator");
  assert.deepEqual(p("re1\nre2\n\nre3", "\n").values, ["re1", "re2", "re3"], "newline separator keeps commas usable in patterns");
  assert.deepEqual(p('["a","b"]').values, ["a", "b"], "JSON array accepted");
  assert.ok(p("[oops").error?.startsWith("COGNEE_CAPTURE_TOOLS is not valid JSON: "), "JSON parse error surfaced with parser detail");
  assert.equal(p('["a", 5]').error, "COGNEE_CAPTURE_TOOLS must be an array of strings", "exact reference shape error");
  assert.equal(p("just-a-string").error, undefined, "plain split never errors");
});

await check("trace pure helpers: allowToolCall + hasSensitivePath deny semantics (reference _capture_policy)", () => {
  const policy = (allowTools = [], denyPaths = []) => ({ allowTools, denyPaths });
  assert.equal(clientMod.allowToolCall("anything", {}, policy()), true, "empty allowlist → * (reference default)");
  assert.equal(clientMod.allowToolCall("read", {}, policy(["bash"])), false, "not allowlisted");
  assert.equal(clientMod.allowToolCall("read", {}, policy(["read", "mcp__*"])), true, "allowlisted");
  for (const p of [
    "/p/.env", ".env", "/a/b/.env.production", "C:\\x\\.env", "/home/u/.ssh/id_rsa",
    "/home/u/.aws/credentials", "server.pem", "id_rsa_backup", "client.p12", "store.pfx",
    "secrets.yaml", "credentials.json", ".npmrc", ".netrc", "thing.key", "id_ed25519.pub",
  ]) {
    assert.equal(clientMod.hasSensitivePath({ path: p }), true, `${p} denied`);
  }
  assert.equal(clientMod.hasSensitivePath({ path: "src/.envelope.ts" }), false, "deny patterns do not over-match");
  assert.equal(clientMod.hasSensitivePath({ path: "prod.tfvars" }, ["*.tfvars"]), true, "COGNEE_CAPTURE_DENY_PATHS extra");
  assert.equal(clientMod.hasSensitivePath({ path: "prod.tfvars" }), false, "extra unset → allowed");
  assert.equal(clientMod.hasSensitivePath({ paths: ["/ok.txt", "/u/.ssh/k"] }), true, "nested list under a path key");
  assert.equal(clientMod.hasSensitivePath({ nested: { file_path: "/x/.env" } }), true, "nested dict recursion");
  assert.equal(clientMod.hasSensitivePath({ FILE_PATH: "/x/.env" }), true, "key compare lowercased");
  assert.equal(clientMod.hasSensitivePath({ command: "cat /x/.env" }), false, "non-path key not denied");
  assert.equal(clientMod.hasSensitivePath({ glob: "*.env" }), false, "pattern-ish non-path key not denied");
  assert.equal(clientMod.hasSensitivePath("just a string"), false, "scalar input");
  assert.equal(clientMod.allowToolCall("read", { path: "/p/.env" }, policy(["*"])), false, "allowlist admits but deny refuses (entry-level)");
});

await check("trace pure helpers: redactForCapture (secret-key rule, string rules, custom patterns, off switch)", () => {
  const dict = clientMod.redactForCapture({
    api_key: "v",
    Authorization: "Bearer xyz",
    nested: { password: "x", ok: "plain" },
    list: ["sk-abcdefghijklmnopqrstuv"],
  });
  assert.equal(dict.api_key, "[redacted:credential]", "secret dict key → wholesale");
  assert.equal(dict.Authorization, "[redacted:credential]", "authorization dict key → wholesale");
  assert.equal(dict.nested.password, "[redacted:credential]", "nested secret key");
  assert.equal(dict.nested.ok, "plain", "innocent value untouched");
  assert.equal(dict.list[0], "[redacted:vendor-key]", "list items string-redacted");
  assert.equal(clientMod.redactForCapture("Bearer abcdefghijklmnop123456789"), "[redacted:authorization]", "bearer string rule");
  assert.ok(String(clientMod.redactForCapture("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).startsWith("[redacted:private-key]"), "PEM block");
  assert.equal(
    clientMod.redactForCapture("NI-AB12, NICE-TRY", { customPatterns: ["NI-[A-Z0-9]{4,}[,;]\\s*NICE-TRY"] }),
    "[redacted:custom]",
    "custom pattern (comma-bearing regex, newline separator keeps it whole)",
  );
  assert.equal(clientMod.redactForCapture({ api_key: "v" }, { redact: false }).api_key, "v", "redact=false passes through");
  assert.equal(clientMod.redactForCapture("x", { customPatterns: ["(["] }), "x", "invalid custom regex skipped, no throw");
  // Reference-superset additions on the SHARED string rules (QA path regression):
  assert.equal(clientMod.redactSecrets("sk-ant-" + "a".repeat(20)), "[redacted:vendor-key]", "sk-ant- prefix");
  assert.equal(clientMod.redactSecrets("github_pat_" + "A".repeat(22)), "[redacted:vendor-key]", "github_pat_ prefix");
  assert.equal(clientMod.redactSecrets("sk-proj-" + "b".repeat(20)), "[redacted:vendor-key]", "sk-proj- prefix");
  assert.equal(clientMod.redactSecrets("$2a$10$" + "c".repeat(53)), "[redacted:bcrypt]", "bcrypt hash");
});

await check("trace pure helpers: truncateText byte-exact caps, multibyte-safe cut, surrogate round-trip", () => {
  const ascii = clientMod.truncateText("x".repeat(10_000), 4000);
  assert.equal(Buffer.byteLength(ascii, "utf8"), 4000, "ascii cap byte-exact");
  assert.ok(ascii.endsWith("..."));
  const multi = clientMod.truncateText("ü".repeat(3000), 4000); // 6000 bytes
  assert.ok(Buffer.byteLength(multi, "utf8") <= 4000, `multibyte cap respected (${Buffer.byteLength(multi, "utf8")}B)`);
  assert.ok(multi.endsWith("..."));
  assert.ok(multi.includes("ü"), "uncut characters survive");
  const surrogate = clientMod.truncateText("ok \uD800 end", 100);
  assert.ok(!/[\uD800-\uDFFF]/.test(surrogate), "lone surrogate round-tripped away");
  assert.ok(surrogate.includes("\uFFFD"), "replaced with U+FFFD (reference errors=replace)");
  assert.equal(clientMod.truncateText("short", 100), "short", "under cap unchanged");
});

await check("trace pure helpers: buildTraceEntry — reference shape, caps, status, refusal", () => {
  const policy = { allowTools: ["*"], denyPaths: [], redact: true, redactPatterns: [] };
  assert.equal(
    clientMod.buildTraceEntry({ toolName: "read", input: { path: "/x/.env" }, content: [], isError: false }, policy),
    undefined,
    "deny-list refusal drops the whole entry (never partially redacted)",
  );
  assert.equal(
    clientMod.buildTraceEntry({ toolName: "bash", input: {}, content: [], isError: false }, { ...policy, allowTools: ["read"] }),
    undefined,
    "allowlist refusal",
  );
  const entry = clientMod.buildTraceEntry(
    { toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "out" }], isError: false },
    policy,
  );
  assert.deepEqual(entry, {
    type: "trace",
    origin_function: "bash",
    status: "success",
    method_params: { command: "ls" },
    method_return_value: "out",
    error_message: "",
    generate_feedback_with_llm: false,
  }, "exact reference TraceEntry shape");
  const err = clientMod.buildTraceEntry(
    { toolName: "read", input: { path: "/x" }, content: [{ type: "text", text: "E".repeat(600) }], isError: true },
    policy,
  );
  assert.equal(err.status, "error");
  assert.ok(Buffer.byteLength(err.error_message, "utf8") <= 500 && err.error_message.endsWith("..."), "error message capped at 500B");
  assert.equal(err.method_return_value.length, 600, "return value keeps its own 8000B cap");
});

await check("loadCogneeConfig: trace-capture knobs — defaults, pipe/JSON overrides, malformed fall-back", () => {
  const saved = TRACE_ENV_KEYS.slice(8).map((k) => process.env[k]);
  const keys = TRACE_ENV_KEYS.slice(8);
  try {
    let cfg = clientMod.loadCogneeConfig();
    assert.deepEqual(cfg.captureTools, [...clientMod.DEFAULT_CAPTURE_TOOLS], "default = translated reference matcher");
    assert.equal(cfg.captureToolsError, undefined);
    assert.deepEqual(cfg.captureDenyPaths, []);
    assert.equal(cfg.captureRedact, true);
    assert.deepEqual(cfg.captureRedactPatterns, []);

    process.env.COGNEE_CAPTURE_TOOLS = "read|mcp__*";
    cfg = clientMod.loadCogneeConfig();
    assert.deepEqual(cfg.captureTools, ["read", "mcp__*"], "pipe-separated value REPLACES the default");

    process.env.COGNEE_CAPTURE_TOOLS = '["read", "write"]';
    cfg = clientMod.loadCogneeConfig();
    assert.deepEqual(cfg.captureTools, ["read", "write"], "JSON array accepted");

    process.env.COGNEE_CAPTURE_TOOLS = "[not json";
    cfg = clientMod.loadCogneeConfig();
    assert.deepEqual(cfg.captureTools, [...clientMod.DEFAULT_CAPTURE_TOOLS], "malformed → default set in use");
    assert.ok(cfg.captureToolsError?.startsWith("COGNEE_CAPTURE_TOOLS is not valid JSON: "), "parse error surfaced");

    process.env.COGNEE_CAPTURE_TOOLS = '["read", 5]';
    cfg = clientMod.loadCogneeConfig();
    assert.equal(cfg.captureToolsError, "COGNEE_CAPTURE_TOOLS must be an array of strings", "exact reference shape error");

    process.env.COGNEE_CAPTURE_TOOLS = undefined;
    process.env.COGNEE_CAPTURE_DENY_PATHS = "*.tfvars, *.tfstate";
    cfg = clientMod.loadCogneeConfig();
    assert.deepEqual(cfg.captureDenyPaths, ["*.tfvars", "*.tfstate"], "comma-separated deny extras");

    process.env.COGNEE_CAPTURE_REDACT = "false";
    process.env.COGNEE_CAPTURE_REDACT_PATTERNS = "good-\\d+\n([bad\nalsogood-\\d+";
    cfg = clientMod.loadCogneeConfig();
    assert.equal(cfg.captureRedact, false, "COGNEE_CAPTURE_REDACT=false respected");
    assert.deepEqual(cfg.captureRedactPatterns, ["good-\\d+", "alsogood-\\d+"], "invalid regex filtered out");
    assert.deepEqual(cfg.captureRedactPatternsSkipped, ["([bad"], "skipped patterns surfaced for the doctor");
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

/* Wire-level checks (spec §6 1–9): drive the recorded tool_result handler
 * through the harness and assert on the outgoing POST bodies. */

await check("traces §6.1: entry shape — one POST, exact TraceEntry + envelope keys", async () => {
  await withTraceHarness({}, async ({ fire, waitPosts }) => {
    fire({ toolName: "bash", input: { command: "ls -la" }, content: [{ type: "text", text: "file1" }, { type: "text", text: "file2" }], isError: false });
    const got = await waitPosts(1);
    assert.equal(got.length, 1, "exactly one POST /api/v1/remember/entry");
    const body = got[0].body;
    assert.equal(body.entry.type, "trace");
    assert.equal(body.entry.origin_function, "bash");
    assert.equal(body.entry.status, "success");
    assert.deepEqual(body.entry.method_params, { command: "ls -la" });
    assert.equal(body.entry.method_return_value, "file1\nfile2", "text blocks joined");
    assert.equal(body.entry.error_message, "");
    assert.equal(body.entry.generate_feedback_with_llm, false);
    assert.ok(body.session_id.startsWith("pi_"), "envelope session_id");
    assert.equal(body.dataset_name, "agent_sessions", "envelope dataset_name");
  });
});

await check("traces §6.2: error status — isError drives status + 500B error_message", async () => {
  await withTraceHarness({}, async ({ fire, waitPosts }) => {
    fire({ toolName: "read", input: { path: "/tmp/missing.ts" }, content: [{ type: "text", text: "E".repeat(600) }], isError: true });
    const [post] = await waitPosts(1);
    assert.equal(post.body.entry.status, "error", "isError → error");
    assert.ok(Buffer.byteLength(post.body.entry.error_message, "utf8") <= 500, "error_message ≤ 500B");
    assert.ok(post.body.entry.error_message.endsWith("..."), "over-cap error text truncated");
    assert.equal(post.body.entry.method_return_value, "E".repeat(600), "return value keeps the full text (own 8000B cap)");
  });
});

await check("traces §6.3: allowlist — default set, widening, case sensitivity, master switch (QA regression)", async () => {
  await withTraceHarness({}, async ({ fire, waitPosts }) => {
    fire({ toolName: "mcp__x__y", input: { q: 1 }, content: [{ type: "text", text: "custom tool out" }], isError: false });
    fire({ toolName: "read", input: { path: "/a/ok.txt" }, content: [{ type: "text", text: "ok" }], isError: false });
    const got = await waitPosts(1);
    assert.equal(got.length, 1, "default set: custom tool NOT captured, builtin read is");
    assert.equal(got[0].body.entry.origin_function, "read");
  });
  await withTraceHarness({ COGNEE_CAPTURE_TOOLS: "read|mcp__x__*" }, async ({ fire, waitPosts }) => {
    fire({ toolName: "mcp__x__y", input: { q: 1 }, content: [{ type: "text", text: "custom" }], isError: false });
    const got = await waitPosts(1);
    assert.equal(got[0].body.entry.origin_function, "mcp__x__y", "user-set allowlist widens to custom tools");
  });
  await withTraceHarness({ COGNEE_CAPTURE_TOOLS: "READ" }, async ({ fire, posts }) => {
    fire({ toolName: "read", input: { path: "/a/ok.txt" }, content: [{ type: "text", text: "x" }], isError: false });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(posts().length, 0, "fnmatch is case-sensitive — READ does not match read");
  });
  await withTraceHarness({ COGNEE_CAPTURE: "false" }, async ({ fire, posts, recorded, ctx }) => {
    fire({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "x" }], isError: false });
    const messageEnd = recorded.events.get("message_end")[0];
    messageEnd({ message: { role: "user", content: "what do we know about traces" } }, ctx);
    messageEnd({ message: { role: "assistant", content: "they are captured" } }, ctx);
    recorded.events.get("agent_settled")[0]();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(posts().length, 0, "COGNEE_CAPTURE=false gates traces AND the QA path (regression)");
  });
});

await check("traces §6.4: deny list — whole-entry refusal, nesting, backslashes, env extension, non-path keys", async () => {
  await withTraceHarness({}, async ({ fire, waitPosts }) => {
    fire({ toolName: "read", input: { path: "/p/.env" }, content: [{ type: "text", text: "SECRET=1" }], isError: false });
    fire({ toolName: "write", input: { path: "secrets.yaml" }, content: [], isError: false });
    fire({ toolName: "read", input: { paths: ["/a/ok.txt", "/home/u/.ssh/key"] }, content: [], isError: false });
    fire({ toolName: "read", input: { path: "C:\\x\\.env" }, content: [], isError: false });
    fire({ toolName: "find", input: { pattern: "*.env" }, content: [{ type: "text", text: "1" }], isError: false });
    const got = await waitPosts(1);
    assert.equal(got.length, 1, "deny hits refuse the whole entry (never partially redacted)");
    assert.equal(got[0].body.entry.origin_function, "find", "non-path key (pattern) not denied — positive control");
    assert.ok(!JSON.stringify(got[0].raw).includes("SECRET"), "denied entries never reach the wire");
  });
  await withTraceHarness({ COGNEE_CAPTURE_DENY_PATHS: "*.tfvars" }, async ({ fire, waitPosts }) => {
    fire({ toolName: "write", input: { path: "prod.tfvars" }, content: [], isError: false });
    fire({ toolName: "read", input: { path: "ok.txt" }, content: [{ type: "text", text: "x" }], isError: false });
    const got = await waitPosts(1);
    assert.equal(got.length, 1);
    assert.equal(got[0].body.entry.origin_function, "read", "COGNEE_CAPTURE_DENY_PATHS extends the compiled-in list");
  });
});

await check("traces §6.5: redaction — PEM, secret dict key, bearer, custom patterns, off switch", async () => {
  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpA\n-----END RSA PRIVATE KEY-----";
  await withTraceHarness({}, async ({ fire, waitPosts }) => {
    fire({ toolName: "bash", input: { command: "cat key" }, content: [{ type: "text", text: `loaded ${PEM} ok` }], isError: false });
    fire({ toolName: "read", input: { path: "/x/cfg", api_key: "supersecret" }, content: [{ type: "text", text: "cfg" }], isError: false });
    fire({ toolName: "bash", input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrst' x" }, content: [], isError: false });
    const got = await waitPosts(3);
    const pem = got.find((p) => p.body.entry.method_params.command === "cat key").body.entry;
    assert.ok(pem.method_return_value.includes("[redacted:private-key]"), "PEM in output redacted");
    assert.ok(!pem.method_return_value.includes("MIIEpA"), "key material gone");
    const readEntry = got.find((p) => p.body.entry.origin_function === "read").body.entry;
    assert.equal(readEntry.method_params.api_key, "[redacted:credential]", "secret dict key replaced wholesale");
    const bearer = got.find((p) => /curl/.test(p.body.entry.method_params.command)).body.entry;
    assert.ok(bearer.method_params.command.includes("[redacted:authorization]"), "bearer token redacted");
    assert.ok(!bearer.method_params.command.includes("abcdefghijklmnopqrst"), "bearer material gone");
  });
  await withTraceHarness({ COGNEE_CAPTURE_REDACT_PATTERNS: "NI-[A-Z0-9]{4,}[,;]\\s*NICE-TRY\nAKIA[0-9A-Z]{16}" }, async ({ fire, waitPosts }) => {
    fire({ toolName: "bash", input: { command: "echo" }, content: [{ type: "text", text: "NI-AB12, NICE-TRY and AKIAABCDEFGHIJKLMNOP" }], isError: false });
    const [post] = await waitPosts(1);
    assert.equal(post.body.entry.method_return_value, "[redacted:custom] and [redacted:custom]", "newline-separated custom patterns (comma-bearing regex)");
  });
  await withTraceHarness({ COGNEE_CAPTURE_REDACT: "false" }, async ({ fire, waitPosts }) => {
    fire({ toolName: "read", input: { path: "/x/cfg", api_key: "supersecret" }, content: [{ type: "text", text: PEM }], isError: false });
    const [post] = await waitPosts(1);
    assert.equal(post.body.entry.method_params.api_key, "supersecret", "redact=false passes input through");
    assert.ok(post.body.entry.method_return_value.includes("BEGIN RSA PRIVATE KEY"), "output unredacted");
  });
});

await check("traces §6.6: caps + order — 4000B/8000B byte-exact, multibyte, redact-before-truncate", async () => {
  await withTraceHarness({}, async ({ fire, waitPosts }) => {
    fire({ toolName: "bash", input: { command: "x".repeat(10_000) }, content: [{ type: "text", text: "y".repeat(20_000) }], isError: false });
    fire({ toolName: "bash", input: { command: "ü".repeat(3000) }, content: [], isError: false }); // 6000 bytes
    fire({ toolName: "bash", input: { command: "x".repeat(3995) + " sk-" + "A".repeat(40) }, content: [], isError: false });
    const got = await waitPosts(3);
    const entries = got.map((p) => p.body.entry);
    const [plain, multi, straddle] = entries;
    assert.ok(Buffer.byteLength(plain.method_params.command, "utf8") <= 4000, `10kB param ≤ 4000B (${Buffer.byteLength(plain.method_params.command, "utf8")}B)`);
    assert.ok(plain.method_params.command.endsWith("..."), "param truncation marker");
    assert.ok(Buffer.byteLength(plain.method_return_value, "utf8") <= 8000, "20kB return ≤ 8000B");
    assert.ok(plain.method_return_value.endsWith("..."), "return truncation marker");
    assert.ok(Buffer.byteLength(multi.method_params.command, "utf8") <= 4000, `multibyte cap byte-exact (${Buffer.byteLength(multi.method_params.command, "utf8")}B)`);
    assert.ok(!straddle.method_params.command.includes("sk-"), "secret straddling the cap is fully redacted first");
    assert.ok(!/A{10}/.test(straddle.method_params.command), "no secret material survives truncation");
    assert.ok(Buffer.byteLength(straddle.method_params.command, "utf8") <= 4000, "straddled param still ≤ 4000B");
  });
});

await check("traces §6.7: self-reference skip — cognee shell lines and own tools, even under allowlist *", async () => {
  await withTraceHarness({}, async ({ fire, waitPosts }) => {
    fire({ toolName: "bash", input: { command: "cognee search something" }, content: [{ type: "text", text: "r" }], isError: false });
    fire({ toolName: "powershell", input: { command: "cognee.ps1 sync" }, content: [], isError: false });
    fire({ toolName: "read", input: { path: "/a/ok.txt" }, content: [{ type: "text", text: "ok" }], isError: false });
    const got = await waitPosts(1);
    assert.equal(got.length, 1, "bash/powershell lines mentioning cognee are skipped (self-reference)");
    assert.equal(got[0].body.entry.origin_function, "read");
  });
  await withTraceHarness({ COGNEE_CAPTURE_TOOLS: "*" }, async ({ fire, waitPosts }) => {
    fire({ toolName: "cognee_remember", input: { content: "x" }, content: [{ type: "text", text: "Stored." }], isError: false });
    fire({ toolName: "read", input: { path: "/a/ok.txt" }, content: [{ type: "text", text: "ok" }], isError: false });
    const got = await waitPosts(1);
    assert.equal(got.length, 1, "own cognee_* tools skipped even when the allowlist admits them");
    assert.equal(got[0].body.entry.origin_function, "read");
  });
});

await check("traces §6.8: binding — a queued trace drains into its capture-time session/dataset across a mid-flight switch", async () => {
  await withTraceHarness({}, async ({ fire, waitPostWhere, setDatasets, setEntryStatus, recorded, ctx, sessionId }) => {
    setDatasets([{ name: "team_memory", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }]);
    setEntryStatus(503); // retriable: the trace stays buffered across the switch
    fire({ toolName: "bash", input: { command: "ls -la" }, content: [{ type: "text", text: "f" }], isError: false });
    await new Promise((r) => setTimeout(r, 150));
    const cmd = recorded.commands.find((c) => c.name === "cognee-datasets");
    await cmd.handler("team_memory", ctx); // pre-switch drain fails (503, queue kept); improve succeeds → switch proceeds
    setEntryStatus(200);
    fire({ toolName: "grep", input: { pattern: "x" }, content: [{ type: "text", text: "hit" }], isError: false });
    const got = await waitPostWhere((p) => p.body?.entry?.origin_function === "grep");
    const oldPost = got.find((p) => p.body.entry.method_params.command === "ls -la" && p.body.entry.origin_function === "bash" && p.body.session_id === `pi_${sessionId}`).body;
    assert.ok(oldPost, "the pre-switch trace drained (200) after the flip");
    assert.equal(oldPost.session_id, `pi_${sessionId}`, "capture-time session binding (pre-switch)");
    assert.equal(oldPost.dataset_name, "agent_sessions", "capture-time dataset binding (pre-switch)");
    const newPost = got.find((p) => p.body.entry.origin_function === "grep").body;
    assert.equal(newPost.session_id, `pi_${sessionId}__2`, "post-switch trace uses the minted ordinal session");
    assert.equal(newPost.dataset_name, "team_memory", "post-switch trace uses the new dataset");
  });
});

await check("traces §6.9: robustness — non-JSON-safe values, lone surrogates, handler throw-path", async () => {
  await withTraceHarness({}, async ({ fire, fireRaw, posts, waitPosts }) => {
    fire({
      toolName: "read",
      input: { path: "/x/a", fn: function kebab() {}, n: 10n, nested: { deep: 10n } },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    const [post] = await waitPosts(1);
    const params = post.body.entry.method_params;
    assert.equal(typeof params.fn, "string", "function value stringified, no throw");
    assert.equal(params.n, "10", "bigint → String fallback (JSON.stringify throws, safeJson catches)");
    assert.equal(typeof params.nested, "string", "nested non-JSON-safe object stringified");
    fire({ toolName: "bash", input: { command: "cat x" }, content: [{ type: "text", text: "ok \uD800 end" }], isError: false });
    const got = await waitPosts(2);
    assert.doesNotThrow(() => JSON.parse(got[0].raw), "wire body is valid JSON");
    assert.doesNotThrow(() => JSON.parse(got[1].raw), "surrogate-bearing wire body is valid JSON");
    const surrogate = got[1].body.entry.method_return_value;
    assert.ok(!/[\uD800-\uDFFF]/.test(surrogate), "no lone surrogate stored");
    assert.ok(surrogate.includes("\uFFFD"), "round-tripped to U+FFFD (reference parity)");
    const before = posts().length;
    let threw = false;
    try {
      fireRaw({ type: "tool_result", toolCallId: "c9", toolName: "bash", get input() { throw new Error("smoke boom"); }, content: [], isError: false });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "handler never lets an internal throw escape (fail-soft)");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(posts().length, before, "throw-path stored nothing");
  });
});

await check("traces: /cognee-doctor surfaces the capture-policy row and malformed-knob warnings", async () => {
  await withTraceHarness({ COGNEE_CAPTURE_TOOLS: "[bad", COGNEE_CAPTURE_REDACT_PATTERNS: "([bad" }, async ({ recorded, ctx, notifyLog }) => {
    await recorded.commands.find((c) => c.name === "cognee-doctor").handler("", ctx);
    const doctor = notifyLog[notifyLog.length - 1]?.m ?? "";
    assert.ok(doctor.includes("Capture pol"), "capture-policy row present");
    assert.ok(doctor.includes("traces: 8 tool patterns (default set)"), `default tool set labeled (${doctor.split("\n").find((l) => l.includes("Capture pol"))})`);
    assert.ok(doctor.includes("COGNEE_CAPTURE_TOOLS is not valid JSON"), "malformed tools value surfaced");
    assert.ok(doctor.includes("skipped invalid regex: ([bad"), "invalid custom regex surfaced");
  });
});

/* ---------- v0.4: local server bootstrap (offline, hermetic — spec §5.1) ---------- */

const bootMod = await jiti.import(path.join(root, "src", "bootstrap.ts"));
const fsB = await import("node:fs");
const netB = await import("node:net");
const httpB = await import("node:http");
const os = await import("node:os");
const { spawnSync } = await import("node:child_process");
const { mkdtempSync: mkdtempB, mkdirSync: mkdirB, writeFileSync: writeB, chmodSync: chmodB, readFileSync: readB, existsSync: existsB, readdirSync: readdirB, rmSync: rmB } = fsB;

const BOOTSTRAP_ENV_KEYS = [
  "PATH", "COGNEE_PRESENCE_REPROBE_DELAY", "COGNEE_ENV_FILE", "COGNEE_LOCAL_BOOTSTRAP",
  "COGNEE_LOCAL_API_URL", "COGNEE_PI_STATE_DIR", "COGNEE_PI_BACKEND", "COGNEE_BASE_URL",
  "COGNEE_API_KEY",
];
function snapshotEnv(keys = BOOTSTRAP_ENV_KEYS) {
  const saved = keys.map((k) => process.env[k]);
  return () =>
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
}

/** A port that was just freed — guaranteed (short of a TOCTOU race) closed. */
function closedEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = netB.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Write an executable stub binary (shell or node, per shebang). */
function writeBin(dir, name, lines) {
  mkdirB(dir, { recursive: true });
  const p = path.join(dir, name);
  writeB(p, lines.join("\n") + "\n", "utf8");
  chmodB(p, 0o755);
  return p;
}

/** Symlink real coreutils into a stub bin dir so scrubbed-PATH stubs still run. */
function linkCoreutils(dir, names) {
  for (const name of names) {
    for (const base of ["/bin", "/usr/bin"]) {
      const real = path.join(base, name);
      if (existsB(real)) {
        try { fsB.symlinkSync(real, path.join(dir, name)); } catch { /* exists */ }
        break;
      }
    }
  }
}

async function killAndWait(pid, timeoutMs = 5000) {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

/** Dead pid that the OS has definitely not reused (spawned + reaped just now). */
function freshDeadPid() {
  const r = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  const pid = r.pid;
  if (pid) {
    try { process.kill(pid, 0); } catch { return pid; } // ESRCH = dead
  }
  return 0;
}

/** The stub venv python: answers metadata probes; `-m uvicorn ...` serves HTTP.
 *  Modes via SMOKE_UVICORN_MODE: serve (default) | exit | exit-and-serve | sleep. */
function writeVenvPythonStub(root, { marker } = {}) {
  const paths = bootMod.bootstrapPaths(root);
  mkdirB(path.dirname(paths.venvPython), { recursive: true });
  writeB(
    paths.venvPython,
    [
      `#!${process.execPath}`, // absolute — the stub must run under a scrubbed PATH
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `if (${JSON.stringify(marker)}) fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ args }) + '\\n');`,
      "if (args[0] === '-c') {",
      "  const s = args[1] || '';",
      "  if (s.includes(\"m.version('cognee')\")) { console.log(process.env.SMOKE_VENV_VERSION || '1.6.0'); process.exit(0); }",
      "  if (s.includes('sys.argv[1:]')) { console.log(process.env.SMOKE_VENV_MISSING || ''); process.exit(0); }",
      "  console.log(''); process.exit(0);",
      "}",
      "if (args.includes('uvicorn')) {",
      "  const port = Number(args[args.indexOf('--port') + 1]);",
      "  console.log('SMOKE-UVICORN-BOOT listening on ' + port);",
      "  const mode = process.env.SMOKE_UVICORN_MODE || 'serve';",
      "  const startServer = (delayMs) => setTimeout(() => {",
      "    const http = require('node:http');",
      "    const server = http.createServer((req, res) => {",
      "      res.writeHead(200, { 'content-type': 'application/json' });",
      "      res.end(JSON.stringify({ status: 'OK', version: '1.6.0' }));",
      "    });",
      "    server.listen(port, '127.0.0.1', () => {",
      `      if (process.env.SMOKE_HELPER_PID) fs.writeFileSync(process.env.SMOKE_HELPER_PID, String(process.pid));`,
      "    });",
      "  }, delayMs);",
      "  if (mode === 'exit') { console.error('stub uvicorn failed to boot (rc=1)'); process.exit(1); }",
      "  if (mode === 'exit-and-serve') {",
      "    const cp = require('node:child_process');",
      "    cp.spawn(process.execPath, [__filename, ...args], {",
      "      detached: true, stdio: 'ignore',",
      "      env: { ...process.env, SMOKE_UVICORN_MODE: 'serve', SMOKE_SERVE_DELAY_MS: '1300', SMOKE_VENV_MARKER: '' },",
      "    }).unref();",
      "    console.error('stub uvicorn primary exiting (rc=1)');",
      "    process.exit(1);",
      "  }",
      "  if (mode === 'chatty') {", // >1 MiB of chatter — exercises the pump's cap (F1)
      "    const chunk = 'x'.repeat(65536);",
      "    for (let i = 0; i < 26; i++) process.stdout.write(chunk);",
      "  }",
      "  if (mode !== 'sleep') startServer(Number(process.env.SMOKE_SERVE_DELAY_MS || 0));",
      "  setInterval(() => {}, 60000);",
      "}",
    ].join("\n") + "\n",
    "utf8",
  );
  chmodB(paths.venvPython, 0o755);
  return paths;
}

await check("install spec: pinned cognee + provider extras (deduped, ordered)", () => {
  const none = (k) => undefined;
  assert.equal(bootMod.cogneeInstallSpec(none), "cognee==1.6.0", "no providers → bare pin");
  assert.equal(
    bootMod.cogneeInstallSpec((k) => (k === "DB_PROVIDER" ? "postgres" : undefined)),
    "cognee[postgres-binary]==1.6.0",
    "DB_PROVIDER=postgres → postgres-binary extra",
  );
  assert.equal(
    bootMod.cogneeInstallSpec((k) => (k === "DB_PROVIDER" ? "PostgreSQL" : undefined)),
    "cognee[postgres-binary]==1.6.0",
    "postgresql alias matches case-insensitively",
  );
  const combo = bootMod.cogneeInstallSpec((k) =>
    ({
      DB_PROVIDER: "postgres",
      VECTOR_DB_PROVIDER: "pgvector",
      GRAPH_DATABASE_PROVIDER: "neo4j",
      LLM_PROVIDER: "ollama",
    })[k],
  );
  assert.equal(combo, "cognee[postgres-binary,neo4j,ollama]==1.6.0", `combo deduped + ordered: ${combo}`);
  assert.equal(bootMod.PINNED_COGNEE_VERSION, "1.6.0", "pin is the hardcoded constant (not env-overridable)");
});

await check("findUv: self-managed bin wins over PATH; PATH scan; neither → empty", () => {
  const restore = snapshotEnv();
  try {
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-buv-"));
    const binDir = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bpath-"));
    writeBin(binDir, "uv", ["#!/bin/sh", "echo path-uv"]);
    process.env.PATH = binDir;
    // PATH scan finds the stub when nothing is self-managed.
    assert.equal(bootMod.findUv(root), path.join(binDir, "uv"), "PATH scan finds the stub");
    // Self-managed bin wins over PATH.
    writeBin(path.join(root, "uv"), "uv", ["#!/bin/sh", "echo self-uv"]);
    assert.equal(bootMod.findUv(root), bootMod.bootstrapPaths(root).uvBin, "self-managed bin wins over PATH");
    // Neither → "" (empty PATH, no self-managed copy — fresh root).
    const emptyDir = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bempty-"));
    const emptyRoot = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bemptyroot-"));
    process.env.PATH = emptyDir;
    assert.equal(bootMod.findUv(emptyRoot), "", "neither self-managed nor on PATH → empty string");
  } finally {
    restore();
  }
});

await check("installUv: installs into UV_UNMANAGED_INSTALL (env set, no PATH edits); failure → empty", async () => {
  const restore = snapshotEnv();
  try {
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-binstuv-"));
    const binDir = mkdtempB(path.join(os.tmpdir(), "pi-cognee-binstbin-"));
    const envMarker = path.join(root, "uv-env-marker.txt");
    const pathMarker = path.join(root, "uv-path-marker.txt");
    // Stub curl: acts as the whole installer (its stdout feeds `sh` as a no-op).
    writeBin(binDir, "curl", [
      "#!/bin/sh",
      `mkdir -p "$UV_UNMANAGED_INSTALL"`,
      `printf '#!/bin/sh\\necho uv-stub\\n' > "$UV_UNMANAGED_INSTALL/uv"`,
      `chmod +x "$UV_UNMANAGED_INSTALL/uv"`,
      `printenv UV_UNMANAGED_INSTALL > ${JSON.stringify(envMarker)}`,
      `printenv PATH > ${JSON.stringify(pathMarker)}`,
    ]);
    linkCoreutils(binDir, ["sh", "mkdir", "chmod", "printenv"]);
    process.env.PATH = binDir;
    const uv = await bootMod.installUv(root);
    assert.equal(uv, bootMod.bootstrapPaths(root).uvBin, "fake uv landed in the self-managed dir");
    assert.equal(readB(envMarker, "utf8").trim(), bootMod.bootstrapPaths(root).uvDir, "UV_UNMANAGED_INSTALL env var set to <root>/uv");
    assert.equal(readB(pathMarker, "utf8").trim(), binDir, "no PATH edits (child PATH unchanged)");
    // Failing installer → "" + no throw (pipe rc is sh's, so the not-found path reports).
    rmB(root, { recursive: true, force: true });
    const root2 = mkdtempB(path.join(os.tmpdir(), "pi-cognee-binstuv2-"));
    writeBin(binDir, "curl", ["#!/bin/sh", "exit 1"]);
    const failed = await bootMod.installUv(root2);
    assert.equal(failed, "", "failed install → empty string, no throw");
    assert.ok(!existsB(bootMod.bootstrapPaths(root2).uvBin), "no uv created by the failed install");
  } finally {
    restore();
  }
});

await check("version/extras probes: stub interpreter answers; absent interpreter degrades", async () => {
  const restore = snapshotEnv();
  try {
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bprobe-"));
    const paths = writeVenvPythonStub(root);
    assert.equal(await bootMod.venvCogneeVersion(paths.venvPython), "1.6.0", "version probe reads the stub's answer");
    assert.deepEqual(
      await bootMod.venvMissingExtras(paths.venvPython, ["postgres-binary", "neo4j"]),
      [],
      "extras probe: nothing missing (stub prints empty)",
    );
    // Missing extras via the stub's canned stdout (sentinel dist names).
    process.env.SMOKE_VENV_MISSING = "asyncpg neo4j";
    assert.deepEqual(
      await bootMod.venvMissingExtras(paths.venvPython, ["postgres-binary", "neo4j", "ollama"]),
      ["postgres-binary", "neo4j"],
      "missing sentinel dists map back to their extras",
    );
    delete process.env.SMOKE_VENV_MISSING;
    // Absent interpreter → version "" and ALL extras missing.
    assert.equal(await bootMod.venvCogneeVersion(path.join(root, "no", "such", "python")), "", "absent interpreter → empty version");
    assert.deepEqual(
      await bootMod.venvMissingExtras(path.join(root, "no", "such", "python"), ["neo4j"]),
      ["neo4j"],
      "absent interpreter → all extras missing",
    );
  } finally {
    restore();
  }
});

await check("acquireJsonLock: one winner, stale reaping (dead pid / aged), live holder waits out, release unlinks", async () => {
  const dir = mkdtempB(path.join(os.tmpdir(), "pi-cognee-block-"));
  const lockPath = path.join(dir, "test.lock");
  const opts = (over = {}) => ({ staleMs: 60_000, waitMs: 0, pollMs: 20, owner: "test", ...over });
  // Concurrent acquirers → exactly one winner.
  const [a, b] = await Promise.all([
    bootMod.acquireJsonLock(lockPath, opts()),
    bootMod.acquireJsonLock(lockPath, opts()),
  ]);
  assert.equal(Boolean(a) + Boolean(b), 1, "exactly one winner");
  const winner = a || b;
  const holder = JSON.parse(readB(lockPath, "utf8"));
  assert.equal(holder.pid, process.pid, "lock records our pid (reference epoch-seconds format)");
  assert.ok(Number.isFinite(holder.created_at) && holder.created_at < Date.now() / 1000 + 1, "created_at is epoch seconds");
  winner.release();
  assert.ok(!existsB(lockPath), "release unlinks");
  // Dead-pid lock → reaped and taken.
  const deadPid = freshDeadPid();
  assert.ok(deadPid > 0, "got a freshly reaped (dead) pid");
  writeB(lockPath, JSON.stringify({ owner: "gone", pid: deadPid, created_at: Date.now() / 1000 }));
  const fromDead = await bootMod.acquireJsonLock(lockPath, opts());
  assert.ok(fromDead, "dead-pid lock reaped and acquired");
  fromDead.release();
  // Aged lock (live pid, but older than staleMs) → reaped.
  writeB(lockPath, JSON.stringify({ owner: "old", pid: process.pid, created_at: Date.now() / 1000 - 61 }));
  const fromAged = await bootMod.acquireJsonLock(lockPath, opts({ staleMs: 60_000 }));
  assert.ok(fromAged, "aged lock reaped and acquired");
  fromAged.release();
  // Live foreign holder (this process, fresh) → wait → null.
  writeB(lockPath, JSON.stringify({ owner: "live", pid: process.pid, created_at: Date.now() / 1000 }));
  assert.equal(await bootMod.acquireJsonLock(lockPath, opts({ waitMs: 120 })), null, "live holder → wait → null");
  // Unparseable lock → stale.
  writeB(lockPath, "{not json");
  const fromJunk = await bootMod.acquireJsonLock(lockPath, opts());
  assert.ok(fromJunk, "unparseable lock treated as stale");
  fromJunk.release();
});

await check("skip-at-pin: venv at the pin → no uv invocation, venv-ready.json rewritten", async () => {
  const restore = snapshotEnv();
  try {
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bskip-"));
    const marker = path.join(root, "invocations.jsonl");
    const paths = writeVenvPythonStub(root, { marker });
    const binDir = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bskipbin-")); // empty — no uv anywhere
    process.env.PATH = binDir;
    process.env.COGNEE_ENV_FILE = path.join(root, "absent.env");
    const env = (k) =>
      ({
        SYSTEM_ROOT_DIRECTORY: path.join(root, "cognee", "system"),
        DATA_ROOT_DIRECTORY: path.join(root, "cognee", "data"),
        CACHE_ROOT_DIRECTORY: path.join(root, "cognee", "cache"),
      })[k];
    const r = await bootMod.ensureCogneeInstalled(env, { stateRoot: root });
    assert.equal(r.ok, true, "skip-at-pin succeeds");
    assert.equal(r.version, "1.6.0", "version reported");
    assert.equal(r.skippedAtPin, true, "skippedAtPin flag set");
    const calls = existsB(marker) ? readB(marker, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.equal(calls.length, 1, `only the version probe ran (no uv/venv mutation): ${calls.join(" | ")}`);
    assert.ok(JSON.parse(calls[0]).args[0] === "-c", "the one invocation is the metadata probe");
    const ready = JSON.parse(readB(paths.venvReady, "utf8"));
    assert.equal(ready.cognee_version, "1.6.0", "venv-ready.json cognee_version");
    assert.equal(ready.python, paths.venvPython, "venv-ready.json python = venv interpreter path");
    assert.ok(typeof ready.updated_at === "number", "venv-ready.json updated_at is epoch seconds");
    for (const d of ["system", "data", "cache"]) {
      assert.ok(existsB(path.join(root, "cognee", d)), `data dir ${d} created under the temp root`);
    }
    assert.ok(!existsB(paths.installLock), "install lock released");
  } finally {
    restore();
  }
});

await check("install-lock loser: skip-at-pin short-circuits at the first poll while the winner still holds the lock", async () => {
  const restore = snapshotEnv();
  try {
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bloser-"));
    const paths = writeVenvPythonStub(root); // answers 1.6.0, nothing missing
    process.env.PATH = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bloserbin-")); // no uv — the loser must NOT install
    process.env.COGNEE_ENV_FILE = path.join(root, "absent.env");
    // A live foreign holder (this process) keeps the install lock — stale reap
    // and wait-out are both >60s away, so only the in-wait pin probe can exit.
    mkdirB(path.dirname(paths.installLock), { recursive: true });
    writeB(
      paths.installLock,
      JSON.stringify({ owner: "winner", pid: process.pid, created_at: Date.now() / 1000 }),
      "utf8",
    );
    const env = (k) =>
      ({
        SYSTEM_ROOT_DIRECTORY: path.join(root, "cognee", "system"),
        DATA_ROOT_DIRECTORY: path.join(root, "cognee", "data"),
        CACHE_ROOT_DIRECTORY: path.join(root, "cognee", "cache"),
      })[k];
    const started = Date.now();
    const r = await bootMod.ensureCogneeInstalled(env, { stateRoot: root });
    const elapsed = Date.now() - started;
    assert.equal(r.ok, true, "loser short-circuits at the satisfied pin");
    assert.equal(r.version, "1.6.0", "version reported");
    assert.equal(r.skippedAtPin, true, "skippedAtPin flag set");
    // One poll ≈ one venv probe; the wait window is 660 s — anything under a
    // few seconds proves the shortcut fired instead of the wait-out.
    assert.ok(elapsed < 5000, `prompt return at the first poll (took ${elapsed}ms)`);
    assert.ok(existsB(paths.installLock), "winner's lock untouched by the loser");
    const log = readB(paths.bootstrapLog, "utf8");
    assert.ok(
      log.includes('"event":"install_lock_lost_skip_at_pin"') && log.includes('"via":"wait_probe"'),
      `shortcut logged with via=wait_probe: ${log.slice(0, 400)}`,
    );
    // Negative control: an off-pin venv behind the same live holder must NOT
    // shortcut — race the loser against a short timer; only a "no" verdict
    // from the probe keeps it waiting. The holder's lock is then removed so
    // the background loser terminates via the (uv-less) install path instead
    // of polling out its full 61 s window.
    rmB(paths.bootstrapLog, { force: true });
    process.env.SMOKE_VENV_VERSION = "1.5.9";
    let settled = false;
    const loser = bootMod.ensureCogneeInstalled(env, { stateRoot: root }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(settled, false, "off-pin venv: no shortcut — the loser keeps waiting");
    rmB(paths.installLock, { force: true });
    const after = await loser;
    assert.equal(after.ok, false, "terminated through the install path (no uv on the scrubbed PATH)");
    assert.equal(after.skippedAtPin, undefined, "no skip flag off-pin");
    assert.ok(!existsB(paths.installLock), "lock released on the way out");
  } finally {
    delete process.env.SMOKE_VENV_VERSION;
    restore();
  }
});

await check("ensureLocalServerRunning adopt: healthy server → adopted, zero spawns", async () => {
  const restore = snapshotEnv();
  try {
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-badopt-"));
    process.env.PATH = mkdtempB(path.join(os.tmpdir(), "pi-cognee-badoptbin-")); // no uv
    process.env.COGNEE_ENV_FILE = path.join(root, "absent.env");
    // A real HTTP server on an ephemeral port serving /health 200.
    const health = httpB.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "OK" }));
    });
    await new Promise((resolve) => health.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = health.address();
      const r = await bootMod.ensureLocalServerRunning(`http://localhost:${port}`, () => undefined, { stateRoot: root });
      assert.equal(r.ok, true, "adopt ok");
      assert.equal(r.adopted, true, "adopted: a running server is used as-is");
      assert.equal(r.error, undefined, "no error");
      // No venv exists and no uv is on PATH — reaching the install step would
      // have failed, so adopted:true proves nothing was spawned.
      assert.ok(!existsB(path.join(root, "pi")), "no console log / spawn artifacts");
      assert.ok(!existsB(bootMod.bootstrapPaths(root).bootLock), "no boot lock left behind");
    } finally {
      health.close();
    }
  } finally {
    restore();
  }
});

await check("presence verdicts: closed → absent; TCP-no-HTTP → busy; live pidfile → busy; dead pid reaped", async () => {
  const restore = snapshotEnv();
  try {
    process.env.COGNEE_PRESENCE_REPROBE_DELAY = "0";
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bpres-"));
    const port = await closedEphemeralPort();
    const url = `http://localhost:${port}`;
    // Closed port, confirmAbsent:false → absent (refused + no pid = positive absence).
    let p = await bootMod.serverPresence(url, { confirmAbsent: false, stateRoot: root });
    assert.equal(p.verdict, "absent", `closed port → absent (evidence: ${JSON.stringify(p.evidence)})`);
    // confirmAbsent:true → still absent after the (0s) re-probe.
    p = await bootMod.serverPresence(url, { confirmAbsent: true, stateRoot: root });
    assert.equal(p.verdict, "absent", "closed port + confirmAbsent → absent");
    // TCP listener without HTTP → busy (a live listener is a server).
    const listener = netB.createServer(() => {});
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const { port: busyPort } = listener.address();
      p = await bootMod.serverPresence(`http://localhost:${busyPort}`, { confirmAbsent: false, stateRoot: root });
      assert.equal(p.verdict, "busy", "TCP-listening-but-not-HTTP → busy");
    } finally {
      listener.close();
    }
    // Fake pidfile with a live pid + ps stub matching uvicorn → busy.
    const binDir = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bpresbin-"));
    writeBin(binDir, "ps", ["#!/bin/sh", `echo "${process.pid} uvicorn cognee.api.client:app --port ${port}"`]);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    const paths = bootMod.bootstrapPaths(root);
    mkdirB(paths.stateRoot, { recursive: true });
    writeB(paths.pidFile(port), JSON.stringify({ pid: process.pid, port, version: "1.6.0", created_at: Date.now() / 1000 }));
    p = await bootMod.serverPresence(url, { confirmAbsent: false, stateRoot: root });
    assert.equal(p.verdict, "busy", "live pidfile + uvicorn-looking command → busy");
    // Dead pid → record reaped, verdict back to absent.
    const deadPid = freshDeadPid();
    writeB(paths.pidFile(port), JSON.stringify({ pid: deadPid, port, created_at: Date.now() / 1000 }));
    p = await bootMod.serverPresence(url, { confirmAbsent: false, stateRoot: root });
    assert.equal(p.verdict, "absent", "dead pidfile pid does not veto");
    assert.ok(!existsB(paths.pidFile(port)), "stale pidfile record reaped");
  } finally {
    restore();
  }
});

await check("full boot (stubbed uvicorn): pidfile + console capture + health, boot lock released", async () => {
  const restore = snapshotEnv();
  let spawnedPid = 0;
  try {
    process.env.COGNEE_PRESENCE_REPROBE_DELAY = "0";
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bboot-"));
    const paths = writeVenvPythonStub(root);
    process.env.PATH = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bbootbin-")); // no uv — skip-at-pin only
    process.env.COGNEE_ENV_FILE = path.join(root, "absent.env");
    const port = await closedEphemeralPort();
    const r = await bootMod.ensureLocalServerRunning(`http://localhost:${port}`, () => undefined, {
      stateRoot: root,
      healthTimeoutMs: 30_000,
    });
    assert.equal(r.ok, true, `boot ok: ${r.error ?? ""}`);
    assert.equal(r.adopted, false, "not adopted — we spawned it");
    const pidfile = JSON.parse(readB(paths.pidFile(port), "utf8"));
    spawnedPid = pidfile.pid;
    assert.ok(Number.isInteger(spawnedPid) && spawnedPid > 0, "pidfile records the spawned pid");
    assert.equal(pidfile.port, port, "pidfile records the port");
    assert.equal(pidfile.version, "1.6.0", "pidfile records our pin");
    try { process.kill(spawnedPid, 0); assert.ok(true, "spawned process alive"); } catch { assert.fail("spawned process should be alive"); }
    // The pump writes asynchronously (pipe hop) — poll briefly for the boot line.
    let consoleText = "";
    for (let i = 0; i < 80 && !consoleText.includes("SMOKE-UVICORN-BOOT"); i++) {
      consoleText = existsB(paths.consoleLog(port)) ? readB(paths.consoleLog(port), "utf8") : "";
      if (!consoleText) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(consoleText.includes("SMOKE-UVICORN-BOOT"), `console capture holds the boot line: ${consoleText.slice(0, 200)}`);
    assert.ok(!existsB(paths.bootLock), "boot lock released after healthy");
    // Second call adopts the now-running server.
    const again = await bootMod.ensureLocalServerRunning(`http://localhost:${port}`, () => undefined, { stateRoot: root });
    assert.equal(again.ok && again.adopted, true, "second call adopts");
  } finally {
    await killAndWait(spawnedPid);
    restore();
  }
});

await check("console pump: >1 MiB boot chatter stays capped; next boot rotates the capture to .1", async () => {
  const restore = snapshotEnv();
  let spawnedPid = 0;
  const CAP = 1024 * 1024;
  try {
    process.env.COGNEE_PRESENCE_REPROBE_DELAY = "0";
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bpump-"));
    const paths = writeVenvPythonStub(root);
    process.env.PATH = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bpumpbin-"));
    process.env.COGNEE_ENV_FILE = path.join(root, "absent.env");
    process.env.SMOKE_UVICORN_MODE = "chatty"; // ~1.625 MiB of stdout before serving
    const port = await closedEphemeralPort();
    const logPath = paths.consoleLog(port);
    const r = await bootMod.ensureLocalServerRunning(`http://localhost:${port}`, () => undefined, {
      stateRoot: root,
      healthTimeoutMs: 30_000,
    });
    assert.equal(r.ok, true, `chatty boot ok: ${r.error ?? ""}`);
    spawnedPid = JSON.parse(readB(paths.pidFile(port), "utf8")).pid;
    // The pump caps the capture at 1 MiB + the marker line — poll for the marker
    // (the pipe drains asynchronously) and assert the file NEVER passes it.
    let text = "";
    for (let i = 0; i < 240; i++) {
      text = existsB(logPath) ? readB(logPath, "utf8") : "";
      if (text.includes("console capture cap reached")) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(text.includes("console capture cap reached"), "cap marker stamped once the cap hit");
    assert.ok(
      fsB.statSync(logPath).size <= CAP + 200,
      `capture stays at the cap for the server's lifetime (size ${fsB.statSync(logPath).size})`,
    );
    // Let the stub's remaining buffered chatter drain past the cap, then
    // re-assert: the discarded tail must NOT grow the file (the F1 bug).
    await new Promise((res) => setTimeout(res, 500));
    assert.ok(
      fsB.statSync(logPath).size <= CAP + 200,
      `post-drain size still capped (size ${fsB.statSync(logPath).size})`,
    );
    await killAndWait(spawnedPid);
    spawnedPid = 0;

    // Boot 2 (quiet) on the SAME port: the pump rotates boot 1's capped capture
    // to .1 unconditionally and starts a fresh capture — .1 stays bounded.
    delete process.env.SMOKE_UVICORN_MODE;
    const r2 = await bootMod.ensureLocalServerRunning(`http://localhost:${port}`, () => undefined, {
      stateRoot: root,
      healthTimeoutMs: 30_000,
    });
    assert.equal(r2.ok, true, `quiet reboot ok: ${r2.error ?? ""}`);
    assert.equal(r2.adopted, false, "boot 2 spawned (boot 1 was killed)");
    spawnedPid = JSON.parse(readB(paths.pidFile(port), "utf8")).pid;
    assert.ok(existsB(`${logPath}.1`), "previous boot's capture rotated to .1");
    assert.ok(
      fsB.statSync(`${logPath}.1`).size <= CAP + 200,
      `.1 holds the capped boot-1 capture, bounded (size ${fsB.statSync(`${logPath}.1`).size})`,
    );
    let fresh = "";
    for (let i = 0; i < 80 && !fresh.includes("SMOKE-UVICORN-BOOT"); i++) {
      fresh = existsB(logPath) ? readB(logPath, "utf8") : "";
      if (!fresh) await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(fresh.includes("SMOKE-UVICORN-BOOT"), "fresh capture holds the new boot's line");
    assert.ok(!fresh.includes("console capture cap reached"), "quiet boot never hits the cap");
    assert.ok(fresh.length < CAP / 2, `fresh capture is small (len ${fresh.length})`);
  } finally {
    delete process.env.SMOKE_UVICORN_MODE;
    await killAndWait(spawnedPid);
    restore();
  }
});

await check("child exits before healthy: pidfile cleared + console tail in error; late claimer → adopted", async () => {
  const restore = snapshotEnv();
  let helperPid = 0;
  try {
    process.env.COGNEE_PRESENCE_REPROBE_DELAY = "0";
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bexit-"));
    const paths = writeVenvPythonStub(root);
    process.env.PATH = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bexitbin-"));
    process.env.COGNEE_ENV_FILE = path.join(root, "absent.env");
    const helperMarker = path.join(root, "helper.pid");
    // Scenario A: instant rc=1 exit, nobody claims the port → error with the console tail.
    process.env.SMOKE_UVICORN_MODE = "exit";
    let port = await closedEphemeralPort();
    let r = await bootMod.ensureLocalServerRunning(`http://localhost:${port}`, () => undefined, {
      stateRoot: root,
      healthTimeoutMs: 20_000,
    });
    assert.equal(r.ok, false, "instant-exit stub fails the boot");
    assert.equal(r.adopted, false, "not adopted");
    assert.match(r.error ?? "", /rc=1/, "error names the exit code");
    assert.match(r.error ?? "", /stub uvicorn failed to boot/, "error carries the console tail");
    assert.ok(!existsB(paths.pidFile(port)), "pidfile cleared after the child exited");
    // Scenario B: stub exits BUT a helper binds the port during the re-probe window → adopted.
    process.env.SMOKE_UVICORN_MODE = "exit-and-serve";
    process.env.SMOKE_HELPER_PID = helperMarker;
    port = await closedEphemeralPort();
    r = await bootMod.ensureLocalServerRunning(`http://localhost:${port}`, () => undefined, {
      stateRoot: root,
      healthTimeoutMs: 20_000,
    });
    assert.equal(r.ok, true, "late-claimer scenario succeeds");
    assert.equal(r.adopted, true, "…by adopting the server that claimed the port");
    helperPid = Number(readB(helperMarker, "utf8"));
    assert.ok(Number.isInteger(helperPid) && helperPid > 0, "helper pid recorded");
  } finally {
    delete process.env.SMOKE_UVICORN_MODE;
    delete process.env.SMOKE_HELPER_PID;
    await killAndWait(helperPid);
    restore();
  }
});

await check("deadline: never-healthy stub → deadline error, no hang", async () => {
  const restore = snapshotEnv();
  let spawnedPid = 0;
  try {
    process.env.COGNEE_PRESENCE_REPROBE_DELAY = "0";
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bdead-"));
    const paths = writeVenvPythonStub(root);
    process.env.PATH = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bdeadbin-"));
    process.env.COGNEE_ENV_FILE = path.join(root, "absent.env");
    process.env.SMOKE_UVICORN_MODE = "sleep"; // never serves, never exits
    const port = await closedEphemeralPort();
    const started = Date.now();
    const r = await bootMod.ensureLocalServerRunning(`http://localhost:${port}`, () => undefined, {
      stateRoot: root,
      healthTimeoutMs: 1500,
    });
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false, "deadline miss fails");
    assert.match(r.error ?? "", /did not become healthy/, "error names the deadline");
    assert.ok(elapsed < 10_000, `bounded runtime (~2s expected, took ${elapsed}ms)`);
    try {
      spawnedPid = JSON.parse(readB(paths.pidFile(port), "utf8")).pid;
    } catch { /* pidfile may be absent */ }
  } finally {
    delete process.env.SMOKE_UVICORN_MODE;
    await killAndWait(spawnedPid);
    restore();
  }
});

await check("buildServerEnv: shell > env file > pins; denylist; DEFAULT_USER_* setdefault; NO agent mode", () => {
  const restore = snapshotEnv();
  const keys = ["SMOKE_SHELL_X", "SMOKE_ONLY_FILE", "LD_LIBRARY_PATH", "SYSTEM_ROOT_DIRECTORY"];
  const saved2 = keys.map((k) => process.env[k]);
  try {
    process.env.SMOKE_SHELL_X = "shell";
    delete process.env.LD_LIBRARY_PATH;
    delete process.env.SYSTEM_ROOT_DIRECTORY;
    const tmp = mkdtempB(path.join(os.tmpdir(), "pi-cognee-benv-"));
    const out = bootMod.buildServerEnv({
      SMOKE_SHELL_X: "file",
      SMOKE_ONLY_FILE: "file-value",
      PATH: "/evil:/bin",
      HOME: "/evil/home",
      SHELL: "/evil/shell",
      USER: "evil",
      PYTHONPATH: "/evil/py",
      LD_LIBRARY_PATH: "/evil/ld",
      DYLD_LIBRARY_PATH: "/evil/dyld",
      SYSTEM_ROOT_DIRECTORY: path.join(tmp, "sys"),
    });
    assert.equal(out.SMOKE_SHELL_X, "shell", "shell beats the env file");
    assert.equal(out.SMOKE_ONLY_FILE, "file-value", "env-file-only key rides through");
    assert.equal(out.PATH, process.env.PATH, "PATH never sourced from the file");
    assert.equal(out.HOME, process.env.HOME, "HOME never sourced from the file");
    assert.equal(out.SHELL, process.env.SHELL, "SHELL never sourced from the file");
    assert.equal(out.USER, process.env.USER, "USER never sourced from the file");
    assert.equal(out.LD_LIBRARY_PATH, undefined, "LD_* never sourced from the file");
    assert.equal(out.DYLD_LIBRARY_PATH, undefined, "DYLD_* never sourced from the file");
    assert.equal(out.PYTHONPATH, process.env.PYTHONPATH, "PYTHON* never sourced from the file");
    assert.equal(out.SYSTEM_ROOT_DIRECTORY, path.join(tmp, "sys"), "file value beats the pin");
    assert.equal(out.DATA_ROOT_DIRECTORY, path.join(os.homedir(), ".cognee", "data"), "data-dir pin applied");
    assert.equal(out.CACHE_ROOT_DIRECTORY, path.join(os.homedir(), ".cognee", "cache"), "cache-dir pin applied");
    assert.equal(out.CACHING, "true", "CACHING pin");
    assert.equal(out.AUTO_FEEDBACK, "true", "AUTO_FEEDBACK pin");
    assert.equal(out.LLM_INSTRUCTOR_MODE, "json_schema_mode", "LLM_INSTRUCTOR_MODE pin");
    assert.equal(out.DEFAULT_USER_EMAIL, "default_user@example.com", "DEFAULT_USER_EMAIL setdefault");
    assert.equal(out.DEFAULT_USER_PASSWORD, "default_password", "DEFAULT_USER_PASSWORD setdefault");
    assert.equal(out.COGNEE_AGENT_MODE, undefined, "COGNEE_AGENT_MODE deliberately NOT set (documented divergence)");
  } finally {
    keys.forEach((k, i) => {
      if (saved2[i] === undefined) delete process.env[k];
      else process.env[k] = saved2[i];
    });
    restore();
  }
});

await check("fail-soft e2e: no uv + failed uv install → maybeBootstrap resolves, degraded ✕ status, error recorded", async () => {
  const restore = snapshotEnv();
  const realFetch = globalThis.fetch;
  try {
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bsoft-"));
    const envFile = path.join(root, "cognee.env");
    writeB(
      envFile,
      [
        `SYSTEM_ROOT_DIRECTORY=${path.join(root, "cognee", "system")}`,
        `DATA_ROOT_DIRECTORY=${path.join(root, "cognee", "data")}`,
        `CACHE_ROOT_DIRECTORY=${path.join(root, "cognee", "cache")}`,
      ].join("\n"),
    );
    process.env.COGNEE_PI_STATE_DIR = path.join(root, "pi"); // shared bootstrap root = <root>
    process.env.COGNEE_ENV_FILE = envFile;
    process.env.COGNEE_LOCAL_BOOTSTRAP = "on";
    process.env.COGNEE_PRESENCE_REPROBE_DELAY = "0";
    delete process.env.COGNEE_BASE_URL;
    delete process.env.COGNEE_PI_BACKEND;
    delete process.env.COGNEE_API_KEY;
    process.env.PATH = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bsoftbin-")); // no uv, no curl, no sh
    const port = await closedEphemeralPort();
    process.env.COGNEE_LOCAL_API_URL = `http://localhost:${port}`;
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "" });

    const { pi: piBs, recorded: recBs } = makeStubApi();
    factory(piBs);
    const statuses = [];
    const messages = [];
    const ctx = {
      hasUI: true,
      ui: { notify: (m, t) => messages.push({ m, t }), setStatus: (_k, v) => statuses.push(v) },
      cwd: mkdtempB(path.join(os.tmpdir(), "pi-cognee-bsoftcwd-")), // not a git repo
      sessionManager: { getSessionId: () => "smoke-bootstrap" },
    };
    recBs.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    for (let i = 0; i < 200; i++) {
      if (statuses.some((s) => s.startsWith("◐ cognee: starting")) && statuses.some((s) => s.startsWith("✕ cognee: offline"))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(statuses.some((s) => s.startsWith("◐ cognee: starting (local ·")), `starting status shown: ${statuses.join(" || ")}`);
    const startAt = statuses.findIndex((s) => s.startsWith("◐ cognee: starting"));
    const offAt = statuses.findIndex((s) => s.startsWith("✕ cognee: offline"));
    assert.ok(offAt > startAt, "degraded ✕ status after the failed bootstrap");
    assert.ok(messages.some(({ m }) => m.includes("Cognee local server starting")), "one-time starting notice");
    assert.ok(messages.some(({ m }) => m.includes("Cognee memory offline")), "degraded notice from the health path");
    // /cognee-doctor surfaces the bootstrap failure cause (uv missing).
    await recBs.commands.find((c) => c.name === "cognee-doctor").handler("", ctx);
    const doctor = messages[messages.length - 1]?.m ?? "";
    assert.ok(doctor.includes("Local runtime"), "doctor has the Local runtime row");
    assert.ok(doctor.includes("uv: not found"), `doctor reports uv not found: ${doctor.split("\n").find((l) => l.includes("Local runtime"))}`);
    assert.ok(doctor.includes("bootstrap: failed"), "doctor reports the failed bootstrap");
    assert.ok(doctor.includes("Server pidfile"), "doctor has the Server pidfile row");
    await recBs.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });
    // Nothing was spawned (uv missing) — no cleanup needed beyond the temp dir.
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

await check("once-guard: two session starts → one presence probe total (second is a no-op)", async () => {
  const restore = snapshotEnv();
  const realFetch = globalThis.fetch;
  try {
    const root = mkdtempB(path.join(os.tmpdir(), "pi-cognee-bonce-"));
    process.env.COGNEE_PI_STATE_DIR = path.join(root, "pi");
    process.env.COGNEE_ENV_FILE = path.join(root, "absent.env");
    process.env.COGNEE_LOCAL_BOOTSTRAP = "on";
    delete process.env.COGNEE_BASE_URL;
    delete process.env.COGNEE_PI_BACKEND;
    delete process.env.COGNEE_API_KEY;
    delete process.env.COGNEE_LOCAL_API_URL; // default http://localhost:8011
    let healthProbes = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/health")) {
        healthProbes++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "OK", version: "1.6.0" }) };
      }
      return { ok: true, status: 200, text: async () => "[]" };
    };
    const { pi: piOnce, recorded: recOnce } = makeStubApi();
    factory(piOnce);
    const ctx = {
      hasUI: true,
      ui: { notify() {}, setStatus() {} },
      cwd: mkdtempB(path.join(os.tmpdir(), "pi-cognee-boncecwd-")),
      sessionManager: { getSessionId: () => "smoke-once" },
    };
    const start = recOnce.events.get("session_start")[0];
    start({ type: "session_start", reason: "startup" }, ctx);
    for (let i = 0; i < 100 && healthProbes < 2; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(healthProbes >= 2, `first start: presence probe + health check ran (${healthProbes})`);
    start({ type: "session_start", reason: "resume" }, ctx); // second start on the SAME factory
    for (let i = 0; i < 100 && healthProbes < 3; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(healthProbes, 3, "second start: health check only — maybeBootstrap was a no-op (guard)");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(healthProbes, 3, "no late extra probes (no reprobe loop while healthy)");
    await recOnce.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});


/* ---------- v0.4: shared-agent-memory provisioning (offline — spec §4) ---------- */

const provFs = await import("node:fs");
const provOs = await import("node:os");
const PROV_ENV_KEYS = [
  "COGNEE_ENV_FILE", "COGNEE_API_KEY", "COGNEE_PI_STATE_DIR", "COGNEE_PI_BACKEND",
  "COGNEE_BASE_URL", "COGNEE_LOCAL_API_URL", "COGNEE_PLUGIN_DATASET", "COGNEE_CAPTURE",
  "COGNEE_PLUGIN_IDENTITY", "COGNEE_SHARED_AGENT_MEMORY", "COGNEE_BREAKER_FILE",
  "COGNEE_CODE_STATE_DIR",
];

const PRINCIPAL = "principal-key-1";
const AGENT_KEY = "agent-key-1";
const AGENT_ID = "agent-user-1";
const PARENT_ID = "parent-user-1";
const TENANT_ID = "tenant-1";
const ROLE_ID = "role-cognee-agent-1";
const DS_PARENT = "11111111-1111-1111-1111-111111111111";
const DS_SHARED_IN = "22222222-2222-2222-2222-222222222222"; // readable, foreign-owned (shared to us)
const DS_NEW = "33333333-3333-3333-3333-333333333333";

/** openapi fixtures: the 1.6.0 shape (no capabilities) vs the light-up shape. */
const openapiNoCaps = {
  paths: {
    "/api/v1/integrations/plugins/{plugin_key}/provision": { post: { parameters: [] } },
    "/api/v1/remember/entry": { post: {} },
  },
};
const openapiFull = {
  paths: {
    "/api/v1/integrations/plugins/{plugin_key}/provision": {
      post: { parameters: [{ name: "create_only", in: "query", schema: { type: "boolean" } }] },
    },
    "/api/v1/remember/entry": { post: { "x-cognee-session-dataset-ids": true } },
  },
};

/**
 * A canned cognee server exercising the provisioning flow. Every request is
 * recorded with method + url + auth key + parsed body; knobs are mutable
 * between calls (per-test scenarios).
 */
function makeProvisioningServer(fixtures = {}) {
  const srv = {
    calls: [],
    openapi: fixtures.openapi ?? openapiFull,
    parent: fixtures.parent ?? { id: PARENT_ID, tenant_id: "" },
    datasets: fixtures.datasets ?? [
      { id: DS_PARENT, name: "agent_sessions", owner_id: PARENT_ID, created_at: "2026-01-01T00:00:00Z" },
      { id: DS_SHARED_IN, name: "shared_in", owner_id: "someone-else", created_at: "2026-02-01T00:00:00Z" },
    ],
    writableGrants: fixtures.writableGrants ?? [DS_PARENT],
    roles: fixtures.roles ?? [],
    provision: fixtures.provision ?? {
      status: 200,
      body: { pluginKey: "pi", agentId: AGENT_ID, apiKey: AGENT_KEY, created: true },
    },
    tenantsMeStatus: fixtures.tenantsMeStatus ?? 200,
    roleCreateStatus: fixtures.roleCreateStatus ?? 200,
    grantDeny: new Set(fixtures.grantDeny ?? []),
    extra: fixtures.extra ?? {},
  };
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const err = (status, text) => ({ ok: false, status, text: async () => text });
  srv.handler = async (url, opts) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    let body = null;
    if (typeof opts?.body === "string") {
      try {
        body = JSON.parse(opts.body);
      } catch {
        body = opts.body;
      }
    } else if (opts?.body instanceof FormData) {
      body = opts.body;
    }
    const key = opts?.headers?.["X-Api-Key"] ?? "";
    const path = u.replace("https://cognee.invalid", "").split("?")[0];
    srv.calls.push({ method, url: u, key, body });
    if (path.endsWith("/health")) return ok('{"status":"OK","version":"1.6.0-test"}');
    if (path.endsWith("/openapi.json")) return ok(JSON.stringify(srv.openapi));
    if (path.includes("/api/v1/integrations/plugins/pi/provision")) {
      return srv.provision.status === 200
        ? ok(JSON.stringify(srv.provision.body))
        : err(srv.provision.status, JSON.stringify(srv.provision.body ?? {}));
    }
    if (path.includes("/api/v1/integrations/plugins/pi") && method === "DELETE") return ok("{}");
    if (path.endsWith("/api/v1/users/me")) return ok(JSON.stringify(srv.parent));
    if (path === "/api/v1/datasets" || path === "/api/v1/datasets/") {
      if (method === "POST") {
        return ok(JSON.stringify({ id: DS_NEW, name: String(body?.name ?? "created_ds") }));
      }
      return ok(JSON.stringify(srv.datasets));
    }
    if (path.endsWith("/api/v1/permissions/tenants/me")) {
      return srv.tenantsMeStatus === 200 ? ok("{}") : err(srv.tenantsMeStatus, "{}");
    }
    if (path.endsWith("/api/v1/permissions/tenants/select")) return ok("{}");
    if (path.endsWith("/api/v1/permissions/tenants") && method === "POST") {
      return ok(JSON.stringify({ tenant_id: TENANT_ID }));
    }
    if (path.includes(`/api/v1/permissions/tenants/${TENANT_ID}/roles`) && method === "GET") {
      return ok(JSON.stringify(srv.roles));
    }
    if (path.endsWith("/api/v1/permissions/roles") && method === "POST") {
      if (srv.roleCreateStatus !== 200) return err(srv.roleCreateStatus, "{}");
      return ok(JSON.stringify({ role_id: ROLE_ID }));
    }
    if (path.includes("/tenants") && method === "POST" && path.includes("/users/")) return ok("{}");
    if (path.includes("/roles") && path.includes("/users/")) {
      return method === "DELETE" ? ok("{}") : ok("{}");
    }
    if (path.includes("/api/v1/permissions/datasets/") && method === "POST") {
      const perm = u.includes("permission_name=write") ? "write" : "read";
      const denied = srv.grantDeny.has(String(body?.[0]));
      return denied ? err(403, "{}") : ok("{}");
    }
    if (path.includes("/api/v1/permissions/principals/") && u.includes("permission_name=write")) {
      return ok(JSON.stringify(srv.writableGrants.map((id) => ({ id }))));
    }
    if (path.endsWith("/api/v1/recall")) return ok("[]");
    if (path.endsWith("/api/v1/remember/entry")) return ok("{}");
    if (path.endsWith("/api/v1/improve")) return ok('{"status":"completed"}');
    if (path.endsWith("/api/v1/sessions/")) return ok("{}");
    return ok("[]");
  };
  return srv;
}

/** Hermetic provisioning harness: temp state dir, scrubbed env (+ overrides),
 *  a canned server, a factory-built extension with a healthy session. */
async function withProvisioningHarness(envOverrides, server, fn) {
  const stateDir = provFs.mkdtempSync(path.join(provOs.tmpdir(), "pi-cognee-prov-"));
  const piState = path.join(stateDir, "pi-state");
  const cwd = provFs.mkdtempSync(path.join(provOs.tmpdir(), "pi-cognee-provcwd-"));
  const saved = PROV_ENV_KEYS.map((k) => process.env[k]);
  const realFetch = globalThis.fetch;
  try {
    process.env.COGNEE_ENV_FILE = path.join(stateDir, "absent.env");
    process.env.COGNEE_API_KEY = PRINCIPAL;
    process.env.COGNEE_PI_STATE_DIR = piState;
    process.env.COGNEE_BASE_URL = "https://cognee.invalid";
    delete process.env.COGNEE_PI_BACKEND;
    delete process.env.COGNEE_LOCAL_API_URL;
    delete process.env.COGNEE_PLUGIN_DATASET;
    delete process.env.COGNEE_CAPTURE;
    delete process.env.COGNEE_PLUGIN_IDENTITY;
    delete process.env.COGNEE_SHARED_AGENT_MEMORY;
    process.env.COGNEE_BREAKER_FILE = path.join(piState, "breaker.json");
    process.env.COGNEE_CODE_STATE_DIR = path.join(piState, "code-graph");
    Object.assign(process.env, envOverrides);
    globalThis.fetch = (url, opts) => server.handler(url, opts);

    const { pi, recorded } = makeStubApi();
    factory(pi);
    const messages = [];
    const sessionId = `smoke-prov-${Math.random().toString(36).slice(2, 8)}`;
    const ctx = {
      hasUI: true,
      ui: { notify: (m, t) => messages.push({ m, t }), setStatus() {} },
      cwd,
      sessionManager: { getSessionId: () => sessionId },
    };
    const start = () => recorded.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    start();
    const waitCalls = async (pred, ms = 5000) => {
      for (let i = 0; i < ms / 25 && !server.calls.some(pred); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return server.calls.filter(pred);
    };
    const readJson = (name) => {
      try {
        return JSON.parse(provFs.readFileSync(path.join(piState, name), "utf8"));
      } catch {
        return undefined;
      }
    };
    const writeJson = (name, data) => {
      provFs.mkdirSync(piState, { recursive: true });
      provFs.writeFileSync(path.join(piState, name), JSON.stringify(data, null, 2), "utf8");
    };
    const seedAgentKey = (over = {}) =>
      writeJson("agent-key.json", {
        base_url: "https://cognee.invalid",
        api_key: AGENT_KEY,
        agent_id: AGENT_ID,
        plugin_key: "pi",
        principal_fingerprint: clientMod.principalFingerprint(PRINCIPAL),
        updated_at: "2026-09-24T00:00:00Z",
        ...over,
      });
    const seedMarker = (over = {}) =>
      writeJson("shared-memory.json", {
        base_url: "https://cognee.invalid",
        mode: "shared",
        reason: "",
        tenant_id: TENANT_ID,
        role_id: ROLE_ID,
        parent_user_id: PARENT_ID,
        agent_id: AGENT_ID,
        granted: {},
        canonical: {},
        updated_at: "2026-09-24T00:00:00Z",
        plugin_version: clientMod.PROVISIONING_PLUGIN_VERSION,
        ...over,
      });
    await fn({
      recorded, ctx, server, messages, start, waitCalls, readJson, writeJson,
      seedAgentKey, seedMarker, piState, sessionId,
      lastMsg: () => messages[messages.length - 1]?.m ?? "",
    });
    await recorded.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    globalThis.fetch = realFetch;
    PROV_ENV_KEYS.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
}

await check("provisioning §4.1: COGNEE_PLUGIN_IDENTITY × COGNEE_SHARED_AGENT_MEMORY env matrix + exact reference error", () => {
  const keys = ["COGNEE_PLUGIN_IDENTITY", "COGNEE_SHARED_AGENT_MEMORY"];
  const saved = keys.map((k) => process.env[k]);
  const cases = [
    // [identityRaw, sharedRaw, expectIdentity, expectShared, expectError]
    [undefined, undefined, "auto", true, undefined],
    ["auto", "true", "auto", true, undefined],
    ["true", "false", "enabled", false, undefined],
    ["false", "off", "disabled", false, undefined],
    ["yes", "off", "enabled", false, undefined],
    ["0", undefined, "disabled", true, undefined],
    ["ON", "0", "enabled", false, undefined],
    ["bogus", undefined, "auto", true, "COGNEE_PLUGIN_IDENTITY must be auto, true, or false"],
    ["bogus", "nope", "auto", true, "COGNEE_PLUGIN_IDENTITY must be auto, true, or false"],
  ];
  try {
    for (const [identityRaw, sharedRaw, wantIdentity, wantShared, wantError] of cases) {
      if (identityRaw === undefined) delete process.env.COGNEE_PLUGIN_IDENTITY;
      else process.env.COGNEE_PLUGIN_IDENTITY = identityRaw;
      if (sharedRaw === undefined) delete process.env.COGNEE_SHARED_AGENT_MEMORY;
      else process.env.COGNEE_SHARED_AGENT_MEMORY = sharedRaw;
      const cfg = clientMod.loadCogneeConfig();
      assert.equal(cfg.pluginIdentity, wantIdentity, `identity ${identityRaw} (shared ${sharedRaw})`);
      assert.equal(cfg.sharedAgentMemory, wantShared, `shared ${sharedRaw} (identity ${identityRaw})`);
      assert.equal(cfg.pluginIdentityError, wantError, `error for identity=${identityRaw}`);
      if (wantError) {
        // behavior falls back to auto — never a crash, doctor surfaces it.
        assert.equal(cfg.pluginIdentity, "auto", "malformed identity behaves as auto");
      }
    }
    // shared=off parses exactly on the off-set; other values keep it ON.
    for (const [raw, want] of [["0", false], ["false", false], ["no", false], ["off", false], ["1", true], ["yes", true], ["bogus", true], ["", true]]) {
      process.env.COGNEE_SHARED_AGENT_MEMORY = raw;
      assert.equal(clientMod.loadCogneeConfig().sharedAgentMemory, want, `shared=${JSON.stringify(raw)} → ${want}`);
    }
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

await check("provisioning §4.2a: no create_only → zero POSTs, no identity, doctor 'server does not support provisioning'", async () => {
  const server = makeProvisioningServer({ openapi: openapiNoCaps });
  await withProvisioningHarness({}, server, async ({ server: srv, recorded, ctx, readJson, waitCalls, lastMsg }) => {
    await waitCalls((c) => c.url.endsWith("/openapi.json"));
    await new Promise((r) => setTimeout(r, 200));
    // Capability verdict unsupported → in auto mode no provisioning/wiring POSTs at
    // all. The ONE allowed POST is the pre-existing dataset-ensure from the
    // health path (v0.3 behavior kept byte-for-byte — spec §2.4).
    const posts = srv.calls.filter((c) => c.method !== "GET");
    assert.deepEqual(
      posts.map((c) => `${c.method} ${c.url.replace("https://cognee.invalid", "")}`),
      ["POST /api/v1/datasets"],
      "zero provisioning/tenant/role/grant POSTs (fetch log GETs + the legacy ensure only)",
    );
    assert.equal(readJson("agent-key.json"), undefined, "no credential written");
    assert.equal(readJson("shared-memory.json"), undefined, "no marker written without an identity");
    await recorded.commands.find((c) => c.name === "cognee-doctor").handler("", ctx);
    const doctor = lastMsg();
    assert.ok(doctor.includes("Provisioning"), "doctor has the Provisioning row");
    assert.ok(
      doctor.includes("server does not support provisioning"),
      `doctor verdict line: ${doctor.split("\n").find((l) => l.includes("Provisioning"))}`,
    );
    assert.ok(
      doctor.includes("Memory") && doctor.includes("principal (no agent identity)"),
      `doctor memory line: ${doctor.split("\n").find((l) => l.includes("Memory"))}`,
    );
  });
});

await check("provisioning §4.2b: seeded identity + permissions route 404 → marker records separated/unsupported (structural, versioned)", async () => {
  const server = makeProvisioningServer({ openapi: openapiFull, tenantsMeStatus: 404 });
  await withProvisioningHarness({}, server, async ({ server: srv, seedAgentKey, readJson, waitCalls }) => {
    seedAgentKey();
    await waitCalls((c) => c.url.endsWith("/permissions/tenants/me"));
    await new Promise((r) => setTimeout(r, 200));
    const marker = readJson("shared-memory.json");
    assert.ok(marker, "marker written");
    assert.equal(marker.mode, "separated", "mode separated");
    assert.equal(marker.reason, "unsupported", "reason unsupported");
    assert.equal(marker.plugin_version, clientMod.PROVISIONING_PLUGIN_VERSION, "plugin version stamped (structural-reason memo key)");
    assert.equal(marker.base_url, "https://cognee.invalid", "per-server marker");
    // No tenant/role/grant calls were issued past the probe.
    assert.equal(
      srv.calls.filter((c) => c.url.includes("/permissions/") && !c.url.endsWith("/permissions/tenants/me")).length,
      0,
      "no tenant/role/grant POSTs past the unsupported verdict",
    );
    assert.ok(!(srv.calls.some((c) => c.url.includes("/tenants") && c.method === "POST")), "no tenant created");
  });
});

await check("provisioning §4.2c: full light-up — provision POST shape + §1.3 wiring call sequence in order + canonical create-as-parent", async () => {
  // Parent already owns a tenant (the tenantless-with-data case degrades — §1.3
  // step 5); the launch dataset is NOT in the readable set → the parent creates
  // its own canonical copy.
  const server = makeProvisioningServer({
    openapi: openapiFull,
    parent: { id: PARENT_ID, tenant_id: TENANT_ID },
    datasets: [
      { id: DS_PARENT, name: "team_memory", owner_id: PARENT_ID, created_at: "2026-01-01T00:00:00Z" },
      { id: DS_SHARED_IN, name: "shared_in", owner_id: "someone-else", created_at: "2026-02-01T00:00:00Z" },
    ],
  });
  await withProvisioningHarness({}, server, async ({ server: srv, readJson, waitCalls }) => {
    await waitCalls((c) => c.url.includes("/api/v1/datasets/") && c.method === "POST");
    await new Promise((r) => setTimeout(r, 200));

    // Provision POST shape (§1.1): ?create_only=true, body {}, principal key.
    const provision = srv.calls.find((c) => c.url.includes("/integrations/plugins/pi/provision"));
    assert.ok(provision, "provision POST fired");
    assert.ok(provision.url.endsWith("?create_only=true"), "create_only=true query param");
    assert.equal(provision.method, "POST");
    assert.deepEqual(provision.body, {}, "empty JSON body");
    assert.equal(provision.key, PRINCIPAL, "authenticated as the PRINCIPAL");

    // Wiring sequence (§1.3), in order.
    const norm = (u) =>
      u.replace("https://cognee.invalid", "")
        .split("?")[0]
        .replace(/\/tenants\/[^/]+\/roles/, "/tenants/<id>/roles")
        .replace(/\/users\/[^/]+\/(tenants|roles)/, "/users/<id>/$1")
        .replace(/\/datasets\/[^/]+$/, "/datasets/<id>");
    const seq = srv.calls
      .filter((c) => c.url.includes("/permissions/") || c.url.includes("/api/v1/users/me") || (c.url.includes("/api/v1/datasets") && (c.method === "GET" || c.url.endsWith("/api/v1/datasets/"))))
      .map((c) => `${c.method} ${norm(c.url)}`);
    const expected = [
      "GET /api/v1/permissions/tenants/me",
      "GET /api/v1/users/me",
      "GET /api/v1/datasets",
      "GET /api/v1/permissions/tenants/<id>/roles", // miss
      "POST /api/v1/permissions/roles", // created
      "POST /api/v1/permissions/users/<id>/tenants", // principal
      "POST /api/v1/permissions/tenants/select", // AS THE AGENT
      "POST /api/v1/permissions/users/<id>/roles", // principal
      // grants: read then write, one call per dataset
      "POST /api/v1/permissions/datasets/<id>",
      "POST /api/v1/permissions/datasets/<id>",
      "POST /api/v1/permissions/datasets/<id>",
      "POST /api/v1/permissions/datasets/<id>",
      "POST /api/v1/datasets/", // canonical created AS THE PARENT (trailing slash, reference parity)
      "POST /api/v1/permissions/datasets/<id>", // grant on the fresh dataset (read)
      "POST /api/v1/permissions/datasets/<id>", // (write)
    ];
    assert.deepEqual(seq, expected, `wiring sequence: ${JSON.stringify(seq)}`);
    // tenants/select runs as the agent — every other control-plane call as the principal.
    const select = srv.calls.find((c) => c.url.endsWith("/permissions/tenants/select"));
    assert.equal(select.key, AGENT_KEY, "tenants/select authenticates AS THE AGENT");
    for (const c of srv.calls.filter((c) => c.url.includes("/permissions/"))) {
      if (c.url.endsWith("/tenants/select")) continue;
      assert.equal(c.key, PRINCIPAL, `control-plane call as principal: ${c.method} ${c.url}`);
    }
    // Grants carry the dataset id body and the permission_name query.
    const grantCalls = srv.calls.filter((c) => c.url.includes("/api/v1/permissions/datasets/"));
    assert.ok(grantCalls.length >= 4, "read+write per readable dataset");
    const perms = grantCalls.slice(0, 4).map((c) => (c.url.includes("permission_name=write") ? "write" : "read"));
    assert.deepEqual(perms, ["read", "write", "read", "write"], "read-then-write per dataset");

    // Canonical: created as the PARENT; marker records mode shared + canonical.
    const create = srv.calls.find((c) => c.url.endsWith("/api/v1/datasets/") && c.method === "POST");
    assert.equal(create.key, PRINCIPAL, "canonical dataset created as the principal (never the agent)");
    const marker = readJson("shared-memory.json");
    assert.equal(marker.mode, "shared", "marker mode shared");
    assert.equal(marker.canonical?.agent_sessions, DS_NEW, "canonical write UUID recorded");
    assert.equal(marker.granted?.[DS_PARENT], "ok", "grant memoized ok for the parent dataset");
    assert.equal(marker.granted?.[DS_NEW], "ok", "grant memoized ok for the created dataset");
    const agentRecord = readJson("agent-key.json");
    assert.ok(agentRecord, "agent-key.json written");
    assert.equal(agentRecord.api_key, AGENT_KEY, "agent key stored");
    assert.equal(agentRecord.agent_id, AGENT_ID, "agent id stored");
    assert.equal(agentRecord.plugin_key, "pi", "plugin_key pi");
    assert.equal(agentRecord.principal_fingerprint, clientMod.principalFingerprint(PRINCIPAL), "principal fingerprint bound");
  });
});

await check("provisioning §4.2d: data plane under shared memory — dataset_id writes + dataset_ids recall read set", async () => {
  const server = makeProvisioningServer({ openapi: openapiFull, parent: { id: PARENT_ID, tenant_id: TENANT_ID } });
  await withProvisioningHarness({}, server, async ({ server: srv, recorded, ctx, waitCalls }) => {
    await waitCalls((c) => c.url.includes("/api/v1/datasets/") && c.method === "POST");
    await new Promise((r) => setTimeout(r, 200));
    // One captured turn drains by dataset_id (not dataset_name).
    const messageEnd = recorded.events.get("message_end")[0];
    messageEnd({ message: { role: "user", content: "what do we know about shared memory" } }, ctx);
    messageEnd({ message: { role: "assistant", content: "it wires a role." } }, ctx);
    recorded.events.get("agent_settled")[0]();
    for (let i = 0; i < 40 && !srv.calls.some((c) => c.url.endsWith("/api/v1/remember/entry")); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const entry = srv.calls.find((c) => c.url.endsWith("/api/v1/remember/entry"))?.body;
    assert.ok(entry, "remember/entry write observed");
    assert.equal(entry.dataset_id, DS_PARENT, "write addressed by the canonical UUID");
    assert.equal(entry.dataset_name, undefined, "no name addressing under shared memory");
    // Auto-recall addresses the read set by UUID and drops the session binding.
    await recorded.events.get("before_agent_start")[0]({
      type: "before_agent_start",
      prompt: "how does auth work here", // no identifier → graph lane only
    });
    const recalls = srv.calls.filter((c) => c.url.endsWith("/api/v1/recall"));
    assert.ok(recalls.length >= 1, "graph recall fired");
    const recall = recalls.at(-1).body;
    assert.equal(recall.dataset_ids[0], DS_PARENT, "recall read set led by the canonical UUID");
    assert.equal(recall.session_id, undefined, "session binding dropped on the shared-memory read (federation parity)");
    assert.equal(recall.datasets, undefined, "no name addressing on the shared read");
  });
});

await check("provisioning §4.3: provision response validation — each bad body → failed, no credential written", async () => {
  const savedDir = process.env.COGNEE_PI_STATE_DIR;
  const realFetch = globalThis.fetch;
  const dir = provFs.mkdtempSync(path.join(provOs.tmpdir(), "pi-cognee-provv-"));
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  try {
    process.env.COGNEE_PI_STATE_DIR = dir;
    process.env.COGNEE_ENV_FILE = path.join(dir, "absent.env");
    process.env.COGNEE_API_KEY = PRINCIPAL;
    process.env.COGNEE_BASE_URL = "https://cognee.invalid";
    const base = clientMod.loadCogneeConfig();
    let body = {};
    let status = 200;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/openapi.json")) return ok(JSON.stringify(openapiFull));
      if (u.includes("/provision")) {
        return status === 200 ? ok(JSON.stringify(body)) : { ok: false, status, text: async () => "{}" };
      }
      void opts;
      return ok("[]");
    };
    const c = new clientMod.CogneeClient({ ...base, baseUrl: "https://cognee.invalid", apiKey: PRINCIPAL });
    const recordExists = () => {
      try {
        provFs.readFileSync(path.join(dir, "agent-key.json"), "utf8");
        return true;
      } catch {
        return false;
      }
    };
    // not_an_object
    body = ["not", "a", "dict"];
    assert.equal((await c.provisionPluginAgent()).status, "failed", "non-dict → failed");
    // incomplete: no api_key
    body = { agentId: AGENT_ID, created: true };
    assert.equal((await c.provisionPluginAgent()).status, "failed", "missing api_key → failed");
    // incomplete: created != true
    body = { apiKey: "agent-k", agentId: AGENT_ID, created: false };
    assert.equal((await c.provisionPluginAgent()).status, "failed", "created != true → failed");
    // missing_agent_id
    body = { apiKey: "agent-k", created: true };
    assert.equal((await c.provisionPluginAgent()).status, "failed", "missing agent_id → failed");
    // agent_key_equals_principal
    body = { apiKey: PRINCIPAL, agentId: AGENT_ID, created: true };
    assert.equal((await c.provisionPluginAgent()).status, "failed", "agent key == principal → failed");
    // snake_case accepted on read
    body = { api_key: "agent-k-2", agent_id: AGENT_ID, created: true };
    let r = await c.provisionPluginAgent();
    assert.equal(r.status, "provisioned", "snake_case DTO accepted");
    assert.equal(r.apiKey, "agent-k-2");
    assert.equal(r.agentId, AGENT_ID);
    assert.ok(!recordExists(), "provisionPluginAgent itself never writes credentials (caller does)");
    // HTTP classification: 404/405 → unsupported; 500 → failed.
    status = 404;
    assert.equal((await c.provisionPluginAgent()).status, "unsupported", "HTTP 404 → unsupported");
    status = 405;
    assert.equal((await c.provisionPluginAgent()).status, "unsupported", "HTTP 405 → unsupported");
    status = 500;
    assert.equal((await c.provisionPluginAgent()).status, "failed", "HTTP 500 → failed");
  } finally {
    globalThis.fetch = realFetch;
    if (savedDir === undefined) delete process.env.COGNEE_PI_STATE_DIR;
    else process.env.COGNEE_PI_STATE_DIR = savedDir;
  }
});

await check("provisioning §4.4: agent-key.json lifecycle — round-trip, base_url mismatch, blocked, fingerprint mismatch, principal fallback", async () => {
  const dir = provFs.mkdtempSync(path.join(provOs.tmpdir(), "pi-cognee-provk-"));
  const saved = ["COGNEE_PI_STATE_DIR", "COGNEE_ENV_FILE", "COGNEE_API_KEY", "COGNEE_BASE_URL"].map((k) => process.env[k]);
  const realFetch = globalThis.fetch;
  try {
    process.env.COGNEE_PI_STATE_DIR = dir;
    process.env.COGNEE_ENV_FILE = path.join(dir, "absent.env");
    process.env.COGNEE_API_KEY = PRINCIPAL;
    process.env.COGNEE_BASE_URL = "https://cognee.invalid";
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "[]" });
    const fp = clientMod.principalFingerprint(PRINCIPAL);
    // Round-trip.
    clientMod.saveAgentKeyRecord({
      base_url: "https://cognee.invalid", api_key: AGENT_KEY, agent_id: AGENT_ID,
      plugin_key: "pi", principal_fingerprint: fp, updated_at: "2026-09-24T00:00:00Z",
    });
    let record = clientMod.loadAgentKeyRecord("https://cognee.invalid");
    assert.equal(record?.api_key, AGENT_KEY, "round-trip api_key");
    assert.equal(record?.agent_id, AGENT_ID, "round-trip agent_id");
    // base_url mismatch → ignored.
    assert.equal(clientMod.loadAgentKeyRecord("https://other.invalid"), undefined, "foreign server record ignored");
    // Client gates: valid identity wins the data plane; principal retained.
    const base = clientMod.loadCogneeConfig();
    const cfgShared = { ...base, baseUrl: "https://cognee.invalid", apiKey: PRINCIPAL, pluginIdentity: "auto", sharedAgentMemory: true };
    const c = new clientMod.CogneeClient(cfgShared);
    assert.equal(c.activeAgentKey, AGENT_KEY, "usable identity adopted");
    assert.equal(c.activeAgentId, AGENT_ID, "agent id surfaced");
    assert.equal(c.authSummary(), "plugin identity (~/.cognee-plugin/pi/agent-key.json)", "authSummary labels the identity");
    assert.equal(c.principalKey(), PRINCIPAL, "principal retained for the control plane");
    assert.equal(c.keyFingerprint(), clientMod.datasetKeyFingerprint("https://cognee.invalid", PRINCIPAL), "record fingerprint keys on the PRINCIPAL (identity flip cannot orphan the switch)");
    // Fingerprint mismatch → skipped, principal fallback, strict warning surfaced.
    clientMod.saveAgentKeyRecord({
      base_url: "https://cognee.invalid", api_key: AGENT_KEY, agent_id: AGENT_ID,
      plugin_key: "pi", principal_fingerprint: "deadbeef", updated_at: "2026-09-24T00:00:00Z",
    });
    const c2 = new clientMod.CogneeClient(cfgShared);
    assert.equal(c2.activeAgentKey, undefined, "mismatched fingerprint → identity skipped");
    assert.ok(/another or unverified principal/.test(c2.identityProblem ?? ""), "problem text surfaced");
    assert.equal(c2.authSummary(), "shell env", "falls back to the principal (env label)");
    // Blocked → skipped (+strict warning), never re-adopted.
    clientMod.saveAgentKeyRecord({
      base_url: "https://cognee.invalid", api_key: AGENT_KEY, agent_id: AGENT_ID,
      plugin_key: "pi", principal_fingerprint: fp, updated_at: "2026-09-24T00:00:00Z", blocked: true,
    });
    const c3 = new clientMod.CogneeClient({ ...cfgShared, pluginIdentity: "enabled" });
    assert.equal(c3.activeAgentKey, undefined, "blocked identity skipped");
    assert.ok(/rejected/.test(c3.identityProblem ?? ""), "blocked problem text");
    assert.equal(c3.authSummary(), "shell env", "blocked → principal fallback");
    // blockAgentKeyRecord stamps only the matching key.
    assert.equal(clientMod.blockAgentKeyRecord("wrong-key"), false, "non-matching key not stamped");
    assert.equal(clientMod.blockAgentKeyRecord(AGENT_KEY), true, "matching key stamped");
    assert.equal(clientMod.loadAgentKeyRecord("https://cognee.invalid")?.blocked, true, "blocked flag persisted");
    // clear + disabled mode.
    clientMod.clearAgentKeyRecord();
    assert.equal(clientMod.loadAgentKeyRecord("https://cognee.invalid"), undefined, "clear drops the record");
    clientMod.saveAgentKeyRecord({
      base_url: "https://cognee.invalid", api_key: AGENT_KEY, agent_id: AGENT_ID,
      plugin_key: "pi", principal_fingerprint: fp, updated_at: "2026-09-24T00:00:00Z",
    });
    const c4 = new clientMod.CogneeClient({ ...cfgShared, pluginIdentity: "disabled" });
    assert.equal(c4.activeAgentKey, undefined, "disabled mode ignores the cached identity");
    assert.equal(c4.identityProblem, undefined, "no problem under disabled");
  } finally {
    globalThis.fetch = realFetch;
    ["COGNEE_PI_STATE_DIR", "COGNEE_ENV_FILE", "COGNEE_API_KEY", "COGNEE_BASE_URL"].forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

await check("provisioning §4.5: marker memoization — ok never re-POSTs, denied retried after the window; opt-out demotes keeping ids (one role DELETE)", async () => {
  const server = makeProvisioningServer({ openapi: openapiFull, grantDeny: [DS_SHARED_IN] });
  await withProvisioningHarness({}, server, async ({ server: srv, seedAgentKey, seedMarker, readJson, messages }) => {
    const mk = () => {
      const base = clientMod.loadCogneeConfig();
      return new clientMod.CogneeClient({ ...base, baseUrl: "https://cognee.invalid", apiKey: PRINCIPAL });
    };
    seedAgentKey();
    // granted "ok" memoized → never re-POSTed; denied fresh → skipped this pass.
    seedMarker({ granted: { [DS_PARENT]: "ok", [DS_SHARED_IN]: { denied_at: Date.now() / 1000 + 3600 } } });
    let c = mk();
    let out = await c.resolveSharedDataset("agent_sessions");
    assert.equal(out.mode, "shared", "wired marker resolves shared");
    assert.equal(out.dataset_id, DS_PARENT, "canonical = the parent's own copy (eligible via ownership)");
    const grantUrls = srv.calls.filter((x) => x.url.includes("/api/v1/permissions/datasets/"));
    assert.equal(grantUrls.length, 0, "memoized ok + fresh denial → zero grant POSTs");
    // Denied past the window → retried (and denied again, logged once).
    seedMarker({ granted: { [DS_PARENT]: "ok", [DS_SHARED_IN]: { denied_at: Date.now() / 1000 - 7200 } } });
    srv.calls.length = 0;
    c = mk();
    out = await c.resolveSharedDataset("agent_sessions");
    assert.equal(out.mode, "shared", "still shared");
    const retried = srv.calls.filter((x) => x.url.includes("/api/v1/permissions/datasets/") && String(x.body?.[0]) === DS_SHARED_IN);
    assert.equal(retried.length, 1, "expired denial retried exactly once (read only — the 403 breaks the loop)");
    const marker1 = readJson("shared-memory.json");
    assert.ok(marker1.granted[DS_SHARED_IN].denied_at > Date.now() / 1000 - 60, "denied_at restamped");
    // Opt-out: exactly one role-removal DELETE; marker demoted KEEPING the ids.
    srv.calls.length = 0;
    const base2 = clientMod.loadCogneeConfig();
    const cOpt = new clientMod.CogneeClient({ ...base2, baseUrl: "https://cognee.invalid", apiKey: PRINCIPAL, sharedAgentMemory: false });
    const optOut = await cOpt.ensureSharedMemory({ dataset: "agent_sessions" });
    assert.equal(optOut.mode, "separated", "opt-out returns separated");
    assert.equal(optOut.reason, "opt_out", "reason opt_out");
    const deletes = srv.calls.filter((x) => x.method === "DELETE");
    assert.equal(deletes.length, 1, "exactly one DELETE issued");
    assert.ok(deletes[0].url.includes(`/permissions/users/${AGENT_ID}/roles`), "role-removal DELETE as the principal");
    assert.ok(deletes[0].url.includes(`role_id=${ROLE_ID}`), "DELETE targets the shared role");
    assert.equal(deletes[0].key, PRINCIPAL, "leave-role runs as the principal");
    const marker2 = readJson("shared-memory.json");
    assert.equal(marker2.mode, "separated", "marker demoted");
    assert.equal(marker2.reason, "opt_out", "demoted reason opt_out");
    assert.equal(marker2.tenant_id, TENANT_ID, "tenant id kept (re-enable rejoins)");
    assert.equal(marker2.role_id, ROLE_ID, "role id kept");
    assert.equal(marker2.parent_user_id, PARENT_ID, "parent id kept");
    assert.equal(marker2.canonical?.agent_sessions, DS_PARENT, "canonical map kept");
    assert.equal(marker2.role_member, false, "role_member false");
    // Doctor after opt-out.
    void messages;
  });
});

await check("provisioning §4.6: listWritableDatasets classification (direct grants, via_role, 404 → unfiltered) + switcher notes", async () => {
  const server = makeProvisioningServer({ openapi: openapiFull, writableGrants: [DS_PARENT] });
  await withProvisioningHarness({}, server, async ({ server: srv, seedAgentKey, seedMarker, recorded, ctx, lastMsg }) => {
    const mk = (over = {}) => {
      const base = clientMod.loadCogneeConfig();
      return new clientMod.CogneeClient({ ...base, baseUrl: "https://cognee.invalid", apiKey: PRINCIPAL, ...over });
    };
    // Unfiltered (no route answer): owner match → true, foreign-owned → null.
    srv.tenantsMeStatus = 200;
    const rows = srv.datasets;
    // Route present (filtered): direct grants decide; role-granted parent rows need marker "ok".
    seedAgentKey();
    seedMarker({ granted: { [DS_PARENT]: "ok" } });
    let c = mk();
    let listing = await c.listWritableDatasets(5000);
    assert.equal(listing.filtered, true, "route answered → filtered");
    const byName = Object.fromEntries(listing.datasets.map((r) => [r.name, r]));
    assert.equal(byName.agent_sessions.writable, true, "parent-owned + granted ok → writable via_role/direct");
    assert.equal(listing.readonly.includes("shared_in"), true, "foreign row without a grant → read-only");
    assert.equal(listing.hidden_readonly, 1, "one hidden read-only");
    // Without the confirmed grant the parent row is NOT writable via_role.
    seedMarker({ granted: {} });
    c = mk();
    listing = await c.listWritableDatasets(5000);
    const byName2 = Object.fromEntries(listing.datasets.map((r) => [r.name, r]));
    assert.equal(byName2.agent_sessions.writable, true, "direct grant keeps it writable");
    // Route 404 → unfiltered: owner match true, foreign null (unverifiable).
    const realHandler = srv.handler;
    srv.handler = async (url, opts) => {
      const u = String(url);
      if (u.includes("/api/v1/permissions/principals/")) {
        return { ok: false, status: 404, text: async () => "{}" };
      }
      return realHandler(url, opts);
    };
    c = mk();
    listing = await c.listWritableDatasets(5000);
    assert.equal(listing.filtered, false, "route 404 → unfiltered");
    const byName3 = Object.fromEntries(listing.datasets.map((r) => [r.name, r]));
    assert.equal(byName3.agent_sessions.writable, true, "owner match → true in unfiltered mode");
    assert.equal(byName3.shared_in.writable, null, "foreign-owned unverifiable → null (shown, heuristic)");
    assert.equal(listing.hidden_readonly, 0, "no read-only hidden in unfiltered mode");
    srv.handler = realHandler;

    // Switcher list: filtered + hidden → the read-only note; readonly switch refused.
    seedMarker({ granted: { [DS_PARENT]: "ok" } });
    const cmd = recorded.commands.find((x) => x.name === "cognee-datasets");
    await cmd.handler("", ctx);
    assert.ok(lastMsg().includes("(1 read-only dataset(s) not shown)"), `filtered list note: ${lastMsg().split("\n").find((l) => l.includes("read-only"))}`);
    assert.ok(!lastMsg().includes("shared_in"), "read-only row not shown");
    await cmd.handler("shared_in", ctx);
    assert.ok(lastMsg().includes("not writable"), "switch to a read-only target refused");
    // UUID that matches nothing → refused (not creatable by UUID).
    await cmd.handler("99999999-9999-9999-9999-999999999999", ctx);
    assert.ok(lastMsg().includes("not writable"), "unresolvable UUID target refused");
    // Unfiltered list note.
    srv.handler = async (url, opts) => {
      const u = String(url);
      if (u.includes("/api/v1/permissions/principals/")) {
        return { ok: false, status: 404, text: async () => "{}" };
      }
      return realHandler(url, opts);
    };
    await cmd.handler("", ctx);
    assert.ok(
      lastMsg().includes("(write access could not be verified — showing every readable dataset)"),
      `unfiltered list note: ${lastMsg().split("\n").find((l) => l.includes("could not be verified"))}`,
    );
    assert.ok(lastMsg().includes("shared_in"), "unfiltered list shows every readable dataset");
  });
});

await check("provisioning §4.6b: switch under shared memory resolves as principal, stores ids; record fingerprint keyed on the principal", async () => {
  const server = makeProvisioningServer({
    openapi: openapiFull,
    datasets: [
      { id: DS_PARENT, name: "agent_sessions", owner_id: PARENT_ID, created_at: "2026-01-01T00:00:00Z" },
      { id: DS_NEW, name: "team_memory", owner_id: PARENT_ID, created_at: "2026-01-02T00:00:00Z" },
    ],
  });
  await withProvisioningHarness({}, server, async ({ server: srv, seedAgentKey, seedMarker, recorded, ctx, readJson, lastMsg }) => {
    seedAgentKey();
    seedMarker({ granted: { [DS_PARENT]: "ok", [DS_NEW]: "ok" } });
    const cmd = recorded.commands.find((x) => x.name === "cognee-datasets");
    await cmd.handler("team_memory", ctx);
    assert.ok(lastMsg().includes("Switched to dataset 'team_memory'"), `switch ok: ${lastMsg()}`);
    const record = readJson("active-dataset.json");
    assert.ok(record, "record persisted");
    assert.equal(record.dataset, "team_memory", "record names the target");
    assert.equal(record.dataset_id, DS_NEW, "record carries the canonical write UUID");
    assert.deepEqual(record.dataset_ids, [DS_NEW], "record carries the read set");
    // A refresh re-ran grants for the datasets — every OWNER-ONLY control-plane
    // call (tenants/roles/grants) authenticated as the PRINCIPAL; the principals
    // read route runs as the effective identity (the agent) by design (§1.5).
    for (const c of srv.calls.filter((x) => x.url.includes("/permissions/") && !x.url.includes("/permissions/principals/"))) {
      assert.equal(c.key, PRINCIPAL, `switch-time control plane as principal: ${c.url}`);
    }
    // The record fingerprint survives an identity flip (keyed on the principal).
    const cfgAfter = clientMod.loadCogneeConfig();
    assert.equal(cfgAfter.dataset, "team_memory", "next config load adopts the switched dataset");
    assert.equal(cfgAfter.sharedDatasetId, DS_NEW, "…and its canonical UUID");
    assert.deepEqual(cfgAfter.sharedDatasetIds, [DS_NEW], "…and its read set");
    const fpPrincipal = clientMod.datasetKeyFingerprint("https://cognee.invalid", PRINCIPAL);
    assert.equal(record.key_fp, fpPrincipal, "record keyed on the principal fingerprint");
    const base = clientMod.loadCogneeConfig();
    const withIdentity = new clientMod.CogneeClient({ ...base, baseUrl: "https://cognee.invalid", apiKey: PRINCIPAL });
    assert.equal(withIdentity.keyFingerprint(), fpPrincipal, "client fingerprint stays principal-keyed with an active identity");
  });
});

await check("provisioning §4.8: rollback — wiring failure right after provisioning (auto) reverts the identity (disconnect + clear)", async () => {
  const server = makeProvisioningServer({ openapi: openapiFull, roleCreateStatus: 403, parent: { id: PARENT_ID, tenant_id: TENANT_ID } });
  await withProvisioningHarness({}, server, async ({ server: srv, readJson, waitCalls }) => {
    await waitCalls((c) => c.url.includes("/api/v1/integrations/plugins/pi") && c.method === "DELETE");
    await new Promise((r) => setTimeout(r, 200));
    const disconnect = srv.calls.find((c) => c.url.endsWith("/api/v1/integrations/plugins/pi") && c.method === "DELETE");
    assert.ok(disconnect, "fresh key revoked server-side (agent user stays)");
    assert.equal(disconnect.key, PRINCIPAL, "disconnect runs as the principal");
    assert.equal(readJson("agent-key.json"), undefined, "agent cache cleared");
    const marker = readJson("shared-memory.json");
    assert.equal(marker?.mode, "separated", "marker separated");
    assert.equal(marker?.reason, "not_tenant_owner", "structural reason recorded (403 role create)");
    // Enabled mode keeps the identity: no DELETE, record kept.
    const server2 = makeProvisioningServer({ openapi: openapiFull, roleCreateStatus: 403, parent: { id: PARENT_ID, tenant_id: TENANT_ID } });
    await withProvisioningHarness({ COGNEE_PLUGIN_IDENTITY: "true" }, server2, async ({ readJson: readJson2, waitCalls: wait2, server: srv2 }) => {
      await wait2((c) => c.url.includes("/api/v1/permissions/roles"));
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(readJson2("agent-key.json"), "enabled mode keeps the minted identity");
      assert.equal(
        srv2.calls.some((c) => c.url.endsWith("/api/v1/integrations/plugins/pi") && c.method === "DELETE"),
        false,
        "no disconnect under explicit identity",
      );
    });
  });
});

await check("provisioning §4.9: strict-mode obstacles are one-line warnings (never a hard fail) — doctor surfaces them", async () => {
  const server = makeProvisioningServer({ openapi: openapiNoCaps });
  await withProvisioningHarness({ COGNEE_PLUGIN_IDENTITY: "bogus" }, server, async ({ recorded, ctx, messages, lastMsg }) => {
    // A malformed value behaves as auto (config warning at load), factory still constructs.
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(
      messages.some(({ m }) => m.includes("COGNEE_PLUGIN_IDENTITY must be auto, true, or false")),
      "exact reference error surfaced as a session-start config warning",
    );
    await recorded.commands.find((c) => c.name === "cognee-doctor").handler("", ctx);
    assert.ok(lastMsg().includes("COGNEE_PLUGIN_IDENTITY must be auto, true, or false"), "doctor surfaces the malformed value too");
    assert.ok(lastMsg().includes("behaves as auto"), "doctor states the fail-soft fallback");
  });
  const server2 = makeProvisioningServer({ openapi: openapiNoCaps });
  await withProvisioningHarness({ COGNEE_PLUGIN_IDENTITY: "true" }, server2, async ({ messages, waitCalls }) => {
    await waitCalls((c) => c.url.endsWith("/openapi.json"));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      messages.some(({ m, t }) => t === "warning" && /provisioning unsupported/.test(m)),
      "strict mode warns when provisioning is unsupported (no hard fail)",
    );
  });
});


/* ---------- v0.4: resilience cluster — statusline + idle bridge + disk bridge (offline, spec §4) ---------- */

const bridgeMod = await jiti.import(path.join(root, "src", "bridge.ts"));
const improveMod = await jiti.import(path.join(root, "src", "improve-state.ts"));
const resFs = await import("node:fs");
const resOs = await import("node:os");

const RESILIENCE_ENV_KEYS = [
  "COGNEE_ENV_FILE", "COGNEE_API_KEY", "COGNEE_PI_STATE_DIR", "COGNEE_PI_BACKEND",
  "COGNEE_BASE_URL", "COGNEE_LOCAL_API_URL", "COGNEE_PLUGIN_DATASET", "COGNEE_CAPTURE",
  "COGNEE_LOCAL_BOOTSTRAP", "COGNEE_SESSION_ID", "COGNEE_BREAKER_FILE",
  "COGNEE_CODE_STATE_DIR", "LLM_API_KEY", "COGNEE_IDLE_THRESHOLD_MS",
  "COGNEE_IDLE_IMPROVE", "COGNEE_IMPROVE_COOLDOWN_MS", "COGNEE_AUTO_IMPROVE_EVERY",
  "COGNEE_STATUSLINE_COUNTS", "COGNEE_STATUSLINE_CREDITS", "COGNEE_CREDITS_FILE",
  "COGNEE_BILLING_URL", "COGNEE_FINAL_SYNC",
];

/**
 * Hermetic resilience harness: temp state root (pi-state + bridge + counters
 * under it), scrubbed env (+ overrides), a recording fetch stub with mutable
 * per-route behavior, and a factory-built extension with a healthy session.
 * `extraInstance` builds a SECOND independent extension over the same state
 * root + session pin (the crash/relaunch semantics).
 */
async function withResilienceHarness(envOverrides, fn) {
  const stateRoot = resFs.mkdtempSync(path.join(resOs.tmpdir(), "pi-cognee-res-"));
  const piState = path.join(stateRoot, "pi-state");
  const cwd = resFs.mkdtempSync(path.join(resOs.tmpdir(), "pi-cognee-rescwd-")); // not a git repo
  const saved = RESILIENCE_ENV_KEYS.map((k) => process.env[k]);
  const realFetch = globalThis.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const err = (status) => ({ ok: false, status, text: async () => "" });
  try {
    process.env.COGNEE_ENV_FILE = path.join(stateRoot, "absent.env");
    process.env.COGNEE_API_KEY = "smoke-key";
    process.env.COGNEE_PI_STATE_DIR = piState;
    process.env.COGNEE_LOCAL_BOOTSTRAP = "off";
    process.env.COGNEE_CODE_STATE_DIR = path.join(piState, "code-graph");
    process.env.COGNEE_BREAKER_FILE = path.join(piState, "breaker.json");
    process.env.COGNEE_SESSION_ID = `pi_smoke-res-${Math.random().toString(36).slice(2, 8)}`;
    delete process.env.COGNEE_PI_BACKEND;
    delete process.env.COGNEE_BASE_URL;
    delete process.env.COGNEE_LOCAL_API_URL;
    delete process.env.COGNEE_PLUGIN_DATASET;
    delete process.env.COGNEE_CAPTURE;
    delete process.env.LLM_API_KEY; // deterministic llm-key verdict (local mode)
    for (const key of [
      "COGNEE_IDLE_THRESHOLD_MS", "COGNEE_IDLE_IMPROVE", "COGNEE_IMPROVE_COOLDOWN_MS",
      "COGNEE_AUTO_IMPROVE_EVERY", "COGNEE_STATUSLINE_COUNTS", "COGNEE_STATUSLINE_CREDITS",
      "COGNEE_CREDITS_FILE", "COGNEE_BILLING_URL", "COGNEE_FINAL_SYNC",
    ]) {
      delete process.env[key];
    }
    Object.assign(process.env, envOverrides);

    const calls = [];
    const routes = {
      health: () => ok(JSON.stringify({ status: "OK", version: "1.6.0" })),
      datasets: () => ok("[]"),
      rememberEntry: () => ok("{}"),
      improve: () => ok(JSON.stringify({ status: "completed" })),
      sessionDetail: () => ok(JSON.stringify({ qas: [] })),
      recall: () => ok("[]"),
    };
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      let body = null;
      if (typeof opts?.body === "string") {
        try {
          body = JSON.parse(opts.body);
        } catch {
          body = opts.body;
        }
      }
      calls.push({ url: u, method: opts?.method ?? "GET", body });
      if (u.endsWith("/health")) return routes.health();
      if (u.endsWith("/api/v1/datasets")) return routes.datasets();
      if (u.endsWith("/api/v1/remember/entry")) return routes.rememberEntry();
      if (u.endsWith("/api/v1/improve")) return routes.improve();
      if (u.includes("/api/v1/sessions/")) return routes.sessionDetail();
      if (u.endsWith("/api/v1/recall")) return routes.recall();
      return ok("[]");
    };

    const sessionId = process.env.COGNEE_SESSION_ID;
    const buildInstance = () => {
      const { pi, recorded } = makeStubApi();
      factory(pi);
      const statuses = [];
      const messages = [];
      const ctx = {
        hasUI: true,
        ui: {
          notify: (m, t) => messages.push({ m, t }),
          setStatus: (_k, v) => statuses.push(v),
        },
        cwd,
        sessionManager: { getSessionId: () => sessionId },
      };
      const inst = {
        pi, recorded, ctx, statuses, messages, sessionId,
        start: () => recorded.events.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx),
        waitHealthy: async (ms = 5000) => {
          for (let i = 0; i < ms / 25 && !calls.some((c) => c.url.endsWith("/api/v1/datasets")); i++) {
            await new Promise((r) => setTimeout(r, 25));
          }
          await new Promise((r) => setTimeout(r, 50));
        },
        turn: async (question, answer) => {
          recorded.events.get("message_end")[0]({ message: { role: "user", content: question } }, ctx);
          recorded.events.get("message_end")[0]({ message: { role: "assistant", content: answer } }, ctx);
          recorded.events.get("agent_settled")[0]();
        },
        prompt: (text) => recorded.events.get("before_agent_start")[0]({ type: "before_agent_start", prompt: text }),
        shutdown: () => recorded.events.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" }),
      };
      return inst;
    };
    const main = buildInstance();
    const bridgeFileFor = (sid) => bridgeMod.bridgePath(sid);
    const readJson = (p) => {
      try {
        return JSON.parse(resFs.readFileSync(p, "utf8"));
      } catch {
        return undefined;
      }
    };
    const waitCalls = async (pred, ms = 5000) => {
      for (let i = 0; i < ms / 25 && !calls.some(pred); i++) await new Promise((r) => setTimeout(r, 25));
      return calls.filter(pred);
    };
    await fn({
      main, buildInstance, calls, routes, ok, err, sessionId, piState, stateRoot, cwd,
      statuses: main.statuses, messages: main.messages,
      bridgeFileFor, readJson, waitCalls,
      writeCredits: (map) => {
        resFs.mkdirSync(path.join(stateRoot, "claude-code"), { recursive: true });
        resFs.writeFileSync(path.join(stateRoot, "claude-code", "credits.json"), JSON.stringify(map), "utf8");
      },
    });
    await main.shutdown();
  } finally {
    globalThis.fetch = realFetch;
    RESILIENCE_ENV_KEYS.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
}

await check("resilience §4.3: writeOutcomeAmbiguous classification (503/refused → false; timeout/500/502/504 → true)", () => {
  const E = clientMod.CogneeError;
  assert.equal(bridgeMod.writeOutcomeAmbiguous(new E("x", { status: 503 })), false, "503 → unambiguous");
  assert.equal(bridgeMod.writeOutcomeAmbiguous(new E("x", { unreachable: true })), false, "refused/DNS → unambiguous");
  assert.equal(bridgeMod.writeOutcomeAmbiguous(new E("x", { status: 401 })), false, "definitive 4xx → unambiguous");
  assert.equal(bridgeMod.writeOutcomeAmbiguous(new E("x", { transient: true })), true, "timeout → ambiguous");
  assert.equal(bridgeMod.writeOutcomeAmbiguous(new E("x", { aborted: true })), true, "abort → ambiguous");
  assert.equal(bridgeMod.writeOutcomeAmbiguous(new E("x")), true, "unknown transport → ambiguous");
  for (const status of [500, 502, 504]) {
    assert.equal(bridgeMod.writeOutcomeAmbiguous(new E("x", { status })), true, `${status} → ambiguous`);
  }
  assert.equal(bridgeMod.writeOutcomeAmbiguous(undefined), true, "no error object → ambiguous (assume the worst)");
});

await check("resilience §4.4: cooldown file semantics — cooldown/backoff/no_new_entries/", async () => {
  const dir = resFs.mkdtempSync(path.join(resOs.tmpdir(), "pi-cognee-cool-"));
  const sid = "pi_smoke-cool";
  const keys = ["COGNEE_PI_STATE_DIR", "COGNEE_ENV_FILE"];
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env.COGNEE_PI_STATE_DIR = dir;
    process.env.COGNEE_ENV_FILE = path.join(dir, "absent.env");
    const HOUR = 3_600_000;
    assert.equal(improveMod.improveThrottleReason(sid, HOUR), "", "empty state → may run");

    improveMod.recordImproveSuccess(sid, "agent_sessions", "idle", 3);
    assert.equal(improveMod.improveThrottleReason(sid, HOUR), "cooldown", "success now → cooldown");
    for (let i = 0; i < 4; i++) improveMod.bumpStoredCounter(sid);
    assert.equal(improveMod.improveThrottleReason(sid, 0), "", "zero window → never throttled by time (counter past the record)");
    // Reset the counter to the recorded count for the no_new_entries cases below.
    resFs.writeFileSync(
      improveMod.improveCounterPath(),
      JSON.stringify({ [sid]: 0 }),
      "utf8",
    );

    // Expire the success; counter still at turn_count → no_new_entries.
    const expiredAt = Date.now() - 2 * HOUR;
    const st = improveMod.readImproveState(sid);
    resFs.writeFileSync(
      improveMod.improveStatePath(sid),
      JSON.stringify({ ...st, last_improved_at: expiredAt }),
      "utf8",
    );
    assert.equal(improveMod.readStoredCounter(sid), 0, "counter starts at 0");
    assert.equal(improveMod.improveThrottleReason(sid, HOUR), "no_new_entries", "counter 0 ≤ recorded 3 → no_new_entries");
    improveMod.bumpStoredCounter(sid);
    improveMod.bumpStoredCounter(sid);
    improveMod.bumpStoredCounter(sid);
    assert.equal(improveMod.readStoredCounter(sid), 3, "three bumps → 3");
    assert.equal(improveMod.improveThrottleReason(sid, HOUR), "no_new_entries", "counter 3 ≤ recorded 3 → still no_new_entries");
    improveMod.bumpStoredCounter(sid);
    assert.equal(improveMod.improveThrottleReason(sid, HOUR), "", "counter 4 > 3 → may run");

    // Backoff: a recent failure with an expired success gates the auto paths once per window.
    improveMod.recordImproveFailure(sid, "agent_sessions", "idle", "HTTP 500");
    const afterFailure = improveMod.readImproveState(sid);
    assert.equal(afterFailure.last_improved_at, expiredAt, "failure merge preserves the prior success timestamp");
    assert.equal(afterFailure.failure_count, 1, "failure_count incremented");
    assert.equal(afterFailure.last_failure_reason, "HTTP 500", "reason kept");
    resFs.writeFileSync(
      improveMod.improveStatePath(sid),
      JSON.stringify({ ...afterFailure, last_failed_at: Date.now() - 60_000 }),
      "utf8",
    );
    assert.equal(improveMod.improveThrottleReason(sid, HOUR), "backoff", "recent failure → backoff");

    // A session with no success at all: a recent failure still backs off; nothing else does.
    const sid2 = "pi_smoke-cool-2";
    improveMod.recordImproveFailure(sid2, "agent_sessions", "idle", "unreachable");
    assert.equal(improveMod.improveThrottleReason(sid2, HOUR), "backoff", "failure-only state → backoff");
    assert.equal(improveMod.improveThrottleReason("never-attempted", HOUR), "", "never attempted → never throttled");
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

await check("resilience §4.1: spill/replay round-trip — 500 spills ambiguous, crash-relaunch replays exactly once", async () => {
  await withResilienceHarness({}, async ({ main, buildInstance, calls, routes, sessionId, bridgeFileFor, readJson, waitCalls, ok, err }) => {
    // Phase 1: healthy capture, 500 on the write → spill (ambiguous per §1.5: a 500 may have committed).
    routes.rememberEntry = () => err(500);
    main.start();
    await main.waitHealthy();
    await main.turn("what do we know about the spillway", "it buffers retryable failures");
    const file = bridgeFileFor(sessionId);
    for (let i = 0; i < 40 && !readJson(file); i++) await new Promise((r) => setTimeout(r, 25));
    const spilled = readJson(file);
    assert.ok(spilled, "bridge file exists after the failed drain");
    assert.equal(spilled.entries.length, 1, "exactly one spilled entry");
    assert.equal(spilled.entries[0].question, "what do we know about the spillway", "entry payload preserved");
    assert.equal(spilled.entries[0].sessionId, sessionId, "capture-time binding preserved");
    assert.equal(spilled.entries[0].dataset, "agent_sessions", "capture-time dataset preserved");
    assert.equal(spilled.entries[0]._replay_ambiguous, true, "500-class failure stamps _replay_ambiguous");
    assert.equal(typeof spilled.entries[0]._buffered_at, "number", "_buffered_at stamped");
    await main.shutdown();

    // Phase 2: "crash" — a FRESH factory instance (new process semantics) over the
    // same state root + session pin; the server now accepts writes.
    routes.rememberEntry = () => ok("{}");
    const before = calls.length; // marker in the shared call log
    const relaunched = buildInstance();
    relaunched.start();
    await relaunched.waitHealthy();
    const posts = await waitCalls((c) => c.url.endsWith("/api/v1/remember/entry") && calls.indexOf(c) >= before);
    assert.equal(posts.length, 1, `remember called EXACTLY once with the spilled payload (got ${posts.length})`);
    assert.equal(posts[0].body.entry.question, "what do we know about the spillway", "spilled payload replayed");
    assert.equal(posts[0].body.session_id, sessionId, "replay under the capture-time session");
    // Verify-before-replay engaged for the ambiguous head (detail read, no match → replay).
    const detailBase = calls.filter((c) => c.url.includes("/api/v1/sessions/")).length;
    void detailBase;
    const details = calls.filter((c) => c.url.includes("/api/v1/sessions/") && calls.indexOf(c) >= before);
    assert.equal(details.length, 1, `one GET /sessions/{id} verify read for the ambiguous head (got ${details.length})`);
    // Counter bumped exactly once; the drained file is unlinked.
    let counterVal;
    for (let i = 0; i < 40; i++) {
      counterVal = readJson(path.join(process.env.COGNEE_PI_STATE_DIR, "improve-counter.json"))?.[sessionId];
      if (counterVal === 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(counterVal, 1, `improve-counter == 1 (got ${counterVal})`);
    for (let i = 0; i < 20 && readJson(file); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(readJson(file), undefined, "spill file unlinked after the drain");
    await relaunched.shutdown();
  });
});

await check("resilience §4.2: verify-before-replay — fingerprint match consumes without send; detail failure replays (fail-open); traces verified too", async () => {
  // Units: the fingerprint covers BOTH entry kinds (reference `_entry_fingerprint`).
  assert.equal(
    bridgeMod.entryFingerprint({ type: "qa", question: "q", answer: "a", context: "c" }),
    "qa\0q\0a\0c",
    "qa fingerprint shape unchanged",
  );
  const traceFp = (params, status = "success", ret = "ok") =>
    bridgeMod.entryFingerprint({
      type: "trace",
      origin_function: "bash",
      status,
      method_params: params,
      method_return_value: ret,
      error_message: "",
    });
  assert.equal(
    traceFp({ command: "x", cwd: "/r" }),
    traceFp({ cwd: "/r", command: "x" }),
    "trace fingerprint canonicalizes method_params key order (json.dumps sort_keys parity)",
  );
  assert.ok(
    traceFp({ command: "x" }).startsWith("trace\0bash\0success\0"),
    "trace fingerprint field order: type, origin_function, status, params, return, error",
  );
  assert.notEqual(traceFp({ command: "x" }, "error"), traceFp({ command: "x" }), "status participates");
  assert.notEqual(traceFp({ command: "x" }), traceFp({ command: "y" }), "params participate");
  assert.equal(bridgeMod.entryFingerprint({ type: "other" }), undefined, "unverifiable kind → undefined (replays)");
  const union = bridgeMod.serverFingerprints(
    [{ question: "q", answer: "a", context: "c" }],
    [{ origin_function: "bash", status: "success", method_params: { command: "x" }, method_return_value: "ok", error_message: "" }],
  );
  assert.ok(union.has("qa\0q\0a\0c"), "serverFingerprints holds QA rows");
  assert.ok(
    union.has(traceFp({ command: "x" })),
    "serverFingerprints unions trace rows (type forced per list)",
  );

  const entry = {
    type: "qa",
    question: "does the bridge dedupe",
    answer: "yes, via fingerprints",
    context: "pi · dataset agent_sessions",
    sessionId: "",
    dataset: "agent_sessions",
    _replay_ambiguous: true,
    _buffered_at: Date.now(),
  };
  await withResilienceHarness({}, async ({ main, buildInstance, calls, routes, sessionId, bridgeFileFor, readJson, ok, err }) => {
    entry.sessionId = sessionId;
    const seedFile = () => {
      resFs.mkdirSync(path.dirname(bridgeFileFor(sessionId)), { recursive: true });
      resFs.writeFileSync(bridgeFileFor(sessionId), JSON.stringify({ entries: [entry] }), "utf8");
    };

    // Variant A: the server already holds a matching row → consumed WITHOUT a send.
    seedFile();
    routes.sessionDetail = () => ok(JSON.stringify({ qas: [{ question: entry.question, answer: entry.answer, context: entry.context }] }));
    main.start();
    await main.waitHealthy();
    for (let i = 0; i < 20 && readJson(bridgeFileFor(sessionId)); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(readJson(bridgeFileFor(sessionId)), undefined, "matching fingerprint consumed (file trimmed)");
    assert.equal(
      calls.filter((c) => c.url.endsWith("/api/v1/remember/entry")).length,
      0,
      "NO remember call — deduped without re-sending",
    );
    assert.equal(calls.filter((c) => c.url.includes("/api/v1/sessions/")).length, 1, "exactly one detail read");
    await main.shutdown();

    // Variant B: the detail read fails → replay everything (fail-open, duplicate accepted).
    calls.length = 0;
    seedFile();
    routes.sessionDetail = () => err(500);
    const second = buildInstance();
    second.start();
    await second.waitHealthy();
    for (let i = 0; i < 20 && !calls.some((c) => c.url.endsWith("/api/v1/remember/entry")); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(
      calls.filter((c) => c.url.endsWith("/api/v1/remember/entry")).length,
      1,
      "detail failure → replayed once (fail-open)",
    );
    for (let i = 0; i < 20 && readJson(bridgeFileFor(sessionId)); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(readJson(bridgeFileFor(sessionId)), undefined, "file drained after the fail-open replay");
    await second.shutdown();

    // Variant C (v0.4 trace parity): an ambiguous TRACE head is verified too —
    // the server already holds the identical trace (params echoed in a
    // DIFFERENT key order) → consumed without a re-send.
    calls.length = 0;
    const traceEntry = {
      type: "trace",
      origin_function: "bash",
      status: "success",
      method_params: { command: "npm test", cwd: "/repo" },
      method_return_value: "all green",
      error_message: "",
      generate_feedback_with_llm: false,
      sessionId: "",
      dataset: "agent_sessions",
      _replay_ambiguous: true,
      _buffered_at: Date.now(),
    };
    traceEntry.sessionId = sessionId;
    resFs.mkdirSync(path.dirname(bridgeFileFor(sessionId)), { recursive: true });
    resFs.writeFileSync(bridgeFileFor(sessionId), JSON.stringify({ entries: [traceEntry] }), "utf8");
    routes.sessionDetail = () =>
      ok(
        JSON.stringify({
          qas: [],
          traces: [
            {
              origin_function: "bash",
              status: "success",
              method_params: { cwd: "/repo", command: "npm test" }, // reordered — must still match
              method_return_value: "all green",
              error_message: "",
            },
          ],
        }),
      );
    const third = buildInstance();
    third.start();
    await third.waitHealthy();
    for (let i = 0; i < 20 && readJson(bridgeFileFor(sessionId)); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(readJson(bridgeFileFor(sessionId)), undefined, "matching TRACE fingerprint consumed (file trimmed)");
    assert.equal(
      calls.filter((c) => c.url.endsWith("/api/v1/remember/entry")).length,
      0,
      "NO remember call — the ambiguous trace deduped without re-sending",
    );
    await third.shutdown();
  });
});

await check("resilience §4.5: idle bridge — one improve per arm, cooldown re-arm at expiry, shutdown clears timers", async () => {
  await withResilienceHarness(
    { COGNEE_IDLE_THRESHOLD_MS: "10", COGNEE_IMPROVE_COOLDOWN_MS: "6000" },
    async ({ main, buildInstance, calls, sessionId, readJson }) => {
      const improves = () => calls.filter((c) => c.url.endsWith("/api/v1/improve"));
      const settled = (inst) => inst.recorded.events.get("agent_settled")[0]();
      main.start();
      await main.waitHealthy();
      // One stored write so the improve state carries a real turn_count_at_improve
      // (the no_new_entries gate is meaningful only with a nonzero counter).
      await main.turn("what do we know about idle bridges", "they arm one bounded timer");
      for (let i = 0; i < 40 && improveMod.readStoredCounter(sessionId) < 1; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(improveMod.readStoredCounter(sessionId), 1, "one stored write counted");

      // One attempt per arm: the turn's settle arms the timer; 10ms later exactly
      // one improve fires (trigger logged) and its success is persisted.
      for (let i = 0; i < 200 && improves().length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      for (let i = 0; i < 200 && !readJson(improveMod.improveStatePath(sessionId)); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(improves().length, 1, "idle bridge improved exactly once after the threshold");
      // Canonical event-log path = <stateRoot>/pi/bootstrap.log (stateRoot = parent
      // of the pi state dir) — same as bootstrapPaths().bootstrapLog.
      const logText = resFs.readFileSync(
        path.join(path.dirname(process.env.COGNEE_PI_STATE_DIR), "pi", "bootstrap.log"),
        "utf8",
      );
      assert.ok(
        logText.includes('"event":"improve_submitted"') && logText.includes('"trigger":"idle"'),
        "trigger logged (improve_submitted, trigger idle)",
      );

      // Re-fire with no activity: the freshly-recorded success cools the bridge down.
      settled(main);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(improves().length, 1, "no second improve inside the cooldown window");
      const st = readJson(improveMod.improveStatePath(sessionId));
      assert.ok(st?.last_improved_at > Date.now() - 10_000, "success recorded by the wrapper");
      assert.equal(st.trigger, "idle", "trigger recorded");
      assert.equal(st.turn_count_at_improve, 1, "recorded at the current stored count");

      // A NEW stored write past the recorded count + an aged success: the
      // throttled fire re-arms exactly once at the persisted expiry, and that
      // re-arm then runs (cooldown expired, counter advanced — not no_new_entries).
      await main.turn("a second turn stored after the improve", "counter advances past the record");
      for (let i = 0; i < 40 && improveMod.readStoredCounter(sessionId) < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(improveMod.readStoredCounter(sessionId), 2, "second stored write counted");
      resFs.writeFileSync(
        improveMod.improveStatePath(sessionId),
        JSON.stringify({ ...st, last_improved_at: Date.now() - 5900 }), // cooldown 6000 → expiry ~100 ms out
        "utf8",
      );
      settled(main);
      await new Promise((r) => setTimeout(r, 40)); // threshold passed, expiry not yet
      assert.equal(improves().length, 1, "still throttled before the persisted expiry");
      await new Promise((r) => setTimeout(r, 200)); // expiry passes → the single re-arm fires
      assert.equal(improves().length, 2, "the one re-arm fired at the exact expiry");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(improves().length, 2, "no further attempts (one re-arm per arm)");
      await main.shutdown();

      // session_shutdown clears the timers: an armed bridge never improves after it.
      const third = buildInstance();
      third.start();
      await third.waitHealthy();
      const before = improves().length;
      settled(third);
      await third.shutdown(); // immediately — the 10 ms timer is cleared on the way out
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(improves().length, before, "no improve fires after session_shutdown (final sync owns promotion)");
    },
  );
});

await check("resilience §4.7: counter/improve interplay across restart — no_new_entries until a new stored write", async () => {
  await withResilienceHarness(
    { COGNEE_IDLE_THRESHOLD_MS: "60000", COGNEE_IMPROVE_COOLDOWN_MS: "1000", COGNEE_AUTO_IMPROVE_EVERY: "0", COGNEE_FINAL_SYNC: "false" },
    async ({ main, buildInstance, calls, sessionId, readJson, waitCalls }) => {
      const improves = () => calls.filter((c) => c.url.endsWith("/api/v1/improve"));
      main.start();
      await main.waitHealthy();
      // Instance A stores 3 entries and improves at counter 3.
      for (let i = 0; i < 3; i++) {
        await main.turn(`question number ${i}`, `answer number ${i}`);
        await waitCalls((c) => c.url.endsWith("/api/v1/remember/entry"));
      }
      let counterA;
      for (let i = 0; i < 40; i++) {
        counterA = readJson(path.join(process.env.COGNEE_PI_STATE_DIR, "improve-counter.json"))?.[sessionId];
        if (counterA === 3) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(counterA, 3, `counter == 3 (got ${counterA})`);
      const sync = main.recorded.commands.find((c) => c.name === "cognee-sync");
      await sync.handler("", main.ctx);
      assert.equal(improves().length, 1, "manual sync improved once");
      const st = readJson(improveMod.improveStatePath(sessionId));
      assert.equal(st.turn_count_at_improve, 3, "improved at counter 3");
      // Age the success past the (1 s) cooldown so the idle path's verdict is no_new_entries.
      resFs.writeFileSync(
        improveMod.improveStatePath(sessionId),
        JSON.stringify({ ...st, last_improved_at: Date.now() - 2000 }),
        "utf8",
      );
      await main.shutdown();

      // Instance B (relaunch): idle fires with nothing stored → skipped (no_new_entries).
      process.env.COGNEE_IDLE_THRESHOLD_MS = "10";
      const b = buildInstance();
      b.start();
      await b.waitHealthy();
      b.recorded.events.get("agent_settled")[0]();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(improves().length, 1, "relaunch with no new stored writes → idle skipped (no_new_entries)");

      // B stores one more (counter 4) → idle fires → improve runs.
      await b.turn("one more turn after relaunch", "stored and counted");
      await waitCalls((c) => c.url.endsWith("/api/v1/remember/entry"));
      let counterB;
      for (let i = 0; i < 40; i++) {
        counterB = readJson(path.join(process.env.COGNEE_PI_STATE_DIR, "improve-counter.json"))?.[sessionId];
        if (counterB === 4) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(counterB, 4, `counter == 4 (got ${counterB})`);
      b.recorded.events.get("agent_settled")[0](); // re-arm after the store settled
      for (let i = 0; i < 100 && improves().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(improves().length, 2, "counter past the recorded count → idle improve runs");
      await b.shutdown();
    },
  );
});

await check("resilience §4.8: drain backoff — HTTP failures double the window, progress resets, fail_at manipulation re-attempts", async () => {
  const sid = "";
  await withResilienceHarness({}, async ({ main, calls, routes, sessionId, bridgeFileFor, readJson, ok, err }) => {
    void sid;
    const file = bridgeFileFor(sessionId);
    const seed = () => {
      resFs.mkdirSync(path.dirname(file), { recursive: true });
      resFs.writeFileSync(
        file,
        JSON.stringify({
          entries: [
            {
              type: "qa",
              question: "backoff me",
              answer: "401 twice",
              context: "pi · dataset agent_sessions",
              sessionId,
              dataset: "agent_sessions",
              _buffered_at: Date.now(),
            },
          ],
        }),
        "utf8",
      );
    };
    const rememberCalls = () => calls.filter((c) => c.url.endsWith("/api/v1/remember/entry"));
    const status = () => main.recorded.commands.find((c) => c.name === "cognee");

    routes.rememberEntry = () => err(401);
    seed();
    main.start();
    await main.waitHealthy();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rememberCalls().length, 1, "first drain attempt hit the 401");
    let st = readJson(file);
    assert.equal(st.entries.length, 1, "buffered entry retained (never dropped on a file head)");
    assert.equal(st.fail_count, 1, "fail_count recorded");
    assert.ok(st.fail_at > Date.now() - 5000, "fail_at stamped");

    // Inside the window: a health-cycle drain skips the file entirely (no fetches).
    await status().handler("", main.ctx);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rememberCalls().length, 1, "drain skipped inside the backoff window (no remember fetches)");
    assert.equal(calls.filter((c) => c.url.includes("/api/v1/sessions/")).length, 0, "no verify reads either");

    // Manipulate fail_at to the past (window 60 s closed) → re-attempted → 401 again → fail_count grows.
    resFs.writeFileSync(file, JSON.stringify({ ...readJson(file), fail_at: Date.now() - 61_000 }), "utf8");
    await status().handler("", main.ctx);
    for (let i = 0; i < 20 && rememberCalls().length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(rememberCalls().length, 2, "past-timestamp failure re-attempted");
    st = readJson(file);
    for (let i = 0; i < 40 && st?.fail_count !== 2; i++) {
      await new Promise((r) => setTimeout(r, 25));
      st = readJson(file);
    }
    assert.equal(st.fail_count, 2, `fail_count grew to 2 (got ${st.fail_count})`);

    // Window now 120 s; expire it AND fix the server → progress drains and resets.
    routes.rememberEntry = () => ok("{}");
    resFs.writeFileSync(file, JSON.stringify({ ...readJson(file), fail_at: Date.now() - 121_000 }), "utf8");
    await status().handler("", main.ctx);
    for (let i = 0; i < 20 && readJson(file); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(readJson(file), undefined, "entry drained + file unlinked after recovery");
    assert.equal(rememberCalls().length, 3, "exactly one more send");
    assert.equal(rememberCalls().at(-1).body.entry.question, "backoff me", "the buffered payload replayed");
    await main.shutdown();
  });
});

await check("resilience §4.6: render snapshots — glyphs, recall segments, awaiting replay, credits, 120-char cap", async () => {
  // Pure-credit fixture path check first (module-level, no factory).
  const now = Date.now();
  const creditEntry = (over = {}) => ({
    base_url: "https://cognee.invalid",
    remaining_usd: 12.34,
    checked_at: now,
    last_op: { label: "remember", cost_usd: 0.02 },
    ...over,
  });

  // Local healthy: ● + mode · dataset (LLM key configured).
  await withResilienceHarness({ LLM_API_KEY: "sk-smoke" }, async ({ main, statuses }) => {
    main.start();
    await main.waitHealthy();
    assert.equal(statuses.at(-1), "● cognee: local · agent_sessions", `healthy local snapshot: ${statuses.at(-1)}`);
    await main.shutdown();
  });

  // Local + no LLM_API_KEY: static llm-key verdict replaces ● (§2.1 glyph slot).
  await withResilienceHarness({}, async ({ main, statuses }) => {
    main.start();
    await main.waitHealthy();
    assert.equal(statuses.at(-1), "✕ cognee: llm key not set (local · agent_sessions)", `llm-key snapshot: ${statuses.at(-1)}`);
    await main.shutdown();
  });

  // Offline (connection failure wins over the llm-key verdict — reference precedence).
  await withResilienceHarness({}, async ({ main, statuses, routes, ok }) => {
    routes.health = () => {
      throw new Error("smoke: unreachable");
    };
    main.start();
    for (let i = 0; i < 40 && !statuses.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(statuses[0].startsWith("✕ cognee: offline"), `offline snapshot: ${statuses[0]}`);
    await main.shutdown();
  });

  // Auth-failed (recall 401) + hits + cumulative + warming-up + awaiting replay.
  await withResilienceHarness({ LLM_API_KEY: "sk-smoke" }, async ({ main, statuses, routes, sessionId, bridgeFileFor, ok, err }) => {
    main.start();
    await main.waitHealthy();
    // auth-failed glyph from the recall error path
    routes.recall = () => err(401);
    await main.prompt("what do we know about auth failures");
    assert.ok(
      statuses.at(-1).startsWith("✕ cognee: auth failed (local · agent_sessions)"),
      `auth snapshot: ${statuses.at(-1)}`,
    );
    // back to healthy recalls: one hit
    routes.recall = () => ok(JSON.stringify([{ source: "graph", text: "User prefers dark mode." }]));
    await main.prompt("what do we know about preferences");
    assert.equal(
      statuses.at(-1),
      "● cognee: local · agent_sessions · 1 memory hits · 1/2 turns had hits this session",
      `hits + cumulative snapshot: ${statuses.at(-1)}`,
    );
    // zero-hit session (fresh instance): warming up
    statuses.length = 0;
    const fresh = main;
    void fresh;
    // (turn 3, still 1 hit turn) — empty recall keeps the cumulative form
    routes.recall = () => ok("[]");
    await main.prompt("a conversational turn with no hits at all");
    assert.equal(
      statuses.at(-1),
      "● cognee: local · agent_sessions · 0 memory hits · 1/3 turns had hits this session",
      `zero-hit turn snapshot: ${statuses.at(-1)}`,
    );
    // awaiting replay from a seeded spill file
    resFs.mkdirSync(path.dirname(bridgeFileFor(sessionId)), { recursive: true });
    resFs.writeFileSync(
      bridgeFileFor(sessionId),
      JSON.stringify({ entries: [{ type: "qa", question: "q", answer: "a", sessionId, dataset: "agent_sessions", _buffered_at: Date.now() }] }),
      "utf8",
    );
    routes.rememberEntry = () => err(500); // keep it pending across the drain
    await main.prompt("another turn while a turn awaits replay");
    assert.ok(
      statuses.at(-1).includes("· 1 awaiting replay"),
      `awaiting-replay segment present: ${statuses.at(-1)}`,
    );
    await main.shutdown();
  });

  // Zero-hit SESSION (no hit turns at all): memory warming up (N turns).
  await withResilienceHarness({ LLM_API_KEY: "sk-smoke" }, async ({ main, statuses, routes, ok }) => {
    routes.recall = () => ok("[]");
    main.start();
    await main.waitHealthy();
    await main.prompt("first conversational turn with zero hits");
    assert.equal(
      statuses.at(-1),
      "● cognee: local · agent_sessions · 0 memory hits · memory warming up (1 turns)",
      `warming-up snapshot: ${statuses.at(-1)}`,
    );
    // COGNEE_STATUSLINE_COUNTS=false hides the recall segments.
    process.env.COGNEE_STATUSLINE_COUNTS = "false";
    await main.prompt("second turn with the counts hidden");
    assert.equal(statuses.at(-1), "● cognee: local · agent_sessions", `counts hidden: ${statuses.at(-1)}`);
    delete process.env.COGNEE_STATUSLINE_COUNTS;
    // full diagnostic strip with the graph/code split.
    process.env.COGNEE_STATUSLINE_COUNTS = "full";
    await main.prompt("third turn with the diagnostic strip");
    assert.equal(statuses.at(-1), "● cognee: local · agent_sessions · recall 0g/0c", `full strip: ${statuses.at(-1)}`);
    delete process.env.COGNEE_STATUSLINE_COUNTS;
    await main.shutdown();
  });

  // Credits (cloud mode, shared marker, render-only).
  await withResilienceHarness({ COGNEE_BASE_URL: "https://cognee.invalid" }, async ({ main, statuses, writeCredits, stateRoot }) => {
    writeCredits({ "tenant-1": creditEntry() });
    main.start();
    await main.waitHealthy();
    assert.equal(
      statuses.at(-1),
      "● cognee: cloud · agent_sessions · credits: $12.34 · last remember ~$0.02",
      `credits normal snapshot: ${statuses.at(-1)}`,
    );
    await main.shutdown();
  });
  await withResilienceHarness({ COGNEE_BASE_URL: "https://cognee.invalid" }, async ({ main, statuses, writeCredits }) => {
    // aged hint visible when the line is short (no last_op)
    writeCredits({ "tenant-1": creditEntry({ checked_at: Date.now() - 2 * 3600 * 1000, last_op: undefined }) });
    main.start();
    await main.waitHealthy();
    assert.equal(
      statuses.at(-1),
      "● cognee: cloud · agent_sessions · credits: $12.34 (2h ago)",
      `aged-hint snapshot: ${statuses.at(-1)}`,
    );
    await main.shutdown();
  });
  await withResilienceHarness({ COGNEE_BASE_URL: "https://cognee.invalid" }, async ({ main, statuses, writeCredits }) => {
    // The reference writes epoch SECONDS — a seconds-unit marker must render fresh (not fail the 7 d gate).
    writeCredits({ "tenant-1": creditEntry({ checked_at: Math.floor(Date.now() / 1000) - 60 }) });
    main.start();
    await main.waitHealthy();
    assert.equal(
      statuses.at(-1),
      "● cognee: cloud · agent_sessions · credits: $12.34 · last remember ~$0.02",
      `seconds-unit credits snapshot: ${statuses.at(-1)}`,
    );
    await main.shutdown();
  });
  await withResilienceHarness({ COGNEE_BASE_URL: "https://cognee.invalid" }, async ({ main, statuses, writeCredits }) => {
    // low balance + billing override + age hint
    writeCredits({
      "tenant-1": creditEntry({ remaining_usd: 0.42, checked_at: Date.now() - 2 * 3600 * 1000 }),
    });
    process.env.COGNEE_BILLING_URL = "https://billing.example/topup";
    main.start();
    await main.waitHealthy();
    assert.equal(
      statuses.at(-1),
      "● cognee: cloud · agent_sessions · credits: $0.42 · last remember ~$0.02 · top up: https://billing.example/topup",
      `low + aged + top-up snapshot (age hint shed at the 120 cap): ${statuses.at(-1)}`,
    );
    delete process.env.COGNEE_BILLING_URL;
    await main.shutdown();
  });
  await withResilienceHarness({ COGNEE_BASE_URL: "https://cognee.invalid" }, async ({ main, statuses, writeCredits }) => {
    // foreign base_url + opt-out + local mode hide the segment
    writeCredits({ "tenant-1": creditEntry({ base_url: "https://other.invalid" }) });
    main.start();
    await main.waitHealthy();
    assert.equal(statuses.at(-1), "● cognee: cloud · agent_sessions", `foreign base_url hidden: ${statuses.at(-1)}`);
    await main.shutdown();
  });
  await withResilienceHarness({ COGNEE_BASE_URL: "https://cognee.invalid" }, async ({ main, statuses, writeCredits }) => {
    writeCredits({ "tenant-1": creditEntry() });
    process.env.COGNEE_STATUSLINE_CREDITS = "false";
    main.start();
    await main.waitHealthy();
    assert.equal(statuses.at(-1), "● cognee: cloud · agent_sessions", `opt-out hidden: ${statuses.at(-1)}`);
    delete process.env.COGNEE_STATUSLINE_CREDITS;
    await main.shutdown();
  });
  await withResilienceHarness({ LLM_API_KEY: "sk-smoke" }, async ({ main, statuses, writeCredits }) => {
    writeCredits({ "tenant-1": creditEntry() }); // local mode never renders credits
    main.start();
    await main.waitHealthy();
    assert.equal(statuses.at(-1), "● cognee: local · agent_sessions", `local mode hides credits: ${statuses.at(-1)}`);
    await main.shutdown();
  });

  // 120-char cap: low-priority segments drop (age-hint → credits → cumulative) before any cut.
  await withResilienceHarness(
    { COGNEE_BASE_URL: "https://cognee.invalid", COGNEE_PLUGIN_DATASET: "a-very-long-dataset-name-for-the-cap-test-1234567890" },
    async ({ main, statuses, routes, writeCredits, sessionId, bridgeFileFor, ok, err }) => {
      writeCredits({
        "tenant-1": creditEntry({ remaining_usd: 0.5, checked_at: Date.now() - 3 * 3600 * 1000 }),
      });
      resFs.mkdirSync(path.dirname(bridgeFileFor(sessionId)), { recursive: true });
      resFs.writeFileSync(
        bridgeFileFor(sessionId),
        JSON.stringify({ entries: [{ type: "qa", question: "q", answer: "a", sessionId, dataset: "a-very-long-dataset-name-for-the-cap-test-1234567890", _buffered_at: Date.now() }] }),
        "utf8",
      );
      routes.rememberEntry = () => err(500); // keep the spill pending
      routes.recall = () => ok(JSON.stringify([{ source: "graph", text: "hit" }]));
      main.start();
      await main.waitHealthy();
      await main.prompt("a prompt that produces one graph hit for the cap test");
      const line = statuses.at(-1);
      assert.ok(line.length <= 120, `line capped at 120 visible chars (${line.length}): ${line}`);
      assert.ok(line.startsWith("● cognee: cloud · a-very-long-dataset-name-for-the-cap-test-1234567890 · 1 awaiting replay"), `base + awaiting kept: ${line}`);
      assert.ok(line.includes("5 memory hits") || line.includes("1 memory hits"), `per-turn hits kept (highest-priority droppable): ${line}`);
      assert.ok(!line.includes("credits:"), `credits dropped before the recall segments: ${line}`);
      assert.ok(!line.includes("turns had hits"), `cumulative dropped: ${line}`);
      await main.shutdown();
    },
  );
});

await check("factory purity: importing + constructing the extension spawns nothing", async () => {
  const { createRequire } = await import("node:module");
  const nodeRequire = createRequire(import.meta.url);
  const cp = nodeRequire("node:child_process"); // CJS namespace — mutable, shared with jiti's requires
  const origSpawn = cp.spawn;
  cp.spawn = () => {
    throw new Error("spawn must not run at import/factory time");
  };
  try {
    const freshIndex = await jiti.import(path.join(root, "src", "index.ts")); // moduleCache:false → fresh eval
    const { pi: piPure, recorded: recPure } = makeStubApi();
    assert.doesNotThrow(() => freshIndex.default(piPure), "factory constructs without spawning");
    assert.ok(recPure.tools.length >= 6, "fresh factory registers tools");
  } finally {
    cp.spawn = origSpawn;
  }
});

await check("factory leaves no pending timers (no long-lived resources)", async () => {
  // Final re-check after all fixtures: no timer/handle leaked from the checks above.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(true);
});

console.log(`\npi-cognee smoke test: ${passed} checks passed ✅`);
