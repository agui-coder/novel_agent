# ADR-0026: Post-Confirm Archive Bridge

Date: 2026-05-20

## Status

Accepted for implementation under `STATUS-ARCHIVE-BRIDGE-1`.

## Context

ADR-0020 and ADR-0022 established that accepted `chapter_draft.md` prose can be
canonized into `chapters/*.md` and then handed off to the world/status route.
That still leaves an important freshness gap: after new chapters are archived,
`summary.md` may still describe the previous chapter range, and a status-card
handoff that reads the old archive cannot reliably project the current running
state.

The author-facing rolling workflow needs a stronger backend bridge:

1. continuation Agent writes only `chapter_draft.md`;
2. the author confirms the draft;
3. backend canonizes accepted text into formal `chapters/*.md`;
4. backend refreshes `summary.md` from the complete chapter set;
5. backend refreshes `status_card.md` from the latest summary batch;
6. optional world-route discussion may update `world_model.md` or
   `domain_rules.md` only when durable constraints changed.

## Decision

Post-confirm archive refresh is a backend bridge between chapter canonization,
summary archive generation, and status projection.

- `/api/draft/confirm` may trigger or return a structured follow-up action for a
  fixed archive bridge after successful chapter canonization.
- The bridge must rebuild `summary.md` through the backend summary archive
  pipeline, not through Dify `reading_archive_agent`.
- The bridge must refresh `status_card.md` through the backend status projection
  helper, using the freshly written `summary.md`.
- `status_card.md` refresh is a deterministic projection and a regular
  accepted-batch target; it is not a review Agent responsibility.
- `world_model.md` and `domain_rules.md` remain optional world-route targets for
  durable constraint changes. They must not be rewritten merely because a new
  chapter batch was accepted.

## Boundaries

The bridge must not:

- generate, rewrite, summarize, polish, or expand novel prose;
- let the review Agent materialize chapters or update world/status files;
- let Dify `reading_archive_agent` own post-confirm `summary.md`;
- refresh `status_card.md` from a stale summary;
- physically delete consumed outline cards from `chapter_outline.md`;
- hide bridge progress inside chat messages.

The bridge may commit multiple derived outputs as separate per-book commits when
that keeps evidence clearer: chapter canonization, draft reset, summary archive,
and status projection may each be independently visible in nested Git history.

## Compatibility

Existing books do not require migration. Existing `summary.md` and
`status_card.md` files remain valid until the author confirms new continuation
chapters or explicitly launches a rebuild action.

If the archive bridge fails after chapter canonization, the accepted chapters
remain canon. The bridge must report the failed derived step and leave a retry
surface rather than rolling back accepted prose.

## Verification

Implementation must prove:

- confirming a chapter draft materializes `chapters/*.md` before any derived
  refresh;
- post-confirm summary archive covers the new chapter range;
- status projection uses the refreshed summary and cites the latest batch;
- no Dify reading archive route is called for the bridge;
- per-book Git status is clean after each successful bridge step.
