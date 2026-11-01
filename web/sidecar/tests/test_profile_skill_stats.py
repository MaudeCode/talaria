"""TAL-1578: profile skill counts reuse one walk per home until the freshness window or a Talaria write ends it."""

from __future__ import annotations

import json
import re
import shutil
import sys
import threading
import time
import types
from collections import OrderedDict
from contextlib import nullcontext
from importlib.machinery import ModuleSpec
from pathlib import Path

import pytest

from talaria_sidecar.methods import agent_imports, config, profiles, write_approval


class _Registry:
    def __init__(self) -> None:
        self.methods: dict = {}

    def method(self, name: str, *, requires_agent: bool = True):
        def wrap(fn):
            self.methods[name] = fn
            return fn
        return wrap


def _methods() -> dict:
    registry = _Registry()
    for module in (profiles, config, write_approval, agent_imports):
        module.register(registry)
    return registry.methods


class _Agent:
    """Deterministic stand-ins for the Agent's skill parser, platform filter and profile helpers, with I/O counters."""

    def __init__(self) -> None:
        self.walks: list[Path] = []
        self.reads = 0
        self.parses = 0
        self.gate: threading.Event | None = None
        self.entered = threading.Event()
        self.fail_next = False

    def iter_skill_index_files(self, root: Path, filename: str):
        self.walks.append(Path(root))
        if self.fail_next:
            self.fail_next = False
            raise OSError("synthetic walk failure")
        files = sorted(Path(root).rglob(filename))
        self.entered.set()
        gate, self.gate = self.gate, None  # only the first walk is held
        if gate is not None:
            assert gate.wait(5), "walk gate never opened"
        yield from files

    def parse_frontmatter(self, text: str):
        self.parses += 1
        if not text.startswith("---\n") or "\n---" not in text[4:]:
            raise ValueError("malformed frontmatter")
        head = text[4:].split("\n---", 1)[0]
        return dict(line.split(": ", 1) for line in head.splitlines() if ": " in line), text

    @staticmethod
    def skill_matches_platform(frontmatter: dict) -> bool:
        return frontmatter.get("platforms") in (None, "synthetic")


@pytest.fixture
def agent(monkeypatch: pytest.MonkeyPatch) -> _Agent:
    fake = _Agent()
    utils = types.ModuleType("agent.skill_utils")
    utils.iter_skill_index_files = fake.iter_skill_index_files
    utils.parse_frontmatter = fake.parse_frontmatter
    utils.skill_matches_platform = fake.skill_matches_platform
    utils.parse_config_string_list = lambda value: [part.strip() for part in value.split(",")]
    cli = types.ModuleType("hermes_cli.profiles")
    cli._read_config_model = lambda home: (None, None)
    cli._PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
    yaml = types.ModuleType("hermes_yaml")
    yaml.safe_load = json.loads  # the synthetic config.yaml files are JSON, which is YAML
    for name, module in (("agent", types.ModuleType("agent")), ("agent.skill_utils", utils), ("hermes_cli", types.ModuleType("hermes_cli")),
                         ("hermes_cli.profiles", cli), ("hermes_yaml", yaml)):
        module.__spec__ = ModuleSpec(name, None)
        monkeypatch.setitem(sys.modules, name, module)
    real_read = Path.read_text

    def read_text(path: Path, *args, **kwargs):
        if path.name == "SKILL.md":
            fake.reads += 1
        return real_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    # Each test starts with an empty cache.
    monkeypatch.setattr(profiles, "_stats", OrderedDict(), raising=False)
    monkeypatch.setattr(profiles, "_stats_flights", {}, raising=False)
    return fake


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    now = [1000.0]
    monkeypatch.setattr(profiles, "_stats_clock", lambda: now[0])
    return now


def _skill(home: Path, name: str, body: str | None = None) -> Path:
    folder = home / "skills" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(body if body is not None else f"---\nname: {name}\n---\n# {name}\n", encoding="utf-8")
    return folder


def _skills(home: Path, count: int) -> None:
    for index in range(count):
        _skill(home, f"skill-{index:02d}")


def _disable(home: Path, *names: str) -> None:
    (home / "config.yaml").write_text(json.dumps({"skills": {"disabled": list(names)}}), encoding="utf-8")


def _stats(methods: dict, home: Path) -> tuple[int, int]:
    result = methods["profiles.skills_stats"](None, {"profile_home": str(home)})
    return result["enabled"], result["total"]


def _listed(methods: dict, base: Path) -> dict[str, tuple[int, int]]:
    rows = methods["profiles.list"](None, {"base_home": str(base)})["profiles"]
    return {row["name"]: (row["enabled_skills"], row["total_skills"]) for row in rows}


def test_unchanged_warm_reads_skip_the_skill_walk(tmp_path: Path, agent: _Agent) -> None:
    """profiles.list and isolated profiles.skills_stats share one count per home; warm reads walk and parse nothing."""
    methods = _methods()
    base = tmp_path / "hermes"
    _skills(base, 40)
    alpha = base / "profiles" / "alpha"
    _skills(alpha, 3)

    assert _listed(methods, base) == {"default": (40, 40), "alpha": (3, 3)}
    cold = (len(agent.walks), agent.reads, agent.parses)
    assert cold == (2, 43, 43)

    assert _stats(methods, base) == (40, 40)  # isolated mode reads the base home through the same entry
    assert _listed(methods, base) == {"default": (40, 40), "alpha": (3, 3)}
    assert _stats(methods, alpha) == (3, 3)
    assert (len(agent.walks), agent.reads, agent.parses) == cold, "a warm read walked or parsed SKILL.md again"


def test_concurrent_misses_for_one_home_walk_once(tmp_path: Path, agent: _Agent) -> None:
    methods = _methods()
    one, two = tmp_path / "one", tmp_path / "two"
    _skills(one, 4)
    _skills(two, 2)
    gate = agent.gate = threading.Event()
    results: dict[str, list] = {"one": [], "two": []}

    def read(label: str, home: Path) -> None:
        results[label].append(_stats(methods, home))

    first = threading.Thread(target=read, args=("one", one))
    first.start()
    followers = [threading.Thread(target=read, args=("one", one)) for _ in range(3)]
    try:
        assert agent.entered.wait(5)
        flight = profiles._stats_flights[str(one.resolve())]
        for thread in followers:
            thread.start()
        deadline = time.monotonic() + 5
        while len(flight._cond._waiters) < 3:  # every follower is parked on the leader's walk
            assert time.monotonic() < deadline, "followers never waited on the in-flight walk"
            time.sleep(0.001)
    finally:
        gate.set()
        for thread in (first, *followers):
            if thread.is_alive():
                thread.join(5)
    read("two", two)

    assert results == {"one": [(4, 4)] * 4, "two": [(2, 2)]}
    assert agent.walks == [one / "skills", two / "skills"]
    assert profiles._stats_flights == {}


def test_a_failed_walk_releases_its_flight(tmp_path: Path, agent: _Agent) -> None:
    methods = _methods()
    _skills(tmp_path, 2)
    agent.fail_next = True
    with pytest.raises(OSError):
        _stats(methods, tmp_path)
    assert profiles._stats_flights == {} and profiles._stats == {}
    assert _stats(methods, tmp_path) == (2, 2)


def test_out_of_band_edits_appear_after_the_freshness_window(tmp_path: Path, agent: _Agent, clock: list[float]) -> None:
    methods = _methods()
    _skills(tmp_path, 2)
    assert _stats(methods, tmp_path) == (2, 2)

    _skill(tmp_path, "created")
    clock[0] += 29.9
    assert _stats(methods, tmp_path) == (2, 2)
    clock[0] += 0.1
    assert _stats(methods, tmp_path) == (3, 3)

    _skill(tmp_path, "skill-00", "---\nname: skill-00\nplatforms: elsewhere\n---\n")  # edited out of this platform
    _disable(tmp_path, "created")
    assert _stats(methods, tmp_path) == (3, 3)
    clock[0] += 30
    assert _stats(methods, tmp_path) == (1, 2)

    (tmp_path / "skills" / "created" / "SKILL.md").unlink()
    (tmp_path / "config.yaml").unlink()
    assert _stats(methods, tmp_path) == (1, 2)
    clock[0] += 30
    assert _stats(methods, tmp_path) == (1, 1)
    assert len(agent.walks) == 4


def test_counts_keep_the_uncached_semantics(tmp_path: Path, agent: _Agent) -> None:
    """Disabled skills, malformed files, other platforms and duplicate names count exactly as the direct walk does."""
    methods = _methods()
    _skills(tmp_path, 3)
    _skill(tmp_path, "broken", "no frontmatter")
    _skill(tmp_path, "mac-only", "---\nname: mac-only\nplatforms: elsewhere\n---\n")
    _skill(tmp_path, "copy", "---\nname: skill-00\n---\n")
    _disable(tmp_path, "skill-01")
    direct = profiles.skills_stats(tmp_path)
    assert direct == (2, 3)
    assert _stats(methods, tmp_path) == direct


@pytest.mark.parametrize("mutation", ["skills_stats_invalidate", "config.set", "write_approval.approve", "profiles.import"])
def test_talaria_writes_invalidate_immediately(tmp_path: Path, agent: _Agent, clock: list[float], monkeypatch: pytest.MonkeyPatch, mutation: str) -> None:
    methods = _methods()
    _skills(tmp_path, 2)
    assert _stats(methods, tmp_path) == (2, 2)
    home = {"profile_home": str(tmp_path)}
    if mutation == "skills_stats_invalidate":  # the server's skill save and delete
        _skill(tmp_path, "saved")
        methods["profiles.skills_stats_invalidate"](None, home)
        expected = (3, 3)
    elif mutation == "config.set":  # the server's skill toggle
        def write(path: Path, value: dict, *, profile_home: Path | None = None) -> dict:
            path.write_text(json.dumps(value), encoding="utf-8")
            return {"ok": True, "path": str(path)}

        monkeypatch.setattr(config, "write_config", write)
        methods["config.set"](None, {**home, "config": {"skills": {"disabled": ["skill-00"]}}})
        expected = (1, 2)
    elif mutation == "write_approval.approve":
        monkeypatch.setattr(write_approval, "scoped_home", lambda home: nullcontext())
        monkeypatch.setattr(write_approval, "review", lambda kind, verb, writes: _skill(tmp_path, "approved") and {"results": []})
        methods["write_approval.approve"](None, {**home, "kind": "skills", "writes": []})
        expected = (3, 3)
    else:
        monkeypatch.setattr(agent_imports, "run", lambda ctx, params: _skill(tmp_path, "imported") and {"state": "applied"})
        methods["profiles.import"](None, {**home, "action": "apply", "receipt": "synthetic"})
        expected = (3, 3)
    assert _stats(methods, tmp_path) == expected
    assert len(agent.walks) == 2


def test_memory_approvals_and_import_previews_keep_the_count(tmp_path: Path, agent: _Agent, clock: list[float], monkeypatch: pytest.MonkeyPatch) -> None:
    methods = _methods()
    _skills(tmp_path, 1)
    assert _stats(methods, tmp_path) == (1, 1)
    monkeypatch.setattr(write_approval, "scoped_home", lambda home: nullcontext())
    monkeypatch.setattr(write_approval, "review", lambda kind, verb, writes: {"results": []})
    monkeypatch.setattr(agent_imports, "run", lambda ctx, params: {"state": "preview"})
    methods["write_approval.approve"](None, {"profile_home": str(tmp_path), "kind": "memory", "writes": []})
    methods["write_approval.reject"](None, {"profile_home": str(tmp_path), "kind": "skills", "writes": []})
    methods["profiles.import"](None, {"profile_home": str(tmp_path), "action": "preview", "agent": "codex"})
    assert _stats(methods, tmp_path) == (1, 1)
    assert len(agent.walks) == 1


def test_an_invalidated_walk_never_publishes(tmp_path: Path, agent: _Agent, monkeypatch: pytest.MonkeyPatch) -> None:
    """A walk held across profile deletion and recreation returns to its caller but is not cached for the new profile."""
    methods = _methods()
    chat = types.ModuleType("talaria_sidecar.methods.chat")
    chat.release_profile_agents = lambda home: nullcontext()
    chat.forget_profile_hooks = lambda home: None
    monkeypatch.setitem(sys.modules, "talaria_sidecar.methods.chat", chat)
    # The Agent's lifecycle helpers are replaced; the handlers' cache invalidation is what runs for real.
    monkeypatch.setattr(profiles, "delete_profile", lambda base, name: shutil.rmtree(base / "profiles" / name))
    monkeypatch.setattr(profiles, "create_profile", lambda base, name, **kw: (base / "profiles" / name).mkdir() or base / "profiles" / name)
    base = tmp_path / "hermes"
    old = base / "profiles" / "alpha"
    _skills(old, 5)
    gate = agent.gate = threading.Event()
    held: list = []
    walker = threading.Thread(target=lambda: held.append(_stats(methods, old)))
    walker.start()
    try:
        assert agent.entered.wait(5)
        methods["profiles.delete"](None, {"base_home": str(base), "name": "alpha"})
        assert not old.exists()
        assert profiles._stats_flights == {}
        methods["profiles.create"](None, {"base_home": str(base), "name": "alpha"})
        _skill(old, "fresh")
        methods["profiles.skills_stats_invalidate"](None, {"profile_home": str(old)})  # the server's skill save
    finally:
        gate.set()
        walker.join(5)

    assert held == [(0, 0)]  # the held walk listed the deleted files; that answer stays with its caller
    walks = len(agent.walks)
    assert _stats(methods, old) == (1, 1)
    assert len(agent.walks) == walks + 1


def test_the_cache_is_bounded(tmp_path: Path, agent: _Agent, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(profiles, "_STATS_MAX", 2)
    methods = _methods()
    homes = [tmp_path / name for name in ("a", "b", "c")]
    for index, home in enumerate(homes):
        _skills(home, index + 1)
        assert _stats(methods, home) == (index + 1, index + 1)
    assert list(profiles._stats) == [str(homes[1].resolve()), str(homes[2].resolve())]
    assert _stats(methods, homes[0]) == (1, 1)
    assert len(agent.walks) == 4
