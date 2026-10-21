import type { Env } from "./types";
import { nowIso } from "./util";
import { reportDefect } from "./defects";

export type UpdateStatus =
  | "idle"
  | "pending"
  | "deployed_unverified"
  | "confirmed"
  | "reverted"
  | "failed_predeploy"
  | "manual_required";

/**
 * One step of an operation, as it happened. Recorded by the orchestrator so the
 * recovery console can report the actual course of a revert/update instead of
 * just its final status — an operation runs for up to a minute across a
 * background waitUntil, and until now the only visible outcome was a status
 * word that appeared after the fact.
 */
export interface OpEvent {
  at: string;
  /** Machine-readable step key; the console localizes it. */
  step: string;
  state: "run" | "ok" | "fail";
  detail?: string;
}

/** Kept small on purpose: this lives in one KV value alongside the state. */
export const EVENT_CAP = 40;

export interface UpdateState {
  status: UpdateStatus;
  /** CF version id known to be healthy — the revert target. */
  lastGoodVersionId: string | null;
  fromVersionId: string | null;
  toVersionId: string | null;
  /** App's self-reported health.version BEFORE the update (propagation anchor). */
  prevAppVersion: string | null;
  intendedRelease: string | null;
  startedAt: string | null;
  deployedAt: string | null;
  confirmedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  updatedAt: string;
  /** Step-by-step journal of the most recent operation (oldest first). */
  events: OpEvent[];
  /** Which operation the journal belongs to ("update" / "reinstall" / "revert"). */
  operation: string | null;
  /**
   * How many times WorkerOps rolled the app back BY ITSELF (verification failed
   * or the watchdog found an unverified deploy) — never counts a human pressing
   * Revert. This is the only automatic recovery WorkerOps performs; it does not
   * restart a Worker that fails during normal operation.
   */
  autoRevertCount: number;
  lastAutoRevertAt: string | null;
  lastAutoRevertReason: string | null;
}

const STATE_KEY = "workerops:state";
export const LOCK_KEY = "workerops:lock";

const DEFAULT_STATE: UpdateState = {
  status: "idle",
  lastGoodVersionId: null,
  fromVersionId: null,
  toVersionId: null,
  prevAppVersion: null,
  intendedRelease: null,
  startedAt: null,
  deployedAt: null,
  confirmedAt: null,
  finishedAt: null,
  error: null,
  updatedAt: "",
  events: [],
  operation: null,
  autoRevertCount: 0,
  lastAutoRevertAt: null,
  lastAutoRevertReason: null,
};

export async function getState(env: Env): Promise<UpdateState> {
  const raw = await env.WORKEROPS_STATE.get(STATE_KEY);
  if (!raw) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<UpdateState>) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function setState(
  env: Env,
  patch: Partial<UpdateState>,
): Promise<UpdateState> {
  const prev = await getState(env);
  const next: UpdateState = {
    ...prev,
    ...patch,
    updatedAt: nowIso(),
  };
  await env.WORKEROPS_STATE.put(STATE_KEY, JSON.stringify(next));
  // Failures go to Entamy Defects, once per transition (defects.ts), and so
  // does a confirmed update — as a record, not a defect.
  const code = appFailureCode(prev, patch) ?? appRecordCode(prev, patch);
  if (code === "workerops_app_updated") {
    await reportDefect(env, code, {
      operation: next.operation,
      release: next.intendedRelease,
      from: next.prevAppVersion,
    });
  } else if (code) {
    await reportDefect(env, code, {
      operation: next.operation,
      step: lastFailedStep(next.events),
      release: next.intendedRelease,
    });
  }
  return next;
}

/** Which failure, if any, this write records. A human pressing Revert is not one. */
export function appFailureCode(
  prev: UpdateState,
  patch: Partial<UpdateState>,
):
  | "workerops_app_failed_predeploy"
  | "workerops_app_auto_reverted"
  | "workerops_app_manual_required"
  | null {
  if (!patch.status || patch.status === prev.status) return null;
  if (patch.status === "failed_predeploy") return "workerops_app_failed_predeploy";
  if (patch.status === "manual_required") return "workerops_app_manual_required";
  // Only automatic reverts carry the counter (orchestrator.revertTo).
  if (patch.status === "reverted" && patch.autoRevertCount !== undefined)
    return "workerops_app_auto_reverted";
  return null;
}

/**
 * A confirmed update (also one the watchdog confirms later). Only update and
 * reinstall end in "confirmed" — a revert ends in "reverted" — so the
 * transition alone says the app now runs a new, verified version.
 */
export function appRecordCode(
  prev: UpdateState,
  patch: Partial<UpdateState>,
): "workerops_app_updated" | null {
  return patch.status === "confirmed" && prev.status !== "confirmed"
    ? "workerops_app_updated"
    : null;
}

/** The step key of the last failed step in the journal (a token, not text). */
export function lastFailedStep(events: OpEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--)
    if (events[i]?.state === "fail") return events[i]!.step;
  return null;
}

/** Begin a fresh journal for `operation`, discarding the previous run's steps. */
export async function startJournal(
  env: Env,
  operation: string,
): Promise<void> {
  await setState(env, { operation, events: [] });
}

/**
 * Append one step to the journal. Read-modify-write, which is safe here because
 * every operation holds the single-flight lock while it runs.
 */
export async function appendEvent(
  env: Env,
  step: string,
  state: OpEvent["state"],
  detail?: string,
): Promise<void> {
  const current = await getState(env);
  const event: OpEvent = { at: nowIso(), step, state };
  if (detail) event.detail = detail.slice(0, 300);
  await setState(env, {
    events: [...current.events, event].slice(-EVENT_CAP),
  });
}

interface Lock {
  at: number;
  /**
   * How long THIS lock is meant to last. A holder that needs longer than the
   * guardian's own operations (an app replacing the guardian: peer.ts) says
   * so here — otherwise the guardian, judging by its own shorter TTL, would
   * take the lock over midway and update the app under the app's feet.
   */
  ttl?: number;
}

/** A lock still stands while younger than its own TTL (or the caller's, if it named none). */
function lockLive(lock: Lock, lockTtlMs: number): boolean {
  const ttl = typeof lock.ttl === "number" && lock.ttl > 0 ? lock.ttl : lockTtlMs;
  return Date.now() - lock.at < ttl;
}

/**
 * Single-flight lock. KV is eventually consistent, so this is best-effort —
 * adequate for admin-triggered updates. Stale locks expire via TTL + watchdog.
 */
export async function acquireLock(
  env: Env,
  lockTtlMs: number,
): Promise<boolean> {
  const raw = await env.WORKEROPS_STATE.get(LOCK_KEY);
  if (raw) {
    try {
      const lock = JSON.parse(raw) as Lock;
      if (lockLive(lock, lockTtlMs)) return false;
    } catch {
      /* corrupt lock — overwrite */
    }
  }
  await env.WORKEROPS_STATE.put(LOCK_KEY, JSON.stringify({ at: Date.now(), ttl: lockTtlMs } satisfies Lock), {
    expirationTtl: Math.max(60, Math.ceil(lockTtlMs / 1000)),
  });
  return true;
}

export async function releaseLock(env: Env): Promise<void> {
  await env.WORKEROPS_STATE.delete(LOCK_KEY);
}

export async function clearStaleLock(
  env: Env,
  lockTtlMs: number,
): Promise<void> {
  const raw = await env.WORKEROPS_STATE.get(LOCK_KEY);
  if (!raw) return;
  try {
    const lock = JSON.parse(raw) as Lock;
    if (!lockLive(lock, lockTtlMs)) await env.WORKEROPS_STATE.delete(LOCK_KEY);
  } catch {
    await env.WORKEROPS_STATE.delete(LOCK_KEY);
  }
}
