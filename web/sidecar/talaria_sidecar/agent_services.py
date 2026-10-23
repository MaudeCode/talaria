"""Service identities and backend recovery extending agent_mutation's native lease.

Bare/Windows gateways keep the native journal. A checkout-locked companion owns
POSIX supervisor obligations and verifies actual gateway/backend readiness.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import plistlib
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

STOP_SECONDS = 30.0
READY_SECONDS = 30.0
SNAPSHOT_ATTEMPTS = 4
# Bounds a native drain configured to wait indefinitely; the retained debt outlives it.
GATEWAY_DRAIN_CEILING = 4 * 3600.0
# One orphan-recovery attempt must fit its 660-second recovery RPC; its debt drives the next attempt.
RECOVERY_DRAIN_SECONDS = 300.0


@contextlib.contextmanager
def _native_home(home):
    """Resolve native per-profile configuration for one home in this single-purpose worker."""
    previous = os.environ.get('HERMES_HOME')
    os.environ['HERMES_HOME'] = str(home)
    try:
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    except ImportError:  # Older Agents resolve the home from the environment alone.
        set_hermes_home_override = None
    token = set_hermes_home_override(home) if set_hermes_home_override else None
    try:
        yield
    finally:
        if token is not None:
            reset_hermes_home_override(token)
        if previous is None:
            os.environ.pop('HERMES_HOME', None)
        else:
            os.environ['HERMES_HOME'] = previous


def drain_budget(pause, homes, ceiling=GATEWAY_DRAIN_CEILING):
    """One shared drain budget: the longest native after-turn + stop-drain budget among the homes, bounded."""
    budget = 0.0
    for home in sorted({str(home) for home in homes}):
        with _native_home(home):
            native = float(pause._drain_budget())
        # A native wait-indefinitely budget (inf or NaN) takes the ceiling before any comparison.
        budget = max(budget, native if math.isfinite(native) else ceiling)
    return min(budget, ceiling)


@contextlib.contextmanager
def gateway_fence(entry):
    from gateway import status
    home = Path(entry['home'])
    path = status._get_gateway_lock_path(home / 'gateway.pid')
    with os.fdopen(os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK), 'r+') as fence:
        info = os.fstat(fence.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError(f'{_name(entry)} gateway lock is not an exclusive regular file; recovery remains owed.')
        if not status._try_acquire_file_lock(fence):
            yield None
            return
        try:
            # A live, explicitly non-gateway owner keeps native stale-PID cleanup
            # from replacing this held lock inode. The companion debt owns recovery.
            opened, current = os.fstat(fence.fileno()), path.stat()
            if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
                raise RuntimeError(f'{_name(entry)} gateway runtime fence changed; recovery remains owed.')
            marker = {**status._build_pid_record(), 'kind': 'talaria-update-fence', 'hermes_home': str(home)}
            if marker.get('start_time') is None:
                raise RuntimeError(f'{_name(entry)} updater birth identity is unverified; recovery remains owed.')
            fence.seek(0)
            fence.truncate()
            json.dump(marker, fence)
            fence.flush()
            os.fsync(fence.fileno())
            yield fence
        finally:
            status._release_file_lock(fence)


def _verify_fence(entry, fence):
    from gateway import status
    path = status._get_gateway_lock_path(Path(entry['home']) / 'gateway.pid')
    try:
        opened, current = os.fstat(fence.fileno()), path.stat()
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino) or current.st_nlink != 1:
            raise ValueError('replaced or linked inode')
        marker = json.loads(path.read_text())
        if (marker.get('kind') != 'talaria-update-fence' or marker.get('pid') != os.getpid()
                or marker.get('start_time') != status.get_process_start_time(os.getpid())):
            raise ValueError('changed owner')
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        raise RuntimeError(f'{_name(entry)} gateway runtime fence changed; recovery remains owed.') from exc


def recovery_path(root, home):
    key = hashlib.sha256(os.fsencode(Path(root).resolve())).hexdigest()
    return Path(home) / '.talaria-agent-services' / (key + '.json')


def _process_table():
    result = subprocess.run(['ps', '-A', '-o', 'pid=,ppid='], capture_output=True, text=True, timeout=10, check=True)
    parents = {}
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) != 2 or not all(f.isdigit() for f in fields):
            raise RuntimeError('The process ancestry inventory is unreadable.')
        parents[int(fields[0])] = int(fields[1])
    if not parents:
        raise RuntimeError('The process ancestry inventory is empty.')
    return parents


def _ancestors(pid, parents):
    result = []
    while pid > 1:
        if pid in result or pid not in parents:
            raise RuntimeError(f'Process {pid} ancestry could not be proved.')
        result.append(pid)
        pid = parents[pid]
    return result


def _descendants(root, parents):
    found, pending = set(), [root]
    while pending:
        pid = pending.pop()
        if pid in found:
            raise RuntimeError('The process inventory contains an ancestry cycle.')
        found.add(pid)
        pending.extend(p for p, parent in parents.items() if parent == pid)
    return found


def _name(entry):
    return entry.get('label') or entry.get('unit') or f"PID {entry['pid']}"


def _service_key(entry):
    return (entry['kind'], entry.get('domain') or entry.get('scope'), entry.get('label') or entry.get('unit'))


def snapshot(entry, *, records=None, expected=None):
    """Attest a complete live tree, retrying only proved exits/new discoveries."""
    from gateway.status import get_process_start_time, _pid_exists
    service, pid = entry.get('service_pid', entry['pid']), entry['pid']
    anchors = {service, pid}
    observed = {**entry.get('departed_processes', {}), **(expected or {})}
    seen_parents = {int(p): proof['parent'] for p, proof in observed.items() if 'parent' in proof}
    departed = set(map(int, entry.get('departed_processes', {})))

    def exited(p):
        live = _pid_exists(p)
        if live is None:
            raise RuntimeError(f'{_name(entry)} process {p} liveness is unreadable; source was not changed.')
        if live is False:
            if p in anchors:
                raise RuntimeError(f'{_name(entry)} anchor process {p} disappeared during discovery; source was not changed.')
            departed.add(p)
            return True
        return False

    def inventory():
        parents = _process_table()
        if service not in _ancestors(pid, parents):
            raise RuntimeError(f'{_name(entry)} identity/ancestry changed: does not own backend/gateway PID {pid}.')
        if service in _ancestors(os.getpid(), parents):
            raise RuntimeError(f'{_name(entry)} owns the updater or an ancestor; source was not changed.')
        for p, parent in seen_parents.items():
            if parents.get(p) != parent:
                if p not in parents and exited(p):
                    continue
                raise RuntimeError(f'{_name(entry)} process {p} identity/ancestry changed during discovery; source was not changed.')
        descendants = _descendants(service, parents)
        # Successor retries cannot discard a live writer from a previously observed tree.
        for p in seen_parents.keys() - descendants - departed:
            if not exited(p):
                raise RuntimeError(f'{_name(entry)} process {p} remains live outside the attested tree; recovery remains owed.')
        seen_parents.update({p: parents[p] for p in descendants})
        # Zombies may remain in ps. Recheck departed PIDs at every inventory so
        # neither a recycled PID nor unknown liveness can be silently excluded.
        if any(_pid_exists(p) is not False for p in departed):
            raise RuntimeError(f'{_name(entry)} a departed descendant PID became live or unreadable; source was not changed.')
        return parents, descendants - departed

    def read(p, parents):
        if exited(p):
            return None
        proof = {'birth': get_process_start_time(p), 'parent': parents[p]}
        if records is not None:
            proof['ct'] = records.identity(p)['ct']
        if proof['birth'] is None or (records is not None and proof['ct'] is None):
            if exited(p):
                return None
            raise RuntimeError(f'{_name(entry)} process {p} birth identity is live or unreadable; source was not changed.')
        if exited(p):
            return None
        if any(proof.get(key) != value for key, value in observed.get(str(p), {}).items()):
            raise RuntimeError(f'{_name(entry)} process {p} identity/ancestry changed during discovery; source was not changed.')
        observed[str(p)] = proof
        return proof

    for _ in range(SNAPSHOT_ATTEMPTS):
        parents, live = inventory()
        proofs = {str(p): read(p, parents) for p in sorted(live)}
        after, remaining = inventory()
        for p in sorted(live & remaining):
            read(p, after)
        _, final = inventory()
        if live & departed or remaining != live or final != live:
            continue
        if departed:
            entry['departed_processes'] = {str(p): observed.get(str(p), {'parent': seen_parents[p]}) for p in departed}
        return proofs
    raise RuntimeError(f'{_name(entry)} process inventory kept changing after {SNAPSHOT_ATTEMPTS} samples; retry when descendants settle. Source was not changed and recovery remains owed.')


def _gateway_home_matches(home, runtime, pause):
    """Keep native identity policy, decoding only native-recognized inline launchers."""
    from gateway import status
    home = Path(home).resolve()
    observed = pause._home_of(runtime[0])
    command = status._read_process_cmdline(runtime[0])
    if not observed or Path(observed).resolve() != home or not command:
        return False
    try:
        from gateway.status_inline_source import command_line_runs_inline_source, inline_bootstrap_argv
    except ImportError:
        return False  # Older Agents cannot prove this launcher; retain recovery debt.
    try:
        tokens = [t.strip("\"'").replace('\\', '/') for t in shlex.split(command, posix=False)]
    except ValueError:
        return False
    if not command_line_runs_inline_source(tokens):
        return pause._gateway_on_home(str(home), set()) == runtime[0]
    argv = inline_bootstrap_argv(tokens)
    if argv is None:
        return False
    for index, arg in enumerate(argv):
        if arg.startswith('HERMES_HOME='):
            if not status._same_hermes_home(arg.removeprefix('HERMES_HOME='), home):
                return False
            argv[index] = 'HERMES_HOME=' + str(home)
    effective = ' '.join(argv)
    if (not status.looks_like_gateway_command_line(effective)
            or not status._command_line_belongs_to_profile(effective, home)
            or status._process_is_stopped(runtime[0])):
        return False
    profile = status.profile_flag_value(effective)
    if profile is not None and profile != (status._profile_name_for_home(home) or 'default'):
        return False
    pid_path = home / 'gateway.pid'
    records = [status._read_gateway_lock_record(status._get_gateway_lock_path(pid_path))]
    if pid_path.exists():
        records.append(status._read_pid_record(pid_path))
    if any(not record or status.recorded_gateway_home_conflicts(record, expected_home=home) for record in records):
        return False
    return status.get_running_pid_identity_strict(pid_path) == runtime


def gateway_entries(entries, homes, pause, *, allow_starting=False):
    if not entries:
        return []
    from gateway.status import get_running_pid_identity_strict
    found = {}
    for original in entries:
        entry = dict(original)
        home = Path(entry['home']).resolve() if entry.get('home') else None
        if home not in homes:
            raise RuntimeError(f'{_name(entry)} gateway owning profile is unknown or outside this Web instance.')
        runtime = get_running_pid_identity_strict(home / 'gateway.pid')
        if runtime is None and allow_starting:
            continue  # Lock admission can precede PID publication; callers retain custody while waiting.
        if runtime is None or not _gateway_home_matches(home, runtime, pause):
            raise RuntimeError(f'{_name(entry)} has no verified gateway in its owning profile.')
        entry.update(service_pid=entry['pid'], pid=runtime[0], ct=runtime[1], home=str(home))
        entry['processes'] = snapshot(entry, expected={str(entry['pid']): {'birth': entry['ct']}})
        key = _service_key(entry)
        if key in found and found[key] != entry:
            raise RuntimeError(f'{_name(entry)} has conflicting discovery identities.')
        found[key] = entry
    if len({e['pid'] for e in found.values()}) != len(found):
        raise RuntimeError('More than one service claims the same gateway process.')
    return list(found.values())


def _plist(domain, label, argv, dashboard):
    matches = []
    for kind, directory in dashboard._launchd_plist_dirs():
        if (domain == 'system') != (kind == 'daemon'):
            continue
        path = directory / (label + '.plist')
        try:
            data = plistlib.loads(path.read_bytes())
        except FileNotFoundError:
            continue
        if data.get('Label') == label and data.get('ProgramArguments') == argv:
            matches.append(path.resolve())
    if len(set(matches)) != 1:
        raise RuntimeError(f'{label} original launchd configuration could not be proved.')
    return str(matches[0])


def _backend_identity(row, homes, identity):
    from hermes_cli import dashboard_procs, update_inventory, update_receipt
    if row.get('create_time') is None or identity._pid_alive_matches(row['pid'], row['create_time'], strict=True) is not True:
        raise RuntimeError(f"Agent backend PID {row['pid']} birth identity is unverified.")
    env = dashboard_procs._pid_environ(row['pid'])
    if env is None:
        raise RuntimeError(f"Agent backend PID {row['pid']} ownership environment is unreadable.")
    # Native is_desktop_owned_backend is bound to the caller's environment, not this target PID.
    desktop = env.get('HERMES_DESKTOP') == '1' and bool(env.get('HERMES_DASHBOARD_SESSION_TOKEN'))
    if desktop or row.get('isolated') or update_inventory._is_desktop_ssh_ledger_entry(row):
        raise RuntimeError(f"Agent backend PID {row['pid']} is Desktop/isolated-owned; its owner must stop it.")
    observed = dashboard_procs._hermes_home_for_pid(row['pid'])
    home = Path(observed).resolve() if observed else None
    if home not in homes or (row.get('hermes_home') and Path(row['hermes_home']).resolve() != home):
        raise RuntimeError(f"Agent backend PID {row['pid']} has an unknown or foreign owning profile.")
    profiles = {name for name, path in update_receipt._profile_homes() if Path(path).resolve() == home}
    if len(profiles) != 1 or (row.get('profile') and row['profile'] not in profiles):
        raise RuntimeError(f"Agent backend PID {row['pid']} has conflicting or ambiguous profile ownership.")
    if identity._pid_alive_matches(row['pid'], row['create_time'], strict=True) is not True:
        raise RuntimeError(f"Agent backend PID {row['pid']} birth identity changed during discovery.")
    return home, profiles.pop()


def backend_entry(row, homes, pause, identity):
    from hermes_cli import main_dashboard as dashboard
    from hermes_cli import update_inventory
    home, profile = _backend_identity(row, homes, identity)
    parents = _process_table()
    ancestors = _ancestors(row['pid'], parents)
    jobs = dashboard._loaded_launchd_backend_jobs()
    # Native ownership also admits argv-only matches; this lease requires a live ancestry witness.
    candidates = [job for job in jobs if job[3] in ancestors]
    owner = dashboard._launchd_job_owning_backend(row['pid'], shlex.split(row.get('argv') or ''), candidates, ancestors=ancestors)
    entry = dict(pid=row['pid'], purpose=row['purpose'], home=str(home), profile=profile,
                 host=row.get('host'), port=row.get('port'))
    if owner:
        domain, label, service_pid = owner
        if len({(j[0], j[1]) for j in candidates}) != 1:
            raise RuntimeError(f"Backend PID {row['pid']} has ambiguous launchd ownership.")
        argv = next(j[2] for j in candidates if j[:2] == owner[:2])
        entry.update(kind='launchd', domain=domain, label=label, service_pid=service_pid,
                     plist=_plist(domain, label, argv, dashboard))
    else:
        service_pid = next((p for p in ancestors if dashboard._get_systemd_service_for_pid(p)), None)
        if service_pid is None:
            raise RuntimeError(f"Agent backend PID {row['pid']} has no manageable supervised service; stop it through its owner.")
        unit = dashboard._get_systemd_service_for_pid(service_pid)
        cgroup = dashboard._get_pid_cgroup_path(service_pid)
        scope = dashboard._extract_scope_from_cgroup(cgroup or '')
        if scope not in {'user', 'system'} or pause._manage_cmd(scope) is None:
            raise RuntimeError(f'{unit} scope/management authority is unverified.')
        from hermes_cli.update_fleet_scope import systemd_unit_hermes_home
        scope_cmd = ['systemctl', '--user'] if scope == 'user' else ['systemctl']
        declared_home = systemd_unit_hermes_home(scope_cmd, unit)
        if (not update_inventory._serve_unit_matches_profile(entry['profile'], unit)
                or not declared_home or Path(declared_home).resolve() != home):
            raise RuntimeError(f'{unit} does not prove ownership of this backend profile; source was not changed.')
        entry.update(kind='systemd', unit=unit, scope=scope, cgroup=cgroup, service_pid=service_pid)
    _endpoint(entry)
    entry['processes'] = snapshot(entry)
    if identity._pid_alive_matches(row['pid'], row['create_time'], strict=True) is not True:
        raise RuntimeError(f"Agent backend PID {row['pid']} birth identity changed during discovery.")
    return entry


def _endpoint(entry):
    host, port = entry.get('host'), entry.get('port')
    if not isinstance(host, str) or not isinstance(port, int) or isinstance(port, bool) or not 0 < port <= 65535:
        raise RuntimeError(f'{_name(entry)} backend endpoint is unknown.')
    if host == 'localhost':
        return '127.0.0.1', port
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise RuntimeError(f'{_name(entry)} backend bind address is not a verified IP address.') from exc
    return ('::1' if address.version == 6 else '127.0.0.1') if address.is_unspecified else host, port


def _service_pid(entry):
    if entry['kind'] == 'launchd':
        from hermes_cli.gateway import _launchd_print_service_pid
        loaded, pid = _launchd_print_service_pid(entry['domain'], entry['label'])
        return loaded, pid
    from hermes_cli.update_cmd_fleet import _systemctl, _unit_main_pid
    cmd = ['systemctl', '--user'] if entry['scope'] == 'user' else ['systemctl']
    state = _systemctl(cmd + ['show', entry['unit'], '--property=ActiveState', '--value'], timeout=10)
    if state.returncode:
        raise RuntimeError(f'{_name(entry)} supervisor state is unreadable.')
    active = state.stdout.strip() not in {'inactive', 'failed'}
    return active, _unit_main_pid(cmd, entry['unit']) or None


def verify_processes(entry, records, *, stopping=False, fenced=False):
    from gateway.status import get_process_start_time, _pid_exists
    if not stopping:
        # Reuse discovery's bounded proof without granting permission to lose an anchor.
        candidate = dict(entry)
        for boundary in range(2):
            _, service_pid = _service_pid(entry)
            if service_pid != entry['service_pid']:
                raise RuntimeError(f'{_name(entry)} supervisor respawned during quiescence; source was not changed.')
            if 'config_stamp' in entry and _config_stamp(entry) != entry['config_stamp']:
                raise RuntimeError(f'{_name(entry)} service configuration changed; recovery remains owed.')
            if boundary == 0:
                candidate['processes'] = snapshot(candidate, records=records, expected=entry['processes'])
        entry.update(processes=candidate['processes'])
        if candidate.get('departed_processes'):
            entry['departed_processes'] = candidate['departed_processes']
        return True
    parents = _process_table()
    departed = set(map(int, entry.get('departed_processes', {})))
    for pid, expected in entry['processes'].items():
        pid = int(pid)
        if _pid_exists(pid) is False:
            if stopping:
                departed.add(pid)
                continue
            raise RuntimeError(f'{_name(entry)} process {pid} disappeared before its stop.')
        if (get_process_start_time(pid) != expected['birth'] or records.identity(pid)['ct'] != expected.get('ct')
                or parents.get(pid) != expected['parent']):
            if stopping and _pid_exists(pid) is False:
                departed.add(pid)
                continue
            raise RuntimeError(f'{_name(entry)} process {pid} identity/ancestry changed; source was not changed.')
    _, service_pid = _service_pid(entry)
    if service_pid and service_pid != entry['service_pid']:
        if fenced:
            return False
        raise RuntimeError(f'{_name(entry)} supervisor respawned during quiescence; source was not changed.')
    parents = _process_table()
    if any(_pid_exists(pid) is not False for pid in departed):
        raise RuntimeError(f'{_name(entry)} process identity/ancestry changed after departure; source was not changed.')
    for pid, expected in entry['processes'].items():
        if parents.get(int(pid)) != expected['parent']:
            if stopping and _pid_exists(int(pid)) is False:
                continue
            raise RuntimeError(f'{_name(entry)} process {pid} identity/ancestry changed; source was not changed.')
    if service_pid:
        for pid in _descendants(service_pid, parents):
            if str(pid) not in entry['processes']:
                if fenced:
                    return False
                raise RuntimeError(f'{_name(entry)} acquired an unrecorded descendant {pid}; source was not changed.')
    return True


def bind_processes(entry, records):
    if entry.get('processes'):
        verify_processes(entry, records)


def service_entry(entry):
    return {**entry, 'pid': entry.get('service_pid', entry['pid']), 'runtime_pid': entry['pid']}


def wait_stopped(entry, records, stopped, *, writers_only=False):
    pids = {pid: p for pid, p in entry['processes'].items()
            if not writers_only or int(pid) != entry['service_pid'] or int(pid) == entry['pid']}
    deadline = time.monotonic() + STOP_SECONDS
    while any(records.identity_is_live({'pid': int(pid), 'ct': p['ct']}) for pid, p in pids.items()):
        if stopped.wait(.05) or time.monotonic() >= deadline:
            raise RuntimeError(f'{_name(entry)} graceful stop has not completed; source was not changed and recovery remains owed.')
    if not writers_only and any(_service_pid(entry)):
        raise RuntimeError(f'{_name(entry)} supervisor is still active; source was not changed and recovery remains owed.')


def verify_listener(entry):
    """A legacy HTTP response has no PID identity; require OS socket ownership as well."""
    _endpoint(entry)
    pid, port = entry['pid'], entry['port']
    if sys.platform.startswith('linux'):
        owned = set()
        for path in Path(f'/proc/{pid}/fd').iterdir():
            with contextlib.suppress(FileNotFoundError):
                owned.add(os.readlink(path))
        listeners = set()
        for table in ('tcp', 'tcp6'):
            try:
                rows = Path('/proc/net/' + table).read_text().splitlines()[1:]
            except FileNotFoundError:
                if table == 'tcp6':
                    continue
                raise
            for line in rows:
                fields = line.split()
                if int(fields[1].split(':')[1], 16) == port and fields[3] == '0A':
                    listeners.add('socket:[' + fields[9] + ']')
        matched = bool(listeners) and listeners <= owned
    elif sys.platform == 'darwin':
        result = subprocess.run(['/usr/sbin/lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-Fp'],
                                capture_output=True, text=True, timeout=10, check=False)
        matched = result.returncode == 0 and {int(line[1:]) for line in result.stdout.splitlines() if line.startswith('p')} == {pid}
    else:
        matched = False
    if not matched:
        raise RuntimeError(f'{_name(entry)} legacy listener ownership could not be proved; source was not changed.')


def _auth(entry):
    from gateway import host_rendezvous as host
    from hermes_cli.dashboard_procs import _pid_environ
    env = _pid_environ(entry['pid']) or {}
    token = env.get('HERMES_DASHBOARD_SESSION_TOKEN') or ''
    record = host.read_record(host.ROLE_SERVE)
    if (record is not None and record.pid == entry['pid'] and record.home
            and Path(record.home).resolve() == Path(entry['home']).resolve()
            and record.port == entry['port'] and record.host == entry['host']
            and host.liveness_is_proven(record) and host.record_token_is_consistent(record)):
        token = host.read_token(host.ROLE_SERVE)
    return token


def _local_session(entry):
    """Use the owning user's existing native basic-auth key for a short-lived local lifecycle call."""
    from hermes_cli.dashboard_procs import _pid_environ
    try:
        from plugins.dashboard_auth import basic
    except ImportError:
        return None
    from .home import scoped_home
    from agent import secret_scope
    from hermes_cli.env_loader import hydrate_profile_secret_sources
    env = _pid_environ(entry['pid'])
    if env is None:
        return None
    home = Path(entry['home'])
    with scoped_home(home):
        hydrate_profile_secret_sources(home)
        # The launch scope also contains updater credentials; use only the owner's file-backed scope.
        scope = secret_scope.build_profile_secret_scope(home)
        scope.update({name: env[name] for name in ('HERMES_DASHBOARD_BASIC_AUTH_SECRET', 'HERMES_DASHBOARD_BASIC_AUTH_USERNAME')
                      if env.get(name, '').strip()})
        token = secret_scope.set_secret_scope(scope)
        # Config ${...} references must also refuse launch-environment fallback, including on the main profile.
        multiplex = secret_scope.set_multiplex_context(True)
        try:
            section = basic._load_config_basic_auth_section()
        finally:
            secret_scope.reset_multiplex_context(multiplex)
            secret_scope.reset_secret_scope(token)

        def setting(name, key):
            return str(scope.get(name) or '').strip() or str(section.get(key) or '').strip()

        secret = setting('HERMES_DASHBOARD_BASIC_AUTH_SECRET', 'secret')
        username = setting('HERMES_DASHBOARD_BASIC_AUTH_USERNAME', 'username')
        if not secret or not username:
            return None  # A process-random key is not reproducible; never manufacture a replacement key.
        # Native _resolve_secret reads os.environ directly. Match its base64/hex/raw order without mutating it.
        key = secret.encode('utf-8')
        for decoder in (base64.b64decode, bytes.fromhex):
            try:
                decoded = decoder(secret)
                if len(decoded) >= 16:
                    key = decoded
                    break
            except (ValueError, TypeError):
                pass
        return basic._sign({'sub': username, 'kind': 'access', 'exp': int(time.time()) + 60}, key)


class BackendLifecycleUnsupported(RuntimeError):
    """Terminal capability refusal, distinct from retryable recovery readiness."""


def backend_request(entry, action=None, permit=None):
    host, port = _endpoint(entry)
    token = _auth(entry)
    headers = {'X-Hermes-Session-Token': token, 'Authorization': 'Bearer ' + token}

    def request(path, body=None, *, authenticated=True, limit=65536):
        for attempt in range(2):
            connection = http.client.HTTPConnection(host, port, timeout=2)
            try:
                sent = {**headers, 'Content-Type': 'application/json'} if authenticated else {}
                connection.request('GET' if body is None else 'POST', path, body, sent)
                response = connection.getresponse()
                data = response.read(limit + 1)
                if authenticated and response.status == 401 and attempt == 0:
                    credential = _local_session(entry)
                    if credential:
                        headers['Authorization'] = 'Bearer ' + credential
                        continue
                if authenticated and response.status in {401, 403}:
                    raise RuntimeError(f'{_name(entry)} refused authenticated backend lifecycle access (HTTP {response.status}); source was not changed.')
                if len(data) > limit:
                    raise ValueError('oversized response')
                return response.status, json.loads(data) if response.status == 200 else None
            finally:
                connection.close()

    def verified_identity(status, result):
        return (status == 200 and isinstance(result, dict) and result.get('pid') == entry['pid']
                and result.get('role') == 'serve' and result.get('ok') is True)

    def capability_check(identity_status, identity):
        # The schema belongs to the running endpoint, never the checkout on disk.
        status, schema = request('/openapi.json', limit=4 * 1024 * 1024)
        if (status != 200 or not isinstance(schema, dict) or not isinstance(schema.get('paths'), dict)
                or not isinstance(schema.get('openapi'), str) or not schema['openapi'].startswith('3.')):
            raise RuntimeError(f'{_name(entry)} backend lifecycle/readiness schema could not be verified.')
        paths = schema['paths']
        for path, method in (('/api/host/identity', 'get'), ('/api/health/retirement', 'post')):
            route = paths.get(path, {})
            if not isinstance(route, dict) or (method in route and not isinstance(route[method], dict)):
                raise ValueError('malformed lifecycle schema')
        missing_identity = 'get' not in paths.get('/api/host/identity', {})
        missing_retirement = 'post' not in paths.get('/api/health/retirement', {})
        if not missing_identity and not missing_retirement:
            return
        if verified_identity(identity_status, identity):
            if missing_identity or not verified_identity(*request('/api/host/identity')):
                raise RuntimeError(f'{_name(entry)} backend lifecycle identity/schema changed or disagrees.')
        elif identity_status in {404, 405, 501} and missing_identity:
            challenge, _ = request('/api/sessions?limit=1', authenticated=False)
            accepted, sessions = request('/api/sessions?limit=1')
            if (challenge not in {401, 403} or accepted != 200 or not isinstance(sessions, dict)
                    or not isinstance(sessions.get('sessions'), list)
                    or request('/api/host/identity')[0] != identity_status):
                return
        else:
            return
        name = ''.join(c for c in str(_name(entry)) if c.isprintable())
        unverified = ' Backend listener identity remains unverified.' if missing_identity else ''
        raise BackendLifecycleUnsupported(
            f'{name} running backend lifecycle APIs are unsupported for safe Agent update custody.' + unverified
            + ' Finish active work, then have the owner gracefully refresh this service through its original supervisor.'
            + ' Verify the successor lifecycle APIs and intended installation/profile/PID, then retry the Agent update.'
            + ' Any retained service recovery remains owed.')

    try:
        body = None if action is None else json.dumps(dict(action=action, **({'token': permit} if permit else {})))
        status, result = request('/api/host/identity' if action is None else '/api/health/retirement', body)
        if action is None:
            if status == 200 and not verified_identity(status, result):
                raise RuntimeError(f'{_name(entry)} endpoint is not the expected backend process.')
            capability_check(status, result)
        elif status in {404, 405, 501}:
            capability_check(*request('/api/host/identity'))
        if status != 200:
            raise RuntimeError(f'{_name(entry)} backend lifecycle/readiness could not be verified (HTTP {status}).')
        if not isinstance(result, dict):
            raise ValueError('not an object')
        return result
    except (OSError, ValueError, TypeError, http.client.HTTPException) as exc:
        raise RuntimeError(f'{_name(entry)} backend lifecycle/readiness could not be verified.') from exc


def _config_stamp(entry):
    if entry['kind'] == 'launchd':
        return hashlib.sha256(Path(entry['plist']).read_bytes()).hexdigest()
    from hermes_cli.update_cmd_fleet import _systemctl
    cmd = ['systemctl', '--user'] if entry['scope'] == 'user' else ['systemctl']
    result = _systemctl(cmd + ['cat', entry['unit']], timeout=10)
    if result.returncode:
        raise RuntimeError(f'{_name(entry)} original service configuration is unreadable.')
    return hashlib.sha256(result.stdout.encode()).hexdigest()


def _start(entry, pause):
    if _config_stamp(entry) != entry['config_stamp']:
        raise RuntimeError(f'{_name(entry)} service configuration changed; backend recovery remains owed.')
    if entry['kind'] == 'launchd':
        # The native bootstrap helper boots out a concurrently loaded replacement on EIO.
        # This lease must adopt that replacement instead of killing its newly admitted work.
        if not _service_pid(entry)[0]:
            bootstrapped = subprocess.run(['launchctl', 'bootstrap', entry['domain'], entry['plist']],
                                         stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, check=False)
            if bootstrapped.returncode and not _service_pid(entry)[0]:
                raise RuntimeError(f'{_name(entry)} supervisor failed to load its original configuration.')
        result = subprocess.run(['launchctl', 'kickstart', f"{entry['domain']}/{entry['label']}"],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, check=False)
    else:
        from hermes_cli.update_cmd_fleet import _systemctl
        cmd = pause._manage_cmd(entry['scope'])
        if cmd is None:
            raise RuntimeError(f'{_name(entry)} cannot be resumed with current service privileges.')
        result = _systemctl(cmd + ['start', entry['unit']], timeout=30)
    if result.returncode:
        raise RuntimeError(f'{_name(entry)} supervisor failed to start its backend.')


class GatewayDraining(RuntimeError):
    """An acknowledged native drain is still within its native budget: progress, not a recovery failure."""


class ServiceRecovery:
    """Companion to the native pause token; all calls hold its existing checkout lock."""
    def __init__(self, root, home, records, identity, pause):
        self.root, self.records, self.identity, self.pause = root, records, identity, pause
        self.path = recovery_path(root, home)
        self._refresh_starts = set()  # Finally recovery must not retry a failed bootstrap in this worker.
        try:
            self.state = json.loads(self.path.read_text())
        except FileNotFoundError:
            self.state = {'schema': 1, 'root': str(root), 'entries': [], 'tree': {}, 'sync_failed': False}
        except (OSError, ValueError) as exc:
            raise RuntimeError('Backend recovery evidence is unreadable; source was not changed.') from exc
        if (not isinstance(self.state, dict) or self.state.get('schema') != 1 or self.state.get('root') != str(root)
                or not isinstance(self.state.get('entries'), list) or not isinstance(self.state.get('tree'), dict)
                or ('sync_failed' in self.state and not isinstance(self.state['sync_failed'], bool))):
            raise RuntimeError('Backend recovery evidence has an unknown identity or format; source was not changed.')
        if self.state['entries'] and (not self.state['tree'].get('baselines') or any(
                not isinstance(e, dict) or e.get('purpose') not in {'gateway', 'dashboard', 'serve'}
                or e.get('phase') not in {'recorded', 'retiring', 'stopped', 'refreshing'}
                or (e.get('phase') == 'refreshing' and e.get('legacy_refresh') is not True) or not isinstance(e.get('processes'), dict)
                for e in self.state['entries'])):
            raise RuntimeError('Service recovery lacks complete source/process custody evidence; source was not changed.')

        transaction = self.state.get('transaction')
        if transaction is not None and (
                not isinstance(transaction, dict) or not re.fullmatch(r'[a-f0-9]{40}', str(transaction.get('revision', '')))
                or not isinstance(transaction.get('homes'), list) or not transaction['homes']
                or any(not isinstance(home, str) or not Path(home).is_absolute() for home in transaction['homes'])
                or any(key in transaction and not isinstance(transaction[key], bool) for key in ('dependencies_verified',))
                or ('runtime_revision' in transaction and not re.fullmatch(r'[a-f0-9]{40}', str(transaction['runtime_revision'])))):
            raise RuntimeError('Service recovery transaction has an unknown identity or format; its evidence is retained.')

        operation = self.state.get('update_operation')
        if operation is not None and (
                not isinstance(operation, dict)
                or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', str(operation.get('operation_id', '')))
                or any(not re.fullmatch(r'[a-f0-9]{40}', str(operation.get(key, ''))) for key in ('baseline_revision', 'target_revision'))
                or ('attempt_error' in operation and (not isinstance(operation['attempt_error'], str) or len(operation['attempt_error']) > 2000))
                or ('source_moved' in operation and not isinstance(operation['source_moved'], bool))
                or ('failed_stage' in operation and operation['failed_stage'] not in {'install', 'gateway_restart', 'agent_ready'})
                or operation.get('stage') not in {'install', 'gateway_restart', 'agent_ready'}
                or ('recovered_revision' in operation and not re.fullmatch(r'[a-f0-9]{40}', str(operation['recovered_revision'])))):
            raise RuntimeError('Update operation correlation is malformed; its evidence is retained.')

    def save(self, token=None):
        if not self.state['entries'] and not self.state.get('sync_failed') and not self.state.get('transaction') and not self.state.get('update_operation'):
            if self.path.exists():
                self.path.unlink()
                self._sync_directory()
            return
        if token is not None:
            self.state['tree'] = json.loads(json.dumps({key: token[key] for key in ('pause_id', 'baselines') if key in token}))
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + '.')
        try:
            with os.fdopen(fd, 'w') as handle:
                json.dump(self.state, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            self._sync_directory()
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)

    def _sync_directory(self, directory=None):
        if os.name != 'nt':
            fd = os.open(directory if directory is not None else self.path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def prepare(self, entries, token):
        for entry in entries:
            old = next((e for e in self.state['entries'] if _service_key(e) == _service_key(entry)), None)
            if old is not None:
                if old['pid'] != entry['pid']:
                    raise RuntimeError(f'{_name(entry)} has unresolved prior backend recovery debt.')
                continue
            self.state['entries'].append({**entry, 'phase': 'recorded', 'config_stamp': _config_stamp(entry)})
        self.save(token)
        gateways = [e for e in self.state['entries'] if e['purpose'] == 'gateway']
        if gateways:
            # Persist custody here before retiring overlapping native obligations. Native replay
            # cannot distinguish a wrapper from its gateway and can rewrite the configured launcher.
            keys = {_service_key(e) for e in gateways}
            pids = {pid for e in gateways for pid in e['processes']}
            transferred = [e for e in token.get('posix_units', []) if _service_key(e) in keys]
            pids.update(str(e['pid']) for e in transferred)
            token['posix_units'] = [e for e in token.get('posix_units', []) if _service_key(e) not in keys]
            token['unmapped'] = [e for e in token.get('unmapped', []) if str(e['pid']) not in pids]
            token['unmapped_pids'] = [e['pid'] for e in token['unmapped']]
            token['identities'] = {pid: ct for pid, ct in token.get('identities', {}).items() if str(pid) not in pids}
            token['resume_needed'] = bool(token['posix_units'] or token['unmapped'] or token.get('profiles') or token.get('services'))
            self.records.write(token)
            self.save(token)

    def verify_processes(self, entry, **permissions):
        owed = next(e for e in self.state['entries'] if _service_key(e) == _service_key(entry))
        result = verify_processes(owed, self.records, **permissions)
        self.save()  # Updated custody must precede the next lifecycle effect.
        return result

    def stop(self, entry, stopped):
        owed = next(e for e in self.state['entries'] if _service_key(e) == _service_key(entry))
        self.verify_processes(owed)
        backend_request(owed)
        self.verify_processes(owed)
        permit = backend_request(owed, 'prepare')
        if permit.get('ok') is not True or permit.get('idle') is not True or not isinstance(permit.get('token'), str):
            if owed['phase'] == 'recorded':
                self.state['entries'].remove(owed)  # The native refusal created no retirement permit or stop.
                self.save()
            raise RuntimeError(f'{_name(owed)} has active work or cannot prove idle; source was not changed.')
        try:
            owed['phase'] = 'retiring'
            self.save()  # A lost commit reply still owes a full stop/resume of this incarnation.
        except BaseException:
            backend_request(owed, 'cancel', permit['token'])
            raise
        self.verify_processes(owed)
        if backend_request(owed, 'commit', permit['token']).get('ok') is not True:
            raise RuntimeError(f'{_name(owed)} did not commit its backend retirement; recovery remains owed.')
        owed['backend_committed'] = True
        self.save()
        self._stop_backend_supervisor(owed, stopped)

    def _stop_backend_supervisor(self, owed, stopped, *, stopping=False):
        # Disarm through the original manager before its KeepAlive can admit a successor.
        owed['backend_stop_requested'] = True
        self.save()
        self.verify_processes(owed, stopping=stopping)
        if _config_stamp(owed) != owed['config_stamp']:
            raise RuntimeError(f'{_name(owed)} service configuration changed before backend stop; recovery remains owed.')
        if stopped.is_set():
            raise RuntimeError(f'{_name(owed)} backend stop was cancelled; recovery remains owed.')
        self.pause._disarm(service_entry(owed))
        wait_stopped(owed, self.records, stopped)
        self.verify_processes(owed, stopping=True)
        owed['phase'] = 'stopped'
        self.save()

    def refresh(self, entry, stopped, ledger):
        owed = next(e for e in self.state['entries'] if _service_key(e) == _service_key(entry))
        if owed.get('legacy_refresh'):
            raise RuntimeError(f'{_name(entry)} legacy shutdown remains owed; no signal was replayed.')
        if _config_stamp(owed) != owed['config_stamp']:
            raise RuntimeError(f'{_name(entry)} configuration changed before legacy refresh.')
        self.verify_processes(owed)
        verify_listener(owed)
        owed.update(legacy_refresh=True, phase='refreshing')
        self.save()  # Older readers reject this phase and retain debt; no reader replays its signal.
        self.verify_processes(owed)
        verify_listener(owed)
        if _config_stamp(owed) != owed['config_stamp']:
            raise RuntimeError(f'{_name(owed)} configuration changed before legacy refresh.')
        self.verify_processes(owed)
        try:
            if stopped.is_set():
                raise InterruptedError('Legacy refresh was cancelled before interruption.')
            os.kill(owed['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass  # The consented incarnation already exited; only a verified successor can discharge debt.
        except (PermissionError, InterruptedError) as exc:
            self.state['entries'].remove(owed)
            self.save()  # The OS definitively refused delivery, so a new confirmation may retry it.
            raise RuntimeError(f'{_name(owed)} graceful refresh was cancelled or its signal was refused; source was not changed.') from exc
        self._refresh_successor(owed, stopped, ledger)

    def _refresh_successor(self, owed, stopped, ledger):
        wait_stopped(owed, self.records, stopped, writers_only=True)
        deadline = time.monotonic() + READY_SECONDS
        started = False
        while True:
            candidate = self._ready(owed, ledger)
            if candidate:
                if any(self.records.identity_is_live({'pid': int(pid), 'ct': p['ct']})
                       for pid, p in owed['processes'].items()
                       if int(pid) != owed['service_pid'] or int(pid) == owed['pid']):
                    raise RuntimeError(f'{_name(owed)} old writer descendants remain; recovery remains owed.')
                owed.clear()
                owed.update(candidate, phase='recorded', config_stamp=_config_stamp(candidate))
                self.save()
                return
            if not _service_pid(owed)[1] and not started:
                key = _service_key(owed)
                if key in self._refresh_starts:
                    raise RuntimeError(f'{_name(owed)} legacy refresh start was already attempted; retry Agent update recovery. Source was not changed and recovery remains owed.')
                whole, why = self.records.tree_is_whole(self.state['tree'], self.root)
                if not whole or self.state.get('sync_failed'):
                    raise RuntimeError('Legacy refresh source/dependency recovery remains owed: ' + why)
                self._refresh_starts.add(key)
                _start(owed, self.pause)
                started = True
            if stopped.wait(.05) or time.monotonic() >= deadline:
                raise RuntimeError(f'{_name(owed)} legacy refresh readiness is unverified; source was not changed and recovery remains owed.')

    def gateway_requested(self, entry, *, acknowledged=False):
        if not entry.get('processes'):
            return
        owed = next(e for e in self.state['entries'] if _service_key(e) == _service_key(entry))
        owed['phase'] = 'retiring'
        if acknowledged:
            owed.update(drain_acknowledged=True, drain_acknowledged_at=time.time())
        self.save()

    def _gateway_candidate(self, entry):
        units, jobs = self.pause._discover_systemd(), self.pause._discover_launchd()
        matches = [e for e in units + jobs if _service_key(e) == _service_key(entry)]
        if not matches:
            return None
        if len(matches) != 1 or not matches[0].get('home') or Path(matches[0]['home']).resolve() != Path(entry['home']).resolve():
            raise RuntimeError(f'{_name(entry)} successor supervisor/profile is unverified; recovery remains owed.')
        candidates = gateway_entries(matches, {Path(entry['home']).resolve()}, self.pause, allow_starting=True)
        if not candidates:
            return None
        candidate = candidates[0]
        if (_config_stamp(candidate) != entry['config_stamp']
                or candidate.get('profile') != entry.get('profile')):
            raise RuntimeError(f'{_name(entry)} successor configuration/profile changed; recovery remains owed.')
        if entry.get('departed_processes'):
            candidate['departed_processes'] = entry['departed_processes']
        bind_processes(candidate, self.records)
        parents = {int(pid): p['parent'] for pid, p in candidate['processes'].items()}
        chain, pid = set(), candidate['pid']
        while True:
            chain.add(pid)
            if pid == candidate['service_pid']:
                break
            pid = parents[pid]
        if chain | _descendants(candidate['pid'], parents) != set(parents):
            raise RuntimeError(f'{_name(entry)} successor has unrelated descendants; recovery remains owed.')
        for pid, process in candidate['processes'].items():
            old = (entry['processes'].get(pid) or entry.get('departed_processes', {}).get(pid)
                   or entry.get('retired_processes', {}).get(pid))
            if old is not None and old != process:
                raise RuntimeError(f'{_name(entry)} successor reused a recorded process identity; recovery remains owed.')
        return candidate

    def _gateway_writers_live(self, entry):
        processes = {**entry.get('retired_processes', {}), **entry['processes']}
        return any(self.records.identity_is_live({'pid': int(pid), 'ct': p['ct']})
                   for pid, p in processes.items()
                   if int(pid) != entry['service_pid'] or int(pid) == entry['pid'])

    def gateway_deadline(self, homes=None, ceiling=GATEWAY_DRAIN_CEILING):
        if homes is None:
            homes = [e['home'] for e in self.state['entries'] if e['purpose'] == 'gateway']
        return time.monotonic() + drain_budget(self.pause, homes, ceiling)

    def _drain_progressing(self, entry):
        """Live recorded writers still finishing an acknowledged drain within the native budget."""
        if not entry.get('drain_acknowledged') or not self._gateway_writers_live(entry):
            return False
        now = time.time()
        if not isinstance(entry.get('drain_acknowledged_at'), (int, float)):
            entry['drain_acknowledged_at'] = now  # Older custody has no time; its native budget starts when first observed.
            self.save()
        return 0 <= now - entry['drain_acknowledged_at'] < drain_budget(self.pause, [entry['home']])

    def settle_gateway(self, entry, stopped, *, deadline=None):
        owed = next(e for e in self.state['entries'] if _service_key(e) == _service_key(entry))
        self._settle_gateway(owed, stopped, deadline=deadline)

    def _settle_gateway(self, entry, stopped=None, *, deadline=None, ready=None):
        """Stop the recorded gateway; True when ``ready`` adopts a verified successor after the drain instead."""
        if not self._gateway_writers_live(entry) and not any(_service_pid(entry)):
            if _config_stamp(entry) != entry['config_stamp']:
                raise RuntimeError(f'{_name(entry)} service configuration changed; recovery remains owed.')
            entry['phase'] = 'stopped'
            self.save()
            return
        stopped = stopped or threading.Event()
        if deadline is None:
            deadline = self.gateway_deadline([entry['home']], RECOVERY_DRAIN_SECONDS)
        while True:
            if stopped.is_set() or time.monotonic() >= deadline:
                if not stopped.is_set() and self._drain_progressing(entry):
                    raise GatewayDraining(f'{_name(entry)} gateway drain remains owed while its acknowledged native drain finishes; recovery will retry.')
                raise RuntimeError(f'{_name(entry)} gateway drain remains owed; retry Agent update recovery.')
            if _config_stamp(entry) != entry['config_stamp']:
                raise RuntimeError(f'{_name(entry)} service configuration changed; recovery remains owed.')
            if self._gateway_writers_live(entry):
                if not entry.get('drain_acknowledged'):
                    raise RuntimeError(f'{_name(entry)} gateway drain remains owed; retry Agent update recovery.')
                stopped.wait(.05)
                continue
            if ready is not None and ready():
                return True  # The original drain finished under its supervisor; never drain or stop a ready successor.
            entry['runtime_fence_requested'] = True
            self.save()
            with gateway_fence(entry) as fence:
                if fence is not None:
                    while True:
                        _verify_fence(entry, fence)
                        if stopped.is_set() or time.monotonic() >= deadline:
                            raise RuntimeError(f'{_name(entry)} gateway startup contenders remain; recovery remains owed.')
                        _, service_pid = _service_pid(entry)
                        parents = _process_table()
                        # Pre-fence starters may still be in native stale-file cleanup.
                        # Wait for every unrecorded process to exit, never stop them.
                        pending = service_pid and (service_pid != entry['service_pid'] or any(
                            str(pid) not in entry['processes'] for pid in _descendants(service_pid, parents)))
                        if pending:
                            stopped.wait(.05)
                            continue
                        if not self.verify_processes(entry, stopping=True, fenced=True):
                            stopped.wait(.05)
                            continue
                        if self._gateway_writers_live(entry) or _config_stamp(entry) != entry['config_stamp']:
                            raise RuntimeError(f'{_name(entry)} gateway custody changed; recovery remains owed.')
                        _verify_fence(entry, fence)
                        self.pause._disarm(service_entry(entry))
                        wait_stopped(entry, self.records, stopped)
                        _verify_fence(entry, fence)
                        entry['phase'] = 'stopped'
                        self.save()
                        return
            if not entry.get('drain_acknowledged'):
                raise RuntimeError(f'{_name(entry)} successor appeared without an acknowledged drain; recovery remains owed.')
            candidate = self._gateway_candidate(entry)
            if candidate is not None:
                attempts = entry.get('settle_attempts', 0) + 1
                if attempts > 8:
                    raise RuntimeError(f'{_name(entry)} repeatedly respawned during drain; recovery remains owed.')
                retired = {**entry.get('retired_processes', {}), **entry['processes']}
                entry.update(candidate, retired_processes=retired, phase='retiring',
                             drain_acknowledged=False, drain_acknowledged_at=None, settle_attempts=attempts)
                self.save()  # Successor custody precedes its cooperative lifecycle request.
                self.verify_processes(entry)
                if _config_stamp(entry) != entry['config_stamp']:
                    raise RuntimeError(f'{_name(entry)} service configuration changed; recovery remains owed.')
                if not self.pause._ask_to_drain(entry):
                    raise RuntimeError(f'{_name(entry)} successor did not acknowledge cooperative drain; recovery remains owed.')
                entry.update(drain_acknowledged=True, drain_acknowledged_at=time.time())
                self.save()
            stopped.wait(.05)

    def resume(self, ledger, *, gateway_deadline=None):
        if not self.state['entries']:
            return
        whole, why = self.records.tree_is_whole(self.state['tree'], self.root)
        if not whole or self.state.get('sync_failed'):
            raise RuntimeError('Backend recovery remains owed until source/dependency repair completes: ' + why)
        failures, draining = [], True
        for entry in list(self.state['entries']):
            try:
                if self._ready(entry, ledger):
                    self.state['entries'].remove(entry)
                    self.save()
                    continue
                if entry.get('legacy_refresh'):
                    # EOF/crash recovery may adopt/start a successor, but never replay interruption consent.
                    if self.records.identity_is_live({'pid': entry['pid'], 'ct': entry['processes'][str(entry['pid'])]['ct']}):
                        raise RuntimeError(f'{_name(entry)} legacy shutdown remains owed; no signal was replayed.')
                    self._refresh_successor(entry, threading.Event(), ledger)
                    self.state['entries'].remove(entry)
                    self.save()
                    continue
                if entry['purpose'] == 'gateway':
                    if gateway_deadline is None:
                        gateway_deadline = self.gateway_deadline(ceiling=RECOVERY_DRAIN_SECONDS)
                    if self._settle_gateway(entry, deadline=gateway_deadline, ready=lambda entry=entry: self._ready(entry, ledger)):
                        self.state['entries'].remove(entry)
                        self.save()
                        continue
                    if not _service_pid(entry)[1]:
                        _start(entry, self.pause)
                    self._wait_ready(entry, ledger)
                    continue
                original_live = self.records.identity_is_live({'pid': entry['pid'], 'ct': entry['processes'][str(entry['pid'])]['ct']})
                if original_live:
                    if entry['phase'] == 'recorded':
                        raise RuntimeError(f'{_name(entry)} uncommitted retirement could not yet be cancelled; recovery remains owed.')
                    self.stop(entry, threading.Event())
                elif any(self.records.identity_is_live({'pid': int(pid), 'ct': p['ct']}) for pid, p in entry['processes'].items()):
                    self.verify_processes(entry, stopping=True)
                    if any(self.records.identity_is_live({'pid': int(pid), 'ct': p['ct']}) for pid, p in entry['processes'].items() if int(pid) != entry['service_pid']):
                        raise RuntimeError(f'{_name(entry)} still has live writer descendants; recovery remains owed.')
                    self._stop_backend_supervisor(entry, threading.Event(), stopping=True)
                _, active = _service_pid(entry)
                if not active:
                    _start(entry, self.pause)
                self._wait_ready(entry, ledger)
            except Exception as exc:
                draining = draining and isinstance(exc, GatewayDraining)
                failures.append(str(exc))
        if failures:
            # Sibling obligations recover independently; only an all-draining remainder is progress.
            raise (GatewayDraining if draining else RuntimeError)('; '.join(failures))

    def _wait_ready(self, entry, ledger):
        deadline = time.monotonic() + READY_SECONDS
        while True:
            if self._ready(entry, ledger):
                self.state['entries'].remove(entry)
                self.save()
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(f'{_name(entry)} readiness is unverified at its original endpoint; recovery remains owed.')
            time.sleep(.1)

    def _verify_candidate(self, candidate, entry):
        # Readiness retries must retain both live observations and proved departures.
        candidate['config_stamp'] = entry['config_stamp']
        candidate['processes'] = {**candidate['processes'], **entry.get('readiness_processes', {})}
        candidate['departed_processes'] = {**entry.get('departed_processes', {}),
                                            **candidate.get('departed_processes', {})}
        bind_processes(candidate, self.records)
        entry['readiness_processes'] = candidate['processes']
        if candidate['departed_processes']:
            entry['departed_processes'] = candidate['departed_processes']
        self.save()

    def _ready(self, entry, ledger):
        if _config_stamp(entry) != entry['config_stamp']:
            raise RuntimeError(f'{_name(entry)} service configuration changed; backend recovery remains owed.')
        if entry['purpose'] == 'gateway':
            from gateway.status import get_running_pid_identity_strict
            runtime = get_running_pid_identity_strict(Path(entry['home']) / 'gateway.pid')
            if runtime is None:
                return False
            if entry['phase'] != 'recorded' and self._gateway_writers_live(entry):
                return False
            candidate = self._gateway_candidate(entry)
            if candidate is None:
                return False
            self._verify_candidate(candidate, entry)
            ready = _gateway_home_matches(entry['home'], (candidate['pid'], candidate['ct']), self.pause)
            self._verify_candidate(candidate, entry)
            return ready
        if entry.get('legacy_refresh') and any(self.records.identity_is_live({'pid': int(pid), 'ct': p['ct']})
                for pid, p in entry['processes'].items()
                if int(pid) != entry['service_pid'] or int(pid) == entry['pid']):
            return False
        candidates = [row for row, live in ledger(self.root, self.identity) if live is True
                      and row.get('purpose') == entry['purpose']
                      and row.get('host') == entry['host'] and row.get('port') == entry['port']]
        if len(candidates) != 1:
            return False
        row = candidates[0]
        if (row['pid'] == entry['pid'] and entry['phase'] != 'recorded'
                and self.records.identity_is_live({'pid': entry['pid'], 'ct': entry['processes'][str(entry['pid'])]['ct']})):
            return False  # A committed retirement on the original process closes admission permanently.
        candidate = backend_entry(row, {Path(entry['home']).resolve()}, self.pause, self.identity)
        if (candidate['profile'] != entry['profile'] or _service_key(candidate) != _service_key(entry)
                or _config_stamp(candidate) != entry['config_stamp']):
            return False
        self._verify_candidate(candidate, entry)
        try:
            if entry.get('legacy_refresh'):
                verify_listener(candidate)
            backend_request(candidate)
            if entry['phase'] == 'recorded' and row['pid'] == entry['pid']:
                permit = backend_request(candidate, 'prepare')
                if permit.get('ok') is not True or permit.get('idle') is not True or not isinstance(permit.get('token'), str):
                    return False
                if backend_request(candidate, 'cancel', permit['token']).get('ok') is not True:
                    return False
            self._verify_candidate(candidate, entry)
            if self.identity._pid_alive_matches(row['pid'], row['create_time'], strict=True) is not True:
                return False
        except BackendLifecycleUnsupported:
            raise
        except RuntimeError:
            return False
        return candidate
