//! Measure definitions — named aggregation expressions over the data model.
//!
//! Measures are the primary computation unit in the engine. Each measure
//! is an expression tree that must contain at least one aggregate node.
//! Simple measures like `SUM(amount)` can be pushed down to data sources;
//! complex expression measures like `SUM(price * qty)` or
//! `SUM(revenue) / COUNT(orders)` are computed locally.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{self as expr, infer_fact_table, Expression};

/// A named measure: a reusable aggregation expression over a table.
///
/// Measures are defined as expression trees that contain aggregate nodes.
/// The simplest form is `AGG(column)`, but measures can also be
/// expressions over aggregates like `SUM(price * quantity)` or
/// `SUM(revenue) / COUNT(orders)`.
///
/// The fact table is inferred from the expression's qualified column
/// references (e.g. `Sales[amount]`). A cached copy is stored at
/// construction time for efficient `&str` access.
#[derive(Debug, Clone, Serialize)]
pub struct Measure {
    name: String,
    expression: Expression,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    /// Original human-readable expression text, when the measure was
    /// created from text. The source is the authoritative definition;
    /// the expression AST acts as a cache of its last successful parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    /// Display format hint for host applications (e.g. `"#,##0.00"`,
    /// `"0.0%"`). Opaque to the engine — see [`Measure::format_string`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format_string: Option<String>,
    /// Human-readable description shown by host applications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    /// Whether host applications should hide this measure from end-user
    /// field lists. Purely presentational — hidden measures remain fully
    /// queryable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    is_hidden: bool,
    /// Fact table inferred from the expression's qualified column refs.
    #[serde(skip)]
    cached_table: String,
}

impl<'de> Deserialize<'de> for Measure {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Fields {
            name: String,
            expression: Expression,
            #[serde(default)]
            group: Option<String>,
            #[serde(default)]
            source: Option<String>,
            #[serde(default)]
            format_string: Option<String>,
            #[serde(default)]
            description: Option<String>,
            #[serde(default)]
            is_hidden: bool,
        }
        let f = Fields::deserialize(deserializer)?;
        let cached_table = infer_fact_table(&f.expression).unwrap_or_default();
        Ok(Measure {
            name: f.name,
            expression: f.expression,
            group: f.group,
            source: f.source,
            format_string: f.format_string,
            description: f.description,
            is_hidden: f.is_hidden,
            cached_table,
        })
    }
}

impl Measure {
    /// Create a new measure from an expression.
    ///
    /// The fact table is inferred from the expression's qualified column
    /// references. Use `table[column]` syntax in expressions so the table
    /// can be determined automatically.
    pub fn new(name: impl Into<String>, expression: Expression) -> Self {
        let cached_table = infer_fact_table(&expression).unwrap_or_default();
        Self {
            name: name.into(),
            expression,
            group: None,
            source: None,
            format_string: None,
            description: None,
            is_hidden: false,
            cached_table,
        }
    }

    /// Create a simple aggregate measure: `AGG(table[column])`.
    ///
    /// Builds a qualified column reference internally so the fact table
    /// is embedded in the expression.
    pub fn simple(
        name: impl Into<String>,
        table: impl Into<String>,
        column: impl Into<String>,
        operation: AggregateOp,
    ) -> Self {
        let t = table.into();
        let c = column.into();
        Self::new(name, expr::agg(operation, expr::qualified_col(&t, &c)))
    }

    /// Set the measure group.
    pub fn with_group(mut self, group: impl Into<String>) -> Self {
        self.group = Some(group.into());
        self
    }

    /// Attach the original expression source text to this measure.
    ///
    /// The source text is the authoritative, human-readable definition of
    /// the measure: hosts display and edit it, and model loading re-parses
    /// it through the current parser (see
    /// [`DataModel::reparse_measures_from_source`](crate::model::schema::DataModel::reparse_measures_from_source)),
    /// so the stored expression AST acts only as a cache of the last
    /// successful parse. Callers that build a measure by parsing text
    /// (e.g. via `parse_measure_expression`) should attach that text here;
    /// measures built programmatically from [`Expression`] values have no
    /// source.
    pub fn with_source(mut self, text: impl Into<String>) -> Self {
        self.source = Some(text.into());
        self
    }

    /// Set the display format hint for this measure (e.g. `"#,##0.00"`,
    /// `"0.0%"`).
    ///
    /// The format string is an **opaque host contract**: the engine stores
    /// and round-trips it but never interprets it. Calcula Studio writes
    /// it and Calcula applies it when rendering values; the two hosts must
    /// agree on the format-string grammar between themselves.
    pub fn with_format_string(mut self, format: impl Into<String>) -> Self {
        self.format_string = Some(format.into());
        self
    }

    /// Set the human-readable description of this measure.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Mark this measure as hidden from end-user field lists.
    ///
    /// Hiding is purely presentational — hidden measures remain fully
    /// queryable (e.g. as building blocks for other measures).
    pub fn hidden(mut self) -> Self {
        self.is_hidden = true;
        self
    }

    /// Returns the display format hint, if set.
    ///
    /// Opaque to the engine — see [`Measure::with_format_string`].
    pub fn format_string(&self) -> Option<&str> {
        self.format_string.as_deref()
    }

    /// Returns the description, if any.
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    /// Returns `true` if host applications should hide this measure from
    /// end-user field lists.
    pub fn is_hidden(&self) -> bool {
        self.is_hidden
    }

    /// Returns the measure name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the table this measure operates on.
    ///
    /// Inferred from qualified column references in the expression at
    /// construction time.
    pub fn table(&self) -> &str {
        &self.cached_table
    }

    /// Returns the expression tree.
    pub fn expression(&self) -> &Expression {
        &self.expression
    }

    /// Returns the original expression source text, if the measure was
    /// created from text.
    ///
    /// `None` for measures built programmatically from [`Expression`]
    /// values. When present, the source is the authoritative definition
    /// and the expression tree is a cache of its last successful parse.
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    /// Replace the expression tree, recomputing the cached fact table.
    ///
    /// Crate-internal on purpose: it is exposed only through
    /// `DataModel::reparse_measures_from_source`, which keeps the
    /// source-text/AST pairing consistent. A general-purpose public
    /// setter would let hosts desynchronize a measure's `source` from
    /// its expression.
    pub(crate) fn set_expression(&mut self, expression: Expression) {
        self.cached_table = infer_fact_table(&expression).unwrap_or_default();
        self.expression = expression;
    }

    /// Returns the measure group name, if any.
    pub fn group(&self) -> Option<&str> {
        self.group.as_deref()
    }

    /// Returns `true` if this is a simple `AGG(column)` measure that can
    /// be pushed down to a data source.
    pub fn is_simple_aggregate(&self) -> bool {
        self.expression.is_simple_aggregate()
    }

    /// If this is a simple aggregate, returns the column name.
    ///
    /// For backward compatibility with code that expects `measure.column()`.
    pub fn simple_column(&self) -> Option<&str> {
        self.expression.as_simple_aggregate().map(|(_, col)| col)
    }

    /// If this is a simple aggregate, returns the aggregation operation.
    ///
    /// For backward compatibility with code that expects `measure.operation()`.
    pub fn simple_operation(&self) -> Option<AggregateOp> {
        self.expression.as_simple_aggregate().map(|(op, _)| op)
    }

    /// Returns all column names referenced by this measure's expression.
    pub fn column_references(&self) -> Vec<&str> {
        self.expression.column_references()
    }
}

/// A named group of related measures.
///
/// Measure groups are organizational — they do not affect computation.
/// They allow host applications to present measures in logical categories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeasureGroup {
    name: String,
    description: Option<String>,
}

impl MeasureGroup {
    /// Create a new measure group.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: None,
        }
    }

    /// Create a measure group with a description.
    pub fn with_description(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: Some(description.into()),
        }
    }

    /// Returns the group name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the description, if any.
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
}

// --- Convenience constructors ---

/// Create a SUM measure.
pub fn sum_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    column: impl Into<String>,
) -> Measure {
    Measure::simple(name, table, column, AggregateOp::Sum)
}

/// Create a COUNT measure.
pub fn count_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    column: impl Into<String>,
) -> Measure {
    Measure::simple(name, table, column, AggregateOp::Count)
}

/// Create an AVERAGE measure.
pub fn average_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    column: impl Into<String>,
) -> Measure {
    Measure::simple(name, table, column, AggregateOp::Average)
}

/// Create a DISTINCT COUNT measure.
pub fn distinct_count_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    column: impl Into<String>,
) -> Measure {
    Measure::simple(name, table, column, AggregateOp::DistinctCount)
}

/// Create a measure from an arbitrary expression.
///
/// The expression should contain at least one `Aggregate` node and
/// use qualified column references (`table[column]`) so the fact table
/// can be inferred.
pub fn expression_measure(name: impl Into<String>, expression: Expression) -> Measure {
    Measure::new(name, expression)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sum_measure_is_simple_aggregate() {
        let m = sum_measure("Total", "Sales", "amount");
        assert!(m.is_simple_aggregate());
        assert_eq!(m.simple_column(), Some("amount"));
        assert_eq!(m.simple_operation(), Some(AggregateOp::Sum));
        assert_eq!(m.table(), "Sales");
    }

    #[test]
    fn expression_measure_is_not_simple() {
        let m = expression_measure(
            "Revenue",
            expr::agg(
                AggregateOp::Sum,
                expr::qualified_col("Sales", "price")
                    .multiply(expr::qualified_col("Sales", "quantity")),
            ),
        );
        assert!(!m.is_simple_aggregate());
        assert_eq!(m.simple_column(), None);
        assert_eq!(m.simple_operation(), None);
        assert_eq!(m.table(), "Sales");
    }

    #[test]
    fn ratio_measure_is_not_simple() {
        let m = expression_measure(
            "AvgOrder",
            expr::agg(AggregateOp::Sum, expr::qualified_col("Sales", "amount")).divide(expr::agg(
                AggregateOp::Count,
                expr::qualified_col("Sales", "id"),
            )),
        );
        assert!(!m.is_simple_aggregate());
        assert_eq!(m.column_references(), vec!["amount", "id"]);
        assert_eq!(m.table(), "Sales");
    }

    #[test]
    fn measure_with_group() {
        let m = sum_measure("Total", "Sales", "amount").with_group("Financial");
        assert_eq!(m.group(), Some("Financial"));
    }

    #[test]
    fn measure_without_group() {
        let m = sum_measure("Total", "Sales", "amount");
        assert_eq!(m.group(), None);
    }

    #[test]
    fn column_references_for_simple_measure() {
        let m = sum_measure("Total", "Sales", "amount");
        assert_eq!(m.column_references(), vec!["amount"]);
    }

    #[test]
    fn column_references_for_expression_measure() {
        let m = expression_measure(
            "Revenue",
            expr::agg(
                AggregateOp::Sum,
                expr::qualified_col("Sales", "price")
                    .multiply(expr::qualified_col("Sales", "quantity")),
            ),
        );
        assert_eq!(m.column_references(), vec!["price", "quantity"]);
    }

    #[test]
    fn serialize_roundtrip() {
        let m = sum_measure("Total", "Sales", "amount");
        let json = serde_json::to_string(&m).unwrap();
        let restored: Measure = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.name(), "Total");
        assert_eq!(restored.table(), "Sales");
        assert!(restored.is_simple_aggregate());
    }

    #[test]
    fn source_text_round_trips_through_serde() {
        let m = sum_measure("Total", "Sales", "amount").with_source("SUM(Sales[amount])");
        assert_eq!(m.source(), Some("SUM(Sales[amount])"));

        let json = serde_json::to_string(&m).unwrap();
        let restored: Measure = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.source(), Some("SUM(Sales[amount])"));
        assert_eq!(restored.name(), "Total");
        assert_eq!(restored.table(), "Sales");
    }

    #[test]
    fn absent_source_stays_none_through_serde() {
        let m = sum_measure("Total", "Sales", "amount");
        assert_eq!(m.source(), None);

        let json = serde_json::to_string(&m).unwrap();
        // skip_serializing_if keeps legacy-compatible output: no field at all.
        assert!(!json.contains("\"source\""));
        let restored: Measure = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.source(), None);
    }

    // --- Presentation metadata ---

    #[test]
    fn measure_metadata_builders_and_getters() {
        let m = sum_measure("Total", "Sales", "amount")
            .with_format_string("#,##0.00")
            .with_description("Total sales amount")
            .hidden();
        assert_eq!(m.format_string(), Some("#,##0.00"));
        assert_eq!(m.description(), Some("Total sales amount"));
        assert!(m.is_hidden());
    }

    #[test]
    fn measure_metadata_defaults_to_absent_and_visible() {
        let m = sum_measure("Total", "Sales", "amount");
        assert_eq!(m.format_string(), None);
        assert_eq!(m.description(), None);
        assert!(!m.is_hidden());
    }

    #[test]
    fn measure_metadata_round_trips_through_serde() {
        let m = sum_measure("Total", "Sales", "amount")
            .with_format_string("0.0%")
            .with_description("Share of revenue")
            .hidden();

        let json = serde_json::to_string(&m).unwrap();
        let restored: Measure = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.format_string(), Some("0.0%"));
        assert_eq!(restored.description(), Some("Share of revenue"));
        assert!(restored.is_hidden());
        // Custom Deserialize must still rebuild the cached fact table.
        assert_eq!(restored.table(), "Sales");
    }

    #[test]
    fn absent_measure_metadata_is_skipped_in_json_and_defaults_on_load() {
        let m = sum_measure("Total", "Sales", "amount");
        let json = serde_json::to_string(&m).unwrap();
        // Legacy-compatible output: absent metadata writes no fields.
        assert!(!json.contains("\"format_string\""));
        assert!(!json.contains("\"description\""));
        assert!(!json.contains("\"is_hidden\""));

        let restored: Measure = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.format_string(), None);
        assert_eq!(restored.description(), None);
        assert!(!restored.is_hidden());
    }

    #[test]
    fn legacy_measure_json_without_metadata_loads_with_defaults() {
        // JSON written by an older engine: no metadata fields at all.
        let json = r#"{
            "name": "Total",
            "expression": {"Aggregate": {"operation": "Sum", "operand": {
                "QualifiedColumnRef": {"table_or_var": "Sales", "column": "amount"}
            }}}
        }"#;
        let restored: Measure = serde_json::from_str(json).unwrap();
        assert_eq!(restored.format_string(), None);
        assert_eq!(restored.description(), None);
        assert!(!restored.is_hidden());
        assert_eq!(restored.table(), "Sales");
    }
}
