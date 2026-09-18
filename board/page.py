# -*- coding: utf-8 -*-
"""board.page —— 把四块拼成一张页：模板 + 自己的 CSS + 转化率面板（从同步来的 static/conversion.html 抽）+ 数据 + importmap。

CSS 隔离：转化率那两个面板带着工作台转化率页的整套样式（.card / .kpi / .hint …），看板自己那三块也有同名的类，
两边**都加前缀**（`#blk-conversion …` / `.own …`）互不串。`:root` 那些 token 规则不加（两边 token 同一套，值一样），
`body` / `html` 丢掉（模板自己定），`*{box-sizing}` 保留。@media 里面的规则同样处理。

⚠ 面板按 conversion.html 里的 `<!-- ========== 面板：xx ========== -->` 注释切：标记没了要**抛**，不静默抽个空的
  （工作台改了那页的结构，这里要红，tests/offline_board.py 钉着）。
"""
from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TEMPLATE = HERE / "模板.html"
CONVERSION_HTML = ROOT / "static" / "conversion.html"

_COMMENT = re.compile(r"/\*.*?\*/", re.S)


# ---------------------------------------------------------------- CSS 加前缀
def _split_selectors(sel: str) -> list[str]:
    """按顶层逗号切（括号里的逗号不算：`:is(a, b)`）。"""
    out, depth, cur = [], 0, []
    for ch in sel:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        out.append("".join(cur).strip())
    return out


def _prefix_one(sel: str, prefix: str) -> str | None:
    """一条选择器加前缀。None = 这条整个丢掉。"""
    s = sel.strip()
    if not s:
        return None
    head = re.split(r"\s", s, 1)
    first = head[0]
    if first.startswith(":root") or first.startswith("html"):
        if len(head) == 1:
            return s                                   # `:root{…}` / `:root[data-theme]{…}`：token，原样
        return f"{first} {prefix} {head[1].strip()}"   # `:root[data-theme=dark] .x{…}`：主题条件 + 前缀 + 后代
    if first == "body" or first.startswith("body."):
        return None
    if s == "*":
        return s
    return f"{prefix} {s}"


def _rules(css: str):
    """顶层切成 (选择器/at 规则头, 体) 一对对。体不含最外层花括号。"""
    i, n = 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j < 0:
            break
        head = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
            k += 1
        yield head, css[j + 1:k - 1]
        i = k


def scope_css(css: str, prefix: str) -> str:
    out = []
    for head, body in _rules(_COMMENT.sub("", css)):
        if not head:
            continue
        if head.startswith("@"):
            if head.startswith(("@media", "@supports", "@container", "@scope", "@layer")):
                out.append(f"{head}{{ {scope_css(body, prefix)} }}")
            else:                                      # @keyframes / @font-face / @import：原样
                out.append(f"{head}{{{body}}}")
            continue
        sels = [x for x in (_prefix_one(s, prefix) for s in _split_selectors(head)) if x]
        if sels:
            out.append(f"{','.join(sels)}{{{body.strip()}}}")
    return "\n".join(out)


# ---------------------------------------------------------------- 从 conversion.html 抽
_MARK = "<!-- ========== 面板：{} ========== -->"


def extract_style(html: str) -> str:
    m = re.search(r"<style>(.*?)</style>", html, re.S)
    if not m:
        raise ValueError("static/conversion.html 里没有 <style> 块")
    return m.group(1)


def _panel(html: str, name: str, next_name: str, pid: str) -> str:
    a, b = _MARK.format(name), _MARK.format(next_name)
    i, j = html.find(a), html.find(b)
    if i < 0 or j < 0 or j <= i:
        raise ValueError(f"static/conversion.html 里找不到「面板：{name}」到「面板：{next_name}」的标记 —— 工作台改了那页的结构，看板这里要跟")
    seg = html[i + len(a):j]
    k = seg.find(f'id="{pid}"')
    if k < 0:
        raise ValueError(f"「面板：{name}」那段里没有 id=\"{pid}\"")
    start = seg.rfind("<div", 0, k)
    seg = seg[start:].rstrip()
    seg = re.sub(rf'(<div class="panel" id="{pid}")\s+hidden(\s*>)', r"\1\2", seg, count=1)
    return seg


def extract_panels(html: str) -> tuple[str, str]:
    """(概览面板, 异常明细面板)，hidden 去掉。"""
    return _panel(html, "概览", "异常明细", "p-overview"), _panel(html, "异常明细", "播报素材", "p-detail")


# ---------------------------------------------------------------- 拼页
def assemble(*, data_json: str, importmap: str, date: str, generated_at: str, notes: list[str],
             template: str | None = None, conversion_html: str | None = None) -> str:
    tpl = template if template is not None else TEMPLATE.read_text(encoding="utf-8")
    conv = conversion_html if conversion_html is not None else CONVERSION_HTML.read_text(encoding="utf-8")
    ov, de = extract_panels(conv)
    css_conv = scope_css(extract_style(conv), "#blk-conversion")
    own_i, own_j = tpl.index("/*@OWN_CSS_START@*/"), tpl.index("/*@OWN_CSS_END@*/")
    own_css = scope_css(tpl[own_i + len("/*@OWN_CSS_START@*/"):own_j], ".own")
    tpl = tpl[:own_i] + own_css + tpl[own_j + len("/*@OWN_CSS_END@*/"):]
    reps = {
        "<!--@CSS_CONVERSION@-->": css_conv,
        "<!--@PANEL_OVERVIEW@-->": ov,
        "<!--@PANEL_DETAIL@-->": de,
        "<!--@DATA@-->": data_json,
        "<!--@IMPORTMAP@-->": importmap,
        "@DATE@": date,
        "@GENERATED_AT@": generated_at,
        "<!--@NOTES@-->": "".join(f"<li>{_esc(n)}</li>" for n in notes),
    }
    for k, v in reps.items():
        if k not in tpl:
            raise ValueError(f"模板里没有占位 {k}")
        tpl = tpl.replace(k, v)
    return tpl


def _esc(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
