"""
Sprint 20 Tests: Voice input (mic button) via Web Speech API.

These tests verify the static assets contain the correct HTML structure,
CSS rules, and JS logic for the mic feature — all of which runs purely in
the browser with no server-side component.
"""
import re
import urllib.request
import json
import pathlib

from tests._pytest_port import BASE


def get_text(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return r.read().decode(), r.status


# ── index.html ────────────────────────────────────────────────────────────


# ── style.css ────────────────────────────────────────────────────────────


# ── boot.js ──────────────────────────────────────────────────────────────


def test_routes_define_transcribe_endpoint():
    """Server routes must expose /api/transcribe for MediaRecorder fallback uploads."""
    routes = pathlib.Path(__file__).parent.parent.joinpath("api/routes.py").read_text(encoding="utf-8")
    assert '"/api/transcribe"' in routes


def test_routes_define_transcribe_capability_endpoint():
    """Server routes must expose a cheap STT capability probe before defaulting to MediaRecorder."""
    routes = pathlib.Path(__file__).parent.parent.joinpath("api/routes.py").read_text(encoding="utf-8")
    assert '"/api/transcribe/capability"' in routes


# ── Append behaviour (fix: mic appends to existing text, not replace) ────


# ── Regression: existing behaviour unchanged ──────────────────────────────
