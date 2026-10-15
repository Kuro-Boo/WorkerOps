/**
 * The app's static assets (Workers Static Assets), and code that survives them.
 *
 * ## Why the guardian does this
 *
 * Assets change only with a new version, and the guardian is the only one that
 * puts versions on the app (cms-workerops: a version the app made itself would
 * be unknown to us, and last-good would drift). So the app hands its pages to
 * the guardian when a build ends, and the guardian makes the version:
 *
 *   1. register the full manifest (assets-upload-session)
 *   2. send only the files Cloudflare asks for (unchanged ones are not asked)
 *   3. a version with the CURRENT code and the completion token
 *   4. deploy it to 100%
 *
 * A Version upload must carry code ("main_module … required for Version
 * Upload"), so step 3 re-sends what is serving now (content/v2).
 *
 * ## Reverting without losing pages
 *
 * Going back to an old version id brings back that version's assets too —
 * every page published since would vanish — and Cloudflare only rolls back to
 * the 100 most recent versions, which per-build versions use up quickly. So
 * once an app has assets, a revert is a NEW version: the last-good code (kept
 * here at each confirm) with `keep_assets`. An app that never published assets
 * keeps the old id-based revert, exactly as before.
 */
import type { Env } from "./types";
import type { Config } from "./config";
import { CfClient, parseCode, type RawCode } from "./cf";
import { filterBindings } from "./bindings";
import { acquireLock, releaseLock, getState, setState } from "./state";
import { errMsg, nowIso } from "./util";

const CODE_KEY = "workerops:code:good";
const ASSETS_KEY = "workerops:assets";

/** Workers Static Assets per-file cap (25 MiB) and per-version cap on Paid. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 100_000;
const HASH_RE = /^[0-9a-f]{32}$/;

/** A publish can upload many files; it holds the lock longer than an update. */
const PUBLISH_LOCK_MS = 10 * 60 * 1000;

/** Served the way the build lays pages out: /post/ ← /post/index.html. */
export const DEFAULT_ASSETS_CONFIG = {
  html_handling: "auto-trailing-slash",
  not_found_handling: "none",
};

export interface AssetFile {
  /** 32 hex chars. The app's own digest of the file (Cloudflare only compares). */
  hash: string;
  size: number;
  /** Content-Type to serve the file with. */
  type: string;
}

/** Where the guardian reads the files Cloudflare asks for (the app, over RPC). */
export interface AssetSource {
  read(hashes: string[]): Promise<Array<{ hash: string; base64: string }>>;
}

/** Files asked of the app per call: keeps one RPC message well under its size limit. */
const READ_CHUNK = 50;

export interface AssetsRecord {
  status: "published" | "failed";
  at: string;
  files: number;
  uploaded: number;
  versionId: string | null;
  error: string | null;
}

export type PublishResult =
  | { ok: true; status: "published"; versionId: string; files: number; uploaded: number }
  | { ok: false; status: "busy" | "invalid" | "failed"; error: string };

function client(config: Config): CfClient {
  return new CfClient(config.token, config.accountId, config.appWorkerName, {
    max: config.retryMax,
    baseMs: config.retryBaseMs,
  });
}

/** Has this guardian ever put assets on the app? Decides how a revert is done. */
export async function hasPublishedAssets(env: Env): Promise<boolean> {
  return (await env.WORKEROPS_STATE.get(ASSETS_KEY)) !== null;
}

export async function assetsRecord(env: Env): Promise<AssetsRecord | null> {
  const raw = await env.WORKEROPS_STATE.get(ASSETS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as AssetsRecord; } catch { return null; }
}

/**
 * The code serving now. `content/v2` returns the newest UPLOADED version, so
 * it is the serving code only when that version is also the active one; when
 * someone uploaded a version without deploying it, refuse rather than put
 * code nobody deployed under the public site.
 */
export async function servingCode(cf: CfClient): Promise<RawCode> {
  const [active, latest] = await Promise.all([cf.getActiveVersionId(), cf.getLatestVersionId()]);
  if (!active || active !== latest) throw new Error("the newest version is not the one serving; deploy or roll back first");
  return cf.getContentRaw();
}

/** Keep the code serving now as the last-good code (call when it is confirmed). */
export async function saveGoodCode(env: Env, cf: CfClient, versionId: string | null): Promise<void> {
  const raw = await servingCode(cf);
  await env.WORKEROPS_STATE.put(CODE_KEY, raw.body, {
    metadata: { contentType: raw.contentType, mainModule: raw.mainModule, versionId, at: nowIso() },
  });
}

/** Is any code kept? (Streams and drops the value instead of reading megabytes.) */
async function hasGoodCode(env: Env): Promise<boolean> {
  const s = await env.WORKEROPS_STATE.get(CODE_KEY, "stream");
  if (!s) return false;
  await s.cancel();
  return true;
}

/** At a confirm: keep the confirmed code, once this app has assets. Best-effort. */
export async function keepGoodCode(env: Env, config: Config, versionId: string | null): Promise<void> {
  if (!(await hasPublishedAssets(env))) return;
  await saveGoodCode(env, client(config), versionId).catch(() => {});
}

async function loadGoodCode(env: Env): Promise<RawCode | null> {
  const r = await env.WORKEROPS_STATE.getWithMetadata<{ contentType: string; mainModule: string }>(CODE_KEY, "arrayBuffer");
  if (!r.value || !r.metadata) return null;
  return { contentType: r.metadata.contentType, mainModule: r.metadata.mainModule, body: r.value };
}

/**
 * Put the app back on its last-good code. With assets: a new version from the
 * kept code that keeps the current assets. Otherwise (or with no code kept):
 * redeploy the old version id, as before. Returns what it did.
 */
export async function restoreVersion(
  env: Env,
  cf: CfClient,
  targetVersionId: string,
  message: string,
  bindingTypes: Set<string> | null,
): Promise<{ how: "code" | "version"; versionId: string }> {
  if (await hasPublishedAssets(env)) {
    const raw = await loadGoodCode(env);
    if (raw) {
      const settings = await cf.getSettings();
      const versionId = await cf.uploadModules(
        await parseCode(raw),
        filterBindings(settings.bindings, bindingTypes),
        settings.compatibility_date,
        settings.compatibility_flags,
      );
      await cf.deployVersion(versionId, message);
      return { how: "code", versionId };
    }
  }
  await cf.deployVersion(targetVersionId, message);
  return { how: "version", versionId: targetVersionId };
}

export function validateManifest(manifest: Record<string, AssetFile>): string | null {
  const entries = Object.entries(manifest ?? {});
  if (entries.length > MAX_FILES) return `more than ${MAX_FILES} files`;
  for (const [path, f] of entries) {
    if (!path.startsWith("/") || path.includes("..")) return `bad path ${path.slice(0, 80)}`;
    if (!f || !HASH_RE.test(f.hash)) return `bad hash for ${path.slice(0, 80)}`;
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) return `bad size for ${path.slice(0, 80)}`;
  }
  return null;
}

/**
 * Publish the app's assets as a new version (steps at the top of this file).
 * An EMPTY manifest takes every asset down (the app stopped publishing its
 * site): a version with the current code and no assets.
 * Never waits for the lock: when an update or another publish is running it
 * returns `busy`, and the app asks again later with its newest manifest.
 */
export async function publishAssets(
  env: Env,
  config: Config,
  manifest: Record<string, AssetFile>,
  source: AssetSource,
  options: { config?: Record<string, unknown> } = {},
  cf: CfClient = client(config),
): Promise<PublishResult> {
  if (!config.token || !config.accountId || !config.appWorkerName)
    return { ok: false, status: "failed", error: "cf_config_missing" };
  const invalid = validateManifest(manifest);
  if (invalid) return { ok: false, status: "invalid", error: invalid };

  const st = await getState(env);
  if (st.status === "pending" || st.status === "deployed_unverified")
    return { ok: false, status: "busy", error: "update_in_progress" };
  if (!(await acquireLock(env, PUBLISH_LOCK_MS)))
    return { ok: false, status: "busy", error: "operation_in_progress" };

  const files = Object.keys(manifest).length;
  let uploaded = 0;
  try {
    const types = new Map<string, string>();
    const bare: Record<string, { hash: string; size: number }> = {};
    for (const [path, f] of Object.entries(manifest)) {
      bare[path] = { hash: f.hash, size: f.size };
      types.set(f.hash, f.type);
    }
    const empty = files === 0;
    const session = empty ? { jwt: "", buckets: [] as string[][] } : await cf.assetsUploadSession(bare);
    let completion = session.jwt;
    for (const bucket of session.buckets) {
      const byHash = new Map<string, string>();
      for (let i = 0; i < bucket.length; i += READ_CHUNK) {
        for (const g of await source.read(bucket.slice(i, i + READ_CHUNK))) byHash.set(g.hash, g.base64);
      }
      const missing = bucket.filter((h) => !byHash.has(h));
      if (missing.length) throw new Error(`app did not return ${missing.length} file(s)`);
      const done = await cf.uploadAssetBucket(
        session.jwt,
        bucket.map((h) => ({ hash: h, base64: byHash.get(h)!, type: types.get(h) ?? "" })),
      );
      uploaded += bucket.length;
      if (done) completion = done;
    }

    // The code serving now is the confirmed code (no update holds the lock).
    // Keep it first if nothing is kept yet: from here on, reverts rebuild from it.
    if (!(await hasGoodCode(env))) await saveGoodCode(env, cf, st.lastGoodVersionId);
    const code = await parseCode(await servingCode(cf));
    const settings = await cf.getSettings();
    const versionId = await cf.uploadModules(
      code,
      filterBindings(settings.bindings, config.bindingTypes),
      settings.compatibility_date,
      settings.compatibility_flags,
      empty ? "none" : { jwt: completion, config: { ...DEFAULT_ASSETS_CONFIG, ...(options.config ?? {}) } },
    );
    await cf.deployVersion(versionId, empty ? "WorkerOps assets cleared" : `WorkerOps assets ${files} files (${uploaded} new)`);

    // Same code as the last-good one, so this version is as good: an id-based
    // fallback revert should land on it, not on one with older pages.
    if (st.status === "confirmed" || st.status === "idle") await setState(env, { lastGoodVersionId: versionId });
    const record: AssetsRecord = { status: "published", at: nowIso(), files, uploaded, versionId, error: null };
    await env.WORKEROPS_STATE.put(ASSETS_KEY, JSON.stringify(record));
    return { ok: true, status: "published", versionId, files, uploaded };
  } catch (e) {
    const prev = await assetsRecord(env);
    // Keep "has published" true once it was: it decides how reverts are done.
    const record: AssetsRecord = {
      status: "failed", at: nowIso(), files, uploaded, versionId: prev?.versionId ?? null, error: errMsg(e).slice(0, 300),
    };
    if (prev) await env.WORKEROPS_STATE.put(ASSETS_KEY, JSON.stringify(record));
    return { ok: false, status: "failed", error: errMsg(e) };
  } finally {
    await releaseLock(env);
  }
}
