# ADR-0027: Rolling Outline Replenishment Handoff

Date: 2026-05-20

## Status

Accepted, amended on 2026-05-21 to remove the chapter-card repair scheduler branch.

## Context

The rolling workbench selects the next batch from `chapter_outline.md` and asks
the continuation Agent to write selected chapters into `chapter_draft.md`.
Earlier versions treated missing structured chapter-card fields as a hard
planner problem and exposed a repair action. In practice this was too brittle
for recurrence, reset, or rapidly changing web-novel outlines: authors often
have enough usable chapter direction without a complete field template.

## Decision

Rolling outline intervention is now only a promptless replenishment handoff.

- A pending chapter entry is selectable when the planner can read a chapter
  number and usable outline text.
- Missing structured fields remain diagnostics and are carried into the
  continuation context pack, but they do not produce a repair scheduler action.
- `replenish_outline` means the card deck is depleted or insufficient for the
  requested batch. The workbench offers "生成下一批章节卡" and passes the cursor,
  recent accepted progress, and current outline context to the outline route.
- The backend rolling API may build a structured replenishment payload, but it
  must not edit `chapter_outline.md` directly.
- After the outline Agent finishes, the frontend refreshes `/api/rolling/state`.
  Only `continue_existing_cards` with selected card numbers may enable the
  continuation button.

## Boundaries

The rolling outline handoff must not:

- let Codex or local orchestration code write novel prose;
- let the backend silently rewrite `chapter_outline.md`;
- let the continuation Agent invent new chapter-card numbers outside the
  selected rolling batch;
- treat outline proposals as current world canon when they require
  `world_model.md` or `status_card.md` acceptance;
- hide replenishment progress inside chat bubbles.

## Compatibility

Existing books do not require migration. Loosely formatted cards that were
previously blocked now continue through the continuation route if they expose a
chapter number and readable outline text. Depleted decks continue to report
`replenish_outline` and use the explicit frontend action.

## Verification

Implementation must prove:

- missing structured fields do not block rolling continuation;
- missing-field diagnostics are still exposed to the frontend and continuation
  context;
- `replenish_outline` exposes an outline replenishment payload without mutating
  files;
- the frontend no longer exposes a chapter-card repair action;
- `chapter_draft.md` remains owned only by the continuation route.
