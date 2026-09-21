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
| CI-2 | Every built-in mark honours `dataPointOverrides` | **done** — Wave B, for every `builtin: true` mark (18 of them today; the test derives the list from the registry rather than hard-coding it), pinned by `rendering/__tests__/dataPointOverrideCoverage.test.ts` (which also asserts a CUSTOM mark is excluded, `:273`). Two reachability gaps remain and are open items, not coverage gaps — see §6.7 |
| CI-7 | Element hit-testing + honest selection taxonomy | **done** — Wave C. `CHART_ELEMENT_IDS` / `ChartElementId` (`types.ts:1644`), `ChartHitResult = {element?, seriesIndex?, pointIndex?}` with pointIndex ABSENT = whole series (`types.ts:1670`). `rendering/__tests__/elementHitTest-drift.test.ts` RUNS the hit-tester and asserts declared==produced in BOTH directions (`:140`, `:150`) |
| CI-8 | In-place editing of chart title and axis titles | **done** — Wave C (`handlers/chartTextEditing.ts`) |
| CI-3 | Element-aware context menus | **done** — Wave C. The right-click also MOVES the selection and records its subject — see §6.1 |
| CI-9 | Retargeting Format pane | **done** — Wave C. `ChartFormatPane`, contributed by a manifest that declares `contextKeys: ["chart"]` (`app/extensions/Charts/manifest.ts:83`); it retargets on selection change rather than remounting, and its body is keyed on the SUBJECT so a field's local draft reseeds (`components/ChartFormatPane.tsx:1885`) |
| CI-9b | Current-selection readout in the Name Box | **done** — Wave C. `@api/chartSelection` publishes the selection plus a `displayName` (`chartSelectionDisplayName`, `app/src/api/chartSelection.ts:183`); `NameBox.tsx:395` prefers the chart label over the cell address |
| CI-10 | Keyboard element navigation, Ctrl+1, Esc steps up, Delete furniture | **done** — Wave D. `buildChartNavGroups` / `navigateChartSelection` / `escapeLevelUp` (`handlers/selectionHandler.ts`); three capture-phase listeners in `index.ts` (`handleDeleteKey`, `handleOverlayStepKey`, `handleChartNavKey`) all read `chartOwnsKeystroke`. See §6.2-§6.4 |
| CI-11 | Reset to Match Style, scoped to the selection | **done** — Wave D. `resetToMatchStyleScopePatch` (`components/ChartContextMenu.tsx`) is the one scope→patch function, read by that file's own menu item and by the pane's `ResetToMatchStyleRow` (`components/ChartFormatPane.tsx:1729`) |
| CI-12 | Legend entries, gridlines, trendlines, error bars, plot area selectable | **partial** — Wave D. Legend, legend ENTRY and plot area are fully selectable, painted and formattable (`CHART_SELECTABLE_ELEMENT_IDS`, `rendering/selectionHighlight.ts:247`). `trendline` / `errorBars` / `dataLabel` / `dataTable` are hit-testable and named but the ladder collapses them to chart level; `gridlines` is deliberately not in the taxonomy at all. Both are open items — §6.5 and §6.6 |
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
  the click lands on nothing.
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
  (`rendering/chartPainterUtils.ts:461`) is called by `chartDispatch` (`:451`), `chartRenderer`
  (`:1524`), the combo painter (`:76`) and the Pareto painter — every stage that mutates
  `margin` / `plotArea` after layout. The rule and its direction (reflow BEFORE painting, never
  after, or the measured truth the painters wrote back is discarded) is kept on the type itself
  (`types.ts:1875-1884`).
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
`drawHorizontalGridLines` / `drawVerticalGridLines` compute their ticks inside the call and are
invoked by twelve painters that never hand them a layout to write back to.

A `gridlines` member would therefore be **dead on arrival** — a declared element with no producer,
which is the exact defect `CHART_ELEMENT_IDS` exists to prevent (`"title"` and `"legend"` sat in the
previous union for a year with zero producers anywhere in the repository). And it would not sit
quietly: `elementHitTest-drift.test.ts:140` RUNS the hit-tester and fails on a declared element that
nothing produces. It belongs with the change that threads a layout into those two painters and
records the tick geometry. Reasoning kept at `types.ts:1633-1642`.

### 6.7 What CI-2 does not reach

Every `builtin: true` mark honours `dataPointOverrides`, and that is genuinely tested. Two
reachability gaps remain, both open items rather than coverage holes:

- **A DEFAULT area chart has no per-point route.** `showMarkers` defaults to `false`
  (`rendering/areaChartPainter.ts:62`) and the override is resolved only inside
  `if (showMarkers)` (`:291-308`); the area polygon itself is filled from the SERIES colour
  (`:236-239`). So an override is honoured — on a chart the reader has to switch markers on first.
- **A sandboxed / custom mark cannot honour one at all.** `registerChartMark` is public and
  `rendering/sandboxMarkShim.ts` blits an opaque worker `ImageBitmap` into the plot rect
  (`:97`); there is no per-datum call to intercept. The coverage test scopes itself to
  `meta.builtin === true` and asserts a custom mark is excluded, with the reason
  (`dataPointOverrideCoverage.test.ts:273`).

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
- `docs/design/open-items.md` §2.1 — what this work left open: the four furniture ids, `gridlines`,
  `IKeybindingsAPI.register`'s missing `when`, the two per-point-override reachability gaps, and the
  Name Box's empty first render.
- `tests/regression/bug-ledger.json` — **BUG-0123** (the `axis.reverse` no-op, Wave D),
  **BUG-0124** (Delete twice on a cleared title deleted the chart, §6.2), **BUG-0125** (Delete with
  a Format-pane button focused deleted the chart, §6.2).
