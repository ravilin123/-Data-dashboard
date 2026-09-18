# -*- coding: utf-8 -*-
"""dashboard.export —— 把契约日报嵌进 static/dashboard.html 那张页（看板仓库的服务用它导出）。

只剩 `render`：落盘、按天留份那些原来在这儿的东西随 iframe 版离线看板一起删了（2026-09-18 第三次调整）——
独立单文件看板在看板仓库 `-Data-dashboard` 的 `生成看板.py`，不在工作台。
⚠ 嵌进去的 JSON 里 `</` 转义成 `<\/`，否则商户名里一个 `</script>` 就把页面截断。
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
TEMPLATE = HERE / "static" / "dashboard.html"
EMBED_TAG = '<script id="embedded-report" type="application/json">null</script>'


def render(report: dict, template: str) -> str:
    """模板里那一个占位标签换成日报。标签不在或有两个都算模板坏了 —— 抛，不静默出一张空页。"""
    if template.count(EMBED_TAG) != 1:
        raise ValueError(f"模板里 #embedded-report 占位标签要恰好一个，现在 {template.count(EMBED_TAG)} 个")
    payload = json.dumps(report, ensure_ascii=False).replace("</", "<\\/")
    return template.replace(EMBED_TAG, f'<script id="embedded-report" type="application/json">{payload}</script>')
