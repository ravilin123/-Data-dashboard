/* 水平信号（B3）：环比之外的第二类判据。
 *
 *     node tests/level.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 在此之前只有环比告警，于是一整类问题结构性地报不出来：
 *   · 今天是历史上最差的 10% 之一，但比昨天只差 1pt  → 环比阈值够不上
 *   · 连着五期都在 P25 以下，每期只掉一点点          → 一天都不会告警
 *
 * ★ 的几条是「不做这个就永远看不见」的那些，以及三个容易写错的地方：
 * 摩擦类方向、缺口不跨过、以及「没算」和「算了没事」不能长一样。
 *
 * [7c] 是另一种：它钉的是**故意不做的事**（不跨来源比较，用户 2026-09-09 定的）。
 * 那条挂了不代表有 bug，代表有人照计划文档把跨来源比较补上了 —— 先回去看那条的注释。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { levelSignals, runLength, seriesOf } = await import(MODULES + 'level.js');
const { CREEP_MIN_RUN, LEVEL_MIN_ORDERS } = await import(MODULES + 'config.js');
const { isTriggered } = await import(MODULES + 'funnel.js');

const GW='4. 网关通过率', CK='1.1 校验1通过率', F='3.2 3DS交易占比';
const D=[...Array(8)].map((_,i)=>`2026-09-${String(i+1).padStart(2,'0')}`);

function scene(vals){
  const rows=[];
  D.forEach((d,i)=>{
    for(const [src,byM] of Object.entries(vals))
      for(const [m,arr] of Object.entries(byM)){
        if(arr[i]==null) continue;
        rows.push({'统计日期':d, '来源':src, '类型':m, '当期值':arr[i]});
      }
  });
  return rows;
}
/** 历史 P10=0.80 / P25=0.85 / P50=0.90 / P75=0.95 / P90=0.98 的一份假基准线 */
const pool = (o={}) => ({n:20, p10:0.80, p25:0.85, p50:0.90, p75:0.95, p90:0.98, ...o});
const mkBl = (level={}, levelMixed={}) => ({baseline:{v:2, bySrc:{}, mixed:{}, level, levelMixed}, active:true});
const K = (s,m) => s+'|'+m;

console.log('[1] ★ 跌破 P10 —— 环比只差 1pt，一辈子不会告警');
{
  // 前七期都在 0.90 上下，最后一期 0.78（低于 P10=0.80），但环比只有 −1.3%
  const v=[0.90,0.91,0.90,0.89,0.90,0.91,0.79,0.78];
  const r=levelSignals(scene({'独立站API':{[GW]:v}}), {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:pool()})});
  check('★ 报出来了', r.level.length===1 && r.level[0]['指标']===GW, r.level);
  check('带了本期值和分位线', r.level[0]['本期值']===0.78 && r.level[0]['分位线']===0.80, r.level[0]);
  check('标了用的哪个池', r.level[0]._basis==='本来源', r.level[0]._basis);
  // 同一条数据走环比：−1.27%，层级兜底 −5% 够不上
  const dod=(0.78-0.79)/0.79;
  check('★ 而环比判据判不出来（这正是 B3 说的那件事）',
        !isTriggered(GW, dod, {active:false}).hit, {dod});
}

console.log('\n[2] ★ 温水煮青蛙 —— 每期只掉一点点，累计已经很难看');
{
  // 八期从 0.90 一路滑到 0.83，每期跌幅都够不上任何阈值；后四期都 ≤ P25(0.85)
  const v=[0.90,0.89,0.88,0.86,0.85,0.845,0.84,0.83];
  const r=levelSignals(scene({'独立站API':{[GW]:v}}), {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:pool()})});
  check('★ 报出来了', r.creep.length===1, r.creep);
  check('连续期数数对了（后 4 期 ≤ 0.85）', r.creep[0]['连续期数']===4, r.creep[0]);
  const worst=Math.min(...v.map((x,i)=>i?Math.abs((x-v[i-1])/v[i-1]):0));
  check('★ 每一期的环比都够不上 −5% 的兜底阈值',
        v.every((x,i)=>!i || !isTriggered(GW,(x-v[i-1])/v[i-1],{active:false}).hit), {最大单期跌幅:worst});
  check('没跌破 P10 所以不进水平异常', r.level.length===0, r.level);
}

console.log(`\n[3] 连续期数不够 ${CREEP_MIN_RUN} 期就不报`);
{
  const v=[0.90,0.90,0.90,0.90,0.90,0.90,0.84,0.83];   // 只有末 2 期低
  const r=levelSignals(scene({'独立站API':{[GW]:v}}), {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:pool()})});
  check(`2 期不报（门槛 ${CREEP_MIN_RUN}）`, r.creep.length===0, r.creep);
  check('runLength 数得对', runLength(v, 7, 0.85, false)===2, runLength(v,7,0.85,false));
  check('刚好够就报', runLength([0.9,0.84,0.84,0.83], 3, 0.85, false)===3);
}

console.log('\n[4] ★ 中间断一期就停 —— 跨过缺口数出来的「连续」是编的');
{
  const v=[0.84,0.84,null,0.84,0.84,0.84,0.84,0.83];   // 这个来源第 3 期没数据
  check('★ 从末期往前数到缺口就停', runLength(v, 7, 0.85, false)===5, runLength(v,7,0.85,false));
  /* ⚠️ 造数据时要让**那一期本身还在报表里**（另一个来源有行），
     否则 `统计日期` 里压根没有第 3 期，序列会缩成 7 期连续 —— 缺口就不存在了。
     这两件事是不一样的，别混：
       期次整个不在报表里     → 序列里没有这个位置，连续数照数
       期次在、这个来源没数据 → 序列里是 null，连续到此为止 */
  const r=levelSignals(scene({'独立站API':{[GW]:v},
                              'Element':{[GW]:[.5,.5,.5,.5,.5,.5,.5,.5]}}),
                       {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:pool()})});
  const mine=r.creep.filter(x=>x['来源']==='独立站API');
  check('★ 还是报（5 ≥ 3），但期数是 5 不是 8', mine.length===1 && mine[0]['连续期数']===5, mine[0]);

  // 对照：那一期整个不在报表里时，序列没有那个位置，7 期是连着的
  const noGap=levelSignals(scene({'独立站API':{[GW]:v}}),
                           {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:pool()})});
  check('对照：期次整个缺席时不算断开', noGap.creep[0]['连续期数']===7, noGap.creep[0]);
}

console.log('\n[5] ★ 摩擦类方向相反 —— 涨破 P90 才是坏');
{
  const hi=[0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.99];  // 末期冲到 0.99 > P90(0.98)
  const lo=[0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.01];  // 末期跌到 0.01 < P10(0.80)
  const bl=mkBl({[K('独立站API',F)]:pool()});
  const up=levelSignals(scene({'独立站API':{[F]:hi}}), {tDate:D[7], bl});
  const dn=levelSignals(scene({'独立站API':{[F]:lo}}), {tDate:D[7], bl});
  check('★ 涨破 P90 → 报', up.level.length===1 && up.level[0]._isF===true, up.level);
  check('★ 跌到很低 → 不报（占比低是好事）', dn.level.length===0, dn.level);
  // 温水那侧同理：连续 ≥ P75 才算
  const creepUp=[0.10,0.10,0.10,0.10,0.96,0.96,0.96,0.96];
  check('★ 摩擦类连续高于 P75 → 报',
        levelSignals(scene({'独立站API':{[F]:creepUp}}), {tDate:D[7], bl}).creep.length===1);
}

console.log('\n[6] ★「没算」和「算了没事」不能长一样');
{
  const v=[0.90,0.90,0.90,0.90,0.90,0.90,0.90,0.50];
  const s=scene({'独立站API':{[GW]:v}});
  const off=levelSignals(s, {tDate:D[7], bl:{baseline:null, active:false}});
  check('★ 没基准线时明说 noBaseline', off.noBaseline===true && off.level.length===0, off);
  const on=levelSignals(s, {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:pool()})});
  check('算了就不是 noBaseline', on.noBaseline===false, on);
  check('checked 说得出查了几个池', on.checked===1, on.checked);
  // 池子撑不住时不出信号，但 noBaseline 是 false（算了，只是这条没池子）
  const nopool=levelSignals(s, {tDate:D[7], bl:mkBl({}, {})});
  check('没有可用池子的指标：不编信号', nopool.level.length===0 && nopool.checked===0, nopool);
  check('但不谎称没基准线', nopool.noBaseline===false, nopool);
}

console.log('\n[7] ★ 水平**不做**混池回退 —— 混池是天天误报的来源');
{
  /* 环比混池勉强说得过去（各来源的变化幅度量纲相近），绝对水平不行。
     拿真实报表实测，混池那版第一条报的是：
       某来源 · 2. 业务校验通过率  本期 29.70%  低于混池 P10 31.88%（混池中位 98.94%）
     那个中位是**另外两个来源**的水平；这个来源那几期就在 30% 上下，
     在它自己的分布里 29.70% 完全正常（自己的中位 31.85%）——
     **这条报出来就是误报**，混池会让它天天上榜。 */
  const v=[0.90,0.90,0.90,0.90,0.90,0.90,0.90,0.50];
  const s=scene({'独立站API':{[GW]:v}});
  const mixedOnly=levelSignals(s, {tDate:D[7], bl:mkBl({}, {[GW]:pool()})});
  check('★ 只有混池 → 一条都不出', mixedOnly.level.length===0 && mixedOnly.creep.length===0,
        mixedOnly.level);
  check('★ 但要说出来是「没池子」不是「没事」', mixedOnly.noPool===1 && mixedOnly.checked===0,
        mixedOnly);
  const own=levelSignals(s, {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:pool()}, {[GW]:pool({p10:0.10})})});
  check('有本来源池就正常出', own.level.length===1 && own.level[0]._basis==='本来源', own.level[0]);
}

console.log('\n[7b] ★ 分布没有下沉空间的指标不出信号 —— 满分指标别天天上榜');
{
  /* 实测第一版报出来的：
       独立站API · 1.2 Paynow点击率  连续 8 期 ≤ P25(100.00%)  本期 100.00%  中位 100.00%
     它是满分。常年 100% 的指标 P25 = P50 = 1.0，「不高于 P25」恒成立。 */
  const flatPool={n:20, p10:1, p25:1, p50:1, p75:1, p90:1};
  const r=levelSignals(scene({'独立站API':{[GW]:[1,1,1,1,1,1,1,1]}}),
                       {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:flatPool})});
  check('★ 满分指标：一条都不报', r.level.length===0 && r.creep.length===0, r);
  check('★ 计入 flat，不计入 checked', r.flat===1 && r.checked===0, r);
  // 摩擦类的对称情形：P75 = P50 时同样没有区分度
  const flatF={n:20, p10:0, p25:0, p50:0, p75:0, p90:0};
  const rf=levelSignals(scene({'独立站API':{[F]:[0,0,0,0,0,0,0,0]}}),
                        {tDate:D[7], bl:mkBl({[K('独立站API',F)]:flatF})});
  check('★ 摩擦类恒为 0 也不报', rf.level.length===0 && rf.creep.length===0 && rf.flat===1, rf);
  // 有区分度的照常报
  const ok=levelSignals(scene({'独立站API':{[GW]:[.9,.9,.9,.9,.9,.9,.9,.5]}}),
                        {tDate:D[7], bl:mkBl({[K('独立站API',GW)]:pool()})});
  check('分布正常的不受影响', ok.level.length===1 && ok.flat===0, ok);
}

console.log('\n[7c] ★「常年趴在 60%」报不出来 —— 这是**故意**的（用户 2026-09-09：不要跨来源比较）');
{
  /* 计划里 B3 那段原话：「一个指标常年趴在 60%、每天纹丝不动，永远不告警 ——
     而它可能才是最大的那块肉。」现在做完 level.js 之后，这一类**仍然报不出来**：
     纹丝不动 = P25 === P50，被 hasRoom() 挡掉（[7b] 那条）。

     唯一能说「60% 太低」的办法是拿一把**外部尺子**，而这里能拿到的外部尺子只有
     「别的来源」。用户 2026-09-09 明确说了**不要跨来源比较**，所以这条到此为止。

     实测数据支持这个决定（见 2.10）：54 个「来源×指标」里 8 个的绝对水平差得没法比，
     最大差 67pt。拿别家的水平去卡这一家，报出来的每一条都是误报 ——
     这正是 [7] 那条混池误报的放大版。

     ⚠️ 这条用例钉的是「**没有信号**」这个结果。以后有人照着计划文档来「补上
     跨来源比较」，它会挂 —— 那是提醒，不是 bug。真要做，先改这条用例和计划文档。

     ⚠️ 商户级的「低于同来源中位数 10pt」（B14 待观察商户）是**另一回事**，
     照常在跑：那是**同一个来源内部**商户之间比，不跨来源。 */
  const flat60 = [0.60,0.60,0.60,0.60,0.60,0.60,0.60,0.60];
  const s = scene({
    '独立站API': {[GW]: flat60},                                   // 常年 60%，纹丝不动
    'Element':   {[GW]: [0.92,0.92,0.92,0.92,0.92,0.92,0.92,0.92]}, // 同期别家 92%
  });
  const flatPool = {n:20, p10:0.60, p25:0.60, p50:0.60, p75:0.60, p90:0.60};
  const r = levelSignals(s, {tDate:D[7],
    bl: mkBl({[K('独立站API',GW)]: flatPool, [K('Element',GW)]: {n:20, p10:.92,p25:.92,p50:.92,p75:.92,p90:.92}})});
  check('★ 常年 60% 不出信号（哪怕同期别家 92%）', r.level.length===0 && r.creep.length===0, r);
  check('★ 计入 flat 报上去，不是静默丢掉', r.flat===2 && r.checked===0, r);

  // 反面：它真的开始往下掉时，自己的分布就有区分度了，照常报得出来
  const dropping = levelSignals(scene({'独立站API':{[GW]:[.60,.60,.60,.60,.60,.60,.60,.45]}}),
    {tDate:D[7], bl: mkBl({[K('独立站API',GW)]: {n:20, p10:0.55, p25:0.58, p50:0.60, p75:0.62, p90:0.65}})});
  check('★ 一旦真的开始掉，照样报得出来（不是把这个来源整个关掉）',
        dropping.level.length===1, dropping.level);
}

console.log('\n[8] 排序、多来源、选到中间某一期');
{
  const bl=mkBl({[K('独立站API',GW)]:pool(), [K('Element',GW)]:pool(), [K('独立站API',CK)]:pool()});
  const s=scene({
    '独立站API':{[GW]:[.9,.9,.9,.9,.9,.9,.9,0.50], [CK]:[.9,.9,.9,.9,.9,.9,.9,0.79]},
    'Element':  {[GW]:[.9,.9,.9,.9,.9,.9,.9,0.70]},
  });
  const r=levelSignals(s, {tDate:D[7], bl});
  check('三条都报了', r.level.length===3, r.level.map(x=>[x['来源'],x['指标'],x['本期值']]));
  const gaps=r.level.map(x=>x._gap);
  check('★ 按缺口从大到小排', gaps.join()===[...gaps].sort((a,b)=>b-a).join(), gaps);

  // 选到中间某一期：连续期数要从那一期往前数，不是从最新一期
  const mid=levelSignals(scene({'独立站API':{[GW]:[.9,.84,.84,.84,.9,.9,.9,.9]}}),
                         {tDate:D[3], bl:mkBl({[K('独立站API',GW)]:pool()})});
  check('★ 连续期数从选中的那期往前数', mid.creep.length===1 && mid.creep[0]['连续期数']===3,
        mid.creep);
  check('选了个不存在的期次：空名单，不炸',
        levelSignals(s, {tDate:'2099-01-01', bl}).level.length===0);
}

console.log('\n[8b] ★ 排序和取舍看单量，不看 pt —— pt 跨指标不可比');
{
  /* 实测只按 pt 排的时候，头几条长这样：
       独立站API · 3.1 风控综合通过率  98.61%  历史 P10 98.67%  低 0.06pt
     技术上没错，但没人会去处理。折成「回到中位能多成多少单」才排得出轻重。 */
  const bl=mkBl({[K('独立站API',GW)]:pool(), [K('独立站API',CK)]:pool()});
  // GW 分母 10000、下游没有环节 → 回到中位(0.90) 从 0.79 补 0.11 ≈ 1100 单
  // CK 分母 100  → 同样跌 0.11，只值 11 单。pt 一样，单量差 100 倍
  const stages={'独立站API':{stages:[], counts:{[GW]:{n:7900,d:10000}, [CK]:{n:79,d:100}}}};
  const s=scene({'独立站API':{[GW]:[.9,.9,.9,.9,.9,.9,.9,0.79], [CK]:[.9,.9,.9,.9,.9,.9,.9,0.79]}});
  const r=levelSignals(s, {tDate:D[7], bl, stages});
  check('两条都报了', r.level.length===2, r.level.map(x=>[x['指标'],x['影响单量']]));
  check('★ 单量大的排前面（pt 完全一样）', r.level[0]['指标']===GW, r.level.map(x=>x['指标']));
  check('单量算得对（0.11 × 10000）', Math.abs(r.level[0]['影响单量']-1100)<1e-9, r.level[0]['影响单量']);
  check('pt 缺口确实一样', Math.abs(r.level[0]._gap-r.level[1]._gap)<1e-12,
        [r.level[0]._gap, r.level[1]._gap]);

  // 够不上门槛的直接不列，并计数
  const tiny={'独立站API':{stages:[], counts:{[GW]:{n:8,d:10}}}};
  const rt=levelSignals(scene({'独立站API':{[GW]:[.9,.9,.9,.9,.9,.9,.9,0.79]}}),
                        {tDate:D[7], bl, stages:tiny});
  check(`★ 只值 ${0.11*10} 单，不到 ${LEVEL_MIN_ORDERS} 单 → 不列`, rt.level.length===0, rt.level);
  check('但要计数（thin），不是静默丢掉', rt.thin===1, rt);
}

console.log('\n[8c] ★ 算不出单量的不埋 —— 摩擦类和缺分母的照样列出来');
{
  const bl=mkBl({[K('独立站API',F)]:pool(), [K('独立站API',GW)]:pool()});
  const stages={'独立站API':{stages:[], counts:{}}};   // 源表没给分子分母
  const rf=levelSignals(scene({'独立站API':{[F]:[.1,.1,.1,.1,.1,.1,.1,0.99]}}),
                        {tDate:D[7], bl, stages});
  check('★ 摩擦类：算不出单量，但报出来了', rf.level.length===1 && rf.level[0]['影响单量']===null,
        rf.level[0]);
  const rn=levelSignals(scene({'独立站API':{[GW]:[.9,.9,.9,.9,.9,.9,.9,0.50]}}),
                        {tDate:D[7], bl, stages});
  check('★ 缺分母：一样报出来', rn.level.length===1 && rn.level[0]['影响单量']===null, rn.level[0]);
  check('这些不计进 thin（不是「太小」，是「算不出」）', rn.thin===0, rn);
  // 混在一起时：有单量的排前面，算不出的在后面
  const mix=levelSignals(scene({'独立站API':{[F]:[.1,.1,.1,.1,.1,.1,.1,0.99],
                                              [GW]:[.9,.9,.9,.9,.9,.9,.9,0.50]}}),
                         {tDate:D[7], bl,
                          stages:{'独立站API':{stages:[], counts:{[GW]:{n:5000,d:10000}}}}});
  check('★ 有单量的排前面，算不出的殿后',
        mix.level[0]['指标']===GW && mix.level[1]['影响单量']===null,
        mix.level.map(x=>[x['指标'], x['影响单量']]));
}

console.log('\n[9] seriesOf 跟着期次自然序走');
{
  const rows=[
    {'统计日期':'2026 W37','来源':'独立站API','类型':GW,'当期值':0.60},
    {'统计日期':'2026 W9', '来源':'独立站API','类型':GW,'当期值':0.50},
    {'统计日期':'2026 W10','来源':'独立站API','类型':GW,'当期值':0.55},
  ];
  const dates=['2026 W9','2026 W10','2026 W37'];
  check('★ W9 → W10 → W37', seriesOf(rows,'独立站API',GW,dates).join()==='0.5,0.55,0.6',
        seriesOf(rows,'独立站API',GW,dates));
}

check.report();
