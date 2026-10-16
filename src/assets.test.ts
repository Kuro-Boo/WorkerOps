// 契約テスト(`npm run test:assets`)。静的資産を出す流れと、資産を残す戻し。
// Cloudflare の挙動そのもの(keep_assets で資産が残る・無ければ消える)は
// 2026-10-16 に試験用 Worker で確かめた。ここはこちらの手順を固定する。
import { publishAssets, restoreVersion, keepGoodCode, validateManifest, hasPublishedAssets } from "./assets";
import { CfClient } from "./cf";
import type { Config } from "./config";
import type { Env } from "./types";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
};

function fakeEnv(kv: Record<string, string> = {}): Env & { store: Map<string, { v: unknown; m?: unknown }> } {
  const store = new Map<string, { v: unknown; m?: unknown }>(Object.entries(kv).map(([k, v]) => [k, { v }]));
  const ns = {
    get: async (k: string, type?: string) => {
      const e = store.get(k);
      if (!e) return null;
      if (type === "stream") return new Response(e.v as BodyInit).body;
      return e.v;
    },
    getWithMetadata: async (k: string) => {
      const e = store.get(k);
      return { value: e?.v ?? null, metadata: e?.m ?? null };
    },
    put: async (k: string, v: unknown, o?: { metadata?: unknown }) => void store.set(k, { v, m: o?.metadata }),
    delete: async (k: string) => void store.delete(k),
  };
  return { WORKEROPS_STATE: ns, store } as unknown as Env & { store: Map<string, { v: unknown; m?: unknown }> };
}

const config = {
  token: "t", accountId: "a", appWorkerName: "app", retryMax: 1, retryBaseMs: 1, bindingTypes: null,
} as unknown as Config;

const multipart = async (code: string) => {
  const fd = new FormData();
  fd.append("worker.js", new File([code], "worker.js", { type: "application/javascript+module" }));
  const r = new Response(fd);
  return { contentType: r.headers.get("content-type")!, mainModule: "worker.js", body: await r.arrayBuffer() };
};

function fakeCf(opts: { buckets?: string[][]; code?: string; latest?: string } = {}) {
  const calls: Array<[string, unknown]> = [];
  const cf = {
    assetsUploadSession: async (m: unknown) => { calls.push(["session", Object.keys(m as object).length]); return { jwt: "upload-jwt", buckets: opts.buckets ?? [] }; },
    uploadAssetBucket: async (jwt: string, files: Array<{ hash: string; type: string }>) => {
      calls.push(["bucket", [jwt, files.map((f) => `${f.hash.slice(0, 2)}:${f.type}`)]]);
      return calls.filter((c) => c[0] === "bucket").length === (opts.buckets ?? []).length ? "done-jwt" : null;
    },
    getContentRaw: async () => { calls.push(["content", null]); return multipart(opts.code ?? "export default {}"); },
    getActiveVersionId: async () => "v-active",
    getLatestVersionId: async () => opts.latest ?? "v-active",
    getSettings: async () => ({ bindings: [{ type: "d1", name: "DB" }, { type: "secret_text", name: "S" }], compatibility_date: "2026-05-13", compatibility_flags: [] }),
    uploadModules: async (code: { modules: File[] }, bindings: unknown[], _d: string, _f: string[], assets?: unknown) => {
      calls.push(["upload", { modules: code.modules.map((m) => m.name), code: await code.modules[0]!.text(), bindings, assets: assets ?? null }]);
      return "v-new";
    },
    deployVersion: async (id: string) => void calls.push(["deploy", id]),
  };
  return { cf: cf as unknown as CfClient, calls };
}

const h = (c: string) => c.repeat(32);
const manifest = {
  "/index.html": { hash: h("a"), size: 3, type: "text/html" },
  "/post/index.html": { hash: h("b"), size: 3, type: "text/html" },
  "/style.css": { hash: h("c"), size: 3, type: "text/css" },
};
const source = (drop: string[] = []) => ({
  asked: [] as string[][],
  async read(hashes: string[]) { this.asked.push(hashes); return hashes.filter((x) => !drop.includes(x)).map((x) => ({ hash: x, base64: "eA==" })); },
});

// ── 出す ──
{
  const env = fakeEnv({ "workerops:state": JSON.stringify({ status: "confirmed", lastGoodVersionId: "v-old" }) });
  const { cf, calls } = fakeCf({ buckets: [[h("b")], [h("c")]], code: "CODE-NOW" });
  const src = source();
  const r = await publishAssets(env, config, manifest, src, {}, cf);
  eq("出せた", r, { ok: true, status: "published", versionId: "v-new", files: 3, uploaded: 2 });
  eq("頼まれたファイルだけ app に聞く", src.asked, [[h("b")], [h("c")]]);
  eq("ファイルは上げ口の鍵で、型付きで送る", calls.filter((c) => c[0] === "bucket").map((c) => c[1]), [["upload-jwt", ["bb:text/html"]], ["upload-jwt", ["cc:text/css"]]]);
  const up = calls.find((c) => c[0] === "upload")![1] as { code: string; bindings: unknown[]; assets: unknown };
  eq("版は今のコードで作る", up.code, "CODE-NOW");
  eq("版は完了の鍵と既定の配り方を持つ", up.assets, { jwt: "done-jwt", config: { html_handling: "auto-trailing-slash", not_found_handling: "none" } });
  eq("secret は inherit で引き継ぐ", up.bindings, [{ type: "d1", name: "DB" }, { type: "inherit", name: "S" }]);
  eq("100% に出す", calls.filter((c) => c[0] === "deploy").map((c) => c[1]), ["v-new"]);
  eq("同じコードなので last-good も新しい版", JSON.parse(env.store.get("workerops:state")!.v as string).lastGoodVersionId, "v-new");
  eq("初回は今のコードを last-good のコードとして持つ", env.store.has("workerops:code:good"), true);
  eq("出したことが残る", await hasPublishedAssets(env), true);
  eq("鍵は返す", env.store.has("workerops:lock"), false);
}
{
  const env = fakeEnv();
  const { cf, calls } = fakeCf({ buckets: [] });
  const r = await publishAssets(env, config, manifest, source(), {}, cf);
  eq("全部上げ済みなら上げずに session の鍵で版を作る", [r.ok, (calls.find((c) => c[0] === "upload")![1] as { assets: { jwt: string } }).assets.jwt], [true, "upload-jwt"]);
}

// ── 出さない ──
{
  const env = fakeEnv({ "workerops:state": JSON.stringify({ status: "deployed_unverified" }) });
  const { cf, calls } = fakeCf();
  eq("更新の確かめ中は busy", await publishAssets(env, config, manifest, source(), {}, cf), { ok: false, status: "busy", error: "update_in_progress" });
  eq("busy のときは Cloudflare に行かない", calls.length, 0);
}
{
  const env = fakeEnv({ "workerops:lock": JSON.stringify({ at: Date.now() }) });
  const { cf } = fakeCf();
  eq("他の操作中は busy", (await publishAssets(env, config, manifest, source(), {}, cf)).status, "busy");
}
{
  const env = fakeEnv();
  const { cf, calls } = fakeCf({ buckets: [[h("b")]] });
  const r = await publishAssets(env, config, manifest, source([h("b")]), {}, cf);
  eq("app が返さなければ途中まで(partial)", [r.ok, r.status], [false, "partial"]);
  eq("途中なら版を出さない", calls.some((c) => c[0] === "deploy"), false);
}
{
  const env = fakeEnv();
  const { cf, calls } = fakeCf({ buckets: [[h("b"), h("c")]] });
  const r = await publishAssets(env, config, manifest, source([h("c")]), {}, cf);
  eq("束の一部しか返らなくても、返った分は上げる(次の回は残りだけ)", [r.status, calls.filter((c) => c[0] === "bucket").map((c) => c[1])], ["partial", [["upload-jwt", ["bb:text/html"]]]]);
  eq("一度も出していなければ「出した」にしない", await hasPublishedAssets(env), false);
  eq("失敗でも鍵は返す", env.store.has("workerops:lock"), false);
}
{
  const env = fakeEnv();
  const { cf, calls } = fakeCf({ latest: "v-uploaded-not-deployed" });
  const r = await publishAssets(env, config, manifest, source(), {}, cf);
  eq("最後に上げた版が公開中でなければ出さない(content/v2 はそちらを返す)", [r.ok, calls.some((c) => c[0] === "content" || c[0] === "deploy")], [false, false]);
}
{
  const env = fakeEnv();
  const { cf, calls } = fakeCf();
  const r = await publishAssets(env, config, {}, source(), {}, cf);
  const up = calls.find((c) => c[0] === "upload")![1] as { assets: unknown };
  eq("空の一覧は資産を全部外す(上げ口は開かない・資産なしの版)", [r.ok, calls.some((c) => c[0] === "session"), up.assets], [true, false, "none"]);
}
eq("相対パスは拒む", validateManifest({ "a.html": { hash: h("a"), size: 1, type: "" } }), "bad path a.html");
eq("ハッシュの形", validateManifest({ "/a": { hash: "xyz", size: 1, type: "" } }), "bad hash for /a");
eq("25 MiB を超えるファイル", validateManifest({ "/a": { hash: h("a"), size: 26 * 1024 * 1024, type: "" } }), "bad size for /a");

// ── 戻す ──
{
  const env = fakeEnv();
  const { cf, calls } = fakeCf();
  const r = await restoreVersion(env, cf, "v-good", "m", null);
  eq("資産を出したことが無ければ、今までどおり版 ID へ戻す", [r, calls.map((c) => c[0])], [{ how: "version", versionId: "v-good" }, ["deploy"]]);
}
{
  const env = fakeEnv({ "workerops:assets": JSON.stringify({ status: "published" }) });
  const raw = await multipart("GOOD-CODE");
  env.store.set("workerops:code:good", { v: raw.body, m: { contentType: raw.contentType, mainModule: "worker.js" } });
  const { cf, calls } = fakeCf();
  const r = await restoreVersion(env, cf, "v-good", "m", null);
  const up = calls.find((c) => c[0] === "upload")![1] as { code: string; assets: unknown };
  eq("資産があれば last-good のコードで新しい版", [r, up.code], [{ how: "code", versionId: "v-new" }, "GOOD-CODE"]);
  eq("その版は資産を渡さない(=keep_assets で今の資産を残す)", up.assets, null);
}
{
  const env = fakeEnv({ "workerops:assets": JSON.stringify({ status: "published" }) });
  const { cf } = fakeCf();
  eq("コードを持っていなければ版 ID へ戻す", (await restoreVersion(env, cf, "v-good", "m", null)).how, "version");
}
{
  const env = fakeEnv();
  await keepGoodCode(env, config, "v1");
  eq("資産の無い app では確定のたびにコードを持たない", env.store.has("workerops:code:good"), false);
}

// ── 版の metadata ──
{
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const meta = (init?.body as FormData).get("metadata") as File;
    sent.push(JSON.parse(await meta.text()));
    return new Response(JSON.stringify({ success: true, result: { id: "v" } }));
  }) as typeof fetch;
  const cf = new CfClient("t", "a", "app", { max: 1, baseMs: 1 });
  await cf.uploadVersion("x", [], "2026-05-13", []);
  await cf.uploadVersion("x", [], "2026-05-13", [], { jwt: "j" });
  await cf.uploadVersion("x", [], "2026-05-13", [], "none");
  eq("コードの更新は keep_assets: true", sent[0]!.keep_assets, true);
  eq("資産を渡すときは keep_assets を付けない", [sent[1]!.keep_assets, sent[1]!.assets], [undefined, { jwt: "j" }]);
  eq("外すときはどちらも付けない", [sent[2]!.keep_assets, sent[2]!.assets], [undefined, undefined]);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
