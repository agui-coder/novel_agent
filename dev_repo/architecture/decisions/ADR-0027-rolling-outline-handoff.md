# ADR-0027: Rolling Outline Handoff

Date: 2026-05-20

## Status

Accepted for implementation under `ROLL-OUTLINE-HANDOFF`.

## Context

The rolling workbench selects the next batch from executable cards in
`chapter_outline.md`. When the next pending card is malformed, for example a
chapter card misses `conflict_or_obstacle`, the planner returns
`repair_outline_cards` and the continuation button must stay locked. When the
card deck is exhausted, the planner returns `replenish_outline`.

Both states need an author-facing route back into the outline layer. A disabled
continuation button is correct as a gate, but it is not enough as a workflow.
The workbench should expose explicit outline handoff actions so the outline
Agent can repair the card deck before the continuation Agent writes prose.

## Decision

Rolling outline intervention is a promptless workbench handoff to the outline
Agent.

- `repair_outline_cards` means the next pending card exists but is not
  executable. The workbench must offer "修复章节卡" and pass the blocked card,
  missing fields, neighboring cards, and current rolling state to the outline
  route.
- `replenish_outline` means the executable card deck is depleted or insufficient
  for the next requested batch. The workbench must offer "生成下一批章节卡" and
  pass the cursor, recent accepted progress, and current outline context to the
  outline route.
- The backend rolling API may build structured outline handoff payloads, but it
  must not edit `chapter_outline.md` directly.
- The outline Agent may update the outline quartet through the existing
  draft/sandbox review tools. For these handoffs, its concrete target is
  `chapter_outline.md`.
- After the outline Agent finishes, the frontend refreshes `/api/rolling/state`.
  Only `continue_existing_cards` with selected card numbers may enable the
  continuation button.

## Boundaries

The rolling outline handoff must not:

- let Codex or local orchestration code write novel prose;
- let the backend silently rewrite `chapter_outline.md`;
- let the continuation Agent repair chapter cards or invent new card numbers;
- replace a malformed card with a new card when repair of the original card is
  possible;
- treat outline proposals as current world canon when they require
  `world_model.md` or `status_card.md` acceptance;
- hide repair or replenishment progress inside chat bubbles.

## Compatibility

Existing books do not require migration. Malformed cards remain visible as
diagnostics until the author launches the outline repair action. Depleted decks
continue to report `replenish_outline`, but now have an explicit frontend action
instead of a dead end.

## Verification

Implementation must prove:

- `repair_outline_cards` exposes an outline repair payload without mutating
  files;
- `replenish_outline` exposes an outline replenishment payload without mutating
  files;
- the frontend shows the correct action for each planner state;
- the continuation button remains locked until refreshed state is
  `continue_existing_cards`;
- `chapter_draft.md` remains owned only by the continuation route.
