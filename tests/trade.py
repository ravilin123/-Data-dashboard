"""
trade.py - 交易概览页的算数（第 15 张票）：日 / 周 / 月三档 + 构成 + 排名 + 下钻。

    python tests/trade.py        # 零依赖

三条最要紧的：
  ★ **周界用报表自己的（周五 → 周四），周号按结束日算。** 自己按 ISO 周切一遍的话，
    这一页的数和老板手上的报表永远对不上；按起始日算周号会整体差一周，
    而「差一周」在图上完全看不出来（形状一样，只是标错了）。
  ★ **期次走自然序**（§2.9）：`2026 W9` 的字符串排在 `2026 W37` 后面。一律按结束日排。
  ★ **一期缺几天要报出来，不许闷头加**：少三天的一周和完整的一周画在同一条线上，
    看着就是「那周掉了」——而它只是数据没到（§2.12）。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from churn import overview as OV  # noqa: E402
from churn import trade as T  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


def row(uid, site, amt, n=1, mode="标准收银台", owner="赵娜", agent="", name=None):
    return {"用户ID": uid, "站点": site, "商户名称": name or f"商户{uid}", "直签人": owner,
            "代理商ID": "", "代理商名称": agent, "接入模式": mode,
            "交易金额": float(amt), "交易笔数": int(n)}


# 报表的两个真期次（周五 → 周四）
W36 = {"期次": "2026 W36 (2026-08-28~2026-09-03)", "start": "2026-08-28", "end": "2026-09-03", "complete": True, "rows": []}
W37 = {"期次": "2026 W37 (2026-09-04~2026-09-10)", "start": "2026-09-04", "end": "2026-09-10", "complete": True,
       "rows": [row("u1", "a.com", 7000, 70)]}

# ---------- [1] 周界 ----------
print("[1] ★ 周界是周五 → 周四，从报表自己的期次里读")
check("锚点从周台账投票出来（周五=4）", T.anchor_from_ledger([W36, W37]) == 4, T.anchor_from_ledger([W36, W37]))
check("一份周台账都没有时回落到周五", T.anchor_from_ledger([]) == T.WEEK_ANCHOR == 4)
check("垃圾期次不投票、也不炸", T.anchor_from_ledger([{"start": None}, {"start": "呃"}]) == 4)
b = T.bucket_of("2026-09-08", "周", 4)
check("★ 09-08（周二）落在 09-04~09-10 这一周", (b["start"], b["end"]) == ("2026-09-04", "2026-09-10"), b)
check("★ 周号按**结束日**算 → W37，和报表一致（按起始日算是 W36，整体差一周）",
      "W37" in b["label"], b["label"])
check("周一也落在同一周", T.bucket_of("2026-09-07", "周", 4)["end"] == "2026-09-10")
check("周四是这一周的最后一天", T.bucket_of("2026-09-10", "周", 4)["end"] == "2026-09-10")
check("★ 周五是下一周的第一天（边界另一侧）", T.bucket_of("2026-09-11", "周", 4)["start"] == "2026-09-11")
check("锚点可调：周一开始时 09-08 落在 09-07~09-13",
      T.bucket_of("2026-09-08", "周", 0)["start"] == "2026-09-07")
check("日档就是那天自己", T.bucket_of("2026-09-14", "日")["start"] == "2026-09-14")
m = T.bucket_of("2026-09-14", "月")
check("月档是自然月", (m["start"], m["end"], m["label"]) == ("2026-09-01", "2026-09-30", "2026-09"), m)
check("跨年的月也对", T.bucket_of("2026-12-31", "月")["end"] == "2026-12-31")
check("二月", T.bucket_of("2026-02-10", "月")["end"] == "2026-02-28")

print("\n[1b] ★ 能对上报表的那几期用报表**原话**")
rl = T.relabel([T.bucket_of("2026-09-08", "周", 4), T.bucket_of("2026-09-15", "周", 4)], [W36, W37])
check("对得上的换成原话", rl[0]["label"] == W37["期次"] and rl[0]["from_report"] is True, rl[0])
check("对不上的保留自己拼的，并标出来", rl[1]["from_report"] is False and "W38" in rl[1]["label"], rl[1])
check("一份都没有时全保留自己拼的", all(not x["from_report"] for x in T.relabel(rl, [])))

print("\n[2] ★ 期次走自然序：W9 不许排到 W37 后面")
ps = T.periods_back("2026-09-14", "周", 5, 4)
check("按结束日升序", [p["end"] for p in ps] == sorted(p["end"] for p in ps), [p["end"] for p in ps])
check("正好 5 期、互不重复", len(ps) == 5 and len({p["key"] for p in ps}) == 5, [p["key"] for p in ps])
check("最后一期包含 date", ps[-1]["start"] <= "2026-09-14" <= ps[-1]["end"], ps[-1])
# ⚠ 自己拼的 label 是 `W%02d` 补零的，字面序碰巧等于自然序 —— 拿它测排序**测不出东西**
#   （退回成按 label 排，用例照样是绿的，验过）。报表那种**不补零**的期次才暴露得出来：
#   「2026 W9」的字符串排在「2026 W37」后面（§2.9 那条）。
FAKE = [{"期次": "2026 W9 (2026-02-27~2026-03-05)", "start": "2026-02-27", "end": "2026-03-05", "complete": True, "rows": []},
        {"期次": "2026 W37 (2026-09-04~2026-09-10)", "start": "2026-09-04", "end": "2026-09-10", "complete": True, "rows": []}]
mixed = T.relabel([T.bucket_of("2026-03-01", "周", 4), T.bucket_of("2026-09-08", "周", 4)], FAKE)
check("两期都换成了报表原话（不补零的那种）",
      [m["label"] for m in mixed] == [FAKE[0]["期次"], FAKE[1]["期次"]], [m["label"] for m in mixed])
check("★ 按 label 的字面序排会把 W9 排到 W37 后面（这就是要避开的那件事）",
      [m["end"] for m in sorted(mixed, key=lambda x: x["label"])] == ["2026-09-10", "2026-03-05"],
      [m["label"] for m in sorted(mixed, key=lambda x: x["label"])])
check("★ 代码排出来的是自然序（按结束日）",
      [m["end"] for m in sorted(mixed, key=lambda x: x["key"])] == ["2026-03-05", "2026-09-10"])
early = T.periods_back("2026-03-05", "周", 3, 4)
check("periods_back 出来就是按结束日升序",
      [p["end"] for p in early] == sorted(p["end"] for p in early), [p["label"] for p in early])
check("★ 它排的 key 就是结束日，不是 label",
      all(p["key"] == p["end"] for p in early), [(p["key"], p["end"]) for p in early])
check("日档 5 期就是 5 天", [p["key"] for p in T.periods_back("2026-09-14", "日", 5)]
      == ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"])
check("月档 3 期是三个月", [p["label"] for p in T.periods_back("2026-09-14", "月", 3)]
      == ["2026-07", "2026-08", "2026-09"])

# ---------- [3] 一期缺几天 ----------
print("\n[3] ★ 缺几天要报出来，不许闷头加")
days = {d: [row("u1", "a.com", 100, 1)] for d in
        ("2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07")}      # 只有 4/7 天
pts = T.series(days, [T.bucket_of("2026-09-08", "周", 4)])
check("★ 有数的那几天照加（4 天 × 100）", pts[0]["tpv"] == 400.0, pts[0])
check("★ 但要说清楚只有 4/7 天", (pts[0]["days"], pts[0]["span"], len(pts[0]["gap"])) == (4, 7, 3), pts[0])
check("ok 仍然是 true（有数就算得出来）", pts[0]["ok"] is True)
empty = T.series({}, [T.bucket_of("2026-09-08", "周", 4)])
check("★ 一天都没有 → ok:false，值是 None **不是 0**",
      empty[0]["ok"] is False and empty[0]["tpv"] is None, empty[0])
check("日档缺那天同理", T.series({}, [T.bucket_of("2026-09-14", "日")])[0]["tpv"] is None)

# ---------- [4] 构成：按金额 / 按笔数 ----------
print("\n[4] ★ 换成「按笔数」时，排序和占比都跟着换")
mix = [row("u1", "a.com", 10000, 5, mode="Element"),
       row("u2", "b.com", 100, 500, mode="API直连"),
       row("u3", "c.com", 50, 3, mode="标准收银台")]
total = 10150.0
by_tpv = OV.group_by(mix, lambda r: r["接入模式"], total, "tpv")
by_n = OV.group_by(mix, lambda r: r["接入模式"], total, "orders")
check("按金额排：Element 第一", [g["name"] for g in by_tpv][0] == "Element", [g["name"] for g in by_tpv])
check("★ 按笔数排：API直连 第一（不是只换个分母 —— 排序也换了）",
      [g["name"] for g in by_n][0] == "API直连", [g["name"] for g in by_n])
check("★ 占比也按当前指标算", abs(by_n[0]["share"] - 500 / 508) < 1e-6, by_n[0]["share"])
check("两个指标的值都带着（表格视图要）", by_n[0]["tpv"] == 100.0 and by_tpv[0]["orders"] == 5)
many = [row(f"u{i}", f"s{i}.com", 100 - i, 1, mode=f"模式{i}") for i in range(9)]
g9 = OV.group_by(many, lambda r: r["接入模式"], sum(float(r["交易金额"]) for r in many))
check("★ 超过 6 类折进「其他」，不生成第 7 种颜色", len(g9) == 7 and g9[-1]["name"] == "其他", [x["name"] for x in g9])
check("「其他」带着折了几类", g9[-1]["n"] == 3, g9[-1])
# 每段各自 round 到 6 位，7 段累起来最多差 7×0.5e-6 —— 容差按段数给，别写死 1e-6
check("占比加起来是 1（容差按段数算）", abs(sum(x["share"] for x in g9) - 1) < len(g9) * 5e-7,
      sum(x["share"] for x in g9))

# ---------- [5] 整块 ----------
print("\n[5] build：三档 + 四块构成 + 排名 + 校验")
full = {}
for i, d in enumerate(("2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07",
                       "2026-09-08", "2026-09-09", "2026-09-10")):
    full[d] = [row("u1", "a.com", 1000, 10, mode="Element", agent="磐嶽"),
               row("u2", "b.com", 500, 50, mode="API直连")]
out = T.build(full, "2026-09-10", "周", 3, "tpv", 10, anchor=4, weeks=[W36, W37])
check("算得出来", out["ok"], out.get("reason"))
check("★ 当期是 W37、用的是报表原话", out["current"]["label"] == W37["期次"], out["current"]["label"])
check("周 TPV = 7 天 ×1500", out["current"]["tpv"] == 10500.0, out["current"]["tpv"])
check("★ 四块构成都在，顺序走数组",
      list(out["by"]) == ["接入模式", "直签人", "代理商", "商户"], list(out["by"]))
check("代理商那块把直签的单列", {g["name"] for g in out["by"]["代理商"]} == {"磐嶽", "直签"},
      [g["name"] for g in out["by"]["代理商"]])
check("排名是商户级", len(out["top"]) == 2 and out["top"][0]["站点数"] == 1, out["top"][:1])
check("★ 校验：报表说 7000、台账算出 7000×?（对不上就报出来，不改数）",
      out["check"] and out["check"]["期次"] == W37["期次"], out["check"])
check("对不上时 `同` 是 False，且差额带出来",
      out["check"]["同"] is False and out["check"]["差"] == 10500.0 - 7000.0, out["check"])
same = T.check_against_report({**out["current"], "tpv": 7000.0}, [W37])
check("对得上时 `同` 是 True", same["同"] is True, same)
check("没走完的那一期不参与校验", T.check_against_report(out["current"], [{**W37, "complete": False}]) is None)
check("日档也跑得动", T.build(full, "2026-09-10", "日", 3, "orders", 5, anchor=4, weeks=[])["ok"])
check("★ 非法 period / metric 回落到默认，不炸",
      T.build(full, "2026-09-10", "年", 3, "呃", 5, anchor=4, weeks=[])["period"] == "日")
check("★ 幂等", T.build(full, "2026-09-10", "周", 3, "tpv", 10, anchor=4, weeks=[W36, W37]) == out)
check("空台账说人话", "先灌数" in T.build({}, "2026-09-10", "周", 3, weeks=[])["reason"])
check("★ 这一期一天都没有时说清楚，不给一个 0",
      T.build(full, "2026-12-31", "周", 3, anchor=4, weeks=[])["ok"] is False)

# ---------- [6] 下钻 ----------
print("\n[6] 下钻：站点明细 + 筛选（维度只有一处）")
dd = T.drill(full, "2026-09-10", "周", {}, "tpv", anchor=4)
check("★ 站点级，不合并", dd["total"]["sites"] == 2 and len(dd["rows"]) == 2, dd["total"])
check("一期里的天数合起来", dd["rows"][0]["tpv"] == 7000.0 and dd["rows"][0]["days"] == 7, dd["rows"][0])
check("按当前指标排", dd["rows"][0]["站点"] == "a.com")
check("★ 按笔数排就换了个头名",
      T.drill(full, "2026-09-10", "周", {}, "orders", anchor=4)["rows"][0]["站点"] == "b.com")
one = T.drill(full, "2026-09-10", "周", {"接入模式": "Element"}, anchor=4)
check("单维筛", [r["站点"] for r in one["rows"]] == ["a.com"], one["rows"])
check("★ 多维是「与」不是「或」",
      T.drill(full, "2026-09-10", "周", {"接入模式": "Element", "代理商": "直签"}, anchor=4)["rows"] == [])
check("关键词找商户名 / 站点 / 用户ID，不分大小写",
      len(T.drill(full, "2026-09-10", "周", {"kw": "B.COM"}, anchor=4)["rows"]) == 1)
check("筛不到时是空表，不是报错", T.drill(full, "2026-09-10", "周", {"kw": "没有这个"}, anchor=4)["rows"] == [])
check("★ 筛选维度只有一处（后端这份是唯一真相源）",
      T.DRILL_KEYS == ["接入模式", "直签人", "代理商", "商户", "kw"], T.DRILL_KEYS)

print("\n[6b] ★ 截断要自报")
big = {"2026-09-10": [row(f"u{i}", f"s{i}.com", 1000 - i, 1) for i in range(12)]}
cut = T.drill(big, "2026-09-10", "日", {}, "tpv", limit=5)
check("只列了 5 行", len(cut["rows"]) == 5)
check("★ 剩下几行、多少钱都说出来", cut["truncated"]["n"] == 7 and cut["truncated"]["tpv"] > 0, cut["truncated"])
check("★ 合计是**全部**的，不是这张表的", cut["total"]["sites"] == 12, cut["total"])
check("没截断时不写那句", T.drill(big, "2026-09-10", "日", {}, "tpv", limit=50)["truncated"] is None)

print("\n[6c] 下拉的可选值从数据里数出来")
o = T.options(full, "2026-09-10", "周", anchor=4)
check("每一维都有（kw 除外）", set(o) == set(T.DRILL_KEYS) - {"kw"}, list(o))
check("按出现次数降序、带计数", o["接入模式"][0]["count"] == 7, o["接入模式"])

# ---------- [7] 复用，不是第二份 ----------
print("\n[7] ★ 口径层是复用的，不是第二份")
src = (ROOT / "churn" / "trade.py").read_text(encoding="utf-8")
check("★ 分组走 overview.group_by", "ov.group_by(" in src)
check("★ 排名走 overview.top_merchants", "ov.top_merchants(" in src)
check("★ 直签人显示走 overview.owner_label", "ov.owner_label" in src)
check("★ 当日合计走 overview._day_totals", "ov._day_totals(" in src)
check("没有自己再写一份分组", "def _group" not in src and "def group_by" not in src)
check("老名字还在（一处定义、两个名字）", OV._group is OV.group_by and OV._top is OV.top_merchants)

print("\n[8] 页面那几个纯函数")
js = subprocess.run(["node", "-e", """
import('%s/static/js/trade/analyze.js').then(A => {
  const s = [{label:'a',ok:true,tpv:10,orders:2,gap:[],days:1,span:1},
             {label:'b',ok:true,tpv:20,orders:1,gap:['x'],days:6,span:7},
             {label:'c',ok:false,tpv:null,orders:null,gap:['y'],days:0,span:7}];
  console.log(JSON.stringify({
    periods: A.PERIODS, metrics: A.METRICS.map(m=>m[0]), dims: A.COMP_DIMS,
    v: [A.valueOf(s[0],'tpv'), A.valueOf(s[0],'orders'), A.valueOf(s[2],'tpv')],
    gaps: s.map(A.gapNote),
    partial: A.partialCount(s),
    dod: [A.dod(s.slice(0,2),'tpv'), A.dod([s[0]],'tpv'), A.dod([s[2],s[0]],'tpv')],
    keys: [A.drillKeys(null), A.drillKeys({keys:['x']})],
    chips: A.activeFilters({'接入模式':'Element', 商户:'', kw:'abc'}, A.DRILL_FALLBACK).map(c=>c.label),
    check: [A.checkNote(null), A.checkNote({期次:'W37',同:true}), A.checkNote({期次:'W37',同:false,差:-1234})],
    reuse: [typeof A.lineGeom, typeof A.colorAt, typeof A.money],
  }));
});
""" % ROOT], capture_output=True, text=True)
if js.returncode:
    check("node 跑得起来", False, js.stderr[:400])
else:
    j = json.loads(js.stdout)
    check("★ 三档周期的字面量和 Python 一字不差（对不上接口会 400，界面上像「点了没反应」）",
          j["periods"] == T.PERIODS, (j["periods"], T.PERIODS))
    check("★ 两个指标也一字不差", j["metrics"] == T.METRICS, (j["metrics"], T.METRICS))
    check("构成四块，顺序走数组", j["dims"] == ["接入模式", "直签人", "代理商", "商户"], j["dims"])
    check("★ 算不出来给 null 不给 0", j["v"] == [10, 2, None], j["v"])
    check("★ 缺几天的话说出来", j["gaps"][0] == "" and "6/7" in j["gaps"][1]
          and "一天都没有" in j["gaps"][2], j["gaps"])
    check("数得出有几期不全", j["partial"] == 1, j["partial"])
    check("★ 环比：上一期算不出来时给 null，不是 +100%",
          j["dod"][0] == 1 and j["dod"][1] is None and j["dod"][2] is None, j["dod"])
    check("★ 筛选维度以接口带回来的为准，读不到才用兜底",
          j["keys"][0] == T.DRILL_KEYS and j["keys"][1] == ["x"], j["keys"])
    check("★ 空串不算在筛（不然「清空」按钮一直挂着）", len(j["chips"]) == 2, j["chips"])
    check("校验那句人话：对得上 / 对不上 / 没有", j["check"][0] == ""
          and "对得上" in j["check"][1] and "⚠" in j["check"][2], j["check"])
    check("★ 几何和配色是**从第 14 张票那层 re-export** 的，不是新写的",
          j["reuse"] == ["function", "function", "function"], j["reuse"])

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
