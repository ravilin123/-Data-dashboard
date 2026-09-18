/* 写进飞书多维表格的三张表：**列名**必须和人手工建的表一字不差。
 *
 *     node tests/bitable.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 为什么要专门钉列名：这三张表是人在飞书里手工建的。代码这边把「本期PO」改成
 * 「本期单量」不会有任何报错 —— 飞书那边只是从那天起这一列全空，而且**没人会发现**，
 * 直到一个月后想查数据时才发现少了一列。
 *
 * 改列名的话，三处必须同时改：这份用例、`static/js/conversion/feishu.js`、
 * 以及 `README.md` 里那张「怎么建表」的清单。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { state } = await import(MODULES + 'store.js');
const { buildDailyRecords, buildMerchantRecords, buildWatchRecords } =
  await import(MODULES + 'feishu.js');

/* ---- 三张表的列名。和 README「怎么建表」那三张清单一一对应 ---- */
const COLS = {
  scene: ['日期','周期','来源','指标','所属环节','层级','本期值','上期值','环比',
          '是否异常','角色','PO单数','进入本环节','通过本环节','影响单量'],
  merchant: ['日期','周期','来源','用户ID','商户名称','站点','指标','所属环节',
             '本期PO','进入本环节','通过本环节','上期比率','本期比率','环比变动',
             '影响单量','对大盘pt','样本少'],
  watchlist: ['日期','周期','类型','来源','用户ID','商户名称','站点','PO单数','成功率',
              '同行水平','缺口pt','连续','量少','出单监控','可多成单量','备注'],
};

/* ---- 造一份最小的 AnalysisResult。直接写字面量，不为了测一张表去造 xlsx ---- */
const M='4. 网关通过率';
state.data = {
  period:'日报', tDate:'2026-09-06', yDate:'2026-09-05',
  dfScene:[
    // _n/_d 是 load.js 从源表「分子/分母」列解析出来的（sceneCounts 认这两个）
    {统计日期:'2026-09-06', 来源:'独立站API', 类型:M, 当期值:0.60, _n:600, _d:1000},
    {统计日期:'2026-09-05', 来源:'独立站API', 类型:M, 当期值:0.70, _n:700, _d:1000},
  ],
  mergedSite:[{来源:'独立站API', 用户ID:'U1', '商户名称':'M1', 站点:'https://u1.example.com',
               'PO单数_今':1000}],
  mergedTotal:[],
  stages:{'独立站API':{stages:[{code:'4', rateT:0.60, rateY:0.70}]}},
  alarmTotal:[], alarmSite:[{来源:'独立站API', 异常指标:M, _role:'根因'}],
  drillTotal:[], drillSite:[{
    来源:'独立站API', 异常指标:M, 用户ID:'U1', 商户名称:'M1', 站点:'https://u1.example.com',
    本期PO总单量:1000, '进入本环节(单)':1000, '通过本环节(单)':600,
    上期比率:'70.00%', 本期比率:'60.00%', 比率环比变动:'-10.00%',
    影响比率:'-10.000%', 影响单量:-100, 对大盘影响:'−10.00pt', _small:false,
  }],
  churn:{
    lost:[{来源:'独立站API', 用户ID:'L1', 商户名称:'ML', 站点:'https://l1.example.com',
           PO单数:300, 成功率:0.4}],
    gained:[{来源:'独立站API', 用户ID:'G1', 商户名称:'MG', 站点:'https://g1.example.com',
             PO单数:20, 成功率:0.1, 单量少:true, 出单监控:['刚出单']}],
    partial:false, latestDaily:'2026-09-06',
  },
  watch:{
    low:[{src:'独立站API', uid:'U1', name:'M1', site:'https://u1.example.com',
          po:1000, rate:0.30, 基准:0.45, 缺口:0.15, 连续:true, 单量少:false,
          出单监控:['出单滞留'], 可多成:150}],
    fresh:[], omPending:[{用户ID:'P9', 商户名称:'待上量', 站点:'https://p9.example.com',
                          所属BD:'BD甲', 通道通过日期:'2026-09-05'}],
    omDate:'2026-09-06',
  },
};

const colsOf = recs => [...new Set(recs.flatMap(r=>Object.keys(r)))];

console.log('[1] ★ 场景指标表：老 11 列 + B10 补的 4 列');
{
  const recs=buildDailyRecords();
  check('有记录', recs.length === 1, recs.length);
  check('★ 列名和 README 那张清单一致',
        JSON.stringify(colsOf(recs).sort()) === JSON.stringify([...COLS.scene].sort()),
        colsOf(recs));
  const r=recs[0];
  // B10：原来只存比率，攒一年也回答不了「上个月一共折损多少单」
  check('★ 补上了 PO单数', r['PO单数'] === 1000, r['PO单数']);
  check('★ 补上了分子分母', r['进入本环节'] === 1000 && r['通过本环节'] === 600,
        [r['进入本环节'], r['通过本环节']]);
  // 环节4 是最后一关，下游 = 1 → 影响单量 = (0.6-0.7) × 1000 × 1 = −100
  check('★ 补上了影响单量', r['影响单量'] === -100, r['影响单量']);
  check('日期是字符串（服务端转成毫秒时间戳）', typeof r['日期'] === 'string', r['日期']);
  check('是否异常写「是」/「否」（服务端转布尔）', r['是否异常'] === '是', r['是否异常']);
}

console.log('\n[2] ★ 商户明细表：只存触发告警的下钻行');
{
  const recs=buildMerchantRecords();
  check('有记录', recs.length === 1, recs.length);
  check('★ 列名和 README 那张清单一致',
        JSON.stringify(colsOf(recs).sort()) === JSON.stringify([...COLS.merchant].sort()),
        colsOf(recs));
  const r=recs[0];
  check('用户ID 是字符串（19 位，走数字列会丢精度）',
        typeof r['用户ID'] === 'string', typeof r['用户ID']);
  /* ★ 数字列直接发数字，不发 "60.00%" 这种字符串 —— 少一道字符串解析就少一类
     静默出错：解析不出来的值会被原样写进百分比字段，飞书报的错和字段类型错误一样。 */
  check('★ 比率发的是小数不是百分号字符串',
        r['本期比率'] === 0.6 && r['上期比率'] === 0.7, [r['上期比率'], r['本期比率']]);
  check('★ 环比变动也是小数', Math.abs(r['环比变动'] + 0.1) < 1e-9, r['环比变动']);
  check('★ 对大盘pt 解析掉了「pt」和 U+2212 减号',
        Math.abs(r['对大盘pt'] + 0.1) < 1e-9, r['对大盘pt']);
  check('影响单量原样带过来', r['影响单量'] === -100, r['影响单量']);
  check('样本少写「是」/「否」', r['样本少'] === '否', r['样本少']);
}

console.log('\n[3] ★ 商户名单表：四类合一张，用「类型」列区分');
{
  const recs=buildWatchRecords();
  check('四类各一条', recs.length === 4, recs.length);
  check('★ 列名和 README 那张清单一致',
        JSON.stringify(colsOf(recs).sort()) === JSON.stringify([...COLS.watchlist].sort()),
        colsOf(recs));
  check('★ 类型齐了',
        recs.map(r=>r['类型']).join() === '掉量,新增,低于同行,刚审核通过',
        recs.map(r=>r['类型']));
  /* ★ 每条都带齐全部列（哪怕是空的）—— 少列的那几条飞书会当成「没这个字段」，
     以后按列筛选时那些行会莫名其妙漏掉。 */
  check('★ 每条都带齐全部列',
        recs.every(r=>Object.keys(r).length === COLS.watchlist.length),
        recs.map(r=>Object.keys(r).length));
  const low=recs.find(r=>r['类型']==='低于同行');
  check('低于同行带上同行水平和缺口',
        low['同行水平'] === 0.45 && Math.abs(low['缺口pt']-0.15)<1e-9, low);
  check('连续 / 量少 写「是」/「否」', low['连续']==='是' && low['量少']==='否', low);
  check('带上出单监控的标签', low['出单监控'] === '出单滞留', low['出单监控']);
  check('可多成单量带过来', low['可多成单量'] === 150, low['可多成单量']);
  const pend=recs.find(r=>r['类型']==='刚审核通过');
  check('刚审核通过把 BD 和通道通过日期写进备注（好去找人）',
        /BD BD甲/.test(pend['备注']) && /通道通过 2026-09-05/.test(pend['备注']), pend['备注']);
}

console.log('\n[4] 本期未走完时，掉量那条要带上提醒');
{
  state.data.churn.partial = true;
  const lost = buildWatchRecords().find(r=>r['类型']==='掉量');
  check('★ 备注里写清楚「可能只是还没下单」',
        /本期未走完/.test(lost['备注']) && /2026-09-06/.test(lost['备注']), lost['备注']);
  state.data.churn.partial = false;
}

check.report();
