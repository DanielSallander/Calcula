# Dialog layout — `@api/dialogLayout`

**Status:** shipped 2026-09-21. Primitives live in `app/src/api/dialogLayout.tsx`, pinned by
`app/src/api/__tests__/dialogLayout.test.tsx`. First adopter: the Insert Chart dialog
(`app/extensions/Charts/components/CreateChartDialog.tsx`), pinned by
`app/extensions/Charts/__tests__/createChartDialogLayout.test.tsx`.

## The defect this exists for

Calcula has no shell-owned dialog frame — ~110 dialogs each hand-roll their own chrome
(`docs`/memory: [dialog-window-hook]). They therefore hand-roll their **body layout** too, and the
default a developer reaches for is a fixed narrow width with every field group stacked vertically.
When the content outgrows the box, the box does not get wider — it gets a scrollbar.

Insert Chart was the worst case and the one the owner reported:

```
width: 620px;  max-height: 600px;
Header / TabBar / TabContent { overflow-y: auto } / Footer
                              └─ settings, THEN the 220px live preview, THEN the errors
```

The preview is the entire reason the dialog exists, and it was parked below the settings inside the
scroller. In design-query mode — a radio group, a connection picker, a 220px Monaco editor, a
two-line hint and a button — the preview started below the fold and never came back. **You could not
see the chart while you were changing the chart.**

The errors had the same shape of problem: the Insert button refuses at the bottom of the dialog and
the reason rendered at the bottom of a scrolled column.

## The cure, and why it is a shared module

The cure is horizontal space, and it is the same cure every time: split the body into a scrolling
settings pane and a pinned companion pane, and let field groups flow into as many columns as the
width allows. That is three flexbox facts and one grid template that are easy to get subtly wrong
(`minHeight: 0` on every flex ancestor, or the pane refuses to shrink and the footer walks off the
screen; `auto-fit` + `minmax`, or the columns cannot collapse when the user drags the dialog narrow).
Copying them into each of 110 dialogs is how they drift.

```tsx
const split = useDialogSplit({ initial: 0.6, min: 0.35, max: 0.78 });

<DialogBody ref={split.containerRef} stacked={isNarrow}>
  <DialogPane scroll style={split.primaryStyle}>
    <DialogFieldGrid>…</DialogFieldGrid>
  </DialogPane>
  {split.splitter}
  <DialogSidePane title="Preview" flexible style={split.secondaryStyle}>
    <LivePreview />
  </DialogSidePane>
</DialogBody>
```

`@api/layout` is NOT this. That module is orientation-aware primitives for *panel and ribbon*
content, reading `SurfaceLayoutContext`. Dialogs have no such context and no band/sidebar duality;
they have a box the user can drag to any size. `@api/dialogLayout` is the dialog-side counterpart to
`@api/dialogWindow` — one owns where the box is, the other owns what is inside it.

Both are plain inline styles, matching `@api/layout`'s primitives. **`@api` has no
styled-components dependency and must not grow one** — these drop into a styled-components dialog,
an emotion one, or an inline-styled one unchanged, because they only read the CSS custom properties
(`--panel-bg`, `--border-default`, `--text-secondary`, `--accent-primary`) that every dialog already
reads.

## What the primitives are

| Primitive | What it owns |
|---|---|
| `DialogBody` | The row between the tab bar and the footer. `forwardRef` so `useDialogSplit` can measure it. Carries `minHeight: 0` — the reason a child scrolls instead of the dialog growing. |
| `DialogPane` | A content column. `scroll` (default true) makes it the ONLY thing that scrolls. |
| `DialogSidePane` | The pinned companion — preview, summary, result. A **sibling** of the scrolling pane, never a child. |
| `DialogFieldGrid` / `DialogFieldSpan` | `auto-fit` + `minmax` columns; `DialogFieldSpan` takes every column for a wide control. |
| `DialogSection`, `DialogPaneTitle` | The small uppercase caption these dialogs already use. |
| `useDialogSplit` | A draggable, **keyboard-reachable** (`role="separator"`, arrows, Shift+arrow, Home) divider. Generalised from the copy the Chart Spec tab already had. |
| `dialogWidth` / `dialogHeight` | `min(Npx, Mvw)` so a preferred size never overflows a small screen. |

## The responsive contract

Nothing here uses a media query. Two mechanisms carry the whole thing:

1. **`auto-fit` + `minmax`** — a column appears when there is room and folds away when there is not.
   A fixed `repeat(2, 1fr)` is the bug: it cannot collapse, so dragging the dialog narrow clips the
   second column instead of folding it. The test asserts the template is not `repeat(<digit>`.
2. **A measured body width** — Insert Chart observes its own `DialogBody` and stacks the panes below
   820px, where a side-by-side preview would leave neither pane usable. Stacked, the preview keeps a
   fixed 220px slice at the bottom; it still never scrolls away.

## Insert Chart, after

- `width: min(1060px, 95vw); height: min(660px, 88vh)`. The user's own drag-resize
  (`useDialogWindow`) still overrides both, and `win.reset()` + `split.reset()` restore the defaults
  on reopen.
- Body = settings pane | divider | preview pane. All three tabs share the one pinned preview, so
  **switching tabs no longer re-mounts the canvas**.
- Data tab: `DesignGrid` (the same `auto-fit` grid the Design tab already used, min lowered
  220px). Range mode puts *what the data is* in the left column (range, orientation, headers,
  category axis) and *what gets plotted* in the right (the series list, which is the one control
  that grows with the data). The data-source radio spans both columns because it decides which
  fields below exist.
- Spec tab: the Monaco editor fills the pane (`flex: 1`) instead of holding a fixed 300px.
- Errors render in a full-width `ErrorBar` directly above the footer — beside the button that
  refused.

### Two defects the wider layout exposed

- **`ChartPreview` never repainted on resize.** Its effect depended only on `[spec, data]`, but the
  canvas backing store is sized from `clientWidth`. That was latent while the preview was a fixed
  220px box; the moment it fills a resizable pane, a stale bitmap gets stretched. Fixed with a
  `ResizeObserver`.
- **The empty-state message lied.** `data ? "No numeric data to chart" : "Select a data range to
  preview"` — but unchecking every series also clears `previewData`, so a dialog with a perfectly
  good range told you to select a range. Harmless when the message was below the fold; in front of
  the user the whole time, it is a message that actively misdirects. `ChartPreview` now takes an
  `emptyMessage` and the dialog says which of the four reasons applies.

## A second bug class the survey turned up: the box that scrolls itself

Several dialogs put `overflow: auto` (or `overflow-y: auto`) on the **dialog box** rather than on
its body, with the header and footer as ordinary children inside it. The box then scrolls as a
whole: the title bar — which in a `useDialogWindow` dialog is also the DRAG HANDLE — and the OK /
Apply / Save button slide out of view as content grows. It is the same defect four times over, and
the cure is three lines:

```
box:   display: flex; flex-direction: column; overflow: hidden;   /* clips */
body:  flex: 1; min-height: 0; overflow-y: auto;                  /* the only scroller */
header/footer: flex-shrink: 0;
```

`NewFunctionDialog` had the sharper version: no `max-height` on the box at all, so adding enough
parameters grew it straight past the bottom of the screen, taking the OK button with it.

## Dialogs changed in the first pass (2026-09-21)

| Dialog | Was | Now |
|---|---|---|
| **Insert Chart** | 620px column, preview below the fold | `min(1060px, 95vw)`, settings \| preview with a draggable divider |
| **Format Axis** (`Charts`) | 380px, **box scrolled** — header and Apply scrolled away | flex column that clips; 4 sections in 2 balanced columns at `min(760px, 94vw)` |
| **New Model Connection** (`BusinessIntelligence`) | 420px, **box scrolled** | flex column that clips; header/footer pinned; 480px (no widening — the content does not want it) |
| **Calculated Measures** (`CubeFormulas`) | 620px, **box scrolled**, two prose paragraphs eating the width above the editor | flex column that clips; measure editor left, syntax reference pinned right at `min(980px, 94vw)` |
| **Page Setup** (`Print`) | 540px, ~814px of content in an 85vh box | Page+Margins \| Sheet, Header/Footer spanning, at `min(780px, 94vw)` — fits with no scroll |
| **Customize Home Tab** (`BuiltIn`) | 600px, arrangement then palette stacked | arrangement \| palette, each scrolling on its own, at `min(1000px, 95vw)` |
| **New Function** (`DefinedNames`) | 560px, **no max-height at all**, 200px code editor | signature \| editor at `min(940px, 94vw)`; the editor fills the pane (`automaticLayout` already on) |

Insert Chart and the `@api` primitives carry unit tests. The other six are layout-only changes
verified by the existing suites (112,936 green) plus screenshots of each dialog in the running app
— there are no new tests for them.

## The second pass (2026-09-21): the remaining twenty

All of them, one agent per dialog working from its own adversarially-verified plan, then a
three-lens review (behaviour / layout / integration) over every changed file with each finding
put to a separate refuter. 25 findings survived refutation, deduplicating to 15 defects. Three of
those were CORRECTNESS bugs the restructuring introduced, and none of them were layout:

- **Text to Columns** built the destination cell's ROW number out of the COLUMN index, so step 3
  named the wrong cell whenever `startRow !== startCol`. `Step3Format` was never passed
  `sourceRow` at all.
- **Custom Functions** normalised the Parameters field on every keystroke
  (`split(",").map(trim).filter(Boolean)`) while the input was controlled off the result — so a
  trailing comma could never survive the round trip and a second parameter could not be typed.
  Normalisation moved to the point of consumption; the `join`/`split` pair is now an exact inverse.
- **Add Filter** hand-rolled a first-dot split of the BI field key for its new per-table headings.
  The repo forbids that: a schema-qualified table like `BI.dim_customer` mis-attributes. It now
  goes through `splitBiFieldKey` with the model's own table names, which the dialog was already
  loading and discarding.

### Two defects that no unit test could have caught

Both are invisible in jsdom, which has no layout and no `ResizeObserver`:

1. **A width that was a function of its own measurement.** `PublishDialog` read
   `width: twoPane ? 1040 : 620`, `twoPane` read `!isNarrowBody`, and `isNarrowBody` came from a
   ResizeObserver on the body. The dialog opens in `loading` mode at 620, the mount effect
   measures ~618, `isNarrowBody` latches true — and when the awaited status resolves to `push` the
   width expression still reads 620. **620 is an absorbing state**: the two-pane layout was
   unreachable on open, and the only way to it was to drag the dialog past 820px by hand. In jsdom
   `bodyWidth` stays 0, so `twoPane` comes out true and a naive test passes on a broken dialog.
   The width is now keyed on `mode`, which no measurement can change, so `isNarrowBody` is a pure
   CONSUMER of the width — it can only collapse a dialog that is already wide, and collapsing
   terminates. Pinned as a SHAPE by `extensions/Distribution/__tests__/publishDialogWidth.test.ts`.

2. **Moving a dialog pinned its size.** `useDialogWindow` materialised the whole rect on the first
   interaction of *either* kind, so a drag-to-move froze the width — and every dialog whose CSS
   width depends on its mode silently lost the wider layout (Publish 620→1040, Subscribe 560→900,
   Refresh Preview 520→940). Position and size are now owned separately: a move emits position
   only and leaves the size to the CSS; a resize takes both, stickily. The exception is a box the
   hook has to pop OUT of a flex backdrop — it was sized by the flex container, so `position:
   fixed` with no width would shrink it to fit, and those keep the old behaviour.
   `src/api/__tests__/dialogWindowSizeOwnership.test.tsx`, two sabotages.

### The rest

`SlicerSettingsDialog`'s JSON mode gave Monaco zero height (`flex: 1` divides FREE space, and an
auto-height box has none — the branch needs a DEFINITE height, not a cap). `CustomFunctionsDialog`
let its editor row shrink under the editor's own 200px floor, so Monaco painted over the
Description field instead of the pane scrolling. `ScenarioManagerDialog`'s inputs lacked
`minWidth: 0` so they overflowed their grid tracks, and Escape in the Add/Edit sub-form closed the
whole dialog rather than returning to the list (fixed with `dismissOnEscape: false` — the dialog's
own handler cannot win that race, because its effect re-subscribes on mode change and so registers
*after* the shell's). `RecordedMacroDialog`'s "Update Module" saved the edit and then visibly
reverted the box to the regenerated source, and its gate disabled the very button the
module-runtime banner told the user to press. `RefreshPreviewDialog`'s apply-failure message was
the last child of a scrolling pane. `FillTab`'s preview canvas kept a hard-coded 460px bitmap
under a `width: 100%` box that is now ~645px — the one element whose job is to show the fill was
showing it 40% too wide.

**Everything from the survey is now done.** Verification: `npm run check-types`,
`lint:boundaries` and `check:line-endings` clean; **112,962 vitest green across 1,091 files**
(up 26 tests and 5 files from the first pass); the live E2E DOM contract that
`vba-wiring-batch.spec.ts` depends on re-checked in a real browser, including the exact
`fill(first)` → `fill(nth(1))` sequence Playwright performs; and every reachable dialog opened and
screenshotted in the running app.

## When NOT to use this

A dialog with three fields — a rename, a password prompt, a confirm — is **correct** as a narrow
column, and widening it makes it worse. The test is whether content plausibly exceeds the box, or
whether a growing list is crowding fixed fields. A survey of all ~110 dialogs found most are already
right: Format Cells is a category-list/detail split, CSV Import already rows its three selects,
Sparklines and Data Validation are properly small. Insert Chart was the outlier because it carries
a live preview.
