#!/usr/bin/env python3
"""The NAS object helper: SigV4 curl transport with a fake curl; no network, no real credentials."""

import base64
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).with_name("s3-artifact")
FAKE_CURL = r'''#!/usr/bin/env bash
# Records its arguments and any config file, then serves a directory-backed store.
set -euo pipefail
printf '%s\n' "$@" > "$FAKE_CURL_LOG.$$"
args=("$@")
url=""; upload=""; output=""; method=""; config=""; data=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    -T|--upload-file) upload="${args[$((i + 1))]}" ;;
    -o|--output) output="${args[$((i + 1))]}" ;;
    -X|--request) method="${args[$((i + 1))]}" ;;
    -K|--config) config="${args[$((i + 1))]}"; cat "$config" >> "$FAKE_CURL_LOG.$$" ;;
    --data-binary) data="${args[$((i + 1))]}" ;;
    http*) url="${args[$i]}" ;;
  esac
done
key="${url#*/talaria-}"; key="${key#*/}"
store="$FAKE_STORE/${url#"$FAKE_ENDPOINT"/}"
if [[ "$url" == *"?lifecycle" ]]; then
  cp "${data#@}" "$FAKE_STORE/lifecycle.xml"
elif [[ -n "$upload" ]]; then
  mkdir -p "$(dirname "$store")"; cp "$upload" "$store"
elif [[ -n "$output" ]]; then
  [[ -f "$store" ]] || { echo '<Error><Code>NoSuchKey</Code></Error>' > "$output"; exit 22; }
  mkdir -p "$(dirname "$output")"; cp "$store" "$output"
fi
'''


class HelperTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-s3-helper-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "bin").mkdir()
        (self.root / "bin/curl").write_text(FAKE_CURL)
        (self.root / "bin/curl").chmod(0o755)
        (self.root / "store").mkdir()
        self.env = {
            "PATH": f"{self.root / 'bin'}:{os.environ['PATH']}", "HOME": str(self.root), "TMPDIR": str(self.root),
            "FAKE_STORE": str(self.root / "store"), "FAKE_CURL_LOG": str(self.root / "curl"),
            "FAKE_ENDPOINT": "https://nas.example.invalid",
            "TALARIA_S3_ENDPOINT": "https://nas.example.invalid", "TALARIA_S3_REGION": "garage",
            "TALARIA_S3_BUCKET": "talaria-ci", "TALARIA_S3_ACCESS_KEY_ID": "synthetic-key",
            "TALARIA_S3_SECRET_ACCESS_KEY": "synthetic-secret-value",
        }

    def helper(self, *args, env=None):
        return subprocess.run([str(HELPER), *args], env=env or self.env, capture_output=True, text=True)

    def logs(self):
        return "".join(path.read_text() for path in sorted(self.root.glob("curl.*")))

    def test_put_get_use_path_style_sigv4_without_exposing_the_secret_in_arguments(self):
        payload = self.root / "payload.json"
        payload.write_text('{"synthetic":true}\n')
        result = self.helper("put", "fixtures/pr-ci/123/1/live-responses.json", str(payload))
        self.assertEqual(result.returncode, 0, result.stderr)
        stored = self.root / "store/talaria-ci/fixtures/pr-ci/123/1/live-responses.json"
        self.assertEqual(stored.read_text(), '{"synthetic":true}\n')
        log = self.logs()
        self.assertIn("--aws-sigv4\naws:amz:garage:s3\n", log)
        self.assertIn("https://nas.example.invalid/talaria-ci/fixtures/pr-ci/123/1/live-responses.json", log)
        self.assertIn('user = "synthetic-key:synthetic-secret-value"', log, "credentials travel in a private config file")
        self.assertNotIn("synthetic-secret-value\n", log.replace('user = "synthetic-key:synthetic-secret-value"\n', ""))
        self.assertNotIn("synthetic-secret", result.stdout + result.stderr)
        self.assertEqual(list(self.root.glob("s3-artifact-*")), [], "the config file is removed")
        fetched = self.root / "fetched/live-responses.json"
        result = self.helper("get", "fixtures/pr-ci/123/1/live-responses.json", str(fetched))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(fetched.read_text(), '{"synthetic":true}\n')
        result = self.helper("get", "fixtures/pr-ci/123/1/missing.json", str(self.root / "fetched/missing.json"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixtures/pr-ci/123/1/missing.json", result.stderr)
        self.assertFalse((self.root / "fetched/missing.json").exists())
        self.assertNotIn("synthetic-secret", result.stdout + result.stderr)

    def test_missing_credentials_or_settings_fail_before_any_request(self):
        payload = self.root / "payload.json"
        payload.write_text("{}\n")
        for name in ("TALARIA_S3_ENDPOINT", "TALARIA_S3_REGION", "TALARIA_S3_BUCKET",
                     "TALARIA_S3_ACCESS_KEY_ID", "TALARIA_S3_SECRET_ACCESS_KEY"):
            env = {key: value for key, value in self.env.items() if key != name}
            result = self.helper("put", "fixtures/pr-ci/123/1/live-responses.json", str(payload), env=env)
            with self.subTest(name=name):
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(name, result.stderr)
                self.assertEqual(self.logs(), "", "no request is made without complete settings")
                self.assertNotIn("synthetic-secret", result.stdout + result.stderr)
        for key in ("../escape", "/absolute", "fixtures//double", "fixtures/pr-ci/123/1/bad name",
                    "fixtures/pr-ci/..", "fixtures/./pr-ci/1"):
            result = self.helper("put", key, str(payload))
            with self.subTest(key=key):
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.logs(), "")

    def test_lifecycle_rules_are_applied_per_bucket_with_content_md5(self):
        expected = {
            "talaria-ci": {"fixtures/": 7, "test-results/": 14, "fuzz/": 30, "performance-metrics/": 30, "buildcache/": 14},
            "talaria-release": {"handoffs/": 30, "buildcache/": 14},
        }
        for bucket, rules in expected.items():
            with self.subTest(bucket=bucket):
                result = self.helper("lifecycle", env={**self.env, "TALARIA_S3_BUCKET": bucket})
                self.assertEqual(result.returncode, 0, result.stderr)
                body = (self.root / "store/lifecycle.xml").read_bytes()
                found = dict(re.findall(rb"<Prefix>([^<]*)</Prefix>.*?<Days>(\d+)</Days>", body, re.DOTALL))
                self.assertEqual({key.decode(): int(value) for key, value in found.items()}, rules)
                self.assertEqual(body.count(b"<Status>Enabled</Status>"), len(rules))
                log = self.logs()
                self.assertIn(f"https://nas.example.invalid/{bucket}/?lifecycle", log)
                self.assertIn("Content-MD5: " + base64.b64encode(hashlib.md5(body).digest()).decode(), log)
                for path in self.root.glob("curl.*"):
                    path.unlink()
        result = self.helper("lifecycle", env={**self.env, "TALARIA_S3_BUCKET": "talaria-unknown"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.logs(), "")


if __name__ == "__main__":
    unittest.main()
