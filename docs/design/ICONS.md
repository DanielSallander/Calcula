# Icons — one duotone set, one policy

**Status:** shipped 2026-09-23 with the Calcula Clusters redesign (`docs/design/ribbon-design-system.md`).
**Code:** the drawings live in `app/src/api/icons/` (`frame.tsx` + four groups: `home.tsx`,
`chart.tsx`, `data.tsx`, `generic.tsx`); `app/src/api/ribbonIcons.tsx` aggregates them into the one
`RibbonIcon` namespace every ribbon, rail, sidebar, launcher, menu and add-in token resolves against.
**Guard:** `app/src/api/__tests__/ribbonIcons.test.tsx` (1,204 cases over 170 keys).
**Approved drawings:** the mockup artifact https://claude.ai/artifact/W2RwKUxBA79azM4Qznargi (the
Icons board, rev 2).

This file promotes to repo level the policy the Model Editor wrote first, in the header of
`app/extensions/ModelEditor/components/navIcons.tsx`, and restates it for the set the whole app now
shares. Where the two differ in *mechanics* (that rail is a 16-grid stroke set; this one is a
24-grid duotone set), this file wins for anything new; the principles are the same.

---

## 1. Why one set

Before the redesign the ribbon carried three icon styles at once: the Home tab's 16-grid stroke
glyphs, hand-rolled 20x16 SVGs in hardcoded Office blue, orange and grey on the Chart Design tab,
and unicode or emoji glyphs (✎, 🎨, ☰) wherever a drawing was missing. The owner's rev-1 review
called the result **blotchy**, and the cause was physics as much as taste: a 2-unit feature drawn
on a 16-grid and rendered at 16px is 1.3 device pixels, which anti-aliases into a smudge. A glyph
renders in whatever font the machine has, and at 20px a font hint is a smudge too.

The set is hand-drawn, not an npm icon library. The repo idiom has always been hand-drawn SVG, and
a library brings its own grid, weight and metaphor for every spreadsheet concept it does not have.

---

## 2. The rules every drawing is held to

### 2.1 The grid and the frame

Every icon is drawn on **one 24-unit grid** inside `IconFrame` (`app/src/api/icons/frame.tsx`):
`<svg viewBox="0 0 24 24" fill="none">`, `display: block; flex: none`, `focusable="false"`,
`aria-hidden` unless a `title` is given (then `role="img"` with a `<title>`). Icons are decorative
by default because the control that hosts them already carries the name.

### 2.2 Three channels, as tokens — never a colour

| Channel | Constant | Paints with | Is |
|---|---|---|---|
| **SOFT** | `SOFT` | `var(--icon-fill-soft)` | the ground the subject sits on: an axis, a panel, a body |
| **STRONG** | `STRONG` | `currentColor` | the subject itself |
| **ACCENT** | `ACCENT` | `var(--icon-accent)` | exactly ONE thing: the series a chart icon is about, the element a furniture icon names, or the verb |
| DANGER | `DANGER` | `var(--icon-danger)` | the destructive verb (Delete's lid, ClearAll's X), in place of ACCENT |

- **SOFT is a tint of the foreground**, `color-mix(in srgb, currentColor 50%, transparent)` (45% in
  Dark), not a fixed grey. It therefore keeps the same separation on the band, on a tinted cluster,
  on a pressed button and in the Dark skin, instead of washing out on one of them. High contrast
  replaces it with a SOLID mid-grey (#767676 light, #9d9d9d dark), the one ground that must not stay
  translucent there.
- **Why 50 / 45 (2026-09-24; it was 30 / 34).** The owner found the grey too faint: 30% renders
  #afb2b8 on the cluster, 1.9:1, so soft-only drawings (Undo, Find, the Indent rows) looked disabled
  and Format Painter's frame vanished. Two floors hold at once: soft against the cluster at least
  3:1 (WCAG 1.4.11 for a graphic), and STRONG against soft at least 3:1, because about 40 icons lay a
  strong detail on a soft ground. The two ratios MULTIPLY to strong-against-cluster, so every point
  gained on one is taken from the other — a 16.1:1 budget in Light but 10.7:1 in Dark, which is why
  Dark gets the smaller number. Light 50% = #82868f (3.3:1 on the cluster, strong 4.9:1 above it);
  55% turns the tile icons into dark blocks. Dark 45% = #7c7c7e (3.4:1, 3.0:1 under hover, strong
  3.2:1 above it); 50% flattens the small strong details. The one known residual is a pressed
  toggle in Dark (2.6:1).
- **Soft never overlaps soft.** A double layer of the 50% tint is only 2.2:1 from STRONG — a dark
  knot. Draw a soft shape that crosses itself as ONE path (the chart Axes L) or one stroked path
  (Cut's blades: a stroke paints its own crossing once).
- **STRONG is `currentColor`**, so an icon follows the text colour of whatever hosts it — muted at
  rest, full strength when active, inverted in Dark — with no rule per state. This is the Model
  Editor's reasoning, promoted: *an icon that inherits is correct in states nobody thought about,
  and it keeps the whole set outside the hex ban by construction rather than by exemption.*
- **ACCENT is `--icon-accent`**: `color-mix(in oklab, var(--state-accent) 88%, black)` in
  Light (#047857 paints #036448), `var(--state-accent)` in Dark (#34d399). Repointed from
  `--accent-primary` (2.5:1 on the cluster card, the accent collapsed to a thin mark). Light is one
  step darker since 2026-09-24 because the green has to sit between the 50% grey and near-black:
  1.97:1 on the grey (was 1.50), 2.47:1 under STRONG (was 3.23), 6.5:1 on the cluster. It is still
  a reference, so Calcula Soft and a user accent recolour the icons in their own hue. Calcula
  Contrast opts out: its #00543a is already darker. The tab underline, focus ring and checkboxes
  keep `var(--state-accent)`.
- **Exactly one accent per icon**, and never ACCENT and DANGER together. Chart-type icons are
  monochrome duotone (owner decision 2026-09-22): the accent is one series, not a categorical
  palette. A categorical variant would be a one-file swap in `icons/chart.tsx`.
- **The accent borders the background, not the greys (2026-09-24).** No single green reaches 3:1
  from both SOFT and STRONG (the best one lightness can do is 2.2:1 each in Light, 1.8:1 in Dark),
  so separation cannot come from colour. It came up when the owner saw Paste's green clip vanish
  into its board after the grey went to 50%. A new or redrawn icon keeps at least 1.2 units (one
  clean pixel at 20px, on the 1.2 grid) of background between ACCENT/DANGER and every SOFT/STRONG
  shape: move it, shrink it, or cut a notch (Paste) or a HOLE — a reverse-wound subpath, like
  Search's lens and the Lock keyhole — into the ground. No `<mask>`. Parts left beside a cut stay
  at least 2.4 wide. A gap centred on the box cannot be 1.2 AND on whole pixels, so centred gaps
  are 2.4 (Cell Styles). `npm run check:icon-contact` (`app/scripts/icon-accent-contact.mjs`)
  measures this in Chromium from the source against
  `app/scripts/icon-accent-contact.allowlist.json`, where the icons that still break it are pinned
  and may only shrink. Do not cut a gap round a pressed-toggle icon without re-measuring: on the
  Dark pressed tint the grey itself is only 2.66:1.
- **SOFT is translucent, so soft shapes never overlap** (the overlap paints darker) and STRONG /
  ACCENT are laid on top of SOFT, never under it.
- **No colour literal anywhere under `app/src/api/icons/`** — no hex, `rgb()`, `hsl()` or named
  colour. Each channel re-resolves per skin, so one drawing is correct in Light, Dark, Soft, Contrast
  and High contrast; a literal would be correct in exactly one of them.

### 2.3 Shape

- **Filled shapes**, not outlines. Rect corners `rx >= 1.4`, with two exceptions: a 3px pixel-grid
  cell takes rx 0.75-1.0, because at 1.4 it paints as a plus sign (Merge Cells, Waterfall, Keyboard);
  a 2.4-thick bar takes rx 1.2, a full pill.
- **Nothing thinner than 3 grid units, with one exception.** A line or arrow is a stroke of at least
  `MIN_STROKE` (2.6) with round caps and joins — use the `line(channel, width = 3)` helper, which
  clamps. At the 20px control size a 3-unit feature is 2.5 device pixels; that is what cured the
  blotchiness. The exception is `PIXEL_STROKE` (2.4, exactly two pixels), allowed only on a path made
  of horizontal and vertical segments (M/L/H/V/Z) whose centre line is on the 1.2 grid; `line()`
  passes it through and the unit test enforces the rule. A 2.6 line is 2.17 px and can never be crisp.
  A filled bar may likewise be 2.4 thick when its edges are on the grid (the chart Baseline).
- **Straight edges on whole pixels.** At 20px one pixel is 1.2 units (`PIXEL_GRID`). Every
  horizontal and vertical edge (a rect side, or a stroke's centre plus or minus half its width) sits
  on a multiple of 1.2, or it paints a half-covered grey row that reads as soft beside the crisp
  ones. A multiple of 2.4 is also whole pixels at 150% and at the 30px tiles; prefer it when it costs
  nothing at 20px, but 20px wins (the 2026-09-24 sharpening pass). A 3.6 stroke is crisp when its
  centre is on an odd multiple of 0.6. Diagonals, curves and round caps always antialias. 24px and
  28px (rail, launchers, band segments) cannot share this grid: a multiple of 1.2 is a whole pixel
  there only at multiples of 6, so those sizes are not tuned.
- **Lose shapes, don't gain them.** The rev-2 redraw took Chart Title from five shapes to two and
  Gridlines from five to three. Where a concept has an obvious detailed picture and an obvious simple
  one, the simple one wins (navIcons: *a "hierarchy" is three boxes and two lines, not an org chart*).
- **Recognisable by shape before word.** The point of an icon is that after a week the user stops
  reading "Measures" and aims at the sigma. **Two icons that differ only by a detail nobody can
  resolve at 20px are one icon used twice** — redraw one of them (navIcons' Overview vs calculation
  groups is the precedent). ClearContents and ClearAll were such a pair at first — one drawing with
  the X in STRONG vs DANGER — and ClearAll was redrawn on 2026-09-23 as a STACK of cells (a STRONG
  edge of the back layer peeking out above and right) with the DANGER X through the front one, so
  the two now differ by shape and still differ in high contrast or for a colour-blind reader.
- **No `<text>`, no emoji, no unicode glyph** as an icon.

The one deliberate exception is not an icon at all: **typographic commands stay text**. B, I, U, S,
x², x₂ and the Number group's %, `,`, `.0`, `0.` render as their letters in the Home band, because
the letters ARE the command's identity (`TYPOGRAPHIC_ITEM_IDS`,
`app/extensions/BuiltIn/HomeTab/components/homeTabIcons.tsx`). The set still has drawn `Percent`,
`Comma`, `NumberFormat`, `DecimalIncrease`, `DecimalDecrease`, `Superscript` and `Subscript` keys for
every surface that needs a picture (the customize dialog, menus, add-in tokens).

### 2.4 The render ladder: 20 / 24 / 30

Draw once on the 24 grid; the caller picks the size from `@api/layout`:

| Size | Constant | Where |
|---|---|---|
| **20** | `ICON_SIZE_SM` | inside a standard 28px control (Button, IconButton, SegmentedChoice, Dropdown option, Menu row); a PanelDefinition's panel icon |
| **24** | `ICON_SIZE_MD` / `LAUNCHER_ICON_SIZE` | a PanelSection's icon (launcher slot, sidebar header — fitted to 22 there), the activity rail |
| **30** | `ICON_SIZE_LG` / `HERO_ICON_SIZE` | a hero's 34px slot, a tall Tile (Tile and the hero fit whatever size you pass) |

The old ladder was 16 / 20 / 24 / 28. `RibbonIconProps.size` still defaults to 16 for old callers;
new code always passes a ladder size. `CommandButton` outside the band, `Tile`, `Launcher` and the
sidebar header re-fit a direct `<svg>` child to their slot, so one icon element can serve every
surface a control appears on.

---

## 3. Keys are a contract: they only grow

`RibbonIcon` is one namespace object (`{ ...HOME_ICONS, ...CHART_ICONS, ...DATA_ICONS,
...GENERIC_ICONS } as const`), type `RibbonIconKey = keyof typeof RibbonIcon`. Three kinds of caller
depend on the KEYS, not the drawings:

1. **Sandboxed add-ins.** A worker-realm add-in names its ribbon button's icon as a **token string**
   (`icon: "Refresh"`). The trusted host resolves it in `resolveAddInIcon`
   (`app/extensions/ExtensionsManager/AddInsRibbonSection.tsx`) with an own-property check against
   `RibbonIcon`; an unknown or absent token becomes the host's generic add-in glyph. **No markup
   crosses the sandbox** — the token is the only way an add-in picks a picture. A key that
   disappears silently turns every installed add-in that names it into the fallback glyph, with no
   error anywhere.
2. **Persisted Home layouts.** `homeTabIcons.tsx` maps persisted Home item ids onto keys, and
   `GROUP_ICON_IDS` offers keys in the Customize dialog's launcher-icon picker.
3. **Tests** mock the whole namespace with a Proxy (the HomeTab suites).

So: **a key may be redrawn; it may never be renamed or removed.** The 34 historical keys (Cut ...
ClearAll) are frozen by name in `ribbonIcons.test.tsx`, which also fails if two groups define the
same key (the later spread would silently win). An alias shares the COMPONENT rather than copying the
path — `Find` is `Search`, `EditChart` is `Pencil`, `SaveImage` is `Download` — so the two keys can
never drift apart; the test checks identity with `toBe`.

---

## 4. The vocabulary (170 keys, 2026-09-23)

Recount from the source rather than trusting this list (it is what an add-in author reads, and it
must be current). **Home** (`icons/home.tsx`, 38):

- *Frozen 34:* Cut, Copy, Paste, FormatPainter, FontSizeUp, FontSizeDown, FormatCells, FillColor,
  AlignTop, AlignMiddle, AlignBottom, AlignLeft, AlignCenter, AlignRight, WrapText, IndentIncrease,
  IndentDecrease, MergeCells, Percent, Comma, NumberFormat, DecimalIncrease, DecimalDecrease,
  CellStyles, InsertRow, InsertColumn, DeleteRow, DeleteColumn, Undo, Redo, Find, ClearContents,
  ClearFormatting, ClearAll
- *Extras:* Superscript, Subscript, FontColor, Replace

**Chart** (`icons/chart.tsx`, 41):

- *Chart types (18):* ChartColumn, ChartBar, ChartLine, ChartArea, ChartPie, ChartDonut,
  ChartScatter, ChartWaterfall, ChartCombo, ChartRadar, ChartBubble, ChartHistogram, ChartFunnel,
  ChartTreemap, ChartStock, ChartBoxPlot, ChartSunburst, ChartPareto
- *Furniture:* ChartTitle, Gridlines, Legend, AxisLabels, DataLabels
- *Layout and marks:* Grouped, Stacked, Stacked100, SecondaryAxis, Trendline, MarkOptions,
  LineStraight, LineSmooth, LineStep, Markers
- *Style and data:* Palette, Series, Filter, SwitchRowCol
- *Actions:* EditChart, SaveImage, FormatPoint, Code

**Data, BI and page** (`icons/data.tsx`, 41):

- *Objects:* Table, Pivot, Slicer, Timeline, Sparkline, Report, Connection
- *Pivot:* PivotFields, CalcField, FilterPages, Fx, ChangeSource, Subtotals, GrandTotals,
  ReportLayout, BlankRows, Expand, Collapse, ClearFilter
- *Sparkline types:* SparkLine, SparkColumn, SparkWinLoss (note `Sparkline` is the feature,
  `SparkLine` the line type)
- *Table style options:* TableStyle, BandedRows, BandedColumns, HeaderRow, TotalRow, FirstColumn,
  LastColumn, FilterButton
- *Page layout:* Theme, Fonts, Colors, Effects, Margins, Orientation, PageSize, PrintArea, Breaks,
  Background
- *Other:* Lightning

**Generic** (`icons/generic.tsx`, 50):

- *Structure and navigation:* Group (the fallback section/launcher glyph), More, MoreHorizontal,
  Close, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Sidebar, Ribbon, Panel, Layout, Resize
- *Verbs:* Check, Plus, Minus, Refresh, Delete, Pencil, Download, Upload, Save, Sort, Search, Link
- *Transport:* Play, Pause, Stop, StepForward, StepBack, Loop
- *Status:* Info, Warn, Error, Success (SOFT/STRONG only — the host colours them with `color`)
- *Things:* Settings, Text, Pointer, Keyboard, Image, Lock, Eye, Calendar, Clock, Script, Model,
  Controls, Database, Folder, AddIn (the puzzle piece: the host's fallback for an add-in icon token
  that names no key, and the Add-ins tab / Extensions rail glyph)

---

## 5. Adding a key

1. **Look first.** Most requests are an existing key used for a new meaning; a near-duplicate
   drawing is the failure mode in 2.3. If the meaning is new, add a key.
2. **Pick the group file** by family (Home command, chart, data/BI/page, generic) and name the key
   as a PascalCase noun for **what it names**, not what it looks like (`SwitchRowCol`, not
   `TwoArrows`). The name is permanent the moment it ships.
3. **Draw it** as a function component on `IconFrame`, painting only with `SOFT` / `STRONG` /
   `ACCENT` / `DANGER` and `line()`, following section 2. A name that would shadow a browser global
   gets an `Icon` suffix on the FUNCTION (`ErrorIcon`, `ImageIcon`, `TextIcon`, `LockIcon`) while the
   KEY stays bare.
4. **Add it to the group's export object** (additively — never reorder or rename the frozen block).
   If it is an alias, reference the existing component.
5. **Run** `cd app && npx vitest run src/api/__tests__/ribbonIcons.test.tsx`. It checks, per key: a
   24-unit svg whose size follows the prop; no `<text>`; `findHardcodedColours` is `[]`; every
   fill/stroke is one of the four channels, with at least one SOFT or STRONG; not ACCENT and DANGER
   together; no stand-alone stroke under `MIN_STROKE` except `PIXEL_STROKE` on a pixel-aligned
   horizontal/vertical path; and it scans the folder's SOURCE for hex /
   rgb / hsl and `<text>`. The chrome hex ban in `app/eslint.boundaries.js` covers
   `src/api/icons/**` with no exemptions.
6. **Look at it** at 20 and 30, in Light and Dark, beside its neighbours. The test cannot see
   legibility; the owner's review of rev 1 was the first time the blotchiness was visible.
7. **Update section 4 of this file and §8 of `docs/design/third-party-addin-authoring.md`**, which
   lists the same vocabulary for add-in authors.

### An extension that needs its own glyph

Draw it in the same language through the facade — `import { IconFrame, SOFT, STRONG, ACCENT, line }
from "@api/icons"` — rather than inventing a fifth style. `AddInGlyph` in `AddInsRibbonSection.tsx`
is the worked example (a soft body under a strong outline, tokens only). If more than one extension
would use it, it is a key: propose it for the shared set instead.

### Replacing a drawing with the owner's own SVG

The owner designs replacements in an SVG editor and drops them in `icons/` at the repo root (one
file per button, icon only, no text). FormatPainter, MergeCells and ClearFormatting were converted
this way on 2026-09-24; their doc comments list every departure from the owner's file and why. The
conversion rules, learned on those three:

- **Scale 64 -> 24 is x0.375, then fit the set's 1.5-2.5 margins.** Owner drawings tend to fill the
  whole box.
- **Colours map to channels by role, never literally:** the owner's dark greys -> STRONG, light
  grey -> SOFT, green -> ACCENT. The owner's own colour choice wins over the set's habits (Clear
  Formatting's green eraser tip is ACCENT, not DANGER).
- **Every line under 2.6 units must change:** an owner's 1.7-2.5 stroke at 64 is 0.6-0.9 units.
  Thicken it to 2.6 and move it clear of its neighbours (Format Painter's wire), or redraw it as a
  filled shape (Merge Cells' arrows became wedges, Clear Formatting's % rings became dots).
- **Gaps of at least 1.2 units, edges on multiples of 1.2** (whole pixels at 20px). A 0.75-unit gap
  smears into a grey line, and the Dark skin's STRONG vs ACCENT is only 1.46:1, so the gap is often
  the only thing separating two channels.
- **Render before and after.** `icons/tools/render.mjs` (sheet at 20/24/30/120px, Light and Dark,
  beside the owner's file) and `icons/tools/pixels.mjs` (the real 20px pixels magnified) run from
  `app/` with Node and the installed Playwright Chromium; the owner judges from the sheets.

---

## 6. What this policy does not cover (yet)

- **The menu bar.** `app/src/api/menuIcons.tsx` (a 16-grid stroke set of ~200 `Icon*` exports) is
  untouched: the owner scoped the redesign to the ribbon and sidebars and explicitly left the menu
  bar alone. `RibbonIcon` stays one namespace object, never named exports, precisely so its keys can
  never collide with those names.
- **The Model Editor rail** (`navIcons.tsx`, `treeKit.tsx`) is a 16-grid stroke-only set that
  predates this policy and lives in its own window. Its principles are the ones promoted above; its
  mechanics are not the shared standard.
- **Extension-private icons** still exist in about fifteen files outside the redesigned chrome
  (Animation's film icon, the Command Palette, the script editors, the Search view…). They are not
  under the hex ban unless their file is. Migrating them is follow-up work, not a precedent: new code
  uses `RibbonIcon` or `@api/icons`.
