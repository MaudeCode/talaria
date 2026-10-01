# Talaria Web design

## Overview

Talaria Web should feel like a calm developer console, not a demo page assembled from colorful cards. The primary artifact is the conversation. Tool calls, thinking traces, context compaction records, token usage, and runtime status are useful, but they are transcript metadata and should sit below the visual priority of user and assistant prose.

The desired direction is Linear/Vercel precision with a little Claude-style conversational warmth: quiet surfaces, clear spacing, restrained accent use, and progressive disclosure for debugging detail.

## Colors

Every colour, radius, font, and spacing value is a token in `packages/frontend/src/theme/skins.ts`. `BASE` holds the light values plus the dark overrides; each skin in `SKINS` overrides a subset. Components read tokens only, so no rule names a skin or a hex value (see [THEMES.md](THEMES.md)).

- **Palette tokens** (`--bg`, `--sidebar`, `--surface`, `--border`, `--text`, `--muted`, `--accent`): the field, panels, structure, and text. The conversation stays primary; panels carry structure.
- **Accent** (`--accent` and its `--accent-*` roles): active state, focus, and quiet emphasis. Use one accent at a time.
- **Semantic tokens** (`--success`, `--warning`, `--error`, `--info`): state only, never decoration.

## Typography

Functional UI uses `--font-ui`, assistant prose uses `--font-conversation` (the UI stack unless a skin sets an editorial face), and `--font-mono` is only for code, file paths, commands, tool names, and compact metadata. Avoid making whole cards feel like terminal output unless they actually are logs.

Scale should stay tight: 11px metadata, 12px labels, 14px body, 16–18px headings. Do not proliferate 10px/10.5px/12.5px one-offs unless there is a real layout constraint.

## Layout

Conversation rhythm:

1. User message — right aligned, compact bubble.
2. Assistant content — left aligned, prose-first, no heavy bubble.
3. Tool/thinking/context traces — quiet disclosure rows inside the assistant turn.
4. Raw logs/details — hidden until explicitly expanded.

Metadata should not break the reading flow. A turn that used ten tools should read as one assistant turn with one compact `Used 10 tools` disclosure, not ten content cards.

## Elevation & Depth

Use almost no shadows in the transcript. Shadows are reserved for popovers, dropdowns, modal dialogs, and floating controls. Cards inside chat should use either a subtle border or a subtle tint, not both aggressively.

## Shapes

- Rows/list items: `4–8px` radius.
- Cards/panels: `8–12px` radius.
- Pills: only true chips/badges use `999px`.
- Avoid stacks of nested rounded rectangles. If a card contains another card, one of them is probably unnecessary.

## Components

### Tool/thinking activity group

Compact Worklog keeps live prose inline without a turn-level disclosure. Consecutive reasoning and tool rows share one quiet activity summary until prose breaks the sequence; a single supporting row stays inline. The current activity summary tracks the latest action and shimmers while active, with a static label for reduced-motion users. The live status is a pill docked bottom-center above the composer, over the transcript's bottom padding, so it appears and disappears without moving any message. The pinned transcript follows every size change, so streamed lines never hide below the fold. Once the turn settles, the work visibly folds into the "Worked" summary above the final answer rather than snapping. Explicit choices on settled disclosures persist per profile, chat, and turn. Settled turns keep the same consecutive activity groups and prose boundaries. Individual arguments and results remain behind their own disclosure. Error-family turns retain readable partial work. These defaults follow the accepted disclosure addenda in `docs/rfcs/live-to-final-assistant-replies.md`.

### Tool card

A tool card is a debug event row, not a chat message. Show icon, name, short target/preview, and status. Arguments and result snippets stay behind expansion. Result snippets should be truncated; full logs belong behind “show more”.

### Thinking/context cards

Same visual family as tool-call metadata. They should be quieter than assistant prose and should not use bright tinted full cards unless the user expands them.

Automatic compression follows a quiet live-only divider treatment rather than a
tool-card row. Use `Compressing context` for the active barrier and
`Context auto-compressed` after continuation/completion; render both as centered
non-interactive text with horizontal rules. Do not give it a caret, click
target, distinct accent color, special leading dot, or separate card identity.
Once the final answer is settled, omit the live-only compression row unless it is
needed to explain a visible recovery or error state.

### Composer

The composer is the command surface: a floating glass card (24 px radius in the default skin) with borderless, muted controls, a status tab attached above it and a context strip below. Keep it legible and focused: transparent inactive controls, circular primary actions, no theatrical hover scaling.

## Do's and Don'ts

Do:

- Collapse noisy agent internals by default.
- Use one accent color at a time.
- Prefer neutral borders and restrained surfaces.
- Make debug traces accessible and inspectable without making them visually dominant.
- Add stable class/data hooks for future visual regression tests.

Don't:

- Render every tool call as a first-class chat card.
- Mix gold, cyan, purple, orange, red, and green as decorative colors in the same viewport.
- Add new hardcoded radius/color values when a token exists.
- Use shadows, gradients, and hover transforms for routine controls.
- Hide important error or approval states; those are allowed to be prominent because they require action.
