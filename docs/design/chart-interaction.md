# Chart Interaction — Excel Parity

**Status:** landed 2026-09-21, Waves A-E, and PROVED LIVE — `app/e2e/journeys/chart-interaction.spec.ts`
runs 7/7 against a real build. CI-12 is partial by decision (§6.5, §6.6); everything else is done.
§5 carries the per-item status, §6 what the work discovered, §6.9 what only the live run could find.
**Owner request:** "I cannot double click the chart title and edit it, as I can do in Excel. Same
with x and y axis labels. These are a few examples. Another example is that I cannot select a
single data point, a bar for example, and change the color of only this bar. Research how
interaction with charts work in Excel and implement the same here."

The phrase that sets the scope is **"these are a few examples"**: the ask is the whole interaction
model, not the two named gestures.

---

## 1. Excel's model, as researched

Five independent research passes (Microsoft docs, Peltier, Exceljet, the VBA object model) agree on
a model that is smaller and more regular than it looks.

### 1.1 Selection is a two-level ladder reached by REPEATED SINGLE CLICKS

One click on a bar activates the chart and selects the whole **series**. A second, separate single
click on the same bar demotes the selection to that one **point**. Microsoft states this verbatim
for data labels — "The first click selects the data labels for the whole data series, and the
second click selects the individual data label" — and every reputable source says the same for data
markers.

The two clicks must be **slower** than the OS double-click interval. A genuine double-click is
consumed as a double-click and never reaches the ladder. This is load-bearing: a fast user can
never reach a single point by double-clicking, which is why Excel also ships the arrow-key walk.

Excel's own formal hit-test, `GetChartElement`, returns `ElementID + SeriesIndex + PointIndex`,
where **`PointIndex = -1` means "the whole series"**. That is the right shape for a hit-test return
value and we adopt it.

### 1.2 Double-click is ONE uniform gesture: "open Format <element>"

Double-click, right-click > `Format <element>...`, and `Ctrl+1` are three spellings of the same
command, for every element. Text editing is *not* a separate double-click meaning — it is the same
progressive click gesture applied to a text element: "Click again to place the title or data label
in editing mode", then drag-select and type.

### 1.3 The Format pane RE-TARGETS; it does not reopen

Since Excel 2013 there is one task pane. If it is open showing "Format Data Series" and you click
the axis, it becomes "Format Axis" in place. Every control applies **immediately** — there is no
OK/Cancel. The pre-2013 modal dialog with OK/Cancel is the older model and we do not clone it.

### 1.4 Right-click menus follow a strict shape

A shared block (Delete, Reset to Match Style, Change Chart Type..., Select Data...) plus
element-specific verbs, ending in **`Format <element>...` as the last item**.

Singular vs plural is load-bearing, and is how the user learns which rung of the ladder they are
on: **"Add Data Label"** on a point, **"Add Data Labels"** on a series.

`Reset to Match Style` is Excel's *clear-overrides* command (VBA `ClearToMatchStyle`: "resets ... to
automatic; all formatting, including overrides, is reset"). It is the exact counterpart that
per-point colouring requires — **a point-level override that cannot be individually cleared is a
trap.**

### 1.5 Titles are text objects; tick labels are not

Chart title and axis titles are editable in place. Axis **tick** labels never are — they come from
the data, and a click on one selects the axis. Excel is right to refuse, and so do we.

A title can be **linked to a cell** by selecting it and typing `=Sheet1!A1` in the formula bar.
Link-only: no functions, sheet-qualified. Typing literal text into a linked title **breaks the
link**.

`Enter` inside a title **inserts a line break** — it does not commit. Commit is by clicking
outside. (This differs from the cell editor, and the difference is deliberate.)

### 1.6 Deliberate granularity asymmetries — these are correct, not accidents

| Element | Granularity |
|---|---|
| Gridlines | ALL-or-none per axis per major/minor. There is no single-gridline object. |
| Error bars | Per-series, never per-point. |
| Tick labels | Not separable from their axis. |
| Legend entry | **Individually** selectable; deleting one removes the legend row but leaves the series plotted. |
| Data point | Individually formattable — fill, border, effects, marker, slice explosion. |

---

## 2. What Calcula had, measured

An inventory pass read the whole Charts extension. The headline: **the model was further along than
the bug report suggested, and broken in places the report never reached.**

Already present and working:

- The chart -> series -> point ladder (`handlers/selectionHandler.ts`), including an axis level.
- Selection painting, with 6 handles at point level (`rendering/selectionHighlight.ts`).
- A `SERIES` formula in the formula bar for series/point selection.
- `DataPointOverride` on the spec, and a Format Data Point dialog — reachable from the Design panel.
- Right-click > Format Axis (`components/AxisContextMenu.tsx`).
- Cell-linked titles already RESOLVE (`lib/dataSourceResolver.ts` `resolveSpecReferences`) and are
  already watched for invalidation. Only the *gesture* to set one was missing.

Missing or broken:

| # | Defect | Evidence |
|---|---|---|
| 1 | **No double-click gesture exists at all.** Core emits six `floatingObject:*` events, none a double-click. The `@api/cellDoubleClickInterceptors` seam is structurally unreachable over a floating object because the interceptor call sits behind an `if (cell)` gate. | `useMouseSelection.ts` overlay branch returned bare `null` |
| 2 | **Titles have no geometry.** The layout reserves *space* for the title and axis titles but records only four scalars, throwing the breakdown away — so no title can be hit-tested, selected or edited. | `rendering/chartPainterUtils.ts` `computeCartesianLayout` |
| 3 | **The ladder was bar-only.** The click path used `extractBarRects`, which returns `[]` for `points` and `slices` — so on pie, donut, line, area, scatter, radar and bubble a single point could never be selected. Hover meanwhile used the unified `hitTestGeometry`, so hover and click disagreed about the same pixel. | `index.ts` vs `chartRenderer.ts` |
| 4 | **One pixel of jitter cancelled the click.** Core dispatches `movePreview` on every mousemove; its 3px threshold gates only `moveComplete`. Charts cleared the pending click unconditionally. | `overlayMoveHandlers.ts` / `index.ts` |
| 5 | **13 of 18 marks ignored `dataPointOverrides`.** Stacked bars built no override map at all; horizontal bars never referenced overrides. `borderColor`/`borderWidth` were written by the dialog and painted by nothing. | `rendering/*Painter.ts` |
| 6 | **`ChartHitResult` declared `"title"` and `"legend"` with zero producers.** The stability test asserted only that the union had nine entries, so the dead members sat unnoticed. | `types.ts`, `types-stability.test.ts` |
| 7 | **Chart edits failed silently.** Three `.catch(() => {})` sites — update, create, delete. The backend refuses these under sheet protection's `editObjects` gate, so the canvas showed state that was never persisted and vanished on reload. | `lib/chartStore.ts` |
| 8 | Selection reset to chart level on every `CELLS_UPDATED`, so typing in a source cell dropped the user out of "this one bar" mid-task. | `index.ts` |

---

## 3. Architecture

The constraint that shapes everything: **Charts is an extension and may import only `@api`.** A
pointer gesture and a DOM text editor over the canvas are Core concerns. So each is a
feature-neutral Core capability behind a seam, not a chart-specific backdoor.

```
Core                          @api (the contract)            Charts (the semantics)
----                          -------------------            ----------------------
pointer gestures       -->    gridOverlays.onDoubleClick  --> which element was hit
canvas DOM + focus     -->    overlayTextEditor           --> which spec field to write
                              chartSelection (read-only)  --> publishes the current element
```

Two rules kept us honest:

- **A seam must have a second consumer, or it is a backdoor.** `onDoubleClick` was proved
  feature-neutral by deleting FloatingRange's hand-rolled "two `bodyDragStart` within 350 ms"
  workaround and routing it through the seam instead.
- **One implementation, not two.** `overlayTextEditor` generalises what FloatingRange's editor
  already proved, carrying across the three traps its comments documented: the deferred blur-commit,
  the **bounded** suppress window (an unbounded latch once swallowed an unrelated later commit), and
  identity-checked teardown.

### 3.1 The spec stays the single source of truth

A colour the user picks by hand is a `dataPointOverride` in the spec, so the JSON spec editor and
the format pane are two views of ONE object. This has a hard consequence discovered in review:

> `lib/chartSpecSchema.ts` sets `additionalProperties: false` in 61 places, and that one schema
> feeds THREE consumers — the broker's `validateChartSpec` gate, the Monaco spec editor, and an
> auto-generated reference table. **A field added to `types.ts` but not to the schema is refused at
> the gate and red-underlined in the editor.**

A drift guard existed for top-level `ChartSpec` keys but not for nested definitions, which is
exactly how a nested field would have slipped through. Wave B extends it to `LegendSpec` and
`DataPointOverride`.

### 3.2 Overrides are keyed by identity, not just position

Excel ships both index-keyed and datum-keyed behaviour and states plainly that neither default is
safe. Calcula already solved the **filter** half — `toAuthoringIndices` translates painter space to
authoring space, so hiding a lower-index series does not alias an override onto the wrong datum —
but not the **data** half: insert a row in the plotted range and the colour slid to the wrong bar.

Resolution is now **key first, index second**: an override captures the resolved series name +
category label at write time. Index remains the fallback so existing specs keep working. No
user-facing workbook switch — Excel's is a symptom of not having solved it.

---

## 4. Deliberate divergences from Excel

- **No click-timing ambiguity.** Excel's "two slow clicks, but not too fast" is a usability defect
  born of overloading one button. We keep the ladder but do not require the user to out-wait a
  timer.
- **The modern pane, not the legacy modal.** Excel 2013 replaced its OK/Cancel dialogs with an
  immediate-apply retargeting pane; we build that and retire the two modal chart dialogs.
- **A deleted legend entry is individually undoable.** Excel makes you remove and recreate the whole
  legend. That is a defect, not a model.
- **Tick labels stay uneditable** — here we agree with Excel, and for its reason.

---

## 5. Work items

| id | item | status |
|---|---|---|
| CI-4 | Core double-click seam for floating objects (`onDoubleClick`) | **done** — Wave A (`app/src/api/gridOverlays.ts`) |
| CI-5 | `@api/overlayTextEditor` — one in-place canvas editor | **done** — Wave A (`app/src/api/overlayTextEditor.ts`) |
| CI-1 | Ladder survives jitter, reaches every mark, survives data refresh | **done** — Wave A |
| CI-15 | Chart edits fail loudly instead of silently | **done** — Wave A |
| CI-6 | `ChartLayout` records element rects | **done** — Wave B. `ChartElementRects` (`types.ts:1886`), two-stage: layout ESTIMATES, paint OVERWRITES what it measures, and a stage that mutates `margin`/`plotArea` must call `reflowChartElements` before painting (contract at `types.ts:1864-1884`) |
| CI-13 | Overrides keyed by datum identity | **done** — Wave B. `resolveDatumStyle` (`lib/dataPointOverrides.ts`) is the ONE per-datum resolver; key first, index second |
| CI-2 | Every built-in mark honours `dataPointOverrides` | **done** — Wave B, for every `builtin: true` mark (18 of them today; the test derives the list from the registry rather than hard-coding it), pinned by `rendering/__tests__/dataPointOverrideCoverage.test.ts` (which also asserts a CUSTOM mark is excluded, `:273`). The two reachability gaps are now CLOSED — see §6.7 |
| CI-7 | Element hit-testing + honest selection taxonomy | **done** — Wave C. `CHART_ELEMENT_IDS` / `ChartElementId` (`types.ts:1644`), `ChartHitResult = {element?, seriesIndex?, pointIndex?}` with pointIndex ABSENT = whole series (`types.ts:1670`). `rendering/__tests__/elementHitTest-drift.test.ts` RUNS the hit-tester and asserts declared==produced in BOTH directions (`:140`, `:150`) |
| CI-8 | In-place editing of chart title and axis titles | **done** — Wave C (`handlers/chartTextEditing.ts`) |
| CI-3 | Element-aware context menus | **done** — Wave C. The right-click also MOVES the selection and records its subject — see §6.1 |
| CI-9 | Retargeting Format pane | **done** — Wave C. `ChartFormatPane`, contributed by a manifest that declares `contextKeys: ["chart"]` (`app/extensions/Charts/manifest.ts:83`); it retargets on selection change rather than remounting, and its body is keyed on the SUBJECT so a field's local draft reseeds (`components/ChartFormatPane.tsx:1885`) |
| CI-9b | Current-selection readout in the Name Box | **done** — Wave C. `@api/chartSelection` publishes the selection plus a `displayName` (`chartSelectionDisplayName`, `app/src/api/chartSelection.ts:183`); `NameBox.tsx:395` prefers the chart label over the cell address |
| CI-10 | Keyboard element navigation, Ctrl+1, Esc steps up, Delete furniture | **done** — Wave D. `buildChartNavGroups` / `navigateChartSelection` / `escapeLevelUp` (`handlers/selectionHandler.ts`); three capture-phase listeners in `index.ts` (`handleDeleteKey`, `handleOverlayStepKey`, `handleChartNavKey`) all read `chartOwnsKeystroke`. See §6.2-§6.4 |
| CI-11 | Reset to Match Style, scoped to the selection | **done** — Wave D. `resetToMatchStyleScopePatch` (`components/ChartContextMenu.tsx`) is the one scope→patch function, read by that file's own menu item and by the pane's `ResetToMatchStyleRow` (`components/ChartFormatPane.tsx:1729`) |
| CI-12 | Legend entries, gridlines, trendlines, error bars, plot area selectable | **done** — Wave D + Wave R, and the two remaining "declared selectable, not actually clickable" cases closed in Wave V. `CHART_SELECTABLE_ELEMENT_IDS` (`rendering/selectionHighlight.ts`) went from six ids to ten: `trendline`, `errorBars`, `dataLabel` and `dataTable` now have ladder rungs (`buildChartNavGroups`, `sameRung`, `escapeLevelUp`), selection paint in each element's own SHAPE (a trendline is re-stroked with a handle at each end and NO box; an error-bar set gets a hairline box on every bar and no handles), Format-pane sections, and Delete through one resolver (`furnitureDeletePatch`) with three derivations. Two new spec fields carry the finest act: `ErrorBarOptions.seriesFilter` and `DataLabelSpec.hiddenPoints`. **A rect is not a rung until it describes painted pixels**: an error bar running off the top of the scale recorded a NEGATIVE y (the painter clips, the rect did not) so a click aimed at it landed on the GRID and deselected the chart, and an "above" data label on a bar at the scale maximum was clamped INSIDE its own bar, where a datum beats furniture and it can never be hit. Both were worked around in the journey with `yAxis: { max: 100 }`; both are now fixed at the source — §6.13. `gridlines` stays out, with evidence — §6.6 |
| CI-14 | Live preview on hover as a transient write | **done** — Wave D. `previewChartSpec` / `restoreChartSpecPreview` (`lib/chartStore.ts:185`, `:204`). See §6.8 |
| CI-16 | E2E journey proving both named requests live | **done** — Wave E. `app/e2e/journeys/chart-interaction.spec.ts`, 7 journeys, every gesture a real mouse/keyboard event at a coordinate the RENDERER computed. It found four product defects the unit tier could not see — §6.9 |

### 5.1 Traps recorded for the implementer

- **The title editor must be seeded from the RAW spec, never the resolved one.**
  `resolveSpecReferences` returns a spec whose `title` is the *resolved string*, and that is what
  reaches the painters. Seeding the editor from it would show `Revenue` for a title stored as
  `=Sheet1!A1` and commit the literal — silently destroying the link. `initialText` comes from
  `getChartById(id).spec.title`; `getRect()` reads the resolved layout.
- **`layout` is mutated after computation** by the combo painter, the horizontal-bar painter, the
  Pareto painter, the data-table height fold, and the pivot-button adjust. Element rects must be
  offset or recomputed after each, or a title rect is stale by exactly the height that was added and
  the click lands on nothing. *(The data-table fold was later deleted rather than reflowed — §6.11;
  the horizontal-bar painter derives a NEW layout and computes its rects at birth.)*
- **Pareto has a second, independent legend layout.** A change made only in `chartPainterUtils`
  leaves its legend unhittable.
- **The per-point coverage test must be scoped to `builtin: true` marks.** `registerChartMark` is
  public and sandboxed script marks cannot be made to honour overrides.
- **Arrow keys already have a claimant.** Charts installs a capture-phase listener that consumes
  plain Left/Right when the selected chart carries insight cues. Keyboard element-walking must own
  both listeners and state the precedence, not add a third.
- **`deepMergeSpec` replaces arrays wholesale.** A pane that caches its own copy of
  `dataPointOverrides` and writes it back will drop a concurrent JSON-editor edit. Re-read at commit
  time.
- **`.cala` needs no format bump.** Charts persist as `charts.json` of `SavedChart` with an opaque
  `spec_json: String` under the existing `charts` manifest feature id, so new spec fields ride along.

### 5.2 How §5.1's traps held up

Three are visible in the shipped code as written:

- **The title editor IS seeded from the raw spec.** `openChartTextEditor` builds `initialText` from
  `rawChartTextValue(chart.spec, elementId)` (`handlers/chartTextEditing.ts:379`), never from the
  resolved spec, so a title stored as `=Sheet1!A1` opens as that formula and the link survives.
- **The layout mutation trap became a stated contract, not a note.** `reflowChartElements`
  (`rendering/chartPainterUtils.ts`) is called by every stage that still mutates `margin` /
  `plotArea` after layout: the combo painter, the Pareto painter, and `chartRenderer`'s
  `adjustLayoutForPivotButtons` — which takes `spec`/`data`/`theme` it does not otherwise need
  precisely so the reflow lives INSIDE the mutation and a second caller cannot forget it. The rule
  and its direction (reflow BEFORE painting, never after, or the measured truth the painters wrote
  back is discarded) is kept on the type itself (`ChartElementRects` in `types.ts`).
  **The data-table fold is no longer one of them** — OB-2 removed it from `dispatchComputeLayout`
  entirely, because a band folded in after the fact left the tick-label and axis-title reservations
  inside `computeCartesianLayout` untouched: two places computing one band. It is now decided once,
  by the cartesian and radial layout functions every registered mark bottoms out in. See §6.11.
- **The per-point coverage test is scoped to `builtin: true`** and says so
  (`rendering/__tests__/dataPointOverrideCoverage.test.ts:62`, `:273`).

**One changed shape: the arrow-key claimant.** "Own both listeners and state the precedence" was
not sufficient, because the two listeners sit on the SAME DOM node at the same phase, where
`stopPropagation` buys nothing. See §6.3.

---

## 6. What the four waves discovered

Everything in this section was found by building the thing, not by reading Excel. Each item is
here because the next implementer will rediscover it otherwise.

### 6.1 Right-click moves the selection, and the subject is recorded afterwards

The defect: `ChartContextMenuContribution` carries only a `chartId`, so a menu item acted on
whatever the last LEFT click had selected. Right-clicking bar B while bar A was selected formatted
A.

The fix is not a wider contribution contract — that would change the subject of all six existing
contributions. It is Excel's own rule: **a right-click moves the selection, and the menu's subject
is then the selection's subject.** One fact, not two. `handleContextMenu`
(`app/extensions/Charts/index.ts`) does it in three numbered steps:

1. **Resolve the element from the CURSOR, not from hover state** — `findChartAtCanvasPos` by
   bounds, then `hitTestGeometry` against the cached layout. Hover is rAF-throttled and tracks only what the renderer chose to track. The axis branch used to key off
   hover while everything else resolved by bounds, so the same pixel answered two different
   questions depending on how fast the mouse got there.
2. **Move the selection** exactly as a left-click on that pixel would (the block headed
   `1. MOVE THE SELECTION`) — including
   `advanceSelection` on a datum, so a first right-click selects the SERIES and a second selects the
   bar. That is what decides singular vs plural in the menu.
3. **Record the subject** through `setChartRightClickTarget` (`app/src/api/chartData.ts:241`),
   *after* the selection has moved, so the menu's rung and the selection's rung are the same rung
   (the block headed `3. RECORD THE SUBJECT`).

Three details that are not obvious:

- **`pointIndex` is taken from the LADDER, not from the hit** — it is the ladder-derived
  `painterPoint`, not `hit.pointIndex`. The hit names a point on every datum click; the ladder is what knows whether the reader is on the series or on the
  point. Absent `pointIndex` is Excel's `PointIndex = -1`.
- **The recorded pair is translated to AUTHORING space** (via `toAuthoringIndices`, immediately
  before the `setChartRightClickTarget` call). Overrides are keyed pre-filter while the hit test
  answers post-filter. Skipping the translation is wrong only on a FILTERED chart, which is exactly how it would pass
  review.
- **The record is NOT cleared when the menu unmounts.** `onClose()` runs BEFORE a contribution's
  `onSelect`, so clearing on unmount hands every contribution a null subject
  (`app/src/api/chartData.ts:193-197`). It is instead REPLACED on every `contextmenu` event,
  `null` included (the early `return` for a click that hit no chart, and the axis-menu branch),
  and dropped on deactivate (a `cleanupFunctions.push(() => setChartRightClickTarget(null))`).

`CHART_TARGET_ELEMENTS` (`app/src/api/chartData.ts:158`) is a deliberate SECOND SPELLING of
`CHART_ELEMENT_IDS`, because `@api` must never import from `app/extensions`. It is pinned by a
drift guard in `ChartContextMenu.test.tsx` that asserts set equality in both directions plus a
compile-time assignability check each way.

### 6.2 Delete precedence, and why `isGridFocused` is a rung

**The order, final:**

```
1. isKeyClaimed(e)          -> not ours   (a widget stacked ON the grid owns its keys)
2. !isGridFocused()         -> not ours   (the grid is not the subject at all)
3. isTextEntryTarget(target)-> not ours   (a keystroke aimed at a text field is that field's)
then, by SUBJECT:
4. element level + a text element  -> clear the title       (never the chart)
5. element level + legend/entry    -> hide the legend       (never the chart)
6. otherwise                       -> delete the chart
```

Gates 1-3 are `chartOwnsKeystroke` (`app/extensions/Charts/handlers/selectionHandler.ts`), ONE
predicate read by all three of the extension's capture-phase key listeners, because the question is
the same for every one of them and a per-listener copy is a copy that drifts.

**Gate 2 was the missing rung, and it was a data-loss defect.** A `<button>` or a `<select>` in a
task pane carries no pointer claim and is none of INPUT / TEXTAREA / contentEditable, so gates 1 and
3 both said yes. Select a chart, click the Format pane's Options tab (a real `<button>`, now
focused), press Delete — **the chart was destroyed. Three clicks from a fresh selection.** The
contextual Design panel has the same shape; the Format pane widened it from a ribbon strip to a
whole pane of focusable controls, which is what made it easy to hit. The predicate is Core's own
(`isGridFocused` from `@api/keybindings`), imported rather than re-derived, because a second
spelling of `[data-focus-container="spreadsheet"]` inside an extension drifts on the first change to
the attribute. Pinned by `handlers/__tests__/chartKeyboardOwnership.test.ts:94` and `:117`.
Ledgered as **BUG-0125**.

**The claim is asked twice on purpose** — once at each listener's own door (`isKeyClaimed(e)` is
the first line of `handleDeleteKey`) and again inside `chartOwnsKeystroke`. That is not a leftover:
the census in `app/src/core/lib/globalInputListeners.ts` requires a claim-guarded FILE to consult a
claim predicate where its listener lives, on the ground that a guard behind an indirection is a guard a reviewer
cannot see, and `app/src/core/lib/globalInputListeners.test.ts` enforces it. The question is
idempotent, so the cost is one attribute walk and the benefit is that deleting EITHER line still
refuses.

**Gates 4-6: THE SUBJECT DECIDES WHO OWNS THE KEYSTROKE, NOT WHETHER A WRITE HAPPENED.** This is
the second data-loss defect. The branch originally read `if (handleChartTextDelete(chartId)) return;`
— it fell through to deleting the chart when nothing was cleared. `clearChartText`
(`handlers/chartTextEditing.ts:303`) returns **false when the title is already null** (`:306`), and
the reader reaches that state with ONE Delete, because nothing moves the selection off a cleared
title: `revalidateSubSelection` (`handlers/selectionHandler.ts`) returns early unless
`subSelection.level` is `series` or `dataPoint`, so an `element`-level selection is never
re-validated. The second Delete — the "did that work?" reflex, on a title that had visibly just
vanished — therefore destroyed the whole chart. The branch now consumes the keystroke on the SUBJECT
(the `isChartTextElement(sub.elementId)` branch of `handleDeleteKey`), and the legend branch
immediately below it has the same shape for the same reason. Ledgered as **BUG-0124**.

### 6.3 Arrow keys: the precedence rule, and why the early return is what saves it

Two features want plain Left/Right on a selected chart: the insight overlay's STEP through the
points of interest (`docs/design/insight-overlays.md` §4.8a) and the chart-element WALK (CI-10).

**The rule, stated once** as a pure predicate both listeners read —
`arrowsBelongToOverlayStep` (`handlers/selectionHandler.ts`):

> PLAIN Left/Right belong to the overlay step WHEN, AND ONLY WHEN, the sub-selection is at CHART
> level and the chart actually carries cues. Everywhere else — any deeper rung, any chart without
> cues, and every modified arrow — they belong to the element walk.

It is the right split rather than a coin toss: chart level is exactly where the walk has nothing to
do (the chart-area group has one member, so Left/Right there moves nothing), and it is where a
reader who turned cues on is looking. The modifier test comes FIRST — `altKey || ctrlKey ||
metaKey || shiftKey` is the predicate's opening line — and matches `overlayStepDelta`'s own, so a
Ctrl+arrow is never withheld from the walk on the strength of a cue — which is what lets the walk bind both the plain and the Ctrl form without either being taken
away.

**THE NON-OBVIOUS PART — why the walk's own early return is what prevents a double action.** Both
listeners are `keydown`, **capture phase, on `document`** — the same node
(`document.addEventListener("keydown", handleOverlayStepKey, true)` and the identical
registration for `handleChartNavKey`). `stopPropagation()` does **not** stop a sibling listener
registered on the same node at the same phase; only `stopImmediatePropagation()` would, and reaching
for that would make the outcome depend on registration order. So the overlay listener consuming the
key does **nothing** to stop the walk listener from also running and moving the selection. The
safeguard is that the walk asks the SAME predicate and returns before doing anything, in
`handleChartNavKey`:

```ts
if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && overlayStepOwnsArrows(chartId, e)) {
  // The overlay step owns this keystroke — see the precedence note above.
  return;
}
```

Delete that early return and one arrow press steps the cue AND walks the element — with no error
anywhere, because both actions succeed.

### 6.4 Why `registerKeybinding` grew a `when` clause

Ctrl+1 is Excel's universal "format this": it formats CELLS, except while a chart element is
selected, when it formats the chart. Charts could not win it from its own listener. **The shell's
keybinding listener is capture-phase on `window` and is installed before any extension activates**,
so it consumed Ctrl+1 for Format Cells and called `stopPropagation()` before this extension's
document-level door ever ran (the comment block above Charts' `registerKeybinding` call in
`index.ts`).

Registration order could not express the claim either — the built-ins are registered in
`initKeybindings`, long before any extension, so they always won. The honest way to say "I own this
key only while my subject is selected" is VS Code's *when clause*:
`registerKeybinding(binding, when?)` (`app/src/api/keybindings.ts:811`), with the predicate held in
a private `bindingGuards` map (`:788`) rather than as a field on `KeyBinding` — a callable on the
binding object would leak through `getAllKeybindings()` into the settings UI and every consumer that
serialises a binding.

**Three rules, all in the registry rather than at the call site:**

1. **A guarded binding that says no is SKIPPED, and it is skipped BEFORE `matches` is populated**
   (`keybindings.ts:1202`). So it can neither shadow the unguarded binding underneath it nor swallow
   the keystroke with a `preventDefault`.
2. **A guarded binding that says yes BEATS an unguarded one**, because it is the more specific claim
   (`keybindings.ts:1240-1243`). Ties among guarded bindings fall back to registration order, as
   before, and a `source: "script"` binding still never beats an app one.
3. **A predicate that THROWS counts as "does not apply"** (`keybindings.ts:841-850`). A broken
   extension must not be able to take a key away from the app by failing.

Charts' own use is one line — `() => getCurrentChartId() !== null`, passed as the second argument
to `registerKeybinding` for `ext.charts.formatSelection` in `index.ts`.

### 6.5 Composed charts carry no panel index

`HitGeometry.composite` (`types.ts:1797`) is built by **two unrelated producers**:
`composePanelGeometry` (chartDispatch) makes one group per FACET or CONCAT PANEL, while
`comboChartPainter` and `paretoChartPainter` make one group per MARK LAYER over a SINGLE panel.

A group index is therefore **not** a panel index. Stamping it as one would be a fabricated identity
that means two different things depending on which painter produced the geometry — the exact defect
class CI-7 spent its budget removing. So composed charts stay inert at the panel level: the first
datum hit across the groups wins, and its `seriesIndex` / `pointIndex` are the datum's own, which is
what every consumer actually uses. A real panel index belongs with a `HitGeometry` variant that
records one at CONSTRUCTION, not with a guess at hit-test time. Reasoning kept at the head of
`rendering/chartHitTesting.ts:48-59`.

### 6.6 Why `gridlines` has no element id

Excel addresses gridlines — all-or-none per axis per major/minor, never one line — so the omission
looks like a gap. It is not. **Nothing in `ChartLayout` records where a gridline is drawn:**
`drawHorizontalGridLines` / `drawVerticalGridLines` compute `scale.ticks(5)` INSIDE the call, take
no layout, and are invoked from **13 call sites across 12 painter files** (area, bar, boxPlot,
bubble, combo, histogram, horizontalBar, line, pareto, scatter, stock, waterfall) plus
`chartPainterUtils`' own chrome pass. Those are the numbers that make this refusal checkable rather
than a matter of taste: giving gridlines a producer means changing both signatures and every one of
those sites — fourteen files.

Re-checked a THIRD time when the rest of the furniture became selectable in Wave R, and refused
again on the same evidence. There is no honest shortcut either: the layout carries no scale, so a
hit-tester cannot re-derive the tick positions, and a branch that answered "anywhere in the plot
area" would steal every plot-area click — the same defect as the insight ring that stole the click
from a bar (insight-overlays.md §5h). When it is built, the identity is `(axisType, major|minor)`;
`ChartSubSelection` already carries `axisType`, so only a `gridlineKind` would be new.

A `gridlines` member would therefore be **dead on arrival** — a declared element with no producer,
which is the exact defect `CHART_ELEMENT_IDS` exists to prevent (`"title"` and `"legend"` sat in the
previous union for a year with zero producers anywhere in the repository). And it would not sit
quietly: `elementHitTest-drift.test.ts:140` RUNS the hit-tester and fails on a declared element that
nothing produces. It belongs with the change that threads a layout into those two painters and
records the tick geometry. Reasoning kept at `types.ts:1633-1642`.

### 6.7 What CI-2 did not reach, and how both gaps were closed

Every `builtin: true` mark honours `dataPointOverrides`, and that was genuinely tested — but being
honoured is not the same as being REACHABLE. Two gaps were open; both are now closed.

**Gap 1 — a mark whose per-datum shape can be switched off.** `showMarkers` defaults to `false` on
an area chart, and the override was resolved only inside `if (showMarkers)`. The area polygon is
filled from the SERIES colour, so on the chart a reader actually inserts there was no per-datum
shape for "format this point" to land on: the pane took the colour, the spec stored it, the document
went dirty, and the picture did not move.

The rule is now one predicate, `markerReachesDatum(showMarkers, matchedBy)`
(`rendering/markerPainter.ts`), beside the datum-marker primitive the point painters share: markers
on, every datum gets one; markers OFF, only the datums an override actually reached. **The override
IS the request** — Excel's area charts answer it the same way. The loop is skipped outright when
the spec carries no override (`specHasDatumOverrides`, `lib/dataPointOverrides.ts`), so a chart
without overrides is byte-identical to before, proved by call-stream comparison rather than by
assertion.

Three painters adopt it, and the list is exhaustive: `rg showMarkers` over `rendering/` finds four
marks whose datum shape can be switched off — area, line, radar, pareto. Area was the reported gap
because it defaults to off; **line and radar re-open exactly the same hole the moment a reader sets
`showMarkers: false`**, and on those two the datum then has no shape at all. Pareto is unaffected:
its markers sit on the cumulative-line overlay and its datum still has a BAR. Everything else paints
a per-datum shape unconditionally. Pinned by `reachability-areaDefaultMarkers.test.ts` and
`reachability-lineRadarMarkersOff.test.ts`; `dataPointOverrideCoverage.test.ts`'s `area` fixture no
longer switches markers on, so the census now covers the DEFAULT chart.

**Gap 2 — a sandboxed / custom mark.** `registerChartMark` is public and
`rendering/sandboxMarkShim.ts` blits an opaque worker `ImageBitmap` into the plot rect: there is no
per-datum call to intercept. The host now RESOLVES every datum an override reaches
(`resolvedDatumStylesForMark`) and ships the answer in the worker paint payload as
`paint.datumStyles`, sparse, in PAINTER space, with a silent field as `null` rather than a guessed
default. Letting the mark read `spec.dataPointOverrides` itself was refused and the refusal is a
test, not a paragraph: the raw array is keyed in AUTHORING space and matched by identity key before
index, so `reachability-sandboxDatumStyles.test.ts` contains that mark written the obvious way and
demonstrates it losing the reader's colour and painting a HIDDEN datum's colour onto its innocent
neighbour as soon as a filter hides a lower-index series.

**What the host still cannot do is CHECK.** The pixels are opaque, so the capability is a
DECLARATION the mark makes — `ChartMarkMeta.honoursDataPointOverrides`, authored through the
checkbox in the Chart Marks dialog and travelling verbatim to the registry — and
`chartMarkHonoursDataPointOverrides(mark)` is what a UI must consult. Both doors into per-point
formatting now do: the Format pane EXPLAINS ("this chart type does not support formatting a single
data point") and the context menu WITHHOLDS the "Format Data Point..." row, because a verb that
opens a dialog only to refuse is worse than a verb that is absent. True for every built-in, so
nothing changed for the eighteen; false only for a custom mark that did not declare
(`components/__tests__/perPointFormattingGate.test.tsx`, each refusal paired with a positive
control so a gate that refused everything could not pass).

**A FALSE REFUSAL IS ALSO A DEFECT, and this gate shipped one for about ten minutes.** The first
version asked `chartMarkHonoursDataPointOverrides` directly. That predicate answers FALSE for an
UNREGISTERED id — correct on its own terms, since a mark that never registered cannot have promised
anything — and the pane then told the reader that a BAR CHART does not support per-point
formatting whenever the mark registry had not been populated yet. Fifteen previously-green tests
went red saying so, all in files that double `rendering/chartRenderer` and therefore never pull in
`chartDispatch`, which is what registers the built-ins at import time. The rule is now
`markOffersPerPointFormatting` (`lib/dataPointOverrides.ts`), one function behind both doors:
**refuse only what we KNOW declines** — registered and undeclared — and offer an unknown id, whose
chart paints nothing anyway (`paintMark` is a no-op for an unregistered mark), so there is no datum
to right-click. Gating a feature on a registry is gating it on an import order.

### 6.8 The preview's exit paths, and the two backstops

CI-14's live preview is the transient-write pattern (CLAUDE.md rule 6) in its smallest form. It goes
through `previewChartSpec` (`lib/chartStore.ts:185`), which mutates the render-time spec **and
nothing else**: no `scheduleSave`, no undo entry, no dirty flag. Routing it through
`updateChartSpec` instead would persist the colour the pointer happened to pass over — a 300 ms
debounce means the LAST swatch crossed on the way to the OK button is what lands in the workbook,
the document is dirtied, and the close-without-saving prompt then guards an edit the reader never
made.

**THE RESTORE IS THE WHOLE CONTRACT.** A preview left standing is not cosmetic: the next REAL edit
would deep-merge onto the previewed spec and persist it as authored state, so the preview would have
written itself into the document through a command innocent of it.

**Every exit path restores, and they are enumerated rather than assumed**
(`components/ChartFormatPane.tsx:341-349`):

| exit | where |
|---|---|
| mouse-out | the swatch's own `onMouseLeave` / `onBlur` (`ChartFormatPane.tsx:960`, `:973-974`) |
| commit | `applySpecPatch` |
| pane close | the unmount cleanup (`ChartFormatPane.tsx:1780`, `useEffect(() => endChartSpecPreview, [])`) |
| chart deselect / retarget | the selection subscription, keyed on the SUBJECT (`ChartFormatPane.tsx:1773-1776`). Keyed on the subject rather than on "a snapshot arrived", because the republish that follows the preview's OWN repaint carries the same subject, and restoring on that would kill every preview the instant it appeared |
| chart deletion | `chartStore.deleteChart` drops it (`lib/chartStore.ts:742`) |
| File > New / Open | `chartStore.loadChartsFromBackend` drops it (`lib/chartStore.ts:522`) |
| extension teardown | `resetChartStore` drops it (`lib/chartStore.ts:898`) |

**Two backstops make a missed exit path harmless rather than corrupting:**

1. **`updateChartSpec` / `replaceChartSpec` restore BEFORE they merge**
   (`lib/chartStore.ts:690`, `:722`), so a real edit always starts from the true spec.
2. **`flushDirtyCharts` persists the ORIGINAL spec while a preview is up**, via
   `chartAsPersisted` (`lib/chartStore.ts:244`, used at `:470`). This is the case the exit paths
   structurally cannot cover: a drag or a rename scheduled a save 200 ms ago, the reader is now
   hovering a swatch, and the debounce fires. `toEntry` serialises the WHOLE chart, spec included.

Two supporting rules: only ONE preview exists at a time and every preview merges onto the ORIGINAL
spec rather than the previous preview (`lib/chartStore.ts:188-194`), so crossing ten swatches leaves
exactly one thing to undo; and `getPreviewBaseSpec` (`:221`) is what a COMMIT must build from, so a
control that spreads `spec.dataPointOverrides` while its own hover preview is on screen does not
bake the preview into the committed array.

The restore token is held **by reference, not cloned** (`ChartSpecPreview.original`,
`lib/chartStore.ts:163-173`): nothing in the
module mutates a spec in place, and a JSON clone would quietly drop the explicit-`undefined` keys
that `deepMergeSpec` treats as "cleared".

### 6.9 The live proof found four defects that 113,000 green unit tests did not

The E2E journey (`app/e2e/journeys/chart-interaction.spec.ts`) drives real mouse and keyboard
events at coordinates the RENDERER computed, following `insight-overlays.spec.ts` — the journey
that learned this lesson the hard way, having shipped two defects while selecting cues
programmatically. Every defect below was invisible to the unit tier.

1. **Per-point colour was a silent no-op on every radial datum but the first.** The write path
   addressed a slice at `(categoryIndex, categoryIndex)` while every radial painter resolves at
   `(0, categoryIndex)` — the two agree only for slice 0. The pane then READ IT BACK at the same
   wrong address, so the swatch insisted the colour was set while the chart ignored it. The test
   that should have caught this did not exist: one test proved the painters honour `(0, ci)`,
   another proved the merge stores what it is handed, and **nothing asked whether the two
   addresses were the same one.** That closed loop is now `components/__tests__/datumWriteAddress.test.ts`.

2. **Delete cleared the user's cells instead of acting on the chart.** `@api/keybindings` installs a
   **window** capture listener that matches Delete and calls `stopPropagation()`; Charts' listener
   is a **document** capture listener — strictly later. Every branch of the Delete work sat behind
   a door the key never reached. See §6.4: the remedy is a guarded binding, not a third listener.

3. **`flushPendingChartSaves` had no caller in the product.** It documents itself as "call this
   before file save or app close" and the only reference in the repo was the E2E spec. A chart edit
   committed within 300 ms of Ctrl+S was still a pending `setTimeout` when `save_file` serialised.
   Worse on close: the dirty flag is set INSIDE `update_chart`, so a never-flushed edit left
   `is_modified` false and the close-without-saving prompt never appeared.

4. **Clicking the grid did not return keyboard focus to it** — a CORE defect far wider than charts.
   `SpreadsheetContainer` carries `tabIndex={0}`, but the cell mousedown path calls
   `preventDefault()` before its first await, cancelling the browser's focus move, and nothing put
   it back. Once focus sat on any `<button>` outside the grid — a task-pane tab, a ribbon control,
   the Format pane the chart itself opens — clicking the grid moved the cell cursor and advanced the
   chart ladder **while the keyboard stayed dead**, with nothing on screen to explain it. Fixed at
   the grid's outermost pointer door (`core/components/Spreadsheet/gridPointerEntry.ts`) with three
   exemptions: an open cell/formula edit (clicking a cell mid-formula is how a reference is picked),
   focus already inside the container, and a self-focusing target such as the Floating Range's
   unclaimed on-canvas `<textarea>`. The predicate matches concrete tags, never `[tabindex]` — the
   focus container is itself `tabIndex={0}`, so `[tabindex]` would match from every target and the
   rule would never fire.

**The methodological lesson, recorded because it will recur:** defect 1 is the shape to fear. Two
sides of one contract were each tested in isolation and both were green; the contract BETWEEN them
had no test. When a value is written at one address and read at another, test the round trip, not
the halves.

### 6.10 One spelling for the colour of a series (OB-1)

The owner, testing the five waves live: *"when I select an individual data point and give it a
color I cannot select a color for the entire series after that."*

"The colour of a series" had **two spellings**, and the Format pane wrote the losing one.

- `spec.seriesColors[name]` — name-keyed. `applySeriesColorOverrides` (`lib/chartDataReader.ts`)
  applies it onto the parsed `data.series[i].color`, so it is what the painters end up reading.
- `spec.series[i].color` — index-keyed. What `SeriesSections` wrote, and the **base** the line
  above overwrites.

So once a series colour had ever been set from the ribbon Design panel, the Format pane's swatch
reported success and changed nothing. Reproducing it turned up three more:

- The pane bailed on `if (spec.series?.[seriesIndex] === undefined) return null`. `series` is
  required on `ChartSpec`, so a range-backed chart always has entries — but a **pivot**, a
  **design query** and anything compiled from an `encoding` block carry `series: []` and have the
  series produced by the reader. On those the swatch wrote nothing at all.
- The Design panel's **"Auto"** (reset to palette) was dead. It did `delete next[name]` and then
  `updateSpec({ seriesColors: next })`, and `deepMergeSpec` merges a plain-object field **key by
  key** — so the colour survived its own removal.
- On a **pie/donut** the series swatch could never work: the radial painter resolves every slice
  from the palette by CATEGORY (`getSeriesColor(palette, i, null)`) and never reads
  `data.series[0].color`.

**`seriesColors` survives, alone.** It is the only spelling that can address every data source and
the only one that survives a filter. `spec.series[].color` stays in the spec as an
**authored/imported default** — XLSX import, `chartExamples`, an authored spec — and is the base
the override wins over; no formatting surface writes it any more. One reader and one writer live
together in `lib/chartDataReader.ts`, beside the resolution stage that consumes them:
`readSeriesColor`, `seriesColorPatch`, `seriesNameArity`. **All four** surfaces go through them —
the Format pane, the ribbon Design panel, the dialog's Design tab and the dialog's **Data tab**.

A clear writes the cleared key as an **explicit `undefined`** (and drops the whole field when it
was the last one), because that is the one form correct under both merge rules: the live store's
`deepMergeSpec`, which merges a record field by field, and the Insert Chart dialog's spec overlay,
which replaces a key wholesale. Reset to Match Style still clears **both** fields, deliberately —
an imported colour nobody can remove is the same trap in a different field.

**Two ambiguities are now said out loud rather than guessed at.**
`unambiguousDataPointKeyForDatum` refuses an ambiguous DATUM key, and can afford to: the datum
resolver has a second addressing mode (the index pair) the painter resolves just as well. A series
has no second mode left once the index-keyed field is out of the formatting path — a pivot series
has no index-keyed home in the spec at all — so refusing would mean refusing the colour. Defined
behaviour: a name-keyed colour applies to **every** series answering to that name, and the pane
says *"2 series are named 'Cost' — this colour applies to all of them."* Separately, a per-point
override still outranks the series colour, so setting a series colour recolours every other point
and leaves the overridden one alone. That is Excel, it is correct, and it was previously
indistinguishable from a dead control — so the pane now says so and points at Reset to Match
Style rather than changing the precedence.

**Two dead controls were removed.** A pie's series rung explains that slices take their colour from
the palette instead of offering a swatch that writes a field nothing reads; a series whose name
cannot yet be resolved says so instead of no-op'ing.

The ladder was **not** the defect. From a dataPoint, Escape steps to series (`escapeLevelUp`), Up
walks groups, and clicking a different series drops to series level. Clicking the SAME bar keeps
you at the point, as Excel does.

### 6.11 The data table owns the bottom band (OB-2)

The owner's screenshot: with a data table on, the category tick labels `2023 2024 2025 2026`
painted large **on top of** the table's own header row, which carries the same four strings small —
and the x-axis title `Testar 90is` painted **through** the table's series row.

The band below a cartesian plot was computed in **two places**. `computeCartesianLayout`
(`rendering/chartPainterUtils.ts`) reserved `labelFontSize + 8` for the x tick labels and
`axisTitleFontSize + 6` for the x-axis title, knowing nothing about the data table;
`dispatchComputeLayout` then folded the table's height into `margin.bottom` **afterwards**. The
band was big enough overall, but nothing re-apportioned it, so the labels and the title were still
painted at their original offsets — inside the table.

**The whole band now lives in `computeCartesianLayout` / `computeRadialLayout`**, the two functions
every registered mark's `computeLayout` bottoms out in, and the fold is gone from the dispatcher.
Order, top to bottom: **`[plot] [x tick labels] [data table] [x-axis title]`**.

- The tick-label band is **zero** when the categories are on X: the table's header row IS the
  category labelling, which is what Excel does. `specForMarkPaint` takes the labels and the title
  away from the mark painters in ONE place, so no painter grows its own copy of the condition —
  including a mark registered from outside this repo.
- It is **not** zero for `horizontalBar`, `scatter` and `bubble`, whose x labels are VALUES the
  header row does not repeat. `drawHorizontalAxes` paints them at `plotBottom + 4`, exactly where
  the table's header row would otherwise land — so the band is **ordered**, not merely summed.
- The x-axis title drops below the table, painted by `paintDataTableAxisTitle` from the same
  baseline helper the layout's estimate uses, so what is painted and what the hit test trusts
  cannot disagree.

Two more, found while building:

- **The columns never aligned with the bars.** The 30px legend-key column was the table's first
  COLUMN, pushing every category column 30px right of the band it labelled. The grid now spans the
  plot exactly, one equal slice per category, and the swatches moved into the left margin (where
  Excel keeps row headers). The alignment is exact, not approximate: a band scale's step is
  `W / (n * (1 + padding))` with an outer padding of half an inner one, so band centre `i` lands on
  `plotArea.x + (i + 0.5) * W / n` for **every** padding value. The test proves it against the
  chart's OWN hit geometry, not against a re-derived scale.
- **A radial mark has no x axis to hang a title on.** `spec.xAxis.title` survives a mark change, so
  a bar chart with an axis title switched to a pie still carries the string — and the table stage
  painted it below the table, in a band `computeRadialLayout` never reserves. `layoutHasXAxis`
  gates it on the layout family, the codebase's own division: every mark that reaches
  `computeRadialLayout` (pie, donut, radar, funnel, treemap, sunburst) is radial.

`adjustLayoutForPivotButtons` needed no change: it already calls `reflowChartElements`, which
re-derives the table's rect from the new plot area like every other element.

**One fact, one constant.** The x-axis title's drop from the bottom of whatever it hangs under
existed as five literals — `30` and `16` in markerPainter, `16` again for the data table, and a
hand-copied `(showLabels ? 30 : 16)` in **both** `drawCartesianAxes` (what is painted) and
`computeCartesianElementRects` (what the hit test trusts). A drift between those last two is a
title you can see and cannot click, which is why `points-elementRects.test.ts` diffs them. They now
all read `xAxisTitleBaselineY` in `chartPainterUtils` — which is also where it has to live, because
markerPainter already imports that module and the other direction would be a cycle.

### 6.12 One spelling for "where do this chart's error bars live?" (Wave R)

The verification pass over the three concurrent Wave-R changes found a TYPE ERROR, and behind it a
fact spelled five times.

`spec.markOptions` is a union of nineteen shapes and only three of them (`BarMarkOptions`,
`LineMarkOptions`, `ScatterMarkOptions`) declare an `errorBars` slot. So
`{ markOptions: { ...spec.markOptions, errorBars: next } }` — the obvious literal — spreads the
union and produces one illegal arm per shape that has no such property. The Delete path wrote that
literal and did not compile. Two other places wrote it too: the Format pane's `ErrorBarSections`,
and the Design tab, which got away with it behind two `as any` casts. Meanwhile
`chartDispatch` gated the PAINT on its own private `["bar","horizontalBar","line","scatter"]` array
and the Design tab decided whether to show the section at all with its own
`spec.mark === "bar" || ...` chain.

Five spellings of one fact, and the failure they invite is specific: **give `area` error bars and
the reader could read them, write them and see the section offered — and nothing would ever draw
them**, because the dispatcher's private array was not updated. A setting accepted, stored and
ignored.

The fact now lives once, in `rendering/errorBarPainter.ts` beside the painter that draws them:
`ERROR_BAR_MARKS` → `markSupportsErrorBars(mark)`, the reader `getErrorBarOptions(spec)` and the
writer `withErrorBarOptions(spec, next)`, which returns `null` for a mark with no slot — *a caller
that cannot read the options must not be able to write them either*. All four callers go through it.
`rendering/__tests__/errorBarOptionsOneSpelling.test.ts` pins the collapse three ways: reader and
writer agree mark by mark over the whole registry; `dispatchPaint` draws bars for exactly the marks
that can store them and none for the rest **even when a spec carries the field anyway**; and a
source-reading guard asserts the hand-spread appears in exactly one non-test file.

### 6.13 Wave V — the owner's two reports, and what verifying them turned up

The owner tested the shipped waves and filed two things. Both are real, both are fixed, and both
are in the ledger (**BUG-0126**, **BUG-0127**). A three-lens review over the same files raised seven
more candidates; **six survived and one was refuted**, and the live journey's four unfixed
observations were folded in with them.

**"I cannot select a colour for the entire series after colouring one point." (BUG-0126)**
Two causes, and each hides the other.

- **The ladder only descends.** `advanceSelection` (`handlers/selectionHandler.ts:363`) has no arm
  from a data point back to its OWN series: at `level: "dataPoint"`, a click on a datum of the same
  series selects THAT datum and a click on another series selects that other series. Every click
  inside the series keeps the reader on a point, so the pane keeps showing the Data Point sections
  and "Series fill" is never on screen. The routes out were Escape (advertised nowhere), a trip to
  the chart's outer margin and back, or selecting a different series first. **The click ladder is
  unchanged** — it is Excel's — and the pane grows a SECOND DOOR instead: a "Select the whole
  series &lsquo;Sales&rsquo;" row, offered only from the one rung that cannot reach its own parent,
  naming where it goes before it is pressed. That is the one-rung version of Excel's own answer,
  the element picker at the top of its Format pane.
- **On ten marks the control was a lie anyway.** The refusal that OB-1 added was written as
  `mark === "pie" || mark === "donut"`. Eight more built-in marks — histogram, pareto, boxPlot,
  funnel, treemap, sunburst, waterfall, stock — resolve their fill from the palette (by CATEGORY)
  or from their own semantic colours, and never read `data.series[i].color`, which is the only
  channel `spec.seriesColors` has to a pixel. On a histogram the swatch was live, the write landed,
  `applySeriesColorOverrides` copied it onto the parsed data, the document was dirtied, and
  `getSeriesColor(spec.palette, 0, null)` ignored it. `markReadsSeriesColor`
  (`lib/chartDataReader.ts`) is now the one question, and `rendering/__tests__/seriesColorCoverage.test.ts`
  **paints every built-in mark with and without a manual series colour** and asserts the refusal
  list is exactly the set whose call stream does not move — in both directions, so a painter that
  starts or stops reading it fails the build. The pane's refusal is a sentence per family that says
  where the colour comes from and what to do instead, not "not supported".

**"The data table overlaps the x-axis labels." (BUG-0127)** That is OB-2, §6.11, which landed
before the owner tested. Verifying it found the same defect shape still standing in three places:

- **The title's drop was a pixel literal against two writable fonts.** §6.11 ends "one fact, one
  constant" — and the constant was `30` with tick labels, `16` without. The band above it is
  `theme.labelFontSize + 8` and the title's own box is `theme.axisTitleFontSize` tall, and the
  Format pane commits BOTH (`labelFontSize` on the X axis, `axisTitleFontSize` on the axis title).
  Set Label size = 24 and the labels occupy `plotBottom+4 .. +28` while the title box is
  `plotBottom+18 .. +30`: painted straight through them. Set a 20px title under a data table and
  its box starts at `tableBottom + 16 - 20`, i.e. four pixels INSIDE the table's last row — and
  `computeCartesianElementRects` records that overlapping box as the hit rect. The drop is now
  DERIVED: `xAxisTitleBaselineY(box, bandAbove, theme)` = whatever is above + 4 + the title's own
  font size, and `xLabelBandHeight(spec, labels, theme)` is the one formula for the band, taking the
  label STRINGS because the six painters that draw their own axes have a tick list and no
  `ParsedChartData`. Rotated labels now push the title down too, which the literal never did.
  `drawHorizontalAxes`'s hand-copied `(showLabels ? 26 : 16)` — a *fourth* spelling, and 4px out of
  step with every other — is gone with it. `axisTitleBandFonts.test.ts` runs it over five label
  sizes and four title sizes.
- **Two marks do not plot the data they were given.** A histogram's datums are BINS and a Pareto's
  bars are SORTED, and both already had a resolve view for per-point overrides
  (`histogramResolveView`, `paretoResolveView`) — but the data TABLE was painted from the raw rows.
  For a histogram that is a size error: `computeHistogramLayout` reserved the band from the binned
  view (one "Frequency" series, 40px) while `paintDataTable` sized the grid from three source series
  (72px), so the grid overran onto the x-axis title, whose own baseline is measured from the REAL
  table's bottom edge and therefore lands off the canvas. For a Pareto it is a LABELLING error, and
  a worse one: `specForMarkPaint` suppresses the tick labels that carried the sorted order and the
  header row printed `data.categories` in SOURCE order, so the tallest bar was labelled with the
  first source category. Before OB-2 both were drawn and the correct one was at least visible; the
  fix had removed the correct one and kept the wrong one. `chartDataTableView(spec, data)`
  (`lib/dataTableView.ts`) is the sibling of `datumAddress` and answers the same question for the
  table; `computeCartesianLayout` takes the view as an explicit `tableData` parameter so the band
  reserved and the grid painted are measured from one thing.
- **The histogram's bin labels came back.** With the table on, the header row IS the bin labelling —
  which is what the suppression was for — so the reader gets one correct set of labels instead of
  none.

**Four more the review confirmed, away from the two reports:**

- **A refused write left the live preview's restore token pointing at the refused spec.**
  `rollbackToPersisted` (`lib/chartStore.ts`) put the chart back to the last confirmed version and
  the modal said "Nothing was written to the workbook, so what you see now matches what is stored" —
  while `activePreview.original` still held the edit the backend had just refused. The next
  mouse-out spent that token and painted the refused edit back; the next real edit deep-merged onto
  it and persisted it. The token is now dropped BEFORE the rollback, because it cannot be spent and
  must not be kept. §6.8's exit paths were all about the preview ENDING cleanly; this is the case
  where the thing it would restore TO has been withdrawn underneath it.
- **`emitAppEvent` is not a hook you can flush from.** The BEFORE_SAVE listener added in the last
  wave does not guarantee anything: `emitAppEvent` is a synchronous `dispatchEvent` that does not
  await its listeners, and `flushDirtyCharts` awaits each `update_chart` in turn. Nudge two charts
  inside one 300 ms window — aligning two charts is the ordinary way to do that — press Ctrl+S, and
  the recorded call order is `["update_chart", "save_file", "update_chart"]`. The file on disk holds
  chart A's edit and chart B's OLD spec while the UI reports a clean save. `registerLifecycleGuard`
  is the one hook both paths AWAIT: `checkLifecycleGuards('save')` runs before `save_file`
  (`app/src/core/lib/file-api.ts`) and `checkLifecycleGuards('close')` runs before `isFileModified()`
  (`app/src/shell/Layout.tsx`), which is the read that decides whether the close prompt appears at
  all. It is a VETO registry, so the guard always returns `null`: **charts never cancel a save, they
  insist on being in it.** `chartSaveFlushOrdering.test.ts` proves the ordering with the old
  fire-and-forget shape as its negative control.
- **An error bar that runs off the scale recorded a rect above the chart.** The painter clips to the
  plot area; the recorded rect did not, so a `+25%` extent on a value that IS the scale maximum
  carried a negative `y`. A click aimed at it lands above the chart's own rectangle — which is a
  click on the GRID, which deselects the chart. The rect now intersects the plot, and a bar with no
  painted pixels inside it records nothing at all.
- **An "above" data label on the tallest bar was clamped inside the bar.** `drawBarLabels` placed it
  at `rect.y - 4` and then clamped to `plotArea.y + fontSize`, which is inside a bar that reaches
  the top of the scale — and a datum beats furniture in the hit order, so that label can never be
  selected. Excel never puts an outside-end label inside the column. The clamp for "above" is now
  the CANVAS, not the plot.

**And one the review got wrong.** It reported that an overridden area/line/radar datum gets a marker
but paints it in the series colour, because `fill: style.markerFill ?? color` "never reads
`style.fill`, where `override.color` landed". **Refuted.** `resolveDatumStyle` already ends
`markerFill: markerFill ?? (fill === "" ? null : fill)` (`lib/dataPointOverrides.ts`), so
`style.markerFill` IS the resolved fill whenever neither side sets a marker fill of its own; the
`?? color` arm is reachable only when the resolved fill is the empty string, which cannot happen
where the base fill is the series colour. `dataPointOverrideCoverage.test.ts` has asserted the
override colour reaches the canvas for all eighteen built-ins since Wave B, area and radar included,
and it is green. The scatter/bubble spelling `style.markerFill ?? style.fill` is redundant, not
different.

**Two UI-geometry follow-ups from the live journey.** The chart context menu clamped its `top` from
`40 + rows * 26`; over a data table the estimate came up short and the last row — always
"Format &lt;element&gt;..." — rendered below the viewport, visible, enabled and unclickable
(Playwright: "element is visible, enabled and stable", then "element is outside of the viewport",
for thirty seconds). It now measures its own box in a layout effect, before paint, and the estimate
is only where the first layout lands. **The live colour preview is CLOSED (2026-09-22), and the
product was never at fault** — the preview paints in ~84 ms and the E2E sampler was cancelling it
before the first measurement. §6.14 below has the trace and the probe.

### 6.14 The instrument that cancelled what it measured (2026-09-22)

The live colour preview was filed as a product defect on the strength of four identical journey
runs: the store held the previewed override immediately, **no pixel on the chart changed within
three seconds**, and the preview then ended by itself with the pointer never moving. Two facts and
no cause, which is why the round that found them filed it rather than guessing. It is closed here
with **no product change at all** — both facts had one cause, and the cause was in the harness.

**Instrumented, not guessed.** A ring buffer on `window`, written from a stack-traced hook in
`restoreChartSpecPreview` / `endChartSpecPreview` and from spec-identity markers at every stage of
`renderChartAsync`, drained and printed by the SPEC's own `console.log` — the journey fixture keeps
only a short console tail for crash attribution, so evidence has to be pulled out of the page, not
logged from inside it. The first run answered the first fact outright (ms from the pointer arriving):

```
   0.0  PANE   swatch onMouseEnter #636363
   0.1  STORE  previewChartSpec ... overrides=[{...,"color":"#636363"}]
   1.1  RENDER sync SCHEDULES v3 cachedV=2
  81.7  RENDER async RESOLVED v3 nowV3 resolvedOverrides=[{...,"color":"#636363"}]
  83.1  RENDER async PAINTED  v3 overrides=[{...,"color":"#636363"}]
  83.9  RENDER sync DRAWS     rasterV3
 560.0  PANE   swatch onMouseLeave #636363
```

**The preview paints in ~84 ms, every time**, carrying the override, and the previewed raster is
composited onto the grid overlay. So "never painted" was false, and the two filed facts are one
fact: the preview had already ENDED before the poll took its first sample.

**Who ends it.** The `mouseleave` is real and it is the swatch's own handler. What it carries is
not:

```
pt=(305,541)  rel=<not an element>  btn=(1237.0,432.5,16.0x16.0)  efp=CANVAS
```

`pt` is the pointer position the event reports, and (305,541) is **the origin of the screenshot
clip the test was about to take** — nowhere near the swatch the pointer is sitting on. The button's
own `getBoundingClientRect()` is unchanged at `(1237.0,432.5,16x16)` before and after, and so is the
strip's. Nothing in the page moved. The VIEWPORT moved.

**The four-way probe.** One pointer position, held for all four, re-hovered between them:

| what happened while the pointer sat on the swatch | `paneIsPreviewing` before → after |
|---|---|
| nothing at all, for 3 s | true → **true** |
| `page.screenshot()` — full viewport | true → **true** |
| `page.screenshot({ clip })` | true → **FALSE** |
| an in-page canvas readback | true → **true** |

`page.screenshot({ clip })` is not a passive read: to capture a sub-rectangle Chromium is asked to
put that rectangle on screen, the pointer's hit-test moves with the viewport, and the hovered
control receives a `mouseleave` it never earned — with no matching `mouseenter` when the override
is lifted, so the control stays dead until the pointer really moves. `pixels()`, the one helper all
36 pixel samples in this journey go through, was therefore ending the hover before it could sample
it. The earlier "intermittent, 2 runs in 4" reading was the same mechanism seen from the other
side: the capture sometimes beat the product's own restore repaint, so the frame it returned still
had the preview in it.

**The fix is in the instrument.** `app/e2e/viewportSample.ts` captures UNCLIPPED — proved harmless
by the probe above — and crops afterwards, inside the page, against the decoded bitmap. The crop
rect is computed in Node by `deviceCropRect`, a pure function with its own tests, rather than by
arithmetic buried in a string only a live browser can execute. It scales from the ROUNDED EDGES
rather than scaling the width, because `round(x·dpr) + round(w·dpr)` drifts from
`round((x+w)·dpr)` by a pixel at a half-pixel origin, and a one-pixel drift between two samples
makes `diffCount` throw "the clip moved" about a chart that never moved. The returned array is the
same shape the clipped call produced (device pixels, RGBA), so every threshold in the file still
means what it meant.

**The assertion was NOT weakened.** The same positive control now reads
`preview paint latency: 781ms (diff 576)` — 576 of 576 sampled pixels changed — and
`paneIsPreviewing=true` after the poll where it used to read false. (781 ms is when the FIRST
SAMPLE is taken: a 400 ms settle, a state read and one full-viewport capture. The product's own
paint is the 84 ms above.) Journey file: **15 passed, 0 failed.**

**The guard.** `app/e2e/__tests__/viewportSample.test.ts` captures through a page double that
records what it was handed and asserts the ABSENCE — no `clip` reaches `page.screenshot`. "Does not
pass an option" is invisible to a type checker and to every green run on a page with no live hover,
which is exactly why it needs a test rather than a comment. Sabotage: put the `clip` back; that one
test goes red (`expected false to be true`) and the other six stay green.

**The lesson, generalised.** A sampler that perturbs — or merely outruns — the state it samples will
report that as the product's behaviour, with complete confidence and a reproducible trace. A pixel
test that flakes around a hover should suspect the instrument before the product.

### 6.14a What §6.14 said next, and what actually happened (2026-09-22, same day)

This section originally ended by saying the other pixel specs were **"deliberately left on the
clipped path, because a full-viewport capture is several times the bytes."** Both halves of that are
now superseded, and the correction is recorded rather than quietly edited away, because the reasoning
is the interesting part.

**The cost was measured instead of estimated.** It is real — x770 the bytes on a small patch, x3.0 on
a large one — and it is **not the deciding quantity**: +4.5 to +5.9 s across all nine specs per run,
against specs that budget 240–280 s each and spend it in `waitForTimeout`. Nothing is written to disk.

**The mechanism above is NOT settled.** Re-probed the same day on the same machine against two
independent hover state machines across seven clip geometries, with capture-phase listeners on every
mouse and pointer event: **not one event fired**, and `visualViewport` and `elementFromPoint` never
moved. What did reproduce is a ~130 ms timing gap between the clipped and unclipped paths against a
product that paints in ~84 ms — which fits "intermittent, then four consecutive failures" just as
well. The unclipped path is correct under either account, so the migration proceeded; but **Account A
above should not be repeated as fact.**

**The nine migrated anyway**, for a reason that is not the hazard: ten copies of one twenty-line
`diffCount` at one threshold, with the refusal already spelled four different ways, is how a number
drifts in nine places and nobody notices. Only `correctness-cluster` was genuinely exposed (its test
3d samples a rectangle the pointer is parked inside); `insight-overlays` and `insight-overlays-pivot`
sample with the pointer over the measured rectangle after a menu click; the other six never hover.

**The general statement now lives in `docs/design/e2e-pixel-sampling.md`** — this is a harness fact,
not a chart fact — together with the repo-wide guard
(`app/e2e/__tests__/noClippedCapture.test.ts`, which parses every file under `app/e2e` at test time,
covers `toHaveScreenshot({ clip })` as well, and carries a reason-checked allowlist for the three
legitimate clipped captures).

---

## 7. References

- `docs/design/insight-overlays.md` §5h — how click ownership between an overlay and the selection
  ladder was settled. The rule adopted here is the same: **a datum beats furniture that overlaps
  it, and the ladder keeps the click.**
- `app/src/core/lib/overlayTextEditor.ts` — the three blur traps, with the reason each bound exists;
  `app/src/api/overlayTextEditor.ts` is the seam over it.
- `app/src/api/gridOverlays.ts` — the overlay registration contract, including `onDoubleClick`.
- `docs/design/animation-simulation.md` — the transient-write pattern. §6.8 here is its SECOND
  instance and its first one with no backend in it, so `DocumentEffect::transient` is not involved;
  that document now says so in its own "Added 2026-09-21" note.
- `docs/design/open-items.md` §2.1 — what this work left open. Wave R closed all of it but
  `gridlines`: the four furniture ids are selectable (§5 CI-12), both per-point reachability gaps
  are closed (§6.7), `IKeybindingsAPI.register` carries `when` and the per-extension wrapper
  forwards it, and the Name Box paints its address on the FIRST render.
- `tests/regression/bug-ledger.json` — **BUG-0123** (the `axis.reverse` no-op, Wave D),
  **BUG-0124** (Delete twice on a cleared title deleted the chart, §6.2), **BUG-0125** (Delete with
  a Format-pane button focused deleted the chart, §6.2), **BUG-0126** (the series colour was
  unreachable after colouring one point, and a lie on ten marks, §6.13), **BUG-0127** (the data
  table overlapped the category axis labels, §6.11 and §6.13).
