//! Relationship definitions for the data model.
//!
//! A relationship connects a column in one table (the "from" side, typically
//! the fact/many side) to a column in another table (the "to" side, typically
//! the dimension/one side).

use serde::{Deserialize, Serialize};

/// Cardinality of a relationship between two tables.
///
/// In star schemas, the standard pattern is [`ManyToOne`](Cardinality::ManyToOne)
/// from a fact table (many side) to a dimension table (one side).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Cardinality {
    /// Many rows in the "from" table map to one row in the "to" table.
    /// This is the standard fact-to-dimension relationship.
    ManyToOne,
    /// One row in the "from" table maps to many rows in the "to" table.
    /// This is the reverse direction of ManyToOne.
    OneToMany,
    /// One row in the "from" table maps to exactly one row in the "to" table.
    OneToOne,
}

/// Controls how filters propagate through a relationship.
///
/// When a filter is applied on a dimension table column, propagation determines
/// whether that filter automatically reaches the fact table (and vice versa).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FilterPropagation {
    /// Filters propagate from the "to" (dimension) side to the "from" (fact) side.
    /// This is the default for [`ManyToOne`](Cardinality::ManyToOne) relationships.
    Auto,
    /// No automatic filter propagation. Cross-table filters require explicit
    /// `traverse()` in expressions.
    None,
    /// Filters propagate in both directions.
    Both,
}

/// A foreign-key relationship between two tables in the data model.
///
/// A relationship connects a column in the "from" table to a column in the
/// "to" table. In star schema terminology, the "from" side is typically the
/// fact table (many side) and the "to" side is the dimension table (one side).
///
/// # Example
///
/// ```rust
/// use engine_core::model::Relationship;
///
/// let rel = Relationship::many_to_one(
///     "Sales_Products",
///     "Sales", "product_id",
///     "Products", "id",
/// );
/// assert_eq!(rel.from_table(), "Sales");
/// assert_eq!(rel.to_table(), "Products");
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Relationship {
    name: String,
    from_table: String,
    from_column: String,
    to_table: String,
    to_column: String,
    cardinality: Cardinality,
    #[serde(default = "default_propagation")]
    propagation: FilterPropagation,
}

fn default_propagation() -> FilterPropagation {
    FilterPropagation::Auto
}

impl Relationship {
    /// Create a new relationship with explicit cardinality.
    ///
    /// Filter propagation defaults to [`Auto`](FilterPropagation::Auto) for
    /// [`ManyToOne`](Cardinality::ManyToOne), and [`None`](FilterPropagation::None)
    /// for other cardinalities. Use [`with_propagation`](Self::with_propagation)
    /// to override.
    pub fn new(
        name: impl Into<String>,
        from_table: impl Into<String>,
        from_column: impl Into<String>,
        to_table: impl Into<String>,
        to_column: impl Into<String>,
        cardinality: Cardinality,
    ) -> Self {
        let propagation = match cardinality {
            Cardinality::ManyToOne => FilterPropagation::Auto,
            _ => FilterPropagation::None,
        };
        Self {
            name: name.into(),
            from_table: from_table.into(),
            from_column: from_column.into(),
            to_table: to_table.into(),
            to_column: to_column.into(),
            cardinality,
            propagation,
        }
    }

    /// Create a many-to-one relationship (the most common star-schema pattern).
    ///
    /// The "from" side is the fact table (many rows), the "to" side is the
    /// dimension table (one row per key).
    pub fn many_to_one(
        name: impl Into<String>,
        from_table: impl Into<String>,
        from_column: impl Into<String>,
        to_table: impl Into<String>,
        to_column: impl Into<String>,
    ) -> Self {
        Self::new(
            name,
            from_table,
            from_column,
            to_table,
            to_column,
            Cardinality::ManyToOne,
        )
    }

    /// Returns the relationship name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the name of the "from" table (typically the fact/many side).
    pub fn from_table(&self) -> &str {
        &self.from_table
    }

    /// Returns the name of the "from" column (foreign key).
    pub fn from_column(&self) -> &str {
        &self.from_column
    }

    /// Returns the name of the "to" table (typically the dimension/one side).
    pub fn to_table(&self) -> &str {
        &self.to_table
    }

    /// Returns the name of the "to" column (primary key).
    pub fn to_column(&self) -> &str {
        &self.to_column
    }

    /// Returns the cardinality of this relationship.
    pub fn cardinality(&self) -> Cardinality {
        self.cardinality
    }

    /// Returns the filter propagation mode.
    pub fn propagation(&self) -> FilterPropagation {
        self.propagation
    }

    /// Set the filter propagation mode, returning a modified relationship.
    pub fn with_propagation(mut self, propagation: FilterPropagation) -> Self {
        self.propagation = propagation;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_relationship_with_all_fields() {
        let rel = Relationship::new(
            "Sales_Products",
            "Sales",
            "product_id",
            "Products",
            "id",
            Cardinality::ManyToOne,
        );
        assert_eq!(rel.name(), "Sales_Products");
        assert_eq!(rel.from_table(), "Sales");
        assert_eq!(rel.from_column(), "product_id");
        assert_eq!(rel.to_table(), "Products");
        assert_eq!(rel.to_column(), "id");
        assert_eq!(rel.cardinality(), Cardinality::ManyToOne);
    }

    #[test]
    fn many_to_one_convenience_constructor() {
        let rel =
            Relationship::many_to_one("Sales_Products", "Sales", "product_id", "Products", "id");
        assert_eq!(rel.cardinality(), Cardinality::ManyToOne);
    }

    #[test]
    fn relationship_serialization_roundtrip() {
        let rel =
            Relationship::many_to_one("Sales_Products", "Sales", "product_id", "Products", "id");
        let json = serde_json::to_string(&rel).unwrap();
        let deserialized: Relationship = serde_json::from_str(&json).unwrap();
        assert_eq!(rel, deserialized);
    }

    #[test]
    fn many_to_one_defaults_to_auto_propagation() {
        let rel = Relationship::many_to_one("R", "Sales", "product_id", "Products", "id");
        assert_eq!(rel.propagation(), FilterPropagation::Auto);
    }

    #[test]
    fn one_to_many_defaults_to_none_propagation() {
        let rel = Relationship::new(
            "R",
            "Products",
            "id",
            "Sales",
            "product_id",
            Cardinality::OneToMany,
        );
        assert_eq!(rel.propagation(), FilterPropagation::None);
    }

    #[test]
    fn with_propagation_overrides_default() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id")
            .with_propagation(FilterPropagation::Both);
        assert_eq!(rel.propagation(), FilterPropagation::Both);
    }

    #[test]
    fn propagation_serialization_roundtrip() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id")
            .with_propagation(FilterPropagation::Both);
        let json = serde_json::to_string(&rel).unwrap();
        let deserialized: Relationship = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.propagation(), FilterPropagation::Both);
    }

    #[test]
    fn deserialize_without_propagation_defaults_to_auto() {
        // Simulate legacy JSON without propagation field
        let json = r#"{
            "name": "R",
            "from_table": "Sales",
            "from_column": "pid",
            "to_table": "Products",
            "to_column": "id",
            "cardinality": "ManyToOne"
        }"#;
        let rel: Relationship = serde_json::from_str(json).unwrap();
        assert_eq!(rel.propagation(), FilterPropagation::Auto);
    }
}
