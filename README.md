# 跨境支付运营看板

`payment-ops-workbench` 的算数和口径在这里有一份**只读镜像**，上面架着：

1. 一张能脱离本机打开的看板页（`dashboard.html`），展示日报（交易量 / 出单监控 / 商户流失），定时刷新，按人配口令
2. 一个零依赖的小服务（`server/`）：读工作台的台账吐日报、校验口令、导出自带数据的单文件
3. 交给公司研发的口径文档 + 黄金用例（`docs/口径.md`、`fixtures/golden/`）

## 起步

```bash
cp config.example.json config.json          # 填 workbench_data_dir；口令去 /dashboard/admin 配
python -m server                            # 默认 http://127.0.0.1:5070/dashboard
```

第一次或工作台改了口径之后：

```bash
python scripts/同步口径.py --from ../payment-ops-workbench
bash tests/run-unit.sh
```

## 页面怎么脱离本机

- **托管**：把服务开到内网（`config.json` 的 `dashboard.listen` 写 `0.0.0.0:5070`），别人打开 `http://<这台机器>:5070/dashboard`，输口令看。
- **单文件**：页面右上「导出」→ 一个自带当天数据的 HTML，发给谁都能双击打开。**这个文件不设口令**，数据就在文件里，给谁等于给谁看。
- **公司接口**：`config.json` 填 `company_api.base_url` 后，数据源里多一个「公司接口」；契约见 `docs/specs/看板/契约.md`。

## 规矩

同步来的目录不许在这里改（`CLAUDE.md`）。测试：`bash tests/run-unit.sh`。
