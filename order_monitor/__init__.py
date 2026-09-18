# -*- coding: utf-8 -*-
"""出单耗时监控。

原来是工作台外面的两个脚本（`出单监控.py` 只发群通知、`出单监控_BD私聊版.py` 是超集），
凭据明文硬编码在源码里。T10 合并进来，口径一行没改，凭据全部读 `config.json`。

    python -m order_monitor --today T.xls --yesterday Y.xls --date 2026-09-06 --mode both

五步，各自独立 try/except（一步失败不拖垮后面的）：

    excel      读第二个 sheet（两行表头，用户ID 是 19 位大整数，必须按字符串读）
    classify   ← **唯一决定业务口径的地方**：谁算新出单、谁算滞留、谁该进周报
    notify     飞书群通知 + BD 私聊
    bitable    写多维表格底账
    report     存一份本地 txt（不依赖网络，永远最后执行）

`pipeline.run_pipeline()` 把它们串起来，`config.settings` 一次读完配置。
改 classify 之前先看 `tests/order_monitor.py` —— 13 条分支各有一个用例钉着。
"""
