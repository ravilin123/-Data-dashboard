"""交易量每日群播报的文本（纯函数）。

    python tests/trade_msg.py        # 零依赖

钉的是四条**改坏了长得和对的一模一样**的性质：

  [2] 算不出来的数**必须是「—」不是 0**（坑.md §2.12）。台账缺前一天时环比算不出来，
      写成 `0%` 的话读的人会当成「昨天和前天一样」。
  [2b] 四舍五入到 0 的也不许写成 `0%`：实测 -0.48% 和 +0.4% 都会变成 `0%` / `+0%`，
      而它们不是持平。这时候多给一位小数，**方向也保住**。
  [3] 直签人那一维里 `代理商：xxx` / `未分配BD` **不许合并也不许藏**：
      实测它们占掉 43% 的 TPV，藏了之后各行加起来对不上头条那个数，
      而「对不上」的样子和「算错了」一模一样。截断了要补一行「其余」。
  [4] 群消息里**不写口径、不出现「工作台」三个字**（§2.5 §2.6）。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from churn import trade_msg as M  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


# 形状照 churn.overview.build() 的真实输出（2026-08-19，78 行，实测抄来的）
OV = {
    "ok": True, "date": "2026-08-19", "gap": [],
    "kpi": {"tpv": {"value": 358447.0, "prev": 335055.0, "dod": 0.069815,
                    "avg7": 293964.29, "avg7_days": 7, "vs_avg7": 0.219356},
            "orders": {"value": 4779, "prev": 4802, "dod": -0.00479,
                       "avg7": 4523.43, "avg7_days": 7, "vs_avg7": 0.056499},
            "sites": {"value": 78, "prev": 72, "dod": 0.083333,
                      "avg7": 63.29, "avg7_days": 7, "vs_avg7": 0.232422}},
    "by": {"接入模式": [{"name": "API直连", "tpv": 153688.0, "orders": 1774, "sites": 16, "share": 0.428761},
                        {"name": "标准收银台", "tpv": 107285.0, "orders": 1675, "sites": 52, "share": 0.299305},
                        {"name": "Element", "tpv": 94685.0, "orders": 1296, "sites": 4, "share": 0.264153},
                        {"name": "shopyy", "tpv": 2789.0, "orders": 34, "sites": 6, "share": 0.007781}],
           "直签人": [{"name": "赵娜", "tpv": 143962.0, "orders": 2498, "sites": 10, "share": 0.401627},
                      {"name": "代理商：磐嶽有限公司", "tpv": 128689.0, "orders": 1545, "sites": 6, "share": 0.359018},
                      {"name": "未分配BD", "tpv": 27268.0, "orders": 192, "sites": 16, "share": 0.076073},
                      {"name": "吴鑫彪", "tpv": 6089.0, "orders": 61, "sites": 10, "share": 0.016988},
                      {"name": "丁炜炯", "tpv": 3000.0, "orders": 20, "sites": 3, "share": 0.00837},
                      {"name": "高雅静", "tpv": 2000.0, "orders": 10, "sites": 1, "share": 0.00558},
                      {"name": "朱佳吉", "tpv": 1500.0, "orders": 8, "sites": 1, "share": 0.004185}]},
    "top": [{"用户ID": "1828351428978479106", "商户名称": "速飛公司", "直签人": "赵娜",
             "tpv": 89942.0, "orders": 1265, "站点数": 1, "share": 0.250921,
             "prev": 73095.0, "dod": 0.230481},
            {"用户ID": "2", "商户名称": "乙商户", "直签人": "未分配BD",
             "tpv": 1000.0, "orders": 3, "站点数": 2, "share": 0.0028,
             "prev": None, "dod": None}],
}

print("[1] 头条：三个数 + 环比")
t = M.group_text(OV)
check("★ 总额写成 $358,447 不是 358447.0", "$358,447" in t, t[:200])
check("笔数带千分位", "4,779" in t, t[:200])
check("活跃站点数在", "78" in t, t[:200])
check("★ 环比带 + 号（涨了要看得出是涨）", "+7%" in t, t[:200])

print("\n[2] ★ 算不出来写「—」，不写 0")
no_prev = {**OV, "kpi": {**OV["kpi"], "tpv": {**OV["kpi"]["tpv"], "prev": None, "dod": None}}}
t2 = M.group_text(no_prev)
head2 = t2.split("\n")[1]
check("★ 环比算不出来时写「—」", "—" in head2, head2)
check("★ 而且不写成 0%（会被读成「和前天一样」）", "0%" not in head2, head2)
empty = {**OV, "kpi": {**OV["kpi"], "tpv": {"value": None, "prev": None, "dod": None,
                                            "avg7": None, "avg7_days": 0, "vs_avg7": None}}}
check("★ 当天一个数都没有 → 整条不发（返回空串，让调用方记「没跑」不是失败）",
      M.group_text(empty) == "", repr(M.group_text(empty)[:80]))

print("\n[2b] ★ 四舍五入到 0 的不许写成 0%（它不是持平）")
check("★ -0.48% 不写成 0%", M.pct(-0.00479) != "0%" and M.pct(-0.00479) != "-0%", M.pct(-0.00479))
check("★ 而且方向还在（是跌的）", M.pct(-0.00479).startswith("-"), M.pct(-0.00479))
check("★ +0.4% 同理", M.pct(0.004).startswith("+") and M.pct(0.004) != "+0%", M.pct(0.004))
check("★ 真的一点没动才写 0%", M.pct(0.0) == "0%", M.pct(0.0))
check("★ 但 1% 以上照旧取整（别满屏小数）", M.pct(0.069815) == "+7%", M.pct(0.069815))
check("★ 笔数那条在正文里也不是 0%",
      "0%" not in t.split("\n")[2].replace("+0.5%", "").replace("-0.5%", ""), t.split("\n")[2])

print("\n[3] ★ 直签人：代理商 / 未分配 不合并也不藏，截断了要交代")
check("★ 段标题是「直签人 / 代理商」不是「BD」",
      "直签人" in t and "BD 排行" not in t and "BD排行" not in t, t[:400])
check("★ 代理商那行在", "代理商：磐嶽有限公司" in t, t)
check("★ 未分配BD 那行也在（占 7.6%，藏了就对不上头条）", "未分配BD" in t, t)
check("★ 只列前 6 名（第 7 个不出现）", "朱佳吉" not in t, t)
check("★ 但补了一行「其余」，把切掉的那些交代掉（不然各行加不到 100%）",
      "其余 1 家" in t, [x for x in t.split("\n") if "其余" in x])
check("★ 「其余」那行带金额", "$1,500" in t, [x for x in t.split("\n") if "其余" in x])
# 一个都没切的时候不该冒出一行「其余 0 家」
short = {**OV, "by": {**OV["by"], "直签人": OV["by"]["直签人"][:2]}}
check("★ 没切的时候不出现「其余」（写「其余 0 家」比不写还糟）",
      "其余" not in M.group_text(short).split("■ 直签人")[1], M.group_text(short).split("■ 直签人")[1][:200])

print("\n[4] ★ 群消息不写口径、不出现「工作台」")
for w in ["工作台", "口径", "阈值", "前 7 日均值", "30 天窗口", "vs_avg7", "avg7"]:
    check(f"不出现「{w}」", w not in t, t[:300])
check("★ 没有字面量 nan", "nan" not in t.lower(), t)

print("\n[5] Top N 商户")
check("★ 头名的商户名在", "速飛公司" in t, t[:400])
check("★ 带它的环比", "+23%" in t, t[:400])
check("★ 没有前一天数据的那家写「—」", "乙商户" in t and "环比 —" in t, t[:600])
one = M.group_text(OV, {"top_n": 1})
check("★ top_n 能截断", "乙商户" not in one.split("■ 接入模式")[0], one.split("■ 接入模式")[0])
check("★ 截断了也补「其余」", "其余 1 家" in one.split("■ 接入模式")[0],
      one.split("■ 接入模式")[0])

print("\n[6] 格式化本身")
check("money 千分位", M.money(358447) == "$358,447", M.money(358447))
check("money 小额给两位小数", M.money(12.5) == "$12.50", M.money(12.5))
check("money 0", M.money(0) == "$0", M.money(0))
check("★ money(None) → 「—」不写 $0", M.money(None) == "—", M.money(None))
check("★ pct(None) → —", M.pct(None) == "—", M.pct(None))
check("num(None) → —", M.num(None) == "—", M.num(None))
check("md 只留月日", M.md("2026-08-19") == "08-19", M.md("2026-08-19"))

print("\n[7] 默认档")
import names  # noqa: E402
check("★ 默认是 silent（上线先跑几天）", M.DEFAULTS["mode"] == "silent", M.DEFAULTS["mode"])
check("★ 而且这个档在 names.MODES 里（feishu_send.MODES 是同一个对象）", M.DEFAULTS["mode"] in names.MODES, names.MODES)

print("\n" + ("失败 %d 项: %s" % (len(fails), fails) if fails else "全部通过"))
sys.exit(1 if fails else 0)
