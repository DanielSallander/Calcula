# Bug Ledger

Bugs found by the automated soak/oracle system.
GENERATED from bug-ledger.json by tests/soak/bug-ledger.mjs — do not edit by hand.

Total: 20 | Open: 4 | Triaged: 2 | Fixed: 14 | Other: 0

## BUG-0020 `[triaged]`

**Found:** 2026-06-11 (soak-walk, seed 777)
**Oracle:** undo-round-trip

Conditional formatting rules are not registered in the undo system — a CF rule added during the window survives undo-all. Surfaced once the walker's cf.add-rule action used the correct internally-tagged serde shape ({type: "cellValue", ...}); before that the action failed silently and CF was never exercised.

**Repro:** add_conditional_format, then Ctrl+Z — the rule remains. Caught by the undo round-trip oracle (seed 777, 80 actions).
**Triage:** app-bug (confidence 0.9) — conditional_formatting.rs add/update/delete/reorder commands push no undo transactions. Fix with the obj_* swap pattern (snapshot the sheet's Vec<ConditionalFormatDefinition>, like obj_validation).

## BUG-0019 `[triaged]`

**Found:** 2026-06-11 (scenario)
**Oracle:** recalc-consistency

Second-order cross-sheet recalculation does not cascade: with Sheet2!B3 = Sheet1!C9 and Sheet1!C9 = SUM(C4:C8), editing Sheet1!C5 updates C9 (first-order, works after the BUG-0016 fix) but Sheet2!B3 keeps the stale value — update_cell's cascade only consults cross_sheet_dependents for the directly edited cell, not for cells recalculated as dependents.

**Repro:** Scenario budget-model phase 04: the commented-out B3/B4 assertions reproduce it. Sheet1: C9==SUM(C4:C8); Sheet2: B3==Sheet1!C9; edit Sheet1!C5 — B3 stays stale.
**Triage:** app-bug (confidence 0.9) — In commands/data.rs update_cell, the cross-sheet dependent propagation (the dep_sheet_idx block around line ~1240) runs only for the edited cell's direct cross-sheet dependents; cells recalculated in the local cascade (C9) never get their own cross_sheet_dependents looked up. Fix: after the local recalc loop, iterate the recalculated cells and propagate their cross-sheet dependents transitively.

## BUG-0018 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** save-reload-round-trip

Freeze panes are lost across save/reload: freezeRow=1 before save, null after reopening the same .cala. The save side writes freeze (enrich_workbook_metadata populates sheet.freeze_row), so the load path likely fails to restore state.freeze_configs.

**Repro:** Freeze the top row, save to .cala, reopen — the freeze is gone. Caught by the save/reload round-trip oracle in scenario monthly-report phase 08.
**Triage:** app-bug (confidence 0.85) — open_file does not copy sheet.freeze_row/freeze_col back into state.freeze_configs (or the .cala reader drops them).
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: core/calcula-format/src/sheet_metadata.rs, core/calcula-format/src/zip_io.rs

## BUG-0017 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** undo-round-trip

set_freeze_panes does not register an undo transaction at all — freeze changes are invisible to Ctrl+Z. NOTE: Excel does not make freeze panes undoable either, so this may be expected behavior; user decision required (undo.freeze-panes). Originally misattributed as a redo bug; the freeze diff that surfaced in scenarios was the save/reload gap (BUG-0018).

**Repro:** Freeze the top row, Ctrl+Z (freeze removed, correct), Ctrl+Y (freeze NOT restored). Caught by the undo round-trip oracle in scenario monthly-report phase 08.
**Triage:** app-bug (confidence 0.3) — sheets.rs set_freeze_panes pushes no undo transaction. Could be declared Excel-parity expected behavior instead of fixed.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/sheets.rs, app/src-tauri/src/undo_commands.rs

## BUG-0016 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** recalc-consistency

Recalculation does not propagate to dependent formulas after a sheet switch: with =SUM(C4:C8) in C9 on Sheet1, add a second sheet, switch to it, switch back to Sheet1, then edit C5 — C5 shows the new value but C9 keeps its stale total (silently wrong results). Even an explicit full recalculation (calculate_now) leaves C9 stale, which suggests the edited cell landed in a grid copy that formulas do not read (state.grid mirror vs state.grids[i] desync after sheet switching), not just lost dependency edges.

**Repro:** Sheet1: data in C4:C8, C9 ==SUM(C4:C8). Add a sheet (auto-switch), click back to Sheet1's tab, edit C5 via update_cell — C9 does not change. Scenario budget-model phase 04 reproduces this (see the BUG-0016 workaround comment there).
**Triage:** app-bug (confidence 0.9) — AppState keeps an active-sheet mirror (state.grid) AND per-sheet storage (state.grids) which are swapped on sheet switch. After add-sheet + switch-back, update_cell writes and get_cell reads agree (C5 shows 6950) but calculate_now computes from a copy where C5 is still the old value — the mirror and grids[0] have diverged. Known stale-mirror hazard: see the comment in commands/data.rs get_watch_cells ('grids[active_sheet] is stale').
**Fix:** fixed — Same-sheet propagation after sheet switch fixed (calculate_now mirror sync + dependency rebuild on switch). Residual second-order cross-sheet cascade tracked as BUG-0019.
  Files: app/src-tauri/src/calculation.rs, app/src-tauri/src/sheets.rs, app/src-tauri/src/undo_commands.rs

## BUG-0015 `[open]`

**Found:** 2026-06-11 (scenario)
**Oracle:** undo-round-trip

Undo of pivot-table creation leaves the pivot definition behind in PivotState.pivot_tables (a 'ghost pivot'): after undo-all, the digest still contains the full pivot definition. This CONTRADICTS the [verified] behavior undo.pivot-filter ('pivot create/delete are all undoable') — possibly the UI creation path registers undo while the create_pivot_table command path does not, or undo restores the grid region but not the PivotState entry.

**Repro:** Invoke create_pivot_table + update_pivot_fields (as scenario monthly-report phase 05 does), then Ctrl+Z twice — get_all_pivot_tables still returns the pivot definition.
**Triage:** app-bug (confidence 0.7) — The pivot undo transaction restores cells/protected regions but does not remove the (definition, cache) entry from PivotState.pivot_tables, or the direct command path skips undo registration the UI path performs.

## BUG-0014 `[open]`

**Found:** 2026-06-11 (scenario)
**Oracle:** undo-round-trip

Undo of pivot-table creation does not restore column widths: creating a pivot auto-sizes its destination columns (e.g. col H -> 80.2px), but undoing the pivot creation leaves the new widths behind.

**Repro:** Create a pivot at H1 (columns auto-size), Ctrl+Z until the pivot is gone — column H keeps its pivot-fitted width. Caught by the undo round-trip oracle in scenario monthly-report phase 05.
**Triage:** app-bug (confidence 0.75) — Pivot render auto-fit sets column widths outside the pivot-create undo transaction.

## BUG-0013 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** save-reload-round-trip

A table's autoFilterId linkage is lost across save/reload (0 before save, absent after reload), breaking the table's filter-button/autofilter association. Root cause visible in code: saved_to_table in app/src-tauri/src/persistence.rs hardcodes auto_filter_id: None when restoring tables.

**Repro:** Create a table with showFilterButton, save to .cala, reopen — table.autoFilterId is gone. Caught by the save/reload round-trip oracle in scenario monthly-report phase 04.
**Triage:** app-bug (confidence 0.9) — SavedTable has no auto_filter_id field (or it is not persisted); saved_to_table sets auto_filter_id: None on load.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/persistence.rs

## BUG-0012 `[open]`

**Found:** 2026-06-11 (scenario)
**Oracle:** save-reload-round-trip

Sparkline groups are lost across save/reload: a sparkline group present in AppState.sparklines before save_file is gone after open_file of the same .cala file (either not written to the archive or not restored on load).

**Repro:** Create a sparkline group, save to .cala, reopen — the group is gone. Caught by the save/reload round-trip oracle.
**Triage:** app-bug (confidence 0.85) — collect_sparklines_for_save exists in build_workbook_for_save, but either save_file's path does not include it, the .cala writer skips workbook.sparklines, or the load path never restores them into AppState.sparklines.

## BUG-0010 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** recalc-consistency

Sorting rows that contain relative-reference formulas leaves the formulas inconsistent with their new positions: immediately after sort_range the displayed values are correct for the new row order, but a full recalculation (calculate_now) changes 7 cells — e.g. E2 went from 720 (= new row's C2*D2) to 75. Either sort fails to adjust formula references when moving rows, or it adjusts displayed values without updating the underlying formulas/dependency graph.

**Repro:** Run scenario data-cleanup up to phase 'sort by line total descending' with the recalc oracle enabled (remove the `oracles` override in app/e2e/scenarios/data-cleanup.scenario.ts). Minimal: put =C2*D2-style formulas in E2:E9, sort A2:E9 descending by column E, then calculate_now — values change.
**Triage:** app-bug (confidence 0.9) — commands::sort_range moves cell values/formulas between rows without rewriting relative references (or without rebuilding the dependency graph), so incremental state and a from-scratch recalculation disagree.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/commands/data.rs

## BUG-0011 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** save-reload-round-trip

save_file persists only the active sheet: saving a 2-sheet workbook and reopening it produced 45 digest differences (activeSheet, sheet list, second sheet's cells). Predicted by code reading: save_file uses single-sheet Workbook::from_grid (persistence.rs:1136) and enrich_workbook_metadata only populates sheets[0] (persistence.rs:355).

**Repro:** Create a second sheet with data, save to .cala, reopen — the second sheet's content is lost/misplaced. Run scenario budget-model phase 03 with the saveReload oracle enabled (remove the `oracles` override).
**Triage:** app-bug (confidence 0.95) — save_file builds the workbook from the single active grid instead of using the multi-sheet build_workbook_snapshot-style iteration over state.grids.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/persistence.rs

## BUG-0009 `[fixed]`

**Found:** 2026-06-11 (soak-walk, seed 777)
**Oracle:** undo-round-trip

Redo of merge_cells does not restore the merged region. Undo correctly removes the merge, but redo leaves the cells unmerged. Minimized by ddmin to a SINGLE action (merge.merge), replay-confirmed.

**Repro:** `tests/regression/repros/BUG-0009.trace.json` (1 actions)
**Triage:** app-bug (confidence 0.95) — The redo path in undo_commands.rs apply_changes handles cell changes but does not re-apply the merged-region part of a merge transaction (UndoResult.mergeChanged flag exists, so undo-side handling is present; the redo direction misses it).
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/undo_commands.rs

## BUG-0007 `[fixed]`

**Found:** 2026-06-11 (soak-walk, seed 424242)
**Oracle:** undo-round-trip

Named range create/delete is not restored by undo — a name defined during the window survives undo-all. NOTE: Excel does NOT make name definition undoable, so this may be expected behavior rather than a bug; needs a user decision (see undo.named-ranges in docs/expected-behavior.md).

**Repro:** create_named_range, then Ctrl+Z — the name remains. Caught by the undo round-trip oracle (seed 424242).
**Triage:** app-bug (confidence 0.5) — named_ranges.rs commands do not push undo transactions. Could equally be declared Excel-parity expected behavior — user decision required.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/named_ranges.rs, app/src-tauri/src/undo_commands.rs

## BUG-0008 `[fixed]`

**Found:** 2026-06-11 (soak-walk, seed 424242)
**Oracle:** undo-round-trip

Data validation rules are not restored by undo — set_data_validation changes survive undo-all (Excel DOES undo validation changes).

**Repro:** set_data_validation on a range, then Ctrl+Z — the rule remains. Caught by the undo round-trip oracle (seed 424242).
**Triage:** app-bug (confidence 0.8) — data_validation.rs commands do not push undo transactions.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/data_validation.rs, app/src-tauri/src/undo_commands.rs

## BUG-0006 `[fixed]`

**Found:** 2026-06-11 (soak-walk, seed 424242)
**Oracle:** undo-round-trip

Table create/delete is not registered in the undo system — after undo-all, a table created during the window still exists. Same unregistered-lifecycle class as charts (BUG-0001), sparklines (BUG-0002) and autofilters (BUG-0003). Note: slicers, pivots, ribbon filters and merges ARE undo-integrated (UndoResult has flags for them), so the fix pattern exists in the codebase.

**Repro:** Create a table (create_table), press Ctrl+Z — the table remains. Caught by the undo round-trip oracle (seed 424242, 40 actions).
**Triage:** app-bug (confidence 0.9) — tables.rs create_table/delete_table mutate TableStorage without pushing undo transactions, unlike slicer/pivot commands.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/tables.rs, app/src-tauri/src/undo_commands.rs

## BUG-0005 `[open]`

**Found:** 2026-06-11 (soak-walk, seed 424242)
**Oracle:** undo-round-trip

Undo is sheet-unaware: after adding a sheet mid-window (auto-switching to it) and performing further actions, undo-all neither removes the added sheet nor restores the active sheet, and cell-level undo transactions appear to apply to whichever sheet is currently active rather than the sheet they were recorded on. 14 digest differences after undo-all: activeSheet 0->1, sheetNames[1] persists, multiple sheets[0] cells diverge.

**Repro:** `tests/regression/repros/BUG-0005.trace.json` (40 actions)
**Triage:** app-bug (confidence 0.85) — Undo transactions do not record a sheet index; apply_changes in undo_commands.rs operates on state.grid (the active-sheet mirror). Sheet add/delete/rename push no undo entries and do not clear the stack, so undo walks 'through' a sheet boundary applying changes to the wrong sheet. Either make sheet ops undoable with sheet-aware transactions, or (Excel parity) have sheet structural ops clear the undo stack.

## BUG-0003 `[fixed]`

**Found:** 2026-06-11 (soak-walk, seed 424242)
**Oracle:** undo-round-trip

AutoFilter state is not restored by undo. After undoing all steps in a checkpoint window, the autoFilters digest section diverged from the baseline (filter applied via apply_auto_filter/set_column_filter_values survives undo-all).

**Repro:** Apply an autofilter (apply_auto_filter), then Ctrl+Z — the filter state remains. Caught by the undo round-trip oracle.
**Triage:** app-bug (confidence 0.85) — AutoFilter mutations (AutoFilterStorage in AppState) do not push undo transactions.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/autofilter.rs, app/src-tauri/src/undo_commands.rs

## BUG-0004 `[fixed]`

**Found:** 2026-06-11 (soak-walk, seed 424242)
**Oracle:** contextual-ribbon-tabs

File > New (new_file) does not fully reset workbook state: sparkline groups survive into the new workbook (frontend store and/or backend sparklines), and a stale Slicer contextual ribbon tab remained visible with zero slicers. Observed as cross-run state leakage in back-to-back walks.

**Repro:** Create a sparkline group and a slicer, File > New — the sparkline group still exists and the Slicer tab can remain visible.
**Triage:** app-bug (confidence 0.8) — new_file clears grid/tables/charts/etc. but not AppState.sparklines (confirmed by code reading: persistence.rs new_file clears charts at ~line 1791, sparklines absent). Frontend object stores are additionally not notified to reset on new_file.
**Fix:** fixed — Backend part: new_file now clears state.sparklines (one line next to the charts clear). Frontend-store notification on new_file remains open as a follow-up.
  Files: app/src-tauri/src/persistence.rs

## BUG-0001 `[fixed]`

**Found:** 2026-06-10 (invariant-walk, seed 1781119899201)
**Oracle:** undo-round-trip

Undoing all steps did not remove charts created during the window. Chart entries (save_chart / chart delete) are not registered in the undo system, so Ctrl+Z never affects charts.

**Repro:** Create a chart (save_chart), press Ctrl+Z — the chart remains. Caught by the undo round-trip oracle at the first 25-action checkpoint.
**Triage:** app-bug (confidence 0.95) — AppState.charts (Vec<ChartEntry>, opaque JSON) is mutated by chart commands without pushing an undo Transaction. The undo Transaction model has flags for pivot/slicer changes but no chart support.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/chart_commands.rs, app/src-tauri/src/undo_commands.rs

## BUG-0002 `[fixed]`

**Found:** 2026-06-10 (invariant-walk, seed 1781119899201)
**Oracle:** undo-round-trip

Sparkline group create/delete is suspected to bypass the undo system (same storage pattern as charts: AppState.sparklines opaque JSON entries). Surfaced in the same oracle failure as BUG-0001 (4-6 diffs).

**Repro:** Create a sparkline group via __CALCULA_SPARKLINES__, press Ctrl+Z — the group likely remains. Needs confirmation once BUG-0001 suppression isolates remaining diffs.
**Triage:** app-bug (confidence 0.7) — Same pattern as BUG-0001 for AppState.sparklines.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/sparkline_commands.rs, app/src-tauri/src/undo_commands.rs
