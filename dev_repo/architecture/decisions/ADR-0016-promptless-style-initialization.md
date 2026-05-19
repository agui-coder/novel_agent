# ADR-0016: Promptless Style Initialization And Post-Init Style Assistant

Date: 2026-05-16

## Status

Accepted.

Supersedes ADR-0005 for initialization ownership.

## Context

Style initialization is a fixed artifact rebuild, not a natural-language
conversation. Sending "初始化文风" through chat made the style Agent both a
pipeline launcher and a discussion assistant, which polluted chat history,
made reruns hard to reason about, and hid deterministic progress inside agent
prose.

The project now has a workbench action surface for promptless direct jobs.
World initialization already uses this model through `/api/world/init_batch_pipeline`.

## Decision

Style initialization/rebuild is owned by the backend route
`/api/style/init_pipeline`, implemented by
`novel_git_server/pipelines/style_artifact_init.py` and
`novel_git_server/agents/style_init.py`.

The route calls deterministic style diagnostics and writes the style trio:

- `style_fingerprint.md`
- `style_review.md`
- `style_constraints_for_continuation.md`

The frontend launches this as a promptless workbench action with structured
progress. The chat panel must not launch this pipeline by keyword.

The Dify style workflow remains useful, but only as a post-init assistant:

- read and explain style artifacts;
- compare them against latest source text and diagnostics evidence;
- discuss author preferences;
- write minimal author-requested revisions to style files.

For initialization or complete rebuild requests, the style Agent must hand the
user back to the workbench action surface.

## Unchanged Boundaries

- Dify workflows still write book files only through Flask/LoreGit tools.
- `style_guide.md` remains an author-facing guide and does not replace the
  diagnostics trio.
- Continuation treats style files and latest source text as imitation
  references/advisory evidence, not a default scheduler lock.
- No database schema migration is required.

## Verification

- Backend tests prove `/api/style/init_pipeline` streams progress, writes the
  trio, commits changed artifacts, skips existing non-template artifacts without
  force, and rejects path escape.
- Style Dify prompt regression tests prove initialization/rebuild is handed to
  `/api/style/init_pipeline`, while post-init discussion and minimal write tools
  remain available.
- Frontend build proves the workbench action model compiles with style direct
  job controls and guidance.
