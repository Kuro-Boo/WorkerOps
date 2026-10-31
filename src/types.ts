// Environment bindings & configuration vars for the WorkerOps guardian.
// WorkerOps is project-agnostic: everything app-specific is supplied via these.

export interface Env {
  // ── Bindings ───────────────────────────────────────────────────────────
  /** Service binding to the app Worker that WorkerOps fronts. */
  APP_SERVICE: Fetcher;
  /** KV namespace holding WorkerOps' own update state / lock (no app data). */
  WORKEROPS_STATE: KVNamespace;
  /** App database used only for signed, additive release migrations. */
  APP_DB?: D1Database;
  /**
   * Releases kept in a KV namespace of this account, used instead of the
   * distribution endpoint (store-release.ts). A person approves a version by
   * putting it there; nothing is fetched from outside the account.
   * Needs PRODUCT_ID. Checked on every cron tick (a store read stays in the account).
   */
  RELEASE_STORE?: KVNamespace;

  // ── Secrets ────────────────────────────────────────────────────────────
  /** Cloudflare API token (Workers Scripts:Edit) used to update/revert the app. */
  CF_API_TOKEN: string;
  /** Token guarding Ops operations (update/revert/reinstall). Viewing status is public. */
  WORKER_OPS_TOKEN: string;

  // ── Vars (config) ──────────────────────────────────────────────────────
  CF_ACCOUNT_ID: string;
  /** Name of the app Worker script to deploy/revert via the CF API. */
  APP_WORKER_NAME: string;
  /**
   * Product id at the release distribution endpoint. When set, updates come
   * from `{UPDATE_ORIGIN}/v1/dist/{PRODUCT_ID}/…` and are applied only when the
   * owner asks (or has turned automatic updates on).
   */
  PRODUCT_ID?: string;
  /** Older name of PRODUCT_ID. Still read; prefer PRODUCT_ID. */
  RELEASE_PRODUCT?: string;
  /** Release distribution endpoint origin (default https://update.entamy.com). */
  UPDATE_ORIGIN?: string;
  /** Optional service binding to the distribution endpoint (same-zone deployments). */
  UPDATE?: Fetcher;
  /** "stable" (default) or "dev". Which channel pointer is offered to the owner. */
  RELEASE_CHANNEL?: string;
  /**
   * Caller key for a product the distribution endpoint keeps internal (Entamy's own
   * Workers, e.g. Admin). Allowed for that one product only (x_dist.{product}).
   * Not needed for public products.
   */
  RELEASE_READ_KEY?: string;
  /** JSON array of trusted Ed25519 release public keys. */
  RELEASE_PUBKEYS?: string;
  /** Path prefix WorkerOps reserves for itself (default "/__workerops__"). */
  OPS_PATH?: string;
  /**
   * Health states (the contract's `state`) that count as healthy, comma-separated.
   * Unset: only `ok: true` counts (unchanged). An app that reports `degraded`
   * for a missing setting rather than broken code can set "ok,degraded", so a
   * new version is reverted only when it is `down` or does not answer.
   */
  HEALTH_OK_STATES?: string;
  /** App health path returning {ok, version} (default "/health"). */
  HEALTH_PATH?: string;
  /** Optional app endpoint to run one-shot/migrations during an update. */
  MIGRATE_PATH?: string;

  /** "1": the app takes the guardian's minute over APP_SERVICE (`tick(at)`) and has no cron of its own (tick.ts). */
  APP_TICK?: string;
  /**
   * "1": restart the app when its health fails during normal operation (restart.ts) — the serving
   * version is deployed again, once per incident. Unset: the guardian only rolls back fresh updates.
   */
  APP_RESTART?: string;
  /** "off" stops failure reports to Entamy Defects (sent by default). */
  DEFECTS?: string;
  /**
   * There is no self-update: the app the guardian watches replaces it
   * (cms-workerops「番人の更新は app が行う」・2026-10-21). OPS_WORKER_NAME and
   * SELF_UPDATE left on older installs are ignored (OPS_WORKER_NAME still names the install).
   */
  /** This guardian's own script name. Only names the install in failure reports (defects.ts installId). */
  OPS_WORKER_NAME?: string;

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
