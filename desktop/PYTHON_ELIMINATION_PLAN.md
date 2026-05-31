# 去 Python 化开发计划

## 现状

Tauri 17 个 Rust 命令已覆盖：文件 IO、Git、草稿、Markdown 解析、章节校验。缺口在 AI 引擎。

```
当前依赖链：
  前端 → Tauri invoke (Rust)     ← 文件/Git/草稿 ✓ 已 Rust
  前端 → HTTP → Flask → Python   ← AI 对话/流式  ✗ 要去掉
```

## 阶段一：Rust AI 引擎（最关键的缺口）— 3 天

### 1.1 LLM 调用模块

新建 `src-tauri/src/engine/`：

```
src-tauri/src/engine/
├── mod.rs           # 模块入口
├── llm.rs           # DeepSeek API 调用 (reqwest)
├── agent.rs         # Agent 循环：提示词 + 工具 + LLM 往返
├── streaming.rs     # SSE → Tauri Event 转换
├── prompts.rs       # 提示词常量 (从 engine/*.py 提取)
└── tools.rs         # 工具注册表 → 调已有 Rust 命令
```

`llm.rs` — 直调 DeepSeek API：
```rust
// POST https://api.deepseek.com/v1/chat/completions
// 支持 function calling + streaming
fn chat(messages: &[Message], tools: &[Tool]) -> Result<Response>
fn chat_stream(messages: &[Message], tools: &[Tool]) -> impl Stream<Item = Delta>
```

`agent.rs` — Agent 循环（替代 LangGraph ReAct）：
```rust
fn run_agent(prompt: &str, query: &str, tools: &[Tool], book_id: &str) -> Result<String>
fn run_agent_stream(...) -> impl Stream<Item = AgentEvent>
// AgentEvent = ToolCall(..) | Delta(String) | Done | Error
```

循环逻辑：
```
1. 拼 system prompt + user query → messages
2. POST LLM (with tools)
3. 如果 LLM 返回 function_call → 执行对应的 Rust 命令 → 结果注入 messages → goto 2
4. 如果 LLM 返回 content → 推流式 delta → 结束
```

### 1.2 工具注册表

现有 Rust 命令直接映射为 LLM tool schema：

| LLM tool name | Rust 实现 | 已就绪 |
|---|---|---|
| `get_markdown_outline` | `archive::get_markdown_outline` 核心逻辑 | ✓ |
| `get_markdown_section` | `archive::get_markdown_section` 核心逻辑 | ✓ |
| `get_archive_range` | `archive::get_archive_range` 核心逻辑 | ✓ |
| `get_core_archive` | `archive::get_core_archive` 核心逻辑 | ✓ |
| `extract_chapter_highlights` | `tools::extract_chapter_highlights` | ✓ |
| `draft_append_section` | `draft::do_append` | ✓ |
| `draft_replace_section` | `draft::do_replace` 类似逻辑 | ✓ |
| `validate_chapter_lengths` | `tools::validate_chapter_lengths` | ✓ |
| `generate_style_diagnostics` | 待移植 | ✗ |

工具注册为 DeepSeek function schema：
```rust
fn tool_schemas() -> Vec<Tool> {
    vec![
        Tool {
            name: "get_markdown_outline",
            description: "读取 Markdown 文件的标题结构、section_path 与 base_etag...",
            parameters: json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "file_name": {"type": "string"}
                }
            })
        },
        // ... 其他 8 个工具
    ]
}
```

### 1.3 Tauri Event 流式推送

Agent 产生的 delta 事件通过 Tauri Event 推给前端：

```rust
// 在 Tauri command 中
#[tauri::command]
async fn deduce_stream(
    app: tauri::AppHandle,
    book_id: String,
    intent: String,
    active_file: String,
) -> Result<(), String> {
    let agent = Agent::new(agent_type, &book_id);
    let stream = agent.run_stream(&intent, &active_file);

    tokio::spawn(async move {
        for event in stream {
            app.emit("deduce:event", event).ok();
        }
    });
    Ok(())
}
```

前端监听：
```ts
import { listen } from '@tauri-apps/api/event';
listen('deduce:event', (event) => {
    if (event.payload.type === 'delta') { /* append text */ }
    if (event.payload.type === 'done') { /* finish */ }
});
```

### 1.4 提示词嵌入

从 `novel_git_server/engine/` 复制 3 个系统提示词：
- `CONTINUATION_SYSTEM_PROMPT` → `const CONTINUATION_PROMPT: &str`
- `REVIEW_SYSTEM_PROMPT` → `const REVIEW_PROMPT: &str`
- `DISCUSS_SYSTEM_PROMPT` + `COMMIT_SYSTEM_PROMPT` → `const OUTLINE_DISCUSS_PROMPT` / `const OUTLINE_COMMIT_PROMPT`

用 `include_str!("../prompts/continuation.md")` 加载独立 .md 文件。

---

## 阶段二：端口号 Python 工具函数 — 2 天

### 2.1 文风诊断 (`style_fingerprint.rs`)

`utils/style_diagnostics.py` (1177 行) 的核心逻辑是正则统计：
- 对白比例 (dialogue_ratio)
- 环境密度 (environment_density)
- 段落平均长度 (avg_para)
- 说明密度 (exposition_density)
- 悬念密度 (suspense_density)

这些都是纯正则 + 计数，Rust `regex` crate 直接搬。

### 2.2 Markdown 区块读写

`utils/markdown_sections.py` (303 行) 部分已移植到 `archive.rs`：
- ✓ 标题解析 `parse_heading()`
- ✓ 大纲生成 `build_markdown_outline`
- ✓ 区块提取 `extract_markdown_section`
- ✗ 区块替换 `apply_markdown_patch` — 需要完成

### 2.3 番茄导入相关（可选）

番茄小说的搜索/下载/解析目前完全依赖 Python。Rust 替代方案：
- 搜索 → `reqwest` 调番茄搜索 API
- TXT 解析 → Rust `regex` 做章节切分
- 这个功能优先级低，可以最后做

---

## 阶段三：批量管线替换 — 2 天

### 3.1 摘要归档管线

`pipelines/summary_archive.py` (800 行) 的流程：
1. 分批读 chapters/*.md → 格式化为 prompt
2. 调 LLM 生成摘要 → JSON 解析
3. JSON 验证 → Markdown 渲染 → 写入 summary.md
4. Git commit

全部可用 Rust 实现：`reqwest` 调 LLM + `serde_json` 解析 + 已有文件 IO。

### 3.2 世界观初始化管线

`pipelines/world_model_init.py` (1350 行)：同上模式，两次 LLM 调用（提取 + 验证），Rust 直写。

### 3.3 文风初始化管线

`pipelines/style_artifact_init.py` (176 行)：最简管线，调 `generate_style_diagnostics` + 写文件。

---

## 阶段四：清理 Python 残余 — 1 天

### 删除清单

```
desktop/python_sidecar/         ← 删除整个目录
novel_git_server/               ← 不再需要（已提取提示词和工具契约）
src-tauri/tauri.conf.json       ← 删除 "shell" plugin 配置
Cargo.toml                      ← 删除 tauri-plugin-shell 依赖
```

### 不再需要的依赖

```
Python 3.11                    ← 如果装了只是为了这个项目
flask / flask-cors             ← Rust 替代
langchain / langgraph          ← Rust 替代
pypinyin                       ← 确定性 ID 生成用 Rust 拼音库或纯 hash
GitPython                      ← git2-rs 替代
```

---

## 阶段依赖关系

```
阶段一（AI 引擎）         ← 最紧急，解除对 Flask 的依赖
    ↓
阶段二（工具函数移植）     ← 文风诊断优先级最高（续写 Agent 依赖它）
    ↓
阶段三（批量管线移植）     ← 导入初始化链路，非实时可后台运行
    ↓
阶段四（清理）            ← 最终收尾
```

## 总时间

| 阶段 | 内容 | 时间 |
|------|------|------|
| 一 | AI 引擎 (LLM 调用 + 工具循环 + 流式推送) | 3 天 |
| 二 | 工具函数 (文风诊断 + Markdown 补全) | 2 天 |
| 三 | 批量管线 (摘要/世界观/文风初始化) | 2 天 |
| 四 | 清理 Python 残余 | 1 天 |
| **合计** | | **8 天** |

## 第一个里程碑：纯 Rust 续写链路

阶段一完成后即可跑通：

```
用户输入 "续写第6章" 
  → Tauri command deduce_stream
  → Rust Agent 拼提示词 + 调 DeepSeek API
  → LLM 返回 function_call: get_markdown_outline(chapter_outline.md)
  → Rust 执行命令，返回结果给 LLM
  → LLM 返回 function_call: draft_append_section(chapter_draft.md, ...)
  → Rust 执行命令 + Git commit
  → LLM 返回 function_call: validate_chapter_lengths
  → Rust 执行命令，长度通过
  → LLM 输出 delta 流
  → Tauri Event 推给前端
  → 前端实时显示
```

全程不经过 Python，单个 exe。
