# -*- coding: utf-8 -*-
"""
生成黄金用例.py - 黄金用例（fixtures/golden/）的两步：造输入、用口径层跑出 expected。

    python scripts/生成黄金用例.py --init        # 只补缺的 input.json / settings.json（已有的不动）
    python scripts/生成黄金用例.py --generate    # 用口径层跑，写 expected.json（覆盖）
    python scripts/生成黄金用例.py --check       # 重跑并和 expected.json 比，tests/golden.py 调的就是它

一条用例 = `fixtures/golden/<族>/<名字>/{input.json, settings.json, expected.json}`。
**expected 不手写**：它是口径层跑出来的。研发照 docs/口径.md 用别的语言实现后，
喂同样的 input 得到逐字节相同的 expected，才算「同一套口径」。

⚠ 输入全是**构造**的（用户ID 编成 1000000000000000001 这种），真实商户数据不进仓库。
⚠ 输出要**确定**：不带时间戳、顺序走数组。JSON 落盘用 sort_keys + ensure_ascii=False + indent=1。
⚠ `order_monitor_classify` 那一族要 pandas（口径吃 DataFrame）；没装就跳过并说出来，别装作生成了。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
GOLDEN = ROOT / "fixtures" / "golden"
# 这几族的口径只有 JS 版，由 scripts/golden_js.mjs 跑（node 直跑，零依赖）
JS_FAMILIES = ("conversion_funnel", "conversion_coverage", "conversion_analyze", "shared_fail_group", "merchant_status", "merchant_change_attrib")


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def write(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(dump(obj), encoding="utf-8")


# ---------------------------------------------------------------- 造输入（构造数据）

def _row(uid, site, amt, n=1, owner="赵娜", mode="标准收银台", agent_id="", agent="", name=None):
    return {"用户ID": uid, "站点": site, "商户名称": name or f"商户{uid[-3:]}", "直签人": owner,
            "代理商ID": agent_id, "代理商名称": agent, "接入模式": mode,
            "交易金额": float(amt), "交易笔数": int(n)}


U1, U2, U3, U4 = "1000000000000000001", "1000000000000000002", "1000000000000000003", "1000000000000000004"
AGENT = "1000000000000000099"
D = ["2026-09-%02d" % i for i in range(1, 18)]      # 09-01 ~ 09-17


def _days(spec: dict) -> dict:
    return {d: [_row(*r) if isinstance(r, tuple) else r for r in rows] for d, rows in spec.items()}


def _gw(uid, gateway, amt, n=1):
    return {"报表类型": "日报", "统计周期": "", "网关": gateway, "用户ID": uid,
            "交易金额": float(amt), "交易笔数": int(n)}


def cases() -> dict:
    """{族: {名字: (input, settings)}}。名字就是这条用例钉的口径，读得懂再改。"""
    out: dict = {}

    # ---- names：名字清洗 ----
    out["names"] = {
        "owner_name_空和nan一律未分配BD": ({"raw": [None, "", "  ", "nan", "NaN", "NULL", "none", "nat", " 赵娜 ", 0, AGENT]}, {}),
        "is_agent_id_15位以上纯数字": ({"names": [AGENT, "123456789012345", "12345678901234", "赵娜", "12345abc"]}, {}),
    }

    # ---- churn_assess：状态机 ----
    base = {d: [(U1, "a.com", 1000, 10), (U2, "b.com", 900, 9), (U3, "c.com", 50, 1)] for d in D[:-1]}
    silent = {**base, D[-1]: [(U2, "b.com", 900, 9), (U3, "c.com", 50, 1)]}     # U1 今天没出单 → 沉默 1 天（不到 2）
    silent2 = {**{d: base[d] for d in D[:-2]}, D[-2]: [(U2, "b.com", 900, 9)], D[-1]: [(U2, "b.com", 900, 9)]}   # U1 沉默 2 天 → 沉默2
    drop = {**base, D[-1]: [(U1, "a.com", 200, 2), (U2, "b.com", 900, 9), (U3, "c.com", 50, 1)]}   # U1 掉 80% → 掉量·推
    gap = {d: base[d] for d in D[:-1] if d != D[-4]}      # 中间缺一天台账
    gap[D[-1]] = base[D[0]]
    cfg = {"churn": {"top_n": 30, "silence_days": [2, 7, 30], "drop_push": -0.70, "drop_page": -0.50,
                     "recover_ratio": 0.8, "sporadic_max_days": 10, "window_days": 30,
                     "gateway_incident_min": 3, "gateway_incident_top_n": 50}}
    out["churn_assess"] = {
        "沉默不到2天不算命中": ({"days": _days(silent), "today": D[-1], "prev": None}, cfg),
        "沉默2天跃迁一次": ({"days": _days(silent2), "today": D[-1], "prev": None}, cfg),
        "掉八成是掉量推送档": ({"days": _days(drop), "today": D[-1], "prev": None}, cfg),
        "台账缺一天要报gap不当0": ({"days": _days(gap), "today": D[-1], "prev": None}, cfg),
        "今天没台账算不了ok_false": ({"days": _days(base), "today": D[-1], "prev": None}, cfg),
        "网关标签三种": ({"days": _days(silent2), "today": D[-1], "prev": None,
                          "gateway": {D[-1]: [_gw(U1, "网关A", 500, 5)]}}, cfg),
        "不传网关一律网关数据缺": ({"days": _days(silent2), "today": D[-1], "prev": None}, cfg),
    }
    # 通道异常：3 家同沉默、同网关
    uids = [U1, U2, U3]
    inc = {d: [(u, f"s{i}.com", 1000 - i * 10, 10) for i, u in enumerate(uids)] for d in D[:-2]}
    inc[D[-2]] = []
    inc[D[-1]] = []
    out["churn_assess"]["通道异常数的是家不是条_正好3家报"] = (
        {"days": _days(inc), "today": D[-1], "prev": None,
         "gateway": {D[-3]: [_gw(u, "网关A", 100, 2) for u in uids], D[-1]: []}}, cfg)
    inc2 = {d: [(U1, f"s{j}.com", 1000, 10) for j in range(7)] + [(U2, "t.com", 900, 9)] for d in D[:-2]}
    inc2[D[-2]] = []
    inc2[D[-1]] = []
    out["churn_assess"]["通道异常_2家乘7站点14条仍不报"] = (
        {"days": _days(inc2), "today": D[-1], "prev": None,
         "gateway": {D[-3]: [_gw(U1, "网关A", 100, 2), _gw(U2, "网关A", 100, 2)], D[-1]: []}}, cfg)

    # ---- churn_overview：大盘 ----
    ov_days = {d: [(U1, "a.com", 1000 + i, 10), (U2, "b.com", 500, 5, "赵娜", "API"),
                   (U3, "c.com", 100, 1, AGENT, "标准收银台", AGENT, "代理商甲")]
               for i, d in enumerate(D[:-1])}
    ov_days[D[-1]] = [(U1, "a.com", 1200, 12), (U2, "b.com", 400, 4, "赵娜", "API"),
                      (U4, "d.com", 300, 3, "", "API")]          # U3 今天没了；U4 是新商户
    ov_gap = {d: v for d, v in ov_days.items() if d != D[-3]}
    out["churn_overview"] = {
        "新商户环比是null不是加100": ({"days": _days(ov_days), "date": D[-1], "n_days": 7, "top_n": 10}, {}),
        "缺一天序列里是ok_false值null": ({"days": _days(ov_gap), "date": D[-1], "n_days": 7, "top_n": 10}, {}),
        "当天没台账kpi全null但更早的天还在": ({"days": _days({d: ov_days[d] for d in D[:-1]}), "date": D[-1], "n_days": 7, "top_n": 10}, {}),
        "直签人是19位代理商ID显示成代理商": ({"days": _days(ov_days), "date": D[-2], "n_days": 3, "top_n": 2}, {}),
    }

    # ---- churn_trade：周期分桶（锚点是显式参数：4 = 周五起（报表），6 = 周日起（公司看板）） ----
    tr_days = {d: [(U1, "a.com", 100 + i, 1), (U2, "b.com", 50, 1, "赵娜", "API")] for i, d in enumerate(D)}
    out["churn_trade"] = {
        "周五到周四_锚点4_周号按结束日": ({"days": _days(tr_days), "date": D[-1], "period": "周", "n": 3, "metric": "tpv", "top_n": 5, "anchor": 4}, {}),
        "周日起_锚点6_同一批数分桶不同": ({"days": _days(tr_days), "date": D[-1], "period": "周", "n": 3, "metric": "tpv", "top_n": 5, "anchor": 6}, {}),
        "按笔数看排序和占比都换": ({"days": _days(tr_days), "date": D[-1], "period": "日", "n": 5, "metric": "orders", "top_n": 5, "anchor": 4}, {}),
        "一期缺几天要报出来": ({"days": _days({d: tr_days[d] for d in D if d not in (D[-2], D[-3])}), "date": D[-1], "period": "周", "n": 2, "metric": "tpv", "top_n": 5, "anchor": 4}, {}),
    }

    # ---- churn_daily：日报汇总（输入是 assess 的输出，init 时算一次存下来） ----
    from churn import assess as A
    st = A.assess(_days(drop), D[-1], None, cfg)
    # ⚠ summary() 读的是**扁平**的 settings（daily.min_tpv 直接 .get("daily_min_tpv")），不是 {"churn": {...}}。
    #   第一版写成了带 churn 段的形状，两条用例的 expected 一模一样、门槛永远是默认 5000 —— 用例名说的事根本没钉住。
    #   tests/golden.py 现在钉着「这两条 expected 必须不同」。
    out["churn_daily"] = {
        "门槛看商户多大不看掉了多少": ({"state": st}, {"daily_min_tpv": 5000, "daily_top_n": 5}),
        "门槛0是不设门槛不被or吃掉": ({"state": st}, {"daily_min_tpv": 0, "daily_top_n": 5}),
    }
    # ---- churn_assess_chain：多日连跑（每天喂前一天的状态）。钉「一档只跃迁一次 / 恢复 / 掉量关闭 / 过期 / 缺口」 ----
    def chain(active_until, tail, run_from, run_to, gap=None):
        """U2 天天在（当基线）；U1 在 active_until（含）之前每天 1000，之后按 tail 给的 {日期: 金额 或 None(没这行)}。"""
        dd = {}
        for i, d in enumerate(D):
            if gap and d in gap:
                continue
            rows = [(U2, "b.com", 500, 5)]
            if d <= active_until:
                rows.insert(0, (U1, "a.com", 1000, 10))
            elif d in tail and tail[d] is not None:
                rows.insert(0, (U1, "a.com", tail[d], 2))
            dd[d] = rows
        return {"days": _days(dd), "dates": [d for d in D if run_from <= d <= run_to]}
    out["churn_assess_chain"] = {
        "一档只跃迁一次": (chain(D[11], {}, D[12], D[16]), cfg),                                   # 09-13 起沉默：09-14 命中沉默2，之后三天不再命中
        "恢复归零并清掉已恢复标记": (chain(D[11], {D[14]: 1000, D[15]: 1000}, D[12], D[15]), cfg),  # 沉默 2 天后 09-15 回来 → 恢复
        "掉量关闭_两天内回到八成": (chain(D[12], {D[13]: 200, D[14]: 900}, D[13], D[14]), cfg),    # 09-14 掉 80% 推；09-15 回到 900 ≥ 0.8×1000 → 关闭
        "掉量过期_两天没回不命中静默清掉": (chain(D[12], {D[13]: 200, D[14]: 200, D[15]: 200}, D[13], D[15]), cfg),
        "缺口横在中间不跃迁": (chain(D[11], {}, D[13], D[14], gap=[D[12]]), cfg),                    # 09-13 整天没台账 → 09-14 沉默 2 天但 uncertain
    }

    # ---- churn_weekly：老板周报（周台账 + 状态 + 谁在跟）。周界周五→周四是报表定的 ----
    W36 = {"期次": "2026 W36 (2026-08-28~2026-09-03)", "start": "2026-08-28", "end": "2026-09-03", "complete": True, "source_date": "2026-09-04"}
    W37 = {"期次": "2026 W37 (2026-09-04~2026-09-10)", "start": "2026-09-04", "end": "2026-09-10", "complete": True, "source_date": "2026-09-11"}
    prev = dict(W36, rows=[_row(U1, "a.com", 10000, 100), _row(U1, "a2.com", 2000, 20), _row(U2, "b.com", 5000, 50),
                           _row(U3, "c.com", 800, 8), _row(U4, "d.com", 3000, 30)])
    cur = dict(W37, rows=[_row(U1, "a.com", 9000, 90), _row(U2, "b.com", 0, 0), _row(U4, "d.com", 900, 9)])
    sts = [{"hits": [{"key": f"{U3}|c.com", "用户ID": U3, "站点": "c.com", "type": "沉默7", "tpv30": 4000.0},
                     {"key": f"{U4}|d.com", "用户ID": U4, "站点": "d.com", "type": "沉默2", "tpv30": 9999.0}]},
           {"hits": [{"key": f"{U3}|c.com", "用户ID": U3, "站点": "c.com", "type": "沉默30", "tpv30": 4000.0}]},
           {"hits": [{"key": f"{U2}|b.com", "用户ID": U2, "站点": "b.com", "type": "沉默30", "tpv30": 1000.0}]}]
    follow = {f"{U2}|b.com": {"跟进人": "王五", "状态": "跟进中"}, f"{U1}|a2.com": {"跟进人": "赵娜", "状态": "未跟进"}}
    wk_settings = {"drop_page": -0.50}
    out["churn_weekly"] = {
        "头条是上周量_掉量不重叠_有人跟看状态不看名字": ({"ws": [prev, cur], "states": sts, "follow": follow, "date": "2026-09-14"}, wk_settings),
        "在途风险同一站点一周只算一次": ({"ws": [prev, cur], "states": sts, "follow": {}, "date": "2026-09-14"}, wk_settings),
        "在途风险窗口算不出来ok_false不给0": ({"ws": [prev, cur], "states": None, "follow": follow, "date": "2026-09-14"}, wk_settings),
        "不足两个完整周ok_false": ({"ws": [prev], "states": sts, "follow": follow, "date": "2026-09-14"}, wk_settings),
        "没走完的那一周不算数": ({"ws": [prev, dict(cur, complete=False)], "states": sts, "follow": follow, "date": "2026-09-14"}, wk_settings),
    }

    # ---- churn_funnel：生命周期漏斗（出单监控台账明细 + 流失状态） ----
    def fr(uid, site, submit="", approve="", first=""):
        return {"用户ID": uid, "站点": site, "商户名称": f"商户{uid[-3:]}", "直签人": "赵娜",
                "站点_商户提交日期": submit, "通道结果反馈日期": approve, "第一笔成功交易日期": first}
    det = [fr(U1, "a.com", "2026-08-01", "2026-08-05", "2026-08-10"),     # 走完，状态说在出单
           fr(U1, "a2.com", "2026-08-01", "2026-08-05", "2026-08-12"),    # 走完，状态说沉默 9 天
           fr(U2, "b.com", "2026-08-01", "2026-08-20"),                    # 通过了没首单
           fr(U3, "c.com", "2026-08-01"),                                  # 提交了没通过
           fr(U4, "d.com"),                                                # 连提交日期都没有
           fr(AGENT, "e.com", "2026-08-03", "2026-08-06", "2026-08-09")]   # 走完，但状态里没有它 → uncovered
    fst = {"sites": {f"{U1}|a.com": {"silent_days": 0}, f"{U1}|a2.com": {"silent_days": 9}}, "settings": {"silence_days": [2, 7, 30]}}
    out["churn_funnel"] = {
        "五级各几个_状态没覆盖到单独数": ({"detail": det, "state": fst, "date": "2026-09-14"}, {}),
        "耗时三种排除_终点早于起点不进分母": ({"detail": det + [fr(U2, "x.com", "2026-08-10", "2026-08-05", ""),        # 终点早于起点
                                                              fr(U3, "y.com", "", "2026-08-05", "2026-08-09")],      # 起点缺
                                                "state": fst, "date": "2026-09-14"}, {}),
        "date是台账那天不是今天": ({"detail": det, "state": fst, "date": "2026-09-01"}, {}),
    }

    # ---- churn_trade_drill：下钻 + 筛选取值；churn_trade 再加两条「校验对上报表周行」 ----
    dr_days = {d: [(U1, "a.com", 100 + i, 1), (U2, "b.com", 50, 1, "赵娜", "API"), (U3, "c.com", 30, 1, "赵娜", "API", AGENT, "代理商甲")]
               for i, d in enumerate(D)}
    out["churn_trade_drill"] = {
        "多维是与_kw不分大小写": ({"days": _days(dr_days), "date": D[-1], "period": "周", "filters": {"接入模式": "API", "kw": "B.COM"}, "metric": "tpv", "limit": 200, "anchor": 4}, {}),
        "截断自报limit2": ({"days": _days(dr_days), "date": D[-1], "period": "周", "filters": {}, "metric": "tpv", "limit": 2, "anchor": 4}, {}),
        "按笔数看排序按笔数": ({"days": _days(dr_days), "date": D[-1], "period": "日", "filters": {}, "metric": "orders", "limit": 200, "anchor": 4}, {}),
    }
    w37_days = {d: [(U1, "a.com", 1000, 10)] for d in D if "2026-09-04" <= d <= "2026-09-10"}
    out["churn_trade"]["校验对上报表周行_同"] = ({"days": _days(w37_days), "date": "2026-09-10", "period": "周", "n": 2, "metric": "tpv", "top_n": 5, "anchor": 4,
                                                 "weeks": [dict(W36, rows=[]), dict(W37, rows=[_row(U1, "a.com", 7000, 70)])]}, {})
    out["churn_trade"]["校验对不上报表周行_只报不改数"] = ({"days": _days(w37_days), "date": "2026-09-10", "period": "周", "n": 2, "metric": "tpv", "top_n": 5, "anchor": 4,
                                                          "weeks": [dict(W37, rows=[_row(U1, "a.com", 6000, 60)])]}, {})

    # ---- JS 两块：转化率 / 商户成功率（scripts/golden_js.mjs 跑） ----
    PO = "1.1 校验1通过率"
    def sc(date, src, po, metric=PO):
        return {"统计日期": date, "来源": src, "类型": metric, "_n": round(po * 0.9), "_d": po}
    DD = "2026-09-06"
    out["conversion_funnel"] = {
        "toRate量纲_逆算链_calcFunnel": ({"rates": ["99.99%", "0.85", 0.5, "12%", "abc"],
                                        "row": {"PO单数_今": 1000, "1.1 校验1通过率_今": 0.9, "1.2 Paynow点击率_今": 0.8, "2. 业务校验通过率_今": 0.95},
                                        "metric": "1.2 Paynow点击率", "suffix": "_今",
                                        "metrics": ["2. 业务校验通过率", "1. 业务单支付转化率", "4.1 非3DS网关通过率", "不存在的指标"]}, {}),
    }
    out["conversion_coverage"] = {
        "常态缺口不报警": ({"rows": [sc(DD, "FLYPAY", 16089), sc(DD, "独立站API", 5043), sc(DD, "独立站标准收银台", 3027), sc(DD, "Element", 5289),
                                     sc(DD, "FLYLINK商品订单", 2016), sc(DD, "FLYLINK快捷订单", 654)], "date": DD}, {}),
        "缺口超过阈值才报": ({"rows": [sc(DD, "FLYPAY", 10000), sc(DD, "独立站API", 5000), sc(DD, "Element", 3000)], "date": DD}, {}),
        "这一期没数据ok_false": ({"rows": [sc("2026-09-05", "FLYPAY", 100)], "date": DD}, {}),
    }
    out["shared_fail_group"] = {
        "看编码不看文案_兜底单独数": ({"rows": [
            {"fail_reason": "Insufficient funds", "pay_method": "VISA"}, {"fail_reason": "Insufficient funds", "pay_method": "VISA"},
            {"fail_reason": "Zorp error 9981", "pay_method": "MC"}, {"fail_reason": "Zorp error 9981", "pay_method": "MC"},
            {"fail_reason": "Quux timeout", "pay_method": "MC"}, {"fail_reason": "Card declined by your bank", "pay_method": "MC"},
            {"fail_code": "ZFFK00003", "fail_reason": "风控系统拦截", "pay_method": "VISA"},
            {"fail_code": "ZF3D00001", "fail_reason": "Card issuer declined the transaction due to risk", "pay_method": "VISA"}]}, {}),
    }
    out["merchant_status"] = {
        "四类_退款算成功_未决不进分母": ({"statuses": ["支付成功", "已退款", "退款", "支付失败", "待处理", "处理中", "冻结中", "", None, "  支付成功 "],
                                      "rows": [{"status": "支付成功"}, {"status": "支付失败"}, {"status": "处理中"}, {"status": "冻结中"}]}, {}),
    }
    out["merchant_change_attrib"] = {
        "加权分解是恒等式": ({"last": [["A", 100, 80], ["B", 100, 50]], "curr": [["A", 50, 35], ["B", 150, 75]]}, {}),
    }
    lit = {
        "periods": {"日报": {"rows": 2, "dates": 2, "ok": True}},
        "dates": {"日报": ["2026-09-06", "2026-09-05"]},
        "scene": {"日报": [{"时间类别": "日报", "统计日期": "2026-09-05", "来源": "独立站API", "类型": "4. 网关通过率", "当期值": 0.90},
                         {"时间类别": "日报", "统计日期": "2026-09-06", "来源": "独立站API", "类型": "4. 网关通过率", "当期值": 0.72}]},
        "merchantSite": {"日报": [{"时间类别": "日报", "统计日期": "2026-09-05", "来源": "独立站API", "用户ID": U1, "商户名称": "a.example.com", "站点": "https://a.example.com", "PO单数": 500, "4. 网关通过率": 0.90},
                                {"时间类别": "日报", "统计日期": "2026-09-06", "来源": "独立站API", "用户ID": U1, "商户名称": "a.example.com", "站点": "https://a.example.com", "PO单数": 500, "4. 网关通过率": 0.72}]},
        "merchantTotal": {"日报": [{"时间类别": "日报", "统计日期": "2026-09-05", "来源": "独立站API", "用户ID": U1, "商户名称": "a.example.com", "站点": "合计", "PO单数": 500, "4. 网关通过率": 0.90},
                                 {"时间类别": "日报", "统计日期": "2026-09-06", "来源": "独立站API", "用户ID": U1, "商户名称": "a.example.com", "站点": "合计", "PO单数": 500, "4. 网关通过率": 0.72}]},
        "meta": {"日报": {"hasSite": True, "metricNames": ["4. 网关通过率"]}},
        "drift": {"newSources": [], "skipSources": [], "newMetrics": [], "usedSources": ["独立站API"], "dodColumn": {"present": False, "name": None}},
    }
    out["conversion_analyze"] = {
        "字面量Dataset_跌20pct_告警和下钻": ({"dataset": lit, "opts": {"period": "日报", "tDate": "2026-09-06", "yDate": "2026-09-05"}}, {}),
    }

    # ---- order_monitor_classify：出单监控分档（口径吃 pandas DataFrame；expected 要在装了 pandas 的机器上 --generate） ----
    def om(uid, site, name, bd, tpv, first_txn, submit, feedback, site_submit=""):
        return {"用户ID": uid, "站点": site, "商户名称": name, "所属BD": bd, "累计TPV_USD": tpv,
                "第一笔成功交易时间": first_txn, "提交通道时间": submit, "通道结果反馈时间": feedback,
                "站点_商户提交时间": site_submit or submit}
    T, Y = "2026-09-17", "2026-09-16"
    today = [
        om(U1, "a.com", "甲", "赵娜", 150.0, "2026-09-17 09:00:00", "2026-09-10 10:00:00", "2026-09-11 10:00:00"),   # 昨天 <100 今天 ≥100 → 新出单
        om(U2, "b.com", "乙", "赵娜", 30.0, "2026-09-17 09:00:00", "2026-09-12 10:00:00", "2026-09-13 10:00:00"),    # 今天第一笔、<100 → 测试交易
        om(U3, "c.com", "丙", "", 0.0, "", "2026-09-15 10:00:00", "2026-09-16 10:00:00"),                              # 通道反馈日 09-16、报表日 09-17、没出单 → 按 classify 第 7~8 步落「👀 3天内未出单」（待有 pandas 的机器生成 expected 后核）；所属BD 空 → 未分配BD
        om(U4, "d.com", "丁", "钱七", 0.0, "", "2026-03-01 10:00:00", "2026-03-02 10:00:00"),                          # 开通 >180 天 → 只入表不播报
        om(AGENT, "", "戊", "赵娜", 0.0, "", "2026-09-15 10:00:00", "2026-09-16 10:00:00"),                            # 站点为空 → 丢弃
    ]
    yesterday = [
        om(U1, "a.com", "甲", "赵娜", 60.0, "2026-09-15 09:00:00", "2026-09-10 10:00:00", "2026-09-11 10:00:00"),
        om(U2, "b.com", "乙", "赵娜", 0.0, "", "2026-09-12 10:00:00", "2026-09-13 10:00:00"),
        om(U4, "d.com", "丁", "钱七", 0.0, "", "2026-03-01 10:00:00", "2026-03-02 10:00:00"),
    ]
    out["order_monitor_classify"] = {
        "五档各一行_含站点空丢弃与超180天只入表": ({"today": today, "yesterday": yesterday, "date": T, "_yesterday_date": Y}, {}),
    }
    return out


# ---------------------------------------------------------------- 跑口径层

def run(family: str, inp: dict, settings: dict):
    if family == "names":
        import names as N
        if "raw" in inp:
            return [N.owner_name(x) for x in inp["raw"]]
        return [N.is_agent_id(x) for x in inp["names"]]
    if family == "churn_assess":
        from churn import assess as A
        return A.assess(inp["days"], inp["today"], inp.get("prev"), settings, gateway=inp.get("gateway"))
    if family == "churn_overview":
        from churn import overview as OV
        return OV.build(inp["days"], inp["date"], inp.get("n_days", 30), inp.get("top_n", 10))
    if family == "churn_trade":
        from churn import trade as T
        return T.build(inp["days"], inp["date"], inp.get("period", "日"), inp.get("n", 12), inp.get("metric", "tpv"),
                       inp.get("top_n", 10), anchor=inp.get("anchor"), weeks=inp.get("weeks") or [])
    if family == "churn_daily":
        from churn import daily as DL
        return DL.summary(inp["state"], settings)
    if family == "churn_assess_chain":
        from churn import assess as A
        prev, states, hits = None, {}, {}
        for d in inp["dates"]:
            st = A.assess(inp["days"], d, prev, settings, gateway=inp.get("gateway"))
            states[d] = st
            hits[d] = [h["type"] for h in st.get("hits") or []]
            prev = st if st.get("ok") else prev
        return {"dates": inp["dates"], "hits": hits, "states": states}
    if family == "churn_weekly":
        from churn import weekly as W
        return W.summary(inp["ws"], inp.get("states"), settings, inp.get("follow") or {}, date=inp.get("date") or "")
    if family == "churn_funnel":
        from churn import funnel as F
        return F.build(inp["detail"], inp.get("state"), settings or None, date=inp["date"])
    if family == "churn_trade_drill":
        from churn import trade as T
        return {"drill": T.drill(inp["days"], inp["date"], inp["period"], inp.get("filters") or {}, inp.get("metric", "tpv"),
                                 limit=inp.get("limit", 200), anchor=inp.get("anchor")),
                "options": T.options(inp["days"], inp["date"], inp["period"], anchor=inp.get("anchor"))}
    if family in JS_FAMILIES:
        import subprocess
        r = subprocess.run(["node", str(ROOT / "scripts" / "golden_js.mjs")],
                           input=json.dumps({"family": family, "input": inp, "settings": settings}, ensure_ascii=False),
                           capture_output=True, text=True, cwd=str(ROOT))
        if r.returncode != 0:
            raise RuntimeError(f"{family}: node 跑挂了：{(r.stderr or '').strip()[-400:]}")
        return json.loads(r.stdout)
    if family == "order_monitor_classify":
        try:
            import pandas as pd
        except ModuleNotFoundError:
            return None      # 调用方说「跳过」
        from order_monitor import classify as CL
        audit: list = []
        res = CL.classify_from_excel(pd.DataFrame(inp["today"]), pd.DataFrame(inp["yesterday"]), inp["date"], audit=audit)
        return {"results": res, "audit": audit}
    raise KeyError(f"不认识的族：{family}")


def _jsonable(o):
    """pandas 的 Series / DataFrame → dict（classify 的 audit 条目里带着整行）；别的交给 str。
    str(Series) 带 dtype 和对齐空格，两台机器都不一定一样，逐字节比不了。"""
    if hasattr(o, "to_dict"):
        d = o.to_dict()
        return {str(k): (None if (isinstance(v, float) and v != v) else v) for k, v in d.items()}
    return str(o)


def normalize(obj):
    """dict / tuple / datetime / pandas 行 → JSON 能落盘的形状（tuple 变 list）。"""
    return json.loads(json.dumps(obj, ensure_ascii=False, default=_jsonable))


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--init", action="store_true")
    g.add_argument("--generate", action="store_true")
    g.add_argument("--check", action="store_true")
    a = ap.parse_args()

    if a.init:
        n = 0
        for fam, cs in cases().items():
            for name, (inp, settings) in cs.items():
                d = GOLDEN / fam / name
                if not (d / "input.json").exists():
                    write(d / "input.json", normalize(inp))
                    write(d / "settings.json", settings)
                    n += 1
        print(f"补了 {n} 条用例的输入")
        return 0

    bad, skipped, ok = [], [], 0
    for fam_dir in sorted(p for p in GOLDEN.iterdir() if p.is_dir()):
        for case in sorted(p for p in fam_dir.iterdir() if p.is_dir()):
            inp = json.loads((case / "input.json").read_text(encoding="utf-8"))
            settings = json.loads((case / "settings.json").read_text(encoding="utf-8"))
            got = run(fam_dir.name, inp, settings)
            if got is None:
                skipped.append(f"{fam_dir.name}/{case.name}（缺 pandas）")
                continue
            got = normalize(got)
            exp_p = case / "expected.json"
            if a.generate:
                write(exp_p, got)
                ok += 1
            else:
                if not exp_p.exists():
                    bad.append(f"{fam_dir.name}/{case.name}: 还没有 expected.json（先 --generate）")
                elif exp_p.read_text(encoding="utf-8") != dump(got):
                    bad.append(f"{fam_dir.name}/{case.name}: 和 expected.json 不一致")
                else:
                    ok += 1
    for s in skipped:
        print("  跳过 " + s)
    for b in bad:
        print("  FAIL " + b)
    print(f"{'生成' if a.generate else '一致'} {ok} 条" + (f"，跳过 {len(skipped)}" if skipped else "") + (f"，不一致 {len(bad)}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
