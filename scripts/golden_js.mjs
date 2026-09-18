/* golden_js.mjs —— JS 口径层的黄金用例跑法。scripts/生成黄金用例.py 起它：
 *     node scripts/golden_js.mjs <请求.json>      请求是 {family, input, settings}，结果 JSON 写到 stdout
 * 零依赖，node 直跑。
 *
 * 每个 family 对应一个纯函数入口；模块从 static/js/ 原路径 import（同步来的，别改）。
 * conversion/ 那些模块的 import 图会拖进 render 层，所以一律先装 tests/_harness.mjs 的 DOM 桩。
 *
 * ⚠ Windows 上两件事（坑-看板.md §D4，照 jobs/conversion_run.mjs 的做法）：
 *   · ESM 的 import() 不吃 `D:\...` 这种裸路径，要 pathToFileURL 转成 file:// URL；
 *   · 同步读 stdin（fs.readFileSync(0)）会抛 EOF / EAGAIN，所以请求走文件不走 stdin。 */
import fs from 'fs'; import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (...p) => pathToFileURL(path.join(ROOT, ...p)).href;
const { installBrowserStubs } = await import(mod('tests', '_harness.mjs'));
const C = name => mod('static', 'js', 'conversion', name);
const S = name => mod('static', 'js', 'shared', name);
const M = name => mod('static', 'js', 'merchant', name);

const reqPath = process.argv[2];
if (!reqPath) { console.error('用法：node scripts/golden_js.mjs <请求.json>'); process.exit(2); }
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const { family, input } = req;
installBrowserStubs();
let out;
switch (family) {
  case 'conversion_funnel': {
    const F = await import(C('funnel.js'));
    out = {
      toRate: (input.rates || []).map(F.toRate),
      chainDenom: input.row ? F.chainDenom(input.row, input.metric, input.suffix) : null,
      calcFunnel: input.row ? F.calcFunnel(input.row, input.metric, input.suffix) : null,
      hasDenomChain: (input.metrics || []).map(m => [m, F.hasDenomChain(m)]),
    };
    break;
  }
  case 'conversion_coverage': {
    const V = await import(C('coverage.js'));
    out = V.coverageCheck(V.scenePOBySource(input.rows), input.date);
    break;
  }
  case 'conversion_analyze': {
    const A = await import(C('analyze.js'));
    out = A.analyze(input.dataset, input.opts);
    break;
  }
  case 'conversion_watchlist': {
    const W = await import(C('watchlist.js'));
    const { OVERALL_METRIC } = await import(C('config.js'));
    const merged = input.merged.map(([uid, src, po, t, y]) => ({
      来源: src, 用户ID: uid, 商户名称: 'M' + uid, 站点: `https://${uid}.example.com`, 'PO单数_今': po,
      [OVERALL_METRIC + '_今']: t, ...(y == null ? {} : { [OVERALL_METRIC + '_昨']: y }),
    }));
    const w = W.buildWatchlist(merged, input.churn || { gained: [] }, true);
    out = { watchlist: w, peerBaselines: W.peerBaselines(merged.map(r => ({ src: r.来源, po: r['PO单数_今'], rate: r[OVERALL_METRIC + '_今'] }))) };
    break;
  }
  case 'conversion_level': {
    const L = await import(C('level.js'));
    const bl = { baseline: { v: 2, bySrc: {}, mixed: {}, level: input.level || {}, levelMixed: input.levelMixed || {} }, active: true };
    out = L.levelSignals(input.rows, { tDate: input.tDate, bl });
    break;
  }
  case 'conversion_trend': {
    const T = await import(C('trend.js'));
    out = T.buildTrend(input.rows, { limit: input.limit || 12 });
    break;
  }
  case 'conversion_baseline': {
    const B = await import(C('baseline.js'));
    const samples = B.collectSamples(input.rows, B.emptySamples());
    out = { samples, baseline: B.buildBaseline(samples, input.k, input.min_abs) };
    break;
  }
  case 'conversion_po_rate': {
    const P = await import(C('po_rate.js'));
    out = P.buildPoRate(input.rows, { tDate: input.tDate, yDate: input.yDate || null });
    break;
  }
  case 'shared_fail_group': {
    const G = await import(S('fail_group.js'));
    out = G.groupFailures(input.rows, { methodOf: r => r.pay_method });
    break;
  }
  case 'merchant_status': {
    const U = await import(M('util.js'));
    out = { stClass: input.statuses.map(U.stClass), excludePending: U.excludePending(input.rows).map(r => r.status) };
    break;
  }
  case 'merchant_change_attrib': {
    const D = await import(M('charts_data.js'));
    const mk = spec => D.groupMetric(spec.flatMap(([v, n, succ]) =>
      [...Array(succ)].map(() => ({ status: '支付成功', amount: 100, m: v }))
        .concat([...Array(n - succ)].map(() => ({ status: '支付失败', amount: 100, m: v })))), 'm', null, false);
    out = D.changeAttrib(mk(input.curr), mk(input.last), 'm');
    break;
  }
  default:
    throw new Error('不认识的 family：' + family);
}
process.stdout.write(JSON.stringify(out === undefined ? null : out));
