//! FILENAME: app/src-tauri/src/calp_diff.rs
//! PURPOSE: The Tauri surface of the version diff engine.
//! CONTEXT: Three commands, and the split between them is about WHERE the two
//! sides come from:
//!
//! * `calp_diff_versions` / `calp_diff_sheet_cells` — two PUBLISHED versions.
//!   Read-only, available to the Package Inspector window.
//! * `calp_diff_working_copy` — the open workbook against the version it was
//!   authored from. Main window only, because it reads the live document.
//!
//! **Verification posture: the inspector's, unchanged.** Both published sides
//! go through `open_verified_content` with the full per-artifact SHA-256 walk
//! before a byte is compared. A diff is a content-surfacing operation, and a
//! diff row backed by unverified bytes, shown under a window that says
//! "verified", is exactly the confusion the inspector's own header warns about.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use tauri::State;

use calp::diff::{DiffOptions, DiffSide, SheetCellDiff, VersionDiff};
use calp::transport::WorkspaceTransport;

use crate::bi::types::BiState;
use crate::AppState;

// ---------------------------------------------------------------------------
// Two published versions
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffVersionsParams {
    pub registry_path: String,
    pub package_name: String,
    pub from_version: String,
    pub to_version: String,
}

/// What changed between two published versions of a package.
#[tauri::command]
pub fn calp_diff_versions(
    params: DiffVersionsParams,
    window: tauri::Window,
) -> Result<VersionDiff, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_APPLICATION_INSPECTOR,
    )?;

    let (from_registry, from_version, from_manifest) = crate::calp_inspector::open_verified_content(
        &params.registry_path,
        &params.package_name,
        &params.from_version,
        true,
    )?;
    let (to_registry, to_version, to_manifest) = crate::calp_inspector::open_verified_content(
        &params.registry_path,
        &params.package_name,
        &params.to_version,
        true,
    )?;

    calp::diff::diff_sides(
        &DiffSide::Published {
            transport: &from_registry,
            package: &params.package_name,
            version: &from_version,
            manifest: &from_manifest,
        },
        &DiffSide::Published {
            transport: &to_registry,
            package: &params.package_name,
            version: &to_version,
            manifest: &to_manifest,
        },
        &DiffOptions::default(),
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSheetCellsParams {
    pub registry_path: String,
    pub package_name: String,
    pub from_version: String,
    pub to_version: String,
    /// The PACKAGE sheet id, as the summary reported it.
    pub sheet_id: String,
    #[serde(default)]
    pub max_cells: Option<usize>,
}

/// Every changed cell of one sheet, for the drill-down.
#[tauri::command]
pub fn calp_diff_sheet_cells(
    params: DiffSheetCellsParams,
    window: tauri::Window,
) -> Result<SheetCellDiff, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_APPLICATION_INSPECTOR,
    )?;

    // The cap is the caller's, bounded by ours. A drill-down is a table a
    // person scrolls; past this it is a data export, and the summary's
    // `totalChanges` already tells them how much they are not seeing.
    const DEFAULT_MAX: usize = 5_000;
    const HARD_MAX: usize = 20_000;
    let max_cells = params.max_cells.unwrap_or(DEFAULT_MAX).min(HARD_MAX);

    let (from_registry, from_version, from_manifest) = crate::calp_inspector::open_verified_content(
        &params.registry_path,
        &params.package_name,
        &params.from_version,
        true,
    )?;
    let (to_registry, to_version, to_manifest) = crate::calp_inspector::open_verified_content(
        &params.registry_path,
        &params.package_name,
        &params.to_version,
        true,
    )?;

    calp::diff::diff_sheet_cells(
        &DiffSide::Published {
            transport: &from_registry,
            package: &params.package_name,
            version: &from_version,
            manifest: &from_manifest,
        },
        &DiffSide::Published {
            transport: &to_registry,
            package: &params.package_name,
            version: &to_version,
            manifest: &to_manifest,
        },
        &params.sheet_id,
        max_cells,
        &HashMap::new(),
    )
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// The working copy against its base
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffWorkingCopyParams {
    /// Omit to read the target from the workbook's own workspace link, which is
    /// what the push dialog does.
    #[serde(default)]
    pub registry_path: Option<String>,
    #[serde(default)]
    pub package_name: Option<String>,
    /// The version to compare against. Defaults to the link's base version.
    #[serde(default)]
    pub base_version: Option<String>,
    /// Sheets the comparison should cover. Empty = the same default a publish
    /// would take.
    ///
    /// FOR A SUBSCRIBER DIFF THIS MUST BE EXPLICIT, and the command refuses
    /// otherwise. "The publish default" for a workbook that subscribes is *every
    /// user sheet MINUS the subscribed ones* — the exact inverse of what a
    /// "compare my subscribed sheets against the published version" request
    /// means. The refusal is deliberate rather than a silent substitution: the
    /// scope of a diff shown before a destructive act must be visible at the
    /// call site.
    #[serde(default)]
    pub sheet_indices: Option<Vec<usize>>,
    #[serde(default)]
    pub include_comments: bool,
    /// Keep only these APPLICATION sheet ids in the result, and recompute the
    /// totals over what survives.
    ///
    /// A subscriber's diff otherwise reports two changes a reset will never
    /// make. A sheet DETACHED from the application is gone from the ledger but
    /// still in the published manifest, so it reads as `removed` — while
    /// `calp_reset_subscription` skips it, because it resolves targets through
    /// the ledger. And a floating range the subscriber added to a subscribed
    /// sheet drags its LOCAL backing sheet into the publish assembly, where it
    /// is absent from the base manifest and reads as `added`.
    ///
    /// Both are the same class of lie: the preview naming a sheet the act does
    /// not touch. `None` leaves the diff whole, which is what the push preview
    /// wants — there, every sheet in the link's base_sheets IS in scope.
    #[serde(default)]
    pub scope_sheet_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyDiff {
    pub package_name: String,
    pub base_version: String,
    pub diff: VersionDiff,
}

/// What this workbook's next push would change.
///
/// The working-copy side is produced by running the REAL `publish()` against an
/// in-memory registry. That is the entire trick, and it is deliberate: a
/// purpose-built "serialize the workbook for diffing" path would be a second
/// definition of what a package contains, and it would drift from the true one
/// the first time somebody added an artifact type. Here the preview and the
/// push are the same code, so they cannot disagree.
///
/// Cost: one extra full serialization per preview, entirely in memory.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn calp_diff_working_copy(
    state: State<AppState>,
    bi_state: State<BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    params: DiffWorkingCopyParams,
    window: tauri::Window,
) -> Result<WorkingCopyDiff, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // Resolve the target from the link unless the caller overrode it.
    let link = state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    let registry_path = params
        .registry_path
        .clone()
        .or_else(|| link.as_ref().map(|l| l.registry_url.clone()))
        .ok_or_else(|| {
            "This workbook is not a working copy of any package, so there is nothing to \
             compare it against."
                .to_string()
        })?;
    let package_name = params
        .package_name
        .clone()
        .or_else(|| link.as_ref().map(|l| l.package_name.clone()))
        .ok_or_else(|| "No package to compare against.".to_string())?;
    let base_version = params
        .base_version
        .clone()
        .or_else(|| link.as_ref().map(|l| l.base_version.clone()))
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "No base version to compare against.".to_string())?;

    // The base side, through the same verification every content read uses.
    let (base_registry, base_version, base_manifest) = crate::calp_inspector::open_verified_content(
        &registry_path,
        &package_name,
        &format!("={base_version}"),
        true,
    )?;

    // A SUBSCRIBER DIFF MUST NAME ITS SHEETS. An empty `sheet_indices` means
    // "the publish default", and for a workbook that subscribes to this
    // application that default is *every user sheet MINUS the subscribed ones* —
    // the exact inverse of "compare my subscribed sheets against the published
    // version". The preview would then describe sheets the reset does not touch
    // and omit every sheet it does.
    //
    // THE GUARD DOES NOT LOOK AT THE LINK, deliberately. A workbook can be the
    // working copy of application X *and* a subscriber of application Y at the
    // same time — that is a first-class state since checkout became additive,
    // and it is exactly the configuration this feature creates by putting reset,
    // view-changes and push on one tab menu. A `link.is_none()` test would sail
    // past for such a workbook and hand it X's base_sheets for a diff of Y.
    // What matters is only whether THIS application is subscribed.
    //
    // A refusal, never a silent substitution: filling in the tracked indices
    // here would hide a caller bug and make the scope of a diff shown before a
    // destructive act invisible at the call site.
    if params.sheet_indices.as_ref().is_none_or(|v| v.is_empty())
        && !subscription_sheet_map(&state, &package_name)?.is_empty()
    {
        return Err(format!(
            "CALP_DIFF_NEEDS_SHEETS: This workbook SUBSCRIBES to '{}', so a comparison \
             must name the sheets it covers. Without them the diff would describe \
             every sheet you own EXCEPT the subscribed ones, which is the opposite \
             of what was asked.",
            package_name
        ));
    }

    // The working-copy side: a real publish into memory.
    let memory = calp::MemoryWorkspace::new();
    let working_version = calp::SemVer::new(0, 0, 0);
    crate::calp_commands::publish_into_for_preview(
        &state,
        &bi_state,
        &pivot_state,
        &script_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &user_files_state,
        &timeline_slicer_state,
        &memory,
        &registry_path,
        &package_name,
        working_version.clone(),
        // From the link, so a LIBRARY working copy diffs the same zero sheets a
        // real library push would ship rather than its author's whole workbook.
        link.as_ref().map(|l| l.kind.as_str()).unwrap_or(""),
        params.sheet_indices.clone().unwrap_or_default(),
        params.include_comments,
    )?;
    let working_version_str = working_version.to_string();
    let working_manifest = memory
        .get_version_manifest(&package_name, &working_version_str)
        .map_err(|e| e.to_string())?;
    let artifacts: BTreeMap<String, Vec<u8>> =
        memory.artifacts_of(&package_name, &working_version_str);

    // A workbook that SUBSCRIBED to this package carries its own local sheet
    // ids; without the remap every sheet would read as removed-and-added. A
    // checked-out working copy needs no map — its ids ARE the package's.
    let sheet_id_map = subscription_sheet_map(&state, &package_name)?;

    let diff = calp::diff::diff_sides(
        &DiffSide::Published {
            transport: &base_registry,
            package: &package_name,
            version: &base_version,
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &working_manifest, artifacts: &artifacts },
        &DiffOptions { sheet_id_map, ..DiffOptions::default() },
    )
    .map_err(|e| e.to_string())?;

    Ok(WorkingCopyDiff {
        package_name,
        base_version,
        diff: scope_diff(diff, params.scope_sheet_ids.as_deref()),
    })
}

/// Keep only `scope`'s APPLICATION sheet ids, and recompute the totals from what
/// survives.
///
/// A subscriber's diff otherwise names two changes a reset will never make:
///
/// * A DETACHED sheet is gone from the subscription ledger but still in the
///   published manifest, so `diff_sides` reports it `removed` — while
///   `calp_reset_subscription` skips it, because it resolves its targets through
///   that same ledger.
/// * A floating range the subscriber added to a subscribed sheet drags its LOCAL
///   backing sheet into the publish assembly (the expansion runs on the final
///   selection in every branch), where it is absent from the base manifest and
///   reads as `added`.
///
/// Both are the same class of lie — the preview naming a sheet the act does not
/// touch — and both are invisible without this, because each looks like an
/// ordinary row.
///
/// `None` leaves the diff whole. That is what the PUSH preview wants: there every
/// sheet in the link's `base_sheets` really is in scope, and a sheet genuinely
/// added or removed by the push is exactly what the author needs to see.
pub(crate) fn scope_diff(mut diff: VersionDiff, scope: Option<&[String]>) -> VersionDiff {
    let Some(scope) = scope else { return diff };
    let keep: std::collections::HashSet<&str> = scope.iter().map(|s| s.as_str()).collect();
    diff.sheets.retain(|s| keep.contains(s.sheet_id.as_str()));

    // Recomputed, never carried over: a filtered list under an unfiltered header
    // is a strip that counts rows the list below does not show.
    let cell_total = |s: &calp::diff::SheetDiffSummary| s.cells_added + s.cells_removed + s.cells_modified;
    diff.totals.sheets_changed = diff
        .sheets
        .iter()
        .filter(|s| s.change != "modified" || cell_total(s) > 0)
        .count();
    diff.totals.cells_changed = diff.sheets.iter().map(cell_total).sum();
    diff.totals.cells_changed_exact = diff.sheets.iter().all(|s| s.counts_exact);
    diff
}

/// local sheet id -> package sheet id, for a workbook that subscribes to
/// `package`. Empty for a checked-out working copy (identity by construction).
fn subscription_sheet_map(
    state: &AppState,
    package: &str,
) -> Result<HashMap<String, String>, String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    Ok(subs
        .subscriptions
        .iter()
        .filter(|s| s.package_name == package)
        .flat_map(|s| s.sheets.iter())
        .map(|s| (s.local_sheet_id.to_string(), s.package_sheet_id.to_string()))
        .collect())
}
