# UI/UX Guide

This document summarizes UI/UX principles that are already visible in the
repository. It is a contributor guide, not a new design proposal. Source
documents include [`DESIGN.md`](../DESIGN.md), [`README.md`](../README.md),
[`THEMES.md`](../THEMES.md), [`docs/ui-ux/index.html`](ui-ux/index.html),
[`docs/ui-ux/two-stage-proposal.html`](ui-ux/two-stage-proposal.html), and
design comments in `frontend/src/theme/tokens.css`.

Use this guide when a change touches layout, chat rendering, composer chrome,
navigation, theme/skin behavior, responsive behavior, or visual hierarchy. For
purely backend changes, use the runtime/state contracts instead.

## Product shape

Hermes WebUI is a browser workbench for Hermes Agent with near-CLI parity and a
simple operating shape: Python on the server and one committed production build
of the TanStack Start / React / TypeScript app under `frontend/`.

The primary layout is three-panel:

- left sidebar for sessions and navigation,
- center panel for chat,
- right panel for workspace file browsing and previews.

The composer footer carries only what the current message needs: attachments,
dictation, the selected model, the active reasoning mode, context usage, and
Stop/Send. Profile, workspace, toolsets, saved prompts, voice mode and provider
quota live one level down, in the composer's overflow menu
(`#composerMobileConfigBtn` / `#composerMobileConfigPanel`) — one menu at every
width, not a second desktop-only surface. Saved prompts is the exception: it
stays a desktop-only affordance (#3571) and is absent from the menu at phone
widths. Settings and session-level tools live
in the Hermes Control Center. Pending attachments and action-required states
(approvals, clarifications, the queue card) never move into overflow. Preserve
this shape unless the change explicitly justifies a different interaction
model.

## Core feeling: calm developer console

The main artifact is the conversation. Tool calls, thinking traces, context
compaction records, token usage, runtime status, and other internals are useful,
but they are transcript metadata. They should sit below user and assistant prose
in visual priority.

Prefer:

- quiet surfaces,
- clear spacing,
- restrained accent use,
- progressive disclosure for debugging detail,
- legible text over decorative chrome.

Avoid turning the interface into a demo page of colorful cards. Errors,
approvals, and other action-required states may be prominent because the user
must notice and respond to them.

## Conversation hierarchy

A chat turn should read as one coherent story:

1. User message: right-aligned, compact bubble.
2. Assistant content: left-aligned, prose-first, not a heavy bubble. No avatar
   or repeated name row — alignment identifies the speaker, and the assistant
   role stays announced to assistive tech through visually hidden text.
3. Tool, thinking, progress, and context traces: quiet disclosure rows inside or
   adjacent to the assistant turn.
4. Raw logs and verbose details: hidden until explicitly expanded.
5. Per-turn technical metadata (duration, throughput, model, token usage,
   timestamp) sits in one footer row under the answer, not above it.

Message actions follow the same rule: Copy stays directly on the response, and
the secondary actions fold into one overflow control rather than a persistent
toolbar.

Do not render every internal event as a first-class chat card. A turn that used
many tools should summarize the work as inspectable activity, not make the user
read a stack of unrelated-looking cards.

## Tool, thinking, and activity traces

Tool cards are debug event rows, not chat messages. Show the icon, name, short
target or preview, and status first. Arguments, result snippets, and long logs
belong behind expansion, with result snippets truncated and full output behind a
show-more affordance where needed.

Thinking and context cards should share the quiet metadata visual family. They
should not overpower assistant prose. Collapsed activity summaries should be
terse, for example `Activity: 4 tools`, and should not duplicate the thinking
area, list every tool name in the summary, or add redundant trailing count
badges.

Visible interim assistant progress is part of the live conversation timeline,
not raw debug detail. Compact Activity may collapse tool arguments, long tool
results, and low-level reasoning detail, but it must not make concise
user-visible progress text available only inside a collapsed disclosure.

Automatic compression is a live-only context barrier, not a special branded
tool card. Render it as a centered, non-interactive divider with quiet horizontal
rules: `Compressing context` while the compression barrier is active and
`Context auto-compressed` when the agent has continued or the compression
completion event arrives. Do not give it a caret, click target, leading status
dot, or standalone running badge. In settled final history, remove live-only
automatic compression rows unless they explain a visible recovery or error
state.

The existing two-stage proposal in `docs/ui-ux/two-stage-proposal.html` records a
compatible direction for long turns: live work can be grouped as a worklog, then
settled history can collapse while the final answer reads as the calm
conclusion. Treat that page as an existing proposal, not as shipped behavior
unless the code and tests prove it is implemented.

Long-turn performance budgets apply to transport and mounted DOM, never to the
durable worklog history. A normal session load may return only a recent activity
preview, but the UI must expose an in-flow “Show earlier steps” affordance that
loads the omitted prefix from durable state in bounded chunks. Collapsing,
windowing, or switching sessions must not make earlier activity irretrievable.
The same invariant applies while a run is live: the renderer may mount only a
bounded, overlapping activity window, but approaching either scroll edge must
prefetch the adjacent in-memory slice and preserve the reader's viewport. Keep
the explicit earlier/newer controls as keyboard and fast-scroll fallbacks, and
settlement must still persist every row.

## Typography and content

Use three explicit font tokens:

- `--font-ui`: shell chrome, controls, composer, labels, and ordinary UI text
- `--font-conversation`: user/assistant message prose; by default this is
  `var(--font-ui)` in `frontend/src/theme/tokens.css`
- `--font-mono`: code, file paths, command lines, tool payloads, technical logs,
  and terminal output

Use semantic tokens for typography. Keep prose on `--font-conversation` by
default so it tracks `--font-ui` whenever a skin intentionally retunes UI type.
Override `--font-conversation` only for a skin that intentionally wants a
distinct prose face.
Conversation prose must remain the system sans by default. Do not introduce a
global conversation serif through the `--font-conversation` token or
selector-level overrides without explicit design approval plus code and test
evidence; keep distinct editorial prose typography explicitly opt-in or
skin-scoped.
Avoid hard-coding selector-level font stacks when a token already carries the
intent.

Keep scale tight. Avoid introducing near-duplicate one-off font sizes, colors,
radius values, or spacing values when an existing token works.

Chat prose has one typographic authority: `--message-body-font-size` (with
`--message-body-line-height`). Markdown headings inside `.msg-body` size in `em`
so the Small / Large / Extra Large preference scales them from that one step,
and every prose block — paragraph, list, blockquote, heading — shares a single
`0.65em` gap with no outer margin on the first or last block. A message is a
turn in a conversation, not a document: no divider rules under headings, no
uppercase heading styling. A skin may repaint prose, but must not reintroduce
its own prose size or spacing scale.

### Code blocks and tables in chat

Code and tables are quoted content inside prose, not cards competing with it. A
chat code block uses `10px 12px` padding and an `8px` radius (matching the
`.pre-header` it sits under) and keeps its size on
`--message-pre-code-font-size`; Prism highlighting, the Copy button, horizontal
scrolling on desktop and wrapping under 640px all stay.

An ordinary markdown table is a reading table: row separators only, no cell
grid, no header fill, no zebra rows. Columns take their natural width with a
`10ch` floor, so a wide table scrolls inside the reading column instead of
squeezing columns to an unreadable width. Sorting and filtering chrome belongs
to the explicit structured-data mode — a ```` ```csv ```` fence or a CSV
preview, both rendered into `.csv-table-wrap` — and must not appear on prose
tables.

## Color, depth, and shape

Use one accent at a time. Semantic colors are for semantic state: success,
warning, error, and info. Do not mix many bright colors decoratively in the same
viewport.

Use almost no shadows in the transcript. Reserve shadows for popovers,
dropdowns, modals, and floating controls. Chat cards should usually use either a
subtle border or a subtle tint, not aggressive combinations of both.

Avoid stacks of nested rounded rectangles. Rows and list items should feel
compact; panels and cards may be slightly rounder; true pills are reserved for
chips, badges, and the floating scroll-to-end control.

## Composer and controls

The composer is the command surface. Keep it legible, stable, and focused:

- no theatrical hover scaling for routine controls,
- no ambient chrome that crowds the model/workspace/profile controls,
- no new footer buttons on tight layouts without a clear value tradeoff,
- keep Stop/Send and context feedback easy to find while composing.

When adding a control, consider where users will find it on both wide desktop and
mobile. If a setting or quota/control surface does not fit in the composer, route
it through the appropriate Control Center panel instead of squeezing the footer.

On phone widths the composer collapses to a single prompt-preview row while it is
unfocused and idle, and expands on tap or focus (`cf-collapsed`, the third stage
of the `_fitComposerFooter()` mechanism alongside `cf-icons`/`cf-burger`). A new
footer control is therefore hidden until the composer is expanded — anything that
must stay reachable while the user is reading belongs beside the primary action in
`.composer-right`, or in an action-required surface that blocks the collapse.

### Composer sizing

The composer grows with its content up to a cap. Where the browser supports
`field-sizing: content` (`textarea#msg` in `frontend/src/theme/components/chat.css`,
with `field-sizing: fixed` while the placeholder shows) CSS owns that and no
script runs. Elsewhere the fallback in `frontend/src/features/composer/Composer.tsx`
measures `scrollHeight` in an effect that runs only when the text changes, never
on layout or scroll. Keep these invariants when touching it:

- An empty composer keeps its resting height; do not measure the placeholder's
  wrapped height (a long busy hint would grow an empty composer).
- The measure reads `scrollHeight`, which forces a synchronous layout of the whole
  document, so its cost grows with the rendered transcript; never run it from a
  scroll or resize handler, and prefer letting `field-sizing` do the work.
- The transcript's live-follow pin is decided by distance from the bottom, not by
  scroll direction, so a collapse above the tail (worklog fold, thinking card) that
  shrinks `scrollHeight` cannot unpin a reader who never scrolled.

## Responsive behavior

Mobile is not an afterthought. The repository documents a responsive layout with
a hamburger sidebar, mobile-accessible top tabs, a right-edge file slide-over,
full-height chat/composer behavior on phones, and touch-friendly controls.

For UI changes, verify the relevant states:

- wide desktop,
- ordinary laptop width,
- narrow/mobile width,
- open and closed side panels when relevant,
- long chat content and live streaming when relevant.

Controls should remain usable at touch sizes, and mobile navigation should not
steal chat height unnecessarily.

The transcript and composer default to a compact reading column on desktop:
one `--msg-max` token, 768px (48rem at the CSS-default root size), used by every
chat surface. Users who prefer to use the entire center pane can enable **Use
full-width chat** under Settings → Appearance, which is the only override.

The column's gutter lives on the containers — `.messages` and `.composer-wrap`
— not on the surfaces inside them, so a new chat surface only needs
`max-width:var(--msg-max);margin:0 auto` to line up with prose, worklogs, tool
rows, status cards, approvals and the composer. Do not add a second width rule,
a per-surface gutter, or a wide-viewport breakpoint.

Overlay affordances split by role. The scroll-to-end pill is the primary
recovery action for the response being read, so it is centred on the column
immediately above the composer (`left:50%` + `translateX(-50%)`) and is the one
floating control that carries a visible label. The secondary edge affordances —
the optional Start jump button and the outline FAB — use `--chat-col-inset` to
ride the column's right edge instead of the pane's, and stack vertically so a
taller composer cannot make them collide.

The **left** gutter carries the turn minimap (`#outlineMinimap`): one 9×2px mark
per loaded user turn, dividing the rail evenly so mark *k* sits ~*k*/*N* through
the conversation. It is part of the conversation-outline feature — same
`show_conversation_outline` preference, same `_buildEntries()` turns, same
`_jumpToMessage()` jump — with the labelled panel as its keyboard/touch fallback.
The rail is `pointer-events:none` (only the marks and never the hover preview
take pointer events) so it cannot intercept a transcript selection, and
the outline component hides it whenever the measured gutter drops below 52px, the
viewport is under 900px, full-width chat leaves no gutter, or fewer than four
turns are loaded. The current turn is a static width/colour change driven by one
`IntersectionObserver` over the rendered user rows — never a running animation.

User bubbles are right-aligned inside that column and may use up to 80% of it
(90% under 600px), sized as a percentage of `--msg-max` rather than of the
center pane. Length is handled by progressive disclosure, not by a narrower
bubble: a user message longer than 600 characters or 8 lines renders clipped to
8 lines behind a quiet fade with a **Show full message** / **Show less** button.
The clip is visual-only (`max-height` + `overflow: hidden` on `.msg-clip`): the
complete text stays in the accessibility tree at all times, so the button is a
plain action button whose accessible name states the visual change — "Show full
message visually" / "Show less of message visually" — and it carries no
`aria-expanded` / `aria-controls` (which would falsely claim a collapsed
region) and no `aria-pressed` (a toggle's name must not change with its state,
and the visible "Show less" text has to stay inside the accessible name).
Keyboard focus landing on a control below the visible boundary opens the clip
through the same `toggleMessageExpand` path, so the name stays truthful. The thresholds live in two places that must move
together — `USER_MSG_COLLAPSE_CHARS` / `USER_MSG_COLLAPSE_LINES` in
`frontend/src/features/chat/MessageRow.tsx` and `--msg-collapse-lines` in
`frontend/src/theme/tokens.css`. The fade sits
on the `.msg-clip` wrapper, not on `.msg-body`, so skins that repaint the bubble
background with `!important` keep a solid bubble.

## Themes and skins

Theme and skin work should use the existing variable system. `THEMES.md` points
to the core palette variables in `frontend/src/theme/tokens.css`; skin comments in the CSS
show the expected pattern for full palette rewrites and accent-only changes.

Current implementation has two appearance axes, sourced from `frontend/src/theme/boot.ts`:
`theme` is only `light`, `dark`, or `system` and resolves to the `.dark` class
for dark mode; `skin` is a separate axis applied with `data-skin` and currently
includes `default`, `ares`, `mono`, `slate`, `poseidon`, `sisyphus`,
`charizard`, `sienna`, `catppuccin`, `nous`, and `geist-contrast` / Geist Contrast. `slate` is both an active skin
and a legacy theme-name migration target; `solarized`, `monokai`, `nord`, and
`oled` are legacy theme names mapped to current theme/skin pairs. Do not follow
stale `data-theme`-only guidance without first proving the current
`frontend/src/theme/boot.ts` and `frontend/src/theme/tokens.css` contracts still
support it.

Do not hardcode new colors, radii, shadows, or typography values into isolated
components when a token or existing variable can carry the intent. If a token is
missing, explain why a new one is needed.

## Evidence expected for UI changes

For any interface or interaction change:

- include before/after images or a short video,
- mention the tested viewport sizes and responsive states,
- reference the affected visual inventory or design source when applicable,
- add or update tests for behavior, state persistence, or regression-prone DOM
  structure where practical,
- keep stable class or data hooks when they help future visual regression tests.

## Do / don't summary

Do:

- keep the conversation primary,
- collapse noisy internals by default when settled,
- make debugging details accessible without making them visually dominant,
- use existing tokens, variables, and component patterns,
- protect action-required states such as errors and approvals.

Don't:

- make every tool call look like a separate chat message,
- add decorative color or motion without a user-facing reason,
- introduce a frontend framework, bundler, or build step for ordinary UI work,
- hide important recovery, error, or approval state,
- treat proposal mockups as shipped behavior without code/test evidence.
