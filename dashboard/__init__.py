"""dashboard —— 离线看板：每天把三块日报（交易量 / 出单监控 / 商户流失）嵌进一张单文件 HTML。

    python -m dashboard                 # 生成最新那天的 data/看板/看板.html（双击就能离线看）
    python -m dashboard --date 2026-09-17

日报的形状是契约 v1（docs/specs/看板/契约.md），页面 static/dashboard.html 只认契约不认业务字段。
定时：dashboard_job.py 注册成第七个 job（排最后，读的是前面那些 job 落盘的文件），每天跑完落一份。
这个包和 static/dashboard.html、tests/page.mjs 都在 口径清单.json 里，看板仓库按原路径同步走。
"""
