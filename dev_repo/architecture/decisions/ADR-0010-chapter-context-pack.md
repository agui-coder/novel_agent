# ADR-0010: Chapter Context Pack Repair Loop

Date: 2026-05-15

## Status

Accepted.

## Context

The rolling 30-chapter stress test proved that the continuation chain can route, write, validate, and block correctly,
but Chapter 10 repeatedly failed after metric-driven repairs. The latest real run, `R30-MDELTA-3`, preserved the length
gate at `2206` non-whitespace chars but still failed style on `avg_para` and `environment_density`.

Community and research patterns point to the same root cause: long-form fiction systems drift when the model writes
from recent prose inertia instead of from a current scene brief grounded in story bible, lore, outline, character state,
and non-negotiable facts.

## Decision

Add a derived `Chapter Context Pack` evidence layer between the rolling planner and the continuation Agent.

The new flow is:

1. deterministic rolling planner derives the target chapter and current gate state;
2. rolling planner builds `CHAPTER_CONTEXT_PACK_PROTOCOL` from existing source artifacts;
3. continuation Agent consumes the pack as the current-chapter execution brief;
4. continuation Agent remains the only writer for `chapter_draft.md`;
5. length/style gates rerun and either unlock the next chapter or emit another narrow blocker.

The context pack may contain:

- target chapter number and executable chapter-card fields;
- decision chain: who wants what, what blocks them, what state must change;
- non-negotiable facts and forbidden promotions of unresolved `WORLD_MODEL_REQUIRED`;
- source references to outline, world/status/domain, summary, style constraints, error archive, and gate artifacts;
- current metric-delta repair goals, protected metrics, and stop conditions;
- no-prose boundary markers.

The context pack must not contain generated chapter prose. It is not a hidden outline, hidden canon, hidden approval, or
replacement for `chapter_draft.md`.

## Consequences

- `RollingProductionRun` may record `chapter_context_pack` as derived evidence.
- Continuation prompt semantics may consume `CHAPTER_CONTEXT_PACK_PROTOCOL`.
- `chapter_draft.md` ownership does not change.
- Review Agent and human unlock semantics do not change.
- Existing rolling evidence without context packs remains valid historical evidence.

## Verification

- Architecture and ER truth record the derived-evidence semantics.
- Local planner tests prove context packs are generic and contain no prose.
- Live Dify prompt proof must show the continuation Agent consumes the protocol without changing topology, model,
  endpoint, or ToolProvider operation set.
- Same-case Chapter 10 verification must rerun the real continuation route before Chapter 11 is allowed.
