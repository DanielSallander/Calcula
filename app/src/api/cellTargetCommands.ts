//! FILENAME: app/src/api/cellTargetCommands.ts
// PURPOSE: The Rust commands that ACCEPT a cell target (`target:
//          Option<CellTargetRef>`), by their snake_case names -- the list the
//          wrappers fail closed on.
// CONTEXT: P3 (owner finding G3, floating grids take every Home command). A
//          Rust params struct has no `deny_unknown_fields` and Tauri drops an
//          unknown argument, so a `target` sent to a command that has not
//          learned it yet is silently IGNORED: the command acts on the ACTIVE
//          sheet at the floating grid's local coordinates and reports success
//          (BUG-0185 again). `placementArgs` (core/lib/tauri-api.ts) therefore
//          THROWS "<command> does not accept a floating grid target yet." for a
//          target on any command not listed here.
//
// THE LIST GROWS WITH THE RUST SIDE, IN THE SAME STEP. It starts EMPTY; each
// Rust step adds exactly the commands it taught, so the list is true at the
// end of every wave. `app/src/api/__tests__/cellTargetDoorCensus.test.ts`
// (check 3) reads the Rust sources and asserts the list both ways: every name
// here takes a `CellTargetRef`, and every command that takes one is here.
//
// NOTE: no imports. core/lib/tauri-api.ts reads this file, and the API layer
// must stay cycle-free beneath it.

/** The snake_case Rust command names that accept `target`. */
export const TARGET_COMMANDS: readonly string[] = [
  // S2: the styled read the floating grid paints from.
  "get_cell_target_cells",
  // S3: the style commands (written on the backing sheet only).
  "apply_formatting",
  "adjust_number_format_decimals",
  "apply_border_preset",
  "set_cell_rich_text",
  "apply_named_style_range",
  // S4: content, clear, sort, merge, search, Go To Special and conditional
  // formatting (the backing sheet only; host protection gates every write).
  "clear_range_with_options",
  "sort_range",
  "fill_range",
  "update_cells_batch",
  "merge_cells",
  "unmerge_cells",
  "go_to_special",
  "find_all",
  "count_matches",
  "replace_all",
  "replace_single",
  "add_conditional_format",
  "update_conditional_format",
  "delete_conditional_format",
  "reorder_conditional_formats",
  "get_all_conditional_formats",
  "clear_conditional_formats_in_range",
  // S5: whole rows/columns with table semantics (the backing sheet shifts and
  // the object's window grows or shrinks, one undo step), and line sizes and
  // hidden lines on the OBJECT's own maps (host Format Rows/Columns option).
  "insert_rows",
  "insert_columns",
  "delete_rows",
  "delete_columns",
  "set_row_heights",
  "set_column_widths",
  "set_rows_hidden",
  "set_cols_hidden",
];

/**
 * Where the wrapper puts `target` on the wire. The commands listed here carry
 * their sheet selector INSIDE their `params` struct (`ClearRangeParams`,
 * `SortRangeParams`) or take only a params struct (`AddCFParams`,
 * `UpdateCFParams`), so `target` is a `#[serde(default)]` field of that struct;
 * every other command takes it as its LAST top-level argument. The Rust step
 * that teaches one of these commands follows this placement (the census
 * accepts either form).
 */
export const TARGET_IN_PARAMS: readonly string[] = [
  "clear_range_with_options",
  "sort_range",
  "add_conditional_format",
  "update_conditional_format",
];
