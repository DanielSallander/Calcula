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

/// A filter predicate: `Table.Column op value`.
///
/// Used inside `keep()` to add filter conditions to the evaluation context.
/// Column references are always fully qualified with `Table.Column`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterPredicate {
    /// Table name.
    pub table: String,
    /// Column name.
    pub column: String,
    /// Comparison operator.
    pub operator: ComparisonOp,
    /// Value to compare against (string representation).
    pub value: String,
}

impl FilterPredicate {
    /// Create a new filter predicate.
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

/// An IN-membership predicate: `table.column IN var_name.var_column`.
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
        }
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
