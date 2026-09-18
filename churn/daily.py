# -*- coding: utf-8 -*-
"""churn.daily —— 商户流失的**每日汇总**。纯函数：吃当天的状态，吐三行 + 前几家。

和原来那条群消息的分工：

  · 原来 `broadcast.group_text()` 发的是**逐条告警**（沉默跃迁 + 掉量推送档，
    过「前 N 个站点」那道闸）。实测 43 天里只有 24 天会发，共 47 条 —— 很克制，
    但一条一条读不出「今天整体怎么样」。
  · 这一份是**汇总**：三行 + 前几家，形状照老板周报（那份人已经在读了）。
    ⚠ **群里发这份，BD 私聊照旧发逐条** —— 汇总对具体那个 BD 没用，
      他要的是「我名下哪几家出事了」。

⚠ **门槛看的是「这家商户有多大」（30 天 TPV），不是「这次掉了多少」。**
  实测 2026-08-22：36 条命中里 30 天 TPV > $5,000 的只有 10 条，
  但那 10 条占掉 **95% 的金额** —— 砍条数不砍金额，正是「小金额的无所谓」要的。
  换成按「这次掉了多少」滤的话，大商户掉一天小钱也会被滤掉，那不是一回事。

⚠ **被门槛挡掉的要自报**（同 §2.16.5 截断必须自报）。只写「3 个站点」的话，
  看的人会以为今天就掉了 3 家；线下面还有多少、多少钱，得说出来。

⚠ **沉默和掉量不许相加**：沉默是「走了」，掉量是「还在出单但少了」。
  加起来那个数没有意义，而且会让人照着它去问人（同 `weekly` 那条）。

⚠ **算不出来不给 0**（§2.12）：没有状态就说「今天没跑过」，不写「0 家」。
"""
from __future__ import annotations

from . import assess as A
from .broadcast import money, owner_note, pct

DEFAULTS = {
    "daily_min_tpv": 5000,      # 30 天 TPV 低于这条线的不进汇总（小金额的无所谓）
    "daily_top_n": 5,           # 汇总底下列前几家
}

# 汇总只关心这三档。恢复 / 掉量关闭是好消息或已处理，进汇总会把这条消息的读法带偏。
SILENCE_PREFIX = A.SILENCE
DROP_TYPES = (A.DROP_PUSH, A.DROP_PAGE)


def _n(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def min_tpv(settings: dict | None) -> float:
    """门槛。⚠ 走 `is None` 判，不是 `or` —— 填 0 是「不设门槛」，有意义，不能被吃掉
    （§2.18.98 那条）。"""
    v = (settings or {}).get("daily_min_tpv")
    return DEFAULTS["daily_min_tpv"] if v is None else _n(v)


def _merchants(rows: list[dict]) -> int:
    return len({r.get("用户ID") for r in rows})


def by_merchant(rows: list[dict], top: int = 0) -> list[dict]:
    """站点级命中 → 商户维度（同一用户ID 合起来），按 30 天 TPV 降序。"""
    groups: dict = {}
    for r in rows:
        uid = r.get("用户ID") or ""
        g = groups.setdefault(uid, {"用户ID": uid, "商户名称": r.get("商户名称") or "",
                                    "直签人": r.get("直签人") or "",
                                    "代理商名称": r.get("代理商名称") or "",
                                    "tpv": 0.0, "sites": 0, "rows": []})
        g["tpv"] += _n(r.get("tpv30"))
        g["sites"] += 1
        g["rows"].append(r)
        if not g["商户名称"]:
            g["商户名称"] = r.get("商户名称") or ""
    out = sorted(groups.values(), key=lambda g: (-g["tpv"], g["用户ID"]))
    return out[:top] if top else out


def summary(state: dict | None, settings: dict | None = None) -> dict:
    """当天的汇总。`state` 是 `assess.assess()` 的输出。"""
    if not state or not (state.get("hits") is not None):
        return {"ok": False, "reason": "今天没跑过，算不出来"}
    s = {**DEFAULTS, **(settings or {})}
    floor = min_tpv(s)
    hits = state.get("hits") or []

    care = [h for h in hits
            if str(h.get("type") or "").startswith(SILENCE_PREFIX) or h.get("type") in DROP_TYPES]
    big = [h for h in care if _n(h.get("tpv30")) > floor]
    small = [h for h in care if _n(h.get("tpv30")) <= floor]

    sil = [h for h in big if str(h.get("type") or "").startswith(SILENCE_PREFIX)]
    drp = [h for h in big if h.get("type") in DROP_TYPES]

    tiers: dict = {}
    for h in sil:
        t = str(h.get("type"))
        tiers[t] = tiers.get(t, 0) + 1

    return {
        "ok": True, "date": state.get("date"), "floor": floor,
        # 沉默：金额用 30 天 TPV（「这家有多大」），因为它已经不出单了，没有「今天少了多少」
        "silence": {"tpv": round(sum(_n(h.get("tpv30")) for h in sil), 2),
                    "sites": len(sil), "merchants": _merchants(sil), "tiers": tiers},
        # 掉量：金额用**这次少掉的钱**（前一日的量），不是 30 天 TPV —— 它还在出单
        "drop": {"tpv": round(sum(_n((h.get("drop") or {}).get("base")) for h in drp), 2),
                 "sites": len(drp), "merchants": _merchants(drp)},
        "below": {"hits": len(small), "tpv": round(sum(_n(h.get("tpv30")) for h in small), 2)},
        "incidents": list(state.get("incidents") or []),
        "top": by_merchant(big, s["daily_top_n"]),
    }


def _one(g: dict) -> list[str]:
    """一家：名字 + 量 + 归谁 + 各站点在哪一档。"""
    head = f"• {g['商户名称'] or g['用户ID']} | {money(g['tpv'])} | {owner_note(g)}"
    bits = []
    for r in g["rows"]:
        t = str(r.get("type") or "")
        if t in DROP_TYPES:
            bits.append(f"较前日 {pct((r.get('drop') or {}).get('ratio'))}")
        else:
            bits.append(f"沉默 {int(_n(r.get('silent_days')))} 天")
    n = f"{g['sites']} 个站点" if g["sites"] > 1 else ""
    tail = "、".join(dict.fromkeys(bits))
    return [head, f"  {n}{' · ' if n and tail else ''}{tail}"] if tail or n else [head]


def text(sm: dict) -> str:
    """正文。**今天一条都不该报就返回空串** —— 每天一句「今天没人掉」是噪声。"""
    if not sm.get("ok"):
        return ""
    sil, drp = sm["silence"], sm["drop"]
    if not sil["sites"] and not drp["sites"]:
        return ""

    lines = [f"【商户流失日报 {(sm.get('date') or '')[5:]}】"]

    inc = sm.get("incidents") or []
    if inc:
        # 通道异常排在最前：同网关多家一起掉，那是通道的事，不是商户走了 ——
        # 先说这句，下面那份名单才不会被读成「今天跑了一批客户」
        who = "、".join(f"{i.get('gw')}（{i.get('merchants')} 家）" for i in inc)
        lines += [f"⚠ {who} 同通道多家一起掉，先别当商户走了", ""]

    if sil["sites"]:
        # ⚠ **档位分解数的是命中（站点级），单位是「个站点」不是「家」** ——
        #   一家商户可能有好几个站点，写成「2 家 / 3 个站点（满 2 天 2 家）」的话
        #   括号里那个数和前面的打架，看的人以为哪儿算错了（真实渲染里就是这么出来的）。
        # ⚠ **只有一档时括号是废话**：它和「N 个站点」说的是同一件事。
        items = tiers_items(sil["tiers"])
        tier = (" · ".join(f"满 {t.replace(SILENCE_PREFIX, '')} 天 {n} 个站点" for t, n in items)
                if len(items) > 1 else "")
        lines.append(f"■ 新沉默：{money(sil['tpv'])} · {sil['merchants']} 家 / {sil['sites']} 个站点"
                     + (f"（{tier}）" if tier else ""))
    if drp["sites"]:
        lines.append(f"■ 掉量：少了 {money(drp['tpv'])} · {drp['merchants']} 家 / {drp['sites']} 个站点"
                     "（还在出单，没算进上面）")

    if sm["top"]:
        lines += ["", f"前 {len(sm['top'])} 家："]
        for g in sm["top"]:
            lines += _one(g)

    below = sm.get("below") or {}
    if below.get("hits"):
        # ⚠ 挡掉的要自报：不写的话「3 个站点」会被当成今天的全部
        lines += ["", f"另有 {below['hits']} 条在 {money(sm['floor'])} 以下，没列。"]
    return "\n".join(lines).rstrip()


def tiers_items(tiers: dict) -> list:
    """档位按天数**数值**排序。⚠ 别按字符串排 —— 「沉默30」会排到「沉默7」前面。"""
    out = []
    for t, n in (tiers or {}).items():
        try:
            out.append((int(str(t).replace(SILENCE_PREFIX, "")), n))
        except ValueError:
            continue
    return [(f"{SILENCE_PREFIX}{d}", n) for d, n in sorted(out)]
