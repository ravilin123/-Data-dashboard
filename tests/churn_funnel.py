"""
churn_funnel.py - 生命周期漏斗头（第 09 张票）。

    python tests/churn_funnel.py       # 零依赖

前三级来自出单监控报表的三个时间（提交 / 通道反馈 / 第一笔成功交易），后两级来自流失状态。

两条最要紧的：
  ★ **算不出来写「算不出」，不当 0。** 起点缺 / 终点还没到 / 终点早于起点，
    三种都不进分母，而且**各自数了多少行要报出来** —— 不报的话，一个中位数背后是 3 行
    还是 300 行，看的人无从判断（同坑.md §2.18 那六列 0 的四种意思）。
  ★ **一张表一把尺子。** 这里全是自然日（含周末）；报表自带那六列是小时·不含节假日，
    实测同一行自己相减偏大三成，两边不可比。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from churn import funnel as F  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


def row(uid, site, submit="", approve="", first=""):
    return {"用户ID": uid, "站点": site, "商户名称": f"商户{uid}", "直签人": "赵娜",
            F.D_SUBMIT: submit, F.D_APPROVE: approve, F.D_FIRST: first}


TODAY = "2026-09-14"

# ---------- [1] 五级 ----------
print("[1] 五级：注册 → 开通 → 首单 → 稳定出单 → 沉默")
det = [
    row("1", "a.com", "2026-08-01", "2026-08-05", "2026-08-10"),   # 走完，状态说在出单
    row("1", "a2.com", "2026-08-01", "2026-08-05", "2026-08-12"),  # 走完，状态说沉默
    row("2", "b.com", "2026-08-01", "2026-08-20"),                 # 通过了没首单
    row("3", "c.com", "2026-08-01"),                               # 提交了没通过
    row("4", "d.com"),                                             # 连提交日期都没有
]
st = {"sites": {"1|a.com": {"silent_days": 0}, "1|a2.com": {"silent_days": 9}},
      "settings": {"silence_days": [2, 7, 30]}}
f = F.build(det, st, date=TODAY)
lv = {x["name"]: x for x in f["levels"]}
check("★ 顺序走数组，五级都在", [x["name"] for x in f["levels"]] == F.LEVELS, [x["name"] for x in f["levels"]])
check("★ 没有提交日期的那行一级都不进", lv["注册"]["sites"] == 4, lv["注册"])
check("开通 3 个站点", lv["开通"]["sites"] == 3, lv["开通"])
check("首单 2 个站点", lv["首单"]["sites"] == 2, lv["首单"])
check("★ 稳定出单 1 / 沉默 1（后两级来自流失状态）",
      (lv["稳定出单"]["sites"], lv["沉默"]["sites"]) == (1, 1), (lv["稳定出单"], lv["沉默"]))
check("★ 家数和站点数都给（一家两个站点算 1 家 2 个站点）",
      lv["首单"]["merchants"] == 1 and lv["首单"]["sites"] == 2, lv["首单"])
check("门槛跟着配置走", F.build(det, {**st, "settings": {"silence_days": [30]}}, date=TODAY)["tier"] == 30)

print("\n[1b] ★ 状态里没有它 ≠ 它在稳定出单")
f2 = F.build(det, {"sites": {}, "settings": {"silence_days": [2]}}, date=TODAY)
lv2 = {x["name"]: x for x in f2["levels"]}
check("★ 稳定出单是 0，不是 2（台账还没覆盖到，不等于它在正常出单）",
      lv2["稳定出单"]["sites"] == 0 and lv2["沉默"]["sites"] == 0, (lv2["稳定出单"], lv2["沉默"]))
check("★ 那两个站点单独报出来，不是消失", f2["uncovered"]["sites"] == 2, f2["uncovered"])
check("有状态时 uncovered 是 0", f["uncovered"]["sites"] == 0, f["uncovered"])
check("完全没有状态也不炸", F.build(det, None, date=TODAY)["ok"] is True)

# ---------- [2] 耗时：四种情况分开 ----------
print("\n[2] ★ 算不出来不当 0；三种排除各自数出来")
s0 = f["steps"][0]
check("注册 → 开通 这一段", (s0["from"], s0["to"]) == ("注册", "开通"))
check("★ 样本只有真算得出来的那 3 行", s0["n"] == 3, s0)
check("中位是 4 天（4 / 4 / 19）", s0["median"] == 4.0, s0)
check("★ 终点还没到的那行单独数（c.com）", s0["no_end"] == 1, s0)
check("★ 起点缺的那行单独数（d.com）", s0["no_start"] == 1, s0)

neg = [row("9", "z.com", "2026-08-10", "2026-08-01")]      # 终点早于起点
sn = F.step_stats(neg, F.D_SUBMIT, F.D_APPROVE)
check("★ 终点早于起点：算不出，不进分母，也不当 0", sn["n"] == 0 and sn["negative"] == 1, sn)
check("★ 一个样本都没有时中位是 None，不是 0", sn["median"] is None, sn["median"])
check("中位数：空 → None", F.median([]) is None)
check("中位数：偶数个取中间两个的平均", F.median([1, 3]) == 2.0 and F.median([1, 2, 3]) == 2.0)
check("分位", F.step_stats(det, F.D_SUBMIT, F.D_APPROVE)["p75"] == 19.0)
check("★ 尺子自己说得出来", s0["ruler"] == F.RULER and "自然日" in F.RULER and "周末" in F.RULER, F.RULER)

print("\n[2b] 日期读法")
check("空串 / None / 垃圾都算没有", F.gap_days("", "2026-09-01") is None
      and F.gap_days(None, "2026-09-01") is None and F.gap_days("呃", "2026-09-01") is None)
check("带时分秒的只取前十位", F.gap_days("2026-09-01 10:00:00", "2026-09-03") == 2)
check("★ 终点早于起点 → None，不给负数也不给 0", F.gap_days("2026-09-03", "2026-09-01") is None)
check("同一天 → 0（这是真的 0）", F.gap_days("2026-09-01", "2026-09-01") == 0)

# ---------- [3] 卡在路上的 ----------
print("\n[3] 卡在路上的：已等多久按**报表自己那天**算")
stuck = {x["name"]: x for x in f["stuck"]}
check("提交了没通过 1 个", stuck["提交了没通过"]["sites"] == 1, stuck["提交了没通过"])
check("★ 已等 44 天（08-01 → 09-14），按报表那天不是按今天",
      stuck["提交了没通过"]["median"] == 44.0, stuck["提交了没通过"])
check("通过了没首单 1 个、已等 25 天", (stuck["通过了没首单"]["sites"], stuck["通过了没首单"]["median"]) == (1, 25.0),
      stuck["通过了没首单"])
f_old = F.build(det, st, date="2026-09-01")
check("★ 换一份老台账，等待天数跟着变小（拿今天当终点会把每行都多算）",
      {x["name"]: x["median"] for x in f_old["stuck"]}["提交了没通过"] == 31.0, f_old["stuck"])
check("都走完了就没有卡住的", all(x["sites"] == 0 for x in
                                  F.build([det[0]], st, date=TODAY)["stuck"]))

print("\n[3b] 幂等 · 不改输入")
before = repr(det)
check("两次结果一样", F.build(det, st, date=TODAY) == f)
check("没动传进来的明细", repr(det) == before)
check("空输入不炸", F.build([], None)["ok"] is True and F.build(None, None)["levels"][0]["sites"] == 0)
check("用户ID 或站点缺的行整行不算", F.build([{"用户ID": "", "站点": "x", F.D_SUBMIT: "2026-08-01"}],
                                              None)["levels"][0]["sites"] == 0)

# ---------- [4] 页面那边 ----------
print("\n[4] 页面：筛选维度只有一处、掉量三档、「算不出」不写 0")
import json  # noqa: E402
import subprocess  # noqa: E402

js = subprocess.run(["node", "-e", """
import('%s/static/js/churn/analyze.js').then(A => {
  const rows = [
    {'用户ID':'1','站点':'a.com','商户名称':'甲','直签人':'张三','接入模式':'Element',type:'沉默2'},
    {'用户ID':'2','站点':'b.com','商户名称':'乙','直签人':'张三','接入模式':'标准收银台',type:'掉量·推'},
    {'用户ID':'3','站点':'c.com','商户名称':'丙','直签人':'1909165812357570562','代理商名称':'磐嶽','接入模式':'Element',type:'沉默2'},
  ];
  const out = {
    keys: A.FILTER_KEYS,
    metaKeys: Object.keys(A.FILTER_META),
    owners: A.filterOptions(rows, 'owner'),
    types: A.filterOptions(rows, 'type'),
    byOwner: A.applyFilter(rows, {owner:'张三'}).map(r => r['站点']),
    byTwo: A.applyFilter(rows, {owner:'张三', mode:'Element'}).map(r => r['站点']),
    byKw: A.applyFilter(rows, {kw:'丙'}).map(r => r['站点']),
    byKwSite: A.applyFilter(rows, {kw:'B.COM'}).map(r => r['站点']),
    none: A.applyFilter(rows, {}).length,
    filtered: [A.isFiltered({}), A.isFiltered({owner:''}), A.isFiltered({owner:'张三'})],
    dropTypes: A.DROP_TYPES,
    days: [A.fmtDays(null), A.fmtDays(undefined), A.fmtDays(0), A.fmtDays(4.4)],
  };
  console.log(JSON.stringify(out));
});
""" % ROOT], capture_output=True, text=True)
if js.returncode:
    check("node 跑得起来", False, js.stderr[:400])
else:
    j = json.loads(js.stdout)
    check("★ 筛选维度只有 FILTER_KEYS 一处，FILTER_META 一一对上",
          sorted(j["keys"]) == sorted(j["metaKeys"]), (j["keys"], j["metaKeys"]))
    check("取值按出现次数降序、带计数", [o["value"] for o in j["owners"]][0] == "张三"
          and j["owners"][0]["count"] == 2, j["owners"])
    check("★ 类型显示人话，不是内部名「沉默2」",
          all(o["label"] != o["value"] or "沉默" not in o["value"] for o in j["types"])
          and any(o["label"] == "沉默满 2 天" for o in j["types"]), j["types"])
    check("代理商直签人不按 19 位 ID 分组", any(o["value"].startswith("代理商") for o in j["owners"]), j["owners"])
    check("单维筛", j["byOwner"] == ["a.com", "b.com"], j["byOwner"])
    check("★ 多维是「与」不是「或」", j["byTwo"] == ["a.com"], j["byTwo"])
    check("关键词找商户名", j["byKw"] == ["c.com"], j["byKw"])
    check("★ 关键词不分大小写、也找站点", j["byKwSite"] == ["b.com"], j["byKwSite"])
    check("没筛就是全部", j["none"] == 3)
    check("★ 空串不算在筛（不然「清空」按钮一直挂着）", j["filtered"] == [False, False, True], j["filtered"])
    check("★ 掉量三档分开（推 / 页面 / 已关闭）",
          j["dropTypes"] == ["掉量·推", "掉量·页面", "掉量关闭"], j["dropTypes"])
    check("★ 算不出来写「算不出」，0 是真的 0",
          j["days"] == ["算不出", "算不出", "0 天", "4 天"], j["days"])

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
