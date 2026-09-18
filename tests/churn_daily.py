"""商户流失**日报汇总**（第 05 张票之后新加的那份）。

    python tests/churn_daily.py        # 零依赖

原来群里发的是**逐条告警**（沉默跃迁 + 掉量推送档，前 N 那道闸）。用户要的是
**每天一份汇总** —— 三行 + 前几家，形状照老板周报（那份他已经在读了）。

钉的是四条**改坏了长得和对的一模一样**的性质：

  [2] **门槛是 30 天 TPV，不是这次掉了多少。** 实测 2026-08-22：36 条命中里
      30 天 TPV > $5,000 的只有 10 条，但那 10 条占掉 95% 的金额 ——
      砍条数不砍金额，正是「小金额的无所谓」要的。
  [3] **被门槛挡掉的要自报**（同 §2.16.5 截断必须自报）：只写「5 家」的话，
      看的人会以为今天就掉了 5 家；实际还有 21 条在线下面，得说出来。
  [4] **沉默和掉量不许相加**（同周报那条）：沉默是「走了」，掉量是「还在出单但少了」，
      加起来那个数没有意义，而且会让人照着它去问人。
  [5] **算不出来不给 0**（§2.12）：没有状态时说「今天没跑过」，不写「0 家」。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from churn import daily as D  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("  PASS " if cond else "  FAIL ") + name + (("  << " + str(extra)[:300]) if not cond and extra else ""))
    if not cond:
        fails.append(name)


def hit(uid, site, t, tpv30, *, name=None, bd="赵娜", agent="", days=2, ratio=None, base=None, inc=None):
    h = {"key": f"{uid}|{site}", "用户ID": uid, "站点": site, "商户名称": name or f"商户{uid}",
         "直签人": bd, "代理商名称": agent, "type": t, "tpv30": tpv30, "active30": 10,
         "silent_days": days, "eligible": True, "rank": 1, "incident": inc or []}
    if ratio is not None:
        h["drop"] = {"ratio": ratio, "base": base, "now": 0}
    return h


# 形状照 assess.assess() 的真实输出
ST = {
    "ok": True, "date": "2026-08-22",
    "counts": {"沉默2": 3, "沉默7": 1, "掉量·推": 2, "掉量·页面": 1, "恢复": 5, "掉量关闭": 2},
    "incidents": [],
    "hits": [
        hit("u1", "a.com", "沉默2", 146472.0, name="啟東公司", agent="磐嶽公司", bd="1909165812357570562"),
        hit("u1", "b.com", "沉默2", 122962.0, name="啟東公司", agent="磐嶽公司", bd="1909165812357570562"),
        hit("u2", "c.com", "沉默7", 108564.0, name="MI公司", days=7),
        hit("u3", "d.com", "沉默2", 900.0, name="小商户甲"),          # 线下面
        hit("u4", "e.com", "掉量·推", 65092.0, name="宜樹公司", bd="", ratio=-0.78, base=21803.0),
        hit("u5", "f.com", "掉量·推", 36679.0, name="香港公司", ratio=-0.90, base=4284.0),
        hit("u6", "g.com", "掉量·页面", 27364.0, name="乙公司", ratio=-0.55, base=3000.0),
        hit("u7", "h.com", "掉量·推", 300.0, name="小商户乙", ratio=-0.99, base=150.0),   # 线下面
        hit("u8", "i.com", "恢复", 50000.0, name="回来了"),
    ],
}

print("[1] 三行：沉默 / 掉量 / 通道异常，各说各的")
sm = D.summary(ST, {"daily_min_tpv": 5000})
check("算得出来", sm["ok"], sm.get("reason"))
check("★ 沉默：3 个站点（900 那个被门槛挡掉）", sm["silence"]["sites"] == 3, sm["silence"])
check("★ 沉默按商户去重：2 家（u1 有两个站点）", sm["silence"]["merchants"] == 2, sm["silence"])
check("★ 沉默金额 = 三个站点的 30 天 TPV 之和",
      abs(sm["silence"]["tpv"] - (146472 + 122962 + 108564)) < 1, sm["silence"]["tpv"])
check("★ 掉量：3 个站点（300 那个被挡）", sm["drop"]["sites"] == 3, sm["drop"])
check("★ 掉量金额是**这次少掉的钱**（base），不是 30 天 TPV",
      abs(sm["drop"]["tpv"] - (21803 + 4284 + 3000)) < 1, sm["drop"]["tpv"])
check("★ 恢复不进这两行（它不是坏消息）",
      sm["silence"]["sites"] + sm["drop"]["sites"] == 6, (sm["silence"], sm["drop"]))
check("★ 沉默按档位数得出来", sm["silence"]["tiers"] == {"沉默2": 2, "沉默7": 1}, sm["silence"]["tiers"])

print("\n[1b] ★ 「家」和「个站点」是两个单位，不许混")
txt = D.text(sm)
# ⚠ 档位那个分解数的是**命中**（站点级），而同一家商户可能有好几个站点。
#   写成「4 家 / 5 个站点（满 2 天 5 家）」的话，括号里那个 5 和前面的 4 打架 ——
#   看的人会以为哪儿算错了。真实渲染里就是这么出来的。
line = [x for x in txt.split("\n") if x.startswith("■ 新沉默")][0]
check("★ 档位分解写的是「个站点」不是「家」", "满 2 天 2 个站点" in line, line)
check("★ 前面那两个单位还在", "2 家 / 3 个站点" in line, line)
# 只有一档时括号是废话（和「N 个站点」重复），不出现
one_tier = D.summary({**ST, "hits": [h for h in ST["hits"] if h["type"] != "沉默7"]},
                     {"daily_min_tpv": 5000})
one_line = [x for x in D.text(one_tier).split("\n") if x.startswith("■ 新沉默")][0]
check("★ 只有一档时不出现括号（和「N 个站点」说的是同一件事）", "（" not in one_line, one_line)
check("★ 两档以上才出现", "（" in line, line)

print("\n[2] ★ 门槛是 30 天 TPV，不是这次掉了多少")
check("★ 门槛默认 5000", D.DEFAULTS["daily_min_tpv"] == 5000, D.DEFAULTS["daily_min_tpv"])
loose = D.summary(ST, {"daily_min_tpv": 0})
check("★ 门槛 0 时那两条小的回来了", loose["silence"]["sites"] == 4 and loose["drop"]["sites"] == 4,
      (loose["silence"]["sites"], loose["drop"]["sites"]))
check("★ 掉量那条 base=150 的小商户，30 天 TPV 300 < 5000 → 被挡（证明看的是 tpv30 不是 base）",
      sm["drop"]["sites"] == 3 and loose["drop"]["sites"] == 4, (sm["drop"], loose["drop"]))

print("\n[3] ★ 被门槛挡掉的要自报")
check("★ 数得出挡掉几条", sm["below"]["hits"] == 2, sm["below"])
check("★ 也数得出挡掉多少钱", abs(sm["below"]["tpv"] - (900 + 300)) < 1, sm["below"])
check("★ 正文里写出来了（不写的话「3 个站点」会被当成今天的全部）",
      "2 条" in txt and "没列" in txt, [x for x in txt.split("\n") if "没列" in x])
check("★ 一条都没挡掉时不出现那句（「还有 0 条」比不写还糟）",
      "没列" not in D.text(D.summary(ST, {"daily_min_tpv": 0})),
      [x for x in D.text(D.summary(ST, {"daily_min_tpv": 0})).split("\n") if "没列" in x])

print("\n[4] ★ 沉默和掉量不许相加")
check("★ 正文里明说不该相加", "不该相加" in txt or "没算进上面" in txt, txt)
check("★ 三行分开（各一个 ■）", txt.count("■") >= 2, txt)

print("\n[5] ★ 算不出来不给 0")
check("★ 没有状态时说清楚，不写「0 家」",
      D.summary(None, {})["ok"] is False and "没跑" in D.summary(None, {})["reason"],
      D.summary(None, {}))
check("★ 而且正文是空串（调用方据此不发）", D.text(D.summary(None, {})) == "",
      repr(D.text(D.summary(None, {}))))
none_hits = D.summary({**ST, "hits": []}, {"daily_min_tpv": 5000})
check("★ 真的一条命中都没有：算得出来，但正文空（每天一条「今天没人掉」是噪声）",
      none_hits["ok"] is True and D.text(none_hits) == "", (none_hits["ok"], D.text(none_hits)[:60]))

print("\n[6] 前几家")
check("★ 按 30 天 TPV 降序", [g["商户名称"] for g in sm["top"]][:2] == ["啟東公司", "MI公司"],
      [g["商户名称"] for g in sm["top"]])
check("★ 商户维度合并（u1 两个站点算一家）",
      sm["top"][0]["sites"] == 2 and abs(sm["top"][0]["tpv"] - (146472 + 122962)) < 1, sm["top"][0])
check("★ 代理商 ID 写成代理商名字（19 位 ID 不是人名）", "磐嶽公司" in txt, txt[:500])
check("★ 直签人空白的写「未分配BD」不是空白", "未分配BD" in txt, txt)
check("★ 没有字面量 nan", "nan" not in txt.lower(), txt)

print("\n[7] 通道异常单独一行")
inc_st = {**ST, "incidents": [{"gw": "WORLDPAY", "merchants": 5, "sites": 7}]}
itxt = D.text(D.summary(inc_st, {"daily_min_tpv": 5000}))
check("★ 有通道异常时出现，并写明「先别当商户走了」",
      "WORLDPAY" in itxt and ("通道" in itxt or "网关" in itxt), itxt[:400])
check("★ 没有时整行不出现", "通道异常" not in txt, [x for x in txt.split("\n") if "通道" in x])

print("\n[8] ★ 群消息的老规矩")
for w in ["工作台", "口径", "阈值", "eligible", "tpv30", "掉量·推", "沉默2"]:
    check(f"不出现内部名 / 元信息「{w}」", w not in txt, [x for x in txt.split("\n") if w in x])

print("\n" + ("失败 %d 项: %s" % (len(fails), fails) if fails else "全部通过"))
sys.exit(1 if fails else 0)
