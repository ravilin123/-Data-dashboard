# -*- coding: utf-8 -*-
"""第五步：把结果存下来。不依赖网络，永远最后执行。

两份：
  · txt —— 人看的，原脚本就有
  · json —— 转化率工具读的（B15）。出单监控每天已经点名了「哪些商户刚出单 /
    刚审核通过 / 在滞留」，那批正是转化率那边「待观察商户」要盯的人，
    两个工具没必要各自再判一遍。
"""
from __future__ import annotations

import json
import os
from datetime import datetime

from .classify import (DISPOSITION_SINK, DISPOSITION_WHY, DISPOSITIONS, SINK_DROP,
                       SINK_NOTIFY, SINK_TABLE, STATUS_LABEL)
from .classify import _s          # 空格子 → 空串，不给字面量 "nan"（同一个函数，别再抄一份）
from .classify import clean_bd_name   # 「未分配BD」的唯一出处，和群通知/私聊同一个
from .excel import NUMBER_FIELDS, to_date

# 结果 json 的文件名。转化率页面经 /api/order-monitor/latest 读它，两边只认这一个名字。
JSON_NAME = "出单监控结果_%s.json"

# 台账 json 的文件名。**另存一个文件，不往上面那份里塞。**
#   · 上面那份是转化率页「待观察商户」在读的（B15），往里塞 392 行会拖慢那个页面
#   · 而且改错了会连累已经在跑的东西 —— 台账是这一轮的新玩意儿，不该有这个风险
LEDGER_NAME = "出单监控台账_%s.json"

# 报表里已经有的六列耗时。**不自己算。**
# ⚠ 单位是**小时，不含节假日** —— 实测某行提交到首笔 67.4 个自然日，
#   `站点_上线时长` 给 1176.32（÷24 = 49 天，差的 18 天是周末）。
#   自己拿日期相减会偏大三成，而且偏得很像真的。
#   ⚠ **从 NUMBER_FIELDS 派生，不再抄一份列名。** 这个仓库已经吃过两次
#     「两处列名各写一份、上游一改就静默漂移」的亏（见 CLAUDE.md §2.7）。
#     第十一轮的计划文档里这六列写的是「支付方式_风控审核耗时」，
#     而报表和 NUMBER_FIELDS 里是「支付方式_网站审核耗时」—— 正是这种漂移，
#     照计划抄的话那一列在台账里会永远是 None，而且没人看得出来。
DURATION_COLS = [c for c in NUMBER_FIELDS if c != "累计TPV_USD"]

# 报表上的**分类属性**列。不参与分类口径，只用来在页面上分组和筛选。
#
# `建议进件通道` 是第十一轮做完之后补的：那一列以前一次都没读过，
# 而实测它里面有东西 —— 通道审核耗时 WORLDPAY 中位 **0.08h**（5 分钟）、
# FISERV **99.62h**（4 天），差一千多倍，三分之二的 FISERV 单子卡超 24 小时。
# 那是我方的处理速度，不受"商户好坏"影响，是条能直接去催的线索。
#
# ⚠ 同一张表里还有两列**永远是常量**（`站点_审核结果` / `支付方式_审核结果`
#   实测 392 行全是 APPROVED —— 被拒的在第三张 sheet，全 REJECT）。
#   那两列不带进来是对的；真要用是当"上游口径变了"的哨兵，那是另一件事。
ATTR_COLS = ["建议进件通道"]

# 关键日期。台账里写成 YYYY-MM-DD，json 里不要 datetime 对象。
#
# ⚠ 这六个不是随便挑的：**每一列耗时都要有它对应的「终点日期」**，
#   页面才分得开「0 = 还没走到这一步」和「0 = 真的秒过」（见 save_ledger 的说明）。
#   对应关系在 static/js/order_monitor/analyze.js 的 END_DATE_OF 里，改这里要一起改。
#   六列耗时各要一个**起点**和一个**终点**，加起来就是下面这七个日期。
#   起点也少不了：终点早于起点时（首笔交易早于建站提交、或早于通道反馈）
#   上游算出来是负数，一律写 0 —— 那个 0 既不是"秒过"也不是"没走到"，
#   是**算不出来**，混进分布里会把中位数往下拽。实测这种行 站点_上线时长 有 6 行、
#   集成耗时有 41 行。
DATE_COLS = ["站点_商户提交时间", "站点_风控审核时间",
             "支付方式_商户提交时间", "支付方式_风控审核时间",
             "提交通道时间", "通道结果反馈时间", "第一笔成功交易时间"]


def save_local_report(notify, report_date_str, output_dir):
    output_file = os.path.join(output_dir, f"出单监控结果_{report_date_str}.txt")
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(f"商户出单监控结果 - {report_date_str}\n")
        f.write(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write("=" * 60 + "\n\n")
        order = ["✅ 新出单", "🧪 测试交易", "🐢 小额滞留", "🆕 新审核通过-待出单",
                 "👀 3天内未出单", "🔴 3-30天未出单", "🟠 30-60天未出单"]
        for cat in order:
            items = notify.get(cat, [])
            if not items:
                continue
            f.write(f"\n【{STATUS_LABEL.get(cat, cat)}】({len(items)}个)\n")
            f.write("-" * 40 + "\n")
            for uid, name, site, bd, ch_time, first_txn, tpv, _ in items:
                ch_str = ch_time.strftime('%Y-%m-%d') if ch_time else "-"
                f_str = first_txn.strftime('%Y-%m-%d') if first_txn else "-"
                f.write(f"  ID:{uid} | {name} | {site} | BD:{clean_bd_name(bd)}\n")
                f.write(f"    通道通过:{ch_str} | 首笔:{f_str} | TPV:${tpv:,.2f}\n")
    print(f"💾 结果已保存: {output_file}")


def _d(x):
    """datetime → YYYY-MM-DD；空值给 None。json 里不要 datetime 对象。"""
    return x.strftime("%Y-%m-%d") if x else None


def save_json(notify, report_date_str, output_dir, audit=None):
    """把分类结果存成 json，给转化率工具读（B15）。

    ⚠ notify 的每一项是**位置元组** `(uid, name, site, bd, ch_time, first_txn, tpv, label)`
      —— 这是原脚本的形状，第六轮 R6 记着「加一个字段就全线崩，该换 dataclass」。
      在换掉之前，这里是第三个按位置解包的地方，改那个元组时记得连这里一起改。

    ⚠ **不写归一化后的站点 key。** 转化率那边匹配只认 `用户ID` ——
      站点归一化在 Python（normalize_site）和 JS（shortSite）各有一份实现，
      一旦漂移就是静默匹配不上，而这种 bug 这个仓库已经吃过两次。
      用户ID 是 19 位整数，两边格式一致，没有归一化这回事。
      站点仍然写进去，用来显示和人工核对。

    ⚠ **第十一轮只往这份里加了一个 `audit_counts`（三个落点的计数，几十字节）**，
      别的一个字段都没动。整本台账另存 `出单监控台账_*.json`（见 `save_ledger`）：
      这份是转化率页在读的，往里塞几百行会拖慢那个页面，
      而且改错了会连累已经在跑的东西。
      不传 `audit` 时连 `audit_counts` 都不加 —— 老行为逐字节不变。
    """
    out = []
    for bucket, items in (notify or {}).items():
        for uid, name, site, bd, ch_time, first_txn, tpv, _label in items:
            out.append({
                "用户ID": str(uid), "商户名称": name, "站点": site, "所属BD": bd,
                "分类": bucket, "分类说明": STATUS_LABEL.get(bucket, bucket),
                "累计TPV_USD": tpv,
                "通道通过日期": _d(ch_time), "首笔成功交易日期": _d(first_txn),
            })
    path = os.path.join(output_dir, JSON_NAME % report_date_str)
    payload = {"date": report_date_str,
               "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
               "counts": {k: len(v) for k, v in (notify or {}).items()},
               "merchants": out}
    if audit is not None:
        # 只是三个数，给「有台账的日期列表」那个接口当索引用 ——
        # 不必为了知道"这天丢了多少行"去读整本台账
        c = {SINK_NOTIFY: 0, SINK_TABLE: 0, SINK_DROP: 0}
        for e in audit:
            c[e["落点"]] = c.get(e["落点"], 0) + 1
        payload["audit_counts"] = c
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"💾 结果已保存: {path}")
    return path


# ---------------------------------------------------------------------------
# 台账（第十一轮）

def _num(v):
    """报表里的数值格子 → float / None。

    ⚠ **缺列、空格子给 None，但报表里真实的 0 原样保留。**
      拿真实报表核过：这六列**一个空格子都没有**（392/392 全是数值），
      上游用 `0` 表达「还没走到这一步」—— 而 `0` 同时也可能是真的秒过。
      两者靠**终点时间戳**分辨（明细里那四个关键日期就是给这个用的）：
          站点_上线时长 == 0 的 223 行里，217 行没有第一笔成功交易时间（真的还在路上），
          6 行有（那是老商户排除那批，首笔早于建站提交，上游算出来是负数才写 0）；
          通道审核耗时 == 0 的 105 行里，100 行没有通道结果反馈时间，
          5 行有 —— 那 5 行实际是 50 秒左右，四舍五入成了 0，是真的秒过。
      **这一层不做那个判断，只如实转录报表。** 判断在页面的纯函数层
      （`static/js/order_monitor/analyze.js`），那边有用例钉着 ——
      在这里替它判掉的话，「0 是秒过」和「0 是没走到」就再也分不开了。
    """
    if v is None:
        return None
    try:
        import math
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _reject_rows(df):
    """被拒站点表 → 一行一个 dict。列名原样带出来，不改名、不挑列。"""
    out = []
    for _, r in df.iterrows():
        row = {}
        for c in df.columns:
            v = r.get(c)
            if v is None:
                row[str(c)] = None
                continue
            sv = str(v).strip()
            row[str(c)] = None if sv in ("", "nan", "NaT") else sv
        out.append(row)
    return out


def _reject_key(row):
    """被拒站点的唯一键。用户ID + 站点 —— 同一个商户可以被拒多个站点。"""
    return f"{row.get('用户ID') or ''}|{(row.get('站点') or '').strip().lower()}"


# `run_pipeline` 的 done 键 → 台账里那一行怎么写。
# ⚠ **「没跑」和「失败」必须是两个词。** done 里没有这个键 = mode 决定了根本不走
#   这一步；done[键] is False = 试了、失败了。混成一个「否」的话，
#   silent 的正常结果和 both 的全线失败长得一模一样（同 §2.12 那条）。
_SEND_STEPS = [("webhook", "群通知"), ("dm", "BD 私聊"), ("bitable", "多维表格")]


def _run_block(done):
    """把 run_pipeline 返回的 done 整理成台账里那一小块。done 为空就返回 None。"""
    if not done:
        return None
    # ⚠ **「没跑」有两个原因，别写成同一个词**：
    #   mode 决定不走这一步（群通知/私聊），还是 token 根本没换到
    #   （多维表格压根不受 mode 管，它「没跑」只可能是后者）。
    #   写成一样的话，人会去翻 mode 配置，而真正该查的是飞书凭据。
    #
    # ⚠ **`发送` 是个数组不是 dict。** 工作台的 Flask 开着 `app.json.sort_keys`，
    #   dict 会被重排成字典序 —— 实测就排成了「BD 私聊 / 多维表格 / 群通知」，
    #   而且没有任何报错，页面上只是顺序看着"随便排的"（CLAUDE.md §2.18.5）。
    tok = done.get("token")
    send = []
    for key, label in _SEND_STEPS:
        if key in done:
            r = "成功" if done[key] else "失败"
        elif tok is False and key in ("dm", "bitable"):
            r = "没跑（token 没换到）"
        else:
            r = "没跑"                    # mode 决定不走这一步
        send.append({"步骤": label, "结果": r})
    return {"mode": done.get("mode") or "", "发送": send,
            "跑完于": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}


def save_ledger(df_today, audit, reject_df, reject_msg, report_date_str, output_dir,
                done=None):
    """把「这份报表的每一行去哪了」存成台账 json。

    **另存一个文件**（`出单监控台账_YYYY-MM-DD.json`），不动 `save_json` 那份 ——
    那份是转化率页在读的（B15），往里塞几百行会拖慢它，改错了还会连累已经在跑的东西。

    形状：
        { date, generated_at,
          对账: {去向: 行数},  落点: {通知+表/仅表/丢弃: 行数},  总行数,
          去向说明: {去向: 为什么落到这儿},
          明细: [ …audit 每行 + 该行的六列耗时和关键日期… ],
          被拒站点: {行数, 无BD行数, 当日新增, 明细, 读取失败原因, 对比说明} }

    ⚠ 十二档和三个落点**全部常驻，包括 0 的档** —— 0 和「我没在看这一档」
      在页面上长得一模一样，而「站点为空」实测常年就是 0。
    """
    # ---- 对账：十二档 + 三个落点，全部常驻 ----
    tally = {d: 0 for d in DISPOSITIONS}
    sinks = {SINK_NOTIFY: 0, SINK_TABLE: 0, SINK_DROP: 0}
    for e in audit or []:
        tally[e["去向"]] = tally.get(e["去向"], 0) + 1
        sinks[e["落点"]] = sinks.get(e["落点"], 0) + 1

    # ---- 明细：audit 每行 + 该行的六列耗时和关键日期 ----
    # 用 `行号` 回 df_today.iloc[] 取 —— audit 那边记的就是位置下标（见 classify._mark）。
    detail = []
    n_rows = len(df_today)
    for e in audit or []:
        item = dict(e)
        pos = e.get("行号")
        row = df_today.iloc[pos] if isinstance(pos, int) and 0 <= pos < n_rows else None
        for c in DURATION_COLS:
            item[c] = _num(row.get(c)) if row is not None else None
        for c in ATTR_COLS:
            item[c] = _s(row.get(c)) if row is not None else ""
        for c in DATE_COLS:
            d = to_date(row.get(c)) if row is not None else None
            # 键名去掉「时间」改成「日期」—— 台账里存的是 YYYY-MM-DD，没有时分秒，
            # 沿用「时间」会让读的人以为丢了精度
            item[c.replace("时间", "日期")] = _d(d)
        detail.append(item)

    # ---- 被拒站点 ----
    rej = {"行数": None, "无BD行数": None, "当日新增": None,
           "明细": [], "读取失败原因": reject_msg or "", "对比说明": ""}
    if reject_df is not None:
        rows = _reject_rows(reject_df)
        rej["行数"] = len(rows)
        # 511 / 711 行没有所属 BD —— 没人认领的那批正是这张表最值钱的部分，
        # 页面上要单独一块，所以这里先把数算出来
        rej["无BD行数"] = sum(1 for r in rows if not (r.get("所属BD") or "").strip())
        rej["明细"] = rows
        # 「当日新增」= 和前一天台账里的被拒站点集合做差。
        # ⚠ 这张表两天 +13 −2，**不是纯追加** —— 拿行数相减会算错。
        prev = _prev_ledger(output_dir, report_date_str)
        if prev is None:
            rej["对比说明"] = "首份台账，没有前一天可比"
        else:
            old_keys = {_reject_key(r) for r in (prev.get("被拒站点") or {}).get("明细", [])}
            if not old_keys and (prev.get("被拒站点") or {}).get("行数") in (None, 0):
                rej["对比说明"] = f"前一天（{prev.get('date')}）没读到被拒站点，不做对比"
            else:
                new_rows = [r for r in rows if _reject_key(r) not in old_keys]
                rej["当日新增"] = len(new_rows)
                rej["新增明细"] = new_rows
                rej["对比说明"] = f"对比 {prev.get('date')} 的台账"

    payload = {
        "date": report_date_str,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "总行数": n_rows,
        # ⚠ **顺序单独存一个数组，别指望 `对账` 那个 dict 的键序。**
        #   工作台的 Flask 开着 `app.json.sort_keys=True`，jsonify 会把所有 dict 的键
        #   重排成字典序 —— 台账文件里明明是 DISPOSITIONS 的顺序，
        #   经过接口出去就变成「存量已出单、小额滞留、小额爬坡…」，
        #   而且**没有任何报错**，页面上只是那十二行的次序不对，看起来像是"随便排的"。
        #   list 不会被 sort_keys 动，所以顺序走这两个数组。
        "去向顺序": list(DISPOSITIONS),
        "落点顺序": [SINK_NOTIFY, SINK_TABLE, SINK_DROP],
        "对账": tally,
        "落点": sinks,
        "去向说明": {d: DISPOSITION_WHY.get(d, "") for d in DISPOSITIONS},
        "落点归属": {d: DISPOSITION_SINK[d] for d in DISPOSITIONS},
        "属性列": ATTR_COLS,
        "耗时列": DURATION_COLS,
        "耗时单位": "小时 · 不含节假日",
        # ⚠ 界面上要把这句原样标出来。两个坑各占一半：
        #   · 单位是小时不是天，而且**不含节假日** —— 实测某行提交到首笔 67.4 个自然日，
        #     报表给 1176.32（÷24 = 49 天，差的 18 天是周末）。自己相减会偏大三成。
        #   · `0` 不是「零耗时」，多半是「还没走到这一步」；到底是哪种看终点时间戳。
        "耗时口径": "报表原值，单位小时、不含节假日。0 多半表示还没走到这一步，"
                    "也可能是真的秒过 —— 看对应的终点日期有没有值",
        "明细": detail,
        "被拒站点": rej,
    }
    # ⚠ **done 为空时这一块整个不加** —— 不传和「传了但什么都没跑」是两回事，
    #   而且老台账里本来就没有这一块，凭空多一个空壳会让页面以为它有话说。
    run = _run_block(done)
    if run:
        payload["本次运行"] = run
    path = os.path.join(output_dir, LEDGER_NAME % report_date_str)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"💾 台账已保存: {path}")
    return path


def _prev_ledger(output_dir, report_date_str):
    """前一份台账（按文件名日期取比今天早的最近一份）。没有就返回 None。

    不硬取「昨天」：漏跑一天很常见，取最近一份比"昨天那份不存在所以不比"有用。
    对比说明里会写出实际比的是哪一天。
    """
    try:
        names = sorted(n for n in os.listdir(output_dir)
                       if n.startswith("出单监控台账_") and n.endswith(".json"))
    except OSError:
        return None
    prefix = LEDGER_NAME % report_date_str
    older = [n for n in names if n < prefix]
    if not older:
        return None
    try:
        with open(os.path.join(output_dir, older[-1]), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        # 前一份坏了不该让今天这份写不出来 —— 对比是附加信息，台账本身才是主体
        return None
