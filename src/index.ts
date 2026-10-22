import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";
import { loadConfig } from "./config";
import { handleOps, maintenancePage } from "./ops";
import { handleRevive, handleTick, runTick } from "./tick";
import { publishAssets, type AssetFile, type AssetSource, type PublishResult } from "./assets";
import { peerHold, peerRelease, peerStatus, type HoldResult, type PeerStatus } from "./peer";

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

    // The minute from a hosting account's concierge (tick.ts). Before handleOps: that resolves the
    // config with a call to the app, which a minute's call should not pay for.
    if (pathname === config.opsPath + "/api/v1/tick" && request.method === "POST") {
      return handleTick(env, ctx, config, request);
    }
    // The installer asks a guardian to bring a stopped concierge back (concierge-revive.ts). Same token.
    if (pathname === config.opsPath + "/api/v1/concierge/revive" && request.method === "POST") {
      return handleRevive(env, config, request);
    }

    if (pathname === config.opsPath || pathname.startsWith(config.opsPath + "/")) {
      return handleOps(request, env, ctx, config);
    }

    // Everything else is forwarded to the app Worker via the service binding.
    // If the app is unreachable, serve the maintenance page (graceful degrade).
    try {
      return await env.APP_SERVICE.fetch(request);
    } catch {
      return new Response(maintenancePage(config), {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "retry-after": "30",
        },
      });
    }
  },

  /**
   * Watchdog (finishes any update stuck in `deployed_unverified`), automatic updates (only when the
   * owner switched them on), and the app's minute when APP_TICK is "1" (tick.ts). Hosting accounts
   * have no cron here: their concierge calls POST {OPS_PATH}/api/v1/tick instead.
   */
  async scheduled(
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await runTick(env, ctx, loadConfig(env), event.scheduledTime, { everyMinute: event.cron === "* * * * *" });
  },
};
