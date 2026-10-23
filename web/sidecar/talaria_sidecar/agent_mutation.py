"""A lifetime-leased Agent update supervisor, extending dependency_sync's child custody.

Agent code is loaded only in the separate worker, before source changes. The native
checkout lock and gateway journal also fence the backend recovery companion.
"""
from __future__ import annotations

import ast
import contextlib
import hashlib
import importlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from .dependency_sync import _stop_tree
from .errors import InvalidParams, RpcError
from . import agent_services as services

_SESSIONS = {}
_SESSIONS_LOCK = threading.Lock()
_CONSENTS = {}
CONSENT_SECONDS = 300
# One lease exchange, including the worker's unwind after a refused drain.
LEASE_SECONDS = 330


def _close(session):
    with session["close_lock"]:
        if session["closed"]:
            return
        session["closed"] = True
        with contextlib.suppress(OSError):
            session["proc"].stdin.close()
        try:
            session["proc"].wait(timeout=330)
        except subprocess.TimeoutExpired:
            # The native pause journal still owns recovery; never fabricate a successful resume.
            session["proc"].kill()
            session["proc"].wait()
        session["stderr"].close()
        session["proc"].stdout.close()
        session["gateway_lock"].release()


def close_all():
    with _SESSIONS_LOCK:
        sessions = list(_SESSIONS.values())
        _SESSIONS.clear()
    for session in sessions:
        _close(session)


def _reap_sessions():
    with _SESSIONS_LOCK:
        dead = [token for token, session in _SESSIONS.items() if session['proc'].poll() is not None]
        sessions = [_SESSIONS.pop(token) for token in dead]
    for session in sessions:
        _close(session)


def _git_directory(root):
    """Locate receipts before importing possibly torn Agent modules."""
    gitdir = root / '.git'
    if gitdir.is_file():
        value = gitdir.read_text().strip()
        if not value.startswith('gitdir: '):
            raise OSError('The Agent checkout git directory is unreadable.')
        gitdir = (root / value[8:]).resolve()
    return gitdir


def _native_source_repair(root):
    marker = _git_directory(root) / 'hermes-update-pull'
    if not marker.exists():
        return
    with marker.open(encoding='utf-8-sig') as handle:
        raw = handle.read(65537)
    fields = dict(line.partition('=')[::2] for line in raw.splitlines())
    if len(raw) > 65536 or any(not re.fullmatch(r'[a-f0-9]{40}', fields.get(key, '')) for key in ('pre', 'target')):
        raise RuntimeError('Native source recovery receipt is malformed; its evidence is retained.')
    executable = fields.get('git', '')
    executable = executable if os.path.isabs(executable) and Path(executable).is_file() else 'git'
    head = subprocess.run([executable, '--no-replace-objects', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=15, check=True).stdout.strip()
    if head not in {fields['pre'], fields['target']} or not fields.get('pid', '').isdecimal():
        raise RuntimeError('Native source recovery no longer matches the recorded checkout identity; its receipt is retained.')
    # Read the native launch-repair procedure from the immutable baseline, never the damaged tree.
    def constants(path, names):
        found = subprocess.run([executable, '--no-replace-objects', '-C', str(root), 'show', fields['pre'] + ':' + path],
                               capture_output=True, text=True, timeout=15, check=True)
        values = {}
        for node in ast.parse(found.stdout).body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in names:
                values[node.targets[0].id] = ast.literal_eval(node.value)
        if values.keys() != names:
            raise RuntimeError('The recorded Agent baseline has no complete native launch-repair procedure.')
        return values
    template = constants('hermes_cli/_launchers.py', {'_CLOSURE_REPAIR'})['_CLOSURE_REPAIR']
    keys = {'INTERRUPTED_PULL_MARKER', 'RECOVERY_CLOSURE_DIR', 'RECOVERY_CLOSURE_MANIFEST', 'RECOVERY_CLOSURE_INIT', 'RECOVERY_CLOSURE'}
    values = constants('hermes_cli/_early_recovery.py', keys)
    for placeholder, key in (('__MARKER__', 'INTERRUPTED_PULL_MARKER'), ('__CLOSURE_DIR__', 'RECOVERY_CLOSURE_DIR'),
                             ('__MANIFEST__', 'RECOVERY_CLOSURE_MANIFEST'), ('__INIT__', 'RECOVERY_CLOSURE_INIT'), ('__CLOSURE__', 'RECOVERY_CLOSURE')):
        template = template.replace(placeholder, repr(values[key]))
    template = template.replace('__ROOT__', repr(str(root)))
    namespace = {'os': os, 're': re, 'sys': sys}
    exec(compile(template, '<native recorded launch repair>', 'exec'), namespace)
    try:
        namespace['_hermes_closure_repair']()  # Native verification, checkout custody and re-exec remain authoritative.
    except SystemExit:
        if not marker.exists():
            # A proved no-op removes the receipt without changing files; discard the closure imports just as after a restore.
            sys.modules['hermes_cli._early_recovery'].relaunch_after_restore()
        raise


def _receipt_candidates(path, pattern, cache):
    """Cache discovery, never receipt presence; missing paths watch their nearest existing ancestor."""
    key = (path, pattern)
    if cache is not None:
        ancestor = path
        while True:
            try:
                stat = ancestor.stat()
                break
            except FileNotFoundError:
                if ancestor == ancestor.parent:
                    raise
                ancestor = ancestor.parent
        stamp = (ancestor, stat.st_dev, stat.st_ino, stat.st_mode, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
        now = time.monotonic()
        previous = cache.get(key)
        if previous is not None and previous[0] == stamp and 0 <= now - previous[1] < 1:
            return previous[2]
    if pattern is not None:
        try:
            # glob suppresses enumeration errors, which cannot authorize Agent admission.
            with os.scandir(path) as children:
                found = tuple(path / child.name for child in children if Path(child.name).match(pattern))
        except FileNotFoundError:
            found = ()
    else:
        try:
            found = (path,) if any(' refs/talaria/autostash/pending/' in line for line in path.read_text().splitlines()) else ()
        except FileNotFoundError:
            found = ()
    if cache is not None:
        if len(cache) >= 16:
            cache.clear()  # Bound retained paths if an installer repeatedly redirects Git metadata.
        cache[key] = (stamp, now, found)
    return found


def _process_presence(pid):
    """A stdlib rearm trigger only; native identity verification alone decides recovery."""
    if os.name == 'nt' or pid <= 0:
        return 'unknown'
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return 'exited'
    except PermissionError:
        pass
    except (OSError, OverflowError):
        return 'unknown'
    return 'present'


def recovery_receipts(runtime, *, watch=False, discovery_cache=None):
    """Read only the configured checkout's receipts without importing its possibly torn code."""
    root, home = runtime.agent_dir, runtime.hermes_home
    if root is None:
        return [], None
    root = root.resolve()
    state = os.environ.get('TALARIA_SIDECAR_WEB_STATE_DIR') or os.environ.get('HERMES_WEBUI_STATE_DIR', '').strip() or str(home / 'webui')
    marker = Path(state).expanduser() / 'agent-dependency-sync' / hashlib.sha256(str(root).encode()).hexdigest()
    key = hashlib.sha256(os.path.normcase(str(root)).encode()).hexdigest()[:12]
    native = home / ('.hermes-update-paused-gateways.' + key + '.json')
    gitdir = _git_directory(root)
    paths = [services.recovery_path(root, home), marker, native,
             root / '.update-incomplete', root / '.lazy-refresh-incomplete',
             gitdir / 'hermes-update-pull', root / '.hermes-update-zip-swap']
    paths.extend(_receipt_candidates(home, native.name + '.*.claim', discovery_cache))
    common = gitdir
    try:
        common = (gitdir / (gitdir / 'commondir').read_text().strip()).resolve()
    except FileNotFoundError:
        pass
    paths.extend(_receipt_candidates(common / 'refs/talaria/autostash/pending', '*', discovery_cache))
    packed = common / 'packed-refs'
    paths.extend(_receipt_candidates(packed, None, discovery_cache))
    def stamps(candidates):
        result = []
        for path in sorted(set(candidates)):
            try:
                stat = path.lstat()
                result.append((str(path), stat.st_ino, stat.st_mtime_ns, stat.st_size))
            except FileNotFoundError:
                pass
        return result
    found = stamps(paths)
    if watch and found:
        # A repaired source/index or interpreter selection can make previously blocked debt provable again.
        watched = [gitdir / 'HEAD', gitdir / 'index', root / '.venv/pyvenv.cfg', root / 'venv/pyvenv.cfg',
                   root / '.venv/bin/python', root / 'venv/bin/python',
                   home / 'installs' / hashlib.sha256(str(root).encode()).hexdigest()[:16] / 'facts.json']
        try:
            head = (gitdir / 'HEAD').read_text().strip()
            if head.startswith('ref: '):
                ref = Path(head[5:])
                if not ref.is_absolute() and '..' not in ref.parts:
                    watched.append(common / ref)
        except (OSError, UnicodeError):
            pass
        lifecycle = []
        try:
            body = json.loads(services.recovery_path(root, home).read_text())
            for baseline in body.get('tree', {}).get('baselines', []):
                changed = [*baseline.get('dirty_at_pause', []), *baseline.get('move_paths', [])]
                changed.extend(path for paths in baseline.get('landed', {}).values() for path in paths)
                watched.extend(root / path for path in changed if isinstance(path, str) and not Path(path).is_absolute() and '..' not in Path(path).parts)
            # A retained gateway's exit or successor rearms exhausted recovery without changing any receipt.
            for entry in body.get('entries', []):
                if entry.get('purpose') == 'gateway' and isinstance(entry.get('home'), str):
                    watched.append(Path(entry['home']) / 'gateway.pid')
                    pids = {**entry.get('retired_processes', {}), **entry.get('processes', {})}
                    lifecycle.extend(('process', int(pid), _process_presence(int(pid))) for pid in sorted(pids, key=int))
        except (OSError, ValueError, TypeError, AttributeError):
            pass  # The receipt's own stamp still rearms corrected evidence; the worker reports its exact refusal.
        found.extend(stamps(watched))
        found.extend(lifecycle)
    return found, marker


def recover_retained(runtime, ctx, *, probe=False, complete_revision=None):
    """One leased continuation. UpdateService owns the bounded retry sequence."""
    receipts, _ = recovery_receipts(runtime, watch=True)
    fingerprint = hashlib.sha256(json.dumps(receipts).encode()).hexdigest() if receipts else ''
    result = {'ok': not receipts, 'owed': bool(receipts), 'fingerprint': fingerprint, 'detail': ''}
    if complete_revision is not None:
        if not isinstance(complete_revision, str) or not re.fullmatch(r'[a-f0-9]{40}', complete_revision):
            raise InvalidParams('A verified loaded revision is required to complete recovery.')
        if not runtime.loaded or runtime.revision != complete_revision or runtime.is_stale():
            return {**result, 'ok': False, 'detail': 'The loaded Agent runtime does not match the recovered revision.'}
    if probe or not receipts:
        return result
    _reap_sessions()
    from .methods.gateway import _ACTION_LOCK
    if not _ACTION_LOCK.acquire(blocking=False):
        return {**result, 'detail': 'A gateway lifecycle action or Agent update still owns recovery.'}
    from .home import _frozen_launch_env
    root = runtime.agent_dir.resolve()
    env = _frozen_launch_env()
    env.update(HERMES_HOME=str(runtime.hermes_home), HERMES_DISABLE_LAZY_INSTALLS='1',
               PYTHONPATH=str(Path(__file__).parents[1]) + os.pathsep + str(root))
    try:
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            child = subprocess.Popen([sys.executable, '-m', 'talaria_sidecar.agent_mutation', '--recover-current', str(root), complete_revision or ''],
                                     cwd=root, env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr)
            try:
                deadline = time.monotonic() + 660
                while child.poll() is None:
                    ctx.check_cancelled()
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Agent recovery timed out; durable recovery remains owed.')
                    ctx.cancel_event.wait(.05)
                stdout.seek(0)
                reply = json.loads(stdout.read(1024 * 1024))
                if not isinstance(reply, dict) or not isinstance(reply.get('ok'), bool):
                    raise ValueError('Invalid Agent recovery result.')
                if not reply['ok']:
                    stderr.seek(0, os.SEEK_END)
                    stderr.seek(max(0, stderr.tell() - 4000))
                    diagnostic = stderr.read().decode('utf-8', errors='replace').strip()
                    if diagnostic:
                        reply['detail'] = str(reply.get('detail') or '') + ': ' + diagnostic
            finally:
                child.stdin.close()
                try:
                    child.wait(timeout=330)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        remaining, _ = recovery_receipts(runtime, watch=True)
        return {**result, **reply, 'owed': bool(remaining),
                'fingerprint': hashlib.sha256(json.dumps(remaining).encode()).hexdigest() if remaining else ''}
    finally:
        _ACTION_LOCK.release()


def _drain_progress(result):
    progress = result.get("progress") if isinstance(result, dict) and result.keys() == {"progress"} else None
    if (not isinstance(progress, dict) or progress.get("phase") != "gateway_drain"
            or not isinstance(progress.get("deadline_seconds"), (int, float)) or isinstance(progress["deadline_seconds"], bool)
            or not 0 <= progress["deadline_seconds"] <= services.GATEWAY_DRAIN_CEILING
            or not isinstance(progress.get("services"), list) or not all(isinstance(name, str) for name in progress["services"])):
        return None
    return {"phase": "gateway_drain", "deadline_seconds": progress["deadline_seconds"], "services": progress["services"]}


def _exchange(session, request, ctx):
    with session["lock"]:
        if request is not None:
            session["proc"].stdin.write(json.dumps(request) + "\n")
            session["proc"].stdin.flush()
        deadline = time.monotonic() + LEASE_SECONDS
        while True:
            ctx.check_cancelled()
            if time.monotonic() >= deadline:
                raise RpcError("Agent writer lease timed out; recovery remains recorded.", condition="agent_update_unsafe")
            try:
                line = session["output"].get(timeout=.1)
            except queue.Empty:
                continue
            if line is None:
                raise RpcError("Agent writer lease exited; its pause journal retains recovery.", condition="agent_update_unsafe")
            result = json.loads(line)
            if isinstance(result, dict) and "progress" in result:
                progress = _drain_progress(result)
                if progress is None:
                    raise RpcError("Invalid Agent writer lease response.", condition="agent_update_unsafe")
                # The worker's own drain deadline is bounded; unwind keeps the ordinary lease margin.
                deadline = max(deadline, time.monotonic() + progress["deadline_seconds"] + LEASE_SECONDS)
                ctx.emit("progress", progress)
                continue
            if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                raise RpcError("Invalid Agent writer lease response.", condition="agent_update_unsafe")
            return {"ok": result["ok"], "skipped": result.get("skipped") is True, "detail": str(result.get("detail") or ""),
                    **({"refresh_confirmation": result["refresh_confirmation"]} if "refresh_confirmation" in result else {})}


def call(runtime, ctx, params):
    root = runtime.agent_dir
    expected = params.get("agent_dir")
    if root is None or not isinstance(expected, str) or not expected or Path(expected).resolve() != root.resolve():
        raise InvalidParams("agent_dir must match the sidecar's configured Agent checkout")
    action = params.get("action")
    if action not in {"begin", "git", "sync", "finish"}:
        raise InvalidParams("invalid Agent mutation action")
    if action == "begin":
        _reap_sessions()
        revision = params.get("revision")
        homes = params.get("homes")
        if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise InvalidParams("an immutable target revision is required")
        if not isinstance(homes, list) or not homes or not all(isinstance(home, str) and Path(home).is_absolute() for home in homes):
            raise InvalidParams("resolved profile homes are required")
        if any(Path(home).resolve().is_relative_to(root.resolve()) for home in homes):
            raise InvalidParams("Agent profile homes must stay outside the source checkout to survive update cleanup")
        intent = params.get('intent', '')
        refresh_token = params.get('refresh_token')
        if not isinstance(intent, str) or len(intent) > 1024:
            raise InvalidParams('invalid update intent')
        binding = None
        with _SESSIONS_LOCK:
            for key, value in list(_CONSENTS.items()):
                if value['expires'] <= time.monotonic():
                    _CONSENTS.pop(key)
            if refresh_token is not None:
                consent = _CONSENTS.pop(refresh_token, None) if isinstance(refresh_token, str) else None
                if (consent is None or not intent or consent['intent'] != intent or consent['root'] != root.resolve()
                        or consent['revision'] != revision or consent['homes'] != sorted({str(Path(h).resolve()) for h in homes})):
                    return {'ok': False, 'skipped': False, 'detail': 'Legacy refresh confirmation expired, changed or was already used. Check for updates and confirm again.'}
                binding = consent['binding']
            if any(s["root"] == root.resolve() for s in _SESSIONS.values()):
                return {"ok": False, "skipped": False, "detail": "Another Agent update owns the writer lease."}
            from .home import _frozen_launch_env
            env = _frozen_launch_env()
            extra_pythonpath = (os.pathsep + env["PYTHONPATH"]) if env.get("PYTHONPATH") else ""
            env.update(HERMES_HOME=str(runtime.hermes_home), HERMES_DISABLE_LAZY_INSTALLS="1",
                       PYTHONPATH=str(Path(__file__).parents[1]) + os.pathsep + str(root) + extra_pythonpath)
            stderr = tempfile.TemporaryFile()
            from .methods.gateway import _ACTION_LOCK
            if not _ACTION_LOCK.acquire(blocking=False):
                stderr.close()
                return {"ok": False, "skipped": False, "detail": "A gateway lifecycle action is still running."}
            try:
                proc = subprocess.Popen([sys.executable, "-m", "talaria_sidecar.agent_mutation", str(root), revision, json.dumps(homes), binding or ""],
                                        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
            except BaseException:
                stderr.close()
                _ACTION_LOCK.release()
                raise
            token = uuid.uuid4().hex
            session = {"intent": intent, "revision": revision, "homes": sorted({str(Path(h).resolve()) for h in homes}), "root": root.resolve(), "proc": proc, "stderr": stderr, "lock": threading.RLock(),
                       "close_lock": threading.Lock(), "closed": False, "output": queue.Queue(), "gateway_lock": _ACTION_LOCK}
            _SESSIONS[token] = session
        def read():
            try:
                for line in proc.stdout:
                    if len(line) > 16 * 1024 * 1024:
                        break
                    session["output"].put(line)
            finally:
                session["output"].put(None)
        threading.Thread(target=read, daemon=True).start()
    else:
        token = params.get("token")
        if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{32}", token):
            raise InvalidParams("invalid Agent writer lease token")
        with _SESSIONS_LOCK:
            session = _SESSIONS.get(token)
        if session is None or session["root"] != root.resolve():
            raise RpcError("Agent writer lease is unavailable; retry recovery before updating.", condition="agent_update_unsafe")
        if action == "git":
            args = params.get("args")
            if (not isinstance(args, list) or not args or len(args) > 1000
                    or not all(isinstance(arg, str) for arg in args) or sum(map(len, args)) > 1024 * 1024
                    or args[0] not in {"rev-parse", "ls-tree", "show", "tag", "for-each-ref", "status", "diff-index", "diff", "stash",
                                       "merge", "apply", "checkout", "clean", "reset", "update-ref", "describe", "log", "merge-base", "rev-list", "ls-files"}
                    or "--unsafe-paths" in args):
                raise InvalidParams("invalid leased git command")
            timeout = params.get("timeout_ms")
            if not isinstance(timeout, int) or not 100 <= timeout <= 300000:
                raise InvalidParams("invalid leased git timeout")
    try:
        result = _exchange(session, None if action == "begin" else params, ctx)
        if action == 'begin' and 'refresh_confirmation' in result:
            confirmation = result['refresh_confirmation']
            if not session['intent']:
                return {'ok': False, 'skipped': False, 'detail': 'Legacy dashboard refresh requires an interactive operator confirmation.'}
            nonce = uuid.uuid4().hex
            with _SESSIONS_LOCK:
                if len(_CONSENTS) >= 64:
                    _CONSENTS.pop(next(iter(_CONSENTS)))
                _CONSENTS[nonce] = {key: session[key] for key in ('root', 'revision', 'homes', 'intent')}
                _CONSENTS[nonce].update(binding=confirmation['binding'], expires=time.monotonic() + CONSENT_SECONDS)
            result['refresh_confirmation'] = {'token': nonce, 'services': confirmation['services']}
        if action == "begin" and result["ok"]:
            return {**result, "token": token}
        if action != "finish" and result["ok"]:
            return result
        # A failed Git/sync command leaves the lease held so the caller can restore its stash and finish.
        if action in {"git", "sync"}:
            return result
        return result
    except BaseException:
        with _SESSIONS_LOCK:
            _SESSIONS.pop(token, None)
        _close(session)
        raise
    finally:
        if action == "finish" or (action == "begin" and 'result' in locals() and not result["ok"]):
            with _SESSIONS_LOCK:
                _SESSIONS.pop(token, None)
            _close(session)


def _owners(root, homes, pause, identity, windows=None):
    homes = {Path(home).resolve() for home in homes}
    if windows is None:
        units, jobs = pause._discover_systemd(), pause._discover_launchd()
        units, jobs, notices = pause._left_running(units, jobs)
        supervised = services.gateway_entries(units + jobs, homes, pause)
        bare, more = pause._discover_bare({pid for e in supervised for pid in (e["pid"], e["service_pid"])})
        if notices or more:
            raise RuntimeError("A gateway cannot be safely quiesced: " + "; ".join(notices + more))
        entries = supervised + bare
    else:
        from hermes_cli.gateway import _capture_gateway_argv
        _, native_services, _, running = windows._discover_windows_gateways()
        by_pid = {int(service.gateway_pid): service for service in native_services}
        entries = [{"pid": int(pid), "home": pause._home_of(int(pid)), "argv": _capture_gateway_argv(int(pid))} for pid in running]
        for entry in entries:
            service = by_pid.get(entry["pid"])
            if service is not None:
                entry.update(kind="windows-service", service=str(service.name), profile=str(service.profile),
                             service_pid=int(service.service_pid), service_ct=float(service.service_create_time),
                             descendants=list(getattr(service, "descendant_identities", ())))
                if entry["service_pid"] <= 0 or entry["service_ct"] <= 0:
                    raise RuntimeError("A Windows gateway service's process identity could not be proved.")
        if any(not entry["argv"] and not entry.get("kind") for entry in entries):
            raise RuntimeError("A Windows gateway's resume command could not be proved.")
        if any(holder["kind"] != "gateway" or holder["pid"] not in {e["pid"] for e in entries} for holder in windows.list_venv_holders()):
            raise RuntimeError("An Agent environment writer cannot be cooperatively quiesced.")
    pids = {entry["pid"] for entry in entries}
    for entry, live in _writer_ledger(root, identity):
        if live is not True:
            raise RuntimeError(f"Agent writer PID {entry.get('pid')} has no proven live identity; source was not changed.")
        if entry.get('purpose') in {'serve', 'dashboard'} and windows is None:
            backend = services.backend_entry(entry, homes, pause, identity)
            existing = next((e for e in entries if e['pid'] == backend['pid']), None)
            if existing is not None and (existing.get('purpose') != backend['purpose'] or existing.get('home') != backend['home']):
                raise RuntimeError(f"Agent writer PID {backend['pid']} has conflicting native ownership identities.")
            if backend['pid'] not in pids:
                if any(e.get('purpose') in {'serve', 'dashboard'} and services._service_key(e) == services._service_key(backend) for e in entries):
                    raise RuntimeError('More than one backend claims the same supervised service.')
                entries.append(backend)
                pids.add(backend['pid'])
        elif entry.get("pid") not in pids:
            raise RuntimeError(f"Agent writer PID {entry.get('pid')} has no proven cooperative pause; stop it through its owner before updating.")
    if any(not entry.get("home") or Path(entry["home"]).resolve() not in homes for entry in entries):
        raise RuntimeError("A gateway's owning profile is unknown or outside this Web instance's scope.")
    return entries


def _writer_ledger(root, identity):
    ledger = identity._read_ledger(identity._ledger_path())
    if ledger is None:
        raise RuntimeError("Agent process ownership evidence is unreadable.")
    try:
        raw = identity._ledger_path().read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        raw = "[]"
    if raw.strip():
        complete = json.loads(raw)
        if not isinstance(complete, list) or not all(isinstance(row, dict) for row in complete):
            raise RuntimeError("Agent process ownership evidence is malformed.")
    found = []
    for entry in ledger:
        if entry.get("purpose") in {"gateway", "serve", "dashboard"} and not entry.get("install"):
            raise RuntimeError("Agent process ownership evidence is incomplete.")
        if entry.get("install") != identity.install_id(root) or entry.get("purpose") not in {"gateway", "serve", "dashboard"}:
            continue
        live = identity._pid_alive_matches(entry.get("pid"), entry.get("create_time"))
        if live is not False:
            found.append((entry, live))
    return found


def _worker(root, revision, homes, requests, stopped, send, refresh_binding=None):
    if os.name not in {"posix", "nt"}:
        raise RuntimeError("A cooperative Agent writer lease is unavailable on this platform; source was not changed.")
    sys.path.insert(0, str(root))
    # Keep the installed updater's resume closure loaded across replacement of its source files.
    modules = {name: importlib.import_module("hermes_cli." + name) for name in (
        "update_lock", "update_cmd_posix_pause", "update_pause_record", "update_cmd_pause_gate",
        "update_cmd_windows", "update_custody", "process_identity", "update_cmd_commit")}
    if any(not Path(module.__file__).resolve().is_relative_to(root) for module in modules.values()):
        raise RuntimeError("Agent writer lease imported a different checkout.")
    pause, records, identity = (modules[name] for name in ("update_cmd_posix_pause", "update_pause_record", "process_identity"))
    windows = modules["update_cmd_windows"] if os.name == "nt" else None
    lock = modules["update_lock"].UpdateLock(install_root=root)
    if not lock.acquire():
        raise RuntimeError("Another Agent update owns the native checkout lock.")
    token = None
    initial = None
    initial_tree = None
    handed_off = False
    sync_failed = False
    error = None
    recovery = None
    gateway_deadline = None
    try:
        recovery = services.ServiceRecovery(root, Path(os.environ['HERMES_HOME']), records, identity, pause)
        found = _command(modules["update_custody"].git_argv(["git"], ["rev-parse", "HEAD"]), root, 10, stopped, modules["update_custody"])
        if not found["ok"]:
            raise RuntimeError("The installed Agent revision could not be verified before quiescence.")
        initial = found["detail"]
        initial_tree = records.tree_state(root)
        if initial_tree is None or initial_tree.get("pre_sha") != initial or initial_tree.get("dirty_at_pause") is None:
            raise RuntimeError("The Agent source baseline could not be proved before quiescence.")
        # Recovery must remain readable after a crash on the target tree. Inspect it without importing it.
        found = _command(modules["update_custody"].git_argv(["git"], ["show", f"{revision}:hermes_cli/update_pause_record.py"]), root, 15, stopped, modules["update_custody"])
        if not found["ok"]:
            raise RuntimeError("The target Agent's durable gateway resume protocol could not be read.")
        reader = found["detail"]
        if not all(re.search(r"^def " + name + r"\(", reader, re.M) for name in ("recover", "tree_is_whole", "adopt_orphans")):
            raise RuntimeError("The target Agent lacks the durable gateway resume protocol.")
        found = _command(modules["update_custody"].git_argv(["git"], ["ls-tree", "-r", "--name-only", revision, "--", "hermes_cli"]), root, 15, stopped, modules["update_custody"])
        target_files = set(found["detail"].splitlines()) if found["ok"] else set()
        if not {f"hermes_cli/{name}.py" for name in (*modules, "main")} <= target_files:
            raise RuntimeError("The target Agent is missing its native update-recovery modules.")
        needs_sync = "hermes_cli/venv_sync.py" in target_files
        adopted, claims = records.adopt_orphans()
        bootstrap_repair = False
        try:
            main_module = importlib.import_module("hermes_cli.main")
            if not Path(main_module.__file__).resolve().is_relative_to(root):
                raise RuntimeError("The Agent update loaded another checkout's runtime.")
        except Exception:
            if (not (adopted or recovery.state['entries']) or (initial != revision and needs_sync) or _writer_ledger(root, identity)
                    or any(records.identity_is_live({"pid": int(pid), "ct": ct}) for pid, ct in adopted.get("identities", {}).items())):
                raise RuntimeError("The Agent environment cannot import and its writers cannot be proved quiesced; use native recovery first.")
            bootstrap_repair = True
        if any(e.get('legacy_refresh') for e in recovery.state['entries']):
            recovery.resume(_writer_ledger)
        entries = [] if bootstrap_repair else _owners(root, homes, pause, identity, windows)
        recovery_only = ((bootstrap_repair and needs_sync) or bool(adopted and not records.tree_is_whole(adopted, root)[0])
                         or bool(recovery.state['entries'] and (recovery.state.get('sync_failed') or not records.tree_is_whole(recovery.state['tree'], root)[0])))
        # Native gateway birth stamps and journal identities use different units.
        # Bracket and repeat both probes, binding them to the same incarnation before recording it.
        from gateway.status import get_process_start_time
        owner_identities = {}
        legacy = []
        for entry in entries:
            services.bind_processes(entry, records)
            canonical = records.identity(entry["pid"])["ct"]
            birth = get_process_start_time(entry["pid"])
            if canonical is None or birth is None:
                raise RuntimeError("Gateway process identity could not be proved.")
            if (records.identity(entry["pid"])["ct"] != canonical
                    or get_process_start_time(entry["pid"]) != birth
                    or (entry.get("ct") is not None and entry["ct"] != birth)):
                raise RuntimeError("Gateway process identity changed during quiescence; source was not changed.")
            entry["ct"] = birth
            if entry.get('purpose') in {'dashboard', 'serve'}:
                try:
                    services.backend_request(entry)
                except services.BackendLifecycleUnsupported:
                    services.verify_listener(entry)
                    entry['config_stamp'] = services._config_stamp(entry)
                    legacy.append(entry)
                services.verify_processes(entry, records)
            if not entry.get('purpose'):
                owner_identities[str(entry["pid"])] = canonical
                owner_identities.update({pid: p['ct'] for pid, p in entry.get('processes', {}).items()})
        binding = hashlib.sha256(json.dumps({'root': str(root), 'revision': revision, 'tree': initial_tree,
                                             'homes': sorted(map(str, homes)), 'entries': sorted(legacy, key=services._name)},
                                            sort_keys=True).encode()).hexdigest()
        if refresh_binding and (not legacy or refresh_binding != binding):
            raise RuntimeError('Legacy refresh target or process identity changed. Check for updates and confirm again.')
        if legacy and not refresh_binding:
            send({'ok': False, 'detail': 'Active dashboard work may be interrupted by a graceful refresh.',
                  'refresh_confirmation': {'binding': binding, 'services': [services._name(e) for e in legacy]}})
            return
        if legacy and (recovery_only or bootstrap_repair or initial_tree['dirty_at_pause']
                       or (root / '.interrupted').exists()):
            raise RuntimeError('The installed Agent source/dependencies are not safe for a legacy refresh; repair remains owed.')
        gateway_entries = [e for e in entries if not e.get('purpose')]
        backend_entries = [e for e in entries if e.get('purpose') in {'serve', 'dashboard'}]
        token = pause._empty_token()
        if recovery.state['entries']:
            token['baselines'] = recovery.state['tree'].get('baselines', [])
        if windows is not None:
            token.pop("platform", None)
            native_services = [e for e in entries if e.get("kind") == "windows-service"]
            token.update(services=[e["service"] for e in native_services], expected_services=[e["service"] for e in native_services], restarted_services=[],
                         service_profiles={e["service"]: e["profile"] for e in native_services})
        token.update(posix_units=[], unmapped=[e for e in gateway_entries if not e.get("kind")],
                     unmapped_pids=[e["pid"] for e in gateway_entries if not e.get("kind")],
                     identities=owner_identities, resume_needed=bool(gateway_entries))
        records.record_pause(token, adopted, claims)
        recovery.state.setdefault('transaction', {'revision': revision, 'homes': sorted(map(str, homes))})
        recovery.save(token)
        if legacy:
            whole, why = records.tree_is_whole(token, root)
            if not whole:
                raise RuntimeError('Legacy refresh requires verified current source/dependencies: ' + why)
            for entry in legacy:
                recovery.prepare([entry], token)
                recovery.refresh(entry, stopped, _writer_ledger)
            # Bootstrap is bounded to the consented incarnations; every successor now uses the normal fence.
            entries = _owners(root, homes, pause, identity, windows)
            for entry in entries:
                services.bind_processes(entry, records)
                if entry.get('purpose') in {'dashboard', 'serve'}:
                    services.backend_request(entry)
            gateway_entries = [e for e in entries if not e.get('purpose')]
            backend_entries = [e for e in entries if e.get('purpose') in {'serve', 'dashboard'}]
        recovery.prepare(backend_entries + [{**e, 'purpose': 'gateway'} for e in gateway_entries if e.get('processes')], token)
        records.mark_stop_requested(token, sorted({pid for e in gateway_entries for pid in (e['pid'], e.get('service_pid', e['pid']))}))
        for entry in backend_entries:
            recovery.stop(entry, stopped)
        # Every profile shares the longest native drain; the lease reports it so its RPC keeps custody.
        gateway_deadline = recovery.gateway_deadline(homes)
        if gateway_entries:
            send({'progress': {'phase': 'gateway_drain', 'deadline_seconds': round(max(gateway_deadline - time.monotonic(), 0), 3),
                               'services': sorted({services._name(e) for e in gateway_entries})}})
        for entry in gateway_entries:
            if stopped.is_set() or time.monotonic() >= gateway_deadline:
                raise RuntimeError('Gateway drain has not completed; its durable resume obligation is retained.')
            if entry.get('processes'):
                services.verify_processes(entry, records)
            recovery.gateway_requested(entry)
            for pid in {entry['pid'], entry.get('service_pid', entry['pid'])}:
                records.mark_stop_sent(token, pid)
            # mark_stop_sent is best effort upstream; this producer requires a durable request before sending it.
            records.write(token)
            if not pause._ask_to_drain(entry):
                raise RuntimeError("A gateway did not acknowledge cooperative quiescence; source was not changed.")
            recovery.gateway_requested(entry, acknowledged=True)
        waiting = list(gateway_entries)
        while waiting:
            for entry in list(waiting):
                if not pause._alive(entry["pid"], entry["ct"]):
                    if entry.get("kind") == "windows-service":
                        _, service = windows._win_service(entry["service"])
                        if service.status() != "stopped":
                            windows._stop_windows_gateway_service(entry["service"], expected_processes=tuple(map(tuple, entry["descendants"])),
                                                                 expected_service_identity=(entry["service_pid"], entry["service_ct"]))
                    else:
                        if entry.get('processes'):
                            recovery.settle_gateway(entry, stopped, deadline=gateway_deadline)
                        else:
                            pause._disarm(services.service_entry(entry))
                    waiting.remove(entry)
            if waiting and (stopped.wait(.05) or time.monotonic() >= gateway_deadline):
                raise RuntimeError("Gateway drain has not completed; its durable resume obligation is retained.")
        if (_writer_ledger(root, identity) if bootstrap_repair else _owners(root, homes, pause, identity, windows)):
            raise RuntimeError("A gateway appeared during quiescence; source was not changed.")
        send({"ok": True})
        last_request = time.monotonic()
        while not stopped.is_set():
            try:
                request = requests.get(timeout=.1)
            except queue.Empty:
                if time.monotonic() - last_request > 60:
                    raise RuntimeError("The idle Agent writer lease expired; no further commands are admitted.")
                continue
            last_request = time.monotonic()
            if request["action"] == "finish":
                break
            if (_writer_ledger(root, identity) if bootstrap_repair else _owners(root, homes, pause, identity, windows)):
                raise RuntimeError('An Agent writer appeared during the held lease; source/dependency mutation was refused.')
            if request["action"] == "sync":
                argv = [sys.executable, "-m", "hermes_cli.venv_sync", "--project-root", str(root), "--json"]
                if not (root / "hermes_cli/venv_sync.py").is_file():
                    sync_failed = needs_sync
                    recovery.state['sync_failed'] = needs_sync
                    recovery.save(token)
                    send({"ok": not needs_sync, "skipped": True, "detail": "The target's dependency repair module is missing." if needs_sync else ""})
                    continue
                sync_failed = True
                recovery.state['sync_failed'] = True
                recovery.save(token)
                result = _command(argv, root, 300, stopped, modules["update_custody"])
                try:
                    response = json.loads(result["detail"]) if result["ok"] else {}
                    result["ok"] = result["ok"] and response.get("ok") is True
                    result["detail"] = str(response.get("detail") or result["detail"])
                except ValueError:
                    result = {"ok": False, "detail": "Agent dependency sync returned an invalid result."}
                sync_failed = not result["ok"]
                recovery.state['sync_failed'] = sync_failed
                recovery.state['transaction']['dependencies_verified'] = not sync_failed
                recovery.save(token)
                if not bootstrap_repair and not sync_failed and records.tree_is_whole(token, root)[0]:
                    recovery_only = False
            else:
                args = request.get("args")
                if not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args):
                    raise ValueError("invalid git arguments")
                if recovery_only and args[0] in {"stash", "merge", "apply", "checkout", "clean", "reset"}:
                    send({"ok": False, "detail": "A prior Agent update requires source/dependency recovery before another checkout mutation."})
                    continue
                seconds = min(max(float(request.get("timeout_ms", 10000)) / 1000, .1), 300)
                applying = args[0] == "apply" and "--check" not in args
                paths = _patch_paths(root, args[-1], stopped, modules["update_custody"]) if applying else []
                before = records.tree_state(root) if applying else None
                whole_before = records.tree_is_whole(token, root)[0] if applying else False
                mutating = args[0] in {"merge", "reset", "checkout", "apply", "clean", "stash"} and "--check" not in args
                gate = modules["update_cmd_pause_gate"]._checkout_move(token, revision, paths=paths, revert=True) if mutating else contextlib.nullcontext({})
                if mutating:
                    recovery.state['transaction']['dependencies_verified'] = False
                move_marker = None
                if args[0] == 'merge' and '--ff-only' in args or args[0] == 'reset' and '--hard' in args:
                    commit = modules['update_cmd_commit']
                    current = records.tree_state(root)
                    if current is None or current.get('dirty_at_pause'):
                        raise RuntimeError('A source move requires the recorded clean tree; local edits remain retained.')
                    # The native rollback receipt is immutable before Git can tear any source file.
                    move_marker = commit.arm_tree_move(['git'], root, pre=current['pre_sha'], target=revision, stash=None, rollback='branch')
                with gate as step:
                    recovery.save(token)
                    argv = modules["update_custody"].git_argv(["git"], args)
                    result = _command(argv, root, seconds, stopped, modules["update_custody"])
                    if result["ok"] and applying:
                        step["whole"] = True
                if move_marker is not None and result['ok']:
                    installed = records.tree_state(root)
                    if installed and installed['pre_sha'] == revision and installed['dirty_at_pause'] == []:
                        move_marker.unlink(missing_ok=True)
                        if not needs_sync:
                            recovery.state['sync_failed'] = False
                            recovery.state['transaction']['dependencies_verified'] = True
                    else:
                        result = {'ok': False, 'detail': 'The source move did not leave a verified whole target; native rollback remains owed.'}
                if result["ok"] and applying and whole_before:
                    after = records.tree_state(root)
                    if before is None or after is None or before["pre_sha"] != after["pre_sha"]:
                        raise RuntimeError("The completed local restore could not be verified; gateway resume remains owed.")
                    # Every carried pause verified this HEAD before the atomic restore; retain the intended edits for all of them.
                    for baseline in token.get("baselines", []):
                        if baseline.get("pre_sha") == after["pre_sha"]:
                            baseline.update(after)
                    records.write(token)
                recovery.save(token)
            send(result)
    except BaseException as exc:
        error = str(exc)
    finally:
        try:
            # Cancellation or a lost lease pipe ends the drain wait; the retained debt keeps the gateway owed.
            unwind_deadline = time.monotonic() if stopped.is_set() else gateway_deadline
            if token:
                live = any(records.identity_is_live({"pid": int(pid), "ct": ct}) for pid, ct in token.get("identities", {}).items())
                found = _command(modules["update_custody"].git_argv(["git"], ["rev-parse", "HEAD"]), root, 10, threading.Event(), modules["update_custody"])
                if not found["ok"]:
                    raise RuntimeError("Gateway resume remains owed because the Agent revision is unverified.")
                final_tree = records.tree_state(root)
                if final_tree is None or final_tree.get("dirty_at_pause") is None:
                    raise RuntimeError("Gateway resume remains owed because the source tree is unverified.")
                changed = found["detail"] != initial or final_tree != initial_tree
                if live and not changed and not sync_failed and records.tree_is_whole(token, root)[0]:
                    # An untouched gateway must not strand a backend stopped earlier in a partial pause.
                    recovery.save(token)
                    recovery.resume(_writer_ledger, gateway_deadline=unwind_deadline)
                if live or sync_failed or (changed and needs_sync and not locals().get("response", {}).get("ok")):
                    raise RuntimeError("Gateway resume remains owed until writer drain and dependency repair complete.")
                whole, why = records.tree_is_whole(token, root)
                if not whole:
                    raise RuntimeError("Gateway resume remains owed: " + why)
                pending = _command(modules['update_custody'].git_argv(['git'], ['for-each-ref', '--format=%(objectname)', 'refs/talaria/autostash/pending/']), root, 10, threading.Event(), modules['update_custody'])
                if not pending['ok'] or pending['detail']:
                    raise RuntimeError('Gateway resume remains owed until retained local Agent edits are restored.')
                if token.get("resume_needed"):
                    if bootstrap_repair:
                        records.write({**token, "resume_needed": True}, owner=records.UNOWNED)
                        handed_off = True
                        resumed = _resume_current(root, modules["update_custody"])
                        if not resumed["ok"]:
                            raise RuntimeError(resumed["detail"])
                        token["resume_needed"] = False
                    else:
                        modules["update_cmd_windows"]._resume_windows_gateways_after_update(token)
                if token.get("resume_needed") or token.get("resume_deferred"):
                    raise RuntimeError("Gateway resume could not be verified; its obligation is retained.")
                recovery.save(token)
                recovery.resume(_writer_ledger, gateway_deadline=unwind_deadline)
            if token and not handed_off:
                records.discharge(token)
                from .runtime import AgentRuntime
                _, marker = recovery_receipts(AgentRuntime(Path(os.environ['HERMES_HOME']), root))
                if marker and marker.exists():
                    recovery.state['transaction']['runtime_revision'] = found['detail']
                    recovery.save(token)
                else:
                    recovery.state.pop('transaction', None)
                    recovery.save()
        except BaseException as exc:
            error = (error + "; " if error else "") + str(exc)
            if token and not handed_off:
                records.write({**token, "resume_needed": True}, owner=records.UNOWNED)
        finally:
            lock.release()
    send({"ok": error is None, "detail": error or ""})


def _resume_current(root, custody, stopped=None, complete_revision=None):
    # Resolve target PM code in a fresh stdlib process, after any source/dependency change.
    try:
        launchers = importlib.import_module('hermes_cli._launchers')
        if not Path(launchers.__file__).resolve().is_relative_to(root):
            raise RuntimeError('Recovery loaded another Agent bootstrap selector.')
        bootstrap = launchers.resolve_store_python(root)
    except ModuleNotFoundError as exc:
        if exc.name != 'hermes_cli._launchers':
            raise
        bootstrap = None
    # A copied macOS venv interpreter can be its own _base_executable and later be retired.
    bootstrap = bootstrap or getattr(sys, '_base_executable', None) or sys.executable
    result = _command([str(bootstrap), "-m", "talaria_sidecar.agent_mutation", "--select-resume", str(root), complete_revision or "", sys.executable], root, 660, stopped or threading.Event(), custody, cooperative=True)
    try:
        reply = json.loads(result["detail"]) if result["ok"] else {}
        return {**reply, "ok": result["ok"] and reply.get("ok") is True, "detail": str(reply.get("detail") or result["detail"])}
    except ValueError:
        return {"ok": False, "detail": "The current Agent could not verify its retained gateway resume obligation."}


def _recovery_environment(root):
    """Reuse PM's selector and packaged launch policy without copying its facts/path rules."""
    sys.path.insert(0, str(root))
    environments = importlib.import_module('pm.environments')
    if any(not Path(sys.modules[name].__file__).resolve().is_relative_to(root)
           for name in ('pm', 'pm.environments', 'hermes_constants')):
        raise RuntimeError('Recovery loaded another Agent environment selector.')
    selected = environments.committed_venv(root)
    if selected is None:
        if environments.install_state_dir(root).exists():
            raise RuntimeError('No dependency environment is committed for this Agent install; recovery remains owed.')
        selected = environments.selected_venv(root)
    return environments, selected


def _select_resume(root, complete_revision, legacy_python):
    if (root / 'pm').exists():
        environments, selected = _recovery_environment(root)
        command = environments.venv_command(root, selected)
        environment = str(selected)
    else:
        python = next((path for venv in ('.venv', 'venv')
                       for path in (root / venv / 'bin/python', root / venv / 'Scripts/python.exe') if path.is_file()), Path(legacy_python))
        command, environment = [str(python)], ''
    # Keep bin/python intact: realpath would turn a POSIX venv into its bare tool.
    argv = [*command, '-m', 'talaria_sidecar.agent_mutation', '--resume-leased', str(root), complete_revision or '', environment]
    os.execv(argv[0], argv)


def _verify_recovery_environment(root, expected):
    from .runtime import _check_site_packages_python
    environments, selected = _recovery_environment(root)
    if str(selected) != expected or environments.venv_python_version(selected) != sys.version_info[:2]:
        raise RuntimeError('Agent recovery dependency environment changed or has an incompatible Python ABI.')
    site = environments.site_packages(selected)
    if not site.is_dir() or site.resolve() not in {Path(entry).resolve() for entry in sys.path if entry}:
        raise RuntimeError('Agent recovery did not enter its selected dependency environment.')
    _check_site_packages_python()


def _resume_worker(root, stopped=None, complete_revision=None):
    sys.path.insert(0, str(root))
    from hermes_cli import update_lock, update_pause_record as records, process_identity, update_cmd_posix_pause
    if any(not Path(module.__file__).resolve().is_relative_to(root) for module in (update_lock, records, process_identity, update_cmd_posix_pause)):
        raise RuntimeError("Gateway recovery loaded another Agent checkout.")
    lock = update_lock.UpdateLock(install_root=root)
    if not lock.acquire():
        raise RuntimeError("The gateway recovery child could not join the native checkout lease.")
    try:
        recovery = services.ServiceRecovery(root, Path(os.environ['HERMES_HOME']), records, process_identity, update_cmd_posix_pause)
        adopted = None
        for _, body in records.orphans():
            adopted = records.merge_into(adopted, body['token'])
        tree = records.merge_into(adopted, recovery.state['tree']) if recovery.state['tree'] else adopted or {}
        from .runtime import AgentRuntime
        runtime = AgentRuntime(Path(os.environ['HERMES_HOME']), root)
        receipts, marker = recovery_receipts(runtime)
        custody = importlib.import_module('hermes_cli.update_custody')
        stopped = stopped or threading.Event()
        from hermes_cli._early_recovery import interrupted_pull_marker
        if interrupted_pull_marker(root).exists():
            return {'ok': False, 'detail': 'Native source recovery remains incomplete; its receipt is retained.'}
        if (root / '.hermes-update-zip-swap').exists():
            from hermes_cli._early_recovery import restore_interrupted_pull
            if restore_interrupted_pull(root):
                return _resume_current(root, custody, stopped, complete_revision)
        if (root / '.update-incomplete').exists() or (root / '.lazy-refresh-incomplete').exists():
            return {'ok': False, 'detail': 'Native source recovery remains incomplete; its receipt is preserved.'}
        if receipts and not tree.get('baselines'):
            return {'ok': False, 'detail': 'Recovery has no verified transaction baseline; its receipt is preserved.'}
        whole, why = records.tree_is_whole(tree, root)
        if not whole:
            return {'ok': False, 'detail': 'Source recovery remains owed: ' + why}
        head = _command(custody.git_argv(['git'], ['rev-parse', 'HEAD']), root, 10, stopped, custody)
        if not head['ok'] or not re.fullmatch(r'[a-f0-9]{40}', head['detail']):
            return {'ok': False, 'detail': 'Recovery cannot verify the installed revision.'}
        revision = head['detail']
        if revision not in {r for b in tree.get('baselines', []) for r in [b.get('pre_sha'), *b.get('move_targets', []), *b.get('landed', {})]}:
            return {'ok': False, 'detail': 'Installed revision is outside the retained transaction; recovery was refused.'}
        moved = any(b.get('pre_sha') != revision for b in tree.get('baselines', []))
        transaction = recovery.state.get('transaction') or {}
        if recovery.state.get('sync_failed') or (moved and not transaction.get('dependencies_verified')) or (marker and marker.exists() and not transaction):
            if _writer_ledger(root, process_identity):
                return {'ok': False, 'detail': 'Recorded dependency repair is waiting for the existing writer drain; no additional stop was sent.'}
            sync = root / 'hermes_cli/venv_sync.py'
            if sync.is_file():
                recovery.state['sync_failed'] = True
                recovery.save(tree)
                synced = _command([sys.executable, '-m', 'hermes_cli.venv_sync', '--project-root', str(root), '--json'], root, 300, stopped, custody)
                response = json.loads(synced['detail']) if synced['ok'] else {}
                if response.get('ok') is not True:
                    return {'ok': False, 'detail': 'Recorded dependency repair failed: ' + str(response.get('detail') or synced['detail'])}
                recovery.state['sync_failed'] = False
                transaction = recovery.state.setdefault('transaction', {'revision': revision, 'homes': [str(runtime.hermes_home)]})
                transaction['dependencies_verified'] = True
                recovery.save(tree)
                return _resume_current(root, custody, stopped, complete_revision)
            elif recovery.state.get('sync_failed'):
                return {'ok': False, 'detail': 'The recorded dependency repair module is missing.'}
        whole, why = records.tree_is_whole(tree, root)
        if not whole:
            return {'ok': False, 'detail': 'Recorded source/dependency repair remains unverified: ' + why}
        pending = _command(custody.git_argv(['git'], ['for-each-ref', '--format=%(objectname)', 'refs/talaria/autostash/pending/']), root, 10, stopped, custody)
        if not pending['ok']:
            return {'ok': False, 'detail': 'Retained local edits could not be inspected.'}
        if pending['detail']:
            return {'ok': False, 'local_restore': True, 'revision': revision, 'detail': 'Retained local edits require the existing leased restore path.'}
        main_module = importlib.import_module("hermes_cli.main")
        if not Path(main_module.__file__).resolve().is_relative_to(root):
            raise RuntimeError("Gateway recovery loaded another Agent runtime.")
        records.recover(argv=[])
        try:
            recovery.resume(_writer_ledger)
        except services.GatewayDraining as exc:
            return {'ok': False, 'draining': True, 'detail': str(exc)}
        owed = records.record_path().exists() or bool(records._claims(records.record_path())) or bool(recovery.state['entries'])
        runtime_pending = bool((marker and marker.exists()) or (recovery.state.get('transaction') or {}).get('runtime_revision'))
        if not owed and runtime_pending:
            transaction = recovery.state.setdefault('transaction', {'revision': revision, 'homes': [str(runtime.hermes_home)]})
            if complete_revision == revision and transaction.get('runtime_revision') == revision:
                runtime_pending = False
            else:
                transaction['runtime_revision'] = revision
                recovery.save(tree)
        if not owed and not runtime_pending:
            recovery.state.pop('transaction', None)
            recovery.state['sync_failed'] = False
            recovery.save()
            if marker:
                marker.unlink(missing_ok=True)
        return {"ok": not owed, "revision": revision, "runtime_pending": runtime_pending, "detail": "Gateway recovery remains durably recorded." if owed else ""}
    finally:
        lock.release()


def _patch_paths(root, patch, stopped, custody):
    result = _command(custody.git_argv(["git"], ["apply", "--numstat", "-z", patch]), root, 10, stopped, custody)
    if not result["ok"]:
        raise RuntimeError("Local restore paths could not be bound to the native recovery journal.")
    rows, paths, index = result["detail"].split("\0"), [], 0
    while index < len(rows) and rows[index]:
        fields = rows[index].split("\t", 2)
        if len(fields) != 3:
            raise RuntimeError("Invalid local restore path evidence.")
        if fields[2]:
            paths.append(fields[2])
            index += 1
        else:
            if index + 2 >= len(rows) or not rows[index + 1] or not rows[index + 2]:
                raise RuntimeError("Invalid renamed local restore path evidence.")
            paths.extend(rows[index + 1:index + 3])
            index += 3
    return paths


def _command(argv, root, timeout, stopped, custody, *, cooperative=False):
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        child = custody.popen(argv, inherit_lock=True, cwd=root, stdin=subprocess.PIPE if cooperative else subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                              start_new_session=os.name != "nt")
        deadline = time.monotonic() + timeout
        try:
            while child.poll() is None:
                if stopped.wait(.05) or time.monotonic() >= deadline:
                    if cooperative:
                        child.stdin.close()
                        try:
                            child.wait(timeout=330)
                        except subprocess.TimeoutExpired:
                            child.kill()  # The service journal still owns unverified resume.
                            child.wait()
                    else:
                        _stop_tree(child)
                    return {"ok": False, "detail": "Agent update command cancelled or timed out."}
            out = stdout if child.returncode == 0 else stderr
            out.seek(0, os.SEEK_END)
            size = out.tell()
            if size > 16 * 1024 * 1024:
                return {"ok": False, "detail": "Agent update command output exceeds limit."}
            out.seek(0)
            return {"ok": child.returncode == 0, "detail": out.read().decode("utf-8", errors="replace").strip()}
        finally:
            if cooperative:
                child.stdin.close()
            if child.poll() is None:
                _stop_tree(child)


def main():
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
        os.environ.pop(key, None)
    if len(sys.argv) > 2 and sys.argv[1] in {'--recover-current', '--resume', '--resume-leased', '--select-resume'}:
        try:
            _native_source_repair(Path(sys.argv[2]).resolve())
            if sys.argv[1] == '--select-resume':
                _select_resume(Path(sys.argv[2]).resolve(), sys.argv[3], sys.argv[4])
        except BaseException as exc:
            print(json.dumps({'ok': False, 'detail': str(exc) if str(exc) != '1' else 'Native recorded source repair could not complete; its receipt remains owed.'}), flush=True)
            return
    from .__main__ import _claim_stdout
    output = _claim_stdout()
    stopped, requests = threading.Event(), queue.Queue()
    def read():
        try:
            for line in sys.stdin:
                requests.put(json.loads(line))
        finally:
            stopped.set()
    threading.Thread(target=read, daemon=True).start()
    def send(result):
        output.write((json.dumps(result) + "\n").encode())
    try:
        if sys.argv[1] == "--recover-current":
            root = Path(sys.argv[2]).resolve()
            sys.path.insert(0, str(root))
            custody = importlib.import_module('hermes_cli.update_custody')
            update_lock = importlib.import_module('hermes_cli.update_lock')
            if any(not Path(module.__file__).resolve().is_relative_to(root) for module in (custody, update_lock)):
                raise RuntimeError('Recovery loaded another Agent checkout.')
            lock = update_lock.UpdateLock(install_root=root)
            if not lock.acquire():
                raise RuntimeError('Another Agent update owns the native checkout lock.')
            try:
                send(_resume_current(root, custody, stopped, sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None))
            finally:
                lock.release()
            return
        if sys.argv[1] in {"--resume", "--resume-leased"}:
            with contextlib.redirect_stdout(sys.stderr):
                if len(sys.argv) > 4 and sys.argv[4]:
                    _verify_recovery_environment(Path(sys.argv[2]).resolve(), sys.argv[4])
                reply = _resume_worker(Path(sys.argv[2]).resolve(), stopped if sys.argv[1] == "--resume-leased" else None, sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None)
            send(reply)
            return
        with contextlib.redirect_stdout(sys.stderr):
            _worker(Path(sys.argv[1]).resolve(), sys.argv[2], {Path(h).resolve() for h in json.loads(sys.argv[3])}, requests, stopped, send, sys.argv[4] if len(sys.argv) > 4 else None)
    except BaseException as exc:
        send({"ok": False, "detail": str(exc)})


if __name__ == "__main__":
    main()
