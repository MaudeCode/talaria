# Agent Source Boundary

- **Status:** Implemented (TAL-245)
- **Created:** 2026-05-17
- **Superseded by:** [`architecture/sidecar-rpc.md`](../architecture/sidecar-rpc.md) and
  [`architecture/agent-api-contract.md`](../architecture/agent-api-contract.md)

## Problem (historical)

The Python backend imported Hermes Agent source into its own long-lived process.
In local installs that meant a neighbouring checkout on `sys.path`; in the
multi-container Docker setup it meant the WebUI reading the `hermes-agent-src`
volume the agent container also used. Every Agent module import coupled WebUI
releases to Agent internal layout and made the multi-container setup look more
isolated than it was.

## Resolution

The TypeScript server never imports Agent code. One Web-owned sidecar process,
`python -m talaria_sidecar`, runs on the Agent's own venv and wraps every Agent
capability behind a versioned JSON-RPC surface defined in
`packages/contracts/src/sidecar`. The sidecar owns the Agent pin
(`sidecar/agent_dependency.json`), verifies the loaded revision at handshake, and
reports drift; the server surfaces drift as `503` conditions and fails chat
closed while the sidecar is down.

The source mount remains the mechanism that gets Agent code into the container:
`docker_init.bash` stages the read-only `hermes-agent-src` volume into `/app`
and builds the venv the sidecar runs on. That is a packaging choice, not an
import boundary; a compromised WebUI still cannot rewrite the Agent source, and
the multi-container compose files keep the WebUI-side mount read-only by
default (the entrypoint warns when it is writable).

## Remaining inventory

The class-by-class list of what the sidecar wraps, and how to add a dependency,
lives in [`architecture/agent-api-contract.md`](../architecture/agent-api-contract.md).
Replacing sidecar methods with Hermes Agent HTTP APIs, where the Agent grows
them, is a per-method change on the sidecar side and does not touch the server.
