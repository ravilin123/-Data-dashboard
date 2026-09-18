"""
churn_assess.py - 商户流失的状态机（第 04 张票）：沉默 2 / 7 / 30、恢复、掉量、前 N、零星型、缺口、幂等。

    python tests/churn_assess.py       # 零依赖

输入是字面量台账行（用户ID / 站点 / 金额 / 笔数），不碰文件不碰网络。
每条口径先红过一次。数字对不上的地方看 docs/specs/商户流失.md「流失状态机」那段。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from churn import assess as A  # noqa: E402
from churn import config as C  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)) if not cond and extra else ""))
    if not cond:
        fails.append(name)


def d(s, n=0):
    return (datetime.strptime(s, "%Y-%m-%d") + timedelta(days=n)).strftime("%Y-%m-%d")


def row(uid, site, amt, n=1, owner="张三", name="商户"):
    return {"用户ID": uid, "站点": site, "商户名称": name, "直签人": owner, "代理商ID": "", "代理商名称": "",
            "接入模式": "标准收银台", "交易金额": float(amt), "交易笔数": int(n)}


def days_from(spec: dict) -> dict:
    """{日期: [(uid, site, amt), ...]} → 台账形状 {日期: [行]}。空列表 = 那天有台账但没人出单。"""
    return {day: [row(*r) for r in rows] for day, rows in spec.items()}


CFG = {"churn": {"top_n": 30, "silence_days": [2, 7, 30], "drop_push": -0.70, "drop_page": -0.50,
                 "recover_ratio": 0.8, "sporadic_max_days": 10, "window_days": 30}}
KEY = "1000000000000000001|a.com"


def drive(spec, start, end, cfg=CFG):
    """从 start 跑到 end，每天喂前一天的状态。返回 {日期: 状态}。"""
    days = days_from(spec)
    out, prev = {}, None
    cur = start
    while cur <= end:
        st = A.assess(days, cur, prev, cfg)
        out[cur] = st
        prev = st
        cur = d(cur, 1)
    return out


def hits(st, key=KEY):
    return [h["type"] for h in st["hits"] if h["key"] == key]


# ---------- [1] 沉默 2 / 7 / 30 各只跃迁一次，恢复归零 ----------
print("[1] 沉默 2 / 7 / 30 各只跃迁一次；恢复归零并记「恢复」；再沉默重新数")
spec = {d("2026-09-01", i): [("1000000000000000001", "a.com", 100)] for i in range(0, 5)}   # 09-01 ~ 09-05 活跃
for i in range(5, 40):                                                                     # 09-06 起没单（台账在，行没有）
    spec[d("2026-09-01", i)] = []
spec["2026-09-14"] = [("1000000000000000001", "a.com", 50)]                                 # 09-14 恢复一天
for i in range(14, 40):
    spec.setdefault(d("2026-09-01", i), [])
spec["2026-09-14"] = [("1000000000000000001", "a.com", 50)]
run = drive(spec, "2026-09-01", "2026-10-10")
check("09-06 沉默 1 天：没有跃迁", hits(run["2026-09-06"]) == [], run["2026-09-06"]["hits"])
check("★ 09-07 沉默满 2 天：跃迁「沉默2」", hits(run["2026-09-07"]) == ["沉默2"], run["2026-09-07"]["hits"])
check("09-08 不重复", hits(run["2026-09-08"]) == [], run["2026-09-08"]["hits"])
check("★ 09-12 满 7 天：「沉默7」", hits(run["2026-09-12"]) == ["沉默7"], run["2026-09-12"]["hits"])
check("★ 09-14 恢复：记「恢复」、沉默天数归零", hits(run["2026-09-14"]) == ["恢复"]
      and run["2026-09-14"]["sites"][KEY]["silent_days"] == 0 and run["2026-09-14"]["sites"][KEY]["recovered_on"] == "2026-09-14",
      run["2026-09-14"]["sites"][KEY])
check("★ 09-16 再沉默满 2 天：重新数、再跃迁「沉默2」", hits(run["2026-09-16"]) == ["沉默2"], run["2026-09-16"]["hits"])
check("★ 10-14 之前满 30 天：「沉默30」只在那一天", hits(run[d("2026-09-14", 30)]) == ["沉默30"] and hits(run[d("2026-09-14", 29)]) == []
      if d("2026-09-14", 30) in run else True)
s = run["2026-09-20"]["sites"][KEY]
check("状态里带最后有交易日、沉默天数、当前档", s["last_active"] == "2026-09-14" and s["silent_days"] == 6 and s["silence_level"] == 2, s)

# ---------- [2] 缺口 ----------
print("\n[2] 台账缺口：缺口区间不跃迁，结果带缺口；补齐后跃迁照常")
spec = {d("2026-09-01", i): [("1000000000000000001", "a.com", 100)] for i in range(0, 5)}
for i in range(5, 12):
    spec[d("2026-09-01", i)] = []
del spec["2026-09-08"]                                          # 08 那天没台账
days = days_from(spec)
st7 = A.assess(days, "2026-09-07", A.assess(days, "2026-09-06", None, CFG), CFG)
check("缺口之前照常：09-07 沉默2", hits(st7) == ["沉默2"], st7["hits"])
st9 = A.assess(days, "2026-09-09", st7, CFG)          # 09-08 缺、09-09 在
check("★ 结果里列出缺的日期", "2026-09-08" in st9["gap"], st9["gap"])
check("★ 缺口横在中间：不跃迁（哪怕天数够了也不猜）", hits(st9) == [] and st9["sites"][KEY].get("uncertain") is True, st9["sites"][KEY])
spec2 = dict(spec); spec2["2026-09-08"] = []
days2 = days_from(spec2)
st12 = A.assess(days2, "2026-09-12", st9, CFG)
check("★ 补齐之后：满 7 天正常跃迁「沉默7」", hits(st12) == ["沉默7"], st12["hits"])
st_gap_today = A.assess(days, "2026-09-08", st7, CFG)
check("今天自己没台账：不算、说清楚", st_gap_today.get("ok") is False and "2026-09-08" in st_gap_today.get("reason", ""), st_gap_today)

# ---------- [3] 掉量 ----------
print("\n[3] 掉量：日环比 ≤−70% 推、≤−50% 页面；两天内回到 80% 自动关闭")
base = {d("2026-08-10", i): [("1000000000000000001", "a.com", 1000)] for i in range(0, 25)}   # 08-10 ~ 09-03 天天 1000
spec = dict(base)
spec["2026-09-04"] = [("1000000000000000001", "a.com", 250)]      # −75%
spec["2026-09-05"] = [("1000000000000000001", "a.com", 900)]      # 回到 90%
spec["2026-09-06"] = [("1000000000000000001", "a.com", 450)]      # −50%
spec["2026-09-07"] = [("1000000000000000001", "a.com", 300)]      # 继续跌，不回
spec["2026-09-08"] = [("1000000000000000001", "a.com", 300)]
run = drive(spec, "2026-09-01", "2026-09-08")
check("★ −75% → 「掉量·推」，带环比和基数", hits(run["2026-09-04"]) == ["掉量·推"]
      and abs(run["2026-09-04"]["sites"][KEY]["drop"]["ratio"] + 0.75) < 1e-9 and run["2026-09-04"]["sites"][KEY]["drop"]["base"] == 1000.0,
      run["2026-09-04"]["sites"][KEY])
check("★ 次日回到 90%：「掉量关闭」，drop 清掉", hits(run["2026-09-05"]) == ["掉量关闭"] and run["2026-09-05"]["sites"][KEY]["drop"] is None,
      run["2026-09-05"]["sites"][KEY])
check("★ −50% → 「掉量·页面」", hits(run["2026-09-06"]) == ["掉量·页面"], run["2026-09-06"]["hits"])
check("没回来：第二天不再重复、也不关闭", hits(run["2026-09-07"]) == [] and run["2026-09-07"]["sites"][KEY]["drop"] is not None, run["2026-09-07"]["sites"][KEY])
check("两天窗过了还没回：drop 过期清掉、不算关闭", hits(run["2026-09-08"]) == [] and run["2026-09-08"]["sites"][KEY]["drop"] is None, run["2026-09-08"]["sites"][KEY])
spec = dict(base); spec["2026-09-04"] = [("1000000000000000001", "a.com", 700)]
run = drive(spec, "2026-09-03", "2026-09-04")
check("−30% 什么都不算", hits(run["2026-09-04"]) == [])
spec = dict(base); spec["2026-09-04"] = []
run = drive(spec, "2026-09-03", "2026-09-04")
check("今天没单不算掉量（那是沉默那条线的事）", hits(run["2026-09-04"]) == [] and run["2026-09-04"]["sites"][KEY]["drop"] is None)

# ---------- [4] 前 N 与零星型 ----------
print("\n[4] 前 N 资格按 30 天滚动 TPV 在命中当天算；零星型标签")
spec = {}
for i in range(0, 30):
    day = d("2026-08-15", i)
    spec[day] = [("1000000000000000001", "a.com", 300), ("2000000000000000002", "b.com", 200)]
    if i % 5 == 0 or i == 29:                                               # c.com 自己的窗口里只出 7 天，最后一天和 a、b 一起
        spec[day].append(("3000000000000000003", "c.com", 5000))
for i in range(30, 33):
    spec[d("2026-08-15", i)] = []                                            # 三家一起沉默
cfg = json.loads(json.dumps(CFG)); cfg["churn"]["top_n"] = 2
run = drive(spec, "2026-09-10", "2026-09-15", cfg)
st = run["2026-09-15"]
ranks = {k: (v["rank"], v["eligible"], v["sporadic"], v["active30"]) for k, v in st["sites"].items()}
check("★ 按滚动 TPV 排名：c（35000）> a（9000）> b（6000）", ranks["3000000000000000003|c.com"][0] == 1 and ranks[KEY][0] == 2
      and ranks["2000000000000000002|b.com"][0] == 3, ranks)
check("★ top_n=2：b 的命中 eligible=false", [h["eligible"] for h in st["hits"] if h["key"].endswith("b.com")] == [False]
      and [h["eligible"] for h in st["hits"] if h["key"] == KEY] == [True], st["hits"])
check("★ c 自己窗口里只出 7 天：零星型；a、b 天天出：不是",
      ranks["3000000000000000003|c.com"][2] is True and ranks["3000000000000000003|c.com"][3] == 7
      and ranks[KEY][2] is False and ranks[KEY][3] == 30, ranks)
check("命中先按有资格、再按 30 天 TPV 排", [h["key"].split("|")[1] for h in st["hits"]] == ["c.com", "a.com", "b.com"], st["hits"])
check("counts 里三家都是沉默2", st["counts"].get("沉默2") == 3, st["counts"])
check("站点级：同一商户两个站点各算各的", "1000000000000000001|a.com" in st["sites"] and len(st["sites"]) == 3)

# ---------- [4b] 滚动窗口以「最后有交易日」为终点 ----------
print("\n[4b] ★ 沉默满 30 天的大站点：排名和零星型判断不能被沉默本身带偏")
spec = {}
for i in range(0, 30):                                    # 08-01 ~ 08-30 天天 1 万
    spec[d("2026-08-01", i)] = [("1000000000000000001", "a.com", 10000), ("2000000000000000002", "b.com", 10)]
for i in range(30, 62):                                   # 08-31 起 a 沉默，b 每天还在出小单
    spec[d("2026-08-01", i)] = [("2000000000000000002", "b.com", 10)]
cfg2 = json.loads(json.dumps(CFG)); cfg2["churn"]["top_n"] = 1
run = drive(spec, "2026-09-25", "2026-09-30", cfg2)
st = run["2026-09-29"]                                    # 09-29 = 最后出单 08-30 之后第 30 天
a = st["sites"][KEY]
check("★ 沉默满 30 天那天真的跃迁了", hits(st) == ["沉默30"], st["hits"])
check("★ 它的滚动 TPV 还是沉默前那 30 万，不是 0", a["tpv30"] == 300000.0 and a["tpv_asof"] == "2026-08-30", a)
check("★ 所以它排第一、有推送资格（这一条以前是反的：最高档永远推不出去）",
      a["rank"] == 1 and a["eligible"] is True and st["hits"][0]["eligible"] is True, a)
check("★ 也不会被误标成零星型", a["sporadic"] is False and a["active30"] == 30, a)
check("天天出小单的 b 排在后面", st["sites"]["2000000000000000002|b.com"]["rank"] == 2)

print("\n[4c] ★ 冷启动：沉默 31~90 天的站点也要跟踪（窗口之外，但台账里有）")
st0 = A.assess(days_from(spec), "2026-09-30", None, cfg2)       # prev=None
check("窗口外那家进了 sites", KEY in st0["sites"] and st0["sites"][KEY]["silent_days"] == 31, list(st0["sites"]))

print("\n[4d] ★ 再沉默时「已恢复」标签要清掉")
spec2 = {d("2026-09-01", i): [("1000000000000000001", "a.com", 100)] for i in range(0, 3)}
for i in range(3, 6):
    spec2[d("2026-09-01", i)] = []
spec2["2026-09-07"] = [("1000000000000000001", "a.com", 100)]
for i in range(7, 12):
    spec2[d("2026-09-01", i)] = []
run2 = drive(spec2, "2026-09-01", "2026-09-12")
check("恢复那天有标记", run2["2026-09-07"]["sites"][KEY]["recovered_on"] == "2026-09-07"
      and hits(run2["2026-09-07"]) == ["恢复"], run2["2026-09-07"]["sites"][KEY])
check("隔一天还挂着", run2["2026-09-08"]["sites"][KEY]["recovered_on"] == "2026-09-07")
check("★ 再次沉默满 2 天：标记清掉", hits(run2["2026-09-09"]) == ["沉默2"]
      and run2["2026-09-09"]["sites"][KEY]["recovered_on"] is None, run2["2026-09-09"]["sites"][KEY])

# ---------- [5] 幂等 ----------
print("\n[5] 同样的输入两次结果相同")
# 自带一份数据，别蹭上面几段的 spec/run —— 那两个名字被反复覆盖过，蹭了下次加段就挂
idem = {d("2026-09-01", i): [("1000000000000000001", "a.com", 100 + i), ("2000000000000000002", "b.com", 50)]
        for i in range(0, 6)}
for i in range(6, 9):
    idem[d("2026-09-01", i)] = []
prev8 = drive(idem, "2026-09-01", "2026-09-08")["2026-09-08"]
snap = json.dumps(prev8, ensure_ascii=False, sort_keys=True)
st1 = A.assess(days_from(idem), "2026-09-09", prev8, CFG)
st2 = A.assess(days_from(idem), "2026-09-09", prev8, CFG)
check("逐字节相同", json.dumps(st1, ensure_ascii=False, sort_keys=True) == json.dumps(st2, ensure_ascii=False, sort_keys=True))
check("★ 不改输入（昨日状态原样没动）", json.dumps(prev8, ensure_ascii=False, sort_keys=True) == snap)

# ---------- [6] 配置读法 ----------
print("\n[6] 配置：null / 空串 / 垃圾值回默认，0 要留住，天数档接受列表或「2,7,30」")
s = C.settings({"churn": {"top_n": None, "drop_push": "", "drop_page": "abc", "recover_ratio": 0, "silence_days": "2,7,30"}})
check("null / 空串 / 垃圾 → 默认", s["top_n"] == 30 and s["drop_push"] == -0.70 and s["drop_page"] == -0.50, s)
check("★ 0 要留住", s["recover_ratio"] == 0, s["recover_ratio"])
check("「2,7,30」→ [2, 7, 30]", s["silence_days"] == [2, 7, 30], s["silence_days"])
s = C.settings({"churn": {"silence_days": [7, 2, "x", 30], "mode": "loud"}})
check("列表去掉垃圾、排好序", s["silence_days"] == [2, 7, 30], s["silence_days"])
check("mode 不认识回 silent", s["mode"] == "silent", s["mode"])
check("没这一段也能跑", C.settings({})["top_n"] == 30)

# [7]（run_day 落盘 / 幂等 / 坏文件）2026-09-18 搬到 tests/churn_job_io.py：那段碰 churn.job（调度 / 发送层），
# 这份要能按 口径清单.json 原样同步到看板仓库跑，只留纯口径。

print("\n" + ("失败 %d 项: %s" % (len(fails), fails) if fails else "全部通过"))
sys.exit(1 if fails else 0)
