/**
 * pi-cognee — persisted improve-cooldown state (v0.4 resilience spec §2.4).
 *
 * Ported field-for-field from the reference `_plugin_common.py`
 * (`improve-state/<sha1(session_id)>.json` + the `counter.json` map): the idle
 * bridge exits after each attempt in the reference (and pi re-arms per turn),
 * so a process-local timestamp would reset every launch — the file is what
 * makes "improved 10 min ago" meaningful across restarts.
 *
 * Semantics (consulted ONLY by automatic triggers — idle and every-N; the
 * final/manual/switch syncs always run):
 *   "cooldown"        — last success younger than the cooldown window;
 *   "backoff"         — last FAILED attempt younger than the same window
 *                       (one auto attempt per window for a sick server);
 *   "no_new_entries"  — the stored-write counter did not advance past the
 *                       count recorded at the last success;
 *   ""                — may run. A session that never attempted is never
 *                       throttled.
 * Success/failure are recorded only by the confirmed outcomes of the
 * submitImprove wrapper — a skip is never stamped a success.
 *
 * Pure functions over piStateDir() (~/.cognee-plugin/pi, COGNEE_PI_STATE_DIR
 * honored): no timers, no spawns, all IO fail-soft with atomic writes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piStateDir } from "./helpers";
import { describeError } from "./helpers/errors";

/** Reference default (COGNEE_IMPROVE_COOLDOWN = 1800 s), pi keeps its _MS name. */
export const DEFAULT_IMPROVE_COOLDOWN_MS = 1_800_000;

export type ImproveThrottleReason = "" | "cooldown" | "backoff" | "no_new_entries";

/** File format — success fields whole-file replaced, failure fields merged in. */
export interface ImproveState {
  session_id?: string;
  dataset?: string;
  last_improved_at?: number;
  turn_count_at_improve?: number;
  trigger?: string;
  /* failure fields (merge keeps the last success) */
  last_failed_at?: number;
  last_failure_reason?: string;
  last_failure_trigger?: string;
  failure_count?: number;
}

function sha1Hex(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

/** <stateDir>/improve-state/<sha1(sessionId)>.json */
export function improveStatePath(sessionId: string): string {
  return join(piStateDir(), "improve-state", `${sha1Hex(sessionId)}.json`);
}

/** <stateDir>/improve-counter.json — the persisted stored-write counter map. */
export function improveCounterPath(): string {
  return join(piStateDir(), "improve-counter.json");
}

/** Read one session's state; {} when absent/corrupt (never throws). */
export function readImproveState(sessionId: string): ImproveState {
  try {
    const raw = JSON.parse(readFileSync(improveStatePath(sessionId), "utf8")) as ImproveState;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

function writeImproveState(sessionId: string, state: ImproveState): void {
  const path = improveStatePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Confirmed success — whole-file replace (failure fields wiped, reference parity). */
export function recordImproveSuccess(
  sessionId: string,
  dataset: string,
  trigger: string,
  storedCount: number,
): void {
  try {
    writeImproveState(sessionId, {
      session_id: sessionId,
      dataset,
      last_improved_at: Date.now(),
      turn_count_at_improve: Math.max(0, Math.trunc(storedCount) || 0),
      trigger,
    });
  } catch {
    /* fail-soft — cooldown state is an optimization over re-improving */
  }
}

/** Confirmed failure — merge; keeps the last success fields. Reason capped at 120 chars. */
export function recordImproveFailure(
  sessionId: string,
  dataset: string,
  trigger: string,
  reason: string,
): void {
  try {
    const prior = readImproveState(sessionId);
    writeImproveState(sessionId, {
      ...prior,
      session_id: prior.session_id ?? sessionId,
      dataset: prior.dataset ?? dataset,
      last_failed_at: Date.now(),
      last_failure_reason: String(reason ?? "").slice(0, 120),
      last_failure_trigger: trigger,
      failure_count: (Number(prior.failure_count) || 0) + 1,
    });
  } catch {
    /* fail-soft */
  }
}

/**
 * The automatic-trigger gate. Check order matches the reference listing:
 * cooldown → backoff → no_new_entries. A session with no recorded success is
 * never throttled.
 */
export function improveThrottleReason(
  sessionId: string,
  cooldownMs: number = DEFAULT_IMPROVE_COOLDOWN_MS,
  nowMs: number = Date.now(),
): ImproveThrottleReason {
  if (!sessionId) return "";
  try {
    const st = readImproveState(sessionId);
    const improvedAt = Number(st.last_improved_at) || 0;
    if (improvedAt > 0 && nowMs - improvedAt < cooldownMs) return "cooldown";
    const failedAt = Number(st.last_failed_at) || 0;
    if (failedAt > 0 && nowMs - failedAt < cooldownMs) return "backoff";
    if (improvedAt > 0 && readStoredCounter(sessionId) <= (Number(st.turn_count_at_improve) || 0)) {
      return "no_new_entries";
    }
    return "";
  } catch {
    return ""; // unreadable state must never wedge the auto paths
  }
}

/* ------------------------------------------------------------------ */
/* Persisted stored-write counter                                      */
/* ------------------------------------------------------------------ */

type CounterMap = Record<string, number>;

function readCounterMap(): CounterMap {
  try {
    const raw = JSON.parse(readFileSync(improveCounterPath(), "utf8")) as CounterMap;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

function writeCounterMap(map: CounterMap): void {
  const path = improveCounterPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map), "utf8");
  renameSync(tmp, path);
}

/** The session's stored-write count (bumped once per successfully sent entry). */
export function readStoredCounter(sessionId: string): number {
  if (!sessionId) return 0;
  return Math.max(0, Math.trunc(Number(readCounterMap()[sessionId])) || 0);
}

/** +1 per stored write (the analog of the reference's per trace/qa bump). Returns the new count. */
export function bumpStoredCounter(sessionId: string): number {
  if (!sessionId) return 0;
  try {
    const map = readCounterMap();
    const next = (Number(map[sessionId]) || 0) + 1;
    map[sessionId] = next;
    writeCounterMap(map);
    return next;
  } catch (err) {
    void describeError(err);
    return readStoredCounter(sessionId); // best-effort: the counter is advisory
  }
}
