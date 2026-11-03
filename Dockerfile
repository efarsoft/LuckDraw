FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

# 国内服务器适配：
#  1) apt 换阿里云源 + 预装编译工具链（better-sqlite3 预编译包下载失败时走源码编译的兜底）
#  2) npm 走 npmmirror；better-sqlite3 二进制优先从 npmmirror 镜像拉取（不依赖 GitHub）
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3

# 先装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷源码
COPY . .

# 数据目录（SQLite 库/头像/奖品图）挂卷持久化
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server/index.js"]
