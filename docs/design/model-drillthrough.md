# Drill-through on model visuals

**Status:** BUILT 2026-10-23 and proved live: `app/e2e/journeys/drill-through.spec.ts` J1-J9 green against the real
app on the serverless sales-star fixture, each of its ten sabotages run once and its named assertion seen red
(section 7). The design was agreed the same day after an eight-reader code map and a four-lens adversarial
critique; the build then went through a six-scope adversarial review (32 confirmed findings, each verified by two
refuters, two of them blockers) and a fix round, and the decisions below are written AS BUILT -- section 7 lists
what changed against the first agreement and why. File:line citations are from 2026-10-23 and drift; the symbols
do not.
**Supersedes nothing**: the pivot's existing `builtin` / `query` / `script` drill behaviours
(`docs/design/pivot-drillthrough-customization.md`) stay as they are; this adds the design-query drill beside them
and gives charts their first drill.
**Related:** `canvas-sheets.md`, `query-object-unification.md`, `calp-workspace-collaboration.md`,
`functions/pivot/design-view-reference.md` ("Using a design query as a drill-through" is the user-facing text).

## 0. What the owner asked for

Objects that read a Calcula BI model (design-query charts, including the Card / KPI / Gauge marks, and BI pivots)
get a **drill-through**. A user right-clicks e.g. a bar and defines one: a design-query DSL text (`ROWS:` /
`COLUMNS:` / `VALUES:` / `FILTERS:` / `CALC:`) plus the **presentation** the result takes, a chart of some mark or
a table. Running it takes the clicked datum's members as extra filters, runs the query and shows the result on a
**new sheet that is ephemeral**: it exists until the user leaves it, unless they **double-click its tab**, which
keeps it as an ordinary sheet. In a published `.calp` application the publisher authors the definition and every
subscriber can run it.

## 1. The shape in one paragraph

A **definition** `{ dslText, presentation, name?, keepFilters? }` lives INSIDE the owning object -- a BI pivot's
`DrillThroughBehavior.designQuery`, a chart's `ChartSpec.drillThrough` -- so it persists in the `.cala` and
travels in the `.calp` through the opaque JSON both already carry (2.1). It stores **no connection id**: the run
takes the connection from the source object (2.2). The clicked datum is identified by member **keys**, never
labels (2.3), and the drill's filters are **baked into the DSL text** as one `FILTERS:` clause, so the kept result
is an ordinary design-query object whose Design tab SHOWS what it was filtered to (2.4). The result lands on a new
sheet that the ONE add path flags **ephemeral**, under its own locks, in a session-only set keyed by the stable
`SheetId` (2.6); the tab strip discards the sheet BY THAT ID when the user leaves it and keeps it by id on a
double-click (2.7). One new Tauri command `drill_through` (two ops) and two sheet primitives,
`keep_ephemeral_sheet` and `discard_ephemeral_sheet` (2.5). Subscribers can run and VIEW a definition but not edit
it (2.9). A pre-existing defect that made subscribed design-query charts unable to find their model is fixed as a
prerequisite, at the pull, refresh and open re-binds AND at save time (2.10).

## 2. Decisions

### 2.1 Where the definition lives (D1)

- **BI pivot:** `BiPivotMetadata.drill_through: Option<DrillThroughBehavior>` gains
  `design_query: Option<DrillDesignQuery>`. **A present `design_query` WINS over `kind`**; `kind` keeps whatever it
  was. No new `DrillThroughKind` variant: the enum is closed camelCase with no `other` arm, and an older reader that
  met an unknown variant would fail `from_value::<SavedBiPivotMetadata>(..).ok()` in `restore_pivot_definitions`
  (`persistence.rs`), which drops that pivot's WHOLE BI metadata row (model binding gone, cached numbers shown), a lie
  under the format rule's lie-vs-loss test. An unknown FIELD is ignored, so an older reader runs the previous drill: loss only, no
  format link, no feature id. Pinned by `drill_through_tests::the_old_behavior_shape_parses_the_new_json`.
- **Chart:** `ChartSpec.drillThrough?: DrillThroughDefinition`, declared in `chartSpecSchema.ts` as a closed
  definition (the root is `additionalProperties: false` and `chartSpecSchema.test.ts` pins the top-level key list),
  in `generateSpecReference` and `chartSpecGuide.ts`. `normalizeChartSpec` preserves unknown keys and
  `deepMergeSpec` merges objects field by field; load validation is warn-only. An older reader shows the chart
  without its drill: loss. **The extension's JSON schema is THE gate** for the script door (`chart.updateSpec` is a
  restricted `object.setState` aspect that reaches `checkChartSpec` = shape + 2 MB): `dslText` maxLength 20000,
  `name` maxLength 80, `presentation.kind` enumerated, and a chart presentation's `mark` and `markOptions` follow
  ChartSpec's OWN rules -- the shared mark-id pattern (`CHART_MARK_ID_PATTERN`) and the per-mark options narrowing
  (`allOf: MARK_OPTION_NARROWING`) -- so the gate refuses what `createChart` would refuse later. The Charts drill
  dialog validates a definition against that same sub-schema before it saves (`validateDrillThroughDefinition`).
- Zero `.calp` code: publish clones each chart's whole spec (`core/calp/src/publish.rs`) and serialises
  `SavedBiPivotMetadata` with `drill_through` (`collect_pivot_definitions`, `persistence.rs`); pull reads both
  verbatim; the materialisers copy `drill_through: saved.drill_through` (`apply_refreshed_pivots` and
  `restore_pulled_pivots`, `calp_commands.rs`). No sanitiser strips unknown keys. A new key inside a carried artifact adds no `Workbook` field, so
  `CALP_PUBLISH_COVERAGE` needs no row.
- **Sharing room (v2, not now):** a page-level `CanvasLayout.drillThroughs: [{ id, def }]` with a visual holding
  `{ ref }` would let one definition serve several visuals. Nothing here blocks it: both homes are opaque JSON,
  `presentation.kind` is nested, and the editor edits a plain definition.

### 2.2 No connection id in the definition (D2)

The run reads `BiPivotMetadata.connection_id` (re-bound on the subscriber through
`data_source_id -> Connection.package_data_source_id`) or `DesignQueryDataSource.connectionId` (after 2.10). A
ZERO or unknown id is TOLD ("Open the model's connection first"), never silently queried; the pivot dialog hands
its editor's assist a connection only when the LIVE model was read, so a ZERO connection is never dry-run either.

### 2.3 Member identity is the KEY (D3)

- **Chart:** `memberPathOfHit(cached.data, hit, mark)` (`Charts/handlers/crossFilterClick.ts`) at the right-click
  RECORD site in `Charts/index.ts`, through `lib/chartDrillIdentity.ts`, stored on
  `ChartRightClickTarget.memberPath` / `memberLabels` / `drillIdentity` / `drillIdentityReason` (`@api/chartData`).
  The hit is used, not the ladder's `pointIndex` (absent on the first right-click). Three cases are told apart: a
  **path** (drill on it); **measure-only** (`categoryMembers` is exactly `[[]]`: a Card / KPI / Gauge -- drill with
  the page filters only); **no identity** (a transformed or composed chart, a chart never painted, a missing key) --
  the row is shown DISABLED (`aria-disabled`, the reason as its title) and a click runs nothing.
- **Pivot:** `drill_through { op: "pivotContext" }` resolves the cell's `group_path` with `bi_placed_field_keys` +
  `member_key_of` + `split_bi_field_key`, blank member -> key `""` with label "(Blank)". A coordinate that cannot be
  resolved FAILS the op (a partial path filters on another datum's member) -- except the synthetic "Total" row a
  measure-only pivot places, MARKED on the field (`PivotField.is_synthetic_total`, read by
  `pivot::utils::is_synthetic_total_row`, shared with `bi_request_from_definition` and `get_pivot_at_cell`; the name
  rule survives only for a field saved before the marker), which every record has: it contributes no path spec, so a values-only pivot drills with its standing filters only.
  `pivotCellItemKey` (returns the measure value on a data cell) and `getPivotDataFormula` (spells the blank
  "(blank)", is grid-coordinate bound) are NOT used.
- Labels ride beside the keys (`DrillFilterSpec.labels`, from the app-locale `member_ref` and, for a chart, from
  the hit's drawn category / series text) for captions and titles: keys are shown nowhere.

### 2.4 Filters are baked into the DSL as ONE `FILTERS:` clause (D4, D5)

**What is carried.** (a) The clicked datum's path -- must. (b) When `keepFilters` (default true, Power BI's "Keep
all filters"): the page's rectangular field filters resolved for the source visual,
`resolveFiltersFor(sheetIdAt(getReportPagesSnapshot(), sheetIndex), { ref, canHighlight: false }, connectionId)`.
(c) A BI pivot's own standing filters, returned by `pivotContext` as KEYS in a separate `standing` list (never mixed
into the clicked path): pinned `engine_filters.selected_items` (IN-list keys already), filter-area and axis
`hidden_items` (display-or-key strings, resolved through `pivot_engine::hidden_member_ids` and `member_key_of`), and
worksheet slicer filters; an item that resolves to nothing becomes ONE notice per field, never a DSL term and never
a key spelled in a message. **Not carried, and TOLD** once the sheet has landed: non-rectangular tuple selections
(no DSL spelling). **Refused** before anything runs: a source filtered to NO members (an empty inclusion, an empty
intersection, or an inclusion every member of which the exclusions also hide -- matched the way Rust folds the
blank member). **Level is not carried**: a pinned (level 2-9) page filter runs at slicer level in the drill
(owner question 7).

**How it is written** (`_shared/drillThrough/dslFilters.ts`, `bakeDrillFilters(dslText, specs)`):

- The parser ACCUMULATES `FILTERS:` clauses (it used to assign, so a second clause replaced the first); the
  validator warns on a repeated clause. The bake emits ONE `FILTERS:` line carrying every baked term.
- `compileDesignQuery` sends ONE ref per field: the INTERSECTION of every `=` list on that field and the UNION of
  every `NOT IN`; the author's own `FILTERS: [Product.Category] = ("Gadgets", "Gizmos")` ANDs with the drilled
  `("Gadgets")`. The bake merges its own specs per field the same way before writing.
- Field names are written **bracketed**, `[Table.Column]`, always (the lexer's bare identifier is
  `[A-Za-z0-9_]`); a name containing `]` has no spelling and is refused with a toast.
- Values are always quoted, a `"` inside a key doubled (`""`), the lexer's only escape; the serializer now writes
  the same doubled quote (it wrote `\"`, which the lexer did not read). The blank member is `= ("")`, folded to the
  engine's `(Blank)` in Rust. Keys are written AS-IS; a key containing a newline is refused with a toast.
- `@param`s are substituted BEFORE the bake, so a kept chart shows the dry-run numbers. Re-substitution on read is
  a no-op because the `@param` scanner skips quoted values AND bracketed or single-quoted names, as the lexer does
  (`paramSubstitution.ts scanParamTokens`); before that fix a bracketed `[Contacts.e@mail]` read as a param and the
  WHOLE baked line was dropped on every chart read.
- For the CHART presentation, a filter that a workbook-wide ("all"-scoped) publication supplies is LEFT OUT of the
  bake: it re-applies live on the new page, and a baked copy would intersect with the live one once the user moves
  it. A page filter says so itself (`ResolvedFieldFilter.workbookWide`); a pivot's STANDING filter is dropped when
  its field (case-insensitively) is filtered by an all-scoped publication on the same connection, whatever
  `keepFilters` says. The clicked path is never dropped; the table presentation bakes everything (static cells).
- **The table run uses the ENGINE route** (`compute_design_query_view`), so every `FILTERS:` term is an exact-key
  IN-list, never a filter-area row; value-less `FILTERS:` fields are dropped by that route and named in the caption.

### 2.5 One command, two ops, plus two sheet primitives (D12)

`drill_through` (`app/src-tauri/src/drill_through.rs`, `#[tauri::command]` on a `pub async fn`, the
`run_design_query` shape; feature-open, no dangerous prefix), tagged `op` with `rename_all` and
`rename_all_fields = "camelCase"`:

- `pivotContext { pivotId, groupPath }` -> `{ connectionId, packageDataSourceId?, filters /* the clicked path */,
  standing, notices }` (reads `pivot_tables` THEN `bi_metadata`, both released before the live connection's package
  key is read from `BiState`; the key is omitted for a local connection).
- `toSheet { name, title?, presentation: "table" | "chart", query?, caption }` ->
  `{ sheetIndex, sheetName, sheetId, rowCount, colCount }`. Order: the structure gate and the
  "active sheet is temporary" refusal (`EPHEMERAL_ACTIVE_REFUSAL`) -> a table's query, awaited with NO std lock held
  -> the 100 000 visible-row cap -> **the gates again** (the structure gate, and `CONCURRENT_DRILL_REFUSAL` when
  another drill landed a temporary sheet during the query), so a refusal still leaves the document clean and no
  styles registered -> `DocumentEffect::mutates` -> a detached grid: the bold title at (0,0) (`title`, else the
  sheet-name base `name`, else "Drillthrough"), the caption lines VERBATIM from row 1 (the frontend writes complete
  sentences in labels), one blank row, the view from row `max(3, lines + 2)` through `write_pivot_to_grid` under the
  grid report theme, the style registry released before the add -> `append_user_sheet(EphemeralUserSheet {
  sheet: NewUserSheet { FirstFree(base), Worksheet | new_canvas(), cells, activate: true },
  refusal: CONCURRENT_DRILL_REFUSAL })`, which re-decides "the active sheet is temporary" and INSERTS the new id into
  `ephemeral_sheets` under its own locks -> the merges -> the undo history ends -> the dependency maps are rebuilt.
  ONE left-margin `pub(crate) async fn` so the add-path census charges it.
- `keep_ephemeral_sheet { sheetId } -> SheetsResult` (`sheets.rs`): a sheet PRIMITIVE the Shell calls by its own
  name, BY THE STABLE ID. An unknown id is refused ("There is no sheet with that id."), an object sheet is refused,
  an already ordinary sheet answers Ok (a second keep is harmless and true). Takes NO `FileState` (a flag no save
  reads must not dirty, the `set_scroll_area` rule).
- `discard_ephemeral_sheet { sheetId } -> { deletedIndex, deletedName, result }` (`sheets.rs`): resolves the id to
  its CURRENT index inside the one sync command and refuses, before any slicer work and before any
  `DocumentEffect`, an unknown id or one no longer flagged ("That sheet is not temporary any more."); then runs the
  `delete_sheet` COMMAND itself for that index (not a copy of its body), so the slicer filter clearing, the
  `#REF!` repair, the cascades, the undo reset and the quiet BI re-query are exactly Delete Sheet's. The delete
  RE-CHECKS UNDER ITS OWN LOCKS that the sheet at that index still carries the id (`delete_sheet`'s optional
  `expected_sheet_id`; `delete_sheet_impl` holds its pre-flight guards pending through the write): the MCP server
  runs on its own thread, and a move it made between the lookup and the delete handed the index to a user sheet.
  Such a delete is refused before the document is dirtied ("The sheets changed while that sheet was being deleted,
  so nothing was deleted.").

`append_user_sheet`'s `FirstFree` names shorten the stem by characters from the second candidate on, so a 31-character
base never yields a 32-character name (`numbered_sheet_name`). Counts: 836 -> **839** commands; CLAUDE.md and the five
`backend-facade.md` figures re-run line-wise together (839 / 882 / 125 / 714 / 340).

### 2.6 The ephemeral flag (D6, D8, D9)

- `AppState.ephemeral_sheets: Mutex<HashSet<identity::SheetId>>`, declared after `scroll_areas` with the same
  doc: SESSION-ONLY, a bare Mutex by design, a LEAF lock (taken alone or last, never held across a call, read by the
  sheet-list builders as a snapshot, `ephemeral_sheet_ids`). Keyed by the stable id, so move / copy / rename /
  partition rotation need no maintenance; a copy mints a FRESH id, so **Copy makes a permanent sheet, Move keeps
  the flag**. `delete_sheet_impl` removes the id; `reset_document_scoped_stores` clears the set. Not in
  `state_digest.rs`. Lock census `the_appstate_lock_census_reconciles`: **110 / 66 / 42 / 2** with this field, **111 / 66 / 42 / 3** since the
  consistent-save fix added the lock-free `sheet_structure_generation` (section 7).
- `SheetInfo.ephemeral: bool`, computed in `build_sheet_list` from a 7th argument at all 13 callers; TS
  `SheetInfo.ephemeral?: boolean`. `reportPagesFrom` skips ephemeral canvases (a drill page is not a Page Navigator
  page; `canvas-sheets.md` 13.7). The MCP sheet inventory marks a temporary sheet and the `list_sheets` description
  names the marker, so an agent puts no lasting work on it.
- **Save keeps the sheet** (owner question 1). **Create and leave END the undo history and DIRTY the document**
  (owner question 2).

### 2.7 Leave and keep in the tab strip (D7, D16)

The strip (`app/src/shell/SheetTabs`) owns every sheet-structure change and keeps pure policy helpers beside it;
`ephemeralSheets.ts` holds the temporary-sheet ones: `resolveTabDoubleClick`, `resolveEphemeralLeave`,
`leaveObserverPaused`, `createEphemeralLeaveObserver`, and the keep / refused-discard notices.

**The observer rules** (each one a finding of the critique or the review):

1. It runs ONLY inside `loadSheets()`, never at the strip's own adopt sites (a tab click adopts its result and THEN
   emits SHEET_CHANGED, so a second site would judge the same pair twice).
2. Its memory (the active sheet by id, with its flag) is overwritten synchronously BEFORE the discard is issued, and
   a sheet whose discard is in flight is not discarded again.
3. It records NOTHING while ANY cell edit is open -- the grid's editor (`editing !== null`) or an external session
   -- whatever the formula looks like. NOT "the formula expects a reference": a point-mode click inserts `Sales!B2`
   while the backend is still on Sales, the formula stops expecting a reference, and a read judged then deleted the
   temporary sheet being edited (review blocker). When the pause ends (the edit closed, which a cross-sheet trip
   does only after it switched back), ONE re-read runs, and only if a read was skipped meanwhile.
4. It records nothing for a read SENT or ANSWERED while one of the strip's OWN two-step flows is in flight (Insert
   Sheet = add then move; Move or Copy with a copy = copy then move), nor for one that straddles such a flow (a flow
   epoch on each read's ticket); when the flow settles, ONE re-read runs. A read between the two steps is not the
   list the user ends up with, and a discard between them renumbers the sheets under the second step's index.
5. The error fallback list is never adopted as memory. Reaching the ephemeral sheet is not leaving it; a delete of
   ANOTHER sheet lands on the same id; File > New / Open replaces every id; a fresh read that no longer flags the
   remembered sheet (kept meanwhile) discards nothing -- the backend's flag is the authority.
6. Doors that switch with a raw `setActiveSheet` and no event (the Insights pane, the command line's
   `ensureSheetActive`) produce a LATE leave on the next sheets event. Accepted (owner question 12).

**The discard** (`discardSheetById`) names the sheet by its STABLE id end to end: `discardEphemeralSheet(sheetId)`
(`core/lib/tauri-api.ts`, invoking `discard_ephemeral_sheet`, emitting the same SHEET_DELETED and seven-domain
MUTATION_REFRESH `deleteSheet` emits at the RETURNED index, recording nothing for a macro) ->
`announceReorder(removalReorderDetail(deletedIndex))` -> the list and Core's sheet context from the answer. No switch
fan-out (the user already sits on the sheet they chose; replaying a switch restored that sheet's OLD selection after
a hyperlink landed). An in-flight `Map<sheetId, Promise<boolean>>` makes a second request for the same id await the
first. The review's blocker this closes: the old body deleted by the INDEX a mid-flow read reported, so Insert Sheet
on the first tab while on a temporary sheet deleted a user sheet with no prompt. A discard through the door (the
drill runner's) WAITS, inside its in-flight promise, until none of the strip's two-step flows is in flight
(`whenFlowsIdle`), so it never lands between a flow's two steps; once sent it is registered (`discardsSent`), and a
flow that starts later awaits its answer first and, for Move or Copy, takes the source and the target again BY ID
from a fresh list -- a copy started while a discard was in flight copied whichever sheet slid into the source's
index (both found by the verification round, section 7). **A refused discard** (Protect
Workbook Structure turned on while on the sheet, a repairability pre-flight) keeps the sheet by the same id and
toasts "Temporary sheet kept: <reason>" ONLY when the keep landed; otherwise it says the sheet is still temporary.

**Every other door of the strip by id** (third round). Because a discard renumbers the sheets in the background, every
index-addressed door captures the sheet's id at the gesture and acts through ONE helper (`runSheetDoor` /
`resolveDoorTargets` in `SheetTabs.tsx`): wait for the discards already sent, read a fresh list, find each sheet by id,
refuse a gone one with one toast, and hold the leave observer for the door so no discard is sent between the read and
the step. Duplicate, Move Left / Right (along VISIBLE tabs), drag, Hide, Rename, Tab Color, Unhide, Insert Sheet (which
now refuses when its anchor is gone), Move or Copy (its dialog carries ids and answers `beforeSheetId`; a gone source or
target is refused, never read as "move to end") and Delete (the confirmation remembers `{ sheetId, name }`, and the
delete sends `expectedSheetId`, which Rust re-checks under its locks) all go through it; the tab menu finds its sheet
again by id at the click. Each such door costs one extra `get_sheets`, and the reorder announcement of Move Left / Right
and drag fires after the move lands.

**An open cell edit follows its sheet by its stable id** (fourth and fifth rounds). A discard sent just before the user
starts typing on the sheet they moved to lands while that edit is open and renumbers the sheet under it; the edit held
its sheet's INDEX, so Enter switched "back" to the old index and wrote the value into another sheet (or lost it out of
range). Core's sheet context now carries the active sheet's stable id and an edit records its sheet's id at open; Core
decides whether the grid shows the edit's sheet by id (then name, then index), rebases the stored index whenever the
context lands on that sheet, and on commit or cancel finds the sheet again by id in a fresh list before switching back
-- a renamed sheet is written to; only a deleted one refuses, with nothing written and a message that shows the entry.
(The fourth round's first version went by NAME, which threw the entry away when the edited sheet was renamed during a
formula-bar edit; the fifth round moved it to the id.) A floating grid's own edit decides the same way since the sixth
round: a renumbering of its host only re-filters and keeps the half-typed entry, a genuine switch away still commits
(at once for a tab click or the Name Box, after a fresh read when only SHEET_CHANGED announces it), and a parked edit is
never committed by a switch. A switch back that the backend refuses (a hidden sheet, an index gone out of range) is a
refusal that shows the entry, never a silent loss. The strip also
defers SENDING a discard while an edit is open or opening, and owes one re-read when it closes.

**The keep** (the tab's double-click, **Keep Sheet** first in the tab menu) passes the sheet's id; "Sheet kept"
only when the answered list holds that id unflagged. The core command `core.sheet.discardEphemeral { sheetId }`
resolves `true` only when the sheet is gone and `false` on a refusal it toasted once.

**The macro recorder.** The discard's wrapper and the runner's landing (`activateSheet(index, { record: false })`)
record nothing, so a macro recorded across a drill replays no structural delete.

**Look.** An ephemeral tab's NAME is italic, with the tooltip "Temporary sheet: it closes when you leave it.
Double-click the tab to keep it."; its decoration glyphs stay upright.

**Drill-from-drill.** The runner notes the active temporary sheet's id first and discards NOTHING until every
refusable step has passed: the model, `resolveFiltersFor` (while the source page still exists), the bake, the
compile; for a chart the dry run, the chart-store check and the spec check (2.8); for a table a pre-flight of the
compiled query. Only then it re-reads the sheets, and if that id is still listed and still ephemeral awaits
`core.sheet.discardEphemeral`; a `false` answer stops the run quietly (the command already explained). Residual: a
table that passes the pre-flight can still exceed Rust's 100 000-row cap after the discard (the cap stays ONE Rust
constant). `toSheet` refuses while the active sheet is ephemeral regardless (2.5).

### 2.8 Presentations (D10, D11)

- **Table** = a WORKSHEET of static cells: the title, the caption lines, then the view under the grid report theme,
  merges inserted. A kept table is a snapshot; promoting it to a live grid report through `restore_report` is a
  follow-up (owner question 8).
- **Chart** = a CANVAS (default layout, 1280x720) appended empty and activated by the backend. Before ANY sheet is
  added the runner dry-runs the query (`run_design_query`), asks the Charts seam for the complete spec
  (`IChartStoreService.buildDesignQueryChartSpec({ dslText: baked, connectionId, mark, markOptions?, title })`, built
  from the ONE Charts-owned default skeleton `buildDefaultSpec` also uses -- no copy of Charts' defaults lives
  outside Charts) and checks it (`IChartStoreService.validateChartSpec`, the same check `createChart` runs), so a
  failing query or a refused spec never leaves an empty temporary page. Then `toSheet`, `activateSheet(index,
  { record: false })` and `createChart(spec, { x 16, y 16, 1248 x 688 })`. Title: `<name>: <labels of the clicked
  path>`. The result is an ordinary design-query chart on an ordinary canvas.

### 2.9 Doors, authoring, read-only (D13, D14)

- **Chart right-click** (`ChartContextMenu.tsx`, design-query charts only). Run row `drillThrough`, labelled with
  the datum it acts on -- `Drill through: <labels>` -- FIRST among the element verbs when the subject is a datum or
  legend entry; tooltip = the definition's name; disabled with the reason when the datum has no identity (2.3).
  Authoring row `drillThroughBehavior`, **"Drill-through behavior..."**, between "Edit data..." and "Edit
  Script...", opening `chart:drillThroughBehavior` with radios **None | Design query**; Save =
  `runInUndoTransaction("Edit drill-through", ...)` with `updateChartSpec(chartId, { drillThrough })` + invalidate +
  sync + CHART_UPDATED + `flushPendingChartSavesQuietly`; None passes `drillThrough: undefined`. The datum
  double-click is NOT changed (Excel's Format Data Series; owner question 6).
- **Pivot.** The value-cell item `pivot:showDetails` reads "Drill through" when the pivot carries a design-query
  drill, else "Show Details". That fact rides the REGION transport (`PivotRegionData.hasDesignQueryDrill`, filled in
  Rust where regions are built), so the very first right-click of a never-selected pivot or canvas box is right; a
  dialog Save patches the cached region at once. (The first build read the behaviour through a cache that was cold
  on a first right-click; the review proved the canvas box menu always said "Show Details".) The double-click and
  the menu item both run `runPivotDrillThrough`, which branches on `behavior?.designQuery` BEFORE the script branch:
  `pivotContext` -> `runDrillThrough` with `{ filters: path, standing, notices }`; the runner tells the notices once,
  after the sheet lands. The canvas box under a cross-filter keeps refusing. Authoring is a 4th radio **Design
  query** in the existing "Drill-through behavior..." dialog (at least 640 px wide while it is active); a muted line
  explains when the cached model is in use and the assist is off.
- **Shared editor** `_shared/drillThrough/DrillThroughDefinitionEditor.tsx`: name, the shared `DesignQueryEditor`,
  the presentation picker (Table | Chart; the marks DERIVED from `@api/chartMarks` and filtered to those the Charts
  seam can create -- a `sandbox:` mark the ChartSpec pattern refuses is NOT offered; only a refused mark a definition
  already STORES is listed, disabled, with "cannot be created"), Keep filters, a note, and a read-only mode. It does no IPC of its own: the caller passes its
  bound invoker (`_shared` has no `activate()` to bind a channel).
- **Read-only** (a subscribed page or sheet): the authoring row reads "View drill-through..." on a chart and "View
  drill-through behavior..." on a PivotTable, and opens the same
  dialog read-only. Running stays available. Canvas = `getLayoutSurface(idx)?.editable === false`; worksheet =
  `@api/collaboration isSheetSubscribed(sheetId)`, a synchronous registry Collaboration publishes into.

### 2.10 Prerequisite: subscribed design-query charts find their model (D15, BUG-0588)

Nothing remapped a chart's `connectionId` on a pull; pulled data sources get FRESH connection uuids
(`calp_commands.rs`) and are re-minted on EVERY open (`restore_application_bi_connections`); pivots re-bound
through `data_source_id`, slicers self-healed, charts did neither. Fix, in two halves:

- **Re-bind** (`core/calp/src/chart_refs.rs remap_chart_spec_connection_ids`, host `remap_chart_bi_connections`):
  `DesignQueryDataSource.packageDataSourceId?: string` is the STABLE key; a source resolves by it first, else by its
  old `connectionId` string against the data-source map, and on a hit both fields are written. Run at the three
  points where the map exists: after `load_embedded_data_sources` in `materialize_pull_result` (subscribe AND
  checkout), after the refresh map, and inside `restore_application_bi_connections` on open.
- **Stamp at save** (`stamp_chart_spec_package_keys`, called from `collect_charts_for_save` -- the one place the
  `.cala` save, AutoRecover and the `.calp` publish / preview / working-copy diff serialise charts): every saved
  design-query source whose `connectionId` names a LIVE connection is keyed, and a uuid that names no live
  connection is left as it is. WHICH key is the file's (`ChartKeysFor`): the `.cala` save writes the application
  data-source id the connection was minted from (removed for a local connection), which the next open answers to;
  the `.calp` carrier writes the id the data source is filed under in THAT package, the connection's own id, through
  the one `published_data_source_id` the capture of the data sources uses too. They differ after a checkout, which
  mints its connections from the previous version's data sources while the push files them under new ids: stamping
  the package key on the carrier bound an existing subscriber's chart to the connection still serving the previous
  version (verification round, section 7). Applied to the saved copy only, never to `state.charts`. What this does NOT
  fix is BUG-0589: a working-copy push files the data SOURCE under that new id too, while pivots, model slicers and
  ribbon filters keep the previous key -- so at an existing subscriber the charts follow the new version while those
  stay on the previous one (and page slicers stop filtering the charts), and every subscriber loses the ribbon
  filters. The stable published id that fixes it is filed with its change list (open-items 2.aq). This is what makes a key exist on a chart no TypeScript writer stamped (the
  drill's result chart, Insert Chart, a script, the AI) and what keeps a stale key from re-binding a chart the user
  re-pointed to a local connection. The TypeScript writers keep or clear the key on a connection change
  (`Charts/lib/designQuerySource.ts`), so the in-session store never carries a stale one either.

### 2.11 Audit, scripts, locale

- **No audit row for a run in v1**: the trail spans script activity and capability calls, not user actions, and a
  not-code artifact's transparency is listing (wave3 12.1) -- the same standing as `run_design_query`. The filed
  decision that the pivot module records nothing (open-items 2.1) gains `drill_through.rs` in its scope.
- **Scripts**: the chart key is writable through `chart.updateSpec` and bounded by the extension schema (2.1).
- **Locale**: captions and titles show labels (2.3); the DSL carries keys (invariant, on disk only).

## 3. Types

```rust
// app/src-tauri/src/pivot/types.rs
pub struct DrillThroughBehavior {
    pub kind: DrillThroughKind,                      // Builtin | Query | Script, unchanged
    pub query: Option<DrillQueryOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_query: Option<DrillDesignQuery>,      // present => wins
}
pub struct DrillDesignQuery { pub dsl_text: String, pub presentation: DrillPresentation,
    pub name: Option<String> /* skip if none */, #[serde(default = "default_true")] pub keep_filters: bool }
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DrillPresentation { Table, Chart { mark: String, mark_options: Option<serde_json::Value> } }
// PivotRegionData gains #[serde(default)] has_design_query_drill: bool

// app/src-tauri/src/drill_through.rs
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DrillThroughRequest {
    PivotContext { pivot_id: PivotId, group_path: Vec<(usize, u32)> },
    ToSheet { name: String, #[serde(default)] title: Option<String>, presentation: DrillSheetPresentation,
              #[serde(default)] query: Option<DesignQueryRequest>, #[serde(default)] caption: Vec<String> },
}
pub enum DrillThroughResponse {
    PivotContext { connection_id: ConnectionId, package_data_source_id: Option<String> /* skip if none */,
                   filters: Vec<DrillFilterSpec> /* the clicked path */, standing: Vec<DrillFilterSpec>,
                   notices: Vec<PivotNotice> },
    ToSheet { sheet_index: usize, sheet_name: String, sheet_id: String, row_count: u32, col_count: u32 },
}
pub struct DrillFilterSpec { pub field: String, pub included_keys: Option<Vec<String>>,
                             pub hidden_keys: Option<Vec<String>>, pub labels: Option<Vec<String>> }

// app/src-tauri/src/sheets.rs
pub fn keep_ephemeral_sheet(state, sheet_id: String) -> Result<SheetsResult, String>;
pub fn discard_ephemeral_sheet(app, state, file_state, /* the delete_sheet states */, sheet_id: String)
    -> Result<DiscardedSheet /* { deleted_index, deleted_name, result } */, String>;
pub fn delete_sheet(/* states */, index: usize, expected_sheet_id: Option<String>) -> Result<SheetsResult, String>;
pub(crate) fn delete_sheet_impl(/* states */, index: usize, allow_object: bool, expected: Option<SheetId>) -> ...;
pub(crate) const SHEETS_CHANGED_UNDER_THE_DELETE: &str;

// app/src-tauri/src/persistence.rs, calp_commands.rs
pub enum ChartKeysFor { Document, Package }  // build_workbook_for_save(state, files, bi_state, chart_keys_for)
pub(crate) fn published_data_source_id(connection_id: &ConnectionId) -> String;  // capture AND carrier keys
pub(crate) struct EphemeralUserSheet { pub sheet: NewUserSheet, pub refusal: &'static str }
```

```ts
// app/src/api/drillThrough.ts (re-exported from @api; the ONE TS shape)
export type DrillPresentation = { kind: "table" } | { kind: "chart"; mark: string; markOptions?: Record<string, unknown> };
export interface DrillThroughDefinition { dslText: string; presentation: DrillPresentation; name?: string; keepFilters?: boolean }
export interface DrillFilterSpec { field: string; includedKeys?: string[]; hiddenKeys?: string[]; labels?: string[] }
// + DrillThroughRequest / DrillThroughResponse mirrors, drillKeepsFilters, drillThroughDisplayName,
//   drillThroughSheetName, DRILL_THROUGH_DEFAULT_SHEET_NAME
// pivotTypes.ts: DrillThroughBehavior.designQuery?, PivotRegionData.hasDesignQueryDrill
// Charts/types.ts: ChartSpec.drillThrough?, DesignQueryDataSource.packageDataSourceId?
// chartData.ts: ChartRightClickTarget.memberPath / memberLabels / drillIdentity / drillIdentityReason
// componentStoreRegistry.ts: IChartStoreService.buildDesignQueryChartSpec / validateChartSpec
// reportFilters/types.ts: ResolvedFieldFilter.workbookWide
// core/lib/tauri-api.ts: SheetInfo.ephemeral?, keepEphemeralSheet(sheetId), discardEphemeralSheet(sheetId),
//   deleteSheet / setActiveSheet(index, { record? }); api/sheetSwitch.ts: activateSheet(index, { record? })
// api/collaboration.ts: registerSubscribedSheetsProvider / isSheetSubscribed
```

API version 1.6.0 (`app/src/api/version.ts`; `docs/EXTENSION_GUIDE.md` "New in API v1.6.0").

## 4. Naming

Identifiers: `drillThrough` / `DrillThrough` / `drill_through`. Labels: the RUN row is "Drill through" (Power BI's
verb); the AUTHORING row is "Drill-through behavior..." on both families. The one-word form survives only in the
file name `pivot-drillthrough-customization.md` and the sheet name "Drillthrough".

## 5. Gates and proof

`npm run check-types`; the full vitest suite; `npm run lint:boundaries`; the app-crate unit suite (4167 / 0 at the
end of the build; 4120 at the baseline); `cargo test -p calp -p pivot-engine` in `core/`. The live proof is
`app/e2e/journeys/drill-through.spec.ts` on the serverless sales-star CSV fixture (`canvas-powerbi.spec.ts`'s
recipe), oracles from `designQueryOracle`, never typed in, and never a golden:

| Step | What it proves |
|---|---|
| J1 | right-click a category bar -> "Drill through: Gadgets" -> a temporary worksheet whose table equals the oracle |
| J2 | leaving the drill sheet removes it, by id |
| J3 | a double-click on its tab keeps it; it survives a leave |
| J4 | the chart presentation: one chart on a temporary canvas whose query carries `[Product.Category] = ("Gadgets")` |
| J5 | the pivot's value cell offers "Drill through" (not "Show Details") and drills to the same oracle |
| J6 | a transformed chart's row is disabled with a reason and drills nothing |
| J7 | Insert Sheet before the first tab while on a temporary sheet removes ONLY the temporary sheet (review blocker 1) |
| J8 | a formula's reference pick on another sheet keeps the temporary sheet it is written on (review blocker 2) |
| J9 | a never-selected canvas pivot box offers "Drill through" on its first right-click, and drills |

Sabotages SB1-SB10 are listed in the journey header; each was run once against the live app and its named
assertion seen red (section 7).

## 6. Owner questions (also in open-items 2.aq)

1. Save while an ephemeral sheet exists: keep-on-save (chosen); or clear the flag on save; or delete on BEFORE_SAVE?
2. Create and leave END the undo history and DIRTY the document (Excel parity; a read-only drill still prompts to
   save). Acceptable for frequent drills, or should leave re-arm a clean flag when it was clean before?
3. Hiding or moving an ephemeral sheet: hide = leave = delete, move keeps the flag, copy makes a permanent sheet (chosen).
4. `get_sheets` and the MCP sheet inventory list `ephemeral`; the AI sheet summary reads the stores directly and
   does not. Thread it, or leave it?
5. A kept sheet in a subscriber's workbook enters the default publish selection as a local sheet (expected).
6. The chart datum double-click stays Format Data Series; drill-through is right-click only (Power BI parity).
7. Filter level is not carried: a pinned (level 2-9) page filter runs at slicer level in the drill. Add a
   `(level N)` spelling to the FILTERS grammar?
8. Promote-on-keep: a kept TABLE becomes a live grid report (`restore_report`) -- not built.
9. Tab look: italic name + tooltip (chosen); a mockup round if the owner wants to compare.
10. Protect Workbook Structure refuses the drill (it adds a sheet): a published application with it on loses the feature.
11. Listing drill definitions in the AI sheet summary / an inventory (wave3 12.1's "every one is listed") -- the
    read-only dialog is the v1 listing.
12. Raw switch doors (Insights pane, command line) produce a LATE leave; route them through `@api/sheetSwitch`?
13. After a working-copy checkout the push review lists every design-query chart as modified although nobody edited
    it: the carrier keys each source by the push's own per-session data-source id, which differs on every push. A
    package-key comparison needs BUG-0589's stable published id first; accept the listing until then, or land it?
14. Keep filters on a PIVOT source: the page's model slicers and ribbon filters are folded into the pivot by the
    backend AND resolved again as page filters, so a header override that leaves more members visible than the
    page filter is narrowed back. Should a pivot source skip the page filters its standing filters already carry?
15. A header "Select None" on a pivot reaches the drill as a hidden-only list covering every member, which keeps
    nothing; only `pivotContext` can see that (it has the member list). Refuse it there with "the source shows no
    members here"?
16. `sandbox:` chart marks are offered by the mark registry but refused by the ChartSpec mark pattern (the drill
    editor leaves them out; a stored one is listed disabled with "cannot be created").
17. A publish with NOTHING ticked includes every user sheet, so a temporary drill sheet that exists at that moment ships
    to every subscriber. Leave temporary sheets out of the default selection (and show them unticked), or keep it? Widen the pattern, or keep them out of chart specs?

## 7. As built (2026-10-23)

**The build** ran as six work packages on disjoint files against fixed contracts (Rust core; Rust re-bind; the
@api + shared layer + DSL fixes; the tab strip; Charts; Pivot). Two packages stopped on a usage limit without a
report; their code was reviewed as unreviewed. One cross-package contract mismatch was found by reading the
reports side by side and fixed before review: the runner sends complete caption lines while Rust prefixed
"Filtered to:" and joined them, which would have printed "Filtered to: Filtered to: ...".

**The review** (six scopes: Charts, Pivot, shared layer, tab strip, Rust, contracts and the E2E journey; each finding
verified by two refuters) confirmed 32 findings. The two blockers were both in the tab strip's leave observer: it
deleted by the index a mid-flow read reported (Insert Sheet on the first tab while on a temporary sheet deleted a
user sheet), and it treated a formula's cross-sheet reference pick as a leave (the sheet being edited was deleted
with the editor open). The majors: no writer of `packageDataSourceId` and a stale key reverting a re-point; the
pivot label cold on a first right-click; the drill-from-drill discard running before every check that could still
refuse; a pivot's workbook-wide standing filter baked into a chart; a copied Charts default recipe in `_shared`; a
values-only pivot that could not drill.

**The fix round** closed every confirmed finding; the decisions above are written as fixed. What changed against
the first agreement:

- the discard and the keep address a sheet by its STABLE id in the backend (`discard_ephemeral_sheet`, new;
  `keep_ephemeral_sheet` takes the id), and the observer pauses on any open edit and on the strip's own two-step
  flows (2.7);
- the ephemeral flag is set INSIDE `append_user_sheet` under its locks, and `toSheet` re-checks its gates after the
  query (2.5);
- the package key is stamped at save time in Rust as well as re-bound on pull, refresh and open (2.10);
- the pivot label rides the region transport instead of a read-through cache (2.9);
- the runner discards a temporary source sheet only after every refusable step, takes the chart spec from the
  Charts seam and validates it before any sheet is added, splits a pivot's clicked path from its standing filters,
  and tells notices only after the sheet landed (2.4, 2.7, 2.8);
- the bake refuses an inclusion its exclusions cancel; the `@param` scanner skips bracketed names (2.4);
- `toSheet` carries a separate `title`; `FirstFree` names stay within 31 characters (2.5);
- the definition schema's chart presentation follows ChartSpec's mark pattern and options narrowing (2.1);
- the editor offers only marks the Charts seam can create (2.9).

**Live sabotages left by a stopped agent.** Three fix packages stopped on a session limit mid-way through proving
their tests had teeth. Twelve of their temporary breaks were still in the tree when the round ended, all in Rust:
the synthetic-Total skip, the MCP marker, the append-time refusal, the discard's "not temporary any more" refusal, an
off-by-one in the id-to-index lookup, a keep that answered an unknown id with Ok, the clicked path pushed into the
standing list, the package key filtered out, the post-query gates deleted, the title ignored, the `FirstFree`
shortening bypassed, and the `list_sheets` description missing its marker. Each was found by a pattern scan or by
the test it was aimed at, restored, and the full suites re-run green. Every later sabotage proof went through a
harness that backs up the file, marks the break and restores from the backup, with a final check that no marker is
left.

**The verification round.** A read-only reviewer per stopped package (the Rust sheet and drill core; the region
flag, the save-time stamp and the re-bind; the tab strip) hunted for breaks no test covers and re-checked every plan
item; two refuters judged each finding. No live sabotage was left. Of nine findings, eight were confirmed and fixed
the same day, each new or strengthened test seen failing with its fix broken:

- the `.calp` carrier stamped a chart with its connection's PACKAGE key, which after a checkout names the previous
  version's data source while the push files the data source under the connection's own id: an existing
  subscriber's refresh bound the chart to the connection still serving the previous version (major; fixed by
  `ChartKeysFor::Package` and one `published_data_source_id`, 2.10);
- the discard's id lookup and the delete's locks had a window an MCP move could fall into, deleting a user sheet
  (fixed: `expected_sheet_id` checked under the delete's pending locks, 2.5);
- the door's discard could land between a strip flow's two steps; conversely a Move or Copy started while a
  discard was in flight copied the wrong sheet (fixed both ways, 2.7; the third round extended it to every door);
- `get_pivot_at_cell` kept its own "Total" test, so a calculation group named Total vanished from the field list
  (fixed: the shared `is_synthetic_total_row`, itself made exact by a field marker in the third round);
- the object-dependency census could not see a delete that delegates (fixed: `DELETE_COMMANDS_BY_DELEGATION`,
  checked by what the command calls);
- the drill's undo assertion ran on an empty stack and could not fail, and two refused-discard branches had no
  test (fixed).

The ninth, a lock assertion called vacuous, was refuted: it pins the owned return type, and now says so.

**The third round** (a review of the verification fixes: four reviewers, refuters per finding, 28 confirmed, none
refuted). The tab strip's OTHER index-addressed doors raced the background discard the same way -- a Delete
confirmation open when a discard landed deleted the sheet that slid into the index, with no undo -- so every door now
goes by id (2.7). The floating-range delete door now passes its backing sheet's id, and the object door refuses a
non-object sheet; the MCP `delete_sheet` passes the id it read with the name and tells the agent to re-list on a
renumbering; the subscribed-sheet refusal answers about the sheet the caller meant; a sheet delete clears the filters of
only the slicers it actually removed. The synthetic Total rule read the MODEL's group names, so a model with an unplaced
group named "Total" made a values-only pivot's row read as that group (the refresh asked for it, the drill refused it,
the pane listed a chip the next edit turned into the group): the row is now marked on the field. Three majors traced to
one pre-existing cause -- a working-copy push re-keys every data source -- which was investigated and filed as
BUG-0589 rather than built here, because it changes the collaboration identity contract and needs three owner
decisions. Each new test was seen failing with its fix broken (61 sabotages across the two implementation packages).

**The fourth round** (a review of the third round: three reviewers, 10 confirmed, none refuted). The major one is the
open-edit renumbering above (2.7), fixed in Core so that every source of renumbering is covered, not only the discard.
The script `api.deleteSheet` and the command line's `delete sheet` resolved a name to an index and then deleted by that
index: both now send `expectedSheetId`. The strip re-checks the structural lock after a door's wait, disarms a drag at
mouseup, applies the drag through the current result handler, and refuses a malformed index instead of acting on the
active sheet. In Rust, carried pivot settings now match a field by name AND the synthetic marker (a calculation group
named "Total" no longer inherits the synthetic row's sort), and the last-sheet, out-of-range and last-visible refusals
of a delete come before the document is marked dirty. 72 sabotages across the three packages each turned their test red.

**The fifth round** (a review of the fourth: three reviewers, 7 confirmed, none refuted). Two were regressions of the
fourth round: identity by NAME refused an entry whose sheet was renamed during a formula-bar edit, and disarming a drag
at mouseup let the click that follows a drop switch sheets or toggle a group. Both are fixed (identity by the stable id;
a finished drag is never a click). Also fixed: grouped-sheet copies after a point-mode commit excluded the sheet the user
pointed at instead of the edit's own sheet (pre-existing), and a shortfall is now loud; `EDIT_STARTED` reports the
rebased index; the strip decides an external session's host tab by identity; `core.sheet.*` refuses non-object
arguments. In Rust, `sheet_names` and `sheet_ids` were taken in opposite orders on the MCP thread and the main thread, so
an AI agent's delete overlapping a Refresh or Detach could hang the app (pre-existing, BUG-0590): every site now takes
`sheet_names` first, enforced by a census and two runtime probes. 55 more sabotages each turned their test red.

**The sixth round** (a review of the fifth: two reviewers, 6 confirmed, none refuted). The major one was a pre-existing
deadlock: Refresh preview held the subscription and override stores while waiting for the sheet locks, the reverse of
every cell write, and some cell writers run off the main thread (BUG-0591, with the Application Explorer, the override
export and the save / publish builders found by the same census). Also fixed: a floating-grid entry committed when its
host was renumbered; a switch back that threw dropped the entry without showing it; the tab click's dead drag rule;
every sheet id / name pairing in the calp code now reads both under one hold; and the deferred carrier-test hygiene of
the second round (the wiring pin checks every key copy, and a test proves the captured data-source ids equal the carried
keys). Two cycles found through calls and nine torn reads outside those files are BUG-0592. 27 more sabotages each
turned their test red.

**The seventh round** (a review of the sixth: two reviewers, 1 confirmed, none refuted; the floating-grid and commit
changes came back clean). Releasing the save's sheet locks early -- the sixth round's deadlock fix -- let a structural op
running off the main thread (this feature's own asynchronous sheet add, an MCP delete) land inside a save, AutoRecover or
publish and tear the snapshot (an object sheet saved as a visible canvas, formats filed under the next sheet). Now the
save's body holds grid then grids from its first store read to its last -- deadlock-free, because every mutator takes
grid first and the census forbids taking grid while holding anything else -- and the tails that cannot hold them are
validated by `AppState::sheet_structure_generation`, bumped by every renumbering: an attempt that saw a renumbering is
taken again, up to three times, then refused with a retryable message (AutoRecover skips the tick). A transitive lock
walk proved the body's held region takes neither grid lock again; it also found a pre-existing deadlock between a table
slicer's item fetch and a cell edit (BUG-0593). Two runtime probes park the save inside its body and inside its tail
while an add or a delete runs on another thread, each with a partner that shows the tear on the old shape.

**The eighth round** (a review of the seventh: one reviewer, 5 confirmed, none refuted). The major one: a publish,
preview, working-copy diff or merge retook its snapshot after a renumbering but kept the sheet POSITIONS it had resolved
before the first attempt, so a retried attempt could ship whatever sheet slid into a ticked position -- this feature's
temporary sheet to every subscriber, or a floating range without its backing sheet. The selection now travels as stable
sheet ids, each attempt maps them through its own snapshot (a ticked sheet that was deleted refuses retryably), and every
later step uses the attempt's own positions. Each door names its own act in the refusal ("published", "previewed",
"compared", "merged"), and the frontend never shows the raw code: one recogniser (`@api/backendRefusal`) turns it into
the plain sentence, the push dialog offers Try again, Save and the close path show it, and AutoRecover shows one notice
after three refusals in a row. The tail probe now proves it exercises the retake, and a census proves every renumbering
bumps the counter inside its own `sheet_names` hold. A rename's name-keyed repairs after it releases the locks are filed
(pre-existing).

**The ninth round** (a review of the eighth: two reviewers, 8 confirmed, none refuted). The non-modal Publish dialog
still sent sheet POSITIONS from the list it read when it opened, so a tab moved while it was open -- or a temporary
sheet's background discard -- handed the ticks to other sheets, and Try again resent the same positions (pre-existing,
made easy to reach). The dialog now keys its ticks by stable sheet id and sends `sheetIds`, which the push, the preview
and the diff resolve inside the validated selection; a ticked sheet that is gone refuses by name. Also fixed: a refused
merge analysis re-ran itself in a loop; re-showing the subscriber diff after a refusal hung on "Comparing..."; the
AutoRecover notice stacked; a position past the end and a resolver error during a renumbering were misreported. Remove
Password's ordering is only partly fixable in TypeScript and is filed. 43 more sabotages each turned their test red.

**Rounds ten to twelve** (reviews of the ninth, tenth and eleventh: 5, 4 and 2 confirmed, one major each in the first
and last). The ninth round's re-read of the sheet list after a gone-sheet refusal cleared every cell the author had
unticked in "Changes since vN", so the next Push shipped them; and a sheet the push carries without a tick (a floating
grid's backing sheet, a chart source) parked its unticks so they never acted. Unticks are now kept by the reducer in
`lib/holdBack.ts`, sorted by the sheets the diff answer says the push carries (`WorkingCopyDiff.carriedSheetIds`),
and Push sends all of them with its own selection to `calp_hold_back_cells`, which resolves it through
`resolve_publish_selection` and holds back exactly the cells on carried sheets (`cellsSkipped` for the rest). Also: a
position no list shows is refused as `CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE` (not the retryable code); a re-show re-reads
the list; push, merge and Preview are single-flight; AutoRecover's notice stays up for the whole streak and is
withdrawn through the new `ToastHandle` (also when AutoRecover is switched off).

**The proof.** All gates green at the end: `check-types`, `lint:boundaries`, the app-crate suite 4167 / 0, `calp`
619 / 0, `pivot-engine` 131 / 0, vitest 129 690 passed (one failure, `e2e/__tests__/noClippedCapture.test.ts`, is in
the writeback journeys of the previous commit, not this feature). The journey J1-J9 passed live; SB1-SB10 each
turned its named assertion red and was restored.

**Residuals** (also in open-items 2.aq): BUG-0589 (a working-copy push re-keys every data source; pivots, model slicers
and ribbon filters lose their model at subscribers); an open edit follows its sheet by id, but undo / redo's sheet follow carries
no id, sheet grouping is stored by index, and a delete of the edit's own sheet in the one IPC gap before the write would
still land elsewhere; the clipboard's source index goes stale on a renumbering; the tab menu offers
Delete on the last visible sheet; the Tab Color palette, a plain tab click and the MCP rename / move
are still index-addressed, and `rename_floating_range` renames by index; a delete clears slicer filters by a store
re-read rather than the ids it removed; Core's view cache hands a removed sheet's view to the next inserted one; other
pivot code still tells a calculation group by name; the table's row cap can refuse after a drill-from-drill discard
(2.7); the
Insert Chart dialog still seeds its own axis / legend / palette literals instead of the shared skeleton (a parity
test pins them equal), and on a new-chart open it does not reset axis / palette / title from the previous open;
`normalizeChartSpec` keeps its own repair defaults; the Rust fixture `pivot/types.rs` drill round-trip test uses a
legacy `{ stacked: true }` bar option (opaque to Rust, cosmetic).
