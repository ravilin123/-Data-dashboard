# -*- coding: utf-8 -*-
"""churn.trade_msg —— 交易量每日播报的文本。纯函数：吃 `overview.build()` 的结果，吐字符串。

口径一条都不新定：`kpi` / `by` / `top` 全是 `churn/overview.py` 算好的。

⚠ **群消息里不写口径、不解释阈值、不出现「工作台」三个字**（坑.md §2.5 §2.6）。
  `vs_avg7`（和前 7 日均值比）**刻意不进群消息** —— 它要解释才看得懂，留在页面上。

⚠ **「直签人」不是「BD」。** 实测 2026-08-19 那天 78 行：真人名 25 行、
  `代理商：xxx` 37 行、`未分配BD` 16 行；按 TPV 算代理商占 35.9%、未分配占 7.6%。
  写成「BD 排行」的话，读的人会把代理商那 36% 读成「有个 BD 漏统计了」，
  而那是代理签的、本来就没有 BD。所以段标题是「直签人 / 代理商」，
  这两类**各自单独成行，不合并也不藏**。

⚠ **截断了要补一行「其余 N 家」。** 只列前几名的话各行占比加起来不到 100%，
  而「加不到 100%」的样子和「算错了」一模一样 —— 看的人会自己去加，然后来问你。

⚠ **算不出来一律「—」，绝不写 0**（§2.12）。台账缺前一天时环比是 `None`。
"""
from __future__ import annotations

from .broadcast import money as _money

DEFAULTS = {
    "mode": "silent",       # 上线先只算不发，跑几天对数
    "top_n": 8,             # 群消息里列前几个商户
    "mode_n": 0,            # 接入模式列前几档；0 = 全列（实测就 4 档）
    "owner_n": 6,           # 直签人列前几名
    "webhook_url": "",      # 留空回落到团队群
}


def money(v) -> str:
    """和流失那条消息**共用同一套格式**：同一个群里两条消息数字长得不一样，
    读的人会以为是两套数据。`None` 是这里独有的一档 —— 算不出来不写 $0。"""
    return "—" if v is None else _money(v)


def pct(r) -> str:
    """环比。**四舍五入到 0 但不是真的没动时，多给一位小数，方向也保住。**

    ⚠ 不能直接用 `broadcast.pct`：它一律取整，于是 −0.48% 显示成 `-0%`、
      +0.4% 显示成 `+0%` —— 看着像持平，其实不是。实测那天笔数就是 −0.48%。
    """
    if r is None:
        return "—"
    n = round(r * 100)
    if n == 0 and r != 0:
        v = round(r * 100, 1)
        if v == 0:                       # 连 0.1% 都不到，写个数反而假精确
            return "+<0.1%" if r > 0 else "-<0.1%"
        return f"{'+' if r > 0 else ''}{v}%"
    return f"{'+' if n > 0 else ''}{n}%"


def share(r) -> str:
    """占比。⚠ **别用 `pct()`** —— 那是环比的格式，会写出「占 +40%」这种读不通的话
    （同 `weekly.share` 那条）。"""
    return "—" if r is None else f"{round((r or 0) * 100)}%"


def num(v) -> str:
    return "—" if v is None else f"{int(v):,}"


def md(day: str) -> str:
    """2026-08-19 → 08-19。群消息里年份没人看（同 `broadcast.md`）。"""
    return (day or "")[5:] or "-"


def _rest(rest: list) -> list[str]:
    """被截掉的那些，合成一行交代掉。**一个都没切就不出现这一行** ——
    写「其余 0 家」比不写还糟。"""
    if not rest:
        return []
    tpv = sum(float(x.get("tpv") or 0) for x in rest)
    n = sum(int(x.get("orders") or 0) for x in rest)
    return [f"· 其余 {len(rest)} 家  {money(tpv)}  "
            f"{share(sum(float(x.get('share') or 0) for x in rest))}  {num(n)} 笔"]


def _cut(items: list, n: int) -> tuple:
    """(列出来的, 切掉的)。`n` 为 0 = 全列。"""
    items = list(items or [])
    return (items, []) if not n else (items[:n], items[n:])


def _line(x: dict) -> str:
    return f"· {x.get('name') or '—'}  {money(x.get('tpv'))}  {share(x.get('share'))}  {num(x.get('orders'))} 笔"


def group_text(ov: dict, settings: dict | None = None) -> str:
    """整条群消息。**当天一个数都没有就返回空串** —— 调用方据此记「没跑」，不是失败。"""
    s = {**DEFAULTS, **(settings or {})}
    kpi = (ov or {}).get("kpi") or {}
    tpv, orders, sites = kpi.get("tpv") or {}, kpi.get("orders") or {}, kpi.get("sites") or {}
    if tpv.get("value") is None:
        return ""

    out = [f"【交易量 · {md(ov.get('date'))}】",
           f"{money(tpv.get('value'))}　环比 {pct(tpv.get('dod'))}",
           f"{num(orders.get('value'))} 笔　环比 {pct(orders.get('dod'))}　"
           f"{num(sites.get('value'))} 个站点有交易"]

    top, rest = _cut(ov.get("top") or [], s["top_n"])
    if top:
        out += ["", "■ 商户"]
        for t in top:
            out.append(f"· {t.get('商户名称') or t.get('用户ID') or '—'}  {money(t.get('tpv'))}  "
                       f"{share(t.get('share'))}  环比 {pct(t.get('dod'))}")
        out += _rest(rest)

    by = ov.get("by") or {}
    modes, mrest = _cut(by.get("接入模式") or [], s["mode_n"])
    if modes:
        out += ["", "■ 接入模式"] + [_line(x) for x in modes] + _rest(mrest)

    owners, orest = _cut(by.get("直签人") or [], s["owner_n"])
    if owners:
        # ⚠ 标题写「直签人 / 代理商」不写「BD」—— 见模块头那条
        out += ["", "■ 直签人 / 代理商"] + [_line(x) for x in owners] + _rest(orest)

    return "\n".join(out)
