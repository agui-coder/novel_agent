"""Tests for the engine module — Agent base class, tools, and adapter."""
import os
import sys
import threading
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("DEEPSEEK_API_KEY", "test-dummy-key-for-tests")


class TestAgentConfig(unittest.TestCase):
    def test_from_env_basic(self):
        from engine.base import AgentConfig

        config = AgentConfig.from_env(
            agent_key="test_agent",
            system_prompt="You are a test agent.",
            max_iterations=5,
            thinking=False,
        )
        self.assertEqual(config.agent_key, "test_agent")
        self.assertEqual(config.max_iterations, 5)
        self.assertIn("test agent", config.system_prompt.lower())

    def test_from_env_with_thinking(self):
        from engine.base import AgentConfig

        config = AgentConfig.from_env(
            agent_key="thinking_agent",
            system_prompt="Think carefully.",
            thinking=True,
            reasoning_effort="high",
        )
        self.assertEqual(config.agent_key, "thinking_agent")
        self.assertTrue(config.extra_llm_kwargs.get("model_kwargs", {}).get("thinking"))


class TestLoreAgent(unittest.TestCase):
    def setUp(self):
        self.cancel_event = threading.Event()

    def _fake_llm(self, _prompt=None):
        fake = MagicMock()
        fake.invoke.return_value = MagicMock(content="Test response", type="ai", tool_calls=None)
        fake.bind_tools.return_value = fake
        return fake

    def test_agent_creation(self):
        from engine.base import AgentConfig, LoreAgent

        config = AgentConfig.from_env(
            agent_key="test",
            system_prompt="Test prompt.",
            max_iterations=3,
        )
        agent = LoreAgent(config=config, tools=[], cancel_event=self.cancel_event)
        self.assertEqual(agent.agent_key, "test")
        self.assertIsNone(agent.task_id)

    def test_agent_cancel(self):
        from engine.base import AgentConfig, LoreAgent

        config = AgentConfig.from_env(
            agent_key="test",
            system_prompt="Test prompt.",
        )
        agent = LoreAgent(config=config, tools=[], cancel_event=self.cancel_event)
        agent.cancel()
        self.assertTrue(self.cancel_event.is_set())

    def test_run_returns_dict(self):
        from engine.base import AgentConfig, LoreAgent

        config = AgentConfig.from_env(
            agent_key="test",
            system_prompt="Reply with exactly: OK",
            max_iterations=1,
        )
        agent = LoreAgent(config=config, tools=[])
        agent._graph = MagicMock()
        agent._graph.invoke.return_value = {
            "messages": [
                MagicMock(content="OK", type="ai", tool_calls=None),
            ]
        }
        result = agent.run("Hello", {"book_id": "test_123"})
        self.assertIsInstance(result, dict)
        self.assertIn("answer", result)
        self.assertEqual(result["answer"], "OK")


class TestIntentClassification(unittest.TestCase):
    @patch("utils.model_provider.create_chat_model")
    def test_classify_discuss(self, mock_create):
        fake_llm = MagicMock()
        fake_llm.invoke.return_value = MagicMock(content="discuss")
        mock_create.return_value = fake_llm

        from engine.outline import classify_intent
        result = classify_intent("测试")
        self.assertEqual(result, "discuss")

    @patch("utils.model_provider.create_chat_model")
    def test_classify_commit(self, mock_create):
        fake_llm = MagicMock()
        fake_llm.invoke.return_value = MagicMock(content="commit")
        mock_create.return_value = fake_llm

        from engine.outline import classify_intent
        result = classify_intent("测试")
        self.assertEqual(result, "commit")


class TestAdapter(unittest.TestCase):
    def test_resolve_agent_key_continuation(self):
        from engine.adapter import _resolve_agent_key

        key = _resolve_agent_key({"active_file": "chapter_draft.md"})
        self.assertEqual(key, "continuation_agent")

    def test_resolve_agent_key_outline(self):
        from engine.adapter import _resolve_agent_key

        key = _resolve_agent_key({"active_file": "chapter_outline.md"})
        self.assertEqual(key, "outline")

    def test_resolve_agent_key_world(self):
        from engine.adapter import _resolve_agent_key

        key = _resolve_agent_key({"active_file": "world_model.md"})
        self.assertEqual(key, "world_model")

    def test_engine_error(self):
        from engine.adapter import EngineError

        exc = EngineError("test error", status_code=502, response_body="bad gateway")
        self.assertEqual(exc.status_code, 502)
        self.assertEqual(exc.response_body, "bad gateway")
        self.assertIsInstance(exc, RuntimeError)


class TestToolImports(unittest.TestCase):
    def test_all_tools_importable(self):
        from engine.tools import (
            get_markdown_outline,
            get_markdown_section,
            get_archive_range,
            get_core_archive,
            extract_chapter_highlights,
            draft_append_markdown_section,
            draft_replace_markdown_section,
            validate_chapter_lengths,
            generate_style_diagnostics_tool,
        )
        # @tool-decorated functions are StructuredTool instances, all have .invoke
        for tool in [
            get_markdown_outline, get_markdown_section, get_archive_range,
            get_core_archive, extract_chapter_highlights,
            draft_append_markdown_section, draft_replace_markdown_section,
            validate_chapter_lengths, generate_style_diagnostics_tool,
        ]:
            self.assertTrue(
                callable(tool) or hasattr(tool, "invoke"),
                f"{tool} should be callable or have invoke",
            )


if __name__ == "__main__":
    unittest.main()
