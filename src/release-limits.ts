/**
 * 番人が受け取る版の大きさの決まり(仕様 workerops-workerops-limits・2026-11-27)。
 *
 * 番人が版から使うのは、実行本体(main_module)・移行(migrations)・設定の値(vars)・静的資産(static_assets)
 * の 4 つだけ。ほかの成果物(役割 asset。KuroCMS の管理画面の部品など)は app が自分で取って確かめるので、
 * 番人は取らず、数えもしない。
 *
 * 決まりは、番人が使う成果物の合計の大きさ 1 つだけ。数とファイルごとの上限は置かない —— 守りたいのは
 * Worker のメモリ(128 MB)で、それは合計で決まる。Worker の大きさの上限を超えた実行本体は、Cloudflare が
 * 受け付けずに断る(番人は上げる前の段で止まり、app は無傷)。
 *
 * このファイルは依存を持たない。版を出す側(Libraries/entamy-connect/ops/release-publish.mjs)も同じ決まりを
 * 読み、番人が断る版は出す前に止める —— 出した後に番人が黙って断り、どの導入にも入らないことを起こさない
 * (2.1.15〜2.1.20 が数の上限で 1 日止まった・2026-11-27)。
 */

export interface LimitArtifact { name: string; role?: string; size: number }

/** 番人が使う成果物の役割(実行本体は main_module の名前で決まる)。 */
const GUARDIAN_ROLES = new Set(["migrations", "vars", "static_assets"]);

/**
 * 番人が使う成果物の合計の上限。
 *
 * 番人は、使う成果物を処理の途中で何重にもメモリに持つ(取り込んだバイト列・文字列に直したもの・JSON を
 * 読んだもの・base64 を戻したもの・送るために包んだもの)。2026-11-27 に、番人の確かめと送る手前までを
 * node で通して一番多いときのメモリを測ると、合計のおよそ 4〜5 倍だった(実行本体だけ 20 MiB で +67 MiB、
 * 静的資産を 1 つ 20 MiB で +82 MiB)。Worker のメモリ 128 MB から、動くための分(20〜30 MB)を除いた
 * 残りを 5 で割り、20 MiB にした。持ち方を変えたら測り直して、この値も直す。
 */
export const GUARDIAN_TOTAL_LIMIT = 20 * 1024 * 1024;

/** 版の成果物のうち、番人が取って使うもの。 */
export function guardianArtifacts<T extends LimitArtifact>(manifest: { main_module?: string; artifacts: T[] }): T[] {
  const main = manifest.main_module ?? "worker.js";
  return manifest.artifacts.filter((a) => a.name === main || (a.role !== undefined && GUARDIAN_ROLES.has(a.role)));
}

/** 番人が使う成果物の合計が上限を超えていれば断る(取りに行く前に、manifest の宣言で)。 */
export function checkGuardianSize(manifest: { main_module?: string; artifacts: LimitArtifact[] }): void {
  const total = guardianArtifacts(manifest).reduce((n, a) => n + a.size, 0);
  if (total > GUARDIAN_TOTAL_LIMIT) {
    throw new Error(`release is too large for the guardian: ${total} bytes (limit ${GUARDIAN_TOTAL_LIMIT})`);
  }
}

/**
 * WorkerOps 1.0.12 までの番人が断る版(版を出す側だけが使う)。この番人は、取らない成果物まで数え、
 * 成果物が 16 個を超える・1 つが 10 MiB(移行は 5 MiB)を超える・全部で 25 MiB を超える版を断る。
 * 1.0.13 からの番人が全部の導入に行き渡ったら、この関数と呼び出しを外す。
 */
export function checkGuardian1012(artifacts: LimitArtifact[]): void {
  const MiB = 1024 * 1024;
  if (artifacts.length > 16) throw new Error(`release carries ${artifacts.length} artifacts; guardians up to WorkerOps 1.0.12 refuse more than 16`);
  let total = 0;
  for (const a of artifacts) {
    const limit = a.role === "migrations" ? 5 * MiB : 10 * MiB;
    if (a.size > limit) throw new Error(`${a.name} is ${a.size} bytes; guardians up to WorkerOps 1.0.12 refuse more than ${limit}`);
    total += a.size;
  }
  if (total > 25 * MiB) throw new Error(`release is ${total} bytes; guardians up to WorkerOps 1.0.12 refuse more than ${25 * MiB}`);
}
