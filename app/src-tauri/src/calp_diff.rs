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
use calp::transport::RegistryTransport;

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
        crate::security::window_guard::MAIN_AND_PACKAGE_INSPECTOR,
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
        crate::security::window_guard::MAIN_AND_PACKAGE_INSPECTOR,
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
    #[serde(default)]
    pub sheet_indices: Option<Vec<usize>>,
    #[serde(default)]
    pub include_comments: bool,
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
    let link = state.workspace_link.read().map_err(|e| e.to_string())?.clone();
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

    // The working-copy side: a real publish into memory.
    let memory = calp::MemoryRegistry::new();
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
        &package_name,
        working_version.clone(),
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

    Ok(WorkingCopyDiff { package_name, base_version, diff })
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
