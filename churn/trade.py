# -*- coding: utf-8 -*-
"""churn.trade —— 交易概览页的算数（第 15 张票）：日 / 周 / 月三档 + 构成 + 排名 + 下钻。

⚠ **口径层复用 `churn.overview`，不写第二份**（票面点名的）：`group_by` / `top_merchants` /
  `owner_label` 都是那边的，这里只多做一件事 —— **把日台账按周期分桶**。

# 周月为什么要「现算」，又为什么不能随便算

票面：「周月从台账现算，不依赖报表自带的周月行（那几行只做校验）」。现算的理由是
报表里那几行**只覆盖它自己那一期**，翻不了历史；而且周中那份报表里的周行是半截的。

⚠ 但**周界必须用报表自己的**：报表的「周」是**周五 → 周四**（`2026 W37 (2026-09-04~2026-09-10)`，
  09-04 是周五，见 `docs/坑.md` §2.17.5 隔壁那条 / 第 08 张票）。自己按 ISO 周（周一→周日）
  切一遍的话，**这一页的数和老板手上的报表永远对不上**，而「校验」那一栏会天天报红 ——
  于是没人再看它。所以：**边界从周台账的期次标签里读**，读不到才回落到周五→周四。

⚠ **期次走自然序，不是字面序**（同 §2.9）：`2026 W9` 的字符串排在 `2026 W37` 后面。
  一律按**这一期的结束日**排。

⚠ **一期里缺几天台账，要报出来，不许闷头加。** 少三天的一周和完整的一周画在同一条折线上，
  看着就是「那周掉了」—— 而它只是数据没到（§2.12 同一条）。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from . import ledger as lg
from . import overview as ov

PERIODS = ["日", "周", "月"]          # 顺序 = 界面上的顺序，走数组（§2.18.5）
METRICS = ["tpv", "orders"]
METRIC_LABEL = {"tpv": "交易额", "orders": "交易笔数"}
# 报表的周是周五 → 周四。读不到周台账时用它兜底。
WEEK_ANCHOR = 4                       # 0=周一 … 4=周五


def _d(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


def _s(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def week_start(date: str, anchor: int = WEEK_ANCHOR) -> str:
    """这一天所在那一周的**第一天**。anchor 是周几开始（0=周一）。"""
    t = _d(date)
    return _s(t - timedelta(days=(t.weekday() - anchor) % 7))


def anchor_from_ledger(weeks: list | None = None) -> int:
    """周台账里那些期次是周几开始的。**读报表自己的**，读不到才回落。

    多份期次不一致时按出现最多的那个 —— 上游改过一次周界的话，新的那批会更多。
    """
    ws = lg.weeks(complete_only=False) if weeks is None else weeks
    votes: dict = {}
    for w in ws or []:
        st = (w or {}).get("start")
        try:
            votes[_d(st).weekday()] = votes.get(_d(st).weekday(), 0) + 1
        except (TypeError, ValueError):
            continue
    if not votes:
        return WEEK_ANCHOR
    return max(votes.items(), key=lambda kv: (kv[1], -kv[0]))[0]


def bucket_of(date: str, period: str, anchor: int = WEEK_ANCHOR) -> dict:
    """一天属于哪一期 → {key, label, start, end}。key 用**结束日**，排序走它（自然序）。"""
    if period == "周":
        a = week_start(date, anchor)
        b = _s(_d(a) + timedelta(days=6))
        # ⚠ 周号按**结束日**算，不是按起始日：报表把 09-04(五)~09-10(四) 叫 W37，
        #   而 09-04 的 ISO 周是 36、09-10 的是 37 —— 按起始日算会整体差一周，
        #   而「差一周」这种错在图上完全看不出来（形状一样，只是标错了）。
        iso = _d(b).isocalendar()
        return {"key": b, "label": f"{iso[0]} W{iso[1]:02d}（{a[5:]}~{b[5:]}）", "start": a, "end": b}
    if period == "月":
        t = _d(date)
        a = t.replace(day=1)
        b = (a + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        return {"key": _s(b), "label": _s(a)[:7], "start": _s(a), "end": _s(b)}
    return {"key": date, "label": date, "start": date, "end": date}


def label_from_ledger(end: str, weeks: list | None = None) -> str | None:
    """周台账里那一期的**原话**。对得上就用它 —— 自己拼的编号和报表差一周的话，
    图的形状一模一样、只是标错了，谁也看不出来。"""
    ws = lg.weeks(complete_only=False) if weeks is None else weeks
    hit = next((w for w in ws or [] if (w or {}).get("end") == end), None)
    return (hit or {}).get("期次") or None


def periods_back(date: str, period: str, n: int, anchor: int = WEEK_ANCHOR) -> list[dict]:
    """往前 n 期（含 date 那一期），**按结束日升序**。"""
    out, seen, cur = [], set(), _d(date)
    step = {"日": 1, "周": 7, "月": 28}[period]
    while len(out) < n and cur >= _d(date) - timedelta(days=step * n + 40):
        b = bucket_of(_s(cur), period, anchor)
        if b["key"] not in seen:
            seen.add(b["key"])
            out.append(b)
        cur = _d(b["start"]) - timedelta(days=1)
    out.sort(key=lambda b: b["key"])          # ⚠ 自然序：按结束日，不是按 label 的字面序
    return out[-n:]


def _span(start: str, end: str) -> list[str]:
    t, e, out = _d(start), _d(end), []
    while t <= e:
        out.append(_s(t))
        t += timedelta(days=1)
    return out


def rows_in(days: dict, start: str, end: str) -> tuple:
    """一期里的全部台账行 + 这期缺了哪几天。**缺天要带出去，不许闷头加。**"""
    rows, gap = [], []
    for x in _span(start, end):
        got = days.get(x)
        if got is None:
            gap.append(x)
        else:
            rows.extend(got)
    return rows, gap


def relabel(buckets: list, weeks: list | None = None) -> list[dict]:
    """能对上报表的那几期换成报表原话。对不上的保留自己拼的（历史翻不到那么远）。"""
    ws = lg.weeks(complete_only=False) if weeks is None else weeks
    out = []
    for b in buckets:
        lb = label_from_ledger(b["end"], ws)
        out.append({**b, "label": lb or b["label"], "from_report": bool(lb)})
    return out


def series(days: dict, buckets: list) -> list[dict]:
    """每一期一个点。⚠ **一天都没有的那期 `ok:false`，值是 None 不是 0**（§2.12）。

    有几天但不全的，`ok:true` 但带 `gap` —— 画的时候要标出来：
    少三天的一周和完整的一周画在同一条线上，看着就是「那周掉了」。
    """
    out = []
    for b in buckets:
        rows, gap = rows_in(days, b["start"], b["end"])
        span = len(_span(b["start"], b["end"]))
        if len(gap) >= span:
            out.append({**b, "ok": False, "tpv": None, "orders": None, "sites": None,
                        "gap": gap, "days": 0, "span": span})
            continue
        out.append({**b, "ok": True, **ov._day_totals(rows),
                    "gap": gap, "days": span - len(gap), "span": span})
    return out


def check_against_report(pt: dict, weeks: list | None = None) -> dict | None:
    """拿报表自带的周行**校验**这一期算得对不对。对不上不改数 —— 只报出来。

    ⚠ 报表那几行**只做校验，不做数据源**（票面定的）：它们只覆盖自己那一期、翻不了历史，
      而且周中那份里的周行是半截的（第 08 张票的 `complete`）。
    """
    ws = lg.weeks(complete_only=True) if weeks is None else [w for w in weeks if w.get("complete")]
    hit = next((w for w in ws or [] if w.get("end") == pt.get("end")), None)
    if not hit or not pt.get("ok"):
        return None
    theirs = round(sum(float(r.get("交易金额") or 0) for r in hit.get("rows") or []), 2)
    ours = float(pt.get("tpv") or 0)
    diff = round(ours - theirs, 2)
    return {"期次": hit.get("期次"), "报表": theirs, "台账": ours, "差": diff,
            "同": abs(diff) < max(1.0, theirs * 0.001)}


def build(days: dict, date: str, period: str = "日", n: int = 12, metric: str = "tpv",
          top_n: int = 10, anchor: int | None = None, weeks: list | None = None) -> dict:
    """台账 {日期: [站点行]} → 概览页要的东西。纯函数，不碰文件不碰网络。"""
    period = period if period in PERIODS else "日"
    metric = metric if metric in METRICS else "tpv"
    a = anchor_from_ledger(weeks) if anchor is None else anchor
    buckets = periods_back(date, period, n, a)
    if period == "周":
        buckets = relabel(buckets, weeks)
    pts = series(days, buckets)
    cur, prev = (pts[-1] if pts else None), (pts[-2] if len(pts) > 1 else None)

    rows, gap = (rows_in(days, cur["start"], cur["end"]) if cur else ([], []))
    prev_rows = rows_in(days, prev["start"], prev["end"])[0] if prev else []
    total = float(sum(float(r.get("交易金额") or 0) for r in rows))

    out = {
        "ok": bool(days) and bool(rows),
        "date": date, "period": period, "metric": metric, "n": n,
        "week_anchor": a,
        "current": cur, "series": pts,
        "gap": gap,
        "by": {} if not rows else {
            "接入模式": ov.group_by(rows, lambda r: (r.get("接入模式") or "").strip(), total, metric),
            "直签人": ov.group_by(rows, ov.owner_label, total, metric),
            "代理商": ov.group_by(rows, lambda r: (r.get("代理商名称") or "").strip() or "直签", total, metric),
            "商户": ov.group_by(rows, lambda r: (r.get("商户名称") or "").strip() or "—", total, metric),
        },
        "top": ov.top_merchants(rows, prev_rows, total, top_n, metric) if rows else [],
        "check": check_against_report(cur, weeks) if cur else None,
    }
    if not days:
        out["reason"] = "台账里一天都没有 —— 先灌数（python -m churn seed）"
    elif not rows:
        out["reason"] = (f"{(cur or {}).get('label') or date} 这一期台账里一天都没有"
                         f"（现有 {min(days)} ~ {max(days)}）")
    return out


# ---------------------------------------------------------------- 下钻

# ⚠ **筛选维度只有这一处**（§2.18.7）。渲染层再抄一份的话，加一维时两边必漂，
#   而漂掉的样子是「筛选框在、点了没反应」。
DRILL_KEYS = ["接入模式", "直签人", "代理商", "商户", "kw"]


def _field(r: dict, key: str) -> str:
    if key == "直签人":
        return ov.owner_label(r)
    if key == "代理商":
        return (r.get("代理商名称") or "").strip() or "直签"
    if key == "商户":
        return (r.get("商户名称") or "").strip() or "—"
    return (r.get(key) or "").strip()


def drill(days: dict, date: str, period: str, filters: dict | None = None,
          metric: str = "tpv", limit: int = 200, anchor: int | None = None) -> dict:
    """某一期的**站点明细**，按 filters 筛。站点级，不合并 —— 这一页的单位和流失页一致。

    ⚠ **截断要自报**（同 §2.16.5）：切掉的行数和切掉的金额都要带出去，
      不然看的人会拿前 200 行的合计当全部。
    """
    metric = metric if metric in METRICS else "tpv"
    a = anchor_from_ledger() if anchor is None else anchor
    b = bucket_of(date, period if period in PERIODS else "日", a)
    if b["start"] != b["end"]:
        b = relabel([b])[0]
    rows, gap = rows_in(days, b["start"], b["end"])
    f = {k: str((filters or {}).get(k) or "").strip() for k in DRILL_KEYS}
    kept = [r for r in rows if _match(r, f)]

    agg: dict = {}
    for r in kept:
        k = f"{r.get('用户ID') or ''}|{r.get('站点') or ''}"
        g = agg.setdefault(k, {"key": k, "用户ID": r.get("用户ID") or "", "站点": r.get("站点") or "",
                               "商户名称": r.get("商户名称") or "", "直签人": ov.owner_label(r),
                               "代理商": _field(r, "代理商"), "接入模式": (r.get("接入模式") or "").strip(),
                               "tpv": 0.0, "orders": 0, "days": 0})
        g["tpv"] += float(r.get("交易金额") or 0)
        g["orders"] += int(r.get("交易笔数") or 0)
        if int(r.get("交易笔数") or 0) > 0:
            g["days"] += 1
    items = sorted(agg.values(), key=lambda g: (-g[metric], g["key"]))
    for g in items:
        g["tpv"] = round(g["tpv"], 2)
    shown, rest = items[:limit], items[limit:]
    return {"ok": True, "period": period, "label": b["label"], "start": b["start"], "end": b["end"],
            "gap": gap, "metric": metric, "filters": f,
            "total": {"tpv": round(sum(g["tpv"] for g in items), 2),
                      "orders": sum(g["orders"] for g in items), "sites": len(items)},
            "rows": shown,
            "truncated": {"n": len(rest), "tpv": round(sum(g["tpv"] for g in rest), 2)} if rest else None}


def _match(r: dict, f: dict) -> bool:
    for k in DRILL_KEYS:
        want = f.get(k) or ""
        if not want:
            continue
        if k == "kw":
            hay = f"{r.get('商户名称') or ''} {r.get('站点') or ''} {r.get('用户ID') or ''}".lower()
            if want.lower() not in hay:
                return False
        elif _field(r, k) != want:
            return False
    return True


def options(days: dict, date: str, period: str, anchor: int | None = None) -> dict:
    """某一期里每个维度有哪些取值（按出现次数降序）。**界面上的下拉走它，不自己数一遍。**"""
    a = anchor_from_ledger() if anchor is None else anchor
    b = bucket_of(date, period if period in PERIODS else "日", a)
    rows, _ = rows_in(days, b["start"], b["end"])
    out = {}
    for k in DRILL_KEYS:
        if k == "kw":
            continue
        n: dict = {}
        for r in rows:
            v = _field(r, k)
            if v:
                n[v] = n.get(v, 0) + 1
        out[k] = [{"value": v, "count": c} for v, c in
                  sorted(n.items(), key=lambda kv: (-kv[1], kv[0]))]
    return out
