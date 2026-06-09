import type { Env } from "./types";
import { loadConfig } from "./config";
import { handleOps, maintenancePage } from "./ops";
import { watchdogTick } from "./orchestrator";

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
