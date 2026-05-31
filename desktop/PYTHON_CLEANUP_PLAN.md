# 去 Python 化清理计划

## 一、前端残留 HTTP（2 个文件，14 个函数）

| 文件 | 函数 | 端点 | 优先级 |
|------|------|------|--------|
| `api/proseDelivery.ts` | `fetchProseDeliveryState` | `/api/prose_delivery/state` | P1 |
| | `refreshProseDelivery` | `/api/prose_delivery/refresh` | P1 |
| | `manualSaveProseDelivery` | `/api/prose_delivery/manual_save` | P1 |
| | `submitReviewReport` | `/api/prose_delivery/review_report` | P1 |
| | `submitRewriteRequest` | `/api/prose_delivery/rewrite_request` | P1 |
| `api/tomatoImport.ts` | `previewTomatoImport` 等 8 个 | `/books/tomato/*` | P2 |

**P1 处理**：`proseDelivery.ts` 是审查确认/打回的状态机。替代方案：已有 `draft_confirm` 和 `draft_rollback` Rust 命令。简化为调用这两个命令 + 本地状态管理。工作量 1 天。

**P2 处理**：番茄导入暂时保留 HTTP（非核心创作流程），用户有 Flask 时才可用。或在 Rust 里实现简单的 TXT 批量导入。工作量 2 天。

## 二、Rust 引擎缺失的工具（1 个）

| 工具 | Python 实现 | 状态 |
|------|------------|------|
| `generate_style_diagnostics` | `utils/style_diagnostics.py` (1177行) | 未注册 |

Agent 调用时返回 "Unknown tool" 错误。需要注册到 `engine/tools.rs`。工作量 2 小时。

## 三、批量管线（3 个 Python 管线）

| 管线 | 文件 | 行数 | 做什么 |
|------|------|------|--------|
| 摘要归档 | `pipelines/summary_archive.py` | 800 | 从导入章节生成 summary.md |
| 世界观初始化 | `pipelines/world_model_init.py` | 1350 | 从 summary 提取世界事实 |
| 文风初始化 | `pipelines/style_artifact_init.py` | 176 | 生成文风诊断三件套 |

这三个是导入流程的一部分。替代方案：每个都是一次 LLM 调用 + 文件写入，可在 Rust 里用 `deduce_blocking` + 专门的提示词实现。工作量 2 天。

## 四、可删除的旧代码

| 路径 | 原因 |
|------|------|
| `novel_git_server/engine/` | 已迁移到 Rust `desktop/src-tauri/src/engine/` |
| `novel_git_server/agents/` | Flask 路由，已迁移到 Rust 命令 |
| `novel_git_server/app.py` | Flask 入口，已不需要 |
| `novel_git_server/utils/dify_client.py` | Dify 客户端，已废弃 |
| `novel_git_server/utils/dify_registry.py` | Dify 注册表，已废弃 |
| `desktop/python_sidecar/main.py` | 占位 stub |
| `desktop/src-tauri/src/sidecar/` | 未使用的 sidecar 模块 |
| `desktop/src-tauri/src/commands/sidecar_cmd.rs` | 未使用的命令 |

**注意**：`novel_git_server/pipelines/` 暂时保留（管线尚未移植），`novel_git_server/tests/` 保留（测试资产），`novel_git_server/storage/` 保留（运行时书库数据）。

## 五、执行顺序

```
第 1 步 (2h)：注册 generate_style_diagnostics 工具
               → Agent 调用文风诊断不再报 Unknown tool

第 2 步 (1d)：proseDelivery 去 HTTP
               → 审查工作台用 draft_confirm/draft_rollback

第 3 步 (2d)：批量管线移植到 Rust
               → 摘要/世界观/文风初始化可用

第 4 步 (1h)：清理旧代码
               → 删除 engine/、agents/、app.py、dify_client、sidecar
               → 删除 python_sidecar/

第 5 步 (2d)：番茄导入（可选）
               → Rust 实现 TXT 批量导入
```

**总计**：5 天（不含番茄导入 3 天）
