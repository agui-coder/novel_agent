# Data Model Truth

This directory stores the durable data-model truth for `novel_agent`.

Architecture truth answers subsystem boundaries. Data-model truth answers which durable entities exist, how they relate, where identity and state live, what is source versus derived, and when a normal implementation contract must become an ER/data-model amendment contract.

## Files

- `ER.md`: human-readable entity relationship census.
- `er.mmd`: Mermaid ER diagram.
- `entities.json`: machine-readable entity catalogue.
- `relationships.json`: machine-readable relationship catalogue.
- `invariants.md`: data-model rules ordinary contracts must preserve.
- `migrations.md`: migration, backfill, and compatibility expectations.

## Confidence

- `confirmed`: proven by code, config, schemas, runtime files, or read-only database evidence.
- `inferred`: reconstructed from naming, layout, documentation, or observed usage.
- `unknown`: needs future probe or human confirmation.

