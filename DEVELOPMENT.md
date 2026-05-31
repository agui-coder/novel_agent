# Novel Agent — 开发者上手指南

## 项目定位

面向长篇网文作者的本地 AI 创作工作台。将小说导入、世界观蒸馏、大纲协作、续写草稿、审核归档和剧情分支管理做成一套可维护的创作 IDE。

**核心差异化**：不是聊天壳，而是"数字编辑部" —— 人类作者与 AI Agent 共同维护同一套 Markdown 创作资产，Dify 负责语义决策，Flask + 每书独立 Git 仓库负责确定性 IO 与版本历史，章节草稿、审核意见、回退历史和剧情分支都可以被检查、回滚和继续推进。

## 技术栈

| 层次 | 技术 | 用途 |
|------|------|------|
| 前端 | React 19 + TypeScript + Vite 6 | 创作工作台 UI |
| 前端组件 | Monaco Editor, ReactFlow, Zustand | 编辑器、剧情图、状态管理 |
| 后端 | Flask (Python 3.11+) | REST API + SSE 流式推送 |
| AI 编排 | Dify + LangChain | Agent 工作流、语义推理、批处理管线 |
| 版本管理 | GitPython | 每书独立 Git 仓库、分支、diff |
| 存储 | Markdown 文件 + nested Git | 文件即数据库，目录即索引 |
| 部署 | Docker Compose + GitHub Actions | 本地/服务器/GHCR 多模式部署 |

## 架构总览

```
┌──────────────────────┐
│ React/Vite Frontend   │  ← 作者操作 UI（编辑器 + diff 审阅 + Agent 对话）
└──────────┬───────────┘
           │ HTTP / SSE
┌──────────▼───────────┐
│ Flask Backend         │  ← 确定性工具层（IO、Git、ETag 锁、草稿沙盒）
└──────────┬───────────┘
    ┌──────┴──────────────┐
    │                     │
┌───▼────────┐  ┌─────────▼──────┐
│ LangChain   │  │ Dify Agent     │
│ 管线         │  │ 工作流          │
│ - 摘要归档   │  │ - 灵感大纲      │
│ - 世界观初始化│  │ - 续写         │
│ - 文风初始化  │  │ - 审核         │
│ - 滚动章节   │  │                │
└───┬────────┘  └─────────┬──────┘
    │          LoreGit 工具 │
    └──────────┬───────────┘
               ▼
┌──────────────────────┐
│ storage/<book_id>/    │  ← 每书独立 Git 仓库（Markdown + .git）
└──────────────────────┘
```

**核心设计哲学**：语义判断交给 Agent，确定性 IO 和版本历史交给后端 + Git。后端不裁决剧情，Agent 不能绕过 API 直接写文件。

## 目录结构

```
novel_agent/
├── README.md                        # 项目首页（对外展示）
├── prd.md                           # 产品蓝图（历史文档，设计参考）
├── AGENTS.md                        # Agent 行为规范 + 测试授权
├── FRONTEND_THEME_OPTIONS.md        # 前端视觉备忘
├── REFERENCE_UPSTREAMS.md           # 上游参考资料说明
├── REFERENCE_OPENCODE_DESKTOP_ENTRY_MAP.md  # opencode 桌面端入口映射
│
├── novel_git_server/                # 【后端核心】Flask 服务器
│   ├── app.py                       # Flask 应用入口，路由注册，配置加载
│   ├── config.yml                   # 旧版配置（番茄下载器等遗留配置）
│   ├── requirements.txt             # Python 依赖
│   ├── .env.example                 # 环境变量模板
│   │
│   ├── agents/                      # 路由处理器（每个文件对应一组 API）
│   │   ├── archive.py               # 归档读写：get_file, update_file, append_file, get_archive_range
│   │   ├── chapter.py               # 章节管理：add_chapter, batch_import, search_chapter_index
│   │   ├── checkout.py              # 上下文拼装：按 include 组合输出 Markdown 视图
│   │   ├── git_console.py           # Git 控制台：提交、分支、diff、回滚、draft sandbox
│   │   ├── history.py               # 历史查询：Git 日志
│   │   ├── library.py               # 书架管理：init, search, book 信息
│   │   ├── prose_delivery.py        # 正文交付台：草稿审阅、确认、打回
│   │   ├── rolling.py               # 滚动章节规划器 + 工作台 API
│   │   ├── runtime_config.py        # 运行时配置 CRUD
│   │   ├── session.py               # 会话管理（公开体验模式）
│   │   ├── style_init.py            # 文风初始化管线 API
│   │   ├── summary.py               # 摘要提交
│   │   ├── tomato_import.py         # 番茄小说导入 API（搜索、下载、导入）
│   │   ├── tools.py                 # 工具集：read_chapter, adaptive_slice, extract_highlights
│   │   ├── world_draft.py           # 世界推演主 API + SSE 流式通道
│   │   ├── world_draft_dify.py      # Dify 世界推演客户端
│   │   ├── world_draft_git.py       # 世界推演 Git 操作
│   │   ├── world_draft_layout.py    # 世界推演文件布局保障
│   │   ├── world_draft_sse.py       # 世界推演 SSE 事件编码
│   │   └── world_state.py           # 世界状态批量提交
│   │
│   ├── pipelines/                   # 批处理管线（LangChain 驱动）
│   │   ├── summary_archive.py       # 摘要归档管线：从章节生成 summary.md
│   │   ├── world_model_init.py      # 世界观初始化管线：生成 world_model.md + status_card.md
│   │   ├── style_artifact_init.py   # 文风初始化管线：生成文风诊断三件套
│   │   ├── rolling_chapter.py       # 滚动章节规划器核心逻辑
│   │   ├── batch_parser.py          # 批量解析工具
│   │   ├── extract_schema.py        # Schema 提取
│   │   └── merge_template.py        # 模板合并
│   │
│   ├── utils/                       # 工具库
│   │   ├── book_storage.py          # 书籍存储核心：布局检查、ID 生成、自愈初始化
│   │   ├── dify_client.py           # Dify API 客户端（同步 + 流式）
│   │   ├── dify_registry.py         # Dify Agent 注册表（多 Agent 配置管理）
│   │   ├── git_utils.py             # Git 操作封装
│   │   ├── markdown_sections.py     # Markdown 区块读写
│   │   ├── draft_metadata.py        # 草稿元数据管理
│   │   ├── prose_delivery_state.py  # 正文交付状态机
│   │   ├── session_runtime.py       # 会话运行时管理
│   │   ├── runtime_config.py        # 运行时配置工具
│   │   ├── domain_rules.py          # 领域规则校验
│   │   ├── style_diagnostics.py     # 文风诊断工具（词频、句式等）
│   │   ├── chapter_length.py        # 章节长度工具
│   │   ├── model_provider.py        # 模型提供商抽象（OpenAI 兼容）
│   │   ├── public_demo.py           # 公开体验模式管理
│   │   ├── file_lock.py             # 文件锁（fcntl.flock）
│   │   ├── tomato_importer.py       # 番茄小说导入逻辑
│   │   ├── tomato_search.py         # 番茄小说搜索
│   │   ├── tomato_txt_parser.py     # 番茄 TXT 解析
│   │   ├── tomato_download_adapter.py # 番茄下载适配器
│   │   └── tomato_exe_client.py     # 番茄客户端调用
│   │
│   ├── tests/                       # 测试（50+ 文件，426+ 测试函数）
│   ├── tools/                       # 运维工具（迁移脚本、重构工具等）
│   ├── docs/                        # 后端内部文档（API 文档、OpenAPI spec 等）
│   ├── legacy_attic/                # 历史遗留代码阁楼
│   └── storage/                     # 运行时书籍数据（gitignored）
│
├── frontend/                        # 【前端】React 创作工作台
│   ├── src/
│   │   ├── App.tsx                  # 主应用（155K，核心 UI 逻辑）
│   │   ├── main.tsx                 # 入口
│   │   ├── index.css                # 全局样式
│   │   ├── api/                     # API 调用层
│   │   ├── components/              # UI 组件
│   │   ├── bookshelf/               # 书架页面
│   │   ├── config/                  # 前端配置
│   │   ├── hooks/                   # React Hooks
│   │   ├── i18n/                    # 国际化
│   │   ├── layouts/                 # 布局组件
│   │   ├── lib/                     # 工具函数
│   │   ├── store/                   # Zustand 状态管理
│   │   └── types/                   # TypeScript 类型定义
│   ├── package.json                 # 依赖管理（React 19, Monaco Editor, ReactFlow, Zustand）
│   └── vite.config.ts              # Vite 构建配置
│
├── dify_workflows/                  # Dify 工作流 DSL 导出（YAML）
│   ├── 世界模型agent.yml            # 世界模型 Agent（初始化已退役，保留后初始化协作）
│   ├── 文风学习agent.yml            # 文风 Agent（初始化已退役，保留后初始化协作）
│   ├── 灵感大纲agent.yml            # 【活跃】大纲 Agent
│   ├── 续写agent.yml               # 【活跃】续写 Agent
│   ├── 审核agent.yml               # 【活跃】审核 Agent
│   └── 读书存档agent.yml            # 已退役（摘要主链路已迁到 LangChain）
│
├── deploy/                          # 部署支持
│   ├── demo/                        # 本地 Demo 部署
│   │   ├── backend.Dockerfile       # 后端镜像
│   │   ├── frontend.Dockerfile      # 前端镜像
│   │   ├── compose_smoke.py         # Smoke 测试
│   │   └── deploy_doctor.py         # 部署健康检查
│   └── public_demo/                 # 公开体验部署
│       └── static_proxy.py          # 静态资源代理
│
├── docs/                            # 项目文档（对外 + 技术）
│   ├── ARCHITECTURE.md              # 架构总览
│   ├── TECHNICAL_DOSSIER.md         # 技术档案
│   ├── technical-dossier.html       # 技术档案（HTML 版，GitHub Pages）
│   ├── DEPLOYMENT.md                # 部署说明
│   ├── DEMO_SCRIPT.md               # 演示剧本
│   ├── CLOSEOUT_CHECKLIST.md        # 收口清单
│   ├── DOCUMENT_MAP.md              # 文档地图
│   ├── ROLLING_CHAPTER_WORKFLOW_CASE.md  # 滚动章节工作流案例
│   └── assets/                      # 截图等资源
│
├── docker-compose.demo.yml          # 本地 Demo 启动
├── docker-compose.ghcr.yml          # GHCR 预构建镜像启动
├── start_all.ps1                    # Windows 全栈启动脚本
└── start_demo.ps1                   # Windows Demo 启动脚本
```

## 每本书的存储结构

```
storage/<book_id>/
├── .git/                            # 独立 Git 仓库
├── .gitignore                       # 忽略 .locks/ 和 conflicts/
├── metadata.json                    # 书籍元数据
├── world_model.md                   # 世界百科（地理、势力、规则）
├── status_card.md                   # 运行时状态（位置、关系、目标）
├── summary.md                       # 章节摘要归档
├── style_fingerprint.md             # 文风指纹
├── style_review.md                  # 文风评审
├── style_constraints_for_continuation.md  # 续写文风约束
├── error_archive.md                 # 错误归档（负向约束）
├── brainstorm.md                    # 头脑风暴
├── master_outline.md                # 总纲
├── arc_outline.md                   # 篇章大纲
├── chapter_outline.md               # 章节大纲
├── chapter_draft.md                 # 当前续写草稿（在 draft sandbox 分支）
├── import_report.json              # 导入报告
└── chapters/                        # 原始/归档章节
    ├── 0001_xxx.md
    └── 0002_xxx.md
```

## 核心工作流

### 1. 导入初始化链路

```
番茄 bulk_files
  → 章节解析 + 质量门槛
  → chapters/*.md + import_report.json
  → LangChain 摘要归档管线 → summary.md
  → LangChain 世界观初始化管线 → world_model.md + status_card.md
  → LangChain 文风初始化管线 → 文风诊断三件套
  → 大纲底座
```

### 2. 创作循环链路

```
brainstorm
  → master_outline
  → arc_outline
  → chapter_outline
  → 续写 Agent → chapter_draft.md（草稿分支）
  → 正文交付台 → 审核 / 人工修改 / 打回重写
  → 作者确认归档
  → chapters/*.md + summary/status 更新
  → 下一轮
```

### 3. 章节级人工门控微循环

```
章节大纲已确定
  → 续写 Agent 产出草稿
  → 审核 Agent 给出审查结果
  → 作者决定：再来一轮 / 通过入正史 / 回退草稿 / 改大纲
```

审核 Agent 不会自动触发无限重写，所有"是否继续"和"是否归档"都由作者决定。

### 4. 剧情分支实验室

```
main
├── branch/expose-secret-early      # 独立大纲 + 草稿 + 审核
└── branch/hidden-power-long-game   # 独立状态 + 可比较 diff
```

每个分支可以拥有独立大纲、草稿、审核记录和状态变化。作者可以比较分支差异后决定合并、保留或废弃。

## 关键工程约束

- **文件写入必须经过后端 API**：前端和 Dify Agent 都不能绕过 Flask 直接写文件
- **重要写入必须有 Git 提交**：每次 `update_file` / `append_file` 都会自动 `git commit`
- **核心文件有 ETag 乐观锁**：防止人机同时编辑导致覆盖丢失（章节文件暂为可选模式）
- **Agent 只能写入被授权的文件范围**：后端校验写入路径白名单
- **storage/ 是运行数据，不提交到项目源码**：`.gitignore` 已排除
- **Dify 负责语义决策，后端只做确定性 IO**：后端不裁决剧情、不合并语义冲突

## 本地运行

### 前置条件

- Python 3.11+
- Node.js 22+
- Git
- Dify 服务（本地或远程，需配置 API key）

### 后端启动

```bash
cd novel_git_server
cp .env.example .env.local
# 编辑 .env.local，填入 DIFY_BASE_URL、DIFY_API_KEY 等
pip install -r requirements.txt
python app.py
```

### 前端启动

```bash
cd frontend
cp .env.example .env
# 编辑 .env，设置 VITE_FLASK_ORIGIN
npm install
npm run dev
```

### Docker Compose 一键启动

```bash
docker compose -f docker-compose.demo.yml up -d
```

### 运行测试

```bash
cd novel_git_server
python -m pytest tests/ -v
```

测试规模：50 个测试文件，426+ 测试函数，覆盖 Flask API、Git 分支/diff/回退、Markdown 区块写入、Dify ToolProvider 边界、运行时配置、公开体验会话隔离等核心链路。

## 核心 API 概览

### 书架管理
- `POST /books/init` — 初始化书籍（确定性 ID）
- `GET /books/search?query=...` — 搜索书籍

### 章节管理
- `POST /books/add_chapter` — 添加章节
- `POST /books/batch_import` — 批量导入
- `POST /tools/read_chapter` — 读取章节
- `POST /tools/search_chapter_index` — 关键词搜索

### 归档读写
- `GET /books/get_file?book_id=...&file_name=...` — 读取文件（返回 ETag）
- `POST /books/update_file` — 覆盖写入（需 base_etag）
- `POST /books/append_file` — 增量追加
- `GET /books/get_archive_range` — 按行窗口读取

### 上下文拼装
- `GET /checkout?book_id=...&include=world_model,summary,chapters&last_n=3` — 组合输出

### 世界推演
- `POST /api/world/deduce_stream` — SSE 流式推演（ack → stage → delta → draft_ready → done）

### 草稿管理
- `POST /api/draft/sync_all` — 同步所有草稿
- `POST /api/draft/confirm` — 确认草稿入正史
- `POST /api/draft/rollback` — 回滚草稿

### 番茄小说
- `POST /api/tomato/search` — 搜索
- `POST /api/tomato/import` — 导入

## 开发建议

### 从哪里开始

1. **先读 `docs/ARCHITECTURE.md`** 理解整体分工
2. **读 `novel_git_server/app.py`** 理解路由注册方式
3. **读 `novel_git_server/utils/book_storage.py`** 理解存储协议和自愈机制
4. **读 `novel_git_server/agents/world_draft.py`** 理解最复杂的 Agent API（SSE 流式推演）
5. **读 `frontend/src/App.tsx`** 理解前端主工作台（155K，有点大）

### 添加新 API 的模式

1. 在 `novel_git_server/agents/` 下创建新文件（或加到已有文件）
2. 写一个 `register_xxx_routes(app)` 函数，用 Flask 装饰器注册路由
3. 在 `app.py` 中 import 并调用
4. 用 `app.config["STORAGE_ROOT"]` 获取存储根路径
5. 写操作必须使用 `ensure_book_layout()` 做自愈检查
6. 重要写操作必须用 `git add/commit` 做归档
7. 核心文件写操作需要 ETag 乐观锁校验

### 添加新测试的模式

1. 在 `novel_git_server/tests/` 下创建 `test_vXX_feature_name.py`
2. 使用 `conftest.py` 中的 fixture（临时目录、测试书籍等）
3. 覆盖：正常路径 + 边界条件 + 错误码 + 并发安全（如涉及锁）

## 相关资源

- 公网体验：http://47.237.191.43:15173/
- 演示视频：https://www.bilibili.com/video/BV12eVA69EGV/
- GitHub Pages 技术档案：https://blackzhanzhan.github.io/novel_agent/
