// 更新時に app へ再送信する binding の組み立て。純関数のみ（テストしやすさのため
// worker 依存を持たせない）。

/**
 * 再送信できる binding だけ残し、secret は `inherit` で引き継ぐ。
 *
 * ⚠ かつてここは「secret は勝手に残る」として secret_text を単に捨てていたが、
 *   それが成り立つのは【script の PUT】であって、WorkerOps が使う
 *   `POST /versions` には当てはまらない。版は bindings の完全なスナップショット
 *   なので、落とせばその版から secret が消える。2026-08-13 に kuro.boo で実際に
 *   app の CF_API_TOKEN が消え、CMS の自己更新が "cf_creds_missing" で止まった。
 *   値は API から読めないため、`{type:"inherit", name}` で「既存を引き継ぐ」と
 *   宣言する（POST /versions が受理することを実測で確認）。
 */
export function filterBindings(
  bindings: unknown[],
  allow: Set<string>,
): unknown[] {
  const out: unknown[] = [];
  for (const b of bindings ?? []) {
    const t = (b as { type?: string })?.type;
    const name = (b as { name?: string })?.name;
    if (typeof t !== "string") continue;
    if (t === "secret_text" || t === "inherit") {
      if (typeof name === "string" && name) out.push({ type: "inherit", name });
      continue;
    }
    if (allow.has(t)) out.push(b);
  }
  return out;
}
