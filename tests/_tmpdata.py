"""用例要写台账时，**整套换到临时目录**。

⚠ 这个仓库踩过：本机 `data/churn/ledger/` 里是**用户的真实台账**，而且 `data/` 在 `.gitignore`
  里、从来没进过仓库 —— 被用例覆盖掉就是**永久丢失**，恢复不了（存档报表 30 天就清了）。
  实测丢过两天：71 行变成 1 行，而且**一声不响**。

⚠ 手工改那几个全局路径的写法漏一个就等于没换（`churn_weekly.py` 原来只换了 `LEDGER_DIR`
  和 `WEEKLY_DIR`，`GATEWAY_DIR` / `STATE_PATH` 还指着真目录）。所以这里**一次全换**，
  以后 `ledger.py` 加了新的那本，只改这一处。
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

# ledger.py 里所有指向 data/ 的全局。加了新的一本就往这儿加一行。
_PATHS = ("LEDGER_DIR", "GATEWAY_DIR", "WEEKLY_DIR", "STATE_PATH")


def use_temp_ledger(lg, prefix: str = "wb_ledger_"):
    """把 `churn.ledger` 的所有台账路径换到一个临时目录。返回 (tmp, 还原函数)。

    还原函数**一定要在 finally 里调**：不调的话同一进程里后面的用例会写到临时目录上，
    看着像「台账是空的」，而那正是最难查的一种假红。
    """
    real = {k: getattr(lg, k) for k in _PATHS if hasattr(lg, k)}
    missing = [k for k in _PATHS if not hasattr(lg, k)]
    if missing:                       # ledger.py 改了名字：**要炸，不能装作换好了**
        raise AssertionError(f"churn.ledger 里没有 {missing} —— 换名字了就把 _tmpdata._PATHS 一起改")
    tmp = Path(tempfile.mkdtemp(prefix=prefix))
    for k in real:
        setattr(lg, k, (tmp / k.lower()) if k.endswith("_DIR") else (tmp / "ingested.json"))

    def restore(keep: bool = False):
        for k, v in real.items():
            setattr(lg, k, v)
        if not keep:
            shutil.rmtree(tmp, ignore_errors=True)

    return tmp, restore


def real_paths(lg) -> dict:
    """真实那几个路径长什么样 —— 给「确认没写到真目录上」那种断言用。"""
    return {k: getattr(lg, k, None) for k in _PATHS}
