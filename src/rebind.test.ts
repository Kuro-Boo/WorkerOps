// 契約テスト(`npm run test:rebind`)。app の設定の値を、番人が D1 の近くで出し直す(rebind.ts)。
import { applyRebind, rebindApp, type RebindClient } from "./rebind";
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

const config = { lockTtlMs: 120_000, retryMax: 1, retryBaseMs: 1, appWorkerName: "app", accountId: "a", token: "t", bindingTypes: null } as unknown as Config;
const TOKYO = { region: "aws:ap-northeast-1" };
const MAIL = { type: "send_email", name: "EMAIL", allowed_sender_addresses: ["noreply@example.invalid"] };
const FROM = { type: "plain_text", name: "MAIL_FROM", text: "noreply@example.invalid" };

function setup(o: { status?: string; lock?: boolean; uploadFails?: boolean; extra?: unknown[] } = {}) {
  const store = new Map<string, string>();
  store.set("workerops:state", JSON.stringify({ events: [], status: o.status ?? "idle", lastGoodVersionId: "v1" }));
  if (o.lock) store.set(LOCK_KEY, JSON.stringify({ at: Date.now(), ttl: 600_000, owner: "op:x" }));
  const ns = {
    get: async (k: string, t?: string) => (t === "stream" ? null : store.get(k) ?? null),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  const env = { WORKEROPS_STATE: ns, CF_ACCOUNT_ID: "a", APP_WORKER_NAME: "app", DEFECTS: "off" } as unknown as Env;
  const calls: { placement?: unknown; bindings?: unknown; assets?: unknown; deployed?: string; message?: string } = {};
  const client = (): RebindClient => ({
    getSettings: async () => ({
      bindings: [{ type: "d1", name: "DB", id: "x" }, { type: "secret_text", name: "S" }, ...(o.extra ?? [])],
      compatibility_date: "d", compatibility_flags: [], fromD1: true, placement: TOKYO,
    }),
    uploadModules: async (_c, bindings, _d, _f, assets, placement) => {
      if (o.uploadFails) throw new Error("no");
      Object.assign(calls, { bindings, assets, placement });
      return "v2";
    },
    deployVersion: async (id, message) => { calls.deployed = id; calls.message = message; },
    serving: async () => ({ mainModule: "w.js", modules: [] }),
  });
  const state = () => JSON.parse(store.get("workerops:state")!) as { lastGoodVersionId: string };
  return { env, client, calls, store, state };
}

const main = async () => {
  // ── 何を変えてよいか(applyRebind) ──
  const now = [{ type: "d1", name: "DB", id: "x" }, { type: "inherit", name: "S" }, MAIL, FROM];
  eq("足す(同じ名前は置き換える)", applyRebind(now, { add: [{ ...FROM, text: "b@example.invalid" }] }),
    { bindings: [now[0], now[1], MAIL, { ...FROM, text: "b@example.invalid" }] });
  eq("外す", applyRebind(now, { remove: ["EMAIL", "MAIL_FROM"] }), { bindings: [now[0], now[1]] });
  eq("D1 などは足せない", applyRebind(now, { add: [{ type: "d1", name: "OTHER", id: "y" }] }), { error: "OTHER: d1 cannot be set by the app" });
  eq("Secret は外せない", applyRebind(now, { remove: ["S"] }), { error: "S is a inherit binding" });
  eq("D1 の名前で値を足せない", applyRebind(now, { add: [{ type: "plain_text", name: "DB", text: "x" }] }), { error: "DB is a d1 binding" });
  eq("名前の形を確かめる", applyRebind(now, { remove: ["bad name"] }), { error: "bad name: bad name" });
  eq("何も無ければ断る", applyRebind(now, {}), { error: "nothing to change" });

  {
    const s = setup();
    const r = await rebindApp(s.env, config, { add: [MAIL, FROM] }, s.client);
    eq("今のコードで出し直す", r, { ok: true, status: "rebound", versionId: "v2" });
    eq("D1 の近くに置く", s.calls.placement, TOKYO);
    eq("Secret は引き継ぐ形で渡す", s.calls.bindings, [{ type: "d1", name: "DB", id: "x" }, { type: "inherit", name: "S" }, MAIL, FROM]);
    eq("資産はそのまま", s.calls.assets, undefined);
    eq("配る", [s.calls.deployed, s.calls.message], ["v2", "WorkerOps settings +EMAIL +MAIL_FROM"]);
    eq("戻す先は新しい版", s.state().lastGoodVersionId, "v2");
    eq("鍵を返す", s.store.has(LOCK_KEY), false);
  }
  for (const [name, o] of [
    ["更新の途中は触らない", { status: "deployed_unverified" }],
    ["鍵が取られていれば触らない", { lock: true }],
  ] as const) {
    const s = setup(o);
    eq(name, (await rebindApp(s.env, config, { add: [MAIL] }, s.client)).status, "busy");
    eq(`${name}(配らない)`, s.calls.deployed, undefined);
  }
  {
    const s = setup();
    eq("許されない変更は配らない", (await rebindApp(s.env, config, { remove: ["DB"] }, s.client)).status, "invalid");
    eq("配らない(許されない)", s.calls.deployed, undefined);
    eq("鍵を返す(許されない)", s.store.has(LOCK_KEY), false);
  }
  {
    const s = setup({ uploadFails: true });
    eq("上げられなければ失敗", (await rebindApp(s.env, config, { add: [MAIL] }, s.client)).status, "failed");
    eq("戻す先は変えない", s.state().lastGoodVersionId, "v1");
    eq("鍵を返す(失敗)", s.store.has(LOCK_KEY), false);
  }

  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nrebind: all ok");
};
main();
