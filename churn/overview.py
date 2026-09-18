# -*- coding: utf-8 -*-
"""churn.overview —— 交易大盘的算数（第 14 张票）：趋势、构成、TPV 排名。

台账一行是「某天某个站点」。这里汇成三样：

  趋势  每天一个点（金额 / 笔数 / 有交易的站点数）
  构成  当日按接入模式、按直签人分组的占比，尾巴折进「其他」
  排名  当日按 TPV 降序的**商户**（同一商户的多个站点合起来算），带环比

⚠ **台账缺哪天，那天必须 `ok:false` / 值是 None，不能当 0**（§2.12）：当 0 会在趋势图上
  画出一个真实存在过的深坑，而那天其实只是数据没到。前 7 日均值同理 —— 按**有数的天数**除，
  不按 7 硬除。

⚠ **超过 6 类就折进「其他」**，不生成第 7 种颜色：dataviz 的分类色到 6 已经是软上限，
  再生成一个在色盲下和已有的分不开。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from names import owner_name

MAX_GROUPS = 6          # 构成里最多画几类，剩下的折进「其他」
TOP_N = 10              # 排名默认前几名
AVG_WINDOW = 7          # KPI 里和「前几日均值」比


def _d(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


def _s(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def dates_back(date: str, n: int) -> list[str]:
    t = _d(date)
    return [_s(t - timedelta(days=i)) for i in range(n - 1, -1, -1)]


def owner_label(row: dict) -> str:
    """直签人怎么显示。19 位数字是代理商的 ID 不是人名 —— 写成「代理商：某某」。"""
    who = owner_name(row.get("直签人"))
    if who.isdigit() and len(who) >= 15:
        return "代理商：" + (row.get("代理商名称") or who)
    return who


def _day_totals(rows: list) -> dict:
    return {"tpv": round(sum(float(r.get("交易金额") or 0) for r in rows), 2),
            "orders": sum(int(r.get("交易笔数") or 0) for r in rows),
            "sites": len({(r.get("用户ID"), r.get("站点")) for r in rows if int(r.get("交易笔数") or 0) > 0})}


def _kpi(series: list, key: str) -> dict:
    """当日值 + 环比 + 前 N 日均值。**算不出来一律 None，不给 0。**"""
    today = series[-1] if series else {"ok": False}
    prev = series[-2] if len(series) > 1 else {"ok": False}
    have = [x[key] for x in series[:-1] if x["ok"]][-AVG_WINDOW:]
    val = today[key] if today["ok"] else None
    pv = prev[key] if prev.get("ok") else None
    dod = None
    if val is not None and pv:
        dod = round(val / pv - 1, 6)
    avg = round(sum(have) / len(have), 2) if have else None
    vs = round(val / avg - 1, 6) if (val is not None and avg) else None
    return {"value": val, "prev": pv, "dod": dod, "avg7": avg, "avg7_days": len(have), "vs_avg7": vs}


def group_by(rows: list, key_fn, total: float, metric: str = "tpv") -> list:
    """按某个维度分组。`metric` 决定**排序和占比**按金额还是按笔数算。

    ⚠ **两个指标不能只换个分母。** 按笔数看时，排序也要按笔数 ——
      不然图例的顺序是金额序、条的长短是笔数，读的人会以为第一条最长。
      「其他」也跟着重折：按金额排在前 6 的和按笔数排在前 6 的**不是同一批**。
    """
    agg: dict = {}
    for r in rows:
        name = key_fn(r) or "—"
        g = agg.setdefault(name, {"name": name, "tpv": 0.0, "orders": 0, "sites": set()})
        g["tpv"] += float(r.get("交易金额") or 0)
        g["orders"] += int(r.get("交易笔数") or 0)
        # 只数**有交易**的站点，和头部那个「有交易的站点」同一把尺子 —— 不然两个数对不上
        if int(r.get("交易笔数") or 0) > 0:
            g["sites"].add((r.get("用户ID"), r.get("站点")))
    m = metric if metric in ("tpv", "orders") else "tpv"
    out = sorted(agg.values(), key=lambda g: (-g[m], g["name"]))
    for g in out:
        g["sites"] = len(g["sites"])
        g["tpv"] = round(g["tpv"], 2)
    if len(out) > MAX_GROUPS:
        tail = out[MAX_GROUPS:]
        out = out[:MAX_GROUPS] + [{
            "name": "其他", "n": len(tail),
            "tpv": round(sum(g["tpv"] for g in tail), 2),
            "orders": sum(g["orders"] for g in tail),
            "sites": sum(g["sites"] for g in tail)}]
    denom = total if m == "tpv" else sum(g["orders"] for g in out)
    for g in out:
        g["share"] = round(g[m] / denom, 6) if denom else 0
    return out


# 第 14 张票那会儿叫 _group；第 15 张票要按笔数看，加了 metric 参数并改成公开的。
# 留个别名是因为**这个仓库的规矩是一处定义** —— 两边各写一份迟早漂。
_group = group_by


def top_merchants(rows: list, prev_rows: list, total: float, top_n: int, metric: str = "tpv") -> list:
    """商户级排名：同一商户的多个站点合起来。新出现的商户环比是 None，不是 +100%。"""
    def agg(rs):
        out: dict = {}
        for r in rs:
            uid = str(r.get("用户ID") or "")
            g = out.setdefault(uid, {"用户ID": uid, "商户名称": r.get("商户名称") or "",
                                     "直签人": owner_label(r), "tpv": 0.0, "orders": 0, "sites": set()})
            g["tpv"] += float(r.get("交易金额") or 0)
            g["orders"] += int(r.get("交易笔数") or 0)
            g["sites"].add(r.get("站点"))
        return out

    now, before = agg(rows), agg(prev_rows)
    m = metric if metric in ("tpv", "orders") else "tpv"
    denom = total if m == "tpv" else sum(g["orders"] for g in now.values())
    out = []
    for g in sorted(now.values(), key=lambda x: (-x[m], x["用户ID"]))[:top_n]:
        pv = before.get(g["用户ID"], {}).get(m)
        out.append({**g, "站点数": len(g["sites"]), "tpv": round(g["tpv"], 2),
                    "share": round(g[m] / denom, 6) if denom else 0,
                    "prev": round(pv, 2) if pv else None,
                    "dod": round(g[m] / pv - 1, 6) if pv else None})
    for g in out:
        g.pop("sites", None)
    return out


_top = top_merchants        # 同 _group：一处定义，别再写一份


def build(days: dict, date: str, n_days: int = 30, top_n: int = TOP_N) -> dict:
    """台账 {日期: [站点行]} → 大盘要的三样东西。纯函数，不碰文件不碰网络。"""
    win = dates_back(date, n_days)
    series = []
    for x in win:
        rows = days.get(x)
        if rows is None:
            series.append({"date": x, "ok": False, "tpv": None, "orders": None, "sites": None})
        else:
            series.append({"date": x, "ok": True, **_day_totals(rows)})
    gap = [x["date"] for x in series if not x["ok"]]

    today_rows = days.get(date)
    total = float(sum(float(r.get("交易金额") or 0) for r in today_rows)) if today_rows else 0.0
    prev_rows = days.get(_s(_d(date) - timedelta(days=1))) or []
    out = {
        "ok": bool(days),
        "date": date, "days": n_days, "series": series, "gap": gap,
        "kpi": {k: _kpi(series, k) for k in ("tpv", "orders", "sites")},
        "by": {} if not today_rows else {
            "接入模式": _group(today_rows, lambda r: (r.get("接入模式") or "").strip(), total),
            "直签人": _group(today_rows, owner_label, total),
        },
        "top": _top(today_rows, prev_rows, total, top_n) if today_rows else [],
    }
    if not days:
        out["reason"] = "台账里一天都没有 —— 先灌数（python -m churn seed）"
    elif today_rows is None:
        out["reason"] = f"{date} 没有台账，当日的数算不出来（趋势里更早的天还在）"
    return out
