"""dashboard —— 契约日报（给看板仓库的服务用）：source.py 拼三块、report.py 定形状、export.render 嵌进 static/dashboard.html。

独立单文件看板**不在这里**：它在看板仓库 `-Data-dashboard` 的 `生成看板.py`（只读工作台的 data/ 目录，
用同步过去的口径算；第三次调整，docs/specs/看板/计划.md）。原来那版 iframe 离线看板和第七条 job 已删（2026-09-18）。
这个包和 static/dashboard.html、tests/page.mjs 都在 口径清单.json 里，看板仓库按原路径同步走。
"""
