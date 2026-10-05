# Advanced chat setup

One optional feature for self-hosted Hermes WebUI deployments: LLM session titles. The gateway chat backend and the session-recall prefill hook were dropped with TAL-245.

## Session title generation

Hermes WebUI derives a provisional session title from the first user message
and, after the first response, may call an LLM to generate a better title
(and periodically refresh it for long sessions).

The title model receives up to 2,000 combined characters from the opening
exchange. That budget is allocated to the user request first, with any remainder
available for optional assistant context. The user request is authoritative;
assistant text is used only to clarify vague references or concrete terminology.
Generated titles are limited to 50 characters and aim to capture the durable
subject and desired outcome rather than tools, intermediate findings, or
workflow status. Explicit title regeneration can still run when no visible
assistant text is available.

For structured messages containing text and native images, title generation
uses the user text without flattening or modifying the stored message. Title
comparison and title-model inputs remove the internal `[Workspace::v1: ...]`
prefix and one terminal `[Attached files: ...]` or
`[Attached files for this steer: ...]` suffix separated by a blank line.
For structured content, this cleanup applies to the first text part that
provides title content. Literal legacy `[Workspace: ...]` text and later text
parts remain unchanged. Initial generation, explicit regeneration, and adaptive
refresh use this title-specific cleanup.

Background generation requires user text and a substantive assistant response.
It recognizes the sanitized provisional title as well as the existing raw
placeholder, so internal metadata does not make an image-containing turn look
manually titled. Image-only or metadata-only content does not provide title
text. Existing manual-title protection and the title-generation setting still
apply; this cleanup does not rewrite the transcript or native image parts.

Automatic title-generation LLM calls honor the active Hermes profile's
`auxiliary.title_generation.enabled` setting (default: `true`):

```yaml
auxiliary:
  title_generation:
    enabled: false
```

When disabled:

- the provisional first-message title stays in place and is never replaced
  or overwritten by an automatic LLM call or local fallback;
- the periodic adaptive refresh is skipped;
- the explicit "regenerate title" action still calls the title model, because
  you asked for it; leave it unused if the setting is a cost or privacy
  opt-out.

If the profile's `config.yaml` exists but cannot be read, automatic titling is
skipped for that turn (`config_unavailable`) rather than assumed enabled.

The WebUI's `auto_title_refresh_every` setting remains a separate control for
periodic refreshes of already-generated titles; it does not re-enable
automatic generation when the auxiliary flag is off.

## Gateway-backed browser chat

Dropped with TAL-245: browser chat always runs through the Agent sidecar. `HERMES_WEBUI_CHAT_BACKEND` no longer selects an execution path (the health card only reports its value) and `HERMES_WEBUI_GATEWAY_USE_RUNS_API` is not read; the gateway settings (`HERMES_WEBUI_GATEWAY_BASE_URL`, `HERMES_WEBUI_GATEWAY_API_KEY`) feed the health probe and the gateway status card.
