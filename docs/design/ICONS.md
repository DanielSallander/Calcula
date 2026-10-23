# Icons — one duotone set, one policy

**Status:** shipped 2026-09-23 with the Calcula Clusters redesign (`docs/design/ribbon-design-system.md`).
**Code:** the drawings live in `app/src/api/icons/` (`frame.tsx` + four groups: `home.tsx`,
`chart.tsx`, `data.tsx`, `generic.tsx`, and `marks.tsx`, the Visuals family's construction kit);
`app/src/api/ribbonIcons.tsx` aggregates them into the one `RibbonIcon` namespace every ribbon, rail,
sidebar, launcher, menu and add-in token resolves against.
**Guard:** `app/src/api/__tests__/ribbonIcons.test.tsx` (2,817 cases over 274 keys, 2026-10-22).
**Approved drawings:** the mockup artifact https://claude.ai/artifact/W2RwKUxBA79azM4Qznargi (the
Icons board, rev 2); for the Visuals family (section 2.5), direction B "Geometric" of the
three-way proposal https://claude.ai/artifact/XPeUP8i3JJ941EET2P5SPi, chosen by the owner on
2026-10-22 (Grouped and the Table and Slicer refinements came later; section 2.5 says which).

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
- **Disabled is the one state with a rule (2026-10-02)**, and the HOST owns it, not the drawing: the
  disabled idiom (`DISABLED_LOOK`, `app/src/api/layout/primitives/disabled.ts`) draws every icon
  inside a disabled control with `grayscale(1)` and fades the control to .4, because opacity alone
  left ACCENT green and a disabled Redo read as the same state as the enabled Undo beside it. A
  drawing needs nothing for this. The cost is accepted: with the colour gone, an ACCENT shape laid on
  a SOFT ground separates from it by lightness alone, so a disabled Gridlines or ClearAll loses its
  inner detail (most in High contrast over Dark, about 1.1:1), much as Excel's flat-grey disabled
  icons do.
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
  at least 2.4 wide, with one recorded exception: the arrow HOLE in MergeCenter and MergeAcross
  leaves 1.2 of green above and below each head, which is the merged cell's outline (Excel draws
  that row as a 1px outline round its arrow); heads short enough to leave 2.4 painted as a bar
  with fat ends at 100% (both rendered 2026-10-02; the reasoning is in their doc comments). A gap
  centred on the box cannot be 1.2 AND on whole pixels, so centred gaps
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

- **Filled shapes**, not outlines. Rect corners `rx >= 1.4` (the Visuals family has its own corner
  rule instead: square or a full curve, section 2.5), with these exceptions: a 3px pixel-grid
  cell takes rx 0.75-1.0, because at 1.4 it paints as a plus sign (Merge & Center and Merge
  Across's cell rows, Unmerge Cells' cut row, Keyboard, the Cells heroes' grid rows);
  a 2.4-thick bar takes rx 1.2, a full pill; and a whole-pixel SQUARE MARK of 2 or 3 px takes rx 0
  (the Borders family's 2px dots and All Borders' 3px cells: any radius painted them as a plus sign at
  150%, and rx 0.6 left stray antialiased pixels at 100%). Every 2px square mark in the set is rx 0
  since the 2026-10-04 icon review, which rendered the Paste family's % and No Borders dots side by
  side with Borders' at 150% (rx 0.6: plus signs; rx 0: squares; identical at 100%); the per-key
  test "draws its 2 px square marks square" holds it.
- **Outlines that are the subject (one recorded exception).** Fill Color's bucket (2026-10-04) is
  three STROKED walls of a square tipped 45 degrees, its mouth left open: the open side is what
  makes it a bucket and not a diamond, and a filled body cannot have an open side. A version with a
  SOFT-filled body was rendered beside it and read no better (11 half-covered pixels either way;
  weight 81 against Font Color's 101). Its handle is filled, as the rule asks.
- **Dots under the part floor (2026-10-04).** frame.tsx asks for parts of at least 3.6 units and a
  free-standing dot of at least 4.3. These draw 2.4-unit (2px) dots on purpose: the Borders
  lattice, where the dots are not parts but the TEXTURE of a dotted line (the dotted-vs-solid
  contrast is what lets No Border, All Borders and Outside Borders differ by shape; a faint solid soft
  grid made them a colour-only difference); the Paste family's corner % and No Borders frame, the
  only way a % fits the 7px corner; and, since 2026-10-08, the Canvas grid lattices (SnapToGrid,
  ShowGrid: the dots ARE Power BI's canvas grid, the same texture argument as Borders) and
  ActualSize's colon (the ":" of "1:1"). Whole pixels at 20px, so they paint crisp.
- **Only rigid transforms, and no PIXEL_STROKE inside one (2026-10-04).** The stroke rules read the
  `stroke-width` and `d` attributes as written, so a drawing may translate, rotate or mirror a group
  (the Fill menu, Link, the Excel letters of Wrap Text and Orientation) but never scale or skew it, and
  a 2.4 line is always drawn in the frame's own coordinates (inside a rotation a path written on the
  grid paints off it). Scaled drawings are written out at their final size (Paste Link's chain is Link
  at 0.75, as coordinates). Both are test-enforced. A written-out copy is a second source of truth,
  so where one key draws another's part the test pins the relation, not the coordinates (2026-10-08):
  Button's cursor must be Pointer at 0.66 about its tip, so a redraw of Pointer fails until the copy
  follows. The same holds for Lock Objects' padlock body (Protect Sheet's outline) and Line and
  stacked column's two columns (Stacked's), both pinned by the 2026-10-08 icon review, and since
  2026-10-22 for Grouped's two columns (on Stacked's two slots). Until 2026-10-22 the Card's "123" was
  Paste Values' digits moved by whole pixels; the Visuals family draws its own digits, and the pin
  went with the copy.
  The 27 Canvas keys of 2026-10-08 use no transform at all (test-enforced). **Letters turn only by a quarter.** A 6px letter
  turned 45 degrees keeps two clean pixels of its hole: the first Orientation pictures painted "ab"
  as two rings, a "%" (at 100% and 150%). The 45-degree pictures stand the letters upright and STEP
  the word along the angle (a recorded departure from Excel's turned letters; test-enforced).
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
  Since 2026-10-04 the rule is test-enforced for the menus, pills and galleries listed in
  `MENU_FAMILIES` (`ribbonIcons.test.tsx`: Borders, Underline, Paste, Alignment, Orientation,
  object alignment, Cells, Styles, Number, Fill, Clear, Sort & Filter, Find & Select, Editing and the
  colour splits; since 2026-10-08 also the Canvas tab's Visuals gallery -- all 33 tiles and the All
  Visuals hero -- and its grids, Pages, Elements, Buttons, Arrange, Page, Page view and View; since
  2026-10-17 also Edit interactions): within a family no key may alias another and no two may
  render the same markup. The Merge menu's four rows have a test of their own; any other row of
  pictures is not checked (Chart Design's Line shape pill and the Sparkline tab's Type pill are in
  no family). A Canvas family also
  lists the pictures its rows REPLACED (Layout, Controls, Table, Resize, Search, chart Gridlines,
  Pencil), so a new key can never become an alias or a copy of the picture it replaced. Which key a
  control USES is the tab's own business and its own tests'; this test cannot see it.
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

### 2.5 The Visuals family: "Geometric" (2026-10-22)

The owner found the Canvas tab's Visuals icons "blotchy" and asked for something more professional,
sharp yet smooth, in the minimal theme and colours, after a reference sheet of geometric glyphs. Three
directions were drawn for all 33 visuals and the hero (Crisp, Geometric, Line; the proposal canvas is
linked at the top), and the owner chose **Geometric**. It covers the 18 chart types, Power BI's Canvas
visuals (stacked bars and areas, line and stacked column, Card, Multi-row card, KPI, Gauge), Matrix,
Table, Slicer, Timeline, the All Visuals hero, and Chart Design's Grouped | Stacked | 100% toggle
(Stacked and Stacked100 are gallery tiles, so Grouped follows them). The rest of the set keeps the
duotone rules above; the channels, the one accent and every per-key rule of section 5 still hold.

**What was blotchy, measured at 20px:** the dark-green ACCENT is nearly as dark as the near-black
ink in Light (2.5:1), so a green part one pixel from a black part painted as one lump (the Slicer's
selected row, every stacked bar, the Matrix); the Slicer was a 50% grey slab holding dark pills;
3-5 px parts with rx 1.6 painted as lumps; some pictures had up to nine parts. The project's contact
check found green touching grey in eleven of these icons (Radar 31.2, Slicer 26.8, Pie 20.9 units of
outline); after the redraw it finds none.

The rules (`app/src/api/icons/marks.tsx` is the kit: its sizes everywhere, and its helpers for the
columns, bars, pills, D-marks, the plot's L and the cards' rule; chart.tsx's stacked helpers and
data.tsx's table rows build on its D-mark; the pie, donut, sunburst, radar, treemap, histogram,
Matrix, Line and stacked column and the hero call no helper and are written out on the same sizes):

- **One gap, 2.4** (two whole pixels at 20px): every cut between parts, every space between marks,
  and the ACCENT's clearance from every SOFT or STRONG shape -- stricter than section 2.2's 1.2. The
  30px hero draws the same gap in its own device pixels, 1.6. `npm run check:icon-contact` measures
  the family at its gap (`VISUALS_FAMILY_GAPS` in the script, pinned to this family by the icon test)
  and never allowlists a family key: contact above the script's 1.0-unit edge-pixel tolerance fails
  the check. Two recorded exceptions sit closer between parts of one ink: the Card's digits (the 1
  and the 2 1.2 apart, the 2 and the 3 1.6 at their closest) and one box-plot whisker per plot (1.2
  long).
- **The corner rule.** Square (rx 0) where a part MEETS something: its root (columns stand on
  y 21.6, bars grow from x 2.4), the cut to a neighbour, a cell of the lattice. A FULL curve where a
  part ENDS freely: a value end is a semicircle of radius half the part's thickness (the D-mark), a
  part free at both ends is a pill, a point is a circle, the free outer corner of a bent part is a
  true quarter circle. Never an in-between radius; triangles and polygons stay sharp. Test-enforced
  for the family's rects AND for every arc of a filled path ("keeps its corner rule": an arc smaller
  than a mark must be a semicircle, a disc's large arc or a wedge on one of the path's own points).
- **Sizes:** a mark is 4.8 (three marks and two gaps fill the 19.2 field: x 2.4 / 9.6 / 16.8), a
  stacked pair 7.2 (the pair centred, its marks at 3.6 / 13.2), a rule 2.4, a series line 3.6 with
  round caps and joins: no turn sharper than a right angle (every interior angle 90 degrees or more)
  and no segment under 5.6, so the inside of every turn stays open.
- **No axis under bars and columns**: their aligned square roots are the axis. The one exception is
  the Histogram, whose adjacent bins make one block: it stands on a SOFT baseline. The x/y pictures
  stand in one SOFT L (`PlotAxes`, square ends, a crisp corner); the cards stand on one SOFT rule on
  the field's bottom edge (`CardRule`).
- **Round pictures are cut with straight cuts of the gap**: rings are cut in place (Donut, Gauge),
  pies are exploded (the ACCENT quarter moved out by the gap on both axes), and the Sunburst is the
  exploded ring. The pie's, donut's and sunburst's cuts sit at 12, 3, 6 and 9 o'clock, so their cut
  edges are horizontal or vertical; the Gauge's feet are cut flat at y 16.8 and its ring is cut along
  two lines parallel to the sides of its 1 o'clock needle, the gap from each, so those two edges are
  diagonal.
- **Stacked pictures** are two pair marks, each a crisp STRONG root, the cut, and an ACCENT end. In
  Stacked and the stacked bar the two ends are the same length (6.0, one series) on different totals;
  the 100% twins run every ACCENT end to the field's edge (12 and 6 long), the same total split
  differently. Stacked pictures show two categories and the clustered tiles (ChartColumn, ChartBar,
  ChartCombo) three whole marks; Grouped, the toggle's clustered choice, is two whole columns on the
  pair slots. In Stacked and the stacked bar the pair's ends differ by 4 px, and in the 100% twins
  they end together (test-enforced on the true ends, the caps' apexes: at least 4.8 units apart, and
  0 for the twins; the duotone pictures held 6.0).
- **Crispness:** every straight edge of a filled shape is on the 1.2 grid, whole pixels at 20px
  (test-enforced: "every straight edge of a filled shape on whole pixels"). Of the 34 drawn on that
  grid (the family without the hero), 19 keep every such edge on the 2.4 grid too and stay crisp at
  150% and at 30px: the clustered bar and column, Combo, Waterfall, Pareto and Funnel (marks on the
  three-mark lattice 2.4 / 9.6 / 16.8: in x for the column, Combo, Waterfall and Pareto, in y for the
  bar and the Funnel), the line, the three areas, scatter, bubble and radar, Card, Gauge, Matrix,
  Slicer, Timeline and Histogram. The other 15 have some edges on odd multiples of 1.2, half pixels
  at 150% and at 30px: everything on the pair slots 3.6 / 13.2 (Stacked, Stacked100, the two
  stacked bars, Line and stacked column, Grouped, Box plot), the centred cuts at 10.8 | 13.2 (Pie,
  Donut, Sunburst), and Table, Treemap, Multi-row card, KPI and Stock. Chart Design's 30px Pie quick
  tile is the one quick tile the redraw made softer. The Card's 2 and 3 are 2.6 strokes that
  antialias like any curve, and the hero sits on its own 0.8 grid.

Decisions recorded with the drawings: the stacked BAR puts its long bar on top (with the short one on
top it drew a stencil "B"); the Matrix's header is a row of three SOFT cells and its totals one ACCENT
L whose arms are 12 and 19.2 (a full-height arm drew a "J"); the Donut has three segments (one cut-off
quarter left a "C"); the Card's 1 has a slanted top (a plain bar read as "I23"); the KPI is a square
turned 45 degrees, widened to 19.2 x 14.4 and cut once across its middle (y 8.4 | 10.8), green up
over dark down, on the cards' rule (a lens of two arcs read as an acorn); the Slicer's markers stay
round dots, apart from the square ticks of PivotFields (the
PivotTable Fields pane's icon). Three drawings are not the proposal's exactly: Grouped was drawn when
the family was adopted (two whole columns on Stacked's two slots; the proposal had none), and the
implementation review refined two for cues that survive grayscale and High contrast -- Table's header
row is thinner than its rows (3.6 against 4.8), and the Slicer's unselected items are SOFT, dot and
label, under one STRONG selected label. Adopting the family removed one per-key pin (Card's digits
as Paste Values' digits moved: the pin went with the copy), re-pinned four ("Card and KPI" reads the
Card's three digits by their real ink over the new rule, the Matrix pin reads three SOFT header
cells with square corners, the stacked pin reads the true ends at the 4 px difference, and the All
Visuals 30px pin reads every path point) and added four (the corner rule, straight edges on whole
pixels, Grouped on Stacked's slots, and the contact check's family list).

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

## 4. The vocabulary (274 keys, 2026-10-17)

Recount from the source rather than trusting this list (it is what an add-in author reads, and it
must be current). **Home** (`icons/home.tsx`, 104):

- *Frozen 34:* Cut, Copy, Paste, FormatPainter, FontSizeUp, FontSizeDown, FormatCells, FillColor,
  AlignTop, AlignMiddle, AlignBottom, AlignLeft, AlignCenter, AlignRight, WrapText, IndentIncrease,
  IndentDecrease, MergeCells, Percent, Comma, NumberFormat, DecimalIncrease, DecimalDecrease,
  CellStyles, InsertRow, InsertColumn, DeleteRow, DeleteColumn, Undo, Redo, Find, ClearContents,
  ClearFormatting, ClearAll
- *Extras:* Superscript, Subscript, FontColor, Replace
- *Merge menu (2026-10-02):* MergeCenter (the face of the Home tab's Merge & Center split
  button), MergeAcross, UnmergeCells. With the frozen MergeCells (redrawn the same day as Excel's
  plain Merge Cells) these are Excel's four Merge commands, drawn in Excel's metaphor: a grid two
  cells wide and three rows tall whose middle row is the merged cell, as an ACCENT bar with any
  arrow cut out of it pointing OUTWARD. A tall row with a double arrow (Merge & Center) or a
  right arrow (Merge Across), a thin row (Merge Cells), the thin row cut into four cells (Unmerge
  Cells): the four differ by shape, so they also differ in high contrast.
- *Excel's Home tab (2026-10-04), 63 keys.* Drawn in the metaphor of Excel 365's own pictures
  (captured from a live Excel), with Excel's grey lines STRONG or SOFT, its one blue element ACCENT
  and its red DANGER; every one measures 0 accent contact. Two reviews checked them the same day
  (Excel fidelity, and legibility at 20px); where they disagreed the 20px pixel map decided, and
  `icons/home-excel-icon-review-before-after.png` shows each change and each alternative not
  taken. Nine FROZEN keys were redrawn in place
  the same day: AlignTop / AlignMiddle / AlignBottom (now Excel's three-line TEXT block pushed up,
  centred or down, one colour), WrapText ("ab" over "c" with a return arrow), FillColor (a tipped
  bucket with a loop handle and a soft pour, no accent: the host's bar is the colour), and
  InsertRow / InsertColumn / DeleteRow / DeleteColumn (Excel's arriving or pointed row between its
  neighbours, with an arrow or an X).
  - *Paste options* (the Paste split's menu): PasteFormulas, PasteFormulasNumberFormats,
    PasteKeepSourceFormatting, PasteNoBorders, PasteColumnWidths, PasteTranspose, PasteValues,
    PasteValuesNumberFormats, PasteValuesSourceFormatting, PasteFormatting, PasteLink, PasteSpecial.
    Paste's board cut back to an L with a STRONG clip; the ACCENT badge in front of it says what the
    option pastes (fx, 123, a brush, dots, a width bar, a transpose arrow, a chain, an ellipsis), and
    a % or a small brush in the free corner qualifies it.
  - *Font:* Underline, DoubleUnderline (the Underline split's rows; the face stays the letter U), the
    Borders split's 13 presets BorderBottom (the default face), BorderTop, BorderLeft, BorderRight,
    BorderNone, BorderAll (also More Borders...), BorderOutside, BorderThickOutside,
    BorderDoubleBottom, BorderThickBottom, BorderTopBottom, BorderTopThickBottom,
    BorderTopDoubleBottom -- Excel's dotted 2 x 2 figure with the drawn edges solid ACCENT -- and
    LineColor.
  - *Alignment:* TextOrientation (the Orientation button's face and the Format Cell Alignment row),
    AngleCounterclockwise, AngleClockwise (the 45-degree pictures: the word "ab" upright, stepping up
    or down the angle, beside the arrow), VerticalText, RotateTextUp, RotateTextDown; and
    ObjectAlignTop, ObjectAlignMiddle, ObjectAlignBottom, the pre-2026-10-04 AlignTop/Middle/Bottom
    drawings (an accent edge with a soft object against it), with ObjectAlignLeft, ObjectAlignCenter,
    ObjectAlignRight (the same three mirrored across the diagonal, added by the review): the Canvas
    Arrange menu, which aligns OBJECTS, uses all six. The letters are three shared paths placed by
    translate and quarter turns only.
  - *Number and Styles:* Accounting (a banknote with a cut stack of ACCENT coins),
    ConditionalFormatting (a table with two ACCENT runs: Excel's red is ACCENT here, because DANGER
    means a destructive verb), FormatAsTable (a styled block cut round a STRONG brush).
  - *Cells:* InsertCells, DeleteCells, FormatMenu (the three heroes' faces; FormatMenu is the Format
    MENU, not the frozen FormatCells dialog picture), InsertSheet, DeleteSheet, RenameSheet,
    ProtectSheet (one sheet corner with a curled cell, the verb in the free square), RowHeight,
    ColumnWidth (a double arrow measuring a soft bracket).
  - *Editing:* AutoSum (a STRONG sigma), FillDown, FillRight, FillUp, FillLeft (one picture turned:
    the STRONG bar is the side copied from), Clear (Clear Formatting's eraser alone, larger; the
    Clear menu's face AND its Clear All row, as in Excel -- the frozen ClearAll stack is not that
    row's picture), RemoveHyperlinks (Excel's picture: a whole STRONG chain with a DANGER X in the
    corner, Clear Filter's idiom), SortFilter, SortAscending,
    SortDescending (an ACCENT A and a STRONG Z), GoTo (an ACCENT arrow at a SOFT cell).

**Chart** (`icons/chart.tsx`, 51):

- *Chart types (18), the Visuals family (section 2.5):* ChartColumn, ChartBar (three D-marks, the
  tallest ACCENT, no axis), ChartLine, ChartArea, ChartScatter, ChartBubble (in the SOFT plot L),
  ChartPie (the exploded quarter), ChartDonut (a ring cut into three), ChartWaterfall (a floating
  ACCENT pill between two D-columns), ChartCombo (three short D-columns under an ACCENT wave),
  ChartRadar (a SOFT hexagon web, an ACCENT series), ChartHistogram (one stepped ACCENT block with
  quarter-circle shoulders), ChartFunnel (three centred pills), ChartTreemap (one block cut into four
  tiles), ChartStock (bodies on wick pills), ChartBoxPlot (boxes cut at the median, pill caps),
  ChartSunburst (the exploded ring round a centre dot), ChartPareto (three D-columns, an ACCENT arc)
- *Furniture:* ChartTitle, Gridlines, Legend, AxisLabels, DataLabels
- *Layout and marks:* Grouped, Stacked, Stacked100, SecondaryAxis, Trendline, MarkOptions,
  LineStraight, LineSmooth, LineStep, Markers. Grouped, Stacked and Stacked100 are Chart Design's
  layout toggle and are drawn in the Visuals family (2026-10-22) on the same two slots (x 3.6 and
  13.2, 7.2 wide): two whole columns (Grouped: a STRONG and an ACCENT one side by side), two split
  pairs (Stacked: totals 4 px apart) and two split pairs to the full height (Stacked100). The rest
  are furniture.
- *Style and data:* Palette, Series, Filter, SwitchRowCol
- *Actions:* EditChart, SaveImage, FormatPoint, Code
- *Power BI's Visualizations pane (the Canvas tab's Visuals gallery):* first drawn on 2026-10-08 in
  Power BI's compositions, redrawn on 2026-10-22 in the Visuals family (section 2.5), with Power
  BI's blue as ACCENT, its grey as SOFT and its white marks STRONG and filled; every one measures 0
  accent contact. ChartBarStacked, ChartBarStacked100 (two pair bars, each a STRONG root, the cut
  and an ACCENT D end; the long bar on top; the 100% pair both reach the edge), ChartAreaStacked,
  ChartAreaStacked100 (a STRONG area with an ACCENT band riding on it, a constant cut between; the
  100% band fills down from a flat top), ChartComboStacked (Stacked's two columns cut short with SOFT
  semicircle ends, the ACCENT wave above -- Power BI's line crosses the columns, ours cannot keep its
  gap if it does), ChartCard (geometric ACCENT digits over the cards' SOFT rule, no frame),
  ChartMultiRowCard (two records, each a value pill over a SOFT rule, the first ACCENT), ChartKpi (a
  square turned 45 degrees, widened to 19.2 x 14.4 and cut once: an ACCENT up triangle over a STRONG
  down one, on the cards' rule -- Power BI's red triangle is STRONG, since ACCENT and DANGER never
  meet), ChartGauge (a half
  ring on the cards' rule, ACCENT from the minimum, SOFT beyond, a STRONG hub-and-tip needle in its
  own cuts), AllVisuals (the gallery hero in device pixels at 30px: D-columns, the exploded pie,
  D-bars and a SOFT ring in a 2 x 2). The stacked pictures show two categories and the clustered
  ones (ChartColumn, ChartBar, ChartCombo) three, which is what tells them apart at 20px.
  **AllVisuals is drawn for 30px only** (every point of its marks is on the 0.8 grid, whole pixels
  at 30; test-enforced): use it for the All Visuals hero, never as a 20px button or a 24px gallery
  tile.

**Data, BI and page** (`icons/data.tsx`, 50):

- *Objects:* Table, Pivot, Slicer, Timeline, Sparkline, Report, Connection. Table, Slicer and
  Timeline are Visuals gallery tiles and are drawn in the Visuals family (2026-10-22): Table is three
  rows, each a pill cut into three cells, the ACCENT header row (3.6, thinner, so it is told apart
  without its colour) over two STRONG rows (4.8); Slicer is three round radio dots with pill labels,
  no panel: the selected item an ACCENT dot beside a STRONG label, the other two SOFT, dot and label;
  Timeline is a label pill over one track pill cut once, the ACCENT selected span from the start
- *Pivot:* PivotFields, CalcField, FilterPages, Fx, ChangeSource, Subtotals, GrandTotals,
  ReportLayout, BlankRows, Expand, Collapse, ClearFilter
- *Sparkline types:* SparkLine, SparkColumn, SparkWinLoss (note `Sparkline` is the feature,
  `SparkLine` the line type)
- *Table style options:* TableStyle, BandedRows, BandedColumns, HeaderRow, TotalRow, FirstColumn,
  LastColumn, FilterButton
- *Page layout:* Theme, Fonts, Colors, Effects, Margins, Orientation, PageSize, PrintArea, Breaks,
  Background
- *Other:* Lightning
- *The Canvas tab (2026-10-08):* Matrix (Power BI's matrix with its totals MERGED -- since
  2026-10-22 on the Visuals family's lattice: a row of three SOFT header cells over STRONG cells and
  one ACCENT L of the total column and the total row, its free corner a quarter circle -- because
  Power BI's exact nine-cell picture is GrandTotals; Power BI's grey-over-white also parts it from
  FloatingGrid), FloatingGrid (one STRONG title bar over two rows of cells on the table figure's
  columns, the active cell ACCENT; it was drawn with the 2026-10-08 Table), NewPage (Report's page
  with More's ACCENT plus in a notch), PageNavigator (three page tabs, the current one ACCENT, ABOVE
  a SOFT page; the first drawing had them under it and was Legend), ClearSlicers (a SOFT card -- the
  panel the Slicer drew until 2026-10-22 -- with a STRONG funnel and Clear Filter's DANGER X in a
  bite out of its corner; no ACCENT; a command, not a gallery tile, so it keeps the duotone
  language), the Page View rows FitToPage (ACCENT corner brackets hugging a SOFT page), FitToWidth
  (an ACCENT double arrow in a SOFT window) and
  ActualSize (STRONG "1:1" with an ACCENT colon through a SOFT page), and Wallpaper (an ACCENT
  surround round a STRONG page: the colour outside the page, where Background has it inside)

**Generic** (`icons/generic.tsx`, 69):

- *Structure and navigation:* Group (the fallback section/launcher glyph), More, MoreHorizontal,
  Close, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Sidebar, Ribbon, Panel, Layout, Resize
- *Verbs:* Check, Plus, Minus, Refresh, Delete, Pencil, Download, Upload, Save, Sort, Search, Link
- *Transport:* Play, Pause, Stop, StepForward, StepBack, Loop
- *Status:* Info, Warn, Error, Success (SOFT/STRONG only — the host colours them with `color`)
- *Things:* Settings, Text, Pointer, Keyboard, Image, Lock, Eye, Calendar, Clock, Script, Model,
  Controls, Database, Folder, AddIn (the puzzle piece: the host's fallback for an add-in icon token
  that names no key, and the Add-ins tab / Extensions rail glyph)
- *Arrange (2026-09-25, the Canvas tab):* BringForward, SendBackward, BringToFront, SendToBack
  (two or three overlapping squares, the ACCENT one being the object moved; a covered square is CUT
  with a 1.2 gap, so front and back read by shape), AlignObjects (an accent edge with two objects
  against it -- the Align menu's face; since 2026-10-04 its six rows are Home's ObjectAlignLeft /
  Center / Right / Top / Middle / Bottom, never the TEXT alignment pictures), DistributeHorizontal,
  DistributeVertical (the accent object
  between two others with equal 2.4 gaps)
- *The Canvas tab (2026-10-08):* Shapes (a STRONG triangle, SOFT square and ACCENT circle kept
  apart: Elements' Shapes menu, which Layout drew until then), ButtonControl (an ACCENT button
  notched round Pointer's cursor at two-thirds size: the Buttons menu, which Controls drew),
  NavigateBack (an ACCENT left arrow cut into a SOFT disc: the Back button), SizePosition (a SOFT
  object measured by an ACCENT width arrow and a STRONG height arrow: Arrange's Size & Position,
  which Resize drew), SnapToGrid (a SOFT dot lattice with an ACCENT object snapped across two
  cells; chart Gridlines drew it), ShowGrid (ACCENT grid dots in a SOFT page frame), LockObjects
  (Shapes' SOFT square and circle and an all-ACCENT padlock: View's Lock Objects, which must not be
  Arrange's Lock; the review of 2026-10-08 replaced two grey blocks that made it Home's
  ProtectSheet), DesignMode (an ACCENT pencil on a SOFT set square, Excel's metaphor; Pencil drew it)
- *Edit interactions (2026-10-17, canvas round 2 P4):* Power BI's Format > Edit interactions and the
  three buttons it puts on every other visual of the page. EditInteractions (the Arrange hero beside
  Lock: a STRONG source visual top-left, a SOFT target visual bottom-right and an ACCENT elbow arrow
  from one to the other), InteractionFilter (a SOFT funnel head with the two ACCENT columns that pass
  through below it -- the subject is what is LEFT, where Filter is a whole funnel), InteractionHighlight
  (three columns, each a SOFT upper part over an ACCENT lower part: exactly how a highlighted bar is
  painted, the faded whole then the highlighted portion), InteractionNone (Power BI's circle with a
  slash in one STRONG channel; no ACCENT, because nothing is selected through). Drawn in
  `app/src/api/icons/generic.tsx`; used by `CanvasSheet/components/CanvasArrangeSection.tsx` (the hero)
  and `CanvasSheet/components/InteractionIcons.tsx` (the per-visual strips)

---

## 5. Adding a key

1. **Look first.** Most requests are an existing key used for a new meaning; a near-duplicate
   drawing is the failure mode in 2.3. If the meaning is new, add a key.
2. **Pick the group file** by family (Home command, chart, data/BI/page, generic) and name the key
   as a PascalCase noun for **what it names**, not what it looks like (`SwitchRowCol`, not
   `TwoArrows`). The name is permanent the moment it ships.
3. **Draw it** as a function component on `IconFrame`, painting only with `SOFT` / `STRONG` /
   `ACCENT` / `DANGER` and `line()`, following section 2. A new chart type or report visual joins the
   Visuals family: build it with `marks.tsx` (`dMark`, `column`, `bar`, `pill`, `PlotAxes`,
   `CardRule`, the 2.4 gap) by section 2.5's corner rule, add it to the "Visuals gallery" family in
   `MENU_FAMILIES` if the gallery shows it, or beside "Grouped" in the test's `VISUALS_FAMILY` if it
   does not, and add its key to `VISUALS_FAMILY_GAPS` in `app/scripts/icon-accent-contact.mjs` (the
   icon test fails until `VISUALS_FAMILY_GAPS` lists exactly the test's `VISUALS_FAMILY`, the gallery
   family plus Grouped; the family's corner-rule test runs over that same list and its whole-pixel
   test over the same list less the 30px hero, which has its own 0.8-grid test; the contact check
   then holds it to THE gap with no allowlist). A name that would shadow a
   browser global gets an `Icon` suffix on the FUNCTION (`ErrorIcon`, `ImageIcon`, `TextIcon`,
   `LockIcon`) while the KEY stays bare.
4. **Add it to the group's export object** (additively — never reorder or rename the frozen block).
   If it is an alias, reference the existing component.
5. **Run** `cd app && npx vitest run src/api/__tests__/ribbonIcons.test.tsx`. It checks, per key: a
   24-unit svg whose size follows the prop; no `<text>`; `findHardcodedColours` is `[]`; every
   fill/stroke is one of the four channels, with at least one SOFT or STRONG; not ACCENT and DANGER
   together; no stand-alone stroke under `MIN_STROKE` except `PIXEL_STROKE` on a pixel-aligned
   horizontal/vertical path; only rigid transforms (translate, rotate, a mirror matrix), and no
   `PIXEL_STROKE` line inside any transform; and it scans the folder's SOURCE for hex /
   rgb / hsl and `<text>`. If the new key sits in a menu beside other pictures, add it to that
   family in `MENU_FAMILIES` (no alias, no identical markup within a family). The chrome hex ban in
   `app/eslint.boundaries.js` covers `src/api/icons/**` with no exemptions.
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
this way on 2026-09-24; their doc comments list every departure from the owner's file and why.
The MergeCells conversion (inward wedges at a merged cell over a row of cells) was superseded on
2026-10-02, when the owner asked for Merge "as in Excel": its inward arrows were Google Sheets'
metaphor, and the key now draws Excel's plain Merge Cells (§4). The conversion rules, learned on
those three:

- **Scale 64 -> 24 is x0.375, then fit the set's 1.5-2.5 margins.** Owner drawings tend to fill the
  whole box.
- **Colours map to channels by role, never literally:** the owner's dark greys -> STRONG, light
  grey -> SOFT, green -> ACCENT. The owner's own colour choice wins over the set's habits (Clear
  Formatting's green eraser tip is ACCENT, not DANGER).
- **Every line under 2.6 units must change:** an owner's 1.7-2.5 stroke at 64 is 0.6-0.9 units.
  Thicken it to 2.6 and move it clear of its neighbours (Format Painter's wire), or redraw it as a
  filled shape (the retired Merge Cells conversion's arrows became wedges, Clear Formatting's %
  rings became dots).
- **Gaps of at least 1.2 units, edges on multiples of 1.2** (whole pixels at 20px). A 0.75-unit gap
  smears into a grey line, and the Dark skin's STRONG vs ACCENT is only 1.46:1, so the gap is often
  the only thing separating two channels.
- **Render before and after.** `icons/tools/render.mjs` (sheet at 20/24/30/120px, Light and Dark,
  beside the owner's file) and `icons/tools/pixels.mjs` (the real 20px pixels magnified) run from
  `app/` with Node and the installed Playwright Chromium; the owner judges from the sheets. Render
  the FINAL set from source, not from drafts: esbuild-bundle an entry that `renderToStaticMarkup`s
  every `RibbonIcon` (what `scripts/icon-accent-contact.mjs` does). The 2026-10-04 sheets are
  `icons/home-excel-icons-20px.png` (the 72 new and redrawn keys at 20/24/30, Light and Dark, after
  the icon review), `icons/home-excel-redraws-before-after.png` (the nine redraws, before and after,
  at 20 and 120) and `icons/home-excel-icon-review-before-after.png` (what the review changed, and
  the alternatives it rendered and did not take). The 2026-10-08 sheet is
  `icons/canvas-powerbi-icons-20px.png`: the 27 Canvas keys and the Stacked redraw at 20/24/30 and
  as magnified 20px pixels, Light and Dark, each beside Power BI's own picture where the owner's
  screenshot has one, and the picture each one replaced on the Canvas tab (re-rendered after the
  icon review); `icons/canvas-powerbi-icon-review-before-after.png` shows what that review changed
  and the alternatives it rendered and did not take, as real 20px pixels with each picture's
  half-covered pixel count and ink weight.
- **Two reviewers who disagree are settled on the 20px pixel map**, not by argument: render both
  proposals side by side as real 20px pixels magnified, in Light and Dark, and count half-covered
  pixels and ink weight. The 2026-10-04 review's Orientation, Delete Cells and Remove Hyperlinks
  were decided that way.
- **Lowering the contact allowlist.** `node scripts/icon-accent-contact.mjs --write` rewrites EVERY
  entry with today's measurement, and an entry up to 1.0 above its pin passes as noise, so a write
  can silently RAISE unrelated entries (on 2026-10-04 it would have raised Gridlines, Loop, Pivot,
  Undo and Redo by 0.2-0.8). Write to a scratch copy first (`ICON_CONTACT_ALLOWLIST=<copy>`), diff,
  and carry only the improvement into the repo file.

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
- **Two languages side by side** (owner question, 2026-10-22). The Visuals family (section 2.5) is
  drawn for visuals: the Canvas tab's Visuals gallery and Chart Design's chart types and layout
  toggle. A key is one drawing wherever it is used, though, so four family pictures also stand for
  commands on other tabs -- Table for Table Design's Convert to Range and the Writeback tab's
  Collected Responses, Slicer for Insert Slicer (Table Design and the Pivot Table tab), Timeline for
  the Pivot Table tab's Insert Timeline, and ChartHistogram for the Animation tab's Distribution
  launcher -- and the two languages meet there too. Everything else on the Canvas tab and Chart
  Design keeps the duotone language of sections 2.1-2.4 -- on the Canvas tab Floating Grid, New Page,
  Page Navigator, Clear Slicers, the Page View rows, Wallpaper and the interaction strips; on Chart
  Design the furniture -- so the family's square-rooted, gap-cut marks sit beside the duotone set's
  softly rounded tools. Whether the Canvas tab's own commands should follow the family is the
  owner's call, recorded in `docs/design/open-items.md`.
