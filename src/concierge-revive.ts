/**
 * Bring a hosting account's concierge back (2026-10-22). The concierge ticks every guardian in the
 * account once a minute (tick.ts); when it stops, nothing ticks the guardians, so a guardian cannot
 * notice by itself. Entamy's installer, in another account, checks the concierge every few minutes
 * and, when it does not answer, asks one guardian of that account here:
 *
 *   POST {OPS_PATH}/api/v1/concierge/revive      (TICK_TOKEN)
 *
 * The guardian already holds a token that edits this account's Workers (CF_API_TOKEN). It takes the
 * concierge's stable release from the distribution endpoint, checks its signature like any other
 * release, uploads it over the concierge with the concierge's own bindings (secrets are inherited —
 * the guardian never sees them), deploys it, and puts the concierge's minute back.
 *
 * It only ever touches the Worker named CONCIERGE_NAME.
 */
import type { Config } from "./config";
import type { Env } from "./types";
import { CfClient } from "./cf";
import { channelPointer, fetchDistRelease } from "./dist-release";

export const CONCIERGE_NAME = "entamy-concierge";
const CONCIERGE_PRODUCT = "concierge";
const CF_BASE = "https://api.cloudflare.com/client/v4";

/** The concierge's bindings for the new version: secrets are inherited, everything else kept as is. */
export function conciergeBindings(bindings: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const b of bindings ?? []) {
    const t = (b as { type?: string })?.type;
    const name = (b as { name?: string })?.name;
    if (typeof t !== "string" || typeof name !== "string" || !name) continue;
    out.push(t === "secret_text" || t === "inherit" ? { type: "inherit", name } : b);
  }
  return out;
}

export interface ReviveResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export async function reviveConcierge(env: Env, config: Config, doFetch: typeof fetch = fetch): Promise<ReviveResult> {
  try {
    // The concierge comes from the distribution endpoint, never from this guardian's own release store.
    const distEnv = { ...env, RELEASE_STORE: undefined } as Env;
    const distConfig = { ...config, productId: CONCIERGE_PRODUCT };
    const pointer = await channelPointer(distEnv, distConfig, "stable");
    if (!pointer) return { ok: false, error: "no stable concierge release" };
    const release = await fetchDistRelease(distEnv, distConfig, pointer.version);

    const cf = new CfClient(config.token, config.accountId, CONCIERGE_NAME, { max: 2, baseMs: config.retryBaseMs });
    const settings = await cf.getSettings();
    if (!settings.bindings.length) return { ok: false, error: "concierge has no bindings (place it from the vault)" };
    const flags = [...new Set([...settings.compatibility_flags, "global_fetch_strictly_public"])];
    const versionId = await cf.uploadVersion(release.worker, conciergeBindings(settings.bindings), settings.compatibility_date, flags, "none");
    await cf.deployVersion(versionId, `workerops: revive concierge ${pointer.version}`);
    const res = await doFetch(
      `${CF_BASE}/accounts/${config.accountId}/workers/scripts/${CONCIERGE_NAME}/schedules`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify([{ cron: "* * * * *" }]),
      },
    );
    if (!res.ok) return { ok: false, version: pointer.version, error: `schedules: HTTP ${res.status}` };
    return { ok: true, version: pointer.version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "revive failed" };
  }
}
