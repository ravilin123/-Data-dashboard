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
    check(f"{c.parent.name}/{c.name} 三个文件", all((c / f).exists() for f in ("input.json", "settings.json", "expected.json")),
          [f for f in ("input.json", "settings.json", "expected.json") if not (c / f).exists()])
    if c.parent.name == "order_monitor_classify":
        # ★ 这族的 expected 可能是 pandas 替身生成的（scripts/生成黄金用例.py: _pandas_shim）。替身和真 pandas 逐字节一致的前提：
        #   输入里没有 null、每张表每行的键一样（这样 DataFrame 不会引入 NaN、不会改类型）。破了前提就得在装了 pandas 的机器上重生成。
        inp = json.loads((c / "input.json").read_text(encoding="utf-8"))
        for tbl in ("today", "yesterday"):
            rows = inp[tbl]
            keys = {tuple(sorted(r)) for r in rows}
            check(f"{c.name} · {tbl} 每行键一样", len(keys) == 1, keys)
            check(f"{c.name} · {tbl} 没有 null（替身 = pandas 的前提）", all(v is not None for r in rows for v in r.values()))
    txt = (c / "input.json").read_text(encoding="utf-8")
    real = [u for u in UID.findall(txt) if not u.startswith("10000000000000000")]
    check(f"{c.parent.name}/{c.name} 用户ID 全是构造值", not real, real[:3])
    json.loads(txt)

print("\n[2] ★ 重跑口径层，和 expected.json 逐字节一致")
r = subprocess.run([sys.executable, str(ROOT / "scripts" / "生成黄金用例.py"), "--check"], capture_output=True, text=True, cwd=str(ROOT))
print("   " + (r.stdout.strip().replace("\n", "\n   ")))
check("--check 通过", r.returncode == 0, "\n      ".join(r.stderr.strip().splitlines()[-8:]) if r.stderr.strip() else "")

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
    # ---- 2026-09-18 补的十族 ----
    c = load("churn_assess_chain", "一档只跃迁一次")
    check("★ 多日连跑：沉默2 只在满 2 天那天命中一次，之后三天不再命中",
          [d for d, h in c["hits"].items() if h] == ["2026-09-14"] and c["hits"]["2026-09-14"] == ["沉默2"], c["hits"])
    c = load("churn_assess_chain", "恢复归零并清掉已恢复标记")
    check("★ 沉默后回来 → 命中「恢复」，档位归 0", c["hits"]["2026-09-15"] == ["恢复"]
          and c["states"]["2026-09-15"]["sites"]["1000000000000000001|a.com"]["silence_level"] == 0, c["hits"])
    c = load("churn_assess_chain", "掉量关闭_两天内回到八成")
    check("★ 掉 80% → 掉量·推；次日回到 ≥80% → 掉量关闭", list(c["hits"].values()) == [["掉量·推"], ["掉量关闭"]], c["hits"])
    c = load("churn_assess_chain", "掉量过期_两天没回不命中静默清掉")
    last = c["states"]["2026-09-16"]["sites"]["1000000000000000001|a.com"]
    check("★ 两天没回：不命中「关闭」，drop 静默清掉", c["hits"]["2026-09-16"] == [] and last["drop"] is None, (c["hits"], last["drop"]))
    c = load("churn_assess_chain", "缺口横在中间不跃迁")
    u = c["states"]["2026-09-15"]["sites"]["1000000000000000001|a.com"]
    check("★ 缺口横在中间：uncertain 且不跃迁不命中", u["uncertain"] is True and all(h == [] for h in c["hits"].values()), (u["uncertain"], c["hits"]))
    w = load("churn_weekly", "头条是上周量_掉量不重叠_有人跟看状态不看名字")
    check("★ 周报：头条 7800（上周量）、掉量 1 家不在流失里、有人跟看状态（未跟进不算）",
          w["lost"]["tpv"] == 7800.0 and w["drop"]["sites"] == 1 and w["claimed"] == 1 and w["unclaimed"] == 1, (w["lost"], w["drop"], w["claimed"], w["unclaimed"]))
    w = load("churn_weekly", "在途风险同一站点一周只算一次")
    check("★ 在途风险：先 7 后 30 的同一站点只算一次 → 2 个站点 5000", w["risk"]["sites"] == 2 and w["risk"]["tpv"] == 5000.0, w["risk"])
    w = load("churn_weekly", "在途风险窗口算不出来ok_false不给0")
    check("★ states 为 null → risk ok:false、tpv null，不是 0", w["risk"]["ok"] is False and w["risk"]["tpv"] is None, w["risk"])
    check("★ 不足两周 / 没走完的周 → 整份 ok:false", load("churn_weekly", "不足两个完整周ok_false")["ok"] is False
          and load("churn_weekly", "没走完的那一周不算数")["ok"] is False)
    f = load("churn_funnel", "五级各几个_状态没覆盖到单独数")
    check("★ 漏斗：五级 5/4/3/1/1，状态没覆盖到的单独数 1", [l["sites"] for l in f["levels"]] == [5, 4, 3, 1, 1] and f["uncovered"]["sites"] == 1, ([l["sites"] for l in f["levels"]], f["uncovered"]))
    f = load("churn_funnel", "耗时三种排除_终点早于起点不进分母")
    check("★ 终点早于起点 negative=1、起点缺 no_start=2，都不进分母", f["steps"][0]["negative"] == 1 and f["steps"][0]["no_start"] == 2 and f["steps"][0]["n"] == 4, f["steps"][0])
    f1, f2 = load("churn_funnel", "五级各几个_状态没覆盖到单独数"), load("churn_funnel", "date是台账那天不是今天")
    check("★ date 换成更早那天，卡住等待天数跟着变（不是拿今天当终点）", f1["stuck"][0]["median"] != f2["stuck"][0]["median"], (f1["stuck"][0]["median"], f2["stuck"][0]["median"]))
    d = load("churn_trade_drill", "多维是与_kw不分大小写")
    check("★ 下钻：接入模式=API 与 kw=B.COM 同时成立 → 只剩 b.com", [r["站点"] for r in d["drill"]["rows"]] == ["b.com"], d["drill"]["rows"])
    d = load("churn_trade_drill", "截断自报limit2")
    check("★ 下钻截断自报 {n, tpv}", d["drill"]["truncated"] == {"n": 1, "tpv": 210.0} and len(d["drill"]["rows"]) == 2, d["drill"]["truncated"])
    t1, t2 = load("churn_trade", "校验对上报表周行_同"), load("churn_trade", "校验对不上报表周行_只报不改数")
    check("★ 报表校验：对上 同=true；对不上 同=false 且台账的数不改", t1["check"]["同"] is True and t2["check"]["同"] is False and t2["current"]["tpv"] == 7000.0, (t1["check"], t2["check"]))
    j = load("conversion_funnel", "toRate量纲_逆算链_calcFunnel")
    check("★ toRate：99.99% → 0.9999（不是 99.99）、认不出 → null；calcFunnel 900/720", abs(j["toRate"][0] - 0.9999) < 1e-9 and j["toRate"][-1] is None and j["calcFunnel"] == [900, 720], j)
    check("★ 覆盖：0.37% 缺口不报警、20% 报警、没数据 ok:false",
          load("conversion_coverage", "常态缺口不报警")["alert"] is False and load("conversion_coverage", "缺口超过阈值才报")["alert"] is True
          and load("conversion_coverage", "这一期没数据ok_false")["ok"] is False)
    g = load("shared_fail_group", "看编码不看文案_兜底单独数")
    check("★ 失败归类：ZF3D 编码进 3DS（文案写着 issuer 也不算发卡行）；兜底 3 笔单独数", g["fallback"]["n"] == 3
          and any(x["label"] == "3DS验证失败" and x["n"] == 1 for x in g["groups"]), [(x["label"], x["n"]) for x in g["groups"]])
    st = load("merchant_status", "四类_退款算成功_未决不进分母")
    check("★ 状态归类：退款算成功、未决 pending、没见过 unknown；分母只留成功+失败", st["stClass"][1] == "succ" and st["stClass"][4] == "pending"
          and st["stClass"][6] == "unknown" and st["excludePending"] == ["支付成功", "支付失败"], st)
    a = load("merchant_change_attrib", "加权分解是恒等式")
    check("★ 加权分解：Σ结构 + Σ通过率 = 实际变化（差 0）", abs(a["diff"]) < 0.05 and a["sumStruct"] != 0 and a["sumRate"] != 0, a)
    z = load("conversion_analyze", "字面量Dataset_跌20pct_告警和下钻")
    check("★ 转化率整链：跌 20% → 告警一条、环比 −0.2、下钻到商户", len(z["alarmSite"]) == 1 and abs(z["alarmSite"][0]["_dod"] + 0.2) < 1e-9 and len(z["drillSite"]) >= 1, z["alarmSite"])
    # ---- 2026-09-18 第三批：出单分档、重复行、文本四族、JS 五族 ----
    o = load("order_monitor_classify", "五档各一行_含站点空丢弃与超180天只入表")
    check("★ 出单分档：新出单 / 测试交易 / 3天内未出单 / 开通>180天仅表 / 站点空丢弃，各一行",
          [(a["去向"], a["落点"]) for a in o["audit"]] == [("新出单", "通知+表"), ("测试交易", "通知+表"), ("未出单", "通知+表"), ("开通>180天", "仅表"), ("站点为空", "丢弃")],
          [(a["去向"], a["落点"]) for a in o["audit"]])
    check("★ 通道反馈日比报表日早一天 → 「3天内未出单」不是「新审核通过」", o["audit"][2]["备注"] == "👀 3天内未出单", o["audit"][2])
    check("★ >180 天不进通知（notify 里没有它）", "⏸ 开通>180天" not in o["results"][1] and sum(len(v) for v in o["results"][1].values()) == 3, o["results"][1])
    d = load("churn_assess", "同一天同一站点两行取后一行")
    check("★ 同一天同一站点两行：后一行覆盖前一行（tpv30 = 16×100 + 900）", d["sites"]["1000000000000000001|a.com"]["tpv30"] == 2500.0, d["sites"]["1000000000000000001|a.com"]["tpv30"])
    check("★ 日报正文：一条都不该报时是空串", load("churn_daily_text", "一条都不该报时是空串")["text"] == "")
    tx = load("churn_daily_text", "掉量单独一行_明写还在出单没算进上面")["text"]
    check("★ 日报正文：掉量一行明写「还在出单，没算进上面」", "还在出单，没算进上面" in tx and "沉默" not in tx.split("\n")[1], tx)
    b = load("churn_broadcast", "通道异常单独一行_缺数据一个字不出")
    check("★ 群消息：通道异常单独一行且写「家」；「网关数据缺」一个字不出", "通道异常：网关A 今天 3 家一起掉" in b["group_text"] and "网关数据缺" not in b["group_text"], b["group_text"][:200])
    b2 = load("churn_broadcast", "只推前N的沉默跃迁和掉量推_群和私聊分组")
    check("★ 私聊按直签人分组、群消息不写口径不出现「工作台」", list(b2["dm"]) == ["赵娜"] and "工作台" not in b2["group_text"] and "阈值" not in b2["group_text"], list(b2["dm"]))
    w1 = load("churn_weekly_text", "标题不带日期_谁在跟只在有人跟时出现")["text"]
    w2 = load("churn_weekly_text", "在途风险算不出来写算不出来不写0")["text"]
    check("★ 周报标题是期次不带运行日期；有人跟才出现「谁在跟」段", w1.startswith("【商户流失周报】2026 W37") and "2026-09-14" not in w1 and "谁在跟" in w1 and "谁在跟" not in w2, (w1[:40], "谁在跟" in w2))
    check("★ 在途风险算不出来写「算不出来」不写 $0", "算不出来" in w2 and "在途风险：$0" not in w2, w2)
    check("★ 交易量群消息：当天没数是空串；有数就有整条", load("churn_trade_msg", "当天一个数都没有是空串")["text"] == "" and load("churn_trade_msg", "有数就有整条消息")["text"].startswith("【交易量"))
    wl = load("conversion_watchlist", "低于同行谁进怎么排_量太少不参与")
    check("★ 待观察：低位名单 L1、L2 进；9 单的 T1 不进也不参与基准（peers=6，基准 52.5%）", [x["uid"] for x in wl["watchlist"]["low"]] == ["L1", "L2"] and wl["peerBaselines"]["A"]["peers"] == 6 and abs(wl["peerBaselines"]["A"]["rate"] - 0.525) < 1e-9, wl["peerBaselines"])
    wl2 = load("conversion_watchlist", "基准不加权_一家独大不拿自己当基准")
    check("★ 基准不加权：一家独大的 30% 不是基准，中位数 65%", abs(wl2["peerBaselines"]["E"]["rate"] - 0.65) < 1e-9, wl2["peerBaselines"])
    lv = load("conversion_level", "跌破P10报_环比只差1pt报不出")
    check("★ 水平信号：跌破 P10 报出来（本期 0.78 < 0.80），用的本来源池", len(lv["level"]) == 1 and lv["level"][0]["本期值"] == 0.78 and lv["level"][0]["_basis"] == "本来源", lv["level"])
    check("★ 只有混池没本来源池 → 不报（不做混池回退）；常年 100% → 不报（满分要挡）",
          load("conversion_level", "只有混池没有本来源池不报_不做混池回退")["level"] == [] and load("conversion_level", "满分指标要挡_常年100pct不报")["level"] == [])
    tr = load("conversion_trend", "周报期次W9排在W37前")
    check("★ 趋势：周报期次自然序 W9 → W10 → W37", tr["dates"] == ["2026 W9", "2026 W10", "2026 W37"], tr["dates"])
    tg, tf = load("conversion_trend", "缺一个大环节断线不跳过"), load("conversion_trend", "期次自然序_多来源多期")
    check("★ 趋势：缺一个大环节那期是 null（断线），完整的那份没有 null",
          any(v is None for k in tg["series"] for v in (tg["series"][k].get("独立站API") or [])) and not any(v is None for k in tf["series"] for v in (tf["series"][k].get("独立站API") or [])))
    bs = load("conversion_baseline", "样本分池_环比样本等于期数减一")
    check("★ 基准线：水平样本按来源分池、环比样本 = 期数 − 1", len(bs["samples"]["dod"]["独立站API|4. 网关通过率"]) == 2 and len(bs["samples"]["levelMixed"]["4. 网关通过率"]) == 6, {k: len(v) for k, v in bs["samples"]["dod"].items()})
    bw = load("conversion_baseline", "周报期次自然序_相邻对不配错")
    dd = bw["samples"]["dod"]["独立站API|4. 网关通过率"]
    check("★ 基准线：周报期次按自然序配相邻对（W9→W10→W37），两个环比样本都对", len(dd) == 2 and abs(dd[0] - 0.1) < 1e-9 and abs(dd[1] - (0.6 - 0.55) / 0.55) < 1e-9, dd)
    pr = load("conversion_po_rate", "两段相加等于总流失_只认分子分母")
    r = next(x for x in pr["rows"] if x["来源"] == "独立站标准收银台")
    check("★ 支付前中拆账：1282 + 432 = 1714 = PO − 成功；当期值 99.99% 没被拿来算", r["支付前流失"] == 1282 and r["支付中流失"] == 432 and r["总流失"] == 1714 and abs(r["业务单率"] - 1313 / 3027) < 1e-12, r)
    check("★ 两行分子对不上打 mismatch；缺支付单率那行进 noData 不当 0",
          load("conversion_po_rate", "两行分子对不上打mismatch")["rows"][0]["mismatch"] is True and load("conversion_po_rate", "缺支付单率那行进noData不当0")["noData"] == ["独立站API"])
except (FileNotFoundError, KeyError) as e:
    check("expected 读得到、形状对", False, repr(e))

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
