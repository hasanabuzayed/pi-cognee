/* ------------------------------------------------------------------ */
/* Health Check                                                       */
/* ------------------------------------------------------------------ */
/** Liveness probe result. Discriminated union: reachable ⇒ HTTP status always
 *  present and error impossible; unreachable ⇒ error always present. */
export type HealthResult =
	| { reachable: true; latencyMs: number; status: number; version?: string }
	| { reachable: false; latencyMs: number; status?: number; error: string };

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

export interface RedactOptions {
  /** COGNEE_CAPTURE_REDACT=false disables all trace redaction (default true). */
  redact?: boolean;
  /** COGNEE_CAPTURE_REDACT_PATTERNS — each replaces matches with [redacted:custom]. */
  customPatterns?: readonly string[];
}