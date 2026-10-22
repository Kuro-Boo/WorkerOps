// 契約テスト(`npm run test:tick`)。番人の毎分(tick.ts)と、連絡係からの POST {OPS_PATH}/api/v1/tick。
import { appTicks, guardianMinute, handleRevive, handleTick, runTick, tickAuthorized } from "./tick";
import { conciergeBindings } from "./concierge-revive";
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

const TOKEN = "t".repeat(40);
const kv = { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [] }) };
function fakeEnv(extra: Partial<Env> = {}, app: { tick?: (at: number) => Promise<void> } = {}) {
  const ticks: number[] = [];
  const env = {
    WORKEROPS_STATE: kv,
    APP_SERVICE: { fetch: async () => new Response("app"), tick: app.tick ?? (async (at: number) => void ticks.push(at)) },
    CF_ACCOUNT_ID: "a".repeat(32), APP_WORKER_NAME: "app", CF_API_TOKEN: "x", WORKER_OPS_TOKEN: "y",
    ...extra,
  } as unknown as Env;
  return { env, ticks };
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const config = { opsPath: "/__workerops__", lockTtlMs: 1, healthWindowMs: 1 } as unknown as Config;
const tickReq = (auth?: string) =>
  new Request("https://x.example/__workerops__/api/v1/tick", { method: "POST", headers: auth ? { authorization: auth } : {} });

const main = async () => {
  eq("番人の仕事は 1 分おき(エポックから数える)", [guardianMinute(0), guardianMinute(60_000), guardianMinute(120_000)], [true, false, true]);

  {
    const { env, ticks } = fakeEnv({ APP_TICK: "1" });
    eq("APP_TICK=1 なら app に分を渡す", await runTick(env, ctx, config, 60_000, { everyMinute: true }), { guardian: false, app: "ok" });
    eq("渡した時刻", ticks, [60_000]);
    eq("2 分ごとの cron(古い導入・Admin)は毎回番人の仕事をする", (await runTick(env, ctx, config, 60_000, { everyMinute: false })).guardian, true);
  }
  {
    const { env, ticks } = fakeEnv();
    eq("APP_TICK が無ければ app を呼ばない(Admin の番人など)", await runTick(env, ctx, config, 0, { everyMinute: true }), { guardian: true, app: "off" });
    eq("呼んでいない", ticks, []);
    eq("宣言の判定", appTicks(env), false);
  }
  {
    const { env } = fakeEnv({ APP_TICK: "1" }, { tick: async () => { throw new Error("The RPC receiver does not implement the method \"tick\""); } });
    eq("受け口の無い古い app は error で返す(投げない)", (await runTick(env, ctx, config, 0, { everyMinute: true })).app, "error");
  }

  {
    const { env } = fakeEnv();
    eq("TICK_TOKEN が無ければ口は無い", await tickAuthorized(env, tickReq(`Bearer ${TOKEN}`)), null);
    const res = await handleTick(env, ctx, config, tickReq(`Bearer ${TOKEN}`));
    eq("口が無いときは 404", res.status, 404);
  }
  {
    const { env, ticks } = fakeEnv({ TICK_TOKEN: TOKEN, APP_TICK: "1" });
    eq("違う鍵は 401", (await handleTick(env, ctx, config, tickReq("Bearer nope"))).status, 401);
    eq("鍵が無ければ 401", (await handleTick(env, ctx, config, tickReq())).status, 401);
    const res = await handleTick(env, ctx, config, tickReq(`Bearer ${TOKEN}`));
    eq("合う鍵なら分を進め、app の結果を返す", [res.status, (await res.json() as { app: string }).app], [200, "ok"]);
    eq("app に 1 回渡した", ticks.length, 1);
  }

  {
    const { env } = fakeEnv();
    const req = new Request("https://x.example/__workerops__/api/v1/concierge/revive", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    eq("連絡係を起こす口も TICK_TOKEN が無ければ無い", (await handleRevive(env, config, req)).status, 404);
  }
  {
    const { env } = fakeEnv({ TICK_TOKEN: TOKEN });
    const req = new Request("https://x.example/__workerops__/api/v1/concierge/revive", { method: "POST", headers: { authorization: "Bearer nope" } });
    eq("違う鍵では起こさない", (await handleRevive(env, config, req)).status, 401);
  }
  eq("連絡係の binding: Secret は値を見ずに引き継ぎ、ほかはそのまま", conciergeBindings([
    { type: "plain_text", name: "CF_ACCOUNT_ID", text: "a" },
    { type: "secret_text", name: "CF_API_TOKEN" },
    { type: "secret_text", name: "CONCIERGE_TOKEN" },
    { type: "bogus" },
  ]), [
    { type: "plain_text", name: "CF_ACCOUNT_ID", text: "a" },
    { type: "inherit", name: "CF_API_TOKEN" },
    { type: "inherit", name: "CONCIERGE_TOKEN" },
  ]);

  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nall ok");
};
main();
