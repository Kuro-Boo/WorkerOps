import type { Env } from "./types";
import type { Config } from "./config";
import { CfClient } from "./cf";
import {
  getState,
  setState,
  PEER_KIND,
  acquireLock,
  releaseLock,
  clearStaleLock,
  startJournal,
  appendEvent,
} from "./state";
import { answeredBy, probeHealth, runMigrate } from "./health";
import { nowIso, errMsg, OpsError } from "./util";
import { keepGoodCode, restoreVersion } from "./assets";
import { revokedTarget } from "./store-release";

export interface DeployResult {
  ok: boolean;
  status: string;
  toVersion?: string | null;
  release?: string | null;
  error?: string;
}

function cf(config: Config, retryMax?: number): CfClient {
  return new CfClient(config.token, config.accountId, config.appWorkerName, {
    max: retryMax ?? config.retryMax,
    baseMs: config.retryBaseMs,
  });
}


/**
 * Roll back to the last-good version via the CF Versions/Deployments API.
 *
 * `auto` marks a rollback WorkerOps decided on by itself (verification failed,
 * or the watchdog found a deploy still unverified). Those are counted and shown
 * in the console: a human needs to know the guardian has been stepping in, and
 * how often, because nothing else makes it visible.
 */
async function revertTo(
  env: Env,
  config: Config,
  reason: string,
  auto = false,
): Promise<void> {
  const before = await getState(env);
  const target = before.lastGoodVersionId;
  const counters = auto
    ? {
        autoRevertCount: before.autoRevertCount + 1,
        lastAutoRevertAt: nowIso(),
        lastAutoRevertReason: reason,
      }
    : {};
  await appendEvent(
    env,
    auto ? "auto_revert" : "revert",
    "run",
    `${reason}${target ? ` → ${target}` : ""}`,
  );
  // A version on the store's revoked list is never gone back to: a person decides (billing-operations 5.3節).
  if (target && (await revokedTarget(env, config.productId, before.lastGoodRelease).catch(() => false))) {
    await appendEvent(env, auto ? "auto_revert" : "revert", "fail", `last-good release ${before.lastGoodRelease} is revoked`);
    await setState(env, {
      status: "manual_required",
      error: `${reason}; last-good release ${before.lastGoodRelease} is revoked`,
      finishedAt: nowIso(),
      ...counters,
    });
    return;
  }
  if (!target) {
    await appendEvent(
      env,
      auto ? "auto_revert" : "revert",
      "fail",
      "no last-good version recorded",
    );
    await setState(env, {
      status: "manual_required",
      error: `${reason}; no last-good version to revert to`,
      finishedAt: nowIso(),
      ...counters,
    });
    return;
  }
  try {
    // With assets, a new version from the last-good code that keeps today's
    // pages; otherwise the old version id, as before (assets.ts).
    const restored = await restoreVersion(
      env,
      cf(config, config.revertRetryMax),
      target,
      `WorkerOps revert (${reason})`,
      config.bindingTypes,
    );
    await appendEvent(
      env,
      auto ? "auto_revert" : "revert",
      "ok",
      restored.how === "code" ? `${restored.versionId} (last-good code, current assets)` : target,
    );
    await setState(env, {
      status: "reverted",
      finishedAt: nowIso(),
      error: reason,
      ...(restored.how === "code" ? { lastGoodVersionId: restored.versionId } : {}),
      ...counters,
    });
  } catch (e) {
    await appendEvent(
      env,
      auto ? "auto_revert" : "revert",
      "fail",
      errMsg(e),
    );
    await setState(env, {
      status: "manual_required",
      error: `${reason}; revert failed: ${errMsg(e)}`,
      finishedAt: nowIso(),
      ...counters,
    });
  }
}

/** Manual revert from the Ops API. */
export async function runRevert(env: Env, config: Config): Promise<DeployResult> {
  // The token holder asked: the app's hold does not stand in the way (state.ts acquireLock).
  const lock = await acquireLock(env, config.lockTtlMs, "op", PEER_KIND);
  if (!lock) {
    throw new OpsError(409, "update_in_progress", "An operation is already in progress.");
  }
  try {
    await startJournal(env, "revert");
    await revertTo(env, config, "manual");
    const st = await getState(env);
    return {
      ok: st.status === "reverted",
      status: st.status,
      error: st.error ?? undefined,
    };
  } finally {
    await releaseLock(env, lock);
  }
}

/**
 * Clears stale locks and finishes any update left in `deployed_unverified`.
 *
 * It acts only under the lock: an update that is still verifying holds the lock, and the watchdog
 * must not confirm or revert under its feet. It confirms only an answer from the version that was
 * deployed (health.ts answeredBy) — the old version's ok after the window means the new one was
 * never seen, and that is reverted, not recorded as last-good.
 */
export async function watchdogTick(env: Env, config: Config): Promise<void> {
  await clearStaleLock(env, config.lockTtlMs);
  const peek = await getState(env);
  if (peek.status !== "deployed_unverified") return;
  // Only act once the verification window should have elapsed.
  const deployedAt = peek.deployedAt ? Date.parse(peek.deployedAt) : 0;
  if (deployedAt && Date.now() - deployedAt < config.healthWindowMs) return;

  const lock = await acquireLock(env, config.lockTtlMs);
  if (!lock) return;
  try {
    const st = await getState(env);
    if (st.status !== "deployed_unverified") return;
    const h = await probeHealth(env, config);
    const seen = answeredBy(h, st.intendedRelease) === "new";
    if (seen && h.ok) {
      // The verification that should have asked the app to migrate never finished
      // (its isolate ended mid-window). Ask now, before confirming — confirming
      // without it would leave the new version running on the old schema.
      // The app's migrate endpoint is idempotent, so asking twice is harmless.
      if (config.migratePath) {
        await appendEvent(env, "migrate", "run", `watchdog: ${config.migratePath}`);
        if (!(await runMigrate(env, config))) {
          await appendEvent(env, "migrate", "fail", "watchdog");
          await revertTo(env, config, "watchdog: migrate failed", true);
          return;
        }
        await appendEvent(env, "migrate", "ok", "watchdog");
      }
      await appendEvent(env, "watchdog", "ok", `unverified deploy answered as ${h.version} after the window`);
      await setState(env, {
        status: "confirmed",
        confirmedAt: nowIso(),
        finishedAt: nowIso(),
        lastGoodVersionId: st.toVersionId ?? st.lastGoodVersionId,
        lastGoodRelease: st.toVersionId ? st.intendedRelease : st.lastGoodRelease,
        error: null,
      });
      await keepGoodCode(env, config, st.toVersionId ?? st.lastGoodVersionId);
    } else {
      await appendEvent(
        env,
        "watchdog",
        "fail",
        seen
          ? `new version unhealthy after the window (HTTP ${h.status})`
          : `new version ${st.intendedRelease ?? "?"} not observed after the window (answered ${h.version ?? "no version"}, HTTP ${h.status})`,
      );
      await revertTo(env, config, "watchdog: unverified after window", true);
    }
  } finally {
    await releaseLock(env, lock);
  }
}
