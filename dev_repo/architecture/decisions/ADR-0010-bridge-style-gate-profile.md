# ADR-0010: Bridge Chapter Style Gate Profile

Date: 2026-05-14

## Status

Accepted for implementation under `ROLL-STYLE-DELTA`.

## Context

The rolling chapter probe proved that the continuation workflow can produce the next chapter through the project chain without Codex-authored prose. Chapter 4 then passed the length gate but failed the deterministic style gate after two repair rounds.

The failing chapter card is a bridge and mechanism chapter: it carries causal explanation, cost accounting, and state transition work between the opening unit and the next production beat. Treating that card as a generic continuation chapter creates a false blocker, because the current standard profile assumes the same exposition density and paragraph cadence as ordinary scene chapters.

The system needs a narrow style-gate specialization for bridge/exposition chapters without weakening normal chapter checks or letting the generated draft justify its own profile.

## Decision

Add a deterministic `bridge_exposition_continuation` style gate profile.

Profile selection must be based on source outline-card evidence, especially fields in `chapter_outline.md` such as chapter goal, conflict, payoff, state change, ending hook, and constraint references. The generated draft text may be measured, but it must not be the authority that selects a more permissive profile.

The bridge profile is a gate specialization, not a bypass:

- length validation still applies;
- review and human acceptance gates still apply;
- normal continuation chapters keep the standard profile;
- the rolling orchestrator still stops on unresolved style, review, Git, or author-confirmation blockers;
- Codex and local orchestration code still must not write prose.

## Boundaries

Allowed:

- deterministic diagnostics may read chapter-card evidence already available to `generate_style_diagnostics`;
- deterministic diagnostics may report selected gate profile metadata in style-gate output;
- repair plans may explain the active profile so the project workflow can repair prose through the continuation/style chain.

Not allowed:

- using draft prose alone to select the bridge profile;
- changing Dify workflow ownership, ToolProvider operations, or prompt graph in this delta;
- changing `chapter_draft.md` directly;
- suppressing style failures unrelated to the bridge/exposition profile.

## Compatibility

Existing books without chapter-card evidence continue to use the opening or standard continuation profiles. Existing style artifacts remain valid; the new profile affects future deterministic diagnostics output, not stored prose.

No database schema migration, Dify row mutation, or historical book backfill is required.

## Verification

RSD-0 verifies this amendment by parsing architecture JSON artifacts and running `git diff --check`.

RSD-1 must prove with unit tests that:

- a chapter with bridge/mechanism evidence in its outline card selects `bridge_exposition_continuation`;
- ordinary chapters still select the standard profile and can still fail on real drift;
- profile selection is not triggered by draft prose alone.

RSD-2 must re-run the Chapter 4 rolling-case diagnostics without editing prose and record whether the same generated chapter now passes, warns, or still fails under the specialized gate.

## Amendment - Bridge Profile V2

Date: 2026-05-14

`CH7-BRIDGE-PROFILE-V2` narrows the bridge profile after the Chapter 7 same-case repair proved that raw
`exposition_density` and `suspense_density` are too coarse for bridge/mechanism chapters. The v1 profile could
identify bridge chapters, but it still treated necessary, scene-bound causal explanation the same as abstract
padding.

Bridge V2 keeps the same source-evidence selection rule: the generated draft cannot choose the more permissive
profile for itself. The new behavior adds a profile-specific quality snapshot computed from the draft text after
the profile has already been selected from `chapter_outline.md`.

The bridge profile may downgrade only `exposition_density` and `suspense_density` from hard failure to tracked
warning, and only when all of these are true:

- most paragraphs are bound to scene anchors such as action, environment, dialogue, or interior pressure;
- explanatory paragraphs are scene-bound rather than free-floating rule talk;
- suspense paragraphs are scene-bound rather than repeated open questions;
- action or environment appears often enough to prove the chapter is still a scene;
- the metric is above the old hard band only within a bounded ratio.

This is still not a bypass. The warning remains visible in `red_flags`, `repair_plan.priority_metrics`, and the
case evidence. Abstract rule dumps and hook-heavy padding must continue to fail.

Compatibility remains unchanged: no database migration, Dify workflow mutation, prompt patch, or book backfill is
required. The change is deterministic backend diagnostics only.

Verification for Bridge V2:

- unit tests prove scene-bound bridge exposition/suspense can be downgraded to warning;
- unit tests prove unbound abstract exposition/suspense still fails;
- existing standard and arc-tail choice profile tests continue to pass;
- Chapter 7 same-case validation at book head `dbaef56` passes with four tracked warnings and no prose changes.
