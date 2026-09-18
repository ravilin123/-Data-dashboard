# 看板（-Data-dashboard）

工作台 `payment-ops-workbench` 的**口径层镜像** + 一张能脱离本机的看板 + 交给公司研发的口径文档。
决定都记在 `docs/specs/看板/计划.md`（Q1~Q33，同步自工作台）；契约在 `docs/specs/看板/契约.md`。

## 三条不许破的

1. **同步来的文件不许在这里改。** `churn/`、`order_monitor/`、`names.py`、`static/`、`jobs/`、
   `tests/` 里清单列的那些、`docs/坑.md`、`docs/specs/` —— 全是 `scripts/同步口径.py` 从工作台拷来的，
   `同步记录.json` 记着每个文件的 sha256，`tests/sync_check.py` 守着。要改：回工作台改、跑那边的测试、再同步。
2. **什么算口径层由工作台的 `口径清单.json` 定**，这里不另列一份。
3. **口径层不带运行时**：不 import 飞书 / 邮箱 / Flask。工作台那边 `tests/metrics_manifest.py` 钉着。

## 这个仓库自己的东西（可以改）

| 目录 | 是什么 |
|---|---|
| `生成看板.py` `生成看板.bat` `board/` | **独立单文件看板**（第三次调整 Q1~Q15，`docs/specs/看板/计划.md`）：只读工作台 data/，用同步来的口径算四块，落 `看板/看板_<日期>.html`。`board/js/` 是页面自己的渲染（三块改自工作台各页的 render 去掉控件；转化率直接 import 同步来的 `render/*.js`，面板骨架和 CSS 生成时从同步来的 `static/conversion.html` 抽）。`tests/offline_board.py` 钉 |
| `server/` | 看板服务：`/api/dashboard/*`、按人口令、访问日志、导出单文件。**标准库 wsgiref，零依赖**；日报的拼法和页面是同步来的 `dashboard/`、`static/dashboard.html` |
| `adapters/` | 公司接口 → 契约日报（或 → 报表列名再喂口径层） |
| `contracts/` | 日报契约的 JSON Schema + 校验器 + 每块口径的输入列 |
| `fixtures/golden/` | 黄金用例：输入 → 输出，验收标准。`expected` 是口径层跑出来的，**不手写** |
| `docs/口径.md` `docs/交付说明.md` | 交给研发的正文 |
| `scripts/` | 同步、生成黄金用例、导出 |

## 验证

```bash
bash tests/run-unit.sh            # 同步来的用例 + 自己的，零依赖；要 pandas 的会自己说跳过
WB_CHROME=/path/chrome python tests/offline_board.py   # 看板：再用无头 Chromium 真开一次，四块都得渲染出内容
python tests/sync_check.py        # 同步来的文件没被手改
python scripts/同步口径.py --from ../payment-ops-workbench --dry-run   # 看工作台那边有什么新的
```

## 坑

`docs/坑.md` 是从工作台按条目号抽的，**§ 号一致**：代码注释里的 `CLAUDE.md §x` 指的就是它。
这个仓库自己踩的坑记在 `docs/坑-看板.md`（§D1 起）。
