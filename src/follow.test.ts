// 契約テスト(`npm run test:follow`)。版を取りに行かない番人が、動いている版を戻す先として覚える(follow.ts)。
import { followTick, FOLLOW_KEY, type FollowDeps } from "./follow";
import { LOCK_KEY } from "./state";
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

function setup(opts: { state?: Record<string, unknown>; source?: "store" | "declared"; enabled?: boolean; lock?: boolean } = {}) {
  const store = new Map<string, string>();
  if (opts.state) store.set("workerops:state", JSON.stringify({ events: [], ...opts.state }));
  if (opts.lock) store.set(LOCK_KEY, JSON.stringify({ at: Date.now(), ttl: 600_000, owner: "op:x" }));
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  // DEFECTS=off: 試験から本番の Defects へ送らない。
  const env = {
    WORKEROPS_STATE: ns, CF_ACCOUNT_ID: "a", APP_WORKER_NAME: "app", DEFECTS: "off",
    ...(opts.enabled === false ? {} : { FOLLOW_SERVING: "1" }),
    ...(opts.source === "store" ? { RELEASE_STORE: {} } : {}),
  } as unknown as Env;
  const now = { healthy: true, version: "0.1.634" as string | undefined, serving: "v-new" as string | null };
  const deps: FollowDeps = {
    probe: async () => (now.healthy
      ? { ok: true, status: 200, version: now.version, ...(opts.source === "declared" ? { productId: "cms" } : {}) }
      : { ok: false, status: 503 }),
    client: () => ({ getActiveVersionId: async () => now.serving }),
  };
  const state = () => JSON.parse(store.get("workerops:state") ?? "{}") as Record<string, unknown>;
  return { env, deps, store, now, state };
}
const config = { lockTtlMs: 120_000, retryMax: 1, retryBaseMs: 1 } as unknown as Config;
const stale = { status: "reverted", lastGoodVersionId: "v-august", lastGoodRelease: null, error: "health check failed" };

const main = async () => {
  for (const [name, o, c] of [
    ["頼まれていなければ何もしない", { enabled: false }, config],
    ["版の置き場(KV)を持つ番人は何もしない", { source: "store" as const }, config],
    ["PRODUCT_ID を持つ番人は何もしない", {}, { ...config, productId: "cms" } as Config],
    ["app が製品を名乗る番人は何もしない", { source: "declared" as const }, config],
  ] as const) {
    const t = setup({ state: stale, ...o });
    eq(name, [await followTick(t.env, c, t.deps), await followTick(t.env, c, t.deps), t.state().lastGoodVersionId, t.store.has(FOLLOW_KEY)], ["off", "off", "v-august", false]);
  }
  {
    const t = setup({ state: stale });
    eq("1 回目は見ただけ(戻す先はまだ変えない)", [await followTick(t.env, config, t.deps), t.state().lastGoodVersionId], ["seen", "v-august"]);
    eq("同じ版が続けて健全なら、戻す先にする", await followTick(t.env, config, t.deps), "followed");
    const s = t.state();
    eq("戻す先・版の名乗り・済んだ戻しの表示", [s.lastGoodVersionId, s.lastGoodRelease, s.status, s.error], ["v-new", "0.1.634", "idle", null]);
    eq("出来事に残す", (s.events as Array<{ step: string; state: string }>).map((e) => `${e.step}:${e.state}`), ["follow:ok"]);
    eq("覚え書きを消し、鍵を返す", [t.store.has(FOLLOW_KEY), t.store.has(LOCK_KEY)], [false, false]);
    eq("もう合っていれば何もしない", await followTick(t.env, config, t.deps), "current");
  }
  {
    const t = setup({ state: stale });
    await followTick(t.env, config, t.deps);
    t.now.healthy = false;
    eq("健全でなくなったら、見た版を忘れる", [await followTick(t.env, config, t.deps), t.store.has(FOLLOW_KEY)], ["unhealthy", false]);
    t.now.healthy = true;
    eq("壊れた版は戻す先にならない(数え直す)", [await followTick(t.env, config, t.deps), t.state().lastGoodVersionId], ["seen", "v-august"]);
  }
  {
    const t = setup({ state: stale });
    await followTick(t.env, config, t.deps);
    t.now.serving = "v-newer";
    eq("動いている版が替わったら数え直す", [await followTick(t.env, config, t.deps), t.state().lastGoodVersionId], ["seen", "v-august"]);
    t.now.version = "0.1.635";
    eq("名乗りが替わっても数え直す(前の版の答えかもしれない)", await followTick(t.env, config, t.deps), "seen");
    eq("揃えば戻す先にする", [await followTick(t.env, config, t.deps), t.state().lastGoodVersionId], ["followed", "v-newer"]);
  }
  {
    const t = setup({ state: stale });
    t.now.serving = null;
    eq("全量を受ける版が 1 つに決まらなければ何もしない", [await followTick(t.env, config, t.deps), await followTick(t.env, config, t.deps), t.state().lastGoodVersionId], ["unknown", "unknown", "v-august"]);
  }
  {
    const t = setup({ state: { ...stale, status: "deployed_unverified" } });
    eq("更新の最中は触らない", [await followTick(t.env, config, t.deps), t.store.has(FOLLOW_KEY)], ["busy", false]);
  }
  {
    const t = setup({ state: stale, lock: true });
    await followTick(t.env, config, t.deps);
    eq("鍵が取れなければ書かない", [await followTick(t.env, config, t.deps), t.state().lastGoodVersionId], ["busy", "v-august"]);
  }
  {
    const t = setup({ state: { ...stale, status: "manual_required", error: "revert failed" } });
    await followTick(t.env, config, t.deps);
    await followTick(t.env, config, t.deps);
    const s = t.state();
    eq("人が見るべき失敗の表示は消さない(戻す先だけ合わせる)", [s.lastGoodVersionId, s.status, s.error], ["v-new", "manual_required", "revert failed"]);
  }
  console.log(failed ? `\n${failed} failed` : "\nall ok");
  if (failed) process.exit(1);
};
void main();
