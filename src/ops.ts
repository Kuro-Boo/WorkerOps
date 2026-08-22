import type { Env } from "./types";
import type { Config } from "./config";
import { getState, getSelfState, setSelfState } from "./state";
import { deployLatest, runRevert, watchdogTick } from "./orchestrator";
import { probeHealth } from "./health";
import { fetchAppIncidents } from "./incidents";
import { WORKEROPS_VERSION } from "./version";
import { CfClient } from "./cf";
import { jsonResponse, constantTimeEqual, OpsError } from "./util";

function tokenFromRequest(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const h = request.headers.get("x-workerops-token");
  return h ? h.trim() : null;
}

function requireToken(request: Request, config: Config): void {
  const t = tokenFromRequest(request);
  if (!config.opsToken || !t || !constantTimeEqual(t, config.opsToken)) {
    throw new OpsError(401, "unauthorized", "A valid WorkerOps token is required.");
  }
}

/** Routes everything under OPS_PATH. The recovery page (GET OPS_PATH) is public;
 *  all data/actions require the WorkerOps token. */
export async function handleOps(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: Config,
): Promise<Response> {
  const url = new URL(request.url);
  let sub = url.pathname.slice(config.opsPath.length);
  if (sub === "") sub = "/";

  try {
    // Status payload (public). Shared by the recovery page and the REST API.
    const status = async (): Promise<Response> => {
      ctx.waitUntil(watchdogTick(env, config).catch(() => {}));
      const [state, self, activeVersionId, health, incidents] = await Promise.all([
        getState(env),
        getSelfState(env),
        new CfClient(config.token, config.accountId, config.appWorkerName, {
          max: 1,
          baseMs: config.retryBaseMs,
        })
          .getActiveVersionId()
          .catch(() => null),
        probeHealth(env, config).catch(() => ({ ok: false, status: 0 })),
        fetchAppIncidents(config),
      ]);
      return jsonResponse({
        app: {
          workerName: config.appWorkerName,
          releaseSource: config.releaseSource,
          releaseAsset: config.releaseAsset,
          healthPath: config.healthPath,
          migratePath: config.migratePath,
          opsPath: config.opsPath,
        },
        tunables: {
          retryMax: config.retryMax,
          retryBaseMs: config.retryBaseMs,
          revertRetryMax: config.revertRetryMax,
          healthWindowMs: config.healthWindowMs,
          healthIntervalMs: config.healthIntervalMs,
          lockTtlMs: config.lockTtlMs,
        },
        state,
        self: {
          ...self,
          version: WORKEROPS_VERSION,
          releaseSource: config.selfReleaseSource,
          enabled: config.selfUpdateEnabled,
          intervalMs: config.selfUpdateIntervalMs,
          workerName: config.opsWorkerName,
        },
        cf: { activeVersionId },
        health,
        incidents,
      });
    };

    // Recovery page (HTML).
    if (sub === "/" && request.method === "GET") {
      return new Response(recoveryPage(config), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // REST API liveness (for AI/external callers).
    // ⚠ `version` is what a self-update checks to decide whether the new build
    //   actually took. Do not remove it, and do not make this handler depend on
    //   anything that can fail — it is also the app-independent liveness probe.
    if (request.method === "GET" && sub === "/api/v1/health") {
      return jsonResponse({
        ok: true,
        service: "workerops",
        version: WORKEROPS_VERSION,
      });
    }

    // Status — public. Both the page path and the /api/v1 path.
    if (request.method === "GET" && (sub === "/status" || sub === "/api/v1/status")) {
      return status();
    }

    // Token check — requires WORKER_OPS_TOKEN but changes NOTHING.
    //
    // ⚠ Exists so nobody probes "is my token valid?" by firing an operation.
    //   A caller once used POST /api/v1/revert as an auth probe: it authenticated,
    //   so it RAN — the rollback was a no-op only because no last-good version had
    //   been recorded yet, and it still left the guardian in `manual_required`.
    //   Any credential check must have a read-only endpoint to aim at.
    if (request.method === "GET" && sub === "/api/v1/auth-check") {
      requireToken(request, config);
      return jsonResponse({ ok: true, authorized: true, service: "workerops" });
    }

    // Update channel. Reading is public (the console shows it); changing it is
    // an operation — it decides which code this guardian will install into
    // itself — so it takes the token like any other operation.
    if (request.method === "GET" && sub === "/api/v1/channel") {
      const self = await getSelfState(env);
      return jsonResponse({ channel: self.channel });
    }
    if (
      (request.method === "PUT" || request.method === "POST") &&
      sub === "/api/v1/channel"
    ) {
      requireToken(request, config);
      const body = (await request.json().catch(() => ({}))) as {
        channel?: string;
      };
      const wanted = String(body.channel || "").toLowerCase();
      if (wanted !== "stable" && wanted !== "develop") {
        throw new OpsError(
          400,
          "bad_channel",
          'channel must be "stable" or "develop".',
        );
      }
      const next = await setSelfState(env, { channel: wanted });
      return jsonResponse({ ok: true, channel: next.channel });
    }

    // Operations — require WORKER_OPS_TOKEN. Both the page paths and /api/v1.
    if (request.method === "POST" && (sub === "/update" || sub === "/api/v1/update")) {
      requireToken(request, config);
      return jsonResponse(await deployLatest(env, ctx, config, "update"));
    }
    if (request.method === "POST" && (sub === "/reinstall" || sub === "/api/v1/reinstall")) {
      requireToken(request, config);
      return jsonResponse(await deployLatest(env, ctx, config, "reinstall"));
    }
    if (request.method === "POST" && (sub === "/revert" || sub === "/api/v1/revert")) {
      requireToken(request, config);
      return jsonResponse(await runRevert(env, config));
    }

    return jsonResponse({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof OpsError) {
      return jsonResponse({ error: e.code, message: e.message }, e.status);
    }
    return jsonResponse(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
}

/** Shown by the proxy when the app Worker is unreachable. */
export function maintenancePage(config: Config): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>メンテナンス中</title>
<style>body{margin:0;background:#0f172a;color:#e2e8f0;font:15px/1.7 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}.b{max-width:420px;text-align:center;padding:24px}a{color:#34d399}</style>
</head><body><div class="b"><h1>メンテナンス中</h1>
<p>現在アプリに接続できません。しばらくして再度お試しください。</p>
<p><a href="${config.opsPath}/">復旧コンソール</a></p></div></body></html>`;
}

/** Self-contained recovery console. Status loads automatically (public);
 *  operations (revert/reinstall/update) require the WORKER_OPS_TOKEN. */
export function recoveryPage(config: Config): string {
  const ops = JSON.stringify(config.opsPath);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WorkerOps Recovery</title>
<style>
body{margin:0;background:#0f172a;color:#e2e8f0;font:14px/1.6 system-ui,sans-serif}
.wrap{max-width:600px;margin:40px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 2px}.sub{color:#94a3b8;font-size:12px;margin:0 0 16px}
.card{background:#111827;border:1px solid #334155;border-radius:12px;padding:18px}
.row{margin:5px 0;display:flex;gap:8px}.k{color:#94a3b8;flex:0 0 168px}.v{color:#e2e8f0;word-break:break-all}
.v.stack{display:flex;flex-direction:column;gap:2px}
.hint{color:#64748b;font-size:11px;line-height:1.45}
.num{font-weight:700}.num.bad{color:#f87171}.num.good{color:#22c55e}
input{width:100%;padding:9px 10px;border-radius:8px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;font-size:13px}
.btns{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
button.op{flex:1 1 150px;display:flex;flex-direction:column;align-items:flex-start;gap:10px;text-align:left;border:1px solid #334155;background:#1e293b;color:#e2e8f0;border-radius:12px;padding:18px 16px;min-height:150px;cursor:pointer;font:inherit}
button.op:hover{background:#243044}
button.op.b-revert{background:#ea580c;border-color:#f97316}
button.op.b-revert:hover{background:#f97316}
button.op.b-rebuild{background:#3b82f6;border-color:#60a5fa}
button.op.b-rebuild:hover{background:#60a5fa}
button.op.b-update{background:#16a34a;border-color:#22c55e}
button.op.b-update:hover{background:#22c55e}
.op .ic{display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:10px;background:rgba(255,255,255,.06)}
.op .t{display:flex;flex-direction:column;gap:4px}
.op .t b{font-size:15px;font-weight:700;color:#fff}
.op .d{font-size:12px;color:#94a3b8;font-weight:400;line-height:1.5}
.op.b-revert .d{color:#fed7aa}.op.b-rebuild .d{color:#dbeafe}.op.b-update .d{color:#bbf7d0}
.chan{margin:14px 0 0;padding:12px 14px;border:1px solid #7c2d12;border-left:3px solid #f97316;border-radius:8px;background:#1a0f07}
.chan .ct{display:flex;align-items:center;gap:10px;justify-content:space-between}
.chan .cl{font-size:13px;font-weight:700;color:#fdba74}
.chan .cd{color:#94a3b8;font-size:11px;line-height:1.6;margin-top:6px}
.chan .cd b{color:#fca5a5}
.sw{position:relative;flex:0 0 auto;width:46px;height:26px;border-radius:13px;border:1px solid #475569;background:#1e293b;cursor:pointer;padding:0}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#94a3b8;transition:left .15s,background .15s}
.sw[aria-checked="true"]{background:#ea580c;border-color:#f97316}
.sw[aria-checked="true"]::after{left:22px;background:#fff}
.safe{margin:14px 0 0;padding:12px 14px;border:1px solid #334155;border-left:3px solid #22c55e;border-radius:8px;background:#0b1220;color:#94a3b8;font-size:12px;line-height:1.7}
.safe b{color:#e2e8f0;font-weight:700}
.err{color:#f87171;font-size:12px;margin-top:10px;min-height:16px}
hr{border:0;border-top:1px solid #334155;margin:14px 0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.lbl{color:#94a3b8;font-size:12px;margin:0 0 6px}
.hd{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.langsel{background:#1e293b;color:#e2e8f0;border:1px solid #475569;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer}
.foot{text-align:center;margin:14px 0 0}.foot a{color:#64748b;font-size:11px;text-decoration:none}.foot a:hover{color:#94a3b8}
.mask{position:fixed;inset:0;background:rgba(2,6,23,.72);display:none;align-items:center;justify-content:center;padding:16px;z-index:50}
.mask.on{display:flex}
.dlg{background:#111827;border:1px solid #334155;border-radius:12px;padding:18px;width:100%;max-width:560px;max-height:86vh;display:flex;flex-direction:column}
.dlg h2{margin:0 0 2px;font-size:16px}
.dlg .phase{color:#94a3b8;font-size:12px;margin:0 0 12px}
.steps{overflow:auto;flex:1;margin:0;padding:0;list-style:none;border-top:1px solid #1e293b}
.step{display:flex;gap:10px;padding:8px 2px;border-bottom:1px solid #1e293b;align-items:flex-start}
.step .si{flex:0 0 16px;text-align:center;font-weight:700;line-height:1.5}
.step .sb{flex:1;min-width:0}
.step .sn{font-size:13px}
.step .sd{color:#64748b;font-size:11px;word-break:break-all}
.step .st{color:#475569;font-size:11px;flex:0 0 auto}
.step.run .si{color:#60a5fa}.step.ok .si{color:#22c55e}.step.fail .si{color:#f87171}
.step.fail .sn{color:#fca5a5}
.dlgfoot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px}
.dlgfoot .res{font-size:12px;color:#94a3b8;flex:1}
.dlgfoot button{border:1px solid #475569;background:#1e293b;color:#e2e8f0;border-radius:8px;padding:8px 16px;font:inherit;cursor:pointer}
.dlgfoot button:hover{background:#243044}
</style></head><body><div class="wrap">
<div class="hd"><div><h1>WorkerOps Recovery</h1><p class="sub" id="sub"></p></div>
<select id="lang" class="langsel" onchange="setLang(this.value)" aria-label="language"><option value="ja">JA</option><option value="en">EN</option></select></div>
<div class="card">
<div id="status"><div class="row"><span class="v" id="loading"></span></div></div>
<hr>
<p class="lbl" id="opTarget"></p>
<div class="row"><input id="tok" type="password" autocomplete="off"></div>
<div class="err" id="err"></div>
<div class="btns">
<button class="op b-revert" onclick="act('revert')"><span class="ic"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12H8"/></svg></span><span class="t"><b id="t_revert"></b><span class="d" id="d_revert"></span></span></button>
<button class="op b-rebuild" onclick="act('reinstall')"><span class="ic"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span><span class="t"><b id="t_reinstall"></b><span class="d" id="d_reinstall"></span></span></button>
<button class="op b-update" onclick="act('update')"><span class="ic"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg></span><span class="t"><b id="t_update"></b><span class="d" id="d_update"></span></span></button>
</div>
<div class="chan">
<div class="ct"><span class="cl" id="chanLabel"></span>
<button class="sw" id="chanSw" role="switch" aria-checked="false" onclick="toggleChannel()" aria-label="develop"></button></div>
<p class="cd" id="chanDesc"></p></div>
<p class="safe" id="safeNote"></p>
</div>
<p class="foot"><a href="https://kuro.boo/" target="_blank" rel="noopener">WorkerOps: Kuro.Boo</a></p></div>
<div class="mask" id="mask"><div class="dlg" role="dialog" aria-modal="true">
<h2 id="dlgTitle"></h2><p class="phase" id="dlgPhase"></p>
<ul class="steps" id="dlgSteps"></ul>
<div class="dlgfoot"><span class="res" id="dlgRes"></span><button id="dlgClose" onclick="closeDlg()"></button></div>
</div></div>
<script>
var OPS=${ops};
var STR={
 ja:{sub:'管理 Worker のステータス（自動表示）— 操作にはトークンが必要',loading:'読み込み中…',up:'稼働中',down:'応答なし',
  running:'稼働 version',ustate:'更新状態',active:'CF active version',lastgood:'last-good',fromto:'from → to',
  prev:'prev app version',intended:'intended release',times:'開始 / 確定 / 終了',worker:'app worker',
  release:'release source',hm:'health / migrate',hwin:'health 窓 / 間隔',
  retryUpd:'更新の再試行回数',retryUpdHint:'更新中に Cloudflare API の呼び出しが失敗したとき、間隔を空けて最大 {n} 回までやり直します。',
  retryRev:'巻き戻しの再試行回数',retryRevHint:'巻き戻しに失敗したままだと復旧できなくなるため、更新より多めに粘ります（最大 {n} 回）。',
  autoRev:'自動巻き戻しの実行回数',
  autoRevHint0:'まだ一度もありません。WorkerOps が自動で行うのは更新直後の検証に失敗したときの巻き戻しだけで、平常運転中に落ちた Worker を再起動する機能はありません。',
  autoRevHint:'累計。更新直後の検証に失敗したときだけ自動で戻します。最後: {at} — {why}',
  times24:'24 時間で落ちた回数',
  times24Hint:'Cloudflare Analytics の集計。成功 {ok} 件に対する失敗 {n} 件で、{h} 個の時間帯にまたがっています。最後の発生: {last}',
  times24None:'直近 24 時間、失敗した実行はありません（成功 {ok} 件）。',
  times24NA:'取得できません（{why}）。CF_API_TOKEN に Account Analytics:Read が必要です。',
  unit:'回',hours:'時間帯',
  optarget:'管理対象の App Worker に対して操作します。（Worker作成時に発行された WORKER_OPS_TOKEN が必要です）',ph:'WORKER_OPS_TOKEN（操作に必要）',
  t_revert:'Revert',d_revert:'現在の App Worker を直前の安定版に戻します',
  t_reinstall:'Rebuild',d_reinstall:'Worker を作り直して再インストールします',
  t_update:'Update',d_update:'GitHub Release より最新を取得して更新します',
  safe:'<b>この 3 つの操作が入れ替えるのは Worker（プログラム本体）だけです。</b>接続されている D1（データベース）・KV・R2（画像などのファイル）には一切書き込みません。記事・設定・アップロード済みのファイルはそのまま残り、バインディングも現在の設定を引き継ぎます。',
  selfVer:'WorkerOps の版',selfChan:'更新チャンネル',selfCount:'自己更新の実行回数',
  selfVerHint:'この復旧コンソール自身の版。新しい安定版が出ると{iv}時間ごとに自動で入れ替わります（利用者の操作は不要）。',
  selfOffHint:'自己更新は無効です（OPS_WORKER_NAME 未設定）。自分の Worker 名が分からない guardian は自分を入れ替えません。',
  selfCountHint:'成功 {n} 回 / 検証に失敗して戻した回数 {r} 回。最後: {at}',
  selfCountHint0:'まだ一度も自己更新していません。',
  selfState:'自己更新の状態',
  chanLabel:'develop 版を受け入れる（非推奨）',
  chanDesc:'<b>通常は OFF のままにしてください。</b>OFF のとき、この guardian は<b>安定版だけ</b>を自動で取り込みます。ON にすると検証前の prerelease まで取り込むため、<b>復旧コンソールごと壊れる可能性があります</b>（guardian が起動できない版に入れ替わると、内側から戻す手段がありません）。開発者が自分の instance で新版を試すためのスイッチです。',
  chanOn:'develop（非推奨）',chanOff:'stable（推奨）',
  chanConfirm:'develop 版の受け入れを ON にします。検証前の prerelease が自動で導入され、この復旧コンソールごと失われる可能性があります。続けますか？',
  st_self_found:'新しい版を検出',st_self_read_active:'現在の version を確認',st_self_fetch:'新しい版を取得',
  st_self_read_settings:'設定とバインディングを読み出し',st_self_upload:'新しい版をアップロード',
  st_self_deploy:'新しい版を配備',st_self_verify:'公開URL越しに新版を検証',st_self_rollback:'自己更新を巻き戻し',
  st_self_error:'自己更新でエラー',
  needtok:'操作には WORKER_OPS_TOKEN が必要です',confirm:'{op} を実行しますか？',
  dlgRunning:'実行中… この画面を閉じても処理は続きます',dlgWaiting:'サーバーの応答を待っています…',
  dlgDone:'完了しました',dlgFailed:'失敗しました',dlgTimeout:'画面の追跡を打ち切りました（処理はサーバー側で続いています）',
  close:'閉じる',noSteps:'まだ記録がありません…',
  st_start:'操作を開始',st_read_active:'稼働中の version を確認',st_probe_before:'更新前の app version を記録',
  st_fetch_release:'リリースを取得',st_read_settings:'現在の設定とバインディングを読み出し',
  st_upload_version:'新しい version をアップロード',st_deploy_version:'新しい version を配備',
  st_verify:'health による検証',st_migrate:'マイグレーションを実行',st_confirm:'確定（last-good を更新）',
  st_revert:'巻き戻し',st_auto_revert:'自動巻き戻し',st_watchdog:'watchdog による点検',st_aborted:'中止'},
 en:{sub:'Managed Worker status (auto) — operations require a token',loading:'Loading…',up:'up',down:'down',
  running:'running version',ustate:'update state',active:'CF active version',lastgood:'last-good',fromto:'from → to',
  prev:'prev app version',intended:'intended release',times:'started / confirmed / finished',worker:'app worker',
  release:'release source',hm:'health / migrate',hwin:'health window / interval',
  retryUpd:'update retries',retryUpdHint:'If a Cloudflare API call fails during an update, it is retried up to {n} times with backoff.',
  retryRev:'rollback retries',retryRevHint:'A rollback that stays failed leaves no way back, so it is retried harder than an update (up to {n} times).',
  autoRev:'automatic rollbacks',
  autoRevHint0:'None so far. The only thing WorkerOps does on its own is roll back when a fresh deploy fails verification — it does not restart a Worker that fails during normal operation.',
  autoRevHint:'Lifetime total. Triggered only when a fresh deploy fails verification. Last: {at} — {why}',
  times24:'failures in 24h',
  times24Hint:'From Cloudflare Analytics: {n} failed invocations against {ok} successful ones, spread over {h} hourly buckets. Last seen: {last}',
  times24None:'No failed invocations in the last 24h ({ok} succeeded).',
  times24NA:'Unavailable ({why}). CF_API_TOKEN needs Account Analytics:Read.',
  unit:'',hours:'hours',
  optarget:'Operations target the managed App Worker. (the WORKER_OPS_TOKEN issued when the Worker was created is required)',ph:'WORKER_OPS_TOKEN (required for operations)',
  t_revert:'Revert',d_revert:'Roll the App Worker back to the last stable version',
  t_reinstall:'Rebuild',d_reinstall:'Recreate and reinstall the Worker',
  t_update:'Update',d_update:'Fetch and deploy the latest from GitHub Release',
  safe:'<b>These three operations replace the Worker (the program) and nothing else.</b> They never write to the D1 database, KV, or R2 bucket bound to it. Articles, settings and uploaded files stay exactly as they are, and the current bindings are carried over.',
  selfVer:'WorkerOps version',selfChan:'update channel',selfCount:'self-updates',
  selfVerHint:'The version of this recovery console itself. It replaces itself automatically when a new stable release appears (checked every {iv}h, no user action).',
  selfOffHint:'Self-update is off (OPS_WORKER_NAME is unset). A guardian that cannot name itself never replaces itself.',
  selfCountHint:'{n} succeeded / {r} rolled back after failing verification. Last: {at}',
  selfCountHint0:'Has never self-updated.',
  selfState:'self-update state',
  chanLabel:'Accept develop builds (not recommended)',
  chanDesc:'<b>Leave this OFF.</b> While off, this guardian installs <b>stable releases only</b>. Turning it on installs unvetted prereleases, which <b>can take the recovery console down with it</b> — if the guardian boots into a broken build, nothing inside can put it back. It exists so the developer can exercise a release on their own instance.',
  chanOn:'develop (not recommended)',chanOff:'stable (recommended)',
  chanConfirm:'This enables develop builds. Unvetted prereleases will be installed automatically and may take this recovery console with them. Continue?',
  st_self_found:'New version found',st_self_read_active:'Read the live version',st_self_fetch:'Download the new version',
  st_self_read_settings:'Read settings and bindings',st_self_upload:'Upload the new version',
  st_self_deploy:'Deploy the new version',st_self_verify:'Verify the new version over the public URL',st_self_rollback:'Roll the self-update back',
  st_self_error:'Self-update error',
  needtok:'A WORKER_OPS_TOKEN is required for operations',confirm:'Run {op}?',
  dlgRunning:'Running… closing this dialog does not stop it',dlgWaiting:'Waiting for the server…',
  dlgDone:'Finished',dlgFailed:'Failed',dlgTimeout:'Stopped following along (the server is still working)',
  close:'Close',noSteps:'No steps recorded yet…',
  st_start:'Operation started',st_read_active:'Read the live version',st_probe_before:'Record the app version before the update',
  st_fetch_release:'Fetch the release',st_read_settings:'Read current settings and bindings',
  st_upload_version:'Upload the new version',st_deploy_version:'Deploy the new version',
  st_verify:'Verify via health',st_migrate:'Run migrations',st_confirm:'Confirm (update last-good)',
  st_revert:'Roll back',st_auto_revert:'Automatic rollback',st_watchdog:'Watchdog check',st_aborted:'Aborted'}};
var saved=null;try{saved=localStorage.getItem('wo_lang');}catch(e){}
var lang=(saved==='ja'||saved==='en')?saved:(/^ja/.test((navigator.language||'').toLowerCase())?'ja':'en');
function t(k){return (STR[lang]||STR.en)[k];}
var lastData=null;
var TERMINAL={confirmed:1,reverted:1,failed_predeploy:1,manual_required:1,idle:1};
var tracking=null;
function tok(){return document.getElementById('tok').value.trim();}
function setErr(m){document.getElementById('err').textContent=m||'';}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function fill(s,o){var r=String(s);for(var k in o){r=r.split('{'+k+'}').join(String(o[k]));}return r;}
function row(k,v){return '<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>';}
function rowH(k,v,hint){return '<div class="row"><span class="k">'+k+'</span><span class="v stack"><span>'+v+'</span><span class="hint">'+hint+'</span></span></div>';}
function setText(id,v){var e=document.getElementById(id);if(e)e.textContent=v;}
function hhmmss(iso){var d=new Date(iso);return isNaN(d.getTime())?String(iso||''):d.toLocaleTimeString();}
function applyLabels(){
 document.documentElement.lang=lang;
 var sel=document.getElementById('lang');if(sel)sel.value=lang;
 setText('sub',t('sub'));
 document.getElementById('tok').placeholder=t('ph');
 setText('t_revert',t('t_revert'));setText('d_revert',t('d_revert'));
 setText('t_reinstall',t('t_reinstall'));setText('d_reinstall',t('d_reinstall'));
 setText('t_update',t('t_update'));setText('d_update',t('d_update'));
 setText('dlgClose',t('close'));
 document.getElementById('safeNote').innerHTML=t('safe');
 syncChannelUi((lastData&&lastData.self)||{});
 if(lastData){render(lastData);}else{setText('loading',t('loading'));}}
function setLang(v){lang=v;try{localStorage.setItem('wo_lang',v);}catch(e){}applyLabels();if(tracking)renderSteps(lastData);}
async function loadStatus(){setErr('');
 try{var r=await fetch(OPS+'/status');var d=await r.json();
 if(!r.ok){setErr(d.message||d.error||('HTTP '+r.status));return;}render(d);}catch(e){setErr(String(e));}}
function selfRows(sf){
 var iv=Math.max(1,Math.round((sf.intervalMs||0)/3600000));
 var chan=sf.channel==='develop'?t('chanOn'):t('chanOff');
 var cnt=sf.updateCount||0,rb=sf.rollbackCount||0;
 var cntHint=(cnt||rb)?fill(t('selfCountHint'),{n:cnt,r:rb,at:esc(sf.lastUpdateAt||'—')}):t('selfCountHint0');
 return rowH(t('selfVer'),esc(sf.version||'—'),sf.enabled?fill(t('selfVerHint'),{iv:iv}):t('selfOffHint'))+
  row(t('selfChan'),esc(chan))+
  rowH(t('selfCount'),'<span class="num '+(rb>0?'bad':'good')+'">'+cnt+'</span> '+t('unit'),cntHint)+
  (sf.status&&sf.status!=='idle'?row(t('selfState'),esc(sf.status)+(sf.error?(' — '+esc(sf.error)):'')):'');}
function syncChannelUi(sf){
 var sw=document.getElementById('chanSw');if(!sw)return;
 var on=(sf&&sf.channel)==='develop';
 sw.setAttribute('aria-checked',on?'true':'false');
 setText('chanLabel',t('chanLabel'));
 document.getElementById('chanDesc').innerHTML=t('chanDesc');}
async function toggleChannel(){setErr('');
 if(!tok()){setErr(t('needtok'));return;}
 var cur=(lastData&&lastData.self&&lastData.self.channel)||'stable';
 var next=cur==='develop'?'stable':'develop';
 if(next==='develop'&&!confirm(t('chanConfirm')))return;
 try{var r=await fetch(OPS+'/api/v1/channel',{method:'PUT',
  headers:{'authorization':'Bearer '+tok(),'content-type':'application/json'},
  body:JSON.stringify({channel:next})});
 var d=await r.json();
 if(!r.ok){setErr(d.message||d.error||('HTTP '+r.status));return;}
 loadStatus();}catch(e){setErr(String(e));}}
function autoRevertRow(s){
 var n=s.autoRevertCount||0;
 var v='<span class="num '+(n>0?'bad':'good')+'">'+n+'</span> '+t('unit');
 var hint=n>0?fill(t('autoRevHint'),{at:esc(s.lastAutoRevertAt||'—'),why:esc(s.lastAutoRevertReason||'—')}):t('autoRevHint0');
 return rowH(t('autoRev'),v,hint);}
function incidentsRow(inc){
 if(!inc)return '';
 if(!inc.available)return rowH(t('times24'),'—',fill(t('times24NA'),{why:esc(inc.reason||'unknown')}));
 var n=inc.failed||0;
 var v='<span class="num '+(n>0?'bad':'good')+'">'+n+'</span> '+t('unit');
 if(n===0)return rowH(t('times24'),v,fill(t('times24None'),{ok:inc.succeeded||0}));
 var parts=[];for(var k in (inc.byStatus||{})){parts.push(esc(k)+' '+inc.byStatus[k]);}
 var hint=fill(t('times24Hint'),{n:n,ok:inc.succeeded||0,h:inc.affectedHours||0,last:esc(inc.lastFailureHour||'—')});
 if(parts.length)hint+=' / '+parts.join(', ');
 return rowH(t('times24'),v,hint);}
function render(d){lastData=d;var s=d.state||{},h=d.health||{},app=d.app||{},tn=d.tunables||{},cf=d.cf||{};
 var color=h.ok?'#22c55e':'#ef4444';
 document.getElementById('status').innerHTML=
 row('app','<span class="dot" style="background:'+color+'"></span>'+(h.ok?t('up'):t('down'))+' (HTTP '+esc(h.status)+')')+
 row(t('running'),esc(h.version||'—'))+
 row(t('ustate'),esc(s.status||'—')+(s.error?(' — '+esc(s.error)):''))+
 selfRows(d.self||{})+
 autoRevertRow(s)+
 incidentsRow(d.incidents)+
 row(t('active'),esc(cf.activeVersionId||'—'))+
 row(t('lastgood'),esc(s.lastGoodVersionId||'—'))+
 row(t('fromto'),esc(s.fromVersionId||'—')+'<br><span style="padding-left:1.4em">→ '+esc(s.toVersionId||'—')+'</span>')+
 row(t('prev'),esc(s.prevAppVersion||'—'))+
 row(t('intended'),esc(s.intendedRelease||'—'))+
 row(t('times'),esc(s.startedAt||'—')+' / '+esc(s.confirmedAt||'—')+' / '+esc(s.finishedAt||'—'))+
 row(t('worker'),esc(app.workerName||'—'))+
 row(t('release'),esc(app.releaseSource||'—')+' ('+esc(app.releaseAsset||'')+')')+
 row(t('hm'),esc(app.healthPath||'—')+' / '+esc(app.migratePath||'—'))+
 row(t('hwin'),esc(tn.healthWindowMs)+'ms / '+esc(tn.healthIntervalMs)+'ms')+
 rowH(t('retryUpd'),esc(tn.retryMax)+' '+t('unit'),fill(t('retryUpdHint'),{n:esc(tn.retryMax)}))+
 rowH(t('retryRev'),esc(tn.revertRetryMax)+' '+t('unit'),fill(t('retryRevHint'),{n:esc(tn.revertRetryMax)}));
 var ot=document.getElementById('opTarget');if(ot)ot.textContent=t('optarget');
 syncChannelUi(d.self||{});
 if(tracking)renderSteps(d);}
function stepIcon(st){return st==='ok'?'✓':(st==='fail'?'✕':'●');}
function renderSteps(d){
 var s=(d&&d.state)||{},list=s.events||[];
 var ul=document.getElementById('dlgSteps');if(!ul)return;
 if(!list.length){ul.innerHTML='<li class="step"><span class="sb"><span class="sd">'+esc(t('noSteps'))+'</span></span></li>';}
 else{ul.innerHTML=list.map(function(e){
  var name=t('st_'+e.step)||e.step;
  return '<li class="step '+esc(e.state)+'"><span class="si">'+stepIcon(e.state)+'</span>'+
   '<span class="sb"><span class="sn">'+esc(name)+'</span>'+
   (e.detail?'<br><span class="sd">'+esc(e.detail)+'</span>':'')+'</span>'+
   '<span class="st">'+esc(hhmmss(e.at))+'</span></li>';}).join('');
  ul.scrollTop=ul.scrollHeight;}
 var done=TERMINAL[s.status]===1&&tracking&&tracking.posted;
 setText('dlgPhase',done?'':t('dlgRunning'));
 if(done){
  var okish=s.status==='confirmed'||s.status==='reverted';
  setText('dlgRes',(okish?t('dlgDone'):t('dlgFailed'))+' — '+s.status+(s.error?(' / '+s.error):''));
  stopTracking();}}
function stopTracking(){if(tracking&&tracking.timer){clearInterval(tracking.timer);tracking.timer=null;}}
function closeDlg(){stopTracking();tracking=null;document.getElementById('mask').classList.remove('on');}
function openDlg(title){
 tracking={posted:false,timer:null,started:Date.now()};
 setText('dlgTitle',title);setText('dlgPhase',t('dlgWaiting'));setText('dlgRes','');
 document.getElementById('dlgSteps').innerHTML='';
 document.getElementById('mask').classList.add('on');}
async function act(name){setErr('');if(!tok()){setErr(t('needtok'));return;}
 var L={revert:t('t_revert'),reinstall:t('t_reinstall'),update:t('t_update')};
 if(!confirm(t('confirm').replace('{op}',L[name]||name)))return;
 openDlg(L[name]||name);
 // Poll while the request is in flight: deployLatest returns as soon as the new
 // version is deployed, and verification (plus any auto-revert) then runs in the
 // background — so the journal keeps moving after the POST has resolved.
 tracking.timer=setInterval(function(){
  if(tracking&&Date.now()-tracking.started>180000){setText('dlgRes',t('dlgTimeout'));stopTracking();return;}
  loadStatus();},1500);
 try{var r=await fetch(OPS+'/'+name,{method:'POST',headers:{'authorization':'Bearer '+tok()}});var d=await r.json();
 if(tracking)tracking.posted=true;
 if(!r.ok){setErr(d.message||d.error||('HTTP '+r.status));setText('dlgRes',t('dlgFailed')+' — '+esc(d.message||d.error||('HTTP '+r.status)));stopTracking();}
 loadStatus();}catch(e){setErr(String(e));setText('dlgRes',t('dlgFailed')+' — '+String(e));stopTracking();}}
applyLabels();loadStatus();setInterval(function(){if(!tracking)loadStatus();},5000);
</script></body></html>`;
}
