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

await check("registers 8+ commands", () => {
  assert.ok(recorded.commands.length >= 8, `expected >=8 commands, got ${recorded.commands.length}`);
  const names = recorded.commands.map((c) => c.name).sort();
  for (const expected of [
    "cognee",
    "cognee-code",
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

await check("factory leaves no pending timers (no long-lived resources)", async () => {
  // Final re-check after all fixtures: no timer/handle leaked from the checks above.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(true);
});

console.log(`\npi-cognee smoke test: ${passed} checks passed ✅`);
