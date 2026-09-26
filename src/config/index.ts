import { loadCachedApiKey } from "../client/cashed_api_key";
import { CLOUD_ALIASES, DEFAULT_CAPTURE_TOOLS, LOCAL_ALIASES } from "../constants";
import { datasetKeyFingerprint, sanitizeDatasetName } from "../helpers";
import { parsePluginIdentityMode, parseSharedAgentMemory } from "../provisioning";
import { loadActiveDatasetRecord } from "./active_dataset_record";
import {
    autoindexMode,
    bool,
	type EnvLookup,
	loadCogneeEnvFile,
	num,
	parseListEnv,
	parseReadDatasetIds,
} from "./env_file";
import type { CogneeConfig } from "./types";

export function loadCogneeConfig(): CogneeConfig {
	const envFile = loadCogneeEnvFile();
	// Precedence: shell exports > ~/.cognee/.env (setdefault semantics, per the claude brief).
	const effective: EnvLookup = (key: string) =>
		process.env[key] ?? envFile.values[key];

	const backendRaw = (
		effective("COGNEE_PI_BACKEND") ||
		effective("COGNEE_BACKEND") ||
		""
	)
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
			Object.keys(process.env).filter((k) =>
				/^(COGNEE_|LLM_|DEFAULT_USER_)/.test(k),
			),
		),
	].sort();

	// Federated read set (COGNEE_PLUGIN_READ_DATASET_IDS): shell > env file, same
	// precedence as every other key. Malformed values surface the exact reference
	// error at load (config warning) and disable federation — never a crash.
	const readDatasetParsed = parseReadDatasetIds(
		effective("COGNEE_PLUGIN_READ_DATASET_IDS"),
	);
	const readDatasetIdsSource: "shell env" | "env file" =
		process.env.COGNEE_PLUGIN_READ_DATASET_IDS !== undefined
			? "shell env"
			: "env file";

	// Tool-call trace capture knobs (v0.4). Malformed values surface as *Error
	// fields (shown by /cognee-doctor) and fall back to safe defaults — never
	// fatal. Separators mirror the reference: `|` tools, `,` deny paths,
	// newline redact patterns (commas stay valid regex syntax).
	const captureToolsParsed = parseListEnv(effective("COGNEE_CAPTURE_TOOLS"), {
		separator: "|",
		label: "COGNEE_CAPTURE_TOOLS",
	});
	const captureDenyParsed = parseListEnv(
		effective("COGNEE_CAPTURE_DENY_PATHS"),
		{
			separator: ",",
			label: "COGNEE_CAPTURE_DENY_PATHS",
		},
	);
	const captureRedactParsed = parseListEnv(
		effective("COGNEE_CAPTURE_REDACT_PATTERNS"),
		{
			separator: "\n",
			label: "COGNEE_CAPTURE_REDACT_PATTERNS",
		},
	);
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
	const activeRecord = loadActiveDatasetRecord(
		baseUrl,
		datasetKeyFingerprint(baseUrl, apiKey),
	);
	const datasetSeed = effective("COGNEE_PLUGIN_DATASET");
	const dataset = activeRecord
		? sanitizeDatasetName(activeRecord.dataset)
		: sanitizeDatasetName(datasetSeed || "agent_sessions");

	// Shared-agent-memory identity policy (v0.4): tri-state identity + default-on
	// sharing, parsed exactly as the reference (§1.2). A malformed identity value
	// surfaces the exact reference error at load (config warning) and behaves as
	// auto — never a crash.
	const identityParsed = parsePluginIdentityMode(
		effective("COGNEE_PLUGIN_IDENTITY"),
	);

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
		readDatasetIdsSource: readDatasetParsed.datasetIds
			? readDatasetIdsSource
			: undefined,
		readDatasetIdsError: readDatasetParsed.error,
		sessionIdOverride: effective("COGNEE_SESSION_ID") || undefined,
		sessionPrefix: effective("COGNEE_SESSION_PREFIX") || "pi",
		capture: bool(effective, "COGNEE_CAPTURE", true),
		captureTools:
			captureToolsParsed.error || captureToolsParsed.values.length === 0
				? [...DEFAULT_CAPTURE_TOOLS]
				: captureToolsParsed.values,
		captureToolsError: captureToolsParsed.error,
		captureDenyPaths: captureDenyParsed.error
			? []
			: captureDenyParsed.values,
		captureDenyPathsError: captureDenyParsed.error,
		captureRedact: bool(effective, "COGNEE_CAPTURE_REDACT", true),
		captureRedactPatterns: captureRedactParsed.error
			? []
			: captureRedactPatterns,
		captureRedactPatternsError: captureRedactParsed.error,
		captureRedactPatternsSkipped: captureRedactPatternsSkipped.length
			? captureRedactPatternsSkipped
			: undefined,
		contextMaxChars: num(effective, "COGNEE_CONTEXT_MAX_CHARS", 2000),
		recallTimeoutMs: num(effective, "COGNEE_RECALL_TIMEOUT_MS", 4000),
		requestTimeoutMs: num(effective, "COGNEE_REQUEST_TIMEOUT_MS", 10000),
		healthTimeoutMs: num(effective, "COGNEE_HEALTH_TIMEOUT_MS", 2500),
		improveSubmitTimeoutMs: num(
			effective,
			"COGNEE_IMPROVE_SUBMIT_TIMEOUT_MS",
			60000,
		),
		improveCooldownMs: num(
			effective,
			"COGNEE_IMPROVE_COOLDOWN_MS",
			1800000,
		),
		autoImproveEvery: num(effective, "COGNEE_AUTO_IMPROVE_EVERY", 150),
		idleThresholdMs: num(effective, "COGNEE_IDLE_THRESHOLD_MS", 60000),
		idleImprove: bool(effective, "COGNEE_IDLE_IMPROVE", true),
		drainBudgetMs: num(effective, "COGNEE_DRAIN_BUDGET_MS", 20000),
		rememberWaitMs:
			num(effective, "COGNEE_REMEMBER_WAIT_SECONDS", 8) * 1000,
		rememberBackground: bool(effective, "COGNEE_REMEMBER_BACKGROUND", true),
		finalSync: bool(effective, "COGNEE_FINAL_SYNC", true),
		bufferLimit: num(effective, "COGNEE_BUFFER_LIMIT", 100),
		breakerThreshold: num(effective, "COGNEE_BREAKER_THRESHOLD", 5),
		breakerWindowMs: num(effective, "COGNEE_BREAKER_WINDOW_MS", 300000),
		breakerCooldownMs: num(effective, "COGNEE_BREAKER_COOLDOWN_MS", 120000),
		codeAutoindex: autoindexMode(effective),
		codeIndexTimeoutMs: num(
			effective,
			"COGNEE_CODE_INDEX_TIMEOUT_MS",
			120000,
		),
		llmApiKeyConfigured: Boolean(effective("LLM_API_KEY")),
		llmModel: effective("LLM_MODEL"),
		localBootstrap: bool(effective, "COGNEE_LOCAL_BOOTSTRAP", true),
		serverBootDeadlineS: num(effective, "COGNEE_SERVER_BOOT_DEADLINE", 600),
		installTimeoutS: num(effective, "COGNEE_INSTALL_TIMEOUT", 600),
		pythonPin:
			(effective("COGNEE_PLUGIN_PYTHON") || "3.12").trim() || "3.12",
		presenceReprobeDelayS: num(
			effective,
			"COGNEE_PRESENCE_REPROBE_DELAY",
			3,
		),
		pluginLogMaxBytes: num(
			effective,
			"COGNEE_PLUGIN_LOG_MAX_BYTES",
			20 * 1024 * 1024,
		),
		pluginIdentity: identityParsed.mode,
		pluginIdentityError: identityParsed.error,
		sharedAgentMemory: parseSharedAgentMemory(
			effective("COGNEE_SHARED_AGENT_MEMORY"),
		),
		sharedDatasetId: activeRecord?.dataset_id || undefined,
		sharedDatasetIds: activeRecord?.dataset_ids?.length
			? activeRecord.dataset_ids
			: undefined,
	};
}
