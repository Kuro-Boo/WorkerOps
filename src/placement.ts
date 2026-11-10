/**
 * Keeps the app next to its D1 (2026-11-11, the owner's decision).
 *
 * The placement is part of each version, and a Worker placed far from its D1 crosses the distance on
 * every query. An update places the version (cf.ts); this also moves apps that have no update coming:
 * once a day the guardian compares where the app runs with where its D1 is, and when they differ puts
 * out the code that is serving now as a new version in the right place. Nothing but the place changes
 * (the same way a page publish in assets.ts puts out the serving code with new assets).
 *
 * Not for a guardian that only stands in front of an app (FOLLOW_SERVING=1): whoever brings that app's
 * versions places them.
 */
import type { Env } from "./types";
import type { Config } from "./config";
import { CfClient, parseCode } from "./cf";
import { acquireLock, appendEvent, getState, releaseLock, setState } from "./state";
import { filterBindings } from "./bindings";
import { keepGoodCode, servingCode } from "./assets";
import { appD1Location } from "./placement-map";

export const PLACEMENT_KEY = "workerops:placement:checked2";
const CHECK_EVERY_S = 24 * 60 * 60;
const RETRY_AFTER_S = 60 * 60;

export type PlacementTick = "off" | "waiting" | "busy" | "no_d1" | "current" | "moved" | "failed";

export type PlacementClient = Pick<CfClient, "getSettings" | "currentPlacement" | "uploadModules" | "deployVersion"> & {
  serving: () => ReturnType<typeof parseCode>;
};

const defaultClient = (config: Config): PlacementClient => {
  const cf = new CfClient(config.token, config.accountId, config.appWorkerName, { max: config.retryMax, baseMs: config.retryBaseMs });
  return {
    getSettings: (region, appD1) => cf.getSettings(region, appD1),
    currentPlacement: (mode) => cf.currentPlacement(mode),
    uploadModules: (...args) => cf.uploadModules(...args),
    deployVersion: (id, message) => cf.deployVersion(id, message),
    serving: async () => parseCode(await servingCode(cf)),
  };
};

const updating = (status: string) => status !== "idle" && status !== "confirmed";

export async function placementTick(
  env: Env, config: Config, client: (config: Config) => PlacementClient = defaultClient,
): Promise<PlacementTick> {
  if (env.FOLLOW_SERVING === "1") return "off";
  if (await env.WORKEROPS_STATE.get(PLACEMENT_KEY)) return "waiting";
  if (updating((await getState(env)).status)) return "busy";
  const checked = (ttl: number) => env.WORKEROPS_STATE.put(PLACEMENT_KEY, "1", { expirationTtl: ttl });

  const lock = await acquireLock(env, config.lockTtlMs);
  if (!lock) return "busy";
  try {
    const st = await getState(env);
    if (updating(st.status)) return "busy";
    const cf = client(config);
    const settings = await cf.getSettings(undefined, () => appD1Location(env));
    if (!settings.fromD1 || !settings.placement) {
      await checked(CHECK_EVERY_S);
      return "no_d1";
    }
    const want = settings.placement;
    const now = await cf.currentPlacement(settings.currentMode);
    if (JSON.stringify(now) === JSON.stringify(want)) {
      await checked(CHECK_EVERY_S);
      return "current";
    }
    const versionId = await cf.uploadModules(
      await cf.serving(),
      filterBindings(settings.bindings, config.bindingTypes),
      settings.compatibility_date,
      settings.compatibility_flags,
      undefined,
      want,
    );
    const where = "region" in want ? want.region : want.mode;
    await cf.deployVersion(versionId, `WorkerOps placement ${where}`);
    await appendEvent(env, "placement", "ok", `next to its D1: ${where}`);
    // The same code as the last-good one, so a revert should land on this version (as in assets.ts).
    await setState(env, { lastGoodVersionId: versionId });
    await keepGoodCode(env, config, versionId);
    await checked(CHECK_EVERY_S);
    return "moved";
  } catch (e) {
    console.warn("placement: could not move the app", config.appWorkerName, e);
    await checked(RETRY_AFTER_S);
    return "failed";
  } finally {
    await releaseLock(env, lock);
  }
}
