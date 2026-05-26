# Novel Agent Demo v0.1.3

本次发布同步最新源码、部署说明和演示包，重点是让公开仓库更适合陌生机器复现。

## 主要更新

- 更新部署路线：README、`docs/DEPLOYMENT.md` 和 release 包内 `RELEASE_README.md` 统一说明 Release ZIP、源码运行、Docker Compose 本地构建和 GHCR 预构建镜像四条路线。
- 明确混合架构边界：项目是 Dify + 后端 LangChain + LoreGit ToolProvider + 每书 Git 仓库，不是纯 Dify 或纯 LangChain 应用。
- 标明已退役管线：`读书存档agent.yml` 仅保留历史兼容；摘要归档由后端 LangChain 管线负责。世界模型和文风 Agent 保留初始化后的讨论与修订，初始化/重建职责已迁移到后端。
- 收紧 release 包校验：构建脚本会验证必需文件存在，并拒绝把 `.runtime`、私有书库、Dify 备份、视频工程、`deploy/demo/.env` 等运行时内容打进 ZIP。
- 保留部署排障说明：个人维护、架构原创性较高，如果部署不顺利，建议收集日志、端口、Docker/WSL、Dify、模型 Key 和 ToolProvider 信息后用 AI 辅助定位。

## 发布边界

本包包含源码、前后端、后端 LangChain 管线、Dify DSL 快照、部署脚本、Compose 配置、smoke check 和文档。

本包不包含模型 API 密钥、Dify App API Key、Dify 数据库备份、私有书库、`.runtime`、`novel_git_server/storage/` 或本地视频制作工程。

## 推荐验证

```powershell
.\start_demo.ps1 -InitEnv
.\start_demo.ps1
```

或：

```powershell
docker compose --env-file deploy\demo\.env -f docker-compose.demo.yml up -d --build
docker compose --env-file deploy\demo\.env -f docker-compose.demo.yml run --rm smoke
```
