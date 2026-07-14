//! FILENAME: app/src-tauri/src/bi/writeback_source.rs
//! PURPOSE: Surface .calp writeback submissions as queryable BI model tables.
//!
//! Every writeback region the workbook can see (its subscriptions, which for a
//! publisher include their own published packages) becomes an importable
//! dataset: a long-format table with one row per submission. The data path is
//! strictly one-way and governance-filtered at build time:
//!
//!   registry files -> signature-verified manifest declarations
//!     -> merge_lenient_submissions (same carry-forward as GATHER)
//!     -> apply_gather_governance (same privacy/approval boundary as GATHER,
//!        subscriber audience only)
//!     -> Arrow batches inside an InMemoryConnector under the stable source id
//!        `calp_writeback` -> ordinary engine tables.
//!
//! Because the batches are filtered BEFORE they enter the engine, no query can
//! widen visibility — engine-side filters/RLS only narrow further. Publisher
//! audience (proven by Ed25519 key possession, the same proof as approve/
//! reject) sees every submission in every state plus the review fields;
//! subscribers get their governed view and never see review free-text.
//!
//! The connector's data cannot be rebuilt from the persisted model (SourceKind::
//! InMemory carries no connection), so this module re-provisions it on load,
//! pull, and every writeback mutation — see `refresh_writeback_sources`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowDataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use serde::Serialize;
use tauri::{Manager, State};

use crate::calp_commands::{
    apply_gather_governance, calcula_profile_dir, get_subscriber_identity,
    merge_lenient_submissions, older_package_versions, submission_state_str,
};
use crate::persistence::FileState;
use crate::AppState;

use super::commands::index_to_col;
use super::model_editor::{mutate_and_overview, ModelOverview};
use super::types::{BiState, ConnectionId};

/// Stable catalog/source id for the workbook's writeback datasets. One source
/// serves every region; each region is a physical table `writeback.<region-id>`.
pub const WRITEBACK_SOURCE_ID: &str = "calp_writeback";
/// Cosmetic physical schema name inside the writeback source.
pub const WRITEBACK_SCHEMA: &str = "writeback";

// ---------------------------------------------------------------------------
// Dataset collection (registry I/O + governance)
// ---------------------------------------------------------------------------

/// Which view of a region's submissions this workbook is entitled to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WritebackAudience {
    /// Holder of the package's publisher key: all submissions, all states,
    /// review fields included.
    Publisher,
    /// Everyone else: the same governed view GATHER exposes.
    Subscriber,
}

impl WritebackAudience {
    pub fn as_str(&self) -> &'static str {
        match self {
            WritebackAudience::Publisher => "publisher",
            WritebackAudience::Subscriber => "subscriber",
        }
    }
}

/// One buildable dataset: a writeback region within a subscribed package,
/// with its submissions already merged (version carry-forward) and filtered
/// for this workbook's audience.
pub struct WritebackDataset {
    pub package_name: String,
    pub package_version: String,
    pub region: calp::WritebackRegionDeclaration,
    pub audience: WritebackAudience,
    /// Suggested model-table name: `WB {package} {Sheet}!{A1:B4}`.
    pub display_name: String,
    pub sheet_name: String,
    pub range_ref: String,
    pub rows: Vec<calp::writeback::WritebackSubmission>,
}

/// Strip what the engine's identifier validation forbids (`"[]';\/`, control
/// chars, the `..` sequence) from a suggested table name — sheet names are
/// user text and may contain them ("Q1/Q2"). Spaces, '!' and ':' are legal
/// model identifiers and are kept.
fn sanitize_table_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '"' | '[' | ']' | '\'' | ';' | '\\' | '/' => '-',
            c => c,
        })
        .collect();
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "WB dataset".to_string()
    } else {
        trimmed.to_string()
    }
}

/// A1-style range label for a region selector ("B2" or "B2:D10").
fn selector_range_ref(sel: &calp::writeback::RegionSelector) -> String {
    let start = format!("{}{}", index_to_col(sel.col_start), sel.row_start + 1);
    if sel.row_start == sel.row_end && sel.col_start == sel.col_end {
        start
    } else {
        format!(
            "{}:{}{}",
            start,
            index_to_col(sel.col_end),
            sel.row_end + 1
        )
    }
}

/// Enumerate + load + govern every writeback dataset this workbook can see.
/// Pure registry I/O — no engine access, no grid locks. Mirrors
/// `build_gather_data`'s enumeration exactly (same subscription skips, same
/// signature-verified manifests, same first-subscription-wins per region), so
/// the dataset tables and GATHER can never disagree about what exists.
pub fn collect_writeback_datasets(state: &AppState) -> Vec<WritebackDataset> {
    let mut result: Vec<WritebackDataset> = Vec::new();
    let mut seen_regions: HashSet<String> = HashSet::new();

    let subs = match state.subscriptions.lock() {
        Ok(s) => s,
        Err(_) => return result,
    };
    let own_identity = get_subscriber_identity(state).ok();

    for sub in &subs.subscriptions {
        // Same skips as build_gather_data: dev and file-channel subscriptions
        // have no versioned submission tree.
        if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
            continue;
        }
        let registry_path = sub
            .registry_url
            .strip_prefix("file://")
            .unwrap_or(&sub.registry_url);
        let registry = match crate::calp_registry::open_registry(registry_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        // Region declarations MUST come from the signature-verified manifest —
        // they carry the governance policies enforced below.
        let ver_manifest = match calp::integrity::verify_and_load_manifest_via(
            registry.as_ref(),
            &sub.package_name,
            &sub.resolved_version,
            &calcula_profile_dir(),
        ) {
            Ok((_, m)) => m,
            Err(_) => continue,
        };
        let regions = match &ver_manifest.writeback_regions {
            Some(r) if !r.is_empty() => r.clone(),
            _ => continue,
        };

        // Publisher audience = possession of the package's signing key — the
        // exact proof the approve/reject path (`require_publisher`) demands.
        let audience = if calp::signing::profile_holds_publisher_key(
            &calcula_profile_dir(),
            &ver_manifest.publisher_key,
        )
        .unwrap_or(false)
        {
            WritebackAudience::Publisher
        } else {
            WritebackAudience::Subscriber
        };

        // One tree scan for the resolved version, bucketed by region.
        let mut current_by_region: HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
            HashMap::new();
        match registry.load_all_submissions(&sub.package_name, &sub.resolved_version) {
            Ok(all) => {
                for s in all {
                    current_by_region
                        .entry(s.region_id.clone())
                        .or_default()
                        .push(s);
                }
            }
            Err(_) => continue,
        }

        // Strictly older versions for lenient carry-forward (verified the same
        // way as the current version).
        let older: Vec<(
            Vec<calp::WritebackRegionDeclaration>,
            HashMap<String, Vec<calp::writeback::WritebackSubmission>>,
        )> = older_package_versions(registry.as_ref(), &sub.package_name, &sub.resolved_version)
            .iter()
            .filter_map(|version| {
                let manifest = calp::integrity::verify_and_load_manifest_via(
                    registry.as_ref(),
                    &sub.package_name,
                    version,
                    &calcula_profile_dir(),
                )
                .map(|(_, m)| m)
                .ok()?;
                let mut by_region: HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
                    HashMap::new();
                for s in registry
                    .load_all_submissions(&sub.package_name, version)
                    .ok()?
                {
                    by_region.entry(s.region_id.clone()).or_default().push(s);
                }
                Some((manifest.writeback_regions.unwrap_or_default(), by_region))
            })
            .collect();

        for region in regions {
            // First subscription declaring a region wins, matching the submit
            // path and build_gather_data.
            if !seen_regions.insert(region.id.clone()) {
                continue;
            }

            let submissions = current_by_region.remove(&region.id).unwrap_or_default();
            let submissions = merge_lenient_submissions(submissions, &older, &region);

            let mut rows = match audience {
                // Subscriber rows pass the SAME governance boundary as GATHER:
                // approval gating, Draft/Rejected/Empty drops, read-side schema
                // + deadline integrity, visibility masking/anonymization.
                WritebackAudience::Subscriber => {
                    apply_gather_governance(submissions, &region, own_identity.as_ref())
                }
                // Publisher sees everything (including Rejected — review
                // analytics); their registry, their data.
                WritebackAudience::Publisher => submissions,
            };
            // Deterministic row order for both audiences (governance already
            // sorts, but the publisher path must be stable too).
            rows.sort_by(|a, b| {
                a.cell_row
                    .cmp(&b.cell_row)
                    .then(a.cell_col.cmp(&b.cell_col))
                    .then(a.submitter.id.cmp(&b.submitter.id))
            });

            let sheet_name = ver_manifest
                .sheets
                .iter()
                .find(|s| s.sheet_id == region.selector.sheet_id)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| "Sheet".to_string());
            let range_ref = selector_range_ref(&region.selector);
            let display_name =
                sanitize_table_name(&format!("WB {} {}!{}", sub.package_name, sheet_name, range_ref));

            result.push(WritebackDataset {
                package_name: sub.package_name.clone(),
                package_version: sub.resolved_version.clone(),
                region,
                audience,
                display_name,
                sheet_name,
                range_ref,
                rows,
            });
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Arrow encoding
// ---------------------------------------------------------------------------

/// Engine column definitions for a dataset table. Review fields only exist on
/// publisher-audience tables — a subscriber table must not even have the
/// columns (empty values would still invite "why is it blank" questions, and a
/// carelessly widened batch would then fail the schema instead of leaking).
fn dataset_columns(audience: WritebackAudience) -> Vec<bi_engine::Column> {
    use bi_engine::{Column, DataType};
    let mut cols = vec![
        Column::new("submission_id", DataType::String),
        Column::new("package_name", DataType::String),
        Column::new("package_version", DataType::String),
        Column::new("region_id", DataType::String),
        Column::new("submitter_id", DataType::String),
        Column::new("submitter_name", DataType::String),
        Column::new("cell_row", DataType::Int64),
        Column::new("cell_col", DataType::Int64),
        Column::new("cell_ref", DataType::String),
        Column::new("value_number", DataType::Float64),
        Column::new("value_text", DataType::String),
        Column::new("value_kind", DataType::String),
        Column::new("state", DataType::String),
        Column::new("submitted_at", DataType::String),
        Column::new("updated_at", DataType::String),
    ];
    if audience == WritebackAudience::Publisher {
        cols.push(Column::new("reviewed_by", DataType::String));
        cols.push(Column::new("review_reason", DataType::String));
    }
    cols
}

/// Encode a dataset's rows as one Arrow batch (long format, one row per
/// submission). Column names/types mirror `dataset_columns` exactly.
fn dataset_batch(ds: &WritebackDataset) -> Result<RecordBatch, String> {
    use calp::writeback::SubmissionValue;

    let n = ds.rows.len();
    let mut submission_id: Vec<String> = Vec::with_capacity(n);
    let mut submitter_id: Vec<String> = Vec::with_capacity(n);
    let mut submitter_name: Vec<String> = Vec::with_capacity(n);
    let mut cell_row: Vec<i64> = Vec::with_capacity(n);
    let mut cell_col: Vec<i64> = Vec::with_capacity(n);
    let mut cell_ref: Vec<String> = Vec::with_capacity(n);
    let mut value_number: Vec<Option<f64>> = Vec::with_capacity(n);
    let mut value_text: Vec<String> = Vec::with_capacity(n);
    let mut value_kind: Vec<&'static str> = Vec::with_capacity(n);
    let mut state: Vec<&'static str> = Vec::with_capacity(n);
    let mut submitted_at: Vec<Option<String>> = Vec::with_capacity(n);
    let mut updated_at: Vec<String> = Vec::with_capacity(n);
    let mut reviewed_by: Vec<Option<String>> = Vec::with_capacity(n);
    let mut review_reason: Vec<Option<String>> = Vec::with_capacity(n);

    for s in &ds.rows {
        submission_id.push(s.id.clone());
        submitter_id.push(s.submitter.id.clone());
        submitter_name.push(s.submitter.display_name.clone());
        cell_row.push(s.cell_row as i64);
        cell_col.push(s.cell_col as i64);
        cell_ref.push(format!("{}{}", index_to_col(s.cell_col), s.cell_row + 1));
        let (num, text, kind) = match &s.value {
            SubmissionValue::Number { value } => (Some(*value), value.to_string(), "number"),
            SubmissionValue::Text { value } => (None, value.clone(), "text"),
            SubmissionValue::Boolean { value } => (
                None,
                (if *value { "TRUE" } else { "FALSE" }).to_string(),
                "boolean",
            ),
            // Governance drops Empty for subscribers; a publisher can see a
            // cleared cell as an explicit empty record (never a phantom zero).
            SubmissionValue::Empty => (None, String::new(), "empty"),
        };
        value_number.push(num);
        value_text.push(text);
        value_kind.push(kind);
        state.push(submission_state_str(&s.state));
        submitted_at.push(s.submitted_at.clone());
        updated_at.push(s.updated_at.clone());
        reviewed_by.push(s.reviewed_by.clone());
        review_reason.push(s.review_reason.clone());
    }

    // All fields nullable: the engine's own arrow mapping treats model columns
    // as nullable, and a strict non-null field here would make schema
    // reconciliation brittle for zero benefit.
    let mut fields = vec![
        Field::new("submission_id", ArrowDataType::Utf8, true),
        Field::new("package_name", ArrowDataType::Utf8, true),
        Field::new("package_version", ArrowDataType::Utf8, true),
        Field::new("region_id", ArrowDataType::Utf8, true),
        Field::new("submitter_id", ArrowDataType::Utf8, true),
        Field::new("submitter_name", ArrowDataType::Utf8, true),
        Field::new("cell_row", ArrowDataType::Int64, true),
        Field::new("cell_col", ArrowDataType::Int64, true),
        Field::new("cell_ref", ArrowDataType::Utf8, true),
        Field::new("value_number", ArrowDataType::Float64, true),
        Field::new("value_text", ArrowDataType::Utf8, true),
        Field::new("value_kind", ArrowDataType::Utf8, true),
        Field::new("state", ArrowDataType::Utf8, true),
        Field::new("submitted_at", ArrowDataType::Utf8, true),
        Field::new("updated_at", ArrowDataType::Utf8, true),
    ];
    let mut arrays: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from(submission_id)),
        Arc::new(StringArray::from(vec![ds.package_name.clone(); n])),
        Arc::new(StringArray::from(vec![ds.package_version.clone(); n])),
        Arc::new(StringArray::from(vec![ds.region.id.clone(); n])),
        Arc::new(StringArray::from(submitter_id)),
        Arc::new(StringArray::from(submitter_name)),
        Arc::new(Int64Array::from(cell_row)),
        Arc::new(Int64Array::from(cell_col)),
        Arc::new(StringArray::from(cell_ref)),
        Arc::new(Float64Array::from(value_number)),
        Arc::new(StringArray::from(value_text)),
        Arc::new(StringArray::from(value_kind)),
        Arc::new(StringArray::from(state)),
        Arc::new(StringArray::from(submitted_at)),
        Arc::new(StringArray::from(updated_at)),
    ];
    if ds.audience == WritebackAudience::Publisher {
        fields.push(Field::new("reviewed_by", ArrowDataType::Utf8, true));
        fields.push(Field::new("review_reason", ArrowDataType::Utf8, true));
        arrays.push(Arc::new(StringArray::from(reviewed_by)));
        arrays.push(Arc::new(StringArray::from(review_reason)));
    }

    RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Engine provisioning
// ---------------------------------------------------------------------------

/// What `ensure_writeback_source` did to one engine.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackSourceReport {
    /// Model tables re-bound and re-fetched from the rebuilt connector.
    pub refreshed_tables: Vec<String>,
    /// Model tables whose region no longer exists (or whose fetch failed):
    /// they keep their last-known data and are reported instead of silently
    /// serving a vanished region.
    pub stale_bindings: Vec<String>,
}

/// Idempotently (re)install the writeback source on ONE engine.
///
/// No-op unless the engine's model already carries the `calp_writeback`
/// catalog entry — the entry is added by the first import
/// (`bi_import_writeback_tables`), never implicitly. When present:
/// 1. build an [`InMemoryConnector`] holding every dataset's batch,
/// 2. swap it in under the stable source id (replace semantics),
/// 3. re-bind every writeback-bound model table to the fresh connector index
///    (the old index would otherwise keep serving the old batches),
/// 4. `refresh_table` each so the engine cache repopulates.
pub async fn ensure_writeback_source(
    datasets: &[WritebackDataset],
    engine: &mut bi_engine::Engine,
) -> WritebackSourceReport {
    let mut report = WritebackSourceReport::default();
    if engine.model().source(WRITEBACK_SOURCE_ID).is_none() {
        return report;
    }

    let mut connector = bi_engine::InMemoryConnector::new();
    for ds in datasets {
        match dataset_batch(ds) {
            Ok(batch) => {
                connector = connector.with_table(WRITEBACK_SCHEMA, ds.region.id.clone(), batch);
            }
            Err(e) => {
                report
                    .stale_bindings
                    .push(format!("{} (encode: {})", ds.display_name, e));
            }
        }
    }

    let idx = engine
        .registry_mut()
        .add_connector_with_id(Some(WRITEBACK_SOURCE_ID.to_string()), connector.into());

    // Re-bind + refresh every model table served by this source. Collect
    // first: the loop below needs &mut engine.
    let bound: Vec<(String, String)> = engine
        .model()
        .tables()
        .iter()
        .filter_map(|t| {
            t.source_binding()
                .filter(|b| b.source_id == WRITEBACK_SOURCE_ID)
                .map(|b| (t.name().to_string(), b.table.clone()))
        })
        .collect();

    for (table_name, region_id) in bound {
        engine.registry_mut().bind(
            table_name.clone(),
            idx,
            bi_engine::SourceBinding::new(WRITEBACK_SCHEMA, &region_id),
        );
        match engine.refresh_table(&table_name).await {
            Ok(()) => report.refreshed_tables.push(table_name),
            Err(e) => report
                .stale_bindings
                .push(format!("{table_name}: {e}")),
        }
    }

    report
}

/// Rebuild datasets once, then re-provision the writeback source on EVERY
/// open connection's engine. Safe to call redundantly (cheap early-outs), and
/// engine-sharing-safe (each distinct engine is provisioned once).
pub async fn refresh_writeback_sources(
    state: &AppState,
    bi_state: &BiState,
) -> Vec<WritebackSourceReport> {
    // Snapshot the distinct engines under the connections lock, then release
    // it before any engine await (established engine->connections lock order;
    // never hold the std mutex across an await).
    let engines: Vec<Arc<tokio::sync::Mutex<bi_engine::Engine>>> = {
        let conns = match bi_state.connections.lock() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        let mut list: Vec<Arc<tokio::sync::Mutex<bi_engine::Engine>>> = Vec::new();
        for c in conns.values() {
            if let Some(engine) = &c.engine {
                if !list.iter().any(|e| Arc::ptr_eq(e, engine)) {
                    list.push(engine.clone());
                }
            }
        }
        list
    };
    if engines.is_empty() {
        return Vec::new();
    }

    // Cheap early-out: no engine carries the source -> no batches needed.
    let mut any_wired = false;
    for engine in &engines {
        let guard = engine.lock().await;
        if guard.model().source(WRITEBACK_SOURCE_ID).is_some() {
            any_wired = true;
            break;
        }
    }
    if !any_wired {
        return Vec::new();
    }

    let datasets = collect_writeback_datasets(state);
    let mut reports = Vec::new();
    for engine in &engines {
        let mut guard = engine.lock().await;
        reports.push(ensure_writeback_source(&datasets, &mut guard).await);
    }
    reports
}

/// App handle for the fire-and-forget refresh hook. Installed once at startup
/// (`run()` in lib.rs); deep writeback mutation paths (which only thread
/// `&AppState`) can then trigger a BI re-provision without signature changes.
static WRITEBACK_BI_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
/// Bumped on every invalidation; the worker loops until it has completed a
/// full refresh that STARTED at the latest generation. Guarantees no
/// invalidation is absorbed by a refresh that snapshotted state before it.
static REFRESH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Whether a worker task is active (coalesces bursts like submit-all's
/// one-invalidation-per-region into a single trailing run).
static REFRESH_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Install the app handle for `invalidate_writeback_bi`. Called once from
/// `run()` right after the Tauri app is built.
pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = WRITEBACK_BI_APP.set(app);
}

/// The app handle installed at startup, for sibling writeback modules that
/// need a fire-and-forget task from sync call sites.
pub(crate) fn app_handle() -> Option<tauri::AppHandle> {
    WRITEBACK_BI_APP.get().cloned()
}

/// Fire-and-forget re-provisioning, for writeback mutation paths (submit,
/// clear, approve/reject, pull/refresh/open — everything that invalidates the
/// GATHER cache) that must not block on registry I/O or engine locks. No-op
/// before the app handle is installed. Failures are logged, never surfaced —
/// the manual refresh command exists for diagnosis.
pub(crate) fn invalidate_writeback_bi() {
    use std::sync::atomic::Ordering;
    let Some(app) = WRITEBACK_BI_APP.get() else {
        return;
    };
    REFRESH_GEN.fetch_add(1, Ordering::SeqCst);
    if REFRESH_ACTIVE.swap(true, Ordering::SeqCst) {
        return; // an active worker will observe the bumped generation
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let seen = REFRESH_GEN.load(Ordering::SeqCst);
            let reports = {
                let state = app.state::<AppState>();
                let bi_state = app.state::<BiState>();
                let reports = refresh_writeback_sources(&state, &bi_state).await;
                // The same events (submit/approve/pull/open) also stale the
                // model writeback COLUMN feeds — refresh them in one pass.
                super::writeback::refresh_model_writeback(&state, &bi_state).await;
                reports
            };
            for r in &reports {
                for stale in &r.stale_bindings {
                    eprintln!("[writeback-bi] stale binding after refresh: {stale}");
                }
            }
            if REFRESH_GEN.load(Ordering::SeqCst) != seen {
                continue; // invalidated mid-run — go again
            }
            REFRESH_ACTIVE.store(false, Ordering::SeqCst);
            // Close the check-then-clear race: a bump that landed between the
            // check above and the clear must not be lost. Re-acquire and loop
            // unless another invalidation already spawned a fresh worker.
            if REFRESH_GEN.load(Ordering::SeqCst) == seen
                || REFRESH_ACTIVE.swap(true, Ordering::SeqCst)
            {
                break;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// One importable dataset, projected for the import UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackTableInfo {
    pub region_id: String,
    pub package_name: String,
    pub package_version: String,
    pub display_name: String,
    /// "publisher" (all submissions) | "subscriber" (governed view).
    pub audience: String,
    pub row_count: usize,
    pub sheet_name: String,
    pub range_ref: String,
    /// Whether the given connection's model already has a table bound to this
    /// region (false when no connection was passed).
    pub already_imported: bool,
}

/// List every writeback dataset this workbook can import. Pure registry I/O;
/// no engine mutation.
#[tauri::command]
pub fn bi_list_writeback_tables(
    state: State<AppState>,
    bi_state: State<BiState>,
    connection_id: Option<ConnectionId>,
    window: tauri::Window,
) -> Result<Vec<WritebackTableInfo>, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;

    // Regions already imported into the target connection's model, if given.
    let imported: HashSet<String> = match connection_id {
        Some(id) => {
            let conns = bi_state.connections.lock().map_err(|e| e.to_string())?;
            conns
                .get(&id)
                .and_then(|c| c.base_model.as_ref())
                .map(|m| {
                    m.tables()
                        .iter()
                        .filter_map(|t| {
                            t.source_binding()
                                .filter(|b| b.source_id == WRITEBACK_SOURCE_ID)
                                .map(|b| b.table.clone())
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        None => HashSet::new(),
    };

    Ok(collect_writeback_datasets(&state)
        .into_iter()
        .map(|ds| WritebackTableInfo {
            already_imported: imported.contains(&ds.region.id),
            region_id: ds.region.id,
            package_name: ds.package_name,
            package_version: ds.package_version,
            display_name: ds.display_name,
            audience: ds.audience.as_str().to_string(),
            row_count: ds.rows.len(),
            sheet_name: ds.sheet_name,
            range_ref: ds.range_ref,
        })
        .collect())
}

/// Import selected writeback regions as tables of one connection's model:
/// adds the `calp_writeback` catalog entry on first use, adds one InMemory
/// table per region (bound by region UUID, so renames are safe), then wires
/// the live connector and fetches. Package-subscribed models are refused by
/// the shared mutation path (they are read-only).
#[tauri::command]
pub async fn bi_import_writeback_tables(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    region_ids: Vec<String>,
    window: tauri::Window,
) -> Result<ModelOverview, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    if region_ids.is_empty() {
        return Err("No writeback regions selected".to_string());
    }

    let datasets = collect_writeback_datasets(&state);
    // Validate the selection up front so the model edit is all-or-nothing.
    struct ImportDef {
        region_id: String,
        base_name: String,
        audience: WritebackAudience,
    }
    let defs: Vec<ImportDef> = region_ids
        .iter()
        .map(|rid| {
            datasets
                .iter()
                .find(|d| &d.region.id == rid)
                .map(|d| ImportDef {
                    region_id: d.region.id.clone(),
                    base_name: d.display_name.clone(),
                    audience: d.audience,
                })
                .ok_or_else(|| format!("Writeback region '{rid}' not found in any subscription"))
        })
        .collect::<Result<_, String>>()?;

    let overview = mutate_and_overview(&bi_state, &file_state, connection_id, move |base, _| {
        let mut sources = base.sources().to_vec();
        if !sources.iter().any(|s| s.id == WRITEBACK_SOURCE_ID) {
            sources.push(
                bi_engine::PersistedSource::new(
                    WRITEBACK_SOURCE_ID,
                    bi_engine::SourceKind::InMemory,
                    Default::default(),
                    bi_engine::PersistedAuthKind::Integrated,
                )
                .with_display_name("Writeback (this workbook)"),
            );
        }

        let mut tables = base.tables().to_vec();
        for def in &defs {
            // Idempotent per region: importing an already-imported region is
            // a no-op, not a duplicate table.
            let already = tables.iter().any(|t| {
                t.source_binding()
                    .map_or(false, |b| b.source_id == WRITEBACK_SOURCE_ID && b.table == def.region_id)
            });
            if already {
                continue;
            }
            // Dedupe the display-derived table name; the region UUID in the
            // binding is the real key.
            let mut name = def.base_name.clone();
            let mut i = 2;
            while tables.iter().any(|t| t.name() == name) {
                name = format!("{} ({})", def.base_name, i);
                i += 1;
            }
            let table = bi_engine::Table::new(name, dataset_columns(def.audience))
                .map_err(|e| format!("{}", e))?
                .with_storage_mode(bi_engine::StorageMode::InMemory)
                .with_source_binding(bi_engine::TableSourceBinding::new(
                    WRITEBACK_SOURCE_ID,
                    WRITEBACK_SCHEMA,
                    &def.region_id,
                ));
            tables.push(table);
        }

        let edited = base.with_tables(tables).with_sources(sources);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await?;

    // Wire the live connector and fetch the new tables' data.
    let engine_arc = {
        let conns = bi_state.connections.lock().map_err(|e| e.to_string())?;
        conns
            .get(&connection_id)
            .and_then(|c| c.engine.clone())
            .ok_or("No model loaded for this connection")?
    };
    let mut guard = engine_arc.lock().await;
    let report = ensure_writeback_source(&datasets, &mut guard).await;
    drop(guard);
    if !report.stale_bindings.is_empty() {
        eprintln!(
            "[writeback-bi] import left stale bindings: {}",
            report.stale_bindings.join("; ")
        );
    }

    Ok(overview)
}

/// Rebuild all writeback dataset data on every open connection (manual
/// refresh; the same routine runs automatically after submit/approve/pull).
#[tauri::command]
pub async fn bi_refresh_writeback_data(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    window: tauri::Window,
) -> Result<Vec<WritebackSourceReport>, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    Ok(refresh_writeback_sources(&state, &bi_state).await)
}

#[cfg(test)]
mod tests {
    //! The dataset encoder (value matrix, audience column sets) and the engine
    //! provisioning path (wire + bind + fetch, fail-closed reporting). The
    //! governance and carry-forward boundaries these datasets pass through are
    //! pinned separately (gather_governance_tests / merge_lenient_tests in
    //! calp_commands.rs) — datasets reuse those exact functions.
    use super::*;
    use arrow::array::Array;
    use calp::writeback::{
        RegionSelector, SubmissionState, SubmissionValue, WritebackRegionDeclaration,
        WritebackSubmission,
    };
    use calp::SubmitterIdentity;

    fn region(id: &str) -> WritebackRegionDeclaration {
        WritebackRegionDeclaration {
            id: id.to_string(),
            selector: RegionSelector {
                sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
                row_start: 1,
                row_end: 9,
                col_start: 1,
                col_end: 3,
            },
            mode: None,
            schema: None,
            visibility: None,
            submission_policy: None,
            version_binding: None,
            lifecycle: None,
            aggregation_hint: None,
            expected_respondents: Vec::new(),
            extra: std::collections::HashMap::new(),
        }
    }

    fn submission(
        submitter: &str,
        row: u32,
        col: u32,
        state: SubmissionState,
        value: SubmissionValue,
    ) -> WritebackSubmission {
        WritebackSubmission {
            model_key: None,
            id: format!("sub-{submitter}-{row}-{col}"),
            region_id: "r1".to_string(),
            cell_row: row,
            cell_col: col,
            cell_id: None,
            submitter: SubmitterIdentity {
                display_name: submitter.to_string(),
                id: format!("id-{submitter}"),
                extra: std::collections::HashMap::new(),
            },
            value,
            state,
            created_at: "2026-07-01T10:00:00Z".to_string(),
            updated_at: "2026-07-01T10:00:00Z".to_string(),
            submitted_at: Some("2026-07-01T10:00:00Z".to_string()),
            review_reason: Some("too high".to_string()),
            reviewed_by: Some("Publisher".to_string()),
            extra: std::collections::HashMap::new(),
        }
    }

    fn dataset(audience: WritebackAudience, rows: Vec<WritebackSubmission>) -> WritebackDataset {
        WritebackDataset {
            package_name: "budget-2026".to_string(),
            package_version: "1.2.0".to_string(),
            region: region("r1"),
            audience,
            display_name: "WB budget-2026 Sheet1!B2:D10".to_string(),
            sheet_name: "Sheet1".to_string(),
            range_ref: "B2:D10".to_string(),
            rows,
        }
    }

    // Publisher tables carry the review columns; subscriber tables must not
    // even have them (review free-text can identify people).
    #[test]
    fn audience_column_sets() {
        let publisher = dataset_columns(WritebackAudience::Publisher);
        let subscriber = dataset_columns(WritebackAudience::Subscriber);
        assert_eq!(publisher.len(), subscriber.len() + 2);
        assert!(publisher.iter().any(|c| c.name() == "reviewed_by"));
        assert!(publisher.iter().any(|c| c.name() == "review_reason"));
        assert!(!subscriber.iter().any(|c| c.name() == "reviewed_by"));
        assert!(!subscriber.iter().any(|c| c.name() == "review_reason"));
    }

    // The Arrow batch's column names must mirror the engine table definition
    // exactly, for BOTH audiences — a drift here is a fetch-time schema error.
    #[test]
    fn batch_schema_mirrors_table_columns() {
        for audience in [WritebackAudience::Publisher, WritebackAudience::Subscriber] {
            let ds = dataset(
                audience,
                vec![submission(
                    "alice",
                    1,
                    1,
                    SubmissionState::Submitted,
                    SubmissionValue::Number { value: 1.0 },
                )],
            );
            let batch = dataset_batch(&ds).unwrap();
            let batch_names: Vec<String> = batch
                .schema()
                .fields()
                .iter()
                .map(|f| f.name().clone())
                .collect();
            let col_names: Vec<String> = dataset_columns(audience)
                .iter()
                .map(|c| c.name().to_string())
                .collect();
            assert_eq!(batch_names, col_names);
        }
    }

    // Value encoding matrix: number fills value_number + rendered text;
    // text/boolean render into value_text with a null value_number; a
    // publisher-visible Empty is nulls, never a phantom zero.
    #[test]
    fn value_encoding_matrix() {
        let ds = dataset(
            WritebackAudience::Publisher,
            vec![
                submission("a", 1, 1, SubmissionState::Submitted, SubmissionValue::Number { value: 42.5 }),
                submission("b", 1, 2, SubmissionState::Approved, SubmissionValue::Text { value: "North".into() }),
                submission("c", 1, 3, SubmissionState::Rejected, SubmissionValue::Boolean { value: true }),
                submission("d", 2, 1, SubmissionState::Submitted, SubmissionValue::Empty),
            ],
        );
        let batch = dataset_batch(&ds).unwrap();
        let col = |name: &str| batch.column_by_name(name).unwrap().clone();
        let nums = col("value_number");
        let nums = nums.as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(nums.value(0), 42.5);
        assert!(nums.is_null(1) && nums.is_null(2) && nums.is_null(3));

        let texts = col("value_text");
        let texts = texts.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(texts.value(0), "42.5");
        assert_eq!(texts.value(1), "North");
        assert_eq!(texts.value(2), "TRUE");
        assert_eq!(texts.value(3), "");

        let kinds = col("value_kind");
        let kinds = kinds.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(
            (kinds.value(0), kinds.value(1), kinds.value(2), kinds.value(3)),
            ("number", "text", "boolean", "empty")
        );

        let states = col("state");
        let states = states.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(
            (states.value(0), states.value(1), states.value(2)),
            ("submitted", "approved", "rejected")
        );

        let refs = col("cell_ref");
        let refs = refs.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!((refs.value(0), refs.value(1)), ("B2", "C2"));
    }

    #[test]
    fn selector_and_name_helpers() {
        let r = region("r1");
        assert_eq!(selector_range_ref(&r.selector), "B2:D10");
        let mut single = r.selector.clone();
        single.row_end = single.row_start;
        single.col_end = single.col_start;
        assert_eq!(selector_range_ref(&single), "B2");

        // Sheet names are user text: forbidden identifier chars are stripped.
        assert_eq!(
            sanitize_table_name("WB pkg Q1/Q2!B2:D10"),
            "WB pkg Q1-Q2!B2:D10"
        );
        assert_eq!(sanitize_table_name("a[b]c;d"), "a-b-c-d");
        assert_eq!(sanitize_table_name("  \u{7} "), "WB dataset");
    }

    // End-to-end provisioning: a model carrying the catalog entry + a bound
    // table gets its connector wired, table re-bound, and data fetched; a
    // vanished region fails closed into the stale report; a model WITHOUT the
    // catalog entry is untouched.
    #[tokio::test]
    async fn provisioning_wires_binds_and_fetches() {
        let ds = dataset(
            WritebackAudience::Subscriber,
            vec![
                submission("a", 1, 1, SubmissionState::Submitted, SubmissionValue::Number { value: 1.0 }),
                submission("b", 1, 2, SubmissionState::Submitted, SubmissionValue::Number { value: 2.0 }),
            ],
        );

        let table = bi_engine::Table::new(
            ds.display_name.clone(),
            dataset_columns(WritebackAudience::Subscriber),
        )
        .unwrap()
        .with_storage_mode(bi_engine::StorageMode::InMemory)
        .with_source_binding(bi_engine::TableSourceBinding::new(
            WRITEBACK_SOURCE_ID,
            WRITEBACK_SCHEMA,
            "r1",
        ));
        let model = bi_engine::DataModel::builder()
            .add_source(bi_engine::PersistedSource::new(
                WRITEBACK_SOURCE_ID,
                bi_engine::SourceKind::InMemory,
                Default::default(),
                bi_engine::PersistedAuthKind::Integrated,
            ))
            .add_table(table)
            .build()
            .unwrap();
        let mut engine = bi_engine::Engine::new(model);

        let report = ensure_writeback_source(std::slice::from_ref(&ds), &mut engine).await;
        assert_eq!(report.refreshed_tables, vec![ds.display_name.clone()]);
        assert!(report.stale_bindings.is_empty());

        // Swap with new data (one more row) — same id, rebound, refetched.
        let mut ds2 = dataset(
            WritebackAudience::Subscriber,
            vec![
                submission("a", 1, 1, SubmissionState::Submitted, SubmissionValue::Number { value: 1.0 }),
                submission("b", 1, 2, SubmissionState::Submitted, SubmissionValue::Number { value: 2.0 }),
                submission("c", 1, 3, SubmissionState::Submitted, SubmissionValue::Number { value: 3.0 }),
            ],
        );
        ds2.display_name = ds.display_name.clone();
        let report = ensure_writeback_source(std::slice::from_ref(&ds2), &mut engine).await;
        assert_eq!(report.refreshed_tables.len(), 1);

        // Region vanished: the fetch fails closed into the stale report.
        let report = ensure_writeback_source(&[], &mut engine).await;
        assert!(report.refreshed_tables.is_empty());
        assert_eq!(report.stale_bindings.len(), 1);
        assert!(report.stale_bindings[0].starts_with(&ds.display_name));

        // A model with no catalog entry is a strict no-op.
        let mut plain = bi_engine::Engine::new(bi_engine::DataModel::builder().build().unwrap());
        let report = ensure_writeback_source(std::slice::from_ref(&ds), &mut plain).await;
        assert!(report.refreshed_tables.is_empty() && report.stale_bindings.is_empty());
    }
}
