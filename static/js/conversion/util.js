import { CLIP_UPPER_DEFAULT } from './config.js';
import { esc } from '../shared/dom.js';
import { trim } from '../shared/text.js';

/* ============================================================
   2. 工具函数
   ============================================================ */
function num(x){ if(x==null||x==='') return 0; const n=Number(String(x).replace(/,/g,'').replace(/%/g,'')); return Number.isFinite(n)?n:0; }
function pad2(n){ return String(n).padStart(2,'0'); }
function normDate(v){
  if(v==null||v==='') return '';
  if(v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad2(v.getMonth()+1)}-${pad2(v.getDate())}`;
  return String(v).trim();
}
function pct(v){ return (v*100).toFixed(2)+'%'; }
/** 带符号的 pt 差值。原来住在 render/overview.js，而播报层也要用 ——
    渲染层被非渲染层 import，正是 broadcast ↔ render/overview 那个环的成因。 */
const ptFmt = v => (v>=0?'+':'−')+Math.abs(v*100).toFixed(2)+'pt';
/**
 * 折损单量写成人话：负数 = 减少，正数 = 增加（B1）。
 *
 * 群里那句话应该是「减少 210 单」，不是「环比 −6.2%」—— 后者说了等于没说，
 * 因为看的人还得自己换算成单量才知道要不要管。
 *
 * ⚠ 用「减少/增加」不用「少成/多成」：后者是内部黑话，读的人得先反应一下
 *   「成」指的是成交还是成功。这个数在页面上有列头（对大盘·成功单）撑着，
 *   在播报里有环节抬头撑着，动词写成最普通的那个就够了。
 *
 * |值| < 1 时写「不足 1 单」而不是「0 单」：真的是零和四舍五入成零，
 * 在这里是两件事 —— 前者说明这条根本不值得看，后者说明它擦着边。
 */
function ordFmt(n){
  if(n==null || !Number.isFinite(n)) return '';
  const a=Math.abs(n);
  if(a<1) return (n<0?'减少':'增加')+'不足 1 单';
  return (n<0?'减少 ':'增加 ')+Math.round(a).toLocaleString()+' 单';
}
/** 被 CLIP_UPPER_DEFAULT 封顶的比率要带标记 —— 不然页面上那个 150.00% 看着像测出来的。
    传空串 = 没封顶，不出标记。 */
const capTag = v => v ? ` <span class="tag-warn" title="源表原值 ${esc(v)}，超出上限 ${pct(CLIP_UPPER_DEFAULT)} 已封顶">封顶</span>` : '';
function fmtVal(x){
  if(x==null||x==='') return 'N/A';
  if(typeof x==='number') return (Math.abs(x)<=1.5?(x*100).toFixed(2)+'%':String(x));
  return String(x);
}
/* $ 和 esc 搬到 ../shared/dom.js 了（三处曾各有一份、行为还不一样）。
   这里原样再导出，本目录里的 import 路径不用动。 */
function ffill(rows, col){
  let last=null;
  for(const r of rows){
    let v=r[col];
    const blank = v==null || (typeof v==='string' && v.trim()==='');
    if(blank){ r[col]=last; } else { last=v; }
  }
}
function cleanId(x){
  if(x==null) return '未知';
  if(typeof x==='number' && Number.isFinite(x) && x===Math.trunc(x)) return String(Math.trunc(x));
  const s=String(x).trim();
  if(s===''||s.toLowerCase()==='nan') return '未知';
  return s;
}


export { capTag, cleanId, ffill, fmtVal, normDate, num, ordFmt, pct, ptFmt, trim };
