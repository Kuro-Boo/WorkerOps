import type { Env } from "./types";
import { loadConfig } from "./config";
import { handleOps, maintenancePage } from "./ops";
import { watchdogTick } from "./orchestrator";
import { selfUpdateTick } from "./self-update";

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

    // Look for a newer WorkerOps release. Deliberately NOT on the ops paths:
    // the self-update verifies itself by fetching {opsPath}/api/v1/health over
    // the public URL, and triggering from there could re-enter the update.
    // Cheap on the hot path — an in-isolate gate returns before touching KV
    // until the interval has elapsed.
    ctx.waitUntil(
      selfUpdateTick(env, config, new URL(request.url).origin).catch(() => {}),
    );

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

  /** Watchdog: finishes any update stuck in `deployed_unverified`. */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const config = loadConfig(env);
    ctx.waitUntil(watchdogTick(env, config).catch(() => {}));
  },
};
