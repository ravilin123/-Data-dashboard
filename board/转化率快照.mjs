/* 转化率快照：读一份报表存档 → Dataset（ds）+ 三个周期各自的基准线。给 board/blocks.py 用。
 *
 *     echo '{"file":"…","archives":[{"date","path"}…],"maxFiles":12,"baselineK":3,"baselineMinAbs":1}' | node board/转化率快照.mjs
 *
 * **一行分析代码都不重写**：直接 import 同步来的 static/js/conversion/ 那些模块（dataset.js 读报表、
 * baseline.js 攒样本算基准线、load.js 读场景维度），页面和工作台跑的是同一份。
 * analyze 不在这里跑 —— 页面打开时用同步来的 analyze.js 现算现画（切周期不用重新生成）。
 *
 * 入参走 stdin 的 JSON（命令行在任务管理器里明文可见）；出参走 stdout 一行 JSON；日志一律 stderr。
 * ⚠ 动态 import 必须给 file:// URL：Windows 上 `D:\…` 会被当成协议名（工作台 conversion_run.mjs 踩过）。
 * ⚠ 基准线**按周期各算一份**（页面上就是各周期独立的），但存档每份只 XLSX.read 一次 —— 3MB 的报表读一次 2 秒，
 *   12 份 × 3 个周期读三遍就是一分多钟。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = name => pathToFileURL(path.join(ROOT, 'static/js/conversion', name)).href;
const log = (...a) => console.error('[转化率快照]', ...a);

/* SheetJS 是 UMD，没有 ESM 导出：在 vm 里跑一遍拿 window.XLSX。读的是**页面加载的同一份文件**。 */
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

/* baseline.js 经 render/index.js → main.js 那个环会把整条界面接线一起拖进来（顶层就在 addEventListener），
   所以要一套 DOM 桩 —— 和工作台 tests/_harness.mjs / jobs/conversion_run.mjs 同一套写法。 */
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

async function main(input) {
  installStubs();
  const [{ readReport }, cfg, bl, { loadScene }] = await Promise.all([
    import(mod('dataset.js')), import(mod('config.js')), import(mod('baseline.js')), import(mod('load.js')),
  ]);
  if (!input.file) throw new Error('缺 file');
  const wb = readWb(input.file);
  const ds = readReport(wb);

  /* 基准线：均匀取样（不是取最近 N 份，§2.11），每份读一次，三个周期各攒各的样本。 */
  const archives = input.archives || [];
  const maxFiles = input.maxFiles || cfg.ARCHIVE_MAX_FILES;
  const picks = new Set(bl.spreadPick(archives.map(a => a.date), maxFiles));
  const wbs = [];
  for (const a of archives.filter(a => picks.has(a.date))) {
    try { wbs.push(readWb(a.path)); } catch (e) { log(`存档 ${a.date} 读不出来：${e.message}`); }
  }
  const k = input.baselineK || 3, minAbs = (input.baselineMinAbs ?? 1) / 100;
  const baselines = {}, baselineNotes = {};
  for (const p of cfg.PERIOD_ORDER) {
    if (!wbs.length) { baselines[p] = null; baselineNotes[p] = '本机没有更早的存档，这次不带水平信号'; continue; }
    cfg.setPeriod(p);
    const samples = bl.emptySamples();
    let used = 0;
    for (const w of wbs) {
      if (!w.SheetNames.includes('场景维度')) continue;
      let scene;
      try { scene = loadScene(w, p); } catch (e) { continue; }
      if (!scene || !scene.length) continue;
      bl.collectSamples(scene, samples);
      used++;
    }
    if (!used) { baselines[p] = null; baselineNotes[p] = `存档里没有${p}的行，这个周期不带水平信号`; continue; }
    const r = bl.buildBaseline(samples, k, minAbs);
    baselines[p] = r.bl || null;
    baselineNotes[p] = `${p}基准线取样 ${used} 份 / 存档共 ${archives.length} 份，样本 ${r.totalN}`;
  }
  cfg.setPeriod(cfg.PERIOD_ORDER[0]);
  return { ok: true, file: path.basename(input.file), ds, baselines, baselineNotes,
           note: wbs.length ? `基准线取样 ${wbs.length} 份 / 存档共 ${archives.length} 份` : '本机没有更早的存档，这次不带水平信号' };
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
