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
  checkArtifactSizes([a("worker.js", 1024), a("migrations.json", 1024, "migrations")]);
  eq("checkArtifactSizes: ふつうの版は通す", true, true);
  await throws("checkArtifactSizes: 実行本体が 10 MiB を超えれば断る", () => checkArtifactSizes([a("worker.js", 10 * 1024 * 1024 + 1)]));
  await throws("checkArtifactSizes: 移行が 5 MiB を超えれば断る", () => checkArtifactSizes([a("m.json", 5 * 1024 * 1024 + 1, "migrations")]));
  await throws("checkArtifactSizes: 数が多すぎれば断る", () => checkArtifactSizes(Array.from({ length: 17 }, (_, i) => a(`f${i}`, 1))));
  await throws("checkArtifactSizes: 合計が大きすぎれば断る", () => checkArtifactSizes(Array.from({ length: 3 }, (_, i) => a(`f${i}`, 10 * 1024 * 1024))));

  if (failed) {
    console.log(`\n${failed} 件失敗`);
    process.exit(1);
  }
  console.log("\nverify: すべて OK");
};
main();
