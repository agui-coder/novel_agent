# ADR-0021: Local Runtime Configuration Center

Date: 2026-05-19

## Status

Accepted for implementation under `CONFIG-CENTER-1`.

## Context

The project already depends on local runtime configuration for Dify App API
keys, Dify base URL, request timeouts, and backend model-provider credentials
used by deterministic batch pipelines. Today those values are supplied through
process environment variables and `novel_git_server/.env.local`, which works for
development but is too hidden for a reproducible demo and too easy to misalign
after a machine restart.

The author-facing workbench needs a configuration entry point, especially for
Dify API settings, without turning secrets into chat messages or committing
private credentials to Git.

## Decision

Introduce a local runtime configuration center backed by
`novel_git_server/.env.local`.

The configuration center may expose backend APIs and frontend UI that:

- read current configuration as a redacted status view;
- write selected local settings into `novel_git_server/.env.local`;
- refresh the in-process Dify agent registry after a successful save;
- report configuration completeness for each local integration surface.

The first supported configuration group is:

- Dify Service API base URL and timeout;
- per-agent Dify App API keys for world, style, outline, continuation, and
  review routes;
- backend model-provider settings for batch pipelines, including DeepSeek base
  URL, model names, and API key.

## Secret Handling

`novel_git_server/.env.local` is a local secret file and must remain ignored by
Git. Runtime configuration APIs must never return complete API keys. They may
return only status fields such as `configured`, `source`, `masked_value`, and
short key suffixes.

Frontend code must not persist API keys in local storage, conversation logs,
book repositories, or review artifacts. The configuration UI may keep unsaved
form input in React state only.

## Runtime Boundaries

Saving local runtime configuration does not edit Dify workflow prompts, graph
topology, model nodes, provider credentials inside Dify PostgreSQL, plugin
packages, book files, or conversation logs.

Patching Dify database credentials or model/thinking settings remains a separate
runtime-operation contract because it touches `dify-workflows-runtime`, not only
the local Flask bridge configuration.

## API Semantics

The backend configuration API should be local-control-plane only. It may update
Flask process configuration and rebuild `DIFY_AGENT_REGISTRY` immediately after
writing `.env.local`, so later Dify calls can use the new values without
restarting the backend process.

Writes should be atomic: a failed save must not leave a partially written
`.env.local`.

## Compatibility

No migration or backfill is required. Existing developers may keep their current
`novel_git_server/.env.local`. Missing values should appear as `configured:
false` rather than causing the workbench to crash.

## Verification

Implementation must prove:

- missing `.env.local` yields a safe redacted default view;
- saving API keys does not return full key material;
- `novel_git_server/.env.local` is written atomically and stays ignored by Git;
- the active Dify agent registry is refreshed in the same backend process;
- configuration reads and writes do not generate or modify novel content.
