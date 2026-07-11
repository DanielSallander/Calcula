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
    /// DYNAMIC format string: an expression (source text) that evaluates to
    /// the format string ONCE PER QUERY under the outer filter/slicer context
    /// (no group axis) — e.g. switch between currency formats by slicer.
    /// Overrides [`format_string`](Self::format_string) in
    /// `Engine::query_with_meta` result metadata when it evaluates to a
    /// string; validated (parse + scalar-only) at model build.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format_string_expression: Option<String>,
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
            format_string_expression: Option<String>,
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
            format_string_expression: f.format_string_expression,
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
            format_string_expression: None,
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

    /// Set the DYNAMIC format string expression (source text) — evaluated
    /// once per query under the outer filter context; see the field docs.
    pub fn with_format_string_expression(mut self, expression: impl Into<String>) -> Self {
        self.format_string_expression = Some(expression.into());
        self
    }

    /// Returns the dynamic format string expression, if any.
    pub fn format_string_expression(&self) -> Option<&str> {
        self.format_string_expression.as_deref()
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

    /// Returns the names of the measures this measure **directly** references
    /// (via `[OtherMeasure]`), deduplicated and sorted.
    ///
    /// This is its direct dependency set, not the transitive closure. See
    /// [`Expression::measure_references`] and
    /// [`DataModel::measure_dependents`](crate::model::DataModel::measure_dependents).
    pub fn referenced_measures(&self) -> Vec<&str> {
        self.expression.measure_references()
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

    /// Override the cached home table. Crate-internal: used only by
    /// [`DataModel::resolve_measure_home_tables`](crate::model::DataModel::resolve_measure_home_tables)
    /// to give a measure that references only OTHER measures (e.g.
    /// `[Total Sales] + 1000`) the home table of the measures it builds on —
    /// `infer_fact_table` cannot see through a `MeasureRef` without the model.
    pub(crate) fn set_home_table(&mut self, table: String) {
        self.cached_table = table;
    }

    /// Rewrite every **measure reference** to `old` in this measure as `new`,
    /// leaving column references (`Table[old]`) untouched. Used by
    /// [`DataModel::rewrite_measure_references`](crate::model::DataModel::rewrite_measure_references)
    /// so that renaming a measure propagates into its dependents — renaming
    /// `Revenue` rewrites `[Revenue] + 1000` to `[Total Sales] + 1000`.
    ///
    /// Works off the formula text (this measure's `source` when present, else
    /// the rendered expression) so the rewrite is bracket-aware and the
    /// source/expression pair stays in sync. The home table is preserved: a
    /// rename never moves a measure to a different table. A no-op (returns
    /// `false`) if this measure does not reference `old` or the rewritten text
    /// fails to reparse.
    pub(crate) fn rename_measure_reference(&mut self, old: &str, new: &str) -> bool {
        if old == new || !self.referenced_measures().iter().any(|r| *r == old) {
            return false;
        }
        let had_source = self.source.is_some();
        let text = match &self.source {
            Some(s) => s.clone(),
            None => expr::measure_to_formula(self),
        };
        let rewritten = rewrite_measure_ref_in_source(&text, old, new);
        if rewritten == text {
            return false;
        }
        match crate::compute::parser::parse_measure_expression(&rewritten) {
            Ok(expression) => {
                // Keep cached_table as-is: the referenced columns are unchanged,
                // so a rename never moves this measure to a different table.
                self.expression = expression;
                if had_source {
                    self.source = Some(rewritten);
                }
                true
            }
            Err(_) => false,
        }
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

/// Rewrite bare measure references `[old]` in a measure's formula text to
/// `[new]`, leaving qualified column references (`Table[old]`) untouched.
///
/// A `[` opens a measure reference unless the last non-space character before
/// it is an identifier character — in which case it is a column reference on
/// that table (mirroring how the tokenizer binds `Ident [ ... ]`). Bracket
/// content is compared trimmed, so `[ Revenue ]` matches `Revenue`.
fn rewrite_measure_ref_in_source(src: &str, old: &str, new: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len() + new.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            let is_column_ref = out
                .trim_end()
                .chars()
                .last()
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.');
            let start = i + 1;
            let mut j = start;
            while j < chars.len() && chars[j] != ']' {
                j += 1;
            }
            if !is_column_ref && j < chars.len() {
                let name: String = chars[start..j].iter().collect();
                if name.trim() == old {
                    out.push('[');
                    out.push_str(new);
                    out.push(']');
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
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

    #[test]
    fn rewrite_measure_ref_renames_only_measure_brackets() {
        // Bare `[Revenue]` is a measure ref; `Sales[Revenue]` is a column ref.
        let src = "[Revenue] + Sales[Revenue] * [ Revenue ]";
        let out = rewrite_measure_ref_in_source(src, "Revenue", "Total Sales");
        assert_eq!(out, "[Total Sales] + Sales[Revenue] * [Total Sales]");
    }

    #[test]
    fn rewrite_measure_ref_leaves_non_matching_names_alone() {
        let src = "[Revenue Growth] + [Revenue]";
        let out = rewrite_measure_ref_in_source(src, "Revenue", "Total Sales");
        assert_eq!(out, "[Revenue Growth] + [Total Sales]");
    }

    #[test]
    fn rename_measure_reference_updates_source_and_expression() {
        let expr = crate::compute::parser::parse_measure_expression("[Revenue] + 1000").unwrap();
        let mut m = Measure::new("Bonus", expr).with_source("[Revenue] + 1000");
        assert!(m.rename_measure_reference("Revenue", "Total Sales"));
        assert_eq!(m.source(), Some("[Total Sales] + 1000"));
        assert_eq!(m.referenced_measures(), vec!["Total Sales"]);
    }

    #[test]
    fn rename_measure_reference_is_noop_when_not_referenced() {
        let expr = crate::compute::parser::parse_measure_expression("[Profit] + 1").unwrap();
        let mut m = Measure::new("Bonus", expr).with_source("[Profit] + 1");
        assert!(!m.rename_measure_reference("Revenue", "Total Sales"));
        assert_eq!(m.source(), Some("[Profit] + 1"));
    }
}
