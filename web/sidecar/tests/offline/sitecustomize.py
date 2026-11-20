"""Network guard for Agent processes of cases that share the provisioned PM store (TAL-1985).

Loaded as ``sitecustomize`` from the case's PYTHONPATH, so every Python process the case starts inherits it. A connect
to anything but loopback or a Unix socket raises at once, so a hidden download fails fast with this message instead of
hanging into the case's timeout. ``UV_OFFLINE`` gives the uv binary, which this hook cannot reach, the same rule."""
import ipaddress
import socket
import sys


def _guard(event, args):
    if event != 'socket.connect':
        return
    sock, address = args
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return
    host = address[0]
    try:
        if host == 'localhost' or ipaddress.ip_address(host.split('%', 1)[0]).is_loopback:
            return
    except ValueError:
        pass
    # RuntimeError, not OSError: download retries catch OSError and would back off into the timeout.
    raise RuntimeError(f'test network guard: blocked connect to {address!r}; '
                       'a sidecar test reached the network (seed the PM store, never download)')


sys.addaudithook(_guard)
