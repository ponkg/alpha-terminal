# Alpha UI Readability Refactor

## Global design system
- Added Inter for product/UI copy while reserving JetBrains Mono for prices, tickers, timestamps and keycaps.
- Added semantic light/dark tokens for primary, secondary and disabled text; surfaces; borders; accent; gain/loss; spacing; type scale; radii; and window shadows.
- Set 14px as the default minimum for body copy, with 12px reserved for compact metadata and section labels. Main copy is constrained to roughly 68ch.
- Added a visible 2px accent focus outline, selected-row treatment, hover/pressed/disabled states, higher-contrast surfaces behind text, and reduced-motion handling.
- Preserved Alpha's blue cloud/gradient background, black title bars, draggable window concept and keyboard-first controls.

## Landing page
- Added the main proposition and a clear explanation of Alpha beneath the logo.
- Distinguished the filled “Request early access” action from the outlined “Member login” action.
- Added an explicit “Preview · not yet released” badge and a persistent research-risk disclaimer in the bottom bar.
- Restyled the nav as an opaque, frosted pill and retained the Field Manual link.
- The desktop landing opens only Overview, positioned to the right of the hero copy. Other windows remain closed until requested.
- Removed the duplicated Vision paragraph from Overview. Added three concrete steps to How it works and high-contrast release badges to the How/Vision windows.
- Removed NFA, DYOR and profit-guarantee questions from the FAQ; the disclaimer is surfaced outside the FAQ.
- Renamed the social link to “X” and hid the decorative coordinate crosshair.

## Trending Coin Tracker
- Replaced the stacked prompt/header rows with one toolbar containing the search field, timeframe selector, one token count and a source/network info tooltip.
- Added fixed-width, right-aligned Price, Change, Vol and Liquidity columns; added market cap under price when available.
- Change is explicitly signed with ▲/▼ and extreme moves get a subtle badge.
- Added sortable column headings with `aria-sort`; default sorting is volume descending.
- Replaced the multi-label detection expander with one concise narrative/entity pill, and show no pill when nothing matches.
- Removed empty categories, merged overlapping Influencers/Celebrity classification, moved Other / Unclassified to the end and collapsed it by default with a classification-coverage note.
- Kept detected entities in their own scrollable sidebar section.
- Replaced repeated source/token-count/time metadata with a single “Updated … ago” line.

## News Feed
- Replaced the category sidebar with a single-column feed capped at 720px; moved category filters beside search in the toolbar.
- Reworked each story to source/time, headline, optional distinct description and tags. Source suffixes are removed from headlines where they repeat the source label.
- Descriptions are HTML/entity-decoded and are omitted when they duplicate or begin with the headline.
- Changed the low-confidence fallback from “World” to “Uncategorized”.
- Added local read/unread styling, a “N new” pill, a single live/cached update indicator and an RSS-source tooltip.
- Gave refresh a visible label and loading state; removed duplicated source/protocol/mode/footer counts.

## Scanner
- Applied the shared typography, surfaces, spacing and focus styles to scanner inputs/results without changing scanner behavior or its API.

## Hotkeys
- Replaced the old category set with Navigation, Windows, Search and Actions.
- Put editable bindings first; arrows and Enter are displayed as fixed, read-only shortcuts.
- Rendered bindings as separate keycaps, removed repeated action descriptions and duplicate instruction/status rows, and kept one bottom legend.
- Enter on a focusable row starts editing. The existing capture flow continues to reject reserved shortcuts, show conflicts and support Esc cancellation; feedback appears only while relevant.

## Desktop shell and mobile
- Added a centered empty-workspace hint and Tracker/Feed/Scanner/Hotkeys taskbar app buttons with open/focused state.
- Separated the “Connect wallet” action from a member/wallet chip; user-submitted handles are no longer shown in the taskbar.
- Added a compact help button with keycap-formatted shortcuts and retained the theme icon/label.
- Added non-modal dialog semantics, labelled windows, focus movement on open/close, Escape/back handling and focus restoration.
- At narrow widths, terminal windows become full-screen panels above the bottom app tab bar; tracker rows collapse to ticker/change and volume/liquidity lines.
- Added coarse-pointer 44px targets and `prefers-reduced-motion` overrides.

## RSS cleanup and tests
- Extracted RSS entity/markup cleanup into `lib/rss-utils.js`, including repeated entity decoding, common named/numeric entities, CDATA handling, tag/script/style removal and whitespace normalization.
- Added five utility tests and an inline-browser-script syntax test using Node's built-in test runner.
- Added `npm test` and a GitHub Actions workflow for the tests and Node syntax checks. No runtime package dependency was added.

## Design tokens
The CSS variables in `public/index.html` include:
- Type: 12 / 14 / 16 / 20 / 28px.
- Spacing: 4 / 8 / 12 / 16 / 20 / 24 / 32px.
- Light: primary `#142536`, secondary `#455a6d`, disabled `#53687c`, surface `#f3f7fb`, raised `#ffffff`, border `#7c90a4`, accent `#1769aa`, positive `#146a3b`, negative `#a52824`.
- Dark: primary `#f1f6fb`, secondary `#b7c7d6`, disabled `#96a9ba`, surface `#0d1824`, raised `#15283a`, border `#607a91`, accent `#8cc7f4`, positive `#6ad6a2`, negative `#ff8b86`.
- Radii: 4 / 8 / 12px. Window shadows are defined separately for light and dark.

## Contrast report
Calculated with the WCAG relative-luminance formula for the token pairs below. Text pairs are all above 4.5:1; border pairs are above 3:1.

| Pair | Contrast |
|---|---:|
| Light secondary on surface | 6.64:1 |
| Light secondary on raised surface | 7.15:1 |
| Light primary on surface | 14.48:1 |
| Light disabled on surface | 5.36:1 |
| Light border on surface | 3.06:1 |
| Light border on raised surface | 3.29:1 |
| Light accent on raised surface | 5.77:1 |
| Light positive on raised surface | 6.66:1 |
| Light negative on raised surface | 7.17:1 |
| Dark secondary on surface | 10.36:1 |
| Dark secondary on raised surface | 8.70:1 |
| Dark primary on surface | 16.46:1 |
| Dark disabled on surface | 7.40:1 |
| Dark border on raised surface | 3.36:1 |
| Dark accent on raised surface | 8.30:1 |
| Dark positive on raised surface | 8.42:1 |
| Dark negative on raised surface | 6.65:1 |
| Hero badge text on badge | 10.15:1 |
| Hero badge border on badge | 4.54:1 |

## Not implemented / limitations
- **Seven-point sparklines:** omitted because the current tracker payload contains latest price/change aggregates, not a seven-point historical series. Drawing synthetic sparkline points would be misleading.
- **10m and 30m volume:** the upstream token stats currently expose 5m, 1h and 24h volume aggregates, not 10m/30m aggregates. The corresponding volume cells show an em dash rather than relabelling or estimating another interval. Change percentages still follow the selected interval where available.
- **100%, 125% and 200% browser zoom / real-device QA:** not verified in a rendered browser in this pass. Responsive breakpoints, overflow and touch-target styles are in source, and the PR workflow checks JavaScript syntax/tests; a visual browser pass is still required before release.
- **Automated WCAG audit of every legacy chart/scanner state:** not run. The report covers the new semantic design-token pairs; chart-library canvas labels and remote imagery need visual inspection at runtime.
