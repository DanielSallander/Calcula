//! FILENAME: app/src-tauri/src/mcp/apply_formatting_tests.rs
//! PURPOSE: The MCP / AI-chat `apply_formatting` tool goes through the SHARED
//!          formatting core (`commands::styles::apply_formatting_core`), never a
//!          walk of its own -- the class of BUG-0354.
//!
//! The tool used to be a hand-written copy of the formatting walk: it walked
//! rows x columns (Select All from an AI froze the app), based each cell on the
//! cell's OWN style index (a column's default format was dropped from every
//! cell it touched) and asked NO protection question (an AI could format a
//! protected sheet the user cannot). These drive the real body,
//! `apply_cell_formatting_core`, with no Tauri runtime: the handle half adds
//! only the AI access ceiling and the out-of-band repaint.
//!
//! A child module of `mcp::tools` (declared with `#[path]` there).

use super::*;
use crate::persistence::FileState;
use engine::{CellStyle, Color, Fill, ThemeColor};

/// The smallest workbook the tool needs: one grid sheet, active.
struct Book {
    state: AppState,
    file: FileState,
}

impl Book {
    fn new() -> Self {
        Book { state: crate::create_app_state(), file: FileState::default() }
    }

    /// The tool, called as the MCP server and the AI chat call it.
    fn tool(&self, rect: (u32, u32, u32, u32), edit: impl FnOnce(&mut ApplyFormattingParams)) -> Result<String, String> {
        let mut params = ApplyFormattingParams {
            start_row: rect.0,
            start_col: rect.1,
            end_row: rect.2,
            end_col: rect.3,
            bold: None,
            italic: None,
            text_color: None,
            background_color: None,
            number_format: None,
            text_align: None,
        };
        edit(&mut params);
        apply_cell_formatting_core(&self.state, &self.file, &params)
    }

    /// The style a position on the active sheet resolves to (row/column tiers
    /// included).
    fn style_at(&self, row: u32, col: u32) -> CellStyle {
        let grid = self.state.grid.read().unwrap();
        let index = grid.effective_style_index(row, col);
        self.state.style_registry.read().unwrap().get(index).clone()
    }

    fn stored_cells(&self) -> usize {
        self.state.grid.read().unwrap().cells.len()
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    /// Protect the active sheet with Excel's default options (Format Cells NOT
    /// allowed), as Review > Protect Sheet > OK does.
    fn protect(&self) {
        let seed = crate::document_effect::test_seed_effect();
        self.state.sheet_protection.write(&seed).unwrap().entry(0).or_default().protected = true;
    }

    /// A whole-COLUMN default style (a column TIER) on the active sheet, both
    /// mirrors -- what Home > Italic on a selected column header leaves.
    fn seed_column_tier(&self, col: u32, style: CellStyle) {
        let seed = crate::document_effect::test_seed_effect();
        let index = self.state.style_registry.write(&seed).unwrap().get_or_create_explicit(style);
        self.state.grid.write(&seed).unwrap().set_column_style(col, index);
        self.state.grids.write(&seed).unwrap()[0].set_column_style(col, index);
    }

    /// The `apply_formatting` audit rows the tool recorded.
    fn audit_rows(&self) -> Vec<calp::audit::AuditEntry> {
        self.state
            .audit_log
            .read()
            .unwrap()
            .entries
            .iter()
            .filter(|e| e.extra.get("tool") == Some(&serde_json::json!("apply_formatting")))
            .cloned()
            .collect()
    }
}

/// A PROTECTED SHEET REFUSES THE AI, as it refuses the user's Bold button
/// [Excel: Review > Protect Sheet with the default options greys Bold out for
/// every cell]. The tool asked no protection question at all, so an AI agent
/// could format a sheet the user had locked.
#[test]
fn a_protected_sheet_is_refused_through_the_tool() {
    let b = Book::new();
    b.protect();

    let refusal = b.tool((1, 1, 2, 2), |p| p.bold = Some(true));

    assert!(
        refusal.is_err(),
        "an AI formatted a protected sheet the user cannot: {:?}",
        refusal
    );
    assert!(!b.style_at(1, 1).font.bold, "the refused format must not have been written");
    assert_eq!(b.stored_cells(), 0, "a refusal writes no cell");
    assert_eq!(b.undo_depth(), 0, "a refusal records no undo step");
    assert!(!b.file.is_dirty(), "a refusal must not dirty the document");
    assert!(b.audit_rows().is_empty(), "no audit row claims a format that was refused");

    // Positive control: the same request on the sheet unprotected is applied,
    // so the refusal above came from the protection and nothing else.
    b.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().remove(&0);
    b.tool((1, 1, 2, 2), |p| p.bold = Some(true)).expect("unprotected, the AI may format");
    assert!(b.style_at(2, 2).font.bold);
}

/// A WHOLE COLUMN IS ONE COLUMN TIER, never a million cells (BUG-0354's class).
/// The tool walked rows x columns: B1:B1048576 stored 1,048,576 cells and as
/// many undo entries, and an AI asking for Select All ran 17.2 billion
/// iterations. Excel stores a whole-column format as the column's own format;
/// a cell typed there later inherits it.
#[test]
fn a_whole_column_through_the_tool_writes_a_tier_not_a_million_cells() {
    let b = Book::new();

    let reply = b
        .tool((0, 1, engine::EXCEL_MAX_ROW_INDEX, 1), |p| p.bold = Some(true))
        .expect("Bold on column B");

    {
        let grid = b.state.grid.read().unwrap();
        assert_eq!(grid.cells.len(), 0, "a whole-column format materialised cells");
        assert!(grid.column_styles.contains_key(&1), "column B carries no column tier");
        assert_eq!(grid.column_styles.len(), 1, "only column B is formatted");
    }
    assert!(b.style_at(0, 1).font.bold);
    assert!(b.style_at(engine::EXCEL_MAX_ROW_INDEX, 1).font.bold, "the last row of B inherits the tier");
    assert!(!b.style_at(5, 2).font.bold, "column C was not in the range");
    assert_eq!(b.undo_depth(), 1, "one undo step for the whole column");
    assert!(b.file.is_dirty(), "a format that changed something dirties the document");

    // The tool's contract: the same reply and the same audit row.
    assert_eq!(reply, "Applied formatting to 1048576 cell(s) (B1:B1048576)");
    let rows = b.audit_rows();
    assert_eq!(rows.len(), 1, "one audit row per tool call");
    assert_eq!(rows[0].extra.get("cellsModified"), Some(&serde_json::json!(1_048_576u64)));
    assert_eq!(rows[0].extra.get("lastRow"), Some(&serde_json::json!(engine::EXCEL_MAX_ROW_INDEX)));
    assert_eq!(rows[0].extra.get("firstCol"), Some(&serde_json::json!(1)));
}

/// A CELL UNDER A COLUMN TIER KEEPS THE TIER'S OTHER ATTRIBUTES. Column C's
/// default is italic on a yellow fill; the AI bolds C5. Excel shows C5 bold
/// italic on yellow [Excel: a column's format is the base every cell in it
/// starts from]. The tool based the cell on its OWN style index (0, nothing
/// stored there), so C5 came out bold on white -- the column's italic and fill
/// silently stripped from every cell an AI touched.
#[test]
fn a_cell_with_a_column_tier_keeps_the_tiers_other_attributes() {
    let b = Book::new();
    let mut column = CellStyle::new();
    column.font.italic = true;
    column.fill = Fill::Solid { color: ThemeColor::Absolute(Color::new(255, 255, 0)) };
    b.seed_column_tier(2, column.clone());

    b.tool((4, 2, 4, 2), |p| p.bold = Some(true)).expect("Bold on C5");

    let c5 = b.style_at(4, 2);
    assert!(c5.font.bold, "the requested bold was not applied");
    assert!(c5.font.italic, "C5 lost the column's italic: the tool based it on the cell's own style");
    assert_eq!(c5.fill, column.fill, "C5 lost the column's fill");
    // The rest of the column is untouched.
    let c6 = b.style_at(5, 2);
    assert!(!c6.font.bold);
    assert!(c6.font.italic);
}

/// ONE READ DECIDES THE SHEET (review revFU#9). The tool read the active sheet
/// for its canvas refusal and its audit row, and the shared core read it AGAIN
/// under its own guards: a tab switch in between (the MCP thread runs beside
/// the user) formatted one sheet -- possibly a canvas -- and audited another.
/// Now a rectangle is refused on a canvas by the core's own gate (nothing
/// written, nothing audited, the document clean), and the audit row names the
/// sheet the core answers it formatted. A race cannot be reproduced
/// deterministically, so the single read is pinned on the source, as
/// `style_and_cell_shift_commands_gate_plan_and_write_in_one_critical_section`
/// pins the style commands'.
// SABOTAGE: read the active sheet again for the audit row
// (`let formatted_sheet = *state.active_sheet.read()...` before
// `record_mcp_tool_action`) -> two reads.
#[test]
fn the_tool_formats_and_audits_the_sheet_one_read_decided() {
    let b = Book::new();
    b.state.sheet_kinds.write(&crate::document_effect::test_seed_effect()).unwrap()[0] =
        ::persistence::SheetKind::new_canvas();

    let refusal = b.tool((1, 1, 2, 2), |p| p.bold = Some(true)).expect_err("a canvas has no cells to format");
    assert!(refusal.contains("canvas"), "the refusal names the canvas: {refusal}");
    assert_eq!(b.stored_cells(), 0, "a refusal writes no cell");
    assert_eq!(b.undo_depth(), 0);
    assert!(!b.file.is_dirty(), "a refusal must not dirty the document");
    assert!(b.audit_rows().is_empty(), "no audit row claims a format that was refused");
    assert!(
        b.tool((2, 2, 1, 1), |p| p.bold = Some(true)).is_err(),
        "an empty rectangle on a canvas is refused too (by the tool itself)"
    );

    // Positive control: the same sheet as a worksheet is formatted and audited
    // under its own index.
    b.state.sheet_kinds.write(&crate::document_effect::test_seed_effect()).unwrap()[0] =
        ::persistence::SheetKind::Worksheet;
    b.tool((1, 1, 2, 2), |p| p.bold = Some(true)).expect("a worksheet is formatted");
    assert!(b.style_at(2, 2).font.bold);
    let rows = b.audit_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].extra.get("sheet"), Some(&serde_json::json!(0)));

    const TOOLS: &str = include_str!("tools.rs");
    let tools = TOOLS.replace("\r\n", "\n");
    let start = tools.find("pub(crate) fn apply_cell_formatting_core(").expect("the tool's body");
    let rest = &tools[start..];
    let body = &rest[..rest.find("\n}\n").expect("end of fn")];
    assert_eq!(
        body.matches("active_sheet.read()").count(),
        1,
        "the tool reads the active sheet ONCE, and only where it formats nothing"
    );
    let empty = body.find("if count == 0").expect("the empty-rectangle branch");
    let read = body.find("active_sheet.read()").unwrap();
    let core = body.find("apply_formatting_core_on_active(").expect("the core that answers the sheet it formatted");
    assert!(empty < read && read < core, "the one read belongs to the empty rectangle, before the core's branch");
    assert!(
        body.contains("serde_json::json!(formatted_sheet)"),
        "the audit row names the sheet the core formatted"
    );
}
