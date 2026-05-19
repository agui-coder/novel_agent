# ADR-0006: Outline Layer As Webnovel Serial Control System

Date: 2026-05-12

## Status

Accepted.

## Context

The outline layer currently has four tracked author-facing files:

- `brainstorm.md`
- `master_outline.md`
- `arc_outline.md`
- `chapter_outline.md`

The live outline workflow already separates discussion from archival writes, but its product semantics are still weak: it treats the four files mostly as Markdown targets. For webnovel production, an outline layer must do more than summarize plot. It must preserve reader expectation, payoff cadence, pacing, hooks, foreshadowing debt, and the next executable chapter plan.

World and style layers are now more explicit:

- `world_model.md` and `status_card.md` provide durable story constraints and current narrative state.
- `style_constraints_for_continuation.md` provides rhythm and prose constraints.
- `summary.md` provides factual archive coverage.

The outline Agent should consume those surfaces and produce outline artifacts that continuation and review can use directly.

The live workflow has two agent roles and they map to two author-facing duties:

- `DISCUSS_AGENT` is the ideation engine. It should help the author find interesting directions before commitment: selling points, alternative routes, conflict pressure, retention hooks, payoff motifs, risk zones, and where an idea belongs in the four outline layers. It may judge evidence and red lines, but it should not become only a reviewer; its default discussion posture is to offer usable creative options while labeling their evidence mode.
- `COMMIT_AGENT` is the landing engine. It should convert an approved or explicit author idea into reviewable outline edits: choose the target layer, preserve source facts, quarantine speculative world-rule changes, and produce chapter/arc cards that a continuation agent can execute. It may not write prose chapters and may not promote proposals into canon.

## Decision

The outline layer is a webnovel serial control system with four distinct product roles:

- `brainstorm.md`: selling-point trial pool. It stores premise hypotheses, opening-hook candidates, payoff motifs, risk zones, rejected candidates, and unresolved creative choices.
- `master_outline.md`: reader-promise contract. It stores the long arc, main desire, core loop, terminal direction, non-negotiable character/world constraints, expectation debt, and major payoff plan.
- `arc_outline.md`: retention unit plan. It stores 15-30 chapter arc goals, entry hooks, pressure ladder, payoff sequence, information gaps, foreshadowing, arc-end hook, and hard constraints.
- `chapter_outline.md`: chapter production card deck. Each planned chapter should state objective, scene entry, conflict/obstacle, payoff, state change, foreshadowing action, ending hook, and constraint references.

Outline content must also declare its evidence mode. The same four files can contain all three modes, but they cannot blur them:

- `SOURCE_FACT`: source-backed recap or control archive. These items are grounded in `summary.md`, `world_model.md`, `status_card.md`, style artifacts, existing outline files, or imported chapters.
- `AUTHOR_PROPOSAL`: future-production proposal. These items are allowed to speculate about next retention units, hooks, pacing, and payoff design, but they must be labeled as proposal rather than written as completed canon.
- `WORLD_MODEL_REQUIRED`: proposal that would create or change durable story rules, cosmology, constraints, identity, timeline, resurrection/death status, or other world-state facts. These items must be routed to the world-model layer before downstream agents can treat them as hard constraints.

For completed books or post-finale continuation work, `chapter_outline.md` may be asked to produce next-unit production cards instead of only terminal-arc recap cards. In that mode it should still ground every recap claim as `SOURCE_FACT` and mark all forward-looking cards as `AUTHOR_PROPOSAL` or `WORLD_MODEL_REQUIRED`.

For explicit user requests such as "初始化大纲" or "重建大纲", the live outline workflow should generate reviewable draft updates for all four outline files through the existing gated draft/sandbox Markdown tools. The workflow must read the current book context before writing:

- `summary.md`
- `world_model.md`
- `status_card.md`
- `style_constraints_for_continuation.md`
- the current outline files when present

The outline Agent does not write prose chapters. It provides executable chapter cards for the continuation Agent. The continuation Agent writes `chapter_draft.md` and must not invent or silently replace the outline layer.

`DISCUSS_AGENT` and `COMMIT_AGENT` must stay distinct. Discussion can contain rich ideation, comparisons, and recommended landing paths, but it remains read-only. Commitment can write only after explicit initialization, rebuild, save, archive, or landing intent, and it must compress the chosen idea into the outline quartet instead of continuing open-ended brainstorming.

## Unchanged Boundaries

- `draft/sandbox` remains the review branch for material AI writes.
- The outline Agent may write only the four outline files.
- `summary.md`, `world_model.md`, `status_card.md`, style files, `error_archive.md`, and `chapter_draft.md` remain outside outline Agent write ownership.
- No database schema migration is required.
- Existing sparse outline files remain valid until an explicit initialization, rebuild, or author edit upgrades them.
- The outline Agent may propose new creative material, but may not promote invented terms, hard rules, or contradiction repairs into `SOURCE_FACT` without source evidence.
- Evidence references must name real readable files. Nonexistent files such as `hard_constraints.md` are not valid citations.
- The ideation duty does not weaken source discipline: creative routes that contradict existing facts remain `blocked_by_source` or `WORLD_MODEL_REQUIRED`.
- The landing duty does not weaken author control: without an explicit write/landing intent, `COMMIT_AGENT` must not be invoked and no outline file should change.

## Verification

The upgraded outline runtime is accepted only when these are all true:

- live and draft outline workflow graphs contain `book_id` and the four-layer outline protocol;
- `DISCUSS_AGENT` is clearly discussion/facilitation, not a mislabeled commit agent;
- `COMMIT_AGENT` writes through gated draft/sandbox tools and respects bare target filenames;
- a Chrome frontend real-chain run can turn empty outline templates into non-template drafts for all four outline files;
- generated outline content maps back to `summary.md`, `world_model.md`, `status_card.md`, and style constraints;
- `chapter_outline.md` contains actionable chapter cards suitable for continuation.
- a next-unit planning request labels speculative material as `AUTHOR_PROPOSAL` or `WORLD_MODEL_REQUIRED`;
- a red-line pressure request rejects or quarantines contradictions instead of writing them as hard facts;
- evidence hygiene checks show no citation to nonexistent files.
- a discussion-only ideation request returns multiple usable author options, each with hook/conflict/payoff/risk and a suggested outline layer, without changing book files;
- a landing request converts a chosen idea into specific outline edits with executable arc/chapter cards and evidence-mode labels.
