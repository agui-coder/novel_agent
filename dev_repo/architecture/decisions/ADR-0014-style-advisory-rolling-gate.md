# ADR-0014: Style Advisory Rolling Gate

Date: 2026-05-15

## Status

Accepted for implementation under `R30-STYLE-ADVISORY-GATE / STYLE-ADVISORY-1`.

## Context

The 30-chapter rolling demo repeatedly stalled because deterministic prose-style metrics were treated as scheduler
locks. The Chapter 6 `regression_xiyouji_20260515_153036` case proved the failure mode: the chapter was usable as
webnovel draft material and the remaining concern was author-facing prose taste, but the scheduler still blocked
Chapter 7/8 on `action_density` and `environment_density`.

For the target author workflow, plot control, causal continuity, world/status consistency, branch rollback, and
human review are more important than forcing every chapter through narrow style bands. Style diagnostics remain useful
as hints, but the author owns final prose polish.

## Decision

Downgrade deterministic style diagnostics from a default rolling scheduler lock to `style_advisory` evidence.

The new boundary is:

1. `generate_style_diagnostics` still measures draft style and can produce fail/warn metrics;
2. rolling planner records those metrics with `gate_role=style_advisory`, `advisory=true`, and `locks_scheduler=false`;
3. style advisory evidence is passed into chapter context packs and review packets as reference material;
4. review Agent hard scope narrows to plot continuity, world/status consistency, causal chain, chapter-card fulfillment,
   and unresolved `WORLD_MODEL_REQUIRED` risk;
5. prose style revision authority returns to the human author, with continuation Agent using style files and source text
   as imitation references rather than as a scheduler pass/fail contract.

Length gates, chapter-card executability, world/status conflicts, review gates, Git safety, and explicit human
confirmation remain hard boundaries.

## Compatibility

No book workspace, Dify database row, or historical rolling artifact is migrated or backfilled. Older artifacts that
show style failures as hard blocks remain valid history. Future planner runs using style diagnostics should classify
them as advisory unless a separate non-style hard gate is explicitly supplied.

## Consequences

The rolling demo can continue past local style disagreements while still recording the evidence that an author may
choose to polish. This prevents style metrics from causing unbounded continuation repair loops and keeps the system
focused on controllable long-form production: plot does not drift, authors can revise, and Git can branch or roll back.

## Verification

Implementation must prove on the same Chapter 6 case that:

- style diagnostics still report the original fail metrics;
- planner output sets `quality_gate_locked=false`;
- planner output carries `style_advisory_active=true`;
- `next_action` is no longer `await_quality_gate`;
- selected Chapter 7/8 cards are visible for continuation;
- no prose is generated, rewritten, pasted, or edited by the orchestrator.
