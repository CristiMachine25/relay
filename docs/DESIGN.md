# Relay design system

## Work dispatch desk

Relay helps people select an available AI account and continue their work. Start work leads with the task, account recommendation, explanation, and launch action. Quota supports that decision; it is not the headline on every screen.

The shell groups Start work, Terminals, and Accounts together. Knowledge and Skills form a tools-and-context group. Notifications remains visible, while Settings and usage refresh stay at the bottom. Find and launch is available from every screen. Navigation labels can evolve without changing persisted route identifiers or keyboard shortcuts.

## Palette

All surfaces use the semantic CSS tokens in `src/index.css`. Charts and terminal themes read those same tokens. Dark surfaces are near-black and light surfaces are white, with neutral grays defining depth. Blue means an action or selection; the quota colors retain their separate meaning.

| Role | Dark | Light |
| --- | --- | --- |
| Canvas | #080808 | #FFFFFF |
| Recessed area | #030303 | #FAFAFA |
| Surface | #111111 | #FFFFFF |
| Raised / hover | #1D1D1D | #F2F2F2 |
| Border | #303030 | #E0E0E0 |
| Primary text | #F5F5F5 | #171717 |
| Secondary text | #B4B4B4 | #595959 |
| Quiet text | #9B9B9B | #666666 |
| Action | #9AB7FF | #315BC7 |
| On action | #0F1F3E | #FFFFFF |
| Quota full | #6ADCAB | #117143 |
| Quota half | #EDCB74 | #825A00 |
| Quota low | #F8AA6F | #A6460A |
| Quota empty | #FF8B91 | #B82630 |

Account identity colors and provider marks remain distinct from availability. Every unavailable, stale, or low-quota state needs text; color alone is insufficient.

## Typography and spacing

Hanken Grotesk is the product typeface, including headings and figures. IBM Plex Mono is reserved for terminal output, paths, and commands. Product copy uses sentence case and tabular figures.

- Body and controls: 14px / 21px.
- Supporting copy: 12px / 16px.
- Screen titles: 22px / 28px.
- Section and dialog titles: 17px, semibold.
- Primary quota figures: 44px, when useful to a decision.

The product name in the sidebar is a drawn wordmark (`src/components/Wordmark.tsx`), not set in the typeface: monoline strokes in the text color, with the leg of the R in the action color. The website uses the same drawing.

The expanded sidebar is 240px, wide enough for "Find and launch" beside its shortcut. Compact mode remains 60px, or 92px on macOS to clear native window controls. Native title and drag rows remain 56px. Standard page content has 16px horizontal padding in compact windows and 28px in wider windows, with a 1440px maximum content width.

Controls use an 8px radius; grouped controls use 10px; substantial surfaces and dialogs use 14px. Rows remain flat and aligned. Shadows are reserved for overlays. No decorative gradients or ambient animation.

## Screen hierarchy

Start work presents the recommendation and explanation, continuation actions, actionable account warnings, the account fleet, then history. Recommendations are local rules using account availability and quota; do not suggest that an AI model evaluated the user's work.

Accounts retains its provider-grouped master/detail layout. Status, remaining quota, and launch actions precede advanced account configuration. Knowledge explains what is shared before showing files. Skills keeps search, selection, install destination, and installed state clear. Notifications explains what happened and provides the relevant next action. Settings groups related controls with descriptions beside them.

### Limits and plans

An account has several limits (5 hours, the week, and for some plans a weekly model limit such as Fable). A row shows one of them, chosen with a single Limits switch that Terminals, Start work and Accounts share and remember. Another limit that is running low gets a short mark on the row; the rest are in the tooltip and the account's details.

An account that cannot be used shows no gauges: one line names the limit that stopped it and when it is back. These rows sit under a quiet "Out for now" heading below the usable accounts, soonest back first. While a longer limit is spent, a shorter one is labeled as not counting instead of "100% left".

A plan's renewal or end day is a quiet line on the row. Only a plan that stops by itself is ever colored: within 7 days, then within 2. A day worked out from the start date is marked as an estimate. Start work names the plans that end in the next 7 days on one line above the board.

Screens stay mounted and switch on press. Motion on a switch is a 100ms fade and nothing that moves content.

Terminal sessions retain their lifecycle and layout. Chrome uses the shared palette, while terminal geometry, focus behavior, running hidden sessions, and container-based header adaptation remain intact.

## Interaction requirements

- Launch and resume remain direct actions.
- Unknown quota is labeled unavailable, never rendered as a measured zero.
- Stale quota remains visibly uncertain.
- All numeric navigation shortcuts retain their existing assignments, even when visual order changes.
- Find and launch remains available with Ctrl/Cmd+K; sidebar collapse remains Ctrl/Cmd+B.
- Keep the skip link, keyboard focus rings, radiogroup arrow navigation, dialog focus handling, and reduced-motion behavior.
- Native window controls and drag regions must keep their clear space.
- Validate narrow layouts and both themes using the browser demo without touching real account data.

## Design rationale

The previous design repeated quota in a large hero, alternatives, and a complete account board. The dispatch desk emphasizes the next action and places the evidence next to it. Cool slate surfaces and blue selection preserve Relay's route identity while giving tools, accounts, and terminal sessions a consistent working environment. The interface does not borrow another assistant's serif typography or imply a conversational AI feature that does not exist.
