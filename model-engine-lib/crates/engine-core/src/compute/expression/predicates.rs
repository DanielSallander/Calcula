//! Filter predicates, comparison operators, IN predicates, and relationship paths.

use super::*;

/// Comparison operators for filter predicates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComparisonOp {
    /// `=`
    Equal,
    /// `!=`
    NotEqual,
    /// `>`
    GreaterThan,
    /// `>=`
    GreaterThanOrEqual,
    /// `<`
    LessThan,
    /// `<=`
    LessThanOrEqual,
}

impl ComparisonOp {
    /// Returns the SQL operator string.
    pub fn as_sql(&self) -> &'static str {
        match self {
            Self::Equal => "=",
            Self::NotEqual => "!=",
            Self::GreaterThan => ">",
            Self::GreaterThanOrEqual => ">=",
            Self::LessThan => "<",
            Self::LessThanOrEqual => "<=",
        }
    }
}

/// A runtime identity that a row-level-security predicate resolves to at query
/// time, rather than a fixed value — enabling **dynamic RLS**
/// (e.g. `dim_user[email] = USERNAME()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DynamicValue {
    /// The current user identity, set on the engine via `set_user_identity`
    /// (DAX `USERNAME()`).
    Username,
    /// Host-supplied custom data, set on the engine via `set_custom_data`
    /// (DAX `CUSTOMDATA()`).
    CustomData,
}

/// A filter predicate: `Table.Column op value`.
///
/// Used inside `keep()` to add filter conditions to the evaluation context, and
/// as a [security role](crate::model::SecurityRole)'s row filter. Column
/// references are always fully qualified with `Table.Column`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterPredicate {
    /// Table name.
    pub table: String,
    /// Column name.
    pub column: String,
    /// Comparison operator.
    pub operator: ComparisonOp,
    /// Value to compare against (string representation). For a [dynamic](Self::dynamic)
    /// predicate this is a placeholder; the engine substitutes the resolved
    /// identity here before the predicate is rendered.
    pub value: String,
    /// When `Some`, the predicate compares against a **runtime identity** (the
    /// current `USERNAME()` / `CUSTOMDATA()`) resolved at query time, instead of
    /// the fixed `value` — a **dynamic** row-level-security predicate. The engine
    /// substitutes the concrete identity into `value` (clearing this field)
    /// before the predicate is ever rendered, and **fails closed** when the
    /// identity is unset; an unsubstituted dynamic predicate is never rendered as
    /// a literal. `None` for an ordinary (static) predicate; skipped on
    /// serialization when absent (back-compat with pre-v11 role files).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<DynamicValue>,
}

impl FilterPredicate {
    /// Create a new (static) filter predicate.
    pub fn new(
        table: impl Into<String>,
        column: impl Into<String>,
        operator: ComparisonOp,
        value: impl Into<String>,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            operator,
            value: value.into(),
            dynamic: None,
        }
    }

    /// A **dynamic** predicate comparing `table.column` against the current
    /// `USERNAME()` identity, resolved at query time (dynamic RLS). The engine
    /// substitutes the active user identity before rendering and fails closed if
    /// none is set. See [`DynamicValue`].
    pub fn username(
        table: impl Into<String>,
        column: impl Into<String>,
        operator: ComparisonOp,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            operator,
            value: "USERNAME()".into(),
            dynamic: Some(DynamicValue::Username),
        }
    }

    /// A **dynamic** predicate comparing `table.column` against `CUSTOMDATA()`,
    /// resolved at query time (dynamic RLS). See [`DynamicValue`].
    pub fn custom_data(
        table: impl Into<String>,
        column: impl Into<String>,
        operator: ComparisonOp,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            operator,
            value: "CUSTOMDATA()".into(),
            dynamic: Some(DynamicValue::CustomData),
        }
    }

    /// Validate this predicate for safe SQL rendering.
    ///
    /// The table name is rendered as a raw (unquoted, lowercased) SQL
    /// qualifier by the measure engine and pipeline. The column is always
    /// quoted with `quote_ident_double` and the value with
    /// `sql_quote_literal`, so only the table needs checking here.
    pub fn validate(&self) -> EngineResult<()> {
        validate_identifier(&self.table, "filter table")
    }
}

/// A path through relationships for explicit traversal.
///
/// Represents a chain of table names: `Sales -> Products` or
/// `Sales -> Warehouse -> Products`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationshipPath {
    /// Ordered list of table names forming the traversal path.
    pub hops: Vec<String>,
}

impl RelationshipPath {
    /// Create a path from table names.
    pub fn new(hops: Vec<impl Into<String>>) -> Self {
        Self {
            hops: hops.into_iter().map(Into::into).collect(),
        }
    }
}

/// An IN-membership predicate: `table.column IN var_name.var_column`
/// (or, [negated](Self::negated), `table.column NOT IN var_name.var_column`).
///
/// Tests whether values in `table.column` are members of the set defined
/// by `var_column` in the table variable `var_name`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InPredicate {
    /// Table containing the column to test.
    pub table: String,
    /// Column to test for membership.
    pub column: String,
    /// Table variable providing the set.
    pub var_name: String,
    /// Column in the variable defining the set values.
    pub var_column: String,
    /// `true` = anti-membership (`NOT IN`): keep rows whose value is NOT in
    /// the set. SQL semantics: a BLANK value satisfies neither `IN` nor
    /// `NOT IN` (consistent with `<>`); an empty set keeps everything.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub negated: bool,
}

impl InPredicate {
    /// Create a new IN predicate.
    pub fn new(
        table: impl Into<String>,
        column: impl Into<String>,
        var_name: impl Into<String>,
        var_column: impl Into<String>,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            var_name: var_name.into(),
            var_column: var_column.into(),
            negated: false,
        }
    }

    /// Mark this predicate as anti-membership (`NOT IN`).
    #[must_use]
    pub fn with_negated(mut self, negated: bool) -> Self {
        self.negated = negated;
        self
    }

    /// Validate this predicate for safe SQL rendering.
    ///
    /// The table name and the variable name are rendered as raw (unquoted,
    /// lowercased) SQL identifiers when the IN-subquery is built. The column
    /// names are always quoted with `quote_ident_double`, so only the table
    /// and variable names need checking here.
    pub fn validate(&self) -> EngineResult<()> {
        validate_identifier(&self.table, "IN-predicate table")?;
        validate_identifier(&self.var_name, "IN-predicate variable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_predicate_creation() {
        let fp = FilterPredicate::new("Sales", "Region", ComparisonOp::GreaterThan, "100");
        assert_eq!(fp.table, "Sales");
        assert_eq!(fp.column, "Region");
        assert_eq!(fp.operator, ComparisonOp::GreaterThan);
        assert_eq!(fp.value, "100");
    }

    #[test]
    fn dynamic_constructors_set_the_kind() {
        let u = FilterPredicate::username("Geography", "region", ComparisonOp::Equal);
        assert_eq!(u.dynamic, Some(DynamicValue::Username));
        let c = FilterPredicate::custom_data("Geography", "region", ComparisonOp::Equal);
        assert_eq!(c.dynamic, Some(DynamicValue::CustomData));
        // A plain predicate is static.
        assert!(FilterPredicate::new("T", "c", ComparisonOp::Equal, "v")
            .dynamic
            .is_none());
    }

    #[test]
    fn legacy_predicate_without_dynamic_field_deserializes_as_static() {
        // A pre-v11 role file has no `dynamic` field on its predicates; it must
        // load as an ordinary static predicate (back-compat).
        let json = r#"{"table":"Geography","column":"region","operator":"Equal","value":"West"}"#;
        let p: FilterPredicate = serde_json::from_str(json).unwrap();
        assert_eq!(p.value, "West");
        assert!(p.dynamic.is_none());
    }

    #[test]
    fn comparison_op_sql() {
        assert_eq!(ComparisonOp::Equal.as_sql(), "=");
        assert_eq!(ComparisonOp::NotEqual.as_sql(), "!=");
        assert_eq!(ComparisonOp::GreaterThan.as_sql(), ">");
        assert_eq!(ComparisonOp::GreaterThanOrEqual.as_sql(), ">=");
        assert_eq!(ComparisonOp::LessThan.as_sql(), "<");
        assert_eq!(ComparisonOp::LessThanOrEqual.as_sql(), "<=");
    }

    #[test]
    fn relationship_path_creation() {
        let path = RelationshipPath::new(vec!["Sales", "Products"]);
        assert_eq!(path.hops, vec!["Sales", "Products"]);
    }

    #[test]
    fn in_predicate_creation() {
        let pred = InPredicate::new("Sales", "product_id", "premium", "id");
        assert_eq!(pred.table, "Sales");
        assert_eq!(pred.column, "product_id");
        assert_eq!(pred.var_name, "premium");
        assert_eq!(pred.var_column, "id");
    }
}
