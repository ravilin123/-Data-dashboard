/* 转化率的无头跑法（jobs/conversion_run.mjs，第 10 张票）
 *
 *     node tests/conversion_headless.mjs      # 零依赖
 *
 * 最要紧的一条：**无头跑出来的东西和页面那条链逐字节相同**。
 * 这里不重新实现一遍分析，而是直接把同一批模块在本进程里跑一遍，
 * 再和子进程的输出比 —— 两边漂了就红。漂掉的样子是「页面上看到的和群里发的不是一回事」。
 */
import { execFileSync } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { MODULES, ROOT, installBrowserStubs, makeChecker } from './_harness.mjs';

const XLSX = installBrowserStubs();
const check = makeChecker();

const { readReport } = await import(MODULES + 'dataset.js');
const { analyze } = await import(MODULES + 'analyze.js');
const bc = await import(MODULES + 'broadcast.js');
const fsMod = await import(MODULES + 'feishu.js');
const cfg = await import(MODULES + 'config.js');
const funnel = await import(MODULES + 'funnel.js');

/* ---------- 造一份最小报表：日报 3 期 + 周报 2 期 ---------- */
const METRICS = [['4. 网关通过率', '网关通过率'], ['2. 业务校验通过率', '业务校验通过率']];
const DAYS = ['2026-09-04', '2026-09-05', '2026-09-06'];
const WEEKS = ['2026 W36 (2026-08-28~2026-09-03)', '2026 W37 (2026-09-04~2026-09-10)'];
const VAL = { '2026-09-04': 0.90, '2026-09-05': 0.80, '2026-09-06': 0.62,
              [WEEKS[0]]: 0.88, [WEEKS[1]]: 0.61 };

function makeFile() {
  const scene = [['时间类别', '统计日期', '来源', '类型', '当期值', '分子/分母']];
  const merch = [['时间类别', '统计日期', '用户ID', '站点', '来源', 'PO单数', ...METRICS.map(m => m[1])]];
  const add = (kind, date) => {
    for (const [, raw] of METRICS) scene.push([kind, date, '独立站API', raw, VAL[date], '8000/10000']);
    for (const uid of ['1000000000000000001', '1000000000000000002'])
      merch.push([kind, date, uid, `https://s-${uid.slice(-1)}.example.com`, '独立站API', 500,
                  ...METRICS.map(() => VAL[date])]);
  };
  DAYS.forEach(d => add('日报', d));
  WEEKS.forEach(w => add('周报', w));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scene), '场景维度');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(merch), '商户维度');
  // SheetJS 是在 vm 里加载的，那个上下文里没有 fs —— writeFile / readFile 都用不了，
  // 自己拿 buffer 写盘（jobs/conversion_run.mjs 里读的时候同理）
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-conv-')), 'r.xlsx');
  fs.writeFileSync(f, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return f;
}

const file = makeFile();
const raw = execFileSync('node', [path.join(ROOT, 'jobs/conversion_run.mjs')],
  { input: JSON.stringify({ file, periods: ['日报', '周报'] }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const out = JSON.parse(raw);

console.log('[1] 跑得起来、两个周期都在');
check('ok', out.ok === true, out.msg);
check('日报和周报都算了', !!(out.periods['日报'] && out.periods['周报']), Object.keys(out.periods));
check('没有存档时说清楚这次不带水平信号', /没有存档/.test(out.baselineNote), out.baselineNote);

console.log('[2] ★ 和页面那条链逐字节相同（同一批模块，在本进程里再跑一遍）');
const ds = readReport(XLSX.read(fs.readFileSync(file), { cellDates: true }));
for (const period of ['日报', '周报']) {
  cfg.setPeriod(period);
  const dates = ds.dates[period];
  const data = analyze(ds, { period, tDate: dates[0], yDate: dates[1],
                             baseline: null, baselineActive: false, orderMonitor: null });
  const got = out.periods[period];
  const wantTxt = bc.broadcastTxt(data.alarmTotal, data.drillTotal, data.alarmSite, data.drillSite, dates[0], data);
  const wantMd = bc.broadcastMd(data.alarmTotal, data.drillTotal, data.alarmSite, data.drillSite, dates[0], data);
  check(`${period} 取的是最新两期`, got.tDate === dates[0] && got.yDate === dates[1], [got.tDate, got.yDate]);
  check(`★ ${period} 播报 txt 逐字节相同`, got.broadcast.txt === wantTxt,
    (got.broadcast.txt || '').slice(0, 80) + ' ≠ ' + (wantTxt || '').slice(0, 80));
  check(`★ ${period} 播报 md 逐字节相同`, got.broadcast.md === wantMd);
  check(`★ ${period} 待观察名单逐字节相同`, got.watch.txt === bc.watchTxt(dates[0], data));
  check(`★ ${period} 三张表的行逐字段相同`,
    JSON.stringify(got.records.scene) === JSON.stringify(fsMod.buildDailyRecords(data))
    && JSON.stringify(got.records.merchant) === JSON.stringify(fsMod.buildMerchantRecords(data))
    && JSON.stringify(got.records.watchlist) === JSON.stringify(fsMod.buildWatchRecords(data)),
    [got.records.scene.length, fsMod.buildDailyRecords(data).length]);
  check(`${period} 异常计数对得上`,
    got.alarms === (data.alarmTotal || []).length + (data.alarmSite || []).length, got.alarms);
}

console.log('[3] ★ 周期走完了没有：没走完的不发');
{
  const d = out.periods['日报'], w = out.periods['周报'];
  check('日报那期算走完了', d.complete === true, d);
  // W37 是 2026-09-04~09-10，而报表里最新的日报是 09-06 → 还没走完
  check('★ 周报选到还没走完的那一期时 complete=false', w.complete === false, [w.tDate, w.latestDaily]);
  check('判定和页面同一个函数（periodIncomplete）',
    funnel.periodIncomplete(w.tDate, w.latestDaily) === true);
}

console.log('[4] AI 提示词只给周月报');
check('★ 日报不给提示词（日报不发 AI 总结）', out.periods['日报'].aiPrompt === null);
check('周报给了提示词', typeof out.periods['周报'].aiPrompt === 'string' && out.periods['周报'].aiPrompt.length > 50);

console.log('[5] 报表里没有的周期：说清楚，不是报错');
{
  const r = JSON.parse(execFileSync('node', [path.join(ROOT, 'jobs/conversion_run.mjs')],
    { input: JSON.stringify({ file, periods: ['月报'] }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  check('ok 仍然是 true', r.ok === true);
  check('那个周期 available:false 且带原因', r.periods['月报'].available === false
    && /不足以算环比|只有/.test(r.periods['月报'].reason), r.periods['月报']);
}

console.log('[6] 入参走 stdin 不走命令行（命令行在任务管理器里明文可见）');
{
  const src = fs.readFileSync(path.join(ROOT, 'jobs/conversion_run.mjs'), 'utf8');
  check('★ 没有从 argv 读文件路径', !/process\.argv\s*\[/.test(src));
  check('读的是 stdin', /process\.stdin/.test(src));
}

fs.rmSync(path.dirname(file), { recursive: true, force: true });
check.report();
