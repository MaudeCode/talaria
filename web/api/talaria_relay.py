"""Best-effort publication of live Hermes session state to Talaria Relay."""

from __future__ import annotations

import atexit
import base64
import hashlib
import json
import logging
import os
import queue
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_private_key,
)

logger = logging.getLogger(__name__)
_publisher_lock = threading.RLock()
_publisher_transition_lock = threading.Lock()
_pairing_lock = threading.Lock()

# HWEB-97: profile-scoped browser activity leases. A tab that received trusted
# user input holds a lease for PRESENCE_LEASE_SECONDS after the server saw the
# renewal; while any lease for a profile is fresh, that profile's published
# transitions are stamped alertEligible=false so the phone stays quiet for the
# person already looking at the screen. In-memory and bounded: a restart, an
# evicted lease, or any lookup failure falls back to eligible.
PRESENCE_LEASE_SECONDS = 90
_PRESENCE_MAX_LEASES = 256
_PRESENCE_TAB_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")
_presence_lock = threading.Lock()
# Each entry is [expires_monotonic, last_seq, active]. A revoked lease is kept as
# an inactive tombstone (not deleted) until it would have expired, so a late
# lower-seq renewal that arrives after the revoke is rejected instead of
# resurrecting the lease. Client seq is strictly increasing per tab.
_presence: dict[tuple[str, str], list] = {}
_presence_clock = time.monotonic


def _prune_presence_locked(now: float) -> None:
    for key in [key for key, entry in _presence.items() if entry[0] <= now]:
        del _presence[key]


def _apply_presence_locked(key: tuple[str, str], seq: int, active: bool, now: float) -> None:
    _prune_presence_locked(now)
    current = _presence.get(key)
    if current is not None and seq <= current[1]:
        return  # stale or replayed update; a newer one already won
    _presence.pop(key, None)
    if key not in _presence and len(_presence) >= _PRESENCE_MAX_LEASES:
        # Insertion order is update recency, so evict the least-recent entry.
        del _presence[next(iter(_presence))]
    _presence[key] = [now + PRESENCE_LEASE_SECONDS, seq, active]


def renew_presence(profile: str, tab_id: str, seq: int = 1) -> None:
    now = _presence_clock()
    with _presence_lock:
        _apply_presence_locked((profile, tab_id), seq, True, now)


def revoke_presence(profile: str, tab_id: str, seq: int = 1) -> None:
    now = _presence_clock()
    with _presence_lock:
        _apply_presence_locked((profile, tab_id), seq, False, now)


def profile_has_presence(profile: str) -> bool:
    now = _presence_clock()
    with _presence_lock:
        _prune_presence_locked(now)
        return any(key[0] == profile and entry[2] for key, entry in _presence.items())


def update_presence(body: object, *, profile: str) -> dict[str, bool | int]:
    """Renew or revoke one tab's lease. The server owns every timestamp."""
    if not isinstance(body, dict):
        raise RelayPairingError("Invalid presence request", status=400)
    tab_id = body.get("tab_id")
    active = body.get("active")
    seq = body.get("seq")
    if (
        not isinstance(tab_id, str)
        or not _PRESENCE_TAB_RE.fullmatch(tab_id)
        or not isinstance(active, bool)
        or not isinstance(seq, int)
        or isinstance(seq, bool)
        or not 0 <= seq <= 2 ** 53
    ):
        raise RelayPairingError("Invalid presence request", status=400)
    profile = str(profile or "").strip()
    if not profile:
        raise RelayPairingError("Hermes profile is unavailable", status=403)
    try:
        profile = _canonical_profile(profile)
    except Exception as exc:
        raise RelayPairingError("Hermes profile is unavailable", status=403) from exc
    if active:
        renew_presence(profile, tab_id, seq)
    else:
        revoke_presence(profile, tab_id, seq)
    return {"ok": True, "lease_seconds": PRESENCE_LEASE_SECONDS if active else 0}


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


@dataclass(frozen=True)
class RelayConfig:
    url: str
    publisher_id: str
    key_id: str
    private_key_path: Path
    profiles: dict[str, dict[str, str]] = field(default_factory=lambda: {
        "default": {"identity": "", "profile_id": "prf_default"},
    })

    @staticmethod
    def _validated_origin(value: str, *, https_only: bool = False) -> str:
        value = value.strip().rstrip("/")
        parsed = urllib.parse.urlsplit(value)
        schemes = ("https",) if https_only else ("http", "https")
        if (
            parsed.scheme not in schemes
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            protocol = "HTTPS" if https_only else "HTTP(S)"
            raise ValueError(f"value must be an {protocol} origin")
        return value

    @classmethod
    def from_state(cls) -> "RelayConfig | None":
        path, _ = _state_paths()
        try:
            values = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(values, dict):
                raise ValueError("saved relay configuration is not an object")
            if values.get("version") != 2:
                return None
            profiles = values.get("profiles")
            if not isinstance(profiles, dict) or not profiles:
                raise ValueError("saved relay profiles are invalid")
            normalized_profiles = {}
            for name, profile in profiles.items():
                if (
                    not isinstance(name, str)
                    or not name
                    or not isinstance(profile, dict)
                    or not isinstance(profile.get("identity"), str)
                    or not profile["identity"]
                    or not isinstance(profile.get("profile_id"), str)
                    or not profile["profile_id"]
                ):
                    raise ValueError("saved relay profiles are invalid")
                normalized_profiles[name] = {
                    "identity": profile["identity"],
                    "profile_id": profile["profile_id"],
                }
            return cls(
                url=cls._validated_origin(str(values["url"])),
                publisher_id=cls._validated_origin(str(values["publisher_id"])),
                key_id=str(values["key_id"]),
                private_key_path=Path(str(values["private_key_path"])),
                profiles=normalized_profiles,
            )
        except FileNotFoundError:
            return None


class RelayPairingError(Exception):
    def __init__(self, message: str, *, status: int):
        super().__init__(message)
        self.status = status


def _state_paths() -> tuple[Path, Path]:
    from api.config import STATE_DIR

    state_dir = Path(STATE_DIR)
    return state_dir / "talaria-relay.json", state_dir / "talaria-relay-publisher.pem"


def _canonical_profile(profile: str) -> str:
    from api.profiles import _is_root_profile

    return "default" if _is_root_profile(profile) else profile


def _profile_identity(profile: str) -> str:
    from api.profiles import get_hermes_home_for_profile

    path = get_hermes_home_for_profile(profile) / ".talaria-relay-profile-id"
    try:
        identity = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        from api.paths import _atomic_write_text

        identity = f"pfi_{uuid.uuid4().hex}"
        _atomic_write_text(path, identity + "\n", file_mode=0o600)
    if (
        len(identity) != 36
        or not identity.startswith("pfi_")
        or any(character not in "0123456789abcdef" for character in identity[4:])
    ):
        raise ValueError("invalid Talaria Relay profile identity")
    return identity


def _save_config(config: RelayConfig) -> None:
    from api.paths import _atomic_write_text

    config_path, _ = _state_paths()
    _atomic_write_text(
        config_path,
        json.dumps(
            {
                "version": 2,
                "url": config.url,
                "publisher_id": config.publisher_id,
                "key_id": config.key_id,
                "private_key_path": str(config.private_key_path),
                "profiles": config.profiles,
            },
            indent=2,
            sort_keys=True,
        ) + "\n",
    )


def _signed_request(config: RelayConfig, path: str, body: bytes, *, method: str) -> urllib.request.Request:
    key = TalariaRelayPublisher._load_key(config.private_key_path)
    timestamp = str(int(time.time()))
    nonce = uuid.uuid4().hex
    signed = "\n".join((method, path, timestamp, nonce, _b64url(hashlib.sha256(body).digest())))
    return urllib.request.Request(
        config.url + path,
        data=body,
        method=method,
        headers={
            "Content-Type": "application/json",
            "X-Talaria-Key-Id": config.key_id,
            "X-Talaria-Timestamp": timestamp,
            "X-Talaria-Nonce": nonce,
            "X-Talaria-Signature": _b64url(key.sign(signed.encode("utf-8"))),
        },
    )


def pair_talaria_relay(
    body: object,
    *,
    profile: str = "default",
    operator: bool = True,
    opener=urllib.request.urlopen,
) -> dict[str, str | bool]:
    with _pairing_lock:
        return _pair_talaria_relay_unlocked(
            body,
            profile=profile,
            operator=operator,
            opener=opener,
        )


def _pair_talaria_relay_unlocked(
    body: object,
    *,
    profile: str,
    operator: bool,
    opener,
) -> dict[str, str | bool]:
    if not isinstance(body, dict):
        raise RelayPairingError("Invalid pairing request", status=400)
    relay_url = body.get("relay_url")
    publisher_id = body.get("publisher_id")
    invitation = body.get("publisher_invitation")
    label = body.get("label") or "Hermes WebUI"
    if not all(isinstance(value, str) for value in (relay_url, publisher_id, invitation, label)):
        raise RelayPairingError("Missing relay pairing fields", status=400)
    try:
        relay_url = RelayConfig._validated_origin(relay_url, https_only=True)
        publisher_id = RelayConfig._validated_origin(publisher_id)
    except ValueError as exc:
        raise RelayPairingError(str(exc), status=400) from exc
    allowed_relay_url = os.environ.get(
        "HERMES_WEBUI_TALARIA_RELAY_URL",
        "https://relay.talaria.kil.dev",
    ).strip().rstrip("/")
    if relay_url != allowed_relay_url:
        raise RelayPairingError("Untrusted Talaria Relay origin", status=400)
    if not 1 <= len(invitation) <= 256 or not 1 <= len(label) <= 80:
        raise RelayPairingError("Invalid relay pairing fields", status=400)

    profile = str(profile or "").strip()
    if not profile:
        raise RelayPairingError("Hermes profile is unavailable", status=403)
    try:
        profile = _canonical_profile(profile)
        profile_identity = _profile_identity(profile)
    except (OSError, ValueError) as exc:
        raise RelayPairingError("Hermes profile is unavailable", status=403) from exc
    existing = RelayConfig.from_state()
    if existing is not None:
        if existing.url != relay_url or existing.publisher_id != publisher_id:
            raise RelayPairingError("This Hermes server is registered to a different relay", status=409)
        existing_profile = existing.profiles.get(profile)
        profile_id = (
            existing_profile["profile_id"]
            if existing_profile and existing_profile["identity"] == profile_identity
            else f"prf_{uuid.uuid4().hex}"
        )
        request_body = json.dumps(
            {
                "invitation": invitation,
                "publisherId": publisher_id,
                "profileId": profile_id,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        request = _signed_request(existing, "/v1/pairings/profile/redeem", request_body, method="POST")
        try:
            with opener(request, timeout=10) as response:
                payload = json.loads(response.read())
                if not 200 <= response.status < 300:
                    raise RelayPairingError("Talaria Relay rejected the profile enrollment", status=502)
        except RelayPairingError:
            raise
        except urllib.error.HTTPError as exc:
            status = 409 if 400 <= exc.code < 500 else 502
            raise RelayPairingError(
                f"Talaria Relay rejected the profile enrollment (HTTP {exc.code})",
                status=status,
            ) from exc
        except Exception as exc:
            raise RelayPairingError("Could not reach Talaria Relay", status=502) from exc
        if (
            not isinstance(payload, dict)
            or payload.get("protocolVersion") != 2
            or payload.get("publisherId") != publisher_id
            or payload.get("profileId") != profile_id
        ):
            raise RelayPairingError("Talaria Relay returned an invalid response", status=502)
        config = RelayConfig(
            existing.url,
            existing.publisher_id,
            existing.key_id,
            existing.private_key_path,
            {
                **existing.profiles,
                profile: {"identity": profile_identity, "profile_id": profile_id},
            },
        )
        _save_config(config)
        configure_talaria_relay_publisher(
            config,
            validate_profile_id=profile_id,
            validate_profile_identity=profile_identity,
        )
        return {"ok": True, "publisher_id": publisher_id}

    if not operator:
        raise RelayPairingError(
            "An owner must register this Hermes server with Talaria Relay before profile enrollment",
            status=409,
        )

    key = Ed25519PrivateKey.generate()
    profile_id = f"prf_{uuid.uuid4().hex}"
    request = urllib.request.Request(
        relay_url + "/v1/pairings/publisher/redeem",
        data=json.dumps(
            {
                "invitation": invitation,
                "publisherId": publisher_id,
                "profileId": profile_id,
                "label": label,
                "publicKey": _b64url(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)),
            },
            separators=(",", ":"),
        ).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with opener(request, timeout=10) as response:
            payload = json.loads(response.read())
            if not 200 <= response.status < 300:
                raise RelayPairingError("Talaria Relay rejected the invitation", status=502)
    except RelayPairingError:
        raise
    except urllib.error.HTTPError as exc:
        status = 409 if 400 <= exc.code < 500 else 502
        raise RelayPairingError(
            f"Talaria Relay rejected server registration (HTTP {exc.code})",
            status=status,
        ) from exc
    except Exception as exc:
        raise RelayPairingError("Could not reach Talaria Relay", status=502) from exc
    key_id = payload.get("keyId") if isinstance(payload, dict) else None
    paired_publisher_id = payload.get("publisherId") if isinstance(payload, dict) else None
    paired_profile_id = payload.get("profileId") if isinstance(payload, dict) else None
    profile_id_preserved = payload.get("profileIdPreserved") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or payload.get("protocolVersion") != 2
        or not isinstance(key_id, str)
        or not key_id
        or not isinstance(paired_publisher_id, str)
        or not isinstance(paired_profile_id, str)
        or not paired_profile_id
        or not isinstance(profile_id_preserved, bool)
        or (paired_profile_id != profile_id and not profile_id_preserved)
    ):
        raise RelayPairingError("Talaria Relay returned an invalid response", status=502)
    try:
        publisher_id = RelayConfig._validated_origin(paired_publisher_id)
    except ValueError as exc:
        raise RelayPairingError("Talaria Relay returned an invalid response", status=502) from exc

    config_path, _ = _state_paths()
    key_path = config_path.parent / (
        "talaria-relay-publisher-"
        + hashlib.sha256(key_id.encode("utf-8")).hexdigest()[:16]
        + ".pem"
    )
    config_path.parent.mkdir(parents=True, exist_ok=True)
    from api.paths import _atomic_write_text

    _atomic_write_text(
        key_path,
        key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode("ascii"),
        file_mode=0o600,
    )
    profile_id = paired_profile_id
    config = RelayConfig(
        relay_url,
        publisher_id,
        key_id,
        key_path,
        {profile: {"identity": profile_identity, "profile_id": profile_id}},
    )
    _save_config(config)
    configure_talaria_relay_publisher(
        config,
        validate_profile_id=profile_id,
        validate_profile_identity=profile_identity,
    )
    return {"ok": True, "publisher_id": publisher_id}


class TalariaRelayPublisher:
    """Coalesces state changes into signed complete snapshots."""

    def __init__(self, config: RelayConfig, *, opener=urllib.request.urlopen):
        self.config = config
        self._opener = opener
        self._key = self._load_key(config.private_key_path)
        self._changes: queue.Queue[None] = queue.Queue(maxsize=1)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._revision_lock = threading.Lock()
        self._revision_path = config.private_key_path.parent / "talaria-relay-revision"
        try:
            self._last_revision = int(self._revision_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            self._last_revision = 0
        self._terminal_lock = threading.Lock()
        self._terminal: dict[str, dict] = {}
        self._disabled_profiles: set[str] = set()
        self._alert_eligibility_supported = True

    @staticmethod
    def _load_key(path: Path) -> Ed25519PrivateKey:
        key = load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("Talaria publisher key must be an Ed25519 private key")
        return key

    def start(self, *, publish_initial: bool = True) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="talaria-relay", daemon=True)
        self._thread.start()
        if publish_initial:
            self.changed()

    def stop(self) -> None:
        self._stop.set()
        self.changed()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def changed(self, _profile: str | None = None) -> None:
        try:
            self._changes.put_nowait(None)
        except queue.Full:
            pass

    def note_terminal(self, stream_id: str, phase: str) -> None:
        from api.config import ACTIVE_RUNS, ACTIVE_RUNS_LOCK

        with ACTIVE_RUNS_LOCK:
            run = dict(ACTIVE_RUNS.get(stream_id) or {})
        sid = str(run.get("session_id") or "").strip()
        if not sid:
            return
        run["relay_phase"] = phase
        run["terminal_at"] = time.time()
        with self._terminal_lock:
            self._terminal[sid] = run
        self.changed()

    def _next_revision(self) -> int:
        with self._revision_lock:
            self._last_revision = max(self._last_revision + 1, time.time_ns() // 1_000_000)
            return self._last_revision

    def _run(self) -> None:
        failures = 0
        while not self._stop.is_set():
            try:
                self._changes.get(timeout=60)
            except queue.Empty:
                pass
            if self._stop.is_set():
                return
            try:
                self.publish_snapshot(isolate_permanent=True)
            except Exception as exc:
                if isinstance(exc, _RelayHTTPError) and not exc.retryable:
                    logger.error(
                        "Talaria relay publisher stopped after permanent HTTP %s",
                        exc.status,
                    )
                    return
                failures += 1
                delay = min(
                    5 * 2 ** min(failures - 1, 6) * random.uniform(0.8, 1.2),
                    300,
                )
                if failures == 1:
                    logger.warning(
                        "Talaria relay snapshot failed (%s); retrying in %.1fs",
                        exc,
                        delay,
                        exc_info=not isinstance(exc, _RelayHTTPError),
                    )
                else:
                    logger.debug(
                        "Talaria relay snapshot still failing (%s); retrying in %.1fs",
                        exc,
                        delay,
                    )
                if not self._stop.wait(delay):
                    self.changed()
            else:
                if failures:
                    logger.info("Talaria relay snapshot recovered")
                failures = 0

    def build_states(self, profile: str) -> list[dict]:
        from api.config import ACTIVE_RUNS, ACTIVE_RUNS_LOCK
        from api.models import get_session
        from api.profiles import _profiles_match

        with ACTIVE_RUNS_LOCK:
            runs = [
                dict(item)
                for item in ACTIVE_RUNS.values()
                if isinstance(item, dict) and not item.get("health_only")
            ]

        cutoff = time.time() - 15 * 60
        with self._terminal_lock:
            self._terminal = {
                sid: item for sid, item in self._terminal.items()
                if float(item.get("terminal_at") or 0) >= cutoff
            }
            terminal = dict(self._terminal)

        by_session: dict[str, dict] = {}
        for run in runs:
            sid = str(run.get("session_id") or "").strip()
            if not sid:
                continue
            current = by_session.get(sid)
            if current is None or float(run.get("started_at") or 0) > float(current.get("started_at") or 0):
                by_session[sid] = run
        for sid, run in terminal.items():
            by_session.setdefault(sid, run)

        # One decision per snapshot: every transition it carries was observed
        # while the same lease state held.
        alert_eligible = True
        if self._alert_eligibility_supported:
            try:
                alert_eligible = not profile_has_presence(profile)
            except Exception:
                logger.debug("Failed reading presence state for Talaria", exc_info=True)
                alert_eligible = True

        states = []
        for sid, run in by_session.items():
            try:
                session = get_session(sid, metadata_only=True)
            except Exception:
                continue
            if not _profiles_match(getattr(session, "profile", None), profile):
                continue
            revision = self._next_revision()
            title = str(session.title or "Untitled")[:120]
            phase = str(run.get("relay_phase") or "running")
            try:
                from api.route_approvals import _lock as approval_lock, _pending as approvals
                with approval_lock:
                    pending = approvals.get(sid)
                    if pending and phase not in ("completed", "failed", "cancelled"):
                        phase = "waiting_for_approval"
            except Exception:
                logger.debug("Failed reading approval state for Talaria", exc_info=True)
            if phase == "running":
                try:
                    from api.clarify import has_pending
                    if has_pending(sid):
                        phase = "waiting_for_input"
                except Exception:
                    logger.debug("Failed reading clarify state for Talaria", exc_info=True)
            if phase == "running" and str(run.get("phase") or "").endswith("starting"):
                phase = "starting"
            event_id = f"snapshot:{revision}:{sid}"
            state = {
                "sessionId": sid,
                "streamId": str(run.get("stream_id") or "") or None,
                "eventId": event_id,
                "revision": revision,
                "title": title,
                "phase": phase,
                "updatedAt": int(time.time() * 1_000),
                "deepLink": f"/sessions/{urllib.parse.quote(sid, safe='')}",
            }
            if not alert_eligible:
                state["alertEligible"] = False
            states.append(state)
        if states:
            from api.paths import _atomic_write_text

            _atomic_write_text(self._revision_path, f"{self._last_revision}\n")
        return states

    def publish_snapshot(self, *, isolate_permanent: bool = False) -> None:
        retryable_error = None
        for profile, profile_config in self.config.profiles.items():
            identity = profile_config["identity"]
            if identity:
                try:
                    if _profile_identity(profile) != identity:
                        continue
                except (OSError, ValueError):
                    continue
            profile_id = profile_config["profile_id"]
            if profile_id in self._disabled_profiles:
                continue
            try:
                self._publish_profile_snapshot(profile, profile_id)
            except _RelayHTTPError as exc:
                if not isolate_permanent:
                    raise
                if exc.retryable:
                    retryable_error = retryable_error or exc
                    continue
                self._disabled_profiles.add(profile_id)
                logger.error(
                    "Talaria relay disabled profile after permanent HTTP %s",
                    exc.status,
                )
        if retryable_error is not None:
            raise retryable_error

    def publish_profile(self, profile_id: str, expected_identity: str) -> None:
        for profile, profile_config in self.config.profiles.items():
            if profile_config["profile_id"] == profile_id:
                if (
                    profile_config["identity"] != expected_identity
                    or _profile_identity(profile) != expected_identity
                ):
                    raise RelayPairingError("Hermes profile changed during relay enrollment", status=409)
                self._publish_profile_snapshot(profile, profile_id)
                return
        raise RelayPairingError("Talaria Relay profile enrollment is unavailable", status=502)

    def _publish_profile_snapshot(self, profile: str, profile_id: str) -> None:
        states = self.build_states(profile)
        try:
            self._put_snapshot(profile_id, states)
        except _RelayHTTPError as exc:
            if exc.retryable or not any("alertEligible" in state for state in states):
                raise
            # A relay that predates the alertEligible contract rejects unknown
            # state fields. Re-send the same transitions as eligible so alert
            # delivery keeps working, and stop stamping until the next restart.
            for state in states:
                state.pop("alertEligible", None)
            self._put_snapshot(profile_id, states)
            self._alert_eligibility_supported = False
            logger.warning(
                "Talaria relay rejected alertEligible (HTTP %s); publishing alert-eligible snapshots only",
                exc.status,
            )

    def _put_snapshot(self, profile_id: str, states: list[dict]) -> None:
        body = json.dumps(
            {"snapshotId": f"webui:{uuid.uuid4().hex}", "states": states},
            separators=(",", ":"),
        ).encode("utf-8")
        publisher = urllib.parse.quote(self.config.publisher_id, safe="")
        path = (
            f"/v1/publishers/{publisher}/profiles/"
            f"{urllib.parse.quote(profile_id, safe='')}/snapshot"
        )
        timestamp = str(int(time.time()))
        nonce = uuid.uuid4().hex
        signed = "\n".join(("PUT", path, timestamp, nonce, _b64url(hashlib.sha256(body).digest())))
        signature = _b64url(self._key.sign(signed.encode("utf-8")))
        request = urllib.request.Request(
            self.config.url + path,
            data=body,
            method="PUT",
            headers={
                "Content-Type": "application/json",
                "X-Talaria-Key-Id": self.config.key_id,
                "X-Talaria-Timestamp": timestamp,
                "X-Talaria-Nonce": nonce,
                "X-Talaria-Signature": signature,
            },
        )
        try:
            with self._opener(request, timeout=10) as response:
                if not 200 <= response.status < 300:
                    raise _RelayHTTPError(response.status)
        except urllib.error.HTTPError as exc:
            raise _RelayHTTPError(exc.code) from exc


class _RelayHTTPError(Exception):
    def __init__(self, status: int):
        super().__init__(f"Talaria relay returned HTTP {status}")
        self.status = status
        self.retryable = status in (408, 425, 429) or status >= 500


_publisher: TalariaRelayPublisher | None = None
_publisher_candidate: TalariaRelayPublisher | None = None


def start_talaria_relay_publisher(config: RelayConfig | None = None) -> bool:
    global _publisher, _publisher_candidate
    with _publisher_transition_lock:
        with _publisher_lock:
            if _publisher is not None:
                return True
        candidate = None
        try:
            config = config or RelayConfig.from_state()
            if config is None:
                return False
            candidate = TalariaRelayPublisher(config)
            with _publisher_lock:
                _publisher_candidate = candidate
            from api.session_events import add_session_list_changed_listener
            add_session_list_changed_listener(candidate.changed)
            candidate.start(publish_initial=False)
            with _publisher_lock:
                _publisher = candidate
                _publisher_candidate = None
            atexit.register(stop_talaria_relay_publisher)
            return True
        except Exception:
            if candidate is not None:
                try:
                    from api.session_events import remove_session_list_changed_listener
                    remove_session_list_changed_listener(candidate.changed)
                    candidate.stop()
                except Exception:
                    pass
            with _publisher_lock:
                _publisher = None
                if _publisher_candidate is candidate:
                    _publisher_candidate = None
            logger.warning("Talaria relay publisher disabled: invalid configuration", exc_info=True)
            return False


def configure_talaria_relay_publisher(
    config: RelayConfig,
    *,
    validate_profile_id: str | None = None,
    validate_profile_identity: str | None = None,
) -> None:
    global _publisher, _publisher_candidate
    with _publisher_transition_lock:
        candidate = TalariaRelayPublisher(config)
        with _publisher_lock:
            previous = _publisher
            _publisher_candidate = candidate
        if previous is not None:
            with previous._terminal_lock, candidate._terminal_lock:
                candidate._terminal = dict(previous._terminal)
            with previous._revision_lock, candidate._revision_lock:
                candidate._last_revision = max(candidate._last_revision, previous._last_revision)
        try:
            if validate_profile_id is None:
                candidate.publish_snapshot()
            else:
                if validate_profile_identity is None:
                    raise RelayPairingError("Hermes profile enrollment is unavailable", status=502)
                candidate.publish_profile(validate_profile_id, validate_profile_identity)
        except Exception as exc:
            with _publisher_lock:
                if _publisher_candidate is candidate:
                    _publisher_candidate = None
            raise RelayPairingError("Could not publish the initial Talaria Relay snapshot", status=502) from exc
        from api.session_events import add_session_list_changed_listener
        try:
            add_session_list_changed_listener(candidate.changed)
            candidate.start(publish_initial=False)
        except Exception as exc:
            try:
                from api.session_events import remove_session_list_changed_listener
                remove_session_list_changed_listener(candidate.changed)
                candidate.stop()
            except Exception:
                pass
            with _publisher_lock:
                if _publisher_candidate is candidate:
                    _publisher_candidate = None
            raise RelayPairingError("Could not start the Talaria Relay publisher", status=502) from exc
        if previous is not None:
            # Close the validation-to-swap window: terminal events may have
            # arrived on the still-current publisher while candidate I/O ran.
            with previous._terminal_lock, candidate._terminal_lock:
                candidate._terminal.update(previous._terminal)
            with previous._revision_lock, candidate._revision_lock:
                candidate._last_revision = max(candidate._last_revision, previous._last_revision)
        with _publisher_lock:
            _publisher = candidate
            _publisher_candidate = None
        if callable(candidate.changed):
            candidate.changed()
        if previous is not None:
            from api.session_events import remove_session_list_changed_listener
            remove_session_list_changed_listener(previous.changed)
            previous.stop()
        atexit.register(stop_talaria_relay_publisher)


def stop_talaria_relay_publisher() -> None:
    global _publisher, _publisher_candidate
    with _publisher_transition_lock:
        with _publisher_lock:
            previous = _publisher
            _publisher = None
            _publisher_candidate = None
        if previous is not None:
            from api.session_events import remove_session_list_changed_listener
            remove_session_list_changed_listener(previous.changed)
            previous.stop()


def note_talaria_terminal(stream_id: str, phase: str) -> None:
    with _publisher_lock:
        publisher = _publisher or _publisher_candidate
    if publisher is not None and phase in ("completed", "failed", "cancelled"):
        publisher.note_terminal(stream_id, phase)
        with _publisher_lock:
            current = _publisher or _publisher_candidate
        if current is not None and current is not publisher:
            current.note_terminal(stream_id, phase)
