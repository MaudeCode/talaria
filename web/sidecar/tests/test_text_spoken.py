"""``text.spoken`` (TAL-906): the Agent's read-aloud script, or the text as written on an Agent without one.

The real Agent's answers are recorded through ``scenarios.py``; this covers an Agent that lacks the normalizer.
"""

from __future__ import annotations

import sys
import types

from talaria_sidecar.methods.text import spoken


def test_an_agent_without_the_normalizer_speaks_the_text_as_written(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.tts_text_normalize", types.ModuleType("tools.tts_text_normalize"))
    assert spoken("Saved notes.md to /tmp/out.") == {"spoken_text": "Saved notes.md to /tmp/out."}
