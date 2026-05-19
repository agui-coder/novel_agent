# ADR-0008: Continuation Agent As Chapter Production Layer

Date: 2026-05-13

## Status

Accepted.

## Context

The outline layer now owns webnovel serial control artifacts. In particular,
`chapter_outline.md` is the executable chapter-card deck, while the outline
Agent is explicitly forbidden from writing prose chapters.

The next system layer must turn those chapter cards into reviewable prose. The
existing continuation route already maps `chapter_draft.md` to the continuation
Agent, but the live Dify workflow had lost important production constraints:
style continuation constraints were not mandatory context, length validation was
not exposed in the live ToolProvider, and prompt semantics did not clearly bind
the Agent to chapter-card execution.

Without a formal boundary, the outline layer, continuation layer, and review
layer can blur:

- outline may overproduce prose instead of cards;
- continuation may invent structure instead of executing cards;
- review may become the first place where missing chapter length, style, or
  world-state violations are discovered.

## Decision

The continuation Agent is the chapter production layer.

It consumes:

- `chapter_outline.md` as the primary executable chapter-card source;
- `arc_outline.md` and `master_outline.md` for retention and reader-promise
  context;
- `summary.md` for source-backed archive facts;
- `world_model.md`, `status_card.md`, and `domain_rules.md` for durable
  constraints, current state, and reusable rule checks;
- `style_constraints_for_continuation.md` as the mandatory prose rhythm and
  style constraint surface;
- `style_guide.md` and `error_archive.md` as secondary author-facing context.

It writes only:

- `chapter_draft.md`

The continuation Agent must execute chapter cards rather than silently replacing
the outline layer. A normal production request should select the next explicit
cards from `chapter_outline.md`, produce prose sections in `chapter_draft.md`,
and keep the output traceable to those cards.

The continuation Agent must preserve the outline evidence-mode boundary:

- `SOURCE_FACT` may be used as source-backed canon.
- `AUTHOR_PROPOSAL` may be dramatized as planned future material when the author
  asks for production, but the final response should make clear it was executed
  from outline proposal material rather than discovered canon.
- `WORLD_MODEL_REQUIRED` must not be treated as a hard world fact unless
  `world_model.md` or `status_card.md` already accepts it. If a requested chapter
  depends on unresolved `WORLD_MODEL_REQUIRED`, the continuation Agent must
  block, ask for world-model acceptance, or write only a clearly bounded
  non-canon alternative.

For multi-chapter production, the continuation Agent must use the LoreGit
chapter length validation tool after each written chapter. The default gate is:

- `min_chars = 2200`
- `target_chars = 2500`
- `max_chars = 3200`
- counting uses `non_whitespace_chars` from `validate_chapter_lengths`

If a chapter is under the minimum, the Agent should do bounded local expansion
of that chapter or its nearest section and re-run validation before moving on.
It must not claim completion while `under_min` remains for the requested
chapter set.

When style repair and length recovery interact, the continuation Agent must
preserve the active style repair plan. Bridge/exposition chapters have a special
failure mode: if `bridge_exposition_continuation` fails on two or more of
`avg_para`, `dialogue_ratio`, `environment_density`, and `exposition_density`,
the Agent must treat it as a four-density failure rather than ordinary polish.
In that mode, it must reduce paragraph bulk, Q&A-style dialogue, atmosphere-only
environment cues, and abstract rule explanation before adding material. Any
length recovery must use only scene-bound micro beats that preserve or lower
dialogue, environment, and exposition density.

If the remaining hard failures narrow to `avg_para` plus `environment_density`,
or if a repair recovers length while making `avg_para` worse, the continuation
Agent must switch from generic bridge repair to a paragraph/environment delta:
the replacement must measurably increase paragraph breaks unless the chapter is
already inside the hard band, must not merge split beats back into bulky
paragraphs during sentence polishing, and must reduce repeated environment cue
clusters. Length recovery in this delta must prefer non-environmental micro
beats such as body reaction, object handling, silent decision, consequence
acknowledgement, or character positioning.

## Unchanged Boundaries

- The outline Agent still writes only `brainstorm.md`, `master_outline.md`,
  `arc_outline.md`, and `chapter_outline.md`.
- The style Agent still owns style artifact initialization and rebuild.
- The world initialization pipeline still owns first-create/rebuild of
  `world_model.md` and `status_card.md`.
- The review Agent still owns review findings and may write `error_archive.md`,
  not `chapter_draft.md`.
- `draft/sandbox` remains the review branch for material AI writes.
- No database schema migration or historical book backfill is implied.

## Compatibility

Existing books where `chapter_draft.md` is absent remain valid. The file is
virtual/defaulted until the first continuation production request materializes
it on `draft/sandbox`.

Existing outline files remain valid even if sparse. A continuation request may
refuse production or ask for outline repair when `chapter_outline.md` lacks
executable cards.

Existing Dify workflow runs are evidence only. Live continuation behavior is
proven from the PostgreSQL workflow graph and ToolProvider rows, not from YAML
exports or historical patch scripts.

## Verification

The continuation production layer is accepted only when these are all true:

- live LoreGit ToolProvider exposes `validate_chapter_lengths`;
- live and draft continuation workflow graphs contain `book_id`,
  `style_constraints_for_continuation.md`, `chapter_outline.md`, and
  `validate_chapter_lengths`;
- prompt semantics require bare `chapter_draft.md` file names and draft/sandbox
  writes through existing gated LoreGit tools;
- prompt semantics require chapter-card execution and preservation of
  `SOURCE_FACT`, `AUTHOR_PROPOSAL`, and `WORLD_MODEL_REQUIRED` boundaries;
- a real frontend -> backend -> Dify -> LoreGit run can materialize
  `chapter_draft.md` for the selected book;
- the generated draft changes only `chapter_draft.md`;
- length validation reports no `under_min` chapter in the accepted requested
  set;
- prose quality checks show the result is prose, not merely outline, summary, or
  process report.
