/**
 * A guardian that brings no versions itself follows what is serving (2026-11-10).
 *
 * Some guardians only stand in front of an app and put it back when asked: the app's versions come
 * from somewhere else (Entamy Admin: the platform concierge deploys it, entamy-admin-ops is the way
 * back from outside). Such a guardian never confirms a version, so its revert target stayed where its
 * last own update left it — on Admin, a version three months old that Revert would have put out.
 *
 * So, when the install says so (FOLLOW_SERVING=1) and there is no release source (no PRODUCT_ID, no
 * RELEASE_STORE, none declared by the app), the guardian
 * records the version that serves all traffic as last-good once the app has answered healthy from it
 * on two ticks in a row. Two, because right after a deployment the service binding may still answer
 * from the old version: one healthy answer does not say which version gave it (the same care as
 * verify, which waits for the new version to name itself — here there is no intended version to wait
 * for). An unhealthy answer or a different serving version starts over, so a broken version is never
 * recorded and Revert goes back to the one before it.
 *
 * A guardian with a release source is left alone: there, last-good is what it confirmed itself.
 * Off unless asked for: it costs one health request and one Cloudflare API read per guardian tick.
 */
import type { Env } from "./types";
import type { Config } from "./config";
import { CfClient } from "./cf";
import { acquireLock, appendEvent, getState, releaseLock, setState } from "./state";
import { probeHealth, type HealthResult } from "./health";
import { keepGoodCode } from "./assets";

export const FOLLOW_KEY = "workerops:follow";

/** The serving version seen healthy on the tick before, waiting for a second look. */
interface Seen {
  versionId: string;
  /** What the app called itself then (health.version), when it says. */
  release: string | null;
}

export interface FollowDeps {
  probe: (env: Env, config: Config) => Promise<HealthResult>;
  client: (config: Config) => Pick<CfClient, "getActiveVersionId">;
}

const defaultDeps: FollowDeps = {
  probe: probeHealth,
  client: (config) => new CfClient(config.token, config.accountId, config.appWorkerName, { max: 1, baseMs: config.retryBaseMs }),
};

export type FollowTick = "off" | "busy" | "unhealthy" | "unknown" | "current" | "seen" | "followed";

async function seen(env: Env): Promise<Seen | null> {
  const raw = await env.WORKEROPS_STATE.get(FOLLOW_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Seen;
  } catch {
    return null;
  }
}
const forget = async (env: Env, had: Seen | null) => {
  if (had) await env.WORKEROPS_STATE.delete(FOLLOW_KEY);
};

/** One guardian tick of the follow. */
export async function followTick(env: Env, config: Config, deps: FollowDeps = defaultDeps): Promise<FollowTick> {
  if (env.FOLLOW_SERVING !== "1" || env.RELEASE_STORE || config.productId) return "off";
  const before = await getState(env);
  if (before.status === "pending" || before.status === "deployed_unverified") return "busy";
  const had = await seen(env);

  const h = await deps.probe(env, config);
  // The app names a product at the distribution endpoint: this guardian brings its versions after all.
  if (h.productId) {
    await forget(env, had);
    return "off";
  }
  if (!h.ok) {
    await forget(env, had);
    return "unhealthy";
  }
  const serving = await deps.client(config).getActiveVersionId(true).catch(() => null);
  if (!serving) {
    await forget(env, had);
    return "unknown";
  }
  if (serving === before.lastGoodVersionId) {
    await forget(env, had);
    return "current";
  }
  const release = h.version ?? null;
  if (!had || had.versionId !== serving || had.release !== release) {
    await env.WORKEROPS_STATE.put(FOLLOW_KEY, JSON.stringify({ versionId: serving, release } satisfies Seen));
    return "seen";
  }

  const lock = await acquireLock(env, config.lockTtlMs);
  if (!lock) return "busy";
  try {
    const st = await getState(env);
    if (st.status === "pending" || st.status === "deployed_unverified") return "busy";
    await appendEvent(env, "follow", "ok", `${serving}${release ? ` (${release})` : ""} is serving and healthy: last-good now`);
    await setState(env, {
      lastGoodVersionId: serving,
      lastGoodRelease: release,
      // A revert that is over is no longer the news once a newer version serves healthy. A failure a
      // person has to look at (manual_required, failed_predeploy) stays on the screen.
      ...(st.status === "reverted" ? { status: "idle" as const, error: null } : {}),
    });
    await env.WORKEROPS_STATE.delete(FOLLOW_KEY);
    await keepGoodCode(env, config, serving);
    return "followed";
  } finally {
    await releaseLock(env, lock);
  }
}
