# -*- coding: utf-8 -*-
"""adapters.company_api —— 公司接口的入口（Q4-C / Q22-A）。

现在的约定（等公司接口定了再改这一个文件）：
    GET {base_url}/dates                → {"ok": true, "dates": ["2026-09-17", …]}
    GET {base_url}/daily?date=YYYY-MM-DD → 契约里的日报（contracts/daily_report.schema.json）
    请求头 Authorization: Bearer {token}

⚠ 没配 base_url 不是错：configured() 回 (False, 原因)，daily() 回 ok:false 的日报，**不是 500**。
⚠ 对方回的不合契约：原样列出字段路径（contracts.validate），不静默修、不猜。
⚠ 将来公司只给原始明细：在这里加「接口字段 → 报表列名」的映射，再喂 churn.overview / churn.assess，
  口径层一个字不动。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from contracts.validate import validate
from dashboard import report as R


def _http_get(url: str, headers: dict, timeout: int) -> tuple[int, str]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:      # noqa: S310 —— 地址是自己配的
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


class CompanyApi:
    key = "company"
    label = "公司接口"

    def __init__(self, cfg: dict | None, fetch=None):
        c = (cfg or {}).get("company_api") if isinstance(cfg, dict) and "company_api" in (cfg or {}) else (cfg or {})
        self.base = str((c or {}).get("base_url") or "").strip().rstrip("/")
        self.token = str((c or {}).get("token") or "")
        self.timeout = int((c or {}).get("timeout") or 20)
        self._fetch = fetch or _http_get      # 用例注入假的

    def configured(self) -> tuple[bool, str]:
        if not self.base:
            return False, "还没接：config.json 的 dashboard.company_api.base_url 是空的"
        return True, ""

    def _headers(self) -> dict:
        h = {"Accept": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def _get(self, path: str, params: dict | None = None):
        """(obj, err)。网络 / 非 200 / 不是 JSON 都走 err，一个字不猜。"""
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        try:
            status, text = self._fetch(url, self._headers(), self.timeout)
        except Exception as e:  # noqa: BLE001 —— urllib 的异常种类太多，这里只要一句人话
            return None, f"调不通 {url}：{e}"
        if status != 200:
            return None, f"{url} 回 HTTP {status}：{text[:200]}"
        try:
            return json.loads(text), ""
        except ValueError as e:
            return None, f"{url} 回的不是 JSON：{e}"

    def dates(self) -> list[str]:
        ok, _ = self.configured()
        if not ok:
            return []
        obj, err = self._get("/dates")
        if err or not isinstance(obj, dict):
            return []
        return sorted((d for d in obj.get("dates") or [] if isinstance(d, str)), reverse=True)

    def daily(self, date: str) -> dict:
        ok, why = self.configured()
        if not ok:
            return R.report(date, self.key, self.label, [], reason=why)
        obj, err = self._get("/daily", {"date": date})
        if err:
            return R.report(date, self.key, self.label, [], reason=err)
        errs = validate(obj)
        if errs:
            r = R.report(date, self.key, self.label, [], reason=f"公司接口回的日报不合契约（{len(errs)} 处），见 errors")
            r["errors"] = errs
            return r
        obj["source"] = {"key": self.key, "label": self.label}
        return obj
