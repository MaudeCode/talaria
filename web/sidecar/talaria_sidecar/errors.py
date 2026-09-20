"""JSON-RPC error codes shared by every sidecar method."""

from __future__ import annotations

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Application errors. ``data.condition`` is the string the server forwards to
# HTTP clients as the ``condition`` field of a 503/409 envelope.
APPLICATION_ERROR = -32000
CANCELLED = -32001


class RpcError(Exception):
    """Raise from a method to answer with a JSON-RPC error object."""

    def __init__(self, message: str, *, code: int = APPLICATION_ERROR, condition: str | None = None, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = dict(data or {})
        if condition:
            self.data["condition"] = condition

    def to_json(self) -> dict:
        error = {"code": self.code, "message": str(self)}
        if self.data:
            error["data"] = self.data
        return error


class InvalidParams(RpcError):
    def __init__(self, message: str, **data):
        super().__init__(message, code=INVALID_PARAMS, data=data or None)


class Cancelled(RpcError):
    def __init__(self, message: str = "cancelled"):
        super().__init__(message, code=CANCELLED, condition="cancelled")
