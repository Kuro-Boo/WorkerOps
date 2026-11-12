/**
 * The app asks to change some of its own settings values (2026-11-12, the owner's decision: one path puts
 * out the app's versions — the guardian's). KuroCMS used to PUT its own script to switch sending mail from
 * its own domain; that upload carried no placement and moved the app away from its D1 until the next daily
 * check (placement.ts). Here the guardian puts out the code serving now with the changed bindings, next to
 * the D1, and keeps it as the last good code (as placement.ts and assets.ts do).
 *
 * Only plain text values and send_email may be added or removed: the app must not widen what it can reach
 * through its guardian (a D1, a bucket or a service is set by whoever installs the app).
 */
import type { Env } from "./types";
import type { Config } from "./config";
import { CfClient, parseCode } from "./cf";
import { acquireLock, appendEvent, getState, releaseLock, setState } from "./state";
import { filterBindings } from "./bindings";
import { keepGoodCode, servingCode } from "./assets";
import { appD1Location } from "./placement-map";

export const REBIND_TYPES = new Set(["plain_text", "send_email"]);

export interface RebindChanges {
  /** Names to take away. Each must be a plain text value or a send_email binding. */
  remove?: string[];
  /** Bindings to put in (replacing one of the same name). Only plain_text and send_email. */
  add?: Array<{ type: string; name: string; [k: string]: unknown }>;
}

export type RebindResult =
  | { ok: true; status: "rebound"; versionId: string }
  | { ok: false; status: "busy" | "invalid" | "failed"; error: string };

export type RebindClient = Pick<CfClient, "getSettings" | "uploadModules" | "deployVersion"> & {
  serving: () => ReturnType<typeof parseCode>;
};

const defaultClient = (config: Config): RebindClient => {
  const cf = new CfClient(config.token, config.accountId, config.appWorkerName, { max: config.retryMax, baseMs: config.retryBaseMs });
  return {
    getSettings: (region, appD1) => cf.getSettings(region, appD1),
    uploadModules: (...args) => cf.uploadModules(...args),
    deployVersion: (id, message) => cf.deployVersion(id, message),
    serving: async () => parseCode(await servingCode(cf)),
  };
};

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const updating = (status: string) => status !== "idle" && status !== "confirmed";
const typeOf = (b: unknown) => (b as { type?: string })?.type;
const nameOf = (b: unknown) => (b as { name?: string })?.name;

/** Checks the request and applies it to the bindings read now. Pure: tested alone. */
export function applyRebind(current: unknown[], changes: RebindChanges): { bindings: unknown[] } | { error: string } {
  const remove = changes.remove ?? [];
  const add = changes.add ?? [];
  if (!Array.isArray(remove) || !Array.isArray(add) || (remove.length === 0 && add.length === 0)) return { error: "nothing to change" };
  for (const name of [...remove, ...add.map((b) => b?.name)]) {
    if (typeof name !== "string" || !NAME.test(name)) return { error: `bad name: ${String(name)}` };
  }
  for (const b of add) {
    if (!REBIND_TYPES.has(b.type)) return { error: `${b.name}: ${b.type} cannot be set by the app` };
  }
  // A name already used by another kind of binding (a secret, a D1 …) stays as it is.
  const touched = new Set([...remove, ...add.map((b) => b.name)]);
  for (const b of current) {
    const name = nameOf(b);
    const type = typeOf(b);
    if (name && touched.has(name) && type && !REBIND_TYPES.has(type)) return { error: `${name} is a ${type} binding` };
  }
  return { bindings: [...current.filter((b) => !touched.has(nameOf(b) ?? "")), ...add] };
}

export async function rebindApp(
  env: Env, config: Config, changes: RebindChanges, client: (config: Config) => RebindClient = defaultClient,
): Promise<RebindResult> {
  if (!config.token || !config.accountId || !config.appWorkerName) return { ok: false, status: "failed", error: "cf_config_missing" };
  if (updating((await getState(env)).status)) return { ok: false, status: "busy", error: "an update is being checked" };
  const lock = await acquireLock(env, config.lockTtlMs);
  if (!lock) return { ok: false, status: "busy", error: "update_in_progress" };
  try {
    if (updating((await getState(env)).status)) return { ok: false, status: "busy", error: "an update is being checked" };
    const cf = client(config);
    const settings = await cf.getSettings(undefined, () => appD1Location(env));
    const next = applyRebind(filterBindings(settings.bindings, config.bindingTypes), changes);
    if ("error" in next) return { ok: false, status: "invalid", error: next.error };
    const versionId = await cf.uploadModules(
      await cf.serving(),
      next.bindings,
      settings.compatibility_date,
      settings.compatibility_flags,
      undefined,
      settings.placement,
    );
    const what = [...(changes.add ?? []).map((b) => `+${b.name}`), ...(changes.remove ?? []).map((n) => `-${n}`)].join(" ");
    await cf.deployVersion(versionId, `WorkerOps settings ${what}`);
    await appendEvent(env, "rebind", "ok", what);
    // The same code as the last good one, so a revert should land on this version (as in assets.ts).
    await setState(env, { lastGoodVersionId: versionId });
    await keepGoodCode(env, config, versionId);
    return { ok: true, status: "rebound", versionId };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await appendEvent(env, "rebind", "fail", error).catch(() => {});
    return { ok: false, status: "failed", error };
  } finally {
    await releaseLock(env, lock);
  }
}
