# SubPilot

面向 [SubConverter-Extended](https://github.com/Aethersailor/SubConverter-Extended)（下称 SCE）的订阅管理控制台。

界面与交互沿用前身项目 [SubPilot-Archive](https://github.com/guanxi660-crypto/SubPilot-Archive)（已归档），但**转换层不自己实现** —— 所有 target 格式的产出都交给 SCE，
本项目只负责 SCE 不具备的那部分：**存储、节点处理、分发**。

```
浏览器
  │  /api/*  管理接口（Bearer 令牌）
  ▼
SubPilot 服务端 ──┬── 存储：Cloudflare KV（Worker）/ SQLite（自建）
  │                 │        订阅 / 组合 / 文件 / 成品 / 分享码 / 设置
  │                 ├── 节点解析 + JSON 算子链（筛选 / 排序 / 重命名 …）
  │                 │
  │  /sub           └──► SubConverter-Extended  ──► Clash / Surge / Quantumult X / Sing-box …
  │  /feed/*  ◄── SCE 回拉处理后的节点列表
  │  /download/*     客户端直接拉取的分发链接
  ▼
Clash / Surge / Stash / Shadowrocket …
```

`apps/server/src/` 是同一份代码，可部署到 **Cloudflare Worker** 或**自建 Docker / Node**
（`apps/server/node/` 是适配层，见「部署到 Docker / Node」）。两者接口与行为一致，
只有存储的物理形态不同。

<p align="center">
  <img src="shots/01-概览.png" width="49%" alt="概览" />
  <img src="shots/02-订阅.png" width="49%" alt="订阅管理" />
</p>
<p align="center">
  <img src="shots/06-转换.png" width="49%" alt="转换" />
  <img src="shots/08-AI助手.png" width="49%" alt="AI 助手" />
</p>

## 为什么需要它

SCE 是**无状态**的：只有 `/sub`、`/version`、`/healthz`、`/inspect`、`/dashboard`、`/getruleset`
六个路由，没有任何存储 API。它接受 `url=`（远程订阅地址）或 `node:`（内联节点，仅 Clash），
**不接受任意内联节点列表**，也不保存你的订阅。

于是本项目补上三件事：

1. **存储** —— 订阅、组合、文件、分享码、设置存在服务端（Worker 用 KV，自建用 SQLite）。
2. **节点处理** —— 用一份 JSON 脚本描述筛选、排序、重命名规则，在服务端执行。
3. **分发** —— 处理后的节点通过 `/feed/*` 暴露给 SCE 拉取；客户端则拿 `/download/*`。

## 功能

| 模块 | 说明 |
| --- | --- |
| 概览 | 资源计数统计卡、转换后端状态（在线 / 版本 / 诊断台入口）与分发统计表；不再放订阅 / 组合 / 成品的重复列表 —— 它们各有独立页面 |
| 订阅管理 | 远程订阅 / 本地节点内容，拖拽排序；编辑页左 1 右 2 布局（左侧实时预览节点，右侧基本信息与 JSON 脚本上下堆叠），改名自动同步引用它的组合 |
| JSON 脚本处理 | 14 种算子组合成链：正则筛选、地区筛选、类型筛选、无效节点过滤、正则重命名、正则删除、名称前后缀、排序、**地区置顶**（不改名把指定地区挪到最前/最后）、去重、国旗、限量、快捷设置。直接内联在订阅 / 组合的编辑页，不单开模块。每个算子展开后都有**使用说明**（与参数编辑器合成一块，上说明下参数），工具栏另有「? 填法速查」一次列出全部算子的填法 |
| 算子模板 | 内置 1 条「一键整理（推荐）」（无效过滤 → 去广告 → 削机场前缀 → 去重 → 按地区排序 → 加国旗，**不含地区筛选**，避免误删用户真正想要的地区），另可**自定义模板**：把调好的链存下来复用，支持改名 / 改 JSON / 删除（「模板管理」的编辑走**独立大弹窗**，20 行 JSON 编辑区，不在小卡片里滚动），存在服务端快照里跨设备可用。套用模板是**整条覆盖**，链上已有算子时会先确认 |
| 组合 | 多个订阅合并为一个产出，可叠加组合层算子链 |
| 文件 | 规则集 / 模板 / 片段；每张卡片上并列「生成链接」「分享链接」两个按钮，生成的链接就地展开在卡片下方（可复制 / 删除），不另占版面 |
| 转换 | 8 种目标格式（clash / sing-box / Shadowrocket / VLESS / Hysteria2 / Trojan / SS / SSR；清单由 `docs/目标格式体检报告.md` 用真实订阅逐格式实测后裁剪而来，只留能稳定出节点的），生成分发链接（只读密钥）与 feed 地址；**带管理令牌的预览链接不再显示**（排障时从地址栏拿即可）；「输入源 → 转换后端 → 参数」合并在同一模块内，参数区默认折叠且开关一律不勾选；「外部配置 / 模板」用 SubPilot-Archive 同款预设（104 项，按来源分组）+ 自定义地址；**多选来源同样有分发链接**（后端把选择折成 adhoc spec 走同一套派生密钥，以前多选时链接直接消失）；下方「成品」列表展示保存过的快照（⤓ 下载 / 固定分享链接 / ✈ TG 推送 / 删除），保存后立即出现 |
| AI 助手 | 描述需求生成 JSON 脚本，SSE 流式输出；系统提示词内置**算子技能**（按「要改变什么」选工具：改顺序 / 改名字 / 改存在 / 改字段 + 常见任务 JSON 对照），并在缺能力时提供新算子而非改名凑合；提案给出「预览 / 忽略 / 保存」三个**一次性**按钮。「预览」把提案当算子链跑一遍管线，**弹窗**列出处理后的**全部节点**（不截断、不写库，节点名里的国旗完整可见），「保存」直接写入当前目标（订阅 / 组合 / 自定义模板）的算子链（整体覆盖，非追加），忽略或保存后按钮不再出现。来源下拉里可选**自定义模板**，等于让 AI 直接编辑模板；系统提示词会据此切换口径（模板要写得通用，不写死某份订阅的机场名） |
| 同步 | Gist / WebDAV 备份恢复，含 SSRF 防护；**Telegram 推送**：配置 Bot Token 与推送 ID（支持数字 / @频道名，最多 20 个），按 订阅 / 组合 / 文件 / 成品 用**胶囊按钮**多选推送目标（与转换页「输入源」同一套交互），可指定推送链接格式；订阅 / 组合 / 文件 / 成品的卡片各带「✈ TG」按钮可单项推送。推送链接一律走**只读**分发通道（订阅组合用 HMAC 派生密钥、文件成品复用既有分享码，不重复建码），不会把管理令牌带进聊天记录；Bot Token 只存服务端，接口只回掩码。开启「即时推送」后，被勾选的目标发生增删改会在 15 秒防抖窗口内自动推送（保存成品也算一次变动） |
| 分发统计 | 记录 `/download/*` 与 `/share/*` 的拉取次数与来源 IP，可导出 CSV。成品分享计为「分享成品」 |

## 目录结构

```
subpilot/
├─ apps/server/            Cloudflare Worker
│  ├─ src/
│  │  ├─ index.js          入口与路由分发、鉴权
│  │  ├─ api.js            /api/* REST 处理器
│  │  ├─ convert.js        /sub /feed /download /share 分发中枢
│  │  ├─ sce.js            SubConverter-Extended 客户端
│  │  ├─ pipeline.js       取源 → 解析 → 算子 → 序列化
│  │  ├─ operators.js      JSON 算子链实现 + 内置模板（PROCESS_PRESETS）
│  │  ├─ templates.js      自定义算子模板的校验与增删改查
│  │  ├─ nodes.js          节点解析、地区识别、序列化
│  │  ├─ feedkey.js        HMAC 派生只读分发密钥
│  │  ├─ ai.js             AI 助手 SSE 代理
│  │  ├─ sync.js           Gist / WebDAV 同步
│  │  ├─ telegram.js       TG 推送（配置 / 测试 / 推送 / 变动即时推送）
│  │  ├─ storage.js        快照存储（驱动可替换：KV / SQLite）
│  │  └─ util.js           通用工具
│  ├─ node/                自建部署适配层（Docker / 裸 Node，见「部署到 Docker / Node」）
│  │  ├─ server.mjs        node:http ↔ web Request/Response 桥接 + 响应压缩 + 优雅关闭
│  │  ├─ sqlite-store.mjs  SQLite 存储驱动（node:sqlite 内置，行级 UPSERT + WAL）
│  │  └─ assets.mjs        静态资源服务（ETag / SPA 回退 / 防路径穿越）
│  ├─ wrangler.jsonc       生产配置
│  └─ wrangler.dev.jsonc   本地开发配置
├─ apps/web/               Vue 3 + Vite + Tailwind + Naive UI
│  └─ src/
│     ├─ views/            各页面
│     ├─ components/       ConfigSelect（远程配置选择器）、TgPushButton（卡片 TG 按钮）、OperatorEditor、NodeList …
│     ├─ stores/           auth / theme / operators
│     └─ utils/            name（名称校验）、configPresets（SubPilot-Archive 同款模板预设）、inputs（反浏览器自动填充声明）
├─ scripts/
│  ├─ verify.mjs           后端端到端验证（干净环境下全跑；检测到真实数据时自动跳过写入类断言，见下）
│  ├─ verify-operators.mjs 11 项算子回归（Region Pin 置顶不改名 / 多地区优先级 / 沉底 / 与 Sort 组合）
│  ├─ verify-regions.mjs   56 项地区识别回归（真实节点名用例 / 53 个地区与旗帜 / 短国家码整词边界不误判）
│  ├─ verify-converted-share.mjs  30 项成品分享回归（固定链接不变 / 原样吐出 / 403 边界 / 码归一与回收 / TG 目标落库）
│  ├─ verify-adhoc-link.mjs       18 项多来源分发回归（sp:// 解析 / adhoc 链接 / 每条订阅的算子生效 / 密钥校验）
│  ├─ verify-ui-converted.mjs     20 项转换页界面回归（预览链接隐藏 / 多选分发链接不消失 / 成品卡固定链接 / 无控制台错误）
│  ├─ verify-ui.mjs        108 项界面交互验证（地址栏同步、跳转、分享面板、参数折叠、配置选择、TG 推送与目标胶囊、AI 提案三按钮与预览弹窗、成品保存、反浏览器自动填充）
│  │                       设置页不再展示访问令牌（由 Worker secret 固定，登录页负责输入）
│  ├─ verify-storage.mjs   22 项存储层回归（行级写入量 / 纯重排不重写正文 / 统计行级 UPSERT / 重启持久化）
│  ├─ verify-presets.mjs   远程配置预设与 SubPilot-Archive 的一致性比对
│  └─ shots.mjs            逐页截图（14 张：10 张页面 + 概览三主题 + 订阅页玻璃主题）+ 控制台错误检查
├─ Dockerfile              两段构建镜像（alpine，非 root，含 HEALTHCHECK）
├─ docker-compose.yml      单容器部署
├─ .env.example            SUBPILOT_TOKEN / SUB_BACKEND / TZ / DB_FILE
├─ LICENSE                 AGPL-3.0-only 全文
└─ NOTICE                  第三方组件与出处声明（Sub-Store / SubPilot-Archive / SubConverter-Extended）
```

## 本地开发

```bash
npm run install:all     # 安装前后端依赖（逐个包安装，不用 workspaces）
npm run dev:server      # Worker → http://127.0.0.1:8795
npm run dev:web         # 前端 dev server → http://127.0.0.1:5175
```

浏览器打开 `http://127.0.0.1:8795`，令牌填 `dev-local-token`（见 `wrangler.dev.jsonc`）。

> 端口刻意选 8795 而不是 SubPilot-Archive 用的 8793，避免两个项目同时跑时互相抢端口。

想直接跑**自建部署的那套**（Node + SQLite，就是 Docker 镜像里跑的同一份代码）：

```bash
npm run build          # 先构建前端，产物在 apps/web/dist
SUBPILOT_TOKEN=dev-local-token npm start   # → http://127.0.0.1:8795，数据落在 apps/server/data/
```

`npm start` 等价于 `node --disable-warning=ExperimentalWarning apps/server/node/server.mjs`，
和 `dev:server` 的差别只在存储：前者 SQLite（落盘文件），后者 wrangler 里的 KV 模拟。
两条路的接口行为一致，验证脚本对哪边跑都成立。

### 验证

```bash
npm run dev:server                    # 先起服务
node scripts/verify.mjs               # 接口验证（检测到真实数据时自动跳过写入类断言）
node scripts/verify-converted-share.mjs  # 成品分享回归（30 项，自带数据清理）
node scripts/verify-adhoc-link.mjs    # 多来源分发回归（18 项，自带播种与清理）
node scripts/verify-ui-converted.mjs  # 转换页界面回归（20 项，自带播种与清理）
node scripts/verify-regions.mjs       # 地区识别回归（56 项，纯函数不需起服务）
node scripts/verify-operators.mjs     # 算子回归（11 项，纯函数不需起服务）
node scripts/verify-storage.mjs       # 存储层回归（22 项，直接开临时库，不需起服务）
node scripts/verify-presets.mjs       # 模板预设与 SubPilot-Archive 一致性
node scripts/shots.mjs                # 逐页截图到 shots/，并检查控制台错误
node scripts/verify-ui.mjs            # 108 项界面交互验证（需先跑 shots 播种数据）
```

### 验证脚本的安全边界

这套脚本会在本地库里写数据，其中三个动作**具有破坏性**：

- `verify.mjs`：写假 AI 密钥、写假 TG token、轮换分发密钥
- `verify-converted-share.mjs`：建临时成品 + 临时分享码 + 临时 TG 目标（收尾全部还原）
- `verify-adhoc-link.mjs`：建两条临时订阅（各带不同算子链，收尾删除）
- `verify-ui-converted.mjs`：建临时成品 + 临时分享码 + 两条临时远程订阅（收尾全部删除）
- `shots.mjs`：清空全部订阅 / 组合 / 文件 / 成品 / 分享码，再播种演示数据
- `verify-ui.mjs`：生成分享码（收尾时会自己删掉）

所以前两者都带守门，默认**只对演示数据生效**：

- `verify.mjs` 发现非 `__verify__` 前缀的订阅 / 组合 / 文件时，跳过写入类断言
  （设置页密钥遮蔽、分发密钥轮换、TG 配置写入），
  并输出 `~ 检测到 N 项真实数据，跳过写入类断言`。
  原因是 AI key 与 TG token 都只下发掩码，一旦被假值覆盖就再也拿不回来。
- `shots.mjs` 发现白名单外的条目（含任何分享码）时**直接拒绝执行**并逐条列出，
  确认要清空才加 `SHOTS_FORCE=1`。

确实需要强制跑全部写入类断言时：`VERIFY_FORCE_WRITE=1 node scripts/verify.mjs`。

`shots.mjs` 会先清空服务端的资源（Worker 上就是 KV）再播种演示数据，可反复运行。
它依赖 `playwright-core` + 本机已缓存的 chromium，不额外下载浏览器：

```bash
cd apps/web && npm install --no-save playwright-core
```

> **改完前端必须重启 `dev:server`。** Worker 的 assets 清单在启动时快照，
> 重新 `npm run build` 后新 hash 的 JS 会被 404（`index.html` 却已经指向新文件，
> 表现为白屏 + 两个 404）。重启即可。

## 部署到 Cloudflare

```bash
# 1. 创建 KV namespace，把输出的 id 填进 apps/server/wrangler.jsonc
cd apps/server
npx wrangler kv namespace create DATA -c wrangler.jsonc

# 2. 设置访问令牌（未设置时所有受保护接口一律 401，fail-closed）
npx wrangler secret put SUBPILOT_TOKEN -c wrangler.jsonc

# 3. 构建前端并部署（前端产物由 Worker 的 assets 绑定同域提供）
cd ../.. && npm run deploy
```

首次打开站点输入同一令牌即可登录。转换后端地址默认 `https://subpilot.57995799.xyz`，
可在「转换」页的「转换后端」卡片里改成自建实例；留空则回落到 `SUB_BACKEND` 环境变量。

> 本项目**不能**用纯 API 单文件上传方式部署：Worker 是多模块
> （`main: src/index.js` + 10 个模块）+ `assets` 静态资源 + KV 绑定 + secret，
> 必须走 wrangler。

### 日常运维

```bash
# 改完后端代码或重新构建前端后，重新部署
cd apps/server && npx wrangler deploy -c wrangler.jsonc
# 或从仓库根：npm run deploy（先 vite build 再 wrangler deploy）

# 换访问令牌（改完所有已登录设备需重新输入令牌）
printf '%s' '<新令牌>' | npx wrangler secret put SUBPILOT_TOKEN -c wrangler.jsonc
```

**换自定义域名**：在 Cloudflare Dashboard 的 Worker → Settings → Domains & Routes 里
解绑旧域、绑定新域即可（Cloudflare 会自动建好 `AAAA <host> → 100::` 的 proxied 记录）。
两个容易踩的点：

- 已生成的客户端配置里嵌的是**当时请求的 host**，换域名后旧的 `/feed/...`、`/download/...`
  地址会失效，需要重新分发；若在「设置 → 公开地址」里填了固定域名，也要同步改。
- `apps/server/wrangler.jsonc` 里的 KV id 与 `SUB_BACKEND` 都是**部署者自己的**：
  换到自己的账号时先 `npx wrangler kv namespace create DATA` 拿到新 id，并把后端地址
  换成自己可用的实例。

### 关于仓库里的默认后端

仓库中 `SUB_BACKEND` 指向作者自建的 SubConverter-Extended 实例，**公益免费提供**，
不承诺可用性、稳定性与实时性，请勿滥用；长期使用或对稳定性有要求时请换自建后端。

## 部署到 Docker / Node

不想用 Cloudflare 时，同一份 `apps/server/src/` 可以跑在自建服务器上。
`apps/server/node/` 是一层薄适配，把 Worker 用到的 4 个平台专有能力换掉：

| Worker 专有 | 自建部署里的替代 |
| --- | --- |
| `env.DATA`（KV） | **SQLite**（`node:sqlite` 内置），经 `env.STORE` 注入 |
| `env.ASSETS.fetch` | `node/assets.mjs`（ETag / 缓存头 / SPA 回退 / 防路径穿越） |
| `ctx.waitUntil` | 吞异常的 fire-and-forget |
| `env.*` 环境变量 | 进程环境变量 |

其余能力（`fetch` / `crypto.subtle` / `atob` / `btoa` / `ReadableStream` / `AbortSignal.timeout`）
Node 18+ 原生就有，没有垫片。

> **为什么不用 miniflare / workerd 直接跑。** 两者的官方定位是**开发期模拟器**
> （`wrangler dev` 本身就是它们），依赖 workerd 这个平台相关的原生二进制，官方不把它们
> 当生产运行时。这里真正需要的只是「web 标准 `Request`/`Response` ↔ `node:http`」这点胶水，
> 自己写比拉进一整个 workerd 更可控，镜像也小一个数量级。

### 方式一：Docker Compose（推荐）

```bash
cp .env.example .env      # 填 SUBPILOT_TOKEN，建议 openssl rand -hex 24
docker compose up -d --build
```

打开 `http://<服务器>:8795`，输入 `.env` 里的令牌登录。
数据全部落在宿主机的 `./data` 目录（挂到容器的 `/data`），删容器不丢数据。

> **首次启动若报 `unable to open database file`** —— 是目录权限问题。容器以非 root 的
> `node` 用户（uid 1000）运行，而 compose 自动创建的 `./data` 属于 `root`：
>
> ```bash
> mkdir -p data && sudo chown -R 1000:1000 data
> ```
>
> 或者改用具名卷（Docker 会把镜像里 `/data` 的属主带过来，无需手动 chown）：
> 把 `docker-compose.yml` 里的 `./data:/data` 换成 `subpilot-data:/data`，
> 并在文件顶部加一段 `volumes: { subpilot-data: }`。代价是备份要走 `docker run --rm -v ...`。

```bash
docker compose logs -f          # 看日志
docker compose down             # 停止（数据保留）
docker compose up -d --build    # 改完代码重建
```

镜像细节：`node:22-alpine` 两段构建，第一段装前端依赖并 `vite build`，第二段只装运行时依赖
（`apps/server` 的 `dependencies` 只有一个 `yaml`，`wrangler` 是 devDependency 会被跳过），
所以最终镜像里没有构建工具链，也没有 workerd。以非 root 的 `node` 用户运行，
带 `HEALTHCHECK`（探 `/healthz`）。

### 方式二：裸 Node（不用 Docker）

需要 **Node 22.5+**（`node:sqlite` 从 22.5 开始内置）。不需要任何原生编译工具链。

```bash
npm run install:all                 # 装依赖
npm run build                       # 构建前端 → apps/web/dist
SUBPILOT_TOKEN='<你的令牌>' npm start   # → http://0.0.0.0:8795
```

`npm start` 就是 `node --disable-warning=ExperimentalWarning apps/server/node/server.mjs`。
启动日志会打印数据库路径、静态资源目录、后端地址与令牌是否已设置。

> `--disable-warning=ExperimentalWarning` 只是静音 `node:sqlite` 那行
> 「SQLite is an experimental feature」提示 —— API 本身稳定可用，功能不受影响。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SUBPILOT_TOKEN` | 空 | **访问令牌。为空时所有受保护接口一律 401**（fail-closed）。必填 |
| `SUB_BACKEND` | 空 | 转换后端（SCE）地址。留空则登录后在「转换」页配置 |
| `DB_FILE` | `apps/server/data/subpilot.db`（容器里 `/data/subpilot.db`） | SQLite 文件位置 |
| `PORT` | `8795` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ASSETS_DIR` | `apps/web/dist` | 前端产物目录 |

`TZ` 不是程序读的，是给容器和日志用的（`docker-compose.yml` / `.env.example` 里有）。

### 放在反向代理后面

`/feed/*`、`/download/*` 的地址会被写进客户端配置，`publicBaseUrl()` 取的是**请求的 origin**。
反代必须传 `X-Forwarded-Proto` 与 `X-Forwarded-Host`，否则会把 `http://内网地址`
写进给客户端的配置里（`server.mjs` 的 `toWebRequest()` 会优先读这两个头）。

nginx 还要注意 AI 助手是 SSE 长连接：

```nginx
location / {
    proxy_pass http://127.0.0.1:8795;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_buffering off;              # 否则 AI 助手的流式输出会被攒成一坨
    proxy_read_timeout 300s;          # 与 server.mjs 里关掉 requestTimeout 对应
}
```

`X-Real-IP` / `X-Forwarded-For` 影响「分发统计」里记录的来源 IP。

### 备份

数据就是一个 SQLite 文件。进程正常退出（`SIGTERM` / `docker compose stop`）时会做一次
WAL checkpoint，把 `-wal` 里的内容落回主库，所以：

```bash
docker compose stop                       # 或 systemctl stop
cp ./data/subpilot.db /path/to/backup/    # 单文件即完整备份
docker compose start
```

运行中也可以直接打包整个 `./data` 目录（含 `subpilot.db` / `-wal` / `-shm`），
三者要一起拷才是一致的。

## 关键设计

### 分发链接不放管理令牌

`/feed/*`、`/download/*` 的地址会被写进客户端的配置文件并长期使用，把管理令牌塞进去
等于把管理员凭据发给每一个拿到配置的人。

因此这两类路由用 **HMAC 派生的只读密钥** 自校验：

```
ft = base64url(HMAC-SHA256(SUBPILOT_TOKEN + '|' + feedSalt, "kind:name")).slice(0, 32)
```

单向、限资源、可整体轮换。设置页的「轮换分发密钥」会换掉 `feedSalt`，
所有旧链接立即失效（已实测：轮换前 200 → 轮换后 403，新链接 200）。

### 无算子时透传，有算子才中转

`target=clash` 时 SCE 会把远程订阅转成 `proxy-providers`，由客户端自己更新 —— 后端不代取。
一旦本地算子介入，就必须先取回节点再改写，于是改走 `/feed/*` 中转，把 feed 地址交给 SCE 的 `url` 参数。

### `/share/converted/…` 不再走一次转换

分享通道有四种资源，分发方式**刻意分成两路**：

| 类型 | 路由 | 处理方式 |
| --- | --- | --- |
| `sub` / `col` | `/share/<kind>/<name>?code=` | 原始订阅，交给 SCE **现转**（跟 `/sub` 一样带 target 参数） |
| `file` | `/share/file/<name>?code=` | 本地文本直接返回；远程文件 302 跳转 |
| `converted` | `/share/converted/<name>?code=` | **原样吐出快照**，绝不再转 |

成品是「已经转好的最终产物」。如果顺手复用 `/sub` 那条分支，SCE 会把一份 Clash 配置
当成原始订阅再解析一遍，产出的是垃圾 —— 而且 HTTP 200、不报错，只能靠对内容。
所以这里单开一条分支，并用 `contentTypeForTarget()` 按保存时的 `target` 反推 Content-Type
（clash → YAML、singbox → JSON、其余 → text/plain）。

对应地，TG 推送把可推送类型分成两组：`sub` / `col` 走 HMAC 派生密钥（无状态、不吃配额），
`file` / `converted` 走分享码。删除成品时后端会连带回收它的分享码，不留指向空资源的死链。

### 成品的分享链接是「固定」的

订阅 / 组合的分发链接本来就是确定的（同一个名字 + 同一个盐 → 同一个 `ft`），
但分享码是随机生成的，如果照「点一次生成一次」那套做，成品的链接每次都会变 ——
而它恰恰是会被嵌进客户端配置的东西，一变所有人都得重新分发。

所以成品的码有专门的幂等语义（`ensureConvertedShare`）：

- **保存成品那一刻自动建好**一条永久分享码，并挂在列表项上（`shareCode` 字段）随列表返回；
- **重转 / 重存 / 换 target，code 一律不变**，链接永远指向同一地址、内容永远是当前那份；
- 历史上如果同一条成品积了多条码（以前可以点多次「生成链接」），下次保存时
  **保留最早的那条**（最可能已经被分发出去）、其余回收，并把 `expiresAt` 归一成 null
  —— 固定链接不能自己到期，否则「不变」只是假象；
- 界面上因此没有「生成链接」按钮，卡片直接内联显示链接和「永久有效 · 重新保存不变」。

### 多来源转换也有分发链接（adhoc）

转换页一次勾选多个订阅 / 贴多个地址时，这组选择**没有名字可以寻址** ——
既不是某条订阅，也不是某个组合。以前前端在这里直接把分发链接清空，
用户手里就只剩带管理令牌的预览链接，等于没法把多来源的结果发出去。

现在的做法是把选择折成一个 base64 的 **adhoc spec**（`{sources:[{ref,ua,process}], process}`）：

- `POST /api/link` 收下来源列表，返回 `/download/adhoc?spec=…&ft=…` 和 `/feed/adhoc?spec=…&ft=…`；
- 密钥按 `shortHash(spec)` 派生，和具名来源走**同一套**派生机制，不占分享码、不需要落库；
- spec 是确定性编码 —— 同样一组选择永远得到同一条链接。

这里曾经叠着两个只在多选时才暴露的 bug，都已修掉并固化为 `verify-adhoc-link.mjs`：

1. `handleSub` 解析 `url` 参数时不认识 `sp://` 前缀，把它原样当 URL 丢给 SCE，
   得到 400「no valid proxy nodes or remote resources」—— **多选站内订阅必 400**；
2. adhoc spec 里没带每条订阅自己的 `process`，`/feed/adhoc → runPipeline` 里
   `item.process` 是空的，每条订阅自己的 JSON 脚本被**静默跳过**（节点照出，但没被筛选 / 改名 / 排序）。


### 存储是「单快照 + 可替换驱动」

逻辑上全部数据就是一份快照（`subs` / `collections` / `files` / `converted` / `shares` /
`templates` / `settings`）。快照整体读、整体写，所以**所有写操作都返回更新后的完整快照**，
前端直接覆盖本地状态，写完立刻读不会读到旧数据 —— 这一条对 KV 尤其重要，
因为 KV 是最终一致的（跨 colo 最长 60s），只回「成功」而不回数据的话，前端刷新就会看到旧内容。
自定义算子模板也存在这份快照里（`templates` 字段），因此备份导出 / 导入天然带着它们。

快照之下是**可替换的驱动**（`storage.js` 里 `driverOf(env)`），契约只有 4 个方法：
`readSnapshot` / `writeSnapshot` / `readStats` / `writeStats`。

| 部署方式 | 驱动 | 物理形态 |
| --- | --- | --- |
| Cloudflare Worker | `env.DATA`（KV） | `panel:snapshot:v1` 一个键，整份 JSON |
| Docker / 自建 Node | `env.STORE`（SQLite） | 六张表 + 一张顺序表，**行级 UPSERT** |

业务代码（`api.js` / `convert.js` …）不感知这个差别，两边跑同一套。

### Node 侧的 SQLite 为什么不是「一个大 JSON 字段」

最省事的做法是照抄 KV：一张表、一列 JSON，每次写整份序列化。**那样反而更慢** ——
订阅正文动辄几百 KB，改一个名字就要序列化并重写全部数据。所以 SQLite 驱动按实体拆表，
只 UPSERT 变化的那几行（`sqlite-store.mjs` 的 `planTable()` 对比前后快照算出 upserts / deletes）。

这里有个 SQLite 的性质必须绕：**一行记录是一个整体** —— 改这一行的任一列，
整行（含溢出页）都会被重写。于是「顺序」不能和正文同表：拖拽排序会让所有行的 `ord`
都变，等于把所有正文重写一遍。实测就是这么暴露的 —— 纯重排 817KB 写入量。

解法是把顺序单独放一张表：`order_index(collection, ids)`，一个集合一行、ids 是 JSON 数组。
纯重排只改这一行 → **817KB 降到 4KB**。这条性质由 `scripts/verify-storage.mjs` 守着：

```
✓ 改一条的写入量远小于改五条 — 1 行=213KB · 5 行=1018KB
✓ 改一条不会把整个数据集重写一遍 — 写入 213KB，单条正文 200KB，全量约 1000KB
✓ 纯重排的写入量远小于正文总量 — 4KB（正文合计 1000KB）
✓ 改一条统计的写入量远小于全量 — 1 条=4152B · 200 条=49472B
```

配套的库级设置：`journal_mode=WAL`（读写不互斥）、`synchronous=NORMAL`（不必每事务 fsync）、
`busy_timeout=5000`（防 `SQLITE_BUSY`）。主键选择上，`shares` 用 `code` 而非 `name`
（同一条成品历史上可能积多条码，且成品名可以重复）。

> 跑 `verify-storage.mjs` 时有个坑值得记一笔：WAL 是**追加**日志，写入量的测量必须先
> `PRAGMA wal_checkpoint(TRUNCATE)`，否则量到的是累计值。脚本里的 `measure()` 就是干这个的。

### 自建部署额外做的一件性能优化：响应压缩

Cloudflare 部署时压缩由边缘做，自建 Node 没有这一层 —— 1MB 的前端 JS 会原样发出去。
`server.mjs` 因此自己压：`Accept-Encoding` 优先 br（质量 5，比默认 11 快一个数量级、
压缩率仍有九成）再 gzip（级别 6），只压 ≥1KB 且类型可压的响应，
压缩结果按内容做键缓存（静态资源内容寻址，命中率接近 100%）。

另外 `createServer({ noDelay: true })` 关掉 Nagle、`keepAliveTimeout = 65s`
（比常见反代的 60s 略长，避免复用连接时服务端先关）、`requestTimeout = 0`
（AI 助手是长连接 SSE，默认 300s 会把长回答拦腰切断）。
**SSE 绝不缓冲**：`text/event-stream` 直接 `pipe` 到 socket，实测帧间隔与上游节奏一致。

### 地区识别用「整词」边界匹配

节点名里全是普通英文单词，≤3 字母的国家码不能用裸子串匹配：`online` 含 `nl`、
`Finland` 含 `fi`、`10in1` 含 `in` —— `vless FI.ulzix.Hetzner_Online` 就曾因为
`online` 被认成荷兰。`nodes.js` 的 `regionOf` 因此分两类匹配：

- **中文 / 旗帜 emoji / 长英文词**（`芬兰`、`🇫🇮`、`finland`、`hongkong`）仍用子串匹配 ——
  这些串在节点名里出现就是要表达地区
- **短国家码**（1–3 个字母）用整词正则 `(^|[^a-z])kw([^a-z]|$)`：两侧只要不是字母就算边界，
  数字、`.`、`_`、`-`、中文、首尾都算 —— `FI.`、`HK01`、`US_2` 能命中，
  `online`、`Finland`、`usb-stick` 不会

歧义用「**最长关键词优先**」压：`hongkong` 比 `hk` 具体。配套约束是
短国家码不得跨地区重复登记（97 个码全唯一，`verify-regions.mjs` 守门），
否则同长时谁先谁赢，取决于数组顺序。地区表现有 53 个地区，供
国旗算子 / 地区筛选 / 排序共用。

### 内置模板只有一条，且刻意不含地区筛选

早先是 4 条各自独立的模板，用户得挨个套用才能凑齐一条完整链 —— 但套用是**整条覆盖**
语义，所以「先套清理、再套排序」实际等于「只套了排序」，前一次的结果被静默冲掉。
现在合并成 1 条，链内顺序按依赖排：过滤 → 改名 → 去重（必须在改名之后，否则
改名造成的重名漏掉）→ 排序 → 国旗（放最后，免得 emoji 被「去掉 | 之前的内容」这类正则误伤）。

地区取舍**不进内置模板**：有人只要港台日新美、有人只要一个区，写死会误删用户真正想要的节点。
要筛地区请自己加一个「地区筛选」算子，或存成自定义模板。

### `Regex Rename` 的 regex 是「扁平数组、两两一组」——空串不能被过滤

```json
{ "type": "Regex Rename", "args": { "regex": ["^[^|｜]*[|｜]\\s*", "", "\\s{2,}", " "] } }
```

两组替换依次执行（先整条链跑第一对，再整条链跑第二对），与拆成两个算子**结果完全一致**。
内置模板里的「削机场前缀」和「压空格」就合并在这一条里 —— 拆开时两张卡片的图标、标题、
说明完全相同，折叠后只差一行 JSON，看着像重复了。

⚠️ 这里**不能**用 `asArray()` 归一化参数：它会把空串过滤掉，而「替换成空串」正是削前缀、
去尾巴最常用的写法。空串一被吃掉，整个 pairs 数组就左移错位（模式变成替换文本、末尾那个
替换文本又没有配对的模式），**静默改错名字**；更隐蔽的是数组只剩 1 个元素时循环条件
`i + 1 < len` 直接不成立，整步变成 no-op —— 内置模板原来的「削机场前缀」就这么空转了
很久没人发现。空**模式**则必须跳过（`new RegExp('', 'g')` 会匹配每个字符间隙，
把替换文本插得到处都是）。

这两条都固化在 `scripts/verify.mjs` 的 `[2b]` 段里，改这个算子时会立刻报出来。

自定义模板（`templates.js`）与内置模板**不允许重名** —— 下拉里出现两个同名项，
点哪个全凭运气。写入时直接拒掉；备份导入撞名时跳过并写进 `warnings`。

### AI 能直接编辑自定义模板

模板存在服务端而非 localStorage，原因就是这一条：AI 助手的调用发生在服务端
（API Key 不下发到浏览器），模板若只躺在某个浏览器里，AI 就没法把它当成可编辑的对象。
AI 助手页的来源下拉里可选自定义模板，选中后：

- 提案的「保存」写回该模板（`PATCH /api/template/:name`），而不是某个订阅
- 系统提示词切到「模板」口径，要求写得通用，不写死某份订阅的机场名 / 服务器名
- 模板自己不绑定订阅、没有节点，节点样例**借站内第一个订阅**的；借不到就给空，不编
- 编辑器的「模板管理 → AI 编辑」直接跳到 AI 助手并选中该模板


### 远程配置预设与 SubPilot-Archive 逐字对齐

`apps/web/src/utils/configPresets.js` 里的 104 条模板（分组名、组内顺序、URL）逐字取自
SubPilot-Archive 的 `apps/server/src/subconv/presets.js`，默认值同为
`Custom_OpenClash_Rules/Custom_Clash.ini`。两边选同一个模板会得到同样的策略组结构。

这份清单只在**前端**使用 —— 选中的 URL 直接作为 `config=` 交给 SCE 去拉取，
本项目的 Worker 不参与，因此没有为此新增接口。一致性可以直接跑脚本复验：

```bash
node scripts/verify-presets.mjs                                  # 在相邻目录自动找 SubPilot-Archive
node scripts/verify-presets.mjs /path/to/SubPilot-Archive                # 或显式传仓库路径
SUBPILOT_ARCHIVE_PATH=/path/to/SubPilot-Archive node scripts/verify-presets.mjs  # 或用环境变量
```

逐条比分组名、模板名、URL 与组内顺序，任一不同即失败。当前结果：7 组 / 104 条全等。

### 显式声明「这些密码框不是登录凭据」

本项目的密码框存的是**应用自己的密钥**（访问令牌 / AI Key / Gist PAT / WebDAV 应用密码 /
TG Bot Token），不是用户在站点上的登录凭据；访问令牌还已经存在 localStorage，浏览器再存一份
只会把它同步进 Google 账号。

但 Chrome 只要在页面上看到一个裸的 `type="password"`，就会把整页判成登录表单，
把旁边的普通文本框当「用户名」去填 —— 实测表现是点「设置 → AI 助手」的模型输入框时，
弹出的是浏览器里存的其他站点的账号，把候选模型列表整个盖掉。而且实测
`autocomplete="off"` **拦不住**这条页面级启发式，只写它没用。

实测有效的手段（全站统一走 `utils/inputs.js`）：

- **密钥框的终极形态：`type="text"` + `-webkit-text-security: disc`**（v3，
  `utils/inputs.js` 的 `secretFieldProps()`）—— 视觉仍是圆点，但密码管理器的启发式
  只认 `type="password"`，text 框不管长什么样都不会触发账号列表或「保存密码？」气泡。
  登录页访问令牌、Gist PAT、WebDAV 应用密码、TG Bot Token、API Key 全部走这套；
  不支持的浏览器（Firefox）由特性检测回退成 `type="password"` + `new-password`
- **页面上别有裸密码框**：设置页的 API Key 改成点击「点击修改」后才渲染输入框，
  Chrome 的登录表单判定根本不启动 —— 这条比任何 autocomplete 取值都可靠
- 密码框（回退路径）写 `autocomplete="new-password"` —— 这是**唯一**能让 Chrome
  放弃填充已存密码的取值（对密码框写 `autocomplete="off"` 会被 Chrome 忽略）；
  但它只能阻止「填」，拦不住提交后的「保存密码？」气泡 —— 所以主力是 text-security
- 文本框叠一层 **readonly-until-focus**：登录令牌框默认 `readonly`，聚焦时解锁 ——
  Chrome 对只读字段不弹任何建议
- 候选列表用**自绘面板**而不是原生 datalist：datalist 是浏览器 UI，账号弹窗能盖住它
- 同时挂上 1Password / LastPass / Bitwarden / Proton Pass 的忽略标记

`verify-ui.mjs` 里有对应断言：每个页面的密码框都必须已声明，出现「裸密码框」即失败。

## 已知限制

- **不支持 Script Operator**：Workers 运行时禁用 `eval` / `new Function`。使用时会明确报错，
  引导改用内置算子组合，而不是静默跳过。自建 Node 部署下 `eval` 是可用的，但**同样不实现**
  —— 两边跑同一份 `operators.js`，行为必须一致，不然「本地测过、上云就废」这类问题防不住。
- 各类上限：算子链处理 20000 个节点、文件 512KiB、成品 16MiB、分享码 900 条、备份 20MiB。
- 单租户设计：一套部署一个访问令牌，没有多用户体系。

## 许可

**AGPL-3.0-only**（或更高版本）。完整协议文本见 [`LICENSE`](LICENSE)，
第三方组件与引用的完整声明见 [`NOTICE`](NOTICE)。

### 本项目用了谁的代码

| 项目 | 与本项目的关系 |
| --- | --- |
| [Sub-Store](https://github.com/sub-store-org/Sub-Store)（AGPL-3.0） | **未使用其源码。** 仅算子链的 DSL 保持兼容：少数算子沿用同名（`Flag Operator` / `Sort Operator` / `Useless Filter`），并接受它的 `(?i)` 内联正则标记，方便已有脚本迁移；其余算子刻意另起名（如 `Regex Rename Operator` → `Regex Rename`）。服务端 `apps/server/src/` 为独立实现 —— 无 Sub-Store 导入、无共享模块、无 vendor 目录、无指向它的构建别名 |
| [SubPilot-Archive](https://github.com/guanxi660-crypto/SubPilot-Archive)（AGPL-3.0） | 本项目的前身（已归档，私有仓库）。**唯一逐字复用的是 `apps/web/src/utils/configPresets.js`**（104 条远程配置预设，取自 SubPilot-Archive 的 `apps/server/src/subconv/presets.js`，该文件头部已注明出处）；UI 布局与交互的对齐是刻意的产品一致性，Vue 组件为独立编写。SubPilot-Archive 自身是 Sub-Store 的二次开发（其 `NOTICE` 记录了 vendored 后端），但本项目**没有**沿用那条链路 |
| [SubConverter-Extended](https://github.com/Aethersailor/SubConverter-Extended)（GPL-3.0） | **外部服务，不含源码。** 本项目通过 HTTP 调用它的 `/sub` 完成格式转换；该后端是独立部署，不属于本仓库。多来源递交用的 `tag:/provider:` 前缀语法对齐 SubPilot-Archive / subweb 前端约定，以便与同一个后端互操作 |
| [vaeann/sub-store-scripts](https://github.com/vaeann/sub-store-scripts) | 仅参考了「脚本头部参数文档」这一做法，无代码复制 |

预设清单里的 URL 指向第三方维护的远程配置模板（`Custom_OpenClash_Rules`、`cmliu/sub-web-modify`
等），版权归各自维护者，详见 `NOTICE`。

### 部署者的义务

AGPL 是**网络服务条款**：如果你把修改后的版本作为服务对外提供，必须向该服务的使用者提供
对应的源代码。直接用本项目、或改完只自己用，都不受影响。
