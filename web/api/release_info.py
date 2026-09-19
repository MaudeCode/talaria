"""Release metadata available before optional Agent/runtime dependencies load."""

import json
from pathlib import Path


_agent = json.loads(Path(__file__).with_name("agent_dependency.json").read_text())
COMPATIBLE_AGENT = {
    **_agent["x-talaria"],
    "image": _agent["services"]["hermes-agent"]["image"],
}
