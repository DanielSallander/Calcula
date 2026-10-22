# The ribbon design system — "Calcula Clusters"

**Status:** shipped 2026-09-23. The approved mockup is the private artifact
**https://claude.ai/artifact/W2RwKUxBA79azM4Qznargi** (rev 2, nine boards); its `calcula.css` was the
spec, and every number below comes from it unless section 4 says why the shipped value differs
(one does: the light group-caption colour). The plan it was built from is
`~/.claude/plans/i-would-like-you-melodic-leaf.md`. Icons have their own policy: `docs/design/ICONS.md`.
Deferred work: `docs/design/open-items.md` §2.ae.

The authoritative sources, in the order to read them when this document and the code disagree
(the code wins, and the disagreement is a defect in this file):

| What | Where |
|---|---|
| Geometry (the fill rule, every size the shell measures against) | `app/src/api/layout/tokens.ts` |
| The token table every primitive paints with | `app/src/api/layout/theme.ts` (`LT`) |
| Token names and both baselines | `app/src/core/theme/tokens.ts`, `defaultTheme.ts`, `darkTheme.ts` |
| Skins, merge order, High-contrast rows, user overrides | `app/src/core/theme/builtInSkins.ts`, `skinLoader.ts` |
| The control grammar | `app/src/api/layout/primitives/*`, barrel `app/src/api/layout/index.ts` |
| The cluster (shell-owned chrome) | `app/src/shell/components/SectionChrome.tsx`, `SectionCell.tsx`, `SectionRenderers.tsx` |
| The frame (tab strip, band) | `app/src/shell/Ribbon/RibbonContainer.tsx`, `RibbonContainer.styles.ts` |
| A worked third-party example | `app/extensions/_template/components/MyRibbonSections.tsx` |

---

## 1. The defect this exists for

Every ribbon tab is a `PanelDefinition` registered through `registerPanel()` (`app/src/api/ui.ts`);
the shell measures each `PanelSection` and renders it in a cell, or demotes it to a launcher flyout.
That part was sound. The **look** was split three ways: the shell frame, the handful of
`@api/layout` atoms, and each extension's own emotion/styled CSS. The third share was the biggest,
so tabs drifted. The contextual Chart Design tab was the worst case the owner named: hand-rolled
42px buttons with 20x16 icons in hardcoded Office colours, seven native `<select>`s, a native
checkbox grid, unicode glyphs (✎, 🎨) as icons, and a `position: fixed` JSON overlay. None of it
followed the Dark skin, and no two tabs agreed on a button height.

The fix is architectural before it is visual: **all chrome and every control atom ship from
`@api/layout` plus one `RibbonIcon` namespace; the shell owns the frame; extensions only compose.**
Once that holds, every tab — a third-party add-in's included — inherits the look, and a skin can
retint all of it through tokens. The visual direction (rounded clusters on a band, segmented pills,
duotone icons, tooltips with shortcut chips) is what the owner approved on top of that.

---

## 2. Who owns what

```
RibbonContainer (shell)            frame: tab strip 35px + band 100px, collapse control
 └ SectionRibbonRenderer (shell)   measures sections, width/height demotion
    └ SectionCell -> SectionChrome the CLUSTER: card + caption (shell)
       └ SurfaceLayoutProvider     container = "band" | "panel" | "popover"
          └ section.component      EXTENSION code: composes @api/layout primitives only
```

An extension never draws a cluster, a caption, a card, a launcher or a flyout. It supplies a
`PanelSection` (`id`, `label`, `icon`, `component`, optional `ribbonPresentation`,
`collapsePriority`, `flyoutWidth`, `captionMode`) and a component that composes primitives. The
primitives read `useSurfaceLayout()` and lay themselves out for the surface they are mounted in, so
the **same JSX** renders as a cluster in the band, as a header-and-content row in the sidebar, and
inside a launcher flyout — which is what makes "move any panel between ribbon and sidebar" a
property of the platform rather than per-extension work.

### The cluster DOM (`SectionChrome.tsx`)

```
div[data-section-cell]     measureRef; padding-right = CLUSTER_GAP unless last, so the gap is
 |                         INSIDE offsetWidth and the ResizeObserver sees the cell's whole cost
 +- div[role=group]        the card: aria-label = section label; padding CLUSTER_PAD (8) on all
 |  [aria-label]           four sides; radius --radius-cluster; bg --ribbon-cluster-bg; hover =
 |                         inset 1px --ribbon-cluster-border-hover (a shadow, never a border, so
 |                         hover cannot move layout); content centred
 +- div[data-section-      the caption. ALWAYS the last element child (an E2E and unit oracle).
    caption]               11px/500, line-height 13, margin-top 2, --ribbon-group-label-fg
```

The gradient `border-image` divider between groups is gone; clusters are separated by space.

---

## 3. The fill rule

The owner's review of rev 1 (2026-09-22): the icon menus looked crammed while the card around them
looked empty — a 26px pill in a 77px card, 6px at the sides and 25px above and below. The rule that
fixed it: **a cluster pads equally on all four sides, and its content fills the box.**

```
band                         100   RIBBON_BAND_HEIGHT
- band padding 4 + 4          92   RIBBON_CONTENT_HEIGHT        (RIBBON_BAND_PADDING_Y = 4)
- caption block 15            77   the card                      (GROUP_LABEL_BLOCK_HEIGHT)
- card padding 8 + 8          61   BAND_MAX_CONTENT_HEIGHT       (CLUSTER_PAD = 8)
```

Every section's band content fills that 61 in **exactly one of two ways**:

| Form | Arithmetic | Built from |
|---|---|---|
| **ONE TALL ROW** | 61 | `CommandButton` heroes, `Tile`s, `IconButton size="tall"`, `Segmented size="tall"`, `StyleGallery`'s strip, a `Launcher` |
| **TWO ROWS** | 28 + `ROW_GAP` 5 + 28 = 61 | `ControlGrid` (its defaults ARE this form: `bandRows` 2, `rowGap` `ROW_GAP`), or any column with `gap: ROW_GAP` of 28px controls |

Never one short row alone, and never three rows (3 x 28 = 84 does not fit; the section demotes). A
short control **beside** a tall one is fine: the rule is about the section's content box, not every
child. Home's Clipboard is the worked case: its old 3 x 22px column became the Paste hero beside a
two-row stack (Cut, Copy / Format Painter).

Home renders a group's items **in layout order** (`HomeTabGroupComponent.tsx`, since the Excel Home
tab of 2026-10-04): each hero (`HomeTabItem.hero`) is its own full-height control, and each run of
consecutive non-hero items between heroes is one `ControlGrid` (two band rows, split at the run's
row breaks). That is all it takes to get Excel's shapes from the layout alone — Clipboard is
`[Paste][Cut Copy / Format Painter]`, Editing is `[AutoSum Fill / Clear][Sort & Filter][Find &
Select]`, Styles and Cells are three heroes each — and a user's own group gets the same treatment
(a hero in the middle splits it into two grids). Which control an item IS (a split, a menu, a
gallery) is looked up by item id; `hero` only decides where it stands. Font, Alignment and Number
declare Excel's Format Cells corner arrow through `PanelSection.dialogLauncher` (section 5.8);
the layout stores only an id (`HomeTabGroup.dialogLauncherId`), resolved in the extension's
`buildSections`, because a saved layout cannot hold a function.

Why `ROW_GAP` is 5 and not the in-row `GAP_XS` 4: with 4 between rows the pair is 60px and sits a
pixel off-centre in every cluster that uses it. `ControlGrid`'s `gap` prop therefore sets only the
gap *within* a row; the gap *between* rows is the separate `rowGap`.

The rule is general: a launcher flyout and every card popover pad 8 on all four sides too, and the
mini format toolbar is the same pill language floating over the grid.

### Measurement is TypeScript, not CSS — on purpose

Every number above is a constant in `app/src/api/layout/tokens.ts`, not a CSS custom property. The
shell **measures** the band against them (height demotion, width demotion), so a skin must never be
able to move them: a skin that changed a CSS height would desync the measurement loop and a section
would clip or demote forever. Skins own colour, radius, shadow and motion; geometry is code.

### Demotion

- **Height.** An `"auto"` section (the default) is probe-rendered; it demotes to a launcher when
  `Math.round(height) > DEMOTE_HEIGHT` (63 = 61 + 2 of slack). The rounding is load-bearing: the
  probe reads a fractional `contentRect` (61.4 at some zoom levels for 61 CSS px) and a demotion is
  **sticky for the session**, so comparing the raw value would demote a section that fits, forever
  (`shouldDemoteForHeight`, `app/src/shell/components/useSectionFit.ts`). `"inline"` skips the probe
  (declare it for sections you know are 61: heroes, tiles); `"launcher"` never renders inline
  (declare it for lists, editors, trees).
- **Width.** When the strip is too narrow, sections demote one at a time in `collapsePriority` order
  (lower first; default right-to-left). The pre-measurement width model adds
  `cellChromeWidth(isFirst, isLast) = 2 * CLUSTER_PAD + (isLast ? 0 : CLUSTER_GAP)` — 22, or 16 for
  the last cell (`SectionChrome.tsx`) — and a launcher is modelled at `LAUNCHER_BAND_WIDTH` 80
  (58 + 16 + 6) until its own probe reports. Width demotion is **live in both directions**: the
  measured widths are cached per panel (`SectionRenderers.tsx`), so every band resize recomputes
  `computeWidthDemotions` and a wider window brings clusters back inline. A DOM backstop demotes one
  more section per pass while the strip's real `scrollWidth` still overflows.
- **Cache clearing.** A skin, token-override or label-mode change clears both measurement caches
  (`clearSectionFitCache`, `clearSectionWidthCaches`; wired in `app/src/shell/bootstrap.ts`
  `wireRibbonAppearance`): a demotion measured under one skin's radii and one label mode is not
  evidence under another.
- There is **no PROMOTE for a height demotion**: once a section measured over 63 it stays a
  launcher for the session (its inline content is unmounted, so it cannot be re-measured) until an
  appearance change or a reload clears the fit cache — growing the window does not re-probe it.
  `PROMOTE_HEIGHT` was deleted (it had zero consumers). Tracked in open-items §2.ae.

### Geometry constants (`@api/layout`)

| Constant | Value | Meaning |
|---|---|---|
| `CONTROL_HEIGHT_MD` / `FIELD_HEIGHT` | 28 | the standard row: buttons, inputs, dropdowns, checkbox rows (was 26 / 24 — this reaches every dialog and pane too, intended) |
| `CONTROL_HEIGHT_SM` | 24 | compact list rows, secondary buttons |
| `TALL_CONTROL_HEIGHT` | 61 | a control that fills a cluster alone |
| `ROW_GAP` | 5 | between the two rows of a two-row cluster |
| `GAP_XS` / `GAP_SM` / `GAP_MD` | 4 / 6 / 8 | within a row / between groups / action rows |
| `RIBBON_BAND_HEIGHT` | 100 | the band ([data-ribbon-content]) |
| `RIBBON_BAND_PADDING_Y` | 4 | band padding, top and bottom (horizontal is 8) |
| `RIBBON_CONTENT_HEIGHT` | 92 | band minus padding |
| `GROUP_LABEL_BLOCK_HEIGHT` | 15 | caption: 13 line-height + 2 margin |
| `CLUSTER_PAD` | 8 | card padding, all four sides |
| `CLUSTER_GAP` | 6 | between clusters (inside the cell's padding-right) |
| `BAND_MAX_CONTENT_HEIGHT` | 61 | a section's content box; `bandLayout().maxContentHeight` |
| `DEMOTE_HEIGHT` | 63 | height demotion threshold (compare a ROUNDED height) |
| `LAUNCHER_MIN_WIDTH` / `LAUNCHER_BAND_WIDTH` | 58 / 80 | launcher button / its modelled band footprint |
| `FLYOUT_MIN/DEFAULT/MAX_WIDTH` | 240 / 320 / 480 | launcher flyout (`clampFlyoutWidth`) |
| `ICON_SIZE_SM` / `_MD` / `_LG` | 20 / 24 / 30 | the render ladder (control / rail, header, launcher / tile, hero) |
| `HERO_ICON_SLOT` / `HERO_ICON_SIZE` | 34 / 30 | hero slot and the icon in it |
| `HERO_PAD_Y` / `HERO_LABEL_GAP` / `HERO_LABEL_LINE_HEIGHT` | 6 / 2 / 13 | the one-line hero: 6 + 34 + 2 + 13 + 6 = 61 |
| `HERO_TWO_LINE_PAD_Y` / `HERO_TWO_LINE_GAP` | 2 / 1 | the two-line hero (`labelLines={2}`): 2 + 30 + 1 + 13 + 13 + 2 = 61 — the slot gives way to the 30px icon it holds |
| `HERO_SPLIT_TOP_HEIGHT` / `HERO_SPLIT_TOP_HEIGHT_TWO_LINE` | 41 / 32 | a hero split's picture part; its menu part is the rest of the 61 (20 / 29) |
| `SUBMENU_HOVER_DELAY_MS` | 200 | a `MenuSub` opens after the pointer rests on its row this long; resting as long on a different row closes it |
| `POPOVER_CARD_PADDING` / `POPOVER_CARD_BORDER` | 8 / 1 | the card overlay (`Popover card`): every menu, list, palette and flyout |
| `SUBMENU_ALIGN_OFFSET` | -9 | a `MenuSub` flyout is lifted by border + padding (`Popover alignOffset`), so its first row is level with its parent row (Excel) |
| `DIALOG_LAUNCHER_WIDTH` / `_HEIGHT` / `_GLYPH_SIZE` | 16 / 13 / 10 | the caption-row dialog launcher (Excel's corner arrow) and its glyph |
| `DIALOG_LAUNCHER_CAPTION_PAD` / `_HIDDEN_INSET` | 18 / 2 | symmetric caption padding while a launcher is declared; its inset when group labels are hidden |
| `TILE_WIDTH` | 44 | a tall tile or tall IconButton is 44 x 61 |
| `LABEL_FONT_SIZE` / `GROUP_LABEL_FONT_SIZE` | 11 / 11 | hero, launcher and caption labels (11px/500) |
| `HEADER_FONT_SIZE` | 12 | the ONE header recipe (12px/600, sentence case) |
| `MENU_ROW_HEIGHT` | 30 | menu and listbox rows |
| `TOOLTIP_DELAY_MS` | 400 | hover delay |
| `FONT_FAMILY` / `FONT_MONO` | Segoe UI Variable stack / Cascadia Code stack | no webfont is bundled (owner decision) |

---

## 4. Tokens

Every value is a `THEME_TOKENS` entry (`app/src/core/theme/tokens.ts`) with a value in **both**
baselines, so a skin can override any of them. `LT` (`app/src/api/layout/theme.ts`) writes each as
`var(--token, <light value>)` — the ONE file in `@api/layout` where a colour literal is correct. The
fallback is not decoration: a bare `var(--x)` inside a shorthand such as `border: 1px solid var(--x)`
invalidates the whole declaration when `--x` is missing, so the border vanishes instead of
degrading (`themeTokenParity.test.ts` exists because that shipped once). Parity is enforced three
ways: `tokens.test.ts` (both baselines), `themeTokenParity.test.ts` (every `_shared/lib/themeTokens.ts`
fallback equals the light value), `layoutThemeParity.test.ts` (reads `theme.ts`).

| Token | Light | Dark | Notes |
|---|---|---|---|
| **Shape and motion** ||||
| `--radius-control` | 8px | 8px | every control |
| `--radius-cluster` | 12px | 12px | the cluster card |
| `--radius-popover` | 12px | 12px | card popovers, menus, flyouts |
| `--radius-pill` | 999px | 999px | chips |
| `--motion-hover` | 120ms cubic-bezier(0.2, 0, 0, 1) | same | hover, press, focus |
| `--motion-popover` | 140ms, same curve | same | overlay enter |
| `--motion-panel` | 180ms, same curve | same | panel open/close |
| **Elevation** ||||
| `--shadow-cluster-hover` | 0 1px 2px rgba(16,24,40,.06) | 0 1px 2px rgba(0,0,0,.45) | the switch and slider thumbs (the cluster's own hover is an inset hairline) |
| `--shadow-popover` | 0 8px 24px rgba(16,24,40,.12), 0 1px 3px rgba(16,24,40,.08) | 0 8px 24px rgba(0,0,0,.55), 0 1px 3px rgba(0,0,0,.4) | cards, tooltips |
| `--shadow-toolbar` | 0 4px 16px rgba(16,24,40,.14) | 0 4px 16px rgba(0,0,0,.6) | mini format toolbar |
| `--shadow-raised` | 0 6px 16px rgba(16,24,40,.14) | 0 6px 16px rgba(0,0,0,.5) | temp-expanded band |
| **State** ||||
| `--state-accent` | #047857 | #34d399 | tab/rail indicator, checkbox/switch/slider fill, selected rings, focus ring colour |
| `--focus-ring-color` | var(--state-accent) | same | |
| `--focus-ring` | 0 0 0 2px var(--bg-surface), 0 0 0 4px var(--focus-ring-color) | same | `:focus-visible` on every primitive |
| `--accent-primary` | #10b981 | #10b981 | pre-existing; now ONLY the pressed tint (2.5:1 on white — too weak for a line) |
| `--button-pressed-bg` / `-border` | color-mix(accent-primary 14% / 45%) | 28% / 55% | pressed wash |
| `--button-hover-bg` / `-active-bg` | rgba(0,0,0,.06) / .10 | rgba(255,255,255,.08) / .13 | |
| **Ribbon surfaces** ||||
| `--ribbon-frame-bg` | #f9fafb | #1f1f20 | tab strip + frame |
| `--ribbon-band-bg` | #ffffff | #252526 | the band |
| `--ribbon-cluster-bg` | #f3f4f6 | #2b2b2e | the card (frame -> band -> card is a three-step ladder in Dark) |
| `--ribbon-cluster-border` | #e5e7eb | #38383b | popover card edge |
| `--ribbon-cluster-border-hover` | #d1d5db | #4a4a4f | card hairline on hover |
| `--ribbon-group-label-fg` | **#666d7a** | #9ca3af | see below |
| `--ribbon-tab-indicator` | var(--state-accent) | same | |
| **Controls** ||||
| `--control-border` | #d1d5db | #3f3f46 | control edges — separate from `--border-default` so a skin can split panel edges from control edges |
| `--control-divider` | #e5e7eb | #3a3a3d | dividers inside a Segmented pill, split halves |
| `--control-track` | #e5e7eb | #3f3f46 | switch track, slider track |
| `--chip-bg` / `--chip-border` | #ffffff / #e5e7eb | #303033 / #3f3f46 | a chip reads on the cluster tint |
| `--tooltip-bg` / `--tooltip-fg` | #111827 / #f9fafb | #f3f4f6 / #111827 | inverted in both skins |
| `--kbd-bg` | rgba(255,255,255,.16) | rgba(17,24,39,.10) | shortcut chip |
| `--badge-bg` / `--badge-fg` | var(--accent-color) / #ffffff | same | |
| **Icons** (see ICONS.md) ||||
| `--icon-fill-soft` | color-mix(in srgb, currentColor 50%, transparent) | 45% | a tint of the foreground, not a grey; 30/34 until 2026-09-24 (too faint, see ICONS.md) |
| `--icon-accent` | color-mix(in oklab, var(--state-accent) 88%, black) = #036448 | var(--state-accent) | **repointed** from var(--accent-primary); light one step darker 2026-09-24 (see ICONS.md 2.2) |
| `--icon-danger` | #c42b1c | #f87171 | |
| **Contextual tab accents** (>= 4.5:1 on the frame) ||||
| `--tab-accent-chart` | #1d5fd0 | #7aa7ff | Chart Design |
| `--tab-accent-table` | #0b7a6b | #4fd1c0 | Table Design |
| `--tab-accent-pivot` | #1a7a43 | #5fd08a | Pivot Table, Pivot Table Design |
| `--tab-accent-slicer` | #6a48c9 | #b39cff | Slicer Options, Timeline |
| `--tab-accent-sparkline` | #b8410a | #fb923c | Sparkline |
| `--tab-accent-report` | #8a3d0b | #fbbf24 | Report |
| `--tab-accent-writeback` | #4338ca | #a5b4fc | Writeback (a subscribed writeback region under the active cell) |
| **Sidebar and status** ||||
| `--activity-bar-bg` | #f3f4f6 | #1b1b1c | a LIGHT rail in Light (owner decision; two tokens revert it) |
| `--activity-bar-fg` / `-fg-active` | #4b5563 / #111827 | #a1a1aa / #f5f5f5 | |
| `--activity-bar-item-hover-bg` | rgba(17,24,39,.06) | rgba(255,255,255,.07) | |
| `--activity-bar-item-active-bg` | color-mix(state-accent 14%) | 24% | |
| `--activity-bar-indicator` | var(--state-accent) | same | 3px bar |
| `--side-panel-header-bg` | var(--panel-bg) | same | |
| `--status-bar-bg` / `-fg` | #217346 / #ffffff | #1b5e3a / #ffffff | |
| `--status-bar-item-bg` / `-item-hover-bg` | color-mix(in oklab, var(--status-bar-bg) 85% / 72%, black) | same | a clickable item's well: a shade OF the bar, so a skin that repaints the bar repaints its items; text on it >= 4.5:1 (tokens.test.ts) |
| `--status-bar-fg-quiet` | color-mix(in srgb, var(--status-bar-fg) 72%, transparent) | same | "nothing to report" (the code-and-scripts indicator on a file with no code); still 3:1 on the well |
| `--status-bar-attention` | #ffc83d | #ffc83d | "worth a look" dot on the bar; 3:1 on the bar and the well |
| **Aliases** (fix phantom usages) ||||
| `--border-subtle` | #eef0f3 | #303033 | |
| `--border-color` | var(--border-default) | same | was read in 20 files and declared nowhere |
| `--input-bg` | var(--bg-surface) | same | same |

Three values that are decisions, not transcriptions:

- **`--ribbon-group-label-fg` is #666d7a, not the mockup's #6b7280.** The contract value measured
  4.39:1 on the cluster card and 4.25:1 on Calcula Soft's card, below 4.5:1. #666d7a is the smallest
  same-hue step that clears 4.5 on every built-in card (band 5.21, card 4.73, Soft card 4.57).
  Captions never use `--text-tertiary`.
- **`--state-accent` is a new colour, not `--accent-primary`.** #10b981 is 2.5:1 on white: fine as
  a translucent pressed wash, invisible as a 2px indicator or a checkbox fill. `tokens.test.ts`
  asserts `--state-accent` >= 3:1 against `--bg-surface` and `--ribbon-cluster-bg`, and every tab
  accent >= 4.5:1 against `--ribbon-frame-bg`, in both baselines.
- **`--icon-accent` follows `--state-accent`**, for the same reason: at #10b981 the duotone's accent
  channel read 2.5:1 on the cluster and collapsed to a thin mark. In Light it is the state colour
  one step darker (a color-mix, still a reference), so it sits between the 50% grey and near-black;
  see ICONS.md 2.2.

**High contrast** (`HIGH_CONTRAST` in `skinLoader.ts`) gains the rows the redesign needed, because
chrome moved OFF tokens that table already strengthened: a control edge used to be
`--border-default` (which High contrast blackens) and is now `--control-border`. Light rows:
`--ribbon-cluster-border-hover`, `--control-border`, `--ribbon-tab-indicator` #000000;
`--ribbon-group-label-fg` #1a1a1a; `--icon-fill-soft` a SOLID #767676 (a translucent tint is the one
ground High contrast must not leave translucent); `--activity-bar-fg` #000000. Dark mirrors them in
white / #e8e8e8 / #9d9d9d.

---

## 5. The control grammar

Everything below ships from `@api/layout`. There is no other button, pill, menu, dropdown, toggle,
chip, slider, colour picker, tile or gallery in the ribbon, the sidebar or a flyout.

### 5.1 Which control

| The user is… | Use | Not |
|---|---|---|
| running a command — prominent | `CommandButton` (hero in the band, 28px button elsewhere) | a hand-rolled 42px button |
| running a command — secondary | `Button` / `IconButton` | |
| running one of several commands | `MenuButton` + `Menu` / `MenuItem` | a Dropdown (a Dropdown holds a VALUE) |
| running a command that has variants (Excel's split button: Paste, Borders, Merge & Center) | `SplitMenuButton`, `face` `"icon"` / `"labelled"` / `"hero"` | an `IconButton split` beside a loose Menu (no popup keyboard model) |
| opening more rows, a palette or a gallery from a menu row ("Hide & Unhide >") | `MenuSub` inside any Menu | flattening Excel's flyouts into headings |
| showing another extension's menu-bar subtree on a ribbon control | `RegisteredMenuButton` (+ `useRegisteredMenuItem`) | importing that extension, or a copied tree that drifts |
| picking a value from a list | `Dropdown` | a native `<select>` in the ribbon |
| naming a choice made in a menu (a field that opens a `MenuButton` of check rows -- Writeback's Collect from) | `FieldTrigger` (the Dropdown's own field) as the `MenuButton` trigger | a copy of the field's CSS (it drifts on the first change to the field look) |
| picking one of a few | `SegmentedChoice` (a radiogroup) | a row of ToggleButtons |
| turning a formatting-style state on/off | `ToggleButton` / `IconButton pressed` | |
| turning an option in a set on/off | `Checkbox` | |
| turning a setting on/off that takes effect at once | `Switch` | |
| reading a piece of state ("Loop: On", "3 of 12") | `Chip` (a chip reports; a button acts) | a disabled button |
| seeing a count | `Badge` | a hand-drawn circle |
| choosing a number in a range | `Slider` (onChange = live preview, onCommit = ONE document write) | a bare range input |
| typing a number that may be blank ("auto") | `NumberField blankMeans="auto"` | `Number(e.target.value)` (turns "-" into auto) |
| typing text | `Input` inside `Field` / `FieldGrid` | |
| picking a colour | `ColorSwatch` (+ `ColorPopover`) | a local swatch grid |
| applying the last colour, or picking another (Excel's Font Color / Fill Color) | `ColorSwatch split` + `onApply` | a ColorSwatch beside a loose button |
| picking a colour from a menu row ("Tab Color >", "Line Color >") | `ColorPalette` as a `MenuSub`'s children | a ColorSwatch inside the menu, or a copied swatch grid |
| opening a group's full dialog (Excel's corner arrow under Font, Alignment, Number) | declare `PanelSection.dialogLauncher` (the shell draws `DialogLauncherButton`) | a "More..." button inside the group |
| picking a pictured choice (chart type) | `Tile` in the band, `TileGallery` for all of them | |
| picking a palette | `PaletteStrip` | |
| picking a style with live preview | `StyleGallery` (`onHover` preview, `onChange` commit) | a canvas gallery |
| switching between views of a pane | `SegmentedTabs` | an underlined button row |
| joining related controls into one pill | `Segmented` (or `ControlGrid segmentOf`) | adjacent loose icons |

`Select` is still exported (restyled `appearance: none` with the grammar's chevron) for dialogs and
the places a native list is a hard requirement — the Home Customize dialog, whose journeys drive it
with `selectOption`. No built-in ribbon tab uses it any more: Home's font name, font size and
number-format pickers are `Dropdown`s, and each passes its tooltip through the `Dropdown`'s OWN
`tooltip` / `shortcut` / `commandId` props, so it lands on the combobox trigger a screen reader
announces (an earlier wrapping `<span>` never received focus; `homeTabGroupSurfaces.test.tsx` pins
"no wrapper").

### 5.2 One state machine

Written once, in `Button.tsx`, and inherited by every button-shaped primitive (Segmented children,
Tiles, split halves, menu triggers):

| State | Look | Driven by |
|---|---|---|
| rest | `--button-bg` (transparent) | |
| hover | `--button-hover-bg` | `:hover:not(:disabled)` |
| press | `--button-active-bg` | `:active` |
| **pressed / checked / selected** | `--button-pressed-bg` + 1px `--button-pressed-border` | the **ARIA attribute**: `aria-pressed`, `aria-checked` (or `aria-selected` in a pill) |
| focus | `--focus-ring` box-shadow, no outline | `:focus-visible` only (never on a mouse click) |
| disabled | `DISABLED_LOOK`: opacity .4, every `svg`/`img` inside drawn with `grayscale(1)`, default cursor | the ONLY disabled idiom (`primitives/disabled.ts`, shared by all ten disabled rules) |

Disabled was opacity .5 until 2026-10-02, when the owner found a disabled Redo beside an enabled
Undo only "slightly lighter": opacity alone left the duotone accent GREEN, and green beside green
reads as one state. The icons now lose their colour and the control fades to .4, a value set by the
disabled LABEL (2.53:1 on the Light cluster, above Excel's ~2.3; .35 falls under it). The filter
sits on the icons, never on the control, because a filter cannot be undone by a descendant and a
disabled control still carries colour that is not decoration: the ColorSwatch bar (the colour that
would be applied), a pressed fill, a checked box; an svg marked `data-colour-data` is exempt for the
same reason. An extension that hand-rolls a disabled control interpolates the same `DISABLED_LOOK`
from `@api/layout` into a class rule. An inline style cannot reach the icons, so `DISABLED_OPACITY`
alone is correct only for a control whose icons are already monochrome (`currentColor`): a duotone
RibbonIcon would keep its green accent, which is the defect this fixed.

A control greyed out FOR A REASON is `aria-disabled`, not natively disabled — a native `disabled`
button takes no focus and shows no tooltip, so "isn't available on a protected sheet" could never be
read. Button's `:disabled` rule never reaches it, so it takes `softDisabled` (`primitives/disabled.ts`,
kit-internal): `DISABLED_LOOK`, no hover or press tint, and a pressed control keeps its pressed fill.
SplitMenuButton's halves, the split ColorSwatch's halves and RegisteredMenuButton's disabled trigger
all carry that one class. It used to be written twice (Menu.tsx, and a copy in Color.tsx); a source
guard in `disabled.test.tsx` now fails if any other primitive declares an `&&[aria-disabled="true"]`
look of its own.

Pressed keys off the ARIA attribute, not a class, so what a screen reader announces and what the
user sees cannot disagree: a control that forgets `aria-pressed` also looks unpressed. Transitions
run on `--motion-hover`; reduced motion is honoured globally by
`html[data-reduced-motion="true"]` in `app/src/index.css`.

### 5.3 The primitives

| Primitive | Band geometry | Element / ARIA | Notes |
|---|---|---|---|
| `Button` | 28 (`size="md"`) or 24 (`"sm"`), padding 0 9 / 0 6 | `<button>` | `variant` flat / outlined; `icon` (20 in md); `tone="danger"`; tooltip only when `tooltip`, `shortcut` or `commandId` is given |
| `ToggleButton` | as Button | `aria-pressed={active}` | |
| `IconButton` | 24x24, 28x28, **44x61** (`"tall"`) | `aria-label={label}` always | tooltip = `tooltip ?? label`; `split` = main + 16px chevron half (`chevronLabel` default "`label` options", `chevronProps` for testids); no automatic `title` |
| `CommandButton` | **61** tall, min 58, padding 6 10, 34px slot + 11px/500 label (max 92, ellipsis); `labelLines={2}`: padding 2 10, the 30px icon in a 30px slot, two 13px lines (5.7) | `aria-pressed` when `active` | panel/popover: a 28px Button, icon fitted to 20 (`labelLines` ignored); `badge`; `chevron`; `button.textContent` is icon + label only, the whole label with its spaces in both forms (unless a badge is set — then pass `aria-label`) |
| `SplitMenuButton` | `face="icon"`: IconButton split (28 + 16, or 44x61 + 16 tall); `"labelled"`: [icon label 28][16x28 chevron], `size="sm"` 24; `"hero"`: one 61 column, picture part 41 over menu part 20 (32 / 29 with `labelLines={2}`) | `span.split > button.split-main + button.split-chevron` in every face; chevron `aria-haspopup="menu"` + `aria-expanded` | the menu anchors on the WHOLE control; `data-testid` on the half that runs, `chevronTestId` on the half that opens; disabled = `aria-disabled`, never native (both halves keep their tooltips); disabled while open closes the menu and re-enabling does not reopen it; `"hero"` outside the band is `"labelled"` |
| `MenuSub` | a 30px row with a right chevron; flyout = card at `"right-start"` (flips left), lifted by `SUBMENU_ALIGN_OFFSET` so its first row is level with the row | `menuitem` + `aria-expanded` + `aria-controls`; `aria-haspopup="menu"` with a flyout `role="menu"` (items), `aria-haspopup="dialog"` with a labelled `role="group"` (custom content) | 5.7; `MENU_ICON_BLANK` as any row's `icon` reserves the icon column without drawing; `useMenuClose()` lets custom content close the whole chain |
| `RegisteredMenuButton` / `useRegisteredMenuItem` | the trigger's own geometry | the trigger is cloned (MenuButton's attributes, or `aria-haspopup="dialog"` for a customContent card) | 5.7; re-renders on every menu-registry notification; a customContent trigger opens on click/Enter/Space AND ArrowDown/ArrowUp (focus into the card), like every popup hero; a refusal a registered row throws is shown with `alertAsync` (not awaited) as well as logged |
| `Segmented` | children's height; `"tall"` = 61 | `role="group"` + `aria-label` | border is an INSET shadow, so the pill is exactly its children's height (a real border makes it 30 and breaks 28+5+28) |
| `SegmentedChoice<T>` | 28 (or 24 / 61) | `radiogroup` of `radio` + `aria-checked`, roving tabindex | arrows move AND select, wrap, skip disabled; `iconOnly` puts the label in aria-label + tooltip |
| `SegmentedTabs` | 28; fills the width in a panel | `tablist` of `tab` + `aria-selected` | Left/Right/Home/End move and activate |
| `MenuButton` + `Menu`, `MenuItem`, `MenuSeparator`, `MenuHeading` | card popover, 30px rows | `aria-haspopup="menu"`, `role="menu"`, `menuitem` / `menuitemradio` / `menuitemcheckbox` | Up/Down wrap, Home/End, typeahead, Escape returns focus to the trigger; `onSelect` runs AFTER close; split IconButton: opens from the MAIN half |
| `Dropdown<T>` | 28, width 104 (band) / 100% (panel) | `combobox` + `listbox` of `option` + `aria-selected` | focus lands on the selected option; arrows STOP at the ends (native-select behaviour); `optionTestIdPrefix`; no `tooltip` prop — its `ariaLabel` names it |
| `FieldTrigger` | as Dropdown: 28, width 104 (band, never squeezed) / 100% (panel), or `width` | a plain `<button>`: the caller, or a MenuButton's clone, adds the ARIA | the Dropdown's trigger itself, exported; a string child is `FieldTriggerText` (one line, ellipsis, `line-height: normal` so descenders are not clipped -- the field's own is 1); `trailing` sits before the chevron (a `Badge`); the accent border while `aria-expanded` |
| `Checkbox` | one 28px row, 11px text (12 elsewhere) | a REAL `<input type="checkbox">` | `indeterminate`; `tooltip` shows on hover and becomes the input's description; `testId` on the input |
| `Switch` | 28 row, 30x16 track | `<input type="checkbox" role="switch">` | the input is an invisible layer over the row, so Playwright can click it |
| `Chip` | 24px pill | `<span>`, or `<button>` with `onClick` | `value` renders "name: **value**"; `tone` neutral/info/ok/warn/danger; `onRemove` adds a 16px close button |
| `Badge` | 14 / 16 | `<span>`, NOT aria-hidden by default | tone accent / danger / neutral |
| `Slider` | 28 row, 104 track, 5px track, 16px thumb | `<input type="range">`, readout `<output aria-hidden>` | fill is an inline gradient of two tokens; value text is `aria-valuetext` |
| `NumberField` | 28, width 62 | `<input type="number">` | blank -> null; clamps on blur only |
| `Input` / `Select` / `Field` / `FieldGrid` | 28 | native | Field is label-INLINE in the band (one 28 row), label-above elsewhere |
| `ColorSwatch` / `ColorPopover` / `ColorPalette` | `bar` 32x28 (icon over a 4px bar), `swatch` 28x28; `split`: the face (32x28) + a 16px chevron half | IconButton, or a transparent `<input type=color>` when `native`; `split` = IconButton's split, chevron `aria-haspopup="dialog"` | 5.8; Excel's words: "Theme Colors", "Standard Colors", "More Colors..."; automatic row (`automaticLabel` "No Fill", `automaticChip`, `automaticPlacement`, test id `<testId>-automatic`); `onThemeColorChange(slot, tint, hex)` keeps a theme SLOT, not a flattened hex; Escape CANCELS a typed hex draft; rendered colours carry `data-colour-data`; `ColorPalette` is the same body with no popover, for a `MenuSub` flyout; `disabled` while the palette is open closes it (through `onOpenChange(false)` when controlled) and re-enabling does not reopen it |
| `Tile` / `TileGallery` | tall 44x61 (30px icon) / popover 64x60 with caption | state attribute follows the role (radio -> aria-checked, option -> aria-selected, else aria-pressed) | a tall Tile IS an `IconButton size="tall"` |
| `PaletteStrip` | 44x28 palette radios + "More palettes" | `radiogroup` | the colour bars are DATA (`data-colour-data`) |
| `StyleGallery` | a 61px strip of 56x40 thumbs + expand | listbox grids | arrows MOVE, Enter chooses; `onHover(null)` fires BEFORE `onChange` |
| `Tooltip` | — | body portal, `role="tooltip"`, `pointer-events: none`, z 1200 | see 5.4 |
| `Popover` | — | `card` = the one overlay chrome (surface, cluster border, 12 radius, popover shadow, 8 padding, optional 11px/600 heading) | plain mode is byte-identical to the pre-redesign Popover; `returnFocus` on Escape; Escape closes only the innermost overlay (5.5); `alignOffset` shifts it along the anchor's edge (down for `"right-start"`, right otherwise), default 0 |
| `Launcher` | 61 tall, min 58, 34 slot with the section icon at 24 | `aria-haspopup="dialog"` | flyout = card chrome, heading = label (+ the section's dialog launcher), content under `popoverLayout`; opened from the KEYBOARD it moves focus to the content's first tab stop (5.8) |
| `DialogLauncherButton` / `DialogLauncherGlyph` | caption 16x13 (glyph 10), sidebar header 28x28 (glyph 12) | `<button>`, `aria-label` = label, `data-dialog-launcher`; no text | 5.8; kit chrome, not a RibbonIcon key; tooltip = label + the live shortcut of `commandId` |
| `Group`, `Stack`, `ControlRow`, `ControlGrid`, `ControlGridBreak`, `Grow`, `ActionRow`, `StatusText` | — | — | containers; `ControlGrid segmentOf` wraps same-segment runs in a pill AFTER chunking rows, so segmenting never moves a control to another row |
| `ItemList`, `Tall`, `Gallery` | a Launcher in the band | — | content with no horizontal form |

### 5.4 Tooltips and names

The native `title` shows after an OS-chosen delay, never on keyboard focus, cannot carry a styled
shortcut and ignores the skin, so the grammar replaces it with `Tooltip`:

- **No wrapper element.** The child is cloned with chained handlers; a wrapping `<span>` would break
  every `:first-child` / `> *` rule a Segmented applies and would change `button.textContent`.
- **Hover, or KEYBOARD focus only** (`:focus-visible`). Never on the focus a mouse click gives.
- **Live shortcut chip.** `commandId` resolves `formatCombo(getEffectiveCombo(id))` each time the
  tooltip opens — as a keybinding id, or through the binding that runs that command id — so a
  rebound key updates every tooltip that names it.
- **Never `data-ribbon-content`.** That tag lets the minimized ribbon recognise a press inside a
  flyout; a tooltip takes no presses, and a second match on `[data-ribbon-content]` would fail the
  E2E journeys that resolve it as a strict locator.
- **Off switch.** `html[data-tooltips="off"]` silences every tooltip; `app/e2e/fixtures.ts` sets it
  with `addInitScript` so no golden photographs a stray hover.

Naming rule: an icon-only control is always named (`label` -> `aria-label` + tooltip). A control
whose name is visible gets a tooltip only when it teaches something — a description or a shortcut.
Repeating a visible label on hover is noise; repeating it next to "Ctrl+B" is the point.

A `Dropdown` takes its tooltip as props (`tooltip`, `shortcut`, `commandId`), never from a
`<Tooltip>` wrapped around it: it renders a fragment (trigger + portalled list), so an outside
wrapper can only hang the tooltip on an extra `<span>`, which never opens on keyboard focus and puts
`aria-describedby` on the span instead of the combobox.

### 5.5 Overlays nest

A menu or dropdown is often opened from inside a launcher flyout or a card popover, whose dismissal
listens on `document`. An open Menu and an open Dropdown list therefore stop `mousedown` and
`Escape` at their own portal, and the Launcher ignores any press inside any
`[data-section-flyout]`. Without that, clicking an item in a nested list is an OUTSIDE press to the
flyout, which unmounts the list before the click lands. A `Popover` likewise ignores a press inside
a flyout portalled AFTER it (a Dropdown or colour picker opened from inside the card).

**Escape takes the innermost overlay only, in every overlay** (`ESCAPE NESTS` in `Popover.tsx`;
fixed 2026-10-04 after a review found that Escape in a gallery, a palette or the Cell Styles popover
inside a COLLAPSED group's flyout closed the flyout too, and dropped focus on `<body>`):

| Where focus is when Escape is pressed | What closes |
|---|---|
| inside a `Popover` (any caller: a gallery card, a palette, a plain popover like Cell Styles) | that popover only, focus back on its anchor: the popover's ROOT handles the key and stops it, so it never reaches `document`. Callers get this without asking — there is no prop to opt in |
| on a trigger inside an outer overlay, its popover opened by the pointer | that popover only: every document-level Escape listener (each `Popover`, the `Launcher`) defers while a `[data-section-flyout]` portalled AFTER its own is open (`laterFlyoutIsOpen`), and so do a Popover's root and a `MenuSub`'s custom content |
| anywhere, the key already handled (`defaultPrevented`) | nothing more: the `Launcher` and a Popover's root leave it alone (a Popover's own document listener still closes, as it always did) |
| in the flyout, nothing nested open | the flyout, focus back on the group button (unchanged) |

The next Escape always takes the next level out. Pinned per overlay by
`app/src/api/layout/__tests__/overlayNesting.test.tsx`.

**Layers.** Popovers sit at z-index 1100 and tooltips at 1200 — above the ribbon and task panes, and
below the context menu (`--z-context-menu`, 10000). A control that lives ON a higher surface passes a
layer: `Popover`, `Dropdown`, `ColorPopover`, `ColorPalette` and `ColorSwatch` take `zIndex`, `Tooltip` takes
`zIndex`, `IconButton` takes `tooltipZIndex`, and the parts stack themselves (a ColorSwatch's palette
at `zIndex`, its swatch tooltips +1, the trigger's tooltip +2). The mini format toolbar, which rides
on the context menu, is the worked example. Never raise a layer with a global CSS override: that is
what the toolbar did before the prop existed, and it matched every flyout with a toolbar testid in it.

**Placement and control.** `IconButton`, `ColorSwatch` and `Dropdown` take `tooltipPlacement`
("top" on a surface with something below it). `ColorSwatch` also takes a controlled `open` +
`onOpenChange`, so a toolbar that allows one palette at a time closes the other by state, not by
remounting it with a new `key`.

**Submenus.** The same rule decides who closes a `MenuSub` flyout. The parent Menu stops presses at
its portal, so the flyout's own outside-press listener never hears a press on a sibling row: the
PARENT owns which flyout is open (one per level) and closes it when the keyboard moves to another
row or the pointer rests on one. And because React delivers a portal's events through the
COMPONENT tree, every key, move and focus inside a flyout also reaches each ancestor Menu's
handlers; each Menu acts only on events whose target is DOM-inside its own list (a gallery's
ArrowLeft two levels down must not close the level around it).

### 5.6 Typography

One family (`FONT_FAMILY`, the Segoe UI Variable stack). Tab 12px (active 600). Hero, caption and
launcher labels 11px/500. Control text 12px (11px in band checkbox rows). **One header recipe** —
12px/600, sentence case, `--text-primary` — shared by sidebar section headers, side-panel titles and
the panel form of `Group`; the old uppercase + 0.5px tracking is retired. Tooltips 12px with an
11px mono chip. Readouts use tabular figures.

### 5.7 Large and medium buttons, submenus, hosted menus (2026-10-04)

Added for the Excel Home tab (the programme contract's section 6). All of it is `@api/layout`, so a
third-party tab gets Excel's shapes the same way Home does.

**Two-line heroes.** `CommandButton labelLines={2}` is Excel's large-button label: "Conditional /
Formatting v", "Format as / Table v", "Sort & / Filter v". The break is `splitHeroLabel`: the word
boundary that balances the two lines, counting the chevron (about two characters) on the second;
a tie goes to the shorter second line; one word stays on line 1 and the chevron takes line 2 alone
(Excel's Paste). Character counts, not measured pixels, so it is deterministic in jsdom and
reproduces every break on Excel's Home tab. The 61 is `2 + 30 + 1 + 13 + 13 + 2`: the 34px slot is
the one thing that gives way (34 + 26 = 60 leaves one pixel for four paddings), the icon stays 30.
A two-line hero's icon therefore sits 6px higher than a one-line hero's, so heroes side by side in
one group should agree on `labelLines`. The space between the lines stays in the first line's text
(it collapses at the line end), so `button.textContent` and the accessible name are the whole label.

**Split faces.** `SplitMenuButton` keeps one behaviour and one DOM contract in three looks:

```
face="icon"       [ico][v]                          IconButton split (unchanged)
face="labelled"   [ico Merge & Center][v]           28 (24 in "sm"); icon fitted to 20 (16)
face="hero"       +-----------+  41  pad 6 + slot 34 + 1     the picture: runs onClick
(band only)       |    ico    |
                  +-----------+  <- hairline (inset shadow on the menu part)
                  | Paste  v  |  20  1 + line 13 + pad 6     label + chevron: opens the menu
                  +-----------+
                  labelLines={2}: 32 (pad 2 + icon 30) over 29 (1 + 13 + 13 + 2)
```

The hairline sits in the middle of a plain hero's icon-to-label gap, so the picture and the label
land on the same pixels as a `CommandButton` beside it (Cells: the Insert and Delete splits beside
the Format hero). Each part is its own button and takes its own hover tint, as Excel's do. Outside
the band there is no 61px box and the hero face draws as `"labelled"`. The main half's tooltip
follows the visible-name rule (shown only when `tooltip`, `shortcut` or `commandId` gives it
something to teach); the menu half is named "`label` options" as in the icon face.

**`MenuSub`.** `<MenuSub label icon? testId? disabled? width?>children</MenuSub>` inside any Menu.

| Input | Effect |
|---|---|
| click (pointer) | opens; focus stays on the row (a second click keeps it open) |
| Enter, Space, ArrowRight, an assistive click (`detail` 0) | opens with focus on its first row; on an open flyout, steps into it (custom content that registered its own focus — `ColorPalette` — lands on its own first stop, the SELECTED swatch) |
| the pointer resting on the row `SUBMENU_HOVER_DELAY_MS` | opens; focus stays on the hovered row |
| the pointer resting as long on another row | closes it (opens that row's, if it has one); reaching the flyout first keeps it — the diagonal path across a sibling row |
| keyboard focus moving to another row | closes it at once |
| Escape / ArrowLeft inside it | closes ONLY that level, focus back on its row |
| Escape on the row while the pointer holds its flyout open | closes that flyout only, focus stays on the row — Escape always takes the innermost open level (Windows); the next Escape closes the menu |
| choosing an item at any depth | closes the WHOLE chain, focus back on the control that opened the top menu, THEN the item runs |
| Tab inside it | closes the whole chain; Tab moves on from the trigger |

Children are a menu (MenuItems, MenuSubs, separators, headings — through fragments and arrays: a
`role="menu"` with the full keyboard model; the row says `aria-haspopup="menu"`) or custom content (a
palette, a gallery: a labelled `role="group"` that keeps its own keys except Escape, and takes focus
on its first focusable when opened from the keyboard; the row says `aria-haspopup="dialog"`, ARIA's
generic popup type, because announcing "menu" would promise menu-item arrows the group does not
have). A role=menu may own only menu items, so a mix is custom content. Custom content closes the
chain with `useMenuClose()`. The flyout is laid out as `popoverLayout`, never as the band the top
menu was opened from, so a gallery in it draws its grid and not its 61px strip.

The flyout opens at `"right-start"` with `alignOffset={SUBMENU_ALIGN_OFFSET}` (-9): the card's 1px
border and 8px padding would otherwise put its first row 9px below the row that opened it, and
Excel lines the two up. `Popover`'s `alignOffset` is the cross-axis shift of any placement (down for
`"right-start"`, right for `bottom-*` / `top-*`), applied before the viewport clamp; 0 computes
exactly what Popover did before it existed.
`MENU_ICON_BLANK` passed as any row's `icon` reserves the 20px icon column without drawing — Excel
keeps the picture column on every row so labels line up; a row with no `icon` has no column.

**`RegisteredMenuButton`.** `{ menuId, itemId, trigger, placement?, width? }` draws what another
extension registered at `menuId` > `itemId` in the menu bar (`getMenus()`, `@api/ui`), so Format >
Conditional Formatting and Home > Conditional Formatting are ONE tree owned by the Conditional
Formatting extension — galleries included — and nothing is copied:

| The registered item | The trigger |
|---|---|
| has visible `children` | opens a Menu of them: `children` -> `MenuSub`, a `customContent` child -> `MenuSub` whose flyout is `customContent(onClose)` (onClose closes the chain), `action` (else `commandId` through `CommandRegistry.execute`) runs, `disabled`, `checked` (a menuitemcheckbox), `shortcut`, `separator` (tidied: never doubled or at an end), `hidden` left out, `icon` fitted to 16; each row's `data-testid` is its registered id |
| has only `customContent` | toggles a CARD popover (`aria-haspopup="dialog"`) whose whole body is `customContent(onClose)` — the card is the chrome, because the galleries hosted this way draw no background of their own |
| only runs (`action` / `commandId`) | runs it |
| is missing, `hidden` or `disabled` | is drawn `aria-disabled` (never natively: its tooltip must still be able to say why) and does nothing — not even its own `onClick` |

The registry patches items IN PLACE (`updateMenuItem`, and "mutate, then `notifyMenusChanged()`"),
so the item object never changes identity: `useRegisteredMenuItem(menuId, itemId)` re-renders on
every registry notification and reads the tree afresh — including once right after it subscribes,
because a registration between its render and its subscription notified nobody. Not drawn:
`rightAction`, and the action of an item that also has children.

### 5.8 Colour, the dialog launcher, and the keyboard into a flyout (2026-10-04)

Also added for the Excel Home tab, and also all `@api/layout`.

**The split colour button.** `ColorSwatch split` + `onApply` is Excel's Font Color / Fill Color: the
face half APPLIES the colour shown on its bar, a separate 16px chevron half opens the palette.

| Prop | What it does |
|---|---|
| `split` | IconButton's own split form, so it sizes and looks like every other ribbon split: the face keeps the bar face's 32x28 (28x24 in `"sm"`), the chevron half is 16 wide. `native` wins over `split`; `chevron` is ignored |
| `onApply` | the face half was pressed (click, Enter, Space): apply the colour on the bar. The caller's `onClick` runs first and its `preventDefault()` suppresses the apply. Without `onApply` the face is `aria-disabled` — never a live button that does nothing |
| `color` | in split mode the caller passes the LAST colour applied from this button (Excel's memory), not the active cell's; `null` draws an empty outline, so pass the automatic ink (`#000000`) for Excel's black Font Color bar |
| `chevronTestId` / `chevronLabel` | the chevron half's test id and name (default "`label` options"); `testId` stays on the face |
| `automaticPlacement` | where the automatic row sits: `"first"` (default — Font Color's "Automatic") or `"afterColors"` (below Standard Colors, above "More Colors..." — where live Excel 365 puts Fill Color's "No Fill") |
| `returnFocusTo` | (`ColorPopover`) where a pick or Escape puts focus. The split anchors the palette on its WHOLE wrapper but passes the half that opened it here |

The palette drops under the whole control, so a press on either half while it is open is not an
outside press: the chevron toggles it shut, the face closes it and applies. ArrowDown / ArrowUp on
either half open it (focus on the selected swatch); Escape or a pick return focus to the half that
opened it. Disabled is `aria-disabled` on both halves (`softDisabled`, 5.2), so both keep their
tooltips; the bar is data and keeps its hue. A pick still reports through `onChange` /
`onThemeColorChange` (slot and tint kept, never flattened) / `onAutomatic`, and the caller records it
as the new last colour. Test ids for a face `fmt-backgroundColor`: chevron
`fmt-backgroundColor-options`, palette body `fmt-backgroundColor-popover` (it follows the FACE's
id), rows `-popover-automatic`, `-popover-custom`, `-popover-hex`. Live Excel 365 (probed
2026-10-04) has no "More Fill Options..." row under Fill Color; `moreAction` can still add one.

**`ColorPalette` — the palette in a menu row.** The palette BODY with no popover of its own, for a
surface that already is the overlay — a `MenuSub` flyout, Excel's Format > Tab Color > and Borders
> Line Color >:

```tsx
<MenuSub label="Tab Color" icon={MENU_ICON_BLANK} testId="fmt-formatMenu-tabColor">
  <ColorPalette value={tab} onChange={setTab} allowAutomatic automaticLabel="No Color"
    automaticChip="none" onAutomatic={() => setTab(null)} testId="fmt-formatMenu-tabColor-palette" />
</MenuSub>
```

It takes ColorPopover's content props (`value`, `onChange`, `onThemeColorChange`, `allowAutomatic`,
`automaticLabel`, `automaticChip`, `automaticPlacement`, `onAutomatic`, `moreAction`,
`colorsHeading`, `themeSlot`, `themeTint`, `colors`, `showTheme`, `customLabel`, `testId`, `zIndex`
— `ColorPaletteContentProps`) plus `onDone`, `onEscape` and `autoFocus`. Inside a flyout:

| Input | Effect |
|---|---|
| a swatch, the automatic row, Enter in the hex field | reports, calls `onDone`, then closes the WHOLE menu chain (`useMenuClose`) — focus back on the control that opened the top menu, as a `MenuItem` does |
| the extra action (`moreAction`) | closes the chain FIRST, then runs (it usually opens a dialog, which then takes focus from the trigger and gives it back there) |
| Escape | drops a half-typed hex draft (Escape CANCELS, it never applies), then closes ONE level, focus on the row |
| opened from the keyboard | focus lands on the SELECTED swatch (else the first) once the theme grid has loaded — not on whatever button is first before the grid arrives |
| opened by the pointer | focus stays on the row; ArrowRight then steps in, on the selected swatch |
| the custom colour (`<input type=color>`) | reports LIVE while the OS picker is dragged and does not close the chain (as in ColorPopover) |

The row announces `aria-haspopup="dialog"` (custom content, 5.7). There is ONE body: ColorPopover
calls the same render function inside its anchored card, so the two cannot drift. That refactor was
held to "ColorPopover renders exactly as before" by a DOM dump of seventeen states (closed, open,
settling, typed, escaped, reopened; split and not) taken before and compared after, and
`colorPalette.test.tsx` compares the two bodies element for element. The body is a plain render
function, not a component: a `<PaletteBody>` layer was tried and failed that dump (the extra fiber
moved when the initial focus landed while the palette settled). How the palette places its own
focus in a flyout is the kit-internal `useFlyoutFocus` (`Menu.tsx`): custom content that registers
there owns both the initial keyboard focus and the step-in on ArrowRight.

**The dialog launcher (Excel's corner arrow).** A section DECLARES it; the shell draws it:

```ts
dialogLauncher: {
  label: "Format Cells: Font",          // aria-label and tooltip
  onLaunch: () => CommandRegistry.execute(CoreCommands.FORMAT_CELLS, { tab: "font" }),
  commandId: CoreCommands.FORMAT_CELLS, // the tooltip's live shortcut chip (Ctrl+1)
  // testId omitted: the default is dialog-launcher-<sectionId>
}
```

| Where | Drawn as |
|---|---|
| the group's caption cell | `DialogLauncherButton` 16x13 (glyph 10), absolutely placed at the bottom-right in the caption's 13px line box; the caption takes a symmetric `DIALOG_LAUNCHER_CAPTION_PAD` (18) on both sides so its text stays centred |
| the same cell with group labels hidden | still drawn, inset `DIALOG_LAUNCHER_HIDDEN_INSET` (2) into the card's free bottom strip |
| a collapsed group's flyout | at the right of the flyout's heading (Excel shows a collapsed group's launcher in its drop-down); choosing it closes the flyout, puts focus on the group button, then runs `onLaunch` |
| the sidebar section header | a 28x28 `size="header"` button (glyph 12) beside the header button — a sibling, since a button cannot hold a button; it works while the section is collapsed and never toggles it |

The test id is `dialog-launcher-<sectionId>` (`dialog-launcher-home.font`), never
`section-launcher-*` (the width probes read that as "this group is collapsed") and never `fmt-*`.
Every one carries `data-dialog-launcher`. The glyph (`DialogLauncherGlyph`) is kit chrome on the
24-unit grid, stroked in `currentColor`, like `DropdownChevron` — not a RibbonIcon key, which would
put the group frame in the customisable icon set. A section that declares no launcher renders
exactly the DOM and CSS it did before (no `position` rule on the cell, no caption padding), which
the visual goldens depend on. Exported from `@api/layout`: `DialogLauncherButton`,
`DialogLauncherGlyph`, `DialogLauncherButtonProps`, and the `DIALOG_LAUNCHER_*` geometry (in
`tokens.ts`, section 3; `Launcher.tsx` re-exports the same names). An extension only declares
`PanelSection.dialogLauncher`; it never draws the button itself. A single-section panel has no
sidebar header, so its launcher is not drawn there (open question).

**The keyboard into a collapsed group's flyout.** A `Launcher` opened from the keyboard (Enter or
Space on its button, or an assistive click: a click with `detail` 0) moves focus INTO its flyout, as
Excel's drop-down does — the flyout is a body portal at the END of the document, so a keyboard user
left on the group button would otherwise reach it only by tabbing through the rest of the window.

| Opened | Focus |
|---|---|
| from the keyboard | the content's first TAB STOP: not disabled, `tabIndex` 0 or more — so a roving pill (Segmented, a palette) is entered on its CURRENT item, never on an item parked at -1 |
| from the keyboard, content has nothing to focus | the heading's dialog launcher (it comes last: Excel's launcher is at the bottom of its drop-down) |
| from the keyboard, nothing at all | stays on the group button |
| by the pointer | stays where the pointer put it |
| content that focused itself while mounting (`autoFocus`) | keeps it |

Escape still closes the flyout and hands focus back to the group button.

---

## 6. Surfaces

| Surface | `container` | What changes |
|---|---|---|
| Ribbon band | `"band"` | horizontal; heroes 61; ControlGrid stacks rows; Dropdown 104 wide; Field label inline; `maxContentHeight` 61 |
| Sidebar | `"panel"` | vertical; heroes become 28px buttons; ControlGrid is one wrapping row; Dropdown fills the width; Field label above |
| Launcher flyout | `"popover"` | like panel, at the flyout width (`flyoutWidth`, 240–480) |

The sidebar transposition has no cards: a 36px header row per section (disclosure chevron, the
section icon fitted to 22, the 12px/600 label) over the content (`SectionSidebarRenderer`,
`SectionRenderers.tsx`). A single-section panel renders chrome-less. The activity rail is 48px with
40x40 chips, a 3px `--activity-bar-indicator` and the shared `Badge`. A panel moved to the sidebar
without an icon falls back to `RibbonIcon.Group`.

---

## 7. Contracts

### 7.1 E2E DOM contracts (do not break)

| Contract | Asserted in |
|---|---|
| Ribbon tabs are `<button>`s whose ONLY text is the label, in the FIRST `<div>` of `[data-ribbon-content].parentElement`; a badge is an `aria-hidden` SIBLING inside a `TabSlot` span; the first button in the strip is always a tab; a trailing non-tab control (Collapse ribbon) has no text | `app/e2e/invariants/stateSnapshot.ts`, `RibbonContainer.styles.ts` header |
| The active tab computes `font-weight: 600` | same |
| `[data-ribbon-content]` band is 100px (±1); minimize ends at computed `display: none` | `app/e2e/tests/ribbon-tabs.spec.ts`, `panel-placement.spec.ts` |
| The first `<div>` inside the band is the section strip (the band content wrapper is a `<section>` for that reason) | `app/e2e/journeys/owner-decisions.spec.ts` (D6) |
| `[data-section-cell]` carries the measure ref; its `lastElementChild` is the caption TEXT — in both label modes | `sectionWidthProbe.test.tsx`, `sectionChrome.test.tsx`, `app/e2e/journeys/shapes-hometab.spec.ts` |
| Launcher testid `section-launcher-<sectionId>`; flyouts and popovers carry `data-ribbon-content` + `data-section-flyout`; Escape closes | `panel-placement.spec.ts` |
| A group's dialog launcher is `dialog-launcher-<sectionId>` (never `section-launcher-*`, which the width probes read as "collapsed", never `fmt-*`) and carries `data-dialog-launcher`; the caption TEXT stays the cell's `lastElementChild` with or without one | `dialogLauncher.test.tsx` (shell) |
| Home buttons keep `data-testid="fmt-<id>"` + `data-active` on the same element; `sectionRows('Cells') === 3` | `shapes-hometab.spec.ts` |
| Contextual tab labels exact ("Chart Design", "Table Design", "Pivot Table", "Pivot Table Design", "Sparkline", "Slicer Options", "Timeline", "Report") with a non-null accent | invariants, walker `STANDARD_TABS` |
| `title="Close Task Pane"`; Animation transport keeps `title="Play" / "Step forward" / "Stop (reset)"` | `insight-overlays.spec.ts`, `animation.spec.ts`, `dirty-flag.spec.ts` |
| PanelContextMenu items stay plain `<button>`s with text "Move to Sidebar" / "Move to Ribbon" / "Edit Script..." | `panel-placement.spec.ts` |
| A Tooltip portal never carries `data-ribbon-content` | `tooltip.test.tsx` |

A hero must never be labelled exactly like its tab: the tab is found as the only `<button>` whose
text equals the label (`reportTabSection.test.tsx` and the template test pin this).

### 7.2 `captionMode`

`PanelSection.captionMode?: "default" | "always"` (`app/src/api/uiTypes.ts`). `"always"` keeps the
caption visible when the user hides group labels. It exists for one reason: the Add-ins tab's
caption is the **host-drawn attribution** naming which add-in contributed the buttons, and a
sandboxed surface must never lose its attribution to a cosmetic preference. Use it only for a
caption that carries information the section cannot lose.

### 7.3 Label preference

Captions are **on by default** (the Power BI idiom). `calcula.appearance.ribbonLabels` holds the
literal `"hide"` or is **absent** — "show" is never written, so turning labels back on leaves storage
exactly as a fresh install has it, which is what the E2E residue guard
(`app/e2e/volatilePersistedState.ts`) treats as clean. The loader stamps
`<html data-ribbon-labels="show|hide">`. Hidden, the caption keeps its TEXT at zero height (so the
`lastElementChild` oracle and the screen-reader name are unchanged) and the card carries the label
as its `title`. Reachable from View > Show Ribbon Group Labels, the ribbon's right-click menu
("Hide group labels") and Settings > Appearance. API: `getRibbonLabelMode` / `setRibbonLabelMode`
(`@api/appearance`).

### 7.4 User token overrides

`setUserTokenOverrides(map)` (`@api/appearance`) REPLACES the user's override set
(`calcula.appearance.userTokens`, absent when empty). The Appearance page's accent picker writes
`--accent-primary` and `--state-accent` through it. The sanitiser (`skinLoader.ts`
`isSafeTokenValue`) is structural, not cosmetic: the injected stylesheet is one `:root { ... }` line
with the accessibility tokens in it, so a value that closes the rule, ends the declaration early,
opens a comment or leaves a bracket open would swallow High contrast. Refused: names outside
`THEME_TOKENS`; `; { } < > \ ! @` and backquote; control characters; unbalanced brackets or quotes;
over 256 characters; any function but the colour/length/timing ones (so `url()` and `!important`
never get in — a `url()` in a token FETCHES the first time something paints with it).

**Merge order**, lowest to highest: baseline -> skin tokens -> density/font -> **user overrides** ->
**accessibility** (High contrast, forced base, font scale). The user beats the skin because it is
their machine; accessibility beats the user because it is the one layer a forgotten preference must
never defeat. `forcedBase` discards the user's overrides along with the skin's (an override chosen
against a light base is exactly the light-on-light result forcedBase exists to prevent).

---

## 8. Skins

A `Skin` (`app/src/core/theme/skin.ts`) is a DELTA over a light or dark baseline: `tokens` (any
`THEME_TOKENS` name), `grid` (canvas colours), `density`, `fontFamily`, `assets`. Built-ins, in
gallery order (`BUILTIN_SKINS`):

| Skin | Base | Delta |
|---|---|---|
| **Light** `calcula.light` | light | none — it IS the light baseline |
| **Dark** `calcula.dark` | dark | none — it IS the dark baseline |
| **Calcula Soft** `calcula.soft` | light | radius 10 / 16 / 16; `--accent-primary` #6366f1; `--state-accent` #4f46e5; frame #f7f8fc; cluster #eef0f7, border #e2e5f0, hover #cdd2e6; rail #eef0f6, active chip at 12% |
| **Calcula Contrast** `calcula.contrast` | light | radius 2 / 2 / 2; white cluster and frame; black cluster borders, control borders and dividers; caption #1f2937; solid soft icon #7a7a7a; `--state-accent` #00543a |

Soft and Contrast are nothing but token deltas, on purpose: **if either ever needs a line of
component code to look right, that component is painting with something that is not a token.**
Contrast is a look; the High contrast toggle is an accessibility override applied on top of any
skin, and the two compose.

### How a company skin overrides the chrome

The same way Soft does — a delta, no code:

```ts
import { registerSkin, setActiveSkin } from "@api/appearance";

registerSkin({
  id: "acme.brand",
  name: "Acme",
  base: "light",
  tokens: {
    "--state-accent": "#0b5cad",          // indicators, checks, focus ring, icon accent
    "--accent-primary": "#1672d6",        // the pressed wash
    "--ribbon-cluster-bg": "#eef3f9",
    "--ribbon-frame-bg": "#f7f9fc",
    "--radius-control": "6px",
    "--radius-cluster": "10px",
    "--tab-accent-chart": "#0b5cad",
    "--activity-bar-bg": "#0b2545",       // a dark rail in a light skin: two tokens
    "--activity-bar-fg": "#c9d6e8",
  },
});
```

An organisation can also ship it without an extension: machine policy
(`%PROGRAMDATA%\Calcula\policy.json`, `app/src-tauri/src/managed_policy.rs`) names an **advisory**
default skin, delivered as a signed skin pack (a `.calp` of kind `"skin"`, `core/calp/src/skin_pack.rs`).
Precedence (`resolveEffectiveSkinId`, `app/src/api/appearancePolicy.ts`): the user's own choice >
the org default > the built-in. Accessibility wins over all of them.

What a skin **can** retint: every colour, radius, shadow and motion above, the six contextual-tab
accents, the rail, the status bar and the three icon channels. What it **cannot** move: geometry
(section 3 — code, because the shell measures against it) and the icon drawings. Note that skins
registered by an extension or an org go through no value check — only user overrides do (7.4).

---

## 9. What a third-party extension gets for free

1. **The look.** A panel composed from `@api/layout` primitives and `RibbonIcon` renders as
   clusters in the band, rows in the sidebar and a card flyout when demoted, in every skin, with
   High contrast and reduced motion honoured — and writes no CSS.
2. **Placement.** The user can move it between ribbon and sidebar; a section too tall or too wide
   for the band demotes to a launcher instead of clipping. Placement is never refused for layout.
3. **Accessibility.** Names, roles, roving tabindex, keyboard models, focus return and
   keyboard-only tooltips are in the primitives, not in the caller.
4. **Shortcuts in tooltips.** Pass `commandId` and the chip follows the user's rebinding.

**Start from `app/extensions/_template/`.** `components/MyRibbonSections.tsx` is the design system
on one page: a hero section (ONE TALL ROW) and a two-row section (`SegmentedChoice` + `Dropdown` on
row 1, two `Checkbox`es on row 2), both with section icons, state in an external store so it
survives moving between surfaces, and a test that renders both under `bandLayout()`, `panelLayout()`
and `popoverLayout()` and asserts `findHardcodedColours(container)` is `[]`.

**Sandboxed add-ins** (worker realm, no React) get the same look through the host: their ribbon
buttons are descriptors the trusted `AddInsRibbonSection.tsx` renders as `CommandButton` heroes,
one cluster per contribution group, attribution as an always-shown caption
(`docs/design/third-party-addin-authoring.md` §8).

### The checklist a section is held to

- Composes only `@api/layout` primitives and `RibbonIcon`; imports only `@api` / `@api/*` /
  `extensions/_shared`.
- Band content is ONE TALL ROW of 61 or TWO ROWS of 28 + 5 + 28.
- Every `PanelSection` has an `icon` (a RibbonIcon at 24); a contextual `PanelDefinition` has an
  `icon` at 20 and `ribbonColor: "var(--tab-accent-<x>, <light hex>)"`.
- No colour literal outside `var(--x, #fallback)`. Categorical colour DATA (palettes, style
  thumbnails, a user's chosen colour) stays literal in a data module and its rendered element carries
  `data-colour-data`.
- No native `<select>` in the band, no emoji or unicode glyph as an icon, no `position: fixed`
  layer (use `Popover`, which portals and escapes the band's overflow clip), no `title` where a
  Tooltip belongs.
- State that must survive a surface move lives outside the component.
- A test renders each section under `bandLayout()` and `panelLayout()` and asserts
  `expect(findHardcodedColours(container)).toEqual([])`.

### Enforcement

- **Lint:** the chrome hex ban in `app/eslint.boundaries.js` (`chromeColorConfigs`, run by
  `npm run lint:boundaries`) covers `src/api/layout/**`, `src/api/icons/**`, the shell's ribbon,
  cluster, rail, task pane, toast, status bar and mini toolbar, every migrated extension file and
  `extensions/_template/**`. A literal is allowed only inside a string that also contains `var(`.
  Exempt by name: `theme.ts` (the token layer), `colors.ts` (the standard colour DATA), `testing.ts`.
- **Render:** `findHardcodedColours(root)` (`app/src/api/layout/testing.ts`, exported from
  `@api/layout` so extension tests can reach it through the facade) scans inline styles, SVG
  `fill`/`stroke`/`color`/`stop-color` and the CSS rules of every class in the subtree, after
  stripping `var(--x, fallback)`. Named colours are fenced with `(?<![\w-])…(?![\w-])`, because
  `\b` matched the `white` of every `white-space: nowrap`.

---

## 10. Gotchas that cost this programme a run each

1. **@emotion/css composition.** Interpolating another `css()` class inside a selector
   (`&:checked + .${track}`) does NOT reference it — emotion splices that class's declarations into
   the selector, and the browser silently discards the rule. Use structural selectors
   (`&:checked + span`, `> input`).
2. **Specificity.** Primitives JOIN class names rather than `cx`-merging them: `cx` mints a merged
   class at render time that lands after every module-level rule and out-ranks a Segmented's
   `> *` override. Segmented's child rules use `&&` so they win by specificity, not by stylesheet
   order. Style a primitive from outside through props or `style`, not a competing class.
3. **jsdom** drops `background: var(...)` shorthands from `getComputedStyle`, has no layout and no
   `ResizeObserver`. Assert geometry through inline styles or declared rule text; widths and
   demotion are proved in the live app (the D6 method: feed measured `[data-section-cell]` widths
   to `computeWidthDemotions`).
4. **The Checkbox/Switch tooltip is hover-only**: the anchor is the `<label>`, and focus sits on the
   input inside it, so `:focus-visible` never matches the anchor. The tooltip text is therefore
   also the input's `aria-describedby`, which puts it in `label.textContent`.
5. **A CommandButton with a `badge`** has the count in `textContent` ("F3Filter"). Pass
   `aria-label` when the accessible name matters.
6. **`ControlGrid`'s `gap` is the in-row gap only**; the row gap is `rowGap`. Never pass
   `bandRows={3}`.
7. **The width backstop must wait for widths (BUG-0130).** `SectionRibbonRenderer`'s DOM-truth
   backstop forces one more demotion per commit while the strip really overflows. On a COLD mount
   the strip overflows before any cluster has reported a width, and the forced count once ran up to
   the section total there and never came down: the first Chart Design of a session came up with
   all six clusters as launchers while its own measured widths fit four. It now forces nothing
   until every section has a width, and drops a standing count whenever the measurements change.
   The failure was timing-dependent — a full run passed the same assertion a colder targeted run
   failed — and jsdom cannot reach it without a faked `scrollWidth` (see sectionWidthProbe.test.tsx).
8. **A golden written on a missing baseline is not reviewed.** Playwright's default writes a
   missing snapshot on the first run. The first Sparkline golden was written that way and
   photographed BUG-0130 itself (every cluster a launcher). Delete auto-written baselines and
   record them deliberately, after the run that proves the behaviour.
9. **One owner per observer (BUG-0133).** A ResizeObserver created in a callback ref is
   disconnected by that ref's `null` call, and by nothing else. SectionCell and useSectionFit also
   disconnected theirs from an unmount-only `useEffect` cleanup; React 18 StrictMode (every dev
   build and every E2E run) replays effect cleanups in a simulated unmount WITHOUT re-running
   callback refs, so both probes died after mount and the width collapse trusted widths measured
   before the clusters' content had rendered.
10. **Enter animations fill `backwards`, never `both`.** `both` keeps the last keyframe applied
   indefinitely, which can keep the element on its own compositor layer, where Chromium draws text
   with grayscale instead of LCD anti-aliasing, depending on timing. The ribbon goldens then
   differed at every glyph edge between identical runs.
11. **A portal's events reach every React ancestor.** A keydown, mousemove or focus inside a
   `MenuSub` flyout bubbles through the COMPONENT tree to each enclosing Menu, although none of them
   contains it in the DOM. A handler that does not check `list.contains(event.target)` acts on
   another level's events: without the check an ArrowLeft in a gallery two levels down closes the
   level around it (pinned in `menuSub.test.tsx`; the check removed, that test fails), and a hover
   inside a flyout would count as hovering the parent's rows. React also counts a flyout as
   INSIDE its parent for `mouseleave`, so leaving a row for its flyout fires no leave on the
   parent list.
