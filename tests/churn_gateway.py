"""
churn_gateway.py - 网关标签 + 通道异常（第 07 张票）。

    python tests/churn_gateway.py      # 零依赖

两件事，都是「没有数据时不许猜」的变体：

  网关标签  沉默的站点当天在网关报表里还有没有交易 —— 这是**唯一能拿到的「为什么」**。
            三种：其他通道仍有交易 / 全网关停止 / 网关数据缺。
            ⚠ 第三种**不许并进第二种**：并了的话 BD 会拿着一条「我们没数据」去催商户。
  通道异常  同一网关当天 ≥ N 家前 M 的商户一起掉。数的是**家**不是条。
            商户归哪个网关，看它**最近一次有交易**那天用的是哪几个 —— 只看今天一个都认不出来。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from churn import assess as A  # noqa: E402
from churn import broadcast as BC  # noqa: E402
from churn import config as C  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


def site(uid, host, amt, n=1, name=None, owner="赵娜"):
    return {"用户ID": uid, "站点": host, "商户名称": name or f"商户{uid}", "直签人": owner,
            "代理商ID": "", "代理商名称": "", "接入模式": "标准收银台",
            "交易金额": float(amt), "交易笔数": int(n)}


def gw(uid, gateway, amt, n=1):
    return {"报表类型": "日报", "统计周期": "", "网关": gateway, "用户ID": uid,
            "交易金额": float(amt), "交易笔数": int(n)}


def days_for(spec: dict) -> dict:
    """{日期: [站点行]}。spec 是 {日期: [(uid, host, amt, n), …]}。"""
    return {d: [site(*t) for t in rows] for d, rows in spec.items()}


D = ["2026-09-%02d" % i for i in range(1, 16)]
TODAY = D[-1]

# ---------- [1] 网关标签 ----------
print("[1] ★ 网关标签三种，缺数据是独立的一种")
view_missing = A.gateway_view({}, TODAY)
check("没有网关台账 → 网关数据缺", A.gateway_label(view_missing, "u1") == A.GW_MISSING)
check("★ 缺数据 ≠ 全网关停止（并了的话 BD 会拿着「我们没数据」去催商户）",
      A.GW_MISSING != A.GW_ALL_STOP)

view = A.gateway_view({TODAY: [gw("u1", "网关A", 100, 3), gw("u2", "网关A", 0, 0)]}, TODAY)
check("今天还有交易 → 其他通道仍有交易", A.gateway_label(view, "u1") == A.GW_OTHER)
check("★ 有行但笔数是 0 → 全网关停止（0 笔不是「有交易」）", A.gateway_label(view, "u2") == A.GW_ALL_STOP)
check("今天压根没这家 → 全网关停止", A.gateway_label(view, "u9") == A.GW_ALL_STOP)
check("有当天台账这件事自己说得出来", view["has_today"] is True and view_missing["has_today"] is False)

print("\n[1b] 归哪个网关：看最近一次有交易那天，不是只看今天")
v2 = A.gateway_view({D[-3]: [gw("u1", "网关A", 100, 3)], D[-2]: [gw("u1", "网关A", 50, 2)],
                     TODAY: [gw("u1", "网关A", 0, 0)]}, TODAY)
check("★ 今天 0 笔，仍认得出它归网关A（只看今天的话通道异常永远触发不了）",
      v2["home"].get("u1") == ["网关A"], v2["home"])
check("今天活跃集合里没有它", not v2["active"].get("u1"))
v3 = A.gateway_view({D[-2]: [gw("u1", "网关A", 50, 2)], TODAY: [gw("u1", "网关B", 10, 1)]}, TODAY)
check("★ 最近那天为准，不把历史上用过的网关都算上", v3["home"].get("u1") == ["网关B"], v3["home"])
check("未来的日子不算", A.gateway_view({"2099-01-01": [gw("u1", "网关Z", 1, 1)]}, TODAY)["home"] == {})

# ---------- [2] 接进状态机 ----------
print("\n[2] 状态机里带上标签")
# u1 天天出单到 D[-3]，之后沉默 → 今天沉默 2 天
spec = {d: [("u1", "a.com", 1000, 10), ("u2", "b.com", 900, 9)] for d in D[:-2]}
spec[D[-2]] = []
spec[TODAY] = []
st = A.assess(days_for(spec), TODAY, None, {"churn": {}},
              gateway={TODAY: [gw("u1", "网关A", 500, 5)]})
check("算得出来", st["ok"], st.get("reason"))
s1 = st["sites"]["u1|a.com"]
s2 = st["sites"]["u2|b.com"]
check("★ u1 网关上还有交易", s1["gw"] == A.GW_OTHER, s1["gw"])
check("★ u2 全网关停止", s2["gw"] == A.GW_ALL_STOP, s2["gw"])
check("命中上也带着", all(h.get("gw") for h in st["hits"]), st["hits"][:1])
st_nogw = A.assess(days_for(spec), TODAY, None, {"churn": {}})
check("★ 不传网关 = 一律「网关数据缺」，不猜",
      {v["gw"] for v in st_nogw["sites"].values()} == {A.GW_MISSING},
      {v["gw"] for v in st_nogw["sites"].values()})
check("状态里说得出「这天没有网关台账」", st_nogw["gateway"]["has_today"] is False)
check("有网关时也说得出", st["gateway"]["has_today"] is True)

# ---------- [3] 通道异常的阈值边界 ----------
print("\n[3] ★ 通道异常：门槛是「家」，边界两侧都钉住")


def incident_state(n_merchants, *, gateway_min=3, top_n=50, sites_each=1, extra_gw=None):
    """n_merchants 家商户同时沉默，都挂在网关A 上。"""
    uids = [f"u{i}" for i in range(1, n_merchants + 1)]
    rows = [(u, f"s{j}.com", 1000 - i * 10, 10) for i, u in enumerate(uids) for j in range(sites_each)]
    sp = {d: list(rows) for d in D[:-2]}
    sp[D[-2]] = []
    sp[TODAY] = []
    gwd = {D[-3]: [gw(u, (extra_gw or {}).get(u, "网关A"), 100, 2) for u in uids], TODAY: []}
    return A.assess(days_for(sp), TODAY, None,
                    {"churn": {"gateway_incident_min": gateway_min, "gateway_incident_top_n": top_n}},
                    gateway=gwd)


s3 = incident_state(3)
check("★ 正好 3 家 → 报", [g["网关"] for g in s3["incidents"]] == ["网关A"], s3["incidents"])
check("数的是家", s3["incidents"][0]["merchants"] == 3, s3["incidents"][0])
s2_ = incident_state(2)
check("★ 只有 2 家 → 不报（边界另一侧）", s2_["incidents"] == [], s2_["incidents"])
s7 = incident_state(2, sites_each=7)
check("★ 2 家 ×7 个站点 = 14 条，仍然不报（按条数的话单个大商户就能判整个网关故障）",
      s7["incidents"] == [], s7["incidents"])
check("门槛可配：调到 2 就报", incident_state(2, gateway_min=2)["incidents"][0]["merchants"] == 2)
mix = incident_state(4, extra_gw={"u4": "网关B"})
check("不同网关各数各的", [(g["网关"], g["merchants"]) for g in mix["incidents"]] == [("网关A", 3)],
      mix["incidents"])

print("\n[3b] 只数排名前 M 的")
s_top = incident_state(3, top_n=2)
check("★ 前 2 名之外的那家不算 → 不够 3 家，不报", s_top["incidents"] == [], s_top["incidents"])
check("top_n=0 = 不限", incident_state(3, top_n=0)["incidents"][0]["merchants"] == 3)

print("\n[3c] 受影响的命中带标签，没受影响的不带")
tagged = [h for h in s3["hits"] if h.get("incident")]
check("★ 三条都带上了网关A", len(tagged) == 3 and all(h["incident"] == ["网关A"] for h in tagged),
      [(h["用户ID"], h["incident"]) for h in s3["hits"]])
check("站点上也带着", s3["sites"]["u1|s0.com"]["incident"] == ["网关A"])
check("不报的那天命中一条标签都没有", all(not h.get("incident") for h in s2_["hits"]))
check("★ 没有网关数据时通道异常算不了，也不报",
      A.assess(days_for({**{d: [("u1", "a.com", 1, 1)] for d in D[:-2]}, D[-2]: [], TODAY: []}),
               TODAY, None, {"churn": {}})["incidents"] == [])

print("\n[3d] 幂等 · 不改输入")
gwd = {D[-3]: [gw("u1", "网关A", 1, 1)]}
before = repr(gwd)
a = A.assess(days_for(spec), TODAY, None, {"churn": {}}, gateway=gwd)
b = A.assess(days_for(spec), TODAY, None, {"churn": {}}, gateway=gwd)
check("两次结果一样", a == b)
check("没动传进来的网关台账", repr(gwd) == before)

# ---------- [4] 配置 ----------
print("\n[4] 配置的容错读法（同其余数字：null 回默认、0 要留住）")
d = C.settings({})
check("默认 3 家 / 前 50", (d["gateway_incident_min"], d["gateway_incident_top_n"]) == (3, 50), d)
check("★ 0 要留住（top_n=0 = 不限）", C.settings({"churn": {"gateway_incident_top_n": 0}})["gateway_incident_top_n"] == 0)
check("null 回默认", C.settings({"churn": {"gateway_incident_min": None}})["gateway_incident_min"] == 3)
check("垃圾回默认", C.settings({"churn": {"gateway_incident_min": "呃"}})["gateway_incident_min"] == 3)
check("状态自己带着这两个（页面上要按它写说明）",
      st["settings"]["gateway_incident_min"] == 3 and st["settings"]["gateway_incident_top_n"] == 50)

# ---------- [5] 播报 ----------
print("\n[5] 群消息：通道异常单独一行，缺数据一个字都不出")
txt = BC.group_text(s3)
check("★ 顶上单独一行通道异常", "⚠ 通道异常：网关A 今天 3 家一起掉" in txt, txt[:160])
check("在标题之后、名单之前",
      txt.index("通道异常：网关A") < txt.index("■"), txt[:200])
check("★ 受影响的那几条各自带标签", txt.count("通道异常：网关A") >= 2, txt)
check("群里不列用户ID 清单（谁受影响看名单）", "u1、u2、u3" not in txt)
check("没有异常时一行都不出", "通道异常" not in BC.group_text(s2_))

print("\n[5b] ★「网关数据缺」是页面的事，群里不写")
check("gw_note 把它吞掉", BC.gw_note({"gw": A.GW_MISSING}) == "")
check("另外两种照写", BC.gw_note({"gw": A.GW_OTHER}) == A.GW_OTHER
      and BC.gw_note({"gw": A.GW_ALL_STOP}) == A.GW_ALL_STOP)
nogw_txt = BC.group_text(st_nogw)
check("★ 群消息里没有「网关数据缺」四个字", "网关数据缺" not in nogw_txt, nogw_txt[:200])
check("但有命中的行照样发", "■" in nogw_txt, nogw_txt[:120])
gw_txt = BC.group_text(st)
check("有网关数据时标签进消息", "全网关停止" in gw_txt or "其他通道仍有交易" in gw_txt, gw_txt[:200])

print("\n[5c] 私聊：只提他名下真的碰上的那些网关")
hits = BC.pushable(s3)
by_owner = BC.group_for_dm(hits)
owner = list(by_owner)[0]
bd = BC.bd_text(owner, by_owner[owner], s3)
check("★ 名下有受影响的 → 提醒先别当商户走了", "通道异常" in bd and "先别当商户走了" in bd, bd[:200])
clean = BC.bd_text("张三", [{"type": "沉默2", "用户ID": "x", "站点": "x.com", "商户名称": "x",
                            "直签人": "张三", "silent_days": 2, "last_active": D[0], "tpv30": 1}], s3)
check("★ 名下没碰上的 → 一个字不提（整个大盘的通道故障关他什么事）",
      "通道异常" not in clean, clean[:200])

print("\n[5d] 老规矩没破")
check("★ 群消息里没有字面量 nan", "nan" not in gw_txt and "nan" not in txt)
check("★ 不出现「工作台」三个字", "工作台" not in txt)
check("★ 不解释阈值口径", "门槛" not in txt and "排名前" not in txt)

# ---------- [6] 常量只有一处 ----------
print("\n[6] 档位名只有一处定义")
check("★ broadcast 的 GW_MISSING 就是 assess 的那个（同一个对象）", BC.GW_MISSING is A.GW_MISSING)
js = (ROOT / "static" / "js" / "churn" / "analyze.js").read_text(encoding="utf-8")
for name in (A.GW_OTHER, A.GW_ALL_STOP, A.GW_MISSING):
    check(f"★ 页面上「{name}」一字不差（对不上就整个标签不显示，还不报错）", f"'{name}'" in js)

# [6b]（底账表的标签列）和 [7]（落盘那条链）2026-09-18 搬到 tests/churn_gateway_io.py：那两段碰 churn.bitable / churn.job，
# 这份要能按 口径清单.json 原样同步到看板仓库跑，只留纯口径。

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
