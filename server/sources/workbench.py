# -*- coding: utf-8 -*-
"""server.sources.workbench —— 读工作台的 data/ 目录，拼三块日报。

文件在哪（和工作台一字不差，那边改了这里要跟）：
  交易量   data/churn/ledger/<date>.json        {"date","source_date","sites":[行]}  → churn.overview.build
  流失     data/churn/state/<date>.json         churn.assess 的输出（hits / counts / incidents / gap …）
  出单     data/出单监控结果/出单监控结果_<date>.json  {"date","counts":{分类: n},"audit_counts":{落点: n},"merchants":[…]}

⚠ 缺哪块那块 ok:false + 原因，**不当 0**（§2.12）；文件坏了也说出来（reason 里带文件名），不装作没有。
⚠ 算数一行不新写：交易量走 `churn.overview.build`（和工作台交易概览页同一个函数）。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

from churn import overview as OV
from .. import report as R

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

try:                                   # classify 引 excel 引 pandas；没装 pandas 时分类顺序退回文件里的顺序
    from order_monitor.classify import DAILY_ORDER, PENDING_ORDER
    _OM_ORDER = list(DAILY_ORDER) + list(PENDING_ORDER)
except ModuleNotFoundError:
    _OM_ORDER = []


def _back(date: str, n: int) -> list[str]:
    t = datetime.strptime(date, "%Y-%m-%d")
    return [(t - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n - 1, -1, -1)]


def _read(p: Path):
    """(obj, err)。不存在 → (None, "")；坏了 → (None, 原因)。"""
    if not p.exists():
        return None, ""
    try:
        return json.loads(p.read_text(encoding="utf-8")), ""
    except (OSError, ValueError) as e:
        return None, f"{p.name} 读不出来：{e}"


class WorkbenchSource:
    key = "workbench"
    label = "工作台台账"

    def __init__(self, data_dir: Path, settings: dict | None = None):
        self.data = Path(data_dir)
        s = settings or {}
        self.top_n = int(s.get("top_n") or 10)
        self.hits_top_n = int(s.get("hits_top_n") or 20)
        self.series_days = int(s.get("series_days") or 30)
        self.ledger = self.data / "churn" / "ledger"
        self.state = self.data / "churn" / "state"
        self.om = self.data / "出单监控结果"

    # ---------------------------------------------------------------- 有哪些天
    def configured(self) -> tuple[bool, str]:
        if not self.data.is_dir():
            return False, f"台账目录不存在：{self.data}（config.json 的 dashboard.workbench_data_dir）"
        return True, ""

    def _ledger_dates(self) -> set:
        return {p.stem for p in self.ledger.glob("*.json") if _DATE.match(p.stem)} if self.ledger.is_dir() else set()

    def _state_dates(self) -> set:
        return {p.stem for p in self.state.glob("*.json") if _DATE.match(p.stem)} if self.state.is_dir() else set()

    def _om_dates(self) -> set:
        out = set()
        if self.om.is_dir():
            for p in self.om.glob("出单监控结果_*.json"):
                d = p.stem.replace("出单监控结果_", "")
                if _DATE.match(d):
                    out.add(d)
        return out

    def dates(self) -> list[str]:
        """三块任一有数的日期，倒序。"""
        return sorted(self._ledger_dates() | self._state_dates() | self._om_dates(), reverse=True)

    # ---------------------------------------------------------------- 三块
    def daily(self, date: str) -> dict:
        blocks = [self._trade(date), self._om(date), self._churn(date)]
        return R.report(date, self.key, self.label, blocks)

    def _trade(self, date: str) -> dict:
        key, label = "trade", "交易量"
        if not self.ledger.is_dir():
            return R.missing(key, label, f"没有站点台账目录：{self.ledger}")
        days, broken = {}, []
        for d in _back(date, self.series_days):
            obj, err = _read(self.ledger / f"{d}.json")
            if err:
                broken.append(err)
            elif isinstance(obj, dict):
                days[d] = obj.get("sites") or []
        if not days:
            return R.missing(key, label, f"最近 {self.series_days} 天一份站点台账都没有" + ("；" + "；".join(broken) if broken else ""))
        ov = OV.build(days, date, self.series_days, self.top_n)
        if date not in days:
            return R.missing(key, label, ov.get("reason") or f"{date} 没有台账" + ("；" + "；".join(broken) if broken else ""))
        k = ov["kpi"]
        kpis = [R.kpi("tpv", "交易额", k["tpv"]["value"], "money", unit="USD", dod=k["tpv"]["dod"], prev=k["tpv"]["prev"], note="环比前一天"),
                R.kpi("orders", "笔数", k["orders"]["value"], "int", dod=k["orders"]["dod"], prev=k["orders"]["prev"], note="环比前一天"),
                R.kpi("sites", "有交易的站点", k["sites"]["value"], "int", dod=k["sites"]["dod"], prev=k["sites"]["prev"]),
                R.kpi("vs_avg7", "对比前 7 日均值", k["tpv"]["vs_avg7"], "pct",
                      note=f"按有数的 {k['tpv']['avg7_days']} 天算" if k["tpv"]["avg7_days"] else "前面没有可比的天")]
        top_cols = [R.column("商户名称", "商户"), R.column("直签人", "直签人"), R.column("站点数", "站点数", "int"),
                    R.column("tpv", "交易额", "money"), R.column("orders", "笔数", "int"),
                    R.column("share", "占比", "pct"), R.column("dod", "环比", "pct")]
        grp_cols = [R.column("name", "名称"), R.column("tpv", "交易额", "money"), R.column("orders", "笔数", "int"),
                    R.column("sites", "站点数", "int"), R.column("share", "占比", "pct")]
        by = ov.get("by") or {}
        sections = [R.section("top", f"Top {self.top_n} 商户", top_cols, ov.get("top") or [],
                              note="同一商户的多个站点合起来算；新出现的商户环比是空，不是 +100%"),
                    R.section("by_mode", "按接入模式", grp_cols, by.get("接入模式") or [], note="超过 6 类折进「其他」"),
                    R.section("by_owner", "按直签人", grp_cols, by.get("直签人") or [], note="19 位数字的直签人是代理商 ID，显示成「代理商：…」")]
        ser = ov.get("series") or []
        series_ = [R.series("tpv", f"近 {self.series_days} 天交易额", [(x["date"], x["tpv"]) for x in ser], "money", unit="USD"),
                   R.series("orders", f"近 {self.series_days} 天笔数", [(x["date"], x["orders"]) for x in ser], "int")]
        reason = ""
        if ov.get("gap"):
            reason = f"趋势里缺 {len(ov['gap'])} 天台账（{', '.join(ov['gap'][:5])}{'…' if len(ov['gap']) > 5 else ''}），那几天是断的不是 0"
        if broken:
            reason = (reason + "；" if reason else "") + "；".join(broken)
        return R.block("trade", label, date, True, reason=reason, kpis=kpis, sections=sections, series_=series_)

    def _om(self, date: str) -> dict:
        key, label = "order_monitor", "出单监控"
        if not self.om.is_dir():
            return R.missing(key, label, f"没有出单监控结果目录：{self.om}（出单监控跑过一次就有）")
        obj, err = _read(self.om / f"出单监控结果_{date}.json")
        if err:
            return R.missing(key, label, err)
        if not isinstance(obj, dict):
            return R.missing(key, label, f"{date} 出单监控没跑过（没有 出单监控结果_{date}.json）")
        ac = obj.get("audit_counts") or {}
        counts = obj.get("counts") or {}
        kpis = []
        if ac:
            total = sum(int(v or 0) for v in ac.values())
            kpis.append(R.kpi("rows", "报表行数", total, "int", note="三个落点加起来"))
            for k2, lbl in (("通知+表", "通知 + 表"), ("仅表", "只写表"), ("丢弃", "哪儿都没有")):
                if k2 in ac:
                    kpis.append(R.kpi(k2, lbl, int(ac[k2] or 0), "int"))
        else:
            kpis.append(R.kpi("rows", "报表行数", None, "int", note="这份结果没有 audit_counts（老版本跑的）"))
        kpis.append(R.kpi("notified", "进通知的商户", sum(int(v or 0) for v in counts.values()), "int"))
        order = [k2 for k2 in _OM_ORDER if k2 in counts] + [k2 for k2 in counts if k2 not in _OM_ORDER]
        rows = [{"分类": k2, "n": int(counts[k2] or 0)} for k2 in order]
        sections = [R.section("counts", "各分类几家", [R.column("分类", "分类"), R.column("n", "家数", "int")], rows,
                              note="进通知的那几档；十三档全量落点在工作台「出单监控」页")]
        pts = {k2: [] for k2 in ("通知+表", "仅表", "丢弃")}
        for d in _back(date, 14):
            o, _ = _read(self.om / f"出单监控结果_{d}.json")
            a = (o or {}).get("audit_counts") if isinstance(o, dict) else None
            for k2 in pts:
                pts[k2].append((d, int(a[k2] or 0) if a and k2 in a else None))
        series_ = [R.series(k2, f"近 14 天 · {k2}", v, "int") for k2, v in pts.items()]
        return R.block(key, label, date, True, kpis=kpis, sections=sections, series_=series_)

    def _churn(self, date: str) -> dict:
        key, label = "churn", "商户流失"
        if not self.state.is_dir():
            return R.missing(key, label, f"没有流失状态目录：{self.state}（商户流失 job 跑过一次就有）")
        st, err = _read(self.state / f"{date}.json")
        if err:
            return R.missing(key, label, err)
        if not isinstance(st, dict):
            return R.missing(key, label, f"{date} 商户流失没跑过（没有 state/{date}.json）")
        hits = list(st.get("hits") or [])
        inc = list(st.get("incidents") or [])
        gap = list(st.get("gap") or [])
        kpis = [R.kpi("hits", "今日命中", len(hits), "int"),
                R.kpi("eligible", "其中有资格推送的", st.get("eligible_n"), "int", note="30 天 TPV 排名靠前的那批"),
                R.kpi("incidents", "通道异常", len(inc), "int"),
                R.kpi("gap", "窗口里缺台账的天", len(gap), "days", note="缺的天不当 0")]
        hit_cols = [R.column("商户名称", "商户"), R.column("站点", "站点"), R.column("type", "命中"),
                    R.column("silent_days", "沉默天数", "days"), R.column("drop", "掉量", "pct"),
                    R.column("tpv30", "30 天 TPV", "money"), R.column("直签人", "直签人"), R.column("gw", "网关")]
        inc_cols = [R.column("网关", "网关"), R.column("merchants", "受影响商户数", "int")]
        sections = [R.section("hits", "命中名单", hit_cols, hits, limit=self.hits_top_n, note="顺序就是状态机排好的：先推送档、再页面档"),
                    R.section("incidents", "通道异常", inc_cols, inc, note="同一网关当天多家一起掉；数的是家不是条")]
        pts = []
        for d in _back(date, 14):
            o, _ = _read(self.state / f"{d}.json")
            pts.append((d, len(o.get("hits") or []) if isinstance(o, dict) else None))
        series_ = [R.series("hits", "近 14 天命中数", pts, "int")]
        counts = st.get("counts") or {}
        reason = "、".join(f"{k2} {v}" for k2, v in counts.items()) if counts else ""
        return R.block(key, label, st.get("date") or date, True, reason=reason, kpis=kpis, sections=sections, series_=series_)
