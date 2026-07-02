//! FILENAME: app/src-tauri/src/bi/model_editor.rs
//! PURPOSE: In-app Model Editor (ME-1: measures). Edits a connection's BASE
//!          model in place: clone base_model -> mutate the measure list ->
//!          validate -> install on the shared engine (with workbook calculated
//!          measures re-applied on top) -> mirror onto every connection
//!          sharing the model. Persistence is free: the embedded model saves
//!          into .cala via capture_local_bi_connections and distributes via
//!          calp_publish_model.
//!
//! Formula text: the author's original text is kept as `Measure::source`
//! (first-class in the engine model); display falls back to the Phase-0a
//! `measure_to_formula` rendering for measures without source text (e.g.
//! Studio models imported before Studio stamped sources).

use std::collections::HashSet;

use serde::Serialize;
use tauri::State;

use super::measures::build_combined_model;
use super::types::{BiState, ConnectionId};
use crate::persistence::FileState;

// ---------------------------------------------------------------------------
// API types (camelCase for TypeScript)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeasureInfo {
    pub name: String,
    /// The measure's home (fact) table, inferred from referenced columns.
    pub table: String,
    /// The author's original formula text when available; otherwise a
    /// rendering of the stored expression AST.
    pub formula: String,
    /// False when `formula` is an AST rendering, not author text.
    pub has_source: bool,
    pub description: Option<String>,
    pub format_string: Option<String>,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureValidation {
    pub ok: bool,
    pub message: Option<String>,
    /// Byte offset into the formula for parse errors (drives an editor marker).
    pub position: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineageColumn {
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureLineage {
    /// Other measures this measure references.
    pub measures: Vec<String>,
    pub columns: Vec<LineageColumn>,
    pub contexts: Vec<String>,
    pub table_variables: Vec<String>,
    pub globals: Vec<String>,
    /// Measures that reference THIS measure (delete impact).
    pub referenced_by: Vec<String>,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested below)
// ---------------------------------------------------------------------------

fn measure_info(m: &bi_engine::Measure) -> ModelMeasureInfo {
    ModelMeasureInfo {
        name: m.name().to_string(),
        table: m.table().to_string(),
        formula: m
            .source()
            .map(|s| s.to_string())
            .unwrap_or_else(|| bi_engine::measure_to_formula(m)),
        has_source: m.source().is_some(),
        description: m.description().map(|s| s.to_string()),
        format_string: m.format_string().map(|s| s.to_string()),
        is_hidden: m.is_hidden(),
    }
}

/// Parse editor input into a Measure, preserving the author's text as
/// `source`. Applies the same fact-table guard as workbook calculated
/// measures: an expression referencing no column has no home table and would
/// fail at query time — reject with guidance instead.
fn build_measure(
    name: &str,
    formula: &str,
    description: Option<&str>,
    format_string: Option<&str>,
) -> Result<bi_engine::Measure, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Measure name cannot be empty".to_string());
    }
    if formula.trim().is_empty() {
        return Err(format!("Measure '{}' has an empty formula", name));
    }
    let expr = bi_engine::parse_measure_expression(formula)
        .map_err(|e| format!("Measure '{}': {}", name, e))?;
    let mut measure = bi_engine::Measure::new(name, expr).with_source(formula);
    if let Some(d) = description.map(str::trim).filter(|d| !d.is_empty()) {
        measure = measure.with_description(d);
    }
    if let Some(f) = format_string.map(str::trim).filter(|f| !f.is_empty()) {
        measure = measure.with_format_string(f);
    }
    if measure.table().trim().is_empty() {
        return Err(format!(
            "Measure '{}' must reference at least one column so it can be \
             associated with a table — write it in column form (e.g. \
             SUM(Sales[profit]) / SUM(Sales[revenue])) rather than referencing \
             only other measures.",
            name
        ));
    }
    Ok(measure)
}

/// Add (original_name = None) or replace/rename (Some) a measure in the
/// model's measure list, returning the edited + validated model.
fn upsert_measure_model(
    base: &bi_engine::DataModel,
    original_name: Option<&str>,
    measure: bi_engine::Measure,
) -> Result<bi_engine::DataModel, String> {
    let mut measures: Vec<bi_engine::Measure> = base.measures().to_vec();
    match original_name {
        Some(orig) => {
            let Some(idx) = measures.iter().position(|m| m.name() == orig) else {
                return Err(format!("Measure '{}' not found in the model", orig));
            };
            if measure.name() != orig && measures.iter().any(|m| m.name() == measure.name()) {
                return Err(format!(
                    "A measure named '{}' already exists in the model",
                    measure.name()
                ));
            }
            // Editing must not silently unhide a hidden measure (the editor
            // has no hidden control yet — the flag simply carries over).
            let mut incoming = measure;
            if measures[idx].is_hidden() && !incoming.is_hidden() {
                incoming = incoming.hidden();
            }
            measures[idx] = incoming;
        }
        None => {
            if measures.iter().any(|m| m.name() == measure.name()) {
                return Err(format!(
                    "A measure named '{}' already exists in the model",
                    measure.name()
                ));
            }
            measures.push(measure);
        }
    }
    let edited = base.with_measures(measures);
    // validate() rebuilds the model and catches dangling references (e.g. a
    // rename leaving another measure's [OldName] behind), circular measure
    // refs, and unknown columns.
    edited.validate().map_err(|e| format!("{}", e))?;
    Ok(edited)
}

/// Names of the measures + workbook calculated measures that reference
/// `name`. Calculated measures are raw text on the connection: parse each
/// (ignoring unparseable ones — they fail elsewhere) and scan like the rest.
fn referrers_of(
    base: &bi_engine::DataModel,
    calculated: &[super::types::CalculatedMeasure],
    name: &str,
) -> Vec<String> {
    let mut measure_names: HashSet<String> =
        base.measures().iter().map(|m| m.name().to_string()).collect();
    measure_names.extend(calculated.iter().map(|m| m.name.clone()));
    let global_names: HashSet<String> = base
        .global_variables()
        .iter()
        .map(|g| g.name().to_string())
        .collect();

    let mut referrers: Vec<String> = base
        .measures()
        .iter()
        .filter(|m| m.name() != name)
        .filter(|m| {
            bi_engine::extract_dependencies(m.expression(), &measure_names, &global_names)
                .measures
                .iter()
                .any(|r| r == name)
        })
        .map(|m| m.name().to_string())
        .collect();
    for cm in calculated {
        if cm.name == name {
            continue;
        }
        if let Ok(expr) = bi_engine::parse_measure_expression(&cm.expression) {
            if bi_engine::extract_dependencies(&expr, &measure_names, &global_names)
                .measures
                .iter()
                .any(|r| r == name)
            {
                referrers.push(format!("{} (workbook measure)", cm.name));
            }
        }
    }
    referrers
}

/// Remove a measure, refusing (with the referrer list) when other model
/// measures OR workbook calculated measures still reference it.
fn delete_measure_model(
    base: &bi_engine::DataModel,
    calculated: &[super::types::CalculatedMeasure],
    name: &str,
) -> Result<bi_engine::DataModel, String> {
    let referenced_by = referrers_of(base, calculated, name);
    if !referenced_by.is_empty() {
        return Err(format!(
            "Cannot delete '{}': it is referenced by {}",
            name,
            referenced_by.join(", ")
        ));
    }

    let mut measures: Vec<bi_engine::Measure> = base.measures().to_vec();
    let before = measures.len();
    measures.retain(|m| m.name() != name);
    if measures.len() == before {
        return Err(format!("Measure '{}' not found in the model", name));
    }
    let edited = base.with_measures(measures);
    edited.validate().map_err(|e| format!("{}", e))?;
    Ok(edited)
}

/// Fetch the EDITABLE base model + the connection's calculated-measure overlay.
/// Package-subscribed models are read-only: they reconstruct from the package
/// on every refresh, so local edits would silently vanish.
fn editable_base(
    bi_state: &BiState,
    connection_id: ConnectionId,
) -> Result<(bi_engine::DataModel, Vec<super::types::CalculatedMeasure>), String> {
    let conns = bi_state.connections.lock().unwrap();
    let conn = conns.get(&connection_id).ok_or("Connection not found")?;
    if conn.package_data_source_id.is_some() {
        return Err(
            "Package-subscribed models are read-only — they reconstruct from the package on \
             every refresh, so edits would be lost. Edit the model in the publishing workbook \
             and republish instead."
                .to_string(),
        );
    }
    let base = conn
        .base_model
        .clone()
        .ok_or("This connection has no editable base model")?;
    Ok((base, conn.calculated_measures.clone()))
}

/// Apply a model edit under the ENGINE LOCK — the serialization point for
/// every model writer (measure edits, calculated measures, dataset refresh).
/// The base + overlay are snapshotted, edited, validated, installed, and
/// mirrored onto every model-sharing connection all while the lock is held,
/// so a concurrent writer can neither interleave between snapshot and install
/// nor observe a half-applied state.
async fn apply_model_edit<F>(
    bi_state: &BiState,
    connection_id: ConnectionId,
    edit: F,
) -> Result<Vec<ModelMeasureInfo>, String>
where
    F: FnOnce(
        &bi_engine::DataModel,
        &[super::types::CalculatedMeasure],
    ) -> Result<bi_engine::DataModel, String>,
{
    let engine_arc = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        conn.engine
            .clone()
            .ok_or("No model loaded for this connection")?
    };
    let mut guard = engine_arc.lock().await;

    // Fresh snapshot under the engine lock (the pre-lock snapshot used to
    // build editor input may be stale by now). Brief connections locks nested
    // under the engine lock follow the established engine->connections order
    // (any conflicting connections->engine path uses try_lock).
    let (base, calculated, model_key) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        (
            conn.base_model
                .clone()
                .ok_or("This connection has no editable base model")?,
            conn.calculated_measures.clone(),
            conn.model_key.clone(),
        )
    };

    let new_base = edit(&base, &calculated)?;
    let combined = build_combined_model(&new_base, &calculated)?;
    guard.set_model(combined).map_err(|e| format!("{}", e))?;

    let infos: Vec<ModelMeasureInfo> = new_base.measures().iter().map(measure_info).collect();
    {
        let mut conns = bi_state.connections.lock().unwrap();
        for c in conns.values_mut() {
            if c.model_key == model_key {
                c.base_model = Some(new_base.clone());
            }
        }
    }
    drop(guard);
    Ok(infos)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// List the measures of a connection's base model (editable or not).
#[tauri::command]
pub fn bi_model_get_measures(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
) -> Result<Vec<ModelMeasureInfo>, String> {
    let conns = bi_state.connections.lock().unwrap();
    let conn = conns.get(&connection_id).ok_or("Connection not found")?;
    let base = conn
        .base_model
        .as_ref()
        .ok_or("This connection has no loaded model")?;
    Ok(base.measures().iter().map(measure_info).collect())
}

/// Dry-run validation for the measure editor: positioned parse errors first,
/// then the full upsert pipeline (collisions, unknown columns, dangling refs,
/// calculated-measure overlay conflicts) without applying anything.
#[tauri::command]
pub fn bi_model_validate_measure(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    formula: String,
) -> Result<MeasureValidation, String> {
    let (base, calculated) = match editable_base(&bi_state, connection_id) {
        Ok(v) => v,
        Err(e) => {
            return Ok(MeasureValidation { ok: false, message: Some(e), position: None });
        }
    };
    if let Err(e) = bi_engine::parse_measure_expression(&formula) {
        return Ok(match e {
            bi_engine::EngineError::ParseError { position, message } => MeasureValidation {
                ok: false,
                message: Some(message),
                position: Some(position),
            },
            other => MeasureValidation {
                ok: false,
                message: Some(format!("{}", other)),
                position: None,
            },
        });
    }
    let dry_run = build_measure(&name, &formula, None, None)
        .and_then(|m| upsert_measure_model(&base, original_name.as_deref(), m))
        .and_then(|edited| build_combined_model(&edited, &calculated));
    Ok(match dry_run {
        Ok(_) => MeasureValidation { ok: true, message: None, position: None },
        Err(e) => MeasureValidation { ok: false, message: Some(e), position: None },
    })
}

/// Add or update (original_name = Some) a measure in the connection's model.
/// Returns the updated measure list.
#[tauri::command]
pub async fn bi_model_upsert_measure(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    formula: String,
    description: Option<String>,
    format_string: Option<String>,
    window: tauri::Window,
) -> Result<Vec<ModelMeasureInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Editability check up front (clear error before any engine wait).
    let _ = editable_base(&bi_state, connection_id)?;
    let orig = original_name.clone();
    let new_name = name.clone();
    let infos = apply_model_edit(&bi_state, connection_id, move |base, _calculated| {
        // A SOURCELESS measure's editor text is an AST rendering that may not
        // round-trip the parser (Studio-only syntax). When the user did not
        // touch the formula, keep the stored expression and only apply the
        // metadata — never re-parse text the user never wrote.
        let original = orig
            .as_deref()
            .and_then(|o| base.measures().iter().find(|m| m.name() == o).cloned());
        let measure = match &original {
            Some(orig_m)
                if orig_m.source().is_none()
                    && formula == bi_engine::measure_to_formula(orig_m) =>
            {
                let trimmed = new_name.trim();
                if trimmed.is_empty() {
                    return Err("Measure name cannot be empty".to_string());
                }
                let mut m = bi_engine::Measure::new(trimmed, orig_m.expression().clone());
                if let Some(d) = description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                    m = m.with_description(d);
                }
                if let Some(f) = format_string.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
                    m = m.with_format_string(f);
                }
                m
            }
            _ => build_measure(
                &new_name,
                &formula,
                description.as_deref(),
                format_string.as_deref(),
            )?,
        };
        upsert_measure_model(base, orig.as_deref(), measure)
    })
    .await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    crate::log_info!("BI", "model editor: upserted measure '{}' (conn {})", name, connection_id);
    Ok(infos)
}

/// Delete a measure from the connection's model. Refuses when other model
/// measures reference it. Returns the updated measure list.
#[tauri::command]
pub async fn bi_model_delete_measure(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<Vec<ModelMeasureInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let _ = editable_base(&bi_state, connection_id)?;
    let target = name.clone();
    let infos = apply_model_edit(&bi_state, connection_id, move |base, calculated| {
        delete_measure_model(base, calculated, &target)
    })
    .await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    crate::log_info!("BI", "model editor: deleted measure '{}' (conn {})", name, connection_id);
    Ok(infos)
}

/// Lineage for one measure: what it references and what references it.
#[tauri::command]
pub fn bi_model_measure_lineage(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    name: String,
) -> Result<MeasureLineage, String> {
    let conns = bi_state.connections.lock().unwrap();
    let conn = conns.get(&connection_id).ok_or("Connection not found")?;
    let base = conn
        .base_model
        .as_ref()
        .ok_or("This connection has no loaded model")?;

    let measure_names: HashSet<String> =
        base.measures().iter().map(|m| m.name().to_string()).collect();
    let global_names: HashSet<String> = base
        .global_variables()
        .iter()
        .map(|g| g.name().to_string())
        .collect();

    let target = base
        .measures()
        .iter()
        .find(|m| m.name() == name)
        .ok_or_else(|| format!("Measure '{}' not found in the model", name))?;

    let deps = bi_engine::extract_dependencies(target.expression(), &measure_names, &global_names);
    // Includes workbook calculated measures (marked as such) — delete impact
    // must show EVERYTHING that would break.
    let referenced_by = referrers_of(base, &conn.calculated_measures, &name);

    Ok(MeasureLineage {
        measures: deps.measures,
        columns: deps
            .columns
            .into_iter()
            .map(|(table, column)| LineageColumn { table, column })
            .collect(),
        contexts: deps.contexts,
        table_variables: deps.table_variables,
        globals: deps.globals,
        referenced_by,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use bi_engine::{sum_measure, Column, DataModel, DataType, StorageMode, Table};

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
    fn add_measure_preserves_source_text() {
        let m = build_measure("Orders", "COUNT(Sales[country])", Some("How many"), None).unwrap();
        let edited = upsert_measure_model(&base_model(), None, m).unwrap();
        let added = edited.measures().iter().find(|m| m.name() == "Orders").unwrap();
        assert_eq!(added.source(), Some("COUNT(Sales[country])"));
        assert_eq!(added.description(), Some("How many"));
        assert_eq!(added.table(), "Sales");
    }

    #[test]
    fn add_rejects_name_collision() {
        let m = build_measure("Revenue", "SUM(Sales[amount])", None, None).unwrap();
        let err = upsert_measure_model(&base_model(), None, m).unwrap_err();
        assert!(err.contains("already exists"), "got: {}", err);
    }

    #[test]
    fn update_replaces_in_place_and_rename_collision_is_rejected() {
        let base = base_model();
        let m = build_measure("Orders", "COUNT(Sales[country])", None, None).unwrap();
        let base = upsert_measure_model(&base, None, m).unwrap();

        // Update the formula in place.
        let m2 = build_measure("Orders", "COUNT(Sales[amount])", None, None).unwrap();
        let edited = upsert_measure_model(&base, Some("Orders"), m2).unwrap();
        assert_eq!(
            edited.measures().iter().find(|m| m.name() == "Orders").unwrap().source(),
            Some("COUNT(Sales[amount])")
        );

        // Renaming onto an existing name is rejected.
        let m3 = build_measure("Revenue", "COUNT(Sales[amount])", None, None).unwrap();
        let err = upsert_measure_model(&base, Some("Orders"), m3).unwrap_err();
        assert!(err.contains("already exists"), "got: {}", err);
    }

    #[test]
    fn rename_leaving_dangling_reference_is_rejected_by_validate() {
        let base = base_model();
        let dep = build_measure("Boosted", "[Revenue] + SUM(Sales[amount])", None, None).unwrap();
        let base = upsert_measure_model(&base, None, dep).unwrap();

        // Rename Revenue -> Income: Boosted's [Revenue] now dangles.
        let renamed = build_measure("Income", "SUM(Sales[amount])", None, None).unwrap();
        assert!(upsert_measure_model(&base, Some("Revenue"), renamed).is_err());
    }

    #[test]
    fn delete_refuses_when_referenced_and_lists_referrers() {
        let base = base_model();
        let dep = build_measure("Boosted", "[Revenue] + SUM(Sales[amount])", None, None).unwrap();
        let base = upsert_measure_model(&base, None, dep).unwrap();

        let err = delete_measure_model(&base, &[], "Revenue").unwrap_err();
        assert!(err.contains("Boosted"), "got: {}", err);

        // Deleting the leaf measure works.
        let edited = delete_measure_model(&base, &[], "Boosted").unwrap();
        assert!(edited.measures().iter().all(|m| m.name() != "Boosted"));
    }

    #[test]
    fn delete_refuses_when_a_workbook_calculated_measure_references_it() {
        use crate::bi::types::CalculatedMeasure;
        let calculated = vec![CalculatedMeasure {
            name: "Margin".to_string(),
            expression: "[Revenue] / SUM(Sales[amount])".to_string(),
        }];
        let err = delete_measure_model(&base_model(), &calculated, "Revenue").unwrap_err();
        assert!(err.contains("Margin (workbook measure)"), "got: {}", err);
    }

    #[test]
    fn editing_preserves_hidden_flag() {
        let base = base_model().with_measures(vec![
            bi_engine::sum_measure("Revenue", "Sales", "amount").hidden(),
        ]);
        let edited_measure =
            build_measure("Revenue", "SUM(Sales[amount]) * 2", None, None).unwrap();
        let edited = upsert_measure_model(&base, Some("Revenue"), edited_measure).unwrap();
        assert!(edited.measures()[0].is_hidden(), "edit must not unhide");
    }

    #[test]
    fn pure_measure_reference_is_rejected_with_column_guidance() {
        let err = build_measure("Bad", "[Revenue] * 2", None, None).unwrap_err();
        assert!(err.contains("column form"), "got: {}", err);
    }

    #[test]
    fn delete_missing_measure_errors() {
        assert!(delete_measure_model(&base_model(), &[], "Nope").is_err());
    }
}
