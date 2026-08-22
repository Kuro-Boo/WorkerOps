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

const stripV = (s: string): string => s.replace(/^v/, "").trim();

/** true when `a` is a strictly higher semver than `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = stripV(a).split(".").map(Number);
  const pb = stripV(b).split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

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
    const xml = await res.text();
    // <id>tag:github.com,2008:Repository/{repoId}/{tag}</id>, newest first.
    const m = xml.match(
      new RegExp("<id>tag:github\\.com,2008:Repository/\\d+/([^<]+)</id>"),
    );
    const tag = (m?.[1] || "").trim();
    return /^v\d+\.\d+\.\d+/.test(tag) ? tag : null;
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
  if (Date.now() - state.lastCheckAt < config.selfUpdateIntervalMs) return;

  // Never race an app update: both lifecycles redeploy Workers through the same
  // account, and a self-update mid-app-update would swap out the very code that
  // is verifying the app.
  if (!(await acquireLock(env, config.lockTtlMs))) return;
  try {
    await setSelfState(env, { lastCheckAt: Date.now() });

    const tag = await resolveTag(config, state.channel);
    if (!tag) return;
    if (!isNewer(tag, WORKEROPS_VERSION)) return;

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
    await appendSelfEvent(env, "self_verify", "run", `${origin}${config.opsPath}`);
    const verdict = await verifyNewVersion(origin, config, tag);
    if (verdict.ok) {
      await appendSelfEvent(env, "self_verify", "ok", verdict.detail);
      await setSelfState(env, {
        status: "updated",
        lastGoodVersionId: toVersionId,
        lastUpdateAt: nowIso(),
        updateCount: state.updateCount + 1,
        error: null,
      });
      return;
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
      return;
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
}
