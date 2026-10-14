/**
 * Owner-driven updates from the distribution endpoint (PRODUCT_ID set).
 *
 *   releaseInfo   which version is offered, and whether it is newer than the one running
 *   applyRelease  fetch a version the owner named, verify it, deploy it (verify → confirm or revert)
 *   setAuto       the owner turns automatic updates on/off (on by default — 2026-10-14)
 *   setChannel    the owner picks the channel: stable, or dev (every published version)
 *   autoUpdateTick  once a day, apply the offered version — unless the owner turned it off
 *
 * Automatic updates are on by default so that a fix reaches owners who never
 * open the console (2026-10-14, the operator's decision). Nothing is pushed in:
 * this guardian pulls, verifies the signature, and reverts if the new version
 * fails its health check. An owner who switched it off stays off.
 *
 * "Is there a newer version?" is never answered with "you are up to date" when
 * the lookup itself failed: `checkOk: false` is returned instead, so the console
 * can say it could not check.
 */
import type { Env } from "./types";
import type { Config, ReleaseChannel } from "./config";
import { channelPointer, fetchDistRelease, type Pointer } from "./dist-release";
import { compareVersion, currentReleaseVersion, deploySignedRelease } from "./signed-release";
import { probeHealth } from "./health";
import { errMsg, nowIso, OpsError } from "./util";

const AUTO_KEY = "workerops:release:auto";
const AUTO_BY_KEY = "workerops:release:auto_set";
const CHANNEL_KEY = "workerops:release:channel";
const LAST_AUTO_CHECK_KEY = "workerops:release:last_auto_check";
const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface ReleaseInfo {
  productId: string;
  channel: string;
  current: string | null;
  offered: Pointer | null;
  newer: boolean;
  auto: boolean;
  checkOk: boolean;
  checkedAt: string;
  error?: string;
}

async function runningVersion(env: Env, config: Config): Promise<string | null> {
  const recorded = await currentReleaseVersion(env);
  if (recorded) return recorded;
  // Installed by the installer and never updated through here yet: ask the app.
  const health = await probeHealth(env, config).catch(() => null);
  return health?.version && VERSION_RE.test(health.version) ? health.version : null;
}

const isChannel = (v: unknown): v is ReleaseChannel => v === "stable" || v === "dev";

/** The owner's choice; the installer's RELEASE_CHANNEL until the owner picks one. */
export async function releaseChannel(env: Env, config: Config): Promise<ReleaseChannel> {
  const chosen = await env.WORKEROPS_STATE.get(CHANNEL_KEY);
  return isChannel(chosen) ? chosen : config.releaseChannel;
}

export async function releaseInfo(env: Env, config: Config): Promise<ReleaseInfo> {
  const [current, auto, channel] = await Promise.all([
    runningVersion(env, config), env.WORKEROPS_STATE.get(AUTO_KEY), releaseChannel(env, config),
  ]);
  // Unset means the owner never chose: on.
  const base = { productId: config.productId, channel, current, auto: auto !== "0", checkedAt: nowIso() };
  try {
    const offered = await channelPointer(env, config, channel);
    const newer = !!offered && (!current || compareVersion(offered.version, current) > 0);
    return { ...base, offered, newer, checkOk: true };
  } catch (error) {
    return { ...base, offered: null, newer: false, checkOk: false, error: errMsg(error) };
  }
}

/** Apply the version the owner named. Without a name, the offered version (what the console showed). */
export async function applyRelease(
  env: Env, ctx: ExecutionContext, config: Config, version?: string, reinstall = false,
): Promise<Response> {
  let target = version;
  if (!target) {
    if (reinstall) target = (await runningVersion(env, config)) ?? undefined;
    else target = (await channelPointer(env, config, await releaseChannel(env, config)))?.version;
  }
  if (!target || !VERSION_RE.test(target)) {
    throw new OpsError(409, "no_release", "No release is offered for this product.");
  }
  const release = await fetchDistRelease(env, config, target);
  if (reinstall) await env.WORKEROPS_STATE.delete("workerops:release:version");
  return deploySignedRelease(env, ctx, config, release);
}

export async function setAuto(env: Env, enabled: boolean): Promise<{ auto: boolean }> {
  await env.WORKEROPS_STATE.put(AUTO_KEY, enabled ? "1" : "0");
  // Keep a record that the owner made this choice (the token holder), and when.
  await env.WORKEROPS_STATE.put(AUTO_BY_KEY, JSON.stringify({ enabled, at: nowIso(), by: "owner" }));
  return { auto: enabled };
}

export async function setChannel(env: Env, channel: unknown): Promise<{ channel: ReleaseChannel }> {
  if (!isChannel(channel)) throw new OpsError(400, "bad_channel", 'channel must be "stable" or "dev".');
  await env.WORKEROPS_STATE.put(CHANNEL_KEY, channel);
  await env.WORKEROPS_STATE.put(`${CHANNEL_KEY}_set`, JSON.stringify({ channel, at: nowIso(), by: "owner" }));
  return { channel };
}

/** Called from `scheduled`. Does nothing if the owner switched automatic updates off. */
export async function autoUpdateTick(env: Env, ctx: ExecutionContext, config: Config): Promise<void> {
  if (!config.productId) return;
  if ((await env.WORKEROPS_STATE.get(AUTO_KEY)) === "0") return;
  const last = Number((await env.WORKEROPS_STATE.get(LAST_AUTO_CHECK_KEY)) ?? "0");
  if (Date.now() - last < DAY_MS) return;
  // Record the attempt before any network call, so a failing lookup is not retried every tick.
  await env.WORKEROPS_STATE.put(LAST_AUTO_CHECK_KEY, String(Date.now()));
  const info = await releaseInfo(env, config);
  if (!info.checkOk || !info.newer || !info.offered) return;
  await applyRelease(env, ctx, config, info.offered.version);
}
