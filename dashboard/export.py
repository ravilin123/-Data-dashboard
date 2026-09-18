# -*- coding: utf-8 -*-
"""dashboard.export —— 把某天的日报嵌进页面模板，落成自带数据的单文件 HTML。

文件落在 data/看板/：`看板_<date>.html` 每天一份，`看板.html` 永远是最新那天的副本（给首页 /dashboard 和桌面快捷方式用）。
⚠ 只留最近 keep 份带日期的；`看板.html` 不算在内。
⚠ 补跑更早的一天时**不覆盖** `看板.html`：最新那份得是最新的日期。
⚠ 嵌进去的 JSON 里 `</` 转义成 `<\/`，否则商户名里一个 `</script>` 就把页面截断。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import offline, snapshot
from .source import WorkbenchSource

HERE = Path(__file__).resolve().parent.parent
TEMPLATE = HERE / "static" / "dashboard.html"
OUT_DIR = HERE / "data" / "看板"
EMBED_TAG = '<script id="embedded-report" type="application/json">null</script>'
LATEST_NAME = "看板.html"
_DATED = re.compile(r"^看板_(\d{4}-\d{2}-\d{2})\.html$")


def render(report: dict, template: str) -> str:
    """模板里那一个占位标签换成日报。标签不在或有两个都算模板坏了 —— 抛，不静默出一张空页。"""
    if template.count(EMBED_TAG) != 1:
        raise ValueError(f"模板里 #embedded-report 占位标签要恰好一个，现在 {template.count(EMBED_TAG)} 个")
    payload = json.dumps(report, ensure_ascii=False).replace("</", "<\\/")
    return template.replace(EMBED_TAG, f'<script id="embedded-report" type="application/json">{payload}</script>')


def dated_files(out_dir: Path | None = None) -> list[tuple[str, Path]]:
    d = out_dir or OUT_DIR
    if not d.is_dir():
        return []
    out = []
    for p in d.iterdir():
        m = _DATED.match(p.name)
        if m:
            out.append((m.group(1), p))
    return sorted(out)


def latest_path(out_dir: Path | None = None) -> Path | None:
    p = (out_dir or OUT_DIR) / LATEST_NAME
    return p if p.exists() else None


def export_day(date: str | None = None, *, out_dir: Path | None = None, data_dir: Path | None = None,
               settings: dict | None = None, keep: int = 30, template: Path | None = None) -> dict:
    """生成一天。date 不给 = 数据里最新那天。返回 {ok, date, path, latest, blocks, reason}。"""
    src = WorkbenchSource(data_dir, settings)
    out = out_dir or OUT_DIR
    if not date:
        ds = src.dates()
        if not ds:
            return {"ok": False, "date": None, "path": None, "latest": None, "blocks": [],
                    "reason": f"{src.data} 下一天数据都没有（台账 / 流失状态 / 出单结果都没有）"}
        date = ds[0]
    rep = src.daily(date)
    html = render(rep, (template or TEMPLATE).read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)
    p = out / f"看板_{date}.html"
    p.write_text(html, encoding="utf-8")
    files = dated_files(out)
    newest = files[-1][0] if files else date
    latest = out / LATEST_NAME
    if date >= newest:
        latest.write_text(html, encoding="utf-8")
    for _, old in files[:-keep] if keep > 0 else []:
        old.unlink(missing_ok=True)
    return {"ok": bool(rep.get("ok")), "date": date, "path": str(p), "latest": str(latest) if latest.exists() else None,
            "blocks": [(b["key"], bool(b["ok"])) for b in rep.get("blocks") or []],
            "reason": "" if rep.get("ok") else (rep.get("reason") or "三块都没有这天的数据")}


def export_offline(date: str | None = None, *, out_dir: Path | None = None, get=None, keep: int = 30,
                   now: str | None = None) -> dict:
    """四个页面原样嵌成一张离线单文件（offline.py）。数据从工作台接口抓（snapshot.py）。

    date 不给 = 各页各自最新；给了 = 每页用那一天（没有那天的页面退回它自己的最新，写进 notes）。
    落盘规矩同 export_day：看板_<date>.html + 看板.html（最新日期那份），只留 keep 份。
    """
    from datetime import datetime, timedelta, timezone
    get = get or snapshot.default_getter()
    snap = snapshot.collect(get, date)
    got = [d for d in snap["dates"].values() if d]
    if not got:
        return {"ok": False, "date": None, "path": None, "latest": None, "notes": snap["notes"],
                "reason": "四个页面一个都没有数据（没有报表存档、台账、流失状态、出单结果）"}
    d = date or max(got)
    gen = now or datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    pages = {}
    for key, _, _, label, _ in offline.PAGES:
        used = snap["dates"].get(key)
        banner = f"离线快照 · {label} · 数据日期 {used or '无'} · 生成于 {gen}" + (
            f" · 你要的是 {d}，这一页只有 {used}" if used and d != used else "")
        attrs = {"data-inbox": used} if key == "conversion" and used else None
        pages[key] = offline.page_document(key, snap["pages"][key], banner=banner, html_attrs=attrs)
    html = offline.shell(pages, date=d, generated_at=gen, notes=snap["notes"])
    out = out_dir or OUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    p = out / f"看板_{d}.html"
    p.write_text(html, encoding="utf-8")
    files = dated_files(out)
    newest = files[-1][0] if files else d
    latest = out / LATEST_NAME
    if d >= newest:
        latest.write_text(html, encoding="utf-8")
    for _, old in files[:-keep] if keep > 0 else []:
        old.unlink(missing_ok=True)
    return {"ok": True, "date": d, "path": str(p), "latest": str(latest) if latest.exists() else None,
            "dates": snap["dates"], "notes": snap["notes"], "size": p.stat().st_size, "reason": ""}
