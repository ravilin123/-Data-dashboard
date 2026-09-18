/* 待观察商户名单（B14）。
 *
 *     node tests/watchlist.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * **这不是告警。** 告警回答「今天出了什么事」；这份名单回答「这几家要盯着」——
 * 它们大多常年低位、环比≈0，任何阈值都不会触发，所以不单独做一段就一个字都没有。
 *
 * 三个数字是拿真实报表定的（日报 2026-09-06 / 周报 W37）：
 *   WATCH_MIN_PO=10   门槛 50 会把「量少 + 成功率低」那批整批滤掉，而那正是
 *                     最该盯的组合（等着被风控关的就是这批）。低于 10 单比率没意义。
 *   WATCH_GAP=0.10    10pt → 日报 9 家 / 周报 20 家；15pt 只出 5 / 16 家，
 *                     会漏掉 unisilk.shop 那种 319 单差 11pt 的。
 *   WATCH_MIN_PEERS=3 够量的商户太少就退回全量算，**不跳过这个来源**。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { buildWatchlist, median, peerBaselines } = await import(MODULES + 'watchlist.js');
const { OVERALL_METRIC, SMALL_MERCHANT_PO, WATCH_GAP, WATCH_LOW_RUN, WATCH_MIN_PO } =
  await import(MODULES + 'config.js');

/** 一行 merged。只放这份名单用得到的那几列。 */
const row = (uid, src, po, t, y) => ({
  来源: src, 用户ID: uid, 商户名称: 'M'+uid, 站点: `https://${uid}.example.com`,
  'PO单数_今': po,
  [OVERALL_METRIC+'_今']: t,
  ...(y==null ? {} : {[OVERALL_METRIC+'_昨']: y}),
});

console.log('[1] median');
{
  check('奇数个取中间', median([0.1,0.5,0.9]) === 0.5);
  check('偶数个取中间两个的平均', median([0.2,0.4]) === 0.30000000000000004 || Math.abs(median([0.2,0.4])-0.3)<1e-9);
  check('空的给 null', median([]) === null);
  check('NaN 不参与', median([0.1, NaN, 0.9]) === 0.5, median([0.1,NaN,0.9]));
}

console.log('\n[2] ★ 基准不加权 —— 一家独大的来源不能拿它自己当基准');
{
  /* Element 那种形状：一家 1000 单占 92% 的量、成功率 30%，另外三家各 20 单、60/70/80%。
     PO 加权中位数 = 30%（就是大户自己），于是**谁都不会低于基准**，整条线没人看着。
     不加权中位数 = (60+70)/2 = 65%，大户比它低 35pt —— 这才是该报的。 */
  const rows=[{src:'E',po:1000,rate:0.30},{src:'E',po:20,rate:0.60},
              {src:'E',po:20,rate:0.70},{src:'E',po:20,rate:0.80}];
  const b=peerBaselines(rows);
  check('★ 基准不是那家独大的 30%', Math.abs(b.E.rate-0.65)<1e-9, b.E);
  check('参与算基准的家数报出来了', b.E.peers === 4, b.E);
  check('够量的家数达标就不标 weak', b.E.weak === false, b.E);
}

console.log('\n[3] 够量的商户太少：退回全量算，但**不跳过这个来源**');
{
  const rows=[{src:'E',po:1000,rate:0.30},{src:'E',po:2,rate:0.10},{src:'E',po:3,rate:0.20}];
  const b=peerBaselines(rows);
  check('★ 来源还在（没被跳过）', b.E != null, b);
  check('用全部商户算：中位数 20%', Math.abs(b.E.rate-0.20)<1e-9, b.E);
  check('★ 标了 weak，好在界面上留余地', b.E.weak === true, b.E);
}

console.log('\n[4] ★ 低于同行这一段：谁进、怎么排');
{
  const merged=[
    row('P1','A',100,0.50), row('P2','A',100,0.60), row('P3','A',100,0.70),
    // 11 单、15% —— 量少 + 成功率低，正是最该盯的那种
    row('L1','A', 11,0.15, 0.10),
    // 200 单、40%，上期 62% 正常 → 这期才掉的，不该标「连续」
    row('L2','A',200,0.40, 0.62),
    row('N1','A',100,0.55),
    // 只有 9 单 → 比率没意义，归「量太少」，不参与基准也不进名单
    row('T1','A',  9,0.15),
  ];
  const w=buildWatchlist(merged, {gained:[]}, true);
  const ids=w.low.map(x=>x.uid);
  /* ★ 低位商户**自己也算进基准**：够量的是 15/40/50/55/60/70 六家（T1 的 9 单不够），
     偶数取中间两个的平均 = (50+55)/2 = 52.5%。
     中位数能扛住一半以内的坏样本，所以不用特意把低位那批剔掉；剔掉反而会让基准
     虚高、把整批人都判成「低于同行」。 */
  check('基准 = 52.5%（低位商户也算进去，中位数扛得住）',
        Math.abs(w.baselines.A.rate-0.525)<1e-9, w.baselines.A.rate);
  check('★ 只有低于基准 10pt 的进来', ids.join()==='L1,L2', ids);
  check(`★ 不足 ${WATCH_MIN_PO} 单的不进（比率没意义）`, !ids.includes('T1'), ids);
  check('它进「量太少」那一格', w.tiny.count === 1 && w.tiny.po === 9, w.tiny);
  check('差得不够的不进', !ids.includes('N1'), ids);
  check('★ 按缺口从大到小排', w.low[0].uid === 'L1', ids);

  const l1=w.low.find(x=>x.uid==='L1'), l2=w.low.find(x=>x.uid==='L2');
  /* 不传 hist 时退回两期口径（本期 + 上期），连续期数最多给到 2 —— 功能不炸。
     真正的「连续 N 期」由下面 [4b] 用全期次数据验。 */
  check('★ 上期也低 → 连续 2 期', l1.连续期数 === 2, l1);
  check('★ 这期才掉的只算 1 期（那是告警该管的）', l2.连续期数 === 1, l2);
  check('两期口径下都够不上「长期低位」', !l1.长期低位 && !l2.长期低位, [l1.长期低位, l2.长期低位]);
  check(`不足 ${SMALL_MERCHANT_PO} 单标「量少」`, l1.单量少 === true && l2.单量少 === false,
        [l1.单量少, l2.单量少]);
  check('可多成 = 单量 × 缺口',
        l1.可多成 === Math.round(11*(w.baselines.A.rate-0.15)), l1.可多成);
}

console.log(`\n[4b] ★ 连续 ${WATCH_LOW_RUN} 个有效期低于同行 → 长期低位（用户 2026-09-08 定的）`);
{
  /* 「常年不动的那批」两期看不出来 —— 两期低可能只是巧合，连着三期就是长期低位。
     dfSite 是**未合并**的原始行（每期一行），buildWatchlist 靠它逐期算基准。 */
  const D=['2026-09-01','2026-09-02','2026-09-03','2026-09-04'];
  const raw=(d,uid,po,rate)=>({'统计日期':d,'来源':'A','用户ID':uid,'站点':`https://${uid}.example.com`,
                               'PO单数':po,'业务单支付成功率':rate});
  /* ⚠️ 正常商户要占**多数**：中位数只扛得住一半以内的坏样本。
     第一版放了 3 家正常 + 4 家低位，中位数被拉到 0.20，于是谁都不低于基准、
     w.low 是空的 —— 造数据时踩到的正是这份名单自己的设计前提。 */
  const OK=[['P1',0.60],['P2',0.61],['P3',0.62],['P4',0.63],['P5',0.64],['P6',0.65]];
  const dfSite=[];
  for(const d of D){
    for(const [uid,v] of OK) dfSite.push(raw(d,uid,100,v));
    dfSite.push(raw(d,'LONG',100,0.20));                    // 四期都低 → 连续 4
    dfSite.push(raw(d,'NEW', 100, d===D[3]?0.20:0.63));     // 只有末期低 → 连续 1
    dfSite.push(raw(d,'GAP', 100, d===D[1]?0.63:0.20));     // 中间一期不低 → 断开，连续 2
    dfSite.push(raw(d,'THIN',d===D[1]?3:100, 0.20));        // 中间一期单量不足 → 跳过，4 期里数到 3
  }
  const merged=[...OK.map(([uid,v])=>row(uid,'A',100,v)),
                row('LONG','A',100,0.20,0.20), row('NEW','A',100,0.20,0.63),
                row('GAP','A',100,0.20,0.20), row('THIN','A',100,0.20,0.20)];
  const w=buildWatchlist(merged, {gained:[]}, true, null, {dfSite, tDate:D[3]});
  const by={}; for(const x of w.low) by[x.uid]=x;
  check('四家低位都进了名单', Object.keys(by).sort().join()==='GAP,LONG,NEW,THIN',
        w.low.map(x=>x.uid));

  check('★ 四期都低 → 连续 4 期', by.LONG && by.LONG.连续期数===4, by.LONG && by.LONG.连续期数);
  check('★ 只有末期低 → 连续 1 期', by.NEW && by.NEW.连续期数===1, by.NEW && by.NEW.连续期数);
  check('★ 中间一期不低 → 断开，只算 2 期', by.GAP && by.GAP.连续期数===2, by.GAP && by.GAP.连续期数);
  /* ★ 单量不足那期**跳过**：不打断（GAP 那种「够量但不低」才打断），
     但也**不计数** —— 数的是「连续 N 个有效期」，跳过的不是有效期。
     所以 4 期里跳掉 1 期，数出来是 3 而不是 4。 */
  check(`★ 中间一期单量不足 ${WATCH_MIN_PO} → 跳过不打断，但也不计数（4 期里数到 3）`,
        by.THIN && by.THIN.连续期数===3, by.THIN && by.THIN.连续期数);
  check('★ 跳过 ≠ 打断：THIN 数到 3 仍标长期低位，GAP 被打断只有 2',
        by.THIN.长期低位===true && by.GAP.长期低位===false,
        {THIN:by.THIN.连续期数, GAP:by.GAP.连续期数});
  check(`★ ≥${WATCH_LOW_RUN} 期才标「长期低位」`,
        by.LONG.长期低位===true && by.THIN.长期低位===true
        && by.NEW.长期低位===false && by.GAP.长期低位===false,
        Object.fromEntries(Object.entries(by).map(([k,v])=>[k,v.长期低位])));
  check('★ 长期低位的排在前面（这四家缺口一样）',
        w.low.slice(0,2).every(x=>x.长期低位), w.low.map(x=>[x.uid,x.连续期数]));

  /* 基准要**逐期各算一次**：拿本期的尺子去量历史是另一种口径混用。
     让首期同行整体崩到 15~20%，那一期 LONG 的 20% 就不算「低于同行」了 → 连续降到 3。 */
  const drift=dfSite.map(r=>r['统计日期']===D[0] && OK.some(([u])=>u===r['用户ID'])
    ? {...r, '业务单支付成功率': r['业务单支付成功率']-0.45}
    : r);
  const w2=buildWatchlist(merged, {gained:[]}, true, null, {dfSite:drift, tDate:D[3]});
  const long2=w2.low.find(x=>x.uid==='LONG');
  check('★ 首期同行整体低时，那一期不算「低于同行」→ 连续降到 3',
        long2.连续期数===3, long2.连续期数);

  // 不传 hist 照样能跑（渲染层没接上时不能炸）
  const w3=buildWatchlist(merged, {gained:[]}, true);
  check('不传 hist 不炸，退回两期口径', w3.low.every(x=>x.连续期数<=2),
        w3.low.map(x=>x.连续期数));
}

console.log('\n[5] ★ 「最值钱的一家」不是缺口最大的那家');
{
  /* 排序按缺口（风险），但缺口小、量大的那家钱最多 —— 不单独点一句会被忽略。
     实测周报：ifonetool.com 缺口只有 13pt 排在末尾，7031 单，做到中位数多成 918 单。 */
  const merged=[
    row('P1','A',100,0.50), row('P2','A',100,0.60), row('P3','A',100,0.70),
    row('SMALL','A',  20,0.10),   // 基准 50% → 缺口 40pt，可多成 8 单
    row('BIG',  'A',5000,0.35),   // 缺口 15pt，可多成 750 单
  ];
  const w=buildWatchlist(merged, {gained:[]}, true);
  check('基准 = 50%', Math.abs(w.baselines.A.rate-0.50)<1e-9, w.baselines.A.rate);
  check('缺口最大的排第一', w.low[0].uid === 'SMALL', w.low.map(x=>x.uid));
  check('★ best 是量最大的那家，不是排第一的', w.best.uid === 'BIG', w.best && w.best.uid);
  check('best 的可多成 = 750', w.best.可多成 === 750, w.best.可多成);
  check('排第一那家的可多成只有 8', w.low[0].可多成 === 8, w.low[0].可多成);
}

console.log('\n[6] 新入网：直接用 A2 的 churn.gained，带成功率');
{
  const churn={gained:[
    {来源:'A', 用户ID:'F1', 商户名称:'M1', 站点:'https://f1.example.com', PO单数:5,  成功率:0.12},
    {来源:'A', 用户ID:'F2', 商户名称:'M2', 站点:'https://f2.example.com', PO单数:80, 成功率:null},
  ]};
  const w=buildWatchlist([], churn, true);
  check('按单量倒序', w.fresh.map(f=>f['用户ID']).join()==='F2,F1', w.fresh.map(f=>f['用户ID']));
  check(`不足 ${SMALL_MERCHANT_PO} 单标「量少」`,
        w.fresh[1].单量少 === true && w.fresh[0].单量少 === false, w.fresh.map(f=>f.单量少));
  check('成功率带过来了', w.fresh[1]['成功率'] === 0.12, w.fresh[1]);
  check('★ 算不出成功率时留 null，不写成 0', w.fresh[0]['成功率'] === null, w.fresh[0]);
}

console.log('\n[7] 空输入不炸');
{
  const w=buildWatchlist([], null, true);
  check('三段都是空的', w.low.length===0 && w.fresh.length===0 && w.tiny.count===0, w);
  check('没有 best', w.best === null, w.best);
  check('没有基准', Object.keys(w.baselines).length===0, w.baselines);
  check('GAP 是 10pt', WATCH_GAP === 0.10, WATCH_GAP);
}

console.log('\n[8] ★ 两条消息，不混在一起');
{
  const { broadcastTxt, watchTxt, watchMd } = await import(MODULES + 'broadcast.js');
  const ctx = {
    stages:{}, srcStory:[], mergedSite:[], dfScene:[], drillSite:[], tDate:'2026-09-06', yDate:'2026-09-05',
    churn:{lost:[], gained:[], gone:[], appeared:[], lostPO:0, gainedPO:0},
    watch: buildWatchlist(
      [row('P1','A',100,0.50), row('P2','A',100,0.60), row('P3','A',100,0.70),
       row('L1','A',20,0.10, 0.10)],
      {gained:[{来源:'A',用户ID:'F1',商户名称:'M1',站点:'https://f1.example.com',PO单数:30,成功率:0.12}]},
      true),
  };
  const main = broadcastTxt([], [], [], [], '2026-09-06', ctx);
  const wc   = watchTxt('2026-09-06', ctx);
  check('★ 第一条不含待观察商户', !/待观察商户|低于同行|首次有量/.test(main), main);
  check('★ 第二条自带标题（能单独发）', wc.startsWith('【待观察商户 2026-09-06】'), wc.slice(0,40));
  check('第二条列出了低于同行的那家', /L1/.test(wc) || /l1\.example/.test(wc), wc);
  check('第二条列出了新入网那家', /本期首次有量 1 家/.test(wc), wc);
  check('markdown 版也是独立一份', watchMd('2026-09-06', ctx).startsWith('# 待观察商户'),
        watchMd('2026-09-06', ctx).slice(0,30));

  // 没人要盯时返回空串 —— 每天一条「今天没人要盯」是噪声，调用方据此不发
  const empty = {...ctx, watch: buildWatchlist([], {gained:[]}, true)};
  check('★ 名单空时给空串（调用方据此不发第二条）',
        watchTxt('2026-09-06', empty) === '' && watchMd('2026-09-06', empty) === '');
}

console.log('\n[9] 新入网：不足门槛的不逐家点名，但要报家数');
{
  const gained=[
    {来源:'A',用户ID:'BIG', 商户名称:'M',站点:'https://big.example.com', PO单数:30, 成功率:0.12},
    {来源:'A',用户ID:'T1',  商户名称:'M',站点:'https://t1.example.com',  PO单数:3,  成功率:0},
    {来源:'A',用户ID:'T2',  商户名称:'M',站点:'https://t2.example.com',  PO单数:1,  成功率:1},
  ];
  const w=buildWatchlist([], {gained}, true);
  check('总数还是 3 家', w.fresh.length === 3, w.fresh.length);
  check(`★ 只有 ≥${WATCH_MIN_PO} 单的逐家点名`,
        w.freshNamed.map(f=>f['用户ID']).join()==='BIG', w.freshNamed.map(f=>f['用户ID']));
  check('★ 其余不丢，用一行报家数和总量',
        w.freshTiny.count === 2 && w.freshTiny.po === 4, w.freshTiny);
}

console.log('\n[10] ★ 接出单监控的名单（B15）');
{
  /* 出单监控每天已经点过名了：谁刚跨过 $100、谁刚审核通过、谁在滞留。
     ⚠ **只按用户ID匹配，不按站点** —— 站点归一化在 Python（normalize_site）和
       JS（shortSite）各有一份实现，一旦漂移就是静默匹配不上。 */
  const om={date:'2026-09-06', merchants:[
    {用户ID:'L1',  商户名称:'M', 站点:'https://WWW.L1.example.com/', 分类:'🐢 小额滞留'},
    {用户ID:'F1',  商户名称:'M', 站点:'https://f1.example.com',      分类:'✅ 新出单'},
    {用户ID:'P9',  商户名称:'待上量', 站点:'https://p9.example.com', 分类:'🆕 新审核通过-待出单',
     所属BD:'BD甲', 通道通过日期:'2026-09-05'},
    {用户ID:'X1',  商户名称:'M', 站点:'https://x1.example.com',      分类:'🟠 30-60天未出单'},
  ]};
  const merged=[row('P1','A',100,0.50), row('P2','A',100,0.60), row('P3','A',100,0.70),
                row('L1','A', 20,0.10, 0.10)];
  const churn={gained:[{来源:'A',用户ID:'F1',商户名称:'M',站点:'https://f1.example.com',
                        PO单数:30, 成功率:0.12}]};
  const w=buildWatchlist(merged, churn, true, om);

  check('★ 低于同行那家带上了出单监控的标签',
        (w.low.find(x=>x.uid==='L1').出单监控||[]).join()==='出单滞留',
        w.low.find(x=>x.uid==='L1').出单监控);
  // ★ 站点写法完全不同（大写 WWW.、带尾斜杠）也照样命中 —— 因为压根不比站点
  check('★ 站点写法不同不影响匹配（只认用户ID）',
        (w.low[0].出单监控||[]).length === 1, w.low[0]);
  check('新入网那家也带上了标签',
        (w.fresh[0].出单监控||[]).join()==='刚出单', w.fresh[0].出单监控);
  check('用不上的分类不打标签（30-60天未出单）',
        !JSON.stringify(w.low.concat(w.fresh)).includes('30-60'), w.low.concat(w.fresh));

  /* 「刚审核通过-待出单」在转化率报表里往往一行都没有（还没交易），
     所以既不在 low 也不在 fresh —— 单独一段，不然这条信息就丢了。 */
  check('★ 刚审核通过的单独列出来', w.omPending.length===1 && w.omPending[0]['用户ID']==='P9',
        w.omPending);
  check('带上 BD 和通道通过日期（好去找人）',
        w.omPending[0]['所属BD']==='BD甲' && w.omPending[0]['通道通过日期']==='2026-09-05',
        w.omPending[0]);
  check('记下名单是哪天的', w.omDate==='2026-09-06', w.omDate);

  // 已经在上面两段里的不重复列
  const om2={...om, merchants:[...om.merchants,
    {用户ID:'F1', 商户名称:'M', 站点:'x', 分类:'🆕 新审核通过-待出单'}]};
  const w2=buildWatchlist(merged, churn, true, om2);
  check('★ 已经在名单里的不重复列进「刚审核通过」',
        w2.omPending.map(x=>x['用户ID']).join()==='P9', w2.omPending.map(x=>x['用户ID']));

  // 没有出单监控数据时一切照旧
  const w3=buildWatchlist(merged, churn, true, null);
  check('没接出单监控时不炸、也不留空数组以外的东西',
        w3.omPending.length===0 && w3.omDate==='' && !w3.low[0].出单监控, w3.low[0]);
}

console.log('\n[11] 出单监控的标签进播报');
{
  const { watchTxt } = await import(MODULES + 'broadcast.js');
  const om={date:'2026-09-06', merchants:[
    {用户ID:'L1', 商户名称:'M', 站点:'https://l1.example.com', 分类:'🐢 小额滞留'},
    {用户ID:'P9', 商户名称:'待上量', 站点:'https://p9.example.com', 分类:'🆕 新审核通过-待出单',
     所属BD:'BD甲', 通道通过日期:'2026-09-05'},
  ]};
  const ctx={watch: buildWatchlist(
    [row('P1','A',100,0.50), row('P2','A',100,0.60), row('P3','A',100,0.70), row('L1','A',20,0.10)],
    {gained:[]}, true, om)};
  const wc=watchTxt('2026-09-06', ctx);
  check('低于同行那行带出「出单滞留」', /出单滞留/.test(wc), wc);
  check('★ 刚审核通过单独一段', /刚审核通过、还没出单：1 家/.test(wc), wc);
  check('带上 BD，好知道去找谁', /BD BD甲/.test(wc), wc);
  check('说明名单是哪天的', /出单监控 2026-09-06 的名单/.test(wc), wc);
}

check.report();
