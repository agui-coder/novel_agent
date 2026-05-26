# Novel Agent 演示包 v{{VERSION}}

这是一个净化后的本地演示包，用来复现 Novel Agent 的核心工作台：前端、Flask 后端、后端 LangChain 管线、LoreGit ToolProvider、Dify DSL 快照、启动脚本和基础 smoke check。

它不是包含密钥和私有数据库的一键黑盒包。完整体验仍然需要你自己的 Dify Runtime、模型供应商配置、Dify App API Key，以及能被 Dify 访问到的本项目后端地址。

## 推荐启动路线

### 路线一：Windows 本地演示

适合录屏、面试展示和本机体验。

```powershell
.\start_demo.ps1 -InitEnv
# 编辑 deploy/demo/.env，填入 Dify App API Key 和后端模型 Key。
.\start_demo.ps1
```

启动后打开：

```text
http://127.0.0.1:5173/bookshelf.html
```

只想启动前后端、不让脚本管理 Dify 时：

```powershell
.\start_demo.ps1 -SkipDify
```

### 路线二：Docker Compose 本地构建

适合在新机器上验证前端、后端、隔离 demo storage 和 smoke check。

```powershell
Copy-Item .\deploy\demo\.env.example .\deploy\demo\.env
# 编辑 deploy/demo/.env，至少配置 COMPOSE_DIFY_BASE_URL、Dify App API Key 和模型 Key。
docker compose --env-file deploy\demo\.env -f docker-compose.demo.yml up -d --build
docker compose --env-file deploy\demo\.env -f docker-compose.demo.yml run --rm smoke
```

### 路线三：GHCR 预构建镜像

适合跳过本地镜像构建，只拉取已发布的前后端镜像。

```powershell
Copy-Item .\deploy\demo\.env.example .\deploy\demo\.env
docker compose --env-file deploy\demo\.env -f docker-compose.ghcr.yml up -d
docker compose --env-file deploy\demo\.env -f docker-compose.ghcr.yml run --rm smoke
```

## 必填配置

`deploy/demo/.env` 是本机配置入口，不要提交到 Git。

最常用字段：

```text
DIFY_BASE_URL=http://localhost/v1
COMPOSE_DIFY_BASE_URL=http://host.docker.internal/v1
DIFY_OUTLINE_API_KEY=
DIFY_CONTINUATION_API_KEY=
DIFY_REVIEW_API_KEY=
DIFY_WORLD_MODEL_API_KEY=
DIFY_STYLE_GUIDE_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_API_KEY=
```

Dify 里的 LoreGit ToolProvider 必须指向本项目 Flask 后端。Docker Desktop 常见地址是：

```text
http://host.docker.internal:8000
```

## Dify 与 LangChain 边界

本项目是 Dify + 后端 LangChain + LoreGit + 每书 Git 仓库的混合架构。

- Dify 负责活跃的大纲、续写、审核，以及世界观/文风初始化后的讨论和局部修订。
- 后端 LangChain 负责摘要归档、世界/状态初始化、文风初始化、章节卡和摘要结构修复等可重复管线。
- `读书存档agent.yml` 已退役，仅作为历史兼容资料保留；`summary.md` 初建和重建由后端摘要归档管线负责。
- `世界模型agent.yml` 与 `文风学习agent.yml` 没有完全退役，但初始化/重建职责已经迁移到后端。

## 发布边界

本包包含：

- 前端和后端源码；
- `deploy/demo/` 启动脚本、Compose 配置和 smoke check；
- `dify_workflows/*.yml` 净化后的 Dify DSL 快照；
- 部署文档、技术档案和演示说明；
- 构建 release 包所需的脚本。

本包不包含：

- 模型 API 密钥；
- Dify App API Key；
- Dify PostgreSQL 私有备份；
- 私有小说书库；
- `.runtime`；
- `novel_git_server/storage/`；
- 本地视频制作工程和临时产物。

## 排障提示

这个项目由个人维护，架构原创性较高，目前目标是“可复现本地 demo + 工程展示样例”，不是适配所有机器的成熟商业一键部署产品。

如果部署不顺利，先收集：

- 终端报错；
- `deploy/demo/.env` 的非敏感配置结构；
- Docker Desktop / WSL 状态；
- Dify 是否能打开；
- Dify App 是否已发布并生成 API Key；
- Dify 内 ToolProvider 指向的后端地址；
- 后端健康检查结果：`http://127.0.0.1:8000/health`。

多数问题来自路径、端口、密钥、服务启动顺序，或 Dify 容器访问宿主机后端地址失败。把这些信息交给 AI 辅助排查，通常能很快定位。

更完整说明请阅读 `README.md` 和 `docs/DEPLOYMENT.md`。
