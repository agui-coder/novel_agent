# Architecture Invariants

## Source Of Truth

- Source code owns behavior.
- Dify live database and plugin storage own live Dify runtime truth.
- `dify_workflows/*.yml` is exported evidence unless a contract explicitly synchronizes it with live Dify.
- `novel_git_server/storage/<book_id>/` owns book runtime data and nested Git history.
- Deployment seed material may reproduce a demo runtime, but it must not outrank live Dify PostgreSQL plus plugin storage after restore.
- `dev_repo/state.json`, `journal.jsonl`, `evidence_index.json`, and `tree.md` own campaign runtime truth.
- `dev_repo/architecture/**` owns architecture and data-model truth.

## Write Boundaries

- The frontend must not write book storage directly.
- Dify workflows must write book files only through Flask/LoreGit tools.
- Draft mutations must go through `draft/sandbox` until confirmed.
- When confirmed draft changes include `chapter_draft.md`, deterministic backend canonization may archive the accepted chapter sections into `chapters/*.md`; this step must preserve accepted prose exactly, fail on ambiguous/conflicting chapter files, and never author new prose.
- After successful `chapter_draft.md` canonization, the backend must reset `chapter_draft.md` to its lightweight draft placeholder only after accepted prose has landed in `chapters/*.md`; failed, conflicting, or unparseable canonization must leave the draft branch review surface intact.
- Important book writes must either produce a Git commit or return an explicit error.
- Paths derived from user input must stay inside the intended storage or dev_repo root.
- Chat input and `chatMessages` are reserved for Dify Agent conversation turns, not deterministic workbench actions.
- Frontend keyword interception must not launch non-chat pipelines such as world initialization, style initialization, repository repair, rolling production controls, quality checks, human unlocks, draft decisions, Git operations, book import, or book deletion.
- Non-chat workbench actions must have their own UI surface for launch, progress, success, failure, retry, and disabled state. Existing review, Git, and bookshelf panels already satisfy this boundary for their owned actions; world/style initialization and future rolling controls should use a dedicated workbench action surface rather than chat bubbles.
- Promptless direct jobs must declare that they require no natural-language prompt, must launch from a fixed button/control, must call a fixed route or handler, and must render progress from structured events or task status rather than assistant prose.
- Agent chat may recommend or explain a workbench action, but it must not make the action look like a repeatable free-form prompt.
- Continuation workbench controls are promptless direct jobs. They may derive and display chapter-card queue state, selected batch, progress, and review entrypoints, but they must not append hidden chat prompts or pipeline logs into `chatMessages`.
- `world_model.md`, `status_card.md`, and `domain_rules.md` together form the world-model creative constraint engine; agent updates to them must explain downstream writing or review impact, not only archive facts.
- World-model constraints must preserve lifecycle and applicability scope. A source-backed constraint may be current-active, historical-only, retired, overridden, disabled, conditional, inherited residue, or unresolved, and may apply globally or only to a timeline, arc, stage, loop, faction, POV, location, rule system, or evidence window.
- Downstream workflows must not flatten lifecycle-scoped constraints into one active hard-constraint pool. Historical/retired/disabled constraints may inform memory, debt, trauma, foreshadowing, reader irony, or review risk, but only current-active or explicitly conditional constraints may be treated as present-tense story reality.
- Initial creation or rebuild of the world/status pair is owned by the backend batch pipeline. Initialization may not be split between backend `world_model.md` generation and Dify `status_card.md` repair.
- Initial creation or rebuild of the style diagnostics trio is owned by the promptless backend style pipeline. Initialization/rebuild must not stop at `style_guide.md`: explicit style init must produce and commit `style_fingerprint.md`, `style_review.md`, and `style_constraints_for_continuation.md` through `/api/style/init_pipeline`.
- Dify style workflows are post-initialization discussion and refinement agents. They may read diagnostics and write minimal author-requested revisions, but they must not be the canonical owner for "初始化文风" or "重建文风".
- First-create or explicit rebuild of `summary.md` is owned by the backend summary archive pipeline. Tomato import and summary rebuild actions must not call Dify `reading_archive_agent` as the active production path.
- Dify reading archive workflow rows and historical runs may remain as compatibility or audit evidence, but they must not outrank backend summary archive pipeline output for future `summary.md` generation.
- Style diagnostic profile selection must be deterministic and source-evidence based. Bridge/exposition and arc-tail choice profiles may be selected from `chapter_outline.md` card evidence, but generated draft prose alone must not select a more permissive profile.
- Style diagnostics are rolling-loop advisory evidence by default. They may inform continuation prompts and author revision, but style fail/warn metrics must not lock the scheduler unless a separate non-style hard gate is explicitly introduced by contract.
- Outline initialization/rebuild must not stop at advice or a single outline file: explicit outline init must produce reviewable drafts for `brainstorm.md`, `master_outline.md`, `arc_outline.md`, and `chapter_outline.md`, with each layer serving its webnovel production role.
- The outline Agent must not write prose chapters. It may produce executable chapter cards, but `chapter_draft.md` remains owned by the continuation route.
- Outline facts must not blur source-backed recap and future production design. Durable outline statements should be labeled or structured as `SOURCE_FACT`, `AUTHOR_PROPOSAL`, or `WORLD_MODEL_REQUIRED`.
- New hard world rules proposed during outline work must route through `world_model.md`/`status_card.md` ownership before downstream agents treat them as canon.
- Outline evidence citations must reference real readable files; nonexistent helper names such as `hard_constraints.md` are not valid evidence.
- Continuation production must execute `chapter_outline.md` cards into `chapter_draft.md`; it may read outline, world/status/domain, summary, style, and error files but may write only `chapter_draft.md`.
- Continuation production must treat unresolved `WORLD_MODEL_REQUIRED` items as blocked or non-canon until the world-model layer accepts them.
- Multi-chapter continuation production must validate chapter lengths with `validate_chapter_lengths` after each written chapter and must not claim completion while requested chapters remain under `min_chars`.
- `chapter_draft.md` AI write loops must be bounded at the draft-write tool layer. When recent Git history shows the continuation path is producing repeated repair-like `[AI_Update]` commits in the current repair window, the next markdown-section write must fail explicitly with `AI_WRITE_LOOP_GUARD` rather than allowing more tiny padding commits.
- Optional continuation style repair must be driven by deterministic style diagnostics and metric-delta evidence when the author asks for prose polish or when a prior repair fails or regresses. The repair delta may guide the continuation Agent, but it does not authorize Codex, review, or orchestration code to write prose, and it must not become a scheduler lock by itself.
- Rolling chapter production must be a coordinator only: it may derive chapter-card consumption, trigger outline/continuation routes, and record evidence, but it must not directly write novel prose.
- Rolling chapter production must stop at human review gates. It may not continue to the next accepted batch while the current batch has unresolved length, plot/world/status consistency, review, Git, or author-confirmation blockers.
- Rolling chapter production must replenish executable chapter cards through the outline route when `chapter_outline.md` is depleted or insufficient for the next requested batch; it must not fabricate chapter cards in local orchestration code.
- Rolling chapter production exposed through the frontend workbench must treat consumed cards as derived state, not as physical deletion from `chapter_outline.md`: accepted consumption comes from `chapters/*.md`, while `chapter_draft.md` represents pending-review progress.
- Rolling chapter production must distinguish accepted chapter progress from pending-review draft progress. Accepted progress comes from formal `chapters/*.md`; `chapter_draft.md` headings are draft/review evidence until confirmation and canonization.
- Rolling workbench APIs may expose transient state and stream progress, but they must not directly write novel prose; prose remains written only by the continuation route into `chapter_draft.md`.
- Rolling style metric deltas are derived advisory evidence. They may compare before/after diagnostics, identify protected metrics, and guide continuation or author revision, but they must not become source prose, hidden outline state, scheduler approval, or a default scheduler lock.
- Chapter context packs are derived evidence. They may compact outline, world/status/domain, summary, style, error, and gate evidence into a current-chapter execution brief for the continuation Agent, but they must not contain generated prose, become hidden canon, replace outline files, or unlock the scheduler.
- A hard blocked rolling structural action may be released only by a passing hard gate or an explicit human unlock artifact bound to the same book, chapter, gate source, and blocked action. Review Agent recommendations are advisory evidence and must not silently unlock the scheduler.
- The review Agent may interpret rolling gate evidence and may write reusable findings only to `error_archive.md`; its hard review scope is plot continuity, world/status consistency, causal chain, chapter-card fulfillment, and unresolved `WORLD_MODEL_REQUIRED` risk. It must not write `chapter_draft.md` or turn style advice into a scheduler lock.
- The review Agent must not materialize accepted chapters, update `status_card.md`, or update `world_model.md`. Post-confirm status/world maintenance belongs to the world-model route; `status_card.md` is the regular per-batch target, while `world_model.md` is reserved for durable story-rule or lifecycle changes.
- Deployment scripts may orchestrate, restore, start, and verify the demo runtime, but they must not generate outline cards, write novel prose, or bypass Dify Agent/LoreGit ownership.
- Deployment scripts, examples, and compose files must not commit API keys, model credentials, private `.dify_backups`, real book workspaces, or machine-specific absolute paths as required defaults.

## Runtime Boundaries

- Dify style workflow prompt and tool-provider changes must be verified from the live PostgreSQL ToolProvider/workflow graph, not only from exported YAML.
- Local `conversation_id` and upstream Dify `conversation_id` are different identities.
- Dify agent-node workflows require the `langgenius/agent` plugin package at runtime.
- DeepSeek model use requires a valid `langgenius/deepseek` provider configuration.
- Startup scripts must distinguish canonical local backend/frontend processes from unrelated port owners.
- Startup scripts own the local runtime port fact through `.runtime/ports.json`; frontend proxy and Dify LoreGit ToolProvider endpoints must follow that selected backend port.
- Dify LoreGit ToolProvider endpoint synchronization may rewrite only `host.docker.internal:<port>` URLs in the live `tool_api_providers` row. It must not change the ToolProvider operation set, workflow prompts, or agent responsibilities.
- World model Dify prompt changes must be verified from the live PostgreSQL workflow graph, not only from exported YAML.
- Dify world workflows are post-initialization interactive agents. They must not be the canonical owner for "初始化这本书".
- Dify style workflows are post-initialization interactive agents. They must not be the canonical owner for "初始化文风".
- Dify outline workflow prompt and tool changes must be verified from the live PostgreSQL workflow graph, not only from exported YAML.
- Dify continuation workflow prompt and tool changes must be verified from the live PostgreSQL workflow graph and live LoreGit ToolProvider rows, not only from exported YAML or historical patch scripts.
- Retired Dify reading archive runtime rows are historical evidence only. Re-enabling them as the default `summary.md` owner requires an architecture and ER amendment.
- Reproducible deployment has two official surfaces: a local Windows demo bootstrap around `start_all.ps1`, and a Compose demo pack for backend/frontend/demo storage plus explicit Dify connectivity.
- Public Release ZIP assets must use portable `/` path separators so WSL/Linux extraction produces real directories, not literal backslash filenames.
- Compose demo users may change host ports with `BACKEND_HOST_PORT` and `FRONTEND_HOST_PORT`; backend and frontend container ports stay fixed at `8000` and `5173` unless a separate deployment-topology amendment changes health checks and proxying.
- Local deployment may provide configurable defaults for the developer's Dify compose path, but it must not require a single user-specific path to work.
- Deployment smoke checks must prove backend, frontend, Dify API, and Dify-to-LoreGit reachability; process liveness alone is insufficient.

## Amendment Required

Open an architecture amendment before changing:

- subsystem boundaries or module responsibilities;
- public API route ownership;
- Dify plugin, workflow, or tool-provider ownership;
- Dify ToolProvider public operation set, including LoreGit diagnostics tools;
- Dify ToolProvider public operation set, including LoreGit continuation validation tools;
- deterministic style diagnostic profile semantics or profile-selection evidence source;
- world model creative constraint ownership or downstream workflow interface;
- world-model constraint lifecycle semantics, applicability scopes, or downstream current-active consumption rules;
- world initialization ownership between backend pipeline and Dify workflow;
- style initialization ownership between backend pipeline and Dify workflow;
- summary archive ownership between backend pipeline and Dify reading archive workflow;
- file write ownership or draft/review flow;
- outline production-control evidence modes or world-model gating semantics;
- continuation chapter-card execution, length-gate semantics, or `chapter_draft.md` production ownership;
- `chapter_draft.md` AI write loop budget semantics or guard threshold/window;
- continuation style advisory/repair loop semantics, metric-delta evidence semantics, or no-regression stop conditions;
- chapter context pack derived-evidence semantics, source-reference requirements, or continuation consumption rules;
- rolling chapter production orchestration, chapter-card consumption semantics, replenishment semantics, human-review stop gates, review bridge semantics, or human unlock semantics;
- accepted chapter canonization semantics, including how confirmed `chapter_draft.md` content becomes `chapters/*.md`;
- startup topology or canonical process detection;
- startup runtime port fact ownership or Dify ToolProvider endpoint synchronization rules;
- deployment topology, sanitized Dify restore authority, demo data boundary, or secret-handling boundary;
- world_model.md lifecycle schema or lifecycle-aware output format changes;
- architecture truth schema or versioning policy.
