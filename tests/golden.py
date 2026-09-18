"""
golden.py - 黄金用例逐字节一致（看板计划 第 04 张票）

    python tests/golden.py      # 零依赖（order_monitor 那族要 pandas，没装会说跳过）

fixtures/golden/ 里每条用例的 expected.json 是口径层跑出来的。这里重跑一遍比对：
不一致 = 口径层变了（同步了新版工作台）或者有人手改了 expected。前者要重新 --generate 并在提交里说清楚。

另外钉两条护栏：
  ★ 输入里没有真实商户（用户ID 只许 1000000000000000xxx 这种构造值）
  ★ 每条用例三个文件齐（缺 expected 的要报出来，不能静默跳）
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "fixtures" / "golden"
fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


print("[1] 用例文件齐、输入是构造的")
cases = sorted(p for fam in GOLDEN.iterdir() if fam.is_dir() for p in fam.iterdir() if p.is_dir())
check("至少有一条用例", len(cases) > 0)
UID = re.compile(r'"用户ID": "(\d+)"')
for c in cases:
    check(f"{c.parent.name}/{c.name} 三个文件", all((c / f).exists() for f in ("input.json", "settings.json", "expected.json"))
          or c.parent.name == "order_monitor_classify" and (c / "input.json").exists(),
          [f for f in ("input.json", "settings.json", "expected.json") if not (c / f).exists()])
    txt = (c / "input.json").read_text(encoding="utf-8")
    real = [u for u in UID.findall(txt) if not u.startswith("10000000000000000")]
    check(f"{c.parent.name}/{c.name} 用户ID 全是构造值", not real, real[:3])
    json.loads(txt)

print("\n[2] ★ 重跑口径层，和 expected.json 逐字节一致")
r = subprocess.run([sys.executable, str(ROOT / "scripts" / "生成黄金用例.py"), "--check"], capture_output=True, text=True, cwd=str(ROOT))
print("   " + (r.stdout.strip().replace("\n", "\n   ")))
check("--check 通过", r.returncode == 0, r.stderr.strip().splitlines()[-1:] if r.stderr.strip() else "")

print("\n[3] 一处刻意的边界要真的在 expected 里")
def load(fam, name):
    return json.loads((GOLDEN / fam / name / "expected.json").read_text(encoding="utf-8"))
try:
    e = load("churn_overview", "新商户环比是null不是加100")
    new = [t for t in e["top"] if t["用户ID"] == "1000000000000000004"]
    check("★ 新商户的 dod 是 null（不是 +100%）", new and new[0]["dod"] is None and new[0]["prev"] is None, new)
    e = load("churn_overview", "缺一天序列里是ok_false值null")
    miss = [p for p in e["series"] if not p["ok"]]
    check("★ 缺的那天 ok:false 且 tpv 是 null（不是 0）", len(miss) == 1 and miss[0]["tpv"] is None, miss)
    e = load("churn_assess", "沉默2天跃迁一次")
    u1 = [h for h in e["hits"] if h["用户ID"] == "1000000000000000001"]
    check("★ 沉默 2 天 → 命中类型是「沉默2」，silent_days=2", u1 and u1[0]["type"] == "沉默2" and u1[0]["silent_days"] == 2, u1)
    e = load("churn_assess", "通道异常数的是家不是条_正好3家报")
    check("★ 3 家同沉默同网关 → 报通道异常，数的是家", e["incidents"] and e["incidents"][0]["merchants"] == 3, e["incidents"])
    e = load("churn_assess", "通道异常_2家乘7站点14条仍不报")
    check("★ 2 家 ×7 站点 = 14 条仍不报", e["incidents"] == [], e["incidents"])
    d5 = load("churn_daily", "门槛看商户多大不看掉了多少")
    d0 = load("churn_daily", "门槛0是不设门槛不被or吃掉")
    check("★ 门槛 5000 和门槛 0 的两条 expected 必须不同（2026-09-18 抓到过：settings 形状写错、两条一模一样）",
          d5 != d0 and d0.get("floor") == 0 and d5.get("floor") == 5000, (d5.get("floor"), d0.get("floor")))
    a4 = load("churn_trade", "周五到周四_锚点4_周号按结束日")
    a6 = load("churn_trade", "周日起_锚点6_同一批数分桶不同")
    check("★ 同一批数、两个锚点分出的周不一样（口径参数化）",
          [s["label"] for s in a4["series"]] != [s["label"] for s in a6["series"]] or
          [s.get("start") for s in a4["series"]] != [s.get("start") for s in a6["series"]],
          (a4["series"][-1], a6["series"][-1]))
except (FileNotFoundError, KeyError) as e:
    check("expected 读得到、形状对", False, repr(e))

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
