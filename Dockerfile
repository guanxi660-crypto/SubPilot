# syntax=docker/dockerfile:1
#
# SubPilot —— Docker 镜像（Node / Docker 部署专用）。
#
# 两段构建：第一段装前端依赖并 vite build，第二段只装**运行时**依赖
# （apps/server 的 dependencies 只有一个 yaml），最终镜像里没有构建工具链。
#
# 运行时跑的是 apps/server/node/server.mjs —— 直接调用 src/router.js 的
# 路由逻辑，配上 SQLite 存储（node:sqlite，Node 22.5+ 内置，
# 不需要 better-sqlite3，因此 alpine 上不用装 python/make/g++）。
#
# 多架构支持：node:22-alpine 同时提供 linux/amd64 和 linux/arm64 变体，
# docker buildx build --platform linux/amd64,linux/arm64 即可出多架构镜像。

# ---------- 构建前端 ----------
FROM node:22-alpine AS web

WORKDIR /app

# 先只拷 manifest：源码改动时依赖层仍能命中缓存
COPY apps/web/package.json apps/web/package-lock.json ./
# lock 里已包含各平台变体（含 linux-musl），alpine 上 npm ci 可用
RUN npm ci

COPY apps/web ./
RUN npm run build

# ---------- 运行时 ----------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
# 目录结构与仓库保持一致（/app/apps/server + /app/apps/web/dist），
# 这样 server.mjs 里按相对位置推算的默认路径不用改也不会算错。
WORKDIR /app/apps/server

COPY LICENSE NOTICE /app/

COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci && npm cache clean --force

COPY apps/server/src ./src
COPY apps/server/node ./node
COPY --from=web /app/dist /app/apps/web/dist

# 数据目录（订阅 / 组合 / 文件 / 分享码 / 设置全在这一个目录里），挂卷用。
# 以非 root 运行：先建目录并交给 node 用户。
RUN mkdir -p /data && chown -R node:node /data
USER node

ENV HOST=0.0.0.0 \
    PORT=8795 \
    DB_FILE=/data/subpilot.db

EXPOSE 8795
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8795)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --disable-warning=ExperimentalWarning：node:sqlite 在 22/24 上都会打一行
# 「SQLite is an experimental feature」的实验性提示。API 本身稳定可用，但每行
# 日志都带着它容易让人以为出了问题，这里静音。功能不受影响。
CMD ["node", "--disable-warning=ExperimentalWarning", "node/server.mjs"]
