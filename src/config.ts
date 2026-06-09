import type { Env } from "./types";

export interface Config {
  opsPath: string;
  healthPath: string;
  migratePath: string | null;
  releaseSource: string;
  releaseAsset: string;
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
  bindingTypes: Set<string>;
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
    releaseSource: (env.RELEASE_SOURCE ?? "").trim(),
    releaseAsset: (env.RELEASE_ASSET ?? "worker.js").trim() || "worker.js",
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
    bindingTypes: new Set(
      (env.BINDING_TYPES ?? "d1,kv_namespace,r2_bucket,plain_text,service")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}
