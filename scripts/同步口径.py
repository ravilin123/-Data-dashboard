# -*- coding: utf-8 -*-
"""
同步口径.py - 从工作台仓库把口径层原路径拷过来。

    python scripts/同步口径.py --from ../payment-ops-workbench            # 真同步
    python scripts/同步口径.py --from ../payment-ops-workbench --dry-run  # 只看会动哪些
    python scripts/同步口径.py --from ../payment-ops-workbench --force    # 本地改过的也覆盖

只认工作台根目录那份 `口径清单.json`（什么算口径层由**那边**定，这边不另列一份 —— 两份必漂）。
镜像路径复制：`churn/overview.py` 过来还是 `churn/overview.py`，import 一个字不用改，
同步来的测试原样能跑。

写 `同步记录.json`：工作台 commit、时间、每个文件的 sha256。`tests/sync_check.py` 拿它对现在的
文件 —— 有人手改了同步来的文件就红。**同步来的文件不许在这个仓库里改**，要改回工作台改、再同步。

⚠ 本地改过的文件（现在的 sha 和上次记录不一致）**先列出来、停下**，不静默覆盖；确认了加 `--force`。
⚠ 坑.md 不整份拷：按清单 `docs.坑` 的条目号抽整条，§ 号不变（代码注释里的 `CLAUDE.md §x` 指的就是它）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECORD = ROOT / "同步记录.json"
MANIFEST_NAME = "口径清单.json"
PIT = "docs/坑.md"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def git(src: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(src), *args], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def expand(src: Path, m: dict) -> list[str]:
    """清单 → 相对路径列表（去重、稳定顺序）。目录整个拷（含 README.md）。"""
    out: list[str] = []
    for d in m["js"].get("dirs", []):
        for p in sorted((src / d).rglob("*")):
            if p.is_file() and p.suffix in (".js", ".mjs", ".md"):
                out.append(p.relative_to(src).as_posix())
    for group in ("python", "js", "tests"):
        out += m[group].get("files", [])
    out += m["docs"].get("specs", [])
    out.append(MANIFEST_NAME)
    seen, uniq = set(), []
    for f in out:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    return uniq


_HEAD = re.compile(r"^\*\*(\d+(?:\.\d+)*) ·")


def extract_pits(text: str, wanted: list[str]) -> tuple[str, list[str]]:
    """按条目号抽整条。一条从 `**N · ` 开头到下一条开头（或末尾的 ---）为止。返回 (正文, 没找到的号)。"""
    lines = text.splitlines()
    starts = [(i, m.group(1)) for i, l in enumerate(lines) if (m := _HEAD.match(l))]
    end_all = len(lines)
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip() == "---":
            end_all = i
            break
    chunks, found = {}, set()
    for k, (i, n) in enumerate(starts):
        j = starts[k + 1][0] if k + 1 < len(starts) else end_all
        chunks[n] = "\n".join(lines[i:j]).rstrip() + "\n"
        found.add(n)
    missing = [n for n in wanted if n not in found]
    body = "\n".join(chunks[n] for n in [s[1] for s in starts] if n in wanted)
    return body, missing


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True, help="工作台仓库根目录")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="本地改过的同步文件也覆盖")
    a = ap.parse_args()
    src = Path(a.src).resolve()
    mp = src / MANIFEST_NAME
    if not mp.exists():
        print(f"找不到 {mp} —— --from 要指到工作台仓库根目录", file=sys.stderr)
        return 2
    m = json.loads(mp.read_text(encoding="utf-8"))
    files = expand(src, m)
    old = json.loads(RECORD.read_text(encoding="utf-8")) if RECORD.exists() else {"files": {}}

    missing_src = [f for f in files if not (src / f).exists()]
    if missing_src:
        print("工作台里缺这些清单文件（清单和代码漂了，先去那边修）：\n  " + "\n  ".join(missing_src), file=sys.stderr)
        return 2

    # 本地手改过的：现在的 sha ≠ 上次同步记录的 sha
    dirty = [f for f in files if (ROOT / f).exists() and f in old["files"] and sha(ROOT / f) != old["files"][f]]
    if dirty and not a.force:
        print("⚠ 这些文件在本仓库里被改过（和上次同步记录不一致），不覆盖。要改回工作台改；确认丢弃就加 --force：")
        print("  " + "\n  ".join(dirty))
        return 3

    changed, same, new = [], [], []
    for f in files:
        s, d = src / f, ROOT / f
        if not d.exists():
            new.append(f)
        elif sha(s) != sha(d):
            changed.append(f)
        else:
            same.append(f)

    pit_text = (src / PIT).read_text(encoding="utf-8")
    body, missing_pits = extract_pits(pit_text, m["docs"]["坑"])
    if missing_pits:
        print(f"坑.md 里找不到这些条目号：{missing_pits}（清单和文档漂了）", file=sys.stderr)
        return 2

    commit = git(src, "rev-parse", "--short", "HEAD")
    remote = git(src, "remote", "get-url", "origin")
    print(f"来源 {src}  commit {commit or '?'}")
    print(f"新增 {len(new)}  更新 {len(changed)}  未变 {len(same)}  坑条目 {len(m['docs']['坑'])}")
    for f in new:
        print("  + " + f)
    for f in changed:
        print("  ~ " + f)
    if a.dry_run:
        print("（dry-run，一个字没动）")
        return 0

    for f in new + changed:
        d = ROOT / f
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / f, d)

    tz = timezone(timedelta(hours=8))
    head = (f"# 实测出来的坑（口径相关，抽自工作台）\n\n"
            f"抽自 `payment-ops-workbench` `{commit or '?'}`（{datetime.now(tz).strftime('%Y-%m-%d %H:%M')}），"
            f"按 `{MANIFEST_NAME}` 的 `docs.坑` 逐条抽的，**§ 号和工作台一致**：代码注释里写的 `CLAUDE.md §x`、\n"
            f"`坑.md §x` 指的就是这些号。这份是同步产物，不要在这里改 —— 改工作台那份再同步。\n\n---\n\n")
    (ROOT / PIT).parent.mkdir(parents=True, exist_ok=True)
    (ROOT / PIT).write_text(head + body, encoding="utf-8")

    rec = {
        "from_repo": remote, "from_commit": commit,
        "synced_at": datetime.now(tz).isoformat(timespec="seconds"),
        "files": {f: sha(ROOT / f) for f in files},
        "docs": {PIT: sha(ROOT / PIT), "坑": m["docs"]["坑"]},
    }
    RECORD.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写 {RECORD.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
