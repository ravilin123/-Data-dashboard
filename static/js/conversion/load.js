import { ALLOWED_SOURCES, ALLOW_OVER_ONE, ALL_METRICS, CLIP_UPPER_DEFAULT, PERIOD, PERIOD_ORDER, canonMetric, canonSource } from './config.js';
import { toRate } from './funnel.js';
import { shortSite, trim } from '../shared/text.js';
import { cleanId, ffill, normDate, num } from './util.js';

/* ============================================================
   3. 数据读取（对应 load_scene / load_merchant）
   ============================================================ */
function sheetRows(ws){
  // 返回二维数组（含所有原始行），空单元格为 null
  return XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:true});
}

/* ---- 源表「环比」列：唯一的识别处 ----
   2026-09 改版把这一列**整个拿掉了**（上游说后面会加回来）。它一没，detect() 读不到
   就整行跳过，于是一条告警都判不出来 —— 而页面会照常显示绿色的「大盘平稳」。
   所以这里做两件事：把认得的列名归一成 o['环比']，并让 formatDrift() 能说出它在不在。

   **加回来时只改这个数组。** 下游（detect / computeBaseline）只认归一后的 '环比'，
   一个字都不用动。日/周/月三种叫法是业务本来就在用的（见 config.js 的 PERIODS.dod）。

   口径已核实（2026-09-08，拿 2026-07-30 旧格式报表比对）：这一列是**相对环比**
   (今−昨)/昨，不是 pt 差值。日/周/月三个周期 346 对可比数据里，143 对只符合相对、
   **0 对符合 pt**、203 对变动太小两者分不开、0 对都不符合。例：业务单支付成功率
   40.31% ← 46.56%，源表环比 -0.1342 —— 相对算出 -0.1342 完全吻合，pt 是 -0.0625。
   所以 detect() 直接拿它和 LEVEL_THRESHOLDS 比是对的。
   写法上两种都出现过：旧表发裸小数（-0.1342），也见过带 % 的文本；
   detect() 的 `Math.abs(d)<1 ? d : d/100` 两种都吃得下。
   ⚠️ 上游若哪天改发 pt 差值，要在这里换算 —— 和 toRate/num 那次一样，
   口径错了两级都不报错，只是一直判错。tests/dod_column.mjs 钉的就是这个口子。 */
const DOD_ALIASES = ['环比','日环比','周环比','月环比'];

/** 表头里实际用的是哪个环比列名；一个都没有则返回 null。 */
function dodColumnOf(header){
  return DOD_ALIASES.find(a=>header.includes(a)) || null;
}

function sceneObjs(wb){
  const ws = wb.Sheets['场景维度'];
  const rows = sheetRows(ws);
  const header = rows[0].map(trim);
  const objs = rows.slice(1).map(r=>{
    const o={}; header.forEach((h,i)=>{ if(h) o[h]=r[i]; }); return o;
  });
  // 环比列归一到 '环比'：下游只认这一个名字
  const dodCol = dodColumnOf(header);
  if(dodCol && dodCol!=='环比') objs.forEach(o=>{ o['环比']=o[dodCol]; });
  for(const c of ['时间类别','统计日期','来源']) if(header.includes(c)) ffill(objs,c);
  objs.forEach(o=>{ if('统计日期' in o) o['统计日期']=normDate(o['统计日期']); });
  // 新旧写法归一，下游一律按带编号的指标名和新来源名匹配
  objs.forEach(o=>{
    if('类型' in o) o['类型']=canonMetric(o['类型']);
    if('来源' in o) o['来源']=canonSource(o['来源']);
  });
  // 源表自带「分子/分母」时直接取真值单量，免去逆算（逆算对 4.1 这类分母会失真）
  const frCol = header.find(h=>/^分子\s*[\/／]\s*分母$/.test(h) || h==='分子分母');
  if(frCol) objs.forEach(o=>{
    const v=o[frCol]; if(v==null) return;
    const m=String(v).split(/[\/／]/);
    if(m.length!==2) return;
    const n=Number(String(m[0]).replace(/[,\s]/g,'')), d=Number(String(m[1]).replace(/[,\s]/g,''));
    if(Number.isFinite(n)&&Number.isFinite(d)){ o._n=n; o._d=d; }
  });
  return objs;
}

/* 上游认得但**故意不分析**的来源。放进白名单是为了让下面那条「未识别」提示
   重新有意义 —— 不区分的话，每次都报一串本来就不该分析的东西，
   真正新增/改名的来源就淹在里面了。 */
const KNOWN_UNANALYZED_SOURCES = {
  'FLYPAY':'全局汇总，和子场景重复计数',
  '合计':'同一商户跨来源汇总，按来源归因时不能用',
  'FLYLINK商品订单':'另一条业务线，漏斗多四个 BuyNow 环节',
  'FLYLINK快捷订单':'另一条业务线',
};
/* 同理：认得但**不进漏斗树**的指标。
   ⚠️ 名字里的「unanalyzed」只是说它不是漏斗树上的一个节点，**不是说没人用**。
   `业务单支付成功率` 一直是头条数字（OVERALL_METRIC），`支付单支付成功率` 从
   第十五轮起也在用（po_rate.js 的两段拆账）。这两个留在这里是为了让 formatDrift
   别把它们报成「没见过的新指标」—— 拿掉的话每期都会多两条假的漂移提示。 */
const KNOWN_UNANALYZED_METRICS = new Set([
  '业务单支付成功率','支付单支付成功率',
  // 环节1 没有独立指标（= 1.1 × 1.2），源表给了但漏斗树用不上
  '1. 业务单支付转化率',
  'BuyNow转化率','BuyNow点击率','BuyNow邮箱提交率','BuyNow地址提交率',
]);

/**
 * 报表格式还在变，而两个白名单（ALLOWED_SOURCES / METRIC_CANON）都是
 * 「认不出就丢掉」—— 上游改个名字，那个来源或指标会**一声不响地消失**，
 * 页面照常出图，只是少了一块，没人会发现。
 * 这里把认不出来的都列出来：认得但不分析的走灰字，真没见过的高亮。
 */
function formatDrift(wb){
  let objs; try{ objs=sceneObjs(wb); }catch(e){ return null; }
  /* 环比列在不在，也算一种格式漂移 —— 而且是最要命的那种：
     它一没，告警链路整条静默失效，页面还显示「大盘平稳」。 */
  let dodHeader=[]; try{ dodHeader=sheetRows(wb.Sheets['场景维度'])[0].map(trim); }catch(e){}
  const dodCol=dodColumnOf(dodHeader);
  const srcSeen=new Set(), mSeen=new Set();
  for(const o of objs){
    const s=trim(o['来源']); if(s) srcSeen.add(s);
    const m=trim(o['类型']); if(m) mSeen.add(m);
  }
  const known=new Set([...ALL_METRICS, ...KNOWN_UNANALYZED_METRICS]);
  return {
    newSources: [...srcSeen].filter(x=>!ALLOWED_SOURCES.includes(x) && !KNOWN_UNANALYZED_SOURCES[x]),
    skipSources:[...srcSeen].filter(x=>!ALLOWED_SOURCES.includes(x) &&  KNOWN_UNANALYZED_SOURCES[x]),
    newMetrics: [...mSeen].filter(x=>!known.has(x)),
    usedSources:[...srcSeen].filter(x=>ALLOWED_SOURCES.includes(x)),
    dodColumn: {present: !!dodCol, name: dodCol},
  };
}

/** 探测源文件里实际存在哪些周期（且各自至少有两期数据可对比）。 */
function detectPeriods(wb){
  let objs; try{ objs=sceneObjs(wb); }catch(e){ return {}; }
  const out={};
  for(const p of PERIOD_ORDER){
    const rows=objs.filter(o=> trim(o['时间类别'])===p && ALLOWED_SOURCES.includes(trim(o['来源'])) );
    const dates=[...new Set(rows.map(o=>o['统计日期']).filter(d=>d))];
    out[p]={rows:rows.length, dates:dates.length, ok: rows.length>0 && dates.length>=2};
  }
  return out;
}

/**
 * @param opts.allSources 不按 ALLOWED_SOURCES 过滤（merchant 漏斗要看「合计」和 FLYLINK）。
 *        默认 false —— 转化率分析那条路一个字不变。
 */
function loadScene(wb, period, {allSources=false}={}){
  const cat = period||PERIOD;
  return sceneObjs(wb).filter(o=> trim(o['时间类别'])===cat &&
    (allSources || ALLOWED_SOURCES.includes(trim(o['来源']))) );
}

/** 表里实际出现过哪些「时间类别」。PERIOD_ORDER 只有日/周/月，而源表还发季报。 */
function discoverPeriods(wb){
  let objs; try{ objs=sceneObjs(wb); }catch(e){ return []; }
  return [...new Set(objs.map(o=>trim(o['时间类别'])).filter(x=>x))];
}

/** 商户表的 sheet 名。旧版叫「场景×商户维度」，2026-09 起叫「商户维度」。 */
const MERCHANT_SHEETS = ['商户维度','场景×商户维度'];
const merchantSheetName = wb => MERCHANT_SHEETS.find(n=>wb.SheetNames.includes(n));

function loadMerchant(wb, period, {allSources=false}={}){
  const cat = period||PERIOD;
  const ws = wb.Sheets[merchantSheetName(wb)];
  if(!ws) throw new Error('缺少商户维度 sheet（认「商户维度」或「场景×商户维度」）');
  const raw = sheetRows(ws);

  /* 表头行数两种：旧版是两行（第 0 行放带编号的指标名，第 1 行放基础字段名），
     新版压成一行。用「时间类别 出现在第几行」判断，不靠行数硬编码。 */
  const twoRow = !raw[0].map(trim).includes('时间类别') && raw[1] && raw[1].map(trim).includes('时间类别');
  const hIdx = twoRow ? 1 : 0;
  const headerRow = raw[hIdx].map(trim);
  // PO单数 在新表带尾随空格，trim 后再找
  let poIdx = headerRow.indexOf('PO单数'); if(poIdx<0) poIdx = twoRow ? 6 : headerRow.length-1;
  const baseHeaders = headerRow.slice(0,poIdx+1);
  const metricNames = (twoRow ? raw[0].slice(poIdx+1) : headerRow.slice(poIdx+1))
    .filter(x=>x!=null && trim(x)!=='').map(canonMetric);
  const cols = baseHeaders.concat(metricNames);

  let objs = raw.slice(hIdx+1).map(r=>{
    const o={}; cols.forEach((c,i)=>{ o[c]=r[i]; }); return o;
  });

  for(const c of ['时间类别','统计日期','来源','用户ID','商户名称']) if(cols.includes(c)) ffill(objs,c);
  objs.forEach(o=>{ if('统计日期' in o) o['统计日期']=normDate(o['统计日期']); });
  for(const c of ['用户ID','商户名称','站点']) if(cols.includes(c)) objs.forEach(o=>{ o[c]=cleanId(o[c]); });
  objs.forEach(o=>{ if('来源' in o) o['来源']=canonSource(o['来源']); });
  /* 新表去掉了「商户名称」列（旧表是脱敏的 CL**********C，本来也读不出是谁）。
     用站点域名顶上 —— 比脱敏串可读得多，播报里那行会自动去重不重复显示。 */
  if(!cols.includes('商户名称')){
    objs.forEach(o=>{ o['商户名称']=shortSite(o['站点']); });
    cols.push('商户名称');
  }

  objs = objs.filter(o=> trim(o['时间类别'])===cat &&
    (allSources || ALLOWED_SOURCES.includes(trim(o['来源']))) );
  objs.forEach(o=>{
    o['PO单数']=num(o['PO单数']);
    for(const m of metricNames){
      /* 比率一律走 toRate，**不能**用 num。
         num() 只是把 '%' 抹掉：'99.99%' → 99.99。而从这里往下一整条链路
         —— pct()、delta*100、chainDenom 的累乘、CLIP_UPPER_DEFAULT ——
         全部按「小数比率」算（0.9999 = 99.99%）。商户表的比率单元格两种形态
         都出现过：文本 '99.99%' 和数值 0.9999。num() 分不出来，toRate() 能，
         场景维度那边（sceneMap）本来就一直用的是它。

         用 num() 的后果是两级放大，而且**两级都不报错**：
           2. 业务校验通过率（ALLOW_OVER_ONE 里唯一一个，不裁剪）
               99.99% → 存成 99.99 → 显示 9999.00%
           其余所有指标
               84.57% → 存成 84.57 → 被 CLIP_UPPER_DEFAULT 裁成 1.5 → 显示 150.00%
         第二种更糟：真值当场丢掉，所有商户被裁成同一个 1.5，
         于是商户级明细、环比变动、影响比率排序、播报里的商户归因全部失真。 */
      let v=toRate(o[m]); if(v==null||v<0)v=0;   // 空单元格仍按 0，与原行为一致
      const upper = ALLOW_OVER_ONE.includes(m)?null:CLIP_UPPER_DEFAULT;
      /* 封顶要留痕。上游真的会发「政策3DS通过率 = 302.78%」这种（分子分母不同源），
         裁完页面上就是一个干干净净的 150.00% —— 看不出它被改过，也就没法判断
         该信它还是该去问上游。原值记在 _clip_<指标> 上，明细表里标出来。 */
      if(upper!=null && v>upper){ o['_clip_'+m]=v; v=upper; }
      o[m]=v;
    }
  });

  const hasSite = cols.includes('站点');
  if(hasSite){
    const dfSite  = objs.filter(o=> o['站点']!=='合计' && o['PO单数']>0 && o['站点']!=='未知' );
    /* 商户级合计。旧表上游直接给了「站点=合计」的行；新表没有 ——
       它的「合计」挪到了 来源 列，含义还变了（是同一商户**跨来源**的汇总），
       按来源归因时用它是错的，所以不能拿来顶。
       没有现成行时就按 (来源, 用户ID) 把站点卷起来自己算。
       实测 81 个商户里 78 个只有一个站点，那部分是精确复制；
       多站点的三家做 PO 加权，各指标分母不同所以是近似 —— 只影响商户级
       合计视图的排序，站点级明细（dfSite）始终是原始值。 */
    /* 上游给的合计行优先（是真值），缺的那些用站点卷积补上。
       原来写的是「一行都没有才回退」—— 而上游很可能只给多站点商户发合计行
       （单站点商户的合计等于它自己，没必要发）。那样 66 个商户的合计视图
       会只剩 3 个，其余 63 个凭空消失且没有任何提示。按商户逐个补才对。 */
    const upstream = objs.filter(o=> o['站点']==='合计' && o['PO单数']>0 );
    let dfTotal = upstream;
    if(dfSite.length){
      const have = new Set(upstream.map(o=>[o['时间类别'],o['统计日期'],o['来源'],o['用户ID']].join('\u0000')));
      const missing = dfSite.filter(o=>!have.has([o['时间类别'],o['统计日期'],o['来源'],o['用户ID']].join('\u0000')));
      if(missing.length) dfTotal = upstream.concat(rollupToMerchant(missing, metricNames));
    }
    /* all = 换算后、拆分前的原始行。dfSite 去掉了「站点=合计」、dfTotal 又掺了
       按站点卷出来的合成行 —— merchant 漏斗要的是源表本来那些行，两个都不合用。 */
    return {dfSite, dfTotal, hasSite, metricNames, all:objs};
  }
  const df = objs.filter(o=> o['PO单数']>0 );
  return {dfSite:df, dfTotal:[], hasSite, metricNames, all:objs};
}

/** 站点级 → 商户级：按 (时间类别, 统计日期, 来源, 用户ID) 归并，比率按 PO 加权。 */
function rollupToMerchant(rows, metricNames){
  const m=new Map();
  for(const r of rows){
    const k=[r['时间类别'],r['统计日期'],r['来源'],r['用户ID']].join('\u0000');
    let e=m.get(k);
    if(!e){
      e={...r, 站点:'合计', 'PO单数':0, _acc:{}};
      // 合计是 PO 加权均值，不再对应源表某一个被封顶的单元格，标记不能顺着 spread 带过来
      for(const kk of Object.keys(e)) if(kk.startsWith('_clip_')) delete e[kk];
      m.set(k,e);
    }
    const w=num(r['PO单数']); e['PO单数']+=w;
    for(const mt of metricNames){ e._acc[mt]=(e._acc[mt]||0)+num(r[mt])*w; }
  }
  const out=[...m.values()];
  out.forEach(e=>{
    const w=e['PO单数']||1;
    for(const mt of metricNames) e[mt]=e._acc[mt]/w;
    delete e._acc;
  });
  return out;
}


export { KNOWN_UNANALYZED_SOURCES, detectPeriods, discoverPeriods, formatDrift, loadMerchant, loadScene, merchantSheetName };
