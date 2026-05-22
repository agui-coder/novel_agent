# Novel Agent 演示包 v{{VERSION}}

这是一个经过净化的本地演示包，用来复现 AI 小说创作工作台的核心前后端、Dify 工作流快照、后端 LangChain 管线代码、部署脚本和基本检查流程。

## 启动方式

```powershell
.\start_demo.ps1 -InitEnv
# 按照提示填写 deploy/demo/.env 中的 Dify 应用密钥、模型供应商密钥和后端模型配置。
.\start_demo.ps1
```

启动后打开：

```text
http://127.0.0.1:5173/bookshelf.html
```

## 部署提示

本项目由个人维护，且架构原创性较高：它同时包含本地书库、Dify Agent 工作流、后端 LangChain 管线、LoreGit 工具层，以及每本书独立的 Git 仓库。它目前是可复现的本地演示包，不是适配所有机器的成熟商业一键部署产品。

如果部署不顺利，请先收集终端报错、`deploy/demo/.env` 的非敏感配置结构、Docker/WSL 状态、Dify 运行状态、模型配置和 ToolProvider 地址，再使用 AI 辅助定位。大多数问题来自路径、端口、密钥、服务启动顺序，或 Dify 访问后端地址失败。

## 发布边界

本包包含源码、Dify DSL 快照、前后端代码、后端 LangChain 管线代码和演示脚本。

本包不包含 Dify 数据库备份、模型 API 密钥、Dify 应用 API 密钥、私有书库、`.runtime` 或运行时存储。

更多说明请阅读 `README.md` 和 `docs/DEPLOYMENT.md`。
