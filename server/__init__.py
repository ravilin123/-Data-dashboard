"""server —— 看板服务：按契约吐日报、按人校验口令、记访问日志、导出单文件。

标准库 wsgiref，零依赖（计划里写的是 Flask；改标准库的原因见 docs/计划.md）。
    python -m server            # 读 config.json 的 dashboard.listen，默认 127.0.0.1:5070
路由都在 app.py；数据源在 sources/（工作台台账、公司接口）；日报的形状只在 report.py 一处拼。
"""
