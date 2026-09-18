# -*- coding: utf-8 -*-
"""python -m dashboard [--date YYYY-MM-DD] [--out 目录]"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import stdio_utf8
    stdio_utf8.apply()
except ModuleNotFoundError:
    pass

from . import export as X


def main() -> int:
    ap = argparse.ArgumentParser(description="生成离线看板（自带数据的单文件 HTML）")
    ap.add_argument("--date", default=None, help="业务日期，不给 = 最新那天")
    ap.add_argument("--out", default=None, help="输出目录，默认 data/看板")
    a = ap.parse_args()
    r = X.export_day(a.date, out_dir=Path(a.out) if a.out else None)
    if not r["path"]:
        print("没生成：" + r["reason"])
        return 1
    print(f"已生成 {r['path']}" + ("" if r["ok"] else f"（三块都没数：{r['reason']}）"))
    for k, ok in r["blocks"]:
        print(f"  {k}: {'有数' if ok else '没有'}")
    if r["latest"]:
        print(f"最新副本 {r['latest']} —— 双击就能离线看")
    return 0 if r["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
