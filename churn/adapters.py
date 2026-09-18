# -*- coding: utf-8 -*-
"""churn.adapters —— 两种报表 → 公共字段。

「适配层」的意思：报表的列名、sheet 名、日期写法是上游的事，随时会改；
台账、状态机、推送只认这里吐出来的公共字段。上游改版只打到这个文件。

两条规矩，都是踩过的：
  ⚠ 用户ID 是 19 位整数，**全程文本**。它超过 2^53，走一次 float 就丢精度，而它是
    台账、多维表格、出单监控三边对账的键。读 Excel 时用 converters 钉成 str，
    再过一遍 text() 把 "1.2e+18" / "123.0" 这种半路变过形的也修回来。
  ⚠ 空格子是空串，不是 "nan"。pandas 把空单元格读成 NaN，str(NaN) 是字面量 "nan"
    而且为真 —— 出单监控在群消息里出现过 `nan`（坑.md §2.18.96）。

FlyLink 那份表的结构不一样（多日期列和状态列），以后接的时候再写一个
flylink_rows()，吐同一套 PUBLIC_FIELDS，可选字段留空。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

# 读 Excel 不走 pandas：pandas 把数字单元格先转成 float 再交给 converters，19 位用户ID
# 在那一步就已经丢了精度（实测 1828351428978479106 → …104），converters 救不回来。
# 直接用 openpyxl（.xlsx）/ xlrd（.xls）拿原始单元格：openpyxl 的整数是精确的，
# xlrd 的数字单元格是 IEEE double（.xls 文件本身就存不下 19 位整数，谁读都一样）。
# 上游实际发的两份报表用户ID 都是**文本**单元格；万一哪天变成数字且超过 2^53，
# 那几行不能带着错的键进台账 —— 丢掉，并在 warnings 里说清楚。

# 站点级公共字段。这是内存里 dict 的键序（用例钉着，写行的人照这个顺序写）。
# ⚠ 台账文件按键名排序写出（ledger._write_json 的 sort_keys），文件里的顺序**不是**这个，
#   谁也别依赖文件里的键序 —— 同 坑.md §2.18.5 那类事。
PUBLIC_FIELDS = ["报表类型", "统计周期", "用户ID", "站点", "商户名称", "直签人",
                 "代理商ID", "代理商名称", "接入模式", "交易金额", "交易笔数"]
# 网关报表（站外_网关TPV统计报表 的「网关_商户维度」sheet）的公共字段。
GATEWAY_FIELDS = ["报表类型", "统计周期", "网关", "用户ID", "交易金额", "交易笔数"]

# 上游列名。改版只改这里。
FLYPAY_REQUIRED = ["报表类型", "统计周期", "用户ID", "站点", "商户名称", "交易金额（美元）", "交易笔数"]
FLYPAY_OPTIONAL = ["直签人", "代理商用户ID", "代理商名称", "接入模式"]
GATEWAY_SHEET = "网关_商户维度"        # 按名字认，不按下标（坑.md §2.20）
GATEWAY_REQUIRED = ["时间类别", "统计日期", "网关", "用户ID", "交易笔数", "交易金额_美元"]

# 必须是精确整数的列：数字单元格超过 2^53 就已经不可信
_ID_COLUMNS = {"用户ID", "代理商用户ID"}
_LOSSY = 2 ** 53

_DATE_PREFIX = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$")


@dataclass
class ReadResult:
    """读一份报表的结果。读不到时 rows 为空、reason 说清为什么 —— 绝不返回一张空表装没事。

    warnings：读到了但有行被丢（用户ID 是数字单元格且超过 2^53，键已经不可信）。
    """
    rows: list = field(default_factory=list)
    reason: str = ""
    path: str = ""
    warnings: list = field(default_factory=list)


# ---------------------------------------------------------------- 取值清洗

def _blank(v) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    if isinstance(v, str) and v.strip().lower() in ("", "nan", "none", "null"):
        return True
    # pandas 的 NaT / NA 也算空 —— 不 import pandas，靠鸭子判断
    try:
        return bool(v != v)      # NaN / NaT 自己不等于自己
    except (TypeError, ValueError):
        return False


def text(v) -> str:
    """任何单元格 → 文本。空 → ""；整数（含 123.0）→ 不带小数点；科学计数法 → 展开。"""
    if _blank(v):
        return ""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    s = str(v).strip()
    if s.endswith(".0") and s[:-2].lstrip("-").isdigit():
        s = s[:-2]
    if "e" in s.lower() and s.replace(".", "").replace("-", "").replace("+", "").lower().replace("e", "").isdigit():
        try:
            s = str(int(Decimal(s)))
        except (InvalidOperation, ValueError):
            pass
    return s


def num(v) -> float:
    """金额。空 / 读不出 → 0.0。"""
    if _blank(v):
        return 0.0
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = str(v).strip().replace(",", "")
    try:
        return float(s)
    except ValueError:
        return 0.0


def count(v) -> int:
    """笔数。报表里是 1288.0 这种浮点，落台账时收成整数。"""
    return int(round(num(v)))


def period(v) -> str:
    """统计周期。日期型单元格 → YYYY-MM-DD；字符串（含「2026 W37 (…)」「2026-09」）原样。"""
    if _blank(v):
        return ""
    if isinstance(v, (datetime, date)):          # pd.Timestamp 是 datetime 的子类
        return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    m = _DATE_PREFIX.match(s)                      # "2026-09-14 00:00:00" 这种整列成文本的写法
    return m.group(1) if m else s


def norm_header(c) -> str:
    """列名：去空白、半角括号换成全角 —— 真实报表两种写法都见过。"""
    s = str(c if c is not None else "")
    for ch in ("\n", "\r", "\t", " ", "　"):
        s = s.replace(ch, "")
    return s.replace("(", "（").replace(")", "）")


# ---------------------------------------------------------------- 行 → 公共字段（纯函数）

def id_lossy(v) -> bool:
    """数字单元格里的 ID 超过 2^53：文件里存的已经是近似值，不能当键用。"""
    return isinstance(v, float) and not isinstance(v, bool) and math.isfinite(v) and abs(v) >= _LOSSY


def _lossy_ids(g: dict, cols=("用户ID",)) -> bool:
    return any(id_lossy(g.get(c)) for c in cols)


def flypay_rows(records: list[dict], warnings: list | None = None) -> list[dict]:
    """FlyPay 独立站收单统计表的行 → PUBLIC_FIELDS。输入是列名已规整的 dict。

    用户ID 丢了精度的行不进结果；warnings 不为 None 时把丢了几行写进去。
    """
    out, lossy = [], 0
    for r in records:
        g = {norm_header(k): v for k, v in r.items()}
        if _lossy_ids(g):
            lossy += 1
            continue
        out.append({
            "报表类型": text(g.get("报表类型")),
            "统计周期": period(g.get("统计周期")),
            "用户ID": text(g.get("用户ID")),
            "站点": text(g.get("站点")),
            "商户名称": text(g.get("商户名称")),
            "直签人": text(g.get("直签人")),
            "代理商ID": text(g.get("代理商用户ID")),
            "代理商名称": text(g.get("代理商名称")),
            "接入模式": text(g.get("接入模式")),
            "交易金额": num(g.get("交易金额（美元）")),
            "交易笔数": count(g.get("交易笔数")),
        })
    if lossy and warnings is not None:
        warnings.append(f"{lossy} 行的用户ID 是数字单元格且超过 2^53（文件里已丢精度），这些行没进台账")
    return out


def gateway_rows(records: list[dict], warnings: list | None = None) -> list[dict]:
    """网关_商户维度 的行 → GATEWAY_FIELDS。"""
    out, lossy = [], 0
    for r in records:
        g = {norm_header(k): v for k, v in r.items()}
        if _lossy_ids(g):
            lossy += 1
            continue
        out.append({
            "报表类型": text(g.get("时间类别")),
            "统计周期": period(g.get("统计日期")),
            "网关": text(g.get("网关")),
            "用户ID": text(g.get("用户ID")),
            "交易金额": num(g.get("交易金额_美元")),
            "交易笔数": count(g.get("交易笔数")),
        })
    if lossy and warnings is not None:
        warnings.append(f"{lossy} 行的用户ID 是数字单元格且超过 2^53（文件里已丢精度），这些行没进台账")
    return out


# ---------------------------------------------------------------- 读文件

class SheetError(RuntimeError):
    """读不了这份文件 / 这张 sheet。message 就是给人看的原因。"""


def _sheet_openpyxl(path: Path, sheet):
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        names = wb.sheetnames
        if isinstance(sheet, int):
            ws = wb.worksheets[sheet]
        elif sheet in names:
            ws = wb[sheet]
        else:
            raise SheetError(f"没有「{sheet}」这张 sheet，只有：{'、'.join(names)}")
        rows = ws.iter_rows(values_only=True)
        header = [c for c in next(rows, [])]
        body = [list(r) for r in rows]
    finally:
        wb.close()
    return header, body


def _sheet_xlrd(path: Path, sheet):
    import xlrd
    book = xlrd.open_workbook(path)
    names = book.sheet_names()
    if isinstance(sheet, int):
        ws = book.sheet_by_index(sheet)
    elif sheet in names:
        ws = book.sheet_by_name(sheet)
    else:
        raise SheetError(f"没有「{sheet}」这张 sheet，只有：{'、'.join(names)}")

    def cell(c):
        if c.ctype == xlrd.XL_CELL_DATE:
            return xlrd.xldate_as_datetime(c.value, book.datemode)
        if c.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK, xlrd.XL_CELL_ERROR):
            return None
        return c.value

    header = [cell(c) for c in ws.row(0)] if ws.nrows else []
    body = [[cell(c) for c in ws.row(i)] for i in range(1, ws.nrows)]
    return header, body


def read_sheet(path, sheet=0) -> list[dict]:
    """一张 sheet → [dict]，列名已规整。按扩展名挑引擎；缺依赖 / 读坏都抛 SheetError。"""
    p = Path(path)
    ext = p.suffix.lower()
    try:
        if ext in (".xlsx", ".xlsm"):
            header, body = _sheet_openpyxl(p, sheet)
        elif ext == ".xls":
            header, body = _sheet_xlrd(p, sheet)
        else:
            raise SheetError(f"不认识的扩展名 {ext}（只读 .xlsx / .xlsm / .xls）")
    except SheetError:
        raise
    except ImportError as e:
        raise SheetError(f"缺读表的依赖（openpyxl 读 .xlsx、xlrd 读 .xls）：{e}") from e
    except Exception as e:  # noqa: BLE001 —— 坏文件的原因要带出去给人看
        raise SheetError(f"读不了：{e}") from e
    cols = [norm_header(c) for c in header]
    return [{c: (r[i] if i < len(r) else None) for i, c in enumerate(cols) if c} for r in body]


def _missing(records: list[dict], required: list[str]) -> list[str]:
    have = set(records[0].keys()) if records else set()
    return [c for c in required if norm_header(c) not in have]


def _read(path, sheet, required, mapper, what) -> ReadResult:
    p = Path(path)
    if not p.is_file():
        return ReadResult(reason=f"文件不存在：{p}", path=str(p))
    try:
        records = read_sheet(p, sheet)
    except SheetError as e:
        return ReadResult(reason=f"{p.name}{what}：{e}", path=str(p))
    if not records:
        return ReadResult(reason=f"{p.name}{what}是空的", path=str(p))
    miss = _missing(records, required)
    if miss:
        return ReadResult(reason=f"{p.name}{what}缺必需列：{'、'.join(miss)}（现有列：{'、'.join(records[0].keys())}）",
                          path=str(p))
    warnings: list = []
    rows = mapper(records, warnings)
    return ReadResult(rows=rows, path=str(p), warnings=warnings)


def read_flypay(path) -> ReadResult:
    """读 FlyPay 独立站收单统计表（第一张 sheet）。"""
    return _read(path, 0, FLYPAY_REQUIRED, flypay_rows, "")


def read_gateway(path) -> ReadResult:
    """读 站外_网关TPV统计报表 里的「网关_商户维度」。按名字认；读不到说清楚有哪些 sheet。"""
    return _read(path, GATEWAY_SHEET, GATEWAY_REQUIRED, gateway_rows, f" 的「{GATEWAY_SHEET}」")
