/* 给 tests/board.py 造转化率报表：node tests/_board_xlsx.mjs <今天.xlsx> <昨天.xlsx>
   形状照 tests/dataset.mjs 的 makeWb（同步来的），两份：今天带三期、昨天带两期（算基准线用）。
   用的就是同步来的 SheetJS（static/vendor/xlsx.full.min.js），和页面同一份。 */
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'static/vendor/xlsx.full.min.js'), 'utf8');
const ctx = { console, Date, Math, JSON, RegExp, Error, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, Buffer, process };
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(src, ctx);
const XLSX = ctx.XLSX;

const METRICS = [['4. 网关通过率', '网关通过率'], ['2. 业务校验通过率', '业务校验通过率']];
const VAL = { '2026-09-15': 0.90, '2026-09-16': 0.80, '2026-09-17': 0.72 };

function makeWb(dates) {
  const scene = [['时间类别', '统计日期', '来源', '类型', '当期值', '分子/分母']];
  for (const date of dates)
    for (const [, raw] of METRICS)
      scene.push(['日报', date, '独立站API', raw, VAL[date], '8000/10000']);
  const mHead = ['时间类别', '统计日期', '用户ID', '站点', '来源', 'PO单数', ...METRICS.map(m => m[1])];
  const merch = [mHead];
  for (const date of dates)
    for (const uid of ['1000000000000000001', '1000000000000000002'])
      merch.push(['日报', date, uid, `https://s-${uid.slice(-1)}.example.com`, '独立站API', 500, ...METRICS.map(() => VAL[date])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scene), '场景维度');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(merch), '商户维度');
  return wb;
}

const [today, yesterday] = process.argv.slice(2);
fs.mkdirSync(path.dirname(today), { recursive: true });
fs.writeFileSync(today, XLSX.write(makeWb(['2026-09-15', '2026-09-16', '2026-09-17']), { type: 'buffer', bookType: 'xlsx' }));
fs.writeFileSync(yesterday, XLSX.write(makeWb(['2026-09-15', '2026-09-16']), { type: 'buffer', bookType: 'xlsx' }));
