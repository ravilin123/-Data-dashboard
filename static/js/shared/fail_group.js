/* ============================================================
   支付失败原因归类（2026-09-09，用户给的模板 + 映射表）

   原来没有任何归类：AI 提示词只写了一句「按可优化程度归组（如：需风控侧评估、
   需先确认状态、优化空间有限）」，「如：」后面那三个只是举例 —— 代码里没有映射，
   每次跑分组名都可能不一样，同一个失败原因这次进这组下次进那组。

   ⚠️ **两级判定，编码优先，不能反过来。**（用户 2026-09-09 定的）

     ① 有统一失败原因编码 → 编码说了算，**不看文案**
          ZFFK*  → 风控拦截（飞来汇自己的风控，含反洗钱）
          ZF3D*  → 3DS验证失败
          ZFWG*  → 网关拦截，进第二级
     ② 没有统一编码 → **一律网关拦截**，进第二级

   为什么编码必须优先：文案里「风控拦截」这四个字**两边都在用**。
   实测模板里 `Blocked, first used-transaction from new cardholder` 的说明写的是
   「付款人首次使用该卡，**发卡行风控拦截**」—— 那是发卡行的风控，不是飞来汇的。
   只看文案会把一批发卡行拒绝算成我方风控拦截，方向完全反了。
   用户的原话：「只要是飞来汇系统拦截的交易，都已经配置好了统一编码了。
   没有统一编码的一律是网关拦截，到网关拦截再按关键词拆分。」

   ⚠️ `ZFCS`（收银台自校验）和 `ZFZF`（支付系统）**不会出现在支付流水记录里**
   （用户确认）。所以那 175 个码不用管。真出现了单独计数报出来，不静默塞进网关 ——
   那说明用户的前提变了，是要知道的事。

   ⚠️ 网关拦截内部**一条关键词都没命中的走兜底**，进 `FALLBACK_SUB`（发卡行拒绝），
   见下方那块注释。没有「未归类」这一档了 —— 但兜底进来的笔数照样单独数着。
   ============================================================ */

/** 统一失败原因编码：ZF + 两位系统码 + 5 位数字。 */
const UNIFIED_CODE_RE = /ZF(FK|3D|WG|CS|ZF)\d{5}/i;

const G_RISK = '风控拦截';
const G_3DS  = '3DS验证失败';
const G_GW   = '网关拦截';
const G_ODD  = '⚠️ 其他统一编码';      // ZFCS / ZFZF —— 按用户说明不该出现在流水里

/** 编码前缀 → 一级归类。 */
const CODE_GROUP = { FK:G_RISK, '3D':G_3DS, WG:G_GW, CS:G_ODD, ZF:G_ODD };

const S_ISSUER_RISK = '发卡行风险拒绝';
const S_CARD        = '付款人卡片问题';
const S_PAYER       = '付款人问题';
const S_ISSUER      = '发卡行拒绝';

/* 一条关键词都没命中时归到哪。用户 2026-09-09 定的：「未归类的，先统一都归到
   发卡行拒绝里」—— 网关拒了又没给出可辨认的理由，最接近的解释就是发卡行拒绝。

   ⚠️ **兜底进来的要单独计数**（`fallback`），这不是把口径打回「未归类」，
   是为了兑现那个「**先**」字：失败文案 71.2% 是网关英文原文，写法随网关变，
   兜底的量只会涨不会跌。哪天它占了发卡行拒绝的一大半，那一组就不能再当结论用了，
   而不报这个数的话没人看得见这件事。界面和提示词都把它写出来。 */
const FALLBACK_SUB  = S_ISSUER;

/**
 * 网关拦截内部的关键词规则。**顺序就是口径的一部分**：先命中先算。
 *
 * ⚠️ 必须「先特异后泛化」。`Card issuer declined the transaction **due to risk**`
 * 同时含 `due to risk` 和 `Card issuer declined` —— 前者在风险组、后者在泛拒绝组，
 * 顺序一反就全归成普通拒绝，风险那一类直接归零。
 * `tests/fail_group.mjs` 拿这条当用例钉着，别调换 SUB_RULES 的顺序。
 *
 * ⚠️ 中英文都要有。实测「失败原因报错」列只有 28.8% 配过中文规范文案，
 * 71.2% 是网关英文原文 —— 只写中文等于大半匹配不上。
 */
const SUB_RULES = [
  [S_ISSUER_RISK, [
    'due to risk', 'Restricted card', 'Lost card', 'Pickup card',
    'first used-transaction', 'Blocked by cardholder', 'blocked by issuer',
    'not supported/blocked', 'violation of law', 'not permitted to acquirer',
    '卡受限', '已挂失', '发卡行风控',
  ]],
  [S_CARD, [
    'Insufficient funds', 'over credit limit', 'Exceeds withdrawal amount limit',
    'Exceeded card payment limit', 'Expired card', 'expiration date missing',
    'Card expired', 'Invalid card number', 'Invalid account number',
    'Closed Account', 'Account not yet activated', 'Already reversed',
    'Lifecycle reasons', 'Unable to authorise', 'Unable to authorize',
    '资金不足', '限额不足', '卡过期', '卡号验证失败', '账户关闭', '账户异常', '无法授权',
  ]],
  [S_PAYER, [
    'payment canceled', 'payment cancelled',
    'payment is canceled', 'payment is cancelled',
    'consumer aborted', 'abandons verification', 'abandoned',
    "didn't complete payment within the time limit", 'within the time limit',
    'authentication info incorrect', 'submitted incorrect information',
    'Invalid address', 'Postal code is missing', 'Parse error, invalid XML',
    '取消交易', '交易已取消', '已失效', '放弃认证', '超时未支付',
    'CVV填写有误', '有效期填写有误', '支付信息(手机号',
  ]],
  [S_ISSUER, [
    'declined by your bank', 'Card issuer declined', 'cardholder declined',
    'Invalid transaction', 'Invalid merchant', 'service provider',
    'semantically', 'Timeout in communication with the issuer',
    '银行拒绝', '发卡行拒绝', '无效交易',
  ]],
];

/** 从一行里把统一编码找出来。三处都找：报错编码、初始编码、文案里的【ZFxx00000】。 */
function unifiedCodeOf(row){
  const parts=[row && row.fail_code, row && row.fail_code2, row && row.fail_reason];
  for(const p of parts){
    const m = p==null ? null : String(p).match(UNIFIED_CODE_RE);
    if(m) return m[0].toUpperCase();
  }
  return null;
}

/**
 * 网关拦截内部按文案拆。一条都没命中（含空文案）走 `FALLBACK_SUB` 兜底，
 * 并把 `fallback:true` 带出去 —— 分组统计靠它单独数，见 FALLBACK_SUB 上方。
 */
function gatewaySub(text){
  const hay=String(text||'').toLowerCase();
  if(hay.trim()){
    for(const [sub, kws] of SUB_RULES){
      for(const k of kws) if(hay.includes(k.toLowerCase())) return {sub, hit:k, fallback:false};
    }
  }
  return {sub:FALLBACK_SUB, hit:'', fallback:true};
}

/**
 * 一行 → 归类。
 * @param row {fail_reason, fail_code, fail_code2}
 * @returns {group, sub, label, code, hit}
 *          sub 只有 group 是「网关拦截」时才有值。
 */
function classifyFail(row){
  const code=unifiedCodeOf(row);
  if(code){
    const m=code.match(UNIFIED_CODE_RE);
    const group=CODE_GROUP[(m[1]||'').toUpperCase()] || G_ODD;
    if(group!==G_GW) return {group, sub:null, label:group, code, hit:'编码', fallback:false};
    const {sub, hit, fallback}=gatewaySub(row && row.fail_reason);
    return {group, sub, label:`${group} · ${sub}`, code, hit, fallback};
  }
  // 没有统一编码 → 一律网关拦截（用户 2026-09-09 定的）
  const {sub, hit, fallback}=gatewaySub(row && row.fail_reason);
  return {group:G_GW, sub, label:`${G_GW} · ${sub}`, code:null, hit, fallback};
}

/**
 * 一批失败行 → 分组统计。**工具自己算好再喂给 AI**，不让 AI 自己分组。
 *
 * @param rows 失败的那些行
 * @param opt.methodOf 取支付方式的函数（不同页面字段名不一样，别写死）
 * @returns {total, groups:[{label, group, sub, n, fallbackN, share, methods, samples}],
 *           fallback:{n, share, tops, label}}
 *          `fallback` 是「一条关键词都没命中、按兜底进 FALLBACK_SUB」的那部分。
 *          它**不是**一个独立分组（已经并进发卡行拒绝了），但必须报出来 ——
 *          理由见 FALLBACK_SUB 上方。`groups[].fallbackN` 是每组里兜底进来的笔数。
 */
function groupFailures(rows, {methodOf}={}){
  const mm = methodOf || (r=>r && r.pay_method);
  const acc=new Map(); const fbTexts=new Map();
  let total=0, fbTotal=0;
  for(const r of (rows||[])){
    const c=classifyFail(r);
    total++;
    let e=acc.get(c.label);
    if(!e){ e={label:c.label, group:c.group, sub:c.sub, n:0, fallbackN:0, methods:new Map(), samples:[]}; acc.set(c.label, e); }
    e.n++;
    const pm=mm(r); if(pm) e.methods.set(pm, (e.methods.get(pm)||0)+1);
    /* 样本去重：同一条文案摆两遍占着位置，还让人以为是两种不同的错。 */
    const fr = r && r.fail_reason ? String(r.fail_reason).slice(0,90) : '';
    if(fr && e.samples.length<3 && !e.samples.includes(fr)) e.samples.push(fr);
    if(c.fallback){
      e.fallbackN++; fbTotal++;
      const t=fr || '(空)';
      fbTexts.set(t, (fbTexts.get(t)||0)+1);
    }
  }
  const groups=[...acc.values()].sort((a,b)=>b.n-a.n).map(e=>({
    label:e.label, group:e.group, sub:e.sub, n:e.n, fallbackN:e.fallbackN,
    share: total? e.n/total : 0,
    methods:[...e.methods.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>({m:k, n:v})),
    samples:e.samples,
  }));
  return {total, groups, fallback:{
    n: fbTotal, share: total? fbTotal/total : 0, label: `${G_GW} · ${FALLBACK_SUB}`,
    tops:[...fbTexts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([t,n])=>({text:t, n})),
  }};
}

export { CODE_GROUP, FALLBACK_SUB, SUB_RULES, UNIFIED_CODE_RE,
         G_3DS, G_GW, G_ODD, G_RISK,
         S_CARD, S_ISSUER, S_ISSUER_RISK, S_PAYER,
         classifyFail, gatewaySub, groupFailures, unifiedCodeOf };
