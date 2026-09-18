# -*- coding: utf-8 -*-
"""server.report —— 日报的形状只在这里拼（契约 v1，docs/specs/看板/契约.md）。

顺序全走数组；算不出来给 None 不给 0；截断要自报。数据源只管调这几个函数，不自己拼 dict。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

SCHEMA = 1
TZ = timezone(timedelta(hours=8))
FMTS = ("money", "int", "pct", "text", "date", "days")


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def kpi(key: str, label: str, value, fmt: str, *, unit: str = "", dod=None, prev=None, note: str = "") -> dict:
    assert fmt in FMTS, fmt
    return {"key": key, "label": label, "value": value, "unit": unit, "fmt": fmt, "dod": dod, "prev": prev, "note": note}


def column(key: str, label: str, fmt: str = "text") -> dict:
    assert fmt in FMTS, fmt
    return {"key": key, "label": label, "fmt": fmt}


def section(key: str, label: str, columns: list, rows: list, *, note: str = "", limit: int | None = None) -> dict:
    """`limit` 给了就截断，并自报 shown / total（§2.16.5）。"""
    rows = list(rows)
    trunc = None
    if limit is not None and len(rows) > limit:
        trunc = {"shown": limit, "total": len(rows)}
        rows = rows[:limit]
    return {"key": key, "label": label, "note": note, "columns": list(columns), "rows": rows, "truncated": trunc}


def series(key: str, label: str, points: list, fmt: str, *, unit: str = "") -> dict:
    assert fmt in FMTS, fmt
    return {"key": key, "label": label, "unit": unit, "fmt": fmt, "points": [{"x": x, "y": y} for x, y in points]}


def block(key: str, label: str, date, ok: bool, *, reason: str = "", kpis=(), sections=(), series_=()) -> dict:
    return {"key": key, "label": label, "date": date, "ok": bool(ok), "reason": reason,
            "kpis": list(kpis), "sections": list(sections), "series": list(series_)}


def missing(key: str, label: str, reason: str) -> dict:
    """这一块这天没有：ok:false + 原因，三个数组空。**不是 0。**"""
    return block(key, label, None, False, reason=reason)


def report(date: str, source_key: str, source_label: str, blocks: list, *, reason: str = "",
           asof=None, progress=None, generated_at: str | None = None) -> dict:
    ok = any(b.get("ok") for b in blocks)
    return {"ok": ok, "schema": SCHEMA, "date": date, "generated_at": generated_at or now_iso(),
            "source": {"key": source_key, "label": source_label},
            "asof": asof, "progress": progress,
            "reason": reason or ("" if ok else "三块都没有这天的数据"),
            "blocks": list(blocks)}


def dod(cur, prev):
    if cur is None or not prev:
        return None
    return round(cur / prev - 1, 6)
