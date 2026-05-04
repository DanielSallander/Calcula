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

    /// Returns the SQL aggregate function to compute the boundary value
    /// for this operator on the **dimension** side of a non-equi relationship.
    ///
    /// When a non-equi relationship is used with a GROUP BY on the dimension,
    /// the DAX semantics are: for each group, a fact row is included if it
    /// matches *any* dimension row in that group. This translates to checking
    /// the fact column against a boundary aggregate of the dimension column.
    ///
    /// - `<=` → fact_col <= MAX(dim_col)  → boundary is `MAX`
    /// - `<`  → fact_col <  MAX(dim_col)  → boundary is `MAX`
    /// - `>=` → fact_col >= MIN(dim_col)  → boundary is `MIN`
    /// - `>`  → fact_col >  MIN(dim_col)  → boundary is `MIN`
    /// - `=`  → not applicable (use equi-join instead)
    pub fn boundary_aggregate(&self) -> &'static str {
        match self {
            Self::LessThan | Self::LessThanOrEqual => "MAX",
            Self::GreaterThan | Self::GreaterThanOrEqual => "MIN",
            Self::Equal => "MIN", // Should not be called for equi-joins.
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
    /// Whether this relationship is the active default between its table pair.
    ///
    /// Only one relationship between any two tables may be active. Inactive
    /// relationships can be activated per-measure via `USERELATIONSHIP`.
    #[serde(default = "default_active")]
    active: bool,
}

fn default_propagation() -> FilterPropagation {
    FilterPropagation::Auto
}

fn default_active() -> bool {
    true
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
            active: true,
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
            active: true,
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

    /// Returns whether this relationship is the active default between its table pair.
    ///
    /// Only one relationship per table pair may be active. Inactive relationships
    /// can be activated per-measure via `USERELATIONSHIP`.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Set whether this relationship is active, returning a modified relationship.
    ///
    /// Use this to create inactive relationships that can be activated via
    /// `USERELATIONSHIP` in measure expressions.
    pub fn with_active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    /// Returns `true` if this relationship is safe for a direct INNER JOIN
    /// without risk of row explosion on the fact (many) side.
    ///
    /// A relationship is safe when:
    /// - Cardinality is [`ManyToOne`](Cardinality::ManyToOne) or
    ///   [`OneToOne`](Cardinality::OneToOne) (each fact row matches at most one
    ///   dimension row)
    /// - All conditions use equality (enables hash-join optimization)
    ///
    /// For [`ManyToMany`](Cardinality::ManyToMany) or non-equi relationships,
    /// a semi-join (`EXISTS`) or pre-aggregation strategy should be used instead
    /// to prevent duplicate fact rows from inflating aggregation results.
    pub fn is_safe_for_direct_join(&self) -> bool {
        matches!(
            self.cardinality,
            Cardinality::ManyToOne | Cardinality::OneToOne
        ) && self.is_equi_only()
    }

    /// Try to build a scalar boundary clause instead of a correlated `EXISTS`.
    ///
    /// For relationships with a **single** non-equi condition, the correlated
    /// `EXISTS` subquery can be replaced by a scalar boundary check that is
    /// orders of magnitude faster:
    ///
    /// ```text
    /// -- Instead of (O(n*m) correlated scan):
    /// WHERE EXISTS (SELECT 1 FROM dim AS __d WHERE fact."col" <= __d."col")
    ///
    /// -- Use (O(n + m) scalar subquery):
    /// WHERE fact."col" <= (SELECT MAX(__d."col") FROM dim AS __d)
    /// ```
    ///
    /// Returns `None` when the optimization is not applicable:
    /// - Multiple conditions (e.g., BETWEEN needs both conditions on the same row)
    /// - All conditions are equality (use equi-join instead)
    ///
    /// `dim_filters` are optional additional WHERE conditions on the dimension
    /// table (applied inside the scalar subquery).
    pub fn build_boundary_clause(
        &self,
        fact_alias: &str,
        dim_table: &str,
        fact_is_from: bool,
        dim_filters: &[String],
    ) -> Option<String> {
        // Only optimize single-condition non-equi relationships.
        // Multiple conditions may require both to be satisfied by the SAME row,
        // which a per-condition scalar aggregate cannot guarantee.
        if self.conditions.len() != 1 {
            return None;
        }
        let cond = &self.conditions[0];
        if cond.operator == JoinOperator::Equal {
            return None;
        }

        let (fact_col, dim_col) = if fact_is_from {
            (cond.from_column(), cond.to_column())
        } else {
            (cond.to_column(), cond.from_column())
        };

        let agg = cond.operator.boundary_aggregate();

        let dim_where = if dim_filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", dim_filters.join(" AND "))
        };

        Some(format!(
            "{fact_alias}.\"{fact_col}\" {} (SELECT {agg}(__d.\"{dim_col}\") FROM {dim_table} AS __d{dim_where})",
            cond.operator.as_sql()
        ))
    }

    /// Build an `EXISTS` subquery for semi-join filter propagation.
    ///
    /// Returns a SQL fragment like:
    /// ```text
    /// EXISTS (SELECT 1 FROM {dim_table} WHERE {join_conditions} [AND {extra_filters}])
    /// ```
    ///
    /// This is used instead of a direct JOIN when the dimension table's columns
    /// are not needed in the output (filter-only usage) and the relationship is
    /// not safe for direct join. The EXISTS subquery prevents row explosion by
    /// checking for the *existence* of matching rows without duplicating fact rows.
    ///
    /// `fact_alias` is the alias of the fact table in the outer query.
    /// `dim_table` is the table name used inside the subquery.
    /// `fact_is_from` indicates whether the fact table is the "from" side of the relationship.
    /// `dim_filters` are optional additional WHERE conditions on the dimension table
    /// (e.g., context filters resolved to SQL fragments).
    pub fn build_exists_clause(
        &self,
        fact_alias: &str,
        dim_table: &str,
        fact_is_from: bool,
        dim_filters: &[String],
    ) -> String {
        // Build the join conditions referencing the outer fact table
        // and the inner dimension table alias "__d".
        let join_conditions: Vec<String> = self
            .conditions
            .iter()
            .map(|c| {
                let (fact_col, dim_col) = if fact_is_from {
                    (c.from_column(), c.to_column())
                } else {
                    (c.to_column(), c.from_column())
                };
                format!(
                    "{fact_alias}.\"{fact_col}\" {} __d.\"{dim_col}\"",
                    c.operator.as_sql()
                )
            })
            .collect();

        let mut where_parts = join_conditions;
        for f in dim_filters {
            where_parts.push(f.clone());
        }

        format!(
            "EXISTS (SELECT 1 FROM {dim_table} AS __d WHERE {})",
            where_parts.join(" AND ")
        )
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

    // --- Active/inactive relationship tests ---

    #[test]
    fn relationship_defaults_to_active() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        assert!(rel.is_active());
    }

    #[test]
    fn with_active_sets_inactive() {
        let rel =
            Relationship::many_to_one("R", "Sales", "pid", "Products", "id").with_active(false);
        assert!(!rel.is_active());
    }

    #[test]
    fn serde_roundtrip_active_field() {
        let rel =
            Relationship::many_to_one("R", "Sales", "pid", "Products", "id").with_active(false);
        let json = serde_json::to_string(&rel).unwrap();
        let deserialized: Relationship = serde_json::from_str(&json).unwrap();
        assert!(!deserialized.is_active());
    }

    #[test]
    fn serde_backward_compat_no_active_field() {
        // JSON without "active" field should deserialize as active (default true).
        let json = r#"{
            "name": "R",
            "from_table": "Sales",
            "to_table": "Products",
            "conditions": [{"from_column": "pid", "to_column": "id", "operator": "Equal"}],
            "cardinality": "ManyToOne",
            "propagation": "Auto"
        }"#;
        let rel: Relationship = serde_json::from_str(json).unwrap();
        assert!(rel.is_active());
    }

    #[test]
    fn with_conditions_defaults_to_active() {
        let rel = Relationship::with_conditions(
            "R",
            "A",
            "B",
            vec![JoinCondition::equal("x", "y")],
            Cardinality::OneToOne,
        );
        assert!(rel.is_active());
    }

    #[test]
    fn many_to_many_defaults_to_active() {
        let rel = Relationship::many_to_many("R", "A", "B", vec![JoinCondition::equal("x", "y")]);
        assert!(rel.is_active());
    }

    // --- is_safe_for_direct_join tests ---

    #[test]
    fn safe_for_direct_join_many_to_one_equi() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        assert!(rel.is_safe_for_direct_join());
    }

    #[test]
    fn safe_for_direct_join_one_to_one_equi() {
        let rel = Relationship::with_conditions(
            "R",
            "A",
            "B",
            vec![JoinCondition::equal("x", "y")],
            Cardinality::OneToOne,
        );
        assert!(rel.is_safe_for_direct_join());
    }

    #[test]
    fn not_safe_for_direct_join_many_to_many() {
        let rel = Relationship::many_to_many("R", "A", "B", vec![JoinCondition::equal("x", "y")]);
        assert!(!rel.is_safe_for_direct_join());
    }

    #[test]
    fn not_safe_for_direct_join_one_to_many() {
        let rel = Relationship::new("R", "A", "x", "B", "y", Cardinality::OneToMany);
        assert!(!rel.is_safe_for_direct_join());
    }

    #[test]
    fn not_safe_for_direct_join_non_equi() {
        let rel = Relationship::many_to_many(
            "R",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
            ],
        );
        assert!(!rel.is_safe_for_direct_join());
    }

    // --- build_exists_clause tests ---

    #[test]
    fn build_exists_clause_equi_no_filters() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        let clause = rel.build_exists_clause("sales", "products", true, &[]);
        assert_eq!(
            clause,
            r#"EXISTS (SELECT 1 FROM products AS __d WHERE sales."pid" = __d."id")"#
        );
    }

    #[test]
    fn build_exists_clause_between_no_filters() {
        let rel = Relationship::many_to_many(
            "R",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
            ],
        );
        let clause = rel.build_exists_clause("sales", "periods", true, &[]);
        assert_eq!(
            clause,
            r#"EXISTS (SELECT 1 FROM periods AS __d WHERE sales."order_date" >= __d."start_date" AND sales."order_date" <= __d."end_date")"#
        );
    }

    #[test]
    fn build_exists_clause_with_dim_filters() {
        let rel = Relationship::many_to_many(
            "R",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
            ],
        );
        let filters = vec![r#"__d."name" = 'Q1'"#.to_string()];
        let clause = rel.build_exists_clause("sales", "periods", true, &filters);
        assert_eq!(
            clause,
            r#"EXISTS (SELECT 1 FROM periods AS __d WHERE sales."order_date" >= __d."start_date" AND sales."order_date" <= __d."end_date" AND __d."name" = 'Q1')"#
        );
    }

    #[test]
    fn build_exists_clause_reverse_direction() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        // fact_is_from=false means fact is the "to" table
        let clause = rel.build_exists_clause("products", "sales", false, &[]);
        assert_eq!(
            clause,
            r#"EXISTS (SELECT 1 FROM sales AS __d WHERE products."id" = __d."pid")"#
        );
    }

    // --- build_boundary_clause tests ---

    #[test]
    fn boundary_clause_single_lte_condition() {
        let rel = Relationship::many_to_many(
            "Sales_Date",
            "Sales",
            "Dates",
            vec![JoinCondition::new(
                "order_date",
                "datekey",
                JoinOperator::LessThanOrEqual,
            )],
        );
        let clause = rel.build_boundary_clause("sales", "dates", true, &[]);
        assert_eq!(
            clause,
            Some(
                r#"sales."order_date" <= (SELECT MAX(__d."datekey") FROM dates AS __d)"#
                    .to_string()
            )
        );
    }

    #[test]
    fn boundary_clause_single_gte_condition() {
        let rel = Relationship::many_to_many(
            "Sales_Date",
            "Sales",
            "Dates",
            vec![JoinCondition::new(
                "order_date",
                "start_date",
                JoinOperator::GreaterThanOrEqual,
            )],
        );
        let clause = rel.build_boundary_clause("sales", "dates", true, &[]);
        assert_eq!(
            clause,
            Some(
                r#"sales."order_date" >= (SELECT MIN(__d."start_date") FROM dates AS __d)"#
                    .to_string()
            )
        );
    }

    #[test]
    fn boundary_clause_with_dim_filters() {
        let rel = Relationship::many_to_many(
            "Sales_Date",
            "Sales",
            "Dates",
            vec![JoinCondition::new(
                "order_date",
                "datekey",
                JoinOperator::LessThanOrEqual,
            )],
        );
        let filters = vec![r#"__d."year" = '2024'"#.to_string()];
        let clause = rel.build_boundary_clause("sales", "dates", true, &filters);
        assert_eq!(
            clause,
            Some(
                r#"sales."order_date" <= (SELECT MAX(__d."datekey") FROM dates AS __d WHERE __d."year" = '2024')"#.to_string()
            )
        );
    }

    #[test]
    fn boundary_clause_returns_none_for_multiple_conditions() {
        let rel = Relationship::many_to_many(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
            ],
        );
        assert!(rel
            .build_boundary_clause("sales", "periods", true, &[])
            .is_none());
    }

    #[test]
    fn boundary_clause_returns_none_for_equi_join() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        assert!(rel
            .build_boundary_clause("sales", "products", true, &[])
            .is_none());
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
