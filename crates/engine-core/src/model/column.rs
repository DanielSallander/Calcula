//! Column definition for the data model.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::types::DataType;

/// The calendar role a column plays on a date table.
///
/// Date roles are the metadata that powers time-intelligence functions
/// (`YTD`, `QTD`, `MTD`, `PRIORYEAR`, `PRIORPERIOD`): the engine uses them
/// to find the year/quarter/month/... axis columns of the model's marked
/// date table (see `DataModelBuilder::mark_date_table`). Roles are ordered
/// coarse to fine: `Year` → `Quarter` → `Month` → `Week` → `Day` →
/// `DateKey`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DateRole {
    /// Calendar year (e.g. `2024`).
    Year,
    /// Quarter within the year (e.g. `1`–`4` or `"Q1"`).
    Quarter,
    /// Month within the year (e.g. `1`–`12`).
    Month,
    /// Week within the year (e.g. `1`–`53`).
    Week,
    /// Day within the month (e.g. `1`–`31`).
    Day,
    /// The full date key column (`Date` or `Timestamp` typed).
    DateKey,
}

impl DateRole {
    /// Coarse-to-fine ordering rank: `Year` = 0 … `DateKey` = 5.
    ///
    /// A larger rank means a finer granularity.
    pub fn rank(&self) -> u8 {
        match self {
            DateRole::Year => 0,
            DateRole::Quarter => 1,
            DateRole::Month => 2,
            DateRole::Week => 3,
            DateRole::Day => 4,
            DateRole::DateKey => 5,
        }
    }
}

impl std::fmt::Display for DateRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DateRole::Year => write!(f, "Year"),
            DateRole::Quarter => write!(f, "Quarter"),
            DateRole::Month => write!(f, "Month"),
            DateRole::Week => write!(f, "Week"),
            DateRole::Day => write!(f, "Day"),
            DateRole::DateKey => write!(f, "DateKey"),
        }
    }
}

/// A column definition within a table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
    name: String,
    data_type: DataType,
    nullable: bool,
    /// Optional resolution expression for when this column is used as a lookup
    /// (post-aggregation) instead of a GROUP BY column.
    ///
    /// When a column appears as a lookup in a query, the join back to the
    /// dimension table may produce multiple rows per key (1:many). This
    /// expression controls how those multiple values are resolved into a
    /// single value. Uses the same expression syntax as measures.
    ///
    /// Examples: `"MIN(col)"`, `"IF(DISTINCTCOUNT(col) > 1, \"*\", MIN(col))"`
    ///
    /// If `None`, the model-level `default_lookup_resolution` is used when
    /// set (it references the lookup column via the `__column` placeholder).
    /// Otherwise the built-in fallback applies: for `String` columns,
    /// SELECTEDVALUE-style semantics
    /// (`CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE '#' END`);
    /// for all other column types, `MIN(col)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lookup_resolution: Option<String>,
    /// Optional column name used for sorting this column's values.
    ///
    /// When this column appears in a GROUP BY or on a pivot table axis,
    /// results should be ordered by the sort-by column instead of by this
    /// column's own values. Both columns must belong to the same table.
    ///
    /// Classic example: a "MonthName" column sorted by a "MonthNumber" column
    /// so that month names appear in calendar order rather than alphabetical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sort_by_column: Option<String>,
    /// Optional human-friendly name shown by host applications instead of
    /// the physical column name. Purely presentational — queries and
    /// expressions always use the physical name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    /// Human-readable description shown by host applications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    /// Whether host applications should hide this column from end-user
    /// field lists. Purely presentational — hidden columns remain fully
    /// queryable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    is_hidden: bool,
    /// Aggregation a host should apply when the user drags this column
    /// into a values area without choosing one explicitly. Purely a host
    /// hint — the engine never applies it implicitly and does not check
    /// it against the column's data type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_aggregation: Option<AggregateOp>,
    /// The calendar role this column plays on a date table.
    ///
    /// Only meaningful on the table marked as the model's date table
    /// (`DataModelBuilder::mark_date_table`), where it enables
    /// time-intelligence functions (`YTD`, `PRIORYEAR`, …). On other
    /// tables the role is inert metadata. Validation (on the marked
    /// table) enforces at most one column per role and role-appropriate
    /// data types.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    date_role: Option<DateRole>,
}

impl Column {
    /// Create a new column definition.
    pub fn new(name: impl Into<String>, data_type: DataType) -> Self {
        Self {
            name: name.into(),
            data_type,
            nullable: true,
            lookup_resolution: None,
            sort_by_column: None,
            display_name: None,
            description: None,
            is_hidden: false,
            default_aggregation: None,
            date_role: None,
        }
    }

    /// Create a non-nullable column.
    pub fn non_nullable(name: impl Into<String>, data_type: DataType) -> Self {
        Self {
            nullable: false,
            ..Self::new(name, data_type)
        }
    }

    /// Set the lookup resolution expression for this column.
    ///
    /// When this column is used as a lookup (post-aggregation) in a query,
    /// this expression controls how 1:many values are resolved.
    /// Uses the same expression syntax as measures.
    pub fn with_lookup_resolution(mut self, expr: impl Into<String>) -> Self {
        self.lookup_resolution = Some(expr.into());
        self
    }

    /// Returns the lookup resolution expression, if set.
    pub fn lookup_resolution(&self) -> Option<&str> {
        self.lookup_resolution.as_deref()
    }

    /// Set the sort-by column for this column.
    ///
    /// When this column appears in a GROUP BY or on a pivot table axis,
    /// results should be ordered by the named column instead. Both columns
    /// must belong to the same table (validated at model build time).
    pub fn with_sort_by(mut self, column: impl Into<String>) -> Self {
        self.sort_by_column = Some(column.into());
        self
    }

    /// Returns the sort-by column name, if set.
    pub fn sort_by_column(&self) -> Option<&str> {
        self.sort_by_column.as_deref()
    }

    /// Set the human-friendly display name for this column.
    ///
    /// Purely presentational — hosts show it instead of the physical
    /// column name; queries and expressions always use the physical name.
    pub fn with_display_name(mut self, display_name: impl Into<String>) -> Self {
        self.display_name = Some(display_name.into());
        self
    }

    /// Returns the display name, if set.
    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }

    /// Set the human-readable description of this column.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Returns the description, if any.
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    /// Mark this column as hidden from end-user field lists.
    ///
    /// Hiding is purely presentational — hidden columns remain fully
    /// queryable (e.g. foreign-key columns used only by relationships).
    pub fn hidden(mut self) -> Self {
        self.is_hidden = true;
        self
    }

    /// Returns `true` if host applications should hide this column from
    /// end-user field lists.
    pub fn is_hidden(&self) -> bool {
        self.is_hidden
    }

    /// Set the default aggregation a host should apply when the user drags
    /// this column into a values area.
    ///
    /// Purely a host hint — the engine never applies it implicitly and
    /// does not check it against the column's data type.
    pub fn with_default_aggregation(mut self, operation: AggregateOp) -> Self {
        self.default_aggregation = Some(operation);
        self
    }

    /// Returns the default aggregation hint, if set.
    pub fn default_aggregation(&self) -> Option<AggregateOp> {
        self.default_aggregation
    }

    /// Set the calendar role this column plays on a date table.
    ///
    /// Date roles enable time-intelligence functions (`YTD`, `QTD`, `MTD`,
    /// `PRIORYEAR`, `PRIORPERIOD`) once the column's table is marked as the
    /// model's date table via `DataModelBuilder::mark_date_table`. Each role
    /// may appear on at most one column of the date table (validated at
    /// model build time).
    pub fn with_date_role(mut self, role: DateRole) -> Self {
        self.date_role = Some(role);
        self
    }

    /// Returns the calendar role of this column, if set.
    pub fn date_role(&self) -> Option<DateRole> {
        self.date_role
    }

    /// Returns the column name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the column data type.
    pub fn data_type(&self) -> &DataType {
        &self.data_type
    }

    /// Returns whether this column accepts null values.
    pub fn nullable(&self) -> bool {
        self.nullable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_metadata_builders_and_getters() {
        let col = Column::new("unit_price", DataType::Float64)
            .with_display_name("Unit Price")
            .with_description("Price per unit in USD")
            .with_default_aggregation(AggregateOp::Average)
            .hidden();
        assert_eq!(col.display_name(), Some("Unit Price"));
        assert_eq!(col.description(), Some("Price per unit in USD"));
        assert_eq!(col.default_aggregation(), Some(AggregateOp::Average));
        assert!(col.is_hidden());
    }

    #[test]
    fn column_metadata_defaults_to_absent_and_visible() {
        let col = Column::new("amount", DataType::Float64);
        assert_eq!(col.display_name(), None);
        assert_eq!(col.description(), None);
        assert_eq!(col.default_aggregation(), None);
        assert!(!col.is_hidden());

        let non_nullable = Column::non_nullable("id", DataType::Int64);
        assert!(!non_nullable.nullable());
        assert!(!non_nullable.is_hidden());
        assert_eq!(non_nullable.default_aggregation(), None);
    }

    #[test]
    fn column_metadata_round_trips_through_serde() {
        let col = Column::new("amount", DataType::Float64)
            .with_display_name("Amount")
            .with_description("Sale amount")
            .with_default_aggregation(AggregateOp::Sum)
            .hidden();

        let json = serde_json::to_string(&col).unwrap();
        let restored: Column = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, col);
        assert_eq!(restored.display_name(), Some("Amount"));
        assert_eq!(restored.description(), Some("Sale amount"));
        assert_eq!(restored.default_aggregation(), Some(AggregateOp::Sum));
        assert!(restored.is_hidden());
    }

    #[test]
    fn absent_column_metadata_is_skipped_in_json_and_defaults_on_load() {
        let col = Column::new("amount", DataType::Float64);
        let json = serde_json::to_string(&col).unwrap();
        // Legacy-compatible output: absent metadata writes no fields.
        assert!(!json.contains("\"display_name\""));
        assert!(!json.contains("\"description\""));
        assert!(!json.contains("\"is_hidden\""));
        assert!(!json.contains("\"default_aggregation\""));

        let restored: Column = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, col);
        assert!(!restored.is_hidden());
    }

    #[test]
    fn legacy_column_json_without_metadata_loads_with_defaults() {
        let json = r#"{"name": "amount", "data_type": "Float64", "nullable": true}"#;
        let restored: Column = serde_json::from_str(json).unwrap();
        assert_eq!(restored.name(), "amount");
        assert_eq!(restored.display_name(), None);
        assert_eq!(restored.description(), None);
        assert_eq!(restored.default_aggregation(), None);
        assert!(!restored.is_hidden());
        assert_eq!(restored.date_role(), None);
    }

    #[test]
    fn date_role_builder_getter_and_serde_round_trip() {
        let col = Column::new("year", DataType::Int32).with_date_role(DateRole::Year);
        assert_eq!(col.date_role(), Some(DateRole::Year));

        let json = serde_json::to_string(&col).unwrap();
        assert!(json.contains("\"date_role\""));
        let restored: Column = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, col);
        assert_eq!(restored.date_role(), Some(DateRole::Year));
    }

    #[test]
    fn absent_date_role_is_skipped_in_json_and_defaults_to_none() {
        let col = Column::new("amount", DataType::Float64);
        let json = serde_json::to_string(&col).unwrap();
        assert!(!json.contains("\"date_role\""));
        let restored: Column = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.date_role(), None);
    }

    #[test]
    fn date_role_rank_orders_coarse_to_fine() {
        assert!(DateRole::Year.rank() < DateRole::Quarter.rank());
        assert!(DateRole::Quarter.rank() < DateRole::Month.rank());
        assert!(DateRole::Month.rank() < DateRole::Week.rank());
        assert!(DateRole::Week.rank() < DateRole::Day.rank());
        assert!(DateRole::Day.rank() < DateRole::DateKey.rank());
    }
}
