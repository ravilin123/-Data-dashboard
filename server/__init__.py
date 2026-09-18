"""server —— 看板服务：按契约吐日报、按人校验口令、记访问日志、导出单文件。

标准库 wsgiref，零依赖（计划里写的是 Flask；改标准库的原因见 docs/计划.md）。
    python -m server            # 读 config.json 的 dashboard.listen，默认 127.0.0.1:5070
路由都在 app.py；日报的拼法（dashboard.source）和形状（dashboard.report）是工作台同步来的；公司接口在 adapters/。
"""
