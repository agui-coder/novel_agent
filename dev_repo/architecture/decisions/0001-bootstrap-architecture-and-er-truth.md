# ADR 0001: Bootstrap Architecture And ER Truth

Date: 2026-05-07

## Status

Accepted for current repository governance.

## Context

The repository already had `dev_repo` process runtime files, but it did not have a versioned architecture constitution or data-model constitution. The updated Cyber-Ming skills require serious projects to treat `dev_repo/architecture/` and `dev_repo/architecture/data-model/` as runtime truth for planning broad changes.

## Decision

Create versioned architecture and ER truth under `dev_repo/architecture/**`. Keep volatile process runtime and conversation logs ignored, but allow architecture files to be committed.

## Consequences

- Future implementation contracts must cite affected architecture nodes and data entities.
- Architecture-changing work requires an architecture amendment contract.
- Entity, relationship, identity, source/derived, migration, or deletion-semantic changes require an ER/data-model amendment contract.
- Existing docs under `docs/` remain useful narrative context but do not replace this constitution.

