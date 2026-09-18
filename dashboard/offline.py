# -*- coding: utf-8 -*-
"""dashboard.offline —— 把工作台的四个页面**原样**装进一张离线单文件。

思路（2026-09-18 在 Chromium 上验过：file:// 下能跑）：
  · 页面 HTML 原封不动（样式、布局、交互都是工作台自己的）；
  · 页面的 ES 模块不打包、不改语义：每个模块变成一个 data: URL，用 `<script type="importmap">` 把
    `wb:conversion/funnel.js` 这种裸说明符映射过去 —— live binding、提升、TDZ 全保留（`config.setPeriod`
    改的是导出变量，打包成 CommonJS 会把它弄成死值）；
  · 页面所有 `fetch('/api/…')` 由一段前置脚本接管：接口响应事先在工作台里抓好嵌进文件（snapshot.py），
    按「路径 + 排好序的查询参数」命中；没嵌的回 ok:false + 一句人话，不 500；
  · 四个页面各是一个 `srcdoc` iframe，外面套一层和首页一样的图标轨。

⚠ 页面里任何 `/static/…` 的引用都得在这里被替换掉（vendor SheetJS 内联进去），file:// 下没有 /static。
⚠ 嵌进 <script> 的 JSON 里 `</` 要转义成 `<\\/`，否则一个商户名就能把页面截断。
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
STATIC = HERE / "static"
JS_ROOT = STATIC / "js"
VENDOR_XLSX = STATIC / "vendor" / "xlsx.full.min.js"

# 四个页面：page 键 → (静态文件, 入口模块, 轨道上的名字, 图标 SVG 内容)
PAGES = [
    ("conversion", "conversion.html", "conversion/main.js", "转化率监控",
     '<path d="M3 16.5V11"/><path d="M8.3 16.5V6"/><path d="M13.7 16.5v-3.5"/><path d="M3 8l5.3-5 5.4 5L18 4.2"/>'),
    ("order-monitor", "order_monitor.html", "order_monitor/main.js", "出单监控",
     '<path d="M3 4.5h14"/><path d="M3 10h9"/><path d="M3 15.5h5"/><circle cx="15" cy="14" r="3.2"/>'),
    ("churn", "churn.html", "churn/main.js", "商户流失",
     '<path d="M3 5.5l5 5.5 3.5-3.5L17 13"/><path d="M13 13h4v-4"/>'),
    ("trade", "trade.html", "trade/main.js", "交易概览",
     '<circle cx="10" cy="10" r="6.5"/><path d="M10 6v4l3 2"/>'),
]

_IMPORT = re.compile(r"""(\bimport\s*(?:[^'"]*?)\s*from\s*|\bimport\s*)(['"])(\.{1,2}/[^'"]+)\2""")
_EXPORT_FROM = re.compile(r"""(\bexport\s*\{[^}]*\}\s*from\s*)(['"])(\.{1,2}/[^'"]+)\2""")


def _spec(p: Path) -> str:
    return "wb:" + p.resolve().relative_to(JS_ROOT.resolve()).as_posix()


def collect_modules(entry: str) -> dict[str, str]:
    """从入口出发收齐所有相对 import 的模块。返回 {裸说明符: 已改写的源码}。
    改写只动 import/export 的路径字符串：`'./x.js'` → `'wb:conversion/x.js'`，别的一个字不碰。"""
    out: dict[str, str] = {}

    def walk(p: Path):
        key = _spec(p)
        if key in out:
            return
        if not p.exists():
            raise FileNotFoundError(f"模块不存在：{p}")
        src = p.read_text(encoding="utf-8")
        deps = []

        def sub(m):
            target = (p.parent / m.group(3)).resolve()
            deps.append(target)
            return f"{m.group(1)}{m.group(2)}{_spec(target)}{m.group(2)}"
        src = _IMPORT.sub(sub, src)
        src = _EXPORT_FROM.sub(sub, src)
        out[key] = src
        for d in deps:
            walk(d)

    walk(JS_ROOT / entry)
    return out


def _data_url(src: str) -> str:
    return "data:text/javascript;base64," + base64.b64encode(src.encode("utf-8")).decode("ascii")


def importmap(modules: dict[str, str]) -> str:
    return json.dumps({"imports": {k: _data_url(v) for k, v in modules.items()}}, ensure_ascii=False)


def _json_for_script(obj) -> str:
    """嵌进 <script> 的 JSON：`</` 转义，别让 `</script>` 截断页面。"""
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


SHIM = r"""
(function(){
  var OFF = window.__WB_OFFLINE || {};
  var D = OFF.data || {};
  function norm(u){
    var x = new URL(String(u), 'http://wb.local/');
    var q = [];
    x.searchParams.forEach(function(v, k){ if (v !== '') q.push([k, v]); });
    q.sort(function(a, b){ return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
    return x.pathname + (q.length ? '?' + q.map(function(kv){ return kv[0] + '=' + encodeURIComponent(kv[1]); }).join('&') : '');
  }
  function b64bytes(s){ var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function jsonResp(obj, status){ return new Response(JSON.stringify(obj), {status: status || 200, headers: {'Content-Type': 'application/json; charset=utf-8'}}); }
  window.fetch = function(input, init){
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var key = norm(url);
    var hit = D[key];
    if (hit && method === 'GET') {
      if (hit.t === 'json') return Promise.resolve(jsonResp(hit.b, hit.s || 200));
      if (hit.t === 'bin')  return Promise.resolve(new Response(b64bytes(hit.b), {status: hit.s || 200, headers: {'Content-Type': hit.ct || 'application/octet-stream'}}));
      return Promise.resolve(new Response(hit.b, {status: hit.s || 200, headers: {'Content-Type': hit.ct || 'text/plain; charset=utf-8'}}));
    }
    if (method !== 'GET') return Promise.resolve(jsonResp({ok: false, offline: true, msg: '这是离线快照，这个操作要回工作台里做'}));
    return Promise.resolve(jsonResp({ok: false, offline: true, found: false, dates: [], days: [], msg: '离线快照里没嵌这份数据：' + key, reason: '离线快照里没嵌这份数据（' + key + '）'}));
  };
  window.EventSource = function(){ throw new Error('离线快照里没有实时日志'); };
  document.addEventListener('DOMContentLoaded', function(){
    if (!OFF.banner) return;
    var b = document.createElement('div');
    b.setAttribute('style', 'font:12px/1.6 system-ui,sans-serif;padding:4px 12px;background:#fdf4e3;color:#7a5a12;border-bottom:1px solid #e9d8a8');
    b.textContent = OFF.banner;
    document.body.insertBefore(b, document.body.firstChild);
  });
})();
"""


def page_document(page: str, data: dict, *, banner: str = "", html_attrs: dict | None = None) -> str:
    """一个页面的离线版：原 HTML + importmap + 前置脚本（嵌数据 + fetch 接管）+ 内联入口。"""
    spec = next(p for p in PAGES if p[0] == page)
    _, html_name, entry, _, _ = spec
    html = (STATIC / html_name).read_text(encoding="utf-8")
    modules = collect_modules(entry)
    entry_spec = "wb:" + entry

    # 1. vendor SheetJS 内联（只有转化率页有）
    tag = '<script src="/static/vendor/xlsx.full.min.js"></script>'
    if tag in html:
        html = html.replace(tag, "<script>" + VENDOR_XLSX.read_text(encoding="utf-8").replace("</script", "<\\/script") + "</script>", 1)
    # 2. 入口模块 → importmap + 前置脚本 + 内联 import
    mod_tag = f'<script type="module" src="/static/js/{entry}"></script>'
    if mod_tag not in html:
        raise ValueError(f"{html_name} 里找不到入口 {mod_tag}")
    payload = {"page": page, "data": data, "banner": banner}
    block = (f'<script type="importmap">{importmap(modules)}</script>\n'
             f'<script id="wb-offline-data" type="application/json">{_json_for_script(payload)}</script>\n'
             f'<script>window.__WB_OFFLINE = JSON.parse(document.getElementById("wb-offline-data").textContent);{SHIM}</script>\n'
             f'<script type="module">import "{entry_spec}";</script>')
    html = html.replace(mod_tag, block, 1)
    # 3. <html …> 上的属性（转化率页靠 data-inbox 自动加载报表）
    for k, v in (html_attrs or {}).items():
        html = re.sub(r"<html\b", f'<html {k}="{v}"', html, count=1)
    if "/static/" in html:
        left = sorted(set(re.findall(r"/static/[\w./-]+", html)))
        raise ValueError(f"{html_name} 离线版里还剩 /static/ 引用：{left}")
    return html


# 外壳的样式：抄自 templates/index.html 的设计 token 和图标轨（那份是首页自己的，这里要脱离工作台单独活，只能带一份）
SHELL_CSS = """
:root{--accent:#1664ff;--accent-ink:#0b47b8;--accent-wash:#eaf1ff;--paper:#fafbfd;--surface:#ffffff;--surface-2:#f4f6fa;--line:#e3e8f0;--ink:#12161f;--ink-2:#455065;--ink-3:#7a8699;--r-m:10px;
--ui:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--t:140ms cubic-bezier(.4,0,.2,1)}
@media (prefers-color-scheme:dark){:root{--accent:#5b8dff;--accent-ink:#a8c4ff;--accent-wash:#16213c;--paper:#0e1218;--surface:#161b24;--surface-2:#1d232e;--line:#272f3d;--ink:#e8ecf3;--ink-2:#a3aec1;--ink-3:#727e93}}
:root[data-theme="dark"]{--accent:#5b8dff;--accent-ink:#a8c4ff;--accent-wash:#16213c;--paper:#0e1218;--surface:#161b24;--surface-2:#1d232e;--line:#272f3d;--ink:#e8ecf3;--ink-2:#a3aec1;--ink-3:#727e93}
:root[data-theme="light"]{--accent:#1664ff;--accent-ink:#0b47b8;--accent-wash:#eaf1ff;--paper:#fafbfd;--surface:#ffffff;--surface-2:#f4f6fa;--line:#e3e8f0;--ink:#12161f;--ink-2:#455065;--ink-3:#7a8699}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}[hidden]{display:none !important}html,body{height:100%}
body{font-family:var(--ui);font-size:14px;line-height:1.6;background:var(--paper);color:var(--ink);-webkit-font-smoothing:antialiased;overflow:hidden}
.app{display:flex;height:100vh;overflow:hidden}
.rail{width:56px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;padding:12px 0 10px;gap:4px}
.rail .mark{width:32px;height:32px;border-radius:9px;background:var(--accent);color:#fff;font-weight:800;font-size:15px;margin-bottom:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rail button{width:40px;height:40px;border:0;background:none;cursor:pointer;border-radius:var(--r-m);color:var(--ink-3);font-size:17px;display:flex;align-items:center;justify-content:center;position:relative;transition:background-color var(--t),color var(--t)}
.rail button svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.rail button:hover{background:var(--surface-2);color:var(--ink)}
.rail button[aria-current="true"]{background:var(--accent-wash);color:var(--accent)}
.rail button[aria-current="true"]::before{content:'';position:absolute;left:-8px;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.rail .tip{position:absolute;left:48px;top:50%;transform:translateY(-50%);background:var(--ink);color:var(--paper);font-size:12px;padding:3px 8px;border-radius:6px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity var(--t)}
.rail button:hover .tip{opacity:1}
.rail .spacer{flex:1}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.top{height:44px;flex-shrink:0;display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid var(--line);background:var(--surface);font-size:13px;color:var(--ink-2)}
.top b{color:var(--ink)}.top .mono{font-family:var(--mono)}
.frames{flex:1;position:relative;min-height:0}
.frames iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--paper)}
"""


def shell(pages: dict[str, str], *, date: str, generated_at: str, notes: list[str] | None = None) -> str:
    """外壳：图标轨 + 四个 srcdoc iframe。pages = {page键: 那页的离线 HTML}。"""
    def esc_attr(s: str) -> str:
        return s.replace("&", "&amp;").replace('"', "&quot;")
    btns, frames = [], []
    for i, (key, _, _, label, icon) in enumerate(PAGES):
        if key not in pages:
            continue
        cur = "true" if not btns else "false"
        btns.append(f'<button type="button" data-nav="{key}" aria-current="{cur}" aria-label="{label}">'
                    f'<svg viewBox="0 0 20 20" aria-hidden="true">{icon}</svg><span class="tip">{label}</span></button>')
        frames.append(f'<iframe data-tool="{key}" title="{label}" srcdoc="{esc_attr(pages[key])}"{"" if cur == "true" else " hidden"}></iframe>')
    note = "　".join(notes or [])
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>运营看板 {date}（离线）</title>
<!-- 工作台生成的离线快照：四个页面原样装在这里，数据是生成那一刻的。双击就能看，不用工作台、不用联网。 -->
<style>{SHELL_CSS}</style>
</head>
<body>
<div class="app">
  <nav class="rail" aria-label="主导航">
    <div class="mark" aria-hidden="true">支</div>
    {"".join(btns)}
    <div class="spacer"></div>
    <button type="button" id="themeBtn" aria-label="切换主题"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.6"/><path d="M10 3.4a6.6 6.6 0 000 13.2z" fill="currentColor" stroke="none"/></svg><span class="tip">切换主题</span></button>
  </nav>
  <div class="main">
    <div class="top"><b id="toolTitle">{PAGES[0][3]}</b><span>离线快照 · 业务日期 <span class="mono">{date}</span> · 生成于 <span class="mono">{generated_at}</span></span><span>{note}</span></div>
    <div class="frames">{"".join(frames)}</div>
  </div>
</div>
<script>
(function(){{
  var LABEL = {json.dumps({p[0]: p[3] for p in PAGES}, ensure_ascii=False)};
  var btns = document.querySelectorAll('.rail button[data-nav]');
  var frames = document.querySelectorAll('.frames iframe');
  btns.forEach(function(b){{ b.addEventListener('click', function(){{
    var name = b.dataset.nav;
    btns.forEach(function(x){{ x.setAttribute('aria-current', String(x.dataset.nav === name)); }});
    frames.forEach(function(f){{ f.hidden = f.dataset.tool !== name; }});
    document.getElementById('toolTitle').textContent = LABEL[name] || name;
  }}); }});
  // 主题：外壳和四个 iframe 一起切（页面自己也有按钮，各切各的也行）
  var cur = null;
  try {{ cur = localStorage.getItem('wb_theme'); }} catch (e) {{}}
  function apply(m){{
    var r = document.documentElement;
    if (!m || m === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', m);
    frames.forEach(function(f){{ try {{ var d = f.contentDocument && f.contentDocument.documentElement; if (!d) return; if (!m || m === 'auto') d.removeAttribute('data-theme'); else d.setAttribute('data-theme', m); }} catch (e) {{}} }});
  }}
  apply(cur);
  document.getElementById('themeBtn').addEventListener('click', function(){{
    cur = cur === 'dark' ? 'light' : 'dark';
    try {{ localStorage.setItem('wb_theme', cur); }} catch (e) {{}}
    apply(cur);
  }});
}})();
</script>
</body>
</html>
"""
