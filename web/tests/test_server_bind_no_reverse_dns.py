import socket
from http.server import BaseHTTPRequestHandler

from server import QuietHTTPServer


def test_server_bind_does_not_wait_for_reverse_dns(monkeypatch):
    def fail_reverse_dns(*_args, **_kwargs):
        raise AssertionError("server startup must not perform reverse DNS")

    monkeypatch.setattr(socket, "getfqdn", fail_reverse_dns)
    server = QuietHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    try:
        assert server.server_name == "127.0.0.1"
        assert server.server_port == server.server_address[1]
    finally:
        server.server_close()
