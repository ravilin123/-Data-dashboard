import { buildAmountScheme, setAmountScheme } from './amount.js';
import { COLUMN_MAP, DERIVED_COLS, L3_FAIL_KEYWORDS, L3_KEEP_KEYWORDS, RISK_BLOCK_KEYWORDS } from './config.js';
import { aggregate, isFail, pct, r2 } from './util.js';

/* ============================================================
   数据读取与清洗（对应 Python 的 load_and_clean）+ 过滤

   从 `merchant.html` 拆出来（2026-09-09）。

   ⚠️ **`PRESENT` / `IGNORED_COLS` / `SKIPPED_COLS` 是可变的，而且只在
   `loadAndClean` 里赋值。** 它们和赋值点必须待在同一个文件里 —— ES module 的
   import 是只读绑定，别的模块 import 过去只能读、不能改，这正是我们要的：
   「谁能改它」只有这一个地方。金额档位同理，在 `amount.js`。
   ============================================================ */
let PRESENT = new Set();   // 源数据中存在的标准列
function hasCol(col){ return PRESENT.has(col); }

function toNum(v){
  if(v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g,""));
  return isNaN(n) ? 0 : n;
}

/* 抹掉毫秒。支付时间本来就只到秒，毫秒一律是解析噪声 ——
   xlsx 把日期存成序列号（浮点天数）时，SheetJS 转回 Date 会差个 1ms，
   实测 2026-07-10 01:00:00 被读成 00:59:59.999。平时无所谓，
   但正好压在整点上的那笔会掉进上一个小时的桶，正好压在 00:00:00 的
   会掉到前一天 —— 按日趋势和按小时热力都会错，而且错得毫无征兆。
   源文件把日期存成文本时没有这个问题，所以同一份数据换个导出工具
   结果就对不上，极难排查。 */
function roundToSec(d){
  const t = d.getTime();
  return isNaN(t) ? null : new Date(Math.round(t/1000)*1000);
}
function toDate(v){
  if(v instanceof Date) return isNaN(v) ? null : roundToSec(v);
  if(v === null || v === undefined || v === "") return null;
  if(typeof v === "number"){ // excel 序列号兜底
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : roundToSec(d);
  }
  const d = new Date(String(v).replace(/-/g,"/"));
  return isNaN(d) ? null : roundToSec(d);
}

function cleanWebsite(s){
  s = String(s).trim().replace(/^https?:\/\//i,"").replace(/^www\./i,"");
  return s.replace(/\/+$/,"");
}

/* 确认过「不分析」的列。放进来不是为了少干活，是为了让「未识别」这个提示
   重新有意义 —— 导出有 50 列，其中 24 列本来就不该进分析，
   全都报成「未识别」的话，真正拼错的表头就淹在里面看不见了。
   值是不分析的理由，鼠标悬停能看到，省得下次有人又来问「这列为什么没用」。 */
const KNOWN_UNUSED = {
  // 各种单号/标识：与已用的单号重复，或纯技术标识，没有分析价值
  "camelpay流水号":"通道流水号，对账用", "流水单号":"与支付单号重复",
  "关联业务订单号":"商户侧单号", "ARN":"卡组织参考号，拒付追溯用",
  "cfid":"内部标识", "用户ID":"内部标识，买家维度用邮箱", "通道子商户号":"通道侧标识",
  // 交易分类：本商户单一形态，拆开没有区分度
  "交易类型":"本商户单一形态", "交易来源":"本商户单一形态",
  "贸易类型":"本商户单一形态", "贸易子类型":"本商户单一形态",
  // 资金/结算：结算口径，与支付成功率无关
  "通道结算金额":"结算口径", "通道结算汇率":"结算口径",
  "商户手续费":"结算口径", "商户结算汇率":"结算口径",
  "核定成本手续费":"结算口径", "结算金额":"结算口径",
  "入账状态":"入账口径，不影响支付是否成功",
  "预计入账时间":"入账口径", "实际入账时间":"入账口径",
  "RDR快速争议解决":"拒付处置流程，不在成功率口径内",
  // 其余
  "创建时间":"取不到实际用户耗时，时间维度用支付时间",
  "收货人手机号":"实测全空", "收货国家":"实测全空",
  "是否支持3D":"支付方式本身的能力，不受商户控制；等价于「这笔是不是卡支付」",
};

let IGNORED_COLS = [];   // 白名单外的，真·没认出来
let SKIPPED_COLS = [];   // 白名单内的，确认不分析

/* 列名兜底匹配：源表列名常有细微出入（大小写、括号、"买家邮箱" vs "邮箱"），
   为这一个字改一次 COLUMN_MAP 太脆。命中标准列且该列还没被认领时才生效。 */
const COLUMN_FUZZY = [
  [/邮箱|email/i,                       "buyer_email"],
  [/(ip).*(国家|國家|country)|(国家|國家|country).*(ip)/i, "ip_country"],
  // BIN 国家写法尤其杂：大小写、繁简、"发卡国"/"issuer country" 都见过。
  // 必须排在 ip_country 后面 —— 先让 IP 认领，剩下的才轮到 BIN，
  // 否则「买家ip国家」这种同时含"国家"的列会被抢走。
  [/bin.*(国家|國家|country)|(发卡|發卡|issuer).*(国|國|country)/i, "bin_country"],
  [/收货.*(国家|國家|country)/i,        "ship_country"],
  [/卡组|card.?(brand|scheme|type)/i,   "card_brand"],
];

function loadAndClean(rawRows, headers){
  // 建立 源列名(trim) -> 标准列名
  const rename = {};
  headers.forEach(h => { const t = String(h).trim(); if(COLUMN_MAP[t]) rename[t] = COLUMN_MAP[t]; });
  // 精确表没命中的，再走一遍兜底匹配
  const claimed = new Set(Object.values(rename));
  headers.forEach(h => {
    const t = String(h).trim();
    if(rename[t]) return;
    for(const [re,std] of COLUMN_FUZZY){
      if(re.test(t) && !claimed.has(std)){ rename[t]=std; claimed.add(std); break; }
    }
  });
  const unmapped = headers.map(h=>String(h).trim()).filter(t=>t && !rename[t]);
  SKIPPED_COLS = unmapped.filter(t=>  KNOWN_UNUSED[t]);
  IGNORED_COLS = unmapped.filter(t=>! KNOWN_UNUSED[t]);
  PRESENT = new Set(Object.values(rename));
  if(PRESENT.has("fail_reason_init")||PRESENT.has("fail_reason_old")||PRESENT.has("fail_reason_full")) PRESENT.add("fail_reason");
  if(PRESENT.has("fail_code")||PRESENT.has("fail_code2")) PRESENT.add("fail_code");

  const out = [];
  for(const raw of rawRows){
    const r = {};
    for(const key in raw){
      const t = String(key).trim();
      // 用上面算好的 rename，别再查一遍 COLUMN_MAP —— 那样兜底匹配到的列会被漏掉
      if(rename[t]) r[rename[t]] = raw[key];
    }
    // amount
    r.amount = toNum(r.amount);
    // bin_country: nan->"" , strip
    if(PRESENT.has("bin_country")){
      let b = (r.bin_country === null || r.bin_country === undefined) ? "" : String(r.bin_country).trim();
      if(b.toLowerCase() === "nan") b = "";
      r.bin_country = b;
    }
    // pay_time -> 有效才保留
    const pt = toDate(r.pay_time);
    if(pt === null) continue;               // dropna(subset=["pay_time"])
    r.pay_time = pt;
    // website 清洗
    if(PRESENT.has("website") && r.website !== null && r.website !== undefined){
      r.website = cleanWebsite(r.website);
    }
    // status 归一
    if(r.status !== null && r.status !== undefined) r.status = String(r.status).trim();
    // fail_reason 合成：优先「初始失败原因」→「支付失败原因」(旧)→「失败原因报错」(带编码)
    const _fne = (...xs)=>{ for(const x of xs){ if(x!==null&&x!==undefined&&String(x).trim()!=="") return x; } return null; };
    /* 文案以「失败原因报错」(fail_reason_full) 为准 —— 那是平台侧的统一口径列。
       原来把「初始失败原因」(fail_reason_init) 排在最前，那列是网关原样返回的，
       同一个失败在不同网关下写法都不一样。
       注意别把 full 当成「一定是中文规范文案」：实测只有 28.8% 配置过（中文带【编码】），
       其余 71.2% 仍是网关英文原文。有什么用什么，配没配都照单接收。 */
    const fr = _fne(r.fail_reason_full, r.fail_reason_init, r.fail_reason_old);
    r.fail_reason = fr===null?null:String(fr).trim();
    const fc = _fne(r.fail_code, r.fail_code2);
    r.fail_code = fc===null?null:String(fc).trim();
    // currency
    if(r.currency !== null && r.currency !== undefined) r.currency = String(r.currency).trim();
    // day：按日聚合用。「先排除技术故障、再谈业务」要能按天看错误码有没有结构性突变，
    // 没有这个字段就只能对着期间总数猜，故障窗口和真实业务变化分不开。
    r.day = pt.getFullYear()+"-"+String(pt.getMonth()+1).padStart(2,"0")
              +"-"+String(pt.getDate()).padStart(2,"0");
    out.push(r);
  }
  /* amount_range 得等全部行读完才能算 —— 档位是看整批数据的分布挑的，
     不像其他派生字段能逐行独立算出来。所以放在循环外做第二遍。 */
  const scheme = setAmountScheme(buildAmountScheme(out.map(r=>r.amount)));
  for(const r of out) r.amount_range = scheme.cut(r.amount);
  return out;
}


/* ============================================================
   排除风控 / L3 失败（对应 exclude_risk / exclude_l3_fail / has_dim_data）
   ============================================================ */
// 关键词匹配时同时看 失败原因文字 + 报错编码（新格式编码在单独列，旧格式内嵌在文字里）
function failHaystack(r){ return String(r.fail_reason||"") + " " + String(r.fail_code||""); }
function excludeRisk(rows){
  if(!hasCol("fail_reason")) return rows;
  return rows.filter(r => { const s = failHaystack(r); return !RISK_BLOCK_KEYWORDS.some(kw => s.includes(kw)); });
}
function excludeL3(rows){
  if(!hasCol("fail_reason")) return rows;
  return rows.filter(r => {
    if(r.fail_reason === null || r.fail_reason === undefined) return true; // isna -> 保留
    const s = failHaystack(r);
    // 命中 L3 关键词才考虑排除；但若同时命中“保留名单”(通道发起，如 ZFWG)，则保留
    return !L3_FAIL_KEYWORDS.some(kw => s.includes(kw)) || L3_KEEP_KEYWORDS.some(kw => s.includes(kw));
  });
}
/* 只留这一维有值的行。给 BIN 系列用 ——「卡BIN国家为空」不是一个国家，
   它是「这笔根本不是卡支付」（实测空值 3650 笔全是 ApplePay/GooglePay，
   非空 2491 笔全是 VISA/MASTERCARD/AmEx，零重叠）。
   把空当成一个分组去排影响力，比出来的是「钱包 vs 美国卡」，不是国家差异 ——
   钱包 80.7% 压着 US 卡 49.7%，读表的人会以为美国发卡行在拒付，
   其实是钱包免了 3DS。所以 BIN 维度一律只在卡支付内部比。 */
function withDim(rows, col){
  return rows.filter(r => { const v=r[col]; return v!==null && v!==undefined && String(v).trim()!==""; });
}
function hasDimData(rows, col){
  if(!rows || !hasCol(col) || rows.length === 0) return false;
  return rows.some(r => { const v = r[col]; return v !== null && v !== undefined && String(v).trim() !== ""; });
}
function currencyBreakdown(rows){
  if(!hasCol("currency") || rows.length === 0) return [];
  const total = rows.length, m = new Map();
  for(const r of rows){ const c = (r.currency===null||r.currency===undefined||r.currency==="")?"未知":String(r.currency); m.set(c,(m.get(c)||0)+1); }
  return [...m.entries()].sort((a,b)=>b[1]-a[1]).map(([c,n])=>[c,n,r2(n/total*100)]);
}


// ⚠ KNOWN_UNUSED 必须导出：页面拿它给「已知不分析 N 列」拼 tooltip
//   （merchant.html 的 fileInfo 那一行）。2026-09-09 拆分时搬进来却没导出，
//   而那一行挂在 `SKIPPED_COLS.length > 0` 底下 —— 只有上传的流水里真的有
//   这几列时才会跑到，于是快照比对全绿放行，用户传对了文件才炸成「读取失败」。
export { IGNORED_COLS, KNOWN_UNUSED, PRESENT, SKIPPED_COLS,
         cleanWebsite, currencyBreakdown, excludeL3, excludeRisk, failHaystack,
         hasCol, hasDimData, loadAndClean, toDate, toNum, withDim };
