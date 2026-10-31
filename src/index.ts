import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";
import { loadConfig } from "./config";
import { handleOps, maintenancePage } from "./ops";
import { runTick } from "./tick";
import { publishAssets, type AssetFile, type AssetSource, type PublishResult } from "./assets";
import { askedRestart, type AskedRestart } from "./restart";
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
