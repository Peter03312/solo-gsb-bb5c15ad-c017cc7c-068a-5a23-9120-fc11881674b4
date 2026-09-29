# 数字展品授权核验系统 —— 运行镜像
FROM node:20-bookworm-slim

# better-sqlite3 多数情况下直接下载预编译二进制；
# 保留编译工具链以防需要从源码构建原生模块。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先安装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 拷贝应用代码
COPY src ./src
COPY public ./public

# 数据库持久化目录（server 启动时自动建库、建表并初始化 basis_version）
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000
VOLUME ["/app/data"]

# 容器启动即完成“数据库初始化 + Web 服务启动”
CMD ["node", "src/server.js"]
