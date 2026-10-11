/**
 * Failures reported to Entamy Defects (spec: workerops-workerops-ops, "失敗の知らせ").
 *
 * A guardian's failures are otherwise only visible by opening its /status one
 * install at a time. So when an update or a self-update FAILS, one event is
 * sent. Successes and "nothing newer" are not sent.
 *
 * Only codes and numbers leave the guardian: no error text, no URL, no host
 * name, no account id (the install id is a hash). `DEFECTS=off` stops it.
 * A report that cannot be delivered never changes what the guardian does.
 */
import type { Env } from "./types";
import { WORKEROPS_VERSION } from "./version";

const DEFECTS_URL = "https://defects.entamy.com/v1/defects";
const TIMEOUT_MS = 5_000;

export type DefectCode =
  | "workerops_self_rolled_back"
  | "workerops_self_failed"
  | "workerops_app_failed_predeploy"
  | "workerops_app_auto_reverted"
  | "workerops_app_manual_required";

export function defectsEnabled(env: Env): boolean {
  return !["off", "0", "false", "no"].includes(
    (env.DEFECTS ?? "").trim().toLowerCase(),
  );
}

/** Stable per install, never the account id itself. */
export async function installId(env: Env): Promise<string> {
  const name = (env.OPS_WORKER_NAME ?? "").trim() || env.APP_WORKER_NAME;
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`workerops:${env.CF_ACCOUNT_ID}:${name}`),
    ),
  );
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** A value is sent only if it is a short token (Defects drops free text anyway). */
const token = (v: unknown): string | number | boolean | undefined => {
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= 64 && !/[\s"'<>]/.test(s) ? s : undefined;
};

export async function reportDefect(
  env: Env,
  code: DefectCode,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!defectsEnabled(env)) return;
  try {
    const clean: Record<string, string | number | boolean> = {
      app: (env.PRODUCT_ID ?? env.RELEASE_PRODUCT ?? "").trim() || "unknown",
    };
    for (const [k, v] of Object.entries(detail)) {
      const t = token(v);
      if (t !== undefined) clean[k] = t;
    }
    await fetch(DEFECTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product_id: "workerops",
        install_id: await installId(env),
        code,
        app_version: WORKEROPS_VERSION,
        detail: clean,
        debug_level: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    /* a failed report is lighter than the failure it wanted to report */
  }
}
