#!/usr/bin/env python3

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPOSITORY_LOADER = Path(__file__).parents[1] / "scripts" / "load-env"


class LoadEnvTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        scripts = self.root / "scripts"
        scripts.mkdir()
        shutil.copy(REPOSITORY_LOADER, scripts / "load-env")
        (scripts / "load-env").chmod(0o755)
        self.command = scripts / "print-env"
        self.command.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os\n"
            "print(json.dumps({key: os.environ.get(key) for key in "
            "['BASE', 'LOCAL', 'EXPLICIT', 'PROCESS', 'QUOTED', 'EMPTY']}))\n"
        )
        self.command.chmod(0o755)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def run_loader(self, *, environment=None, command=None):
        clean_environment = {
            "PATH": os.environ["PATH"],
            **(environment or {}),
        }
        return subprocess.run(
            [self.root / "scripts" / "load-env", command or self.command],
            cwd=self.root,
            env=clean_environment,
            capture_output=True,
            text=True,
        )

    def values(self, **kwargs):
        result = self.run_loader(**kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_default_files_and_process_environment_precedence(self):
        (self.root / ".env").write_text("BASE=base\nLOCAL=base\nPROCESS=file\n")
        (self.root / ".env.local").write_text("LOCAL=local\nPROCESS=local\n")

        values = self.values(environment={"PROCESS": "process"})

        self.assertEqual(values["BASE"], "base")
        self.assertEqual(values["LOCAL"], "local")
        self.assertEqual(values["PROCESS"], "process")

    def test_explicit_file_and_dotenv_syntax(self):
        (self.root / ".env").write_text("EXPLICIT=base\n")
        (self.root / ".env.local").write_text("EXPLICIT=local\n")
        explicit = self.root / "custom.env"
        explicit.write_bytes(
            b"# comment\r\nexport EXPLICIT=explicit\r\n"
            b"QUOTED=\"two words\" # comment\r\nEMPTY=''\r\n"
        )

        values = self.values(environment={"TALARIA_ENV_FILE": explicit.name})

        self.assertEqual(values["EXPLICIT"], "explicit")
        self.assertEqual(values["QUOTED"], "two words")
        self.assertEqual(values["EMPTY"], "")

    def test_shell_syntax_is_not_executed(self):
        marker = self.root / "command-ran"
        literal = f"$(touch${{IFS}}{marker})"
        (self.root / ".env.local").write_text(f"QUOTED='{literal}'\n")

        values = self.values()

        self.assertEqual(values["QUOTED"], literal)
        self.assertFalse(marker.exists())

    def test_missing_optional_files_are_ignored(self):
        self.assertEqual(self.values()["BASE"], None)

    def test_missing_explicit_file_fails_without_values(self):
        missing = self.root / "missing-secret.env"

        result = self.run_loader(
            environment={"TALARIA_ENV_FILE": str(missing), "PROCESS": "do-not-print"}
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(missing), result.stderr)
        self.assertNotIn("do-not-print", result.stderr)

    def test_malformed_entry_reports_file_and_line_without_value(self):
        malformed = self.root / ".env.local"
        malformed.write_text("BASE=ok\nnot valid secret-value\n")

        result = self.run_loader()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"{malformed}:2", result.stderr)
        self.assertNotIn("secret-value", result.stderr)

    def test_legacy_webui_file_remains_supported(self):
        webui_command = self.command.with_name("webui-json")
        self.command.rename(webui_command)
        legacy = self.root / "legacy.env"
        legacy.write_text("EXPLICIT=legacy\n")

        values = self.values(
            environment={"HERMES_WEBUI_ENV_FILE": str(legacy)},
            command=webui_command,
        )

        self.assertEqual(values["EXPLICIT"], "legacy")


if __name__ == "__main__":
    unittest.main()
