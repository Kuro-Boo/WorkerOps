// 契約テスト (node で直接実行: `npm run test:bindings`)。
// 更新時に app の binding を取りこぼさないことを固定する。
import { filterBindings } from "./bindings.ts";

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

const allow = new Set([
  "d1",
  "kv_namespace",
  "r2_bucket",
  "plain_text",
  "service",
]);
const f = (b: unknown[]) => filterBindings(b, allow);

// ⚠ 本丸。secret を落とすと POST /versions は「secret の無い版」を作り、
//   その版が展開された瞬間に app から secret が消える（2026-08-13 の実害）。
eq(
  "secret_text は inherit に変換して残す",
  f([{ type: "secret_text", name: "CF_API_TOKEN" }]),
  [{ type: "inherit", name: "CF_API_TOKEN" }],
);
eq(
  "既に inherit のものもそのまま引き継ぐ",
  f([{ type: "inherit", name: "X" }]),
  [{ type: "inherit", name: "X" }],
);
eq("名前の無い secret は捨てる", f([{ type: "secret_text" }]), []);

eq(
  "許可された型はそのまま",
  f([
    { type: "d1", name: "DB", id: "x" },
    { type: "service", name: "APP_SERVICE", service: "app" },
  ]),
  [
    { type: "d1", name: "DB", id: "x" },
    { type: "service", name: "APP_SERVICE", service: "app" },
  ],
);
eq("未許可の型は捨てる", f([{ type: "mystery", name: "M" }]), []);
eq("type が無い要素は捨てる", f([{ name: "X" }]), []);
eq("空配列", f([]), []);

// KuroCMS app の実構成（2026-08-13 の kuro.boo）で取りこぼしが無いこと
eq(
  "実構成: secret を含む全 binding が残る",
  f([
    { type: "plain_text", name: "ACCESS_ADMIN_URL", text: "/kurocms/admin" },
    { type: "plain_text", name: "CF_ACCOUNT_ID", text: "acc" },
    { type: "secret_text", name: "CF_API_TOKEN" },
    { type: "plain_text", name: "CF_WORKER_NAME", text: "w" },
    { type: "d1", name: "DB", id: "d" },
    { type: "r2_bucket", name: "MEDIA_BUCKET", bucket_name: "b" },
    { type: "kv_namespace", name: "PUBLIC_PAGES", namespace_id: "k" },
    { type: "plain_text", name: "SITE_DEFAULT_LANG", text: "ja" },
  ]).length,
  8,
);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
