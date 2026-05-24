# Data Model Invariants

## Book Identity And Storage

- `book_id` is the durable workspace identity.
- `book_id` must not contain path separators, whitespace, or unsupported characters.
- A `BookWorkspace` path must stay inside `novel_git_server/storage/`.
- `metadata.json` may be missing fields in older workspaces; readers must tolerate defaults.

## File Source Status

- `chapters/*.md` is source imported chapter content.
- `chapters/*.md` also contains accepted continuation chapters after deterministic canonization of human-confirmed `chapter_draft.md` sections. Canonization preserves accepted text and must not generate or rewrite prose.
- `import_report.json` is derived evidence from an import operation.
- Knowledge markdown files are mixed source/derived because humans and agents can both edit them.
- `summary.md` first-create/rebuild is derived from `chapters/*.md` by the backend summary archive pipeline. Historical Dify-generated summaries remain valid history, but Dify `reading_archive_agent` is retired from active ownership.
- New backend-generated `summary.md` is rendered from validated structured batch data. Parallel extraction results are intermediate derived data and must not become a durable source artifact unless all source chapters are covered and the renderer can produce the canonical Chinese archive sections.
- `chapter_draft.md` is virtual/defaulted until materialized.
- `chapter_draft.md` remains a continuation review surface even after its accepted sections are canonized into `chapters/*.md`; it is not the formal long-term chapter archive.
- After successful canonization, `chapter_draft.md` should return to the lightweight default draft placeholder and must not retain already archived chapter prose. This reset is a post-success workspace cleanup, not prose generation or rewriting.
- `.loregit/prose_delivery_state.json` is derived control-plane state for the current `chapter_draft.md` delivery transaction. It is not source prose, not hidden canon, not a `KnowledgeFile`, and not human approval.
- `ProseDeliveryState` must bind to `draft_branch`, `base_branch`, `base_commit`, and `draft_commit`. Any manual save or continuation rewrite that changes `draft_commit` must mark older review reports stale before archive or rewrite decisions can proceed.
- `error_archive.md` is long-term reusable review memory. Current pass/problem status, per-finding rewrite requests, unsaved manual edits, and archive eligibility belong to `ProseDeliveryState`, not to `error_archive.md`.
- `world_model.md`, `status_card.md`, and `domain_rules.md` are the creative constraint engine: `world_model.md` owns durable story promise and hard/soft constraints, `status_card.md` owns current run state and immediate obligations, and `domain_rules.md` owns reusable rule blocks.
- World-model constraint lifecycle is part of `KnowledgeFile` semantics. A source-backed constraint can be current-active, historical-only, retired, overridden, disabled, conditional, inherited residue, or unresolved, and its applicability may be global or limited to a timeline, arc, stage, loop, faction, POV, location, rule system, or evidence window.
- Historical-only, retired, overridden, disabled, inherited-residue, or unresolved constraints must not be consumed as present-tense story facts by continuation, outline, review, or rolling evidence unless `world_model.md` or `status_card.md` explicitly marks them current-active or conditional for the active scope.
- Backend initialization pipeline is the source of first-create/rebuild semantics for the `world_model.md` + `status_card.md` pair. Dify workflows may revise those files after initialization but are not the canonical initial producer.
- New backend world/status output is rendered from validated structured world facts or an equivalent intermediate object. Intermediate facts are derived validation data, not a durable source file.
- `status_card.md` is a current-state projection. It must include evidence anchors and must not be accepted when required values are mostly empty, generic, or `???`.
- `brainstorm.md`, `master_outline.md`, `arc_outline.md`, and `chapter_outline.md` form the outline control layer: selling-point trial pool, reader-promise contract, retention-unit plan, and chapter production card deck.
- The outline Agent may write only those four outline files. It must not write `chapter_draft.md`, world/status/domain files, style files, `summary.md`, or `error_archive.md`.
- Outline quartet content distinguishes `SOURCE_FACT`, `AUTHOR_PROPOSAL`, and `WORLD_MODEL_REQUIRED`. Only `SOURCE_FACT` may be treated as source-backed canon; `AUTHOR_PROPOSAL` guides future writing; `WORLD_MODEL_REQUIRED` must be resolved by the world-model layer before becoming a hard constraint.
- The continuation Agent is the only Dify route that may materialize or update `chapter_draft.md`. It must read executable cards from `chapter_outline.md` and may not rewrite outline, world/status/domain, style, summary, or error files.
- Continuation-generated `chapter_draft.md` content must not promote unresolved `WORLD_MODEL_REQUIRED` proposals into source-backed canon.
- Accepted multi-chapter continuation output must have chapter length validation evidence for the requested set.
- The `chapter_draft.md` AI write-loop budget is derived from recent per-book Git history and must not create hidden prose state. A guard hit leaves `chapter_draft.md` unchanged and surfaces `AI_WRITE_LOOP_GUARD` as explicit tool failure evidence.
- Rolling chapter production state is derived evidence. The accepted consumed cursor must be computed from formal `chapters/*.md`, while pending-review draft progress may be computed from `chapter_draft.md`, Dify workflow evidence, validation outputs, and Git history; it must not become hidden source truth that outranks the markdown files.
- Accepted rolling progress must be computed from formal `chapters/*.md`; pending-review progress may be computed from `chapter_draft.md` but must not advance accepted canon until confirm/canonization succeeds.
- Continuation workbench state is a transient projection over rolling chapter production state. It may expose written, pending, selected, and next-action fields to the frontend, but it must not become a source entity, hidden cursor, or physical mutation of `chapter_outline.md`.
- Style advisory summaries and style metric deltas are derived evaluator evidence inside rolling production state. They may guide continuation repair or author revision, but they must not contain generated prose, override `chapter_draft.md` as the prose source, or lock the scheduler by default.
- Chapter context packs are derived execution-brief evidence inside rolling production state. They may guide continuation by compacting current truth sources, decision chains, non-negotiable facts, and gate feedback, but they must not contain generated prose, become hidden canon, replace outline files, or override `chapter_draft.md` as the prose source.
- `RollingProductionRun` may record next actions and stop reasons, but it may not contain generated chapter prose as the production source. Prose must remain in `chapter_draft.md` and be written only by the continuation route.
- Rolling review packets, review recommendations, and human unlock artifacts are derived evidence inside `RollingProductionRun`. They may explain or release a hard scheduler block, but they must not become hidden source prose or hidden outline source.
- Review Agent recommendations are not human approval. A hard failed quality gate may release a blocked structural action only when an explicit human unlock artifact is bound to the same `book_id`, chapter number, gate source, and blocked action. Style advisory failures do not require unlock.
- The review route may write only `error_archive.md`; it must not materialize or update `chapter_draft.md`. Its hard scope is plot continuity, world/status consistency, causal chain, chapter-card fulfillment, and unresolved `WORLD_MODEL_REQUIRED` risk.
- The review route may not materialize `chapters/*.md`, update `summary.md`, update `status_card.md`, or update `world_model.md`. Post-confirm derived maintenance is staged from accepted `ChapterFile` artifacts to backend `summary.md` refresh, backend `status_card.md` projection, then optional world-route durable updates. `world_model.md` remains reserved for durable constraint changes.

## Draft And Git

- `draft/sandbox` is the review branch for material AI or human draft writes.
- `draft/sandbox` is branch-scoped review state, not a global story draft. Its durable review semantics include a source plot branch and source commit captured at draft creation or inferred during legacy migration.
- Confirm/rollback semantics are part of the data model.
- Confirming a draft must merge into the draft source plot branch only. A checkout on another plot branch must not become the merge target by accident.
- Diff/review baselines must come from the draft source plot branch, not from a later current checkout branch.
- Rollback must reset or delete only the draft review branch and must not rewrite the source plot branch unless a future explicit recovery contract says so.
- Rollback must clear active `ProseDeliveryState` for the rolled-back draft branch. Confirm/archive success must clear or archive the active state only after accepted prose has been preserved and post-confirm handoff has either completed or reported a retryable failure.
- Per-book `.git` is not optional once a workspace is initialized.

## Conversation Runtime

- `SessionConversationIndex` identity is `book_id + agent_key`.
- `ConversationMessageLog` identity is `book_id + agent_key + conversation_id`.
- Local conversation ids and upstream Dify conversation ids must stay separate.
- Archive and delete are different operations.
- Deleting a book, resolving a pending delete for a missing book, or successfully fresh/rebuild-importing the same `book_id` must clear that book's local conversation indexes and logs before the workspace is exposed again.
- Failed imports and collision-blocked imports must not clear existing conversation indexes or logs.

## Dify And Cost

- Dify live DB rows are runtime evidence, not repository source files.
- `DifyWorkflowDefinition` may require both database rows and plugin storage.
- Cost accounting should use billable node executions, not `messages.total_price`, unless a future amendment proves that source safe.
- World model workflow semantics must be verified against the live Dify DB graph before claiming runtime behavior changed.
- Retiring Dify initialization ownership must be proven from live Dify DB graph evidence, not YAML exports.
- Legacy Dify reading archive rows are audit/cost evidence only; active summary archive generation must be proven from backend pipeline and per-book Git evidence.

## Amendment Required

Open an ER/data-model amendment before changing:

- entity existence, ownership, or identity;
- relationship cardinality or deletion semantics;
- tracked layout files;
- conversation index or JSONL log format;
- import report schema;
- Dify route file ownership;
- `summary.md` source/derived ownership, output format, metadata boundary, or rebuild semantics;
- creative role semantics of `world_model.md`, `status_card.md`, or `domain_rules.md`;
- world-model constraint lifecycle values, applicability scopes, or current-active consumption semantics;
- initialization source semantics for `world_model.md` or `status_card.md`;
- outline evidence-mode semantics or world-model gating for future production proposals;
- continuation production ownership of `chapter_draft.md`, chapter-card execution semantics, or chapter length gate semantics;
- accepted chapter canonization semantics between `chapter_draft.md` and `chapters/*.md`;
- `ProseDeliveryState` identity, source/derived classification, state-machine semantics, stale-review invalidation, manual-edit semantics, rewrite request semantics, or cleanup semantics;
- `chapter_draft.md` AI write-loop budget threshold/window or guard failure semantics;
- `DraftSandbox` source-branch identity, source-commit capture, legacy source inference, confirm target, or rollback target semantics;
- style advisory or metric-delta repair evidence semantics, protected-metric stop rules, scheduler-lock semantics, or continuation repair loop semantics;
- chapter context pack derived-evidence semantics, source-reference requirements, or continuation consumption rules;
- rolling production cursor semantics, replenishment semantics, review bridge semantics, human unlock semantics, or human-review stop-gate semantics;
- cost accounting formula or enforcement model.
