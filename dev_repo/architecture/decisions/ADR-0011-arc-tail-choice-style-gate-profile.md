# ADR-0011: Arc-Tail Choice Style Gate Profile

Date: 2026-05-14

## Status

Accepted for implementation under `ROLL-CH5-CHOICE-STYLE-DELTA`.

## Context

The rolling Chapter 5 probe proved that the continuation workflow can produce the chapter through the project chain and pass the length gate without Codex-authored prose. Independent style validation then failed because the chapter was classified as `bridge_exposition_continuation`.

That classification was too coarse for an arc-tail choice/resolution card. This card role naturally concentrates dialogue pressure, decision beats, and next-unit hooks. Treating those signals as ordinary bridge/exposition drift creates a false stop after the project workflow has already performed its allowed repair rounds.

## Decision

Add a deterministic `arc_tail_choice_continuation` style gate profile.

The profile may be selected only from source outline-card evidence in `chapter_outline.md`. The generated draft can be measured, but draft prose alone must never select this more permissive profile.

The selector requires all of these source-evidence groups:

- arc-tail or resolution cues;
- multiple choice/decision cues;
- cost, memory, lock, or control cues.

The profile is a gate specialization, not a bypass:

- length validation still applies;
- review and human acceptance gates still apply;
- normal continuation chapters keep the standard profile;
- bridge/mechanism chapters that do not meet the arc-tail choice evidence keep the bridge profile;
- warnings remain visible when elevated paragraph, dialogue, or suspense metrics are expected but still worth tracking;
- Codex and local orchestration code still must not write prose.

## Boundaries

Allowed:

- deterministic diagnostics may read existing chapter-card evidence already available to `generate_style_diagnostics`;
- deterministic diagnostics may report the selected profile and matched cue groups;
- repair plans may surface the active profile so the project workflow can decide whether to repair through its own continuation/style chain.

Not allowed:

- using draft prose alone to select `arc_tail_choice_continuation`;
- changing Dify workflow ownership, ToolProvider operations, or prompt graph in this delta;
- changing `chapter_draft.md` directly;
- suppressing failures unrelated to the selected profile.

## Compatibility

Existing books without matching source outline-card evidence continue to use the opening or standard continuation profiles. Bridge/mechanism cards continue to use `bridge_exposition_continuation` unless the stricter arc-tail choice evidence is present.

No database schema migration, Dify row mutation, or historical book backfill is required.

## Verification

`ROLL-CH5-CHOICE-STYLE-DELTA` verifies this amendment by:

- adding unit tests for source-evidence profile selection;
- proving that standard and bridge profiles are not globally weakened;
- proving that draft prose alone does not select the profile;
- revalidating the existing project-generated Chapter 4 and Chapter 5 without editing prose.
