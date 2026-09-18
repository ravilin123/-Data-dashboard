# -*- coding: utf-8 -*-
"""dashboard.snapshot —— 离线快照要嵌哪些接口响应，以及怎么从工作台抓。

四个页面各自会 fetch 哪些地址，列在 `catalog()` 里（只认这一份；页面加了接口这里要跟，
`tests/offline.py` 用页面源码里的 fetch 地址扫一遍兜底）。抓的办法是 `get(path) -> (status, content_type, body_bytes)`：
  · 工作台进程里：`set_app(app)` 之后用 Flask 的 test_client，走的就是页面平时走的那些路由，一个字不重写；
  · 命令行 `python -m dashboard`：自己建一个只挂只读蓝图的 Flask app；
  · 用例：注入假的 get。

「某一天」的快照：页面默认不带 date 参数拉「最新」，所以抓的时候把**不带参数的键**存成「那一天」的响应，
带 `date=那一天` 的键也存一份 —— 这样 看板_<那天>.html 打开就是那天，而不是生成时的最新。
"""
from __future__ import annotations

import base64
import json
from urllib.parse import parse_qsl, urlencode, urlsplit

_APP = None


def set_app(app) -> None:
    """工作台启动时把 Flask app 交进来（app.py 调）。"""
    global _APP
    _APP = app


def norm(url: str) -> str:
    """和页面里 SHIM 的 norm() 一样：路径 + 排好序的非空查询参数。"""
    u = urlsplit(url)
    q = sorted((k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if v != "")
    return u.path + ("?" + urlencode(q) if q else "")


def flask_getter(app):
    client = app.test_client()

    def get(path: str):
        r = client.get(path)
        return r.status_code, r.headers.get("Content-Type", ""), r.get_data()
    return get


def private_app():
    """没有工作台进程时（命令行）：只挂只读蓝图，不起任何后台线程。"""
    from flask import Flask
    from workbench import churn_api, inbox, order_monitor, status
    app = Flask("wb-offline")
    try:
        app.json.ensure_ascii = False
    except AttributeError:
        pass
    for bp in (churn_api.bp, inbox.bp, order_monitor.bp, status.bp):
        app.register_blueprint(bp)
    return app


def default_getter():
    if _APP is not None:
        return flask_getter(_APP)
    return flask_getter(private_app())


class Snap:
    """抓的时候顺手整理成页面 SHIM 要的形状：{键: {t, s, b, ct}}。"""

    def __init__(self, get):
        self.get = get
        self.data: dict = {}
        self.notes: list[str] = []

    def fetch_json(self, path: str):
        st, ct, body = self.get(path)
        try:
            return st, json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return st, None

    def put_json(self, key: str, obj, status: int = 200) -> None:
        self.data[norm(key)] = {"t": "json", "s": status, "b": obj}

    def grab_json(self, path: str, *, also_as: str | None = None):
        """抓一份 JSON 存在 path 的键下；`also_as` 再存一份到另一个键（「不带参数 = 那一天」的规矩）。"""
        st, obj = self.fetch_json(path)
        if obj is None:
            obj = {"ok": False, "reason": f"工作台没回 JSON（HTTP {st}）", "msg": f"工作台没回 JSON（HTTP {st}）"}
        self.put_json(path, obj, st)
        if also_as:
            self.put_json(also_as, obj, st)
        return obj

    def grab_bin(self, path: str) -> bool:
        st, ct, body = self.get(path)
        if st != 200:
            self.notes.append(f"{path} → HTTP {st}")
            return False
        self.data[norm(path)] = {"t": "bin", "s": st, "ct": ct or "application/octet-stream",
                                 "b": base64.b64encode(body).decode("ascii")}
        return True


def _pick(dates: list, date: str | None) -> str | None:
    """页面这一块用哪天：要的那天有就用，没有就最新。"""
    if not dates:
        return None
    if date and date in dates:
        return date
    return max(dates)


def collect(get, date: str | None = None) -> dict:
    """抓四个页面要的全部响应。返回 {"pages": {page: data}, "dates": {page: 实际用的日期}, "notes": [...]}。"""
    pages: dict = {}
    used: dict = {}
    notes: list[str] = []

    # ---------------- 转化率：报表文件 + 邮箱状态 ----------------
    s = Snap(get)
    dl = s.grab_json("/api/inbox/dates/conversion")
    cdates = [d for d in (dl.get("dates") or []) if isinstance(d, str)]
    pick = _pick(cdates, date)
    latest = s.grab_json("/api/inbox/latest")
    if pick and s.grab_bin(f"/api/inbox/file/conversion/{pick}"):
        # 页面靠 inbox/latest 里的 conversion.url 去拿报表：改成那一天的；没配邮箱也照样能自动加载
        if not isinstance(latest, dict):
            latest = {}
        latest = dict(latest, ok=True, conversion={"date": pick, "url": f"/api/inbox/file/conversion/{pick}",
                                                   "analyzed": (latest.get("conversion") or {}).get("analyzed", False)
                                                   if isinstance(latest.get("conversion"), dict) else False})
        s.put_json("/api/inbox/latest", latest)
    else:
        notes.append("转化率：本机存档里没有报表，页面只能手动选文件")
    s.grab_json("/api/workbench/bootstrap")
    s.grab_json("/api/order-monitor/latest")
    pages["conversion"] = s.data
    used["conversion"] = pick
    notes += s.notes

    # ---------------- 出单监控：台账清单 + 那一天（和前两天）的台账 ----------------
    s = Snap(get)
    days_obj = s.grab_json("/api/order-monitor/days")
    odays = [d.get("date") for d in (days_obj.get("days") or []) if isinstance(d, dict) and d.get("date")]
    opick = _pick(odays, date)
    if opick:
        s.grab_json(f"/api/order-monitor/ledger?date={opick}", also_as="/api/order-monitor/ledger")
        for d in sorted(odays, reverse=True)[:3]:
            if d != opick:
                s.grab_json(f"/api/order-monitor/ledger?date={d}")
    else:
        s.grab_json("/api/order-monitor/ledger")
    s.grab_json("/api/inbox/latest")
    s.grab_json("/api/status")
    pages["order-monitor"] = s.data
    used["order-monitor"] = opick
    notes += s.notes

    # ---------------- 商户流失：状态 + 大盘 + 漏斗 + 周报 ----------------
    s = Snap(get)
    cd = s.grab_json("/api/churn/days")
    sdates = [d for d in (cd.get("dates") or []) if isinstance(d, str)]
    spick = _pick(sdates, date)
    q = f"?date={spick}" if spick else ""
    s.grab_json(f"/api/churn/state{q}", also_as="/api/churn/state")
    s.grab_json("/api/churn/coverage")
    for n in (7, 14, 30, 60, 90):
        s.grab_json(f"/api/churn/overview?days={n}{('&date=' + spick) if spick else ''}",
                    also_as=f"/api/churn/overview?days={n}")
    s.grab_json(f"/api/churn/funnel{q}", also_as="/api/churn/funnel")
    s.grab_json(f"/api/churn/weekly{q}", also_as="/api/churn/weekly")
    pages["churn"] = s.data
    used["churn"] = spick
    notes += s.notes

    # ---------------- 交易概览：三档周期 × 两个指标，默认 n=12；下钻只嵌不带筛选的 ----------------
    s = Snap(get)
    tpick = spick    # 交易概览和流失读同一本台账
    for period in ("日", "周", "月"):
        for metric in ("tpv", "orders"):
            base = f"metric={metric}&n=12&period={period}"
            dq = f"&date={tpick}" if tpick else ""
            s.grab_json(f"/api/churn/trade?{base}{dq}", also_as=f"/api/churn/trade?{base}")
            s.grab_json(f"/api/churn/trade/drill?{base}{dq}", also_as=f"/api/churn/trade/drill?{base}")
    pages["trade"] = s.data
    used["trade"] = tpick
    notes += s.notes

    return {"pages": pages, "dates": used, "notes": notes}
