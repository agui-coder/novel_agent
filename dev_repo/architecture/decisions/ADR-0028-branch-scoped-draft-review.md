# ADR-0028: Branch-Scoped Draft Review

Date: 2026-05-21

## Status

Accepted.

## Context

The workbench now exposes plot branches as an author-facing feature. A writer can explore parallel story lines such as `master`, `线路一`, and `线路二`, and each branch must evolve independently.

The historical draft review implementation used a singleton branch named `draft/sandbox`. That was acceptable while the book had one active mainline, but it becomes unsafe after plot branching. A draft created from `线路二` can still exist while the user checks out `master`. If review, diff, or confirm resolves its baseline from the current checkout, the system may show false deletions and can merge the wrong draft into the wrong plot line.

Observed evidence from the current local book:

- `draft/sandbox` is clean relative to `线路二` except for `chapter_outline.md`.
- The same draft compared against `master` shows unrelated deletions and file changes.
- Therefore the draft content is not corrupt; the review/confirm baseline is under-specified.

## Decision

Draft review state is branch-scoped.

Every `draft/sandbox` review state must carry:

- `draft_branch`: the review branch, currently `draft/sandbox`.
- `base_branch`: the source plot branch that the draft was created from.
- `base_commit`: the source branch head when the draft was created or first bound.
- `draft_commit`: the latest review branch commit when metadata is written or refreshed.
- `source`: whether the binding was explicit on creation or inferred for a legacy branch.

The storage form may be ignored per-book runtime metadata such as `.loregit/draft_meta.json`. It must survive backend restarts, but it must not pollute author-facing review diffs or become a committed book knowledge file.

The singleton branch name remains for compatibility in this phase. The semantic identity is now `BookWorkspace + draft_branch + base_branch`, not merely `BookWorkspace + draft_branch`.

## Required Behavior

- Draft creation captures the current non-draft checkout as `base_branch` and its head commit as `base_commit`.
- Existing legacy `draft/sandbox` branches without metadata may be bound by Git evidence. The preferred inference is a local branch whose merge-base with the draft equals that branch head and whose diff to the draft is minimal. Ambiguous inference must fail closed.
- Review changed-file lists and diff previews compare `base_branch..draft/sandbox`.
- Confirm merges `draft/sandbox` into `base_branch` only. If the current checkout is a different branch, the backend must report a branch-mismatch error or require the frontend to switch first.
- Rollback resets or deletes the draft review branch and returns to `base_branch` when possible.
- Frontend review surfaces should display both draft branch and source plot branch so the author can see which story line is being resolved.

## Non-Goals

- This decision does not yet require multiple simultaneous draft branches.
- This decision does not change continuation prose ownership: only the continuation route may write `chapter_draft.md`.
- This decision does not change accepted chapter canonization, summary refresh, or status projection ordering.

## Consequences

The immediate bug is fixed by making baseline selection explicit and durable. Long term, this can evolve into per-plot draft branches, but the current compatibility path is enough to prevent cross-branch contamination while preserving the existing review UI and Dify tool contracts.

## Verification

- A draft created from a non-default plot branch reports that branch as its `base_branch`.
- Switching to another branch does not change the draft changed-file list.
- Confirm on the wrong current branch fails closed with source/current branch evidence.
- Confirm after switching back to the source branch merges only into the source plot branch and leaves other plot branches unchanged.
