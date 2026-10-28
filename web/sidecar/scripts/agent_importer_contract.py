"""Provision reviewed native API bytes outside tests, into the checker's disposable directory."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen


def provision(target):
    reviewed = json.loads((Path(__file__).parents[1] / 'agent_importer.json').read_text())
    pin = reviewed['revision']
    target = Path(target)
    target.mkdir()
    for name, expected in reviewed['files'].items():
        with urlopen(f'https://raw.githubusercontent.com/NousResearch/hermes-official-plugins/{pin}/agent-importers/{name}', timeout=30) as response:
            body = response.read(256 * 1024)
        if hashlib.sha256(body).hexdigest() != expected:
            raise ValueError('Reviewed importer contract source changed')
        (target / name).write_bytes(body)
    return target
