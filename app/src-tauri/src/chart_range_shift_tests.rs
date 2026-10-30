//! FILENAME: app/src-tauri/src/chart_range_shift_tests.rs
//! PURPOSE: BUG-0357 -- chart and sparkline data ranges follow insert/delete
//!          rows, columns and cells. Every expectation below is a measurement
//!          on live Excel 16 (2026-10-29; see the rules in chart_range_shift.rs)
//!          unless it says it is a divergence.

use super::*;
use crate::api_types::{ChartEntry, SparklineEntry};
use crate::commands::structure::structure_cells::{BandEdit, CellShift};
use calp::writeback::StructuralEdit as SE;
use serde_json::json;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// 0-based, inclusive.
fn rect(r0: u32, c0: u32, r1: u32, c1: u32) -> CellRange {
    CellRange { start_row: r0, end_row: r1, start_col: c0, end_col: c1 }
}

fn rows_insert(at: u32, count: u32) -> BandEdit {
    BandEdit::whole_lines(SE::RowInsert { at, count })
}
fn rows_delete(at: u32, count: u32) -> BandEdit {
    BandEdit::whole_lines(SE::RowDelete { at, count })
}
fn cols_insert(at: u32, count: u32) -> BandEdit {
    BandEdit::whole_lines(SE::ColInsert { at, count })
}
fn cols_delete(at: u32, count: u32) -> BandEdit {
    BandEdit::whole_lines(SE::ColDelete { at, count })
}

/// The probe chart: Sheet1!A1:C5, header row, categories in A, Sales (B) and Cost (C).
const A1C5: CellRange = CellRange { start_row: 0, end_row: 4, start_col: 0, end_col: 2 };

fn probe_shape() -> SeriesShape {
    SeriesShape { has_headers: true, columns: true, category: 0, series: vec![1, 2] }
}

fn moved(r: CellRange, series: &[Option<u32>], category: u32, has_headers: bool) -> RangeShift {
    RangeShift::Moved { rect: r, series: series.to_vec(), category, has_headers }
}

const SHEET1: EditedSheet<'static> = EditedSheet { index: 0, id: "S0", name: "Sheet1" };

/// The probe chart as the store keeps it, its range a DataRangeRef on sheet S0.
fn probe_record() -> serde_json::Value {
    json!({
        "chartId": "c1", "name": "Chart 1", "sheetIndex": 0, "x": 0, "y": 0, "width": 300, "height": 200,
        "spec": {
            "mark": "bar",
            "data": { "sheetIndex": 0, "sheetId": "S0", "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 2 },
            "hasHeaders": true, "seriesOrientation": "columns", "categoryIndex": 0,
            "series": [
                { "name": "Sales", "sourceIndex": 1, "color": null },
                { "name": "Cost", "sourceIndex": 2, "color": null }
            ]
        }
    })
}

/// A chart placed on the edited sheet (a worksheet).
fn shifted(record: &serde_json::Value, sheet: &EditedSheet, band: &BandEdit) -> Option<serde_json::Value> {
    shifted_on(record, sheet, band, ParamHost::Worksheet { edited: true })
}

fn shifted_on(
    record: &serde_json::Value,
    sheet: &EditedSheet,
    band: &BandEdit,
    host: ParamHost,
) -> Option<serde_json::Value> {
    shift_chart_record(&record.to_string(), sheet, band, host).map(|s| serde_json::from_str(&s).unwrap())
}

// ---------------------------------------------------------------------------
// One chart range: rows (the points)
// ---------------------------------------------------------------------------

#[test]
fn a_row_inserted_inside_the_range_grows_it() {
    // Insert row 3: SERIES(..,$A$2:$A$6,$B$2:$B$6,..).
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_insert(2, 1)), moved(rect(0, 0, 5, 2), &[Some(1), Some(2)], 0, true));
    // Insert row 5 (the last data row) grows it too.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_insert(4, 1)), moved(rect(0, 0, 5, 2), &[Some(1), Some(2)], 0, true));
}

#[test]
fn a_row_inserted_at_the_first_row_moves_the_range_and_one_just_after_changes_nothing() {
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_insert(0, 1)), moved(rect(1, 0, 5, 2), &[Some(1), Some(2)], 0, true));
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_insert(5, 1)), RangeShift::Same);
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_insert(9, 3)), RangeShift::Same);
}

#[test]
fn a_row_inserted_at_the_first_data_row_grows_the_range_a_known_divergence() {
    // Excel moves the values to B3:B6 and keeps the name in B1; one rectangle
    // cannot say that, so the inserted row becomes an empty point.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_insert(1, 1)), moved(rect(0, 0, 5, 2), &[Some(1), Some(2)], 0, true));
}

#[test]
fn deleting_rows_shrinks_the_range_and_deleting_all_of_it_is_ref() {
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_delete(2, 1)), moved(rect(0, 0, 3, 2), &[Some(1), Some(2)], 0, true));
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_delete(0, 5)), RangeShift::Gone);
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_delete(5, 2)), RangeShift::Same);
    // Every data row deleted: the header row is all that is left (Excel's
    // series are #REF! -- nothing is plotted either way).
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_delete(1, 4)), moved(rect(0, 0, 0, 2), &[Some(1), Some(2)], 0, true));
}

#[test]
fn deleting_the_header_row_keeps_every_value_with_the_header_row_off() {
    // Excel: the names become #REF!, the values A2:A5 -> A1:A4 are all kept.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &rows_delete(0, 1)), moved(rect(0, 0, 3, 2), &[Some(1), Some(2)], 0, false));
}

// ---------------------------------------------------------------------------
// One chart range: columns (the series)
// ---------------------------------------------------------------------------

#[test]
fn a_column_inserted_between_series_repoints_the_later_series() {
    // Insert column C: Cost moves to D, the inserted column is no series.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cols_insert(2, 1)), moved(rect(0, 0, 4, 3), &[Some(1), Some(3)], 0, true));
    // Insert column B: both series move, the category stays in A.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cols_insert(1, 1)), moved(rect(0, 0, 4, 3), &[Some(2), Some(3)], 0, true));
    // Two columns at once.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cols_insert(2, 2)), moved(rect(0, 0, 4, 4), &[Some(1), Some(4)], 0, true));
}

#[test]
fn a_column_inserted_at_the_first_column_moves_the_range_and_one_just_after_changes_nothing() {
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cols_insert(0, 1)), moved(rect(0, 1, 4, 3), &[Some(1), Some(2)], 0, true));
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cols_insert(3, 1)), RangeShift::Same);
}

#[test]
fn deleting_a_series_column_takes_that_series_out() {
    // Excel leaves a #REF! series that plots nothing; Cost is now column B.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cols_delete(1, 1)), moved(rect(0, 0, 4, 1), &[None, Some(1)], 0, true));
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cols_delete(0, 3)), RangeShift::Gone);
}

#[test]
fn deleting_the_category_column_moves_the_category_to_a_line_that_is_no_series() {
    // Every line left is a series: the first one (Excel shows 1, 2, 3 ...).
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cols_delete(0, 1)), moved(rect(0, 0, 4, 1), &[Some(0), Some(1)], 0, true));
    // A1:D5 plotting B and C only: column D (now C) becomes the category.
    let wide = rect(0, 0, 4, 3);
    assert_eq!(shift_chart_range(wide, &probe_shape(), &cols_delete(0, 1)), moved(rect(0, 0, 4, 2), &[Some(0), Some(1)], 2, true));
}

#[test]
fn whole_column_series_ignore_row_edits_and_follow_column_edits() {
    let whole = rect(0, 0, engine::EXCEL_MAX_ROW_INDEX, 2);
    assert_eq!(shift_chart_range(whole, &probe_shape(), &rows_insert(2, 1)), RangeShift::Same);
    assert_eq!(
        shift_chart_range(whole, &probe_shape(), &cols_insert(1, 1)),
        moved(rect(0, 0, engine::EXCEL_MAX_ROW_INDEX, 3), &[Some(2), Some(3)], 0, true)
    );
}

#[test]
fn series_in_rows_swap_the_two_axes() {
    // A1:E3: names in column A, categories in row 1, series in rows 2 and 3.
    let r = rect(0, 0, 2, 4);
    let shape = SeriesShape { has_headers: true, columns: false, category: 0, series: vec![1, 2] };
    assert_eq!(shift_chart_range(r, &shape, &rows_insert(2, 1)), moved(rect(0, 0, 3, 4), &[Some(1), Some(3)], 0, true));
    assert_eq!(shift_chart_range(r, &shape, &rows_delete(1, 1)), moved(rect(0, 0, 1, 4), &[None, Some(1)], 0, true));
    assert_eq!(shift_chart_range(r, &shape, &cols_insert(2, 1)), moved(rect(0, 0, 2, 5), &[Some(1), Some(2)], 0, true));
    // The name column deleted: the header column is off.
    assert_eq!(shift_chart_range(r, &shape, &cols_delete(0, 1)), moved(rect(0, 0, 2, 3), &[Some(1), Some(2)], 0, false));
}

// ---------------------------------------------------------------------------
// One chart range: Insert / Delete Cells
// ---------------------------------------------------------------------------

fn cells(r0: u32, c0: u32, r1: u32, c1: u32, shift: CellShift) -> BandEdit {
    BandEdit::new(r0, c0, r1, c1, shift)
}

#[test]
fn insert_cells_down_over_every_series_column_follows_the_series() {
    // B3:C3 down: Excel's values B2:B6 / C2:C6 (the categories stay A2:A5).
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(2, 1, 2, 2, CellShift::Down)), moved(rect(0, 0, 5, 2), &[Some(1), Some(2)], 0, true));
    // A3:C3 and A3:D3 down: everything grows, like a whole row.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(2, 0, 2, 2, CellShift::Down)), moved(rect(0, 0, 5, 2), &[Some(1), Some(2)], 0, true));
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(2, 0, 2, 3, CellShift::Down)), moved(rect(0, 0, 5, 2), &[Some(1), Some(2)], 0, true));
}

#[test]
fn insert_or_delete_cells_under_one_series_only_keeps_the_address() {
    // B3 down: Excel's Sales is B2:B6 and Cost C2:C5 -- they part ways.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(2, 1, 2, 1, CellShift::Down)), RangeShift::Same);
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(2, 1, 2, 1, CellShift::Up)), RangeShift::Same);
    // Only the category column (A3 down): the series stay where they are.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(2, 0, 2, 0, CellShift::Down)), RangeShift::Same);
}

#[test]
fn delete_cells_up_across_the_range_shrinks_it() {
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(2, 0, 2, 2, CellShift::Up)), moved(rect(0, 0, 3, 2), &[Some(1), Some(2)], 0, true));
}

#[test]
fn insert_cells_right_over_the_whole_range_moves_it() {
    // A1:A5 right: every series and the category move one column.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(0, 0, 4, 0, CellShift::Right)), moved(rect(0, 1, 4, 3), &[Some(1), Some(2)], 0, true));
    // A band that misses the range's rows changes nothing.
    assert_eq!(shift_chart_range(A1C5, &probe_shape(), &cells(7, 0, 9, 0, CellShift::Right)), RangeShift::Same);
}

// ---------------------------------------------------------------------------
// The stored record
// ---------------------------------------------------------------------------

#[test]
fn the_stored_record_follows_a_row_insert_and_says_nothing_when_nothing_moved() {
    let next = shifted(&probe_record(), &SHEET1, &rows_insert(2, 1)).expect("the range moved");
    assert_eq!(next["spec"]["data"], json!({ "sheetIndex": 0, "sheetId": "S0", "startRow": 0, "startCol": 0, "endRow": 5, "endCol": 2 }));
    assert_eq!(next["spec"]["series"], probe_record()["spec"]["series"]);
    // The placement is not a range.
    assert_eq!(next["sheetIndex"], json!(0));
    assert_eq!(shifted(&probe_record(), &SHEET1, &rows_insert(5, 1)), None);
}

#[test]
fn a_range_on_another_sheet_is_matched_by_its_id_first() {
    let other = EditedSheet { index: 1, id: "S1", name: "Sheet2" };
    assert_eq!(shifted(&probe_record(), &other, &rows_insert(0, 1)), None, "the edit is on another sheet");
    // The id wins over a stale index.
    let mut stale = probe_record();
    stale["spec"]["data"]["sheetIndex"] = json!(1);
    assert!(shifted(&stale, &SHEET1, &rows_insert(0, 1)).is_some());
    assert_eq!(shifted(&stale, &other, &rows_insert(0, 1)), None);
    // A range without an id is matched by its index.
    let mut by_index = probe_record();
    by_index["spec"]["data"].as_object_mut().unwrap().remove("sheetId");
    by_index["spec"]["data"]["sheetIndex"] = json!(1);
    assert!(shifted(&by_index, &other, &rows_insert(0, 1)).is_some());
    assert_eq!(shifted(&by_index, &SHEET1, &rows_insert(0, 1)), None);
}

#[test]
fn a_deleted_series_takes_what_is_keyed_by_its_position_with_it() {
    let mut record = probe_record();
    record["spec"]["series"] = json!([
        { "name": "Sales", "sourceIndex": 1, "color": null },
        { "name": "Cost", "sourceIndex": 2, "color": null },
        { "name": "Tax", "sourceIndex": 3, "color": null }
    ]);
    record["spec"]["data"]["endCol"] = json!(3);
    record["spec"]["trendlines"] = json!([{ "type": "linear" }, { "type": "linear", "seriesIndex": 1 }, { "type": "linear", "seriesIndex": 2 }]);
    record["spec"]["dataPointOverrides"] = json!([{ "seriesIndex": 1, "categoryIndex": 0, "color": "#f00" }, { "seriesIndex": 2, "categoryIndex": 1, "color": "#0f0" }]);
    record["spec"]["filters"] = json!({ "hiddenSeries": [1, 2], "hiddenCategories": [0] });
    record["spec"]["seriesRefs"] = json!([{ "valRef": "Sheet1!$B$2:$B$5" }, { "valRef": "Sheet1!$C$2:$C$5" }, { "valRef": "Sheet1!$D$2:$D$5" }]);
    // Delete column C: Cost (array position 1) leaves, Tax steps down to D -> C.
    let next = shifted(&record, &SHEET1, &cols_delete(2, 1)).expect("moved");
    assert_eq!(next["spec"]["data"]["endCol"], json!(2));
    assert_eq!(
        next["spec"]["series"],
        json!([{ "name": "Sales", "sourceIndex": 1, "color": null }, { "name": "Tax", "sourceIndex": 2, "color": null }])
    );
    assert_eq!(next["spec"]["trendlines"], json!([{ "type": "linear" }, { "type": "linear", "seriesIndex": 1 }]));
    assert_eq!(next["spec"]["dataPointOverrides"], json!([{ "seriesIndex": 1, "categoryIndex": 1, "color": "#0f0" }]));
    assert_eq!(next["spec"]["filters"], json!({ "hiddenSeries": [1], "hiddenCategories": [0] }));
    assert_eq!(next["spec"]["seriesRefs"], json!([{ "valRef": "Sheet1!$B$2:$B$5" }, { "valRef": "Sheet1!$C$2:$C$5" }]));
}

#[test]
fn a_range_deleted_whole_becomes_ref_and_keeps_its_series() {
    let next = shifted(&probe_record(), &SHEET1, &rows_delete(0, 5)).expect("moved");
    assert_eq!(next["spec"]["data"], json!(REF_ERROR_SOURCE));
    assert_eq!(next["spec"]["series"], probe_record()["spec"]["series"]);
}

#[test]
fn a_sheet_qualified_a1_string_follows_by_name_in_its_own_form() {
    let with_data = |data: serde_json::Value| {
        let mut r = probe_record();
        r["spec"]["data"] = data;
        r
    };
    let data_after = |r: &serde_json::Value, band: &BandEdit| shifted(r, &SHEET1, band).map(|n| n["spec"]["data"].clone());
    assert_eq!(data_after(&with_data(json!("Sheet1!A1:C5")), &rows_insert(2, 1)), Some(json!("Sheet1!A1:C6")));
    assert_eq!(data_after(&with_data(json!("sheet1!$A$1:$C$5")), &rows_insert(0, 1)), Some(json!("sheet1!$A$2:$C$6")));
    assert_eq!(data_after(&with_data(json!("Sheet1!A:C")), &cols_insert(1, 1)), Some(json!("Sheet1!A:D")));
    assert_eq!(data_after(&with_data(json!("Sheet1!A1:C5")), &rows_delete(0, 5)), Some(json!(REF_ERROR_SOURCE)));
    let quoted = EditedSheet { index: 0, id: "S0", name: "My Sheet's" };
    assert_eq!(
        shifted(&with_data(json!("'My Sheet''s'!A1:C5")), &quoted, &rows_insert(2, 1)).map(|n| n["spec"]["data"].clone()),
        Some(json!("'My Sheet''s'!A1:C6"))
    );
    // Unqualified text means the ACTIVE sheet at read time, and a defined
    // name follows its own definition: neither is rewritten.
    assert_eq!(data_after(&with_data(json!("A1:C5")), &rows_insert(2, 1)), None);
    assert_eq!(data_after(&with_data(json!("SalesData")), &rows_insert(2, 1)), None);
    assert_eq!(data_after(&with_data(json!("Sheet2!A1:C5")), &rows_insert(2, 1)), None);
}

#[test]
fn model_and_pivot_sources_have_no_cells_and_are_left_alone() {
    for data in [
        json!({ "type": "pivot", "pivotId": "p1" }),
        json!({ "type": "designQuery", "dslText": "ROWS: Region", "connectionId": "x" }),
    ] {
        let mut r = probe_record();
        r["spec"]["data"] = data;
        assert_eq!(shifted(&r, &SHEET1, &rows_insert(0, 1)), None);
        assert_eq!(shifted(&r, &SHEET1, &cols_delete(0, 3)), None);
    }
}

#[test]
fn layers_lookups_concat_children_and_bare_specs_follow_too() {
    let r = json!({
        "mark": "bar",
        "data": "SalesData",
        "layers": [
            { "mark": "line", "data": { "sheetIndex": 0, "startRow": 0, "startCol": 4, "endRow": 4, "endCol": 6 }, "series": [{ "name": "L", "sourceIndex": 2 }] },
            { "mark": "rule" }
        ],
        "transform": [{ "type": "lookup", "from": { "sheetIndex": 0, "startRow": 10, "startCol": 0, "endRow": 20, "endCol": 1 } }],
        "concat": { "charts": [{ "mark": "bar", "data": { "sheetIndex": 0, "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 2 }, "series": [{ "name": "S", "sourceIndex": 1 }] }] }
    });
    // Insert column F (index 5): the layer's series 2 (column G) moves to H.
    let next = shifted(&r, &SHEET1, &cols_insert(5, 1)).expect("moved");
    assert_eq!(next["layers"][0]["data"]["endCol"], json!(7));
    assert_eq!(next["layers"][0]["series"][0]["sourceIndex"], json!(3));
    assert_eq!(next["layers"][1], json!({ "mark": "rule" }));
    assert_eq!(next["transform"][0]["from"]["endCol"], json!(1), "left of the insert");
    assert_eq!(next["concat"]["charts"][0]["data"]["endCol"], json!(2), "left of the insert");
    // Insert row 3: the lookup table moves down, the concat child grows.
    let next = shifted(&r, &SHEET1, &rows_insert(2, 1)).expect("moved");
    assert_eq!(next["transform"][0]["from"]["startRow"], json!(11));
    assert_eq!(next["concat"]["charts"][0]["data"]["endRow"], json!(5));
    assert_eq!(next["data"], json!("SalesData"));
}

// ---------------------------------------------------------------------------
// Chart PARAMETER cells (rule 6): `params[].cellRef` and `params[].writeTo`
// ---------------------------------------------------------------------------

/// The probe chart with one cell-bound, write-back param, one sheet-qualified
/// param and one whose write-back names a range (neither is a cell the param
/// reader uses).
fn with_params(params: serde_json::Value) -> serde_json::Value {
    let mut r = probe_record();
    r["spec"]["params"] = params;
    r
}

fn probe_params() -> serde_json::Value {
    json!([
        { "name": "Threshold", "cellRef": "=H1", "writeTo": "$J$10", "select": "point" },
        { "name": "Other", "cellRef": "Sheet2!H1" },
        { "name": "Area", "writeTo": "H1:I2" }
    ])
}

#[test]
fn a_param_cell_moves_like_a_formula_reference_and_a_deleted_one_is_ref() {
    // Insert row 1: =H1 is now =H2 (Excel's formula reference), $J$10 is $J$11.
    let next = shifted(&with_params(probe_params()), &SHEET1, &rows_insert(0, 1)).expect("moved");
    assert_eq!(next["spec"]["params"][0]["cellRef"], json!("=H2"));
    assert_eq!(next["spec"]["params"][0]["writeTo"], json!("$J$11"));
    assert_eq!(next["spec"]["params"][1]["cellRef"], json!("Sheet2!H1"), "a qualified ref is no param cell");
    assert_eq!(next["spec"]["params"][2]["writeTo"], json!("H1:I2"), "a range is no param cell");
    // Insert column I: H stays, J moves to K.
    let next = shifted(&with_params(probe_params()), &SHEET1, &cols_insert(8, 1)).expect("moved");
    assert_eq!(next["spec"]["params"][0]["cellRef"], json!("=H1"));
    assert_eq!(next["spec"]["params"][0]["writeTo"], json!("$K$10"));
    // Delete row 1: the read cell is gone (the reader then keeps the default
    // and the write-back is skipped); the write-back cell moves up.
    let next = shifted(&with_params(probe_params()), &SHEET1, &rows_delete(0, 1)).expect("moved");
    assert_eq!(next["spec"]["params"][0]["cellRef"], json!("=#REF!"));
    assert_eq!(next["spec"]["params"][0]["writeTo"], json!("$J$9"));
    // Insert Cells down over H1:H1 moves only the cell in the band.
    let next = shifted(&with_params(probe_params()), &SHEET1, &cells(0, 7, 0, 7, CellShift::Down)).expect("moved");
    assert_eq!(next["spec"]["params"][0]["cellRef"], json!("=H2"));
    assert_eq!(next["spec"]["params"][0]["writeTo"], json!("$J$10"), "column J is outside the band");
    // Nothing on the param's lines: nothing moves, the text is left alone.
    let mut far = with_params(json!([{ "name": "T", "cellRef": "=H1" }]));
    far["spec"]["data"] = json!({ "type": "pivot", "pivotId": "p1" });
    assert_eq!(shifted(&far, &SHEET1, &rows_insert(5, 1)), None);
}

#[test]
fn param_cells_follow_the_sheet_the_param_reads() {
    let no_names = DefinedNameSheets::new();
    let canvas = ParamHost::Canvas { names: &no_names };
    let record = with_params(json!([{ "name": "T", "cellRef": "=H1", "writeTo": "=J1" }]));
    // Placed on ANOTHER worksheet than the edited one: its params are on its
    // own sheet; only the data range (on the edited sheet) moves.
    let next = shifted_on(&record, &SHEET1, &rows_insert(0, 1), ParamHost::Worksheet { edited: false }).expect("the data moved");
    assert_eq!(next["spec"]["data"]["startRow"], json!(1));
    assert_eq!(next["spec"]["params"][0]["cellRef"], json!("=H1"));
    assert_eq!(next["spec"]["params"][0]["writeTo"], json!("=J1"));
    // Placed on a CANVAS: its params are on its data's sheet -- the edited one here.
    let next = shifted_on(&record, &SHEET1, &rows_insert(0, 1), canvas).expect("moved");
    assert_eq!(next["spec"]["params"][0]["cellRef"], json!("=H2"));
    assert_eq!(next["spec"]["params"][0]["writeTo"], json!("=J2"));
    // A canvas chart whose data is on another sheet, or has no sheet at all.
    let sheet2 = EditedSheet { index: 1, id: "S1", name: "Sheet2" };
    assert_eq!(shifted_on(&record, &sheet2, &rows_insert(0, 1), canvas), None);
    let mut model = record.clone();
    model["spec"]["data"] = json!({ "type": "designQuery", "dslText": "ROWS: Region", "connectionId": "x" });
    assert_eq!(shifted_on(&model, &SHEET1, &rows_insert(0, 1), canvas), None);
    // The data range deleted whole: the canvas params were on its sheet all the same.
    let next = shifted_on(&record, &SHEET1, &rows_delete(0, 5), canvas).expect("moved");
    assert_eq!(next["spec"]["data"], json!(REF_ERROR_SOURCE));
    assert_eq!(next["spec"]["params"][0]["cellRef"], json!("=#REF!"));
}

/// rev3C#4: a canvas chart whose data is a DEFINED NAME reads its params on
/// the sheet the name's range is on, as `locateParamCell` -> `resolveDataSource`
/// (Charts/lib/dataSourceResolver.ts) finds it -- so its param cells move with
/// THAT sheet's edits.
#[test]
fn a_canvas_charts_params_follow_the_sheet_of_the_defined_name_it_reads() {
    // The workbook's names as the registry keeps them (upper-cased key).
    let registry: std::collections::HashMap<String, crate::named_ranges::NamedRange> = [
        ("SalesData", None, "=Sheet1!$A$1:$C$5"),
        ("LocalData", Some(0), "=$A$1:$C$5"),
        ("OtherData", None, "=Sheet2!$A$1:$C$5"),
    ]
    .into_iter()
    .map(|(name, sheet_index, refers_to)| {
        let entry = crate::named_ranges::NamedRange {
            name: name.to_string(),
            sheet_index,
            refers_to: refers_to.to_string(),
            comment: None,
            folder: None,
        };
        (name.to_uppercase(), entry)
    })
    .collect();
    let names = defined_name_sheets(&registry);
    let canvas = ParamHost::Canvas { names: &names };
    let named = |data: &str| {
        let mut r = with_params(json!([{ "name": "T", "cellRef": "=B1", "writeTo": "=B1" }]));
        r["spec"]["data"] = json!(data);
        r
    };
    // SalesData (=Sheet1!$A$1:$C$5), Insert Row 1 on Sheet1: =B1 is =B2.
    let next = shifted_on(&named("SalesData"), &SHEET1, &rows_insert(0, 1), canvas).expect("the param cells moved");
    assert_eq!(next["spec"]["params"][0]["cellRef"], json!("=B2"), "the param reads its name's sheet");
    assert_eq!(next["spec"]["params"][0]["writeTo"], json!("=B2"), "and writes back there");
    assert_eq!(next["spec"]["data"], json!("SalesData"), "the name follows its own definition");
    // The name looked up as `get_named_range` does: case aside, trimmed.
    assert!(shifted_on(&named(" salesdata "), &SHEET1, &rows_insert(0, 1), canvas).is_some());
    // An unqualified definition on a Sheet1-scoped name is Sheet1's too.
    assert!(shifted_on(&named("LocalData"), &SHEET1, &rows_insert(0, 1), canvas).is_some());
    // A name on ANOTHER sheet, an unknown name, an unqualified A1 string (the
    // active sheet at read time): nothing on the edited sheet.
    assert_eq!(shifted_on(&named("OtherData"), &SHEET1, &rows_insert(0, 1), canvas), None);
    assert_eq!(shifted_on(&named("NoSuchName"), &SHEET1, &rows_insert(0, 1), canvas), None);
    assert_eq!(shifted_on(&named("A1:C5"), &SHEET1, &rows_insert(0, 1), canvas), None);
    // ...and its own sheet's edits move it.
    let sheet2 = EditedSheet { index: 1, id: "S1", name: "Sheet2" };
    assert!(shifted_on(&named("OtherData"), &sheet2, &rows_insert(0, 1), canvas).is_some());
    // A WORKSHEET chart's params are on its own sheet, whatever its data is.
    assert_eq!(shifted_on(&named("SalesData"), &SHEET1, &rows_insert(0, 1), ParamHost::Worksheet { edited: false }), None);
}

/// Which sheet a definition puts a name's range on (`parseRefersToFormula`,
/// then `resolveDataSource`): qualified, else the name's scope; never for
/// what that reader refuses.
#[test]
fn a_defined_names_sheet_is_its_definitions_qualifier_else_its_scope() {
    let named = |s: &str| Some(NameSheet::Named(s.to_string()));
    assert_eq!(name_definition_sheet("=Sheet1!$A$1:$C$5", None), named("Sheet1"));
    assert_eq!(name_definition_sheet("='My Sheet'!B2", Some(3)), named("My Sheet"));
    assert_eq!(name_definition_sheet("='Rock''n'!a1:c5", None), named("Rock'n"));
    assert_eq!(name_definition_sheet("=$A$1:$C$5", Some(2)), Some(NameSheet::Scope(2)));
    // Unqualified and workbook-scoped: read on the ACTIVE sheet -- none known here.
    assert_eq!(name_definition_sheet("=$A$1:$C$5", None), None);
    // What `parseA1Reference` refuses is no data range at all.
    assert_eq!(name_definition_sheet("=0.25", Some(0)), None);
    assert_eq!(name_definition_sheet("=Sheet1!A:C", None), None);
    assert_eq!(name_definition_sheet("=SUM(Sheet1!A1:A3)", None), None);
    assert_eq!(name_definition_sheet("=Sheet1!A0", None), None);
    // Deleted whole: the qualifier (or the scope) it had.
    assert_eq!(name_definition_sheet("=Sheet1!#REF!", None), named("Sheet1"));
    assert_eq!(name_definition_sheet("=#REF!", Some(1)), Some(NameSheet::Scope(1)));
    assert_eq!(name_definition_sheet("=#REF!", None), None);
}

/// The four places a spec keeps a range are walked by TWO functions: the
/// load-time sheet-id stamp (`stamp_chart_record_sheet_ids`) and this shift.
/// On the stamp's own shared fixture, every range the stamp walk reaches must
/// be one this walk moves -- a place one of them forgets fails here.
#[test]
fn the_shift_walk_reaches_every_place_the_stamp_walk_does() {
    const STAMP_FIXTURE: &str = include_str!("../../extensions/Charts/lib/__tests__/fixtures/chartSheetIdStamp.json");
    /// How many range objects (`startRow` holders) differ in `key` between the two.
    fn changed_ranges(before: &serde_json::Value, after: &serde_json::Value, key: &str) -> usize {
        match (before, after) {
            (serde_json::Value::Object(b), serde_json::Value::Object(a)) => {
                let here = usize::from(b.contains_key("startRow") && b.get(key) != a.get(key));
                here + b.iter().map(|(k, v)| a.get(k).map_or(0, |av| changed_ranges(v, av, key))).sum::<usize>()
            }
            (serde_json::Value::Array(b), serde_json::Value::Array(a)) => {
                b.iter().zip(a).map(|(x, y)| changed_ranges(x, y, key)).sum()
            }
            _ => 0,
        }
    }
    let fixture: serde_json::Value = serde_json::from_str(STAMP_FIXTURE).unwrap();
    let mut checked = 0;
    for case in fixture["cases"].as_array().unwrap() {
        let record = &case["record"];
        for sheet in 0..3usize {
            let only = |i: usize| (i == sheet).then(|| format!("id-{i}"));
            let stamps = crate::chart_commands::stamp_chart_record_sheet_ids(&record.to_string(), &only).map_or(0, |text| {
                changed_ranges(record, &serde_json::from_str(&text).unwrap(), "sheetId")
            });
            let edited = EditedSheet { index: sheet, id: "no-such-id", name: "no-such-sheet" };
            let shifts = shifted(record, &edited, &rows_insert(0, 1)).map_or(0, |next| changed_ranges(record, &next, "startRow"));
            assert_eq!(shifts, stamps, "case `{}`, sheet {}", case["name"].as_str().unwrap(), sheet);
            checked += stamps;
        }
    }
    // Seven unstamped ranges in the fixture (two of them in one concat case).
    assert!(checked >= 7, "the fixture's ranges were reached ({checked})");
}

// ---------------------------------------------------------------------------
// Sparklines
// ---------------------------------------------------------------------------

/// The probe group: E2:E5 over A2:C5, one sparkline per row.
fn probe_groups() -> serde_json::Value {
    json!([{
        "id": 1, "type": "line", "color": "#4472C4",
        "location": { "startRow": 1, "startCol": 4, "endRow": 4, "endCol": 4 },
        "dataRange": { "startRow": 1, "startCol": 0, "endRow": 4, "endCol": 2 }
    }])
}

/// (location, data) of every group after the edit; `None` = nothing moved.
fn groups_after(groups: &serde_json::Value, band: &BandEdit) -> Option<Vec<(CellRange, CellRange, u64)>> {
    let text = shift_sparkline_groups(&groups.to_string(), band)?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    Some(
        v.as_array()
            .unwrap()
            .iter()
            .map(|g| {
                assert_eq!(g["type"], json!("line"), "every other property is kept");
                (
                    ref_rect(g["location"].as_object().unwrap()).unwrap(),
                    ref_rect(g["dataRange"].as_object().unwrap()).unwrap(),
                    g["id"].as_u64().unwrap(),
                )
            })
            .collect(),
    )
}

#[test]
fn a_sparkline_group_grows_with_a_row_inserted_inside_or_just_after_it() {
    // Insert row 3: E2:E6 over A2:C6 -- the inserted row is a sparkline too.
    assert_eq!(groups_after(&probe_groups(), &rows_insert(2, 1)), Some(vec![(rect(1, 4, 5, 4), rect(1, 0, 5, 2), 1)]));
    // Insert row 6, just after: Excel's "format same as above" grows it too.
    assert_eq!(groups_after(&probe_groups(), &rows_insert(5, 1)), Some(vec![(rect(1, 4, 5, 4), rect(1, 0, 5, 2), 1)]));
    // Insert row 2, the first: it moves.
    assert_eq!(groups_after(&probe_groups(), &rows_insert(1, 1)), Some(vec![(rect(2, 4, 5, 4), rect(2, 0, 5, 2), 1)]));
    assert_eq!(groups_after(&probe_groups(), &rows_insert(7, 1)), None);
}

#[test]
fn a_sparkline_group_shrinks_with_deleted_rows_and_goes_with_all_of_them() {
    assert_eq!(groups_after(&probe_groups(), &rows_delete(2, 1)), Some(vec![(rect(1, 4, 3, 4), rect(1, 0, 3, 2), 1)]));
    assert_eq!(groups_after(&probe_groups(), &rows_delete(1, 4)), Some(vec![]));
}

#[test]
fn sparkline_columns_move_the_location_as_cells_and_the_data_as_a_reference() {
    // Insert column B: E -> F, data A2:D5.
    assert_eq!(groups_after(&probe_groups(), &cols_insert(1, 1)), Some(vec![(rect(1, 5, 4, 5), rect(1, 0, 4, 3), 1)]));
    // Insert column A: F, B2:D5.
    assert_eq!(groups_after(&probe_groups(), &cols_insert(0, 1)), Some(vec![(rect(1, 5, 4, 5), rect(1, 1, 4, 3), 1)]));
    // Insert column E, at the location: the data stays.
    assert_eq!(groups_after(&probe_groups(), &cols_insert(4, 1)), Some(vec![(rect(1, 5, 4, 5), rect(1, 0, 4, 2), 1)]));
    // Delete column B: D2:D5 over A2:B5.
    assert_eq!(groups_after(&probe_groups(), &cols_delete(1, 1)), Some(vec![(rect(1, 3, 4, 3), rect(1, 0, 4, 1), 1)]));
    // Delete column E: the location is gone, so is the group.
    assert_eq!(groups_after(&probe_groups(), &cols_delete(4, 1)), Some(vec![]));
    // Delete A:C: Excel keeps #REF! sparklines that draw nothing; the group goes.
    assert_eq!(groups_after(&probe_groups(), &cols_delete(0, 3)), Some(vec![]));
}

#[test]
fn a_row_location_takes_a_sparkline_for_a_column_inserted_inside_it() {
    // A7:C7 over A2:C5 (one data column per cell). Insert column B: A7:D7
    // over A2:D5 -- B7 is a copy of A7 over B2:B5.
    let groups = json!([{
        "id": 4, "type": "line",
        "location": { "startRow": 6, "startCol": 0, "endRow": 6, "endCol": 2 },
        "dataRange": { "startRow": 1, "startCol": 0, "endRow": 4, "endCol": 2 }
    }]);
    assert_eq!(groups_after(&groups, &cols_insert(1, 1)), Some(vec![(rect(6, 0, 6, 3), rect(1, 0, 4, 3), 4)]));
}

#[test]
fn insert_cells_splits_a_group_where_its_sparklines_part_ways() {
    // A3:C3 down (data only): Excel's E2 <- A2:C2, E3 <- A4:C4, E4 <- A5:C5,
    // E5 <- A6:C6 -- two groups here, the second with a fresh id.
    assert_eq!(
        groups_after(&probe_groups(), &cells(2, 0, 2, 2, CellShift::Down)),
        Some(vec![(rect(1, 4, 1, 4), rect(1, 0, 1, 2), 1), (rect(2, 4, 4, 4), rect(3, 0, 5, 2), 2)])
    );
    // E3 down (location only): Excel's E2 <- A2:C2, E3 <- A3:C3 (the copy),
    // E4 <- A3:C3, E5 <- A4:C4, E6 <- A5:C5.
    assert_eq!(
        groups_after(&probe_groups(), &cells(2, 4, 2, 4, CellShift::Down)),
        Some(vec![(rect(1, 4, 2, 4), rect(1, 0, 2, 2), 1), (rect(3, 4, 5, 4), rect(2, 0, 4, 2), 2)])
    );
}

// ---------------------------------------------------------------------------
// Through the real structural commands, and their undo
// ---------------------------------------------------------------------------

struct Harness {
    state: AppState,
    file: crate::persistence::FileState,
    files: crate::persistence::UserFilesState,
    slicer: crate::slicer::SlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

impl Harness {
    /// Two sheets, Sheet1 (active) and Sheet2.
    fn new() -> Self {
        let state = crate::create_app_state();
        let seed = crate::document_effect::test_seed_effect();
        state.grids.write(&seed).unwrap().push(engine::Grid::new());
        state.sheet_names.write(&seed).unwrap().push("Sheet2".to_string());
        state.all_column_widths.write(&seed).unwrap().push(std::collections::HashMap::new());
        state.all_row_heights.write(&seed).unwrap().push(std::collections::HashMap::new());
        state.all_user_hidden_rows.write(&seed).unwrap().push(std::collections::HashSet::new());
        state.all_user_hidden_cols.write(&seed).unwrap().push(std::collections::HashSet::new());
        state.sheet_ids.write(&seed).unwrap().push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            while all.len() < 2 {
                all.push(std::collections::HashSet::new());
            }
        }
        Harness {
            state,
            file: crate::persistence::FileState::default(),
            files: crate::persistence::UserFilesState::default(),
            slicer: crate::slicer::SlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn sheet_id(&self, index: usize) -> String {
        self.state.sheet_ids.read().unwrap()[index].to_string()
    }

    /// A chart ON sheet 0 over `data` (A1:C5 on the sheet `data_sheet` names by id).
    fn add_chart(&self, data_sheet: usize) -> identity::EntityId {
        let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let mut record = probe_record();
        record["spec"]["data"]["sheetIndex"] = json!(data_sheet);
        record["spec"]["data"]["sheetId"] = json!(self.sheet_id(data_sheet));
        self.state
            .charts
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
            .push(ChartEntry { id, sheet_index: 0, spec_json: record.to_string() });
        id
    }

    fn chart_data(&self, id: identity::EntityId) -> serde_json::Value {
        let charts = self.state.charts.read().unwrap();
        let entry = charts.iter().find(|c| c.id == id).expect("the chart is there");
        serde_json::from_str::<serde_json::Value>(&entry.spec_json).unwrap()["spec"]["data"].clone()
    }

    fn insert_rows(&self, row: u32, count: u32, sheet: Option<usize>) {
        crate::commands::structure::insert_rows_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
            &self.timeline, row, count, sheet,
        )
        .expect("insert_rows");
    }

    fn delete_columns(&self, col: u32, count: u32) {
        crate::commands::structure::delete_columns_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
            &self.timeline, col, count, None,
        )
        .expect("delete_columns");
    }

    fn insert_cells_down(&self, r0: u32, c0: u32, r1: u32, c1: u32) {
        let result = crate::commands::structure::structure_cells::shift_cells_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
            &self.timeline, r0, c0, r1, c1, CellShift::Down, false,
        )
        .expect("insert_cells");
        assert!(result.applied, "the cell shift was applied");
    }

    fn undo(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane, &self.timeline,
            transaction, true,
        );
    }

    fn redo(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_redo().expect("nothing to redo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane, &self.timeline,
            transaction, false,
        );
    }
}

#[test]
fn insert_rows_moves_the_chart_range_and_one_undo_puts_it_back() {
    let h = Harness::new();
    let chart = h.add_chart(0);
    let before = h.state.charts.read().unwrap()[0].spec_json.clone();
    h.insert_rows(2, 1, None);
    assert_eq!(h.chart_data(chart)["endRow"], json!(5), "the chart reads the inserted row's data too");
    h.undo();
    assert_eq!(h.state.charts.read().unwrap()[0].spec_json, before, "undo of the insert restores the chart exactly");
    h.redo();
    assert_eq!(h.chart_data(chart)["endRow"], json!(5));
}

#[test]
fn an_edit_on_another_sheet_moves_the_ranges_that_read_it_and_only_those() {
    let h = Harness::new();
    let on_sheet2 = h.add_chart(1);
    let on_sheet1 = h.add_chart(0);
    // Off the active sheet (a script's insert on Sheet2).
    h.insert_rows(0, 2, Some(1));
    assert_eq!(h.chart_data(on_sheet2)["startRow"], json!(2));
    assert_eq!(h.chart_data(on_sheet2)["endRow"], json!(6));
    assert_eq!(h.chart_data(on_sheet1)["startRow"], json!(0), "Sheet1's range did not move");
    h.undo();
    assert_eq!(h.chart_data(on_sheet2)["startRow"], json!(0));
    // Undo puts a restored chart back in its place in the store.
    let order: Vec<identity::EntityId> = h.state.charts.read().unwrap().iter().map(|c| c.id).collect();
    assert_eq!(order, vec![on_sheet2, on_sheet1]);
}

#[test]
fn delete_columns_takes_the_deleted_series_out_of_the_stored_chart() {
    let h = Harness::new();
    let chart = h.add_chart(0);
    h.delete_columns(1, 1);
    let spec: serde_json::Value = serde_json::from_str(&h.state.charts.read().unwrap()[0].spec_json).unwrap();
    assert_eq!(spec["spec"]["data"]["endCol"], json!(1));
    assert_eq!(spec["spec"]["series"], json!([{ "name": "Cost", "sourceIndex": 1, "color": null }]));
    h.undo();
    assert_eq!(h.chart_data(chart)["endCol"], json!(2));
}

#[test]
fn insert_cells_moves_the_chart_and_the_sparklines_in_one_undo_step() {
    let h = Harness::new();
    let chart = h.add_chart(0);
    h.state
        .sparklines
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .push(SparklineEntry { sheet_index: 0, groups_json: probe_groups().to_string() });
    // B3:C3 down: the series columns grow; E is not in the band.
    h.insert_cells_down(2, 1, 2, 2);
    assert_eq!(h.chart_data(chart)["endRow"], json!(5));
    let groups: serde_json::Value = serde_json::from_str(&h.state.sparklines.read().unwrap()[0].groups_json).unwrap();
    assert_eq!(groups, probe_groups(), "the sparkline data A2:C5 straddles the band B:C and keeps its address");
    // A3:E3 down: the data and the location both move.
    h.insert_cells_down(2, 0, 2, 4);
    let groups: serde_json::Value = serde_json::from_str(&h.state.sparklines.read().unwrap()[0].groups_json).unwrap();
    assert_eq!(groups[0]["location"], json!({ "startRow": 1, "startCol": 4, "endRow": 5, "endCol": 4 }));
    assert_eq!(groups[0]["dataRange"], json!({ "startRow": 1, "startCol": 0, "endRow": 5, "endCol": 2 }));
    h.undo();
    let groups: serde_json::Value = serde_json::from_str(&h.state.sparklines.read().unwrap()[0].groups_json).unwrap();
    assert_eq!(groups, probe_groups(), "one undo puts the sparklines back with the cells");
    assert_eq!(h.chart_data(chart)["endRow"], json!(5), "the earlier step is still done");
}

#[test]
fn a_canvas_charts_param_cell_follows_its_data_sheet_through_the_real_command_and_its_undo() {
    let h = Harness::new();
    // Sheet2 is a canvas page; its chart reads Sheet1!A1:C5 and binds =H1 / writes =J1.
    h.state
        .sheet_kinds
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .push(::persistence::SheetKind::Canvas(::persistence::CanvasLayout::default()));
    let on_canvas = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let mut record = with_params(json!([{ "name": "T", "cellRef": "=H1", "writeTo": "=J1" }]));
    record["spec"]["data"]["sheetId"] = json!(h.sheet_id(0));
    // A worksheet chart on Sheet1 with the same params: its cells are Sheet1's too.
    let on_sheet = h.add_chart(0);
    {
        let mut charts = h.state.charts.write(&crate::document_effect::test_seed_effect()).unwrap();
        charts.push(ChartEntry { id: on_canvas, sheet_index: 1, spec_json: record.to_string() });
        let sheet_chart = charts.iter_mut().find(|c| c.id == on_sheet).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&sheet_chart.spec_json).unwrap();
        v["spec"]["params"] = json!([{ "name": "T", "cellRef": "=H1" }]);
        sheet_chart.spec_json = v.to_string();
    }
    let params_of = |id: identity::EntityId| -> serde_json::Value {
        let charts = h.state.charts.read().unwrap();
        let entry = charts.iter().find(|c| c.id == id).unwrap();
        serde_json::from_str::<serde_json::Value>(&entry.spec_json).unwrap()["spec"]["params"].clone()
    };
    let before = params_of(on_canvas);
    h.insert_rows(0, 1, None);
    assert_eq!(params_of(on_canvas)[0]["cellRef"], json!("=H2"), "the canvas chart's param reads its data sheet");
    assert_eq!(params_of(on_canvas)[0]["writeTo"], json!("=J2"), "and writes back there");
    assert_eq!(params_of(on_sheet)[0]["cellRef"], json!("=H2"), "a worksheet chart's param is on its own sheet");
    h.undo();
    assert_eq!(params_of(on_canvas), before, "one undo puts the param cells back with the rows");
    // Rows inserted below both cells move neither.
    h.insert_rows(20, 1, None);
    assert_eq!(params_of(on_canvas), before);
}

/// rev3C#4 through the real command: the canvas chart's data is the defined
/// name SalesData (=Sheet1!$A$1:$C$5), its param reads / writes =B1. Insert
/// Row 1 on Sheet1 moves the name AND the param cell; one undo puts both back.
#[test]
fn a_canvas_chart_over_a_defined_name_moves_its_param_cell_with_the_names_sheet() {
    let h = Harness::new();
    let seed = crate::document_effect::test_seed_effect();
    h.state
        .sheet_kinds
        .write(&seed)
        .unwrap()
        .push(::persistence::SheetKind::Canvas(::persistence::CanvasLayout::default()));
    h.state.named_ranges.write(&seed).unwrap().insert(
        "SALESDATA".to_string(),
        crate::named_ranges::NamedRange {
            name: "SalesData".to_string(),
            sheet_index: None,
            refers_to: "=Sheet1!$A$1:$C$5".to_string(),
            comment: None,
            folder: None,
        },
    );
    let on_canvas = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let mut record = with_params(json!([{ "name": "T", "cellRef": "=B1", "writeTo": "=B1" }]));
    record["spec"]["data"] = json!("SalesData");
    record["sheetIndex"] = json!(1);
    h.state.charts.write(&seed).unwrap().push(ChartEntry { id: on_canvas, sheet_index: 1, spec_json: record.to_string() });
    let params_of = || -> serde_json::Value {
        let charts = h.state.charts.read().unwrap();
        let entry = charts.iter().find(|c| c.id == on_canvas).unwrap();
        serde_json::from_str::<serde_json::Value>(&entry.spec_json).unwrap()["spec"]["params"].clone()
    };
    let before = params_of();
    h.insert_rows(0, 1, None);
    assert_eq!(
        h.state.named_ranges.read().unwrap()["SALESDATA"].refers_to,
        "=Sheet1!$A$2:$C$6",
        "the name follows its own definition"
    );
    assert_eq!(params_of()[0]["cellRef"], json!("=B2"), "the canvas chart's param reads its name's sheet");
    assert_eq!(params_of()[0]["writeTo"], json!("=B2"), "and a point selection writes back there");
    h.undo();
    assert_eq!(params_of(), before, "one undo puts the param cells back with the rows");
    // Rows inserted below the param cell move nothing of it.
    h.insert_rows(20, 1, None);
    assert_eq!(params_of(), before);
}
