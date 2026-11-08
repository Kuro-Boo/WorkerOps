// 契約テスト(`npm run test:tick`)。番人の毎分(tick.ts)。
import { appTicks, guardianMinute, runTick } from "./tick";
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
    // 2026-11-08: 回の打ち切りを app に知らせる(KuroCMS の planAutoPass)。
    const opts: unknown[] = [];
    const cuts: number[] = [];
    const env = fakeEnv({ APP_TICK: "1" }).env as unknown as { APP_SERVICE: Record<string, unknown> };
    env.APP_SERVICE.tick = async (_at: number, o: unknown) => void opts.push(o);
    env.APP_SERVICE.tickCut = async (at: number) => void cuts.push(at);
    await runTick(env as unknown as Env, ctx, config, 60_000, { everyMinute: true });
    eq("知らせることを app に伝える", opts, [{ reportsCut: true }]);
    eq("済んだ分は知らせない", cuts, []);
    env.APP_SERVICE.tick = async () => { throw new Error("Worker exceeded CPU time limit."); };
    eq("打ち切られた分は error で返す", (await runTick(env as unknown as Env, ctx, config, 120_000, { everyMinute: true })).app, "error");
    eq("打ち切られた分を tickCut で知らせる", cuts, [120_000]);
    env.APP_SERVICE.tickCut = async () => { throw new Error("The RPC receiver does not implement the method \"tickCut\""); };
    eq("tickCut の無い app でも投げない", (await runTick(env as unknown as Env, ctx, config, 180_000, { everyMinute: true })).app, "error");
  }


  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nall ok");
};
main();
