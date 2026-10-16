//! FILENAME: app/src-tauri/src/object_bindings/formula_tests.rs
// PURPOSE: The binding formula rules (D §3.6): locale, sheet qualification on a
//          worksheet object / a canvas chart / a canvas shape, canonical sheet
//          case, verbatim unchanged text, measure references, CUBE arguments and
//          the analysis flags.

use std::collections::HashMap;

use super::formula::*;
use crate::named_ranges::NamedRange;
use crate::tables::{Table, TableColumn, TableStyleOptions};

const SHEET1: usize = 0;
const INPUTS: usize = 1;
const REPORT: usize = 2;

fn sheet_id() -> identity::SheetId {
    identity::SheetId::from_bytes(identity::generate_uuid_v7())
}

/// Sheet1 and Inputs are worksheets, Report is a canvas page.
fn world() -> FormulaWorld {
    FormulaWorld {
        sheet_names: vec!["Sheet1".to_string(), "Inputs".to_string(), "Report".to_string()],
        sheet_ids: vec![sheet_id(), sheet_id(), sheet_id()],
        sheet_kinds: vec![
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::new_canvas(),
        ],
        sheet_visibility: vec!["visible".to_string(); 3],
        named_ranges: HashMap::new(),
        tables: HashMap::new(),
        table_names: HashMap::new(),
        locale: engine::LocaleSettings::invariant(),
    }
}

fn add_table(w: &mut FormulaWorld, name: &str, sheet: usize, columns: &[&str]) {
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let table = Table {
        id,
        name: name.to_string(),
        sheet_index: sheet,
        start_row: 0,
        start_col: 0,
        end_row: 5,
        end_col: columns.len() as u32 - 1,
        columns: columns
            .iter()
            .map(|c| TableColumn::new(identity::EntityId::from_bytes(identity::generate_uuid_v7()), c.to_string()))
            .collect(),
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };
    w.tables.entry(sheet).or_default().insert(id, table);
    w.table_names.insert(name.to_uppercase(), (sheet, id));
}

fn add_name(w: &mut FormulaWorld, name: &str, refers_to: &str) {
    w.named_ranges.insert(
        name.to_uppercase(),
        NamedRange {
            name: name.to_string(),
            sheet_index: None,
            refers_to: refers_to.to_string(),
            comment: None,
            folder: None,
        },
    );
}

fn models(list: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
    list.iter()
        .map(|(k, ms)| (k.to_string(), ms.iter().map(|m| m.to_string()).collect()))
        .collect()
}

fn norm(w: &FormulaWorld, host: usize, chart_sheet: Option<usize>, text: &str) -> Result<NormalizedFormula, String> {
    let none: Vec<(String, Vec<String>)> = Vec::new();
    let cx = w.context(host, chart_sheet, &none, None)?;
    normalize(text, &cx, None)
}

// ---------------------------------------------------------------------------
// Rule 2: qualification
// ---------------------------------------------------------------------------

#[test]
fn an_unqualified_ref_on_a_worksheet_object_reads_its_own_sheet() {
    let w = world();
    let n = norm(&w, INPUTS, None, "=B1*2").unwrap();
    assert_eq!(n.text, "=Inputs!B1*2");
    assert_eq!(n.analysis.sheets, vec![INPUTS]);
    assert_eq!(n.analysis.warning, None, "a worksheet object's own sheet is no fallback");
}

#[test]
fn an_unqualified_ref_on_a_canvas_chart_reads_the_charts_data_sheet() {
    let w = world();
    let n = norm(&w, REPORT, Some(INPUTS), "=A1").unwrap();
    assert_eq!(n.text, "=Inputs!A1", "the specReferenceSheet rule: the chart's data sheet");
    assert_eq!(n.analysis.warning, None);
}

#[test]
fn an_unqualified_ref_on_a_canvas_shape_reads_the_first_visible_worksheet_and_warns() {
    let mut w = world();
    let n = norm(&w, REPORT, None, "=A1").unwrap();
    assert_eq!(n.text, "=Sheet1!A1");
    let warning = n.analysis.warning.expect("a fallback is announced");
    assert!(warning.contains("Sheet1!A1") && warning.contains("canvas"), "{warning}");

    w.sheet_visibility[SHEET1] = "hidden".to_string();
    let n = norm(&w, REPORT, None, "=A1").unwrap();
    assert_eq!(n.text, "=Inputs!A1", "a hidden worksheet is skipped");

    let n = norm(&w, REPORT, None, "=Sheet1!A1").unwrap();
    assert_eq!(n.analysis.warning, None, "nothing was unqualified, so nothing to warn about");
}

#[test]
fn a_chart_data_sheet_is_read_from_the_spec_data_source() {
    let w = world();
    let by_name = r#"{"chartId":"c","sheetIndex":2,"spec":{"data":"inputs!A1:B5","layers":[{"data":"Sheet1!A1:A2"}]}}"#;
    assert_eq!(chart_data_sheet(by_name, &w.sheet_names, &w.sheet_ids), Some(INPUTS), "case-insensitive, spec.data only");
    let by_id = format!(
        r#"{{"spec":{{"data":{{"sheetId":"{}","sheetIndex":0,"startRow":0,"startCol":0,"endRow":4,"endCol":1}}}}}}"#,
        w.sheet_ids[INPUTS]
    );
    assert_eq!(chart_data_sheet(&by_id, &w.sheet_names, &w.sheet_ids), Some(INPUTS), "the sheetId wins over the index");
    let design_query = r#"{"spec":{"data":{"type":"designQuery","connectionId":"x"}}}"#;
    assert_eq!(chart_data_sheet(design_query, &w.sheet_names, &w.sheet_ids), None);
    let unqualified = r#"{"spec":{"data":"A1:B5"}}"#;
    assert_eq!(chart_data_sheet(unqualified, &w.sheet_names, &w.sheet_ids), None);
}

#[test]
fn a_lexer_upper_cased_sheet_name_is_canonicalised() {
    let w = world();
    // The lexer reads a bare `sheet1` as SHEET1; the workbook spells it Sheet1.
    let n = norm(&w, INPUTS, None, "=sheet1!a1").unwrap();
    assert_eq!(n.text, "=Sheet1!A1");
    let n = norm(&w, INPUTS, None, "=SUM(INPUTS!A1:A3)").unwrap();
    assert_eq!(n.text, "=SUM(Inputs!A1:A3)", "a range carries its sheet on the range node");
}

#[test]
fn unchanged_text_is_kept_verbatim() {
    let w = world();
    let n = norm(&w, INPUTS, None, "   =Inputs!B1 +  Inputs!B2   ").unwrap();
    assert_eq!(n.text, "=Inputs!B1 +  Inputs!B2", "trimmed, spacing kept: nothing needed re-rendering");
    // Non-vacuity: a formula that DID change is re-rendered (spacing normalised).
    let n = norm(&w, INPUTS, None, "=B1 +  Inputs!B2").unwrap();
    assert_eq!(n.text, "=Inputs!B1+Inputs!B2");
}

#[test]
fn an_unknown_sheet_and_malformed_text_are_refused() {
    let w = world();
    let err = norm(&w, INPUTS, None, "=Nowhere!A1").unwrap_err();
    assert_eq!(err, "There is no sheet named 'NOWHERE' in this workbook.");
    let err = norm(&w, INPUTS, None, "Inputs!A1").unwrap_err();
    assert!(err.contains("starts with '='"), "{err}");
    let err = norm(&w, INPUTS, None, "=SUM(").unwrap_err();
    assert!(err.starts_with("The formula could not be read"), "{err}");
    let long = format!("={}", "1+".repeat(MAX_BINDING_FORMULA_CHARS / 2) + "1");
    let err = norm(&w, INPUTS, None, &long).unwrap_err();
    assert!(err.contains("8192"), "{err}");
}

// ---------------------------------------------------------------------------
// Rule 4: measures
// ---------------------------------------------------------------------------

#[test]
fn a_measure_ref_with_one_model_binds_that_model_in_its_canonical_spelling() {
    let w = world();
    let m = models(&[("m1", &["Revenue", "Cost"])]);
    let cx = w.context(REPORT, None, &m, None).unwrap();
    let n = normalize("=[revenue]*2", &cx, None).unwrap();
    assert_eq!(n.text, "=[Revenue]*2");
    assert_eq!(n.analysis.measure_refs, vec!["Revenue".to_string()]);
    assert_eq!(n.analysis.model.as_deref(), Some("m1"));
    assert!(n.analysis.sheets.is_empty(), "a measure reads no sheet");
}

#[test]
fn two_models_refuse_and_list_both_unless_one_is_named() {
    let w = world();
    let m = models(&[("m1", &["Revenue"]), ("m2", &["Revenue", "Units"])]);
    let cx = w.context(REPORT, None, &m, None).unwrap();
    let err = normalize("=[Revenue]", &cx, None).unwrap_err();
    assert!(err.contains("2 models") && err.contains("m1") && err.contains("m2"), "{err}");

    let n = normalize("=[Units]", &cx, Some("m2")).unwrap();
    assert_eq!(n.analysis.model.as_deref(), Some("m2"));

    let cx = w.context(REPORT, None, &m, Some("m1")).unwrap();
    let n = normalize("=[Revenue]", &cx, None).unwrap();
    assert_eq!(n.analysis.model.as_deref(), Some("m1"), "the page's only model is the default");

    let err = normalize("=[Revenue]", &cx, Some("gone")).unwrap_err();
    assert!(err.contains("'gone' is not connected"), "{err}");
}

#[test]
fn an_unknown_measure_lists_the_models_measures() {
    let w = world();
    let m = models(&[("m1", &["Revenue", "Cost"])]);
    let cx = w.context(REPORT, None, &m, None).unwrap();
    let err = normalize("=[Profit]", &cx, None).unwrap_err();
    assert_eq!(err, "There is no measure [Profit] in model 'm1'. Its measures: Revenue, Cost.");

    let none: Vec<(String, Vec<String>)> = Vec::new();
    let cx = w.context(REPORT, None, &none, None).unwrap();
    let err = normalize("=[Revenue]", &cx, None).unwrap_err();
    assert!(err.contains("no data model is connected"), "{err}");
}

#[test]
fn a_measure_that_is_also_a_table_column_on_the_sheet_is_ambiguous() {
    let mut w = world();
    add_table(&mut w, "Sales", INPUTS, &["Region", "Revenue", "Amount"]);
    let m = models(&[("m1", &["Revenue"])]);

    let cx = w.context(INPUTS, None, &m, None).unwrap();
    let err = normalize("=[Revenue]", &cx, None).unwrap_err();
    assert!(err.contains("both") && err.contains("Sales[Revenue]") && err.contains("'m1'"), "{err}");

    // On another sheet the column is not in scope: the measure binds.
    let cx = w.context(REPORT, None, &m, None).unwrap();
    assert!(normalize("=[Revenue]", &cx, None).is_ok());

    // A table column that is no measure is pointed at its spelling.
    let err = normalize("=[Amount]", &cx, None).unwrap_err();
    assert_eq!(err, "Write Sales[Amount] for the table column; [Amount] in a bound property names a model measure.");
}

#[test]
fn a_this_row_ref_and_a_bare_special_specifier_are_refused() {
    let w = world();
    let m = models(&[("m1", &["Revenue"])]);
    let cx = w.context(REPORT, None, &m, None).unwrap();
    let err = normalize("=[@Revenue]", &cx, None).unwrap_err();
    assert!(err.contains("[@Revenue]") && err.contains("no row"), "{err}");
    let err = normalize("=[#All]", &cx, None).unwrap_err();
    assert!(err.contains("must name its table"), "{err}");
}

#[test]
fn a_measure_name_with_punctuation_and_spaces_parses() {
    let w = world();
    let m = models(&[("m1", &["% Revenue of Total"])]);
    let cx = w.context(REPORT, None, &m, None).unwrap();
    let n = normalize("=[% Revenue of Total]", &cx, None).unwrap();
    assert_eq!(n.analysis.measure_refs, vec!["% Revenue of Total".to_string()]);
    assert_eq!(n.text, "=[% Revenue of Total]");
}

#[test]
fn a_stored_row_is_prepared_without_measure_metadata() {
    let w = world();
    let none: Vec<(String, Vec<String>)> = Vec::new();
    let cx = w.context(REPORT, None, &none, None).unwrap();
    // Validated at Set; the model metadata is async (S4), so preparing only collects.
    let n = prepare_stored("=[Revenue]+Sheet1!A1", &cx, Some("m1")).unwrap();
    assert_eq!(n.analysis.measure_refs, vec!["Revenue".to_string()]);
    assert_eq!(n.analysis.model.as_deref(), Some("m1"));
    // Non-vacuity: the same text is REFUSED when it is being entered.
    assert!(normalize("=[Revenue]+Sheet1!A1", &cx, Some("m1")).is_err());
}

// ---------------------------------------------------------------------------
// Rule 5: CUBE
// ---------------------------------------------------------------------------

#[test]
fn a_cube_function_with_a_cell_argument_is_refused_and_a_literal_one_is_accepted() {
    let w = world();
    let err = norm(&w, INPUTS, None, r#"=CUBEVALUE("Model", Inputs!A1)"#).unwrap_err();
    assert_eq!(err, "A CUBE function in a bound property takes text arguments; use [Measure] instead.");
    let err = norm(&w, INPUTS, None, r#"=CUBEVALUE("Model", CUBEMEMBER("Model", B1))"#).unwrap_err();
    assert!(err.contains("text arguments"), "a nested reference is still a reference: {err}");
    let n = norm(&w, INPUTS, None, r#"=CUBEVALUE("Model", "[Measures].[Revenue]", "[Date].[Year].&[" & "2024]")"#).unwrap();
    assert!(n.analysis.uses_cube);
    assert!(n.analysis.sheets.is_empty());
}

// ---------------------------------------------------------------------------
// Rule 6: analysis
// ---------------------------------------------------------------------------

#[test]
fn the_analysis_flags_say_what_the_formula_reads() {
    let mut w = world();
    add_name(&mut w, "Rate", "=Inputs!$B$1");
    add_table(&mut w, "Sales", INPUTS, &["Amount"]);

    let n = norm(&w, INPUTS, None, "=SUM(Inputs!A1:A3)*Rate").unwrap();
    assert_eq!(n.analysis.sheets, vec![INPUTS]);
    assert!(n.analysis.uses_names);
    assert!(!n.analysis.uses_indirect && !n.analysis.uses_table_refs && !n.analysis.uses_cube);
    assert_eq!(n.text, "=SUM(Inputs!A1:A3)*Rate", "the name keeps the Name Manager's casing");

    let n = norm(&w, INPUTS, None, "=SUM(Sales[Amount])").unwrap();
    assert!(n.analysis.uses_table_refs && !n.analysis.uses_names);

    for indirect in [r#"=INDIRECT("A1")"#, r#"=GET.CONTROLVALUE("Region")"#, r#"=OFFSET(INDIRECT("A1"),1,1)"#] {
        let n = norm(&w, INPUTS, None, indirect).unwrap();
        assert!(n.analysis.uses_indirect, "{indirect}");
    }
    let n = norm(&w, INPUTS, None, "=OFFSET(A1,1,1)").unwrap();
    assert!(!n.analysis.uses_indirect, "OFFSET over a written reference is not indirect");

    let n = norm(&w, INPUTS, None, "=SUM(Sheet1:Inputs!A1)").unwrap();
    assert_eq!(n.analysis.sheets, vec![SHEET1, INPUTS], "a 3-D reference reads every sheet it spans");

    // The all-sheets wildcard names no sheet, but reads every one of them: the
    // restricted clamp decides from `sheets`, so an empty list here would let a
    // restricted script read every sheet (WP-D verifier finding).
    for wildcard in ["='*'!A1", "=SUM('*'!A1:B2)", r#"=TEXTJOIN(",",TRUE,'*'!A1:C3)"#] {
        let n = norm(&w, INPUTS, None, wildcard).unwrap();
        assert_eq!(n.analysis.sheets, vec![SHEET1, INPUTS, REPORT], "{wildcard} reads every sheet");
    }

    // A JS UDF call is not a defined name; an undefined name in value position is.
    let n = norm(&w, INPUTS, None, "=MYUDF(1)").unwrap();
    assert!(!n.analysis.uses_names);
    let n = norm(&w, INPUTS, None, "=Undefined*2").unwrap();
    assert!(n.analysis.uses_names, "a #NAME? waiting for its definition still reads a name");
}

// ---------------------------------------------------------------------------
// Rule 0: locale
// ---------------------------------------------------------------------------

#[test]
fn sv_se_formula_is_stored_invariant() {
    let mut w = world();
    w.sheet_names[INPUTS] = "Inputs".to_string();
    w.locale = engine::LocaleSettings::from_locale_id("sv-SE");
    assert_eq!(w.locale.list_separator, ';', "precondition: sv-SE separates arguments with ';'");
    let m = models(&[("m1", &["Revenue"])]);
    let cx = w.context(REPORT, None, &m, None).unwrap();

    let typed = r##"=Inputs!B1&TEXT([Revenue];"#,##0")"##;
    let n = normalize_entered(typed, false, &cx, None).unwrap();
    assert_eq!(n.text, r##"=Inputs!B1&TEXT([Revenue],"#,##0")"##, "stored with the invariant ','");
    assert_eq!(n.analysis.display_normalized, typed, "shown back in the person's locale");
    assert_eq!(display_formula(&n.text, &w.locale), typed);
}

#[test]
fn invariant_flag_skips_delocalisation() {
    let mut w = world();
    w.locale = engine::LocaleSettings::from_locale_id("sv-SE");
    let none: Vec<(String, Vec<String>)> = Vec::new();
    let cx = w.context(INPUTS, None, &none, None).unwrap();

    let n = normalize_entered("=ROUND(A1,1)", true, &cx, None).unwrap();
    assert_eq!(n.text, "=ROUND(Inputs!A1,1)", "a script's invariant text is taken as is");
    assert_eq!(n.analysis.display_normalized, "=ROUND(Inputs!A1;1)");

    // Non-vacuity: the same text read as sv-SE input means something else
    // (',' is the decimal separator there), so the flag decides the outcome.
    let as_person = normalize_entered("=ROUND(A1,1)", false, &cx, None);
    assert_ne!(as_person.map(|n| n.text).ok(), Some("=ROUND(Inputs!A1,1)".to_string()));
}
