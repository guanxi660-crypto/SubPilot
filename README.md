# SubPilot

面向 [SubConverter-Extended](https://github.com/Aethersailor/SubConverter-Extended)（下称 SCE）的订阅管理控制台。
界面与交互沿用前身项目 [SubPilot-Archive](https://github.com/guanxi660-crypto/SubPilot-Archive)（已归档），
但**转换层不自己实现** —— 本项目只做 SCE 不具备的那部分：**存储、节点处理、分发**。

```
浏览器 ──/api/*（Bearer 令牌）──► SubPilot 服务端
                                    ├── 存储：KV（Worker）/ SQLite（自建）
                                    ├── 节点解析 + JSON 算子链
                                    ├── /feed/*  ──► SCE ──► Clash / sing-box / Surge …
                                    └── /download/*  客户端直接拉取
```

`apps/server/src/` 是同一份代码，可部署到 **Cloudflare Worker** 或**自建 Node / Docker**
（`apps/server/node/` 是适配层）。两者接口与行为一致，只有存储形态不同。

<p align="center">
  <img src="shots/01-概览.png" width="49%" alt="概览" />
  <img src="shots/02-订阅.png" width="49%" alt="订阅管理" />
</p>
<p align="center">
  <img src="shots/06-转换.png" width="49%" alt="转换" />
  <img src="shots/08-AI助手.png" width="49%" alt="AI 助手" />
</p>

## 它补上什么

SCE 是无状态的：只有 `/sub`、`/version`、`/healthz` 等少数路由，没有存储 API，
也不接受任意内联节点列表。于是：

1. **存储** —— 订阅、组合、文件、成品、分享码、设置（Worker 用 KV，自建用 SQLite）。
2. **节点处理** —— 一份 JSON 脚本描述筛选 / 排序 / 重命名等规则，在服务端执行。
3. **分发** —— 处理后的节点经 `/feed/*` 给 SCE 拉取，客户端拿 `/download/*`。

## 分发链接语义（重要）

分享 / 分发链接**只输出编辑后的订阅，不做任何格式转换**（Sub-Store 模式）：

- URI 来源 → v2ray base64 通用订阅，各客户端直接导入，也可再当转换输入；
- clash 来源 → 本地序列化的 clash YAML；
- `?target=` 参数在分发通道**被忽略**（老链接兼容）。

这样分享出去的链接不会被下游二次转换。需要特定客户端格式时，去**转换页**
（`/sub?target=xxx`）或保存成品（`/api/converted`）—— 那两条路仍走 SCE。

## 本地开发

```bash
npm run install:all     # 安装前后端依赖
npm run dev:server      # Worker 形态 → http://127.0.0.1:8795
npm run dev:web         # 前端 dev server → http://127.0.0.1:5175
```

打开 `http://127.0.0.1:8795`，令牌填 `dev-local-token`（见 `wrangler.dev.jsonc`）。

想跑**自建那套**（Node + SQLite，与 Docker 镜像同一份代码）：

```bash
npm run build                                   # 构建前端 → apps/web/dist
SUBPILOT_TOKEN=dev-local-token npm start        # → http://127.0.0.1:8795，数据落 apps/server/data/
```

> **改完前端要重启服务。** Worker 的 assets 清单在启动时快照，重新 build 后
> 新 hash 的 JS 会 404（`index.html` 已指向新文件，表现为白屏 + 两个 404）。

## 部署到 Cloudflare Worker

```bash
cd apps/server
npx wrangler kv namespace create DATA -c wrangler.jsonc   # 把输出的 id 填进 wrangler.jsonc
npx wrangler secret put SUBPILOT_TOKEN -c wrangler.jsonc  # 访问令牌（未设置时受保护接口一律 401）
cd ../.. && npm run deploy                                # vite build + wrangler deploy
```

> 本项目**不能**用纯 API 单文件上传方式部署：Worker 是多模块 + `assets` 静态资源
> + KV 绑定 + secret，必须走 wrangler。

`wrangler.jsonc` 里的 `name` 必须与线上 Worker 一致 —— 改了名字 `wrangler deploy`
会**新建**一个 Worker，而自定义域仍指向旧的，表现为「部署成功但线上没变」。

**换自定义域名**：Dashboard → Worker → Settings → Domains & Routes 解绑 / 绑定即可。
注意已生成的客户端配置里嵌的是**当时请求的 host**，换域后旧的 `/feed/...`、`/download/...`
地址会失效，需要重新分发。

## 部署到 Docker / Node

同一份 `apps/server/src/`，`apps/server/node/` 把 4 个平台专有能力换掉：

| Worker 专有 | 自建替代 |
| --- | --- |
| `env.DATA`（KV） | SQLite（`node:sqlite` 内置），经 `env.STORE` 注入 |
| `env.ASSETS.fetch` | `node/assets.mjs`（ETag / SPA 回退 / 防路径穿越） |
| `ctx.waitUntil` | 吞异常的 fire-and-forget |
| `env.*` 环境变量 | 进程环境变量 |

### Docker Compose（推荐）

```bash
cp .env.example .env      # 填 SUBPILOT_TOKEN，建议 openssl rand -hex 24
docker compose up -d --build
```

打开 `http://<服务器>:8795`，数据落在宿主机 `./data`。首次启动若报
`unable to open database file`，是目录权限问题（容器以 uid 1000 运行）：

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

镜像为 `node:22-alpine` 两段构建，非 root 运行，带 `HEALTHCHECK`（探 `/healthz`）。

### 裸 Node

需要 **Node 22.5+**（`node:sqlite` 内置），无需原生编译工具链。

```bash
npm run install:all
npm run build
SUBPILOT_TOKEN='<你的令牌>' npm start
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SUBPILOT_TOKEN` | 空 | **访问令牌，为空时所有受保护接口 401**（fail-closed）。必填 |
| `SUB_BACKEND` | 空 | SCE 地址；留空则登录后在「转换」页配置 |
| `DB_FILE` | `apps/server/data/subpilot.db` | SQLite 文件位置 |
| `PORT` | `8795` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ASSETS_DIR` | `apps/web/dist` | 前端产物目录 |

### 反向代理

`/feed/*`、`/download/*` 的地址会被写进客户端配置，取的是**请求的 origin**，
反代必须传 `X-Forwarded-Proto` 与 `X-Forwarded-Host`，否则会把内网地址写进配置。
AI 助手是 SSE 长连接，nginx 需关闭该路径的 buffering。

## 目录结构

```
apps/server/          Worker 后端
  src/                index(路由/鉴权) api convert sce pipeline operators
                      nodes feedkey ai sync telegram storage templates util
  node/               自建适配层：server.mjs / sqlite-store.mjs / assets.mjs
  wrangler.jsonc      生产配置
apps/web/             Vue 3 + Vite + Tailwind + Naive UI
  src/views components stores utils
Dockerfile docker-compose.yml .env.example
LICENSE (AGPL-3.0-only)  NOTICE
```

## 许可

AGPL-3.0-only，见 [LICENSE](LICENSE)。第三方组件与出处见 [NOTICE](NOTICE)。
