//! FILENAME: app/src-tauri/src/commands/collection_preview_tests.rs
// PURPOSE: P2 S5 -- the List/Dict cell preview (`get_cell_collection`) is
//          DISPLAY text, so its numbers -- scalars and number keys, at any
//          depth -- read in the app locale. Text, booleans and errors read as
//          before, and the clipboard twin (`get_collection_texts`) stays JSON.

use engine::cell::{CellValue, DictKey};
use serde_json::json;

use super::data::collection_preview;

fn sample() -> CellValue {
    CellValue::Dict(Box::new(vec![
        (DictKey::Number(1.5), CellValue::Number(1234.5)),
        (DictKey::Text("k".to_string()), CellValue::List(Box::new(vec![
            CellValue::Number(0.25),
            CellValue::Text("2.5".to_string()),
            CellValue::Boolean(true),
        ]))),
    ]))
}

#[test]
fn a_dict_preview_reads_its_numbers_in_the_app_locale() {
    let de = engine::LocaleSettings::from_locale_id("de-DE");
    let preview = serde_json::to_value(collection_preview(Some(&sample()), &de)).unwrap();
    assert_eq!(preview["cellType"], json!("dict"));
    let entries = &preview["root"]["entries"];
    assert_eq!(entries[0]["key"], json!("1,5"), "a number KEY is display text too");
    assert_eq!(entries[0]["value"]["display"], json!("1234,5"));
    let items = &entries[1]["value"]["items"];
    assert_eq!(entries[1]["key"], json!("\"k\""));
    assert_eq!(items[0]["display"], json!("0,25"), "nested numbers localise");
    assert_eq!(items[1]["display"], json!("\"2.5\""), "text is never localised");
    assert_eq!(items[2]["display"], json!("TRUE"));
}

#[test]
fn the_invariant_preview_keeps_a_decimal_point() {
    let preview = serde_json::to_value(collection_preview(Some(&sample()), &engine::LocaleSettings::invariant())).unwrap();
    assert_eq!(preview["root"]["entries"][0]["key"], json!("1.5"));
    assert_eq!(preview["root"]["entries"][0]["value"]["display"], json!("1234.5"));
}

#[test]
fn a_list_preview_and_a_plain_cell() {
    let sv = engine::LocaleSettings::from_locale_id("sv-SE");
    let list = CellValue::List(Box::new(vec![CellValue::Number(-2.75), CellValue::Number(42.0)]));
    let preview = serde_json::to_value(collection_preview(Some(&list), &sv)).unwrap();
    assert_eq!(preview["cellType"], json!("list"));
    assert_eq!(preview["root"]["count"], json!(2));
    assert_eq!(preview["root"]["items"][0]["display"], json!("-2,75"));
    assert_eq!(preview["root"]["items"][1]["display"], json!("42"));

    let none = serde_json::to_value(collection_preview(Some(&CellValue::Number(1.0)), &sv)).unwrap();
    assert_eq!(none["cellType"], json!("none"));
    assert!(none["root"].is_null());
    assert_eq!(serde_json::to_value(collection_preview(None, &sv)).unwrap()["cellType"], json!("none"));
}
