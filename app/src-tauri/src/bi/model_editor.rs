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

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::State;

use super::engine_registry::ModelKey;
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
// ---------------------------------------------------------------------------
// Model-edit undo/redo
// ---------------------------------------------------------------------------
//
// Model edits are NOT part of the grid's cell-transaction undo stack (they
// mutate a shared engine model, not the workbook grid). Instead every mutation
// that flows through `apply_model_edit` records the PRE-edit base_model on a
// per-`model_key` snapshot stack; undo/redo reinstall a snapshot on the shared
// engine and mirror it to every connection sharing that model (the same
// install path apply_model_edit uses). Keyed by model_key because connections
// sharing a model share edits.

#[derive(Default)]
struct ModelUndoStacks {
    undo: Vec<bi_engine::DataModel>,
    redo: Vec<bi_engine::DataModel>,
}

/// Cap the snapshot depth (each entry is a full model clone).
const MAX_MODEL_UNDO: usize = 50;

fn model_undo_store() -> &'static Mutex<HashMap<Option<ModelKey>, ModelUndoStacks>> {
    static STORE: OnceLock<Mutex<HashMap<Option<ModelKey>, ModelUndoStacks>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record a pre-edit snapshot for a model_key and clear its redo stack (a new
/// edit invalidates the redo branch).
fn record_model_undo(model_key: &Option<ModelKey>, pre_edit: bi_engine::DataModel) {
    if let Ok(mut store) = model_undo_store().lock() {
        let stacks = store.entry(model_key.clone()).or_default();
        stacks.undo.push(pre_edit);
        if stacks.undo.len() > MAX_MODEL_UNDO {
            stacks.undo.remove(0);
        }
        stacks.redo.clear();
    }
}

/// Install a base model on the connection's shared engine and mirror it onto
/// every connection sharing that model. Shared by undo and redo (does NOT touch
/// the undo stacks). Lock order engine -> connections, as elsewhere.
async fn install_base_model(
    bi_state: &BiState,
    connection_id: &ConnectionId,
    new_base: &bi_engine::DataModel,
) -> Result<(), String> {
    let (engine_arc, calculated, model_key) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(connection_id).ok_or("Connection not found")?;
        (
            conn.engine
                .clone()
                .ok_or("No model loaded for this connection")?,
            conn.calculated_measures.clone(),
            conn.model_key.clone(),
        )
    };
    let mut guard = engine_arc.lock().await;
    let combined = build_combined_model(new_base, &calculated)?;
    guard.set_model(combined).map_err(|e| format!("{}", e))?;
    {
        let mut conns = bi_state.connections.lock().unwrap();
        for c in conns.values_mut() {
            if c.model_key == model_key {
                c.base_model = Some(new_base.clone());
            }
        }
    }
    drop(guard);
    Ok(())
}

async fn apply_model_edit<F>(
    bi_state: &BiState,
    connection_id: ConnectionId,
    edit: F,
) -> Result<bi_engine::DataModel, String>
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

    {
        let mut conns = bi_state.connections.lock().unwrap();
        for c in conns.values_mut() {
            if c.model_key == model_key {
                c.base_model = Some(new_base.clone());
            }
        }
    }
    drop(guard);
    // Record the pre-edit state for undo (after a successful install).
    record_model_undo(&model_key, base);
    Ok(new_base)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// List the measures of a connection's base model (editable or not).
#[tauri::command]
pub fn bi_model_get_measures(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<Vec<ModelMeasureInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
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
    window: tauri::Window,
) -> Result<MeasureValidation, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
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
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
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
    Ok(infos.measures().iter().map(measure_info).collect())
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
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let _ = editable_base(&bi_state, connection_id)?;
    let target = name.clone();
    let infos = apply_model_edit(&bi_state, connection_id, move |base, calculated| {
        delete_measure_model(base, calculated, &target)
    })
    .await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    crate::log_info!("BI", "model editor: deleted measure '{}' (conn {})", name, connection_id);
    Ok(infos.measures().iter().map(measure_info).collect())
}

/// Lineage for one measure: what it references and what references it.
#[tauri::command]
pub fn bi_model_measure_lineage(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<MeasureLineage, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
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
// Model-wide dependency graph (Lineage section)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyNodeDto {
    /// Stable id: "measure:{name}" | "global:{name}" |
    /// "cc:{table}.{name}" | "ctxcol:{table}.{name}".
    pub id: String,
    /// "measure" | "globalVariable" | "calculatedColumn" | "contextColumn".
    pub node_type: String,
    pub name: String,
    pub table: Option<String>,
    pub expression: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdgeDto {
    /// The dependant.
    pub from_id: String,
    /// The referenced node (a measure or global that this node depends on).
    pub to_id: String,
    /// "measure" | "global".
    pub edge_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyGraphDto {
    pub nodes: Vec<DependencyNodeDto>,
    pub edges: Vec<DependencyEdgeDto>,
}

/// Model-wide dependency graph over the expression-bearing entities (measures,
/// global variables, calculated columns, context columns). Edges point from a
/// dependant to each measure/global it references (via `extract_dependencies`).
#[tauri::command]
pub fn bi_model_dependency_graph(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<DependencyGraphDto, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
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

    let mut nodes: Vec<DependencyNodeDto> = Vec::new();
    let mut edges: Vec<DependencyEdgeDto> = Vec::new();

    // Push a node's outgoing edges from its expression's referenced measures +
    // globals.
    let mut add_edges = |from_id: &str, expr: &bi_engine::Expression| {
        let deps = bi_engine::extract_dependencies(expr, &measure_names, &global_names);
        for m in deps.measures {
            edges.push(DependencyEdgeDto {
                from_id: from_id.to_string(),
                to_id: format!("measure:{}", m),
                edge_type: "measure".to_string(),
            });
        }
        for g in deps.globals {
            edges.push(DependencyEdgeDto {
                from_id: from_id.to_string(),
                to_id: format!("global:{}", g),
                edge_type: "global".to_string(),
            });
        }
    };

    for m in base.measures() {
        let id = format!("measure:{}", m.name());
        add_edges(&id, m.expression());
        nodes.push(DependencyNodeDto {
            id,
            node_type: "measure".to_string(),
            name: m.name().to_string(),
            table: Some(m.table().to_string()),
            expression: Some(
                m.source()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| bi_engine::measure_to_formula(m)),
            ),
        });
    }

    for g in base.global_variables() {
        let id = format!("global:{}", g.name());
        add_edges(&id, g.expression());
        nodes.push(DependencyNodeDto {
            id,
            node_type: "globalVariable".to_string(),
            name: g.name().to_string(),
            table: Some(g.table().to_string()),
            expression: Some(bi_engine::expression_to_formula(g.expression(), g.table())),
        });
    }

    for cc in base.calculated_columns() {
        let id = format!("cc:{}.{}", cc.table(), cc.name());
        add_edges(&id, cc.expression());
        nodes.push(DependencyNodeDto {
            id,
            node_type: "calculatedColumn".to_string(),
            name: cc.name().to_string(),
            table: Some(cc.table().to_string()),
            expression: Some(bi_engine::expression_to_formula(cc.expression(), cc.table())),
        });
    }

    for cc in base.context_columns() {
        let id = format!("ctxcol:{}.{}", cc.table(), cc.name());
        add_edges(&id, cc.expression());
        nodes.push(DependencyNodeDto {
            id,
            node_type: "contextColumn".to_string(),
            name: cc.name().to_string(),
            table: Some(cc.table().to_string()),
            expression: Some(bi_engine::expression_to_formula(cc.expression(), cc.table())),
        });
    }

    // Keep only edges whose target node exists, and drop duplicates.
    let node_ids: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    edges.retain(|e| {
        node_ids.contains(&e.to_id)
            && e.from_id != e.to_id
            && seen.insert((e.from_id.clone(), e.to_id.clone()))
    });

    Ok(DependencyGraphDto { nodes, edges })
}

// ===========================================================================
// ME-2..5: tables/columns, calculated columns, relationships, hierarchies,
// KPIs, security roles, calculation groups, schema import, blank models.
// Every mutation goes through apply_model_edit (engine-lock-serialized).
// ===========================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelColumnInfo {
    pub name: String,
    pub data_type: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub is_hidden: bool,
    /// True for a calculated column (refresh-time, expression-derived).
    pub is_calculated: bool,
    /// The calculated column's formula rendering (None for physical columns).
    pub formula: Option<String>,
    /// Resolution expression when this column is used as a lookup (physical
    /// columns only; None for calculated columns).
    pub lookup_resolution: Option<String>,
    /// Column to sort this column's values by (physical columns only).
    pub sort_by_column: Option<String>,
    /// Excel-style number format applied to this column's values in pivots.
    pub format_string: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTableInfo {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub is_hidden: bool,
    pub storage_mode: String,
    /// Whether this connection has a source binding for the table.
    pub bound: bool,
    /// The persisted-source id this table binds to (model catalog), or null.
    pub source_id: Option<String>,
    pub columns: Vec<ModelColumnInfo>,
    /// InMemory cache refresh strategies (empty = never auto-refresh; the cache
    /// is populated on first query and reused).
    pub refresh_strategies: Vec<RefreshStrategyDto>,
    /// Incremental-refresh filter (re-fetch only volatile rows), or null.
    pub incremental_refresh: Option<String>,
}

/// One InMemory refresh strategy, flattened into a `type`-discriminated struct
/// (the engine `RefreshStrategy` is an enum). Only the fields relevant to
/// `type` are populated.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshStrategyDto {
    /// "interval" | "containsCurrentDate" | "dailyAfter" | "sourceQuery"
    pub r#type: String,
    #[serde(default)]
    pub secs: Option<u64>,
    #[serde(default)]
    pub column: Option<String>,
    #[serde(default)]
    pub hour: Option<u8>,
    #[serde(default)]
    pub minute: Option<u8>,
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub source_table: Option<String>,
}

fn refresh_strategy_from_dto(d: &RefreshStrategyDto) -> Result<bi_engine::RefreshStrategy, String> {
    Ok(match d.r#type.as_str() {
        "interval" => bi_engine::RefreshStrategy::Interval {
            secs: d.secs.ok_or("An interval strategy needs a number of seconds")?,
        },
        "containsCurrentDate" => bi_engine::RefreshStrategy::ContainsCurrentDate {
            column: d
                .column
                .clone()
                .filter(|c| !c.trim().is_empty())
                .ok_or("A contains-current-date strategy needs a date column")?,
        },
        "dailyAfter" => bi_engine::RefreshStrategy::DailyAfter {
            hour: d.hour.ok_or("A daily-after strategy needs an hour")?,
            minute: d.minute.ok_or("A daily-after strategy needs a minute")?,
        },
        "sourceQuery" => bi_engine::RefreshStrategy::SourceQuery {
            sql: d
                .sql
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or("A source-query strategy needs a SQL query")?,
            source_table: d
                .source_table
                .clone()
                .filter(|s| !s.trim().is_empty()),
        },
        other => return Err(format!("Unknown refresh strategy '{}'", other)),
    })
}

fn refresh_strategy_to_dto(s: &bi_engine::RefreshStrategy) -> RefreshStrategyDto {
    let mut dto = RefreshStrategyDto {
        r#type: String::new(),
        secs: None,
        column: None,
        hour: None,
        minute: None,
        sql: None,
        source_table: None,
    };
    match s {
        bi_engine::RefreshStrategy::Interval { secs } => {
            dto.r#type = "interval".to_string();
            dto.secs = Some(*secs);
        }
        bi_engine::RefreshStrategy::ContainsCurrentDate { column } => {
            dto.r#type = "containsCurrentDate".to_string();
            dto.column = Some(column.clone());
        }
        bi_engine::RefreshStrategy::DailyAfter { hour, minute } => {
            dto.r#type = "dailyAfter".to_string();
            dto.hour = Some(*hour);
            dto.minute = Some(*minute);
        }
        bi_engine::RefreshStrategy::SourceQuery { sql, source_table } => {
            dto.r#type = "sourceQuery".to_string();
            dto.sql = Some(sql.clone());
            dto.source_table = source_table.clone();
        }
    }
    dto
}

fn default_join_operator() -> String {
    "=".to_string()
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipConditionDto {
    pub from_column: String,
    pub to_column: String,
    /// Join operator ("=" default; ">", ">=", "<", "<=" for range joins).
    /// Round-tripped so editing a relationship never coerces its operators.
    #[serde(default = "default_join_operator")]
    pub operator: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRelationshipInfo {
    pub name: String,
    pub from_table: String,
    pub to_table: String,
    pub conditions: Vec<RelationshipConditionDto>,
    pub cardinality: String,
    pub active: bool,
    /// "auto" | "none" | "both" — round-tripped so editing never drops it.
    pub filter_propagation: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyLevelDto {
    pub column: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Ragged-hierarchy metadata — round-tripped so edits never drop it.
    #[serde(default)]
    pub is_optional: bool,
    #[serde(default)]
    pub stopper_value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHierarchyInfo {
    pub name: String,
    pub table: String,
    pub levels: Vec<HierarchyLevelDto>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiBandDto {
    pub threshold: f64,
    /// "offTrack" | "atRisk" | "onTrack"
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelKpiInfo {
    pub name: String,
    pub base_measure: String,
    pub target_measure: Option<String>,
    pub target_constant: Option<f64>,
    pub status_bands: Vec<KpiBandDto>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleFilterDto {
    pub table: String,
    pub column: String,
    /// "=" | "!=" | ">" | ">=" | "<" | "<="
    pub operator: String,
    pub value: String,
    /// None = static value; "username" | "customData" = dynamic RLS.
    pub dynamic: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoleInfo {
    pub name: String,
    pub filters: Vec<RoleFilterDto>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcGroupItemDto {
    pub name: String,
    pub formula: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCalcGroupInfo {
    pub name: String,
    pub items: Vec<CalcGroupItemDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelGlobalVariableInfo {
    pub name: String,
    pub table: String,
    /// Rendered expression text (the model stores an AST; there is no author
    /// source string for globals — same lossless concern as measures).
    pub expression: String,
    /// True when the expression is a table-producing QUERY(...) global.
    pub is_query: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTableVariableInfo {
    pub name: String,
    /// Base table or another table-variable name.
    pub source: String,
    pub filters: Vec<RoleFilterDto>,
}

/// A clear/reset target within a context operation.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearTargetDto {
    /// "column" | "table".
    pub kind: String,
    pub table: String,
    /// Present only for a "column" target.
    #[serde(default)]
    pub column: Option<String>,
}

/// An IN-membership predicate (`table.column IN var_name.var_column`) for a
/// context KeepIn operation.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InPredicateDto {
    pub table: String,
    pub column: String,
    pub var_name: String,
    pub var_column: String,
}

/// A single context operation, flattened into a discriminated struct so the
/// engine `ContextOp` enum crosses IPC losslessly (see the enum⇄struct bridge
/// helpers). Only the fields relevant to `type` are populated.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextOpDto {
    /// "keep" | "keepIn" | "clear" | "clearInner" | "clearOuter" | "reset" |
    /// "resetInner" | "resetOuter" | "inherit" | "useRelationship".
    pub r#type: String,
    #[serde(default)]
    pub filters: Vec<RoleFilterDto>,
    #[serde(default)]
    pub clear_targets: Vec<ClearTargetDto>,
    #[serde(default)]
    pub in_predicates: Vec<InPredicateDto>,
    #[serde(default)]
    pub inherit_context: Option<String>,
    #[serde(default)]
    pub relationship_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextInfo {
    pub name: String,
    pub operations: Vec<ContextOpDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextColumnInfo {
    pub name: String,
    pub table: String,
    /// Rendered row-level expression (may embed a scalar [Measure]).
    pub expression: String,
    pub data_type: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptParamDto {
    pub name: String,
    /// "Int" | "Float" | "Bool" | "String".
    pub ty: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelScriptFunctionInfo {
    pub name: String,
    pub params: Vec<ScriptParamDto>,
    pub return_type: String,
    /// The Rhai source body (stored verbatim, so no AST round-trip risk).
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverview {
    pub editable: bool,
    pub read_only_reason: Option<String>,
    pub tables: Vec<ModelTableInfo>,
    pub relationships: Vec<ModelRelationshipInfo>,
    pub hierarchies: Vec<ModelHierarchyInfo>,
    pub kpis: Vec<ModelKpiInfo>,
    pub security_roles: Vec<ModelRoleInfo>,
    pub calculation_groups: Vec<ModelCalcGroupInfo>,
    pub measures: Vec<ModelMeasureInfo>,
    pub contexts: Vec<ModelContextInfo>,
    pub context_columns: Vec<ModelContextColumnInfo>,
    pub table_variables: Vec<ModelTableVariableInfo>,
    pub global_variables: Vec<ModelGlobalVariableInfo>,
    pub script_functions: Vec<ModelScriptFunctionInfo>,
    /// Name of the marked date table (drives time intelligence), or null.
    pub date_table: Option<String>,
    /// Model-level default lookup-resolution expression, or null.
    pub default_lookup_resolution: Option<String>,
    /// Descriptive metadata (presentation only).
    pub model_name: Option<String>,
    pub model_version: Option<String>,
    pub model_author: Option<String>,
    pub model_description: Option<String>,
    /// The model's persisted data-source catalog (engine v14). Drives the
    /// Connections tab; a model may bind different tables to different sources.
    pub sources: Vec<ModelSourceInfo>,
}

/// One entry in the model's persisted data-source catalog (secret-free).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSourceInfo {
    pub id: String,
    /// "postgres" | "sqlServer" | "inMemory" | "csv" | "parquet"
    pub kind: String,
    pub display_name: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub default_schema: Option<String>,
    /// "integrated" | "usernamePassword" | "environmentVariable"
    pub preferred_auth: String,
    /// Explicit TLS mode: "disable" | "prefer" | "require", or null (default).
    pub ssl_mode: Option<String>,
    /// How many model tables bind to this source.
    pub table_count: usize,
}

/// Wire string for an engine [`bi_engine::SourceKind`].
fn source_kind_str(kind: bi_engine::SourceKind) -> &'static str {
    match kind {
        bi_engine::SourceKind::Postgres => "postgres",
        bi_engine::SourceKind::SqlServer => "sqlServer",
        bi_engine::SourceKind::InMemory => "inMemory",
        bi_engine::SourceKind::Csv => "csv",
        bi_engine::SourceKind::Parquet => "parquet",
    }
}

/// Parse a wire kind string back to an engine [`bi_engine::SourceKind`].
fn source_kind_from_str(s: &str) -> Result<bi_engine::SourceKind, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" => Ok(bi_engine::SourceKind::Postgres),
        "sqlserver" | "sql server" | "mssql" => Ok(bi_engine::SourceKind::SqlServer),
        "inmemory" | "in-memory" => Ok(bi_engine::SourceKind::InMemory),
        "csv" => Ok(bi_engine::SourceKind::Csv),
        "parquet" => Ok(bi_engine::SourceKind::Parquet),
        other => Err(format!("Unknown data source kind '{}'", other)),
    }
}

/// Wire string for an engine [`bi_engine::PersistedAuthKind`].
fn persisted_auth_str(kind: bi_engine::PersistedAuthKind) -> &'static str {
    match kind {
        bi_engine::PersistedAuthKind::Integrated => "integrated",
        bi_engine::PersistedAuthKind::UsernamePassword => "usernamePassword",
        bi_engine::PersistedAuthKind::EnvironmentVariable => "environmentVariable",
    }
}

/// Parse a wire auth string back to an engine [`bi_engine::PersistedAuthKind`].
fn persisted_auth_from_str(s: &str) -> bi_engine::PersistedAuthKind {
    match s.trim().to_ascii_lowercase().as_str() {
        "integrated" | "windows" | "kerberos" => bi_engine::PersistedAuthKind::Integrated,
        "environmentvariable" | "environment" | "env" => {
            bi_engine::PersistedAuthKind::EnvironmentVariable
        }
        _ => bi_engine::PersistedAuthKind::UsernamePassword,
    }
}

/// Build the overview's source-catalog entries from the model.
fn build_source_infos(base: &bi_engine::DataModel) -> Vec<ModelSourceInfo> {
    base.sources()
        .iter()
        .map(|s| ModelSourceInfo {
            id: s.id.clone(),
            kind: source_kind_str(s.kind).to_string(),
            display_name: s.display_name.clone(),
            host: s.connection.host.clone(),
            port: s.connection.port,
            database: s.connection.database.clone(),
            default_schema: s.connection.default_schema.clone(),
            preferred_auth: persisted_auth_str(s.preferred_auth).to_string(),
            ssl_mode: s.connection.ssl_mode.clone(),
            table_count: base
                .tables()
                .iter()
                .filter(|t| t.source_binding().map(|b| b.source_id == s.id).unwrap_or(false))
                .count(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTableInfo {
    pub schema: String,
    pub name: String,
    /// A model table with this name already exists.
    pub imported: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTableRef {
    pub schema: String,
    pub name: String,
}

// ---------------------------------------------------------------------------
// String <-> engine enum maps
// ---------------------------------------------------------------------------

fn cardinality_to_str(c: bi_engine::Cardinality) -> &'static str {
    match c {
        bi_engine::Cardinality::ManyToOne => "manyToOne",
        bi_engine::Cardinality::OneToMany => "oneToMany",
        bi_engine::Cardinality::OneToOne => "oneToOne",
        bi_engine::Cardinality::ManyToMany => "manyToMany",
    }
}

fn cardinality_from_str(s: &str) -> Result<bi_engine::Cardinality, String> {
    Ok(match s {
        "manyToOne" => bi_engine::Cardinality::ManyToOne,
        "oneToMany" => bi_engine::Cardinality::OneToMany,
        "oneToOne" => bi_engine::Cardinality::OneToOne,
        "manyToMany" => bi_engine::Cardinality::ManyToMany,
        other => return Err(format!("Unknown cardinality '{}'", other)),
    })
}

fn join_operator_from_str(s: &str) -> Result<bi_engine::JoinOperator, String> {
    Ok(match s {
        "=" => bi_engine::JoinOperator::Equal,
        ">" => bi_engine::JoinOperator::GreaterThan,
        ">=" => bi_engine::JoinOperator::GreaterThanOrEqual,
        "<" => bi_engine::JoinOperator::LessThan,
        "<=" => bi_engine::JoinOperator::LessThanOrEqual,
        other => return Err(format!("Unknown join operator '{}'", other)),
    })
}

fn comparison_op_from_str(s: &str) -> Result<bi_engine::ComparisonOp, String> {
    Ok(match s {
        "=" => bi_engine::ComparisonOp::Equal,
        "!=" => bi_engine::ComparisonOp::NotEqual,
        ">" => bi_engine::ComparisonOp::GreaterThan,
        ">=" => bi_engine::ComparisonOp::GreaterThanOrEqual,
        "<" => bi_engine::ComparisonOp::LessThan,
        "<=" => bi_engine::ComparisonOp::LessThanOrEqual,
        other => return Err(format!("Unknown operator '{}'", other)),
    })
}

fn dynamic_kind_to_str(d: &bi_engine::expression::DynamicValue) -> String {
    match d {
        bi_engine::expression::DynamicValue::Username => "username".to_string(),
        bi_engine::expression::DynamicValue::CustomData => "customData".to_string(),
    }
}

/// Convert a filter DTO (shared by roles, table variables and context Keep ops)
/// into an engine predicate, honoring the static/dynamic (USERNAME/CUSTOMDATA)
/// distinction.
fn predicate_from_dto(f: &RoleFilterDto) -> Result<bi_engine::FilterPredicate, String> {
    let op = comparison_op_from_str(&f.operator)?;
    Ok(match f.dynamic.as_deref() {
        Some("username") => {
            bi_engine::FilterPredicate::username(f.table.clone(), f.column.clone(), op)
        }
        Some("customData") => {
            bi_engine::FilterPredicate::custom_data(f.table.clone(), f.column.clone(), op)
        }
        Some(other) => return Err(format!("Unknown dynamic kind '{}'", other)),
        None => {
            bi_engine::FilterPredicate::new(f.table.clone(), f.column.clone(), op, f.value.clone())
        }
    })
}

/// Convert an engine predicate back into the filter DTO (lossless round-trip).
fn predicate_to_dto(f: &bi_engine::FilterPredicate) -> RoleFilterDto {
    RoleFilterDto {
        table: f.table.clone(),
        column: f.column.clone(),
        operator: f.operator.as_sql().to_string(),
        value: f.value.clone(),
        dynamic: f.dynamic.as_ref().map(dynamic_kind_to_str),
    }
}

fn propagation_to_str(p: bi_engine::FilterPropagation) -> &'static str {
    match p {
        bi_engine::FilterPropagation::Auto => "auto",
        bi_engine::FilterPropagation::None => "none",
        bi_engine::FilterPropagation::Both => "both",
    }
}

fn propagation_from_str(s: &str) -> Result<bi_engine::FilterPropagation, String> {
    Ok(match s {
        "auto" => bi_engine::FilterPropagation::Auto,
        "none" => bi_engine::FilterPropagation::None,
        "both" => bi_engine::FilterPropagation::Both,
        other => return Err(format!("Unknown filter propagation '{}'", other)),
    })
}

fn script_type_from_str(s: &str) -> Result<bi_engine::ScriptType, String> {
    Ok(match s {
        "Int" => bi_engine::ScriptType::Int,
        "Float" => bi_engine::ScriptType::Float,
        "Bool" => bi_engine::ScriptType::Bool,
        "String" => bi_engine::ScriptType::String,
        other => return Err(format!("Unknown script type '{}'", other)),
    })
}

fn script_type_to_str(t: bi_engine::ScriptType) -> &'static str {
    match t {
        bi_engine::ScriptType::Int => "Int",
        bi_engine::ScriptType::Float => "Float",
        bi_engine::ScriptType::Bool => "Bool",
        bi_engine::ScriptType::String => "String",
    }
}

fn storage_mode_from_str(s: &str) -> Result<bi_engine::StorageMode, String> {
    Ok(match s {
        "DirectQuery" => bi_engine::StorageMode::DirectQuery,
        "InMemory" => bi_engine::StorageMode::InMemory,
        other => return Err(format!("Unknown storage mode '{}'", other)),
    })
}

fn clear_target_from_dto(t: &ClearTargetDto) -> Result<bi_engine::ClearTarget, String> {
    match t.kind.as_str() {
        "column" => {
            let column = t
                .column
                .clone()
                .filter(|c| !c.trim().is_empty())
                .ok_or("A column clear-target needs a column")?;
            Ok(bi_engine::ClearTarget::Column {
                table: t.table.clone(),
                column,
            })
        }
        "table" => Ok(bi_engine::ClearTarget::Table(t.table.clone())),
        other => Err(format!("Unknown clear-target kind '{}'", other)),
    }
}

fn clear_target_to_dto(t: &bi_engine::ClearTarget) -> ClearTargetDto {
    match t {
        bi_engine::ClearTarget::Column { table, column } => ClearTargetDto {
            kind: "column".to_string(),
            table: table.clone(),
            column: Some(column.clone()),
        },
        bi_engine::ClearTarget::Table(table) => ClearTargetDto {
            kind: "table".to_string(),
            table: table.clone(),
            column: None,
        },
    }
}

fn in_predicate_from_dto(p: &InPredicateDto) -> bi_engine::InPredicate {
    bi_engine::InPredicate::new(
        p.table.clone(),
        p.column.clone(),
        p.var_name.clone(),
        p.var_column.clone(),
    )
}

fn in_predicate_to_dto(p: &bi_engine::InPredicate) -> InPredicateDto {
    InPredicateDto {
        table: p.table.clone(),
        column: p.column.clone(),
        var_name: p.var_name.clone(),
        var_column: p.var_column.clone(),
    }
}

/// Build an engine [`ContextOp`] from the flat, discriminated DTO. The engine
/// type is an enum; the DTO carries every operand field and selects one by
/// `type`, so the bridge must hand-construct the correct variant (a naive serde
/// round-trip would not work).
fn context_op_from_dto(op: &ContextOpDto) -> Result<bi_engine::ContextOp, String> {
    Ok(match op.r#type.as_str() {
        "keep" => bi_engine::ContextOp::Keep(
            op.filters
                .iter()
                .map(predicate_from_dto)
                .collect::<Result<Vec<_>, String>>()?,
        ),
        "keepIn" => bi_engine::ContextOp::KeepIn(
            op.in_predicates.iter().map(in_predicate_from_dto).collect(),
        ),
        "clear" => bi_engine::ContextOp::Clear(
            op.clear_targets
                .iter()
                .map(clear_target_from_dto)
                .collect::<Result<Vec<_>, String>>()?,
        ),
        "clearInner" => bi_engine::ContextOp::ClearInner(
            op.clear_targets
                .iter()
                .map(clear_target_from_dto)
                .collect::<Result<Vec<_>, String>>()?,
        ),
        "clearOuter" => bi_engine::ContextOp::ClearOuter(
            op.clear_targets
                .iter()
                .map(clear_target_from_dto)
                .collect::<Result<Vec<_>, String>>()?,
        ),
        "reset" => bi_engine::ContextOp::Reset,
        "resetInner" => bi_engine::ContextOp::ResetInner,
        "resetOuter" => bi_engine::ContextOp::ResetOuter,
        "inherit" => bi_engine::ContextOp::Inherit(
            op.inherit_context
                .clone()
                .filter(|c| !c.trim().is_empty())
                .ok_or("An inherit operation needs a context name")?,
        ),
        "useRelationship" => bi_engine::ContextOp::UseRelationship(
            op.relationship_name
                .clone()
                .filter(|c| !c.trim().is_empty())
                .ok_or("A use-relationship operation needs a relationship name")?,
        ),
        other => return Err(format!("Unknown context operation '{}'", other)),
    })
}

/// Flatten an engine [`ContextOp`] back into the discriminated DTO for the
/// editor (the read half of the enum⇄struct bridge; must handle every variant
/// so a loaded model never panics or silently drops an operation).
fn context_op_to_dto(op: &bi_engine::ContextOp) -> ContextOpDto {
    let mut dto = ContextOpDto {
        r#type: String::new(),
        filters: Vec::new(),
        clear_targets: Vec::new(),
        in_predicates: Vec::new(),
        inherit_context: None,
        relationship_name: None,
    };
    match op {
        bi_engine::ContextOp::Keep(filters) => {
            dto.r#type = "keep".to_string();
            dto.filters = filters.iter().map(predicate_to_dto).collect();
        }
        bi_engine::ContextOp::KeepIn(preds) => {
            dto.r#type = "keepIn".to_string();
            dto.in_predicates = preds.iter().map(in_predicate_to_dto).collect();
        }
        bi_engine::ContextOp::Clear(targets) => {
            dto.r#type = "clear".to_string();
            dto.clear_targets = targets.iter().map(clear_target_to_dto).collect();
        }
        bi_engine::ContextOp::ClearInner(targets) => {
            dto.r#type = "clearInner".to_string();
            dto.clear_targets = targets.iter().map(clear_target_to_dto).collect();
        }
        bi_engine::ContextOp::ClearOuter(targets) => {
            dto.r#type = "clearOuter".to_string();
            dto.clear_targets = targets.iter().map(clear_target_to_dto).collect();
        }
        bi_engine::ContextOp::Reset => dto.r#type = "reset".to_string(),
        bi_engine::ContextOp::ResetInner => dto.r#type = "resetInner".to_string(),
        bi_engine::ContextOp::ResetOuter => dto.r#type = "resetOuter".to_string(),
        bi_engine::ContextOp::Inherit(name) => {
            dto.r#type = "inherit".to_string();
            dto.inherit_context = Some(name.clone());
        }
        bi_engine::ContextOp::UseRelationship(name) => {
            dto.r#type = "useRelationship".to_string();
            dto.relationship_name = Some(name.clone());
        }
    }
    dto
}

fn kpi_status_to_str(s: &bi_engine::KpiStatus) -> &'static str {
    match s {
        bi_engine::KpiStatus::OffTrack => "offTrack",
        bi_engine::KpiStatus::AtRisk => "atRisk",
        bi_engine::KpiStatus::OnTrack => "onTrack",
    }
}

fn kpi_status_from_str(s: &str) -> Result<bi_engine::KpiStatus, String> {
    Ok(match s {
        "offTrack" => bi_engine::KpiStatus::OffTrack,
        "atRisk" => bi_engine::KpiStatus::AtRisk,
        "onTrack" => bi_engine::KpiStatus::OnTrack,
        other => return Err(format!("Unknown KPI status '{}'", other)),
    })
}

/// Data types offered by the calculated-column editor. Decimal is excluded
/// (needs precision/scale parameters — not surfaced in v1).
fn data_type_from_str(s: &str) -> Result<bi_engine::DataType, String> {
    Ok(match s {
        "String" => bi_engine::DataType::String,
        "Int32" => bi_engine::DataType::Int32,
        "Int64" => bi_engine::DataType::Int64,
        "Float64" => bi_engine::DataType::Float64,
        "Boolean" => bi_engine::DataType::Boolean,
        "Date" => bi_engine::DataType::Date,
        "Timestamp" => bi_engine::DataType::Timestamp,
        other => return Err(format!("Unsupported data type '{}'", other)),
    })
}

// ---------------------------------------------------------------------------
// Overview assembly
// ---------------------------------------------------------------------------

fn build_overview(
    base: &bi_engine::DataModel,
    bindings: &[super::types::BiBindRequest],
    editable: bool,
    read_only_reason: Option<String>,
) -> ModelOverview {
    let tables = base
        .tables()
        .iter()
        .map(|t| {
            let mut columns: Vec<ModelColumnInfo> = t
                .columns()
                .iter()
                .map(|c| ModelColumnInfo {
                    name: c.name().to_string(),
                    data_type: format!("{:?}", c.data_type()),
                    display_name: c.display_name().map(|s| s.to_string()),
                    description: c.description().map(|s| s.to_string()),
                    is_hidden: c.is_hidden(),
                    is_calculated: false,
                    formula: None,
                    lookup_resolution: c.lookup_resolution().map(|s| s.to_string()),
                    sort_by_column: c.sort_by_column().map(|s| s.to_string()),
                    format_string: c.format_string().map(|s| s.to_string()),
                })
                .collect();
            columns.extend(
                base.calculated_columns()
                    .iter()
                    .filter(|cc| cc.table() == t.name())
                    .map(|cc| ModelColumnInfo {
                        name: cc.name().to_string(),
                        data_type: format!("{:?}", cc.data_type()),
                        display_name: None,
                        description: None,
                        is_hidden: false,
                        is_calculated: true,
                        formula: Some(bi_engine::expression_to_formula(
                            cc.expression(),
                            cc.table(),
                        )),
                        lookup_resolution: None,
                        sort_by_column: None,
                        format_string: None,
                    }),
            );
            ModelTableInfo {
                name: t.name().to_string(),
                display_name: t.display_name().map(|s| s.to_string()),
                description: t.description().map(|s| s.to_string()),
                is_hidden: t.is_hidden(),
                storage_mode: format!("{:?}", t.storage_mode()),
                // Bound if the model records a source for it (catalog) or the
                // connection has a live/app binding.
                bound: t.source_binding().is_some()
                    || bindings.iter().any(|b| b.model_table == t.name()),
                source_id: t.source_binding().map(|b| b.source_id.clone()),
                columns,
                refresh_strategies: t
                    .refresh_strategies()
                    .iter()
                    .map(refresh_strategy_to_dto)
                    .collect(),
                incremental_refresh: t
                    .incremental_refresh()
                    .map(|i| i.refresh_filter().to_string()),
            }
        })
        .collect();

    let relationships = base
        .relationships()
        .iter()
        .map(|r| ModelRelationshipInfo {
            name: r.name().to_string(),
            from_table: r.from_table().to_string(),
            to_table: r.to_table().to_string(),
            conditions: r
                .conditions()
                .iter()
                .map(|c| RelationshipConditionDto {
                    from_column: c.from_column().to_string(),
                    to_column: c.to_column().to_string(),
                    operator: c.operator().as_sql().to_string(),
                })
                .collect(),
            cardinality: cardinality_to_str(r.cardinality()).to_string(),
            active: r.is_active(),
            filter_propagation: propagation_to_str(r.propagation()).to_string(),
        })
        .collect();

    let hierarchies = base
        .hierarchies()
        .iter()
        .map(|h| ModelHierarchyInfo {
            name: h.name().to_string(),
            table: h.table().to_string(),
            levels: h
                .levels()
                .iter()
                .map(|l| HierarchyLevelDto {
                    column: l.column().to_string(),
                    display_name: l.display_name().map(|s| s.to_string()),
                    is_optional: l.is_optional(),
                    stopper_value: l.stopper_value().map(|s| s.to_string()),
                })
                .collect(),
        })
        .collect();

    let kpis = base
        .kpis()
        .iter()
        .map(|k| {
            let (target_measure, target_constant) = match k.target() {
                bi_engine::KpiTarget::Measure(m) => (Some(m.clone()), None),
                bi_engine::KpiTarget::Constant(v) => (None, Some(*v)),
            };
            ModelKpiInfo {
                name: k.name().to_string(),
                base_measure: k.base_measure().to_string(),
                target_measure,
                target_constant,
                status_bands: k
                    .status_bands()
                    .iter()
                    .map(|b| KpiBandDto {
                        threshold: b.threshold,
                        status: kpi_status_to_str(&b.status).to_string(),
                    })
                    .collect(),
                description: k.description().map(|s| s.to_string()),
            }
        })
        .collect();

    let security_roles = base
        .security_roles()
        .iter()
        .map(|r| ModelRoleInfo {
            name: r.name().to_string(),
            filters: r.table_filters().iter().map(predicate_to_dto).collect(),
        })
        .collect();

    let calculation_groups = base
        .calculation_groups()
        .iter()
        .map(|g| ModelCalcGroupInfo {
            name: g.name().to_string(),
            items: g
                .items()
                .iter()
                .map(|i| CalcGroupItemDto {
                    name: i.name().to_string(),
                    formula: i
                        .source()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| bi_engine::expression_to_formula(i.expression(), "")),
                })
                .collect(),
        })
        .collect();

    let contexts = base
        .contexts()
        .iter()
        .map(|c| ModelContextInfo {
            name: c.name().to_string(),
            operations: c.operations().iter().map(context_op_to_dto).collect(),
        })
        .collect();

    let context_columns = base
        .context_columns()
        .iter()
        .map(|cc| ModelContextColumnInfo {
            name: cc.name().to_string(),
            table: cc.table().to_string(),
            expression: bi_engine::expression_to_formula(cc.expression(), cc.table()),
            data_type: format!("{:?}", cc.data_type()),
            description: cc.description().map(|s| s.to_string()),
        })
        .collect();

    let table_variables = base
        .table_variables()
        .iter()
        .map(|tv| ModelTableVariableInfo {
            name: tv.name().to_string(),
            source: tv.source().to_string(),
            filters: tv.filters().iter().map(predicate_to_dto).collect(),
        })
        .collect();

    let global_variables = base
        .global_variables()
        .iter()
        .map(|gv| ModelGlobalVariableInfo {
            name: gv.name().to_string(),
            table: gv.table().to_string(),
            expression: bi_engine::expression_to_formula(gv.expression(), gv.table()),
            is_query: gv.is_query(),
        })
        .collect();

    let script_functions = base
        .script_functions()
        .iter()
        .map(|sf| ModelScriptFunctionInfo {
            name: sf.name().to_string(),
            params: sf
                .params()
                .iter()
                .map(|p| ScriptParamDto {
                    name: p.name().to_string(),
                    ty: script_type_to_str(p.ty()).to_string(),
                })
                .collect(),
            return_type: script_type_to_str(sf.return_type()).to_string(),
            body: sf.body().to_string(),
        })
        .collect();

    ModelOverview {
        editable,
        read_only_reason,
        tables,
        relationships,
        hierarchies,
        kpis,
        security_roles,
        calculation_groups,
        measures: base.measures().iter().map(measure_info).collect(),
        contexts,
        context_columns,
        table_variables,
        global_variables,
        script_functions,
        date_table: base.date_table().map(|s| s.to_string()),
        default_lookup_resolution: base.default_lookup_resolution().map(|s| s.to_string()),
        model_name: base.model_name().map(|s| s.to_string()),
        model_version: base.model_version().map(|s| s.to_string()),
        model_author: base.model_author().map(|s| s.to_string()),
        model_description: base.model_description().map(|s| s.to_string()),
        sources: build_source_infos(base),
    }
}

/// Full model overview for the editor window. Works for read-only (package)
/// connections too — the overview says so instead of erroring.
#[tauri::command]
pub fn bi_model_get_overview(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    // Guarded like every sibling: the overview is the richest read surface
    // (it includes the RLS role definitions) and must not be readable from
    // the inert secondary windows (chart-spec/object-script editors).
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let conns = bi_state.connections.lock().unwrap();
    let conn = conns.get(&connection_id).ok_or("Connection not found")?;
    let base = conn
        .base_model
        .as_ref()
        .ok_or("This connection has no loaded model")?;
    let (editable, reason) = if conn.package_data_source_id.is_some() {
        (
            false,
            Some(
                "Package-subscribed models are read-only — edit the model in the publishing \
                 workbook and republish."
                    .to_string(),
            ),
        )
    } else {
        (true, None)
    };
    Ok(build_overview(base, &conn.bindings, editable, reason))
}

/// Shared tail for every ME-2..4 mutation: run the edit through
/// apply_model_edit, mark the document dirty, return the fresh overview.
async fn mutate_and_overview<F>(
    bi_state: &BiState,
    file_state: &FileState,
    connection_id: ConnectionId,
    edit: F,
) -> Result<ModelOverview, String>
where
    F: FnOnce(
        &bi_engine::DataModel,
        &[super::types::CalculatedMeasure],
    ) -> Result<bi_engine::DataModel, String>,
{
    let _ = editable_base(bi_state, connection_id)?;
    let new_base = apply_model_edit(bi_state, connection_id, edit).await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    let bindings = {
        let conns = bi_state.connections.lock().unwrap();
        conns
            .get(&connection_id)
            .map(|c| c.bindings.clone())
            .unwrap_or_default()
    };
    Ok(build_overview(&new_base, &bindings, true, None))
}

/// Update a table's presentation metadata (display name/description/hidden).
#[tauri::command]
pub async fn bi_model_update_table(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table: String,
    display_name: Option<String>,
    description: Option<String>,
    is_hidden: bool,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut tables = base.tables().to_vec();
        let Some(t) = tables.iter_mut().find(|t| t.name() == table) else {
            return Err(format!("Table '{}' not found in the model", table));
        };
        t.set_display_name(display_name.filter(|s| !s.trim().is_empty()));
        t.set_description(description.filter(|s| !s.trim().is_empty()));
        t.set_hidden(is_hidden);
        let edited = base.with_tables(tables);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Update a PHYSICAL column's presentation metadata.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bi_model_update_column(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table: String,
    column: String,
    display_name: Option<String>,
    description: Option<String>,
    is_hidden: bool,
    lookup_resolution: Option<String>,
    sort_by_column: Option<String>,
    format_string: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut tables = base.tables().to_vec();
        let Some(t) = tables.iter_mut().find(|t| t.name() == table) else {
            return Err(format!("Table '{}' not found in the model", table));
        };
        let Some(c) = t.columns_mut().iter_mut().find(|c| c.name() == column) else {
            return Err(format!("Column '{}[{}]' not found", table, column));
        };
        let clean = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        c.set_display_name(clean(display_name));
        c.set_description(clean(description));
        c.set_hidden(is_hidden);
        c.set_lookup_resolution(clean(lookup_resolution));
        c.set_sort_by(clean(sort_by_column));
        c.set_format_string(clean(format_string));
        let edited = base.with_tables(tables);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Add or update a refresh-time calculated column.
#[tauri::command]
pub async fn bi_model_upsert_calc_column(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    table: String,
    formula: String,
    data_type: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Column name cannot be empty".to_string());
        }
        let expr = bi_engine::parse_measure_expression(&formula)
            .map_err(|e| format!("Calculated column '{}': {}", trimmed, e))?;
        // When editing and the submitted type string round-trips the ORIGINAL
        // column's Debug form (e.g. "Decimal(18, 2)" — not offered by the
        // editable dropdown), keep the original type instead of failing or
        // silently coercing.
        let dt = match original_name
            .as_deref()
            .and_then(|o| base.calculated_columns().iter().find(|c| c.name() == o))
            .filter(|c| format!("{:?}", c.data_type()) == data_type)
        {
            Some(orig) => orig.data_type().clone(),
            None => data_type_from_str(&data_type)?,
        };
        let new_col = bi_engine::CalculatedColumn::new(trimmed, table.clone(), expr, dt);

        let mut columns = base.calculated_columns().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = columns.iter().position(|c| c.name() == orig) else {
                    return Err(format!("Calculated column '{}' not found", orig));
                };
                columns[idx] = new_col;
            }
            None => columns.push(new_col),
        }
        let edited = base.with_calculated_columns(columns);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Delete a calculated column (validate() rejects if anything references it).
#[tauri::command]
pub async fn bi_model_delete_calc_column(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut columns = base.calculated_columns().to_vec();
        let before = columns.len();
        columns.retain(|c| c.name() != name);
        if columns.len() == before {
            return Err(format!("Calculated column '{}' not found", name));
        }
        let edited = base.with_calculated_columns(columns);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Add or update a relationship (single or multi equality condition).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bi_model_upsert_relationship(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    from_table: String,
    to_table: String,
    conditions: Vec<RelationshipConditionDto>,
    cardinality: String,
    active: bool,
    // "auto" | "none" | "both". None falls back to the cardinality default.
    filter_propagation: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Relationship name cannot be empty".to_string());
        }
        if conditions.is_empty() {
            return Err("A relationship needs at least one join condition".to_string());
        }
        let card = cardinality_from_str(&cardinality)?;
        let built_conditions: Vec<bi_engine::JoinCondition> = conditions
            .iter()
            .map(|c| {
                Ok(bi_engine::JoinCondition::new(
                    c.from_column.clone(),
                    c.to_column.clone(),
                    join_operator_from_str(&c.operator)?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut rel = bi_engine::Relationship::with_conditions(
            trimmed,
            from_table.clone(),
            to_table.clone(),
            built_conditions,
            card,
        )
        .with_active(active);

        // Explicit propagation from the editor takes precedence; otherwise
        // preserve the existing relationship's setting when the cardinality is
        // unchanged, and fall back to the cardinality-derived default only when
        // neither is available.
        let existing_prop = original_name
            .as_deref()
            .and_then(|orig| base.relationships().iter().find(|r| r.name() == orig))
            .filter(|r| r.cardinality() == card)
            .map(|r| r.propagation());
        if let Some(p) = filter_propagation
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            rel = rel.with_propagation(propagation_from_str(p)?);
        } else if let Some(p) = existing_prop {
            rel = rel.with_propagation(p);
        }

        let mut rels = base.relationships().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = rels.iter().position(|r| r.name() == orig) else {
                    return Err(format!("Relationship '{}' not found", orig));
                };
                rels[idx] = rel;
            }
            None => rels.push(rel),
        }
        let edited = base.with_relationships(rels);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_relationship(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut rels = base.relationships().to_vec();
        let before = rels.len();
        rels.retain(|r| r.name() != name);
        if rels.len() == before {
            return Err(format!("Relationship '{}' not found", name));
        }
        let edited = base.with_relationships(rels);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Remove a table from the model. Relationships referencing the table (either
/// side) are cascade-dropped; the table's source binding is pruned from every
/// model-sharing connection so it does not linger across save/reload. Fails
/// (with the validation error) if a measure/column still references the table.
#[tauri::command]
pub async fn bi_model_delete_table(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table_name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let target = table_name.clone();
    let overview = mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        if !base.tables().iter().any(|t| t.name() == target) {
            return Err(format!("Table '{}' not found in the model", target));
        }
        let tables: Vec<_> = base
            .tables()
            .iter()
            .filter(|t| t.name() != target)
            .cloned()
            .collect();
        let rels: Vec<_> = base
            .relationships()
            .iter()
            .filter(|r| r.from_table() != target && r.to_table() != target)
            .cloned()
            .collect();
        let edited = base.with_tables(tables).with_relationships(rels);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await?;

    // Prune the persisted source binding for the removed table on every
    // connection that shares this model (mirrors how imports add it).
    {
        let mut conns = bi_state.connections.lock().unwrap();
        let model_key = conns.get(&connection_id).map(|c| c.model_key.clone());
        if let Some(mk) = model_key {
            for c in conns.values_mut() {
                if c.model_key == mk {
                    c.bindings.retain(|b| b.model_table != table_name);
                }
            }
        }
    }
    crate::log_info!(
        "BI",
        "model editor: deleted table '{}' (conn {})",
        table_name,
        connection_id
    );
    Ok(overview)
}

/// Add or update a hierarchy.
#[tauri::command]
pub async fn bi_model_upsert_hierarchy(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    table: String,
    levels: Vec<HierarchyLevelDto>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Hierarchy name cannot be empty".to_string());
        }
        if levels.is_empty() {
            return Err("A hierarchy needs at least one level".to_string());
        }
        let built_levels: Vec<bi_engine::HierarchyLevel> = levels
            .iter()
            .map(|l| {
                let mut level = bi_engine::HierarchyLevel::new(l.column.clone())
                    .with_optional(l.is_optional);
                if let Some(d) = l.display_name.as_deref().filter(|d| !d.trim().is_empty()) {
                    level = level.with_display_name(d);
                }
                if let Some(s) = l.stopper_value.as_deref().filter(|s| !s.is_empty()) {
                    level = level.with_stopper_value(s);
                }
                level
            })
            .collect();
        let mut hierarchy = bi_engine::Hierarchy::new(trimmed, table.clone(), built_levels);

        let mut hierarchies = base.hierarchies().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = hierarchies.iter().position(|h| h.name() == orig) else {
                    return Err(format!("Hierarchy '{}' not found", orig));
                };
                // The DTO does not carry ragged behavior: carry it over so an
                // edit never silently resets it.
                hierarchy = hierarchy.with_ragged_behavior(hierarchies[idx].ragged_behavior());
                hierarchies[idx] = hierarchy;
            }
            None => hierarchies.push(hierarchy),
        }
        let edited = base.with_hierarchies(hierarchies);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_hierarchy(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut hierarchies = base.hierarchies().to_vec();
        let before = hierarchies.len();
        hierarchies.retain(|h| h.name() != name);
        if hierarchies.len() == before {
            return Err(format!("Hierarchy '{}' not found", name));
        }
        let edited = base.with_hierarchies(hierarchies);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Add or update a KPI.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bi_model_upsert_kpi(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    base_measure: String,
    target_measure: Option<String>,
    target_constant: Option<f64>,
    status_bands: Vec<KpiBandDto>,
    description: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("KPI name cannot be empty".to_string());
        }
        let target = match (target_measure.as_deref().filter(|m| !m.is_empty()), target_constant) {
            (Some(m), _) => bi_engine::KpiTarget::Measure(m.to_string()),
            (None, Some(v)) => bi_engine::KpiTarget::Constant(v),
            (None, None) => {
                return Err("A KPI needs a target: a measure or a constant".to_string())
            }
        };
        let mut kpi = bi_engine::Kpi::new(trimmed, base_measure.clone(), target);
        for band in &status_bands {
            kpi = kpi.with_status_band(bi_engine::StatusBand::new(
                band.threshold,
                kpi_status_from_str(&band.status)?,
            ));
        }
        if let Some(d) = description.as_deref().filter(|d| !d.trim().is_empty()) {
            kpi = kpi.with_description(d);
        }

        let mut kpis = base.kpis().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = kpis.iter().position(|k| k.name() == orig) else {
                    return Err(format!("KPI '{}' not found", orig));
                };
                kpis[idx] = kpi;
            }
            None => kpis.push(kpi),
        }
        let edited = base.with_kpis(kpis);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_kpi(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut kpis = base.kpis().to_vec();
        let before = kpis.len();
        kpis.retain(|k| k.name() != name);
        if kpis.len() == before {
            return Err(format!("KPI '{}' not found", name));
        }
        let edited = base.with_kpis(kpis);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Add or update a security role (static + dynamic RLS filters).
#[tauri::command]
pub async fn bi_model_upsert_role(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    filters: Vec<RoleFilterDto>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Role name cannot be empty".to_string());
        }
        let predicates = filters
            .iter()
            .map(predicate_from_dto)
            .collect::<Result<Vec<_>, String>>()?;
        let role = bi_engine::SecurityRole::new(trimmed).with_filters(predicates);

        let mut roles = base.security_roles().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = roles.iter().position(|r| r.name() == orig) else {
                    return Err(format!("Role '{}' not found", orig));
                };
                roles[idx] = role;
            }
            None => roles.push(role),
        }
        let edited = base.with_security_roles(roles);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_role(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut roles = base.security_roles().to_vec();
        let before = roles.len();
        roles.retain(|r| r.name() != name);
        if roles.len() == before {
            return Err(format!("Role '{}' not found", name));
        }
        let edited = base.with_security_roles(roles);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Add or update a calculation group (items parsed with SELECTEDMEASURE()).
#[tauri::command]
pub async fn bi_model_upsert_calc_group(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    items: Vec<CalcGroupItemDto>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Calculation group name cannot be empty".to_string());
        }
        let mut built_items = Vec::with_capacity(items.len());
        for item in &items {
            let expr = bi_engine::parse_measure_expression(&item.formula)
                .map_err(|e| format!("Item '{}': {}", item.name, e))?;
            built_items.push(
                bi_engine::CalculationItem::new(item.name.clone(), expr)
                    .with_source(item.formula.clone()),
            );
        }
        let group = bi_engine::CalculationGroup::new(trimmed, built_items);

        let mut groups = base.calculation_groups().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = groups.iter().position(|g| g.name() == orig) else {
                    return Err(format!("Calculation group '{}' not found", orig));
                };
                groups[idx] = group;
            }
            None => groups.push(group),
        }
        let edited = base.with_calculation_groups(groups);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_calc_group(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut groups = base.calculation_groups().to_vec();
        let before = groups.len();
        groups.retain(|g| g.name() != name);
        if groups.len() == before {
            return Err(format!("Calculation group '{}' not found", name));
        }
        let edited = base.with_calculation_groups(groups);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

// ---------------------------------------------------------------------------
// ME-6: global variables
// ---------------------------------------------------------------------------

/// Add or update a global variable (a model-level reusable expression; scalar
/// or table-producing QUERY(...)). Parsed by the engine `parse_global`.
#[tauri::command]
pub async fn bi_model_upsert_global_variable(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    table: String,
    expression: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Global variable name cannot be empty".to_string());
        }
        if table.trim().is_empty() {
            return Err("Global variable must specify a table".to_string());
        }
        if expression.trim().is_empty() {
            return Err(format!("Global variable '{}' has an empty expression", trimmed));
        }
        let gv = bi_engine::parse_global(trimmed, table.trim(), &expression)
            .map_err(|e| format!("Global variable '{}': {}", trimmed, e))?;

        let mut globals = base.global_variables().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = globals.iter().position(|g| g.name() == orig) else {
                    return Err(format!("Global variable '{}' not found", orig));
                };
                globals[idx] = gv;
            }
            None => globals.push(gv),
        }
        let edited = base.with_global_variables(globals);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_global_variable(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut globals = base.global_variables().to_vec();
        let before = globals.len();
        globals.retain(|g| g.name() != name);
        if globals.len() == before {
            return Err(format!("Global variable '{}' not found", name));
        }
        let edited = base.with_global_variables(globals);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

// ---------------------------------------------------------------------------
// ME-6: table variables
// ---------------------------------------------------------------------------

/// Add or update a table variable (a named, pre-filtered view of a base table
/// or another variable). Filters reuse the shared static/dynamic predicate DTO.
#[tauri::command]
pub async fn bi_model_upsert_table_variable(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    source: String,
    filters: Vec<RoleFilterDto>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Table variable name cannot be empty".to_string());
        }
        if source.trim().is_empty() {
            return Err("Table variable must specify a source table".to_string());
        }
        let predicates = filters
            .iter()
            .map(predicate_from_dto)
            .collect::<Result<Vec<_>, String>>()?;
        let tv = bi_engine::TableVariable::new(trimmed, source.trim(), predicates);

        let mut vars = base.table_variables().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = vars.iter().position(|v| v.name() == orig) else {
                    return Err(format!("Table variable '{}' not found", orig));
                };
                vars[idx] = tv;
            }
            None => vars.push(tv),
        }
        let edited = base.with_table_variables(vars);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_table_variable(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut vars = base.table_variables().to_vec();
        let before = vars.len();
        vars.retain(|v| v.name() != name);
        if vars.len() == before {
            return Err(format!("Table variable '{}' not found", name));
        }
        let edited = base.with_table_variables(vars);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

// ---------------------------------------------------------------------------
// ME-6: script functions (sandboxed Rhai UDFs)
// ---------------------------------------------------------------------------

/// Add or update a script function. Constructed programmatically (no parser);
/// the body is compiled and sandbox-validated by `DataModel::validate()`.
#[tauri::command]
pub async fn bi_model_upsert_script_function(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    params: Vec<ScriptParamDto>,
    return_type: String,
    body: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Script function name cannot be empty".to_string());
        }
        let ret = script_type_from_str(&return_type)?;
        let mut builder = bi_engine::ScriptFunction::builder(trimmed);
        for p in &params {
            builder = builder.param(p.name.trim(), script_type_from_str(&p.ty)?);
        }
        let func = builder.returns(ret).body(body.clone()).build();

        let mut funcs = base.script_functions().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = funcs.iter().position(|f| f.name() == orig) else {
                    return Err(format!("Script function '{}' not found", orig));
                };
                funcs[idx] = func;
            }
            None => funcs.push(func),
        }
        let edited = base.with_script_functions(funcs);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_script_function(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut funcs = base.script_functions().to_vec();
        let before = funcs.len();
        funcs.retain(|f| f.name() != name);
        if funcs.len() == before {
            return Err(format!("Script function '{}' not found", name));
        }
        let edited = base.with_script_functions(funcs);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

// ---------------------------------------------------------------------------
// ME-6: contexts + context columns
// ---------------------------------------------------------------------------

/// Add or update a named context (a composable set of filter operations
/// referenced by measures via `using(expr, context)`). The flat operation DTOs
/// are bridged into the engine `ContextOp` enum.
#[tauri::command]
pub async fn bi_model_upsert_context(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    operations: Vec<ContextOpDto>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Context name cannot be empty".to_string());
        }
        let ops = operations
            .iter()
            .map(context_op_from_dto)
            .collect::<Result<Vec<_>, String>>()?;
        let ctx = bi_engine::ContextDefinition::new(trimmed, ops);

        let mut contexts = base.contexts().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = contexts.iter().position(|c| c.name() == orig) else {
                    return Err(format!("Context '{}' not found", orig));
                };
                contexts[idx] = ctx;
            }
            None => contexts.push(ctx),
        }
        let edited = base.with_contexts(contexts);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_context(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut contexts = base.contexts().to_vec();
        let before = contexts.len();
        contexts.retain(|c| c.name() != name);
        if contexts.len() == before {
            return Err(format!("Context '{}' not found", name));
        }
        let edited = base.with_contexts(contexts);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Add or update a context-driven calculated column (a groupable column whose
/// per-row value derives from a scalar measure resolved against the query's
/// filter context). Name is unique model-wide.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bi_model_upsert_context_column(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    original_name: Option<String>,
    name: String,
    table: String,
    expression: String,
    data_type: String,
    description: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Context column name cannot be empty".to_string());
        }
        if table.trim().is_empty() {
            return Err("Context column must specify a table".to_string());
        }
        if expression.trim().is_empty() {
            return Err(format!("Context column '{}' has an empty expression", trimmed));
        }
        let expr = bi_engine::parse_measure_expression(&expression)
            .map_err(|e| format!("Context column '{}': {}", trimmed, e))?;
        let dt = data_type_from_str(&data_type)?;
        let mut cc = bi_engine::ContextColumn::new(trimmed, table.trim(), expr, dt);
        if let Some(d) = description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            cc = cc.with_description(d);
        }

        let mut cols = base.context_columns().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = cols.iter().position(|c| c.name() == orig) else {
                    return Err(format!("Context column '{}' not found", orig));
                };
                cols[idx] = cc;
            }
            None => cols.push(cc),
        }
        let edited = base.with_context_columns(cols);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

#[tauri::command]
pub async fn bi_model_delete_context_column(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut cols = base.context_columns().to_vec();
        let before = cols.len();
        cols.retain(|c| c.name() != name);
        if cols.len() == before {
            return Err(format!("Context column '{}' not found", name));
        }
        let edited = base.with_context_columns(cols);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

// ---------------------------------------------------------------------------
// ME-6: model settings (date table, default lookup resolution) + validation
// ---------------------------------------------------------------------------

/// Mark (or clear, when `table` is null/empty) the model's date table, enabling
/// time-intelligence over its DateRole-tagged columns.
#[tauri::command]
pub async fn bi_model_set_date_table(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let marked = table.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let edited = base.with_date_table(marked.map(|s| s.to_string()));
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Set (or clear, when null/empty) the model-level default lookup-resolution
/// expression used when a column has no per-column resolution.
#[tauri::command]
pub async fn bi_model_set_default_lookup_resolution(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    expression: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let expr = expression.as_deref().map(str::trim).filter(|e| !e.is_empty());
        let edited = base.with_default_lookup_resolution(expr.map(|s| s.to_string()));
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Set the model's descriptive metadata (name/version/author/description).
/// Presentation only — travels with the model on publish. Each empty/blank
/// field clears that metadata.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bi_model_set_metadata(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    name: Option<String>,
    version: Option<String>,
    author: Option<String>,
    description: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let clean = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        Ok(base.with_model_metadata(
            clean(name),
            clean(version),
            clean(author),
            clean(description),
        ))
    })
    .await
}

/// Toggle a table's storage mode (DirectQuery <-> InMemory).
#[tauri::command]
pub async fn bi_model_set_table_storage_mode(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table_name: String,
    storage_mode: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mode = storage_mode_from_str(&storage_mode)?;
        let mut tables = base.tables().to_vec();
        let Some(table) = tables.iter_mut().find(|t| t.name() == table_name) else {
            return Err(format!("Table '{}' not found", table_name));
        };
        table.set_storage_mode(mode);
        let edited = base.with_tables(tables);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Set a table's InMemory refresh strategies + incremental-refresh policy.
/// The strategies are honored lazily by the engine's query_auto_refresh path
/// (evaluated on each query; a stale table is re-fetched before the query
/// runs). validate() checks strategy shapes + the incremental filter grammar.
#[tauri::command]
pub async fn bi_model_set_table_refresh(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table_name: String,
    strategies: Vec<RefreshStrategyDto>,
    incremental_refresh: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let strats = strategies
            .iter()
            .map(refresh_strategy_from_dto)
            .collect::<Result<Vec<_>, String>>()?;
        let incr = incremental_refresh
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(bi_engine::IncrementalRefresh::new);
        let mut tables = base.tables().to_vec();
        let Some(table) = tables.iter_mut().find(|t| t.name() == table_name) else {
            return Err(format!("Table '{}' not found", table_name));
        };
        table.set_refresh_strategies(strats);
        table.set_incremental_refresh(incr);
        let edited = base.with_tables(tables);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Force a table's in-memory cache to be dropped so the next query re-fetches
/// it from the source (a manual refresh). No model mutation. Requires the
/// connection to be live for the re-fetch to succeed.
#[tauri::command]
pub async fn bi_model_refresh_table(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    table_name: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let engine_arc = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        conn.engine
            .clone()
            .ok_or("No model loaded for this connection")?
    };
    let mut engine = engine_arc.lock().await;
    engine
        .refresh_table(&table_name)
        .await
        .map_err(|e| format!("{}", e))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUndoStateDto {
    pub can_undo: bool,
    pub can_redo: bool,
}

/// Undo/redo availability for the current connection's model (drives the
/// editor's Undo/Redo button enablement).
#[tauri::command]
pub fn bi_model_undo_state(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<ModelUndoStateDto, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let model_key = {
        let conns = bi_state.connections.lock().unwrap();
        conns
            .get(&connection_id)
            .ok_or("Connection not found")?
            .model_key
            .clone()
    };
    let (can_undo, can_redo) = {
        let store = model_undo_store().lock().map_err(|e| e.to_string())?;
        store
            .get(&model_key)
            .map(|s| (!s.undo.is_empty(), !s.redo.is_empty()))
            .unwrap_or((false, false))
    };
    Ok(ModelUndoStateDto { can_undo, can_redo })
}

/// Undo the last model edit: reinstall the previous base_model snapshot on the
/// shared engine (and push the current state onto the redo stack).
#[tauri::command]
pub async fn bi_model_undo(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let (model_key, current_base, bindings) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        (
            conn.model_key.clone(),
            conn.base_model
                .clone()
                .ok_or("This connection has no editable base model")?,
            conn.bindings.clone(),
        )
    };
    let prev = {
        let mut store = model_undo_store().lock().map_err(|e| e.to_string())?;
        let stacks = store.entry(model_key).or_default();
        let Some(prev) = stacks.undo.pop() else {
            return Err("Nothing to undo".to_string());
        };
        stacks.redo.push(current_base);
        if stacks.redo.len() > MAX_MODEL_UNDO {
            stacks.redo.remove(0);
        }
        prev
    };
    install_base_model(&bi_state, &connection_id, &prev).await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    Ok(build_overview(&prev, &bindings, true, None))
}

/// Redo a previously undone model edit.
#[tauri::command]
pub async fn bi_model_redo(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let (model_key, current_base, bindings) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        (
            conn.model_key.clone(),
            conn.base_model
                .clone()
                .ok_or("This connection has no editable base model")?,
            conn.bindings.clone(),
        )
    };
    let next = {
        let mut store = model_undo_store().lock().map_err(|e| e.to_string())?;
        let stacks = store.entry(model_key).or_default();
        let Some(next) = stacks.redo.pop() else {
            return Err("Nothing to redo".to_string());
        };
        stacks.undo.push(current_base);
        if stacks.undo.len() > MAX_MODEL_UNDO {
            stacks.undo.remove(0);
        }
        next
    };
    install_base_model(&bi_state, &connection_id, &next).await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    Ok(build_overview(&next, &bindings, true, None))
}

/// One entry of the engine's built-in function catalog (for editor
/// autocompletion/hover/signature help).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDefDto {
    pub name: String,
    pub description: String,
    pub signature: String,
}

/// The engine's built-in function catalog (static; drives the formula editor's
/// completion/hover/signature-help providers).
#[tauri::command]
pub fn bi_model_function_catalog(window: tauri::Window) -> Result<Vec<FunctionDefDto>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    Ok(bi_engine::function_catalog()
        .iter()
        .map(|f| FunctionDefDto {
            name: f.name.to_string(),
            description: f.description.to_string(),
            signature: f.signature.to_string(),
        })
        .collect())
}

/// A single model-validation issue for the Overview panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssueDto {
    /// "error" | "warning".
    pub level: String,
    pub message: String,
}

/// Read-only model validation for the Overview "Validate" button: a full
/// builder rebuild (name collisions, dangling refs, circular measure deps,
/// relationship/hierarchy/role/group rules). Returns an empty list when valid.
#[tauri::command]
pub fn bi_model_validate(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<Vec<ValidationIssueDto>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let conns = bi_state.connections.lock().unwrap();
    let conn = conns.get(&connection_id).ok_or("Connection not found")?;
    let base = conn
        .base_model
        .as_ref()
        .ok_or("This connection has no loaded model")?;
    Ok(match base.validate() {
        Ok(()) => Vec::new(),
        Err(e) => vec![ValidationIssueDto {
            level: "error".to_string(),
            message: format!("{}", e),
        }],
    })
}

// ---------------------------------------------------------------------------
// ME-5: schema import + blank models
// ---------------------------------------------------------------------------

/// List the source database's tables through the connection's live connector.
/// Requires the connection to be CONNECTED (Data > Connections > Connect).
#[tauri::command]
pub async fn bi_model_list_source_tables(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<Vec<SourceTableInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let (engine_arc, connector_index, model_tables, schema_filter) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        let idx = conn.connector_index.ok_or(
            "Not connected to the database — open Data > Connections and click Connect first.",
        )?;
        let tables: HashSet<String> = conn
            .base_model
            .as_ref()
            .map(|m| m.tables().iter().map(|t| t.name().to_string()).collect())
            .unwrap_or_default();
        // If the connection specifies a schema, only that schema's objects are
        // listed (a database exposes many schemas; scope to the chosen one).
        let (target, _auth) = super::commands::parse_connection_string(&conn.connection_string);
        let schema_filter = target.default_schema.filter(|s| !s.trim().is_empty());
        (
            conn.engine
                .clone()
                .ok_or("No model loaded for this connection")?,
            idx,
            tables,
            schema_filter,
        )
    };
    let guard = engine_arc.lock().await;
    let connector = guard
        .registry()
        .connector_by_index(connector_index)
        .ok_or("Connector not found — reconnect and retry")?;
    let source_tables = connector
        .list_tables()
        .await
        .map_err(|e| format!("Failed to list source tables: {}", e))?;
    Ok(source_tables
        .into_iter()
        .filter(|t| {
            schema_filter
                .as_deref()
                .map_or(true, |s| t.schema.eq_ignore_ascii_case(s))
        })
        .map(|t| SourceTableInfo {
            imported: model_tables.contains(&t.name),
            schema: t.schema,
            name: t.name,
        })
        .collect())
}

/// Import source tables into the model: introspect each through the live
/// connector, append to the model (validated), bind, and persist bindings.
#[tauri::command]
pub async fn bi_model_import_tables(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    tables: Vec<ImportTableRef>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let _ = editable_base(&bi_state, connection_id)?;
    if tables.is_empty() {
        return Err("Select at least one table to import".to_string());
    }

    let (engine_arc, connector_index) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        let idx = conn.connector_index.ok_or(
            "Not connected to the database — open Data > Connections and click Connect first.",
        )?;
        (
            conn.engine
                .clone()
                .ok_or("No model loaded for this connection")?,
            idx,
        )
    };

    // Everything under the engine lock: introspection, model edit, install,
    // binding — the same serialization point as every other model writer.
    let mut guard = engine_arc.lock().await;

    let mut introspected: Vec<bi_engine::Table> = Vec::with_capacity(tables.len());
    {
        let connector = guard
            .registry()
            .connector_by_index(connector_index)
            .ok_or("Connector not found — reconnect and retry")?;
        for t in &tables {
            let table = connector
                .introspect_table(&t.schema, &t.name)
                .await
                .map_err(|e| format!("Failed to introspect {}.{}: {}", t.schema, t.name, e))?;
            introspected.push(table);
        }
    }

    let (base, calculated, model_key, persisted_source, source_id) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        let persisted_source = super::commands::persisted_source_for(conn);
        let source_id = persisted_source.id.clone();
        (
            conn.base_model
                .clone()
                .ok_or("This connection has no editable base model")?,
            conn.calculated_measures.clone(),
            conn.model_key.clone(),
            persisted_source,
            source_id,
        )
    };

    // Append the introspected tables, stamping each with its persisted source
    // binding (source id + physical schema/table) so the model self-describes
    // where its data comes from and survives save/export/publish.
    let mut model_tables = base.tables().to_vec();
    for (src, table) in tables.iter().zip(introspected.iter()) {
        if model_tables.iter().any(|t| t.name() == table.name()) {
            return Err(format!(
                "The model already has a table named '{}'",
                table.name()
            ));
        }
        model_tables.push(table.clone().with_source_binding(
            bi_engine::TableSourceBinding::new(&source_id, &src.schema, &src.name),
        ));
    }
    let mut new_base = base.with_tables(model_tables);
    // Record the source in the model's persisted catalog (idempotent — a repeat
    // import from the same connection reuses the existing entry).
    let _ = new_base.push_source(persisted_source);
    new_base.validate().map_err(|e| format!("{}", e))?;
    let combined = build_combined_model(&new_base, &calculated)?;
    guard.set_model(combined).map_err(|e| format!("{}", e))?;

    // Bind each imported table to its source (runtime) and persist the
    // binding on every model-sharing connection (restore re-binds from it).
    let new_bindings: Vec<super::types::BiBindRequest> = tables
        .iter()
        .zip(introspected.iter())
        .map(|(src, table)| super::types::BiBindRequest {
            model_table: table.name().to_string(),
            schema: src.schema.clone(),
            source_table: src.name.clone(),
            source_query: None,
        })
        .collect();
    for b in &new_bindings {
        guard.bind_table(
            b.model_table.clone(),
            connector_index,
            bi_engine::SourceBinding::new(b.schema.clone(), b.source_table.clone()),
        );
    }

    let bindings_snapshot = {
        let mut conns = bi_state.connections.lock().unwrap();
        for c in conns.values_mut() {
            if c.model_key == model_key {
                c.base_model = Some(new_base.clone());
                for b in &new_bindings {
                    if !c.bindings.iter().any(|x| x.model_table == b.model_table) {
                        c.bindings.push(b.clone());
                    }
                }
            }
        }
        // The overview's bound flags must reflect the EDITED connection, not
        // whichever model-sharing sibling the map yields first.
        conns
            .get(&connection_id)
            .map(|c| c.bindings.clone())
            .unwrap_or_default()
    };
    drop(guard);

    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    crate::log_info!(
        "BI",
        "model editor: imported {} table(s) (conn {})",
        tables.len(),
        connection_id
    );
    Ok(build_overview(&new_base, &bindings_snapshot, true, None))
}

/// Map an Arrow result-set type (from probing a SQL source) to the model's
/// column data type. Widening is deliberate (any integer that fits → Int32/64,
/// any float → Float64); unknowns fall back to String.
fn arrow_to_model_type(dt: &arrow::datatypes::DataType) -> bi_engine::DataType {
    use arrow::datatypes::DataType as A;
    match dt {
        A::Int8 | A::Int16 | A::Int32 | A::UInt8 | A::UInt16 => bi_engine::DataType::Int32,
        A::Int64 | A::UInt32 | A::UInt64 => bi_engine::DataType::Int64,
        A::Float16 | A::Float32 | A::Float64 => bi_engine::DataType::Float64,
        A::Decimal128(p, s) | A::Decimal256(p, s) => bi_engine::DataType::Decimal(*p, *s),
        A::Boolean => bi_engine::DataType::Boolean,
        A::Date32 | A::Date64 => bi_engine::DataType::Date,
        A::Timestamp(_, _) => bi_engine::DataType::Timestamp,
        _ => bi_engine::DataType::String,
    }
}

/// Import a table whose rows come from a user-authored SQL SELECT rather than a
/// physical table (e.g. to pre-filter, or to load the same table twice under
/// different names). The query's result columns are introspected via a LIMIT-0
/// probe, the table is added as InMemory, and it is bound as a wrapped subquery
/// so every downstream filter/measure composes on top of the import SQL. The
/// table lives in — and distributes with — the workbook like any other.
#[tauri::command]
pub async fn bi_model_import_sql_source(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table_name: String,
    sql: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let _ = editable_base(&bi_state, connection_id)?;

    let table_name = table_name.trim().to_string();
    if table_name.is_empty() {
        return Err("Enter a name for the table".to_string());
    }
    // Normalize: a single SELECT/WITH, trailing semicolon stripped so it nests
    // as a subquery. A light guard, not a full SQL validator.
    let source_sql = sql.trim().trim_end_matches(';').trim().to_string();
    if source_sql.is_empty() {
        return Err("Enter a SQL query for the source".to_string());
    }
    let lower = source_sql.to_ascii_lowercase();
    if !(lower.starts_with("select") || lower.starts_with("with")) {
        return Err("The source query must be a SELECT statement".to_string());
    }

    let (engine_arc, connector_index) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        let idx = conn.connector_index.ok_or(
            "Not connected to the database — open Data > Connections and click Connect first.",
        )?;
        (
            conn.engine
                .clone()
                .ok_or("No model loaded for this connection")?,
            idx,
        )
    };

    let mut guard = engine_arc.lock().await;

    // Introspect the result columns by probing the wrapped query with LIMIT 0.
    let columns: Vec<bi_engine::Column> = {
        let connector = guard
            .registry()
            .connector_by_index(connector_index)
            .ok_or("Connector not found — reconnect and retry")?;
        let probe = format!("SELECT * FROM ({}) AS _probe LIMIT 0", source_sql);
        let batches = connector
            .execute_query(&probe)
            .await
            .map_err(|e| format!("The source query failed: {}", e))?;
        let schema = batches
            .first()
            .map(|b| b.schema())
            .ok_or("The source query returned no columns")?;
        if schema.fields().is_empty() {
            return Err("The source query returned no columns".to_string());
        }
        schema
            .fields()
            .iter()
            .map(|f| bi_engine::Column::new(f.name().clone(), arrow_to_model_type(f.data_type())))
            .collect()
    };

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

    if base.tables().iter().any(|t| t.name() == table_name) {
        return Err(format!("The model already has a table named '{}'", table_name));
    }
    let mut new_table =
        bi_engine::Table::new(&table_name, columns).map_err(|e| format!("{}", e))?;
    new_table.set_storage_mode(bi_engine::StorageMode::InMemory);

    let mut model_tables = base.tables().to_vec();
    model_tables.push(new_table);
    let new_base = base.with_tables(model_tables);
    new_base.validate().map_err(|e| format!("{}", e))?;
    let combined = build_combined_model(&new_base, &calculated)?;
    guard.set_model(combined).map_err(|e| format!("{}", e))?;

    // Bind the table to its SQL source (rendered as a wrapped subquery whenever
    // the InMemory cache loads/refreshes).
    guard.bind_table(
        table_name.clone(),
        connector_index,
        bi_engine::SourceBinding::new_query(&table_name, &source_sql),
    );

    let bind_req = super::types::BiBindRequest {
        model_table: table_name.clone(),
        schema: String::new(),
        source_table: String::new(),
        source_query: Some(source_sql.clone()),
    };
    let bindings_snapshot = {
        let mut conns = bi_state.connections.lock().unwrap();
        for c in conns.values_mut() {
            if c.model_key == model_key {
                c.base_model = Some(new_base.clone());
                if !c.bindings.iter().any(|x| x.model_table == bind_req.model_table) {
                    c.bindings.push(bind_req.clone());
                }
            }
        }
        conns
            .get(&connection_id)
            .map(|c| c.bindings.clone())
            .unwrap_or_default()
    };
    drop(guard);

    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    crate::log_info!(
        "BI",
        "model editor: imported SQL source '{}' (conn {})",
        table_name,
        connection_id
    );
    Ok(build_overview(&new_base, &bindings_snapshot, true, None))
}

// ---------------------------------------------------------------------------
// Connections tab: the model's persisted data-source catalog (engine v14)
// ---------------------------------------------------------------------------

/// Add or update (by id) a persisted data source in the model's catalog. The
/// descriptor is secret-free (host/port/database/schema + auth *hint*); the id
/// is stable across edits so table bindings never dangle. Returns the overview.
#[tauri::command]
pub async fn bi_model_upsert_source(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    id: String,
    kind: String,
    host: Option<String>,
    port: Option<u16>,
    database: Option<String>,
    default_schema: Option<String>,
    trust_server_certificate: bool,
    ssl_mode: Option<String>,
    preferred_auth: String,
    display_name: Option<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("A data source id is required".to_string());
    }
    let kind = source_kind_from_str(&kind)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let connection = bi_engine::PersistedConnection {
            host: host.clone().unwrap_or_default(),
            port,
            database: database.clone().unwrap_or_default(),
            default_schema: default_schema.clone().filter(|s| !s.trim().is_empty()),
            trust_server_certificate,
            ssl_mode: ssl_mode.clone().filter(|s| !s.trim().is_empty()),
        };
        let mut src = bi_engine::PersistedSource::new(
            id.clone(),
            kind,
            connection,
            persisted_auth_from_str(&preferred_auth),
        );
        if let Some(dn) = display_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            src = src.with_display_name(dn.to_string());
        }
        // Replace an existing source with the same id, else append.
        let mut sources: Vec<bi_engine::PersistedSource> =
            base.sources().iter().filter(|s| s.id != id).cloned().collect();
        sources.push(src);
        let edited = base.with_sources(sources);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Remove a data source from the model's catalog and clear every table binding
/// that names it (those tables become unbound). Returns the overview.
#[tauri::command]
pub async fn bi_model_delete_source(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    source_id: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let overview = mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        if base.source(&source_id).is_none() {
            return Err(format!("Data source '{}' not found", source_id));
        }
        let sources: Vec<bi_engine::PersistedSource> =
            base.sources().iter().filter(|s| s.id != source_id).cloned().collect();
        let tables: Vec<bi_engine::Table> = base
            .tables()
            .iter()
            .map(|t| {
                if t.source_binding().map(|b| b.source_id == source_id).unwrap_or(false) {
                    let mut t = t.clone();
                    t.set_source_binding(None);
                    t
                } else {
                    t.clone()
                }
            })
            .collect();
        let edited = base.with_sources(sources).with_tables(tables);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await?;
    Ok(overview)
}

/// Bind a model table to a location within a catalog source (or clear its
/// binding when `source_id` is null). Records the persisted binding on the
/// model; the runtime binding is (re)established when the source is connected.
#[tauri::command]
pub async fn bi_model_set_table_source_binding(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table_name: String,
    source_id: Option<String>,
    schema: String,
    source_table: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        if base.tables().iter().all(|t| t.name() != table_name) {
            return Err(format!("Table '{}' not found in the model", table_name));
        }
        let binding = match source_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(sid) => {
                if base.source(sid).is_none() {
                    return Err(format!("Data source '{}' is not in the catalog", sid));
                }
                Some(bi_engine::TableSourceBinding::new(sid, schema.trim(), source_table.trim()))
            }
            None => None,
        };
        let tables: Vec<bi_engine::Table> = base
            .tables()
            .iter()
            .map(|t| {
                if t.name() == table_name {
                    let mut t = t.clone();
                    t.set_source_binding(binding.clone());
                    t
                } else {
                    t.clone()
                }
            })
            .collect();
        let edited = base.with_tables(tables);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await
}

/// Connect ONE catalog source: wire it into the live engine registry using the
/// supplied credentials (from `connection_string`) and the source's secret-free
/// persisted target, then bind every table that names it. In-memory sources
/// cannot be rebuilt from a descriptor and are rejected. Returns the overview.
#[tauri::command]
pub async fn bi_model_connect_source(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    source_id: String,
    connection_string: String,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let (engine_arc, base) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        (
            conn.engine.clone().ok_or("No model loaded for this connection")?,
            conn.base_model.clone().ok_or("This connection has no loaded model")?,
        )
    };
    if base.source(&source_id).is_none() {
        return Err(format!("Data source '{}' is not in the catalog", source_id));
    }
    let (_, auth) = super::commands::parse_connection_string(&connection_string);
    let sid = source_id.clone();
    let report = {
        let mut engine = engine_arc.lock().await;
        engine
            .wire_sources(|s| {
                if s.id != sid {
                    return bi_engine::SourceCredential::Skip;
                }
                match s.kind {
                    bi_engine::SourceKind::InMemory => bi_engine::SourceCredential::Skip,
                    bi_engine::SourceKind::Csv | bi_engine::SourceKind::Parquet => {
                        bi_engine::SourceCredential::Auth(bi_engine::AuthMethod::Integrated)
                    }
                    _ => bi_engine::SourceCredential::Auth(auth.clone()),
                }
            })
            .await
            .map_err(|e| format!("Connect failed: {}", e))?
    };
    if report.wired.is_empty() {
        return Err(
            "This source kind can't be reconnected from the model (in-memory data lives in the host)."
                .to_string(),
        );
    }
    // Mark connected on every connection sharing this model.
    {
        let mut conns = bi_state.connections.lock().unwrap();
        if let Some(mk) = conns.get(&connection_id).and_then(|c| c.model_key.clone()) {
            for c in conns.values_mut() {
                if c.model_key.as_ref() == Some(&mk) {
                    c.is_connected = true;
                }
            }
        }
    }
    crate::log_info!(
        "BI",
        "model editor: wired source '{}' ({} tables) on conn {}",
        source_id,
        report.bound_tables.len(),
        connection_id
    );
    let bindings = {
        let conns = bi_state.connections.lock().unwrap();
        conns.get(&connection_id).map(|c| c.bindings.clone()).unwrap_or_default()
    };
    Ok(build_overview(&base, &bindings, true, None))
}

/// Create a NEW blank model as a path-less connection (the model lives
/// embedded in the workbook from the start; publish it as a dataset package
/// to distribute). Import tables via bi_model_import_tables after connecting.
#[tauri::command]
pub async fn bi_model_create_blank(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    name: String,
    connection_string: Option<String>,
    window: tauri::Window,
) -> Result<super::types::ConnectionInfo, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Model name cannot be empty".to_string());
    }
    let empty = bi_engine::DataModel::builder()
        .build()
        .map_err(|e| format!("{}", e))?
        // Prefill the model's descriptive name from the name given at creation
        // (editable later under Settings ▸ Model metadata).
        .with_model_metadata(Some(trimmed.to_string()), None, None, None);
    let model_json = serde_json::to_value(&empty).map_err(|e| format!("{}", e))?;
    let info = super::commands::create_connection_from_json(
        &bi_state,
        trimmed.to_string(),
        None,
        connection_string.unwrap_or_default(),
        model_json,
    )
    .await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    Ok(info)
}

/// Export a connection's model to a standalone file as a ModelBundle
/// (`{ formatVersion, model }`) — the same Studio-compatible wrapper the import
/// path understands. The model still lives in the workbook (this writes a COPY
/// for sharing/versioning), so exporting changes nothing about the workbook's
/// own persistence.
#[tauri::command]
pub fn bi_model_export_to_file(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    path: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    // Build the bundle while holding the connections lock, then release it
    // before the blocking file write.
    let bundle = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        let base = conn
            .base_model
            .as_ref()
            .ok_or("This connection has no loaded model")?;
        let mut model_json =
            serde_json::to_value(base).map_err(|e| format!("Failed to serialize model: {}", e))?;
        // Stamp the inner model's format_version exactly like workbook save does,
        // so a subscriber on an older Calcula gets a clear version error.
        super::commands::stamp_feature_format_version(base, &mut model_json);
        serde_json::json!({
            "formatVersion": bi_engine::MODEL_FORMAT_VERSION,
            "model": model_json,
        })
    };
    let bytes = serde_json::to_vec_pretty(&bundle)
        .map_err(|e| format!("Failed to serialize model bundle: {}", e))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write model file: {}", e))?;
    Ok(())
}

/// Import a model from a standalone file (a raw DataModel or a Studio ModelBundle
/// `{ formatVersion, model }`) as a NEW path-less connection. The imported model
/// becomes workbook-embedded, so it travels inside a `.calp` like any other
/// in-app model. Reuses the same create-connection path as blank/new models,
/// which unwraps the ModelBundle wrapper and validates the model.
#[tauri::command]
pub async fn bi_model_import_from_file(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    name: String,
    path: String,
    window: tauri::Window,
) -> Result<super::types::ConnectionInfo, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let trimmed = name.trim();
    let model_name = if trimmed.is_empty() { "Imported Model" } else { trimmed };
    let json_str =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let json_value: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Not a valid model file (invalid JSON): {}", e))?;
    let info = super::commands::create_connection_from_json(
        &bi_state,
        model_name.to_string(),
        None,
        String::new(),
        json_value,
    )
    .await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    Ok(info)
}

/// Dry-run a connection: build a throwaway engine, actually connect with the
/// given connection string (PostgreSQL), and report success + the source table
/// count. Persists nothing. Used by the New-Model dialog's Test button.
#[tauri::command]
pub async fn bi_model_test_connection(
    connection_string: String,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    if connection_string.trim().is_empty() {
        return Err("Enter the connection details first.".to_string());
    }
    let (target, auth) = super::commands::parse_connection_string(&connection_string);
    // If a schema was specified, the reported count must be scoped to it — the
    // same filter bi_model_list_source_tables uses (a DB exposes many schemas).
    let schema_filter = target
        .default_schema
        .clone()
        .filter(|s| !s.trim().is_empty());
    let empty = bi_engine::DataModel::builder()
        .build()
        .map_err(|e| format!("{}", e))?;
    let mut engine = bi_engine::Engine::new(empty);
    let idx = engine
        .add_postgres(target, auth)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    // Prove the connection is usable and report how many tables it exposes
    // (scoped to the chosen schema, if any).
    match engine.registry().connector_by_index(idx) {
        Some(connector) => match connector.list_tables().await {
            Ok(tables) => {
                let count = tables
                    .iter()
                    .filter(|t| {
                        schema_filter
                            .as_deref()
                            .map_or(true, |s| t.schema.eq_ignore_ascii_case(s))
                    })
                    .count();
                let scope = match &schema_filter {
                    Some(s) => format!(" in schema \"{}\"", s),
                    None => String::new(),
                };
                Ok(format!(
                    "Connected successfully — {} source table{} available{}.",
                    count,
                    if count == 1 { "" } else { "s" },
                    scope
                ))
            }
            Err(_) => Ok("Connected successfully.".to_string()),
        },
        None => Ok("Connected successfully.".to_string()),
    }
}

/// Live-connect a connection using its stored connection string (PostgreSQL
/// only). Sets the connector so `bi_model_list_source_tables`/import work
/// immediately after creating a model. Used by the New-Model dialog's
/// create → connect flow.
#[tauri::command]
pub async fn bi_model_connect(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<super::types::ConnectionInfo, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let (engine_arc, conn_str) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        if conn.connection_type != super::types::ConnectionType::PostgreSQL {
            return Err(format!(
                "Live connect supports PostgreSQL only right now (this connection is {}).",
                conn.connection_type.as_str()
            ));
        }
        (
            conn.engine
                .clone()
                .ok_or("No model loaded for this connection")?,
            conn.connection_string.clone(),
        )
    };
    if conn_str.trim().is_empty() {
        return Err(
            "This connection has no connection details — set a data source when creating the model."
                .to_string(),
        );
    }
    let (target, auth) = super::commands::parse_connection_string(&conn_str);
    let idx = {
        let mut engine = engine_arc.lock().await;
        engine
            .add_postgres(target, auth)
            .await
            .map_err(|e| format!("Connection failed: {}", e))?
    };
    let info = {
        let mut conns = bi_state.connections.lock().unwrap();
        let conn = conns.get_mut(&connection_id).ok_or("Connection not found")?;
        conn.connector_index = Some(idx);
        conn.is_connected = true;
        conn.to_info()
    };
    Ok(info)
}

// ---------------------------------------------------------------------------
// ME-7: Testing Ground — ad-hoc query preview over the model
// ---------------------------------------------------------------------------
//
// A read-only query runner: pick measures + group-by dimensions + filters,
// optionally preview a security role (dynamic RLS identities), and see the
// rows the engine returns, the per-column metadata, and (optionally) the
// execution plan. It never mutates the model. RLS preview is EPHEMERAL: the
// role/identity/custom-data set on the shared engine is saved and restored
// around the query under the engine lock, so a preview never leaks into CUBE
// cells or a sibling connection's results.

/// Client-supplied query ids -> cancellation tokens for in-flight test queries.
/// A module-level registry keeps cancellation off the BiState hot path.
fn query_tokens() -> &'static Mutex<HashMap<String, bi_engine::CancellationToken>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, bi_engine::CancellationToken>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Hard cap on preview rows (an unbounded high-cardinality group-by would
/// otherwise materialize every row). One extra row is fetched to detect
/// truncation without computing the whole set.
const MAX_TEST_ROWS: usize = 5000;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRefDto {
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestFilterDto {
    /// Column name (the engine matches it to the owning table).
    pub column: String,
    /// "=" | "!=" | ">" | ">=" | "<" | "<="
    pub operator: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumnDto {
    pub name: String,
    /// "Dimension" | "Measure" | "GroupingId" | "Rank"
    pub kind: String,
    pub data_type: Option<String>,
    pub source_table: Option<String>,
    pub source_column: Option<String>,
    pub measure: Option<String>,
    pub format_string: Option<String>,
    pub display_name: Option<String>,
    pub kpi_name: Option<String>,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPropertyDto {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanNodeDto {
    pub operation: String,
    pub label: String,
    pub duration_ms: f64,
    pub properties: Vec<PlanPropertyDto>,
    pub children: Vec<PlanNodeDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPlanDto {
    pub summary: String,
    pub total_ms: f64,
    pub root: PlanNodeDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: usize,
    /// True when the source produced more rows than the cap (more exist).
    pub truncated: bool,
    pub result_columns: Vec<ResultColumnDto>,
    pub plan: Option<ExecutionPlanDto>,
}

fn filter_operator_from_str(s: &str) -> Result<bi_engine::FilterOperator, String> {
    Ok(match s {
        "=" => bi_engine::FilterOperator::Equal,
        "!=" => bi_engine::FilterOperator::NotEqual,
        ">" => bi_engine::FilterOperator::GreaterThan,
        ">=" => bi_engine::FilterOperator::GreaterThanOrEqual,
        "<" => bi_engine::FilterOperator::LessThan,
        "<=" => bi_engine::FilterOperator::LessThanOrEqual,
        other => return Err(format!("Unknown filter operator '{}'", other)),
    })
}

fn result_column_to_dto(rc: &bi_engine::ResultColumn) -> ResultColumnDto {
    let kind = match rc.kind {
        bi_engine::ResultColumnKind::Dimension => "Dimension",
        bi_engine::ResultColumnKind::Measure => "Measure",
        bi_engine::ResultColumnKind::GroupingId => "GroupingId",
        bi_engine::ResultColumnKind::Rank => "Rank",
    }
    .to_string();
    ResultColumnDto {
        name: rc.name.clone(),
        kind,
        data_type: rc.data_type.as_ref().map(|dt| format!("{:?}", dt)),
        source_table: rc.source_table.clone(),
        source_column: rc.source_column.clone(),
        measure: rc.measure.clone(),
        format_string: rc.format_string.clone(),
        display_name: rc.display_name.clone(),
        kpi_name: rc.kpi_name.clone(),
        is_hidden: rc.is_hidden,
    }
}

fn plan_value_to_string(v: &bi_engine::PlanValue) -> String {
    match v {
        bi_engine::PlanValue::Text(s) => s.clone(),
        bi_engine::PlanValue::Number(n) => n.to_string(),
        bi_engine::PlanValue::Bool(b) => b.to_string(),
        bi_engine::PlanValue::List(items) => items.join(", "),
    }
}

fn plan_node_to_dto(n: &bi_engine::PlanNode) -> PlanNodeDto {
    PlanNodeDto {
        operation: format!("{:?}", n.operation),
        label: n.label.clone(),
        duration_ms: n.duration.ms,
        properties: n
            .properties
            .iter()
            .map(|p| PlanPropertyDto {
                key: p.key.clone(),
                value: plan_value_to_string(&p.value),
            })
            .collect(),
        children: n.children.iter().map(plan_node_to_dto).collect(),
    }
}

fn execution_plan_to_dto(p: &bi_engine::ExecutionPlan) -> ExecutionPlanDto {
    ExecutionPlanDto {
        summary: p.summary.clone(),
        total_ms: p.total_duration.ms,
        root: plan_node_to_dto(&p.root),
    }
}

/// Server-side sort directive (a measure sort + row cap is a TOP-N query the
/// engine evaluates over the full dataset).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotSortDto {
    /// "measure" to sort by a measure result, or "column" for a group-by column.
    pub kind: String,
    /// Table name (used only when kind == "column").
    pub table: Option<String>,
    /// Measure name (kind == "measure") or column name (kind == "column").
    pub field: String,
    pub descending: bool,
}

/// Measure-value filter (HAVING).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureFilterDto {
    pub measure: String,
    /// "=" | "!=" | ">" | ">=" | "<" | "<="
    pub operator: String,
    pub value: f64,
}

/// Keep the top-N groups by a measure (tie-inclusive).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopNDto {
    pub measure: String,
    pub limit: usize,
    pub ascending: bool,
}

/// Append a measure-value ranking column (RANKX).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankByDto {
    pub measure: String,
    pub output_column: String,
    pub dense: bool,
    pub ascending: bool,
}

/// Run an ad-hoc query against a connection's model for the Testing Ground.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bi_model_test_query(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    measures: Vec<String>,
    group_by: Vec<ColumnRefDto>,
    filters: Vec<TestFilterDto>,
    sort: Vec<PivotSortDto>,
    measure_filters: Vec<MeasureFilterDto>,
    top_n: Option<TopNDto>,
    rank_by: Option<RankByDto>,
    row_limit: Option<usize>,
    rollup: bool,
    include_plan: bool,
    preview_role: Option<String>,
    preview_user_identity: Option<String>,
    preview_custom_data: Option<String>,
    query_id: Option<String>,
    window: tauri::Window,
) -> Result<TestQueryResult, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;

    if measures.is_empty() {
        return Err("Select at least one measure to run a query.".to_string());
    }

    let engine_arc = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        conn.engine
            .clone()
            .ok_or("No model loaded for this connection")?
    };

    let group_refs: Vec<bi_engine::ColumnRef> = group_by
        .iter()
        .map(|g| bi_engine::ColumnRef::new(&g.table, &g.column))
        .collect();
    let filter_conds: Vec<bi_engine::FilterCondition> = filters
        .iter()
        .map(|f| {
            Ok(bi_engine::FilterCondition::new(
                f.column.clone(),
                filter_operator_from_str(&f.operator)?,
                f.value.clone(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;

    // Rollup subtotals cannot be combined with RANKX/TOPN (the engine rejects
    // it; fail early with a clear message).
    if rollup && (top_n.is_some() || rank_by.is_some()) {
        return Err(
            "Rollup subtotals cannot be combined with TOPN or RANKX. Turn off one of them."
                .to_string(),
        );
    }

    let order_by: Vec<bi_engine::OrderByClause> = sort
        .iter()
        .map(|s| {
            let mut clause = if s.kind == "measure" {
                bi_engine::OrderByClause::measure(&s.field)
            } else {
                bi_engine::OrderByClause::column(s.table.clone().unwrap_or_default(), &s.field)
            };
            clause.descending = s.descending;
            clause
        })
        .collect();

    let measure_filter_conds: Vec<bi_engine::MeasureFilter> = measure_filters
        .iter()
        .map(|m| {
            Ok(bi_engine::MeasureFilter::new(
                m.measure.clone(),
                filter_operator_from_str(&m.operator)?,
                m.value,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let top_n_req = top_n.as_ref().map(|t| {
        let mut r = bi_engine::TopN::new(t.measure.clone(), t.limit);
        r.ascending = t.ascending;
        r
    });
    let rank_by_req = rank_by.as_ref().map(|r| {
        let mut rb = bi_engine::RankBy::new(r.measure.clone(), r.output_column.clone());
        rb.dense = r.dense;
        rb.ascending = r.ascending;
        rb
    });

    let cap = row_limit.map_or(MAX_TEST_ROWS, |n| n.min(MAX_TEST_ROWS).max(1));
    let request = bi_engine::QueryRequest {
        measures,
        group_by: group_refs,
        filters: filter_conds,
        order_by,
        measure_filters: measure_filter_conds,
        top_n: top_n_req,
        rank_by: rank_by_req,
        limit: Some(cap.saturating_add(1)),
        totals: if rollup {
            bi_engine::TotalsMode::Rollup
        } else {
            bi_engine::TotalsMode::None
        },
        ..Default::default()
    };

    // Register a cancellation token so bi_model_cancel_query can abort this run.
    let token = bi_engine::CancellationToken::new();
    if let Some(qid) = query_id.clone() {
        if let Ok(mut map) = query_tokens().lock() {
            map.insert(qid, token.clone());
        }
    }

    let mut engine = engine_arc.lock().await;

    // Save the shared engine's sticky RLS state, apply the preview, and ALWAYS
    // restore it before releasing the lock so the preview is ephemeral.
    let saved_role = engine.active_role().map(|s| s.to_string());
    let saved_user = engine.user_identity().map(|s| s.to_string());
    let saved_custom = engine.custom_data().map(|s| s.to_string());
    let clean = |s: Option<String>| s.filter(|v| !v.trim().is_empty());
    engine.set_active_role(clean(preview_role));
    engine.set_user_identity(clean(preview_user_identity));
    engine.set_custom_data(clean(preview_custom_data));

    let run: Result<(super::types::BiQueryResult, Vec<bi_engine::ResultColumn>, Option<bi_engine::ExecutionPlan>), String> =
        if include_plan {
            engine
                .query_explained(request)
                .await
                .map(|(batches, plan)| {
                    (super::commands::batches_to_result(&batches), Vec::new(), Some(plan))
                })
                .map_err(|e| format!("{}", e))
        } else {
            engine
                .query_with_meta_and_cancellation(request, token)
                .await
                .map(|(batches, meta)| {
                    (super::commands::batches_to_result(&batches), meta, None)
                })
                .map_err(|e| format!("{}", e))
        };

    // Restore the engine's pre-preview RLS state unconditionally.
    engine.set_active_role(saved_role);
    engine.set_user_identity(saved_user);
    engine.set_custom_data(saved_custom);
    drop(engine);

    if let Some(qid) = query_id.as_ref() {
        if let Ok(mut map) = query_tokens().lock() {
            map.remove(qid);
        }
    }

    let (mut result, meta, plan) = run?;

    // Detect + trim the one over-fetched truncation-probe row.
    let truncated = result.rows.len() > cap;
    if truncated {
        result.rows.truncate(cap);
    }
    let row_count = result.rows.len();

    // Drop the synthetic grouping-id column's metadata so result_columns aligns
    // positionally with the emitted `columns` for the common (no-rollup) path.
    let result_columns: Vec<ResultColumnDto> = meta
        .iter()
        .filter(|rc| rc.kind != bi_engine::ResultColumnKind::GroupingId)
        .map(result_column_to_dto)
        .collect();

    Ok(TestQueryResult {
        columns: result.columns,
        rows: result.rows,
        row_count,
        truncated,
        result_columns,
        plan: plan.as_ref().map(execution_plan_to_dto),
    })
}

/// Cancel an in-flight Testing Ground query by its client-supplied id. Touches
/// only the token registry (never the engine lock), so it never blocks on the
/// running query; the query aborts cooperatively.
#[tauri::command]
pub fn bi_model_cancel_query(query_id: String, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    if let Ok(map) = query_tokens().lock() {
        if let Some(token) = map.get(&query_id) {
            token.cancel();
        }
    }
    Ok(())
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

    // -----------------------------------------------------------------------
    // ME-6 DTO bridge round-trips
    // -----------------------------------------------------------------------

    fn rf(table: &str, column: &str, op: &str, value: &str, dynamic: Option<&str>) -> RoleFilterDto {
        RoleFilterDto {
            table: table.into(),
            column: column.into(),
            operator: op.into(),
            value: value.into(),
            dynamic: dynamic.map(|s| s.into()),
        }
    }

    #[test]
    fn predicate_dto_roundtrips_static_and_dynamic() {
        // Static predicate: operator + value preserved, no dynamic kind.
        let s = predicate_to_dto(&predicate_from_dto(&rf("S", "region", ">=", "10", None)).unwrap());
        assert_eq!((s.operator.as_str(), s.value.as_str(), s.dynamic), (">=", "10", None));
        // Dynamic predicate: the dynamic kind survives (value is the engine
        // placeholder — the identity is substituted at query time).
        let d = predicate_to_dto(
            &predicate_from_dto(&rf("S", "email", "=", "ignored", Some("username"))).unwrap(),
        );
        assert_eq!(d.dynamic.as_deref(), Some("username"));
        assert_eq!(d.operator, "=");
    }

    fn op_dto(ty: &str) -> ContextOpDto {
        ContextOpDto {
            r#type: ty.into(),
            filters: vec![],
            clear_targets: vec![],
            in_predicates: vec![],
            inherit_context: None,
            relationship_name: None,
        }
    }

    #[test]
    fn context_op_bridge_roundtrips_every_variant() {
        // Unit variants: type string survives the enum round-trip.
        for ty in ["reset", "resetInner", "resetOuter"] {
            let back = context_op_to_dto(&context_op_from_dto(&op_dto(ty)).unwrap());
            assert_eq!(back.r#type, ty);
        }

        // Keep with a filter.
        let mut keep = op_dto("keep");
        keep.filters = vec![rf("Sales", "country", "=", "US", None)];
        let back = context_op_to_dto(&context_op_from_dto(&keep).unwrap());
        assert_eq!(back.r#type, "keep");
        assert_eq!(back.filters.len(), 1);
        assert_eq!(back.filters[0].column, "country");

        // Clear (column + table targets).
        let mut clear = op_dto("clear");
        clear.clear_targets = vec![
            ClearTargetDto { kind: "column".into(), table: "Cal".into(), column: Some("Year".into()) },
            ClearTargetDto { kind: "table".into(), table: "Products".into(), column: None },
        ];
        let back = context_op_to_dto(&context_op_from_dto(&clear).unwrap());
        assert_eq!(back.clear_targets.len(), 2);
        assert_eq!(back.clear_targets[0].kind, "column");
        assert_eq!(back.clear_targets[0].column.as_deref(), Some("Year"));
        assert_eq!(back.clear_targets[1].kind, "table");
        assert_eq!(back.clear_targets[1].column, None);

        // KeepIn membership.
        let mut keep_in = op_dto("keepIn");
        keep_in.in_predicates = vec![InPredicateDto {
            table: "Sales".into(),
            column: "cust".into(),
            var_name: "TopCustomers".into(),
            var_column: "id".into(),
        }];
        let back = context_op_to_dto(&context_op_from_dto(&keep_in).unwrap());
        assert_eq!(back.r#type, "keepIn");
        assert_eq!(back.in_predicates[0].var_name, "TopCustomers");

        // Inherit + UseRelationship carry their single operand.
        let mut inherit = op_dto("inherit");
        inherit.inherit_context = Some("base".into());
        assert_eq!(
            context_op_to_dto(&context_op_from_dto(&inherit).unwrap()).inherit_context.as_deref(),
            Some("base")
        );
        let mut use_rel = op_dto("useRelationship");
        use_rel.relationship_name = Some("Sales_Date".into());
        assert_eq!(
            context_op_to_dto(&context_op_from_dto(&use_rel).unwrap()).relationship_name.as_deref(),
            Some("Sales_Date")
        );
    }

    #[test]
    fn context_op_from_dto_rejects_unknown_and_missing_operands() {
        assert!(context_op_from_dto(&op_dto("bogus")).is_err());
        assert!(context_op_from_dto(&op_dto("inherit")).is_err()); // no context name
        assert!(context_op_from_dto(&op_dto("useRelationship")).is_err());
    }

    #[test]
    fn string_enum_maps_are_consistent() {
        for op in ["=", "!=", ">", ">=", "<", "<="] {
            assert!(comparison_op_from_str(op).is_ok());
            assert!(filter_operator_from_str(op).is_ok());
        }
        for p in ["auto", "none", "both"] {
            assert_eq!(propagation_to_str(propagation_from_str(p).unwrap()), p);
        }
        for t in ["Int", "Float", "Bool", "String"] {
            assert_eq!(script_type_to_str(script_type_from_str(t).unwrap()), t);
        }
        assert!(propagation_from_str("sideways").is_err());
        assert!(script_type_from_str("Decimal").is_err());
    }

    #[test]
    fn model_undo_stack_records_pushes_and_clears_redo() {
        let key = Some(ModelKey::from_model_path("unit-test-undo-key-8f3a"));
        {
            // Isolate from any other test touching the global store.
            let mut store = model_undo_store().lock().unwrap();
            store.remove(&key);
        }
        record_model_undo(&key, base_model());
        record_model_undo(&key, base_model());
        {
            let mut store = model_undo_store().lock().unwrap();
            let stacks = store.get_mut(&key).unwrap();
            assert_eq!(stacks.undo.len(), 2);
            assert!(stacks.redo.is_empty());
            // Simulate an undo moving one snapshot to redo.
            stacks.redo.push(stacks.undo.pop().unwrap());
            assert_eq!(stacks.undo.len(), 1);
            assert_eq!(stacks.redo.len(), 1);
        }
        // A fresh edit clears the redo branch.
        record_model_undo(&key, base_model());
        {
            let mut store = model_undo_store().lock().unwrap();
            let stacks = store.get_mut(&key).unwrap();
            assert_eq!(stacks.undo.len(), 2);
            assert!(stacks.redo.is_empty());
            store.remove(&key); // cleanup
        }
    }
}
