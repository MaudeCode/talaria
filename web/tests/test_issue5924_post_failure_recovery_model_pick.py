"""Regression coverage for #5924 — post-failure recovery must honor a fresh pick.

After a provider failure the reporter (@b3nw) could not switch models: changing
the model in the selector and then **edit-resubmit** or **/retry** re-sent the
*failed* model, forcing a session fork to escape.

Root cause (Facet 1 + Facet 4): the onchange explicit-pick marker
(``_rememberPendingSessionModel``) is single-shot — ``send()`` consumes it once
(``messages.js``). The two recovery paths (``submitEdit`` in ``ui.js`` and
``cmdRetry`` in ``commands.js``) truncate and call ``send()`` directly WITHOUT
re-arming the marker, so ``explicit_model_pick`` goes out ``false`` and the
server's ``_resolve_compatible_session_model_state`` re-reverts a freshly-picked
cross-family model back to the profile default.

Two-layer invariant pinned here:
  * WebUI: both recovery paths re-arm the pending explicit-pick marker from the
    CURRENT selector state *before* ``await send()`` (so a recovery send —
    including a SECOND consecutive one — carries ``explicit_model_pick:true``).
  * Server: with ``explicit_model_pick=True`` the fresh cross-family pick is
    honored (NOT reverted), and without it the stale value is still normalized
    (the #3737/#5731 repair path must not regress).
"""

from pathlib import Path

import api.routes as routes

ROOT = Path(__file__).resolve().parents[1]
def _function_body(src: str, name: str) -> str:
    # Match either "async function NAME" or plain "function NAME".
    start = src.find(f"async function {name}")
    if start == -1:
        start = src.find(f"function {name}")
    if start == -1:
        raise AssertionError(f"function {name!r} not found")
    brace = src.index("{", start)
    depth = 0
    for i in range(brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
    raise AssertionError(f"function {name!r} body not found")


# ── WebUI layer: recovery paths re-arm the marker before send() ──────────────


# ── Server layer: explicit pick is honored; repair path preserved (#3737) ────


def test_explicit_pick_honors_fresh_cross_family_model_on_recovery():
    """The freshly-picked cross-family model survives when explicit_model_pick=True.

    This is the value the re-armed marker carries into /api/chat/start on the
    recovery send. It must NOT be reverted to the failed/profile-default model.
    """
    effective, provider, changed = routes._resolve_compatible_session_model_state(
        "gpt-5.4-mini",  # freshly picked, cross-family vs anthropic profile
        None,
        profile_provider="anthropic",
        profile_default_model="claude-sonnet-4",
        explicit_model_pick=True,
    )
    assert changed is False, "an explicit recovery pick must not be reverted"
    assert effective == "gpt-5.4-mini", "the freshly-picked model must survive"
    assert provider == "anthropic"


def test_second_consecutive_recovery_send_still_honors_pick():
    """A SECOND consecutive recovery send re-arms the marker, so it stays explicit.

    send() consumes the marker each time, but both recovery paths re-arm it from
    the current selector state on every invocation — so two retries/edits in a
    row both carry explicit_model_pick=True and both honor the pick.
    """
    for _ in range(2):
        effective, provider, changed = routes._resolve_compatible_session_model_state(
            "gpt-5.4-mini",
            None,
            profile_provider="anthropic",
            profile_default_model="claude-sonnet-4",
            explicit_model_pick=True,
        )
        assert changed is False
        assert effective == "gpt-5.4-mini"
        assert provider == "anthropic"


def test_non_explicit_send_still_normalizes_stale_model():
    """Guard against regressing the #3737/#5731 repair path.

    Without an explicit pick (the normal 2nd+-turn continuation), a stale
    cross-family model is still normalized to the profile default. The #5924 fix
    only re-arms on the recovery entry points, so this path is unchanged.
    """
    effective, provider, changed = routes._resolve_compatible_session_model_state(
        "gpt-5.4-mini",
        None,
        profile_provider="anthropic",
        profile_default_model="claude-sonnet-4",
        explicit_model_pick=False,
    )
    assert changed is True, "stale model must still be normalized on a plain send"
    assert effective == "claude-sonnet-4"
    assert provider == "anthropic"


# ── #5924 gate re-fixes: gated re-arm + session-race guards ──────────────────
