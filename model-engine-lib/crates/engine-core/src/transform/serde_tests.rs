//! Serialization contract for the step catalog.
//!
//! A pipeline is persisted in shared model files and read by host
//! applications, so its JSON shape is a contract. These tests pin it.

use crate::transform::test_support::one_of_every_step;
use crate::transform::TransformStep;

#[test]
fn every_step_round_trips() {
    for step in one_of_every_step() {
        let json = serde_json::to_string(&step).unwrap();
        let restored: TransformStep = serde_json::from_str(&json).unwrap();
        assert_eq!(step, restored, "round trip failed for {json}");
    }
}

#[test]
fn every_step_is_tagged_with_a_camel_case_type() {
    for step in one_of_every_step() {
        let value = serde_json::to_value(&step).unwrap();
        let tag = value
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_else(|| panic!("no `type` tag on {value}"));
        assert!(
            !tag.contains('_') && tag.starts_with(|c: char| c.is_lowercase()),
            "tag '{tag}' is not camelCase"
        );
    }
}

#[test]
fn no_field_name_uses_snake_case() {
    // The host mirrors these structures in TypeScript, where the convention is
    // camelCase (repo rule). A snake_case field here would silently break the
    // mirror on one variant only.
    for step in one_of_every_step() {
        let value = serde_json::to_value(&step).unwrap();
        let object = value.as_object().unwrap();
        for key in object.keys() {
            assert!(
                !key.contains('_'),
                "field '{key}' on step '{}' is not camelCase",
                step.type_name()
            );
        }
    }
}

#[test]
fn a_pipeline_round_trips_as_an_array() {
    let steps = one_of_every_step();
    let json = serde_json::to_string(&steps).unwrap();
    let restored: Vec<TransformStep> = serde_json::from_str(&json).unwrap();
    assert_eq!(steps, restored);
}

#[test]
fn an_unknown_step_tag_is_refused() {
    // Refusing is the point of the format-version gate: a pipeline containing
    // a step this engine does not implement must not load and silently skip
    // it, because the table would then look refreshed while being unfiltered.
    let json = r#"{"type":"teleportRows","columns":["a"]}"#;
    let parsed: Result<TransformStep, _> = serde_json::from_str(json);
    assert!(parsed.is_err(), "unknown step tag must not deserialize");
}

#[test]
fn json_shape_is_stable_for_a_representative_step() {
    let step = TransformStep::AddColumn {
        name: "margin".into(),
        expression: "amount - cost".into(),
        data_type: None,
    };
    let json = serde_json::to_string(&step).unwrap();
    assert_eq!(
        json,
        r#"{"type":"addColumn","name":"margin","expression":"amount - cost"}"#
    );
}

#[test]
fn a_filter_condition_survives_quotes_and_newlines_verbatim() {
    // Expressions are stored as the author's text; a lossy round trip here
    // would rewrite someone's formula.
    let condition = "status <> \"cancelled\"\n  AND amount > 0";
    let step = TransformStep::FilterRows {
        condition: condition.into(),
    };
    let json = serde_json::to_string(&step).unwrap();
    let restored: TransformStep = serde_json::from_str(&json).unwrap();
    match restored {
        TransformStep::FilterRows { condition: got } => assert_eq!(got, condition),
        other => panic!("expected FilterRows, got {other:?}"),
    }
}
