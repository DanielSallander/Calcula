//! FILENAME: app/src-tauri/src/calp_merge.rs
//! PURPOSE: The three-outcome push — fast-forward, merge, or conflict.
//! CONTEXT: A stale base used to be a flat refusal: somebody published while
//! you were working, so your push is rejected and you re-do your edits by hand.
//! That is the right answer when you both changed the same thing, and the wrong
//! answer the rest of the time — which, on a decomposed package, is most of the
//! time. One developer adding a button and another editing a formula have not
//! conflicted, and a system that says they have is a system people route around.
//!
//! Two commands:
//!
//! * `calp_push_merge_analyze` — what landed since your base, what you changed,
//!   and whether those overlap. Read-only.
//! * `calp_push_merge_apply` — brings the intervening changes into the open
//!   working copy as ONE undoable step, recalculates, and moves the workspace
//!   link's base forward so the push that follows is a fast-forward.
//!
//! **The apply is deliberately narrow, and says so.** It brings across CELL
//! changes. Materializing one chart, or one control, out of a published version
//! means calling a slice of the pull materializer that is not separately
//! addressable today, so a merge whose intervening changes include objects is
//! reported as `cannotApply` — disjoint work, machinery limit — and the remedy
//! is the same "open the latest version" as a conflict's. Being clear about
//! which of the two happened is the difference between "you two collided" and
//! "we cannot do this for you yet".

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use calp::diff::{DiffOptions, DiffSide, VersionDiff};
use calp::merge::{MergeAnalysis, MergeVerdict};
use calp::transport::WorkspaceTransport;

use crate::bi::types::BiState;
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeAnalysisResponse {
    pub package_name: String,
    /// The version this working copy was authored against.
    pub base_version: String,
    /// The registry's current head.
    pub head_version: String,
    /// Who published the head.
    pub head_published_by: String,
    /// What the head's author said they changed.
    pub head_change_summary: String,
    pub analysis: MergeAnalysis,
}

/// Where a push stands against what landed while its author was working.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn calp_push_merge_analyze(
    state: State<AppState>,
    bi_state: State<BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    window: tauri::Window,
) -> Result<MergeAnalysisResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let ctx = MergeContext::resolve(&state)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&ctx.registry_url)
        .map_err(|e| e.to_string())?;
    let package_manifest = registry
        .get_application_manifest(&ctx.package_name)
        .map_err(|e| e.to_string())?;
    let head = calp::head_version(&package_manifest)
        .ok_or_else(|| format!("'{}' has no published versions.", ctx.package_name))?;
    let head_str = head.to_string();
    let head_entry = package_manifest
        .versions
        .iter()
        .find(|e| e.version == head_str);

    // Both diffs are taken against the SAME base, or the two sets of touched
    // pieces are not comparable — which is the whole basis of the decision.
    let theirs = diff_head_against_base(&ctx, &head_str)?;
    let yours = diff_working_copy_against_base(
        &state,
        &bi_state,
        &pivot_state,
        &script_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &user_files_state,
        &timeline_slicer_state,
        &ctx,
    )?;

    let analysis = if head_str == ctx.base_version {
        // Nothing landed. Say so through the same type rather than a special
        // case the UI has to know about.
        calp::merge::analyze(&empty_diff(&ctx.package_name), &yours)
    } else {
        calp::merge::analyze(&theirs, &yours)
    };

    Ok(MergeAnalysisResponse {
        package_name: ctx.package_name,
        base_version: ctx.base_version,
        head_version: head_str,
        head_published_by: head_entry.map(|e| e.published_by.clone()).unwrap_or_default(),
        head_change_summary: head_entry.map(|e| e.change_summary.clone()).unwrap_or_default(),
        analysis,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeApplyResponse {
    pub merged_from_version: String,
    pub cells_applied: usize,
    /// The sheets whose cells were touched, for the confirmation message.
    pub sheets_touched: Vec<String>,
}

/// Bring the intervening changes into the open working copy.
///
/// Refuses unless the analysis says `canMerge`, and re-runs that analysis here
/// rather than trusting a verdict from the caller: the registry may have moved
/// again between the dialog rendering and the user confirming, and a merge
/// applied against a head that is no longer the head is a merge with the wrong
/// thing.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn calp_push_merge_apply(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    bi_state: State<BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    window: tauri::Window,
) -> Result<MergeApplyResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let ctx = MergeContext::resolve(&state)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&ctx.registry_url)
        .map_err(|e| e.to_string())?;
    let package_manifest = registry
        .get_application_manifest(&ctx.package_name)
        .map_err(|e| e.to_string())?;
    let head = calp::head_version(&package_manifest)
        .ok_or_else(|| format!("'{}' has no published versions.", ctx.package_name))?;
    let head_str = head.to_string();

    if head_str == ctx.base_version {
        return Err(
            "There is nothing to merge — your working copy is already based on the \
             latest version."
                .to_string(),
        );
    }

    let theirs = diff_head_against_base(&ctx, &head_str)?;
    let yours = diff_working_copy_against_base(
        &state,
        &bi_state,
        &pivot_state,
        &script_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &user_files_state,
        &timeline_slicer_state,
        &ctx,
    )?;
    let analysis = calp::merge::analyze(&theirs, &yours);
    if analysis.verdict != MergeVerdict::CanMerge {
        return Err(format!(
            "CALP_MERGE_REFUSED: {}",
            match analysis.verdict {
                MergeVerdict::Conflict => format!(
                    "The same thing was changed on both sides: {}. Open v{head_str} \
                     for editing and re-apply your work.",
                    analysis
                        .collisions
                        .iter()
                        .map(|c| c.description.clone())
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
                MergeVerdict::CannotApply => format!(
                    "Your work and v{head_str} do not overlap, but this version cannot \
                     bring across {}. Open v{head_str} for editing and re-apply your work.",
                    analysis.unmergeable.join("; ")
                ),
                _ => "Nothing to merge.".to_string(),
            }
        ));
    }

    // Build the after-grids: the CURRENT workbook with their cell changes laid
    // over it. Their pieces are disjoint from ours by construction, so every
    // cell written here is one this working copy did not touch.
    let (modified_grids, cells_applied, sheets_touched, active_sheet) =
        overlay_their_cells(&state, &ctx, &head_str, &theirs)?;

    if cells_applied > 0 {
        // Through the SAME pipeline a script write uses: diff, one undo
        // transaction, parse, dependency maps, recalculation, dirty flag,
        // events. A merge that installed grids wholesale would skip all of it —
        // and the recalculation is not optional here, because piece-level
        // disjointness says nothing about whether your formulas READ the cells
        // theirs changed.
        crate::scripting::commands::apply_script_modified_grids(
            &state,
            &file_state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            &modified_grids,
            active_sheet,
            cells_applied as u32,
            "calpMerge",
            &format!("{}@{}", ctx.package_name, head_str),
        )?;
    }

    // The working copy is now based on the head: the push that follows is a
    // fast-forward, and its recorded lineage will say it came from there.
    {
        let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut link = state.working_copy_link.write(&effect).map_err(|e| e.to_string())?;
        if let Some(l) = link.as_mut() {
            l.base_version = head_str.clone();
        }
    }

    Ok(MergeApplyResponse {
        merged_from_version: head_str,
        cells_applied,
        sheets_touched,
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

struct MergeContext {
    registry_url: String,
    package_name: String,
    base_version: String,
    /// The application's kind, from the link. Threaded into the in-memory
    /// publish so a LIBRARY working copy diffs the same zero sheets a real
    /// library push would ship, instead of its author's whole workbook.
    kind: String,
}

impl MergeContext {
    fn resolve(state: &AppState) -> Result<Self, String> {
        let link = state.working_copy_link.read().map_err(|e| e.to_string())?;
        let link = link.as_ref().ok_or_else(|| {
            "This workbook is not a working copy of any package, so there is nothing to \
             merge with."
                .to_string()
        })?;
        if link.base_version.is_empty() {
            return Err("This working copy has no base version recorded.".to_string());
        }
        Ok(Self {
            registry_url: link.registry_url.clone(),
            package_name: link.package_name.clone(),
            base_version: link.base_version.clone(),
            kind: link.kind.clone(),
        })
    }
}

/// A diff with nothing in it — "nothing landed", expressed in the same type.
fn empty_diff(package_name: &str) -> VersionDiff {
    VersionDiff {
        package_name: package_name.to_string(),
        from_version: String::new(),
        to_version: String::new(),
        artifacts: Default::default(),
        sheets: Vec::new(),
        objects: Vec::new(),
        manifest_changes: Vec::new(),
        totals: calp::diff::DiffTotals {
            cells_changed_exact: true,
            ..Default::default()
        },
    }
}

/// Sampling wide enough that the piece set is the truth rather than a floor.
///
/// The default sample cap exists so a UI payload stays readable. A merge
/// decision is not a UI payload: an unsampled cell is a piece missing from the
/// comparison, and `calp::merge::analyze` refuses outright when the diff it is
/// handed was truncated. Raising the cap here is what lets it answer at all.
fn merge_diff_options(sheet_id_map: HashMap<String, String>) -> DiffOptions {
    DiffOptions {
        sample_cells_per_sheet: usize::MAX,
        sheet_id_map,
        ..DiffOptions::default()
    }
}

fn diff_head_against_base(ctx: &MergeContext, head: &str) -> Result<VersionDiff, String> {
    let (base_registry, base_version, base_manifest) = crate::calp_inspector::open_verified_content(
        &ctx.registry_url,
        &ctx.package_name,
        &format!("={}", ctx.base_version),
        true,
    )?;
    let (head_registry, head_version, head_manifest) = crate::calp_inspector::open_verified_content(
        &ctx.registry_url,
        &ctx.package_name,
        &format!("={head}"),
        true,
    )?;
    calp::diff::diff_sides(
        &DiffSide::Published {
            transport: &base_registry,
            package: &ctx.package_name,
            version: &base_version,
            manifest: &base_manifest,
        },
        &DiffSide::Published {
            transport: &head_registry,
            package: &ctx.package_name,
            version: &head_version,
            manifest: &head_manifest,
        },
        &merge_diff_options(HashMap::new()),
    )
    .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn diff_working_copy_against_base(
    state: &State<AppState>,
    bi_state: &State<BiState>,
    pivot_state: &State<crate::pivot::types::PivotState>,
    script_state: &State<crate::scripting::types::ScriptState>,
    slicer_state: &State<crate::slicer::SlicerState>,
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: &State<crate::pane_control::PaneControlState>,
    user_files_state: &State<crate::persistence::UserFilesState>,
    timeline_slicer_state: &State<crate::timeline_slicer::TimelineSlicerState>,
    ctx: &MergeContext,
) -> Result<VersionDiff, String> {
    let (base_registry, base_version, base_manifest) = crate::calp_inspector::open_verified_content(
        &ctx.registry_url,
        &ctx.package_name,
        &format!("={}", ctx.base_version),
        true,
    )?;

    let memory = calp::MemoryWorkspace::new();
    let working_version = calp::SemVer::new(0, 0, 0);
    crate::calp_commands::publish_into_for_preview(
        state,
        bi_state,
        pivot_state,
        script_state,
        slicer_state,
        ribbon_filter_state,
        pane_control_state,
        user_files_state,
        timeline_slicer_state,
        &memory,
        &ctx.package_name,
        working_version.clone(),
        &ctx.kind,
        Vec::new(),
        false,
    )?;
    let working_str = working_version.to_string();
    let working_manifest = memory
        .get_version_manifest(&ctx.package_name, &working_str)
        .map_err(|e| e.to_string())?;
    let artifacts = memory.artifacts_of(&ctx.package_name, &working_str);

    calp::diff::diff_sides(
        &DiffSide::Published {
            transport: &base_registry,
            package: &ctx.package_name,
            version: &base_version,
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &working_manifest, artifacts: &artifacts },
        &merge_diff_options(HashMap::new()),
    )
    .map_err(|e| e.to_string())
}

/// Copy the current grids and lay the head's cell changes over them.
///
/// Returns `(grids, cells_applied, sheet_names, active_sheet)`.
fn overlay_their_cells(
    state: &AppState,
    ctx: &MergeContext,
    head: &str,
    theirs: &VersionDiff,
) -> Result<(Vec<engine::grid::Grid>, usize, Vec<String>, usize), String> {
    let (registry, head_version, _manifest) = crate::calp_inspector::open_verified_content(
        &ctx.registry_url,
        &ctx.package_name,
        &format!("={head}"),
        true,
    )?;

    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    let mut grids = state.grids.read().map_err(|e| e.to_string())?.clone();
    let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;

    let mut cells_applied = 0usize;
    let mut sheets_touched: Vec<String> = Vec::new();

    for sheet in &theirs.sheets {
        if sheet.sample.is_empty() {
            continue;
        }
        // A checked-out working copy carries the package's sheet ids verbatim,
        // so the package id IS the local id. A sheet the head added is not
        // present locally at all — those land in `unmergeable`, so reaching
        // here with no match means the analysis and this walk disagree, which
        // is worth refusing over rather than silently skipping.
        let Some(local_index) = sheet_ids.iter().position(|id| id.to_string() == sheet.sheet_id)
        else {
            return Err(format!(
                "Cannot merge: the sheet '{}' from v{head} has no counterpart in this \
                 working copy.",
                sheet.name
            ));
        };

        let data = registry
            .read_artifact(
                &ctx.package_name,
                &head_version,
                &format!("sheets/{}/data.json", sheet.sheet_id),
            )
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("v{head} is missing data for the sheet '{}'.", sheet.name))?;
        let head_data: calcula_format::sheet_data::SheetData =
            serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        let head_cells = calcula_format::sheet_data::sheet_data_to_cells(&head_data);

        let grid = grids
            .get_mut(local_index)
            .ok_or_else(|| "Sheet index out of range while merging.".to_string())?;

        for cell in &sheet.sample {
            let pos = (cell.row, cell.col);
            match head_cells.get(&pos) {
                Some(saved) => {
                    grid.cells.insert(pos, saved.to_cell());
                }
                // They deleted it. Their delta is disjoint from ours, so this
                // cell is not one we edited.
                None => {
                    grid.cells.remove(&pos);
                }
            }
            cells_applied += 1;
        }
        sheets_touched.push(sheet.name.clone());
    }

    Ok((grids, cells_applied, sheets_touched, active_sheet))
}
