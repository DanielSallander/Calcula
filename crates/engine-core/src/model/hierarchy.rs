//! Hierarchy definitions for the data model.
//!
//! A hierarchy is an ordered sequence of levels (columns) within a single
//! table that defines a drill-down path. Hierarchies are typically defined
//! on dimension tables — for example, a geography dimension might have
//! a hierarchy Country → State → City.
//!
//! ## Ragged hierarchies
//!
//! A ragged hierarchy is one where not all branches extend to the same
//! depth. For example, "Washington DC" has no state — it goes directly
//! from Country to City. The [`RaggedBehavior`] enum lets model designers
//! control how these incomplete branches are presented:
//!
//! - **ShowBlanks** (default) — null levels appear as empty cells
//! - **HideMembers** — skip blank levels, the branch appears shorter
//! - **RepeatParent** — fill blank levels with the parent level's value
//! - **ShowAsLeaf** — treat incomplete paths as leaf nodes at their natural level
//!
//! Individual levels can be marked as [`optional`](HierarchyLevel::is_optional),
//! indicating that blanks are expected at that level. The first and last
//! levels of a hierarchy must always be required.

use serde::{Deserialize, Serialize};

/// Controls how ragged (uneven-depth) hierarchies are displayed.
///
/// A ragged hierarchy has branches where some intermediate levels are
/// null. This enum determines the presentation strategy for those gaps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum RaggedBehavior {
    /// Null levels appear as empty cells (default, matches Power BI).
    #[default]
    ShowBlanks,
    /// Skip blank levels — the branch appears shorter in the output.
    HideMembers,
    /// Fill blank levels by repeating the nearest non-blank parent value.
    RepeatParent,
    /// Treat rows with incomplete paths as leaf nodes at their natural level.
    ShowAsLeaf,
}

/// A single level within a hierarchy.
///
/// Each level references a column in the hierarchy's table. Levels can
/// have an optional display name (for presentation) and can be marked
/// as optional to indicate that blanks are expected (ragged hierarchy).
///
/// # Example
///
/// ```
/// use engine_core::model::hierarchy::HierarchyLevel;
///
/// let level = HierarchyLevel::new("state")
///     .with_display_name("State/Province")
///     .with_optional(true);
/// assert_eq!(level.column(), "state");
/// assert_eq!(level.display_name(), Some("State/Province"));
/// assert!(level.is_optional());
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HierarchyLevel {
    column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(default)]
    optional: bool,
    /// A custom value that marks "this branch stops here" at this level.
    ///
    /// When set, the engine treats this value as a hierarchy stopper —
    /// semantically equivalent to NULL for ragged hierarchy purposes.
    /// Only valid on optional levels; the builder rejects stopper values
    /// on required levels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stopper_value: Option<String>,
}

impl HierarchyLevel {
    /// Create a new hierarchy level referencing a column.
    pub fn new(column: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            display_name: None,
            optional: false,
            stopper_value: None,
        }
    }

    /// Set a display name for this level.
    pub fn with_display_name(mut self, name: impl Into<String>) -> Self {
        self.display_name = Some(name.into());
        self
    }

    /// Mark this level as optional (blanks expected in ragged hierarchies).
    pub fn with_optional(mut self, optional: bool) -> Self {
        self.optional = optional;
        self
    }

    /// Set a custom stopper value for this optional level.
    ///
    /// When a row contains this value at this level, the engine treats
    /// the branch as stopping here — equivalent to NULL for ragged
    /// hierarchy purposes. This is only valid on optional levels;
    /// model validation rejects stopper values on required levels.
    ///
    /// # Example
    ///
    /// ```
    /// use engine_core::model::hierarchy::HierarchyLevel;
    ///
    /// let level = HierarchyLevel::new("state")
    ///     .with_optional(true)
    ///     .with_stopper_value("#");
    /// assert_eq!(level.stopper_value(), Some("#"));
    /// ```
    pub fn with_stopper_value(mut self, value: impl Into<String>) -> Self {
        self.stopper_value = Some(value.into());
        self
    }

    /// Returns the column name for this level.
    pub fn column(&self) -> &str {
        &self.column
    }

    /// Returns the display name, if set.
    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }

    /// Returns whether this level is optional (blanks expected).
    pub fn is_optional(&self) -> bool {
        self.optional
    }

    /// Returns the custom stopper value, if set.
    pub fn stopper_value(&self) -> Option<&str> {
        self.stopper_value.as_deref()
    }
}

/// A named hierarchy: an ordered sequence of drill-down levels on a table.
///
/// Hierarchies define how users navigate from coarse to fine granularity
/// within a dimension table. Each level references a column in the table,
/// and the order of levels defines the drill path.
///
/// # Example
///
/// ```
/// use engine_core::model::hierarchy::{Hierarchy, HierarchyLevel, RaggedBehavior};
///
/// let hierarchy = Hierarchy::new(
///     "Geography",
///     "dim_geography",
///     vec![
///         HierarchyLevel::new("country"),
///         HierarchyLevel::new("state").with_optional(true),
///         HierarchyLevel::new("city"),
///     ],
/// )
/// .with_ragged_behavior(RaggedBehavior::RepeatParent);
///
/// assert_eq!(hierarchy.name(), "Geography");
/// assert_eq!(hierarchy.table(), "dim_geography");
/// assert_eq!(hierarchy.levels().len(), 3);
/// assert_eq!(hierarchy.ragged_behavior(), RaggedBehavior::RepeatParent);
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hierarchy {
    name: String,
    table: String,
    levels: Vec<HierarchyLevel>,
    #[serde(default)]
    ragged_behavior: RaggedBehavior,
}

impl Hierarchy {
    /// Create a new hierarchy on a table with the given levels.
    pub fn new(
        name: impl Into<String>,
        table: impl Into<String>,
        levels: Vec<HierarchyLevel>,
    ) -> Self {
        Self {
            name: name.into(),
            table: table.into(),
            levels,
            ragged_behavior: RaggedBehavior::default(),
        }
    }

    /// Set the ragged hierarchy behavior.
    pub fn with_ragged_behavior(mut self, behavior: RaggedBehavior) -> Self {
        self.ragged_behavior = behavior;
        self
    }

    /// Returns the hierarchy name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the table this hierarchy belongs to.
    pub fn table(&self) -> &str {
        &self.table
    }

    /// Returns the ordered list of levels.
    pub fn levels(&self) -> &[HierarchyLevel] {
        &self.levels
    }

    /// Returns the ragged hierarchy behavior.
    pub fn ragged_behavior(&self) -> RaggedBehavior {
        self.ragged_behavior
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hierarchy_creation() {
        let h = Hierarchy::new(
            "Geography",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("state"),
                HierarchyLevel::new("city"),
            ],
        );
        assert_eq!(h.name(), "Geography");
        assert_eq!(h.table(), "dim_geography");
        assert_eq!(h.levels().len(), 3);
        assert_eq!(h.levels()[0].column(), "country");
        assert_eq!(h.levels()[1].column(), "state");
        assert_eq!(h.levels()[2].column(), "city");
    }

    #[test]
    fn hierarchy_level_with_display_name() {
        let level = HierarchyLevel::new("state").with_display_name("State/Province");
        assert_eq!(level.display_name(), Some("State/Province"));
    }

    #[test]
    fn hierarchy_level_no_display_name() {
        let level = HierarchyLevel::new("state");
        assert_eq!(level.display_name(), None);
    }

    #[test]
    fn hierarchy_level_optional_flag() {
        let level = HierarchyLevel::new("state").with_optional(true);
        assert!(level.is_optional());

        let required = HierarchyLevel::new("country");
        assert!(!required.is_optional());
    }

    #[test]
    fn hierarchy_with_ragged_behavior() {
        let h = Hierarchy::new(
            "Org",
            "dim_org",
            vec![HierarchyLevel::new("level1"), HierarchyLevel::new("level2")],
        )
        .with_ragged_behavior(RaggedBehavior::RepeatParent);
        assert_eq!(h.ragged_behavior(), RaggedBehavior::RepeatParent);
    }

    #[test]
    fn hierarchy_default_ragged_behavior() {
        let h = Hierarchy::new(
            "H",
            "t",
            vec![HierarchyLevel::new("a"), HierarchyLevel::new("b")],
        );
        assert_eq!(h.ragged_behavior(), RaggedBehavior::ShowBlanks);
    }

    #[test]
    fn hierarchy_serialization_roundtrip() {
        let h = Hierarchy::new(
            "Geography",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("state")
                    .with_display_name("State/Province")
                    .with_optional(true),
                HierarchyLevel::new("city"),
            ],
        )
        .with_ragged_behavior(RaggedBehavior::HideMembers);

        let json = serde_json::to_string(&h).unwrap();
        let deserialized: Hierarchy = serde_json::from_str(&json).unwrap();
        assert_eq!(h, deserialized);
    }

    #[test]
    fn hierarchy_level_stopper_value() {
        let level = HierarchyLevel::new("state")
            .with_optional(true)
            .with_stopper_value("#");
        assert_eq!(level.stopper_value(), Some("#"));
    }

    #[test]
    fn hierarchy_level_no_stopper_value() {
        let level = HierarchyLevel::new("state").with_optional(true);
        assert_eq!(level.stopper_value(), None);
    }

    #[test]
    fn hierarchy_level_serde_defaults() {
        // Deserialize without optional fields — should get defaults.
        let json = r#"{"column":"state"}"#;
        let level: HierarchyLevel = serde_json::from_str(json).unwrap();
        assert_eq!(level.column(), "state");
        assert_eq!(level.display_name(), None);
        assert!(!level.is_optional());
        assert_eq!(level.stopper_value(), None);
    }

    #[test]
    fn hierarchy_level_stopper_value_serde_roundtrip() {
        let level = HierarchyLevel::new("state")
            .with_optional(true)
            .with_stopper_value("#");
        let json = serde_json::to_string(&level).unwrap();
        assert!(json.contains("\"stopper_value\":\"#\""));
        let deserialized: HierarchyLevel = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.stopper_value(), Some("#"));
    }

    #[test]
    fn hierarchy_level_stopper_value_omitted_when_none() {
        let level = HierarchyLevel::new("state").with_optional(true);
        let json = serde_json::to_string(&level).unwrap();
        assert!(!json.contains("stopper_value"));
    }

    #[test]
    fn hierarchy_serde_without_ragged_behavior() {
        // Deserialize without ragged_behavior — should default to ShowBlanks.
        let json = r#"{"name":"H","table":"t","levels":[{"column":"a"},{"column":"b"}]}"#;
        let h: Hierarchy = serde_json::from_str(json).unwrap();
        assert_eq!(h.ragged_behavior(), RaggedBehavior::ShowBlanks);
    }
}
