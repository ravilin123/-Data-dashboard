import { r2 } from './util.js';

/* ============================================================
   金额分档（按数据自适应）

   从 `merchant.html` 拆出来（2026-09-09）。这块**自带可变状态**
   （`AMOUNT_LABELS` / `AMOUNT_SCHEME` 读数据时会被换掉），所以单独成一个模块：
   ES module 的 import 是只读绑定，赋值必须和 `let` 待在同一个文件里，
   否则「谁能改它」这件事会散到几个模块去。改只走 `setAmountScheme()` 一个口子。
   ============================================================ */
/* 金额分档。固定档位是默认，但它是照着「几十到几百刀的实物电商」定的，
   对订阅制/数字商品完全失效 —— 本次真实数据 99.2% 塌进 0-1 和 1-20 两档，
   后面五档一笔都没有，这个维度等于白给。所以改成按数据自适应，见 buildAmountScheme。 */
const AMOUNT_BINS_FIXED   = [0, 1, 20, 50, 100, 500, 1000, 3000, 5000];
const AMOUNT_LABELS_FIXED = ["0-1","1-20","20-50","50-100","100-500","500-1000","1000-3000","3000-5000"];
/* 这两个是运行时的当前档位，读数据时由 buildAmountScheme 换掉。
   下游（分类种子、排序、交叉表）一律读 AMOUNT_LABELS，不认识具体是哪套。 */
let AMOUNT_LABELS = AMOUNT_LABELS_FIXED.slice();
let AMOUNT_SCHEME = null;


const amtKey = v => Math.round(v*100)/100;          // 金额比大小一律先归到分
const amtFmt = v => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/* 固定档位（原逻辑，一字未改，只是搬进函数里当其中一套方案） */
function cutFixed(v){
  if(v === null || v === undefined || isNaN(v)) return null;
  if(v < AMOUNT_BINS_FIXED[0] || v > AMOUNT_BINS_FIXED[AMOUNT_BINS_FIXED.length-1]) return null;
  for(let i=0;i<AMOUNT_LABELS_FIXED.length;i++){
    const lo = AMOUNT_BINS_FIXED[i], hi = AMOUNT_BINS_FIXED[i+1];
    if(i === 0){ if(v >= lo && v <= hi) return AMOUNT_LABELS_FIXED[i]; }
    else if(v > lo && v <= hi) return AMOUNT_LABELS_FIXED[i];
  }
  return null;
}
const fixedScheme = note => ({kind:"fixed", labels:AMOUNT_LABELS_FIXED.slice(), cut:cutFixed,
  note: note || "固定档位"});

/* 按数据挑一套档位。三选一，优先级从「最能说事」到「最保底」：

   1. 价位点 —— 少数几个价位就覆盖绝大多数交易（订阅制、数字商品、会员档位都长这样）。
      这时候「$0.99 通过率多少 / $6.99 通过率多少」是能直接拿去调价目表的，
      而「0-1 档 vs 1-20 档」什么也说明不了。
   2. 固定档位 —— 数据在固定档位上本来就铺得开，那就别动，跨商户跨周期可比。
   3. 分位档 —— 金额连续分布但固定档位不合身（比如客单价整体偏高或偏低），
      按分位自动切，保证每档笔数相当。

   分位法对本次数据反而失效：p1=p25=0.99，切点全撞一起，
   所以第 3 条自己也会塌，塌了就老实退回固定档，不硬造。 */
function buildAmountScheme(amounts){
  const vals = amounts.filter(v => typeof v==="number" && isFinite(v) && v>=0).map(amtKey);
  const n = vals.length;
  if(!n) return fixedScheme("无有效金额，用固定档位");

  // ---- 1. 价位点 ----
  const cnt = new Map();
  for(const v of vals) cnt.set(v,(cnt.get(v)||0)+1);
  const byCnt = [...cnt.entries()].sort((a,b)=>b[1]-a[1]);
  /* 取点按「这个价位自己占多少」，不是「累计够了没」。
     累计到 90% 就收手会把还有份量的价位一起扫进「其他」——
     实测那样只取 7 个点，「其他」就攒到 503 笔、通过率 61%（全表最差），
     而它到底差在哪个价位上完全看不出来。按 ≥1% 取，能取到 10 个点、
     覆盖 99.09%，「其他」缩到 56 笔，才是真正的长尾。 */
  let acc=0, take=0;
  for(let i=0;i<byCnt.length && i<12;i++){
    if(byCnt[i][1]/n < 0.01) break;
    acc+=byCnt[i][1]; take=i+1;
  }
  if(take>0 && acc/n >= 0.90){
    const pts = byCnt.slice(0,take).map(x=>x[0]).sort((a,b)=>a-b);
    const set = new Set(pts), tail = n-acc;
    const labels = pts.map(amtFmt); if(tail>0) labels.push("其他");
    return {kind:"price", labels, cut:v=>{
        if(v===null||v===undefined||isNaN(v)) return null;
        const k=amtKey(v); return set.has(k)?amtFmt(k):(tail>0?"其他":null);
      },
      note:`按价位点分档，${take} 个价位覆盖 ${r2(acc/n*100)}% 交易`
           + (tail>0?`，其余 ${tail} 笔归「其他」`:"")};
  }

  // ---- 2. 固定档位铺得开就不动 ----
  const share = new Map();
  for(const v of vals){ const l=cutFixed(v); if(l) share.set(l,(share.get(l)||0)+1); }
  const spread = [...share.values()].filter(c=>c/n>=0.02).length;
  if(spread>=4) return fixedScheme(`固定档位，${spread} 档各占 2% 以上，分布够散`);

  // ---- 3. 分位档 ----
  const sorted = vals.slice().sort((a,b)=>a-b);
  const q = pp => { const i=(sorted.length-1)*pp, lo=Math.floor(i), hi=Math.ceil(i);
                    return sorted[lo]+(sorted[hi]-sorted[lo])*(i-lo); };
  const raw = [sorted[0]]; for(let k=1;k<6;k++) raw.push(q(k/6)); raw.push(sorted[sorted.length-1]);
  const edges = [...new Set(raw.map(amtKey))].sort((a,b)=>a-b);
  // 切点撞一起说明金额高度集中，分位法在这种数据上分不出档，退回固定档
  if(edges.length < 4) return fixedScheme(`金额过度集中（${cnt.size} 个不同金额），分位切点重合，退回固定档位`);
  const labels=[]; for(let i=0;i<edges.length-1;i++) labels.push(`${amtFmt(edges[i])}-${amtFmt(edges[i+1])}`);
  return {kind:"quantile", labels, cut:v=>{
      if(v===null||v===undefined||isNaN(v)) return null;
      const k=amtKey(v);
      if(k<edges[0]||k>edges[edges.length-1]) return null;
      for(let i=0;i<edges.length-1;i++){
        if(i===0 ? (k>=edges[0]&&k<=edges[1]) : (k>edges[i]&&k<=edges[i+1])) return labels[i];
      }
      return null;
    },
    note:`按分位自动分档，${labels.length} 档，每档笔数相当`};
}

function cutAmount(v){ return (AMOUNT_SCHEME||fixedScheme()).cut(v); }


/** 换掉当前档位。**只有 `loadAndClean` 调它** —— 别在别处改档位。 */
function setAmountScheme(scheme){
  AMOUNT_SCHEME = scheme;
  AMOUNT_LABELS = scheme.labels;
  return scheme;
}

export { AMOUNT_BINS_FIXED, AMOUNT_LABELS, AMOUNT_LABELS_FIXED, AMOUNT_SCHEME,
         amtFmt, amtKey, buildAmountScheme, cutAmount, cutFixed, fixedScheme, setAmountScheme };
