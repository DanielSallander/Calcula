//! Relationship definitions for the data model.
//!
//! A relationship connects columns in one table (the "from" side, typically
//! the fact/many side) to columns in another table (the "to" side, typically
//! the dimension/one side). Standard relationships use equality joins, but
//! advanced relationships can use comparison operators (`>`, `>=`, `<`, `<=`)
//! for range-based joins (e.g., BETWEEN date ranges, price tiers).

use serde::{Deserialize, Serialize};

/// The comparison operator used in a join condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JoinOperator {
    /// Equality join (`=`). The standard equi-join.
    Equal,
    /// Greater-than join (`>`).
    GreaterThan,
    /// Greater-than-or-equal join (`>=`).
    GreaterThanOrEqual,
    /// Less-than join (`<`).
    LessThan,
    /// Less-than-or-equal join (`<=`).
    LessThanOrEqual,
}

impl JoinOperator {
    /// Returns the SQL representation of this operator.
    pub fn as_sql(&self) -> &'static str {
        match self {
            Self::Equal => "=",
            Self::GreaterThan => ">",
            Self::GreaterThanOrEqual => ">=",
            Self::LessThan => "<",
            Self::LessThanOrEqual => "<=",
        }
    }
}

/// A single condition in a relationship join.
///
/// Each condition pairs a column from the "from" table with a column from the
/// "to" table, connected by a [`JoinOperator`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinCondition {
    from_column: String,
    to_column: String,
    operator: JoinOperator,
}

impl JoinCondition {
    /// Create a new join condition with an explicit operator.
    pub fn new(
        from_column: impl Into<String>,
        to_column: impl Into<String>,
        operator: JoinOperator,
    ) -> Self {
        Self {
            from_column: from_column.into(),
            to_column: to_column.into(),
            operator,
        }
    }

    /// Create an equality join condition (the most common case).
    pub fn equal(from_column: impl Into<String>, to_column: impl Into<String>) -> Self {
        Self::new(from_column, to_column, JoinOperator::Equal)
    }

    /// Returns the "from" column name.
    pub fn from_column(&self) -> &str {
        &self.from_column
    }

    /// Returns the "to" column name.
    pub fn to_column(&self) -> &str {
        &self.to_column
    }

    /// Returns the join operator.
    pub fn operator(&self) -> JoinOperator {
        self.operator
    }
}

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
    /// Many rows in the "from" table map to many rows in the "to" table.
    /// This is the default for non-equi relationships (range joins, BETWEEN, etc.).
    ManyToMany,
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

/// A relationship between two tables in the data model.
///
/// A relationship connects columns in the "from" table to columns in the
/// "to" table via one or more [`JoinCondition`]s. In star schema terminology,
/// the "from" side is typically the fact table (many side) and the "to" side
/// is the dimension table (one side).
///
/// # Simple Equality Join
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
///
/// # Range Join (BETWEEN)
///
/// ```rust
/// use engine_core::model::{Relationship, JoinCondition, JoinOperator};
///
/// let rel = Relationship::many_to_many(
///     "Sales_DateRange",
///     "Sales", "Periods",
///     vec![
///         JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
///         JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
///     ],
/// );
/// assert!(!rel.is_equi_only());
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Relationship {
    name: String,
    from_table: String,
    to_table: String,
    conditions: Vec<JoinCondition>,
    cardinality: Cardinality,
    #[serde(default = "default_propagation")]
    propagation: FilterPropagation,
}

fn default_propagation() -> FilterPropagation {
    FilterPropagation::Auto
}

impl Relationship {
    /// Create a new single-condition equality relationship with explicit cardinality.
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
            to_table: to_table.into(),
            conditions: vec![JoinCondition::equal(from_column, to_column)],
            cardinality,
            propagation,
        }
    }

    /// Create a relationship with multiple join conditions and explicit cardinality.
    pub fn with_conditions(
        name: impl Into<String>,
        from_table: impl Into<String>,
        to_table: impl Into<String>,
        conditions: Vec<JoinCondition>,
        cardinality: Cardinality,
    ) -> Self {
        let propagation = match cardinality {
            Cardinality::ManyToOne => FilterPropagation::Auto,
            _ => FilterPropagation::None,
        };
        Self {
            name: name.into(),
            from_table: from_table.into(),
            to_table: to_table.into(),
            conditions,
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

    /// Create a many-to-many relationship with multiple join conditions.
    ///
    /// This is the standard constructor for non-equi (range) relationships.
    /// Filter propagation defaults to [`None`](FilterPropagation::None).
    pub fn many_to_many(
        name: impl Into<String>,
        from_table: impl Into<String>,
        to_table: impl Into<String>,
        conditions: Vec<JoinCondition>,
    ) -> Self {
        Self::with_conditions(
            name,
            from_table,
            to_table,
            conditions,
            Cardinality::ManyToMany,
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

    /// Returns the "from" column of the first join condition.
    ///
    /// This is a convenience accessor for single-condition relationships.
    /// For multi-condition relationships, use [`conditions()`](Self::conditions).
    pub fn from_column(&self) -> &str {
        self.conditions[0].from_column()
    }

    /// Returns the name of the "to" table (typically the dimension/one side).
    pub fn to_table(&self) -> &str {
        &self.to_table
    }

    /// Returns the "to" column of the first join condition.
    ///
    /// This is a convenience accessor for single-condition relationships.
    /// For multi-condition relationships, use [`conditions()`](Self::conditions).
    pub fn to_column(&self) -> &str {
        self.conditions[0].to_column()
    }

    /// Returns all join conditions in this relationship.
    pub fn conditions(&self) -> &[JoinCondition] {
        &self.conditions
    }

    /// Returns `true` if all join conditions use the equality operator.
    ///
    /// Equi-only relationships can use optimized join paths (DataFusion `.join()` API,
    /// IN-list pushdown). Non-equi relationships fall back to SQL string generation.
    pub fn is_equi_only(&self) -> bool {
        self.conditions
            .iter()
            .all(|c| c.operator == JoinOperator::Equal)
    }

    /// Build the SQL ON clause for this relationship's join conditions.
    ///
    /// `left_alias` and `right_alias` are the SQL aliases for the two tables.
    /// `left_is_from` indicates whether the left alias corresponds to the "from" table.
    ///
    /// # Example
    ///
    /// For a BETWEEN-style relationship with conditions `order_date >= start_date`
    /// and `order_date <= end_date`:
    ///
    /// ```text
    /// build_on_clause("fact", "dim", true)
    /// // → fact."order_date" >= dim."start_date" AND fact."order_date" <= dim."end_date"
    /// ```
    pub fn build_on_clause(
        &self,
        left_alias: &str,
        right_alias: &str,
        left_is_from: bool,
    ) -> String {
        self.conditions
            .iter()
            .map(|c| {
                let (left_col, right_col) = if left_is_from {
                    (c.from_column(), c.to_column())
                } else {
                    (c.to_column(), c.from_column())
                };
                format!(
                    "{left_alias}.\"{left_col}\" {} {right_alias}.\"{right_col}\"",
                    c.operator.as_sql()
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ")
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

    // --- New tests for JoinOperator, JoinCondition, and multi-condition relationships ---

    #[test]
    fn join_operator_as_sql_all_variants() {
        assert_eq!(JoinOperator::Equal.as_sql(), "=");
        assert_eq!(JoinOperator::GreaterThan.as_sql(), ">");
        assert_eq!(JoinOperator::GreaterThanOrEqual.as_sql(), ">=");
        assert_eq!(JoinOperator::LessThan.as_sql(), "<");
        assert_eq!(JoinOperator::LessThanOrEqual.as_sql(), "<=");
    }

    #[test]
    fn join_condition_equal_convenience() {
        let cond = JoinCondition::equal("product_id", "id");
        assert_eq!(cond.from_column(), "product_id");
        assert_eq!(cond.to_column(), "id");
        assert_eq!(cond.operator(), JoinOperator::Equal);
    }

    #[test]
    fn join_condition_with_operator() {
        let cond = JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual);
        assert_eq!(cond.from_column(), "order_date");
        assert_eq!(cond.to_column(), "start_date");
        assert_eq!(cond.operator(), JoinOperator::GreaterThanOrEqual);
    }

    #[test]
    fn relationship_with_multiple_conditions() {
        let rel = Relationship::many_to_many(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
            ],
        );
        assert_eq!(rel.conditions().len(), 2);
        assert_eq!(rel.cardinality(), Cardinality::ManyToMany);
        assert_eq!(rel.propagation(), FilterPropagation::None);
    }

    #[test]
    fn many_to_many_defaults_to_none_propagation() {
        let rel = Relationship::many_to_many("R", "A", "B", vec![JoinCondition::equal("x", "y")]);
        assert_eq!(rel.propagation(), FilterPropagation::None);
    }

    #[test]
    fn is_equi_only_true_for_single_equal() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        assert!(rel.is_equi_only());
    }

    #[test]
    fn is_equi_only_true_for_multiple_equal() {
        let rel = Relationship::with_conditions(
            "R",
            "A",
            "B",
            vec![
                JoinCondition::equal("x1", "y1"),
                JoinCondition::equal("x2", "y2"),
            ],
            Cardinality::OneToOne,
        );
        assert!(rel.is_equi_only());
    }

    #[test]
    fn is_equi_only_false_for_non_equal() {
        let rel = Relationship::many_to_many(
            "R",
            "A",
            "B",
            vec![
                JoinCondition::new("date", "start", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("date", "end", JoinOperator::LessThanOrEqual),
            ],
        );
        assert!(!rel.is_equi_only());
    }

    #[test]
    fn is_equi_only_false_for_mixed() {
        let rel = Relationship::with_conditions(
            "R",
            "A",
            "B",
            vec![
                JoinCondition::equal("id", "id"),
                JoinCondition::new("date", "start", JoinOperator::GreaterThanOrEqual),
            ],
            Cardinality::ManyToMany,
        );
        assert!(!rel.is_equi_only());
    }

    #[test]
    fn build_on_clause_single_equi() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        let clause = rel.build_on_clause("sales", "products", true);
        assert_eq!(clause, r#"sales."pid" = products."id""#);
    }

    #[test]
    fn build_on_clause_between() {
        let rel = Relationship::many_to_many(
            "R",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
            ],
        );
        let clause = rel.build_on_clause("sales", "periods", true);
        assert_eq!(
            clause,
            r#"sales."order_date" >= periods."start_date" AND sales."order_date" <= periods."end_date""#
        );
    }

    #[test]
    fn build_on_clause_reverse_direction() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        // left_is_from=false means left alias is the "to" table
        let clause = rel.build_on_clause("products", "sales", false);
        assert_eq!(clause, r#"products."id" = sales."pid""#);
    }

    #[test]
    fn serialization_roundtrip_with_conditions() {
        let rel = Relationship::many_to_many(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
            ],
        );
        let json = serde_json::to_string(&rel).unwrap();
        let deserialized: Relationship = serde_json::from_str(&json).unwrap();
        assert_eq!(rel, deserialized);
    }
}
