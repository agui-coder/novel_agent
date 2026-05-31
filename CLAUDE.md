# Novel Agent Desktop — AI 编码规范

> **加载方式**：本文件在每次 AI 编码会话中 always 加载。
> **适用范围**：`desktop/` 目录下的 Rust 后端 + React 前端 + Tauri 胶水层。
> **旧项目**：`novel_git_server/`（Python Flask）、`frontend/`（React）、`dify_workflows/` 是 Python 时代遗留，不再维护，**不要在上面改代码**。架构参考见 `DEVELOPMENT.md`、技术债见 `desktop/技术债.md`。

---

## 一、项目边界（必记）

| 目录 | 状态 | 说明 |
|------|------|------|
| `desktop/src-tauri/` | **活跃** | Rust 后端，单体 crate，Tauri v2 |
| `desktop/src/` | **活跃** | React 19 前端，Zustand 状态管理 |
| `desktop/src-tauri/prompts/` | **活跃** | AI Agent 的 system prompt，`include_str!` 嵌入 |
| `.claude/skills/` | **活跃** | 开发工作流 Skill（Code review、收尾清单等） |
| `novel_git_server/` | 废弃 | Python Flask 后端，已被 Rust 替代 |
| `frontend/` | 废弃 | 旧前端，已被 `desktop/src/` 替代 |
| `dify_workflows/` | 废弃 | Dify DSL，已被 Rust engine 替代 |
| `storage/` | 运行时 | 书籍数据（Markdown + .git），勿提交到 git |

**原则**：新功能只在 `desktop/` 下实现。旧代码可参考逻辑，不照搬实现。

---

## 二、架构分层（依赖方向，不可违反）

```
┌─ React 前端 (desktop/src/) ──────────────────────────┐
│  components/  ← 纯 UI，不直接调 invoke()              │
│  hooks/       ← 业务逻辑 + invoke() 调用               │
│  store/       ← Zustand，全局状态                      │
│  api/         ← invoke() 封装层，返回类型化结果          │
└──────────────┬───────────────────────────────────────┘
               │ Tauri IPC (invoke / listen)
┌──────────────▼───────────────────────────────────────┐
│  lib.rs           ← 命令注册 + AppState                │
│  commands/        ← #[tauri::command] 处理器           │
│  engine/          ← Agent 运行时 + LLM 客户端 + 工具     │
│  storage/         ← 文件读写 + etag + 布局管理          │
└──────────────────────────────────────────────────────┘
```

**依赖规则（编译方向=箭头方向，禁止反向）**：

1. `commands/` → `engine/`, `storage/`（commands 可以调用 engine 和 storage）
2. `engine/` → `storage/`（engine 可以通过 storage 读写文件）
3. **禁止**：`storage/` → `engine/` 或 `commands/`
4. **禁止**：`engine/` → `commands/`
5. `storage/` 不依赖任何上层模块

**前端规则**：
1. `components/` 不直接调 `invoke()` —— 通过 props 或 hooks 接收数据
2. `hooks/` 封装 `invoke()` + Tauri `listen()` 事件
3. `store/` 只被 hooks 和 components 使用，不直接调 `api/`
4. `api/` 层只做 IPC 调用和错误映射，不做状态管理

---

## 三、Rust 编码规范

### 3.1 错误处理

```rust
// 禁止：生产路径用 unwrap()、expect()、.ok() 吞错
let content = fs::read_to_string(&path).unwrap();     // ❌
let x = result.ok();                                   // ❌ 吞错

// 推荐：用 ? 传播，在边界处 map_err 转为可读信息
let content = fs::read_to_string(&path).map_err(|e| format!("Read {}: {e}", path.display()))?; // ✅

// 禁止：裸 String 做错误类型的新增
fn do_thing() -> Result<(), String> { ... }           // ❌ 不要新增这种函数签名
```

**错误类型约定**（`src-tauri/src/error.rs`，已规划待创建）：
- `LlmError` — LLM API 调用失败（rate limit、context exceeded、network error）
- `StorageError` — 文件 IO、路径越狱、etag 冲突
- `ToolError` — 工具调用失败（参数校验、权限拒绝、执行错误）

在此之前，**至少**保证 `map_err` 中的错误信息包含足够上下文：操作名、文件路径、原始错误原因。

### 3.2 所有权与借用

```rust
// 禁止：遇所有权问题就 .clone()
fn process(data: &str) -> String {
    let owned = data.to_string();  // ❌ 能借用就不要抢所有权
    // ...
}

// 推荐：优先借用
fn process(data: &str) -> String {  // ✅
    // ...
}

// 允许：跨线程传递、存入 HashMap、返回给调用方时 clone
```

### 3.3 Tauri 命令规范

```rust
// 命令签名：State<'_, AppState> 必须用下划线生命周期
#[tauri::command]
pub fn my_command(
    state: State<'_, AppState>,       // ✅
    book_id: Option<String>,          // 可选参数
    file_name: String,                // 必选参数
) -> Result<MyResult, String> {       // 返回 Result
    // ...
}
```

- 前端 `invoke('my_command', { ... })` 的参数名必须与 Rust 参数名一致（snake_case 自动映射）
- 不要在 `generate_handler!` 中重复注册同一命令
- 新增命令后确认前端 `invoke` 调用点参数匹配

### 3.4 导入规范

```rust
// 禁止：通配符导入
use crate::engine::*;               // ❌

// 推荐：显式导入
use crate::engine::agent::run_agent_streaming;  // ✅
use crate::engine::llm::{Message, ToolCall};    // ✅（少量可以 grouped）
```

### 3.5 日志

```rust
use log::{info, warn, error, debug};

// info：启动、session 边界、LLM 调用成功/失败
// warn：可恢复的异常（etag 冲突、retry 耗尽）
// error：不可恢复的错误
// debug：工具调用细节、LLM 请求参数（脱敏后）

// 禁止：API Key、完整 prompt 内容、工具调用全文 进入日志
// 禁止：用 println!()，必须用 log 宏
```

### 3.6 新增 Prompt 文件

在 `desktop/src-tauri/prompts/` 下新建 `.md` 文件后：
1. 在 `desktop/src-tauri/src/engine/prompts.rs` 中加 `pub const XXX_PROMPT: &str = include_str!("../../prompts/xxx.md");`
2. 在 `desktop/src-tauri/src/engine/agent.rs` 的 `AgentType` 枚举中加变体（如需新增 Agent 类型）
3. 在 `run_agent_streaming` 的 match 分支中映射新 Prompt
4. Prompt 中引用的工具名必须与 `tools.rs::ToolRegistry` 注册的一致

---

## 四、TypeScript / React 编码规范

### 4.1 新增 Zustand State

**原则**：不要继续膨胀 `store/index.ts`（948 行）。新增状态用 slice 模式：

```typescript
// store/chatSlice.ts
import { StateCreator } from 'zustand';
import { AppStore, ChatSlice } from '../types/store';

export const createChatSlice: StateCreator<AppStore, [], [], ChatSlice> = (set, get) => ({
  chatMessages: [],
  pushUserMessage: (text) => { /* ... */ },
  // ...
});
```

然后在 `store/index.ts` 的 `create` 中组合：

```typescript
export const useAppStore = create<AppStore>()((...a) => ({
  ...createChatSlice(...a),
  ...createGitSlice(...a),
  // ...
}));
```

**禁止**：在已有 slice 文件超过 150 行后继续往里面加状态。拆新 slice 文件。

### 4.2 Component vs Hook vs API 边界

```typescript
// components/  — 纯渲染，通过 props 接收数据和回调
<ChatPanel
  messages={store.chatMessages}
  onSend={handleSend}
/>

// hooks/       — 封装 invoke() 和 listen()，管理异步生命周期
function useAgentSession(deps: { store: AppStore }) {
  const handleSend = useCallback(async (text: string) => {
    const { taskId } = await invokeApi('deduce_stream', { ... });
    // ...
  }, []);
  return { handleSend, ... };
}

// api/         — 纯函数，invoke() 封装 + 错误类型映射
export async function deduceStream(args: DeduceArgs): Promise<{ taskId: string }> {
  return invokeApi('deduce_stream', args);
}
```

**禁止**：
- Component 中直接写 `await invoke(...)` —— 抽到 hook 或 api
- `api/` 中 import store 或做状态管理
- `hooks/` 中直接操作 DOM

### 4.3 类型安全

```typescript
// 禁止：用 any 做新类型声明
function handle(payload: any): any { ... }     // ❌

// 推荐：具体类型
function handle(payload: DeducePayload): DeduceResult { ... }  // ✅

// 禁止：在 store action 参数中用 any
// 允许：在 listen() 回调的事件 data 中用 unknown + type guard
```

### 4.4 新增 Tauri IPC 调用

1. 在 `api/` 下对应的文件中加封装函数（返回类型化的 Promise）
2. 确认 Rust 端命令名与前端 `invoke` 第一个参数一致
3. 错误映射用 `invokeApi`（在 `api/client.ts`），它会自动做 `ApiError` 转换
4. 流式事件监听用 `listen()`（Tauri event），**不用 `api/sse.ts`**（它已废弃）

---

## 五、命名与文件约定

### 5.1 Rust

| 项目 | 惯例 | 示例 |
|------|------|------|
| 文件名 | snake_case | `agent.rs`, `chapter_list.rs` |
| 类型/结构体 | PascalCase | `AgentEngine`, `ToolRegistry` |
| 函数/方法 | snake_case | `run_agent_streaming`, `resolve_book_id` |
| 常量 | SCREAMING_SNAKE_CASE | `DEFAULT_BASE`, `MAX_BATCH_CHAPTERS` |
| Tauri 命令 | snake_case | `deduce_stream`, `git_log` |
| Tauri 事件 | snake_case + 模块前缀 | `deduce:event`, `pipeline:event`, `style:event` |

### 5.2 TypeScript

| 项目 | 惯例 | 示例 |
|------|------|------|
| 组件文件 | PascalCase | `ChatPanel.tsx` |
| Hook 文件 | camelCase (use 前缀) | `useAgentSession.ts` |
| API 文件 | camelCase | `orchestration.ts` |
| Store 文件 | camelCase | `chatSlice.ts`, `index.ts` |
| 类型/接口 | PascalCase | `ChatMessage`, `DeducePayload` |
| 函数/变量 | camelCase | `handleSend`, `resolveAgentKey` |
| 常量 | SCREAMING_SNAKE_CASE | `UI_LANGUAGE_STORAGE_KEY` |

### 5.3 文件组织

```
desktop/src/
├── api/            # invoke() 封装，按功能域分文件
├── components/     # 按功能域分组（非按类型）
├── hooks/          # 自定义 hooks
├── store/          # Zustand store + slices
├── types/          # TypeScript 类型定义
├── lib/            # 纯工具函数（不依赖 React/Tauri）
├── layouts/        # 布局组件
└── i18n/           # 国际化

desktop/src-tauri/src/
├── main.rs         # 入口
├── lib.rs          # Tauri 配置 + 命令注册
├── error.rs        # 统一错误类型（待创建）
├── engine/         # LLM + Agent + Tools
├── commands/       # Tauri 命令处理器
└── storage/        # 文件读写 + 布局管理
```

---

## 六、测试规范

### 6.1 何时写测试

- **必须写**：文件路径安全函数（`resolve_file_path` 覆盖路径越狱场景）
- **必须写**：book_id 解析逻辑（`resolve_book_id`、`find_book_id`）
- **必须写**：章节号解析（支持中文数字 十一、十二、三十五）
- **必须写**：流式 Tool Call 参数解析逻辑
- **建议写**：etag 计算与冲突检测
- **可以不写**：Tauri 命令函数体的胶水代码（如参数透传 + 调用 engine）

### 6.2 Rust 测试位置

```
desktop/src-tauri/tests/
├── unit/
│   ├── storage_tests.rs
│   ├── tool_tests.rs
│   └── llm_tests.rs
└── integration/
    └── agent_pipeline.rs
```

当前 `desktop/src-tauri/tests/unit_tests.rs` 中重复实现了生产代码——**禁止继续此模式**。测试必须 `use` 被测试的生产代码，不要复制粘贴。

### 6.3 前端测试

前端目前无测试框架。引入 Vitest 后，优先给 `lib/` 下的工具函数补测试。

---

## 七、Git 规范

### 7.1 Commit Message

遵循已有格式：
```
feat: <新功能>
fix: <bug 修复>
chore: <杂项（依赖、构建、配置）>
docs: <文档>
refactor: <重构（不改变功能）>
```

commit message 描述"为什么改"而非"改了什么"，后者写在 PR 描述中。

### 7.2 分支策略

- `main` — 稳定分支，不对其直接 commit
- `feature/<name>` — 功能分支，从 main 切出
- `fix/<name>` — 修复分支

### 7.3 不要提交的内容

- `desktop/.env`（API key 等敏感信息）
- `desktop/src-tauri/gen/`（tauri 生成代码）
- `storage/`（运行时书籍数据）
- 任何包含 API Key 的配置文件

---

## 八、AI Skill 与 Prompt 管理

### 8.1 开发工作流 Skill（`.claude/skills/`）

- 仅开发者使用，不会被编译进二进制
- 命名格式：`<skill-name>/SKILL.md`，含 frontmatter
- 当前 Skill：
  - `post-change-checklist/` — 修改代码后的收尾清单
  - `awesome-novel/` — 小说写作工作流（非编码用）

### 8.2 Agent Prompt（`desktop/src-tauri/prompts/`）

- 运行时由 `include_str!` 嵌入二进制
- 修改后必须确认编译通过（`cargo check`）
- 新增 Agent 类型需要同步更新 `AgentType` 枚举

### 8.3 新增 Skill 或 Prompt 的检查清单

- [ ] 文件位置正确（Skill → `.claude/skills/`，Agent Prompt → `desktop/src-tauri/prompts/`）
- [ ] Frontmatter 完整（Skill 需要 `name`、`description`）
- [ ] 对 Agent Prompt，`prompts.rs` 中有对应 `include_str!`
- [ ] 对 Agent Prompt，`AgentType` 枚举 + `run_agent_streaming` match 分支已更新
- [ ] 工具名引用与 `ToolRegistry` 一致

---

## 九、禁止事项（硬性）

| 禁止 | 原因 |
|------|------|
| 在 `novel_git_server/` 或 `frontend/` 下写新代码 | 已废弃的 Python 旧项目 |
| 在 `commands/` 或 `engine/` 中使用 `unwrap()` / `expect()` | 生产路径无 panic |
| 在 `api/` 中使用 `any` 类型 | 类型安全 |
| 在 `lib.rs` 的 `generate_handler!` 中重复注册命令 | 已知技术债（见 `desktop/技术债.md` §1.2） |
| 在 store 中直接调用 `invoke()` | 违反分层 |
| 新增依赖全局 `OnceLock` 的隐式状态 | 改用参数注入（见 `desktop/技术债.md` §2.5） |
| 在测试中复制生产代码 | 测试必须引用被测试代码 |
| `println!()` 或 `console.log()` 留在提交中 | 用 `log` crate（Rust）/ 开发完成后清理（TS） |
| 提交 `.env`、`storage/`、API Key | 安全 |

---

## 十、修改代码后的收尾流程

每次在 `desktop/` 下完成代码修改后，执行以下步骤。详见 Skill `post-change-checklist`。

1. **代码清理**：删除无调用方的函数/import/模块、Python 残留
2. **链路走查**：通读 diff，核对 IPC/事件/工具调用链路
3. **Rust 审查**：检查 unwrap、unsafe、并发、错误处理
4. **`cargo check --manifest-path desktop/src-tauri/Cargo.toml`**（0 error）
5. **`cargo test --manifest-path desktop/src-tauri/Cargo.toml`**（全绿）
6. **`cd desktop && npm run build`**（前端 build 通过）
7. **Prompt 同步**：如改 prompt，确认 `include_str!` + `AgentType` 已更新
