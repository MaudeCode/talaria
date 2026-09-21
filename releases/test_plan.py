"""Local Git and synthetic job receipts; no publication or cloud credentials."""

import os
import json
import shutil
import subprocess
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from plan import assemble, resolve
from release_set import COMMON_GATES, COMPONENTS


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="talaria-release-plan-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-b", "main")
        (self.root / "seed").write_text("synthetic upstream")
        self.git("add", ".")
        self.git("commit", "-m", "synthetic base")
        base = self.git("rev-parse", "HEAD")
        repository = Path(__file__).resolve().parents[1]
        for name in ("app/Talaria/Resources/Info.plist", "web/sidecar/agent_dependency.json",
                     "web/api/contract_versions.json", "relay/convex/releaseInfo.json"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(repository / name, target)
        self.git("add", ".")
        self.git("commit", "-m", "synthetic release source")
        self.source = self.git("rev-parse", "HEAD")
        self.tags = {name: f"{name}-v{index}.0.0" for index, name in enumerate(COMPONENTS, 1)}
        for tag in self.tags.values():
            self.git("tag", "-a", tag, "-m", "synthetic tag")
        self.request = {"sourceRevision": self.source, "tags": self.tags, "relayDeploymentId": "synthetic-relay"}
        self.notes = {name: f"{name} notes" for name in COMPONENTS}

    def git(self, *args):
        return subprocess.check_output([
            "git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
            "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", *args,
        ], cwd=self.root, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"},
            text=True, stderr=subprocess.PIPE).strip()

    def receipts(self, plan, *, published=False):
        def receipt(gate, **values):
            return {"gate": gate, "sourceRevision": plan["releaseSet"], "result": "success",
                    "runUrl": "https://github.com/MaudeCode/talaria/actions/runs/1", **values}
        result = [receipt(gate) for gate in sorted(COMMON_GATES)]
        for name in COMPONENTS:
            if plan["changed"][name]:
                values = {"tag": plan["components"][name]["tag"]}
                if name == "app":
                    values["buildNumber"] = 321
                    values["ipaSha256"] = "c" * 64
                elif name == "web":
                    values["image"] = "ghcr.io/maudecode/talaria-web@sha256:" + "f" * 64
                else:
                    values["deploymentId"] = "synthetic-relay"
                result.append(receipt("build" + name.title(), **values))
                if published:
                    if name == "relay":
                        values["deployedRevision"] = plan["releaseSet"]
                    result.append(receipt({"app": "uploadApp", "web": "publishWeb", "relay": "deployRelay"}[name], **values))
        return result

    def test_assembly_requires_real_component_results_and_all_gates(self):
        plan = resolve(self.root, self.request)
        self.assertNotIn("image", plan["components"]["web"])
        receipts = self.receipts(plan)
        candidate = assemble(plan, receipts, self.notes)
        self.assertEqual(candidate["status"], "candidate")
        self.assertEqual(candidate["components"]["app"]["buildNumber"], 321)
        self.assertIsNone(candidate["components"]["relay"]["deployedRevision"])
        with self.assertRaises(ValueError):
            assemble(plan, receipts, self.notes, complete=True)
        broken = deepcopy(receipts)
        broken[0]["result"] = "failure"
        with self.assertRaises(ValueError):
            assemble(plan, broken, self.notes)
        complete = assemble(plan, self.receipts(plan, published=True), self.notes, complete=True)
        self.assertEqual(complete["status"], "complete")
        self.assertEqual(assemble(plan, list(reversed(self.receipts(plan, published=True))), self.notes, complete=True)["components"], complete["components"])

    def test_unchanged_components_reuse_exact_artifacts(self):
        first = resolve(self.root, self.request)
        previous = assemble(first, self.receipts(first, published=True), self.notes, complete=True)
        (self.root / "seed").write_text("next synthetic App release")
        self.git("commit", "-am", "next source")
        source = self.git("rev-parse", "HEAD")
        self.git("tag", "-a", "app-v1.1.0", "-m", "synthetic App tag")
        request = {**self.request, "sourceRevision": source, "tags": {**self.tags, "app": "app-v1.1.0"}}
        plan = resolve(self.root, request, previous)
        self.assertEqual(plan["changed"], {"app": True, "web": False, "relay": False})
        result = assemble(plan, self.receipts(plan), self.notes, previous)
        for name in ("web", "relay"):
            self.assertEqual(result["components"][name], previous["components"][name])
        self.git("tag", "-f", "web-v2.0.0", source)
        with self.assertRaisesRegex(ValueError, "tag moved"):
            resolve(self.root, request, previous)

    def test_publication_readback_cannot_substitute_other_artifacts(self):
        plan = resolve(self.root, self.request)
        for gate, field, value in (("publishWeb", "image", "wrong"), ("uploadApp", "buildNumber", 999),
                                   ("uploadApp", "ipaSha256", "d" * 64), ("buildApp", "ipaSha256", None),
                                   ("deployRelay", "deployedRevision", "a" * 40)):
            receipts = self.receipts(plan, published=True)
            next(item for item in receipts if item["gate"] == gate)[field] = value
            with self.assertRaises(ValueError):
                assemble(plan, receipts, self.notes, complete=True)

    def test_changed_components_cannot_regress_versions(self):
        first = resolve(self.root, self.request)
        previous = assemble(first, self.receipts(first, published=True), self.notes, complete=True)
        (self.root / "seed").write_text("next release source")
        self.git("commit", "-am", "next source")
        source = self.git("rev-parse", "HEAD")
        for name, tag in (("app", "app-v0.9.0"), ("web", "web-v1.9.0"), ("relay", "relay-v2.9.0")):
            self.git("tag", "-a", tag, "-m", "synthetic regressed version")
            request = {**self.request, "sourceRevision": source, "tags": {**self.tags, name: tag}}
            with self.subTest(component=name), self.assertRaisesRegex(ValueError, "must advance"):
                resolve(self.root, request, previous)

    def test_relay_upgrade_preserves_previous_web_capability(self):
        first = resolve(self.root, self.request)
        previous = assemble(first, self.receipts(first, published=True), self.notes, complete=True)
        web = self.root / "web/api/contract_versions.json"
        relay = self.root / "relay/convex/releaseInfo.json"
        versions, info = json.loads(web.read_text()), json.loads(relay.read_text())
        old = versions["webRelay"]["protocolVersion"]
        versions["webRelay"]["protocolVersion"] = old + 1
        web.write_text(json.dumps(versions))
        for supported in ([old + 1], [old, old + 1]):
            info["contracts"]["webRelay"] = supported
            relay.write_text(json.dumps(info))
            self.git("commit", "-am", "next Web and Relay capabilities")
            source = self.git("rev-parse", "HEAD")
            tags = {**self.tags, "web": f"web-v2.0.{len(supported)}", "relay": f"relay-v3.0.{len(supported)}"}
            for name in ("web", "relay"):
                self.git("tag", "-a", tags[name], "-m", "synthetic upgrade")
            request = {**self.request, "sourceRevision": source, "tags": tags}
            if old not in supported:
                with self.assertRaisesRegex(ValueError, "previous Web"):
                    resolve(self.root, request, previous)
            else:
                resolve(self.root, request, previous)

    def test_changed_components_must_contain_previously_released_sources(self):
        older = self.source
        (self.root / "seed").write_text("newer published source")
        self.git("commit", "-am", "newer release")
        newer = self.git("rev-parse", "HEAD")
        published_tags = {name: f"{name}-v{index}.1.0" for index, name in enumerate(COMPONENTS, 1)}
        for tag in published_tags.values():
            self.git("tag", "-a", tag, "-m", "published tag")
        first = resolve(self.root, {**self.request, "sourceRevision": newer, "tags": published_tags})
        previous = assemble(first, self.receipts(first, published=True), self.notes, complete=True)
        for name, index in zip(COMPONENTS, (1, 2, 3), strict=True):
            tag = f"{name}-v{index}.2.0"
            self.git("tag", "-a", tag, older, "-m", "higher version on older source")
            request = {**self.request, "sourceRevision": older, "tags": {**published_tags, name: tag}}
            with self.subTest(component=name), self.assertRaisesRegex(ValueError, "descend"):
                resolve(self.root, request, previous)


if __name__ == "__main__":
    unittest.main()
