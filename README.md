# 跨境支付运营看板

`payment-ops-workbench` 的算数和口径在这里有一份**只读镜像**，上面架着：

1. **独立单文件看板**（`生成看板.py` + `board/`）：只读工作台的 `data\` 目录，落一张自带数据、双击就能开、能直接发人的 HTML。
   四块按顺序：交易概览 → 商户流失 → 出单监控 → 转化率，样式和工作台一套。**不用开工作台、不用配 job。**
2. 一个零依赖的小服务（`server/`，以后接公司 API 用）：读工作台的台账吐契约日报、校验口令、导出。
3. 交给公司研发的口径文档 + 黄金用例（`docs/口径.md`、`fixtures/golden/`）。

## 独立单文件看板：怎么用

**第一次**（Windows，工作台装在 `D:\跨境支付运营工作台`）：

1. 下载这个仓库的 zip，解压成一个文件夹（比如 `D:\-Data-dashboard-main`）。
2. 复制 `config.example.json` 为 `config.json`，把 `dashboard.workbench_data_dir` 填成工作台的 data 目录：
   `"workbench_data_dir": "D:\\跨境支付运营工作台\\data"`（JSON 里反斜杠要写两个）。
   不想改文件也行：每次带参数 `--data D:\跨境支付运营工作台\data`。
3. 双击 `生成看板.bat`。跑完文件在 `看板\看板.html`（永远最新）和 `看板\看板_<日期>.html`（每天一份，留 30 份）。

要求：Python 3.10+（工作台的 venv 就行，.bat 会自动找 `..\跨境支付运营工作台\venv`）；
**转化率那块要 Node 18+**（口径只有 JS 版，工作台装转化率播报时就装了）。没有 Node 时那一块写明原因，其余三块照常。

**每天自动生成**（计划任务，每天 11:30 —— 工作台 10:30 那一轮把台账、流失、出单跑完之后）：

```
schtasks /Create /SC DAILY /ST 11:30 /TN "生成运营看板" /TR "\"D:\-Data-dashboard-main\生成看板.bat\"" /F
```

或者「任务计划程序」里手动建：触发器每天 11:30，操作「启动程序」指到 `生成看板.bat`，「起始于」填它所在的文件夹。
想立刻补一次就双击 .bat；想生成某一天：`python 生成看板.py --date 2026-09-17`。

**给别人看**：直接发 `看板.html` 这个文件。它不设口令，数据都在文件里 —— 给谁等于给谁看。
四块各用自己最新的一天，块头写着数据日期；和文件日期不同的会标黄（比如出单监控昨天没跑）。

**以后要改看板**：只更新这个仓库（再下一次 zip 覆盖），工作台不用动。
工作台改了口径 / 页面才要同步：`python scripts/同步口径.py --from ../payment-ops-workbench`。

## 服务（以后接公司接口用）

```bash
cp config.example.json config.json          # 口令去 /dashboard/admin 配
python -m server                            # 默认 http://127.0.0.1:5070/dashboard
```

- **托管**：`dashboard.listen` 写 `0.0.0.0:5070`，别人打开 `http://<这台机器>:5070/dashboard`，输口令看。
- **公司接口**：`config.json` 填 `company_api.base_url` 后，数据源里多一个「公司接口」；契约见 `docs/specs/看板/契约.md`。

## 规矩

同步来的目录不许在这里改（`CLAUDE.md`）。测试：`bash tests/run-unit.sh`（`tests/offline_board.py` 钉看板，有 node 才验转化率那块；
`WB_CHROME=<chrome> python tests/offline_board.py` 会用无头 Chromium 真开一次）。
