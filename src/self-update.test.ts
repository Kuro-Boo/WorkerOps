// 契約テスト (node で直接実行: `npm run test:selfupdate`)。
// 自己更新は「壊れた版に入れ替わると内側から戻せない」唯一の操作なので、
// どの版を取りに行くかを決める 2 つの純粋関数を固定しておく。
import { isNewer, parseAtomTag } from "./release-tag.ts";

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

// ── isNewer: 「厳密に新しいときだけ」入れ替える ────────────────────────
eq("パッチが上", isNewer("v0.1.7", "0.1.6"), true);
eq("マイナーが上", isNewer("v0.2.0", "0.1.99"), true);
eq("メジャーが上", isNewer("v1.0.0", "0.99.99"), true);
eq("同じ版は更新しない", isNewer("v0.1.6", "0.1.6"), false);
eq("古い版へは下げない", isNewer("v0.1.5", "0.1.6"), false);
// ⚠ develop から stable に戻したとき、stable が古ければ据え置きになる。
//    自動でのダウングレードは行わない（意図しない巻き戻しを避ける）。
eq("develop→stable の降格はしない", isNewer("v0.1.6", "0.1.9"), false);
eq("v 有無を混ぜても比較できる", isNewer("0.1.7", "v0.1.6"), true);
// 数字でない版が来たら「更新しない」側に倒す（誤って配備しない）。
eq("壊れたタグは更新しない", isNewer("vX.Y.Z", "0.1.6"), false);
eq("空文字は更新しない", isNewer("", "0.1.6"), false);
eq("2 桁の比較が文字列順にならない", isNewer("v0.1.10", "0.1.9"), true);

// ── parseAtomTag: develop チャンネルのタグ解決 ─────────────────────────
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/Kuro-Boo/WorkerOps/releases</id>
  <title>Release notes from WorkerOps</title>
  <entry>
    <id>tag:github.com,2008:Repository/1263495535/v0.1.7</id>
    <title>WorkerOps v0.1.7</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1263495535/v0.1.6</id>
    <title>WorkerOps v0.1.6</title>
  </entry>
</feed>`;
// フィードの先頭 = 最新。⚠ feed 自身の <id> は Repository/{数字}/ の形ではない
//    ので拾わない（拾うとタグの代わりに URL を掴む）。
eq("最新のタグを取る", parseAtomTag(feed), "v0.1.7");
eq("空のフィードは null", parseAtomTag("<feed></feed>"), null);
eq("タグらしくない値は null", parseAtomTag(
  "<id>tag:github.com,2008:Repository/1/nightly</id>",
), null);
eq("リリースが 1 件でも取れる", parseAtomTag(
  "<id>tag:github.com,2008:Repository/9/v1.2.3</id>",
), "v1.2.3");

console.log("");
if (failed) {
  console.log(`${failed} 件 FAIL`);
  process.exit(1);
}
console.log("すべて OK");
