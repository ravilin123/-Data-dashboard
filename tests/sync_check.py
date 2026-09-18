"""
sync_check.py - 同步来的文件没人手改过（看板计划 第 03 张票）

    python tests/sync_check.py      # 零依赖

`同步记录.json` 记着每个同步文件的 sha256。这里逐个比：不一致 = 有人在这个仓库里改了
口径层 —— 那是**不许的**（改回工作台改、再同步），否则两份口径就漂了（§2.18.99）。
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
rec_p = ROOT / "同步记录.json"
fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


print("[1] 同步记录在")
check("同步记录.json 存在（没有 = 还没同步过：python scripts/同步口径.py --from <工作台>）", rec_p.exists())
if not rec_p.exists():
    sys.exit(1)
rec = json.loads(rec_p.read_text(encoding="utf-8"))
check("记着工作台 commit", bool(rec.get("from_commit")), rec.get("from_commit"))

print("[2] ★ 同步来的文件一个字没改")
for f, h in rec["files"].items():
    p = ROOT / f
    if not p.exists():
        check(f"{f} 还在", False, "文件没了")
        continue
    check(f, hashlib.sha256(p.read_bytes()).hexdigest() == h, "和同步记录的 sha256 不一致 —— 在这里改了？改回工作台改再同步")
for f, h in (rec.get("docs") or {}).items():
    if f == "坑":
        continue
    p = ROOT / f
    check(f + "（抽取产物）", p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() == h)

print("\n" + (f"失败 {len(fails)} 项" if fails else "全部通过"))
sys.exit(1 if fails else 0)
