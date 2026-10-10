import type { Env } from "./types";

export interface Config {
  opsPath: string;
  healthPath: string;
  migratePath: string | null;
  /**
   * Product id at the release distribution endpoint. When set, the app is
   * updated from `{UPDATE_ORIGIN}/v1/dist/{productId}/…` (signed, version-pinned)
   * instead of RELEASE_SOURCE, and only when the owner asks for it.
   */
  productId: string;
  /** Channel whose pointer is offered to the owner ("stable" unless set). */
  releaseChannel: "stable" | "dev";
  releaseSource: string;
  releaseTagPrefix: string;
  releaseAsset: string;
  /** private リポジトリを読むときだけ使う。空なら未認証経路(既定)。 */
  githubToken: string;
  token: string;
  accountId: string;
  appWorkerName: string;
  opsToken: string;
  retryMax: number;
  retryBaseMs: number;
  revertRetryMax: number;
  healthWindowMs: number;
  healthIntervalMs: number;
  lockTtlMs: number;
  bindingTypes: Set<string> | null;
  /** Own script name; empty disables self-update. */
  opsWorkerName: string;
  selfReleaseSource: string;
  selfUpdateIntervalMs: number;
  selfUpdateEnabled: boolean;
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
    migratePath: env.MIGRATE_PATH ? absPath(env.MIGRATE_PATH, "/migrate") : null,
    // RELEASE_PRODUCT is the older name of PRODUCT_ID; both are read so that
    // guardians installed before the rename keep working.
    productId: (env.PRODUCT_ID ?? env.RELEASE_PRODUCT ?? "").trim(),
    releaseChannel: (env.RELEASE_CHANNEL ?? "").trim().toLowerCase() === "dev" ? "dev" : "stable",
    releaseSource: (env.RELEASE_SOURCE ?? "").trim(),
    releaseTagPrefix: (env.RELEASE_TAG_PREFIX ?? "").trim(),
    releaseAsset: (env.RELEASE_ASSET ?? "worker.js").trim() || "worker.js",
    githubToken: (env.GITHUB_TOKEN ?? "").trim(),
    token: env.CF_API_TOKEN ?? "",
    accountId: env.CF_ACCOUNT_ID ?? "",
    appWorkerName: env.APP_WORKER_NAME ?? "",
    opsToken: env.WORKER_OPS_TOKEN ?? "",
    retryMax: int(env.RETRY_MAX, 3),
    retryBaseMs: int(env.RETRY_BASE_MS, 1000),
    revertRetryMax: int(env.REVERT_RETRY_MAX, 5),
    healthWindowMs: int(env.HEALTH_WINDOW_MS, 45000),
    healthIntervalMs: int(env.HEALTH_INTERVAL_MS, 2000),
    lockTtlMs: int(env.UPDATE_LOCK_TTL_MS, 120000),
    opsWorkerName: (env.OPS_WORKER_NAME ?? "").trim(),
    selfReleaseSource:
      (env.SELF_RELEASE_SOURCE ?? "").trim() || "Kuro-Boo/WorkerOps",
    selfUpdateIntervalMs: int(env.SELF_UPDATE_INTERVAL_MS, 6 * 60 * 60 * 1000),
    // Named AND not explicitly switched off. Both conditions, because the
    // failure mode of a bad self-update is "no way back from inside".
    selfUpdateEnabled:
      !!(env.OPS_WORKER_NAME ?? "").trim() &&
      !["0", "false", "off", "no"].includes(
        (env.SELF_UPDATE ?? "").trim().toLowerCase(),
      ),
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
