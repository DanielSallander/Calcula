//! FILENAME: app/src-tauri/src/bi/measures.rs
//! PURPOSE: Workbook-local calculated measures (Layer 2). A user defines
//!          `[Profit Margin] = [Profit]/[Revenue]` for a connection's model; it
//!          is baked into the engine's model so CUBE formulas, pivots, and the
//!          script `cube.*` API can all use it natively.
//!
//! ## How they are applied
//! The engine has no public per-query measure overlay, so calculated measures
//! are installed into the engine's model via `engine.set_model(base + measures)`.
//! `base_model` (the model as originally loaded, kept on the Connection) is the
//! source of truth so re-applying never double-adds.
//!
//! ## Shared engines
//! Connections that use the same model SHARE one engine (EngineRegistry keyed by
//! ModelKey). A calculated measure therefore belongs to the MODEL: we apply the
//! UNION of all measures across connections sharing a model_key, so whichever
//! connection triggers the apply, the shared engine ends up consistent.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use tauri::State;

use super::engine_registry::ModelKey;
use super::types::{BiState, CalculatedMeasure, ConnectionId};

/// Parse the measure expressions and produce `base + measures`, validating
/// syntax and name collisions. The engine reports unknown-column / unknown-
/// measure references at query time (surfaced to the user as a query error).
/// pub(crate): the .calp refresh path re-applies measures onto an updated model.
pub(crate) fn build_combined_model(
    base: &bi_engine::DataModel,
    measures: &[CalculatedMeasure],
) -> Result<bi_engine::DataModel, String> {
    if measures.is_empty() {
        return Ok(base.clone());
    }
    let mut built = Vec::with_capacity(measures.len());
    for m in measures {
        let expr = bi_engine::parse_measure_expression(&m.expression)
            .map_err(|e| format!("Measure '{}': {}", m.name, e))?;
        built.push(bi_engine::expression_measure(&m.name, expr));
    }
    let combined = base.with_overlay_measures(built).map_err(|e| format!("{}", e))?;
    // Validate references (unknown column / measure) against the whole model.
    combined.validate().map_err(|e| format!("{}", e))?;
    // The engine derives a measure's fact table from the COLUMNS its expression
    // references; a purely measure-referential expression (e.g. `[Profit]/[Revenue]`
    // with no direct column) gets an empty table and fails at query time. Reject
    // it here with guidance toward the column form.
    for m in measures {
        if let Some(rm) = combined.measures().iter().find(|x| x.name() == m.name) {
            if rm.table().trim().is_empty() {
                return Err(format!(
                    "Measure '{}' must reference at least one column so it can be \
                     associated with a table — write it in column form (e.g. \
                     SUM(Sales[profit]) / SUM(Sales[revenue])) rather than referencing \
                     only other measures.",
                    m.name
                ));
            }
        }
    }
    Ok(combined)
}

/// Push `m` into `out` unless a measure of the same name is already present.
fn push_unique(out: &mut Vec<CalculatedMeasure>, m: &CalculatedMeasure) {
    if !out.iter().any(|x| x.name == m.name) {
        out.push(m.clone());
    }
}

/// (Re)apply every connection's calculated measures to its engine. Sync path
/// (used on workbook restore): groups by model_key, applies the union once per
/// shared engine via `try_lock` (engines are idle at restore time).
pub fn reapply_all_calculated_measures(bi: &BiState) {
    type Plan = (Arc<TokioMutex<bi_engine::Engine>>, bi_engine::DataModel, Vec<CalculatedMeasure>);
    let plans: Vec<Plan> = {
        let conns = bi.connections.lock().unwrap();
        let mut by_key: HashMap<ModelKey, Plan> = HashMap::new();
        for c in conns.values() {
            let (Some(arc), Some(key), Some(base)) = (&c.engine, &c.model_key, &c.base_model) else {
                continue;
            };
            let entry =
                by_key.entry(key.clone()).or_insert_with(|| (arc.clone(), base.clone(), Vec::new()));
            for m in &c.calculated_measures {
                push_unique(&mut entry.2, m);
            }
        }
        by_key.into_values().filter(|(_, _, ms)| !ms.is_empty()).collect()
    };
    for (arc, base, measures) in plans {
        match build_combined_model(&base, &measures) {
            Ok(combined) => match arc.try_lock() {
                Ok(mut guard) => {
                    if let Err(e) = guard.set_model(combined) {
                        crate::log_warn!("BI", "reapply calculated measures: set_model failed: {}", e);
                    }
                }
                Err(_) => crate::log_warn!("BI", "reapply calculated measures: engine busy"),
            },
            Err(e) => crate::log_warn!("BI", "reapply calculated measures: {}", e),
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Get the workbook-local calculated measures defined for a connection.
#[tauri::command]
pub async fn bi_get_calculated_measures(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
) -> Result<Vec<CalculatedMeasure>, String> {
    let conns = bi_state.connections.lock().unwrap();
    let conn = conns.get(&connection_id).ok_or("Connection not found")?;
    Ok(conn.calculated_measures.clone())
}

/// Replace the calculated measures for a connection's MODEL. `measures` is the
/// COMPLETE set for the model (the dialog edits the whole list). Validates
/// BEFORE storing, then mirrors the set onto every connection sharing the model
/// (calculated measures belong to the model, not one connection) and installs
/// them on the shared engine. Leaves prior measures intact on validation error.
#[tauri::command]
pub async fn bi_set_calculated_measures(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    measures: Vec<CalculatedMeasure>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // Validate the request shape.
    let mut names = std::collections::HashSet::new();
    for m in &measures {
        let name = m.name.trim();
        if name.is_empty() {
            return Err("A calculated measure name cannot be empty".to_string());
        }
        if m.expression.trim().is_empty() {
            return Err(format!("Measure '{}' has an empty expression", name));
        }
        if !names.insert(name.to_string()) {
            return Err(format!("Duplicate measure name '{}'", name));
        }
    }

    let (engine_arc, base, model_key) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        // Package (.calp-subscribed) connections reconstruct from the package on
        // every pull and are NOT persisted by the workbook save path, so measures
        // set on them would be silently lost. Refuse rather than lose data.
        if conn.package_data_source_id.is_some() {
            return Err(
                "Calculated measures aren't supported on package-subscribed connections yet. \
                 Define them on a local model connection instead."
                    .to_string(),
            );
        }
        let engine_arc = conn.engine.clone().ok_or("No model loaded for this connection")?;
        let base = conn
            .base_model
            .clone()
            .ok_or("This connection has no editable base model")?;
        (engine_arc, base, conn.model_key.clone())
    };

    // Validate the complete set against the base BEFORE mutating any state.
    let combined = build_combined_model(&base, &measures)?;

    // Calculated measures belong to the MODEL: mirror the set onto every
    // connection sharing this engine so deleting any one connection cannot drop
    // the model's measures (each persists the full set on save).
    {
        let mut conns = bi_state.connections.lock().unwrap();
        for c in conns.values_mut() {
            if c.model_key == model_key {
                c.calculated_measures = measures.clone();
            }
        }
    }
    let mut guard = engine_arc.lock().await;
    guard.set_model(combined).map_err(|e| format!("{}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{Float64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use bi_engine::{
        sum_measure, Column, ColumnRef, DataModel, DataType, Engine, InMemoryConnector,
        QueryRequest, SourceBinding, StorageMode, Table,
    };

    fn cm(name: &str, expr: &str) -> CalculatedMeasure {
        CalculatedMeasure { name: name.into(), expression: expr.into() }
    }

    fn base_model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("country", DataType::String),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap()
    }

    #[test]
    fn combined_model_adds_measure() {
        let combined =
            build_combined_model(&base_model(), &[cm("DoubleRevenue", "SUM(Sales[amount]) * 2")]).unwrap();
        assert!(combined.measures().iter().any(|m| m.name() == "DoubleRevenue"));
        assert!(combined.measures().iter().any(|m| m.name() == "Revenue"));
    }

    #[test]
    fn combined_model_rejects_bad_syntax() {
        assert!(build_combined_model(&base_model(), &[cm("Bad", "[Revenue] /")]).is_err());
    }

    #[test]
    fn combined_model_rejects_pure_measure_reference() {
        // No direct column -> empty fact table -> rejected with guidance.
        let err = build_combined_model(&base_model(), &[cm("DoubleRev", "[Revenue] * 2")])
            .unwrap_err();
        assert!(err.contains("column form"), "got: {}", err);
    }

    #[test]
    fn combined_model_rejects_name_collision() {
        assert!(build_combined_model(&base_model(), &[cm("Revenue", "[Revenue]")]).is_err());
    }

    #[tokio::test]
    async fn calculated_measure_computes_in_query() {
        // Install the workbook-local measure into the model, then query it
        // through the same bind flow as the passing cube tests.
        let combined =
            build_combined_model(&base_model(), &[cm("DoubleRevenue", "SUM(Sales[amount]) * 2")]).unwrap();
        let mut engine = Engine::new(combined);
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("country", ArrowType::Utf8, true),
                Field::new("amount", ArrowType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec!["USA", "UK", "USA"])),
                Arc::new(Float64Array::from(vec![100.0, 50.0, 75.0])),
            ],
        )
        .unwrap();
        let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", batch));
        engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));

        let (batches, _) = engine
            .query_auto_refresh(QueryRequest {
                measures: vec!["DoubleRevenue".into()],
                group_by: vec![ColumnRef::new("Sales", "country")],
                ..Default::default()
            })
            .await
            .unwrap();
        // Total across countries: (100+75)*2 + 50*2 = 450.
        let total: f64 = batches
            .iter()
            .flat_map(|b| {
                let c = b.column(b.num_columns() - 1);
                let arr = c.as_any().downcast_ref::<Float64Array>().unwrap();
                (0..arr.len()).map(|i| arr.value(i)).collect::<Vec<_>>()
            })
            .sum();
        assert_eq!(total, 450.0);
    }
}
