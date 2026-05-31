# NovelForge 项目计划

## 定位

网文作家专用的 VS Code 扩展——把小说创作做成类似 Cursor 的 AI IDE 体验。

**不是通用写作工具，专门服务长篇网文生产流**：导入 → 世界观蒸馏 → 大纲规划 → 逐章续写 → AI 审核 → Git 版本管理。

## 架构

```
┌─ VS Code 扩展 (TypeScript) ───────────────────────┐
│                                                     │
│  commands/    扩展命令（创建项目、导入、续写等）        │
│  panels/      WebView 面板（Agent 对话、大纲树、审查台）│
│  providers/   数据提供者（文件树、Git 历史、诊断信息）   │
│  sidecar.ts   Rust 进程管理 + JSON-RPC 通信          │
│                                                     │
├─ Rust CLI (binary) ────────────────────────────────┤
│                                                     │
│  commands/    文件 IO · Git 操作 · Markdown 解析     │
│  engine/      AI Agent 引擎（续写/审核/大纲）         │
│  storage/     书库布局管理 · ETag 锁                │
│  server.rs    stdin/stdout JSON-RPC 循环            │
│                                                     │
├─ 提示词 (复用 novel_agent)                         │
│  prompts/continuation.md                           │
│  prompts/review.md                                 │
│  prompts/outline.md                                │
└─────────────────────────────────────────────────────┘
```

**为什么 Rust CLI 而不是 VS Code 扩展里调 LLM**：
- 文件 IO、Git 操作是确定性的，Rust 快且安全
- 提示词 + 工具调用逻辑复杂，放 Rust 里好测试
- VS Code 扩展只负责 UI，不碰文件系统和 Git

## 阶段一：Rust CLI 核心（2 周）

### 1.1 项目初始化
- Cargo 项目 `NovelForge-core`
- `clap` CLI 框架：`NovelForge server`（JSON-RPC）、`NovelForge init`、`NovelForge check`
- `serde` / `serde_json` 序列化
- `git2` Git 操作
- `sha2` ETag 计算
- `reqwest` HTTP 客户端（调 DeepSeek API）

### 1.2 存储层
- 从 `novel_agent/desktop/src-tauri/src/storage/` 移植
- 书架布局自愈初始化
- 确定性 book_id 生成
- ETag 计算与冲突检测

### 1.3 文件 IO 命令
- 移植 `desktop/src-tauri/src/commands/archive.rs`
- get_file / update_file / append_file / get_archive_range
- get_markdown_outline / get_markdown_section
- 路径安全校验 + Git 自动提交

### 1.4 Git 命令
- 移植 `desktop/src-tauri/src/commands/git.rs`
- git_log / git_diff / git_branch_list / git_checkout_branch
- 剧情分支：每个分支 = 独立故事线

### 1.5 AI 引擎
- 移植 `novel_agent/novel_git_server/engine/`
- 提示词从 engine/*.py 翻译为 Rust 的 `include_str!()` 或独立 .md 文件
- `reqwest` 直调 DeepSeek chat/completions API
- 工具调用：LLM 返回 function_call → Rust 执行对应的文件/Git/校验命令 → 结果注入回对话
- SSE 流式输出（用于 Agent 对话面板实时显示）

### 1.6 JSON-RPC 服务
- stdin/stdout 行协议
- 请求格式：`{"id":"...","method":"...","params":{...}}`
- 响应格式：`{"id":"...","result":{...}}` 或 `{"id":"...","error":"..."}`
- 流式事件：`{"event":"delta","data":{"text":"..."}}` （用独立行 `{"event":...}` 推送）

## 阶段二：VS Code 扩展（2.5 周）

### 2.1 项目初始化
- `yo code` 生成扩展骨架
- `package.json` 配置 activation events、contributes
- 侧车管理：`extension.ts` 启动时 spawn Rust 进程

### 2.2 文件视图
- TreeView：章节、大纲、世界设定、草稿
- 点击打开对应文件到编辑器
- 右键菜单：新建章节、删除、重命名

### 2.3 Agent 对话面板（WebView）
- 三个 Agent：续写 / 审核 / 大纲
- 聊天界面 + 流式输出（SSE 事件解析）
- 输入框 + 发送按钮 + 停止按钮
- 阶段状态指示（读取文件 → 思考 → 写草稿 → 校验长度 → 完成）

### 2.4 审查工作台（WebView）
- 草稿 diff 对比（Monaco Diff Editor）
- 审核意见列表（问题 + 建议 + 严重度）
- 操作按钮：通过入正史 / 打回重写 / 作者小修

### 2.5 Git 面板
- 提交历史列表
- 分支列表 + 切换
- 剧情分支可视化（可选）

### 2.6 状态栏
- 当前书 + 当前 Agent + 流式状态
- 草稿长度统计

## 阶段三：打包发布（1 周）

### 3.1 Rust 编译产物
- `NovelForge-core` 编译为各平台二进制（Windows / Mac / Linux）
- VS Code 扩展打包时内嵌对应平台的二进制

### 3.2 VS Code Marketplace
- `vsce package` 打包
- 发布到 VS Code Marketplace
- README + 截图 + 演示视频

### 3.3 首次使用引导
- 第一步：配置 DeepSeek API Key
- 第二步：创建或导入项目
- 第三步：初始化世界观 + 大纲
- 第四步：开始续写

## 复用的提示词资产

| 文件 | 来源 | 用途 |
|------|------|------|
| `prompts/continuation.md` | `engine/continuation.py` | 续写 Agent 系统提示词，含 LENGTH_GATE 等全部协议 |
| `prompts/review.md` | `engine/review.py` | 审核 Agent 提示词，7 维度审查 + 错误档案规则 |
| `prompts/outline_discuss.md` | `engine/outline.py` | 大纲讨论 Agent |
| `prompts/outline_commit.md` | `engine/outline.py` | 大纲落档 Agent |
| `prompts/classifier.md` | `engine/outline.py` | 意图分类器 |

## 工具集（Agent 可调用）

| 工具名 | 类型 | 作用 |
|--------|------|------|
| `get_markdown_outline` | 读 | 获取文件标题结构和 etag |
| `get_markdown_section` | 读 | 读取指定区块内容 |
| `get_archive_range` | 读 | 按行范围读取归档 |
| `get_core_archive` | 读 | 读取核心档案全文 |
| `extract_chapter_highlights` | 读 | 关键词抽取章节高光 |
| `draft_append_section` | 写 | 追加草稿区块 |
| `draft_replace_section` | 写 | 替换草稿区块 |
| `validate_chapter_lengths` | 校验 | 检查章节字数 |
| `generate_style_diagnostics` | 校验 | 生成文风诊断 |

## 关键技术决策

1. **直调 LLM API，不依赖 Dify**——`novel_agent` 已验证可行
2. **Rust 管理工具调用循环**——不需要 LangChain/LangGraph，纯 Rust 做 function calling loop
3. **JSON-RPC over stdin/stdout**——VS Code 扩展和 Rust 的通信协议，简单可靠
4. **每书独立 Git 仓库**——不需要数据库，文件即真相
5. **WebView 面板用 Preact + Tailwind**——轻量，比 React 小 10 倍

## 总时间线

```
Week 1-2:   Rust CLI 核心（存储 + IO + Git + AI 引擎 + JSON-RPC）
Week 3-4:   VS Code 扩展（文件视图 + Agent 面板 + 审查台）
Week 5:     Git 面板 + 状态栏 + 引导
Week 6:     打包 + 测试 + 发布
```

## 第一个里程碑目标

创建项目 → 导入 3 章测试文本 → 初始化世界观 → 生成章节大纲 → 续写 1 章 → 审核 → 确认归档
