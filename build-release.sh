#!/bin/sh
# 构建 release 版本并打包（NSIS 安装包）。
cd "$(dirname "$0")"
. ./env/activate.sh
exec npm run tauri build
