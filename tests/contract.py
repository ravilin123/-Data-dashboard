"""
contract.py - 契约校验器（contracts/validate.py）自己得先靠得住。

    python tests/contract.py     # 零依赖

校验器读的是 schema 文件本身；这里钉的是「它真抓得到」：每种错都造一份坏日报看它报不报、报的路径对不对。
一条误报就够让人学会忽略这个校验器（§2.18.99），所以也钉「合契约的最小日报一条错都不报」。
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from contracts.validate import validate  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


GOOD = {
    "ok": True, "schema": 1, "date": "2026-09-17", "generated_at": "2026-09-18T09:30:12+08:00",
    "source": {"key": "workbench", "label": "工作台台账"}, "asof": None, "progress": None, "reason": "",
    "blocks": [{
        "key": "trade", "label": "交易量", "date": "2026-09-17", "ok": True, "reason": "",
        "kpis": [{"key": "tpv", "label": "交易额", "value": 12.5, "unit": "USD", "fmt": "money", "dod": 0.03, "prev": 12.1, "note": ""}],
        "sections": [{"key": "top", "label": "Top", "note": "",
                      "columns": [{"key": "商户名称", "label": "商户", "fmt": "text"}, {"key": "tpv", "label": "交易额", "fmt": "money"}],
                      "rows": [{"商户名称": "甲", "tpv": 1.0}], "truncated": {"shown": 1, "total": 3}}],
        "series": [{"key": "tpv30", "label": "近 30 天", "unit": "USD", "fmt": "money",
                    "points": [{"x": "2026-09-16", "y": 1.0}, {"x": "2026-09-17", "y": None}]}],
    }, {
        "key": "churn", "label": "商户流失", "date": None, "ok": False, "reason": "这天没跑过",
        "kpis": [], "sections": [], "series": [],
    }],
}

print("[1] 合契约的一条错都不报")
check("最小日报", validate(GOOD) == [], validate(GOOD))
check("ok:false 的块（date null、三个数组空）也合契约", validate(GOOD)[:1] == [])


def broken(mut):
    r = copy.deepcopy(GOOD)
    mut(r)
    return validate(r)


print("\n[2] ★ 每种错都抓得到，且路径指到那个字段")
cases = [
    ("顶层缺 blocks", lambda r: r.pop("blocks"), "report.blocks: 缺字段"),
    ("schema 不是 1", lambda r: r.__setitem__("schema", 2), "report.schema: 只能是 [1]"),
    ("日期格式", lambda r: r.__setitem__("date", "2026/09/17"), "report.date: 不符合"),
    ("fmt 不在六种里", lambda r: r["blocks"][0]["kpis"][0].__setitem__("fmt", "percent"), "report.blocks[0].kpis[0].fmt: 只能是"),
    ("dod 写成字符串（百分数字面量）", lambda r: r["blocks"][0]["kpis"][0].__setitem__("dod", "3%"), "report.blocks[0].kpis[0].dod: 期望 number|null，得到 str"),
    ("value 缺（0 都不许省，null 也要写出来）", lambda r: r["blocks"][0]["kpis"][0].pop("value"), "report.blocks[0].kpis[0].value: 缺字段"),
    ("point 的 y 是字符串", lambda r: r["blocks"][0]["series"][0]["points"][0].__setitem__("y", "1"), "report.blocks[0].series[0].points[0].y: 期望 number|null"),
    ("truncated 缺 total", lambda r: r["blocks"][0]["sections"][0].__setitem__("truncated", {"shown": 1}), "report.blocks[0].sections[0].truncated.total: 缺字段"),
    ("column 缺 fmt", lambda r: r["blocks"][0]["sections"][0]["columns"][0].pop("fmt"), "report.blocks[0].sections[0].columns[0].fmt: 缺字段"),
    ("blocks 不是数组（dict 键序那种）", lambda r: r.__setitem__("blocks", {"trade": {}}), "report.blocks: 期望 array"),
    ("block 缺 series 数组", lambda r: r["blocks"][0].pop("series"), "report.blocks[0].series: 缺字段"),
    ("rows 的键和 columns 一个都对不上", lambda r: r["blocks"][0]["sections"][0].__setitem__("rows", [{"x": 1}]), "report.blocks[0].sections[0].rows: 没有一行的键对得上"),
    ("ok 写成 1", lambda r: r.__setitem__("ok", 1), "report.ok: 期望 boolean"),
]
for name, mut, want in cases:
    errs = broken(mut)
    check(f"{name} → 报 `{want}`", any(e.startswith(want) for e in errs), errs)

print("\n[3] 只报一处、不连锁：一个字段错，别的字段不跟着报")
errs = broken(lambda r: r["blocks"][0]["kpis"][0].__setitem__("fmt", "percent"))
check("正好一条", len(errs) == 1, errs)

print("\n" + (f"失败 {len(fails)} 项: {fails}" if fails else "全部通过"))
sys.exit(1 if fails else 0)
