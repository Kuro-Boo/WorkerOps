// 契約テスト(`npm run test:peer`)。app が番人を更新するときの受け口(peer.ts)。
import { peerHold, peerRelease, peerStatus, HOLD_MAX_MS } from "./peer";
import type { Config } from "./config";
import type { Env } from "./types";
import { WORKEROPS_VERSION } from "./version";

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

function fakeEnv(kv: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(kv));
  const ttls = new Map<string, number | undefined>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      store.set(k, v);
      ttls.set(k, o?.expirationTtl);
    },
    delete: async (k: string) => void store.delete(k),
  };
  return { env: { WORKEROPS_STATE: ns } as unknown as Env, store, ttls };
}

const config = { selfUpdateEnabled: false } as unknown as Config;
const state = (status: string) => JSON.stringify({ status, events: [] });

const main = async () => {
  {
    const { env } = fakeEnv();
    eq("status: 自分の版を名乗り、鍵が無ければ locked=false", await peerStatus(env, config), {
      service: "workerops", version: WORKEROPS_VERSION, state: "idle", selfUpdate: false, locked: false,
    });
  }
  {
    const { env, store, ttls } = fakeEnv();
    eq("hold: 空いていれば取れる", await peerHold(env, 5 * 60 * 1000), { ok: true });
    eq("hold: 鍵を KV に置き、TTL で必ず切れる", [store.has("workerops:lock"), ttls.get("workerops:lock")], [true, 300]);
    eq("status: 取った後は locked=true", (await peerStatus(env, config)).locked, true);
    eq("hold: 取られていれば busy", await peerHold(env, 60_000), { ok: false, reason: "busy" });
    await peerRelease(env);
    eq("release: 鍵を返す", store.has("workerops:lock"), false);
  }
  {
    // 番人自身の操作は 2 分の鍵で判断する。app の 5 分の鍵を 3 分で横取りしない。
    const { env } = fakeEnv();
    await peerHold(env, 5 * 60 * 1000);
    const { acquireLock } = await import("./state");
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 1000;
    eq("鍵: 番人の操作(2 分)は、app の 5 分の鍵を 3 分では取れない", await acquireLock(env, 120_000), false);
    Date.now = () => realNow() + 6 * 60 * 1000;
    eq("鍵: 鍵の期間を過ぎれば取れる", await acquireLock(env, 120_000), true);
    Date.now = realNow;
  }
  {
    const { env, ttls } = fakeEnv();
    await peerHold(env, 24 * 60 * 60 * 1000);
    eq("hold: 長すぎる TTL は上限で切る", ttls.get("workerops:lock"), HOLD_MAX_MS / 1000);
  }
  for (const s of ["pending", "deployed_unverified"]) {
    const { env, store } = fakeEnv({ "workerops:state": state(s) });
    eq(`hold: app の更新が確かめ中(${s})なら断る`, await peerHold(env, 60_000), { ok: false, reason: "update_in_progress" });
    eq(`hold: 断ったときは鍵を置かない(${s})`, store.has("workerops:lock"), false);
  }
  {
    const { env } = fakeEnv({ "workerops:state": state("confirmed") });
    eq("hold: 確定済みなら取れる", await peerHold(env, 60_000), { ok: true });
  }
  if (failed) {
    console.log(`\n${failed} 件失敗`);
    process.exit(1);
  }
  console.log("\npeer: すべて OK");
};
main();
