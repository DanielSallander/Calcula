//! FILENAME: app/src-tauri/src/scripting/control_action_tests.rs
//! PURPOSE: The one button rule in Rust (M6, phase 4 of BUG-0257): the pure
//! planners, ported case for case from the TypeScript suites they replace
//! (`_shared/lib/__tests__/buttonScriptRun.test.ts`,
//! `Controls/__tests__/buttonScriptRun.test.ts`), plus what only held code
//! needs: a held `Name()` never reaches the user's modules, and held bytes are
//! never composed.
//! CONTEXT: The identifier helpers are pinned against a fixture the vitest
//! drift test reads too (`fixtures/button_names.json`), so the Rust port and the
//! TypeScript copies cannot drift apart unnoticed.

use super::*;

const ESCAPING_BODY: &str = "} __payload(); function __pad() {";

fn local(name: &str, source: &str) -> ModuleView {
    ModuleView {
        id: format!("local-{name}"),
        name: name.to_string(),
        source: source.to_string(),
        source_package: None,
        description: None,
    }
}

fn from_app(name: &str, source: &str, app: &str) -> ModuleView {
    ModuleView {
        id: format!("pkg-{name}"),
        name: name.to_string(),
        source: source.to_string(),
        source_package: Some(app.to_string()),
        description: None,
    }
}

fn package(name: &str, source: &str) -> ModuleView {
    from_app(name, source, "SalesApp")
}

fn recorded(mut module: ModuleView) -> ModuleView {
    module.description = Some("Recorded macro \u{b7} runtime=objectScript \u{b7} 2 actions".to_string());
    module
}

/// (source, filename, module id, unavailable) of a run plan; panics on a refusal.
fn run(plan: Plan) -> (String, String, Option<String>, Vec<UnavailableModule>) {
    match plan {
        Plan::Run { source, filename, module, unavailable } => (source, filename, module.map(|m| m.id), unavailable),
        Plan::Refuse { message, .. } => panic!("expected a run plan, got a refusal: {message}"),
    }
}

fn refusal(plan: Plan) -> (PlanRefusal, String) {
    match plan {
        Plan::Refuse { reason, message, .. } => (reason, message),
        Plan::Run { source, .. } => panic!("expected a refusal, got a run of {source:?}"),
    }
}

fn cell_script(plan: CellPlan) -> Plan {
    match plan {
        CellPlan::Script(plan) => plan,
        other => panic!("expected a script plan, got {other:?}"),
    }
}

// ============================================================================
// The shared fixture
// ============================================================================

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/button_names.json")).expect("the fixture is JSON")
}

/// SABOTAGE (b): sanitize char-wise (`name.chars()`) -- the emoji row writes
/// one underscore where the Properties pane writes two.
#[test]
fn sanitize_matches_the_shared_fixture_per_utf16_unit() {
    let rows = fixture()["sanitize"].as_array().unwrap().clone();
    assert!(rows.len() >= 6);
    for row in rows {
        let name = row["name"].as_str().unwrap();
        assert_eq!(sanitize_script_name(name), row["expected"].as_str().unwrap(), "sanitize({name:?})");
    }
}

#[test]
fn the_call_name_matches_the_shared_fixture_with_explicit_whitespace() {
    for row in fixture()["callName"].as_array().unwrap() {
        let code = row["code"].as_str().unwrap();
        assert_eq!(single_module_call_name(code).as_deref(), row["expected"].as_str(), "callName({code:?})");
    }
}

#[test]
fn the_runtime_marker_matches_the_shared_fixture() {
    for row in fixture()["runtime"].as_array().unwrap() {
        let description = row["description"].as_str();
        let expected = match row["expected"].as_str() {
            Some("objectScript") => Some(ModuleRuntime::ObjectScript),
            Some("notebook") => Some(ModuleRuntime::Notebook),
            None => None,
            Some(other) => panic!("unknown runtime {other}"),
        };
        assert_eq!(parse_module_runtime(description), expected, "runtime({description:?})");
    }
}

#[test]
fn the_button_action_id_is_the_prefix_and_the_sha256_of_the_exact_bytes() {
    let code = "Calcula.setCellValue(0, 0, 'h\u{e9}');";
    let id = button_action_consent_id(code);
    assert!(id.starts_with("buttonAction:"));
    assert_eq!(&id["buttonAction:".len()..], calp::integrity::sha256_hex(code.as_bytes()));
    assert_ne!(button_action_consent_id("Report()"), button_action_consent_id("Report() "), "one byte is a new id");
}

// ============================================================================
// A module body that escapes its wrapper (ported)
// ============================================================================

#[test]
fn an_escaping_body_of_the_users_own_is_their_own_code_and_runs() {
    let (source, ..) = run(plan_own_inline("Good();", &[local("Good", "Calcula.log('ok');"), local("Evil", ESCAPING_BODY)]));
    assert!(source.contains("__payload"));
    assert!(source.contains("function Good() {"));
}

#[test]
fn every_other_button_keeps_working_when_one_module_is_unusable() {
    let (source, ..) = run(plan_own_inline("Good();", &[local("Evil", ESCAPING_BODY), local("Good", "Calcula.log('ok');")]));
    assert!(source.contains("function Good() {"));
}

// ============================================================================
// A distributed module is never spliced into a button's program (ported)
// ============================================================================

/// SABOTAGE (c): make `plan_own_inline` wrap application modules too (filter
/// `wrapped` from `modules`, not `local`) -- the publisher's payload lands in
/// the user's program.
#[test]
fn a_distributed_module_is_absent_from_the_preamble() {
    let (source, _, _, unavailable) =
        run(plan_own_inline("Helper();", &[local("Helper", "Calcula.log('mine');"), package("Report", "__publisherPayload();")]));
    assert!(source.contains("function Helper() {"));
    assert!(!source.contains("function Report() {"));
    assert!(!source.contains("__publisherPayload"));
    assert!(unavailable.is_empty(), "a button that never mentioned it is not nagged");
}

#[test]
fn a_distributed_module_is_absent_even_when_its_name_would_shadow_the_users() {
    let (source, _, module, unavailable) =
        run(plan_own_inline("Helper();", &[local("Helper", "Calcula.log('mine');"), package("Helper", "__publisherPayload();")]));
    assert_eq!(source, "function Helper() {\nCalcula.log('mine');\n}\nHelper();");
    assert_eq!(module, None);
    assert!(unavailable.is_empty());
}

#[test]
fn a_named_distributed_module_is_reported_not_silently_dropped() {
    let (source, _, _, unavailable) = run(plan_own_inline(
        "Report(); Helper();",
        &[local("Helper", "Calcula.log('mine');"), package("Report", "__publisherPayload();")],
    ));
    assert!(!source.contains("__publisherPayload"));
    let notice = unavailable.iter().find(|u| u.name == "Report").expect("a notice");
    assert_eq!(notice.reason, "distributed");
    assert!(notice.message.contains("SalesApp"));
    assert!(notice.message.contains("\"Report()\""));
}

#[test]
fn a_bare_call_of_one_application_module_runs_its_stored_source_verbatim() {
    let target = package("Report", "__publisherPayload();");
    let (source, filename, module, _) = run(plan_own_inline(" Report() ; ", &[target.clone()]));
    assert_eq!(source, "__publisherPayload();");
    assert_eq!(module.as_deref(), Some(target.id.as_str()));
    assert_eq!(filename, format!("button_module_{}.js", target.id));
}

#[test]
fn only_a_bare_zero_argument_call_is_an_invocation() {
    assert_eq!(single_module_call_name("Report()").as_deref(), Some("Report"));
    assert_eq!(single_module_call_name("Report();").as_deref(), Some("Report"));
    assert_eq!(single_module_call_name("  Report ( ) ; ").as_deref(), Some("Report"));
    for not_a_call in ["Report(1)", "Report(); evil();", "if (x) Report();", "a.Report()"] {
        assert_eq!(single_module_call_name(not_a_call), None, "{not_a_call}");
    }
}

#[test]
fn code_that_merely_ends_in_a_call_does_not_delegate() {
    let (source, _, module, _) = run(plan_own_inline("Calcula.log('x'); Report();", &[package("Report", "__publisherPayload();")]));
    assert_eq!(module, None);
    assert_eq!(source, "Calcula.log('x'); Report();");
}

// ============================================================================
// A local module that shadows a distributed one (ported)
// ============================================================================

#[test]
fn a_local_namesake_runs_and_nothing_is_reported_for_exactly_name() {
    let (source, _, module, unavailable) =
        run(plan_own_inline("Report()", &[local("Report", "Calcula.log('mine');"), package("Report", "__publisherPayload();")]));
    assert_eq!(source, "function Report() {\nCalcula.log('mine');\n}\nReport()");
    assert_eq!(module, None);
    assert!(unavailable.is_empty());
}

#[test]
fn composed_code_naming_a_shadowed_module_reports_nothing() {
    let (source, _, _, unavailable) = run(plan_own_inline(
        "if (ready) Report(); Helper();",
        &[local("Report", "Calcula.log('mine');"), local("Helper", "Calcula.log('helper');"), package("Report", "__publisherPayload();")],
    ));
    assert!(source.contains("function Report() {"));
    assert!(!source.contains("__publisherPayload"));
    assert!(unavailable.is_empty());
}

#[test]
fn a_distributed_module_no_local_answers_to_is_still_reported() {
    let (_, _, _, unavailable) = run(plan_own_inline(
        "Report(); Other();",
        &[local("Report", "Calcula.log('mine');"), package("Report", "__publisherPayload();"), from_app("Other", "__otherPayload();", "FinanceApp")],
    ));
    assert_eq!(unavailable.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), vec!["Other"]);
    assert!(unavailable[0].message.contains("FinanceApp"));
}

#[test]
fn an_empty_local_module_does_not_shadow() {
    let theirs = package("Report", "__publisherPayload();");
    let empty = local("Report", "   ");
    let (source, _, module, _) = run(plan_own_inline("Report();", &[empty.clone(), theirs.clone()]));
    assert_eq!(module.as_deref(), Some(theirs.id.as_str()), "an empty local must not stand in for the module");
    assert_eq!(source, "__publisherPayload();");
    let (_, _, _, unavailable) = run(plan_own_inline("Calcula.log(1); Report();", &[empty, theirs]));
    assert_eq!(unavailable.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), vec!["Report"]);
}

#[test]
fn a_local_module_wins_even_over_several_distributed_namesakes() {
    let mut finance = from_app("Report", "__financePayload();", "FinanceApp");
    finance.id = "pkg-Report-2".to_string();
    let (source, _, _, unavailable) = run(plan_own_inline(
        "Report();",
        &[local("Report", "Calcula.log('mine');"), from_app("Report", "__salesPayload();", "SalesApp"), finance],
    ));
    assert_eq!(source, "function Report() {\nCalcula.log('mine');\n}\nReport();");
    assert!(unavailable.is_empty());
}

// ============================================================================
// A Name() two applications answer to is refused (ported)
// ============================================================================

fn sales() -> ModuleView {
    from_app("Report", "__salesPayload();", "SalesApp")
}

fn finance() -> ModuleView {
    let mut m = from_app("Report", "__financePayload();", "FinanceApp");
    m.id = "pkg-Report-finance".to_string();
    m
}

#[test]
fn an_ambiguous_call_is_refused_naming_each_application() {
    let (reason, message) = refusal(plan_own_inline("Report()", &[sales(), finance()]));
    assert_eq!(reason, PlanRefusal::Ambiguous);
    assert!(message.contains("Report()"));
    assert!(message.contains("\"Report\" from the application \"SalesApp\""));
    assert!(message.contains("\"Report\" from the application \"FinanceApp\""));
    assert!(message.contains("will not run"));
    assert!(message.contains("Bind the button") && message.contains("rename"));
}

#[test]
fn an_ambiguous_call_is_refused_identically_in_either_order() {
    let (_, a) = refusal(plan_own_inline("Report();", &[sales(), finance()]));
    let (_, b) = refusal(plan_own_inline("Report();", &[finance(), sales()]));
    assert_eq!(a, b);
}

#[test]
fn two_modules_of_one_application_that_sanitize_alike_are_ambiguous() {
    let (_, message) = refusal(plan_own_inline(
        "My_Report()",
        &[from_app("My Report", "__a();", "SalesApp"), ModuleView { id: "pkg-My_Report-2".into(), ..from_app("My_Report", "__b();", "SalesApp") }],
    ));
    assert!(message.contains("\"My Report\" from the application \"SalesApp\""));
    assert!(message.contains("\"My_Report\" from the application \"SalesApp\""));
}

#[test]
fn composed_code_naming_a_tie_gets_one_notice_whose_remedy_works() {
    let mut other = from_app("Report", "b();", "FinancePack");
    other.id = "pkg-Report-2".to_string();
    let (_, _, _, unavailable) = run(plan_own_inline("Calcula.log(1); Report();", &[from_app("Report", "a();", "SalesApp"), other]));
    let notices: Vec<&UnavailableModule> = unavailable.iter().filter(|u| u.name == "Report").collect();
    assert_eq!(notices.len(), 1);
    assert!(notices[0].message.contains("\"SalesApp\"") && notices[0].message.contains("\"FinancePack\""));
    assert!(!notices[0].message.contains("set the button's action to exactly"));
    assert!(notices[0].message.contains("Bind the button to one module directly"));
}

#[test]
fn the_one_module_that_answers_still_runs_when_there_is_no_tie() {
    let (source, _, module, _) = run(plan_own_inline("Report()", &[sales()]));
    assert_eq!(source, "__salesPayload();");
    assert_eq!(module.as_deref(), Some(sales().id.as_str()));
}

// ============================================================================
// The user's own code is unchanged (ported)
// ============================================================================

#[test]
fn a_users_button_calling_a_users_module_produces_the_program_it_always_did() {
    let (source, filename, _, _) = run(plan_own_inline("MyMacro();", &[local("My Macro", "Calcula.log(1);")]));
    assert_eq!(source, "function My_Macro() {\nCalcula.log(1);\n}\nMyMacro();");
    assert_eq!(filename, "button_onSelect.js");
    assert_eq!(sanitize_script_name("My Macro"), "My_Macro");
    assert_eq!(sanitize_script_name("2nd pass"), "_2nd_pass");
    assert_eq!(sanitize_script_name("!!!"), "___");
}

#[test]
fn an_own_duplicate_name_has_one_fixed_winner() {
    let mut first = local("Tools", "Calcula.log('first');");
    first.id = "a-tools".to_string();
    let mut second = local("Tools", "Calcula.log('second');");
    second.id = "b-tools".to_string();
    let mut store = std::collections::HashMap::new();
    for m in [&second, &first] {
        store.insert(
            m.id.clone(),
            crate::scripting::types::WorkbookScript {
                id: m.id.clone(),
                name: m.name.clone(),
                description: None,
                source: m.source.clone(),
                scope: crate::scripting::types::ScriptScope::Workbook,
                source_package: None,
            },
        );
    }
    let views = module_views(&store);
    assert_eq!(views.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["a-tools", "b-tools"], "sorted by (name, id)");
    let (source, ..) = run(plan_own_inline("Tools();", &views));
    // The LATER declaration wins in JavaScript, and the later one is fixed.
    assert!(source.find("'first'").unwrap() < source.find("'second'").unwrap(), "{source}");
}

#[test]
fn reserved_internal_records_are_never_seen_by_a_planner() {
    let mut store = std::collections::HashMap::new();
    store.insert(
        "__calcula_custom_functions__".to_string(),
        crate::scripting::types::WorkbookScript {
            id: "__calcula_custom_functions__".to_string(),
            name: "CustomFunctions".to_string(),
            description: None,
            source: "{\"functions\":[]}".to_string(),
            scope: crate::scripting::types::ScriptScope::Workbook,
            source_package: None,
        },
    );
    assert!(module_views(&store).is_empty());
}

// ============================================================================
// Held code (new in M6)
// ============================================================================

/// THE CONFUSED DEPUTY BY NAME. The user owns `Report`, and the held code is
/// `Report()`: the user's module must never run as the application's approved
/// button code. The application's own `Report` runs, verbatim; with none, the
/// held bytes run as themselves.
///
/// SABOTAGE (a): let `plan_held_inline` consult local modules.
#[test]
fn a_held_name_never_resolves_to_a_local_module() {
    let mine = local("Report", "Calcula.log('MINE');");
    let theirs = from_app("Report", "Calcula.log('theirs');", "sales");
    let (source, _, module, _) = run(plan_held_inline("Report()", "sales", &[mine.clone(), theirs.clone()]));
    assert_eq!(source, "Calcula.log('theirs');");
    assert_eq!(module.as_deref(), Some(theirs.id.as_str()));

    let (source, filename, module, _) = run(plan_held_inline("Report()", "sales", &[mine]));
    assert_eq!(source, "Report()", "no preamble: the user's module is not defined for held code");
    assert_eq!(filename, "button_onSelect.js");
    assert_eq!(module, None);
}

#[test]
fn a_held_name_never_resolves_to_another_applications_module() {
    let hr = from_app("Report", "Calcula.log('hr');", "hr");
    let (source, _, module, _) = run(plan_held_inline("Report()", "sales", &[hr]));
    assert_eq!(source, "Report()");
    assert_eq!(module, None);
    // Two of the application's own that answer: refused, not guessed.
    let mut again = from_app("Report", "Calcula.log('two');", "sales");
    again.id = "pkg-Report-2".to_string();
    let (reason, _) = refusal(plan_held_inline("Report()", "sales", &[from_app("Report", "x()", "sales"), again]));
    assert_eq!(reason, PlanRefusal::Ambiguous);
}

/// SABOTAGE (b of S4): prepend the local preamble to held code.
#[test]
fn held_code_is_never_composed() {
    let modules = vec![local("Helper", "Calcula.log('mine');"), from_app("Report", "r();", "sales")];
    for code in ["Calcula.setCellValue(0, 0, 1); Helper();", "  weird \u{2028} bytes \u{feff}", "Report(1)"] {
        let (source, ..) = run(plan_held_inline(code, "sales", &modules));
        assert_eq!(source.as_bytes(), code.as_bytes(), "held code must run byte for byte");
    }
}

// ============================================================================
// Button cells (ported planStoredModuleRun + the command split)
// ============================================================================

#[test]
fn a_bound_module_runs_unchanged_when_no_function_is_named() {
    let module = package("Report", "__publisherPayload();");
    let plan = cell_script(plan_cell_action(&serde_json::json!({"kind":"script","scriptId": module.id}), None, &[module.clone()]));
    let (source, filename, id, _) = run(plan);
    assert_eq!(source, "__publisherPayload();");
    assert_eq!(filename, "button_Report.js");
    assert_eq!(id.as_deref(), Some(module.id.as_str()));
}

#[test]
fn the_call_is_appended_for_the_users_own_module_only() {
    let mine = local("Mine", "function Go() { x(); }");
    let (source, _, module, _) = run(cell_script(plan_cell_action(
        &serde_json::json!({"kind":"script","scriptId": mine.id, "functionName": " Go "}),
        None,
        &[mine],
    )));
    assert_eq!(source, "function Go() { x(); }\nGo();");
    assert_eq!(module, None, "a composition is no longer one stored module");
}

#[test]
fn the_cell_composition_is_refused_for_a_distributed_module_and_for_a_non_identifier() {
    let theirs = package("Report", "function Go() {}");
    let (reason, message) = refusal(cell_script(plan_cell_action(
        &serde_json::json!({"kind":"script","scriptId": theirs.id, "functionName": "Go"}),
        None,
        &[theirs],
    )));
    assert_eq!(reason, PlanRefusal::ComposesApplicationCode);
    assert!(message.contains("SalesApp") && message.contains("Go()"));

    let mine = local("Mine", "var a = 1;");
    let (reason, message) = refusal(cell_script(plan_cell_action(
        &serde_json::json!({"kind":"script","scriptId": mine.id, "functionName": "Go(); __publisherPayload()"}),
        None,
        &[mine],
    )));
    assert_eq!(reason, PlanRefusal::NotAFunctionName);
    assert!(message.contains("is not a function name"));
}

#[test]
fn a_stamped_cell_runs_only_its_applications_module() {
    let mine = local("Quarterly Reports", "Exfiltrate();");
    let (reason, message) = refusal(cell_script(plan_cell_action(
        &serde_json::json!({"kind":"script","scriptId": mine.id}),
        Some("sales"),
        &[mine],
    )));
    assert_eq!(reason, PlanRefusal::MacroNotFromApplication);
    assert!(message.contains("\"Quarterly Reports\"") && message.contains("is one of your own"), "{message}");
    assert!(message.starts_with(&describe_macro_not_from_application("sales", "Quarterly Reports", None)));

    let hr = from_app("Payroll", "x();", "hr");
    let (_, message) =
        refusal(cell_script(plan_cell_action(&serde_json::json!({"kind":"script","scriptId": hr.id}), Some("sales"), &[hr])));
    assert!(message.contains("came with a different application, \"hr\""), "{message}");

    let ours = from_app("Report", "ok();", "sales");
    let (source, ..) =
        run(cell_script(plan_cell_action(&serde_json::json!({"kind":"script","scriptId": ours.id}), Some("sales"), &[ours])));
    assert_eq!(source, "ok();");
}

/// The TypeScript sentence the macro-run seam still uses, byte for byte.
#[test]
fn the_not_from_application_sentence_is_the_typescript_one() {
    assert_eq!(
        describe_macro_not_from_application("sales", "Report", None),
        "This button came with the application \"sales\", and the macro \"Report\" it names is one of your own. \
         A button from an application runs only that application's own macros, so it did not run."
    );
    assert_eq!(
        describe_macro_not_from_application("sales", "Report", Some("hr")),
        "This button came with the application \"sales\", and the macro \"Report\" it names came with a \
         different application, \"hr\". A button from an application runs only that application's own macros, \
         so it did not run."
    );
}

/// The user's own command is the page's to run; an application's goes to the
/// command gate (plan_M8 S1), which alone knows the list and the approvals --
/// the planner never answers it as the user's own.
///
/// SABOTAGE: plan a stamped command as `CellPlan::Command` -> red.
#[test]
fn a_command_runs_for_the_users_own_button_and_goes_to_the_gate_for_an_applications() {
    let action = serde_json::json!({"kind":"command","commandId":"format.bold"});
    assert_eq!(plan_cell_action(&action, None, &[]), CellPlan::Command { command_id: "format.bold".into() });
    assert_eq!(
        plan_cell_action(&action, Some("sales"), &[]),
        CellPlan::ApplicationCommand { command_id: "format.bold".into() }
    );
}

#[test]
fn a_cell_with_nothing_it_can_run_says_so() {
    assert!(matches!(plan_cell_action(&serde_json::json!({}), None, &[]), CellPlan::Nothing { .. }));
    let CellPlan::Nothing { message } = plan_cell_action(&serde_json::json!({"kind":"script"}), Some("sales"), &[]) else {
        panic!("nothing to run");
    };
    assert!(message.contains("'sales'"));
    let (reason, _) =
        refusal(cell_script(plan_cell_action(&serde_json::json!({"kind":"script","scriptId":"gone"}), None, &[])));
    assert_eq!(reason, PlanRefusal::ModuleNotFound);
}

// ============================================================================
// Modules that run only as object scripts (owner decision Q1)
// ============================================================================

#[test]
fn an_object_script_runtime_module_is_refused_by_name_never_handed_to_the_interpreter() {
    let theirs = recorded(from_app("Report", "function setup(context) {}", "sales"));
    // A held Name().
    let (reason, message) = refusal(plan_held_inline("Report()", "sales", &[theirs.clone()]));
    assert_eq!(reason, PlanRefusal::ObjectScriptMacro);
    assert!(message.starts_with("Report runs as an object script") && message.contains("Properties > Macro"), "{message}");
    // An own Name() that delegates to it.
    let (reason, _) = refusal(plan_own_inline("Report()", &[theirs.clone()]));
    assert_eq!(reason, PlanRefusal::ObjectScriptMacro);
    // An own Name() of the user's own recorded macro.
    let mine = recorded(local("Mine", "function setup(context) {}"));
    let (reason, _) = refusal(plan_own_inline("Mine()", &[mine.clone()]));
    assert_eq!(reason, PlanRefusal::ObjectScriptMacro);
    // ...which composed code does not wrap, and names instead.
    let (source, _, _, unavailable) = run(plan_own_inline("if (x) Mine();", &[mine.clone(), local("Helper", "h();")]));
    assert!(!source.contains("function Mine()"), "{source}");
    assert!(source.contains("function Helper()"));
    assert_eq!(unavailable.len(), 1);
    assert_eq!(unavailable[0].reason, "objectScript");
    // An unrelated own button in a workbook that holds a recorded macro is
    // unaffected.
    let (source, ..) = run(plan_own_inline("Calcula.log(1);", &[mine]));
    assert_eq!(source, "Calcula.log(1);");
}

/// Owner decision B, follow-up F6: a button CELL whose action names a macro
/// that runs only as an object script is no longer refused -- it is handed to
/// the page's macro seam as a WHOLE macro (this door's interpreter has no
/// `api`, so handing it the source would define `setup` and run nothing).
/// SABOTAGE: return the old `ObjectScriptMacro` refusal for every cell action in
/// `plan_cell_action` -> the first assertion goes red.
#[test]
fn a_cell_action_naming_an_object_script_macro_is_the_macro_seams_to_run_whole() {
    let theirs = recorded(from_app("Report", "function setup(context) {}", "sales"));
    // The application's own button cell: the seam's, never the interpreter's.
    assert_eq!(
        plan_cell_action(&serde_json::json!({"kind":"script","scriptId": theirs.id}), Some("sales"), &[theirs.clone()]),
        CellPlan::ObjectScriptMacro { macro_id: theirs.id.clone() },
    );
    // The user's own button cell, naming the user's own recorded macro -- and
    // naming the application's: the seam asks that one's approval.
    let mine = recorded(local("Mine", "function setup(context) {}"));
    assert_eq!(
        plan_cell_action(&serde_json::json!({"kind":"script","scriptId": mine.id}), None, &[mine.clone()]),
        CellPlan::ObjectScriptMacro { macro_id: mine.id.clone() },
    );
    assert_eq!(
        plan_cell_action(&serde_json::json!({"kind":"script","scriptId": theirs.id}), None, &[theirs.clone()]),
        CellPlan::ObjectScriptMacro { macro_id: theirs.id.clone() },
    );
    // A "Function to call" inside one: there is no program to append it to.
    let (reason, message) = refusal(cell_script(plan_cell_action(
        &serde_json::json!({"kind":"script","scriptId": mine.id, "functionName": "Go"}),
        None,
        &[mine.clone()],
    )));
    assert_eq!(reason, PlanRefusal::ObjectScriptMacro);
    assert!(message.contains("runs it as a whole macro") && message.contains("\"Go\""), "{message}");
    // The stamp is still checked FIRST: an application's button cell naming
    // another application's recorded macro is refused, never handed on.
    let hrs = recorded(from_app("Payroll", "function setup(context) {}", "hr"));
    let (reason, _) = refusal(cell_script(plan_cell_action(
        &serde_json::json!({"kind":"script","scriptId": hrs.id}),
        Some("sales"),
        &[hrs],
    )));
    assert_eq!(reason, PlanRefusal::MacroNotFromApplication);
    let (reason, _) = refusal(cell_script(plan_cell_action(
        &serde_json::json!({"kind":"script","scriptId": mine.id}),
        Some("sales"),
        &[mine],
    )));
    assert_eq!(reason, PlanRefusal::MacroNotFromApplication);
}
