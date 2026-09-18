#!/usr/bin/env bash
# 跑全部单元测试：同步来的（按 口径清单.json 的 tests 组）+ 这个仓库自己的。
#
#     bash tests/run-unit.sh
#
# 零依赖：node 直跑 .mjs，python 直跑 .py。要 pandas 的用例会自己说「跳过」。
set -u
cd "$(dirname "$0")/.."
fail=0
run(){ echo "──────── $1"; "${@:2}" || fail=1; }

# 先守两条护栏：同步来的没被手改、清单里的都在
run tests/sync_check.py python3 tests/sync_check.py

# 同步来的用例（清单说了算，别在这儿再抄一份）
for f in $(python3 -c "import json;m=json.load(open('口径清单.json',encoding='utf-8'));print(' '.join(m['tests']['files']))"); do
  case "$f" in
    *.mjs) [ "$(basename "$f")" = "_harness.mjs" ] && continue; run "$f" node "$f" ;;
    *.py)  [ "$(basename "$f")" = "_tmpdata.py" ] && continue; run "$f" python3 "$f" ;;
  esac
done

# 这个仓库自己的
for f in tests/golden.py tests/contract.py tests/server.py tests/offline_board.py; do
  [ -f "$f" ] && run "$f" python3 "$f"
done

echo
[ $fail -eq 0 ] && echo "单元测试全部通过" || echo "有用例失败"
exit $fail
