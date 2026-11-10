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
  /** The release (X.Y.Z) the last-good version runs, when known: a revoked one is never gone back to. */
  lastGoodRelease: string | null;
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
/** The kind of the app's hold (peer.ts): released by kind, and taken over by the token holder's operations. */
export const PEER_KIND = "peer";
export const LOCK_KEY = "workerops:lock";

const DEFAULT_STATE: UpdateState = {
  status: "idle",
  lastGoodVersionId: null,
  lastGoodRelease: null,
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
  /**
   * Who holds it: `<kind>:<random>`. Only the holder lets it go (releaseLock), so an operation that
   * ends late — or the app's release — never removes a lock another operation took meanwhile.
   */
  owner?: string;
}

/** A lock still stands while younger than its own TTL (or the caller's, if it named none). */
function lockLive(lock: Lock, lockTtlMs: number): boolean {
  const ttl = typeof lock.ttl === "number" && lock.ttl > 0 ? lock.ttl : lockTtlMs;
  return Date.now() - lock.at < ttl;
}

async function readLock(env: Env): Promise<Lock | null | "corrupt"> {
  const raw = await env.WORKEROPS_STATE.get(LOCK_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Lock;
  } catch {
    return "corrupt";
  }
}

/**
 * Single-flight lock. Returns the holder's id (pass it to releaseLock), or null when another
 * operation holds it.
 *
 * Where the state lives in a Durable Object (a concierge hosting the guardians: kv-shim.ts), the
 * read and the write below run with no other I/O between them, so the object's input gate makes
 * them one step and two requests cannot both take the lock. Over Workers KV they are two separate
 * calls and KV has no compare-and-swap; requests from two locations can still both take it there.
 */
export async function acquireLock(
  env: Env,
  lockTtlMs: number,
  kind = "op",
  /**
   * A kind of lock this caller may take over while it is still live. Only an operation the token
   * holder asked for passes PEER_KIND: the app's hold (peer.ts) keeps the guardian from updating
   * the app on its own, but it must not keep the owner from reverting or replacing the app — an
   * app that holds the lock again and again would shut the recovery console out. A lock of any
   * other kind (an operation that is running) is never taken over.
   */
  over?: string,
): Promise<string | null> {
  const lock = await readLock(env);
  if (lock && lock !== "corrupt" && lockLive(lock, lockTtlMs) && !(over && lock.owner?.startsWith(`${over}:`))) return null;
  const owner = `${kind}:${crypto.randomUUID()}`;
  await env.WORKEROPS_STATE.put(LOCK_KEY, JSON.stringify({ at: Date.now(), ttl: lockTtlMs, owner } satisfies Lock), {
    expirationTtl: Math.max(60, Math.ceil(lockTtlMs / 1000)),
  });
  return owner;
}

/** Let the lock go — only if `owner` still holds it. */
export async function releaseLock(env: Env, owner: string): Promise<void> {
  const lock = await readLock(env);
  if (lock && lock !== "corrupt" && lock.owner === owner) await env.WORKEROPS_STATE.delete(LOCK_KEY);
}

/** Let go a lock taken by `kind` (the app's hold: it releases by a separate call and keeps no id). */
export async function releaseKind(env: Env, kind: string): Promise<void> {
  const lock = await readLock(env);
  if (lock && lock !== "corrupt" && lock.owner?.startsWith(`${kind}:`)) await env.WORKEROPS_STATE.delete(LOCK_KEY);
}

export async function clearStaleLock(
  env: Env,
  lockTtlMs: number,
): Promise<void> {
  const lock = await readLock(env);
  if (!lock) return;
  if (lock === "corrupt" || !lockLive(lock, lockTtlMs)) await env.WORKEROPS_STATE.delete(LOCK_KEY);
}
