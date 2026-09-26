import { CODE_EXTENSIONS } from "../constants";
import { sha256Hex } from "./hash";
import { canonicalRepoSpec, readableTail } from "./git";

/* ------------------------------------------------------------------ */
/* Code graph (enola) — naming, git fingerprints, state, identifiers   */
/* Mirrors the official plugins' scripts/_code_graph.py field-for-field. */
/* ------------------------------------------------------------------ */

/** CamelCase words that are prose/product names, not symbols worth a code-graph seed. */
const CAMEL_STOPLIST: ReadonlySet<string> = new Set([
	"Claude",
	"ClaudeCode",
	"Codex",
	"Cognee",
	"GitHub",
	"GitLab",
	"JavaScript",
	"TypeScript",
	"PostgreSQL",
	"MongoDB",
	"OpenAI",
	"MacOS",
	"ReadMe",
	"WiFi",
	"OAuth",
	"TODOs",
]);

const BACKTICK_RE = /`([^`\n]{2,120})`/g;
const FILEPATH_RE = new RegExp(
	`\\b[\\w./-]{1,120}\\.(?:${[...CODE_EXTENSIONS].sort().join("|")})\\b`,
	"g",
);
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
		const token = rawToken
			.trim()
			.replace(/^[.,:;()\[\]{}]+|[.,:;()\[\]{}]+$/g, "");
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
				if (token.length < 5 || !parts.some((p) => p.length >= 3))
					continue;
				if (
					parts.length === 2 &&
					["com", "org", "net", "io", "ai", "dev"].includes(
						parts[1].toLowerCase(),
					)
				)
					continue;
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
export function buildCodeQuery(
	identifier: string,
	limit = 5,
): Record<string, unknown> {
	return { operation: "query_facts", name: identifier, limit };
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
