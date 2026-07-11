//! Calculated tables: model-level named QUERY expressions reusable across
//! measures (user-facing term: "Calculated Table"; this struct keeps its
//! historical name).
//!
//! A calculated table stores a named table-producing `QUERY(...)` expression
//! at the data model level. Measures reference its output columns directly,
//! and the expression is evaluated dynamically in the referencing query's
//! filter context:
//! ```text
//! GlobalVariable { name: "city_sales", table: "fact_sales",
//!     expression: QUERY(SUM(fact_sales[linetotal]) AS Amount BY dim_customer[city]) }
//!
//! AVG(city_sales[Amount])   -- referenced via QualifiedColumnRef
//! ```
//!
//! Only `Query` expressions are valid; the model builder and [`parse_global`]
//! (crate::compute::parser::parse_global) reject anything else. Scalar
//! globals were removed 2026-07-11: a reusable scalar is a (hidden) measure
//! (see Calcula's docs/design/calculated-tables.md).
//!
//! # Modes
//!
//! A calculated table is either **dynamic** (the default) or **materialized**:
//!
//! - **Dynamic** (`dynamic == true`): virtual — evaluated per query in the
//!   referencing query's live filter context, injected as a VAR binding.
//!   Never a model table; cannot participate in relationships.
//! - **Materialized** (`dynamic == false`): a real, derived model [`Table`]
//!   (marked [`Table::is_calculated`]) is synthesized from the inferred QUERY
//!   output schema at model build/mutation time, and its DATA is produced at
//!   refresh time by evaluating the QUERY over the unfiltered model (no
//!   slicers, no RLS role — same posture as Power BI calculated tables).
//!   Being a real table, it supports relationships (including non-equi),
//!   grouping, hierarchies, and RLS filters like any other table.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::Expression;
use crate::error::{EngineError, EngineResult};
use crate::model::column::Column;
use crate::model::table::Table;
use crate::types::DataType;

fn default_dynamic() -> bool {
    true
}

fn is_true(b: &bool) -> bool {
    *b
}

/// A model-level named `QUERY(...)` expression reusable across measures
/// (a "calculated table").
///
/// Referenced as `name[column]`. Dynamic calculated tables are expanded into
/// referencing measures as a VAR binding in an implicit `Block` before
/// evaluation; materialized ones resolve as real model tables (see the
/// module docs for the mode semantics).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalVariable {
    /// Unique name for this calculated table.
    name: String,
    /// The fact table this calculated table operates on.
    table: String,
    /// The table-producing `Query` expression. Non-`Query` expressions are
    /// representable here (it is plain data) but rejected by validation.
    expression: Expression,
    /// `true` (default) = evaluated per query in the live filter context;
    /// `false` = materialized at refresh into a real model table.
    #[serde(default = "default_dynamic", skip_serializing_if = "is_true")]
    dynamic: bool,
}

impl GlobalVariable {
    /// Create a new calculated table (dynamic by default).
    pub fn new(name: impl Into<String>, table: impl Into<String>, expression: Expression) -> Self {
        Self {
            name: name.into(),
            table: table.into(),
            expression,
            dynamic: true,
        }
    }

    /// Set the mode: `true` (default) = dynamic (per-query, filter-context
    /// evaluation); `false` = materialized at refresh into a real model table.
    pub fn with_dynamic(mut self, dynamic: bool) -> Self {
        self.dynamic = dynamic;
        self
    }

    /// Returns `true` if this calculated table is dynamic (per-query
    /// evaluation), `false` if it is materialized at refresh.
    pub fn is_dynamic(&self) -> bool {
        self.dynamic
    }

    /// Returns the calculated table's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the fact table this calculated table operates on.
    pub fn table(&self) -> &str {
        &self.table
    }

    /// Returns the expression.
    pub fn expression(&self) -> &Expression {
        &self.expression
    }

    /// Returns `true` if the expression is a table-producing `Query` — the
    /// only valid form; validation rejects anything else.
    pub fn is_query(&self) -> bool {
        matches!(self.expression, Expression::Query { .. })
    }
}

/// Infer the output columns of a calculated table's `QUERY(...)` expression:
/// the BY columns (with their source column types) followed by one column per
/// aggregate alias (type from the aggregate's semantics). This is the schema
/// a **materialized** calculated table declares as a model [`Table`] — needed
/// at build time (before any data exists) so relationships can validate
/// against it.
///
/// Errors when the expression is not a `Query`, a BY table/column does not
/// exist in `tables`, or the output column names collide.
pub fn infer_calculated_table_columns(
    gv: &GlobalVariable,
    tables: &[Table],
) -> EngineResult<Vec<Column>> {
    let Expression::Query {
        aggregates,
        group_by,
    } = gv.expression()
    else {
        return Err(EngineError::InvalidGlobalVariable {
            name: gv.name().to_string(),
            reason: "a calculated table must be a table-producing QUERY(...) expression"
                .to_string(),
        });
    };

    let find_column = |table_name: &str, column_name: &str| -> EngineResult<DataType> {
        let table = tables
            .iter()
            .find(|t| t.name() == table_name)
            .ok_or_else(|| EngineError::InvalidGlobalVariable {
                name: gv.name().to_string(),
                reason: format!("references unknown table '{table_name}'"),
            })?;
        let column = table
            .columns()
            .iter()
            .find(|c| c.name() == column_name)
            .ok_or_else(|| EngineError::InvalidGlobalVariable {
                name: gv.name().to_string(),
                reason: format!("references unknown column '{table_name}[{column_name}]'"),
            })?;
        Ok(column.data_type().clone())
    };

    let mut columns = Vec::new();
    for (table_name, column_name) in group_by {
        columns.push(Column::new(
            column_name.clone(),
            find_column(table_name, column_name)?,
        ));
    }
    for (agg_expr, alias) in aggregates {
        columns.push(Column::new(
            alias.clone(),
            infer_aggregate_type(agg_expr, &find_column),
        ));
    }

    // Reuse Table::new's duplicate-column validation for the collision check.
    Table::new(gv.name(), columns.clone()).map_err(|_| EngineError::InvalidGlobalVariable {
        name: gv.name().to_string(),
        reason: "QUERY output column names collide (BY columns and aggregate aliases must be \
                 unique)"
            .to_string(),
    })?;

    Ok(columns)
}

/// The model table names a calculated table's `QUERY(...)` reads from: the
/// BY tables plus every table referenced inside the aggregate expressions
/// (qualified column refs, `COUNTROWS(table)` refs, context-op inner refs).
/// Used to order materialization (a materialized calculated table that reads
/// another one's derived table must materialize after it) and to decide which
/// calculated tables need re-materializing after a source-table refresh.
pub fn calculated_table_dependencies(gv: &GlobalVariable) -> std::collections::HashSet<String> {
    use crate::compute::expression::child_expressions;

    let mut deps = std::collections::HashSet::new();
    let Expression::Query {
        aggregates,
        group_by,
    } = gv.expression()
    else {
        return deps;
    };
    for (table, _) in group_by {
        deps.insert(table.clone());
    }
    let mut stack: Vec<&Expression> = aggregates.iter().map(|(e, _)| e).collect();
    while let Some(expr) = stack.pop() {
        match expr {
            Expression::QualifiedColumnRef { table_or_var, .. } => {
                deps.insert(table_or_var.clone());
            }
            Expression::TableRef(table) | Expression::Iterate { table, .. } => {
                deps.insert(table.clone());
            }
            _ => {}
        }
        stack.extend(child_expressions(expr));
    }
    deps
}

/// Infer the result type of one QUERY aggregate expression. Context-operation
/// wrappers are unwrapped to find the underlying aggregate; unknown shapes
/// fall back to `Float64` (numeric results are the overwhelmingly common
/// case, and materialization casts the computed batch to this schema).
fn infer_aggregate_type(
    expr: &Expression,
    find_column: &dyn Fn(&str, &str) -> EngineResult<DataType>,
) -> DataType {
    match expr {
        // Unwrap context-operation wrappers.
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::ClearExcept { expr, .. }
        | Expression::Reset { expr }
        | Expression::ResetInner { expr }
        | Expression::ResetOuter { expr }
        | Expression::KeepIn { expr, .. }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::UseRelationship { expr, .. } => infer_aggregate_type(expr, find_column),

        Expression::Aggregate { operation, operand } => match operation {
            AggregateOp::Count | AggregateOp::DistinctCount | AggregateOp::CountRows => {
                DataType::Int64
            }
            AggregateOp::Average
            | AggregateOp::Median
            | AggregateOp::StdevSample
            | AggregateOp::StdevPop
            | AggregateOp::VarSample
            | AggregateOp::VarPop => DataType::Float64,
            AggregateOp::Sum
            | AggregateOp::Min
            | AggregateOp::Max
            | AggregateOp::AnyValue
            | AggregateOp::Mode => infer_operand_type(operand, find_column),
        },
        Expression::CountIf { .. } => DataType::Int64,
        Expression::Percentile { .. } => DataType::Float64,
        Expression::ListAgg { .. } => DataType::String,
        Expression::MaxBy { value, .. } | Expression::MinBy { value, .. } => {
            infer_operand_type(value, find_column)
        }
        _ => DataType::Float64,
    }
}

/// Infer the type of an aggregate operand: a qualified column keeps its
/// source type; `ITERATE` recurses into its row expression; anything else
/// (arithmetic, function calls) is numeric and reported as `Float64`.
fn infer_operand_type(
    operand: &Expression,
    find_column: &dyn Fn(&str, &str) -> EngineResult<DataType>,
) -> DataType {
    match operand {
        Expression::QualifiedColumnRef {
            table_or_var,
            column,
        } => find_column(table_or_var, column).unwrap_or(DataType::Float64),
        Expression::Iterate { expression, .. } => infer_operand_type(expression, find_column),
        _ => DataType::Float64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::aggregate::AggregateOp;

    #[test]
    fn non_query_expression_is_representable_but_flagged() {
        // The struct is plain data — a non-Query expression can be held, but
        // is_query() is false and the model builder rejects it.
        let expr = Expression::Aggregate {
            operation: AggregateOp::Sum,
            operand: Box::new(Expression::ColumnRef("linetotal".into())),
        };
        let gv = GlobalVariable::new("total_revenue", "fact_sales", expr.clone());

        assert_eq!(gv.name(), "total_revenue");
        assert_eq!(gv.table(), "fact_sales");
        assert!(!gv.is_query());
    }

    #[test]
    fn query_global_variable() {
        let expr = Expression::Query {
            aggregates: vec![(
                Expression::Aggregate {
                    operation: AggregateOp::Sum,
                    operand: Box::new(Expression::ColumnRef("linetotal".into())),
                },
                "Amount".into(),
            )],
            group_by: vec![("dim_customer".into(), "city".into())],
        };
        let gv = GlobalVariable::new("city_sales", "fact_sales", expr);

        assert!(gv.is_query());
    }

    #[test]
    fn serde_roundtrip() {
        let expr = Expression::Query {
            aggregates: vec![(
                Expression::Aggregate {
                    operation: AggregateOp::Sum,
                    operand: Box::new(Expression::ColumnRef("amount".into())),
                },
                "Amt".into(),
            )],
            group_by: vec![("dim".into(), "city".into())],
        };
        let gv = GlobalVariable::new("rev", "sales", expr);

        let json = serde_json::to_string(&gv).unwrap();
        let restored: GlobalVariable = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.name(), "rev");
        assert_eq!(restored.table(), "sales");
        assert!(restored.is_query());
    }
}
