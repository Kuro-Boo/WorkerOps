import type { Env } from "./types";
import { nowIso } from "./util";

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
const LOCK_KEY = "workerops:lock";

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
  const next: UpdateState = {
    ...(await getState(env)),
    ...patch,
    updatedAt: nowIso(),
  };
  await env.WORKEROPS_STATE.put(STATE_KEY, JSON.stringify(next));
  return next;
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
      if (Date.now() - lock.at < lockTtlMs) return false;
    } catch {
      /* corrupt lock — overwrite */
    }
  }
  await env.WORKEROPS_STATE.put(LOCK_KEY, JSON.stringify({ at: Date.now() }), {
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
    if (Date.now() - lock.at >= lockTtlMs)
      await env.WORKEROPS_STATE.delete(LOCK_KEY);
  } catch {
    await env.WORKEROPS_STATE.delete(LOCK_KEY);
  }
}
