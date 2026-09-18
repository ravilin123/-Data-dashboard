"""board —— 独立单文件看板（第三次调整，docs/specs/看板/计划.md Q1~Q15）。**看板仓库自己的代码，不同步。**

    python 生成看板.py --data D:\\跨境支付运营工作台\\data

只读工作台的 data/ 目录，用同步来的口径算四块，落成一张双击就能开、能直接发人的 HTML：
  data.py    读文件（台账 / 周台账 / 流失状态 / 出单台账 / 报表存档），都吃 data_dir
  blocks.py  四块：交易概览（churn.trade）/ 商户流失（状态 + churn.funnel + churn.weekly）/ 出单监控（原始台账）/ 转化率（Node 跑 转化率快照.mjs）
  bundle.py  ES 模块 → importmap（data: URL），页面里 import 同步来的口径模块，语义不变
  page.py    模板 + CSS 加前缀隔离 + 从同步来的 static/conversion.html 抽两个面板
  export.py  落盘：看板_<date>.html + 看板.html（最新），留 keep 份
  js/        页面自己的渲染（三块自绘、转化率复用工作台 render/*.js）

⚠ 缺哪块那块 ok:false + 原因，不当 0（坑.md §2.12）。四块各用自己最新的一天（Q15）。
"""
