# -*- coding: utf-8 -*-
"""读报表与类型转换。逻辑照搬自「出单监控.py」的工具函数区，一行未改。

`clean_uid` 那段尤其别动：用户ID 是 19 位大整数，走 float 会丢精度，
而它是和多维表格对账的唯一键的一半。
"""
from __future__ import annotations

import os
import re
from datetime import datetime
from decimal import Decimal

import pandas as pd

DATE_FIELDS = [
    "站点_商户提交时间", "站点_风控审核时间", "支付方式_商户提交时间", "支付方式_风控审核时间",
    "提交通道时间", "通道结果反馈时间", "第一笔成功交易时间", "出单日期",
]

NUMBER_FIELDS = [
    "站点_上线时长", "支付方式_上线时长", "站点_网站审核耗时", "支付方式_网站审核耗时",
    "通道审核耗时", "集成耗时", "累计TPV_USD",
]


def normalize_site(site):
    if isinstance(site, list):
        site = site[0].get("text", "") if site else ""
    if pd.isna(site) or site is None:
        return ""
    # ⚠ 先转小写，再剥前缀。原来顺序是反的（.lower() 在最后一步），
    #   于是 "WWW." / "HTTPS://" 这些大写写法一个都剥不掉：
    #   同一个站点大小写不同会算成两个 key（uid|站点）—— 多维表格对账时匹配不上，
    #   而且昨天今天大小写一变，那家商户会被当成"新的"，TPV 对比整个失效。
    #   key 每次都是从原始值现算的（报表那边和多维表格那边走的是同一个函数），
    #   所以改这里不需要数据迁移。
    site = str(site).strip().lower()
    site = site.replace("https://", "").replace("http://", "")
    if site.startswith("www."):
        site = site[4:]
    return site.rstrip("/")


def to_timestamp_ms(val):
    if pd.isna(val) or val is None or str(val).strip() == "":
        return None
    if isinstance(val, (pd.Timestamp, datetime)):
        dt = val.to_pydatetime() if isinstance(val, pd.Timestamp) else val
        return int(dt.timestamp() * 1000)
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"]:
        try:
            return int(datetime.strptime(str(val).strip(), fmt).timestamp() * 1000)
        except ValueError:
            continue
    return None


def to_float(val):
    if pd.isna(val) or val is None or str(val).strip() == "":
        return 0.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


def to_date(val):
    if pd.isna(val) or val is None or str(val).strip() == "":
        return None
    if isinstance(val, (pd.Timestamp, datetime)):
        return val.to_pydatetime() if isinstance(val, pd.Timestamp) else val
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"]:
        try:
            return datetime.strptime(str(val).strip(), fmt)
        except ValueError:
            continue
    return None


def extract_date_from_filename(filepath):
    match = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(filepath))
    return match.group(1) if match else None


def clean_uid(x):
    """清理用户ID，不经过float，避免大整数精度丢失"""
    if pd.isna(x) or str(x).strip() == "":
        return ""
    s = str(x).strip()
    if s.endswith(".0"):
        s = s[:-2]
    if "e" in s.lower():
        # 科学计数法用Decimal精确还原
        try:
            s = str(int(Decimal(s)))
        except Exception:
            pass
    return s


# 第三张 sheet 的名字。**按名字认，不按下标** —— `read_excel_sheet2` 走的是
# `sheet_name=1`，上游哪天在前面插一张表，那条会整个错位**而且不报错**
# （读到的是别的表，列名对不上，于是每一行都被当成脏数据）。
REJECT_SHEET = "站点审核失败"


def read_reject_sheet(filepath):
    """读第三张 sheet「站点审核失败」——被拒站点的累计名单。

    第十一轮之前**从来没读过它**：`read_excel_sheet2` 只读 `sheet_name=1`。
    实测 711 行 / 528 个商户 / 707 个站点，两天 +13 −2（不是纯追加），
    **511 行没有所属 BD** —— 没人认领的那批正是这张表最值钱的部分。

    返回 `(df, 原因)`：
      · 认得出 → `(df, "")`
      · 认不出 → `(None, 说明)`，**不抛异常** —— 分类和通知一个字都不依赖这张表，
        不能因为上游改了个表名就让整条链路挂掉
      · 但也**不静默返回空表** —— 空表和「今天真的一条都没有」长得一模一样，
        而这两件事该做的动作完全相反（一个是去改代码，一个是什么都不用做）
    """
    try:
        book = pd.ExcelFile(filepath)
    except Exception as e:
        return None, f"打不开 {os.path.basename(filepath)}：{e}"

    names = [str(n) for n in book.sheet_names]
    if REJECT_SHEET not in names:
        # 把实际有哪些 sheet 列出来 —— 上游改名时照着这句就能改，
        # 不用再自己去开一遍 Excel 数第几张表
        return None, (f"没有名叫「{REJECT_SHEET}」的 sheet，这份有：" + "、".join(names))

    try:
        df = book.parse(sheet_name=REJECT_SHEET, converters={"用户ID": str})
    except Exception as e:
        return None, f"读「{REJECT_SHEET}」失败：{e}"

    df.columns = [str(c).strip().replace('\n', '').replace('\r', '') for c in df.columns]
    if "用户ID" in df.columns:
        df["用户ID"] = df["用户ID"].apply(clean_uid)
    return df, ""


def read_excel_sheet2(filepath):
    converters = {"用户ID": str}
    try:
        df = pd.read_excel(filepath, sheet_name=1, header=1, converters=converters)
    except Exception:
        try:
            df = pd.read_excel(filepath, sheet_name=1, header=0, converters=converters)
        except Exception:
            df = pd.read_excel(filepath, header=0, converters=converters)
    df.columns = [str(c).strip().replace('\n', '').replace('\r', '') for c in df.columns]
    if df.shape[0] > 0 and str(df.iloc[0, 0]).strip() in ["用户ID", "字段说明", ""]:
        df = df.iloc[1:].reset_index(drop=True)
    if "用户ID" in df.columns:
        df["用户ID"] = df["用户ID"].apply(clean_uid)
    return df
