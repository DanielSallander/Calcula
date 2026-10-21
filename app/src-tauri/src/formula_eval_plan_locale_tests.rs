//! FILENAME: app/src-tauri/src/formula_eval_plan_locale_tests.rs
// PURPOSE: P2 S5 / DC5 -- Evaluate Formula localises the evaluated VALUE of a
//          step (node values, step descriptions, the final result) in the app
//          locale, while the formula TEXT and its literals stay invariant (a
//          localised literal beside the invariant separator would read
//          `SUM(1,5,2)`, and the underline spans index the invariant text).
// CONTEXT: A child module of `formula_eval_plan` (declared with `#[path]`
//          there), so it reaches the private `build_eval_plan`.

use super::*;

fn plan_for(formula: &str, locale: &engine::LocaleSettings) -> FormulaEvalPlan {
    let parsed = parse_formula(formula).expect("the formula parses");
    let ast = convert_expr(&parsed);
    let grids = vec![engine::Grid::new()];
    let sheet_names = vec!["Sheet1".to_string()];
    build_eval_plan(&ast, &grids, &sheet_names, 0, locale)
}

#[test]
fn a_german_step_result_reads_with_a_decimal_comma_while_the_formula_text_stays_invariant() {
    let de = engine::LocaleSettings::from_locale_id("de-DE");
    let plan = plan_for("=1234.5*1", &de);

    assert_eq!(plan.result, "1234,5", "the evaluated value is in the app locale");
    let step = plan.steps.last().expect("one reduction step");
    assert!(step.description.ends_with("= 1234,5"), "{}", step.description);
    assert!(plan.formula.contains("1234.5"), "formula text stays invariant: {}", plan.formula);
    assert!(step.formula_before.contains("1234.5"), "{}", step.formula_before);
    assert!(step.formula_after.contains("1234.5"), "the substituted literal stays invariant: {}", step.formula_after);
    assert!(!step.formula_after.contains("1234,5"), "{}", step.formula_after);
}

#[test]
fn the_invariant_locale_keeps_todays_step_values_byte_for_byte() {
    let inv = engine::LocaleSettings::invariant();
    let plan = plan_for("=1234.5*1", &inv);
    assert_eq!(plan.result, "1234.5");
    let text = plan_for("=\"a\"&\"b\"", &inv);
    assert_eq!(text.result, "\"ab\"");
    let de = engine::LocaleSettings::from_locale_id("de-DE");
    assert_eq!(plan_for("=\"1.5\"&\"x\"", &de).result, "\"1.5x\"", "text is never localised");
    assert_eq!(plan_for("=1=1", &de).result, "TRUE");
    assert_eq!(plan_for("=6*7", &de).result, "42");
}

#[test]
fn value_to_display_localized_only_touches_numbers() {
    let sv = engine::LocaleSettings::from_locale_id("sv-SE");
    assert_eq!(value_to_display_localized(&Value::Number(0.25), &sv), "0,25");
    assert_eq!(value_to_display_localized(&Value::Number(-3.0), &sv), "-3");
    assert_eq!(value_to_display_localized(&Value::String("1.5".into()), &sv), "\"1.5\"");
    assert_eq!(value_to_display_localized(&Value::Error("#DIV/0!".into()), &sv), "#DIV/0!");
    assert_eq!(value_to_display(&Value::Number(0.25)), "0.25", "the formula-text renderer stays invariant");
}
