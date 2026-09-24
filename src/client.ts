/**
 * pi-cognee — HTTP client for the cognee memory server.
 *
 * Node 18+ only: global fetch / FormData / Blob. No npm dependencies.
 *
 * Contract source: research/codex-api-brief.md (byte-identical HTTP layer shared by
 * the official Claude Code and Codex cognee plugins).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class CogneeError extends Error {
  readonly status?: number;
  /** Timeout / unknown transport outcome — neither success nor breaker-eligible failure. */
  readonly transient?: boolean;
  /** Positively absent server (refused / DNS / unroutable). */
  readonly unreachable?: boolean;
  readonly aborted?: boolean;

  constructor(
    message: string,
    opts: { status?: number; transient?: boolean; unreachable?: boolean; aborted?: boolean } = {},
  ) {
    super(message);
    this.name = "CogneeError";
    this.status = opts.status;
    this.transient = opts.transient;
    this.unreachable = opts.unreachable;
    this.aborted = opts.aborted;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

export function wrapAsCogneeError(err: unknown): CogneeError {
  if (err instanceof CogneeError) return err;
  return new CogneeError(describeError(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Env file (~/.cognee/.env) — shared with the Claude Code / Codex plugins */
/* ------------------------------------------------------------------ */

/** Keys we never import from the env file (same denylist as the official plugins). */
const ENV_FILE_DENYLIST = /^(PATH|HOME|SHELL|USER|PYTHON\w*|LD_.+|DYLD_.+)$/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!key || ENV_FILE_DENYLIST.test(key)) continue;
    out[key] = value; // last wins
  }
  return out;
}

export interface EnvFileResult {
  path: string;
  exists: boolean;
  values: Record<string, string>;
}

export function loadCogneeEnvFile(): EnvFileResult {
  const path = process.env.COGNEE_ENV_FILE || join(homedir(), ".cognee", ".env");
  try {
    const text = readFileSync(path, "utf8");
    return { path, exists: true, values: parseEnvFile(text) };
  } catch {
    return { path, exists: false, values: {} };
  }
}

/* ------------------------------------------------------------------ */
/* Owner-key cache (~/.cognee-plugin/api_key.json)                      */
/* Shared with the Claude Code / Codex cognee plugins.                  */
/* ------------------------------------------------------------------ */

const API_KEY_CACHE_DIR = join(homedir(), ".cognee-plugin");
const API_KEY_CACHE_PATH = join(API_KEY_CACHE_DIR, "api_key.json");

/** Cached key file format — identical to the official plugins' save_cached_api_key. */
interface CachedApiKeyFile {
  base_url?: unknown;
  api_key?: unknown;
}

/** Read the cached owner key; only honored when it was minted for this server. */
function loadCachedApiKey(baseUrl: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(API_KEY_CACHE_PATH, "utf8")) as CachedApiKeyFile;
    const key = typeof data.api_key === "string" ? data.api_key.trim() : "";
    if (!key) return undefined;
    const cachedUrl = (typeof data.base_url === "string" ? data.base_url : "").trim().replace(/\/+$/, "");
    if (cachedUrl && cachedUrl !== baseUrl) return undefined; // key belongs to another server
    return key;
  } catch {
    return undefined; // absent or unreadable — fine
  }
}

function saveCachedApiKey(baseUrl: string, key: string): void {
  try {
    mkdirSync(API_KEY_CACHE_DIR, { recursive: true });
    writeFileSync(
      API_KEY_CACHE_PATH,
      JSON.stringify({ base_url: baseUrl, api_key: key, updated_at: new Date().toISOString() }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* fail-soft — the key stays in memory for this session */
  }
}

/** Local-mode quickstart servers live on the loopback interface. Same predicate as the
 *  official plugins' service_url_is_local: consent for auto-index = the code never
 *  leaves this machine, which is a property of the URL host, not the backend label. */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export interface CogneeConfig {
  backend: "local" | "cloud";
  backendForced: boolean;
  /** Forced cloud with no COGNEE_BASE_URL anywhere — never silently falls back to local. */
  missingBaseUrl: boolean;
  baseUrl: string;
  apiKey?: string;
  apiKeySource: "shell env" | "env file" | "cached owner key (~/.cognee-plugin/api_key.json)" | "not set";
  /** Credentials for the lazy local owner-key bootstrap (never logged or exported). */
  authEmail?: string;
  authPassword?: string;
  envFilePath: string;
  envFileExists: boolean;
  envFileKeys: string[];
  shellOverrides: string[];
  /** Default dataset (graph tier). `agent_sessions` is shared with the official plugins. */
  dataset: string;
  sessionIdOverride?: string;
  sessionPrefix: string;
  /** Master switch for automatic capture + auto-recall (explicit tools always work). */
  capture: boolean;
  contextMaxChars: number;
  recallTimeoutMs: number;
  requestTimeoutMs: number;
  healthTimeoutMs: number;
  improveSubmitTimeoutMs: number;
  improveCooldownMs: number;
  autoImproveEvery: number;
  rememberWaitMs: number;
  finalSync: boolean;
  bufferLimit: number;
  breakerThreshold: number;
  breakerWindowMs: number;
  breakerCooldownMs: number;
  /** Code-graph auto-indexing mode: "auto" (local server only) | "always" | "off". */
  codeAutoindex: "auto" | "always" | "off";
  /** Submit timeout for the repo-index POST (background pipelines still confirm slowly). */
  codeIndexTimeoutMs: number;
  /** LLM key pass-through (reported by /cognee-doctor; pi-cognee never boots a server). */
  llmApiKeyConfigured: boolean;
  llmModel?: string;
}

type EnvLookup = (key: string) => string | undefined;

function num(effective: EnvLookup, key: string, fallback: number): number {
  const raw = effective(key);
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(effective: EnvLookup, key: string, fallback: boolean): boolean {
  const raw = effective(key);
  if (raw === undefined || raw === "") return fallback;
  return !/^(false|0|no|off)$/i.test(raw);
}

const LOCAL_ALIASES = new Set(["local", "native", "sdk"]);
const CLOUD_ALIASES = new Set(["cloud", "http", "api", "server"]);

/** COGNEE_CODE_AUTOINDEX semantics (same values as the official plugins). */
function autoindexMode(effective: EnvLookup): "auto" | "always" | "off" {
  const value = (effective("COGNEE_CODE_AUTOINDEX") || "").trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(value)) return "off";
  if (["always", "1", "true", "yes", "on"].includes(value)) return "always";
  return "auto";
}

export function loadCogneeConfig(): CogneeConfig {
  const envFile = loadCogneeEnvFile();
  // Precedence: shell exports > ~/.cognee/.env (setdefault semantics, per the claude brief).
  const effective: EnvLookup = (key: string) => process.env[key] ?? envFile.values[key];

  const backendRaw = (effective("COGNEE_PI_BACKEND") || effective("COGNEE_BACKEND") || "")
    .trim()
    .toLowerCase();
  const backendForced = backendRaw !== "";

  let backend: "local" | "cloud" = "local";
  let baseUrl = "";
  let missingBaseUrl = false;

  if (backendForced && LOCAL_ALIASES.has(backendRaw)) {
    backend = "local";
    // ponytail: forced local keeps COGNEE_API_KEY when present (the official plugin scrubs it
    // because it auto-mints a local key; we never boot a server, so an explicit key is useful).
    baseUrl = effective("COGNEE_LOCAL_API_URL") || "http://localhost:8011";
  } else if (backendForced && CLOUD_ALIASES.has(backendRaw)) {
    backend = "cloud";
    baseUrl = effective("COGNEE_BASE_URL") || "";
    missingBaseUrl = baseUrl === "";
  } else if (effective("COGNEE_BASE_URL")) {
    backend = "cloud"; // managed endpoint (remote or self-run)
    baseUrl = effective("COGNEE_BASE_URL")!;
  } else {
    backend = "local";
    baseUrl = effective("COGNEE_LOCAL_API_URL") || "http://localhost:8011";
  }
  baseUrl = baseUrl.replace(/\/+$/, "");

  // Auth resolution (data plane): COGNEE_API_KEY (shell > env file) → cached
  // ~/.cognee-plugin/api_key.json → lazy owner-key mint on loopback servers
  // (see CogneeClient.ensureAuth — same order as the official plugins).
  const envKey = effective("COGNEE_API_KEY") || undefined;
  const cachedKey = envKey ? undefined : loadCachedApiKey(baseUrl);
  const apiKey = envKey ?? cachedKey;
  const apiKeySource = !apiKey
    ? "not set"
    : process.env.COGNEE_API_KEY
      ? "shell env"
      : envKey
        ? "env file"
        : "cached owner key (~/.cognee-plugin/api_key.json)";

  const envFileKeys = Object.keys(envFile.values).sort();
  const shellOverrides = [
    ...new Set(
      Object.keys(process.env).filter((k) => /^(COGNEE_|LLM_|DEFAULT_USER_)/.test(k)),
    ),
  ].sort();

  return {
    backend,
    backendForced,
    missingBaseUrl,
    baseUrl,
    apiKey,
    apiKeySource,
    authEmail: effective("COGNEE_USER_EMAIL") || undefined,
    authPassword: effective("COGNEE_USER_PASSWORD") || undefined,
    envFilePath: envFile.path,
    envFileExists: envFile.exists,
    envFileKeys,
    shellOverrides,
    dataset: sanitizeDatasetName(effective("COGNEE_PLUGIN_DATASET") || "agent_sessions"),
    sessionIdOverride: effective("COGNEE_SESSION_ID") || undefined,
    sessionPrefix: effective("COGNEE_SESSION_PREFIX") || "pi",
    capture: bool(effective, "COGNEE_CAPTURE", true),
    contextMaxChars: num(effective, "COGNEE_CONTEXT_MAX_CHARS", 2000),
    recallTimeoutMs: num(effective, "COGNEE_RECALL_TIMEOUT_MS", 4000),
    requestTimeoutMs: num(effective, "COGNEE_REQUEST_TIMEOUT_MS", 10000),
    healthTimeoutMs: num(effective, "COGNEE_HEALTH_TIMEOUT_MS", 2500),
    improveSubmitTimeoutMs: num(effective, "COGNEE_IMPROVE_SUBMIT_TIMEOUT_MS", 60000),
    improveCooldownMs: num(effective, "COGNEE_IMPROVE_COOLDOWN_MS", 1800000),
    autoImproveEvery: num(effective, "COGNEE_AUTO_IMPROVE_EVERY", 150),
    rememberWaitMs: num(effective, "COGNEE_REMEMBER_WAIT_SECONDS", 8) * 1000,
    finalSync: bool(effective, "COGNEE_FINAL_SYNC", true),
    bufferLimit: num(effective, "COGNEE_BUFFER_LIMIT", 100),
    breakerThreshold: num(effective, "COGNEE_BREAKER_THRESHOLD", 5),
    breakerWindowMs: num(effective, "COGNEE_BREAKER_WINDOW_MS", 300000),
    breakerCooldownMs: num(effective, "COGNEE_BREAKER_COOLDOWN_MS", 120000),
    codeAutoindex: autoindexMode(effective),
    codeIndexTimeoutMs: num(effective, "COGNEE_CODE_INDEX_TIMEOUT_MS", 120000),
    llmApiKeyConfigured: Boolean(effective("LLM_API_KEY")),
    llmModel: effective("LLM_MODEL"),
  };
}

/* ------------------------------------------------------------------ */
/* Naming helpers                                                      */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function sanitizeDatasetName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9-_.]/g, "-").slice(0, 100);
  return cleaned || "agent_sessions";
}

export function sanitizeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9-_.]/g, "-").slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Code graph (enola) — naming, git fingerprints, state, identifiers   */
/* Mirrors the official plugins' scripts/_code_graph.py field-for-field. */
/* ------------------------------------------------------------------ */

/** Code extensions cognee's CodeLoader claims (v1.5.3) — file-cap + identifier patterns. */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "c", "cc", "cpp", "cs", "cxx", "dart", "fs", "go", "h", "hcl", "hh", "hpp",
  "java", "js", "jsx", "kt", "kts", "php", "proto", "py", "rake", "rb", "rs",
  "scala", "svelte", "swift", "tf", "ts", "tsx", "vb", "vue",
]);

/** CamelCase words that are prose/product names, not symbols worth a code-graph seed. */
const CAMEL_STOPLIST: ReadonlySet<string> = new Set([
  "Claude", "ClaudeCode", "Codex", "Cognee", "GitHub", "GitLab", "JavaScript",
  "TypeScript", "PostgreSQL", "MongoDB", "OpenAI", "MacOS", "ReadMe", "WiFi",
  "OAuth", "TODOs",
]);

const BACKTICK_RE = /`([^`\n]{2,120})`/g;
const FILEPATH_RE = new RegExp(`\\b[\\w./-]{1,120}\\.(?:${[...CODE_EXTENSIONS].sort().join("|")})\\b`, "g");
const DOTTED_RE = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g;
const SNAKE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const CAMEL_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
const IDENTIFIER_CHARS_RE = /^[\w./:-]+$/;

/**
 * Identifier-shaped tokens from a prompt, best first, at most `limit`.
 * An empty list means the syntactic gate did not fire and the code recall
 * lane must be skipped for this prompt (same gate as the official plugins).
 */
export function extractIdentifiers(prompt: string, limit = 2): string[] {
  if (!prompt) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (rawToken: string): void => {
    const token = rawToken.trim().replace(/^[.,:;()\[\]{}]+|[.,:;()\[\]{}]+$/g, "");
    if (token.length < 3 || token.length > 120) return;
    if (CAMEL_STOPLIST.has(token)) return;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(token);
  };
  for (const match of prompt.matchAll(BACKTICK_RE)) {
    const inner = match[1].trim();
    // Backticks quote commands and prose too; only take identifier-shaped tokens.
    if (!inner.includes(" ") && IDENTIFIER_CHARS_RE.test(inner)) add(inner);
  }
  for (const pattern of [FILEPATH_RE, DOTTED_RE, SNAKE_RE, CAMEL_RE]) {
    for (const match of prompt.matchAll(pattern)) {
      const token = match[0];
      if (pattern === DOTTED_RE) {
        const parts = token.split(".");
        if (token.length < 5 || !parts.some((p) => p.length >= 3)) continue;
        if (parts.length === 2 && ["com", "org", "net", "io", "ai", "dev"].includes(parts[1].toLowerCase())) continue;
      }
      add(token);
    }
  }
  return found.slice(0, limit);
}

/**
 * The auto-recall code query: a bounded substring fact lookup.
 * query_facts (not explore) on purpose: explore needs a resolvable seed and
 * errors on ambiguity, while query_facts degrades to an empty page — the
 * right failure mode for a lane that must never disturb the prompt path.
 */
export function buildCodeQuery(identifier: string, limit = 5): Record<string, unknown> {
  return { operation: "query_facts", name: identifier, limit };
}

/* ----- git helpers (guarded, timeout-bounded; "" on any failure) ----- */

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch {
    return ""; // missing git, not a repo, timeout — all "cannot fingerprint"
  }
}

/** The repo root containing `cwd`, or "" when not inside a git repo. */
export async function gitRepoRoot(cwd: string): Promise<string> {
  if (!cwd) return "";
  const out = (await runGit(["rev-parse", "--show-toplevel"], cwd)).trim();
  if (!out) return "";
  try {
    return realpathSync(out);
  } catch {
    return out;
  }
}

/** Remote repo specs are cloned server-side (freshness follows pushed commits). */
export function isRemoteRepoSpec(spec: string): boolean {
  return /^(https:\/\/|http:\/\/|git@|ssh:\/\/)/.test(spec);
}

/**
 * The stable identity of an indexed repository: local paths resolve through
 * symlinks; remote URLs drop a trailing slash and the `.git` suffix, so
 * `…/repo` and `…/repo.git` do not index twice.
 */
export function canonicalRepoSpec(spec: string): string {
  const trimmed = String(spec).trim();
  if (isRemoteRepoSpec(trimmed)) {
    let canonical = trimmed.replace(/\/+$/, "");
    if (canonical.endsWith(".git")) canonical = canonical.slice(0, -".git".length);
    return canonical;
  }
  try {
    return realpathSync(trimmed);
  } catch {
    return trimmed; // server rejects invalid paths; the client never crashes on one
  }
}

function readableTail(canonical: string): string {
  const tail = canonical.replace(/\/+$/, "").split("/").pop() || "repo";
  return tail.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "repo";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * A stable, readable, collision-free per-repo dataset name:
 * `codebase-<repo-name>-<digest8>`. One narrow dataset per repo keeps code
 * searches fast, and the path digest keeps two checkouts sharing a basename
 * (`~/work/a/service`, `~/work/b/service`) out of one graph (a shared dataset
 * would let each ingestion's stale-node sweep delete the other's nodes).
 */
export function codeDatasetName(spec: string): string {
  const canonical = canonicalRepoSpec(spec);
  return `codebase-${readableTail(canonical).toLowerCase()}-${sha256Hex(canonical).slice(0, 8)}`;
}

// enola writes its snapshot INTO the indexed repository (<repo>/.enola/) and
// rotates files there on every run — excluded at the git level so the
// indexer's own output can never change the fingerprint (and thus force a
// re-index loop). Belt and braces: untracked .enola lines are skipped too.
const ENOLA_DIR = ".enola";
const FINGERPRINT_PATHSPEC = ["--", ".", `:(exclude)${ENOLA_DIR}`] as const;

/**
 * A cheap content fingerprint of the working tree: HEAD + dirty-path set +
 * tracked content diff + untracked (path,size,mtime). Returns "" when the
 * root is not a usable git repo (callers skip the freshness gate; server-side
 * content hashes still dedupe).
 */
export async function gitFingerprint(root: string): Promise<string> {
  if (!root) return "";
  const head = (await runGit(["rev-parse", "HEAD"], root)).trim();
  if (!head) return "";
  const porcelain = await runGit(["status", "--porcelain", ...FINGERPRINT_PATHSPEC], root);
  const diff = await runGit(["diff", "HEAD", ...FINGERPRINT_PATHSPEC], root);
  const digest = createHash("sha256");
  digest.update(head, "utf8");
  digest.update(porcelain, "utf8");
  digest.update(diff, "utf8");
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("??")) continue;
    const rel = line.slice(3).trim().replace(/^"|"$/g, "");
    if (rel.replace(/\/+$/, "") === ENOLA_DIR || rel.startsWith(`${ENOLA_DIR}/`)) continue;
    try {
      const st = statSync(join(root, rel), { bigint: true });
      digest.update(`${rel}:${st.size}:${st.mtimeNs}`, "utf8");
    } catch {
      digest.update(`${rel}:gone`, "utf8");
    }
  }
  return digest.digest("hex");
}

const SOURCE_FILE_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", ".venv", "venv", "dist", "build", "target", "__pycache__",
]);

/**
 * Count code files under `root`, stopping once `cap` is exceeded — this runs
 * at session start, so it must cost the same on a monorepo as on a small
 * service. Dot-directories (incl. `.enola/`) and the usual build dirs are skipped.
 */
export function countSourceFiles(root: string, cap: number): number {
  let seen = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen > cap) return;
      if (entry.isDirectory()) {
        if (SOURCE_FILE_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = entry.name.includes(".") ? entry.name.split(".").pop()! : "";
        if (ext && CODE_EXTENSIONS.has(ext.toLowerCase())) seen++;
      }
    }
  };
  walk(root);
  return seen;
}

/* ----- per-repo index state (~/.cognee-plugin/pi/code-graph/) ----- */

export interface CodeRepoState {
  spec: string;
  spec_kind: "path" | "url";
  /** The indexed path itself (not its enclosing git root); "" for URL specs. */
  repo_root: string;
  dataset: string;
  index_vectors: boolean;
  fingerprint: string;
  last_index_at: number;
  last_status?: string;
  error_count?: number;
  last_error_at?: number;
  last_error?: string;
}

const CODE_STATE_DIR = join(homedir(), ".cognee-plugin", "pi", "code-graph");

function repoStatePath(key: string): string {
  const canonical = canonicalRepoSpec(key);
  return join(CODE_STATE_DIR, `${readableTail(canonical)}-${sha256Hex(canonical).slice(0, 12)}.json`);
}

/** Persist one repo's index state. Fail-soft: state is an optimization, not a source of truth. */
export function saveRepoState(state: CodeRepoState): void {
  try {
    mkdirSync(CODE_STATE_DIR, { recursive: true });
    writeFileSync(repoStatePath(state.repo_root || state.spec), JSON.stringify(state), "utf8");
  } catch {
    /* fail-soft */
  }
}

/** All recorded repo states (invalid files skipped, never raised). */
export function loadRepoStates(): CodeRepoState[] {
  try {
    return readdirSync(CODE_STATE_DIR)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          const parsed = JSON.parse(readFileSync(join(CODE_STATE_DIR, name), "utf8")) as CodeRepoState;
          return parsed && typeof parsed === "object" && parsed.dataset ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * The index state whose repo_root contains `cwd`, or undefined. Only
 * locally-indexed repos match by cwd (a URL spec has no local root);
 * longest matching root wins so nested checkouts resolve to the innermost.
 */
export function findIndexedRepo(cwd: string): CodeRepoState | undefined {
  let real = "";
  try {
    real = realpathSync(cwd);
  } catch {
    return undefined;
  }
  let best: CodeRepoState | undefined;
  for (const state of loadRepoStates()) {
    const root = state.repo_root || "";
    if (!root || state.spec_kind !== "path") continue;
    if (real === root || real.startsWith(root.replace(/\/+$/, "") + "/")) {
      if (!best || root.length > best.repo_root.length) best = state;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Capture policy: redaction + truncation (per the claude-code brief §4) */
/* ------------------------------------------------------------------ */

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted:private_key]"],
  [/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s"'<>]+/gi, "[redacted:db_uri]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, "[redacted:token]"],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted:api_key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted:github_token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted:slack_token]"],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, "[redacted:webhook_secret]"],
  [/\b(api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|auth[_-]?token)(\s*[:=]\s*)["']?[^\s"']{6,}/gi, "$1$2[redacted:credential]"],
];

/** Best-effort secret redaction, applied BEFORE truncation so a clipped key cannot escape. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/** Byte-aware truncation with `...` marker (matches the plugin limits convention). */
export function truncateText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - 3)).toString("utf8");
  // Drop a possibly-broken trailing surrogate pair.
  out = out.replace(/[\uD800-\uDFFF]*$/, "");
  return out + "...";
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export interface RecallItem {
  source?: string;
  text?: string;
  content?: string;
  question?: string;
  answer?: string;
  [key: string]: unknown;
}

export interface RecallParams {
  query: string;
  sessionId?: string;
  dataset?: string;
  datasetIds?: string[];
  topK?: number;
  /** Pinning avoids the server auto-router (plugins pin HYBRID_COMPLETION on completion recalls). */
  searchType?: string;
  onlyContext?: boolean;
  scope?: string[];
  codeQuery?: Record<string, unknown>;
  /** Caller already sanitized/derived this name (code lane): skip the 100-char
   *  re-sanitize — codeDatasetName() output is charset-clean by construction and
   *  truncating it breaks cross-plugin dataset identity for long repo names. */
  datasetPresanitized?: boolean;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
}

export interface RecallResult {
  ok: boolean;
  items: RecallItem[];
  /** 404 on graph scope = dataset has no graph yet (authoritative empty). */
  noGraph?: boolean;
  error?: CogneeError;
}

export interface QaEntry {
  type: "qa";
  question: string;
  answer: string;
  context?: string;
  node_set?: string;
}

export interface RememberParams {
  content: string;
  filename?: string;
  nodeSet?: "user_context" | "project_docs" | "agent_actions";
  dataset?: string;
  datasetId?: string;
  background?: boolean;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
}

export type ImproveOutcome = "ok" | "busy" | "unsupported" | "error";

export interface DatasetInfo {
  name: string;
  id: string;
  owner_id?: string;
  ownerId?: string;
}

export interface DataItemInfo {
  id: string;
  name?: string;
  created_at?: string;
}

export interface SessionQaRow {
  question?: string;
  answer?: string;
  context?: string;
  [key: string]: unknown;
}

export interface HealthResult {
  reachable: boolean;
  latencyMs: number;
  status?: number;
  version?: string;
  error?: string;
}

interface RawFetchOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  timeoutMs: number;
  externalSignal?: AbortSignal;
  /** Single small retry on connect errors — idempotent requests only (writes never retry). */
  retryOnConnect?: boolean;
}

export class CogneeClient {
  readonly cfg: CogneeConfig;

  /** Key minted by the lazy local owner bootstrap (session-lifetime fallback). */
  private mintedKey: string | undefined;
  private mintFailed = false;
  private mintPromise: Promise<void> | undefined;

  constructor(cfg: CogneeConfig) {
    this.cfg = cfg;
  }

  private authHeaders(): Record<string, string> {
    const key = this.cfg.apiKey ?? this.mintedKey;
    return key ? { "X-Api-Key": key } : {};
  }

  /** Effective key source for display, including the lazy local bootstrap mint. */
  authSummary(): string {
    if (this.cfg.apiKey) return this.cfg.apiKeySource;
    if (this.mintedKey) return "auto-minted owner key (~/.cognee-plugin/api_key.json)";
    return this.mintFailed ? "not set (local owner-key bootstrap failed — run /cognee-doctor)" : "not set";
  }

  /**
   * Lazy owner-key bootstrap for loopback servers with auth enforced (cognee ≥ 1.2.2
   * authenticates even localhost): login as the default user, reuse-or-mint an owner
   * API key, cache it in the shared ~/.cognee-plugin/api_key.json. Never throws;
   * runs at most once per process (a failed mint is not retried this session).
   */
  async ensureAuth(): Promise<void> {
    if (this.cfg.apiKey || this.mintedKey || this.mintFailed) return;
    if (!isLoopbackUrl(this.cfg.baseUrl)) return; // cloud/remote servers need an explicit key
    if (!this.mintPromise) {
      this.mintPromise = this.mintOwnerKey()
        .then((key) => {
          this.mintedKey = key;
          saveCachedApiKey(this.cfg.baseUrl, key);
        })
        .catch(() => {
          this.mintFailed = true;
        })
        .finally(() => {
          this.mintPromise = undefined;
        });
    }
    await this.mintPromise;
  }

  private async mintOwnerKey(): Promise<string> {
    const timeoutMs = this.cfg.healthTimeoutMs; // localhost mint — short bound
    const login = await this.rawFetch(`${this.cfg.baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: this.cfg.authEmail ?? "default_user@example.com",
        password: this.cfg.authPassword ?? "default_password",
      }).toString(),
      timeoutMs,
    });
    const loginText = await login.readText();
    if (!login.ok) {
      throw new CogneeError(`default-user login failed (HTTP ${login.status})`);
    }
    let jwt = "";
    try {
      jwt = String((JSON.parse(loginText) as { access_token?: unknown }).access_token ?? "");
    } catch {
      /* non-JSON body — treated as an empty token below */
    }
    if (!jwt) throw new CogneeError("default-user login returned no access token");
    const cookie = `auth_token=${jwt}`;
    // Reuse an existing owner key when the server has one (keys minted by the
    // official plugins count) — minting would needlessly multiply credentials.
    const listed = await this.rawFetch(`${this.cfg.baseUrl}/api/v1/auth/api-keys`, {
      method: "GET",
      headers: { Cookie: cookie },
      timeoutMs,
    });
    const listedText = await listed.readText();
    if (listed.ok && listedText) {
      try {
        const keys: unknown = JSON.parse(listedText);
        if (Array.isArray(keys) && keys.length > 0) {
          const first = keys[0] as { key?: unknown } | undefined;
          const firstKey = first && typeof first.key === "string" ? first.key : "";
          if (firstKey) return firstKey;
        }
      } catch {
        /* fall through to mint */
      }
    }
    const created = await this.rawFetch(`${this.cfg.baseUrl}/api/v1/auth/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "pi-owner-bootstrap" }),
      timeoutMs,
    });
    const createdText = await created.readText();
    if (!created.ok) {
      throw new CogneeError(`owner API key creation failed (HTTP ${created.status})`);
    }
    let key = "";
    try {
      key = String((JSON.parse(createdText) as { key?: unknown }).key ?? "");
    } catch {
      /* empty key below */
    }
    if (!key) throw new CogneeError("owner API key creation returned empty key");
    return key;
  }

  private async rawFetch(
    url: string,
    opts: RawFetchOptions,
  ): Promise<Response & { readText(): Promise<string> }> {
    const attempt = async (): Promise<Response & { readText(): Promise<string> }> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      const onExternalAbort = () => controller.abort();
      opts.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timer);
        opts.externalSignal?.removeEventListener("abort", onExternalAbort);
      };
      try {
        const resp = await fetch(url, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          signal: controller.signal,
        });
        // Abort wiring stays alive until the body is consumed: a server that sends
        // headers and then stalls must not hang the body read past the timeout.
        // Body-read failures get the same classification as connect failures.
        return Object.assign(resp, {
          readText: async (): Promise<string> => {
            try {
              return await resp.text();
            } catch (err) {
              if (opts.externalSignal?.aborted) {
                throw new CogneeError("request aborted", { aborted: true });
              }
              if (err instanceof Error && err.name === "AbortError") {
                throw new CogneeError(`request timed out after ${opts.timeoutMs}ms`, {
                  transient: true,
                });
              }
              throw new CogneeError(`cannot read response body: ${describeError(err)}`, {
                unreachable: true,
              });
            } finally {
              cleanup();
            }
          },
        });
      } catch (err) {
        cleanup();
        if (opts.externalSignal?.aborted) {
          throw new CogneeError("request aborted", { aborted: true });
        }
        if (err instanceof Error && err.name === "AbortError") {
          throw new CogneeError(`request timed out after ${opts.timeoutMs}ms`, { transient: true });
        }
        throw new CogneeError(`cannot reach cognee server: ${describeError(err)}`, {
          unreachable: true,
        });
      }
    };
    try {
      return await attempt();
    } catch (err) {
      // ponytail: one 300ms-backoff retry on positively-absent servers, reads only —
      // writes never retry (no server-side idempotency; a retried write could duplicate).
      if (opts.retryOnConnect && err instanceof CogneeError && err.unreachable) {
        await sleep(300);
        return await attempt();
      }
      throw err;
    }
  }

  private async jsonRequest<T>(
    method: string,
    path: string,
    opts: {
      json?: unknown;
      timeoutMs?: number;
      externalSignal?: AbortSignal;
      retryOnConnect?: boolean;
    } = {},
  ): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: CogneeError }> {
    try {
      await this.ensureAuth(); // no-op once a key is resolved (or off-loopback)
      const headers = this.authHeaders();
      let body: string | undefined;
      if (opts.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.json);
      }
      const resp = await this.rawFetch(this.cfg.baseUrl + path, {
        method,
        headers,
        body,
        timeoutMs: opts.timeoutMs ?? this.cfg.requestTimeoutMs,
        externalSignal: opts.externalSignal,
        retryOnConnect: opts.retryOnConnect,
      });
      const text = await resp.readText();
      let data: unknown;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!resp.ok) {
        const detail =
          data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : String(text).slice(0, 300);
        return {
          ok: false,
          status: resp.status,
          error: new CogneeError(`HTTP ${resp.status} ${method} ${path}: ${detail}`, {
            status: resp.status,
          }),
        };
      }
      return { ok: true, status: resp.status, data: data as T };
    } catch (err) {
      return { ok: false, status: 0, error: wrapAsCogneeError(err) };
    }
  }

  /** Liveness probe. Any status < 500 counts as reachable (per the server contract). */
  async health(timeoutMs: number = this.cfg.healthTimeoutMs): Promise<HealthResult> {
    const started = Date.now();
    try {
      const resp = await this.rawFetch(`${this.cfg.baseUrl}/health`, {
        method: "GET",
        timeoutMs,
        retryOnConnect: true,
      });
      const latencyMs = Date.now() - started;
      const text = await resp.readText();
      let version: string | undefined;
      try {
        const parsed = JSON.parse(text) as { version?: unknown };
        if (parsed && typeof parsed.version === "string") version = parsed.version;
      } catch {
        /* non-JSON health body is fine */
      }
      if (resp.status < 500) return { reachable: true, latencyMs, status: resp.status, version };
      return { reachable: false, latencyMs, status: resp.status, error: `HTTP ${resp.status}` };
    } catch (err) {
      return {
        reachable: false,
        latencyMs: Date.now() - started,
        error: describeError(err),
      };
    }
  }

  /**
   * POST /api/v1/recall. Dataset addressing: UUID → dataset_ids (drops session_id),
   * plain name → datasets, neither → server default. 404 on graph scope = authoritative
   * empty (no graph yet) and is returned as ok with noGraph=true.
   */
  async recall(params: RecallParams): Promise<RecallResult> {
    const scope = params.scope ?? ["graph"];
    const body: Record<string, unknown> = {
      query: params.query,
      top_k: Math.max(1, params.topK ?? 5),
      only_context: params.onlyContext ?? true,
      scope,
    };
    if (params.searchType) body.search_type = params.searchType;
    if (params.datasetIds?.length) {
      body.dataset_ids = params.datasetIds;
    } else {
      if (params.dataset)
        body.datasets = [params.datasetPresanitized ? params.dataset : sanitizeDatasetName(params.dataset)];
      if (params.sessionId) body.session_id = params.sessionId;
    }
    if (params.codeQuery && scope.includes("code")) body.code_query = params.codeQuery;

    const r = await this.jsonRequest<unknown>("POST", "/api/v1/recall", {
      json: body,
      timeoutMs: params.timeoutMs ?? this.cfg.requestTimeoutMs,
      externalSignal: params.externalSignal,
    });
    if (!r.ok) {
      if (r.error.status === 404) return { ok: true, items: [], noGraph: true };
      return { ok: false, items: [], error: r.error };
    }
    const items = Array.isArray(r.data) ? (r.data as RecallItem[]) : [];
    return { ok: true, items };
  }

  /**
   * POST /api/v1/remember — multipart. The file part keeps a real .txt basename so the
   * server routes it through the prose LLM pipeline (code extensions go the zero-LLM route).
   */
  async remember(params: RememberParams): Promise<{
    ok: boolean;
    status?: number;
    datasetId?: string;
    pipelineRunId?: string;
    error?: CogneeError;
  }> {
    try {
      await this.ensureAuth(); // no-op once a key is resolved (or off-loopback)
      const form = new FormData();
      form.set("node_set", params.nodeSet ?? "user_context");
      form.set("run_in_background", String(params.background ?? true));
      if (params.datasetId) form.set("datasetId", params.datasetId);
      else if (params.dataset) form.set("datasetName", sanitizeDatasetName(params.dataset));
      const filename =
        params.filename ?? `pi-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      form.set("data", new Blob([params.content], { type: "text/plain" }), filename);

      const resp = await this.rawFetch(`${this.cfg.baseUrl}/api/v1/remember`, {
        method: "POST",
        headers: this.authHeaders(),
        body: form,
        timeoutMs: params.timeoutMs ?? this.cfg.requestTimeoutMs,
        externalSignal: params.externalSignal,
      });
      const text = await resp.readText();
      let data: { error?: unknown; dataset_id?: string; datasetId?: string; pipeline_run_id?: string } | undefined;
      try {
        data = text ? (JSON.parse(text) as typeof data) : undefined;
      } catch {
        data = undefined;
      }
      if (!resp.ok) {
        return {
          ok: false,
          status: resp.status,
          error: new CogneeError(
            `HTTP ${resp.status} POST /api/v1/remember: ${String(text).slice(0, 300)}`,
            { status: resp.status },
          ),
        };
      }
      // The server may report errors inside a 2xx body.
      if (data && typeof data.error === "string") {
        return { ok: false, status: resp.status, error: new CogneeError(`server error: ${data.error}`) };
      }
      return {
        ok: true,
        status: resp.status,
        datasetId: data?.dataset_id ?? data?.datasetId,
        pipelineRunId: data?.pipeline_run_id,
      };
    } catch (err) {
      return { ok: false, error: wrapAsCogneeError(err) };
    }
  }

  /**
   * POST /api/v1/remember with content_type="code" — submits one repository
   * for code-graph (enola) indexing. Mirrors _code_graph.py field-for-field:
   * datasetName, content_type=code, raw_data=<repo-spec>, run_in_background,
   * index_vectors. Requires cognee >= 1.5.4 (1.5.4 renamed `repositories` →
   * `raw_data`; only the new name is sent). No LLM/embedding calls — fast and
   * deterministic. A timeout is surfaced transient (the submission may have
   * landed); unreachable means positively absent, nothing was submitted.
   */
  async indexCodeRepo(params: {
    repoSpec: string;
    dataset: string;
    indexVectors?: boolean;
    background?: boolean;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    status?: number;
    datasetId?: string;
    pipelineRunId?: string;
    serverStatus?: string;
    items?: unknown;
    error?: CogneeError;
  }> {
    try {
      await this.ensureAuth();
      const form = new FormData();
      // No re-sanitize: callers pass either an already-sanitized explicit name or a
      // codeDatasetName() product (charset-clean by construction) — the 100-char cap
      // would truncate long-repo names and desync from the official plugins.
      form.set("datasetName", params.dataset);
      form.set("content_type", "code");
      form.set("raw_data", String(params.repoSpec));
      form.set("run_in_background", String(params.background ?? true));
      form.set("index_vectors", String(params.indexVectors ?? false));
      const resp = await this.rawFetch(`${this.cfg.baseUrl}/api/v1/remember`, {
        method: "POST",
        headers: this.authHeaders(),
        body: form,
        timeoutMs: params.timeoutMs ?? this.cfg.codeIndexTimeoutMs,
      });
      const text = await resp.readText();
      let data:
        | { error?: unknown; detail?: unknown; dataset_id?: unknown; pipeline_run_id?: unknown; status?: unknown; items?: unknown }
        | undefined;
      try {
        data = text ? (JSON.parse(text) as typeof data) : undefined;
      } catch {
        data = undefined;
      }
      const detail = String(
        (data && typeof data === "object" && (data.detail ?? data.error)) || text || "",
      ).slice(0, 300);
      if (!resp.ok) {
        let message = `HTTP ${resp.status} POST /api/v1/remember (code): ${detail}`;
        if (resp.status === 401 || resp.status === 403) {
          message = `unauthorized (HTTP ${resp.status}) — check COGNEE_API_KEY / credentials`;
        } else if (
          resp.status === 400 &&
          detail.toLowerCase().includes("unsupported content_type")
        ) {
          // Matching on the full phrase only: a current server's code-branch 400s
          // all name the field and must fall through as contract errors.
          message =
            "server rejected content_type='code' — repo indexing requires cognee >= 1.5.4; " +
            `upgrade the server. Detail: ${detail}`;
        }
        return { ok: false, status: resp.status, error: new CogneeError(message, { status: resp.status }) };
      }
      // A 2xx the caller cannot parse is NOT success — callers advance the repo's
      // stored fingerprint on ok, so an unparseable body would mark edits indexed.
      if (!data || typeof data !== "object") {
        return {
          ok: false,
          status: resp.status,
          error: new CogneeError("malformed JSON response from /api/v1/remember (code)"),
        };
      }
      if (typeof data.error === "string" && data.error) {
        return { ok: false, status: resp.status, error: new CogneeError(`server error: ${data.error.slice(0, 200)}`) };
      }
      return {
        ok: true,
        status: resp.status,
        datasetId: typeof data.dataset_id === "string" ? data.dataset_id : undefined,
        pipelineRunId: typeof data.pipeline_run_id === "string" ? data.pipeline_run_id : undefined,
        serverStatus: typeof data.status === "string" ? data.status : undefined,
        items: data.items,
      };
    } catch (err) {
      return { ok: false, error: wrapAsCogneeError(err) };
    }
  }

  /** GET /api/v1/datasets/status?dataset=<id>&pipeline=code_graph_pipeline (poll helper). */
  async codeGraphStatus(
    datasetId: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; status?: string; error?: CogneeError }> {
    return this.datasetStatus(datasetId, "code_graph_pipeline", timeoutMs);
  }

  /**
   * Deterministic code-graph search — POST /api/v1/recall with scope=["code"]
   * (the exact endpoint cognee-search.sh --code uses). Without `codeQuery` the
   * seed text is the query (exact/suffix/substring match); with it, one exact
   * operation runs (query_facts, explore, traverse, find_path, impact_analysis,
   * delta). No session_id: the code dataset is a foreign dataset for this
   * session, and the server binds session ids to the session dataset only.
   * No CLI fallback exists for this route — unreachable means "not run".
   */
  async codeSearch(params: {
    seed: string;
    codeQuery?: Record<string, unknown>;
    dataset: string;
    topK?: number;
    timeoutMs?: number;
    externalSignal?: AbortSignal;
  }): Promise<RecallResult> {
    return this.recall({
      query: params.seed,
      topK: params.topK ?? 5,
      onlyContext: true,
      scope: ["code"],
      dataset: params.dataset,
      datasetPresanitized: true,
      codeQuery: params.codeQuery,
      timeoutMs: params.timeoutMs ?? this.cfg.requestTimeoutMs,
      externalSignal: params.externalSignal,
    });
  }

  /** POST /api/v1/remember/entry — writes one typed entry into the server-side session cache. */
  async rememberEntry(
    entry: QaEntry,
    sessionId: string,
    dataset: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; error?: CogneeError }> {
    const r = await this.jsonRequest<unknown>("POST", "/api/v1/remember/entry", {
      json: { entry, session_id: sessionId, dataset_name: sanitizeDatasetName(dataset) },
      timeoutMs,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /**
   * POST /api/v1/improve — promotes the server-side session cache into the permanent graph.
   * Empty-object response = per-session improve lock held (busy, never retried);
   * 404/405/422 = improve_unsupported.
   */
  async improve(
    sessionId: string,
    dataset: string | undefined,
    timeoutMs: number = this.cfg.improveSubmitTimeoutMs,
    externalSignal?: AbortSignal,
  ): Promise<{ outcome: ImproveOutcome; error?: CogneeError }> {
    const body: Record<string, unknown> = { session_ids: [sessionId], run_in_background: true };
    if (dataset) {
      if (isUuid(dataset)) body.dataset_id = dataset;
      else body.dataset_name = sanitizeDatasetName(dataset);
    }
    const r = await this.jsonRequest<unknown>("POST", "/api/v1/improve", {
      json: body,
      timeoutMs,
      externalSignal,
    });
    if (!r.ok) {
      const status = r.error.status ?? 0;
      if (status === 404 || status === 405 || status === 422) {
        return { outcome: "unsupported", error: r.error };
      }
      return { outcome: "error", error: r.error };
    }
    const data = r.data;
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      Object.keys(data as object).length === 0
    ) {
      return { outcome: "busy" };
    }
    return { outcome: "ok" };
  }

  /** GET /api/v1/datasets — the caller's full read set. */
  async listDatasets(timeoutMs?: number): Promise<{ ok: boolean; datasets: DatasetInfo[]; error?: CogneeError }> {
    const r = await this.jsonRequest<unknown>("GET", "/api/v1/datasets", {
      timeoutMs,
      retryOnConnect: true,
    });
    if (!r.ok) return { ok: false, datasets: [], error: r.error };
    const data = r.data;
    const list = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { datasets?: unknown[] }).datasets)
        ? (data as { datasets: unknown[] }).datasets
        : [];
    const datasets = list
      .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
      .map((d) => ({
        name: String(d.name ?? ""),
        id: String(d.id ?? ""),
        owner_id: typeof d.owner_id === "string" ? d.owner_id : undefined,
        ownerId: typeof d.ownerId === "string" ? d.ownerId : undefined,
      }))
      .filter((d) => d.name || d.id);
    return { ok: true, datasets };
  }

  /** POST /api/v1/datasets — idempotent ensure. */
  async ensureDataset(name: string, timeoutMs?: number): Promise<{ ok: boolean; error?: CogneeError }> {
    const r = await this.jsonRequest<unknown>("POST", "/api/v1/datasets", {
      json: { name: sanitizeDatasetName(name) },
      timeoutMs,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** One stored data item (forget-flow discovery). */
  async listDataItems(
    datasetId: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; items: DataItemInfo[]; error?: CogneeError }> {
    const r = await this.jsonRequest<unknown>("GET", `/api/v1/datasets/${encodeURIComponent(datasetId)}/data`, {
      timeoutMs,
      retryOnConnect: true,
    });
    if (!r.ok) return { ok: false, items: [], error: r.error };
    const data = r.data;
    const list = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { data?: unknown[] }).data)
        ? (data as { data: unknown[] }).data
        : [];
    const items = list
      .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
      .map((d) => ({
        id: String(d.id ?? d.data_id ?? ""),
        name: typeof d.name === "string" ? d.name : undefined,
        created_at: typeof d.created_at === "string" ? d.created_at : undefined,
      }))
      .filter((d) => d.id);
    return { ok: true, items };
  }

  /** GET /api/v1/datasets/{uuid}/data/{dataId}/raw — raw stored text (delete preview). */
  async getDataItemRaw(
    datasetId: string,
    dataId: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; text: string; error?: CogneeError }> {
    const r = await this.jsonRequest<unknown>(
      "GET",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/data/${encodeURIComponent(dataId)}/raw`,
      { timeoutMs, retryOnConnect: true },
    );
    if (!r.ok) return { ok: false, text: "", error: r.error };
    const data = r.data;
    const text =
      typeof data === "string"
        ? data
        : data && typeof data === "object"
          ? String(
              (data as Record<string, unknown>).content ??
                (data as Record<string, unknown>).text ??
                (data as Record<string, unknown>).raw ??
                JSON.stringify(data),
            )
          : "";
    return { ok: true, text };
  }

  /** GET /api/v1/datasets/status?dataset=<uuid>&pipeline=cognify_pipeline */
  async datasetStatus(
    datasetId: string,
    pipeline = "cognify_pipeline",
    timeoutMs?: number,
  ): Promise<{ ok: boolean; status?: string; error?: CogneeError }> {
    const r = await this.jsonRequest<Record<string, unknown>>(
      "GET",
      `/api/v1/datasets/status?dataset=${encodeURIComponent(datasetId)}&pipeline=${encodeURIComponent(pipeline)}`,
      { timeoutMs, retryOnConnect: true },
    );
    if (!r.ok) return { ok: false, error: r.error };
    const map = r.data;
    if (!map || typeof map !== "object") return { ok: true };
    const entry = map[datasetId] ?? Object.values(map)[0];
    if (entry && typeof entry === "object") {
      return { ok: true, status: String((entry as Record<string, unknown>)[pipeline] ?? "") };
    }
    if (typeof entry === "string") return { ok: true, status: entry };
    return { ok: true };
  }

  /** GET /api/v1/sessions/{id} — last ~20 QA/trace rows of the server-side session cache. */
  async getSessionDetail(
    sessionId: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; qas: SessionQaRow[]; error?: CogneeError }> {
    const r = await this.jsonRequest<{ qas?: unknown }>(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { timeoutMs, retryOnConnect: true },
    );
    if (!r.ok) return { ok: false, qas: [], error: r.error };
    const qas = Array.isArray(r.data?.qas)
      ? (r.data.qas as SessionQaRow[])
      : Array.isArray(r.data)
        ? (r.data as unknown as SessionQaRow[])
        : [];
    return { ok: true, qas };
  }

  /** POST /api/v1/forget — irreversible. dataId omitted ⇒ whole-dataset scope. */
  async forget(
    datasetId: string,
    dataId?: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; error?: CogneeError }> {
    const json: Record<string, unknown> = dataId ? { datasetId, dataId } : { datasetId };
    const r = await this.jsonRequest<unknown>("POST", "/api/v1/forget", { json, timeoutMs });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
}
