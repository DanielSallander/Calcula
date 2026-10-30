//! FILENAME: app/src-tauri/src/commands/format_home_tests.rs
//! PURPOSE: The backend half of "Home tab = Excel's Home tab" (2026-10-04,
//! rust-format lane): half-point font sizes, stacked text, the Comma and
//! Accounting-menu presets, Increase/Decrease Decimal, and border presets
//! under row/column defaults and over whole rows, whole columns and Select All.
//!
//! A CHILD module of `commands::styles` (declared with `#[path]` there), so it
//! drives the real command bodies (`*_core`) and the private planners in-process
//! with no Tauri runtime.
//!
//! Excel facts quoted here were measured live on Excel 16 (sv-SE regional
//! settings, fresh hidden instances started and closed by the probe) on
//! 2026-10-04; the probe scripts and their output are in the lane's scratchpad
//! (`rustfmt-probe/probe1.ps1`, `probe2.ps1`) and in survey number.md.

use super::*;
use crate::api_types::{format_number_format_name, FormattingParams};
use crate::persistence::{FileState, UserFilesState};
use engine::{CellValue, LocaleSettings};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// The smallest workbook the command bodies need: `sheets` grid sheets, sheet
/// 0 active, plus the side stores Undo's real restore path takes.
struct Book {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    pivots: crate::pivot::types::PivotState,
    slicer: crate::slicer::SlicerState,
    filters: crate::ribbon_filter::types::RibbonFilterState,
    pane: crate::pane_control::types::PaneControlState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
}

impl Book {
    fn new(sheets: usize) -> Self {
        let state = crate::create_app_state();
        let seed = crate::document_effect::test_seed_effect;
        for i in 1..sheets {
            state.grids.write(&seed()).unwrap().push(engine::Grid::new());
            state.sheet_names.write(&seed()).unwrap().push(format!("Sheet{}", i + 1));
            state.all_column_widths.write(&seed()).unwrap().push(Default::default());
            state.all_row_heights.write(&seed()).unwrap().push(Default::default());
            state.all_user_hidden_rows.write(&seed()).unwrap().push(Default::default());
            state.all_user_hidden_cols.write(&seed()).unwrap().push(Default::default());
            state
                .sheet_ids
                .write(&seed())
                .unwrap()
                .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
        {
            let mut all = state.all_merged_regions.write(&seed()).unwrap();
            while all.len() < sheets {
                all.push(Default::default());
            }
        }
        Book {
            state,
            file: FileState::default(),
            files: UserFilesState::default(),
            pivots: crate::pivot::types::PivotState::new(),
            slicer: crate::slicer::SlicerState::new(),
            filters: crate::ribbon_filter::types::RibbonFilterState::new(),
            pane: crate::pane_control::types::PaneControlState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn locale(&self, id: &str) {
        *self.state.locale.lock().unwrap() = LocaleSettings::from_locale_id(id);
    }

    /// Put a cell on `sheet` (both mirrors when it is the active sheet 0).
    fn seed_cell(&self, sheet: usize, row: u32, col: u32, value: CellValue, style: CellStyle) {
        let seed = crate::document_effect::test_seed_effect();
        let style_index = self.state.style_registry.write(&seed).unwrap().get_or_create(style);
        let cell = Cell { value, ast: None, style_index, rich_text: None };
        if sheet == 0 {
            self.state.grid.write(&seed).unwrap().set_cell(row, col, cell.clone());
        }
        self.state.grids.write(&seed).unwrap()[sheet].set_cell(row, col, cell);
    }

    /// A whole-COLUMN default style on the active sheet (both mirrors).
    fn seed_column_tier(&self, col: u32, style: CellStyle) {
        let seed = crate::document_effect::test_seed_effect();
        let idx = self.state.style_registry.write(&seed).unwrap().get_or_create_explicit(style);
        self.state.grid.write(&seed).unwrap().set_column_style(col, idx);
        self.state.grids.write(&seed).unwrap()[0].set_column_style(col, idx);
    }

    /// The style a position on the ACTIVE sheet resolves to.
    fn style_at(&self, row: u32, col: u32) -> CellStyle {
        let grid = self.state.grid.read().unwrap();
        let idx = grid.effective_style_index(row, col);
        self.state.style_registry.read().unwrap().get(idx).clone()
    }

    /// The style a position on `sheet` resolves to, read from `grids`.
    fn style_on(&self, sheet: usize, row: u32, col: u32) -> CellStyle {
        let grids = self.state.grids.read().unwrap();
        let idx = grids[sheet].effective_style_index(row, col);
        self.state.style_registry.read().unwrap().get(idx).clone()
    }

    fn value_on(&self, sheet: usize, row: u32, col: u32) -> CellValue {
        self.state.grids.read().unwrap()[sheet]
            .get_cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    /// Undo through the REAL restore path, as Ctrl+Z does.
    fn undo(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters,
            &self.pane, &self.timelines, transaction, true,
        );
    }

    fn format(&self, rows: Vec<u32>, cols: Vec<u32>, edit: impl FnOnce(&mut FormattingParams)) -> Result<FormattingResult, String> {
        let mut params = FormattingParams { rows, cols, ..Default::default() };
        edit(&mut params);
        apply_formatting_core(&self.state, &self.file, &params, &[])
    }

    fn border(&self, rect: (u32, u32, u32, u32), preset: &str) -> Result<FormattingResult, String> {
        apply_border_preset_core(
            &self.state,
            &self.file,
            CellRect::new(rect.0, rect.1, rect.2, rect.3),
            preset,
            "solid",
            "#000000",
            1,
            &[],
        )
    }

    fn decimals(&self, rows: Vec<u32>, cols: Vec<u32>, delta: i32) -> Result<FormattingResult, String> {
        adjust_number_format_decimals_core(&self.state, &self.file, &rows, &cols, delta, &[])
    }
}

fn thin() -> engine::BorderStyle {
    engine::BorderStyle {
        width: 1,
        color: ThemeColor::Absolute(Color::new(0, 0, 0)),
        style: BorderLineStyle::Solid,
    }
}

fn yellow_fill() -> Fill {
    Fill::Solid { color: ThemeColor::Absolute(Color::new(255, 255, 0)) }
}

// ---------------------------------------------------------------------------
// 1. Half-point font sizes, Excel's 409 (survey D1)
// ---------------------------------------------------------------------------

/// The Home tab's Decrease Font Size from 11 sends 10.5; the old `u8` field
/// failed to deserialise it and the button was stuck. It is now applied,
/// stored and reported back as 10.5 -- and 409, Excel's top, fits too.
#[test]
fn a_half_point_and_a_409_point_size_are_applied_and_reported() {
    let b = Book::new(1);
    let result = b.format(vec![0], vec![0], |p| p.font_size = Some(10.5)).expect("10.5 is legal");
    let reported = result
        .styles
        .iter()
        .find(|e| e.index == result.cells[0].style_index)
        .expect("the new style is returned for the cache");
    assert_eq!(reported.style.font_size, 10.5);
    assert_eq!(b.style_at(0, 0).font.size.points(), 10.5);

    b.format(vec![1], vec![0], |p| p.font_size = Some(409.0)).expect("409 is legal");
    assert_eq!(b.style_at(1, 0).font.size.points(), 409.0);
}

/// Outside 1..=409 the command REFUSES -- before the document is dirtied,
/// before anything is recorded, before any cell is written.
#[test]
fn a_size_outside_excels_range_is_refused_before_anything_is_written() {
    let b = Book::new(1);
    for bad in [0.5, 0.0, 409.5, 410.0, -1.0, f64::NAN] {
        let verdict = b.format(vec![0], vec![0], |p| p.font_size = Some(bad));
        assert!(verdict.is_err(), "{bad} must be refused");
    }
    assert!(!b.file.is_dirty(), "a refusal must not dirty the document");
    assert_eq!(b.undo_depth(), 0);
    assert!(b.state.grid.read().unwrap().get_cell(0, 0).is_none());
}

// ---------------------------------------------------------------------------
// 2. Stacked text; an unknown rotation refuses instead of clearing
// ---------------------------------------------------------------------------

#[test]
fn vertical_text_is_applied_and_reported_as_vertical() {
    let b = Book::new(1);
    let result = b.format(vec![0], vec![0], |p| p.text_rotation = Some("vertical".into())).unwrap();
    assert_eq!(b.style_at(0, 0).text_rotation, TextRotation::Vertical);
    assert_eq!(result.styles[0].style.text_rotation, "vertical");
    // And a recorded "custom:45" (Angle Counterclockwise) is accepted.
    b.format(vec![1], vec![0], |p| p.text_rotation = Some("custom:45".into())).unwrap();
    assert_eq!(b.style_at(1, 0).text_rotation, TextRotation::Custom(45));
}

/// "sideways" used to become `None` -- and `None` CLEARS a rotation. A cell
/// already rotated must keep its rotation when a bad value is refused.
#[test]
fn an_unknown_rotation_is_refused_and_the_existing_rotation_survives() {
    let b = Book::new(1);
    b.format(vec![0], vec![0], |p| p.text_rotation = Some("rotate90".into())).unwrap();
    crate::document_effect::mark_saved(&b.file);
    let depth = b.undo_depth();
    let verdict = b.format(vec![0], vec![0], |p| p.text_rotation = Some("sideways".into()));
    assert!(verdict.is_err());
    assert_eq!(b.style_at(0, 0).text_rotation, TextRotation::Rotate90);
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), depth);
}

// ---------------------------------------------------------------------------
// 3. Comma Style, the Accounting menu, and the regional negative pattern
// ---------------------------------------------------------------------------

/// Every Home-tab accounting keyword is the TYPED Accounting format, carrying
/// the region's negative pattern (en-US brackets, sv-SE a leading minus), and
/// its display name -- what `get_style` reports and Format Cells sends back on
/// an untouched OK -- parses back to the identical format.
#[test]
fn every_home_accounting_preset_is_typed_accounting_and_round_trips() {
    for (locale_id, pattern) in [("en-US", NegativeStyle::Parentheses), ("sv-SE", NegativeStyle::Minus)] {
        let locale = LocaleSettings::from_locale_id(locale_id);
        for preset in HOME_ACCOUNTING_PRESETS {
            let nf = parse_number_format_with_locale(preset, &locale);
            match &nf {
                NumberFormat::Accounting { negative_style, decimal_places, .. } => {
                    assert_eq!(*negative_style, pattern, "{locale_id} {preset}");
                    assert_eq!(*decimal_places, 2, "{locale_id} {preset}");
                }
                other => panic!("{locale_id} {preset} resolved to {other:?}"),
            }
            let name = format_number_format_name(&nf);
            assert_eq!(parse_number_format_with_locale(&name, &locale), nf, "{name}");
        }
    }
    // The symbol and its side, row by row (CONTRACT section 3.7).
    let us = LocaleSettings::invariant();
    let shape = |preset: &str| match parse_number_format_with_locale(preset, &us) {
        NumberFormat::Accounting { symbol, symbol_position, .. } => (symbol, symbol_position),
        other => panic!("{other:?}"),
    };
    use CurrencyPosition::{After, Before};
    assert_eq!(shape("comma"), (String::new(), Before));
    assert_eq!(shape("accounting_usd"), ("$".to_string(), Before));
    assert_eq!(shape("accounting_gbp"), ("\u{00A3}".to_string(), Before));
    assert_eq!(shape("accounting_eur_before"), ("\u{20AC}".to_string(), Before));
    assert_eq!(shape("accounting_eur_after"), ("\u{20AC}".to_string(), After));
    assert_eq!(shape("accounting_cny"), ("\u{00A5}".to_string(), Before));
    assert_eq!(shape("accounting_chf"), ("CHF".to_string(), Before));
}

/// What Comma Style renders on sv-SE, against Excel's own text for the same
/// cells (live): 1234.5 -> `"   1 234,50 "`, 0 -> a dash, -42 ->
/// `"-         42,00 "` (the minus at the LEFT edge). The single-string
/// spelling has no fill, so the comparison is on the split parts.
#[test]
fn comma_style_renders_excels_comma_on_sv_se() {
    let se = LocaleSettings::from_locale_id("sv-SE");
    let comma = parse_number_format_with_locale("comma", &se);
    let parts = |v: f64| {
        engine::format_number_with_color(v, &comma, &se).accounting.expect("a split layout")
    };
    let p = parts(1234.5);
    assert_eq!((p.symbol.as_str(), p.value.as_str()), ("", "1\u{00A0}234,50 "));
    let p = parts(0.0);
    assert_eq!(p.value, "-\u{2007}\u{2007} ");
    let p = parts(-42.0);
    assert_eq!((p.symbol.as_str(), p.value.as_str()), ("-", "42,00 "));
    // en-US brackets instead.
    let us = LocaleSettings::invariant();
    let comma_us = parse_number_format_with_locale("comma", &us);
    let p = engine::format_number_with_color(-42.0, &comma_us, &us).accounting.unwrap();
    assert_eq!((p.symbol.as_str(), p.value.as_str()), ("", "(42.00)"));
}

/// THE SURVEY'S DEFECT D: `[$£-809]` is the symbol £ in locale 0x809. The
/// whole bracket body used to become the symbol, so the cell read
/// "£-809 1,234.50". The space after the bracket is the CODE's (measured:
/// `[$£-809]#,##0.00` shows no space, `[$€-2] #,##0.00` shows one).
#[test]
fn a_locale_tagged_currency_keeps_its_symbol_and_drops_the_tag() {
    let us = LocaleSettings::invariant();
    let currency = |sym: &str| NumberFormat::Currency {
        decimal_places: 2,
        symbol: sym.to_string(),
        symbol_position: CurrencyPosition::Before,
        negative_style: NegativeStyle::Minus,
    };
    let gbp = parse_number_format("[$\u{00A3}-809]#,##0.00");
    assert_eq!(gbp, currency("\u{00A3}"));
    assert_eq!(engine::format_number(1234.5, &gbp, &us), "\u{00A3}1,234.50");
    assert_eq!(parse_number_format("[$\u{20AC}-2] #,##0.00"), currency("\u{20AC} "));
    assert_eq!(parse_number_format("[$$-en-US]#,##0.00"), currency("$"));
    assert_eq!(parse_number_format("[$CHF-100C] #,##0.00"), currency("CHF "));
    // The pre-existing tag-less form is unchanged.
    assert_eq!(parse_number_format("[$EUR] #,##0.00"), currency("EUR "));
    // A locale tag with no symbol is not a currency.
    assert!(!matches!(parse_number_format("[$-409]0.00"), NumberFormat::Currency { .. }));
}

// ---------------------------------------------------------------------------
// 4. Increase / Decrease Decimal (number.md section 3, every row)
// ---------------------------------------------------------------------------

fn num(dp: u8, sep: bool) -> NumberFormat {
    NumberFormat::Number { decimal_places: dp, use_thousands_separator: sep }
}

fn custom(code: &str) -> NumberFormat {
    NumberFormat::Custom { format: code.to_string() }
}

/// Every row of the survey's Excel table, against `next_decimal_format`.
#[test]
fn every_row_of_excels_decimal_table() {
    let n = |v: f64| CellValue::Number(v);
    let inc = |f: &NumberFormat, v: Option<CellValue>| next_decimal_format(f, v.as_ref(), 1);
    let dec = |f: &NumberFormat, v: Option<CellValue>| next_decimal_format(f, v.as_ref(), -1);
    let general = NumberFormat::General;

    // General uses the decimals it shows.
    assert_eq!(inc(&general, Some(n(1.5))), Some(num(2, false)), "General 1.5 Inc -> 0.00");
    assert_eq!(dec(&general, Some(n(1.5))), Some(num(0, false)), "General 1.5 Dec -> 0");
    assert_eq!(inc(&general, Some(n(1.2345))), Some(num(5, false)), "General 1.2345 Inc");
    assert_eq!(dec(&general, Some(n(1.2345))), Some(num(3, false)), "General 1.2345 Dec");
    assert_eq!(inc(&general, Some(n(3.0))), Some(num(1, false)), "General 3 Inc -> 0.0");
    assert_eq!(dec(&general, Some(n(3.0))), None, "General 3 Dec stays General");

    // Fixed decimals, with and without separators.
    assert_eq!(inc(&num(2, false), Some(n(2.25))), Some(num(3, false)));
    assert_eq!(dec(&num(2, false), Some(n(2.25))), Some(num(1, false)));
    assert_eq!(inc(&num(2, true), Some(n(2234.25))), Some(num(3, true)));
    assert_eq!(dec(&num(0, false), Some(n(2.0))), None, "0 Dec is unchanged");

    // Percent keeps its kind.
    let pct = |dp| NumberFormat::Percentage { decimal_places: dp };
    assert_eq!(inc(&pct(0), Some(n(0.256))), Some(pct(1)), "0% -> 0.0%");
    assert_eq!(dec(&pct(0), Some(n(0.256))), None, "0% Dec is unchanged");
    assert_eq!(inc(&pct(1), Some(n(0.256))), Some(pct(2)));
    assert_eq!(dec(&pct(1), Some(n(0.256))), Some(pct(0)));

    // Accounting keeps symbol, side and negative pattern; 2 -> 0 keeps "kr".
    let kr = |dp| NumberFormat::Accounting {
        decimal_places: dp,
        symbol: "kr".to_string(),
        symbol_position: CurrencyPosition::After,
        negative_style: NegativeStyle::Minus,
    };
    assert_eq!(inc(&kr(2), Some(n(1234.5))), Some(kr(3)));
    assert_eq!(dec(&kr(1), Some(n(1234.5))), Some(kr(0)));

    // Currency keeps its symbol AND its red negatives.
    let red = |dp| NumberFormat::Currency {
        decimal_places: dp,
        symbol: "$".to_string(),
        symbol_position: CurrencyPosition::Before,
        negative_style: NegativeStyle::Red,
    };
    assert_eq!(inc(&red(2), Some(n(-2.25))), Some(red(3)));

    // Scientific keeps its exponent.
    let sci = |dp| NumberFormat::Scientific { decimal_places: dp };
    assert_eq!(inc(&sci(2), Some(n(12345.678))), Some(sci(3)));
    assert_eq!(dec(&sci(1), Some(n(12345.678))), Some(sci(0)));

    // Date, time, fraction and text formats are left alone.
    let date = NumberFormat::Date { format: "yyyy-mm-dd".to_string() };
    let time = NumberFormat::Time { format: "hh:mm".to_string() };
    let fraction = NumberFormat::Fraction { denominator: None, max_digits: 1 };
    for unchanged in [&date, &time, &fraction, &custom("@"), &custom("dd/mm/yyyy hh:mm")] {
        assert_eq!(inc(unchanged, Some(n(45000.5))), None, "{unchanged:?}");
        assert_eq!(dec(unchanged, Some(n(45000.5))), None, "{unchanged:?}");
    }

    // Custom codes: one 0 per numeric section, literals untouched.
    assert_eq!(
        inc(&custom("#,##0.00 \"kr\""), Some(n(1234.5))),
        Some(custom("#,##0.000 \"kr\""))
    );
    assert_eq!(
        dec(&custom("#,##0.00 \"kr\""), Some(n(1234.5))),
        Some(custom("#,##0.0 \"kr\""))
    );
    assert_eq!(
        inc(&custom("0.00;(0.00);\"zero\""), Some(n(1234.5))),
        Some(custom("0.000;(0.000);\"zero\""))
    );
    assert_eq!(
        inc(&custom("#,##0 \" k\""), Some(n(1500.0))),
        Some(custom("#,##0.0 \" k\"")),
        "a section with no decimals gains a point and a 0"
    );
    assert_eq!(dec(&custom("#,##0 \" k\""), Some(n(1500.0))), None);
    assert_eq!(dec(&custom("0.0"), Some(n(1.5))), Some(custom("0")), "the point goes with the last 0");
    assert_eq!(inc(&custom("0.0E+00"), Some(n(1.5))), Some(custom("0.00E+00")), "the mantissa, not the exponent");
    // Excel's own Comma code: the zero section (`"-"??`, no 0 or #) and the
    // text section stay as they are (live: `_-* # ##0,000_-;...;_-* "-"??_-;_-@_-`).
    assert_eq!(
        inc(&custom("_-* #,##0.00_-;-* #,##0.00_-;_-* \"-\"??_-;_-@_-"), Some(n(1.0))),
        Some(custom("_-* #,##0.000_-;-* #,##0.000_-;_-* \"-\"??_-;_-@_-"))
    );

    // An empty active cell, or text under General: Excel changes nothing.
    assert_eq!(inc(&general, None), None);
    assert_eq!(inc(&general, Some(CellValue::Text("abc".to_string()))), None);

    // 255 decimals: the old regex path wrapped `frac.len() as u8` to 0.
    assert_eq!(inc(&num(255, false), Some(n(1.0))), None, "no wrap past 255");
}

/// The ACTIVE cell (first row and column given) decides; the whole selection
/// gets the result, as ONE undo step (live: F1:F3, F1 General 1.5 active ->
/// all three `0.00`, the `0%` cell included).
#[test]
fn the_active_cell_decides_and_the_whole_selection_follows_in_one_undo_step() {
    let b = Book::new(1);
    b.seed_cell(0, 0, 5, CellValue::Number(1.5), CellStyle::new());
    b.seed_cell(0, 1, 5, CellValue::Number(2.125), CellStyle::new().with_number_format(num(3, false)));
    b.seed_cell(
        0,
        2,
        5,
        CellValue::Number(0.5),
        CellStyle::new().with_number_format(NumberFormat::Percentage { decimal_places: 0 }),
    );
    let before = b.undo_depth();
    let result = b.decimals(vec![0, 1, 2], vec![5], 1).unwrap();
    assert_eq!(result.cells.len(), 3);
    for row in 0..3 {
        assert_eq!(b.style_at(row, 5).number_format, num(2, false), "row {row}");
    }
    assert_eq!(b.undo_depth(), before + 1, "ONE undo step");
    assert!(b.file.is_dirty());

    b.undo();
    assert_eq!(b.style_at(0, 5).number_format, NumberFormat::General);
    assert_eq!(b.style_at(1, 5).number_format, num(3, false));
    assert_eq!(
        b.style_at(2, 5).number_format,
        NumberFormat::Percentage { decimal_places: 0 }
    );

    // Active G2 (row 1 first): its `0.000` decides -> `0.0000` for all.
    let r = b.decimals(vec![1, 0, 2], vec![5], 1).unwrap();
    assert_eq!(r.cells.len(), 3);
    for row in 0..3 {
        assert_eq!(b.style_at(row, 5).number_format, num(4, false), "row {row}");
    }
}

/// Where Excel changes nothing -- a date, an empty cell, text -- nothing is
/// written ANYWHERE in the selection (live: a DATE active beside a `0.00`
/// cell: neither changed), nothing is recorded, and the document stays clean.
#[test]
fn when_excel_changes_nothing_nothing_is_written_and_the_document_stays_clean() {
    let b = Book::new(1);
    let date = NumberFormat::Date { format: "yyyy-mm-dd".to_string() };
    b.seed_cell(0, 0, 7, CellValue::Number(45000.0), CellStyle::new().with_number_format(date.clone()));
    b.seed_cell(0, 1, 7, CellValue::Number(2.25), CellStyle::new().with_number_format(num(2, false)));
    b.seed_cell(0, 0, 8, CellValue::Text("abc".to_string()), CellStyle::new());
    for (rows, cols) in [(vec![0, 1], vec![7]), (vec![0], vec![8]), (vec![5, 6], vec![9])] {
        let r = b.decimals(rows, cols, 1).unwrap();
        assert!(r.cells.is_empty());
    }
    assert_eq!(b.style_at(0, 7).number_format, date);
    assert_eq!(b.style_at(1, 7).number_format, num(2, false));
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
    assert!(b.decimals(vec![0], vec![0], 2).is_err(), "delta is 1 or -1");
}

// ---------------------------------------------------------------------------
// 5. Border presets: effective styles (D2), whole axes and Select All (D3),
//    grouped sheets (D4)
// ---------------------------------------------------------------------------

/// SURVEY D2. A cell that only SHOWS its column's default (style index 0 under
/// a column tier) used to be bordered on top of the DEFAULT style: the column's
/// fill vanished from it and, on a column unlocked through its tier, the cell
/// silently re-locked.
#[test]
fn a_border_under_a_column_default_keeps_the_columns_fill_and_lock() {
    let b = Book::new(1);
    let mut column = CellStyle::new().with_fill(yellow_fill());
    column.locked = false;
    b.seed_column_tier(2, column);
    b.seed_cell(0, 1, 2, CellValue::Number(5.0), CellStyle::new()); // index 0: inherits the tier

    b.border((1, 2, 1, 2), "allBorders").unwrap();
    let s = b.style_at(1, 2);
    assert_eq!(s.fill, yellow_fill(), "the column's fill survives");
    assert!(!s.locked, "the column's unlock survives");
    assert_eq!(s.borders.top, thin());
    assert_eq!(s.borders.right, thin());

    // An EMPTY position under the tier is the same case.
    b.border((4, 2, 4, 2), "outside").unwrap();
    let s = b.style_at(4, 2);
    assert_eq!(s.fill, yellow_fill());
    assert!(!s.locked);
    assert_eq!(s.borders.bottom, thin());
}

/// SURVEY D3. Select All is 1,048,576 x 16,384 positions; the preset used to
/// walk every one (and count them in an overflowing `u32`). It now writes
/// ONE tier entry per column and the cells that differ from it, finishes at
/// once, reaches positions nobody stored, and is ONE undo step.
#[test]
fn select_all_borders_go_through_the_column_tiers_and_undo_whole() {
    let b = Book::new(1);
    b.seed_cell(0, 10, 3, CellValue::Number(1.0), CellStyle::new().with_bold(true));
    let max_row = engine::EXCEL_MAX_ROW_INDEX;
    let max_col = engine::EXCEL_MAX_COL_INDEX;

    b.border((0, 0, max_row, max_col), "allBorders").unwrap();
    {
        let grid = b.state.grid.read().unwrap();
        assert_eq!(grid.column_styles.len(), (max_col + 1) as usize, "one tier per column");
        assert!(grid.cells.len() <= 1, "no cell materialised for allBorders ({})", grid.cells.len());
    }
    // A position nobody ever stored shows the border...
    assert_eq!(b.style_at(1_000_000, 16_000).borders.left, thin());
    // ...and the stored bold cell kept its bold.
    let s = b.style_at(10, 3);
    assert!(s.font.bold);
    assert_eq!(s.borders.bottom, thin());
    assert_eq!(b.undo_depth(), 1);

    b.undo();
    assert!(b.state.grid.read().unwrap().column_styles.is_empty(), "Undo removes the tiers");
    assert_eq!(b.style_at(1_000_000, 16_000).borders.left, engine::BorderStyle::default());
    assert!(b.style_at(10, 3).font.bold);
    assert_eq!(b.style_at(10, 3).borders.bottom, engine::BorderStyle::default());
}

/// Outside on whole columns B:D: the outline is the columns' left and right
/// edges (tiers) plus the sheet's first and last row (cells) -- the interior
/// stays clear.
#[test]
fn outside_on_whole_columns_borders_only_the_outline() {
    let b = Book::new(1);
    let max_row = engine::EXCEL_MAX_ROW_INDEX;
    b.border((0, 1, max_row, 3), "outside").unwrap();
    let none = engine::BorderStyle::default();
    assert_eq!(b.style_at(500, 1).borders.left, thin());
    assert_eq!(b.style_at(500, 1).borders.right, none);
    assert_eq!(b.style_at(500, 3).borders.right, thin());
    assert_eq!(b.style_at(500, 2).borders, engine::Borders::default());
    assert_eq!(b.style_at(0, 2).borders.top, thin());
    assert_eq!(b.style_at(max_row, 2).borders.bottom, thin());
    assert_eq!(b.style_at(0, 1).borders.left, thin(), "a corner has both edges");
    assert_eq!(b.style_at(0, 1).borders.top, thin());
}

/// Whole ROWS: the new row tier outranks every column default it crosses, so
/// the crossing cell is written explicitly and keeps the column's fill.
#[test]
fn a_whole_row_border_keeps_a_crossing_columns_fill() {
    let b = Book::new(1);
    b.seed_column_tier(4, CellStyle::new().with_fill(yellow_fill()));
    let max_col = engine::EXCEL_MAX_COL_INDEX;
    b.border((3, 0, 4, max_col), "allBorders").unwrap();
    let crossing = b.style_at(3, 4);
    assert_eq!(crossing.fill, yellow_fill(), "the column's fill survives the row tier");
    assert_eq!(crossing.borders.top, thin());
    assert_eq!(b.style_at(3, 100).borders.top, thin(), "the rest of the row via its tier");
    assert_eq!(b.style_at(5, 100).borders.top, engine::BorderStyle::default());
}

/// A preset that changes nothing writes nothing and leaves the file clean.
#[test]
fn no_border_on_a_range_without_borders_changes_nothing() {
    let b = Book::new(1);
    let r = b.border((0, 0, 9, 9), "none").unwrap();
    assert!(r.cells.is_empty());
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
}

/// A partial rectangle too large to style cell by cell is refused, cleanly.
/// CHANGED DELIBERATELY (round-2 review revA#4): this used B2 to the sheet's
/// corner, which is ALMOST whole columns -- every column but A, short by row
/// 1 -- and is now written as column tiers plus one exception row
/// (`CellRect::line_extent`), as Excel stores it. A truly interior rectangle
/// (3,000 rows x 2,000 columns, nowhere near a whole line) is still refused.
#[test]
fn a_huge_partial_rectangle_is_refused_without_touching_anything() {
    let b = Book::new(1);
    let verdict = b.border((1_000, 100, 3_999, 2_099), "allBorders");
    assert!(verdict.is_err());
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
}

/// An unknown preset is refused before anything changes.
#[test]
fn an_unknown_border_preset_is_refused_cleanly() {
    let b = Book::new(1);
    assert!(b.border((0, 0, 1, 1), "diagonal").is_err());
    assert!(!b.file.is_dirty());
}

/// SURVEY D4. With sheets grouped, the preset reaches every OTHER selected
/// sheet (the active sheet is the caller's own `apply_border_preset`), as
/// `apply_formatting_to_sheets` does for every other format.
#[test]
fn grouped_sheets_get_the_same_border_preset() {
    let b = Book::new(3);
    apply_border_preset_to_sheets_core(
        &b.state,
        &b.file,
        &[0, 1, 2],
        CellRect::new(0, 0, 1, 1),
        "outside",
        "solid",
        "#000000",
        1,
    )
    .unwrap();
    for sheet in [1, 2] {
        assert_eq!(b.style_on(sheet, 0, 0).borders.top, thin(), "sheet {sheet}");
        assert_eq!(b.style_on(sheet, 1, 1).borders.right, thin(), "sheet {sheet}");
        assert_eq!(b.style_on(sheet, 0, 0).borders.bottom, engine::BorderStyle::default());
    }
    assert_eq!(
        b.style_at(0, 0).borders,
        engine::Borders::default(),
        "the active sheet is not this command's to change"
    );
    // Undo reverts every grouped sheet in ONE step (it was one per sheet).
    assert_eq!(b.undo_depth(), 1);
    b.undo();
    for sheet in [1, 2] {
        assert_eq!(b.style_on(sheet, 0, 0).borders, engine::Borders::default(), "sheet {sheet}");
    }
}

// ---------------------------------------------------------------------------
// 6. Grouped formatting records its undo against the RIGHT sheet
// ---------------------------------------------------------------------------

/// `apply_formatting_to_sheets` recorded every change against the ACTIVE
/// sheet, so Undo wrote the grouped sheet's old cell INTO THE ACTIVE SHEET --
/// overwriting what the active sheet held -- and never reverted the grouped
/// sheet. Found while reusing its applier for this lane.
#[test]
fn undoing_a_grouped_format_restores_the_grouped_sheet_not_the_active_one() {
    let b = Book::new(2);
    b.seed_cell(0, 0, 0, CellValue::Text("active".to_string()), CellStyle::new());
    b.seed_cell(1, 0, 0, CellValue::Text("other".to_string()), CellStyle::new());
    let params = FormattingParams { rows: vec![0], cols: vec![0], bold: Some(true), ..Default::default() };
    apply_formatting_to_sheets_core(&b.state, &b.file, &[0, 1], &params).unwrap();
    assert!(b.style_on(1, 0, 0).font.bold);

    b.undo();
    assert_eq!(
        b.value_on(0, 0, 0),
        CellValue::Text("active".to_string()),
        "the active sheet's cell must not be overwritten by the grouped sheet's"
    );
    assert!(!b.style_on(1, 0, 0).font.bold, "the grouped sheet is the one reverted");
}

// ---------------------------------------------------------------------------
// 7. The adversarial review (2026-10-04): Select All decimals, one critical
//    section per style command, and ONE undo step for a grouped format
// ---------------------------------------------------------------------------

/// Run `body` on its own thread and fail -- instead of hanging the suite --
/// when it does not finish in `seconds`. Select All is 17.2 billion
/// positions; a command that walks them never returns, so a plain call would
/// turn a red test into a stuck run.
fn within<T: Send + 'static>(seconds: u64, body: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(body());
    });
    rx.recv_timeout(std::time::Duration::from_secs(seconds))
        .unwrap_or_else(|_| panic!("did not finish within {seconds} s (walked every position?)"))
}

fn every_row() -> Vec<u32> {
    (0..=engine::EXCEL_MAX_ROW_INDEX).collect()
}

fn every_col() -> Vec<u32> {
    (0..=engine::EXCEL_MAX_COL_INDEX).collect()
}

/// REVIEW FINDING 4. Ctrl+A, then Increase Decimal: the Home tab sends all
/// 1,048,576 rows and 16,384 columns, and the command walked every position
/// -- materialising a cell and an undo entry for each until memory ran out.
/// It now goes through the column TIERS the border presets use: one tier per
/// column, a cell only where a stored style differs, ONE undo step, and every
/// returned style carries the new format (the wrapper records `styles[0]`).
#[test]
fn select_all_increase_decimal_goes_through_the_column_tiers() {
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_cell(0, 0, 0, CellValue::Number(1.5), CellStyle::new());
    b.seed_cell(0, 7, 3, CellValue::Number(2.0), CellStyle::new().with_bold(true));
    let runner = b.clone();
    let result = within(60, move || runner.decimals(every_row(), every_col(), 1)).expect("Select All decimals");

    {
        let grid = b.state.grid.read().unwrap();
        assert_eq!(grid.column_styles.len(), (engine::EXCEL_MAX_COL_INDEX + 1) as usize, "one tier per column");
        assert!(grid.cells.len() <= 2, "no cell materialised beyond the stored ones ({})", grid.cells.len());
    }
    assert_eq!(b.style_at(0, 0).number_format, num(2, false), "the active cell");
    assert_eq!(b.style_at(1_000_000, 16_000).number_format, num(2, false), "a position nobody stored");
    assert!(b.style_at(7, 3).font.bold, "a stored style keeps its own format");
    assert_eq!(b.style_at(7, 3).number_format, num(2, false));
    assert!(!result.styles.is_empty());
    let registry = b.state.style_registry.read().unwrap().clone();
    for entry in &result.styles {
        assert_eq!(registry.get(entry.index).number_format, num(2, false), "style {} carries the new format", entry.index);
    }
    assert_eq!(b.undo_depth(), 1, "ONE undo step");

    b.undo();
    assert!(b.state.grid.read().unwrap().column_styles.is_empty(), "Undo removes the tiers");
    assert_eq!(b.style_at(0, 0).number_format, NumberFormat::General);
    assert_eq!(b.style_at(1_000_000, 16_000).number_format, NumberFormat::General);
}

/// Whole ROWS take the row tiers the same way.
#[test]
fn whole_row_decimals_go_through_the_row_tiers() {
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_cell(0, 3, 0, CellValue::Number(1.25), CellStyle::new());
    let runner = b.clone();
    within(60, move || runner.decimals(vec![3, 4], every_col(), -1)).expect("whole rows");
    let grid = b.state.grid.read().unwrap();
    assert_eq!(grid.row_styles.len(), 2);
    drop(grid);
    assert_eq!(b.style_at(4, 16_000).number_format, num(1, false), "1.25 shows 2 decimals; Decrease gives 1");
}

/// The RANGE form of the protection gate: a protected sheet whose every
/// column is unlocked through its tier allows Select All -- and the gate must
/// answer that without enumerating 17.2 billion positions.
#[test]
fn select_all_decimals_on_an_unlocked_protected_sheet_is_gated_by_range() {
    let b = std::sync::Arc::new(Book::new(1));
    let mut unlocked = CellStyle::new();
    unlocked.locked = false;
    for col in 0..=engine::EXCEL_MAX_COL_INDEX {
        b.seed_column_tier(col, unlocked.clone());
    }
    b.seed_cell(0, 0, 0, CellValue::Number(1.5), unlocked.clone());
    let seed = crate::document_effect::test_seed_effect();
    b.state.sheet_protection.write(&seed).unwrap().entry(0).or_default().protected = true;
    // formatCells must be allowed for the gate to reach the cell question.
    b.state
        .sheet_protection
        .write(&seed)
        .unwrap()
        .get_mut(&0)
        .unwrap()
        .options
        .allow_format_cells = true;
    let runner = b.clone();
    within(60, move || runner.decimals(every_row(), every_col(), 1)).expect("every position is unlocked");
    assert_eq!(b.style_at(500_000, 9_000).number_format, num(2, false));
}

/// A selection that is not one rectangle (the lists name rows 0 and 5 only)
/// is still formatted cell by cell; one too large to plan is refused before
/// anything happens.
#[test]
fn listed_cells_are_formatted_and_a_huge_scattered_list_is_refused() {
    let b = Book::new(1);
    b.seed_cell(0, 0, 0, CellValue::Number(1.5), CellStyle::new());
    b.decimals(vec![0, 5], vec![0], 1).expect("two listed rows");
    assert_eq!(b.style_at(5, 0).number_format, num(2, false));
    assert_eq!(b.style_at(3, 0).number_format, NumberFormat::General, "row 4 was not listed");

    let rows: Vec<u32> = (0..=engine::EXCEL_MAX_ROW_INDEX).step_by(2).collect();
    let before = b.undo_depth();
    let verdict = b.decimals(rows, (0..20).collect(), 1);
    assert!(verdict.is_err(), "10 million scattered positions are refused");
    assert_eq!(b.undo_depth(), before);
}

/// REVIEW FINDING 5 (TOCTOU). The border preset, the decimal step and Insert/
/// Delete Cells decided under READ guards, dropped them, and wrote under
/// re-acquired ones -- a style computed from a stale base, or a gate answered
/// about cells that changed before the write. Each now takes its guards with
/// `lock_pending` FIRST and gates, plans and writes under them. A race cannot
/// be reproduced deterministically, so the rule is pinned on the source: no
/// read guard on the grid or the style registry in these bodies, and the
/// pending guards come before the first gate.
#[test]
fn style_and_cell_shift_commands_gate_plan_and_write_in_one_critical_section() {
    fn body<'a>(source: &'a str, signature: &str) -> &'a str {
        let start = source.find(signature).unwrap_or_else(|| panic!("{signature} not found"));
        let rest = &source[start..];
        let end = rest.find("\n}\n").expect("end of fn");
        &rest[..end]
    }
    const STYLES: &str = include_str!("styles.rs");
    const CELLS: &str = include_str!("structure_cells.rs");
    let cases = [
        (STYLES, "fn border_preset_on_sheets(", "gate_style_targets("),
        // The body moved into the target-aware twin (P3), and then below the
        // active-cell resolution (the wire's activeRow / activeCol); _core and
        // _on delegate to it.
        (STYLES, "fn adjust_number_format_decimals_at(", "gate_style_targets("),
        (STYLES, "fn format_cells_on_sheets(", "gate_style_targets("),
        (CELLS, "pub(crate) fn shift_cells_impl(", "ensure_not_canvas_in_state("),
    ];
    for (source, signature, first_gate) in cases {
        let text = body(source, signature);
        for forbidden in ["state.grid.read()", "state.grids.read()", "state.style_registry.read()"] {
            assert!(!text.contains(forbidden), "{signature} takes {forbidden}: decide and write under ONE guard");
        }
        let lock = text
            .find("lock_pending()")
            .or_else(|| text.find("StyleLocks::take("))
            .unwrap_or_else(|| panic!("{signature} takes no pending guard"));
        let gate = text.find(first_gate).unwrap_or_else(|| panic!("{signature} has no {first_gate}"));
        assert!(lock < gate, "{signature}: the guard must be taken BEFORE the first gate");
    }
}

/// `apply_formatting_to_sheets` with nothing to do (only the active sheet, or
/// indices past the workbook) used to dirty the document anyway.
#[test]
fn a_grouped_format_with_no_other_sheet_leaves_the_document_clean() {
    let b = Book::new(2);
    let params = FormattingParams { rows: vec![0], cols: vec![0], bold: Some(true), ..Default::default() };
    apply_formatting_to_sheets_core(&b.state, &b.file, &[0, 9], &params).unwrap();
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
}

/// REVIEW FINDING 9. With sheets grouped, a border preset on the active sheet
/// plus its copy on every grouped sheet is ONE Ctrl+Z, and every sheet is
/// gated before any is written: one protected sheet refuses the whole group,
/// active sheet included, and the document stays clean.
#[test]
fn a_grouped_border_preset_is_one_undo_step_and_gated_whole() {
    let b = Book::new(3);
    apply_border_preset_core(&b.state, &b.file, CellRect::new(0, 0, 1, 1), "outside", "solid", "#000000", 1, &[0, 1, 2])
        .expect("grouped preset");
    assert_eq!(b.style_at(0, 0).borders.top, thin(), "the active sheet");
    for sheet in [1, 2] {
        assert_eq!(b.style_on(sheet, 1, 1).borders.right, thin(), "sheet {sheet}");
    }
    assert_eq!(b.undo_depth(), 1, "ONE undo step for the whole group");
    b.undo();
    assert_eq!(b.style_at(0, 0).borders, engine::Borders::default());
    for sheet in [1, 2] {
        assert_eq!(b.style_on(sheet, 0, 0).borders, engine::Borders::default(), "sheet {sheet}");
    }

    // A protected grouped sheet refuses the group before anything is written.
    let b = Book::new(3);
    let seed = crate::document_effect::test_seed_effect();
    b.state.sheet_protection.write(&seed).unwrap().entry(2).or_default().protected = true;
    let verdict =
        apply_border_preset_core(&b.state, &b.file, CellRect::new(0, 0, 1, 1), "outside", "solid", "#000000", 1, &[0, 1, 2]);
    assert!(verdict.is_err());
    assert_eq!(b.style_at(0, 0).borders, engine::Borders::default(), "the active sheet was not formatted first");
    assert_eq!(b.style_on(1, 0, 0).borders, engine::Borders::default());
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
}

/// The same for a grouped FORMAT (Bold) and a grouped decimal step.
#[test]
fn a_grouped_format_and_decimal_step_are_one_undo_step_and_gated_whole() {
    let b = Book::new(2);
    b.seed_cell(0, 0, 0, CellValue::Number(1.5), CellStyle::new());
    let params = FormattingParams { rows: vec![0], cols: vec![0], bold: Some(true), ..Default::default() };
    apply_formatting_core(&b.state, &b.file, &params, &[0, 1]).expect("grouped bold");
    assert!(b.style_at(0, 0).font.bold);
    assert!(b.style_on(1, 0, 0).font.bold);
    assert_eq!(b.undo_depth(), 1, "ONE undo step");
    b.undo();
    assert!(!b.style_at(0, 0).font.bold);
    assert!(!b.style_on(1, 0, 0).font.bold);

    adjust_number_format_decimals_core(&b.state, &b.file, &[0], &[0], 1, &[0, 1]).expect("grouped decimals");
    assert_eq!(b.style_at(0, 0).number_format, num(2, false));
    assert_eq!(b.style_on(1, 0, 0).number_format, num(2, false), "the active cell's step reaches the group");
    assert_eq!(b.undo_depth(), 1);

    let b = Book::new(2);
    let seed = crate::document_effect::test_seed_effect();
    b.state.sheet_protection.write(&seed).unwrap().entry(1).or_default().protected = true;
    assert!(apply_formatting_core(&b.state, &b.file, &params, &[0, 1]).is_err());
    assert!(!b.style_at(0, 0).font.bold, "the active sheet was not formatted first");
    assert!(!b.file.is_dirty());
}


// ---------------------------------------------------------------------------
// 7. P3 (owner finding G3): the style commands on a floating grid's cells
// ---------------------------------------------------------------------------
//
// A cell TARGET names an object (a floating grid); its cells live on a hidden
// BACKING sheet. Every style command with a target writes ONLY that sheet,
// decides from it, reports it (its merges included), refuses outside the
// write extent, refuses a target together with a sheet group (never ignores
// either), and is gated by the HOST sheet's protection.

/// A floating grid `rows` x `cols` on the active sheet 0. Returns (target,
/// backing sheet index), with the document clean and no undo history.
fn float_target(b: &Book, rows: u32, cols: u32) -> (crate::api_types::CellTargetRef, usize) {
    let info = crate::floating_range::create_floating_range_inner(&b.state, &b.file, None, 100.0, 50.0)
        .expect("create a floating range");
    crate::floating_range::update_floating_range_inner(
        &b.state,
        &b.file,
        info.range.id,
        crate::api_types::FloatingRangePatch { row_count: Some(rows), col_count: Some(cols), ..Default::default() },
        crate::floating_range::PatchGate::ObjectEdit,
    )
    .expect("size the window");
    // Creating the object is not what these tests measure.
    crate::document_effect::mark_saved(&b.file);
    b.state.undo_stack.lock().unwrap().clear();
    (crate::api_types::CellTargetRef::FloatingRange { id: info.range.id }, info.backing_sheet_index)
}

/// Make the active (host) sheet 0 a canvas page.
fn make_host_canvas(b: &Book) {
    let seed = crate::document_effect::test_seed_effect();
    b.state.sheet_kinds.write(&seed).unwrap()[0] = persistence::SheetKind::new_canvas();
}

fn bold_on(
    b: &Book,
    target: Option<&crate::api_types::CellTargetRef>,
    rows: Vec<u32>,
    cols: Vec<u32>,
    group: &[usize],
) -> Result<FormattingResult, String> {
    let params = FormattingParams { rows, cols, bold: Some(true), ..Default::default() };
    apply_formatting_on(&b.state, &b.file, &params, group, target)
}

/// The backing sheet has B2:C2 merged; the ACTIVE sheet has no merge at all.
/// Bold on the target reports B2 spanning two columns -- the backing merge,
/// not the active sheet's mirror (`formatting_result` used to read only that).
#[test]
fn a_target_result_reports_backing_merges() {
    let b = Book::new(1);
    let (target, backing) = float_target(&b, 4, 4);
    let seed = crate::document_effect::test_seed_effect();
    b.state.all_merged_regions.write(&seed).unwrap()[backing]
        .insert(MergedRegion { start_row: 1, start_col: 1, end_row: 1, end_col: 2 });
    assert!(b.state.merged_regions.read().unwrap().is_empty(), "the active sheet has nothing merged");

    let result = bold_on(&b, Some(&target), vec![1], vec![1], &[]).expect("bold on the target");
    let b2 = result.cells.iter().find(|c| (c.row, c.col) == (1, 1)).expect("B2 is reported");
    assert_eq!((b2.row_span, b2.col_span), (1, 2), "B2 spans the backing merge B2:C2");
}

/// Bold on a floating grid writes ONLY the backing sheet -- on a worksheet
/// host AND on a canvas host -- the result cells are the backing cells, and
/// one undo restores them. A group beside a target is refused, never ignored.
#[test]
fn bold_on_a_floating_grid_target_writes_only_the_backing_sheet() {
    for canvas_host in [false, true] {
        let b = Book::new(2);
        let (target, backing) = float_target(&b, 4, 3);
        if canvas_host {
            make_host_canvas(&b);
        }
        b.seed_cell(backing, 1, 1, CellValue::Number(7.0), CellStyle::new());

        let result = bold_on(&b, Some(&target), vec![0, 1], vec![1], &[]).expect("bold on the target");
        assert!(b.style_on(backing, 0, 1).font.bold, "backing B1 (canvas host: {canvas_host})");
        assert!(b.style_on(backing, 1, 1).font.bold, "backing B2");
        assert!(!b.style_at(0, 1).font.bold, "the ACTIVE sheet's B1 is untouched");
        assert!(!b.style_at(1, 1).font.bold, "the ACTIVE sheet's B2 is untouched");
        assert!(b.state.grid.read().unwrap().get_cell(1, 1).is_none(), "no cell was created on the host");
        assert!(!b.style_on(1, 1, 1).font.bold, "the other sheet is untouched");
        let mut reported: Vec<(u32, u32)> = result.cells.iter().map(|c| (c.row, c.col)).collect();
        reported.sort_unstable();
        assert_eq!(reported, vec![(0, 1), (1, 1)], "the result reports the BACKING cells");
        let b2 = result.cells.iter().find(|c| (c.row, c.col) == (1, 1)).unwrap();
        assert_eq!(b2.display, "7", "the backing value is what is reported");
        assert!(b.file.is_dirty());
        assert_eq!(b.undo_depth(), 1, "ONE undo step");

        b.undo();
        assert!(!b.style_on(backing, 0, 1).font.bold, "undo restores backing B1");
        assert!(!b.style_on(backing, 1, 1).font.bold, "undo restores backing B2");
        assert_eq!(b.value_on(backing, 1, 1), CellValue::Number(7.0), "the value survives undo");

        // A group beside a target: refused, nothing written, still clean.
        crate::document_effect::mark_saved(&b.file);
        let err = bold_on(&b, Some(&target), vec![0], vec![0], &[1]).expect_err("target + group refuses");
        assert_eq!(err, "Pass a floating grid target or a sheet, not both.");
        assert!(!b.style_on(1, 0, 0).font.bold);
        assert!(!b.style_on(backing, 0, 0).font.bold);
        assert!(!b.file.is_dirty());
    }
}

/// The step is decided from the BACKING cell: backing B2 shows "0.00", the
/// active sheet's B2 shows "0.0000". Decrease Decimal on the target gives
/// "0.0" on the backing sheet and leaves the active sheet alone.
#[test]
fn decrease_decimal_on_a_target_decides_from_the_backing_cell() {
    let b = Book::new(1);
    b.locale("en-US");
    let (target, backing) = float_target(&b, 4, 3);
    b.seed_cell(backing, 1, 1, CellValue::Number(1.5), CellStyle::new().with_number_format(num(2, false)));
    b.seed_cell(0, 1, 1, CellValue::Number(1.5), CellStyle::new().with_number_format(num(4, false)));

    let result = adjust_number_format_decimals_on(&b.state, &b.file, &[1], &[1], -1, &[], Some(&target))
        .expect("decrease decimal on the target");
    assert_eq!(b.style_on(backing, 1, 1).number_format, num(1, false), "0.00 -> 0.0 on the backing sheet");
    assert_eq!(b.style_at(1, 1).number_format, num(4, false), "the active sheet keeps 0.0000");
    let b2 = result.cells.iter().find(|c| (c.row, c.col) == (1, 1)).expect("backing B2 reported");
    assert_eq!(b2.display, "1.5");
    assert_eq!(b.undo_depth(), 1);
}

/// A rectangle reaching past the write extent is refused, naming the cell,
/// and the document stays clean -- for every style command.
#[test]
fn a_target_outside_the_extent_is_refused_and_the_document_stays_clean() {
    let b = Book::new(1);
    crate::named_styles_cmd::init_builtin_named_styles(&b.state);
    let (target, backing) = float_target(&b, 4, 3);
    let err = bold_on(&b, Some(&target), vec![4], vec![0], &[]).expect_err("row 5 is outside a 4-row grid");
    assert_eq!(err, "Cell A5 is outside floating grid 'Float1'. Nothing was changed.");
    let err = adjust_number_format_decimals_on(&b.state, &b.file, &[0], &[3], 1, &[], Some(&target))
        .expect_err("column D is outside a 3-column grid");
    assert!(err.starts_with("Cell D1 is outside floating grid"), "got: {err}");
    let err = apply_border_preset_on(
        &b.state, &b.file, CellRect::new(0, 0, 5, 1), "outside", "solid", "#000000", 1, &[], Some(&target),
    )
    .expect_err("borders past the extent");
    assert!(err.contains("is outside floating grid 'Float1'"), "got: {err}");
    let err = set_cell_rich_text_core(&b.state, &b.file, 9, 0, None, Some(&target)).expect_err("rich text past it");
    assert!(err.contains("is outside floating grid"), "got: {err}");
    let err = crate::named_styles_cmd::apply_named_style_impl(&b.state, &b.file, "Good", &[0, 7], &[0], Some(&target))
        .expect_err("a named style past it");
    assert!(err.contains("is outside floating grid"), "got: {err}");
    assert!(!b.file.is_dirty(), "a refusal must not dirty the document");
    assert_eq!(b.undo_depth(), 0);
    assert!(b.state.grids.read().unwrap()[backing].get_cell(4, 0).is_none());
}

/// A PROTECTED HOST protects its floating grid's cells: the host's own
/// sentence, nothing written, the document clean -- even though the backing
/// sheet itself carries no protection.
#[test]
fn a_protected_host_refuses_every_style_command_on_its_grid() {
    let b = Book::new(1);
    crate::named_styles_cmd::init_builtin_named_styles(&b.state);
    let (target, backing) = float_target(&b, 4, 3);
    // A number in backing A1, so Increase Decimal has a step to gate.
    b.seed_cell(backing, 0, 0, CellValue::Number(1.5), CellStyle::new());
    let seed = crate::document_effect::test_seed_effect();
    b.state.sheet_protection.write(&seed).unwrap().entry(0).or_default().protected = true;
    assert!(b.state.sheet_protection.read().unwrap().get(&backing).is_none(), "the backing sheet is not protected");

    let err = bold_on(&b, Some(&target), vec![0], vec![0], &[]).expect_err("the host's protection refuses");
    assert!(err.starts_with("Cannot format cells on a protected sheet."), "got: {err}");
    let err = adjust_number_format_decimals_on(&b.state, &b.file, &[0], &[0], 1, &[], Some(&target))
        .expect_err("decimals refused");
    assert!(err.starts_with("Cannot format cells on a protected sheet."), "got: {err}");
    let err = apply_border_preset_on(
        &b.state, &b.file, CellRect::new(0, 0, 1, 1), "outside", "solid", "#000000", 1, &[], Some(&target),
    )
    .expect_err("borders refused");
    assert!(err.starts_with("Cannot apply borders on a protected sheet."), "got: {err}");
    let err = set_cell_rich_text_core(&b.state, &b.file, 0, 0, None, Some(&target)).expect_err("rich text refused");
    assert!(err.contains("protected"), "got: {err}");
    let err = crate::named_styles_cmd::apply_named_style_impl(&b.state, &b.file, "Good", &[0], &[0], Some(&target))
        .expect_err("a named style refused");
    assert!(err.contains("protected"), "got: {err}");

    assert!(!b.style_on(backing, 0, 0).font.bold);
    assert!(!b.file.is_dirty(), "every refusal left the document clean");
    assert_eq!(b.undo_depth(), 0);

    // Unprotected again, the same Bold lands: the refusal was the HOST's.
    b.state.sheet_protection.write(&seed).unwrap().remove(&0);
    bold_on(&b, Some(&target), vec![0], vec![0], &[]).expect("an unprotected host takes it");
    assert!(b.style_on(backing, 0, 0).font.bold);
}

/// Borders, rich text and a named style reach the backing cell, each as ONE
/// undo step, and the host's same cell stays untouched.
#[test]
fn borders_rich_text_and_a_named_style_write_only_the_backing_sheet() {
    let b = Book::new(1);
    crate::named_styles_cmd::init_builtin_named_styles(&b.state);
    let (target, backing) = float_target(&b, 4, 3);

    let result = apply_border_preset_on(
        &b.state, &b.file, CellRect::new(0, 0, 1, 1), "outside", "solid", "#000000", 1, &[], Some(&target),
    )
    .expect("borders on the target");
    assert_eq!(b.style_on(backing, 0, 0).borders.top, thin());
    assert_eq!(b.style_on(backing, 1, 1).borders.right, thin());
    assert_eq!(b.style_at(0, 0).borders, engine::Borders::default(), "the host's A1 has no border");
    assert!(result.cells.iter().any(|c| (c.row, c.col) == (1, 1)), "the backing cells are reported");
    assert_eq!(b.undo_depth(), 1);

    let runs: Vec<crate::api_types::RichTextRunData> =
        serde_json::from_str(r#"[{"text":"Hi","bold":true}]"#).expect("runs");
    b.seed_cell(backing, 2, 0, CellValue::Text("Hi".into()), CellStyle::new());
    let cell = set_cell_rich_text_core(&b.state, &b.file, 2, 0, Some(runs), Some(&target))
        .expect("rich text on the target")
        .expect("the cell is returned");
    assert_eq!(cell.display, "Hi");
    assert!(b.state.grids.read().unwrap()[backing].get_cell(2, 0).unwrap().rich_text.is_some());
    assert!(b.state.grid.read().unwrap().get_cell(2, 0).is_none(), "the host's A3 is untouched");
    assert_eq!(b.undo_depth(), 2);
    b.undo();
    assert!(b.state.grids.read().unwrap()[backing].get_cell(2, 0).unwrap().rich_text.is_none(), "undo restores it");

    let good = b.state.named_styles.read().unwrap().get("Good").expect("built-in Good").style_index;
    crate::named_styles_cmd::apply_named_style_impl(&b.state, &b.file, "Good", &[0, 1], &[2], Some(&target))
        .expect("a named style on the target");
    assert_eq!(b.state.grids.read().unwrap()[backing].get_cell(1, 2).unwrap().style_index, good);
    assert!(b.state.grid.read().unwrap().get_cell(1, 2).is_none(), "the host's C2 is untouched");
}

/// LOCK ORDER (R9). A targeted style command takes `StyleLocks` (`grid` ->
/// `grids` -> `style_registry`) and then `sheet_ids` (`ensure_target_still_at`);
/// the styled read and the resolver take `sheet_ids` alone. Run targeted
/// formatting, targeted rich text, untargeted formatting and the styled read
/// side by side, 200 times each, under a 60 s deadline.
#[test]
fn targeted_style_commands_run_beside_the_styled_read_without_deadlocking() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let state = Arc::new(crate::create_app_state());
    let file = Arc::new(FileState::default());
    let info = crate::floating_range::create_floating_range_inner(&state, &file, None, 0.0, 0.0).unwrap();
    crate::floating_range::update_floating_range_inner(
        &state,
        &file,
        info.range.id,
        crate::api_types::FloatingRangePatch { row_count: Some(5), col_count: Some(3), ..Default::default() },
        crate::floating_range::PatchGate::ObjectEdit,
    )
    .unwrap();
    let target = crate::api_types::CellTargetRef::FloatingRange { id: info.range.id };
    let finished = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();

    let mut spawn = |work: Box<dyn Fn(u32) + Send>| {
        let finished = Arc::clone(&finished);
        handles.push(std::thread::spawn(move || {
            // Counted even when `work` panics, so a failure surfaces through
            // join below instead of as a 60 s "deadlock".
            struct Done(Arc<AtomicUsize>);
            impl Drop for Done {
                fn drop(&mut self) {
                    self.0.fetch_add(1, Ordering::SeqCst);
                }
            }
            let _done = Done(finished);
            for i in 0..200u32 {
                work(i);
            }
        }));
    };
    {
        let (state, file, target) = (Arc::clone(&state), Arc::clone(&file), target.clone());
        spawn(Box::new(move |i| {
            let params = FormattingParams { rows: vec![i % 5], cols: vec![0], bold: Some(i % 2 == 0), ..Default::default() };
            apply_formatting_on(&state, &file, &params, &[], Some(&target)).unwrap();
        }));
    }
    {
        let (state, file, target) = (Arc::clone(&state), Arc::clone(&file), target.clone());
        spawn(Box::new(move |i| {
            set_cell_rich_text_core(&state, &file, i % 5, 1, None, Some(&target)).unwrap();
        }));
    }
    {
        let (state, file) = (Arc::clone(&state), Arc::clone(&file));
        spawn(Box::new(move |i| {
            let params = FormattingParams { rows: vec![i % 5], cols: vec![2], italic: Some(true), ..Default::default() };
            apply_formatting_core(&state, &file, &params, &[]).unwrap();
        }));
    }
    {
        let (state, target) = (Arc::clone(&state), target.clone());
        spawn(Box::new(move |_| {
            crate::cell_target::get_cell_target_cells_inner(&state, &target, 0, 0, 4, 2).unwrap();
        }));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while finished.load(Ordering::SeqCst) < 4 {
        assert!(std::time::Instant::now() < deadline, "a targeted style command and the styled read deadlocked");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    for handle in handles {
        handle.join().expect("every worker ran to the end without an error");
    }
}

// ---------------------------------------------------------------------------
// 8. BUG-0354: apply_formatting over whole rows, whole columns and Select All
// ---------------------------------------------------------------------------
//
// `apply_formatting` walked every (row, col) of its lists: Ctrl+A then Ctrl+B
// is 17.2 billion positions and the app stopped responding; the Borders
// split's Left/Right edge presets (and Top/Bottom on whole rows) come through
// the same command, so Left Border on a whole column wrote a million cells.
// Whole-line selections now go through the row/column TIERS. Each test below
// asserts on WHAT WAS WRITTEN -- tier entries versus cells -- and on what a
// position reads back through the normal style read, not on wall-clock alone
// (`within` only keeps a regression from hanging the suite). Excel facts are
// [LIVE] from Excel 16 on 2026-10-29: each case saved as .xlsx and its sheet
// XML read back (lane scratchpad laneA/probe.ps1, probe2.ps1).

impl Book {
    /// Type `value` at (row, col) on the active sheet through the REAL
    /// single-cell entry path, as the cell editor does.
    fn type_value(&self, row: u32, col: u32, value: &str) {
        crate::commands::data::update_cell_impl(
            &self.state,
            &self.file,
            &self.files,
            &self.slicer,
            &self.pivots,
            &self.pane,
            &self.filters,
            row,
            col,
            value.to_string(),
            None,
            None,
            None,
        )
        .unwrap_or_else(|e| panic!("typing at ({row}, {col}) failed: {e}"));
    }

    /// A whole-ROW default style on the active sheet (both mirrors).
    fn seed_row_tier(&self, row: u32, style: CellStyle) {
        let seed = crate::document_effect::test_seed_effect();
        let idx = self.state.style_registry.write(&seed).unwrap().get_or_create_explicit(style);
        self.state.grid.write(&seed).unwrap().set_row_style(row, idx);
        self.state.grids.write(&seed).unwrap()[0].set_row_style(row, idx);
    }

    /// (stored cells, row tiers, column tiers) on the active sheet's live grid.
    fn written(&self) -> (usize, usize, usize) {
        let grid = self.state.grid.read().unwrap();
        (grid.cells.len(), grid.row_styles.len(), grid.column_styles.len())
    }
}

fn thin_side() -> crate::api_types::BorderSideParam {
    crate::api_types::BorderSideParam { style: "thin".to_string(), color: "#000000".to_string() }
}

const EVERY_COLUMN: usize = engine::EXCEL_MAX_COL_INDEX as usize + 1;

/// Ctrl+A, Ctrl+B. ONE tier entry per column (every one the SAME style, as
/// Excel's single `<col min=1 max=16384>`), no cell materialised, a stored
/// cell with a style of its own keeps it and gains bold, a populated cell that
/// inherited takes the format AS ITS OWN (round-2 review revA#2 [LIVE]: Excel
/// saves `<c r=C3 s=bold>` for a value there) but is not REPORTED, an empty
/// position reads bold, the frontend is told the tier's style, and ONE Ctrl+Z
/// restores all of it.
#[test]
fn select_all_bold_writes_one_tier_per_column_and_no_cell() {
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_cell(0, 10, 3, CellValue::Number(1.0), CellStyle::new().with_italic(true));
    b.seed_cell(0, 20, 5, CellValue::Number(2.0), CellStyle::new());
    let runner = b.clone();
    let result = within(60, move || runner.format(every_row(), every_col(), |p| p.bold = Some(true)))
        .expect("Select All + Bold");

    assert_eq!(b.written(), (2, 0, EVERY_COLUMN), "(cells, row tiers, column tiers): tiers, not cells");
    let tier = {
        let grid = b.state.grid.read().unwrap();
        let mut indices: Vec<usize> = grid.column_styles.values().copied().collect();
        indices.sort_unstable();
        indices.dedup();
        assert_eq!(indices.len(), 1, "every column shares ONE tier style");
        // CHANGED DELIBERATELY (round-2 review revA#2): this asserted "an
        // inheriting cell is not rewritten" (style 0). Excel gives an existing
        // value the line's format as its own, so it travels with the value on
        // Sort / Insert Cells / Cut; style 0 left it on the line.
        assert_eq!(
            grid.get_cell(20, 5).unwrap().style_index,
            indices[0],
            "a stored value takes the line's format as its OWN style"
        );
        let mirror = &b.state.grids.read().unwrap()[0];
        assert_eq!(mirror.column_styles.len(), EVERY_COLUMN, "the second copy of the active sheet too");
        assert_eq!(mirror.get_cell(20, 5).unwrap().style_index, indices[0], "in the second copy too");
        indices[0]
    };
    let own = b.style_at(10, 3);
    assert!(own.font.bold && own.font.italic, "a cell's own style keeps its italic and gains bold");
    assert!(b.style_at(20, 5).font.bold, "a populated cell that inherits reads bold");
    assert!(b.style_at(1_000_000, 16_000).font.bold, "an empty position nobody stored reads bold");
    assert!(result.styles.iter().any(|e| e.index == tier), "the tier's style reaches the frontend cache");
    assert!(
        result.cells.iter().all(|c| (c.row, c.col) == (10, 3)),
        "only the cell whose look differs from the tier is REPORTED: {:?}",
        result.cells.iter().map(|c| (c.row, c.col)).collect::<Vec<_>>()
    );
    assert!(b.file.is_dirty());
    assert_eq!(b.undo_depth(), 1, "ONE undo step");

    b.undo();
    assert_eq!(b.written(), (2, 0, 0), "Undo removes every tier");
    assert!(!b.style_at(10, 3).font.bold && b.style_at(10, 3).font.italic, "the own style is back");
    assert!(!b.style_at(20, 5).font.bold);
    assert_eq!(b.state.grid.read().unwrap().get_cell(20, 5).unwrap().style_index, 0, "Undo gives back the inheriting cell");
    assert!(!b.style_at(1_000_000, 16_000).font.bold);
    assert_eq!(b.value_on(0, 20, 5), CellValue::Number(2.0), "values untouched");
}

/// Excel semantics: formatting a whole sheet or column sets the LINE's
/// default, so a cell typed there LATER -- through the real entry path --
/// inherits it ([LIVE] Select All Bold, then 42 typed in C7: bold).
#[test]
fn a_cell_typed_after_formatting_whole_lines_inherits_the_format() {
    let b = std::sync::Arc::new(Book::new(1));
    let runner = b.clone();
    within(60, move || runner.format(every_row(), every_col(), |p| p.bold = Some(true))).expect("Select All + Bold");
    let runner = b.clone();
    within(60, move || runner.format(every_row(), vec![2], |p| p.background_color = Some("#FFFF00".to_string())))
        .expect("column C yellow");

    b.type_value(500, 7, "42");
    b.type_value(300_000, 2, "hello");
    assert_eq!(b.value_on(0, 500, 7), CellValue::Number(42.0));
    assert!(b.style_at(500, 7).font.bold, "typed after Select All Bold: bold");
    let typed = b.style_at(300_000, 2);
    assert!(typed.font.bold, "typed in the yellow column: still bold");
    assert_eq!(typed.fill, yellow_fill(), "typed in the yellow column: yellow");
    assert_eq!(
        b.state.grid.read().unwrap().get_cell(300_000, 2).unwrap().style_index,
        0,
        "the typed cell inherits; it carries no style of its own"
    );
}

/// The Borders split's Left Border on a WHOLE COLUMN (it sends every row and
/// the one column to apply_formatting): ONE column tier, no cell beyond the
/// stored ones; populated (own style and inheriting) and empty positions read
/// the border; the neighbour column is untouched; Undo restores. Bottom
/// Border on a whole ROW is one row tier the same way.
#[test]
fn edge_borders_on_whole_lines_are_one_tier_entry() {
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_cell(0, 7, 2, CellValue::Number(1.0), CellStyle::new().with_bold(true));
    b.seed_cell(0, 8, 2, CellValue::Number(2.0), CellStyle::new());
    let runner = b.clone();
    within(60, move || runner.format(every_row(), vec![2], |p| p.border_left = Some(thin_side())))
        .expect("Left Border on column C");

    assert_eq!(b.written(), (2, 0, 1), "(cells, row tiers, column tiers): one column tier");
    assert_eq!(b.style_at(500_000, 2).borders.left, thin(), "an empty position");
    assert_eq!(b.style_at(8, 2).borders.left, thin(), "a populated cell that inherits");
    let own = b.style_at(7, 2);
    assert!(own.font.bold, "a cell's own style keeps its bold");
    assert_eq!(own.borders.left, thin());
    assert_eq!(b.style_at(500_000, 3).borders, engine::Borders::default(), "the next column is untouched");
    assert_eq!(b.undo_depth(), 1);
    b.undo();
    assert_eq!(b.written(), (2, 0, 0));
    assert_eq!(b.style_at(500_000, 2).borders.left, engine::BorderStyle::default());
    assert!(b.style_at(7, 2).font.bold);
    assert_eq!(b.style_at(7, 2).borders.left, engine::BorderStyle::default());

    let runner = b.clone();
    within(60, move || runner.format(vec![4], every_col(), |p| p.border_bottom = Some(thin_side())))
        .expect("Bottom Border on row 5");
    assert_eq!(b.written(), (2, 1, 0), "one row tier");
    assert_eq!(b.style_at(4, 16_000).borders.bottom, thin());
    assert_eq!(b.style_at(5, 16_000).borders.bottom, engine::BorderStyle::default());
}

/// Whole ROWS 1:10 Bold: ten row tiers and no cell beyond the stored one --
/// the cell walk wrote 163,840 cells here.
#[test]
fn whole_rows_bold_writes_row_tiers_not_cells() {
    let b = Book::new(1);
    b.seed_cell(0, 3, 9, CellValue::Text("kept".to_string()), CellStyle::new());
    b.format((0..10).collect(), every_col(), |p| p.bold = Some(true)).expect("rows 1:10 Bold");
    assert_eq!(b.written(), (1, 10, 0), "(cells, row tiers, column tiers)");
    assert!(b.style_at(9, engine::EXCEL_MAX_COL_INDEX).font.bold);
    assert!(b.style_at(3, 9).font.bold, "the stored value takes its row's format");
    assert!(!b.style_at(10, 0).font.bold, "row 11 is not in the selection");
    assert_eq!(b.value_on(0, 3, 9), CellValue::Text("kept".to_string()));
}

/// SELECT ALL REWRITES EVERY ROW FORMAT [LIVE: row 3 bold, then Select All
/// Italic -- row 3's own format is bold italic, no cell is written in it]. The
/// planner used to write one crossing cell per row tier per COLUMN (16,384
/// per formatted row) and refused a sheet with more than 122 formatted rows.
#[test]
fn select_all_rewrites_existing_row_formats_instead_of_writing_crossings() {
    let b = std::sync::Arc::new(Book::new(1));
    for row in [2u32, 3, 4] {
        b.seed_row_tier(row, CellStyle::new().with_bold(true));
    }
    let runner = b.clone();
    within(60, move || runner.format(every_row(), every_col(), |p| p.italic = Some(true))).expect("Select All + Italic");

    assert_eq!(b.written(), (0, 3, EVERY_COLUMN), "no crossing cell: the three row tiers took the change");
    let row = b.style_at(3, 16_000);
    assert!(row.font.bold && row.font.italic, "the row keeps its bold and gains italic");
    let other = b.style_at(8, 0);
    assert!(other.font.italic && !other.font.bold, "an unformatted row reads the column tier");
    b.undo();
    let row = b.style_at(3, 16_000);
    assert!(row.font.bold && !row.font.italic, "Undo restores the row tier");
    assert_eq!(b.written(), (0, 3, 0));
}

/// A WHOLE ROW is based on the format every column shares, else on the
/// default [LIVE]: after Select All Bold, row 5 yellow is bold + yellow with
/// NO cell written (the used range stays A5); with 16,383 of the 16,384
/// columns bold, row 5 yellow is plain yellow and each bold column's crossing
/// is a cell (XFD5 not bold, A5 bold + yellow).
#[test]
fn a_whole_row_is_based_on_the_format_every_column_shares() {
    let b = std::sync::Arc::new(Book::new(1));
    let runner = b.clone();
    within(60, move || runner.format(every_row(), every_col(), |p| p.bold = Some(true))).expect("Select All + Bold");
    let runner = b.clone();
    within(60, move || runner.format(vec![4], every_col(), |p| p.background_color = Some("#FFFF00".to_string())))
        .expect("row 5 yellow");
    assert_eq!(b.written(), (0, 1, EVERY_COLUMN), "one row tier and no crossing cell");
    let crossing = b.style_at(4, 16_000);
    assert!(crossing.font.bold, "the row tier is based on the shared bold");
    assert_eq!(crossing.fill, yellow_fill());

    let b = std::sync::Arc::new(Book::new(1));
    let runner = b.clone();
    let all_but_last: Vec<u32> = (0..engine::EXCEL_MAX_COL_INDEX).collect();
    within(60, move || runner.format(every_row(), all_but_last, |p| p.bold = Some(true))).expect("A:XFC Bold");
    let runner = b.clone();
    within(60, move || runner.format(vec![4], every_col(), |p| p.background_color = Some("#FFFF00".to_string())))
        .expect("row 5 yellow");
    let last = b.style_at(4, engine::EXCEL_MAX_COL_INDEX);
    assert!(!last.font.bold, "XFD5: the row is based on the default");
    assert_eq!(last.fill, yellow_fill());
    let first = b.style_at(4, 0);
    assert!(first.font.bold, "A5: the bold column's crossing keeps its bold");
    assert_eq!(first.fill, yellow_fill());
    assert_eq!(b.written(), (EVERY_COLUMN - 1, 1, EVERY_COLUMN - 1), "each crossing with a column format is a cell");
}

/// The RANGE form of the protection gate: a protected sheet whose every
/// column is unlocked through its tier allows Select All + Bold, answered
/// without enumerating 17.2 billion positions (the cell form did); a sheet
/// whose cells are locked refuses it before anything is written.
#[test]
fn select_all_bold_on_a_protected_sheet_is_gated_by_range() {
    let b = std::sync::Arc::new(Book::new(1));
    let mut unlocked = CellStyle::new();
    unlocked.locked = false;
    for col in 0..=engine::EXCEL_MAX_COL_INDEX {
        b.seed_column_tier(col, unlocked.clone());
    }
    let seed = crate::document_effect::test_seed_effect();
    {
        let mut protection = b.state.sheet_protection.write(&seed).unwrap();
        let sheet = protection.entry(0).or_default();
        sheet.protected = true;
        sheet.options.allow_format_cells = true;
    }
    let runner = b.clone();
    within(60, move || runner.format(every_row(), every_col(), |p| p.bold = Some(true)))
        .expect("every position is unlocked");
    let s = b.style_at(500_000, 9_000);
    assert!(s.font.bold && !s.locked, "bold, and still unlocked");

    let b = std::sync::Arc::new(Book::new(1));
    {
        let mut protection = b.state.sheet_protection.write(&seed).unwrap();
        let sheet = protection.entry(0).or_default();
        sheet.protected = true;
        sheet.options.allow_format_cells = true;
    }
    let runner = b.clone();
    let verdict = within(60, move || runner.format(every_row(), every_col(), |p| p.bold = Some(true)));
    assert!(verdict.is_err(), "locked cells refuse Select All + Bold");
    assert_eq!(b.written(), (0, 0, 0));
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
}

/// Grouped sheets: Select All + Bold reaches every sheet of the group as ONE
/// undo step, and a protected grouped sheet refuses the whole group before
/// the active sheet is written.
#[test]
fn grouped_select_all_bold_is_one_step_and_gated_whole() {
    let b = std::sync::Arc::new(Book::new(2));
    let runner = b.clone();
    within(60, move || {
        let params = FormattingParams { rows: every_row(), cols: every_col(), bold: Some(true), ..Default::default() };
        apply_formatting_core(&runner.state, &runner.file, &params, &[0, 1])
    })
    .expect("grouped Select All + Bold");
    assert!(b.style_at(700_000, 100).font.bold);
    assert!(b.style_on(1, 700_000, 100).font.bold, "the grouped sheet");
    assert_eq!(b.state.grids.read().unwrap()[1].cells.len(), 0, "no cell on the grouped sheet either");
    assert_eq!(b.undo_depth(), 1, "ONE undo step for the group");
    b.undo();
    assert!(!b.style_at(700_000, 100).font.bold);
    assert!(!b.style_on(1, 700_000, 100).font.bold);

    let b = std::sync::Arc::new(Book::new(2));
    let seed = crate::document_effect::test_seed_effect();
    b.state.sheet_protection.write(&seed).unwrap().entry(1).or_default().protected = true;
    let runner = b.clone();
    let verdict = within(60, move || {
        let params = FormattingParams { rows: every_row(), cols: every_col(), bold: Some(true), ..Default::default() };
        apply_formatting_core(&runner.state, &runner.file, &params, &[0, 1])
    });
    assert!(verdict.is_err());
    assert_eq!(b.written(), (0, 0, 0), "the active sheet was not formatted first");
    assert!(!b.file.is_dirty());
}

/// A partial rectangle too large to style cell by cell (spanning no whole
/// line, and too far from one to be whole lines plus exceptions) is refused
/// cleanly, before any guard, instead of walked: B2:F850001 (4.25 million
/// cells, just past the bound; its whole columns would need 992,880
/// exceptions) and a 3,000 x 2,000 interior block. CHANGED DELIBERATELY
/// (round-2 review revA#4): the second case was B2 to the sheet's corner,
/// which is almost-whole columns and is now ACCEPTED -- see
/// `an_almost_whole_rectangle_is_whole_lines_plus_exceptions`.
#[test]
fn a_huge_partial_rectangle_is_refused_by_apply_formatting() {
    let b = std::sync::Arc::new(Book::new(1));
    let runner = b.clone();
    // A written result is never Debug-printed: it would be millions of cells.
    let refusal = |verdict: Result<FormattingResult, String>, what: &str| -> String {
        match verdict {
            Err(message) => message,
            Ok(result) => panic!("{what} were written, not refused ({} cells reported)", result.cells.len()),
        }
    };
    let runner = b.clone();
    let verdict = within(120, move || runner.format((1..=850_000).collect(), (1..=5).collect(), |p| p.bold = Some(true)));
    let message = refusal(verdict, "4.25 million cells");
    assert!(message.starts_with("Formatting can be applied to at most"), "{message}");
    assert_eq!(b.written(), (0, 0, 0));

    let runner = b.clone();
    let verdict = within(60, move || runner.format((1_000..4_000).collect(), (100..2_100).collect(), |p| p.bold = Some(true)));
    let message = refusal(verdict, "6 million interior cells");
    assert!(message.starts_with("Formatting can be applied to at most"), "{message}");
    assert_eq!(b.written(), (0, 0, 0));
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
}

/// THE WIRE (BUG-0354): `rows` / `cols` arrive as a plain list or as an
/// `IndexRun` `{ first, last }` -- what the frontend's `encodeIndexList`
/// sends for a whole column instead of a million numbers -- and are the same
/// list in Rust. A reversed run, or one longer than a whole column, is refused
/// rather than allocated.
#[test]
fn formatting_params_take_a_run_or_a_list() {
    let params: FormattingParams = serde_json::from_value(serde_json::json!({
        "rows": { "first": 0, "last": engine::EXCEL_MAX_ROW_INDEX },
        "cols": [2],
        "bold": true,
    }))
    .expect("a run deserialises");
    assert_eq!(params.rows, every_row(), "a run is the whole list");
    assert_eq!(params.cols, vec![2]);
    assert_eq!(params.bold, Some(true));

    let params: FormattingParams =
        serde_json::from_value(serde_json::json!({ "rows": [5, 3, 4], "cols": { "first": 7, "last": 9 } }))
            .expect("a list and a short run");
    assert_eq!(params.rows, vec![5, 3, 4], "a list keeps its order (the active cell may come first)");
    assert_eq!(params.cols, vec![7, 8, 9]);

    let reversed = serde_json::from_value::<FormattingParams>(serde_json::json!({ "rows": { "first": 5, "last": 4 } }));
    assert!(reversed.is_err(), "a reversed run is refused");
    let huge = serde_json::from_value::<FormattingParams>(serde_json::json!({ "rows": { "first": 0, "last": 4_000_000_000u32 } }));
    assert!(huge.is_err(), "a run longer than a whole column is refused, not allocated");
    let absent: FormattingParams = serde_json::from_value(serde_json::json!({ "bold": true })).expect("absent lists");
    assert!(absent.rows.is_empty() && absent.cols.is_empty());
}

/// THE DECIMAL STEP'S WIRE (BUG-0354 follow-up). `adjust_number_format_decimals`
/// takes `rows` / `cols` as a list OR as an `IndexRun` (`IndexListArg`, in
/// api_types.rs beside `IndexRun`: the two shapes `FormattingParams` takes),
/// so the wrapper no longer sends Select
/// All's million row indices. A run has lost which line came first -- and the
/// Home tab puts the ACTIVE line first (Ctrl+A: `[1048575, 0, 1, ...]`) -- so
/// the wire names it apart (`activeRow` / `activeCol`), and the step must
/// decide from THAT cell, not from the run's first line.
// SABOTAGE: drop the `deserialize_with` on IndexListArg (api_types.rs) -> the run
// does not deserialise; resolve the active cell from `list.first()` only in
// adjust_number_format_decimals_from_wire -> the empty C1 decides and nothing
// is written.
#[test]
fn the_decimal_step_takes_a_run_and_decides_from_the_named_active_cell() {
    let last = engine::EXCEL_MAX_ROW_INDEX;
    let rows: IndexListArg =
        serde_json::from_value(serde_json::json!({ "first": 0, "last": last })).expect("a run deserialises");
    assert_eq!(rows.0, every_row(), "a run is the whole list");
    let list: IndexListArg = serde_json::from_value(serde_json::json!([5, 3, 4])).expect("a list deserialises");
    assert_eq!(list.0, vec![5, 3, 4], "a list keeps its order (the active line first)");
    assert!(
        serde_json::from_value::<IndexListArg>(serde_json::json!({ "first": 5, "last": 4 })).is_err(),
        "a reversed run is refused"
    );
    assert!(
        serde_json::from_value::<IndexListArg>(serde_json::json!({ "first": 0, "last": 4_000_000_000u32 })).is_err(),
        "a run longer than a whole column is refused, not allocated"
    );

    // Column C selected whole, the active cell on its LAST row holding 1.5 as
    // `0.0`. The run's first line, C1, is EMPTY -- where Excel changes nothing --
    // so a step decided from `rows[0]` would write nothing at all.
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_cell(0, last, 2, CellValue::Number(1.5), CellStyle::new().with_number_format(num(1, false)));
    let runner = b.clone();
    let result = within(60, move || {
        adjust_number_format_decimals_from_wire(&runner.state, &runner.file, &rows.0, &[2], 1, (Some(last), None), &[], None)
    })
    .expect("the step");
    assert!(!result.styles.is_empty(), "the NAMED active cell decided, so a format was written");
    assert_eq!(b.style_at(last, 2).number_format, num(2, false), "the active cell: 0.0 -> 0.00");
    assert_eq!(b.style_at(0, 2).number_format, num(2, false), "the whole column follows");
    assert_eq!(b.undo_depth(), 1, "ONE undo step");

    // Without a named line, `rows[0]` decides exactly as before.
    let b = Book::new(1);
    b.seed_cell(0, 3, 0, CellValue::Number(2.5), CellStyle::new().with_number_format(num(1, false)));
    b.seed_cell(0, 4, 0, CellValue::Number(7.0), CellStyle::new().with_number_format(num(3, false)));
    adjust_number_format_decimals_from_wire(&b.state, &b.file, &[3, 4], &[0], 1, (None, None), &[], None).unwrap();
    assert_eq!(b.style_at(4, 0).number_format, num(2, false), "row 3 (first) decided: 0.0 -> 0.00");

    // A named line OUTSIDE the selection is refused before anything is written.
    let b = Book::new(1);
    b.seed_cell(0, 7, 0, CellValue::Number(1.5), CellStyle::new());
    for active in [(Some(7), None), (None, Some(9))] {
        let err = adjust_number_format_decimals_from_wire(&b.state, &b.file, &[0, 1], &[0], 1, active, &[], None)
            .expect_err("an active line outside the selection");
        assert!(err.contains("not inside the selection"), "{err}");
    }
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
}

// ---------------------------------------------------------------------------
// 9. Round-2 review of BUG-0354 (revA#2, revA#3, revA#4)
// ---------------------------------------------------------------------------
//
// Excel facts are [LIVE] from Excel 16 on 2026-10-29, each case saved as .xlsx
// and its sheet XML read back (review scratchpad revA/probe.ps1, probe2.ps1).

const LAST_ROW: u32 = engine::EXCEL_MAX_ROW_INDEX;
const LAST_COL: u32 = engine::EXCEL_MAX_COL_INDEX;

impl Book {
    /// Sort `rect` on `sheet` (not the active sheet) by its first column,
    /// ascending, through the real off-sheet sort.
    fn sort_by_first_column(&self, sheet: usize, rect: (u32, u32, u32, u32)) {
        let params = crate::api_types::SortRangeParams {
            start_row: rect.0,
            start_col: rect.1,
            end_row: rect.2,
            end_col: rect.3,
            fields: vec![crate::api_types::SortField {
                key: 0,
                ascending: true,
                sort_on: Default::default(),
                color: None,
                icon: None,
                data_option: Default::default(),
                sub_field: None,
                custom_order: None,
            }],
            match_case: false,
            has_headers: false,
            orientation: crate::api_types::SortOrientation::Rows,
            sheet_index: Some(sheet),
            target: None,
        };
        let result = crate::commands::data::sort_range_off_sheet(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, sheet, params,
        )
        .expect("the sort runs");
        assert!(result.success, "{:?}", result.error);
    }

    /// The style index a STORED cell on the active sheet carries itself.
    fn own_style(&self, row: u32, col: u32) -> usize {
        self.state.grid.read().unwrap().get_cell(row, col).map_or(0, |c| c.style_index)
    }
}

/// revA#2. [LIVE] Row 5 Bold over A5:B5 holding values saves the row format
/// AND `<c r=A5 s=bold>`, `<c r=B5 s=bold>`: an existing value takes the
/// line's format as its OWN style. It is written but not reported (every
/// caller repaints after a whole-line format), and Undo gives back the
/// inheriting cell.
// SABOTAGE: drop the `else if changes && own_style == 0 ...` branch of
// plan_range_style's candidate loop -> A5 stays at style 0.
#[test]
fn a_stored_value_takes_the_whole_line_format_as_its_own() {
    let b = Book::new(1);
    b.seed_cell(0, 4, 0, CellValue::Number(4.0), CellStyle::new());
    b.seed_cell(0, 4, 1, CellValue::Text("t5".to_string()), CellStyle::new());
    let result = b.format(vec![4], every_col(), |p| p.bold = Some(true)).expect("row 5 Bold");
    let tier = b.state.grid.read().unwrap().row_styles.get(&4).copied().expect("row 5 has its format");
    assert_eq!(b.own_style(4, 0), tier, "A5 carries the row's format itself");
    assert_eq!(b.own_style(4, 1), tier, "B5 too");
    assert_eq!(b.written(), (2, 1, 0), "no cell beyond the two values");
    assert!(result.cells.is_empty(), "the carried values are not reported");
    assert!(result.styles.iter().any(|e| e.index == tier), "the style reaches the frontend cache");
    b.undo();
    assert_eq!(b.own_style(4, 0), 0, "Undo gives back the inheriting cell");
    assert!(!b.style_at(4, 0).font.bold);

    // A format the value already shows writes nothing, and the file stays clean.
    let b = Book::new(1);
    b.seed_column_tier(2, CellStyle::new().with_bold(true));
    b.seed_cell(0, 6, 2, CellValue::Number(1.0), CellStyle::new());
    let result = b.format(every_row(), vec![2], |p| p.bold = Some(true)).expect("column C Bold again");
    assert!(result.cells.is_empty() && result.styles.is_empty());
    assert_eq!(b.own_style(6, 2), 0, "nothing changed, so nothing was written");
    assert!(!b.file.is_dirty());
    assert_eq!(b.undo_depth(), 0);
}

/// revA#2, the scenario. [LIVE] A1:B8 = (8, "t1") .. (1, "t8"), row 5 Bold,
/// Sort A1:B8 by A: Excel saves the MOVED record (4, "t5") at row 4 with
/// s=bold on both cells, and row 5 keeps its row format. The record's format
/// went with it. (Before this, the values in row 5 only inherited the row's
/// format and the sort moved them off it plain.)
#[test]
fn sorting_after_a_row_format_moves_the_format_with_the_record() {
    let b = Book::new(2);
    for r in 0..8u32 {
        b.seed_cell(1, r, 0, CellValue::Number(f64::from(8 - r)), CellStyle::new());
        b.seed_cell(1, r, 1, CellValue::Text(format!("t{}", r + 1)), CellStyle::new());
    }
    let params = FormattingParams { rows: vec![4], cols: every_col(), bold: Some(true), ..Default::default() };
    apply_formatting_to_sheets_core(&b.state, &b.file, &[1], &params).expect("row 5 Bold on Sheet2");
    b.sort_by_first_column(1, (0, 0, 7, 1));

    assert_eq!(b.value_on(1, 3, 0), CellValue::Number(4.0), "the record (4, t5) sorts to row 4");
    assert_eq!(b.value_on(1, 3, 1), CellValue::Text("t5".to_string()));
    assert!(b.style_on(1, 3, 0).font.bold, "A4: the moved record keeps its bold");
    assert!(b.style_on(1, 3, 1).font.bold, "B4 too");
    assert!(b.style_on(1, 4, 9).font.bold, "row 5 keeps its own format where nothing is stored");
    assert!(!b.style_on(1, 2, 0).font.bold, "a record that was never in row 5 stays plain");
}

/// revA#2, the Insert Cells route: Insert Cells at A5 (shift down) moves A5's
/// value off the formatted row, and -- carrying the format as its own, as in
/// Excel -- it keeps its bold at A6.
#[test]
fn insert_cells_after_a_row_format_moves_the_format_with_the_value() {
    let b = Book::new(1);
    b.seed_cell(0, 4, 0, CellValue::Number(42.0), CellStyle::new());
    b.format(vec![4], every_col(), |p| p.bold = Some(true)).expect("row 5 Bold");
    crate::commands::structure::structure_cells::shift_cells_impl(
        &b.state, &b.file, &b.pivots, &b.files, &b.pane, &b.filters, &b.slicer, &b.timelines, 4, 0, 4, 0,
        crate::commands::structure::structure_cells::CellShift::Down, false,
    )
    .expect("Insert Cells at A5, shift down");
    assert_eq!(b.value_on(0, 5, 0), CellValue::Number(42.0), "the value moved to A6");
    assert!(b.style_at(5, 0).font.bold, "and took its bold with it");
}

/// revA#3. Format Cells > Border, inside horizontal OFF, on WHOLE columns C:F
/// after All Borders: one `insideHorizontal` preset with NO line (width 0)
/// through the tiers -- not two almost-whole strips that walked a million
/// cells per column (or were refused from four columns up). The interior
/// loses its top and bottom, the sheet's first row keeps its top edge and the
/// last row its bottom edge [LIVE: Excel's column format after this is left +
/// right only], the left/right lines stay. Whole rows with inside vertical
/// off are the same with the axes swapped; on an ordinary range it is both
/// sides of each inner boundary, and the outline stays.
// SABOTAGE: drop the `width == 0 || style == "none"` early return in
// BorderPresetDelta::new -> the "removed" sides are a solid zero-width line,
// not the empty side, and the interior assertions fail.
#[test]
fn inside_lines_off_on_whole_lines_go_through_the_tiers() {
    let none = engine::BorderStyle::default();
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_cell(0, 9, 3, CellValue::Number(1.0), CellStyle::new());
    b.border((0, 2, LAST_ROW, 5), "allBorders").expect("All Borders on C:F");
    let runner = b.clone();
    within(60, move || {
        apply_border_preset_core(&runner.state, &runner.file, CellRect::new(0, 2, LAST_ROW, 5), "insideHorizontal", "solid", "#000000", 0, &[])
    })
    .expect("inside horizontal off on C:F");
    let interior = b.style_at(500, 3).borders;
    assert_eq!((interior.top.clone(), interior.bottom.clone()), (none.clone(), none.clone()), "the inside lines are gone");
    assert_eq!((interior.left.clone(), interior.right.clone()), (thin(), thin()), "the vertical lines stay");
    assert_eq!(b.style_at(9, 3).borders.top, none, "the stored value too");
    assert_eq!(b.style_at(0, 3).borders.top, thin(), "row 1 keeps the top edge");
    assert_eq!(b.style_at(0, 3).borders.bottom, none);
    assert_eq!(b.style_at(LAST_ROW, 3).borders.bottom, thin(), "the last row keeps the bottom edge");
    assert_eq!(b.style_at(LAST_ROW, 3).borders.top, none);
    assert_eq!(b.written(), (9, 0, 4), "four column tiers, the two edge rows' cells and the value");
    assert_eq!(b.undo_depth(), 2);
    b.undo();
    assert_eq!(b.style_at(500, 3).borders.top, thin(), "Undo brings the inside lines back");

    let b = std::sync::Arc::new(Book::new(1));
    b.border((4, 0, 9, LAST_COL), "allBorders").expect("All Borders on rows 5:10");
    let runner = b.clone();
    within(60, move || {
        apply_border_preset_core(&runner.state, &runner.file, CellRect::new(4, 0, 9, LAST_COL), "insideVertical", "solid", "#000000", 0, &[])
    })
    .expect("inside vertical off on rows 5:10");
    let interior = b.style_at(6, 9_000).borders;
    assert_eq!((interior.left.clone(), interior.right.clone()), (none.clone(), none.clone()));
    assert_eq!((interior.top.clone(), interior.bottom.clone()), (thin(), thin()));
    assert_eq!(b.style_at(6, 0).borders.left, thin(), "column A keeps the left edge");
    assert_eq!(b.style_at(6, LAST_COL).borders.right, thin(), "XFD keeps the right edge");
    assert_eq!(b.written(), (12, 6, 0), "six row tiers and the two edge columns' cells");

    let b = Book::new(1);
    b.border((1, 1, 3, 3), "allBorders").unwrap();
    apply_border_preset_core(&b.state, &b.file, CellRect::new(1, 1, 3, 3), "insideHorizontal", "solid", "#000000", 0, &[])
        .unwrap();
    assert_eq!(b.style_at(1, 2).borders.top, thin(), "B2:D4: the outline's top stays");
    assert_eq!(b.style_at(1, 2).borders.bottom, none, "both sides of the inner boundary go");
    assert_eq!(b.style_at(2, 2).borders.top, none);
    assert_eq!(b.style_at(3, 2).borders.bottom, thin());
}

/// revA#4. Click A2, Ctrl+Shift+Down, Shift+Right x3, Ctrl+B: A2:D1048576 is
/// 4,194,300 cells, one row short of four whole columns. It was REFUSED
/// ("at most 4000000 cells"), and A2:A1048576 alone walked a million cells.
/// [LIVE] Excel stores it as the column format over A:D plus an exception
/// for row 1, and no cell. Here: four column tiers, and row 1 keeps what it
/// showed as a ROW format (round-3 review rev3A#7; [LIVE, lane clearfmt
/// probe.ps1] `<row r=1 customFormat=1/>`, no cell); a value inside takes the
/// format, typed cells later inherit it. The same for almost-whole ROWS
/// (B5:XFD10: six row tiers, A5:A10 kept as cells, as in Excel), and for B2
/// to the sheet's corner (17 billion cells: the column tiers of B:XFD and
/// row 1's format). CHANGED DELIBERATELY (rev3A#7): the excluded row 1 was
/// kept as one cell per column -- A1:D1, A1, and the 16,383 cells B1:XFD1
/// that ran the used range to XFD.
// SABOTAGE: make CellRect::line_extent return None unless whole_columns() ||
// whole_rows() -> A2:D1048576 is refused again.
#[test]
fn an_almost_whole_rectangle_is_whole_lines_plus_exceptions() {
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_cell(0, 0, 0, CellValue::Text("Name".to_string()), CellStyle::new());
    b.seed_cell(0, 5, 1, CellValue::Number(3.0), CellStyle::new());
    let runner = b.clone();
    let result = within(60, move || runner.format((1..=LAST_ROW).collect(), (0..4).collect(), |p| p.bold = Some(true)))
        .expect("A2:D1048576 Bold is applied, not refused");
    assert_eq!(b.written(), (2, 1, 4), "four column tiers and row 1's format; no cell beyond A1's and B6's values");
    for col in 0..4 {
        assert!(!b.style_at(0, col).font.bold, "row 1 is not in the selection (column {col})");
        assert!(b.style_at(1, col).font.bold && b.style_at(LAST_ROW, col).font.bold, "column {col}");
    }
    assert!(b.style_at(5, 1).font.bold, "B6's value");
    assert_ne!(b.own_style(5, 1), 0, "and it carries the format itself");
    assert!(!b.style_at(1, 4).font.bold && !b.style_at(0, 4).font.bold, "column E is not selected");
    assert!(result.cells.len() <= 4, "only the exceptions are reported ({})", result.cells.len());
    assert_eq!(b.undo_depth(), 1);
    b.undo();
    assert_eq!(b.written(), (2, 0, 0), "Undo removes the tiers and the exception cells");
    assert!(!b.style_at(1, 0).font.bold);

    // One column: A2:A1048576 is one column tier and one exception, at once.
    let b = std::sync::Arc::new(Book::new(1));
    let runner = b.clone();
    within(60, move || runner.format((1..=LAST_ROW).collect(), vec![0], |p| p.bold = Some(true))).expect("A2:A1048576");
    assert_eq!(b.written(), (0, 1, 1), "one column tier and row 1's format [LIVE: Excel's own two records]");
    assert!(!b.style_at(0, 0).font.bold && b.style_at(700_000, 0).font.bold);
    b.type_value(800_000, 0, "typed");
    assert!(b.style_at(800_000, 0).font.bold, "a value typed later inherits the column's format");

    // Almost-whole ROWS: B5:XFD10.
    let b = std::sync::Arc::new(Book::new(1));
    let runner = b.clone();
    within(60, move || runner.format((4..10).collect(), (1..=LAST_COL).collect(), |p| p.italic = Some(true)))
        .expect("B5:XFD10");
    assert_eq!(b.written(), (6, 6, 0), "six row tiers and A5:A10 kept");
    assert!(!b.style_at(4, 0).font.italic && !b.style_at(9, 0).font.italic, "column A is not selected");
    assert!(b.style_at(4, 1).font.italic && b.style_at(9, LAST_COL).font.italic);
    assert!(!b.style_at(10, 5).font.italic, "row 11 is not selected");

    // B2 to the sheet's corner: 17 billion cells, almost-whole columns B:XFD.
    let b = std::sync::Arc::new(Book::new(1));
    let runner = b.clone();
    within(60, move || runner.format((1..=LAST_ROW).collect(), (1..=LAST_COL).collect(), |p| p.bold = Some(true)))
        .expect("B2:XFD1048576");
    assert_eq!(b.written(), (0, 1, LAST_COL as usize), "B:XFD's tiers and row 1's format, no cell");
    assert_eq!(b.state.grid.read().unwrap().max_col, 0, "the used range no longer runs to XFD");
    assert!(!b.style_at(500, 0).font.bold, "column A is not selected");
    assert!(!b.style_at(0, 1).font.bold, "B1 is not selected");
    assert!(!b.style_at(0, LAST_COL).font.bold, "XFD1 is not selected");
    assert!(b.style_at(1, 1).font.bold && b.style_at(LAST_ROW, LAST_COL).font.bold);
}

/// rev3A#7, the crossing. [LIVE, lane clearfmt probe.ps1] Column F italic,
/// then A2:A1048576 Bold: Excel writes the column format over A, row 1's
/// format AND `<c r=F1 s=italic/>` -- the row format would otherwise hide
/// column F's italic at F1. Here the same three records. And where a column
/// OUTSIDE the range has a format and the range's own columns do not share
/// one look, the excluded positions stay cells (A2:B1048576 over a bold A and
/// a plain B: no row format can show both).
// SABOTAGE: make excluded_row_format return None -> A1 is kept as a cell and
// row 1 gets no format.
#[test]
fn an_excluded_row_keeps_its_look_as_a_row_format_with_its_crossings() {
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_column_tier(5, CellStyle::new().with_italic(true));
    let runner = b.clone();
    within(60, move || runner.format((1..=LAST_ROW).collect(), vec![0], |p| p.bold = Some(true))).expect("A2:A1048576 Bold");
    {
        let grid = b.state.grid.read().unwrap();
        assert!(grid.row_styles.contains_key(&0), "row 1 keeps its look as a row format");
        assert!(grid.get_cell(0, 0).is_none(), "A1 is no cell of its own");
        assert!(grid.get_cell(0, 5).is_some(), "F1 is the crossing the row format would hide");
        assert_eq!(grid.cells.len(), 1);
    }
    assert!(!b.style_at(0, 0).font.bold, "A1 is not selected");
    assert!(b.style_at(1, 0).font.bold && b.style_at(LAST_ROW, 0).font.bold);
    assert!(b.style_at(0, 5).font.italic, "F1 keeps column F's italic");
    assert!(b.style_at(7, 5).font.italic);
    assert!(!b.style_at(0, 9).font.italic && !b.style_at(0, 9).font.bold, "J1 stays plain");
    b.undo();
    assert_eq!(b.written(), (0, 0, 1), "Undo takes back the column format, the row format and the crossing");

    // Columns A (bold) and B (plain) show two looks on row 1: no single row
    // format holds both, so A1:B1 stay cells.
    let b = std::sync::Arc::new(Book::new(1));
    b.seed_column_tier(0, CellStyle::new().with_bold(true));
    let runner = b.clone();
    within(60, move || runner.format((1..=LAST_ROW).collect(), vec![0, 1], |p| p.italic = Some(true))).expect("A2:B1048576");
    assert!(b.state.grid.read().unwrap().row_styles.is_empty(), "no row format");
    assert!(b.style_at(0, 0).font.bold && !b.style_at(0, 0).font.italic, "A1 keeps bold, not italic");
    assert!(!b.style_at(0, 1).font.italic, "B1 stays plain");
    assert!(b.style_at(1, 1).font.italic && b.style_at(1, 0).font.bold && b.style_at(1, 0).font.italic);

    // Nothing changes on the range's columns (un-Bold on a plain C2:C1048576):
    // row 1 needs nothing to keep its look, so no row format is written and
    // the document stays clean.
    let b = std::sync::Arc::new(Book::new(1));
    let runner = b.clone();
    within(60, move || runner.format((1..=LAST_ROW).collect(), vec![2], |p| p.bold = Some(false))).expect("C2:C1048576");
    assert_eq!(b.written(), (0, 0, 0), "nothing written");
    assert!(!b.file.is_dirty());
}

/// rev3A#6. The decimal step's reply lists the NEW format first, so the
/// wrapper's recorded `styles[0].numberFormat` is the format the selection
/// took. An almost-whole range's excluded positions keep their old style --
/// here row 1's, the registry's memoised explicit default, made earlier in
/// the session (Clear Formats under a tier makes it) -- and that LOWER index
/// used to sort first: the recorder recorded `numberFormat: "General"` over
/// A2:A1048576, and replaying the macro removed the decimals.
#[test]
fn the_decimal_step_names_the_new_format_first_on_an_almost_whole_column() {
    let b = std::sync::Arc::new(Book::new(1));
    let explicit_default = {
        let seed = crate::document_effect::test_seed_effect();
        let mut registry = b.state.style_registry.write(&seed).unwrap();
        let normal = registry.default_style().clone();
        registry.get_or_create_explicit(normal)
    };
    b.seed_cell(0, 0, 0, CellValue::Text("Amount".to_string()), CellStyle::new());
    b.seed_cell(0, 1, 0, CellValue::Number(1.5), CellStyle::new());
    let runner = b.clone();
    let result = within(60, move || runner.decimals((1..=LAST_ROW).collect(), vec![0], 1)).expect("Increase Decimal");
    assert_eq!(b.style_at(1, 0).number_format, num(2, false), "A2: General 1.5 -> 0.00");
    assert_eq!(b.style_at(0, 0).number_format, NumberFormat::General, "A1 is not selected");
    assert!(
        result.styles.iter().any(|e| e.index == explicit_default),
        "precondition: the excluded row's style is reported too (indices {:?})",
        result.styles.iter().map(|e| e.index).collect::<Vec<_>>()
    );
    let registry = b.state.style_registry.read().unwrap().clone();
    assert_eq!(
        registry.get(result.styles[0].index).number_format,
        num(2, false),
        "styles[0] -- what the recorder records -- must carry the new format, not the exception's {:?}",
        result.styles[0].style.number_format
    );
}

// ---------------------------------------------------------------------------
// A cell that MOVES keeps its look (BUG-0354 follow-up, round 4)
// ---------------------------------------------------------------------------
//
// A whole-line format is ONE row/column tier, and a stored cell with style 0
// INHERITS it. Excel has no inheriting cell: every cell carries its own style
// and a line format applies only where no cell exists, so a moved cell keeps
// the look it showed and a cell landing under a line format does not pick it
// up. [LIVE] Excel 16, 2026-10-29, lane `lineformat` scratchpad probe.ps1 and
// probe2.ps1 (a fresh hidden instance and a new unsaved workbook per case,
// Font.Bold read back): with row 5 Bold --
//   - Sort A1:A8 typed AFTER the format: A4 = 4 bold, A5 = 5 plain;
//   - Delete Cells A5 shift up (A1:A8 typed after): A5 = 6 plain;
//   - Insert Cells A5 shift down (typed after): A6 = 5 bold, a value typed
//     into the inserted A5 plain;
//   - Delete Cells A3 shift up, A5:A8 empty: the empty A4 bold, a value typed
//     into A5 plain; Insert Cells A3 shift down, nothing stored: typed A5
//     plain, typed A6 bold;
//   - Copy / Cut A1 (plain) to C5 / D5, Fill Down A1:A8, Paste Special >
//     Formats of A1 onto F5: plain; an EMPTY plain position cut or copied
//     into A5: a value typed there afterwards plain.
// Typing is unchanged: a value typed under a line format inherits it
// (`a_cell_typed_after_formatting_whole_lines_inherits_the_format`).

impl Book {
    /// Insert / Delete Cells on the active sheet through the real body.
    fn shift_cells(&self, rect: (u32, u32, u32, u32), shift: crate::commands::structure::structure_cells::CellShift) {
        crate::commands::structure::structure_cells::shift_cells_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer, &self.timelines,
            rect.0, rect.1, rect.2, rect.3, shift, false,
        )
        .expect("the shift runs");
    }

    /// The style index a STORED cell on `sheet` carries itself (`None`: no cell).
    fn own_on(&self, sheet: usize, row: u32, col: u32) -> Option<usize> {
        self.state.grids.read().unwrap()[sheet].get_cell(row, col).map(|c| c.style_index)
    }

    /// A paste / fill / script batch through the REAL batch body:
    /// `(row, col, value, styleIndex)`.
    fn batch(&self, updates: &[(u32, u32, &str, Option<usize>)]) {
        let updates = updates
            .iter()
            .map(|&(row, col, value, style_index)| crate::api_types::CellUpdateInput {
                row,
                col,
                value: value.to_string(),
                style_index,
                invariant: None,
                pasted: None,
            })
            .collect();
        crate::commands::data::update_cells_batch_core(
            &self.state, &self.file, &self.files, &self.pivots, updates, None, None, None, None,
        )
        .expect("the batch runs");
    }

    /// Row 5 Bold on the active sheet, then A1:A8 = 1..8 TYPED (so A5 only
    /// inherits the row's bold).
    fn typed_after_a_bold_row_5() -> Book {
        let b = Book::new(1);
        b.format(vec![4], every_col(), |p| p.bold = Some(true)).expect("row 5 Bold");
        for r in 0..8u32 {
            b.type_value(r, 0, &(r + 1).to_string());
        }
        assert_eq!(b.own_style(4, 0), 0, "precondition: the typed A5 inherits the row's bold");
        assert!(b.style_at(4, 0).font.bold);
        b
    }
}

/// Sort: the record from the bold row takes its bold along, the record sorted
/// INTO the bold row stays plain [LIVE `sort_values_typed_AFTER_row5_bold`],
/// an empty position keeps the row's format [LIVE probe2
/// `sort_with_empty_position_in_bold_row`], and one Ctrl+Z restores exactly.
/// Driven through the off-sheet sort; the active one, a `#[tauri::command]`
/// taking `State`, is pinned on the source below.
// SABOTAGE: drop the `if inherits[col_offset]` carry in the row arm of
// sort_range_off_sheet_at -> A4 plain, A5 bold.
#[test]
fn a_sort_moves_each_record_with_its_look_across_a_row_format() {
    let b = Book::new(2);
    let params = FormattingParams { rows: vec![4], cols: every_col(), bold: Some(true), ..Default::default() };
    apply_formatting_to_sheets_core(&b.state, &b.file, &[1], &params).expect("row 5 Bold on Sheet2");
    for r in 0..8u32 {
        b.seed_cell(1, r, 0, CellValue::Number(f64::from(8 - r)), CellStyle::new());
    }
    assert_eq!(b.own_on(1, 4, 0), Some(0), "precondition: A5 (4) inherits the row's bold");
    assert!(b.style_on(1, 4, 0).font.bold);
    let depth = b.undo_depth();

    b.sort_by_first_column(1, (0, 0, 7, 1));

    assert_eq!(b.value_on(1, 3, 0), CellValue::Number(4.0));
    assert!(b.style_on(1, 3, 0).font.bold, "A4: the record from the bold row keeps its bold");
    assert_eq!(b.value_on(1, 4, 0), CellValue::Number(5.0));
    assert!(!b.style_on(1, 4, 0).font.bold, "A5: the record sorted INTO the bold row stays plain");
    assert_ne!(b.own_on(1, 4, 0), Some(0), "A5 is plain by a style of its own (explicit Normal), not by inheriting");
    assert!(b.style_on(1, 4, 1).font.bold, "B5 holds nothing: the row's format stays where it is");
    assert_eq!(b.own_on(1, 0, 0), Some(0), "nothing is written where no line format changes the look");
    assert!(!b.style_on(1, 0, 0).font.bold && !b.style_on(1, 7, 0).font.bold);

    assert_eq!(b.undo_depth(), depth + 1, "one undo step");
    b.undo();
    assert_eq!(b.value_on(1, 4, 0), CellValue::Number(4.0), "Undo puts the record back");
    assert_eq!(b.own_on(1, 4, 0), Some(0), "inheriting again");
    assert_eq!(b.own_on(1, 3, 0), Some(0));
    assert!(b.style_on(1, 4, 0).font.bold && !b.style_on(1, 3, 0).font.bold);
}

/// The ACTIVE sheet's sort is a `#[tauri::command]` taking `State`, which a
/// unit test cannot build (see `writeback_range_guard_wiring_tests` in
/// data.rs), so its carry is pinned on the source: BOTH orientations of BOTH
/// sorts carry an inheriting cell's look through `carried_line_format`, from
/// the line it came FROM to the line it lands on.
// SABOTAGE: drop the carry from the column arm of `sort_range` -> one call.
#[test]
fn every_sort_arm_carries_an_inheriting_cells_look() {
    const DATA: &str = include_str!("data.rs");
    let data = DATA.replace("\r\n", "\n");
    for signature in ["pub fn sort_range(", "fn sort_range_off_sheet_at("] {
        let start = data.find(signature).unwrap_or_else(|| panic!("{signature} not found"));
        let rest = &data[start..];
        let body = &rest[..rest.find("\n}\n").expect("end of fn")];
        assert_eq!(
            body.matches("carried_line_format(").count(),
            2,
            "{signature}: the row arm AND the column arm must carry an inheriting cell's look"
        );
        for origin in ["*original_row, target_col)", "target_row, *original_col)"] {
            assert!(body.contains(origin), "{signature}: the look must come from the ORIGINAL line ({origin})");
        }
        assert_eq!(body.matches("inherits.push(").count(), 2, "{signature}: both extractions mark the inheriting cells");
    }
}

/// Insert / Delete Cells move cells inside a band, but a row format never
/// moves: every position keeps (or, inserted, takes from its neighbour) the
/// look it showed. The four [LIVE] cases in the section comment.
// SABOTAGE: (1) drop the `cell.style_index == 0` carry in shift_cells_impl's
// lift loop -> Delete Cells A5 leaves A5 bold; (2) make plan_carried_line_looks
// return no blanks -> a value typed into the inserted A5 comes out bold (and
// the empty-position cases after it invert).
#[test]
fn insert_and_delete_cells_keep_each_positions_look_across_a_row_format() {
    use crate::commands::structure::structure_cells::CellShift;

    // Delete Cells A5, shift up: A6's 6 moves INTO the bold row and stays plain.
    let b = Book::typed_after_a_bold_row_5();
    b.shift_cells((4, 0, 4, 0), CellShift::Up);
    assert_eq!(b.value_on(0, 4, 0), CellValue::Number(6.0));
    assert!(!b.style_at(4, 0).font.bold, "A5: the value moved into the bold row stays plain");
    assert_ne!(b.own_style(4, 0), 0, "by a style of its own");
    assert!(!b.style_at(3, 0).font.bold && !b.style_at(5, 0).font.bold, "A4 and A6 stay plain");
    assert!(b.style_at(4, 1).font.bold, "B5, outside the band, keeps the row's bold");
    b.undo();
    assert_eq!(b.value_on(0, 4, 0), CellValue::Number(5.0), "Undo restores the cells");
    assert_eq!(b.own_style(4, 0), 0, "and A5 inherits again");
    assert!(b.style_at(4, 0).font.bold);

    // Insert Cells A5, shift down: A5's 5 is carried OFF the bold row, bold;
    // the inserted A5 takes its neighbour A4's look.
    let b = Book::typed_after_a_bold_row_5();
    b.shift_cells((4, 0, 4, 0), CellShift::Down);
    assert_eq!(b.value_on(0, 5, 0), CellValue::Number(5.0));
    assert!(b.style_at(5, 0).font.bold, "A6: the value carried off the bold row keeps its bold");
    assert!(!b.style_at(6, 0).font.bold, "A7 (was A6) stays plain");
    b.type_value(4, 0, "new");
    assert!(!b.style_at(4, 0).font.bold, "a value typed into the inserted A5 is plain, as its neighbour A4");

    // Delete Cells A3, shift up, with A5:A8 EMPTY: the empty positions move too.
    let b = Book::new(1);
    for r in 0..4u32 {
        b.type_value(r, 0, &(r + 1).to_string());
    }
    b.format(vec![4], every_col(), |p| p.bold = Some(true)).expect("row 5 Bold");
    b.shift_cells((2, 0, 2, 0), CellShift::Up);
    assert!(b.style_at(3, 0).font.bold, "the empty A5's bold moved up to A4 with the position");
    b.type_value(3, 0, "t4");
    b.type_value(4, 0, "t5");
    assert!(b.style_at(3, 0).font.bold, "a value typed into A4 is bold");
    assert!(!b.style_at(4, 0).font.bold, "a value typed into A5 is plain (A6's look moved up)");
    assert!(b.style_at(4, 1).font.bold, "B5, outside the band, keeps the row's bold");

    // Insert Cells A3, shift down, nothing stored.
    let b = Book::new(1);
    b.format(vec![4], every_col(), |p| p.bold = Some(true)).expect("row 5 Bold");
    b.shift_cells((2, 0, 2, 0), CellShift::Down);
    b.type_value(4, 0, "t5");
    b.type_value(5, 0, "t6");
    assert!(!b.style_at(4, 0).font.bold, "typed A5 is plain (A4's look moved down)");
    assert!(b.style_at(5, 0).font.bold, "typed A6 is bold (A5's look moved down)");

    // The other axis: Delete Cells B1, shift LEFT, under a COLUMN format.
    let b = Book::new(1);
    b.format(every_row(), vec![2], |p| p.bold = Some(true)).expect("column C Bold");
    for c in 0..5u32 {
        b.type_value(0, c, &(c + 1).to_string());
    }
    b.shift_cells((0, 1, 0, 1), CellShift::Left);
    assert_eq!(b.value_on(0, 0, 1), CellValue::Number(3.0));
    assert!(b.style_at(0, 1).font.bold, "B1: the value from the bold column keeps its bold");
    assert_eq!(b.value_on(0, 0, 2), CellValue::Number(4.0));
    assert!(!b.style_at(0, 2).font.bold, "C1: the value moved into the bold column stays plain");
    assert!(b.style_at(1, 2).font.bold, "C2, outside the band, keeps the column's bold");
}

/// Copy / Cut + Paste, Fill and a script's paste "all" send the source cell's
/// DISPLAYED index, so `styleIndex: 0` means "look Normal": under a line
/// format it is written as the explicit Normal, and a pasted EMPTY position
/// keeps its look as an empty cell. A batch write naming no style still
/// inherits, like typing. [LIVE] copy / cut / fill / empty-position cases in
/// the section comment.
// SABOTAGE: make own_index_for_requested_look return `requested` unchanged ->
// C5 comes out bold; route the empty value straight to clear_cell -> E5 and D8
// hold nothing.
#[test]
fn a_pasted_or_filled_plain_cell_stays_plain_in_a_formatted_row() {
    let b = Book::new(1);
    b.format(vec![4], every_col(), |p| p.bold = Some(true)).expect("row 5 Bold");
    let bold = b.state.grid.read().unwrap().row_styles[&4];
    let yellow = {
        let mut style = CellStyle::new();
        style.fill = yellow_fill();
        b.state.style_registry.write(&crate::document_effect::test_seed_effect()).unwrap().get_or_create(style)
    };
    let depth = b.undo_depth();

    b.batch(&[
        (4, 2, "1", Some(0)),      // C5: a plain cell pasted into the bold row
        (4, 3, "x", None),         // D5: written with no style named
        (4, 4, "", Some(0)),       // E5: an empty plain position pasted there
        (4, 5, "", Some(bold)),    // F5: an empty position that looked like the row
        (7, 2, "2", Some(0)),      // C8: a plain cell where no line format sits
        (7, 3, "", Some(yellow)),  // D8: an empty yellow position (Excel pastes its fill)
        (7, 4, "", None),          // E8: a clear
    ]);

    assert!(!b.style_at(4, 2).font.bold, "C5: a plain cell pasted into a bold row stays plain");
    assert_ne!(b.own_style(4, 2), 0, "by the explicit Normal, not index 0 (which inherits)");
    assert!(b.style_at(4, 3).font.bold, "D5: a write naming no style inherits the row, like typing");
    assert_eq!(b.own_style(4, 3), 0);
    assert!(!b.style_at(4, 4).font.bold, "E5: the pasted empty position keeps its plain look");
    b.type_value(4, 4, "typed");
    assert!(!b.style_at(4, 4).font.bold, "and a value typed there afterwards is plain");
    assert!(b.own_on(0, 4, 5).is_none(), "F5: the same look as the row needs no cell");
    assert!(b.style_at(4, 5).font.bold);
    assert_eq!(b.own_style(7, 2), 0, "C8: no line format, so 0 stays 0 -- nothing interned for it");
    assert_eq!(b.style_at(7, 3).fill, yellow_fill(), "D8: a pasted empty yellow position stays yellow");
    assert!(b.own_on(0, 7, 4).is_none(), "E8: a value-less write naming no style still clears");
    assert_eq!(b.undo_depth(), depth + 2, "the batch, then the typed value");

    b.undo();
    b.undo();
    assert_eq!(b.written(), (0, 1, 0), "Undo leaves only the row's format");
}

/// Drag-move, Format Painter and Paste Special > Formats write through
/// `set_cell_style` with the source's DISPLAYED index (a `#[tauri::command]`
/// taking `State`): its decision is `own_index_for_requested_look`, proved
/// here, and the wiring is pinned on the source. [LIVE] probe.ps1
/// `paste_formats_plain_onto_bold_row`: Paste Special > Formats of a plain A1
/// onto F5 (typed after row 5 Bold) leaves F5 plain.
// SABOTAGE: drop the `own_index_for_requested_look` call from set_cell_style.
#[test]
fn a_style_written_by_look_is_the_explicit_normal_only_where_a_line_format_shows_through() {
    let b = Book::new(1);
    b.format(vec![4], every_col(), |p| p.bold = Some(true)).expect("row 5 Bold");
    {
        let grid = b.state.grid.read().unwrap();
        let mut styles = b.state.style_registry.write(&crate::document_effect::test_seed_effect()).unwrap();
        let in_row = own_index_for_requested_look(&mut styles, &grid, 4, 5, 0);
        assert_ne!(in_row, 0, "under the bold row, Normal must be explicit");
        assert_eq!(styles.get(in_row), styles.default_style(), "and look Normal");
        assert_eq!(own_index_for_requested_look(&mut styles, &grid, 6, 5, 0), 0, "no line format: 0 stays 0");
        assert_eq!(own_index_for_requested_look(&mut styles, &grid, 4, 5, 7), 7, "a named non-zero style is kept");
    }
    const STYLES: &str = include_str!("styles.rs");
    let styles_rs = STYLES.replace("\r\n", "\n");
    let start = styles_rs.find("pub fn set_cell_style(").expect("set_cell_style");
    let rest = &styles_rs[start..];
    let body = &rest[..rest.find("\n}\n").expect("end of fn")];
    let decide = body.find("own_index_for_requested_look(").expect("set_cell_style decides the own index by look");
    let write = body.find("grid.set_cell(").expect("set_cell_style writes the cell");
    assert!(decide < write, "set_cell_style must decide the own index BEFORE it writes the cell");
}
