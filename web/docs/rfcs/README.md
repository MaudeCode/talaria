# RFCs

Design contracts for Talaria Web behavior that spans several layers: durability,
recovery, streaming, and reply rendering. Each RFC states its status; an
implemented RFC describes the current system and changes with it.

## Conventions

- One file per RFC. Filename is the topic (kebab-case), not a number.
- Top of every RFC carries a small header:

      - **Status:** Proposed | Accepted | Implemented | Withdrawn
      - **Created:** YYYY-MM-DD
      - **Updated:** YYYY-MM-DD

- Sections usually include: Problem, Goals, Non-goals, Proposal, Open
  questions. Skip what doesn't apply.
- Revisions land as edits to the RFC in the same change as the code they
  describe. Delete an RFC once it no longer describes the system.

## When to file an RFC

- The change is large enough that you want agreement before writing code.
- The change touches data-at-rest formats or recovery semantics.
- The change introduces a new architectural primitive (journal, queue,
  scheduler, cache layer) that other features will build on.
- A reviewer asks for one during code review.

When in doubt, just ship the code — small features don't need RFCs.

## Current RFCs

- [`webui-run-state-consistency-contract.md`](webui-run-state-consistency-contract.md)
  — Accepted. Consistency rules keeping transcript, model context, live
  streams, replay, compression, and session metadata coherent during active
  and recovered runs.
- [`live-to-final-assistant-replies.md`](live-to-final-assistant-replies.md)
  — Implemented. Product model for long-running assistant replies: live
  process prose, tool activity, recovery, terminal outcomes, display
  projections, and the final-answer boundary.
- [`session-sse-contract-v1.md`](session-sse-contract-v1.md) — Implemented.
  Chat and per-session SSE event names, cursor/resume semantics, replay source,
  snapshot fallback, and the session detail transcript cursor.
