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
  /** JSON array of trusted Ed25519 release public keys. */
  RELEASE_PUBKEYS?: string;
  /**
   * Legacy release source for the app worker.js, e.g. GitHub "owner/repo".
   * Used only when PRODUCT_ID is not set.
   */
  RELEASE_SOURCE?: string;
  /**
   * Tag prefix when RELEASE_SOURCE is a monorepo holding several components'
   * releases (e.g. "Admin/" for tags like "Admin/v0.1.2"). Default: none.
   * Needs GITHUB_TOKEN (the prefix is resolved through the releases list API).
   */
  RELEASE_TAG_PREFIX?: string;
  /** private リリースを読むための token。未設定なら未認証経路(public 用・既定)。 */
  GITHUB_TOKEN?: string;
  /** Release asset filename (default "worker.js"). */
  RELEASE_ASSET?: string;
  /** Path prefix WorkerOps reserves for itself (default "/__workerops__"). */
  OPS_PATH?: string;
  /** App health path returning {ok, version} (default "/health"). */
  HEALTH_PATH?: string;
  /** Optional app endpoint to run one-shot/migrations during an update. */
  MIGRATE_PATH?: string;

  // ── Self-update (the guardian updating ITSELF) ─────────────────────────
  /**
   * Name of THIS guardian's own Worker script. Self-update is DISABLED unless
   * it is set — a guardian that cannot name itself must never try to replace
   * itself, and "off" is the only safe default for a component whose failure
   * has no in-band recovery.
   */
  /** "off" stops failure reports to Entamy Defects (sent by default). */
  DEFECTS?: string;
  OPS_WORKER_NAME?: string;
  /** Repo holding WorkerOps' own releases (default "Kuro-Boo/WorkerOps"). */
  SELF_RELEASE_SOURCE?: string;
  /** How often to look for a new WorkerOps release (default 3h). */
  SELF_UPDATE_INTERVAL_MS?: string;
  /** Set to "0"/"false" to switch self-update off even when named. */
  SELF_UPDATE?: string;

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
