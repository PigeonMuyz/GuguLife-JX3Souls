#!/bin/bash

# 快速启动脚本 - 一键编译并启动

echo "🐦 渡渡鸟情缘机器人 快速启动"
echo "=========================="

# 编译所有插件
echo "📦 编译插件..."
for plugin in plugins/*/; do
    [ -f "$plugin/tsconfig.json" ] && (cd "$plugin" && rm -rf lib && npx tsc 2>/dev/null)
done

# 安装依赖
echo "📥 更新依赖..."
yarn install --silent

# 启动
echo "🎮 启动服务器..."
echo "📍 地址: http://localhost:5140"
echo "🛑 按 Ctrl+C 停止"
echo ""

yarn dev
