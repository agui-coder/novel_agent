# Architecture Census

Investigation date: 2026-05-07.

This census captures the current agent-actionable architecture. It does not replace source code, Dify runtime state, or per-book Git repositories.

## System Context

`novel_agent` is a local novel creation workbench:

- React/Vite provides the author-facing workbench and bookshelf/import UI.
- Flask provides deterministic file, Git, session, import, backend batch-pipeline, and Dify bridge APIs.
- The backend batch pipeline owns promptless derived-archive jobs such as `summary.md`, world/status initialization, and style diagnostic initialization.
- Dify provides semantic agent orchestration for post-initialization world/style discussion, outline, continuation, and review workflows. The legacy reading archive app may remain as historical runtime evidence, but it is no longer an active owner for `summary.md`.
- Local runtime configuration is controlled through a backend-owned configuration center backed by ignored local env files. It configures Dify App API access and backend model-provider credentials, but it does not edit Dify workflow graphs, prompts, plugin packages, or book content.
- Each book is a local workspace under `novel_git_server/storage/<book_id>/` with its own nested Git repository.
- `dev_repo/` stores process/runtime truth and local conversation logs; this directory now stores architecture and data-model truth.

## Architecture Nodes

| Node | Purpose | Owned Files | Public Interfaces | Depends On | Invariants | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| `frontend-workbench` | Main author IDE: file view, chat, review, Git panels, streaming traces, FSM, and promptless workbench actions including continuation production controls. | `frontend/src/App.tsx`, `frontend/src/store/index.ts`, `frontend/src/types/store.d.ts`, `frontend/src/components/*`, `frontend/src/api/*`, `frontend/src/lib/*` | Browser UI at `http://127.0.0.1:5173`; API clients in `frontend/src/api/*`; continuation workbench action surface | `flask-backend-api`, `session-runtime`, `book-storage-git`, `dify-bridge` through Flask, `rolling-production-orchestrator` through Flask | Never writes storage directly; review state must be backed by draft metadata; user-visible state must survive hydration where persisted; promptless continuation controls must not become hidden chat prompts. | confirmed |
| `frontend-bookshelf-import` | Book list, online Tomato search/import, summary and download polling, book deletion UX. | `frontend/src/bookshelf/BookshelfApp.tsx`, `frontend/src/api/library.ts`, `frontend/src/api/tomatoImport.ts`, `frontend/src/components/TomatoImportPanel.tsx` | Browser bookshelf route and import actions | `flask-backend-api`, `tomato-import-pipeline`, `book-storage-git` | Delete is force-delete from the UI perspective: active Tomato/summary work is cancelled first; locked books may be hidden while cleanup is pending. Imports must surface quality/download/summary state. | confirmed |
| `flask-backend-api` | Local deterministic API shell and blueprint composition. | `novel_git_server/app.py`, `novel_git_server/agents/*.py`, `novel_git_server/tests/*` | `/health`, `/books/*`, `/api/world/*`, `/api/style/init_pipeline`, `/api/rolling/*`, `/api/draft/*`, `/api/conversations/*`, `/tools/*`, `/tools/generate_style_diagnostics`, `/checkout`, Git console routes | `book-storage-git`, `dify-bridge`, `session-runtime`, `tomato-import-pipeline`, `batch-pipeline`, `rolling-production-orchestrator` | JSON responses use UTF-8; book addressing accepts `book_id` or `book_name`; legacy routes remain forbidden; style diagnostics returns three markdown artifacts for the promptless backend style initialization flow; Tomato summary generation is a backend batch-pipeline job, not a Dify chat turn; rolling workbench APIs are control-plane endpoints and must not write prose directly. | confirmed |
| `local-runtime-config` | Local control plane for machine-specific API keys, Dify endpoints, timeouts, and backend model-provider credentials. | `novel_git_server/.env.local` (ignored), `novel_git_server/utils/runtime_config.py`, `novel_git_server/agents/runtime_config.py`, future frontend configuration UI/API client | `/api/runtime/config`, `/api/runtime/config/check`, local env-file helpers | `flask-backend-api`, `dify-bridge`, `batch-pipeline`, `startup-orchestrator` | Secrets must never be returned unmasked, written to chat logs, committed to Git, or stored in book repositories. Saving local config may refresh Flask's Dify route registry, but must not edit Dify workflow graphs, prompts, model nodes, plugin packages, or Dify PostgreSQL credentials. | inferred |
| `book-storage-git` | Per-book filesystem layout, metadata, nested Git repository, branch/diff/review persistence. | `novel_git_server/utils/book_storage.py`, `novel_git_server/utils/git_utils.py`, `novel_git_server/agents/archive.py`, `novel_git_server/agents/git_console.py`, `novel_git_server/agents/checkout.py`, `novel_git_server/agents/history.py` | Storage APIs, Git console APIs, markdown read/write APIs | Local filesystem, Git, Flask helpers | Every book path must stay inside storage root; important writes must commit or return an explicit error; draft writes belong on `draft/sandbox`. | confirmed |
| `dify-bridge` | Local bridge from Flask/session/file targets to Dify App API and active agent route registry. Retired reading-archive compatibility must not be used as the `summary.md` production path. | `novel_git_server/utils/dify_client.py`, `novel_git_server/utils/dify_registry.py`, `novel_git_server/agents/world_draft.py` | `/api/world/deduce_stream`, `/api/world/stop_generation`, Dify `/v1/chat-messages`, Dify file upload | `dify-workflows-runtime`, `book-storage-git`, `session-runtime`, `local-runtime-config` | Stale upstream Dify conversation ids may be retried without breaking local conversations; file route permissions must govern agent read/write scope; world-model routes treat `world_model.md`, `status_card.md`, and `domain_rules.md` as creative constraint surfaces, not loose archives; `reading_archive_agent` is retired from active summary ownership. | confirmed |
| `dify-workflows-runtime` | Live Dify apps, workflow graphs, plugin packages, model/tool providers, workflow run/cost evidence for active semantic agents. A legacy reading archive app may exist only as historical/compatibility evidence. | `dify_workflows/*.yml`, Dify PostgreSQL `apps`, `workflows`, `workflow_runs`, `workflow_node_executions`, Dify plugin storage | Dify console, Dify Service API, LoreGit OpenAPI tool provider including style diagnostics and chapter length validation | Docker Dify stack, `flask-backend-api`, `dify-bridge` | Agent node workflows require `langgenius/agent`; model provider requires `langgenius/deepseek`; local DSL is evidence, not sole truth; world model agent output must explain creative function before archival breadth; style workflow is a post-init discussion/refinement assistant and must not own initialization/rebuild; outline initialization/rebuild must produce four outline-layer drafts that control webnovel expectation, payoff cadence, pacing, hooks, and chapter execution; continuation production must execute `chapter_outline.md` cards into `chapter_draft.md` and pass chapter length validation; retired reading archive workflows must not be treated as active `summary.md` producers. | confirmed |
| `batch-pipeline` | Local LangChain/LangGraph-style batch processing layer and canonical owner for promptless derived archive initialization/rebuild jobs. | `novel_git_server/pipelines/__init__.py`, `novel_git_server/pipelines/world_model_init.py`, `novel_git_server/pipelines/style_artifact_init.py`, `novel_git_server/pipelines/summary_archive.py`, `novel_git_server/pipelines/batch_parser.py` | `/api/world/init_batch_pipeline`, `/api/style/init_pipeline`, Tomato summary archive trigger, pipeline helper APIs | `book-storage-git`, model provider configuration | Pipeline runs locally without Dify multi-turn orchestration; new `summary.md` output is derived from validated structured batch data and deterministically rendered from `chapters/*.md`; world/status initialization is moving to validated structured world facts plus deterministic world/status rendering; style initialization remains a promptless backend job. | confirmed |
| `rolling-production-orchestrator` | Three-chapter rolling coordinator for long-form production: derive chapter cursor, select next batch, trigger continuation, request outline replenishment, expose workbench state, and record evidence. | `novel_git_server/pipelines/rolling_chapter.py`, `scripts/rolling_chapter_production.py`, `docs/ROLLING_CHAPTER_WORKFLOW_CASE.md`, `.runtime/rolling_chapter_*.json` | CLI/dry-run planner, live probe scripts, case-study evidence, `/api/rolling/state`, `/api/rolling/run_stream` | `book-storage-git`, `dify-bridge`, `dify-workflows-runtime`, `dev-repo-runtime` | Orchestrator must not write prose; chapter_draft.md remains owned by continuation workflow; depleted chapter cards must be replenished by outline workflow; human review gates stop the loop; workbench state is a transient projection, not hidden source truth. | confirmed |
| `tomato-import-pipeline` | Parse local Tomato bulk exports, online Tomato search/download fallback, import report, and backend summary archive trigger. | `novel_git_server/agents/tomato_import.py`, `novel_git_server/utils/tomato_*.py`, `frontend/src/api/tomatoImport.ts` | `/books/tomato/*`, `import_report.json`, `/books/tomato/summary_status` | `book-storage-git`, `batch-pipeline`, optional Tomato exe service | Import must pass or explicitly override quality gates; online import writes chapters plus `import_report.json`; active download/summary work must honor per-book cancellation before writeback; summary generation must call the backend batch pipeline rather than Dify `reading_archive_agent`. | confirmed |
| `session-runtime` | Local per-agent conversation index and JSONL message persistence. | `novel_git_server/utils/session_runtime.py`, `novel_git_server/agents/session.py`, `dev_repo/conversations/**` | `/api/conversations/*`, JSON index and JSONL message files | `dev-repo-runtime`, `dify-bridge`, `frontend-workbench` | Local thread id is separate from upstream Dify conversation id; delete/archive semantics must keep active conversation consistent. | confirmed |
| `startup-orchestrator` | Start/stop/status orchestration for Dify, backend, frontend, and post-start health checks. | `start_all.ps1`, `scripts/start_dify.ps1`, `scripts/start_backend.ps1`, `scripts/start_frontend.ps1` | PowerShell commands, pid/log files under `.runtime/` | Docker Desktop/WSL, Python venv, npm/Vite | Must not confuse stale or noncanonical processes with healthy runtime; Dify health depends on required containers plus API reachability. | confirmed |
| `deployment-repro-pack` | Reproducible demo packaging for local Windows bootstrap and containerized demo startup. | `docs/DEPLOYMENT.md`, `deploy/demo/**`, `.env.example`, `docker-compose.demo.yml` | Windows bootstrap command, Docker Compose demo command, smoke healthcheck command | `startup-orchestrator`, `dify-workflows-runtime`, `flask-backend-api`, `frontend-workbench`, `book-storage-git` | Must keep secrets and real book storage out of Git; must restore/check Dify runtime from sanitized seed material only; must prove content is still produced by project Dify Agents through LoreGit tools. | inferred |
| `dev-repo-runtime` | Campaign runtime, evidence index, conversation logs, and architecture/data-model truth. | `dev_repo/state.json`, `journal.jsonl`, `evidence_index.json`, `tree.md`, `dev_repo/conversations/**`, `dev_repo/architecture/**` | Repository files read by agents and humans | Git, contract skills, `session-runtime` | Volatile runtime remains ignored; architecture truth is versioned; old oral summaries do not outrank runtime files. | confirmed |

## Critical Flows

### Startup

`start_all.ps1` invokes Dify, backend, and frontend scripts. Dify readiness is based on required Docker service states plus API reachability. Backend readiness is `/health` from a canonical Python process. Frontend readiness is a canonical Vite dev server on the configured port.

Startup now owns the local runtime port fact. It prefers backend `8000` and frontend `5173`, but may allocate replacement ports when those preferred ports are occupied by noncanonical processes. The chosen ports are written to `.runtime/ports.json`, and the frontend proxy must point to the selected backend port.

Because Dify calls LoreGit tools from Docker through `host.docker.internal`, startup must also synchronize the live Dify LoreGit ToolProvider endpoint to the selected backend port. That sync is endpoint-only: it may rewrite `host.docker.internal:<port>` URLs in `tool_api_providers.schema` and `tools_str`, but must not change the ToolProvider operation set, workflow prompts, or agent responsibilities.

### Local Runtime Configuration

The local runtime configuration center owns machine-specific configuration that
should be easy to initialize from the workbench but unsafe to commit. Its source
artifact is `novel_git_server/.env.local`, which is ignored by Git and imported
by backend startup. The configuration center may expose redacted read, local
save, and health/check APIs for Dify App API keys, Dify base URL, Dify timeout,
and backend batch-pipeline model-provider settings such as DeepSeek base URL,
model, summary model, and API key.

This control plane is deliberately narrower than the live Dify database. It can
refresh Flask's in-process `DIFY_AGENT_REGISTRY` after a save so the next agent
call uses the updated local App API keys, but it must not patch Dify PostgreSQL,
workflow graphs, prompts, model-node thinking flags, ToolProvider operations, or
plugin packages. Those remain `dify-workflows-runtime` responsibilities and
require separate runtime-operation contracts.

Configuration UI belongs to the workbench action/control layer, not to the chat
conversation surface. API keys may be entered in a form, but saved key material
must never be returned unmasked, appended to `chatMessages`, written to
conversation JSONL, written into a book workspace, or committed to Git.

### Reproducible Demo Deployment

The project supports two deployment surfaces.

The local Windows demo pack is a thin wrapper around the existing runtime: it checks prerequisites, prepares environment files without committing secrets, optionally restores a sanitized Dify runtime seed, starts Dify/backend/frontend through the startup orchestrator, synchronizes the LoreGit ToolProvider endpoint, and runs smoke checks. It may use a developer's existing Dify compose directory as a configurable default, but it must not hardcode one user path as the only supported path.

The Compose demo pack is the reproducibility target for a fresh evaluator: it runs the Flask backend and frontend from the repository, mounts an explicit demo storage volume, and either connects to an externally restored Dify stack or starts a documented Dify dependency when that slice is implemented. Compose packaging must preserve the same agent ownership boundaries as local development: outline content comes from the outline Agent, chapter prose comes from the continuation Agent, review findings come from the review Agent, and Codex/local scripts only orchestrate, validate, restore, or package evidence.

The public Release ZIP is a portable source/demo package, not only a Windows archive. Its zip entries must use `/` separators so WSL/Linux extraction produces real directories such as `deploy/demo/` and `docs/`. Compose host ports are configurable through `BACKEND_HOST_PORT` and `FRONTEND_HOST_PORT`, while backend and frontend container ports remain fixed at `8000` and `5173` to preserve health checks, frontend proxying, and smoke checks.

Dify live PostgreSQL plus plugin storage remain the source of runtime truth. Sanitized seeds or backups may reproduce that runtime, but `dify_workflows/*.yml` is exported evidence only unless a contract explicitly synchronizes it into the live database. Deployment scripts must never commit API keys, model credentials, private `.dify_backups`, or real `novel_git_server/storage/` book workspaces.

### Import And Summary Archive

The bookshelf imports a Tomato book through Flask. Backend parses/downloads chapters, writes `chapters/*.md`, writes `import_report.json`, commits to the book Git repo, then triggers the backend summary archive pipeline to generate `summary.md` in batches from the imported chapters. The pipeline must preserve the existing summary status surface used by the bookshelf, update summary metadata, and leave the per-book Git repository clean after a completed summary write.

The legacy Dify `reading_archive_agent` route is retired from the active import path. Historical Dify workflow runs and cost observations remain valid audit evidence, but new summary archive generation/rebuild work belongs to `batch-pipeline` and `tomato-import-pipeline`.

### Summary Archive Ownership

`summary.md` is a derived knowledge file built from `chapters/*.md`, optional import metadata, and human edits. First-create and explicit rebuild semantics are owned by the backend summary archive pipeline. Dify workflows may read `summary.md` as context for world, style, outline, continuation, and review work, but they must not be treated as the active first-create or rebuild owner for the reading archive.

This mirrors the world/style promptless initialization boundary: import and summary generation are fixed backend jobs with structured progress, not natural-language chat turns. Repeated summary rebuilds may be launched from a workbench/bookshelf action surface, and must not be hidden behind Dify chat text.

New backend summary generation is schema-locked. Model calls may run in parallel for small extraction batches, but each call returns structured batch data; the backend then validates coverage and required sections, rejects conversational assistant preambles, sorts by chapter range, builds the top index, and renders the final Chinese Markdown deterministically. Parallel extraction is an implementation detail and never changes Dify ownership or final archive ordering.

### Post-Confirm Archive Bridge

Accepted continuation batches have a derived-state bridge after canonization. Once `/api/draft/confirm` successfully materializes accepted `chapter_draft.md` sections into formal `chapters/*.md`, the backend may run a fixed archive bridge that first refreshes `summary.md` through the backend summary archive pipeline and then refreshes `status_card.md` through the backend status projection helper. This keeps the next continuation batch anchored to the latest formal chapter range rather than an old summary tail.

The bridge is deterministic orchestration, not authorship. It must not generate, rewrite, summarize, polish, or expand chapter prose. It must not call Dify `reading_archive_agent`, route derived state maintenance through the review Agent, or hide progress in chat messages. If summary or status projection fails after chapter canonization, accepted chapters remain canon and the bridge reports a retryable derived-step failure instead of rolling back accepted prose.

`world_model.md` and `domain_rules.md` remain optional world-route targets after the backend bridge. They should be updated only when accepted chapters introduce durable story rules, identities, timeline/loop state, cosmology, contradiction repairs, or reusable domain rules. Routine current-state movement belongs in `status_card.md`.

### Agent Deduction And Draft Review

The workbench selects an active file. The frontend resolves an agent key, sends a stream request to Flask, and Flask routes to the matching Dify app. Dify calls LoreGit tools exposed by Flask. Material writes land on `draft/sandbox`; frontend review state is based on changed files, draft commit id, and diff preview.

### Workbench Actions

Workbench actions are user-triggered operations that run deterministic local pipelines, maintenance commands, Git operations, review decisions, or orchestration commands without being Dify conversation turns. They must not be smuggled through the chat input, stored as user/assistant chat messages, or rendered as if an agent answered them.

The frontend may expose these actions in a dedicated workbench action surface such as a floating dock, file-scoped action bar, review panel, Git panel, or bookshelf panel. The action surface owns progress, success, failure, retry, and disabled-state UI. Examples include world initialization/rebuild through `/api/world/init_batch_pipeline`, style initialization/rebuild through `/api/style/init_pipeline`, repository layout repair, draft confirm/rollback, Git branch management, book import/delete, future rolling three-chapter production controls, quality checks, and human unlock artifacts.

Promptless direct jobs are the strictest workbench-action subtype. A direct job is launched by a fixed button or control, calls a fixed backend route or local handler, and renders deterministic progress from SSE events, step state, or task status fields. It must declare `requiresPrompt=false` at the frontend action-model layer, must not ask the user for a natural-language prompt, and must not translate the click into hidden chat text. World initialization/rebuild is a direct job; future rolling production, quality checks, and human unlock controls should use the same model when their backend contract is fixed enough to run without agent interpretation.

The chat panel remains the Dify Agent conversation surface. Agent chat may explain an action, recommend an action, or report that an action must be launched from the workbench action surface, but chat text must not directly trigger non-chat pipelines by keyword interception. This protects local conversation history from pipeline logs and prevents deterministic operations from looking like repeatable free-form prompts.

### Continuation Workbench

The continuation workbench is the author-facing control surface for rolling chapter production. It belongs to the workbench action layer, not the chat panel. It shows a derived queue from `chapter_outline.md`, formal `chapters/*.md`, and any unconfirmed `chapter_draft.md`: accepted chapters, pending-review draft chapters, pending executable cards, the selected next batch, and the next action such as `continue`, `replenish_outline`, or `await_review`.

The workbench launch control is a promptless direct job. It may default to three chapters, call a rolling state API, and then call a rolling run API that delegates to the existing continuation route. It must render structured progress and must open or refresh the existing review workspace after `chapter_draft.md` is changed.

The workbench does not physically consume cards by deleting them from `chapter_outline.md`. Accepted card consumption is derived from chapter numbers already materialized as formal `chapters/*.md`; unconfirmed headings in `chapter_draft.md` may be shown only as draft/review state. When the card deck is depleted or too small for the requested batch, the workbench must surface outline replenishment as the next action instead of fabricating cards or clearing source outline text.

The continuation workbench may coordinate `book_id`, selected card numbers, `target_file=chapter_draft.md`, and review state, but it must not write novel prose, mutate outline files, bypass `draft/sandbox`, or continue past unresolved review/Git blockers. Prose production remains owned by the continuation Dify workflow.

### Accepted Chapter Canonization

Accepted continuation prose becomes canon only after the human confirms the draft. When `/api/draft/confirm` accepts a change set that includes `chapter_draft.md`, the backend may deterministically split the confirmed draft into chapter sections and materialize them as `chapters/*.md`. This canonization step is a storage/review responsibility, not a prose-writing responsibility: it preserves already accepted text, derives safe chapter filenames from the accepted headings, commits the new chapter files, and fails explicitly on ambiguous parsing or conflicting existing chapter files.

`chapter_draft.md` remains the continuation Agent's review surface. The backend canonization step must not generate, rewrite, expand, polish, or summarize chapter prose. It must not clear `chapter_outline.md`, physically delete consumed cards, or treat unconfirmed draft headings as accepted canon. After successful canonization, the backend resets `chapter_draft.md` to its lightweight draft placeholder so the next rolling batch starts from a clean review surface; this reset happens only after accepted prose has been preserved in `chapters/*.md`. Rolling state should prefer formal `chapters/*.md` for accepted chapter progress while still exposing `chapter_draft.md` as pending review evidence when applicable.

Post-confirm story-state maintenance is staged. The backend archive bridge should refresh `summary.md` and then deterministically project `status_card.md` from the refreshed archive so the next batch sees current timeline, POV, character state, open loops, and immediate obligations. The world-model route may then update `world_model.md` or `domain_rules.md` only when the accepted chapters introduce durable story rules, identities, timeline/loop state, cosmology, contradiction repairs, or other long-lived constraints. The review Agent may flag conflicts and write `error_archive.md`, but it must not approve, materialize, or update chapter canon, `summary.md`, `status_card.md`, or `world_model.md`.

### World Model Constraint Engine

The world model layer is a creative constraint engine for webnovel production. `world_model.md` owns durable story promise, selling-point contract, conflict engines, hard constraints, soft assumptions, contradiction ledger, and downstream workflow interface. `status_card.md` owns current timeline/POV/character/open-loop state and immediate next-chapter obligations. `domain_rules.md` owns reusable machine-readable or semi-machine-readable rules for review and continuation checks. World model agent outputs may cite facts, but accepted updates must also state how each important item constrains continuation, review, outline, style, or archive workflows.

Creative constraints have lifecycle semantics, not only hard/soft labels. A constraint may be current-active, historical-only, retired, overridden, disabled, conditional, inherited as memory/debt/trauma/foreshadowing, or unresolved. It may apply globally, to a timeline, arc, stage, loop, faction, character POV, location, rule system, or source-evidence window. The world model layer must preserve that scope when distilling from `summary.md` or live corrections: old constraints remain historically true when source-backed, but they do not automatically remain current-active.

Downstream agents must consume the lifecycle before consuming the fact. Continuation may write only current-active or explicitly conditional constraints as present-tense story reality; historical-only or retired constraints may be used as memory, residue, debt, foreshadowing, reader irony, or review risk, but not as active ability/state unless the world/status layer marks them current-active. Outline may propose changes under `AUTHOR_PROPOSAL` or `WORLD_MODEL_REQUIRED`, while review should flag lifecycle conflicts such as "old state reused as current state" or "disabled ability treated as active."

### World Initialization Ownership

World initialization is owned by the backend batch pipeline, not by the Dify world workflow. The user-facing initialization intent, including "初始化这本书", routes to `/api/world/init_batch_pipeline`, where `novel_git_server/pipelines/world_model_init.py` must generate and commit both `world_model.md` and `status_card.md`. Dify world workflows remain interactive agents for read, explanation, local correction, and online verification, but they must not be treated as the first-create owner for the world/status pair.

This boundary exists because long-summary extraction is a deterministic backend pipeline concern, while Dify is better suited for conversational agent work after the initial constraint surfaces exist.

In the frontend, world initialization is a promptless direct job, not a chat command. It may appear when the selected file or current context is `world_model.md`, `status_card.md`, or the world-core surface, and its SSE progress belongs to the workbench action UI as a progress bar and step list. It must not append batch progress to local `chatMessages`, must not require prompt text, and typing an initialization phrase into the chat box must not launch `/api/world/init_batch_pipeline` directly.

### Style Artifact Initialization

Style initialization and rebuild are owned by the promptless backend pipeline, not by the live Dify style workflow. The user-facing initialization intent, including "初始化文风" or "重建文风", routes to `/api/style/init_pipeline`, where `novel_git_server/pipelines/style_artifact_init.py` calls deterministic LoreGit diagnostics and commits `style_fingerprint.md`, `style_review.md`, and `style_constraints_for_continuation.md` together. `style_guide.md` remains an author-facing guide and may be updated only as a separate lower-frequency guide, not as a substitute for the three diagnostics products.

The Dify style workflow remains a post-init discussion and refinement assistant. It may read the style artifacts, latest source text, summary, chapter highlights, and diagnostics evidence; it may update style files only when the author explicitly asks for a local revision after discussion. It must hand initialization/rebuild requests back to the workbench action surface instead of calling diagnostics and write tools as a hidden chat pipeline.

In the frontend, style initialization is a promptless direct job, not a chat command. It appears when the selected file or current context is a style surface, and its SSE progress belongs to the workbench action UI. It must not append pipeline progress to local `chatMessages`, must not require prompt text, and typing an initialization phrase into the chat box must not launch `/api/style/init_pipeline` directly.

Deterministic style diagnostics may use specialized profiles when source outline-card evidence proves a chapter has a different production role. In particular, bridge/exposition chapters may select a `bridge_exposition_continuation` profile, and arc-tail choice/resolution chapters may select an `arc_tail_choice_continuation` profile, from `chapter_outline.md` fields such as goal, conflict, payoff, state change, hook, and constraint references. The generated draft may be measured by the diagnostic, but draft prose alone must not select a more permissive profile.

Style diagnostics are now rolling-loop advisory evidence by default. They remain visible to the continuation Agent and author through style artifacts, source-text imitation references, chapter context packs, and review packets, but they do not lock the rolling scheduler by themselves. The continuation prompt treats `style_constraints_for_continuation.md`, `style_guide.md`, and latest source text as imitation references rather than pass/fail contracts. Length validation, plot/world/status consistency, review gates, and human acceptance remain hard boundaries; ordinary scene chapters continue to use the opening or standard continuation profiles for advice and comparison.

The live Dify PostgreSQL ToolProvider and workflow graph are the source of truth for this runtime flow. Patch scripts may reproduce or verify the graph, but YAML exports do not prove live behavior.

### Outline Layer Control

The outline layer is a webnovel serial control system, not a generic plot-note bucket. The four outline files have distinct product roles:

- `brainstorm.md`: selling-point trial pool for premise hypotheses, opening hooks, payoff motifs, risk zones, rejected candidates, and unresolved creative choices.
- `master_outline.md`: reader-promise contract for the long arc, main desire, core loop, terminal direction, expectation debt, and major payoff plan.
- `arc_outline.md`: retention unit plan for 15-30 chapter arcs, entry hooks, pressure ladders, payoff sequence, information gaps, foreshadowing, and arc-end hooks.
- `chapter_outline.md`: chapter production card deck with objective, scene entry, conflict, payoff, state change, foreshadowing action, ending hook, and constraint references.

The live outline workflow has two author-facing duties. `DISCUSS_AGENT` is the ideation engine: it reads source context and gives the author multiple usable routes, hooks, conflicts, payoffs, risks, and recommended landing layers without writing files. `COMMIT_AGENT` is the landing engine: when the author explicitly asks to save, archive, initialize, rebuild, or press an idea into the outline, it converts that idea into reviewable `draft/sandbox` edits for the outline quartet.

For explicit requests such as "初始化大纲" or "重建大纲", the live outline workflow must read `summary.md`, `world_model.md`, `status_card.md`, `style_constraints_for_continuation.md`, and existing outline files, then generate reviewable draft updates for all four outline files through the gated draft/sandbox tools. The outline Agent must not write `chapter_draft.md`; it prepares executable chapter cards for the continuation Agent.

Outline artifacts distinguish three evidence modes. `SOURCE_FACT` is grounded recap/control archive from existing book evidence. `AUTHOR_PROPOSAL` is future-facing production design that may guide the author but is not canon. `WORLD_MODEL_REQUIRED` is any proposed new durable world rule, cosmology, identity, timeline, constraint, resurrection/death state, or contradiction repair that must be accepted by the world-model layer before it can become a hard constraint.

This distinction is especially important after a completed book is initialized. A terminal-arc recap card deck is valid as `SOURCE_FACT`; a continuation request should ask the outline workflow for next-unit production cards and those cards must remain proposal-labeled unless the world/status files already support them.

### Continuation Production Layer

The continuation layer is the prose-production layer for webnovel chapters. It consumes the outline quartet, especially `chapter_outline.md`, plus `summary.md`, `world_model.md`, `status_card.md`, `domain_rules.md`, `style_constraints_for_continuation.md`, `style_guide.md`, and `error_archive.md`. It writes only `chapter_draft.md`.

The continuation Agent must not replace the outline layer by inventing a new structure. It should execute explicit chapter cards from `chapter_outline.md`, use `arc_outline.md` and `master_outline.md` for retention and reader-promise context, and preserve the outline evidence modes:

- `SOURCE_FACT` may be used as source-backed canon.
- `AUTHOR_PROPOSAL` may be dramatized when the author asks for production, but it remains proposal-origin material.
- `WORLD_MODEL_REQUIRED` cannot become a hard fact unless `world_model.md` or `status_card.md` already accepts it.

For multi-chapter production, the continuation Agent must validate chapter lengths after each written chapter through the LoreGit `validate_chapter_lengths` tool. The default production gate is `min_chars=2200`, `target_chars=2500`, and `max_chars=3200`, measured by the tool's `non_whitespace_chars`. Under-minimum chapters require bounded local expansion and revalidation before the Agent may claim the requested set is complete.

The LoreGit draft write tools enforce an additional AI write-loop budget for `chapter_draft.md`: if recent Git history already shows too many consecutive repair-like `[AI_Update]` commits to the draft in the current repair window, another markdown-section write is rejected with `AI_WRITE_LOOP_GUARD`. This is a tool-layer stop, not a style judgment. It exists to prevent a continuation repair from becoming an unbounded sequence of tiny padding commits after length/style gates keep failing, while allowing normal chapter-by-chapter production commits.

When the author explicitly asks for style repair, the optional continuation repair loop is metric-delta guided rather than generic prompt-advice driven. The deterministic style evaluator produces a derived `style_metric_delta` from before/after diagnostics: failed and warning metrics, per-metric direction, proxy targets, protected non-regression metrics, and stop conditions. The continuation Agent may consume that delta and rewrite only the current chapter through `chapter_draft.md`; the rolling orchestrator records and compares the delta but still cannot author prose. A length recovery that passes the length gate while worsening a style metric should stop the optional repair loop instead of continuing blind expansion, but style regression alone is not a scheduler lock.

### Rolling Chapter Production Loop

The rolling production layer coordinates long-form chapter generation as a three-chapter human-in-the-loop cadence. It does not own prose generation. It derives accepted progress from formal `chapters/*.md`, pending-review draft progress from `chapter_draft.md`, and executable cards from `chapter_outline.md`; it selects the next unwritten chapter-card batch, triggers the existing continuation workflow to write that batch, stops at validation/review gates, and asks the outline workflow to replenish executable chapter cards when the current card deck is depleted.

The loop is intentionally derived-state-first. Accepted consumed cards are inferred from formal chapter filenames and headings under `chapters/*.md`; pending-review cards can be inferred from headings already present in `chapter_draft.md` but cannot advance the accepted cursor until confirmed. Pending cards are inferred from executable `chapter_outline.md` cards. If the next batch cannot reach the requested batch size, the orchestrator reports `replenish_outline` rather than inventing new cards or writing prose itself.

Chapter-card field completeness is advisory rather than a scheduler gate. If a pending card has a readable chapter number and outline text, the orchestrator may select it for continuation even when structured fields are missing; the missing fields remain visible as diagnostics and the raw outline text is carried into the continuation context pack. When the deck is depleted, the frontend exposes "生成下一批章节卡", routes to the outline Agent, and refreshes rolling state afterward. Neither the rolling layer nor the continuation Agent may fabricate new outline cards in local code.

Runtime evidence for a rolling cycle belongs in `.runtime/rolling_chapter_*.json` and case-study docs such as `docs/ROLLING_CHAPTER_WORKFLOW_CASE.md`. The orchestrator may call `/api/world/deduce_stream` for outline and continuation routes, but all durable book edits must still be made by the appropriate Dify workflow through LoreGit draft tools. Human review remains the stop gate between accepted batches.

Rolling evidence may include deterministic style diagnostic profile metadata so a bridge/exposition chapter can be compared against its chapter-card role. The orchestrator records that evidence as `style_advisory` by default; it still cannot repair or rewrite prose directly, and style failures alone do not lock the scheduler.

Rolling evidence may also include style metric deltas. These deltas are evaluator evidence for optional continuation repair or author-facing polish: they translate style diagnostic findings into measurable proxy goals such as paragraph-count increase, environment cue-cluster reduction, dialogue-ratio reduction, exposition-trigger reduction, and no-new-hard-regression guardrails. They do not become source prose, hidden outline state, human approval, or scheduler locks.

Rolling evidence may also include a `Chapter Context Pack`. This is a derived current-chapter execution brief built from
existing truth sources before the continuation Agent writes. It may summarize executable chapter-card fields, current
world/status obligations, style and repair-gate evidence, non-negotiable facts, forbidden promotions of unresolved
`WORLD_MODEL_REQUIRED`, and a decision chain for the target chapter. It is not generated prose, hidden canon, hidden
outline state, or human approval. The pack exists to make the continuation Agent write from project truth and current
scene decisions rather than recent prose inertia; `chapter_draft.md` remains owned only by the continuation route.

When a hard deterministic quality gate blocks a structural action, the rolling layer must route through a review bridge before any human override can release the blocked action. The bridge packages planner state, length diagnostics, plot/world/status risk, style advisory evidence, repair deltas, workflow run ids, and Git evidence into a review packet. The existing review Agent may interpret hard story-continuity risk and write reusable findings only to `error_archive.md`; it may not write `chapter_draft.md` and its recommendation is not approval. Only an explicit human unlock artifact can release a hard blocked action such as outline replenishment, and that artifact must be bound to the same book, chapter, gate source, and blocked action.

### Local Conversations

Frontend conversation state is hydrated from `/api/conversations/context`. Backend stores one index per book and agent plus JSONL message logs. Local `conversation_id` is stable even when Dify upstream conversation ids must be recreated after restore or migration.

### Book Deletion

Book deletion first cancels active Tomato download and reading-summary background work for the target `book_id`, including the optional Tomato exe service, then tries to remove the storage directory. On Windows lock failure, backend attempts cleanup, trash rename, and finally a pending-delete marker. Books with pending-delete markers are hidden from list/search while cleanup retries after lock release.

## Known Debt

- `dev_repo/state.json` and historical docs contain encoding damage from earlier Windows/terminal flows.
- `docs/ARCHITECTURE.md` is useful human context but is not a machine-readable architecture constitution.
- Dify live database is the true runtime for workflow graphs; `dify_workflows/*.yml` is ignored and should be treated as exported evidence unless a contract explicitly synchronizes it.
- `frontend/src/App.tsx` is very large and owns multiple concerns; future broad UI changes should treat it as a high-risk node.
- Cost governance is currently query/report based rather than codified as a budget guard.
- Historical Dify `INIT_AGENT` prompt work is superseded by the backend-owned initialization contract; Dify may still keep read/revision/online nodes for post-init interaction.
- Historical Dify `reading_archive_agent` rows may remain for cost audit or compatibility, but `summary.md` active production is now a backend batch-pipeline responsibility.
- Runtime startup previously had split port truth: `start_all.ps1` used backend `8000` while the live LoreGit ToolProvider pointed at `8001`. ADR-0007 makes startup the port fact source and requires endpoint sync.
