import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";
import { loadConfig } from "./config";
import { handleOps, maintenancePage, PAGE_HEADERS } from "./ops";
import { runTick } from "./tick";
import { publishAssets, type AssetFile, type AssetSource, type PublishResult } from "./assets";
import { askedRestart, type AskedRestart } from "./restart";
import { peerHold, peerRelease, peerStatus, type HoldResult, type PeerStatus } from "./peer";
import { applyRelease, LAST_AUTO_CHECK_KEY, resolveConfig } from "./release-ops";
import { rebindApp, type RebindChanges, type RebindResult } from "./rebind";
import { OpsError } from "./util";
import { forApp } from "./trial";

/**
 * The app hands its built pages to the guardian here (assets.ts). Reached only
 * through a service binding that names this entrypoint — it has no URL — so a
 * caller needs no token: only a Worker bound to it on this account can call.
 *
 *   env.WORKEROPS.publish(manifest, read)
 *     manifest  { "/post/index.html": { hash, size, type } }   — {} takes every asset down
 *     read      (hashes) => [{ hash, base64 }]   — a function: RPC hands us a stub
 *               to call back while this call runs
 */
export class WorkerOpsAssets extends WorkerEntrypoint<Env> {
  async publish(
    manifest: Record<string, AssetFile>,
    read: AssetSource["read"],
    options?: { config?: Record<string, unknown> },
  ): Promise<PublishResult> {
    return publishAssets(this.env, loadConfig(this.env), manifest, { read: (h) => read(h) }, options ?? {});
  }

  /** The app updating the guardian (peer.ts): which version answers, and whether it is busy. */
  async status(): Promise<PeerStatus> {
    return peerStatus(this.env, loadConfig(this.env));
  }

  /** Take the guardian's lock while the app replaces the guardian (peer.ts). */
  async hold(ttlMs?: number): Promise<HoldResult> {
    return peerHold(this.env, ttlMs);
  }

  async release(): Promise<void> {
    await peerRelease(this.env);
  }

  /**
   * The app saw a newer version on its channel: check now instead of waiting for the daily gate
   * (release-ops.ts autoUpdateTick). Only clears the gate — the guardian's own rules still decide
   * (auto off, a pinned version, a version it reverted). Accounts with a concierge already do this
   * for every install; this is for a guardian on its own (customer-owned installs).
   */
  async recheck(): Promise<{ ok: true }> {
    await this.env.WORKEROPS_STATE.delete(LAST_AUTO_CHECK_KEY);
    return { ok: true };
  }

  /**
   * The app asks for a version (its admin's "update now", or the release script naming the version just
   * published): the guardian fetches, verifies and puts it out like any other update — next to the D1,
   * confirmed by the app's health and reverted if it does not answer (2026-11-12: the app no longer uploads
   * itself). Without a version, the version the app's channel offers. 202 deployed_unverified means it is out
   * and being checked; the app reads how it ended from its own version.
   */
  async update(version?: string): Promise<{ ok: boolean; status: string; version?: string; error?: string; detail?: string; httpStatus: number }> {
    // The product comes from PRODUCT_ID, or else from the app's own health declaration (resolveConfig).
    const config = await resolveConfig(this.env, loadConfig(this.env));
    if (!config.productId) return { ok: false, status: "not_configured", error: "not_configured", httpStatus: 404 };
    try {
      const res = await applyRelease(this.env, this.ctx, config, typeof version === "string" && version ? version : undefined, false, true);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; version?: string; error?: string; detail?: string };
      return { ok: res.ok, status: body.status ?? body.error ?? "unknown", ...body, httpStatus: res.status };
    } catch (e) {
      if (e instanceof OpsError) return { ok: false, status: e.code, error: e.code, detail: e.message, httpStatus: e.status };
      throw e;
    }
  }

  /** The app changes some of its own settings values (rebind.ts): the guardian puts the serving code out with them. */
  async rebind(changes: RebindChanges): Promise<RebindResult> {
    return rebindApp(this.env, loadConfig(this.env), changes ?? {});
  }

  /** The app asks to be restarted (an operator's button in its admin screen): the serving version goes out again (restart.ts). */
  async restart(reason?: string): Promise<AskedRestart> {
    return askedRestart(this.env, loadConfig(this.env), typeof reason === "string" ? reason : "");
  }
}

export default {
  /** Front-of-app proxy + Ops endpoints. */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const config = loadConfig(env);
    const { pathname } = new URL(request.url);

    if (pathname === config.opsPath || pathname.startsWith(config.opsPath + "/")) {
      return handleOps(request, env, ctx, config);
    }

    // Everything else is forwarded to the app Worker via the service binding.
    // If the app is unreachable, serve the maintenance page (graceful degrade).
    try {
      return await env.APP_SERVICE.fetch(forApp(request));
    } catch {
      return new Response(maintenancePage(config), {
        status: 503,
        headers: { ...PAGE_HEADERS, "retry-after": "30" },
      });
    }
  },

  /**
   * Watchdog (finishes any update stuck in `deployed_unverified`), automatic updates (only when the
   * owner switched them on), and the app's minute when APP_TICK is "1" (tick.ts).
   */
  async scheduled(
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await runTick(env, ctx, loadConfig(env), event.scheduledTime, { everyMinute: event.cron === "* * * * *" });
  },
};
