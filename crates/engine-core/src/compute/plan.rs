//! Execution plan visualization types.
//!
//! A hierarchical tree of [`PlanNode`] values describes how a query was
//! executed: which phases ran, what decisions were made, and how long
//! each step took. The tree is serializable to JSON so host applications
//! can render it for users.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The top-level execution plan for a query.
///
/// Returned by `Engine::query_explained()` alongside the query results.
///
/// # Example
///
/// ```
/// use engine_core::compute::plan::*;
///
/// let plan = ExecutionPlan {
///     summary: "Query: [Revenue]".into(),
///     total_duration: PlanDuration::from_ms(42.5),
///     root: PlanNode::new(PlanOperation::Planning, "Query Execution"),
/// };
/// let json = serde_json::to_string_pretty(&plan).unwrap();
/// assert!(json.contains("Revenue"));
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    /// Human-readable summary of the query.
    pub summary: String,
    /// Total wall-clock duration of the entire query.
    pub total_duration: PlanDuration,
    /// Root node of the plan tree.
    pub root: PlanNode,
}

/// A single node in the execution plan tree.
///
/// Each node describes one phase of execution: planning, fetching,
/// joining, aggregating, context resolution, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanNode {
    /// What kind of operation this node represents.
    pub operation: PlanOperation,
    /// Human-readable label for display.
    pub label: String,
    /// Wall-clock duration of this node.
    pub duration: PlanDuration,
    /// Detailed properties specific to this operation.
    pub properties: Vec<PlanProperty>,
    /// Child nodes (sub-phases).
    pub children: Vec<PlanNode>,
}

impl PlanNode {
    /// Create a new plan node with zero duration and no properties.
    pub fn new(operation: PlanOperation, label: impl Into<String>) -> Self {
        Self {
            operation,
            label: label.into(),
            duration: PlanDuration::ZERO,
            properties: Vec::new(),
            children: Vec::new(),
        }
    }

    /// Set the duration from a `std::time::Duration`.
    pub fn with_duration(mut self, duration: Duration) -> Self {
        self.duration = duration.into();
        self
    }

    /// Add a property.
    pub fn with_property(mut self, key: impl Into<String>, value: PlanValue) -> Self {
        self.properties.push(PlanProperty {
            key: key.into(),
            value,
        });
        self
    }

    /// Add a child node.
    pub fn with_child(mut self, child: PlanNode) -> Self {
        self.children.push(child);
        self
    }

    /// Add a child node by mutable reference.
    pub fn add_child(&mut self, child: PlanNode) {
        self.children.push(child);
    }

    /// Add a property by mutable reference.
    pub fn add_property(&mut self, key: impl Into<String>, value: PlanValue) {
        self.properties.push(PlanProperty {
            key: key.into(),
            value,
        });
    }
}

/// The type of operation a plan node represents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum PlanOperation {
    /// Top-level query execution phase.
    Planning,
    /// Pushdown decision analysis.
    PushdownDecision,
    /// Context resolution for a measure.
    ContextResolution,
    /// Fetching data from a remote source.
    SourceFetch,
    /// Local join of tables.
    LocalJoin,
    /// Local aggregation via DataFusion.
    LocalAggregation,
    /// Pushed aggregation to remote source.
    PushedAggregation,
    /// Measure evaluation.
    MeasureEvaluation,
    /// Calculated column materialization.
    CalculatedColumnMaterialization,
    /// DataFusion SQL execution.
    DataFusionExecution,
}

/// A key-value property attached to a plan node.
///
/// Properties carry the "why" details: which tables, what SQL,
/// what filters, why pushdown was chosen or rejected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanProperty {
    /// Property name.
    pub key: String,
    /// Property value.
    pub value: PlanValue,
}

impl PlanProperty {
    /// Create a text property.
    pub fn text(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: PlanValue::Text(value.into()),
        }
    }

    /// Create a numeric property.
    pub fn number(key: impl Into<String>, value: f64) -> Self {
        Self {
            key: key.into(),
            value: PlanValue::Number(value),
        }
    }

    /// Create a boolean property.
    pub fn bool(key: impl Into<String>, value: bool) -> Self {
        Self {
            key: key.into(),
            value: PlanValue::Bool(value),
        }
    }

    /// Create a list property.
    pub fn list(key: impl Into<String>, values: Vec<String>) -> Self {
        Self {
            key: key.into(),
            value: PlanValue::List(values),
        }
    }
}

/// A property value — string, number, boolean, or a list of strings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum PlanValue {
    /// A text value.
    Text(String),
    /// A numeric value.
    Number(f64),
    /// A boolean value.
    Bool(bool),
    /// A list of text values.
    List(Vec<String>),
}

/// Duration wrapper that serializes to fractional milliseconds.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct PlanDuration {
    /// Duration in fractional milliseconds.
    pub ms: f64,
}

impl PlanDuration {
    /// Zero duration.
    pub const ZERO: Self = Self { ms: 0.0 };

    /// Create from fractional milliseconds.
    pub fn from_ms(ms: f64) -> Self {
        Self { ms }
    }
}

impl From<Duration> for PlanDuration {
    fn from(d: Duration) -> Self {
        Self {
            ms: d.as_secs_f64() * 1000.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_node_serialization_roundtrip() {
        let plan = ExecutionPlan {
            summary: "Query: [Revenue] grouped by [Products.category]".into(),
            total_duration: PlanDuration::from_ms(42.5),
            root: PlanNode::new(PlanOperation::Planning, "Query Execution")
                .with_duration(Duration::from_millis(42))
                .with_child(
                    PlanNode::new(PlanOperation::PushdownDecision, "Pushdown Analysis")
                        .with_property("decision", PlanValue::Text("LocalAggregation".into()))
                        .with_property(
                            "tables_involved",
                            PlanValue::List(vec!["Sales".into(), "Products".into()]),
                        ),
                )
                .with_child(
                    PlanNode::new(PlanOperation::SourceFetch, "Fetch: Sales")
                        .with_property("rows_fetched", PlanValue::Number(31465.0)),
                ),
        };

        let json = serde_json::to_string(&plan).unwrap();
        let deserialized: ExecutionPlan = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.summary, plan.summary);
        assert_eq!(deserialized.root.children.len(), 2);
        assert_eq!(
            deserialized.root.children[0].operation,
            PlanOperation::PushdownDecision
        );
        assert_eq!(
            deserialized.root.children[1].operation,
            PlanOperation::SourceFetch
        );
    }

    #[test]
    fn plan_node_builder_chaining() {
        let node = PlanNode::new(PlanOperation::LocalAggregation, "Local Agg")
            .with_duration(Duration::from_micros(500))
            .with_property("sql", PlanValue::Text("SELECT ...".into()))
            .with_property("all_simple", PlanValue::Bool(true))
            .with_child(PlanNode::new(
                PlanOperation::DataFusionExecution,
                "DataFusion",
            ));

        assert_eq!(node.label, "Local Agg");
        assert_eq!(node.properties.len(), 2);
        assert_eq!(node.children.len(), 1);
        assert!(node.duration.ms > 0.0);
    }

    #[test]
    fn plan_duration_from_std_duration() {
        let d = Duration::from_millis(123);
        let pd: PlanDuration = d.into();
        assert!((pd.ms - 123.0).abs() < 0.01);

        let d2 = Duration::from_micros(500);
        let pd2: PlanDuration = d2.into();
        assert!((pd2.ms - 0.5).abs() < 0.001);

        assert_eq!(PlanDuration::ZERO.ms, 0.0);
    }

    #[test]
    fn plan_property_constructors() {
        let p1 = PlanProperty::text("key", "value");
        assert_eq!(p1.value, PlanValue::Text("value".into()));

        let p2 = PlanProperty::number("count", 42.0);
        assert_eq!(p2.value, PlanValue::Number(42.0));

        let p3 = PlanProperty::bool("pushed", true);
        assert_eq!(p3.value, PlanValue::Bool(true));

        let p4 = PlanProperty::list("tables", vec!["A".into(), "B".into()]);
        assert_eq!(p4.value, PlanValue::List(vec!["A".into(), "B".into()]));
    }

    #[test]
    fn plan_node_mutable_builders() {
        let mut node = PlanNode::new(PlanOperation::Planning, "Root");
        node.add_property("key", PlanValue::Text("val".into()));
        node.add_child(PlanNode::new(PlanOperation::SourceFetch, "Fetch"));

        assert_eq!(node.properties.len(), 1);
        assert_eq!(node.children.len(), 1);
    }
}
