/* golden_js.mjs —— JS 口径层的黄金用例跑法。scripts/生成黄金用例.py 起它，stdin 喂 {family, input, settings}，
 * stdout 回 JSON。零依赖，node 直跑。
 *
 * 每个 family 对应一个纯函数入口；模块从 static/js/ 原路径 import（同步来的，别改）。
 * conversion/ 那些模块的 import 图会拖进 render 层，所以一律先装 tests/_harness.mjs 的 DOM 桩。 */
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { installBrowserStubs, MODULES } = await import(path.join(ROOT, 'tests/_harness.mjs'));
const C = MODULES, S = path.join(ROOT, 'static/js/shared') + '/', M = path.join(ROOT, 'static/js/merchant') + '/';

const req = JSON.parse(fs.readFileSync(0, 'utf8'));
const { family, input } = req;
installBrowserStubs();
let out;
switch (family) {
  case 'conversion_funnel': {
    const F = await import(C + 'funnel.js');
    out = {
      toRate: (input.rates || []).map(F.toRate),
      chainDenom: input.row ? F.chainDenom(input.row, input.metric, input.suffix) : null,
      calcFunnel: input.row ? F.calcFunnel(input.row, input.metric, input.suffix) : null,
      hasDenomChain: (input.metrics || []).map(m => [m, F.hasDenomChain(m)]),
    };
    break;
  }
  case 'conversion_coverage': {
    const V = await import(C + 'coverage.js');
    out = V.coverageCheck(V.scenePOBySource(input.rows), input.date);
    break;
  }
  case 'conversion_analyze': {
    const A = await import(C + 'analyze.js');
    out = A.analyze(input.dataset, input.opts);
    break;
  }
  case 'shared_fail_group': {
    const G = await import(S + 'fail_group.js');
    out = G.groupFailures(input.rows, { methodOf: r => r.pay_method });
    break;
  }
  case 'merchant_status': {
    const U = await import(M + 'util.js');
    out = { stClass: input.statuses.map(U.stClass), excludePending: U.excludePending(input.rows).map(r => r.status) };
    break;
  }
  case 'merchant_change_attrib': {
    const D = await import(M + 'charts_data.js');
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
