# -*- coding: utf-8 -*-
"""server.config —— config.json 里 `dashboard` 那一段的读法和口令名单的写回。

⚠ 数字走 `_int`：`.get(k, 默认)` 挡不住 `null`，`or 默认` 会吃掉有意义的 0（坑.md §2.18.98）。
⚠ 写回只动 `dashboard.viewers` 一个键，别的段原样；写之前把原文件复制成 .bak（在 .gitignore 里）。
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
EXAMPLE_PATH = ROOT / "config.example.json"

DEFAULTS = {
    # ⚠ 不是 5060：Chrome 把 5060 / 5061（SIP）列为 unsafe port，页面直接 ERR_UNSAFE_PORT（坑-看板.md §D1）
    "listen": "127.0.0.1:5070",
    "workbench_data_dir": "",       # 空 = ROOT/data
    "viewers": [],                  # [{"name","passcode","enabled"}]
    "company_api": {"base_url": "", "token": "", "timeout": 20},
    "week_anchor": 4,               # 周从周几起：4 = 周五（报表），6 = 周日（公司看板）
    "hits_top_n": 20,               # 流失命中名单列前几条（截断会自报）
    "top_n": 10,                    # Top 商户
    "series_days": 30,              # 趋势画几天
}


def _int(v, default: int) -> int:
    try:
        return int(v) if v is not None and v != "" else default
    except (TypeError, ValueError):
        return default


def _read(path: Path) -> dict | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else None
    except (OSError, ValueError):
        return None


def normalize(section: dict | None, source: str = "") -> dict:
    """`dashboard` 段 → 补齐默认值、数字规整。不认识的键原样留着。"""
    s = dict(DEFAULTS)
    s.update({k: v for k, v in (section or {}).items() if not k.startswith("_comment")})
    s["listen"] = str(s.get("listen") or DEFAULTS["listen"])
    s["workbench_data_dir"] = str(s.get("workbench_data_dir") or "")
    ca = dict(DEFAULTS["company_api"])
    ca.update({k: v for k, v in (s.get("company_api") or {}).items() if not k.startswith("_comment")})
    ca["timeout"] = _int(ca.get("timeout"), 20)
    s["company_api"] = ca
    for k in ("week_anchor", "hits_top_n", "top_n", "series_days"):
        s[k] = _int(s.get(k), DEFAULTS[k])
    vs = []
    for v in s.get("viewers") or []:
        if not isinstance(v, dict):
            continue
        name = str(v.get("name") or "").strip()
        pc = str(v.get("passcode") or "")
        if name and pc:
            vs.append({"name": name, "passcode": pc, "enabled": bool(v.get("enabled", True))})
    s["viewers"] = vs
    s["_source"] = source
    return s


def load(path: Path | None = None) -> dict:
    """读 config.json（没有就 example，再没有就全默认）。返回的是规整后的 dashboard 段。"""
    for p in ((path or CONFIG_PATH), EXAMPLE_PATH):
        raw = _read(p)
        if raw is not None:
            return normalize(raw.get("dashboard"), str(p))
    return normalize({}, "")


def listen(cfg: dict) -> tuple[str, int]:
    host, _, port = (cfg.get("listen") or DEFAULTS["listen"]).rpartition(":")
    return (host or "127.0.0.1"), _int(port, 5070)


def data_dir(cfg: dict) -> Path:
    d = cfg.get("workbench_data_dir") or ""
    return Path(d).expanduser() if d else ROOT / "data"


def save_viewers(viewers: list[dict], path: Path | None = None) -> None:
    """只写回 dashboard.viewers。原子写（临时文件 + replace），先留 .bak。"""
    p = path or CONFIG_PATH
    raw = _read(p) or {}
    raw.setdefault("dashboard", {})
    raw["dashboard"]["viewers"] = [{"name": v["name"], "passcode": v["passcode"], "enabled": bool(v.get("enabled", True))}
                                   for v in viewers]
    if p.exists():
        shutil.copy2(p, p.with_suffix(p.suffix + ".bak"))
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".config_", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(raw, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, p)
