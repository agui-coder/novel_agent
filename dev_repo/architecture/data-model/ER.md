# Entity Relationship Census

Investigation date: 2026-05-07.

## Entity Groups

### Book Storage

- `BookWorkspace`: one directory under `novel_git_server/storage/<book_id>/`.
- `BookMetadata`: `metadata.json`, source for book display name and update time.
- `ChapterFile`: source chapter markdown under `chapters/*.md`, created either by import/manual archive or by deterministic canonization of human-confirmed continuation drafts.
- `KnowledgeFile`: maintained markdown files such as `world_model.md`, `summary.md`, `status_card.md`, `style_guide.md`, outlines, `domain_rules.md`, `error_archive.md`, and `chapter_draft.md`. `summary.md` is a backend-derived archive from `chapters/*.md`, import metadata, and later human edits; first-create/rebuild belongs to the backend summary archive pipeline, not Dify `reading_archive_agent`. New backend-generated `summary.md` is rendered from validated structured batch data: model extraction batches may run concurrently, but final coverage validation, sorting, index construction, and Markdown rendering are deterministic backend responsibilities. The world/status/domain trio is the creative constraint engine for continuation, review, outline, style, and archive workflows. World-model constraints carry lifecycle semantics: current-active, historical-only, retired, overridden, disabled, conditional, inherited residue, or unresolved, plus an applicability scope such as global, timeline, arc, stage, loop, faction, POV, location, rule system, or evidence window. The outline quartet (`brainstorm.md`, `master_outline.md`, `arc_outline.md`, `chapter_outline.md`) is the webnovel serial control layer: selling-point trial pool, reader-promise contract, retention-unit plan, and chapter production card deck. Outline content carries evidence-mode semantics: `SOURCE_FACT` for source-backed recap/control archive, `AUTHOR_PROPOSAL` for future production design, and `WORLD_MODEL_REQUIRED` for proposed durable world-rule changes that require world-model acceptance before becoming hard constraints. `chapter_draft.md` is the continuation production artifact: it is virtual/defaulted until materialized, written only by the continuation route, and should remain traceable to executable chapter cards plus world/status/style constraints. After human confirmation, accepted `chapter_draft.md` sections may be canonized into `ChapterFile` artifacts, but the draft file itself remains a review surface rather than the long-term chapter archive.
- `ImportReport`: `import_report.json`, produced by local or online import.
- `DraftSandbox`: `draft/sandbox` branch plus changed files used by review.
- `GitRepositoryState`: nested `.git` state, branches, commits, diffs, and working tree.
- `PendingDeleteMarker`: `_pending_delete/<book_id>.json`, hides locked books while physical cleanup remains pending.

### Conversation Runtime

- `SessionConversationIndex`: one index per book and agent under `dev_repo/conversations/<agent>/<book_id>.index.json`.
- `ConversationMessageLog`: JSONL messages per conversation under `dev_repo/conversations/<agent>/<book_id>__<conversation_id>.jsonl`.

### Dify Runtime

- `DifyAgentRoute`: local Flask route registry mapping active files to Dify apps and read/write scopes. The review route is the editorial interpretation route for rolling gate evidence: it may read draft/context files and write only `error_archive.md`. The legacy `reading_archive_agent` route is retired from active `summary.md` production.
- `DifyWorkflowDefinition`: Dify app workflow graph in live DB, with local DSL exports as evidence. Legacy reading archive workflows are historical/compatibility evidence only.
- `DifyWorkflowRun`: Dify workflow execution row.
- `DifyNodeExecution`: Dify node-level execution and cost row.
- `DifyPluginPackage`: plugin package required by workflow nodes, such as `langgenius/agent` and `langgenius/deepseek`.
- `ToolProvider`: LoreGit OpenAPI provider configured in Dify.
- `CostObservation`: derived accounting view over `workflow_node_executions`, not `messages.total_price`.
- `RollingProductionRun`: derived evidence for a rolling chapter-production cycle. It records a cursor over `chapter_outline.md` and `chapter_draft.md`, requested batch size, next action, workflow run ids, validation outputs, style advisory summaries, style metric deltas, chapter context packs, Git commits, review packets, review recommendations, human unlock artifacts, and human-review stop state. It is evidence, not a new source-of-truth table.

### Local Runtime Configuration

- `LocalRuntimeConfig`: machine-local configuration materialized in ignored env files such as `novel_git_server/.env.local`. It contains Dify Service API base URL, Dify timeout, per-agent Dify App API keys, and backend model-provider settings for batch pipelines such as DeepSeek base URL, model names, and API key. It is source configuration for the local Flask process, but it is not a book artifact, not a conversation artifact, and not a Dify workflow definition.
- `RedactedRuntimeConfigView`: derived API response that reports configured/missing state, source, masked value, and short suffix information for `LocalRuntimeConfig` without exposing full secret values.

### Governance Runtime

- `RuntimeContract`: current and historical contract state in `dev_repo/state.json`, `journal.jsonl`, `evidence_index.json`, and `tree.md`.
- `ArchitectureTruthArtifact`: versioned files under `dev_repo/architecture/**`.

## High-Level Relationships

- One `BookWorkspace` owns one `BookMetadata`, many `ChapterFile`, many `KnowledgeFile`, zero or one latest `ImportReport`, one `GitRepositoryState`, and optionally one `PendingDeleteMarker`.
- Deleting one `BookWorkspace` must first cancel active Tomato download and reading-summary background work for that `book_id`; if physical cleanup is blocked, a `PendingDeleteMarker` hides it until cleanup succeeds.
- One `BookWorkspace` has many `SessionConversationIndex` rows, one per agent key.
- Deleting or fresh/rebuild-importing one `BookWorkspace` must delete local `SessionConversationIndex` and `ConversationMessageLog` artifacts for that same `book_id` before the next workbench hydration can expose agent threads.
- One `SessionConversationIndex` contains many conversation metadata entries and points to zero or one active conversation.
- One conversation metadata entry owns one `ConversationMessageLog`.
- One `LocalRuntimeConfig` may derive many `DifyAgentRoute` entries when Flask builds or refreshes the agent registry. Updating it changes future route credentials only after the backend applies the refresh.
- One `RedactedRuntimeConfigView` is derived from one `LocalRuntimeConfig` plus process defaults. It must not include complete API keys or raw secret values.
- One `DifyAgentRoute` maps a file scope and agent key to one Dify app/API key configuration.
- One backend summary archive pipeline derives `summary.md` from many `ChapterFile` artifacts and commits the resulting `KnowledgeFile` plus metadata changes when applicable. Intermediate structured batch results are derived validation inputs; they are discarded or kept only as runtime evidence and must not bypass final coverage checks.
- One world-model `DifyAgentRoute` reads and writes the `KnowledgeFile` trio `world_model.md`, `status_card.md`, and `domain_rules.md`; continuation/review/style/outline routes read them as constraint inputs.
- World-model constraint lifecycle is part of the `KnowledgeFile` semantics, not a separate source table. The same fact can remain source-backed history while its lifecycle changes from current-active to historical-only, retired, overridden, disabled, conditional, inherited residue, or unresolved.
- One outline `DifyAgentRoute` reads and writes only the outline quartet `brainstorm.md`, `master_outline.md`, `arc_outline.md`, and `chapter_outline.md`; it may read context through the live workflow tools but does not own `summary.md`, world/status/style files, `error_archive.md`, or `chapter_draft.md`. It may write future-facing production proposals, but new hard world rules remain `WORLD_MODEL_REQUIRED` until accepted by the world-model layer.
- One continuation `DifyAgentRoute` reads `chapter_draft.md`, the outline quartet, `summary.md`, `world_model.md`, `status_card.md`, `domain_rules.md`, style artifacts, and `error_archive.md`; it writes only `chapter_draft.md`. It turns executable chapter cards into reviewable prose and must preserve `SOURCE_FACT` / `AUTHOR_PROPOSAL` / `WORLD_MODEL_REQUIRED` boundaries.
- The draft write tools may derive an AI write-loop budget from recent `GitRepositoryState` for `chapter_draft.md`. The budget is a transient guard over recent commit history, not a new durable source entity, and a guard hit returns `AI_WRITE_LOOP_GUARD` without changing `KnowledgeFile` content.
- One review `DifyAgentRoute` reads `chapter_draft.md`, the outline quartet, `summary.md`, `world_model.md`, `status_card.md`, `domain_rules.md`, style artifacts, and `error_archive.md`; it writes only `error_archive.md`. It interprets rolling review packets for plot continuity, world/status consistency, causal chain, chapter-card fulfillment, and unresolved `WORLD_MODEL_REQUIRED` risk. Style evidence is advisory; the review route cannot approve or unlock blocked structural actions.
- One confirmed draft flow may derive many `ChapterFile` artifacts from one accepted `chapter_draft.md` `KnowledgeFile`. This relationship is deterministic canonization, not generation: the backend preserves accepted text and fails on ambiguous headings or conflicting chapter files.
- One `RollingProductionRun` observes one `BookWorkspace`, derives accepted consumed chapter cards from `chapters/*.md`, derives pending-review draft chapters from `chapter_draft.md`, derives pending chapter cards from `chapter_outline.md`, and may trigger outline or continuation `DifyAgentRoute` calls. It never owns prose content and never replaces `KnowledgeFile` or `ChapterFile` as source artifacts.
- One `RollingProductionRun` may derive a style advisory summary or metric delta from style diagnostics. The evidence records metric movement, proxy repair goals, protected non-regression metrics, and author/continuation guidance. It is derived advisory evaluator evidence and must not contain generated chapter prose or lock the scheduler by default.
- One `RollingProductionRun` may derive a chapter context pack from existing outline, world/status/domain, summary, style, error, gate, and metric-delta artifacts. The pack is a current-chapter execution brief for the continuation route. It is derived evidence and must not contain generated chapter prose, hidden canon, hidden outline state, or scheduler approval.
- One `RollingProductionRun` may produce a review packet, call the review `DifyAgentRoute`, and record a human unlock artifact. The review recommendation is advisory evidence; the human unlock artifact is the only derived evidence that can release a hard blocked structural action when a non-style deterministic quality gate has not passed.
- Initial generation or explicit rebuild of `summary.md` is produced by the backend summary archive pipeline and committed in the per-book Git repository. Dify reading archive workflow rows remain historical audit/cost evidence and do not own future `summary.md` production.
- Initial generation of the `world_model.md` and `status_card.md` pair is produced by the backend batch pipeline and committed in the per-book Git repository. Dify workflows can revise or explain the files after initialization, but do not own the initial pair creation. New backend world/status generation should derive final Markdown from validated structured world facts: `world_model.md` is the durable constraint rendering, and `status_card.md` is the current-state projection from accepted facts plus the latest summary batch. The intermediate fact objects are derived validation inputs and are not a new persisted source entity unless a later contract creates one.
- Post-confirm story-state maintenance belongs to the world-model route: accepted chapter batches should refresh `status_card.md`, while `world_model.md` changes are reserved for durable world rules, identities, timeline/loop state, cosmology, contradiction repairs, or other long-lived constraints. The review route remains limited to `error_archive.md`.
- One `DifyWorkflowDefinition` can produce many `DifyWorkflowRun`.
- One `DifyWorkflowRun` contains many `DifyNodeExecution`.
- One `CostObservation` is derived from a filtered set of `DifyNodeExecution` rows.
- One `ToolProvider` exposes Flask routes for use by many Dify workflow tool nodes.

## Current Runtime Notes

- Book deletion is force-delete from the user experience perspective: active Tomato/summary tasks are cancelled first, and locked storage may be hidden with a pending-delete marker while physical cleanup retries later.
- Online import for an absent workspace, or overwrite/rebuild import for an existing workspace, must reset prior local conversation runtime for the same `book_id`; failed imports and collision-blocked imports must leave existing conversation runtime intact.
- Active Dify runtime tokens cover world, review, style, outline, and continuation. A legacy reading archive app/token may still exist as historical compatibility evidence, but it is retired from active summary generation.
- Local API keys and provider credentials belong to `LocalRuntimeConfig` and should be initialized through the configuration center or local env files. They must remain outside Git, outside book workspaces, outside chat logs, and outside Dify prompt exports.
- Historical Dify DB evidence shows reading archive dominated cost; cost must be calculated from billable node executions rather than message totals to avoid double counting iteration aggregates.
- World model files are currently allowed to remain old, empty, or sparse until an explicit author action or future repair slice upgrades them; no automatic backfill is implied by the creative constraint engine decision.
- The initialization owners are now backend batch pipelines for `summary.md`, the world/status pair, and the style diagnostics trio. Existing Dify workflow run rows remain evidence only; no migration or backfill is implied by the ownership change.
