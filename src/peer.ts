import type { Env } from "./types";
import type { Config } from "./config";
import { LOCK_KEY, acquireLock, getState, releaseLock, type UpdateStatus } from "./state";
import { WORKEROPS_VERSION } from "./version";

/**
 * The app updating the guardian (cms-workerops「番人の更新は app が行う」・2026-10-16).
 *
 * The guardian updates the app; the app updates the guardian. Each checks the
 * other from outside and rolls it back from outside — the one thing a
 * guardian replacing ITSELF cannot do. These three calls are what the app
 * needs from the guardian for that, on the same named entrypoint as
 * `publish` (no URL, so only a Worker bound to it can call).
 *
 *   status()       which version is answering, and whether it is busy. The app
 *                  waits for the NEW version to name itself after deploying it.
 *   hold(ttlMs)    take the guardian's lock so it does not update the app while
 *                  the app replaces the guardian. Refuses while an app update
 *                  is running or being verified.
 *   release()      give the lock back.
 */

export interface PeerStatus {
  service: "workerops";
  version: string;
  state: UpdateStatus;
  /**
   * Always false: the guardian never replaces itself — the app it watches does
   * (cms-workerops「番人の更新は app が行う」). Kept because apps read it.
   */
  selfUpdate: false;
  /** The guardian's lock is taken (an operation, or an app's hold). */
  locked: boolean;
}

export type HoldResult = { ok: true } | { ok: false; reason: "update_in_progress" | "busy" };

/** Upper bound on a hold: the lock always expires, even if the app never comes back. */
export const HOLD_MAX_MS = 10 * 60 * 1000;
const HOLD_MIN_MS = 60 * 1000;

export async function peerStatus(env: Env, _config: Config): Promise<PeerStatus> {
  const [state, lock] = await Promise.all([getState(env), env.WORKEROPS_STATE.get(LOCK_KEY)]);
  return {
    service: "workerops",
    version: WORKEROPS_VERSION,
    state: state.status,
    selfUpdate: false,
    locked: !!lock,
  };
}

export async function peerHold(env: Env, ttlMs: unknown): Promise<HoldResult> {
  const st = await getState(env);
  // Same rule as publishing assets: never while an app update is unconfirmed.
  if (st.status === "pending" || st.status === "deployed_unverified") return { ok: false, reason: "update_in_progress" };
  const n = typeof ttlMs === "number" && Number.isFinite(ttlMs) ? ttlMs : HOLD_MAX_MS;
  const ttl = Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, n));
  if (!(await acquireLock(env, ttl))) return { ok: false, reason: "busy" };
  return { ok: true };
}

export async function peerRelease(env: Env): Promise<void> {
  await releaseLock(env);
}
