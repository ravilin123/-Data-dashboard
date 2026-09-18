# -*- coding: utf-8 -*-
"""churn.ledger —— 每天一份、永不清理的站点台账。

报表本身没有任何日期列（没有开通时间、没有最近一笔），「一个站点沉默了几天」
只能靠每天一份日报叠出来。所以：

  data/churn/ledger/<日期>.json    站点台账：那天每个「用户ID + 站点」的金额、笔数、直签人…
  data/churn/gateway/<日期>.json   网关台账：那天每个「网关 × 用户ID」的金额、笔数
  data/churn/weekly/<周末日>.json  周台账：**报表自带的周报行**原样留着（第 08 张票）
  data/churn/ingested.json         哪些报表文件已经灌过（按种类 + 业务日期 + 大小 + 修改时间）

三条规矩：
  ⚠ **永不清理。** mailbox.purge 只碰 data/inbox/<kind>/，这里不在它眼里；用例 [5] 钉着。
    「沉默 30 天」要 30 天历史，「30 天滚动 TPV」再要 30 天，存档 30 天就清的话永远算不了。
  ⚠ **后来的文件盖住同一天，先来的盖不掉后来的。** 每份报表带 7 天日报窗口，同一天会出现在
    7 份文件里；实测不同文件里同一天金额不一致的只有 0.07%，「业务日期更晚的那份为准」
    是安全的，而且和文件灌进来的先后无关（补灌老文件不会把新数据盖掉）。
  ⚠ **多站点不合并。** 一家商户同一天可以有 7 行（7 个站点），台账原样留 7 行；
    tpv-sync 按（期, 用户ID）去重就少了 5.2% 的 TPV。

⚠ **周报行要单独留一本，不能从日报加出来**（第 08 张票踩过）：报表里的「周」是
  **周五 → 周四**（`2026 W37 (2026-09-04~2026-09-10)`，09-04 是周五），不是周一到周日。
  老板的周摘要头条要「和报表流失率同口径」，自己按 ISO 周加一遍的话数对不上，
  而且**不报错** —— 谁也不会发现。所以周报行原样进 `data/churn/weekly/`，边界从期次标签里读。
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timedelta
from pathlib import Path


from . import adapters as ad

HERE = Path(__file__).resolve().parent.parent
LEDGER_DIR = HERE / "data" / "churn" / "ledger"
GATEWAY_DIR = HERE / "data" / "churn" / "gateway"
WEEKLY_DIR = HERE / "data" / "churn" / "weekly"
STATE_PATH = HERE / "data" / "churn" / "ingested.json"

# 邮箱里的报表种类 → 落到哪本台账、用哪个读法、行里的列表叫什么
KINDS = {
    # weekly：这份报表**自带周报行**，单独留一本（第 08 张票；周界是周五→周四，算不回来）
    "flypay_tpv": {"ledger": "sites", "reader": ad.read_flypay, "list_key": "sites", "weekly": True},
    "gateway_tpv": {"ledger": "gateway", "reader": ad.read_gateway, "list_key": "rows"},
}
LEDGER_LABEL = {"sites": "站点台账", "gateway": "网关台账", "weekly": "周台账"}

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# 「2026 W37 (2026-09-04~2026-09-10)」里的那对日期。半角全角括号、~ 和 ～ 都认。
_WEEK = re.compile(r"(\d{4}-\d{2}-\d{2})\s*[~～-]\s*(\d{4}-\d{2}-\d{2})")

def _dir(ledger: str) -> Path:
    """⚠ **每次现读模块全局**，别在 import 时固化成一张表：用例把 `LEDGER_DIR` 指到临时目录上，
    固化了的话它改的是另一个对象，测试会去读真实的 data/ —— 而且看着像是路径不存在。"""
    return {"gateway": GATEWAY_DIR, "weekly": WEEKLY_DIR}.get(ledger, LEDGER_DIR)


def _sort_key(row: dict):
    return (row.get("用户ID", ""), row.get("站点", ""), row.get("网关", ""))


# ---------------------------------------------------------------- 纯函数：拆、并

def split_daily(rows: list[dict]) -> dict[str, list[dict]]:
    """只留日报，按统计周期分组。周报 / 月报 / 季报不进台账 —— 它们从日报能算回来。"""
    out: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("报表类型") != "日报":
            continue
        d = r.get("统计周期") or ""
        if not _DATE.match(d):
            continue
        out.setdefault(d, []).append({k: v for k, v in r.items() if k not in ("报表类型", "统计周期")})
    return out


def week_range(label: str) -> tuple:
    """「2026 W37 (2026-09-04~2026-09-10)」→ ("2026-09-04", "2026-09-10")。认不出 → (None, None)。

    ⚠ **别自己按星期几算。** 报表的周是**周五→周四**，边界只能从标签里读；
      按 ISO 周（周一→周日）加出来的数和报表对不上，而且不报错。
    """
    m = _WEEK.search(str(label or ""))
    return (m.group(1), m.group(2)) if m else (None, None)


def split_weekly(rows: list[dict]) -> dict[str, dict]:
    """只留周报，按**周末日**分组（期次标签里带着起止，文件名用末日才排得了序）。

    认不出起止的期次整条跳过 —— 键错了的话周摘要会拿两个不相干的周去比。
    """
    out: dict[str, dict] = {}
    for r in rows:
        if r.get("报表类型") != "周报":
            continue
        label = r.get("统计周期") or ""
        start, end = week_range(label)
        if not end:
            continue
        b = out.setdefault(end, {"期次": label, "start": start, "end": end, "rows": []})
        b["rows"].append({k: v for k, v in r.items() if k not in ("报表类型", "统计周期")})
    return out


def merge_week(existing: dict | None, week: dict, source_date: str) -> dict:
    """把一份报表里「这一周」的行并进周台账。规矩同 merge_day：业务日期更晚的整个盖住。

    `complete`：报表业务日期**过了周末日**才算这一周走完了。周中那份报表里的 W37 行
    只统计到当天 —— 拿它当完整周去算流失，数会偏小而且不报错（同第 10 张票「周期走完判断」）。
    """
    if existing and (existing.get("source_date") or "") > source_date:
        return existing
    return {"期次": week["期次"], "start": week["start"], "end": week["end"],
            "source_date": source_date, "complete": source_date >= week["end"],
            "rows": sorted(week["rows"], key=_sort_key)}


def merge_day(existing: dict | None, date: str, rows: list[dict], source_date: str,
              list_key: str = "sites") -> dict:
    """把一份报表里「这一天」的行并进台账的这一天。

    业务日期更晚的报表整个盖住这一天；更早的盖不掉；同一份再来一遍结果相同。
    行按（用户ID, 站点, 网关）排好序 —— 写出来的文件才能逐字节比对。
    """
    if existing and (existing.get("source_date") or "") > source_date:
        return existing
    return {"date": date, "source_date": source_date,
            list_key: sorted(rows, key=_sort_key)}


# ---------------------------------------------------------------- 文件

def _read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(p: Path, obj) -> None:
    """原子写。临时文件名带随机段：收信线程、页面上的「叠加」、命令行的 seed 可能同时写同一天，
    固定的 .tmp 名会互相踩（一个刚 rename 掉，另一个的 replace 就找不到文件）。

    文件按键名排序写出来，才能逐字节比对「再灌一遍没变」；这和 Flask 的 sort_keys 不是一回事 ——
    读回来的是 dict，谁也不该依赖文件里的键序。
    """
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=p.name + ".", suffix=".tmp", dir=p.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True))
        os.replace(tmp, p)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def dates(ledger: str = "sites") -> list[str]:
    d = _dir(ledger)
    if not d.is_dir():
        return []
    return sorted(p.stem for p in d.iterdir() if p.is_file() and p.suffix == ".json" and _DATE.match(p.stem))


def read_day(date: str, ledger: str = "sites") -> dict | None:
    return _read_json(_dir(ledger) / f"{date}.json")


def ingest_rows(rows: list[dict], source_date: str, kind: str) -> dict:
    """把一份报表的公共字段行灌进台账。返回写了哪些天、哪些天因为已有更新的文件而保留。"""
    spec = KINDS[kind]
    ledger, key = spec["ledger"], spec["list_key"]
    written, kept = [], []
    for day, day_rows in sorted(split_daily(rows).items()):
        p = _dir(ledger) / f"{day}.json"
        before = _read_json(p)
        after = merge_day(before, day, day_rows, source_date, list_key=key)
        if after is before:
            kept.append(day)
            continue
        if after != before:
            _write_json(p, after)
        written.append(day)
    out = {"written": written, "kept": kept}
    if spec.get("weekly"):
        out["weeks"] = _ingest_weeks(rows, source_date)
    return out


def _ingest_weeks(rows: list[dict], source_date: str) -> list[str]:
    """周报行进周台账。返回写了哪几周（按周末日）。"""
    done = []
    for end, week in sorted(split_weekly(rows).items()):
        p = _dir("weekly") / f"{end}.json"
        before = _read_json(p)
        after = merge_week(before, week, source_date)
        if after is before:
            continue
        if after != before:
            _write_json(p, after)
        done.append(end)
    return done


def weeks(complete_only: bool = True) -> list[dict]:
    """周台账里的那些周，按周末日升序。`complete_only` 挡掉没走完的那一周。"""
    out = []
    for d in dates("weekly"):
        w = read_day(d, "weekly")
        if w and (w.get("complete") or not complete_only):
            out.append(w)
    return out


def _load_state() -> dict:
    return _read_json(STATE_PATH) or {}


# 灌入口径的版本。**加一本新台账、或者改了从报表里取什么，就把它 +1** ——
# 不加的话已经灌过的文件永远被跳过，新那本台账在老机器上一直是空的，
# 而报出来的话是「周台账里只有 0 个走完的周」，读着像「你还没灌数」，
# 于是人去重灌一遍 —— 再被跳过一次。第 08 张票加周台账时踩的。
INGEST_VERSION = 2


def _stamp(p: Path) -> dict:
    st = p.stat()
    return {"file": p.name, "size": st.st_size, "mtime": int(st.st_mtime), "v": INGEST_VERSION}


def _already(state: dict, kind: str, source_date: str, p: Path) -> bool:
    rec = state.get(f"{kind}|{source_date}")
    if not rec:
        return False
    s = _stamp(p)
    return (rec.get("size") == s["size"] and rec.get("mtime") == s["mtime"]
            and rec.get("v") == INGEST_VERSION)


def ingest_file(path, kind: str, source_date: str) -> dict:
    """读一份报表文件并灌进台账；登记它，下次同一份不再灌。读不到时 reason 带回去。"""
    p = Path(path)
    spec = KINDS[kind]
    res = spec["reader"](p)
    if res.reason:
        return {"written": [], "kept": [], "reason": res.reason}
    r = ingest_rows(res.rows, source_date, kind)
    if res.warnings:
        r["warnings"] = list(res.warnings)
    state = _load_state()
    state[f"{kind}|{source_date}"] = {**_stamp(p), "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                                      "written": len(r["written"])}
    _write_json(STATE_PATH, state)
    return r


# ---------------------------------------------------------------- 覆盖

def _coverage_of(ledger: str) -> dict:
    ds = dates(ledger)
    if not ds:
        return {"label": LEDGER_LABEL[ledger], "first": None, "last": None, "days": 0, "missing": []}
    first, last = ds[0], ds[-1]
    cur = datetime.strptime(first, "%Y-%m-%d")
    end = datetime.strptime(last, "%Y-%m-%d")
    have = set(ds)
    missing = []
    while cur <= end:
        s = cur.strftime("%Y-%m-%d")
        if s not in have:
            missing.append(s)
        cur += timedelta(days=1)
    return {"label": LEDGER_LABEL[ledger], "first": first, "last": last, "days": len(ds), "missing": missing}


def coverage() -> dict:
    """现在台账覆盖到哪：起止、天数、缺的日期。两本台账分开报。"""
    ws = weeks(complete_only=False)
    return {"ok": True, "sites": _coverage_of("sites"), "gateway": _coverage_of("gateway"),
            "weekly": {"label": LEDGER_LABEL["weekly"], "weeks": len(ws),
                       "complete": sum(1 for w in ws if w.get("complete")),
                       "first": ws[0]["期次"] if ws else None, "last": ws[-1]["期次"] if ws else None}}


# ---------------------------------------------------------------- 批量：灌目录、同步存档

def _ingest_listed(items: list[tuple[str, str, Path]]) -> dict:
    """items = [(kind, 业务日期, 路径)]。按业务日期从早到晚灌，登记过且没变的跳过。"""
    state = _load_state()
    out = {"ingested": [], "already": [], "errors": []}
    for kind, day, p in sorted(items, key=lambda x: (x[1], x[0])):
        if _already(state, kind, day, p):
            out["already"].append({"file": p.name, "kind": kind, "date": day})
            continue
        r = ingest_file(p, kind, day)
        if r.get("reason"):
            out["errors"].append({"file": p.name, "kind": kind, "date": day, "reason": r["reason"]})
            continue
        item = {"file": p.name, "kind": kind, "date": day,
                "written": len(r["written"]), "kept": len(r["kept"])}
        if r.get("warnings"):
            item["warnings"] = r["warnings"]
        out["ingested"].append(item)
    return out


def seed_dir(directory) -> dict:
    """把一个目录里的报表全灌进来。文件名当主题，用邮箱那套规则认种类和业务日期。

    上线时拿 tpv-sync 攒下的 attachments/ 目录跑一次，46 天历史就有了。
    认不出种类（例会纪要之类）或不是这两种报表的，进 skipped。
    """
    import mailbox as mb   # 口径层只有这两个函数碰邮箱那套，收在函数内：看板仓库同步这份文件时没有 mailbox.py

    root = Path(directory)
    if not root.is_dir():
        return {"ingested": [], "already": [], "errors": [f"不是目录：{root}"], "skipped": []}
    cfg = mb.load_config()
    items, skipped = [], []
    for p in sorted(root.iterdir()):
        if not p.is_file() or p.suffix.lower() not in mb.ALLOWED_EXT:
            continue
        try:
            hit = mb.match(mb.Message(uid=f"seed:{p.name}", subject=p.stem, received_at=0), cfg)
        except mb.MailboxError:
            hit = None
        if not hit or hit[0] not in KINDS:
            skipped.append(p.name)
            continue
        items.append((hit[0], hit[1], p))
    out = _ingest_listed(items)
    out["skipped"] = skipped
    return out


def sync_from_archive() -> dict:
    """邮箱存档里新到的两种报表灌进台账。幂等：登记过且文件没变的不再灌。"""
    import mailbox as mb   # 同 seed_dir

    items = []
    for kind in KINDS:
        for day in mb.archived_dates(kind):
            p = mb.find_archived(kind, day)
            if p:
                items.append((kind, day, p))
    return _ingest_listed(items)
