# 用 18/20 都可以，和平台文档一致即可
FROM node:18-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production || npm install --only=production

COPY . .

# 复制启动脚本到平台预期的位置
RUN mkdir -p /opt/application \
 && cp ./run.sh /opt/application/run.sh \
 && chmod +x /opt/application/run.sh

# 可选健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8000}/healthz || exit 1

# 即使平台忽略 CMD 走自己的 run.sh，也不冲突
CMD ["node","app.js"]