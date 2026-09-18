/* 只在一期出现的商户 / 整个消失的来源（第四轮 A2 + A3）。
 *
 *     node tests/churn.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * buildMerged() 是内连接：`const y = yMap.get(keyOf(t)); if(!y) return;`。
 * 两类商户因此**永远不会出现在任何视图里**：
 *   · 昨天有量、今天归零  → 今期没有这条 key，join 掉。这是最该报的一类。
 *   · 今天首次有量        → 上期没有这条 key，join 掉。
 * 来源整个消失同理：stageAnalysis 只遍历本期有的来源，页面上就是少一张卡，
 * 不报错也不提示。
 *
 * 这套用例钉住「丢了要说出来」，以及排序（按 PO 倒序 —— 掉一家 3000 单的
 * 和掉一家 3 单的不是一回事）。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
const XLSX = installBrowserStubs();
const check = makeChecker();

const { readReport } = await import(MODULES + 'dataset.js');
const { analyze }    = await import(MODULES + 'analyze.js');
const { buildChurn, buildMerged, periodEnd, periodIncomplete, sourceChurn } = await import(MODULES + 'funnel.js');
const { broadcastTxt, watchTxt } = await import(MODULES + 'broadcast.js');

const METRICS = [['4. 网关通过率','网关通过率'], ['2. 业务校验通过率','业务校验通过率']];
const Y='2026-09-05', T='2026-09-06';

/* 两期的商户名单故意不一样：
 *   U1 U2 两期都在（正常进 merged）
 *   U3   只有今期  → 新增
 *   U4   只有上期  → 掉量，而且是最大的一家（3000 单）
 *   U5   只有上期  → 掉量，很小的一家（3 单）
 * 来源：独立站API 两期都有；独立站标准收银台 只有上期；Element 只有今期。
 * （三个都必须在 ALLOWED_SOURCES 里 —— 不在白名单的来源 readReport 会直接丢掉，
 *   那是另一件事，`formatDrift()` 管的。）
 */
const MERCH = [
  // [date, uid, 来源, PO]
  [Y,'U1','独立站API',500], [T,'U1','独立站API',520],
  [Y,'U2','独立站API',400], [T,'U2','独立站API',380],
  [T,'U3','独立站API',77],
  [Y,'U4','独立站API',3000],
  [Y,'U5','独立站API',3],
];
const SCENE = [
  [Y,'独立站API'], [T,'独立站API'],
  [Y,'独立站标准收银台'],            // 本期整个没了
  [T,'Element'],                     // 本期才出现
];

function makeWb(){
  const scene = [['时间类别','统计日期','来源','类型','当期值','分子/分母']];
  for(const [d,src] of SCENE)
    for(const [,raw] of METRICS)
      scene.push(['日报', d, src, raw, d===T?0.78:0.80, '8000/10000']);
  const mHead = ['时间类别','统计日期','用户ID','站点','来源','PO单数', ...METRICS.map(m=>m[1])];
  const merch = [mHead];
  for(const [d,uid,src,po] of MERCH)
    merch.push(['日报', d, uid, `https://${uid.toLowerCase()}.example.com`, src, po,
                ...METRICS.map(()=> d===T?0.78:0.80)]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scene), '场景维度');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(merch), '商户维度');
  return wb;
}

const ds = readReport(makeWb());
const r  = analyze(ds, {period:'日报', tDate:T, yDate:Y});

console.log('[1] buildMerged 把两批漏网的带出来了');
{
  const dfSite = ds.merchantSite['日报'];
  const m = buildMerged(dfSite, true, T, Y);
  check('merged 只有两期都在的', m.merged.length === 2, m.merged.length);
  check('onlyT = 今期首次有量', m.onlyT.map(o=>o['用户ID']).join() === 'U3',
        m.onlyT.map(o=>o['用户ID']));
  check('onlyY = 上期有、今期没了',
        m.onlyY.map(o=>o['用户ID']).sort().join() === 'U4,U5',
        m.onlyY.map(o=>o['用户ID']));
  // 老调用方只解构 merged/tDate/yDate，多返回两个键不该影响它们
  check('原有返回值一个没动', m.tDate === T && m.yDate === Y && Array.isArray(m.keys));
}

console.log('\n[2] ★ 掉量名单按 PO 倒序 —— 掉 3000 单和掉 3 单不是一回事');
{
  const c = r.churn;
  check('掉量两家', c.lost.length === 2, c.lost);
  check('★ 最大的那家排第一',
        c.lost[0]['用户ID'] === 'U4' && c.lost[0]['PO单数'] === 3000, c.lost[0]);
  check('小的那家排后面', c.lost[1]['用户ID'] === 'U5', c.lost[1]);
  check('掉量总单数 = 3003', c.lostPO === 3003, c.lostPO);
  check('新增一家', c.gained.length === 1 && c.gained[0]['用户ID'] === 'U3', c.gained);
  check('新增总单数 = 77', c.gainedPO === 77, c.gainedPO);
  check('带上来源，好知道是哪条线掉的', c.lost[0]['来源'] === '独立站API', c.lost[0]);
  check('hasSite 时带站点', c.lost[0]['站点'].includes('u4.'), c.lost[0]['站点']);
}

console.log('\n[3] ★ 整个来源消失也要说出来（A3）');
{
  const c = r.churn;
  check('★ 上期有、本期整个没了的来源列出来了',
        c.gone.join() === '独立站标准收银台', c.gone);
  check('本期新出现的来源也列出来', c.appeared.join() === 'Element', c.appeared);
  // stageAnalysis 仍然只出本期有数据的卡片 —— 消失的那个没数据可画
  check('消失的来源不会凭空出一张空卡片',
        !Object.keys(r.stages).includes('独立站标准收银台'), Object.keys(r.stages));
}

console.log('\n[4] 没有增减时不该无中生有');
{
  const c = sourceChurn(ds.scene['日报'], T, T);   // 同一期比同一期
  check('自己比自己：没有消失也没有新增',
        c.gone.length === 0 && c.appeared.length === 0, c);
  const e = buildChurn([], [], true);
  check('两边都空时给的是空名单和 0',
        e.gained.length === 0 && e.lost.length === 0 && e.lostPO === 0, e);
}

console.log('\n[5] hasSite=false（合计口径）时站点位占位不留空');
{
  const e = buildChurn([], [{来源:'独立站API', 用户ID:'U9', 商户名称:'X', PO单数:12}], false);
  check('站点写成 (用户ID合计)', e.lost[0]['站点'] === '(用户ID合计)', e.lost[0]);
  check('PO 取整', e.lost[0]['PO单数'] === 12, e.lost[0]);
}

console.log('\n[6] ★ 播报里说得出来（不然工作台知道、群里的人不知道）');
{
  const bc = broadcastTxt(r.alarmTotal, r.drillTotal, r.alarmSite, r.drillSite, r.tDate, r);
  const lines = bc.split('\n');
  check('★ 来源整个没了要报', /独立站标准收银台｜本期整个没有数据/.test(bc), bc);
  check('新来源也说一句', /Element｜本期首次出现/.test(bc), bc);
  // 来源级的话要排在各来源故事**前面** —— 它让下面每一条对比都缺了一块
  const iGone = lines.findIndex(l=>l.includes('本期整个没有数据'));
  const iSrc  = lines.findIndex(l=>l.startsWith('■ ') && !l.includes('商户进出'));
  check('★ 来源缺数据排在来源故事前面', iGone >= 0 && (iSrc < 0 || iGone < iSrc), {iGone, iSrc});

  check('★ 掉量那批进了播报', /■ 掉量商户｜2 家上期有量、本期整个没了/.test(bc), bc);
  check('说清上期一共掉了多少单', /上期共 3,003 单/.test(bc), bc);
  // U4 3000 单要点名；U5 只有 3 单，低于门槛，不点名 —— 否则真正要看的会被淹掉
  check('★ 大的那家点名', /u4\.example\.com .* 上期 3,000 单/.test(bc), bc);
  /* 只报「另有 N 家未列出」，**不解释门槛**（2026-09-09 用户：口径别进群消息）。
     ⚠️ 同时钉着「不许出现 50 单那句」—— 删掉的东西不写用例就会被下一次改动加回来。 */
  check('★ 小尾巴不点名', !bc.includes('u5.example.com'), bc);
  check('★ 未列出的报家数', /（另有 1 家未列出）/.test(bc), bc);
  check('★ 掉量段不解释 50 单门槛', !/不足 50 单|≥50 单的未列出|只计数/.test(bc), bc);
  /* ★ 播报拆成两条（B14）：这一条只讲「今天出了什么事」，
     「新入网」那批归第二条（待观察商户）—— 两件事、两个受众，
     塞一条里飞书上纯文本缩进打架、卡片版一大坨。 */
  check('★ 第一条里没有「新入网」那批', !/首次有量/.test(bc), bc);
  check('★ 第一条里没有待观察商户段', !/待观察商户/.test(bc), bc);
  const wc = watchTxt(r.tDate, r);
  check('★ 第二条有自己的标题', wc.startsWith('【待观察商户 2026-09-06】'), wc.slice(0,40));
  check('★ 新入网在第二条里', /本期首次有量 1 家/.test(wc), wc);
  check('第二条不写「这不是告警」那种解释句', !/不是告警/.test(wc), wc);
  /* 钉的是「基准值出现了」，不是那句定义 —— 定义 2026-09-09 从群消息里删了
     （用户：口径删干净）。没有基准值的话，每条「低 N pt」都没有分母。 */
  check('第二条末尾交代同行水平（不然「低 N pt」没有分母）',
        /同行水平：.*%/.test(wc), wc.slice(-200));
  check('播报里不出现工作台地址', !bc.includes('127.0.0.1'), bc);
}

console.log('\n[7] ★ 本期没走完时，「掉量」多半只是还没下单 —— 必须说出来');
{
  // 拿真实报表实测过：月报选到当月（9 月只过了 6 天）会报出 81 家 / 8.5 万单掉量，
  // 几乎全是"这个月还没下单"。比率不受影响（它是个比值），是 A2 把这件事暴露出来的。
  check('日报窗口就是当天', periodEnd('2026-09-06') === '2026-09-06', periodEnd('2026-09-06'));
  check('周报取括号里的第二个日期',
        periodEnd('2026 W37 (2026-09-04~2026-09-10)') === '2026-09-10',
        periodEnd('2026 W37 (2026-09-04~2026-09-10)'));
  check('月报取当月最后一天', periodEnd('2026-09') === '2026-09-30', periodEnd('2026-09'));
  check('闰年 2 月也要对', periodEnd('2028-02') === '2028-02-29', periodEnd('2028-02'));
  check('认不出来的写法给 null（宁可不提示也别瞎提示）',
        periodEnd('2026Q3') === null, periodEnd('2026Q3'));
  check('★ 窗口还没到最新日报 → 本期未走完',
        periodIncomplete('2026-09', '2026-09-06') === true);
  check('窗口已经过去 → 走完了', periodIncomplete('2026-08', '2026-09-06') === false);
  check('日报永远算走完了', periodIncomplete('2026-09-06', '2026-09-06') === false);
  check('没有日报可比时不提示', periodIncomplete('2026-09', null) === false);

  // 本用例的 fixture 是日报，不该出这句
  check('日报不出「还没走完」这句', r.churn.partial === false, r.churn.partial);
  const bc = broadcastTxt(r.alarmTotal, r.drillTotal, r.alarmSite, r.drillSite, r.tDate, r);
  check('播报里也不出现', !bc.includes('还没走完'), bc);
}

check.report();
