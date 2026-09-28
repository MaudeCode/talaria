# Issue tracking

Kaneo project `Talaria` (`TAL`) is the canonical work queue. GitHub pull
requests are the review and merge record for `MaudeCode/talaria`.

## Workflow

- Read the human-selected Kaneo task and its relations before implementation.
- Move selected work through the states defined in `AGENTS.md`; do not choose
  unrequested backlog work.
- Branch from `main` as `<type>/TAL-<number>-<slug>` and start each tracked
  commit subject with the Kaneo key.
- Push and open a ready PR only with the authorization defined by the active
  workflow. Merge still needs human approval.
- Pass `--repo MaudeCode/talaria` to every repository-scoped `gh` command.
- Keep API request and response evidence in the Kaneo task or PR.

External GitHub reports may provide intake, but a maintainer links or creates
the canonical Kaneo task before implementation.
