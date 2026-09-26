import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PI_STATE_DIR = join(homedir(), ".cognee-plugin", "pi");

export const API_KEY_CACHE_PATH =
	process.env.COGNEE_API_KEY_CACHE ??
	join(homedir(), ".cognee-plugin", "api_key.json");

export const LOCAL_ALIASES = new Set(["local", "native", "sdk"]);

export const CLOUD_ALIASES = new Set(["cloud", "http", "api", "server"]);

/** The reference PostToolUse matcher translated to pi tool names — the DEFAULT
 *  value of COGNEE_CAPTURE_TOOLS (a user-set value replaces it wholesale). */
export const DEFAULT_CAPTURE_TOOLS: readonly string[] = [
	"bash",
	"powershell",
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
];

/** Code extensions cognee's CodeLoader claims (v1.5.3) — file-cap + identifier patterns. */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
	"c",
	"cc",
	"cpp",
	"cs",
	"cxx",
	"dart",
	"fs",
	"go",
	"h",
	"hcl",
	"hh",
	"hpp",
	"java",
	"js",
	"jsx",
	"kt",
	"kts",
	"php",
	"proto",
	"py",
	"rake",
	"rb",
	"rs",
	"scala",
	"svelte",
	"swift",
	"tf",
	"ts",
	"tsx",
	"vb",
	"vue",
]);

/** Reference `_PATH_KEYS` — only values under these keys (compare lowercased,
 *  recursing nested dicts/lists) are tested against the deny list. */
export const PATH_KEYS: ReadonlySet<string> = new Set([
  "file_path", "filepath", "path", "paths", "notebook_path", "filename",
]);

/** Reference `_DENY_PATHS`, verbatim. */
export const DENY_PATHS: readonly string[] = [
  ".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc",
  "*/.aws/credentials", "*/.ssh/*", "*.p12", "*.pfx", "secrets.*", "credentials.*",
];