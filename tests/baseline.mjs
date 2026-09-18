/* 基准线分池 + 三级回退（B4）。
 *
 *     node tests/baseline.mjs      # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 三件事：
 *   1. 分池是为了准 —— Element 的噪声不该抬高独立站API 的阈值（B4 的原话）
 *   2. 回退是为了有 —— 实测周报/月报按来源分池 0/54 个池够格，没有混池这一级
 *      等于分池之后大家一起退回层级兜底，比不分还差
 *   3. ★ 老形状要认 —— v2 之前存的是 {指标: 阈值}，用户的 localStorage 里就躺着。
 *      读不出来的话是**静默**退回层级兜底，界面还说着「基准线已启用」。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { buildBaseline, collectSamples, emptySamples, percentile, poolKey, spreadPick, summarizeDod, summarizeLevel }
  = await import(MODULES + 'baseline.js');
const { isTriggered, pickLevelPool, pickPool, thresholdFor } = await import(MODULES + 'funnel.js');
const { LEVEL_MIN_N, MIX_MAX_GAP, MIX_MIN_SAMPLES, POOL_MIN_MIXED, POOL_MIN_SRC } = await import(MODULES + 'config.js');

const M = {ck:'1.1 校验1通过率', gw:'4. 网关通过率', f:'3.2 3DS交易占比'};
const RAW = {[M.ck]:'校验1通过率', [M.gw]:'网关通过率', [M.f]:'3DS交易占比'};

/** 造场景维度行。vals[来源][指标] = 各期的值。 */
function scene(dates, vals){
  const rows=[];
  dates.forEach((d,i)=>{
    for(const [src, byMetric] of Object.entries(vals))
      for(const [metric, arr] of Object.entries(byMetric)){
        const v=arr[i];
        if(v==null) continue;
        rows.push({'统计日期':d, '来源':src, '类型':metric, '当期值':v});
      }
  });
  return rows;
}
const seq = (base, step, n) => [...Array(n)].map((_,i)=>base+step*i);

console.log('[1] 攒样本：两类样本各进两个池');
{
  const dates=['2026-09-01','2026-09-02','2026-09-03'];
  const s=collectSamples(scene(dates, {
    '独立站API':      {[M.gw]:[0.80,0.82,0.81]},
    '独立站标准收银台':{[M.gw]:[0.60,0.61,0.59]},
  }), emptySamples());
  check('水平样本按来源分开', s.level[poolKey('独立站API',M.gw)].join()==='0.8,0.82,0.81',
        s.level[poolKey('独立站API',M.gw)]);
  check('水平混池是两家之和', s.levelMixed[M.gw].length===6, s.levelMixed[M.gw]);
  check('环比样本 = 期数 − 1', s.dod[poolKey('独立站API',M.gw)].length===2,
        s.dod[poolKey('独立站API',M.gw)]);
  check('环比混池同理', s.dodMixed[M.gw].length===4, s.dodMixed[M.gw]);
  check('累加进同一个 into', collectSamples(scene(dates,{'Element':{[M.gw]:[0.5,0.5,0.5]}}), s)
        .levelMixed[M.gw].length===9, s.levelMixed[M.gw].length);
}

console.log('\n[2] ★ 周报期次要自然序 —— 字典序会把相邻两期配错对');
{
  // W9 → W10 → W37。字典序排出来是 W10 → W37 → W9，相邻对全错
  const s=collectSamples(scene(['2026 W9','2026 W10','2026 W37'],
                               {'独立站API':{[M.gw]:[0.50, 0.55, 0.60]}}), emptySamples());
  const d=s.dod[poolKey('独立站API',M.gw)];
  const want=[(0.55-0.50)/0.50, (0.60-0.55)/0.55];
  check('★ 两个环比样本都对得上', d.length===2 && d.every((v,i)=>Math.abs(v-want[i])<1e-12),
        {got:d, want});
}

console.log('\n[3] ★ 分池是为了准 —— 小来源的噪声不该抬高大来源的阈值');
{
  const n=12;
  // 独立站API 很稳（每期 +0.1%），Element 上蹿下跳（±15% 来回）
  const steady=[...Array(n)].map((_,i)=>0.80*(1+0.001*i));
  const wild=[...Array(n)].map((_,i)=>0.50*(1+(i%2?0.15:-0.15)));
  const s=collectSamples(scene([...Array(n)].map((_,i)=>`2026-09-${String(i+1).padStart(2,'0')}`),
    {'独立站API':{[M.gw]:steady}, 'Element':{[M.gw]:wild}}), emptySamples());
  const {bl}=buildBaseline(s, 3, 0.01);

  const own=bl.bySrc[poolKey('独立站API',M.gw)], mixed=bl.mixed[M.gw];
  check('稳的那家有自己的池', !!own, Object.keys(bl.bySrc));
  check('混池也在', !!mixed);
  check('★ 混池的 σ 被 Element 抬高了', mixed.sigma > own.sigma*3,
        {本来源:own.sigma, 混池:mixed.sigma});
  check('★ 于是混池阈值更松（更负）', mixed.drop < own.drop,
        {本来源:own.drop, 混池:mixed.drop});

  // 独立站API 掉 2%：拿自己的池判 = 触发；拿混池判 = 被 Element 的噪声吃掉
  const blOn={baseline:bl, active:true};
  const hitOwn=isTriggered(M.gw, -0.02, blOn, '独立站API');
  const hitMix=isTriggered(M.gw, -0.02, blOn, '不存在的来源');
  check('★ 用本来源池：报出来了', hitOwn.hit && hitOwn.basis==='基准线·本来源', hitOwn);
  check('★ 用混池：被吃掉了（这正是 B4 说的那件事）', !hitMix.hit && hitMix.basis==='基准线·混池', hitMix);
}

console.log('\n[4] 三级回退，顺序不能换');
{
  const bl={v:2,
    bySrc:{[poolKey('独立站API',M.gw)]:{drop:-0.02, rise:0.02}},
    mixed:{[M.gw]:{drop:-0.09, rise:0.09}},
    level:{}, levelMixed:{}};
  check('1 本来源', thresholdFor(M.gw, {baseline:bl,active:true}, '独立站API').basis==='基准线·本来源');
  check('2 混池（这个来源没有自己的池）',
        thresholdFor(M.gw, {baseline:bl,active:true}, 'Element').basis==='基准线·混池');
  check('3 层级兜底（这个指标混池里也没有）',
        thresholdFor(M.ck, {baseline:bl,active:true}, 'Element').basis==='层级兜底');
  check('没启用就一路兜底', thresholdFor(M.gw, {baseline:bl,active:false}, '独立站API').basis==='层级兜底');
  check('不传 source 时跳过第 1 级，不报错',
        thresholdFor(M.gw, {baseline:bl,active:true}).basis==='基准线·混池');
  check('完全不传 bl 也不炸', thresholdFor(M.gw).basis==='层级兜底');
}

console.log('\n[5] ★ 老形状（v2 之前）要认 —— 读不出来是静默退回兜底');
{
  const legacy={'4. 网关通过率':{n:20, median:-0.001, sigma:0.01, drop:-0.031, rise:0.031}};
  const t=thresholdFor(M.gw, {baseline:legacy, active:true}, '独立站API');
  check('★ 认出来了，当混池用', t.basis==='基准线·混池' && t.drop===-0.031, t);
  check('★ 没有静默掉成层级兜底', t.basis!=='层级兜底', t);
  check('老形状里没有的指标照样兜底',
        thresholdFor(M.ck, {baseline:legacy, active:true}, '独立站API').basis==='层级兜底');
  check('老形状没有水平池，pickLevelPool 给 null', pickLevelPool(legacy, M.gw, '独立站API')===null);
}

console.log('\n[6] 门槛：撑不住的池子不产出');
{
  const mk=n=>{
    const s=emptySamples();
    s.dod[poolKey('独立站API',M.gw)]=seq(-0.01,0.001,n);
    s.dodMixed[M.gw]=seq(-0.01,0.001,n);
    s.level[poolKey('独立站API',M.gw)]=seq(0.80,0.001,n);
    s.levelMixed[M.gw]=seq(0.80,0.001,n);
    return buildBaseline(s,3,0.01).bl;
  };
  const below=mk(POOL_MIN_SRC-1), at=mk(POOL_MIN_SRC);
  check(`本来源池差一个（${POOL_MIN_SRC-1}）不产出`, !below.bySrc[poolKey('独立站API',M.gw)]);
  check(`本来源池刚够（${POOL_MIN_SRC}）产出`, !!at.bySrc[poolKey('独立站API',M.gw)]);
  check(`混池门槛是 ${POOL_MIN_MIXED}`,
        !mk(POOL_MIN_MIXED-1).mixed[M.gw] && !!mk(POOL_MIN_MIXED).mixed[M.gw]);
  const lk=poolKey('独立站API',M.gw);
  check(`★ 水平池门槛更高（${LEVEL_MIN_N}）—— 分位数比中位数更吃样本`,
        LEVEL_MIN_N>POOL_MIN_MIXED && !mk(LEVEL_MIN_N-1).level[lk] && !!mk(LEVEL_MIN_N).level[lk]);
  check('★ 基准线里没有 levelMixed —— 绝对水平不做混池，产出了迟早有人拿去判',
        mk(30).levelMixed===undefined, Object.keys(mk(30)));
}

console.log('\n[6b] ★ 水平差太远的来源不许混池 —— 混池阈值对它就是错的');
{
  /* 用户提的（2026-09-08）：某个来源的数据绝对不要混池到其他来源去。
     实测这不是单个来源的事，54 个「来源×指标」里 8 个差 10pt 以上：
       67.1pt  某来源 · 2. 业务校验通过率      自己 31.85%  混池 98.94%
       41.3pt  某来源 · 1.2 Paynow点击率     自己 58.70%  混池 100.00%
       32.3pt  某来源 · 4.1 非3DS网关通过率   自己 38.91%  混池 71.22%
     所以做成一般规则，不硬编码来源名。 */
  const n=12;
  const dates=[...Array(n)].map((_,i)=>`2026-09-${String(i+1).padStart(2,'0')}`);
  // 两家在 99% 上下，一家常年 31% —— 那一家和混池差 60pt 以上
  const s=collectSamples(scene(dates, {
    '独立站API':      {[M.gw]:seq(0.99,0.0001,n)},
    '独立站标准收银台':{[M.gw]:seq(0.99,0.0001,n)},
    'Element':        {[M.gw]:seq(0.31,0.0001,n)},
  }), emptySamples());
  const {bl}=buildBaseline(s, 3, 0.01);
  const far=poolKey('Element',M.gw), near=poolKey('独立站API',M.gw);
  check('★ 差太远的那个标了 noMix', !!bl.noMix[far], Object.keys(bl.noMix));
  check('★ 说得出为什么', bl.noMix[far].why.includes('差太远') && bl.noMix[far].gap>MIX_MAX_GAP,
        bl.noMix[far]);
  check('水平接近的不标', !bl.noMix[near], bl.noMix[near]);

  /* 这里三家样本都够（12 个 ≥ POOL_MIN_SRC），所以都走第 1 级。
     要验回退，把本来源池拿掉 —— 模拟「样本不够、要退混池」那一刻。 */
  const stripped={...bl, bySrc:{}};
  const blOn={baseline:stripped, active:true};
  check('★ 差太远的：跳过混池，直接层级兜底',
        thresholdFor(M.gw, blOn, 'Element').basis==='层级兜底', thresholdFor(M.gw, blOn, 'Element'));
  check('水平接近的：照常退混池',
        thresholdFor(M.gw, blOn, '独立站API').basis==='基准线·混池', thresholdFor(M.gw, blOn, '独立站API'));

  // 判不了可比性（水平样本太少）时也不许混 —— 刚上线的来源最不该用别人的阈值
  const s2=collectSamples(scene(dates, {'独立站API':{[M.gw]:seq(0.99,0.0001,n)}}), emptySamples());
  collectSamples(scene(dates.slice(0,MIX_MIN_SAMPLES-1), {'Element':{[M.gw]:[0.99,0.99]}}), s2);
  const bl2=buildBaseline(s2,3,0.01).bl;
  check(`★ 水平样本 <${MIX_MIN_SAMPLES} 也不许混（判不了就别假设可比）`,
        bl2.noMix[far] && bl2.noMix[far].why.includes('样本不足'), bl2.noMix[far]);

  check('stats 里报出来了哪些来源不许混池',
        buildBaseline(s,3,0.01).stats.find(x=>x.m===M.gw).noMix.join()==='Element',
        buildBaseline(s,3,0.01).stats.find(x=>x.m===M.gw).noMix);
  // 不传 source 时判不了，保持原样（这是调用方的降级路径，不是主路径）
  check('不传 source 时仍走混池，不炸', thresholdFor(M.gw, blOn).basis==='基准线·混池');
}

console.log('\n[6c] ★ 跨文件去重 —— 存档是滚动窗口，重叠会让 n 说谎');
{
  /* 每份报表带最近 8 期，连着两天的存档重叠 7 期。不去重的话同一个观测算好几遍：
     分位数的形状不变（重复值不改变分布），但 **n 会说谎** —— 而 n 正是
     POOL_MIN_SRC / LEVEL_MIN_N 这些门槛在看的东西。
     实测把同一份报表喂两遍：水平样本 8→16，池子从 0 个变成 54 个，
     原本「样本不足、不该出信号」的池子凭空达标。 */
  const dates=[...Array(8)].map((_,i)=>`2026-09-0${i+1}`);
  const sc=scene(dates, {'独立站API':{[M.gw]:seq(0.80,0.001,8)}});
  const key=poolKey('独立站API',M.gw);

  const one=collectSamples(sc, emptySamples());
  const n1=one.level[key].length, d1=one.dod[key].length;
  check('一份：8 个水平样本、7 个环比样本', n1===8 && d1===7, {n1, d1});

  const twice=emptySamples();
  collectSamples(sc, twice); collectSamples(sc, twice);
  check('★ 喂两遍，样本数不变（去重了）',
        twice.level[key].length===8 && twice.dod[key].length===7,
        {level:twice.level[key].length, dod:twice.dod[key].length});
  check('★ 混池也去重', twice.levelMixed[M.gw].length===8, twice.levelMixed[M.gw].length);

  // 真实重叠：两份存档共享中间几期，各自有独占的几期
  const a=scene(dates.slice(0,6), {'独立站API':{[M.gw]:seq(0.80,0.001,6)}});
  const b=scene(dates.slice(3),   {'独立站API':{[M.gw]:seq(0.803,0.001,5)}});
  const both=emptySamples(); collectSamples(a, both); collectSamples(b, both);
  check('★ 重叠的存档：并集是 8 期不是 11 期', both.level[key].length===8, both.level[key].length);

  // 期次不同就不算重复
  const other=scene(['2026-10-01'], {'独立站API':{[M.gw]:[0.9]}});
  collectSamples(other, both);
  check('新期次照样进', both.level[key].length===9, both.level[key].length);

  // 手工构造的样本集（没有 _seen）不该炸
  const bare={dod:{}, dodMixed:{}, level:{}, levelMixed:{}};
  collectSamples(sc, bare);
  check('没有 _seen 时也能跑（不去重，但不报错）', bare.level[key].length===8, bare.level[key].length);
}

console.log('\n[6d] 均匀取样：同样的文件数覆盖更多期次');
{
  const many=[...Array(50)].map((_,i)=>`d${String(50-i).padStart(2,'0')}`);   // 倒序，接口就是这么给的
  const got=spreadPick(many, 12);
  check('取够 12 份', got.length===12, got.length);
  check('★ 永远含最新那份', got[0]==='d50', got[0]);
  check('★ 也含最旧那份（覆盖整个窗口）', got[got.length-1]==='d01', got[got.length-1]);
  check('★ 不是「取最近 12 份」', got[1]!=='d49', got.slice(0,3));
  check('没有重复', new Set(got).size===got.length, got);
  check('顺序不乱（还是倒序）', got.join()===[...got].sort().reverse().join(), got);
  check('存档比要的少就全给', spreadPick(['a','b','c'],12).join()==='a,b,c');
  check('一份也能取', spreadPick(['x'],12).join()==='x');
  check('空的给空的', spreadPick([],12).length===0);
  check('undefined 不炸', spreadPick(undefined,12).length===0);
}

console.log('\n[7] 分位数算得对');
{
  const s=[...Array(11)].map((_,i)=>i/10);      // 0 … 1.0
  check('P10', Math.abs(percentile(s,0.10)-0.1)<1e-12, percentile(s,0.10));
  check('P50 = 中位', Math.abs(percentile(s,0.50)-0.5)<1e-12);
  check('P90', Math.abs(percentile(s,0.90)-0.9)<1e-12);
  const L=summarizeLevel(s);
  check('summarizeLevel 五个分位都在',
        L.p10!=null&&L.p25!=null&&L.p50!=null&&L.p75!=null&&L.p90!=null&&L.n===11, L);
  const D=summarizeDod(seq(-0.01,0.002,12), 3, 0.01);
  check('minAbs 兜住：阈值不会比 ±1% 还松', D.drop<=-0.01 && D.rise>=0.01, D);
}

console.log('\n[8] stats 说得出「几个来源用自己的池」');
{
  const n=12;
  const dates=[...Array(n)].map((_,i)=>`2026-09-${String(i+1).padStart(2,'0')}`);
  const s=collectSamples(scene(dates, {
    '独立站API':      {[M.gw]:seq(0.80,0.001,n), [M.ck]:seq(0.99,0.0001,n)},
    '独立站标准收银台':{[M.gw]:seq(0.60,0.002,n)},
  }), emptySamples());
  const {stats}=buildBaseline(s,3,0.01);
  const gw=stats.find(x=>x.m===M.gw), ck=stats.find(x=>x.m===M.ck);
  check('网关通过率：2 个来源有自己的池', gw.own===2, gw);
  check('校验1通过率：只有 1 个', ck.own===1, ck);
  check('stats 带了参考分位数（只给人看，不参与判断）', gw.lvl && gw.lvl.p10!=null, gw.lvl);
  check('stats 说得出几个来源有自己的水平池', gw.ownLvl===2 && ck.ownLvl===1, {gw:gw.ownLvl, ck:ck.ownLvl});
  check('没有样本的指标标 insufficient',
        stats.find(x=>x.m==='2. 业务校验通过率').insufficient===true);
}

check.report();
