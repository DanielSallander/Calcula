# Bug Ledger

Bugs found by the automated soak/oracle system.
GENERATED from bug-ledger.json by tests/soak/bug-ledger.mjs — do not edit by hand.

Total: 42 | Open: 1 | Triaged: 0 | Fixed: 41 | Other: 0

## BUG-0023 `[fixed]`

**Found:** 2026-08-11 (review)
**Oracle:** visual-golden

The committed screenshot corpus is split across two capture paths. Decoding all 71 goldens: 44 hold the dpr-2 grid hairline (241,241,241) and 27 -- the whole e2e/visual tree, all re-recorded 2026-08-11 14:11-14:13 -- hold the dpr-1 hairline (226,226,226). The display is 200% (GDI DESKTOPHORZRES 2944 / HORZRES 1472 = 2), so dpr 2 is correct and the visual corpus encodes an environment this machine does not produce. e2e/captureEnvironment.ts declares devicePixelRatio 2 as the configuration EVERY committed golden was captured under; for 27 of 71 files that is false.

**Repro:** Run npm run e2e:visual on this machine. Every grid golden under e2e/visual differs from its capture by ~39,400 pixels against a 200-pixel budget, entirely in the gridline hairline. No product code is involved.
**Triage:** test-bug (confidence 0.95) — The visual corpus was re-recorded through a launch whose device pixel ratio was 1. The re-record absorbed no structural change: fitting the dpr-2 grid-empty-grid-default against the dpr-1 grid-core-empty-canvas leaves 0.83% residual, and it is a symmetric one-pixel gridline phase shift (1980 px of 241->255 against 1980 px of 255->226) plus text rasterization, spread over the whole frame with no localized bounding box.
**Fix:** fixed — The 27 e2e/visual goldens were re-recorded at dpr 2 on 2026-08-11 against a cold app of the fixed build (--project=visual --update-snapshots, 18/18). Decoding all 72 committed goldens afterwards reads dpr 2 on every one of them, so MIS_RECORDED_CORPORA is now empty and the BUG-0023 quarantine is deleted. The quarantine was designed to self-expire and it did: its two cases assert that every quarantined file still MEASURES recordedAt (1), so they would have failed the moment the files were corrected.
  Files: app/e2e/visual/__screenshots__/core-visual.spec.ts/*.png, app/e2e/visual/__screenshots__/workflow-visual.spec.ts/*.png, app/e2e/goldenCorpus.ts

## BUG-0022 `[fixed]`

**Found:** 2026-08-11 (review)
**Oracle:** undo-round-trip

`change_pivot_data_source` records no undo entry at all: repointing a pivot at a different source range is not undoable. Same discovery as BUG-0021.

**Repro:** Create a pivot, use Change Data Source to point it at a different range, press Ctrl+Z — the pivot keeps the new source.
**Triage:** app-bug (confidence 1) — CONFIRMED on the current tree: change_pivot_data_source recorded nothing at all, and it both rebuilds the cache from the new range and can overwrite cells it did not previously cover. Same root as BUG-0021 and fixed in the same pass.
**Fix:** fixed — The old definition AND the old cache are captured before the range is repointed, the cells the new (possibly larger) pivot overwrites are SAVED rather than merely counted, and one 'Change pivot data source' step is recorded after the work succeeds.
  Files: app/src-tauri/src/pivot/commands.rs (change_pivot_data_source snapshots definition+cache, saves the overwritten cells and records one step), app/src-tauri/src/undo_commands.rs (the cache-carrying snapshot it needs)

## BUG-0021 `[fixed]`

**Found:** 2026-08-11 (review)
**Oracle:** undo-round-trip

`update_bi_pivot_fields` records no undo entry at all: changing a BI pivot's fields is not undoable, and Ctrl+Z afterwards silently undoes whatever action came before it instead. Found by narrowing the blanket `pivots.` suppression that had hidden the whole pivot subtree from the undo round-trip oracle since 2026-06-11.

**Repro:** Create a pivot from a BI model, change its fields via update_bi_pivot_fields, press Ctrl+Z — the pivot keeps the new fields and an unrelated earlier edit is reverted instead.
**Triage:** app-bug (confidence 1) — CONFIRMED on the current tree, and the code said so itself: the auto-fit branch carried a comment reading 'DELIBERATELY DISCARDED ... this command records NO undo entry at all'. The command has FIVE mutating exits (cosmetic fast path, no-fields-clear, no-measures-save, failed-query-save, main path) and none recorded anything. A definition-only snapshot is not sufficient because four of the five replace the cache.
**Fix:** fixed — The pivot-definition undo snapshot grew an optional `cache`, and the restore puts it back when it is present. All five mutating exits of update_bi_pivot_fields now record ONE undo step, carrying the old cache (the four that replace it) and the saved overwritten cells and auto-fit column widths, so the resize undoes with the change that caused it instead of being discarded. The payload had THREE independent writers and a fourth private decoder in undo_pivot_overwrite; all four now go through one encoder/decoder in undo_commands, because a field added to one author is silently defaulted away in the others - which is exactly the failure `cache` would have had.
  Files: app/src-tauri/src/undo_commands.rs (PivotDefinitionSnapshot.cache + encode/decode + PIVOT_DEFINITION_RESTORE_KIND), app/src-tauri/src/pivot/commands.rs (record_pivot_definition_undo takes a cache; 5 exits of update_bi_pivot_fields record), app/src-tauri/src/mcp/objects.rs (json! literal -> the shared encoder), app/src-tauri/src/calp_commands.rs (local struct copy -> the shared encoder), app/src-tauri/src/pivot_undo_cache_tests.rs (new)

## BUG-0020 `[fixed]`

**Found:** 2026-06-11 (soak-walk, seed 777)
**Oracle:** undo-round-trip

Conditional formatting rules are not registered in the undo system — a CF rule added during the window survives undo-all. Surfaced once the walker's cf.add-rule action used the correct internally-tagged serde shape ({type: "cellValue", ...}); before that the action failed silently and CF was never exercised.

**Repro:** add_conditional_format, then Ctrl+Z — the rule remains. Caught by the undo round-trip oracle (seed 777, 80 actions).
**Triage:** app-bug (confidence 0.9) — conditional_formatting.rs add/update/delete/reorder commands push no undo transactions. Fix with the obj_* swap pattern (snapshot the sheet's Vec<ConditionalFormatDefinition>, like obj_validation).
**Fix:** fixed — fixed 2026-08-11 — the CF commands (add/update/delete/reorder/clear) recorded no undo entry at all. They now snapshot the sheet's whole rule list as `obj_conditional_formats` and announce the `conditionalFormats` refresh domain. The ledger status lagged the fix; corrected while re-examining the oracle suppressions, which had already removed the BUG-0020 entry.
  Files: app/src-tauri/src/conditional_formatting.rs, app/src-tauri/src/undo_commands.rs

## BUG-0019 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** recalc-consistency

Second-order cross-sheet recalculation does not cascade: with Sheet2!B3 = Sheet1!C9 and Sheet1!C9 = SUM(C4:C8), editing Sheet1!C5 updates C9 (first-order, works after the BUG-0016 fix) but Sheet2!B3 keeps the stale value — update_cell's cascade only consults cross_sheet_dependents for the directly edited cell, not for cells recalculated as dependents.

**Repro:** Scenario budget-model phase 04: the commented-out B3/B4 assertions reproduce it. Sheet1: C9==SUM(C4:C8); Sheet2: B3==Sheet1!C9; edit Sheet1!C5 — B3 stays stale.
**Triage:** app-bug (confidence 0.9) — In commands/data.rs update_cell, the cross-sheet dependent propagation (the dep_sheet_idx block around line ~1240) runs only for the edited cell's direct cross-sheet dependents; cells recalculated in the local cascade (C9) never get their own cross_sheet_dependents looked up. Fix: after the local recalc loop, iterate the recalculated cells and propagate their cross-sheet dependents transitively.
**Fix:** fixed — Two independent causes, one per hop, both in cascade_cross_sheet_dependents. (1) The walk was rooted ONLY on the cells the caller edited; the cells the caller RECALCULATED were marked processed but never queued, so C9's cross-sheet dependents were never looked up (hop 1, exactly the triage hypothesis). Both sets are now walk roots. (2) The walk expanded a NON-ACTIVE sheet's same-sheet dependents through the ACTIVE sheet's dependents map — a map with no sheet dimension — so Sheet2!B4 = B2-B3 was invisible (hop 2). A per-sheet SheetDependencyIndex is now derived on demand from that sheet's own formula ASTs (cell + whole-column + whole-row edges) and expanded in topological order. Both hand-copied duplicates of the walk in update_cells_batch_core (paste) and fill_range were deleted in favour of the shared function, and a wiring test fails if a third copy appears.
  Files: app/src-tauri/src/commands/data.rs, app/src-tauri/src/calculation.rs, app/src-tauri/src/control_values.rs, app/src-tauri/src/commands/cross_sheet_recalc_tests.rs, app/e2e/scenarios/budget-model.scenario.ts

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

## BUG-0015 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** undo-round-trip

Undo of pivot-table creation leaves the pivot definition behind in PivotState.pivot_tables (a 'ghost pivot'): after undo-all, the digest still contains the full pivot definition. This CONTRADICTS the [verified] behavior undo.pivot-filter ('pivot create/delete are all undoable') — possibly the UI creation path registers undo while the create_pivot_table command path does not, or undo restores the grid region but not the PivotState entry.

**Repro:** Invoke create_pivot_table + update_pivot_fields (as scenario monthly-report phase 05 does), then Ctrl+Z twice — get_all_pivot_tables still returns the pivot definition.
**Triage:** app-bug (confidence 0.7) — The pivot undo transaction restores cells/protected regions but does not remove the (definition, cache) entry from PivotState.pivot_tables, or the direct command path skips undo registration the UI path performs.
**Fix:** fixed — fixed (cause) — the ledgered path no longer leaves a ghost: `apply_pivot_create_restore` removes the entry from `PivotState.pivot_tables`. Re-examining the suppression found the blanket `pivots.` prefix had gone on to hide its SUCCESSORS: four pivot commands mutate `pivot_tables` and record no undo entry at all. `create_pivot_from_bi_model` (the same symptom on the BI path — a pivot Ctrl+Z could not remove) and `relocate_pivot` are fixed here. `update_bi_pivot_fields` and `change_pivot_data_source` remain OPEN as BUG-0021 and BUG-0022: both rebuild the cache, so they need a definition+cache snapshot rather than the definition-only one. `refresh_pivot_cache` records nothing and is correct — Excel does not undo a PivotTable refresh.
  Files: app/src-tauri/src/pivot/operations.rs, app/src-tauri/src/pivot/commands.rs, app/src-tauri/src/undo_commands.rs, app/e2e/oracles/knownIssues.ts

## BUG-0014 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** undo-round-trip

Undo of pivot-table creation does not restore column widths: creating a pivot auto-sizes its destination columns (e.g. col H -> 80.2px), but undoing the pivot creation leaves the new widths behind.

**Repro:** Create a pivot at H1 (columns auto-size), Ctrl+Z until the pivot is gone — column H keeps its pivot-fitted width. Caught by the undo round-trip oracle in scenario monthly-report phase 05.
**Triage:** app-bug (confidence 0.75) — Pivot render auto-fit sets column widths outside the pivot-create undo transaction.
**Fix:** fixed — fixed — `auto_fit_pivot_columns` wrote into `column_widths` / `all_column_widths` and recorded nothing on the undo stack. It now returns the widths it overwrote and `record_pivot_definition_undo` records them in the SAME transaction as the pivot change, as a new `pivot_col_widths` restore kind that is sheet-INDEXED (a pivot can render on a sheet the user is not looking at, where the fit writes `all_column_widths[dest]`). `None` means the column had no explicit width, so the restore removes the entry rather than writing a default.
  Files: app/src-tauri/src/pivot/operations.rs, app/src-tauri/src/pivot/commands.rs, app/src-tauri/src/undo_commands.rs, app/e2e/oracles/knownIssues.ts

## BUG-0013 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** save-reload-round-trip

A table's autoFilterId linkage is lost across save/reload (0 before save, absent after reload), breaking the table's filter-button/autofilter association. Root cause visible in code: saved_to_table in app/src-tauri/src/persistence.rs hardcodes auto_filter_id: None when restoring tables.

**Repro:** Create a table with showFilterButton, save to .cala, reopen — table.autoFilterId is gone. Caught by the save/reload round-trip oracle in scenario monthly-report phase 04.
**Triage:** app-bug (confidence 0.9) — SavedTable has no auto_filter_id field (or it is not persisted); saved_to_table sets auto_filter_id: None on load.
**Fix:** fixed — Fixed in the 2026-06-11 fix campaign; validated by oracle walk (seed 424242), BUG-0009 repro replay, and the scenario suite.
  Files: app/src-tauri/src/persistence.rs

## BUG-0012 `[fixed]`

**Found:** 2026-06-11 (scenario)
**Oracle:** save-reload-round-trip

Sparkline groups are lost across save/reload: a sparkline group present in AppState.sparklines before save_file is gone after open_file of the same .cala file (either not written to the archive or not restored on load).

**Repro:** Create a sparkline group, save to .cala, reopen — the group is gone. Caught by the save/reload round-trip oracle.
**Triage:** app-bug (confidence 0.85) — collect_sparklines_for_save exists in build_workbook_for_save, but either save_file's path does not include it, the .cala writer skips workbook.sparklines, or the load path never restores them into AppState.sparklines. || RE-TRIAGED 2026-08-12: already fixed on the tree and never closed -- the same pattern as BUG-0024, a filing that outlived its defect. collect_sparklines_for_save is wired into build_workbook_for_save, zip_io.rs writes sparklines.json and reads it back unconditionally, and restore_sparklines puts them into AppState. Reading the source cannot settle that, which is the only reason this entry survived three handovers; it was RUN.
**Fix:** fixed — No product change was needed. Proved live on the real app: a real sparkline group, a real save_file to a real .cala, a real open_file, and the BACKEND'S OWN DIGEST on both sides -- the same instrument (save-reload-round-trip) that filed the bug. The digest hashes sheetIndex -> sorted groups_json, i.e. the group's LOCATION and SOURCE range, so it is strictly stronger than a count: a reload that restores an empty group at the wrong address would still fail. The spec also reads the .cala archive bytes directly and requires a sparklines.json entry, which separates 'the writer dropped it' from 'the reader dropped it' -- the two halves this bug's own triage could not tell apart. A non-vacuity assertion requires the digest to actually hold a group BEFORE the save, so the test cannot rot into a no-op.
  Files: app/e2e/journeys/sparkline-persistence.spec.ts (new, the proof)

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

## BUG-0005 `[fixed]`

**Found:** 2026-06-11 (soak-walk, seed 424242)
**Oracle:** undo-round-trip

Undo is sheet-unaware: after adding a sheet mid-window (auto-switching to it) and performing further actions, undo-all neither removes the added sheet nor restores the active sheet, and cell-level undo transactions appear to apply to whichever sheet is currently active rather than the sheet they were recorded on. 14 digest differences after undo-all: activeSheet 0->1, sheetNames[1] persists, multiple sheets[0] cells diverge.

**Repro:** `tests/regression/repros/BUG-0005.trace.json` (40 actions)
**Triage:** app-bug (confidence 0.85) — Undo transactions do not record a sheet index; apply_changes in undo_commands.rs operates on state.grid (the active-sheet mirror). Sheet add/delete/rename push no undo entries and do not clear the stack, so undo walks 'through' a sheet boundary applying changes to the wrong sheet. Either make sheet ops undoable with sheet-aware transactions, or (Excel parity) have sheet structural ops clear the undo stack.
**Fix:** fixed — ROOT: the third appearance of one missing dimension. `CellChange::SetCell` had already grown a `sheet` field, but the field holds an INDEX -- a POSITION, not an identity. Deleting, moving or copying a sheet renumbers every index after it, so a queued undo entry silently came to describe a different sheet and undo wrote onto a sheet the user never edited. `remap_sheet_keyed_stores` re-aimed the `CustomRestore` payloads and NOT the `SetCell` indices beside them in the same transactions, so it repaired half the problem. Two hazards were not about indices at all: a RENAME shifts nothing but rewrites every formula in the workbook, leaving queued `previous` cells holding ASTs that spell the old sheet name; and the width/height/merge/snapshot changes carry no sheet dimension AT ALL. VERIFIED EXCEL BEHAVIOUR: Excel does not let a sheet structural operation be undone -- deleting a worksheet is the documented case ('you can't undo deleting sheets') and no undo entry exists for inserting, renaming, moving or copying one either -- so a workbook-structure change ends the undo history. Under the standing 'Excel parity wins' rule that is now Calcula's behaviour, applied at ONE choke point that all five commands call, with a source census that fails by name when a command stops calling it. It also answers the target-sheet-deleted case with Excel's own answer instead of an invented one: the question cannot arise, because the delete ended the history that could have asked it. The MCP tool layer had been TELLING callers this all along ('Sheet structure changes are NOT undoable') while leaving the stack intact behind them. Removing the re-aim also removed a real lock-order inversion: it took `undo_stack` while `move_sheet`/`copy_sheet` held the grid pair, the reverse of `apply_changes`. Finally, the soak oracle could not tell 'a sheet operation ended the history' from 'the walk undid past its checkpoint' -- which is exactly how this bug was FILED -- so `UndoStack` now counts wholesale clears separately from cap evictions and `stepsBackToBaseline` names the right cause.
  Files: core/engine/src/undo.rs (UndoStack::cleared_total + counted clear(); visit_custom_restores DELETED), app/src-tauri/src/sheets.rs (invalidate_undo_history_for_sheet_structure + the five structural commands; remap_sheet_keyed_stores no longer re-aims queued undo entries; move_sheet/copy_sheet release their guards first), app/src-tauri/src/undo_commands.rs (UndoState.cleared_total), app/src-tauri/src/undo_sheet_structure_tests.rs (NEW: 16 tests incl. the census + its teeth), app/src-tauri/src/undo_sheet_domain_tests.rs (Fixture made pub(super) so the new file reuses it), app/src-tauri/src/formula_serialisation_tests.rs (free_function_bodies made pub(crate) for census reuse), app/src/core/lib/tauri-api.ts, app/e2e/oracles/types.ts, app/e2e/oracles/undoRoundTrip.ts, app/e2e/oracles/index.ts, app/e2e/__tests__/undoHistoryHorizon.test.ts (NEW: 9 vitest cases for stepsBackToBaseline)

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

## BUG-0024 `[fixed]`

**Found:** 2026-08-11 (review)
**Oracle:** visual-golden

The committed screenshot corpus is ALSO split on a second axis that the device-pixel-ratio census structurally cannot see: the COLOUR PROFILE. Measured on a cold --project=functional run of the fixed build: 512 passed / 31 failed / 11 skipped, and all 31 failures are goldens with NONE of them dpr (every failing pair holds the same hairline on both sides). The app declares #217346 (33,115,70) and #10b981 (16,185,129); a capture under --force-color-profile=sRGB reproduces those bit-exactly and the committed goldens hold 63,112,75 / 95,180,134, the wide-gamut transform of them. The pin reached the manual launch path for the first time when e2e/webview2Args.mjs became the single definition of the WebView2 arguments (register 3by section 5), and the manual path is how every golden in this tree was recorded -- so the whole corpus predates the pin. The profile transform is the IDENTITY on neutrals and both hairline constants are neutral, which is exactly why the dpr census reported a clean corpus over this.

**Repro:** Run --project=functional on this machine before the re-record. statusbar-text-range alone moves 30,683 px (99.88% of the capture) against a 15-pixel budget, and 29,569 of them are the single mapping 63,112,75 -> 33,115,70. No product code is involved.
**Triage:** test-bug (confidence 0.99) — The goldens were recorded before --force-color-profile=sRGB was actually delivered on the manual launch path. The direction is proved from source rather than assumed: 33,115,70 and 16,185,129 are the literal colours the application declares (uiTypes.ts, ribbonIcons.tsx, darkTheme.ts), so the PINNED capture is the faithful one and the committed golden is the stale one. Structurally safe to re-record: reducing each failing pair to a colour relation gives a functional share of 0.9666..1.0000 with fan-out 1 on every dominant mapping and no compact bounding box, which is a recolouring and not a displacement.
**Fix:** fixed — Re-recorded with --update-snapshots=changed (never 'all', which would rewrite goldens that currently pass and discard the evidence they represent), and added the missing SECOND census axis so the same class cannot recur silently. readColourProfile abstains on neutrals rather than counting them as agreement; describeProfileSplit fires in BOTH directions, so a LOST pin is reported as a launcher fault instead of being re-recorded into every golden.
  Files: app/e2e/tests/__screenshots__/**/*.png (38 goldens), app/e2e/scenarios/__screenshots__/**/*.png (3 goldens), app/e2e/goldenCorpus.ts (readColourProfile + describeProfileSplit), app/e2e/captureEnvironment.ts (CAPTURE_ENVIRONMENT.colourProfile), app/e2e/__tests__/goldenCorpus.test.ts

## BUG-0025 `[fixed]`

**Found:** 2026-08-11 (e2e)
**Oracle:** vba-idioms-wave3

vba-idioms-wave3 #5 retypes the token SEEDREF to A1 in the macro editor and then reads the stored module source. Expected substring 'const jump = "A1"'; the store held 'const jump = "A"' -- the final keystroke is missing. Passed in both earlier full ordered runs the same evening; 1 failure in 3.

**Repro:** Run --project=functional in its natural order. Running the spec ALONE is NOT a reproduction: it depends on sheets earlier specs create and fails at line 1080 with Expected 1 / Received 0, a different assertion entirely.
**Triage:** app-bug (confidence 0.97) — SEPARATED: hypothesis (b). The measurement the filing named -- read the Monaco buffer at the moment the assertion fails -- was taken deterministically instead of by re-running a 1-in-3 flake: a vitest reproduction of the exact sequence (type a character, let the 400ms idle window elapse, hold the store write open, type the next character while it is in flight, release) reproduces the symptom exactly. The store held 'A', the BUFFER held 'A1', and the live chip read 'live'. So no keystroke was dropped and this is NOT the grid's type-to-open defect; the editor's live indicator claimed the store held the buffer while a write was still owed. Corroborated by the harness's own history: two of the six copies of retypeToken's caller already carried a comment describing this race and worked around it by polling the store, and those two are green while the copy without the workaround is the flake.
**Fix:** fixed — PRODUCT: a persist outcome describes the bytes it wrote, not the bytes on screen, so the live chip is now derived from the persister's own buffer-vs-store comparison at the moment the outcome lands and reads 'Saving...' while a later keystroke is still unstored. The same staleness had a destructive second face: a 'compiled' outcome replaced the buffer with the stored JavaScript even when the author had typed since, deleting those keystrokes and desynchronising the persister (setSource never reaches it); outcomes now carry the `input` they compiled FROM, the swap is skipped when the screen has moved on, and when it does happen the persister is told via a new `adopt`. HARNESS: retypeToken's six byte-identical copies (plus a seventh editorText and inline indicator locators) became one e2e/helpers/macroEditor.ts, whose failure message prints the chip state, the Monaco buffer and the stored source -- so the separating measurement is permanent instead of costing a 38-minute run.
  Files: app/extensions/ScriptableObjects/components/ObjectScriptEditorApp.tsx, app/extensions/ScriptableObjects/lib/liveModuleBuffer.ts, app/extensions/ScriptableObjects/__tests__/liveMacroEditing.test.tsx, app/extensions/ScriptableObjects/lib/__tests__/liveModuleBuffer.test.ts, app/e2e/helpers/macroEditor.ts (new), app/e2e/tests/macro-live-edit.spec.ts, app/e2e/tests/vba-idioms-wave1.spec.ts, app/e2e/tests/vba-idioms-wave2.spec.ts, app/e2e/tests/vba-idioms-wave3.spec.ts, app/e2e/tests/vba-idioms-wave4.spec.ts, app/e2e/tests/vba-wiring-batch.spec.ts, app/e2e/tests/macro-editor-inventory.spec.ts, app/e2e/tests/macro-link-model.spec.ts

## BUG-0026 `[fixed]`

**Found:** 2026-08-11 (soak, seed 20260812731)
**Oracle:** contextual-ribbon-tabs

Contextual tab "Slicer" is visible but at least one slicer must exist. Found: slicers=0, charts=0, tables=0, pivots=0, timelines=0, sparklines=0

**Repro:** `app/e2e/results/soak/failures/2026-08-11T21-37-06-340Z-soak-contextual-ribbon-tabs/minimized.trace.json` (3 actions)
**Triage:** product-bug (confidence 0.95) — THE FRONTEND NEVER HEARS ABOUT A CASCADED DELETE. SlicerEvents.SLICER_DELETED is dispatched from exactly one place in the tree -- deleteSlicerAsync in extensions/Slicer/lib/slicerStore.ts -- which is the FRONTEND delete path (context menu, Options pane). Slicer/index.ts listens for that event and calls deselectSlicer(), with a comment saying 'without this, deleting a selected slicer leaves the Options tab visible with no slicer to configure' -- i.e. the defect was already known and fixed for the DIRECT path. Deleting the owning TABLE removes the slicer through the register-3bt object-dependency cascade, which runs in the backend and never passes through deleteSlicerAsync, so no event is raised, the selection is never cleared, and the contextual tab survives its subject. This is the frontend half of the 3bt cascade and the object-deps census cannot see it: that census checks that a Rust delete command DECLARES what happens to its dependents, not that the UI is told when a dependent dies.
**Fix:** fixed — SLICER_DELETED was dispatched from deleteSlicerAsync alone -- the one route a user takes by hand -- so every backend cascade removed the slicer and told the UI nothing, and the contextual tab is a function of the selection. Fixed in the STORE, not at the call site: refreshCache diffs the id set it just read against the one it held and announces whatever vanished, which covers every route including ones that do not exist yet, prunes the leaked items cache by the same diff, and keeps a multi-selection's survivors. The identical defect in TimelineSlicer (never reported) and a partial one in Pivot are fixed with it. The direction nothing had covered: an MCP tool is not invoked BY the frontend, so four bespoke per-kind Tauri events -- one of which, sheets:refresh, had no listener anywhere in the app -- were replaced by one announce_cascade -> mutation:refresh bridged into the same MUTATION_DOMAIN_EVENTS fan-out. Deriving the domain list transitively from DEPENDENCY_MATRIX found three live backend orphans: delete_sheet never ran cascade_deleted_charts, cascade_deleted_sources never ran cascade_deleted_slicers, and neither pruned object scripts.
  Files: app/src-tauri/src/object_deps.rs (UiDomain, dependent_kind, cascade_domains, announce_cascade, delete_sheet/cascade_deleted_sources transitive fixes), app/src-tauri/src/object_deps_census_tests.rs, app/src-tauri/src/undo_commands.rs (MutationDomain now aliases object_deps::UiDomain), app/src-tauri/src/mcp/objects.rs, app/src-tauri/src/mcp/tools.rs, app/src/shell/bootstrap.ts (mutation:refresh bridged into MUTATION_DOMAIN_EVENTS), app/src/api/__tests__/cascadeAnnouncementCensus.test.ts, app/extensions/Slicer/lib/slicerStore.ts, app/extensions/Slicer/handlers/selectionHandler.ts, app/extensions/TimelineSlicer/lib/timelineSlicerStore.ts

## BUG-0027 `[fixed]`

**Found:** 2026-08-11 (e2e, seed 1786456498740)
**Oracle:** harness

An invariant walk stopped at [step 47/75] ribbon.switch-tab and printed nothing for TWELVE MINUTES while the app stayed alive, Responding=True, CPU flat, CDP answering. Not the lock-order wedge (that stops the WebView2 message pump; this did not).

**Repro:** E2E_MANUAL=1 INVARIANT_SEED=1786456498740 npx playwright test --project=invariant --grep "random action sequence" with actionTimeout unset.
**Triage:** test-bug (confidence 0.99) — TWO DEFAULTS MEETING. (1) Playwright's default actionTimeout is 0 -- NO timeout -- so locator.click() waits for actionability forever; playwright.config.ts set expect.timeout and never set actionTimeout, and walker/actionCatalog.ts has 5 bare .click() calls, ribbon.switch-tab among them (it probes isVisible({timeout:500}) and then clicks unbounded, so a visible-but-not-actionable button parks it). (2) state-consistency.spec.ts raises its own ceiling with test.setTimeout(1_500_000), so the project's 300s does not apply and the hang had 25 minutes to run in. A hang is invisible to an exit-status check.
**Fix:** fixed — use.actionTimeout = 30_000 and use.navigationTimeout = 60_000, with the measurement recorded beside them. 30s is far above the slowest legitimate action in these suites, so it cannot turn a slow action into a false failure; it turns an infinite one into a reported failure that names the locator.
  Files: app/playwright.config.ts

## BUG-0028 `[fixed]`

**Found:** 2026-08-11 (e2e)
**Oracle:** visual-golden

4 of the 27 e2e/visual goldens are a function of app WARMTH rather than of the page. --project=visual is 18/18 twice on a warm app (one that has already run functional/scenario/journey) and 14/18 then 15/18 on a cold-launched one. menu-file-open, menu-edit-open and menu-data-open fail on cold in BOTH cold runs and pass on warm in ALL THREE warm runs -- deterministic per condition, opposite between conditions. core-empty-grid failed the FIRST capture after a cold start and passed the second, so it is not even stable within one condition.

**Repro:** Run --project=visual against an app that has already run other suites: 18/18. Kill the app, cold-launch it, run --project=visual as the first suite on the instance: 4 fail, then 3 fail on an immediate re-run.
**Triage:** test-bug (confidence 0.8) — NOT a recolouring and therefore not a capture-path artifact: fan-out reaches 22 and saturated colours map to greys (37,98,156 -> 110,110,110; 96,37,38 -> 65,65,66; 193,153,97 -> 153,153,154), i.e. coloured menu iconography present in the golden and grey in the cold capture -- consistent with an icon font or accent asset that only resolves once the app has been exercised, though that specific mechanism is a hypothesis and was not confirmed. core-empty-grid is separate: its dominant transitions are 221,245,237 -> 255,255,255 (510 px) and 128,217,188 -> 255,255,255 (80 px), a pale green highlight present in the golden and absent from the first cold capture -- a highlight that has not settled, the same class as the FormulaInput selection race (register 3bw).
**Fix:** fixed — TWO defects, and 'warmth' was neither time nor fonts. (a) The three menu-* goldens differ by TEXT ANTIALIASING, decided per composited layer: an accelerated 2D canvas is its own layer, an overlay that overlaps it is composited too, and Chromium refuses LCD text on a layer it cannot prove opaque. The app de-accelerates its own canvas through GridCanvas.captureRange, so 'warm' meant 'some earlier suite exercised the capture seam'. Measured on one cold app: 7 layers and 0 chromatic pixels before 120 getImageData calls, 5 layers and 1575 after. Fixed with --disable-accelerated-2d-canvas, which pins every golden to the side it was already recorded on (zero re-records for that axis) rather than --disable-lcd-text, which would have turned all 89 goldens grey. (b) core-empty-grid was a PRODUCT bug: useHomeTabState keyed its style read on the selection alone and returned without clearing when getCell resolved to null, so an empty cell inherited the previous cell's ribbon state and File > New / undo / Clear-Formats never re-read at all.
  Files: app/e2e/webview2Args.mjs (--disable-accelerated-2d-canvas in DETERMINISTIC_CAPTURE_FLAGS), app/e2e/captureEnvironment.ts (compositedCanvasLayers axis), app/e2e/helpers/screenshots.ts (CDP LayerTree reader), app/extensions/BuiltIn/HomeTab/components/useHomeTabState.ts, app/e2e/visual/workflow-visual.spec.ts, 5 goldens re-recorded: core-empty-grid, ribbon-core-default-ribbon, menu-file-open, menu-edit-open, workflow-multisheet-sheet1

## BUG-0029 `[fixed]`

**Found:** 2026-08-12 (review)
**Oracle:** visual-golden

tests/__screenshots__/grid-rendering.spec.ts/empty-grid-full-window.png photographs a product state the build no longer produces. BUG-0028's product fix (useHomeTabState clears the ribbon when getCell resolves to null) was verified by re-recording five goldens in the VISUAL project; the FUNCTIONAL project was not re-run and still holds a capture of the same brand-new workbook, through the same resetToNewWorkbook helper, with the Center-Vertically toggle latched. Measured off the committed bytes: 546 pressed-accent pixels where the re-recorded sibling core-empty-grid.png measures 36. A pixel-for-pixel fit of the two 1280x800 captures leaves 2,173 differing pixels of which 590 are exactly this box (510 of 221,245,237 -> 255,255,255 plus 80 of its 128,217,188 border) inside x 128..441 / y 69..94. The comparator budget is min(200, 0.0005 * 1,024,000) = 200, so it cannot pass.

**Repro:** Run --project=functional after the BUG-0028 product fix; 'empty grid renders correctly with headers and gridlines' fails on its second capture. No run is needed to see it: app/e2e/__tests__/goldenCorpus.test.ts now reads the state off the committed bytes, and removing the BUG-0029 entry from STALE_PRODUCT_STATE_GOLDENS fails 'shows an UNLIT Home tab on every golden taken on a brand-new workbook' naming the file and the count.
**Triage:** test-bug (confidence 0.97) — A product fix invalidates goldens in EVERY project that photographs the affected surface, and the tree had no way to say which. Both existing corpus censuses ask which MACHINE took the picture (device pixel ratio, colour profile); neither can see which BUILD did. Added as a third axis rather than a note: readPressedAccentFill recovers 'was a Home-tab toggle latched' from a golden's bytes, EMPTY_DOCUMENT_GOLDENS declares the population and is checked against the SPEC source so it cannot claim a populated capture is empty, and STALE_PRODUCT_STATE_GOLDENS is a two-sided quarantine that expires the moment the file is re-recorded.
**Fix:** fixed — Re-recorded on a COLD app inside a full ordered --project=functional run with --update-snapshots=changed, which rewrote exactly three files and nothing else. THE PREDICTION WAS EXACT: the live comparator reported 2,173 differing pixels, the same 2,173 computed off the committed bytes with no run, and decoding the pair gives 510 of the predicted 221,245,237 fill against a 200-pixel budget. The file now measures 36 pressed-accent pixels, the same 36 its re-recorded sibling core-empty-grid.png holds. The STALE_PRODUCT_STATE_GOLDENS quarantine then did what it was built to do: it requires its entry to STILL measure 546, so re-recording the file correctly turned the census RED on its own entry rather than letting it rot. The entry is deleted and the array is empty. One detector self-test that used this file as its LIT example failed with it, correctly, and now uses sheets-default-tabs.png, which is lit legitimately (its capture follows a setCellValue) and will still be a valid example next year.
  Files: app/e2e/tests/__screenshots__/grid-rendering.spec.ts/empty-grid-full-window.png, app/e2e/goldenCorpus.ts, app/e2e/__tests__/goldenCorpus.test.ts

## BUG-0030 `[fixed]`

**Found:** 2026-08-12 (e2e)
**Oracle:** visual-golden

tests/__screenshots__/ribbon-tabs.spec.ts/ribbon-ribbon-tab-insert.png and tests/__screenshots__/tables.spec.ts/grid-tables-after-create.png were recorded BEFORE BUG-0028 --disable-accelerated-2d-canvas pin and hold the OTHER side of it. ribbon-ribbon-tab-insert: 1,145 differing pixels against a 200-pixel budget, every top transition a neutral grey mapping to a chromatic one (153,153,154 -> 193,153,97; 110,110,110 -> 37,98,156) -- the golden holds GRAYSCALE-antialiased text, the pinned build paints LCD. grid-tables-after-create: a 199x88 crop whose budget is min(200, 0.0005*17512) = 8.75 px; 36 pixels cross the YIQ gate and the actual is systematically about 1 unit lighter (mean signed delta R +1.44 G +1.07 B +0.57, max 28), which is the GPU-vs-CPU 2D canvas rasterizer. Both diffs are BYTE-IDENTICAL across two independent cold runs.

**Repro:** Run --project=functional from a cold app with the flag on. Deterministic: identical diffs on two independent cold runs (532/11/11, then 540/3/11 after the BUG-0033 fix). No run is needed to see the ribbon half: e2e/__tests__/goldenCorpus.test.ts now measures it off the committed bytes -- the ribbon-strip cohort other seven members sit at 3.8% mid-tone-neutral and this one at 44.8%, a ratio of 11.9x.
**Triage:** test-bug (confidence 0.97) — BUG-0028 pinned a real axis with --disable-accelerated-2d-canvas and stated in webview2Args.mjs that the flag leaves every committed golden on the side it was recorded on, so it costs no re-record at all. That sentence was reached by measuring exactly ONE candidate golden (autocomplete-dropdown-visible) in the two projects that were not re-run. It is false: two functional goldens sit on the other side. This is the twin of BUG-0029 one axis over -- BUG-0029 is a PRODUCT fix invalidating goldens in projects nobody re-ran, this is an ENVIRONMENT pin doing the same. Both generalised from a single measured file.
**Fix:** fixed — Both re-recorded under the pin, on a COLD app, inside a full ordered run, and verified by a further cold run (543 passed / 0 failed / 11 skipped). A FOURTH corpus axis was built to catch the class ahead of a run and then DELETED, which is the more useful half of this entry. The reader restricted the denominator to mid-tone pixels (luminance 40..200, where glyph edges live) and compared inside a cohort of same-element captures; it separated 11.9x against the 4x margin, it fired on the real corpus naming the file, and then the re-record disproved it: the CORRECT recording measures 29.3% against its cohort's 3.8% and the stale one's 44.8%, i.e. 7.7x from its own cohort and only 1.5x from the defect it was meant to distinguish. Part of the Insert ribbon is composited for its own CONTENT reasons in the correctly-pinned build, so a cohort-agreement rule states something true that is not a corpus defect and would have been permanently red. The measurement, including the one number the earlier rejection could not have had (the same file recorded both ways), is written into goldenCorpus.ts so this is not attempted a third time. The guard for this class is a PROCESS rule, not a reader: when a capture pin changes, every project has to run.
  Files: app/e2e/tests/__screenshots__/ribbon-tabs.spec.ts/ribbon-ribbon-tab-insert.png, app/e2e/tests/__screenshots__/tables.spec.ts/grid-tables-after-create.png, app/e2e/goldenCorpus.ts

## BUG-0031 `[fixed]`

**Found:** 2026-08-12 (review)
**Oracle:** walker-action-catalog

e2e/walker/actionCatalog.ts chart.create wrote the chart with a raw save_chart Tauri invoke and told the chart STORE nothing. Measured on a running app: get_charts answered 2 while __CALCULA_CHARTS__.getAllCharts() answered 0. The next two actions read the STORE, so chart.select -- whose entire job is to raise the Chart Design contextual tab -- selected nothing and returned successfully, chart.delete deleted nothing and returned successfully, and getCurrentChartId() stayed null throughout. Their preconditions are satisfied from the BACKEND count, so the generator kept issuing them and the walk kept reporting them executed.

**Repro:** On a running app, invoke save_chart directly and then read __CALCULA_CHARTS__.getAllCharts(): backend 2, store 0. chart.select is then a no-op and no contextual tab ever appears.
**Triage:** test-bug (confidence 0.98) — The lesson table.delete had already learned in this same file (THE PRODUCT OWN DELETE, not a raw delete_table invoke) was never applied to charts. The consequence is the shape this program keeps deleting: the contextual-ribbon-tabs invariant -- the very invariant that found BUG-0026 -- could NEVER observe a chart tab, because nothing in the catalog could raise one. Section 3cd matrix lists Chart as already correct, which is a reading of the source; the walk that would have tested it was structurally unable to.
**Fix:** fixed — chart.create goes through the store own createChart (what Insert > Chart calls), which pushes into the store AND persists through the same save_chart, so the backend sees exactly what it saw before and the store is no longer blind. Proved live by the positive control in cascade-announcement-live.spec.ts: before the fix, the assertion that a selected chart must raise a chart contextual tab FAILED with Received: []; after it, the tab appears and the sheet-delete cascade removes it.
  Files: app/e2e/walker/actionCatalog.ts, app/e2e/journeys/cascade-announcement-live.spec.ts

## BUG-0032 `[fixed]`

**Found:** 2026-08-12 (review)
**Oracle:** state-snapshot

captureSnapshot().logical.activeSheet has been a CONSTANT 0 for the whole life of e2e/invariants/stateSnapshot.ts. It read gridState.activeSheet, which does not exist -- the grid state exposes sheetContext.activeSheetIndex -- so the ?? 0 defaulted every time. Probed on a running app sitting on Sheet2: sheetContext.activeSheetIndex was 1 and the field said 0.

**Repro:** Switch to any sheet other than the first and read captureSnapshot().logical.activeSheet. It answers 0.
**Triage:** test-bug (confidence 1) — A defaulted read of a misspelled key is indistinguishable from a correct read of a true value, which is why it survived. The field appears in every soak and invariant failure bundle and in every minimized trace, so every triage that reasoned about which sheet was active was reasoning from a constant.
**Fix:** fixed — Falls back through sheetContext.activeSheetIndex, keeping the old key first so a rename in the other direction is picked up rather than silently zeroed. Asserted live: adding a sheet switches to it, and the journey spec requires snapshot.logical.activeSheet to equal the new index.
  Files: app/e2e/invariants/stateSnapshot.ts, app/e2e/journeys/cascade-announcement-live.spec.ts

## BUG-0033 `[fixed]`

**Found:** 2026-08-12 (e2e)
**Oracle:** functional-suite

Three MCP specs asserted Tauri events that BUG-0026 DELETED -- tables:refresh, pivots:refresh, named-ranges:refresh -- so all three failed at step 3. Worse, mcp-create-table and mcp-create-pivot removed the object they created only in step 4 undo, INSIDE the try, after the assertion that threw; their finally blocks cleared the seeded cells and left the OBJECT. The AI-created table then sat at A1:B3 for the rest of the ordered run with its header fill, its banded rows and its Table Design contextual ribbon tab, and took later tests down with it -- paste-special x2 and scrolling photographed the blue table where their goldens hold white, and two ribbon-tabs goldens differed by exactly the 68x12 px of the extra tab label. Three root failures presented as eleven.

**Repro:** Run --project=functional in its natural order after BUG-0026. Root-versus-cascade was proved by measurement rather than argument: fixing ONLY the three MCP specs took the same ordered cold run from 11 failures to 3.
**Triage:** test-bug (confidence 0.99) — BUG-0026 replaced five bespoke per-kind Tauri announcements with one mutation:refresh carrying domains and source, fanned out by the Shell through MUTATION_DOMAIN_EVENTS. The PRODUCT is correct -- verified live: the backend announces the right domain and the Shell dispatches the feature event the extension consumes. The tests named a transport that no longer exists, and nothing unit-tier could see it, because the contract they assert is a live Tauri event. The cleanup half is independent and worse: a cleanup that runs only when the assertions passed is not a cleanup.
**Fix:** fixed — Each spec now asserts BOTH halves, and they fail for opposite reasons: that the BACKEND announced (a mutation:refresh arrived naming the domain ObjectKind maps to in object_deps::ui_domain -- objects / pivot / namedRanges), and that the UI HEARD IT (the Shell fanned out TABLE_DEFINITIONS_UPDATED / pivot:refresh / NAMED_RANGES_CHANGED, which is what actually decides whether the user sees the object). Naming the transport alone could never have distinguished a broken bridge from a silent backend. The table and the pivot are now removed BY NAME in finally, unconditionally.
  Files: app/e2e/tests/mcp-create-table.spec.ts, app/e2e/tests/mcp-create-pivot.spec.ts, app/e2e/tests/mcp-create-named-range.spec.ts

## BUG-0034 `[fixed]`

**Found:** 2026-08-12 (code-review)
**Oracle:** undo-round-trip

Undo of a non-cell change lands on the ACTIVE sheet rather than the sheet it was recorded on. CellChange::SetColumnWidth / SetRowHeight / AddMergeRegion / RemoveMergeRegion / RestoreSnapshot carried no sheet dimension at all, and apply_changes wrote them into state.column_widths / state.row_heights / state.merged_regions / state.grid unconditionally. The severe case is RestoreSnapshot, which replaces a WHOLE grid: insert a row on Sheet2, click the Sheet1 tab, press Ctrl+Z, and Sheet1's entire cell map is replaced by Sheet2's saved one -- silently, with no error and no way back.

**Repro:** Three ordinary actions. Rust reproduction: undo_commands::undo_sheet_domain_tests::a_structural_snapshot_undo_does_not_replace_the_active_sheets_whole_grid (and three siblings for widths, heights and merges). Each fails when the off-sheet routing in apply_changes is disabled, and the control test the_active_sheet_path_is_unchanged_by_the_off_sheet_one still passes -- i.e. only the previously-broken branch changed.
**Triage:** app-bug (confidence 1) — Same missing dimension as BUG-0005, on the changes that never got one. 'The active sheet' is true when these are RECORDED and need not be true when they are RESTORED. Found while sweeping BUG-0005's family; not reachable by that bug's fix, because no sheet structural operation is involved.
**Fix:** fixed — The four variants now carry the sheet they were recorded on, exactly as SetCell does. When that sheet IS the active one the arms behave byte-identically to before -- which is what makes the change safe without a live run -- and when it is not, the restore is queued into the pass's existing DEFERRED phase and applied to all_column_widths / all_row_heights / all_merged_regions / grids[sheet] there. Deferred rather than inline because apply_changes holds the active mirrors for its whole pass and set_active_sheet takes mirror-then-all in every case, so reaching for the all- stores inline would both invert the lock order and deadlock against the pass's own non-reentrant guards (the same trap the pivot column-width restore fell into). The off-sheet snapshot path also runs record_subscription_override_edits for its own sheet, so it does not repeat the gap the JSON-payload sheet_structural_snapshot path has.
  Files: core/engine/src/undo.rs (sheet on GridSnapshot, SetColumnWidth, SetRowHeight, AddMergeRegion, RemoveMergeRegion; recorders take it), app/src-tauri/src/undo_commands.rs (OffSheetGeometry + apply_off_sheet_geometry, run in the DEFERRED phase), app/src-tauri/src/commands/dimensions.rs, app/src-tauri/src/merge_commands.rs, app/src-tauri/src/commands/structure.rs (recorders stamp the active sheet), app/src-tauri/src/undo_sheet_domain_tests.rs (GAP 4: 5 tests incl. the active-path control)

## BUG-0035 `[fixed]`

**Found:** 2026-08-12 (walk, seed 90010001)
**Oracle:** walker-action-effect

The walker's chart SELECT and DELETE actions are silent no-ops, and so is the chart half of deepResetForWalk. All three pass a chart's identity as `charts[0].id`, but a ChartDefinition in the frontend store keys its identity as `chartId` (the BACKEND's ChartEntry is the one that calls it `id`). Every call therefore receives `undefined` and returns successfully having done nothing. MEASURED LIVE on a 75-action chart-weighted invariant walk: 46 chart actions ran, `get_charts` afterwards answered 9, and `__CALCULA_CHARTS__.getCurrentChartId()` was still null -- nothing had ever been selected and nothing had ever been deleted. This is the residual of BUG-0031, which fixed the CREATE half (backend-only -> store+backend) and left select/delete reading a key that does not exist.

**Repro:** E2E_MANUAL=1 INVARIANT_SEED=90010001 INVARIANT_CATEGORY_WEIGHTS="chart:10" npx playwright test --project=invariant --grep "random action sequence". The walk passes; then probe the app: `get_charts` returns 9 while `getCurrentChartId()` is null. Minimal form: run the catalog's chart.create then chart.delete against a live app and observe get_charts stays at 1.
**Triage:** test-bug (confidence 0.99) — One object type in this tree names its store id differently from its backend id (`chartId` vs `id`); slicers and sparkline groups both use `id`, so the harness's uniform `.id` read is correct everywhere except charts. Nothing asserted that a walker action had an effect, so the mismatch was invisible: the action ran, the trace recorded it, and the oracles compared an unchanged workbook to an unchanged workbook.
**Fix:** fixed — chart.select and chart.delete read `charts[0].chartId ?? charts[0].id` and THROW naming the available keys when neither exists, so a future rename fails loudly instead of no-opping; deepResetForWalk reads the same. The lasting fix is the new live guard spec `e2e/soak/walker-action-effects.spec.ts`: it drives the catalog's own ActionDef objects against a running app and asserts each one's observable effect -- create raises both the backend and the store count and yields a usable id, select raises the Chart Design contextual tab AND sets getCurrentChartId, deselect clears it, delete lowers both counts, deepResetForWalk really empties the store, and a generic net checks create-raises/delete-lowers for chart, table, slicer and sparkline. A unit test cannot see any of this: the defect is in the seam between the harness and a live extension, which is where all three instances of it (table.delete, BUG-0031, BUG-0035) have been.
  Files: app/e2e/walker/actionCatalog.ts, app/e2e/walker/reset.ts, app/e2e/soak/walker-action-effects.spec.ts

## BUG-0036 `[fixed]`

**Found:** 2026-08-12 (walk, seed 90010001)
**Oracle:** contextual-ribbon-tabs

Contextual tab "Chart Design" is visible but at least one chart must exist. Found: slicers=0, charts=0, tables=1, pivots=0, timelines=0, sparklines=0. ROOT CAUSE: there were TWO chart-delete recipes and they had drifted. The UI path (Delete key / context menu) deselected the chart and cleared its render cache with removeChartFromCache; the component-store registry's deleteChart -- the route used by object scripts, the MCP tools and the broker's api.deleteChart -- did NEITHER. Deleting the selected chart from a script therefore left the contextual Chart Design tab on screen over a workbook with zero charts, with getCurrentChartId() still returning the dead id, so every Chart Design command was aimed at a chart that no longer existed. Two further drifts rode along: no CHART_SELECTION_CHANGED emission (FormulaBar/NameBox kept the deleted chart's name), and invalidateChartCache (which only bumps a version counter) standing in for removeChartFromCache (which drops the OffscreenCanvas, the parsed data cache, the point selection and the widget values) -- so a script-deleted chart leaked all four for the life of the session under an id nothing could reach again.

**Repro:** `tests/regression/repros/BUG-0036.trace.json` (3 actions)
**Triage:** product-bug (confidence 0.97) — A copied recipe, the failure mode the Seam Rule already names: `performChartDelete` was a local closure inside activate() and the component-store registry re-implemented it from memory. The copies could not be compared because neither was reachable from the other. Excel parity is unambiguous -- deleting a chart clears its selection and the contextual tab goes with it -- and Microsoft's own contextual-tab behaviour is that the tab exists only while its object is selected.
**Fix:** fixed — ONE chart delete. `performChartDelete(chartId): boolean` is hoisted to module scope in Charts/index.ts and is now the only implementation: it refuses an unknown id, deselects AND announces the selection change when the deleted chart is the selected one, deletes from the store, removes (not merely invalidates) the render cache, re-syncs the grid regions, and emits CHART_DELETED + GRID_REFRESH. The component-store registry method delegates to it (so api.deleteChart / MCP / object scripts get the whole recipe), the Delete key and context-menu handlers delegate to it, and the E2E bridge `__CALCULA_CHARTS__.deleteChart` now hands out the PRODUCT'S delete instead of the raw chartStore primitive -- the same correction `chart.create` needed in BUG-0031. `chartStore.deleteChart` is left as what it always was, an internal store+backend persistence primitive with no external callers. The deselect is CONDITIONAL, which the old UI copy was not: deleting chart A while chart B is selected must leave B selected, as Excel does, and the context-menu route could already pass a non-selected id.
  Files: app/extensions/Charts/index.ts, app/e2e/soak/walker-action-effects.spec.ts

## BUG-0037 `[fixed]`

**Found:** 2026-08-12 (walk, seed 1786456498740)
**Oracle:** ui-not-blocked

`ribbon.switch-tab` opens the Customize Home Tab modal by accident, and the walk then runs to completion with the UI unreachable and reports PASS. The action matched its target with `page.locator("button").filter({ hasText: name }).first()` -- a SUBSTRING match resolved by DOM order. Clicking the "View" tab opens the View MENU, whose "Customize Home Tab..." item is a <button> containing the word "Home" and sits at DOM index 22, ten positions before the real ribbon Home tab at 32. So the action's "return to Home" click opened a modal: position fixed, z-index 1050, covering 100% of the viewport, with NO role="dialog" (so the long-captured `visibleDialogCount` stayed 0). From that step on every UI action in the walk clicked into the modal's backdrop; each burned the 30s `actionTimeout` and was TOLERATED by the runner. MEASURED on seed 1786456498740: two such throws, 60 seconds of a 75-action walk spent clicking nothing, reported as a pass. Before `actionTimeout` was set at all this same state hung forever -- it is the unexplained twelve-minute stall at `[step 47/75] ribbon.switch-tab` recorded in playwright.config.ts, now diagnosed.

**Repro:** E2E_MANUAL=1 INVARIANT_SEED=1786456498740 npx playwright test --project=invariant --grep "random action sequence". Pre-fix: passes, with two `[action failed] ribbon.switch-tab: locator.click: Timeout 30000ms exceeded` at steps 41 and 42. With the `ui-not-blocked` invariant in place but the old locator restored, the same seed FAILS at step 40 naming the modal. Direct proof of the locator confusion: open the View menu, then enumerate buttons whose text contains "Home" -- "Customize Home Tab..." is at DOM index 22, the ribbon tab at 32.
**Triage:** test-bug (confidence 0.99) — Two independent gaps met. (1) A substring `.first()` locator can click a completely different control than the one named. (2) The walker had no notion of 'the UI is unreachable', so a poisoned state was indistinguishable from a healthy one: an action that cannot click is tolerated, and the only signal -- `visibleDialogCount` -- was captured after every action and read by nothing, and would not have fired anyway because the modal carries no ARIA role.
**Fix:** fixed — Three changes, and only the first is the bug. (1) `ribbon.switch-tab` presses Escape (closing whatever a previous action left open) and targets `getByRole("button", { name, exact: true })`, which cannot match "Customize Home Tab..." while looking for "Home". (2) NEW INVARIANT `ui-not-blocked`: `captureVisualState` hit-tests the centre of a real ribbon tab button with `document.elementFromPoint` and records `visual.ribbonBlockedBy` when the hit is neither the button nor inside the tab strip -- a question immune to both styled-components hashes and missing ARIA roles. A walk that continues with a covered ribbon now FAILS naming the covering element instead of quietly proving nothing. (3) The walker now takes an overlay census the moment an action throws (`ActionTiming.overlays`: every position:fixed/absolute element covering >=40% of the viewport, with class, z-index, pointer-events and text). That census is what identified this bug in a single run, after the register had carried the undiagnosed hang for a pass.
  Files: app/e2e/walker/actionCatalog.ts, app/e2e/walker/walkRunner.ts, app/e2e/invariants/stateSnapshot.ts, app/e2e/oracles/cheapInvariants.ts, app/e2e/__tests__/cheapInvariants.test.ts

## BUG-0038 `[fixed]`

**Found:** 2026-08-12 (walk, seed 90040001)
**Oracle:** selection-in-bounds

Malformed selection (endRow < startRow): {"startRow":14,"startCol":1,"endRow":3,"endCol":6}. ROOT CAUSE, measured on the running app: a ZERO-DURATION click leaves the grid permanently dragging. `handleGlobalMouseUp` in useMouseSelection is always attached but reads isDragging/isSelectionDragging/... from the CLOSURE of the render it was attached in. A mousedown starts a drag with setIsDragging(true); when the matching mouseup is dispatched before React commits that state, the still-attached handler sees every flag false and ends nothing. The flag then stays true forever, and the conditional `mousemove` listener -- which IS attached on the next render -- extends the selection on every subsequent pointer MOVE with no button held. Live matrix: hold 0ms -> the selection follows the pointer forever; hold 5ms/20ms/150ms -> correct. A physical mouse never produces a 0ms click, which is why no human reported it; `element.click()` always does, so every synthetic click -- macro replay, object scripts, MCP-driven interaction, OS-synthesized touch/pen taps -- puts the grid into an unending drag. It reached the surface as an INVERTED range because the walk clicked a cell and then a chart: the chart overlay consumes the second mousedown, so nothing re-anchored the phantom drag and the malformed selection survived to be observed. Anything iterating startRow..endRow over it silently operates on nothing.

**Repro:** `tests/regression/repros/BUG-0038.trace.json` (3 actions)
**Triage:** product-bug (confidence 0.95) — A React closure-vs-event-timing race in Core interaction code. The teardown handler is always mounted but only ever sees the state of the render that mounted it, so an event that arrives inside the same commit window is dropped. Widened by the header paths being `await`ed, which can move setIsDragging(true) a whole task past the mousedown.
**Fix:** fixed — LATCH THE MISSED EVENT rather than duplicate the teardown. `handleGlobalMouseUp` gains a final `else` branch: when no drag is committed it records `pendingMouseUpRef` instead of returning silently. The same effect, which re-runs whenever the drag flags change, replays `handleGlobalMouseUp` the moment a drag becomes visible while the latch is set -- so the ONE teardown recipe runs, one render later, with a consistent closure. A native window `mousedown` listener (capture phase) clears the latch so a stale one can never end a later gesture. THE POSITION OF THAT CLEAR WAS MEASURED, NOT GUESSED: the first attempt cleared it at the top of `handleMouseDown` and the fix did not work, because instrumentation showed the React handler running AFTER the window mouseup ('up' then 'down' in the log) -- it is async and delegated. A plain window listener runs during mousedown dispatch, which always completes first.
  Files: app/src/core/hooks/useMouseSelection/useMouseSelection.ts, app/e2e/soak/synthetic-click-drag.spec.ts

## BUG-0039 `[fixed]`

**Found:** 2026-08-12 (walk, seed 20260810)
**Oracle:** native-dialog-blocking

A NATIVE dialog hangs the walker silently and indefinitely. MEASURED: a soak walk stopped printing at `[shrink] replay 22` and sat there. Fifteen minutes later the app was still answering `page.evaluate`, a screenshot showed an ordinary spreadsheet, and `list-app-windows.ps1` reported TWELVE visible `#32770` windows stacked on it -- `TEXT:Failed to rename sheet: Sheet index 2 out of range`. The walk burned its whole 30-minute spec timeout without printing a line. TWO independent causes met. (1) The shrinker recorded `sheet.rename {tabIndex: 2}` against a three-sheet workbook, then dropped the `sheet.add` that made the third sheet and replayed the rename against two; `ActionDef.precondition` received only the snapshot, never the recorded params, so it could ask 'are there two sheets?' but never 'does sheet 2 exist?' -- and the catalog's own header had been promising that preconditions are re-checked on replay. (2) Nothing in the harness could see or answer a native dialog: it is a separate Win32 window, absent from page screenshots, with no DOM, and invisible to the new `ui-not-blocked` invariant's elementFromPoint hit test. `deepResetForWalk` issues a long chain of invokes inside ONE `page.evaluate` with no timeout, so a blocked IPC channel there is an unbounded await.

**Repro:** Add a sheet, then dispatch `sheet:requestRename` with an index one past the end, repeatedly. Each raises an alertAsync message box that nothing answers. Then call deepResetForWalk: before the fix it never returns. e2e/soak/native-dialog-hang.spec.ts rebuilds the pile (12 alerts) and asserts the reset clears it.
**Triage:** test-bug (confidence 0.95) — The harness had exactly one blind spot left that a timeout could not cover, and a shrink step that could manufacture invalid input walked straight into it. Playwright's actionTimeout bounds locator actions, not `page.evaluate`, so the one place the walker awaits an unbounded chain of invokes -- the reset -- was the one place with no bound.
**Fix:** fixed — Both causes, and a bound for what neither covers. (1) `ActionDef.precondition` now takes the recorded `params` as an optional second argument, supplied ONLY on the replay path (the generator has none yet, so both sheet actions stay generatable); `sheet.rename` and `sheet.switch` refuse a tabIndex that no longer addresses a sheet, and `createTraceSource` hands the params over -- without that wiring the preconditions are correct and the walk still hangs. (2) NEW `e2e/helpers/nativeDialogs.ts` wraps `answer-native-dialog.ps1` for the Node side: `readNativeDialogText()` and `sweepNativeDialogs()`, which dismisses the whole STACK (they pile one per replay) and returns each message, because the text is the only evidence of what raised it. `deepResetForWalk` sweeps before anything else and prints what it cleared -- a reset that has to clear dialogs is itself a finding -- and is now bounded (90s) with one retry, then throws a named error instead of hanging. The walk runner additionally bounds `captureSnapshot` (45s, its first invoke after every action) and, on timeout, sweeps, names the dialogs and fails with `native-dialog-blocking`. NOT CLAIMED: that a single alert blocks IPC. Measured on the live app, one open alert left `get_charts` answering normally; the pile-up is what stopped `new_file`. The sweep keeps the pile from forming; the timeouts are the backstop.
  Files: app/e2e/helpers/nativeDialogs.ts, app/e2e/walker/reset.ts, app/e2e/walker/walkRunner.ts, app/e2e/walker/actionCatalog.ts, app/e2e/walker/sources.ts, app/e2e/soak/native-dialog-hang.spec.ts, app/e2e/__tests__/walkerReplayPreconditions.test.ts

## BUG-0040 `[fixed]`

**Found:** 2026-08-13 (walk, seed 20260810)
**Oracle:** save-reload-round-trip

Removing a table's AutoFilter does not survive save/reload: the LOAD path invents the filter again. Digest diff, two entries: `tables.<id>.autoFilterId: "<absent>" -> "<new id>"` and `autoFilters.0: "<absent>" -> {enabled:true, startRow:0, startCol:30, endRow:2, endCol:32, ...}` -- exactly the walker's table range AE1:AG3. MECHANISM, read off the source: `create_table` creates an AutoFilter when `show_filter_button` is set (tables.rs ~line 865), `remove_auto_filter` removes it, and `auto_filter_id` is derived state that is never persisted. On load, `persistence.rs` finds no `autofilters.json` for the sheet and executes a block commented "Seed a filter from the lowest filter-button table when the workbook has none saved (pre-existing behavior, kept)" -- manufacturing an AutoFilter from the lowest filter-button table and then relinking ownership to it. So a filter the user deliberately removed comes back on reopen, and the reopened document now differs from the one that was saved.

**Repro:** `tests/regression/repros/BUG-0040.trace.json` (2 actions)
**Triage:** product-bug (confidence 0.9) — A legacy compensation in the load path outliving its reason, in the same family as the suppressions §5 and §10a are about. The seed exists so that a workbook with filter-button tables and no saved filters still shows filter buttons; since `create_table` now establishes the filter itself, the only workbooks that reach the seed are ones whose filter was REMOVED on purpose.
**Fix:** fixed — ROOT CAUSE, and it is not the load-path seed the entry pointed at. Calcula kept TWO records of one thing: `Table.style_options.show_filter_button` (persisted, on the table) and the entry in `auto_filters` (persisted separately in autofilters.json). `create_table` wrote both; `remove_auto_filter` cleared only the second. `Table.auto_filter_id` is derived state that is never saved, so the load path reconstructs it -- and finding no saved filter for a sheet whose table STILL advertised buttons, it seeded one from that table. The removal was undone by the reopen. EXCEL PARITY SETTLES THE DESIGN: Excel has a single state, `ListObject.ShowAutoFilter`. Data > Filter (Ctrl+Shift+L) on a table and Table Design > Filter Button are the same switch, and turning it off persists. There is no Excel state where a table shows filter dropdowns but has no filter. So `remove_auto_filter_inner` now clears `show_filter_button` on the table that OWNED the removed filter (matched by exact id, so bystander tables on the same sheet keep their own buttons). THE SEED STAYS, AND THAT IS THE QUESTION THE ENTRY SAID THE FIX COULD NOT ANSWER BY ITSELF -- so it was traced rather than guessed. `load_xlsx` (core/persistence/src/xlsx_reader.rs) hard-codes `user_files: HashMap::new()`, so an imported workbook NEVER carries an autofilters.json; the `show_filter_button` in the table metadata is the only record of its filters that exists. Deleting the seed would have silently stripped the filter buttons from every imported workbook. With the flag now cleared on removal, the seed only fires for a table that still asks for buttons -- exactly its job. UNDO HAD TO MOVE WITH IT, or the fix would have traded one bug for another: ownership is RE-DERIVED from `show_filter_button` by `relink_autofilter_owner`, so an undo restoring the filter alone would restore an ORPHAN -- a sheet filter no table claims, on a table showing no buttons to clear it with. `AutoFilterObjSnapshot` grew a `filter_buttons: Vec<(EntityId, bool)>`; the restore arm applies it and records the CURRENT values into the inverse so redo is exact; `record_autofilter_undo_with_buttons` is the one recorder that populates it, and the other nine autofilter recorders pass an empty vec (a criteria change moves no buttons).
  Files: app/src-tauri/src/autofilter.rs, app/src-tauri/src/undo_commands.rs, app/src-tauri/src/autofilter_table_button_tests.rs, app/e2e/journeys/orphaned-sheet-state.spec.ts

## BUG-0041 `[fixed]`

**Found:** 2026-08-13 (walk, seed 90050003)
**Oracle:** save-reload-round-trip

A sparkline group created on a sheet that is then DELETED survives in the backend under the dead sheet's index, and reappears on ANOTHER SHEET after save/reload. Digest diff: `sparklines.1` present before save and absent after; `sparklines.0[1]` absent before and present after -- the same group, re-keyed from the deleted sheet 1 onto sheet 0, where it becomes that sheet's second group. A hyperlink goes the other way: `hyperlinks.1:16:0` present before, absent after. So the in-memory workbook holds per-sheet state for a sheet that no longer exists, and the loader resolves the out-of-range index by landing it on sheet 0. This is data appearing on the WRONG SHEET after a reopen.

**Repro:** `tests/regression/repros/BUG-0041.trace.json` (3 actions)
**Triage:** product-bug (confidence 0.85) — NOT the obvious one, and that is why it is filed rather than patched. `cascade_sheet_removed` (object_deps.rs ~1594) DOES walk `state.sparklines` and drops every entry whose sheet index remaps to None, and `object_deps.rs`'s own census carries the rule `sparkline.sheetIndex -> cascade_sheet_removed`. The census is satisfied and the entry survived anyway, so the leak is elsewhere: the likely candidates are the FRONTEND sparkline store re-persisting after the cascade ran (the walker creates through `__CALCULA_SPARKLINES__`, which write-throughs to the backend), or the walker's `sheet.delete` UI path completing after the cascade. Hyperlinks are a separate question again: they are cell-keyed with the sheet in the key, like comments, and comments ARE remapped in `remap_sheet_keyed_stores` while hyperlinks and notes are not listed there at all.
**Fix:** fixed — The entry named three candidate mechanisms and refused to guess. It is the FIRST -- the frontend write-through -- and the damage is done by two SILENT FALLBACKS in the serialiser that nobody had connected to it. MECHANISM, end to end. (1) `cascade_sheet_removed` correctly drops the sparkline entry whose sheet index no longer resolves -- this half was never broken, which is exactly why the object-deps census was satisfied while the bug was live. (2) The Sparklines extension saves on every SHEET_CHANGED (`saveNow()` in extensions/Sparklines/index.ts), and SHEET_CHANGED also fires for a sheet COLLECTION change; the grid-state snapshot still holds the PRE-change active index, so the save arrives naming the DELETED sheet and re-inserts what step 1 removed. (3) On save, `sheet_index_to_id` could not resolve that index and MINTED A FRESH RANDOM SheetId -- turning a detectable inconsistency into an undetectable one. (4) On load, `sheet_id_to_index` could not find that id and answered `0`. The orphan landed on the first sheet. FIXED AT ALL THREE LEVELS. (a) `save_sparklines_impl` refuses an entry naming a sheet index that does not exist, reading the live `sheet_names` length -- the backend is the authority on which sheets exist and no longer takes the caller's word for it. The refusal is silent and CLEAN: the write is spurious, so it must not dirty the document. (b) `sheet_index_to_id` now returns `Option<SheetId>` and (c) `sheet_id_to_index` returns `Option<usize>`; all 29 call sites drop the orphan instead. STEPS 3 AND 4 WERE NEVER SPARKLINE-SPECIFIC and that is the real weight of this entry: every per-sheet store on the save/load path routes through that one pair -- tables, slicers, charts, conditional formats, data validation, comments, scenarios, outlines, named ranges and sheet PROTECTION. Any of them, orphaned by any means, was being relocated onto sheet 0 rather than dropped. Two call sites needed more than a mechanical change: a SHEET-SCOPED named range whose sheet is gone is dropped rather than flattened to workbook scope (flattening `Some(idx)` to `None` would silently promote a local name to global), and a pending-recalc marker naming a missing sheet is dropped rather than landing on sheet 0 and warning that a calculated sheet is stale. The frontend was deliberately NOT changed: its stale write is harmless now that the authority refuses it, and for an ordinary sheet SWITCH the pre-change index it uses is the correct one.
  Files: app/src-tauri/src/sparkline_commands.rs, app/src-tauri/src/persistence.rs, app/src-tauri/src/orphaned_sheet_state_tests.rs, app/src-tauri/src/document_effect_objects_tests.rs, app/e2e/journeys/orphaned-sheet-state.spec.ts

## BUG-0042 `[open]`

**Found:** 2026-08-13 (e2e)
**Oracle:** functional-assertion

Clicking a cell that carries a NOTE does not open the note editor, and the note's red indicator triangle DISAPPEARS at the same moment. `vba-idioms-wave4.spec.ts:735` step 'clicking the annotated cell opens the note editor with the text' fails on `locator('textarea:visible').first()` — element(s) not found, 10s. MEASURED, and this is the part that makes it a product bug rather than a flaky test: the two screenshots the spec itself writes show the triangle PRESENT on AA61 before the click (wave4-note-triangle.png) and ABSENT after it (test-failed-1.png), with AA61 selected and no overlay. NO DATA IS LOST. A direct probe (add_note at row 60/col 26, grid:refresh, click AA61) reports 0 visible textareas while `get_note` STILL returns the note, byte-identical, after the click. So the note is intact in the backend and unreachable from the UI: clicking is the product's documented inspection gesture for a note (the spec's own comment records that the hover preview in hoverHandler.ts is unwired dead code — initHoverHandler has no caller), so there is currently NO way to read a note's text by pointing at it.

**Repro:** FOUR BACKEND CALLS AND ONE CLICK, on a cold app, no macro and no editor involved: (1) new_file; (2) add_note {params:{row:60,col:26,authorName:'Probe',content:'PROBE-NOTE-TEXT',richContent:null,width:null,height:null}}; (3) dispatch window Event('grid:refresh') and wait ~1.2s — the triangle paints; (4) click cell AA61. Then: page.locator('textarea:visible').count() === 0, and get_note {row:60,col:26} still returns the note. Full-suite form: E2E_MANUAL=1 npx playwright test --project=functional --grep "setNote/getNote/listNotes". IT REPRODUCES COLD AND ALONE — which corrects the previous pass's triage (§10 recorded it as passing on a cold app and therefore order/residue dependent). It was re-run twice on a freshly launched app with nothing else in the run and failed both times.
**Triage:** product-bug (confidence 0.85) — A SYNCHRONOUS READ OF AN ASYNCHRONOUSLY REFILLED CACHE. `handleAnnotationClick` (app/extensions/Review/handlers/clickHandler.ts) opens the editor only if `getNoteIndicatorAt(row, col)` returns something, and that is a synchronous `Map.get` on `noteIndicatorMap` in app/extensions/Review/lib/annotationStore.ts. The map is refilled only by `readAnnotationState()`, which is `async` (it awaits getCommentIndicators/getNoteIndicators), while `invalidateAnnotationCache()` and `resetAnnotationStore()` CLEAR both maps synchronously. So any invalidation opens a window — and, if nothing re-triggers the read, a permanent state — in which the indicator is absent: the click handler returns false (no editor) and the decoration paints nothing (no triangle). That is exactly the pair of symptoms observed, and it explains why the triangle can be present one paint and gone the next without the note changing. NOT VERIFIED: which invalidation fires here, and whether the re-read is never re-triggered or merely late. Distinguishing those is the first work, because they need different fixes (re-trigger vs. make the read await-and-retry), and guessing between them is how a fix makes a test go green without making the product right.
**Fix:** not-attempted — NOT FIXED THIS PASS, and deliberately: it is a frontend defect in the Review extension, outside the sheet/undo/persistence work this pass was sent to do, and it long predates it — §10 already reported this exact test failing. It is filed rather than patched because the cheap fix (have the click handler await a refresh before deciding) would make the test green while leaving the DISAPPEARING TRIANGLE untouched, and the triangle is the half a user actually notices. What this pass adds is the evidence the previous triage lacked: it reproduces COLD AND ALONE, it is not order-dependent, no data is lost, and the mechanism is a synchronous read of an asynchronously refilled cache with a named pair of functions.
