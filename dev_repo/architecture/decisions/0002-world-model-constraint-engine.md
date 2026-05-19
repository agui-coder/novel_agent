# ADR 0002: World Model Constraint Engine

Date: 2026-05-08

## Status

Accepted.

## Context

The live Dify world model app already has useful operational structure: intent routing, `INIT_AGENT` / `READ AGENT` / `ONLINE_AGENT`, local LoreGit tools, and conservative write discipline. The weak point is not routing. The weak point is product semantics: `world_model.md` can degrade into a loose archive of extracted facts, so later continuation, review, outline, and style workflows cannot reliably use it as a creative constraint source.

For webnovel work, the world model must answer a stronger question than "what facts exist": it must explain what keeps the book readable, what cannot be violated, what unresolved promises still drive reader expectation, and which downstream workflow should consume each constraint.

## Decision

Treat the world model layer as a **creative constraint engine**, not as a passive dossier.

The layer is split into three cooperating `KnowledgeFile` products:

- `world_model.md`: durable creative contract. It owns the story promise, genre/selling-point contract, core conflict engines, power/rule systems, institutions, causality, hard constraints, soft assumptions, contradiction ledger, and downstream workflow interface.
- `status_card.md`: current run state. It owns the latest timeline position, POV/current scene state, character state, open promises, immediate next-chapter obligations, and "do not write next" guardrails.
- `domain_rules.md`: reusable machine-readable or semi-machine-readable rules. It owns validated `domain-rule` blocks and reusable checks that review/continuation can apply without re-reading prose.

Every world-model update should classify content into at least one of these creative roles:

- `story_promise`: what the reader is being promised.
- `conflict_engine`: what keeps scenes producing pressure.
- `hard_constraint`: a fact/rule that later writing should not violate without explicit retcon.
- `soft_assumption`: useful but revisable context.
- `open_loop`: a promise, mystery, debt, or setup that expects payoff.
- `workflow_interface`: how continuation, review, outline, style, or archive workflows should use the item.

World model agent prompts may still summarize source evidence, but the accepted output must state the creative use of each important item. A fact-only addition is incomplete unless it also explains why it matters to future writing or review.

## Consequences

- New templates should give `world_model.md`, `status_card.md`, and `domain_rules.md` stable headings aligned with these roles.
- The live Dify world model workflow should preserve its three-agent routing, but its prompts should prioritize creative function before archival breadth.
- Continuation and review workflows can treat world/status/domain rules as constraints and audit surfaces rather than background reading.
- Existing book workspaces do not require migration. Empty or older files remain valid until the author or a future repair action explicitly upgrades them.

## Verification

- Architecture and ER truth mention the creative constraint engine and the three-file split.
- JSON architecture files parse.
- Later implementation slices must prove new templates and live Dify prompt changes against the same target book/file instead of relying on exported YAML.
