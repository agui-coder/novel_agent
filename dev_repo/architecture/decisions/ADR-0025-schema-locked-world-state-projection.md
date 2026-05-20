# ADR-0025: Schema-Locked World State Projection

Date: 2026-05-20

## Status

Accepted.

## Context

The backend batch pipeline already owns first-create and explicit rebuild of the `world_model.md` and `status_card.md` pair. Recent real-book initialization showed a different failure mode from summary archive generation:

- `world_model.md` can look structurally correct while still being sparse, generic, or over-bound to a previous stage of the story;
- lifecycle-sensitive stories, especially loop or reincarnation structures, need old constraints to remain historically true without automatically staying current-active;
- `status_card.md` can satisfy required field labels while still carrying too many weak, generic, or `???` values;
- letting the model directly author final Markdown makes it difficult for the backend to prove evidence coverage, lifecycle labels, and current-state quality before writeback.

The world/status pair is consumed by outline, continuation, review, rolling context packs, and author-facing demo workflows. It must therefore behave like a validated state projection, not like a loose reading note.

## Decision

World/status initialization uses a schema-locked world-state projection model.

- The world initialization model must return structured world facts or an equivalent validated intermediate representation, not final trusted Markdown.
- Each world fact must carry at least category, subject, content, lifecycle, applicability scope, evidence reference, confidence, and downstream impact.
- Backend validation owns lifecycle, applicability, evidence presence, required categories, Chinese surface, and conversational-noise rejection before any writeback.
- `world_model.md` is deterministically rendered from accepted world facts. It is the durable creative constraint view, not the raw model answer.
- `status_card.md` is a deterministic current-state projection from accepted world facts plus the latest summary batch. It should expose the active timeline/state, current driver, key character state, open promises, immediate next-chapter obligations, and evidence anchors.
- A weak status projection must fail closed or report explicit insufficiency when required fields are present but too empty, too generic, or dominated by `???`.
- Repair prompts may retry malformed JSON or validation failures, but repaired content must pass the same backend validators before writeback.

## Boundaries

- Dify world workflows remain post-initialization interactive agents for explanation, discussion, local correction, and online verification. They are not the first-create/rebuild owner for the world/status pair.
- Exported Dify YAML, live Dify PostgreSQL workflow graph, plugin packages, and model-node thinking flags are out of scope for this backend pipeline decision.
- The backend may distill constraints and current state from existing source artifacts, but it must not generate continuation prose, outline cards, or future story decisions.
- The intermediate world-facts representation is a validation object. It is not a new source-of-truth file unless a later contract explicitly creates such a persisted artifact.

## Compatibility

No historical book migration or backfill is required. Existing `world_model.md` and `status_card.md` remain valid history until the user explicitly rebuilds or revises them.

New pipeline output should prefer the schema-locked Chinese format and lifecycle-aware current-state projection. Readers should tolerate older world/status files where practical.

## Verification

- Unit tests prove malformed structured world output can be repaired or fails closed without writing partial files.
- Unit tests prove facts missing lifecycle, applicability scope, evidence, or downstream impact cannot silently become current-active hard constraints.
- Unit tests prove `world_model.md` is rendered from validated facts and includes lifecycle, scope, evidence, and downstream impact.
- Unit tests prove `status_card.md` rejects or reports weak projections with excessive `???` or missing evidence anchors.
- A real-book rebuild proves the current book can produce non-empty world/status outputs and leaves the per-book Git repository clean after the archive commit.
