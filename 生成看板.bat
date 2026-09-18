@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
cd /d "%HERE%"

REM 用哪个 Python：工作台的 venv（和看板放在同一个盘时）> PATH 里的 python
set "PY=python"
for %%d in ("%HERE%..\跨境支付运营工作台" "%HERE%..\payment-ops-workbench") do (
    if exist "%%~d\venv\Scripts\python.exe" set "PY=%%~d\venv\Scripts\python.exe"
)

REM --data 不给就读 config.json 的 dashboard.workbench_data_dir；其余参数原样透传（--date / --out）
"%PY%" "%HERE%生成看板.py" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo 生成失败（退出码 %RC%）。看上面的原因；--data 要指到工作台的 data 目录。
    pause
)
exit /b %RC%
