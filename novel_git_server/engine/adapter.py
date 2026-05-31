"""Adapter layer — same interface as dify_client.py but powered by engine agents.

This allows world_draft.py to swap `from utils.dify_client import X` →
`from engine.adapter import X` with minimal other changes.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Iterator

from engine.base import AgentConfig, LoreAgent
from engine.continuation import CONTINUATION_SYSTEM_PROMPT, CONTINUATION_TOOLS
from engine.review import REVIEW_SYSTEM_PROMPT, REVIEW_TOOLS
from engine.outline import (
    DISCUSS_SYSTEM_PROMPT,
    DISCUSS_TOOLS,
    COMMIT_SYSTEM_PROMPT,
    COMMIT_TOOLS,
    classify_intent,
)

logger = logging.getLogger(__name__)

ENGINE_AVAILABLE = True


class EngineError(RuntimeError):
    """Exception class compatible with DifyClientError for error handling."""
    def __init__(self, message: str, *, status_code: int | None = None, response_body: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


# Global registry of running agents for stop_generation
_running_agents: dict[str, LoreAgent] = {}
_agents_lock = threading.Lock()


def _get_agent_config(agent_key: str) -> AgentConfig:
    """Map Dify agent keys to engine AgentConfigs."""
    thinking = True
    reasoning_effort = "high"

    configs = {
        "continuation_agent": AgentConfig.from_env(
            agent_key="continuation_agent",
            system_prompt=CONTINUATION_SYSTEM_PROMPT,
            max_iterations=45,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
        ),
        "review_agent": AgentConfig.from_env(
            agent_key="review_agent",
            system_prompt=REVIEW_SYSTEM_PROMPT,
            max_iterations=10,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
        ),
        "outline": AgentConfig.from_env(
            agent_key="outline",
            system_prompt=DISCUSS_SYSTEM_PROMPT,
            max_iterations=30,
            thinking=True,
        ),
        "world_model": AgentConfig.from_env(
            agent_key="world_model",
            system_prompt=REVIEW_SYSTEM_PROMPT,
            max_iterations=10,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
        ),
        "style_guide": AgentConfig.from_env(
            agent_key="style_guide",
            system_prompt=REVIEW_SYSTEM_PROMPT,
            max_iterations=10,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
        ),
    }
    return configs.get(agent_key, configs["continuation_agent"])


def _get_tools_for_agent(agent_key: str) -> list:
    tools_map = {
        "continuation_agent": CONTINUATION_TOOLS,
        "review_agent": REVIEW_TOOLS,
        "outline": DISCUSS_TOOLS,
        "world_model": REVIEW_TOOLS,
        "style_guide": REVIEW_TOOLS,
    }
    return tools_map.get(agent_key, CONTINUATION_TOOLS)


def _create_agent(agent_key: str) -> LoreAgent:
    config = _get_agent_config(agent_key)
    tools = _get_tools_for_agent(agent_key)
    return LoreAgent(config=config, tools=tools)


def chat_messages(
    *,
    base_url: str = "",
    api_key: str = "",
    query: str = "",
    inputs: dict[str, Any] | None = None,
    user: str = "loregit",
    conversation_id: str | None = None,
    response_mode: str = "blocking",
    timeout_seconds: int = 90,
) -> dict[str, Any]:
    """Blocking mode — same signature as dify_client.chat_messages()."""
    agent_key = _resolve_agent_key(inputs)
    agent = _create_agent(agent_key)
    result = agent.run(query, inputs)
    return {
        "answer": result.get("answer", ""),
        "conversation_id": result.get("conversation_id") or conversation_id,
        "mode": "engine",
    }


def chat_messages_stream(
    *,
    base_url: str = "",
    api_key: str = "",
    query: str = "",
    inputs: dict[str, Any] | None = None,
    user: str = "loregit",
    conversation_id: str | None = None,
    response_mode: str = "streaming",
    timeout_seconds: int = 90,
    on_conversation_reset: Any = None,
) -> Iterator[dict[str, Any]]:
    """Streaming mode — same signature as dify_client.chat_messages_stream().

    Yields SSE-compatible events: {event, data, id, retry}.
    """
    agent_key = _resolve_agent_key(inputs)

    # Route outline to correct sub-agent
    if agent_key == "outline":
        intent = classify_intent(query)
        if intent == "commit":
            from engine.outline import COMMIT_SYSTEM_PROMPT as prompt, COMMIT_TOOLS as tools
            config = AgentConfig.from_env(
                agent_key="outline_commit",
                system_prompt=prompt,
                max_iterations=45,
                thinking=True,
            )
            agent = LoreAgent(config=config, tools=tools)
        else:
            agent = _create_agent("outline")
    else:
        agent = _create_agent(agent_key)

    task_id = ""
    with _agents_lock:
        task_id = agent.task_id or ""
        if task_id:
            _running_agents[task_id] = agent

    try:
        for engine_event in agent.run_stream(query, inputs):
            sse_event = _engine_to_sse(engine_event, conversation_id, task_id)
            yield sse_event
    finally:
        with _agents_lock:
            if task_id:
                _running_agents.pop(task_id, None)


def stop_chat_message(
    *,
    base_url: str = "",
    api_key: str = "",
    task_id: str = "",
    user: str = "loregit",
    timeout_seconds: int = 30,
) -> dict[str, Any]:
    """Cancel a running generation — same signature as dify_client.stop_chat_message()."""
    with _agents_lock:
        agent = _running_agents.get(task_id)
    if agent:
        agent.cancel()
        return {"result": "success"}
    return {"result": "not_found"}


def _engine_to_sse(engine_event: dict, conversation_id: str | None, task_id: str) -> dict:
    """Convert engine stream event to Dify-compatible SSE event format."""
    event_name = engine_event.get("event", "message")
    data = engine_event.get("data", {})

    # Map engine events to Dify SSE event shapes
    if event_name == "delta":
        return {
            "event": "message",
            "data": {
                "event": "message",
                "answer": data.get("text", ""),
                "conversation_id": conversation_id or "",
                "task_id": task_id,
            },
            "id": "",
            "retry": 0,
        }
    elif event_name == "stage":
        return {
            "event": "workflow",
            "data": {
                "event": _map_stage_to_dify(data.get("stage", "")),
                "data": data,
                "conversation_id": conversation_id or "",
                "task_id": task_id,
            },
            "id": "",
            "retry": 0,
        }
    elif event_name == "done":
        return {
            "event": "message_end",
            "data": {
                "event": "message_end",
                "answer": data.get("answer", ""),
                "conversation_id": conversation_id or "",
                "task_id": task_id,
            },
            "id": "",
            "retry": 0,
        }
    elif event_name == "error":
        return {
            "event": "error",
            "data": {
                "event": "error",
                "code": data.get("code", "UNKNOWN"),
                "message": data.get("message", ""),
                "conversation_id": conversation_id or "",
                "task_id": task_id,
            },
            "id": "",
            "retry": 0,
        }
    elif event_name == "ack":
        return {
            "event": "message",
            "data": {
                "event": "message",
                "answer": "",
                "conversation_id": conversation_id or "",
                "task_id": data.get("task_id", task_id),
            },
            "id": "",
            "retry": 0,
        }
    else:
        return {
            "event": event_name,
            "data": {**data, "conversation_id": conversation_id or "", "task_id": task_id},
            "id": "",
            "retry": 0,
        }


def _map_stage_to_dify(stage: str) -> str:
    mapping = {
        "llm_start": "node_started",
        "llm_end": "node_finished",
        "tool_call": "node_started",
        "tool_result": "node_finished",
        "agent_start": "workflow_started",
        "agent_end": "workflow_finished",
    }
    return mapping.get(stage, stage)


def _resolve_agent_key(inputs: dict[str, Any] | None) -> str:
    """Determine which agent to use based on active_file."""
    if not inputs:
        return "continuation_agent"
    active_file = str(inputs.get("active_file", "")).strip()
    file_type = str(inputs.get("file_type", "")).strip()

    if file_type == "outline" or active_file in (
        "brainstorm.md", "master_outline.md", "arc_outline.md", "chapter_outline.md"
    ):
        return "outline"
    if file_type == "style" or active_file in (
        "style_guide.md", "style_fingerprint.md", "style_review.md",
        "style_constraints_for_continuation.md",
    ):
        return "style_guide"
    if file_type == "world_core" or active_file in ("world_model.md", "status_card.md", "domain_rules.md"):
        return "world_model"
    # default: continuation (chapter_draft.md) and review both use this key from active_file context
    return "continuation_agent"
