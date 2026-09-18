# -*- coding: utf-8 -*-
"""churn.assess —— 流失状态机（第 04 张票）。纯函数：吃台账若干天 + 昨日状态 + 配置，吐今天的状态。

单位是**站点**（用户ID + 站点），不是商户（用户 2026-09-15 定的）。

  沉默    沉默天数 = 今天 − 最后一个有交易日。满 2 / 7 / 30 天各跃迁一次（取够得着的最高档），
          恢复交易归零并记「恢复」（只在页面，不推），再沉默重新数。
  滚动值  `tpv30` / `active30` 的窗口**以该站点最后一个有交易日为终点**，不是以今天。
          以今天为终点的话，沉默满 30 天的站点窗口内 TPV 必然是 0 → 排名垫底 →
          **最高那一档永远拿不到推送资格**，而那正是最该推的一档（实测：rank=None）。
          活跃天数同理：沉默 20 天的大站点会被算成「30 天只出 10 天」，误标零星型。
          `tpv_asof` 记着窗口的终点，页面上和今天不一致时要标出来。
  掉量    今天和昨天都有单：日环比 ≤ drop_push 为「掉量·推」，≤ drop_page 为「掉量·页面」。
          开了之后两天内任一天回到掉量前水平的 recover_ratio → 「掉量关闭」；两天没回就过期清掉，不算关闭。
          开着的期间不再开第二个（基数是掉量前那天的金额）。
  资格    最近 window_days 天滚动 TPV 排前 top_n 的站点才有资格推；命中当天算，不回溯。
  零星型  窗口里活跃天数 ≤ sporadic_max_days。它的沉默不值钱，名单上要标出来。
  缺口    窗口里缺台账的日子列在 gap 里；缺口横在「最后有交易日 → 今天」中间的站点标 uncertain，
          **不跃迁**（算不出来不能当算出来了，坑.md §2.12）。今天自己没台账 → ok:false + reason。
  网关    第 07 张票。网关台账（站外_网关TPV统计报表）是**全公司收单**、按「网关 × 用户ID」，
          **没有站点列**。所以：
            · 标签是**商户级**的 —— 「其他通道仍有交易」里的「其他通道」包含**这家商户自己别的
              站点**（同一个用户ID 在网关报表里分不开），页面上那句提示写明了这一点。
            · 网关台账**缺当天就标「网关数据缺」，不猜**：没有数据不等于「全网关停止」，
              后者是会让 BD 直接去催商户的结论（坑.md §2.12 同一条规矩）。
          通道异常：同一网关当天 ≥ `gateway_incident_min` 家**排名前 `gateway_incident_top_n`**
          的商户一起掉（沉默跃迁或掉量），算这个网关出事。商户归哪个网关，看它**最近一次在
          网关台账里有交易**的那天用的是哪几个 —— 今天它已经掉了，只看今天会一个都认不出来。

幂等：同样的输入两次结果相同；不改输入。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from . import config as C

SILENCE = "沉默"
RECOVER = "恢复"
DROP_PUSH = "掉量·推"
DROP_PAGE = "掉量·页面"
DROP_CLOSE = "掉量关闭"
# 命中类型的顺序 = 名单里的顺序（走数组，别走 dict 键序）
HIT_ORDER = ["沉默30", "沉默7", "沉默2", DROP_PUSH, DROP_PAGE, RECOVER, DROP_CLOSE]
# 网关标签（第 07 张票）。**三种，缺数据是独立的一种**，不许并进「全网关停止」。
GW_OTHER = "其他通道仍有交易"
GW_ALL_STOP = "全网关停止"
GW_MISSING = "网关数据缺"
# 会被算进「通道异常」的命中：沉默跃迁（下面按前缀认）和两档掉量
INCIDENT_TYPES = (DROP_PUSH, DROP_PAGE)

DROP_WINDOW = 2          # 掉量开了之后看几天
PRUNE_AFTER = 90         # 沉默超过这么多天的站点不再跟踪（最高档早就推过了）

SITE_FIELDS = ("用户ID", "站点", "商户名称", "直签人", "代理商ID", "代理商名称", "接入模式")


def _d(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


def _s(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def window_dates(today: str, n: int) -> list[str]:
    t = _d(today)
    return [_s(t - timedelta(days=i)) for i in range(n - 1, -1, -1)]


def site_key(row: dict) -> str:
    return f"{row.get('用户ID', '')}|{row.get('站点', '')}"


def _index(days: dict, today: str) -> dict:
    """{日期: {key: 行}}，只留今天及之前、且用户ID 和站点都非空的行。"""
    out = {}
    for date, rows in days.items():
        if date > today:
            continue
        m = {}
        for r in rows or []:
            if not r.get("用户ID") or not r.get("站点"):
                continue
            m[site_key(r)] = r
        out[date] = m
    return out


def gateway_view(gw_days: dict | None, today: str) -> dict:
    """网关台账 → 今天怎么读它。

      has_today   当天有没有网关台账。**没有就一律标「网关数据缺」，不猜**。
      active      {用户ID: [今天有交易的网关]}
      home        {用户ID: [最近一次有交易那天用的网关]} —— 用来把「掉了的商户」归到网关上。
                  今天它已经掉了，只看今天的话一个都认不出来，通道异常永远触发不了。
    """
    gw_days = gw_days or {}
    dates = sorted((d for d in gw_days if d <= today), reverse=True)
    active: dict[str, list] = {}
    for r in gw_days.get(today) or []:
        uid, g = r.get("用户ID"), r.get("网关")
        if uid and g and (r.get("交易笔数") or 0) > 0 and g not in active.setdefault(uid, []):
            active[uid].append(g)
    home: dict[str, list] = {}
    seen: set = set()
    for d in dates:                       # 从今天往回：一个用户ID 只认最近那一天
        by_uid: dict[str, list] = {}
        for r in gw_days.get(d) or []:
            uid, g = r.get("用户ID"), r.get("网关")
            if uid and g and (r.get("交易笔数") or 0) > 0 and g not in by_uid.setdefault(uid, []):
                by_uid[uid].append(g)
        for uid, gs in by_uid.items():
            if uid not in seen:
                seen.add(uid)
                home[uid] = gs
    return {"has_today": today in gw_days, "active": active, "home": home,
            "dates": sorted(gw_days), "latest": dates[0] if dates else None}


def gateway_label(view: dict, uid: str) -> str:
    """这家商户今天的网关标签。⚠ **缺数据是独立的一种**，不许当成「全网关停止」。"""
    if not (view or {}).get("has_today"):
        return GW_MISSING
    return GW_OTHER if (view.get("active") or {}).get(uid) else GW_ALL_STOP


def incidents(hits: list[dict], sites: dict, view: dict, s: dict) -> list[dict]:
    """通道异常：同一网关当天 ≥ N 家前 M 的商户一起掉。

    **数的是「家」（用户ID）不是「条」** —— 一家商户 7 个站点一起沉默是一家出事，
    不是七家；按条数的话单个大商户就能把整个网关判成故障。
    """
    need = max(1, int(s.get("gateway_incident_min") or 1))
    top = int(s.get("gateway_incident_top_n") or 0)
    by_gw: dict[str, dict] = {}
    for h in hits:
        t = h.get("type")
        if not (t in INCIDENT_TYPES or t.startswith(SILENCE)):
            continue
        rank = (sites.get(h.get("key")) or {}).get("rank")
        if top and not (rank and rank <= top):
            continue
        uid = h.get("用户ID")
        for g in (view.get("home") or {}).get(uid) or []:
            b = by_gw.setdefault(g, {"网关": g, "uids": [], "sites": 0, "types": {}})
            if uid not in b["uids"]:
                b["uids"].append(uid)
            b["sites"] += 1
            b["types"][t] = b["types"].get(t, 0) + 1
    out = [dict(b, merchants=len(b["uids"])) for b in by_gw.values() if len(b["uids"]) >= need]
    out.sort(key=lambda b: (-b["merchants"], b["网关"]))
    return out


def _hit_rank(h: dict) -> tuple:
    return (0 if h["eligible"] else 1, -h["tpv30"], h["key"])


def assess(days: dict, today: str, prev: dict | None, cfg: dict | None,
           gateway: dict | None = None) -> dict:
    """`gateway` 是 {日期: [网关台账行]}，形状同 `days`。不给 = 没有网关数据，一律标「网关数据缺」。"""
    s = C.settings(cfg)
    if today not in days:
        return {"ok": False, "date": today, "reason": f"{today} 没有台账，这天算不了", "gap": [], "sites": {}, "hits": [],
                "counts": {}, "settings": s}
    gw_view = gateway_view(gateway, today)
    per_day = _index(days, today)
    win = window_dates(today, s["window_days"])
    gap = [x for x in win if x not in per_day]
    tiers = s["silence_days"]
    prev_sites = (prev or {}).get("sites") or {}
    yesterday = _s(_d(today) - timedelta(days=1))

    # 候选站点取**读进来的全部天**，不只是窗口内那 30 天：冷启动（prev=None）时
    # 沉默 31~90 天的大站点只出现在窗口之外，只看窗口的话它们整个不进 sites、永远不跃迁。
    # PRUNE_AFTER 负责把太老的挡在外面。
    keys = set(prev_sites.keys())
    for m in per_day.values():
        keys |= set(m.keys())

    sites, hits = {}, []
    dates_desc = sorted(per_day, reverse=True)
    for k in sorted(keys):
        p = prev_sites.get(k) or {}
        # 最近一行（带商户名、直签人等）；最后有交易日
        latest_row, last_active = None, None
        for date in dates_desc:
            r = per_day[date].get(k)
            if r is None:
                continue
            if latest_row is None:
                latest_row = r
            if r.get("交易笔数", 0) > 0:
                last_active = date
                break
        if last_active is None:
            last_active = p.get("last_active")
        if last_active is None:
            continue                                   # 从没见它出过单：没什么可跟踪的
        info = {f: (latest_row or {}).get(f, p.get(f, "")) for f in SITE_FIELDS}
        silent_days = (_d(today) - _d(last_active)).days
        if silent_days > PRUNE_AFTER:
            continue

        # 滚动指标：窗口以**这个站点最后一个有交易日**为终点（见文件头「滚动值」那段）
        own = win if last_active >= today else window_dates(last_active, s["window_days"])
        tpv30 = float(sum(per_day[x][k].get("交易金额", 0.0)
                          for x in own if x in per_day and k in per_day[x]))
        active30 = sum(1 for x in own if x in per_day and k in per_day[x]
                       and per_day[x][k].get("交易笔数", 0) > 0)

        today_row = per_day[today].get(k)
        active_today = bool(today_row and today_row.get("交易笔数", 0) > 0)
        uncertain = any(g > last_active for g in gap)
        prev_level = int(p.get("silence_level") or 0)
        level, recovered_on, site_hits = prev_level, p.get("recovered_on"), []

        if active_today:
            if prev_level > 0:
                site_hits.append(RECOVER)
                recovered_on = today
            level = 0
        elif not uncertain:
            reach = [t for t in tiers if silent_days >= t]
            top = max(reach) if reach else 0
            if top > prev_level:
                level = top
                site_hits.append(f"{SILENCE}{top}")
                recovered_on = None      # 又沉默了，绿色的「已恢复」标签不能再挂着

        # 掉量
        drop = dict(p["drop"]) if p.get("drop") else None
        if drop:
            opened = drop["opened"]
            age = (_d(today) - _d(opened)).days
            amt_t = today_row.get("交易金额", 0.0) if active_today else 0.0
            if active_today and amt_t >= s["recover_ratio"] * drop["base"]:
                site_hits.append(DROP_CLOSE)
                drop = None
            elif age >= DROP_WINDOW:
                drop = None                            # 两天没回来：过期，不算关闭
        if drop is None and active_today:
            y = per_day.get(yesterday, {}).get(k)
            if y and y.get("交易笔数", 0) > 0 and y.get("交易金额", 0.0) > 0 and DROP_CLOSE not in site_hits:
                base = float(y["交易金额"])
                ratio = float(today_row["交易金额"]) / base - 1.0
                lvl = DROP_PUSH if ratio <= s["drop_push"] else DROP_PAGE if ratio <= s["drop_page"] else None
                if lvl:
                    drop = {"level": lvl, "opened": today, "base": base, "ratio": round(ratio, 6)}
                    site_hits.append(lvl)

        sites[k] = {**info, "key": k, "gw": gateway_label(gw_view, info.get("用户ID")),
                    "incident": [],
                    "last_active": last_active, "silent_days": silent_days,
                    "silence_level": level, "recovered_on": recovered_on, "drop": drop,
                    "tpv30": round(tpv30, 2), "tpv_asof": own[-1], "active30": active30, "uncertain": uncertain,
                    "sporadic": active30 <= s["sporadic_max_days"], "rank": None, "eligible": False,
                    "_hits": site_hits}

    # 资格：按 30 天 TPV 排名
    ranked = sorted((k for k in sites if sites[k]["tpv30"] > 0), key=lambda k: (-sites[k]["tpv30"], k))
    for i, k in enumerate(ranked, start=1):
        sites[k]["rank"] = i
        sites[k]["eligible"] = i <= s["top_n"]

    for k, v in sites.items():
        for t in v.pop("_hits"):
            # active30 / uncertain / recovered_on / tpv_asof 也要带上：页面的标签是命中行和
            # 名单行共用的一段（render.tags），少一个就印出「30 天出 undefined 天」
            hits.append({"key": k, "type": t, "eligible": v["eligible"], "tpv30": v["tpv30"], "rank": v["rank"],
                         "tpv_asof": v["tpv_asof"], "active30": v["active30"], "uncertain": v["uncertain"],
                         "recovered_on": v["recovered_on"], "gw": v["gw"], "incident": [],
                         "silent_days": v["silent_days"], "sporadic": v["sporadic"], "last_active": v["last_active"],
                         "drop": v["drop"] if t in (DROP_PUSH, DROP_PAGE) else None,
                         **{f: v[f] for f in SITE_FIELDS}})
    hits.sort(key=lambda h: (_hit_rank(h), HIT_ORDER.index(h["type"]) if h["type"] in HIT_ORDER else 99))

    # 通道异常：算完排名才数得了「前 M 的商户」
    inc = incidents(hits, sites, gw_view, s)
    hot = {g["网关"]: g for g in inc}
    for h in hits:
        tagged = [g for g in (gw_view.get("home") or {}).get(h.get("用户ID")) or [] if g in hot]
        h["incident"] = tagged
        if tagged:
            sites[h["key"]]["incident"] = tagged

    counts = {}
    for h in hits:
        counts[h["type"]] = counts.get(h["type"], 0) + 1
    return {"ok": True, "date": today, "window": win, "gap": gap, "sites": sites, "hits": hits,
            "counts": counts, "eligible_n": sum(1 for h in hits if h["eligible"]),
            "incidents": inc,
            "gateway": {"has_today": gw_view["has_today"], "latest": gw_view["latest"],
                        "merchants": len(gw_view["active"])},
            "settings": {"top_n": s["top_n"], "silence_days": tiers, "drop_push": s["drop_push"],
                         "drop_page": s["drop_page"], "sporadic_max_days": s["sporadic_max_days"],
                         "window_days": s["window_days"],
                         "gateway_incident_min": s["gateway_incident_min"],
                         "gateway_incident_top_n": s["gateway_incident_top_n"]}}
