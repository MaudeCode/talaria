"""What a real-owner peer did and where its time went: ``MODES {...}`` on stdout, ``PHASES {...}`` on stderr (TAL-1780)."""
from contextlib import contextmanager
import json
import sys
import time

# Each poll is a full reconnect through a sidecar and the owner. Tighter polling only takes CPU from the turn being
# waited for, most of all with parallel peers on a small CI runner.
POLL_SECONDS = .25


class Phases:
    def __init__(self, started):
        self.started = started
        self.imports = time.monotonic() - started
        self.startup = self.teardown = 0.0
        self.probes = {}

    @contextmanager
    def daemon(self, factory, *args, **kwargs):
        """``local_recovery_probe.daemon`` with its boot and stop charged to startup and teardown."""
        entered = time.monotonic()
        with factory(*args, **kwargs) as owner:
            self.startup += time.monotonic() - entered
            try:
                yield owner
            finally:
                stopping = time.monotonic()
        self.teardown += time.monotonic() - stopping

    @contextmanager
    def probe(self, mode):
        begun, owner = time.monotonic(), self.startup + self.teardown
        try:
            yield
        finally:
            self.probes[mode] = round(time.monotonic() - begun - (self.startup + self.teardown - owner), 2)

    def report(self):
        print("PHASES " + json.dumps({"imports": round(self.imports, 2), "startup": round(self.startup, 2), "probes": self.probes,
                                      "teardown": round(self.teardown, 2), "total": round(time.monotonic() - self.started, 2)}),
              file=sys.stderr, flush=True)


def report_modes(ran, skipped, failed=None):
    """The test proves from this line that no requested mode was silently dropped."""
    print("MODES " + json.dumps({"ran": ran, "skipped": skipped, "failed": failed}), flush=True)
