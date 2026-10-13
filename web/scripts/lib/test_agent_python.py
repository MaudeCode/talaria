"""The image and entrypoint use one resolver, including the pre-PM fallback."""

import json
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from agent_python import install_pinned, python_request


class AgentPythonTests(unittest.TestCase):
    def test_source_interpreter(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            (source / "pyproject.toml").write_text('[project]\nrequires-python = ">=3.11,<3.15"\n')
            self.assertEqual(python_request(source), sys.executable)
            (source / "pm").mkdir()
            lock = source / "pm/lock.json"
            for version, expected in (("3.14.7+20260901", "3.14"), ("3.13.9", "3.13"), (None, "3.14")):
                with self.subTest(version=version):
                    lock.write_text(json.dumps({"packages": {"python": {"version": version}}}))
                    self.assertEqual(python_request(source), expected)
            lock.write_text('{"packages": {"python": {"version": "../python"}}}')
            with self.assertRaisesRegex(ValueError, "Invalid Agent Python pin"):
                python_request(source)
            lock.write_text('{}')
            (source / "pyproject.toml").write_text('[project]\nrequires-python = ">=3.11"\n')
            with self.assertRaisesRegex(ValueError, "Cannot derive"):
                python_request(source)
            lock.write_text('{')
            with self.assertRaises(json.JSONDecodeError):
                python_request(source)

    def test_image_install_uses_source_selection_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            pin = Path(temporary) / "pin.json"
            revision = "a" * 40
            pin.write_text(json.dumps({"x-talaria": {"sourceRevision": revision}}))
            for lock, expected in ((b'{"packages":{"python":{"version":"3.14.7+20260901"}}}', "3.14"),
                                   (b'{}', "3.13")):
                with self.subTest(lock=lock), patch("agent_python.urllib.request.urlopen", side_effect=[
                    io.BytesIO(lock), io.BytesIO(b'[project]\nrequires-python = ">=3.11,<3.14"\n'),
                ]) as fetch, patch("agent_python.subprocess.run") as run:
                    install_pinned(pin)
                    run.assert_called_once_with(["uv", "python", "install", "--no-bin", expected], check=True)
                    self.assertIn(f"/{revision}/pm/lock.json", fetch.call_args_list[0].args[0])
            for status in (404, 403, 500):
                with self.subTest(status=status), patch("agent_python.urllib.request.urlopen",
                    side_effect=HTTPError("url", status, "failure", {}, None)), patch("agent_python.subprocess.run") as run:
                    if status == 404:
                        install_pinned(pin)
                    else:
                        with self.assertRaises(HTTPError):
                            install_pinned(pin)
                    run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
