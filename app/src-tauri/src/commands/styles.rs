//! FILENAME: app/src-tauri/src/commands/styles.rs
// PURPOSE: Styling operations, formatting, and style definitions.

use crate::api_types::{
    CellData, CellTargetRef, FillParam, FormattingParams, FormattingResult, IndexListArg, MergedRegion, PreviewResult,
    StyleCheckArea, StyleData, StyleEntry,
};
use crate::cell_target::ResolvedCellTarget;
use serde::{Deserialize, Serialize};
use crate::persistence::FileState;
use crate::{format_cell_value_with_color, AppState};
use engine::{
    BorderLineStyle, BorderStyle, Cell, CellStyle, CellValue, Color, CurrencyPosition, Fill,
    FontSize, GradientDirection, NegativeStyle, NumberFormat, PatternType, TextAlign, TextRotation,
    ThemeColor, VerticalAlign,
};
use tauri::State;

/// Get a style by index.
#[tauri::command]
pub fn get_style(state: State<AppState>, index: usize) -> StyleData {
    let styles = state.style_registry.read().unwrap();
    let theme = state.theme.read().unwrap();
    StyleData::from_cell_style(styles.get(index), &theme)
}

/// Get all styles.
#[tauri::command]
pub fn get_all_styles(state: State<AppState>) -> Vec<StyleData> {
    let styles = state.style_registry.read().unwrap();
    let theme = state.theme.read().unwrap();
    styles.all_styles().iter().map(|s| StyleData::from_cell_style(s, &theme)).collect()
}

/// Set a cell's style index.
///
/// `target` (BUG-0513, owner finding G3): the cell is a floating grid's cell --
/// written on its backing sheet ONLY, inside the write extent, gated by the
/// HOST's protection (its Format Cells option; on a protected host the cell
/// keeps its Locked flag), and recorded against the backing sheet in the
/// caller's open undo step. Format Painter, Paste Formatting and Paste (No Borders) reach a
/// floating grid's cells through it exactly as they reach a sheet's.
///
/// `check_area` (ALL OR NOTHING): the call is a CHECK of the whole rectangle a
/// gesture is about to style cell by cell -- the same gates, asked once over
/// the rectangle, and nothing written (`row`, `col` and `style_index` are not
/// used; answers `None`). A Format Painter stroke over A1:A3 whose A3 was
/// refused used to paint A1 and A2 first, and the stroke's cancel then dropped
/// its undo record: two cells changed with no Ctrl+Z. Excel refuses a
/// protected format whole, before anything changes [LIVE, Excel 16, Format
/// Cells not allowed: Paste Special > Formats onto A1:A3 raises the
/// protected-sheet error and nothing changes]. The gate is the Format Cells
/// option alone (`gate_cell_style_rect`), so today the check refuses exactly
/// when Format Cells is not allowed.
///
/// `cells` (the style-only BATCH): every listed cell styled as one call would
/// style it, in ONE call -- gated once, all or nothing, one undo step (or the
/// caller's open one); `row`, `col` and `style_index` are not used and the
/// answer is `None` (`set_cell_styles_core`). A tiled Paste Formatting of one
/// cell over a column used to be one call per cell.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_cell_style(
    state: State<AppState>,
    file_state: State<FileState>,
    row: u32,
    col: u32,
    style_index: usize,
    target: Option<CellTargetRef>,
    check_area: Option<StyleCheckArea>,
    cells: Option<Vec<crate::api_types::CellStyleWrite>>,
) -> Result<Option<CellData>, String> {
    if let Some(area) = check_area {
        check_cell_style_area_core(&state, area, target.as_ref())?;
        return Ok(None);
    }
    if let Some(cells) = cells {
        set_cell_styles_core(&state, &file_state, &cells, target.as_ref())?;
        return Ok(None);
    }
    set_cell_style_core(&state, &file_state, row, col, style_index, target.as_ref())
}

/// `set_cell_style`'s CHECK (`check_area`): every gate a style write asks of
/// one cell, asked of the whole rectangle, holding nothing and writing
/// nothing -- no effect, no undo record. A target resolves first and the
/// rectangle must lie inside its write extent.
pub(crate) fn check_cell_style_area_core(
    state: &AppState,
    area: StyleCheckArea,
    target: Option<&CellTargetRef>,
) -> Result<(), String> {
    let rect = (
        area.start_row.min(area.end_row),
        area.start_col.min(area.end_col),
        area.start_row.max(area.end_row),
        area.start_col.max(area.end_col),
    );
    let resolved = match target {
        Some(target) => {
            let t = crate::cell_target::resolve_cell_target(state, target)?;
            crate::cell_target::ensure_in_extent(&t, rect.0, rect.1, rect.2, rect.3)?;
            Some(t)
        }
        None => None,
    };
    gate_cell_style_rect(state, resolved.as_ref(), rect)
}

/// The protection gate of a style write over `rect` (inclusive
/// `(r0, c0, r1, c1)`), holding nothing: the Format Cells option -- the
/// HOST's for a cell target (`gate_host_action`), the active sheet's
/// otherwise -- and the canvas rule. Shared by the one-cell write and the
/// whole-rectangle check, so the check can never pass a cell the write would
/// refuse.
///
/// FORMATTING ASKS ONLY THE OPTION, NEVER THE LOCK FLAGS (Excel parity). On a
/// protected sheet that allows Format Cells, Excel formats LOCKED cells --
/// Bold, a number format, a border, a fill, a cell style and Paste Special >
/// Formats all land on a locked cell -- and keeps every destination's Locked
/// flag [LIVE, Excel 16 COM, 2026-10-30, probe1-3.ps1]. The lock flags guard
/// CONTENT; what they guarded here (a paint from an unlocked cell UNLOCKING a
/// locked one) is closed instead by the writer keeping the cell's Locked flag
/// while the sheet is protected (`keep_cell_lock`). Without Format Cells
/// every cell is refused, the unlocked ones too, as Excel refuses them.
fn gate_cell_style_rect(
    state: &AppState,
    resolved: Option<&ResolvedCellTarget>,
    _rect: (u32, u32, u32, u32),
) -> Result<(), String> {
    match resolved {
        Some(t) => crate::cell_target::gate_host_action(state, t.host_index, t.backing_index, "formatCells", "format cells"),
        None => {
            let active_sheet = *state.active_sheet.read().unwrap();
            crate::protection::check_sheet_action(state, active_sheet, "formatCells", "format cells")
        }
    }
}

/// Under the held grid and style guards: the Format Cells option of the sheet
/// WRITTEN (the HOST's for a cell target) asked again, so the option the gate
/// passed holding nothing cannot change before the write, and whether that
/// sheet is protected -- a protected sheet's style writes keep every cell's
/// Locked flag (`keep_cell_lock`). LOCKS: `sheet_kinds` then
/// `sheet_protection`, read and released -- after `style_registry`, the order
/// `gate_style_targets` uses; call before the undo stack.
pub(crate) fn format_protection_under_guards(
    state: &AppState,
    resolved: Option<&ResolvedCellTarget>,
    sheet: usize,
    what: &str,
) -> Result<bool, String> {
    let sheet_kinds = state.sheet_kinds.read().unwrap();
    let stored = state.sheet_protection.read().unwrap();
    let view;
    let protection: &crate::protection::ProtectionStorage = match resolved {
        Some(t) => {
            view = crate::cell_target::target_protection_view(&stored, t);
            &view
        }
        None => &stored,
    };
    crate::protection::check_sheet_action_in(&sheet_kinds, protection, sheet, "formatCells", what)?;
    Ok(protection.get(&sheet).is_some_and(|p| p.protected))
}

/// The OWN style index to write at `(row, col)` so the cell keeps the Locked
/// flag `locked` it had before the write -- the rule of every style write on a
/// PROTECTED sheet (Excel [LIVE, Excel 16 COM, Format Cells allowed]: Paste
/// Special > Formats of an unlocked cell onto a locked one leaves it locked,
/// of a locked cell onto an unlocked one leaves it unlocked, and Paste All
/// does the same; only the Locked flag is kept -- Hidden travels with the
/// format). `own` is the index the writer chose; 0 shows the line format at
/// the cell. Unchanged when the look already has that flag; otherwise the
/// look with the flag replaced, interned explicitly so it never reads as
/// "inherit".
pub(crate) fn keep_cell_lock(
    styles: &mut engine::StyleRegistry,
    grid: &engine::Grid,
    row: u32,
    col: u32,
    own: usize,
    locked: bool,
) -> usize {
    let shown = if own != 0 { own } else { line_format_index_at(grid, row, col) };
    if styles.get(shown).locked == locked {
        return own;
    }
    let mut style = styles.get(shown).clone();
    style.locked = locked;
    styles.get_or_create_explicit(style)
}

/// `set_cell_style` without the Tauri wrappers (tests drive the real body).
pub(crate) fn set_cell_style_core(
    state: &AppState,
    file_state: &FileState,
    row: u32,
    col: u32,
    style_index: usize,
    target: Option<&CellTargetRef>,
) -> Result<Option<CellData>, String> {
    // A cell target resolves, holding nothing, before any guard below.
    let resolved = match target {
        Some(target) => {
            let t = crate::cell_target::resolve_cell_target(state, target)?;
            crate::cell_target::ensure_in_extent(&t, row, col, row, col)?;
            Some(t)
        }
        None => None,
    };

    // Sheet protection, before any lock below: the Format Cells option (the
    // HOST's for a cell target) -- the same gate a whole-rectangle CHECK asks
    // (`check_cell_style_area_core`). Returns Result (it used to return a bare
    // Option) so a refusal can reach the user.
    //
    // This command takes an ARBITRARY style index and is reachable from Format
    // Painter and Paste-Formats, so it is the sharpest unlock vector there is:
    // painting format from an unlocked cell onto a locked one would unlock it
    // on a protected sheet. Excel formats a locked cell when Format Cells is
    // allowed but KEEPS its Locked flag [LIVE], so the write below does too
    // (`keep_cell_lock`), decided under the held guards.
    gate_cell_style_rect(state, resolved.as_ref(), (row, col, row, col))?;

    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    // The sheet written: the active sheet, or the target's backing sheet --
    // re-checked under the held grid guards (`sheet_ids` after `grids`).
    let sheet = match &resolved {
        Some(t) => {
            crate::cell_target::ensure_target_still_at(state, t)?;
            t.backing_index
        }
        None => active_sheet,
    };
    if sheet != active_sheet && sheet >= grids.len() {
        return Err("Floating range backing sheet is missing".to_string());
    }
    // WRITE (once authorized), not read: the explicit Normal or a lock-keeping
    // look may have to be interned (below).
    let styles = state.style_registry.lock_pending().unwrap();
    // Asked again under the guards the write uses: the option, and whether the
    // sheet written is protected (then the cell keeps its Locked flag).
    let protected = format_protection_under_guards(state, resolved.as_ref(), sheet, "format cells")?;

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merges = report_merges(state, sheet, active_sheet);
    let locale = state.locale.lock().unwrap();

    // The grid written, and the active sheet's second copy when it is the one.
    let (grid, mirror): (&mut engine::Grid, Option<&mut engine::Grid>) = if sheet == active_sheet {
        (&mut *grid, grids.get_mut(active_sheet))
    } else {
        (&mut grids[sheet], None)
    };

    // Every caller names the LOOK the cell must show -- the source cell's
    // displayed index (drag-move, Format Painter, Paste Special > Formats) --
    // so index 0 means Normal, which on a stored cell is "inherit": under a
    // row/column format it is the explicit Normal (BUG-0354 follow-up; Excel
    // [LIVE]: Paste Special > Formats of a plain cell onto a bold row is plain).
    // Asked of the sheet WRITTEN, so a floating grid's own line formats decide.
    let style_index = own_index_for_requested_look(&mut styles, grid, row, col, style_index);
    // A protected sheet: the cell keeps the Locked flag it had (Excel [LIVE]).
    let style_index = if protected {
        let locked = crate::protection::cell_is_locked(grid, &styles, row, col);
        keep_cell_lock(&mut styles, grid, row, col, style_index, locked)
    } else {
        style_index
    };

    // Record undo, against the sheet the cell is on.
    let previous_cell = grid.get_cell(row, col).cloned();
    undo_stack.record_cell_change(sheet, row, col, previous_cell);

    // The cell keeps its value, formula and rich text; only its style moves. A
    // missing cell is created empty, carrying the style.
    let mut updated_cell = grid.get_cell(row, col).cloned().unwrap_or(Cell {
        value: CellValue::Empty,
        ast: None,
        style_index,
        rich_text: None,
    });
    updated_cell.style_index = style_index;
    grid.set_cell(row, col, updated_cell.clone());
    if let Some(m) = mirror {
        m.set_cell(row, col, updated_cell.clone());
    }

    // Get merge span info
    let (row_span, col_span) = match merges.iter().find(|r| r.start_row == row && r.start_col == col) {
        Some(region) => (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1),
        None => (1, 1),
    };

    // The cell keeps its OWN index (written above); what is DISPLAYED is the
    // resolved one. An index of 0 is left only where no row/column format
    // would show through it (see `own_index_for_requested_look`).
    let effective_style_index = grid.effective_style_index(row, col);
    let style = styles.get(effective_style_index);
    let result = format_cell_value_with_color(&updated_cell.value, style, &locale);
    let accounting_layout = result.accounting.map(|a| crate::api_types::AccountingLayout {
        symbol: a.symbol,
        symbol_before: a.symbol_before,
        value: a.value,
    });

    Ok(Some(CellData {
        row,
        col,
        display: result.text, overflow: result.overflow,
        display_color: result.color,
        formula: updated_cell.formula_string().map(|f| format!("={}", f)),
        style_index: effective_style_index,
        row_span,
        col_span,
        sheet_index: None,
        rich_text: updated_cell.rich_text.as_ref().map(|r| crate::api_types::rich_text_runs_to_data(r)),
        accounting_layout,
    }))
}

/// `set_cell_style`'s style-only BATCH (`cells`): each write as
/// `set_cell_style_core` makes it -- the requested LOOK
/// (`own_index_for_requested_look`), the Locked flag kept on a protected sheet
/// (`keep_cell_lock`), on the active sheet or a target's backing sheet -- but
/// ONE call for them all:
///   - GATED ONCE, ALL OR NOTHING: the Format Cells option (the HOST's for a
///     target) before any lock, and again under the held grid and style guards;
///     a target's whole bounding rectangle must lie inside its write extent.
///     A refusal writes nothing.
///   - ONE UNDO STEP: the caller's open step, else one of its own.
///   - `keep_borders`: the cell keeps every border side it shows (Paste
///     Special > All Except Borders: the source's whole style but its borders
///     [LIVE, Excel 16 COM, 2026-10-04]) -- decided here from the cell's own
///     style, so the frontend no longer reads each destination and puts each
///     side back with its own call.
/// An empty list does nothing and dirties nothing.
pub(crate) fn set_cell_styles_core(
    state: &AppState,
    file_state: &FileState,
    writes: &[crate::api_types::CellStyleWrite],
    target: Option<&CellTargetRef>,
) -> Result<(), String> {
    if writes.is_empty() {
        return Ok(());
    }
    let rect = writes.iter().fold((u32::MAX, u32::MAX, 0u32, 0u32), |r, w| {
        (r.0.min(w.row), r.1.min(w.col), r.2.max(w.row), r.3.max(w.col))
    });
    // A cell target resolves, holding nothing, before any guard below.
    let resolved = match target {
        Some(target) => {
            let t = crate::cell_target::resolve_cell_target(state, target)?;
            crate::cell_target::ensure_in_extent(&t, rect.0, rect.1, rect.2, rect.3)?;
            Some(t)
        }
        None => None,
    };
    // The same gate one cell's write asks, asked once for the whole set.
    gate_cell_style_rect(state, resolved.as_ref(), rect)?;

    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let sheet = match &resolved {
        Some(t) => {
            crate::cell_target::ensure_target_still_at(state, t)?;
            t.backing_index
        }
        None => active_sheet,
    };
    if sheet != active_sheet && sheet >= grids.len() {
        return Err("Floating range backing sheet is missing".to_string());
    }
    let styles = state.style_registry.lock_pending().unwrap();
    // Asked again under the guards the writes use (see `set_cell_style_core`).
    let protected = format_protection_under_guards(state, resolved.as_ref(), sheet, "format cells")?;

    // Every gate above has passed; from here this command commits.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut undo_stack = state.undo_stack.lock().unwrap();

    let (grid, mut mirror): (&mut engine::Grid, Option<&mut engine::Grid>) = if sheet == active_sheet {
        (&mut *grid, grids.get_mut(active_sheet))
    } else {
        (&mut grids[sheet], None)
    };

    let opened_transaction = !undo_stack.has_open_transaction();
    if opened_transaction {
        undo_stack.begin_transaction(format!("Format {} cells", writes.len()));
    }
    for w in writes {
        let (row, col) = (w.row, w.col);
        let mut style_index = own_index_for_requested_look(&mut styles, grid, row, col, w.style_index);
        if w.keep_borders.unwrap_or(false) {
            let own_borders = styles.get(grid.effective_style_index(row, col)).borders.clone();
            let shown = if style_index != 0 { style_index } else { line_format_index_at(grid, row, col) };
            if styles.get(shown).borders != own_borders {
                let mut style = styles.get(shown).clone();
                style.borders = own_borders;
                style_index = styles.get_or_create_explicit(style);
            }
        }
        if protected {
            let locked = crate::protection::cell_is_locked(grid, &styles, row, col);
            style_index = keep_cell_lock(&mut styles, grid, row, col, style_index, locked);
        }
        let previous_cell = grid.get_cell(row, col).cloned();
        undo_stack.record_cell_change(sheet, row, col, previous_cell.clone());
        let mut updated_cell = previous_cell.unwrap_or(Cell {
            value: CellValue::Empty,
            ast: None,
            style_index,
            rich_text: None,
        });
        updated_cell.style_index = style_index;
        if let Some(m) = mirror.as_deref_mut() {
            m.set_cell(row, col, updated_cell.clone());
        }
        grid.set_cell(row, col, updated_cell);
    }
    if opened_transaction {
        undo_stack.commit_transaction();
    }
    Ok(())
}

// ============================================================================
// A CELL THAT MOVES KEEPS ITS LOOK (BUG-0354 follow-up)
// ============================================================================
//
// Since BUG-0354 a whole-row / whole-column format is ONE row or column tier,
// and a stored cell with style index 0 INHERITS it (`Grid::effective_style_index`).
// Excel has no "inherit" on a cell: every cell carries its own style, and a
// line format applies only where no cell exists -- a value typed under a row
// format takes that format as its own [LIVE, Excel 16, 2026-10-29: row 5 Bold,
// then a value typed in C5 saves `<c r=C5 s=bold>`]. So in Excel a moved cell
// keeps the look it showed, and a cell landing under a line format does not
// pick it up [LIVE, lane `lineformat` probe.ps1 / probe2.ps1: Sort, Delete
// Cells shift up, Insert Cells shift down, Copy, Cut, Fill Down and Paste
// Special > Formats all leave a plain cell plain in a bold row, and carry a
// bold-row cell's bold away with it].
//
// Every MOVE primitive therefore writes the look explicitly where the line
// format at the origin and the one at the destination differ, and a writer
// that names a look (a paste, a fill, a drag-move) gets the explicit Normal --
// never index 0 -- where a line format would otherwise show through. Typing is
// unchanged: a value typed under a line format still inherits it.

/// The style an INHERITING cell (own index 0) shows at `(row, col)`: the row's
/// format, else the column's, else 0 -- `Grid::effective_style_index` with the
/// cell itself left out. This is the "line format" a move carries a cell off
/// or onto.
pub(crate) fn line_format_index_at(grid: &engine::Grid, row: u32, col: u32) -> usize {
    match grid.row_styles.get(&row) {
        Some(&index) if index != 0 => index,
        _ => match grid.column_styles.get(&col) {
            Some(&index) if index != 0 => index,
            _ => 0,
        },
    }
}

/// Whether two style indices LOOK the same (the same index, or equal styles --
/// index 0 and the explicit Normal look alike).
pub(crate) fn same_cell_look(styles: &engine::StyleRegistry, a: usize, b: usize) -> bool {
    a == b || styles.get(a) == styles.get(b)
}

/// The explicit Normal: a NON-ZERO index whose style is the default, because 0
/// means "inherit" on a cell (`StyleRegistry::get_or_create_explicit`, memoised
/// in the registry, so every caller shares one entry).
pub(crate) fn explicit_normal_index(styles: &mut engine::StyleRegistry) -> usize {
    let normal = styles.default_style().clone();
    styles.get_or_create_explicit(normal)
}

/// The OWN style index a moved cell with NO style of its own (index 0) must
/// carry so it keeps the look it showed. `origin_line` is the line format at
/// its origin (`line_format_index_at` there: what it showed), `dest_line` the
/// one where it lands. 0 -- go on inheriting -- when the two look the same;
/// otherwise the origin's line format, or the explicit Normal when the origin
/// had none. A cell with a style of its own needs nothing: it carries it.
///
/// It also answers for an EMPTY position whose look a move carries (Insert /
/// Delete Cells, a pasted blank): a non-zero result is the style of the blank
/// cell that position needs.
pub(crate) fn carried_line_format(styles: &mut engine::StyleRegistry, origin_line: usize, dest_line: usize) -> usize {
    if same_cell_look(styles, origin_line, dest_line) {
        0
    } else if origin_line != 0 {
        origin_line
    } else {
        explicit_normal_index(styles)
    }
}

/// The OWN index for a writer that names the LOOK a cell must show -- a paste,
/// a fill, a drag-move, Format Painter: every one of them sends the source
/// cell's DISPLAYED index. A non-zero index is kept as it is. Index 0 means
/// Normal, which on a stored cell reads as "inherit": where a row/column format
/// sits under `(row, col)` it becomes the explicit Normal, so a plain cell
/// copied into a bold row stays plain [LIVE, Excel 16].
pub(crate) fn own_index_for_requested_look(
    styles: &mut engine::StyleRegistry,
    grid: &engine::Grid,
    row: u32,
    col: u32,
    requested: usize,
) -> usize {
    if requested != 0 {
        return requested;
    }
    carried_line_format(styles, 0, line_format_index_at(grid, row, col))
}

/// The parameters of one `apply_formatting` call, with every field that can be
/// REFUSED already parsed.
///
/// WHY PARSE FIRST. Three fields can be wrong in a way that must reach the
/// user: a font size outside Excel's 1..=409, a text rotation the backend does
/// not know, and (later, per cell) nothing else. Parsing them inside the cell
/// loop -- where they used to be read -- meant a bad value was discovered with
/// the document already dirty and half the cells written. Parsing here, before
/// the gates and before `DocumentEffect::mutates`, makes a bad value a clean
/// refusal. The number format is parsed here too, once, instead of once per
/// distinct base style.
///
/// ONE APPLIER FOR BOTH COMMANDS. `apply_formatting` and
/// `apply_formatting_to_sheets` used to carry two hand-copied lists of
/// "if let Some(x) = params.x { style.x = x }" -- the second one in compressed
/// one-line form, which is exactly how two copies drift. Both now call
/// `ParsedFormatting::apply`.
pub(crate) struct ParsedFormatting<'a> {
    params: &'a FormattingParams,
    font_size: Option<FontSize>,
    text_rotation: Option<TextRotation>,
    number_format: Option<NumberFormat>,
}

impl<'a> ParsedFormatting<'a> {
    pub(crate) fn parse(
        params: &'a FormattingParams,
        locale: &engine::LocaleSettings,
    ) -> Result<Self, String> {
        let font_size = match params.font_size {
            None => None,
            Some(points) => Some(FontSize::from_points(points).ok_or_else(|| {
                format!(
                    "Font size must be a number between {} and {} points (got {}).",
                    FontSize::MIN_POINTS,
                    FontSize::MAX_POINTS,
                    points
                )
            })?),
        };
        let text_rotation = params.text_rotation.as_deref().map(parse_text_rotation).transpose()?;
        // Locale-aware: the ribbon's Currency / Accounting / Short Date / Long
        // Date / Time entries are REGIONAL presets, and the invariant parse
        // would resolve them to US shapes.
        let number_format = params
            .number_format
            .as_deref()
            .map(|format| parse_number_format_with_locale(format, locale));
        Ok(ParsedFormatting { params, font_size, text_rotation, number_format })
    }

    /// Write every field the caller set onto `style`. Fields left `None` are
    /// untouched, so "bold this range" never resets its font or its format.
    pub(crate) fn apply(&self, new_style: &mut CellStyle) {
        let params = self.params;
        if let Some(bold) = params.bold {
            new_style.font.bold = bold;
        }
        if let Some(italic) = params.italic {
            new_style.font.italic = italic;
        }
        if let Some(underline) = params.underline {
            new_style.font.underline = underline.into();
        }
        if let Some(strikethrough) = params.strikethrough {
            new_style.font.strikethrough = strikethrough;
        }
        if let Some(font_size) = self.font_size {
            new_style.font.size = font_size;
        }
        if let Some(ref font_family) = params.font_family {
            new_style.font.family = font_family.clone();
        }
        if let Some(ref text_color) = params.text_color {
            if let Some(color) = Color::from_hex(text_color) {
                new_style.font.color = ThemeColor::Absolute(color);
            }
        }
        if let Some(ref text_color_theme) = params.text_color_theme {
            if let Some(slot) = engine::ThemeColorSlot::from_key(text_color_theme) {
                let tint = engine::Tint(params.text_color_tint.unwrap_or(0));
                new_style.font.color = ThemeColor::Theme { slot, tint };
            }
        }
        if let Some(ref bg_color) = params.background_color {
            if let Some(color) = Color::from_hex(bg_color) {
                new_style.fill = Fill::Solid { color: ThemeColor::Absolute(color) };
            }
        }
        if let Some(ref bg_color_theme) = params.bg_color_theme {
            if let Some(slot) = engine::ThemeColorSlot::from_key(bg_color_theme) {
                let tint = engine::Tint(params.bg_color_tint.unwrap_or(0));
                new_style.fill = Fill::Solid { color: ThemeColor::Theme { slot, tint } };
            }
        }
        if let Some(ref align) = params.text_align {
            new_style.text_align = match align.as_str() {
                "left" => TextAlign::Left,
                "center" => TextAlign::Center,
                "right" => TextAlign::Right,
                _ => TextAlign::General,
            };
        }
        if let Some(ref valign) = params.vertical_align {
            new_style.vertical_align = match valign.as_str() {
                "top" => VerticalAlign::Top,
                "middle" => VerticalAlign::Middle,
                "bottom" => VerticalAlign::Bottom,
                // Excel's default vertical alignment is BOTTOM, so an
                // unrecognised spelling resolves to the document default
                // rather than to a third state.
                _ => VerticalAlign::Bottom,
            };
        }
        if let Some(wrap) = params.wrap_text {
            new_style.wrap_text = wrap;
        }
        if let Some(rotation) = self.text_rotation {
            new_style.text_rotation = rotation;
        }
        if let Some(ref format) = self.number_format {
            new_style.number_format = format.clone();
        }
        if let Some(checkbox) = params.checkbox {
            new_style.checkbox = checkbox;
        }
        if let Some(button) = params.button {
            new_style.button = button;
        }
        if let Some(indent) = params.indent {
            new_style.indent = indent;
        }
        if let Some(shrink_to_fit) = params.shrink_to_fit {
            new_style.shrink_to_fit = shrink_to_fit;
        }

        // Borders
        if let Some(ref border) = params.border_top {
            new_style.borders.top = parse_border_side(border);
        }
        if let Some(ref border) = params.border_right {
            new_style.borders.right = parse_border_side(border);
        }
        if let Some(ref border) = params.border_bottom {
            new_style.borders.bottom = parse_border_side(border);
        }
        if let Some(ref border) = params.border_left {
            new_style.borders.left = parse_border_side(border);
        }
        if let Some(ref border) = params.border_diagonal_down {
            new_style.borders.diagonal_down = parse_border_side(border);
        }
        if let Some(ref border) = params.border_diagonal_up {
            new_style.borders.diagonal_up = parse_border_side(border);
        }

        // Fill
        if let Some(ref fill_param) = params.fill {
            new_style.fill = parse_fill_param(fill_param);
        }

        // Protection
        if let Some(locked) = params.locked {
            new_style.locked = locked;
        }
        if let Some(formula_hidden) = params.formula_hidden {
            new_style.formula_hidden = formula_hidden;
        }
    }
}

/// Apply formatting to a range of cells -- on the active sheet and, with sheets
/// GROUPED, on every other sheet in `sheet_indices` too.
///
/// ONE COMMAND FOR THE GROUP (review finding, 2026-10-04). The wrapper used to
/// format the active sheet with this command and then repeat it on the group
/// with `apply_formatting_to_sheets`: a protected grouped sheet refused only
/// the SECOND call, after the active sheet was already formatted (and the
/// refusal went to the console), and a successful group took one Ctrl+Z per
/// sheet plus one. Now every sheet is gated before any is written and the whole
/// group is ONE undo step. `sheet_indices` may include the active sheet; an
/// absent list formats the active sheet only.
///
/// `target` (P3, owner finding G3): format an OBJECT's cells instead -- a
/// floating grid's backing sheet, ONLY, inside its write extent, gated by the
/// HOST's protection. Refused together with `sheet_indices`; the result then
/// describes the BACKING cells (their merges included).
#[tauri::command]
pub fn apply_formatting(
    state: State<AppState>,
    file_state: State<FileState>,
    params: FormattingParams,
    sheet_indices: Option<Vec<usize>>,
    target: Option<CellTargetRef>,
) -> Result<FormattingResult, String> {
    apply_formatting_on(&state, &file_state, &params, sheet_indices.as_deref().unwrap_or(&[]), target.as_ref())
}

/// `apply_formatting` without the Tauri wrappers, so the tests drive the real
/// body. `group` is the grouped sheets (the active sheet is always formatted).
pub(crate) fn apply_formatting_core(
    state: &AppState,
    file_state: &FileState,
    params: &FormattingParams,
    group: &[usize],
) -> Result<FormattingResult, String> {
    apply_formatting_on(state, file_state, params, group, None)
}

/// [`apply_formatting_core`] with an optional cell target. With `Some`, the
/// group must be empty, and only the target's backing sheet is written.
pub(crate) fn apply_formatting_on(
    state: &AppState,
    file_state: &FileState,
    params: &FormattingParams,
    group: &[usize],
    target: Option<&CellTargetRef>,
) -> Result<FormattingResult, String> {
    // Refusable VALUES first (see `ParsedFormatting`), then the gates.
    let parsed = {
        let locale = state.locale.lock().unwrap();
        ParsedFormatting::parse(params, &locale)?
    };
    let resolved = resolve_style_target(state, target, !group.is_empty(), bounds_of_lists(&params.rows, &params.cols))?;
    let route = match &resolved {
        Some(t) => StyleTargets::Only(t),
        None => StyleTargets::Sheets { group, include_active: true },
    };
    format_cells_on_sheets(state, file_state, &parsed, &params.rows, &params.cols, route).map(|(result, _)| result)
}

/// [`apply_formatting_core`] on the ACTIVE sheet only, also answering WHICH
/// sheet that was. The active sheet is read ONCE, under the guards the format
/// is gated and written under (`StyleLocks::take`), and a canvas sheet is
/// refused there (the formatCells gate, `check_sheet_action_in`) -- so a
/// caller that names the sheet afterwards names the one actually formatted,
/// whatever tab the user clicked meanwhile (the MCP tool's audit row, review
/// revFU#9).
pub(crate) fn apply_formatting_core_on_active(
    state: &AppState,
    file_state: &FileState,
    params: &FormattingParams,
) -> Result<(FormattingResult, usize), String> {
    let parsed = {
        let locale = state.locale.lock().unwrap();
        ParsedFormatting::parse(params, &locale)?
    };
    let route = StyleTargets::Sheets { group: &[], include_active: true };
    format_cells_on_sheets(state, file_state, &parsed, &params.rows, &params.cols, route)
}

/// The cell-target half of every style command, run holding NOTHING before
/// `StyleLocks::take`: resolve the target once, refuse it together with an
/// explicit sheet group, and refuse a rectangle (`(r0, c0, r1, c1)`; `None`
/// for an empty selection) outside the write extent. `None` without a target.
fn resolve_style_target(
    state: &AppState,
    target: Option<&CellTargetRef>,
    has_group: bool,
    bounds: Option<(u32, u32, u32, u32)>,
) -> Result<Option<ResolvedCellTarget>, String> {
    let Some(target) = target else { return Ok(None) };
    crate::cell_target::refuse_target_with_sheet(&Some(target.clone()), has_group)?;
    let resolved = crate::cell_target::resolve_cell_target(state, target)?;
    if let Some((r0, c0, r1, c1)) = bounds {
        crate::cell_target::ensure_in_extent(&resolved, r0, c0, r1, c1)?;
    }
    Ok(Some(resolved))
}

/// The bounding box `(min row, min col, max row, max col)` of `rows` x
/// `cols`; `None` when either list is empty.
fn bounds_of_lists(rows: &[u32], cols: &[u32]) -> Option<(u32, u32, u32, u32)> {
    Some((*rows.iter().min()?, *cols.iter().min()?, *rows.iter().max()?, *cols.iter().max()?))
}

// ============================================================================
// ONE CRITICAL SECTION AND ONE UNDO STEP for every style command
// ============================================================================

/// THE GUARDS EVERY STYLE COMMAND HOLDS FROM ITS FIRST GATE TO ITS LAST WRITE.
///
/// The border presets and the decimal step used to decide under READ guards,
/// drop them, and write under re-acquired ones; Tauri dispatches on a thread
/// pool, so an edit landing in between (Bold from a script) was overwritten by
/// a style computed from the stale base, and the protection gate answered about
/// cells that could change before the write (review finding, 2026-10-04;
/// CLAUDE.md: "Never read(), drop the lock, then write()"). Taken with
/// `lock_pending` in the canonical order -- `grid`, `grids`, then the style
/// registry -- and turned into write guards with `.authorize(&effect)` only
/// once every gate has passed and something will change.
struct StyleLocks<'a> {
    grid: crate::document_effect::PendingGuard<'a, engine::Grid>,
    grids: crate::document_effect::PendingGuard<'a, Vec<engine::Grid>>,
    styles: crate::document_effect::PendingGuard<'a, engine::StyleRegistry>,
    active_sheet: usize,
}

impl<'a> StyleLocks<'a> {
    fn take(state: &'a AppState) -> Self {
        let grid = state.grid.lock_pending().unwrap();
        let grids = state.grids.lock_pending().unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();
        let styles = state.style_registry.lock_pending().unwrap();
        StyleLocks { grid, grids, styles, active_sheet }
    }

    /// The cells of `sheet` as the user sees them: the active sheet's live
    /// mirror (`state.grid`; `grids[active]` is its second copy), else
    /// `grids[sheet]`. `None` for a sheet the workbook does not have.
    fn sheet_grid(&self, sheet: usize) -> Option<&engine::Grid> {
        if sheet == self.active_sheet {
            Some(&*self.grid)
        } else {
            self.grids.get(sheet)
        }
    }

    /// The sheets a command writes, once each: the active sheet first when
    /// `include_active`, then every listed sheet the workbook has.
    fn targets(&self, group: &[usize], include_active: bool) -> Vec<usize> {
        let mut out = Vec::with_capacity(group.len() + 1);
        if include_active {
            out.push(self.active_sheet);
        }
        for &sheet in group {
            if sheet != self.active_sheet && sheet < self.grids.len() && !out.contains(&sheet) {
                out.push(sheet);
            }
        }
        out
    }

    /// The sheets `route` writes, once each, and the sheet whose written cells
    /// the result REPORTS: the active sheet for a sheet route, the backing
    /// sheet for a cell target (P3).
    fn route_targets(&self, route: &StyleTargets<'_>) -> (Vec<usize>, usize) {
        match route {
            StyleTargets::Sheets { group, include_active } => (self.targets(group, *include_active), self.active_sheet),
            StyleTargets::Only(t) => {
                // ONLY the backing sheet: never the active sheet, never a group.
                let mut out = self.targets(&[], false);
                if t.backing_index < self.grids.len() && !out.contains(&t.backing_index) {
                    out.push(t.backing_index);
                }
                (out, t.backing_index)
            }
        }
    }
}

/// Which sheets a style command writes (P3).
#[derive(Clone, Copy)]
enum StyleTargets<'t> {
    /// The active sheet (when `include_active`) and the grouped sheets.
    Sheets { group: &'t [usize], include_active: bool },
    /// ONLY a cell target's backing sheet, gated by its HOST's protection.
    Only(&'t ResolvedCellTarget),
}

impl<'t> StyleTargets<'t> {
    fn cell_target(&self) -> Option<&'t ResolvedCellTarget> {
        match self {
            StyleTargets::Only(t) => Some(t),
            StyleTargets::Sheets { .. } => None,
        }
    }
}

/// Which cell attributes a style command changes, for its protection gate.
#[derive(Clone, Copy, PartialEq, Eq)]
enum StyleChange {
    /// Only the look (font, fill, borders, number format, alignment, ...).
    Look,
    /// The Locked or Hidden flag too (the Protection tab, a script's
    /// `locked` / `formulaHidden`).
    Protection,
}

/// The refusal of a Locked / Hidden change on a protected sheet.
fn protection_flag_refusal() -> String {
    "Cannot change whether cells are locked or hidden while the sheet is protected. \
     Unprotect the sheet first (Review > Unprotect Sheet)."
        .to_string()
}

/// Gate EVERY target sheet against the HELD guards, before anything is
/// written: one protected sheet refuses the whole group. `what` names the
/// operation in the refusal.
///
/// A protected sheet is asked ONLY its Format Cells option -- never the cells'
/// lock flags. Excel formats LOCKED cells when Format Cells is allowed (Bold,
/// a number format, a border, a fill and a cell style all land on a locked
/// cell [LIVE, Excel 16 COM, 2026-10-30]); the lock flags guard content. A
/// format delta never moves the Locked flag, so a cell keeps it; a change OF
/// the Locked or Hidden flag (`StyleChange::Protection`) is refused on a
/// protected sheet whatever its options, as Excel refuses `Range.Locked` and
/// `Range.FormulaHidden` there [LIVE].
///
/// With a cell target (P3) the backing sheet is first re-checked to still be
/// the target's (`ensure_target_still_at`: `sheet_ids` after `grids`), and the
/// protection asked is the HOST's, through the derived view
/// (`cell_target::target_protection_view`).
fn gate_style_targets(
    state: &AppState,
    locks: &StyleLocks<'_>,
    targets: &[usize],
    cell_target: Option<&ResolvedCellTarget>,
    change: StyleChange,
    what: &str,
) -> Result<(), String> {
    if let Some(t) = cell_target {
        crate::cell_target::ensure_target_still_at(state, t)?;
    }
    // After the style registry, released before the undo stack is taken: the
    // order search.rs's held-guard gates use.
    let sheet_kinds = state.sheet_kinds.read().unwrap();
    let stored = state.sheet_protection.read().unwrap();
    let view;
    let protection: &crate::protection::ProtectionStorage = match cell_target {
        Some(t) => {
            view = crate::cell_target::target_protection_view(&stored, t);
            &view
        }
        None => &stored,
    };
    for &sheet in targets {
        if locks.sheet_grid(sheet).is_none() {
            continue;
        }
        crate::protection::check_sheet_action_in(&sheet_kinds, protection, sheet, "formatCells", what)?;
        if change == StyleChange::Protection && protection.get(&sheet).is_some_and(|p| p.protected) {
            return Err(protection_flag_refusal());
        }
    }
    Ok(())
}

/// The body of `apply_formatting` and `apply_formatting_to_sheets`: gate every
/// target sheet under the held guards, then write `rows` x `cols` on each of
/// them inside ONE owned undo transaction (or the step a caller holds open).
/// Returns the REPORTED sheet's written cells (the active sheet's, or a cell
/// target's backing sheet's) and the styles they use.
///
/// WHOLE ROWS, WHOLE COLUMNS AND SELECT ALL GO THROUGH THE TIERS (BUG-0354).
/// This walked every (row, col) of the lists: Ctrl+A then Ctrl+B is 1,048,576
/// x 16,384 = 17.2 billion positions, a cell and an undo entry each, and the
/// app stopped responding; Left Border on a whole column (the Borders split's
/// edge presets come here) materialised a million cells. When the lists are
/// one rectangle spanning whole rows or whole columns -- or ALMOST whole ones
/// (A2:D1048576, `CellRect::line_extent`) -- the change is planned by
/// `plan_range_style` -- the planner the border presets and the decimal step
/// use -- as ONE row/column tier entry per line plus the cells whose style
/// must differ from it or that hold a value, which is also what Excel stores
/// (a cell typed there later inherits the line's format; an existing value
/// takes it as its own). Anything else keeps the cell walk, bounded by
/// `DENSE_BORDER_CELL_LIMIT` and refused above it before any guard is taken.
/// A rectangle is gated with the RANGE form of the protection gate, which
/// never enumerates it.
///
/// Also answers the REPORTED sheet -- read once, under the guards everything
/// above was gated and written under -- so a caller that names the sheet
/// afterwards (the MCP tool's audit row) names the one formatted.
fn format_cells_on_sheets(
    state: &AppState,
    file_state: &FileState,
    parsed: &ParsedFormatting<'_>,
    rows: &[u32],
    cols: &[u32],
    route: StyleTargets<'_>,
) -> Result<(FormattingResult, usize), String> {
    let rect = rect_of_lists(rows, cols);
    let lines = rect.filter(|r| r.line_extent().is_some());
    let count = rows.len() as u64 * cols.len() as u64;
    if lines.is_none() && count > DENSE_BORDER_CELL_LIMIT {
        return Err(dense_limit_refusal(&FORMAT_WORDING, count));
    }

    let locks = StyleLocks::take(state);
    let (targets, report_sheet) = locks.route_targets(&route);
    let change = if parsed.params.locked.is_some() || parsed.params.formula_hidden.is_some() {
        StyleChange::Protection
    } else {
        StyleChange::Look
    };
    gate_style_targets(state, &locks, &targets, route.cell_target(), change, "format cells")?;
    if targets.is_empty() {
        // Nothing to format (a group of only the active sheet, or indices past
        // the workbook): nothing written, and the document stays clean -- this
        // used to construct the effect regardless.
        return Ok((FormattingResult { cells: Vec::new(), styles: Vec::new() }, report_sheet));
    }
    let label = format!("Format {} cells", count);
    if let Some(rect) = lines {
        return format_lines_on_sheets(state, file_state, parsed, rect, locks, &targets, report_sheet, &label)
            .map(|result| (result, report_sheet));
    }

    // Every gate has passed; from here this command commits. Constructed HERE
    // so a refusal cannot leave a spuriously dirty document.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let StyleLocks { grid, grids, styles, active_sheet } = locks;
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Joins a step the caller holds open (a script's undo batch).
    let txn = undo_stack.begin_owned_transaction(label);
    let delta = |style: &mut CellStyle| parsed.apply(style);
    let mut written = Vec::new();
    for &sheet in &targets {
        let cells = if sheet == active_sheet {
            write_style_delta(
                &mut grid,
                grids.get_mut(active_sheet),
                &mut styles,
                &mut undo_stack,
                sheet,
                rows,
                cols,
                &delta,
            )
        } else if let Some(sheet_grid) = grids.get_mut(sheet) {
            write_style_delta(sheet_grid, None, &mut styles, &mut undo_stack, sheet, rows, cols, &delta)
        } else {
            continue;
        };
        // KEEP the reported sheet's cells -- a cell target's backing sheet's
        // too, which used to be discarded with every off-sheet result.
        if sheet == report_sheet {
            written = cells;
        }
    }
    undo_stack.commit_owned(txn);
    drop(undo_stack);

    let mut used: Vec<usize> = written.iter().map(|&(_, _, index)| index).collect();
    used.sort_unstable();
    used.dedup();
    let merges = report_merges(state, report_sheet, active_sheet);
    let report_grid = if report_sheet == active_sheet { &*grid } else { &grids[report_sheet] };
    Ok((formatting_result(state, report_grid, &styles, &written, &merges, Some(used)), report_sheet))
}

/// The WHOLE-LINE half of `format_cells_on_sheets` (BUG-0354), under the
/// guards it took and gated: plan `rect` on EVERY target sheet first -- a
/// refusal (too many tier crossings) writes nothing on any sheet -- then, only
/// if something changes, construct the effect and write every plan inside ONE
/// owned transaction (`write_range_style_plan`: tiers with their undo snapshot,
/// then the cells that differ).
///
/// The result's `cells` are the reported sheet's cells whose look differs
/// from the new tiers only: a stored value that takes the line's format as
/// its own (`RangeStylePlan::carried`) is written but not listed -- on a
/// filled sheet that is every value -- so callers refresh the grid (every
/// caller announces through `styles:refresh` / `grid:refresh`, as for the
/// border presets). Its `styles` carry the listed cells' AND the new tiers'
/// and carried cells' styles -- a Select All writes tiers and maybe no listed
/// cell at all, and the frontend style cache must know a tier's index to
/// paint the column (`announceStyleEntries`, BUG-0076).
#[allow(clippy::too_many_arguments)]
fn format_lines_on_sheets<'a>(
    state: &'a AppState,
    file_state: &FileState,
    parsed: &ParsedFormatting<'_>,
    rect: CellRect,
    locks: StyleLocks<'a>,
    targets: &[usize],
    report_sheet: usize,
    label: &str,
) -> Result<FormattingResult, String> {
    let delta = |style: &mut CellStyle, _: EdgePosition| parsed.apply(style);
    let mut plans: Vec<(usize, RangeStylePlan)> = Vec::new();
    for &sheet in targets {
        let Some(grid) = locks.sheet_grid(sheet) else { continue };
        // Every FormattingParams field sets the same value at every position:
        // the edges never matter.
        let plan = plan_range_style(grid, &locks.styles, rect, &delta, false, &FORMAT_WORDING)?;
        if !plan.is_empty() {
            plans.push((sheet, plan));
        }
    }
    if plans.is_empty() {
        // Every position already shows that format: nothing is written,
        // nothing is recorded, and the document stays clean.
        return Ok(FormattingResult { cells: Vec::new(), styles: Vec::new() });
    }

    // Every gate has passed and something changes; from here this command
    // commits. Constructed HERE so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let StyleLocks { grid, grids, styles, active_sheet } = locks;
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Joins a step the caller holds open (a script's undo batch, the Home
    // tab's multi-block gesture).
    let txn = undo_stack.begin_owned_transaction(label.to_string());
    let mut written = Vec::new();
    let mut used: Vec<usize> = Vec::new();
    for (sheet, plan) in plans {
        let outcome = if sheet == active_sheet {
            write_range_style_plan(&mut grid, grids.get_mut(active_sheet), &mut styles, &mut undo_stack, sheet, plan, label)
        } else if let Some(sheet_grid) = grids.get_mut(sheet) {
            write_range_style_plan(sheet_grid, None, &mut styles, &mut undo_stack, sheet, plan, label)
        } else {
            continue;
        };
        used.extend(outcome.cells.iter().map(|&(_, _, index)| index));
        used.extend(outcome.unreported_styles.iter().copied());
        if sheet == report_sheet {
            written = outcome.cells;
        }
    }
    undo_stack.commit_owned(txn);
    drop(undo_stack);

    used.sort_unstable();
    used.dedup();
    let merges = report_merges(state, report_sheet, active_sheet);
    let report_grid = if report_sheet == active_sheet { &*grid } else { &grids[report_sheet] };
    Ok(formatting_result(state, report_grid, &styles, &written, &merges, Some(used)))
}

/// The merged regions of the REPORTED sheet, for the result's spans: the
/// active sheet's live mirror (`state.merged_regions`), else the stored set
/// `all_merged_regions[sheet]` (a cell target's backing sheet). Read after the
/// caller's held grid and style guards, as `formatting_result` always read
/// the mirror.
fn report_merges(state: &AppState, report_sheet: usize, active_sheet: usize) -> Vec<MergedRegion> {
    if report_sheet == active_sheet {
        state.merged_regions.read().unwrap().iter().cloned().collect()
    } else {
        state
            .all_merged_regions
            .read()
            .unwrap()
            .get(report_sheet)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// THE WALK of `apply_formatting`, on ONE sheet: for every (row, col) in
/// `rows` x `cols`, take the cell's EFFECTIVE style, run `delta` on a copy,
/// intern the result and point the cell at it, recording the previous cell
/// against `sheet` in the caller's open transaction. `mirror` is the second
/// copy of the ACTIVE sheet (`grids[active]` beside `state.grid`), written in
/// step. The caller holds every guard and has passed every gate. Returns the
/// cells written with their new style index.
#[allow(clippy::too_many_arguments)]
fn write_style_delta(
    grid: &mut engine::Grid,
    mut mirror: Option<&mut engine::Grid>,
    styles: &mut engine::StyleRegistry,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    rows: &[u32],
    cols: &[u32],
    delta: &dyn Fn(&mut CellStyle),
) -> Vec<(u32, u32, usize)> {
    // Optimization: cache the computed style index per (base style,
    // needs-explicit) pair. A selection's cells mostly share a few bases.
    let mut style_cache: std::collections::HashMap<(usize, bool), usize> = std::collections::HashMap::new();
    let mut written = Vec::new();
    for &row in rows {
        for &col in cols {
            let previous_cell = grid.get_cell(row, col).cloned();
            let mut cell = previous_cell.clone().unwrap_or(Cell {
                value: CellValue::Empty,
                ast: None,
                style_index: 0,
                rich_text: None,
            });

            // Base the delta on the EFFECTIVE style: a style-0 cell under a
            // row/column tier is showing the tier's format (and lock state),
            // and basing on index 0 would discard the tier -- turning "bold this
            // cell" into "bold + strip the column's fill", or silently
            // re-locking a cell inside a tier-unlocked column.
            let old_style_index = grid.effective_style_index(row, col);
            // Under a tier, the computed style must land on a NON-ZERO index
            // even when it equals the default -- index 0 would mean "inherit"
            // and resolve straight back to the tier.
            let needs_explicit = cell.style_index == 0 && old_style_index != 0;
            let new_style_index = match style_cache.get(&(old_style_index, needs_explicit)) {
                Some(&cached) => cached,
                None => {
                    let mut new_style = styles.get(old_style_index).clone();
                    delta(&mut new_style);
                    let index = if needs_explicit {
                        styles.get_or_create_explicit(new_style)
                    } else {
                        styles.get_or_create(new_style)
                    };
                    style_cache.insert((old_style_index, needs_explicit), index);
                    index
                }
            };

            cell.style_index = new_style_index;
            grid.set_cell(row, col, cell.clone());
            if let Some(m) = mirror.as_deref_mut() {
                m.set_cell(row, col, cell);
            }
            // THE SHEET THIS CELL IS ON: a grouped sheet's change recorded
            // against the active sheet made Undo overwrite the ACTIVE sheet
            // with the grouped sheet's old cell (rust-format, 2026-10-04).
            undo_stack.record_cell_change(sheet, row, col, previous_cell);
            written.push((row, col, new_style_index));
        }
    }
    written
}

/// The `FormattingResult` the frontend primes its caches from: a `CellData`
/// for every written cell of the REPORTED sheet (`grid`), and the styles --
/// `Some(indices)` for just those, `None` for the WHOLE registry (a tier's
/// style is referenced by no returned cell, and the style cache must still
/// know it to paint the column). `merges` are the reported sheet's merged
/// regions, passed EXPLICITLY (`report_merges`) so a cell target's result
/// spans the BACKING sheet's merges, never the active sheet's mirror (P3).
/// Takes the locale and the theme after the caller's held guards, the order
/// every style command has always used.
fn formatting_result(
    state: &AppState,
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    written: &[(u32, u32, usize)],
    merges: &[MergedRegion],
    returned_styles: Option<Vec<usize>>,
) -> FormattingResult {
    let locale = state.locale.lock().unwrap();
    let merge_at: std::collections::HashMap<(u32, u32), (u32, u32)> = merges
        .iter()
        .map(|r| ((r.start_row, r.start_col), (r.end_row - r.start_row + 1, r.end_col - r.start_col + 1)))
        .collect();
    let mut cells = Vec::with_capacity(written.len());
    for &(row, col, style_index) in written {
        let Some(cell) = grid.get_cell(row, col) else { continue };
        let fmt_result = format_cell_value_with_color(&cell.value, styles.get(style_index), &locale);
        let acct_layout = fmt_result.accounting.map(|a| crate::api_types::AccountingLayout {
            symbol: a.symbol,
            symbol_before: a.symbol_before,
            value: a.value,
        });
        let (row_span, col_span) = merge_at.get(&(row, col)).copied().unwrap_or((1, 1));
        cells.push(CellData {
            row,
            col,
            display: fmt_result.text,
            overflow: fmt_result.overflow,
            display_color: fmt_result.color,
            formula: cell.formula_string().map(|f| format!("={}", f)),
            style_index,
            row_span,
            col_span,
            sheet_index: None,
            rich_text: None,
            accounting_layout: acct_layout,
        });
    }
    drop(locale);

    let theme = state.theme.read().unwrap();
    let all = styles.all_styles();
    let styles = match returned_styles {
        Some(indices) => indices
            .into_iter()
            .filter_map(|index| all.get(index).map(|style| StyleEntry { index, style: StyleData::from_cell_style(style, &theme) }))
            .collect(),
        None => all
            .iter()
            .enumerate()
            .map(|(index, style)| StyleEntry { index, style: StyleData::from_cell_style(style, &theme) })
            .collect(),
    };
    FormattingResult { cells, styles }
}

/// Apply formatting to a range of cells on multiple non-active sheets.
/// Used for sheet grouping: when the user has multiple sheets selected,
/// formatting applied on the active sheet is replicated to grouped sheets.
/// The ACTIVE sheet is never this command's (`apply_formatting` with
/// `sheet_indices` formats a whole group, active sheet included, as one step).
#[tauri::command]
pub fn apply_formatting_to_sheets(
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_indices: Vec<usize>,
    params: FormattingParams,
) -> Result<(), String> {
    apply_formatting_to_sheets_core(&state, &file_state, &sheet_indices, &params)
}

/// `apply_formatting_to_sheets` without the Tauri wrappers (tests). Every
/// listed sheet is gated before any is written, and all of them are ONE undo
/// step (it was one per sheet).
pub(crate) fn apply_formatting_to_sheets_core(
    state: &AppState,
    file_state: &FileState,
    sheet_indices: &[usize],
    params: &FormattingParams,
) -> Result<(), String> {
    // Same regional presets and the same refusals as apply_formatting -- a
    // group format must not resolve dates differently from a single sheet's.
    let parsed = {
        let locale = state.locale.lock().unwrap();
        ParsedFormatting::parse(params, &locale)?
    };
    let route = StyleTargets::Sheets { group: sheet_indices, include_active: false };
    format_cells_on_sheets(state, file_state, &parsed, &params.rows, &params.cols, route).map(|_| ())
}

/// Preview a custom number format string against a sample value.
/// Used by the Format Cells dialog for live preview.
#[tauri::command]
pub fn preview_number_format(state: State<AppState>, format_string: String, sample_value: f64) -> PreviewResult {
    let locale = state.locale.lock().unwrap();
    let nf = NumberFormat::Custom { format: format_string };
    let style = CellStyle::new().with_number_format(nf);
    let result = format_cell_value_with_color(&CellValue::Number(sample_value), &style, &locale);
    PreviewResult {
        display: result.text,
        color: result.color,
    }
}

// ============================================================================
// Home > Number dropdown (Excel's ribbon Number-format gallery)
// ============================================================================

/// Excel's Home > Number dropdown, in Excel's order.
///
/// These are the ONLY vocabulary the ribbon sends. They are preset KEYWORDS,
/// not format codes, because the six regional ones cannot be written down
/// without knowing the region -- Excel's Short Date / Long Date / Time entries
/// are `[$-x-sysdate]` / `[$-x-systime]` handles and its Currency / Accounting
/// entries read the OS currency pattern. Shipping `m/d/yyyy` or `$` from the
/// frontend would be BUG-0064 again (the Format Cells dialog advertising
/// "1,234.00" on a document that renders "1 234,00").
///
/// `Special` and `Custom` are deliberately absent: they are Format Cells
/// categories, not dropdown entries. The dropdown's twelfth row is
/// "More Number Formats...", which opens that dialog and is UI, not a format.
pub(crate) const RIBBON_NUMBER_FORMAT_PRESETS: [&str; 11] = [
    "general",
    "number",
    "currency",
    "accounting",
    "date_short",
    "date_long",
    "time",
    "percentage",
    "fraction_1",
    "scientific",
    "text",
];

/// The Home tab's Number-group keywords that are NOT dropdown rows: Comma
/// Style and the six fixed-currency rows of the Accounting split button's menu
/// (CONTRACT section 3.7), in the menu's order. All seven resolve to the typed
/// `Accounting` format; only the SYMBOL and its side are fixed -- the negative
/// pattern is the region's (`LocaleSettings::accounting_negative_style`), as in
/// Excel, where "$ English (United States)" picked on a Swedish machine writes
/// the Swedish minus pattern with a `$`.
pub(crate) const HOME_ACCOUNTING_PRESETS: [&str; 7] = [
    "comma",
    "accounting_usd",
    "accounting_gbp",
    "accounting_eur_before",
    "accounting_eur_after",
    "accounting_cny",
    "accounting_chf",
];

/// One row of the ribbon Number dropdown, resolved for the current locale.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RibbonNumberFormatPreset {
    /// The preset keyword the ribbon sends back through `apply_formatting`.
    pub preset: String,
    /// What `get_style` will report for a cell carrying this preset, i.e. the
    /// output of `format_number_format_name`. The ribbon needs this to answer
    /// "which entry is the selected cell already on?" -- get_style speaks
    /// display names, the dropdown speaks presets, and inverting the mapping
    /// in TypeScript would be a second source of truth that drifts the first
    /// time a name changes here (exactly how BUG-0065 happened).
    pub display_name: String,
    /// The preset applied to `sample_value`, so the dropdown can show Excel's
    /// live sample without re-deriving any format string.
    pub sample: String,
}

/// Resolve Excel's Home > Number dropdown for the CURRENT locale.
///
/// Returns one row per entry, in Excel's order, carrying the keyword to send,
/// the display name `get_style` will report back, and a formatted sample of
/// `sample_value` (the active cell's value, the way Excel previews each row).
#[tauri::command]
pub fn get_ribbon_number_formats(
    state: State<AppState>,
    sample_value: Option<f64>,
) -> Vec<RibbonNumberFormatPreset> {
    let locale = state.locale.lock().unwrap();
    let sample = sample_value.unwrap_or(1234.5678);
    RIBBON_NUMBER_FORMAT_PRESETS
        .iter()
        .map(|preset| {
            let nf = parse_number_format_with_locale(preset, &locale);
            let style = CellStyle::new().with_number_format(nf.clone());
            RibbonNumberFormatPreset {
                preset: (*preset).to_string(),
                display_name: crate::api_types::format_number_format_name(&nf),
                sample: format_cell_value_with_color(&CellValue::Number(sample), &style, &locale)
                    .text,
            }
        })
        .collect()
}

/// Parse a number format string into a NumberFormat enum, using the INVARIANT
/// (en-US) locale for the presets whose meaning is regional.
///
/// Prefer `parse_number_format_with_locale` on any path that carries a locale.
/// The six regional presets -- `currency`, `accounting`, `date_short`,
/// `date_long`, `time`, and the legacy `date_iso`/`time_24h` family's
/// locale-free siblings -- resolve to US shapes here, which is right for the
/// pivot/format-code call sites (they already format against
/// `LocaleSettings::invariant()`) and wrong for anything a user picked.
pub(crate) fn parse_number_format(format: &str) -> NumberFormat {
    parse_number_format_with_locale(format, &engine::LocaleSettings::invariant())
}

/// Parse a number format string into a NumberFormat enum.
/// Recognizes known preset names (e.g., "general", "currency_usd") and treats
/// anything else containing format characters as a custom format string.
///
/// The RIBBON presets (`RIBBON_NUMBER_FORMAT_PRESETS`) are resolved against
/// `locale`, because that is what Excel does: its Short Date / Long Date / Time
/// entries write `[$-x-sysdate]` / `[$-x-systime]` -- handles meaning "ask the
/// OS" -- and its Currency / Accounting entries take the symbol AND its side
/// from the regional currency pattern, not from the language. Sending a
/// hard-coded `m/d/yyyy` or `$` would render a Swedish workbook in US shapes.
pub(crate) fn parse_number_format_with_locale(
    format: &str,
    locale: &engine::LocaleSettings,
) -> NumberFormat {
    // Excel's Currency category is TWO choices -- a symbol and a "Negative
    // numbers:" entry -- and the dialog composes them into one preset id
    // (`currency_usd` + `_neg_paren`). Splitting the suffix here rather than
    // writing four arms per symbol keeps the count at one arm per symbol and
    // means a currency preset added later inherits all four entries for free.
    let (format, negative_style) = split_negative_suffix(format);
    let locale_currency_position = match locale.currency_position {
        engine::LocaleCurrencyPosition::Before => CurrencyPosition::Before,
        engine::LocaleCurrencyPosition::After => CurrencyPosition::After,
    };
    let parsed = parse_number_format_base(format, locale, locale_currency_position);
    // ONLY A REAL SUFFIX OVERWRITES. `split_negative_suffix` answers `Minus`
    // both for "the user picked Excel's first entry" and for "this string
    // carries no suffix at all", and the second case includes every DISPLAY
    // NAME -- `Currency ($, 2 decimals, red negatives)` has no `_neg_red` on
    // it. Applying the answer unconditionally therefore threw away the style
    // `try_parse_display_name` had just read correctly, and a red-negative cell
    // reset itself to the default on an untouched OK. The suffix also only
    // means anything on a Currency; Accounting has no choice to make.
    match (parsed, negative_style) {
        (NumberFormat::Currency { decimal_places, symbol, symbol_position, .. }, style)
            if style != NegativeStyle::Minus =>
        {
            NumberFormat::Currency {
                decimal_places,
                symbol,
                symbol_position,
                negative_style: style,
            }
        }
        (other, _) => other,
    }
}

/// The suffix the Format Cells dialog appends to a currency preset id to name
/// one of Excel's four "Negative numbers:" entries. `NegativeStyle::Minus` --
/// Excel's default and the meaning of a bare `$#,##0.00` -- has no suffix, so
/// every existing preset id keeps its exact spelling and its exact meaning.
pub(crate) const NEGATIVE_STYLE_SUFFIXES: [(&str, NegativeStyle); 3] = [
    // Longest first: `_neg_red_paren` also ends with `_neg_paren`'s letters
    // only if tested loosely, and `_neg_red` is a prefix of it. Ordering the
    // table by length makes the first match the right one.
    ("_neg_red_paren", NegativeStyle::RedParentheses),
    ("_neg_paren", NegativeStyle::Parentheses),
    ("_neg_red", NegativeStyle::Red),
];

fn split_negative_suffix(format: &str) -> (&str, NegativeStyle) {
    for (suffix, style) in NEGATIVE_STYLE_SUFFIXES {
        if let Some(base) = format.strip_suffix(suffix) {
            return (base, style);
        }
    }
    (format, NegativeStyle::Minus)
}

fn parse_number_format_base(
    format: &str,
    locale: &engine::LocaleSettings,
    locale_currency_position: CurrencyPosition,
) -> NumberFormat {
    // Every ACCOUNTING keyword freezes the REGION's negative pattern into the
    // format, the way Excel writes the region's accounting code (survey defect
    // B): parentheses in en-US, a leading minus everywhere else.
    let accounting = |decimal_places: u8, symbol: &str, symbol_position: CurrencyPosition| {
        NumberFormat::Accounting {
            decimal_places,
            symbol: symbol.to_string(),
            symbol_position,
            negative_style: locale.accounting_negative_style(),
        }
    };
    match format.to_lowercase().as_str() {
        "general" => NumberFormat::General,
        // ---- Excel's Home > Number dropdown, the regional half ----
        "currency" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: locale.currency_symbol.clone(),
            symbol_position: locale_currency_position,
            negative_style: NegativeStyle::Minus,
        },
        "accounting" => accounting(2, locale.currency_symbol.trim(), locale_currency_position),
        // ---- Excel's Home > Number group, outside the dropdown ----
        // Comma Style is Excel's "Comma" cell style: ACCOUNTING with NO symbol
        // and 2 decimals (sv-SE `_-* # ##0,00_-;-* # ##0,00_-;_-* "-"??_-;_-@_-`,
        // measured live). The ribbon used to send `#,##0`, which rounded away
        // the decimals and showed zero as "0" instead of a dash.
        "comma" => accounting(2, "", CurrencyPosition::Before),
        // The Accounting split button's menu rows (CONTRACT section 3.7).
        // `accounting_usd` is below with the dialog's fixed-currency presets.
        "accounting_gbp" => accounting(2, "\u{00A3}", CurrencyPosition::Before),
        "accounting_eur_before" => accounting(2, "\u{20AC}", CurrencyPosition::Before),
        "accounting_eur_after" => accounting(2, "\u{20AC}", CurrencyPosition::After),
        "accounting_cny" => accounting(2, "\u{00A5}", CurrencyPosition::Before),
        "accounting_chf" => accounting(2, "CHF", CurrencyPosition::Before),
        "date_short" => NumberFormat::Date {
            format: locale.date_format.clone(),
        },
        "date_long" => NumberFormat::Date {
            format: locale.long_date_format.clone(),
        },
        "time" => NumberFormat::Time {
            format: locale.time_format.clone(),
        },
        // Excel's Text entry is the one-section format `@`: the value is shown
        // exactly as typed and is not evaluated as a number.
        "text" => NumberFormat::Custom {
            format: "@".to_string(),
        },
        "number" => NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: false,
        },
        "number_sep" => NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: true,
        },
        "currency_usd" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "$".to_string(),
            symbol_position: CurrencyPosition::Before,
            negative_style: NegativeStyle::Minus,
        },
        "currency_eur" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "EUR".to_string(),
            symbol_position: CurrencyPosition::Before,
            negative_style: NegativeStyle::Minus,
        },
        "currency_sek" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "kr".to_string(),
            symbol_position: CurrencyPosition::After,
            negative_style: NegativeStyle::Minus,
        },
        "accounting_usd" => accounting(2, "$", CurrencyPosition::Before),
        "accounting_usd_0" => accounting(0, "$", CurrencyPosition::Before),
        "accounting_eur" => accounting(2, "EUR", CurrencyPosition::Before),
        "accounting_sek" => accounting(2, "kr", CurrencyPosition::After),
        "fraction_1" => NumberFormat::Fraction { denominator: None, max_digits: 1 },
        "fraction_2" => NumberFormat::Fraction { denominator: None, max_digits: 2 },
        "fraction_3" => NumberFormat::Fraction { denominator: None, max_digits: 3 },
        "fraction_halves" => NumberFormat::Fraction { denominator: Some(2), max_digits: 1 },
        "fraction_quarters" => NumberFormat::Fraction { denominator: Some(4), max_digits: 1 },
        "fraction_eighths" => NumberFormat::Fraction { denominator: Some(8), max_digits: 1 },
        "fraction_sixteenths" => NumberFormat::Fraction { denominator: Some(16), max_digits: 2 },
        "fraction_tenths" => NumberFormat::Fraction { denominator: Some(10), max_digits: 1 },
        "fraction_hundredths" => NumberFormat::Fraction { denominator: Some(100), max_digits: 2 },
        "percentage" => NumberFormat::Percentage { decimal_places: 2 },
        "scientific" => NumberFormat::Scientific { decimal_places: 2 },
        "date_iso" => NumberFormat::Date {
            format: "yyyy-mm-dd".to_string(),
        },
        "date_us" => NumberFormat::Date {
            format: "mm/dd/yyyy".to_string(),
        },
        "date_eu" => NumberFormat::Date {
            format: "dd/mm/yyyy".to_string(),
        },
        "time_24h" => NumberFormat::Time {
            format: "hh:mm:ss".to_string(),
        },
        "time_12h" => NumberFormat::Time {
            format: "hh:mm:ss AM/PM".to_string(),
        },
        _ => {
            // BUG-0065: accept everything format_number_format_name() emits
            // (api_types.rs) BEFORE guessing. get_style hands the frontend
            // display names like "Number (2 decimals, with separators)" or
            // "Date (yyyy-mm-dd)"; the Format Cells dialog sends the loaded
            // string straight back on OK, so a parser that cannot read its own
            // serializer's output silently RESET the format to General (the
            // name carries no format characters) or, worse, degraded it to a
            // garbage Custom format ("Date (yyyy-mm-dd)" rendered
            // "15ate (2023-03-15)" -- the leading D consumed as a day token).
            // Same rationale and precedent as parse_text_rotation below: the
            // full vocabulary the app itself emits must round-trip here.
            if let Some(named) = try_parse_display_name(format) {
                named
            } else if let Some(recognized) = try_parse_format_code(format) {
                // Try to recognize common Excel-style format codes before
                // falling through to the custom format engine (which has known
                // issues with large numbers).
                recognized
            } else if is_custom_format_string(format) {
                NumberFormat::Custom {
                    format: format.to_string(),
                }
            } else {
                NumberFormat::General
            }
        }
    }
}

/// Inverse of `format_number_format_name` (api_types.rs): parses the display
/// names that `get_style` emits back into the typed `NumberFormat`, so a
/// read-modify-write through the style API is lossless. Returns None for
/// anything that is not one of the serializer's shapes.
///
/// Two fields are not present in the names and are reconstructed:
/// - Currency/Accounting `symbol_position`: "kr" is the only suffix currency
///   the app emits, so it maps to After and everything else to Before --
///   matching every preset above.
/// - Fixed-fraction `max_digits`: reconstructed from the preset table
///   (2/4/8/10 -> 1, 16/100 -> 2), falling back to the denominator's digit
///   count; the engine ignores it when the denominator is fixed.
/// Split a format code into its positive and negative sections, on the first
/// semicolon that is not inside quotes. `None` when the code has no negative
/// section (the overwhelmingly common case) or has THREE or more, which is a
/// zero/text-section code no preset writes and that belongs in `Custom`.
fn split_first_format_section(code: &str) -> Option<(&str, &str)> {
    let mut in_quotes = false;
    let mut first: Option<usize> = None;
    for (i, ch) in code.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ';' if !in_quotes => {
                if first.is_some() {
                    return None; // three sections or more
                }
                first = Some(i);
            }
            _ => {}
        }
    }
    first.map(|i| (&code[..i], &code[i + 1..]))
}

/// Which of Excel's "Negative numbers:" entries a NEGATIVE SECTION spells.
/// Deliberately reads only the section it is handed: `[Red]` on the POSITIVE
/// section means a red positive, which is a different format entirely.
fn negative_style_of_section(section: &str) -> NegativeStyle {
    let red = section.to_ascii_lowercase().contains("[red]");
    let parens = section.contains('(') && section.contains(')');
    // A MINUS IN THE NEGATIVE SECTION MEANS THE SIGN IS SHOWN, and Excel's
    // `Red` entry shows NO sign -- its code is `$#,##0.00;[Red]$#,##0.00`, the
    // sign deliberately absent. `…;[Red]-$#,##0.00` is therefore a red MINUS,
    // which no structured style can express; classifying it as `Red` would
    // render -1234.5 as `$1,234.50`, indistinguishable from the positive in
    // copy, CSV and print, none of which carry colour -- and the writer would
    // then delete the user's minus from the exported file. Kept as the
    // leading-minus style, which renders the sign; the caller falls back to
    // `Custom` for anything it cannot classify.
    let signed = section.contains('-');
    match (red, parens, signed) {
        (true, true, _) => NegativeStyle::RedParentheses,
        (true, false, false) => NegativeStyle::Red,
        (false, true, _) => NegativeStyle::Parentheses,
        _ => NegativeStyle::Minus,
    }
}

/// Split `NegativeStyle::display_suffix` off the tail of a Currency display
/// name's inner text. The inverse of what `format_number_format_name` appends.
fn split_negative_display_suffix(rest: &str) -> (&str, NegativeStyle) {
    // Longest first: ", red parenthesised negatives" also ends with
    // ", parenthesised negatives"'s letters, so a shorter probe would win and
    // lose the colour.
    for style in [
        NegativeStyle::RedParentheses,
        NegativeStyle::Parentheses,
        NegativeStyle::Red,
    ] {
        if let Some(head) = rest.strip_suffix(style.display_suffix()) {
            return (head, style);
        }
    }
    (rest, NegativeStyle::Minus)
}

pub(crate) fn try_parse_display_name(format: &str) -> Option<NumberFormat> {
    let s = format.trim();
    let inner = |prefix: &str| -> Option<&str> {
        s.strip_prefix(prefix)?.strip_suffix(')')
    };

    let parse_decimals = |text: &str| -> Option<u8> {
        text.trim().strip_suffix(" decimals")?.trim().parse::<u8>().ok()
    };

    if let Some(rest) = inner("Number (") {
        let (dec_part, with_sep) = match rest.strip_suffix(", with separators") {
            Some(d) => (d, true),
            None => (rest, false),
        };
        return Some(NumberFormat::Number {
            decimal_places: parse_decimals(dec_part)?,
            use_thousands_separator: with_sep,
        });
    }

    // "Currency ($, 2 decimals)" / "Accounting (kr, 2 decimals, symbol after)"
    // -- the decimals clause never contains ", ", so split at the LAST
    // occurrence and the symbol keeps any commas of its own.
    //
    // THE POSITION IS READ, NOT GUESSED. This used to reconstruct it from the
    // symbol TEXT -- `symbol.trim() == "kr"` meant After and everything else
    // meant Before -- and the comment above justified that by observing `kr`
    // was the only suffix currency the app could emit. Reading the user's
    // Windows regional settings (open-items 1.3) ends that premise: a Polish
    // `zl`, a Hungarian `Ft` or a Czech `Kc` with `LOCALE_ICURRENCY = 3` is a
    // suffix currency too, and under the old rule the symbol jumped to the
    // wrong side of the number the first time the user pressed OK on a dialog
    // they had not touched.
    let parse_money = |rest: &str| -> Option<(String, u8, CurrencyPosition)> {
        let (rest, position) = match rest.strip_suffix(", symbol after") {
            Some(head) => (head, CurrencyPosition::After),
            None => (rest, CurrencyPosition::Before),
        };
        let (symbol, dec_part) = rest.rsplit_once(", ")?;
        let decimals = parse_decimals(dec_part)?;
        Some((symbol.to_string(), decimals, position))
    };
    if let Some(rest) = inner("Currency (") {
        // Strip the negative clause FIRST: it is the only part of a currency
        // name that may follow the decimals clause, and `parse_money` splits on
        // the LAST ", " -- left in place, ", parenthesised negatives" would be
        // taken for the decimals clause and the whole name would fail to parse,
        // silently corrupting the cell's format on an untouched OK.
        let (rest, negative_style) = split_negative_display_suffix(rest);
        let (symbol, decimal_places, symbol_position) = parse_money(rest)?;
        return Some(NumberFormat::Currency {
            decimal_places,
            symbol,
            symbol_position,
            negative_style,
        });
    }
    if let Some(rest) = inner("Accounting (") {
        // The negative clause FIRST, for the same reason as Currency's: it
        // follows the decimals clause and `parse_money` splits on the last
        // ", ". An Accounting name carries it since the negative pattern became
        // part of the format ("..., parenthesised negatives" for en-US).
        let (rest, negative_style) = split_negative_display_suffix(rest);
        let (symbol, decimal_places, symbol_position) = parse_money(rest)?;
        return Some(NumberFormat::Accounting {
            decimal_places,
            symbol,
            symbol_position,
            negative_style,
        });
    }

    if let Some(rest) = inner("Percentage (") {
        return Some(NumberFormat::Percentage { decimal_places: parse_decimals(rest)? });
    }
    if let Some(rest) = inner("Scientific (") {
        return Some(NumberFormat::Scientific { decimal_places: parse_decimals(rest)? });
    }

    if let Some(rest) = inner("Fraction (") {
        if let Some(digits) = rest.strip_prefix("up to ").and_then(|r| r.strip_suffix(" digits")) {
            return Some(NumberFormat::Fraction {
                denominator: None,
                max_digits: digits.trim().parse::<u8>().ok()?,
            });
        }
        if let Some(denom) = rest.strip_prefix('/').and_then(|r| r.strip_suffix(" fixed")) {
            let d: u32 = denom.trim().parse().ok()?;
            let max_digits = match d {
                2 | 4 | 8 | 10 => 1,
                16 | 100 => 2,
                other => other.to_string().len() as u8,
            };
            return Some(NumberFormat::Fraction { denominator: Some(d), max_digits });
        }
        return None;
    }

    if let Some(rest) = inner("Date (") {
        return Some(NumberFormat::Date { format: rest.to_string() });
    }
    if let Some(rest) = inner("Time (") {
        return Some(NumberFormat::Time { format: rest.to_string() });
    }

    None
}

/// Attempts to parse a format code string (e.g., "0.00", "#,##0", "$#,##0.00")
/// into a typed NumberFormat variant. Returns None if the format is not
/// a recognized pattern, in which case the caller should fall back to Custom.
fn try_parse_format_code(format: &str) -> Option<NumberFormat> {
    let trimmed = format.trim();

    // A CURRENCY CODE WITH A NEGATIVE SECTION IS STILL A CURRENCY.
    // Excel's three non-default "Negative numbers:" entries write two-section
    // codes (`$#,##0.00;($#,##0.00)`), and before this arm the semicolon made
    // the whole thing unparseable, so the dialog reopened the user's own
    // Currency choice as `Custom` with a raw code in a text box. Recognised
    // here rather than in each shape below because the positive section is the
    // ONLY part that carries symbol and decimals -- the negative section is a
    // rendering, and `negative_style_of_section` is the whole of what it means.
    if let Some((positive, negative)) = split_first_format_section(trimmed) {
        if let Some(NumberFormat::Currency { decimal_places, symbol, symbol_position, .. }) =
            try_parse_format_code(positive)
        {
            return Some(NumberFormat::Currency {
                decimal_places,
                symbol,
                symbol_position,
                negative_style: negative_style_of_section(negative),
            });
        }
        return None;
    }

    // Percentage formats: "0%", "0.0%", "0.00%", etc.
    if trimmed.ends_with('%') {
        let before_pct = &trimmed[..trimmed.len() - 1];
        if let Some(decimals) = count_decimal_places(before_pct) {
            return Some(NumberFormat::Percentage {
                decimal_places: decimals,
            });
        }
    }

    // Currency formats with $ prefix: "$#,##0", "$#,##0.00", etc.
    if trimmed.starts_with('$') {
        let after_symbol = &trimmed[1..];
        if let Some((decimals, _has_sep)) = parse_number_pattern(after_symbol) {
            return Some(NumberFormat::Currency {
                decimal_places: decimals,
                symbol: "$".to_string(),
                symbol_position: CurrencyPosition::Before,
                // A one-section code IS Excel's default entry.
                negative_style: NegativeStyle::Minus,
            });
        }
    }

    // Currency formats with a [$SYMBOL] or [$SYMBOL-LOCALE] prefix:
    // "[$EUR] #,##0.00", "[$£-809]#,##0.00", "[$€-2] #,##0.00".
    if let Some(currency) = try_parse_bracket_currency(trimmed) {
        return Some(currency);
    }

    // Plain number formats: "0", "0.00", "#,##0", "#,##0.00", etc.
    if let Some((decimals, has_separator)) = parse_number_pattern(trimmed) {
        return Some(NumberFormat::Number {
            decimal_places: decimals,
            use_thousands_separator: has_separator,
        });
    }

    None
}

/// A `[$SYMBOL-LOCALE]` currency prefix followed by a plain number pattern.
///
/// THE LOCALE TAG IS NOT PART OF THE SYMBOL (survey defect D). Excel's
/// `[$£-809]#,##0.00` is "the symbol £, locale 0x809"; Excel 365 also writes
/// the tag as a name (`[$$-en-US]`). The symbol is everything before the FIRST
/// '-', and the tag after it is dropped -- this used to keep the whole bracket
/// body, so the cell rendered "£-809 1,234.50" instead of "£1,234.50".
///
/// THE SPACE IS THE CODE'S, NOT OURS. Measured live: `[$£-809]#,##0.00` shows
/// "£1 234,50" (no space) and `[$€-2] #,##0.00` shows "€ 1 234,50" (the code's
/// own space). This used to add a space after every bracketed symbol.
///
/// A bracket with NO symbol (`[$-409]0.00`, a locale tag alone) is not a
/// currency: `None`, so the caller keeps looking.
fn try_parse_bracket_currency(trimmed: &str) -> Option<NumberFormat> {
    let body_start = trimmed.strip_prefix("[$")?;
    let bracket_end = body_start.find(']')?;
    let body = &body_start[..bracket_end];
    let symbol = body.split('-').next().unwrap_or("").trim();
    if symbol.is_empty() {
        return None;
    }
    let after = &body_start[bracket_end + 1..];
    let (decimals, _has_sep) = parse_number_pattern(after.trim())?;
    let gap = after.starts_with(char::is_whitespace);
    Some(NumberFormat::Currency {
        decimal_places: decimals,
        symbol: if gap { format!("{} ", symbol) } else { symbol.to_string() },
        symbol_position: CurrencyPosition::Before,
        negative_style: NegativeStyle::Minus,
    })
}

/// Parses a number pattern like "0", "0.00", "#,##0", "#,##0.00" and returns
/// (decimal_places, has_thousands_separator). Returns None if the pattern
/// doesn't match a pure number format.
fn parse_number_pattern(s: &str) -> Option<(u8, bool)> {
    // Must only contain: 0, #, comma, period
    if s.is_empty() || !s.chars().all(|c| c == '0' || c == '#' || c == ',' || c == '.') {
        return None;
    }

    let has_separator = s.contains(',');
    let decimals = if let Some(dot_pos) = s.find('.') {
        let frac = &s[dot_pos + 1..];
        // All fraction chars should be '0' (fixed-place digits)
        if frac.chars().all(|c| c == '0') {
            frac.len() as u8
        } else {
            return None;
        }
    } else {
        0
    };

    Some((decimals, has_separator))
}

/// Counts the number of decimal places in a simple numeric format like "0",
/// "0.0", "0.00". Returns None if the format is not a simple numeric pattern.
fn count_decimal_places(s: &str) -> Option<u8> {
    // For percentage patterns, just delegate to parse_number_pattern
    parse_number_pattern(s).map(|(decimals, _)| decimals)
}

/// Check if a string looks like a custom number format string.
fn is_custom_format_string(s: &str) -> bool {
    s.contains('0')
        || s.contains('#')
        || s.contains('?')
        || s.contains('@')
        || s.contains(';')
        || s.starts_with('[')
        || s.contains("yy")
        || s.contains("mm")
        || s.contains("dd")
        || s.contains("hh")
        || s.contains("ss")
}

/// Parse a text rotation string into the engine's TextRotation.
///
/// The FULL vocabulary the app itself emits round-trips here:
/// - `StyleData::from_cell_style` (api_types.rs) emits "none" | "rotate90" |
///   "rotate270" | "vertical" | "custom:N", and the FormatCells dialog + script
///   surface send those same strings back -- "rotate90"/"rotate270"/"custom:N"
///   used to fall through to the integer parser, fail, and silently apply None.
/// - "vertical" is STACKED text (Excel's Vertical Text, OOXML 255).
/// - Bare integer degrees ("45", "-30") and the legacy aliases
///   ("0"/"90"/"270"/"-90"/"up"/"down") are accepted too; angles clamp to
///   -90..90, and a clamped 0/90/-90 collapses to the named variant so the
///   emitted form stays canonical.
///
/// ANYTHING ELSE IS AN ERROR. An unrecognised value used to become `None`,
/// which is not "ignore the request" but "CLEAR the rotation": sending
/// "vertical" before this variant existed, or a typo from a script, silently
/// flattened every selected cell. The caller turns the error into a refusal
/// before anything is written (`ParsedFormatting::parse`).
fn parse_text_rotation(rotation: &str) -> Result<TextRotation, String> {
    let lower = rotation.trim().to_lowercase();
    match lower.as_str() {
        "none" | "0" => Ok(TextRotation::None),
        "rotate90" | "90" | "up" => Ok(TextRotation::Rotate90),
        "rotate270" | "270" | "-90" | "down" => Ok(TextRotation::Rotate270),
        "vertical" => Ok(TextRotation::Vertical),
        _ => {
            let angle_str = lower.strip_prefix("custom:").unwrap_or(&lower).trim();
            match angle_str.parse::<i16>() {
                Ok(angle) => Ok(match angle.clamp(-90, 90) {
                    0 => TextRotation::None,
                    90 => TextRotation::Rotate90,
                    -90 => TextRotation::Rotate270,
                    other => TextRotation::Custom(other),
                }),
                Err(_) => Err(format!(
                    "Unknown text rotation \"{}\": expected none, rotate90, rotate270, \
                     vertical or custom:N with N between -90 and 90.",
                    rotation
                )),
            }
        }
    }
}

/// Parse a border side parameter into a BorderStyle.
fn parse_border_side(param: &crate::api_types::BorderSideParam) -> BorderStyle {
    let line_style = match param.style.as_str() {
        "none" => BorderLineStyle::None,
        "thin" | "medium" | "thick" => BorderLineStyle::Solid,
        "dashed" => BorderLineStyle::Dashed,
        "dotted" => BorderLineStyle::Dotted,
        "double" => BorderLineStyle::Double,
        _ => BorderLineStyle::None,
    };
    let width: u8 = match param.style.as_str() {
        "none" => 0,
        "thin" => 1,
        "medium" => 2,
        "thick" => 3,
        "dashed" | "dotted" | "double" => 1,
        _ => 0,
    };
    let color = ThemeColor::Absolute(Color::from_hex(&param.color).unwrap_or(Color::new(0, 0, 0)));

    BorderStyle {
        width,
        color,
        style: line_style,
    }
}

/// Parse a FillParam into a Fill enum.
fn parse_fill_param(param: &FillParam) -> Fill {
    match param {
        FillParam::None => Fill::None,
        FillParam::Solid { color, color_theme, color_tint } => {
            let theme_color = parse_theme_or_absolute(color, color_theme.as_deref(), *color_tint);
            Fill::Solid { color: theme_color }
        }
        FillParam::Pattern {
            pattern_type, fg_color, bg_color,
            fg_color_theme, fg_color_tint,
            bg_color_theme, bg_color_tint,
        } => {
            Fill::Pattern {
                pattern_type: parse_pattern_type(pattern_type),
                fg_color: parse_theme_or_absolute(fg_color, fg_color_theme.as_deref(), *fg_color_tint),
                bg_color: parse_theme_or_absolute(bg_color, bg_color_theme.as_deref(), *bg_color_tint),
            }
        }
        FillParam::Gradient {
            color1, color2, direction,
            color1_theme, color1_tint,
            color2_theme, color2_tint,
        } => {
            Fill::Gradient {
                color1: parse_theme_or_absolute(color1, color1_theme.as_deref(), *color1_tint),
                color2: parse_theme_or_absolute(color2, color2_theme.as_deref(), *color2_tint),
                direction: parse_gradient_direction(direction),
            }
        }
    }
}

/// Parse a color string with optional theme slot and tint into a ThemeColor.
fn parse_theme_or_absolute(hex: &str, theme_key: Option<&str>, tint: Option<i16>) -> ThemeColor {
    if let Some(key) = theme_key {
        if let Some(slot) = engine::ThemeColorSlot::from_key(key) {
            return ThemeColor::Theme {
                slot,
                tint: engine::Tint(tint.unwrap_or(0)),
            };
        }
    }
    ThemeColor::Absolute(Color::from_hex(hex).unwrap_or(Color::white()))
}

fn parse_pattern_type(s: &str) -> PatternType {
    match s {
        "solid" => PatternType::Solid,
        "darkGray" => PatternType::DarkGray,
        "mediumGray" => PatternType::MediumGray,
        "lightGray" => PatternType::LightGray,
        "gray125" => PatternType::Gray125,
        "gray0625" => PatternType::Gray0625,
        "darkHorizontal" => PatternType::DarkHorizontal,
        "darkVertical" => PatternType::DarkVertical,
        "darkDown" => PatternType::DarkDown,
        "darkUp" => PatternType::DarkUp,
        "darkGrid" => PatternType::DarkGrid,
        "darkTrellis" => PatternType::DarkTrellis,
        "lightHorizontal" => PatternType::LightHorizontal,
        "lightVertical" => PatternType::LightVertical,
        "lightDown" => PatternType::LightDown,
        "lightUp" => PatternType::LightUp,
        "lightGrid" => PatternType::LightGrid,
        "lightTrellis" => PatternType::LightTrellis,
        _ => PatternType::None,
    }
}

fn parse_gradient_direction(s: &str) -> GradientDirection {
    match s {
        "horizontal" => GradientDirection::Horizontal,
        "vertical" => GradientDirection::Vertical,
        "diagonalDown" => GradientDirection::DiagonalDown,
        "diagonalUp" => GradientDirection::DiagonalUp,
        "fromCenter" => GradientDirection::FromCenter,
        _ => GradientDirection::Horizontal,
    }
}

/// Get the total number of styles.
#[tauri::command]
pub fn get_style_count(state: State<AppState>) -> usize {
    let styles = state.style_registry.read().unwrap();
    styles.len()
}

/// Set rich text runs on a cell.
/// Replaces any existing rich text. Pass null/empty to clear rich text.
///
/// Returns Result (it used to return a bare Option) so a protection refusal
/// can reach the user instead of silently writing through the gate.
///
/// `target` (P3): the cell is a floating grid's cell -- written on its backing
/// sheet ONLY, inside the extent, gated by the HOST's protection.
#[tauri::command]
pub fn set_cell_rich_text(
    state: State<AppState>,
    file_state: State<FileState>,
    row: u32,
    col: u32,
    runs: Option<Vec<crate::api_types::RichTextRunData>>,
    target: Option<CellTargetRef>,
) -> Result<Option<CellData>, String> {
    set_cell_rich_text_core(&state, &file_state, row, col, runs, target.as_ref())
}

/// `set_cell_rich_text` without the Tauri wrappers (tests drive the real body).
pub(crate) fn set_cell_rich_text_core(
    state: &AppState,
    file_state: &FileState,
    row: u32,
    col: u32,
    runs: Option<Vec<crate::api_types::RichTextRunData>>,
    target: Option<&CellTargetRef>,
) -> Result<Option<CellData>, String> {
    // A cell target resolves, holding nothing, before any guard below.
    let resolved = match target {
        Some(target) => {
            let t = crate::cell_target::resolve_cell_target(state, target)?;
            crate::cell_target::ensure_in_extent(&t, row, col, row, col)?;
            Some(t)
        }
        None => None,
    };
    // Sheet protection, before any lock below. Rich text is cell CONTENT: for
    // a cell target, the HOST's protection over the backing cell's lock flag.
    match &resolved {
        Some(t) => crate::cell_target::gate_target_cells(
            state,
            t,
            (row, col, row, col),
            crate::cell_target::EDIT_CELLS,
            "edit a floating grid's cells",
        )?,
        None => {
            let active_sheet = *state.active_sheet.read().unwrap();
            crate::protection::check_sheet_protection_range(state, active_sheet, row, col, row, col)?;
        }
    }

    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    // The sheet written: the active sheet, or the target's backing sheet --
    // re-checked under the held grid guards (`sheet_ids` after `grids`).
    let sheet = match &resolved {
        Some(t) => {
            crate::cell_target::ensure_target_still_at(state, t)?;
            t.backing_index
        }
        None => active_sheet,
    };
    if sheet != active_sheet && sheet >= grids.len() {
        return Err("Floating range backing sheet is missing".to_string());
    }

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let styles = state.style_registry.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merges = report_merges(state, sheet, active_sheet);
    let locale = state.locale.lock().unwrap();

    // The grid written, and the active sheet's second copy when it is the one.
    let (sheet_grid, mirror): (&mut engine::Grid, Option<&mut engine::Grid>) = if sheet == active_sheet {
        (&mut *grid, grids.get_mut(active_sheet))
    } else {
        (&mut grids[sheet], None)
    };

    // Record undo, against the sheet the cell is on.
    let previous = sheet_grid.get_cell(row, col).cloned();
    undo_stack.record_cell_change(sheet, row, col, previous);

    // Get or create the cell, update rich_text
    let engine_runs = runs.as_ref().map(|r| crate::api_types::data_to_rich_text_runs(r));
    let mut cell = sheet_grid.get_cell(row, col).cloned().unwrap_or_else(Cell::new);
    cell.rich_text = engine_runs;
    sheet_grid.set_cell(row, col, cell.clone());

    // Sync to the active sheet's grids-vector copy
    if let Some(m) = mirror {
        m.set_cell(row, col, cell);
    }

    // Build response
    let Some(cell) = sheet_grid.get_cell(row, col) else {
        return Ok(None);
    };
    let effective_style_index = sheet_grid.effective_style_index(row, col);
    let style = styles.get(effective_style_index);
    let result = format_cell_value_with_color(&cell.value, style, &locale);
    let accounting_layout = result.accounting.map(|a| crate::api_types::AccountingLayout {
        symbol: a.symbol,
        symbol_before: a.symbol_before,
        value: a.value,
    });
    let (row_span, col_span) = match merges
        .iter()
        .find(|m| m.start_row == row && m.start_col == col)
    {
        Some(m) => (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1),
        None => (1, 1),
    };

    Ok(Some(CellData {
        row,
        col,
        display: result.text, overflow: result.overflow,
        display_color: result.color,
        formula: cell.formula_string().map(|f| format!("={}", f)),
        style_index: effective_style_index,
        row_span,
        col_span,
        sheet_index: None,
        rich_text: cell.rich_text.as_ref().map(|r| crate::api_types::rich_text_runs_to_data(r)),
        accounting_layout,
    }))
}

// ============================================================================
// Border presets (Home > Font > Borders, Format Cells > Border, scripts)
// ============================================================================

/// The six range-aware presets `apply_border_preset` understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BorderPreset {
    /// Horizontal lines between rows (not on the outer edges).
    InsideHorizontal,
    /// Vertical lines between columns (not on the outer edges).
    InsideVertical,
    /// Both inside directions.
    InsideBoth,
    /// The rectangle's outline only.
    Outside,
    /// Every edge of every cell.
    AllBorders,
    /// Clear every side, diagonals included.
    NoBorder,
}

impl BorderPreset {
    fn parse(preset: &str) -> Result<Self, String> {
        match preset {
            "insideHorizontal" => Ok(BorderPreset::InsideHorizontal),
            "insideVertical" => Ok(BorderPreset::InsideVertical),
            "insideBoth" => Ok(BorderPreset::InsideBoth),
            "outside" => Ok(BorderPreset::Outside),
            "allBorders" => Ok(BorderPreset::AllBorders),
            "none" => Ok(BorderPreset::NoBorder),
            other => Err(format!("Unknown border preset: {}", other)),
        }
    }
}

/// Which of a rectangle's four EDGES a cell lies on. A border preset is a
/// function of nothing else, which is what lets a whole column's worth of
/// interior cells share ONE tier style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
struct EdgePosition {
    top: bool,
    bottom: bool,
    left: bool,
    right: bool,
}

/// One preset with its line, applied cell by cell.
#[derive(Debug, Clone)]
struct BorderPresetDelta {
    preset: BorderPreset,
    line: BorderStyle,
}

impl BorderPresetDelta {
    /// `width` 0 (or the style word `none`) is NO LINE: the preset then
    /// REMOVES the sides it would draw, as the canonical empty side
    /// (`BorderStyle::default()`, what `none` writes). That is how Format
    /// Cells' Border tab turns an inside line OFF -- `insideHorizontal` with no
    /// line clears the bottom of every row but the last and the top of every
    /// row but the first, exactly the two sides of each inner boundary -- in
    /// ONE call through the tier planner (round-2 review revA#3). It used to
    /// send two almost-whole strips (rows 0..1048574 and 1..1048575 of a whole
    /// column) that walked a million cells per column, or were refused.
    fn new(preset: &str, style: &str, color: &str, width: u8) -> Result<Self, String> {
        let preset = BorderPreset::parse(preset)?;
        if width == 0 || style == "none" {
            return Ok(BorderPresetDelta { preset, line: BorderStyle::default() });
        }
        let line_style = match style {
            "solid" => BorderLineStyle::Solid,
            "dashed" => BorderLineStyle::Dashed,
            "dotted" => BorderLineStyle::Dotted,
            "double" => BorderLineStyle::Double,
            _ => BorderLineStyle::Solid,
        };
        let line = BorderStyle {
            width,
            color: ThemeColor::Absolute(Color::from_hex(color).unwrap_or(Color::new(0, 0, 0))),
            style: line_style,
        };
        Ok(BorderPresetDelta { preset, line })
    }

    /// Whether the preset reads the EDGE position at all. All Borders and No
    /// Border do the same to every cell, so the planner need not visit a
    /// whole-line selection's edge cells for them (`plan_range_style`).
    fn edges_matter(&self) -> bool {
        !matches!(self.preset, BorderPreset::AllBorders | BorderPreset::NoBorder)
    }

    fn apply(&self, style: &mut CellStyle, at: EdgePosition) {
        let line = &self.line;
        let borders = &mut style.borders;
        match self.preset {
            BorderPreset::InsideHorizontal => {
                if !at.bottom {
                    borders.bottom = line.clone();
                }
                if !at.top {
                    borders.top = line.clone();
                }
            }
            BorderPreset::InsideVertical => {
                if !at.right {
                    borders.right = line.clone();
                }
                if !at.left {
                    borders.left = line.clone();
                }
            }
            BorderPreset::InsideBoth => {
                if !at.bottom {
                    borders.bottom = line.clone();
                }
                if !at.top {
                    borders.top = line.clone();
                }
                if !at.right {
                    borders.right = line.clone();
                }
                if !at.left {
                    borders.left = line.clone();
                }
            }
            BorderPreset::Outside => {
                if at.top {
                    borders.top = line.clone();
                }
                if at.bottom {
                    borders.bottom = line.clone();
                }
                if at.left {
                    borders.left = line.clone();
                }
                if at.right {
                    borders.right = line.clone();
                }
            }
            BorderPreset::AllBorders => {
                borders.top = line.clone();
                borders.bottom = line.clone();
                borders.left = line.clone();
                borders.right = line.clone();
            }
            BorderPreset::NoBorder => {
                let none = BorderStyle::default();
                borders.top = none.clone();
                borders.bottom = none.clone();
                borders.left = none.clone();
                borders.right = none.clone();
                borders.diagonal_down = none.clone();
                borders.diagonal_up = none;
            }
        }
    }
}

/// An inclusive cell rectangle with its corners normalised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CellRect {
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
}

impl CellRect {
    fn new(start_row: u32, start_col: u32, end_row: u32, end_col: u32) -> Self {
        CellRect {
            start_row: start_row.min(end_row),
            start_col: start_col.min(end_col),
            end_row: start_row.max(end_row),
            end_col: start_col.max(end_col),
        }
    }

    /// Row and column counts in u64. `(end - start + 1)` as a `u32` PRODUCT
    /// overflowed on Select All (1,048,576 x 16,384 = 2^34) -- a panic in a
    /// debug build and a wrapped, meaningless count in release (survey D3).
    fn rows(&self) -> u64 {
        u64::from(self.end_row - self.start_row) + 1
    }

    fn cols(&self) -> u64 {
        u64::from(self.end_col - self.start_col) + 1
    }

    fn contains(&self, row: u32, col: u32) -> bool {
        row >= self.start_row && row <= self.end_row && col >= self.start_col && col <= self.end_col
    }

    fn position(&self, row: u32, col: u32) -> EdgePosition {
        EdgePosition {
            top: row == self.start_row,
            bottom: row == self.end_row,
            left: col == self.start_col,
            right: col == self.end_col,
        }
    }

    fn whole_columns(&self) -> bool {
        self.start_row == 0 && self.end_row >= engine::EXCEL_MAX_ROW_INDEX
    }

    fn whole_rows(&self) -> bool {
        self.start_col == 0 && self.end_col >= engine::EXCEL_MAX_COL_INDEX
    }

    /// The WHOLE-LINE extent `plan_range_style` writes this rectangle through:
    /// itself for whole rows, whole columns or Select All; the whole columns
    /// (or whole rows) it nearly fills for an ALMOST-whole rectangle; `None`
    /// for a rectangle styled cell by cell.
    ///
    /// ALMOST WHOLE (round-2 review revA#4). Click A2, Ctrl+Shift+Down: the
    /// selection is A2:A1048576, one row short of a whole column, and it was
    /// walked cell by cell -- a million cells, a million undo entries and a
    /// million-cell result, the BUG-0354 stall -- and A2:D1048576 (4,194,300
    /// cells) was refused outright. Excel 16 [LIVE, 2026-10-29] stores Bold on
    /// A2:D1048576 as ONE column format over A:D plus an exception for row 1,
    /// and no cell. Here: the whole columns' tiers, and every EXCLUDED position
    /// (row 1 of A:D) keeps what it showed -- as a ROW format where one can
    /// hold it ([`excluded_row_format`], round-3 review rev3A#7), else as its
    /// own cell. Taken only when those exceptions are fewer than the selected
    /// cells and at most [`ALMOST_WHOLE_EXCEPTION_LIMIT`]; the axis is the one
    /// with fewer of them. Clear Formats / Clear All take the same route
    /// (`line_extent_of`, `commands::data::plan_clear_formats`, rev3A#2).
    fn line_extent(&self) -> Option<CellRect> {
        if self.whole_columns() || self.whole_rows() {
            return Some(*self);
        }
        let every_row = u64::from(engine::EXCEL_MAX_ROW_INDEX) + 1;
        let every_col = u64::from(engine::EXCEL_MAX_COL_INDEX) + 1;
        let selected = self.rows() * self.cols();
        // Expanding to whole COLUMNS leaves the unselected rows of these
        // columns as exceptions; to whole ROWS, the unselected columns.
        let as_columns = every_row.saturating_sub(self.rows()) * self.cols();
        let as_rows = every_col.saturating_sub(self.cols()) * self.rows();
        let exceptions = as_columns.min(as_rows);
        if exceptions >= selected || exceptions > ALMOST_WHOLE_EXCEPTION_LIMIT {
            return None;
        }
        Some(if as_columns <= as_rows {
            CellRect::new(0, self.start_col, engine::EXCEL_MAX_ROW_INDEX, self.end_col)
        } else {
            CellRect::new(self.start_row, 0, self.end_row, engine::EXCEL_MAX_COL_INDEX)
        })
    }
}

/// A rectangle smaller than whole rows or whole columns is styled cell by
/// cell; above this many cells it is refused rather than materialised (a
/// Calcula-only bound -- Excel has none). Whole rows, whole columns, Select
/// All and ALMOST-whole lines (`CellRect::line_extent`) never reach it: they
/// go through the row/column TIERS.
const DENSE_BORDER_CELL_LIMIT: u64 = 4_000_000;

/// The most EXCEPTIONS an almost-whole rectangle may need -- the positions of
/// its whole lines it does not select, each keeping what it showed, as a row
/// format or as its own cell (`CellRect::line_extent`). A few header rows over
/// a few columns is a handful; a rectangle short of its lines by more than
/// this is styled cell by cell (or refused) instead.
const ALMOST_WHOLE_EXCEPTION_LIMIT: u64 = 65_536;

/// [`CellRect::line_extent`] for a NORMALISED `(min_row, min_col, max_row,
/// max_col)` rectangle, for a planner outside this module: Clear Formats /
/// Clear All (`commands::data::plan_clear_formats`) take the same almost-whole
/// route as the formatting planner (round-3 review rev3A#2) -- C2:C1048576
/// used to be planned as a partial clear, one explicit cell per position.
pub(crate) fn line_extent_of(rect: (u32, u32, u32, u32)) -> Option<(u32, u32, u32, u32)> {
    CellRect::new(rect.0, rect.1, rect.2, rect.3)
        .line_extent()
        .map(|line| (line.start_row, line.start_col, line.end_row, line.end_col))
}

/// How an EXCLUDED row of an almost-whole COLUMN range keeps its look as a
/// ROW format (`excluded_row_format`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExcludedRowFormat {
    /// A registry index that LOOKS like what the row shows across the range's
    /// columns today (0: Normal). The row's new format is this style, interned
    /// explicitly by the writer.
    pub(crate) look: usize,
    /// Columns OUTSIDE the range whose own column format differs from `look`,
    /// with that format: the row format would hide it there, so each crossing
    /// keeps it as a cell of its own.
    pub(crate) crossings: Vec<(u32, usize)>,
}

/// THE ROW-FORMAT EXCEPTION (round-3 review rev3A#7). An untiered row that an
/// almost-whole COLUMN range leaves out (row 1 of B2:XFD1048576) shows the
/// range's column formats today; once those change, each excluded position
/// must keep its look, and it used to become one cell per column -- 16,383 for
/// B2 to the sheet's corner, and the used range ran to XFD. Excel 16 [LIVE,
/// 2026-10-29, lane clearfmt probe.ps1, each case saved and its sheet XML read
/// back] writes a ROW format instead:
///   - B2:XFD1048576 Bold, empty sheet: `<col min=2 max=16384 s=bold>` and
///     `<row r=1 customFormat=1/>`, no cell (and A2:D1048576 the same);
///   - column F italic, then A2:A1048576 Bold: the row format AND the
///     crossing `<c r=F1 s=italic/>`, which the row format would hide;
///   - every column bold, then B2:XFD1048576 (or A2:A1048576) Clear Formats:
///     `<row r=1 s=bold customFormat=1/>`, no cell;
///   - but columns A:D bold, then A2:D1048576 Clear Formats: the CELLS A1:D1
///     (a bold row format would turn E1:XFD1 bold -- 16,380 crossings).
/// What this takes from them: the range's columns must show ONE look on such
/// a row; every column outside the range without a format of its own shows
/// Normal, so that look must then be Normal; and the columns outside the range
/// whose format differs become crossing cells.
///
/// THE CROSSING COUNT IS A CALCULA BOUND, NOT EXCEL'S RULE. The row format is
/// taken only while the crossings are no more than the cells it saves (the
/// range's columns; the tie, as in the column-F case, goes to the row format).
/// Excel keeps the row format with MORE crossings than that [LIVE, rev5A
/// probe-rowfmt.ps1 / probe-rowfmt2.ps1, sheet XML read back]: columns F:G
/// italic then A2:A1048576 Bold stores `<row r=1 customFormat=1>` plus F1 and
/// G1 (2 crossings, 1 column), and F:H italic then A2:B1048576 Bold the row
/// format plus F1:H1 (3 crossings, 2 columns) -- where this writes the
/// excluded positions as cells. Excel switches to cells somewhere below the
/// 16,380 crossings of the A:D case above; its threshold is not known. The
/// LOOK is identical either way: only the stored shape and the used range
/// differ. `None`: the excluded positions are kept as cells. O(column
/// formats), once per range.
pub(crate) fn excluded_row_format(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    first_col: u32,
    last_col: u32,
) -> Option<ExcludedRowFormat> {
    let (first_col, last_col) = (first_col.min(last_col), first_col.max(last_col));
    let inside = |col: u32| col >= first_col && col <= last_col;
    let width = u64::from(last_col - first_col) + 1;
    let mut inside_tiers: Vec<usize> = Vec::new();
    let mut outside_tiers: Vec<(u32, usize)> = Vec::new();
    for (&col, &index) in &grid.column_styles {
        if index == 0 {
            continue;
        }
        if inside(col) {
            inside_tiers.push(index);
        } else {
            outside_tiers.push((col, index));
        }
    }
    let normal = styles.default_style();
    // The look the range's columns show on an untiered row: Normal where one
    // of them has no format, else the one format they all share.
    let look = if (inside_tiers.len() as u64) < width {
        if inside_tiers.iter().any(|&index| styles.get(index) != normal) {
            return None;
        }
        0
    } else {
        let first = *inside_tiers.first()?;
        if inside_tiers.iter().any(|&index| styles.get(index) != styles.get(first)) {
            return None;
        }
        first
    };
    let shown = styles.get(look);
    let every_column = u64::from(engine::EXCEL_MAX_COL_INDEX) + 1;
    let untiered_outside = every_column - width - outside_tiers.len() as u64;
    if untiered_outside > 0 && shown != normal {
        return None;
    }
    let mut crossings: Vec<(u32, usize)> =
        outside_tiers.into_iter().filter(|&(_, index)| styles.get(index) != shown).collect();
    if crossings.len() as u64 > width {
        return None;
    }
    crossings.sort_unstable();
    Some(ExcludedRowFormat { look, crossings })
}

/// Where a whole-row/whole-column preset crosses the OTHER axis's tiers, each
/// crossing needs its own cell (the row tier outranks the column tier, so the
/// new tier would not reach it). Above this many crossings the command is
/// refused rather than materialising them. The precedent is the 250,000 guard
/// in `protection.rs`'s tier planner, which instead SKIPS the crossings -- a
/// silent gap that is tolerable for a lock bit and is not for a visible border.
const BORDER_TIER_CROSSING_LIMIT: u64 = 2_000_000;

/// Everything a range-style command will WRITE, decided before anything is
/// touched, so a refusal (too many cells, too many crossings) costs nothing.
#[derive(Debug, Default)]
struct RangeStylePlan {
    /// The distinct styles the plan writes, each ONCE; the entries below name
    /// them by position here. A whole column's interior -- or a million row
    /// tiers -- share a handful of styles, and a clone per entry made the plan
    /// itself O(lines x style size) before a single tier was written.
    styles: Vec<CellStyle>,
    /// Explicit cell styles: ((row, col), index into `styles`).
    cells: Vec<((u32, u32), usize)>,
    /// Stored cells holding a value that take the new LINE format as their
    /// OWN style, although the tier alone would show it: Excel gives every
    /// existing cell the format, so it travels with the data on Sort, Insert
    /// Cells and Cut (round-2 review revA#2). Written like `cells`, but not
    /// REPORTED in the result -- a Select All over a filled sheet is every
    /// value, and every caller repaints the grid after a whole-line format.
    carried: Vec<((u32, u32), usize)>,
    /// New column-tier styles: (col, index into `styles`).
    column_tiers: Vec<(u32, usize)>,
    /// New row-tier styles: (row, index into `styles`).
    row_tiers: Vec<(u32, usize)>,
}

impl RangeStylePlan {
    fn is_empty(&self) -> bool {
        self.cells.is_empty() && self.carried.is_empty() && self.column_tiers.is_empty() && self.row_tiers.is_empty()
    }
}

/// A style the planner settled on for a position or a line: the REGISTRY
/// style it already has (`Kept`, a registry index), or one of the plan's own
/// (`New`, an index into `RangeStylePlan::styles`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Planned {
    Kept(usize),
    New(usize),
}

/// The delta, run ONCE per (base style, edge position). Every position of a
/// whole-line selection is one of a handful of such pairs, so a million row
/// tiers cost a million hash lookups and a few clones, not a million clones.
struct DeltaMemo<'p> {
    registry: &'p engine::StyleRegistry,
    apply: &'p dyn Fn(&mut CellStyle, EdgePosition),
    /// Whether `apply` reads the position. When it does not, every position
    /// shares one answer per base style.
    edges_matter: bool,
    answers: std::collections::HashMap<(usize, EdgePosition), Planned>,
    /// `RangeStylePlan::styles`, by value: one entry per distinct style.
    interned: std::collections::HashMap<CellStyle, usize>,
}

impl<'p> DeltaMemo<'p> {
    fn new(
        registry: &'p engine::StyleRegistry,
        apply: &'p dyn Fn(&mut CellStyle, EdgePosition),
        edges_matter: bool,
    ) -> Self {
        DeltaMemo {
            registry,
            apply,
            edges_matter,
            answers: std::collections::HashMap::new(),
            interned: std::collections::HashMap::new(),
        }
    }

    /// What the registry style `base` becomes at `at`.
    fn desired(&mut self, plan: &mut RangeStylePlan, base: usize, at: EdgePosition) -> Planned {
        let at = if self.edges_matter { at } else { EdgePosition::default() };
        if let Some(&answer) = self.answers.get(&(base, at)) {
            return answer;
        }
        let before = self.registry.get(base);
        let mut next = before.clone();
        (self.apply)(&mut next, at);
        let answer = if next == *before { Planned::Kept(base) } else { Planned::New(self.intern(plan, next)) };
        self.answers.insert((base, at), answer);
        answer
    }

    fn intern(&mut self, plan: &mut RangeStylePlan, style: CellStyle) -> usize {
        if let Some(&id) = self.interned.get(&style) {
            return id;
        }
        let id = plan.styles.len();
        self.interned.insert(style.clone(), id);
        plan.styles.push(style);
        id
    }

    /// The plan's own index for `planned` -- a `Kept` registry style is copied
    /// in when a cell must carry it EXPLICITLY (a new tier would hide it).
    fn materialize(&mut self, plan: &mut RangeStylePlan, planned: Planned) -> usize {
        match planned {
            Planned::New(id) => id,
            Planned::Kept(index) => {
                let style = self.registry.get(index).clone();
                self.intern(plan, style)
            }
        }
    }

    fn style<'a>(&'a self, plan: &'a RangeStylePlan, planned: Planned) -> &'a CellStyle {
        match planned {
            Planned::Kept(index) => self.registry.get(index),
            Planned::New(id) => &plan.styles[id],
        }
    }
}

/// Plan a border preset over `rect` on `grid`.
///
/// EVERY CELL IS BASED ON ITS EFFECTIVE STYLE (survey D2). This used to start
/// from the cell's OWN `style_index`, which is 0 -- "inherit" -- for a cell
/// that only shows a row or column default, so a border on such a cell
/// replaced the tier's whole format with "default + border": a column's fill
/// vanished, and a column unlocked through its tier silently re-locked.
/// `apply_formatting` has based on the effective style for exactly that reason.
///
/// WHOLE ROWS AND WHOLE COLUMNS GO THROUGH THE TIERS (survey D3). Select All is
/// 17.2 billion positions; this used to walk every one of them (and compute
/// its count as an overflowing `u32` product). Excel stores a whole-column
/// format as a COLUMN format, and so does Calcula (`Grid::column_styles`):
///  - the interior cells of a whole-column range differ only in which column
///    they are in, so ONE tier style per column carries them all;
///  - the cells that can differ from their column's tier get their own style:
///    the first and last row (an `outside` top/bottom edge), every stored cell
///    that already has a style of its own, and every crossing with a ROW tier
///    (the row tier outranks the column, so the column change would not show)
///    -- except on Select All, where each row tier takes the change itself
///    and only its first and last column need a cell (BUG-0354);
///  - a cell is written only when what it would SHOW without one differs from
///    what the preset asks for, or when it holds a value the preset changes
///    (that value takes the format as its own, as in Excel; see
///    `plan_range_style`), so `allBorders` over an empty plain column writes
///    one tier entry and no cells at all.
/// Whole rows are the same with the axes swapped -- except that the new ROW
/// tier then outranks every column tier it crosses, so those crossings are
/// written to keep the column's own format (unless every column shares one
/// format: the row is then based on it; see `plan_range_style`).
fn plan_border_preset(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    rect: CellRect,
    delta: &BorderPresetDelta,
) -> Result<RangeStylePlan, String> {
    plan_range_style(
        grid,
        styles,
        rect,
        &|style, position| delta.apply(style, position),
        delta.edges_matter(),
        &BORDER_WORDING,
    )
}

/// How a range-style refusal names what it refuses.
struct PlanWording {
    /// "Borders" -> "Borders can be applied to at most ...".
    dense: &'static str,
    /// "This border" -> "This border would have to be written to ...".
    crossing: &'static str,
}

const BORDER_WORDING: PlanWording = PlanWording { dense: "Borders", crossing: "This border" };
const NUMBER_FORMAT_WORDING: PlanWording =
    PlanWording { dense: "A number format", crossing: "This number format" };
const FORMAT_WORDING: PlanWording = PlanWording { dense: "Formatting", crossing: "This format" };

/// The planner behind `apply_formatting`, the border presets AND Increase/
/// Decrease Decimal: what `apply` does to every position of `rect` (it is told
/// where the position sits on the rectangle's edge; a delta that does not care
/// passes `edges_matter = false` and is never asked about the edge cells
/// separately), with whole columns and whole rows written through the style
/// TIERS. See `plan_border_preset` for the tier rules; they do not depend on
/// the delta.
///
/// THE WORK IS O(lines + stored cells + crossings), never O(rows x columns)
/// (BUG-0354: `apply_formatting` walked Select All's 17.2 billion positions).
/// The rules, measured on Excel 16 [LIVE, 2026-10-29: each case saved as
/// .xlsx and its sheet XML read back]:
///  - Select All Bold on an EMPTY sheet is ONE column format over every column
///    and no cell (`<col min=1 max=16384 style=bold>`); a cell typed later is
///    bold.
///  - EVERY EXISTING CELL HOLDING A VALUE GETS THE FORMAT AS ITS OWN (round-2
///    review revA#2). Select All Bold with C3 = 42 and B7 = "x" saves the
///    column format AND `<c r=C3 s=bold>`, `<c r=B7 s=bold>`; row 5 Bold over
///    A5:B5 saves the row format and both cells. So the format travels with
///    the value: sort A1:B8 after that and the moved record keeps it. A stored
///    cell that only inherited (own style 0) was left to the tier here, so a
///    sort moved its value off the formatted row without the format. It is now
///    written explicitly (`RangeStylePlan::carried`) -- O(stored cells), the
///    candidate set below -- and only empty positions are left to the tier.
///  - AN ALMOST-WHOLE RECTANGLE IS WHOLE LINES PLUS EXCEPTIONS (round-2 review
///    revA#4; `CellRect::line_extent`). A2:D1048576 Bold is the column format
///    over A:D and an exception for row 1. Here the excluded positions (A1:D1)
///    are planned with NO delta, so each keeps what it showed: an untiered
///    excluded row as a ROW format holding that look where one can
///    (`excluded_row_format`, round-3 review rev3A#7 -- Excel's
///    `<row r=1 customFormat=1/>`; B2 to the sheet's corner used to write
///    16,383 cells B1:XFD1), else each position as its own cell.
///  - SELECT ALL ALSO REWRITES EVERY ROW FORMAT. Row 3 bold, then Select All
///    Italic: row 3's own format became bold italic, no cell was written in
///    it. Here: each existing row tier takes the delta itself, so a sheet with
///    row formats needs no crossing cells (it used to need one per row tier
///    per column -- 16,384 per formatted row, refused above 122 of them).
///  - A WHOLE ROW over columns that do not all share one format is based on
///    the DEFAULT, and every crossing with a column format gets its own cell
///    (columns A:XFC bold, then row 5 yellow: 16,383 cells bold + yellow, the
///    row's own format plain yellow). Over a sheet whose columns ALL share one
///    format (the state Select All leaves) the row is based on THAT format and
///    writes no cell (Select All Bold, then row 5 yellow: the row's format is
///    bold + yellow, the used range stays A5). `uniform_column_style`.
///  - A WHOLE COLUMN crossing a row format writes the crossing cell (row 3
///    bold, column C Left Border: C3 is bold + bordered, as its own cell).
fn plan_range_style(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    rect: CellRect,
    apply: &dyn Fn(&mut CellStyle, EdgePosition),
    edges_matter: bool,
    wording: &PlanWording,
) -> Result<RangeStylePlan, String> {
    let mut plan = RangeStylePlan::default();
    let mut memo = DeltaMemo::new(styles, apply, edges_matter);

    // `line`: the whole lines written through the tiers -- `rect` itself, or
    // the whole columns / rows an almost-whole `rect` nearly fills. `rect`
    // still decides which positions take the delta and where its edges are.
    let Some(line) = rect.line_extent() else {
        let count = rect.rows() * rect.cols();
        if count > DENSE_BORDER_CELL_LIMIT {
            return Err(dense_limit_refusal(wording, count));
        }
        for row in rect.start_row..=rect.end_row {
            for col in rect.start_col..=rect.end_col {
                let base = grid.effective_style_index(row, col);
                if let Planned::New(id) = memo.desired(&mut plan, base, rect.position(row, col)) {
                    plan.cells.push(((row, col), id));
                }
            }
        }
        return Ok(plan);
    };
    let whole_columns = line.whole_columns();
    let whole_rows = line.whole_rows();

    // ---- Tier path: whole columns (Select All included) or whole rows ----
    // The new tier of each line that changes (an index into `plan.styles`).
    let mut new_column_tier: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    let mut new_row_tier: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    // The positions whose style may differ from the tiers after the change:
    // every stored cell of the lines (its own style outranks every tier, and
    // one holding a value takes the format as its own), plus the crossings,
    // edges and exceptions added below.
    let mut candidates: std::collections::BTreeSet<(u32, u32)> = grid
        .cells
        .keys()
        .copied()
        .filter(|&(r, c)| line.contains(r, c))
        .collect();

    // THE EXCEPTIONS of an almost-whole rectangle: the positions of its whole
    // lines it does not select (`line_extent` bounded their number). Each is
    // planned with no delta below, so it keeps what it shows -- as its own
    // cell when the new tiers would otherwise reach it. An excluded ROW with a
    // tier of its own needs none under new column tiers: it outranks them. An
    // untiered excluded row keeps its look as a ROW format where one can hold
    // it (`excluded_row_format`, rev3A#7): written below once the column tiers
    // are known, with each crossing it would hide as a candidate here.
    let mut excluded_row_tiers: Option<(usize, Vec<u32>)> = None;
    if line != rect {
        if whole_columns {
            let excluded_rows: Vec<u32> = (line.start_row..rect.start_row)
                .chain(rect.end_row.saturating_add(1)..=line.end_row)
                .filter(|row| grid.row_styles.get(row).copied().unwrap_or(0) == 0)
                .collect();
            match excluded_row_format(grid, styles, rect.start_col, rect.end_col) {
                Some(format) if !excluded_rows.is_empty() => {
                    for &row in &excluded_rows {
                        for &(col, _) in &format.crossings {
                            candidates.insert((row, col));
                        }
                    }
                    excluded_row_tiers = Some((format.look, excluded_rows));
                }
                _ => {
                    for row in excluded_rows {
                        for col in rect.start_col..=rect.end_col {
                            candidates.insert((row, col));
                        }
                    }
                }
            }
        } else {
            let excluded_cols: Vec<u32> =
                (line.start_col..rect.start_col).chain(rect.end_col.saturating_add(1)..=line.end_col).collect();
            for row in rect.start_row..=rect.end_row {
                for &col in &excluded_cols {
                    candidates.insert((row, col));
                }
            }
        }
    }

    if whole_columns {
        for col in rect.start_col..=rect.end_col {
            let current = grid.column_styles.get(&col).copied().unwrap_or(0);
            let interior = EdgePosition {
                top: false,
                bottom: false,
                left: col == rect.start_col,
                right: col == rect.end_col,
            };
            if let Planned::New(id) = memo.desired(&mut plan, current, interior) {
                new_column_tier.insert(col, id);
                plan.column_tiers.push((col, id));
            }
        }
        // Rows with a tier of their own: it OUTRANKS the new column tiers.
        let mut tiered_rows: Vec<(u32, usize)> = grid
            .row_styles
            .iter()
            .filter(|(r, idx)| **idx != 0 && **r >= rect.start_row && **r <= rect.end_row)
            .map(|(r, idx)| (*r, *idx))
            .collect();
        tiered_rows.sort_unstable();
        if whole_rows {
            // SELECT ALL: each row tier takes the change itself (see above).
            for &(row, current) in &tiered_rows {
                let interior = EdgePosition {
                    top: row == rect.start_row,
                    bottom: row == rect.end_row,
                    left: false,
                    right: false,
                };
                if let Planned::New(id) = memo.desired(&mut plan, current, interior) {
                    new_row_tier.insert(row, id);
                    plan.row_tiers.push((row, id));
                }
            }
            if edges_matter {
                for &(row, _) in &tiered_rows {
                    candidates.insert((row, rect.start_col));
                    candidates.insert((row, rect.end_col));
                }
            }
        } else {
            let crossings = tiered_rows.len() as u64 * rect.cols();
            if crossings > BORDER_TIER_CROSSING_LIMIT {
                return Err(crossing_limit_refusal(wording, crossings, "row"));
            }
            for &(row, _) in &tiered_rows {
                for col in rect.start_col..=rect.end_col {
                    candidates.insert((row, col));
                }
            }
        }
        if edges_matter {
            for col in rect.start_col..=rect.end_col {
                candidates.insert((rect.start_row, col));
                candidates.insert((rect.end_row, col));
            }
        }
    } else {
        // Whole rows. A row WITHOUT a tier shows its columns' formats; its new
        // tier is based on the one format every column shares, else on the
        // default -- and then every crossing with a column format needs a cell.
        let background = uniform_column_style(grid);
        let crossed_columns: Vec<u32> = if background != 0 {
            Vec::new()
        } else {
            let mut cols: Vec<u32> = grid
                .column_styles
                .iter()
                .filter(|(c, idx)| **idx != 0 && **c >= rect.start_col && **c <= rect.end_col)
                .map(|(c, _)| *c)
                .collect();
            cols.sort_unstable();
            cols
        };
        let mut untiered_rows: u64 = 0;
        for row in rect.start_row..=rect.end_row {
            let own = grid.row_styles.get(&row).copied().unwrap_or(0);
            let base = if own != 0 {
                own
            } else {
                untiered_rows += 1;
                background
            };
            let interior = EdgePosition {
                top: row == rect.start_row,
                bottom: row == rect.end_row,
                left: false,
                right: false,
            };
            if let Planned::New(id) = memo.desired(&mut plan, base, interior) {
                new_row_tier.insert(row, id);
                plan.row_tiers.push((row, id));
            }
        }
        // A row that HAS a tier shows it over every column already, so only
        // the untiered rows cross the column formats.
        let crossings = untiered_rows * crossed_columns.len() as u64;
        if crossings > BORDER_TIER_CROSSING_LIMIT {
            return Err(crossing_limit_refusal(wording, crossings, "column"));
        }
        if !crossed_columns.is_empty() {
            for row in rect.start_row..=rect.end_row {
                if grid.row_styles.get(&row).copied().unwrap_or(0) != 0 {
                    continue;
                }
                for &col in &crossed_columns {
                    candidates.insert((row, col));
                }
            }
        }
        if edges_matter {
            for row in rect.start_row..=rect.end_row {
                candidates.insert((row, rect.start_col));
                candidates.insert((row, rect.end_col));
            }
        }
    }

    // The excluded rows' ROW formats (rev3A#7) -- only when a new column tier
    // would reach them; with none, the excluded positions keep their look
    // untouched and nothing is written for them.
    if let Some((look, rows)) = excluded_row_tiers {
        if !new_column_tier.is_empty() {
            let id = memo.intern(&mut plan, styles.get(look).clone());
            for row in rows {
                plan.row_tiers.push((row, id));
                new_row_tier.insert(row, id);
            }
        }
    }

    for (row, col) in candidates {
        let before = grid.effective_style_index(row, col);
        // An exception (outside `rect`, inside `line`) keeps what it shows.
        let desired = if rect.contains(row, col) {
            memo.desired(&mut plan, before, rect.position(row, col))
        } else {
            Planned::Kept(before)
        };
        let stored = grid.get_cell(row, col);
        let own_style = stored.map_or(0, |c| c.style_index);
        let row_tiered = grid.row_styles.get(&row).copied().unwrap_or(0) != 0;
        // What this position SHOWS after the tier entries land, if no cell
        // style is written for it. A cell's own style outranks every tier; a
        // row tier (new or kept) outranks a column tier.
        let after = if own_style != 0 {
            Planned::Kept(before)
        } else if let Some(&id) = new_row_tier.get(&row) {
            Planned::New(id)
        } else if row_tiered {
            Planned::Kept(before)
        } else if let Some(&id) = new_column_tier.get(&col) {
            Planned::New(id)
        } else {
            Planned::Kept(before)
        };
        let shows_wrong = memo.style(&plan, desired) != memo.style(&plan, after);
        let changes = memo.style(&plan, desired) != memo.style(&plan, Planned::Kept(before));
        if shows_wrong {
            let id = memo.materialize(&mut plan, desired);
            plan.cells.push(((row, col), id));
        } else if changes && own_style == 0 && stored.is_some_and(holds_value) {
            // The tier alone would show it, but Excel gives the existing cell
            // the format as its own, so it travels with the value (revA#2).
            let id = memo.materialize(&mut plan, desired);
            plan.carried.push(((row, col), id));
        }
    }
    Ok(plan)
}

/// Whether a stored cell holds something a user put there -- a value, a
/// formula or rich text -- rather than being an empty placeholder. Such a
/// cell takes a whole-line format as its OWN style (`plan_range_style`).
fn holds_value(cell: &Cell) -> bool {
    !matches!(cell.value, CellValue::Empty) || cell.ast.is_some() || cell.rich_text.is_some()
}

/// The column format EVERY column of the sheet shares, or 0 (the default)
/// when they do not all share one. Excel bases a new whole-row format on it
/// [LIVE: after Select All Bold, row 5 yellow is bold + yellow with no cell;
/// with 16,383 of the 16,384 columns bold it is plain yellow, and each bold
/// column's crossing becomes a cell] -- not on a majority.
fn uniform_column_style(grid: &engine::Grid) -> usize {
    let every_column = u64::from(engine::EXCEL_MAX_COL_INDEX) + 1;
    if grid.column_styles.len() as u64 != every_column {
        return 0;
    }
    let mut indices = grid.column_styles.values().copied();
    let Some(first) = indices.next() else { return 0 };
    if first != 0 && indices.all(|index| index == first) {
        first
    } else {
        0
    }
}

/// The refusal when a whole-line style would need more crossing cells than
/// [`BORDER_TIER_CROSSING_LIMIT`]; `other_axis` names the formats it crosses.
fn crossing_limit_refusal(wording: &PlanWording, crossings: u64, other_axis: &str) -> String {
    format!(
        "{} would have to be written to {} separate cells where whole-{} \
         formats cross; select a smaller range.",
        wording.crossing, crossings, other_axis
    )
}

/// The refusal for a cell-by-cell style write past [`DENSE_BORDER_CELL_LIMIT`].
fn dense_limit_refusal(wording: &PlanWording, count: u64) -> String {
    format!(
        "{} can be applied to at most {} cells at once ({} selected). \
         Select whole rows or whole columns, or a smaller range.",
        wording.dense, DENSE_BORDER_CELL_LIMIT, count
    )
}

/// What `write_range_style_plan` wrote: the cells to REPORT (with their new
/// style index) and the style indices no reported cell names -- its tier
/// entries' and its carried cells' (`RangeStylePlan::carried`) -- which the
/// frontend's style cache must still learn to paint them.
struct WrittenPlan {
    cells: Vec<(u32, u32, usize)>,
    unreported_styles: Vec<usize>,
}

/// Write a `RangeStylePlan` to one sheet: tiers first (with their undo
/// snapshot), then cells. `mirror` is the second copy of the ACTIVE sheet
/// (`grids[active]` beside `state.grid`); both must change or the readers that
/// resolve against the other copy would not see the borders. Returns the
/// cells written (the carried ones written but not listed), with their new
/// style index.
fn write_range_style_plan(
    grid: &mut engine::Grid,
    mut mirror: Option<&mut engine::Grid>,
    styles: &mut engine::StyleRegistry,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    plan: RangeStylePlan,
    label: &str,
) -> WrittenPlan {
    // Each planned style is interned ONCE per flavour, however many lines or
    // cells use it (`explicit` for tiers and cells under a tier, `plain` for
    // the rest) -- a million row tiers are one registry lookup, not a million.
    let RangeStylePlan { styles: planned, cells, carried, column_tiers, row_tiers } = plan;
    let mut explicit: Vec<Option<usize>> = vec![None; planned.len()];
    let mut plain: Vec<Option<usize>> = vec![None; planned.len()];
    let mut unreported_styles = Vec::new();
    for (is_column, entries) in [(true, column_tiers), (false, row_tiers)] {
        if entries.is_empty() {
            continue;
        }
        let previous: Vec<(u32, usize)> = entries
            .iter()
            .map(|(idx, _)| {
                let tiers = if is_column { &grid.column_styles } else { &grid.row_styles };
                (*idx, tiers.get(idx).copied().unwrap_or(0))
            })
            .collect();
        undo_stack.record_custom_restore(
            "obj_style_tiers".to_string(),
            crate::undo_commands::style_tiers_snapshot_bytes(sheet_index, is_column, previous),
            label,
        );
        for (idx, id) in entries {
            // EXPLICIT: a tier whose style equals the default would otherwise
            // intern to 0, which `set_column_style` reads as "clear the tier".
            let style_index = match explicit[id] {
                Some(index) => index,
                None => {
                    let index = styles.get_or_create_explicit(planned[id].clone());
                    explicit[id] = Some(index);
                    unreported_styles.push(index);
                    index
                }
            };
            if is_column {
                grid.set_column_style(idx, style_index);
                if let Some(m) = mirror.as_deref_mut() {
                    m.set_column_style(idx, style_index);
                }
            } else {
                grid.set_row_style(idx, style_index);
                if let Some(m) = mirror.as_deref_mut() {
                    m.set_row_style(idx, style_index);
                }
            }
        }
    }

    let mut written = Vec::with_capacity(cells.len());
    let reported = cells.into_iter().map(|entry| (entry, true));
    let quiet = carried.into_iter().map(|entry| (entry, false));
    for (((row, col), id), report) in reported.chain(quiet) {
        // Under a tier (after the tier writes above), a style equal to the
        // default must still be EXPLICIT: index 0 means "inherit".
        let under_tier = grid.row_styles.get(&row).copied().unwrap_or(0) != 0
            || grid.column_styles.get(&col).copied().unwrap_or(0) != 0;
        let style_index = if under_tier {
            *explicit[id].get_or_insert_with(|| styles.get_or_create_explicit(planned[id].clone()))
        } else {
            *plain[id].get_or_insert_with(|| styles.get_or_create(planned[id].clone()))
        };
        let previous_cell = grid.get_cell(row, col).cloned();
        let mut cell = previous_cell.clone().unwrap_or(Cell {
            value: CellValue::Empty,
            ast: None,
            style_index: 0,
            rich_text: None,
        });
        cell.style_index = style_index;
        grid.set_cell(row, col, cell.clone());
        if let Some(m) = mirror.as_deref_mut() {
            m.set_cell(row, col, cell);
        }
        undo_stack.record_cell_change(sheet_index, row, col, previous_cell);
        if report {
            written.push((row, col, style_index));
        } else {
            unreported_styles.push(style_index);
        }
    }
    unreported_styles.sort_unstable();
    unreported_styles.dedup();
    WrittenPlan { cells: written, unreported_styles }
}

/// Apply a border preset to a rectangular range.
///
/// Presets:
/// - "insideHorizontal" - horizontal borders between rows (not on outer edges)
/// - "insideVertical"   - vertical borders between columns (not on outer edges)
/// - "insideBoth"       - both inside horizontal and vertical
/// - "outside"          - borders on the outer edges only
/// - "allBorders"       - all inside + outside borders
/// - "none"             - clear all borders in the range
///
/// Whole rows, whole columns and Select All are written through the row/column
/// tiers (see `plan_border_preset`); everything else cell by cell, each cell
/// based on its EFFECTIVE style. One undo step, joining a step the caller holds
/// open (script batches, the Home tab's two-call presets).
///
/// `sheet_indices`: with sheets GROUPED, the group (it may include the active
/// sheet). Every sheet is gated and planned before any is written, and the
/// whole group is ONE undo step -- see `apply_formatting` for why one command.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn apply_border_preset(
    state: State<AppState>,
    file_state: State<FileState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    preset: String,
    style: String,
    color: String,
    width: u8,
    sheet_indices: Option<Vec<usize>>,
    target: Option<CellTargetRef>,
) -> Result<FormattingResult, String> {
    apply_border_preset_on(
        &state,
        &file_state,
        CellRect::new(start_row, start_col, end_row, end_col),
        &preset,
        &style,
        &color,
        width,
        sheet_indices.as_deref().unwrap_or(&[]),
        target.as_ref(),
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_border_preset_core(
    state: &AppState,
    file_state: &FileState,
    rect: CellRect,
    preset: &str,
    style: &str,
    color: &str,
    width: u8,
    group: &[usize],
) -> Result<FormattingResult, String> {
    apply_border_preset_on(state, file_state, rect, preset, style, color, width, group, None)
}

/// [`apply_border_preset_core`] with an optional cell target (P3): with
/// `Some`, ONLY the target's backing sheet is written, inside its extent.
#[allow(clippy::too_many_arguments)]
fn apply_border_preset_on(
    state: &AppState,
    file_state: &FileState,
    rect: CellRect,
    preset: &str,
    style: &str,
    color: &str,
    width: u8,
    group: &[usize],
    target: Option<&CellTargetRef>,
) -> Result<FormattingResult, String> {
    let bounds = (rect.start_row, rect.start_col, rect.end_row, rect.end_col);
    let resolved = resolve_style_target(state, target, !group.is_empty(), Some(bounds))?;
    let route = match &resolved {
        Some(t) => StyleTargets::Only(t),
        None => StyleTargets::Sheets { group, include_active: true },
    };
    border_preset_on_sheets(state, file_state, rect, preset, style, color, width, route)
}

/// The grouped-sheets half of a border preset (survey D4): repeat the preset
/// on every listed sheet EXCEPT the active one. Kept for callers that format
/// the active sheet themselves; the Home tab's wrapper now sends the whole
/// group to `apply_border_preset` instead.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn apply_border_preset_to_sheets(
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_indices: Vec<usize>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    preset: String,
    style: String,
    color: String,
    width: u8,
) -> Result<(), String> {
    apply_border_preset_to_sheets_core(
        &state,
        &file_state,
        &sheet_indices,
        CellRect::new(start_row, start_col, end_row, end_col),
        &preset,
        &style,
        &color,
        width,
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_border_preset_to_sheets_core(
    state: &AppState,
    file_state: &FileState,
    sheet_indices: &[usize],
    rect: CellRect,
    preset: &str,
    style: &str,
    color: &str,
    width: u8,
) -> Result<(), String> {
    let route = StyleTargets::Sheets { group: sheet_indices, include_active: false };
    border_preset_on_sheets(state, file_state, rect, preset, style, color, width, route).map(|_| ())
}

/// The body of both border commands. Under the HELD guards (`StyleLocks`):
/// gate every target sheet, plan every one (a refusal -- too many cells, too
/// many tier crossings -- touches nothing), and only if something changes
/// construct the effect and write every plan inside ONE owned transaction.
/// Returns the active sheet's written cells and the whole style registry.
#[allow(clippy::too_many_arguments)]
fn border_preset_on_sheets(
    state: &AppState,
    file_state: &FileState,
    rect: CellRect,
    preset: &str,
    style: &str,
    color: &str,
    width: u8,
    route: StyleTargets<'_>,
) -> Result<FormattingResult, String> {
    // An unknown preset or style is refused before any guard is taken.
    let delta = BorderPresetDelta::new(preset, style, color, width)?;

    let locks = StyleLocks::take(state);
    let (targets, report_sheet) = locks.route_targets(&route);
    gate_style_targets(state, &locks, &targets, route.cell_target(), StyleChange::Look, "apply borders")?;
    let mut plans: Vec<(usize, RangeStylePlan)> = Vec::new();
    for &sheet in &targets {
        let Some(grid) = locks.sheet_grid(sheet) else { continue };
        let plan = plan_border_preset(grid, &locks.styles, rect, &delta)?;
        if !plan.is_empty() {
            plans.push((sheet, plan));
        }
    }
    if plans.is_empty() {
        // Nothing would change (`none` on a range without borders): nothing is
        // written, nothing is recorded, and the document stays clean.
        return Ok(FormattingResult { cells: Vec::new(), styles: Vec::new() });
    }

    // Every gate has passed and something changes; from here this command
    // commits. Constructed HERE so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let StyleLocks { grid, grids, styles, active_sheet } = locks;
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut undo_stack = state.undo_stack.lock().unwrap();

    let label = format!("Border preset '{}' on {} cells", preset, rect.rows() * rect.cols());
    // Join an already-open frontend transaction (script undo batching, the Home
    // tab's two-call presets) instead of opening a nested one.
    let txn = undo_stack.begin_owned_transaction(label.clone());
    let mut written = Vec::new();
    for (sheet, plan) in plans {
        let outcome = if sheet == active_sheet {
            write_range_style_plan(&mut grid, grids.get_mut(active_sheet), &mut styles, &mut undo_stack, sheet, plan, &label)
        } else if let Some(sheet_grid) = grids.get_mut(sheet) {
            write_range_style_plan(sheet_grid, None, &mut styles, &mut undo_stack, sheet, plan, &label)
        } else {
            continue;
        };
        // The REPORTED sheet's cells (a cell target's backing sheet's too).
        if sheet == report_sheet {
            written = outcome.cells;
        }
    }
    undo_stack.commit_owned(txn);
    drop(undo_stack);

    // The WHOLE registry: a tier's style is referenced by no returned cell, and
    // the frontend's style cache must still know it to paint the column.
    let merges = report_merges(state, report_sheet, active_sheet);
    let report_grid = if report_sheet == active_sheet { &*grid } else { &grids[report_sheet] };
    Ok(formatting_result(state, report_grid, &styles, &written, &merges, None))
}

// ============================================================================
// Increase / Decrease Decimal (Home > Number)
// ============================================================================

/// The format Increase/Decrease Decimal turns `format` into, for a cell
/// holding `value` -- or `None` when Excel leaves the selection UNCHANGED.
///
/// Excel's rules, measured live on Excel 16 (sv-SE, 2026-10-04; survey
/// number.md section 3 and the rust-format probes):
///  - the ACTIVE cell's format decides, and the result is applied to the WHOLE
///    selection (F1:F3 with F1 General 1.5 active: all three became `0.00`,
///    a `0%` cell included);
///  - the format KEEPS ITS KIND: Number, Currency, Accounting, Percentage and
///    Scientific gain or lose one decimal (`0%` -> `0.0%`, `0.00E+00` ->
///    `0.000E+00`, accounting keeps its symbol and layout, currency its symbol
///    and its negative entry);
///  - General uses the decimals it SHOWS: 1.5 -> `0.00` / `0`, 1.2345 ->
///    `0.00000` / `0.000`, 3 -> `0.0` / unchanged;
///  - a Custom code gets one `0` more or less after the last digit
///    placeholder of EVERY numeric section (`#,##0.00 "kr"` -> `#,##0.000
///    "kr"`, `0.00;(0.00);"zero"` -> `0.000;(0.000);"zero"`, `#,##0 " k"` ->
///    `#,##0.0 " k"`); a section with no digit placeholder is left alone;
///  - UNCHANGED, for the whole selection: Date, Time, Fraction and Text (`@`)
///    formats, an empty active cell, a General cell holding text, and a
///    Decrease with no decimal left to remove (`0`, `0%`). With a DATE active
///    and a `0.00` cell beside it, neither changed.
///
/// One deliberate difference: Excel's General count comes from the column
/// WIDTH (1234.5678 in a default column shows `1234,568` and becomes 4
/// decimals); the backend does not lay text out, so it counts the decimals of
/// General's full rendering (`format_general`, up to 10) and gets 5.
pub(crate) fn next_decimal_format(
    format: &NumberFormat,
    value: Option<&CellValue>,
    delta: i32,
) -> Option<NumberFormat> {
    let step = |places: u8| -> Option<u8> {
        if delta > 0 {
            places.checked_add(1)
        } else {
            places.checked_sub(1)
        }
    };
    match format {
        NumberFormat::General => {
            let Some(CellValue::Number(n)) = value else {
                return None;
            };
            let shown = engine::format_number(*n, &NumberFormat::General, &engine::LocaleSettings::invariant());
            let (mantissa, scientific) = match shown.split_once('E') {
                Some((m, _)) => (m.to_string(), true),
                None => (shown.clone(), false),
            };
            let decimals = mantissa.split_once('.').map_or(0, |(_, frac)| frac.len());
            let decimals = u8::try_from(decimals).ok()?;
            let next = step(decimals)?;
            Some(if scientific {
                NumberFormat::Scientific { decimal_places: next }
            } else {
                NumberFormat::Number { decimal_places: next, use_thousands_separator: false }
            })
        }
        NumberFormat::Number { decimal_places, use_thousands_separator } => {
            Some(NumberFormat::Number {
                decimal_places: step(*decimal_places)?,
                use_thousands_separator: *use_thousands_separator,
            })
        }
        NumberFormat::Currency { decimal_places, symbol, symbol_position, negative_style } => {
            Some(NumberFormat::Currency {
                decimal_places: step(*decimal_places)?,
                symbol: symbol.clone(),
                symbol_position: *symbol_position,
                negative_style: *negative_style,
            })
        }
        NumberFormat::Accounting { decimal_places, symbol, symbol_position, negative_style } => {
            Some(NumberFormat::Accounting {
                decimal_places: step(*decimal_places)?,
                symbol: symbol.clone(),
                symbol_position: *symbol_position,
                negative_style: *negative_style,
            })
        }
        NumberFormat::Percentage { decimal_places } => {
            Some(NumberFormat::Percentage { decimal_places: step(*decimal_places)? })
        }
        NumberFormat::Scientific { decimal_places } => {
            Some(NumberFormat::Scientific { decimal_places: step(*decimal_places)? })
        }
        NumberFormat::Fraction { .. } | NumberFormat::Date { .. } | NumberFormat::Time { .. } => None,
        NumberFormat::Custom { format: code } => {
            adjust_custom_code_decimals(code, delta).map(|format| NumberFormat::Custom { format })
        }
    }
}

/// One `0` more or less after the last digit placeholder of every numeric
/// section of a custom code; `None` when no section changed, or when the code
/// is a date/time/text code (Excel leaves those alone).
///
/// The code is read with Excel's tokenizer rules: `"..."` and `\x` are
/// literals, `_x` and `*x` consume the next character, `[...]` is a colour,
/// condition or locale. Only the MANTISSA counts -- the part before an
/// `E+`/`E-` exponent -- so `0.00E+00` gains a decimal, not an exponent digit.
pub(crate) fn adjust_custom_code_decimals(code: &str, delta: i32) -> Option<String> {
    let sections = split_code_sections(code);
    let mut changed = false;
    let mut out: Vec<String> = Vec::with_capacity(sections.len());
    for (i, section) in sections.iter().enumerate() {
        let scan = scan_decimal_section(section);
        if scan.date_or_text {
            if i == 0 {
                return None; // a date, time or text code: Excel leaves it
            }
            out.push(section.clone());
            continue;
        }
        let Some(last) = scan.last_digit.filter(|_| scan.has_zero_or_hash) else {
            out.push(section.clone());
            continue;
        };
        let mut chars: Vec<char> = section.chars().collect();
        if delta > 0 {
            match scan.decimal_point {
                Some(point) if point < last => chars.insert(last + 1, '0'),
                _ => {
                    chars.insert(last + 1, '0');
                    chars.insert(last + 1, '.');
                }
            }
            changed = true;
        } else {
            match scan.decimal_point {
                Some(point) if point < last => {
                    chars.remove(last);
                    // No digit placeholder left after the point: the point goes too.
                    let still_has_decimals = chars[point + 1..]
                        .iter()
                        .take_while(|c| matches!(c, '0' | '#' | '?'))
                        .next()
                        .is_some();
                    if !still_has_decimals {
                        chars.remove(point);
                    }
                    changed = true;
                }
                _ => {}
            }
        }
        out.push(chars.into_iter().collect());
    }
    if changed {
        Some(out.join(";"))
    } else {
        None
    }
}

/// Split a format code on the semicolons outside quotes, escapes and brackets.
fn split_code_sections(code: &str) -> Vec<String> {
    let mut sections = vec![String::new()];
    let mut in_quotes = false;
    let mut in_bracket = false;
    let mut escaped = false;
    for ch in code.chars() {
        if escaped {
            escaped = false;
            sections.last_mut().unwrap().push(ch);
            continue;
        }
        match ch {
            '\\' if !in_quotes => escaped = true,
            '"' if !in_bracket => in_quotes = !in_quotes,
            '[' if !in_quotes => in_bracket = true,
            ']' if !in_quotes => in_bracket = false,
            ';' if !in_quotes && !in_bracket => {
                sections.push(String::new());
                continue;
            }
            _ => {}
        }
        sections.last_mut().unwrap().push(ch);
    }
    sections
}

/// The digit placeholders of one custom-code section, by CHAR index.
#[derive(Debug, Default)]
struct DecimalSectionScan {
    /// The last `0`/`#`/`?` of the mantissa.
    last_digit: Option<usize>,
    /// Whether the mantissa has a `0` or `#`. A section whose only digit
    /// placeholders are `?` is not edited: Excel left the accounting zero
    /// section `"-"??` alone when it gave the other sections a decimal (live).
    has_zero_or_hash: bool,
    /// The mantissa's decimal point.
    decimal_point: Option<usize>,
    /// A date/time token or `@` outside literals.
    date_or_text: bool,
}

fn scan_decimal_section(section: &str) -> DecimalSectionScan {
    let chars: Vec<char> = section.chars().collect();
    let mut scan = DecimalSectionScan::default();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '"' => {
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    i += 1;
                }
            }
            '\\' | '_' | '*' => i += 1,
            '[' => {
                let start = i;
                while i < chars.len() && chars[i] != ']' {
                    i += 1;
                }
                // Elapsed time: [h], [mm], [ss].
                let body: String = chars[start + 1..i.min(chars.len())].iter().collect();
                let lower = body.to_ascii_lowercase();
                if !lower.is_empty() && lower.chars().all(|c| matches!(c, 'h' | 'm' | 's')) {
                    scan.date_or_text = true;
                }
            }
            'E' | 'e' if matches!(chars.get(i + 1), Some('+') | Some('-')) => break,
            '0' | '#' => {
                scan.last_digit = Some(i);
                scan.has_zero_or_hash = true;
            }
            '?' => scan.last_digit = Some(i),
            '.' => {
                if scan.decimal_point.is_none() {
                    scan.decimal_point = Some(i);
                }
            }
            '@' => scan.date_or_text = true,
            c if matches!(c.to_ascii_lowercase(), 'y' | 'm' | 'd' | 'h' | 's') => {
                scan.date_or_text = true
            }
            _ => {}
        }
        i += 1;
    }
    scan
}

/// Home > Number > Increase Decimal (`delta` = 1) / Decrease Decimal (-1).
///
/// The ACTIVE cell -- `(rows[0], cols[0])`; callers put the active cell's row
/// and column first -- decides the new format (`next_decimal_format`), and the
/// whole `rows` x `cols` selection receives it, as ONE undo step. When Excel
/// would change nothing (a date, text, an empty cell, no decimal left), the
/// command writes nothing, records nothing and leaves the document clean.
///
/// WHY THE BACKEND. The ribbon used to do this in TypeScript by regex over the
/// DISPLAY NAME (`/(\d+)\s*decimal/`) and always wrote a plain `0.0...`, so
/// Percent, Accounting, Currency, Scientific and Custom formats all turned
/// into plain numbers, dates turned into serial numbers, and General 1.2345
/// SHRANK to one decimal on "Increase" (survey number.md section 3). Doing it
/// on the typed `NumberFormat` keeps the kind, and a second parser of display
/// names in TypeScript would be the drift class behind BUG-0065.
///
/// SELECT ALL (review finding, 2026-10-04). Ctrl+A then Increase Decimal
/// sends all 1,048,576 rows and 16,384 columns, and this walked every one of
/// the 17.2 billion positions, materialising a cell and an undo entry for each.
/// A rectangular selection now goes through `plan_range_style` -- the planner
/// the border presets use -- so whole columns and whole rows are written as
/// row/column TIERS plus the cells that differ, and a partial rectangle too
/// large to style cell by cell is refused before any work. The protection gate
/// takes the RANGE form, which never enumerates the rectangle. A selection
/// that is not one rectangle is styled cell by cell under the same bound.
///
/// `sheet_indices`: with sheets GROUPED, the group (the active cell's format
/// decides for every sheet); gated whole and ONE undo step, as
/// `apply_formatting`.
///
/// THE WIRE (BUG-0354 follow-up). `rows` / `cols` arrive as a plain list or as
/// an [`crate::api_types::IndexRun`] `{ first, last }` ([`IndexListArg`]), the
/// way `apply_formatting`'s `FormattingParams` takes them, so Select All no
/// longer crosses the bridge as a million-element array. A run has lost which
/// line came first, so the frontend then names the active line on its own:
/// `active_row` / `active_col` (`activeRow` / `activeCol`), which must lie
/// inside the selection. Absent, the active cell is `(rows[0], cols[0])` as
/// before.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn adjust_number_format_decimals(
    state: State<AppState>,
    file_state: State<FileState>,
    rows: IndexListArg,
    cols: IndexListArg,
    delta: i32,
    active_row: Option<u32>,
    active_col: Option<u32>,
    sheet_indices: Option<Vec<usize>>,
    target: Option<CellTargetRef>,
) -> Result<FormattingResult, String> {
    adjust_number_format_decimals_from_wire(
        &state,
        &file_state,
        &rows.0,
        &cols.0,
        delta,
        (active_row, active_col),
        sheet_indices.as_deref().unwrap_or(&[]),
        target.as_ref(),
    )
}

/// The body of [`adjust_number_format_decimals`] below its Tauri arguments:
/// resolves the active cell -- the named `active` line where one is given
/// (refused outside the selection, before any guard is taken), else the
/// list's first entry -- and steps. No selection: nothing to do.
#[allow(clippy::too_many_arguments)]
pub(crate) fn adjust_number_format_decimals_from_wire(
    state: &AppState,
    file_state: &FileState,
    rows: &[u32],
    cols: &[u32],
    delta: i32,
    active: (Option<u32>, Option<u32>),
    group: &[usize],
    target: Option<&CellTargetRef>,
) -> Result<FormattingResult, String> {
    if delta != 1 && delta != -1 {
        return Err(format!("delta must be 1 or -1 (got {})", delta));
    }
    let resolve = |named: Option<u32>, list: &[u32], axis: &str| -> Result<Option<u32>, String> {
        match named {
            Some(line) if !list.contains(&line) => Err(format!(
                "The active {} ({}) is not inside the selection, so the decimal step was not applied.",
                axis,
                line + 1
            )),
            Some(line) => Ok(Some(line)),
            None => Ok(list.first().copied()),
        }
    };
    let (Some(active_row), Some(active_col)) = (resolve(active.0, rows, "row")?, resolve(active.1, cols, "column")?) else {
        return Ok(FormattingResult { cells: Vec::new(), styles: Vec::new() });
    };
    adjust_number_format_decimals_at(state, file_state, (active_row, active_col), rows, cols, delta, group, target)
}

/// `rows` and `cols` as ONE rectangle, when they are: each list holds every
/// index of one contiguous run exactly once, in any order (the Home tab sends
/// the active cell's row and column first). `None` otherwise.
fn rect_of_lists(rows: &[u32], cols: &[u32]) -> Option<CellRect> {
    fn run(list: &[u32]) -> Option<(u32, u32)> {
        // The common shape -- already ascending and contiguous, which is what a
        // whole column's million rows are -- is answered without a copy.
        if !list.is_empty() && list.windows(2).all(|w| w[0].checked_add(1) == Some(w[1])) {
            return Some((list[0], list[list.len() - 1]));
        }
        let mut sorted = list.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        let (first, last) = (*sorted.first()?, *sorted.last()?);
        (sorted.len() == list.len() && (last - first) as usize + 1 == sorted.len()).then_some((first, last))
    }
    let (r0, r1) = run(rows)?;
    let (c0, c1) = run(cols)?;
    Some(CellRect::new(r0, c0, r1, c1))
}

/// The cell-by-cell plan for a selection that is not one rectangle: every
/// listed position (once) whose style `apply` changes. The caller has bounded
/// the product.
fn plan_listed_cells(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    rows: &[u32],
    cols: &[u32],
    apply: &dyn Fn(&mut CellStyle),
) -> RangeStylePlan {
    let mut plan = RangeStylePlan::default();
    let positioned = |style: &mut CellStyle, _: EdgePosition| apply(style);
    let mut memo = DeltaMemo::new(styles, &positioned, false);
    let mut seen: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    for &row in rows {
        for &col in cols {
            if !seen.insert((row, col)) {
                continue;
            }
            let base = grid.effective_style_index(row, col);
            if let Planned::New(id) = memo.desired(&mut plan, base, EdgePosition::default()) {
                plan.cells.push(((row, col), id));
            }
        }
    }
    plan
}

pub(crate) fn adjust_number_format_decimals_core(
    state: &AppState,
    file_state: &FileState,
    rows: &[u32],
    cols: &[u32],
    delta: i32,
    group: &[usize],
) -> Result<FormattingResult, String> {
    adjust_number_format_decimals_on(state, file_state, rows, cols, delta, group, None)
}

/// [`adjust_number_format_decimals_core`] with an optional cell target (P3):
/// with `Some`, the step is decided from the BACKING sheet's active cell and
/// written ONLY there, inside the extent, gated by the host's protection. The
/// active cell is `(rows[0], cols[0])`.
pub(crate) fn adjust_number_format_decimals_on(
    state: &AppState,
    file_state: &FileState,
    rows: &[u32],
    cols: &[u32],
    delta: i32,
    group: &[usize],
    target: Option<&CellTargetRef>,
) -> Result<FormattingResult, String> {
    adjust_number_format_decimals_from_wire(state, file_state, rows, cols, delta, (None, None), group, target)
}

/// The decimal step with the ACTIVE cell resolved (by
/// [`adjust_number_format_decimals_from_wire`], which has checked `delta` and
/// that `active` lies inside the selection): `active` decides the new format,
/// `rows` x `cols` receives it.
#[allow(clippy::too_many_arguments)]
fn adjust_number_format_decimals_at(
    state: &AppState,
    file_state: &FileState,
    active: (u32, u32),
    rows: &[u32],
    cols: &[u32],
    delta: i32,
    group: &[usize],
    target: Option<&CellTargetRef>,
) -> Result<FormattingResult, String> {
    let unchanged = || FormattingResult { cells: Vec::new(), styles: Vec::new() };
    let (active_row, active_col) = active;
    // The shape decides the route; a scattered list too large to style cell
    // by cell is refused before any guard is taken.
    let rect = rect_of_lists(rows, cols);
    if rect.is_none() {
        let count = rows.len() as u64 * cols.len() as u64;
        if count > DENSE_BORDER_CELL_LIMIT {
            return Err(dense_limit_refusal(&NUMBER_FORMAT_WORDING, count));
        }
    }

    let resolved = resolve_style_target(state, target, !group.is_empty(), bounds_of_lists(rows, cols))?;
    let route = match &resolved {
        Some(t) => StyleTargets::Only(t),
        None => StyleTargets::Sheets { group, include_active: true },
    };

    let locks = StyleLocks::take(state);
    let (targets, report_sheet) = locks.route_targets(&route);
    // Decide from the ACTIVE cell OF THE SHEET WRITTEN (the backing sheet for a
    // cell target -- never the active sheet's cell at the same coordinates),
    // under the guards the write will use.
    let next = {
        let Some(decide_grid) = locks.sheet_grid(report_sheet) else {
            return Ok(unchanged());
        };
        let style = locks.styles.get(decide_grid.effective_style_index(active_row, active_col));
        let value = decide_grid.get_cell(active_row, active_col).map(|c| &c.value);
        next_decimal_format(&style.number_format, value, delta)
    };
    let Some(next) = next else {
        return Ok(unchanged());
    };

    // The same gates as apply_formatting, and only for a REAL change.
    gate_style_targets(state, &locks, &targets, route.cell_target(), StyleChange::Look, "format cells")?;

    let set_format = |style: &mut CellStyle| style.number_format = next.clone();
    let mut plans: Vec<(usize, RangeStylePlan)> = Vec::new();
    for &sheet in &targets {
        let Some(grid) = locks.sheet_grid(sheet) else { continue };
        let plan = match rect {
            Some(r) => plan_range_style(grid, &locks.styles, r, &|style, _| set_format(style), false, &NUMBER_FORMAT_WORDING)?,
            None => plan_listed_cells(grid, &locks.styles, rows, cols, &set_format),
        };
        if !plan.is_empty() {
            plans.push((sheet, plan));
        }
    }
    if plans.is_empty() {
        // Every position already shows that format: nothing to write.
        return Ok(unchanged());
    }

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let StyleLocks { grid, grids, styles, active_sheet } = locks;
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut undo_stack = state.undo_stack.lock().unwrap();

    let label = if delta > 0 { "Increase Decimal" } else { "Decrease Decimal" };
    let txn = undo_stack.begin_owned_transaction(label);
    let mut written = Vec::new();
    let mut used: Vec<usize> = Vec::new();
    for (sheet, plan) in plans {
        let outcome = if sheet == active_sheet {
            write_range_style_plan(&mut grid, grids.get_mut(active_sheet), &mut styles, &mut undo_stack, sheet, plan, label)
        } else if let Some(sheet_grid) = grids.get_mut(sheet) {
            write_range_style_plan(sheet_grid, None, &mut styles, &mut undo_stack, sheet, plan, label)
        } else {
            continue;
        };
        used.extend(outcome.cells.iter().map(|&(_, _, index)| index));
        used.extend(outcome.unreported_styles.iter().copied());
        if sheet == report_sheet {
            written = outcome.cells;
        }
    }
    undo_stack.commit_owned(txn);
    drop(undo_stack);

    // THE NEW FORMAT COMES FIRST (round-3 review rev3A#6). The wrapper records
    // `styles[0]`'s number format for the macro recorder (a Select All writes
    // tiers and no cell at all, so no written cell can name it). Every style
    // written for the selection carries `next`, but an almost-whole range's
    // EXCEPTIONS keep their OLD style (`plan_range_style`) -- often the
    // registry's memoised explicit default, whose LOWER index sorted it first,
    // and the recorder then recorded `numberFormat: "General"`. A stable sort
    // puts every style carrying `next` ahead of the rest.
    used.sort_unstable();
    used.dedup();
    used.sort_by_key(|&index| styles.get(index).number_format != next);
    let merges = report_merges(state, report_sheet, active_sheet);
    let report_grid = if report_sheet == active_sheet { &*grid } else { &grids[report_sheet] };
    Ok(formatting_result(state, report_grid, &styles, &written, &merges, Some(used)))
}

#[cfg(test)]
mod tests {
    use crate::api_types::StyleData;
    use engine::theme::ThemeDefinition;
    use engine::{CellStyle, TextRotation};

    /// StyleData.text_rotation as the app emits it for a given rotation
    /// (mirrors StyleData::from_cell_style, exercised through the real
    /// conversion below).
    fn emit(rotation: TextRotation) -> String {
        let mut style = CellStyle::default();
        style.text_rotation = rotation;
        StyleData::from_cell_style(&style, &ThemeDefinition::default()).text_rotation
    }

    /// The tests below assert ACCEPTED values, so they read the Ok side; the
    /// refusal of an unknown value is pinned on its own by
    /// `an_unknown_rotation_is_refused_instead_of_clearing_the_rotation`.
    fn parse_text_rotation(s: &str) -> TextRotation {
        super::parse_text_rotation(s).unwrap_or_else(|e| panic!("{s:?} was refused: {e}"))
    }

    /// THE round-trip: StyleData -> FormattingParams.text_rotation ->
    /// parse_text_rotation -> StyleData again. Every rotation the app can
    /// hold must survive the loop unchanged -- "rotate90"/"rotate270"/
    /// "custom:N" used to fall through to the integer parser and silently
    /// apply None.
    #[test]
    fn style_data_round_trips_over_the_full_vocabulary() {
        let vocabulary = [
            TextRotation::None,
            TextRotation::Rotate90,
            TextRotation::Rotate270,
            TextRotation::Custom(1),
            TextRotation::Custom(45),
            TextRotation::Custom(89),
            TextRotation::Custom(-1),
            TextRotation::Custom(-45),
            TextRotation::Custom(-89),
            // Stacked text, Excel's "Vertical Text" (emitted as "vertical").
            TextRotation::Vertical,
        ];
        for rotation in vocabulary {
            let emitted = emit(rotation);
            let parsed = parse_text_rotation(&emitted);
            assert_eq!(
                parsed, rotation,
                "StyleData \"{}\" must parse back to {:?}",
                emitted, rotation
            );
            // And the re-emitted form is byte-identical (canonical).
            assert_eq!(emit(parsed), emitted);
        }
    }

    /// The exact strings the FormatCells dialog emits (AlignmentTab
    /// ROTATION_OPTIONS) and the script surface validates (TEXT_ROTATIONS).
    #[test]
    fn dialog_vocabulary_is_accepted() {
        assert_eq!(parse_text_rotation("none"), TextRotation::None);
        assert_eq!(parse_text_rotation("rotate90"), TextRotation::Rotate90);
        assert_eq!(parse_text_rotation("rotate270"), TextRotation::Rotate270);
    }

    #[test]
    fn custom_prefix_is_accepted() {
        assert_eq!(parse_text_rotation("custom:45"), TextRotation::Custom(45));
        assert_eq!(parse_text_rotation("custom:-45"), TextRotation::Custom(-45));
        // Canonical collapse: a custom angle equal to a named variant becomes
        // that variant, so re-emission stays canonical.
        assert_eq!(parse_text_rotation("custom:0"), TextRotation::None);
        assert_eq!(parse_text_rotation("custom:90"), TextRotation::Rotate90);
        assert_eq!(parse_text_rotation("custom:-90"), TextRotation::Rotate270);
    }

    #[test]
    fn bare_integer_degrees_are_accepted() {
        assert_eq!(parse_text_rotation("45"), TextRotation::Custom(45));
        assert_eq!(parse_text_rotation("-30"), TextRotation::Custom(-30));
        assert_eq!(parse_text_rotation("0"), TextRotation::None);
        assert_eq!(parse_text_rotation("90"), TextRotation::Rotate90);
        assert_eq!(parse_text_rotation("-90"), TextRotation::Rotate270);
    }

    #[test]
    fn legacy_aliases_and_clamping() {
        assert_eq!(parse_text_rotation("up"), TextRotation::Rotate90);
        assert_eq!(parse_text_rotation("down"), TextRotation::Rotate270);
        assert_eq!(parse_text_rotation("270"), TextRotation::Rotate270);
        // Out-of-range angles clamp to the -90..90 band.
        assert_eq!(parse_text_rotation("120"), TextRotation::Rotate90);
        assert_eq!(parse_text_rotation("custom:120"), TextRotation::Rotate90);
        assert_eq!(parse_text_rotation("custom:-500"), TextRotation::Rotate270);
    }

    /// "vertical" is stacked text, and the API emits exactly that word.
    #[test]
    fn vertical_is_stacked_text_both_ways() {
        assert_eq!(parse_text_rotation("vertical"), TextRotation::Vertical);
        assert_eq!(parse_text_rotation("Vertical"), TextRotation::Vertical);
        assert_eq!(emit(TextRotation::Vertical), "vertical");
    }

    /// AN UNKNOWN VALUE IS AN ERROR, not `None`. `None` is not "leave it" --
    /// it CLEARS the rotation -- so a typo, or "vertical" before stacked text
    /// existed, silently flattened every selected cell.
    #[test]
    fn an_unknown_rotation_is_refused_instead_of_clearing_the_rotation() {
        for garbage in ["sideways", "stacked", "custom:", "custom:abc", "", "45deg"] {
            let verdict = super::parse_text_rotation(garbage);
            assert!(verdict.is_err(), "{garbage:?} must be refused, got {verdict:?}");
        }
    }

    // ------------------------------------------------------------------
    // BUG-0065: the number-format display names get_style emits must parse
    // back to the identical NumberFormat -- the Format Cells dialog sends the
    // loaded name straight back on OK, so a lossy loop silently reset
    // "Number (2 decimals, with separators)" to General and degraded
    // "Date (yyyy-mm-dd)" to a Custom format that RENDERED the name
    // ("15ate (2023-03-15)", the leading D consumed as a day token).
    // Measured live on 2026-08-14 before the fix.
    // ------------------------------------------------------------------
    use super::parse_number_format;
    use crate::api_types::format_number_format_name;
    use engine::{CurrencyPosition, NegativeStyle, NumberFormat};

    #[test]
    fn every_display_name_the_serializer_emits_round_trips() {
        let vocabulary = [
            NumberFormat::General,
            NumberFormat::Number { decimal_places: 2, use_thousands_separator: false },
            NumberFormat::Number { decimal_places: 2, use_thousands_separator: true },
            NumberFormat::Number { decimal_places: 0, use_thousands_separator: true },
            NumberFormat::Number { decimal_places: 5, use_thousands_separator: false },
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: "$".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Minus,
            },
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: "EUR".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Minus,
            },
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: "kr".to_string(),
                symbol_position: CurrencyPosition::After,
                negative_style: NegativeStyle::Minus,
            },
            // All four of Excel's "Negative numbers:" entries must survive the
            // loop, not just the default -- the negative clause is the newest
            // part of the name and the one a `rsplit_once(", ")` would eat.
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: "$".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Red,
            },
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: "$".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Parentheses,
            },
            NumberFormat::Currency {
                decimal_places: 0,
                symbol: "kr".to_string(),
                symbol_position: CurrencyPosition::After,
                negative_style: NegativeStyle::RedParentheses,
            },
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: "$".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Parentheses,
            },
            NumberFormat::Accounting {
                decimal_places: 0,
                symbol: "$".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Minus,
            },
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: "kr".to_string(),
                symbol_position: CurrencyPosition::After,
                negative_style: NegativeStyle::Minus,
            },
            // The Home tab's Comma Style and Accounting-menu shapes (CONTRACT
            // 3.7): an EMPTY symbol, the non-ASCII symbols, a multi-letter one,
            // a suffix one -- each under both regional negative patterns.
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: String::new(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Minus,
            },
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: String::new(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Parentheses,
            },
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: "\u{00A3}".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Minus,
            },
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: "\u{20AC}".to_string(),
                symbol_position: CurrencyPosition::After,
                negative_style: NegativeStyle::Parentheses,
            },
            NumberFormat::Accounting {
                decimal_places: 3,
                symbol: "\u{00A5}".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Minus,
            },
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: "CHF".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::RedParentheses,
            },
            // SUFFIX CURRENCIES THAT ARE NOT `kr`. The position used to be
            // reconstructed from the symbol text, so every one of these parsed
            // back as a PREFIX currency and moved the symbol to the other side
            // of the number on an untouched OK. Reading the user's Windows
            // regional settings (open-items 1.3) is what makes them reachable.
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: " z\u{0142}".to_string(),
                symbol_position: CurrencyPosition::After,
                negative_style: NegativeStyle::Minus,
            },
            NumberFormat::Currency {
                decimal_places: 0,
                symbol: " Ft".to_string(),
                symbol_position: CurrencyPosition::After,
                negative_style: NegativeStyle::Parentheses,
            },
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: "K\u{010D}".to_string(),
                symbol_position: CurrencyPosition::After,
                negative_style: NegativeStyle::Minus,
            },
            // ...and the same symbols BEFORE the number, so the clause is
            // proved to carry information rather than to be always present.
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: "z\u{0142} ".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Minus,
            },
            NumberFormat::Percentage { decimal_places: 0 },
            NumberFormat::Percentage { decimal_places: 2 },
            NumberFormat::Scientific { decimal_places: 2 },
            NumberFormat::Fraction { denominator: None, max_digits: 1 },
            NumberFormat::Fraction { denominator: None, max_digits: 3 },
            NumberFormat::Fraction { denominator: Some(2), max_digits: 1 },
            NumberFormat::Fraction { denominator: Some(8), max_digits: 1 },
            NumberFormat::Fraction { denominator: Some(16), max_digits: 2 },
            NumberFormat::Fraction { denominator: Some(100), max_digits: 2 },
            NumberFormat::Date { format: "yyyy-mm-dd".to_string() },
            NumberFormat::Date { format: "mm/dd/yyyy".to_string() },
            NumberFormat::Time { format: "hh:mm:ss".to_string() },
            NumberFormat::Time { format: "hh:mm:ss AM/PM".to_string() },
        ];
        for nf in vocabulary {
            let emitted = format_number_format_name(&nf);
            let parsed = parse_number_format(&emitted);
            assert_eq!(
                parsed, nf,
                "display name \"{}\" must parse back to {:?}",
                emitted, nf
            );
            // And re-emission is canonical (byte-identical name).
            assert_eq!(format_number_format_name(&parsed), emitted);
        }
    }

    /// The two live-measured corruption shapes stay dead: the separator name
    /// must not collapse to General, and the date name must not become a
    /// Custom format that renders its own text.
    #[test]
    fn the_untouched_ok_corruption_shapes_stay_dead() {
        assert_eq!(
            parse_number_format("Number (2 decimals, with separators)"),
            NumberFormat::Number { decimal_places: 2, use_thousands_separator: true }
        );
        assert_eq!(
            parse_number_format("Date (yyyy-mm-dd)"),
            NumberFormat::Date { format: "yyyy-mm-dd".to_string() }
        );
        assert_eq!(
            parse_number_format("Percentage (0 decimals)"),
            NumberFormat::Percentage { decimal_places: 0 }
        );
    }

    /// Custom formats serialize as their own format string and must keep
    /// taking the custom path, not the display-name path.
    #[test]
    fn custom_format_strings_still_parse_as_custom() {
        assert_eq!(
            parse_number_format("#,##0.00;[Red]-#,##0.00"),
            NumberFormat::Custom { format: "#,##0.00;[Red]-#,##0.00".to_string() }
        );
    }

    // ------------------------------------------------------------------
    // Home > Number dropdown (Excel parity, 2026-08-15)
    //
    // The ribbon used to send FORMAT CODES ("0.00", "#,##0.00", "@") from a
    // six-entry list whose third label was "Thousands" -- not an Excel entry
    // name -- with no Currency, no Accounting, no date, no time and no
    // fraction. Codes and preset keywords are disjoint vocabularies, so a code
    // survived only through the `_ =>` guessing arm; a date code would have
    // landed in Custom rather than Date.
    // ------------------------------------------------------------------
    use super::{parse_number_format_with_locale, RIBBON_NUMBER_FORMAT_PRESETS};
    use engine::LocaleSettings;

    fn se() -> LocaleSettings {
        LocaleSettings::from_locale_id("sv-SE")
    }

    /// Every dropdown entry must resolve to a REAL typed format. A keyword
    /// that fell through to the guessing arm would land in General (no format
    /// characters) and the entry would silently do nothing.
    #[test]
    fn every_ribbon_preset_resolves_to_a_typed_format() {
        for locale_id in ["en-US", "sv-SE", "de-DE", "ja-JP"] {
            let locale = LocaleSettings::from_locale_id(locale_id);
            for preset in RIBBON_NUMBER_FORMAT_PRESETS {
                let parsed = parse_number_format_with_locale(preset, &locale);
                if preset == "general" {
                    assert_eq!(parsed, NumberFormat::General);
                } else {
                    assert_ne!(
                        parsed,
                        NumberFormat::General,
                        "{} / {} fell through to General",
                        locale_id,
                        preset
                    );
                }
            }
        }
    }

    /// The dropdown's own vocabulary must round-trip through get_style the
    /// same way BUG-0065's did: the ribbon reads back a DISPLAY NAME and has
    /// to recognise which entry the cell is on.
    #[test]
    fn every_ribbon_preset_round_trips_through_the_display_name() {
        for locale_id in ["en-US", "sv-SE"] {
            let locale = LocaleSettings::from_locale_id(locale_id);
            for preset in RIBBON_NUMBER_FORMAT_PRESETS {
                let applied = parse_number_format_with_locale(preset, &locale);
                let name = format_number_format_name(&applied);
                assert_eq!(
                    parse_number_format_with_locale(&name, &locale),
                    applied,
                    "{} / {} did not survive the name round-trip ({})",
                    locale_id,
                    preset,
                    name
                );
            }
        }
    }

    /// The regional half. A hard-coded US date or `$` here is the defect
    /// BUG-0064 was: the surface advertising one region while the document
    /// renders another.
    #[test]
    fn regional_presets_follow_the_locale() {
        let se = se();
        assert_eq!(
            parse_number_format_with_locale("date_short", &se),
            NumberFormat::Date { format: "YYYY-MM-DD".to_string() }
        );
        assert_eq!(
            parse_number_format_with_locale("date_long", &se),
            NumberFormat::Date { format: "\"den \"d mmmm yyyy".to_string() }
        );
        assert_eq!(
            parse_number_format_with_locale("time", &se),
            NumberFormat::Time { format: "hh:mm:ss".to_string() }
        );
        assert_eq!(
            parse_number_format_with_locale("currency", &se),
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: " kr".to_string(),
                symbol_position: CurrencyPosition::After,
                negative_style: NegativeStyle::Minus,
            }
        );
        // Accounting draws the symbol as its own column, so it takes the bare
        // symbol -- the currency preset's leading space would double up.
        assert_eq!(
            parse_number_format_with_locale("accounting", &se),
            NumberFormat::Accounting {
                decimal_places: 2,
                symbol: "kr".to_string(),
                symbol_position: CurrencyPosition::After,
                // sv-SE's accounting pattern: a leading minus (live probe).
                negative_style: NegativeStyle::Minus,
            }
        );

        let us = LocaleSettings::invariant();
        assert_eq!(
            parse_number_format_with_locale("date_short", &us),
            NumberFormat::Date { format: "MM/DD/YYYY".to_string() }
        );
        assert_eq!(
            parse_number_format_with_locale("currency", &us),
            NumberFormat::Currency {
                decimal_places: 2,
                symbol: "$".to_string(),
                symbol_position: CurrencyPosition::Before,
                negative_style: NegativeStyle::Minus,
            }
        );
        assert_eq!(
            parse_number_format_with_locale("time", &us),
            NumberFormat::Time { format: "h:mm:ss AM/PM".to_string() }
        );
    }

    /// The non-regional half is identical in every locale (only the SEPARATORS
    /// move, and those live in the formatter, not the format).
    #[test]
    fn non_regional_presets_are_locale_invariant() {
        for preset in ["general", "number", "percentage", "fraction_1", "scientific", "text"] {
            assert_eq!(
                parse_number_format_with_locale(preset, &se()),
                parse_number_format_with_locale(preset, &LocaleSettings::invariant()),
                "{} must not depend on the locale",
                preset
            );
        }
        // Excel's Number entry is `0.00` -- fixed 2 decimals, NO separator.
        assert_eq!(
            parse_number_format_with_locale("number", &se()),
            NumberFormat::Number { decimal_places: 2, use_thousands_separator: false }
        );
        // Excel's Text entry is the one-section `@` format.
        assert_eq!(
            parse_number_format_with_locale("text", &se()),
            NumberFormat::Custom { format: "@".to_string() }
        );
    }

    /// What each entry actually RENDERS on the app's own sv-SE test locale.
    /// These are the strings measured live in the app; if the formatter or the
    /// locale table moves, this is the pin that says so.
    #[test]
    fn swedish_ribbon_presets_render_excel_shapes() {
        let se = se();
        let render = |preset: &str, value: f64| {
            engine::format_number(value, &parse_number_format_with_locale(preset, &se), &se)
        };
        let nbsp = '\u{00A0}';
        assert_eq!(render("general", 1234.5678), "1234,5678");
        assert_eq!(render("number", 1234.5678), "1234,57");
        assert_eq!(render("currency", 1234.5678), format!("1{}234,57 kr", nbsp));
        assert_eq!(render("accounting", 1234.5678), format!("1{}234,57  kr", nbsp));
        assert_eq!(render("date_short", 45306.0), "2024-01-15");
        assert_eq!(render("date_long", 45306.0), "den 15 januari 2024");
        assert_eq!(render("time", 45306.5625), "13:30:00");
        assert_eq!(render("percentage", 1234.5678), "123456,78%");
        assert_eq!(render("fraction_1", 1234.5678), "1234 4/7");
        assert_eq!(render("scientific", 1234.5678), "1,23E+03");
        assert_eq!(render("text", 1234.5678), "1234,5678");
    }

    /// The same eleven entries on en-US, so a regression that hard-codes ONE
    /// region is visible from either side.
    #[test]
    fn us_ribbon_presets_render_excel_shapes() {
        let us = LocaleSettings::invariant();
        let render = |preset: &str, value: f64| {
            engine::format_number(value, &parse_number_format_with_locale(preset, &us), &us)
        };
        assert_eq!(render("number", 1234.5678), "1234.57");
        assert_eq!(render("currency", 1234.5678), "$1,234.57");
        assert_eq!(render("date_short", 45306.0), "01/15/2024");
        assert_eq!(render("date_long", 45306.0), "Monday, January 15, 2024");
        assert_eq!(render("time", 45306.5625), "1:30:00 PM");
    }

    /// The list itself: Excel's entries, in Excel's order, with Special and
    /// Custom (Format Cells categories, not dropdown rows) absent.
    #[test]
    fn the_dropdown_is_excels_list_in_excels_order() {
        assert_eq!(
            RIBBON_NUMBER_FORMAT_PRESETS,
            [
                "general",
                "number",
                "currency",
                "accounting",
                "date_short",
                "date_long",
                "time",
                "percentage",
                "fraction_1",
                "scientific",
                "text",
            ]
        );
    }
}

/// The Home-tab programme's backend tests (2026-10-04): half-point sizes,
/// stacked text, the Comma/Accounting presets, Increase/Decrease Decimal and
/// border presets over tiers, whole axes, Select All and grouped sheets.
#[cfg(test)]
#[path = "format_home_tests.rs"]
mod format_home_tests;
