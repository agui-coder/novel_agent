# ADR-0019: Continuation Workbench For Rolling Chapter Production

Date: 2026-05-18

## Status

Accepted for implementation under `CONT-WB`.

## Context

The rolling production layer can derive a chapter cursor from `chapter_outline.md`
and `chapter_draft.md`, and the continuation Agent can write prose into
`chapter_draft.md`. The missing piece is an author-facing control surface that
turns that backend capability into a repeatable demo workflow.

Authors should not have to type hidden command prompts into chat to start a
deterministic three-chapter production batch. They need to see which outline
cards are already consumed, which cards are pending, which next cards will be
selected, and whether the workflow must stop for review or outline
replenishment.

## Decision

Add a continuation workbench as a promptless frontend control surface for rolling
chapter production.

The continuation workbench:

- reads rolling state from a backend API derived from `chapter_outline.md` and
  `chapter_draft.md`;
- displays accepted chapters, pending-review draft chapters, pending outline
  cards, selected next batch, and the next action;
- defaults the production batch size to three cards but must tolerate smaller
  pending batches;
- launches a fixed direct action rather than a chat message;
- calls the existing continuation route to produce prose;
- sends the result into the existing draft review workspace;
- shows `replenish_outline` when executable cards are depleted or insufficient;
- keeps the source `chapter_outline.md` intact unless the author explicitly
  edits or accepts outline changes.

The workbench is a control plane. It may orchestrate and display progress, but it
must not generate, edit, or rewrite chapter prose.

## Boundaries

The continuation workbench may:

- call a rolling state API exposed by Flask;
- call a rolling run API that delegates to the existing Dify continuation route;
- pass fixed route parameters such as `book_id`, `batch_size`,
  `target_file=chapter_draft.md`, and selected chapter card numbers;
- render progress from structured stream events;
- open or refresh the existing review workspace after a draft write;
- show that outline replenishment is needed.

The continuation workbench must not:

- append hidden natural-language prompts to chat;
- store deterministic pipeline progress as user/assistant chat turns;
- directly write `chapter_draft.md`;
- directly clear, truncate, or mutate `chapter_outline.md`;
- bypass `draft/sandbox`, review, confirm, rollback, length validation, or human
  review gates;
- treat style advisory evidence as a hard scheduler lock by itself;
- continue to the next accepted batch while the current batch has unresolved
  review or Git blockers.

## Data Semantics

`ContinuationWorkbenchState` is a transient projection, not a new source entity
or database table.

It is derived from:

- formal chapter files under `chapters/*.md`;
- executable cards in `chapter_outline.md`;
- written chapter headings in `chapter_draft.md`;
- current `draft/sandbox` and review state;
- rolling planner output;
- optional `RollingProductionRun` evidence.

Consumed outline cards are not physically deleted. The UI may present formal
chapter files as accepted consumption and draft headings as pending review, but
source truth remains the outline file, formal chapter archive, and draft prose.

## Compatibility

Existing books remain valid. Books with no accepted continuation chapters under
`chapters/*.md` begin with an empty accepted cursor. Books whose outline deck is depleted enter
`replenish_outline` without local code inventing chapter cards.

No migration or historical backfill is required.

## Verification

The implementation must prove:

- the state API returns accepted, pending-review, pending outline, selected, and
  next action fields from a real book workspace;
- the frontend exposes a continuation workbench action without using chat input;
- the action calls the project continuation Agent instead of local prose code;
- successful production changes only `chapter_draft.md` on `draft/sandbox`;
- the review workspace is reachable after the action;
- depleted cards surface `replenish_outline` instead of clearing
  `chapter_outline.md`.
