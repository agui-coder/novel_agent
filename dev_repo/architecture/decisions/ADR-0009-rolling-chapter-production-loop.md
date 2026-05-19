# ADR-0009: Rolling Chapter Production Loop

Date: 2026-05-14

## Status

Accepted for implementation under `ROLLING-CHAPTER-PRODUCTION-LOOP`.

## Context

The continuation production layer can turn executable `chapter_outline.md` cards into `chapter_draft.md` prose in batches of one to three chapters. The outline layer can generate and land executable chapter cards. Those two capabilities are real, but the system lacks a stable coordinator for serial production:

- which chapter cards are already consumed;
- which cards form the next production batch;
- when a depleted `chapter_outline.md` should trigger outline replenishment;
- when human review blocks further continuation;
- which evidence proves each rolling cycle.

Without that coordinator, a 30-chapter demo becomes manual operator memory rather than an agent workflow.

## Decision

Add a rolling production orchestration layer. The layer is a coordinator, not a prose generator.

The rolling loop is:

1. derive the current chapter cursor from `chapter_outline.md` and `chapter_draft.md`;
2. select the next batch, normally up to three unwritten chapter cards;
3. if chapter cards are depleted or insufficient for the next batch, request outline replenishment before more prose production;
4. let the continuation Agent write only the selected batch into `chapter_draft.md`;
5. collect length, style, workflow-run, and Git evidence;
6. if deterministic length/style evidence fails, expose `await_quality_gate` and record the structural action it blocks rather than presenting that blocked action as executable;
7. when a repair is attempted, compare before/after style diagnostics so added hard failures or a wider failure surface are visible before another repair or outline replenishment is allowed;
8. when a deterministic gate remains blocked, package the evidence for the review Agent and require explicit human unlock before releasing the blocked structural action;
9. stop at the human review gate before the next batch is accepted;
10. after acceptance, repeat until the requested demonstration horizon is reached or a red line blocks the loop.

The orchestrator may invoke project agents and local read-only validators, but it must not write novel prose. All prose changes remain owned by the continuation Dify workflow through LoreGit draft write tools.

## Boundaries

The rolling orchestrator may:

- read `chapter_outline.md`, `chapter_draft.md`, outline context files, style artifacts, and validation outputs;
- derive consumed and pending chapter-card state;
- trigger the existing outline and continuation routes through `/api/world/deduce_stream`;
- write runtime evidence under `.runtime/`;
- write case-study documentation for repository presentation.

The rolling orchestrator must not:

- directly create, edit, or rewrite `chapter_draft.md`;
- directly author chapter prose in scripts, docs, fixtures, or prompts used as production content;
- promote unresolved `WORLD_MODEL_REQUIRED` items into canon;
- bypass length, style, review, or human-confirmation gates;
- treat a review Agent recommendation as human approval;
- unlock a blocked structural action without a passing quality gate or explicit human unlock artifact;
- confirm `draft/sandbox` into the mainline without explicit human approval.

## Data Semantics

`RollingProductionRun` is a derived evidence entity. It is not a new database table and does not require migration or backfill.

Its state is derived from:

- `chapter_outline.md` chapter-card headings and fields;
- `chapter_draft.md` written chapter headings;
- Dify workflow run ids and node statuses;
- LoreGit validation outputs;
- per-book Git commits on `draft/sandbox`;
- review packets and review Agent recommendations;
- explicit human unlock artifacts;
- case-study reports under versioned docs.

The chapter-card consumption cursor is derived state, not source data. The source artifacts remain the outline quartet and `chapter_draft.md`.

## Compatibility

Existing books remain valid. Books without formal continuation chapters under `chapters/*.md` have an empty accepted cursor; a materialized `chapter_draft.md` may still show pending-review draft progress. Books with sparse or short chapter outlines may enter the replenishment path immediately.

No historical book workspace, Dify row, or conversation log is migrated in this decision.

## Verification

ROLL-0 verifies the architecture amendment by parsing architecture and data-model JSON artifacts and running `git diff --check`.

ROLL-1 must prove the dry-run cursor on book `7276384138653862966`:

- detects existing written chapters 1-3;
- detects pending outline cards 4-5;
- reports that the next full three-chapter batch will need replenishment.

ROLL-2 through ROLL-4 must prove the real loop with project agents:

- continuation consumes the remaining cards without Codex-authored prose;
- outline replenishes the card deck without writing prose;
- continuation consumes the next replenished batch;
- every batch records length, style, Dify workflow, and Git evidence;
- failures stop with a named blocker instead of silently continuing.

## Consequences

This creates a demonstrable AI-agent workflow suitable for repository presentation: the project can be described as a rolling, human-in-the-loop long-form production system rather than a one-shot chapter generator.

The first implementation should stay conservative: a local dry-run planner and scripted live probe are enough. A frontend button, persistent scheduler UI, or automated 30-chapter marathon requires a later contract after the two-cycle evidence proves the loop.
