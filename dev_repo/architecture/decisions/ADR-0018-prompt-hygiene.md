# ADR-0018: Prompt Hygiene Guardrail

Date: 2026-05-18

## Status

Accepted.

## Context

The live Dify workflows contain prompt surfaces that are part of the product's
runtime behavior. Some prompts drifted toward one book's demo case, kept English
protocol blocks, or exposed unreadable tool descriptions. That weakens the
project's generality: a web novel author should see Chinese, domain-generic
instructions, while story-specific facts should come from the current book's
files at runtime.

The risk is two-layered:

- Live Dify PostgreSQL rows can contain hardcoded prompt text that affects the
  current app immediately.
- Patch scripts and exported workflow YAML can reintroduce the same prompt text
  during restore or future maintenance.

## Decision

Prompt hygiene is now a Dify runtime guardrail.

- General Dify prompts must use Chinese for human-facing instructions.
- Technical identifiers may remain stable, including file names, tool names,
  `book_id`, `SOURCE_FACT`, `AUTHOR_PROPOSAL`, `WORLD_MODEL_REQUIRED`, and
  `EXTERNAL_REFERENCE`.
- Prompt text must not contain a specific book's character names, example book
  ids, tournaments, locations, or one-off red lines unless those facts are read
  from the current book workspace during the run.
- Web search in the outline agent is external reference only. Search output may
  support ideation, but it must not become source-backed canon or world-model
  hard constraint without the normal world/status ownership path.
- Live workflow changes must be paired with reproducible patch-script updates.
- `scripts/scan_dify_prompt_hygiene.py` is the regression scanner for live DB,
  patch scripts, and exported workflow evidence.

## Boundaries

- The guardrail does not change workflow topology, model selection, thinking
  settings, file ownership, or tool permissions by itself.
- The continuation agent remains the only prose writer for `chapter_draft.md`.
- The outline agent may create executable cards but must not write prose.
- The world/status initialization owner remains the backend batch pipeline.
- The scanner is not allowed to treat historical conversation logs as prompt
  truth.

## Compatibility

No schema migration, book workspace migration, or backfill is required. Existing
books keep their current files. This decision governs future prompt patches and
runtime verification.

## Verification

- `python scripts/scan_dify_prompt_hygiene.py --source live-db`
- `python scripts/scan_dify_prompt_hygiene.py --source scripts`
- `python scripts/scan_dify_prompt_hygiene.py --source exports`
- Later prompt-cleaning slices must use failing hardcoded/mojibake scans as red
  tests and passing scans as green tests before claiming completion.
