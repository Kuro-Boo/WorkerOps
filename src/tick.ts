/**
 * The guardian's minute: its own watch (watchdog + automatic updates) and, when the app asks for it,
 * the app's scheduled work. One trigger per install instead of one per Worker (2026-10-22).
 *
 * Cloudflare's free plan allows 5 cron triggers per account. An install used two (the app every minute,
 * the guardian every two minutes), so a free account held two installs. Now the guardian's own cron
 * calls runTick (a hosting account's concierge runs the guardians of its installs itself, and its own
 * paired guardian ticks the concierge — core-offering 15.3), and the guardian passes the minute on to
 * the app over the service binding it already has (APP_SERVICE.tick(at)), when APP_TICK is "1". The app's method is reached only through that binding —
 * a public request cannot call it.
 *
 * The guardian's own work keeps its old pace (every other minute) when ticked every minute: the
 * watchdog and the update check only read KV, and the free plan's KV reads are shared by the account.
 */
import type { Config } from "./config";
import type { Env } from "./types";
import { watchdogTick } from "./orchestrator";
import { autoUpdateTick } from "./release-ops";
import { restartTick } from "./restart";

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
    // After the watchdog has had its say about an update (restart.ts leaves updates alone).
    ctx.waitUntil(restartTick(env, config).catch(() => "off"));
  }
  if (!appTicks(env)) return { guardian, app: "off" };
  try {
    await (env.APP_SERVICE as unknown as { tick(at: number): Promise<void> }).tick(at);
    return { guardian, app: "ok" };
  } catch (error) {
    return { guardian, app: "error", error: error instanceof Error ? error.message.slice(0, 200) : "tick failed" };
  }
}
