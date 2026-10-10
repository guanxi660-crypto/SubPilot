# SubPilot

一体化订阅管理面板：**订阅管理 · 节点拼接（组合）· 格式转换 · 文件与文档管理 · AI 助手**。

前端是 Vue 3 单页应用；后端同一份 `apps/server/src/`，可部署到 **Cloudflare Worker**
或**自建 Node / Docker**，两者接口与行为一致，只有存储形态不同。
其中**格式转换委托给外部** [SubConverter-Extended](https://github.com/Aethersailor/SubConverter-Extended)
（下称 SCE），其余能力（存储、节点处理、分发、同步、推送、AI）都由本站实现。

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
   └── 转换        委托 SCE ──► Clash / sing-box / Shadowrocket …
                     ▲
        /feed/* ─────┘  供 SCE 回拉处理后的节点
        /download/*、/share/*   客户端直接拉取（只读分发密钥）
```

> **默认转换后端**是作者自建的 SCE 实例，`SUB_BACKEND` 已预置该地址，开箱即用、
> 公益免费（不承诺可用性，请勿滥用；有稳定性要求请换自建后端）。出处与第三方声明见
> [`NOTICE`](NOTICE) 与文末「许可」。

**出处引用**：界面与交互承袭前身项目
[SubPilot-Archive](https://github.com/guanxi660-crypto/SubPilot-Archive)（已归档）；
算子链 DSL 与 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 保持兼容；
格式转换由 [SubConverter-Extended](https://github.com/Aethersailor/SubConverter-Extended) 提供。
三者均为 AGPL / GPL 系协议，完整声明见 [`NOTICE`](NOTICE)。

<p align="center">
  <img src="shots/01-概览.png" width="49%" alt="概览" />
  <img src="shots/02-订阅.png" width="49%" alt="订阅管理" />
</p>
<p align="center">
  <img src="shots/06-转换.png" width="49%" alt="转换" />
  <img src="shots/08-AI助手.png" width="49%" alt="AI 助手" />
</p>

## 与转换后端（SCE）的分工

SCE 是**无状态**的转换服务：只有 `/sub`、`/version`、`/healthz` 等少数路由，
没有存储 API，也不保存你的订阅。于是分工是：

- **本站负责** —— 订阅 / 组合 / 文件的存储与编辑、节点级处理（JSON 算子链）、
  分发链接与分享码、备份同步、Telegram 推送、AI 助手。这些 SCE 都不提供。
- **SCE 负责** —— 目标格式转换。转换页（`/sub?target=xxx`）与成品保存走这条路，
  产出 Clash / sing-box / Shadowrocket 等客户端配置。
- **分发通道不做转换** —— `/download/*`、`/share/*` 只输出编辑后的订阅原文（见下节），
  避免下游拿到转换结果再转一次。

## 分发链接语义（重要）

分享 / 分发链接**只输出编辑后的订阅，不做任何格式转换**（Sub-Store 模式）：

- URI 来源 → v2ray base64 通用订阅，各客户端直接导入，也可再当转换输入；
- clash 来源 → 本地序列化的 clash YAML；
- `?target=` 参数在分发通道**被忽略**（老链接兼容）。

这样分享出去的链接不会被下游二次转换。需要特定客户端格式时，去**转换页**
（`/sub?target=xxx`）或保存成品（`/api/converted`）—— 那两条路仍走 SCE。

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

## 部署到 Cloudflare Worker

```bash
cd apps/server
npx wrangler kv namespace create DATA -c wrangler.jsonc
npx wrangler secret put SUBPILOT_TOKEN -c wrangler.jsonc
cd ../..
npm run deploy
```

| 命令 | 作用 |
| --- | --- |
| `kv namespace create DATA` | 创建 KV 命名空间，**把输出的 id 填回 `wrangler.jsonc`** |
| `secret put SUBPILOT_TOKEN` | 设置访问令牌（未设置时受保护接口一律 401） |
| `npm run deploy` | 先 `vite build` 再 `wrangler deploy` |

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

### 裸 Node

需要 **Node 22.5+**（`node:sqlite` 内置），无需原生编译工具链。

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
