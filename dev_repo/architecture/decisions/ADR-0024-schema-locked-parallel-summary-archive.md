# ADR-0024: Schema-Locked Parallel Summary Archive

Date: 2026-05-20

## Status

Accepted.

## Context

The backend summary archive pipeline already owns first-create and explicit rebuild of `summary.md`.
Recent real-book evidence showed that letting each large batch return free-form Markdown makes batch quality and shape drift:

- some batches write bullet lists while others write long paragraphs or numbered lists;
- assistant preambles such as "好的" can enter the archive body;
- oversized batches can omit chapter ranges while still producing plausible prose;
- the top index inherits these inconsistencies because it extracts from model-written Markdown.

The archive is a downstream knowledge surface for world, style, outline, continuation, and review workflows, so its shape must be stable even when model answers vary.

## Decision

`summary.md` rebuild uses a schema-locked parallel extraction model.

- The backend may split source `chapters/*.md` into small extraction batches and invoke the model concurrently.
- Each model call must return structured batch data, not final Markdown.
- The backend validates structured batch data before writeback: chapter range, required sections, chapter coverage, Chinese heading surface, and conversational-noise rejection.
- Final ordering, global coverage validation, index construction, and Markdown rendering are deterministic backend work and must run after all accepted batch results are collected.
- Failed or incomplete batches may be retried or reported as explicit failure, but they must not be silently rendered into `summary.md`.
- The concurrency limit is backend configuration, not a story or Dify workflow property.

## Boundaries

- Dify `reading_archive_agent` remains retired from active `summary.md` production.
- Exported Dify YAML and live Dify DSL are out of scope for this pipeline.
- The backend pipeline may summarize imported chapters, but it must not generate continuation prose, outline cards, or author-facing future story decisions.
- Existing `summary.md` files remain valid history. The schema-locked renderer applies to future import summary generation and explicit rebuilds.

## Compatibility

No schema migration, Dify database mutation, book workspace migration, or historical backfill is required.
Existing readers must remain compatible with older `summary.md` headings where practical, but new pipeline output should prefer the schema-locked Chinese format.

## Verification

- Unit tests prove that concurrent batch completion order does not change final chapter order.
- Unit tests reject or repair missing required sections and conversational preambles.
- Unit tests prove every source chapter is represented in the rendered chapter index.
- A real-book rebuild of the current 501-chapter case produces stable per-batch sections and leaves the per-book Git repository clean after the archive commit.
