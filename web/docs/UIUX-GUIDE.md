# UI/UX Guide

This document summarizes the UI/UX principles of the current frontend. It is a
contributor guide, not a new design proposal. Source documents include
[`DESIGN.md`](../DESIGN.md), [`README.md`](../README.md),
[`THEMES.md`](../THEMES.md), and the token vocabulary in
`packages/frontend/src/theme/skins.ts`.

Use this guide when a change touches layout, chat rendering, composer chrome,
navigation, theme/skin behavior, responsive behavior, or visual hierarchy. For
purely backend changes, use the runtime/state contracts instead.

## Product shape

Talaria Web is a browser workbench for Hermes Agent with near-CLI parity: a
TypeScript server and a TanStack Start / React app under `packages/frontend/`,
built into `static/dist/`.

The primary layout is three-panel:

- left sidebar for sessions and navigation,
- center panel for chat,
- right panel for workspace file browsing and previews.

The composer is a floating glass card over the transcript, after T3 Code's
composer (TAL-429). Its footer carries only what the next message needs: model
and reasoning effort on the left; attachments, dictation, context usage, and
Stop/Send on the right. Two attached extensions share the card's edges: a top
tab for status (connection and runtime notices, manual compression, the
running turn, dictation, the YOLO warning, queued messages) and a bottom context strip for where it runs (workspace,
toolsets, profile). The terminal toggle lives in the chat header; phones reach
it from the composer's overflow menu (`#composerMobileConfigBtn` /
`#composerMobileConfigPanel`), which also takes model and reasoning when the
footer runs out of width. Settings and session-level tools live in the Control
Center. Pending attachments and action-required states (approvals,
clarifications, the queue) never move into overflow. Preserve this shape unless
the change explicitly justifies a different interaction model.

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
terse and should not duplicate the thinking area, list every tool name in the
summary, or add redundant trailing count badges.

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
  `var(--font-ui)` (`packages/frontend/src/theme/skins.ts`)
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
chat code block keeps its size on `--message-pre-code-font-size` and keeps
syntax highlighting, the Copy button, and horizontal scrolling.

An ordinary markdown table is a reading table: row separators only, no cell
grid, no header fill, no zebra rows. A wide table scrolls inside the reading
column instead of squeezing columns to an unreadable width.

Explanations live behind help, not under labels. Copy that says what a page,
section, setting, or control does and when to use it goes in a `HelpTip` (the
"?" popover in `packages/frontend/src/ui/Field.tsx`) beside the label or heading
it explains: `FieldRow`'s `hint`, `HubPage`'s `help`, or a `HelpTip` placed
directly next to a heading. Its accessible name is "About <label>"
(`m.field_help_about`). Visible sub-text is reserved for live information:
status, errors, warnings, empty states, counts, versions, and data belonging to
an item (for example a plugin's own description). A dialog's own message or
question (its `aria-describedby` text) and onboarding step copy are the content
of their flow and stay visible; how-to-use notes inside a dialog or card are
explanations and go in a `HelpTip`.

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
unfocused and idle, and expands on tap or focus (`cf-collapsed`, the third
footer-fit stage alongside `cf-icons`/`cf-burger` in `Composer.tsx`). A new
footer control is therefore hidden until the composer is expanded — anything that
must stay reachable while the user is reading belongs beside the primary action in
`.composer-right`, or in an action-required surface that blocks the collapse.

Above phone width the composer rests like T3 Code's: a hand scroll (wheel or
touch) of a transcript taller than its pane flattens the card to one prompt row
with only the right-hand actions, until the next composer interaction (focus,
pointer down, typing, drag-over). Losing focus never rests it, and a multi-line
draft (an explicit line break or a soft wrap, measured once when the scroll
arrives), attachments, an open menu or slash list, or a clarification keep it
expanded; a scroll that arrives while one of those holds is dropped, not kept
for later. The card's height eases over 200 ms both ways (instant under reduced
motion). A transcript pinned at its end re-pins as the composer grows, whatever
the auto-follow setting, so the newest message is never covered.

### Composer placement and send motion

`ChatView` renders the composer in `.composer-dock`, absolutely positioned in
`.chat-stage` over the transcript. A new or empty chat centres the dock (the
hero) with its headline hanging above the card; otherwise it docks to the
bottom. The dock's measured height is `--composer-h`, the transcript's bottom
inset and the offset for the scroll-to-end pill. One continuous wash
(`.composer-wrap::before`) runs from the dock's top edge to its bottom, like T3
Code's: clear at the top, deepening behind the card's glass, and opaque from the
card's bottom edge (`--composer-card-bottom`, measured by `Composer`) so a
scrolled-up transcript never shows around the context strip. A skin can start it
higher with `--composer-fade-height` (0 in the base skin). Keep it one layer: two
layers that meet leave a visible edge around the card (TAL-433). Leaving the hero plays a 340 ms FLIP from
the centred position (`sendMotion.ts`; instant under reduced motion). A new
chat's first send shows its text as the pending user row and leaves the hero
before the session or turn exists; the index and session routes mount separate
views, so that state (`firstSend.ts`) and the dock animation (`sendMotion.ts`)
survive the remount, and a failed send returns the text to the box. Every send, steer,
or queue returns the transcript to its end.

The top tab is a list of `ComposerNotice` entries (`ComposerTab.tsx`): an id,
a tone (`neutral`, `info`, `warning`, `error`), content, and an optional action
or dismiss. New transient status is a new entry, not new composer
chrome; `useRuntimeNotices` supplies the connection and runtime ones (offline,
Talaria server unreachable, agent unavailable, provider failure, turn error with
Retry, compressing); an unreachable server is probed with exponential backoff
and shows its countdown and a Retry action. Entries slide up from behind the card and sink back on exit;
every height change of the composer re-pins a following transcript in the same
frame, so streamed lines never hide behind a growing tab.

### Composer sizing

The composer grows with its content up to a cap. Where the browser supports
`field-sizing: content` (`textarea#msg` in `packages/frontend/src/theme/components/chat.css`,
with `field-sizing: fixed` while the placeholder shows) CSS owns that and no
script runs. Elsewhere the fallback in `packages/frontend/src/features/composer/Composer.tsx`
measures `scrollHeight` in an effect that runs only when the text changes, never
on layout or scroll. Keep these invariants when touching it:

- An empty composer keeps its resting height; do not measure the placeholder's
  wrapped height (a long busy hint would grow an empty composer).
- The measure reads `scrollHeight`, which forces a synchronous layout of the whole
  document, so its cost grows with the rendered transcript; never run it from a
  scroll or resize handler, and prefer letting `field-sizing` do the work.
- Typing and stream renders run no other measuring or storage work. The footer fit
  pass (`cf-icons`/`cf-burger`) runs only when the footer's size or content changes,
  and the local draft is written after a typing pause and at once when the session
  changes, the composer unmounts, or the page hides.
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
floating control that carries a visible label. The optional Start jump button
uses `--chat-col-inset` to ride the column's right edge instead of the pane's.

User bubbles are right-aligned inside that column and stay compact; length is
handled by progressive disclosure rather than a narrower bubble.

## Themes and skins

Theme and skin work uses the token system described in
[`THEMES.md`](../THEMES.md): `theme` is `light`, `dark`, or `system` and
resolves to the `.dark` class; `skin` is a separate axis applied with
`data-skin`, defined by the `SKINS` array in
`packages/frontend/src/theme/skins.ts`. `packages/frontend/src/theme/boot.ts`
also maps the legacy theme names `slate`, `solarized`, `monokai`, `nord`, and
`oled` to current theme/skin pairs.

Do not hardcode new colors, radii, shadows, or typography values into isolated
components when a token or existing variable can carry the intent. If a token is
missing, explain why a new one is needed.

## Evidence expected for UI changes

For any interface or interaction change:

- attach before/after images or a short video to the PR (never commit them),
- mention the tested viewport sizes and responsive states,
- add or update tests for behavior, state persistence, or regression-prone DOM
  structure where practical,
- keep stable class or data hooks when they help future visual regression tests.

## Do / don't summary

Do:

- keep the conversation primary,
- collapse noisy internals by default when settled,
- make debugging details accessible without making them visually dominant,
- use existing tokens, variables, and component patterns,
- protect action-required states such as errors and approvals,
- put explanatory copy in a `HelpTip` (`FieldRow` `hint`, `HubPage` `help`) beside its label.

Don't:

- make every tool call look like a separate chat message,
- add decorative color or motion without a user-facing reason,
- add a frontend framework, bundler plugin, or build step for ordinary UI work,
- hide important recovery, error, or approval state,
- render an explanation of a page, setting, or control as always-visible sub-text,
- document behavior the code and tests do not show.
