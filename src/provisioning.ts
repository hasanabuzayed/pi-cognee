/**
 * pi-cognee — shared-agent-memory provisioning: pure helpers (v0.4).
 *
 * Ported field-for-field from reference/claude-code/scripts/_plugin_common.py
 * (research/v04-provisioning-spec.md §1 is the contract). This module is
 * deliberately dependency-free (node builtins only, no fs, no imports from
 * the sibling modules) so src/client.ts can import it without a cycle; the
 * state-file half of the cluster (agent-key.json / shared-memory.json) lives
 * in client.ts next to the other ~/.cognee-plugin/pi state helpers.
 *
 * Identity model recap (README gap 4): a provisioned plugin agent is its own
 * user, and cognee's grants flow child→parent only — the parent sees what the
 * agent creates, the agent sees nothing the parent or a sibling owns. Shared
 * agent memory closes that loop with the server's existing permission model:
 * a tenant + a "cognee-agent" role holding read+write on the parent's
 * datasets, and every plugin agent a member of that role. All control-plane
 * calls authenticate as the PRINCIPAL (owner-only server-side — an agent key
 * can never widen its own access); only tenants/select runs as the agent.
 */

/** Provision path segment + marker plugin_key — the reference's PLUGIN_KEY. */
export const PLUGIN_KEY = "pi";

/** The shared role every plugin agent joins (reference AGENT_ROLE_NAME). */
export const AGENT_ROLE_NAME = "cognee-agent";

/**
 * Version stamped into the shared-memory marker: a STRUCTURAL wiring failure
 * recorded by this version suppresses re-probing until the plugin updates
 * (server-side fixes ship with plugin bumps — reference parity). Keep in sync
 * with package.json until the release commit pins both.
 */
export const PROVISIONING_PLUGIN_VERSION = "0.4.0-dev";

/** A denied grant is retried after this window (reference _GRANT_DENIED_RETRY_SECONDS). */
export const GRANT_DENIED_RETRY_SECONDS = 3600;

/**
 * Structural (vs transient) shared-memory failures: recorded in the marker,
 * they stop `auto` mode from provisioning again until the plugin updates
 * (reference _STRUCTURAL_SHARED_MEMORY_FAILURES verbatim).
 */
export const STRUCTURAL_SHARED_MEMORY_FAILURES: ReadonlySet<string> = new Set([
  "unsupported",
  "typed_dataset_unsupported",
  "not_tenant_owner",
  "tenantless_with_data",
]);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** ~/.cognee-plugin/pi/shared-memory.json — the wiring marker (§1.1). */
export interface SharedMemoryMarker {
  base_url?: string;
  mode?: "shared" | "separated";
  reason?: string;
  tenant_id?: string;
  role_id?: string;
  parent_user_id?: string;
  agent_id?: string;
  /** Opt-out keeps the ids; re-enabling rejoins the same role. */
  role_member?: boolean;
  /** Dataset UUID → "ok" | {denied_at} (grant backfill memoization). */
  granted?: Record<string, "ok" | { denied_at: number }>;
  /** Dataset name → canonical write UUID (survives restarts). */
  canonical?: Record<string, string>;
  updated_at?: string;
  /** Plugin version that recorded `reason` (structural-reason memo key). */
  plugin_version?: string;
}

/** The wiring outcome every caller consumes (§1.3). */
export interface SharedMemoryOutcome {
  mode: "shared" | "separated";
  reason: string;
  /** Canonical UUID to WRITE the dataset under ("" → address by name). */
  dataset_id: string;
  /** UUIDs to RECALL from (write_id + same-named readable copies). */
  dataset_ids: string[];
  role_id: string;
}

/** One dataset row as the wiring/grant code sees it. */
export interface DatasetRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
}

export type ProvisionStatus =
  | "provisioned"
  | "unsupported"
  | "failed";

export interface ProvisionResult {
  status: ProvisionStatus;
  apiKey?: string;
  agentId?: string;
}

/** listWritableDatasets row with the classified writability. */
export interface WritableDatasetRow {
  name: string;
  id: string;
  owner_id: string;
  /** true = writable, false = read-only, null = unverifiable. */
  writable: boolean | null;
}

export interface WritableDatasetsListing {
  datasets: WritableDatasetRow[];
  readonly: string[];
  readonly_ids: string[];
  hidden_readonly: number;
  /** True when the permissions route answered (writability positively judged). */
  filtered: boolean;
}

export function separatedOutcome(reason: string): SharedMemoryOutcome {
  return { mode: "separated", reason, dataset_id: "", dataset_ids: [], role_id: "" };
}

/* ------------------------------------------------------------------ */
/* Identity policy parsing (§1.2)                                      */
/* ------------------------------------------------------------------ */

/**
 * `plugin_identity` / COGNEE_PLUGIN_IDENTITY → "auto" | "enabled" | "disabled".
 * Reference plugin_identity_mode() verbatim: unset/blank/auto (any case) →
 * auto; 1/true/yes/on → enabled; 0/false/no/off → disabled; anything else is
 * the exact reference error "COGNEE_PLUGIN_IDENTITY must be auto, true, or
 * false" (pi surfaces it as a load-time config warning and falls back to auto
 * — fail-soft, never a crash).
 */
export function parsePluginIdentityMode(
  raw: string | undefined,
): { mode: "auto" | "enabled" | "disabled"; error?: string } {
  const value = (raw ?? "").trim();
  if (!value || value.toLowerCase() === "auto") return { mode: "auto" };
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return { mode: "enabled" };
  if (["0", "false", "no", "off"].includes(normalized)) return { mode: "disabled" };
  return { mode: "auto", error: "COGNEE_PLUGIN_IDENTITY must be auto, true, or false" };
}

/**
 * COGNEE_SHARED_AGENT_MEMORY → off exactly on 0/false/no/off
 * (case-insensitive); default on (reference shared_memory_enabled()).
 */
export function parseSharedAgentMemory(raw: string | undefined): boolean {
  const value = (raw ?? "").trim();
  if (!value) return true;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* OpenAPI capability parsing (§1.1 / §1.3 / §2.2)                     */
/* ------------------------------------------------------------------ */

export interface OpenapiCapabilities {
  /** Provision POST advertises the create_only query parameter. */
  createOnlyProvision: boolean;
  /** POST /api/v1/remember/entry carries `x-cognee-session-dataset-ids: true`. */
  typedDatasetIds: boolean;
}

/**
 * Extract the two provisioning-relevant capability declarations from an
 * openapi document. Returns undefined when the document is not an object —
 * callers treat that as "cannot judge" (probe failure), never as supported.
 */
export function parseOpenapiCapabilities(spec: unknown): OpenapiCapabilities | undefined {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return undefined;
  const paths = (spec as Record<string, unknown>).paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return { createOnlyProvision: false, typedDatasetIds: false };
  }
  const operation = (
    (paths as Record<string, unknown>)["/api/v1/integrations/plugins/{plugin_key}/provision"] as
      | Record<string, unknown>
      | undefined
  )?.post as Record<string, unknown> | undefined;
  let createOnlyProvision = false;
  const parameters = operation?.parameters;
  if (Array.isArray(parameters)) {
    createOnlyProvision = parameters.some(
      (p) =>
        p && typeof p === "object" &&
        (p as Record<string, unknown>).name === "create_only" &&
        (p as Record<string, unknown>).in === "query",
    );
  }
  const entry = (paths as Record<string, unknown>)["/api/v1/remember/entry"] as
    | Record<string, unknown>
    | undefined;
  const typedDatasetIds =
    ((entry?.post as Record<string, unknown> | undefined)?.["x-cognee-session-dataset-ids"] as unknown) ===
    true;
  return { createOnlyProvision, typedDatasetIds };
}

/* ------------------------------------------------------------------ */
/* Provision response validation (§1.1, in order)                      */
/* ------------------------------------------------------------------ */

export type ProvisionRejection =
  | "not_an_object"
  | "incomplete"
  | "missing_agent_id"
  | "agent_key_equals_principal";

/**
 * PluginProvisionDTO validation, reference order: not a dict →
 * not_an_object; missing api_key or created != true → incomplete; missing
 * agent_id → missing_agent_id (shared memory wires the agent BY id);
 * api_key == principal → agent_key_equals_principal. camelCase body with
 * snake_case tolerated on read.
 */
export function validateProvisionResponse(
  result: unknown,
  principalKey: string,
): { ok: true; apiKey: string; agentId: string } | { ok: false; reason: ProvisionRejection; keys?: string[] } {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, reason: "not_an_object" };
  }
  const dto = result as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const apiKey = str(dto.api_key) || str(dto.apiKey);
  const agentId = str(dto.agent_id) || str(dto.agentId);
  const created = Boolean(dto.created);
  if (!apiKey || !created) return { ok: false, reason: "incomplete", keys: sortedKeys(dto) };
  if (!agentId) return { ok: false, reason: "missing_agent_id", keys: sortedKeys(dto) };
  if (apiKey === (principalKey ?? "").trim()) {
    return { ok: false, reason: "agent_key_equals_principal", keys: sortedKeys(dto) };
  }
  return { ok: true, apiKey, agentId };
}

function sortedKeys(dto: Record<string, unknown>): string[] {
  return Object.keys(dto).sort();
}

/* ------------------------------------------------------------------ */
/* Canonical dataset pick (§1.3 step 10)                               */
/* ------------------------------------------------------------------ */

/**
 * The canonical dataset among same-named rows: the parent's own copy, else
 * the oldest (deterministic across plugins, so siblings converge —
 * reference _pick_canonical verbatim; missing created_at sorts last).
 */
export function pickCanonical(rows: DatasetRow[], parentId: string): DatasetRow {
  for (const row of rows) {
    if (row.owner_id && row.owner_id === parentId) return row;
  }
  return [...rows].sort((a, b) => {
    const ka = a.created_at || "9";
    const kb = b.created_at || "9";
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0];
}
