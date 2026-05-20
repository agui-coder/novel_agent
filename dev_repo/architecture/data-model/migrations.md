# Migration And Backfill Notes

## Current Bootstrap

This bootstrap records architecture and ER truth only. It does not migrate or backfill application data.

## Existing Data Compatibility

- Existing `dev_repo/state.json`, `journal.jsonl`, `evidence_index.json`, and `tree.md` remain untouched.
- Existing `dev_repo/conversations/**` runtime logs remain ignored and untouched.
- Existing `novel_git_server/storage/**` book workspaces remain untouched.
- Existing Dify PostgreSQL rows and plugin storage remain untouched.
- Retiring active Dify reading archive ownership is a schema/semantics change only. Existing `summary.md` files and historical Dify workflow rows remain valid evidence; no book workspace, Dify row, conversation log, or summary file is migrated or backfilled.
- The delete-cancellation change is runtime-only. It does not migrate or backfill existing book workspaces, import reports, pending-delete markers, Dify rows, or conversation logs.
- The world-model creative constraint engine decision is schema/semantics only. Existing sparse or legacy `world_model.md`, `status_card.md`, and `domain_rules.md` files remain valid until a future explicit author action, repair command, or migration slice upgrades their contents.
- The constraint-lifecycle decision is schema/semantics only. Existing books are not backfilled immediately; constraints that lack lifecycle tags remain legacy mixed constraints until a future world-model initialization, revision, repair, or migration slice reclassifies them from source evidence into current-active, historical-only, retired, overridden, disabled, conditional, inherited-residue, or unresolved scopes.
- The outline control-layer decision is schema/semantics only. Existing empty or sparse `brainstorm.md`, `master_outline.md`, `arc_outline.md`, and `chapter_outline.md` files remain valid until an explicit author action, initialization, rebuild, or migration slice upgrades their contents.
- The continuation production-layer decision is schema/semantics only. Existing books where `chapter_draft.md` is absent remain valid because the file is virtual/defaulted until a continuation request materializes it on `draft/sandbox`.
- The rolling production-loop decision is schema/semantics only. Existing books need no migration: their rolling cursor can be derived from the current `chapter_outline.md` and `chapter_draft.md`, and books without enough pending cards simply enter the outline-replenishment path.
- The accepted chapter canonization decision is schema/semantics only. Existing imported books and existing draft files are not automatically mutated. Books with accepted continuation prose stranded in `chapter_draft.md` require a future explicit repair or a valid confirm/canonization flow before those chapters become formal `chapters/*.md`.
- The post-canonization draft reset decision applies only to future successful confirmations. Existing workspaces are not scanned or rewritten; any already oversized `chapter_draft.md` remains untouched until the author runs an explicit repair or a valid confirm/canonization flow.
- The review bridge and human unlock decision is schema/semantics only. Existing rolling evidence without review packets remains valid historical evidence, but cannot release a current quality-gate block without a fresh explicit human unlock artifact. No book workspace, Dify row, or conversation log is migrated or backfilled.
- The style metric-delta repair-loop decision is schema/semantics only. Existing rolling evidence without `style_metric_delta` remains valid historical evidence, but future repair loops should generate a fresh delta from available before/after diagnostics before claiming metric-driven repair. No book workspace, Dify row, or conversation log is migrated or backfilled.
- The chapter context pack decision is schema/semantics only. Existing rolling evidence without `chapter_context_pack` remains valid historical evidence, but future continuation repair loops should generate a fresh pack from current outline/world/status/style/error/gate sources before claiming current-chapter truth conditioning. No book workspace, Dify row, or conversation log is migrated or backfilled.
- The `chapter_draft.md` AI write-loop budget is runtime-only and derived from recent Git history. It does not migrate, rewrite, or backfill existing book workspaces, Dify rows, conversation logs, or historical rolling artifacts.
- The style advisory rolling-gate decision is schema/semantics only. Existing rolling evidence that treated style failures as hard quality-gate blocks remains valid historical evidence, but future planner runs should record style diagnostics as `style_advisory` unless a separate non-style hard gate is explicitly supplied. No book workspace, Dify row, conversation log, or historical rolling artifact is migrated or backfilled.

## Future Migration Rules

- Adding a tracked book layout file requires:
  - an ER amendment;
  - layout repair behavior;
  - compatibility behavior for older book workspaces;
  - Git tracking expectations.
- Changing `metadata.json` fields requires:
  - tolerant readers for missing historical fields;
  - explicit backfill decision.
- Changing conversation index or JSONL format requires:
  - backward-compatible read path or a migration script;
  - clear treatment of archived/deleted conversations.
- Changing Dify app, provider, or plugin runtime expectations requires:
  - live DB backup;
  - plugin storage verification;
  - local DSL/export policy statement.
- Changing world/status/domain creative constraint roles requires:
  - architecture and ER amendment;
  - a compatibility decision for existing book workspaces;
  - proof from live Dify DB if prompt semantics are changed.
- Changing world-model constraint lifecycle semantics or applicability scopes requires:
  - architecture and ER amendment;
  - compatibility behavior for legacy unscoped constraints;
  - same-case evidence proving old states are not treated as current-active facts by default;
  - proof from live Dify DB if Dify world, outline, continuation, or review prompt semantics are changed.
- Changing outline-layer source roles or write ownership requires:
  - architecture and ER amendment;
  - a compatibility decision for existing sparse outline files;
  - proof from live Dify DB if prompt or workflow semantics are changed.
- Changing summary archive ownership, output format, metadata boundary, or rebuild semantics requires:
  - architecture and ER amendment;
  - compatibility behavior for existing `summary.md` files generated by older Dify reading archive runs;
  - proof that the new path derives from `chapters/*.md` and leaves the per-book Git repository clean after summary completion;
  - proof that Dify `reading_archive_agent` is not called when the backend pipeline is the declared owner;
  - proof that structured batch validation prevents missing chapter coverage, missing required sections, and conversational assistant preambles from entering new `summary.md` output.
- Changing continuation production ownership, chapter-card execution semantics, or length-gate requirements requires:
  - architecture and ER amendment;
  - a compatibility decision for books without `chapter_draft.md`;
  - live Dify ToolProvider backup and workflow graph proof if runtime behavior is changed.
- Changing accepted chapter canonization semantics requires:
  - architecture and ER amendment;
  - compatibility behavior for existing `chapter_draft.md` files and existing `chapters/*.md` archives;
  - proof that confirmed draft text is preserved rather than generated or rewritten;
  - conflict tests proving existing chapter files are not silently overwritten;
  - rolling-state evidence proving accepted progress comes from formal chapter files after canonization.
- Changing continuation style advisory or metric-delta repair semantics requires:
  - architecture and ER amendment;
  - proof that the delta is derived evidence and does not become source prose;
  - same-case regression evidence from at least one before/after style diagnostics pair;
  - live Dify workflow proof if continuation prompt semantics are changed.
- Changing chapter context pack derived-evidence semantics requires:
  - architecture and ER amendment;
  - proof that the pack is derived evidence and contains no generated prose;
  - source-reference evidence to outline, world/status/domain, summary, style, error, or gate artifacts;
  - same-case regression evidence from at least one blocked rolling chapter;
  - live Dify workflow proof if continuation prompt semantics are changed.
- Changing rolling production cursor, replenishment, style advisory, or human-review stop-gate semantics requires:
  - architecture and ER amendment;
  - compatibility for existing sparse `chapter_outline.md` and absent `chapter_draft.md`;
  - proof that orchestration code does not directly author prose;
  - runtime evidence from at least one live rolling case before README/demo claims are updated.
- Changing review bridge, review hard scope, or human unlock semantics requires:
  - architecture and ER amendment;
  - compatibility for older rolling artifacts that lack review packets;
  - proof that review Agent writes remain limited to `error_archive.md`;
  - proof that review recommendations do not silently unlock blocked structural actions.
- Adding cost budget enforcement requires:
  - a declared accounting formula;
  - a decision on whether historical observations are backfilled;
  - tests or manual probes proving no duplicate iteration aggregates are counted.
