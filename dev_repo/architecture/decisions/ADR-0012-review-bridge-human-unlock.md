# ADR-0012: Rolling Review Bridge And Human Unlock

Date: 2026-05-14

## Status

Accepted for implementation under `R30-REVIEW-BRIDGE-HUMAN-UNLOCK`.

## Context

The rolling production loop can now derive the chapter cursor, call the continuation and outline workflows, validate
length and style, and lock outline replenishment when a quality gate fails. Chapter 8 proved the missing boundary:
after the current card deck was consumed, the planner could correctly block `replenish_outline`, but the system had no
formal bridge from deterministic gate evidence to the review Agent and then to an explicit human decision.

Without that bridge, the scheduler has only two unsafe choices: keep asking the continuation Agent for blind repairs,
or let an operator manually remember why a blocked structural action is acceptable. Neither is good enough for a
repeatable human-in-the-loop demo.

## Decision

Add a review bridge and human unlock layer to the rolling production loop.

The boundary is:

1. deterministic gates measure length, style, repair deltas, and the structural action being blocked;
2. the rolling orchestrator packages that evidence into a review packet;
3. the review Agent may read the draft and context and may write only reusable findings to `error_archive.md`;
4. the review Agent returns an author-facing recommendation, not an unlock;
5. only an explicit human decision may unlock a blocked structural action such as outline replenishment;
6. the rolling planner records the review packet, review recommendation, human decision, and unlock target as derived
   evidence.

The review bridge must not change prose ownership. `chapter_draft.md` remains owned by the continuation Agent, and the
rolling orchestrator remains a coordinator and evidence packager.

## Boundaries

The rolling orchestrator may:

- build a review packet from existing planner, style, length, repair-delta, Dify run, and Git evidence;
- route the packet to the existing `review_agent` route;
- record review recommendations and human unlock artifacts under `.runtime/`;
- expose whether a blocked action is still blocked, review-recommended, or explicitly human-unlocked.

The rolling orchestrator must not:

- write or rewrite novel prose;
- treat a review Agent recommendation as human approval;
- allow outline replenishment while the latest failed chapter lacks a passing quality gate or explicit human unlock;
- change review Agent file permissions in this decision.

The review Agent may:

- read `chapter_draft.md`, outline, summary, world/status/domain, style, and error files according to the existing
  route registry;
- write only `error_archive.md` when it finds reusable review errors.

The review Agent must not:

- write `chapter_draft.md`;
- silently approve outline replenishment;
- replace deterministic gate evidence with prose-only judgment.

## Data Semantics

`RollingProductionRun` remains a derived evidence entity. Review packets, review recommendations, and human unlock
artifacts are derived runtime evidence, not a new durable database table and not hidden source truth.

A human unlock artifact must bind the decision to enough evidence to prevent stale approvals from applying to the wrong
chapter or book. At minimum it should identify the book, chapter, blocked action, gate source, and review packet or
equivalent evidence source.

## Compatibility

Existing books, drafts, Dify rows, and rolling artifacts require no migration or backfill. Older rolling artifacts
without review packets are still valid historical evidence; they simply cannot unlock a currently blocked structural
action without a new explicit decision artifact.

## Verification

Implementation slices must prove:

- a same-case Chapter 8 review packet can be generated from current artifacts;
- the review bridge uses the existing `review_agent` route and does not expand its write scope;
- the book repository shows no direct prose changes from the rolling bridge;
- without explicit human unlock, the planner keeps `next_action=await_quality_gate`;
- with explicit human unlock bound to the same book/chapter/action, the blocked structural action can be surfaced as
  eligible for the next step.

## Consequences

This makes the rolling demo more honest. The system is no longer pretending every quality failure should be solved by
blind repair or profile tuning. When the gate sees risk, it can ask the review Agent for editorial interpretation and
then require the author to decide whether the demo should repair, adjust profile, replan outline, block, or override.
