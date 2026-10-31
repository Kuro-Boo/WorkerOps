/**
 * Restarting the app when it stops answering during normal operation (APP_RESTART=1).
 *
 * Until now the guardian acted on its own only right after an update (verify, then roll back). An app
 * that went down later — a wedged isolate, a bad state held in memory — stayed down until a person
 * noticed. A restart puts the version that is serving right now back out (a new deployment of the SAME
 * version id): no version moves, so it is the safest first step, the same as Admin's 再起動.
 *
 * Decided by states the guardian sees, not by how long it waited (counted in the guardian's own ticks):
 *
 *   healthy          nothing is written (KV writes are kept for transitions)
 *   1st failure      remembered ("watching")
 *   2nd in a row     the serving version is deployed again ("restarted") — once per incident
 *   still failing    after a restart, two more failures in a row: "down". Nothing more is tried
 *                    (the cause is not the isolate — data, a binding, the platform), reported once
 *   healthy again    the incident ends; a restart that helped is reported as a record
 *
 * Never while an update is running or unverified (that has its own verify and roll back), and never
 * without the guardian's lock (an app replacing the guardian holds it: peer.ts).
 *
 * The app can also ask for a restart over the service binding (WorkerOpsAssets.restart): an operator
 * pressing a button in the app's own admin screen. That one is not counted as an incident.
 */
import type { Env } from "./types";
import type { Config } from "./config";
import { CfClient } from "./cf";
import { acquireLock, getState, releaseLock } from "./state";
import { probeHealth, type HealthResult } from "./health";
import { reportDefect } from "./defects";
import { errMsg, nowIso } from "./util";

export const RESTART_KEY = "workerops:restart";
/** Failed health checks in a row (guardian ticks) before a restart, and again before giving up. */
export const FAILURES_TO_ACT = 2;

export interface RestartRecord {
  /** Failed checks in a row in the current phase (before or after the restart). */
  failures: number;
  /** This incident already restarted the app. */
  restarted: boolean;
  /** A restart did not help; nothing more is tried until the app answers again. */
  down: boolean;
  /** Lifetime number of restarts (automatic and asked for). */
  count: number;
  lastAt: string | null;
  /** Why: "health HTTP 503", "asked by the app", … */
  lastReason: string | null;
  /** What the last restart did: "ok" or the error code. */
  lastOutcome: string | null;
}

const EMPTY: RestartRecord = {
  failures: 0, restarted: false, down: false, count: 0, lastAt: null, lastReason: null, lastOutcome: null,
};

export const restartEnabled = (env: Env): boolean => env.APP_RESTART === "1";

export async function getRestart(env: Env): Promise<RestartRecord> {
  const raw = await env.WORKEROPS_STATE.get(RESTART_KEY);
  if (!raw) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<RestartRecord>) };
  } catch {
    return { ...EMPTY };
  }
}

async function putRestart(env: Env, r: RestartRecord): Promise<void> {
  await env.WORKEROPS_STATE.put(RESTART_KEY, JSON.stringify(r));
}

export interface RestartDeps {
  probe: (env: Env, config: Config) => Promise<HealthResult>;
  client: (config: Config) => Pick<CfClient, "getActiveVersionId" | "deployVersion">;
}

const defaultDeps: RestartDeps = {
  probe: probeHealth,
  client: (config) => new CfClient(config.token, config.accountId, config.appWorkerName, {
    max: config.retryMax, baseMs: config.retryBaseMs,
  }),
};

export type RestartTick = "off" | "busy" | "healthy" | "watching" | "restarted" | "restart_failed" | "down";

/** Put the serving version out again. Holds the guardian's lock; returns "ok" or an error code. */
async function redeploy(env: Env, config: Config, deps: RestartDeps, reason: string): Promise<"ok" | "busy" | "no_active_version" | "deploy_failed"> {
  if (!(await acquireLock(env, config.lockTtlMs))) return "busy";
  try {
    const cf = deps.client(config);
    const active = await cf.getActiveVersionId();
    if (!active) return "no_active_version";
    await cf.deployVersion(active, `WorkerOps restart (${reason})`);
    return "ok";
  } catch (e) {
    console.log("restart failed", errMsg(e));
    return "deploy_failed";
  } finally {
    await releaseLock(env);
  }
}

const updating = async (env: Env) => {
  const st = await getState(env);
  return st.status === "pending" || st.status === "deployed_unverified";
};

/** One guardian tick of the watch. */
export async function restartTick(env: Env, config: Config, deps: RestartDeps = defaultDeps): Promise<RestartTick> {
  if (!restartEnabled(env)) return "off";
  if (await updating(env)) return "busy";
  const h = await deps.probe(env, config);
  const r = await getRestart(env);

  if (h.ok) {
    if (r.failures === 0 && !r.restarted && !r.down) return "healthy";
    // The incident is over. A restart that brought the app back is worth a trace.
    if (r.restarted && !r.down) await reportDefect(env, "workerops_app_restarted", { reason: r.lastReason, outcome: r.lastOutcome });
    await putRestart(env, { ...r, failures: 0, restarted: false, down: false });
    return "healthy";
  }

  if (r.down) return "down";
  const failures = r.failures + 1;
  if (failures < FAILURES_TO_ACT) {
    await putRestart(env, { ...r, failures });
    return "watching";
  }
  if (r.restarted) {
    await putRestart(env, { ...r, failures, down: true });
    await reportDefect(env, "workerops_app_down", { status: h.status });
    return "down";
  }
  const reason = `health HTTP ${h.status}`;
  const outcome = await redeploy(env, config, deps, reason);
  if (outcome === "busy") {
    // Someone else holds the lock (an app replacing the guardian). Count stays; try next tick.
    await putRestart(env, { ...r, failures });
    return "busy";
  }
  await putRestart(env, {
    ...r, failures: 0, restarted: true, down: outcome !== "ok",
    count: r.count + 1, lastAt: nowIso(), lastReason: reason, lastOutcome: outcome,
  });
  if (outcome !== "ok") {
    await reportDefect(env, "workerops_app_down", { status: h.status, step: outcome });
    return "restart_failed";
  }
  return "restarted";
}

export type AskedRestart = { ok: true } | { ok: false; reason: "update_in_progress" | "busy" | "no_active_version" | "deploy_failed" };

/** The app asks for its own restart (an operator's button). Not an incident: the watch is left as it is. */
export async function askedRestart(env: Env, config: Config, reason: string, deps: RestartDeps = defaultDeps): Promise<AskedRestart> {
  if (await updating(env)) return { ok: false, reason: "update_in_progress" };
  const why = `asked by the app: ${reason.replace(/[^\w .:-]/g, "").slice(0, 60) || "no reason"}`;
  const outcome = await redeploy(env, config, deps, why);
  if (outcome === "busy") return { ok: false, reason: "busy" };
  const r = await getRestart(env);
  await putRestart(env, { ...r, count: r.count + 1, lastAt: nowIso(), lastReason: why, lastOutcome: outcome });
  return outcome === "ok" ? { ok: true } : { ok: false, reason: outcome };
}
