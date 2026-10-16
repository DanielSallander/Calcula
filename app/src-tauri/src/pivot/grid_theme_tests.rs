//! FILENAME: app/src-tauri/src/pivot/grid_theme_tests.rs
//! PURPOSE: Pins `grid_theme.rs` (ruling R3, WP-C S10b): the backend reads the
//! SAME preset file the Pivot extension imports (no second list), resolves a
//! persisted style by the extension's rule, and maps cells the way the box
//! paints them. The TypeScript direction is
//! `app/extensions/Pivot/__tests__/pivotStyleSourceDrift.test.ts`.

use super::*;
use std::path::{Path, PathBuf};

fn app_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = app/src-tauri
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("app/").to_path_buf()
}

fn data() -> &'static PivotStyleData {
    pivot_style_data().expect("the compiled-in pivot style data parses")
}

fn preset_theme(name: &str) -> &'static BTreeMap<String, String> {
    &data().styles.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("no preset {}", name)).theme
}

fn hex(value: &str) -> Color {
    Color::from_hex(value).unwrap_or_else(|| panic!("{} is not a colour", value))
}

fn choice(id: &str, overrides: &[(&str, &str)]) -> PivotStyleChoice {
    PivotStyleChoice {
        style_id: id.to_string(),
        theme_overrides: overrides.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

/// The compiled-in bytes ARE the extension's file, its current bytes: a build
/// that compiled an older copy, or a path that drifted to some other file,
/// fails here. And the TypeScript styles module imports exactly that file.
///
/// SABOTAGE (confirmed): point `include_str!` at a copy of the file with one
/// colour changed -> the byte comparison fails.
#[test]
fn rust_reads_the_file_the_extension_imports() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("pivot");
    let resolved = here.join(PIVOT_STYLE_DATA_PATH);
    let on_disk = std::fs::read_to_string(&resolved)
        .unwrap_or_else(|e| panic!("{} does not resolve to a file: {}", resolved.display(), e));
    assert_eq!(on_disk, PIVOT_STYLE_DATA_JSON, "the compiled-in pivot style data is not the file's current bytes");

    let styles_dir = app_dir().join("extensions").join("Pivot").join("styles");
    assert_eq!(
        resolved.canonicalize().expect("canonical data path"),
        styles_dir.join("excelPivotStyles.json").canonicalize().expect("canonical TS data path"),
        "the backend reads a different file than the Pivot extension's styles folder holds"
    );

    let ts_module = std::fs::read_to_string(styles_dir.join("excelPivotStyles.ts")).expect("the TS styles module");
    assert!(
        ts_module.contains(r#"import pivotStyleData from "./excelPivotStyles.json";"#),
        "styles/excelPivotStyles.ts no longer imports ./excelPivotStyles.json -- two readers, two sources"
    );

    // The macro literal and the const spell the same path (include_str! takes a literal).
    let source = std::fs::read_to_string(here.join("grid_theme.rs")).expect("grid_theme.rs");
    assert!(
        source.contains(&format!("include_str!(\"{}\")", PIVOT_STYLE_DATA_PATH)),
        "grid_theme.rs: the include_str! literal and PIVOT_STYLE_DATA_PATH disagree"
    );
}

/// No hand-copied colour list is left in the pivot writer: the six constants
/// that echoed the default style are gone, and nothing in this module spells a
/// colour as code.
#[test]
fn no_second_copy_of_a_preset_colour_lives_in_rust() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("pivot");
    let operations = std::fs::read_to_string(here.join("operations.rs")).expect("operations.rs");
    for gone in ["PIVOT_HEADER_BG", "PIVOT_TOTAL_BG", "PIVOT_GRAND_TOTAL_BG", "PIVOT_FILTER_BG", "PIVOT_BORDER_COLOR", "PIVOT_HEADER_BORDER"] {
        assert!(!operations.contains(gone), "operations.rs still carries {}", gone);
    }
    assert!(!operations.contains("Color::new("), "operations.rs builds a colour from code, not from the style data");
    let theme = std::fs::read_to_string(here.join("grid_theme.rs")).expect("grid_theme.rs");
    assert!(!theme.contains("Color::new("), "grid_theme.rs builds a colour from code, not from the style data");
}

#[test]
fn the_data_file_parses_and_names_its_default() {
    let data = data();
    assert!(data.styles.len() > 80, "the catalogue lost styles: {}", data.styles.len());
    assert!(data.styles.iter().any(|s| s.name == data.default_style), "defaultStyle {} is not a preset", data.default_style);
    let mut names: Vec<&str> = data.styles.iter().map(|s| s.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), data.styles.len(), "two presets share a name");
    let keys: Vec<&String> = data.fallback_theme.keys().collect();
    for preset in &data.styles {
        assert_eq!(preset.theme.keys().collect::<Vec<_>>(), keys, "{}: its theme keys are not the fallback theme's", preset.name);
        for (k, v) in &preset.theme {
            if k == HEADER_FONT_WEIGHT {
                assert!(v == "700" || v == "400", "{}: headerFontWeight {}", preset.name, v);
            } else {
                assert!(Color::from_hex(v).is_some(), "{}: {} = {} is not a colour", preset.name, k, v);
            }
        }
    }
    // Every override key Rust accepts names a colour of the style theme.
    for key in pivot_engine::PIVOT_THEME_OVERRIDE_KEYS {
        assert!(data.fallback_theme.contains_key(*key), "override key {} is not a style theme key", key);
        assert_ne!(*key, HEADER_FONT_WEIGHT);
    }
}

/// THE RESOLUTION RULE, case for case with `resolvePivotStyleOverrides`
/// (pivotStyleSourceDrift.test.ts runs the same table on the TypeScript side).
#[test]
fn the_resolution_rule_matches_the_extension() {
    let data = data();
    let with_fallback = |preset: &BTreeMap<String, String>| {
        let mut m = data.fallback_theme.clone();
        m.extend(preset.clone());
        m
    };
    let default = with_fallback(preset_theme(&data.default_style));

    assert_eq!(resolved_theme_values(None), default, "no style = the default style");
    assert_eq!(resolved_theme_values(Some(&choice("", &[]))), default, "style id \"\" = the default style");
    assert_eq!(resolved_theme_values(Some(&choice("NoSuchStyle", &[]))), data.fallback_theme, "an unknown id = the fallback theme");
    let dark1 = resolved_theme_values(Some(&choice("PivotStyleDark1", &[])));
    assert_eq!(dark1, with_fallback(preset_theme("PivotStyleDark1")));
    assert_ne!(dark1, default, "a non-default style must differ from the default");

    let over = resolved_theme_values(Some(&choice(
        "PivotStyleDark1",
        &[
            ("grandTotalBackground", "#112233"),
            ("headerText", "#AbCdEf"),
            ("headerFontWeight", "#000000"),
            ("fontFamily", "#000000"),
            ("valueBackground", "red"),
            ("labelBackground", "#12345"),
        ],
    )));
    assert_eq!(over["grandTotalBackground"], "#112233", "a valid override wins");
    assert_eq!(over["headerText"], "#AbCdEf", "the override's spelling is kept");
    assert_eq!(over["headerFontWeight"], dark1["headerFontWeight"], "headerFontWeight is never overridden");
    assert!(!over.contains_key("fontFamily"), "a key the style theme has not is never added");
    assert_eq!(over["valueBackground"], dark1["valueBackground"], "a value that is not #rrggbb is ignored");
    assert_eq!(over["labelBackground"], dark1["labelBackground"], "a short hex is ignored");
}

/// The box's `getThemedBackground` / `getThemedTextStyle`, cell for cell.
#[test]
fn cells_take_the_colours_the_box_paints() {
    let t = PivotGridTheme::for_choice(Some(&choice("PivotStyleDark1", &[("labelBackground", "#010203")])));
    let d1 = preset_theme("PivotStyleDark1");
    use pivot_engine::{BackgroundStyle as B, PivotCellType as C};

    assert_eq!(t.background_for(&B::Header, &C::ColumnHeader), hex(&d1["headerBackground"]));
    assert_eq!(t.text_for(&B::Header, &C::ColumnHeader), hex(&d1["headerText"]));
    assert_eq!(t.background_for(&B::Subtotal, &C::RowSubtotal), hex(&d1["totalBackground"]));
    assert_eq!(t.background_for(&B::Total, &C::RowSubtotal), hex(&d1["totalBackground"]));
    assert_eq!(t.text_for(&B::Total, &C::RowSubtotal), hex(&d1["totalText"]));
    assert_eq!(t.background_for(&B::GrandTotal, &C::GrandTotal), hex(&d1["grandTotalBackground"]));
    assert_eq!(t.text_for(&B::GrandTotal, &C::GrandTotal), hex(&d1["grandTotalText"]));
    assert_eq!(t.background_for(&B::FilterRow, &C::FilterLabel), hex(&d1["filterRowBackground"]));
    assert_eq!(t.text_for(&B::FilterRow, &C::FilterLabel), hex(&d1["filterText"]));
    assert_eq!(t.background_for(&B::Alternate, &C::Data), hex(&d1["alternateRowBackground"]));
    assert_eq!(t.text_for(&B::Alternate, &C::RowHeader), hex(&d1["labelText"]));

    // Normal cells: labels vs values, and the ColumnHeader asymmetry.
    assert_eq!(t.background_for(&B::Normal, &C::RowHeader), hex("#010203"), "a row header paints labelBackground");
    assert_eq!(t.background_for(&B::Normal, &C::Corner), hex("#010203"));
    assert_eq!(t.background_for(&B::Normal, &C::Data), hex(&d1["valueBackground"]));
    assert_eq!(t.background_for(&B::Normal, &C::ColumnHeader), hex(&d1["valueBackground"]), "a ColumnHeader's BACKGROUND is a value's");
    assert_eq!(t.text_for(&B::Normal, &C::ColumnHeader), hex(&d1["labelText"]), "a ColumnHeader's TEXT is a label's");
    assert_eq!(t.text_for(&B::Normal, &C::Data), hex(&d1["valueText"]));
    assert!(t.bold_weight);
}

/// A style whose header weight is normal paints NO cell bold, as the box does.
#[test]
fn a_normal_header_weight_turns_bold_off() {
    let normal = data()
        .styles
        .iter()
        .find(|s| s.theme.get(HEADER_FONT_WEIGHT).map(String::as_str) == Some("400"))
        .expect("the catalogue has a style with a normal header weight");
    assert!(!PivotGridTheme::for_choice(Some(&choice(&normal.name, &[]))).bold_weight, "{}", normal.name);
    assert!(PivotGridTheme::default_style().bold_weight);
    assert!(weight_is_bold("700") && weight_is_bold("bold") && !weight_is_bold("400") && !weight_is_bold("normal"));
}
