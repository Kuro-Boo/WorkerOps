// 契約テスト(`npm run test:restart`)。平常運転中に答えなくなった app の再起動(restart.ts)。
import { askedRestart, getRestart, restartTick, RESTART_KEY, type RestartDeps } from "./restart";
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

const reports: string[] = [];
globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
  reports.push(JSON.parse(init?.body ?? "{}").code);
  return new Response("{}");
}) as typeof fetch;

function setup(opts: { status?: string; enabled?: boolean; lock?: boolean; active?: string | null; deployThrows?: boolean } = {}) {
  const store = new Map<string, string>();
  if (opts.status) store.set("workerops:state", JSON.stringify({ status: opts.status, events: [] }));
  if (opts.lock) store.set(LOCK_KEY, JSON.stringify({ at: Date.now(), ttl: 600_000 }));
  let writes = 0;
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { writes++; store.set(k, v); },
    delete: async (k: string) => void store.delete(k),
  };
  const env = {
    WORKEROPS_STATE: ns, CF_ACCOUNT_ID: "a", APP_WORKER_NAME: "app",
    ...(opts.enabled === false ? {} : { APP_RESTART: "1" }),
  } as unknown as Env;
  let healthy = true;
  const deployed: string[] = [];
  const deps: RestartDeps = {
    probe: async () => (healthy ? { ok: true, status: 200 } : { ok: false, status: 503 }),
    client: () => ({
      getActiveVersionId: async () => (opts.active === undefined ? "v-serving" : opts.active),
      deployVersion: async (id: string) => {
        if (opts.deployThrows) throw new Error("10000 auth");
        deployed.push(id);
      },
    }),
  };
  return {
    env, deps, deployed, store,
    setHealthy: (v: boolean) => { healthy = v; },
    writes: () => writes,
  };
}
const config = { lockTtlMs: 120_000, retryMax: 1, retryBaseMs: 1 } as unknown as Config;

const main = async () => {
  {
    const t = setup({ enabled: false });
    t.setHealthy(false);
    eq("APP_RESTART が無ければ何もしない", await restartTick(t.env, config, t.deps), "off");
  }
  {
    const t = setup();
    eq("答えていれば何も書かない", [await restartTick(t.env, config, t.deps), t.writes()], ["healthy", 0]);
    t.setHealthy(false);
    eq("1 回目の失敗は見張るだけ", await restartTick(t.env, config, t.deps), "watching");
    eq("置き直していない", t.deployed, []);
    eq("2 回続けば、動いている版を置き直す", await restartTick(t.env, config, t.deps), "restarted");
    eq("同じ版の ID", t.deployed, ["v-serving"]);
    eq("鍵は返した", t.store.has(LOCK_KEY), false);
    t.setHealthy(true);
    reports.length = 0;
    eq("戻れば不調は終わり", await restartTick(t.env, config, t.deps), "healthy");
    eq("効いた再起動は記録として知らせる", reports, ["workerops_app_restarted"]);
    const r = await getRestart(t.env);
    eq("累計は残り、不調の印は消える", [r.count, r.restarted, r.down, r.failures], [1, false, false, 0]);
  }
  {
    const t = setup();
    t.setHealthy(false);
    await restartTick(t.env, config, t.deps);
    await restartTick(t.env, config, t.deps);
    reports.length = 0;
    eq("置き直した後の 1 回目", await restartTick(t.env, config, t.deps), "watching");
    eq("置き直しても 2 回続けば down", await restartTick(t.env, config, t.deps), "down");
    eq("down は 1 度だけ知らせる", reports, ["workerops_app_down"]);
    const writes = t.writes();
    eq("down の間は二度と置き直さず、書きもしない", [await restartTick(t.env, config, t.deps), t.deployed.length, t.writes() - writes], ["down", 1, 0]);
    t.setHealthy(true);
    eq("戻れば次の不調でまた置き直せる", [await restartTick(t.env, config, t.deps), (await getRestart(t.env)).down], ["healthy", false]);
  }
  for (const status of ["pending", "deployed_unverified"]) {
    const t = setup({ status });
    t.setHealthy(false);
    eq(`更新の最中(${status})は触らない`, [await restartTick(t.env, config, t.deps), t.store.has(RESTART_KEY)], ["busy", false]);
  }
  {
    const t = setup({ lock: true });
    t.setHealthy(false);
    await restartTick(t.env, config, t.deps);
    eq("鍵を app が持っている間は置き直さず、次の回に回す", [await restartTick(t.env, config, t.deps), t.deployed], ["busy", []]);
    t.store.delete(LOCK_KEY);
    eq("鍵が空けば置き直す", await restartTick(t.env, config, t.deps), "restarted");
  }
  {
    const t = setup({ deployThrows: true });
    t.setHealthy(false);
    await restartTick(t.env, config, t.deps);
    reports.length = 0;
    eq("置き直しに失敗したら restart_failed・down", [await restartTick(t.env, config, t.deps), (await getRestart(t.env)).down], ["restart_failed", true]);
    eq("失敗を知らせる", reports, ["workerops_app_down"]);
  }
  {
    const t = setup();
    eq("app から頼まれた再起動", await askedRestart(t.env, config, "admin <script>", t.deps), { ok: true });
    const r = await getRestart(t.env);
    eq("理由は記号を落として残し、不調には数えない", [r.count, r.lastReason, r.restarted], [1, "asked by the app: admin script", false]);
    const u = setup({ status: "deployed_unverified" });
    eq("更新の最中は断る", await askedRestart(u.env, config, "x", u.deps), { ok: false, reason: "update_in_progress" });
    const n = setup({ active: null });
    eq("動いている版が分からなければ置き直さない", await askedRestart(n.env, config, "x", n.deps), { ok: false, reason: "no_active_version" });
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log("restart: all ok");
};
main();
