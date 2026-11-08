/**
 * 確かめてから配る(update-mgmt-s11 11.1.1節・2026-11-06)。
 *
 * 番人のふだんの形は「配ってから確かめる」で、反映から確認までの間、壊れた版が本番の要求を受ける。
 * 基盤のサービスは API で、要求が毎回 Worker に届き、呼び出し元へ連鎖するので、この窓が実害になる。
 *
 * そこで、上げた版を**本番の要求が 0% の版**として載せ(今の版 100% と並べる)、確かめの要求だけを
 * その版へ向ける。向けるのは Cloudflare の版の指定(要求ごとの `Cloudflare-Workers-Version-Overrides`)。
 * Service Binding の fetch でも効き、RPC では効かない(公式の文書・2026-11-06 に確かめた)。
 * 指した版がその配備に無ければ、指定は黙って無視され、要求は今の版へ行く —— だから**上げた版の番号を名乗った
 * ことを見てから**良しとする(旧版の ok で確かめたことにしない・11.4節)。今の版が何を名乗るかは要らない
 * (名乗らない古い版からでも上げられる・2026-11-06 statistics 0.1.8 → 0.1.9)。今の版が同じ番号を名乗るとき
 * (入れ直し)だけは見分けられないので、載せずに止める。
 *
 * プレビューの URL は使わない: workers_dev を切った Worker では既定で出ず、出すと誰でも開ける公開の URL になり、
 * Durable Object を持つ Worker には作られない(同)。Durable Object を持つ Worker は版を分けた配備の振る舞いが
 * 違うので、この段に通さない(呼ぶ側が TRIAL_BEFORE_DEPLOY を付けない)。
 *
 * 0% の版を Cloudflare の API が受けるかは、文書どうしが食い違っている(版の指定の頁は 0% を挙げ、API の頁は
 * 下限 0.01)。wrangler は 0 をそのまま送る。断られたら**本番を変えずに止める**(0.01% に落とさない ——
 * 落とすと本番の要求の一部が確かめていない版へ行く)。
 */
import type { HealthResult } from "./health";

export const OVERRIDE_HEADER = "Cloudflare-Workers-Version-Overrides";

/** 構造化ヘッダの辞書の 1 項目(Worker の名前 = "版の ID")。 */
export function overrideValue(worker: string, versionId: string): string {
  return `${worker}="${versionId}"`;
}

export interface TrialDeps {
  /** 配備を作る(割合の並び)。断られたら投げる。 */
  deploy(versions: Array<{ version_id: string; percentage: number }>, message: string): Promise<void>;
  /** 確かめの要求(版の指定のヘッダを付けて /health を叩く)。 */
  probe(headers: Record<string, string>): Promise<HealthResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface TrialInput {
  worker: string;
  /** いま 100% の版(戻る先)。 */
  from: string;
  /** 上げたばかりの版(まだ本番の要求を受けていない)。 */
  to: string;
  /** 上げる版の番号(新しい版が /health でこれを名乗れば、その版が答えた)。 */
  expectedVersion: string;
  /** いま動いている版が名乗る版(名乗らなければ null)。上げる版と同じなら見分けられない。 */
  previousVersion: string | null;
  windowMs: number;
  intervalMs: number;
  label: string;
}

export type TrialResult =
  | { ok: true; version: string }
  /** placed: 0% の版を載せたか(載せていなければ本番は一度も変わっていない)。 */
  | { ok: false; placed: boolean; error: string };

export async function trialVersion(deps: TrialDeps, input: TrialInput): Promise<TrialResult> {
  if (input.previousVersion === input.expectedVersion) {
    return { ok: false, placed: false, error: "trial: the running version reports the same version; the new one cannot be told apart" };
  }
  try {
    await deps.deploy(
      [{ version_id: input.from, percentage: 100 }, { version_id: input.to, percentage: 0 }],
      `WorkerOps trial ${input.label}`,
    );
  } catch (e) {
    return { ok: false, placed: false, error: `trial: 0% deployment refused: ${e instanceof Error ? e.message : String(e)}` };
  }
  const headers = { [OVERRIDE_HEADER]: overrideValue(input.worker, input.to) };
  const deadline = deps.now() + input.windowMs;
  let error = "trial: new version was not observed";
  while (deps.now() < deadline) {
    const r = await deps.probe(headers);
    if (r.version === input.expectedVersion) {
      if (r.ok) return { ok: true, version: r.version };
      error = `trial: new version is unhealthy (HTTP ${r.status})`;
      break;
    }
    await deps.sleep(input.intervalMs);
  }
  // 0% の版を外す(本番の要求は最初から今の版だけが受けている)。外せなければ投げる —— 呼ぶ側が人を呼ぶ。
  await deps.deploy([{ version_id: input.from, percentage: 100 }], `WorkerOps trial rejected ${input.label}`);
  return { ok: false, placed: true, error };
}
