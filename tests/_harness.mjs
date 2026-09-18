/* Node 里跑 static/js/conversion/ 那些模块要的两样东西：SheetJS 和一个 DOM 桩。
   两个用例（dod_column / dataset）共用，别各写一份 —— 这仓库吃过重复实现漂移的亏。 */
import vm from 'vm'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODULES = path.join(ROOT, 'static/js/conversion') + '/';

/* SheetJS 是 UMD，没有 ESM 导出，在 vm 里跑一遍拿 window.XLSX。
   读的就是页面加载的同一份文件（T4 抽出来的），不会和页面漂移。 */
function loadSheetJS(){
  const src = fs.readFileSync(path.join(ROOT, 'static/vendor/xlsx.full.min.js'), 'utf8');
  const ctx = { console, Date, Math, JSON, RegExp, Error, TextDecoder, TextEncoder,
                Uint8Array, ArrayBuffer, Buffer, process };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  if(!ctx.XLSX) throw new Error('static/vendor/xlsx.full.min.js 没设上 window.XLSX');
  return ctx.XLSX;
}

/* 为什么桩要这么全：分析核心经 render/index.js → main.js 那个环，会把整条界面接线
   一起拖进来（main.js 顶层就在 addEventListener）。T3 把 store 读取收进参数、
   T7 抽出 shared 层之后，这个桩能瘦回几行。在那之前，桩全一点比给模块加
   `if(typeof document)` 分支干净 —— 后者会让生产代码为了测试变形。 */
const fakeEl = () => new Proxy({}, {
  get(_, k) {
    if (k === 'classList') return { add(){}, remove(){}, toggle(){}, contains: () => false };
    if (k === 'dataset' || k === 'style') return {};
    if (k === 'options' || k === 'files' || k === 'children') return [];
    if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
    if (k === 'checked' || k === 'hidden' || k === 'disabled') return false;
    if (k === 'parentNode' || k === 'closest' || k === 'firstChild') return null;
    return () => fakeEl();
  },
  set() { return true; },
});

export function installBrowserStubs(){
  globalThis.XLSX = loadSheetJS();
  globalThis.document = {
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    getElementById: () => fakeEl(), createElement: () => fakeEl(),
    documentElement: { removeAttribute(){}, setAttribute(){} },
    addEventListener(){}, body: fakeEl(),
  };
  globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
  globalThis.fetch = async () => ({ ok:false, json: async()=>({}), text: async()=>'' });
  globalThis.location = { search: '', href: '' };
  globalThis.window = globalThis;
  globalThis.window.scrollTo = () => {};
  return globalThis.XLSX;
}

/** 极简断言器：打一行 PASS/FAIL，最后 report() 决定退出码。 */
export function makeChecker(){
  let fails = 0;
  const check = (name, cond, extra='') => {
    console.log((cond ? '  PASS ' : '  FAIL ') + name + (!cond && extra ? '  << ' + extra : ''));
    if (!cond) fails++;
  };
  check.report = () => {
    console.log(fails ? `\n失败 ${fails} 项` : '\n全部通过');
    process.exit(fails ? 1 : 0);
  };
  return check;
}
