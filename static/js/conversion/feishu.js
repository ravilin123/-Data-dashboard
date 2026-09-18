import { DEPS, METRIC_DEPTH, METRIC_STAGE, PERIOD, stageLabel } from './config.js';
import { downstreamPass, orderImpact, sceneCounts, toRate } from './funnel.js';
import { WB_AI } from '../shared/ai.js';
import { download } from './render/broadcast.js';
import { state } from './store.js';
import { $, esc } from '../shared/dom.js';
import { trim } from '../shared/text.js';
import { fmtVal, num } from './util.js';

/* ============================================================
   11. 飞书同步（功能 1 + 2，纯网页 Webhook）
   ============================================================ */
const FS_KEYS=['fsHook','fsSecret','fsProxy','fsApp','fsTable','fsToken','fsBaseProxy'];

/* 由工作台托管凭据时置 true，此时不再读写 localStorage —— 否则工作台的中转地址
   （127.0.0.1:5050）会被写进 localStorage，换个地址部署就会一直往一个连不上的地方发。 */
let FS_MANAGED=false;

(function restoreFeishu(){
  try{ const j=JSON.parse(localStorage.getItem('crm_feishu')||'{}');
    FS_KEYS.forEach(k=>{ if(j[k]!=null) $('#'+k).value=j[k]; });
    if(j.cardMode) $('#fsCardMode').checked=true;
  }catch(e){}
})();

/* ---- 由工作台下发配置 ----
   本页被工作台（Flask）托管时，凭据和中转地址都由工作台给，不需要用户填、
   也不需要先去首页点一个「一键配置」按钮。工作台没起来 / 接口不通时这个请求会失败，
   自动退回上面的 localStorage 方案。 */
(async function bootstrapFromWorkbench(){
  let cfg;
  try{
    const r=await fetch('/api/workbench/bootstrap',{cache:'no-store'});
    if(!r.ok) return;
    cfg=await r.json();
    if(!cfg || !cfg.managed) return;
  }catch(e){ return; }   // 不是工作台在服务本页

  FS_MANAGED=true;
  $('#fsHook').value      = cfg.webhook_relay || '';
  $('#fsProxy').value     = cfg.webhook_relay || '';
  $('#fsApp').value       = (cfg.bitable&&cfg.bitable.app_token) || 'workbench';
  $('#fsTable').value     = (cfg.bitable&&cfg.bitable.table_id) || 'workbench';
  $('#fsToken').value     = 'managed_by_workbench';   // 工作台自己加 Bearer，这里只是占位
  $('#fsSecret').value    = '';                        // 签名由工作台做
  if(cfg.card) $('#fsCardMode').checked=true;

  // AI 也由工作台代转：key 在服务端，不用填、也不会被 CORS 拦
  if(cfg.ai && cfg.ai.available){
    WB_AI.available=true;
    WB_AI.endpoint=cfg.ai.endpoint||'/api/ai/summary';
    WB_AI.model=cfg.ai.model||'';
    const k=$('#aiKey');
    if(k){ k.value=''; k.readOnly=true; k.style.opacity=.5;
           k.placeholder='由工作台托管，无需填写'; k.title='key 存在工作台的 config.json 里'; }
    const h=$('#aiHint'); if(h) h.textContent='· 由工作台代转 '+(cfg.ai.model||'');
  }else{
    const h=$('#aiHint');
    if(h) h.textContent='· 未配置 AI key（在 config.json 的 ai.api_key 填好即可免填 key）';
  }

  FS_KEYS.forEach(k=>{ const el=$('#'+k); if(el){ el.readOnly=true; el.style.opacity=.6; el.title='由工作台统一管理'; } });

  const note=document.createElement('div');
  note.className='banner ok';
  note.style.marginBottom='14px';
  note.innerHTML='🔗 <b>凭据由工作台托管</b> —— Webhook / 多维表格 / token 都走本机工作台中转，'
               + '下面的配置项已自动填好并锁定，无需手动填写。<b>发不发飞书由你点按钮决定</b>。';
  const panel=document.querySelector('#p-feishu .card');
  const anchor=panel && panel.querySelector('.autosync');
  if(anchor) panel.insertBefore(note, anchor);

  if(typeof updateFsSubject==='function') updateFsSubject();
})();

function saveFeishu(){
  if(FS_MANAGED) return;
  const o={}; FS_KEYS.forEach(k=>o[k]=$('#'+k).value.trim());
  o.cardMode=$('#fsCardMode').checked;
  try{ localStorage.setItem('crm_feishu', JSON.stringify(o)); }catch(e){}
}
FS_KEYS.forEach(k=>$('#'+k).addEventListener('input', saveFeishu));
$('#fsCardMode').addEventListener('change', saveFeishu);

async function feishuSign(secret, ts){
  const key=`${ts}\n${secret}`;
  const ck=await crypto.subtle.importKey('raw', new TextEncoder().encode(key), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', ck, new Uint8Array(0));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
function anomalyCount(){ return state.data ? (state.data.alarmTotal.length+state.data.alarmSite.length) : 0; }

/**
 * 一条消息的 body。
 *
 * 播报是**两条**（B14）：转化率监控 + 待观察商户。它们标题不同、卡片配色也不同 ——
 * 一条讲「今天出了什么事」（有异常就红），一条讲「这几家要盯着」（永远是橙，
 * 它本来就不是紧急的）。塞进同一条里飞书上会很难看，也会让人把下半截
 * 当成没修完的告警。
 *
 * @param kind 'main' | 'watch'
 */
async function buildWebhookBody(kind){
  const d=state.data;
  const ts=Math.floor(Date.now()/1000);
  const watch = kind==='watch';
  const txt = watch ? state.bc.watchTxt : state.bc.txt;
  const md  = watch ? state.bc.watchMd  : state.bc.md;
  let body;
  if($('#fsCardMode').checked){
    const n=anomalyCount();
    const header = watch
      ? { template:'orange', title:{tag:'plain_text',content:`待观察商户 ${d.tDate}`} }
      : { template:n?'red':'green', title:{tag:'plain_text',content:`转化率日报监控 ${d.tDate}`} };
    const content = md.replace(/^# .*\n/,'');   // 卡片里用 md，去掉一级标题
    body={ msg_type:'interactive', card:{ header, elements:[{tag:'markdown', content}] } };
  }else{
    body={ msg_type:'text', content:{ text: txt } };
  }
  const secret=$('#fsSecret').value.trim();
  if(secret){ body.timestamp=String(ts); body.sign=await feishuSign(secret, ts); }
  return body;
}
/** 有没有第二条要发。名单空的时候不发 —— 每天一条「今天没人要盯」是噪声。 */
const hasWatchCast = () => !!(state.bc && state.bc.watchTxt);
async function tryPost(url, body, headers){
  try{
    const res=await fetch(url,{method:'POST',headers:Object.assign({'Content-Type':'application/json'},headers||{}),body:JSON.stringify(body)});
    let data=null; try{ data=await res.json(); }catch(e){}
    return {ok:res.ok,status:res.status,data};
  }catch(e){ return {error:e.message||String(e)}; }
}
function curlOf(url, body, headers){
  const h=Object.assign({'Content-Type':'application/json'},headers||{});
  const hstr=Object.entries(h).map(([k,v])=>`-H '${k}: ${v}'`).join(' ');
  return `curl -X POST '${url}' ${hstr} \\\n  -d '${JSON.stringify(body).replace(/'/g,"'\\''")}'`;
}

/* 推送与写表抽成函数，按钮与「自动同步」共用同一条路径 */
async function pushOne(url, kind){
  const r=await tryPost(url, await buildWebhookBody(kind));
  if(r.error) return {ok:false, msg:'直连失败（多为 CORS/CSP 限制）：'+r.error};
  if(r.data && r.data.code!==undefined && r.data.code!==0)
    return {ok:false, msg:`飞书返回 code=${r.data.code}：${r.data.msg||''}`};
  return {ok:true, msg:`HTTP ${r.status||'?'}`};
}
/**
 * 推送。**串行发两条**：先转化率监控，再待观察商户。
 *
 * 串行不是讲究，是必须的 —— 并发发出去两条在群里的先后顺序不确定，
 * 而「今天出了什么事」应该排在「这几家要盯着」前面。
 * 第一条失败就不发第二条：连不上的话第二条也一样连不上，没必要再报一次同样的错。
 */
async function pushWebhook(){
  const hook=$('#fsHook').value.trim();
  if(!hook) return {skip:true, msg:'未填写 Webhook 地址'};
  const url=$('#fsProxy').value.trim() || hook;
  const a=await pushOne(url, 'main');
  if(!a.ok) return a;
  if(!hasWatchCast()) return {ok:true, msg:`已推送（${a.msg}）`};
  const b=await pushOne(url, 'watch');
  return b.ok
    ? {ok:true, msg:`已推送两条：转化率监控 + 待观察商户（${b.msg}）`}
    : {ok:false, msg:`转化率监控已发出，但待观察商户那条失败：${b.msg}`};
}
/* 三张表：场景指标 / 商户明细 / 商户名单。
   builder 现算，别缓存 —— 切周期、换日期之后内容就变了。 */
const BITABLE_JOBS = [
  {table:'scene',     label:'场景指标', build:()=>buildDailyRecords()},
  {table:'merchant',  label:'商户明细', build:()=>buildMerchantRecords()},
  {table:'watchlist', label:'商户名单', build:()=>buildWatchRecords()},
];

async function writeOneTable(tgt, job){
  const recs=job.build();
  if(!recs.length) return {ok:true, empty:true, label:job.label, n:0};
  /* 直连模式发不了多表 —— 页面上只有一个 table_id 输入框，
     而飞书的 URL 里带着表 ID。托管时才有 table 这个口子。 */
  const body={records:recs.map(f=>({fields:f}))};
  if(tgt.managed) body.table=job.table;
  const r=await tryPost(tgt.url, body, tgt.headers);
  if(r.error) return {ok:false, label:job.label, msg:'直连失败（多为 CORS/CSP 限制）：'+r.error};
  if(r.data && r.data.code!==undefined && r.data.code!==0)
    return {ok:false, label:job.label, msg:`飞书返回 code=${r.data.code}：${r.data.msg||''}`};
  // 中转说这张表没配 —— 不是错，跳过并把话带回来（是让人去 config.json 填 table_id）
  if(r.data && r.data.skipped) return {ok:true, skipped:true, label:job.label, n:0, msg:r.data.msg||''};
  return {ok:true, label:job.label, n:recs.length};
}

/**
 * 写多维表格。**串行写三张**（B10 + 「所有监控数据入表」）。
 *
 * 串行不是讲究：三张表共用一个 tenant_access_token，并发写容易撞上飞书的频控，
 * 而那个错和字段类型错误长得一样，很难查。三张表几十条记录，串行也就几百毫秒。
 *
 * 直连模式（没有工作台）只写第一张 —— 页面上只有一个 table_id 输入框，
 * 而飞书的 URL 里带着表 ID，多表要三个框。这条路本来就是兜底用的。
 */
async function writeBitable(){
  const tgt=bitableTarget();
  if(!tgt) return {skip:true, msg:'未填写 app_token / table_id'};
  if(!tgt.headers) return {skip:true, msg:'未填写 tenant_access_token'};
  const jobs = tgt.managed ? BITABLE_JOBS : BITABLE_JOBS.slice(0,1);
  const done=[], skipped=[];
  for(const job of jobs){
    const r=await writeOneTable(tgt, job);
    if(!r.ok) return {ok:false, msg:`${r.label}：${r.msg}`};
    if(r.skipped) skipped.push(`${r.label}（${r.msg}）`);
    else if(!r.empty) done.push(`${r.label} ${r.n} 条`);
  }
  if(!done.length && !skipped.length) return {ok:true, msg:'本期没有要写的记录'};
  const tail = skipped.length ? `；未写：${skipped.join('、')}` : '';
  const head = done.length ? `已写入 ${done.join('、')}` : '一条也没写';
  const more = (!tgt.managed && BITABLE_JOBS.length>1)
    ? '（直连模式只写场景指标表，多表要经工作台）' : '';
  return {ok:true, msg:head+tail+more};
}

$('#fsSend').addEventListener('click', async ()=>{
  if(!state.data){ return; }
  const st=$('#fsStatus');
  if(!$('#fsHook').value.trim()){ st.className='status err'; st.textContent='请填写 Webhook 地址。'; return; }
  if(anomalyCount()===0 && !confirm(`本期(${PERIOD})无异常，仍要推送「平稳」播报到飞书吗？`)) return;
  if(!confirmResend('webhook','推送')) return;
  st.className='status'; st.textContent='正在推送…';
  const r=await pushWebhook();
  st.className='status '+(r.ok?'ok':'err');
  st.innerHTML = r.ok ? '✅ '+esc(r.msg)
    : esc(r.msg)+(r.skip?'':(FS_MANAGED
        ? '。检查 config.json 的 feishu.webhook，或点「复制 curl」到终端执行。'
        : '。请填代理地址，或点「复制 curl」到终端 / 后端执行。'));
  if(r.ok) sent.webhook.add(syncKey());
  updateFsSubject();
});
$('#fsCopyCurl').addEventListener('click', async ()=>{
  if(!state.data) return;
  const url=$('#fsProxy').value.trim() || $('#fsHook').value.trim() || 'https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_HOOK';
  /* 两条消息就复制两条 curl（按顺序执行）—— 只给第一条的话，
     拿它去终端跑完还以为全发完了，第二条永远发不出去。 */
  const cmds=[curlOf(url, await buildWebhookBody('main'))];
  if(hasWatchCast()) cmds.push(curlOf(url, await buildWebhookBody('watch')));
  const all=cmds.join('\n\n');
  try{
    await navigator.clipboard.writeText(all);
    $('#fsCopyCurl').textContent = cmds.length>1 ? '已复制 2 条 ✓' : '已复制 ✓';
    setTimeout(()=>$('#fsCopyCurl').textContent='复制 curl',1400);
  }catch(e){ alert(all); }
});

/* ---- Bitable 记录 ---- */
/* data 可以显式传进来（无头跑那条路要它）；不传就还是取全局，页面那边一个字没改。 */
function buildDailyRecords(data){
  const d=data||state.data;
  const cntT=sceneCounts(d.dfScene, d.tDate);          // 源表「分子/分母」列解析出来的真值单量
  // 该来源的 PO 总量：先用大盘真值（分母最大的那个环节），没有就退回商户 PO 之和
  const srcPO={};
  for(const [src,m] of Object.entries(cntT))
    srcPO[src]=Math.max(0, ...Object.values(m||{}).map(x=>x.d).filter(Number.isFinite));
  for(const r of d.mergedSite)
    if(srcPO[r['来源']]==null) srcPO[r['来源']]=(srcPO[r['来源']]||0)+Math.round(num(r['PO单数_今']));
  const today=d.dfScene.filter(o=>o['统计日期']===d.tDate);
  const yest=d.dfScene.filter(o=>o['统计日期']===d.yDate);
  const yMap=new Map(); yest.forEach(o=>yMap.set(trim(o['来源'])+'|'+trim(o['类型']), o['当期值']));
  const all=[...d.alarmTotal,...d.alarmSite];
  const alarmSet=new Set(all.map(a=>a['来源']+'|'+a['异常指标']));
  const roleMap=new Map(all.map(a=>[a['来源']+'|'+a['异常指标'], a._role||'']));
  const depthName={0:'大环节',1:'子环节',2:'孙环节'};
  const recs=[];
  for(const o of today){
    const metric=trim(o['类型']); if(!(metric in DEPS)) continue;
    const key=trim(o['来源'])+'|'+metric;
    /* 底账写的环比也按**选中的这对日期**现算，和页面、告警同一个口径（第四轮 A1）。
       原来读源表那一列：口径和页面对不上，2026-09 起那列还整个没了（写进去全是空），
       而基准线正是要拿底账攒出来的分布当阈值。 */
    const rT=toRate(o['当期值']), rY=toRate(yMap.get(key));
    const dod=(rT!=null&&rY!=null&&rY!==0)?(rT-rY)/rY:null;
    const stage=METRIC_STAGE[metric], depth=METRIC_DEPTH[metric];
    /* 补的四列（B10）。原来只存比率，攒一年也回答不了「上个月一共折损多少单」
       「哪个环节全年吃掉的单最多」—— 而**历史补不回来**，今天不加，一年后还是只有比率。
       分子/分母来自源表的「分子/分母」列（sceneCounts 解析成 _n/_d），
       源表没带那列时留空，不编。 */
    const cnt=(cntT[trim(o['来源'])]||{})[metric] || null;
    const po=srcPO[trim(o['来源'])] ?? null;
    const ord=(rT!=null&&rY!=null&&cnt) ? orderImpact(rT-rY, cnt.d, downstreamPass(d.stages[trim(o['来源'])], metric)) : null;
    recs.push({日期:d.tDate, 周期:d.period||PERIOD, 来源:trim(o['来源']), 指标:metric,
      所属环节: stage!=null?`${stage}. ${stageLabel(stage)}`:'',
      层级: depthName[depth]||'',
      本期值:fmtVal(o['当期值']), 上期值:fmtVal(yMap.get(key)),
      环比: dod==null?'':`${dod>=0?'+':''}${(dod*100).toFixed(2)}%`,
      是否异常: alarmSet.has(key)?'是':'否',
      角色: roleMap.get(key)||'',
      PO单数: po, 进入本环节: cnt?cnt.d:null, 通过本环节: cnt?cnt.n:null,
      影响单量: ord==null?null:Math.round(ord)});
  }
  return recs;
}

/* ============================================================
   商户明细表（B10 后半 + 用户要求「所有监控数据都入表」）

   存的是**触发告警的下钻行**（每天约 42 条），不是全部商户 × 全部指标
   （那是每天约 1400 条、一年 50 万行）—— 用户定的。
   要做全量趋势时再说，那属于另一个量级的设计。

   ⚠ 数字列**直接发数字**，不发 "82.35%" 这种字符串。少一道字符串解析就少一类
     静默出错：解析不出来的值会被原样写进百分比字段，而飞书报的错和字段类型
     错误长得一模一样，很难查。老的场景指标表还在发字符串，那是历史包袱。
   ============================================================ */
/* data 可以显式传进来（无头跑那条路要它）；不传就还是取全局，页面那边一个字没改。 */
function buildMerchantRecords(data){
  const d=data||state.data;
  const pctNum = s => { const v=parseFloat(String(s).replace('%','')); return Number.isFinite(v)?v/100:null; };
  const out=[];
  for(const r of [...d.drillTotal, ...d.drillSite]){
    const metric=r['异常指标'], stage=METRIC_STAGE[metric];
    out.push({
      日期:d.tDate, 周期:d.period||PERIOD, 来源:r['来源'],
      用户ID:String(r['用户ID']||''), 商户名称:r['商户名称']||'', 站点:r['站点']||'',
      指标:metric, 所属环节: stage!=null?`${stage}. ${stageLabel(stage)}`:'',
      本期PO: r['本期PO总单量'] ?? null,
      进入本环节: r['进入本环节(单)'] ?? null,
      通过本环节: r['通过本环节(单)'] ?? null,
      上期比率: pctNum(r['上期比率']), 本期比率: pctNum(r['本期比率']),
      环比变动: pctNum(r['比率环比变动']),
      影响单量: r['影响单量'] ?? null,
      对大盘pt: pctNum(r['对大盘影响'].replace('pt','').replace('−','-')),
      样本少: r._small ? '是' : '否',
    });
  }
  return out;
}

/* ============================================================
   商户名单表 —— 掉量 / 新增 / 低于同行 / 刚审核通过 四类合一张

   四类合一张而不是四张：列几乎一样，分四张要建四次、查也要 union 四次。
   用「类型」列区分。
   ============================================================ */
/* data 可以显式传进来（无头跑那条路要它）；不传就还是取全局，页面那边一个字没改。 */
function buildWatchRecords(data){
  const d=data||state.data, base={日期:d.tDate, 周期:d.period||PERIOD};
  const w=d.watch||{low:[],fresh:[],omPending:[]}, c=d.churn||{lost:[],gained:[]};
  const out=[];
  const push=(type, o)=>out.push({...base, 类型:type,
    来源:'', 用户ID:'', 商户名称:'', 站点:'',
    PO单数:null, 成功率:null, 同行水平:null, 缺口pt:null,
    连续:'否', 量少:'否', 出单监控:'', 可多成单量:null, 备注:'', ...o});

  for(const x of c.lost)
    push('掉量', {来源:x['来源'], 用户ID:x['用户ID'], 商户名称:x['商户名称'], 站点:x['站点'],
                  PO单数:x['PO单数'], 成功率:x['成功率'] ?? null,
                  备注: c.partial ? `本期未走完（报表最新到 ${c.latestDaily}），可能只是还没下单` : ''});
  for(const x of c.gained)
    push('新增', {来源:x['来源'], 用户ID:x['用户ID'], 商户名称:x['商户名称'], 站点:x['站点'],
                  PO单数:x['PO单数'], 成功率:x['成功率'] ?? null,
                  量少: x.单量少?'是':'否', 出单监控:(x.出单监控||[]).join('·')});
  for(const x of w.low)
    push('低于同行', {来源:x.src, 用户ID:x.uid, 商户名称:x.name, 站点:x.site,
                      PO单数:x.po, 成功率:x.rate, 同行水平:x.基准, 缺口pt:x.缺口,
                      连续:x.连续?'是':'否', 量少:x.单量少?'是':'否',
                      出单监控:(x.出单监控||[]).join('·'), 可多成单量:x.可多成});
  for(const x of (w.omPending||[]))
    push('刚审核通过', {用户ID:x['用户ID'], 商户名称:x['商户名称'], 站点:x['站点'],
                        出单监控:'刚审核通过',
                        备注: [x['所属BD']?`BD ${x['所属BD']}`:'',
                               x['通道通过日期']?`通道通过 ${x['通道通过日期']}`:''].filter(Boolean).join(' · ')});
  return out;
}
/**
 * 写表往哪发。
 *
 * 工作台托管时直接打本机中转 `/api/feishu/bitable` —— 它自己从 config.json 取
 * app_token / table_id 并加 Bearer，页面这边不需要凭据。
 * 以前是让页面把中转地址拼成**飞书原生 URL 的样子**
 * （`{中转}/open-apis/bitable/v1/apps/workbench/tables/workbench/records/batch_create`），
 * 服务端再拿一条同形状的路由接住、把 URL 里的 app_token/table_id 整个忽略。
 * 一层只为了长得像的假兼容，删掉。顺带修好「复制写表 curl」——
 * 它原来在托管模式下会复制出一条带 `managed_by_workbench` 占位 token 的 curl，
 * 拿出去根本用不了。
 *
 * 没被工作台托管时（接口不通）才拼真正的飞书地址，用页面上填的凭据直连。
 */
function bitableTarget(){
  if(FS_MANAGED) return {url:'/api/feishu/bitable', headers:{}, managed:true};
  const app=$('#fsApp').value.trim(), table=$('#fsTable').value.trim();
  if(!app||!table) return null;
  const token=$('#fsToken').value.trim();
  const base=$('#fsBaseProxy').value.trim() || 'https://open.feishu.cn';
  return {url:`${base.replace(/\/$/,'')}/open-apis/bitable/v1/apps/${app}/tables/${table}/records/batch_create`,
          headers: token?{Authorization:'Bearer '+token}:null, managed:false};
}
function refreshRecInfo(){
  if(!state.data){ $('#fsRecInfo').textContent=''; return; }
  // 逐张报条数：只说一个总数的话，某张表突然写 0 条也看不出来
  const parts=BITABLE_JOBS.map(j=>`${j.label} ${j.build().length}`).filter(x=>!/ 0$/.test(x));
  $('#fsRecInfo').textContent = parts.length
    ? `将写入 ${parts.join(' 条 · ')} 条` : '本期没有要写的记录';
}
$('#fsWrite').addEventListener('click', async ()=>{
  if(!state.data) return;
  const st=$('#fsWriteStatus');
  if(!confirmResend('bitable','写表')) return;
  st.className='status'; st.textContent='正在写入多维表格…';
  const r=await writeBitable();
  st.className='status '+(r.ok?'ok':'err');
  st.innerHTML = r.ok ? '✅ '+esc(r.msg)
    : esc(r.msg)+(r.skip?'':(FS_MANAGED
        ? '。检查 config.json 的 feishu.bitable（app_token / table_id）和 app_secret，'
          + '或点「复制写表 curl」手动执行。'
        : '。请填代理地址，或点「复制写表 curl」手动执行。'));
  if(r.ok) sent.bitable.add(syncKey());
  updateFsSubject();
});
$('#fsCopyRecCurl').addEventListener('click', async ()=>{
  if(!state.data) return;
  /* 托管时复制打本机中转的 curl（不带凭据，能直接跑）；
     直连时才复制打飞书的那条，凭据取页面上填的。 */
  const tgt=bitableTarget();
  const url=tgt ? (tgt.managed ? location.origin+tgt.url : tgt.url)
                : 'https://open.feishu.cn/open-apis/bitable/v1/apps/APP_TOKEN/tables/TABLE_ID/records/batch_create';
  const body={records: buildDailyRecords().map(f=>({fields:f}))};
  const headers = (tgt && tgt.managed) ? {}
    : {Authorization:'Bearer '+($('#fsToken').value.trim()||'TENANT_ACCESS_TOKEN')};
  const c=curlOf(url,body,headers);
  try{ await navigator.clipboard.writeText(c); $('#fsCopyRecCurl').textContent='已复制 ✓'; setTimeout(()=>$('#fsCopyRecCurl').textContent='复制写表 curl',1400); }
  catch(e){ alert(c); }
});
$('#fsDlRec').addEventListener('click', ()=>{
  if(!state.data) return;
  download(`${PERIOD}记录_${state.data.tDate}.json`, JSON.stringify({records:buildDailyRecords().map(f=>({fields:f}))},null,2));
});

/* ============================================================
   12. 发送前的确认信息
   这里以前是「解析后自动同步」。取消了：加上日期筛选之后，
   去重 key 是「周期+本期日期」，换一次对比日期就是一个新 key，
   于是每换一次日期就往群里推一次。什么时候发改由人点按钮决定。

   sent 只用来防误触（同一期连点两次会问一句），不阻止真的想重发。
   ============================================================ */
const sent = { bitable:new Set(), webhook:new Set() };

const syncKey = () => state.data ? `${state.data.period||PERIOD}|${state.data.tDate}` : '';

/** 按钮上方那行：这次点下去到底会发哪一期的什么 */
function updateFsSubject(){
  const el=$('#fsSubject'); if(!el) return;
  if(!state.data){
    el.className='status';
    el.textContent='尚未解析数据。';
    $('#fsCnt').textContent='';
    return;
  }
  const d=state.data, n=anomalyCount(), key=syncKey();
  const done=[];
  if(sent.webhook.has(key)) done.push('已推送');
  if(sent.bitable.has(key)) done.push('已写表');
  el.className='status '+(n?'err':'ok');
  el.textContent = `${d.period||PERIOD}　本期 ${d.tDate}（对比 ${d.yDate}）　异常 ${n} 项`
                 + (done.length?`　·　本次会话${done.join('、')}`:'');
  $('#fsCnt').textContent = `${d.tDate} · 异常 ${n}`;
}

/** 同一期重复发之前问一句。true = 继续发 */
function confirmResend(kind, label){
  const key=syncKey();
  if(!key || !sent[kind].has(key)) return true;
  return confirm(`本期（${key}）本次会话已经${label}过一次了，确定再来一次吗？`);
}


/* 三个 record builder 导出来是为了让用例钉住**列名**。
   这三张表是人在飞书里手工建的（列名一字不差才写得进去），
   代码这边改个字段名不会有任何报错 —— 只会从那天起某一列全空。
   tests/bitable.mjs 拿一份列名清单钉着，改列名必须同时改用例和 README 里那张表。 */
export { anomalyCount, buildDailyRecords, buildMerchantRecords, buildWatchRecords,
         refreshRecInfo, updateFsSubject };
