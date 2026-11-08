// 確かめてから配る(trial.ts)。本番の要求が 0% の版で確かめ、だめなら外す。
import assert from "node:assert/strict";
import { OVERRIDE_HEADER, overrideValue, trialVersion, type TrialDeps } from "./trial.ts";
import type { HealthResult } from "./health.ts";

function fake(answers: HealthResult[], refuse = false) {
  const deployed: Array<Array<{ version_id: string; percentage: number }>> = [];
  const seen: Array<Record<string, string>> = [];
  let t = 0;
  const deps: TrialDeps = {
    async deploy(versions) {
      if (refuse && versions.some((v) => v.percentage === 0)) throw new Error("percentage must be >= 0.01");
      deployed.push(versions);
    },
    async probe(headers) { seen.push(headers); return answers.shift() ?? { ok: true, version: "1.0.0", status: 200 }; },
    async sleep(ms) { t += ms; },
    now: () => t,
  };
  return { deps, deployed, seen };
}
const input = { worker: "entamy-statistics", from: "old-id", to: "new-id", expectedVersion: "1.0.1", previousVersion: "1.0.0", windowMs: 10_000, intervalMs: 2_000, label: "1.0.1" };

assert.equal(overrideValue("entamy-statistics", "new-id"), 'entamy-statistics="new-id"');

{ // 新しい版が名乗って ok → 良し。0% の版を載せたまま(呼ぶ側が 100% にする)。
  const f = fake([{ ok: true, version: "1.0.0", status: 200 }, { ok: true, version: "1.0.1", status: 200 }]);
  assert.deepEqual(await trialVersion(f.deps, input), { ok: true, version: "1.0.1" });
  assert.deepEqual(f.deployed, [[{ version_id: "old-id", percentage: 100 }, { version_id: "new-id", percentage: 0 }]]);
  assert.equal(f.seen[0]![OVERRIDE_HEADER], 'entamy-statistics="new-id"');
}
{ // 新しい版が名乗ったが ok でない → 0% の版を外し、今の版 100% だけに戻す。
  const f = fake([{ ok: false, version: "1.0.1", status: 503 }]);
  const r = await trialVersion(f.deps, input);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? null : { placed: r.placed }, { placed: true });
  assert.deepEqual(f.deployed.at(-1), [{ version_id: "old-id", percentage: 100 }]);
}
{ // 旧版の ok しか返らない(指定が効かない)→ 確かめたことにしない。窓が過ぎたら外す。
  const f = fake(Array.from({ length: 10 }, () => ({ ok: true, version: "1.0.0", status: 200 })));
  const r = await trialVersion(f.deps, input);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /not observed/);
  assert.deepEqual(f.deployed.at(-1), [{ version_id: "old-id", percentage: 100 }]);
}
{ // 0% を Cloudflare に断られた → 本番は一度も変わっていない。0.01% に落とさない。
  const f = fake([], true);
  const r = await trialVersion(f.deps, input);
  assert.deepEqual(r.ok ? null : { placed: r.placed }, { placed: false });
  assert.equal(f.deployed.length, 0);
  assert.equal(f.seen.length, 0);
}
{ // 今の版が名乗らない(古い版)→ 上げる版の番号を名乗るのを待てば見分けられる。
  const f = fake([{ ok: true, status: 200 }, { ok: true, version: "1.0.1", status: 200 }]);
  assert.deepEqual(await trialVersion(f.deps, { ...input, previousVersion: null }), { ok: true, version: "1.0.1" });
}
{ // 別の番号を名乗る(上げる版ではない)→ 良しとしない。
  const f = fake(Array.from({ length: 10 }, () => ({ ok: true, version: "1.0.2", status: 200 })));
  const r = await trialVersion(f.deps, input);
  assert.equal(r.ok, false);
}
{ // 今の版が同じ番号を名乗る(入れ直し)→ 見分けられないので、載せずに止める。
  const f = fake([]);
  const r = await trialVersion(f.deps, { ...input, previousVersion: "1.0.1" });
  assert.equal(r.ok, false);
  assert.equal(f.deployed.length, 0);
}
console.log("  ok   trial: 0% で確かめてから配る");
