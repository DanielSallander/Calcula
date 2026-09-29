//! Enum VARIANT FIELDS cross the Tauri boundary in camelCase.
//!
//! `#[serde(rename_all = "camelCase")]` on an ENUM renames the variant names
//! only. A struct variant's own fields keep their Rust spelling unless the enum
//! also says `rename_all_fields = "camelCase"` (or the variant carries its own
//! `#[serde(rename_all = "camelCase")]`). Two enums shipped without either, so
//! their snake_case fields never met the frontend's camelCase ones:
//!
//! * `data_validation::ListSource::Range` -- the Data Validation dialog's
//!   list-from-range rule was refused ("missing field `start_row`"), found live
//!   by `e2e/journeys/fixall-calp.spec.ts` DV-WIRE on 2026-09-29.
//! * `pivot::types::FieldGroupingConfig::ManualGrouping` -- the frontend's
//!   `ungroupedName` was read as absent, so a custom name was dropped.
//!
//! The census below reads every `.rs` file under `src` and fails on any enum
//! that renames its variants to camelCase but leaves a snake_case field in a
//! struct variant with no field renaming. The one sanctioned exception is a
//! wire format owned by someone else (`ai/wire.rs` mirrors an external API
//! and already renames per variant).

use std::path::{Path, PathBuf};

#[test]
fn a_list_source_range_reads_and_writes_camel_case_fields() {
    let json = r#"{"range":{"sheetIndex":1,"startRow":0,"startCol":0,"endRow":4,"endCol":0}}"#;
    let parsed: crate::data_validation::ListSource =
        serde_json::from_str(json).expect("the dialog's camelCase list-from-range source must deserialize");
    match &parsed {
        crate::data_validation::ListSource::Range { sheet_index, start_row, end_row, .. } => {
            assert_eq!(*sheet_index, Some(1));
            assert_eq!((*start_row, *end_row), (0, 4));
        }
        other => panic!("expected a Range source, got {:?}", other),
    }
    let back = serde_json::to_string(&parsed).unwrap();
    assert!(back.contains("\"startRow\":0") && back.contains("\"sheetIndex\":1"), "must serialize camelCase: {back}");
    assert!(!back.contains("start_row"), "no snake_case field may cross the wire: {back}");
}

#[test]
fn a_manual_grouping_keeps_its_ungrouped_name() {
    let json = r#"{"type":"manualGrouping","groups":[],"ungroupedName":"Other regions"}"#;
    let parsed: crate::pivot::types::FieldGroupingConfig =
        serde_json::from_str(json).expect("the frontend's manual grouping must deserialize");
    match &parsed {
        crate::pivot::types::FieldGroupingConfig::ManualGrouping { ungrouped_name, .. } => {
            assert_eq!(ungrouped_name.as_deref(), Some("Other regions"), "ungroupedName was dropped");
        }
        other => panic!("expected ManualGrouping, got {:?}", other),
    }
    let back = serde_json::to_string(&parsed).unwrap();
    assert!(back.contains("\"ungroupedName\":\"Other regions\""), "must serialize camelCase: {back}");
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read src") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Every `(file, enum, variant, field)` whose field would cross the wire in
/// snake_case although the enum renames its variants to camelCase.
fn snake_variant_fields(src: &str) -> Vec<(String, String, String)> {
    let mut hits = Vec::new();
    let bytes: Vec<char> = src.chars().collect();
    let text: String = bytes.iter().collect();
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find("pub enum ") {
        let at = search_from + rel;
        search_from = at + 9;
        // The serde attributes directly above the enum.
        let head_start = text[..at].rfind("\n\n").map(|i| i + 2).unwrap_or(0);
        let head = &text[head_start..at];
        let serde_attrs: Vec<&str> = head.lines().filter(|l| l.trim_start().starts_with("#[serde(")).collect();
        let renames_variants = serde_attrs.iter().any(|l| l.contains("rename_all = \"camelCase\""));
        let renames_fields = serde_attrs.iter().any(|l| l.contains("rename_all_fields"));
        if !renames_variants || renames_fields {
            continue;
        }
        let name: String = text[at + 9..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        let Some(open_rel) = text[at..].find('{') else { continue };
        let open = at + open_rel;
        let mut depth = 0usize;
        let mut close = open;
        for (i, c) in text[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &text[open + 1..close];
        // Walk the variants at depth 0 of the body.
        let lines: Vec<&str> = body.lines().collect();
        let mut i = 0;
        let mut variant_attr_renames = false;
        while i < lines.len() {
            let t = lines[i].trim();
            if t.starts_with("#[serde(") {
                if t.contains("rename_all = \"camelCase\"") {
                    variant_attr_renames = true;
                }
                i += 1;
                continue;
            }
            if t.starts_with("//") || t.starts_with("#[") || t.is_empty() {
                i += 1;
                continue;
            }
            let is_struct_variant = t.ends_with('{') && t.chars().next().is_some_and(|c| c.is_ascii_uppercase());
            if is_struct_variant {
                let variant: String = t.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                i += 1;
                while i < lines.len() && !lines[i].trim().starts_with('}') {
                    let f = lines[i].trim();
                    if !f.starts_with("//") && !f.starts_with("#[") {
                        let field: String = f.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                        let is_field = f[field.len()..].trim_start().starts_with(':');
                        if is_field && field.contains('_') && !variant_attr_renames {
                            hits.push((name.clone(), variant.clone(), field));
                        }
                    }
                    i += 1;
                }
            }
            variant_attr_renames = false;
            i += 1;
        }
    }
    hits
}

#[test]
fn the_census_sees_a_snake_case_variant_field() {
    let fixture = "#[derive(Serialize)]\n#[serde(rename_all = \"camelCase\")]\npub enum Probe {\n    Range {\n        start_row: u32,\n    },\n}\n";
    let hits = snake_variant_fields(fixture);
    assert_eq!(hits, vec![("Probe".to_string(), "Range".to_string(), "start_row".to_string())]);
    let renamed = fixture.replace("rename_all = \"camelCase\"", "rename_all = \"camelCase\", rename_all_fields = \"camelCase\"");
    assert!(snake_variant_fields(&renamed).is_empty(), "rename_all_fields must satisfy the census");
    let per_variant = fixture.replace("    Range {", "    #[serde(rename_all = \"camelCase\")]\n    Range {");
    assert!(snake_variant_fields(&per_variant).is_empty(), "a per-variant rename must satisfy the census");
}

#[test]
fn no_enum_sends_a_snake_case_variant_field_over_the_wire() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut offenders = Vec::new();
    for file in files {
        let rel = file.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        if rel.ends_with("_tests.rs") || rel.ends_with("tests.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&file).expect("read source");
        for (e, v, f) in snake_variant_fields(&text) {
            offenders.push(format!("{rel}: {e}::{v}.{f}"));
        }
    }
    assert!(
        offenders.is_empty(),
        "enum variant fields that cross the wire in snake_case (add rename_all_fields = \"camelCase\" \
         to the enum, or #[serde(rename_all = \"camelCase\")] to the variant):\n{}",
        offenders.join("\n")
    );
}
