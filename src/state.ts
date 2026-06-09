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
