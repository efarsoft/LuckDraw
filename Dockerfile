FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

# 先装依赖（利用 Docker 层缓存；better-sqlite3 在 Debian slim 有预编译二进制，无需编译工具）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷源码
COPY . .

# 数据目录（SQLite 库/头像/奖品图）挂卷持久化
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server/index.js"]
