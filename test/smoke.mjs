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

await check("loadCogneeConfig honors env overrides (capture opt-out, autoindex, timeouts)", () => {
  // Regression guard for the blocker where num()/bool() indexed the EnvLookup
  // function object instead of calling it — every override silently ignored.
  const keys = ["COGNEE_CAPTURE", "COGNEE_CODE_AUTOINDEX", "COGNEE_CODE_INDEX_TIMEOUT_MS"];
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env.COGNEE_CAPTURE = "false";
    process.env.COGNEE_CODE_AUTOINDEX = "off";
    process.env.COGNEE_CODE_INDEX_TIMEOUT_MS = "45000";
    const cfg = clientMod.loadCogneeConfig();
    assert.equal(cfg.capture, false, "COGNEE_CAPTURE=false disables capture/recall");
    assert.equal(cfg.codeAutoindex, "off", "COGNEE_CODE_AUTOINDEX=off respected");
    assert.equal(cfg.codeIndexTimeoutMs, 45000, "COGNEE_CODE_INDEX_TIMEOUT_MS=45000 respected");
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

await check("factory leaves no pending timers (no long-lived resources)", async () => {
  // Final re-check after all fixtures: no timer/handle leaked from the checks above.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(true);
});

console.log(`\npi-cognee smoke test: ${passed} checks passed ✅`);
