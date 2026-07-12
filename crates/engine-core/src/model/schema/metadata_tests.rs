//! Builder validation tests for presentation metadata (display names,
//! descriptions, format strings, hidden flags, default aggregation).

use super::*;
use crate::compute::aggregate::AggregateOp;
use crate::compute::measure::sum_measure;
use crate::model::column::Column;
use crate::model::table::Table;
use crate::types::DataType;

fn sales_table_with_metadata() -> Table {
    Table::new(
        "fact_sales",
        vec![
            Column::new("id", DataType::Int64).hidden(),
            Column::new("amount", DataType::Float64)
                .with_display_name("Amount")
                .with_description("Sale amount in USD")
                .with_default_aggregation(AggregateOp::Sum),
        ],
    )
    .unwrap()
    .with_display_name("Sales")
    .with_description("One row per order line")
}

#[test]
fn model_format_version_is_current() {
    // Version 2 introduced presentation metadata (measure format_string/
    // description/is_hidden, column display_name/description/is_hidden/
    // default_aggregation, table display_name/description/is_hidden).
    // Version 3 introduced time-intelligence metadata (column date_role,
    // model date_table, ToDate/PeriodShift expression variants).
    // Version 4 introduced sandboxed script functions (model script_functions).
    // Version 5 introduced row-level security (model security_roles).
    // Version 6 introduced incremental refresh (table incremental_refresh).
    // Version 7 introduced calculation groups (model calculation_groups,
    // SelectedMeasure expression variant).
    // Version 8 introduced the DATESINPERIOD trailing-window time-intelligence
    // function (DatesInPeriod expression variant).
    // Version 9 introduced semi-additive balances CLOSINGBALANCE/OPENINGBALANCE
    // (SemiAdditiveBalance expression variant). v10 added KPIs; v11 added the
    // dynamic-RLS predicate field; v12 added context-driven calculated columns;
    // v13 added query-scoped (GVAR) variables (Block query_scoped_bindings);
    // v14 added persisted multi-source bindings (model sources catalog + table
    // source_binding) and finalized the model metadata fields; v15 added
    // materialized calculated tables (GlobalVariable dynamic flag + derived
    // Table is_calculated marker, calendar spec, DISTINCT queries); v16 added
    // the IsFiltered expression variant (ISFILTERED direct-filter check);
    // v17 added the LookupValue variant (LOOKUPVALUE in calculated columns)
    // and cross-table calculated-column references; v18 added the measure
    // format_string_expression (dynamic format strings); v19 added the
    // DAX-gap batch (PATH calculated columns + PATHLENGTH/PATHITEM, measure
    // detail_rows, security-role OLS denials, perspectives); v20 added the
    // second DAX-gap batch (THISROW anchor rows, DATESBETWEEN, Week
    // granularity/WTD, fiscal_year_end_month, cultures/translations).
    // If you bump the constant, extend the version history in `mod.rs`
    // and update this pin deliberately.
    assert_eq!(MODEL_FORMAT_VERSION, 20);
}

#[test]
fn build_accepts_valid_presentation_metadata() {
    let model = DataModel::builder()
        .add_table(sales_table_with_metadata())
        .add_measure(
            sum_measure("Revenue", "fact_sales", "amount")
                .with_format_string("#,##0.00")
                .with_description("Total sales amount")
                .hidden(),
        )
        .build()
        .unwrap();

    let table = model.table("fact_sales").unwrap();
    assert_eq!(table.display_name(), Some("Sales"));
    assert!(!table.is_hidden());
    let amount = table.column("amount").unwrap();
    assert_eq!(amount.default_aggregation(), Some(AggregateOp::Sum));
    let measure = model.measure("Revenue").unwrap();
    assert_eq!(measure.format_string(), Some("#,##0.00"));
    assert!(measure.is_hidden());
}

#[test]
fn model_with_metadata_round_trips_through_json() {
    let model = DataModel::builder()
        .add_table(sales_table_with_metadata())
        .add_measure(
            sum_measure("Revenue", "fact_sales", "amount")
                .with_format_string("0.0%")
                .with_description("Revenue share")
                .hidden(),
        )
        .build()
        .unwrap();

    let json = serde_json::to_string(&model).unwrap();
    let restored: DataModel = serde_json::from_str(&json).unwrap();
    restored.validate().unwrap();

    let table = restored.table("fact_sales").unwrap();
    assert_eq!(table.display_name(), Some("Sales"));
    assert_eq!(table.description(), Some("One row per order line"));
    assert!(table.column("id").unwrap().is_hidden());
    let amount = table.column("amount").unwrap();
    assert_eq!(amount.display_name(), Some("Amount"));
    assert_eq!(amount.description(), Some("Sale amount in USD"));
    assert_eq!(amount.default_aggregation(), Some(AggregateOp::Sum));
    let measure = restored.measure("Revenue").unwrap();
    assert_eq!(measure.format_string(), Some("0.0%"));
    assert_eq!(measure.description(), Some("Revenue share"));
    assert!(measure.is_hidden());
}

#[test]
fn build_accepts_format_string_at_length_cap() {
    let result = DataModel::builder()
        .add_table(sales_table_with_metadata())
        .add_measure(
            sum_measure("Revenue", "fact_sales", "amount").with_format_string("#".repeat(256)),
        )
        .build();
    assert!(result.is_ok());
}

#[test]
fn build_rejects_over_cap_format_string() {
    let result = DataModel::builder()
        .add_table(sales_table_with_metadata())
        .add_measure(
            sum_measure("Revenue", "fact_sales", "amount").with_format_string("#".repeat(257)),
        )
        .build();
    assert!(matches!(
        result,
        Err(EngineError::InvalidMetadata { ref entity, ref field, .. })
            if entity == "measure 'Revenue'" && field == "format_string"
    ));
}

#[test]
fn build_rejects_empty_table_display_name() {
    for bad in ["", "   ", "\t"] {
        let table = Table::new("t", vec![Column::new("a", DataType::Int32)])
            .unwrap()
            .with_display_name(bad);
        let result = DataModel::builder().add_table(table).build();
        assert!(
            matches!(
                result,
                Err(EngineError::InvalidMetadata { ref field, .. }) if field == "display_name"
            ),
            "expected rejection of table display_name {bad:?}"
        );
    }
}

#[test]
fn build_rejects_empty_column_display_name() {
    let table = Table::new(
        "t",
        vec![Column::new("a", DataType::Int32).with_display_name("  ")],
    )
    .unwrap();
    let result = DataModel::builder().add_table(table).build();
    assert!(matches!(
        result,
        Err(EngineError::InvalidMetadata { ref entity, ref field, .. })
            if entity == "column 't.a'" && field == "display_name"
    ));
}

#[test]
fn build_rejects_over_cap_display_names() {
    let long = "x".repeat(257);

    let table = Table::new("t", vec![Column::new("a", DataType::Int32)])
        .unwrap()
        .with_display_name(&long);
    assert!(matches!(
        DataModel::builder().add_table(table).build(),
        Err(EngineError::InvalidMetadata { ref field, .. }) if field == "display_name"
    ));

    let table = Table::new(
        "t",
        vec![Column::new("a", DataType::Int32).with_display_name(&long)],
    )
    .unwrap();
    assert!(matches!(
        DataModel::builder().add_table(table).build(),
        Err(EngineError::InvalidMetadata { ref field, .. }) if field == "display_name"
    ));
}

#[test]
fn build_rejects_over_cap_descriptions() {
    let long = "x".repeat(1025);

    // Table description.
    let table = Table::new("t", vec![Column::new("a", DataType::Int32)])
        .unwrap()
        .with_description(&long);
    assert!(matches!(
        DataModel::builder().add_table(table).build(),
        Err(EngineError::InvalidMetadata { ref field, .. }) if field == "description"
    ));

    // Column description.
    let table = Table::new(
        "t",
        vec![Column::new("a", DataType::Int32).with_description(&long)],
    )
    .unwrap();
    assert!(matches!(
        DataModel::builder().add_table(table).build(),
        Err(EngineError::InvalidMetadata { ref field, .. }) if field == "description"
    ));

    // Measure description.
    let result = DataModel::builder()
        .add_table(sales_table_with_metadata())
        .add_measure(sum_measure("Revenue", "fact_sales", "amount").with_description(&long))
        .build();
    assert!(matches!(
        result,
        Err(EngineError::InvalidMetadata { ref entity, ref field, .. })
            if entity == "measure 'Revenue'" && field == "description"
    ));
}

#[test]
fn build_accepts_description_at_length_cap() {
    let table = Table::new("t", vec![Column::new("a", DataType::Int32)])
        .unwrap()
        .with_description("x".repeat(1024));
    assert!(DataModel::builder().add_table(table).build().is_ok());
}

#[test]
fn unicode_metadata_caps_count_characters_not_bytes() {
    // 256 multi-byte characters must pass a 256-character cap even though
    // the byte length exceeds it.
    let display = "ö".repeat(256);
    let table = Table::new("t", vec![Column::new("a", DataType::Int32)])
        .unwrap()
        .with_display_name(display);
    assert!(DataModel::builder().add_table(table).build().is_ok());
}
