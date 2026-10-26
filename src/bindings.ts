// 更新時に app へ再送信する binding の組み立て。純関数のみ（テストしやすさのため
// worker 依存を持たせない）。

/**
 * app へ再送信する binding を組み立てる。secret は `inherit` で引き継ぐ。
 *
 * ⚠ 既定では【型で絞らない】。かつては許可リスト
 *   (d1,kv_namespace,r2_bucket,plain_text,service) 方式で、そこに無い型が
 *   黙って消えていた。2026-08-13 に kuro.boo の app から `images` binding が
 *   実際に消えた。CF は binding 型を増やし続けるので、知らない型を落とす設計は
 *   必ず破綻する。BINDING_TYPES を明示した場合だけ従来どおり許可リストとして扱う。
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
  allow: Set<string> | null,
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
    // allow が null（BINDING_TYPES 未設定＝既定）なら型を問わず残す。
    if (allow === null || allow.has(t)) out.push(b);
  }
  return out;
}

/**
 * 版が運ぶ設定の値(wrangler.toml の [vars])を、引き継いだ binding に重ねる(2026-10-26・利用者の決定)。
 *
 * 番人は動いている Worker の binding を引き継いでコードだけを入れ替えるので、[vars] に足した値は
 * 番人の道では届かなかった(Billing 0.0.9 の BILLING_ENVIRONMENT)。人の手を要らなくするため、版が値を運ぶ。
 *   ・版にある値は足すか上書きする(plain_text)
 *   ・**版に無い値は消さない** —— 取り違えた時に要る値まで消さないため。要らなくなった値は人が消す
 *   ・同じ名前の別の型(secret・KV など)があれば止める。値で上書きすると、その binding が消える
 */
export function applyVars(
  bindings: unknown[],
  vars: Record<string, string> | null | undefined,
): unknown[] {
  if (!vars) return bindings;
  const out = [...bindings];
  for (const [name, text] of Object.entries(vars)) {
    const at = out.findIndex((b) => (b as { name?: string })?.name === name);
    const binding = { type: "plain_text", name, text };
    if (at < 0) {
      out.push(binding);
      continue;
    }
    const type = (out[at] as { type?: string }).type;
    if (type !== "plain_text") throw new Error(`release var ${name} collides with a ${type} binding`);
    out[at] = binding;
  }
  return out;
}
