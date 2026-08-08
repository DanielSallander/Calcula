# Calcula E2E Test Plan

Playwright E2E suite for the Calcula spreadsheet application. Tests run against
the live Tauri app via WebView2 CDP (Chrome DevTools Protocol) — there is no
headless mode and no mock backend; every assertion is against the shipping
binary.

**Current status (2026-08-08):** 92 functional specs, 2 visual specs, 6
journeys, 3 scenarios, ~72 committed screenshot baselines.

**The functional suite is NOT green on HEAD: 495 passed / 34 failed / 11
skipped.** That is deliberate reporting, not an oversight — see
"The suite is not green, and the number overstates the damage" below before
quoting any figure from it.

---

## Read this first

Most of this document is about the ways a green E2E run can mean nothing. That
is where the value is. The suite has, at various points, shipped:

- a visual comparator so loose that **an entirely erased gridline scored zero
  differing pixels**;
- two screenshot helpers that **returned silently** when their selector matched
  nothing, so every call had been a no-op for months against an empty baseline
  directory;
- a pair of goldens named `...-collapsed` and `...-expanded` that were
  **byte-identical** — the pair asserted that collapsing and expanding a group
  produce the same picture;
- feature goldens photographing a 66-pixel indicator inside a 685,000-pixel
  frame, under a 200-pixel budget.

None of those failed. All of them passed, for years in one case. The rules
below each exist because one of them was found.

---

## Project split

`app/playwright.config.ts` defines six projects. The split is not organisational
tidiness — it is the only thing keeping specs that disturb the whole document
away from specs that share one.

| Project | Dir | What it is |
|---|---|---|
| `functional` | `e2e/tests` | The bulk. One long-lived app, ONE accumulating workbook shared by all 92 specs. `yarn e2e`. |
| `visual` | `e2e/visual` | Whole-frame regression goldens (`core-visual`, `workflow-visual`). 18 tests, 27 baselines. |
| `journey` | `e2e/journeys` | **New.** Specs that deliberately wipe or reopen the document — `new_file`, `open_file`, a frontend reload, a real window close. 300 s timeout. |
| `scenario` | `e2e/scenarios` | Real-user workflows with oracle checkpoints per phase (`*.scenario.ts`). |
| `invariant` | `e2e/tests/state-consistency.spec.ts` | Oracle checkpoints: digest + undo/redo round-trip + recalc + periodic save/reload. |
| `soak` | `e2e/soak` | Long random action walks with semantic oracles and in-spec trace minimization. Driven by `SOAK_*` env vars. |

**Why `journey` had to exist.** The functional specs share one workbook and
`resetGrid` clears only `A1:Z1000`, so every screenshot baseline in
`e2e/tests/__screenshots__/` encodes the residue of the specs that ran before
it. A spec that replaces the document therefore shifts unrelated goldens, and a
spec that closes the window ends the run. Keeping those in their own project
makes them explicit to invoke and harmless to `yarn e2e`. `image-ingress`,
`dirty-flag`, `dirty-flag-close`, `census-followon`, `correctness-cluster` and
`shapes-hometab` all live there for that reason.

### Running

```bash
cd app
yarn e2e                  # functional (auto-launches the app, tears it down)
yarn e2e:visual           # visual goldens
yarn e2e:journey          # document-replacing journeys
yarn e2e:scenario         # workflow scenarios
yarn e2e:invariant        # oracle checkpoints
yarn e2e:all              # every project
yarn e2e:manual           # connect to an already-running app (E2E_MANUAL=1)
yarn e2e:visual:update    # re-record visual goldens
yarn e2e:report           # HTML report from the last run
```

`E2E_MANUAL=1` skips `global-setup`'s `cargo tauri dev` launch and connects to
whatever is on CDP 9222. It is the right mode when you are controlling the app's
lifecycle yourself — which, per the operational rules below, you usually should
be.

---

## The visual comparator

Both `playwright.config.ts` (`expect.toHaveScreenshot`) and
`DEFAULT_SCREENSHOT_OPTIONS` in `e2e/helpers/screenshots.ts` carry the same
gates. They must stay in sync; the helper file holds the measurements.

```
maxDiffPixels:      200
maxDiffPixelRatio:  0.0005      # effective budget = min(200, 0.05% of image)
threshold:          0.02
```

**`threshold` is not a per-channel tolerance.** It is pixelmatch's YIQ
colour-distance gate: a pixel is counted as different only when its squared YIQ
distance exceeds `35215 * threshold²`. That makes it the single setting deciding
whether the suite can see the grid at all.

Measured on the default skin (re-measure if the skin changes):

| | |
|---|---|
| Gridline colour | `#f1f1f1` on white — ΔY 14 |
| Faintest hairline | `#f5f5f5` — ΔY 10 |
| pixelmatch stops seeing them above | threshold **0.053** / **0.038** |
| Erased gridline at the old threshold 0.2 | **0 differing pixels** |
| Same defect at 0.02 | 520 px (vertical) / 1193 px (horizontal) / 1042 px (1 px shift) |

So at 0.2 **no grid-geometry change could ever fail**, and a 40 px row-gutter
change passed the entire suite. 0.02 keeps roughly 2x margin on the faintest
line the renderer paints.

**The budget is the other half of the gate, and tightening only the threshold
would not have been enough.** The old `maxDiffPixelRatio: 0.005` allowed 3,425
pixels on a grid capture — six whole gridlines' worth. 200 sits at the geometric
mean of the measured noise ceiling and the smallest single-line defect (520 px).

**The noise floor is what makes the tightening cheap.** Over two cold runs of
all 76 captures the suite takes, **74 were bit-identical at threshold 0**. The
only non-deterministic thing in either suite is the marching-ants copy border in
the paste-special shots, at 77 px. There is no anti-aliasing tax to pay for
here; the old looseness bought nothing.

**Do not loosen these to make a shot pass.** A shot that cannot hold this gate
is capturing something non-deterministic. Fix the capture — `waitForVisualStability`
exists for transient overlays (the pivot progress indicator is drawn canvas
state with no DOM node to await), and `parkSelectionAwayFrom` exists for
selection chrome.

**Region captures have no separate gate, on purpose.** A
`REGION_SCREENSHOT_OPTIONS` override of `maxDiffPixelRatio: 0.001` was written
when the default was 0.005 (5x tighter, earned its place); against the new
0.0005 default the same override would LOOSEN small clips by 2x — precisely the
captures it existed to sharpen. It was removed rather than re-tuned. The
ratio-plus-cap default already scales: on a whole-grid shot the 200 px cap
binds; on a one-cell clip the ratio binds at 4 px.

---

## How a golden loses its teeth

Three distinct mechanisms, all found live, all of which produce a passing test
that proves nothing. Check for each one before adding a feature golden.

### 1. Scale — the feature is too small to blow the budget

A whole-grid shot is 1232x556 = **685k pixels**, where `maxDiffPixels: 200`
binds. A note-indicator triangle is **66 device pixels** — under a third of the
budget, in the best case where the triangle is the only thing that moved. Its
presence or absence *cannot* fail the assertion at any threshold.

**Fix: `takeGridRegionScreenshot`,** which clips to the cells that own the
chrome. Clipped to one cell the same triangle is 0.82% of the frame against a
4 px budget — a ~16x margin instead of a 0.3x one. Keep `padding` small (default
4 px); padding is dead pixels that dilute the assertion again. Use
`includeHeaders: true` for chrome that paints in the header margin — the
grouping outline bar is drawn at `x < rowHeaderWidth`, so a cell-only clip
frames everything EXCEPT the feature under test.

Rule of thumb: **whole-grid shots prove layout and data; they do not prove
chrome.**

### 2. The feature was never RENDERED

`grouping.spec.ts` had four goldens. Two of them —
`grouping-rows-collapsed.png` and `grouping-rows-expanded.png` — were
byte-identical (sha256 `1c8a474d…`).

The cause was not framing. Those tests drove the Rust commands (`group_rows`,
`collapse_row_group`) **directly via `invoke`**, and a backend-only outline
change has no effect on what is drawn: only the Grouping extension's store
pushes hidden rows/cols into grid state and sizes the outline bar. Measured
against the running app, `group_rows` changed **0 of 42k captured pixels**.

This is the general trap for any spec that reaches past the frontend: a Tauri
command that mutates backend state does not, by itself, tell the frontend
anything. The four goldens were deleted rather than re-recorded.

**What changed since.** The mutation IPC wrappers now announce
(`OUTLINE_CHANGED`, `HYPERLINKS_CHANGED`, `VALIDATIONS_CHANGED`,
`ANNOTATIONS_CHANGED`), so an out-of-band mutator can dispatch
`window.dispatchEvent(new CustomEvent("app:outline-changed"))` — or, better,
drive the seam the extension publishes:

```ts
const gs = await window.__calcImport(
  new URL("/src/api/groupingService.ts", document.baseURI).href);
await gs.requireGroupingController().groupRows(0, 2);
```

which resolves only once the grid, the outline bar and the backend agree, so no
arbitrary wait is needed.

**Corollary: some features correctly paint nothing.** `add_hyperlink` changes
zero pixels of its cell and always did — the blue-underlined look is cell
formatting the dialog applies separately. Its live oracle is the rendered
CURSOR (`pointer` over the linked cell, `cell` over its neighbour). A pixel
assertion there would fail forever against correct code. Establish what the
feature actually paints before writing a golden for it.

### 3. Selection chrome paints over the thing under test

The active-cell highlight covers the cell's top-right corner — exactly where
Review paints its annotation triangles. Probed live on an isolated cell carrying
a note:

```
note cell NOT selected -> 15 indicator px
note cell SELECTED     ->  0 indicator px
```

Every region spec reaches its capture via `navigateTo(topLeftCell)`, which
SELECTS that cell — so every single-cell feature golden was a picture of the
selection border with the feature erased underneath it. That is how goldens
named `...-cell-with-indicator` came to hold one stray pixel of indicator
colour.

`takeGridRegionScreenshot` now parks the selection six rows below the range
before framing (`parkSelectionAwayFrom`); `keepSelection: true` opts out, and is
only correct when the golden's subject genuinely IS the selection rectangle.
Parking happens BEFORE framing, because parking dispatches a navigate that can
scroll.

The renderer side is fixed too: `registerCellDecoration` carries a z-anchor, and
`"over-selection"` decorations (indicator chrome) are replayed after
`drawSelection`. `"under-selection"` (the default) is cell CONTENT — data bars,
sparklines, checkboxes — where the selection tint reading over it is correct.

**One more decoding trap, because it wasted a triage.** Counting exact source
constants is not a valid test for "no indicator". `#FF0000` / `#7B68EE` are the
literals in `Review/rendering/triangleRenderer.ts`, but the renderer paints
through the skin/theme, so the literal constant never appears in a frame — a
frame that plainly shows an indicator will report zero. Count near-matches, or
diff against the same frame with the decoration unregistered (which is what
`gridRenderer/cellDecorationZOrder.test.ts` does).

### What a capture actually captures

`takeGridScreenshot` targets `[data-grid-area]`, the CONTAINER, not
`page.locator("canvas")`. The grid is drawn on a single canvas — verified: the
main window has exactly one `<canvas>` node, so extension chrome really does
land on those pixels and there is nothing to stitch. But DOM layers sit ON TOP
of the canvas inside `[data-grid-area]`, and an element capture of the canvas
drops them: the InlineEditor is a real `<input>`, so every "editing mode" golden
used to be a picture of the grid WITHOUT the editor the shot exists to show.
Also the scrollbars and the corner box.

---

## Assertions that silently pass

**The rule: a helper that cannot fail must be deleted, not left as decoration.**
A helper that silently succeeds is worse than no test — the suite reports
coverage it does not have.

Every capture helper in `e2e/helpers/screenshots.ts` now resolves its target
through `resolveOne`, which throws with the full candidate list and what each
selector matched. What it replaced:

- `takeStatusBarScreenshot` **returned silently** when its selector matched
  nothing, which it always did (`StatusBar.tsx` rendered a bare inline-styled
  `<div>` with neither testid nor class). Every call had been a no-op since May
  and the golden directory was empty. The component now carries
  `data-testid="status-bar"`.
- `takeRibbonScreenshot` **fell back to a fixed 1280x180 page clip**, which
  fired unconditionally (all three of its selectors matched zero nodes) and was
  17 px taller than menu bar + tab strip + band — so every ribbon golden also
  framed part of the formula bar and churned on unrelated cell edits. The
  fallback is gone; primary target is `[data-testid='ribbon']`.
- `takeRegionScreenshot` accepted a clip that was empty or outside the viewport,
  photographing nothing and passing against a baseline recorded from the same
  nothing. It now validates against the live viewport.
- `takeGridRegionScreenshot` fails with the computed rect, canvas size, scroll
  and zoom when a range cannot be framed after scrolling, rather than producing
  a golden of blank grid.
- `takeCheckpoint` with a `target` locator matching 0 nodes used to time out
  with a generic message; it now names what it was asked to photograph.

Two further shapes to watch for when reading an existing spec:

- **Goldens byte-identical across the state change they are named for** — the
  grouping pair above. If two goldens in a spec are supposed to differ, hash
  them.
- **`softly()` does not suppress a missing baseline the way people assume.** It
  swallows only `"snapshot doesn't exist"`. A new visual test still needs a
  committed baseline before it asserts anything.

---

## Operational rules

These are not style preferences. Each was measured.

1. **Restart the app COLD before any run you intend to report.** Kill `app.exe`
   and `cargo.exe`, confirm ports 9222 and 5173 are clear, relaunch via
   `tauri dev`, wait for CDP. The macro debugger specs measured **10 failures
   against a long-lived instance versus 60/60 cold**. `editing.spec.ts` fails
   3/3 in a full ordered run and passes 12/12 cold in isolation.
2. **Never edit `app/src-tauri` while a run is in flight.** The `tauri dev`
   watcher rebuilds and restarts the binary mid-run; the failures that produces
   are indistinguishable from real ones.
3. **A Vite HMR update to an extension file does NOT re-run extension
   activation.** An already-registered menu action keeps its OLD closure, so a
   live check against a change you just made can pass FALSELY. Force a full page
   reload after touching `app/extensions/**` before trusting a live run.
4. **Goldens are valid only for the exact ordered cold pass that recorded
   them.** Because the functional workbook accumulates and `resetGrid` clears
   only `A1:Z1000`, a golden recorded from a different order or a warm instance
   encodes different residue.
5. **Re-record one golden at a time from a real ordered pass, not with
   `--update-snapshots`.** `--update-snapshots` rewrites every sibling in the
   run, which silently launders regressions into baselines. Triage each diff
   first: an unattributable diff is a possible regression, and one triage this
   session turned up three goldens that did not need re-recording at all and one
   whose entire diff was dated chrome (the 2026-07-30 ribbon SVG icons, the
   2026-07-20 point-size/row-height geometry, the top-level Model menu, the
   Filters→Controls tab rename) with every cell value identical.
6. **The first test after a cold launch can time out.** Documented, order-
   dependent flake in the 30 s fixture timeout. Re-run before believing a
   first-test failure.

---

## Driving the native file dialog from outside

Tauri defines its IPC surface with `Object.defineProperty(..., { value })` —
`writable: false, configurable: false` — so the file picker **cannot be stubbed
from the page**. That wall stopped `dirty-flag-close.spec.ts` and would have
stopped any test of Insert > Image, which is part of why an ingress with no
validation of any kind shipped and stayed.

The technique that defeats it: answer the dialog from OUTSIDE the app, as a user
would. `journeys/image-ingress.spec.ts` writes its own PowerShell helper which:

1. `EnumWindows` for a visible window whose class is **`#32770`** (the Win32
   common-dialog class) owned by an `app.exe` process;
2. `SetForegroundWindow`, then `EnumChildWindows` for the visible `Edit` child —
   the file-name box;
3. `SendMessageW(edit, WM_SETTEXT /*0x000C*/, 0, path)`;
4. `PostMessageW(dialog, WM_COMMAND /*0x0111*/, IDOK /*1*/, 0)`.
   `IDCANCEL` is `2`, and the helper takes a `-Cancel` switch.

It prints `NODIALOG` when no dialog is open, so the spec can poll rather than
sleep.

**Run a CANCEL case first.** `image-ingress` does, so that every later outcome
is attributable to the file CHOSEN rather than to the menu click having done
anything at all.

The same spec shows the two probes that give a binary-ingress test teeth, both
asserted in both directions: "did the document gain a control?" via
`get_control_metadata` at the anchor, and "did the document gain the BYTES?" via
`resolve_media_ref("media:" + sha256(fixture))` — content-addressed, so it asks
about THAT file and no other. Persisted state is read out of the saved `.cala`
ARCHIVE by a dependency-free ZIP reader inside the spec, not from a value the
app reports about itself.

**Show refusal assertions have teeth by reinstating the defect.** Disabling
`checkShapeSetProperty`'s `src` rule makes test 6 fail with `ACCEPTED`; making
`pickValidatedImage` return a placeholder instead of `null` reproduces the
shipped defect's exact signature (a `200x150` control at the anchor). A refusal
test that could only ever pass is worthless. Build in an attributability guard
too: the byte-cap case first inserts a twin PNG built identically but under the
cap and requires it to be ACCEPTED, so "refused" cannot mean "the whole path is
broken".

---

## The suite is not green, and the number overstates the damage

**Functional, full ordered cold pass on HEAD: 495 passed / 34 failed / 11
skipped.** Basic editing and scrolling specs are among the failures. Every
"64/64"-style figure quoted during feature work is a SUBSET — the specs relevant
to the change under test — not whole-suite health.

The failures cluster in `worker-extension*` (5), `scrolling` (4), `dimensions`
(4), `editing` (3), `status-bar` (3), `state-consistency` (2), `paste-special`
(2), `protection` (2), `evaluate-formula` (2), plus nine singletons.

**Most of that count is CASCADE, proved rather than assumed:**

- `editing.spec.ts` fails 3/3 in the full run and **passes 12/12 (5 skipped)
  cold in isolation**. Its three failures read `"This column should be wider"` —
  a `dimensions.spec.ts` fixture string — where they expect `"Hello"` / `"123"` /
  `"EditMe"`. Not editing defects; the preceding spec's residue.
- The `dimensions` goldens fail on **a chart painting an error** into the shared
  workbook: `Chart data error — Cannot read properties of undefined (reading
  'title')`, ~11.5k differing pixels. That error frame is itself left by an
  earlier spec — and a chart that renders its own exception is a real symptom
  worth an owner independent of the golden.

So the headline count materially overstates the number of distinct defects.
Fixing the few genuine roots (the chart title error, and whatever leaves
`dimensions` residue) should collapse a large part of the tail — a better first
move than re-recording 34 goldens. Evidence and the per-cluster breakdown are in
`docs/design/open-decisions-2026-08.md` §3a/§3b.

**The other suites ARE green** on the same HEAD: `visual` 18/18, `journey` 30
passed / 1 skipped, `scenario` 24/24. One pre-existing macro failure is known
and proved pre-existing: `macro-live-edit` test 6, a whitespace/EOL
normalisation between the Monaco buffer and `save_script` that makes an
untouched macro report phantom unsaved work. The "56/56" macro figure some
briefs still carry is stale for that one test.

**Open decision:** drive the functional suite to green, or formally designate a
maintained subset. Right now the number invites misreading.

---

## Known limitations

- **Canvas interaction.** The grid is a `<canvas>`, so cells cannot be targeted
  by DOM selector. `GridHelper` computes pixel coordinates — but it reads live
  geometry from `__CALCULA_GRID_STATE__` every time, not from constants.
  Hardcoding geometry was a 32-failure cascade once: `new_file` handed out a
  24x100 grid while launch was 20x64.29, so any spec that created a new file
  re-scaled the grid for the rest of the run and `clickCell("B2")` clicked
  somewhere else entirely. The fallback constants in `helpers/grid.ts` apply
  only when the app has not booted, so a helper call fails as an assertion
  rather than a `TypeError`.
- **`clickCell` selection drift.** It leaves flaky ambient selection in
  screenshots; use `navigateTo` before a capture.
- **Locale.** The app uses the system locale. On sv-SE the decimal separator is
  `,` and the argument separator is `;`, and `keyboard.type()` converts commas
  to dots. Use `setCellValueDirect()` for formulas, or type semicolons.
- **`resetGrid` clears only `A1:Z1000`** and only content + formatting. It does
  not reset sheets, dimensions, charts, controls or the outline. Specs that need
  a true clean slate belong in `journey`.
- **`resetToNewWorkbook` must dispatch three events after `new_file`.** The
  backend also resets default geometry, and the frontend caches it: without
  `dimensions:refresh` + `app:sheet-changed` + `grid:refresh`, a golden captured
  afterwards encodes ghost 100px/24px lines and a phantom "Sheet2" tab — states
  the app can never actually be in. (The product itself does a full page reload
  on File > New.)
- **The sampler runs tests in isolation**, so specs must be self-contained and
  must not rely on prior-test grid state.

---

## Coverage

The per-test tables this document used to carry are gone; they described 186
tests across 23 phases and were three months stale against 540. Spec files are
the inventory. Grouped by area:

| Area | Specs |
|---|---|
| Grid core | `editing`, `formula`, `navigation`, `scrolling`, `mouse-interactions`, `keyboard-workflows`, `grid-rendering`, `dimensions`, `zoom-view`, `freeze-panes`, `edge-cases`, `stress-tests` |
| Formatting | `formatting`, `number-formatting`, `alignment`, `conditional-formatting`, `merge`, `column-row-ops`, `hidden-rows-persistence` |
| Data | `clipboard`, `paste-special`, `fill-handle`, `find-replace`, `sort-filter`, `data-validation`, `go-to-special`, `named-ranges`, `tables`, `grouping` |
| Formulas | `advanced-formulas`, `formula-autocomplete`, `formula-tracing`, `evaluate-formula`, `udf-evaluation` |
| Objects | `charts`, `pivot`, `comments-notes`, `hyperlinks`, `cell-types`, `cell-behaviors`, `button-onclick` |
| Files & state | `file-operations`, `encryption`, `print`, `protection`, `sheets`, `undo-redo`, `state-consistency` |
| Scripting | `scriptable-objects`, `scriptable-shapes`, `undoable-macros`, `macro-*` (6), `table-namedrange-script`, `sandbox-mark-blit`, `worker-realm-*`, `worker-extension*` |
| Security | `consent-flow`, `extension-consent`, `chart-library-consent`, `capability-fetch`, `capability-storage` |
| VBA parity | `vba-idioms-wave1..4`, `vba-wiring-batch` |
| MCP / AI | `mcp-*` (5), `ai-chat-tools` |
| Shell / UI | `ribbon-tabs`, `menu-interactions`, `panel-placement`, `status-bar`, `appearance-skins`, `animation` |
| Workflows | `realistic-workflows`, `workflow-dashboard`, `workflow-gradebook`, `workflow-invoice`, `regression-scenarios`, `flagged-defects` |

Journeys: `image-ingress` (Insert > Image through the real native dialog),
`dirty-flag` and `dirty-flag-close`, `correctness-cluster`, `census-followon`,
`shapes-hometab`.

---

## Bugs Found by E2E Tests

| Date | Bug | Found By | Status |
|------|-----|----------|--------|
| 2026-05-20 | Formula "=" prefix stripped — formula bar shows "A1+B1" instead of "=A1+B1" | `formula.spec.ts` (10 tests) | FIXED — 43 call sites in 15 Rust files |
| 2026-05-20 | Formatting not persisting — ribbon toggles UI but `applyFormatting` sends stale/empty selection | `formatting.spec.ts` | FIXED — `getGridStateSnapshot()` + `lastSelectionRef` |
| 2026-05-20 | Off-screen cells not clickable — `cellCenter()` ignored scroll offset | `formatting.spec.ts` | FIXED — scroll-aware clicking via `__CALCULA_GRID_STATE__` |
| 2026-05-20 | Increase/decrease decimal read format codes; backend returns descriptive names ("Number (1 decimals)") | `number-formatting.spec.ts` | FIXED |
| 2026-05-20 | VLOOKUP returns #NA for valid data — `extract_2d_rows()` returns a flat array for multi-column ranges | `advanced-formulas.spec.ts` | OPEN |
| 2026-08-07 | Grouping goldens byte-identical across collapse/expand — backend-only mutation never reached the frontend | `grouping.spec.ts` goldens | FIXED (events) — goldens deleted, re-record pending |
| 2026-08-07 | `group_rows` / `add_hyperlink` / backend validations and notes changed 0 pixels until something else forced a refresh | live pixel probe | FIXED — `OUTLINE_CHANGED` / `HYPERLINKS_CHANGED` / `VALIDATIONS_CHANGED` emitted from the IPC wrapper |
| 2026-08-07 | Selecting a commented cell erased its own note indicator (15 px → 0 px) | live probe, then `cellDecorationZOrder.test.ts` | FIXED — `registerCellDecoration` z-anchor |
| 2026-08-07 | Insert > Image was an uncapped, unvalidated binary ingress that travelled into signed `.calp` artifacts | `journeys/image-ingress.spec.ts` (first E2E the feature ever had) | FIXED — `read_media_file` + `inspect_media`, content-addressed `media/{sha256}` |
| 2026-08-07 | `named_ranges.rs:129` multiply overflow **ABORTED the whole application** (`STATUS_STACK_BUFFER_OVERRUN`) on a 7+ letter name like `ABCDEFGHIJKLMNOP1` — a `#[tauri::command]` on a thread that cannot unwind | `--project=journey` run | FIXED — ceiling enforced inside the loop; 2 regression tests |
| 2026-08-07 | `macro-live-edit` test 6: whitespace/EOL normalisation between the Monaco buffer and `save_script` makes an untouched macro report phantom unsaved work | `macro-live-edit.spec.ts` | OPEN — proved pre-existing (reproduces cold, in isolation, and with the session's changes reverted) |
| 2026-08-07 | Charts paint their own exception into the shared workbook (`Cannot read properties of undefined (reading 'title')`), ~11.5k px | `dimensions.spec.ts` goldens | OPEN |

---

## Adding New Tests

1. Decide the project first. Does the spec wipe, reopen, reload or close the
   document? Then it is a `journey`, not a functional spec.
2. Create the `.spec.ts` under the right dir and
   `import { test, expect } from "../fixtures";`.
3. Make it self-contained. Do not rely on grid state left by an earlier spec —
   the sampler runs tests in isolation and the full suite runs them in an order
   you do not control.
4. Use `grid` for canvas interaction; use `setCellValueDirect()` for formulas
   and locale-sensitive content.
5. **Drive the product, not the backend.** An `invoke("group_rows")` mutates
   Rust and tells the frontend nothing — see "The feature was never RENDERED".
   Prefer the `@api` seam the extension publishes; if you must invoke directly,
   dispatch the corresponding announce event and say so in a comment.
6. For a golden that must prove a specific piece of chrome rendered, use
   `takeGridRegionScreenshot` clipped to the owning cells — never a whole-grid
   shot.
7. Before trusting a new refusal/negative assertion, **reinstate the defect and
   watch it go red.** An assertion never observed failing is decoration.
8. Record the baseline from an ordered cold pass, and add the spec to the
   coverage table above.
