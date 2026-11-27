// 契約テスト(`npm run test:verify`)。配った後の確かめ: 旧版の ok で新版を確定しない(課題 00af7a01)。
import { answeredBy, type HealthResult } from "./health";
import { watchdogTick } from "./orchestrator";
import { loadConfig } from "./config";
import { checkArtifactSizes, readCapped } from "./signed-release";
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
const throws = async (name: string, f: () => unknown) => {
  try { await f(); eq(name, "no error", "error"); } catch { eq(name, "error", "error"); }
};

const h = (ok: boolean, version?: string): HealthResult => ({ ok, status: ok ? 200 : 500, ...(version ? { version } : {}) });

function fakeEnv(state: Record<string, unknown>, answer: { ok: boolean; version?: string }) {
  const store = new Map<string, string>([["workerops:state", JSON.stringify(state)]]);
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  const env = {
    WORKEROPS_STATE: ns,
    APP_SERVICE: { fetch: async () => new Response(JSON.stringify(answer), { status: answer.ok ? 200 : 500 }) },
    APP_WORKER_NAME: "app", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "t",
    // 試験から本番の Defects へ送らない(既定は送る)。
    DEFECTS: "off",
  } as unknown as Env;
  return { env, state: () => JSON.parse(store.get("workerops:state")!), store };
}

const unverified = (extra: Record<string, unknown> = {}) => ({
  status: "deployed_unverified", deployedAt: new Date(Date.now() - 3600_000).toISOString(),
  intendedRelease: "1.2.0", prevAppVersion: "1.1.0", toVersionId: "new-id", lastGoodVersionId: null, events: [],
  autoRevertCount: 0, ...extra,
});

const main = async () => {
  eq("answeredBy: 上げた版を名乗れば new", answeredBy(h(true, "1.2.0"), "1.2.0"), "new");
  eq("answeredBy: 旧版の ok は unknown", answeredBy(h(true, "1.1.0"), "1.2.0"), "unknown");
  eq("answeredBy: 版を名乗らない ok は unknown", answeredBy(h(true), "1.2.0"), "unknown");
  eq("answeredBy: 上げる版が分からなければ unknown", answeredBy(h(true, "1.2.0"), null), "unknown");

  const config = loadConfig({ APP_WORKER_NAME: "app", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "t" } as unknown as Env);
  {
    const t = fakeEnv(unverified(), { ok: true, version: "1.1.0" });
    await watchdogTick(t.env, config);
    eq("見張り: 窓の後も旧版が ok を返すだけなら確定しない", t.state().status !== "confirmed", true);
    eq("見張り: last-good を新版で汚さない", t.state().lastGoodVersionId, null);
    eq("見張り: 鍵を残さない", t.store.has("workerops:lock"), false);
  }
  {
    const t = fakeEnv(unverified(), { ok: true });
    await watchdogTick(t.env, config);
    eq("見張り: 版を名乗らない ok では確定しない", t.state().status !== "confirmed", true);
  }
  {
    const t = fakeEnv(unverified(), { ok: true, version: "1.2.0" });
    await watchdogTick(t.env, config);
    eq("見張り: 新版が名乗って ok なら確定する", t.state().status, "confirmed");
    eq("見張り: 確定した版を last-good にする", t.state().lastGoodVersionId, "new-id");
  }
  {
    const t = fakeEnv(unverified(), { ok: true, version: "1.2.0" });
    t.store.set("workerops:lock", JSON.stringify({ at: Date.now(), ttl: 600_000, owner: "op:x" }));
    await watchdogTick(t.env, config);
    eq("見張り: 確かめ中の操作が鍵を持つ間は触らない", t.state().status, "deployed_unverified");
    eq("見張り: 他の操作の鍵を消さない", t.store.has("workerops:lock"), true);
  }

  {
    // 取り消しの一覧に載った版へは戻さない(billing-operations 5.3節・課題 b8bbbcbe)
    const t = fakeEnv(unverified({ lastGoodVersionId: "old-id", lastGoodRelease: "1.1.0" }), { ok: true, version: "1.1.0" });
    const kv = new Map([["release/billing/revoked.json", JSON.stringify(["1.1.0"])]]);
    (t.env as unknown as Record<string, unknown>).RELEASE_STORE = { get: async (k: string) => kv.get(k) ?? null };
    const c = loadConfig({ APP_WORKER_NAME: "app", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "t", PRODUCT_ID: "billing" } as unknown as Env);
    await watchdogTick(t.env, c);
    eq("戻し: last-good が取り消された版なら戻さず人を呼ぶ", t.state().status, "manual_required");
    eq("戻し: 理由に取り消しを書く", /revoked/.test(t.state().error), true);
  }

  // サイズの上限(課題 c1f5e404)
  const stream = (n: number, chunk = 1024) => new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < n; i += chunk) c.enqueue(new Uint8Array(Math.min(chunk, n - i))); c.close(); },
  });
  eq("readCapped: 上限までは読む", (await readCapped(stream(4096), 4096, "x")).byteLength, 4096);
  await throws("readCapped: 上限を 1 バイトでも超えれば止める", () => readCapped(stream(4097), 4096, "x"));
  {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024 * 1024)); } });
    await throws("readCapped: 終わらない応答でも読み切らずに止める", () => readCapped(endless, 2 * 1024 * 1024, "x"));
    eq("readCapped: 上限を超えたところで読むのをやめる", pulled <= 4, true);
  }
  const a = (name: string, size: number, role?: string) => ({ name, size, sha256: "0".repeat(64), ...(role ? { role } : {}) });
  const MiB = 1024 * 1024;
  const m = (...artifacts: ReturnType<typeof a>[]) => ({ main_module: "worker.js", artifacts });
  checkArtifactSizes(m(a("worker.js", 1024), a("migrations.json", 1024, "migrations")));
  eq("checkArtifactSizes: ふつうの版は通す", true, true);
  // 2026-11-27: KuroCMS 2.1.15〜2.1.20 は管理画面の部品が増えて成果物が 22 個になり、数の上限(16)で断られた。
  checkArtifactSizes(m(a("worker.js", 1024), ...Array.from({ length: 40 }, (_, i) => a(`admin-app.l${i}.js`, MiB, "asset"))));
  eq("checkArtifactSizes: 数では断らない・番人が使わない部品(asset)は大きさに数えない", true, true);
  checkArtifactSizes(m(a("worker.js", 12 * MiB), a("migrations.json", 6 * MiB, "migrations")));
  eq("checkArtifactSizes: ファイルごとの上限は置かない(合計で縛る)", true, true);
  await throws("checkArtifactSizes: 番人が使うものの合計が上限を超えれば断る",
    () => checkArtifactSizes(m(a("worker.js", 15 * MiB), a("static-assets.json", 6 * MiB, "static_assets"))));
  {
    const { guardianArtifacts } = await import("./release-limits");
    const names = guardianArtifacts({ main_module: "app.js", artifacts: [a("app.js", 1), a("migrations.json", 1, "migrations"),
      a("vars.json", 1, "vars"), a("static-assets.json", 1, "static_assets"), a("admin-app.x.js", 1, "asset"), a("worker.js", 1)] }).map((x) => x.name);
    eq("guardianArtifacts: 番人が取るのは実行本体・移行・設定・静的資産だけ", names, ["app.js", "migrations.json", "vars.json", "static-assets.json"]);
    const { checkGuardian1012 } = await import("./release-limits");
    await throws("checkGuardian1012: 1.0.12 までの番人は 17 個の版を断る(出す側が止める)", () => checkGuardian1012(Array.from({ length: 17 }, (_, i) => a(`f${i}`, 1))));
    const { reasonToken } = await import("./state");
    eq("reasonToken: 断りの理由を Defects に載る短い符号にする", reasonToken("release carries too many artifacts"), "release_carries_too_many_artifacts");
  }
  if (failed) {
    console.log(`\n${failed} 件失敗`);
    process.exit(1);
  }
  console.log("\nverify: すべて OK");
};
main();
