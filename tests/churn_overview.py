"""
churn_overview.py - 交易大盘的算数（第 14 张票）：趋势、构成、TPV 排名。

    python tests/churn_overview.py     # 零依赖

口径来自第 01 张票那份台账，一行是「某天某个站点」。这里把它汇成三样东西：
每天一个点的序列（趋势）、按维度分组的占比（构成）、按 TPV 降序的商户排名。

⚠ **台账缺哪天，序列里那天必须是 `ok:false`，不能当 0** —— 当 0 会在趋势图上画出一个
  真实存在过的深坑（同 §2.12「算不出来必须 ok:false」）。
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from churn import overview as O  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)) if not cond and extra else ""))
    if not cond:
        fails.append(name)


def d(n):
    return (datetime(2026, 9, 14) + timedelta(days=n)).strftime("%Y-%m-%d")


def row(uid, site, amt, orders=1, mode="标准收银台", owner="张三", name=None, agent=""):
    return {"用户ID": uid, "站点": site, "商户名称": name or ("商户" + uid[-1]), "直签人": owner,
            "代理商ID": "", "代理商名称": agent, "接入模式": mode,
            "交易金额": float(amt), "交易笔数": int(orders)}


# 30 天：A 每天 1000（标准收银台/张三）、B 每天 500（API直连/李四）、C 只在最后 3 天出现
days = {}
for i in range(-29, 1):
    rows = [row("1", "a.com", 1000, 10), row("2", "b.com", 500, 5, "API直连", "李四")]
    if i >= -2:
        rows.append(row("3", "c.com", 2000, 1, "Element", "1909165812357570562", agent="磐嶽公司"))
    days[d(i)] = rows
del days[d(-5)]                      # 台账缺一天

# ---------- [1] 趋势序列 ----------
print("[1] 趋势：每天一个点；台账缺的那天 ok:false，不当 0")
ov = O.build(days, "2026-09-14", 30)
ser = ov["series"]
check("30 个点、从早到晚", len(ser) == 30 and ser[0]["date"] == d(-29) and ser[-1]["date"] == "2026-09-14",
      (len(ser), ser[0]["date"], ser[-1]["date"]))
gap = [x for x in ser if x["date"] == d(-5)][0]
check("★ 缺的那天 ok:false 且 tpv 是 None（不是 0）", gap["ok"] is False and gap["tpv"] is None, gap)
normal = [x for x in ser if x["date"] == d(-10)][0]
check("有数的那天：金额 / 笔数 / 站点数", normal["tpv"] == 1500.0 and normal["orders"] == 15 and normal["sites"] == 2, normal)
last = ser[-1]
check("最后一天带上 C", last["tpv"] == 3500.0 and last["sites"] == 3, last)
check("缺口日期单独列出来", ov["gap"] == [d(-5)], ov["gap"])

# ---------- [2] KPI ----------
print("\n[2] KPI：当日 + 和前一日、前 7 日均值比")
k = ov["kpi"]
check("三个指标都在", sorted(k) == ["orders", "sites", "tpv"], sorted(k))
check("当日 TPV", k["tpv"]["value"] == 3500.0, k["tpv"])
check("前一日也是 3500 → 环比 0", abs(k["tpv"]["dod"]) < 1e-9, k["tpv"])
# 今天之前有数的 7 天：d(-1) d(-2) 是 3500（C 那两天在），d(-3) d(-4) d(-6) d(-7) d(-8) 是 1500
# （d(-5) 缺台账，被跳过 —— 按 7 硬除的话会把它当 0 算进去，均值直接掉一格）
check("★ 前 7 日均值把缺的那天排除在外（不是按 7 天硬除）",
      k["tpv"]["avg7_days"] == 7 and abs(k["tpv"]["avg7"] - (3500 * 2 + 1500 * 5) / 7) < 0.01, k["tpv"])
check("笔数和站点数也各有一份", k["orders"]["value"] == 16 and k["sites"]["value"] == 3, (k["orders"], k["sites"]))
one = O.build({d(0): [row("1", "a.com", 10)]}, "2026-09-14", 30)
check("★ 只有一天时环比算不出来 → None，不是 0", one["kpi"]["tpv"]["dod"] is None, one["kpi"]["tpv"])

# ---------- [3] 构成 ----------
print("\n[3] 构成：按接入模式 / 直签人，占比之和为 1，尾巴折进「其他」")
by = ov["by"]
check("两个维度都在", sorted(by) == ["接入模式", "直签人"], sorted(by))
m = {x["name"]: x for x in by["接入模式"]}
check("★ 按当日算（不是 30 天累计）", m["Element"]["tpv"] == 2000.0 and m["标准收银台"]["tpv"] == 1000.0, m)
check("按 TPV 降序", [x["name"] for x in by["接入模式"]] == ["Element", "标准收银台", "API直连"], [x["name"] for x in by["接入模式"]])
check("占比之和为 1", abs(sum(x["share"] for x in by["接入模式"]) - 1) < 1e-9)
o = {x["name"]: x for x in by["直签人"]}
check("★ 直签人是代理商 ID 时显示成「代理商：磐嶽公司」", "代理商：磐嶽公司" in o, list(o))
many = {d(0): [row(str(i), f"s{i}.com", 100 - i, mode=f"通道{i}") for i in range(10)]}
byx = O.build(many, "2026-09-14", 30)["by"]["接入模式"]
check("★ 超过 6 类时尾巴折进「其他」，不是生成第 7 种颜色",
      len(byx) == 7 and byx[-1]["name"] == "其他" and byx[-1]["n"] == 4, [(x["name"], x.get("n")) for x in byx])
check("「其他」的金额是尾巴之和", abs(byx[-1]["tpv"] - sum(100 - i for i in range(6, 10))) < 1e-9, byx[-1])

# ---------- [4] TPV 排名 ----------
print("\n[4] 排名：按当日 TPV 降序，带环比和站点数")
top = ov["top"]
check("按 TPV 降序", [x["用户ID"] for x in top] == ["3", "1", "2"], [x["用户ID"] for x in top])
check("带商户名、站点数、笔数", top[0]["商户名称"] == "商户3" and top[0]["站点数"] == 1 and top[0]["orders"] == 1, top[0])
check("老商户环比是 0", abs(top[1]["dod"]) < 1e-9, top[1])
# 今天才第一次出现的商户：昨天没有它，环比**算不出来**
fresh = dict(days)
fresh["2026-09-14"] = list(days["2026-09-14"]) + [row("9", "new.com", 50)]
t9 = [x for x in O.build(fresh, "2026-09-14", 30)["top"] if x["用户ID"] == "9"][0]
check("★ 今天才出现的商户环比是 None（不是 +100%）", t9["dod"] is None and t9["prev"] is None, t9)
check("占比也带上", abs(sum(x["share"] for x in top) - 1) < 1e-9)
check("top_n 可调", len(O.build(days, "2026-09-14", 30, top_n=2)["top"]) == 2)
multi = {d(0): [row("1", "a.com", 10), row("1", "b.com", 20)], d(-1): [row("1", "a.com", 5)]}
t2 = O.build(multi, "2026-09-14", 30)["top"][0]
check("★ 同一商户多个站点合起来算（排名是商户级）", t2["tpv"] == 30.0 and t2["站点数"] == 2, t2)

# ---------- [5] 边界 ----------
print("\n[5] 边界：一天都没有 / 那天缺台账")
empty = O.build({}, "2026-09-14", 30)
check("一天都没有：ok:false + 说清楚", empty["ok"] is False and "台账" in empty["reason"], empty)
check("序列仍然给出来（全是 ok:false）", len(empty["series"]) == 30 and all(x["ok"] is False for x in empty["series"]))
miss = O.build({d(-1): [row("1", "a.com", 10)]}, "2026-09-14", 30)
check("★ 当日缺台账：KPI 是 None，不拿前一天冒充", miss["kpi"]["tpv"]["value"] is None and miss["by"] == {} and miss["top"] == [],
      (miss["kpi"]["tpv"], miss["by"]))
check("但序列里前一天还在", any(x["ok"] and x["tpv"] == 10.0 for x in miss["series"]))

print("\n" + ("失败 %d 项: %s" % (len(fails), fails) if fails else "全部通过"))
sys.exit(1 if fails else 0)
