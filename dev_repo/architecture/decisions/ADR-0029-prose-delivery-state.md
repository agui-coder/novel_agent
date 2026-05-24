# ADR-0029: Prose Delivery State

Date: 2026-05-24

## Status

Accepted.

## Context

The rolling continuation loop can ask the continuation Agent to write one batch
of prose into `chapter_draft.md`. In normal demo use that draft package often
contains multiple chapter sections. The historical review workspace treated the
result as a generic file diff, so several different decisions were collapsed
into one surface:

- whether the review Agent has inspected the prose;
- which chapter section or finding has a blocking problem;
- whether the author has manually edited and saved the draft;
- whether a specific finding has been handed back to the continuation Agent for
  rewrite;
- whether the author is ready to archive the accepted sections into
  `chapters/*.md`;
- whether post-confirm summary/status handoff is still pending.

`error_archive.md` is useful as long-lived reusable review evidence, but it is
not a current transaction state. A generic diff view also cannot safely represent
three chapter sections inside one `chapter_draft.md` package.

## Decision

Add a dedicated derived control-plane entity named `ProseDeliveryState`.

The source artifact is ignored per-book runtime metadata:

```text
novel_git_server/storage/<book_id>/.loregit/prose_delivery_state.json
```

Its identity is:

```text
BookWorkspace + draft_branch + base_branch + base_commit + draft_commit
```

The state is owned by `book-storage-git`, exposed through future
`/api/prose_delivery/*` backend routes, and consumed by a dedicated frontend
"正文交付台". It is not book prose, not an outline, not a hidden review approval,
and not a replacement for Git history.

## State Shape

The persisted JSON should be tolerant of older or partial versions, but the
active shape must include these concepts:

- `schema_version`, `book_id`, `draft_branch`, `base_branch`, `base_commit`,
  `draft_commit`.
- `source_agent` or `created_by`, plus timestamps.
- `status` or phase such as `draft_ready`, `review_running`, `review_ready`,
  `rewrite_requested`, `manual_editing`, `archive_running`, `archived`,
  `handoff_pending`, or `blocked`.
- `draft_package`: `target_file=chapter_draft.md` and parsed chapter spans with
  chapter number, title, heading line, end line, review status, and author
  status.
- `review_report`: structured review findings keyed by chapter number and
  finding id. This report is current-state evidence, while `error_archive.md`
  remains long-term reusable evidence.
- `rewrite_requests`: finding id, chapter number, rewrite scope, prior draft
  commit, target file, and instruction that chapter numbers and accepted context
  must be preserved.
- `manual_edit`: dirty/saved metadata, edit base commit, saved draft commit,
  and whether review must be rerun.
- `archive_state`: archive eligibility, running/success/failure state,
  archived chapter files, and post-confirm bridge status.
- `handoff_state`: summary/status/world-model follow-up status after archive.

## Required Behavior

- The state is created or refreshed when `chapter_draft.md` materializes or its
  draft commit changes.
- Chapter parsing is advisory for UI structure, but the package is still one
  draft file. A batch with three chapters is one draft package with three spans,
  not three independent review branches.
- A structured review report updates `review_report` and per-chapter/finding
  statuses. Review pass is not author approval.
- A human inline save updates `chapter_draft.md` through the backend, creates a
  new draft commit, updates `manual_edit`, and marks older review reports stale.
- A rewrite request is attached to one review finding. The continuation Agent
  receives the prior draft and review finding; it remains the only AI writer of
  `chapter_draft.md`.
- Archive is allowed only when there is no unsaved manual edit and the author
  explicitly accepts the draft package.
- Confirm/archive success clears or archives the active delivery state after
  `chapter_draft.md` sections are canonized and post-confirm handoff is either
  complete or reported as retryable.
- Rollback clears the active delivery state.
- If `base_branch`, `base_commit`, or `draft_commit` no longer matches the
  current draft metadata, the state must be treated as stale and must fail closed
  instead of driving archive or rewrite actions.

## Non-Goals

- This decision does not let Codex, backend orchestration code, or the review
  Agent write novel prose.
- This decision does not make `error_archive.md` the live review-state source.
- This decision does not replace `DraftSandbox`; it sits above branch-scoped
  draft metadata and below the author-facing prose delivery UI.
- This decision does not require multiple simultaneous draft branches.

## Consequences

The frontend can separate the production flow into two clear surfaces:

1. continuation workbench: select cards and ask the continuation Agent to write
   `chapter_draft.md`;
2. prose delivery workbench: review, manually edit, request targeted rewrite,
   archive, and watch post-confirm handoff.

The generic diff review UI remains useful for outline/world/style/file changes,
but `chapter_draft.md` should no longer rely on filename-only heuristics or
chat-panel state to represent prose delivery decisions.

## Verification

- Architecture and ER truth list `ProseDeliveryState` as a derived control-plane
  entity under `.loregit`.
- JSON architecture/data-model artifacts parse successfully.
- Future backend tests must prove stale review reports are invalidated when
  `draft_commit` changes.
- Future frontend tests must prove `chapter_draft.md` opens in the dedicated
  prose delivery workbench and supports inline manual save before archive.
