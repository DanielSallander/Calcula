//! FILENAME: app/src-tauri/src/commands/styles.rs
// PURPOSE: Styling operations, formatting, and style definitions.

use crate::api_types::{CellData, FillParam, FormattingParams, FormattingResult, PreviewResult, StyleData, StyleEntry};
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
#[tauri::command]
pub fn set_cell_style(
    state: State<AppState>,
    file_state: State<FileState>,
    row: u32,
    col: u32,
    style_index: usize,
) -> Result<Option<CellData>, String> {
    // Sheet protection, before any lock below.
    //
    // Returns Result (it used to return a bare Option) so a refusal can reach
    // the user. This command takes an ARBITRARY style index and is reachable
    // from Format Painter and Paste-Formats, so once `CellStyle.locked` is
    // authoritative it becomes the sharpest unlock vector there is: painting
    // format from an unlocked cell onto a locked one would otherwise silently
    // unlock it on a protected sheet.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_protection_range(
            &state, active_sheet, row, col, row, col,
        )?;
        // The two protection axes are additive: this is FORMATTING, so the
        // formatCells option flag applies exactly as it does in apply_formatting.
        crate::protection::check_sheet_action(&state, active_sheet, "formatCells", "format cells")?;
    }

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Record previous state for undo
    let previous_cell = grid.get_cell(row, col).cloned();

    // Get merge span info
    let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
    let (row_span, col_span) = if let Some(region) = merge_info {
        (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
    } else {
        (1, 1)
    };

    Ok(if let Some(cell) = grid.get_cell(row, col) {
        let mut updated_cell = cell.clone();
        updated_cell.style_index = style_index;
        grid.set_cell(row, col, updated_cell.clone());

        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, updated_cell.clone());
        }

        // Record undo
        undo_stack.record_cell_change(active_sheet, row, col, previous_cell);

        // The cell keeps its OWN index (written above); what is DISPLAYED is the
        // resolved one, so an index of 0 falls back to the row/column tier.
        let effective_style_index = grid.effective_style_index(row, col);
        let style = styles.get(effective_style_index);
        let result = format_cell_value_with_color(&updated_cell.value, style, &locale);

        let accounting_layout = result.accounting.map(|a| crate::api_types::AccountingLayout {
            symbol: a.symbol,
            symbol_before: a.symbol_before,
            value: a.value,
        });

        // Mark workbook as dirty
        let _ = crate::document_effect::DocumentEffect::mutates(&file_state);

        Some(CellData {
            row,
            col,
            display: result.text, overflow: result.overflow,
            display_color: result.color,
            formula: updated_cell.formula_string().map(|f| format!("={}", f)),
            style_index: effective_style_index,
            row_span,
            col_span,
            sheet_index: None,
            rich_text: None,
            accounting_layout,
        })
    } else {
        // Create a new empty cell with the style
        let cell = Cell {
            value: CellValue::Empty,
            ast: None,
            style_index,
            rich_text: None,
        };
        grid.set_cell(row, col, cell.clone());

        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, cell);
        }

        // Record undo (previous was None since cell didn't exist)
        undo_stack.record_cell_change(active_sheet, row, col, previous_cell);

        // Mark workbook as dirty
        let _ = crate::document_effect::DocumentEffect::mutates(&file_state);

        // Displayed index resolves the row/column tiers; the cell above keeps
        // the caller's explicit index.
        let effective_style_index = grid.effective_style_index(row, col);

        Some(CellData {
            row,
            col,
            display: String::new(),
            // Empty: nothing to overflow, and text never marks.
            overflow: crate::api_types::OverflowClass::Text,
            display_color: None,
            formula: None,
            style_index: effective_style_index,
            row_span,
            col_span,
            sheet_index: None,
            rich_text: None,
            accounting_layout: None,
        })
    })
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
#[tauri::command]
pub fn apply_formatting(
    state: State<AppState>,
    file_state: State<FileState>,
    params: FormattingParams,
    sheet_indices: Option<Vec<usize>>,
) -> Result<FormattingResult, String> {
    apply_formatting_core(&state, &file_state, &params, sheet_indices.as_deref().unwrap_or(&[]))
}

/// `apply_formatting` without the Tauri wrappers, so the tests drive the real
/// body. `group` is the grouped sheets (the active sheet is always formatted).
pub(crate) fn apply_formatting_core(
    state: &AppState,
    file_state: &FileState,
    params: &FormattingParams,
    group: &[usize],
) -> Result<FormattingResult, String> {
    // Refusable VALUES first (see `ParsedFormatting`), then the gates.
    let parsed = {
        let locale = state.locale.lock().unwrap();
        ParsedFormatting::parse(params, &locale)?
    };
    format_cells_on_sheets(state, file_state, &parsed, &params.rows, &params.cols, group, true)
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
}

/// What a style command's protection gate is asked about.
#[derive(Clone, Copy)]
enum StyleArea<'p> {
    /// A rectangle: the RANGE form of the gate, which never enumerates it
    /// (Select All is 17.2 billion positions).
    Range(CellRect),
    /// Listed rows x columns: the cell form (the caller bounds the product).
    Cells { rows: &'p [u32], cols: &'p [u32] },
}

/// Gate EVERY target sheet -- the formatCells option and the locked cells --
/// against the HELD guards, before anything is written: one protected sheet
/// refuses the whole group. `what` names the operation in the refusal.
fn gate_style_targets(
    state: &AppState,
    locks: &StyleLocks<'_>,
    targets: &[usize],
    area: StyleArea<'_>,
    what: &str,
) -> Result<(), String> {
    // After the style registry, released before the undo stack is taken: the
    // order search.rs's held-guard gates use.
    let sheet_kinds = state.sheet_kinds.read().unwrap();
    let protection = state.sheet_protection.read().unwrap();
    for &sheet in targets {
        let Some(grid) = locks.sheet_grid(sheet) else { continue };
        crate::protection::check_sheet_action_in(&sheet_kinds, &protection, sheet, "formatCells", what)?;
        match area {
            StyleArea::Range(rect) => crate::protection::check_sheet_protection_range_in(
                &sheet_kinds,
                &protection,
                grid,
                &locks.styles,
                sheet,
                rect.start_row,
                rect.start_col,
                rect.end_row,
                rect.end_col,
            )?,
            StyleArea::Cells { rows, cols } => crate::protection::check_sheet_protection_cells_in(
                &sheet_kinds,
                &protection,
                grid,
                &locks.styles,
                sheet,
                rows.iter().flat_map(move |r| cols.iter().map(move |c| (*r, *c))),
            )?,
        }
    }
    Ok(())
}

/// The body of `apply_formatting` and `apply_formatting_to_sheets`: gate every
/// target sheet under the held guards, then walk `rows` x `cols` on each of
/// them inside ONE owned undo transaction (or the step a caller holds open).
/// Returns the ACTIVE sheet's written cells and the styles they use.
fn format_cells_on_sheets(
    state: &AppState,
    file_state: &FileState,
    parsed: &ParsedFormatting<'_>,
    rows: &[u32],
    cols: &[u32],
    group: &[usize],
    include_active: bool,
) -> Result<FormattingResult, String> {
    let locks = StyleLocks::take(state);
    let targets = locks.targets(group, include_active);
    gate_style_targets(state, &locks, &targets, StyleArea::Cells { rows, cols }, "format cells")?;
    if targets.is_empty() {
        // Nothing to format (a group of only the active sheet, or indices past
        // the workbook): nothing written, and the document stays clean -- this
        // used to construct the effect regardless.
        return Ok(FormattingResult { cells: Vec::new(), styles: Vec::new() });
    }

    // Every gate has passed; from here this command commits. Constructed HERE
    // so a refusal cannot leave a spuriously dirty document.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let StyleLocks { grid, grids, styles, active_sheet } = locks;
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut undo_stack = state.undo_stack.lock().unwrap();

    let label = format!("Format {} cells", rows.len() * cols.len());
    // Joins a step the caller holds open (a script's undo batch).
    let txn = undo_stack.begin_owned_transaction(label);
    let delta = |style: &mut CellStyle| parsed.apply(style);
    let mut written = Vec::new();
    for &sheet in &targets {
        if sheet == active_sheet {
            written = write_style_delta(
                &mut grid,
                grids.get_mut(active_sheet),
                &mut styles,
                &mut undo_stack,
                sheet,
                rows,
                cols,
                &delta,
            );
        } else if let Some(sheet_grid) = grids.get_mut(sheet) {
            write_style_delta(sheet_grid, None, &mut styles, &mut undo_stack, sheet, rows, cols, &delta);
        }
    }
    undo_stack.commit_owned(txn);
    drop(undo_stack);

    let mut used: Vec<usize> = written.iter().map(|&(_, _, index)| index).collect();
    used.sort_unstable();
    used.dedup();
    Ok(formatting_result(state, &grid, &styles, &written, Some(used)))
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
/// for every written ACTIVE-sheet cell, and the styles -- `Some(indices)` for
/// just those, `None` for the WHOLE registry (a tier's style is referenced by
/// no returned cell, and the style cache must still know it to paint the
/// column). Takes the merges, the locale and the theme after the caller's held
/// guards, the order every style command has always used.
fn formatting_result(
    state: &AppState,
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    written: &[(u32, u32, usize)],
    returned_styles: Option<Vec<usize>>,
) -> FormattingResult {
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();
    let merge_at: std::collections::HashMap<(u32, u32), (u32, u32)> = merged_regions
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
    drop(merged_regions);

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
    format_cells_on_sheets(state, file_state, &parsed, &params.rows, &params.cols, sheet_indices, false).map(|_| ())
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
#[tauri::command]
pub fn set_cell_rich_text(
    state: State<AppState>,
    file_state: State<FileState>,
    row: u32,
    col: u32,
    runs: Option<Vec<crate::api_types::RichTextRunData>>,
) -> Result<Option<CellData>, String> {
    // Sheet protection, before any lock below. Rich text is cell CONTENT.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_protection_range(&state, active_sheet, row, col, row, col)?;
    }

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Record undo
    let previous = grid.get_cell(row, col).cloned();
    undo_stack.record_cell_change(active_sheet, row, col, previous);

    // Get or create the cell, update rich_text
    let engine_runs = runs.as_ref().map(|r| crate::api_types::data_to_rich_text_runs(r));
    let mut cell = grid.get_cell(row, col).cloned().unwrap_or_else(Cell::new);
    cell.rich_text = engine_runs;
    grid.set_cell(row, col, cell);

    // Sync to grids vector
    if active_sheet < grids.len() {
        if let Some(c) = grid.get_cell(row, col) {
            grids[active_sheet].set_cell(row, col, c.clone());
        }
    }

    // Build response
    let Some(cell) = grid.get_cell(row, col) else {
        return Ok(None);
    };
    let effective_style_index = grid.effective_style_index(row, col);
    let style = styles.get(effective_style_index);
    let result = format_cell_value_with_color(&cell.value, style, &locale);
    let accounting_layout = result.accounting.map(|a| crate::api_types::AccountingLayout {
        symbol: a.symbol,
        symbol_before: a.symbol_before,
        value: a.value,
    });
    let (row_span, col_span) = match merged_regions
        .iter()
        .find(|m| m.start_row == row && m.start_col == col)
    {
        Some(m) => (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1),
        None => (1, 1),
    };

    // Mark workbook as dirty
    let _ = crate::document_effect::DocumentEffect::mutates(&file_state);

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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    fn new(preset: &str, style: &str, color: &str, width: u8) -> Result<Self, String> {
        let preset = BorderPreset::parse(preset)?;
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
}

/// A rectangle smaller than whole rows or whole columns is styled cell by
/// cell; above this many cells it is refused rather than materialised (a
/// Calcula-only bound -- Excel has none). Whole rows, whole columns and Select
/// All never reach it: they go through the row/column TIERS.
const DENSE_BORDER_CELL_LIMIT: u64 = 4_000_000;

/// Where a whole-row/whole-column preset crosses the OTHER axis's tiers, each
/// crossing needs its own cell (the row tier outranks the column tier, so the
/// new tier would not reach it). Above this many crossings the command is
/// refused rather than materialising them. The precedent is the 250,000 guard
/// in `protection.rs`'s tier planner, which instead SKIPS the crossings -- a
/// silent gap that is tolerable for a lock bit and is not for a visible border.
const BORDER_TIER_CROSSING_LIMIT: u64 = 2_000_000;

/// Everything a border preset will WRITE, decided before anything is touched,
/// so a refusal (too many cells, too many crossings) costs nothing.
#[derive(Debug, Default)]
struct RangeStylePlan {
    /// Explicit cell styles: ((row, col), style).
    cells: Vec<((u32, u32), CellStyle)>,
    /// New column-tier styles: (col, style).
    column_tiers: Vec<(u32, CellStyle)>,
    /// New row-tier styles: (row, style).
    row_tiers: Vec<(u32, CellStyle)>,
}

impl RangeStylePlan {
    fn is_empty(&self) -> bool {
        self.cells.is_empty() && self.column_tiers.is_empty() && self.row_tiers.is_empty()
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
///    (the row tier outranks the column, so the column change would not show);
///  - a cell is written only when what it would SHOW without one differs from
///    what the preset asks for, so `allBorders` over a plain column writes one
///    tier entry and no cells at all.
/// Whole rows are the same with the axes swapped -- except that the new ROW
/// tier then outranks every column tier it crosses, so those crossings are
/// written to keep the column's own format.
fn plan_border_preset(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    rect: CellRect,
    delta: &BorderPresetDelta,
) -> Result<RangeStylePlan, String> {
    plan_range_style(grid, styles, rect, &|style, position| delta.apply(style, position), &BORDER_WORDING)
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

/// The planner behind the border presets AND Increase/Decrease Decimal: what
/// `apply` does to every position of `rect` (it is told where the position
/// sits on the rectangle's edge; a delta that does not care ignores it), with
/// whole columns and whole rows written through the style TIERS. See
/// `plan_border_preset` for the tier rules; they do not depend on the delta.
fn plan_range_style(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    rect: CellRect,
    apply: &dyn Fn(&mut CellStyle, EdgePosition),
    wording: &PlanWording,
) -> Result<RangeStylePlan, String> {
    let mut plan = RangeStylePlan::default();
    let desired_at = |row: u32, col: u32| -> (CellStyle, bool) {
        let before = styles.get(grid.effective_style_index(row, col));
        let mut desired = before.clone();
        apply(&mut desired, rect.position(row, col));
        let changed = desired != *before;
        (desired, changed)
    };

    let tier_is_column = rect.whole_columns();
    if !tier_is_column && !rect.whole_rows() {
        let count = rect.rows() * rect.cols();
        if count > DENSE_BORDER_CELL_LIMIT {
            return Err(dense_limit_refusal(wording, count));
        }
        for row in rect.start_row..=rect.end_row {
            for col in rect.start_col..=rect.end_col {
                let (desired, changed) = desired_at(row, col);
                if changed {
                    plan.cells.push(((row, col), desired));
                }
            }
        }
        return Ok(plan);
    }

    // ---- Tier path: whole columns (Select All included) or whole rows ----
    let mut new_tier: std::collections::HashMap<u32, CellStyle> = std::collections::HashMap::new();
    if tier_is_column {
        for col in rect.start_col..=rect.end_col {
            let current = styles.get(grid.column_styles.get(&col).copied().unwrap_or(0));
            let mut next = current.clone();
            let interior = EdgePosition {
                top: false,
                bottom: false,
                left: col == rect.start_col,
                right: col == rect.end_col,
            };
            apply(&mut next, interior);
            if next != *current {
                new_tier.insert(col, next.clone());
                plan.column_tiers.push((col, next));
            }
        }
    } else {
        for row in rect.start_row..=rect.end_row {
            let current = styles.get(grid.row_styles.get(&row).copied().unwrap_or(0));
            let mut next = current.clone();
            let interior = EdgePosition {
                top: row == rect.start_row,
                bottom: row == rect.end_row,
                left: false,
                right: false,
            };
            apply(&mut next, interior);
            if next != *current {
                new_tier.insert(row, next.clone());
                plan.row_tiers.push((row, next));
            }
        }
    }

    // The positions whose style may differ from the tier after the change.
    let crossing: Vec<u32> = if tier_is_column {
        grid.row_styles
            .iter()
            .filter(|(r, idx)| **idx != 0 && **r >= rect.start_row && **r <= rect.end_row)
            .map(|(r, _)| *r)
            .collect()
    } else {
        grid.column_styles
            .iter()
            .filter(|(c, idx)| **idx != 0 && **c >= rect.start_col && **c <= rect.end_col)
            .map(|(c, _)| *c)
            .collect()
    };
    let span = if tier_is_column { rect.cols() } else { rect.rows() };
    let crossings = crossing.len() as u64 * span;
    if crossings > BORDER_TIER_CROSSING_LIMIT {
        return Err(format!(
            "{} would have to be written to {} separate cells where whole-{} \
             formats cross; select a smaller range.",
            wording.crossing,
            crossings,
            if tier_is_column { "row" } else { "column" }
        ));
    }

    let mut candidates: std::collections::BTreeSet<(u32, u32)> = grid
        .cells
        .keys()
        .copied()
        .filter(|&(r, c)| rect.contains(r, c))
        .collect();
    if tier_is_column {
        for col in rect.start_col..=rect.end_col {
            candidates.insert((rect.start_row, col));
            candidates.insert((rect.end_row, col));
            for &row in &crossing {
                candidates.insert((row, col));
            }
        }
    } else {
        for row in rect.start_row..=rect.end_row {
            candidates.insert((row, rect.start_col));
            candidates.insert((row, rect.end_col));
            for &col in &crossing {
                candidates.insert((row, col));
            }
        }
    }

    for (row, col) in candidates {
        let (desired, _) = desired_at(row, col);
        let own_style = grid.get_cell(row, col).map_or(0, |c| c.style_index);
        let before = styles.get(grid.effective_style_index(row, col));
        // What this position SHOWS after the tier entries land, if no cell
        // style is written for it. A cell's own style outranks every tier; a
        // row tier outranks a column tier.
        let after: &CellStyle = if own_style != 0 {
            before
        } else if tier_is_column {
            if grid.row_styles.get(&row).copied().unwrap_or(0) != 0 {
                before
            } else {
                new_tier.get(&col).unwrap_or(before)
            }
        } else {
            new_tier.get(&row).unwrap_or(before)
        };
        if desired != *after {
            plan.cells.push(((row, col), desired));
        }
    }
    Ok(plan)
}

/// The refusal for a cell-by-cell style write past [`DENSE_BORDER_CELL_LIMIT`].
fn dense_limit_refusal(wording: &PlanWording, count: u64) -> String {
    format!(
        "{} can be applied to at most {} cells at once ({} selected). \
         Select whole rows or whole columns, or a smaller range.",
        wording.dense, DENSE_BORDER_CELL_LIMIT, count
    )
}

/// What `write_range_style_plan` wrote: the cells (with their new style
/// index) and the style indices its tier entries now use.
struct WrittenPlan {
    cells: Vec<(u32, u32, usize)>,
    tier_styles: Vec<usize>,
}

/// Write a `RangeStylePlan` to one sheet: tiers first (with their undo
/// snapshot), then cells. `mirror` is the second copy of the ACTIVE sheet
/// (`grids[active]` beside `state.grid`); both must change or the readers that
/// resolve against the other copy would not see the borders. Returns the
/// cells written, with their new style index.
fn write_range_style_plan(
    grid: &mut engine::Grid,
    mut mirror: Option<&mut engine::Grid>,
    styles: &mut engine::StyleRegistry,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    plan: RangeStylePlan,
    label: &str,
) -> WrittenPlan {
    let mut tier_styles = Vec::new();
    for (is_column, entries) in [(true, plan.column_tiers), (false, plan.row_tiers)] {
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
        for (idx, style) in entries {
            // EXPLICIT: a tier whose style equals the default would otherwise
            // intern to 0, which `set_column_style` reads as "clear the tier".
            let style_index = styles.get_or_create_explicit(style);
            tier_styles.push(style_index);
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

    let mut written = Vec::with_capacity(plan.cells.len());
    for ((row, col), style) in plan.cells {
        // Under a tier (after the tier writes above), a style equal to the
        // default must still be EXPLICIT: index 0 means "inherit".
        let under_tier = grid.row_styles.get(&row).copied().unwrap_or(0) != 0
            || grid.column_styles.get(&col).copied().unwrap_or(0) != 0;
        let style_index = if under_tier {
            styles.get_or_create_explicit(style)
        } else {
            styles.get_or_create(style)
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
        written.push((row, col, style_index));
    }
    tier_styles.sort_unstable();
    tier_styles.dedup();
    WrittenPlan { cells: written, tier_styles }
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
) -> Result<FormattingResult, String> {
    apply_border_preset_core(
        &state,
        &file_state,
        CellRect::new(start_row, start_col, end_row, end_col),
        &preset,
        &style,
        &color,
        width,
        sheet_indices.as_deref().unwrap_or(&[]),
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
    border_preset_on_sheets(state, file_state, rect, preset, style, color, width, group, true)
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
    border_preset_on_sheets(state, file_state, rect, preset, style, color, width, sheet_indices, false).map(|_| ())
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
    group: &[usize],
    include_active: bool,
) -> Result<FormattingResult, String> {
    // An unknown preset or style is refused before any guard is taken.
    let delta = BorderPresetDelta::new(preset, style, color, width)?;

    let locks = StyleLocks::take(state);
    let targets = locks.targets(group, include_active);
    gate_style_targets(state, &locks, &targets, StyleArea::Range(rect), "apply borders")?;
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
        if sheet == active_sheet {
            written = write_range_style_plan(
                &mut grid,
                grids.get_mut(active_sheet),
                &mut styles,
                &mut undo_stack,
                sheet,
                plan,
                &label,
            )
            .cells;
        } else if let Some(sheet_grid) = grids.get_mut(sheet) {
            write_range_style_plan(sheet_grid, None, &mut styles, &mut undo_stack, sheet, plan, &label);
        }
    }
    undo_stack.commit_owned(txn);
    drop(undo_stack);

    // The WHOLE registry: a tier's style is referenced by no returned cell, and
    // the frontend's style cache must still know it to paint the column.
    Ok(formatting_result(state, &grid, &styles, &written, None))
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
#[tauri::command]
pub fn adjust_number_format_decimals(
    state: State<AppState>,
    file_state: State<FileState>,
    rows: Vec<u32>,
    cols: Vec<u32>,
    delta: i32,
    sheet_indices: Option<Vec<usize>>,
) -> Result<FormattingResult, String> {
    adjust_number_format_decimals_core(&state, &file_state, &rows, &cols, delta, sheet_indices.as_deref().unwrap_or(&[]))
}

/// `rows` and `cols` as ONE rectangle, when they are: each list holds every
/// index of one contiguous run exactly once, in any order (the Home tab sends
/// the active cell's row and column first). `None` otherwise.
fn rect_of_lists(rows: &[u32], cols: &[u32]) -> Option<CellRect> {
    fn run(list: &[u32]) -> Option<(u32, u32)> {
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
    let mut seen: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    for &row in rows {
        for &col in cols {
            if !seen.insert((row, col)) {
                continue;
            }
            let before = styles.get(grid.effective_style_index(row, col));
            let mut desired = before.clone();
            apply(&mut desired);
            if desired != *before {
                plan.cells.push(((row, col), desired));
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
    if delta != 1 && delta != -1 {
        return Err(format!("delta must be 1 or -1 (got {})", delta));
    }
    let unchanged = || FormattingResult { cells: Vec::new(), styles: Vec::new() };
    let (Some(&active_row), Some(&active_col)) = (rows.first(), cols.first()) else {
        return Ok(unchanged());
    };
    // The shape decides the route; a scattered list too large to style cell
    // by cell is refused before any guard is taken.
    let rect = rect_of_lists(rows, cols);
    if rect.is_none() {
        let count = rows.len() as u64 * cols.len() as u64;
        if count > DENSE_BORDER_CELL_LIMIT {
            return Err(dense_limit_refusal(&NUMBER_FORMAT_WORDING, count));
        }
    }

    let locks = StyleLocks::take(state);
    // Decide from the ACTIVE cell, under the guards the write will use.
    let next = {
        let style = locks.styles.get(locks.grid.effective_style_index(active_row, active_col));
        let value = locks.grid.get_cell(active_row, active_col).map(|c| &c.value);
        next_decimal_format(&style.number_format, value, delta)
    };
    let Some(next) = next else {
        return Ok(unchanged());
    };

    // The same gates as apply_formatting, and only for a REAL change.
    let targets = locks.targets(group, true);
    let area = match rect {
        Some(r) => StyleArea::Range(r),
        None => StyleArea::Cells { rows, cols },
    };
    gate_style_targets(state, &locks, &targets, area, "format cells")?;

    let set_format = |style: &mut CellStyle| style.number_format = next.clone();
    let mut plans: Vec<(usize, RangeStylePlan)> = Vec::new();
    for &sheet in &targets {
        let Some(grid) = locks.sheet_grid(sheet) else { continue };
        let plan = match rect {
            Some(r) => plan_range_style(grid, &locks.styles, r, &|style, _| set_format(style), &NUMBER_FORMAT_WORDING)?,
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
        used.extend(outcome.tier_styles.iter().copied());
        if sheet == active_sheet {
            written = outcome.cells;
        }
    }
    undo_stack.commit_owned(txn);
    drop(undo_stack);

    // Every style returned carries the new format (cells' and tiers' alike, on
    // every sheet written): the wrapper records `styles[0]` for the macro
    // recorder, and a Select All writes tiers and no cell at all.
    used.sort_unstable();
    used.dedup();
    Ok(formatting_result(state, &grid, &styles, &written, Some(used)))
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
