# `static/js/merchant/` —— 商户成功率页的计算内核

`merchant.html` 原来是一整段 3370 行的 `<script type="module">`，**里面一个函数都跑不了单元测试**。
2026-09-09 把其中**纯计算**的那 1450 行拆到这里；页面剩下 2500 行，全是界面。

拆之前唯一的护栏是 `tests/e2e*.py` 那几套 Playwright 用例，而它们覆盖不到口径细节 ——
「退款算不算成功」「失败文案取哪一列」「金额档位怎么挑」这些错了都不报错，只是数字悄悄变了。
现在这些有 `tests/merchant_core.mjs`。

## 分层

```
util.js        小工具 + 状态归类（succ / fail / pending / unknown）
   ↑
amount.js      金额分档（带可变状态：当前档位）
   ↑
config.js      列映射、维度注册表、各种阈值、失败编码常量
   ↑
clean.js       读取与清洗（带可变状态：PRESENT / IGNORED_COLS / SKIPPED_COLS）
               + 排除风控 / L3 / withDim / hasDimData / 币种拆分
   ↑
tables.js      各种表：失败原因 / 失败归类 / 维度 / 维度×维度 / 维度×失败
               + dimRows / dimAvail / dimTable
   ↑
conclusion.js  异常检测 + 文字结论
   ↑
report.js      完整分析（编排：出哪些表、什么顺序）

charts_data.js 图表层的取数（口径是显式参数，不读界面全局）
```

箭头是 import 方向，**没有环**。

界面层还在 `merchant.html` 里：密码锁、文件读取、视图管道（筛选/站点/期间）、
图表（983 行，最大的一块）、下钻面板、详细报表/导出/AI、支付转化漏斗。

## 三个刻意的位置

**1 · 状态归类在 `util.js`，不在 `config.js`。**
它本来在配置区，但 `aggregate()` 要用 `isSucc` —— 留在配置里就得让工具层反过来
import 配置，白白多一个环。这几个谓词本来也是工具性质的。

**2 · `dimRows` / `dimAvail` / `dimTable` 在 `tables.js`，不在 `config.js`。**
它们要 `withDim`（清洗层）和 `generateGroupedTable`（表层），放配置里等于让配置
依赖上面两层。`DIMENSIONS` / `DIM` / `dimLabel` / `dimCats` 这些纯数据留在配置。

**3 · 可变状态和它的赋值点必须同一个文件。**
`PRESENT` / `IGNORED_COLS` / `SKIPPED_COLS` 只在 `loadAndClean` 里赋值，
所以三个 `let` 和 `loadAndClean` 都在 `clean.js`；金额档位同理，在 `amount.js`，
改只走 `setAmountScheme()` 一个口子。

ES module 的 import 是**只读绑定** —— 别的模块 import 过去只能读、不能改。
这正是我们要的：「谁能改它」只有一个地方。拆的时候原来那句
`AMOUNT_SCHEME = buildAmountScheme(...)` 就是因此改成了 `setAmountScheme(...)`。

## 拆的时候是怎么保证行为没变的

不是靠读代码，是靠**逐字节对比**。拆之前先抓一份完整快照，拆完再抓一份：

- 4 个场景：小/大两份合成流水 × 单期/对比两种模式
- 每个场景抓：KPI 区文字、每个页签（口径/维度/失败/趋势/交叉/风险）渲染出来的全部文字、
  **39 张表的每一格**、规则结论、以及喂给 AI 的完整提示词
- 39 个文件 `diff -q`，**全部逐字节一致**

脚本在会话的 scratchpad 里（`snap.py`），没进仓库 —— 它依赖合成的流水文件。
以后再动这一层，建议照这个办法再来一遍：读代码看不出「某个分支的取整变了」。

## 图表层的取数（2026-09-09 第二刀）

`charts_data.js` —— 按上面那条「先抽取数，渲染留在页面」拆出来的：
`aggMetric` / `groupMetric` / `failGroups` / `changeAttrib` / `impactItems` /
`timeHeatGrid` / `heatRate` / `heatScale`。

**口径（笔数 / 金额）改成显式参数 `amount`**，不再读 `isAmt()` 那个界面全局 ——
原来同一个函数在两种口径下行为不同、调用点看不出来，也没法单独跑。
页面里保留三个小包装（`aggMetric` / `groupMetric` / `failGroups`）把当前口径补上，
所以那 20 多处调用点一个都不用改。

### 抽出来当场逮到一个真 bug

**变化归因的加权分解，遇到「本期新增的取值」会对不上账，而卡片把差额写成「四舍五入」。**

恒等式 `Σ(w2−w1)·r1 + Σ w2·(r2−r1) = overall2 − overall1` 对 r1 取什么值都成立
（两项里的 r1 会相消）。但原来的写法是 `eStruct` 按 `r1=0` 算、`eRate` 对新增
**直接写死 0** —— 两处用了不同的 r1，恒等式当场破掉。

实测：上期只有 VISA（80%），本期 VISA 减半 + 新增 NEWPAY（90%），整体 +5pt，
而分解出来是 **−40pt**，卡片底下印着「差 45 pt 为四舍五入」。

修法：新增取值的反事实基线取**上期整体通过率**。这样两项都有意义 ——
结构效应 = 新增的这批量按老平均水平该贡献多少，通过率效应 = 它实际比老平均好/差多少。
tooltip 里也写明了「新增，按上期整体 X% 作基线」，不然「上期通过率 —」看着像没参与计算。

## 还没拆的

界面层还剩 ~2400 行，基本都是纯渲染：SVG 拼装、tooltip、图例、联动筛选的接线，
以及密码锁、文件读取、导出、漏斗面板。

⚠️ **别为了拆而拆。** 两刀拆的都是**有口径、会静默出错、值得写用例**的那部分；
纯拼 HTML 的代码搬到另一个文件里并不会变得更安全，只会多一层跳转。
