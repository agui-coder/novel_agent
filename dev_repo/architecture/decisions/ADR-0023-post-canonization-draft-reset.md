# ADR-0023: Post-Canonization Draft Reset

Date: 2026-05-19

## Status

Accepted for implementation under `ROLL-WHITEBOX-DRAFT-RESET`.

## Context

ADR-0020 made human-confirmed continuation prose become formal chapter canon by
materializing accepted `chapter_draft.md` sections into `chapters/*.md`.
After that step, the same accepted prose could remain in `chapter_draft.md`.
That made the rolling workbench harder to reason about: authors saw an ever
growing draft file, and the next continuation batch had to share a review
surface with already archived chapters.

The project needs `chapter_draft.md` to remain a short-lived review surface, not
a second long-term chapter archive.

## Decision

After `/api/draft/confirm` successfully canonizes `chapter_draft.md` into
`chapters/*.md`, the backend resets `chapter_draft.md` to the standard
lightweight draft placeholder.

This reset:

- happens only after accepted prose has been preserved in `chapters/*.md`;
- is committed in the book Git history and returned as
  `chapter_draft_reset_commit_id`;
- does not generate, rewrite, summarize, polish, or otherwise author prose;
- does not run on parse failure, chapter archive conflict, missing draft branch,
  or non-`chapter_draft.md` confirmations;
- does not physically consume or edit `chapter_outline.md`.

## Boundaries

`chapters/*.md` is the durable accepted chapter archive. `chapter_draft.md` is a
review/workspace file for the next continuation batch.

Failed or ambiguous canonization must preserve the draft branch so the author
can inspect and repair the pending text. Cleanup is a post-success step only.

## Compatibility

No migration or backfill is required. Existing books are not scanned or
rewritten. Any older workspace where accepted prose remains stranded in
`chapter_draft.md` requires an explicit repair or a future valid confirmation
flow.

## Verification

Implementation must prove:

- confirmed continuation chapters still land in `chapters/*.md`;
- the accepted prose is removed from mainline `chapter_draft.md` after
  successful canonization;
- the per-book Git worktree is clean after confirmation;
- non-chapter confirmations do not create a reset commit;
- conflicts or parse failures do not clear the draft review surface.
