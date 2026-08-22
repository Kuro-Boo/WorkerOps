import type { Env } from "./types";
import type { Config } from "./config";
import { filterBindings } from "./bindings";
import { CfClient } from "./cf";
import {
  getState,
  setState,
  acquireLock,
  releaseLock,
  clearStaleLock,
  startJournal,
  appendEvent,
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


async function fetchReleaseWorker(
  env: Env,
  config: Config,
): Promise<{ tag: string; script: string }> {
  const repo = config.releaseSource;
  if (!repo) throw new Error("RELEASE_SOURCE is not configured");
  const retry = { max: config.retryMax, baseMs: config.retryBaseMs };

  // Private repositories cannot use the unauthenticated path below: both the
  // /releases/latest redirect and /releases/download/... return 404 without
  // credentials. When GITHUB_TOKEN is set we therefore go through the API.
  //
  // This does NOT reintroduce the rate-limit problem the comment below
  // describes. That problem is specific to UNAUTHENTICATED API calls, which
  // are capped per shared Cloudflare egress IP. An authenticated call is
  // capped at 5,000/hour PER TOKEN, so it neither competes with other tenants
  // nor with other installs. Public installs (no token) keep the existing
  // path unchanged.
  if (config.githubToken) {
    return fetchReleaseWorkerViaApi(repo, config, retry);
  }

  // Resolve the release tag WITHOUT the GitHub API.
  //
  // ⚠ Do not use api.github.com here. Unauthenticated it is capped at 60
  //   requests/hour PER IP, and a Worker's egress IP is one of Cloudflare's
  //   shared addresses — so the quota is routinely already exhausted by other
  //   tenants and the call returns 403 regardless of our own usage (observed
  //   2026-08 on a fresh account: KuroCMS self-update failed with
  //   "API rate limit exceeded for <CF IP>"). We would also be spending a
  //   shared resource that every other WorkerOps/KuroCMS install competes for.
  //
  // The HTML endpoint /releases/latest 302-redirects to /releases/tag/vX.Y.Z
  // and is NOT rate-limited, with the same semantics as the API's
  // /releases/latest (newest non-prerelease, non-draft release).
  let tag = "latest";
  try {
    const r = await fetchRetry(
      `https://github.com/${repo}/releases/latest`,
      { redirect: "manual", headers: { "User-Agent": "WorkerOps/1.0" } },
      retry,
    );
    const located = (r.headers.get("location") || "").split(
      "/releases/tag/",
    )[1];
    const candidate = (located || "").split(/[?#]/)[0].trim();
    if (/^v\d+\.\d+\.\d+$/.test(candidate)) tag = candidate;
  } catch {
    /* tag is best-effort — falls back to /releases/latest/download below */
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
 * Private-repo release fetch (GitHub API).
 *
 * Two calls: resolve the tag, then download the asset by id. The asset must be
 * pulled from /releases/assets/{id} with Accept: application/octet-stream —
 * browser_download_url is not usable with a token on private repos.
 */
async function fetchReleaseWorkerViaApi(
  repo: string,
  config: Config,
  retry: { max: number; baseMs: number },
): Promise<{ tag: string; script: string }> {
  const headers = {
    Authorization: `Bearer ${config.githubToken}`,
    "User-Agent": "WorkerOps/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const relRes = await fetchRetry(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { headers: { ...headers, Accept: "application/vnd.github+json" } },
    retry,
  );
  if (!relRes.ok) throw new Error(`release lookup HTTP ${relRes.status}`);
  const rel = (await relRes.json()) as {
    tag_name?: string;
    assets?: { id: number; name: string }[];
  };
  const tag = /^v\d+\.\d+\.\d+$/.test(rel.tag_name || "")
    ? (rel.tag_name as string)
    : "latest";

  const asset = (rel.assets || []).find((a) => a.name === config.releaseAsset);
  if (!asset) throw new Error(`release asset ${config.releaseAsset} not found`);

  const res = await fetchRetry(
    `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`,
    {
      redirect: "follow",
      headers: { ...headers, Accept: "application/octet-stream" },
    },
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
    await appendEvent(env, "aborted", "fail", error);
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
    await startJournal(env, reason);
    await appendEvent(env, "start", "ok", `operation: ${reason}`);
    await appendEvent(env, "read_active", "run");
    const fromVersion = await client.getActiveVersionId();
    await appendEvent(env, "read_active", "ok", fromVersion ?? "unknown");
    // Anchor for propagation-aware verification: the version the app reports now.
    await appendEvent(env, "probe_before", "run");
    const prevAppVersion = (await probeHealth(env, config)).version ?? null;
    await appendEvent(env, "probe_before", "ok", prevAppVersion ?? "unknown");
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
    await appendEvent(env, "fetch_release", "run", config.releaseSource);
    try {
      rel = await fetchReleaseWorker(env, config);
      await appendEvent(
        env,
        "fetch_release",
        "ok",
        `${rel.tag} (${rel.script.length} bytes)`,
      );
    } catch (e) {
      return await fail(`release fetch failed: ${errMsg(e)}`);
    }

    let settings;
    await appendEvent(env, "read_settings", "run");
    try {
      settings = await client.getSettings();
    } catch (e) {
      return await fail(`get settings failed: ${errMsg(e)}`);
    }
    const bindings = filterBindings(settings.bindings, config.bindingTypes);
    await appendEvent(
      env,
      "read_settings",
      "ok",
      `${bindings.length} bindings carried over`,
    );

    let versionId: string;
    await appendEvent(env, "upload_version", "run");
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
    await appendEvent(env, "upload_version", "ok", versionId);
    await setState(env, { toVersionId: versionId, intendedRelease: rel.tag });

    await appendEvent(env, "deploy_version", "run", versionId);
    try {
      await client.deployVersion(versionId, `WorkerOps ${reason} ${rel.tag}`);
    } catch (e) {
      // App is still on the previous version — nothing to revert.
      return await fail(`deploy failed (app unchanged): ${errMsg(e)}`);
    }
    await appendEvent(env, "deploy_version", "ok", rel.tag);
    await setState(env, { status: "deployed_unverified", deployedAt: nowIso() });
    await appendEvent(
      env,
      "verify",
      "run",
      `health window ${config.healthWindowMs}ms`,
    );

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
      await appendEvent(env, "migrate", "run", config.migratePath);
      const migrated = await runMigrate(env, config);
      if (!migrated) {
        await appendEvent(env, "migrate", "fail");
        await revertTo(env, config, "migrate failed", true);
        return;
      }
      await appendEvent(env, "migrate", "ok");
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
          await appendEvent(env, "verify", "ok", `app reports ${h.version}`);
          await finalize();
        } else {
          await appendEvent(
            env,
            "verify",
            "fail",
            `app reports ${h.version} but health is not ok (HTTP ${h.status})`,
          );
          await revertTo(env, config, "health check failed", true);
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
      await appendEvent(
        env,
        "verify",
        "ok",
        "window elapsed while healthy (new version never distinguished)",
      );
      await finalize();
    } else {
      await appendEvent(env, "verify", "fail", "never became healthy in window");
      await revertTo(
        env,
        config,
        "health check failed (new version not observed)",
        true,
      );
    }
  } finally {
    await releaseLock(env);
  }
}

async function confirm(env: Env, toVersionId: string): Promise<void> {
  await appendEvent(env, "confirm", "ok", toVersionId);
  await setState(env, {
    status: "confirmed",
    confirmedAt: nowIso(),
    finishedAt: nowIso(),
    lastGoodVersionId: toVersionId,
    error: null,
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
    await cf(config, config.revertRetryMax).deployVersion(
      target,
      `WorkerOps revert (${reason})`,
    );
    await appendEvent(env, auto ? "auto_revert" : "revert", "ok", target);
    await setState(env, {
      status: "reverted",
      finishedAt: nowIso(),
      error: reason,
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
  if (!(await acquireLock(env, config.lockTtlMs))) {
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
    await appendEvent(
      env,
      "watchdog",
      "ok",
      "unverified deploy found healthy after the window",
    );
    await setState(env, {
      status: "confirmed",
      confirmedAt: nowIso(),
      finishedAt: nowIso(),
      lastGoodVersionId: st.toVersionId ?? st.lastGoodVersionId,
      error: null,
    });
  } else {
    await appendEvent(
      env,
      "watchdog",
      "fail",
      `still unhealthy after the window (HTTP ${h.status})`,
    );
    await revertTo(env, config, "watchdog: unverified after window", true);
  }
}
