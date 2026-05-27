# 部署路线与可复现演示

本文定义 `novel_agent` 当前公开仓库和 Release 包的复现边界。目标是让新的评审者能在一台机器上跑起工作台，接入自己的 Dify Runtime 和模型配置，验证小说导入、大纲、续写、审核、正文归档、剧情分支和回退链路。

项目不是纯 Dify 应用，也不是纯 LangChain 应用，而是：

```text
React 工作台
  -> Flask 后端与 LoreGit ToolProvider
  -> 每本书独立 Markdown 工作区与 Git 仓库
  -> 后端 LangChain 批处理管线
  -> Dify 活跃 Agent 工作流
```

个人维护说明：本项目架构原创性较高，目前是“可复现本地 demo + 工程展示样例”，不是覆盖所有机器环境的成熟商业一键部署产品。如果部署不顺利，请收集终端报错、`deploy/demo/.env` 的非敏感配置结构、Docker/WSL 状态、Dify 运行状态、模型配置和 ToolProvider 地址，再使用 AI 辅助定位。大多数问题来自路径、端口、密钥、服务启动顺序，或 Dify 访问 Flask 后端地址失败。

## 发布边界

公开仓库与 Release ZIP 应当包含：

- 前端工作台；
- Flask 后端、LoreGit 工具层和后端 LangChain 管线；
- `deploy/demo/` 启动脚本、Compose 配置和 smoke check；
- `dify_workflows/*.yml` 净化后的 Dify DSL 快照；
- 技术档案、部署文档和演示说明；
- 构建 release 包的脚本。

公开仓库与 Release ZIP 不包含：

- 模型 API 密钥；
- Dify App API Key；
- 私有 Dify PostgreSQL 备份；
- 私有小说书库；
- `.runtime`；
- `novel_git_server/storage/`；
- `deploy/demo/.env`；
- 本地视频制作工程和临时产物。

Release ZIP 需要使用可移植路径，压缩包内条目统一使用 `/` 分隔，让 Windows、WSL 和 Linux 解压后都能得到真实目录，例如 `deploy/demo/`、`docs/`、`dify_workflows/`。

## 部署体检工具

`deploy/demo/deploy_doctor.py` 是一个 stdlib-only 体检器，适合在 Release ZIP、源码 clone 或服务器目录中直接运行。它不负责启动服务，只负责回答“现在断在哪里”：

- Python/Git/Node/npm/Docker 是否存在；
- `.env` 是否存在，关键 Dify 和体验版配置是否明显缺失；
- Flask `/health` 是否可访问；
- 前端书架页与 `/api/*` 代理是否可访问；
- Dify 地址是否从当前机器可达；
- 受控体验版是否启用了 cookie 沙箱、配置中心只读和 Dify 无 cookie 回调绑定。

本地部署画像：

```powershell
python .\deploy\demo\deploy_doctor.py `
  --profile local `
  --env .\deploy\demo\.env `
  --backend-url http://127.0.0.1:8000 `
  --frontend-url http://127.0.0.1:5173
```

本地画像不会检查会话隔离。它关注的是本机三端能否启动、Dify App key 是否漏填、前端代理是否打到后端。

云端受控体验版画像：

```bash
python deploy/demo/deploy_doctor.py \
  --profile public-demo \
  --env /etc/novel-agent-demo.env \
  --backend-url http://127.0.0.1:18000 \
  --frontend-url http://127.0.0.1:15173
```

云端画像会多做三件本地不需要的检查：

- 浏览器 cookie 会话是否能创建临时书库；
- Dify ToolProvider 回调没有浏览器 cookie 时，是否仍能通过 `demo_<session>_<book>` 绑定回正确会话；
- 配置中心是否只读，避免把 API Key 配置暴露给访问者。

如果想把 Dify 一起纳入体检：

```powershell
python .\deploy\demo\deploy_doctor.py --profile local --env .\deploy\demo\.env --dify-url http://localhost/v1
```

体检器支持 `--json` 给自动化脚本读取，也支持 `--strict` 在警告时返回非零退出码。

## 这次云端部署踩过的坑

| 坑 | 为什么会发生 | 现在的规避方式 |
| --- | --- | --- |
| 以为 Dify 已经部署/运行 | 前后端能打开不代表 Dify Runtime 存在，Dify DSL 也不是可运行数据库备份。 | 部署步骤把 Dify Runtime 作为显式依赖；体检器单独检查 Dify HTTP 可达。 |
| Dify 能回复但不能写文件 | ToolProvider 从 Dify 容器/沙箱访问后端，`localhost` 往往指容器自己。 | 在 Dify 里配置它能访问到的 Flask 地址，例如宿主机地址、`host.docker.internal` 或同网段地址，并从 Dify 网络侧验证。 |
| 服务器上已有别的项目 | 随手占用 80/8000/5173 容易冲突，也可能暴露不该暴露的后端。 | 受控体验版默认后端只绑定 `127.0.0.1:18000`，只暴露一个静态代理入口。 |
| 小服务器跑完整 Dify 很吃力 | Dify、PostgreSQL、插件服务、模型代理和多个项目会争内存。 | 小规模展示优先部署 Novel Agent 前端/后端，Dify 可以连接已有私有 Runtime。 |
| 前端源代码更新后页面不变 | 浏览器拿到的是 `frontend/dist`，服务器没有重新 build。 | 每次前端改动后执行 `npm ci && npm run build`，再重启静态代理。 |
| 新书导入/元数据提交失败 | 每本书都是独立 Git 仓库，systemd 环境可能没有 Git 作者身份。 | 服务器初始化时配置 `user.name` 和 `user.email`。 |
| 25 章限制理解错 | 体验版不是禁止导入长书，而是只落盘前 25 章以控成本。 | 后端导入管线保留搜索/选择体验，只限制实际物化章节数。 |
| cookie 隔离修过头导致 Dify 回调丢会话 | Dify 工具调用没有浏览器 cookie，纯 cookie 模型会让写入落到新会话。 | 当前规则是浏览器 cookie 优先；无 cookie 但带合法 `demo_<sid>_<book>` 时绑定已有会话；同时 `book_id` 优先于 `book_name`。 |

## 路线 A：Release ZIP，本地演示推荐

适合面试演示、录屏、本机快速体验。

前置条件：

- Windows 10/11；
- PowerShell；
- Git for Windows；
- Python 3.11 或兼容版本；
- Node.js LTS 与 npm；
- Docker Desktop；
- 已经可打开的 Dify Runtime。

操作步骤：

```powershell
# 1. 从 GitHub Releases 下载并解压 novel-agent-demo-v*.zip。

# 2. 第一次运行时创建本地配置文件。
.\start_demo.ps1 -InitEnv

# 3. 编辑 deploy/demo/.env，填入 Dify App API Key 和模型 Key。

# 4. 启动三端。
.\start_demo.ps1
```

启动后打开：

```text
http://127.0.0.1:5173/bookshelf.html
```

常用命令：

```powershell
.\start_demo.ps1 -Status
.\start_demo.ps1 -Stop
.\start_demo.ps1 -SkipDify
.\start_demo.ps1 -DryRun
```

`-SkipDify` 只启动后端和前端，适合 UI 调试。完整大纲、续写、审核和正文归档体验仍然需要 Dify 可访问。

## 路线 B：源码运行，适合开发和二次修改

适合需要阅读代码、改功能、写简历项目说明的人。

```powershell
git clone https://github.com/blackzhanzhan/novel_agent.git
cd novel_agent
Copy-Item .\deploy\demo\.env.example .\deploy\demo\.env
# 编辑 deploy/demo/.env。
.\deploy\demo\bootstrap.ps1
```

`bootstrap.ps1` 会做这些事：

- 检查 Docker、Python、Node.js、npm、Git 和 Dify compose 路径；
- 从示例文件准备本地环境配置；
- 安装后端虚拟环境和前端依赖；
- 启动 Dify、Flask 后端和 Vite 前端；
- 同步 LoreGit ToolProvider 到当前后端端口；
- 打印前端地址和健康检查地址。

关键配置字段：

| 字段 | 作用 |
| --- | --- |
| `NOVEL_AGENT_WSL_DISTRO` | Dify 位于 WSL 时使用的发行版，默认 `Ubuntu`。 |
| `NOVEL_AGENT_DIFY_COMPOSE_DIR` | 本机 Dify compose 目录。 |
| `DIFY_BASE_URL` | 后端在 Windows 路径下调用 Dify Service API 的地址，常见为 `http://localhost/v1`。 |
| `COMPOSE_DIFY_BASE_URL` | Docker Compose 内访问 Dify 的地址，常见为 `http://host.docker.internal/v1`。 |
| `DIFY_*_API_KEY` | 各个活跃 Dify App 的 API Key。 |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` / `DEEPSEEK_API_KEY` | 后端 LangChain 管线的 OpenAI-compatible 模型配置。 |
| `BACKEND_HOST_PORT` / `FRONTEND_HOST_PORT` | Compose 暴露到宿主机的端口，默认 `8000` 与 `5173`。 |
| `PUBLIC_DEMO_MODE` | 可选公开体验沙箱开关。设为 `1` 后配置中心与删除入口会被隐藏，后端按临时会话隔离书库。 |
| `PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT` | 公开体验版导入章节上限，默认 `25`。 |
| `PUBLIC_DEMO_WORLD_INIT_LIMIT` | 公开体验版世界观初始化次数上限，默认 `1`。 |

## 路线 C：Docker Compose 本地构建

适合用容器隔离后端、前端、demo storage 和 runtime。

```powershell
Copy-Item .\deploy\demo\.env.example .\deploy\demo\.env
# 编辑 deploy/demo/.env，填入 Dify 与模型配置。
docker compose --env-file deploy\demo\.env -f docker-compose.demo.yml up -d --build
docker compose --env-file deploy\demo\.env -f docker-compose.demo.yml run --rm smoke
```

Compose 包会构建：

- `deploy/demo/backend.Dockerfile`
- `deploy/demo/frontend.Dockerfile`

默认基础镜像使用 MCR devcontainer 镜像，通常在 Docker Desktop 环境下较容易拉取。如果环境更适合 Docker Hub 或私有镜像源，可以在 `deploy/demo/.env` 中改：

```text
BACKEND_BASE_IMAGE=python:3.11-slim
FRONTEND_BASE_IMAGE=node:22-bookworm-slim
```

容器会使用隔离卷：

- `demo-storage`：书库 demo 数据；
- `demo-runtime`：运行时状态。

它不会挂载宿主机的 `novel_git_server/storage/`。

如果宿主机端口冲突，只改宿主机端口：

```text
BACKEND_HOST_PORT=18000
FRONTEND_HOST_PORT=15173
```

容器内部端口保持后端 `8000`、前端 `5173`，这样健康检查和前端代理不会漂移。

## 路线 D：GHCR 预构建镜像

适合跳过本地 build，直接拉取已发布镜像。

```powershell
Copy-Item .\deploy\demo\.env.example .\deploy\demo\.env
# 编辑 deploy/demo/.env，填入 Dify App API Key、模型 Key 和 COMPOSE_DIFY_BASE_URL。
docker compose --env-file deploy\demo\.env -f docker-compose.ghcr.yml up -d
docker compose --env-file deploy\demo\.env -f docker-compose.ghcr.yml run --rm smoke
```

镜像：

- `ghcr.io/blackzhanzhan/novel_agent-backend:latest`
- `ghcr.io/blackzhanzhan/novel_agent-frontend:latest`

`.github/workflows/publish-images.yml` 会在 `main`、`v*` tag 和手动触发时发布镜像。GHCR 镜像不包含 Dify 数据库、密钥、私有书库或运行时 storage，只替代本地镜像构建步骤。

## 路线 E：半公开体验版服务器部署

适合简历、作品集和小范围试用链接。这个路线的目标不是把完整 Dify 控制台暴露到公网，而是在服务器上给访问者一个临时、低成本、可清理的 Novel Agent 体验入口。

推荐边界：

- 不公开 Dify 控制台。
- 不公开配置中心。
- 不把真实 API Key、SSH 密码、Dify 数据库备份或私有书库写入仓库、release 包或前端。
- 不占用已有演示项目端口；默认后端 `127.0.0.1:18000`，前端静态代理 `0.0.0.0:15173`。
- 小内存服务器不建议强行同机部署完整 Dify Docker；可以先连接已有私有 Dify API，或把 Dify 放到更合适的机器。

体验版限制由后端环境变量控制：

```text
PUBLIC_DEMO_MODE=1
PUBLIC_DEMO_TEMPLATE_BOOK_ID=7558519503458405438
PUBLIC_DEMO_SESSION_TTL_SECONDS=600
PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT=25
PUBLIC_DEMO_WORLD_INIT_LIMIT=1
```

含义：

- 每位访问者分配一个 cookie 临时会话。
- 书架会复制一份模板书到当前会话沙箱。
- 用户仍然可以导入新书，但只落盘前 25 章。
- 世界观初始化每个临时会话/书只允许一次。
- 滚动三章续写可以多次运行，适合展示工作流。
- 会话过期后，`.demo_sessions` 状态与 `demo_<session>_*` 书库会被后端清理。

仓库内提供：

```text
deploy/public_demo/.env.example
deploy/public_demo/static_proxy.py
deploy/public_demo/novel-agent-demo-backend.service
deploy/public_demo/novel-agent-demo-frontend.service
deploy/public_demo/README.md
```

最小安装流程见 `deploy/public_demo/README.md`。上线前至少验证：

```bash
curl http://127.0.0.1:18000/health
curl http://127.0.0.1:15173/api/demo/session
curl http://127.0.0.1:15173/bookshelf.html
```

## Dify Runtime 规则

Dify live PostgreSQL 和插件存储是 Dify 运行时真相。`dify_workflows/*.yml` 是净化后的 DSL 快照，可以用来复现 App/workflow 结构、提示词、节点图和工具引用，但不是完整运行时备份。

当前 DSL 状态：

| DSL | 当前状态 |
| --- | --- |
| `dify_workflows/世界模型agent.yml` | 保留，用于初始化后的讨论、解释、局部修订和考据；首次生成/重建已迁移到后端 LangChain 世界/状态管线。 |
| `dify_workflows/文风学习agent.yml` | 保留，用于初始化后的文风讨论、解释和作者协作修订；首次生成/重建已迁移到后端文风管线。 |
| `dify_workflows/灵感大纲agent.yml` | 活跃，用于大纲讨论、联网参考、分层大纲和章节卡落档。 |
| `dify_workflows/续写agent.yml` | 活跃，用于生成 `chapter_draft.md`。 |
| `dify_workflows/审核agent.yml` | 活跃，用于审核剧情冲突、状态风险、断章和正文归档风险，并沉淀 `error_archive.md`。 |
| `dify_workflows/读书存档agent.yml` | 已退役，仅历史兼容；`summary.md` 初建/重建由后端 LangChain 摘要归档管线负责。 |

导入活跃 DSL 后需要重新配置：

1. 模型供应商和模型；
2. 需要思考能力的 Agent 的 thinking 设置；
3. 每个 App 的 API Key；
4. LoreGit ToolProvider endpoint；
5. Dify 到后端的网络可达性。

Dify 内 LoreGit ToolProvider 常见地址：

```text
http://host.docker.internal:8000
```

如果 Dify 运行在 WSL 或远端服务器，需要换成该环境能访问 Flask 后端的地址。

## 可选 Dify 恢复

如果你有额外的净化 SQL seed，可以用：

```powershell
.\deploy\demo\dify_runtime.ps1 `
  -RestoreSqlBackup `
  -BackupDir C:\path\to\sanitized_dify_seed `
  -RestartAfterRestore `
  -IUnderstandThisWritesDify
```

seed 目录需要包含：

- `dify.sql`
- `dify_plugin.sql`

私有 `.dify_backups` 保持忽略，不应提交或打进 release。

## 创作权责边界

部署脚本可以启动、恢复、配置、健康检查和验证，但不能代替 Agent 直接生成小说内容。

演示内容必须遵守：

- 大纲文件由大纲 Agent 产生；
- `chapter_draft.md` 由续写 Agent 产生；
- 审核意见由审核 Agent 产生；
- 正文归档由审阅/归档工作台触发；
- Git 操作保留每本书独立分支、回退和审计模型。

## 验收清单

最小可复现 demo 需要满足：

- 后端 `/health` 可访问；
- 前端书架页可访问；
- 配置中心可以保存 Dify Base URL、Dify App Key 和后端模型配置；
- Dify API 可访问；
- Dify sandbox 或 API 能访问 Flask LoreGit `/health`；
- LoreGit ToolProvider endpoint 指向当前后端端口；
- 可以导入或打开一本书；
- 后端 LangChain 初始化链路能生成或重建摘要、世界/状态、文风资料；
- 活跃大纲、续写、审核 Agent 至少能完成一次端到端链路；
- 正文归档后章节、状态卡和必要世界观更新可见；
- 每书 Git 分支、diff、回退能力可用；
- 没有密钥、真实书库、`.runtime` 或 `novel_git_server/storage/` 被 Git 跟踪或打进 release。

后端健康检查：

```powershell
Invoke-WebRequest http://127.0.0.1:8000/health
```

Compose smoke：

```powershell
docker compose --env-file deploy\demo\.env -f docker-compose.demo.yml run --rm smoke
```

部署体检：

```powershell
python .\deploy\demo\deploy_doctor.py --profile local --env .\deploy\demo\.env --backend-url http://127.0.0.1:8000 --frontend-url http://127.0.0.1:5173
```

受控体验版体检：

```bash
python deploy/demo/deploy_doctor.py --profile public-demo --env /etc/novel-agent-demo.env --backend-url http://127.0.0.1:18000 --frontend-url http://127.0.0.1:15173
```

## 常见故障

| 现象 | 排查方向 |
| --- | --- |
| 前端能打开，但 Dify 调用失败 | 检查 `DIFY_BASE_URL`、对应 `DIFY_*_API_KEY`、Dify App 是否发布。 |
| Dify 能生成文字，但不能读写书库 | 检查 LoreGit ToolProvider 是否指向 Flask 后端，容器里通常用 `http://host.docker.internal:8000`。 |
| Compose smoke 失败 | 检查 `COMPOSE_DIFY_BASE_URL` 是否是容器内可访问的 Dify 地址。 |
| 端口被占用 | Compose 改 `BACKEND_HOST_PORT` 或 `FRONTEND_HOST_PORT`；PowerShell 启动脚本用 `-BackendPort` 或 `-FrontendPort`。 |
| GHCR 拉取失败 | 检查 GitHub Packages 可见性；必要时执行 `docker login ghcr.io`。 |
| Dify YAML 导入后没有模型 | 正常现象，需要在自己的 Dify 环境里重新选择模型供应商和模型。 |
| Agent 能回答但工作台没变化 | 检查是否启用了正确的活跃 Dify App、API Key 是否填到了对应字段、工具调用是否命中 LoreGit。 |
| `deploy_doctor.py --profile local` 警告缺少 Dify key | 本地前端/后端可以先启动，但活跃大纲、续写、审核 Agent 需要对应 App key。 |
| `deploy_doctor.py --profile public-demo` 会话检查失败 | 检查 `PUBLIC_DEMO_MODE=1`、模板书是否存在、前端代理是否转发 cookie 和 `/api/demo/session`。 |
| Dify 工具回调在云端写入错误书库 | 检查回调请求是否传了明确 `book_id`；受控体验版要求 `demo_<session>_<book>` 在无 cookie 请求下仍能映射到原会话。 |
| 配置中心在云端还能写入 | 说明体验版后端没有读到 `PUBLIC_DEMO_MODE=1` 或运行的不是受控体验服务。 |
| 服务器响应慢 | 先确认是不是 Dify 或模型 API 慢；Novel Agent 前端/后端本身可以用体检器分层测延迟。小机器不要同机跑过多项目。 |
