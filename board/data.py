# -*- coding: utf-8 -*-
"""board.data —— 工作台 data/ 目录里那几种文件怎么读。**全部吃 data_dir**，不碰任何模块级路径常量。

文件在哪（和工作台一字不差，那边改了这里要跟；tests/offline_board.py 钉着形状）：
  站点台账   data/churn/ledger/<date>.json          {"date","source_date","sites":[行]}
  周台账     data/churn/weekly/<周末日>.json          {"期次","start","end","complete","rows":[行]}
  流失状态   data/churn/state/<date>.json            churn.assess 的输出（sites 是 dict）
  出单台账   data/出单监控结果/出单监控台账_<date>.json  order_monitor.report.save_ledger 的输出
  出单结果   data/出单监控结果/出单监控结果_<date>.json  {"date","counts","audit_counts","merchants"}
  报表存档   data/inbox/conversion/<date>.xlsx        mailbox 存的转化率报表（.xls / .xlsm / .csv 也认）

⚠ 「文件不在」和「文件坏了」是两回事：read() 返回 (obj, err)，坏了的要把原因带出去（坑.md §2.12）。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ARCHIVE_EXT = (".xlsx", ".xls", ".xlsm", ".csv")


def read(p: Path):
    """(obj, err)。不存在 → (None, "")；坏了 → (None, 原因)。"""
    if not p.exists():
        return None, ""
    try:
        return json.loads(p.read_text(encoding="utf-8")), ""
    except (OSError, ValueError) as e:
        return None, f"{p.name} 读不出来：{e}"


def _dates(d: Path, prefix: str = "", suffix: str = ".json") -> list[str]:
    if not d.is_dir():
        return []
    out = []
    for p in d.iterdir():
        if not p.is_file() or p.suffix.lower() != suffix or not p.name.startswith(prefix):
            continue
        stem = p.stem[len(prefix):]
        if _DATE.match(stem):
            out.append(stem)
    return sorted(set(out))


class Data:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir)
        self.ledger = self.root / "churn" / "ledger"
        self.weekly = self.root / "churn" / "weekly"
        self.state_dir = self.root / "churn" / "state"
        self.om = self.root / "出单监控结果"
        self.conv = self.root / "inbox" / "conversion"

    # ---- 站点台账
    def ledger_dates(self) -> list[str]:
        return _dates(self.ledger)

    def ledger_days(self, start: str, end: str) -> tuple[dict, list[str]]:
        """{日期: [站点行]}（只读 [start, end]）+ 坏文件原因。⚠ 坏的那天当**缺**，不当 0。"""
        days, broken = {}, []
        for d in self.ledger_dates():
            if start <= d <= end:
                obj, err = read(self.ledger / f"{d}.json")
                if err:
                    broken.append(err)
                elif isinstance(obj, dict):
                    days[d] = obj.get("sites") or []
        return days, broken

    # ---- 周台账
    def weeks(self) -> list[dict]:
        """全部周（含没走完的），按周末日升序。坏的跳过。"""
        out = []
        for d in _dates(self.weekly):
            obj, _ = read(self.weekly / f"{d}.json")
            if isinstance(obj, dict) and obj.get("end"):
                out.append(obj)
        return out

    # ---- 流失状态
    def state_dates(self) -> list[str]:
        return _dates(self.state_dir)

    def state(self, date: str):
        return read(self.state_dir / f"{date}.json")

    # ---- 出单监控
    def om_ledger_dates(self) -> list[str]:
        return _dates(self.om, "出单监控台账_")

    def om_ledger(self, date: str):
        return read(self.om / f"出单监控台账_{date}.json")

    def om_result(self, date: str):
        return read(self.om / f"出单监控结果_{date}.json")

    def om_result_dates(self) -> list[str]:
        return _dates(self.om, "出单监控结果_")

    # ---- 转化率报表存档
    def archive_dates(self) -> list[str]:
        if not self.conv.is_dir():
            return []
        return sorted({p.stem for p in self.conv.iterdir()
                       if p.is_file() and p.suffix.lower() in ARCHIVE_EXT and _DATE.match(p.stem)})

    def archive(self, date: str) -> Path | None:
        for ext in ARCHIVE_EXT:
            p = self.conv / f"{date}{ext}"
            if p.exists():
                return p
        return None
