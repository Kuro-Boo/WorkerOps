/**
 * Owner-driven updates from the distribution endpoint (PRODUCT_ID set).
 *
 *   releaseInfo   which version is offered, and whether it is newer than the one running
 *   applyRelease  fetch a version the owner named, verify it, deploy it (verify → confirm or revert)
 *   setAuto       the owner turns automatic updates on/off (on by default — 2026-10-14)
 *   setChannel    the owner picks the channel: stable, or dev (every published version)
 *   (an app whose admin screen holds these choices declares them in its health
 *    response — `update_policy` — and then they are chosen there, not here)
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
import { compareVersion, currentReleaseVersion, deploySignedRelease, failedKey } from "./signed-release";
import { probeHealth } from "./health";
import { errMsg, nowIso, OpsError } from "./util";

const AUTO_KEY = "workerops:release:auto";
const AUTO_BY_KEY = "workerops:release:auto_set";
const CHANNEL_KEY = "workerops:release:channel";
/**
 * The daily gate. Entamy's concierge (CoreSystem/concierge) deletes this key to make the next tick
 * look right away (an urgent fix for managed installs) — the name is a contract: do not rename it.
 */
export const LAST_AUTO_CHECK_KEY = "workerops:release:last_auto_check";
const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface ReleaseInfo {
  productId: string;
  channel: string;
  current: string | null;
  offered: Pointer | null;
  newer: boolean;
  auto: boolean;
  /** "app" when the app's own admin screen holds the owner's choices (health `update_policy`). */
  managedBy: "app" | "guardian";
  checkOk: boolean;
  checkedAt: string;
  error?: string;
}

/**
 * What the app declares in its health response: its product id at the
 * distribution endpoint, and the owner's update choices when the app's own admin
 * screen holds them. Lets a guardian installed before PRODUCT_ID existed follow
 * the distribution endpoint without anyone touching its settings. Cached briefly
 * per isolate (the console polls status every few seconds).
 */
type Declaration = { productId?: string; policy?: { auto?: boolean; channel?: ReleaseChannel }; version?: string };
let declared: { at: number; value: Declaration } | null = null;
export async function appDeclaration(env: Env, config: Config, fresh = false): Promise<Declaration> {
  if (!fresh && declared && Date.now() - declared.at < 60_000) return declared.value;
  const h = await probeHealth(env, config).catch(() => null);
  const value: Declaration = h ? { productId: h.productId, policy: h.policy, version: h.version } : {};
  if (h && h.status) declared = { at: Date.now(), value };
  return value;
}

/** PRODUCT_ID from the settings, or else the one the app declares. */
export async function resolveConfig(env: Env, config: Config): Promise<Config> {
  if (config.productId) return config;
  const d = await appDeclaration(env, config);
  return d.productId ? { ...config, productId: d.productId } : config;
}

async function runningVersion(env: Env, config: Config): Promise<string | null> {
  // The app's own report first: it may have updated itself since we last deployed.
  const health = await probeHealth(env, config).catch(() => null);
  if (health?.version && VERSION_RE.test(health.version)) return health.version;
  return currentReleaseVersion(env);
}

const isChannel = (v: unknown): v is ReleaseChannel => v === "stable" || v === "dev";

/** The app's declared choice; else the owner's choice here; else the installer's RELEASE_CHANNEL. */
export async function releaseChannel(env: Env, config: Config): Promise<ReleaseChannel> {
  const fromApp = (await appDeclaration(env, config)).policy?.channel;
  if (fromApp) return fromApp;
  const chosen = await env.WORKEROPS_STATE.get(CHANNEL_KEY);
  return isChannel(chosen) ? chosen : config.releaseChannel;
}

/** The app's declared choice; else the owner's choice here; unset means on. */
async function autoEnabled(env: Env, config: Config): Promise<boolean> {
  const fromApp = (await appDeclaration(env, config)).policy?.auto;
  if (fromApp !== undefined) return fromApp;
  return (await env.WORKEROPS_STATE.get(AUTO_KEY)) !== "0";
}

export async function releaseInfo(env: Env, config: Config): Promise<ReleaseInfo> {
  const [current, auto, channel, decl] = await Promise.all([
    runningVersion(env, config), autoEnabled(env, config), releaseChannel(env, config), appDeclaration(env, config),
  ]);
  const managedBy = decl.policy ? "app" as const : "guardian" as const;
  const base = { productId: config.productId, channel, current, auto, managedBy, checkedAt: nowIso() };
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
  return deploySignedRelease(env, ctx, config, release, reinstall);
}

/** The app's admin screen holds the choice: changing it here would be overridden on the next look. */
async function refuseIfApp(env: Env, config: Config, field: "auto" | "channel"): Promise<void> {
  if ((await appDeclaration(env, config, true)).policy?.[field] !== undefined) {
    throw new OpsError(409, "managed_by_app", "This setting is chosen in the app's own admin screen.");
  }
}

export async function setAuto(env: Env, config: Config, enabled: boolean): Promise<{ auto: boolean }> {
  await refuseIfApp(env, config, "auto");
  await env.WORKEROPS_STATE.put(AUTO_KEY, enabled ? "1" : "0");
  // Keep a record that the owner made this choice (the token holder), and when.
  await env.WORKEROPS_STATE.put(AUTO_BY_KEY, JSON.stringify({ enabled, at: nowIso(), by: "owner" }));
  return { auto: enabled };
}

export async function setChannel(env: Env, config: Config, channel: unknown): Promise<{ channel: ReleaseChannel }> {
  await refuseIfApp(env, config, "channel");
  if (!isChannel(channel)) throw new OpsError(400, "bad_channel", 'channel must be "stable" or "dev".');
  await env.WORKEROPS_STATE.put(CHANNEL_KEY, channel);
  await env.WORKEROPS_STATE.put(`${CHANNEL_KEY}_set`, JSON.stringify({ channel, at: nowIso(), by: "owner" }));
  return { channel };
}

/** Called from `scheduled`. Does nothing if the owner switched automatic updates off. */
export async function autoUpdateTick(env: Env, ctx: ExecutionContext, loaded: Config): Promise<void> {
  // A store in this account (RELEASE_STORE) is read on every tick: the read stays
  // in the account, and a version a person put there should go out within minutes.
  const store = !!env.RELEASE_STORE;
  if (!store) {
    // The daily gate first: the cron runs every few minutes and must not ask the app each time.
    const last = Number((await env.WORKEROPS_STATE.get(LAST_AUTO_CHECK_KEY)) ?? "0");
    if (Date.now() - last < DAY_MS) return;
    // Record the attempt before any network call, so a failing lookup is not retried every tick.
    await env.WORKEROPS_STATE.put(LAST_AUTO_CHECK_KEY, String(Date.now()));
  }
  const config = await resolveConfig(env, loaded);
  if (!config.productId) return;
  if (!await autoEnabled(env, config)) return;
  const info = await releaseInfo(env, config);
  if (!info.checkOk || !info.newer || !info.offered) return;
  // A store guardian does not try a version again that it already reverted.
  if (store && await env.WORKEROPS_STATE.get(failedKey(info.offered.version))) return;
  await applyRelease(env, ctx, config, info.offered.version);
}
