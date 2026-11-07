//! Row-level security stays STRICT on BLANK (owner decision BUG-0759,
//! 2026-11-06), on every route a role filter reaches.
//!
//! A role filter never admits a row whose filtered column is BLANK: `= 0`,
//! `<> 5`, `< 1` and `= ""` all exclude the BLANK rows. This is a deliberate,
//! documented difference from Power BI, whose role filters are DAX and compare
//! BLANK as 0 / "" ("All comparison operators except == treat BLANK as equal
//! to number 0, empty string ""...", Microsoft, *DAX operators*) -- there
//! `[tenant] = 0` would also show the BLANK-tenant rows. A security filter
//! must never widen what a role sees because a key is missing. The role path
//! is separate from the KEEP renderers (`engine_query::security_filter`), so a
//! change to KEEP's BLANK reading cannot reach it; these tests pin the result.
//!
//! Fixture. `Sales(tenant, code, amount)`:
//!
//! | tenant | code  | amount |
//! |--------|-------|--------|
//! | 0      | a     | 1      |
//! | BLANK  | BLANK | 10     |
//! | 5      | ""    | 100    |
//! | 2      | b     | 1000   |
//!
//! `Tenant(id, name)` -> 0 Zero, 2 Two, 5 Five (Sales many-to-one), and a
//! second fact `Budget(tenant, b)` -> Tenant: (0, 7), (5, 70).
//! The Power BI answers that strict RLS deliberately does NOT give are noted
//! beside each case.

#![cfg(test)]

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Column, ColumnRef, ComparisonOp, DataModel, DataType, DetailRequest, Engine,
    QueryRequest, Relationship, SecurityRole, SourceBinding, StorageMode, Table,
};

/// (role, table, column, operator, value, Revenue under the role).
const ROLES: &[(&str, &str, &str, ComparisonOp, &str, f64)] = &[
    // Power BI: 11 (the BLANK tenant equals 0).
    ("TenantZero", "Sales", "tenant", ComparisonOp::Equal, "0", 1.0),
    // Power BI: 1011 (BLANK <> 5).
    ("NotFive", "Sales", "tenant", ComparisonOp::NotEqual, "5", 1001.0),
    // Power BI: 11 (BLANK < 1).
    ("BelowOne", "Sales", "tenant", ComparisonOp::LessThan, "1", 1.0),
    // Power BI: 110 (BLANK = "").
    ("EmptyCode", "Sales", "code", ComparisonOp::Equal, "", 100.0),
    // On the DIMENSION: the BLANK-keyed sale belongs to no tenant row, so a
    // tenant filter never reaches it (Power BI: its blank row has id BLANK,
    // which `= 0` admits: 11).
    ("DimZero", "Tenant", "id", ComparisonOp::Equal, "0", 1.0),
    ("DimNotFive", "Tenant", "id", ComparisonOp::NotEqual, "5", 1001.0),
];

fn table(name: &str, columns: Vec<Column>) -> Table {
    Table::new(name, columns)
        .unwrap()
        .with_storage_mode(StorageMode::InMemory)
}

fn model() -> DataModel {
    let mut builder = DataModel::builder()
        .add_table(table(
            "Sales",
            vec![
                Column::new("tenant", DataType::Int64),
                Column::new("code", DataType::String),
                Column::new("amount", DataType::Float64),
            ],
        ))
        .add_table(table(
            "Tenant",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
            ],
        ))
        .add_table(table(
            "Budget",
            vec![
                Column::new("tenant", DataType::Int64),
                Column::new("b", DataType::Float64),
            ],
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Tenant",
            "Sales",
            "tenant",
            "Tenant",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Budget_Tenant",
            "Budget",
            "tenant",
            "Tenant",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(sum_measure("Plan", "Budget", "b"));
    for (role, t, c, op, v, _) in ROLES {
        builder = builder.add_security_role(SecurityRole::new(*role).with_filter(*t, *c, *op, *v));
    }
    builder.build().unwrap()
}

fn engine(role: &str) -> Engine {
    let mut e = Engine::new(model());
    for t in ["Sales", "Tenant", "Budget"] {
        e.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    let batch = |fields: Vec<Field>, columns: Vec<Arc<dyn Array>>| {
        RecordBatch::try_new(Arc::new(Schema::new(fields)), columns).unwrap()
    };
    e.cache
        .store(
            "Sales",
            batch(
                vec![
                    Field::new("tenant", ArrowType::Int64, true),
                    Field::new("code", ArrowType::Utf8, true),
                    Field::new("amount", ArrowType::Float64, true),
                ],
                vec![
                    Arc::new(Int64Array::from(vec![Some(0), None, Some(5), Some(2)])),
                    Arc::new(StringArray::from(vec![Some("a"), None, Some(""), Some("b")])),
                    Arc::new(Float64Array::from(vec![1.0, 10.0, 100.0, 1000.0])),
                ],
            ),
        )
        .unwrap();
    e.cache
        .store(
            "Tenant",
            batch(
                vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("name", ArrowType::Utf8, true),
                ],
                vec![
                    Arc::new(Int64Array::from(vec![0, 2, 5])),
                    Arc::new(StringArray::from(vec!["Zero", "Two", "Five"])),
                ],
            ),
        )
        .unwrap();
    e.cache
        .store(
            "Budget",
            batch(
                vec![
                    Field::new("tenant", ArrowType::Int64, true),
                    Field::new("b", ArrowType::Float64, true),
                ],
                vec![
                    Arc::new(Int64Array::from(vec![0, 5])),
                    Arc::new(Float64Array::from(vec![7.0, 70.0])),
                ],
            ),
        )
        .unwrap();
    e.set_active_role(Some(role.to_string()));
    e
}

fn as_f64(column: &dyn Array, row: usize) -> Option<f64> {
    if column.is_null(row) {
        return None;
    }
    let cast = arrow::compute::cast(&column.slice(row, 1), &ArrowType::Float64).unwrap();
    Some(cast.as_any().downcast_ref::<Float64Array>().unwrap().value(0))
}

/// The sum of `measure` over every result row (a grouped result's groups
/// add up to the total a role sees: no group is BLANK-keyed here).
fn total(batches: &[RecordBatch], measure: &str) -> f64 {
    let mut sum = 0.0;
    for b in batches {
        let col = b.column(b.schema().index_of(measure).unwrap());
        for row in 0..b.num_rows() {
            sum += as_f64(col.as_ref(), row).unwrap_or(0.0);
        }
    }
    sum
}

async fn revenue(e: &Engine, group_by: Vec<ColumnRef>, extra: &[&str]) -> Vec<RecordBatch> {
    let mut measures = vec!["Revenue".to_string()];
    measures.extend(extra.iter().map(|m| m.to_string()));
    e.query(QueryRequest {
        measures,
        group_by,
        ..Default::default()
    })
    .await
    .unwrap()
}

/// Ungrouped, grouped by a fact column, grouped by the dimension, and beside
/// a second fact's measure (the multi-fact route): the BLANK rows never count.
#[tokio::test]
async fn a_role_filter_never_admits_a_blank_row_in_an_aggregate() {
    for (role, _, _, _, _, want) in ROLES {
        let e = engine(role);
        let got = revenue(&e, vec![], &[]).await;
        assert_eq!(total(&got, "Revenue"), *want, "{role}: ungrouped");
        let got = revenue(&e, vec![ColumnRef::new("Sales", "code")], &[]).await;
        assert_eq!(total(&got, "Revenue"), *want, "{role}: by Sales[code]");
        let got = revenue(&e, vec![ColumnRef::new("Tenant", "name")], &[]).await;
        assert_eq!(total(&got, "Revenue"), *want, "{role}: by Tenant[name]");
        let got = revenue(&e, vec![], &["Plan"]).await;
        assert_eq!(total(&got, "Revenue"), *want, "{role}: beside Plan");
    }
}

/// The drill-through (detail rows) under each role: the BLANK row is never
/// one of them.
#[tokio::test]
async fn a_role_filter_never_admits_a_blank_row_in_a_drill_through() {
    for (role, _, _, _, _, want) in ROLES {
        let e = engine(role);
        let rows = e.query_rows(DetailRequest::new("Sales", 100)).await.unwrap();
        let mut sum = 0.0;
        for b in &rows {
            let col = b.column(b.schema().index_of("amount").unwrap());
            for row in 0..b.num_rows() {
                sum += as_f64(col.as_ref(), row).unwrap_or(0.0);
            }
        }
        assert_eq!(sum, *want, "{role}: drill-through rows");
    }
}
