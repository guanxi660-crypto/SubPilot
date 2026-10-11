# SubPilot

> **当前分支 `dev`** —— Docker / Node.js 自建部署版（SQLite 存储 + node:vm 脚本沙箱）
> · Cloudflare Worker 部署请看 [`main` 分支](../../tree/main)

一体化订阅管理面板：**订阅管理 · 节点拼接（组合）· 格式转换 · 文件与文档管理 · AI 助手**。

前端是 Vue 3 单页应用；后端部署到 **自建 Node / Docker**，存储用 SQLite。

```
浏览器（Vue 3 SPA）
  订阅 · 组合 · 文件 · 转换 · 同步 · AI 助手 · 设置
        │
        │  /api/*（Bearer 令牌）
        ▼
SubPilot 服务端 ──────────────────────────────────────────────
   ├── 存储        SQLite（node:sqlite 内置）
   │               订阅 / 组合 / 文件 / 成品 / 分享码 / 设置
   ├── 节点处理    解析 + JSON 算子链（筛选 / 排序 / 重命名 / 去重 / 自定义脚本 …）
   ├── 文档管理    规则集 / 模板 / 片段，生成链接与分享链接
   ├── AI 助手     OpenAI 兼容接口 SSE 代理（API Key 不下发浏览器）
   ├── 同步推送    Gist / WebDAV 备份恢复、Telegram 推送
   └── 转换        调用转换后端 ──► Clash / sing-box / Shadowrocket …
                     ▲
        /feed/* ─────┘  供后端回拉处理后的节点
        /download/*、/share/*   客户端直接拉取（只读分发密钥）
```

[本项目默认后端版本](https://subpilot.57995799.xyz/version)

基于 [SubConverter-Extended](https://github.com/Aethersailor/SubConverter-Extended)

该实例由作者自建、**公益免费提供**，`SUB_BACKEND` 已预置此地址，开箱即用；
不承诺可用性与稳定性，请勿滥用，有稳定性要求请换自建后端。

**出处引用**：算子链 DSL 与 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 保持兼容；
完整第三方声明见 `NOTICE` 与文末「许可」。

## 截图

| | |
| --- | --- |
| ![概览](shots/11-概览-玻璃.png) | ![订阅](shots/02-订阅.png) |
| ![订阅编辑](shots/03-订阅编辑.png) | ![转换](shots/06-转换.png) |
| ![文件](shots/05-文件.png) | ![AI 助手](shots/08-AI助手.png) |

更多页面与亮色 / 暗色 / 玻璃三种主题的对比见 [shots/](shots/)。

## 部署

### Cloudflare Worker 部署

> Cloudflare Worker（KV 存储 + QuickJS WASM 脚本沙箱）的部署方式已移至
> [`main` 分支](../../tree/main#部署)。该分支包含 wrangler 配置、QuickJS WASM 集成、
> 以及对应的 README 说明。

### Docker（推荐）

**快速方式（一条命令）**，适合先跑起来看看：

```bash
docker run -d --name subpilot --init \
  -p 8795:8795 \
  -e SUBPILOT_TOKEN='<你的令牌>' \
  -v subpilot-data:/data \
  ghcr.io/guanxi660-crypto/subpilot:latest
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
    image: ghcr.io/guanxi660-crypto/subpilot:latest
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

### Node / 免费容器平台（zip 上传）

适合 Render、Railway、Koyeb、Zeabur、Northflank 这类「传包就跑」的平台。

1. 到 [Releases](../../releases) 下载 `subpilot-<版本>-node.zip`，解压后把**整个目录**
   传上去。目录里带后端源码、Node 适配层、前端产物、运行时依赖 `yaml`，
   以及根目录的 `index.js` 入口。
2. 启动命令填 `node index.js`（填 `npm start` 也一样）。
3. 环境变量**要自己填**，平台不会替你填：

| 变量 | 必填 | 填什么 |
| --- | --- | --- |
| `SUBPILOT_TOKEN` | ✅ | 登录令牌，随机串（建议 `openssl rand -hex 24`）或 UUID |
| `PORT` | ✅ | **平台要求监听哪个端口就填哪个**（常见 `3000` / `8080` / `10000`；平台没要求就填 `8795`）。不填默认 `8795`，若与平台期望的端口不一致，健康检查会失败 |
| `DB_FILE` | ✅（要留数据） | 指到挂载卷里，如 `/data/subpilot.db`。**不挂卷、也不指过去，平台重启后数据全丢** |
| `HOST` | ❌ | 默认已是 `0.0.0.0`。**不要改成 `127.0.0.1`**，否则容器外部访问不到 |
| `SUB_BACKEND` | ❌ | 留空即用公益默认后端；想换自建实例再填 |

> 只需要暴露**一个**端口，就是上面 `PORT` 那个 —— 服务只监听它，另外开 8795 没有用。

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

### 本地开发

```bash
npm run install:all
npm run dev:server
npm run dev:web
```

三条命令依次是：

| 命令 | 作用 |
| --- | --- |
| `npm run install:all` | 安装前后端依赖（逐个包安装，不用 workspaces） |
| `npm run dev:server` | 起后端（Node 形态，`node index.js`） |
| `npm run dev:web` | 起前端 dev server |

后端跑起来后打开 `http://127.0.0.1:8795`，令牌填 `dev-local-token`
（该值来自 `apps/server/wrangler.dev.jsonc`）。前端 dev server 在
`http://127.0.0.1:5175`，只改界面时用它更方便。

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

nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8795;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

Caddy（Caddyfile）：

```caddy
example.com {
    reverse_proxy 127.0.0.1:8795 {
        flush_interval -1
    }
}
```

## 许可

AGPL-3.0-only，见 [LICENSE](LICENSE)。第三方组件与出处见 [NOTICE](NOTICE)。