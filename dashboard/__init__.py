"""dashboard —— 离线看板：每天把四个页面（转化率监控 / 出单监控 / 商户流失 / 交易概览）**原样**嵌进一张单文件 HTML。

    python -m dashboard                 # 生成最新那天的 data/看板/看板.html（双击就能离线看）
    python -m dashboard --date 2026-09-17

怎么嵌见 offline.py（importmap + data: 模块 + fetch 接管），抓哪些接口见 snapshot.py。
契约那套（source.py / report.py / static/dashboard.html）是给看板仓库的服务用的三块日报，工作台的 job 不生成它。
定时：dashboard_job.py 注册成第七个 job（排最后，读的是前面那些 job 落盘的文件），每天跑完落一份。
这个包和 static/dashboard.html、tests/page.mjs 都在 口径清单.json 里，看板仓库按原路径同步走。
"""
