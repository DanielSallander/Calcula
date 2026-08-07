# Open decisions — August 2026

Written 2026-08-07 at the close of the VBA-idiom parity program, the hidden-rows fix, the
visual-suite restoration and the dirty-flag census. Everything here is either a **product
decision that needs an owner** or a **scoped proposal awaiting a go/no-go**. Nothing here is
work in progress.

Status of the things that are *done* lives elsewhere: `docs/design/scripting-vba-review.md`
(§7 items 26-29 for the idiom waves).

---

## 1. Shapes and pictures — the deferred Wave-5 item

This was deferred as "VBA parity: `Shapes.AddShape` / `Shapes.AddPicture`". That framing
undersells it. The **report-distribution vision needs it**: a published `.calp` report with no
logo is not a report anyone sends to a customer. Recommend re-scoping it as a distribution
feature, not a scripting one.

The two halves have very different costs and should be decided separately.

### 1a. Shapes — create and delete (SMALL, recommend doing)

Manipulating an *existing* shape already works from scripts (`setProperty`, including `text`).
What is missing is creation and deletion, because `IControlStoreService`
(`app/src/api/componentStoreRegistry.ts:139`) is **list-only** — `listControls` returns identity
and anchor, nothing else.

**Proposal.** Widen it to a feature-neutral `@api/controlsService` seam with create/delete,
following the `buttonControlService` precedent established by the macro recorder. That precedent
exists for a hard-won reason: the recorder originally hand-rolled a button by writing control
properties directly, and it produced an *invisible* button — wrong property name, no geometry, no
floating-store registration — while the backend reported success. **One recipe must live in the
Controls extension**; a second copy drifts on the first default change.

Script surface: `api.createShape(catalogId, anchor, {width?, height?, text?, name?, sheet?})`
and `api.deleteShape(id)`.

**Risk: low.** No new file format, no new ingress, an established seam pattern.

### 1b. Pictures — needs a binary-ingress decision first (MEDIUM-LARGE)

Today **only text crosses the file picker** (`cap.fileImportText`). Pictures are the first binary
to enter the document, which touches the file format, the distribution package and the sandbox
boundary at once. Four sub-decisions, with recommendations:

**(i) How do bytes enter?** Recommend an **opaque, size-capped `dataRef` handle**: the picker
returns a reference, the image bytes never enter the script realm, and the script calls
`api.createPicture(dataRef, anchor)`. Reject base64-into-the-realm — a 5 MB logo becomes a 6.7 MB
string crossing IPC, and worse, it lets a script *synthesize* arbitrary binary content rather than
merely place a file the user chose.

**(ii) Where do the bytes live?** `.cala` is already a ZIP of structured JSON, so store images as
separate artifacts under `media/`, content-addressed by SHA-256 and referenced by id. That dedupes
a logo repeated on twenty sheets for free. Requires an explicit `format_version` bump (currently
**6**).

**(iii) What may a distributed package and a sandboxed script do?** These differ.
A published report must carry its logo — that is the point. But a *distributed script* introducing
new bytes is a different risk from one referencing bytes already in the document. Recommend:
**restricted-tier scripts may reference existing media, never introduce new bytes.** Introducing
requires the file picker plus user consent, i.e. the unlocked tier.

**(iv) Decode safety.** Image decoding is a classic attack surface. Recommend validating **magic
bytes, a hard size cap and a dimension cap in Rust**, then letting the **WebView do the actual
decode** — do *not* add an image-parsing crate to the privileged Rust process purely to validate.
Allowlist PNG/JPEG/GIF/WebP.

**Recommendation: ship 1a now; treat 1b as its own scoped change** with the above as its design
premise. It is the one remaining item whose value is driven by the product vision rather than by
VBA parity.

### 1c. The rest of Wave 5 — recommend demand-driven, not scheduled

`CenterAcrossSelection` (engine + renderer neighbour-paint pass) is the strongest of the
remainder — it is what the "never merge cells" school reaches for, and report titles want it.
Insert/delete *cells* with shift, extended border line styles, superscript/subscript and
sparklines are genuinely long-tail: each is an engine project whose script API is the last 5%.
Let real user demand pull these rather than pushing them.

---

## 2. Defects found and deliberately not fixed

Each was found during the work above, verified, and left alone because it needed an owner
decision or exceeded the scope of the pass that found it.

### 2a. Home-tab "Customize" entry point was deleted — DECISION NEEDED

The gear icon that opened Home-tab customisation was dropped during the sections/panel migration.
`HomeTabCustomizeDialog.tsx` (~839 lines) is **still registered and still listening** for its save
event, and `loadLayout` still runs at startup — so a previously saved layout still applies, but a
user can never change it again. Live, maintained, unreachable code.

Repair needs a new `PanelDefinition` field plus shell rendering (the shell cannot know about one
extension's dialog), and *where* the affordance belongs — ribbon gear, Home-tab context menu, View
menu — is a product call.

**Decide: restore an entry point, or delete the dialog deliberately.** Note that **8 visual
goldens currently encode its absence as correct**; restoring the gear will correctly turn them red.

### 2b. Pivot progress overlay never clears — FIXED 2026-08-07

The backend emits its final `pivot:progress` immediately before returning
(`src-tauri/src/pivot/commands.rs:884`). Tauri events and command responses travel separate
channels, so that last event landed *after* pivot-api's `finally { clearLoading }` had run,
re-arming an indicator nothing would ever clear. Reproduced deterministically (byte-identical
across two cold runs, unchanged by a 6 s wait), not a race.

**Fix.** `applyBackendProgress()` in `Pivot/lib/pivotViewStore.ts`, called from
`Pivot/index.ts`: a backend event may UPDATE a running operation, never START one.

The proposed one-liner was right but **incomplete**, and the second half is the interesting
one. The guard is only safe while every progress-emitting command clears its indicator under
a sequence check, because `loadingPivots` is keyed by pivot id alone and `clearLoading`
deletes unconditionally. Two of the three (`updatePivotFields`, `refreshPivotCache`) already
took a `startOperation` sequence and cleared under `isCurrentOperation`; **`changePivotDataSource`
did not**. A superseded `changePivotDataSource` therefore wiped a newer operation's entry, and
from that moment the guard dropped every one of the newer operation's real progress events —
leaving a genuinely-running refresh with no indicator at all. Before the guard existed an
unconditional `setLoading` re-created the entry, so the leak healed itself; the guard removed
that accidental safety net, which is why the sequencing had to become real.
`changePivotDataSource` is now sequenced like its siblings, and
`Every progress-emitting command is sequenced` fails if a fourth emitter appears unsequenced.

### 2c. Cross-sheet recalculation does not propagate (BUG-0019) — FIXED 2026-08-07

Editing `Sheet1!C5` propagated to `C9`, but the chain `C9 -> Sheet2!B3 -> B4` never recalculated
in memory. The scenario spec's assertions are restored (and corrected — see §2h) and the ledger
entry is closed. **Four causes, not two**: the fourth was found on the running app after the
first three were "done", and it is the one an ordinary user would have met first.

The asymmetry with save-and-reload was the whole clue, and it pointed at two *different* causes,
one per hop, both in `cascade_cross_sheet_dependents` (`commands/data.rs`):

1. **The walk was rooted only on the cells the caller EDITED.** Cells the caller *recalculated*
   were marked processed but never queued, so `C9` — which changed as a dependent — never had its
   own cross-sheet dependents looked up. First-order propagation therefore worked perfectly, which
   is exactly why this survived: every obvious cross-sheet test passes against the broken code.
2. **The walk expanded a non-active sheet's same-sheet dependents through the ACTIVE sheet's
   dependency map.** Those maps are keyed `(row, col)` with no sheet dimension and are rebuilt on
   every sheet switch, so reaching `Sheet2!B3` asked *Sheet1* what depends on `(2,1)`. Nothing did,
   and `Sheet2!B4 = B2-B3` stayed stale forever. A `SheetDependencyIndex` is now derived on demand
   from the reached sheet's own formula ASTs and expanded in topological order.

Two hand-copied duplicates of the walk (`update_cells_batch_core` for paste, `fill_range`) were
carrying cause 1 independently and lacked the same-sheet expansion entirely; both now call the
shared function, and a wiring test fails if a third copy appears.

**A third entry point, found while auditing the fix (FIXED 2026-08-07): `sort_range`
recalculated NOTHING.** Not cross-sheet, not same-sheet, nothing. It permuted its range, rebuilt
the dependency maps and returned, so a `=A1` beside the range or any off-sheet reader kept its
pre-sort value until an unrelated later edit swept it up. The asymmetry that gives it away is
that the **off-sheet** sibling `sort_range_off_sheet` has always recalculated (through
`recalc_after_off_sheet_write`) — so sorting a sheet you were NOT looking at produced the right
answer while sorting the one in front of you did not. Fixed with
`recalc_after_active_sheet_bulk_rewrite`, which reuses `recalc_order_from_seeds` +
`reevaluate_formula_cell` + the one shared `cascade_cross_sheet_dependents` rather than copying
them, and runs as a second lock phase (the dependency maps it needs are the ones
`rebuild_all_dependencies_from_grid` just held, and std mutexes are not reentrant).

**A FOURTH cause, found on the RUNNING app 2026-08-07 while proving the above — FIXED.**
Every cross-sheet test, unit and E2E alike, visited the referencing sheet exactly once: go
there, type the formula, come back. A real user opens the summary sheet again to look at it.
That **second visit silently disabled cross-sheet recalculation for the rest of the session**
— `Sheet2!A1` and `Sheet2!A2` froze at their old values while Sheet1 recalculated perfectly.
Reproduced live: `Sheet1!A1=100`, `A2==A1*2`, `Sheet2!A1==Sheet1!A2`, `A2==A1+1`; with no extra
sheet visit the edit gives 250/500/500/501, with one Sheet1→Sheet2→Sheet1 round trip it gives
250/500/**200**/**201**.

Cause: `CrossSheetDependentsMap` is keyed by sheet NAME, and `cascade_cross_sheet_dependents`
looks a cell up under the workbook's OFFICIAL name (`sheet_names[idx]`). Every registration site
normalised the parsed name to that spelling — four hand-copied inline copies of the same
`eq_ignore_ascii_case` loop — but `rebuild_all_dependencies_from_grid`, which runs on EVERY
sheet switch, registered straight from the AST's spelling.

And the AST's spelling is **never** the workbook's: the lexer normalises every bare identifier
to UPPERCASE (`parser/src/lexer.rs:196`), so `=Sheet1!A2` is stored as `SHEET1!A2` and re-keys
as `("SHEET1", 0, 1)` while the cascade asks for `("Sheet1", 0, 1)`. That is why this was not a
narrow bad-casing bug but a total loss: **every** cross-sheet edge owned by a revisited sheet
died. (A quoted reference, `='Sheet1'!A2`, lexes as `QuotedIdentifier` and keeps its case, so it
would have survived — a difference no user could have explained.)

The four copies are now one `normalize_cross_sheet_refs` in `lib.rs` that the rebuild also
calls, and `rebuild_all_dependencies_from_grid` takes `sheet_names` explicitly rather than
locking for it (some callers already hold the grid). Pinned by
`revisiting_a_sheet_does_not_lose_its_cross_sheet_dependents` and
`a_cross_sheet_reference_registers_under_the_official_sheet_name`; both fail against the old
code with exactly the live symptom (200 where 500 is required).

**Not fixed, discovered here:**

- **Undo does not recalculate dependents at all** — verified, not inferred
  (`undo_does_not_recalculate_dependents_pinning_a_known_gap`). Undo is a value RESTORE: only
  cells the caller passed to `record_cell_change` are in the transaction, cascade dependents
  never were, and `apply_changes` re-evaluates nothing for a plain cell restore. After undoing
  an edit, `Sheet1!C9` and `Sheet2!B3` both keep their post-edit values while a full
  recalculation gives the pre-edit ones. **Same-sheet first**, so it is not a cross-sheet defect
  and BUG-0019's fix neither caused it nor could have fixed it — but it means every forward-path
  cascade fix (including the sort one above) is correct going forward and stale coming back.
  Fixing it means recording cascade dependents into the transaction or re-cascading from the
  restored cells; that trade-off belongs to whoever owns undo.
- A dependency cycle that crosses a sheet boundary is not detected anywhere —
  `partition_formula_cells` runs Kahn's algorithm over one sheet's local map, and the edit path
  has no cross-sheet cycle check. It terminates and produces an order-dependent number instead of
  `#CIRCULAR!`. Detecting it needs a genuinely sheet-dimensioned dependency graph, which is the
  same underlying gap as cause 2 above and is the real follow-on here.
- `clear_range` performs no dependent recalculation at all — not even same-sheet. Same class as
  the sort defect above; not fixed because it was outside this pass.

### 2d. Selection chrome hides cell decorations — FIXED 2026-08-07

The active-cell highlight painted over the cell's top-right corner — exactly where the note/comment
indicator lives. Selecting a commented cell therefore hid its own indicator from the user.
Measured: 15 indicator pixels with the selection parked elsewhere, **0** with the cell selected.

**Fix.** `registerCellDecoration` grew a z-anchor. `"under-selection"` (the default) is cell
CONTENT — data bars, sparklines, checkboxes — where the selection tint reading over it is correct,
exactly as it reads over the text. `"over-selection"` is INDICATOR chrome that must survive the
highlight. The cell pass paints over-selection decorations in place for cells no chrome covers and
defers the covered ones, which the renderer replays after `drawSelection` /
`drawClipboardSelection` and before the above-selection overlays — a chart floating over the cell
should still cover it. Deferring the already-computed context rather than running a second loop
keeps the geometry (merge masters, insertion-animation offsets, header clipping) owned by the one
pass that computes it, and costs one object per chrome-covered cell — one, for the usual
single-cell selection. Review's annotation triangles, ErrorChecking's error triangles and
CellBookmarks' dot declare the new anchor; the selection painter learned nothing about notes.

Verified by a deterministic pixel probe (`gridRenderer/cellDecorationZOrder.test.ts`): frames go
through the real `renderGrid` into a small alpha-compositing rasteriser, and "indicator pixels" is
the count of pixels that differ between the frame with the decoration registered and the identical
frame without it — the defect report's own measurement. The count on a selected cell is now
**equal** to the count on an unselected one, for a single-cell selection, a containing range and a
clipboard range; an `"under-selection"` decoration still measures strictly lower when selected,
which is what keeps the two anchors demonstrably different.

**Golden impact, triaged rather than assumed (2026-08-07).** Exactly three committed goldens are
affected, all in the FUNCTIONAL suite (`e2e/tests/__screenshots__/comments-notes.spec.ts/`):
`comments-cell-with-indicator`, `notes-cell-with-indicator` and `comments-indicators-visible`.
Each of those tests annotates a cell, then calls `navigateTo` on **that same cell** and clips the
screenshot to it (W1, X1, W6 respectively) — so every one of them captures an annotated cell while
it is the active cell, which is precisely the frame this change alters. They must be
**re-recorded**: they currently encode the defect (indicator lost under the active-cell chrome),
and the triangle is ~66 device pixels against a single-cell clip, far above the
`min(200px, 0.05%)` budget, so they will go red rather than pass quietly.

The **visual suite (18/18) is not affected**: neither `core-visual.spec.ts` nor
`workflow-visual.spec.ts` creates a note, comment, bookmark or formula error, so no frame in it
contains an over-selection decoration to reorder.

### 2e. Backend mutations never reach the frontend for grouping, hyperlinks and tracing — FIXED 2026-08-07

Measured on the live app: `group_rows`, `add_hyperlink` and `trace_precedents` changed **0 pixels**
until something else forced a refresh. Tables and annotations had refresh events; these three did
not. Same class: **backend-created validations and notes stayed invisible to their extension's
frontend cache**.

**Fix.** Three new feature-neutral events (`OUTLINE_CHANGED`, `HYPERLINKS_CHANGED`,
`VALIDATIONS_CHANGED`; `ANNOTATIONS_CHANGED` reused), emitted **from the IPC wrapper, never a
call site** — the `ROWS_INSERTED` / `SHEET_ADDED` precedent — so "every route announces" is a
property of the code rather than a checklist. Verified against all three route classes: UI,
script broker (which drives the same wrappers through the `@api` services), and MCP, which has
**no** tools for any of the four and no reach to them from the Rust QuickJS surface either. The
only bypasses left are raw `invoke(...)` calls, which exist solely in E2E specs.
`coalescedRefresh.ts` keeps a mutating caller and its own listener from paying two round-trips.

**Tracing deliberately got no event** — `trace_precedents` is a pure query that mutates nothing,
so "0 pixels" is correct by construction. What was missing is a *door*: `@api/tracingService`
(the `groupingService` shape), registered by the Tracing extension. Note it currently has **no
in-repo consumer** — it exists for the deleted E2E assertions and outside callers.

**Found and fixed on the way:** `resetGroupingState()` zeroed the outline bar on SHEET_CHANGED,
and `renderOutlineBar` returns early while the bar is zero-sized — so the only code that would
re-fetch stopped running. Switching to a sheet that already had groups showed **no outline for
the rest of the session**.

**The document-REPLACING routes were still missing — FIXED 2026-08-07.** Announcing from the
mutation wrappers covers every per-mutation route, but `new_file` and `open_file` replace all
four states at once and go through none of them. Measured live: after grouping rows and then
File > New, the grid still reserved a **36 px outline gutter** for a workbook whose backend
reported `maxRowLevel: 0`, and the sheet-tab bar still showed a clickable phantom **"Sheet2"**
whose backend index no longer existed (activating it errors with "Sheet index 1 out of range").
`AFTER_NEW`/`AFTER_OPEN` do not cover it — those are workbook-lifecycle events with their own
subscribers, and the four caches deliberately listen for the state they own. `newFile()` and
`openFileAtPath()` in `core/lib/file-api.ts` now call one `announceBackendStateReplaced()`
after the backend has committed (order asserted, not assumed: announcing early would have every
listener re-read and re-cache the OLD state, which is indistinguishable from not announcing).
`SHEET_CHANGED` rides along because it is literally true and because SheetTabs re-reads on it.

**Still open (needs Rust):** undo/redo does not refresh these four. `MUTATION_REFRESH` domains
come from Rust undo-result flags, so this needs new flags plus the `MutationDomain` union and the
shell translator. Pre-existing — `DATA_CHANGED` was never emitted on undo either.

**A hyperlink paints NOTHING, by construction — measured, and not a defect.** `add_hyperlink`
changes zero pixels of its cell and always did: the blue-and-underlined look is cell FORMATTING
that `InsertHyperlinkDialog` applies separately, and the Hyperlinks extension paints nothing at
all. What it owns is an `indicatorSet` feeding a cell CURSOR interceptor and the
Open/Edit/Remove context-menu items — and THAT is what went stale. The live oracle is therefore
the rendered cursor: `pointer` over the linked cell, `cell` over its neighbour, with nothing
refreshed by hand (`correctness-cluster.spec.ts` 3c). A pixel-diff assertion on the cell would
fail forever against correct code.

### 2f. The dirty *indicator* lags the dirty *flag* — FIXED 2026-08-07

After a backend-only mutation the title bar showed no asterisk even though `is_file_modified` was
true. The safety net worked; the ambient signal did not.

**Fix.** The announcement sits on the FLAG, not at the call sites. `FileState::is_modified` is a
`document_effect::DirtyFlag` rather than a bare `Mutex<bool>`, and its guard compares the value it
was locked at against the value at release, emitting `document:dirty-changed` on a real transition.
That covers `DocumentEffect::mutates`, the legacy `mark_workbook_modified` and the ~60 remaining
direct `*is_modified.lock() = true` sites in one move, with none of them having to remember — which
is the point, since asking 355 commands to emit an event is the same failure mode the dirty-flag
census existed to end. The API is `Mutex`-shaped (`.lock()`, `.unwrap()`, `.map_err(..)?`), so no
call site changed.

Only TRANSITIONS are announced, in both directions: a bulk operation over an already-dirty document
emits one event rather than one per write, a read emits none — including the `is_file_modified` the
frontend calls from inside the listener, which would otherwise loop — and the save/open/new
`= false` sites clear the asterisk. `shell/dirtyStateBridge.ts` re-emits onto
`AppEvents.DIRTY_STATE_CHANGED`, which `Layout.tsx` already re-titles on; that last hop is asserted
from source in `shell/__tests__/dirtyStateBridge.test.ts`, because a bridge nobody subscribes to is
a silent no-op of exactly the kind this program keeps finding.

### 2g. Smaller, verified, unowned

- **`Ctrl+Home` is intermittently swallowed** before reaching the grid (WebView2 level).
- **The Script Editor's macro `<select>` picks the wrong macro under load** — a `-sbfault-` id
  selected instead of `-sb-` during a 12-minute run.
- **The inline editor never expands over neighbouring cells**, so at the (now correct) 64.29 px
  default column width longer entries scroll instead of being visible. An Excel-parity gap that
  the geometry fix exposed rather than caused.
- **A truncated cell's underline is drawn wider than the ellipsised text.** Cosmetic.
- **The app hard-crashed twice** during visual workflow specs (`app.exe` exit `0xffffffff`, no
  panic in the tauri log). Not reproduced deliberately; worth knowing it happens.

---

### 2h. Proved live — what `correctness-cluster.spec.ts` now holds

`app/e2e/journeys/correctness-cluster.spec.ts` (10 tests, `journey` project) asserts §2b-§2f on
the RUNNING app, through the real UI, with no test double in the path. It is a JOURNEY because
it calls `new_file`, saves to disk and adds a sheet — the functional specs share one
accumulating workbook whose goldens encode prior residue.

Three techniques in it are worth reusing rather than re-deriving:

- **Reading another sheet without activating it.** `get_cell` only answers for the ACTIVE sheet,
  and switching to read would run `set_active_sheet`, which rebuilds the very dependency state
  under test. `get_workbook_state_digest` (cellsOnly) is a pure read of the stored per-sheet
  grids — no mirror, no recalculation, no rebuild. Every cross-sheet assertion uses it. The same
  correction was needed in `budget-model.scenario.ts`: its restored BUG-0019 assertions read
  `B3`/`B4` through `getCellDisplayValue` while **Sheet1** was active, so they read Sheet1!B3 =
  "Budget" and could never have passed. The expected VALUES (27800, -500) are unchanged and
  arithmetically forced; only the read mechanism moved.
- **"No overlay" as "these pixels do not move".** The pivot progress overlay is canvas-drawn and
  its bar re-renders every animation frame while it lives, so a stuck overlay cannot hold still.
  Two captures ~1 s apart that are byte-identical prove it is gone — no golden, nothing to go
  stale. Paired with a PRECONDITION capture before the refresh, so a failure cannot be blamed on
  something else that animates.
- **Indicator pixels as a difference, live.** §2d's own measurement, reproduced in the app: count
  the pixels that differ between the frame with the note and the frame without it, once with the
  selection parked and once with the cell selected. 65 px vs 65 px now; flipping Review's anchor
  back to `"under-selection"` gives 65 vs 10 and the test goes red.

Three traps cost real time and are worth knowing before touching this file:

- A **clipboard marquee** left by a copy animates forever and `new_file` does not dismiss it
  (Escape does), so it silently breaks any "these pixels did not move" assertion downstream.
- A **menu button's textContent concatenates its label with its chevron or shortcut** — the rows
  read "Outline▸" and "GroupAlt+Shift+Right" — so anchored `^Label$` patterns match nothing and,
  because Playwright has no default action timeout, the test HANGS until the 3-minute test
  timeout rather than failing in seconds. Every menu step here carries an explicit timeout.
- **Never edit anything under `app/src-tauri` while an E2E run is in flight.** The `tauri dev`
  watcher rebuilds and RESTARTS the app — even for a `#[cfg(test)]`-only file — and the suite
  then fails for reasons that look exactly like real defects. One macro run was lost to this.

## 3. Test-infrastructure decisions

### 3a. The full functional E2E suite is not green on HEAD

**490 passed / 33 failed.** Basic editing and scrolling specs are among the failures. Every
"64/64"-style number quoted during this program is a **subset** — the specs relevant to the change
under test — not whole-suite health. Someone should decide whether to drive that to green or
formally designate the maintained subset, because right now the number invites misreading.

### 3b. Shared-workbook contamination between specs

The functional specs share one accumulating workbook, and `resetGrid` clears only `A1:Z1000`, so
screenshot goldens encode prior specs' residue and are only valid for the exact ordered cold pass
that recorded them. Specs that wipe and reopen the document now live in a separate `journey`
project for this reason. **The macro debugger specs are additionally not robust to a long-lived
app instance** — 10 failures contaminated versus 60/60 cold.

Deciding to make specs self-contained would cost a pass but would end a recurring class of
false signal.

### 3c. `AppState.grids` is still a bare `Mutex`

Which is why `FileState::is_modified` cannot yet be made private with `DocumentEffect` as its sole
writer. Grid writes are gated at their commit helpers rather than by the type. **This is the
highest-value follow-on to the dirty-flag census** — it converts the remaining convention into a
compiler guarantee.

---

## Suggested order

2b, 2c, 2d, 2e and 2f are all done (2026-08-07). What remains, in order:

1. **Undo does not recalculate dependents** (§2c) — the largest remaining wrong-answer bug, and
   now the reason every forward-path cascade fix is only half a guarantee. Pinned by a test.
2. **Re-record the three `comments-notes` goldens** (§2d) — triaged, expected, not a regression.
   The scenario golden `scenario-budget-model-title.png` is stale too, but for older reasons: it
   was recorded 2026-06-11, before the 2026-07-20 point-size/row-height geometry change and the
   2026-07-30 ribbon SVG icon set, and now differs by 15% of the frame. Nothing in this program
   caused it; the whole budget-model scenario passes 8/8 with `--ignore-snapshots`.
3. **3c** — `AppState.grids` as a bare `Mutex`; finishes the dirty-flag census properly.
4. **1a** shapes — cheap, unblocks report annotation.
5. **2a** — decide it either way; leaving 839 lines of unreachable code is the worst option.
6. `clear_range` recalculates nothing (§2c), and cross-sheet cycles are undetected (§2c).
7. **1b** pictures — as its own scoped change, on the ingress design above.
