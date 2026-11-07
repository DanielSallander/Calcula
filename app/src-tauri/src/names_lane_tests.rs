//! FILENAME: app/src-tauri/src/names_lane_tests.rs
//! PURPOSE: Ledger programme 2, lane `names` -- the defined-name registry
//! keyed by (scope, name) (BUG-0744), a relative name read at the active cell
//! by the Name Box and Go To (BUG-0749), and Excel's name-character rule on
//! every name door (BUG-0741), driven through the real command bodies.
//!
//! [LIVE, Excel 16, 2026-11-06, lane names q1-q8.ps1 under
//! SCRATCH/names/] -- each test cites the measurement it holds Calcula to.

use crate::named_ranges::{
    create_named_range_impl, delete_named_range_scoped, registry_key, rename_named_range_scoped_impl,
    resolve_in_scope, NamedRange,
};
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use engine::CellValue;
use std::collections::{HashMap, HashSet};

struct Wb {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

impl Wb {
    /// `Sheet1` (active) and `Sheet2`.
    fn new() -> Self {
        let state = crate::create_app_state();
        *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
        let seed = crate::document_effect::test_seed_effect();
        state.grids.write(&seed).unwrap().push(engine::Grid::new());
        state.sheet_names.write(&seed).unwrap().push("Sheet2".to_string());
        state.all_column_widths.write(&seed).unwrap().push(HashMap::new());
        state.all_row_heights.write(&seed).unwrap().push(HashMap::new());
        state.all_user_hidden_rows.write(&seed).unwrap().push(HashSet::new());
        state.all_user_hidden_cols.write(&seed).unwrap().push(HashSet::new());
        state.sheet_ids.write(&seed).unwrap().push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            while all.len() < 2 {
                all.push(HashSet::new());
            }
        }
        Wb {
            state,
            file: FileState::default(),
            files: UserFilesState::default(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
        }
    }

    /// A cell on the ACTIVE sheet.
    fn set(&self, row: u32, col: u32, value: &str) {
        crate::commands::data::update_cell_impl(
            &self.state, &self.file, &self.files, &self.slicer, &self.pivots, &self.pane, &self.filters,
            row, col, value.to_string(), None, None, None,
        )
        .unwrap_or_else(|e| panic!("update_cell({},{}) failed: {}", row, col, e));
    }

    fn define(&self, name: &str, scope: Option<usize>, refers_to: &str) -> crate::named_ranges::NamedRangeResult {
        create_named_range_impl(&self.state, &self.file, name.to_string(), scope, refers_to.to_string(), None, None)
    }

    /// The value of a cell on `sheet` (the active sheet's authoritative grid
    /// when it is the active one).
    fn number(&self, sheet: usize, row: u32, col: u32) -> f64 {
        let active = *self.state.active_sheet.read().unwrap();
        let value = if sheet == active {
            self.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone())
        } else {
            self.state.grids.read().unwrap()[sheet].get_cell(row, col).map(|c| c.value.clone())
        };
        match value.unwrap_or(CellValue::Empty) {
            CellValue::Number(n) => n,
            other => panic!("sheet {} ({},{}) holds {:?}, not a number", sheet, row, col, other),
        }
    }

    fn names(&self) -> HashMap<String, NamedRange> {
        self.state.named_ranges.read().unwrap().clone()
    }

    fn delete(&self, name: &str, scope: Option<usize>) -> crate::named_ranges::NamedRangeResult {
        delete_named_range_scoped(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, name.to_string(), scope,
        )
    }
}

/// BUG-0744: a workbook name and a sheet's own name of ONE spelling stand
/// side by side, and a formula reads its sheet's own first. [LIVE q1.ps1]
/// `Names.Add("Dup","=1")` and `Sheet1.Names.Add("Dup","=2")` both stand; `=Dup`
/// is 2 on Sheet1 and 1 on Sheet2.
///
/// SABOTAGE (names-key): `registry_key` ignores the scope -- the second
/// definition is refused as a duplicate ("THE SECOND SCOPE").
#[test]
fn a_workbook_name_and_a_sheet_name_of_one_spelling_stand_side_by_side() {
    let wb = Wb::new();
    assert!(wb.define("Dup", None, "=1").success);
    let local = wb.define("Dup", Some(0), "=2");
    assert!(local.success, "THE SECOND SCOPE: Sheet1!Dup was refused: {:?}", local.error);
    assert!(!wb.define("dup", Some(0), "=3").success, "a second Sheet1!Dup is a duplicate");
    assert!(!wb.define("DUP", None, "=3").success, "a second workbook Dup is a duplicate");
    assert_eq!(wb.names().len(), 2);

    let names = wb.names();
    assert_eq!(resolve_in_scope(&names, "dup", Some(0)).map(|n| n.refers_to.as_str()), Some("=2"));
    assert_eq!(resolve_in_scope(&names, "dup", Some(1)).map(|n| n.refers_to.as_str()), Some("=1"));

    // Through a real cell on Sheet1: its own Dup.
    wb.set(0, 0, "=Dup*10");
    assert_eq!(wb.number(0, 0, 0), 20.0, "=Dup on Sheet1 reads Sheet1!Dup (Excel: 2)");

    // Deleting the SHEET's name leaves the workbook's, and the cell follows it.
    let deleted = wb.delete("Dup", Some(0));
    assert!(deleted.success, "{:?}", deleted.error);
    assert_eq!(deleted.named_range.and_then(|n| n.sheet_index), Some(0), "the sheet's Dup was the one deleted");
    assert_eq!(wb.names().len(), 1);
    assert!(wb.names().contains_key(&registry_key(None, "Dup")));
    assert_eq!(wb.number(0, 0, 0), 10.0, "with Sheet1!Dup gone, =Dup reads the workbook's");

    // Renaming within a scope keeps the scope and frees the old spelling there.
    assert!(wb.define("Rate", Some(1), "=5").success);
    let renamed = rename_named_range_scoped_impl(&wb.state, &wb.file, "Rate", "Dup", Some(1));
    assert!(renamed.success, "Sheet2!Rate -> Sheet2!Dup beside the workbook Dup: {:?}", renamed.error);
    let names = wb.names();
    assert_eq!(names.get(&registry_key(Some(1), "Dup")).map(|n| n.refers_to.as_str()), Some("=5"));
    assert_eq!(names.get(&registry_key(None, "Dup")).map(|n| n.refers_to.as_str()), Some("=1"));
}

/// BUG-0744: Copy Sheet carries the source's names onto the copy as Excel's
/// does [LIVE q1.ps1 + q3.ps1]: every name scoped to the source, re-pointed
/// where it named the source and kept where it named another sheet or none;
/// every WORKBOOK name whose definition reads the source, as the copy's own;
/// not a workbook name reading only other sheets, and not one the source
/// shadows with a name of its own. The copied formula then reads the COPY.
/// Deleting the copy takes its names away.
///
/// SABOTAGE (names-copy): `copy_defined_names_to_copied_sheet` returns at once
/// -- fails at "THE COPY'S NAMES".
#[test]
fn copying_a_sheet_gives_the_copy_its_own_names_as_excel_does() {
    let wb = Wb::new();
    for (name, scope, refers_to) in [
        ("LocOwn", Some(0), "=Sheet1!$A$1"),
        ("LocOther", Some(0), "=Sheet2!$B$2"),
        ("LocConst", Some(0), "=42"),
        ("GlobOwn", None, "=Sheet1!$C$3"),
        ("GlobOther", None, "=Sheet2!$D$4"),
        ("Shadow", None, "=Sheet1!$C$1"),
        ("Shadow", Some(0), "=99"),
        ("OnOther", Some(1), "=Sheet2!$A$1"),
    ] {
        let r = wb.define(name, scope, refers_to);
        assert!(r.success, "{}: {:?}", name, r.error);
    }
    wb.set(0, 0, "10"); // A1
    wb.set(2, 2, "30"); // C3
    wb.set(0, 5, "=LocOwn+GlobOwn"); // F1
    assert_eq!(wb.number(0, 0, 5), 40.0);

    let copied = crate::sheets::copy_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timeline, &wb.filters, 0, None)
        .expect("copy");
    assert_eq!(copied.active_index, 1);
    assert_eq!(wb.state.sheet_names.read().unwrap()[1], "Sheet1 (2)");

    let names = wb.names();
    let on_copy = |name: &str| names.get(&registry_key(Some(1), name)).map(|n| n.refers_to.clone());
    assert_eq!(on_copy("LocOwn").as_deref(), Some("='Sheet1 (2)'!$A$1"), "THE COPY'S NAMES: LocOwn");
    assert_eq!(on_copy("LocOther").as_deref(), Some("=Sheet2!$B$2"), "a name reading another sheet keeps it");
    assert_eq!(on_copy("LocConst").as_deref(), Some("=42"));
    assert_eq!(on_copy("GlobOwn").as_deref(), Some("='Sheet1 (2)'!$C$3"), "a workbook name reading the source");
    assert_eq!(on_copy("GlobOther"), None, "a workbook name reading only another sheet is not copied");
    assert_eq!(on_copy("Shadow").as_deref(), Some("=99"), "the source's own Shadow is the one the copy gets");
    assert_eq!(on_copy("OnOther"), None, "another sheet's name is not the source's");
    // The originals are where they were; Sheet2 is now index 2.
    assert_eq!(names.get(&registry_key(Some(0), "LocOwn")).map(|n| n.refers_to.as_str()), Some("=Sheet1!$A$1"));
    assert_eq!(names.get(&registry_key(None, "GlobOwn")).map(|n| n.refers_to.as_str()), Some("=Sheet1!$C$3"));
    assert_eq!(names.get(&registry_key(Some(2), "OnOther")).map(|n| n.refers_to.as_str()), Some("=Sheet2!$A$1"));
    assert!(names.iter().all(|(k, nr)| *k == nr.registry_key()), "every entry under its (scope, name) key");

    // The copy's formula reads the copy's cells through the copy's names.
    wb.set(0, 0, "1"); // the copy's A1
    wb.set(2, 2, "2"); // the copy's C3
    wb.set(0, 5, "=LocOwn+GlobOwn"); // the copy's F1, entered again
    assert_eq!(wb.number(1, 0, 5), 3.0, "the copy's F1 = its own LocOwn + its own GlobOwn");
    assert_eq!(wb.number(0, 0, 5), 40.0, "the source's F1 is untouched");

    // Deleting the copy takes its names with it.
    crate::sheets::delete_sheet_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer, &wb.timeline, 1, false, None,
    )
    .expect("delete the copy");
    let names = wb.names();
    assert!(names.values().all(|n| n.sheet_index != Some(2)), "nothing is scoped past the last sheet");
    assert_eq!(names.values().filter(|n| n.sheet_index.is_none()).count(), 3);
    assert_eq!(names.values().filter(|n| n.sheet_index == Some(0)).count(), 4);
    assert_eq!(names.get(&registry_key(Some(1), "OnOther")).map(|n| n.refers_to.as_str()), Some("=Sheet2!$A$1"));
    assert!(names.iter().all(|(k, nr)| *k == nr.registry_key()), "re-keyed after the delete");
}

/// BUG-0744 follow-up (wave 3, lane namescalp): after Copy Sheet there are
/// TWO sheet-scoped names of one spelling and no workbook one, and a caller
/// asking with no scope (a chart's data, a named-range object script, MCP,
/// the command line) used to get nothing. [LIVE, namescalp p1/p3/p4.ps1]
/// Excel's `Names("Sales")` answers the FIRST sheet's (here the lowest of
/// the two) whichever sheet is active, whichever was defined first and
/// whatever the tabs are called (see also
/// `names_item_is_the_first_sheets_own_then_the_workbooks`), and `Names("Sales").Delete` deletes that one; the
/// object model's `Range("Sales")` is the asking sheet's own.
///
/// SABOTAGE (namescalp-key): `addressed_key` keeps the old "the ONE name of
/// that spelling, else nothing" -- fails at "NAMES(SALES) AFTER THE COPY".
#[test]
fn after_copy_sheet_a_name_asked_with_no_scope_is_excels_names_item() {
    let wb = Wb::new();
    assert!(wb.define("Sales", Some(0), "=Sheet1!$A$1").success);
    crate::sheets::copy_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timeline, &wb.filters, 0, None)
        .expect("copy");
    // The copy (index 1, now active) has its own Sales; Sheet2 is index 2.
    assert!(wb.names().contains_key(&registry_key(Some(1), "Sales")));

    let found = crate::named_ranges::get_named_range_in(&wb.state, "Sales", None);
    assert_eq!(
        found.as_ref().map(|n| (n.sheet_index, n.refers_to.as_str())),
        Some((Some(0), "=Sheet1!$A$1")),
        "NAMES(SALES) AFTER THE COPY: the first sheet's"
    );
    let coords = crate::named_ranges::resolve_named_range_coords_at(&wb.state, "Sales", None, None)
        .expect("a script's names.Sales still resolves");
    assert_eq!((coords.sheet_index, coords.start_row, coords.start_col), (0, 0, 0));
    // Asked FROM a sheet (the Name Box, a chart's sheet), that sheet's own.
    let from_copy = crate::named_ranges::get_named_range_in(&wb.state, "Sales", Some(1)).expect("the copy's own");
    assert_eq!(from_copy.sheet_index, Some(1));
    // Asked from a sheet with none of its own: nothing, as Range("Sales") errors there.
    assert!(crate::named_ranges::get_named_range_in(&wb.state, "Sales", Some(2)).is_none());

    // No scope: the delete takes the first sheet's, as Excel's does.
    let r = wb.delete("Sales", None);
    assert!(r.success, "{:?}", r.error);
    let names = wb.names();
    assert!(!names.contains_key(&registry_key(Some(0), "Sales")), "the first tab's Sales is the one deleted");
    assert!(names.contains_key(&registry_key(Some(1), "Sales")), "the copy's stays");

    // A refused name says Excel's sentence [LIVE p1.ps1], never the old
    // "only letters, numbers, underscores, and periods" (`\` and `?` are name
    // characters now, BUG-0741).
    let refused = wb.define("1abc", None, "=1").error.unwrap_or_default();
    assert!(refused.contains("The syntax of the name '1abc' isn't correct."), "EXCEL'S TEXT: {refused}");
    assert!(refused.contains("-Doesn't include a space or character that isn't allowed"), "{refused}");
    assert!(!refused.contains("only letters"), "{refused}");
}

/// Wave-3 verifier (namescalp): Excel's `Workbook.Names("Sales")` reads the name
/// as the FIRST sheet would -- its own `Sales`, else the workbook's -- and a
/// name scoped only to a later sheet is not found. [LIVE, Excel 16,
/// 2026-11-06, lane obj4 n1.ps1 / n2.ps1; tabs Zed, Abc, Third] workbook +
/// Abc's: the workbook's; + Zed's: Zed's, ahead of the workbook's; only Abc's
/// (or Abc's and Third's): 0x800A03EC; Third moved to the front: Third's.
/// The command wire's null scope is ALSO the Name Manager's workbook scope, so
/// `addressed_key(None)` keeps the workbook's when both exist.
///
/// SABOTAGE (obj4-nik): `names_item_key` asks the workbook first -- fails at
/// "THE FIRST TAB'S AHEAD OF THE WORKBOOK'S".
#[test]
fn names_item_is_the_first_sheets_own_then_the_workbooks() {
    use crate::named_ranges::{addressed_key, names_item_key};
    let entry = |scope: Option<usize>, refers_to: &str| NamedRange {
        name: "Sales".to_string(),
        sheet_index: scope,
        refers_to: refers_to.to_string(),
        comment: None,
        folder: None,
    };
    let mut names: HashMap<String, NamedRange> = HashMap::new();
    let put = |names: &mut HashMap<String, NamedRange>, scope: Option<usize>, refers_to: &str| {
        let e = entry(scope, refers_to);
        names.insert(e.registry_key(), e);
    };
    // Only a later sheet's: Names("Sales") raises, so nothing.
    put(&mut names, Some(1), "=Abc!$B$2");
    assert_eq!(names_item_key(&names, "Sales"), None, "ONLY A LATER SHEET'S: not found");
    assert_eq!(addressed_key(&names, "Sales", None), None);
    put(&mut names, Some(2), "=Third!$C$3");
    assert_eq!(names_item_key(&names, "sales"), None, "two later sheets': still not found");
    // A workbook name: it answers, ahead of every later sheet's.
    put(&mut names, None, "=Third!$C$3");
    assert_eq!(names_item_key(&names, "Sales"), Some(registry_key(None, "Sales")), "workbook + later sheets: the workbook's");
    // The first tab's own: ahead of the workbook's.
    put(&mut names, Some(0), "=Zed!$A$1");
    assert_eq!(
        names_item_key(&names, "SALES"),
        Some(registry_key(Some(0), "Sales")),
        "THE FIRST TAB'S AHEAD OF THE WORKBOOK'S"
    );
    // The command wire: null is also the Name Manager's workbook scope.
    assert_eq!(addressed_key(&names, "Sales", None), Some(registry_key(None, "Sales")), "a null scope on the wire is the workbook's");
    assert_eq!(addressed_key(&names, "Sales", Some(1)), Some(registry_key(Some(1), "Sales")));
    names.remove(&registry_key(None, "Sales"));
    assert_eq!(addressed_key(&names, "Sales", None), Some(registry_key(Some(0), "Sales")), "no workbook name: the first sheet's own");
}

/// BUG-0744 follow-up (lane namescalp): renaming a WORKBOOK name repoints the
/// definitions that read it, but not one scoped to a sheet that holds its OWN
/// name of the old spelling -- there the old spelling reads that sheet's name
/// [LIVE q1.ps1], the rule the grid repoint already follows (`shadowed`).
///
/// SABOTAGE (namescalp-nested): drop the `shadowed` skip in
/// `plan_nested_renames` -- fails at "SHADOWED DEFINITION".
#[test]
fn a_workbook_rename_leaves_a_definition_its_sheet_shadows() {
    let wb = Wb::new();
    assert!(wb.define("Rate", None, "=1").success);
    assert!(wb.define("Rate", Some(0), "=2").success);
    assert!(wb.define("Twice", Some(0), "=Rate*2").success);
    assert!(wb.define("Half", Some(1), "=Rate/2").success);
    assert!(wb.define("Plus", None, "=Rate+1").success);
    let r = rename_named_range_scoped_impl(&wb.state, &wb.file, "Rate", "Tax", None);
    assert!(r.success, "{:?}", r.error);
    let names = wb.names();
    let text = |scope: Option<usize>, name: &str| names[&registry_key(scope, name)].refers_to.clone();
    assert_eq!(text(Some(0), "Twice"), "=Rate*2", "SHADOWED DEFINITION: Sheet1's Twice reads Sheet1!Rate");
    assert_eq!(text(Some(1), "Half"), "=Tax/2", "Sheet2 has no Rate of its own: it read the workbook's");
    assert_eq!(text(None, "Plus"), "=Tax+1");
    assert_eq!(text(Some(0), "Rate"), "=2", "the sheet's own Rate is untouched");
}

/// BUG-0749: the Name Box and Go To read a RELATIVE name at the active cell,
/// a script reads it as written. [LIVE q1.ps1] `relN` = `=Sheet2!B2` defined
/// at A1: `Application.Goto "relN"` from D5 selects E6, from A1 B2; the object
/// model's `Range("relN")` is B2 from D5.
///
/// SABOTAGE (names-at): `named_range_coords_at` skips the anchor -- fails at
/// "FROM D5".
#[test]
fn the_name_box_reads_a_relative_name_at_the_active_cell() {
    let wb = Wb::new();
    assert!(wb.define("relN", None, "=Sheet2!B2").success);
    let from_d5 = crate::named_ranges::resolve_named_range_coords_at(&wb.state, "relN", Some(0), Some((4, 3)))
        .expect("relN resolves");
    assert_eq!(
        (from_d5.sheet_index, from_d5.start_row, from_d5.start_col, from_d5.end_row, from_d5.end_col),
        (1, 5, 4, 5, 4),
        "FROM D5: Go To selects Sheet2!E6"
    );
    let as_written = crate::named_ranges::resolve_named_range_coords_at(&wb.state, "relN", None, None).unwrap();
    assert_eq!((as_written.start_row, as_written.start_col), (1, 1), "a script reads B2, as Range(\"relN\") does");
    // An absolute name does not move.
    assert!(wb.define("absN", None, "=Sheet2!$B$2:$C$3").success);
    let abs = crate::named_ranges::resolve_named_range_coords_at(&wb.state, "absN", Some(0), Some((9, 9))).unwrap();
    assert_eq!((abs.start_row, abs.start_col, abs.end_row, abs.end_col), (1, 1, 2, 2));

    // The SCOPE the Name Box asks from: the active sheet's own name first, a
    // qualified `Sheet2!Loc` that sheet's.
    assert!(wb.define("Loc", None, "=Sheet1!$D$4").success);
    assert!(wb.define("Loc", Some(1), "=Sheet2!$C$3").success);
    let on = |text: &str, sheet: Option<usize>| {
        crate::named_ranges::get_named_range_in(&wb.state, text, sheet).map(|n| n.refers_to)
    };
    assert_eq!(on("Loc", Some(0)).as_deref(), Some("=Sheet1!$D$4"));
    assert_eq!(on("Loc", Some(1)).as_deref(), Some("=Sheet2!$C$3"));
    assert_eq!(on("Sheet2!Loc", Some(0)).as_deref(), Some("=Sheet2!$C$3"));
    assert_eq!(on("'Sheet2'!loc", Some(0)).as_deref(), Some("=Sheet2!$C$3"));
    assert_eq!(on("Sheet1!Loc", Some(1)).as_deref(), Some("=Sheet1!$D$4"), "Sheet1 has none: the workbook's");
    assert_eq!(on("Nowhere!Loc", Some(0)), None);
}

/// BUG-0741: Excel's name characters, on the name door and through a formula.
/// [LIVE q1-q3.ps1, `Names.Add` per name] and [LIVE q4.ps1,
/// `ListObject.Name`] -- see `identity::is_valid_defined_name`.
///
/// SABOTAGE (names-chars): the lexer's `?` continuation is removed -- fails at
/// "=abc? READS THE NAME".
#[test]
fn names_take_excels_backslash_and_question_mark_rules() {
    for name in [
        "\\abc", "a\\b", "abc?", "_x", "A1B", "\\", "a?b", "_", "a.b", "XFE1", "A1A", "\\ab", "\\a1", "\\_a",
        "a\\", "a?", "_?", "_\\", "\\abc?", "\\RC", "\\A1", "\\TRUE", "\\a.b", "\\r1", "\\1a", "\\.a", "\\?a",
        "\\11", "\\.1", "a?.b", "_?a", "a\\\\b", "\\\\a", "\\a\\", "\\a?", "\\XFD1", "\\R1C1", "R?", "C\\",
        "A1?", "A1\\", "a1?", "A1.B1?", "a.?", "TRUE?",
    ] {
        assert!(identity::is_valid_defined_name(name), "Excel accepts the name {:?}", name);
    }
    for name in [
        "?abc", "R", "C", "r", "c", "R1", "\\\\", "\\a", "?", ".a", "1a", "RC", "R1C1", "Abc1", "XFD1", "\\b",
        "\\x", "\\z", "\\_", "\\.", "\\1", "\\?", "\\R", "\\C", "\\c", "\\r", "\\A", "\\B", "\\Z", "?a", "R1?",
        "C1\\", "R1\\x", "RC1?", "\\a b",
    ] {
        assert!(!identity::is_valid_defined_name(name), "Excel refuses the name {:?}", name);
    }
    for name in ["\\abc", "a\\b", "abc?", "\\", "\\a", "_x", "a?b", "\\ab"] {
        assert!(identity::is_valid_table_name(name), "Excel accepts the TABLE name {:?}", name);
    }
    assert!(!identity::is_valid_table_name("R1C1"));

    let wb = Wb::new();
    assert!(wb.define("abc?", None, "=13").success);
    assert!(wb.define("\\abc", None, "=11").success);
    assert!(wb.define("a\\b", None, "=12").success);
    assert!(!wb.define("\\a", None, "=1").success, "the door refuses what Excel refuses");
    wb.set(0, 0, "=abc?+1");
    assert_eq!(wb.number(0, 0, 0), 14.0, "=abc? READS THE NAME (Excel: 13)");
    wb.set(1, 0, "=\\abc+a\\b");
    assert_eq!(wb.number(0, 1, 0), 23.0, "Excel: =\\abc+abc? reads both names");
    wb.set(2, 0, "=SUM(\\abc,abc?)");
    assert_eq!(wb.number(0, 2, 0), 24.0);
}

/// BUG-0749: a RELATIVE reference in a name is an offset from the cell that
/// uses it, so a structural edit neither moves it nor kills it; an absolute
/// part follows the edit, and dies with its line. [LIVE q9.ps1, names defined
/// at A1, the same four edits in the same order: insert row 1, insert column
/// A, delete row 4, delete column D.]
///
/// SABOTAGE (names-struct): `keep_relative_name_parts` returns `after` -- fails
/// at "RELATIVE STAYS".
#[test]
fn a_relative_name_does_not_follow_a_structural_edit() {
    let wb = Wb::new();
    for (name, refers_to) in [
        ("nRel", "=Sheet1!C3"),
        ("nAbs", "=Sheet1!$C$3"),
        ("nMixR", "=Sheet1!$C3"),
        // Column E, not the probe's C: Calcula's parser refuses a qualified
        // `Sheet1!C$3` / `Sheet1!R$3` (it reads `C` / `R` as an R1C1 spelling
        // first) -- a parser defect of its own, reported beside this lane.
        ("nMixC", "=Sheet1!E$3"),
        ("nRng", "=Sheet1!C3:D4"),
        // A mixed definition: its relative part is restored and the re-render
        // must not upper-case the other name it reads (lane namescalp).
        ("myRate", "=1"),
        ("nWithName", "=SUM(Sheet1!C3,myRate)+Sheet1!$A$1"),
    ] {
        assert!(wb.define(name, None, refers_to).success, "{}", name);
    }
    let text = |name: &str| wb.names()[&registry_key(None, name)].refers_to.clone();
    let rows = |insert: bool, at: u32| {
        let r = if insert {
            crate::commands::structure::insert_rows_impl(
                &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer, &wb.timeline, at, 1, None,
            )
        } else {
            crate::commands::structure::delete_rows_impl(
                &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer, &wb.timeline, at, 1, None,
            )
        };
        r.expect("row edit");
    };
    let cols = |insert: bool, at: u32| {
        let r = if insert {
            crate::commands::structure::insert_columns_impl(
                &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer, &wb.timeline, at, 1, None,
            )
        } else {
            crate::commands::structure::delete_columns_impl(
                &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer, &wb.timeline, at, 1, None,
            )
        };
        r.expect("column edit");
    };

    rows(true, 0); // insert row 1
    assert_eq!(text("nRel"), "=Sheet1!C3", "RELATIVE STAYS on a row insert (Excel: C3)");
    assert_eq!(text("nAbs"), "=Sheet1!$C$4");
    assert_eq!(text("nMixR"), "=Sheet1!$C3");
    assert_eq!(text("nMixC"), "=Sheet1!E$4");
    assert_eq!(text("nRng"), "=Sheet1!C3:D4");
    assert_eq!(
        text("nWithName"),
        "=SUM(Sheet1!C3,myRate)+Sheet1!$A$2",
        "THE NAME'S SPELLING survives the restore"
    );

    cols(true, 0); // insert column A
    assert_eq!(text("nRel"), "=Sheet1!C3");
    assert_eq!(text("nAbs"), "=Sheet1!$D$4");
    assert_eq!(text("nMixR"), "=Sheet1!$D3");
    assert_eq!(text("nMixC"), "=Sheet1!E$4");
    assert_eq!(text("nRng"), "=Sheet1!C3:D4");

    rows(false, 3); // delete row 4
    assert_eq!(text("nRel"), "=Sheet1!C3", "a relative reference is never the edit's to kill");
    assert!(text("nAbs").contains("#REF!"), "nAbs: {}", text("nAbs"));
    assert_eq!(text("nMixR"), "=Sheet1!$D3");
    assert!(text("nMixC").contains("#REF!"), "nMixC: {}", text("nMixC"));
    assert_eq!(text("nRng"), "=Sheet1!C3:D4");

    cols(false, 3); // delete column D
    assert_eq!(text("nRel"), "=Sheet1!C3");
    assert!(text("nMixR").contains("#REF!"), "nMixR: {}", text("nMixR"));
    assert_eq!(text("nRng"), "=Sheet1!C3:D4");
}

