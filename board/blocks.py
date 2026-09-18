# -*- coding: utf-8 -*-
"""board.blocks —— 四块各自的数据，顺序 交易概览 → 商户流失 → 出单监控 → 转化率（用户定的）。

算数一行不新写：交易概览走 `churn.trade.build`（和工作台交易概览页同一个函数，三档 × 两指标各跑一遍）；
商户流失的漏斗走 `churn.funnel.build`、周报走 `churn.weekly.summary/text`（和页面、和发出去的正文同一份）；
出单监控嵌**原始台账**，页面里用同步来的 `order_monitor/analyze.js` 算（和工作台那页同一份）；
转化率起 Node 跑 `转化率快照.mjs`：同步来的 `dataset.js` 读报表、`baseline.js` 按存档算基准线，页面里 `analyze.js` 现算。

每块：{key, label, date, ok, reason, ...payload}。
⚠ 缺哪块那块 ok:false + 原因，**不当 0**（坑.md §2.12）；文件坏了 reason 里带文件名。
⚠ 四块各用**自己**最新的一天（Q15）；给了 date 就用那天，那天没有的块退回它自己最新的并在 reason 里说。
⚠ 「谁在跟」是飞书多维表格回读的，离线拿不到 → 状态里**不带 follow**，周报的 follow 传 {}（一条没填时那段整个不出现，§2.21.6）。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from churn import config as C
from churn import funnel as F
from churn import trade as T
from churn import weekly as W

from .data import Data

HERE = Path(__file__).resolve().parent
NODE_SNAPSHOT = HERE / "转化率快照.mjs"
ORDER = ["trade", "churn", "om", "conversion"]
LABEL = {"trade": "交易概览", "churn": "商户流失", "om": "出单监控", "conversion": "转化率"}
TRADE_N = 12
TRADE_TOP = 10
ARCHIVE_MAX = 12          # 基准线最多读几份存档（和工作台 conversion_job.ARCHIVE_MAX / config.ARCHIVE_MAX_FILES 同一个数）
NODE_TIMEOUT = 600


def _block(key: str, date, ok: bool, reason: str = "", **payload) -> dict:
    return {"key": key, "label": LABEL[key], "date": date, "ok": bool(ok), "reason": reason, **payload}


def _pick(dates: list[str], want: str | None) -> tuple[str | None, str]:
    """要哪天：给了且有 → 那天；给了没有 → 最新 + 说明；没给 → 最新。"""
    if not dates:
        return None, ""
    if want and want in dates:
        return want, ""
    latest = dates[-1]
    return latest, (f"没有 {want} 这天的，用的是最新的 {latest}" if want else "")


# ---------------------------------------------------------------- ① 交易概览
def trade(data: Data, want: str | None = None) -> dict:
    key = "trade"
    ds = data.ledger_dates()
    date, note = _pick(ds, want)
    if not date:
        return _block(key, None, False, f"没有站点台账（{data.ledger}）—— 工作台灌过台账（python -m churn seed）才有")
    weeks = data.weeks()
    anchor = T.anchor_from_ledger(weeks)
    periods, broken_all = {}, []
    for period in T.PERIODS:
        buckets = T.periods_back(date, period, TRADE_N, anchor)
        days, broken = data.ledger_days(buckets[0]["start"], buckets[-1]["end"])
        broken_all += [b for b in broken if b not in broken_all]
        periods[period] = {m: T.build(days, date, period, TRADE_N, m, TRADE_TOP, anchor=anchor, weeks=weeks)
                           for m in T.METRICS}
    reason = "；".join(x for x in [note, *broken_all] if x)
    return _block(key, date, True, reason, periods=periods, order=list(T.PERIODS), metrics=list(T.METRICS), n=TRADE_N)


# ---------------------------------------------------------------- ② 商户流失
def _site_rows(state: dict) -> list[dict]:
    """状态里的 sites 是 dict，发给页面前排成数组（30 天 TPV 降序）—— 顺序走数组（§2.18.5）。和工作台 churn_api._site_rows 同一条规矩。"""
    sites = list((state.get("sites") or {}).values())
    sites.sort(key=lambda x: (-(x.get("tpv30") or 0), x.get("key") or ""))
    return sites


def _funnel(data: Data, st: dict, date: str) -> dict:
    """生命周期漏斗头：前三级来自出单监控台账（取状态那天的，没有就最新一份），后两级来自状态。"""
    oms = data.om_ledger_dates()
    if not oms:
        return {"ok": False, "reason": "出单监控还没跑过一次 —— 漏斗的前三级（提交 / 通过 / 首笔）全靠它那份报表", "levels": [], "steps": [], "stuck": []}
    od = date if date in oms else oms[-1]
    led, err = data.om_ledger(od)
    if err or not isinstance(led, dict):
        return {"ok": False, "reason": err or f"出单监控台账 {od} 读不出来", "levels": [], "steps": [], "stuck": []}
    out = F.build(led.get("明细") or [], st, date=led.get("date") or od)
    out["order_monitor_date"] = led.get("date") or od
    out["state_date"] = st.get("date") or date
    return out


def _weekly(data: Data, st: dict, date: str) -> dict:
    """老板周报（和 churn.weekly_job.build 同一条算法，只是台账 / 状态从 data_dir 读、follow 是空的）。"""
    settings = C.settings(st.get("settings") or {})
    ws = [w for w in data.weeks() if w.get("complete")]
    if len(ws) < 2:
        return {"ok": False, "date": date, "reason": f"周台账里只有 {len(ws)} 个走完的周，头条要两个完整周才算得出来", "text": ""}
    cur = ws[-1]
    # 在途风险的窗口：这一周的第一天到 date。倒过来传 None（算不出来），不传 []（真的 0 家）—— 同 weekly_job.build
    win = W.risk_window(cur.get("start") or date, date)
    sts = None
    if win:
        sts = []
        for d in data.state_dates():
            if win[0] <= d <= win[1]:
                obj, _ = data.state(d)
                if isinstance(obj, dict):
                    sts.append(obj)
    sm = W.summary(ws, sts, settings, {}, date=date)
    sm["text"] = W.text(sm) if sm.get("ok") else ""
    return sm


def churn(data: Data, want: str | None = None) -> dict:
    key = "churn"
    ds = data.state_dates()
    date, note = _pick(ds, want)
    if not date:
        return _block(key, None, False, f"没有流失状态（{data.state_dir}）—— 工作台的商户流失 job 跑过一次才有")
    st, err = data.state(date)
    if err or not isinstance(st, dict):
        return _block(key, date, False, err or f"state/{date}.json 不是状态文件")
    view = {k: v for k, v in st.items() if k != "sites"}
    view["sites"] = _site_rows(st)
    view["hits"] = list(st.get("hits") or [])
    return _block(key, st.get("date") or date, True, note, state=view,
                  funnel=_funnel(data, st, date), weekly=_weekly(data, st, date))


# ---------------------------------------------------------------- ③ 出单监控
def om(data: Data, want: str | None = None) -> dict:
    key = "om"
    ds = data.om_ledger_dates()
    date, note = _pick(ds, want)
    if not date:
        return _block(key, None, False, f"没有出单监控台账（{data.om}）—— 工作台的出单监控跑过一次才有")
    led, err = data.om_ledger(date)
    if err or not isinstance(led, dict):
        return _block(key, date, False, err or f"出单监控台账_{date}.json 不是台账")
    return _block(key, led.get("date") or date, True, note, ledger=led)


def om_latest_result(data: Data, date: str | None) -> dict | None:
    """转化率「待观察商户」要的出单监控名单（B15）：那天的结果 json，没有就最近一份。形状照 /api/order-monitor/latest。"""
    ds = data.om_result_dates()
    if not ds:
        return None
    d = date if date in ds else ds[-1]
    obj, _ = data.om_result(d)
    if not isinstance(obj, dict):
        return None
    return {**obj, "ok": True, "found": True}


# ---------------------------------------------------------------- ④ 转化率
def _node(payload: dict, node: str, timeout: int = NODE_TIMEOUT) -> dict:
    """跑一次快照脚本。入参走 stdin（命令行在任务管理器里明文可见）；stderr 是日志。"""
    try:
        p = subprocess.run([node, str(NODE_SNAPSHOT)], input=json.dumps(payload, ensure_ascii=False),
                           capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    except FileNotFoundError:
        return {"ok": False, "msg": f"找不到 {node} —— 转化率那块要 Node 18+（口径只有 JS 版）。装了 Node 再跑一次，其余三块不受影响"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "msg": f"Node 跑太久（超过 {timeout // 60} 分钟）"}
    if not (p.stdout or "").strip():
        return {"ok": False, "msg": f"Node 没有输出（退出码 {p.returncode}）：{(p.stderr or '')[-300:]}"}
    try:
        out = json.loads(p.stdout)
    except ValueError as e:
        return {"ok": False, "msg": f"Node 输出不是 JSON：{e}；stderr：{(p.stderr or '')[-200:]}"}
    if not isinstance(out, dict):
        return {"ok": False, "msg": "Node 输出不是对象"}
    return out


def conversion(data: Data, want: str | None = None, *, node: str = "node", om_date: str | None = None) -> dict:
    key = "conversion"
    ds = data.archive_dates()
    date, note = _pick(ds, want)
    if not date:
        return _block(key, None, False, f"没有转化率报表存档（{data.conv}）—— 工作台从邮箱取到报表才有")
    f = data.archive(date)
    archives = [{"date": d, "path": str(data.archive(d))} for d in ds if d < date and data.archive(d)]
    out = _node({"file": str(f), "archives": archives, "maxFiles": ARCHIVE_MAX, "baselineK": 3, "baselineMinAbs": 1}, node)
    if not out.get("ok"):
        return _block(key, date, False, out.get("msg") or "无头跑失败")
    reason = "；".join(x for x in [note, out.get("note") or ""] if x)
    return _block(key, date, True, reason, file=f.name, ds=out["ds"], baselines=out.get("baselines") or {},
                  baselineNotes=out.get("baselineNotes") or {}, om=om_latest_result(data, om_date))


# ---------------------------------------------------------------- 合起来
def build_all(data_dir, date: str | None = None, *, node: str = "node") -> dict:
    data = Data(data_dir)
    if not data.root.is_dir():
        reason = f"台账目录不存在：{data.root}（--data 要指到工作台的 data\\ 目录）"
        return {"date": None, "blocks": [_block(k, None, False, reason) for k in ORDER]}
    t = trade(data, date)
    c = churn(data, date)
    o = om(data, date)
    v = conversion(data, date, node=node, om_date=o.get("date"))
    blocks = [t, c, o, v]
    got = [b["date"] for b in blocks if b["ok"] and b["date"]]
    return {"date": (date if date and date in got else (max(got) if got else None)), "blocks": blocks}
