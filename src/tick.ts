/**
 * The guardian's minute: its own watch (watchdog + automatic updates) and, when the app asks for it,
 * the app's scheduled work. One trigger per install instead of one per Worker (2026-10-22).
 *
 * Cloudflare's free plan allows 5 cron triggers per account. An install used two (the app every minute,
 * the guardian every two minutes), so a free account held two installs. Now:
 *
 *   - the guardian's own cron calls runTick, or
 *   - a caller with TICK_TOKEN calls POST {OPS_PATH}/api/v1/tick (a hosting account's concierge ticks
 *     every guardian it runs, so the account needs a single trigger in all)
 *
 * and the guardian passes the minute on to the app over the service binding it already has
 * (APP_SERVICE.tick(at)), when APP_TICK is "1". The app's method is reached only through that binding —
 * a public request cannot call it.
 *
 * The guardian's own work keeps its old pace (every other minute) when ticked every minute: the
 * watchdog and the update check only read KV, and the free plan's KV reads are shared by the account.
 */
import type { Config } from "./config";
import type { Env } from "./types";
import { watchdogTick } from "./orchestrator";
import { autoUpdateTick } from "./release-ops";
import { constantTimeEqual, jsonResponse } from "./util";
import { reviveConcierge } from "./concierge-revive";

export type AppTick = "ok" | "off" | "error";

export interface TickResult {
  /** Whether the guardian ran its own watch this minute. */
  guardian: boolean;
  /** What happened to the app's minute. */
  app: AppTick;
  error?: string;
}

/** The app answers the minute when the install says so (APP_TICK=1). */
export const appTicks = (env: Env): boolean => env.APP_TICK === "1";

/** Every other minute, counted from the epoch so every caller agrees. */
export const guardianMinute = (at: number): boolean => Math.floor(at / 60_000) % 2 === 0;

export async function runTick(
  env: Env,
  ctx: ExecutionContext,
  config: Config,
  at: number,
  opts: { everyMinute: boolean },
): Promise<TickResult> {
  const guardian = !opts.everyMinute || guardianMinute(at);
  if (guardian) {
    ctx.waitUntil(watchdogTick(env, config).catch(() => {}));
    ctx.waitUntil(autoUpdateTick(env, ctx, config).catch(() => {}));
  }
  if (!appTicks(env)) return { guardian, app: "off" };
  try {
    await (env.APP_SERVICE as unknown as { tick(at: number): Promise<void> }).tick(at);
    return { guardian, app: "ok" };
  } catch (error) {
    return { guardian, app: "error", error: error instanceof Error ? error.message.slice(0, 200) : "tick failed" };
  }
}

/** POST {OPS_PATH}/api/v1/tick. Without TICK_TOKEN the endpoint does not exist. */
export async function tickAuthorized(env: Env, request: Request): Promise<boolean | null> {
  const expected = env.TICK_TOKEN ?? "";
  if (expected.length < 32) return null;
  const m = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
  return !!m && constantTimeEqual(m[1]!, expected);
}

/** The endpoint itself: 404 without TICK_TOKEN, 401 for a wrong token, else the minute's result. */
export async function handleTick(env: Env, ctx: ExecutionContext, config: Config, request: Request): Promise<Response> {
  const ok = await tickAuthorized(env, request);
  if (ok === null) return jsonResponse({ error: "not_found" }, 404);
  if (!ok) return jsonResponse({ error: "unauthorized" }, 401);
  return jsonResponse(await runTick(env, ctx, config, Date.now(), { everyMinute: true }));
}

/** POST {OPS_PATH}/api/v1/concierge/revive — same token as the minute (concierge-revive.ts). */
export async function handleRevive(env: Env, config: Config, request: Request): Promise<Response> {
  const ok = await tickAuthorized(env, request);
  if (ok === null) return jsonResponse({ error: "not_found" }, 404);
  if (!ok) return jsonResponse({ error: "unauthorized" }, 401);
  const result = await reviveConcierge(env, config);
  return jsonResponse(result, result.ok ? 200 : 502);
}
