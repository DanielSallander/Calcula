//! Declarative table transformations — a table's **applied steps**.
//!
//! A model table bound to a data source can carry an ordered list of
//! [`TransformStep`]s that turn the rows a connector returned into the rows the
//! table declares. The pipeline is stored in the model file, applied on every
//! refresh, and is universal across connectors: every connector hands back
//! Arrow batches, so a pipeline works identically over PostgreSQL, SQL Server,
//! CSV, Parquet, a REST endpoint, or host-fed rows, with no per-connector work.
//!
//! # Steps are data, not code
//!
//! Each step is a typed, inspectable record — not a script. That is what lets
//! a host render the pipeline as an editable list, lets
//! [`derive_pipeline_schema`] answer "what columns does this produce?" without
//! reading a single row, and lets a reviewer see exactly what a shared model
//! file will do before opening it. Logic the catalog cannot express is reached
//! through a sandboxed script function (`Expression::Call`) inside an
//! expression step, not by embedding code in the pipeline.
//!
//! # What lives here
//!
//! This module is I/O-free, per `engine-core`'s architecture constraint: it
//! defines the steps, derives schemas, and validates. **Evaluating** a pipeline
//! over real batches lives in the `engine` facade, which owns the connectors.
//!
//! # Example
//!
//! ```rust
//! use engine_core::model::Column;
//! use engine_core::transform::{derive_pipeline_schema, TransformStep};
//! use engine_core::types::DataType;
//!
//! let source = vec![
//!     Column::new("id", DataType::Int64),
//!     Column::new("status", DataType::String),
//!     Column::new("amount", DataType::Float64),
//! ];
//! let steps = vec![
//!     TransformStep::FilterRows { condition: "status <> \"cancelled\"".into() },
//!     TransformStep::RemoveColumns { columns: vec!["status".into()] },
//! ];
//!
//! let derived = derive_pipeline_schema("Sales", &source, &steps).unwrap();
//! let names: Vec<&str> = derived.iter().map(|c| c.name()).collect();
//! assert_eq!(names, vec!["id", "amount"]);
//! ```

mod apply_to_model;
mod eval;
mod infer;
mod parts;
mod rules_columns;
mod rules_rows;
mod schema;
mod step;
mod validate;

#[cfg(test)]
mod serde_tests;
#[cfg(test)]
pub(crate) mod test_support;

pub use apply_to_model::with_table_transformations;
pub use eval::{apply_steps, conform_to_declared};
pub use parts::{
    CastErrorPolicy, ColumnRename, GroupAggregate, RowRange, SortKey, TextOp, TypeChange,
};
pub(crate) use schema::describe_schema;
pub use schema::{derive_pipeline_schema, derive_step_schema, schemas_match};
pub use step::TransformStep;
pub use validate::validate_steps;

/// A canonical, order-sensitive fingerprint of a transformation pipeline.
///
/// Cached data is only valid for the pipeline that produced it. A table's
/// schema hash catches a step that changes the *shape* of the output, but a
/// step that changes only *values* — a trim, a replace, a filter — leaves the
/// schema identical while making every cached row suspect. Folding this
/// fingerprint into the table's cache identity is what stops a stale on-disk
/// cache from being served after such an edit.
///
/// Returns `None` for an empty pipeline, so an ordinary table's cache identity
/// is unchanged by the existence of this feature.
pub fn pipeline_fingerprint(steps: &[TransformStep]) -> Option<String> {
    use std::hash::{Hash, Hasher};

    if steps.is_empty() {
        return None;
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // Serializing is what makes this total: every field of every step
    // contributes, so a new step field cannot silently escape the identity.
    // Serialization of these plain types cannot fail; if it somehow did,
    // falling back to the debug rendering keeps the fingerprint total rather
    // than panicking in library code.
    match serde_json::to_string(steps) {
        Ok(json) => json.hash(&mut hasher),
        Err(_) => format!("{steps:?}").hash(&mut hasher),
    }
    Some(format!("{:016x}", hasher.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_pipeline_has_no_fingerprint() {
        assert_eq!(pipeline_fingerprint(&[]), None);
    }

    #[test]
    fn fingerprint_is_stable_for_the_same_pipeline() {
        let steps = test_support::one_of_every_step();
        assert_eq!(
            pipeline_fingerprint(&steps),
            pipeline_fingerprint(&steps.clone())
        );
    }

    #[test]
    fn a_values_only_edit_changes_the_fingerprint() {
        // The exact case the schema hash cannot see: same columns, different
        // rows. If this ever stops holding, a stale disk cache outlives the
        // edit that invalidated it.
        let before = vec![TransformStep::FilterRows {
            condition: "amount > 0".into(),
        }];
        let after = vec![TransformStep::FilterRows {
            condition: "amount > 100".into(),
        }];
        assert_ne!(pipeline_fingerprint(&before), pipeline_fingerprint(&after));

        let before_schema = derive_pipeline_schema("T", &test_support::source_schema(), &before);
        let after_schema = derive_pipeline_schema("T", &test_support::source_schema(), &after);
        assert!(
            schemas_match(&before_schema.unwrap(), &after_schema.unwrap()),
            "the premise of this test is that the SCHEMA is identical"
        );
    }

    #[test]
    fn reordering_steps_changes_the_fingerprint() {
        let a = vec![
            TransformStep::FilterRows {
                condition: "amount > 0".into(),
            },
            TransformStep::Sort {
                by: vec![SortKey::ascending("amount")],
            },
        ];
        let b = vec![a[1].clone(), a[0].clone()];
        assert_ne!(pipeline_fingerprint(&a), pipeline_fingerprint(&b));
    }
}
