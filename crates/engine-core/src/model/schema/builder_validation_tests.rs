//! Build-time validation tests: context name collisions, expression AST
//! validation (step 0b), lookup-resolution expressions (step 1c), global
//! variables, and sort-by columns.

use super::test_fixtures::*;
use super::*;
use crate::model::column::Column;
use crate::types::DataType;

// --- Context name collision tests ---

#[test]
fn rejects_context_name_collision_with_table() {
    use crate::model::context::{ContextDefinition, ContextOp};

    let ctx = ContextDefinition::new("Sales", vec![ContextOp::Reset]);

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_context(ctx)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with table"));
}

#[test]
fn rejects_table_variable_name_collision_with_context() {
    use crate::model::context::{ContextDefinition, ContextOp};

    let ctx = ContextDefinition::new("my_ctx", vec![ContextOp::Reset]);
    let var = TableVariable::new("my_ctx", "Products", vec![]);

    let result = DataModel::builder()
        .add_table(products_table())
        .add_context(ctx)
        .add_table_variable(var)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with context"));
}

#[test]
fn accepts_context_with_unique_name() {
    use crate::compute::expression::{ComparisonOp, FilterPredicate};
    use crate::model::context::{ContextDefinition, ContextOp};

    let ctx = ContextDefinition::new(
        "ctx_us",
        vec![ContextOp::Keep(vec![FilterPredicate::new(
            "Sales",
            "region",
            ComparisonOp::Equal,
            "US",
        )])],
    );

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_context(ctx)
        .build()
        .unwrap();

    assert_eq!(model.contexts().len(), 1);
}

#[test]
fn validate_catches_invalid_deserialized_model() {
    // Build a valid model, serialize it, tamper with JSON, deserialize.
    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(sales_products_relationship())
        .build()
        .unwrap();

    let mut json: serde_json::Value = serde_json::to_value(&model).unwrap();
    // Remove the Products table so the relationship becomes invalid.
    let tables = json["tables"].as_array_mut().unwrap();
    tables.retain(|t| t["name"] != "Products");

    let tampered: DataModel = serde_json::from_value(json).unwrap();
    assert!(tampered.validate().is_err());
}

// --- Expression AST validation (step 0b) tests ---

/// JSON for a measure whose expression carries a DATE_TRUNC interval.
/// Hand-constructed (not produced by the parser) to emulate a hostile
/// or tampered model file.
fn date_trunc_measure_json(interval: &str) -> String {
    format!(
        r#"{{
            "name": "FirstOfMonth",
            "expression": {{
                "Aggregate": {{
                    "operation": "Max",
                    "operand": {{
                        "DateTimeFunc": {{
                            "function": "DateTrunc",
                            "args": [
                                {{"QualifiedColumnRef": {{"table_or_var": "Sales", "column": "amount"}}}},
                                {{"LiteralString": "{interval}"}}
                            ]
                        }}
                    }}
                }}
            }}
        }}"#
    )
}

#[test]
fn build_rejects_deserialized_measure_with_hostile_interval() {
    // The custom Measure Deserialize accepts any Expression tree —
    // the parser's interval allow-list is bypassed entirely.
    let measure: Measure =
        serde_json::from_str(&date_trunc_measure_json("MONTH'); DROP TABLE x; --")).unwrap();

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_measure(measure)
        .build();

    let err = result.unwrap_err().to_string();
    assert!(err.contains("invalid interval"), "got: {err}");
}

#[test]
fn build_accepts_deserialized_measure_with_benign_interval() {
    let measure: Measure = serde_json::from_str(&date_trunc_measure_json("MONTH")).unwrap();

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_measure(measure)
        .build()
        .unwrap();
    assert_eq!(model.measures().len(), 1);
}

#[test]
fn validate_rejects_full_model_json_with_hostile_interval() {
    // Round-trip a valid model through JSON, splice in a hostile
    // measure, and confirm DataModel::validate() (which delegates to
    // build()) rejects it.
    let model = DataModel::builder()
        .add_table(sales_table())
        .build()
        .unwrap();

    let mut json: serde_json::Value = serde_json::to_value(&model).unwrap();
    let hostile: serde_json::Value =
        serde_json::from_str(&date_trunc_measure_json("MONTH'); DROP TABLE x; --")).unwrap();
    json["measures"].as_array_mut().unwrap().push(hostile);

    let tampered: DataModel = serde_json::from_value(json).unwrap();
    let err = tampered.validate().unwrap_err().to_string();
    assert!(err.contains("invalid interval"), "got: {err}");
}

#[test]
fn build_rejects_context_filter_with_hostile_table() {
    use crate::compute::expression::{ComparisonOp, FilterPredicate};
    use crate::model::context::ContextOp;

    let ctx = ContextDefinition::new(
        "ctx_evil",
        vec![ContextOp::Keep(vec![FilterPredicate::new(
            "dim\" ON 1=1; --",
            "year",
            ComparisonOp::Equal,
            "2014",
        )])],
    );

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_context(ctx)
        .build();
    assert!(result.is_err());
}

#[test]
fn build_rejects_table_variable_filter_with_hostile_table() {
    use crate::compute::expression::{ComparisonOp, FilterPredicate};

    let tv = TableVariable::new(
        "evil_var",
        "Sales",
        vec![FilterPredicate::new(
            "Sales'; DROP TABLE x; --",
            "region",
            ComparisonOp::Equal,
            "US",
        )],
    );

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_table_variable(tv)
        .build();
    assert!(result.is_err());
}

// --- Lookup resolution validation (step 1c) tests ---

#[test]
fn build_rejects_model_default_lookup_without_placeholder() {
    let result = DataModel::builder()
        .add_table(sales_table())
        .default_lookup_resolution("MAX(category_name)")
        .build();

    let err = result.unwrap_err().to_string();
    assert!(err.contains("__column"), "got: {err}");
}

#[test]
fn build_rejects_unparseable_model_default_lookup() {
    let result = DataModel::builder()
        .add_table(sales_table())
        .default_lookup_resolution("MAX(")
        .build();

    let err = result.unwrap_err().to_string();
    assert!(err.contains("does not parse"), "got: {err}");
}

#[test]
fn build_accepts_model_default_lookup_with_placeholder() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .default_lookup_resolution("MAX(__column)")
        .build()
        .unwrap();
    assert_eq!(model.default_lookup_resolution(), Some("MAX(__column)"));
}

#[test]
fn build_rejects_unparseable_column_lookup_resolution() {
    let table = Table::new(
        "Products",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("name", DataType::String).with_lookup_resolution("MIN(name"),
        ],
    )
    .unwrap();

    let result = DataModel::builder().add_table(table).build();
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("lookup_resolution does not parse"),
        "got: {err}"
    );
}

// --- Global variable tests ---

#[test]
fn global_variable_added_to_model() {
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::expression as expr;
    use crate::model::global_variable::GlobalVariable;

    let gv = GlobalVariable::new(
        "total_revenue",
        "Sales",
        expr::agg(AggregateOp::Sum, expr::col("amount")),
    );

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_global_variable(gv)
        .build()
        .unwrap();

    assert_eq!(model.global_variables().len(), 1);
    assert!(model.global_variable("total_revenue").is_ok());
    assert!(model.global_variable("missing").is_err());
}

#[test]
fn rejects_duplicate_global_variable_names() {
    use crate::compute::expression as expr;
    use crate::model::global_variable::GlobalVariable;

    let g1 = GlobalVariable::new("gv", "Sales", expr::col("amount"));
    let g2 = GlobalVariable::new("gv", "Sales", expr::col("id"));

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_global_variable(g1)
        .add_global_variable(g2)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Duplicate"));
    assert!(err.contains("gv"));
}

#[test]
fn rejects_global_variable_name_collision_with_table() {
    use crate::compute::expression as expr;
    use crate::model::global_variable::GlobalVariable;

    let gv = GlobalVariable::new("Sales", "Sales", expr::col("amount"));

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_global_variable(gv)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with table"));
}

#[test]
fn rejects_global_variable_name_collision_with_context() {
    use crate::compute::expression as expr;
    use crate::model::context::{ContextDefinition, ContextOp};
    use crate::model::global_variable::GlobalVariable;

    let ctx = ContextDefinition::new("my_ctx", vec![ContextOp::Reset]);
    let gv = GlobalVariable::new("my_ctx", "Sales", expr::col("amount"));

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_context(ctx)
        .add_global_variable(gv)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with context"));
}

#[test]
fn rejects_global_variable_with_missing_table() {
    use crate::compute::expression as expr;
    use crate::model::global_variable::GlobalVariable;

    let gv = GlobalVariable::new("gv", "NonExistent", expr::col("x"));

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_global_variable(gv)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("NonExistent"));
}

#[test]
fn serde_backward_compat_no_global_variables() {
    // JSON without global_variables field should deserialize with empty vec.
    let json = r#"{
        "tables": [],
        "relationships": [],
        "measures": [],
        "calculated_columns": [],
        "measure_groups": []
    }"#;
    let model: DataModel = serde_json::from_str(json).unwrap();
    assert!(model.global_variables().is_empty());
}

#[test]
fn global_variable_json_roundtrip() {
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::expression as expr;
    use crate::model::global_variable::GlobalVariable;

    let gv = GlobalVariable::new(
        "total_revenue",
        "Sales",
        expr::agg(AggregateOp::Sum, expr::col("amount")),
    );

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_global_variable(gv)
        .build()
        .unwrap();

    let json = serde_json::to_string_pretty(&model).unwrap();
    let restored: DataModel = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.global_variables().len(), 1);
    assert_eq!(restored.global_variables()[0].name(), "total_revenue");
    assert!(restored.validate().is_ok());
}

// --- Sort-by column tests ---

#[test]
fn sort_by_column_accepted() {
    let table = Table::new(
        "dim_date",
        vec![
            Column::new("month_number", DataType::Int32),
            Column::new("month_name", DataType::String).with_sort_by("month_number"),
        ],
    )
    .unwrap();

    let model = DataModel::builder().add_table(table).build().unwrap();

    let col = model
        .table("dim_date")
        .unwrap()
        .column("month_name")
        .unwrap();
    assert_eq!(col.sort_by_column(), Some("month_number"));
}

#[test]
fn sort_by_column_missing_target_rejected() {
    let table = Table::new(
        "dim_date",
        vec![Column::new("month_name", DataType::String).with_sort_by("nonexistent")],
    )
    .unwrap();

    let result = DataModel::builder().add_table(table).build();
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("nonexistent"));
    assert!(err.contains("not found"));
}

#[test]
fn sort_by_column_self_reference_rejected() {
    let table = Table::new(
        "dim_date",
        vec![Column::new("month_name", DataType::String).with_sort_by("month_name")],
    )
    .unwrap();

    let result = DataModel::builder().add_table(table).build();
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("sort by itself"));
}

#[test]
fn sort_by_column_circular_rejected() {
    let table = Table::new(
        "dim_date",
        vec![
            Column::new("a", DataType::String).with_sort_by("b"),
            Column::new("b", DataType::String).with_sort_by("a"),
        ],
    )
    .unwrap();

    let result = DataModel::builder().add_table(table).build();
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("circular"));
}

#[test]
fn sort_column_for_returns_sort_column() {
    let table = Table::new(
        "dim_date",
        vec![
            Column::new("month_number", DataType::Int32),
            Column::new("month_name", DataType::String).with_sort_by("month_number"),
        ],
    )
    .unwrap();

    let model = DataModel::builder().add_table(table).build().unwrap();

    // Column with sort_by returns the sort column.
    assert_eq!(
        model.sort_column_for("dim_date", "month_name").unwrap(),
        "month_number"
    );
    // Column without sort_by returns itself.
    assert_eq!(
        model.sort_column_for("dim_date", "month_number").unwrap(),
        "month_number"
    );
}

#[test]
fn sort_by_column_serde_roundtrip() {
    let table = Table::new(
        "dim_date",
        vec![
            Column::new("month_number", DataType::Int32),
            Column::new("month_name", DataType::String).with_sort_by("month_number"),
        ],
    )
    .unwrap();

    let model = DataModel::builder().add_table(table).build().unwrap();
    let json = serde_json::to_string_pretty(&model).unwrap();
    assert!(json.contains("sort_by_column"));
    assert!(json.contains("month_number"));

    let restored: DataModel = serde_json::from_str(&json).unwrap();
    let col = restored
        .table("dim_date")
        .unwrap()
        .column("month_name")
        .unwrap();
    assert_eq!(col.sort_by_column(), Some("month_number"));
    assert!(restored.validate().is_ok());
}

#[test]
fn sort_by_column_omitted_from_json_when_none() {
    let table = Table::new("t", vec![Column::new("a", DataType::Int32)]).unwrap();

    let model = DataModel::builder().add_table(table).build().unwrap();
    let json = serde_json::to_string(&model).unwrap();
    assert!(!json.contains("sort_by_column"));
}

// --- Date table validation tests (step 11) ---

#[test]
fn rejects_date_table_that_does_not_exist() {
    use crate::error::EngineError;

    let result = DataModel::builder()
        .add_table(sales_table())
        .mark_date_table("dim_date")
        .build();

    let err = result.unwrap_err();
    assert!(matches!(err, EngineError::InvalidDateTable { .. }));
    assert!(err.to_string().contains("not found"));
}

#[test]
fn rejects_duplicate_date_roles_on_date_table() {
    use crate::model::column::DateRole;

    let dim_date = crate::model::table::Table::new(
        "dim_date",
        vec![
            Column::new("year", DataType::Int32).with_date_role(DateRole::Year),
            Column::new("fiscal_year", DataType::Int32).with_date_role(DateRole::Year),
        ],
    )
    .unwrap();

    let result = DataModel::builder()
        .add_table(dim_date)
        .mark_date_table("dim_date")
        .build();

    let err = result.unwrap_err().to_string();
    assert!(err.contains("Year"), "got: {err}");
    assert!(err.contains("multiple columns"), "got: {err}");
}

#[test]
fn rejects_date_key_role_on_non_date_column() {
    use crate::model::column::DateRole;

    let dim_date = crate::model::table::Table::new(
        "dim_date",
        vec![Column::new("datekey", DataType::Int32).with_date_role(DateRole::DateKey)],
    )
    .unwrap();

    let result = DataModel::builder()
        .add_table(dim_date)
        .mark_date_table("dim_date")
        .build();

    let err = result.unwrap_err().to_string();
    assert!(err.contains("DateKey"), "got: {err}");
    assert!(err.contains("Date or Timestamp"), "got: {err}");
}

#[test]
fn rejects_part_role_on_float_column() {
    use crate::model::column::DateRole;

    let dim_date = crate::model::table::Table::new(
        "dim_date",
        vec![Column::new("month", DataType::Float64).with_date_role(DateRole::Month)],
    )
    .unwrap();

    let result = DataModel::builder()
        .add_table(dim_date)
        .mark_date_table("dim_date")
        .build();

    let err = result.unwrap_err().to_string();
    assert!(err.contains("Month"), "got: {err}");
    assert!(err.contains("integer or string"), "got: {err}");
}

#[test]
fn accepts_valid_date_table_and_round_trips_through_serde() {
    use crate::model::column::DateRole;

    let dim_date = crate::model::table::Table::new(
        "dim_date",
        vec![
            Column::new("datekey", DataType::Date).with_date_role(DateRole::DateKey),
            Column::new("year", DataType::Int32).with_date_role(DateRole::Year),
            // String part columns are lenient by design ("Q1"-style labels).
            Column::new("quarter", DataType::String).with_date_role(DateRole::Quarter),
            Column::new("month", DataType::Int64).with_date_role(DateRole::Month),
            // Role-less display column is fine on the date table.
            Column::new("month_name", DataType::String),
        ],
    )
    .unwrap();

    let model = DataModel::builder()
        .add_table(dim_date)
        .mark_date_table("dim_date")
        .build()
        .unwrap();
    assert_eq!(model.date_table(), Some("dim_date"));

    let json = serde_json::to_string(&model).unwrap();
    assert!(json.contains("\"date_table\""));
    let restored: DataModel = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.date_table(), Some("dim_date"));
    restored.validate().unwrap();
    let year = restored.table("dim_date").unwrap().column("year").unwrap();
    assert_eq!(year.date_role(), Some(DateRole::Year));
}

#[test]
fn unmarked_model_omits_date_table_from_json() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .build()
        .unwrap();
    assert_eq!(model.date_table(), None);
    let json = serde_json::to_string(&model).unwrap();
    assert!(!json.contains("\"date_table\""));
}

#[test]
fn date_roles_on_unmarked_tables_are_not_validated() {
    use crate::model::column::DateRole;

    // Duplicate roles + bad types, but the table is NOT marked as the date
    // table — roles are inert metadata until the table is marked.
    let table = crate::model::table::Table::new(
        "some_dim",
        vec![
            Column::new("a", DataType::Float64).with_date_role(DateRole::Year),
            Column::new("b", DataType::Float64).with_date_role(DateRole::Year),
        ],
    )
    .unwrap();

    DataModel::builder().add_table(table).build().unwrap();
}
