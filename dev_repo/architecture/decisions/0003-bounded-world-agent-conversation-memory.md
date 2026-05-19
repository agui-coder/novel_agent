# ADR 0003: Bounded World Agent Conversation Memory

Date: 2026-05-08

## Status

Accepted.

## Context

The world model workflow is now a creative constraint engine, but the author-facing chat still needs short-turn continuity. Without Dify conversation memory, a follow-up such as "use the second suggestion above" can lose the immediately previous answer even though the local UI thread is intact.

The durable truth remains the book files: `world_model.md`, `status_card.md`, and `domain_rules.md`. Conversation memory is only an interaction aid. It must not become an implicit write path, a replacement for explicit review, or a way to bypass bounded-read cost guards.

## Decision

Enable bounded Dify memory for the three world-model agent nodes:

- `INIT_AGENT`
- `READ AGENT`
- `ONLINE_AGENT`

The live and draft Dify workflow graphs use:

```yaml
memory:
  query_prompt_template: "{{#sys.query#}}\n\n{{#sys.files#}}"
  window:
    enabled: true
    size: 6
```

This is the agent node's top-level `data.memory`, not an `agent_parameters.memory` entry. Dify 1.12.1 injects recent conversation history only from the top-level `AgentNodeData.memory` field when it builds the model parameter's `history_prompt_messages`.

The continuation fallback route also targets `READ AGENT`. Short context-dependent inputs such as "continue", "use the second one", or "what was the second candidate" must reach an agent node with Dify history instead of the fixed "state memory expired" answer node.

The local bridge keeps local thread identity and upstream Dify identity separate. The frontend sends `thread_id` for the local session and `upstream_conversation_id` for Dify continuity. The backend may recover the upstream id from `dev_repo/conversations/**`, but must not send a local `conv_*` id to Dify as if it were an upstream id.

## Unchanged

- Dify graph topology stays at 10 nodes and 12 edges.
- Model provider and model stay `langgenius/deepseek/deepseek` / `deepseek-v4-flash`.
- LoreGit tool lists stay unchanged.
- Prompt cost guards and bounded-read instructions stay unchanged.
- File truth stays in `world_model.md`, `status_card.md`, and `domain_rules.md`.
- Writes still require explicit user intent and still go through draft/review tooling.

## Consequences

- Short follow-up turns can reference prior assistant output in the same Dify conversation.
- Cost can rise modestly because recent turns are included, so the window is deliberately small.
- Long-term continuity still requires accepted file updates; chat memory is not archival truth.
- If restored Dify upstream conversation ids go stale, the bridge retry behavior remains responsible for recovering without corrupting local threads.

## Verification

- Live PostgreSQL readback must show both live and draft world workflows with the three agent nodes at `data.memory.window.enabled=true` and `data.memory.window.size=6`, with no stale `agent_parameters.memory`.
- Live PostgreSQL readback must show the continuation fallback target is `READ AGENT`, not the fixed state-expired answer node.
- Readback must confirm topology remains 10 nodes / 12 edges.
- Patch script validation must confirm model and tool lists are unchanged.
- Manual Playwriter acceptance should use a short two-turn follow-up, not a whole-book query.
