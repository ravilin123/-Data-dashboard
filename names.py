# -*- coding: utf-8 -*-
"""
names.py - 「名字」和「档位」的唯一出处：`owner_name` / `UNASSIGNED` / `is_agent_id` / `MODES`。

这是**口径层**的一部分（`口径清单.json`），不依赖飞书、邮箱、Flask —— 看板仓库按原路径同步它。
2026-09-18 之前这四样定义在 `feishu_send.py`（第 03 张票抽的共享层）；那边现在原名 re-export，
调用方一个都没断：`feishu_send.owner_name is names.owner_name`，`classify.clean_bd_name` 仍是别名。
搬家的原因：口径层（`churn/overview.py`、`order_monitor/classify.py`）为了一个清洗名字的函数
拖进整个发送层（requests、签名、私聊），在没装 requests 的环境里 import 不进来。

  · 空格子是「未分配BD」，不是字面量 nan（坑.md §2.18.96）—— owner_name 就是原来的 clean_bd_name
  · 四档 mode 只在 MODES 一处定义，出单监控的 --mode choices 和配置页下拉由用例钉着一字不差（§2.18.95）
"""
from __future__ import annotations

import math

MODES = ("both", "group", "dm", "silent")
UNASSIGNED = "未分配BD"


def owner_name(raw) -> str:
    """负责人（所属BD / 直签人）的名字。空 / NaN / "nan" 一律「未分配BD」。

    原来叫 order_monitor.classify.clean_bd_name，三处共用（群消息、私聊分组、台账），
    那边现在是这个函数的别名。逻辑一字未改。
    """
    if raw is None:
        return UNASSIGNED
    if isinstance(raw, float) and math.isnan(raw):
        return UNASSIGNED
    s = str(raw).strip()
    if not s or s.lower() in ("nan", "nat", "none", "null"):     # 和原来 clean_bd_name 的清单一字不差
        return UNASSIGNED
    return s


def is_agent_id(name: str) -> bool:
    """直签人写的是代理商的用户 ID（15 位以上的纯数字），不是人名。"""
    return name.isdigit() and len(name) >= 15
