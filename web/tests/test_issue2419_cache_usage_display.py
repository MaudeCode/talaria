from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_webui_backend_prompt_cache_hit_percent_uses_prompt_total_denominator():
    from api.usage import prompt_cache_hit_percent

    assert prompt_cache_hit_percent(100_000, 125_000) == 80
    assert prompt_cache_hit_percent(0, 125_000) is None
    assert prompt_cache_hit_percent(100, 0) is None
    assert prompt_cache_hit_percent(None, None) is None
    assert prompt_cache_hit_percent(200, 100) == 100


def test_session_compact_exposes_prompt_cache_counters():
    from api.models import Session

    session = Session(
        session_id="issue2419_cache_usage",
        workspace="/tmp",
        input_tokens=125_000,
        output_tokens=5_000,
        estimated_cost=0.44,
        cache_read_tokens=100_000,
        cache_write_tokens=5_000,
    )

    compact = session.compact()

    assert compact["cache_read_tokens"] == 100_000
    assert compact["cache_write_tokens"] == 5_000
    assert compact["cache_hit_percent"] == 80


def test_streaming_usage_payload_includes_prompt_cache_counters():
    src = (ROOT / "api" / "streaming.py").read_text()

    assert "session_cache_read_tokens" in src
    assert "session_cache_write_tokens" in src
    assert "prompt_cache_hit_percent(" in src
    assert "'cache_hit_percent':" in src
    assert "'turn_cache_hit_percent':" in src
