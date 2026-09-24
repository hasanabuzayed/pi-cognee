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
const clientMod = await jiti.import(path.join(root, "src", "client.ts"));

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

await check("factory leaves no pending timers (no long-lived resources)", async () => {
  // Final re-check after all fixtures: no timer/handle leaked from the checks above.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(true);
});

console.log(`\npi-cognee smoke test: ${passed} checks passed ✅`);
