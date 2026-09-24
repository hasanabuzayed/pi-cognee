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
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_ROLE_NAME,
  GRANT_DENIED_RETRY_SECONDS,
  PLUGIN_KEY,
  PROVISIONING_PLUGIN_VERSION,
  parseOpenapiCapabilities,
  parsePluginIdentityMode,
  parseSharedAgentMemory,
  pickCanonical,
  separatedOutcome,
  validateProvisionResponse,
  type DatasetRow,
  type ProvisionResult,
  type SharedMemoryMarker,
  type SharedMemoryOutcome,
  type WritableDatasetsListing,
} from "./provisioning";

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
  /** Default dataset (graph tier). `agent_sessions` is shared with the official plugins.
   *  Once a switch was persisted for this backend, the record's dataset wins over
   *  the COGNEE_PLUGIN_DATASET seed (the reference's "env only seeds" precedence). */
  dataset: string;
  /** Where `dataset` came from — surfaced by /cognee-doctor and switch provenance. */
  datasetSource: "default" | "COGNEE_PLUGIN_DATASET" | "persisted switch";
  /** Retired dataset + when, when a persisted switch is active (provenance). */
  datasetSwitchedFrom?: string;
  datasetSwitchedAt?: string;
  /** Session id recorded by the persisted switch — adopted at session start so a
   *  resumed conversation keeps bridging into the switched session. */
  switchSessionId?: string;
  /** Federated graph-recall read set (COGNEE_PLUGIN_READ_DATASET_IDS — JSON array of
   *  UUIDs, read-only federation; writes never consult it). */
  readDatasetIds?: string[];
  /** Where the read set came from (shell exports beat the env file). */
  readDatasetIdsSource?: "shell env" | "env file";
  /** Exact reference validation error when the var is set but malformed (federation off). */
  readDatasetIdsError?: string;
  sessionIdOverride?: string;
  sessionPrefix: string;
  /** Master switch for automatic capture + auto-recall (explicit tools always work). */
  capture: boolean;
  /* ----- v0.4 tool-call trace capture (research/v04-traces-spec.md §3) ----- */
  /** COGNEE_CAPTURE_TOOLS allowlist (pipe-separated globs or JSON array); the
   *  default is the reference PostToolUse matcher translated to pi tool names
   *  (a user-set value REPLACES it — widen to custom tools or narrow at will). */
  captureTools: string[];
  /** Exact parse error when COGNEE_CAPTURE_TOOLS is malformed (default set in use). */
  captureToolsError?: string;
  /** COGNEE_CAPTURE_DENY_PATHS — extra patterns beyond the compiled-in deny list. */
  captureDenyPaths: string[];
  captureDenyPathsError?: string;
  /** COGNEE_CAPTURE_REDACT — master switch for TRACE redaction (default true). */
  captureRedact: boolean;
  /** COGNEE_CAPTURE_REDACT_PATTERNS — custom regexes → [redacted:custom]. */
  captureRedactPatterns: string[];
  captureRedactPatternsError?: string;
  /** Invalid custom regexes, skipped with a /cognee-doctor warning (fail-soft
   *  divergence — the reference raises instead). */
  captureRedactPatternsSkipped?: string[];
  contextMaxChars: number;
  recallTimeoutMs: number;
  requestTimeoutMs: number;
  healthTimeoutMs: number;
  improveSubmitTimeoutMs: number;
  improveCooldownMs: number;
  autoImproveEvery: number;
  /* ----- v0.4 resilience cluster (research/v04-resilience-spec.md §2) ----- */
  /** Idle-bridge arm delay (COGNEE_IDLE_THRESHOLD_MS, default 60 000 — the
   *  reference COGNEE_IDLE_THRESHOLD=60 s; pi is event-driven, no poll loop). */
  idleThresholdMs: number;
  /** Arms/disarms the idle improve trigger alone (COGNEE_IDLE_IMPROVE, default true). */
  idleImprove: boolean;
  /** Background drain time box (COGNEE_DRAIN_BUDGET_MS, default 20 000 — the
   *  reference COGNEE_DRAIN_BUDGET=20 s; per-request timeouts clamp to it). */
  drainBudgetMs: number;
  rememberWaitMs: number;
  /** Default run_in_background for explicit remember writes (COGNEE_REMEMBER_BACKGROUND). */
  rememberBackground: boolean;
  finalSync: boolean;
  bufferLimit: number;
  breakerThreshold: number;
  breakerWindowMs: number;
  breakerCooldownMs: number;
  /** Code-graph auto-indexing mode: "auto" (local server only) | "always" | "off". */
  codeAutoindex: "auto" | "always" | "off";
  /** Submit timeout for the repo-index POST (background pipelines still confirm slowly). */
  codeIndexTimeoutMs: number;
  /** LLM key pass-through (reported by /cognee-doctor; handed to a booted server via its env). */
  llmApiKeyConfigured: boolean;
  llmModel?: string;
  /* ----- v0.4 local server bootstrap (research/v04-bootstrap-spec.md §2.4) ----- */
  /** Master switch for the local server bootstrap (on|off; off = v0.3 behavior). */
  localBootstrap: boolean;
  /** Overall boot deadline seconds (health wait after spawn; COGNEE_SERVER_BOOT_DEADLINE). */
  serverBootDeadlineS: number;
  /** Per uv subprocess timeout seconds; install-lock stale/wait = this + 60 s. */
  installTimeoutS: number;
  /** Python pin for `uv venv` (COGNEE_PLUGIN_PYTHON, default 3.12). */
  pythonPin: string;
  /** Delay seconds before the absence-confirming presence re-probe. */
  presenceReprobeDelayS: number;
  /** bootstrap.log rotation cap (COGNEE_PLUGIN_LOG_MAX_BYTES, default 20 MiB). */
  pluginLogMaxBytes: number;
  /* ----- v0.4 shared-agent-memory provisioning (research/v04-provisioning-spec.md) ----- */
  /** COGNEE_PLUGIN_IDENTITY tri-state (auto | enabled | disabled; default auto). */
  pluginIdentity: "auto" | "enabled" | "disabled";
  /** Exact reference error when COGNEE_PLUGIN_IDENTITY is invalid (behavior: auto). */
  pluginIdentityError?: string;
  /** COGNEE_SHARED_AGENT_MEMORY — off exactly on 0/false/no/off; default true. */
  sharedAgentMemory: boolean;
  /** Canonical write UUID recorded on the persisted dataset-switch record
   *  (shared memory resolved it; name addressing when absent). */
  sharedDatasetId?: string;
  /** Recall read set recorded on the persisted record (UUIDs; #2 precedence
   *  after env federation, before the explicit dataset). */
  sharedDatasetIds?: string[];
}

type EnvLookup = (key: string) => string | undefined;

export type { EnvLookup };

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

/* ------------------------------------------------------------------ */
/* Federated read datasets (COGNEE_PLUGIN_READ_DATASET_IDS)            */
/* Mirrors reference _dataset_access.py recall_fields' env lane.       */
/* ------------------------------------------------------------------ */

export interface ReadDatasetIdsResult {
  /** Canonical UUIDs, deduped preserving first-seen order; absent when unset/blank/invalid. */
  datasetIds?: string[];
  /** Exact reference error string when the value is present but malformed. */
  error?: string;
}

/**
 * COGNEE_PLUGIN_READ_DATASET_IDS — a JSON array of dataset UUIDs that widens
 * GRAPH recall (read-only federation; writes never consult it). Parsing mirrors
 * the reference field-for-field: unset or whitespace-only → off; invalid JSON →
 * the exact error with the parser's message appended verbatim; non-list / empty
 * list / any non-UUID entry → the exact shape error; entries canonicalized via
 * dataset_id (hyphens optional, case-insensitive) then deduped preserving
 * first-seen order (dict.fromkeys). The reference raises these errors at recall
 * time; pi-cognee surfaces the same exact strings at config load instead —
 * fail-soft: a bad value disables federation, it never crashes the recall path.
 */
export function parseReadDatasetIds(raw: string | undefined): ReadDatasetIdsResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return {}; // unset or whitespace-only → no federation
  let values: unknown;
  try {
    values = JSON.parse(trimmed);
  } catch (err) {
    return { error: `COGNEE_PLUGIN_READ_DATASET_IDS is not valid JSON: ${describeError(err)}` };
  }
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((v) => canonicalUuid(v) !== "")
  ) {
    return { error: "COGNEE_PLUGIN_READ_DATASET_IDS must be a nonempty JSON list of UUIDs" };
  }
  // Dedupe AFTER canonicalization, first-seen order preserved (dict.fromkeys).
  return { datasetIds: [...new Set(values.map((v) => canonicalUuid(v)))] };
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

  // Federated read set (COGNEE_PLUGIN_READ_DATASET_IDS): shell > env file, same
  // precedence as every other key. Malformed values surface the exact reference
  // error at load (config warning) and disable federation — never a crash.
  const readDatasetParsed = parseReadDatasetIds(effective("COGNEE_PLUGIN_READ_DATASET_IDS"));
  const readDatasetIdsSource: "shell env" | "env file" =
    process.env.COGNEE_PLUGIN_READ_DATASET_IDS !== undefined ? "shell env" : "env file";

  // Tool-call trace capture knobs (v0.4). Malformed values surface as *Error
  // fields (shown by /cognee-doctor) and fall back to safe defaults — never
  // fatal. Separators mirror the reference: `|` tools, `,` deny paths,
  // newline redact patterns (commas stay valid regex syntax).
  const captureToolsParsed = parseListEnv(effective("COGNEE_CAPTURE_TOOLS"), {
    separator: "|",
    label: "COGNEE_CAPTURE_TOOLS",
  });
  const captureDenyParsed = parseListEnv(effective("COGNEE_CAPTURE_DENY_PATHS"), {
    separator: ",",
    label: "COGNEE_CAPTURE_DENY_PATHS",
  });
  const captureRedactParsed = parseListEnv(effective("COGNEE_CAPTURE_REDACT_PATTERNS"), {
    separator: "\n",
    label: "COGNEE_CAPTURE_REDACT_PATTERNS",
  });
  const captureRedactPatterns: string[] = [];
  const captureRedactPatternsSkipped: string[] = [];
  for (const pattern of captureRedactParsed.values) {
    try {
      new RegExp(pattern);
      captureRedactPatterns.push(pattern);
    } catch {
      captureRedactPatternsSkipped.push(pattern);
    }
  }

  // Persisted dataset switch (reference launch-record semantics): the record's
  // dataset wins over the COGNEE_PLUGIN_DATASET seed — "env only seeds the first
  // launch". Keyed by server URL + key fingerprint so a switch minted for one
  // backend/identity is never served to another. Absent/corrupt → seed wins.
  const activeRecord = loadActiveDatasetRecord(baseUrl, datasetKeyFingerprint(baseUrl, apiKey));
  const datasetSeed = effective("COGNEE_PLUGIN_DATASET");
  const dataset = activeRecord
    ? sanitizeDatasetName(activeRecord.dataset)
    : sanitizeDatasetName(datasetSeed || "agent_sessions");

  // Shared-agent-memory identity policy (v0.4): tri-state identity + default-on
  // sharing, parsed exactly as the reference (§1.2). A malformed identity value
  // surfaces the exact reference error at load (config warning) and behaves as
  // auto — never a crash.
  const identityParsed = parsePluginIdentityMode(effective("COGNEE_PLUGIN_IDENTITY"));

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
    dataset,
    datasetSource: activeRecord
      ? "persisted switch"
      : datasetSeed
        ? "COGNEE_PLUGIN_DATASET"
        : "default",
    datasetSwitchedFrom: activeRecord?.previous?.dataset,
    datasetSwitchedAt: activeRecord?.switched_at,
    switchSessionId: activeRecord?.session_id,
    readDatasetIds: readDatasetParsed.datasetIds,
    readDatasetIdsSource: readDatasetParsed.datasetIds ? readDatasetIdsSource : undefined,
    readDatasetIdsError: readDatasetParsed.error,
    sessionIdOverride: effective("COGNEE_SESSION_ID") || undefined,
    sessionPrefix: effective("COGNEE_SESSION_PREFIX") || "pi",
    capture: bool(effective, "COGNEE_CAPTURE", true),
    captureTools:
      captureToolsParsed.error || captureToolsParsed.values.length === 0
        ? [...DEFAULT_CAPTURE_TOOLS]
        : captureToolsParsed.values,
    captureToolsError: captureToolsParsed.error,
    captureDenyPaths: captureDenyParsed.error ? [] : captureDenyParsed.values,
    captureDenyPathsError: captureDenyParsed.error,
    captureRedact: bool(effective, "COGNEE_CAPTURE_REDACT", true),
    captureRedactPatterns: captureRedactParsed.error ? [] : captureRedactPatterns,
    captureRedactPatternsError: captureRedactParsed.error,
    captureRedactPatternsSkipped:
      captureRedactPatternsSkipped.length ? captureRedactPatternsSkipped : undefined,
    contextMaxChars: num(effective, "COGNEE_CONTEXT_MAX_CHARS", 2000),
    recallTimeoutMs: num(effective, "COGNEE_RECALL_TIMEOUT_MS", 4000),
    requestTimeoutMs: num(effective, "COGNEE_REQUEST_TIMEOUT_MS", 10000),
    healthTimeoutMs: num(effective, "COGNEE_HEALTH_TIMEOUT_MS", 2500),
    improveSubmitTimeoutMs: num(effective, "COGNEE_IMPROVE_SUBMIT_TIMEOUT_MS", 60000),
    improveCooldownMs: num(effective, "COGNEE_IMPROVE_COOLDOWN_MS", 1800000),
    autoImproveEvery: num(effective, "COGNEE_AUTO_IMPROVE_EVERY", 150),
    idleThresholdMs: num(effective, "COGNEE_IDLE_THRESHOLD_MS", 60000),
    idleImprove: bool(effective, "COGNEE_IDLE_IMPROVE", true),
    drainBudgetMs: num(effective, "COGNEE_DRAIN_BUDGET_MS", 20000),
    rememberWaitMs: num(effective, "COGNEE_REMEMBER_WAIT_SECONDS", 8) * 1000,
    rememberBackground: bool(effective, "COGNEE_REMEMBER_BACKGROUND", true),
    finalSync: bool(effective, "COGNEE_FINAL_SYNC", true),
    bufferLimit: num(effective, "COGNEE_BUFFER_LIMIT", 100),
    breakerThreshold: num(effective, "COGNEE_BREAKER_THRESHOLD", 5),
    breakerWindowMs: num(effective, "COGNEE_BREAKER_WINDOW_MS", 300000),
    breakerCooldownMs: num(effective, "COGNEE_BREAKER_COOLDOWN_MS", 120000),
    codeAutoindex: autoindexMode(effective),
    codeIndexTimeoutMs: num(effective, "COGNEE_CODE_INDEX_TIMEOUT_MS", 120000),
    llmApiKeyConfigured: Boolean(effective("LLM_API_KEY")),
    llmModel: effective("LLM_MODEL"),
    localBootstrap: bool(effective, "COGNEE_LOCAL_BOOTSTRAP", true),
    serverBootDeadlineS: num(effective, "COGNEE_SERVER_BOOT_DEADLINE", 600),
    installTimeoutS: num(effective, "COGNEE_INSTALL_TIMEOUT", 600),
    pythonPin: (effective("COGNEE_PLUGIN_PYTHON") || "3.12").trim() || "3.12",
    presenceReprobeDelayS: num(effective, "COGNEE_PRESENCE_REPROBE_DELAY", 3),
    pluginLogMaxBytes: num(effective, "COGNEE_PLUGIN_LOG_MAX_BYTES", 20 * 1024 * 1024),
    pluginIdentity: identityParsed.mode,
    pluginIdentityError: identityParsed.error,
    sharedAgentMemory: parseSharedAgentMemory(effective("COGNEE_SHARED_AGENT_MEMORY")),
    sharedDatasetId: activeRecord?.dataset_id || undefined,
    sharedDatasetIds: activeRecord?.dataset_ids?.length ? activeRecord.dataset_ids : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Naming helpers                                                      */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const UUID32_RE = /^[0-9a-f]{32}$/i;

/**
 * `dataset_id(value)` from the reference `_dataset_access.py`, verbatim semantics:
 * `str(UUID(str(value)))` — accepts UUIDs with or without hyphens, case-insensitively,
 * canonicalizes to the lowercase-hyphenated form, and returns "" for anything else
 * ("Dataset UUIDs are authoritative; names are only for owned datasets.").
 * Unlike Python's UUID constructor, brace-wrapped (`{…}`) and URN (`urn:uuid:…`)
 * forms are not accepted — practically irrelevant for the JSON env array and the
 * dataset arguments this feeds.
 */
export function canonicalUuid(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  if (UUID_RE.test(raw)) return raw.toLowerCase();
  if (UUID32_RE.test(raw)) {
    return [
      raw.slice(0, 8),
      raw.slice(8, 12),
      raw.slice(12, 16),
      raw.slice(16, 20),
      raw.slice(20, 32),
    ]
      .join("-")
      .toLowerCase();
  }
  return "";
}

export function sanitizeDatasetName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9-_.]/g, "-").slice(0, 100);
  return cleaned || "agent_sessions";
}

export function sanitizeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9-_.]/g, "-").slice(0, 120);
}

/**
 * `mint_switch_session_id` from the reference, ported: a switch never reuses
 * a session id — it mints the next ordinal suffix (`pi_x`, `pi_x__2`, `__3`, …),
 * so the new session never collides while staying readable in the dashboard.
 */
export function mintSwitchSessionId(current: string): string {
  const m = current.match(/^(.*)__(\d+)$/);
  return m ? `${m[1]}__${Number(m[2]) + 1}` : `${current}__2`;
}

/**
 * Match a user-given switch target against readable dataset rows: exact name,
 * or UUID (canonicalized — "Dataset UUIDs are authoritative"). More than one
 * row → ambiguous ("select its UUID"); zero → not listed (create-on-switch is
 * the picker's free-typed "Other" behavior, decided by the caller).
 */
export function matchDatasets(
  target: string,
  rows: { name: string; id: string }[],
): { status: "ok" | "ambiguous" | "missing"; matches: { name: string; id: string }[] } {
  const uuid = canonicalUuid(target);
  const matches = rows.filter((d) => (uuid ? canonicalUuid(d.id) === uuid : d.name === target));
  return {
    status: matches.length === 0 ? "missing" : matches.length > 1 ? "ambiguous" : "ok",
    matches,
  };
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
  /** Epoch ms when `last_status` was last observed (terminal write-back from a poll). */
  last_status_at?: number;
  error_count?: number;
  last_error_at?: number;
  last_error?: string;
}

const CODE_STATE_DIR =
  process.env.COGNEE_CODE_STATE_DIR ?? join(homedir(), ".cognee-plugin", "pi", "code-graph");

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

/*
 * ------------------------------------------------------------------
 * Per-file ingestion (cognee-remember --file) — guarded disk read
 * ------------------------------------------------------------------ */

/** Hard cap for a --file upload (same as the official plugins' practical limit). */
export const REMEMBER_FILE_MAX_BYTES = 200_000;

/** Obvious secret-carrier paths, refused before any disk read. The reference
 *  --file route uploads any user-given path verbatim (parity), but pi-cognee
 *  refuses credential-looking files (~/.ssh, *.pem, .env, id_rsa*, credentials*)
 *  with a helpful error — hardening beyond parity. */
const SENSITIVE_REMEMBER_PATH_RE =
  /(?:^|[\\/])\.ssh(?:[\\/]|$)|(?:^|[\\/])\.env(?:[\\/.]|$)|(?:^|[\\/])id_(?:rsa|dsa|ecdsa|ed25519)|(?:^|[\\/])credentials[^\\/]*$|\.pem$/i;

export interface RememberFileResult {
  ok: boolean;
  /** File text (utf-8) — verbatim, NOT redacted (code must route as code). */
  text?: string;
  /** Real basename — the server's loader-routing signal (payments.py → code route). */
  basename?: string;
  bytes?: number;
  error?: string;
}

/**
 * Read one file for /api/v1/remember file ingestion. Mirrors cognee-remember.sh
 * --file + _remember_http.do_remember: the file must exist, is capped in size,
 * and must be text (NUL bytes / control-char-heavy content is rejected — the
 * prose and code pipelines are text-only). Never throws; failures come back as
 * { ok: false, error } so callers can surface a helpful message.
 */
export function readRememberFile(
  filePath: string,
  maxBytes: number = REMEMBER_FILE_MAX_BYTES,
): RememberFileResult {
  try {
    const trimmed = String(filePath).replace(/\/+$/, "");
    if (SENSITIVE_REMEMBER_PATH_RE.test(trimmed)) {
      return {
        ok: false,
        error: `refusing likely-secret file '${filePath}' — remember the non-secret part as content instead`,
      };
    }
    const st = statSync(trimmed);
    if (!st.isFile()) return { ok: false, error: `not a file: ${filePath}` };
    if (st.size > maxBytes) {
      return {
        ok: false,
        error: `file too large (${st.size} bytes; limit ${maxBytes}) — remember a summary instead`,
      };
    }
    const buf = readFileSync(trimmed);
    // Text-only guard: a NUL byte or a control-char-heavy head means binary —
    // uploading it would corrupt the graph and route nowhere useful.
    const probe = buf.subarray(0, 8192);
    let control = 0;
    for (const byte of probe) {
      if (byte === 0) return { ok: false, error: `binary file rejected (NUL byte): ${filePath}` };
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) control++;
    }
    if (probe.length > 0 && control / probe.length > 0.1) {
      return { ok: false, error: `binary file rejected (too many control characters): ${filePath}` };
    }
    return {
      ok: true,
      text: buf.toString("utf8"),
      basename: basename(trimmed) || "upload.txt",
      bytes: st.size,
    };
  } catch (err) {
    const message = describeError(err);
    return {
      ok: false,
      error: /ENOENT/.test(message)
        ? `file not found: ${filePath}`
        : `cannot read ${filePath}: ${message}`,
    };
  }
}

/*
 * ------------------------------------------------------------------
 * File-shared circuit breaker (~/.cognee-plugin/pi/breaker.json)
 * ------------------------------------------------------------------ */

export interface SharedBreakerEntry {
  /** Epoch ms — recall is paused until then (0/absent = closed). */
  open_until?: number;
  /** Consecutive outage-classified failures seen across processes. */
  consecutive_failures?: number;
  updated_at?: string;
}

/** { "<base_url>": { open_until, consecutive_failures, updated_at } } */
export type SharedBreakerFile = Record<string, SharedBreakerEntry>;

export const DEFAULT_BREAKER_FILE = join(homedir(), ".cognee-plugin", "pi", "breaker.json");

/**
 * Read the shared breaker entry for one server. Stale-read tolerant: a missing,
 * corrupt, or non-object file is an empty entry (never throws), so a half-written
 * or foreign file degrades to per-process behavior instead of breaking recall.
 */
export function loadSharedBreaker(
  baseUrl: string,
  filePath: string = DEFAULT_BREAKER_FILE,
): SharedBreakerEntry {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const entry = (raw as SharedBreakerFile)[baseUrl];
    if (!entry || typeof entry !== "object") return {};
    return entry;
  } catch {
    return {};
  }
}

/**
 * Persist the shared breaker entry for one server. Best-effort atomic write
 * (temp file + rename, same pattern as the official plugins' state markers):
 * other entries in the file are preserved, and any failure is swallowed — the
 * in-memory breaker keeps working when the disk does not.
 */
export function saveSharedBreaker(
  baseUrl: string,
  entry: SharedBreakerEntry,
  filePath: string = DEFAULT_BREAKER_FILE,
): void {
  try {
    let all: SharedBreakerFile = {};
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) all = raw as SharedBreakerFile;
    } catch {
      /* unreadable/absent — start from an empty map */
    }
    all[baseUrl] = { ...entry, updated_at: new Date().toISOString() };
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), "utf8");
    renameSync(tmp, filePath);
  } catch {
    /* fail-soft — shared-state propagation is an optimization */
  }
}

/* ------------------------------------------------------------------ */
/* Persisted dataset switch (~/.cognee-plugin/pi/active-dataset.json)  */
/* The pi analog of the reference launch record: a switch must survive  */
/* restarts and resumes. pi has no stable host session id across        */
/* processes, so this record IS the session affinity.                   */
/* ------------------------------------------------------------------ */

export interface ActiveDatasetRecord {
  /** Server the switch was recorded for — never served to another backend. */
  base_url: string;
  /** sha256(baseUrl + effective api key) — same discipline as the reference's
   *  readable-datasets cache: an active dataset minted for one identity is
   *  never served to another. Keys on the PRINCIPAL key (never the agent key —
   *  flipping to a plugin identity must not orphan the persisted switch). */
  key_fp: string;
  dataset: string;
  /** Ordinal-suffixed session id minted by the switch (adopted on restart). */
  session_id: string;
  /** Canonical write UUID under shared memory (v0.4; "" → name addressing). */
  dataset_id?: string;
  /** Shared-memory recall read set (v0.4; write UUID + same-named copies). */
  dataset_ids?: string[];
  /** The retired triple (the reference keeps these in `touched`). */
  previous?: { dataset: string; session_id: string; synced: boolean };
  switched_at: string;
}

export const DEFAULT_PI_STATE_DIR = join(homedir(), ".cognee-plugin", "pi");

/** pi-side state dir (~/.cognee-plugin/pi), override for tests/embedding. */
export function piStateDir(): string {
  return process.env.COGNEE_PI_STATE_DIR ?? DEFAULT_PI_STATE_DIR;
}

export function activeDatasetPath(): string {
  return join(piStateDir(), "active-dataset.json");
}

/** The server+identity fingerprint a persisted switch is keyed by. */
export function datasetKeyFingerprint(baseUrl: string, apiKey?: string): string {
  return createHash("sha256").update(`${baseUrl}\n${apiKey ?? ""}`, "utf8").digest("hex");
}

/** Read the persisted active-dataset record; undefined unless it exists, parses,
 *  and belongs to exactly this backend (base_url + key fingerprint). Fail-soft:
 *  an absent or corrupt record leaves the env seed in charge, never a crash. */
export function loadActiveDatasetRecord(
  baseUrl: string,
  keyFp: string,
): ActiveDatasetRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(activeDatasetPath(), "utf8")) as ActiveDatasetRecord;
    if (!raw || typeof raw !== "object") return undefined;
    if (raw.base_url !== baseUrl || raw.key_fp !== keyFp) return undefined;
    if (typeof raw.dataset !== "string" || !raw.dataset) return undefined;
    if (typeof raw.session_id !== "string" || !raw.session_id) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** Atomically persist the active-dataset record (tmp + rename, same pattern as
 *  the other state writers). Unlike them this one REPORTS failure: the switcher
 *  must roll back when the record cannot be persisted ("nothing was changed").
 *  Never throws. */
export function saveActiveDatasetRecord(
  record: ActiveDatasetRecord,
): { ok: boolean; error?: string } {
  try {
    const dir = piStateDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "active-dataset.json");
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/* ------------------------------------------------------------------ */
/* Shared-agent-memory provisioning state (v0.4 — spec §3.2)          */
/* ~/.cognee-plugin/pi/agent-key.json + shared-memory.json, alongside  */
/* active-dataset.json. Fail-soft + atomic like every state writer.    */
/* ------------------------------------------------------------------ */

/** ~/.cognee-plugin/pi/agent-key.json (spec §3.2; the reference's agent_key.json). */
export interface AgentKeyRecord {
  base_url: string;
  api_key: string;
  agent_id: string;
  plugin_key: string;
  /** sha256(principal key) — binds the identity to the principal that minted it. */
  principal_fingerprint: string;
  updated_at: string;
  /** Stamped when the server rejects the key; never auto-re-provisioned. */
  blocked?: boolean;
}

/** sha256 of the principal key (reference _principal_fingerprint). */
export function principalFingerprint(key: string): string {
  return key ? createHash("sha256").update(key, "utf8").digest("hex") : "";
}

export function agentKeyPath(): string {
  return join(piStateDir(), "agent-key.json");
}

export function sharedMemoryMarkerPath(): string {
  return join(piStateDir(), "shared-memory.json");
}

/** The cached plugin identity, or undefined — only honored when its base_url
 *  matches this server. Never throws. */
export function loadAgentKeyRecord(baseUrl: string): AgentKeyRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(agentKeyPath(), "utf8")) as AgentKeyRecord;
    if (!raw || typeof raw !== "object") return undefined;
    const key = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
    if (!key) return undefined;
    const cachedUrl = (typeof raw.base_url === "string" ? raw.base_url : "").trim().replace(/\/+$/, "");
    if (cachedUrl && cachedUrl !== baseUrl.replace(/\/+$/, "")) return undefined;
    return {
      base_url: typeof raw.base_url === "string" ? raw.base_url : "",
      api_key: key,
      agent_id: typeof raw.agent_id === "string" ? raw.agent_id : "",
      plugin_key: typeof raw.plugin_key === "string" ? raw.plugin_key : PLUGIN_KEY,
      principal_fingerprint: typeof raw.principal_fingerprint === "string" ? raw.principal_fingerprint : "",
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
      blocked: raw.blocked === true ? true : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Atomically persist the plugin identity (0600, tmp + rename). Never throws. */
export function saveAgentKeyRecord(record: AgentKeyRecord): void {
  try {
    mkdirSync(piStateDir(), { recursive: true });
    const tmp = `${agentKeyPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...record, updated_at: new Date().toISOString() }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, agentKeyPath());
  } catch {
    /* fail-soft — the key stays in memory for this session */
  }
}

/** Stamp `blocked` on the cached identity when it is still the expected key
 *  (a concurrent reconnect may have replaced it) — reads the raw file, no
 *  base_url gate. Never throws. */
export function blockAgentKeyRecord(expectedKey: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(agentKeyPath(), "utf8")) as AgentKeyRecord;
    if (!raw || typeof raw !== "object") return false;
    const key = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
    if (!key || key !== expectedKey) return false;
    saveAgentKeyRecord({ ...raw, api_key: key, blocked: true });
    return true;
  } catch {
    return false;
  }
}

/** Drop the cached identity (revoked key / post-provision revert). */
export function clearAgentKeyRecord(): void {
  try {
    unlinkSync(agentKeyPath());
  } catch {
    /* absent — fine */
  }
}

/** The wiring marker for this server, or {} — base_url mismatch (or a foreign/
 *  corrupt file) is treated as absent (per-server marker, §1.1). */
export function loadSharedMemoryMarker(baseUrl: string): SharedMemoryMarker {
  try {
    const raw = JSON.parse(readFileSync(sharedMemoryMarkerPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const marker = raw as SharedMemoryMarker;
    const cachedUrl = (typeof marker.base_url === "string" ? marker.base_url : "").trim().replace(/\/+$/, "");
    const wanted = baseUrl.replace(/\/+$/, "");
    if (wanted && cachedUrl && cachedUrl !== wanted) return {};
    return marker;
  } catch {
    return {};
  }
}

/** Persist the marker, stamping updated_at + the plugin version (a structural
 *  reason is only structural for THIS version — §2.4). Never throws. */
export function saveSharedMemoryMarker(marker: SharedMemoryMarker): void {
  try {
    mkdirSync(piStateDir(), { recursive: true });
    const tmp = `${sharedMemoryMarkerPath()}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        ...marker,
        updated_at: new Date().toISOString(),
        plugin_version: PROVISIONING_PLUGIN_VERSION,
      }, null, 2) + "\n",
      "utf8",
    );
    renameSync(tmp, sharedMemoryMarkerPath());
  } catch {
    /* fail-soft — wiring state is re-derived at the next session start */
  }
}

/** Provisioning event log — same JSON-lines bootstrap.log the v0.4 bootstrap
 *  cluster writes (rotated at COGNEE_PLUGIN_LOG_MAX_BYTES). Fail-soft. */
export function logPluginEvent(event: Record<string, unknown>): void {
  try {
    const path = join(piStateDir(), "bootstrap.log");
    mkdirSync(piStateDir(), { recursive: true });
    let maxBytes = 20 * 1024 * 1024;
    const raw = process.env.COGNEE_PLUGIN_LOG_MAX_BYTES;
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) maxBytes = parsed;
    }
    try {
      if (statSync(path).size >= maxBytes) {
        try {
          unlinkSync(`${path}.1`);
        } catch {
          /* no previous rotation */
        }
        renameSync(path, `${path}.1`);
      }
    } catch {
      /* absent — first line */
    }
    writeFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { flag: "a" });
  } catch {
    /* fail-soft */
  }
}

/* ------------------------------------------------------------------ */
/* Capture policy: redaction + truncation (per the claude-code brief §4) */
/* ------------------------------------------------------------------ */

/** Reference-exact redaction rules (`_capture_policy.py` `_RULES`) — the shared
 *  superset both the QA text path (`redactSecrets`) and the trace path
 *  (`redactForCapture`) apply. Order matters (authorization before credential,
 *  so a bearer header is tagged once; vendor prefixes before bcrypt). */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted:private-key]"],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s"'<>]+/gi, "[redacted:connection]"],
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted:authorization]"],
  [/["']?\b(?:[\w-]*[_-])?(?:secret|token|password|passwd|api[_-]?key|x-api-key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[redacted:credential]"],
  [/\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|xox[baprs]-|whsec_)[A-Za-z0-9_-]{16,}/g, "[redacted:vendor-key]"],
  [/\$2[aby]\$\d{2}\$[.\/A-Za-z0-9]{53}/g, "[redacted:bcrypt]"],
];

/** Best-effort secret redaction, applied BEFORE truncation so a clipped key cannot escape. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tool-call trace capture (v0.4 — research/v04-traces-spec.md)        */
/* Port of the reference _capture_policy.py: fnmatch-style allowlist,  */
/* sensitive-path deny list (entry-level refusal, never partial        */
/* redaction), recursive redaction with the secret-key rule + custom   */
/* regex patterns, and TraceEntry construction with the reference      */
/* caps (4000/8000/500 bytes).                                         */
/* ------------------------------------------------------------------ */

/** The reference PostToolUse matcher translated to pi tool names — the DEFAULT
 *  value of COGNEE_CAPTURE_TOOLS (a user-set value replaces it wholesale). */
export const DEFAULT_CAPTURE_TOOLS: readonly string[] = [
  "bash", "powershell", "read", "write", "edit", "grep", "find", "ls",
];

/** Reference caps (_MAX_PARAMS_BYTES / _MAX_RETURN_BYTES / error 500). */
export const TRACE_MAX_PARAM_BYTES = 4000;
export const TRACE_MAX_RETURN_BYTES = 8000;
export const TRACE_MAX_ERROR_BYTES = 500;

/** fnmatch-subset glob → anchored RegExp: `*`, `?`, `[...]` / `[!...]`,
 *  case-sensitive, `*` crosses path separators (required by the `*\/.ssh\/*`
 *  deny pattern). Full-string match like fnmatchcase. No dependency. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      const negated = pattern[i + 1] === "!" || pattern[i + 1] === "^";
      const start = negated ? i + 2 : i + 1;
      if (close < start) {
        re += "\\["; // unterminated class — literal "["
        continue;
      }
      let cls = pattern.slice(start, close).replace(/[\\\]]/g, "\\$&");
      if (negated) cls = `^${cls.replace(/^\^/, "\\^")}`;
      re += `[${cls}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Reference `_list_env`: unset/blank → []; a leading `[` switches to JSON-array
 *  mode (must be an array of strings — the exact reference error otherwise);
 *  anything else splits on `separator`, parts trimmed, empties dropped. */
export function parseListEnv(
  raw: string | undefined,
  opts: { separator: string; label: string },
): { values: string[]; error?: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { values: [] };
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
        return { values: [], error: `${opts.label} must be an array of strings` };
      }
      return { values: parsed };
    } catch (err) {
      return { values: [], error: `${opts.label} is not valid JSON: ${describeError(err)}` };
    }
  }
  return { values: trimmed.split(opts.separator).map((part) => part.trim()).filter(Boolean) };
}

/** Reference `_PATH_KEYS` — only values under these keys (compare lowercased,
 *  recursing nested dicts/lists) are tested against the deny list. */
const PATH_KEYS: ReadonlySet<string> = new Set([
  "file_path", "filepath", "path", "paths", "notebook_path", "filename",
]);

/** Reference `_DENY_PATHS`, verbatim. */
const DENY_PATHS: readonly string[] = [
  ".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc",
  "*/.aws/credentials", "*/.ssh/*", "*.p12", "*.pfx", "secrets.*", "credentials.*",
];

/** Reference `_sensitive_path`: the basename OR the `/`-prefixed normalized
 *  full path fnmatches any deny pattern (compiled-in + COGNEE_CAPTURE_DENY_PATHS
 *  extras); normalization = backslashes→`/` + lowercase. */
export function sensitivePathValue(value: unknown, extraDeny: readonly string[] = []): boolean {
  if (Array.isArray(value)) return value.some((item) => sensitivePathValue(item, extraDeny));
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;
  const slashPrefixed = `/${normalized.replace(/^\/+/, "")}`;
  for (const raw of [...DENY_PATHS, ...extraDeny]) {
    const re = globToRegExp(raw.toLowerCase());
    if (re.test(name) || re.test(slashPrefixed)) return true;
  }
  return false;
}

/** Reference `_has_sensitive_path`: recurses dicts/lists; a PATH_KEY carrying a
 *  sensitive value refuses the WHOLE entry — never partially redacted. */
export function hasSensitivePath(value: unknown, extraDeny: readonly string[] = []): boolean {
  if (Array.isArray(value)) return value.some((item) => hasSensitivePath(item, extraDeny));
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) =>
        (PATH_KEYS.has(key.toLowerCase()) && sensitivePathValue(item, extraDeny)) ||
        hasSensitivePath(item, extraDeny),
    );
  }
  return false;
}

/** Reference `allow_tool` minus the master switch (the handler gates
 *  cfg.capture first): fnmatch allowlist (empty → `*`, reference default),
 *  then the sensitive-path deny list. */
export function allowToolCall(
  toolName: string,
  input: unknown,
  policy: { allowTools: readonly string[]; denyPaths: readonly string[] },
): boolean {
  const patterns = policy.allowTools.length ? policy.allowTools : ["*"];
  if (!patterns.some((p) => globToRegExp(p).test(toolName))) return false;
  return !hasSensitivePath(input, policy.denyPaths);
}

/** Reference `_SECRET_KEY` — dict keys whose values are replaced wholesale. */
const SECRET_KEY_RE =
  /^(?:authorization|x-api-key|(?:.*[_-])?(?:secret|token|password|passwd|api[_-]?key))$/i;

export interface RedactOptions {
  /** COGNEE_CAPTURE_REDACT=false disables all trace redaction (default true). */
  redact?: boolean;
  /** COGNEE_CAPTURE_REDACT_PATTERNS — each replaces matches with [redacted:custom]. */
  customPatterns?: readonly string[];
}

/** Reference `redact()`, recursive: dict values under secret keys →
 *  `[redacted:credential]` wholesale (never re-walked); strings → the shared
 *  REDACTIONS superset, then custom patterns; lists recurse; everything else
 *  passes through untouched. Invalid custom regexes are skipped (validated at
 *  config load with a doctor warning — fail-soft divergence). */
export function redactForCapture(value: unknown, opts: RedactOptions = {}): unknown {
  if (opts.redact === false) return value;
  const customs: RegExp[] = [];
  for (const pattern of opts.customPatterns ?? []) {
    try {
      customs.push(new RegExp(pattern, "g"));
    } catch {
      /* skipped — surfaced by /cognee-doctor */
    }
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = redactSecrets(v);
      for (const re of customs) out = out.replace(re, "[redacted:custom]");
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) {
        out[key] = SECRET_KEY_RE.test(key) ? "[redacted:credential]" : walk(item);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Join the text blocks of a content array (ImageContent contributes no text).
 *  Shared by the QA and trace capture paths. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text?: string } =>
        Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text",
      )
      .map((block) => block.text ?? "")
      .join("\n");
  }
  return "";
}

/** OpenAPI TraceEntry (type "trace") — one captured tool call (reference
 *  `_store_tool_call`; memory_query / memory_context stay server-defaulted
 *  because the reference never populates them). */
export interface TraceEntry {
  type: "trace";
  origin_function: string;
  status: "success" | "error";
  method_params: Record<string, string>;
  method_return_value: string;
  error_message: string;
  generate_feedback_with_llm: boolean;
}

/** The slice of a pi ToolResultEvent that buildTraceEntry consumes (tests pass
 *  plain objects; the handler passes the real event). */
export interface ToolResultLike {
  toolName: string;
  input: unknown;
  content: unknown;
  isError: boolean;
}

export interface CapturePolicy {
  allowTools: readonly string[];
  denyPaths: readonly string[];
  redact: boolean;
  redactPatterns: readonly string[];
}

/** json.dumps(default=str) analog for non-string param values: custom tool
 *  inputs can hold non-JSON-safe values (functions, bigints) — fall back to
 *  String(v) on a JSON TypeError instead of throwing. */
function safeJson(value: unknown): string {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? String(value) : out;
  } catch {
    return String(value);
  }
}

/** Reference `_store_tool_call` steps minus queueing: allowlist + deny-list
 *  refusal (→ undefined — the entry is dropped whole, never partially
 *  redacted), redact input and output BEFORE truncation, then build the
 *  TraceEntry with the reference caps. */
export function buildTraceEntry(event: ToolResultLike, policy: CapturePolicy): TraceEntry | undefined {
  if (!allowToolCall(event.toolName, event.input, policy)) return undefined;
  const redactOpts = { redact: policy.redact, customPatterns: policy.redactPatterns };
  const redactedInput = redactForCapture(event.input ?? {}, redactOpts);
  const paramsSource =
    redactedInput && typeof redactedInput === "object" && !Array.isArray(redactedInput)
      ? (redactedInput as Record<string, unknown>)
      : { value: redactedInput };
  const method_params: Record<string, string> = {};
  for (const [key, value] of Object.entries(paramsSource)) {
    method_params[key] = truncateText(
      typeof value === "string" ? value : safeJson(value),
      TRACE_MAX_PARAM_BYTES,
    );
  }
  const redactedText = redactForCapture(extractText(event.content), redactOpts);
  const text = typeof redactedText === "string" ? redactedText : safeJson(redactedText);
  const status: "success" | "error" = event.isError ? "error" : "success";
  return {
    type: "trace",
    origin_function: event.toolName,
    status,
    method_params,
    method_return_value: truncateText(text, TRACE_MAX_RETURN_BYTES),
    error_message: status === "error" ? truncateText(text, TRACE_MAX_ERROR_BYTES) : "",
    generate_feedback_with_llm: false, // reference constant — per-step LLM feedback deferred
  };
}

/** Byte-aware truncation with `...` marker — semantically equal to the reference
 *  `_truncate_str`: every string round-trips through utf-8 so lone surrogates
 *  become U+FFFD (one stored surrogate 500s the server's session endpoints and
 *  wedges improve); over-cap strings are sliced to cap-3 bytes with a partially
 *  cut trailing multibyte sequence dropped (errors="ignore"), then suffixed
 *  `...`. Redaction must always run BEFORE this so a clipped key cannot escape. */
export function truncateText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const safe = Buffer.from(text, "utf8").toString("utf8");
  if (Buffer.byteLength(safe, "utf8") <= maxBytes) return safe;
  const buf = Buffer.from(safe, "utf8").subarray(0, Math.max(0, maxBytes - 3));
  let end = buf.length;
  // The input is valid utf-8 by construction, so a cut sequence can only sit at
  // the very end. Drop it (errors="ignore") whether the slice kept none of its
  // continuation bytes (trailing lead byte) or some of them.
  if (end > 0 && (buf[end - 1] & 0x80) !== 0) {
    const expected = buf[end - 1] >= 0xf0 ? 4 : buf[end - 1] >= 0xe0 ? 3 : buf[end - 1] >= 0xc0 ? 2 : 0;
    if (expected > 0) {
      end -= 1; // trailing lead byte whose sequence did not fit
    } else {
      let lead = end - 1;
      while (lead > 0 && (buf[lead] & 0xc0) === 0x80) lead--;
      const need = buf[lead] >= 0xf0 ? 4 : buf[lead] >= 0xe0 ? 3 : 2;
      if (lead + need > end) end = lead;
    }
  }
  return buf.subarray(0, end).toString("utf8") + "...";
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
}

export interface RememberParams {
  content: string;
  filename?: string;
  nodeSet?: "user_context" | "project_docs" | "agent_actions";
  dataset?: string;
  datasetId?: string;
  /** Defaults to cfg.rememberBackground (COGNEE_REMEMBER_BACKGROUND, default true). */
  background?: boolean;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
}

/** How a remember() call landed. "stored" = plain POST add (or fallback after a
 *  discovery failure); "updated" = the existing data item was PATCHed (delta
 *  re-ingestion, chunk-level diff server-side); "unchanged" = content hash-
 *  identical to the stored copy — nothing was sent. Only the explicit-filename
 *  (real file upload) lane can produce "updated"/"unchanged"; prose memories
 *  use timestamped synthetic names and stay append-only by design. */
export type RememberOutcome = "stored" | "updated" | "unchanged";

/** Structured outcome of the update path (PATCH /api/v1/update). */
export interface RememberUpdateInfo {
  /** Server status: incremental | unchanged | full_rebuild ("failed" returns ok:false). */
  status: string;
  /** One compact line for humans: "+3/−1 chunks, 12 kept" / "memory dropped and rebuilt (fallback: …)". */
  detail: string;
}

export interface RememberResult {
  ok: boolean;
  status?: number;
  outcome?: RememberOutcome;
  datasetId?: string;
  /** The data item's UUID (update/unchanged paths) — the handle for a targeted forget. */
  dataId?: string;
  pipelineRunId?: string;
  update?: RememberUpdateInfo;
  error?: CogneeError;
}

/** `error` string from an UpdateResult/ErrorResponse body, when present (lenient). */
function errorStringFromUpdateBody(data: Record<string, unknown>): string | undefined {
  if (typeof data.error === "string" && data.error) return data.error; // ErrorResponse
  const err = data.error;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message; // UpdateResult.error
  }
  return undefined;
}

/** One compact human line for an UpdateResult: "+3/−1 chunks, 12 kept"
 *  (incremental), "no content change" (unchanged), or "memory dropped and
 *  rebuilt (fallback: <reason>)" — counters are null on a rebuild by contract. */
function updateSummaryLine(data: Record<string, unknown>): string {
  const status = String(data.status ?? "");
  const num = (key: string): number | null => {
    const v = data[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const fallback = data.fallback;
  const reason =
    fallback && typeof fallback === "object" && typeof (fallback as { reason?: unknown }).reason === "string"
      ? (fallback as { reason: string }).reason
      : "";
  if (status === "unchanged") return "no content change";
  if (status === "full_rebuild") {
    return `memory dropped and rebuilt${reason ? ` (fallback: ${reason})` : ""}`;
  }
  const parts: string[] = [];
  const added = num("added_chunks");
  const deleted = num("deleted_chunks");
  if (added !== null || deleted !== null) parts.push(`+${added ?? 0}/−${deleted ?? 0} chunks`);
  const kept = num("kept_chunks");
  if (kept !== null) parts.push(`${kept} kept`);
  const reused = num("reused_chunks");
  if (reused !== null && reused > 0) parts.push(`${reused} reused`);
  if (reason) parts.push(`fallback: ${reason}`);
  return parts.join(", ") || status;
}

export type ImproveOutcome = "ok" | "busy" | "unsupported" | "error";

export interface DatasetInfo {
  name: string;
  id: string;
  owner_id?: string;
  ownerId?: string;
  /** Creation timestamp (newest spelling wins; used for canonical pick). */
  created_at?: string;
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

/** A trace row of `GET /api/v1/sessions/{id}` — the server echoes the stored
 *  TraceEntry fields (v0.4: verify-before-replay fingerprints traces too). */
export interface SessionTraceRow {
  origin_function?: string;
  status?: string;
  method_params?: Record<string, unknown>;
  method_return_value?: unknown;
  error_message?: string;
  [key: string]: unknown;
}

export interface HealthResult {
  reachable: boolean;
  latencyMs: number;
  status?: number;
  version?: string;
  error?: string;
}

/** openapi capability verdict (§2.2): `probed: false` = unreachable/unparseable. */
export interface CapabilityVerdict {
  probed: boolean;
  /** Provision POST advertises the create_only contract. */
  provisioning: boolean;
  /** remember/entry carries x-cognee-session-dataset-ids: true. */
  typedDatasetIds: boolean;
}

/** First non-empty of several spellings (OutDTOs answer camelCase — reference
 *  _row_str). */
function rowStr(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
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

  /* ----- v0.4 shared-agent-memory identity (spec §3.3) -----
   * After the existing env → cached-owner (→ lazy mint) principal resolution,
   * a cached plugin identity (agent-key.json) may take over the DATA plane.
   * Usable exactly when: the record loads ∧ mode ≠ disabled ∧ a principal is
   * known ∧ principal_fingerprint matches. The principal is retained for the
   * CONTROL plane (owner-only server-side); strict-mode obstacles are surfaced
   * as `identityProblem` (a one-line warning — pi never hard-fails startup,
   * fail-soft divergence from the reference's raise). */
  private agentKey: string | undefined;
  private agentId: string | undefined;
  /** Reference-verbatim obstacle text for a cached-but-unusable identity. */
  identityProblem: string | undefined;
  /** Machine kind of the obstacle ("blocked" | "principal_mismatch" | "not_connected"). */
  identityProblemKind: string | undefined;
  /** openapi capability cache — one probe per session start + 60 s TTL (§2.2). */
  private capabilityCache: { at: number; verdict: CapabilityVerdict } | undefined;

  constructor(cfg: CogneeConfig) {
    this.cfg = cfg;
    this.refreshAgentIdentity();
  }

  /** Re-evaluate the cached plugin identity against the current principal.
   *  Sync + fail-soft (file read); called at construction and again after the
   *  lazy local owner-key mint resolves a principal. */
  refreshAgentIdentity(): void {
    this.agentKey = undefined;
    this.agentId = undefined;
    this.identityProblem = undefined;
    this.identityProblemKind = undefined;
    if (this.cfg.pluginIdentity === "disabled") return;
    const record = loadAgentKeyRecord(this.cfg.baseUrl);
    if (!record) {
      if (this.cfg.pluginIdentity === "enabled") {
        this.identityProblem = "Plugin identity is enabled but not connected; run a session start to provision";
        this.identityProblemKind = "not_connected";
      }
      return;
    }
    const principal = this.cfg.apiKey ?? this.mintedKey;
    let problem = "";
    let kind = "";
    if (record.blocked) {
      problem = "Plugin identity was rejected; reconnect explicitly (no automatic rotation)";
      kind = "blocked";
    } else if (!principal || record.principal_fingerprint !== principalFingerprint(principal)) {
      problem = "Plugin identity belongs to another or unverified principal; run a session start";
      kind = "principal_mismatch";
    }
    if (!problem) {
      this.agentKey = record.api_key;
      this.agentId = record.agent_id;
      return;
    }
    // A rejected or foreign identity is never used; `enabled` makes that an
    // error (pi: warning), `auto` keeps the plugin working as the principal.
    this.identityProblem = problem;
    this.identityProblemKind = kind;
  }

  /** The cached plugin identity's key when it is the credential in force. */
  get activeAgentKey(): string | undefined {
    return this.agentKey;
  }

  /** The cached plugin identity's agent id (shared memory wires BY id). */
  get activeAgentId(): string | undefined {
    return this.agentId;
  }

  /** Drop the in-memory identity (after revert/block) — subsequent calls run
   *  as the principal for the rest of this process. */
  dropAgentIdentity(): void {
    this.agentKey = undefined;
    this.agentId = undefined;
  }

  /** The PARENT user's key, for control-plane calls — never the agent key
   *  (reference principal_key_for_control_plane: an env key equal to the
   *  cached agent key is the agent's, not the user's). */
  principalKey(): string | undefined {
    const agentKey = this.agentKey;
    for (const candidate of [this.cfg.apiKey, this.mintedKey]) {
      if (candidate && candidate !== agentKey) return candidate;
    }
    return undefined;
  }

  /** Effective DATA-plane key: agent identity wins over the principal. */
  private effectiveKey(): string | undefined {
    return this.agentKey ?? this.cfg.apiKey ?? this.mintedKey;
  }

  private authHeaders(): Record<string, string> {
    const key = this.effectiveKey();
    return key ? { "X-Api-Key": key } : {};
  }

  /** The server+identity fingerprint under which a persisted dataset switch is
   *  stored for this client. Deliberately keyed on the PRINCIPAL (never the
   *  agent key — spec §3.2): flipping to a plugin identity must not orphan the
   *  persisted switch. */
  keyFingerprint(): string {
    return datasetKeyFingerprint(this.cfg.baseUrl, this.principalKey());
  }

  /** Effective key source for display, including the plugin identity and the
   *  lazy local bootstrap mint. */
  authSummary(): string {
    if (this.agentKey) return "plugin identity (~/.cognee-plugin/pi/agent-key.json)";
    if (this.cfg.apiKey) return this.cfg.apiKeySource;
    if (this.mintedKey) return "auto-minted owner key (~/.cognee-plugin/api_key.json)";
    return this.mintFailed ? "not set (local owner-key bootstrap failed — run /cognee-doctor)" : "not set";
  }

  /** Cache an env-provided principal into the shared ~/.cognee-plugin/api_key.json
   *  when nothing is cached yet (reference: detached workers can still act as
   *  the parent after provisioning). */
  ensurePrincipalCached(): void {
    const principal = this.principalKey();
    if (principal && !loadCachedApiKey(this.cfg.baseUrl)) {
      saveCachedApiKey(this.cfg.baseUrl, principal);
    }
  }

  /** A 401/403 while authenticating AS the agent key: the provisioned key was
   *  revoked out-of-band. Blocked so no later call reuses it — and never
   *  auto-re-provisioned (create-only refuses an existing agent; rotating
   *  would revoke another machine's key). Never throws. */
  private rejectAgentKey(usedKey: string | undefined): void {
    if (!usedKey || usedKey !== this.agentKey) return;
    blockAgentKeyRecord(usedKey);
    this.agentKey = undefined;
    this.agentId = undefined;
    this.identityProblem = "Plugin identity was rejected; reconnect explicitly (no automatic rotation)";
    this.identityProblemKind = "blocked";
    logPluginEvent({ event: "plugin_identity_rejected_fallback", agent_key_blocked: true });
  }

  /**
   * Lazy owner-key bootstrap for loopback servers with auth enforced (cognee ≥ 1.2.2
   * authenticates even localhost): login as the default user, reuse-or-mint an owner
   * API key, cache it in the shared ~/.cognee-plugin/api_key.json. Never throws;
   * runs at most once per process (a failed mint is not retried this session).
   */
  async ensureAuth(): Promise<void> {
    if (this.cfg.apiKey || this.mintedKey || this.mintFailed) {
      // A principal that appeared since the last identity check (env key set at
      // construction) needs no re-check; one minted just now does.
      if (this.mintedKey && !this.agentKey && !this.identityProblem) this.refreshAgentIdentity();
      return;
    }
    if (!isLoopbackUrl(this.cfg.baseUrl)) return; // cloud/remote servers need an explicit key
    if (!this.mintPromise) {
      this.mintPromise = this.mintOwnerKey()
        .then((key) => {
          this.mintedKey = key;
          saveCachedApiKey(this.cfg.baseUrl, key);
          // The mint resolved a principal — re-evaluate the cached plugin
          // identity against it (fingerprint may now match).
          this.refreshAgentIdentity();
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
      const usedKey = this.effectiveKey();
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
        if (resp.status === 401 || resp.status === 403) this.rejectAgentKey(usedKey);
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
   * POST /api/v1/recall. Dataset addressing mirrors _dataset_access.py
   * recall_fields(): a UUID-shaped dataset value → dataset_ids (canonicalized —
   * "Dataset UUIDs are authoritative; names are only for owned datasets"), a
   * plain name → datasets, neither → server default. The session binding stays
   * attached outside the federated path (only federation drops it, like the
   * reference). 404 on graph scope = authoritative empty (no graph yet) and is
   * returned as ok with noGraph=true.
   *
   * Federation (research/federation-brief.md, mirroring _dataset_access.py):
   * on an EXACT ["graph"] scope with COGNEE_PLUGIN_READ_DATASET_IDS configured, the
   * payload addresses the federated read set via dataset_ids ONLY — dataset/datasets
   * and session_id are dropped ("session history remains bound to ONE dataset.
   * Federated graph recall is a separate read"). Precedence: env federation >
   * explicit datasetIds > dataset name; the code lane (scope=["code"]) never
   * federates. Writes never consult the federation config.
   *
   * Renamed body keys are dual-spelled (snake_case for cognee ≤ 1.5.x, camelCase per
   * the 1.6.0 RecallPayloadDTO schema) — each server version reads the spelling it
   * knows and ignores the other; query/scope/datasets never changed casing.
   */
  async recall(params: RecallParams): Promise<RecallResult> {
    const scope = params.scope ?? ["graph"];
    const topK = Math.max(1, params.topK ?? 5);
    const onlyContext = params.onlyContext ?? true;
    const body: Record<string, unknown> = {
      query: params.query,
      top_k: topK,
      topK,
      only_context: onlyContext,
      onlyContext,
      scope,
    };
    if (params.searchType) {
      body.search_type = params.searchType;
      body.searchType = params.searchType;
    }
    // Exact ["graph"]-scope gate only — any other scope (e.g. ["graph","session"],
    // ["code"]) keeps normal name addressing and the session binding.
    const graphOnly = scope.length === 1 && scope[0] === "graph";
    if (graphOnly && this.cfg.readDatasetIds?.length) {
      body.dataset_ids = this.cfg.readDatasetIds;
      body.datasetIds = this.cfg.readDatasetIds;
    } else if (params.datasetIds?.length) {
      body.dataset_ids = params.datasetIds;
      body.datasetIds = params.datasetIds;
    } else {
      // Reference recall_fields(): a UUID-shaped dataset value is authoritative —
      // address dataset_ids (canonicalized); a plain name addresses datasets. The
      // session binding stays attached in both cases (only federation drops it).
      const ident = canonicalUuid(params.dataset);
      if (ident) {
        body.dataset_ids = [ident];
        body.datasetIds = [ident];
      } else if (params.dataset) {
        body.datasets = [params.datasetPresanitized ? params.dataset : sanitizeDatasetName(params.dataset)];
      }
      if (params.sessionId) {
        body.session_id = params.sessionId;
        body.sessionId = params.sessionId;
      }
    }
    if (params.codeQuery && scope.includes("code")) {
      body.code_query = params.codeQuery;
      body.codeQuery = params.codeQuery;
    }

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
   * run_in_background defaults to cfg.rememberBackground (COGNEE_REMEMBER_BACKGROUND —
   * set false for a synchronous, immediately-queryable write, like the reference).
   *
   * Update-when-changed (v0.3): when `filename` is EXPLICITLY set (a real file upload,
   * never the synthetic prose timestamp), the client first discovers the data item
   * previously ingested under that basename and either no-ops (identical bytes) or
   * PATCHes it (chunk-level diff server-side) instead of adding a duplicate. Every
   * discovery failure degrades to the plain add below — see updateExistingFileIfChanged.
   */
  async remember(params: RememberParams): Promise<RememberResult> {
    try {
      await this.ensureAuth(); // no-op once a key is resolved (or off-loopback)
      const usedKey = this.effectiveKey();
      if (params.filename) {
        const delta = await this.updateExistingFileIfChanged(params);
        if (delta) return delta; // handled (unchanged / updated / hard error)
      }
      const form = new FormData();
      form.set("node_set", params.nodeSet ?? "user_context");
      form.set("run_in_background", String(params.background ?? this.cfg.rememberBackground));
      if (params.datasetId) form.set("datasetId", params.datasetId);
      else if (params.dataset) {
        // Reference write_fields(): a UUID-shaped dataset value addresses
        // datasetId (canonicalized — UUIDs are authoritative), a plain name
        // addresses datasetName.
        const ident = canonicalUuid(params.dataset);
        if (ident) form.set("datasetId", ident);
        else form.set("datasetName", sanitizeDatasetName(params.dataset));
      }
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
        if (resp.status === 401 || resp.status === 403) this.rejectAgentKey(usedKey);
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
        outcome: "stored",
        datasetId: data?.dataset_id ?? data?.datasetId,
        pipelineRunId: data?.pipeline_run_id,
      };
    } catch (err) {
      return { ok: false, error: wrapAsCogneeError(err) };
    }
  }

  /**
   * Update-when-changed for an explicit-filename remember (v0.3): discover the
   * data item previously ingested under this basename (exact `name` match,
   * latest `createdAt` on same-name twins), compare content hashes statelessly,
   * and either no-op (identical), PATCH /api/v1/update (changed — chunk-level
   * diff server-side), or signal the caller to fall back to a plain add
   * (returns undefined: dataset/item listing failed, name never ingested, or
   * the item vanished mid-flight — the 404 race with forget). A FAILED update
   * returns ok:false WITHOUT a plain-add fallback: the document still exists,
   * and a duplicate add would corrupt its identity. Never throws.
   */
  private async updateExistingFileIfChanged(params: RememberParams): Promise<RememberResult | undefined> {
    try {
      if (!params.filename) return undefined;
      // 1. Dataset UUID — the data-item routes are UUID-addressed. A UUID-shaped
      //    dataset value (datasetId or dataset) is used as-is; a plain name is
      //    resolved via one extra GET. A NAME-shaped datasetId addresses
      //    datasetName — the explicit dataset param wins over it (mirrors
      //    write_fields()' routing; no caller mixes them today, defensive).
      const dsParam = canonicalUuid(params.datasetId ?? "")
        ? params.datasetId
        : params.dataset ?? params.datasetId;
      let datasetId = canonicalUuid(dsParam ?? "");
      if (!datasetId && dsParam) {
        const listed = await this.listDatasets();
        if (!listed.ok) return undefined; // discovery failed → fail open to a plain add
        const hit = listed.datasets.find((d) => d.name === sanitizeDatasetName(dsParam!));
        if (!hit?.id) return undefined; // name not on the server yet → plain add creates it
        datasetId = canonicalUuid(hit.id);
      }
      if (!datasetId) return undefined;
      // 2. Exact basename match; latest createdAt wins on same-name twins (the
      //    hash compare below is the safety net — identical content no-ops
      //    regardless of which twin matched).
      const items = await this.listDataItems(datasetId);
      if (!items.ok) return undefined;
      const matches = items.items.filter((i) => i.name === params.filename && canonicalUuid(i.id));
      if (matches.length === 0) return undefined; // never ingested under this name → plain add
      let item = matches[0];
      for (const m of matches) {
        if ((m.created_at ?? "") >= (item.created_at ?? "")) item = m; // ISO sort, ties → last
      }
      const dataId = canonicalUuid(item.id);
      // 3. Stateless content compare: identical bytes → authoritative no-op
      //    (nothing sent). Raw unreadable/shape-mismatch → treat as changed; the
      //    server-side "unchanged" status is the backstop.
      const localHash = createHash("sha256").update(params.content, "utf8").digest("hex");
      const raw = await this.getDataItemRaw(datasetId, dataId);
      if (raw.ok && createHash("sha256").update(raw.text, "utf8").digest("hex") === localHash) {
        return {
          ok: true,
          outcome: "unchanged",
          dataId,
          update: { status: "unchanged", detail: "identical to the stored copy" },
        };
      }
      // 4. Changed → PATCH under the same data_id (server diffs chunks; falls
      //    back to a delete+re-ingest transparently, also under the same id).
      const update = await this.updateDataItem({
        datasetId,
        dataId,
        content: params.content,
        filename: params.filename,
        externalSignal: params.externalSignal,
      });
      if (update.ok) {
        return {
          ok: true,
          outcome: "updated",
          datasetId: update.datasetId || datasetId,
          dataId,
          pipelineRunId: update.pipelineRunId,
          update: { status: update.status ?? "update", detail: update.detail ?? "" },
        };
      }
      if (update.vanished) return undefined; // raced with forget → plain add re-creates it
      return { ok: false, outcome: "updated", error: update.error };
    } catch {
      return undefined; // discovery itself failed → plain add (fail open)
    }
  }

  /**
   * PATCH /api/v1/update — replace the stored content of one data item under
   * its stable `data_id` (cognee 1.6.0): chunk_level_diff defaults true server-
   * side, so the server diffs the new content against the stored text and
   * either replaces only the affected chunks or transparently falls back to a
   * full delete+re-ingest — both keep the data_id. `node_set` and
   * `chunk_level_diff` are deliberately omitted (the document already belongs
   * to its node set; the default diff behavior is what we want). Both ids are
   * canonicalized BEFORE the request — a non-UUID never leaves the client (the
   * 422 guard). No retry (a write). A 404 means the item vanished since
   * discovery (race with forget) and is reported as vanished:true so the caller
   * can fall back to a plain add. A 500 carries either an UpdateResult with
   * status:"failed" or an ErrorResponse — parsed leniently either way.
   */
  async updateDataItem(params: {
    datasetId: string;
    dataId: string;
    content: string;
    filename: string;
    timeoutMs?: number;
    externalSignal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    status?: string;
    datasetId?: string;
    pipelineRunId?: string;
    /** Compact human summary of the chunk counters / rebuild fallback. */
    detail?: string;
    /** 404 — data_id resolves to no document: fall back to a plain add. */
    vanished?: boolean;
    error?: CogneeError;
  }> {
    const dataId = canonicalUuid(params.dataId);
    const datasetId = canonicalUuid(params.datasetId);
    if (!dataId || !datasetId) {
      return {
        ok: false,
        error: new CogneeError(
          `update needs UUID data_id and dataset_id (got data_id '${params.dataId}', dataset_id '${params.datasetId}')`,
        ),
      };
    }
    try {
      await this.ensureAuth();
      const form = new FormData();
      // Same Blob+basename construction as the remember file lane: the part's
      // filename is the loader-routing signal (code extensions stay code).
      form.set("data", new Blob([params.content], { type: "text/plain" }), params.filename);
      const resp = await this.rawFetch(
        `${this.cfg.baseUrl}/api/v1/update?data_id=${dataId}&dataset_id=${datasetId}`,
        {
          method: "PATCH",
          headers: this.authHeaders(),
          body: form,
          timeoutMs: params.timeoutMs ?? this.cfg.requestTimeoutMs,
          externalSignal: params.externalSignal,
        },
      );
      const text = await resp.readText();
      let data: Record<string, unknown> | undefined;
      try {
        data = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      } catch {
        data = undefined;
      }
      if (data && typeof data === "object" && data.status === "failed") {
        // "failed" rides a 200 OR a 500 body (the spec documents both) — the
        // rebuild's cognify run errored; retryable, and the document still exists.
        const errObj = data.error as { message?: unknown } | undefined;
        const message =
          errObj && typeof errObj === "object" && typeof errObj.message === "string" && errObj.message
            ? errObj.message
            : "the rebuild's cognify run errored";
        return {
          ok: false,
          error: new CogneeError(
            `update failed server-side: ${message} — retryable; the document still exists (re-run the same remember to retry)`,
          ),
        };
      }
      if (resp.status === 404) {
        return {
          ok: false,
          vanished: true,
          error: new CogneeError(`HTTP 404 PATCH /api/v1/update: ${String(text).slice(0, 200) || "data item no longer exists"}`, {
            status: 404,
          }),
        };
      }
      if (!resp.ok) {
        const detail =
          (data && typeof data === "object" ? errorStringFromUpdateBody(data) : undefined) ??
          String(text).slice(0, 300);
        return {
          ok: false,
          error: new CogneeError(`HTTP ${resp.status} PATCH /api/v1/update: ${detail}`, {
            status: resp.status,
          }),
        };
      }
      if (!data || typeof data !== "object" || typeof data.status !== "string" || !data.status) {
        // A 2xx the caller cannot parse is NOT success — the outcome is unknown,
        // and the document may already be updated (never silently re-add).
        return {
          ok: false,
          error: new CogneeError("malformed JSON response from PATCH /api/v1/update"),
        };
      }
      const status = data.status;
      const known = status === "incremental" || status === "unchanged" || status === "full_rebuild";
      return {
        ok: true,
        status,
        datasetId: typeof data.dataset_id === "string" ? data.dataset_id : datasetId,
        pipelineRunId: typeof data.pipeline_run_id === "string" ? data.pipeline_run_id : undefined,
        detail: known ? updateSummaryLine(data) : String(status),
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
   * delta). session_id is optional and, when given, attached exactly like the
   * reference auto lane does ("session_id attached on the code scope too" — the
   * server keeps the binding to the session dataset, not the code one).
   * No CLI fallback exists for this route — unreachable means "not run".
   */
  async codeSearch(params: {
    seed: string;
    codeQuery?: Record<string, unknown>;
    dataset: string;
    topK?: number;
    /** Attached on the code scope too (the reference's auto lane sends it); the
     *  server binds session ids to the session dataset, never to the code one. */
    sessionId?: string;
    timeoutMs?: number;
    externalSignal?: AbortSignal;
  }): Promise<RecallResult> {
    return this.recall({
      query: params.seed,
      sessionId: params.sessionId,
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

  /** POST /api/v1/remember/entry — writes one typed entry into the server-side
   *  session cache. The server dispatches on entry.type ("qa" | "trace").
   *  Under shared memory the resolved canonical UUID (datasetId) addresses the
   *  write instead of the name (§3.5 — a name only resolves among the CALLER's
   *  own datasets, so an agent writing by name would fork a private copy). */
  async rememberEntry(
    entry: QaEntry | TraceEntry,
    sessionId: string,
    dataset: string,
    timeoutMs?: number,
    datasetId?: string,
  ): Promise<{ ok: boolean; error?: CogneeError }> {
    const ident = datasetId ? canonicalUuid(datasetId) : "";
    const body: Record<string, unknown> = ident
      ? { entry, session_id: sessionId, dataset_id: ident }
      : { entry, session_id: sessionId, dataset_name: sanitizeDatasetName(dataset) };
    const r = await this.jsonRequest<unknown>("POST", "/api/v1/remember/entry", {
      json: body,
      timeoutMs,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /**
   * POST /api/v1/improve — promotes the server-side session cache into the permanent graph.
   * cognee 1.6.0 answers with a typed ImproveResult whose REQUIRED status enum maps to
   * outcomes: running → busy, errored → error, completed/skipped → ok. The legacy
   * pre-1.6 signals stay honored: empty-object body = per-session improve lock held
   * (busy, never retried); 404/405/422 = improve_unsupported. Body keys are
   * dual-spelled (snake_case ≤ 1.5.x, camelCase per ImprovePayloadDTO in 1.6.0).
   */
  async improve(
    sessionId: string,
    dataset: string | undefined,
    timeoutMs: number = this.cfg.improveSubmitTimeoutMs,
    externalSignal?: AbortSignal,
  ): Promise<{ outcome: ImproveOutcome; error?: CogneeError }> {
    const body: Record<string, unknown> = {
      session_ids: [sessionId],
      sessionIds: [sessionId],
      run_in_background: true,
      runInBackground: true,
    };
    if (dataset) {
      if (isUuid(dataset)) {
        body.dataset_id = dataset;
        body.datasetId = dataset;
      } else {
        const name = sanitizeDatasetName(dataset);
        body.dataset_name = name;
        body.datasetName = name;
      }
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
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const result = data as { status?: unknown; error?: unknown };
      if (result.status === "running") return { outcome: "busy" };
      if (result.status === "errored") {
        const detail = typeof result.error === "string" && result.error ? result.error : "pipeline errored";
        return { outcome: "error", error: new CogneeError(`improve errored: ${detail}`) };
      }
      if (result.status === "completed" || result.status === "skipped") return { outcome: "ok" };
      // Unknown or absent status: pre-1.6 untyped body — keep the legacy signals.
      if (Object.keys(result).length === 0) return { outcome: "busy" };
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
        created_at:
          typeof d.created_at === "string"
            ? d.created_at
            : typeof d.createdAt === "string"
              ? d.createdAt
              : undefined,
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
        // 1.6.0 renamed created_at → createdAt in DataDTO; probe both spellings.
        created_at:
          typeof d.created_at === "string"
            ? d.created_at
            : typeof d.createdAt === "string"
              ? d.createdAt
              : undefined,
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

  /** GET /api/v1/sessions/{id} — last ~20 QA/trace rows of the server-side
   *  session cache (both kinds feed the bridge's verify-before-replay
   *  fingerprints; `qas` stays first for existing callers). */
  async getSessionDetail(
    sessionId: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; qas: SessionQaRow[]; traces: SessionTraceRow[]; error?: CogneeError }> {
    const r = await this.jsonRequest<{ qas?: unknown; traces?: unknown }>(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { timeoutMs, retryOnConnect: true },
    );
    if (!r.ok) return { ok: false, qas: [], traces: [], error: r.error };
    const qas = Array.isArray(r.data?.qas)
      ? (r.data.qas as SessionQaRow[])
      : Array.isArray(r.data)
        ? (r.data as unknown as SessionQaRow[])
        : [];
    const traces = Array.isArray(r.data?.traces) ? (r.data.traces as SessionTraceRow[]) : [];
    return { ok: true, qas, traces };
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

  /* ================================================================ */
  /* Shared-agent-memory provisioning (v0.4 — spec §3.3)                */
  /* Ported field-for-field from reference _plugin_common.py: same      */
  /* routes, bodies, verdicts, log events, marker/memoization           */
  /* semantics. All control-plane calls as the PRINCIPAL; only          */
  /* tenants/select runs as the agent.                                  */
  /* ================================================================ */

  /** `_json_http_request` that reports instead of raising: 200 for any 2xx,
   *  the HTTP status otherwise, 0 when the request never got an HTTP answer. */
  private async controlPlaneRequest(
    path: string,
    opts: { method?: string; json?: unknown; key?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: unknown }> {
    const key = opts.key ?? this.principalKey() ?? "";
    try {
      const headers: Record<string, string> = key ? { "X-Api-Key": key } : {};
      let body: string | undefined;
      if (opts.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.json);
      }
      const resp = await this.rawFetch(this.cfg.baseUrl + path, {
        method: opts.method ?? "POST",
        headers,
        body,
        timeoutMs: opts.timeoutMs ?? 15_000,
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
      return resp.ok ? { status: 200, body: data } : { status: resp.status, body: data };
    } catch (err) {
      logPluginEvent({ event: "control_plane_request_failed", path, error: describeError(err).slice(0, 200) });
      return { status: 0, body: undefined };
    }
  }

  /** GET /openapi.json capability verdict, cached for 60 s (one probe per
   *  session start — §2.2). `probed: false` = unreachable/unparseable — never
   *  blocks or fails startup; callers treat it conservatively. */
  async probeCapabilities(timeoutMs: number = 5000): Promise<CapabilityVerdict> {
    const now = Date.now();
    if (this.capabilityCache && now - this.capabilityCache.at < 60_000) {
      return this.capabilityCache.verdict;
    }
    let verdict: CapabilityVerdict = { probed: false, provisioning: false, typedDatasetIds: false };
    try {
      const key = this.principalKey();
      const resp = await this.rawFetch(`${this.cfg.baseUrl}/openapi.json`, {
        method: "GET",
        headers: key ? { "X-Api-Key": key } : {},
        timeoutMs,
        retryOnConnect: true,
      });
      const text = await resp.readText();
      if (resp.ok) {
        let spec: unknown;
        try {
          spec = text ? JSON.parse(text) : undefined;
        } catch {
          spec = undefined;
        }
        const parsed = parseOpenapiCapabilities(spec);
        if (parsed) {
          verdict = { probed: true, provisioning: parsed.createOnlyProvision, typedDatasetIds: parsed.typedDatasetIds };
        }
      } else {
        // A server without an openapi document advertises neither capability
        // (the reference classifies 404/405 on openapi → provisioning unsupported).
        verdict = { probed: true, provisioning: false, typedDatasetIds: false };
      }
    } catch {
      /* unreachable → not probed */
    }
    this.capabilityCache = { at: now, verdict };
    return verdict;
  }

  /** Create this plugin's identity without rotating an existing key (§1.1).
   *  Verifies the advertised create-only contract BEFORE POSTing — older
   *  servers ignore unknown query params and rotate keys. 404/405 →
   *  "unsupported" (a capability verdict, not a fault); any other HTTP/network
   *  error → "failed"; bad response bodies → "failed" (logged
   *  plugin_provision_bad_response). Unsupported/failed fail closed in the
   *  caller — never a partial identity. */
  async provisionPluginAgent(timeoutMs: number = 20_000): Promise<ProvisionResult> {
    const principal = (this.principalKey() ?? "").trim();
    if (!principal) return { status: "failed" };
    try {
      const capabilities = await this.probeCapabilities(Math.min(timeoutMs, 10_000));
      if (!capabilities.probed) return { status: "failed" };
      if (!capabilities.provisioning) return { status: "unsupported" };
      const resp = await this.rawFetch(
        `${this.cfg.baseUrl}/api/v1/integrations/plugins/${PLUGIN_KEY}/provision?create_only=true`,
        {
          method: "POST",
          headers: { "X-Api-Key": principal, "Content-Type": "application/json" },
          body: "{}",
          timeoutMs,
        },
      );
      const text = await resp.readText();
      if (!resp.ok) {
        if (resp.status === 404 || resp.status === 405) return { status: "unsupported" };
        logPluginEvent({ event: "plugin_provision_failed", status: resp.status });
        return { status: "failed" };
      }
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      const verdict = validateProvisionResponse(data, principal);
      if (verdict.ok) {
        return { status: "provisioned", apiKey: verdict.apiKey, agentId: verdict.agentId };
      }
      logPluginEvent({ event: "plugin_provision_bad_response", reason: verdict.reason, keys: verdict.keys });
      return { status: "failed" };
    } catch {
      logPluginEvent({ event: "plugin_provision_failed", error: "network" });
      return { status: "failed" };
    }
  }

  /** DELETE /api/v1/integrations/plugins/{PLUGIN_KEY} as the principal — revoke
   *  this plugin's agent keys (the agent user + its data stay; re-provisioning
   *  later revives the same identity with a fresh key). Best-effort. */
  async disconnectPluginAgent(timeoutMs: number = 20_000): Promise<boolean> {
    const principal = (this.principalKey() ?? "").trim();
    if (!principal) return false;
    const r = await this.controlPlaneRequest(`/api/v1/integrations/plugins/${PLUGIN_KEY}`, {
      method: "DELETE",
      key: principal,
      timeoutMs,
    });
    if (r.status !== 200) logPluginEvent({ event: "plugin_disconnect_failed", status: r.status });
    return r.status === 200;
  }

  /** `{id, tenant_id}` for the key's user, or `{id: ""}` (absent /users/me is
   *  tolerated by the caller — §1.3 step 3). */
  private async usersMe(key: string | undefined, timeoutMs = 10_000): Promise<{ id: string; tenant_id: string }> {
    const r = await this.controlPlaneRequest("/api/v1/users/me", {
      method: "GET",
      key,
      timeoutMs,
    });
    if (r.status !== 200 || !r.body || typeof r.body !== "object" || Array.isArray(r.body)) {
      return { id: "", tenant_id: "" };
    }
    const body = r.body as Record<string, unknown>;
    return { id: rowStr(body, "id"), tenant_id: rowStr(body, "tenant_id", "tenantId") };
  }

  /** Does this server expose the permissions API? Probed on the one endpoint
   *  that cannot 404 for any other reason (a missing tenant 404s elsewhere). */
  private async permissionsSupported(principal: string, timeoutMs = 10_000): Promise<boolean> {
    const r = await this.controlPlaneRequest("/api/v1/permissions/tenants/me", {
      method: "GET",
      key: principal,
      timeoutMs,
    });
    return r.status !== 404 && r.status !== 405;
  }

  /** Every dataset the key can READ, as the wiring code sees it (§1.3 step 4). */
  private async listDatasetsAs(key: string | undefined, timeoutMs = 15_000): Promise<DatasetRow[]> {
    const r = await this.controlPlaneRequest("/api/v1/datasets", {
      method: "GET",
      key,
      timeoutMs,
    });
    if (r.status !== 200 || !Array.isArray(r.body)) return [];
    const rows: DatasetRow[] = [];
    for (const item of r.body) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      const id = rowStr(d, "id");
      const name = rowStr(d, "name");
      if (id && name) {
        rows.push({
          id,
          name,
          owner_id: rowStr(d, "owner_id", "ownerId"),
          created_at: rowStr(d, "created_at", "createdAt"),
        });
      }
    }
    return rows;
  }

  /** POST /api/v1/datasets/ as the given key — the (new or existing) row. The
   *  trailing slash is reference parity (servers disagree about this route). */
  private async createDatasetAs(key: string, name: string, timeoutMs = 30_000): Promise<{ id: string; name: string }> {
    const r = await this.controlPlaneRequest("/api/v1/datasets/", {
      json: { name },
      key,
      timeoutMs,
    });
    if (r.status !== 200 || !r.body || typeof r.body !== "object" || Array.isArray(r.body)) {
      return { id: "", name };
    }
    const body = r.body as Record<string, unknown>;
    const id = rowStr(body, "id");
    return id ? { id, name: rowStr(body, "name") || name } : { id: "", name };
  }

  /** Resolve the tenant the shared role lives in: (tenantId, reason). A
   *  tenant-less parent gets one created — but only when it can read ZERO
   *  datasets (activating a tenant re-scopes visibility and would hide
   *  no-tenant data → `tenantless_with_data`). */
  private async ensureTenant(
    principal: string,
    parent: { id: string; tenant_id: string },
    datasets: DatasetRow[],
    timeoutMs = 15_000,
  ): Promise<{ tenantId: string; reason: string }> {
    if (parent.tenant_id) return { tenantId: parent.tenant_id, reason: "" };
    const parentId = parent.id;
    if (datasets.length > 0) return { tenantId: "", reason: "tenantless_with_data" };
    const tenantName = `cognee-${parentId.slice(0, 8)}`;
    const r = await this.controlPlaneRequest(
      `/api/v1/permissions/tenants?tenant_name=${encodeURIComponent(tenantName)}`,
      { key: principal, timeoutMs },
    );
    if (r.status !== 200 || !r.body || typeof r.body !== "object" || Array.isArray(r.body)) {
      logPluginEvent({ event: "shared_memory_tenant_create_failed", status: r.status });
      return { tenantId: "", reason: "tenant_create_failed" };
    }
    return { tenantId: rowStr(r.body as Record<string, unknown>, "tenant_id", "tenantId"), reason: "" };
  }

  /** Get-or-create AGENT_ROLE_NAME in the tenant: (roleId, reason). */
  private async ensureRole(
    principal: string,
    tenantId: string,
    timeoutMs = 15_000,
  ): Promise<{ roleId: string; reason: string }> {
    const find = async (): Promise<string> => {
      const r = await this.controlPlaneRequest(
        `/api/v1/permissions/tenants/${encodeURIComponent(tenantId)}/roles`,
        { method: "GET", key: principal, timeoutMs: Math.min(timeoutMs, 10_000) },
      );
      if (r.status === 200 && Array.isArray(r.body)) {
        for (const row of r.body) {
          if (row && typeof row === "object" && rowStr(row as Record<string, unknown>, "name") === AGENT_ROLE_NAME) {
            return rowStr(row as Record<string, unknown>, "id");
          }
        }
      }
      return "";
    };
    const existing = await find();
    if (existing) return { roleId: existing, reason: "" };
    const r = await this.controlPlaneRequest(
      `/api/v1/permissions/roles?role_name=${encodeURIComponent(AGENT_ROLE_NAME)}`,
      { key: principal, timeoutMs },
    );
    if (r.status === 200 && r.body && typeof r.body === "object" && !Array.isArray(r.body)) {
      const roleId = rowStr(r.body as Record<string, unknown>, "role_id", "roleId");
      if (roleId) return { roleId, reason: "" };
    }
    if (r.status === 409) return { roleId: await find(), reason: "" };
    if (r.status === 401 || r.status === 403) {
      // Only the tenant owner may create roles — stay separated rather than fail.
      return { roleId: "", reason: "not_tenant_owner" };
    }
    logPluginEvent({ event: "shared_memory_role_create_failed", status: r.status });
    return { roleId: "", reason: "role_create_failed" };
  }

  /** Membership wiring for one agent; a failure reason or "" (§1.3 step 7). */
  private async addAgentToTenantAndRole(
    principal: string,
    agentKey: string,
    agentId: string,
    tenantId: string,
    roleId: string,
    timeoutMs = 15_000,
  ): Promise<string> {
    const accepted = (status: number): boolean => status === 200 || status === 409;
    let r = await this.controlPlaneRequest(
      `/api/v1/permissions/users/${encodeURIComponent(agentId)}/tenants?tenant_id=${encodeURIComponent(tenantId)}`,
      { key: principal, timeoutMs },
    );
    if (!accepted(r.status)) {
      return r.status === 401 || r.status === 403 ? "not_tenant_owner" : "tenant_membership_failed";
    }
    // The agent selects the tenant ITSELF (as the agent): membership alone
    // doesn't set its active tenant, and the dataset-visibility filter compares
    // against that — without it every grant that follows is invisible to the agent.
    r = await this.controlPlaneRequest("/api/v1/permissions/tenants/select", {
      json: { tenant_id: tenantId },
      key: agentKey,
      timeoutMs,
    });
    if (r.status !== 200) {
      logPluginEvent({ event: "shared_memory_agent_select_tenant_failed", status: r.status });
      return "agent_tenant_select_failed";
    }
    r = await this.controlPlaneRequest(
      `/api/v1/permissions/users/${encodeURIComponent(agentId)}/roles?role_id=${encodeURIComponent(roleId)}`,
      { key: principal, timeoutMs },
    );
    if (!accepted(r.status)) {
      return r.status === 401 || r.status === 403 ? "not_tenant_owner" : "role_membership_failed";
    }
    return "";
  }

  /** Take the agent out of the shared role (opt-out). True when it is no longer
   *  a member — including when it already wasn't (404). Runs as the principal. */
  private async removeAgentFromRole(
    principal: string | undefined,
    agentId: string,
    roleId: string,
    timeoutMs = 15_000,
  ): Promise<boolean> {
    if (!(principal && agentId && roleId)) return false;
    const r = await this.controlPlaneRequest(
      `/api/v1/permissions/users/${encodeURIComponent(agentId)}/roles?role_id=${encodeURIComponent(roleId)}`,
      { method: "DELETE", key: principal, timeoutMs },
    );
    if (r.status !== 200 && r.status !== 404) {
      logPluginEvent({ event: "shared_memory_leave_role_failed", status: r.status });
      return false;
    }
    return true;
  }

  /** Give the role read+write on each dataset (one call per dataset, so a single
   *  unshareable one cannot fail the batch). Outcomes memoized in
   *  marker.granted: "ok" never retried; {denied_at} retried after the hourly
   *  window (logged once per dataset); anything else transient → retried next
   *  time. Returns the ids the role holds read+write on. */
  private async grantRoleOnDatasets(
    principal: string,
    roleId: string,
    datasetIds: string[],
    marker: SharedMemoryMarker,
    timeoutMs = 15_000,
  ): Promise<Set<string>> {
    if (!marker.granted || typeof marker.granted !== "object") marker.granted = {};
    const granted = marker.granted;
    const now = Date.now() / 1000; // epoch seconds, reference parity (denied_at)
    for (const datasetId of datasetIds) {
      if (!datasetId) continue;
      const prior = granted[datasetId];
      if (prior === "ok") continue;
      if (
        prior && typeof prior === "object" &&
        now - Number(prior.denied_at || 0) < GRANT_DENIED_RETRY_SECONDS
      ) {
        continue;
      }
      let outcome: "ok" | { denied_at: number } | null = "ok";
      for (const permission of ["read", "write"] as const) {
        const r = await this.controlPlaneRequest(
          `/api/v1/permissions/datasets/${encodeURIComponent(roleId)}?permission_name=${permission}`,
          { json: [datasetId], key: principal, timeoutMs },
        );
        if (r.status === 401 || r.status === 403) {
          outcome = { denied_at: now };
          if (!(prior && typeof prior === "object")) {
            // Typically a dataset shared to the user read-only by someone else:
            // said once per dataset, not once per hour.
            logPluginEvent({ event: "shared_memory_grant_denied", dataset_id: datasetId, permission, status: r.status });
          }
          break;
        }
        if (r.status !== 200) {
          outcome = null; // transient: retry next time
          break;
        }
      }
      if (outcome === null) {
        delete granted[datasetId];
        continue;
      }
      granted[datasetId] = outcome;
    }
    return new Set(Object.entries(granted).filter(([, v]) => v === "ok").map(([k]) => k));
  }

  /** Wire (or refresh) shared agent memory (§1.3). Returns the outcome every
   *  caller consumes; every step degrades to `separated/<reason>` — nothing
   *  here can fail a session. `allowSetup: false` (the refresh/switch path)
   *  only re-resolves the canonical dataset and backfills grants against
   *  wiring a session start already completed — never creates tenants/roles. */
  async ensureSharedMemory(
    opts: { dataset?: string; allowSetup?: boolean; agentKey?: string; agentId?: string; timeoutMs?: number } = {},
  ): Promise<SharedMemoryOutcome> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    try {
      await this.ensureAuth();
      const principal = this.principalKey();
      const agentKey = opts.agentKey ?? this.agentKey ?? "";
      const agentId = opts.agentId ?? this.agentId ?? "";
      const baseUrl = this.cfg.baseUrl;

      if (!this.cfg.sharedAgentMemory) {
        // Opting out is a real boundary: the agent LEAVES the shared role. The
        // marker is demoted (nothing keeps treating the wiring as active) but
        // the tenant/role/parent ids are kept — re-enabling rejoins the same
        // role. Runs as the principal; retried on the next session start.
        const marker = loadSharedMemoryMarker(baseUrl);
        if (marker.mode === "shared") {
          const removed = await this.removeAgentFromRole(
            principal,
            String(marker.agent_id || agentId),
            String(marker.role_id || ""),
            timeoutMs,
          );
          if (removed) {
            saveSharedMemoryMarker({ ...marker, mode: "separated", reason: "opt_out", role_member: false });
          }
          logPluginEvent({ event: "shared_memory_opted_out", role_id: marker.role_id, left_role: removed });
        }
        return separatedOutcome("opt_out");
      }
      if (!(principal && agentKey && agentId)) return separatedOutcome("no_agent_identity");

      let marker = loadSharedMemoryMarker(baseUrl);
      const wired =
        marker.mode === "shared" &&
        marker.agent_id === agentId &&
        Boolean(marker.role_id) &&
        Boolean(marker.parent_user_id);
      if (!wired && !opts.allowSetup) return separatedOutcome(String(marker.reason || "not_wired"));

      let datasets: DatasetRow[] | undefined;
      if (!wired) {
        if (!(await this.permissionsSupported(principal, timeoutMs))) {
          saveSharedMemoryMarker({ base_url: baseUrl, mode: "separated", reason: "unsupported" });
          logPluginEvent({ event: "shared_memory_skipped", reason: "unsupported" });
          return separatedOutcome("unsupported");
        }
        const capabilities = await this.probeCapabilities(Math.min(timeoutMs, 10_000));
        if (!(capabilities.probed && capabilities.typedDatasetIds)) {
          saveSharedMemoryMarker({ base_url: baseUrl, mode: "separated", reason: "typed_dataset_unsupported" });
          logPluginEvent({ event: "shared_memory_skipped", reason: "typed_dataset_unsupported" });
          return separatedOutcome("typed_dataset_unsupported");
        }
        const parent = await this.usersMe(principal, timeoutMs);
        if (!parent.id) return separatedOutcome("principal_unresolved");
        datasets = await this.listDatasetsAs(principal, timeoutMs);
        const tenant = await this.ensureTenant(principal, parent, datasets, timeoutMs);
        let roleId = "";
        let reason = tenant.reason;
        if (!reason) {
          const role = await this.ensureRole(principal, tenant.tenantId, timeoutMs);
          roleId = role.roleId;
          reason = role.reason;
        }
        if (!reason) {
          reason = await this.addAgentToTenantAndRole(principal, agentKey, agentId, tenant.tenantId, roleId, timeoutMs);
        }
        if (reason) {
          saveSharedMemoryMarker({ base_url: baseUrl, mode: "separated", reason });
          logPluginEvent({ event: "shared_memory_skipped", reason });
          return separatedOutcome(reason);
        }
        marker = {
          base_url: baseUrl,
          mode: "shared",
          reason: "",
          tenant_id: tenant.tenantId,
          role_id: roleId,
          parent_user_id: parent.id,
          agent_id: agentId,
          granted: {},
          canonical: {},
        };
        logPluginEvent({ event: "shared_memory_wired", tenant_id: tenant.tenantId, role_id: roleId, agent_id: agentId });
      }

      const parentId = String(marker.parent_user_id || "");
      const roleId = String(marker.role_id || "");
      if (datasets === undefined) datasets = await this.listDatasetsAs(principal, timeoutMs);

      // Backfill: the role gets read+write on everything the parent can share.
      // Datasets a sibling agent creates are auto-shared to the parent, so this
      // is also how they reach every other agent — no per-plugin coordination.
      const roleHolds = await this.grantRoleOnDatasets(
        principal,
        roleId,
        datasets.map((row) => row.id),
        marker,
        timeoutMs,
      );

      // The launch's dataset: a canonical copy every agent writes to, plus other
      // same-named copies for recall. Only datasets the role actually holds (or
      // the parent owns) qualify — a read-only-shared same-named dataset is
      // neither the write target nor part of the recall set. With no eligible
      // copy the parent creates its own (creating as the agent would fork an
      // agent-owned copy nobody sees).
      let writeId = "";
      let readIds: string[] = [];
      const dataset = (opts.dataset ?? "").trim();
      if (dataset) {
        let sameName = datasets.filter((row) => row.name === dataset);
        let eligible = sameName.filter((row) => row.owner_id === parentId || roleHolds.has(row.id));
        if (eligible.length === 0) {
          const created = await this.createDatasetAs(principal, dataset, timeoutMs);
          if (!created.id) {
            // The wiring itself is fine (the marker keeps its grants), but this
            // launch has no canonical UUID to address — report that rather than
            // "shared" with an empty dataset_id (name addressing would quietly
            // write to an agent-owned copy nobody else can see).
            saveSharedMemoryMarker(marker);
            logPluginEvent({ event: "shared_memory_skipped", reason: "dataset_create_failed", dataset });
            return separatedOutcome("dataset_create_failed");
          }
          const row: DatasetRow = { id: created.id, name: created.name || dataset, owner_id: parentId, created_at: "" };
          sameName = [...sameName, row];
          datasets.push(row);
          for (const id of await this.grantRoleOnDatasets(principal, roleId, [row.id], marker, timeoutMs)) {
            roleHolds.add(id);
          }
          eligible = [row];
        }
        if (eligible.length > 0) {
          writeId = pickCanonical(eligible, parentId).id;
          if (!marker.canonical || typeof marker.canonical !== "object") marker.canonical = {};
          marker.canonical[dataset] = writeId;
          readIds = [
            writeId,
            ...sameName
              .filter(
                (row) => row.id !== writeId && (roleHolds.has(row.id) || row.owner_id === agentId),
              )
              .map((row) => row.id),
          ];
        }
      }
      saveSharedMemoryMarker(marker);
      return { mode: "shared", reason: "", dataset_id: writeId, dataset_ids: readIds, role_id: roleId };
    } catch {
      return separatedOutcome("wiring_failed"); // fail-soft — retried at the next session start
    }
  }

  /** `ensureSharedMemory` for an already-wired agent, from any caller (§1.3):
   *  resolves the keys itself, so the dataset switch can re-resolve a dataset's
   *  canonical UUIDs and backfill grants without the session-start context. */
  async resolveSharedDataset(dataset: string, timeoutMs: number = 15_000): Promise<SharedMemoryOutcome> {
    if (!this.cfg.sharedAgentMemory) return separatedOutcome("opt_out");
    await this.ensureAuth().catch(() => {});
    const principal = this.principalKey();
    const agentKey = this.agentKey;
    const agentId = this.agentId;
    if (!(principal && agentKey && agentId)) {
      return separatedOutcome(!agentKey ? "no_agent_identity" : "no_principal_key");
    }
    return this.ensureSharedMemory({ dataset, allowSetup: false, timeoutMs });
  }

  /** Use effective permissions to classify the readable set (§1.5):
   *  GET /permissions/principals/{user}/datasets?permission_name=write lists
   *  DIRECT write grants — a role-held grant does not appear there, so under a
   *  live shared-memory marker the parent's datasets count as writable only
   *  once the grant memo says "ok" (via_role). Without the route (404/405)
   *  `filtered` is false and writability degrades to the owner match (null =
   *  unverifiable). Throws on transport/other HTTP failure — callers fall back
   *  to the every-readable heuristic. */
  async listWritableDatasets(timeoutMs: number = 15_000): Promise<WritableDatasetsListing> {
    await this.ensureAuth();
    const listed = await this.listDatasets(timeoutMs);
    if (!listed.ok) throw listed.error ?? new CogneeError("cannot list datasets");
    const me = await this.usersMe(this.effectiveKey(), timeoutMs);
    const userId = me.id;
    let writableIds: Set<string> | null = null;
    if (userId) {
      const r = await this.controlPlaneRequest(
        `/api/v1/permissions/principals/${encodeURIComponent(userId)}/datasets?permission_name=write`,
        { method: "GET", key: this.effectiveKey(), timeoutMs },
      );
      if (r.status === 200 && Array.isArray(r.body)) {
        writableIds = new Set(
          r.body
            .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
            .map((row) => rowStr(row, "id"))
            .filter(Boolean),
        );
      } else if (r.status !== 404 && r.status !== 405) {
        throw new CogneeError(`HTTP ${r.status} GET /permissions/principals/.../datasets`, {
          status: r.status,
        });
      }
    }
    const shared = loadSharedMemoryMarker(this.cfg.baseUrl);
    let sharedParent = "";
    let roleGranted: Record<string, unknown> = {};
    if (this.cfg.sharedAgentMemory && shared.mode === "shared") {
      sharedParent = String(shared.parent_user_id || "");
      roleGranted = (shared.granted ?? {}) as Record<string, unknown>;
    }
    const rows = listed.datasets.map((item) => {
      const owner = item.owner_id ?? item.ownerId ?? "";
      const ident = item.id;
      // Writable through the shared role only once the grant is confirmed — a
      // transient failure leaves a parent-owned dataset ungranted until the
      // next refresh; it must not be offered as writable meanwhile.
      const viaRole = Boolean(sharedParent) && owner === sharedParent && roleGranted[ident] === "ok";
      let writable: boolean | null;
      if (writableIds !== null) writable = writableIds.has(ident) || viaRole;
      else writable = owner && (owner === userId || viaRole) ? true : null;
      return { name: item.name, id: ident, owner_id: owner, writable };
    });
    return {
      datasets: rows.filter((row) => row.writable !== false),
      readonly: rows.filter((row) => row.writable === false).map((row) => row.name),
      readonly_ids: rows.filter((row) => row.writable === false).map((row) => row.id),
      hidden_readonly: rows.filter((row) => row.writable === false).length,
      filtered: writableIds !== null,
    };
  }
}
