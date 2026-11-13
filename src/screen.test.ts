// 契約テスト(`npm run test:screen`)。番人の画面と状態を見せるかは Secret OPS_SCREEN で決める。
// 既定は隠す(自社の基盤・Billing・Payout の番人は Entamy 管理画面で操る)。顧客運用は導入口が on を置く。
import { handleOps, maintenancePage } from "./ops";
import { forApp, OVERRIDE_HEADER } from "./trial";
import { sameSecret } from "./util";
import { WORKEROPS_VERSION } from "./version";
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

// 断る要求は app に届かせない(課題 91093b53)。PRODUCT_ID の無い番人は app の health で製品を知るが、門が先。
{
  let asked = 0;
  const env = { ...envOf(undefined), APP_SERVICE: { fetch: async () => { asked++; return Response.json({ ok: true }); } } } as unknown as Env;
  await get(env, "/");
  await get(env, "/api/v1/status", "wrong");
  eq("門で断る要求は app を叩かない", asked, 0);
  await get(env, "/api/v1/auth-check", TOKEN);
  eq("鍵のある要求は app に訊いてよい", asked > 0, true);
}
// 守りのヘッダ(課題 46cdf7b7)。
{
  const env = envOf("on");
  const page = await get(env, "/");
  const csp = page.headers.get("content-security-policy") ?? "";
  eq("画面: よその枠に入らない", csp.includes("frame-ancestors 'none'") && page.headers.get("x-frame-options") === "DENY", true);
  eq("画面: 外へ送れない", csp.includes("default-src 'none'") && csp.includes("connect-src 'self'"), true);
  eq("画面: 控えに残さない", page.headers.get("cache-control"), "no-store");
  const json = await get(env, "/api/v1/health");
  eq("JSON: 控えに残さない・種類を当てさせない", [json.headers.get("cache-control"), json.headers.get("x-content-type-options")], ["no-store", "nosniff"]);
  eq("画面の esc は引用符も逃がす", (await page.text()).includes("'\"':'&quot;'"), true);
}
// 版の指定は公開の要求から外す(課題 79262681)。
{
  const plain = new Request("https://x/a");
  eq("ヘッダが無ければ要求はそのまま", forApp(plain) === plain, true);
  const picked = forApp(new Request("https://x/a", { method: "POST", body: "b", headers: { [OVERRIDE_HEADER]: 'app="v"', "x-keep": "1" } }));
  eq("版の指定を外す", picked.headers.has(OVERRIDE_HEADER), false);
  eq("ほかのヘッダと本文は残す", [picked.headers.get("x-keep"), picked.method, await picked.text()], ["1", "POST", "b"]);
}
// 配布の版の口は鍵が要る(課題 3f48bfd1)。
eq("OPS_SCREEN=on: release は鍵が要る", (await get({ ...envOf("on"), PRODUCT_ID: "p" } as unknown as Env, "/api/v1/release")).status, 401);
// 公開の状態は失敗の文を出さない(課題 209e2163)。
{
  const stored = JSON.stringify({
    status: "manual_required", error: "getSettings: HTTP 403 secret words", lastAutoRevertReason: "why", intendedRelease: "1.2.3",
    events: [{ at: "t", step: "migrate", state: "fail", detail: "migration 0001.sql failed: no such table: users" }],
  });
  const kv: Record<string, string> = {
    "workerops:state": stored,
    "workerops:assets": JSON.stringify({ status: "failed", at: "t", files: 1, uploaded: 0, versionId: null, error: "asset words" }),
  };
  const env = {
    ...envOf("on"), PRODUCT_ID: "p",
    WORKEROPS_STATE: { get: async (k: string) => kv[k] ?? null },
    APP_SERVICE: { fetch: async () => Response.json({ ok: true, version: "1.2.2" }) },
  } as unknown as Env;
  const open = await get(env, "/api/v1/status");
  const text = await open.text();
  const body = JSON.parse(text) as { detail: string; state: { status: string; intendedRelease: string; events: Array<Record<string, unknown>> } };
  eq("公開の状態: 文は出ない", ["secret words", "no such table", "asset words", "why"].filter((w) => text.includes(w)), []);
  eq("公開の状態: 状態・段と成否は出る", [body.detail, body.state.status, body.state.events], ["token_required", "manual_required", [{ at: "t", step: "migrate", state: "fail" }]]);
  // 版は鍵が要る(2026-11-13): 版が分かると、その版の既知の穴を狙われる。
  eq("公開の状態: 版は出ない", ["1.2.3", "1.2.2", WORKEROPS_VERSION].filter((v) => text.includes(`"${v}"`)), []);
  // 鍵のある読み取りは Cloudflare と配布基盤にも訊く。試験では外へ出さない。
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  const withToken = await (await get(env, "/api/v1/status", TOKEN)).json() as { state: { intendedRelease: string }; health: { version: string }; self: { version: string } };
  globalThis.fetch = realFetch;
  eq("鍵があれば版は出る", [withToken.state.intendedRelease, withToken.health.version, withToken.self.version], ["1.2.3", "1.2.2", WORKEROPS_VERSION]);
  eq("health: 鍵が無ければ版は出ない", "version" in (await (await get(env, "/api/v1/health")).json() as object), false);
  eq("health: 鍵があれば版が出る", (await (await get(env, "/api/v1/health", TOKEN)).json() as { version: string }).version, WORKEROPS_VERSION);
}
// 鍵の比較(課題 c8ec022f)。
eq("同じ鍵", await sameSecret(TOKEN, TOKEN), true);
eq("長さの違う鍵", await sameSecret(TOKEN + "x", TOKEN), false);
eq("同じ長さの違う鍵", await sameSecret(TOKEN.slice(0, -1) + "y", TOKEN), false);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nscreen contract OK");
