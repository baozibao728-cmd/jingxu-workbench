#!/bin/zsh
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print '请先安装 Node.js 22 或以上版本，再打开工作台。'
  read '?按回车关闭…'
  exit 1
fi
if curl -fsS --max-time 2 'http://127.0.0.1:6040/api/bootstrap' >/dev/null 2>&1; then
  open 'http://127.0.0.1:6040'
  exit 0
fi
(
  for WORKFLOW_ATTEMPT in {1..40}; do
    if curl -fsS --max-time 1 'http://127.0.0.1:6040/api/bootstrap' >/dev/null 2>&1; then
      open 'http://127.0.0.1:6040'
      break
    fi
    sleep 0.25
  done
) &
print '工作台运行时请保留此窗口。关闭窗口会停止后台；重新启动后可以继续查询已有任务。'
node --env-file-if-exists=.env src/server.js
