# -*- coding: utf-8 -*-
"""churn.weekly —— 老板的周一摘要（第 08 张票）。纯函数：吃周台账 + 那一周的每日状态，吐三行。

三行，刻意分开，**不许合并成一个数**：

  头条    上一个完整周活跃、这一周一笔没有的站点，其**上一周**的 TPV 之和。
          和报表「流失率」同口径 —— 所以走**报表自带的周报行**（`data/churn/weekly/`），
          ⚠ 不自己按 ISO 周从日报加：报表的周是**周五→周四**，加出来的数对不上还不报错。
  在途    这一周新进沉默满 7 天（或更高档）的站点，各自最近 30 天 TPV 之和。
          「下周还会掉多少」—— 它还没算进头条，混进去的话头条那个数就不是「已经掉了的」。
  掉量    周环比 ≤ `drop_page`（默认 −50%）的站点单列。**不混进流失数**：
          它们这一周还在出单，是「掉了」不是「走了」；混了的话头条会虚高，老板照着它去问人。

「谁在跟」从底账表回读（人在飞书里填的），空的**明写「无人认领」** —— 那正是老板要看的。
"""
from __future__ import annotations

from . import assess as A
from .broadcast import money, owner_note, pct

RISK_TIER = 7            # 「在途风险」数的是沉默满这么多天（含更高档）的新进


def share(r) -> str:
    """占比。⚠ **别用 `pct()`** —— 那是环比的格式，会给出「占上周 +38%」这种读不通的话。"""
    return "—" if r is None else f"{round(r * 100)}%"
TOP_N = 5                # 头条底下列前几家


def _key(r: dict) -> str:
    return f"{r.get('用户ID', '')}|{r.get('站点', '')}"


def _by_site(week: dict | None) -> dict:
    """一周的行 → {用户ID|站点: 行}。同键相加（报表里正常不会重复，重复了也不该丢一条）。"""
    out: dict = {}
    for r in (week or {}).get("rows") or []:
        k = _key(r)
        if not r.get("用户ID") or not r.get("站点"):
            continue
        if k in out:
            out[k] = {**out[k], "交易金额": out[k]["交易金额"] + float(r.get("交易金额") or 0),
                      "交易笔数": out[k]["交易笔数"] + int(r.get("交易笔数") or 0)}
        else:
            out[k] = {**r, "交易金额": float(r.get("交易金额") or 0), "交易笔数": int(r.get("交易笔数") or 0)}
    return out


def _live(row: dict | None) -> bool:
    """这一周算「有交易」吗。⚠ 笔数和金额都看：报表里见过笔数 0 而金额非 0 的退款行。"""
    return bool(row) and (int(row.get("交易笔数") or 0) > 0 or float(row.get("交易金额") or 0) > 0)


def churned(prev: dict, cur: dict) -> list[dict]:
    """上一周活跃、这一周一笔没有的站点，按上一周 TPV 降序。"""
    a, b = _by_site(prev), _by_site(cur)
    out = [dict(r, tpv=float(r.get("交易金额") or 0)) for k, r in a.items()
           if _live(r) and not _live(b.get(k))]
    out.sort(key=lambda r: (-r["tpv"], _key(r)))
    return out


def dropped(prev: dict, cur: dict, ratio: float) -> list[dict]:
    """周环比 ≤ ratio 的站点（两周都还在出单）。**和 churned 不重叠** —— 这一周是 0 的归流失。"""
    a, b = _by_site(prev), _by_site(cur)
    out = []
    for k, r in a.items():
        base = float(r.get("交易金额") or 0)
        now = b.get(k)
        if not _live(r) or not _live(now) or base <= 0:
            continue
        v = float(now.get("交易金额") or 0)
        rt = v / base - 1.0
        if rt <= ratio:
            out.append(dict(r, tpv=base, now=v, ratio=round(rt, 6)))
    out.sort(key=lambda r: (r["ratio"], _key(r)))
    return out


def risk_window(start: str, end: str) -> tuple | None:
    """在途风险要看哪一段状态。**倒过来就返回 None** —— 那是「算不出来」，不是「没有」。

    ⚠ 补跑时 `date` 是排队里那一天（可能是六周前的周一），而这份摘要算的永远是
      **最新那个完整周**。于是窗口成了 `[本周周五, 六周前那天]`，`start <= d <= end`
      一天都取不到，在途风险显示成 `$0 · 0 家` —— 而那长得和「真没有风险」
      一模一样（坑.md §2.12）。2026-09-16 用户收到的那条就是这么来的。
    """
    if not start or not end or start > end:
        return None
    return (start, end)


def risk(states: list[dict], tier: int = RISK_TIER) -> list[dict]:
    """在途风险：这些状态里新进沉默 ≥ tier 天的站点，每个站点只算一次（取最后那条）。

    ⚠ **只数「新进」的** —— 状态里的命中本来就是跃迁，天天都在沉默的站点不会再出现。
      但同一个站点一周里可能先满 7 天、后满 30 天，那是同一次流失，只能算一次。
    """
    out: dict = {}
    for st in states:
        for h in (st or {}).get("hits") or []:
            t = str(h.get("type") or "")
            if not t.startswith(A.SILENCE):
                continue
            try:
                n = int(t[len(A.SILENCE):])
            except ValueError:
                continue
            if n < tier:
                continue
            out[h.get("key") or _key(h)] = dict(h, tpv=float(h.get("tpv30") or 0))
    return sorted(out.values(), key=lambda r: (-r["tpv"], _key(r)))


# 真的有人接手才算的那几档。⚠ **「未跟进」和「无人认领」都不算** ——
# 建行时「跟进人」默认填了 BD / 代理商（churn/bitable.py），所以回读回来人人都有名字，
# 而那个名字和消息里上一行的「归谁」是同一个人。判据只能看**状态**：
# 默认行的状态是空（`follow_state` 回「未跟进」），人真接手了才会去选一档。
ACTIVE_STATES = ("跟进中", "已挽回", "放弃")


def taken(label: str) -> bool:
    """这半句算不算「真有人在跟」。`label` 是 `_follow_of` 拼出来的那串。"""
    return any(x in (label or "") for x in ACTIVE_STATES)


def _follow_of(rows: list[dict], follow: dict) -> str:
    """一家商户若干站点的「谁在跟」。**空的明写无人认领**，别显示成空白。"""
    who = []
    for r in rows:
        f = (follow or {}).get(_key(r)) or {}
        name = str(f.get("跟进人") or "").strip()
        state = str(f.get("状态") or "").strip()
        if name:
            label = f"{name} · {state}" if state and state != "无人认领" else name
        else:
            label = state or "无人认领"
        if label not in who:
            who.append(label)
    return "、".join(who) or "无人认领"


def by_merchant(rows: list[dict], follow: dict | None = None, top: int = TOP_N) -> list[dict]:
    """站点行 → 商户维度的前几家（同一用户ID 合起来）。每家带「谁在跟」。"""
    groups: dict = {}
    for r in rows:
        uid = r.get("用户ID") or ""
        g = groups.setdefault(uid, {"用户ID": uid, "商户名称": r.get("商户名称") or "",
                                    "直签人": r.get("直签人") or "", "代理商名称": r.get("代理商名称") or "",
                                    "tpv": 0.0, "sites": []})
        g["tpv"] += float(r.get("tpv") or r.get("交易金额") or 0)
        g["sites"].append(r)
        if not g["商户名称"]:
            g["商户名称"] = r.get("商户名称") or ""
    out = sorted(groups.values(), key=lambda g: (-g["tpv"], g["用户ID"]))
    for g in out:
        g["跟进"] = _follow_of(g["sites"], follow or {})
        g["无人认领"] = g["跟进"] == "无人认领"
        g["有人跟"] = taken(g["跟进"])
    return out[:top] if top else out


def summary(ws: list[dict], states: list[dict], settings: dict | None = None,
            follow: dict | None = None, date: str = "") -> dict:
    """三行 + 前 5 家。`ws` 是**已走完**的周（升序），至少要两周才算得出头条。"""
    s = settings or {}
    ws = [w for w in ws or [] if w.get("complete")]
    if len(ws) < 2:
        return {"ok": False, "date": date,
                "reason": f"周台账里只有 {len(ws)} 个走完的周，头条要两个完整周才算得出来 —— "
                          f"再等一份报表，或者 `python -m churn seed` 灌历史"}
    prev, cur = ws[-2], ws[-1]
    lost = churned(prev, cur)
    drops = dropped(prev, cur, float(s.get("drop_page", -0.50)))
    # `states is None` = 调用方（weekly_job.build）说「窗口算不出来」。
    # ⚠ 和「窗口对但那几天一条状态都没有」**是两回事**：后者是真的 0 家。
    known = states is not None
    at_risk = risk(states or [], RISK_TIER)
    base = sum(float(r.get("交易金额") or 0) for r in (prev.get("rows") or []))
    lost_tpv = sum(r["tpv"] for r in lost)
    return {
        "ok": True, "date": date, "prev": prev["期次"], "cur": cur["期次"],
        "window": {"start": cur.get("start"), "end": cur.get("end")},
        "lost": {"tpv": round(lost_tpv, 2), "sites": len(lost),
                 "merchants": len({r.get("用户ID") for r in lost}),
                 "base": round(base, 2),
                 # 和报表「流失率」同口径：掉掉的上周量 ÷ 上周总量
                 "rate": round(lost_tpv / base, 6) if base > 0 else None},
        "risk": ({"ok": True, "tpv": round(sum(r["tpv"] for r in at_risk), 2),
                  "sites": len(at_risk),
                  "merchants": len({r.get("用户ID") for r in at_risk}), "tier": RISK_TIER}
                 if known else
                 {"ok": False, "tpv": None, "sites": None, "merchants": None, "tier": RISK_TIER,
                  "reason": "这一周的状态没跑过，算不出来"}),
        "drop": {"tpv": round(sum(r["tpv"] - r["now"] for r in drops), 2), "sites": len(drops),
                 "merchants": len({r.get("用户ID") for r in drops}),
                 "ratio": float(s.get("drop_page", -0.50))},
        "top": by_merchant(lost, follow, TOP_N),
        "unclaimed": sum(1 for g in by_merchant(lost, follow, 0) if g["无人认领"]),
        # 有几家**真有人接手**（选了「跟进中 / 已挽回 / 放弃」之一）。
        # ⚠ 不是「跟进人非空」：建行时那一列默认填了 BD / 代理商，非空是常态。
        # ⚠ 也别让正文靠「unclaimed == 家数」去推：那是两个各自会变的数，
        #   哪天对不上了，正文会静默少掉一整段。
        "claimed": sum(1 for g in by_merchant(lost, follow, 0) if g["有人跟"]),
    }


def text(sm: dict) -> str:
    """摘要的正文。私聊老板和抄送运营群**是同一份** —— 两边看到的必须一个字不差。"""
    if not sm.get("ok"):
        return ""
    lost, rk, dp = sm["lost"], sm["risk"], sm["drop"]
    rate = f"（占上周 {share(lost['rate'])}）" if lost.get("rate") is not None else ""
    lines = [
        # ⚠ **标题不带 `date`。** 补跑时它是排队里那一天（可能是六周前的周一），
        #   而内容永远是最新那个完整周 —— 两个日期差几周，读的人无从判断这份是哪一周的。
        #   期次本身（`2026 W37 (2026-09-04~2026-09-10)`）已经把时间说全了。
        f"【商户流失周报】{sm['cur']}",
        f"■ 上周还在、这周一笔没有：{money(lost['tpv'])}{rate}"
        f" · {lost['merchants']} 家 / {lost['sites']} 个站点",
        (f"■ 在途风险：{money(rk['tpv'])} · {rk['merchants']} 家新进沉默满 {rk['tier']} 天（还没掉完）"
         if rk.get("ok", True) else
         # ⚠ **算不出来就说算不出来。** 写 $0 的话老板读成「下周没东西要掉了」
         f"■ 在途风险：{rk.get('reason') or '算不出来'}（沉默满 {rk['tier']} 天的那档）"),
        f"■ 周掉量（≤{pct(dp['ratio'])}）：少了 {money(dp['tpv'])} · {dp['merchants']} 家（还在出单，没算进上面）",
        "",
    ]
    # ⚠ **「谁在跟」是人在飞书底账表里手填的。一条都没填过时整段不出现。**
    #   没人用这一列的时候，前 5 家每家挂一句「谁在跟：无人认领」、末尾再来一句
    #   「其中 N 家无人认领」—— 6 行全是同一句废话，把上面那三个数挤下去了。
    #   ⚠ 但**有人填了就照旧出现**：那时候「谁没人管」正是老板要看的东西。
    #   判据走 `claimed`（真填过几家），不是「unclaimed 等不等于家数」—— 后者
    #   是两个各自会变的数，哪天对不上，这一整段会静默消失。
    used = bool(sm.get("claimed"))
    if sm["top"]:
        lines.append(f"前 {len(sm['top'])} 家：")
        for g in sm["top"]:
            head_ = f"• {g['商户名称'] or g['用户ID']} | {money(g['tpv'])} | {owner_note(g)}"
            n = f"{len(g['sites'])} 个站点"
            if used:
                lines += [head_, f"  {n} · 谁在跟：{g['跟进']}"]
            else:
                # 没有「谁在跟」的时候第二行只剩「N 个站点」—— 名单白长一倍，并上去
                lines.append(f"{head_} | {n}")
    if used and sm.get("unclaimed"):
        lines += ["", f"其中 {sm['unclaimed']} 家无人认领。"]
    return "\n".join(lines).rstrip()
