/* 转化率的无头跑法（第 10 张票）
 *
 *     echo '{"file":"…","archives":[…]}' | node jobs/conversion_run.mjs
 *
 * 把页面上那条链在 Node 里跑一遍：读报表 → analyze → 两条播报 → 三张表的行。
 * **一行分析代码都不重写** —— 直接 import `static/js/conversion/` 里那些模块，
 * 页面和这里跑的是同一份。抄一份的话两边迟早漂，而漂掉的样子是
 * 「页面上看到的和群里发的不是一回事」，没人查得出来。
 *
 * 入参走 **stdin 的 JSON**，不走命令行：命令行在任务管理器里明文可见（同出单监控那条）。
 * 出参走 stdout 的一行 JSON；日志一律走 stderr，别把它们混进结果里。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/* ⚠ **动态 import 必须给 file:// URL，不能给绝对路径**：Windows 上的 `C:\…`
   会被当成协议名（ERR_UNSUPPORTED_ESM_URL_SCHEME），Linux 上却一切正常 ——
   于是用例全绿、生产机器天天失败。目标平台就是 Windows。 */
const mod = name => pathToFileURL(path.join(ROOT, 'static/js/conversion', name)).href;
const log = (...a) => console.error('[conversion]', ...a);

/* SheetJS 是 UMD，没有 ESM 导出：在 vm 里跑一遍拿 window.XLSX。
   读的是**页面加载的同一份文件**，不会和页面漂移。 */
function loadSheetJS() {
  const src = fs.readFileSync(path.join(ROOT, 'static/vendor/xlsx.full.min.js'), 'utf8');
  const ctx = { console, Date, Math, JSON, RegExp, Error, TextDecoder, TextEncoder,
                Uint8Array, ArrayBuffer, Buffer, process };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  if (!ctx.XLSX) throw new Error('static/vendor/xlsx.full.min.js 没设上 window.XLSX');
  return ctx.XLSX;
}

/* 那几个模块经 render/index.js → main.js 那个环会把整条界面接线一起拖进来
   （main.js 顶层就在 addEventListener），所以要一套 DOM 桩。
   和 tests/_harness.mjs 是同一套写法 —— 那边是为了跑用例，这边是为了跑生产。 */
const fakeEl = () => new Proxy({}, {
  get(_, k) {
    if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
    if (k === 'dataset' || k === 'style') return {};
    if (k === 'options' || k === 'files' || k === 'children') return [];
    if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
    if (k === 'checked' || k === 'hidden' || k === 'disabled') return false;
    if (k === 'parentNode' || k === 'closest' || k === 'firstChild') return null;
    return () => fakeEl();
  },
  set() { return true; },
});

function installStubs() {
  globalThis.XLSX = loadSheetJS();
  globalThis.document = {
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    getElementById: () => fakeEl(), createElement: () => fakeEl(),
    documentElement: { removeAttribute() {}, setAttribute() {} },
    addEventListener() {}, body: fakeEl(),
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
  globalThis.location = { search: '', href: '' };
  globalThis.window = globalThis;
  globalThis.window.scrollTo = () => {};
}

const readWb = f => globalThis.XLSX.read(fs.readFileSync(f), { cellDates: true });
/* computeBaseline 要的是「有 .arrayBuffer() 的东西」（页面上是 File/Blob）。
   本机存档给它包一层就行，不用把那个函数改成认两种入参。 */
const asFile = f => ({ name: path.basename(f), arrayBuffer: async () => fs.readFileSync(f) });

async function main(input) {
  installStubs();
  const [{ readReport }, { analyze }, bc, fs_, cfg, funnel, bl, ai] = await Promise.all([
    import(mod('dataset.js')), import(mod('analyze.js')),
    import(mod('broadcast.js')), import(mod('feishu.js')),
    import(mod('config.js')), import(mod('funnel.js')),
    import(mod('baseline.js')), import(mod('ai_prompt.js')),
  ]);

  const wb = readWb(input.file);
  const ds = readReport(wb);

  /* 基准线：每次从本机存档现算。页面上是点按钮算一次存起来，无头跑没人点，
     而没有基准线时「水平信号」那一段整块不出（B3）—— 那正是周月报最值钱的一段。 */
  let baseline = null, baselineNote = '';
  const archives = input.archives || [];
  if (archives.length) {
    try {
      const pick = bl.spreadPick(archives.map(a => a.date || a), cfg.ARCHIVE_MAX_FILES);
      const files = archives.filter(a => pick.includes(a.date || a)).map(a => asFile(a.path || a));
      const r = await bl.computeBaseline(files, input.baselineK || 3, (input.baselineMinAbs ?? 1) / 100);
      baseline = r.bl;
      baselineNote = `基准线取样 ${files.length} 份 / 共 ${archives.length} 份，样本 ${r.totalN}`;
    } catch (e) {
      baselineNote = `基准线算不出来（${e.message}），这次不带水平信号`;
      log(baselineNote);
    }
  } else {
    baselineNote = '本机没有存档，这次不带水平信号';
  }

  const out = { ok: true, file: path.basename(input.file), baselineNote, periods: {} };
  for (const period of (input.periods || cfg.PERIOD_ORDER)) {
    const dates = (ds.dates && ds.dates[period]) || [];
    const avail = ds.periods && ds.periods[period];
    if (dates.length < 2 || !(avail && avail.ok)) {
      out.periods[period] = { available: false,
        reason: `${period}只有 ${dates.length} 期，不足以算环比` };
      continue;
    }
    cfg.setPeriod(period);
    const [tDate, yDate] = dates;                    // dates 已按期次倒序
    const data = analyze(ds, { period, tDate, yDate, baseline, baselineActive: !!baseline,
                               orderMonitor: input.orderMonitor || null });
    /* 这一期走完了没有：期末日 > 报表里最新的那个日报日期 = 还没走完。
       没走完就发的话，「本期掉了 9 万单」这种又大又醒目的假结论会把整条播报带偏（§2.16）。 */
    const latestDaily = ((ds.dates && ds.dates['日报']) || [])[0] || null;
    const complete = !funnel.periodIncomplete(tDate, latestDaily);
    const txt = bc.broadcastTxt(data.alarmTotal, data.drillTotal, data.alarmSite, data.drillSite, tDate, data);
    const md = bc.broadcastMd(data.alarmTotal, data.drillTotal, data.alarmSite, data.drillSite, tDate, data);
    out.periods[period] = {
      available: true, tDate, yDate, complete, latestDaily,
      alarms: (data.alarmTotal || []).length + (data.alarmSite || []).length,
      broadcast: { txt, md },
      watch: { txt: bc.watchTxt(tDate, data), md: bc.watchMd(tDate, data) },
      records: {
        scene: fs_.buildDailyRecords(data),
        merchant: fs_.buildMerchantRecords(data),
        watchlist: fs_.buildWatchRecords(data),
      },
      // 提示词只给周月报用（日报那套口径不一样，而且日报不发 AI 总结）
      aiPrompt: period === '日报' ? null : ai.buildAIPrompt(data, md),
    };
  }
  return out;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', async () => {
  try {
    const out = await main(JSON.parse(raw || '{}'));
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, msg: String(e && e.message || e) }));
    log(e && e.stack || e);
    process.exitCode = 1;
  }
});
