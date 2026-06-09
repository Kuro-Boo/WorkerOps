import type { Env } from "./types";
import type { Config } from "./config";
import { getState } from "./state";
import { deployLatest, runRevert, watchdogTick } from "./orchestrator";
import { probeHealth } from "./health";
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
      const [state, activeVersionId, health] = await Promise.all([
        getState(env),
        new CfClient(config.token, config.accountId, config.appWorkerName, {
          max: 1,
          baseMs: config.retryBaseMs,
        })
          .getActiveVersionId()
          .catch(() => null),
        probeHealth(env, config).catch(() => ({ ok: false, status: 0 })),
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
        cf: { activeVersionId },
        health,
      });
    };

    // Recovery page (HTML).
    if (sub === "/" && request.method === "GET") {
      return new Response(recoveryPage(config), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // REST API liveness (for AI/external callers).
    if (request.method === "GET" && sub === "/api/v1/health") {
      return jsonResponse({ ok: true, service: "workerops" });
    }

    // Status — public. Both the page path and the /api/v1 path.
    if (request.method === "GET" && (sub === "/status" || sub === "/api/v1/status")) {
      return status();
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
.err{color:#f87171;font-size:12px;margin-top:10px;min-height:16px}
hr{border:0;border-top:1px solid #334155;margin:14px 0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.lbl{color:#94a3b8;font-size:12px;margin:0 0 6px}
.hd{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.langsel{background:#1e293b;color:#e2e8f0;border:1px solid #475569;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer}
.foot{text-align:center;margin:14px 0 0}.foot a{color:#64748b;font-size:11px;text-decoration:none}.foot a:hover{color:#94a3b8}
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
</div></div>
<p class="foot"><a href="https://kuro.boo/" target="_blank" rel="noopener">WorkerOps: Kuro.Boo</a></p></div>
<script>
var OPS=${ops};
var STR={
 ja:{sub:'管理 Worker のステータス（自動表示）— 操作にはトークンが必要',loading:'読み込み中…',up:'稼働中',down:'応答なし',
  running:'稼働 version',ustate:'更新状態',active:'CF active version',lastgood:'last-good',fromto:'from → to',
  prev:'prev app version',intended:'intended release',times:'開始 / 確定 / 終了',worker:'app worker',
  release:'release source',hm:'health / migrate',hwin:'health 窓 / 間隔',retry:'retry / revert',
  optarget:'対象 Worker（{name}）に対して操作します。（操作には WORKER_OPS_TOKEN が必要）',ph:'WORKER_OPS_TOKEN（操作に必要）',
  t_revert:'Revert',d_revert:'現在の App Worker を直前の安定版に戻します',
  t_reinstall:'Rebuild',d_reinstall:'Worker を作り直して再インストールします',
  t_update:'Update',d_update:'GitHub Release より最新を取得して更新します',
  needtok:'操作には WORKER_OPS_TOKEN が必要です',confirm:'{op} を実行しますか？'},
 en:{sub:'Managed Worker status (auto) — operations require a token',loading:'Loading…',up:'up',down:'down',
  running:'running version',ustate:'update state',active:'CF active version',lastgood:'last-good',fromto:'from → to',
  prev:'prev app version',intended:'intended release',times:'started / confirmed / finished',worker:'app worker',
  release:'release source',hm:'health / migrate',hwin:'health window / interval',retry:'retry / revert',
  optarget:'Operations target Worker ({name}). (a WORKER_OPS_TOKEN is required)',ph:'WORKER_OPS_TOKEN (required for operations)',
  t_revert:'Revert',d_revert:'Roll the App Worker back to the last stable version',
  t_reinstall:'Rebuild',d_reinstall:'Recreate and reinstall the Worker',
  t_update:'Update',d_update:'Fetch and deploy the latest from GitHub Release',
  needtok:'A WORKER_OPS_TOKEN is required for operations',confirm:'Run {op}?'}};
var saved=null;try{saved=localStorage.getItem('wo_lang');}catch(e){}
var lang=(saved==='ja'||saved==='en')?saved:(/^ja/.test((navigator.language||'').toLowerCase())?'ja':'en');
function t(k){return (STR[lang]||STR.en)[k];}
var lastData=null;
function tok(){return document.getElementById('tok').value.trim();}
function setErr(m){document.getElementById('err').textContent=m||'';}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function row(k,v){return '<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>';}
function setText(id,v){var e=document.getElementById(id);if(e)e.textContent=v;}
function applyLabels(){
 document.documentElement.lang=lang;
 var sel=document.getElementById('lang');if(sel)sel.value=lang;
 setText('sub',t('sub'));
 document.getElementById('tok').placeholder=t('ph');
 setText('t_revert',t('t_revert'));setText('d_revert',t('d_revert'));
 setText('t_reinstall',t('t_reinstall'));setText('d_reinstall',t('d_reinstall'));
 setText('t_update',t('t_update'));setText('d_update',t('d_update'));
 if(lastData){render(lastData);}else{setText('loading',t('loading'));}}
function setLang(v){lang=v;try{localStorage.setItem('wo_lang',v);}catch(e){}applyLabels();}
async function loadStatus(){setErr('');
 try{var r=await fetch(OPS+'/status');var d=await r.json();
 if(!r.ok){setErr(d.message||d.error||('HTTP '+r.status));return;}render(d);}catch(e){setErr(String(e));}}
function render(d){lastData=d;var s=d.state||{},h=d.health||{},app=d.app||{},tn=d.tunables||{},cf=d.cf||{};
 var color=h.ok?'#22c55e':'#ef4444';
 document.getElementById('status').innerHTML=
 row('app','<span class="dot" style="background:'+color+'"></span>'+(h.ok?t('up'):t('down'))+' (HTTP '+esc(h.status)+')')+
 row(t('running'),esc(h.version||'—'))+
 row(t('ustate'),esc(s.status||'—')+(s.error?(' — '+esc(s.error)):''))+
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
 row(t('retry'),esc(tn.retryMax)+' / '+esc(tn.revertRetryMax));
 var ot=document.getElementById('opTarget');if(ot)ot.textContent=t('optarget').replace('{name}',app.workerName||'—');}
async function act(name){setErr('');if(!tok()){setErr(t('needtok'));return;}
 var L={revert:t('t_revert'),reinstall:t('t_reinstall'),update:t('t_update')};
 if(!confirm(t('confirm').replace('{op}',L[name]||name)))return;
 try{var r=await fetch(OPS+'/'+name,{method:'POST',headers:{'authorization':'Bearer '+tok()}});var d=await r.json();
 if(!r.ok)setErr(d.message||d.error||('HTTP '+r.status));setTimeout(loadStatus,1500);}catch(e){setErr(String(e));}}
applyLabels();loadStatus();setInterval(loadStatus,5000);
</script></body></html>`;
}
