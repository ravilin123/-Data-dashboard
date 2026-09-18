/* 支付失败原因归类（static/js/shared/fail_group.js）。
 *
 *     node tests/fail_group.mjs
 *
 * 这套用例钉的不是"分得对不对"（那是业务口径，会变），而是**四条一旦破了就静默出错**
 * 的性质：
 *
 *   [1] 编码优先于文案。文案里「风控拦截」四个字飞来汇和发卡行**两边都在用**，
 *       只看文案会把发卡行风控拒绝算成我方拦截，方向完全反了。
 *   [2] SUB_RULES 的**顺序就是口径**。`Card issuer declined the transaction due to risk`
 *       同时含 `due to risk` 和 `Card issuer declined`，顺序一反风险那类直接归零。
 *   [3] 一条关键词都没命中的走兜底进「发卡行拒绝」（用户 2026-09-09 定的），
 *       但**兜底的笔数要单独数出来**。失败原因 71.2% 是网关英文原文，写法随网关变，
 *       兜底的量只会涨；不报这个数，那一组哪天变成一锅粥没人看得见。
 *   [4] ZFCS / ZFZF 用户说不会出现在流水里 —— 真出现了要单独计数，不能混进网关拦截。
 *       那说明前提变了，是要知道的事。
 */
import { MODULES, makeChecker } from './_harness.mjs';
const check = makeChecker();
const SHARED = MODULES.replace('/conversion/', '/shared/');
const { FALLBACK_SUB, G_3DS, G_GW, G_ODD, G_RISK, S_CARD, S_ISSUER, S_ISSUER_RISK, S_PAYER,
        classifyFail, gatewaySub, groupFailures, unifiedCodeOf } = await import(SHARED + 'fail_group.js');

console.log('[1] 编码优先：有统一编码就不看文案');
{
  const c = classifyFail({fail_code:'ZFFK00003', fail_reason:'Card issuer declined the transaction'});
  check('ZFFK → 风控拦截（文案说的是发卡行拒绝也不改判）', c.group===G_RISK && c.sub===null, JSON.stringify(c));
  check('编码档的 hit 标成「编码」', c.hit==='编码', c.hit);

  const d = classifyFail({fail_code:'ZF3D00002', fail_reason:'consumer abandons verification'});
  check('ZF3D → 3DS验证失败（不掉进付款人问题）', d.group===G_3DS && d.sub===null, JSON.stringify(d));

  /* ★ 这条是整套的核心。模板里这条的「具体原因」写的是「付款人首次使用该卡，
     发卡行风控拦截」—— 是**发卡行**的风控。只看文案关键词会算成飞来汇风控拦截。 */
  const e = classifyFail({fail_reason:'Blocked, first used-transaction from new cardholder'});
  check('★ 「发卡行风控拦截」的文案不能算成我方风控拦截',
        e.group===G_GW && e.sub===S_ISSUER_RISK, JSON.stringify(e));

  // 三处都要找得到编码：报错编码 / 初始失败原因编码 / 文案里内嵌的【ZFxx00000】
  check('编码在 fail_code2 也认', unifiedCodeOf({fail_code2:'ZFFK00005'})==='ZFFK00005');
  check('编码内嵌在文案里也认', unifiedCodeOf({fail_reason:'风控系统拦截【ZFFK00004】'})==='ZFFK00004');
  check('小写编码归一化成大写', unifiedCodeOf({fail_code:'zffk00002'})==='ZFFK00002');
  check('不是统一编码的码不认（旧版 MN3DSFAIL）', unifiedCodeOf({fail_code:'MN3DSFAIL'})===null);
}

console.log('[2] ZFWG 与无码都进网关拦截，再按文案拆');
{
  const a = classifyFail({fail_code:'ZFWG00007', fail_reason:'Card issuer declined the transaction due to risk'});
  check('ZFWG → 网关拦截（不是单独一类）', a.group===G_GW, a.group);
  check('★ 顺序敏感：due to risk 先于 Card issuer declined',
        a.sub===S_ISSUER_RISK, `${a.sub} / hit=${a.hit}`);

  const b = classifyFail({fail_reason:'Insufficient funds'});
  check('无码 → 网关拦截', b.group===G_GW && b.code===null, JSON.stringify(b));
  check('Insufficient funds → 付款人卡片问题', b.sub===S_CARD, b.sub);

  // 用户 2026-09-09 点名的那批，全部算付款人卡片问题
  for(const [t, want] of [
    ['Exceeds withdrawal amount limit', S_CARD],
    ['Exceeded card payment limit', S_CARD],
    ['Expired card', S_CARD],
    ['Invalid card number', S_CARD],
    ['Closed Account', S_CARD],
    ['Unable to authorise', S_CARD],
  ]) check(`「${t}」→ ${want}`, gatewaySub(t).sub===want, gatewaySub(t).sub);

  // ZFWG00005：支付信息(手机号/邮箱/用户名)有误 —— 用户定为付款人问题
  check('ZFWG00005 文案 → 付款人问题',
        classifyFail({fail_code:'ZFWG00005', fail_reason:'支付信息(手机号、邮箱或用户名）有误或未注册'}).sub===S_PAYER);
  check('payment canceled → 付款人问题', gatewaySub('The payment is canceled').sub===S_PAYER);
  check('declined by your bank → 发卡行拒绝', gatewaySub('Card declined by your bank').sub===S_ISSUER);
  check('大小写不敏感', gatewaySub('INSUFFICIENT FUNDS').sub===S_CARD);
}

console.log('[3] 兜底：没命中的进发卡行拒绝，但笔数要单独数出来');
{
  check('兜底档就是发卡行拒绝', FALLBACK_SUB===S_ISSUER, FALLBACK_SUB);
  check('空文案 → 兜底', gatewaySub('').sub===S_ISSUER && gatewaySub('').fallback===true);
  check('没见过的文案 → 兜底', gatewaySub('Zorp error 9981').sub===S_ISSUER);
  check('★ 命中关键词的不算兜底', gatewaySub('Card issuer declined').fallback===false);
  check('★ 兜底的没有 hit（和真命中区分得开）', gatewaySub('Zorp error 9981').hit==='');

  const rows=[
    {fail_reason:'Insufficient funds',         pay_method:'VISA'},
    {fail_reason:'Insufficient funds',         pay_method:'VISA'},
    {fail_reason:'Zorp error 9981',            pay_method:'MC'},
    {fail_reason:'Zorp error 9981',            pay_method:'MC'},
    {fail_reason:'Quux timeout',               pay_method:'MC'},
    {fail_reason:'Card declined by your bank', pay_method:'MC'},
    {fail_code:'ZFFK00003', fail_reason:'风控系统拦截', pay_method:'VISA'},
  ];
  const g = groupFailures(rows, {methodOf:r=>r.pay_method});
  check('总数对得上', g.total===7, String(g.total));
  check('★ 没有「未归类」这一组了', !g.groups.some(x=>/未归类/.test(x.label)),
        JSON.stringify(g.groups.map(x=>x.label)));
  const iss=g.groups.find(x=>x.sub===S_ISSUER);
  check('★ 兜底的并进发卡行拒绝（3 笔兜底 + 1 笔真命中）', iss.n===4, JSON.stringify(iss));
  check('★ 每组带 fallbackN，看得出这组有多少是兜底来的', iss.fallbackN===3, String(iss.fallbackN));
  check('★ 兜底总数单独统计', g.fallback.n===3, JSON.stringify(g.fallback));
  check('兜底占比 = 3/7', Math.abs(g.fallback.share-3/7)<1e-9, String(g.fallback.share));
  check('★ 兜底给出原文 TOP，让人能补规则',
        g.fallback.tops[0].text==='Zorp error 9981' && g.fallback.tops[0].n===2,
        JSON.stringify(g.fallback.tops));
  check('兜底 label 指向落在哪一组', g.fallback.label===`${G_GW} · ${S_ISSUER}`, g.fallback.label);
  check('真命中的那组 fallbackN=0', g.groups.find(x=>x.sub===S_CARD).fallbackN===0);
  check('分组按笔数从多到少', g.groups[0].n>=g.groups[g.groups.length-1].n);
  const risk=g.groups.find(x=>x.group===G_RISK);
  check('风控拦截独立成组', !!risk && risk.n===1, JSON.stringify(risk));
  const card=g.groups.find(x=>x.sub===S_CARD);
  check('支付方式分布跟着算好（不让 AI 自己数）',
        card.methods[0].m==='VISA' && card.methods[0].n===2, JSON.stringify(card.methods));
  check('占失败比算好了', Math.abs(card.share-2/7)<1e-9, String(card.share));
  check('空 rows 不炸', groupFailures([]).total===0 && groupFailures().total===0);
  check('全命中时兜底为 0', groupFailures([{fail_reason:'Insufficient funds'}]).fallback.n===0);
}

console.log('[4] ZFCS / ZFZF：用户说不会出现，真出现要单独报');
{
  const a=classifyFail({fail_code:'ZFCS00012', fail_reason:'Insufficient funds'});
  check('ZFCS 不混进网关拦截', a.group===G_ODD, JSON.stringify(a));
  const b=classifyFail({fail_code:'ZFZF00030', fail_reason:''});
  check('ZFZF 不混进网关拦截', b.group===G_ODD, JSON.stringify(b));
  const g=groupFailures([{fail_code:'ZFCS00012'},{fail_reason:'Insufficient funds'}]);
  check('★ 单独成组，看得见', g.groups.some(x=>x.group===G_ODD && x.n===1), JSON.stringify(g.groups.map(x=>x.label)));
  check('★ ZFCS 没文案也不算网关兜底', g.fallback.n===0, JSON.stringify(g.fallback));
}

check.report();
