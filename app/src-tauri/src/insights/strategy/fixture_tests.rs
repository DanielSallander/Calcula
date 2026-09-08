//! FILENAME: app/src-tauri/src/insights/strategy/fixture_tests.rs
// PURPOSE: Run the checked-in strategy fixtures against the real resolver.
// CONTEXT: Every other test in this subtree builds its own two-rule document,
// which proves the mechanism and nothing about whether a document a person
// would actually write survives it. These two files are that document:
//
//   tests/fixtures/model/sales_star{,_strategy}.json — a full star schema with
//   six measures, a KPI, a snowflaked dimension, seven rules and inline tests.
//   tests/eval/strategy-cases.json — one resolution case per RULE of §7.4, each
//   carrying a `why` that says what breaks if it fails.
//
// They are read from disk rather than `include_str!`'d because the model file is
// 600 KB and would otherwise sit in the binary; the path is relative to
// CARGO_MANIFEST_DIR so it does not depend on the working directory a test
// runner happens to use.
//
// THE CORPUS IS THE SPEC. A case here failing means the resolver disagrees with
// the documented layering, and the right first move is to read the case's `why`
// rather than to adjust the expectation.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;

use super::facts::facts_from_model;
use super::resolve::{resolve, AttrSource, ModelFacts, ScopePoint};
use super::types::{Materiality, QualifiedColumn, StrategyDoc, Target};
use super::validate::{run_inline_tests, validate, Severity};
use super::{check_overlaps, Direction};

/// `<repo>/tests/...`, from this crate's manifest directory.
fn repo_file(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

fn read_json(relative: &str) -> serde_json::Value {
    let path = repo_file(relative);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()))
}

/// The star-schema fixture's model, as engine facts.
fn star_facts() -> ModelFacts {
    let bundle = read_json("tests/fixtures/model/sales_star.json");
    let model: bi_engine::DataModel = serde_json::from_value(bundle["model"].clone())
        .expect("the fixture's `model` deserializes as a DataModel");
    facts_from_model(&model)
}

fn star_strategy() -> StrategyDoc {
    serde_json::from_value(read_json("tests/fixtures/model/sales_star_strategy.json"))
        .expect("the fixture strategy document deserializes")
}

#[test]
fn the_star_fixture_strategy_document_deserializes_as_written() {
    // `deny_unknown_fields` is on every container, so this fails the moment the
    // hand-authored file and the types drift apart in EITHER direction — a
    // renamed field in the Rust or a typo in the JSON.
    let doc = star_strategy();
    assert_eq!(doc.version, 1);
    assert!(doc.measures.len() >= 5, "the fixture is meant to be substantial");
    assert!(doc.rules.len() >= 5);
    assert!(!doc.tests.is_empty(), "the fixture carries its own assertions");
}

#[test]
fn the_star_fixture_strategy_document_validates_without_errors() {
    let facts = star_facts();
    let doc = star_strategy();
    let findings = validate(&facts, &doc);
    let errors: Vec<String> = findings
        .iter()
        .filter(|f| f.severity == Severity::Error)
        .map(|f| format!("[{}] {}: {}", f.code, f.path, f.message))
        .collect();
    assert!(
        errors.is_empty(),
        "the shipped fixture must be a valid document:\n{}",
        errors.join("\n")
    );
}

#[test]
fn the_star_fixture_has_no_unresolved_rule_overlap() {
    // The fixture deliberately contains a DISJOINT equal-specificity pair and a
    // more-specific rule that resolves an intersecting one. Both are legal, and
    // the checker must say so — a checker that refuses legal documents is as
    // useless as one that accepts ambiguous ones.
    let conflicts = check_overlaps(&star_strategy());
    let messages: Vec<String> = conflicts.iter().map(|c| c.message()).collect();
    assert!(conflicts.is_empty(), "{}", messages.join("\n"));
}

#[test]
fn the_star_fixtures_own_inline_tests_pass() {
    let facts = star_facts();
    let doc = star_strategy();
    let findings = run_inline_tests(&facts, &doc);
    let failures: Vec<String> = findings
        .iter()
        .map(|f| format!("[{}] {}: {}", f.code, f.path, f.message))
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn the_snowflaked_dimension_is_present_and_is_not_a_leaf() {
    // The fixture plants a snowflake on purpose, so that "an attribute behind
    // another dimension is reported unreachable rather than silently skipped"
    // has something real to point at. If this stops holding, that guarantee
    // becomes untested even though its test still passes.
    let facts = star_facts();
    let one_hop = facts.directly_related_tables("Sales");
    assert!(one_hop.contains("Product"), "Product is directly related");
    assert!(
        !one_hop.contains("Subcategory"),
        "Subcategory must be reachable only THROUGH Product, or the fixture no \
         longer exercises the single-hop limit"
    );
    // ...and it must still be part of the model, or the fixture would be
    // proving the limit with a table that is simply absent.
    assert!(facts.reachable_tables("Sales").contains("Subcategory"));
}

// ---------------------------------------------------------------------------
// The resolution corpus
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseFile {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    /// What breaks if this case fails. Printed on failure, because the reason a
    /// case exists is the thing a future reader needs and the thing a bare
    /// assertion never carries.
    why: String,
    /// `"sales_star"` or an inline model. Only the named fixture is supported
    /// today; an inline one is reported rather than silently skipped.
    #[serde(default)]
    model: serde_json::Value,
    /// `"sales_star"` to use the fixture's own strategy document, or an inline
    /// document for a case that needs a different one. Most cases are inline,
    /// because a case that shares the big document proves less: the reader
    /// cannot see which rule it is testing without opening another file.
    strategy: serde_json::Value,
    measure: String,
    #[serde(default)]
    scope_point: BTreeMap<String, serde_json::Value>,
    expect: Expect,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expect {
    #[serde(default)]
    direction: Option<Direction>,
    /// `"base"`, `"inferred"`, `"strategy"`, `"kpi:<name>"` or `"rule:<id>"`.
    #[serde(default)]
    direction_source: Option<String>,
    #[serde(default)]
    materiality: Option<Materiality>,
    #[serde(default)]
    target: Option<Target>,
    #[serde(default)]
    suppressed: Option<bool>,
    #[serde(default)]
    suppress_reason: Option<String>,
}

/// The corpus spells provenance as one flat string; `AttrSource` is an enum.
fn source_label(source: &AttrSource) -> String {
    match source {
        AttrSource::Base => "base".to_string(),
        AttrSource::Inferred => "inferred".to_string(),
        AttrSource::Strategy => "strategy".to_string(),
        AttrSource::Kpi(name) => format!("kpi:{name}"),
        AttrSource::Rule(id) => format!("rule:{id}"),
    }
}

/// A scope point written as `{"Table[Column]": "Member"}`.
fn point_from_json(raw: &BTreeMap<String, serde_json::Value>) -> ScopePoint {
    let mut fixed = BTreeMap::new();
    for (key, value) in raw {
        let column: QualifiedColumn = key
            .parse()
            .unwrap_or_else(|e| panic!("scope point key '{key}' is not Table[Column]: {e}"));
        let member = value
            .as_str()
            .unwrap_or_else(|| panic!("scope point '{key}' must fix ONE member, got {value}"));
        fixed.insert(column, member.to_string());
    }
    ScopePoint {
        fixed,
        aggregated: BTreeMap::new(),
    }
}

#[test]
fn every_strategy_resolution_case_resolves_the_way_the_corpus_says() {
    let file: CaseFile = serde_json::from_value(read_json("tests/eval/strategy-cases.json"))
        .expect("the case corpus deserializes");
    assert!(
        file.cases.len() >= 10,
        "a corpus this small cannot cover the layering rules"
    );

    let facts = star_facts();
    let shipped = star_strategy();
    let mut failures: Vec<String> = Vec::new();

    for case in &file.cases {
        if case.model.as_str() != Some("sales_star") {
            failures.push(format!(
                "{}: only the 'sales_star' model fixture is wired up; this case names {:?}",
                case.id, case.model
            ));
            continue;
        }
        let doc: StrategyDoc = if case.strategy.as_str() == Some("sales_star") {
            shipped.clone()
        } else {
            match serde_json::from_value(case.strategy.clone()) {
                Ok(d) => d,
                Err(e) => {
                    failures.push(format!(
                        "--- {} ---\n  why: {}\n  its inline strategy document does not \
                         deserialize: {e}",
                        case.id, case.why
                    ));
                    continue;
                }
            }
        };
        let point = point_from_json(&case.scope_point);
        let resolved = resolve(&facts, &doc, &case.measure, &point);
        let mut problems: Vec<String> = Vec::new();

        if let Some(expected) = case.expect.direction {
            match resolved.direction.as_ref() {
                Some(a) if a.value == expected => {}
                other => problems.push(format!(
                    "direction: expected {expected:?}, got {:?}",
                    other.map(|a| a.value)
                )),
            }
        }
        if let Some(expected) = &case.expect.direction_source {
            match resolved.direction.as_ref() {
                Some(a) if &source_label(&a.source) == expected => {}
                other => problems.push(format!(
                    "direction source: expected {expected}, got {:?}",
                    other.map(|a| source_label(&a.source))
                )),
            }
        }
        if let Some(expected) = &case.expect.materiality {
            match resolved.materiality.as_ref() {
                Some(a) if &a.value == expected => {}
                other => problems.push(format!(
                    "materiality: expected {expected:?}, got {:?}",
                    other.map(|a| &a.value)
                )),
            }
        }
        if let Some(expected) = &case.expect.target {
            match resolved.target.as_ref() {
                Some(a) if &a.value == expected => {}
                other => problems.push(format!(
                    "target: expected {expected:?}, got {:?}",
                    other.map(|a| &a.value)
                )),
            }
        }
        if let Some(expected) = case.expect.suppressed {
            let actual = resolved
                .suppression_of(super::types::Attribute::Direction)
                .is_some();
            if actual != expected {
                problems.push(format!(
                    "direction suppression: expected {expected}, got {actual}"
                ));
            }
        }
        if let Some(expected_rule) = &case.expect.suppress_reason {
            match resolved.suppression_of(super::types::Attribute::Direction) {
                Some(s) if &s.rule == expected_rule => {}
                other => problems.push(format!(
                    "suppressing rule: expected {expected_rule}, got {:?}",
                    other.map(|s| &s.rule)
                )),
            }
        }

        if !problems.is_empty() {
            failures.push(format!(
                "--- {} ---\n  why: {}\n  {}",
                case.id,
                case.why,
                problems.join("\n  ")
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} resolution cases disagree with the resolver:\n\n{}",
        failures.len(),
        file.cases.len(),
        failures.join("\n\n")
    );
}
