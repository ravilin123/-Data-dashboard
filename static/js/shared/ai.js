/* ============================================================
   AI 调用栈 —— 两个工具页共用

   原来两页各有一份，结构一样但**功能不齐**：
     · conversion 的 aiDirect 写死 base URL，且不返回 finish_reason
     · conversion 的用量展示只有一行朴素文本；merchant 那份带千分位、
       显示上限与用掉百分比、finish_reason 异常提示，**用掉八成以上还会提醒
       把 config.json 的 ai.max_tokens 调大一档**
   统一取功能齐的那份，两页都拿到。
   ============================================================ */
import { esc } from './dom.js';

/* 直连路径（工作台代转不可用时的兜底）的默认值。代转路径一律以 config.json 为准，
   这两个常量碰都不碰。原来这边硬编码 'deepseek-chat'，那个模型供应商已经下线，
   直连必报 400。 */
const AI_BASE_URL = 'https://api.deepseek.com';
const AI_MODEL = 'deepseek-v4-pro';
const AI_MAX_TOKENS = 8000;

/** 由工作台的 /api/workbench/bootstrap 填。每个页面各一份（模块实例不跨页共享）。 */
const WB_AI = { available:false, endpoint:'', model:'' };

/* 提示词发出去之前先估个大小。精确 token 数只有接口自己知道（各家分词器不同），
   但「这次要发多少字」是当场就能算的，量级不会差 ——
   中文按 ~0.8 token/字、ASCII 按 ~0.28 估，够判断「会不会太大」。 */
function promptSize(t){
  let cjk=0, ascii=0;
  for(const ch of t){ const c=ch.codePointAt(0);
    if(c>=0x4E00&&c<=0x9FFF || c>=0x3000&&c<=0x303F || c>=0xFF00&&c<=0xFFEF) cjk++;
    else if(c<128) ascii++; }
  return {chars:t.length, est:Math.round(cjk*0.8+ascii*0.28+(t.length-cjk-ascii)*0.5)};
}

/** 用量的事实条目。usageText / usageBanner 都基于它，两页的说法就不会再分叉。 */
function usageBits(u, promptEst){
  if(!u) return [];
  const bits=[];
  const n = x => Number(x).toLocaleString();
  if(u.prompt!=null) bits.push(`输入 ${n(u.prompt)} tokens`);
  else if(promptEst) bits.push(`输入约 ${n(promptEst)} tokens（估算）`);
  if(u.completion!=null){
    let t=`输出 ${n(u.completion)}`;
    if(u.max_tokens) t+=` / 上限 ${n(u.max_tokens)}（用掉 ${Math.round(u.completion/u.max_tokens*100)}%）`;
    if(u.reasoning!=null) t+=`，其中思考 ${n(u.reasoning)}`;
    bits.push(t);
  }
  if(u.finish_reason && u.finish_reason!=='stop') bits.push(`finish_reason=${u.finish_reason}`);
  return bits;
}

/** 用掉八成以上就该提醒了 —— 别等真被截断才发现 max_tokens 不够。 */
function usageTight(u){
  return !!(u && u.completion!=null && u.max_tokens && u.completion/u.max_tokens>=0.8);
}
const TIGHT_HINT = '　⚠ 已用掉八成以上，建议把 config.json 的 ai.max_tokens 调大一档';

/** 纯文本版（塞 textContent 用）。 */
function usageText(u, promptEst){
  const bits=usageBits(u, promptEst);
  return bits.length ? '　·　'+bits.join('　') + (usageTight(u)?TIGHT_HINT:'') : '';
}

/** HTML 横幅版（塞 innerHTML 用）。 */
function usageBanner(u, promptEst){
  const bits=usageBits(u, promptEst);
  if(!bits.length) return '';
  const tight=usageTight(u);
  return `<div class="banner${tight?' warn':''}" style="margin-top:6px">额度用量：${esc(bits.join(' · '))}`
       + (tight?TIGHT_HINT:'') + '</div>';
}

/** 经工作台代转（有 config.json 的 key，且不受 CORS 限制）。 */
async function aiViaWorkbench(prompt){
  const r=await fetch(WB_AI.endpoint||'/api/ai/summary',{method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt})});
  const data=await r.json().catch(()=>({}));
  if(!r.ok || !data.ok) throw new Error(data.msg || ('工作台返回 '+r.status));
  return {content:(data.content||'').trim(), usage:data.usage||null};
}

/** 浏览器直连（工作台代转不可用时的兜底，多半会被 CORS 拦，拦了就落到手动兜底）。 */
async function aiDirect(prompt, key, {baseUrl}={}){
  const base=(baseUrl||AI_BASE_URL).replace(/\/$/,'');
  const resp=await fetch(base+'/chat/completions',{method:'POST',
    headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model:AI_MODEL,max_tokens:AI_MAX_TOKENS,stream:false,messages:[
      {role:'system',content:'你是一名专业、谨慎、只依据给定数据说话的支付数据分析师。'},
      {role:'user',content:prompt}]})});
  if(!resp.ok) throw new Error('接口返回 '+resp.status+'：'+(await resp.text()).slice(0,200));
  const data=await resp.json();
  const content=data?.choices?.[0]?.message?.content?.trim();
  if(!content) throw new Error('返回格式异常');
  const u=data.usage||{};
  return {content, usage:{prompt:u.prompt_tokens, completion:u.completion_tokens,
    reasoning:(u.completion_tokens_details||{}).reasoning_tokens, max_tokens:AI_MAX_TOKENS,
    finish_reason:data?.choices?.[0]?.finish_reason||null}};
}

export { AI_BASE_URL, AI_MODEL, AI_MAX_TOKENS, WB_AI,
         aiDirect, aiViaWorkbench, promptSize, usageBanner, usageBits, usageText };
