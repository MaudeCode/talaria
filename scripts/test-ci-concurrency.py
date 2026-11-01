#!/usr/bin/env python3
"""CI's concurrency policy, evaluated from the real ci.yml against synthetic event contexts (TAL-1656).

Only initial pull_request attempts share the per-PR group, so a newer head cancels superseded work. A retry of an
older head, a push or a manual run gets its own run-scoped group and cannot cancel the latest head's checks."""

import importlib.util
import math
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("hosted", Path(__file__).with_name("check-hosted-runners.py"))
hosted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosted)

TOKEN = re.compile(r"\s*(?:('(?:[^']|'')*')|(\d+)|(==|!=|&&|\|\||[!(),])|([A-Za-z_][\w.-]*))")


def number(value):
    if value is None or isinstance(value, (bool, int, float)):
        return int(value or 0) if not isinstance(value, float) else value
    try:
        return float(value) if value.strip() else 0
    except ValueError:
        return math.nan


def equal(left, right):
    """GitHub's loose equality: mismatched types compare as numbers; strings ignore case."""
    if isinstance(left, str) and isinstance(right, str):
        return left.lower() == right.lower()
    return number(left) == number(right)


def text(value):
    return "" if value is None else str(value).lower() if isinstance(value, bool) else str(value)


def evaluate(expression, context):
    """The subset of GitHub's expression syntax ci.yml's concurrency uses."""
    tokens, position = [], 0
    while position < len(expression.rstrip()):
        match = TOKEN.match(expression, position)
        if not match:
            raise ValueError(f"cannot parse {expression[position:]!r}")
        tokens.append(match.groups())
        position = match.end()
    tokens.append((None, None, None, None))
    index = 0

    def take(operator=None):
        nonlocal index
        token = tokens[index]
        if operator is not None and token[2] != operator:
            raise ValueError(f"expected {operator!r} in {expression!r}")
        index += 1
        return token

    def either():
        value = both()
        while tokens[index][2] == "||":
            take()
            right = both()
            value = value or right
        return value

    def both():
        value = comparison()
        while tokens[index][2] == "&&":
            take()
            right = comparison()
            value = value and right
        return value

    def comparison():
        value = unary()
        while tokens[index][2] in ("==", "!="):
            same = take()[2] == "=="
            value = equal(value, unary()) == same
        return value

    def unary():
        if tokens[index][2] == "!":
            take()
            return not unary()
        if tokens[index][2] == "(":
            take()
            value = either()
            take(")")
            return value
        literal, digits, _, name = take()
        if literal is not None:
            return literal[1:-1].replace("''", "'")
        if digits is not None:
            return int(digits)
        if name in ("true", "false", "null"):
            return {"true": True, "false": False, "null": None}[name]
        if tokens[index][2] == "(":
            take()
            arguments = [either()]
            while tokens[index][2] == ",":
                take()
                arguments.append(either())
            take(")")
            if name != "format":
                raise ValueError(f"unsupported function {name}")
            return re.sub(r"\{(\d+)\}", lambda found: text(arguments[1 + int(found.group(1))]), arguments[0])
        value = context
        for part in name.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        return value

    value = either()
    if tokens[index][2] is not None or tokens[index][3] is not None:
        raise ValueError(f"trailing tokens in {expression!r}")
    return value


def render(value, context):
    """A workflow value: a lone expression keeps its type; otherwise expressions interpolate into the string."""
    if not isinstance(value, str):
        return value
    lone = re.fullmatch(r"\$\{\{(.*?)\}\}", value.strip(), re.S)
    if lone:
        return evaluate(lone.group(1), context)
    return re.sub(r"\$\{\{(.*?)\}\}", lambda found: text(evaluate(found.group(1), context)), value, flags=re.S)


CONCURRENCY = hosted.load(ROOT / ".github/workflows/ci.yml")["concurrency"]


def run(event_name, run_id, sha, attempt=1, pr=None):
    event = {"pull_request": {"number": pr, "head": {"sha": sha}}} if pr is not None else {}
    context = {"github": {"event_name": event_name, "run_id": run_id, "run_attempt": attempt, "sha": sha,
                          "event": event}}
    return render(CONCURRENCY["group"], context), bool(render(CONCURRENCY["cancel-in-progress"], context))


def cancels(newer, running):
    """Whether starting `newer` cancels `running`: same group and the newcomer cancels in-progress work."""
    return newer[0] == running[0] and newer[1]


class ConcurrencyTests(unittest.TestCase):
    def test_retry_of_an_older_head_cannot_cancel_the_latest_head(self):
        for attempt in (2, "2", 3, "3"):
            with self.subTest(attempt=attempt):
                latest = run("pull_request", 200, "b" * 40, attempt=1, pr=42)
                retry = run("pull_request", 100, "a" * 40, attempt=attempt, pr=42)
                self.assertNotEqual(retry[0], latest[0])
                self.assertFalse(cancels(retry, latest))
                self.assertFalse(cancels(latest, retry))

    def test_successive_initial_heads_share_the_group_and_cancel_superseded_work(self):
        for attempt in (1, "1"):
            with self.subTest(attempt=attempt):
                older = run("pull_request", 100, "a" * 40, attempt=attempt, pr=42)
                newer = run("pull_request", 200, "b" * 40, attempt=attempt, pr=42)
                self.assertEqual(newer[0], older[0])
                self.assertTrue(cancels(newer, older))

    def test_runs_outside_one_pull_requests_initial_attempts_are_isolated(self):
        initial = run("pull_request", 100, "a" * 40, pr=42)
        others = [
            run("pull_request", 101, "a" * 40, pr=43),
            run("pull_request", 102, "a" * 40, attempt="2", pr=42),
            run("push", 103, "a" * 40),
            run("push", 104, "a" * 40, attempt=2),
            run("push", 105, "c" * 40),
            run("workflow_dispatch", 106, "a" * 40),
            run("workflow_dispatch", 107, "a" * 40),
        ]
        groups = [initial[0], *(other[0] for other in others)]
        self.assertEqual(len(set(groups)), len(groups), groups)
        for other in others:
            self.assertFalse(cancels(other, initial), other)
            self.assertFalse(cancels(initial, other), other)

    def test_a_retry_keeps_its_own_runs_group(self):
        self.assertEqual(run("push", 103, "a" * 40, attempt=2)[0], run("push", 103, "a" * 40, attempt=3)[0])

    def test_evaluator_follows_github_loose_equality(self):
        context = {"github": {"run_attempt": "1", "n": 7}}
        self.assertTrue(evaluate("github.run_attempt == 1", context))
        self.assertTrue(evaluate("github.run_attempt == '1'", context))
        self.assertFalse(evaluate("github.run_attempt != 1", context))
        self.assertEqual(evaluate("github.missing || format('x-{0}-{1}', github.n, true)", context), "x-7-true")
        self.assertEqual(evaluate("!(github.n == 7) && 'a' || 'b'", context), "b")


if __name__ == "__main__":
    unittest.main()
