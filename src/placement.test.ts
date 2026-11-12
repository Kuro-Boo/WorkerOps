// 契約テスト(`npm run test:placement`)。Worker を D1 の近くで動かす(placement.ts・placement-map.ts)。
import { PLACEMENT_KEY, placementTick, type PlacementClient } from "./placement";
import { placementOfD1 } from "./placement-map";
import { CfClient } from "./cf";
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

function setup(o: { status?: string; follow?: boolean; checked?: boolean; lock?: boolean; fromD1?: boolean; fromDefault?: boolean; now?: unknown; uploadFails?: boolean } = {}) {
  const store = new Map<string, string>();
  const ttl = new Map<string, number | undefined>();
  store.set("workerops:state", JSON.stringify({ events: [], status: o.status ?? "idle", lastGoodVersionId: "v1" }));
  if (o.checked) store.set(PLACEMENT_KEY, "1");
  if (o.lock) store.set(LOCK_KEY, JSON.stringify({ at: Date.now(), ttl: 600_000, owner: "op:x" }));
  const ns = {
    get: async (k: string, t?: string) => (t === "stream" ? null : store.get(k) ?? null),
    put: async (k: string, v: string, p?: { expirationTtl?: number }) => { store.set(k, v); ttl.set(k, p?.expirationTtl); },
    delete: async (k: string) => void store.delete(k),
  };
  const env = { WORKEROPS_STATE: ns, CF_ACCOUNT_ID: "a", APP_WORKER_NAME: "app", DEFECTS: "off", ...(o.follow ? { FOLLOW_SERVING: "1" } : {}) } as unknown as Env;
  const calls: { placement?: unknown; bindings?: unknown; assets?: unknown; deployed?: string } = {};
  const client = (): PlacementClient => ({
    getSettings: async () => ({
      bindings: [{ type: "d1", name: "DB", id: "x" }, { type: "secret_text", name: "S" }], compatibility_date: "d", compatibility_flags: [],
      fromD1: o.fromD1 !== false, ...(o.fromD1 !== false || o.fromDefault ? { placement: TOKYO } : {}),
      ...(o.fromDefault ? { fromDefault: true } : {}), currentMode: "targeted",
    }),
    currentPlacement: async () => o.now as never,
    uploadModules: async (_c, bindings, _d, _f, assets, placement) => {
      if (o.uploadFails) throw new Error("no");
      Object.assign(calls, { bindings, assets, placement });
      return "v2";
    },
    deployVersion: async (id) => { calls.deployed = id; },
    serving: async () => ({ mainModule: "w.js", modules: [] }),
  });
  const state = () => JSON.parse(store.get("workerops:state")!) as { lastGoodVersionId: string };
  return { env, client, calls, store, ttl, state };
}

const main = async () => {
  eq("東京", placementOfD1("NRT", "APAC"), "aws:ap-northeast-1");
  eq("大阪", placementOfD1("KIX", "APAC"), "aws:ap-northeast-3");
  eq("シンガポール", placementOfD1("SIN", "APAC"), "aws:ap-southeast-1");
  eq("知らない拠点は地域で決める", placementOfD1("XXX", "ENAM"), "aws:us-east-1");
  eq("分からなければ決めない", placementOfD1(undefined, undefined), undefined);

  {
    const s = setup();
    eq("D1 から離れていれば、動いているコードを D1 の近くで出し直す", await placementTick(s.env, config, s.client), "moved");
    eq("地域を渡す", s.calls.placement, TOKYO);
    eq("Secret は引き継ぐ形で渡す", s.calls.bindings, [{ type: "d1", name: "DB", id: "x" }, { type: "inherit", name: "S" }]);
    eq("資産はそのまま", s.calls.assets, undefined);
    eq("配る", s.calls.deployed, "v2");
    eq("戻す先は新しい版", s.state().lastGoodVersionId, "v2");
    eq("1 日は確かめない", s.ttl.get(PLACEMENT_KEY), 86400);
    eq("鍵を返す", s.store.has(LOCK_KEY), false);
    eq("次は待つ", await placementTick(s.env, config, s.client), "waiting");
  }
  {
    const s = setup({ now: TOKYO });
    eq("揃っていれば何もしない", await placementTick(s.env, config, s.client), "current");
    eq("配らない", s.calls.deployed, undefined);
  }
  {
    const s = setup({ fromD1: false });
    eq("D1 が無ければ何もしない", await placementTick(s.env, config, s.client), "no_d1");
    eq("配らない", s.calls.deployed, undefined);
  }
  {
    const s = setup({ fromD1: false, fromDefault: true });
    eq("D1 の場所が分からず、どこにも置かれていなければ既定の場所(東京)へ", await placementTick(s.env, config, s.client), "moved");
    eq("既定の場所を渡す", s.calls.placement, TOKYO);
  }
  for (const [name, o, want] of [
    ["更新の途中は触らない", { status: "deployed_unverified" }, "busy"],
    ["戻して止まっている時は触らない", { status: "manual_required" }, "busy"],
    ["鍵が取られていれば触らない", { lock: true }, "busy"],
    ["前に立つだけの番人は触らない", { follow: true }, "off"],
    ["確かめたばかりなら待つ", { checked: true }, "waiting"],
  ] as const) {
    const s = setup(o);
    eq(name, await placementTick(s.env, config, s.client), want);
    eq(`${name}(配らない)`, s.calls.deployed, undefined);
  }
  {
    const s = setup({ uploadFails: true });
    eq("失敗は 1 時間後に取り直す", [await placementTick(s.env, config, s.client), s.ttl.get(PLACEMENT_KEY)], ["failed", 3600]);
    eq("鍵を返す(失敗)", s.store.has(LOCK_KEY), false);
    eq("戻す先は変えない", s.state().lastGoodVersionId, "v1");
  }

  // ── 版の配備の地域の決め方(cf.ts) ──
  const settingsOf = async (bindings: unknown[], d1: () => Response, region?: unknown, appD1?: () => Promise<{ served_by_colo?: string }>) => {
    const urls: string[] = [];
    globalThis.fetch = (async (u: unknown) => {
      urls.push(String(u));
      if (String(u).endsWith("/settings")) return new Response(JSON.stringify({ success: true, result: { bindings } }));
      return d1();
    }) as typeof fetch;
    const got = await new CfClient("t", "a", "app", { max: 1, baseMs: 1 }).getSettings(region, appD1);
    return [got.placement, got.fromD1];
  };
  const db = [{ type: "d1", name: "DB", id: "db1" }];
  const sin = () => new Response(JSON.stringify({ success: true, result: [{ meta: { served_by_colo: "SIN", served_by_region: "APAC", served_by_primary: true } }] }));
  eq("D1 の近くが版の名指しに勝つ", await settingsOf(db, sin, "aws:ap-northeast-1"), [{ region: "aws:ap-southeast-1" }, true]);
  eq("D1 が読めなければ版の名指し", await settingsOf(db, () => new Response("x", { status: 403 }), "aws:ap-northeast-1"), [TOKYO, false]);
  eq("D1 を持たなければ版の名指し", await settingsOf([], sin, "aws:ap-northeast-1"), [TOKYO, false]);

  eq("番人の束縛で D1 が読めれば API を使わない", await settingsOf(db, () => new Response("x", { status: 403 }), undefined, async () => ({ served_by_colo: "SIN" })), [{ region: "aws:ap-southeast-1" }, true]);
  eq("束縛で分からなければ API で読む", await settingsOf(db, sin, undefined, async () => ({})), [{ region: "aws:ap-southeast-1" }, true]);
  eq("D1 も名指しも今の置き場所も無ければ東京", await settingsOf(db, () => new Response("x", { status: 403 })), [TOKYO, false]);

  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nall ok");
};
void main();
