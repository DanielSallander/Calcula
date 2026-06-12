//! Hierarchy group-by resolution: validation, level expansion, and the
//! planner-resolved [`HierarchySpec`] carried into local execution.
//!
//! A [`HierarchyGroupBy`](crate::request::HierarchyGroupBy) on a request is
//! expanded **once**, early in planning: the hierarchy's level columns (in
//! drill order, up to the requested depth) are appended to the request's
//! explicit `group_by` columns. Every downstream consumer — ORDER BY
//! validation and defaulting, lookup-key inference, column projection,
//! pushdown decisions, fetch construction — sees the expanded list, so the
//! planner and the executor cannot diverge ([`effective_group_by`] is the
//! single source of truth).
//!
//! # Ragged-behavior execution contract
//!
//! The model's [`RaggedBehavior`] (see `engine_core::model::hierarchy`) is
//! applied to the query result. Cells equal to a level's `stopper_value` are
//! treated as NULL-equivalent under **every** behavior (the model docs define
//! a stopper as "semantically equivalent to NULL"): they are normalized via
//! `NULLIF` before grouping.
//!
//! - **ShowBlanks** — no transformation; NULL level values appear as-is
//!   (stopper cells appear as NULL). Without stoppers this needs no local
//!   work, so full pushdown is preserved.
//! - **HideMembers** — "skip blank levels — the branch appears shorter":
//!   result rows whose value at any included level is NULL (or a stopper)
//!   are filtered from the result **post-aggregation**. Subtotal rows from
//!   [`TotalsMode::Rollup`](crate::request::TotalsMode) are exempt for the
//!   levels they roll up; totals therefore still aggregate over all
//!   underlying data (hiding is presentation, not a filter context — measure
//!   CLEAR/RESET semantics are unaffected).
//! - **RepeatParent** — "fill blank levels by repeating the nearest
//!   non-blank parent value": each level is computed as
//!   `COALESCE(level_i, level_{i-1}, …, level_0)` (after stopper
//!   normalization) and grouping happens **on the filled value**, so members
//!   that display identically are one result row.
//! - **ShowAsLeaf** — "treat rows with incomplete paths as leaf nodes at
//!   their natural level": interior gaps (a blank level with a real value
//!   somewhere deeper *within the queried depth*) are filled like
//!   RepeatParent so the path stays navigable, while trailing blanks (no
//!   real value at or below the level) stay NULL — the branch ends at its
//!   deepest real level. Levels below the queried depth are not consulted.
//!   Grouping happens on the transformed values, as with RepeatParent.
//!
//! Behaviors that transform or filter (everything except stopper-free
//! ShowBlanks) force [`QueryPlan::LocalAggregation`](super::QueryPlan): the
//! transforms are rendered into the local DataFusion SQL, which the pushed
//! connector requests cannot express.

use engine_core::model::{DataModel, RaggedBehavior};

use crate::error::{QueryError, QueryResult};
use crate::request::{ColumnRef, QueryRequest};

/// A single hierarchy level included in a query, as resolved by the planner.
#[derive(Debug, Clone)]
pub struct HierarchyLevelSpec {
    /// The level's column on the hierarchy table.
    pub column: String,
    /// Custom stopper value treated as NULL-equivalent, if declared.
    pub stopper_value: Option<String>,
}

/// A hierarchy group-by resolved against the model, carried in
/// [`QueryPlan::LocalAggregation`](super::QueryPlan) so the executor applies
/// the same expansion and ragged behavior the planner decided on.
#[derive(Debug, Clone)]
pub struct HierarchySpec {
    /// Hierarchy name (as defined in the model).
    pub name: String,
    /// The table the hierarchy is defined on.
    pub table: String,
    /// Number of levels included (validated `1..=levels.len()`).
    pub depth: usize,
    /// The model's ragged-hierarchy behavior.
    pub behavior: RaggedBehavior,
    /// The included levels, in drill order (`levels[0]` is the top).
    pub levels: Vec<HierarchyLevelSpec>,
}

impl HierarchySpec {
    /// Whether executing this hierarchy needs local aggregation.
    ///
    /// True when the ragged behavior transforms or filters level values
    /// (HideMembers, RepeatParent, ShowAsLeaf) or any included level has a
    /// `stopper_value` (which must be NULL-normalized even under
    /// ShowBlanks). Stopper-free ShowBlanks hierarchies expand to ordinary
    /// group-by columns and keep full pushdown.
    pub fn needs_local(&self) -> bool {
        self.behavior != RaggedBehavior::ShowBlanks
            || self.levels.iter().any(|l| l.stopper_value.is_some())
    }

    /// Index of the included level matching a group-by column, if any
    /// (case-insensitive on both table and column).
    pub(crate) fn level_index_of(&self, table: &str, column: &str) -> Option<usize> {
        if !self.table.eq_ignore_ascii_case(table) {
            return None;
        }
        self.levels
            .iter()
            .position(|l| l.column.eq_ignore_ascii_case(column))
    }

    /// The included level columns as group-by column references, in order.
    pub fn level_column_refs(&self) -> Vec<ColumnRef> {
        self.levels
            .iter()
            .map(|l| ColumnRef::new(self.table.clone(), l.column.clone()))
            .collect()
    }
}

/// Resolve and validate a request's `hierarchy_group_by` against the model.
///
/// Returns `Ok(None)` when the request has no hierarchy group-by. Errors:
/// unknown hierarchy name, depth `0`, depth beyond the hierarchy's level
/// count, or an explicit `group_by` column that duplicates one of the
/// included level columns (levels are appended automatically).
pub(crate) fn resolve_hierarchy(
    request: &QueryRequest,
    model: &DataModel,
) -> QueryResult<Option<HierarchySpec>> {
    let Some(hgb) = &request.hierarchy_group_by else {
        return Ok(None);
    };

    let hierarchy = model.hierarchy(&hgb.hierarchy)?;
    let level_count = hierarchy.levels().len();

    if hgb.depth == 0 {
        return Err(QueryError::InvalidQuery(format!(
            "hierarchy '{}' depth must be at least 1 (depth counts included levels)",
            hgb.hierarchy
        )));
    }
    if hgb.depth > level_count {
        return Err(QueryError::InvalidQuery(format!(
            "hierarchy '{}' has {level_count} level(s), requested depth {}",
            hgb.hierarchy, hgb.depth
        )));
    }

    let levels: Vec<HierarchyLevelSpec> = hierarchy.levels()[..hgb.depth]
        .iter()
        .map(|l| HierarchyLevelSpec {
            column: l.column().to_string(),
            stopper_value: l.stopper_value().map(str::to_string),
        })
        .collect();

    // Reject explicit group_by columns that duplicate an included level —
    // the levels are appended automatically, and a duplicate output column
    // would be ambiguous.
    for col in &request.group_by {
        if col.table.eq_ignore_ascii_case(hierarchy.table())
            && levels
                .iter()
                .any(|l| l.column.eq_ignore_ascii_case(&col.column))
        {
            return Err(QueryError::InvalidQuery(format!(
                "group_by column '{}.{}' is a level of hierarchy '{}'; hierarchy levels \
                 are appended automatically and must not be listed in group_by",
                col.table, col.column, hgb.hierarchy
            )));
        }
    }

    Ok(Some(HierarchySpec {
        name: hierarchy.name().to_string(),
        table: hierarchy.table().to_string(),
        depth: hgb.depth,
        behavior: hierarchy.ragged_behavior(),
        levels,
    }))
}

/// The effective group-by columns for a request: the explicit `group_by`
/// columns followed by the hierarchy level columns (in drill order, up to
/// the requested depth) when `hierarchy_group_by` is set.
///
/// This is the **single expansion point** used by the planner; the executor
/// receives the expanded list through the plan, so the two cannot diverge.
pub fn effective_group_by(
    request: &QueryRequest,
    model: &DataModel,
) -> QueryResult<Vec<ColumnRef>> {
    let mut group_by = request.group_by.clone();
    if let Some(spec) = resolve_hierarchy(request, model)? {
        group_by.extend(spec.level_column_refs());
    }
    Ok(group_by)
}

#[cfg(test)]
mod tests {
    use super::super::test_util::*;
    use super::super::{PushdownPlanner, QueryPlan};
    use super::*;
    use crate::registry::{SourceBinding, SourceRegistry};
    use crate::request::HierarchyGroupBy;
    use engine_core::compute::measure::sum_measure;
    use engine_core::model::{Column, Hierarchy, HierarchyLevel, Relationship, Table};
    use engine_core::types::DataType;

    /// Single-table model with a 3-level geography hierarchy on the fact
    /// table itself (country → state → city).
    fn geo_model(behavior: RaggedBehavior, state_stopper: Option<&str>) -> DataModel {
        let mut state = HierarchyLevel::new("state").with_optional(true);
        if let Some(s) = state_stopper {
            state = state.with_stopper_value(s);
        }
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("country", DataType::String),
                Column::new("state", DataType::String),
                Column::new("city", DataType::String),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(sales)
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .add_hierarchy(
                Hierarchy::new(
                    "Geo",
                    "Sales",
                    vec![
                        HierarchyLevel::new("country"),
                        state,
                        HierarchyLevel::new("city"),
                    ],
                )
                .with_ragged_behavior(behavior),
            )
            .build()
            .unwrap()
    }

    fn geo_request(depth: usize) -> crate::request::QueryRequest {
        crate::request::QueryRequest {
            measures: vec!["TotalAmount".into()],
            hierarchy_group_by: Some(HierarchyGroupBy::new("Geo", depth)),
            ..Default::default()
        }
    }

    #[test]
    fn unknown_hierarchy_is_rejected() {
        let model = geo_model(RaggedBehavior::ShowBlanks, None);
        let registry = mock_registry_single(0);
        let request = crate::request::QueryRequest {
            measures: vec!["TotalAmount".into()],
            hierarchy_group_by: Some(HierarchyGroupBy::new("NoSuchHierarchy", 1)),
            ..Default::default()
        };
        let err = PushdownPlanner::plan(&request, &model, &registry).unwrap_err();
        assert!(err.to_string().contains("NoSuchHierarchy"), "{err}");
    }

    #[test]
    fn depth_zero_is_rejected() {
        let model = geo_model(RaggedBehavior::ShowBlanks, None);
        let registry = mock_registry_single(0);
        let err = PushdownPlanner::plan(&geo_request(0), &model, &registry).unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(msg.contains("depth must be at least 1"), "{msg}");
            }
            other => panic!("Expected InvalidQuery, got {other:?}"),
        }
    }

    #[test]
    fn depth_beyond_level_count_is_rejected() {
        let model = geo_model(RaggedBehavior::ShowBlanks, None);
        let registry = mock_registry_single(0);
        let err = PushdownPlanner::plan(&geo_request(4), &model, &registry).unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(msg.contains("3 level(s), requested depth 4"), "{msg}");
            }
            other => panic!("Expected InvalidQuery, got {other:?}"),
        }
    }

    #[test]
    fn explicit_group_by_duplicating_a_level_is_rejected() {
        let model = geo_model(RaggedBehavior::ShowBlanks, None);
        let registry = mock_registry_single(0);
        let request = crate::request::QueryRequest {
            group_by: vec![ColumnRef::new("Sales", "STATE")],
            ..geo_request(2)
        };
        let err = PushdownPlanner::plan(&request, &model, &registry).unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(msg.contains("appended automatically"), "{msg}");
            }
            other => panic!("Expected InvalidQuery, got {other:?}"),
        }

        // A column beyond the requested depth is NOT an included level —
        // grouping by it explicitly stays legal.
        let request = crate::request::QueryRequest {
            group_by: vec![ColumnRef::new("Sales", "city")],
            ..geo_request(2)
        };
        assert!(PushdownPlanner::plan(&request, &model, &registry).is_ok());
    }

    /// Depth 2 of a 3-level hierarchy appends exactly the first two level
    /// columns, in drill order, after the explicit group-by columns.
    #[test]
    fn expansion_appends_levels_in_order_after_explicit_columns() {
        let model = geo_model(RaggedBehavior::ShowBlanks, None);
        let request = crate::request::QueryRequest {
            group_by: vec![ColumnRef::new("Sales", "id")],
            ..geo_request(2)
        };
        let cols = effective_group_by(&request, &model).unwrap();
        assert_eq!(
            cols,
            vec![
                ColumnRef::new("Sales", "id"),
                ColumnRef::new("Sales", "country"),
                ColumnRef::new("Sales", "state"),
            ]
        );
    }

    /// Stopper-free ShowBlanks keeps full pushdown: the levels are pushed
    /// as ordinary GROUP BY columns in the source fetch.
    #[test]
    fn show_blanks_hierarchy_is_pushed_with_level_columns() {
        let model = geo_model(RaggedBehavior::ShowBlanks, None);
        let registry = mock_registry_single(0);
        let plan = PushdownPlanner::plan(&geo_request(2), &model, &registry).unwrap();
        match plan {
            QueryPlan::PushedAggregation { request: fetch, .. } => {
                assert_eq!(
                    fetch.group_by,
                    vec!["country".to_string(), "state".to_string()]
                );
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }
    }

    /// RepeatParent (and every transforming behavior) forces local
    /// aggregation: the COALESCE grouping cannot be expressed in the pushed
    /// connector requests.
    #[test]
    fn repeat_parent_forces_local_aggregation() {
        let model = geo_model(RaggedBehavior::RepeatParent, None);
        let registry = mock_registry_single(0);
        let plan = PushdownPlanner::plan(&geo_request(2), &model, &registry).unwrap();
        match plan {
            QueryPlan::LocalAggregation {
                group_by,
                hierarchy,
                ..
            } => {
                assert_eq!(
                    group_by,
                    vec![
                        ColumnRef::new("Sales", "country"),
                        ColumnRef::new("Sales", "state"),
                    ]
                );
                let spec = hierarchy.expect("plan should carry the hierarchy spec");
                assert_eq!(spec.name, "Geo");
                assert_eq!(spec.depth, 2);
                assert_eq!(spec.behavior, RaggedBehavior::RepeatParent);
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    /// A stopper on an included level forces local aggregation even under
    /// ShowBlanks (the stopper must be NULL-normalized); a stopper on a
    /// level beyond the requested depth does not.
    #[test]
    fn stopper_on_included_level_forces_local() {
        let model = geo_model(RaggedBehavior::ShowBlanks, Some("#"));
        let registry = mock_registry_single(0);

        // Depth 2 includes the stoppered state level → local.
        let plan = PushdownPlanner::plan(&geo_request(2), &model, &registry).unwrap();
        assert!(matches!(plan, QueryPlan::LocalAggregation { .. }));

        // Depth 1 (country only) excludes it → still pushed.
        let plan = PushdownPlanner::plan(&geo_request(1), &model, &registry).unwrap();
        assert!(matches!(plan, QueryPlan::PushedAggregation { .. }));
    }

    /// Lookups interact with hierarchy levels under the existing group-by
    /// rules: with exactly one level on the lookup table the key is
    /// auto-inferred from it; with two levels the inference is ambiguous.
    #[test]
    fn lookups_key_inference_sees_expanded_levels() {
        let model = geo_model(RaggedBehavior::ShowBlanks, None);
        let registry = mock_registry_single(0);

        // Depth 1: `country` is the only group-by column on Sales — the
        // lookup key is inferred from it.
        let request = crate::request::QueryRequest {
            lookups: vec![crate::request::LookupColumn::new("Sales", "city")],
            ..geo_request(1)
        };
        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();
        match plan {
            QueryPlan::LocalAggregation { lookup_specs, .. } => {
                assert_eq!(lookup_specs.len(), 1);
                assert_eq!(lookup_specs[0].key_column, "country");
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }

        // Depth 2: two group-by columns on Sales — ambiguous, same error
        // as for explicit group-by columns.
        let request = crate::request::QueryRequest {
            lookups: vec![crate::request::LookupColumn::new("Sales", "city")],
            ..geo_request(2)
        };
        let err = PushdownPlanner::plan(&request, &model, &registry).unwrap_err();
        assert!(
            err.to_string().contains("Multiple group_by columns")
                && err.to_string().contains("Specify key_column explicitly"),
            "{err}"
        );
    }

    /// Star schema: a hierarchy on a dimension table reached cross-source —
    /// the dimension fetch projects the level columns.
    #[test]
    fn cross_source_fetch_projects_level_columns() {
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("geo_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let geo = Table::new(
            "Geography",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("country", DataType::String),
                Column::new("state", DataType::String),
                Column::new("city", DataType::String),
            ],
        )
        .unwrap();
        let model = DataModel::builder()
            .add_table(sales)
            .add_table(geo)
            .add_relationship(Relationship::many_to_one(
                "Sales_Geo",
                "Sales",
                "geo_id",
                "Geography",
                "id",
            ))
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .add_hierarchy(Hierarchy::new(
                "Geo",
                "Geography",
                vec![
                    HierarchyLevel::new("country"),
                    HierarchyLevel::new("state").with_optional(true),
                    HierarchyLevel::new("city"),
                ],
            ))
            .build()
            .unwrap();

        let mut registry = SourceRegistry::new();
        registry.bind("Sales", 0, SourceBinding::new("sales", "salesorderheader"));
        registry.bind("Geography", 1, SourceBinding::new("dim", "geography"));

        let request = crate::request::QueryRequest {
            measures: vec!["TotalAmount".into()],
            hierarchy_group_by: Some(HierarchyGroupBy::new("Geo", 2)),
            ..Default::default()
        };
        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();
        match plan {
            QueryPlan::LocalAggregation {
                fetches, group_by, ..
            } => {
                assert_eq!(
                    group_by,
                    vec![
                        ColumnRef::new("Geography", "country"),
                        ColumnRef::new("Geography", "state"),
                    ]
                );
                let geo_fetch = fetches.iter().find(|(n, _)| n == "Geography").unwrap();
                assert!(
                    geo_fetch.1.columns.iter().any(|c| c == "country")
                        && geo_fetch.1.columns.iter().any(|c| c == "state"),
                    "dimension fetch must project the level columns, got {:?}",
                    geo_fetch.1.columns
                );
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }
}
