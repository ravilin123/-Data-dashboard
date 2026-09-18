# -*- coding: utf-8 -*-
"""board.export —— 四块算好 → 拼页 → 落盘。

文件落在 out_dir（默认仓库根的 看板/）：`看板_<date>.html` 每天一份，`看板.html` 永远是最新那天的副本。
⚠ 只留最近 keep 份带日期的；`看板.html` 不算在内。
⚠ 补跑更早的一天时**不覆盖** `看板.html`：最新那份得是最新的日期。
⚠ 嵌进去的 JSON 里 `</` 转义成 `<\\/`，否则商户名里一个 `</script>` 就把页面截断。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import blocks as B
from . import bundle as BD
from . import page as PG

OUT_DIR = PG.ROOT / "看板"
LATEST_NAME = "看板.html"
ENTRY = "board/js/main.js"
_DATED = re.compile(r"^看板_(\d{4}-\d{2}-\d{2})\.html$")


def embed_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def dated_files(out_dir: Path) -> list[tuple[str, Path]]:
    if not out_dir.is_dir():
        return []
    out = []
    for p in out_dir.iterdir():
        m = _DATED.match(p.name)
        if m:
            out.append((m.group(1), p))
    return sorted(out)


def export_board(data_dir, *, out_dir: Path | None = None, date: str | None = None, keep: int = 30,
                 node: str = "node", now: str | None = None) -> dict:
    r = B.build_all(data_dir, date, node=node)
    d = r["date"]
    if not d:
        return {"ok": False, "date": None, "path": None, "latest": None, "blocks": r["blocks"],
                "reason": "四块一块都没有数据：" + ("；".join(dict.fromkeys(b["reason"] for b in r["blocks"])) if len({b["reason"] for b in r["blocks"]}) == 1 else "；".join(f"{b['label']}：{b['reason']}" for b in r["blocks"]))}
    gen = now or datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    notes = [f"{b['label']}：{b['reason']}" for b in r["blocks"] if b["reason"]]
    payload = {"date": d, "generated_at": gen, "blocks": r["blocks"]}
    mods = BD.collect_modules(ENTRY)
    html = PG.assemble(data_json=embed_json(payload), importmap=BD.importmap(mods), date=d, generated_at=gen, notes=notes)
    out = Path(out_dir) if out_dir else OUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    p = out / f"看板_{d}.html"
    p.write_text(html, encoding="utf-8")
    files = dated_files(out)
    newest = files[-1][0] if files else d
    latest = out / LATEST_NAME
    if d >= newest:
        latest.write_text(html, encoding="utf-8")
    for _, old in files[:-keep] if keep > 0 else []:
        try:
            old.unlink()
        except OSError:
            pass
    return {"ok": True, "date": d, "path": str(p), "latest": str(latest) if latest.exists() else None,
            "size": len(html.encode("utf-8")), "notes": notes,
            "blocks": [(b["key"], b["ok"], b["date"]) for b in r["blocks"]], "reason": ""}
