# Architecture Truth

This directory is the repository architecture truth layer for `novel_agent`.

Runtime truth in `dev_repo/state.json`, `journal.jsonl`, `evidence_index.json`, and `tree.md` answers which campaign is active. Architecture truth answers what system exists, which files belong to which nodes, and when an ordinary contract must become an architecture or data-model amendment contract.

## Files

- `ARCHITECTURE.md`: human-readable architecture census.
- `graph.json`: machine-readable architecture graph.
- `index.json`: machine-readable file and route index for planning.
- `invariants.md`: architecture rules ordinary contracts must preserve.
- `diagrams/`: Mermaid diagrams for system context and critical flows.
- `decisions/`: architecture decision records.
- `data-model/`: durable entity and relationship truth.

## Confidence

- `confirmed`: proven by code, config, scripts, runtime files, or read-only database evidence.
- `inferred`: reconstructed from naming, layout, imports, or observed usage.
- `unknown`: requires a future probe or human confirmation.

Do not promote an inferred or unknown fact to confirmed during takeover without new evidence.

