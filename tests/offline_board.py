# -*- coding: utf-8 -*-
"""
offline_board.py - 独立单文件看板（board/ + 生成看板.py，第三次调整 Q1~Q15）。零依赖，整套换到临时目录。

    python tests/offline_board.py                       # 合成数据；有 node 才验转化率那块（没有会说出来，不装作过了）
    WB_CHROME=<chrome> python tests/offline_board.py    # 再用无头 Chromium 真开一次，四块都得渲染出内容

钉的：
  ★ 四块各自取自己最新的一天；缺哪块那块 ok:false + 原因，不当 0、不让整张页塌
  ★ 交易概览三档 × 两指标都预先算好；商户流失有状态 / 漏斗 / 周报；出单监控嵌的是原始台账；转化率嵌 ds + 三个周期的基准线
  ★ CSS 加前缀隔离：:root 不动、body 丢掉、@media 里面也加、选择器逗号分开各加
  ★ 从同步来的 static/conversion.html 里抽得到「概览 / 异常明细」两个面板（工作台改了标记这里红）
  ★ 打包：从入口收齐全部相对 import、改写成 wb: 说明符；**不许**把 baseline / feishu / main / render/index 拖进来（它们顶层绑 DOM、会 fetch）
  ★ 落盘：看板_<date>.html + 看板.html（最新日期那份），补跑更早的不覆盖，只留 keep 份；</ 转义；页面里没有 /static/ 引用
  ★ Chromium：四块都渲染出内容、没有「渲染失败」
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from board import blocks as B  # noqa: E402
from board import bundle as BD  # noqa: E402
from board import page as PG  # noqa: E402
from board import export as X  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:400]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


def has_node() -> bool:
    try:
        return subprocess.run(["node", "--version"], capture_output=True, text=True).returncode == 0
    except FileNotFoundError:
        return False


# ---------------------------------------------------------------- 合成数据
def site_row(uid, site, amt, n, owner="赵娜", mode="标准收银台", agent=""):
    return {"用户ID": uid, "站点": site, "商户名称": "商户" + uid[-1], "直签人": owner, "代理商ID": agent,
            "代理商名称": "代理甲" if agent else "", "接入模式": mode, "交易金额": float(amt), "交易笔数": n}


def om_row(**o):
    base = {"行号": 0, "用户ID": "1000000000000000001", "商户名称": "m", "站点": "s.example.com", "所属BD": "BD甲",
            "去向": "未出单", "落点": "通知+表", "累计TPV_USD": 0, "开通天数": None, "备注": "",
            "站点_上线时长": 0, "支付方式_上线时长": 0, "站点_网站审核耗时": 0, "支付方式_网站审核耗时": 0,
            "通道审核耗时": 0, "集成耗时": 0, "建议进件通道": "WORLDPAY",
            "站点_商户提交日期": "2026-09-01", "站点_风控审核日期": None, "支付方式_商户提交日期": "2026-09-01",
            "支付方式_风控审核日期": None, "提交通道日期": None, "通道结果反馈日期": None, "第一笔成功交易日期": None}
    base.update(o)
    return base


DISP = ["新出单", "测试交易", "小额滞留", "新审核通过", "未出单", "待激活", "存量已出单", "小额爬坡", "通道审核中",
        "待提交通道", "开通>180天", "站点为空", "老商户排除"]
SINK = {"新出单": "通知+表", "测试交易": "通知+表", "小额滞留": "通知+表", "新审核通过": "通知+表", "未出单": "通知+表",
        "待激活": "通知+表", "存量已出单": "仅表", "小额爬坡": "仅表", "通道审核中": "仅表", "待提交通道": "仅表",
        "开通>180天": "仅表", "站点为空": "丢弃", "老商户排除": "丢弃"}


def om_ledger(date):
    rows = [
        om_row(行号=0, 用户ID="1000000000000000001", 商户名称="甲商户", 去向="新出单", 备注="✅ 新出单", 站点_上线时长=100, 集成耗时=50,
               通道审核耗时=10, 提交通道日期="2026-09-01", 通道结果反馈日期="2026-09-02", 第一笔成功交易日期="2026-09-05", 累计TPV_USD=1200),
        om_row(行号=1, 用户ID="1000000000000000002", 商户名称="乙商户", 去向="通道审核中", 落点="仅表", 建议进件通道="FISERV",
               提交通道日期="2026-09-02"),
        om_row(行号=2, 用户ID="1000000000000000003", 商户名称="丙商户", 去向="待激活", 备注="🟡 60-180天待激活", 开通天数=88,
               提交通道日期="2026-06-01", 通道结果反馈日期="2026-06-05"),
        om_row(行号=3, 用户ID="1000000000000000004", 商户名称="丁商户", 去向="老商户排除", 落点="丢弃", 所属BD="",
               第一笔成功交易日期="2025-01-01"),
    ]
    tally = {d: 0 for d in DISP}
    sinks = {"通知+表": 0, "仅表": 0, "丢弃": 0}
    for r in rows:
        tally[r["去向"]] += 1
        sinks[r["落点"]] += 1
    return {"date": date, "总行数": len(rows), "去向顺序": DISP, "落点顺序": ["通知+表", "仅表", "丢弃"], "对账": tally,
            "落点": sinks, "去向说明": {d: f"为什么落到{d}" for d in DISP}, "落点归属": SINK, "属性列": ["建议进件通道"],
            "耗时列": ["站点_上线时长", "支付方式_上线时长", "站点_网站审核耗时", "支付方式_网站审核耗时", "通道审核耗时", "集成耗时"],
            "耗时单位": "小时 · 不含节假日", "耗时口径": "报表原值", "明细": rows,
            "被拒站点": {"行数": 2, "无BD行数": 1, "当日新增": None, "对比说明": "没有可比的前一天", "读取失败原因": "",
                     "明细": [{"用户ID": "1000000000000000009", "商户名称": "被拒甲", "站点": "r.example.com", "所属BD": "", "站点_商户提交时间": "2026-09-01"},
                            {"用户ID": "1000000000000000008", "商户名称": "被拒乙", "站点": "q.example.com", "所属BD": "BD乙", "站点_商户提交时间": "2026-09-02"}],
                     "新增明细": []},
            "本次运行": {"mode": "silent", "跑完于": f"{date} 10:31", "发送": [{"步骤": "群通知", "结果": "没跑"}]}}


def churn_state(date):
    site = lambda uid, s, days, tpv, **x: {"key": f"{uid}|{s}", "用户ID": uid, "站点": s, "商户名称": "商户" + uid[-1], "直签人": "赵娜",
                                          "代理商名称": "", "接入模式": "标准收银台", "gw": "网关数据缺", "incident": [],
                                          "last_active": "2026-09-15", "silent_days": days, "silence_level": None, "recovered_on": None,
                                          "drop": None, "tpv30": float(tpv), "tpv_asof": date, "active30": 20, "uncertain": False,
                                          "sporadic": False, "rank": 1, "eligible": True, **x}
    sites = {"1000000000000000001|a.example.com": site("1000000000000000001", "a.example.com", 3, 9000, silence_level=2),
             "1000000000000000002|b.example.com": site("1000000000000000002", "b.example.com", 0, 8000),
             "1000000000000000003|c.example.com": site("1000000000000000003", "c.example.com", 2, 100, eligible=False)}
    hits = [{**sites["1000000000000000001|a.example.com"], "type": "沉默2"},
            {**sites["1000000000000000002|b.example.com"], "type": "掉量·推", "drop": {"level": "掉量·推", "opened": date, "base": 5000.0, "ratio": -0.8}}]
    return {"ok": True, "date": date, "window": ["2026-08-20", date], "gap": [], "sites": sites, "hits": hits,
            "counts": {"沉默2": 1, "掉量·推": 1}, "eligible_n": 2,
            "incidents": [{"网关": "网关A", "merchants": 3, "sites": 4, "uids": ["1000000000000000001", "1000000000000000002", "1000000000000000005"]}],
            "gateway": {"has_today": False, "latest": "2026-09-16", "merchants": 0},
            "settings": {"top_n": 30, "silence_days": [2, 7, 30], "drop_push": -0.7, "drop_page": -0.5,
                         "gateway_incident_min": 3, "gateway_incident_top_n": 50}}


def week(label, start, end, complete, rows):
    return {"期次": label, "start": start, "end": end, "source_date": end if complete else start, "complete": complete,
            "rows": rows}


def make_data(root: Path, *, with_om=True, with_conv=True):
    led = root / "churn" / "ledger"
    led.mkdir(parents=True)
    for i, d in enumerate(("2026-09-14", "2026-09-15", "2026-09-17")):          # 09-16 缺
        rows = [site_row("1000000000000000001", "a.example.com", 1000 + i, 10),
                site_row("1000000000000000002", "b.example.com", 500, 5, "赵娜", "API"),
                site_row("1000000000000000004", "d.example.com", 200, 2, "1000000000000000099", "标准收银台", agent="1000000000000000099")]
        if d == "2026-09-17":
            rows.append(site_row("1000000000000000003", "c.example.com", 300, 3))
        (led / f"{d}.json").write_text(json.dumps({"date": d, "source_date": d, "sites": rows}, ensure_ascii=False), encoding="utf-8")
    wk = root / "churn" / "weekly"
    wk.mkdir(parents=True)
    r1 = [{"用户ID": "1000000000000000001", "站点": "a.example.com", "商户名称": "商户1", "直签人": "赵娜", "交易金额": 7000.0, "交易笔数": 70},
          {"用户ID": "1000000000000000002", "站点": "b.example.com", "商户名称": "商户2", "直签人": "赵娜", "交易金额": 3000.0, "交易笔数": 30}]
    r2 = [{"用户ID": "1000000000000000001", "站点": "a.example.com", "商户名称": "商户1", "直签人": "赵娜", "交易金额": 6000.0, "交易笔数": 60}]
    (wk / "2026-09-03.json").write_text(json.dumps(week("2026 W36 (2026-08-28~2026-09-03)", "2026-08-28", "2026-09-03", True, r1), ensure_ascii=False), encoding="utf-8")
    (wk / "2026-09-10.json").write_text(json.dumps(week("2026 W37 (2026-09-04~2026-09-10)", "2026-09-04", "2026-09-10", True, r2), ensure_ascii=False), encoding="utf-8")
    (wk / "2026-09-17.json").write_text(json.dumps(week("2026 W38 (2026-09-11~2026-09-17)", "2026-09-11", "2026-09-17", False, r2), ensure_ascii=False), encoding="utf-8")
    st = root / "churn" / "state"
    st.mkdir(parents=True)
    (st / "2026-09-17.json").write_text(json.dumps(churn_state("2026-09-17"), ensure_ascii=False), encoding="utf-8")
    if with_om:
        om = root / "出单监控结果"
        om.mkdir()
        (om / "出单监控台账_2026-09-16.json").write_text(json.dumps(om_ledger("2026-09-16"), ensure_ascii=False), encoding="utf-8")
        (om / "出单监控结果_2026-09-16.json").write_text(json.dumps(
            {"date": "2026-09-16", "counts": {"✅ 新出单": 1}, "audit_counts": {"通知+表": 3, "仅表": 1, "丢弃": 1},
             "merchants": [{"用户ID": "1000000000000000001", "商户名称": "甲商户", "状态": "✅ 新出单"}]}, ensure_ascii=False), encoding="utf-8")
    if with_conv and has_node():
        conv = root / "inbox" / "conversion"
        conv.mkdir(parents=True)
        r = subprocess.run(["node", str(ROOT / "tests" / "_board_xlsx.mjs"), str(conv / "2026-09-17.xlsx"), str(conv / "2026-09-16.xlsx")],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("造转化率报表失败：" + (r.stderr or r.stdout)[-500:])


tmp = Path(tempfile.mkdtemp(prefix="wb_board_"))
data, out = tmp / "data", tmp / "看板"
try:
    print("[1] ★ 空目录：四块各自 ok:false + 原因，不当 0")
    r = B.build_all(tmp / "nothing")
    check("四块顺序 交易概览 / 商户流失 / 出单监控 / 转化率", [b["key"] for b in r["blocks"]] == ["trade", "churn", "om", "conversion"], [b["key"] for b in r["blocks"]])
    check("全部 ok:false 且各带原因", all(not b["ok"] and b["reason"] for b in r["blocks"]), [(b["key"], b["reason"]) for b in r["blocks"]])
    check("没有日期", r["date"] is None)

    print("\n[2] ★ 合成数据：四块各取自己最新的一天")
    make_data(data)
    r = B.build_all(data)
    bl = {b["key"]: b for b in r["blocks"]}
    check("文件日期 = 最新那天 09-17", r["date"] == "2026-09-17", r["date"])
    t = bl["trade"]
    check("交易概览 ok、日期 09-17", t["ok"] and t["date"] == "2026-09-17", t.get("reason"))
    check("三档 × 两指标都算好了", set(t["periods"]) == {"日", "周", "月"} and all(set(v) == {"tpv", "orders"} for v in t["periods"].values()), list(t["periods"]))
    day = t["periods"]["日"]["tpv"]
    check("日：当期 1802 + 300、缺的 09-16 那期 ok:false 值 None", day["current"]["tpv"] == 2002.0
          and next(p for p in day["series"] if p["key"] == "2026-09-16")["ok"] is False
          and next(p for p in day["series"] if p["key"] == "2026-09-16")["tpv"] is None, day["current"])
    wkp = t["periods"]["周"]["tpv"]
    check("周：期次用报表原话（W38）、周界周五起", wkp["current"]["label"].startswith("2026 W38") and wkp["week_anchor"] == 4, (wkp["current"], wkp["week_anchor"]))
    check("构成四维 + 前 N 商户 + 代理商 ID 显示成代理商", set(day["by"]) == {"接入模式", "直签人", "代理商", "商户"} and day["top"]
          and any(g["name"].startswith("代理商") for g in day["by"]["直签人"]), (list(day["by"]), day["by"]["直签人"]))

    c = bl["churn"]
    check("商户流失 ok、日期 09-17、sites 是数组按 tpv30 降序", c["ok"] and c["date"] == "2026-09-17" and isinstance(c["state"]["sites"], list)
          and [s["tpv30"] for s in c["state"]["sites"]] == [9000.0, 8000.0, 100.0], c.get("reason"))
    check("★ 没有 follow（离线拿不到飞书），页面上不会显示成「无人认领」", all("follow" not in s for s in c["state"]["sites"]) and all("follow" not in h for h in c["state"]["hits"]))
    check("漏斗用的是出单监控 09-16 那份台账 + 状态 09-17", c["funnel"]["ok"] and c["funnel"]["order_monitor_date"] == "2026-09-16" and c["funnel"]["state_date"] == "2026-09-17", c["funnel"].get("reason"))
    check("周报：两个走完的周 → ok，掉了商户2（$3000）、正文有字", c["weekly"]["ok"] and c["weekly"]["lost"]["tpv"] == 3000.0 and "W37" in c["weekly"]["cur"] and c["weekly"]["text"], c["weekly"])
    check("★ 周报正文里没有「谁在跟」那段（一条都没填时整段不出现）", "跟进" not in c["weekly"]["text"] or "无人认领" not in c["weekly"]["text"], c["weekly"]["text"])

    o = bl["om"]
    check("出单监控 ok、日期 09-16（它自己最新的一天，不是 09-17）、嵌的是原始台账", o["ok"] and o["date"] == "2026-09-16" and o["ledger"]["总行数"] == 4 and o["ledger"]["去向顺序"] == DISP, o.get("reason"))

    cv = bl["conversion"]
    if has_node():
        check("转化率 ok、日期 09-17、ds 三样都在", cv["ok"] and cv["date"] == "2026-09-17" and all(k in cv["ds"] for k in ("periods", "scene", "merchantSite", "dates")), cv.get("reason"))
        check("日报可用、两期日期", cv["ds"]["periods"]["日报"]["ok"] and cv["ds"]["dates"]["日报"][:2] == ["2026-09-17", "2026-09-16"], cv["ds"].get("dates"))
        check("三个周期各有一栏基准线（没历史的那档是 null，不是 {}）", set(cv["baselines"]) == {"日报", "周报", "月报"} and cv["baselines"]["日报"] is not None and cv["baselines"]["周报"] is None, {k: type(v).__name__ for k, v in cv["baselines"].items()})
        check("出单监控名单也喂进去了（待观察商户要它）", cv["om"] and cv["om"]["found"] is True and cv["om"]["date"] == "2026-09-16", cv.get("om"))
    else:
        print("  跳过 转化率那块：这台机器没有 node（装了再跑一次）—— 下面只验「没 node 时说清原因」")
        check("没 node → ok:false 且原因里写了 Node", not cv["ok"] and "Node" in cv["reason"], cv.get("reason"))

    print("\n[2b] 缺出单监控：那一块和漏斗各自说原因，别的照常")
    d2 = tmp / "data2"
    make_data(d2, with_om=False, with_conv=False)
    r2 = B.build_all(d2)
    b2 = {b["key"]: b for b in r2["blocks"]}
    check("出单监控 ok:false 带原因", not b2["om"]["ok"] and "出单监控" in b2["om"]["reason"], b2["om"].get("reason"))
    check("漏斗 ok:false 说清要先跑出单监控", b2["churn"]["ok"] and not b2["churn"]["funnel"]["ok"] and "出单监控" in b2["churn"]["funnel"]["reason"], b2["churn"]["funnel"])
    check("转化率没报表 → ok:false 带原因", not b2["conversion"]["ok"] and b2["conversion"]["reason"], b2["conversion"].get("reason"))
    check("文件日期还是 09-17", r2["date"] == "2026-09-17")

    print("\n[3] ★ CSS 加前缀")
    css = """:root{--a:1}\n@media (x){ :root:where(:not([data-theme="light"])){--a:2} .k,.j b{color:red} }\nbody{margin:0}\n*{box-sizing:border-box}\n.card h2,.x>.y{m:1}\n.panel[hidden]{display:none!important}\n"""
    s = PG.scope_css(css, "#blk-c")
    check(":root 不动", ":root{--a:1}" in s and ':root:where(:not([data-theme="light"])){--a:2}' in s, s)
    check("@media 里面的也加了、逗号分开各加", "#blk-c .k,#blk-c .j b{color:red}" in s, s)
    check("body 丢掉、* 不动", "body{" not in s and "*{box-sizing:border-box}" in s, s)
    check("普通选择器加前缀", "#blk-c .card h2,#blk-c .x>.y{m:1}" in s and "#blk-c .panel[hidden]{display:none!important}" in s, s)

    print("\n[4] ★ 从同步来的 conversion.html 抽两个面板 + 样式")
    html = (ROOT / "static" / "conversion.html").read_text(encoding="utf-8")
    ov, de = PG.extract_panels(html)
    check("概览面板：id 在、hidden 去掉、含 #kpis / #sourceBlocks / #summary", ov.startswith('<div class="panel" id="p-overview">') and all(f'id="{i}"' in ov for i in ("kpis", "prio", "porate", "level", "trend", "churn", "watch", "sourceBlocks", "summary")), ov[:120])
    check("明细面板：含筛选栏和两个 wrap", de.startswith('<div class="panel" id="p-detail">') and all(f'id="{i}"' in de for i in ("topMerchants", "prioDrillWrap", "fSrc", "fStage", "fRole", "fDim", "fKw", "fReset", "fReset2", "detailTotalWrap", "detailSiteWrap", "detailEmpty", "totCnt", "siteCnt")), de[:120])
    check("两个面板都以 </div> 收尾且不含下一个面板", ov.rstrip().endswith("</div>") and "p-detail" not in ov and de.rstrip().endswith("</div>") and "p-cast" not in de)
    css2 = PG.extract_style(html)
    check("样式块抽到了（含 .kpis 和 .tr-box）", ".kpis{" in css2 and ".tr-box" in css2)
    try:
        PG.extract_panels(html.replace("面板：异常明细", "面板：xx"))
        check("★ 标记没了要抛，不静默抽空", False)
    except ValueError as e:
        check("★ 标记没了要抛，不静默抽空", "面板" in str(e), e)

    print("\n[5] ★ 打包：收齐相对 import，不拖进带 DOM 副作用 / 会 fetch 的模块")
    mods = BD.collect_modules("board/js/main.js")
    check("入口在、四块的口径模块在", "wb:board/js/main.js" in mods and all(k in mods for k in (
        "wb:static/js/order_monitor/analyze.js", "wb:static/js/churn/analyze.js", "wb:static/js/churn/overview.js",
        "wb:static/js/trade/analyze.js", "wb:static/js/conversion/analyze.js", "wb:static/js/conversion/render/overview.js",
        "wb:static/js/conversion/render/detail.js", "wb:static/js/shared/dom.js")), sorted(mods)[:40])
    bad = [k for k in mods if k.endswith(("conversion/baseline.js", "conversion/feishu.js", "conversion/main.js", "render/index.js", "render/broadcast.js", "shared/ai.js"))]
    check("★ baseline / feishu / main / render/index / render/broadcast / shared/ai 一个都没拖进来", not bad, bad)
    check("改写后没有相对说明符残留", not any(("from './" in v or "from '../" in v or 'from "./' in v or 'from "../' in v) for v in mods.values()))
    own = "\n".join(v for k, v in mods.items() if k.startswith("wb:board/"))
    check("看板自己的 JS 不 fetch、不引 /static/", "fetch(" not in own and "/static/" not in own)
    im = json.loads(BD.importmap(mods))
    check("importmap 全是 data: URL", all(v.startswith("data:text/javascript;base64,") for v in im["imports"].values()))

    print("\n[6] ★ 落盘")
    e = X.export_board(data, out_dir=out, keep=2, now="2026-09-18 11:30")
    check("生成了 看板_2026-09-17.html + 看板.html", e["ok"] and Path(e["path"]).name == "看板_2026-09-17.html" and (out / "看板.html").exists(), e)
    page = (out / "看板.html").read_text(encoding="utf-8")
    check("四块的壳按顺序在", [page.index(f'data-block="{k}"') for k in ("trade", "churn", "om", "conversion")] == sorted(page.index(f'data-block="{k}"') for k in ("trade", "churn", "om", "conversion")))
    check("嵌了数据、importmap、入口", 'id="board-data"' in page and '<script type="importmap">' in page and 'import "wb:board/js/main.js"' in page)
    check("★ 页面里没有 /static/ 引用、没有外链脚本", "/static/" not in page and "<script src=" not in page and "<link " not in page)
    check("生成时间和文件日期写进去了", "2026-09-18 11:30" in page and "2026-09-17" in page)
    evil = json.loads(page[page.index('id="board-data"'):].split(">", 1)[1].split("</script>", 1)[0].replace("<\\/", "</"))
    check("嵌的数据能原样读回（</ 转义只在文本层）", evil["date"] == "2026-09-17" and [b["key"] for b in evil["blocks"]] == ["trade", "churn", "om", "conversion"])
    check("★ 数据里的 </ 已转义（商户名里一个 </script> 就截断页面）", "<\\/" in X.embed_json({"x": "</script>"}))
    latest_before = page
    (data / "churn" / "state" / "2026-09-10.json").write_text(json.dumps(churn_state("2026-09-10"), ensure_ascii=False), encoding="utf-8")
    e2 = X.export_board(data, out_dir=out, date="2026-09-10", keep=2, now="2026-09-18 11:31")
    check("★ 补跑更早的一天：生成带日期的那份，看板.html 不动", e2["ok"] and (out / "看板_2026-09-10.html").exists() and (out / "看板.html").read_text(encoding="utf-8") == latest_before, e2)
    X.export_board(data, out_dir=out, date="2026-09-14", keep=2, now="2026-09-18 11:32")
    names = sorted(p.name for p in out.iterdir())
    check("★ keep=2：最早那份被清掉，看板.html 不算在内", names == ["看板.html", "看板_2026-09-14.html", "看板_2026-09-17.html"], names)
    e3 = X.export_board(tmp / "nothing", out_dir=tmp / "o3")
    check("一天数据都没有 → 不生成、说原因", not e3["ok"] and e3["path"] is None and e3["reason"], e3)

    print("\n[7] ★ 无头 Chromium 真开一次（WB_CHROME）")
    chrome = os.environ.get("WB_CHROME") or ("/opt/pw-browsers/chromium" if Path("/opt/pw-browsers/chromium").exists() else "")
    if not chrome:
        print("  跳过（没设 WB_CHROME）")
    else:
        prof = tmp / "prof"
        r = subprocess.run([chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-proxy-server", f"--user-data-dir={prof}",
                            "--virtual-time-budget=20000", "--dump-dom", (out / "看板.html").resolve().as_uri()],
                           capture_output=True, text=True, timeout=180)
        dom = r.stdout
        check("打开了", r.returncode == 0 and len(dom) > 1000, (r.returncode, (r.stderr or "")[-300:]))
        check("交易概览渲染出了内容（本期交易额 + 排名）", "本期交易额" in dom and "排名" in dom)
        check("商户流失渲染出了内容（今日命中 + 沉默名单 + 老板周报）", "今日命中" in dom and "沉默名单" in dom and "老板周报" in dom)
        check("出单监控渲染出了内容（对账 + 耗时 + 分类 + 被拒站点）", all(k in dom for k in ("对账", "耗时", "分类", "被拒站点")))
        if has_node():
            check("转化率渲染出了内容（成功率 KPI + 异常明细）", "成功率" in dom and "合计行异常" in dom)
        check("★ 没有一块写着「渲染失败」", "渲染失败" not in dom, [ln for ln in dom.splitlines() if "渲染失败" in ln][:3])
        check("★ 数据日期和文件日期不同的块标黄（出单监控 09-16）", 'class="bdate warn"' in dom or "bdate warn" in dom)
finally:
    keep = os.environ.get("WB_BOARD_KEEP")          # 想亲眼看一眼生成的页：WB_BOARD_KEEP=<目录> 会把 看板/ 拷过去
    if keep and out.is_dir():
        shutil.copytree(out, keep, dirs_exist_ok=True)
    shutil.rmtree(tmp, ignore_errors=True)

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
