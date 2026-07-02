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
    pub columns: Vec<ModelColumnInfo>,
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
                    }),
            );
            ModelTableInfo {
                name: t.name().to_string(),
                display_name: t.display_name().map(|s| s.to_string()),
                description: t.description().map(|s| s.to_string()),
                is_hidden: t.is_hidden(),
                storage_mode: format!("{:?}", t.storage_mode()),
                bound: bindings.iter().any(|b| b.model_table == t.name()),
                columns,
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
            filters: r
                .table_filters()
                .iter()
                .map(|f| RoleFilterDto {
                    table: f.table.clone(),
                    column: f.column.clone(),
                    operator: f.operator.as_sql().to_string(),
                    value: f.value.clone(),
                    dynamic: f.dynamic.as_ref().map(|d| match d {
                        bi_engine::expression::DynamicValue::Username => "username".to_string(),
                        bi_engine::expression::DynamicValue::CustomData => {
                            "customData".to_string()
                        }
                    }),
                })
                .collect(),
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
pub async fn bi_model_update_column(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    table: String,
    column: String,
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
        let Some(c) = t.columns_mut().iter_mut().find(|c| c.name() == column) else {
            return Err(format!("Column '{}[{}]' not found", table, column));
        };
        c.set_display_name(display_name.filter(|s| !s.trim().is_empty()));
        c.set_description(description.filter(|s| !s.trim().is_empty()));
        c.set_hidden(is_hidden);
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
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Relationship name cannot be empty".to_string());
        }
        let Some(first) = conditions.first() else {
            return Err("A relationship needs at least one join condition".to_string());
        };
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
        // Suppress the unused warning path: `first` is only needed for the
        // single-condition constructor which with_conditions supersedes.
        let _ = first;
        let mut rel = bi_engine::Relationship::with_conditions(
            trimmed,
            from_table.clone(),
            to_table.clone(),
            built_conditions,
            card,
        )
        .with_active(active);

        let mut rels = base.relationships().to_vec();
        match original_name.as_deref() {
            Some(orig) => {
                let Some(idx) = rels.iter().position(|r| r.name() == orig) else {
                    return Err(format!("Relationship '{}' not found", orig));
                };
                // The DTO does not carry filter propagation: preserve the old
                // relationship's setting when the cardinality is unchanged
                // (a cardinality change falls back to the derived default).
                if rels[idx].cardinality() == card {
                    rel = rel.with_propagation(rels[idx].propagation());
                }
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
        let mut predicates = Vec::with_capacity(filters.len());
        for f in &filters {
            let op = comparison_op_from_str(&f.operator)?;
            predicates.push(match f.dynamic.as_deref() {
                Some("username") => {
                    bi_engine::FilterPredicate::username(f.table.clone(), f.column.clone(), op)
                }
                Some("customData") => {
                    bi_engine::FilterPredicate::custom_data(f.table.clone(), f.column.clone(), op)
                }
                Some(other) => return Err(format!("Unknown dynamic kind '{}'", other)),
                None => bi_engine::FilterPredicate::new(
                    f.table.clone(),
                    f.column.clone(),
                    op,
                    f.value.clone(),
                ),
            });
        }
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
    let (engine_arc, connector_index, model_tables) = {
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
        (
            conn.engine
                .clone()
                .ok_or("No model loaded for this connection")?,
            idx,
            tables,
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

    let mut model_tables = base.tables().to_vec();
    for table in &introspected {
        if model_tables.iter().any(|t| t.name() == table.name()) {
            return Err(format!(
                "The model already has a table named '{}'",
                table.name()
            ));
        }
        model_tables.push(table.clone());
    }
    let new_base = base.with_tables(model_tables);
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
        .map_err(|e| format!("{}", e))?;
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
