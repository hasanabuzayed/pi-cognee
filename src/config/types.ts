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
	apiKeySource:
		| "shell env"
		| "env file"
		| "cached owner key (~/.cognee-plugin/api_key.json)"
		| "not set";
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