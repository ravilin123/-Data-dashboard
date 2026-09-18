/* 独立单文件看板的入口：读嵌好的数据 → 四块各自渲染。**不 fetch、不引任何外部路径**，全靠 importmap 里的模块。
   每块单独 try/catch：一块炸了写「渲染失败」在它自己的位置，别的照常（一块的 bug 不该让整张页白屏）。 */
import { initTheme } from '../../static/js/shared/theme.js';
import { esc } from '../../static/js/shared/dom.js';
import { renderTrade } from './trade.js';
import { renderChurn } from './churn.js';
import { renderOm } from './om.js';
import { renderConversion } from './conversion.js';

initTheme();

const D = JSON.parse(document.getElementById('board-data').textContent);
const RENDER = { trade: renderTrade, churn: renderChurn, om: renderOm, conversion: renderConversion };

for (const b of D.blocks || []) {
  const sec = document.querySelector(`[data-block="${b.key}"]`);
  if (!sec) continue;
  const head = sec.querySelector('.bdate');
  if (head) {
    head.textContent = b.date ? `数据日期 ${b.date}` : '没有数据';
    // 和文件日期不同的块标黄（Q15）：出单监控昨天没跑，这里就是 09-16 而文件是 09-17
    head.classList.toggle('warn', !b.date || b.date !== D.date);
  }
  const body = sec.querySelector('.body');
  if (!b.ok) {
    body.innerHTML = `<div class="empty">${esc(b.reason || '没有数据')}</div>`;
    continue;
  }
  try {
    RENDER[b.key](sec, b, D);
    if (b.reason) body.insertAdjacentHTML('afterbegin', `<div class="note">⚠ ${esc(b.reason)}</div>`);
  } catch (e) {
    console.error(b.key, e);
    body.innerHTML = `<div class="empty">渲染失败：${esc((e && e.stack) || e)}</div>`;
  }
}
