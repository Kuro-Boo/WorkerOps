import type { Env } from "./types";
import type { Config } from "./config";
import type { SelfChannel } from "./state";
import { filterBindings } from "./bindings";
import { CfClient } from "./cf";
import {
  getSelfState,
  setSelfState,
  appendSelfEvent,
  acquireLock,
  releaseLock,
} from "./state";
import { fetchRetry } from "./retry";
import { isNewer, parseAtomTag, stripV } from "./release-tag";
import { WORKEROPS_VERSION } from "./version";
import { errMsg, nowIso, sleep } from "./util";

/**
 * The guardian updating ITSELF.
 *
 * ⚠ This is the one operation with no in-band recovery. Everything else
 *   WorkerOps does can be undone by WorkerOps; a guardian that replaces itself
 *   with a version that cannot boot takes the recovery console down with it and
 *   leaves only the Cloudflare dashboard. Three things keep that from happening:
 *
 *   1. `stable` is the default channel and takes only non-prerelease releases,
 *      so a release is exercised on the developer's own `develop` instances
 *      before any user's guardian will look at it.
 *   2. After deploying, the OLD isolate — still executing this function —
 *      verifies the new version over the PUBLIC url and redeploys the previous
 *      version if it cannot answer. Deploying a version does not kill in-flight
 *      isolates, so the rollback path runs on code known to work.
 *   3. Self-update is off unless OPS_WORKER_NAME names this very script. A
 *      guardian that cannot name itself never tries to replace itself.
 */

/** How long to wait for the freshly deployed version to answer for itself. */
const VERIFY_WINDOW_MS = 24_000;
const VERIFY_INTERVAL_MS = 3_000;

/**
 * Newest release tag for the channel.
 *
 * `stable` uses the /releases/latest HTML redirect, which excludes prereleases
 * and drafts and — unlike api.github.com — is not rate limited per IP (a
 * Worker's egress IP is shared with every other Cloudflare tenant).
 *
 * `develop` needs prereleases included, which that redirect will not give. The
 * releases atom feed lists every release newest-first and is likewise not rate
 * limited, so it is parsed instead of spending the shared API quota.
 */
async function resolveTag(
  config: Config,
  channel: SelfChannel,
): Promise<string | null> {
  const repo = config.selfReleaseSource;
  const retry = { max: config.retryMax, baseMs: config.retryBaseMs };
  const headers = { "User-Agent": "WorkerOps/1.0" };

  if (channel === "develop") {
    const res = await fetchRetry(
      `https://github.com/${repo}/releases.atom`,
      { headers },
      retry,
    );
    if (!res.ok) return null;
    return parseAtomTag(await res.text());
  }

  const res = await fetchRetry(
    `https://github.com/${repo}/releases/latest`,
    { redirect: "manual", headers },
    retry,
  );
  const located = (res.headers.get("location") || "").split("/releases/tag/")[1];
  const tag = (located || "").split(/[?#]/)[0].trim();
  return /^v\d+\.\d+\.\d+$/.test(tag) ? tag : null;
}

async function downloadAsset(config: Config, tag: string): Promise<string> {
  // Tag-specific URL, never /latest/download — that one's CDN cache can briefly
  // hand back the PREVIOUS release's asset right after a release is published.
  const res = await fetchRetry(
    `https://github.com/${config.selfReleaseSource}/releases/download/${tag}/${config.releaseAsset}`,
    { redirect: "follow", headers: { "User-Agent": "WorkerOps/1.0" } },
    { max: config.retryMax, baseMs: config.retryBaseMs, timeoutMs: 30_000 },
  );
  if (!res.ok) throw new Error(`release asset HTTP ${res.status}`);
  const script = await res.text();
  if (!script || script.length < 10) throw new Error("release asset empty");
  return script;
}

/**
 * Ask the freshly deployed version, over the public URL, whether it is alive.
 *
 * Must NOT go through a service binding (there is none pointing at ourselves)
 * and must not be a local call — the whole point is to exercise the code that
 * is now actually serving. Returns true once it reports the expected version,
 * or if it stayed answerable for the whole window (propagation can keep the old
 * version responding, exactly as it does for the app).
 */
async function verifyNewVersion(
  origin: string,
  config: Config,
  expectVersion: string,
): Promise<{ ok: boolean; detail: string }> {
  const url = `${origin}${config.opsPath}/api/v1/health`;
  const deadline = Date.now() + VERIFY_WINDOW_MS;
  let answered = 0;
  let lastSeen = "";
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "WorkerOps/1.0", "cache-control": "no-cache" },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          version?: string;
        };
        if (body?.ok === true) {
          answered++;
          lastSeen = body.version || "";
          if (stripV(lastSeen) === stripV(expectVersion)) {
            return { ok: true, detail: `new version answering (${lastSeen})` };
          }
        } else {
          lastError = "health reported not ok";
        }
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastError = errMsg(e);
    }
    await sleep(VERIFY_INTERVAL_MS);
  }
  if (answered > 0) {
    return {
      ok: true,
      detail: `stayed answerable for the whole window (still reporting ${lastSeen || "unknown"})`,
    };
  }
  return { ok: false, detail: lastError };
}

const ORIGINS_KEY = "workerops:origins";
const ORIGINS_CAP = 8;
let knownOrigins: Set<string> | null = null;

/**
 * Remember the hosts this guardian is reached on (one KV read per isolate,
 * a write only when a host is new). The self-update chooses among them.
 */
export async function rememberOrigin(env: Env, origin: string): Promise<void> {
  if (knownOrigins?.has(origin)) return;
  const stored = await readOrigins(env);
  knownOrigins = new Set(stored);
  if (knownOrigins.has(origin)) return;
  const next = [origin, ...stored].slice(0, ORIGINS_CAP);
  knownOrigins = new Set(next);
  await env.WORKEROPS_STATE.put(ORIGINS_KEY, JSON.stringify(next));
}

async function readOrigins(env: Env): Promise<string[]> {
  try {
    const v = JSON.parse((await env.WORKEROPS_STATE.get(ORIGINS_KEY)) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The first host on which the RUNNING version answers as itself, or null. */
export async function pickVerifyOrigin(
  env: Env,
  config: Config,
  origin: string,
): Promise<string | null> {
  const candidates = [...new Set([origin, ...(await readOrigins(env))])];
  for (const c of candidates) {
    try {
      const res = await fetch(`${c}${config.opsPath}/api/v1/health`, {
        headers: { "User-Agent": "WorkerOps/1.0", "cache-control": "no-cache" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const body = (await res.json().catch(() => ({}))) as {
        service?: string;
        version?: string;
      };
      if (
        body.service === "workerops" &&
        stripV(body.version ?? "") === stripV(WORKEROPS_VERSION)
      )
        return c;
    } catch {
      /* try the next host */
    }
  }
  return null;
}

/** Per-isolate gate so the KV throttle is read at most once per interval. */
let nextLocalCheckAt = 0;

/**
 * Check for a newer WorkerOps release and install it. Safe to call on every
 * request: it returns immediately unless the interval has elapsed.
 *
 * `origin` is this guardian's own public origin, taken from the request — the
 * verification step needs a real URL, and a Worker has no way to learn its own
 * hostname otherwise.
 */
export async function selfUpdateTick(
  env: Env,
  config: Config,
  origin: string,
): Promise<void> {
  if (!config.selfUpdateEnabled || !config.token || !config.accountId) return;
  if (Date.now() < nextLocalCheckAt) return;
  nextLocalCheckAt = Date.now() + Math.min(config.selfUpdateIntervalMs, 900_000);

  const state = await getSelfState(env);
  // ±10% jitter on the window. Each install's window is anchored to its own
  // last check so they drift apart on their own, but a batch of guardians
  // created together (an installer rollout) would start out synchronized and
  // keep hitting github.com in lockstep. Cheap insurance against that.
  const window =
    config.selfUpdateIntervalMs * (0.9 + Math.random() * 0.2);
  if (Date.now() - state.lastCheckAt < window) return;

  // Never race an app update: both lifecycles redeploy Workers through the same
  // account, and a self-update mid-app-update would swap out the very code that
  // is verifying the app.
  if (!(await acquireLock(env, config.lockTtlMs))) return;
  await runSelfUpdate(env, config, origin, state);
}

/** Minimum gap between checks the owner asks for (protects the GitHub quota). */
export const SELF_CHECK_MIN_GAP_MS = 60_000;

export type SelfCheckOutcome =
  | "up_to_date"
  | "updated"
  | "rolled_back"
  | "failed";

export type SelfCheckResult =
  | { ok: false; error: "self_update_disabled" | "too_soon" | "busy" }
  | {
      ok: true;
      before: string;
      channel: SelfChannel;
      found: string | null;
      outcome: SelfCheckOutcome;
    };

/**
 * Check now, without waiting for the 3-hour window (POST /api/v1/self/check).
 *
 * For an urgent fix: it only brings the check forward. What gets installed is
 * exactly what the tick would install — a strictly newer release on this
 * guardian's channel — through the same three safeguards. A guardian whose
 * owner switched self-update off (or that cannot name itself) does nothing.
 */
export async function selfCheckNow(
  env: Env,
  config: Config,
  origin: string,
): Promise<SelfCheckResult> {
  if (!config.selfUpdateEnabled || !config.token || !config.accountId) {
    return { ok: false, error: "self_update_disabled" };
  }
  const state = await getSelfState(env);
  if (Date.now() - state.lastCheckAt < SELF_CHECK_MIN_GAP_MS) {
    return { ok: false, error: "too_soon" };
  }
  if (!(await acquireLock(env, config.lockTtlMs))) {
    return { ok: false, error: "busy" };
  }
  const found = await runSelfUpdate(env, config, origin, state);
  const after = await getSelfState(env);
  const outcome: SelfCheckOutcome = !found
    ? "up_to_date"
    : after.status === "updated"
      ? "updated"
      : after.status === "rolled_back"
        ? "rolled_back"
        : "failed";
  return {
    ok: true,
    before: WORKEROPS_VERSION,
    channel: state.channel,
    found,
    outcome,
  };
}

/**
 * The check and the replacement. The caller holds the lock; it is released
 * here. Returns the newer tag that was attempted, or null when there was none.
 */
async function runSelfUpdate(
  env: Env,
  config: Config,
  origin: string,
  state: Awaited<ReturnType<typeof getSelfState>>,
): Promise<string | null> {
  let attempted: string | null = null;
  try {
    await setSelfState(env, { lastCheckAt: Date.now() });

    const tag = await resolveTag(config, state.channel);
    if (!tag) return null;
    if (!isNewer(tag, WORKEROPS_VERSION)) return null;
    attempted = tag;

    await setSelfState(env, {
      status: "updating",
      targetTag: tag,
      error: null,
      events: [],
    });
    await appendSelfEvent(
      env,
      "self_found",
      "ok",
      `${WORKEROPS_VERSION} → ${tag} (${state.channel})`,
    );

    // Pick the URL the new version will be verified through BEFORE deploying.
    // Only a host that reaches this guardian from inside works: a Custom Domain
    // or workers.dev does, a Route does not (a same-zone fetch to a Route goes
    // to the origin — on 2026-10-12 that turned a good update into a 522 and a
    // rollback). The current version must answer as itself there.
    const verifyOrigin = await pickVerifyOrigin(env, config, origin);
    if (!verifyOrigin) {
      await appendSelfEvent(
        env,
        "self_verify_origin",
        "fail",
        "no known host reaches this guardian from inside",
      );
      await setSelfState(env, {
        status: "failed",
        error: "no host to verify the new version through (routes cannot be fetched from the same zone)",
      });
      return attempted;
    }
    await appendSelfEvent(env, "self_verify_origin", "ok", verifyOrigin);

    const client = new CfClient(
      config.token,
      config.accountId,
      config.opsWorkerName,
      { max: config.retryMax, baseMs: config.retryBaseMs },
    );

    const fromVersionId = await client.getActiveVersionId();
    await appendSelfEvent(
      env,
      "self_read_active",
      "ok",
      fromVersionId ?? "unknown",
    );

    await appendSelfEvent(env, "self_fetch", "run", tag);
    const script = await downloadAsset(config, tag);
    await appendSelfEvent(env, "self_fetch", "ok", `${script.length} bytes`);

    const settings = await client.getSettings();
    const bindings = filterBindings(settings.bindings, config.bindingTypes);
    await appendSelfEvent(
      env,
      "self_read_settings",
      "ok",
      `${bindings.length} bindings carried over`,
    );

    await appendSelfEvent(env, "self_upload", "run");
    const toVersionId = await client.uploadVersion(
      script,
      bindings,
      settings.compatibility_date,
      settings.compatibility_flags,
    );
    await appendSelfEvent(env, "self_upload", "ok", toVersionId);

    await setSelfState(env, {
      fromVersionId,
      toVersionId,
      lastGoodVersionId: fromVersionId ?? state.lastGoodVersionId,
    });

    await appendSelfEvent(env, "self_deploy", "run", toVersionId);
    await client.deployVersion(toVersionId, `WorkerOps self-update ${tag}`);
    await appendSelfEvent(env, "self_deploy", "ok", tag);

    // From here on the NEW code is serving. This isolate is still running the
    // OLD code, which is the only thing that can put the previous version back.
    await appendSelfEvent(env, "self_verify", "run", `${verifyOrigin}${config.opsPath}`);
    const verdict = await verifyNewVersion(verifyOrigin, config, tag);
    if (verdict.ok) {
      await appendSelfEvent(env, "self_verify", "ok", verdict.detail);
      await setSelfState(env, {
        status: "updated",
        lastGoodVersionId: toVersionId,
        lastUpdateAt: nowIso(),
        updateCount: state.updateCount + 1,
        error: null,
      });
      return attempted;
    }

    await appendSelfEvent(env, "self_verify", "fail", verdict.detail);
    if (!fromVersionId) {
      await appendSelfEvent(
        env,
        "self_rollback",
        "fail",
        "no previous version id recorded",
      );
      await setSelfState(env, {
        status: "failed",
        error: `self-update unverified and no version to roll back to: ${verdict.detail}`,
      });
      return attempted;
    }
    await appendSelfEvent(env, "self_rollback", "run", fromVersionId);
    await new CfClient(config.token, config.accountId, config.opsWorkerName, {
      max: config.revertRetryMax,
      baseMs: config.retryBaseMs,
    }).deployVersion(fromVersionId, "WorkerOps self-update rollback");
    await appendSelfEvent(env, "self_rollback", "ok", fromVersionId);
    await setSelfState(env, {
      status: "rolled_back",
      rollbackCount: state.rollbackCount + 1,
      error: verdict.detail,
    });
  } catch (e) {
    await appendSelfEvent(env, "self_error", "fail", errMsg(e));
    await setSelfState(env, { status: "failed", error: errMsg(e) });
  } finally {
    await releaseLock(env);
  }
  return attempted;
}
