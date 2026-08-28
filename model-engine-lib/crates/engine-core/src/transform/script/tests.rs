//! The round-trip battery.
//!
//! Every assertion here is made on the **re-parsed value**, never on the
//! rendered text. Asserting rendered bytes is how a serializer and its parser
//! drift apart while both look tested: the repo's own pivot-layout DSL has an
//! escape test that asserts serializer output, and it thereby locks in a
//! `\"`-versus-`""` mismatch that a single re-parse would have caught.

use std::collections::BTreeSet;

use super::vocabulary::{
    parse_aggregate, parse_cast_error_policy, parse_data_type, parse_text_op, render_aggregate,
    render_cast_error_policy, render_data_type, AGGREGATE_NAMES, CAST_ERROR_POLICY_NAMES, STEPS,
    TEXT_OP_NAMES,
};
use super::{
    parse_placed_statement, parse_script, parse_statement, render_script, render_statement,
};
use crate::compute::aggregate::AggregateOp;
use crate::transform::parts::{
    CastErrorPolicy, ColumnRename, GroupAggregate, RowRange, SortKey, TextOp, TypeChange,
};
use crate::transform::test_support::{every_field_shape, one_of_every_step, HOSTILE};
use crate::transform::{pipeline_fingerprint, TransformStep};
use crate::types::DataType;

/// Every fixture the census tests iterate: one of each variant, plus both
/// states of every omittable field.
fn census() -> Vec<TransformStep> {
    let mut steps = one_of_every_step();
    steps.extend(every_field_shape());
    steps
}

// ---------------------------------------------------------------------------
// 1. The property
// ---------------------------------------------------------------------------

#[test]
fn every_step_survives_render_and_reparse() {
    // THE property this module exists to hold. `one_of_every_step` is tied to
    // the enum by a wildcard-free match that stops compiling when a variant is
    // added, so the denominator cannot silently shrink.
    let steps = one_of_every_step();
    assert_eq!(steps.len(), 18, "the catalog has 18 steps");

    for step in &steps {
        let text = render_statement(step);
        let parsed = parse_script(&text).unwrap_or_else(|e| {
            panic!(
                "{} rendered as {text:?} but failed to parse: {e}",
                step.type_name()
            )
        });
        assert_eq!(
            parsed,
            vec![step.clone()],
            "{} did not survive the round trip; rendered as {text:?}",
            step.type_name()
        );
    }
}

#[test]
fn a_whole_pipeline_survives_as_one_document() {
    // Per-step round trips can all pass while statement separation is broken —
    // this is the assertion that the statements do not bleed into each other.
    let steps = census();
    let text = render_script(&steps);
    assert_eq!(parse_script(&text).unwrap(), steps);
}

#[test]
fn an_empty_pipeline_round_trips_through_empty_text() {
    assert_eq!(render_script(&[]), "");
    assert_eq!(parse_script("").unwrap(), Vec::<TransformStep>::new());
    assert_eq!(
        parse_script("\n\n  \n// only a comment\n# and another\n").unwrap(),
        Vec::<TransformStep>::new(),
        "a buffer holding nothing but comments is an empty pipeline, which is how it is cleared"
    );
}

// ---------------------------------------------------------------------------
// 2. The fail-closed guard on the FIELD axis
// ---------------------------------------------------------------------------

#[test]
fn every_serialized_field_has_a_spelling() {
    // An exhaustive `match` in the renderer catches an 18th VARIANT at compile
    // time. It does not catch a new FIELD on an existing variant unless the
    // destructuring is total — and even then, a field the vocabulary never
    // learned would render into text the parser refuses. So: diff the JSON keys
    // the enum actually produces against the keys the vocabulary declares, in
    // BOTH directions.
    let mut seen: std::collections::BTreeMap<String, BTreeSet<String>> =
        std::collections::BTreeMap::new();
    for step in census() {
        let value = serde_json::to_value(&step).unwrap();
        let object = value.as_object().unwrap();
        let tag = object["type"].as_str().unwrap().to_string();
        let keys = seen.entry(tag).or_default();
        for key in object.keys() {
            if key != "type" {
                keys.insert(key.clone());
            }
        }
    }

    for step in STEPS {
        let mut declared: BTreeSet<String> = step
            .options
            .iter()
            .map(|o| o.json_field.to_string())
            .collect();
        if step.takes_expression {
            declared.insert(step.expression_field.to_string());
        }
        let observed = seen
            .get(step.tag)
            .unwrap_or_else(|| panic!("no fixture produces a {} step", step.tag));

        let unspelled: Vec<&String> = observed.difference(&declared).collect();
        assert!(
            unspelled.is_empty(),
            "{} serializes {unspelled:?}, which the script vocabulary cannot spell — \
             a field with no spelling is silently dropped by the round trip",
            step.tag
        );
        let unexercised: Vec<&String> = declared.difference(observed).collect();
        assert!(
            unexercised.is_empty(),
            "the vocabulary declares {unexercised:?} for {}, but no fixture ever serializes it — \
             add one to every_field_shape() so the spelling is actually tested",
            step.tag
        );
    }
    assert_eq!(seen.len(), 18, "every tag must be represented");
}

#[test]
fn no_render_arm_destructures_with_a_wildcard() {
    // The compile-time half of the guard above. A renderer arm written
    // `Sort { by, .. }` compiles forever while dropping whatever was added
    // beside `by`; total destructuring makes the compiler name the new field.
    let source = include_str!("render.rs");
    let body = source
        .split("fn statement_parts(")
        .nth(1)
        .expect("statement_parts must exist");
    let body = body.split("\n/// A list option").next().unwrap_or(body);
    assert!(
        !body.contains(".. }") && !body.contains(", ..") && !body.contains("{ .. "),
        "statement_parts must destructure every field of every step; a `..` there \
         silently drops a field from the rendered script"
    );
    // Non-vacuity: the slice really is the function body.
    assert!(
        body.contains("TransformStep::Pivot"),
        "sliced the wrong text"
    );
}

// ---------------------------------------------------------------------------
// 3. Enum spellings
// ---------------------------------------------------------------------------

#[test]
fn enum_spelling_census() {
    // Catches the class of defect where a value renders under a spelling its
    // own parser does not accept. `AggregateOp`'s `Display` is SQL text —
    // `Average` displays as `AVG` — so rendering through it would produce a
    // script that cannot be read back.
    let mut checked = 0usize;

    for data_type in [
        DataType::Int32,
        DataType::Int64,
        DataType::Float64,
        DataType::Decimal(18, 2),
        DataType::Decimal(38, -2),
        DataType::String,
        DataType::Boolean,
        DataType::Date,
        DataType::Timestamp,
    ] {
        let rendered = render_data_type(&data_type);
        // Same reasoning as the aggregate census below: an alias must not be
        // able to hide a renderer that emits a non-canonical spelling. Decimal
        // carries its own precision and scale, so it is matched by head.
        let published = super::vocabulary::DATA_TYPE_NAMES.iter().any(|name| {
            *name == rendered || (name.starts_with("Decimal") && rendered.starts_with("Decimal"))
        });
        assert!(
            published,
            "{data_type:?} rendered as {rendered:?}, which is not a published spelling"
        );
        assert_eq!(
            parse_data_type(&rendered),
            Some(data_type.clone()),
            "{data_type:?} rendered as {rendered:?} and did not read back"
        );
        // And through a whole step, so the lexer sees it in place.
        let step = TransformStep::ChangeType {
            changes: vec![TypeChange::new("qty", data_type)],
            on_error: CastErrorPolicy::Fail,
        };
        assert_eq!(parse_script(&render_statement(&step)).unwrap(), vec![step]);
        checked += 1;
    }
    assert_eq!(checked, 9, "every DataType, including both Decimal shapes");

    checked = 0;
    for aggregate in [
        AggregateOp::Sum,
        AggregateOp::Count,
        AggregateOp::Average,
        AggregateOp::Min,
        AggregateOp::Max,
        AggregateOp::DistinctCount,
        AggregateOp::CountRows,
        AggregateOp::Median,
        AggregateOp::StdevSample,
        AggregateOp::StdevPop,
        AggregateOp::VarSample,
        AggregateOp::VarPop,
        AggregateOp::AnyValue,
        AggregateOp::Mode,
    ] {
        let rendered = render_aggregate(&aggregate);
        // Reading back is not enough on its own: an ALIAS can absorb a wrong
        // spelling and leave the round trip intact while the editor's
        // completion offers a word the renderer never emits. So the rendered
        // spelling must be the canonical one the vocabulary publishes.
        assert!(
            AGGREGATE_NAMES.contains(&rendered),
            "{aggregate:?} rendered as {rendered:?}, which is not one of the published              spellings {AGGREGATE_NAMES:?}"
        );
        assert_eq!(parse_aggregate(rendered), Some(aggregate));
        let step = TransformStep::GroupBy {
            group_by: vec!["region".into()],
            aggregates: vec![GroupAggregate::new("amount", aggregate, "out")],
        };
        assert_eq!(parse_script(&render_statement(&step)).unwrap(), vec![step]);
        checked += 1;
    }
    assert_eq!(
        checked,
        AGGREGATE_NAMES.len(),
        "the matrix must stay exhaustive over AggregateOp"
    );

    checked = 0;
    for operation in [TextOp::Trim, TextOp::Clean, TextOp::Upper, TextOp::Lower] {
        assert!(
            TEXT_OP_NAMES.contains(&operation.as_str()),
            "{operation:?} renders as {:?}, which is not a published spelling",
            operation.as_str()
        );
        assert_eq!(parse_text_op(operation.as_str()), Some(operation));
        let step = TransformStep::TextTransform {
            columns: vec!["status".into()],
            operation,
        };
        assert_eq!(parse_script(&render_statement(&step)).unwrap(), vec![step]);
        checked += 1;
    }
    assert_eq!(checked, TEXT_OP_NAMES.len());

    checked = 0;
    for policy in [CastErrorPolicy::Fail, CastErrorPolicy::Null] {
        let rendered = render_cast_error_policy(&policy);
        assert!(
            CAST_ERROR_POLICY_NAMES.contains(&rendered),
            "{policy:?} rendered as {rendered:?}, which is not a published spelling"
        );
        assert_eq!(parse_cast_error_policy(rendered), Some(policy));
        checked += 1;
    }
    assert_eq!(checked, CAST_ERROR_POLICY_NAMES.len());

    checked = 0;
    for range in [
        RowRange::FirstN { count: 0 },
        RowRange::FirstN { count: 1000 },
        RowRange::LastN { count: 7 },
        RowRange::Range {
            offset: 10,
            count: 5,
        },
        RowRange::Range {
            offset: u64::MAX,
            count: u64::MAX,
        },
    ] {
        let step = TransformStep::KeepRows {
            range: range.clone(),
        };
        assert_eq!(parse_script(&render_statement(&step)).unwrap(), vec![step]);
        checked += 1;
    }
    assert_eq!(checked, 5);
}

// ---------------------------------------------------------------------------
// 4 + 5. Field shapes and hostile names
// ---------------------------------------------------------------------------

#[test]
fn every_field_shape_survives() {
    for step in every_field_shape() {
        let text = render_statement(&step);
        let parsed = parse_script(&text)
            .unwrap_or_else(|e| panic!("{step:?} rendered as {text:?} and failed to parse: {e}"));
        assert_eq!(parsed, vec![step.clone()], "rendered as {text:?}");
    }
}

#[test]
fn hostile_names_survive_in_every_string_slot() {
    // Every string-bearing slot of every step, driven with names that break a
    // naive grammar. A slot missed here is a slot where a real column name with
    // a comma or a quote in it corrupts the pipeline on save.
    let mut checked = 0usize;
    for &hostile in HOSTILE {
        let h = hostile.to_string();
        let steps = vec![
            TransformStep::RemoveColumns {
                columns: vec![h.clone(), "plain".into()],
            },
            TransformStep::SelectColumns {
                columns: vec![h.clone()],
            },
            TransformStep::RenameColumns {
                renames: vec![ColumnRename::new(h.clone(), h.clone())],
            },
            TransformStep::ChangeType {
                changes: vec![TypeChange::new(h.clone(), DataType::Decimal(18, 2))],
                on_error: CastErrorPolicy::Null,
            },
            TransformStep::AddColumn {
                name: h.clone(),
                expression: "1 + 1".into(),
                data_type: Some(DataType::Int64),
            },
            TransformStep::TransformColumn {
                column: h.clone(),
                expression: "UPPER([x])".into(),
                data_type: Some(DataType::String),
            },
            TransformStep::SplitColumn {
                column: h.clone(),
                delimiter: h.clone(),
                parts: 3,
                keep_original: true,
            },
            TransformStep::ReplaceValues {
                column: h.clone(),
                find: h.clone(),
                replace: h.clone(),
                match_entire_value: true,
            },
            TransformStep::TextTransform {
                columns: vec![h.clone()],
                operation: TextOp::Upper,
            },
            TransformStep::FillDown {
                columns: vec![h.clone()],
            },
            TransformStep::RemoveDuplicates {
                columns: vec![h.clone()],
            },
            TransformStep::Sort {
                by: vec![
                    SortKey::descending(h.clone()),
                    SortKey::ascending(h.clone()),
                ],
            },
            TransformStep::GroupBy {
                group_by: vec![h.clone()],
                aggregates: vec![
                    GroupAggregate::new(h.clone(), AggregateOp::Sum, h.clone()),
                    GroupAggregate::count_rows(h.clone()),
                    // The formula slot is quoted on render, so a hostile
                    // string must survive there byte-for-byte as well.
                    GroupAggregate::formula(AggregateOp::Max, h.clone(), h.clone()),
                ],
            },
            TransformStep::Unpivot {
                columns: vec![h.clone()],
                name_column: h.clone(),
                value_column: h.clone(),
            },
            TransformStep::Pivot {
                name_column: h.clone(),
                value_column: h.clone(),
                aggregate: AggregateOp::Max,
                value_names: vec![h.clone(), "plain".into()],
            },
        ];
        for step in steps {
            let text = render_statement(&step);
            let parsed = parse_script(&text).unwrap_or_else(|e| {
                panic!(
                    "{hostile:?} in {} rendered as {text:?} and failed to parse: {e}",
                    step.type_name()
                )
            });
            assert_eq!(
                parsed,
                vec![step.clone()],
                "{hostile:?} in {} did not survive; rendered as {text:?}",
                step.type_name()
            );
            checked += 1;
        }
        // The whole batch as one document too, so quoting cannot leak across
        // statement boundaries.
        let steps = vec![
            TransformStep::RemoveColumns {
                columns: vec![h.clone()],
            },
            TransformStep::FillDown {
                columns: vec![h.clone()],
            },
        ];
        assert_eq!(parse_script(&render_script(&steps)).unwrap(), steps);
    }
    assert_eq!(
        checked,
        HOSTILE.len() * 15,
        "every hostile string must reach every string-bearing step"
    );
}

#[test]
fn a_hostile_expression_survives_verbatim() {
    // Expression text reaches the model parser byte-for-byte, so the
    // continuation mechanism must not touch it. Carriage returns are the one
    // documented exception and are excluded here; see
    // `carriage_returns_are_line_terminators_not_data`.
    for expression in [
        "amount > 0",
        "status <> \"cancelled\"",
        "a\nb",
        "a\n  b\n    c",
        "a\n\nb",
        "  leading",
        "trailing  ",
        "x // not a comment\nAND y",
        "# not a comment",
        "CONCAT(a, \";\")",
        "a = b",
        "IF(x, \"y\", \"z\")",
        "\ta",
        "",
    ] {
        for step in [
            TransformStep::FilterRows {
                condition: expression.to_string(),
            },
            TransformStep::AddColumn {
                name: "c".into(),
                expression: expression.to_string(),
                data_type: None,
            },
        ] {
            let text = render_statement(&step);
            let parsed = parse_script(&text).unwrap_or_else(|e| {
                panic!("{expression:?} rendered as {text:?} and failed to parse: {e}")
            });
            assert_eq!(
                parsed,
                vec![step.clone()],
                "{expression:?} did not survive; rendered as {text:?}"
            );
        }
    }
}

#[test]
fn a_trailing_blank_line_in_an_expression_normalizes_away() {
    // The documented cost of not absorbing an editor's stray blank line
    // between two steps. An INTERNAL blank line is preserved exactly, which is
    // the case that makes multi-line DAX readable.
    let steps = parse_script(
        "filterRows = a > 0
 

removeColumns columns=b",
    )
    .unwrap();
    assert_eq!(
        steps[0],
        TransformStep::FilterRows {
            condition: "a > 0".into()
        },
        "a whitespace-only line after a condition is not part of it"
    );
    assert_eq!(steps.len(), 2, "and the next step still starts");

    let internal = parse_script(
        "filterRows = a > 0
 
 AND b > 0",
    )
    .unwrap();
    assert_eq!(
        internal,
        vec![TransformStep::FilterRows {
            condition: "a > 0

AND b > 0"
                .into()
        }],
        "an internal blank line survives"
    );
}

#[test]
fn carriage_returns_are_line_terminators_not_data() {
    // A script buffer is line-oriented text, so a CR is a terminator like any
    // other format's. Pinned rather than left to chance: a CRLF paste and an LF
    // paste must produce the same pipeline.
    let lf = "filterRows = amount > 0\n\nremoveColumns columns=notes";
    let crlf = lf.replace('\n', "\r\n");
    assert_eq!(parse_script(lf).unwrap(), parse_script(&crlf).unwrap());
    assert_eq!(
        parse_script(&crlf).unwrap(),
        vec![
            TransformStep::FilterRows {
                condition: "amount > 0".into()
            },
            TransformStep::RemoveColumns {
                columns: vec!["notes".into()]
            },
        ]
    );
}

// ---------------------------------------------------------------------------
// 6. Cache identity
// ---------------------------------------------------------------------------

#[test]
fn the_round_trip_preserves_the_cache_fingerprint() {
    // The property the on-disk row cache actually depends on. If a round trip
    // through the script pane changed the fingerprint, opening the pane and
    // pressing Apply would discard every cached row for the table.
    let steps = census();
    let reparsed = parse_script(&render_script(&steps)).unwrap();
    assert_eq!(
        pipeline_fingerprint(&reparsed),
        pipeline_fingerprint(&steps)
    );
    for step in steps {
        let one = vec![step];
        let back = parse_script(&render_script(&one)).unwrap();
        assert_eq!(pipeline_fingerprint(&back), pipeline_fingerprint(&one));
    }
}

// ---------------------------------------------------------------------------
// Grammar behaviour
// ---------------------------------------------------------------------------

#[test]
fn a_realistic_pipeline_reads_the_way_it_is_written() {
    let text = r#"
// Sales - applied steps
removeColumns columns=internal_note

renameColumns
  rename=amt:amount
  rename=cst:cost

changeType
  cast=order_id:Int64
  cast=amount:Decimal(18,2)
  onError=null

filterRows = status <> "cancelled"
   AND amount > 0

addColumn name=margin dataType=Float64 = amount - cost

// splitColumn column=region delimiter=" - " parts=2

sort by=-margin,region

groupBy
  groupBy=region
  agg=Sum:margin:total_margin
  agg=CountRows::orders

pivot
  nameColumn=region
  valueColumn=total_margin
  aggregate=Sum
  valueNames=North,South
"#;
    let steps = parse_script(text).unwrap();
    assert_eq!(
        steps,
        vec![
            TransformStep::RemoveColumns {
                columns: vec!["internal_note".into()]
            },
            TransformStep::RenameColumns {
                renames: vec![
                    ColumnRename::new("amt", "amount"),
                    ColumnRename::new("cst", "cost"),
                ]
            },
            TransformStep::ChangeType {
                changes: vec![
                    TypeChange::new("order_id", DataType::Int64),
                    TypeChange::new("amount", DataType::Decimal(18, 2)),
                ],
                on_error: CastErrorPolicy::Null,
            },
            TransformStep::FilterRows {
                condition: "status <> \"cancelled\"\n  AND amount > 0".into()
            },
            TransformStep::AddColumn {
                name: "margin".into(),
                expression: "amount - cost".into(),
                data_type: Some(DataType::Float64),
            },
            TransformStep::Sort {
                by: vec![SortKey::descending("margin"), SortKey::ascending("region")]
            },
            TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![
                    GroupAggregate::new("margin", AggregateOp::Sum, "total_margin"),
                    GroupAggregate::count_rows("orders"),
                ],
            },
            TransformStep::Pivot {
                name_column: "region".into(),
                value_column: "total_margin".into(),
                aggregate: AggregateOp::Sum,
                value_names: vec!["North".into(), "South".into()],
            },
        ]
    );
    // And it survives being written back out.
    assert_eq!(parse_script(&render_script(&steps)).unwrap(), steps);
}

#[test]
fn a_commented_out_step_is_left_out() {
    // The gesture the script pane exists to make possible: disable a step,
    // watch the preview, put it back. Only a comment at column zero counts,
    // because an indented line is always a continuation.
    let steps =
        parse_script("removeColumns columns=a\n// fillDown columns=b\nfillDown columns=c").unwrap();
    assert_eq!(
        steps,
        vec![
            TransformStep::RemoveColumns {
                columns: vec!["a".into()]
            },
            TransformStep::FillDown {
                columns: vec!["c".into()]
            },
        ]
    );
}

#[test]
fn an_indented_comment_is_part_of_the_expression_above_it() {
    let steps = parse_script("filterRows = a > 0\n  // still the condition").unwrap();
    assert_eq!(
        steps,
        vec![TransformStep::FilterRows {
            condition: "a > 0\n // still the condition".into()
        }]
    );
}

#[test]
fn a_formula_aggregate_reads_renders_and_keeps_its_place() {
    // The SUMIF shape in the script: `aggFormula=Function:"formula":alias`,
    // the same three-atom family as `agg=`, with the operand quoted so it can
    // hold commas, colons and its own string literals. The column aggregate
    // sits BETWEEN two formula ones because the two kinds render under two
    // different keys — a parser collecting per key would reorder them.
    let text = "groupBy groupBy=region \
                aggFormula=Sum:\"IF([status] = \"\"open\"\", [amount], BLANK())\":open_total \
                agg=Sum:amount:total \
                aggFormula=Count:\"IF([amount] > 80, 1, BLANK())\":big";
    let steps = parse_script(text).unwrap();
    let expected = vec![TransformStep::GroupBy {
        group_by: vec!["region".into()],
        aggregates: vec![
            GroupAggregate::formula(
                AggregateOp::Sum,
                "open_total",
                "IF([status] = \"open\", [amount], BLANK())",
            ),
            GroupAggregate::new("amount", AggregateOp::Sum, "total"),
            GroupAggregate::formula(AggregateOp::Count, "big", "IF([amount] > 80, 1, BLANK())"),
        ],
    }];
    assert_eq!(steps, expected);
    // And the round trip holds over the mixed order.
    assert_eq!(parse_script(&render_script(&expected)).unwrap(), expected);

    // Two atoms is a missing alias, named as such.
    let error = parse_script("groupBy aggFormula=Sum:\"1\"").unwrap_err();
    assert!(error.message.contains("output column name"), "{error}");
}

#[test]
fn the_command_lines_spellings_still_parse() {
    // The shipped CLI's abbreviations and shapes, kept readable so a script the
    // command line produced is not suddenly invalid. None of these is ever
    // emitted by the renderer.
    let cases: Vec<(&str, TransformStep)> = vec![
        (
            "filter = amount > 0",
            TransformStep::FilterRows {
                condition: "amount > 0".into(),
            },
        ),
        (
            "renameColumn column=amt newname=amount",
            TransformStep::RenameColumns {
                renames: vec![ColumnRename::new("amt", "amount")],
            },
        ),
        (
            "changeType columns=a,b type=int",
            TransformStep::ChangeType {
                changes: vec![
                    TypeChange::new("a", DataType::Int64),
                    TypeChange::new("b", DataType::Int64),
                ],
                on_error: CastErrorPolicy::Fail,
            },
        ),
        (
            "changeType column=qty type=Int64 onerror=null",
            TransformStep::ChangeType {
                changes: vec![TypeChange::new("qty", DataType::Int64)],
                on_error: CastErrorPolicy::Null,
            },
        ),
        (
            "replace column=s find=\"a\" replace=\"b\" matchentire=true",
            TransformStep::ReplaceValues {
                column: "s".into(),
                find: "a".into(),
                replace: "b".into(),
                match_entire_value: true,
            },
        ),
        (
            "dedupe columns=id",
            TransformStep::RemoveDuplicates {
                columns: vec!["id".into()],
            },
        ),
        (
            "sort by=amount:desc",
            TransformStep::Sort {
                by: vec![SortKey::descending("amount")],
            },
        ),
        (
            "group groupby=region agg=avg:amount:mean",
            TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::new("amount", AggregateOp::Average, "mean")],
            },
        ),
        (
            "pivot namecolumn=s valuecolumn=a aggregate=sum values=x,y",
            TransformStep::Pivot {
                name_column: "s".into(),
                value_column: "a".into(),
                aggregate: AggregateOp::Sum,
                value_names: vec!["x".into(), "y".into()],
            },
        ),
        (
            "removeColumns columns=[an odd name],plain",
            TransformStep::RemoveColumns {
                columns: vec!["an odd name".into(), "plain".into()],
            },
        ),
        (
            "keeprow range=first:100",
            TransformStep::KeepRows {
                range: RowRange::FirstN { count: 100 },
            },
        ),
    ];
    for (text, expected) in cases {
        assert_eq!(parse_statement(text).unwrap(), expected, "parsing {text:?}");
    }
}

#[test]
fn a_placement_is_read_and_never_rendered() {
    let placed = parse_placed_statement("fillDown columns=region at=3").unwrap();
    assert_eq!(placed.at, Some(3));
    assert_eq!(
        placed.step,
        TransformStep::FillDown {
            columns: vec!["region".into()]
        }
    );
    assert!(
        !render_statement(&placed.step).contains("at="),
        "position is carried by the order of the statements, never by an option"
    );
    assert_eq!(
        parse_placed_statement("fillDown columns=region")
            .unwrap()
            .at,
        None
    );
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

#[test]
fn an_unknown_step_is_refused_with_the_catalog() {
    let error = parse_script("frobnicate columns=a").unwrap_err();
    assert!(
        error.message.contains("not a transformation step"),
        "{error}"
    );
    assert!(
        error.message.contains("filterRows"),
        "must list the catalog: {error}"
    );
    assert_eq!((error.line, error.column), (1, 1));
}

#[test]
fn a_near_miss_is_named() {
    let error = parse_script("filterRow2 = a > 0").unwrap_err();
    assert!(error.message.contains("filterRows"), "{error}");
}

#[test]
fn a_step_this_catalog_deliberately_lacks_says_why() {
    // These are the steps a Power Query user reaches for first. "Unknown step"
    // teaches nothing; the reason is a design decision worth stating.
    for (text, expected) in [
        ("promoteHeaders", "derivable without reading rows"),
        ("mergeTable table=Other", "not yet a step"),
        ("appendTable table=Other", "not yet a step"),
        ("addIndex name=i", "depend on row order"),
        ("transpose", "come from the data"),
    ] {
        let error = parse_script(text).unwrap_err();
        assert!(
            error.message.contains(expected),
            "{text} should explain '{expected}', said: {}",
            error.message
        );
    }
}

#[test]
fn an_option_that_does_not_apply_is_refused() {
    let error = parse_script("filterRows column=x = a > 0").unwrap_err();
    assert!(error.message.contains("does not apply"), "{error}");
    assert!(error.message.contains("filterRows"), "{error}");

    let error = parse_script("fillDown columns=a delimiter=\",\"").unwrap_err();
    assert!(error.message.contains("does not apply"), "{error}");
    assert!(error.message.contains("it accepts: columns="), "{error}");
}

#[test]
fn a_missing_required_option_names_it() {
    let error = parse_script("splitColumn column=region parts=2").unwrap_err();
    assert!(error.message.contains("delimiter"), "{error}");

    let error = parse_script("addColumn = a + b").unwrap_err();
    assert!(error.message.contains("name"), "{error}");
}

#[test]
fn an_expression_step_without_an_expression_is_refused_and_the_reverse() {
    let error = parse_script("filterRows").unwrap_err();
    assert!(error.message.contains("= <expression>"), "{error}");

    let error = parse_script("fillDown columns=a = 1 + 1").unwrap_err();
    assert!(
        error.message.contains("takes no '= <expression>'"),
        "{error}"
    );
    assert!(
        error.message.contains("filterRows and addColumn"),
        "{error}"
    );
}

#[test]
fn a_repeated_single_option_is_refused() {
    let error = parse_script("splitColumn column=a column=b delimiter=\",\" parts=2").unwrap_err();
    assert!(error.message.contains("more than once"), "{error}");
}

#[test]
fn errors_carry_the_position_the_editor_needs() {
    // Line and column are what a host turns into a marker; an error without
    // them can only be shown as a banner.
    let error = parse_script("removeColumns columns=a\n\nfillDown wrong=1").unwrap_err();
    assert_eq!(error.line, 3, "the third physical line: {error}");
    assert_eq!(error.column, 10, "the column of 'wrong': {error}");

    let error = parse_script("changeType cast=qty:Nonsense").unwrap_err();
    assert!(error.message.contains("not a column type"), "{error}");
    assert_eq!(error.line, 1);
    assert_eq!(error.column, 21, "the column of 'qty:Nonsense': {error}");
}

#[test]
fn an_indented_first_line_is_refused_rather_than_silently_dropped() {
    let error = parse_script("  fillDown columns=a").unwrap_err();
    assert!(error.message.contains("no step above"), "{error}");
    assert_eq!(error.line, 1);
}

#[test]
fn an_unterminated_quote_or_bracket_is_refused() {
    let error = parse_script("removeColumns columns=\"unclosed").unwrap_err();
    assert!(error.message.contains("unterminated"), "{error}");

    let error = parse_script("removeColumns columns=[unclosed").unwrap_err();
    assert!(error.message.contains("unterminated"), "{error}");
}

#[test]
fn an_unknown_escape_is_refused_rather_than_passed_through() {
    // Accepting an unknown escape silently is how two spellings of the same
    // character end up in one corpus.
    let error = parse_script("splitColumn column=a delimiter=\"\\d\" parts=2").unwrap_err();
    assert!(error.message.contains("unknown escape"), "{error}");
}

#[test]
fn parse_statement_refuses_a_second_step() {
    let error = parse_statement("fillDown columns=a\nfillDown columns=b").unwrap_err();
    assert!(error.message.contains("one transformation step"), "{error}");
    assert_eq!(error.line, 2);
}

#[test]
fn a_value_glued_to_the_one_before_it_is_refused() {
    let error = parse_script("removeColumns columns=a\"b\"").unwrap_err();
    assert!(error.message.contains("runs straight into"), "{error}");
}

#[test]
fn mode_renders_and_reparses_even_though_derivation_refuses_it() {
    // The renderer is total over the enum, so the parser must be too. Refusing
    // `Mode` here would make the renderer emit text its own parser rejects;
    // instead it survives the round trip and is refused later, on its own step
    // index, by `aggregate_output_type`.
    let step = TransformStep::GroupBy {
        group_by: vec!["region".into()],
        aggregates: vec![GroupAggregate::new("amount", AggregateOp::Mode, "common")],
    };
    assert_eq!(parse_script(&render_statement(&step)).unwrap(), vec![step]);
}

// ---------------------------------------------------------------------------
// Rendering shape
// ---------------------------------------------------------------------------

#[test]
fn rendering_omits_every_default() {
    // The text must say what the JSON says: an omitted option is the same
    // absence serde writes, so the two forms cannot disagree about a default.
    let rendered = render_statement(&TransformStep::ChangeType {
        changes: vec![TypeChange::new("qty", DataType::Int64)],
        on_error: CastErrorPolicy::Fail,
    });
    assert!(!rendered.contains("onError"), "got {rendered:?}");

    let rendered = render_statement(&TransformStep::RemoveDuplicates { columns: vec![] });
    assert_eq!(
        rendered, "removeDuplicates",
        "an omitted columns= is the meaning 'every column'"
    );

    let rendered = render_statement(&TransformStep::SplitColumn {
        column: "a".into(),
        delimiter: ",".into(),
        parts: 2,
        keep_original: false,
    });
    assert!(!rendered.contains("keepOriginal"), "got {rendered:?}");

    let rendered = render_statement(&TransformStep::Sort {
        by: vec![SortKey::ascending("amount")],
    });
    assert_eq!(rendered, "sort by=amount", "ascending is the default");
}

#[test]
fn repeatable_options_break_onto_their_own_lines() {
    // So that a changed rename is one changed line in a diff, not one changed
    // long line.
    let rendered = render_statement(&TransformStep::RenameColumns {
        renames: vec![ColumnRename::new("a", "b"), ColumnRename::new("c", "d")],
    });
    assert_eq!(rendered, "renameColumns\n  rename=a:b\n  rename=c:d");
}

#[test]
fn a_single_short_step_stays_on_one_line() {
    assert_eq!(
        render_statement(&TransformStep::RemoveColumns {
            columns: vec!["notes".into()]
        }),
        "removeColumns columns=notes"
    );
    assert_eq!(
        render_statement(&TransformStep::FilterRows {
            condition: "amount > 0".into()
        }),
        "filterRows = amount > 0"
    );
}

#[test]
fn a_long_statement_wraps_and_still_reads_back() {
    let step = TransformStep::SelectColumns {
        columns: (0..20).map(|i| format!("column_number_{i}")).collect(),
    };
    let rendered = render_statement(&step);
    assert!(rendered.contains('\n'), "should have wrapped: {rendered}");
    assert_eq!(parse_script(&rendered).unwrap(), vec![step]);
}

#[test]
fn statements_are_separated_by_a_blank_line() {
    let text = render_script(&[
        TransformStep::RemoveColumns {
            columns: vec!["a".into()],
        },
        TransformStep::FillDown {
            columns: vec!["b".into()],
        },
    ]);
    assert_eq!(text, "removeColumns columns=a\n\nfillDown columns=b");
}

#[test]
fn a_column_whose_name_starts_with_a_dash_keeps_it_when_sorted() {
    // The compact `-column` form for descending must never swallow a column
    // whose own name begins with a dash.
    for descending in [false, true] {
        let step = TransformStep::Sort {
            by: vec![SortKey {
                column: "-weird".into(),
                descending,
            }],
        };
        let rendered = render_statement(&step);
        assert_eq!(
            parse_script(&rendered).unwrap(),
            vec![step],
            "rendered as {rendered:?}"
        );
    }
}

#[test]
fn the_vocabulary_covers_the_catalog() {
    // The table the host serves to its editor must describe every step, or
    // completion silently stops offering one.
    let vocabulary = super::script_vocabulary();
    assert_eq!(vocabulary.steps.len(), 18);
    let tags: BTreeSet<&str> = vocabulary.steps.iter().map(|s| s.tag).collect();
    for step in one_of_every_step() {
        assert!(
            tags.contains(step.type_name()),
            "{} is missing from the vocabulary",
            step.type_name()
        );
    }
    assert_eq!(vocabulary.placement_option, "at");
    assert!(vocabulary.data_types.contains(&"Decimal(18,2)"));
    assert_eq!(vocabulary.aggregates.len(), AGGREGATE_NAMES.len());
}
