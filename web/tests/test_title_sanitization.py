import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from api.streaming import (
    _fallback_title_from_exchange,
    _first_exchange_snippets,
    _latest_exchange_snippets,
    _sanitize_generated_title,
    _title_prompts,
)
from tests._aux_client_helpers import auxiliary_client_modules, patch_tg_config


class TestGeneratedTitleSanitization(unittest.TestCase):
    def test_strips_session_title_markdown_prefix(self):
        self.assertEqual(
            _sanitize_generated_title("**Session Title:** Clarifying Topic for Discussion"),
            "Clarifying Topic for Discussion",
        )

    def test_strips_plain_title_prefix(self):
        self.assertEqual(
            _sanitize_generated_title("Title: Clarifying Topic for Discussion"),
            "Clarifying Topic for Discussion",
        )

    def test_strips_wrapping_markdown_emphasis(self):
        self.assertEqual(
            _sanitize_generated_title("**Clarifying Topic for Discussion**"),
            "Clarifying Topic for Discussion",
        )

    def test_first_exchange_skips_empty_assistant_tool_call_placeholder(self):
        messages = [
            {"role": "user", "content": "What time is it in San Francisco?"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1"}]},
            {"role": "tool", "content": "tool output", "tool_call_id": "call_1"},
            {"role": "assistant", "content": "It is 6:16 PM in San Francisco."},
        ]
        self.assertEqual(
            _first_exchange_snippets(messages),
            ("What time is it in San Francisco?", "It is 6:16 PM in San Francisco."),
        )

    def test_title_context_keeps_two_thousand_characters(self):
        messages = [
            {"role": "user", "content": "u" * 2500},
            {"role": "assistant", "content": "a" * 2500},
        ]

        user_text, assistant_text = _first_exchange_snippets(messages)

        self.assertEqual(len(user_text), 2000)
        self.assertEqual(len(assistant_text), 2000)
        latest_user, latest_assistant = _latest_exchange_snippets(messages)
        self.assertEqual(len(latest_user), 2000)
        self.assertEqual(len(latest_assistant), 2000)

    def test_title_prompt_prioritizes_user_goal_and_omits_empty_assistant_context(self):
        qa, prompts = _title_prompts("Investigate flaky session titles", "")

        self.assertIn("Subject:", prompts[0])
        self.assertIn("Outcome:", prompts[0])
        self.assertIn("Incidental instructions:", prompts[0])
        self.assertIn("Prefer the user's explicit goal", prompts[0])
        self.assertNotIn("Use BOTH", prompts[0])
        self.assertEqual(qa, "User request:\nInvestigate flaky session titles")

    def test_title_prompt_caps_combined_context_with_user_first(self):
        qa, _prompts = _title_prompts("用" * 1500, "答" * 2000)

        self.assertEqual(qa.count("用"), 1500)
        self.assertEqual(qa.count("答"), 500)

    def test_generated_titles_are_capped_at_fifty_characters(self):
        self.assertEqual(
            _sanitize_generated_title("A" * 60),
            "A" * 50,
        )

    def test_assistant_text_is_optional(self):
        from api.streaming import generate_title_raw_via_aux

        response = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="Investigate Session Titles"),
                    finish_reason="stop",
                )
            ]
        )
        captured = {}

        def fake_call_llm(**kwargs):
            captured.update(kwargs)
            return response

        with auxiliary_client_modules(), patch_tg_config(
            {"provider": "", "model": "title-model", "base_url": ""}
        ), patch("agent.auxiliary_client.call_llm", side_effect=fake_call_llm, create=True):
            result, status = generate_title_raw_via_aux(
                user_text="Investigate flaky session titles",
                assistant_text="",
            )

        self.assertEqual(result, "Investigate Session Titles")
        self.assertEqual(status, "llm_aux")
        self.assertEqual(
            captured["messages"][1]["content"],
            "User request:\nInvestigate flaky session titles",
        )

    def test_assistant_text_is_optional_for_active_agent_route(self):
        from api.streaming import generate_title_raw_via_agent

        response = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="Investigate Session Titles"),
                    finish_reason="stop",
                )
            ]
        )
        client = MagicMock()
        client.chat.completions.create.return_value = response
        agent = MagicMock(
            api_mode="openai",
            provider="openai",
            model="title-model",
            base_url="",
            reasoning_config=None,
        )
        agent._build_api_kwargs.return_value = {}
        agent._ensure_primary_openai_client.return_value = client

        result, status = generate_title_raw_via_agent(
            agent,
            user_text="Investigate flaky session titles",
            assistant_text="",
        )

        self.assertEqual(result, "Investigate Session Titles")
        self.assertEqual(status, "llm")
        sent_messages = agent._build_api_kwargs.call_args.args[0]
        self.assertEqual(
            sent_messages[1]["content"],
            "User request:\nInvestigate flaky session titles",
        )

    def test_fallback_title_uses_english_discussion_suffix(self):
        self.assertEqual(
            _fallback_title_from_exchange('Please review "random cancel"', ""),
            "random cancel discussion",
        )

    def test_fallback_title_obeys_generated_title_cap(self):
        self.assertEqual(
            _fallback_title_from_exchange("x" * 80, ""),
            "x" * 50,
        )

    def test_fallback_title_summary_label_is_english(self):
        self.assertEqual(
            _fallback_title_from_exchange("Generate a short title summary test", ""),
            "Session title auto-summary test",
        )

    def test_fallback_title_non_latin_input_uses_english_placeholder(self):
        self.assertEqual(
            _fallback_title_from_exchange("讨论一下这个问题", ""),
            "Conversation topic",
        )

    def test_fallback_title_non_latin_quoted_topic_uses_english_placeholder(self):
        self.assertEqual(
            _fallback_title_from_exchange('Please review "讨论主题"', ""),
            "Conversation topic",
        )

    def test_title_generation_source_has_no_cjk_literals(self):
        src = Path("api/streaming.py").read_text(encoding="utf-8")
        self.assertNotRegex(src, r"[\u4e00-\u9fff]", "title generation code should stay English-only")
