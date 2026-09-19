"""HTTP-server helpers shared by the WebUI entry point."""

import threading
from socketserver import TCPServer


REQUEST_WORKER_OVERFLOW_BODY = (
    b'{"error":"Request worker capacity exhausted",'
    b'"condition":"request_worker_capacity"}'
)
REQUEST_WORKER_OVERFLOW_RESPONSE = (
    b"HTTP/1.1 503 Service Unavailable\r\n"
    b"Content-Type: application/json\r\n"
    b"Connection: close\r\n"
    b"Content-Length: " + str(len(REQUEST_WORKER_OVERFLOW_BODY)).encode("ascii") + b"\r\n"
    b"\r\n"
    + REQUEST_WORKER_OVERFLOW_BODY
)


class HTTPWorkerBudgetMixin:
    """Reserve half the handler budget for requests and half for SSE."""

    max_client_streams = 8

    def _init_worker_budgets(self) -> None:
        stream_workers = max(1, self.max_request_workers // 2)
        request_workers = max(1, self.max_request_workers - stream_workers)
        self._request_worker_slots = threading.BoundedSemaphore(request_workers)
        self._stream_worker_slots = threading.BoundedSemaphore(stream_workers)
        self._stream_clients: dict[tuple[str, str], int] = {}
        self._stream_clients_lock = threading.Lock()
        self._worker_slot_state = threading.local()

    def process_request(self, request, client_address):
        if not self._request_worker_slots.acquire(blocking=False):
            self._reject_overflow_request(request)
            return
        try:
            return super().process_request(request, client_address)
        except Exception:
            self._request_worker_slots.release()
            self._close_request_quietly(request)
            raise

    @staticmethod
    def _stream_client_key(handler) -> tuple[str, str]:
        info = getattr(handler, "_trusted_auth_session_reconciled", None)
        if isinstance(info, dict):
            username = str(info.get("username") or "").strip()
            if username:
                return "identity", username.casefold()
        address = getattr(handler, "client_address", ("unknown",))[0]
        return "address", str(address)

    def promote_request_to_stream(self, handler) -> dict[str, str] | None:
        """Move this handler from the request budget to the SSE budget."""
        slot_kind = getattr(self._worker_slot_state, "kind", None)
        if slot_kind == "stream":
            return None
        if slot_kind != "request":
            return {
                "error": "SSE worker ownership unavailable",
                "condition": "stream_worker_untracked",
            }

        client_key = self._stream_client_key(handler)
        with self._stream_clients_lock:
            if self._stream_clients.get(client_key, 0) >= self.max_client_streams:
                return {
                    "error": "Client SSE stream limit reached",
                    "condition": "client_stream_limit",
                }
            if not self._stream_worker_slots.acquire(blocking=False):
                return {
                    "error": "SSE stream capacity exhausted",
                    "condition": "stream_worker_capacity",
                }
            self._stream_clients[client_key] = self._stream_clients.get(client_key, 0) + 1

        self._worker_slot_state.kind = "stream"
        self._worker_slot_state.client_key = client_key
        self._request_worker_slots.release()
        return None

    def _release_current_worker_slot(self) -> None:
        if getattr(self._worker_slot_state, "kind", None) == "stream":
            client_key = self._worker_slot_state.client_key
            with self._stream_clients_lock:
                remaining = self._stream_clients.get(client_key, 1) - 1
                if remaining:
                    self._stream_clients[client_key] = remaining
                else:
                    self._stream_clients.pop(client_key, None)
            self._stream_worker_slots.release()
        else:
            self._request_worker_slots.release()
        self._worker_slot_state.kind = None
        self._worker_slot_state.client_key = None

    def process_request_thread(self, request, client_address):
        self._worker_slot_state.kind = "request"
        self._worker_slot_state.client_key = None
        try:
            return super().process_request_thread(request, client_address)
        finally:
            self._release_current_worker_slot()


def bind_without_reverse_dns(server) -> None:
    """Bind an HTTP server without Python's unnecessary reverse-DNS lookup."""
    TCPServer.server_bind(server)
    host, port = server.server_address[:2]
    server.server_name = str(host)
    server.server_port = int(port)
