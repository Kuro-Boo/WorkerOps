// Environment bindings & configuration vars for the WorkerOps guardian.
// WorkerOps is project-agnostic: everything app-specific is supplied via these.

export interface Env {
  // ── Bindings ───────────────────────────────────────────────────────────
  /** Service binding to the app Worker that WorkerOps fronts. */
  APP_SERVICE: Fetcher;
  /** KV namespace holding WorkerOps' own update state / lock (no app data). */
  WORKEROPS_STATE: KVNamespace;

  // ── Secrets ────────────────────────────────────────────────────────────
  /** Cloudflare API token (Workers Scripts:Edit) used to update/revert the app. */
  CF_API_TOKEN: string;
  /** Token guarding Ops operations (update/revert/reinstall). Viewing status is public. */
  WORKER_OPS_TOKEN: string;

  // ── Vars (config) ──────────────────────────────────────────────────────
  CF_ACCOUNT_ID: string;
  /** Name of the app Worker script to deploy/revert via the CF API. */
  APP_WORKER_NAME: string;
  /** Release source for the app worker.js, e.g. GitHub "owner/repo". */
  RELEASE_SOURCE: string;
  /** Release asset filename (default "worker.js"). */
  RELEASE_ASSET?: string;
  /** Path prefix WorkerOps reserves for itself (default "/__workerops__"). */
  OPS_PATH?: string;
  /** App health path returning {ok, version} (default "/health"). */
  HEALTH_PATH?: string;
  /** Optional app endpoint to run one-shot/migrations during an update. */
  MIGRATE_PATH?: string;

  // ── Tunables (optional, string env) ────────────────────────────────────
  RETRY_MAX?: string;
  RETRY_BASE_MS?: string;
  REVERT_RETRY_MAX?: string;
  HEALTH_WINDOW_MS?: string;
  HEALTH_INTERVAL_MS?: string;
  UPDATE_LOCK_TTL_MS?: string;
  /** Comma list of CF binding types to re-submit when redeploying the app. */
  BINDING_TYPES?: string;
}
