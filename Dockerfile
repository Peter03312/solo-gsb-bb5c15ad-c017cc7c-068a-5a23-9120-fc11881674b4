FROM node:20-bookworm-slim

# better-sqlite3 为原生模块；node:20 官方镜像带预编译构建工具链通常无需编译，
# 保留构建依赖以兜底（从源码编译时需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用层缓存；better-sqlite3 需从源码编译时由上方工具链兜底）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝应用代码
COPY src ./src
COPY public ./public

# 数据库存放目录（挂载为卷以持久化）
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/app.db \
    PORT=3000 \
    HOST=0.0.0.0 \
    SEED_DEMO=1

EXPOSE 3000

# 启动即自动建表（幂等），空库时写入演示数据
CMD ["node", "src/server.js"]
