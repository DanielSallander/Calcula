//! Serialization round-trip tests for expression types.

use super::*;

#[test]
fn qualified_column_ref_serialization_roundtrip() {
    let expr = qualified_col("premium", "amount");
    let json = serde_json::to_string(&expr).unwrap();
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.to_sql_string().unwrap(), "\"amount\"");
}

#[test]
fn table_ref_serialization_roundtrip() {
    let expr = table_ref("premium");
    let json = serde_json::to_string(&expr).unwrap();
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    assert!(matches!(deserialized, Expression::TableRef(ref n) if n == "premium"));
}

#[test]
fn query_scoped_bindings_serialization_roundtrip() {
    // A block carrying a GVAR (query-scoped) binding round-trips.
    let expr = block_with_globals(
        vec![(
            "grand".into(),
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        )],
        vec![],
        safe_divide(
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
            col("grand"),
            None,
        ),
    );
    let json = serde_json::to_string(&expr).unwrap();
    assert!(json.contains("query_scoped_bindings"));
    let restored: Expression = serde_json::from_str(&json).unwrap();
    match restored {
        Expression::Block {
            query_scoped_bindings,
            bindings,
            ..
        } => {
            assert_eq!(query_scoped_bindings.len(), 1);
            assert_eq!(query_scoped_bindings[0].0, "grand");
            assert!(bindings.is_empty());
        }
        other => panic!("expected Block, got {other:?}"),
    }
}

#[test]
fn block_without_query_scoped_bindings_omits_the_field() {
    // Backward compatibility: an ordinary VAR block does not emit the new key,
    // and legacy JSON without it deserializes to an empty list.
    let expr = block(
        vec![(
            "total".into(),
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        )],
        col("total"),
    );
    let json = serde_json::to_string(&expr).unwrap();
    assert!(
        !json.contains("query_scoped_bindings"),
        "empty query_scoped_bindings must be skipped: {json}"
    );
    // Legacy JSON (pre-v13, no field) still deserializes.
    let legacy = r#"{"Block":{"bindings":[["total",{"Aggregate":{"operation":"Sum","operand":{"QualifiedColumnRef":{"table_or_var":"Sales","column":"amount"}}}}]],"result":{"ColumnRef":"total"}}}"#;
    let restored: Expression = serde_json::from_str(legacy).unwrap();
    assert!(!restored.has_query_scoped_bindings());
}

#[test]
fn keep_in_serialization_roundtrip() {
    let expr = keep_in(
        agg(AggregateOp::Sum, col("amount")),
        vec![InPredicate::new("Sales", "product_id", "premium", "id")],
    );
    let json = serde_json::to_string(&expr).unwrap();
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    assert!(deserialized.has_context_ops());
    assert!(deserialized.has_aggregate());
    assert_eq!(deserialized.to_sql_string().unwrap(), "SUM(\"amount\")");
}

#[test]
fn context_expression_serialization_roundtrip() {
    let expr = agg(
        AggregateOp::Sum,
        keep(
            col("amount"),
            vec![FilterPredicate::new(
                "Calendar",
                "Year",
                ComparisonOp::Equal,
                "2024",
            )],
        ),
    );
    let json = serde_json::to_string(&expr).unwrap();
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.to_sql_string().unwrap(), "SUM(\"amount\")");
    assert!(deserialized.has_context_ops());
    assert!(deserialized.has_aggregate());
}

#[test]
fn new_exprs_serialization_roundtrip() {
    let exprs = vec![
        if_expr(
            compare(col("x"), ComparisonOp::GreaterThan, lit_int(0)),
            lit_str("pos"),
            lit_str("neg"),
        ),
        safe_divide(col("a"), col("b"), Some(lit_int(0))),
        coalesce(vec![col("a"), col("b")]),
        blank(),
        is_blank(col("x")),
        scalar_fn(ScalarFunction::Round, vec![col("price"), lit_int(2)]),
        count_rows(),
    ];
    for expr in exprs {
        let json = serde_json::to_string(&expr).unwrap();
        let deser: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(
            deser.to_sql_string().unwrap(),
            expr.to_sql_string().unwrap()
        );
    }
}

#[test]
fn block_serialization_roundtrip() {
    let expr = block(
        vec![
            ("rev".into(), agg(AggregateOp::Sum, col("amount"))),
            ("cnt".into(), agg(AggregateOp::Count, col("id"))),
        ],
        safe_divide(col("rev"), col("cnt"), None),
    );
    let json = serde_json::to_string(&expr).unwrap();
    let deser: Expression = serde_json::from_str(&json).unwrap();
    assert_eq!(
        deser.to_sql_string().unwrap(),
        expr.to_sql_string().unwrap()
    );
}

#[test]
fn has_one_value_serialization_roundtrip() {
    let expr = has_one_value(col("region"));
    let json = serde_json::to_string(&expr).unwrap();
    let deser: Expression = serde_json::from_str(&json).unwrap();
    assert_eq!(
        deser.to_sql_string().unwrap(),
        expr.to_sql_string().unwrap()
    );
}

#[test]
fn selected_value_serialization_roundtrip() {
    let expr = selected_value(col("region"), Some(lit_str("Multiple")));
    let json = serde_json::to_string(&expr).unwrap();
    let deser: Expression = serde_json::from_str(&json).unwrap();
    assert_eq!(
        deser.to_sql_string().unwrap(),
        expr.to_sql_string().unwrap()
    );
}

#[test]
fn first_value_serialization_roundtrip() {
    let expr = first_value(col("name"), col("sort_order"));
    let json = serde_json::to_string(&expr).unwrap();
    let deser: Expression = serde_json::from_str(&json).unwrap();
    assert_eq!(
        deser.to_sql_string().unwrap(),
        expr.to_sql_string().unwrap()
    );
}

#[test]
fn literal_bool_serialization_roundtrip() {
    let expr = lit_bool(true);
    let json = serde_json::to_string(&expr).unwrap();
    let deser: Expression = serde_json::from_str(&json).unwrap();
    assert_eq!(deser.to_sql_string().unwrap(), "TRUE");

    let expr2 = lit_bool(false);
    let json2 = serde_json::to_string(&expr2).unwrap();
    let deser2: Expression = serde_json::from_str(&json2).unwrap();
    assert_eq!(deser2.to_sql_string().unwrap(), "FALSE");
}

#[test]
fn xor_serialization_roundtrip() {
    let expr = xor(lit_bool(true), lit_bool(false));
    let json = serde_json::to_string(&expr).unwrap();
    let deser: Expression = serde_json::from_str(&json).unwrap();
    assert_eq!(
        deser.to_sql_string().unwrap(),
        expr.to_sql_string().unwrap()
    );
}

#[test]
fn text_func_serialization_roundtrip() {
    let exprs = vec![
        text_fn(TextFunction::Upper, vec![col("name")]),
        text_fn(
            TextFunction::Concatenate,
            vec![col("a"), col("b"), col("c")],
        ),
        text_fn(TextFunction::Mid, vec![col("x"), lit_int(1), lit_int(3)]),
        text_fn(TextFunction::Value, vec![lit_str("42")]),
    ];
    for expr in exprs {
        let json = serde_json::to_string(&expr).unwrap();
        let deser: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(
            deser.to_sql_string().unwrap(),
            expr.to_sql_string().unwrap()
        );
    }
}

#[test]
fn window_serialization_roundtrip() {
    let w = window_expr(
        agg(AggregateOp::Sum, qualified_col("fact", "amount")),
        AggregateOp::Sum,
        vec![("dim_date".into(), "month".into())],
        vec![("dim_product".into(), "cat".into())],
        Some(WindowFrame {
            from: -2,
            from_type: BoundaryType::Rel,
            to: 0,
            to_type: BoundaryType::Rel,
        }),
    );
    let json = serde_json::to_string(&w).unwrap();
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    if let Expression::Window {
        function,
        order_by,
        partition_by,
        frame,
        ..
    } = &deserialized
    {
        assert_eq!(*function, AggregateOp::Sum);
        assert_eq!(order_by.len(), 1);
        assert_eq!(partition_by.len(), 1);
        let f = frame.as_ref().unwrap();
        assert_eq!(f.from, -2);
    } else {
        panic!("expected Window after deserialization");
    }
}

#[test]
fn to_date_serialization_roundtrip() {
    let ytd = to_date(
        agg(AggregateOp::Sum, qualified_col("fact", "amount")),
        DateGranularity::Year,
    );
    let json = serde_json::to_string(&ytd).unwrap();
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    if let Expression::ToDate { expr, granularity } = &deserialized {
        assert_eq!(*granularity, DateGranularity::Year);
        assert!(matches!(expr.as_ref(), Expression::Aggregate { .. }));
    } else {
        panic!("expected ToDate after deserialization");
    }
}

#[test]
fn period_shift_serialization_roundtrip() {
    let shift = period_shift(
        agg(AggregateOp::Sum, qualified_col("fact", "amount")),
        -1,
        DateGranularity::Quarter,
    );
    let json = serde_json::to_string(&shift).unwrap();
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    if let Expression::PeriodShift {
        offset,
        granularity,
        ..
    } = &deserialized
    {
        assert_eq!(*offset, -1);
        assert_eq!(*granularity, DateGranularity::Quarter);
    } else {
        panic!("expected PeriodShift after deserialization");
    }
}

#[test]
fn call_serialization_roundtrip() {
    let expr = agg(
        AggregateOp::Sum,
        call("double", vec![qualified_col("fact_sales", "amount")]),
    );
    let json = serde_json::to_string(&expr).unwrap();
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    if let Expression::Aggregate { operand, .. } = &deserialized {
        if let Expression::Call { name, args } = operand.as_ref() {
            assert_eq!(name, "double");
            assert_eq!(args.len(), 1);
        } else {
            panic!("expected Call operand after deserialization");
        }
    } else {
        panic!("expected Aggregate after deserialization");
    }
    assert_eq!(
        deserialized.to_sql_string().unwrap(),
        "SUM(double(\"amount\"))"
    );
}

#[test]
fn call_deserialized_hostile_name_rejected_by_validate() {
    // A hand-written model file can contain any name — validate() is the gate.
    let json = r#"{"Call":{"name":"evil\"name","args":[]}}"#;
    let deserialized: Expression = serde_json::from_str(json).unwrap();
    assert!(deserialized.validate().is_err());
}

// --- SelectedMeasure (calculation-item placeholder) ---

#[test]
fn selected_measure_serialization_roundtrip() {
    let expr = Expression::SelectedMeasure;
    let json = serde_json::to_string(&expr).unwrap();
    assert_eq!(json, "\"SelectedMeasure\"");
    let deserialized: Expression = serde_json::from_str(&json).unwrap();
    assert!(matches!(deserialized, Expression::SelectedMeasure));
}

#[test]
fn substitute_selected_measure_replaces_all_occurrences() {
    // YoY% pattern: SELECTEDMEASURE() appears three times.
    let item = safe_divide(
        Expression::SelectedMeasure.subtract(Expression::SelectedMeasure),
        Expression::SelectedMeasure,
        None,
    );
    let replacement = agg(AggregateOp::Sum, qualified_col("Sales", "amount"));
    let info = SelectedMeasureInfo {
        expression: &replacement,
        name: "Revenue",
        format_string: Some("#,0"),
    };
    let substituted = item.substitute_selected_measure(&info);

    // No SelectedMeasure node survives anywhere in the tree.
    assert!(!format!("{substituted:?}").contains("SelectedMeasure"));
    // It renders (proving every placeholder was replaced with the aggregate).
    let sql = substituted.to_sql_string().unwrap();
    assert!(sql.contains("SUM(\"amount\")"));
    // validate() now passes (no placeholder left), confirming all three
    // occurrences were substituted.
    assert!(substituted.validate().is_ok());
}

#[test]
fn substitute_folds_calc_group_introspection_family() {
    // IF(ISSELECTEDMEASURE([Revenue], [Cost]),
    //    SELECTEDMEASURENAME(), SELECTEDMEASUREFORMATSTRING())
    let item = if_expr(
        Expression::IsSelectedMeasure {
            measures: vec!["Revenue".into(), "Cost".into()],
        },
        Expression::SelectedMeasureName,
        Expression::SelectedMeasureFormatString,
    );
    let replacement = agg(AggregateOp::Sum, qualified_col("Sales", "amount"));

    // Applied to "Revenue" (in the list, format "#,0"):
    let info = SelectedMeasureInfo {
        expression: &replacement,
        name: "Revenue",
        format_string: Some("#,0"),
    };
    let substituted = item.substitute_selected_measure(&info);
    match &substituted {
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            assert!(matches!(**condition, Expression::LiteralBool(true)));
            assert!(
                matches!(&**then_expr, Expression::LiteralString(s) if s == "Revenue"),
                "SELECTEDMEASURENAME() must fold to the applied measure's name"
            );
            assert!(
                matches!(&**else_expr, Expression::LiteralString(s) if s == "#,0"),
                "SELECTEDMEASUREFORMATSTRING() must fold to the measure's format"
            );
        }
        other => panic!("expected If, got {other:?}"),
    }

    // Applied to "Margin" (NOT in the list, no format string):
    let info = SelectedMeasureInfo {
        expression: &replacement,
        name: "Margin",
        format_string: None,
    };
    let substituted = item.substitute_selected_measure(&info);
    match &substituted {
        Expression::If {
            condition,
            else_expr,
            ..
        } => {
            assert!(matches!(**condition, Expression::LiteralBool(false)));
            assert!(
                matches!(**else_expr, Expression::Blank),
                "SELECTEDMEASUREFORMATSTRING() folds to BLANK without a format"
            );
        }
        other => panic!("expected If, got {other:?}"),
    }
}

#[test]
fn is_selected_measure_matching_is_exact_case_sensitive() {
    let item = Expression::IsSelectedMeasure {
        measures: vec!["Revenue".into()],
    };
    let replacement = agg(AggregateOp::Sum, qualified_col("Sales", "amount"));
    let info = SelectedMeasureInfo {
        expression: &replacement,
        name: "REVENUE",
        format_string: None,
    };
    // Measure lookup is exact/case-sensitive throughout the engine; the fold
    // uses the same matching.
    assert!(matches!(
        item.substitute_selected_measure(&info),
        Expression::LiteralBool(false)
    ));
}

#[test]
fn validate_rejects_introspection_family_in_regular_measure() {
    for expr in [
        Expression::IsSelectedMeasure {
            measures: vec!["Revenue".into()],
        },
        Expression::SelectedMeasureName,
        Expression::SelectedMeasureFormatString,
    ] {
        let err = agg(AggregateOp::Sum, qualified_col("Sales", "amount"))
            .add(expr.clone())
            .validate()
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("calculation item"),
            "expected calc-item-only error, got: {err}"
        );
        assert!(expr.validate_calc_item().is_ok());
    }
}

#[test]
fn measure_references_include_isselectedmeasure_arguments() {
    let expr = Expression::IsSelectedMeasure {
        measures: vec!["Revenue".into(), "Cost".into()],
    };
    assert_eq!(expr.measure_references(), vec!["Cost", "Revenue"]);
}

#[test]
fn validate_rejects_selected_measure_in_regular_measure() {
    let expr = agg(AggregateOp::Sum, Expression::SelectedMeasure);
    let err = expr.validate().unwrap_err().to_string();
    assert!(err.contains("SELECTEDMEASURE"), "got: {err}");
}

#[test]
fn validate_calc_item_allows_selected_measure() {
    // Bare placeholder and nested-in-aggregate both pass validate_calc_item.
    assert!(Expression::SelectedMeasure.validate_calc_item().is_ok());
    let nested = agg(AggregateOp::Sum, Expression::SelectedMeasure).multiply(lit_int(2));
    assert!(nested.validate_calc_item().is_ok());
}

#[test]
fn render_errors_on_unsubstituted_selected_measure() {
    let err = Expression::SelectedMeasure.to_sql_string().unwrap_err();
    assert!(matches!(err, EngineError::InvalidExpression(_)));
    let err2 = Expression::SelectedMeasure
        .multiply(lit_int(2))
        .to_sql_string()
        .unwrap_err();
    assert!(matches!(err2, EngineError::InvalidExpression(_)));
}
