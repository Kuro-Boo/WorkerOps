import type { Env } from "./types";
import type { Config } from "./config";
import { CfClient } from "./cf";
import {
  getState,
  setState,
  acquireLock,
  releaseLock,
  clearStaleLock,
} from "./state";
import { probeHealth, runMigrate } from "./health";
import { fetchRetry } from "./retry";
import { nowIso, errMsg, sleep, OpsError } from "./util";

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

/** Keep only binding types that can be re-submitted; secrets persist on their own. */
function filterBindings(bindings: unknown[], allow: Set<string>): unknown[] {
  return (bindings ?? []).filter((b) => {
    const t = (b as { type?: string })?.type;
    return typeof t === "string" && allow.has(t);
  });
}

async function fetchReleaseWorker(
  env: Env,
  config: Config,
): Promise<{ tag: string; script: string }> {
  const repo = config.releaseSource;
  if (!repo) throw new Error("RELEASE_SOURCE is not configured");
  const retry = { max: config.retryMax, baseMs: config.retryBaseMs };

  // Release tag is informational (used for the strict version check / logging).
  let tag = "latest";
  try {
    const r = await fetchRetry(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          "User-Agent": "WorkerOps/1.0",
          Accept: "application/vnd.github+json",
        },
      },
      retry,
    );
    if (r.ok) {
      const d = (await r.json().catch(() => null)) as { tag_name?: string } | null;
      if (d?.tag_name) tag = d.tag_name;
    }
  } catch {
    /* tag is best-effort */
  }

  // Download the asset from the resolved tag's URL (deterministic) rather than
  // /latest/download/, whose CDN cache can briefly serve a previous release's
  // asset right after a new release is published.
  const url =
    tag !== "latest"
      ? `https://github.com/${repo}/releases/download/${tag}/${config.releaseAsset}`
      : `https://github.com/${repo}/releases/latest/download/${config.releaseAsset}`;
  const res = await fetchRetry(
    url,
    { redirect: "follow", headers: { "User-Agent": "WorkerOps/1.0" } },
    { ...retry, timeoutMs: 30_000 },
  );
  if (!res.ok) throw new Error(`release asset HTTP ${res.status}`);
  const script = await res.text();
  if (!script || script.length < 10) throw new Error("release asset empty");
  return { tag, script };
}

/**
 * Deploy the latest release (update / reinstall). Returns quickly after the
 * deploy is journaled; health verification + auto-revert run in the background
 * (ctx.waitUntil) and are backstopped by the watchdog.
 */
export async function deployLatest(
  env: Env,
  ctx: ExecutionContext,
  config: Config,
  reason: string,
): Promise<DeployResult> {
  if (!config.token || !config.accountId || !config.appWorkerName) {
    throw new OpsError(
      400,
      "cf_config_missing",
      "CF_API_TOKEN / CF_ACCOUNT_ID / APP_WORKER_NAME are required.",
    );
  }
  if (!(await acquireLock(env, config.lockTtlMs))) {
    throw new OpsError(409, "update_in_progress", "An update is already in progress.");
  }
  const client = cf(config);
  let lockHeld = true;

  const fail = async (error: string): Promise<DeployResult> => {
    await setState(env, {
      status: "failed_predeploy",
      error,
      finishedAt: nowIso(),
    });
    await releaseLock(env);
    lockHeld = false;
    return { ok: false, status: "failed_predeploy", error };
  };

  try {
    const fromVersion = await client.getActiveVersionId();
    // Anchor for propagation-aware verification: the version the app reports now.
    const prevAppVersion = (await probeHealth(env, config)).version ?? null;
    await setState(env, {
      status: "pending",
      fromVersionId: fromVersion,
      lastGoodVersionId:
        fromVersion ?? (await getState(env)).lastGoodVersionId,
      toVersionId: null,
      prevAppVersion,
      intendedRelease: null,
      startedAt: nowIso(),
      deployedAt: null,
      confirmedAt: null,
      finishedAt: null,
      error: null,
    });

    let rel: { tag: string; script: string };
    try {
      rel = await fetchReleaseWorker(env, config);
    } catch (e) {
      return await fail(`release fetch failed: ${errMsg(e)}`);
    }

    let settings;
    try {
      settings = await client.getSettings();
    } catch (e) {
      return await fail(`get settings failed: ${errMsg(e)}`);
    }
    const bindings = filterBindings(settings.bindings, config.bindingTypes);

    let versionId: string;
    try {
      versionId = await client.uploadVersion(
        rel.script,
        bindings,
        settings.compatibility_date,
        settings.compatibility_flags,
      );
    } catch (e) {
      return await fail(`upload version failed: ${errMsg(e)}`);
    }
    await setState(env, { toVersionId: versionId, intendedRelease: rel.tag });

    try {
      await client.deployVersion(versionId, `WorkerOps ${reason} ${rel.tag}`);
    } catch (e) {
      // App is still on the previous version — nothing to revert.
      return await fail(`deploy failed (app unchanged): ${errMsg(e)}`);
    }
    await setState(env, { status: "deployed_unverified", deployedAt: nowIso() });

    // Verification continues in the background and releases the lock when done.
    lockHeld = false;
    ctx.waitUntil(
      verifyAndFinalize(env, config, {
        toVersionId: versionId,
        prevAppVersion,
      }).catch(() => {}),
    );
    return {
      ok: true,
      status: "deployed_unverified",
      toVersion: versionId,
      release: rel.tag,
    };
  } catch (e) {
    if (lockHeld) await releaseLock(env);
    if (e instanceof OpsError) throw e;
    await setState(env, {
      status: "manual_required",
      error: `unexpected: ${errMsg(e)}`,
      finishedAt: nowIso(),
    });
    return { ok: false, status: "manual_required", error: errMsg(e) };
  }
}

/**
 * Run migrations (optional), verify health, and confirm or auto-revert.
 *
 * Propagation-aware: right after a deploy the service binding may still serve
 * the OLD version for a few seconds. Confirming on the first `ok:true` would
 * falsely accept a broken new version (and poison last-good). So we wait until
 * the app reports a version DIFFERENT from the pre-update one before deciding;
 * once the new version is live we confirm on ok / revert on failure.
 */
async function verifyAndFinalize(
  env: Env,
  config: Config,
  opts: { toVersionId: string; prevAppVersion: string | null },
): Promise<void> {
  // Run migrations + confirm — only AFTER the new version is confirmed live.
  // (Running migrate right after deploy could hit the OLD version during
  //  propagation lag and miss a broken migration, same as the health check.)
  const finalize = async (): Promise<void> => {
    if (config.migratePath) {
      const migrated = await runMigrate(env, config);
      if (!migrated) {
        await revertTo(env, config, "migrate failed");
        return;
      }
    }
    await confirm(env, opts.toVersionId);
  };

  try {
    const deadline = Date.now() + config.healthWindowMs;
    let sawOk = false;
    while (Date.now() < deadline) {
      const h = await probeHealth(env, config);
      const newVersionLive =
        h.version !== undefined &&
        opts.prevAppVersion !== null &&
        h.version !== opts.prevAppVersion;
      if (newVersionLive) {
        // The new deployment is the one actually responding — decide now.
        if (h.ok) {
          await finalize();
        } else {
          await revertTo(env, config, "health check failed");
        }
        return;
      }
      if (h.ok) sawOk = true;
      await sleep(config.healthIntervalMs);
    }

    // Window elapsed without observing the new version (same-version reinstall,
    // unknown-version app, or propagation never surfaced it). Proceed only if it
    // stayed healthy; otherwise revert.
    if (opts.prevAppVersion === null || sawOk) {
      await finalize();
    } else {
      await revertTo(env, config, "health check failed (new version not observed)");
    }
  } finally {
    await releaseLock(env);
  }
}

async function confirm(env: Env, toVersionId: string): Promise<void> {
  await setState(env, {
    status: "confirmed",
    confirmedAt: nowIso(),
    finishedAt: nowIso(),
    lastGoodVersionId: toVersionId,
    error: null,
  });
}

/** Roll back to the last-good version via the CF Versions/Deployments API. */
async function revertTo(
  env: Env,
  config: Config,
  reason: string,
): Promise<void> {
  const target = (await getState(env)).lastGoodVersionId;
  if (!target) {
    await setState(env, {
      status: "manual_required",
      error: `${reason}; no last-good version to revert to`,
      finishedAt: nowIso(),
    });
    return;
  }
  try {
    await cf(config, config.revertRetryMax).deployVersion(
      target,
      `WorkerOps revert (${reason})`,
    );
    await setState(env, {
      status: "reverted",
      finishedAt: nowIso(),
      error: reason,
    });
  } catch (e) {
    await setState(env, {
      status: "manual_required",
      error: `${reason}; revert failed: ${errMsg(e)}`,
      finishedAt: nowIso(),
    });
  }
}

/** Manual revert from the Ops API. */
export async function runRevert(env: Env, config: Config): Promise<DeployResult> {
  if (!(await acquireLock(env, config.lockTtlMs))) {
    throw new OpsError(409, "update_in_progress", "An operation is already in progress.");
  }
  try {
    await revertTo(env, config, "manual");
    const st = await getState(env);
    return {
      ok: st.status === "reverted",
      status: st.status,
      error: st.error ?? undefined,
    };
  } finally {
    await releaseLock(env);
  }
}

/** Clears stale locks and finishes any update left in `deployed_unverified`. */
export async function watchdogTick(env: Env, config: Config): Promise<void> {
  await clearStaleLock(env, config.lockTtlMs);
  const st = await getState(env);
  if (st.status !== "deployed_unverified") return;

  // Only act once the verification window should have elapsed.
  const deployedAt = st.deployedAt ? Date.parse(st.deployedAt) : 0;
  if (deployedAt && Date.now() - deployedAt < config.healthWindowMs) return;

  const h = await probeHealth(env, config);
  if (h.ok) {
    await setState(env, {
      status: "confirmed",
      confirmedAt: nowIso(),
      finishedAt: nowIso(),
      lastGoodVersionId: st.toVersionId ?? st.lastGoodVersionId,
      error: null,
    });
  } else {
    await revertTo(env, config, "watchdog: unverified after window");
  }
}
