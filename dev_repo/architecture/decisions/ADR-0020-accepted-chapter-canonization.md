# ADR-0020: Accepted Chapter Canonization

Date: 2026-05-19

## Status

Accepted for implementation under `ROLLING-CANON`.

## Context

The rolling continuation loop can ask the continuation Agent to write one to
three chapters into `chapter_draft.md`, and the review workspace can confirm the
draft branch. A real demo run exposed a gap after confirmation: accepted prose
stayed in `chapter_draft.md` and did not become formal `chapters/*.md`, so the
book library, rolling cursor, status card, and world model could not reliably
see the accepted chapters as canon.

This is not a prose-generation task. The continuation Agent has already written
the prose. The missing responsibility is deterministic storage canonization
after human confirmation.

## Decision

When `/api/draft/confirm` accepts a draft that includes `chapter_draft.md`, the
backend may split the accepted draft into chapter sections and materialize those
sections as formal chapter files under `chapters/*.md`.

Canonization:

- preserves accepted text without generating or rewriting prose;
- derives chapter number and title from accepted chapter headings;
- writes safe, numbered chapter filenames that match the existing archive style;
- fails explicitly when headings are ambiguous or an existing chapter file would
  be overwritten with different content;
- records the materialized files in the confirm response and book Git history;
- lets rolling state treat formal `chapters/*.md` as the accepted progress
  source.

`chapter_draft.md` remains the continuation Agent's review surface and may still
show pending-review draft chapters before confirmation. `chapter_outline.md`
remains the source chapter-card deck and is never physically consumed by
canonization.

## Post-Confirm Distillation

After chapter canonization, state maintenance belongs to the world-model route.

- `status_card.md` should be refreshed after every accepted chapter batch.
- `world_model.md` should update only when accepted chapters introduce durable
  world rules, identities, timeline/loop state, cosmology, contradiction
  repairs, or other long-lived constraints.
- `domain_rules.md` may be updated only when reusable review/continuation rules
  change.

The review Agent may inspect the accepted batch and record reusable conflict
findings in `error_archive.md`, but review recommendations are not approval and
do not materialize chapter canon or update world/status files.

## Boundaries

The backend canonization step must not:

- generate, summarize, expand, polish, or otherwise author novel prose;
- clear or rewrite `chapter_outline.md`;
- treat unconfirmed `chapter_draft.md` headings as accepted canon;
- silently overwrite an existing `chapters/*.md` file with different content;
- route post-confirm world/status maintenance through the review Agent.

The world-model route must not:

- rewrite chapter prose;
- treat every accepted chapter event as a durable `world_model.md` change;
- bypass draft/review semantics when proposing status/world updates.

## Data Semantics

`ChapterFile` includes imported chapters and accepted continuation chapters. The
accepted continuation path is: continuation Agent writes `chapter_draft.md` on
`draft/sandbox`; the human confirms the draft; backend canonization archives the
accepted chapter sections into `chapters/*.md`.

`chapter_draft.md` remains a `KnowledgeFile` and review surface. It is not the
formal long-term chapter archive after confirmation.

Rolling progress is derived from:

- accepted chapter files under `chapters/*.md`;
- pending-review headings in `chapter_draft.md`;
- executable cards in `chapter_outline.md`;
- review and Git state.

## Compatibility

No migration or backfill is required. Existing imported books remain valid.
Books with already confirmed continuation prose stranded in `chapter_draft.md`
may be repaired by a future explicit canonization action or by re-confirming a
valid draft branch; this ADR does not automatically mutate real book workspaces.

## Verification

Implementation must prove:

- confirming a draft containing chapters such as 153-155 creates matching
  `chapters/*.md` files;
- conflicting existing chapter files fail safely;
- non-`chapter_draft.md` confirm behavior remains unchanged;
- rolling state advances from formal chapter files after canonization;
- post-confirm state/world maintenance is routed to the world-model route, not
  the review route.
