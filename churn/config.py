# -*- coding: utf-8 -*-
"""churn.config —— `config.json` 里 `churn` 那一段的读法。

⚠ 数字一律走 `_int` / `_float`：配置页上 number 框空着保存写的是 `null`，`.get(k, 默认)` 挡不住；
  `or 默认` 又会把有意义的 `0` 吃掉（坑.md §2.18.98）。
每次现读文件：配置页写回后立刻生效，不用重启。
"""
from __future__ import annotations

import json
from pathlib import Path

from names import MODES

HERE = Path(__file__).resolve().parent.parent
CONFIG_PATH = HERE / "config.json"
EXAMPLE_PATH = HERE / "config.example.json"

DEFAULTS = {
    "mode": "silent",             # 上线先静默三天，看名单准不准再开推送（第 05 张票接推送）
    "top_n": 30,                  # 只有最近 30 天滚动 TPV 前 N 的站点有资格推
    "silence_days": [2, 7, 30],   # 沉默满几天各推一次
    "drop_push": -0.70,           # 日环比 ≤ 这个 → 推
    "drop_page": -0.50,           # 日环比 ≤ 这个 → 只在页面
    "recover_ratio": 0.8,         # 两天内回到掉量前水平的这个比例 → 自动关闭
    "sporadic_max_days": 10,      # 30 天里活跃 ≤ 这么多天 → 零星型
    "window_days": 30,            # 滚动窗口
    "webhook_url": "",            # 群消息发到哪；留空回落到 feishu.webhook.team
    "boss_emails": [],            # 周一摘要私聊给谁（第 08 张票）
    "fallback_email": "",         # 兜底人：直签人是代理商 ID 或空时发给他（第 05 张票）
    "gateway_incident_min": 3,    # 同网关当天 ≥ 这么多**家**（不是条）一起掉 → 通道异常（第 07 张票）
    "gateway_incident_top_n": 50, # 只数排名前这么多的；0 = 不限（一堆尾部小商户凑不出「通道出事」）
    "agent_owner": {},            # 代理商ID → BD 姓名（以后维护）
    # 日报汇总：30 天 TPV 低于这条线的不进汇总（「小金额的掉量无所谓」）。
    # ⚠ 看的是**这家商户有多大**，不是「这次掉了多少」—— 实测 2026-08-22 那天
    #   36 条命中里过线的只有 10 条，但那 10 条占掉 95% 的金额（砍条数不砍金额）。
    # ⚠ 填 0 = 不设门槛，是有意义的一档，别被 `or` 吃掉（§2.18.98）。
    "daily_min_tpv": 5000,
    "daily_top_n": 5,             # 日报汇总底下列前几家
    # 商户流失自己的底账表。app_token 留空回落到 feishu.bitable.app_token（常在同一个 base 里），
    # table_id **必须自己填** —— 回落到别的表的话列名一个都不重合，写进去 0 条还不报错（§2.19.6）。
    "bitable": {"app_token": "", "table_id": ""},
}


def _int(v, default):
    if v is None or (isinstance(v, str) and not v.strip()):
        return default
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _float(v, default):
    if v is None or (isinstance(v, str) and not v.strip()):
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _days(v, default):
    """[2, 7, 30] 或「2,7,30」都认；垃圾丢掉；去重排序；空了回默认。"""
    if isinstance(v, str):
        v = v.replace("，", ",").split(",")
    if not isinstance(v, (list, tuple)):
        return list(default)
    out = sorted({x for x in (_int(x, None) for x in v) if x is not None and x > 0})
    return out or list(default)


def settings(cfg: dict | None) -> dict:
    """整个 config.json（或只有 churn 那段的 dict）→ 规整后的设置。"""
    raw = (cfg or {}).get("churn") if isinstance(cfg, dict) and "churn" in (cfg or {}) else (cfg or {})
    raw = raw if isinstance(raw, dict) else {}
    s = dict(DEFAULTS)
    s["mode"] = raw.get("mode") if raw.get("mode") in MODES else DEFAULTS["mode"]
    s["top_n"] = _int(raw.get("top_n"), DEFAULTS["top_n"])
    s["silence_days"] = _days(raw.get("silence_days"), DEFAULTS["silence_days"])
    for k in ("drop_push", "drop_page", "recover_ratio"):
        s[k] = _float(raw.get(k), DEFAULTS[k])
    for k in ("sporadic_max_days", "window_days", "gateway_incident_min", "gateway_incident_top_n",
              "daily_min_tpv", "daily_top_n"):
        s[k] = _int(raw.get(k), DEFAULTS[k])
    s["webhook_url"] = str(raw.get("webhook_url") or "").strip()
    s["fallback_email"] = str(raw.get("fallback_email") or "").strip()
    # 配置页上是一个文本框，写回来是「a@x.com, b@y.com」；老配置里是数组。两种都认。
    be = raw.get("boss_emails")
    if isinstance(be, str):
        be = be.replace("，", ",").replace("；", ",").replace(";", ",").split(",")
    s["boss_emails"] = [str(x).strip() for x in (be if isinstance(be, (list, tuple)) else [be])
                        if x and str(x).strip()]
    ao = raw.get("agent_owner")
    s["agent_owner"] = {str(k): str(v) for k, v in ao.items()} if isinstance(ao, dict) else {}
    bt = raw.get("bitable") if isinstance(raw.get("bitable"), dict) else {}
    s["bitable"] = {"app_token": str(bt.get("app_token") or "").strip(),
                    "table_id": str(bt.get("table_id") or "").strip()}
    return s


def table_target(cfg: dict, settings: dict) -> tuple:
    """(app_token, table_id, 说不出来的原因)。table_id 没配就不写表，**不回落到别的表**。"""
    bt = settings.get("bitable") or {}
    app = bt.get("app_token") or (((cfg or {}).get("feishu") or {}).get("bitable") or {}).get("app_token") or ""
    table = bt.get("table_id") or ""
    if not table:
        return "", "", "没配 churn.bitable.table_id，不写表（不回落到别的表：列名对不上会写进去 0 条还不报错）"
    if not app:
        return "", "", "没配 churn.bitable.app_token，也没有 feishu.bitable.app_token 可回落"
    return app, table, "" 


def load_raw() -> dict:
    """现读整个 config.json（没有就 example）。读不到 = 空 dict。

    要整份而不只是 churn 段：BD 邮箱在 `order_monitor.bd_emails`、群 webhook 要回落到
    `feishu.webhook.team.url`，只拿 churn 段的话这两样都取不到。
    """
    for p in (CONFIG_PATH, EXAMPLE_PATH):
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return raw
        except (OSError, ValueError):
            continue
    return {}


def load() -> dict:
    """现读 config.json 里的 churn 段。读不到 = 全默认。"""
    return settings(load_raw())
