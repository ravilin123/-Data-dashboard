# -*- coding: utf-8 -*-
"""第二步：纯 Excel 对比，生成分类结果。不碰多维表格、不发通知。

逻辑照搬自「出单监控.py」—— 这是整条链路里唯一决定「谁算新出单、谁算滞留」的地方，
动它就是动业务口径。T10 搬进来时一行未改。

**唯一的改动是后来加的 `keep` 档**（第五轮 R1）：原来只有"状态发生跃迁"的商户能进
`results`，于是漏跑一天，那天跨过 $100 的商户**再也不会**进入 `results` ——
不是延迟，是永久缺席。现在存量商户照样带整行进 `results`（表每天全量对齐），
但**不进 `notify`** —— 存量不是事件，通知内容和加 keep 之前逐字一致。

**第十一轮加了 `audit` 出参 —— 只观测，不改口径。**
起因是「这个出单监控存在一个问题就是数据没有穷尽」。拿 2026-09-08 那份真实报表
（392 行）实跑：通知 + 多维表格看得到 126 行（32.1%），只进多维表格 192 行（49.0%），
**剩下 74 行（18.9%）三条 `continue` 静默丢弃** —— 不进 `results`、不进多维表格、
不进通知、不进 json，哪儿都没有。其中最大的一条是开通 >60 天的 68 家，
开通天数中位 88 天、**39 家在 61~90 天**，是刚越过 60 天线掉下去、还救得回来的那批。

传一个 list 给 `audit`，就往里追加每行的去向，**每行不多不少一条**。
⚠ `results` / `notify` 逐字段和不传 `audit` 时相同 —— `tests/order_monitor.py`
的 [3b] 正面钉着这一条。要改的是「看得见」，不是「怎么分类」：
那 68 家仍然不进多维表格、不播报（用户 2026-09-09 定的），只是工作台上看得见了。
"""
from __future__ import annotations

from datetime import datetime

from .excel import clean_uid, normalize_site, to_date, to_float
from names import owner_name


# 小额滞留判定阈值
STUCK_DAYS_THRESHOLD = 3      # 距首笔交易满 N 天，累计仍未上量(<$100)
STUCK_GROWTH_EPS = 0.01       # 较昨日 TPV 增长小于此值，视为"零增长/真停滞"

# 状态显示标签（群通知/本地存档/控制台用，去图标；notify 的 key 保持带图标不变）
# 「待激活」的上界（第 12 张票，2026-09-16 改的口径）。
# 原来 `days_open > 60` 的那 68 家整批静默丢弃（坑.md §2.17）；实测开通→首单的
# **75 分位就是 62 天**，那条 60 天的线正好切在分布中间，被切掉的一多半还救得回来。
# 现在 61~180 天进「待激活」（通知 + 表，单独一条消息、按周发），>180 天只入表。
PENDING_DAYS = 180
PENDING_REMARK = "🟡 60-180天待激活"
OVER_REMARK = "⏸ 开通>180天"


def get_remark_by_days(days_open):
    """开通天数对应的备注状态。
    注意：不含 ≤1 天档 —— 「新审核通过」单独由「通道反馈日期 == 报表日期」判定。"""
    if days_open <= 3:
        return "👀 3天内未出单"
    elif days_open <= 30:
        return "🔴 3-30天未出单"
    elif days_open <= 60:
        return "🟠 30-60天未出单"
    elif days_open <= PENDING_DAYS:
        return PENDING_REMARK
    return None


# 展示顺序：群通知、控制台、本地存档都按这个顺序列
# ⚠ **「待激活」不在这里。** 这是**日报**群通知和控制台的顺序，它按周发、单独一条消息，
#   混进来会改到现有那条日报的内容（第 12 张票要求一字不变）。它的顺序在 PENDING_ORDER。
DAILY_ORDER = ["✅ 新出单", "🧪 测试交易", "🐢 小额滞留", "🆕 新审核通过-待出单",
               "👀 3天内未出单", "🔴 3-30天未出单", "🟠 30-60天未出单"]
# 待激活那条**单独的**周消息（第 12 张票）
PENDING_ORDER = [PENDING_REMARK]

STATUS_LABEL = {
    "✅ 新出单": "新出单（今日累计TPV≥$100）",
    "🧪 测试交易": "测试交易（今日开始有成功交易且累计TPV<$100）",
    "🐢 小额滞留": "小额滞留（长期累计TPV<$100）",
    "🆕 新审核通过-待出单": "审核通过-待出单（通道已通过审批）",
    "👀 3天内未出单": "未出单·3天内",
    "🔴 3-30天未出单": "未出单·3-30天",
    "🟠 30-60天未出单": "未出单·30-60天",
    PENDING_REMARK: "待激活（通道通过 60-180 天仍未出单）",
    OVER_REMARK: "开通超 180 天仍未出单（只入表，不播报）",
}


# ---------------------------------------------------------------------------
# 去向（第十一轮；第 12 张票从十二档变成十三档）。
# **十三档，和下面十三个终点一一对应**，加起来必须等于报表行数。
#
# 为什么是十二档而不是把「未出单」再拆成三档：3天内 / 3-30 / 30-60 的落点一样、
# 排查动作也一样，拆开是给页面上那 7 档分类用的（备注留在 `备注` 字段里），
# 不是对账的维度。对账要回答的只有一句：这一行**去哪了**。

D_NEW_ORDER       = "新出单"
D_TEST_TXN        = "测试交易"
D_STUCK           = "小额滞留"
D_NEW_APPROVED    = "新审核通过"
D_NO_ORDER        = "未出单"          # 三个备注档合起来，备注留在条目里
D_KEEP_ORDERED    = "存量已出单"
D_KEEP_RAMP       = "小额爬坡"
D_CHANNEL_REVIEW  = "通道审核中"
D_CHANNEL_PENDING = "待提交通道"
D_DROP_SITE_EMPTY = "站点为空"
D_DROP_OLD        = "老商户排除"
# 第 12 张票：原来的 D_DROP_60（开通>60天，整批丢弃）拆成这两档。
# 「待激活」是**新增的一档通知**，「开通>180天」降级成「仅表」而不是丢弃。
D_PENDING         = "待激活"
D_OVER_180        = "开通>180天"

# 落点：这一行最后被谁看见了。
SINK_NOTIFY = "通知+表"    # 群通知 + BD 私聊 + 多维表格，人看得到
SINK_TABLE  = "仅表"       # 只写多维表格 —— 存量对齐用，没有人会主动去翻
SINK_DROP   = "丢弃"       # ⚠ 哪儿都没有。这一轮要让它在工作台上看得见

# 展示顺序。**十二档全部常驻，包括常年是 0 的那几档** ——
# 「站点为空」实测就是 0，而正因为它一直是 0，从来没人显示过它，
# 于是"这一档是 0"和"这一档我没在看"长得一模一样。
#
# ⚠ 顺带查出来的：这一档是 0 **不是因为没有空站点**，而是因为那条判断对真正的
#   空格子根本不成立（NaN → 字面量 "nan" → 非空）。口径这一轮不改，
#   但 `tests/order_monitor.py` 的 [3b] 两种写法各钉了一条，别把它当成"已经防住了"。
DISPOSITIONS = [
    D_NEW_ORDER, D_TEST_TXN, D_STUCK, D_NEW_APPROVED, D_NO_ORDER, D_PENDING,
    D_KEEP_ORDERED, D_KEEP_RAMP, D_CHANNEL_REVIEW, D_CHANNEL_PENDING, D_OVER_180,
    D_DROP_SITE_EMPTY, D_DROP_OLD,
]

DISPOSITION_SINK = {
    D_NEW_ORDER: SINK_NOTIFY,
    D_TEST_TXN: SINK_NOTIFY,
    D_STUCK: SINK_NOTIFY,
    D_NEW_APPROVED: SINK_NOTIFY,
    D_NO_ORDER: SINK_NOTIFY,
    D_PENDING: SINK_NOTIFY,          # 第 12 张票：从「丢弃」提到「通知+表」
    D_KEEP_ORDERED: SINK_TABLE,
    D_KEEP_RAMP: SINK_TABLE,
    D_CHANNEL_REVIEW: SINK_TABLE,
    D_CHANNEL_PENDING: SINK_TABLE,
    D_OVER_180: SINK_TABLE,          # 第 12 张票：从「丢弃」提到「仅表」
    D_DROP_SITE_EMPTY: SINK_DROP,
    D_DROP_OLD: SINK_DROP,
}

# 每档为什么会落到这儿。页面上每档点开时显示这句 —— 「丢弃」那三档尤其要说清楚，
# 不然看到的人第一反应是「这是 bug 吗」。
DISPOSITION_WHY = {
    D_NEW_ORDER: "今天累计 TPV 跨过 $100，昨天还没到",
    D_TEST_TXN: "今天首次产生成功交易，累计 TPV 仍 < $100",
    D_STUCK: "已试水但累计 < $100，距首笔满 3 天且较昨日零增长",
    D_NEW_APPROVED: "通道结果反馈日期 == 报表日期",
    D_NO_ORDER: "通道已通过、还没交易，按开通天数分档",
    D_KEEP_ORDERED: "昨天今天都 ≥ $100 的存量。跨过 $100 只发生一次，"
                    "不是事件所以不通知；整行照样写表，免得字段停在第一次出单那天",
    D_KEEP_RAMP: "有交易、既不是新试水也不算滞留（小额还在爬坡），同样只对齐字段不通知",
    D_CHANNEL_REVIEW: "没有交易活动、通道结果还没反馈，但已提交通道",
    D_CHANNEL_PENDING: "没有交易活动、通道结果还没反馈，也还没提交通道",
    D_DROP_SITE_EMPTY: "站点那一格全是空白字符 —— 唯一键（用户ID|站点）拼不出来，无法和昨天对比。"
                       "⚠ 只认「全空白」这一种写法：真正的空格子被 pandas 读成 NaN，"
                       "而 str(NaN) 是字面量 \"nan\"（非空），那行会带着假唯一键"
                       "『用户ID|nan』照常往下分类，落不到这一档",
    D_DROP_OLD: "首笔成功交易早于建站提交时间 —— 不属于这条漏斗，是故意排除的。"
                "可以不处理，但不能看不见",
    D_PENDING: "通道通过 60~180 天仍未出单。**第 12 张票新开的一档**（2026-09-16）："
               "原来这批整个静默丢弃，而开通→首单的 75 分位就是 62 天 —— "
               "那条 60 天的线正好切在分布中间。现在进表、也播报，"
               "但**单独一条消息、按周发**，不混进日报",
    D_OVER_180: "通道通过已超过 180 天仍未出单。**只入表不播报**："
                "过了 90 分位（252 天）那一带，催也催不动了，"
                "但账要对得齐 —— 不能像以前那样连表里都没有",
}


def _s(v):
    """报表格子 → 字符串。**空格子给空串，不给字面量 `"nan"`。**

    ⚠ pandas 把空格子读成 `NaN`，而 `str(NaN)` 是 `"nan"` —— **非空、truthy**。
      直接往台账里塞的话，页面上 `所属BD || '—'` 那种兜底全废，
      显示出来是一列 `nan`；「按 BD 筛」的下拉里还会多出一个叫 nan 的 BD。
      实测那份真实报表 392 行里 **291 行（74%）** 的所属BD 是空的，全中招。

      和「站点为空」那条 continue 走不通是**同一个根因**（见 DISPOSITION_WHY）——
      那边是判断失效，这边是显示出错，都是 `str(NaN)` 那四个字符干的。
    """
    if v is None:
        return ""
    sv = str(v).strip()
    # NaT 是 pandas 的空日期，同样会 str 成字面量
    return "" if sv.lower() in ("nan", "nat", "none") else sv


# 「未分配BD」这个名字只有一处出处：现在在 names.owner_name（第 03 张票抽到 feishu_send，2026-09-18 再搬进口径层），
# 这里是它的别名 —— 群消息、私聊分组、台账三处 import 的还是这个名字，一个调用方都没断。
# 那边的 docstring 记着原来那两条：⚠ 唯一出处、⚠ 要认得字面量 "nan"（踩过：群消息 127 行 `BD:nan`）。
clean_bd_name = owner_name


def _mark(audit, pos, row, disp, **extra):
    """记下这一行的去向。**十二个终点各插一次，每行不多不少一条。**

    ⚠ 只观测不改口径 —— 这个函数除了往 `audit` 里 append 什么都不做，
      调用点一律紧贴着原来那句 `continue` / `results.append`，不动任何判断。
    """
    if audit is None:
        return
    e = {
        # 行号是**位置下标**，不是 DataFrame 的 index —— report.save_ledger 要拿它
        # 回 df_today.iloc[行号] 去取六列耗时，两边必须是同一种下标。
        "行号": pos,
        # 这四格一律走 _s()：空格子给空串，不给字面量 "nan"（见上面那段）
        "用户ID": clean_uid(row.get("用户ID", "")),
        "商户名称": _s(row.get("商户名称")),
        "站点": _s(row.get("站点")),
        "所属BD": _s(row.get("所属BD")),
        "去向": disp,
        "落点": DISPOSITION_SINK[disp],
        "累计TPV_USD": None,
        "开通天数": None,
        "备注": "",
    }
    e.update(extra)
    audit.append(e)


def classify_from_excel(df_today, df_yesterday, report_date_str, audit=None):
    """纯Excel对比，返回分类结果。唯一键=用户ID+站点（避免同站点多商户冲突）"""
    report_date = datetime.strptime(report_date_str, "%Y-%m-%d")

    # 昨天数据（key = 用户ID|站点）
    yesterday_map = {}
    for _, row in df_yesterday.iterrows():
        sk = normalize_site(row.get("站点", ""))
        uid_y = clean_uid(row.get("用户ID", ""))
        if sk:
            yesterday_map[f"{uid_y}|{sk}"] = {
                "tpv": to_float(row.get("累计TPV_USD", 0)),
                "first_txn": to_date(row.get("第一笔成功交易时间")),
            }

    results = []
    notify = {}

    # enumerate 取**位置下标**：save_ledger 要拿它回 df_today.iloc[pos] 取六列耗时。
    # 不用 iterrows 给的 index —— read_excel_sheet2 有一条分支会 reset_index，
    # 另一条不会，两种下标混着用迟早对不上号。
    for pos, (_, row) in enumerate(df_today.iterrows()):
        site_raw = str(row.get("站点", "")).strip()
        site_norm = normalize_site(site_raw)
        if not site_norm:
            _mark(audit, pos, row, D_DROP_SITE_EMPTY)
            continue

        uid = clean_uid(row.get("用户ID", ""))
        match_key = f"{uid}|{site_norm}"   # 唯一键

        tpv_today = to_float(row.get("累计TPV_USD", 0))
        first_txn = to_date(row.get("第一笔成功交易时间"))
        site_submit = to_date(row.get("站点_商户提交时间"))
        channel_fb = to_date(row.get("通道结果反馈时间"))
        submit_ch = to_date(row.get("提交通道时间"))

        name = str(row.get("商户名称", "")).strip()
        bd = str(row.get("所属BD", "")).strip()

        yd = yesterday_map.get(match_key, {})
        tpv_yd = yd.get("tpv", 0.0)
        first_txn_yd = yd.get("first_txn")

        # 老商户排除
        if first_txn and site_submit and first_txn < site_submit:
            _mark(audit, pos, row, D_DROP_OLD, 累计TPV_USD=tpv_today)
            continue

        # 新出单：今天TPV>=100 且 昨天<100
        if tpv_today >= 100:
            if tpv_yd < 100:
                results.append({"site_key": match_key, "row": row,
                                "action": "new_order", "status": "已出单", "remark": "",
                                "order_date": report_date})
                notify.setdefault("✅ 新出单", []).append(
                    (uid, name, site_raw, bd, channel_fb, first_txn, tpv_today, "✅ 新出单"))
                _mark(audit, pos, row, D_NEW_ORDER, 累计TPV_USD=tpv_today, 备注="✅ 新出单")
            else:
                # 存量已出单。**原来这里直接 continue，是「漏一天就永久少一批商户」的确切成因**：
                # 跨过 $100 只发生一次、只在那一天被记录，漏跑那天之后
                # tpv_today 和 tpv_yd 都 ≥100，这家商户再也不会进入 results。
                # 顺带还有一个不靠漏跑也存在的毛病：已出单商户的所有字段
                # （TPV、BD、站点信息、各种耗时）停在第一次出单那天的快照。
                # 现在照样带整行进 results（表每天全量对齐），但**不进 notify** ——
                # 存量不是事件，没什么可通知的。
                results.append({"site_key": match_key, "row": row,
                                "action": "keep", "status": "已出单", "remark": ""})
                _mark(audit, pos, row, D_KEEP_ORDERED, 累计TPV_USD=tpv_today)
            continue

        # 测试交易 / 小额滞留：TPV<100 但有交易活动
        if (first_txn is not None) or (tpv_today > 0):
            if first_txn_yd is None:
                # 今天才首次产生交易 → 测试交易
                results.append({"site_key": match_key, "row": row,
                                "action": "test_txn", "status": "测试交易", "remark": ""})
                notify.setdefault("🧪 测试交易", []).append(
                    (uid, name, site_raw, bd, channel_fb, first_txn, tpv_today, "🧪 测试交易"))
                _mark(audit, pos, row, D_TEST_TXN, 累计TPV_USD=tpv_today, 备注="🧪 测试交易")
            else:
                # 已试水但累计仍<100：距首笔满N天 且 较昨日零增长 → 小额滞留
                hit = False
                if first_txn is not None:
                    stuck_days = (report_date.date() - first_txn.date()).days
                    growth = tpv_today - tpv_yd
                    if stuck_days >= STUCK_DAYS_THRESHOLD and abs(growth) < STUCK_GROWTH_EPS:
                        results.append({"site_key": match_key, "row": row,
                                        "action": "stuck", "status": "小额滞留", "remark": ""})
                        notify.setdefault("🐢 小额滞留", []).append(
                            (uid, name, site_raw, bd, channel_fb, first_txn, tpv_today, "🐢 小额滞留"))
                        _mark(audit, pos, row, D_STUCK, 累计TPV_USD=tpv_today, 备注="🐢 小额滞留")
                        hit = True
                if not hit:
                    # 有交易、但今天既不是新试水也不算滞留（小额还在爬坡）。
                    # 原来也是直接 continue，表里那行就停在它上次被分类那天。
                    # 同样只对齐字段、不通知。
                    results.append({"site_key": match_key, "row": row,
                                    "action": "keep", "status": "测试交易", "remark": ""})
                    _mark(audit, pos, row, D_KEEP_RAMP, 累计TPV_USD=tpv_today)
            continue

        # 无交易活动 + 通道反馈为空 → 通道审核中/待提交通道
        if channel_fb is None:
            status = "通道审核中" if submit_ch else "待提交通道"
            results.append({"site_key": match_key, "row": row,
                            "action": "set_status", "status": status, "remark": ""})
            _mark(audit, pos, row,
                  D_CHANNEL_REVIEW if submit_ch else D_CHANNEL_PENDING,
                  累计TPV_USD=tpv_today)
            continue

        # 通道已通过，开通天数
        days_open = (report_date.date() - channel_fb.date()).days

        # 新审核通过 = 通道反馈日期 == 报表日期
        if channel_fb.date() == report_date.date():
            status = "🆕 新审核通过-待出单"
            results.append({"site_key": match_key, "row": row,
                            "action": "new_approved", "status": status, "remark": ""})
            notify.setdefault(status, []).append(
                (uid, name, site_raw, bd, channel_fb, first_txn, tpv_today, status))
            _mark(audit, pos, row, D_NEW_APPROVED,
                  累计TPV_USD=tpv_today, 开通天数=days_open, 备注=status)
            continue

        # 存量未出单。⚠ **第 12 张票改的就是这一段**（2026-09-16，坑.md §2.17.5）：
        #   原来 `days_open > 60` 整批静默丢弃（实测 68 行 / 392），现在拆成两档 ——
        #   61~180 天「待激活」进表也播报（单独一条周消息），>180 天只入表。
        remark = get_remark_by_days(days_open)
        if remark is None:
            # >180 天：**只入表，不进 notify**。写表是为了账对得齐 ——
            # 以前连表里都没有，对账时那 68 家凭空消失。
            results.append({"site_key": match_key, "row": row,
                            "action": "update_remark", "status": "未出单", "remark": OVER_REMARK})
            _mark(audit, pos, row, D_OVER_180,
                  累计TPV_USD=tpv_today, 开通天数=days_open, 备注=OVER_REMARK)
            continue
        results.append({"site_key": match_key, "row": row,
                        "action": "update_remark", "status": "未出单", "remark": remark})
        notify.setdefault(remark, []).append(
            (uid, name, site_raw, bd, channel_fb, first_txn, tpv_today, remark))
        # ⚠ 待激活是**单独一档去向**，不并进「未出单」：并了的话对账表上看不出
        #   这一轮到底把多少家从「丢弃」捞了回来，而那正是这张票要回答的那个数。
        _mark(audit, pos, row, D_PENDING if remark == PENDING_REMARK else D_NO_ORDER,
              累计TPV_USD=tpv_today, 开通天数=days_open, 备注=remark)

    return results, notify
