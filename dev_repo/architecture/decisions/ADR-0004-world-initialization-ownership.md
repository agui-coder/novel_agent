# ADR 0004: World Initialization Ownership

Date: 2026-05-12

## Status

Accepted for the current amendment contract.

## Context

The world model workflow previously had two initialization-capable paths:

- Dify `INIT_AGENT`, which owns interactive agent orchestration and LoreGit tool calls.
- The local backend batch pipeline, which performs long-summary extraction and streams progress through `/api/world/init_batch_pipeline`.

The same user phrase, such as "初始化这本书", could be understood as a Dify world-agent action while the frontend actually routed it to the backend batch pipeline. That split made ownership ambiguous: `world_model.md` could be initialized by the backend while `status_card.md` quality and archival expectations still lived in the Dify prompt contract.

## Decision

World initialization is owned by the backend batch pipeline.

For initialization, rebuild, batch initialization, and first world-model generation:

- The frontend routes the action to the backend initialization pipeline.
- The backend pipeline is responsible for generating and committing both `world_model.md` and `status_card.md`.
- `status_card.md` is a required initialization artifact, not a Dify-side optional repair.
- Dify world workflows no longer own initial world/status creation.

Dify remains responsible for interactive world-agent behavior:

- reading and explaining the world model;
- local revisions after initialization;
- original-text or summary-driven corrections;
- online or external verification tasks when explicitly routed there.

## Consequences

- The user-visible "初始化这本书" path has one owner: backend pipeline.
- Dify workflow graph patches must retire or bypass `INIT_AGENT` ownership rather than duplicating the backend pipeline contract.
- Backend pipeline verification must check `world_model.md`, `status_card.md`, and per-book Git commit state together.
- Existing Dify workflow run history remains audit evidence. No Dify schema migration is required.

## Verification

- Architecture and ER truth name backend pipeline as the sole initialization owner.
- Live Dify DB graph is backed up and patched in a later slice; YAML exports are ignored.
- Same-case acceptance uses book `6982529841564224526` and verifies that "初始化这本书" reaches `/api/world/init_batch_pipeline`, not Dify `INIT_AGENT`.
