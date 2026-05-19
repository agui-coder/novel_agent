# ADR-0009: Style Metric Delta Repair Loop

Date: 2026-05-15

## Status

Accepted.

## Context

The rolling 30-chapter stress run exposed a repeatable continuation failure mode.
Chapter 10 could be moved by ordinary prompt repair, but the repair direction was
not stable:

- broad bridge-density repair reduced hard style failures from four metrics to
  two;
- length recovery then restored the minimum length gate;
- the same recovery regressed paragraph rhythm, making `avg_para` worse while
  `environment_density` remained a hard failure.

This is not a Chapter 10-only problem. It is a general gap between deterministic
style gates and the continuation Agent's prose repair behavior. The Agent can
read natural-language repair advice, but it does not yet receive a structured
delta contract that says which metrics must improve, which metrics must not
regress, which proxy actions satisfy each metric, and when the loop must stop
instead of blindly expanding.

## Decision

Continuation style repair uses a style metric delta loop.

The deterministic evaluator layer produces a `style_metric_delta` or equivalent
repair artifact from before/after style diagnostics. That artifact is derived
evidence, not prose. It records:

- failed, warning, resolved, persistent, and newly added metrics;
- per-metric before/after values and severity movement;
- the required repair direction from the active repair plan;
- proxy targets for the continuation Agent, such as paragraph-count increase,
  environment cue-cluster reduction, dialogue paragraph-ratio reduction, or
  explanation-trigger reduction;
- guardrails for metrics that may not regress while another metric is repaired;
- stop conditions when the failure score worsens, hard failures are added, or a
  length recovery passes while a required style metric regresses.

The continuation Agent remains the only route that may write `chapter_draft.md`.
It consumes the delta as repair guidance and must still write through the
existing LoreGit draft tools. The rolling orchestrator records the delta,
compares gate movement, and decides whether the next action remains locked. It
does not write or rewrite novel prose.

This loop follows the evaluator-optimizer pattern:

1. evaluator: deterministic length/style gates measure the current draft;
2. optimizer: continuation Agent rewrites only the current chapter under the
   metric delta;
3. evaluator: gates are rerun and the delta is compared;
4. stop or continue: a pass unlocks the next chapter, while regression or
   persistent hard failure produces the next narrow delta instead of blind
   expansion.

## Unchanged Boundaries

- Codex and the rolling orchestrator still do not generate, rewrite, paste, or
  directly edit novel prose.
- `chapter_draft.md` is still owned by the continuation route only.
- Style gates remain deterministic quality gates; specialized profiles are not
  bypasses.
- Review Agent recommendations remain advisory and cannot unlock a blocked
  structural action.
- No new database table, schema migration, historical book backfill, or Dify
  workflow topology change is implied by this architecture decision.

## Compatibility

Existing rolling artifacts without metric-delta fields remain historical
evidence. They can still be read and summarized, but they do not provide the
structured repair contract required for the new loop.

Existing books do not require migration. Their current `chapter_outline.md` and
`chapter_draft.md` continue to be the source files from which the rolling cursor
and quality gates are derived.

Existing Dify workflow definitions remain compatible until a later runtime patch
teaches the live continuation workflow to consume the new protocol markers.

## Verification

The metric delta loop is accepted only when:

- architecture and ER truth record the new derived evidence semantics;
- local repair-delta generation compares before/after style diagnostics without
  hardcoding a chapter number;
- continuation prompt patch tests prove the live prompt contains the metric
  delta protocol markers;
- live Dify patch evidence proves the workflow changed only where expected;
- a real continuation Agent repair writes only `chapter_draft.md`;
- length and style gates decide whether Chapter 11 remains locked or can resume.
