# -*- coding: utf-8 -*-
"""board.bundle —— 页面的 ES 模块不打包、不改语义：每个模块变成一个 data: URL，用 `<script type="importmap">`
把裸说明符 `wb:<仓库内路径>` 映射过去。相对 import 只改路径字符串，别的一个字不碰 ——
live binding、模块级状态（conversion/config.js 的 PERIOD、store.js 的 state）都还是那一份。
（iframe 版离线看板在 Chromium 上验过这条路，file:// 也能开。）

⚠ 入口出发收齐相对 import；漏了的模块在页面上是「整块不出且报错在控制台」，tests/offline_board.py 钉着
  四块的口径模块都在、而且**没**把顶层绑 DOM / 会 fetch 的模块（baseline / feishu / main / render/index）拖进来。
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_IMPORT = re.compile(r"""(\bimport\s*(?:[^'"]*?)\s*from\s*|\bimport\s*)(['"])(\.{1,2}/[^'"]+)\2""")
_EXPORT_FROM = re.compile(r"""(\bexport\s*\{[^}]*\}\s*from\s*)(['"])(\.{1,2}/[^'"]+)\2""")


def spec(p: Path) -> str:
    return "wb:" + p.resolve().relative_to(ROOT.resolve()).as_posix()


def collect_modules(entry: str) -> dict[str, str]:
    """从入口（仓库内相对路径）出发收齐所有相对 import 的模块。返回 {裸说明符: 已改写的源码}。"""
    out: dict[str, str] = {}

    def walk(p: Path):
        key = spec(p)
        if key in out:
            return
        if not p.exists():
            raise FileNotFoundError(f"模块不存在：{p}（同步来的 static/js 里没有它？先 python scripts/同步口径.py）")
        src = p.read_text(encoding="utf-8")
        deps = []

        def sub(m):
            target = (p.parent / m.group(3)).resolve()
            deps.append(target)
            return f"{m.group(1)}{m.group(2)}{spec(target)}{m.group(2)}"
        src = _IMPORT.sub(sub, src)
        src = _EXPORT_FROM.sub(sub, src)
        out[key] = src
        for d in deps:
            walk(d)

    walk(ROOT / entry)
    return out


def _data_url(src: str) -> str:
    return "data:text/javascript;base64," + base64.b64encode(src.encode("utf-8")).decode("ascii")


def importmap(modules: dict[str, str]) -> str:
    return json.dumps({"imports": {k: _data_url(v) for k, v in modules.items()}}, ensure_ascii=False)
