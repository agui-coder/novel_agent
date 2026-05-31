from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.prebuilt import create_react_agent

from utils.model_provider import BatchModelConfig, build_batch_model_config, create_chat_model

logger = logging.getLogger(__name__)

# LangGraph streaming events that map to frontend stage events
_STAGE_EVENT_KINDS = {
    "on_chat_model_start": "llm_start",
    "on_chat_model_end": "llm_end",
    "on_tool_start": "tool_call",
    "on_tool_end": "tool_result",
    "on_chain_start": "agent_start",
    "on_chain_end": "agent_end",
}


@dataclass(frozen=True)
class AgentConfig:
    agent_key: str
    system_prompt: str
    model_config: BatchModelConfig | None = None
    max_iterations: int = 10
    extra_llm_kwargs: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_env(
        cls,
        *,
        agent_key: str,
        system_prompt: str,
        max_iterations: int = 10,
        thinking: bool = False,
        reasoning_effort: str | None = None,
    ) -> AgentConfig:
        config = build_batch_model_config()
        extra: dict[str, Any] = {}
        if thinking:
            extra["model_kwargs"] = {"thinking": True}
            if reasoning_effort:
                extra["model_kwargs"]["reasoning_effort"] = reasoning_effort
        return cls(
            agent_key=agent_key,
            system_prompt=system_prompt,
            model_config=config,
            max_iterations=max_iterations,
            extra_llm_kwargs=extra,
        )


class LoreAgent:
    """Agent using LangGraph ReAct pattern — equivalent to Dify's FunctionCalling strategy."""

    def __init__(
        self,
        *,
        config: AgentConfig,
        tools: list[Callable],
        cancel_event: threading.Event | None = None,
    ):
        self._config = config
        self._tools = tools
        self._cancel_event = cancel_event or threading.Event()
        self._llm = None
        self._graph = None
        self._task_id: str | None = None

    def _ensure_graph(self):
        if self._graph is None:
            self._llm = self._build_llm()
            self._graph = create_react_agent(
                model=self._llm,
                tools=self._tools,
                prompt=self._config.system_prompt,
            )

    @property
    def agent_key(self) -> str:
        return self._config.agent_key

    @property
    def task_id(self) -> str | None:
        return self._task_id

    def cancel(self) -> None:
        self._cancel_event.set()

    def _build_llm(self):
        if self._config.model_config:
            mc = self._config.model_config
            return create_chat_model(max_tokens=8192).bind_tools(self._tools)
        return create_chat_model(max_tokens=8192).bind_tools(self._tools)

    def run(self, query: str, inputs: dict[str, Any] | None = None) -> dict[str, Any]:
        """Blocking mode — returns {"answer": str, "conversation_id": str|None}."""
        self._ensure_graph()
        user_message = self._build_user_message(query, inputs)
        messages = [SystemMessage(content=self._config.system_prompt), user_message]

        config = {"recursion_limit": self._config.max_iterations * 2 + 4}
        result = self._graph.invoke({"messages": messages}, config=config)
        answer = self._extract_final_answer(result)
        return {"answer": answer, "conversation_id": None}

    def run_stream(self, query: str, inputs: dict[str, Any] | None = None) -> Iterator[dict[str, Any]]:
        """Streaming mode — yields SSE-compatible events: {event, data, ...}."""
        self._ensure_graph()
        import uuid

        self._task_id = uuid.uuid4().hex[:12]
        user_message = self._build_user_message(query, inputs)

        yield {"event": "ack", "data": {"task_id": self._task_id, "status": "started"}}

        config = {"recursion_limit": self._config.max_iterations * 2 + 4}
        last_answer = ""

        async def _collect():
            chunks = []
            async for chunk in self._graph.astream_events(
                {"messages": [SystemMessage(content=self._config.system_prompt), user_message]},
                config=config,
                version="v2",
            ):
                if self._cancel_event.is_set():
                    break
                chunks.append(chunk)
            return chunks

        try:
            chunks = asyncio.run(_collect())
        except Exception as exc:
            logger.exception("Agent streaming error")
            yield {"event": "error", "data": {"code": "AGENT_ERROR", "message": str(exc)}}
            return

        for chunk in chunks:
            event_kind = chunk.get("event", "")
            stage_event = self._build_stage_event(chunk, event_kind)
            if stage_event:
                yield stage_event

            if event_kind == "on_chat_model_stream":
                delta = self._extract_stream_delta(chunk)
                if delta:
                    last_answer += delta
                    yield {"event": "delta", "data": {"text": delta}}

        yield {
            "event": "done",
            "data": {
                "answer": last_answer or self._extract_answer_from_state({}),
                "task_id": self._task_id,
                "conversation_id": None,
            },
        }

    def _build_stage_event(self, chunk: dict, event_kind: str) -> dict | None:
        stage_name = _STAGE_EVENT_KINDS.get(event_kind)
        if not stage_name:
            return None

        data = chunk.get("data", {})
        node_id = data.get("name") or chunk.get("name", "")
        node_title = node_id or stage_name

        if event_kind == "on_tool_start":
            tool_input = data.get("input", {})
            node_title = tool_input.get("tool_name") or data.get("name", "tool_call")
        elif event_kind == "on_tool_end":
            node_title = data.get("name", "tool_result")

        return {
            "event": "stage",
            "data": {
                "node_id": node_id,
                "node_title": str(node_title),
                "stage": stage_name,
                "status": "started" if "start" in event_kind else "finished",
            },
        }

    def _extract_stream_delta(self, chunk: dict) -> str | None:
        data = chunk.get("data", {})
        chunk_content = data.get("chunk")
        if chunk_content is None:
            return None
        if hasattr(chunk_content, "content"):
            content = chunk_content.content
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "".join(str(c) for c in content if isinstance(c, str))
        return str(chunk_content) if chunk_content else None

    def _extract_final_answer(self, result: dict) -> str:
        messages = result.get("messages", [])
        for msg in reversed(messages):
            if hasattr(msg, "content") and isinstance(msg.content, str) and msg.content.strip():
                if getattr(msg, "type", "") == "ai" and not getattr(msg, "tool_calls", None):
                    return msg.content
        return ""

    def _extract_answer_from_state(self, chunk: dict) -> str:
        return ""

    def _build_user_message(self, query: str, inputs: dict[str, Any] | None) -> HumanMessage:
        if inputs:
            parts = [f"用户请求：{query}"]
            for key, value in inputs.items():
                if value:
                    parts.append(f"{key}：{value}")
            return HumanMessage(content="\n".join(parts))
        return HumanMessage(content=query)


def build_agent_registry(
    agents: dict[str, tuple[type[LoreAgent], AgentConfig, list[Callable]]],
) -> dict[str, dict]:
    """Build a registry dict compatible with the existing DIFY_AGENT_REGISTRY shape."""
    registry = {}
    for key, (agent_cls, config, tools) in agents.items():
        registry[key] = {
            "agent_cls": agent_cls,
            "config": config,
            "tools": tools,
        }
    return registry
