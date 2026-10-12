// 契約テスト(`npm run test:selfcheck`)。
// 「今すぐ確かめる」は窓を早めるだけで、持ち主の止め・連打・同時実行の守りは外さない。
// 守りに当たったときは、GitHub へも Cloudflare へも行かずに返ることを固定する。
import {
  pickVerifyOrigin,
  rememberOrigin,
  selfCheckNow,
  SELF_CHECK_MIN_GAP_MS,
} from "./self-update";
import { WORKEROPS_VERSION } from "./version";
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

function fakeEnv(kv: Record<string, string> = {}): Env {
  const store = new Map(Object.entries(kv));
  return {
    WORKEROPS_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
  } as unknown as Env;
}

const base = {
  selfUpdateEnabled: true,
  token: "t",
  accountId: "a",
  lockTtlMs: 120_000,
} as unknown as Config;

// どの守りでも外へ出ないこと(出たら落とす)。
globalThis.fetch = (async () => {
  throw new Error("must not reach the network");
}) as typeof fetch;

eq(
  "自己更新が切られた番人は何もしない",
  await selfCheckNow(fakeEnv(), { ...base, selfUpdateEnabled: false }, "https://x"),
  { ok: false, error: "self_update_disabled" },
);
eq(
  "1 分以内の確かめは断る",
  await selfCheckNow(
    fakeEnv({ "workerops:self": JSON.stringify({ lastCheckAt: Date.now() - SELF_CHECK_MIN_GAP_MS / 2 }) }),
    base,
    "https://x",
  ),
  { ok: false, error: "too_soon" },
);
eq(
  "更新の最中(ロック)は断る",
  await selfCheckNow(
    fakeEnv({ "workerops:lock": JSON.stringify({ at: Date.now() }) }),
    base,
    "https://x",
  ),
  { ok: false, error: "busy" },
);

// ── 確かめる URL は配る前に確かめる(ルートのホストは自分に届かない・2026-10-12) ──
{
  const env = fakeEnv();
  await rememberOrigin(env, "https://custom.example");
  await rememberOrigin(env, "https://route.example");
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.startsWith("https://route.example")) return new Response("", { status: 522 });
    if (u.startsWith("https://other.example"))
      return Response.json({ ok: true, service: "workerops", version: "0.0.1" });
    return Response.json({ ok: true, service: "workerops", version: WORKEROPS_VERSION });
  }) as typeof fetch;
  const cfg = { ...base, opsPath: "/__workerops__" } as Config;
  eq(
    "きっかけのホストがルートなら、自分に届く別のホストを選ぶ",
    await pickVerifyOrigin(env, cfg, "https://route.example"),
    "https://custom.example",
  );
  eq(
    "別の番人(版が違う)が答えるホストは選ばない",
    await pickVerifyOrigin(fakeEnv(), cfg, "https://other.example"),
    null,
  );
  eq(
    "届くホストが無ければ選ばない(配らない)",
    await pickVerifyOrigin(fakeEnv(), cfg, "https://route.example"),
    null,
  );
}

if (failed) {
  console.error(`${failed} 件失敗`);
  process.exit(1);
}
