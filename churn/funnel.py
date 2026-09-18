# -*- coding: utf-8 -*-
"""churn.funnel —— 生命周期漏斗头（第 09 张票）。纯函数：吃出单监控台账 + 流失状态，吐五级。

    注册 → 开通 → 首单 → 稳定出单 → 沉默

前三级来自**出单监控报表的三个时间**（提交 / 通道反馈 / 第一笔成功交易），
后两级来自流失状态（有没有在沉默）。单位是**站点**（用户ID + 站点），和整套一致；
「家」按用户ID 去重另算一个数。

⚠ **耗时一律自然日（含周末），一张表一把尺子。**
  报表自带的六列耗时是**小时 · 不含节假日**（坑.md §2.18），实测同一行自己相减会偏大三成。
  但这五级里只有两段能对上现成的列（`站点_上线时长` = 注册→首单、`集成耗时` = 开通→首单），
  「注册 → 开通」没有对应的列。两把尺子混在一张表里读的人分不出来，所以这里统一用自然日，
  **并在界面上写明**，另附一句指回出单监控页看报表自带那六列。

⚠ **算不出来就写「算不出」，不当 0**（同 §2.12、同那六列 `0` 的四种意思）：
    起点缺        → 算不出，不进分母
    终点缺        → **还没走到这一步**，不进分母（这是「卡住的」，另外数）
    终点早于起点  → 上游数据有问题，算不出，不进分母
  每一段都把样本量 `n` 和被排除的行数分别报出来 —— 不报的话，一个中位数背后是 3 行还是
  300 行，看的人无从判断。
"""
from __future__ import annotations

from datetime import datetime

# 三个时间在出单监控台账的「明细」里叫什么（report.DATE_COLS 把「时间」改成了「日期」）
D_SUBMIT = "站点_商户提交日期"
D_APPROVE = "通道结果反馈日期"
D_FIRST = "第一笔成功交易日期"

# 五级的顺序 = 界面上的顺序。**走数组**（坑.md §2.18.5）。
LEVELS = ["注册", "开通", "首单", "稳定出单", "沉默"]
# 每一级是「到这儿了」，段是「从上一级走到这一级花了多久」
STEPS = [("注册", "开通", D_SUBMIT, D_APPROVE), ("开通", "首单", D_APPROVE, D_FIRST)]

RULER = "自然日 · 含周末"


def _d(v):
    s = str(v or "").strip()[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return None


def site_key(r: dict) -> str:
    return f"{r.get('用户ID') or ''}|{r.get('站点') or ''}"


def median(xs: list) -> float | None:
    """中位数。空 → None（**不是 0**）。"""
    if not xs:
        return None
    ys = sorted(xs)
    n = len(ys)
    return float(ys[n // 2]) if n % 2 else (ys[n // 2 - 1] + ys[n // 2]) / 2.0


def gap_days(a, b):
    """两个日期之间的自然日。算不出来 → None。"""
    x, y = _d(a), _d(b)
    if x is None or y is None or y < x:
        return None
    return (y - x).days


def step_stats(rows: list, start_col: str, end_col: str) -> dict:
    """一段的耗时分布。**四种情况分开数**，不许合并成一个「样本 n」。"""
    vals, no_start, no_end, negative = [], 0, 0, 0
    for r in rows:
        a, b = _d(r.get(start_col)), _d(r.get(end_col))
        if a is None and b is None:
            no_start += 1            # 两头都没有：这一步还没开始
            continue
        if a is None:
            no_start += 1
            continue
        if b is None:
            no_end += 1              # 还没走到这一步 —— 它是「卡住的」，不是耗时 0
            continue
        if b < a:
            negative += 1            # 上游数据有问题（终点早于起点），算不出
            continue
        vals.append((b - a).days)
    return {"median": median(vals), "n": len(vals), "ruler": RULER,
            "no_start": no_start, "no_end": no_end, "negative": negative,
            "p75": _pct(vals, 0.75), "p90": _pct(vals, 0.90)}


def _pct(xs: list, q: float):
    if not xs:
        return None
    ys = sorted(xs)
    i = min(len(ys) - 1, int(round(q * (len(ys) - 1))))
    return float(ys[i])


def _n(rows: list) -> dict:
    """一组行的「几个站点 / 几家商户」。**两个都给** —— 票面问的是家数，
    而整套系统的单位是站点，只给一个的话另一个会被人自己脑补出来。"""
    return {"sites": len(rows), "merchants": len({r.get("用户ID") or "" for r in rows})}


def build(detail: list, state: dict | None = None, settings: dict | None = None,
          date: str = "") -> dict:
    """出单监控台账的「明细」+ 流失状态 → 五级 + 两段耗时 + 卡在哪。

    `date` 是**这份台账自己那天**，不是运行这段代码的今天：看三天前那份台账时，
    拿今天当「卡了多久」的终点，会把每一行都多算三天。
    """
    rows = [r for r in (detail or []) if r.get("用户ID") and r.get("站点")]
    s = settings or (state or {}).get("settings") or {}
    tier = (s.get("silence_days") or [2])[0]
    today = date or datetime.now().strftime("%Y-%m-%d")

    reg = [r for r in rows if _d(r.get(D_SUBMIT))]
    apr = [r for r in reg if _d(r.get(D_APPROVE))]
    fst = [r for r in apr if _d(r.get(D_FIRST))]
    apr_keys, fst_keys = {site_key(r) for r in apr}, {site_key(r) for r in fst}

    # 后两级：有首单的站点里，流失状态说它在不在沉默。
    # ⚠ 状态里没有这个站点 ≠ 它在稳定出单 —— 台账可能还没覆盖到它，那一档单独数，
    #   混进「稳定出单」的话这一级会虚高，而那正是老板最想信的那个数。
    sites = (state or {}).get("sites") or {}
    steady, silent, unknown = [], [], []
    for r in fst:
        st = sites.get(site_key(r))
        if st is None:
            unknown.append(r)
        elif (st.get("silent_days") or 0) >= tier:
            silent.append(r)
        else:
            steady.append(r)

    levels = [{"name": n, **_n(g)} for n, g in
              (("注册", reg), ("开通", apr), ("首单", fst), ("稳定出单", steady), ("沉默", silent))]

    stuck = []
    for name, note, group, col in (
            ("提交了没通过", "注册 → 开通 卡着", [r for r in reg if site_key(r) not in apr_keys], D_SUBMIT),
            ("通过了没首单", "开通 → 首单 卡着", [r for r in apr if site_key(r) not in fst_keys], D_APPROVE)):
        waited = [x for x in (gap_days(r.get(col), today) for r in group) if x is not None]
        stuck.append({"name": name, "note": note, **_n(group),
                      "median": median(waited), "n": len(waited), "ruler": RULER})
    return {
        "ok": True, "date": today, "ruler": RULER, "levels": levels,
        "steps": [{"from": a, "to": b, **step_stats(rows, sc, ec)} for a, b, sc, ec in STEPS],
        "stuck": stuck,
        # 状态没覆盖到的那些：**不当成「稳定出单」**，单独说
        "uncovered": _n(unknown),
        "tier": tier,
    }
