"""
offline.py - 离线看板（dashboard/offline.py + snapshot.py）：四个页面原样嵌成一张单文件。

    python tests/offline.py                      # 零依赖
    WB_CHROME=/path/to/chrome python tests/offline.py   # 再用无头 Chromium 真开一遍每页，看渲染出了东西

钉的：
  ★ 模块收齐：四个入口能收到全部相对 import，改写后一个相对路径都不剩，改写只动路径字符串（别的一个字节不变）
  ★ 页面源码里 fetch 的每个 /api 地址，snapshot.catalog 都嵌了（页面加了接口这里会红 —— 否则离线页那块就是「没嵌这份数据」）
  ★ 离线页：没有 /static/ 引用、importmap 在、fetch 接管脚本在、数据里 </ 转义了、转化率页内联了 SheetJS 且带 data-inbox
  ★ 快照：「不带 date 的键 = 那一天」；要的那天没有就退回最新并记 notes；报表文件按 base64 嵌
  ★ 外壳：四个 srcdoc iframe、srcdoc 里的引号转义正确、第一个可见其余 hidden
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dashboard import export as X  # noqa: E402
from dashboard import offline as O  # noqa: E402
from dashboard import snapshot as S  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


print("[1] ★ 模块收齐、改写只动路径")
allmods = {}
for key, html_name, entry, _, _ in O.PAGES:
    mods = O.collect_modules(entry)
    allmods[key] = mods
    check(f"{key}：收到 {len(mods)} 个模块，入口在里面", "wb:" + entry in mods and len(mods) >= 5)
    leftover = [k for k, v in mods.items() if re.search(r"""from\s*['"]\.{1,2}/""", v) or re.search(r"""import\s*['"]\.{1,2}/""", v)]
    check(f"{key}：一个相对路径都不剩", not leftover, leftover)
    for k, v in mods.items():
        orig = (O.JS_ROOT / k[3:]).read_text(encoding="utf-8")
        back = re.sub(r"""(['"])wb:[\w./-]+\1""", "X", v)
        orig2 = re.sub(r"""(['"])\.{1,2}/[\w./-]+\1""", "X", orig)
        if back != orig2:
            check(f"{k} 改写只动了路径字符串", False, "别的字节也变了")
            break
total = set().union(*[set(m) for m in allmods.values()])
own = {"wb:" + p.relative_to(O.JS_ROOT).as_posix() for p in O.JS_ROOT.rglob("*.js")
       if p.relative_to(O.JS_ROOT).parts[0] in ("conversion", "order_monitor", "churn", "trade")}
check("四页合起来覆盖了各自目录下的全部模块（shared/ 里只被商户页用的那两个不算）", own <= total, sorted(own - total))
check("importmap 是合法 JSON 且值是 data: URL", all(v.startswith("data:text/javascript;base64,") for v in json.loads(O.importmap(allmods["trade"]))["imports"].values()))

print("\n[2] ★ 页面源码里 fetch 的 /api 地址，快照都嵌了")
FAKE_DAYS = {}
def row(uid, site, amt, n, owner="赵娜", mode="标准收银台"):
    return {"用户ID": uid, "站点": site, "商户名称": "商户" + uid[-1], "直签人": owner, "代理商ID": "", "代理商名称": "", "接入模式": mode, "交易金额": float(amt), "交易笔数": n}
for i in range(1, 18):
    d = "2026-09-%02d" % i
    if d == "2026-09-16":
        continue
    FAKE_DAYS[d] = [row("1000000000000000001", "a.com", 1000 + i, 10), row("1000000000000000002", "b.com", 500, 5, "赵娜", "API")]
FAKE_DAYS["2026-09-17"] = [row("1000000000000000001", "a.com", 200, 2), row("1000000000000000002", "b.com", 500, 5, "赵娜", "API")]   # a.com 掉八成
from churn import assess as A  # noqa: E402
from churn import overview as OV  # noqa: E402
from churn import trade as T  # noqa: E402
from urllib.parse import parse_qs, urlsplit  # noqa: E402

calls = []


def fake_get(path: str):
    """照真实路由的形状造响应：流失 / 交易走真口径层算，别的给最小形状。"""
    calls.append(path)
    u = urlsplit(path); q = {k: v[0] for k, v in parse_qs(u.query).items()}
    date = q.get("date") or "2026-09-17"
    def J(obj, st=200):
        return st, "application/json; charset=utf-8", json.dumps(obj, ensure_ascii=False).encode("utf-8")
    p = u.path
    if p == "/api/inbox/dates/conversion":
        return J({"ok": True, "kind": "conversion", "label": "转化率", "count": 2, "dates": ["2026-09-17", "2026-09-16"]})
    if p.startswith("/api/inbox/file/conversion/"):
        return 200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", b"PK\x03\x04fake-xlsx-" + p[-10:].encode()
    if p == "/api/inbox/latest":
        return J({"ok": True, "enabled": True, "conversion": {"date": "2026-09-17", "url": "/api/inbox/file/conversion/2026-09-17", "analyzed": False}, "order_monitor": None, "jobs": [], "at": "10:30"})
    if p == "/api/workbench/bootstrap":
        return J({"ok": True, "managed": True, "webhook_relay": "/api/feishu/webhook", "bitable": {"app_token": "x", "table_id": "y"}, "card": True, "ai": {"available": False, "model": "", "max_tokens": 8000, "endpoint": "/api/ai/summary"}})
    if p == "/api/order-monitor/latest":
        return J({"ok": True, "found": False})
    if p == "/api/order-monitor/days":
        return J({"ok": True, "count": 0, "days": [], "bad": [], "dir": "D:\\x\\data\\出单监控结果", "msg": "还没有台账 —— 出单监控跑过一次就有了"})
    if p == "/api/order-monitor/ledger":
        return J({"ok": True, "found": False, "date": q.get("date", ""), "msg": "还没有台账"})
    if p == "/api/status":
        return J({"config_loaded": True, "summary": {"order_monitor": {"mode": "both", "builtin": True, "ready": True}}})
    if p == "/api/churn/days":
        return J({"ok": True, "count": 2, "dates": ["2026-09-17", "2026-09-15"]})
    if p == "/api/churn/state":
        st = A.assess(FAKE_DAYS, date, None, {"churn": {}})
        sites = sorted(st["sites"].values(), key=lambda x: (-(x.get("tpv30") or 0), x["key"]))
        for r_ in sites:
            r_["follow"] = {"状态": "无人认领"}
        hits = [dict(h, follow={"状态": "无人认领"}) for h in st["hits"]]
        return J({"ok": True, "found": True, "date": date, "gap": st["gap"], "window": st["window"], "hits": hits, "sites": sites,
                  "incidents": st["incidents"], "gateway": st["gateway"], "counts": st["counts"], "eligible_n": st["eligible_n"], "follow_n": 0, "settings": st["settings"]})
    if p == "/api/churn/coverage":
        return J({"ok": True, "days": len(FAKE_DAYS), "first": min(FAKE_DAYS), "last": max(FAKE_DAYS), "sites": {"days": len(FAKE_DAYS)}, "gateway": {"days": 0}})
    if p == "/api/churn/overview":
        return J(OV.build(FAKE_DAYS, date, int(q.get("days") or 30)))
    if p in ("/api/churn/funnel", "/api/churn/weekly"):
        return J({"ok": False, "reason": "离线用例没造这份（" + p + "）"})
    if p == "/api/churn/trade":
        return J(T.build(FAKE_DAYS, date, q.get("period", "日"), int(q.get("n") or 12), q.get("metric", "tpv"), 10, anchor=4, weeks=[]))
    if p == "/api/churn/trade/drill":
        out = T.drill(FAKE_DAYS, date, q.get("period", "日"), {}, q.get("metric", "tpv"), anchor=4)
        out["options"] = T.options(FAKE_DAYS, date, q.get("period", "日"), anchor=4); out["keys"] = list(T.DRILL_KEYS)
        return J(out)
    return J({"ok": False, "msg": "假服务没有 " + path}, 404)


snap = S.collect(fake_get, None)
# 页面源码里所有 fetch 的字面地址（动态拼的那几个在 load.js 里是 getJSON('/api/…' + …)，一起抓）
lit = set()
for key, mods in allmods.items():
    for v in mods.values():
        lit |= {m.split("?")[0] for m in re.findall(r"""['"`](/api/[\w/-]+)""", v)}
embedded_paths = {k.split("?")[0] for pg in snap["pages"].values() for k in pg}
SKIP = {"/api/inbox/analyzed", "/api/run/order-monitor", "/api/inbox/run-order-monitor", "/api/jobs/", "/api/feishu/webhook", "/api/feishu/bitable", "/api/ai/summary"}   # POST / SSE / 发送类：离线不做
missing = sorted(p for p in lit if p not in embedded_paths and not any(p.startswith(s_) for s_ in SKIP) and not p.startswith("/api/inbox/file/"))
check("★ 页面会 fetch 的 GET 接口，快照全嵌了", not missing, missing)
check("四页都有数据、各自的日期", snap["dates"] == {"conversion": "2026-09-17", "order-monitor": None, "churn": "2026-09-17", "trade": "2026-09-17"}, snap["dates"])

print("\n[3] ★ 「不带 date 的键 = 那一天」；要的那天没有就退回最新")
s15 = S.collect(fake_get, "2026-09-15")
check("流失：state 不带参数那份就是 09-15 的", s15["pages"]["churn"]["/api/churn/state"]["b"]["date"] == "2026-09-15")
check("交易：不带 date 的六个组合都嵌了、且是 09-15 的", all(s15["pages"]["trade"][S.norm(f"/api/churn/trade?metric={m}&n=12&period={p_}")]["b"]["date"] == "2026-09-15" for m in ("tpv", "orders") for p_ in ("日", "周", "月")))
check("转化率：09-15 没有报表 → 退回最新 09-17 并把 inbox/latest 指过去", s15["dates"]["conversion"] == "2026-09-17" and s15["pages"]["conversion"]["/api/inbox/latest"]["b"]["conversion"]["date"] == "2026-09-17")
check("报表文件按 base64 嵌、带 content-type", s15["pages"]["conversion"]["/api/inbox/file/conversion/2026-09-17"]["t"] == "bin" and "spreadsheetml" in s15["pages"]["conversion"]["/api/inbox/file/conversion/2026-09-17"]["ct"])
check("键是规整过的（参数排序、去空值）", S.norm("/api/churn/trade?period=日&metric=tpv&n=12&date=") == "/api/churn/trade?metric=tpv&n=12&period=%E6%97%A5")
check("出单监控：一天台账都没有也不炸，日期是 None", s15["dates"]["order-monitor"] is None)

print("\n[4] ★ 离线页装配")
docs = {}
for key, html_name, entry, label, _ in O.PAGES:
    attrs = {"data-inbox": "2026-09-17"} if key == "conversion" else None
    doc = O.page_document(key, snap["pages"][key], banner=f"离线快照 · {label}", html_attrs=attrs)
    docs[key] = doc
    check(f"{key}：没有 /static/ 引用、有 importmap、有接管脚本、入口是内联 import", "/static/" not in doc and '<script type="importmap">' in doc and "window.fetch = function" in doc and f'import "wb:{entry}"' in doc)
    check(f"{key}：数据 JSON 里 </ 已转义", "<\\/" in doc or "</" not in json.dumps(snap["pages"][key], ensure_ascii=False))
check("转化率页内联了 SheetJS、带 data-inbox", "xlsx.full.min.js" not in docs["conversion"] and "XLSX" in docs["conversion"] and 'data-inbox="2026-09-17"' in docs["conversion"])
check("别的页没内联 SheetJS（体积）", len(docs["trade"]) < 400_000 and len(docs["conversion"]) > 1_000_000, (len(docs["trade"]), len(docs["conversion"])))
try:
    O.page_document("trade", {}, html_attrs=None)
    ok_ = True
except Exception as e:  # noqa: BLE001
    ok_ = False; err = e
check("空数据也装得起来（页面自己会显示原因）", ok_, "" if ok_ else repr(err))

print("\n[5] ★ 外壳")
sh = O.shell(docs, date="2026-09-17", generated_at="2026-09-18 10:00", notes=["转化率：x"])
check("四个 iframe，第一个可见其余 hidden", sh.count("<iframe") == 4 and sh.count(" hidden></iframe>") == 3)
check("srcdoc 里的引号转义了（否则属性在第一个引号处就断了）", sh.count('srcdoc="') == 4 and '&quot;utf-8&quot;' in sh and len(re.findall(r'<iframe [^>]*srcdoc="[^"]*"(?: hidden)?></iframe>', sh)) == 4)
check("四个入口按钮 + 主题按钮", sh.count('data-nav="') == 4 and 'id="themeBtn"' in sh)
check("标题带日期、备注进了顶栏", "看板 2026-09-17（离线）" in sh and "转化率：x" in sh)

print("\n[6] export_offline：落盘规矩同 export_day")
tmp = Path(tempfile.mkdtemp(prefix="wb_off_"))
try:
    r = X.export_offline("2026-09-17", out_dir=tmp, get=fake_get, keep=2, now="2026-09-18 10:00")
    check("生成了 看板_2026-09-17.html 和 看板.html", r["ok"] and (tmp / "看板_2026-09-17.html").exists() and (tmp / "看板.html").exists(), r)
    check("dates / notes 带回来", r["dates"]["churn"] == "2026-09-17" and isinstance(r["notes"], list))
    before = (tmp / "看板.html").read_text(encoding="utf-8")
    X.export_offline("2026-09-15", out_dir=tmp, get=fake_get, keep=2, now="2026-09-18 10:00")
    check("补跑更早的一天不覆盖 看板.html", (tmp / "看板.html").read_text(encoding="utf-8") == before and (tmp / "看板_2026-09-15.html").exists())
    def none_get(path):
        return 200, "application/json", json.dumps({"ok": True, "dates": [], "days": [], "found": False}).encode()
    r0 = X.export_offline(None, out_dir=tmp, get=none_get)
    check("一页都没数据 → 不生成、说原因", r0["path"] is None and "一个都没有" in r0["reason"], r0)

    chrome = os.environ.get("WB_CHROME")
    if chrome and Path(chrome).exists():
        print("\n[7] ★ 无头 Chromium 真开每一页（WB_CHROME）")
        for key, _, _, label, _ in O.PAGES:
            f = tmp / f"page_{key}.html"
            f.write_text(docs[key], encoding="utf-8")
            r_ = subprocess.run([chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server",
                                 "--virtual-time-budget=6000", "--dump-dom", f"file://{f}"], capture_output=True, text=True, timeout=120)
            dom = r_.stdout
            txt = re.sub(r"<script[\s\S]*?</script>", "", dom)
            txt = re.sub(r"<[^>]+>", " ", txt)
            want = {"conversion": "直接加载", "order-monitor": "还没有台账", "churn": "商户", "trade": "交易额"}[key]
            check(f"{label}：页面渲染出了内容（含「{want}」，没有「没嵌这份数据」）", len(dom) > 1000 and want in txt and "没嵌这份数据" not in txt,
                  ("dom", len(dom), "片段", re.sub(r"\s+", " ", txt)[:200]))
    else:
        print("\n  跳过 [7]（没设 WB_CHROME）")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
