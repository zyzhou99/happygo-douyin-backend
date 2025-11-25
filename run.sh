#!/bin/sh
set -e

# FaaS 环境常见端口是 8000；容器模式也会下发 PORT
export PORT="${PORT:-${BYTEFAAS_HTTP_PORT:-8000}}"
export HOST="0.0.0.0"

echo "Starting Node app on $HOST:$PORT ..."
exec node app.js
