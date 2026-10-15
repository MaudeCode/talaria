"""A lifetime-leased Agent update supervisor, extending dependency_sync's child custody.

Agent code is loaded only in the separate worker, before source changes. Its native
checkout lock and pause journal remain authoritative; Web never invents a pause format.
"""
from __future__ import annotations

import contextlib
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

_SESSIONS = {}
_SESSIONS_LOCK = threading.Lock()


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


def _exchange(session, request, ctx):
    with session["lock"]:
        if request is not None:
            session["proc"].stdin.write(json.dumps(request) + "\n")
            session["proc"].stdin.flush()
        deadline = time.monotonic() + 330
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
            if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                raise RpcError("Invalid Agent writer lease response.", condition="agent_update_unsafe")
            return {"ok": result["ok"], "skipped": result.get("skipped") is True, "detail": str(result.get("detail") or "")}


def call(runtime, ctx, params):
    root = runtime.agent_dir
    expected = params.get("agent_dir")
    if root is None or not isinstance(expected, str) or not expected or Path(expected).resolve() != root.resolve():
        raise InvalidParams("agent_dir must match the sidecar's configured Agent checkout")
    action = params.get("action")
    if action not in {"begin", "git", "sync", "finish"}:
        raise InvalidParams("invalid Agent mutation action")
    if action == "begin":
        revision = params.get("revision")
        homes = params.get("homes")
        if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise InvalidParams("an immutable target revision is required")
        if not isinstance(homes, list) or not homes or not all(isinstance(home, str) and Path(home).is_absolute() for home in homes):
            raise InvalidParams("resolved profile homes are required")
        if any(Path(home).resolve().is_relative_to(root.resolve()) for home in homes):
            raise InvalidParams("Agent profile homes must stay outside the source checkout to survive update cleanup")
        with _SESSIONS_LOCK:
            for old_token, old in list(_SESSIONS.items()):
                if old["proc"].poll() is not None:
                    _SESSIONS.pop(old_token)
                    _close(old)
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
                proc = subprocess.Popen([sys.executable, "-m", "talaria_sidecar.agent_mutation", str(root), revision, json.dumps(homes)],
                                        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
            except BaseException:
                stderr.close()
                _ACTION_LOCK.release()
                raise
            token = uuid.uuid4().hex
            session = {"root": root.resolve(), "proc": proc, "stderr": stderr, "lock": threading.RLock(),
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
    if windows is None:
        units, jobs = pause._discover_systemd(), pause._discover_launchd()
        units, jobs, notices = pause._left_running(units, jobs)
        bare, more = pause._discover_bare({entry["pid"] for entry in units + jobs})
        if notices or more:
            raise RuntimeError("A gateway cannot be safely quiesced: " + "; ".join(notices + more))
        entries = units + jobs + bare
    else:
        from hermes_cli.gateway import _capture_gateway_argv
        _, services, _, running = windows._discover_windows_gateways()
        by_pid = {int(service.gateway_pid): service for service in services}
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
        if live is not True or entry.get("pid") not in pids:
            raise RuntimeError("An Agent writer has no proven cooperative gateway pause; stop it before updating.")
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


def _worker(root, revision, homes, requests, stopped, send):
    if os.name not in {"posix", "nt"}:
        raise RuntimeError("A cooperative Agent writer lease is unavailable on this platform; source was not changed.")
    sys.path.insert(0, str(root))
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
        os.environ.pop(key, None)
    # Keep the installed updater's resume closure loaded across replacement of its source files.
    modules = {name: importlib.import_module("hermes_cli." + name) for name in (
        "update_lock", "update_cmd_posix_pause", "update_pause_record", "update_cmd_pause_gate",
        "update_cmd_windows", "update_custody", "process_identity")}
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
    try:
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
            if (not adopted or (initial != revision and needs_sync) or _writer_ledger(root, identity)
                    or any(records.identity_is_live({"pid": int(pid), "ct": ct}) for pid, ct in adopted.get("identities", {}).items())):
                raise RuntimeError("The Agent environment cannot import and its writers cannot be proved quiesced; use native recovery first.")
            bootstrap_repair = True
        entries = [] if bootstrap_repair else _owners(root, homes, pause, identity, windows)
        recovery_only = (bootstrap_repair and needs_sync) or bool(adopted and not records.tree_is_whole(adopted, root)[0])
        token = pause._empty_token()
        if windows is not None:
            token.pop("platform", None)
            services = [e for e in entries if e.get("kind") == "windows-service"]
            token.update(services=[e["service"] for e in services], expected_services=[e["service"] for e in services], restarted_services=[],
                         service_profiles={e["service"]: e["profile"] for e in services})
        token.update(posix_units=[e for e in entries if e.get("kind") and windows is None], unmapped=[e for e in entries if not e.get("kind")],
                     unmapped_pids=[e["pid"] for e in entries if not e.get("kind")],
                     identities={str(e["pid"]): records.identity(e["pid"])["ct"] for e in entries}, resume_needed=bool(entries))
        from gateway.status import get_process_start_time
        for entry in entries:
            entry["ct"] = get_process_start_time(entry["pid"])
            if entry["ct"] is None or token["identities"][str(entry["pid"])] is None:
                raise RuntimeError("Gateway process identity could not be proved.")
        records.record_pause(token, adopted, claims)
        records.mark_stop_requested(token, [e["pid"] for e in entries])
        for entry in entries:
            records.mark_stop_sent(token, entry["pid"])
            # mark_stop_sent is best effort upstream; this producer requires a durable request before sending it.
            records.write(token)
            if not pause._ask_to_drain(entry):
                raise RuntimeError("A gateway did not acknowledge cooperative quiescence; source was not changed.")
        deadline = time.monotonic() + min(pause._drain_budget(), 300)
        waiting = list(entries)
        while waiting:
            for entry in list(waiting):
                if not pause._alive(entry["pid"], entry["ct"]):
                    if entry.get("kind") == "windows-service":
                        _, service = windows._win_service(entry["service"])
                        if service.status() != "stopped":
                            windows._stop_windows_gateway_service(entry["service"], expected_processes=tuple(map(tuple, entry["descendants"])),
                                                                 expected_service_identity=(entry["service_pid"], entry["service_ct"]))
                    else:
                        pause._disarm(entry)
                    waiting.remove(entry)
            if waiting and (stopped.wait(.05) or time.monotonic() >= deadline):
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
            if request["action"] == "sync":
                argv = [sys.executable, "-m", "hermes_cli.venv_sync", "--project-root", str(root), "--json"]
                if not (root / "hermes_cli/venv_sync.py").is_file():
                    sync_failed = needs_sync
                    send({"ok": not needs_sync, "skipped": True, "detail": "The target's dependency repair module is missing." if needs_sync else ""})
                    continue
                sync_failed = True
                result = _command(argv, root, 300, stopped, modules["update_custody"])
                try:
                    response = json.loads(result["detail"]) if result["ok"] else {}
                    result["ok"] = result["ok"] and response.get("ok") is True
                    result["detail"] = str(response.get("detail") or result["detail"])
                except ValueError:
                    result = {"ok": False, "detail": "Agent dependency sync returned an invalid result."}
                sync_failed = not result["ok"]
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
                with gate as step:
                    argv = modules["update_custody"].git_argv(["git"], args)
                    result = _command(argv, root, seconds, stopped, modules["update_custody"])
                    if result["ok"] and applying:
                        step["whole"] = True
                if result["ok"] and applying and whole_before:
                    after = records.tree_state(root)
                    if before is None or after is None or before["pre_sha"] != after["pre_sha"]:
                        raise RuntimeError("The completed local restore could not be verified; gateway resume remains owed.")
                    # A completed atomic apply at the pause's own HEAD is an intended edit, not a torn move.
                    for baseline in token.get("baselines", []):
                        if baseline.get("pause_id") == token.get("pause_id") and baseline.get("pre_sha") == after["pre_sha"]:
                            baseline.update(after)
                    records.write(token)
            send(result)
    except BaseException as exc:
        error = str(exc)
    finally:
        try:
            if token:
                live = any(records.identity_is_live({"pid": int(pid), "ct": ct}) for pid, ct in token.get("identities", {}).items())
                found = _command(modules["update_custody"].git_argv(["git"], ["rev-parse", "HEAD"]), root, 10, threading.Event(), modules["update_custody"])
                if not found["ok"]:
                    raise RuntimeError("Gateway resume remains owed because the Agent revision is unverified.")
                final_tree = records.tree_state(root)
                if final_tree is None or final_tree.get("dirty_at_pause") is None:
                    raise RuntimeError("Gateway resume remains owed because the source tree is unverified.")
                changed = found["detail"] != initial or final_tree != initial_tree
                if live or sync_failed or (changed and needs_sync and not locals().get("response", {}).get("ok")):
                    raise RuntimeError("Gateway resume remains owed until writer drain and dependency repair complete.")
                whole, why = records.tree_is_whole(token, root)
                if not whole:
                    raise RuntimeError("Gateway resume remains owed: " + why)
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
            if token and not handed_off:
                records.discharge(token)
        except BaseException as exc:
            error = (error + "; " if error else "") + str(exc)
            if token and not handed_off:
                records.write({**token, "resume_needed": True}, owner=records.UNOWNED)
        finally:
            lock.release()
    send({"ok": error is None, "detail": error or ""})


def _resume_current(root, custody):
    try:
        from hermes_cli._launchers import resolve_store_python
        python = resolve_store_python(root)
    except ModuleNotFoundError as exc:
        if exc.name != "hermes_cli._launchers":
            raise
        python = None
    if python is None:
        python = next((path for path in (root / ".venv/bin/python", root / "venv/bin/python", root / "venv/Scripts/python.exe") if path.is_file()), Path(sys.executable))
    result = _command([str(python), "-m", "talaria_sidecar.agent_mutation", "--resume", str(root)], root, 300, threading.Event(), custody)
    try:
        reply = json.loads(result["detail"]) if result["ok"] else {}
        return {"ok": result["ok"] and reply.get("ok") is True, "detail": str(reply.get("detail") or result["detail"])}
    except ValueError:
        return {"ok": False, "detail": "The current Agent could not verify its retained gateway resume obligation."}


def _resume_worker(root):
    sys.path.insert(0, str(root))
    from hermes_cli import update_lock, update_pause_record as records
    if any(not Path(module.__file__).resolve().is_relative_to(root) for module in (update_lock, records)):
        raise RuntimeError("Gateway recovery loaded another Agent checkout.")
    lock = update_lock.UpdateLock(install_root=root)
    if not lock.acquire():
        raise RuntimeError("The gateway recovery child could not join the native checkout lease.")
    try:
        main_module = importlib.import_module("hermes_cli.main")
        if not Path(main_module.__file__).resolve().is_relative_to(root):
            raise RuntimeError("Gateway recovery loaded another Agent runtime.")
        records.recover(argv=[])
        owed = records.record_path().exists() or bool(records._claims(records.record_path()))
        return {"ok": not owed, "detail": "Gateway recovery remains durably recorded." if owed else ""}
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


def _command(argv, root, timeout, stopped, custody):
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        child = custody.popen(argv, inherit_lock=True, cwd=root, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                              start_new_session=os.name != "nt")
        deadline = time.monotonic() + timeout
        try:
            while child.poll() is None:
                if stopped.wait(.05) or time.monotonic() >= deadline:
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
            if child.poll() is None:
                _stop_tree(child)


def main():
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
        if sys.argv[1] == "--resume":
            send(_resume_worker(Path(sys.argv[2]).resolve()))
            return
        with contextlib.redirect_stdout(sys.stderr):
            _worker(Path(sys.argv[1]).resolve(), sys.argv[2], {Path(h).resolve() for h in json.loads(sys.argv[3])}, requests, stopped, send)
    except BaseException as exc:
        send({"ok": False, "detail": str(exc)})


if __name__ == "__main__":
    main()
