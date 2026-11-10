import type { Env } from "./types";
import type { Config } from "./config";
import { withTimeout } from "./util";
import { retryAsync } from "./retry";

export interface HealthResult {
  ok: boolean;
  version?: string;
  status: number;
  /** What the app says it is at the distribution endpoint (optional contract field `product_id`). */
  productId?: string;
  /** The owner's update choices as the app's own admin screen holds them (optional `update_policy`). */
  policy?: { auto?: boolean; channel?: "stable" | "dev" };
}

const PRODUCT_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// The host is irrelevant for service-binding routing; only the path matters.
const APP_ORIGIN = "https://app.internal";

/** Probe the app's WorkerOps Contract health endpoint via the service binding. */
export async function probeHealth(env: Env, config: Config, extraHeaders: Record<string, string> = {}): Promise<HealthResult> {
  try {
    const req = new Request(APP_ORIGIN + config.healthPath, {
      method: "GET",
      // extraHeaders: 確かめてから配る段の版の指定(trial.ts)。
      headers: { accept: "application/json", ...extraHeaders },
    });
    const res = await withTimeout(env.APP_SERVICE.fetch(req), 5000);
    // Parse the body even on non-2xx: a broken NEW version may still report its
    // `version` (with ok:false), which lets verify distinguish "new version is
    // live but unhealthy" from "old version still serving" (propagation lag).
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      state?: unknown;
      version?: string;
      product_id?: unknown;
      update_policy?: { auto?: unknown; channel?: unknown };
    };
    const p = body?.update_policy;
    const policy = p && typeof p === "object" ? {
      ...(typeof p.auto === "boolean" ? { auto: p.auto } : {}),
      ...(p.channel === "stable" || p.channel === "dev" ? { channel: p.channel as "stable" | "dev" } : {}),
    } : undefined;
    return {
      ok: res.ok && (body?.ok === true
        || (typeof body?.state === "string" && (config.healthOkStates?.has(body.state) ?? false))),
      version: typeof body?.version === "string" ? body.version : undefined,
      status: res.status,
      ...(typeof body?.product_id === "string" && PRODUCT_RE.test(body.product_id) ? { productId: body.product_id } : {}),
      ...(policy && Object.keys(policy).length ? { policy } : {}),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Trigger the app's one-shot/migration endpoint (optional contract method).
 * Idempotent on the app side (run-once), so retries are safe.
 */
export async function runMigrate(env: Env, config: Config): Promise<boolean> {
  if (!config.migratePath) return true;
  const path = config.migratePath;
  return retryAsync(
    async () => {
      const req = new Request(APP_ORIGIN + path, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const res = await withTimeout(env.APP_SERVICE.fetch(req), 30_000);
      if (!res.ok) return false;
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return body?.ok !== false; // 2xx counts as success unless body says ok:false
    },
    { max: config.retryMax, baseMs: config.retryBaseMs },
  );
}

/**
 * Whether this health answer came from the version just deployed (version-aware verification,
 * CLAUDE.md・update-mgmt-s11 11.4節). Right after a deploy the service binding may still reach the
 * old version, and the old version answers ok — counting that would confirm a version nobody has
 * seen and record it as last-good (the revert target).
 *
 *   "new"     the answer names the intended version: judge it by its ok
 *   "unknown" not yet (old version, or no version named) — keep waiting; at the end of the window
 *             this is a failure, never a confirmation
 *
 * A reinstall puts the same version in again: the old and the new answer alike and cannot be told
 * apart, so there an answer naming that version counts (it is the same code).
 */
export function answeredBy(h: HealthResult, intended: string | null): "new" | "unknown" {
  return intended && h.version === intended ? "new" : "unknown";
}
