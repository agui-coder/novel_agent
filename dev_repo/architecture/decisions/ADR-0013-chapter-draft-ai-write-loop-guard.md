# ADR-0013: Chapter Draft AI Write Loop Guard

Date: 2026-05-15

## Status

Accepted

## Context

The rolling 30-chapter stress test exposed a failure mode in the continuation repair loop. After a chapter failed length and style gates, the continuation Agent could keep calling markdown-section write tools with very small "final" or "padding" edits. Prompt constraints already asked it to stop after bounded repair rounds, but the tool layer still allowed many consecutive `chapter_draft.md` commits.

This is dangerous for demo reliability because the loop looks active while it is no longer making structural progress. It also creates noisy book Git history and can trade length recovery against style regressions.

Codex and local orchestration still must not generate or edit prose directly. The fix therefore belongs at the write tool boundary, not in local prose manipulation.

## Decision

LoreGit draft markdown-section write tools now enforce an AI write-loop budget for `chapter_draft.md`.

If recent per-book Git history already contains six consecutive repair-like `[AI_Update]` commits touching `chapter_draft.md` inside the current repair window, the next markdown-section write is rejected with `AI_WRITE_LOOP_GUARD`. The guard returns before writing the file or committing another draft change.

The continuation Agent prompt is also updated to treat `AI_WRITE_LOOP_GUARD` as a hard stop: it must not retry with smaller edits, padding, alternate section paths, or another replacement in the same run. The next valid action is deterministic gate reporting, a bounded repair plan, a review bridge, or a human decision where the rolling gate allows it.

## Invariants

- `chapter_draft.md` remains owned by the continuation route.
- Codex and rolling orchestration code still must not write novel prose.
- The guard is derived from recent Git history; it is not hidden source truth and does not create a new durable entity.
- Guard hits must leave `chapter_draft.md` unchanged.
- The guard is generic to the file and recent AI commit pattern; it is not hardcoded to one book or chapter.

## Compatibility

No migration or backfill is required. Existing book histories remain valid. The guard affects only future draft markdown-section writes when the recent history pattern indicates an active AI write loop.

The threshold intentionally allows normal one-to-three-chapter production plus a small number of local repairs. Normal chapter production commits do not count unless their subjects look like repair-loop commits; repeated repair, round, final, length, style, tweak, padding, push, or loop commits do count.

## Verification

- Backend markdown-section tests cover the seventh recent `chapter_draft.md` AI update being blocked with `AI_WRITE_LOOP_GUARD`.
- Continuation prompt tests prove the live workflow patch script includes the write-loop stop protocol.
- Live Dify patch verification must show provider endpoints, tool set, topology, and model identity remain unchanged.
