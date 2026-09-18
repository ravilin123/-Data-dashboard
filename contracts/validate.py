# -*- coding: utf-8 -*-
"""
contracts/validate.py - 按 daily_report.schema.json 校验一份日报。零依赖。

    python -m contracts.validate 某份日报.json

只实现 schema 用到的那一小撮关键字（type / required / properties / items / enum / pattern / $ref），
**读的是 schema 文件本身** —— 不另抄一份规则，schema 改了校验器跟着变（一处定义）。
返回的是**字段路径列表**（`blocks[2].kpis[0].dod: 期望 number|null，得到 str`），
公司接口不合契约时页面和 sources 接口把这份列表原样给出，不静默修。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent / "daily_report.schema.json"
_SCHEMA: dict | None = None

_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def schema() -> dict:
    global _SCHEMA
    if _SCHEMA is None:
        _SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return _SCHEMA


def _resolve(node: dict, root: dict) -> dict:
    ref = node.get("$ref")
    if not ref:
        return node
    cur = root
    for part in ref.lstrip("#/").split("/"):
        cur = cur[part]
    return _resolve(cur, root)


def _walk(value, node: dict, root: dict, path: str, errors: list[str]) -> None:
    node = _resolve(node, root)
    types = node.get("type")
    if types is not None:
        ts = [types] if isinstance(types, str) else list(types)
        if not any(_TYPES[t](value) for t in ts):
            errors.append(f"{path}: 期望 {'|'.join(ts)}，得到 {type(value).__name__}")
            return
    if "enum" in node and value not in node["enum"]:
        errors.append(f"{path}: 只能是 {node['enum']}，得到 {value!r}")
    if "pattern" in node and isinstance(value, str) and not re.search(node["pattern"], value):
        errors.append(f"{path}: 不符合 {node['pattern']}，得到 {value!r}")
    if isinstance(value, dict):
        for k in node.get("required", []):
            if k not in value:
                errors.append(f"{path}.{k}: 缺字段")
        for k, sub in node.get("properties", {}).items():
            if k in value:
                _walk(value[k], sub, root, f"{path}.{k}", errors)
    if isinstance(value, list) and "items" in node:
        for i, item in enumerate(value):
            _walk(item, node["items"], root, f"{path}[{i}]", errors)


def validate(report) -> list[str]:
    """一份日报 → 错误列表（空 = 合契约）。路径从 `report` 起。"""
    errors: list[str] = []
    _walk(report, schema(), schema(), "report", errors)
    # 契约里写在 schema 之外的两条：rows 的键要对得上 columns（多的忽略、少的空），这里只报「一列都对不上」
    if isinstance(report, dict):
        for bi, b in enumerate(report.get("blocks") or []):
            if not isinstance(b, dict):
                continue
            for si, s in enumerate(b.get("sections") or []):
                if not isinstance(s, dict):
                    continue
                keys = {c.get("key") for c in s.get("columns") or [] if isinstance(c, dict)}
                rows = [r for r in s.get("rows") or [] if isinstance(r, dict)]
                if keys and rows and all(not (keys & set(r)) for r in rows):
                    errors.append(f"report.blocks[{bi}].sections[{si}].rows: 没有一行的键对得上 columns[].key")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("用法：python -m contracts.validate 日报.json", file=sys.stderr)
        return 2
    errs = validate(json.loads(Path(argv[1]).read_text(encoding="utf-8")))
    if errs:
        print("\n".join(errs))
        return 1
    print("合契约")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
