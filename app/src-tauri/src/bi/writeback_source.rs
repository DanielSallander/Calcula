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
    merge_lenient_submissions, submission_state_str,
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

/// Where a dataset's region comes from, from this workbook's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatasetOrigin {
    /// One of this workbook's OWN regions (it published the application, or
    /// is a working copy of it): read through Writeback > Collect From, which
    /// may admit several streams, so the table carries an `environment` column.
    Author,
    /// A region of a SUBSCRIBED application: the subscription's one stream,
    /// with the schema it always had.
    Subscription,
}

/// One buildable dataset: a writeback region within a subscribed package,
/// with its submissions already merged (version carry-forward) and filtered
/// for this workbook's audience.
pub struct WritebackDataset {
    pub package_name: String,
    pub package_version: String,
    pub region: calp::WritebackRegionDeclaration,
    pub audience: WritebackAudience,
    pub origin: DatasetOrigin,
    /// Which streams the rows come from, for the import list ("prod",
    /// "every stream", "the development line, test").
    pub streams: String,
    /// A caveat the model table cannot show itself (newer versions whose
    /// answers could not be verified here). Empty when none.
    pub note: String,
    /// Suggested model-table name: `WB {package} {Sheet}!{A1:B4}`.
    pub display_name: String,
    pub sheet_name: String,
    pub range_ref: String,
    pub rows: Vec<calp::writeback::WritebackSubmission>,
    /// A SUBSCRIPTION view of a region the author pass ALSO serves (a publisher
    /// who subscribes to their own application from the same workbook). Never
    /// listed for import -- a new import gets the author table -- but kept so
    /// a model table imported BEFORE the author pass existed, with the
    /// subscription's columns, keeps reading the subscription's one stream
    /// with its own schema (`served_key`).
    pub shadow: bool,
}

/// The connector key a shadow (subscription) dataset is served under, beside
/// the author dataset that owns the region id.
pub(crate) const SUBSCRIPTION_VARIANT_SUFFIX: &str = "#subscription";

/// WHICH DATASET A BOUND MODEL TABLE READS. A region served by both passes is
/// keyed by its id for the AUTHOR dataset (the import default) and by
/// `{id}#subscription` for the subscription's. A table whose columns have no
/// `environment` column was imported with the subscription's schema: it keeps
/// the subscription's stream and columns, rather than silently switching to
/// the Collect From choice with a column it was never imported with.
pub(crate) fn served_key(region_id: &str, table_has_environment: bool, has_shadow: bool) -> String {
    if has_shadow && !table_has_environment {
        format!("{region_id}{SUBSCRIPTION_VARIANT_SUFFIX}")
    } else {
        region_id.to_string()
    }
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

/// The MODEL name an imported writeback table gets: letters, digits and `_`
/// only (`WB_writeback_test_Sheet1_2_B3_B5`). A measure names its table as a
/// bare identifier -- `SUM(WB_writeback_test_Sheet1_2_B3_B5[value_number])` --
/// and the measure language has no quoting, so the readable name
/// (`WB writeback-test Sheet1 (2)!B3:B5`, legal for the model's own validator)
/// could be imported but never referenced: no measure, so no pivot value, no
/// `bi_query` and no CUBE formula could read the table (BUG-0585). The
/// readable text stays the table's DISPLAY name. `.` is left out as well: a
/// dotted name reads as `schema.table` to the field-key splitter.
fn model_table_name(display: &str) -> String {
    let mut out = String::with_capacity(display.len());
    for c in display.chars() {
        if c.is_alphanumeric() || c == '_' {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_end_matches('_');
    match trimmed.chars().next() {
        None => "WB_dataset".to_string(),
        Some(first) if first.is_numeric() => format!("WB_{trimmed}"),
        Some(_) => trimmed.to_string(),
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
/// `build_gather_data`'s enumeration (same subscription skips, same
/// signature-verified manifests, same first-subscription-wins per region), so
/// the dataset tables and GATHER can never disagree about what exists.
///
/// ONE DELIBERATE DIVERGENCE: `rebuild_gather_cache` additionally skips HTTP
/// registries that are inside their unreachable-backoff window
/// (`GATHER_REGISTRY_BACKOFF`), because GATHER now rebuilds on a worker and must
/// not re-time-out against a dead host every couple of seconds. This path is
/// already asynchronous (`queue_model_writeback_refresh`), so it pays the
/// timeout without blocking anything and keeps the full walk. A GATHER cell can
/// therefore be briefly empty while the dataset table still resolves — same
/// declarations, different freshness. Do not "restore parity" by turning this
/// sentence into a test without carrying the backoff clause with it.
pub fn collect_writeback_datasets(state: &AppState) -> Vec<WritebackDataset> {
    let mut result: Vec<WritebackDataset> = Vec::new();
    let mut seen_regions: HashSet<String> = HashSet::new();

    // THE AUTHOR'S OWN REGIONS FIRST (open-items 2.am item 7), matching the
    // Collected Responses listing.
    collect_author_datasets(state, &mut result, &mut seen_regions);

    // The regions the author pass serves: a subscription that declares one of
    // them still builds its own view, as a SHADOW (`WritebackDataset::shadow`).
    let author_regions: HashSet<String> = seen_regions.clone();
    let subs = match state.subscriptions.read() {
        Ok(s) => s,
        Err(_) => return result,
    };
    let own_identity = get_subscriber_identity(state).ok();

    for sub in &subs.subscriptions {
        // Same skips as build_gather_data: dev and file-channel subscriptions
        // have no versioned submission tree.
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }
        // RAW `registry_url` — see the note in `bi/writeback.rs`. A local
        // `file://` strip here would scope the pin differently from the one
        // written at subscribe, and these datasets would silently disappear.
        let (registry, scope) =
            match crate::calp_registry::open_workspace_scoped(&sub.registry_url) {
                Ok(r) => r,
                Err(_) => continue,
            };

        // Region declarations MUST come from the signature-verified manifest —
        // they carry the governance policies enforced below.
        //
        // ALREADY-TRUSTED (RequirePinned): writeback datasets exposed as model
        // tables belong to packages the user subscribed to. Verifying no longer
        // pins, and the manifest-only return means the trust answer cannot be
        // discarded the way `Ok((_, m))` used to discard it.
        let ver_manifest = match calp::integrity::load_pinned_manifest_via(
            registry.as_ref(),
            &sub.package_name,
            &sub.resolved_version,
            &scope,
            &calcula_profile_dir(),
        ) {
            Ok(m) => m,
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

        // One tree scan for the resolved version (current/folded view),
        // bucketed by region.
        let mut current_by_region: HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
            HashMap::new();
        // See `bi/writeback.rs`: a dataset table built across environments puts
        // test values into production measures.
        let environment = sub.environment.clone().unwrap_or_default();
        // Only signed decisions count (identity phase 1), exactly as GATHER.
        let authority = crate::calp_commands::review_authority(
            registry.as_ref(),
            &sub.package_name,
            &ver_manifest.publisher_key,
            Some(&scope),
        );
        match registry
            .load_current_submissions(&sub.package_name, &sub.resolved_version, &authority)
            .map(|all| calp::writeback::visible_in(all, Some(&environment)))
        {
            Ok(all) => {
                // The reader's identity verdicts, exactly as GATHER attaches them.
                let all = crate::identity_verification::attested(
                    registry.as_ref(),
                    &sub.package_name,
                    &sub.resolved_version,
                    all,
                );
                for s in all {
                    current_by_region
                        .entry(s.region_id.clone())
                        .or_default()
                        .push(s);
                }
            }
            Err(_) => continue,
        }

        // The versions this stream ran before the current one, for lenient
        // carry-forward (verified the same way as the current version).
        //
        // NOT "strictly older" for an environment: a rollback makes the current
        // pointer LOWER than one it ran last week, and the semver rule would
        // drop the subscriber's own submissions the moment their environment
        // was rolled back.
        let older: Vec<(
            Vec<calp::WritebackRegionDeclaration>,
            HashMap<String, Vec<calp::writeback::WritebackSubmission>>,
        )> = crate::calp_commands::carry_forward_versions(
            registry.as_ref(),
            &sub.package_name,
            &sub.resolved_version,
            &environment,
        )
            .iter()
            .filter_map(|version| {
                let manifest = calp::integrity::load_pinned_manifest_via(
                    registry.as_ref(),
                    &sub.package_name,
                    version,
                    &scope,
                    &calcula_profile_dir(),
                )
                .ok()?;
                let mut by_region: HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
                    HashMap::new();
                for s in crate::identity_verification::attested(
                    registry.as_ref(),
                    &sub.package_name,
                    version,
                    calp::writeback::visible_in(
                        registry
                            .load_current_submissions(&sub.package_name, version, &authority)
                            .ok()?,
                        Some(&environment),
                    ),
                ) {
                    by_region.entry(s.region_id.clone()).or_default().push(s);
                }
                Some((manifest.writeback_regions.unwrap_or_default(), by_region))
            })
            .collect();

        for region in regions {
            // First subscription declaring a region wins, matching the submit
            // path and build_gather_data. A region the author pass already
            // serves is built as a shadow.
            let shadow = author_regions.contains(&region.id);
            if !shadow && !seen_regions.insert(region.id.clone()) {
                continue;
            }
            if shadow && !seen_regions.insert(format!("{}{SUBSCRIPTION_VARIANT_SUFFIX}", region.id)) {
                continue;
            }

            let submissions = current_by_region.remove(&region.id).unwrap_or_default();
            let submissions = merge_lenient_submissions(submissions, &older, &region);

            // The application's identity rule, from the same pinned manifest:
            // a model table counts exactly what GATHER counts.
            let identity_policy = ver_manifest.identity_policy.unwrap_or_default();
            let mut rows = match audience {
                // Subscriber rows pass the SAME governance boundary as GATHER:
                // the identity rule, approval gating, Draft/Rejected/Empty
                // drops, read-side schema + deadline integrity, visibility
                // masking/anonymization.
                WritebackAudience::Subscriber => {
                    apply_gather_governance(submissions, &region, own_identity.as_ref(), &identity_policy)
                }
                // Publisher sees everything (including Rejected — review
                // analytics); their registry, their data -- but only the
                // answers the application's identity rule COUNTS.
                WritebackAudience::Publisher => calp::identity_check::admit(submissions, &identity_policy),
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
                origin: DatasetOrigin::Subscription,
                streams: calp::writeback::stream_label(&environment),
                note: String::new(),
                display_name,
                sheet_name,
                range_ref,
                rows,
                shadow,
            });
        }
    }

    result
}

/// THE AUTHOR PASS: every one of this workbook's own regions that Collected
/// Responses lists as READY (resolved through the linked application AND past
/// the publisher gate) becomes a PUBLISHER dataset, built from THE SAME ROWS
/// the pane, the exports and scripts read (`load_region_current_submissions`
/// through the workbook's Collect From choice, compatibility rule included).
/// So a model table and Collected Responses can never disagree, and a model
/// table never collects a stream the publisher did not choose: the default is
/// the pipeline's LAST environment, never "every stream" (owner, 2026-10-22).
///
/// Never built for a computer that is not a publisher of the application: an
/// author region has no governed subscriber view, so it is simply absent.
fn collect_author_datasets(
    state: &AppState,
    result: &mut Vec<WritebackDataset>,
    seen_regions: &mut HashSet<String>,
) {
    // ONE workspace walk and one gate per key for every own region (the
    // listing's author half, not its subscriber half), the rows read through
    // the walk's opened workspace -- this runs from the import list and the
    // freshness poll, and used to re-walk the whole workspace per region.
    let (walk, ready) = match crate::calp_collection::ready_author_collections(state) {
        Ok(Some(found)) => found,
        Ok(None) => return,
        Err(e) => {
            eprintln!("[writeback-bi] the author's regions could not be listed: {e}");
            return;
        }
    };
    let Some(registry) = walk.registry() else {
        return;
    };
    for (collection, sheet_name) in ready {
        let region_id = collection.declaration.id.clone();
        let submissions = match crate::calp_commands::load_region_current_submissions(
            &collection,
            registry,
            &region_id,
            &collection.streams,
        ) {
            Ok(s) => s,
            // Every version unreadable: no dataset, so a bound table lands in
            // `stale_bindings` (the existing failure surface) instead of
            // reporting an empty region.
            Err(e) => {
                eprintln!("[writeback-bi] author region '{}' could not be read: {e}", region_id);
                continue;
            }
        };
        if !seen_regions.insert(region_id.clone()) {
            continue;
        }
        let mut rows = submissions;
        rows.sort_by(|a, b| {
            a.cell_row
                .cmp(&b.cell_row)
                .then(a.cell_col.cmp(&b.cell_col))
                .then(a.environment.cmp(&b.environment))
                .then(a.submitter.id.cmp(&b.submitter.id))
        });
        let sheet_name = sheet_name.unwrap_or_else(|| "Sheet".to_string());
        let range_ref = selector_range_ref(&collection.declaration.selector);
        let display_name =
            sanitize_table_name(&format!("WB {} {}!{}", collection.package_name, sheet_name, range_ref));
        if !collection.note.is_empty() {
            eprintln!("[writeback-bi] author region '{}': {}", region_id, collection.note);
        }
        result.push(WritebackDataset {
            package_name: collection.package_name.clone(),
            package_version: collection.read_version.clone(),
            region: collection.declaration.clone(),
            audience: WritebackAudience::Publisher,
            origin: DatasetOrigin::Author,
            streams: collection.streams.label(),
            note: collection.note.clone(),
            display_name,
            sheet_name,
            range_ref,
            rows,
            shadow: false,
        });
    }
}

// ---------------------------------------------------------------------------
// Arrow encoding
// ---------------------------------------------------------------------------

/// Engine column definitions for a dataset table. Review fields only exist on
/// publisher-audience tables — a subscriber table must not even have the
/// columns (empty values would still invite "why is it blank" questions, and a
/// carelessly widened batch would then fail the schema instead of leaking).
///
/// The `environment` column exists only on AUTHOR tables (the workbook's own
/// regions, read through Writeback > Collect From, which may admit several
/// streams): a measure slices by it. A subscribed region's table is one stream
/// and keeps the schema it always had, so a table imported before this column
/// existed still refreshes.
fn dataset_columns(audience: WritebackAudience, origin: DatasetOrigin) -> Vec<bi_engine::Column> {
    use bi_engine::{Column, DataType};
    let mut cols = vec![
        Column::new("submission_id", DataType::String),
        Column::new("package_name", DataType::String),
        Column::new("package_version", DataType::String),
        Column::new("region_id", DataType::String),
    ];
    if origin == DatasetOrigin::Author {
        cols.push(Column::new("environment", DataType::String).with_description(
            "The stream each answer was sent in: empty = the development line, otherwise the \
             environment. Which streams this table collects is chosen in Writeback > Collect From \
             (default: the pipeline's last environment).",
        ));
    }
    cols.extend([
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
    ]);
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
    ];
    let mut arrays: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from(submission_id)),
        Arc::new(StringArray::from(vec![ds.package_name.clone(); n])),
        Arc::new(StringArray::from(vec![ds.package_version.clone(); n])),
        Arc::new(StringArray::from(vec![ds.region.id.clone(); n])),
    ];
    if ds.origin == DatasetOrigin::Author {
        // Mirrors `dataset_columns`: only the author's tables carry the stream.
        fields.push(Field::new("environment", ArrowDataType::Utf8, true));
        arrays.push(Arc::new(StringArray::from(
            ds.rows.iter().map(|s| s.environment.clone()).collect::<Vec<String>>(),
        )));
    }
    fields.extend([
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
    ]);
    arrays.extend::<[ArrayRef; 11]>([
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
    ]);
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
    let shadowed: HashSet<String> = datasets.iter().filter(|d| d.shadow).map(|d| d.region.id.clone()).collect();
    for ds in datasets {
        let key = if ds.shadow {
            format!("{}{SUBSCRIPTION_VARIANT_SUFFIX}", ds.region.id)
        } else {
            ds.region.id.clone()
        };
        match dataset_batch(ds) {
            Ok(batch) => {
                connector = connector.with_table(WRITEBACK_SCHEMA, key, batch);
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
    let bound: Vec<(String, String, bool)> = engine
        .model()
        .tables()
        .iter()
        .filter_map(|t| {
            t.source_binding().filter(|b| b.source_id == WRITEBACK_SOURCE_ID).map(|b| {
                let has_environment = t.columns().iter().any(|c| c.name() == "environment");
                (t.name().to_string(), b.table.clone(), has_environment)
            })
        })
        .collect();

    for (table_name, region_id, has_environment) in bound {
        let key = served_key(&region_id, has_environment, shadowed.contains(&region_id));
        if key != region_id {
            eprintln!(
                "[writeback-bi] '{table_name}' was imported from the subscription (no environment column): \
                 it keeps reading the subscription's stream; import the region again for the Collect From choice"
            );
        }
        engine.registry_mut().bind(
            table_name.clone(),
            idx,
            bi_engine::SourceBinding::new(WRITEBACK_SCHEMA, &key),
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
    // What this rebuild serves is what the freshness poll compares against: an
    // invalidation-driven rebuild records it too, so the next poll does not
    // rebuild the very same rows again.
    datasets_changed_since_last_poll(&datasets);
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
/// `run()` right after the Tauri app is built. Also starts the freshness poll
/// ([`WRITEBACK_BI_POLL`]).
pub fn set_app_handle(app: tauri::AppHandle) {
    if WRITEBACK_BI_APP.set(app.clone()).is_ok() {
        start_writeback_bi_poll(app);
    }
}

// ---------------------------------------------------------------------------
// Freshness: answers arrive from OTHER computers
// ---------------------------------------------------------------------------
//
// `invalidate_writeback_bi` fires on THIS process's mutations (submit, review,
// pull, open, Collect From). A subscriber submits by appending to the
// workspace from their own machine, which no event here sees -- so without
// the two triggers below, an author's model table showed the answers it had
// when it was last rebuilt, while Collected Responses showed the new ones.
//
// 1. A publisher read (the pane, the submission watch, a script) that sees an
//    author region's rows CHANGE invalidates at once (`note_author_rows_seen`).
// 2. While some open model carries writeback tables, a background thread
//    re-reads the datasets every `WRITEBACK_BI_POLL` and rebuilds only when
//    they changed (`datasets_changed_since_last_poll`).

/// How often the freshness poll re-reads the datasets while some open model
/// carries writeback tables (and only then).
pub const WRITEBACK_BI_POLL: std::time::Duration = std::time::Duration::from_secs(60);

/// region key -> fingerprint of the rows a publisher read last saw.
static AUTHOR_ROWS_SEEN: std::sync::OnceLock<std::sync::Mutex<HashMap<String, u64>>> = std::sync::OnceLock::new();
/// Fingerprint of the datasets the last poll saw.
static LAST_POLLED_DATASETS: std::sync::Mutex<Option<u64>> = std::sync::Mutex::new(None);

/// A fingerprint of a set of rows: which records, in which state, as of when,
/// under which stream choice. Order-independent.
pub(crate) fn rows_fingerprint(streams: &str, rows: &[calp::writeback::WritebackSubmission]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut keys: Vec<(&str, &str, &str, u32, u32, &str, &str)> = rows
        .iter()
        .map(|s| {
            (
                s.environment.as_str(),
                s.submitter.id.as_str(),
                s.id.as_str(),
                s.cell_row,
                s.cell_col,
                submission_state_str(&s.state),
                s.updated_at.as_str(),
            )
        })
        .collect();
    keys.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    streams.hash(&mut h);
    keys.hash(&mut h);
    h.finish()
}

/// A publisher read saw `rows` for one of the author's regions: when they
/// differ from what the last read saw (new answers from another computer, a
/// review, another stream choice), rebuild the BI datasets. Returns whether it
/// did.
pub(crate) fn note_author_rows_seen(
    collection: &crate::calp_collection::RegionCollection,
    region_id: &str,
    rows: &[calp::writeback::WritebackSubmission],
) -> bool {
    let key = format!("{}|{}|{}", collection.registry_path, collection.package_name, region_id);
    let fingerprint = rows_fingerprint(&collection.streams.label(), rows);
    let changed = match AUTHOR_ROWS_SEEN.get_or_init(Default::default).lock() {
        Ok(mut seen) => seen.insert(key, fingerprint) != Some(fingerprint),
        Err(_) => true,
    };
    if changed {
        invalidate_writeback_bi();
    }
    changed
}

/// Whether `datasets` differ from what the previous poll saw (the first poll
/// always differs). Records them as seen.
pub(crate) fn datasets_changed_since_last_poll(datasets: &[WritebackDataset]) -> bool {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for ds in datasets {
        ds.region.id.hash(&mut h);
        ds.package_version.hash(&mut h);
        rows_fingerprint(&ds.streams, &ds.rows).hash(&mut h);
    }
    let fingerprint = h.finish();
    match LAST_POLLED_DATASETS.lock() {
        Ok(mut last) => last.replace(fingerprint) != Some(fingerprint),
        Err(_) => true,
    }
}

/// Whether some open model carries the writeback source. An engine busy with a
/// query counts as carrying it (the poll then reads; it never waits on one).
fn any_engine_wired(bi_state: &BiState) -> bool {
    let engines: Vec<Arc<tokio::sync::Mutex<bi_engine::Engine>>> = match bi_state.connections.lock() {
        Ok(conns) => conns.values().filter_map(|c| c.engine.clone()).collect(),
        Err(_) => return false,
    };
    engines.iter().any(|engine| match engine.try_lock() {
        Ok(guard) => guard.model().source(WRITEBACK_SOURCE_ID).is_some(),
        Err(_) => true,
    })
}

/// The freshness poll's thread. A plain thread, not a runtime task: it reads
/// the workspace synchronously and must never hold an async worker.
fn start_writeback_bi_poll(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new().name("writeback-bi-poll".to_string()).spawn(move || loop {
        std::thread::sleep(WRITEBACK_BI_POLL);
        let wired = {
            let bi_state = app.state::<BiState>();
            any_engine_wired(&bi_state)
        };
        if !wired {
            continue;
        }
        let datasets = {
            let state = app.state::<AppState>();
            collect_writeback_datasets(&state)
        };
        if datasets_changed_since_last_poll(&datasets) {
            invalidate_writeback_bi();
        }
    });
    if let Err(e) = spawned {
        eprintln!("[writeback-bi] the freshness poll could not start: {e}");
    }
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
    /// Which streams the table collects ("prod", "every stream", ...): for
    /// the workbook's own regions the Writeback > Collect From choice, for a
    /// subscribed region its subscription's stream.
    pub streams: String,
    /// A caveat the table cannot show (newer versions whose answers could not
    /// be verified here). Empty when none.
    pub note: String,
    /// Whether the given connection's model already has a table bound to this
    /// region (false when no connection was passed).
    pub already_imported: bool,
}

/// List every writeback dataset this workbook can import. Pure registry I/O;
/// no engine mutation. ASYNC: it reads the workspace (every subscribed
/// application and the linked one), and a slow or unreachable share must never
/// freeze the window.
#[tauri::command(async)]
pub fn bi_list_writeback_tables(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
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
        // A shadow is never offered: a new import gets the author table.
        .filter(|ds| !ds.shadow)
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
            streams: ds.streams,
            note: ds.note,
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
        origin: DatasetOrigin,
    }
    let defs: Vec<ImportDef> = region_ids
        .iter()
        .map(|rid| {
            datasets
                .iter()
                .find(|d| &d.region.id == rid && !d.shadow)
                .map(|d| ImportDef {
                    region_id: d.region.id.clone(),
                    base_name: d.display_name.clone(),
                    audience: d.audience,
                    origin: d.origin,
                })
                .ok_or_else(|| format!("Writeback region '{rid}' not found among this workbook's writeback regions"))
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
            // Dedupe the table's model name (one a measure can reference);
            // the region UUID in the binding is the real key, and the
            // readable dataset name is the display name.
            let base_name = model_table_name(&def.base_name);
            let mut name = base_name.clone();
            let mut i = 2;
            while tables.iter().any(|t| t.name().eq_ignore_ascii_case(&name)) {
                name = format!("{base_name}_{i}");
                i += 1;
            }
            let mut table = bi_engine::Table::new(name, dataset_columns(def.audience, def.origin))
                .map_err(|e| format!("{}", e))?
                .with_storage_mode(bi_engine::StorageMode::InMemory)
                .with_source_binding(bi_engine::TableSourceBinding::new(
                    WRITEBACK_SOURCE_ID,
                    WRITEBACK_SCHEMA,
                    &def.region_id,
                ));
            table.set_display_name(Some(def.base_name.clone()));
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
///
/// DIRTY FLAG: deliberately none (census "mutates-document" reclassified to read-only).
/// `refresh_writeback_sources` re-provisions the ENGINE's in-memory writeback connectors
/// from submissions that are already persisted; it writes no `AppState` store that the
/// save path reads (it touches only `bi_state.connections`). Nothing it does changes what
/// a save would write, so marking here would dirty a workbook on a refresh that cannot
/// be lost -- and this runs on connect, which would make merely opening a subscribed
/// workbook prompt to save. The commands that CREATE submissions own the flag.
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
            environment: String::new(),
            model_key: None,
            id: format!("sub-{submitter}-{row}-{col}"),
            region_id: "r1".to_string(),
            cell_row: row,
            cell_col: col,
            cell_id: None,
            submitter: SubmitterIdentity {
                display_name: submitter.to_string(),
                id: format!("id-{submitter}"),
                principal_name: String::new(),
                provider: Default::default(),
                scope: Default::default(),
                extra: std::collections::HashMap::new(),
            },
            value,
            state,
            created_at: "2026-07-01T10:00:00Z".to_string(),
            updated_at: "2026-07-01T10:00:00Z".to_string(),
            submitted_at: Some("2026-07-01T10:00:00Z".to_string()),
            review_reason: Some("too high".to_string()),
            reviewed_by: Some("Publisher".to_string()),
            seal: None,
            sender: Default::default(),
            identity: Default::default(),
            extra: std::collections::HashMap::new(),
        }
    }

    fn dataset(audience: WritebackAudience, rows: Vec<WritebackSubmission>) -> WritebackDataset {
        WritebackDataset {
            package_name: "budget-2026".to_string(),
            package_version: "1.2.0".to_string(),
            region: region("r1"),
            audience,
            origin: DatasetOrigin::Subscription,
            streams: "the development line".to_string(),
            note: String::new(),
            display_name: "WB budget-2026 Sheet1!B2:D10".to_string(),
            sheet_name: "Sheet1".to_string(),
            range_ref: "B2:D10".to_string(),
            rows,
            shadow: false,
        }
    }

    /// A TABLE IMPORTED FROM THE SUBSCRIPTION KEEPS ITS STREAM AND SCHEMA when
    /// the author pass also serves its region: it is served the subscription's
    /// dataset (no `environment` column) under the shadow key, never the
    /// author's batch with a column it was not imported with. A table imported
    /// with the author's columns, or a region with no shadow, reads the
    /// region id.
    ///
    /// SABOTAGE: make `served_key` always return the region id.
    #[test]
    fn a_table_imported_from_the_subscription_keeps_reading_it() {
        assert_eq!(served_key("r1", false, true), format!("r1{SUBSCRIPTION_VARIANT_SUFFIX}"));
        assert_eq!(served_key("r1", true, true), "r1");
        assert_eq!(served_key("r1", false, false), "r1");
        // The two schemas really differ by that column.
        let author = dataset_columns(WritebackAudience::Publisher, DatasetOrigin::Author);
        let subscription = dataset_columns(WritebackAudience::Publisher, DatasetOrigin::Subscription);
        assert!(author.iter().any(|c| c.name() == "environment"));
        assert!(!subscription.iter().any(|c| c.name() == "environment"));
    }

    // Publisher tables carry the review columns; subscriber tables must not
    // even have them (review free-text can identify people).
    #[test]
    fn audience_column_sets() {
        let publisher = dataset_columns(WritebackAudience::Publisher, DatasetOrigin::Subscription);
        let subscriber = dataset_columns(WritebackAudience::Subscriber, DatasetOrigin::Subscription);
        assert_eq!(publisher.len(), subscriber.len() + 2);
        assert!(publisher.iter().any(|c| c.name() == "reviewed_by"));
        assert!(publisher.iter().any(|c| c.name() == "review_reason"));
        assert!(!subscriber.iter().any(|c| c.name() == "reviewed_by"));
        assert!(!subscriber.iter().any(|c| c.name() == "review_reason"));
    }

    /// THE AUTHOR'S TABLE CARRIES THE STREAM; a subscribed region's does not.
    ///
    /// The author's table follows Writeback > Collect From, which may admit
    /// several streams, so a measure must be able to slice by stream. A
    /// subscribed region's table is one stream and keeps the schema it always
    /// had -- widening it would make every table imported before this change
    /// fail its refresh.
    ///
    /// SABOTAGE: push the `environment` column for every origin.
    #[test]
    fn only_the_authors_table_carries_the_environment_column() {
        let author = dataset_columns(WritebackAudience::Publisher, DatasetOrigin::Author);
        let subscribed = dataset_columns(WritebackAudience::Publisher, DatasetOrigin::Subscription);
        assert!(author.iter().any(|c| c.name() == "environment"));
        assert!(!subscribed.iter().any(|c| c.name() == "environment"));
        assert_eq!(author.len(), subscribed.len() + 1);

        let mut prod = submission("alice", 1, 1, SubmissionState::Submitted, SubmissionValue::Number { value: 1.0 });
        prod.environment = "prod".to_string();
        let line = submission("bob", 1, 2, SubmissionState::Submitted, SubmissionValue::Number { value: 2.0 });
        let mut ds = dataset(WritebackAudience::Publisher, vec![prod, line]);
        ds.origin = DatasetOrigin::Author;
        let batch = dataset_batch(&ds).unwrap();
        let env = batch.column_by_name("environment").expect("the stream column").clone();
        let env = env.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!((env.value(0), env.value(1)), ("prod", ""));
    }

    // The Arrow batch's column names must mirror the engine table definition
    // exactly, for BOTH audiences and BOTH origins — a drift here is a
    // fetch-time schema error.
    #[test]
    fn batch_schema_mirrors_table_columns() {
        for audience in [WritebackAudience::Publisher, WritebackAudience::Subscriber] {
            for origin in [DatasetOrigin::Author, DatasetOrigin::Subscription] {
                let mut ds = dataset(
                    audience,
                    vec![submission(
                        "alice",
                        1,
                        1,
                        SubmissionState::Submitted,
                        SubmissionValue::Number { value: 1.0 },
                    )],
                );
                ds.origin = origin;
                let batch = dataset_batch(&ds).unwrap();
                let batch_names: Vec<String> = batch
                    .schema()
                    .fields()
                    .iter()
                    .map(|f| f.name().clone())
                    .collect();
                let col_names: Vec<String> = dataset_columns(audience, origin)
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect();
                assert_eq!(batch_names, col_names);
            }
        }
    }

    /// The freshness triggers rebuild only when the rows CHANGED: a new answer
    /// (from any computer), a review, or another stream choice. Re-reading the
    /// same rows is not a change.
    ///
    /// SABOTAGE: make `rows_fingerprint` ignore `updated_at` and `state` -- a
    /// review is no longer seen as a change.
    #[test]
    fn the_freshness_fingerprint_sees_new_answers_reviews_and_choices() {
        let a = submission("alice", 1, 1, SubmissionState::Submitted, SubmissionValue::Number { value: 1.0 });
        let b = submission("bob", 1, 2, SubmissionState::Submitted, SubmissionValue::Number { value: 2.0 });
        let base = rows_fingerprint("prod", &[a.clone(), b.clone()]);
        assert_eq!(base, rows_fingerprint("prod", &[b.clone(), a.clone()]), "order does not matter");
        assert_ne!(base, rows_fingerprint("prod", &[a.clone()]), "a new answer is a change");
        let mut reviewed = a.clone();
        reviewed.state = SubmissionState::Approved;
        reviewed.updated_at = "2026-07-02T10:00:00Z".to_string();
        assert_ne!(base, rows_fingerprint("prod", &[reviewed, b.clone()]), "a review is a change");
        assert_ne!(base, rows_fingerprint("every stream", &[a, b]), "another choice is a change");
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

    /// BUG-0585 (found live 2026-10-22): an imported writeback table must be a
    /// table a MEASURE can name. Its readable name -- spaces, '-', '!', ':',
    /// '(' -- parsed as anything but a table, so no measure, pivot value,
    /// `bi_query` or CUBE formula could ever read the table it imported.
    ///
    /// SABOTAGE: make `model_table_name` return `display.to_string()`.
    #[test]
    fn an_imported_writeback_table_is_named_so_a_measure_can_reference_it() {
        let cases = [
            ("WB writeback-test Sheet1 (2)!B3:B5", "WB_writeback_test_Sheet1_2_B3_B5"),
            ("WB pkg Q1-Q2!B2:D10", "WB_pkg_Q1_Q2_B2_D10"),
            ("WB budget.2026 Försäljning!A1", "WB_budget_2026_Försäljning_A1"),
            ("  !! ", "WB_dataset"),
            ("2026 plan", "WB_2026_plan"),
        ];
        for (display, model) in cases {
            let name = model_table_name(display);
            assert_eq!(name, model, "{display}");
            let formula = format!("SUM({name}[value_number])");
            let parsed = bi_engine::parse_measure_expression(&formula);
            assert!(parsed.is_ok(), "a measure cannot name the table {name}: {:?}", parsed.err());
            let text = format!("{:?}", parsed.unwrap());
            assert!(text.contains(&format!("\"{name}\"")), "the measure does not reference the table {name}: {text}");
        }
        // Why: the readable name is not a table reference in the measure language.
        let readable = format!("SUM({}[value_number])", "WB writeback-test Sheet1 (2)!B3:B5");
        let parsed = bi_engine::parse_measure_expression(&readable);
        assert!(
            parsed.as_ref().map_or(true, |e| !format!("{e:?}").contains("WB writeback-test")),
            "the measure language now reads a readable table name; this name rule may be relaxed: {parsed:?}"
        );
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
            dataset_columns(WritebackAudience::Subscriber, DatasetOrigin::Subscription),
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
