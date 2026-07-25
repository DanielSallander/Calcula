//! Table variable definitions for the data model.
//!
//! A table variable is a named, pre-filtered view of a base table. Table
//! variables can be composed (a variable based on another variable) and
//! aggregated (`sum(var.column)`). They can be defined at the model level
//! for reuse across multiple measures.

use serde::{Deserialize, Serialize};

use crate::compute::expression::FilterPredicate;

/// A named table variable: a filtered view of a base table.
///
/// Table variables represent a pre-filtered subset of a table's data.
/// They can be composed (a variable based on another variable) and
/// their columns can be referenced in measure expressions via
/// `qualified_col("var_name", "column_name")`.
///
/// # Example
///
/// ```
/// use engine_core::model::table_variable::TableVariable;
/// use engine_core::compute::expression::{FilterPredicate, ComparisonOp};
///
/// let premium = TableVariable::new(
///     "PremiumProducts",
///     "Products",
///     vec![FilterPredicate::new("Products", "ListPrice", ComparisonOp::GreaterThan, "1000")],
/// );
/// assert_eq!(premium.name(), "PremiumProducts");
/// assert_eq!(premium.source(), "Products");
/// assert_eq!(premium.filters().len(), 1);
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableVariable {
    name: String,
    /// The source: a base table name or another table variable name.
    source: String,
    /// Filter predicates applied to the source to produce this variable.
    filters: Vec<FilterPredicate>,
}

impl TableVariable {
    /// Create a new table variable.
    pub fn new(
        name: impl Into<String>,
        source: impl Into<String>,
        filters: Vec<FilterPredicate>,
    ) -> Self {
        Self {
            name: name.into(),
            source: source.into(),
            filters,
        }
    }

    /// Returns the variable name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the source table or variable name.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Returns the filter predicates.
    pub fn filters(&self) -> &[FilterPredicate] {
        &self.filters
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::expression::ComparisonOp;

    #[test]
    fn table_variable_creation() {
        let tv = TableVariable::new(
            "PremiumProducts",
            "Products",
            vec![FilterPredicate::new(
                "Products",
                "ListPrice",
                ComparisonOp::GreaterThan,
                "1000",
            )],
        );
        assert_eq!(tv.name(), "PremiumProducts");
        assert_eq!(tv.source(), "Products");
        assert_eq!(tv.filters().len(), 1);
    }

    #[test]
    fn table_variable_serialization_roundtrip() {
        let tv = TableVariable::new(
            "Sales2024",
            "Sales",
            vec![FilterPredicate::new(
                "Calendar",
                "Year",
                ComparisonOp::Equal,
                "2024",
            )],
        );
        let json = serde_json::to_string(&tv).unwrap();
        let deserialized: TableVariable = serde_json::from_str(&json).unwrap();
        assert_eq!(tv, deserialized);
    }

    #[test]
    fn table_variable_no_filters() {
        let tv = TableVariable::new("AllSales", "Sales", vec![]);
        assert!(tv.filters().is_empty());
    }
}
