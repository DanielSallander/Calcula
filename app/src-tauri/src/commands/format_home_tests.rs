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

/// A partial rectangle too large to style cell by cell is refused, cleanly
/// (B2 to the sheet's corner is 17 billion cells and spans no whole axis).
#[test]
fn a_huge_partial_rectangle_is_refused_without_touching_anything() {
    let b = Book::new(1);
    let verdict = b.border(
        (1, 1, engine::EXCEL_MAX_ROW_INDEX, engine::EXCEL_MAX_COL_INDEX),
        "allBorders",
    );
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
        // The body moved into the target-aware twin (P3); _core delegates to it.
        (STYLES, "pub(crate) fn adjust_number_format_decimals_on(", "gate_style_targets("),
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
