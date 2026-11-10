/**
 * 署名済みの版を確かめて、app Worker へ入れる。
 *
 * 版の取り方(取得口から指名した版を取る)は dist-release.ts にある。ここは取得の経路を問わず、
 *   ① manifest の署名を、手元に持つ公開鍵(RELEASE_PUBKEYS)で確かめる
 *   ② 各成果物の大きさと sha256 を manifest と照合する
 *   ③ 移行を当て、新しい版を配り、health が新しい版で応答するのを待って確定する。だめなら前の版へ戻す
 * の3つだけを行う。外から版を送り込まれる口は持たない —— 版を上げるかどうかは持ち主が決める。
 */
import { applyVars, filterBindings } from "./bindings";
import { CfClient, type VersionAssets } from "./cf";
import { keepGoodCode, restoreVersion } from "./assets";
import type { Config } from "./config";
import { answeredBy, probeHealth, runMigrate } from "./health";
import { addColumnTarget, createIndexName, splitSql } from "./sql";
import { trialVersion } from "./trial";
import {
  acquireLock,
  appendEvent,
  getState,
  releaseLock,
  setState,
  startJournal,
} from "./state";
import type { Env } from "./types";
import { revokedTarget } from "./store-release";
import { errMsg, nowIso, sleep } from "./util";

const WORKER_LIMIT = 10 * 1024 * 1024;
const MIGRATIONS_LIMIT = 5 * 1024 * 1024;
/** The manifest itself (dist-release.ts・store-release.ts). */
export const MANIFEST_LIMIT = 256 * 1024;
/** A release carries the worker, its migrations, vars and static assets; a few more at most. */
const MAX_ARTIFACTS = 16;
/** Everything a release may carry together (each artifact also has its own limit). */
const TOTAL_LIMIT = 2 * WORKER_LIMIT + MIGRATIONS_LIMIT;

const artifactLimit = (a: Artifact): number => (a.role === "migrations" ? MIGRATIONS_LIMIT : WORKER_LIMIT);

/**
 * Refuse a release by what its manifest declares, before any artifact is fetched: how many, how
 * large each, how large together. The bytes read later are held to the declared size (readCapped),
 * so a Worker never buffers more than this — its memory is 128 MB.
 */
export function checkArtifactSizes(artifacts: Artifact[]): void {
  if (artifacts.length > MAX_ARTIFACTS) throw new Error("release carries too many artifacts");
  let total = 0;
  for (const a of artifacts) {
    if (a.size > artifactLimit(a)) throw new Error(`${a.name} is too large`);
    total += a.size;
  }
  if (total > TOTAL_LIMIT) throw new Error("release is too large");
}

/**
 * Read a body, stopping as soon as it passes `limit` bytes (a missing or false Content-Length, an
 * oversized answer, or a gzip that expands too far all end here, without reading the rest).
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number, what: string): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`${what} is larger than expected`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
const VERSION_KEY = "workerops:release:version";
/**
 * A version that was deployed and then reverted (health or migrate failed).
 * Recorded for every guardian; only a store guardian (RELEASE_STORE) reads it,
 * and then never deploys that version again on its own — the next one is
 * whatever a person puts into the store next.
 */
export const failedKey = (version: string): string => `workerops:release:failed:${version}`;
/**
 * Keys trusted when RELEASE_PUBKEYS is not set: the publisher keys of the default
 * distribution endpoint (https://update.entamy.com). Guardians installed before
 * PRODUCT_ID existed have no RELEASE_PUBKEYS, and the keys travel inside the
 * guardian's own release so that nothing fetched at update time decides what is trusted.
 * Rotation only ever adds a key, in a release signed with an older one.
 */
export const DEFAULT_RELEASE_PUBKEYS = JSON.stringify([
  { key_id: "release-b01a61a2", pub: "oSIheWqY73pJf85mtBNC4N7pAM8_aSpnCzVNcZ4INps" },
]);
const VERSION_RE = /^\d+\.\d+\.\d+$/;

interface Artifact { name: string; role?: string; sha256: string; size: number }
export interface Manifest {
  schema: "entamy.release/1" | "entamy.release/2";
  kind?: "code" | "data";
  severity?: string;
  product: string;
  version: string;
  main_module?: string;
  artifacts: Artifact[];
  migrations?: string[];
  signature: { alg: "ed25519"; key_id: string; sig: string };
  [key: string]: unknown;
}
interface Key { key_id: string; pub: string }
interface Envelope { manifest: Manifest; artifacts: Record<string, string> }

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function bytes(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const encoded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(encoded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function canonical(manifest: Manifest): string {
  const { signature: _signature, ...unsigned } = manifest;
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        output[key] = sort((value as Record<string, unknown>)[key]);
      }
      return output;
    }
    return value;
  };
  return JSON.stringify(sort(unsigned));
}

async function digest(value: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes(value));
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function keys(raw: string | undefined): Key[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? ""); } catch { throw new Error("release public keys are invalid"); }
  if (!Array.isArray(parsed)) throw new Error("release public keys are invalid");
  const valid = parsed.filter((item): item is Key => !!item && typeof item === "object"
    && typeof (item as Key).key_id === "string" && typeof (item as Key).pub === "string");
  if (valid.length === 0) throw new Error("release public keys are not configured");
  return valid;
}

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

export interface SignedRelease {
  manifest: Manifest;
  worker: string;
  migrations: Array<{ name: string; sql: string }>;
  /** 版が運ぶ設定の値(`role: "vars"`・wrangler.toml の [vars])。運ばない版は null。 */
  vars?: Record<string, string> | null;
  /** 版が運ぶ Worker の静的資産(`role: "static_assets"`・wrangler の [assets])。運ばない版は null(今の資産を残す)。 */
  staticAssets?: StaticAssets | null;
}

export interface StaticAssets {
  config: Record<string, unknown>;
  files: Array<{ path: string; type: string; base64: string }>;
}

/** 版から受け取る資産の配り方。ほかの鍵は渡さない(Cloudflare の assets.config に載る鍵だけ)。 */
const STATIC_CONFIG_KEYS = ["run_worker_first", "html_handling", "not_found_handling"];
const STATIC_PATH = /^\/[A-Za-z0-9._\-/]{1,255}$/;

function parseStaticAssets(data: Uint8Array): StaticAssets {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new Error("release static assets are invalid"); }
  const raw = parsed as { config?: unknown; files?: unknown };
  if (!raw || typeof raw.files !== "object" || raw.files === null || Array.isArray(raw.files)) throw new Error("release static assets are invalid");
  const files: StaticAssets["files"] = [];
  for (const [path, f] of Object.entries(raw.files as Record<string, unknown>)) {
    const file = f as { type?: unknown; base64?: unknown };
    if (!STATIC_PATH.test(path) || path.includes("..") || typeof file?.type !== "string" || typeof file.base64 !== "string") {
      throw new Error("release static assets are invalid");
    }
    files.push({ path, type: file.type, base64: file.base64 });
  }
  if (!files.length) throw new Error("release static assets are invalid");
  const config: Record<string, unknown> = {};
  const given = raw.config && typeof raw.config === "object" ? raw.config as Record<string, unknown> : {};
  for (const k of STATIC_CONFIG_KEYS) if (k in given) config[k] = given[k];
  return { config, files };
}

/**
 * 版の静的資産を上げ、版に付ける鍵を返す(assets.ts の publishAssets と同じ手順: 目録 → 求められた分だけ送る)。
 * 指紋は中身と種類から作る(Cloudflare は比べるだけ・32 桁)。
 */
export async function uploadStaticAssets(client: CfClient, sa: StaticAssets): Promise<VersionAssets> {
  const byHash = new Map<string, { base64: string; type: string }>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of sa.files) {
    const bytesOf = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
    const hash = (await digest(new Uint8Array([...new TextEncoder().encode(`${f.type}\n`), ...bytesOf]))).slice(0, 32);
    manifest[f.path] = { hash, size: bytesOf.byteLength };
    byHash.set(hash, { base64: f.base64, type: f.type });
  }
  const session = await client.assetsUploadSession(manifest);
  let completion = session.jwt;
  for (const bucket of session.buckets) {
    const done = await client.uploadAssetBucket(session.jwt, bucket.map((h) => {
      const f = byHash.get(h);
      if (!f) throw new Error("static asset asked for is not in the release");
      return { hash: h, base64: f.base64, type: f.type };
    }));
    if (done) completion = done;
  }
  return { jwt: completion, config: sa.config };
}

const VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const VARS_MAX = 64;
const VAR_TEXT_MAX = 4096;

/** 設定の値の成果物を読む。名前・値・数の形が外れていれば版ごと断る。 */
function parseVars(bytes: Uint8Array): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("release vars are invalid"); }
  const vars = (parsed as { vars?: unknown })?.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new Error("release vars are invalid");
  const entries = Object.entries(vars as Record<string, unknown>);
  if (entries.length > VARS_MAX || entries.some(([name, text]) =>
    !VAR_NAME.test(name) || typeof text !== "string" || text.length > VAR_TEXT_MAX)) {
    throw new Error("release vars are invalid");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** ① manifest の形と署名。**通るまで本体を取りに行かない。** */
export async function verifyManifest(env: Env, value: unknown, product: string): Promise<Manifest> {
  if (!value || typeof value !== "object") throw new Error("release manifest is invalid");
  const manifest = value as Manifest;
  if (!manifest || (manifest.schema !== "entamy.release/1" && manifest.schema !== "entamy.release/2")
    || manifest.product !== product || !VERSION_RE.test(manifest.version) || !Array.isArray(manifest.artifacts)) {
    throw new Error("release identity is invalid");
  }
  if (!manifest.signature || manifest.signature.alg !== "ed25519") throw new Error("release signature is missing");
  const trusted = keys(env.RELEASE_PUBKEYS || (env.UPDATE_ORIGIN ? undefined : DEFAULT_RELEASE_PUBKEYS)).find((item) => item.key_id === manifest.signature.key_id);
  if (!trusted) throw new Error("release signing key is not trusted");
  const key = await crypto.subtle.importKey("raw", bytes(fromBase64Url(trusted.pub)), { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "Ed25519", key, bytes(fromBase64Url(manifest.signature.sig)), bytes(new TextEncoder().encode(canonical(manifest))),
  );
  if (!ok) throw new Error("release signature does not match");
  for (const artifact of manifest.artifacts) {
    if (!artifact || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(artifact.name)
      || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 0) {
      throw new Error("release artifact metadata is invalid");
    }
  }
  checkArtifactSizes(manifest.artifacts);
  return manifest;
}

/** ② 成果物を manifest と照合し、実行本体と移行を取り出す。 */
export function verifyArtifactsSync(manifest: Manifest, files: Map<string, Uint8Array>, sha: Map<string, string>): SignedRelease {
  const names = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (names.has(artifact.name)) throw new Error("release artifact metadata is invalid");
    names.add(artifact.name);
    const data = files.get(artifact.name);
    if (!data) throw new Error(`${artifact.name} is missing`);
    const limit = artifactLimit(artifact);
    if (data.byteLength !== artifact.size || data.byteLength > limit) throw new Error(`${artifact.name} size does not match`);
    if (sha.get(artifact.name) !== artifact.sha256) throw new Error(`${artifact.name} digest does not match`);
  }
  if ([...files.keys()].some((name) => !names.has(name))) throw new Error("undeclared release artifact");

  const main = manifest.main_module ?? "worker.js";
  const workerBytes = files.get(main);
  if (!workerBytes) throw new Error("release main module is missing");
  const migrationArtifact = manifest.artifacts.find((item) => item.role === "migrations");
  let migrations: Array<{ name: string; sql: string }> = [];
  if (migrationArtifact) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(files.get(migrationArtifact.name)!)); }
    catch { throw new Error("release migrations are invalid"); }
    const list = (parsed as { migrations?: unknown })?.migrations;
    if (!Array.isArray(list) || !list.every((item) => !!item && typeof item === "object"
      && typeof (item as { name?: unknown }).name === "string" && typeof (item as { sql?: unknown }).sql === "string")) {
      throw new Error("release migrations are invalid");
    }
    migrations = list as Array<{ name: string; sql: string }>;
    const declared = [...(manifest.migrations ?? [])].sort();
    const actual = migrations.map((item) => item.name).sort();
    if (declared.length !== actual.length || declared.some((name, index) => name !== actual[index])) {
      throw new Error("release migration declaration does not match");
    }
  }
  const varsArtifact = manifest.artifacts.find((item) => item.role === "vars");
  const vars = varsArtifact ? parseVars(files.get(varsArtifact.name)!) : null;
  const staticArtifact = manifest.artifacts.find((item) => item.role === "static_assets");
  const staticAssets = staticArtifact ? parseStaticAssets(files.get(staticArtifact.name)!) : null;
  return { manifest, worker: new TextDecoder().decode(workerBytes), migrations, vars, staticAssets };
}

export async function verifyArtifacts(manifest: Manifest, files: Map<string, Uint8Array>): Promise<SignedRelease> {
  const sha = new Map<string, string>();
  for (const [name, data] of files) sha.set(name, await digest(data));
  return verifyArtifactsSync(manifest, files, sha);
}

/** 稼働中として記録している版(確定したときだけ書く)。 */
export async function currentReleaseVersion(env: Env): Promise<string | null> {
  return env.WORKEROPS_STATE.get(VERSION_KEY);
}

export { compareVersion };

/**
 * 移行を 1 つずつ、文と当てた記録を 1 つのトランザクション(`batch()`)で当てる(2026-10-26)。
 *
 * 前は `exec()` に丸ごと渡していた。`exec()` は改行ごとに 1 文として流し、失敗した所で止まるので、
 * 複数行の文で落ちると途中まで当たったまま記録が残らなかった(sql.ts)。
 * その時に当たった分でやり直しが止まらないよう、**既にある列の ADD COLUMN は飛ばし、既にある索引は
 * 消して移行どおりに作り直す**(索引は中身を持たないので作り直しても失うものが無い)。
 */
export async function applyMigrations(env: Env, migrations: Array<{ name: string; sql: string }>): Promise<void> {
  if (migrations.length === 0) return;
  const db = env.APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL)").run();
  for (const migration of migrations) {
    if (!/^[0-9][A-Za-z0-9._-]*\.sql$/.test(migration.name)) throw new Error("migration name is invalid");
    const applied = await db.prepare("SELECT 1 AS applied FROM d1_migrations WHERE name=?1").bind(migration.name).first();
    if (applied) continue;
    const statements: D1PreparedStatement[] = [];
    for (const stmt of splitSql(migration.sql)) {
      const add = addColumnTarget(stmt);
      // D1 の文書にあるのは PRAGMA table_info(表の形の pragma_table_info() は載っていない)。
      if (add && (await db.prepare(`PRAGMA table_info("${add.table}")`).all<{ name: string }>()).results.some((c) => c.name === add.column)) continue;
      const index = createIndexName(stmt);
      if (index && await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name=?1").bind(index).first()) {
        // 同じ移行の前の文で表ごと作り直していれば、索引はもう無い。
        statements.push(db.prepare(`DROP INDEX IF EXISTS "${index}"`));
      }
      statements.push(db.prepare(stmt));
    }
    statements.push(db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES(?1,?2)").bind(migration.name, nowIso()));
    try {
      await db.batch(statements);
    } catch (error) {
      throw new Error(`migration ${migration.name} failed: ${errMsg(error)}`);
    }
  }
}

export async function deploySignedRelease(
  env: Env, ctx: ExecutionContext, config: Config, release: SignedRelease, reinstall = false,
  /**
   * 前の版へ入れ替えてよいか。運用者が版を指したとき(release-ops.ts の PIN_KEY・Admin が委託へ
   * 版を指して配る/戻す)だけ真。ふだんは古い版を入れない(取得口の誤りで版を下げないため)。
   */
  allowDowngrade = false,
): Promise<Response> {
  if (!config.token || !config.accountId || !config.appWorkerName) return response({ error: "cf_config_missing" }, 503);
  // What the app reports wins over our record: the app may have updated itself
  // (an app with its own update button) since we last deployed.
  const live = (await probeHealth(env, config)).version;
  const current = (live && VERSION_RE.test(live) ? live : null) ?? await env.WORKEROPS_STATE.get(VERSION_KEY);
  if (current && !allowDowngrade && compareVersion(release.manifest.version, current) < 0) return response({ error: "release_downgrade" }, 409);
  // Rebuild puts the running version in again on purpose.
  if (current === release.manifest.version && !reinstall) return response({ ok: true, status: "already_current", version: current });
  const lock = await acquireLock(env, config.lockTtlMs);
  if (!lock) return response({ error: "update_in_progress" }, 409);

  const client = new CfClient(config.token, config.accountId, config.appWorkerName, { max: config.retryMax, baseMs: config.retryBaseMs });
  try {
    await startJournal(env, "signed_release");
    await appendEvent(env, "verify_release", "ok", release.manifest.version);
    const fromVersion = await client.getActiveVersionId();
    const previousHealthVersion = (await probeHealth(env, config)).version ?? null;
    await setState(env, {
      status: "pending", fromVersionId: fromVersion,
      ...(fromVersion ? { lastGoodVersionId: fromVersion, lastGoodRelease: current } : {}),
      toVersionId: null, prevAppVersion: previousHealthVersion, intendedRelease: release.manifest.version,
      startedAt: nowIso(), deployedAt: null, confirmedAt: null, finishedAt: null, error: null,
    });
    // An app with a MIGRATE_PATH keeps its own migration ledger: it is asked to
    // migrate once the new version is live. Only an app
    // without one gets the release's migrations applied to APP_DB here.
    if (!config.migratePath) {
      await appendEvent(env, "migrate", "run", `${release.migrations.length} migrations`);
      await applyMigrations(env, release.migrations);
      await appendEvent(env, "migrate", "ok");
    }
    const settings = await client.getSettings();
    // 版が運ぶ設定の値を重ねる(版に無い値は残す・bindings.ts の applyVars)。
    const bindings = applyVars(filterBindings(settings.bindings, config.bindingTypes), release.vars);
    // 版が資産を運ぶなら、その資産を版に付ける(運ばない版は今の資産を残す)。
    const assets = release.staticAssets ? await uploadStaticAssets(client, release.staticAssets) : undefined;
    if (release.staticAssets) await appendEvent(env, "static_assets", "ok", `${release.staticAssets.files.length} files`);
    const versionId = await client.uploadVersion(release.worker, bindings, settings.compatibility_date, settings.compatibility_flags, assets);
    await setState(env, { toVersionId: versionId });
    if (config.trialBeforeDeploy) {
      // 確かめてから配る(trial.ts)。だめなら本番は今の版のまま。この版は二度と自分から入れない。
      if (!fromVersion) throw new Error("trial: no serving version to keep");
      const trial = await trialVersion({
        deploy: (versions, message) => client.deployVersions(versions, message),
        probe: (headers) => probeHealth(env, config, headers),
        sleep, now: Date.now,
      }, {
        worker: config.appWorkerName, from: fromVersion, to: versionId, expectedVersion: release.manifest.version, previousVersion: previousHealthVersion,
        windowMs: config.healthWindowMs, intervalMs: config.healthIntervalMs, label: release.manifest.version,
      });
      if (!trial.ok) {
        await env.WORKEROPS_STATE.put(failedKey(release.manifest.version), JSON.stringify({ at: nowIso(), error: trial.error }));
        await appendEvent(env, "trial", "fail", trial.error);
        await setState(env, { status: "failed_predeploy", finishedAt: nowIso(), error: trial.error });
        await releaseLock(env, lock);
        return response({ error: "trial_failed", detail: trial.error }, 502);
      }
      await appendEvent(env, "trial", "ok", `${release.manifest.version} answered at 0%`);
    }
    await client.deployVersion(versionId, `WorkerOps signed release ${release.manifest.version}`);
    await setState(env, { status: "deployed_unverified", deployedAt: nowIso() });

    ctx.waitUntil((async () => {
      try {
        const deadline = Date.now() + config.healthWindowMs;
        // Only an answer that names the version just deployed counts (health.ts answeredBy):
        // the old version's ok must not confirm the new one.
        let seen = false;
        while (Date.now() < deadline) {
          const result = await probeHealth(env, config);
          if (answeredBy(result, release.manifest.version) === "new") {
            if (!result.ok) throw new Error("new release health check failed");
            seen = true;
            break;
          }
          await sleep(config.healthIntervalMs);
        }
        if (!seen) throw new Error("new release was not observed (no health answer named it)");
        if (config.migratePath) {
          await appendEvent(env, "migrate", "run", config.migratePath);
          if (!await runMigrate(env, config)) throw new Error("migrate failed");
          await appendEvent(env, "migrate", "ok");
        }
        await env.WORKEROPS_STATE.put(VERSION_KEY, release.manifest.version);
        await appendEvent(env, "confirm", "ok", versionId);
        await setState(env, { status: "confirmed", lastGoodVersionId: versionId, lastGoodRelease: release.manifest.version, confirmedAt: nowIso(), finishedAt: nowIso(), error: null });
        await keepGoodCode(env, config, versionId);
      } catch (error) {
        // Not back to a revoked release (billing-operations 5.3節): a person decides then.
        const back = fromVersion && !(await revokedTarget(env, config.productId, current).catch(() => false)) ? fromVersion : null;
        if (back) await restoreVersion(env, client, back, `WorkerOps auto-revert ${release.manifest.version}`, config.bindingTypes);
        await env.WORKEROPS_STATE.put(failedKey(release.manifest.version), JSON.stringify({ at: nowIso(), error: errMsg(error) }));
        await appendEvent(env, "verify", "fail", errMsg(error));
        const why = fromVersion && !back ? `${errMsg(error)}; previous release ${current} is revoked` : errMsg(error);
        await setState(env, { status: back ? "reverted" : "manual_required", finishedAt: nowIso(), error: why });
      } finally {
        await releaseLock(env, lock);
      }
    })());
    return response({ ok: true, status: "deployed_unverified", version: release.manifest.version }, 202);
  } catch (error) {
    await appendEvent(env, "signed_release", "fail", errMsg(error)).catch(() => {});
    await setState(env, { status: "failed_predeploy", finishedAt: nowIso(), error: errMsg(error) }).catch(() => {});
    await releaseLock(env, lock);
    return response({ error: "release_deploy_failed" }, 502);
  }
}
