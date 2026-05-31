# 贡献指南

## 首次设置

### 环境要求

- Rust 1.80+（[rustup](https://rustup.rs)）
- Node.js 22+
- Windows：WebView2（通常已预装）
- Git

### 克隆与运行

```bash
git clone <repo-url> && cd novel_agent
npm install
cargo tauri dev --manifest-path src-tauri/Cargo.toml
```

首次运行需在应用中配置 DeepSeek API Key（Settings → 填入 `api_key`），遵循 OpenAI 兼容 API 的也可配置 `api_base_url` 和 `model`。

`cargo tauri dev` 会自动编译 Rust、启动前端。改 Rust 代码需重启命令；只改 `src/` 则 Vite 热更新。

## 项目结构

开发只发生在 本目录下。`novel_git_server/`、`frontend/`、`dify_workflows/` 是旧 Python 项目，已废弃。

```
├── src/                        # React 前端
│   ├── api/                    # Tauri invoke() 封装
│   ├── components/             # UI 组件
│   ├── hooks/                  # 业务逻辑 hooks
│   ├── store/                  # Zustand 状态
│   ├── types/                  # TypeScript 类型
│   └── lib/                    # 工具函数
├── src-tauri/
│   ├── src/
│   │   ├── engine/             # Agent 引擎（LLM + Tools）
│   │   ├── commands/           # Tauri 命令处理器
│   │   ├── storage/            # 文件 I/O + 布局
│   │   └── lib.rs              # 命令注册
│   ├── prompts/                # AI Agent Prompt 模板
│   └── tests/                  # Rust 测试
└── 技术债.md                   # 技术债清单与修复优先级
```

完整架构说明见 `CLAUDE.md`（AI 编码规范）。

## 开发流程

1. **找 Issue**：从 GitHub Issues 中选一个，优先 `good first issue` 标签
2. **建分支**：`git checkout -b feature/<issue-name>`（从 `main` 切出）
3. **写代码**
4. **自检**：
   ```bash
   cargo check --manifest-path src-tauri/Cargo.toml
   cargo test --manifest-path src-tauri/Cargo.toml
   npm run build
   ```
5. **提交**：遵循 `feat: / fix: / chore: / refactor: / docs:` 格式
6. **提 PR**：描述改了什么 + 测试截图/日志

## 编码规范

AI 编码规范见 `CLAUDE.md`（所有贡献者适用）。关键原则：

- **依赖方向**：`commands/` → `engine/` → `storage/`（不可反向）
- **前端分层**：`components/` 不调 `invoke()` → `hooks/` 封装 → `api/` 做 IPC
- **禁止 `unwrap()`** 出现在生产路径（Rust）
- **禁止 `any` 类型**出现在新增接口中（TypeScript）
- **命名**：Rust snake_case，TS camelCase，Tauri 命令 snake_case

## 测试要求

- 路径安全、book_id 解析、章节号解析、流式 Tool Call 参数解析 → 必须写测试
- 测试引用生产代码，不复制实现

## 从哪里开始

1. **读 `技术债.md`** — 了解当前已知问题全貌
2. **读 `CLAUDE.md`** — 理解架构分层和编码规范
3. **选 Issue** — P0 bug 修起，或 P2 代码质量改善（新人友好）
4. **PR 提交** — CI 会自动跑 `cargo check` + `cargo test` + `npm run build`

有问题在 Issue 下讨论，或在 PR 描述中 @ 仓库维护者。
