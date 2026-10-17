"""Service identities and backend recovery extending agent_mutation's native lease.

Bare/Windows gateways keep the native journal. A checkout-locked companion owns
POSIX supervisor obligations and verifies actual gateway/backend readiness.
"""
from __future__ import annotations

import contextlib
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import shlex
import signal
import subprocess
import tempfile
import threading
import time

STOP_SECONDS = 30.0
READY_SECONDS = 30.0


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


def snapshot(entry):
    from gateway.status import get_process_start_time
    parents = _process_table()
    service, pid = entry.get('service_pid', entry['pid']), entry['pid']
    chain = _ancestors(pid, parents)
    if service not in chain:
        raise RuntimeError(f'{_name(entry)} does not own backend/gateway PID {pid}.')
    if service in _ancestors(os.getpid(), parents):
        raise RuntimeError(f'{_name(entry)} owns the updater or an ancestor; source was not changed.')
    descendants = _descendants(service, parents)
    births = {str(p): get_process_start_time(p) for p in descendants}
    if any(value is None for value in births.values()):
        raise RuntimeError(f'{_name(entry)} process birth identities could not be proved.')
    after = _process_table()
    if any(after.get(p) != parents[p] or get_process_start_time(p) != births[str(p)] for p in descendants):
        raise RuntimeError(f'{_name(entry)} process identity or ancestry changed during discovery.')
    return {str(p): {'birth': births[str(p)], 'parent': parents[p]} for p in descendants}


def gateway_entries(entries, homes, pause):
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
        if runtime is None or not pause._home_of(runtime[0]) or Path(pause._home_of(runtime[0])).resolve() != home:
            raise RuntimeError(f'{_name(entry)} has no verified gateway in its owning profile.')
        entry.update(service_pid=entry['pid'], pid=runtime[0], ct=runtime[1], home=str(home))
        entry['processes'] = snapshot(entry)
        if entry['processes'][str(entry['pid'])]['birth'] != entry['ct']:
            raise RuntimeError(f'{_name(entry)} gateway birth identity changed during discovery.')
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


def verify_processes(entry, records, *, stopping=False):
    from gateway.status import get_process_start_time, _pid_exists
    parents = _process_table()
    for pid, expected in entry['processes'].items():
        pid = int(pid)
        if not _pid_exists(pid):
            if stopping:
                continue
            raise RuntimeError(f'{_name(entry)} process {pid} disappeared before its stop.')
        if (get_process_start_time(pid) != expected['birth'] or records.identity(pid)['ct'] != expected.get('ct')
                or parents.get(pid) != expected['parent']):
            raise RuntimeError(f'{_name(entry)} process {pid} identity/ancestry changed; source was not changed.')
    _, service_pid = _service_pid(entry)
    if service_pid and service_pid != entry['service_pid']:
        raise RuntimeError(f'{_name(entry)} supervisor respawned during quiescence; source was not changed.')
    if service_pid:
        for pid in _descendants(service_pid, parents):
            if str(pid) not in entry['processes']:
                raise RuntimeError(f'{_name(entry)} acquired an unrecorded descendant {pid}; source was not changed.')


def bind_processes(entry, records):
    from gateway.status import get_process_start_time
    for pid, expected in entry.get('processes', {}).items():
        canonical = records.identity(int(pid))['ct']
        if canonical is None or get_process_start_time(int(pid)) != expected['birth'] or records.identity(int(pid))['ct'] != canonical:
            raise RuntimeError(f'{_name(entry)} process {pid} identity changed before custody.')
        expected['ct'] = canonical
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
    env = _pid_environ(entry['pid'])
    if env is None:
        return None
    with scoped_home(Path(entry['home'])):
        section = basic._load_config_basic_auth_section()
        secret = env.get('HERMES_DASHBOARD_BASIC_AUTH_SECRET') or section.get('secret')
        username = env.get('HERMES_DASHBOARD_BASIC_AUTH_USERNAME') or section.get('username')
        if not secret or not username:
            return None  # A process-random key is not reproducible; never manufacture a replacement key.
        previous = os.environ.get('HERMES_DASHBOARD_BASIC_AUTH_SECRET')
        try:
            os.environ['HERMES_DASHBOARD_BASIC_AUTH_SECRET'] = str(secret)
            key = basic._resolve_secret(section)
        finally:
            if previous is None:
                os.environ.pop('HERMES_DASHBOARD_BASIC_AUTH_SECRET', None)
            else:
                os.environ['HERMES_DASHBOARD_BASIC_AUTH_SECRET'] = previous
        return basic._sign({'sub': str(username), 'kind': 'access', 'exp': int(time.time()) + 60}, key)


def backend_request(entry, action=None, permit=None):
    host, port = _endpoint(entry)
    token = _auth(entry)
    headers = {'X-Hermes-Session-Token': token, 'Authorization': 'Bearer ' + token}
    for attempt in range(2):
        connection = http.client.HTTPConnection(host, port, timeout=2)
        try:
            body = None if action is None else json.dumps(dict(action=action, **({'token': permit} if permit else {})))
            if body is not None:
                headers['Content-Type'] = 'application/json'
            connection.request('GET' if body is None else 'POST', '/api/host/identity' if body is None else '/api/health/retirement', body, headers)
            response = connection.getresponse()
            data = response.read(65537)
            if response.status == 401 and attempt == 0:
                credential = _local_session(entry)
                if credential:
                    headers['Authorization'] = 'Bearer ' + credential
                    continue
            if response.status != 200 or len(data) > 65536:
                raise RuntimeError(f'{_name(entry)} refused authenticated backend lifecycle access (HTTP {response.status}); source was not changed.')
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError('not an object')
            if action is None and (result.get('pid') != entry['pid'] or result.get('role') != 'serve' or result.get('ok') is not True):
                raise RuntimeError(f'{_name(entry)} endpoint is not the expected backend process.')
            return result
        except (OSError, ValueError, http.client.HTTPException) as exc:
            raise RuntimeError(f'{_name(entry)} backend lifecycle/readiness could not be verified.') from exc
        finally:
            connection.close()


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


class ServiceRecovery:
    """Companion to the native pause token; all calls hold its existing checkout lock."""
    def __init__(self, root, home, records, identity, pause):
        self.root, self.records, self.identity, self.pause = root, records, identity, pause
        self.path = recovery_path(root, home)
        try:
            self.state = json.loads(self.path.read_text())
        except FileNotFoundError:
            self.state = {'schema': 1, 'root': str(root), 'entries': [], 'tree': {}, 'sync_failed': False}
        except (OSError, ValueError) as exc:
            raise RuntimeError('Backend recovery evidence is unreadable; source was not changed.') from exc
        if (not isinstance(self.state, dict) or self.state.get('schema') != 1 or self.state.get('root') != str(root)
                or not isinstance(self.state.get('entries'), list) or not isinstance(self.state.get('tree'), dict)):
            raise RuntimeError('Backend recovery evidence has an unknown identity or format; source was not changed.')
        if self.state['entries'] and (not self.state['tree'].get('baselines') or any(
                not isinstance(e, dict) or e.get('purpose') not in {'gateway', 'dashboard', 'serve'}
                or e.get('phase') not in {'recorded', 'retiring', 'stopped'} or not isinstance(e.get('processes'), dict)
                for e in self.state['entries'])):
            raise RuntimeError('Service recovery lacks complete source/process custody evidence; source was not changed.')

    def save(self, token=None):
        if not self.state['entries']:
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

    def _sync_directory(self):
        if os.name != 'nt':
            fd = os.open(self.path.parent, os.O_RDONLY)
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

    def stop(self, entry, stopped):
        owed = next(e for e in self.state['entries'] if _service_key(e) == _service_key(entry))
        verify_processes(owed, self.records)
        backend_request(owed)
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
        verify_processes(owed, self.records)
        if backend_request(owed, 'commit', permit['token']).get('ok') is not True:
            raise RuntimeError(f'{_name(owed)} did not commit its backend retirement; recovery remains owed.')
        verify_processes(owed, self.records)
        os.kill(owed['pid'], signal.SIGTERM)
        wait_stopped(owed, self.records, stopped, writers_only=True)
        verify_processes(owed, self.records, stopping=True)
        self.pause._disarm(service_entry(owed))
        wait_stopped(owed, self.records, stopped)
        owed['phase'] = 'stopped'
        self.save()

    def gateway_requested(self, entry):
        if not entry.get('processes'):
            return
        owed = next(e for e in self.state['entries'] if _service_key(e) == _service_key(entry))
        owed['phase'] = 'retiring'
        self.save()

    def _settle_gateway(self, entry):
        live = [int(pid) for pid, p in entry['processes'].items()
                if self.records.identity_is_live({'pid': int(pid), 'ct': p['ct']})]
        if any(pid != entry['service_pid'] or pid == entry['pid'] for pid in live):
            raise RuntimeError(f'{_name(entry)} gateway drain remains owed; retry Agent update recovery.')
        if live:
            verify_processes(entry, self.records, stopping=True)
            self.pause._disarm(service_entry(entry))
            wait_stopped(entry, self.records, threading.Event())
            entry['phase'] = 'stopped'
            self.save()

    def resume(self, ledger):
        if not self.state['entries']:
            return
        whole, why = self.records.tree_is_whole(self.state['tree'], self.root)
        if not whole or self.state.get('sync_failed'):
            raise RuntimeError('Backend recovery remains owed until source/dependency repair completes: ' + why)
        failures = []
        for entry in list(self.state['entries']):
            try:
                if self._ready(entry, ledger):
                    self.state['entries'].remove(entry)
                    self.save()
                    continue
                if entry['purpose'] == 'gateway':
                    self._settle_gateway(entry)
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
                    verify_processes(entry, self.records, stopping=True)
                    if any(self.records.identity_is_live({'pid': int(pid), 'ct': p['ct']}) for pid, p in entry['processes'].items() if int(pid) != entry['service_pid']):
                        raise RuntimeError(f'{_name(entry)} still has live writer descendants; recovery remains owed.')
                    self.pause._disarm(service_entry(entry))
                    wait_stopped(entry, self.records, threading.Event())
                    entry['phase'] = 'stopped'
                    self.save()
                _, active = _service_pid(entry)
                if not active:
                    _start(entry, self.pause)
                self._wait_ready(entry, ledger)
            except Exception as exc:
                failures.append(str(exc))
        if failures:
            raise RuntimeError('; '.join(failures))

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

    def _ready(self, entry, ledger):
        if _config_stamp(entry) != entry['config_stamp']:
            raise RuntimeError(f'{_name(entry)} service configuration changed; backend recovery remains owed.')
        if entry['purpose'] == 'gateway':
            from gateway.status import get_running_pid_identity_strict
            runtime = get_running_pid_identity_strict(Path(entry['home']) / 'gateway.pid')
            if runtime is None:
                return False
            if (runtime[0] == entry['pid'] and entry['phase'] != 'recorded'
                    and self.records.identity_is_live({'pid': entry['pid'], 'ct': entry['processes'][str(entry['pid'])]['ct']})):
                return False
            candidate = {**entry, 'pid': runtime[0], 'service_pid': _service_pid(entry)[1]}
            if not candidate['service_pid']:
                return False
            candidate['processes'] = snapshot(candidate)
            bind_processes(candidate, self.records)
            ready = self.pause._gateway_on_home(entry['home'], set()) == runtime[0]
            verify_processes(candidate, self.records)
            return ready
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
        bind_processes(candidate, self.records)
        try:
            backend_request(candidate)
            if entry['phase'] == 'recorded' and row['pid'] == entry['pid']:
                permit = backend_request(candidate, 'prepare')
                if permit.get('ok') is not True or permit.get('idle') is not True or not isinstance(permit.get('token'), str):
                    return False
                if backend_request(candidate, 'cancel', permit['token']).get('ok') is not True:
                    return False
            verify_processes(candidate, self.records)
            if self.identity._pid_alive_matches(row['pid'], row['create_time'], strict=True) is not True:
                return False
        except RuntimeError:
            return False
        return True
