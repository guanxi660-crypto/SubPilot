# SubPilot

一体化订阅管理面板：**订阅管理 · 节点拼接（组合）· 格式转换 · 文件与文档管理 · AI 助手**。

前端是 Vue 3 单页应用；后端同一份 `apps/server/src/`，可部署到 **Cloudflare Worker**
或**自建 Node / Docker**，两者接口与行为一致，只有存储形态不同。

```
浏览器（Vue 3 SPA）
  订阅 · 组合 · 文件 · 转换 · 同步 · AI 助手 · 设置
        │
        │  /api/*（Bearer 令牌）
        ▼
SubPilot 服务端 ──────────────────────────────────────────────
   ├── 存储        KV（Worker）/ SQLite（自建）
   │               订阅 / 组合 / 文件 / 成品 / 分享码 / 设置
   ├── 节点处理    解析 + JSON 算子链（筛选 / 排序 / 重命名 / 去重 …）
   ├── 文档管理    规则集 / 模板 / 片段，生成链接与分享链接
   ├── AI 助手     OpenAI 兼容接口 SSE 代理（API Key 不下发浏览器）
   ├── 同步推送    Gist / WebDAV 备份恢复、Telegram 推送
   └── 转换        调用转换后端 ──► Clash / sing-box / Shadowrocket …
                     ▲
        /feed/* ─────┘  供后端回拉处理后的节点
        /download/*、/share/*   客户端直接拉取（只读分发密钥）
```

**本项目默认后端**：https://subpilot.57995799.xyz/version

基于 **SubConverter-Extended**：https://github.com/Aethersailor/SubConverter-Extended

该实例由作者自建、**公益免费提供**，`SUB_BACKEND` 已预置此地址，开箱即用；
不承诺可用性与稳定性，请勿滥用，有稳定性要求请换自建后端。

**出处引用**：算子链 DSL 与 Sub-Store（https://github.com/sub-store-org/Sub-Store）保持兼容；
完整第三方声明见 `NOTICE` 与文末「许可」。

<p align="center">
  <img src="shots/01-概览.png" width="49%" alt="概览" />
  <img src="shots/02-订阅.png" width="49%" alt="订阅管理" />
</p>
<p align="center">
  <img src="shots/06-转换.png" width="49%" alt="转换" />
  <img src="shots/08-AI助手.png" width="49%" alt="AI 助手" />
</p>

## 分发链接语义（重要）

分享 / 分发链接**只输出编辑后的订阅，不做任何格式转换**（Sub-Store 模式）：

- URI 来源 → v2ray base64 通用订阅，各客户端直接导入，也可再当转换输入；
- clash 来源 → 本地序列化的 clash YAML；
- `?target=` 参数在分发通道**被忽略**（老链接兼容）。

这样分享出去的链接不会被下游二次转换。需要特定客户端格式时，去**转换页**
（`/sub?target=xxx`）或保存成品（`/api/converted`）—— 只有这两条路会做格式转换。

## 部署

三种方式，按推荐顺序排列。自建形态（`apps/server/node/`）把 4 个平台专有能力换掉：

| Worker 专有 | 自建替代 |
| --- | --- |
| `env.DATA`（KV） | SQLite（`node:sqlite` 内置），经 `env.STORE` 注入 |
| `env.ASSETS.fetch` | `node/assets.mjs`（ETag / SPA 回退 / 防路径穿越） |
| `ctx.waitUntil` | 吞异常的 fire-and-forget |
| `env.*` 环境变量 | 进程环境变量 |

### 一、Docker（推荐）

**快速方式（一条命令）**，适合先跑起来看看：

```bash
docker run -d --name subpilot --init \
  -p 8795:8795 \
  -e SUBPILOT_TOKEN='<你的令牌>' \
  -v subpilot-data:/data \
  ghcr.io/guanxi660-crypto/subpilot:0.1.13
```

| 参数 | 说明 |
| --- | --- |
| `-e SUBPILOT_TOKEN` | 访问令牌，唯一必填项 |
| `-v subpilot-data:/data` | 具名卷存数据。用卷而不是挂宿主目录，可省掉改属主那一步 |
| `-p 8795:8795` | 端口映射，左边是宿主机端口 |
| `--init` | 以 tini 作 PID 1，优雅关闭才能把 WAL 落回主库 |

然后打开 `http://<服务器>:8795`，输入上面的令牌登录。
日常用 `docker logs -f subpilot` 看日志，`docker rm -f subpilot` 删除（卷里的保留）。

正式部署建议用下面的 compose（便于固化配置、重启策略与健康检查）：

完整可用的 `docker-compose.yml`：

```yaml
services:
  subpilot:
    # 直接用已发布的镜像（版本号与 package.json 一致）
    image: ghcr.io/guanxi660-crypto/subpilot:0.1.13
    # 想从源码构建就注释掉上面那行，改用下面这两行：
    #   build:
    #     context: .
    #     dockerfile: Dockerfile
    container_name: subpilot
    restart: unless-stopped
    init: true                 # 以 tini 作 PID 1，优雅关闭才能把 WAL 落回主库

    ports:
      # 放反向代理后面时建议改成 "127.0.0.1:8795:8795"，只监听回环
      - "8795:8795"

    environment:
      # 访问令牌，必填。不设置时所有受保护接口一律 401（fail-closed）
      SUBPILOT_TOKEN: ${SUBPILOT_TOKEN:?请在 .env 里设置 SUBPILOT_TOKEN}
      # 转换后端。留空则用仓库预置的公益实例
      SUB_BACKEND: ${SUB_BACKEND:-https://subpilot.57995799.xyz}
      TZ: ${TZ:-Asia/Shanghai}
      # SQLite 文件位置，放在卷里才会持久化
      DB_FILE: ${DB_FILE:-/data/subpilot.db}

    volumes:
      # 全部业务数据都在这一个目录里
      - ./data:/data

    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8795)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s
```

配套的 `.env`（与 compose 放同一目录，**不要提交**）：

```bash
SUBPILOT_TOKEN=            # 必填，建议 openssl rand -hex 24
SUB_BACKEND=               # 可留空，留空用公益默认后端
TZ=Asia/Shanghai
```

启动与日常操作：

```bash
cp .env.example .env
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d
docker compose logs -f
docker compose down
```

| 步骤 | 说明 |
| --- | --- |
| 填 `.env` | 至少填 `SUBPILOT_TOKEN`；`cp .env.example .env` 后编辑即可 |
| 建 `data` 目录并改属主 | 容器以 uid 1000 运行，不做这步会报 `unable to open database file` |
| `docker compose up -d` | 后台启动；用镜像时不需要 `--build`，改成本地构建才要 |
| `docker compose logs -f` | 看启动日志（会打印数据库路径、后端地址、令牌是否已设置） |

启动后打开 `http://<服务器>:8795`，输入 `.env` 里的令牌登录。
数据落在宿主机 `./data`，删容器不丢；备份就是打包这个目录。

镜像为 `node:22-alpine` 两段构建，非 root 运行，带 `HEALTHCHECK`（探 `/healthz`）。

### 二、Cloudflare Worker（一键部署）

点下面的按钮，授权 GitHub 与 Cloudflare，其余都在网页上完成：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/guanxi660-crypto/SubPilot)

部署表单里**只有一个必填项**：

| 表单项 | 怎么填 |
| --- | --- |
| 项目名称 | 默认 `subpilot`，可改 |
| `SUBPILOT_TOKEN` | **唯一要填的**。填一个随机串（建议 `openssl rand -hex 24`），这就是登录令牌 |
| `SUB_BACKEND` / `TZ` / `DB_FILE` | 已预填默认值，**不用动** |
| 启用预构建 | 保持开启（部署时自动构建前端） |

点「部署」即可，KV 等资源由部署流程按 `wrangler.jsonc` 的声明自动创建并绑定。
完成后打开分配的 `*.workers.dev` 地址（或你绑定的自定义域），输入刚才填的
`SUBPILOT_TOKEN` 登录。

之后想用本地 wrangler 管理同一个 Worker：

```bash
cd apps/server
npx wrangler deploy -c wrangler.jsonc
npx wrangler secret put SUBPILOT_TOKEN -c wrangler.jsonc
```

| 命令 | 作用 |
| --- | --- |
| `wrangler deploy` | 改完后端代码或重新构建前端后重新部署 |
| `wrangler secret put SUBPILOT_TOKEN` | 换访问令牌（改完所有已登录设备需重新输入） |

两点容易踩：

- `wrangler.jsonc` 里的 `name` 必须与线上 Worker 一致 —— 改了名字 `wrangler deploy`
  会**新建**一个 Worker，而自定义域仍指向旧的，表现为「部署成功但线上没变」。
- **换自定义域名**：Dashboard → Worker → Settings → Domains & Routes 解绑 / 绑定即可。
  注意已生成的客户端配置里嵌的是**当时请求的 host**，换域后旧的 `/feed/...`、`/download/...`
  地址会失效，需要重新分发。

### 三、Node / 免费容器平台（zip 上传）

适合 Render、Railway、Koyeb、Zeabur、Northflank 这类「传代码或传包就跑」的免费平台。
到 [Releases](../../releases) 下载 `subpilot-<版本>-node.zip`（内含后端源码、Node 适配层、
前端产物与运行时依赖 `yaml`，解压即跑），上传到平台后：

| 配置项 | 取值 |
| --- | --- |
| 启动命令 | `node apps/server/node/server.mjs` |
| 监听端口 | 从环境变量 `PORT` 读取，默认 `8795` |
| 必填环境变量 | `SUBPILOT_TOKEN` |
| 持久化 | **必须挂一个持久卷并把 `DB_FILE` 指到卷内**，否则平台重启后数据全丢 |

平台若支持直接用 Dockerfile，把 zip 换成「选本仓库 + 自动识别 Dockerfile」更省事，
配置与上面一致。

裸机 / 自己的服务器上跑也是同一套：

```bash
npm run install:all
npm run build
SUBPILOT_TOKEN='<你的令牌>' npm start
```

| 命令 | 作用 |
| --- | --- |
| `npm run install:all` | 安装依赖（含前端构建所需） |
| `npm run build` | 构建前端到 `apps/web/dist` |
| `npm start` | 起服务，监听 `http://0.0.0.0:8795` |

需要 **Node 22.5+**（`node:sqlite` 内置），无需原生编译工具链。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SUBPILOT_TOKEN` | 空 | **访问令牌，为空时所有受保护接口 401**（fail-closed）。必填 |
| `SUB_BACKEND` | `https://subpilot.57995799.xyz` | 转换后端（SCE）地址。**项目已预置公益默认后端，留空即用它**；想换自建实例就填自己的地址，也可登录后在「转换」页改 |
| `DB_FILE` | `apps/server/data/subpilot.db` | SQLite 文件位置（容器内 `/data/subpilot.db`） |
| `PORT` | `8795` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ASSETS_DIR` | `apps/web/dist` | 前端产物目录 |

### 反向代理

`/feed/*`、`/download/*` 的地址会被写进客户端配置，取的是**请求的 origin**，
反代必须传 `X-Forwarded-Proto` 与 `X-Forwarded-Host`，否则会把内网地址写进配置。
AI 助手是 SSE 长连接，nginx 需关闭该路径的 buffering。

## 本地开发

```bash
npm run install:all
npm run dev:server
npm run dev:web
```

三条命令依次是：

| 命令 | 作用 |
| --- | --- |
| `npm run install:all` | 安装前后端依赖（逐个包安装，不用 workspaces） |
| `npm run dev:server` | 起后端（Worker 形态） |
| `npm run dev:web` | 起前端 dev server |

后端跑起来后打开 `http://127.0.0.1:8795`，令牌填 `dev-local-token`
（该值来自 `apps/server/wrangler.dev.jsonc`）。前端 dev server 在
`http://127.0.0.1:5175`，只改界面时用它更方便。

想跑**自建那套**（Node + SQLite，与 Docker 镜像同一份代码）：

```bash
npm run build
SUBPILOT_TOKEN=dev-local-token npm start
```

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 构建前端，产物写到 `apps/web/dist` |
| `npm start` | 起自建形态后端，监听 `http://127.0.0.1:8795`，数据落在 `apps/server/data/` |

> **改完前端要重启服务。** Worker 的 assets 清单在启动时快照，重新 build 后
> 新 hash 的 JS 会 404（`index.html` 已指向新文件，表现为白屏 + 两个 404）。

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
