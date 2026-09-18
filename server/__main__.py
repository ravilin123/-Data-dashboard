# -*- coding: utf-8 -*-
"""python -m server —— 起看板服务。"""
from __future__ import annotations

import sys
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, make_server

from . import config as C
from .app import create_app


class _Threaded(ThreadingMixIn, WSGIServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    cfg = C.load()
    host, port = C.listen(cfg)
    app = create_app(cfg, data_dir=C.data_dir(cfg), page_path=C.ROOT / "dashboard.html",
                     log_path=C.ROOT / "data" / "access.log", config_path=C.CONFIG_PATH)
    print(f"[看板] 配置来自 {cfg.get('_source') or '默认值（没有 config.json）'}")
    print(f"[看板] 台账目录 {C.data_dir(cfg)}")
    print(f"[看板] http://{host}:{port}/dashboard   口令配置 http://127.0.0.1:{port}/dashboard/admin（只许本机）")
    print(f"[看板] 口令 {len(cfg.get('viewers') or [])} 个" + ("" if cfg.get("viewers") else " —— 一个都没配，页面谁都打不开；去 /dashboard/admin 配"))
    with make_server(host, port, app, server_class=_Threaded) as srv:
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
