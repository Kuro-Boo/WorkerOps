import type { Env } from "./types";

export type ReleaseChannel = "stable" | "dev";

export interface Config {
  opsPath: string;
  healthPath: string;
  /** Contract `state` values that count as healthy besides `ok: true` (HEALTH_OK_STATES). Empty: only `ok: true`. */
  healthOkStates: Set<string>;
  migratePath: string | null;
  /**
   * Product id at the release distribution endpoint. The app is updated from
   * `{UPDATE_ORIGIN}/v1/dist/{productId}/…` (signed, version-pinned), or from
   * RELEASE_STORE when that is bound. There is no other source.
   */
  productId: string;
  /** Channel offered until the owner picks one in the console ("stable" unless set). */
  releaseChannel: ReleaseChannel;
  token: string;
  accountId: string;
  appWorkerName: string;
  opsToken: string;
  /** OPS_SCREEN=on: the page and status are public. Otherwise OPS_PATH answers only to the token (types.ts). */
  opsScreen?: boolean;
  retryMax: number;
  retryBaseMs: number;
  revertRetryMax: number;
  healthWindowMs: number;
  healthIntervalMs: number;
  lockTtlMs: number;
  bindingTypes: Set<string> | null;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : fallback;
}

/** Normalize to a leading-slash path with no trailing slash. */
function absPath(value: string | undefined, fallback: string): string {
  const raw = (value ?? fallback).trim();
  const lead = "/" + raw.replace(/^\/+/, "");
  return lead.replace(/\/+$/, "") || fallback;
}

export function loadConfig(env: Env): Config {
  return {
    opsPath: absPath(env.OPS_PATH, "/__workerops__"),
    healthPath: absPath(env.HEALTH_PATH, "/health"),
    healthOkStates: new Set((env.HEALTH_OK_STATES ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    migratePath: env.MIGRATE_PATH ? absPath(env.MIGRATE_PATH, "/migrate") : null,
    // RELEASE_PRODUCT is the older name of PRODUCT_ID; both are read so that
    // guardians installed before the rename keep working.
    productId: (env.PRODUCT_ID ?? env.RELEASE_PRODUCT ?? "").trim(),
    releaseChannel: (env.RELEASE_CHANNEL ?? "").trim().toLowerCase() === "dev" ? "dev" : "stable",
    token: env.CF_API_TOKEN ?? "",
    accountId: env.CF_ACCOUNT_ID ?? "",
    appWorkerName: env.APP_WORKER_NAME ?? "",
    opsToken: env.WORKER_OPS_TOKEN ?? "",
    opsScreen: (env.OPS_SCREEN ?? "").trim() === "on",
    retryMax: int(env.RETRY_MAX, 3),
    retryBaseMs: int(env.RETRY_BASE_MS, 1000),
    revertRetryMax: int(env.REVERT_RETRY_MAX, 5),
    healthWindowMs: int(env.HEALTH_WINDOW_MS, 45000),
    healthIntervalMs: int(env.HEALTH_INTERVAL_MS, 2000),
    lockTtlMs: int(env.UPDATE_LOCK_TTL_MS, 120000),
    // ⚠ 未設定なら null＝【型で絞らない】。既定を許可リストにしていたため、
    //   そこに無い型 (images など) が更新のたびに消えていた。明示された場合だけ
    //   従来どおり許可リストとして働く。
    bindingTypes: env.BINDING_TYPES
      ? new Set(
          env.BINDING_TYPES.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : null,
  };
}
