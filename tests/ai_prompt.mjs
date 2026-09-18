/* AI 提示词按周期分口径（第六轮欠的那条）。
 *
 *     node tests/ai_prompt.mjs      # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 原来一套提示词打三个周期，问的是「本期检出 N 项异常，请列出关键变化」——
 * 那是**日报的问题**。周报月报拿同一套问，问出来的还是「这周哪天出了什么事」。
 *
 * ★ 的几条钉的是「不只是换套话术」：周月报**喂的素材本身**就该不一样 ——
 * 多期趋势（B5）和水平信号（B3）才是「趋势和结构」的原料，而这两样以前根本没有。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { PROMPT_LIST_TOP, buildAIPrompt, churnText, levelText, merchantScanText,
        poRateText, trendText, watchText } = await import(MODULES + 'ai_prompt.js');
const { BROADCAST_PRIO_TOP, CREEP_MIN_RUN, SMALL_MERCHANT_PO } = await import(MODULES + 'config.js');

const DATES=['2026-09-01','2026-09-02','2026-09-03','2026-09-04'];
const trend={
  dates:DATES, sources:['独立站API','Element'],
  measures:[{key:'overall',label:'整体成功率'},{key:'4',label:'4. 网关通过率'}],
  series:{ overall:{'独立站API':[0.52,0.51,0.49,0.47], 'Element':[0.23,0.23,0.24,null]},
           '4':{'独立站API':[0.80,0.79,0.77,0.75], 'Element':[0.85,0.85,0.86,null]} },
  po:{'独立站API':[5000,5100,4900,5200], 'Element':[3000,3100,3200,null]},
  partial:[false,false,false,true],
};
const levels={ noBaseline:false, checked:20, flat:0, noPool:0, thin:0,
  level:[{来源:'独立站API',指标:'4. 网关通过率',本期值:0.75,分位线:0.78,中位:0.82,影响单量:364,_isF:false,_basis:'本来源',_n:20,_gap:0.03}],
  creep:[{来源:'独立站API',指标:'1.1 校验1通过率',本期值:0.97,分位线:0.972,中位:0.98,连续期数:4,影响单量:52,_isF:false,_basis:'本来源',_n:20,_gap:0.002}] };
const watch={ low:[{site:'a.com',src:'独立站API',po:300,rate:0.30,缺口:0.12,连续期数:5,长期低位:true},
                   {site:'b.com',src:'Element',po:50,rate:0.10,缺口:0.14,连续期数:1,长期低位:false}],
              fresh:[{}], tiny:{count:3,po:12} };
const churn={ lost:[{}], lostPO:845, gone:[], partial:false };
/* 重点关注商户（B6）：一家「播报里点不到」的大户 + 一批小的。
   `影响单量` 是负数（少成多少单），`topLosers` 按它升序取前 N。 */
const merchantScan={ noBase:2, rows:[
  {来源:'Element', 商户名称:'lovegobuy.com', 站点:'lovegobuy.com', PO单数:5249,
   本期:0.2320, 上期:0.2515, 变动:-0.0195, 影响单量:-102,
   主因:{code:'1', label:'业务单支付转化率', contrib:-0.02}, 口径存疑:false},
  {来源:'独立站标准收银台', 商户名称:'vigorbuy.com', 站点:'vigorbuy.com', PO单数:1073,
   本期:0.4203, 上期:0.4814, 变动:-0.0611, 影响单量:-66,
   主因:{code:'4', label:'网关通过率', contrib:-0.05}, 口径存疑:true},
  ...[...Array(20)].map((_,i)=>({来源:'独立站API', 商户名称:`m${i}.com`, 站点:`m${i}.com`,
   PO单数:100, 本期:0.5, 上期:0.55, 变动:-0.05, 影响单量:-(20-i), 主因:null, 口径存疑:false})),
]};
/* 支付前/支付中（B7）：一家全卡在支付前、一家全卡在支付中 —— 这两种该找的人不同 */
const poRate={ ok:true, partial:false, noData:['FLYLINK'],
  rows:[
    {来源:'独立站标准收银台', PO单数:3027, 支付单数:1745, 成功单数:1313,
     业务单率:1313/3027, 支付单率:1313/1745, 总流失:1714, 支付前流失:1282, 支付中流失:432,
     支付前占比:1282/1714, mismatch:false},
    {来源:'Element', PO单数:5289, 支付单数:5289, 成功单数:1233,
     业务单率:1233/5289, 支付单率:1233/5289, 总流失:4056, 支付前流失:0, 支付中流失:4056,
     支付前占比:0, mismatch:true},
  ],
  total:{来源:'合计', PO单数:8316, 支付单数:7034, 成功单数:2546, 业务单率:2546/8316,
     支付单率:2546/7034, 总流失:5770, 支付前流失:1282, 支付中流失:4488, 支付前占比:1282/5770,
     mismatch:true}};
const base=(period)=>({period, tDate:DATES[3], yDate:DATES[2],
  alarmTotal:[{}], alarmSite:[{},{}], trend, levels, watch, churn, merchantScan, poRate});

console.log('[1] 日报：问的是巡检');
{
  const p=buildAIPrompt(base('日报'), '播报正文XYZ');
  check('说明是「日报」口径', p.includes('「日报」'), p.slice(0,120));
  check('★ 明说这是巡检', p.includes('这是**巡检**'), p.slice(0,400));
  check('喂了播报素材', p.includes('播报正文XYZ'));
  check('也给了水平信号', p.includes('跌破历史下沿'));
  check('★ 不喂多期趋势（日报不需要，那是周月报的主线）',
        !p.includes('多期趋势'), p.slice(0,600));
  check('告警数对上（1+2）', p.includes('3 项'), p.slice(0,200));
}

console.log('\n[2] ★ 周报/月报：问的是复盘，而且喂的素材不一样');
{
  for(const per of ['周报','月报']){
    const p=buildAIPrompt(base(per), '播报正文XYZ');
    check(`${per}：★ 明说不是巡检`, p.includes('不是巡检'), p.slice(0,400));
    check(`${per}：★ 喂了多期趋势`, p.includes('多期趋势') && p.includes(DATES.join(' → ')), '');
    check(`${per}：★ 要求拿多期说话、别只比首末`, p.includes('不要只比首末两期'));
    check(`${per}：★ 把慢性问题定为重点`, p.includes('这是周月报最该讲的部分'));
    check(`${per}：喂了持续低于同行的商户`, p.includes('持续低于同行的商户') && p.includes('a.com'));
    check(`${per}：播报素材降级成补充`, p.includes('补充，不是主线'), '');
    check(`${per}：★ 明确不要拿单期波动当趋势`, p.includes('单期的小波动不要当成趋势'));
  }
}

console.log('\n[3] ★ 趋势文本：多期序列真的进去了，不是只写个「有趋势」');
{
  const t=trendText(trend);
  check('★ 四期都在', DATES.every(d=>t.includes(d)), t.slice(0,200));
  check('★ 每个来源一行数值', /独立站API：52\.00% 51\.00% 49\.00% 47\.00%/.test(t), t.slice(0,400));
  check('缺的那期写「—」不写 0', t.includes('—'), t);
  check('★ 未走完的期次要提醒', t.includes('还没走完') && t.includes(DATES[3]), t.slice(0,300));
  check('PO 单量也给', t.includes('PO 单量') && t.includes('5,000'), t.slice(-300));
  check('两期以下不出趋势块', trendText({...trend, dates:[DATES[0]]})==='' );
  check('没有 trend 不炸', trendText(null)==='' && trendText(undefined)==='');
}

console.log('\n[4] 水平信号 / 名单 / 进出的文本');
{
  const l=levelText(levels);
  check('跌破那条带了中位和折损单量', l.includes('中位 82.00%') && l.includes('364 单'), l);
  /* 量词跟周期走（用户 2026-09-09：把「连续3期」改成「连续3天」）。
     只有日报能叫「天」—— 所以这里同时钉住「默认给日报的天」和「周报要给周」。 */
  check(`温水那条写了连续期数和门槛 ${CREEP_MIN_RUN}`,
        l.includes('连续 4 天') && l.includes(`≥${CREEP_MIN_RUN} 天`), l);
  check('★ 周报不能写「天」', levelText(levels, '周').includes('连续 4 周'), levelText(levels,'周'));
  check('★ 没算基准线时整块不出（不是出个空标题）', levelText({noBaseline:true})==='' );
  check('null 不炸', levelText(null)==='');

  const w=watchText(watch);
  check('说得出几家长期低位', w.includes('连续 ≥3 天的 1 家'), w);
  check('逐家带连续期数', w.includes('连续 5 天'), w);
  check('★ 月报要写「个月」不是「天」', watchText(watch, '个月').includes('连续 5 个月'),
        watchText(watch, '个月'));
  check('null 不炸', watchText(null)==='');

  check('掉量带上期单量', churnText(churn).includes('845 单'), churnText(churn));
  check('本期没走完要提醒',
        churnText({...churn, partial:true}).includes('还没走完'));
  check('null 不炸', churnText(null)==='');
}

console.log('\n[4b] ★ 播报是给群消息写的 —— 那三处刻意的省略必须写给模型');
{
  /* 播报每环节只点前 BROADCAST_PRIO_TOP 家、不足 SMALL_MERCHANT_PO 单不点名、
     还有字数预算。以前提示词一个字没说，模型看到「点名的这 3 家」就当成全部。 */
  for(const per of ['日报','周报']){
    const p=buildAIPrompt(base(per), '播报正文XYZ');
    check(`${per}：说了只点名前 ${BROADCAST_PRIO_TOP} 家`, p.includes(`只点名前 ${BROADCAST_PRIO_TOP} 家`), per);
    check(`${per}：说了不足 ${SMALL_MERCHANT_PO} 单不点名`, p.includes(`不足 ${SMALL_MERCHANT_PO} 单`), per);
    check(`${per}：★ 明说「点名的商户不是全部」`, p.includes('点名的商户不是全部'), per);
  }
  check('★ 没有播报素材时不硬加这段说明',
        !buildAIPrompt(base('日报'), '').includes('刻意的省略'));
}

console.log('\n[4c] ★ 重点关注商户（B6）：播报补不上的那块，日报周报都要喂');
{
  for(const per of ['日报','周报']){
    const p=buildAIPrompt(base(per), '播报正文XYZ');
    check(`${per}：有这一块`, p.includes('重点关注商户'), per);
    check(`${per}：★ 播报里点不到的那家大户在里面（少成 102 单）`,
          p.includes('lovegobuy.com') && p.includes('少成 102 单'), per);
  }
  const t=merchantScanText(merchantScan);
  check(`★ 超过 ${PROMPT_LIST_TOP} 家时说明只列了前几家`,
        t.includes('共 18 家') && t.includes(`少成最多的 ${PROMPT_LIST_TOP} 家`), t.split('\n')[1]);
  check('列的条数不超上限', t.split('\n').filter(l=>l.startsWith('  ') && !l.startsWith('  （')).length <= PROMPT_LIST_TOP);
  check('★ 口径存疑要带出去（主因不可全信）', t.includes('主因不可全信'), t);
  check('★ 算不出整体变动的家数要报上去', t.includes('另有 2 家算不出'), t);
  check('没有商户时不出空块', merchantScanText({rows:[], noBase:0}) === '' && merchantScanText(null) === '');
  check('全都没到门槛时不出块', merchantScanText({rows:[{影响单量:-1, PO单数:10}], noBase:0}) === '');
}

console.log('\n[4d] ★ 支付前 / 支付中（B7）：两段该找的人不同');
{
  for(const per of ['日报','周报']){
    const p=buildAIPrompt(base(per), 'x');
    check(`${per}：有这一块`, p.includes('支付前 / 支付中'), per);
  }
  const t=poRateText(poRate);
  check('★ 写明两段该找谁（不然模型会把「人没走到支付」说成支付失败）',
        t.includes('支付前查收银台和前端，支付中查风控网关'), t.slice(0,200));
  check('合计行在', t.includes('合计：PO 8,316 单'), t);
  check('★ 全卡在支付前的那家看得出来', t.includes('支付前流失 1,282 单'), t);
  check('★ 全卡在支付中的那家看得出来', t.includes('支付前流失 0 单'), t);
  check('★ mismatch 要带出去', t.includes('劈法不可全信'), t);
  check('★ 缺行的来源要报出来，并说明没按 0 计',
        t.includes('FLYLINK') && t.includes('没有按 0 计'), t);
  check('本期没走完时说明单量环比不可比',
        poRateText({...poRate, partial:true}).includes('单量环比不可比'));
  check('算不出来时不出空块', poRateText({ok:false, rows:[]}) === '' && poRateText(null) === '');
}

console.log('\n[5] 边界');
{
  check('没数据给空串', buildAIPrompt(null)==='' && buildAIPrompt(undefined)==='');
  const bare=buildAIPrompt({period:'周报', tDate:'x', yDate:'y'}, null);
  check('只有周期也能出提示词，不炸', bare.length>200, bare.length);
  check('缺素材时不出空块', !bare.includes('===== 多期趋势'), bare);
  check('播报素材缺失写「（无）」', bare.includes('（无）'), bare.slice(-200));
}

check.report();
