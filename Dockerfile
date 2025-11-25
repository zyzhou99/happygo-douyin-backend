# ---- 生产镜像：Node 18 ----
FROM node:18-alpine

# 让 Node 在容器里更安全
ENV NODE_ENV=production
# 抖音云会注入 PORT 环境变量，这里不写死
WORKDIR /app

# 仅复制依赖清单，利用缓存
COPY package*.json ./

# 安装生产依赖
RUN npm ci --only=production || npm install --only=production

# 再复制源码
COPY . .

# 健康检查路由（可选，抖音云也支持配置）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1

# 启动
CMD [ "node", "app.js" ]
