# -*- coding: utf-8 -*-
"""
生成看板.py - 独立单文件看板：只读工作台的 data\\ 目录，落一张双击就能开、能直接发人的 HTML。

    python 生成看板.py --data D:\\跨境支付运营工作台\\data
    python 生成看板.py                      # --data 不给就读 config.json 的 dashboard.workbench_data_dir
    python 生成看板.py --date 2026-09-17    # 指定业务日期（没有那天的块退回它自己最新的，并写明）
    python 生成看板.py --out D:\\同步盘\\看板  # 落到别处（默认仓库里的 看板\\）

四块：交易概览 → 商户流失 → 出单监控 → 转化率。转化率那块要 Node（口径只有 JS 版），没有就那一块写明原因、其余照常。
产物：看板_<日期>.html（每天一份，留最近 30 份）+ 看板.html（永远最新那天）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# Windows 上 stdout 是 GBK·strict，一个 emoji 就炸（坑.md §2.21.2）
for s in (sys.stdout, sys.stderr):
    try:
        s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from board import export as X  # noqa: E402


def _configured_data_dir() -> str:
    """config.json → dashboard.workbench_data_dir（和 server/ 同一个键）。"""
    for name in ("config.json", "config.example.json"):
        p = ROOT / name
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        d = ((cfg.get("dashboard") or {}).get("workbench_data_dir") or "").strip()
        if d:
            return d
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(description="生成独立单文件看板")
    ap.add_argument("--data", default=None, help="工作台的 data 目录（不给就读 config.json 的 dashboard.workbench_data_dir）")
    ap.add_argument("--out", default=None, help="输出目录，默认仓库里的 看板/")
    ap.add_argument("--date", default=None, help="业务日期 YYYY-MM-DD，不给 = 各块各自最新")
    ap.add_argument("--node", default="node", help="node 可执行文件，默认 PATH 里的 node")
    ap.add_argument("--keep", type=int, default=30, help="留最近几份带日期的文件，默认 30")
    a = ap.parse_args()
    data = a.data or _configured_data_dir()
    if not data:
        print("没给 --data，config.json 里 dashboard.workbench_data_dir 也是空的。\n"
              "    python 生成看板.py --data D:\\跨境支付运营工作台\\data")
        return 2
    r = X.export_board(data, out_dir=Path(a.out) if a.out else None, date=a.date, keep=a.keep, node=a.node)
    if not r["ok"]:
        print("没生成：" + r["reason"])
        return 1
    print(f"已生成 {r['path']}（{r['size'] // 1024} KB）")
    for key, ok, d in r["blocks"]:
        print(f"  {X.B.LABEL[key]}: {'有数 · ' + d if ok else '没有数据'}")
    for n in r["notes"]:
        print("  ⚠ " + n)
    if r["latest"]:
        print(f"最新副本 {r['latest']} —— 双击就能看，直接发人也行")
    return 0


if __name__ == "__main__":
    sys.exit(main())
