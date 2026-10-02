//! FILENAME: app/src-tauri/src/calp_diff.rs
//! PURPOSE: The Tauri surface of the version diff engine.
//! CONTEXT: Three commands, and the split between them is about WHERE the two
//! sides come from:
//!
//! * `calp_diff_versions` / `calp_diff_sheet_cells` — two PUBLISHED versions.
//!   Read-only, available to the Package Inspector window.
//! * `calp_diff_working_copy` — the open workbook against the version it was
//!   authored from. Main window only, because it reads the live document.
//!   Asked by the push dialog (`codeSummary`), it also carries the CODE this
//!   push changes -- the Promote dialog's code summary, base -> push
//!   (`push_code_summary`, owner question 14).
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
    /// The frontend providers' distributable objects (the model overlay,
    /// reports), collected the way a push collects them (BUG-0150). Absent =
    /// the caller could not collect them, and the working side then lacks
    /// them: every one reads as REMOVED against a base that carries it.
    #[serde(default)]
    pub custom_objects: Option<Vec<crate::calp_commands::FrontendCustomObject>>,
    /// What the push dialog ADDS to the application ("Include in application",
    /// `PublishParams::include_in_application`), so the working side is the
    /// push the dialog would make. Empty for every other caller.
    #[serde(default)]
    pub include_in_application: Vec<crate::calp_push_scope::IncludedItem>,
    /// Also compare the CODE (owner question 14): the push dialog asks, so the
    /// developer reads which macros, scripts, functions, notebooks, buttons and
    /// validators this push changes -- and what each change means for everyone
    /// on the development line -- before anything goes out under their key.
    /// False for every other caller, whose answer then carries `code: null`.
    #[serde(default)]
    pub code_summary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyDiff {
    pub package_name: String,
    pub base_version: String,
    pub diff: VersionDiff,
    /// The code this push changes, when the caller asked for it
    /// (`code_summary`); `null` otherwise.
    pub code: Option<WorkingCopyCode>,
}

/// The CODE this push changes against its signed base (owner question 14): the
/// Promote dialog's code summary (`calp::code_summary`), here between the base
/// version and what the push would publish, with what each change means for
/// everyone on the development line. The same three fields as the promotion's
/// `PromotionImpactResponse` carries, so one TypeScript reader reads both.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyCode {
    /// Empty when `code_error` is set: an empty list then means "not known",
    /// never "no code changes".
    pub code_changes: Vec<calp::code_summary::CodeChange>,
    /// Whether anyone who approved the application's code will be asked again.
    pub asks_approval_again: bool,
    /// Why the code could not be compared -- an artifact of the base that no
    /// longer matches its signed checksum, a file that cannot be read. NAMED,
    /// never swallowed, and serialized as `null` when there is none.
    pub code_error: Option<String>,
}

/// The code summary of a push: the BASE (already opened by the caller through
/// the verified reader) against the push's in-memory publish.
///
/// * THE BASE is read as `DiffSide::PublishedChecked`, so each code artifact the
///   summary reads is held to the base's SIGNED checksum at the moment it is
///   read -- the caller verified the base and then spent a whole publish before
///   this runs, and a module rewritten on the share in between must not become
///   the BEFORE side of a row.
/// * THE PUSH is the in-memory publish the cell diff compares, so the two
///   halves of the preview describe one push.
/// * A button cell's command is judged against the same list the subscriber's
///   admission uses (`button_cells::DISTRIBUTABLE_BUTTON_COMMANDS`), exactly as
///   the promotion's summary judges it.
pub(crate) fn push_code_summary(
    base_transport: &dyn WorkspaceTransport,
    package: &str,
    base_version: &str,
    base_manifest: &calp::VersionManifest,
    working_manifest: &calp::VersionManifest,
    working_artifacts: &BTreeMap<String, Vec<u8>>,
) -> WorkingCopyCode {
    let base = DiffSide::PublishedChecked {
        transport: base_transport,
        package,
        version: base_version,
        manifest: base_manifest,
    };
    let push = DiffSide::InMemory { manifest: working_manifest, artifacts: working_artifacts };
    match calp::code_summary::code_summary(
        Some(&base),
        &push,
        &DiffOptions::default(),
        crate::button_cells::DISTRIBUTABLE_BUTTON_COMMANDS,
    ) {
        Ok(summary) => WorkingCopyCode {
            code_changes: summary.changes,
            asks_approval_again: summary.asks_approval_again,
            code_error: None,
        },
        Err(e) => WorkingCopyCode {
            code_changes: Vec::new(),
            asks_approval_again: false,
            code_error: Some(format!("the code of this push could not be compared with v{base_version}: {e}")),
        },
    }
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

    // The working-copy side: a real publish into memory -- with the frontend's
    // distributable objects when the caller sent them, as the push does.
    let frontend_objects_supplied = params.custom_objects.is_some();
    // A SUBSCRIBER's collision renames, undone in the working side's
    // references so they compare in the published spelling (BUG-0151). Empty
    // for a working copy, whose assembly undoes its own.
    let published_names =
        crate::calp_commands::subscriber_published_names(&state, &package_name, &base_manifest)?;
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
        params.custom_objects,
        &published_names,
        &params.include_in_application,
    )?;
    let working_version_str = working_version.to_string();
    let working_manifest = memory
        .get_version_manifest(&package_name, &working_version_str)
        .map_err(|e| e.to_string())?;
    let artifacts: BTreeMap<String, Vec<u8>> =
        memory.artifacts_of(&package_name, &working_version_str);

    // THE CODE, when asked (the push dialog): the verified base against the
    // very publish the cell diff below compares, so both halves of the preview
    // describe one push. A failure is carried in `code_error`, beside the diff.
    let code = if params.code_summary {
        Some(push_code_summary(
            base_registry.as_ref(),
            &package_name,
            &base_version,
            &base_manifest,
            &working_manifest,
            &artifacts,
        ))
    } else {
        None
    };

    // A workbook that SUBSCRIBED to this package carries its own local sheet
    // ids; without the remap every sheet would read as removed-and-added. A
    // checked-out working copy needs no map — its ids ARE the package's.
    let sheet_id_map = subscription_sheet_map(&state, &package_name)?;

    let mut diff = calp::diff::diff_sides(
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
    // Only a working side that could NOT see the frontend's distributable
    // objects needs its version-stamp line reconciled -- see the helper. One
    // that was handed them saw everything the push carries, and a stamp line
    // it reports is real (BUG-0150).
    if !frontend_objects_supplied {
        crate::calp_commands::reconcile_unknowable_min_app_version(
            &mut diff,
            &base_manifest,
            &working_manifest,
        );
    }

    Ok(WorkingCopyDiff {
        package_name,
        base_version,
        diff: scope_diff(diff, params.scope_sheet_ids.as_deref()),
        code,
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
