# Paginated Grid Reports — Design

Status: **Slices 1/1b/1c (create/refresh/delete + persistence + undo), 2 (@param
interactive filters), 2b (ribbon-filter targeting), 2c (hardening pass: grammar,
structural ops, error surfacing — see below) and 4 (.calp distribution) are BUILT.
Slice 3 (pagination) deferred — likely a separate report form.** Decisions locked:
committed/pivot-like model (D1), single row-capped block (D4).
User docs: "Using a design query in a grid report" in
`functions/pivot/design-view-reference.md`.
Related: `docs/design/model-editor.md`, `functions/pivot/design-view-reference.md`,
`docs/design/animation-simulation.md` (transient-write precedent),
`docs/design/calp-distribution.md`.

## Context

Phases 1–2 grew the pivot "design language" (DSL) into a general query language:
transform functions in `CALC` (Phase 1), and a **headless design-query executor**
(`run_design_query`) that a chart can hold as its data source (Phase 2). Phase 3
is the third consumer the user asked for: **a report materialized straight into
the grid** — "make a report directly from the source into the grid," with no
pivot table object in between.

The user flagged this feature as **not fully developed** ("for example, how
filters should be handled"), so this doc frames the design space, makes
recommendations grounded in the existing code, and proposes a phased build. It
ends with the decisions needed before implementation.

## What a report is

A **report** is a named object that:
- holds a **design query** (pivot-layout DSL) + a **model binding** (connectionId),
- **materializes** its tabular result into a **grid range** at a destination
  (sheet + anchor cell), styled like a pivot's output,
- **refreshes** on demand / on data change, re-writing that range,
- **persists** in `.cala` and can be distributed in `.calp`.

Unlike a pivot, a report has no interactive pivot chrome (no drag-drop field
list, no in-grid collapse/expand). It is a "query → block of cells" object. Over
time it grows print/pagination semantics (the "paginated" in the name).

## Foundations we reuse (verified in code)

| Need | Reused mechanism | Location |
|------|------------------|----------|
| Compute the query | `run_design_query` compute core (compile DSL → `PivotDefinition` + `PivotCache` → `PivotView`) | `app/src-tauri/src/pivot/headless.rs` |
| Write result to cells | `write_pivot_to_grid(grid, active_grid, view: &PivotView, dest, styles)` — **generic**, not pivot-specific | `app/src-tauri/src/pivot/operations.rs:527` |
| Update/clear a region | `update_pivot_in_grid` (clear old region + write new) | `operations.rs:733` |
| Overwrite protection | `count_overwritten_cells` / `save_overwritten_cells` → `overwrittenCellCount` warning | `operations.rs:1108` |
| Refresh without undo pollution | transient-write: `anim_snapshot`/`anim_apply_frame`/`anim_restore` (token-keyed buffer, scoped recalc, no undo/dirty) | `app/src-tauri/src/animation_commands.rs` |
| Object persistence | mirror `SavedPivotLayout` (`AppState.pivot_layouts`, included in `build_workbook_for_save`) | `persistence.rs`, `core/persistence` |
| Undo for object mutations | `record_custom_restore` + handlers (`pivot_create`/`delete`/`definition`) | `undo_commands.rs:644`, `pivot/commands.rs:32` |
| Distribution (.calp) | generic `custom_objects` channel `{kind,id,name,sheet_id,payload}` (pane-controls precedent) | `core/calp/src/{manifest,publish,pull}.rs` |
| Interactive filter values | `GET.CONTROLVALUE("name")` + pane controls; ribbon-filter → pivot targeting | `pane_control/`, `ribbon_filter/` |
| Refresh events | `GRID_REFRESH`, `MUTATION_REFRESH{domains}`, `BiEvents.REFRESHED`, `pivot:refresh` | `app/src/api/events.ts` |

**Key insight:** `run_design_query` already builds a `PivotView` and then converts
it to a `PivotViewResponse`. Factor the compute into a shared
`compute_design_query_view(request) -> (PivotDefinition, PivotCache, PivotView)`;
`run_design_query` returns the response (charts), and a new report command writes
the same `PivotView` to the grid via `write_pivot_to_grid`. **No new write path
is needed.**

## Design decisions (with recommendations)

### D1 — Report model: committed (pivot-like) vs transient (overlay) — **Recommend: committed**

- **Committed / pivot-like (recommended):** the report writes **real cells** into
  a protected region (like a pivot's output). Cells are formula-referenceable,
  overwrite-guarded, undoable (create/refresh/delete via `record_custom_restore`),
  and saved as ordinary grid content. This matches "a report **in the grid**" and
  Excel/paginated-report intuition, and reuses the pivot region + undo machinery
  wholesale.
- **Transient (rejected for v1):** cells live only as an overlay that
  re-renders on refresh (animation model). Good for previews, wrong for a
  persistent, printable, formula-referenceable report.

The refresh itself is *undo-light* (as built in Slice 2c): manual refreshes
record one undo entry each; **control-driven auto-refreshes skip the undo entry**
unless the write reaches non-empty cells outside the report's previous region
(then it must stay recoverable). This keeps Ctrl+Z on the user's own actions —
clicking through five filter values does not flood the stack, and undoing a
filter change re-syncs the report via the value-diff events (below) instead of
via undo history.

### D2 — Object identity & storage

*(As designed — superseded in the build, see Slice 1b:)* the shipped shape is
`SavedReport { id, name, dslText, connectionId, sheetIndex, anchor/end bounds,
dataSourceId }` in `AppState.report_definitions`, mirrored into
`extension_data["calcula.reports"]`; there is no separate `ReportState` and no
`refreshMode`/`options` field yet (refresh is manual + control-driven auto). A
`protected_regions` entry (region_type "report") tracks the materialized range.

### D3 — Filters — **Recommend: v1 = fixed inline `FILTERS`; interactive filters as a dedicated later slice**

This is the part the user called out as unresolved. Three layers, delivered in order:

1. **v1 — inline `FILTERS:` (fixed).** The DSL already supports
   `FILTERS: dim_product.style = ("W")`. A v1 report is fully specified by its DSL;
   no interactive filtering. Simple, ships the core value.
2. **Later — control-bound filters.** Bind a report's filter field to a **pane
   control** (dropdown/slider). Two possible mechanisms, to be chosen when we build it:
   - *(a) Parameter substitution:* the report declares `FILTERS: dim_product.style
     = @StyleControl`, and materialization substitutes the control's current value
     before compiling. Keeps the DSL declarative; needs a small parser addition
     for `@name` params. **Leaning this way.**
   - *(b) `GET.CONTROLVALUE`:* allow the FILTERS clause to call
     `GET.CONTROLVALUE("StyleControl")`. Reuses the existing control-value engine,
     but the DSL FILTERS grammar currently takes literal value-lists, not
     function calls — would need grammar work and a value-resolution hop.
3. **Ribbon-filter target. ✅ BUILT — via the `@name` pull model, not a push target
   list.** A report references a ribbon filter by name exactly like a pane control
   (`FILTERS: dim_product.style = @RegionFilter`), so one workbook-level filter can
   drive pivots **and** reports of the same connection. This reuses (2a) rather than
   generalizing the ribbon-filter "connected pivots" push list to "connected objects,"
   because the pull model is explicit (the report author picks *which* field the
   filter maps to) and needs no per-report connection bookkeeping. The one missing
   link was that a ribbon-filter selection change fired only the internal
   `FILTER_SELECTION_CHANGED`, not the app-wide `CONTROL_VALUE_CHANGED` that
   `@api/controlValues.onControlValueChange` consumers (reports) observe — even
   though ribbon filters were already enumerable via `listControlValues`/
   `getControlValue`. Completing that facade event (in `filterPaneStore`'s
   `updateFilterSelectionAsync`) makes a ribbon-filter change auto-refresh any
   `@`-bound report, the same way it drives pivots. The report editor now offers
   `@Name` autocomplete listing both pane controls and ribbon filters.

Inline `FILTERS` and any external filter **merge by intersection (AND)** — the
same rule pivots use today.

### D4 — Pagination — **Recommend: v1 = single materialized block (row-capped); true pagination as a later slice**

- **v1:** materialize the whole result as one contiguous block, with a **row cap**
  (e.g. a configurable max, `log()`-style warning when truncated) so a runaway
  query can't fill a sheet. This is a "grid report," not yet "paginated."
- **Later — real pagination:** add `page:{offset,limit}` to
  `compute_design_query_view` (already anticipated) and a print-oriented layout:
  fixed page size, **repeated header rows per page**, page breaks, optional
  title/footer band. This is what earns the "paginated report" name and aligns
  with print/PDF export.

### D5 — Overwrite protection & destination

Reuse `count_overwritten_cells`: before writing, count non-empty cells the report
would clobber outside its previous region and surface `overwrittenCellCount`; the
frontend shows the existing "…will overwrite existing data" confirm. Destination =
sheet + anchor cell chosen at create (default: active cell), stored in the
definition; moving the report re-anchors + clears the old region.

### D6 — Refresh triggers

**Built:** manual **Refresh** (Manage Reports), and control/ribbon-filter change
events (`CONTROL_VALUE_CHANGED` → debounced, name-targeted, coalesced
auto-refresh of only the reports referencing the changed control). The
per-connection BI-model compile cache is invalidated on the BI connection/model
events (`app:bi-refreshed`, `app:bi-connection-*`). Auto-refreshes don't push
undo (except when they'd cover external cells — see D1).
**NOT built (future):** re-materializing on `BiEvents.REFRESHED` data changes,
and a per-report `refreshMode` (`manual` | `onOpen` | `auto`) gate — today the
data-change path requires a manual refresh.

### D7 — Persistence (.cala) & distribution (.calp)

- **.cala:** `SavedReport` in the workbook (parallel to `pivot_layouts`); the
  materialized cells save as normal grid content, and the definition rehydrates the
  live/refreshable object on load.
- **.calp:** publish each report on the generic **`custom_objects`** channel
  (`kind:"report"`, opaque JSON payload = the definition), restored on subscribe —
  exactly how pane controls already ride `custom_objects`. `data_source_id` rebind
  on pull mirrors pivots/ribbon-filters so a subscriber points at their own copy of
  the model.

## Phased build

- **Slice 1 — Materialize a report (core value). ✅ BUILT + verified live.**
  Backend: `compute_design_query_view` refactor (shared by charts + reports);
  `report.rs` module with `create_report` / `refresh_report` / `delete_report` /
  `list_reports` (materialize via the generic `write_pivot_to_grid`, `region_type
  "report"` tracking, overwrite counting, row cap, recalc); `ReportState` managed
  state. Frontend: a `Reports` extension with a "Report from Design Query…" Data-
  menu item + a create dialog reusing the **shared** Monaco design-query editor
  (moved to `_shared/dsl/pivotLayout/DesignQueryEditor.tsx`, `biModel` prop) +
  `compileDesignQuery`; destination = active cell. Fixed inline `FILTERS`, single
  row-capped block.
- **Slice 1b — Persistence. ✅ BUILT.** Reports persist via the sanctioned
  **`extension_data`** channel (key `calcula.reports`), NOT a new typed `.cala`
  field (per the `Workbook.extension_data` guidance). `SavedReport` (with region
  bounds) lives in `AppState.report_definitions`; `create/refresh/delete` mirror it
  into `extension_data`; the load path hydrates it and re-registers each report's
  protected region (`region_type "report"`) from its saved bounds (the cells
  themselves reload as ordinary grid content); new-file clears it. `ReportState`
  was dropped in favor of `AppState.report_definitions`.
- **Slice 1c — Undo. ✅ BUILT.** Undo/redo for create/refresh/delete via a single
  symmetric `"report_restore"` custom-restore (registered in `undo_commands.rs`,
  `change_class: Objects`). It is **cell-based** (mirrors `script_grid_cells`), not
  re-materialize — so it works offline: each op records the affected cells (before)
  + the report-definitions list; restore reverts cells + defs + regions (+ clears
  box merges) + syncs `extension_data`, and captures the current state as the
  inverse (redo). The create dialog's overwrite note points to Ctrl+Z.
  A true pre-write overwrite *confirm* (dry-run) is deferred — undo covers it for now.
- **Slice 2 — Interactive filters. ✅ BUILT (control-bound params).** A report's
  DSL `FILTERS` can reference a Controls-pane value with `@ControlName`. Done as
  **pure text substitution before compile** (no DSL grammar change):
  `Reports/lib/paramSubstitution.ts` replaces `@Name` with the control's current
  value as a DSL value-list (`("W")` / `("A","B")`), dropping a `FILTERS` line when
  its control is unset (= show all). `Reports/lib/reportRefresh.ts` substitutes →
  recompiles → `refresh_report` (with a per-connection model cache). The Reports
  extension listens on `@api/controlValues` `onControlValueChange` (skips transient
  mid-drag; debounced) and re-runs the `@`-bound reports. A new **Manage Reports…**
  Data-menu dialog lists reports with Refresh / Delete (Slice 1 had no management
  UI). Multiple `@params` per `FILTERS` line are substituted; if ANY of them is
  unset the whole line is dropped (documented in the user reference).
- **Slice 2b — Ribbon-filter targeting. ✅ BUILT.** A report bound via `@Name` to a
  **ribbon filter** now auto-refreshes when that filter's selection changes, so one
  ribbon filter drives pivots *and* reports (D3.3, pull model). Ribbon filters were
  already enumerable through `@api/controlValues` (`listControlValues`/`getControlValue`),
  and `paramSubstitution.isAll` already recognized the `"(All)"` sentinel (unset → drop
  the filter line). The only gap was the change event: `filterPaneStore`'s
  `updateFilterSelectionAsync` fired the pane-internal `FILTER_SELECTION_CHANGED` but
  not the app-wide `CONTROL_VALUE_CHANGED` that the Reports auto-refresh listener (and
  any other facade consumer) observes. It now dispatches a well-formed
  `CONTROL_VALUE_CHANGED` (id + name + value + `transient:false`) alongside the existing
  event — completing the `@api/controlValues` facade for the ribbon-filter family. The
  value derivation (`filterControlValue`: `(All)` / single Text / multi TextList) moved
  to `filterPaneStore` and is shared with `buildNamedControlList` (one-way dep). The
  report editor gained `@Name` autocomplete (`setDslEditorContext` third arg
  `controlHints`; the `CreateReportDialog` snapshots `listControlValues()` on open),
  listing pane controls **and** ribbon filters so the binding is discoverable.
- **Slice 2c — Hardening pass. ✅ BUILT (post-review, 46 verified findings closed).**
  The multi-agent review of Slices 1–2b surfaced a set of gaps; all closed in one
  pass:
  - **@Name grammar:** quoted `@"Any name"` form (spaces/dots — default ribbon-filter
    names are dotted `Table.Column`); bare names now unicode
    (`[\p{L}_][\p{L}\p{N}_]*`); substitution scoped to `FILTERS` lines only and
    quote/comment-aware (an `@` in a value or comment is data); splice-based
    replacement (no `String.replace` `$`-expansion corruption); empty ribbon
    selection ("Select None") now matches NOTHING (pivot parity) instead of showing
    all; DSL lexer gained `""` quote-escape so values containing `"` compile. Shared
    name-shape module `_shared/dsl/pivotLayout/paramNames.ts` keeps the editor's
    insertions and the substitution grammar in lock-step.
  - **Editor:** @-completion inserts the correct (bare/quoted) form, replaces the
    whole `@token` (dotted names), sets `filterText` (suggestions survive typing),
    respects string/comment context, and clears its hints on unmount.
  - **Refresh pipeline:** name-targeted (only reports referencing the changed
    control re-run), in-flight coalescing, failures returned + shown in Manage
    Reports (compile errors, model-not-loaded, backend errors) instead of silently
    swallowed, model cache only caches successes and is invalidated on BI events.
  - **Undo policy:** control-driven auto-refreshes skip the undo entry unless they'd
    cover external non-empty cells (data protection); `CONTROL_VALUE_CHANGED` is now
    also dispatched from cache diffs (`refreshCache`/`refreshControlsCache`) so
    undo/redo, rename, delete and `.calp`-pull changes re-sync `@`-bound reports;
    optimistic selection updates roll back on backend failure.
  - **Structural integrity:** row/col insert/delete realigns report definitions with
    their shifted regions (`structure.rs`); `delete_sheet` / `move_sheet` /
    `copy_sheet` remap report definitions + regions; report merge bookkeeping (and
    the undo restore path) targets the report's own sheet via the per-sheet store
    (never the visible sheet's set); undo snapshots carry the box's merged regions;
    create/refresh reject overlap with OTHER protected regions; `restore_report`
    validates the sheet index and returns a rebind warning the pull flow surfaces;
    the `.calp` provider now uses the channel's `sheetId` remap (new backend command
    `get_sheet_ids`).
- **Slice 2d — Live-test fixes + report object UX. ✅ BUILT.** From the first live
  test session:
  - **Canvas refresh events:** `AppEvents.GRID_REFRESH` ("app:grid-refresh") is
    REPAINT-ONLY; backend cell writers must dispatch raw `"grid:refresh"`
    (refetch) AND `"styles:refresh"` (materialization creates new styles — without
    it the report renders unstyled). Reports' `refreshGridCells()` now does both.
  - **Region write-protection (backend, benefits pivots too):** paste
    (`update_cells_batch`), delete-key/menu clears (`clear_cell`, `clear_range`,
    `clear_range_with_options` content-clears, `clear_range_on_sheets`) now reject
    targets inside ANY protected region — previously only the single-cell edit
    path checked, so paste/clear could punch through pivot AND report output. The
    core paste flow also cancels its undo transaction on a rejected batch (was
    left dangling). Format-only clears stay allowed (Excel parity). The scripting
    write surface is intentionally not gated.
  - **Edit Design Query:** `RefreshReportRequest` gained optional
    `dsl_text`/`name` — one `refresh_report` call re-materializes and persists the
    edit as a single undo step. New `EditReportDialog` (name + Monaco DSL editor
    with @-hints), opened from a new report right-click menu (Edit Design Query /
    Refresh / Delete / Manage, visible only inside report regions) and from the
    new **contextual "Report" ribbon tab** — registered/unregistered on selection
    like the pivot Analyze tab (`reportRegions.ts` frontend bounds cache +
    `reportSelectionHandler.ts`; cache refreshes on mutations, sheet switch, and
    debounced on `grid:refresh` so undo/redo keeps it honest).
- **Slice 3 — Pagination & print. DEFERRED (maybe not this report form).** Pages
  don't map cleanly onto a report already materialized as *all rows into cells*;
  pagination (page breaks, repeated headers, print/PDF) likely belongs to a future
  distinct "paginated report" form, not the grid report. Revisit later.
- **Slice 4 — Distribution. ✅ BUILT.** Reports publish/subscribe in `.calp`
  packages via the generic distributable-object channel (`@api/distributableObjects`,
  the same one cell-types dogfood). The Reports extension registers a provider
  (`kind: "calcula.report"`): `collect()` → `list_reports` payloads; `materialize()`
  → a new backend `restore_report` per object. The report's **cells travel with the
  package sheet grid**, so a subscriber sees the data offline; `restore_report`
  registers the definition + protected region and **rebinds the BI connection** by
  a stable `data_source_id` (SavedReport now carries it — the connection's package
  data-source id or local id, exactly like `SavedBiPivotMetadata`/`SavedRibbonFilter`).
  v1 assumes a matching sheet layout across publish/pull (no per-report sheet-id
  remap yet). End-to-end round-trip verification needs a two-workbook + registry +
  BI-model setup; the integration mirrors the proven cellTypes/ribbon-filter path.

**Phase 3 reports: Slices 1, 2, 2b (ribbon-filter targeting), 2c (hardening) + 4
complete. Slice 3 (pagination) deferred as a possible separate report form.
Known future items (out of current scope): data-change auto-refresh
(`BiEvents.REFRESHED`) + per-report `refreshMode` (D6); a needs-rebind badge in
Manage Reports for unrebound `.calp` reports; e2e `.calp` round-trip
verification.**

## Open decisions for review

1. **D1 report model:** committed/pivot-like (recommended) vs transient overlay.
2. **D3 filter scope for Slice 1:** fixed inline `FILTERS` only (recommended) vs
   include control-bound filters in the first slice.
3. **D4 pagination:** single block first (recommended) vs build paginated print
   layout up front.
4. **Where reports are authored:** a dedicated "Reports" pane/dialog, or folded
   into an existing surface (e.g. the Data menu / a task pane).
5. **Build Slice 1 now**, or iterate this doc further first.
