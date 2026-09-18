# -*- coding: utf-8 -*-
"""server.app —— 路由、口令、访问日志、导出、口令配置页。标准库 WSGI，零依赖。

    GET  /dashboard                 页面（不要口令：页面本身不含数据，数据接口才要）
    GET  /dashboard/admin           口令配置页 —— **只许回环地址**（127.0.0.1 / ::1），别的地址 403
    POST /dashboard/admin           加人 / 删人 / 停用 / 启用（表单）
    GET  /api/dashboard/health      探活，不要口令
    GET  /api/dashboard/sources     哪些数据源、配没配
    GET  /api/dashboard/dates       ?source=
    GET  /api/dashboard/daily       ?source=&date=
    GET  /api/dashboard/export      ?source=&date=  → 自带数据的单文件 HTML（这份文件不设口令，页面顶上会写）

口令：`Authorization: Bearer <口令>`，和 config.json `dashboard.viewers` 里某个 enabled 的全等才放行，
否则 401 JSON。名字只用来记 `data/access.log`，不进响应。**一个口令都没配 = 谁都进不来**，
health 会说出来 —— 比「没配就全放行」安全，第一次跑就知道要去 admin 配。

CORS：`/api/dashboard/*` 发 `Access-Control-Allow-Origin: *`（页面可能托管在别处或 file:// 打开，
凭据在 Bearer 头里不在 cookie 里，`*` 是安全的）；`/dashboard/admin` **不发**（同工作台 `/api/config` 那条规矩）。
"""
from __future__ import annotations

import html
import json
import re
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config as C
from . import report as R
from .sources.workbench import WorkbenchSource

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EMBED_TAG = '<script id="embedded-report" type="application/json">null</script>'
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
TZ = timezone(timedelta(hours=8))
_lock = threading.Lock()


class _Req:
    def __init__(self, environ):
        self.method = environ.get("REQUEST_METHOD", "GET").upper()
        self.path = environ.get("PATH_INFO", "/") or "/"
        self.query = {k: v[-1] for k, v in urllib.parse.parse_qs(environ.get("QUERY_STRING", "")).items()}
        self.remote = environ.get("REMOTE_ADDR", "")
        self.auth = environ.get("HTTP_AUTHORIZATION", "")
        self.origin = environ.get("HTTP_ORIGIN", "")
        try:
            n = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            n = 0
        self.body = environ["wsgi.input"].read(n) if n > 0 and environ.get("wsgi.input") else b""


def _json(status: int, obj, extra: list | None = None):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return status, [("Content-Type", "application/json; charset=utf-8")] + (extra or []), body


def _err(status: int, msg: str):
    return _json(status, {"ok": False, "code": status, "msg": msg})


def _html(status: int, text: str, extra: list | None = None):
    return status, [("Content-Type", "text/html; charset=utf-8")] + (extra or []), text.encode("utf-8")


def create_app(cfg: dict, *, data_dir: Path, page_path: Path, log_path: Path, config_path: Path | None = None,
               sources: list | None = None, now=None):
    """cfg 是 `server.config.load()` 规整后的 dashboard 段。sources 不给就是工作台台账 + 公司接口。"""
    if sources is None:
        from adapters.company_api import CompanyApi
        sources = [WorkbenchSource(data_dir, cfg), CompanyApi(cfg)]
    by_key = {s.key: s for s in sources}
    _now = now or (lambda: datetime.now(TZ))

    # ---------------------------------------------------------------- 口令 / 日志
    def viewer_of(auth: str):
        m = re.match(r"^\s*Bearer\s+(.+?)\s*$", auth or "")
        if not m:
            return None
        pc = m.group(1)
        for v in cfg.get("viewers") or []:
            if v.get("enabled") and v.get("passcode") == pc:      # 全等；名字不参与
                return v["name"]
        return None

    def log_access(name: str, path: str, date: str) -> None:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with _lock, open(log_path, "a", encoding="utf-8") as f:
                f.write(f"{_now().isoformat(timespec='seconds')}\t{name}\t{path}\t{date}\n")
        except OSError:
            pass     # 记不上日志不该让人看不了看板

    # ---------------------------------------------------------------- 参数
    def pick_source(req: _Req):
        key = (req.query.get("source") or "workbench").strip()
        src = by_key.get(key)
        if src is None:
            return None, _err(400, f"source 只能是 {' / '.join(by_key)}")
        return src, None

    def pick_date(req: _Req, src):
        d = (req.query.get("date") or "").strip()
        if d and not _DATE.match(d):
            return None, _err(400, "日期格式应为 YYYY-MM-DD")
        if not d:
            ds = src.dates()
            d = ds[0] if ds else ""
        return d, None

    # ---------------------------------------------------------------- 处理函数
    def health(req):
        n = len(cfg.get("viewers") or [])
        return _json(200, {"ok": True, "service": "dashboard", "viewers": n,
                           "hint": "" if n else "一个口令都没配，数据接口谁都进不来 —— 去 /dashboard/admin 配"})

    def page(req):
        if not page_path.exists():
            return _err(404, f"{page_path.name} 不在 —— 页面文件丢了")
        return _html(200, page_path.read_text(encoding="utf-8"))

    def sources_api(req):
        out = []
        for s in sources:
            ok, why = s.configured()
            out.append({"key": s.key, "label": s.label, "configured": bool(ok), "reason": why})
        return _json(200, {"ok": True, "sources": out})

    def dates_api(req):
        src, e = pick_source(req)
        if e:
            return e
        ok, why = src.configured()
        ds = src.dates() if ok else []
        return _json(200, {"ok": True, "source": src.key, "dates": ds, "latest": ds[0] if ds else None,
                           "reason": why if not ok else ("" if ds else "一天数据都没有")})

    def daily_api(req, name):
        src, e = pick_source(req)
        if e:
            return e
        d, e = pick_date(req, src)
        if e:
            return e
        if not d:
            ok, why = src.configured()
            return _json(200, R.report("", src.key, src.label, [], reason=why or "一天数据都没有"))
        log_access(name, req.path, d)
        return _json(200, src.daily(d))

    def export_api(req, name):
        src, e = pick_source(req)
        if e:
            return e
        d, e = pick_date(req, src)
        if e:
            return e
        if not page_path.exists():
            return _err(404, f"{page_path.name} 不在")
        tpl = page_path.read_text(encoding="utf-8")
        if tpl.count(EMBED_TAG) != 1:
            return _err(500, "页面里找不到嵌入数据的那个标签（#embedded-report），导出不了")
        rep = src.daily(d) if d else R.report("", src.key, src.label, [], reason="一天数据都没有")
        rep["exported_by"] = name
        # </script> 不能出现在内联 JSON 里；转义 `</` 之后 JSON 语义不变
        payload = json.dumps(rep, ensure_ascii=False).replace("</", "<\\/")
        out = tpl.replace(EMBED_TAG, f'<script id="embedded-report" type="application/json">{payload}</script>')
        log_access(name, req.path, d)
        fname = urllib.parse.quote(f"看板_{src.key}_{d or '空'}.html")
        return _html(200, out, [("Content-Disposition", f"attachment; filename*=UTF-8''{fname}")])

    # ---------------------------------------------------------------- 口令配置页（只许回环）
    def admin_page(msg: str = ""):
        rows = "".join(
            f"<tr><td>{html.escape(v['name'])}</td><td><code>{html.escape(v['passcode'])}</code></td>"
            f"<td>{'启用' if v['enabled'] else '<b>停用</b>'}</td>"
            f"<td><form method=post style='display:inline'><input type=hidden name=action value=toggle>"
            f"<input type=hidden name=name value='{html.escape(v['name'], quote=True)}'><button>{'停用' if v['enabled'] else '启用'}</button></form> "
            f"<form method=post style='display:inline' onsubmit='return confirm(\"删掉 {html.escape(v['name'])}？\")'>"
            f"<input type=hidden name=action value=delete><input type=hidden name=name value='{html.escape(v['name'], quote=True)}'><button>删除</button></form></td></tr>"
            for v in cfg.get("viewers") or [])
        return f"""<!doctype html><html lang=zh><meta charset=utf-8><title>看板口令</title>
<style>body{{font:14px/1.6 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ccc;padding:4px 8px;text-align:left}}.msg{{color:#060}}</style>
<h1>看板口令</h1>
<p>按人配。名字只用来记访问日志（<code>data/access.log</code>），口令全等且启用才能看。这一页只许本机打开。</p>
{f'<p class=msg>{html.escape(msg)}</p>' if msg else ''}
<table><tr><th>名字</th><th>口令</th><th>状态</th><th></th></tr>{rows or '<tr><td colspan=4>还没配一个人 —— 配之前谁都打不开看板</td></tr>'}</table>
<h2>加一个人</h2>
<form method=post><input type=hidden name=action value=add>
名字 <input name=name required> 口令 <input name=passcode required minlength=4> <button>加</button></form>
<p>存到 <code>{html.escape(str(config_path or C.CONFIG_PATH))}</code>（在 .gitignore 里，不进仓库）；每次保存前留一份 .bak。</p>"""

    def admin(req):
        if req.remote not in LOOPBACK:
            return _html(403, "<h1>403</h1><p>口令配置页只许在这台机器上打开（127.0.0.1）。</p>")
        if req.method == "GET":
            return _html(200, admin_page())
        form = {k: v[-1] for k, v in urllib.parse.parse_qs(req.body.decode("utf-8", "replace")).items()}
        action = form.get("action") or ""
        name = (form.get("name") or "").strip()
        viewers = list(cfg.get("viewers") or [])
        if action == "add":
            pc = form.get("passcode") or ""
            if not name or len(pc) < 4:
                return _html(400, admin_page("名字不能空，口令至少 4 位"))
            if any(v["name"] == name for v in viewers):
                return _html(400, admin_page(f"已经有「{name}」了，先删再加"))
            if any(v["passcode"] == pc for v in viewers):
                return _html(400, admin_page("这个口令别人在用了，两个人不能同一个口令（日志会分不清是谁）"))
            viewers.append({"name": name, "passcode": pc, "enabled": True})
            msg = f"加了「{name}」"
        elif action == "delete":
            viewers = [v for v in viewers if v["name"] != name]
            msg = f"删了「{name}」"
        elif action == "toggle":
            for v in viewers:
                if v["name"] == name:
                    v["enabled"] = not v["enabled"]
            msg = f"改了「{name}」的状态"
        else:
            return _html(400, admin_page("不认识的操作"))
        cfg["viewers"] = viewers
        if config_path is not None:
            C.save_viewers(viewers, config_path)
        return _html(200, admin_page(msg))

    # ---------------------------------------------------------------- 分发
    ROUTES = [
        ("GET", "/dashboard", page, False),
        ("GET", "/dashboard/admin", admin, False),
        ("POST", "/dashboard/admin", admin, False),
        ("GET", "/api/dashboard/health", health, False),
        ("GET", "/api/dashboard/sources", sources_api, True),
        ("GET", "/api/dashboard/dates", dates_api, True),
        ("GET", "/api/dashboard/daily", daily_api, True),
        ("GET", "/api/dashboard/export", export_api, True),
    ]
    CORS = [("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, OPTIONS"),
            ("Access-Control-Allow-Headers", "Authorization, Content-Type")]

    def application(environ, start_response):
        req = _Req(environ)
        is_api = req.path.startswith("/api/dashboard/")
        if req.method == "OPTIONS" and is_api:
            status, headers, body = 204, list(CORS), b""
        else:
            hit = [r for r in ROUTES if r[1] == req.path]
            if not hit:
                status, headers, body = _err(404, "没有这条路由") if is_api else _html(404, "<h1>404</h1>")
            elif not any(r[0] == req.method for r in hit):
                status, headers, body = _err(405, "方法不对")
            else:
                _, _, fn, need_auth = next(r for r in hit if r[0] == req.method)
                if need_auth:
                    name = viewer_of(req.auth)
                    if not name:
                        status, headers, body = _err(401, "口令不对或已停用" if req.auth else "要口令：Authorization: Bearer <口令>")
                    elif fn in (daily_api, export_api):
                        status, headers, body = fn(req, name)
                    else:
                        status, headers, body = fn(req)
                else:
                    status, headers, body = fn(req)
            if is_api:
                headers = headers + CORS
        # ⚠ 不发 Connection 这类 hop-by-hop 头：WSGI 不许应用发（PEP 3333），wsgiref 会直接 500。
        #   §2.18.9 那条「SSE 要 Connection: close」是 Flask 那边的事；这里没有 SSE，wsgiref 每个请求自己关连接。
        #   用例经 wsgiref.validate 跑，就是为了抓这一类「直接调应用是绿的、真起服务全 500」。
        headers = headers + [("Content-Length", str(len(body))), ("Cache-Control", "no-store")]
        reason = {200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
                  404: "Not Found", 405: "Method Not Allowed", 500: "Internal Server Error"}.get(status, "OK")
        start_response(f"{status} {reason}", headers)
        return [body]

    return application
