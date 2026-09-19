import os
import socket
import shutil
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
CTL = REPO_ROOT / "ctl.sh"
HEALTH_PROBE = REPO_ROOT / "scripts" / "lib" / "health_probe.sh"


def _seed_ctl_repo(repo_root: Path) -> None:
    """Copy ctl.sh plus its sourced dependencies into an isolated repo dir."""
    shutil.copy2(CTL, repo_root / "ctl.sh")
    lib_dir = repo_root / "scripts" / "lib"
    lib_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HEALTH_PROBE, lib_dir / "health_probe.sh")



def run_ctl(
    home: Path,
    *args: str,
    env: dict[str, str] | None = None,
    timeout: float = 15.0,
    repo_root: Path = REPO_ROOT,
    load_dotenv: bool = False,
):
    merged = os.environ.copy()
    for key in (
        "HERMES_WEBUI_HOST",
        "HERMES_WEBUI_PORT",
        "HERMES_WEBUI_PYTHON",
        "HERMES_WEBUI_STATE_DIR",
        "HERMES_WEBUI_PID_FILE",
        "HERMES_WEBUI_LOG_FILE",
        "HERMES_WEBUI_CTL_STATE_FILE",
        "HERMES_WEBUI_CTL_PORT_START",
        "HERMES_WEBUI_START_GRACE",
        "HERMES_WEBUI_CTL_ISOLATE_WORKTREE",
        "HERMES_WEBUI_CTL_DETACH_WORKTREE",
        "HERMES_WEBUI_NO_DOTENV",
        "HERMES_WEBUI_DEV_PROXY",
        "XDG_RUNTIME_DIR",
    ):
        merged.pop(key, None)
    merged.update(
        {
            "HOME": str(home),
            "HERMES_HOME": str(home / ".hermes"),
            "PATH": os.environ.get("PATH", ""),
            "HERMES_WEBUI_NO_DOTENV": "0" if load_dotenv else "1",
            "HERMES_WEBUI_CTL_ISOLATE_WORKTREE": "0",
        }
    )
    if env:
        merged.update(env)
    return subprocess.run(
        ["bash", str(repo_root / "ctl.sh"), *args],
        cwd=repo_root,
        env=merged,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def write_fake_python(path: Path) -> None:
    path.write_text(
        textwrap.dedent(
            """
            #!/usr/bin/env bash
            printf 'fake-python args:%s\n' "$*" >> "${FAKE_PYTHON_LOG}"
            printf 'host=%s port=%s state=%s\n' "${HERMES_WEBUI_HOST:-}" "${HERMES_WEBUI_PORT:-}" "${HERMES_WEBUI_STATE_DIR:-}" >> "${FAKE_PYTHON_LOG}"
            trap 'printf "terminated\n" >> "${FAKE_PYTHON_LOG}"; exit 0' TERM INT
            while true; do sleep 0.1; done
            """
        ).lstrip(),
        encoding="utf-8",
    )
    path.chmod(0o755)


def write_delayed_listener(path: Path) -> None:
    path.write_text(
        textwrap.dedent(
            f"""
            #!{sys.executable}
            import os
            import signal
            import socket
            import sys
            import time

            with open(os.environ["FAKE_PYTHON_LOG"], "a", encoding="utf-8") as log:
                log.write(f"fake-python args:{{' '.join(sys.argv[1:])}}\\n")
                log.write(
                    f"host={{os.environ.get('HERMES_WEBUI_HOST', '')}} "
                    f"port={{os.environ.get('HERMES_WEBUI_PORT', '')}} "
                    f"state={{os.environ.get('HERMES_WEBUI_STATE_DIR', '')}}\\n"
                )
            time.sleep(float(os.environ["FAKE_BIND_DELAY"]))
            host = os.environ.get("HERMES_WEBUI_HOST", "127.0.0.1").strip("[]")
            family = socket.AF_INET6 if ":" in host else socket.AF_INET
            listener = socket.socket(family)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind((host, int(sys.argv[-1])))
            listener.listen()
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
            while True:
                time.sleep(0.1)
            """
        ).lstrip(),
        encoding="utf-8",
    )
    path.chmod(0o755)


def wait_for_pid_file(pid_file: Path, timeout: float = 3.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pid_file.exists():
            raw = pid_file.read_text(encoding="utf-8").strip()
            if raw:
                return int(raw)
        time.sleep(0.05)
    raise AssertionError(f"PID file was not written: {pid_file}")


def wait_for_file_text(path: Path, timeout: float = 3.0, contains: str | None = None) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists():
            text = path.read_text(encoding="utf-8")
            if text and (contains is None or contains in text):
                return text
        time.sleep(0.05)
    raise AssertionError(f"File was not written: {path}")


def assert_path_in_text(path: Path, text: str) -> None:
    assert str(path).replace("\\", "/") in text.replace("\\", "/")


def bash_path(path: Path) -> str:
    raw = str(path.resolve()).replace("\\", "/")
    if sys.platform == "win32" and len(raw) > 1 and raw[1] == ":":
        return f"/{raw[0].lower()}{raw[2:]}"
    return raw


def bash_pid(pid: int) -> int:
    if sys.platform != "win32":
        return pid
    result = subprocess.run(
        [
            "bash",
            "-lc",
            "ps -W | awk -v winpid=\"$1\" '$4 == winpid { print $1; exit }'",
            "_",
            str(pid),
        ],
        text=True,
        capture_output=True,
        timeout=3,
    )
    if result.returncode == 0 and result.stdout.strip():
        return int(result.stdout.strip())
    return pid


def windows_pid(pid: int) -> int | None:
    if sys.platform != "win32":
        return pid
    result = subprocess.run(
        [
            "bash",
            "-lc",
            "ps -p \"$1\" -l | awk 'NR == 2 { print $4 }'",
            "_",
            str(pid),
        ],
        text=True,
        capture_output=True,
        timeout=3,
    )
    if result.returncode == 0 and result.stdout.strip():
        return int(result.stdout.strip())
    return None


def start_fake_launchd_process() -> subprocess.Popen:
    return subprocess.Popen(
        ["bash", "-lc", "exec sleep 30"],
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}),
    )


def _kill_tree(pid: int) -> None:
    if sys.platform == "win32":
        winpid = windows_pid(pid)
        if winpid is not None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(winpid)], capture_output=True)
    else:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass


def process_exists(pid: int) -> bool:
    if sys.platform == "win32":
        return (
            subprocess.run(
                ["bash", "-lc", "kill -0 \"$1\"", "_", str(pid)],
                text=True,
                capture_output=True,
                timeout=3,
            ).returncode
            == 0
        )
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def assert_process_exits(pid: int, timeout: float = 3.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not process_exists(pid):
            return
        time.sleep(0.05)
    _kill_tree(pid)
    raise AssertionError(f"process {pid} did not exit")


def test_start_writes_pid_under_hermes_home_runs_foreground_no_browser_and_logs(tmp_path):
    fake_python = tmp_path / "fake-python"
    fake_log = tmp_path / "fake-python.log"
    write_fake_python(fake_python)

    result = run_ctl(
        tmp_path,
        "start",
        env={
            "HERMES_WEBUI_PYTHON": str(fake_python),
            "FAKE_PYTHON_LOG": str(fake_log),
            "HERMES_WEBUI_HOST": "0.0.0.0",
            "HERMES_WEBUI_PORT": "18991",
            "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
        },
    )

    assert result.returncode == 0, result.stderr + result.stdout
    hermes_home = tmp_path / ".hermes"
    pid_file = hermes_home / "webui.pid"
    log_file = hermes_home / "webui.log"
    pid = wait_for_pid_file(pid_file)
    try:
        assert pid > 1
        assert log_file.exists()
        fake_output = wait_for_file_text(fake_log, contains="host=0.0.0.0 port=18991")
        assert "bootstrap.py --no-browser --foreground" in fake_output
        assert "host=0.0.0.0 port=18991" in fake_output
        assert_path_in_text(hermes_home / "webui", fake_output)
        status = run_ctl(tmp_path, "status")
        assert status.returncode == 0
        assert "running" in status.stdout
        assert f"PID:     {pid}" in status.stdout
        assert "Bound:   0.0.0.0:18991" in status.stdout
        assert_path_in_text(log_file, status.stdout)
    finally:
        stop = run_ctl(tmp_path, "stop")
        assert stop.returncode == 0, stop.stderr + stop.stdout
        _kill_tree(pid)
        assert_process_exits(pid)
        assert not pid_file.exists()


def test_remote_flag_starts_frontend_against_configured_webui(tmp_path):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _seed_ctl_repo(repo_root)
    (repo_root / "frontend" / "node_modules").mkdir(parents=True)
    (repo_root / ".env").write_text(
        "HERMES_WEBUI_DEV_PROXY=https://webui.example.test\n",
        encoding="utf-8",
    )
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    npm_log = tmp_path / "npm.log"
    npm = fake_bin / "npm"
    npm.write_text(
        "#!/usr/bin/env bash\n"
        "printf 'args=%s\\npwd=%s\\nproxy=%s\\n' \"$*\" \"$PWD\" \"$HERMES_WEBUI_DEV_PROXY\" > \"$NPM_LOG\"\n",
        encoding="utf-8",
    )
    npm.chmod(0o755)

    result = run_ctl(
        tmp_path,
        "start",
        "--remote",
        "--port",
        "18993",
        env={"PATH": f"{fake_bin}:{os.environ.get('PATH', '')}", "NPM_LOG": str(npm_log)},
        repo_root=repo_root,
        load_dotenv=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    output = npm_log.read_text(encoding="utf-8")
    assert "args=run dev -- --host 127.0.0.1 --port 18993" in output
    assert_path_in_text(repo_root / "frontend", output)
    assert "proxy=https://webui.example.test" in output
    assert not (tmp_path / ".hermes" / "webui.pid").exists()


def test_remote_flag_requires_http_webui_target(tmp_path):
    for value, message in (("", "must be set"), ("file:///tmp/webui", "must start with")):
        result = run_ctl(
            tmp_path,
            "start",
            "--remote",
            env={"HERMES_WEBUI_DEV_PROXY": value},
        )
        assert result.returncode == 2
        assert message in result.stderr


def test_worktree_start_selects_next_free_port_and_reports_it(tmp_path):
    fake_python = tmp_path / "fake-python"
    fake_log = tmp_path / "fake-python.log"
    runtime_root = tmp_path / "runtime"
    write_delayed_listener(fake_python)

    while True:
        blocker = socket.socket()
        blocker.bind(("127.0.0.1", 0))
        start_port = blocker.getsockname()[1]
        if start_port < 65535:
            break
        blocker.close()
    env = {
        "HERMES_WEBUI_PYTHON": str(fake_python),
        "FAKE_PYTHON_LOG": str(fake_log),
        "HERMES_WEBUI_CTL_ISOLATE_WORKTREE": "1",
        "HERMES_WEBUI_CTL_PORT_START": str(start_port),
        "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
        "HERMES_WEBUI_CTL_DETACH_WORKTREE": "1",
        "FAKE_BIND_DELAY": "0.1",
        "TMPDIR": str(runtime_root),
    }
    try:
        result = run_ctl(tmp_path, "start", env=env)
    finally:
        blocker.close()

    assert result.returncode == 0, result.stderr + result.stdout
    assert f"HERMES_WEBUI_PORT={start_port + 1}" in result.stdout
    assert f"HERMES_WEBUI_URL=http://127.0.0.1:{start_port + 1}" in result.stdout
    fake_output = wait_for_file_text(fake_log, contains=f"port={start_port + 1}")
    assert str(runtime_root) in fake_output

    pid_files = list(runtime_root.glob("hermes-webui-ctl-*/*/webui.pid"))
    assert len(pid_files) == 1
    pid = int(pid_files[0].read_text().strip())
    try:
        stop = run_ctl(tmp_path, "stop", env=env)
        assert stop.returncode == 0, stop.stderr + stop.stdout
    finally:
        _kill_tree(pid)
        assert_process_exits(pid)


def test_worktree_runtime_root_is_owner_only(tmp_path):
    if sys.platform == "win32":
        pytest.skip("POSIX runtime directory ownership and mode check")
    runtime_root = tmp_path / "runtime"
    shared_root = runtime_root / f"hermes-webui-ctl-{os.getuid()}"
    shared_root.mkdir(parents=True, mode=0o755)
    shared_root.chmod(0o755)

    result = run_ctl(
        tmp_path,
        "status",
        env={
            "HERMES_WEBUI_CTL_ISOLATE_WORKTREE": "1",
            "TMPDIR": str(runtime_root),
        },
    )

    assert result.returncode == 0
    assert shared_root.stat().st_mode & 0o777 == 0o700


def test_worktree_runtime_root_rejects_symlink(tmp_path):
    if sys.platform == "win32":
        pytest.skip("POSIX runtime directory symlink check")
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    target = tmp_path / "attacker-controlled"
    target.mkdir()
    shared_root = runtime_root / f"hermes-webui-ctl-{os.getuid()}"
    shared_root.symlink_to(target, target_is_directory=True)

    result = run_ctl(
        tmp_path,
        "status",
        env={
            "HERMES_WEBUI_CTL_ISOLATE_WORKTREE": "1",
            "TMPDIR": str(runtime_root),
        },
    )

    assert result.returncode != 0
    assert "unsafe runtime directory" in result.stderr
    assert not any(target.iterdir())


def test_worktree_start_waits_for_reserved_port_to_bind(tmp_path):
    fake_python = tmp_path / "delayed-listener"
    runtime_root = tmp_path / "runtime"
    write_delayed_listener(fake_python)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        start_port = probe.getsockname()[1]

    env = {
        "HERMES_WEBUI_PYTHON": str(fake_python),
        "FAKE_PYTHON_LOG": str(tmp_path / "fake-python.log"),
        "HERMES_WEBUI_CTL_ISOLATE_WORKTREE": "1",
        "HERMES_WEBUI_CTL_PORT_START": str(start_port),
        "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
        "HERMES_WEBUI_CTL_DETACH_WORKTREE": "1",
        "HERMES_WEBUI_START_GRACE": "1",
        "FAKE_BIND_DELAY": "1.75",
        "TMPDIR": str(runtime_root),
    }
    started_at = time.monotonic()
    result = run_ctl(tmp_path, "start", env=env, timeout=5)
    elapsed = time.monotonic() - started_at

    assert result.returncode == 0, result.stderr + result.stdout
    assert elapsed >= 1.5
    pid_file = next(runtime_root.glob("hermes-webui-ctl-*/*/webui.pid"))
    pid = int(pid_file.read_text().strip())
    try:
        stop = run_ctl(tmp_path, "stop", env=env)
        assert stop.returncode == 0, stop.stderr + stop.stdout
    finally:
        _kill_tree(pid)
        assert_process_exits(pid)


def test_worktree_start_probes_requested_ipv6_host(tmp_path):
    if not socket.has_ipv6:
        pytest.skip("IPv6 is unavailable")
    fake_python = tmp_path / "fake-python"
    fake_log = tmp_path / "fake-python.log"
    runtime_root = tmp_path / "runtime"
    write_delayed_listener(fake_python)
    while True:
        blocker = socket.socket(socket.AF_INET6)
        try:
            blocker.bind(("::1", 0))
            start_port = blocker.getsockname()[1]
            if start_port >= 65535:
                blocker.close()
                continue
            with socket.socket(socket.AF_INET6) as next_port:
                next_port.bind(("::1", start_port + 1))
            with socket.socket() as next_port_v4:
                next_port_v4.bind(("127.0.0.1", start_port + 1))
            break
        except OSError:
            blocker.close()
            pytest.skip("IPv6 loopback is unavailable")

    env = {
        "HERMES_WEBUI_PYTHON": str(fake_python),
        "FAKE_PYTHON_LOG": str(fake_log),
        "HERMES_WEBUI_HOST": "::1",
        "HERMES_WEBUI_CTL_ISOLATE_WORKTREE": "1",
        "HERMES_WEBUI_CTL_PORT_START": str(start_port),
        "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
        "HERMES_WEBUI_CTL_DETACH_WORKTREE": "1",
        "HERMES_WEBUI_START_GRACE": "1",
        "FAKE_BIND_DELAY": "0.1",
        "TMPDIR": str(runtime_root),
    }
    try:
        result = run_ctl(tmp_path, "start", env=env, timeout=12)
    finally:
        blocker.close()
        pid_files = list(runtime_root.glob("hermes-webui-ctl-*/*/webui.pid"))
        if pid_files:
            pid = int(pid_files[0].read_text().strip())
            run_ctl(tmp_path, "stop", env=env)
            _kill_tree(pid)
            assert_process_exits(pid)

    assert result.returncode == 0, result.stderr + result.stdout
    assert f"HERMES_WEBUI_PORT={start_port + 1}" in result.stdout


def test_start_reports_linux_lan_url(tmp_path):
    fake_python = tmp_path / "fake-python"
    fake_log = tmp_path / "fake-python.log"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    write_delayed_listener(fake_python)
    for name, body in {
        "route": "exit 1",
        "ipconfig": "exit 1",
        "ip": "printf '%s\\n' '1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.44'",
    }.items():
        command = fake_bin / name
        command.write_text(f"#!/usr/bin/env bash\n{body}\n", encoding="utf-8")
        command.chmod(0o755)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    env = {
        "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
        "HERMES_WEBUI_PYTHON": str(fake_python),
        "FAKE_PYTHON_LOG": str(fake_log),
        "HERMES_WEBUI_HOST": "0.0.0.0",
        "HERMES_WEBUI_PORT": str(port),
        "HERMES_WEBUI_CTL_ISOLATE_WORKTREE": "1",
        "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
        "HERMES_WEBUI_CTL_DETACH_WORKTREE": "1",
        "HERMES_WEBUI_START_GRACE": "1",
        "FAKE_BIND_DELAY": "0.1",
        "TMPDIR": str(tmp_path / "runtime"),
    }
    try:
        result = run_ctl(tmp_path, "start", env=env, timeout=5)
    finally:
        pid_files = list((tmp_path / "runtime").glob("hermes-webui-ctl-*/*/webui.pid"))
        if pid_files:
            pid = int(pid_files[0].read_text().strip())
            run_ctl(tmp_path, "stop", env=env)
            _kill_tree(pid)
            assert_process_exits(pid)

    assert result.returncode == 0, result.stderr + result.stdout
    assert f"HERMES_WEBUI_LAN_URL=http://192.0.2.44:{port}" in result.stdout


def test_start_uses_nohup_so_daemon_survives_launcher_exit():
    ctl_text = CTL.read_text(encoding="utf-8")

    assert "trap '' HUP" in ctl_text
    assert 'exec nohup "${python_exe}"' in ctl_text


def test_start_can_ignore_repo_dotenv_for_authoritative_test_env(tmp_path):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _seed_ctl_repo(repo_root)
    (repo_root / "bootstrap.py").write_text("# fake bootstrap target\n", encoding="utf-8")
    (repo_root / ".env").write_text(
        f"HERMES_WEBUI_STATE_DIR={tmp_path / 'host-specific-webui'}\n",
        encoding="utf-8",
    )
    fake_python = tmp_path / "fake-python"
    fake_log = tmp_path / "fake-python.log"
    write_fake_python(fake_python)

    result = run_ctl(
        tmp_path,
        "start",
        env={
            "HERMES_WEBUI_PYTHON": str(fake_python),
            "FAKE_PYTHON_LOG": str(fake_log),
            "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
            # This test exercises dotenv precedence on the DEFAULT port; keep
            # it hermetic on developer machines where a real WebUI (systemd
            # unit or manual run) is serving 8787.
            "HERMES_WEBUI_CTL_ALLOW_SYSTEMD_CONFLICT": "1",
            "HERMES_WEBUI_CTL_ALLOW_PORT_CONFLICT": "1",
        },
        repo_root=repo_root,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    pid = wait_for_pid_file(tmp_path / ".hermes" / "webui.pid")
    try:
        fake_output = wait_for_file_text(fake_log, contains="host=127.0.0.1 port=8787")
        assert_path_in_text(tmp_path / ".hermes" / "webui", fake_output)
        assert "host-specific-webui" not in fake_output
    finally:
        stop = run_ctl(tmp_path, "stop", repo_root=repo_root)
        assert stop.returncode == 0, stop.stderr + stop.stdout
        _kill_tree(pid)
        assert_process_exits(pid)


def test_start_loads_dotenv_but_inline_overrides_win(tmp_path):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _seed_ctl_repo(repo_root)
    (repo_root / "bootstrap.py").write_text("# fake bootstrap target\n", encoding="utf-8")

    fake_python = tmp_path / "fake-python"
    fake_log = tmp_path / "fake-python.log"
    write_fake_python(fake_python)
    (repo_root / ".env").write_text(
        "HERMES_WEBUI_HOST=127.9.9.9\nHERMES_WEBUI_PORT=18888\n",
        encoding="utf-8",
    )

    result = run_ctl(
        tmp_path,
        "start",
        env={
            "HERMES_WEBUI_PYTHON": str(fake_python),
            "FAKE_PYTHON_LOG": str(fake_log),
            "HERMES_WEBUI_HOST": "0.0.0.0",
            "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
        },
        repo_root=repo_root,
        load_dotenv=True,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    pid = wait_for_pid_file(tmp_path / ".hermes" / "webui.pid")
    try:
        fake_output = wait_for_file_text(fake_log, contains="host=0.0.0.0 port=18888")
        assert "fake-python args:" in fake_output
        assert "host=0.0.0.0 port=18888" in fake_output
    finally:
        stop = run_ctl(tmp_path, "stop", repo_root=repo_root)
        assert stop.returncode == 0, stop.stderr + stop.stdout
        _kill_tree(pid)
        assert_process_exits(pid)


def test_start_loads_dotenv_double_quoted_port_with_trailing_comment(tmp_path):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _seed_ctl_repo(repo_root)
    (repo_root / "bootstrap.py").write_text("# fake bootstrap target\n", encoding="utf-8")

    fake_python = tmp_path / "fake-python"
    fake_log = tmp_path / "fake-python.log"
    write_fake_python(fake_python)
    (repo_root / ".env").write_text(
        'HERMES_WEBUI_PORT="19004" # inline comment\n',
        encoding="utf-8",
    )

    result = run_ctl(
        tmp_path,
        "start",
        env={
            "HERMES_WEBUI_PYTHON": str(fake_python),
            "FAKE_PYTHON_LOG": str(fake_log),
            "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
        },
        repo_root=repo_root,
        load_dotenv=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    pid = wait_for_pid_file(tmp_path / ".hermes" / "webui.pid")
    try:
        fake_output = wait_for_file_text(fake_log, contains="host=127.0.0.1 port=19004")
        assert "host=127.0.0.1 port=19004" in fake_output
    finally:
        stop = run_ctl(tmp_path, "stop", repo_root=repo_root)
        assert stop.returncode == 0, stop.stderr + stop.stdout
        _kill_tree(pid)
        assert_process_exits(pid)


def test_start_loads_dotenv_export_tab_host_assignment(tmp_path):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _seed_ctl_repo(repo_root)
    (repo_root / "bootstrap.py").write_text("# fake bootstrap target\n", encoding="utf-8")

    fake_python = tmp_path / "fake-python"
    fake_log = tmp_path / "fake-python.log"
    write_fake_python(fake_python)
    (repo_root / ".env").write_text(
        "export\tHERMES_WEBUI_HOST=0.0.0.0\nHERMES_WEBUI_PORT=19005\n",
        encoding="utf-8",
    )

    result = run_ctl(
        tmp_path,
        "start",
        env={
            "HERMES_WEBUI_PYTHON": str(fake_python),
            "FAKE_PYTHON_LOG": str(fake_log),
            "HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT": "1",
        },
        repo_root=repo_root,
        load_dotenv=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    pid = wait_for_pid_file(tmp_path / ".hermes" / "webui.pid")
    try:
        fake_output = wait_for_file_text(fake_log, contains="host=0.0.0.0 port=19005")
        assert "host=0.0.0.0 port=19005" in fake_output
    finally:
        stop = run_ctl(tmp_path, "stop", repo_root=repo_root)
        assert stop.returncode == 0, stop.stderr + stop.stdout
        _kill_tree(pid)
        assert_process_exits(pid)


def test_stale_pid_file_is_removed_without_killing_unrelated_process(tmp_path):
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    pid_file = hermes_home / "webui.pid"
    sleeper = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}),
    )
    try:
        pid_file.write_text(str(sleeper.pid), encoding="utf-8")
        result = run_ctl(tmp_path, "stop")
        assert result.returncode == 0
        assert "stale" in (result.stdout + result.stderr).lower()
        assert sleeper.poll() is None, "ctl.sh must not kill unrelated PIDs"
        assert not pid_file.exists()
    finally:
        sleeper.terminate()
        try:
            sleeper.wait(timeout=3)
        except subprocess.TimeoutExpired:
            sleeper.kill()


def _write_fake_launchctl(fake_bin, pid):
    launchctl = fake_bin / "launchctl"
    launchctl.write_text(
        textwrap.dedent(
            f"""
            #!/usr/bin/env bash
            if [[ "$1" == "print" ]]; then
              printf '\\tpid = {pid}\\n'
              exit 0
            fi
            exit 1
            """
        ).lstrip(),
        encoding="utf-8",
    )
    launchctl.chmod(0o755)


def _write_fake_lsof(fake_bin, listening):
    """Fake lsof: exit 0 (PID listens on the port) iff `listening` is True."""
    lsof = fake_bin / "lsof"
    lsof.write_text(
        "#!/usr/bin/env bash\n" + ("exit 0\n" if listening else "exit 1\n"),
        encoding="utf-8",
    )
    lsof.chmod(0o755)


def test_start_refuses_second_instance_when_launchd_job_owns_the_port(tmp_path):
    if sys.platform == "win32":
        pytest.skip("launchd conflict guard is a macOS path; fake launchctl PIDs are not stable under Git Bash")

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()

    sleeper = start_fake_launchd_process()
    _write_fake_launchctl(fake_bin, bash_pid(sleeper.pid))
    # launchd-owned PID IS listening on the requested (default) port → real conflict.
    _write_fake_lsof(fake_bin, listening=True)

    try:
        result = run_ctl(
            tmp_path,
            "start",
            env={
                "PATH": f"{bash_path(fake_bin)}{os.pathsep}{os.environ.get('PATH', '')}",
                "HERMES_WEBUI_LAUNCHD_LABEL": "com.parantoux.hermes-webui",
            },
        )
        assert result.returncode == 2
        combined = result.stdout + result.stderr
        assert "Refusing to start a second Hermes WebUI" in combined
        assert "launchctl kickstart -k" in combined
        assert not (tmp_path / ".hermes" / "webui.pid").exists()
    finally:
        sleeper.terminate()
        try:
            sleeper.wait(timeout=3)
        except subprocess.TimeoutExpired:
            sleeper.kill()


def test_start_allows_alternate_port_while_launchd_job_runs_on_default(tmp_path):
    """A second instance on a DIFFERENT port must not be blocked by the launchd
    guard, even while the launchd-managed default instance is alive (#3291 fix /
    Codex regression-gate finding for v0.51.191)."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()

    sleeper = start_fake_launchd_process()
    _write_fake_launchctl(fake_bin, bash_pid(sleeper.pid))
    # launchd-owned PID is alive but NOT listening on our (alternate) port → no conflict.
    _write_fake_lsof(fake_bin, listening=False)

    # A fake python so `start` "launches" without needing the real server.
    fake_python = tmp_path / "fake-python"
    fake_python.write_text(
        "#!/usr/bin/env bash\ntrap 'exit 0' TERM INT\nwhile true; do sleep 1; done\n",
        encoding="utf-8",
    )
    fake_python.chmod(0o755)

    started_pid = None
    try:
        result = run_ctl(
            tmp_path,
            "start",
            env={
                "PATH": f"{bash_path(fake_bin)}{os.pathsep}{os.environ.get('PATH', '')}",
                "HERMES_WEBUI_LAUNCHD_LABEL": "com.parantoux.hermes-webui",
                "HERMES_WEBUI_PORT": "18992",
                "HERMES_WEBUI_PYTHON": str(fake_python),
            },
        )
        combined = result.stdout + result.stderr
        assert "Refusing to start a second Hermes WebUI" not in combined, combined
        assert result.returncode == 0, combined
        pid_file = tmp_path / ".hermes" / "webui.pid"
        if pid_file.exists():
            started_pid = int(pid_file.read_text().strip())
    finally:
        if started_pid:
            _kill_tree(started_pid)
        sleeper.terminate()
        try:
            sleeper.wait(timeout=3)
        except subprocess.TimeoutExpired:
            sleeper.kill()


def test_logs_supports_non_following_line_count(tmp_path):
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    log_file = hermes_home / "webui.log"
    log_file.write_text("one\ntwo\nthree\n", encoding="utf-8")

    result = run_ctl(tmp_path, "logs", "--lines", "2", "--no-follow")

    assert result.returncode == 0
    assert result.stdout == "two\nthree\n"
