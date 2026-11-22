"""Record the prompts the released, unmodified Agent v0.23.3 builds for cron jobs (TAL-2638).

Usage: <agent-python> generate-cron-prompts.py <agent-checkout>
No model calls, account data or live store: the skills and bundle live in a throwaway HERMES_HOME and the run clock is
fixed. Each case is the user row a cron session stores, built by the Agent's own `_build_job_prompt`: a plain job, one with
skills, one with a bundle, and one whose listed skill is missing.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

agent = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(agent))
with tempfile.TemporaryDirectory(prefix="tal2638-cron-prompts-") as home:
    os.environ["HERMES_HOME"] = home
    for name in ("daily-brief", "inbox-triage"):
        skill = Path(home, "skills", name)
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(f"---\nname: {name}\ndescription: Fixture skill {name}.\n---\n\nFollow the {name} steps.\n")
    Path(home, "skill-bundles").mkdir()
    Path(home, "skill-bundles", "mornings.yaml").write_text("name: mornings\nskills: [daily-brief, inbox-triage]\n")

    from cron.scheduler_prompt import _build_job_prompt

    prompt = "Summarize what changed in the repo since yesterday.\nList open pull requests."
    jobs = {
        "plain": {"id": "job-plain", "prompt": prompt},
        "skills": {"id": "job-skills", "prompt": prompt, "skills": ["daily-brief", "inbox-triage"]},
        "bundle": {"id": "job-bundle", "prompt": prompt, "skills": ["mornings"]},
        "missing": {"id": "job-missing", "prompt": prompt, "skills": ["daily-brief", "no-such-skill"]},
    }
    with patch("cron.scheduler_prompt._hermes_now", return_value=datetime(2026, 11, 22, 9, 0, tzinfo=timezone.utc)):
        # The bundle names each skill's directory; a fixed home keeps the fixture reproducible.
        cases = {key: _build_job_prompt(job).replace(home, "/hermes-home") for key, job in jobs.items()}
    fixture = {"agentRevision": "caafe5389ae585ef77387a962aee05b1bcf17029", "agentRelease": "v0.23.3", "prompt": prompt, "cases": cases}
    Path(__file__).with_name("cron-prompts.json").write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
