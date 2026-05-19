# ADR-0005: Style Artifact Initialization Through Live Dify And LoreGit Diagnostics

Date: 2026-05-12

## Status

Superseded by ADR-0016.

This record is retained as historical evidence for why the style diagnostics
trio exists. Initialization ownership has moved from the live Dify style
workflow to the promptless backend `/api/style/init_pipeline`.

## Context

The style layer has four author-facing files: `style_guide.md`, `style_fingerprint.md`, `style_review.md`, and `style_constraints_for_continuation.md`.

`style_guide.md` may remain an author-maintained guide, but the other three files need a repeatable initialization/rebuild path before continuation and review agents can consume them as style constraints. A previous probe showed that the backend already exposes deterministic diagnostics at `POST /tools/generate_style_diagnostics`, while the live Dify ToolProvider and style workflow do not expose or require that tool.

Dify runtime truth for this repository is the live PostgreSQL graph and ToolProvider row. YAML exports are evidence only.

## Decision

Style initialization and rebuild are a Dify style-agent runtime flow backed by LoreGit diagnostics:

- The live LoreGit ToolProvider must expose `generate_style_diagnostics`.
- The live style workflow must make `generate_style_diagnostics` available to the style Agent.
- For explicit user requests such as "初始化文风" or "重建文风", the style Agent must call diagnostics first, then write all three generated artifacts through the existing gated draft/sandbox Markdown write tools:
  - `style_fingerprint.md`
  - `style_review.md`
  - `style_constraints_for_continuation.md`
- The Agent may update `style_guide.md` only as a lower-frequency author guide, not as a substitute for the three diagnostics products.
- Successful generation remains reviewable draft work. The human author confirms or rolls back through the existing draft/review flow.

## Unchanged Boundaries

- `KnowledgeFile` source status remains mixed source/derived because humans and agents can both edit these markdown files.
- No database schema migration is required.
- World initialization ownership remains with the backend batch pipeline; this ADR only covers style artifacts.
- Dify workflows still write book files only through Flask/LoreGit tools.

## Verification

The flow is accepted only when these are all true:

- live `tool_api_providers.tools_str` and `schema` contain `generate_style_diagnostics`;
- live and draft style workflow graphs contain the diagnostics operation and the three artifact filenames;
- post-patch dry-run reports no remaining change;
- a Chrome frontend real-chain run on the style route produces reviewable draft changes for all three files;
- the generated artifacts contain non-template content tied to source style evidence.
