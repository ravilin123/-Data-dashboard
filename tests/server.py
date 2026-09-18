"""
server.py - 看板服务（server/app.py）的用例。零依赖，不开端口：直接调 WSGI 应用。

    python tests/server.py

钉的都是「长得像没坏」的那类：
  ★ 数据接口没口令 / 口令错 / 停用 → 401 JSON；health 不要口令
  ★ 一个口令都没配 = 谁都进不来（不是全放行）
  ★ 三块各自 ok:false + 原因，不当 0；有台账那块 ok:true 且**合契约**（contracts.validate 零错）
  ★ 公司接口没配 → sources 里 configured:false，daily 回 ok:false 不是 500；配了但回的不合契约 → 字段路径列出来
  ★ 导出的单文件里嵌着日报、不含任何口令；嵌的 JSON 里 `</` 转义了
  ★ admin 只许回环地址；加人 / 停用 / 删人写回 config.json 且留 .bak；两个人不能同一个口令
  ★ /api 发 CORS 头、admin 不发；OPTIONS 预检 204；坏日期 / 坏 source 400
  ★ 访问日志一行一次，记名字不记口令
"""
from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from adapters.company_api import CompanyApi  # noqa: E402
from contracts.validate import validate  # noqa: E402
from server import config as C  # noqa: E402
from wsgiref.util import setup_testing_defaults  # noqa: E402
from wsgiref.validate import validator  # noqa: E402
from server.app import EMBED_TAG, create_app  # noqa: E402
from server.sources.workbench import WorkbenchSource  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


def call(app, method, path, *, auth="", remote="10.0.0.9", body=b"", origin=""):
    q = ""
    if "?" in path:
        path, q = path.split("?", 1)
    env = {}
    setup_testing_defaults(env)          # 补齐 WSGI 规定的那些键，validator 才肯跑
    env.update({"REQUEST_METHOD": method, "PATH_INFO": path, "QUERY_STRING": q, "REMOTE_ADDR": remote,
                "wsgi.input": io.BytesIO(body), "CONTENT_LENGTH": str(len(body))})
    if auth:
        env["HTTP_AUTHORIZATION"] = auth
    if origin:
        env["HTTP_ORIGIN"] = origin
    out = {}

    def sr(status, headers):
        out["status"] = int(status.split()[0])
        out["headers"] = dict(headers)
    # ★ 经 wsgiref.validate 跑：它会断言 hop-by-hop 头、status 格式、header 类型 —— 直接调应用抓不到，
    #   真起服务却全 500（2026-09-18 踩过：应用自己发了 Connection: close）
    chunks = validator(app)(env, sr)
    raw = b"".join(chunks)
    chunks.close()                       # validator 要求调用方关掉迭代器（服务端真会关）
    try:
        out["json"] = json.loads(raw.decode("utf-8"))
    except ValueError:
        out["json"] = None
    out["text"] = raw.decode("utf-8", "replace")
    return out


tmp = Path(tempfile.mkdtemp(prefix="wb_dash_"))
data = tmp / "data"
page = tmp / "dashboard.html"
page.write_text("<!doctype html><title>t</title>\n" + EMBED_TAG + "\n<p>页面</p>", encoding="utf-8")
cfgp = tmp / "config.json"
cfgp.write_text(json.dumps({"dashboard": {"viewers": [{"name": "张三", "passcode": "abcd1234", "enabled": True},
                                                      {"name": "停用的", "passcode": "zzzz9999", "enabled": False}]}},
                           ensure_ascii=False), encoding="utf-8")
FIXED = datetime(2026, 9, 18, 9, 30, 0, tzinfo=timezone(timedelta(hours=8)))
cfg = C.load(cfgp)
log = data / "access.log"
app = create_app(cfg, data_dir=data, page_path=page, log_path=log, config_path=cfgp, now=lambda: FIXED)
OK = "Bearer abcd1234"

try:
    print("[1] ★ 口令")
    check("health 不要口令", call(app, "GET", "/api/dashboard/health")["status"] == 200)
    r = call(app, "GET", "/api/dashboard/daily")
    check("没口令 → 401 JSON", r["status"] == 401 and r["json"]["ok"] is False and "口令" in r["json"]["msg"], r["text"][:120])
    check("口令错 → 401", call(app, "GET", "/api/dashboard/daily", auth="Bearer nope")["status"] == 401)
    check("★ 停用的 → 401", call(app, "GET", "/api/dashboard/daily", auth="Bearer zzzz9999")["status"] == 401)
    check("对的 → 200", call(app, "GET", "/api/dashboard/daily", auth=OK)["status"] == 200)
    check("页面本身不要口令", call(app, "GET", "/dashboard")["status"] == 200)
    empty = create_app(C.normalize({}), data_dir=data, page_path=page, log_path=log)
    check("★ 一个口令都没配 = 谁都进不来", call(empty, "GET", "/api/dashboard/sources", auth=OK)["status"] == 401)
    check("health 会说没配", "没配" in call(empty, "GET", "/api/dashboard/health")["json"]["hint"])

    print("\n[2] ★ 空目录：三块各自 ok:false + 原因，不当 0")
    r = call(app, "GET", "/api/dashboard/daily?date=2026-09-17", auth=OK)["json"]
    check("整份 ok:false 且有 reason", r["ok"] is False and r["reason"], r.get("reason"))
    check("三块都在、顺序 trade / order_monitor / churn", [b["key"] for b in r["blocks"]] == ["trade", "order_monitor", "churn"])
    check("每块 ok:false 且 reason 说了目录", all(not b["ok"] and b["reason"] for b in r["blocks"]), [b["reason"] for b in r["blocks"]])
    check("每块三个数组是空的、不是 0 的卡", all(b["kpis"] == [] and b["sections"] == [] and b["series"] == [] for b in r["blocks"]))
    check("★ 空的也合契约", validate(r) == [], validate(r))
    d = call(app, "GET", "/api/dashboard/dates", auth=OK)["json"]
    check("dates 空也是 200：dates:[] latest:null + reason", d["dates"] == [] and d["latest"] is None and d["reason"], d)
    r0 = call(app, "GET", "/api/dashboard/daily", auth=OK)["json"]
    check("不给 date 且一天都没有 → ok:false + reason，不 500", r0["ok"] is False and r0["reason"], r0.get("reason"))

    print("\n[3] ★ 有台账那块 ok:true 且合契约，缺天断开")
    (data / "churn" / "ledger").mkdir(parents=True)
    def row(uid, site, amt, n, owner="赵娜", mode="标准收银台"):
        return {"用户ID": uid, "站点": site, "商户名称": "商户" + uid[-1], "直签人": owner, "代理商ID": "", "代理商名称": "",
                "接入模式": mode, "交易金额": float(amt), "交易笔数": n}
    for i, dd in enumerate(("2026-09-14", "2026-09-15", "2026-09-17")):      # 09-16 缺
        rows = [row("1000000000000000001", "a.com", 1000 + i, 10), row("1000000000000000002", "b.com", 500, 5, "赵娜", "API")]
        if dd == "2026-09-17":
            rows.append(row("1000000000000000003", "c.com", 300, 3))     # 新商户
        (data / "churn" / "ledger" / f"{dd}.json").write_text(json.dumps({"date": dd, "sites": rows}, ensure_ascii=False), encoding="utf-8")
    r = call(app, "GET", "/api/dashboard/daily?date=2026-09-17", auth=OK)["json"]
    t = r["blocks"][0]
    check("交易量 ok:true、日期是它自己的", t["ok"] and t["date"] == "2026-09-17", t.get("reason"))
    check("★ 整份合契约（零错）", validate(r) == [], validate(r))
    check("整份 ok:true（至少一块 ok）", r["ok"] is True)
    tpv = next(k for k in t["kpis"] if k["key"] == "tpv")
    check("交易额 = 1002+500+300", tpv["value"] == 1802.0 and tpv["fmt"] == "money", tpv)
    check("环比对昨天（09-16 缺 → prev 是 null，dod 也是 null，不是 +∞）", tpv["prev"] is None and tpv["dod"] is None, tpv)
    ser = next(s for s in t["series"] if s["key"] == "tpv")
    p16 = next(p for p in ser["points"] if p["x"] == "2026-09-16")
    check("★ 缺的那天 y:null（折线断开），不是 0", p16["y"] is None, p16)
    check("reason 说了缺几天", "缺" in t["reason"], t["reason"])
    top = next(s for s in t["sections"] if s["key"] == "top")
    new = next(x for x in top["rows"] if x["用户ID"] == "1000000000000000003")
    check("★ 新商户 dod 是 null 不是 +100%", new["dod"] is None and new["prev"] is None, new)
    check("另外两块仍 ok:false", not r["blocks"][1]["ok"] and not r["blocks"][2]["ok"])
    d = call(app, "GET", "/api/dashboard/dates", auth=OK)["json"]
    check("dates 倒序、latest 是最新", d["dates"][0] == "2026-09-17" == d["latest"] and d["dates"][-1] == "2026-09-14", d)
    check("不给 date = 最新那天", call(app, "GET", "/api/dashboard/daily", auth=OK)["json"]["date"] == "2026-09-17")

    print("\n[3b] 流失 + 出单：读状态文件 / 结果文件，截断自报")
    (data / "churn" / "state").mkdir(parents=True)
    hits = [{"key": f"u{i}|s{i}.com", "type": "沉默2", "silent_days": 2, "drop": None, "tpv30": 1000.0 - i, "gw": "网关数据缺",
             "用户ID": f"10000000000000000{i:02d}", "站点": f"s{i}.com", "商户名称": f"商户{i}", "直签人": "赵娜"} for i in range(25)]
    (data / "churn" / "state" / "2026-09-17.json").write_text(json.dumps(
        {"ok": True, "date": "2026-09-17", "hits": hits, "counts": {"沉默2": 25}, "incidents": [{"网关": "网关A", "merchants": 3}],
         "gap": ["2026-09-16"], "eligible_n": 7, "sites": {}}, ensure_ascii=False), encoding="utf-8")
    (data / "出单监控结果").mkdir()
    (data / "出单监控结果" / "出单监控结果_2026-09-17.json").write_text(json.dumps(
        {"date": "2026-09-17", "counts": {"✅ 新出单": 3, "🐢 小额滞留": 2}, "audit_counts": {"通知+表": 5, "仅表": 40, "丢弃": 7}, "merchants": []},
        ensure_ascii=False), encoding="utf-8")
    r = call(app, "GET", "/api/dashboard/daily?date=2026-09-17", auth=OK)["json"]
    check("★ 三块都 ok 且合契约", all(b["ok"] for b in r["blocks"]) and validate(r) == [], validate(r) or [b["reason"] for b in r["blocks"]])
    ch = r["blocks"][2]
    hs = next(s for s in ch["sections"] if s["key"] == "hits")
    check("★ 命中名单截断自报：shown 20 / total 25", hs["truncated"] == {"shown": 20, "total": 25} and len(hs["rows"]) == 20, hs["truncated"])
    check("kpi：命中 25、有资格 7、通道异常 1、缺台账 1 天", [k["value"] for k in ch["kpis"]] == [25, 7, 1, 1], [k["value"] for k in ch["kpis"]])
    om = r["blocks"][1]
    check("出单：报表行数 = 52，三个落点各一张卡", [k["value"] for k in om["kpis"]][:4] == [52, 5, 40, 7], [k["value"] for k in om["kpis"]])
    s14 = next(s for s in om["series"] if s["key"] == "丢弃")
    check("14 天序列：没跑的天 y:null", sum(1 for p in s14["points"] if p["y"] is None) == 13 and s14["points"][-1]["y"] == 7)
    bad = data / "churn" / "state" / "2026-09-15.json"
    bad.write_text("{坏了", encoding="utf-8")
    r = call(app, "GET", "/api/dashboard/daily?date=2026-09-15", auth=OK)["json"]
    check("★ 文件坏了要说出来（reason 带文件名），不装作没跑过", not r["blocks"][2]["ok"] and "2026-09-15.json" in r["blocks"][2]["reason"], r["blocks"][2]["reason"])

    print("\n[4] ★ 公司接口：没配不是错；配了不合契约要列字段路径")
    s = call(app, "GET", "/api/dashboard/sources", auth=OK)["json"]["sources"]
    co = next(x for x in s if x["key"] == "company")
    check("sources 里 configured:false + reason", co["configured"] is False and "base_url" in co["reason"], co)
    r = call(app, "GET", "/api/dashboard/daily?source=company&date=2026-09-17", auth=OK)
    check("daily?source=company → 200 + ok:false + reason，不 500", r["status"] == 200 and r["json"]["ok"] is False and r["json"]["reason"], r["text"][:200])
    check("dates?source=company → 200 + 空", call(app, "GET", "/api/dashboard/dates?source=company", auth=OK)["json"]["dates"] == [])
    check("source 不认识 → 400", call(app, "GET", "/api/dashboard/daily?source=xx", auth=OK)["status"] == 400)
    check("日期格式错 → 400", call(app, "GET", "/api/dashboard/daily?date=2026/09/17", auth=OK)["status"] == 400)
    seen = {}
    def fake_fetch(url, headers, timeout):
        seen["url"], seen["headers"] = url, headers
        if url.endswith("/dates"):
            return 200, json.dumps({"ok": True, "dates": ["2026-09-16", "2026-09-17"]})
        return 200, json.dumps({"ok": True, "schema": 1, "date": "2026-09-17", "generated_at": "x",
                                "source": {"key": "company", "label": "公司"}, "blocks": [{"key": "t", "label": "t", "date": "2026-09-17", "ok": True,
                                "kpis": [{"key": "a", "label": "a", "value": "3%", "fmt": "percent"}], "sections": [], "series": []}]})
    api = CompanyApi({"base_url": "http://corp.example/api/", "token": "tok-1", "timeout": 5}, fetch=fake_fetch)
    check("配了 → configured", api.configured()[0])
    check("dates 倒序", api.dates() == ["2026-09-17", "2026-09-16"], api.dates())
    check("★ 带 Bearer token、地址拼对（末尾 / 去掉）", seen["headers"].get("Authorization") == "Bearer tok-1" and seen["url"] == "http://corp.example/api/dates", seen)
    r = api.daily("2026-09-17")
    check("★ 不合契约 → ok:false + errors 列字段路径", r["ok"] is False and any("kpis[0].fmt" in e for e in r["errors"]), r.get("errors"))
    api2 = CompanyApi({"base_url": "http://corp.example", "token": ""}, fetch=lambda u, h, t: (500, "boom"))
    check("对方 500 → ok:false + reason 带状态码", "500" in api2.daily("2026-09-17")["reason"])
    api3 = CompanyApi({"base_url": "http://corp.example"}, fetch=lambda u, h, t: (_ for _ in ()).throw(OSError("拒绝连接")))
    check("调不通 → ok:false + reason", "调不通" in api3.daily("2026-09-17")["reason"])

    print("\n[5] ★ 导出：嵌着日报、不含口令、`</` 转义")
    r = call(app, "GET", "/api/dashboard/export?date=2026-09-17", auth=OK)
    check("200 + attachment", r["status"] == 200 and "attachment" in r["headers"].get("Content-Disposition", ""), r["headers"])
    check("★ 嵌入标签被换掉了（不再是 null）", EMBED_TAG not in r["text"] and 'id="embedded-report"' in r["text"])
    check("★ 口令一个都不在里面", "abcd1234" not in r["text"] and "zzzz9999" not in r["text"])
    check("嵌的是那天的日报", '"date": "2026-09-17"' in r["text"] or '"date":"2026-09-17"' in r["text"])
    check("exported_by 记着谁导的", '"exported_by": "张三"' in r["text"] or '"exported_by":"张三"' in r["text"])
    check("没口令导不了", call(app, "GET", "/api/dashboard/export")["status"] == 401)
    # `</` 转义：造一份商户名带 </script> 的台账
    evil = data / "churn" / "ledger" / "2026-09-13.json"
    evil.write_text(json.dumps({"date": "2026-09-13", "sites": [dict(row("1000000000000000009", "e.com", 1, 1), 商户名称="x</script><b>y")]}, ensure_ascii=False), encoding="utf-8")
    r = call(app, "GET", "/api/dashboard/export?date=2026-09-13", auth=OK)["text"]
    check("★ 嵌入 JSON 里没有裸的 </script>（转义成 <\\/）", r.count("</script>") == r.count("<script") and "<\\/script>" in r)

    print("\n[6] ★ admin 只许回环；加 / 停 / 删写回 config.json")
    check("非回环 → 403", call(app, "GET", "/dashboard/admin")["status"] == 403)
    check("回环 → 200", call(app, "GET", "/dashboard/admin", remote="127.0.0.1")["status"] == 200)
    check("::1 也算", call(app, "GET", "/dashboard/admin", remote="::1")["status"] == 200)
    def post(form, remote="127.0.0.1"):
        return call(app, "POST", "/dashboard/admin", remote=remote, body=json.dumps(form) and "&".join(f"{k}={v}" for k, v in form.items()).encode())
    check("非回环 POST 也 403", post({"action": "add", "name": "x", "passcode": "12345678"}, remote="10.0.0.9")["status"] == 403)
    r = post({"action": "add", "name": "李四", "passcode": "lisi0001"})
    saved = json.loads(cfgp.read_text(encoding="utf-8"))["dashboard"]["viewers"]
    check("加人写回 config.json", r["status"] == 200 and any(v["name"] == "李四" for v in saved), saved)
    check("留了 .bak", cfgp.with_suffix(".json.bak").exists())
    check("新口令立刻能用", call(app, "GET", "/api/dashboard/sources", auth="Bearer lisi0001")["status"] == 200)
    check("★ 两个人不能同一个口令", post({"action": "add", "name": "王五", "passcode": "lisi0001"})["status"] == 400)
    check("口令太短拒绝", post({"action": "add", "name": "王五", "passcode": "12"})["status"] == 400)
    post({"action": "toggle", "name": "李四"})
    check("停用后 401", call(app, "GET", "/api/dashboard/sources", auth="Bearer lisi0001")["status"] == 401)
    post({"action": "delete", "name": "李四"})
    saved = json.loads(cfgp.read_text(encoding="utf-8"))["dashboard"]["viewers"]
    check("删人写回", all(v["name"] != "李四" for v in saved), saved)
    check("别的段没被动（只写 viewers）", set(json.loads(cfgp.read_text(encoding="utf-8"))) == {"dashboard"})
    check("admin 页面上没有 CORS 头", "Access-Control-Allow-Origin" not in call(app, "GET", "/dashboard/admin", remote="127.0.0.1")["headers"])

    print("\n[7] CORS / 预检 / 日志")
    r = call(app, "GET", "/api/dashboard/health", origin="https://x.example")
    check("/api 发 Access-Control-Allow-Origin: *", r["headers"].get("Access-Control-Allow-Origin") == "*")
    check("允许 Authorization 头", "Authorization" in r["headers"].get("Access-Control-Allow-Headers", ""))
    check("OPTIONS 预检 204", call(app, "OPTIONS", "/api/dashboard/daily")["status"] == 204)
    check("★ 没有 hop-by-hop 头（Connection 之类，WSGI 不许应用发）", "Connection" not in r["headers"] and "Keep-Alive" not in r["headers"])
    check("404 是 JSON", call(app, "GET", "/api/dashboard/nope", auth=OK)["json"]["ok"] is False)
    lines = log.read_text(encoding="utf-8").splitlines()
    check("访问日志一行一次：时间 \\t 名字 \\t 路径 \\t 日期", lines and lines[0].split("\t") == ["2026-09-18T09:30:00+08:00", "张三", "/api/dashboard/daily", "2026-09-17"], lines[:1])
    check("★ 日志里没有口令", "abcd1234" not in log.read_text(encoding="utf-8"))
    check("导出也记了", any("/api/dashboard/export" in l for l in lines))
    check("401 的不记（还不知道是谁）", all("张三" in l or "李四" in l for l in lines), [l for l in lines if "张三" not in l and "李四" not in l][:2])

    print("\n[8] config：数字读法、监听地址")
    c = C.normalize({"top_n": None, "hits_top_n": 0, "listen": "0.0.0.0:5071", "company_api": {"timeout": None}})
    check("null 回默认、0 留住（§2.18.98）", c["top_n"] == 10 and c["hits_top_n"] == 0 and c["company_api"]["timeout"] == 20, c)
    check("listen 拆得开", C.listen(c) == ("0.0.0.0", 5071))
    check("没名字 / 没口令的 viewer 丢掉", C.normalize({"viewers": [{"name": "", "passcode": "x"}, {"name": "a"}, {"name": "b", "passcode": "c"}]})["viewers"] == [{"name": "b", "passcode": "c", "enabled": True}])
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
