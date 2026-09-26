import type { TraceEntry } from "../client/types";
import { DENY_PATHS, PATH_KEYS } from "../constants";
import type { CapturePolicy, RedactOptions, ToolResultLike } from "./types";

/* ------------------------------------------------------------------ */
/* Tool-call trace capture (v0.4 — research/v04-traces-spec.md)        */
/* Port of the reference _capture_policy.py: fnmatch-style allowlist,  */
/* sensitive-path deny list (entry-level refusal, never partial        */
/* redaction), recursive redaction with the secret-key rule + custom   */
/* regex patterns, and TraceEntry construction with the reference      */
/* caps (4000/8000/500 bytes).                                         */
/* ------------------------------------------------------------------ */

/** Reference caps (_MAX_PARAMS_BYTES / _MAX_RETURN_BYTES / error 500). */
export const TRACE_MAX_PARAM_BYTES = 4000;
export const TRACE_MAX_RETURN_BYTES = 8000;
export const TRACE_MAX_ERROR_BYTES = 500;

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

/** Reference `_sensitive_path`: the basename OR the `/`-prefixed normalized
 *  full path fnmatches any deny pattern (compiled-in + COGNEE_CAPTURE_DENY_PATHS
 *  extras); normalization = backslashes→`/` + lowercase. */
export function sensitivePathValue(
	value: unknown,
	extraDeny: readonly string[] = [],
): boolean {
	if (Array.isArray(value))
		return value.some((item) => sensitivePathValue(item, extraDeny));
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
export function hasSensitivePath(
	value: unknown,
	extraDeny: readonly string[] = [],
): boolean {
	if (Array.isArray(value))
		return value.some((item) => hasSensitivePath(item, extraDeny));
	if (value && typeof value === "object") {
		return Object.entries(value).some(
			([key, item]) =>
				(PATH_KEYS.has(key.toLowerCase()) &&
					sensitivePathValue(item, extraDeny)) ||
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

/** Reference `_SECRET_KEY` — dict keys whose values are replaced wholesale. */
const SECRET_KEY_RE =
  /^(?:authorization|x-api-key|(?:.*[_-])?(?:secret|token|password|passwd|api[_-]?key))$/i;

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

/** Reference `_store_tool_call` steps minus queueing: allowlist + deny-list
 *  refusal (→ undefined — the entry is dropped whole, never partially
 *  redacted), redact input and output BEFORE truncation, then build the
 *  TraceEntry with the reference caps. */
export function buildTraceEntry(
	event: ToolResultLike,
	policy: CapturePolicy,
): TraceEntry | undefined {
	if (!allowToolCall(event.toolName, event.input, policy)) return undefined;
	const redactOpts = {
		redact: policy.redact,
		customPatterns: policy.redactPatterns,
	};
	const redactedInput = redactForCapture(event.input ?? {}, redactOpts);
	const paramsSource =
		redactedInput &&
		typeof redactedInput === "object" &&
		!Array.isArray(redactedInput)
			? (redactedInput as Record<string, unknown>)
			: { value: redactedInput };
	const method_params: Record<string, string> = {};
	for (const [key, value] of Object.entries(paramsSource)) {
		method_params[key] = truncateText(
			typeof value === "string" ? value : safeJson(value),
			TRACE_MAX_PARAM_BYTES,
		);
	}
	const redactedText = redactForCapture(
		extractText(event.content),
		redactOpts,
	);
	const text =
		typeof redactedText === "string"
			? redactedText
			: safeJson(redactedText);
	const status: "success" | "error" = event.isError ? "error" : "success";
	return {
		type: "trace",
		origin_function: event.toolName,
		status,
		method_params,
		method_return_value: truncateText(text, TRACE_MAX_RETURN_BYTES),
		error_message:
			status === "error" ? truncateText(text, TRACE_MAX_ERROR_BYTES) : "",
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
	const buf = Buffer.from(safe, "utf8").subarray(
		0,
		Math.max(0, maxBytes - 3),
	);
	let end = buf.length;
	// The input is valid utf-8 by construction, so a cut sequence can only sit at
	// the very end. Drop it (errors="ignore") whether the slice kept none of its
	// continuation bytes (trailing lead byte) or some of them.
	if (end > 0 && (buf[end - 1] & 0x80) !== 0) {
		const expected =
			buf[end - 1] >= 0xf0
				? 4
				: buf[end - 1] >= 0xe0
					? 3
					: buf[end - 1] >= 0xc0
						? 2
						: 0;
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
