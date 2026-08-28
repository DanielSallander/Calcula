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
//! use engine_core::transform::{derive_pipeline_schema, NoOtherTables, TransformStep};
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
//! // `NoOtherTables`: this pipeline looks nothing up, so there is no catalog
//! // to supply. A lookup step needs `ModelTableSchemas::new(model.tables())`.
//! let derived =
//!     derive_pipeline_schema("Sales", &source, &steps, &NoOtherTables).unwrap();
//! let names: Vec<&str> = derived.iter().map(|c| c.name()).collect();
//! assert_eq!(names, vec!["id", "amount"]);
//! ```

use crate::error::{EngineError, EngineResult};

mod apply_to_model;
mod catalog;
mod eval;
mod functions;
mod infer;
mod literal;
mod parts;
mod rules_columns;
mod rules_rows;
mod schema;
mod script;
mod step;
mod validate;

#[cfg(test)]
mod serde_tests;
#[cfg(test)]
pub(crate) mod test_support;

pub use apply_to_model::with_table_transformations;
pub use catalog::{ModelTableSchemas, NoOtherTables, StepInputs, TableSchemas};
pub use eval::{apply_steps, conform_to_declared};
pub use functions::row_level_function_names;
pub use parts::{
    CastErrorPolicy, ColumnRename, GroupAggregate, LookupKey, LookupTake, RowRange, SortKey,
    TextOp, TypeChange,
};
pub(crate) use schema::describe_schema;
pub use schema::{derive_pipeline_schema, derive_step_schema, schemas_match};
pub use script::{
    parse_placed_statement, parse_script, parse_statement, render_script, render_statement,
    script_vocabulary, OptionSpec, PlacedStep, ScriptError, ScriptVocabulary, StepVocabulary,
};
pub use step::TransformStep;
pub use validate::validate_steps;

/// The model tables one step reads BESIDES the table it belongs to.
///
/// Read off typed fields, never by re-parsing an expression — so it is total
/// over the catalog and cannot drift from what evaluation actually reads. Every
/// step but [`TransformStep::LookupColumn`] returns nothing today; a future
/// `mergeTable`/`appendTable` adds an arm here and inherits ordering, cycle
/// rejection and cache invalidation for free.
pub fn step_dependencies(step: &TransformStep) -> Vec<&str> {
    match step {
        TransformStep::LookupColumn { table, .. } => vec![table.as_str()],
        _ => Vec::new(),
    }
}

/// Every other table a whole pipeline reads, de-duplicated and sorted.
///
/// Sorted because this feeds a cache identity: an unstable order would change
/// the identity of a pipeline that did not change.
pub fn pipeline_dependencies(steps: &[TransformStep]) -> std::collections::BTreeSet<String> {
    steps
        .iter()
        .flat_map(step_dependencies)
        .map(str::to_string)
        .collect()
}

/// Order `tables` so every table comes after the tables its pipeline reads.
///
/// Kahn's algorithm over the [`pipeline_dependencies`] edges. Refresh walks
/// this order so a target is stored before any dependent transforms against it.
///
/// # Errors
///
/// [`EngineError::InvalidData`] naming the members of a cycle. Model build
/// calls this, so a cyclic pipeline fails to LOAD rather than hanging or
/// producing a table built from a half-built other table.
///
/// Table names are matched case-insensitively, as everywhere else in the model.
pub fn pipeline_refresh_order(tables: &[crate::model::Table]) -> EngineResult<Vec<String>> {
    use std::collections::{BTreeMap, BTreeSet, VecDeque};

    // Canonical (lowercase) name -> declared name, so an edge written with
    // different casing still lands on the same node.
    let canonical: BTreeMap<String, String> = tables
        .iter()
        .map(|t| (t.name().to_lowercase(), t.name().to_string()))
        .collect();

    let mut waiting_on: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut dependents: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for table in tables {
        let me = table.name().to_lowercase();
        let deps: BTreeSet<String> = table
            .source_binding()
            .map(|binding| pipeline_dependencies(&binding.transformations))
            .unwrap_or_default()
            .into_iter()
            .map(|d| d.to_lowercase())
            // A dependency on a table this model does not have is a validation
            // error, reported there with a better message; ordering just
            // ignores it rather than deadlocking on a node that never arrives.
            .filter(|d| canonical.contains_key(d) && *d != me)
            .collect();
        for dep in &deps {
            dependents.entry(dep.clone()).or_default().push(me.clone());
        }
        waiting_on.insert(me, deps);
    }

    let mut ready: VecDeque<String> = waiting_on
        .iter()
        .filter(|(_, deps)| deps.is_empty())
        .map(|(name, _)| name.clone())
        .collect();
    let mut order: Vec<String> = Vec::with_capacity(tables.len());
    while let Some(name) = ready.pop_front() {
        order.push(canonical[&name].clone());
        for dependent in dependents.get(&name).cloned().unwrap_or_default() {
            if let Some(deps) = waiting_on.get_mut(&dependent) {
                deps.remove(&name);
                if deps.is_empty() {
                    ready.push_back(dependent);
                }
            }
        }
        waiting_on.remove(&name);
    }

    if !waiting_on.is_empty() {
        // Whatever is still waiting is in, or downstream of, a cycle. Naming
        // the members is what makes the error actionable — the author has to
        // find the loop, and the engine already knows it.
        let members: Vec<&str> = waiting_on.keys().map(|k| canonical[k].as_str()).collect();
        return Err(EngineError::InvalidData(format!(
            "transformation pipelines form a dependency cycle among: {}. A table's \
             pipeline may look up into another table, but the chain must not come \
             back to where it started.",
            members.join(", ")
        )));
    }
    Ok(order)
}

/// Refuse a lookup whose target is a KIND of table a lookup cannot read.
///
/// Not a schema question — the target's columns are perfectly well known — so
/// it cannot live in the derivation rule, which sees only
/// [`TableSchemas`]. It needs the whole table list, which is exactly what
/// model build has, so it sits beside [`pipeline_refresh_order`] and runs in
/// the same pass.
///
/// Two kinds are refused, both because their rows would never be there:
///
/// * **DirectQuery** — nothing is ever cached for it, so every refresh of the
///   dependent would fail with "the lookup table has no loaded rows". A
///   structural mistake deserves a structural message, at load, once.
/// * **A calculated table** — those MATERIALIZE after the physical tables, in
///   a later phase of the same refresh, so a physical table looking one up
///   would join against an empty or previous-run cache. Lifting this means
///   interleaving the two phase diagrams, which is a bigger change than the
///   feature warrants today.
///
/// A writeback store IS a legal target: it is host-fed and cached like any
/// in-memory table.
pub fn validate_lookup_targets(tables: &[crate::model::Table]) -> EngineResult<()> {
    for table in tables {
        let Some(binding) = table.source_binding() else {
            continue;
        };
        for (index, step) in binding.transformations.iter().enumerate() {
            for dependency in step_dependencies(step) {
                let Some(target) = tables
                    .iter()
                    .find(|t| t.name().eq_ignore_ascii_case(dependency))
                else {
                    // An unknown target is reported by the derivation rule,
                    // which can name the model's tables. Not our message.
                    continue;
                };
                let refusal = if target.is_calculated() {
                    Some(format!(
                        "'{}' is a calculated table, which is materialized AFTER the \
                         tables it reads from — a lookup into it would join against \
                         rows that are not there yet. Look up a physical table, or \
                         express this with a measure once the table has joined the model.",
                        target.name()
                    ))
                } else if !target.is_in_memory() {
                    Some(format!(
                        "'{}' is a DirectQuery table, so its rows are never held in \
                         the model — there is nothing for a lookup to join against. \
                         Set it to Import storage to look it up.",
                        target.name()
                    ))
                } else {
                    None
                };
                if let Some(reason) = refusal {
                    return Err(EngineError::InvalidTransform {
                        table: table.name().to_string(),
                        step_index: index,
                        reason,
                    });
                }
            }
        }
    }
    Ok(())
}

/// A table's cache identity, INCLUDING every table its pipeline looks up.
///
/// `Table::schema_hash` already folds in the table's own columns and its own
/// pipeline fingerprint, but it cannot see other tables — so it says a
/// disk-cached `Orders` is still valid after `Customers` was reshaped, even
/// though `Orders`' cached rows contain columns joined out of the old
/// `Customers`. The dependency's identity has to be part of the dependent's,
/// which means a post-order fold rather than one hash.
///
/// A table with no lookups returns its `schema_hash` VERBATIM: an ordinary
/// model's disk caches are bit-identical to what they were before this feature
/// existed, so nothing is invalidated by the mere existence of the fold.
///
/// Total by construction: a dependency the model does not have contributes
/// nothing (validation reports it with a better message), and a cycle — which
/// model build refuses, so this can only see one in a hand-edited file — is
/// marked rather than recursed into.
pub fn cache_identity(tables: &[crate::model::Table], table_name: &str) -> String {
    let mut visiting = std::collections::BTreeSet::new();
    identity_of(tables, table_name, &mut visiting)
}

fn identity_of(
    tables: &[crate::model::Table],
    table_name: &str,
    visiting: &mut std::collections::BTreeSet<String>,
) -> String {
    use std::hash::{Hash, Hasher};

    let Some(table) = tables
        .iter()
        .find(|t| t.name().eq_ignore_ascii_case(table_name))
    else {
        return String::new();
    };
    let own = table.schema_hash();

    let key = table.name().to_lowercase();
    let dependencies: Vec<String> = table
        .source_binding()
        .map(|binding| pipeline_dependencies(&binding.transformations))
        .unwrap_or_default()
        .into_iter()
        .filter(|dependency| {
            !dependency.eq_ignore_ascii_case(table.name())
                && tables
                    .iter()
                    .any(|t| t.name().eq_ignore_ascii_case(dependency))
        })
        .collect();
    if dependencies.is_empty() {
        return own;
    }
    if !visiting.insert(key.clone()) {
        // Only reachable from a model that never passed validation. Marking
        // it keeps this function total; the identity will not match anything
        // on disk, so the cache is simply re-fetched.
        return format!("{own}+cycle");
    }

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    own.hash(&mut hasher);
    // `pipeline_dependencies` returns a sorted set, so the fold is stable —
    // an unstable order would change the identity of a table nobody edited.
    for dependency in &dependencies {
        identity_of(tables, dependency, visiting).hash(&mut hasher);
    }
    visiting.remove(&key);
    format!("{own}+{:016x}", hasher.finish())
}

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

    /// A table named `name` whose pipeline looks up each of `targets`.
    fn table_looking_up(name: &str, targets: &[&str]) -> crate::model::Table {
        let steps: Vec<TransformStep> = targets
            .iter()
            .map(|target| TransformStep::LookupColumn {
                table: (*target).to_string(),
                keys: vec![LookupKey::new("id", "id")],
                takes: vec![LookupTake::new("value")],
            })
            .collect();
        let mut binding = crate::model::TableSourceBinding::new("src", "public", "t");
        if !steps.is_empty() {
            binding = binding.with_transformations(steps);
        }
        crate::model::Table::new(
            name,
            vec![crate::model::Column::new(
                "id",
                crate::types::DataType::Int64,
            )],
        )
        .unwrap()
        .with_source_binding(binding)
    }

    /// Index of `name` in an order, for "comes before" assertions.
    fn position(order: &[String], name: &str) -> usize {
        order
            .iter()
            .position(|n| n == name)
            .unwrap_or_else(|| panic!("{name} missing from {order:?}"))
    }

    #[test]
    fn a_step_that_looks_nothing_up_has_no_dependencies() {
        // The property that keeps this cheap for the 99% case: an ordinary
        // pipeline contributes no edges at all.
        let steps = test_support::one_of_every_step();
        let lookups = steps
            .iter()
            .filter(|s| !step_dependencies(s).is_empty())
            .count();
        assert_eq!(
            lookups, 1,
            "exactly one step type reads another table today; if that changed, \
             ordering and invalidation need the new arm too"
        );
    }

    #[test]
    fn refresh_order_puts_every_target_before_its_dependent() {
        // Declared worst-first, so a pass-through of model order fails.
        let tables = vec![
            table_looking_up("Summary", &["Orders"]),
            table_looking_up("Orders", &["Customers"]),
            table_looking_up("Customers", &[]),
        ];
        let order = pipeline_refresh_order(&tables).unwrap();
        assert_eq!(order.len(), 3);
        assert!(position(&order, "Customers") < position(&order, "Orders"));
        assert!(position(&order, "Orders") < position(&order, "Summary"));
    }

    #[test]
    fn refresh_order_names_every_table_even_with_no_lookups_at_all() {
        // The ordinary model: no edges, but nothing may be dropped — refresh
        // walks this list.
        let tables = vec![
            table_looking_up("A", &[]),
            table_looking_up("B", &[]),
            table_looking_up("C", &[]),
        ];
        let order = pipeline_refresh_order(&tables).unwrap();
        assert_eq!(order.len(), 3);
    }

    #[test]
    fn refresh_order_matches_table_names_case_insensitively() {
        // `table=customers` against a `Customers` table is one edge, not a
        // dangling reference that would silently order them wrongly.
        let tables = vec![
            table_looking_up("Orders", &["cUsToMeRs"]),
            table_looking_up("Customers", &[]),
        ];
        let order = pipeline_refresh_order(&tables).unwrap();
        assert_eq!(order, vec!["Customers".to_string(), "Orders".to_string()]);
    }

    #[test]
    fn refresh_order_ignores_a_dependency_the_model_does_not_have() {
        // Validation reports the unknown table with a much better message;
        // ordering must not deadlock waiting for a node that never arrives.
        let tables = vec![table_looking_up("Orders", &["Nowhere"])];
        assert_eq!(pipeline_refresh_order(&tables).unwrap(), vec!["Orders"]);
    }

    #[test]
    fn a_cycle_is_refused_and_names_its_members() {
        let tables = vec![
            table_looking_up("A", &["B"]),
            table_looking_up("B", &["C"]),
            table_looking_up("C", &["A"]),
        ];
        let error = pipeline_refresh_order(&tables).unwrap_err().to_string();
        for member in ["A", "B", "C"] {
            assert!(error.contains(member), "must name {member}: {error}");
        }
    }

    #[test]
    fn a_two_table_cycle_is_refused_too() {
        let tables = vec![table_looking_up("A", &["B"]), table_looking_up("B", &["A"])];
        assert!(pipeline_refresh_order(&tables).is_err());
    }

    #[test]
    fn a_table_outside_a_cycle_does_not_hide_it() {
        // Kahn drains the acyclic part first; whatever is left is the cycle
        // and its downstream. The error must still fire.
        let tables = vec![
            table_looking_up("Fine", &[]),
            table_looking_up("A", &["B"]),
            table_looking_up("B", &["A"]),
        ];
        let error = pipeline_refresh_order(&tables).unwrap_err().to_string();
        assert!(error.contains('A') && error.contains('B'), "{error}");
    }

    #[test]
    fn a_lookup_into_a_directquery_table_is_refused_at_build() {
        // A DirectQuery table is never cached, so the dependent would fail on
        // EVERY refresh with "no loaded rows". A structural mistake deserves a
        // structural message, once, at load.
        let target = crate::model::Table::new(
            "Remote",
            vec![crate::model::Column::new(
                "id",
                crate::types::DataType::Int64,
            )],
        )
        .unwrap()
        .with_storage_mode(crate::model::StorageMode::DirectQuery);
        let tables = vec![table_looking_up("Orders", &["Remote"]), target];

        let error = validate_lookup_targets(&tables).unwrap_err().to_string();
        assert!(error.contains("Remote"), "must name the target: {error}");
        assert!(error.contains("DirectQuery"), "must say why: {error}");
    }

    #[test]
    fn a_lookup_into_a_calculated_table_is_refused_at_build() {
        // Calculated tables materialize in a LATER phase of the same refresh,
        // so a physical table looking one up joins against rows that are not
        // there yet — an empty column that looks like real "no match" data.
        let target = crate::model::Table::new(
            "Summary",
            vec![crate::model::Column::new(
                "id",
                crate::types::DataType::Int64,
            )],
        )
        .unwrap()
        .with_storage_mode(crate::model::StorageMode::InMemory)
        .calculated();
        let tables = vec![table_looking_up("Orders", &["Summary"]), target];

        let error = validate_lookup_targets(&tables).unwrap_err().to_string();
        assert!(error.contains("Summary"), "{error}");
        assert!(error.contains("calculated"), "{error}");
    }

    #[test]
    fn a_lookup_into_an_ordinary_in_memory_table_is_allowed() {
        // The non-vacuity control: the refusals above must come from the KIND
        // of table, not from having a lookup at all.
        let target = crate::model::Table::new(
            "Customers",
            vec![crate::model::Column::new(
                "id",
                crate::types::DataType::Int64,
            )],
        )
        .unwrap()
        .with_storage_mode(crate::model::StorageMode::InMemory);
        let tables = vec![table_looking_up("Orders", &["Customers"]), target];
        assert!(validate_lookup_targets(&tables).is_ok());
    }

    #[test]
    fn a_lookup_into_an_unknown_table_is_left_to_the_derivation_rule() {
        // Two messages for one mistake is worse than one: the derivation rule
        // can list the model's tables, so it owns this case.
        let tables = vec![table_looking_up("Orders", &["Nowhere"])];
        assert!(validate_lookup_targets(&tables).is_ok());
    }

    #[test]
    fn an_ordinary_tables_cache_identity_is_exactly_its_schema_hash() {
        // The no-regression property: adding cross-table lookups to the
        // engine must not invalidate one disk cache in a model that has none.
        let tables = vec![table_looking_up("Plain", &[])];
        assert_eq!(
            cache_identity(&tables, "Plain"),
            tables[0].schema_hash(),
            "a table with no lookups must not get a NEW identity"
        );
    }

    #[test]
    fn a_dependents_identity_changes_when_its_target_is_reshaped() {
        // The whole point. `Orders`' own columns and pipeline are untouched,
        // so `schema_hash` cannot tell that its cached rows now contain
        // columns joined out of a `Customers` that no longer looks like that.
        let orders = table_looking_up("Orders", &["Customers"]);
        let before = vec![
            orders.clone(),
            crate::model::Table::new(
                "Customers",
                vec![crate::model::Column::new(
                    "id",
                    crate::types::DataType::Int64,
                )],
            )
            .unwrap(),
        ];
        let after = vec![
            orders.clone(),
            crate::model::Table::new(
                "Customers",
                vec![
                    crate::model::Column::new("id", crate::types::DataType::Int64),
                    crate::model::Column::new("extra", crate::types::DataType::String),
                ],
            )
            .unwrap(),
        ];

        assert_eq!(
            before[0].schema_hash(),
            after[0].schema_hash(),
            "the dependent's own hash is blind to this, which is why the fold exists"
        );
        assert_ne!(
            cache_identity(&before, "Orders"),
            cache_identity(&after, "Orders"),
            "the fold must see the target's change"
        );
    }

    #[test]
    fn an_identity_travels_the_whole_chain() {
        // Two hops: reshaping the bottom must reach the top, or `Summary`'s
        // restored rows outlive the shape they were joined from.
        fn chain(bottom: Vec<crate::model::Column>) -> Vec<crate::model::Table> {
            vec![
                table_looking_up("Summary", &["Orders"]),
                table_looking_up("Orders", &["Customers"]),
                crate::model::Table::new("Customers", bottom).unwrap(),
            ]
        }
        let before = chain(vec![crate::model::Column::new(
            "id",
            crate::types::DataType::Int64,
        )]);
        let after = chain(vec![
            crate::model::Column::new("id", crate::types::DataType::Int64),
            crate::model::Column::new("extra", crate::types::DataType::String),
        ]);
        assert_ne!(
            cache_identity(&before, "Summary"),
            cache_identity(&after, "Summary")
        );
    }

    #[test]
    fn an_identity_is_stable_across_calls() {
        // It keys a disk cache: an identity that varied per call would
        // invalidate every entry on every run.
        let tables = vec![
            table_looking_up("Orders", &["Customers"]),
            table_looking_up("Customers", &[]),
        ];
        assert_eq!(
            cache_identity(&tables, "Orders"),
            cache_identity(&tables, "Orders")
        );
    }

    #[test]
    fn an_identity_survives_a_cycle_instead_of_recursing_forever() {
        // Model build refuses cycles, so this is only reachable from a
        // hand-edited file — where a stack overflow would be the worst
        // possible answer.
        let tables = vec![table_looking_up("A", &["B"]), table_looking_up("B", &["A"])];
        assert!(!cache_identity(&tables, "A").is_empty());
        assert!(!cache_identity(&tables, "B").is_empty());
    }

    #[test]
    fn an_unknown_table_has_no_identity() {
        assert_eq!(cache_identity(&[], "Nowhere"), "");
    }

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

        let before_schema =
            derive_pipeline_schema("T", &test_support::source_schema(), &before, &NoOtherTables);
        let after_schema =
            derive_pipeline_schema("T", &test_support::source_schema(), &after, &NoOtherTables);
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
