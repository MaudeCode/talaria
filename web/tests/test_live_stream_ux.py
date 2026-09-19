from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUN_JOURNAL_PY = (ROOT / "api" / "run_journal.py").read_text(encoding="utf-8")

def test_stale_interrupted_event_marks_recovery_control():
    assert "\"recovery_control\": True" in RUN_JOURNAL_PY
