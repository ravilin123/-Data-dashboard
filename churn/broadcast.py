# -*- coding: utf-8 -*-
"""churn.broadcast —— 流失的播报文本（第 05 张票）。纯函数：吃状态，吐字符串。

三条规矩照转化率那边（坑.md §2.5 §2.6 §2.18.96）：

  ⚠ **群消息里不写口径、不解释阈值、不出现「工作台」三个字。** 元信息在群里没人读，
    解释留在页面上 —— 那是配这套东西的人在看。
  ⚠ **不出现字面量 `nan`。** 直签人一律走 `names.owner_name`。
  ⚠ **推的只有「前 N 的沉默跃迁」和「掉量推送档」。** 恢复 / 掉量关闭 / 掉量·页面
    只在页面上 —— 它们不是「出事了」，混进群消息会把这条消息的读法带偏。
"""
from __future__ import annotations

from names import owner_name

from .assess import DROP_PUSH, GW_MISSING  # noqa: F401 —— 档位名只有一处定义（同 names.MODES 那条）


def push_types(settings: dict | None = None) -> tuple:
    """会推的类型，顺序就是消息里分段的顺序：越严重越靠前。

    ⚠ **跟着 `churn.silence_days` 走，别写死 2/7/30** —— 配置页上能改成 3/14，
      写死的话那些档的命中会被这里**静默丢掉**，运行记录还写着「无命中」。
    """
    tiers = (settings or {}).get("silence_days") or [2, 7, 30]
    return tuple(f"沉默{t}" for t in sorted(tiers, reverse=True)) + (DROP_PUSH,)


def section_label(t: str, settings: dict | None = None) -> str:
    """段标题。后面会接「（N）」，所以标题本身不带括号，免得读成「刚沉默（2 天）（1）」。"""
    if t == DROP_PUSH:
        return "■ 掉量"
    tiers = sorted((settings or {}).get("silence_days") or [2, 7, 30])
    n = t.replace("沉默", "")
    return f"■ 刚沉默 {n} 天" if str(tiers[0]) == n else f"■ 沉默满 {n} 天"


def money(v) -> str:
    v = float(v or 0)
    return "$" + (f"{round(v):,}" if v >= 100 else f"{v:.2f}" if v else "0")


def pct(r) -> str:
    return "—" if r is None else f"{'+' if r > 0 else ''}{round(r * 100)}%"


def md(day: str) -> str:
    """2026-09-14 → 09-14。群消息里日期只占两段，年份没人看。"""
    return (day or "")[5:] or "-"


def owner_of(hit: dict, settings: dict | None = None) -> str:
    """这条命中归谁。直签人是代理商 ID 且配了映射表 → 换成那个 BD 的名字。"""
    name = owner_name(hit.get("直签人"))
    return ((settings or {}).get("agent_owner") or {}).get(name, name)


def owner_note(hit: dict) -> str:
    """名单上那半句「归谁」。直签人是代理商 ID 时写代理商的名字，让接的人知道该找谁。"""
    name = owner_name(hit.get("直签人"))
    if name.isdigit() and len(name) >= 15:
        return "代理商：" + (hit.get("代理商名称") or name)
    return name


def gw_note(h: dict) -> str:
    """这条命中的网关标签，写进群消息那半句。

    ⚠ **「网关数据缺」在群里一个字都不出。** 群消息不写元信息（§2.5）：BD 看到「网关数据缺」
      既不能去催商户也不能去查通道，只会来问「这是什么意思」。缺数据这件事是**配这套东西的人**
      要知道的 —— 它在页面上、在运行记录里。
    """
    g = h.get("gw") or ""
    return "" if g in ("", GW_MISSING) else g


def incident_lines(state: dict) -> list[str]:
    """群消息顶上那几行「通道异常」。没有就一行都不出。

    单独成行是因为它改的是**这条消息的读法**：底下那些商户不是各自走了，是一个通道出事了。
    """
    # 群里**不列用户ID**：哪几家受影响，看下面名单里带「通道异常」那几条就是。
    return [f"⚠ 通道异常：{g.get('网关')} 今天 {g.get('merchants')} 家一起掉"
            for g in (state or {}).get("incidents") or []]


def pushable(state: dict, settings: dict | None = None) -> list[dict]:
    """该推的命中：沉默跃迁 + 掉量推送档，且有推送资格（前 N）。顺序 = 状态里的顺序。

    档位从**状态自己带的 settings** 认（状态是哪套配置算出来的就按哪套），
    调用方另给一份时以调用方的为准。
    """
    st_settings = (state or {}).get("settings") or {}
    types = push_types(settings or st_settings or None)
    return [h for h in (state or {}).get("hits") or []
            if h.get("type") in types and h.get("eligible")]


def _line(h: dict) -> list[str]:
    head = f"• {h.get('商户名称') or ''} | {h.get('站点') or ''}"
    bits = [f"ID:{h.get('用户ID') or ''}", owner_note(h), f"30天:{money(h.get('tpv30'))}"]
    if h["type"] == "掉量·推":
        drop = h.get("drop") or {}
        bits.insert(2, f"较前日 {pct(drop.get('ratio'))}（{money(drop.get('base'))}）")
    else:
        bits.insert(2, f"沉默 {h.get('silent_days')} 天 · 末次 {md(h.get('last_active'))}")
    gw = gw_note(h)
    if gw:
        bits.append(gw)
    if h.get("incident"):
        bits.append("通道异常：" + "、".join(h["incident"]))
    if h.get("sporadic"):
        bits.append(f"30天仅出{h.get('active30')}天")
    return [head, "  " + " | ".join(b for b in bits if b)]


def _sections(hits: list[dict], settings: dict | None = None) -> list[str]:
    out = []
    for t in push_types(settings):
        items = [h for h in hits if h["type"] == t]
        if not items:
            continue
        out.append(f"{section_label(t, settings)}（{len(items)}）")
        for h in items:
            out.extend(_line(h))
        out.append("")
    return out


def group_text(state: dict, settings: dict | None = None) -> str:
    """群消息。**没有该推的就返回空串** —— 每天一条「今天没人掉」是噪声（同待观察商户那条）。"""
    settings = settings or (state or {}).get("settings") or None
    hits = pushable(state, settings)
    if not hits:
        return ""
    inc = incident_lines(state)
    lines = [f"【商户流失 {state.get('date')}】"] + (inc + [""] if inc else []) + _sections(hits, settings)
    return "\n".join(lines).rstrip()


def group_for_dm(hits: list[dict], settings: dict | None = None) -> dict:
    """{负责人: [命中]}。顺序保持（组按首次出现，组内按输入顺序）。"""
    out: dict = {}
    for h in hits:
        out.setdefault(owner_of(h, settings), []).append(h)
    return out


def bd_text(owner: str, hits: list[dict], state: dict, settings: dict | None = None) -> str:
    """一个负责人的私聊。只有他名下的那几条，格式和群消息一致。"""
    settings = settings or (state or {}).get("settings") or None
    lines = [f"【商户流失 {state.get('date')}】", f"{owner} · 名下 {len(hits)} 条", ""]
    # 通道异常只列**他名下这几条真的碰上的**那些网关：整个大盘的通道故障关他什么事，
    # 而他手上这条是不是「不用去催商户」，关系很大。
    mine = []
    for h in hits:
        for g in h.get("incident") or []:
            if g not in mine:
                mine.append(g)
    if mine:
        lines += ["⚠ 这里有 " + "、".join(mine) + " 的通道异常，同网关多家一起掉，先别当商户走了", ""]
    lines.extend(_sections(hits, settings))
    return "\n".join(lines).rstrip()
