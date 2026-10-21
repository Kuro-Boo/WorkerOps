// 契約テスト(`npm run test:defects`)。失敗したときだけ、符号だけを、1回だけ送る。
import { appFailureCode, appRecordCode, lastFailedStep, getState, setState } from "./state";
import { installId, reportDefect } from "./defects";
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

const sent: Array<Record<string, unknown>> = [];
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body)));
  return new Response("{}", { status: 201 });
}) as typeof fetch;

function fakeEnv(extra: Record<string, string> = {}): Env {
  const store = new Map<string, string>();
  return {
    CF_ACCOUNT_ID: "acc123",
    APP_WORKER_NAME: "app",
    OPS_WORKER_NAME: "site",
    PRODUCT_ID: "cms",
    ...extra,
    WORKEROPS_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
  } as unknown as Env;
}

const idle = await getState(fakeEnv());
eq("配備前の失敗", appFailureCode(idle, { status: "failed_predeploy" }), "workerops_app_failed_predeploy");
eq("手当てが要る", appFailureCode(idle, { status: "manual_required" }), "workerops_app_manual_required");
eq("自動の巻き戻し", appFailureCode(idle, { status: "reverted", autoRevertCount: 1 }), "workerops_app_auto_reverted");
eq("人が押した Revert は送らない", appFailureCode(idle, { status: "reverted" }), null);
eq("同じ状態の書き直しは送らない", appFailureCode({ ...idle, status: "manual_required" }, { status: "manual_required" }), null);
eq("成功は不具合としては送らない", appFailureCode(idle, { status: "confirmed" }), null);
eq("確かめが済んだ更新は記録として送る", appRecordCode({ ...idle, status: "deployed_unverified" }, { status: "confirmed" }), "workerops_app_updated");
eq("confirmed の書き直しは送らない", appRecordCode({ ...idle, status: "confirmed" }, { status: "confirmed" }), null);
eq("戻しは記録にしない", appRecordCode(idle, { status: "reverted" }), null);
eq(
  "失敗した段の符号",
  lastFailedStep([
    { at: "", step: "fetch", state: "ok" },
    { at: "", step: "verify", state: "fail" },
    { at: "", step: "revert", state: "run" },
  ]),
  "verify",
);

const env = fakeEnv();
await reportDefect(env, "workerops_app_failed_predeploy", { step: "fetch_release", note: "free text here" });
const body = sent.pop()!;
eq("製品と導入 ID で名乗る", [body.product_id, String(body.install_id).length], ["workerops", 32]);
eq("アカウント ID そのものは送らない", JSON.stringify(body).includes("acc123"), false);
eq("文は落とし、符号だけ送る", body.detail, { app: "cms", step: "fetch_release" });
eq("不具合は record を付けない", body.record, false);
eq("導入 ID は決まった値", await installId(fakeEnv()), await installId(fakeEnv()));

await reportDefect(fakeEnv({ DEFECTS: "off" }), "workerops_app_failed_predeploy", {});
eq("DEFECTS=off は送らない", sent.length, 0);

sent.length = 0;
const e3 = fakeEnv();
await setState(e3, { status: "deployed_unverified", operation: "update", intendedRelease: "v1.10.51", prevAppVersion: "1.10.50" });
await setState(e3, { status: "confirmed" });
await setState(e3, { status: "confirmed" });
eq("確かめが済んだ更新を1回だけ送る", sent.map((x) => x.code), ["workerops_app_updated"]);
eq("記録として送る", sent[0]?.record, true);
eq("どの版からどの版へ", sent[0]?.detail, { app: "cms", operation: "update", release: "v1.10.51", from: "1.10.50" });

if (failed) {
  console.error(`${failed} 件失敗`);
  process.exit(1);
}
