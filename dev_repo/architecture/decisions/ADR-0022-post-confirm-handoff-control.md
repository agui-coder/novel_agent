# ADR-0022: Post-Confirm Status Handoff Control

Date: 2026-05-19

## Status

Accepted for implementation under `DRAFT-ARCHIVE-HANDOFF`.

## Context

ADR-0020 defines the accepted chapter canonization boundary: when a human
confirms `chapter_draft.md`, the backend may preserve the accepted text into
formal `chapters/*.md` files and return a post-confirm world/status handoff
payload. The existing frontend already attempted to run that payload
automatically, but it reused the world initialization action state. As a result,
authors could see the chapter archive step only as a vague "confirm" action,
and a failed or interrupted status-card handoff had no clear retry surface.

For rolling demo use, the author needs to see a closed loop:

1. continuation Agent writes `chapter_draft.md`;
2. author confirms the draft;
3. accepted text is archived as formal `chapters/*.md`;
4. world route refreshes `status_card.md` and only updates durable world files
   when the new chapters require it.

## Decision

Expose post-confirm status handoff as its own promptless workbench action state.

The frontend may:

- keep the backend-provided `post_confirm_payload` in local React state after a
  successful chapter-draft confirm;
- run that payload automatically after canonization;
- show progress under a distinct "正文归档接棒" action instead of world
  initialization;
- allow retrying the same payload when the handoff fails or is deferred because
  another Agent is streaming.

The payload remains a control-plane description. It references accepted chapter
numbers, titles, and archive file paths, but must not contain chapter prose.

## Boundaries

This control must not:

- generate, rewrite, polish, or summarize chapter prose;
- bypass `draft/sandbox` review for proposed world/status edits;
- route state maintenance through the review Agent;
- treat every accepted chapter as a required `world_model.md` change;
- store the handoff payload in book files, chat messages, or local persistent
  browser storage.

`status_card.md` remains the routine post-confirm target. `world_model.md` and
`domain_rules.md` remain optional, durable-constraint targets.

## Compatibility

No migration or backfill is required. Existing confirm responses without a
`post_confirm_payload` continue to behave as ordinary draft confirmations.
Existing chapter archive semantics from ADR-0020 remain unchanged.

## Verification

Implementation must prove:

- the review UI exposes chapter-draft confirmation as a body-archive action;
- the workbench action dock can show and retry the post-confirm handoff;
- frontend build succeeds;
- backend confirm tests still prove `post_confirm_payload` contains no chapter
  prose and routes to the world-model route.
