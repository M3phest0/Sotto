#!/bin/sh
# 启动开发模式：Vite + Tauri。
cd "$(dirname "$0")"
. ./env/activate.sh
exec npm run tauri dev
