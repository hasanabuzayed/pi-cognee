import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CODE_EXTENSIONS } from "../constants";
import { sha256Hex } from "./hash";
import { CodeRepoState } from "./types";

const execFileAsync = promisify(execFile);

const SOURCE_FILE_SKIP_DIRS: ReadonlySet<string> = new Set([
	".git",
	"node_modules",
	".venv",
	"venv",
	"dist",
	"build",
	"target",
	"__pycache__",
]);

/* ----- git helpers (guarded, timeout-bounded; "" on any failure) ----- */
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

// enola writes its snapshot INTO the indexed repository (<repo>/.enola/) and
// rotates files there on every run — excluded at the git level so the
// indexer's own output can never change the fingerprint (and thus force a
// re-index loop). Belt and braces: untracked .enola lines are skipped too.
const ENOLA_DIR = ".enola";
const FINGERPRINT_PATHSPEC = ["--", ".", `:(exclude)${ENOLA_DIR}`] as const;

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
		if (canonical.endsWith(".git"))
			canonical = canonical.slice(0, -".git".length);
		return canonical;
	}
	try {
		return realpathSync(trimmed);
	} catch {
		return trimmed; // server rejects invalid paths; the client never crashes on one
	}
}

export function readableTail(canonical: string): string {
	const tail = canonical.replace(/\/+$/, "").split("/").pop() || "repo";
	return (
		tail.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") ||
		"repo"
	);
}

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
	const porcelain = await runGit(
		["status", "--porcelain", ...FINGERPRINT_PATHSPEC],
		root,
	);
	const diff = await runGit(["diff", "HEAD", ...FINGERPRINT_PATHSPEC], root);
	const digest = createHash("sha256");
	digest.update(head, "utf8");
	digest.update(porcelain, "utf8");
	digest.update(diff, "utf8");
	for (const line of porcelain.split("\n")) {
		if (!line.startsWith("??")) continue;
		const rel = line.slice(3).trim().replace(/^"|"$/g, "");
		if (
			rel.replace(/\/+$/, "") === ENOLA_DIR ||
			rel.startsWith(`${ENOLA_DIR}/`)
		)
			continue;
		try {
			const st = statSync(join(root, rel), { bigint: true });
			digest.update(`${rel}:${st.size}:${st.mtimeNs}`, "utf8");
		} catch {
			digest.update(`${rel}:gone`, "utf8");
		}
	}
	return digest.digest("hex");
}

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
				if (
					SOURCE_FILE_SKIP_DIRS.has(entry.name) ||
					entry.name.startsWith(".")
				)
					continue;
				walk(join(dir, entry.name));
			} else if (entry.isFile()) {
				const ext = entry.name.includes(".")
					? entry.name.split(".").pop()!
					: "";
				if (ext && CODE_EXTENSIONS.has(ext.toLowerCase())) seen++;
			}
		}
	};
	walk(root);
	return seen;
}

/* ----- per-repo index state (~/.cognee-plugin/pi/code-graph/) ----- */

const CODE_STATE_DIR =
	process.env.COGNEE_CODE_STATE_DIR ??
	join(homedir(), ".cognee-plugin", "pi", "code-graph");

function repoStatePath(key: string): string {
	const canonical = canonicalRepoSpec(key);
	return join(
		CODE_STATE_DIR,
		`${readableTail(canonical)}-${sha256Hex(canonical).slice(0, 12)}.json`,
	);
}

/** Persist one repo's index state. Fail-soft: state is an optimization, not a source of truth. */
export function saveRepoState(state: CodeRepoState): void {
	try {
		mkdirSync(CODE_STATE_DIR, { recursive: true });
		writeFileSync(
			repoStatePath(state.repo_root || state.spec),
			JSON.stringify(state),
			"utf8",
		);
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
					const parsed = JSON.parse(
						readFileSync(join(CODE_STATE_DIR, name), "utf8"),
					) as CodeRepoState;
					return parsed &&
						typeof parsed === "object" &&
						parsed.dataset
						? [parsed]
						: [];
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
