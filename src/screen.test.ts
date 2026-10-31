// 契約テスト(`npm run test:screen`)。番人の画面と状態を見せるかは Secret OPS_SCREEN で決める。
// 既定は隠す(自社の基盤・Billing・Payout の番人は Entamy 管理画面で操る)。顧客導入は導入口が on を置く。
import { handleOps, maintenancePage } from "./ops";
import { loadConfig } from "./config";
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

const TOKEN = "wops_" + "x".repeat(40);
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const envOf = (screen?: string) => ({
  WORKER_OPS_TOKEN: TOKEN, APP_WORKER_NAME: "app", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t",
  ...(screen === undefined ? {} : { OPS_SCREEN: screen }),
}) as unknown as Env;
const get = (env: Env, path: string, token?: string) =>
  handleOps(new Request(`https://x/__workerops__${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}), env, ctx, loadConfig(env));

for (const screen of [undefined, "", "off", "1"]) {
  const env = envOf(screen);
  eq(`OPS_SCREEN=${screen ?? "(none)"}: 画面は 404`, (await get(env, "/")).status, 404);
  eq(`OPS_SCREEN=${screen ?? "(none)"}: 状態は 404`, (await get(env, "/api/v1/status")).status, 404);
  eq(`OPS_SCREEN=${screen ?? "(none)"}: 違う鍵でも 404`, (await get(env, "/api/v1/auth-check", "wrong")).status, 404);
  eq(`OPS_SCREEN=${screen ?? "(none)"}: 鍵があれば通る`, (await get(env, "/api/v1/auth-check", TOKEN)).status, 200);
  eq(`OPS_SCREEN=${screen ?? "(none)"}: health は開いたまま`, (await get(env, "/api/v1/health")).status, 200);
  eq(`OPS_SCREEN=${screen ?? "(none)"}: 保守の頁に画面への道を出さない`, maintenancePage(loadConfig(env)).includes("__workerops__"), false);
}
{
  const env = envOf("on");
  eq("OPS_SCREEN=on: 画面は公開", (await get(env, "/")).status, 200);
  eq("OPS_SCREEN=on: 操作は鍵が要る", (await get(env, "/api/v1/auth-check")).status, 401);
  eq("OPS_SCREEN=on: 保守の頁に画面への道", maintenancePage(loadConfig(env)).includes("__workerops__"), true);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nscreen contract OK");
