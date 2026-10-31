//! FILENAME: app/src-tauri/src/xlsx_calc_mode_tests.rs
//! PURPOSE: Excel's calculation-mode rule through .xlsx, host side: a save
//!          records the session's mode (`save_xlsx_for_session`), and an open
//!          adopts the file's (`adopt_xlsx_calculation_mode`).
//!
//! [LIVE] Excel 16 (round 11): an application in manual calculation saves
//! `<calcPr calcId="191029" calcMode="manual"/>`, automatic saves no
//! `calcMode`; with nothing open, opening a manual file makes the application
//! manual and an automatic file makes it automatic; a second workbook opened
//! while one is open leaves the mode alone. A Calcula window holds one
//! document, so every open is Excel's "nothing else open" case.

use super::{adopt_xlsx_calculation_mode, save_xlsx_for_session};

fn set_mode(state: &crate::AppState, mode: &str) {
    *state.calculation_mode.lock().unwrap() = mode.to_string();
}

fn mode_of(state: &crate::AppState) -> String {
    state.calculation_mode.lock().unwrap().clone()
}

/// A real .xlsx written by the host's own save door under `mode`.
fn export_under(dir: &std::path::Path, name: &str, mode: &str) -> std::path::PathBuf {
    let state = crate::create_app_state();
    set_mode(&state, mode);
    let path = dir.join(name);
    save_xlsx_for_session(&state, &persistence::Workbook::new(), &path).expect("the export is written");
    path
}

#[test]
fn an_xlsx_save_records_the_sessions_calculation_mode() {
    let dir = tempfile::tempdir().unwrap();
    let manual = export_under(dir.path(), "manual.xlsx", "manual");
    assert!(
        persistence::read_xlsx_manual_calculation(&manual).unwrap(),
        "an .xlsx saved under manual calculation did not record calcMode=\"manual\""
    );
    let automatic = export_under(dir.path(), "automatic.xlsx", "automatic");
    assert!(
        !persistence::read_xlsx_manual_calculation(&automatic).unwrap(),
        "an .xlsx saved under automatic calculation claimed manual"
    );
}

#[test]
fn an_xlsx_open_adopts_the_files_calculation_mode() {
    let dir = tempfile::tempdir().unwrap();
    let manual = export_under(dir.path(), "manual.xlsx", "manual");
    let automatic = export_under(dir.path(), "automatic.xlsx", "automatic");

    let state = crate::create_app_state();
    set_mode(&state, "automatic");
    assert_eq!(adopt_xlsx_calculation_mode(&state, &manual), Some("manual"));
    assert_eq!(mode_of(&state), "manual", "opening a manual .xlsx left calculation automatic");

    assert_eq!(adopt_xlsx_calculation_mode(&state, &automatic), Some("automatic"));
    assert_eq!(mode_of(&state), "automatic", "opening an automatic .xlsx left calculation manual");
    // Adopting automatic over a manual session does not mark the freshly
    // read sheets stale (that mark is about the session's own manual edits).
    {
        let grid = state.grid.read().unwrap();
        let grids = state.grids.read().unwrap();
        assert!(
            !crate::calculation::values_may_be_stale_in(&grid, &grids),
            "adopting a file's automatic mode marked the opened values stale"
        );
    }

    // A file whose mode cannot be read leaves the session's mode alone.
    set_mode(&state, "manual");
    let broken = dir.path().join("broken.xlsx");
    std::fs::write(&broken, b"not a zip").unwrap();
    assert_eq!(adopt_xlsx_calculation_mode(&state, &broken), None);
    assert_eq!(mode_of(&state), "manual");
}

/// Comment-stripped text of the function that starts at `needle`, up to its
/// column-0 closing brace.
fn code_body_of(src: &str, needle: &str) -> String {
    let src = src.replace("\r\n", "\n");
    let start = src.find(needle).unwrap_or_else(|| panic!("`{needle}` not found"));
    let rest = &src[start..];
    let end = rest.find("\n}\n").map(|e| e + 2).unwrap_or_else(|| panic!("`{needle}`: no closing brace"));
    rest[..end]
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `save_file` and `open_file` take `State<...>` and cannot be driven
/// in-process, so their ONE call each into the two doors is pinned in code (a
/// commented-out call does not count).
#[test]
fn save_file_and_open_file_are_wired_to_the_calculation_mode() {
    const SRC: &str = include_str!("persistence.rs");
    assert!(
        code_body_of(SRC, "pub fn save_file(").contains("save_xlsx_for_session("),
        "save_file no longer writes .xlsx through save_xlsx_for_session: the export drops the calculation mode"
    );
    assert!(
        code_body_of(SRC, "pub fn open_file(").contains("adopt_xlsx_calculation_mode("),
        "open_file no longer adopts an .xlsx's calculation mode"
    );
    assert!(
        code_body_of(SRC, "pub fn open_file(").contains("adopt_cala_calculation_mode("),
        "open_file no longer adopts a .cala's calculation mode"
    );
    assert!(
        code_body_of(SRC, "pub fn save_file(").contains("record_session_calculation_mode("),
        "save_file no longer records the calculation mode in the .cala it writes"
    );
    assert!(
        code_body_of(SRC, "pub fn auto_recover_save(").contains("record_session_calculation_mode("),
        "auto_recover_save no longer records the calculation mode in its snapshot"
    );
}

/// .CALA RECORDS AND ADOPTS THE MODE TOO (round 12; the owner question
/// answered by "Excel wins"): Excel's own files carry the mode and the open
/// sets it, and so does a .cala now -- `save_file` (and AutoRecover) record the
/// session's mode into `Workbook::calculation_manual` (`calc_mode.json`,
/// `record_session_calculation_mode`), and `open_file` adopts it
/// (`adopt_cala_calculation_mode`). It used to carry none, so a manual
/// workbook reopened in whatever mode the session had. Through the real save
/// assembly and the real .cala bytes.
///
/// SABOTAGE: make `record_session_calculation_mode` write `false`.
#[test]
fn a_cala_save_records_the_sessions_calculation_mode_and_the_open_adopts_it() {
    let files = crate::persistence::UserFilesState::default();
    let bi = crate::bi::types::BiState::new();
    let saved_under = |mode: &str| -> persistence::Workbook {
        let state = crate::create_app_state();
        set_mode(&state, mode);
        let (mut workbook, _) =
            super::build_workbook_for_save(&state, &files, &bi, super::ChartKeysFor::Document).expect("assembled");
        super::record_session_calculation_mode(&state, &mut workbook);
        let bytes = calcula_format::write_calcula_bytes(&workbook).expect("written");
        calcula_format::read_calcula_bytes(&bytes).expect("read back")
    };

    let manual = saved_under("manual");
    assert!(manual.calculation_manual, "a .cala saved under manual calculation did not record it");
    let opener = crate::create_app_state();
    set_mode(&opener, "automatic");
    assert_eq!(super::adopt_cala_calculation_mode(&opener, &manual), "manual");
    assert_eq!(mode_of(&opener), "manual", "opening a manual .cala left calculation automatic");
    {
        let grid = opener.grid.read().unwrap();
        let grids = opener.grids.read().unwrap();
        assert!(
            !crate::calculation::values_may_be_stale_in(&grid, &grids),
            "adopting a file's mode marked the opened values stale"
        );
    }

    let automatic = saved_under("automatic");
    assert!(!automatic.calculation_manual);
    assert_eq!(super::adopt_cala_calculation_mode(&opener, &automatic), "automatic");
    assert_eq!(mode_of(&opener), "automatic", "opening an automatic .cala left calculation manual");
}

/// rev15A (round 16): a hyperlink or a defined name the .xlsx format refuses
/// was left out of the export with only a stderr `[WARN]`. The host's save
/// door now returns the sentence that tells the user, and `save_file` shows it
/// (`document:load-warnings`) only once the file is written and marked saved
/// -- after its last fallible step, so a save that then fails announces no
/// loss for a file it never finished.
#[test]
fn what_an_xlsx_export_leaves_out_reaches_the_user_after_the_save() {
    let dir = tempfile::tempdir().unwrap();
    let state = crate::create_app_state();
    let mut workbook = persistence::Workbook::new();
    workbook.named_ranges.push(persistence::SavedNamedRange {
        name: "Bad Name".to_string(),
        refers_to: "=Sheet1!$A$1".to_string(),
        sheet_id: None,
        comment: None,
        folder: None,
    });
    let told = save_xlsx_for_session(&state, &workbook, &dir.path().join("loss.xlsx")).expect("the export is written");
    let told = told.expect("SILENT EXPORT LOSS: the save door said nothing about the name it left out");
    assert!(told.contains("Bad Name") && told.contains("left out"), "{told}");
    let clean = save_xlsx_for_session(&state, &persistence::Workbook::new(), &dir.path().join("clean.xlsx")).unwrap();
    assert_eq!(clean, None, "a lossless export announced a loss");

    const SRC: &str = include_str!("persistence.rs");
    let body = code_body_of(SRC, "pub fn save_file(");
    let saved = body.find("mark_saved(").expect("save_file marks the document saved");
    let told_at = body.find("\"xlsxExport\"").expect("SILENT EXPORT LOSS: save_file never shows what the export left out");
    assert!(told_at > saved, "the export loss is shown before the save is done");
    assert!(body[saved..].find("?").is_none(), "a step after mark_saved can still fail the save");
}
