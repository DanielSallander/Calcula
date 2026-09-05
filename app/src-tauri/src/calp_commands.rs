//! FILENAME: app/src-tauri/src/calp_commands.rs
//! PURPOSE: Tauri commands for .calp application operations (publish, pull, etc.).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;
use crate::bi::types::BiState;

use calp::manifest::SubscriptionManifest;
use calp::publish::PushMode;
use calp::version::{SemVer, VersionPin};
use identity::{CellId, SheetId};

// ============================================================================
// API Types (camelCase for TypeScript)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishParams {
    pub registry_path: String,
    pub package_name: String,
    pub version: String,
    pub kind: String,
    pub sheet_indices: Vec<usize>,
    pub published_by: String,
    /// What this publish IS. `"update"` pushes the next version of an application
    /// this workbook is a working copy of and REQUIRES `expected_base_version`;
    /// `"createNew"` creates an application under a name that must not exist yet.
    ///
    /// Absent means `"createNew"` — which is the pre-working-copy behaviour and
    /// stays available for the scripted/model publish paths and for a first
    /// publish from a standalone workbook. It is never a silent fallback for a
    /// failed update: an update whose base is missing is refused, not downgraded.
    #[serde(default)]
    pub mode: Option<String>,
    /// For `"update"`: the version the author worked from, taken from the
    /// workbook's working-copy link and echoed back by the preflight the user saw.
    /// The base-version gate compares it against the workspace head — this is
    /// the optimistic-concurrency token, and it is the caller's claim about
    /// their own state, never something re-read from the workspace.
    #[serde(default)]
    pub expected_base_version: Option<String>,
    /// What changed, in the author's words. Required for `"update"`.
    #[serde(default)]
    pub change_summary: String,
    /// Extra custom objects supplied by frontend distributable-object providers
    /// (distribution brick 4). Merged with the Rust-collected built-in custom
    /// objects (cell types). Absent when no provider contributed.
    #[serde(default)]
    pub custom_objects: Option<Vec<FrontendCustomObject>>,
    /// Opt-in for carrying threaded comments (Wave B). Comments are internal
    /// discussion — a privacy hazard to ship silently — so they publish ONLY
    /// when the author checks "Include comments" (default false).
    #[serde(default)]
    pub include_comments: bool,
}

/// A custom object contributed by a FRONTEND provider for publishing
/// (distribution brick 4). Mirrors `calp::publish::PublishCustomObject` over
/// the IPC boundary; `payload` is opaque provider-owned JSON.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendCustomObject {
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sheet_id: Option<identity::SheetId>,
    pub payload: serde_json::Value,
}

impl From<FrontendCustomObject> for calp::publish::PublishCustomObject {
    fn from(f: FrontendCustomObject) -> Self {
        calp::publish::PublishCustomObject {
            kind: f.kind,
            id: f.id,
            name: f.name,
            sheet_id: f.sheet_id,
            payload: f.payload,
        }
    }
}

/// Collect the workbook's cell-type assignments (for the selected sheets) as
/// generic custom objects — one per sheet that has assignments (distribution
/// brick 4 dogfood). Mirrors how controls travel, but through the open channel.
fn collect_cell_type_custom_objects(
    state: &AppState,
    sheet_indices: &[usize],
) -> Result<Vec<calp::publish::PublishCustomObject>, String> {
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    let selected: std::collections::HashSet<identity::SheetId> = sheet_indices
        .iter()
        .filter_map(|&i| sheet_ids.get(i).copied())
        .collect();
    let cell_types = state.cell_types.read().map_err(|e| e.to_string())?;
    let objects = crate::cell_types::collect_cell_types_for_save(&cell_types, &sheet_ids)
        .into_iter()
        .filter(|s| selected.contains(&s.sheet_id))
        .map(|s| calp::publish::PublishCustomObject {
            kind: "cellType".to_string(),
            // Stable per-sheet id so refresh replaces the same object.
            id: format!("cellType-{}", s.sheet_id),
            name: "Cell Types".to_string(),
            sheet_id: Some(s.sheet_id),
            payload: s.cells,
        })
        .collect();
    Ok(objects)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResponse {
    pub package_name: String,
    pub version: String,
    pub sheets_published: usize,
    pub tables_published: usize,
    pub named_ranges_published: usize,
    pub scripts_published: usize,
    /// Number of standalone module scripts published (C8).
    pub modules_published: usize,
    /// Number of standalone notebooks published (C8).
    pub notebooks_published: usize,
    /// Transparency report: everything that shipped and everything present in
    /// the workbook that applications cannot carry yet (no silent drops).
    pub report: PublishReport,
    /// Publish-time disclosure warnings from core publish — e.g. a dropdown
    /// pane control whose CellRange item source references a sheet outside
    /// the published selection (the artifact is unchanged; these only warn).
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullParams {
    pub registry_path: String,
    pub package_name: String,
    /// A pin on the development line. Empty when `environment` is given.
    #[serde(default)]
    pub version_pin: String,
    /// The ENVIRONMENT to follow, e.g. `"prod"`.
    ///
    /// Exactly one of this and `version_pin` may be supplied; both is refused
    /// (`CALP_PULL_TARGET_AMBIGUOUS`) rather than one silently winning, because
    /// the two answer the same question differently and a caller that sent both
    /// does not know which it wants.
    #[serde(default)]
    pub environment: Option<String>,
    /// Deliberately subscribe to the DEVELOPMENT LINE on an application that
    /// has environments.
    ///
    /// Required, because the line receives every push the moment it lands —
    /// which is the exact accident environments exist to prevent. A subscriber
    /// who has not asked for that gets `CALP_PULL_ENVIRONMENT_REQUIRED` naming
    /// the environments on offer, not a silent seat on unreleased work.
    #[serde(default)]
    pub follow_line: bool,
    /// The user was shown a CROSS-WORKSPACE NAME CONFLICT -- this application name is
    /// already pinned to a different publisher key from another workspace -- and
    /// answered a second, differently-worded question accepting it anyway.
    ///
    /// Absent/false is the safe default: a plain subscribe REFUSES a conflict
    /// (`CalpError::PublisherNameConflict`) rather than pinning, so a caller that
    /// forgets this flag fails closed with an explanation instead of quietly
    /// trusting a second claimant to a familiar name.
    #[serde(default)]
    pub accept_name_conflict: bool,
    /// REFUSE to create a TOFU pin: the application must already be pinned on this
    /// machine or the pull fails.
    ///
    /// Set ONLY by the scripted distribution gateway
    /// (`scripting/distribution_gateway.rs`, `Action::Pull`). Subscribing is the
    /// one .calp flow allowed to mint a pin, and what makes that sound is that a
    /// human was shown the publisher and said yes. A script calling
    /// `cap.pkgPull` is not that human: it would pin whatever key the workspace
    /// happened to be serving at that moment, silently, on the author's
    /// authority rather than the user's. `Action::RefreshApply` already reasoned
    /// its way to `RequirePinned` for the same reason; `Pull` did not.
    ///
    /// Absent/false keeps the interactive Subscribe dialog's behavior unchanged.
    #[serde(default)]
    pub require_pinned: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub package_name: String,
    pub resolved_version: String,
    pub sheets_pulled: usize,
    pub tables_pulled: usize,
    pub scripts_pulled: usize,
    /// Publisher display name asserted in the verified manifest (S5 phase 2).
    pub publisher_name: String,
    /// A `CalpTrustStatus` -- the TOFU outcome for THIS workspace. Subscribe is a
    /// commit point, so it is one of the pinning states; the frontend surfaces a
    /// first-use notice from it.
    pub trust_status: String,
    /// Pins held for this same application name in OTHER workspaces, so the notice
    /// can say "the publisher you already trust, reached from a new location" --
    /// or, for an accepted conflict, exactly whose key it is competing with.
    pub other_scope_pins: Vec<crate::calp_inspector::OtherScopePinInfo>,
    /// Generic custom objects of kinds NOT handled Rust-side (distribution
    /// brick 4), surfaced so frontend distributable-object providers can
    /// materialize them. Built-in kinds (cellType) are already applied and are
    /// NOT included here. Payloads are already integrity-verified.
    #[serde(default)]
    pub custom_objects: Vec<PulledCustomObjectDto>,
    /// The TRUE state-vector index of the first user-visible sheet this pull
    /// created, for the caller to activate. `None` when the application brought
    /// no user sheet (a dataset or library application).
    ///
    /// Answered here because only this layer knows the real indices: the sheet
    /// LIST omits object-backed sheets, so a caller deriving a position from it
    /// names the wrong sheet as soon as a floating range exists.
    #[serde(default)]
    pub first_pulled_sheet_index: Option<usize>,
}

/// A pulled custom object handed to the frontend for provider materialization
/// (distribution brick 4). `sheet_index` is the LOCAL sheet index (the application
/// sheet remapped), or null for workbook-scoped / unresolvable objects.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledCustomObjectDto {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub sheet_index: Option<usize>,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationInfo {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub author: String,
    pub versions: Vec<VersionInfo>,
    /// The application's environments, from the manifest LISTING.
    ///
    /// Unverified, deliberately: a browse list reads every application in a
    /// workspace, and folding a signed log per application would make opening
    /// the Subscribe dialog cost one signature check per environment per
    /// application. The listing is enough to render the picker; the version a
    /// subscription actually lands on is resolved through the SIGNED log at
    /// pull. Same status `published_by` already has in this struct.
    pub environments: Vec<EnvironmentSummary>,
}

/// One environment as a browse list shows it: a name and where it points.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSummary {
    pub name: String,
    /// `None` = defined but nothing promoted into it yet. Such an environment
    /// cannot be subscribed to, and the picker must show it as unavailable
    /// rather than offering a seat on nothing.
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: String,
    pub published_at: String,
    pub published_by: String,
    pub sheets: Vec<SheetInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub name: String,
    pub description: String,
}

/// Resolve the per-user Calcula profile directory (%LOCALAPPDATA%\Calcula).
/// This is the SAME directory used for the subscriber identity; it also holds
/// the publisher's Ed25519 keypair (`publisher-key.json`) and the TOFU pin
/// store (`trusted-publishers.json`) for S5 phase 2 application signing.
pub(crate) fn calcula_profile_dir() -> std::path::PathBuf {
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(local_app_data).join("Calcula")
}

// ============================================================================
// Tauri Commands
// ============================================================================

// ============================================================================
// Publish assembly + transparency report
// ============================================================================

/// Everything calp_publish hands to core publish, assembled once so the real
/// publish and the dry-run preview (calp_publish_preview) can never drift.
struct PublishAssembly {
    workbook: persistence::Workbook,
    writeback_regions: Option<Vec<calp::WritebackRegionDeclaration>>,
    object_scripts: Option<Vec<persistence::SavedObjectScript>>,
    data_sources: Vec<calp::publish::PublishDataSource>,
    /// Writeback COLUMN declarations derived from the captured models
    /// (engine v21) — governance for model-keyed submissions.
    model_writebacks: Vec<calp::writeback::ModelWritebackDeclaration>,
    excluded_regions: Vec<calp::publish::ExcludedRegion>,
}

/// Build the publish carrier. ONE collector — the same enriched builder as the
/// .cala save path (active-sheet mirror content, notes/hyperlinks/hidden rows/
/// page setup, CF/DV, controls, charts, sparklines, tables, named ranges,
/// slicers, ribbon filters, theme, extension data) — so application fidelity
/// automatically tracks file fidelity. Core publish writes the subset the
/// .calp format supports; compute_publish_report tells the author exactly
/// what shipped and what stayed behind.
/// Is `local` what `resolve_sheet_name_collisions` would have produced from
/// `published` — i.e. exactly it, or it with a ` (n)` suffix?
///
/// The distinction decides whether a differing name may be restored silently.
/// A collision rename touches nothing but the sheet's own name, so undoing it
/// puts every reference back. A deliberate rename has already rewritten every
/// formula and named range in the workbook, so undoing only the name strands
/// them — that case is refused instead.
///
/// Case-insensitive, like every sheet-name comparison in the product.
fn is_collision_rename(local: &str, published: &str) -> bool {
    let (local_l, published_l) = (local.to_ascii_lowercase(), published.to_ascii_lowercase());
    if local_l == published_l {
        return true;
    }
    let Some(rest) = local_l.strip_prefix(&published_l) else { return false };
    let Some(rest) = rest.strip_prefix(" (") else { return false };
    let Some(digits) = rest.strip_suffix(')') else { return false };
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

fn assemble_publish_workbook(
    state: &State<AppState>,
    bi_state: &State<BiState>,
    pivot_state: &State<crate::pivot::types::PivotState>,
    script_state: &State<crate::scripting::types::ScriptState>,
    slicer_state: &State<crate::slicer::SlicerState>,
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: &State<crate::pane_control::PaneControlState>,
    user_files_state: &State<crate::persistence::UserFilesState>,
    timeline_state: &State<crate::timeline_slicer::TimelineSlicerState>,
    sheet_indices: &[usize],
    // The application THIS assembly is for. The published-name restoration
    // applies only when the workbook's working-copy link targets it — a link
    // belongs to one application, and creating a NEW one from the same workbook
    // must not borrow its names.
    registry_path: &str,
    package_name: &str,
) -> Result<PublishAssembly, String> {
    // Timelines CARRY into the application. Their EFFECT already travels as the
    // pivot's hidden_items/slicer_filters, so excluding the control while
    // carrying its filter would hand a subscriber a pivot pinned to the
    // publisher's last date range with no way to change it -- the worse of the
    // two answers.
    let mut workbook = crate::persistence::build_workbook_for_save_with_slicers(
        state,
        user_files_state,
        slicer_state,
        ribbon_filter_state,
        pivot_state,
        timeline_state,
    )?;

    // Pane controls (Controls pane) are workbook-scoped and ride in the
    // application as pane_controls.json (config + current values, sorted
    // deterministically at publish). Their custom-control/button scripts are
    // ordinary object scripts and ship consent-gated via object_scripts below.
    workbook.pane_controls =
        crate::persistence::collect_pane_controls_for_save(pane_control_state);

    for &idx in sheet_indices {
        if idx >= workbook.sheets.len() {
            return Err(format!("Sheet index {} out of range", idx));
        }
    }

    // A LOCAL RENAME DOES NOT TRAVEL. An application sheet publishes under the
    // name the application already knows it by, taken from the working-copy
    // link's `base_sheets`, never from this workbook's live tab.
    //
    // The leak this closes had nothing to do with deliberate renames. Checkout
    // is ADDITIVE, so pulling an application's "Sheet1" into a workbook that
    // already has one renames the INCOMING sheet to "Sheet1 (2)" — a collision
    // in THIS author's workbook and nowhere else. Publishing the live name then
    // renamed that sheet for every subscriber, on the DEFAULT push, with no tick
    // and no author action: the default selection is exactly `base_sheets`, and
    // `publish()` copies `sheet.name` straight into the manifest.
    //
    // And names are the formula reference key. Cross-sheet refs inside a package
    // are stored as raw text and resolved by a first-match case-insensitive name
    // lookup, so a renamed sheet re-points every `=Sheet1!A1` in the package at
    // whatever the subscriber happens to call "Sheet1" — silently.
    //
    // It was also self-erasing: `record_push` overwrites `base_sheets` from the
    // live names after a successful push, so one leaked push and the drift is no
    // longer detectable offline.
    //
    // A DELIBERATE rename therefore does not travel either, and that is the
    // 2026-09-01 decision rather than an oversight: renaming a sheet that
    // subscribers hold formulas against is a breaking change, and push is the
    // wrong gesture for it. It belongs to a workspace-side edit that can be
    // reviewed as such. Until that exists, a working copy's tab name is local.
    //
    // Applied HERE, so the publish, the dry-run preview and the working-copy
    // diff all see the same names — `assemble_publish_workbook` is the one door
    // all three go through.
    //
    // Returns LOWERCASED local name -> published name for every sheet it
    // renamed, because anything else that refers to a sheet BY NAME has to
    // follow it, and every sheet-name comparison in this product is
    // case-insensitive. A case-sensitive key here silently dropped a pivot whose
    // stored `destination_sheet` spelling had drifted from its tab.
    //
    // ONLY WHEN THIS PUSH TARGETS THE LINKED APPLICATION. The link belongs to
    // ONE application; publishing a NEW application from the same workbook must
    // not take its names. Without this check, a working copy of "sales" that
    // creates "sales-2026" shipped a sheet under a name borrowed from an
    // unrelated application, and both refusal messages in `calp_publish` route
    // the author here by name.
    let renamed_for_publish: std::collections::HashMap<String, String> = {
        let link = state.working_copy_link.read().map_err(|e| e.to_string())?;
        let mut renamed = std::collections::HashMap::new();
        let applies = link
            .as_ref()
            .is_some_and(|l| l.targets(registry_path, package_name));
        if applies {
            let link = link.as_ref().expect("checked by `applies`");
            let published_name: std::collections::HashMap<identity::SheetId, String> = link
                .base_sheets
                .iter()
                .map(|s| (s.sheet_id, s.name.clone()))
                .collect();
            for &idx in sheet_indices {
                let Some(sheet) = workbook.sheets.get_mut(idx) else { continue };
                let Some(published) = published_name.get(&sheet.id) else { continue };
                if sheet.name == *published {
                    continue;
                }

                // A COLLISION RENAME IS SAFE TO UNDO; A DELIBERATE ONE IS NOT.
                //
                // `resolve_sheet_name_collisions` renames the incoming sheet and
                // rewrites NOTHING else — no formula, no named range — so
                // restoring the published name puts every reference back where
                // it pointed. `rename_sheet_inner` is the opposite: it repairs
                // every formula in the workbook (`repair_all_formulas` +
                // `repair_3d_refs_on_rename`) and every `refers_to`. Restoring
                // the sheet name after THAT strands them: the package would ship
                // a sheet called "Data" beside a formula saying
                // `='Sales Data'!B5`, naming a sheet the package does not
                // contain — and nothing warns, because publish's only reference
                // checks cover pane controls and macros, not cells or names.
                //
                // The two are told apart by shape: a collision produces exactly
                // `<published>` or `<published> (n)`. Anything else is the
                // author's own rename, and a push is refused rather than
                // half-applied — renames are out of push (2026-09-01), so the
                // remedy is to put the tab name back.
                if !is_collision_rename(&sheet.name, published) {
                    return Err(format!(
                        "CALP_PUSH_SHEET_RENAMED: the sheet '{}' is published as '{}', and a \
                         push cannot carry a rename — subscribers hold formulas against that \
                         name. Rename the tab back to '{}' before pushing. (Renaming a \
                         published sheet is a breaking change and needs its own gesture; it \
                         is not something a push should do quietly.)",
                        sheet.name, published, published
                    ));
                }

                renamed.insert(sheet.name.to_ascii_lowercase(), published.clone());
                sheet.name = published.clone();
            }
        }
        renamed
    };

    // Standalone module scripts / notebooks live in ScriptState, not AppState.
    // With these present, the publish request's None ("all from the workbook")
    // ships every module script + notebook (C8).
    workbook.scripts = crate::persistence::collect_scripts_for_save(script_state);
    workbook.notebooks = crate::persistence::collect_notebooks_for_save(script_state);

    // THE APPLICATION'S SCRIPTS, NOT THE AUTHOR'S.
    //
    // `publish()` reads an absent script list as "all from the workbook", which
    // was harmless while checkout REPLACED the document — the workbook then held
    // nothing but the application. Additive checkout ended that: the author's
    // own module scripts and notebooks now sit beside the application's, and a
    // push wrote every one of them into the shared workspace, checksummed and
    // Ed25519-signed under the author's key, disclosed only as a bare count in
    // the report. A private module holding an API token is exactly the shape of
    // thing that lives in somebody's personal workbook.
    //
    // The link records what the base version carried, the same job `base_sheets`
    // does for the tick list. An EMPTY record means a link written before this
    // existed: fall back to publishing everything rather than silently dropping
    // the application's own scripts, which is the opposite failure and just as
    // quiet.
    let withheld_private_content: Vec<String> = {
        let link = state.working_copy_link.read().map_err(|e| e.to_string())?;
        let mut withheld = Vec::new();
        if let Some(link) = link.as_ref() {
            if link.targets(registry_path, package_name)
                && !(link.base_script_ids.is_empty() && link.base_notebook_ids.is_empty())
            {
                let keep_scripts: std::collections::HashSet<&str> =
                    link.base_script_ids.iter().map(|s| s.as_str()).collect();
                let keep_notebooks: std::collections::HashSet<&str> =
                    link.base_notebook_ids.iter().map(|s| s.as_str()).collect();
                workbook.scripts.retain(|s| {
                    let keep = keep_scripts.contains(s.id.as_str());
                    if !keep {
                        withheld.push(format!("script '{}'", s.name));
                    }
                    keep
                });
                workbook.notebooks.retain(|n| {
                    let keep = keep_notebooks.contains(n.id.as_str());
                    if !keep {
                        withheld.push(format!("notebook '{}'", n.name));
                    }
                    keep
                });

                // NAMED RANGES, the same leak by a different route. A pull is
                // ADDITIVE for names, so an application whose `RATE` collides
                // with the author's own is silently DROPPED at checkout — and
                // then the author's `RATE`, pointing at a sheet of theirs the
                // package does not contain, shipped as the application's. Every
                // subscriber's next refresh took that definition and started
                // computing against a `#REF!`.
                //
                // Only workbook-scoped names are filtered here: a SHEET-scoped
                // name rides with its sheet, and the sheet selection already
                // decides whether that sheet ships at all.
                if !link.base_named_range_keys.is_empty() {
                    let keep_names: std::collections::HashSet<String> = link
                        .base_named_range_keys
                        .iter()
                        .map(|k| k.to_uppercase())
                        .collect();
                    workbook.named_ranges.retain(|nr| {
                        if nr.sheet_id.is_some() {
                            return true;
                        }
                        let keep = keep_names.contains(&nr.name.to_uppercase());
                        if !keep {
                            withheld.push(format!("name '{}'", nr.name));
                        }
                        keep
                    });
                }
            }
        }
        withheld
    };
    if !withheld_private_content.is_empty() {
        crate::log_info!(
            "CALP",
            "publish withheld {} item(s) not part of '{}': {}",
            withheld_private_content.len(),
            package_name,
            withheld_private_content.join(", ")
        );
    }

    // Ship pivot definitions + BI pivot metadata so subscribers can rebuild
    // live pivots; per-pivot data source routing reads the dataSourceId
    // carried in that metadata.
    crate::persistence::collect_pivot_definitions(pivot_state, state, &mut workbook);

    // The application contains only the selected sheets: drop pivots whose
    // source or destination sheet isn't included, and remap grid-source
    // sheet indices from workbook positions to application positions (pull
    // appends application sheets in order, offset by the pre-pull sheet count).
    {
        let index_map: std::collections::HashMap<usize, usize> = sheet_indices
            .iter()
            .enumerate()
            .map(|(package_idx, &wb_idx)| (wb_idx, package_idx))
            .collect();
        // LOWERCASED, because every other sheet-name comparison in the product
        // is `eq_ignore_ascii_case` — the lexer uppercases bare identifiers, so
        // `Data` and `data` are one name to a formula. This set was matched
        // case-SENSITIVELY, which silently DROPPED a pivot whose
        // `destination_sheet` was recorded as `data` from an application whose
        // tab is spelled `Data`. Found while closing the rename leak; the two
        // are the same class of defect, a name compared one way here and
        // another way everywhere else.
        let published_names: std::collections::HashSet<String> = sheet_indices
            .iter()
            .filter_map(|&i| workbook.sheets.get(i).map(|s| s.name.to_ascii_lowercase()))
            .collect();

        workbook.pivot_definitions.retain_mut(|def| {
            // A PIVOT FOLLOWS ITS SHEET — BOTH ANCHORS. If the sheet was
            // restored to the name the application publishes it under, the
            // pivot's stored names have to be rewritten to match, or the
            // published pivot names a sheet the package does not contain.
            //
            // `source_sheet` matters as much as `destination_sheet` and was
            // missed the first time. The subscriber's `refresh_pivot_cache`
            // resolves the SOURCE anchor by name and falls back to
            // `.unwrap_or(0)`, so a stale source rebuilds the pivot's entire
            // cache from sheet 0 of THEIR workbook at the publisher's
            // coordinates, and drill-through then lists rows from an unrelated
            // sheet. The pull side already remaps both
            // (`restore_pulled_pivots`); the push side remapped one.
            //
            // Looked up LOWERCASED: `renamed_for_publish` is keyed that way
            // because a stored anchor's spelling can drift from its tab, and a
            // case-sensitive miss here means the anchor is left stale and the
            // `dest_ok` test three lines down then drops the pivot silently.
            for anchor in ["destination_sheet", "source_sheet"] {
                let Some(local) = def
                    .definition
                    .get(anchor)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_ascii_lowercase())
                else {
                    continue;
                };
                if let Some(published) = renamed_for_publish.get(&local) {
                    if let Some(obj) = def.definition.as_object_mut() {
                        obj.insert(
                            anchor.to_string(),
                            serde_json::Value::String(published.clone()),
                        );
                    }
                }
            }
            let dest_ok = def
                .definition
                .get("destination_sheet")
                .and_then(|v| v.as_str())
                .map_or(true, |name| published_names.contains(&name.to_ascii_lowercase()));
            if !dest_ok {
                return false;
            }
            match def.source_sheet_index {
                Some(wb_idx) => match index_map.get(&wb_idx) {
                    Some(&package_idx) => {
                        def.source_sheet_index = Some(package_idx);
                        true
                    }
                    None => false, // grid source sheet not published
                },
                None => true, // BI pivot — no grid source sheet
            }
        });

        let kept: std::collections::HashSet<String> = workbook
            .pivot_definitions
            .iter()
            .map(|d| d.id.to_string())
            .collect();
        workbook.bi_pivot_metadata.retain(|m| {
            m.get("pivotId")
                .and_then(|v| v.as_str())
                .map_or(false, |id| kept.contains(id))
        });
    }

    // Include any author-designated writeback regions in the publish
    let writeback_regions = {
        let drafts = state.writeback_draft_regions.read().map_err(|e| e.to_string())?;
        if drafts.is_empty() { None } else { Some(drafts.clone()) }
    };

    // Include object scripts in the publish
    let object_scripts = {
        let scripts = state.object_scripts.read().map_err(|e| e.to_string())?;
        if scripts.is_empty() { None } else { Some(scripts.clone()) }
    };

    // Capture active BI connections as data sources (+ their writeback-column
    // declarations for governed model-keyed submissions).
    let (data_sources, model_writebacks) = capture_bi_data_sources(&state, bi_state)?;

    // Validate BI pivot definitions against the embedded model before publishing.
    // This catches mismatched field names (e.g., grid-style "Category" instead of
    // BI-style "dim_product.categoryname") that would silently break for subscribers.
    validate_bi_pivot_definitions(&workbook, &data_sources)?;

    // Build exclusion regions from pivot protected regions.
    // Pivot output cells are recalculated by subscribers, so we strip them
    // from the published data — only hard-coded cell values go into the application.
    let excluded_regions = {
        let regions = state.protected_regions.lock().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        regions.iter()
            .filter(|r| r.region_type == "pivot")
            .filter_map(|r| {
                sheet_ids.get(r.sheet_index).map(|&sid| calp::publish::ExcludedRegion {
                    sheet_id: sid,
                    start_row: r.start_row,
                    start_col: r.start_col,
                    end_row: r.end_row,
                    end_col: r.end_col,
                })
            })
            .collect::<Vec<_>>()
    };

    Ok(PublishAssembly {
        workbook,
        writeback_regions,
        object_scripts,
        data_sources,
        model_writebacks,
        excluded_regions,
    })
}

/// One line of the publish transparency report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishReportItem {
    pub category: String,
    pub count: usize,
    pub detail: String,
}

/// What a publish did (or, for the preview, WOULD do) carry — and what stays
/// behind. No silent drops: anything present in the workbook that applications
/// cannot carry yet is listed under `excluded` with a reason.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishReport {
    pub included: Vec<PublishReportItem>,
    pub excluded: Vec<PublishReportItem>,
}

fn compute_publish_report(
    assembly: &PublishAssembly,
    state: &AppState,
    sheet_indices: &[usize],
    include_comments: bool,
    selection: &PublishSelection,
) -> PublishReport {
    let wb = &assembly.workbook;
    let published_sheet_ids: std::collections::HashSet<SheetId> = sheet_indices
        .iter()
        .filter_map(|&i| wb.sheets.get(i).map(|s| s.id))
        .collect();

    let item = |list: &mut Vec<PublishReportItem>, category: &str, count: usize, detail: &str| {
        if count > 0 {
            list.push(PublishReportItem {
                category: category.to_string(),
                count,
                detail: detail.to_string(),
            });
        }
    };

    let mut included: Vec<PublishReportItem> = Vec::new();
    item(&mut included, "sheets", sheet_indices.len(),
        "cell data, formulas, styles, merges, freeze panes, notes, hyperlinks, page setup");
    item(&mut included, "tables",
        wb.tables.iter().filter(|t| published_sheet_ids.contains(&t.sheet_id)).count(),
        "table objects (name, range, columns, style)");
    item(&mut included, "namedRanges",
        wb.named_ranges.iter()
            .filter(|nr| nr.sheet_id.map_or(true, |sid| published_sheet_ids.contains(&sid)))
            .count(),
        "workbook-scoped names + names on published sheets");
    item(&mut included, "charts",
        wb.charts.iter().filter(|c| published_sheet_ids.contains(&c.sheet_id)).count(),
        "charts on published sheets");
    item(&mut included, "sparklines",
        wb.sparklines.iter().filter(|s| published_sheet_ids.contains(&s.sheet_id)).count(),
        "sheets with sparkline groups");
    item(&mut included, "pivots", wb.pivot_definitions.len(),
        "pivot definitions (output recalculated by subscribers)");
    item(&mut included, "conditionalFormatting",
        wb.conditional_formats.iter().filter(|c| published_sheet_ids.contains(&c.sheet_id)).count(),
        "sheets with conditional formatting rules");
    item(&mut included, "dataValidation",
        wb.data_validations.iter().filter(|d| published_sheet_ids.contains(&d.sheet_id)).count(),
        "sheets with data validation");
    item(&mut included, "controls",
        wb.controls.iter().filter(|c| published_sheet_ids.contains(&c.sheet_id)).count(),
        "sheets with buttons/checkboxes (incl. onSelect wiring)");
    // Embedded pictures. Counted the same way publish SELECTS them — by scanning
    // the published sheets' control payloads for media: handles — so the report
    // cannot claim a different number from the one the application carries. Media
    // referenced only from an unpublished sheet is neither shipped nor counted.
    {
        let mut media_refs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for entry in wb.controls.iter().filter(|c| published_sheet_ids.contains(&c.sheet_id)) {
            calcula_format::media::visit_media_refs(&entry.controls, &mut |hash| {
                if wb.media.contains_key(hash) {
                    media_refs.insert(hash.to_string());
                }
            });
        }
        if !media_refs.is_empty() {
            item(&mut included, "media", media_refs.len(),
                "embedded pictures, content-addressed and deduplicated across versions");
        }
    }
    // Comment/scenario/outline counts come from the SAME carrier the publish
    // writes (Wave B), counted per object (threads/scenarios/groups) so the
    // report reads naturally.
    let comment_threads: usize = wb.comments.iter()
        .filter(|c| published_sheet_ids.contains(&c.sheet_id))
        .map(|c| c.comments.as_array().map_or(0, |a| a.len()))
        .sum();
    if include_comments {
        item(&mut included, "comments", comment_threads,
            "threaded comment threads on published sheets (opted in via 'Include comments')");
    }
    item(&mut included, "scenarios",
        wb.scenarios.iter()
            .filter(|s| published_sheet_ids.contains(&s.sheet_id))
            .map(|s| s.scenarios.as_array().map_or(0, |a| a.len()))
            .sum(),
        "saved what-if scenarios on published sheets");
    item(&mut included, "outlineGroups",
        wb.outlines.iter()
            .filter(|o| published_sheet_ids.contains(&o.sheet_id))
            .map(|o| {
                let groups = |key: &str| o.outline.get(key)
                    .and_then(|v| v.as_array())
                    .map_or(0, |a| a.len());
                groups("rowGroups") + groups("columnGroups")
            })
            .sum(),
        "row/column outline groups (structure + collapsed state)");
    item(&mut included, "cellBehaviors",
        wb.cell_behaviors.iter()
            .filter(|b| published_sheet_ids.contains(&b.sheet_id))
            .count(),
        "cell-behavior bindings on published sheets (the script itself ships as a consent-gated object script)");
    item(&mut included, "paneControls", wb.pane_controls.len(),
        "pane controls (config + current values); custom-control scripts ship as object scripts (consent-gated)");
    item(&mut included, "objectScripts",
        assembly.object_scripts.as_ref().map_or(0, |s| s.len()),
        "consent-gated on the subscriber; capability ceiling in the signed manifest");
    item(&mut included, "moduleScripts", wb.scripts.len(),
        "inert until explicitly run by the subscriber");
    item(&mut included, "notebooks", wb.notebooks.len(),
        "execution output stripped; inert until run");
    item(&mut included, "slicers",
        wb.slicers.iter().filter(|s| published_sheet_ids.contains(&s.sheet_id)).count(),
        "slicers on published sheets (position, style, selections, report connections)");
    item(&mut included, "ribbonFilters", wb.ribbon_filters.len(),
        "ribbon filters (BI-only; re-bound to the application's embedded data sources on pull)");
    item(&mut included, "pivotLayouts", wb.pivot_layouts.len(),
        "saved pivot layouts (DSL + source references)");
    item(&mut included, "documentTheme", 1,
        "applied on pull unless the subscriber customized their theme");
    item(&mut included, "extensionData", wb.extension_data.len(),
        "extension state (only keys you don't already have apply on pull)");
    item(&mut included, "dataSources", assembly.data_sources.len(),
        "BI model schema only — no data, no credentials");
    item(&mut included, "writebackRegions",
        assembly.writeback_regions.as_ref().map_or(0, |w| w.len()),
        "declared data-collection regions");

    let mut excluded: Vec<PublishReportItem> = Vec::new();
    item(&mut excluded, "workbookFiles", wb.user_files.len(),
        "workbook files (bookmarks, stored documents, filter state) are subscriber-local by policy");
    item(&mut excluded, "floatingRanges",
        wb.floating_ranges.iter().filter(|fr| published_sheet_ids.contains(&fr.host_sheet_id)).count(),
        "floating range OBJECTS do not distribute yet; their backing cell-store \
         sheets DO travel with the host sheet, so formulas referencing them stay \
         live — the subscriber just sees no floating object");
    if !include_comments {
        item(&mut excluded, "comments", comment_threads,
            "comments stay private unless 'Include comments' is checked");
    }
    // SHEET-level protection only. Cell LOCK state is a CellStyle attribute now
    // and therefore already travels inside the published styles.json — claiming
    // otherwise here would be a false statement in the fidelity report, which is
    // exactly the kind of drift this report exists to prevent.
    let protected = state.sheet_protection.read().map(|p| p.len()).unwrap_or(0);
    item(&mut excluded, "protection", protected,
        "sheet protection policy is not carried (a governance feature, not yet distributed); \
         per-cell locked/hidden DO travel, as cell formatting");
    // WORKBOOK STRUCTURE protection, which the "protection" line above does NOT
    // cover: that one counts `state.sheet_protection`, a different store. A
    // workbook whose author locked its structure published with no line at all
    // saying the lock did not travel.
    let workbook_protected = usize::from(wb.workbook_protection.is_some());
    item(&mut excluded, "workbookProtection", workbook_protected,
        "workbook structure protection is not carried (a governance feature, not yet distributed)");
    // WORKBOOK-SCOPED GRID DEFAULTS. An application's sheets are APPENDED to the
    // subscriber's existing workbook, and these two are one-per-workbook, so
    // applying the publisher's values would silently re-size every sheet the
    // subscriber already had. The published sheets' own explicit widths/heights
    // DO travel (layout.json); only the fallback for columns and rows the author
    // never touched reverts to the subscriber's default. Reported rather than
    // dropped in silence, because an author who set a 30px default row is
    // entitled to know their report will not open that way elsewhere.
    let non_default_grid_defaults = usize::from(
        (wb.default_row_height - ::persistence::DEFAULT_ROW_HEIGHT_PX).abs() > f64::EPSILON
            || (wb.default_column_width - ::persistence::DEFAULT_COLUMN_WIDTH_PX).abs()
                > f64::EPSILON,
    );
    item(&mut excluded, "gridDefaults", non_default_grid_defaults,
        "your default row height / column width are workbook-wide, and the application's sheets are added to the subscriber's own workbook; explicitly sized rows and columns do travel");
    // Per-connection "view as" RLS role selections. Deliberately not carried:
    // the selection is the PUBLISHER's impersonation of a role on their own
    // machine, and re-applying it on a subscriber would present that
    // subscriber's data through a role their identity may not hold.
    item(&mut excluded, "biRoleSelections", wb.bi_connection_roles.len(),
        "your 'view as' role selections stay with you; a subscriber sees the model through their own identity");
    let doc_props = [
        &wb.properties.title,
        &wb.properties.author,
        &wb.properties.subject,
        &wb.properties.description,
        &wb.properties.keywords,
        &wb.properties.category,
    ]
    .iter()
    .filter(|s| !s.is_empty())
    .count();
    item(&mut excluded, "documentProperties", doc_props,
        "document properties describe YOUR workbook; the application manifest carries the application's own identity");

    // PROVENANCE, last, because it qualifies rows above rather than adding a new
    // kind of content. The rows come from the SELECTION, not from a second walk:
    // the carrier and the disclosure must not be able to disagree about which
    // sheets are leaving.
    let (included_subscribed, excluded_subscribed) = subscribed_sheet_report_rows(selection);
    if let Some(row) = included_subscribed {
        included.push(row);
    }
    if let Some(row) = excluded_subscribed {
        excluded.push(row);
    }

    PublishReport { included, excluded }
}

// The `.calp` publish-coverage census table (`CALP_PUBLISH_COVERAGE`) lives at
// the END of this file, not next to the report it describes.
//
// It has to, and the reason is worth the four lines.
// `only_subscribe_and_install_may_create_a_calp_pin` isolates this file's
// production code by splitting the source at the FIRST test-gate attribute and
// keeping what comes before it. A test-gated item placed above the pinning call
// sites therefore truncates that scan to a string that contains none of them,
// and the guard passes over nothing at all while reporting success. (Writing
// the attribute out in THIS comment does it too — the split is textual and does
// not know a comment from code, which is how the first attempt at this note
// silently disarmed the guard.)


/// Serialize the OPEN WORKBOOK into `registry` by running the real publish.
///
/// Used by the working-copy diff to produce a comparable side without writing
/// anything to a real workspace. It deliberately goes through
/// `assemble_publish_workbook` and `calp::publish::publish` — the same two
/// calls `calp_publish` makes — rather than a purpose-built serializer, because
/// a second definition of "what an application contains" drifts from the real one
/// the first time an artifact type is added, and the whole value of a push
/// preview is that it describes the push that would actually happen.
///
/// The caller supplies an in-memory workspace; nothing reaches disk. One
/// documented side effect: like any first publish, this creates the profile's
/// signing keypair if it does not exist yet — the same file a real publish
/// would create, and idempotent.
#[allow(clippy::too_many_arguments)]
pub(crate) fn publish_into_for_preview(
    state: &State<AppState>,
    bi_state: &State<BiState>,
    pivot_state: &State<crate::pivot::types::PivotState>,
    script_state: &State<crate::scripting::types::ScriptState>,
    slicer_state: &State<crate::slicer::SlicerState>,
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: &State<crate::pane_control::PaneControlState>,
    user_files_state: &State<crate::persistence::UserFilesState>,
    timeline_slicer_state: &State<crate::timeline_slicer::TimelineSlicerState>,
    registry: &dyn calp::transport::WorkspaceTransport,
    // The WORKSPACE the caller is previewing against, beside the transport. The
    // transport cannot answer "is this the application my link targets", and the
    // published-name restoration has to ask.
    registry_path: &str,
    package_name: &str,
    version: SemVer,
    kind: &str,
    sheet_indices: Vec<usize>,
    include_comments: bool,
) -> Result<(), String> {
    let sheet_indices = resolve_publish_sheet_indices(state, kind, sheet_indices)?.indices;
    let assembly = assemble_publish_workbook(
        state,
        bi_state,
        pivot_state,
        script_state,
        slicer_state,
        ribbon_filter_state,
        pane_control_state,
        user_files_state,
        timeline_slicer_state,
        &sheet_indices,
        registry_path,
        package_name,
    )?;

    let PublishAssembly {
        workbook,
        writeback_regions,
        object_scripts,
        data_sources,
        model_writebacks,
        excluded_regions,
    } = assembly;

    let custom_objects = collect_cell_type_custom_objects(state, &sheet_indices)?;

    let request = calp::publish::PublishRequest {
        workbook: &workbook,
        package_name: package_name.to_string(),
        version,
        kind: "report".to_string(),
        // A preview application is created, not pushed: there is no prior version
        // in a fresh in-memory workspace, and no gate to satisfy.
        mode: PushMode::CreateNew,
        change_summary: String::new(),
        sheet_indices,
        now: chrono::Utc::now().to_rfc3339(),
        published_by: publisher_display_name(),
        writeback_regions,
        model_writebacks: if model_writebacks.is_empty() {
            None
        } else {
            Some(model_writebacks)
        },
        object_scripts,
        module_scripts: None,
        notebooks: None,
        data_sources,
        excluded_regions,
        custom_objects,
        include_comments,
        min_app_version: String::new(),
    };

    calp::publish::publish(registry, &request, &calcula_profile_dir())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A change summary is a headline for the version history, not the
/// documentation. Long enough for two sentences, short enough that the history
/// list stays readable.
const MAX_CHANGE_SUMMARY_CHARS: usize = 2000;

/// The publisher display name for this machine, derived from the signing
/// identity rather than accepted from the caller.
fn publisher_display_name() -> String {
    calp::signing::PublisherKeypair::load_existing(&calcula_profile_dir())
        .ok()
        .flatten()
        .map(|k| k.display_name())
        .unwrap_or_else(|| {
            std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .unwrap_or_else(|_| "unknown".to_string())
        })
}

/// Turn the wire `mode` + `expectedBaseVersion` into a [`calp::PushMode`].
///
/// The wire form is two loose fields; the core form is an enum where `Update`
/// cannot exist without a base version. Converting here means the impossible
/// combination ("update, but I won't say from what") is rejected at the edge
/// with a sentence, rather than being represented at all.
pub(crate) fn parse_push_mode(params: &PublishParams) -> Result<calp::PushMode, String> {
    match params.mode.as_deref().unwrap_or("createNew") {
        "createNew" => Ok(calp::PushMode::CreateNew),
        "update" => {
            let base = params
                .expected_base_version
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| {
                    "CALP_PUSH_NO_BASE: An update must say which version it was based on. \
                     Re-open the push dialog so it can read the workbook's working-copy link."
                        .to_string()
                })?;
            Ok(calp::PushMode::Update {
                expected_base: SemVer::parse(base).map_err(|e| e.to_string())?,
            })
        }
        other => Err(format!(
            "Unknown publish mode '{other}' (expected \"createNew\" or \"update\")."
        )),
    }
}

/// Publish selected sheets to a local workspace.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn calp_publish(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    bi_state: State<BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    params: PublishParams,
    window: tauri::Window,
) -> Result<PublishResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // ---- PHASE A: the gates only this layer can run ------------------------
    // Workspace-fact gates (mode, base version, monotonic version, key
    // continuity) live in core `publish()` under the workspace lock, so every
    // caller gets them. What is left here is what needs WORKBOOK state, which
    // core cannot see.
    let push_mode = parse_push_mode(&params)?;

    // GATE: a working copy pushes to ITS application. Publishing into a different
    // application from a linked workbook is either a typo or a misunderstanding,
    // and both are cheaper to catch here than to discover in a workspace.
    // A structured code, not prose, because the remedy is a UI branch: offer
    // "publish as a new application" rather than a message the user must decode.
    if matches!(push_mode, calp::PushMode::Update { .. }) {
        let link = state.working_copy_link.read().map_err(|e| e.to_string())?;
        match link.as_ref() {
            None => {
                return Err(format!(
                    "CALP_PUSH_NOT_LINKED: This workbook is not a working copy of '{}'. \
                     Open the application for editing first (Distribution > Open Application \
                     for Editing), or publish this workbook as a NEW application.",
                    params.package_name
                ));
            }
            Some(l) if !l.targets(&params.registry_path, &params.package_name) => {
                return Err(format!(
                    "CALP_PUSH_WRONG_TARGET: This workbook is a working copy of '{}' \
                     ({}), not of '{}'. Push it to the application it came from, or publish \
                     it as a NEW application.",
                    l.package_name, l.registry_url, params.package_name
                ));
            }
            Some(_) => {}
        }
    }

    // GATE: a SUBSCRIBER may never push to the application it subscribes to. Its
    // sheets carry freshly-minted local ids (pull mints them deliberately), so
    // the push would hand the application a different identity and every other
    // subscriber's next refresh would see every sheet removed and re-added,
    // orphaning their overrides. This is the identity trap, refused by name.
    {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        if subscribes_to(
            &subs.subscriptions,
            &params.registry_path,
            &params.package_name,
        ) {
            return Err(format!(
                "CALP_PUSH_IS_SUBSCRIBER: This workbook SUBSCRIBES to '{}' at {} — its sheets \
                 are a local copy with their own identity, so publishing from here would look \
                 to every other subscriber like every sheet was deleted and replaced, and \
                 would discard their local edits. To change the application itself, use \
                 Distribution > Open Application for Editing.",
                params.package_name, params.registry_path
            ));
        }
    }

    // GATE: a push must say what changed. Checked here as well as in core so
    // the user is told before a full workbook assembly runs.
    if matches!(push_mode, calp::PushMode::Update { .. }) {
        let summary = params.change_summary.trim();
        if summary.is_empty() {
            return Err(format!(
                "CALP_PUSH_NEEDS_SUMMARY: Say what changed in '{}', in a sentence or two. \
                 Subscribers and co-developers read it in the version history.",
                params.package_name
            ));
        }
        if summary.chars().count() > MAX_CHANGE_SUMMARY_CHARS {
            return Err(format!(
                "CALP_PUSH_NEEDS_SUMMARY: The change summary is too long ({} characters, \
                 limit {}). It is a headline, not the documentation.",
                summary.chars().count(),
                MAX_CHANGE_SUMMARY_CHARS
            ));
        }
    }

    // A CANCELLED RECALCULATION MUST NOT BE PUBLISHED.
    //
    // This is a hard refusal, unlike the save path, and the asymmetry is
    // deliberate. Saving a half-calculated workbook keeps the mess on the
    // author's own machine, where the status bar is still saying "Calculate"
    // and they can fix it. Publishing SENDS it: every subscriber pulls cells
    // that look authoritative and are silently stale, with no indicator,
    // because the pending set is session state that does not travel. A report
    // nobody can tell is wrong is a data-correctness bug in the distribution
    // story, not a UI nicety — so the author is told to finish the calculation
    // (F9) rather than being allowed to ship it by accident.
    if let Ok(pending) = state.pending_recalc.read() {
        if let Some(p) = pending.as_ref().filter(|p| !p.is_empty()) {
            return Err(format!(
                "Cannot publish: {} cell(s) still hold values from before a cancelled \
                 recalculation. Press F9 to finish calculating, then publish.",
                p.cells.len()
            ));
        }
    }

    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;

    // The `workspace.calcula` pointer file is NOT written here. It is written by
    // `LocalWorkspace::write_application_manifest`, because that is the one call
    // every route into a workspace makes — this command, the model publish, the
    // library publish and the skin pack. It sat here instead until an audit
    // found that two of those four produced markerless workspaces.

    // GATE: an HTTP workspace is read-only. Refusing here, before the workbook is
    // assembled and megabytes are serialized, turns a confusing deep transport
    // error into a sentence about the workspace.
    if params.registry_path.trim_start().to_lowercase().starts_with("http") {
        return Err(format!(
            "CALP_PUSH_READONLY_REGISTRY: '{}' is an HTTP workspace, which can only be read \
             from. Push to a file-share workspace instead.",
            params.registry_path
        ));
    }

    let version = SemVer::parse(&params.version)
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    // Empty selection = every sheet — the SAME normalization the preview
    // applies, so the dry-run report can never describe a different application
    // than the publish that follows it (previously an empty selection
    // previewed the whole workbook but published a zero-sheet application).
    //
    // ONE EXCEPTION, and it is the reason libraries were unpublishable: a
    // LIBRARY application's payload is the workbook's standalone MODULE SCRIPTS
    // (modules/{id}.json — see library_commands.rs), not its sheets. Defaulting
    // an empty selection to "every sheet" is right for a report and wrong here:
    // it would ship the author's entire workbook — data and all — to a shared
    // workspace as a side effect of publishing a function library. A library
    // therefore publishes ZERO sheets unless the author names sheets explicitly.
    //
    // THE LIBRARY RULE NOW LIVES IN THE RESOLVER, not here. It used to be this
    // branch, which `calp_publish_preview` did not have — so a library preview
    // described every sheet for a publish that shipped none.
    let selection = resolve_publish_sheet_indices(&state, &params.kind, params.sheet_indices)?;
    let sheet_indices = selection.indices.clone();

    let assembly = assemble_publish_workbook(
        &state,
        &bi_state,
        &pivot_state,
        &script_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &user_files_state,
        &timeline_slicer_state,
        &sheet_indices,
        &params.registry_path,
        &params.package_name,
    )?;
    let report =
        compute_publish_report(&assembly, &state, &sheet_indices, params.include_comments, &selection);

    let PublishAssembly {
        workbook,
        writeback_regions,
        object_scripts,
        data_sources,
        model_writebacks,
        excluded_regions,
    } = assembly;

    // Cell types travel via the generic custom-object channel (brick 4
    // dogfood): one per selected sheet, kind "cellType", payload = the sheet's
    // opaque cell-type assignments. Frontend providers can add more via
    // params.custom_objects (merged in — moved out of params before the request
    // literal consumes its other fields).
    let frontend_custom_objects = params.custom_objects.unwrap_or_default();
    let mut custom_objects = collect_cell_type_custom_objects(&state, &sheet_indices)?;
    custom_objects.extend(frontend_custom_objects.into_iter().map(Into::into));

    let mut request = calp::publish::PublishRequest {
        workbook: &workbook,
        package_name: params.package_name,
        version,
        kind: params.kind,
        mode: push_mode,
        change_summary: params.change_summary.clone(),
        sheet_indices,
        now: now.clone(),
        // Stamped from the signing identity, not from the caller. `published_by`
        // sits next to a verified `publisher_key` in the version list, and a
        // display name the caller can type is a display name that can disagree
        // with the key beside it. (The scripted publish path already refused to
        // trust a caller-supplied value; this makes both paths agree.)
        published_by: publisher_display_name(),
        writeback_regions,
        model_writebacks: if model_writebacks.is_empty() {
            None
        } else {
            Some(model_writebacks)
        },
        object_scripts,
        // None => publish all standalone module scripts / notebooks carried in
        // the carrier above (C8). They distribute as inert, transparent data.
        module_scripts: None,
        notebooks: None,
        data_sources,
        excluded_regions,
        custom_objects,
        include_comments: params.include_comments,
        min_app_version: String::new(),
    };
    // Compatibility stamp: an application carrying Wave A/B artifacts (slicers,
    // ribbon filters, pivot layouts, extension data, comments/scenarios/
    // outlines, non-default theme) declares THIS app's version as its minimum
    // — an older app's pull fails honestly at the compat gate instead of
    // silently dropping those artifacts. Same version source the gate
    // compares against (set_host_app_version(env!("CARGO_PKG_VERSION")) at
    // startup). Cell-only applications stay pullable by older apps.
    if calp::publish::carries_wave_content(&request)
        // Model writeback declarations are inert to pre-feature apps (they
        // only consult writeback_regions), but the columns' VALUES would be
        // invisible there (pre-v21 engines refuse the model anyway) — declare
        // this app's version as the minimum for an honest gate.
        || request
            .model_writebacks
            .as_ref()
            .is_some_and(|m| !m.is_empty())
        // Custom objects (e.g. calcula.modelOverlay carrying workbook-layer
        // measures) are exactly the silent-drop class this gate exists for: an
        // app without distributable-object providers would pull "successfully"
        // and never materialize them.
        || !request.custom_objects.is_empty()
    {
        request.min_app_version = env!("CARGO_PKG_VERSION").to_string();
    }

    // ---- PHASE B: core runs the workspace-fact gates under the workspace lock --
    let result = calp::publish::publish(&registry, &request, &calcula_profile_dir())
        .map_err(|e| e.to_string())?;

    // The push landed. Record it in the workbook's own link, so the NEXT push
    // knows its base — and so a standalone workbook that just created an application
    // becomes that application's working copy without a separate step.
    {
        // THE NAMES THAT WERE ACTUALLY PUBLISHED, read back off the assembled
        // carrier — never off `state.sheet_names`.
        //
        // The link is the record of what the application calls each sheet, and
        // it is what the next push's name restoration reads. Rebuilding it from
        // the LIVE tab names overwrote that record with the local ones, so the
        // restoration worked on the first push and never again: push #2 found
        // the local name already equal to the "published" name, changed nothing,
        // and the collision rename shipped after all. The block that restores
        // the names and this one disagreed about which names were published.
        //
        // What actually SHIPPED, for the same reason and off the same carrier:
        // the next push filters against this, so a script added to the
        // application by this push belongs to it from now on.
        let published_script_ids: Vec<String> =
            request.workbook.scripts.iter().map(|s| s.id.clone()).collect();
        let published_notebook_ids: Vec<String> =
            request.workbook.notebooks.iter().map(|n| n.id.clone()).collect();
        let published_name_keys: Vec<String> = request
            .workbook
            .named_ranges
            .iter()
            .map(|nr| nr.name.to_uppercase())
            .collect();

        // `request.workbook` is the carrier `assemble_publish_workbook` produced
        // and `publish()` serialized, so its sheet names ARE the manifest's.
        let published_sheets: Vec<calp::WorkingCopySheetRef> = request
            .sheet_indices
            .iter()
            .filter_map(|&i| {
                let sheet = request.workbook.sheets.get(i)?;
                Some(calp::WorkingCopySheetRef {
                    sheet_id: sheet.id,
                    name: sheet.name.clone(),
                })
            })
            .collect();
        // A push CHANGES what this workbook is (its base version moved), which
        // is saved state — so this is the command's one `mutates` arm, taken
        // only after the workspace has actually accepted the version.
        let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut link = state.working_copy_link.write(&effect).map_err(|e| e.to_string())?;
        match link.as_mut() {
            Some(existing) => existing.record_push(
                &result.version,
                &now,
                published_sheets,
                published_script_ids.clone(),
                published_notebook_ids.clone(),
                published_name_keys.clone(),
            ),
            None => {
                let mut fresh = calp::WorkingCopyLink::new(
                    &params.registry_path,
                    &result.package_name,
                    &request.kind,
                    &result.version,
                    &now,
                    published_sheets.clone(),
                );
                fresh.record_push(
                    &result.version,
                    &now,
                    published_sheets,
                    published_script_ids.clone(),
                    published_notebook_ids.clone(),
                published_name_keys.clone(),
                );
                *link = Some(fresh);
            }
        }
    }

    // Audit — always recorded (publish is egress; see AuditEvent docs).
    {
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)) {
            let mut extra = std::collections::HashMap::new();
            extra.insert(
                "package".to_string(),
                serde_json::Value::String(result.package_name.clone()),
            );
            extra.insert(
                "version".to_string(),
                serde_json::Value::String(result.version.clone()),
            );
            extra.insert(
                "baseVersion".to_string(),
                serde_json::Value::String(match &request.mode {
                    calp::PushMode::CreateNew => String::new(),
                    calp::PushMode::Update { expected_base } => expected_base.to_string(),
                }),
            );
            extra.insert(
                "registry".to_string(),
                serde_json::Value::String(params.registry_path.clone()),
            );
            audit.record_with_extra(
                calp::audit::AuditEvent::Published,
                &format!(
                    "Published {} v{} ({} sheets)",
                    result.package_name, result.version, result.sheets_published
                ),
                &user,
                &now,
                extra,
            );
        }
    }

    Ok(PublishResponse {
        package_name: result.package_name,
        version: result.version,
        sheets_published: result.sheets_published,
        tables_published: result.tables_published,
        named_ranges_published: result.named_ranges_published,
        scripts_published: result.scripts_published,
        modules_published: result.modules_published,
        notebooks_published: result.notebooks_published,
        report,
        warnings: result.warnings,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishModelParams {
    pub registry_path: String,
    pub package_name: String,
    pub version: String,
    pub published_by: String,
    /// The BI connection whose model to publish (EntityId as UUID string).
    pub connection_id: String,
}

/// Publish a single BI model as a MODEL-ONLY application (kind "dataset", zero
/// sheets). This makes the .calp the distribution unit for models — signed
/// (Ed25519 + TOFU), versioned (semver pins), min-app-gated — replacing loose
/// .json file hand-off. Subscribing materializes a live BI connection
/// (schema only, no data, no credentials; the subscriber connects with their
/// own credentials, so RLS is preserved).
#[tauri::command]
pub fn calp_publish_model(
    state: State<AppState>,
    bi_state: State<BiState>,
    params: PublishModelParams,
    window: tauri::Window,
) -> Result<PublishResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let version = SemVer::parse(&params.version).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    // Capture ONLY the requested connection as an application data source (the
    // capture serializes the live engine model, credential-free).
    let (all_sources, all_model_writebacks) = capture_bi_data_sources(&state, &bi_state)?;
    let data_sources: Vec<calp::publish::PublishDataSource> = all_sources
        .into_iter()
        .filter(|ds| ds.id == params.connection_id)
        .collect();
    let model_writebacks: Vec<calp::writeback::ModelWritebackDeclaration> = all_model_writebacks
        .into_iter()
        .filter(|d| d.data_source_id == params.connection_id)
        .collect();
    if data_sources.is_empty() {
        // capture_bi_data_sources silently skips a busy engine — distinguish
        // that from a genuinely missing connection so the error is actionable.
        let busy = {
            let connections = bi_state.connections.lock().map_err(|e| e.to_string())?;
            connections.values().any(|c| {
                c.id.to_string() == params.connection_id
                    && c.engine.as_ref().is_some_and(|arc| arc.try_lock().is_err())
            })
        };
        return Err(if busy {
            "The connection's engine is busy (a query or refresh is running) — retry in a moment."
                .to_string()
        } else {
            "Connection not found or its model is not loaded (open Data > Connections)"
                .to_string()
        });
    }
    let model_name = data_sources[0].name.clone();

    // A minimal carrier: zero sheets, no scripts/tables/names — the application is
    // the model. Workbook::new()'s default sheet is never published because
    // sheet_indices is empty.
    let workbook = persistence::Workbook::new();
    let request = calp::publish::PublishRequest {
        workbook: &workbook,
        package_name: params.package_name,
        version,
        kind: "dataset".to_string(),
        mode: PushMode::CreateNew,
        change_summary: String::new(),
        sheet_indices: Vec::new(),
        now: now.clone(),
        published_by: params.published_by,
        writeback_regions: None,
        model_writebacks: if model_writebacks.is_empty() {
            None
        } else {
            Some(model_writebacks)
        },
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources,
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false, // dataset application: no sheets, no comments
        // Model-only application: no Wave A/B artifacts, so no minimum — it stays
        // pullable by older apps. Writeback columns are the exception: a
        // pre-v21 engine refuses the model, so gate honestly.
        min_app_version: String::new(),
    };
    let mut request = request;
    if request
        .model_writebacks
        .as_ref()
        .is_some_and(|m| !m.is_empty())
    {
        request.min_app_version = env!("CARGO_PKG_VERSION").to_string();
    }
    let result = calp::publish::publish(&registry, &request, &calcula_profile_dir())
        .map_err(|e| e.to_string())?;

    // Audit (B4)
    {
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)) {
            audit.record(
                calp::audit::AuditEvent::Published,
                &format!(
                    "Published model '{}' as dataset application {} v{}",
                    model_name, result.package_name, result.version
                ),
                &user,
                &now,
            );
        }
    }

    let report = PublishReport {
        included: vec![PublishReportItem {
            category: "dataSources".to_string(),
            count: 1,
            detail: format!(
                "model '{}' — schema only: no data, no credentials",
                model_name
            ),
        }],
        excluded: Vec::new(),
    };

    Ok(PublishResponse {
        package_name: result.package_name,
        version: result.version,
        sheets_published: result.sheets_published,
        tables_published: result.tables_published,
        named_ranges_published: result.named_ranges_published,
        scripts_published: result.scripts_published,
        modules_published: result.modules_published,
        notebooks_published: result.notebooks_published,
        report,
        warnings: result.warnings,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPreviewParams {
    /// Sheets to include (workbook indices). None or empty => all sheets.
    #[serde(default)]
    pub sheet_indices: Option<Vec<usize>>,
    /// Mirror of PublishParams.include_comments, so the dry-run report shows
    /// comments exactly where the real publish would put them (default false).
    #[serde(default)]
    pub include_comments: bool,
    /// The application's kind, so the dry run resolves the SAME sheets a publish
    /// would. Absent means "report" — the ordinary case. Only `"library"`
    /// changes the answer (zero sheets by default), and a library preview that
    /// omitted it described every sheet for a publish that ships none.
    #[serde(default)]
    pub kind: String,
    /// The push target, when the caller is previewing an actual push rather
    /// than running a content-only dry run. Supplying both turns the response's
    /// `gates` field on.
    #[serde(default)]
    pub registry_path: Option<String>,
    #[serde(default)]
    pub package_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPreviewResponse {
    /// Names of the sheets the preview covered, in application order.
    pub sheet_names: Vec<String>,
    pub report: PublishReport,
    /// The SAME disclosure warnings a real publish of this selection would
    /// emit (core `dropdown_reference_warnings` over the same carrier) — e.g.
    /// a dropdown pane control whose CellRange item source references a sheet
    /// outside the selection. Non-blocking; the artifact is never rewritten.
    pub warnings: Vec<String>,
    /// The state of every push gate that can be evaluated WITHOUT publishing,
    /// so the dialog can show the user where they stand before they write a
    /// change summary — rather than making them discover a refusal afterwards.
    ///
    /// Absent when the preview was asked for without a target application (the
    /// plain dry-run the Application Explorer's "Preview publish" button runs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gates: Option<PushGateStatus>,
    /// Every sheet the author may choose from, with its TRUE workbook index and
    /// its provenance.
    ///
    /// `sheet_names` above is a different question — the names of what the
    /// PREVIEWED selection covered. A dialog that builds its checkbox list from
    /// that has no way to name a sheet the default withheld, and no way to map a
    /// checkbox back to a workbook index except by position, which stops being
    /// true the moment the default excludes anything.
    #[serde(default)]
    pub sheets: Vec<PublishPreviewSheet>,
    /// The indices an empty selection resolves to. The dialog sends these
    /// EXPLICITLY rather than `[]`, so "everything ticked" can never silently
    /// mean "everything minus the subscribed ones".
    #[serde(default)]
    pub default_sheet_indices: Vec<usize>,
}

/// One row of the publish dialog's sheet list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPreviewSheet {
    /// TRUE workbook index — the value to send back in `sheetIndices`.
    pub index: usize,
    /// The workbook's stable sheet uuid, so the dialog can tell "this sheet was
    /// in the base version" from "a sheet with the same NAME was".
    ///
    /// A working copy's ids ARE the application's, so this is directly
    /// comparable with `WorkingCopyLink::base_sheets[].sheet_id`. Comparing the
    /// NAMES instead is wrong the moment a name moves, and additive checkout
    /// moves names as a matter of course: pulling an application's `Sheet1` into
    /// a workbook that already has one renames it `Sheet1 (2)`, so the
    /// application's own sheet stops matching its base entry while the author's
    /// unrelated `Sheet1` starts matching it.
    pub sheet_id: String,
    pub name: String,
    /// The application this sheet came from; empty when it is the author's own.
    pub subscribed_to: String,
    /// Whether a DEFAULT publish would include it (i.e. ticked on open).
    pub default_selected: bool,
}

/// Where a prospective push stands against each gate.
///
/// Advisory ONLY. The authoritative evaluation happens inside core `publish()`
/// under the workspace lock, because anything checked out here and acted on
/// later is a TOCTOU window on a share two people publish to. What this buys is
/// a dialog that can be honest BEFORE the user does the work, not a shortcut
/// past the gate.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushGateStatus {
    /// "linked" | "notLinked" | "wrongTarget" | "subscriber"
    pub link_status: String,
    /// The base version this workbook would declare (from its working-copy link).
    pub expected_base: String,
    /// The workspace's current head. Empty when unreachable.
    pub registry_latest: String,
    pub latest_published_by: String,
    /// True when the head has moved past `expected_base` — a push would be
    /// refused by the base-version gate.
    pub base_stale: bool,
    /// True when this machine holds the key that signed the head (or the
    /// application has no signed head yet).
    pub key_continuity_ok: bool,
    /// True when the workspace can be written to at all (a file share, not HTTP).
    pub registry_writable: bool,
    /// Suggested next versions from the head.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_next: Option<SuggestedVersions>,
    /// Why the workspace could not be consulted, when it could not be.
    pub registry_error: String,
}

/// Dry-run of calp_publish: assemble the EXACT carrier a publish would use
/// (same collector, same filters) and report what would ship vs stay behind —
/// without writing anything to any workspace.
#[tauri::command]
pub fn calp_publish_preview(
    state: State<AppState>,
    bi_state: State<BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    params: PublishPreviewParams,
    window: tauri::Window,
) -> Result<PublishPreviewResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let selection = resolve_publish_sheet_indices(
        &state,
        &params.kind,
        params.sheet_indices.unwrap_or_default(),
    )?;
    let sheet_indices = selection.indices.clone();

    // The link's own target, for a dry run that names none — see the call below.
    let link_target: (String, String) = {
        let link = state.working_copy_link.read().map_err(|e| e.to_string())?;
        link.as_ref()
            .map(|l| (l.registry_url.clone(), l.package_name.clone()))
            .unwrap_or_default()
    };

    let assembly = assemble_publish_workbook(
        &state,
        &bi_state,
        &pivot_state,
        &script_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &user_files_state,
        &timeline_slicer_state,
        &sheet_indices,
        // A content-only dry run names no target, so fall back to the link's own —
        // the preview then restores exactly the names its push would.
        params.registry_path.as_deref().unwrap_or(&link_target.0),
        params.package_name.as_deref().unwrap_or(&link_target.1),
    )?;
    let report =
        compute_publish_report(&assembly, &state, &sheet_indices, params.include_comments, &selection);
    // Same checks core publish runs, over the same carrier — so the author sees
    // dangling dropdown references AND macro-linked buttons whose macro is not in
    // the module set at PREVIEW time, not only after the artifact is written.
    let mut warnings =
        calp::publish::dropdown_reference_warnings(&assembly.workbook, &sheet_indices);
    // Preview carries the default module set (all workbook module scripts), which
    // is exactly what a default publish ships — so a linked macro is "missing"
    // only if it genuinely is not among the workbook's modules.
    let published_module_ids: std::collections::HashSet<String> = assembly
        .workbook
        .scripts
        .iter()
        .map(|s| s.id.clone())
        .collect();
    warnings.extend(calp::publish::macro_reference_warnings(
        &assembly.workbook,
        &sheet_indices,
        &published_module_ids,
    ));
    let sheet_names = sheet_indices
        .iter()
        .filter_map(|&i| assembly.workbook.sheets.get(i).map(|s| s.name.clone()))
        .collect();

    let gates = match (params.registry_path.as_deref(), params.package_name.as_deref()) {
        (Some(registry_path), Some(package_name)) => {
            Some(evaluate_push_gates(&state, registry_path, package_name)?)
        }
        _ => None,
    };

    let sheets = publish_preview_sheet_list(&state, &selection)?;
    Ok(PublishPreviewResponse {
        sheet_names,
        report,
        warnings,
        gates,
        sheets,
        default_sheet_indices: selection.indices.clone(),
    })
}

/// Evaluate every push gate that can be answered without publishing.
///
/// Failure-tolerant by design: an unreachable workspace reports itself in
/// `registry_error` and leaves the workspace-derived fields empty, rather than
/// failing the whole preview. The dialog then shows what it does know (which
/// application, which base) instead of nothing at all.
fn evaluate_push_gates(
    state: &AppState,
    registry_path: &str,
    package_name: &str,
) -> Result<PushGateStatus, String> {
    let link = state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    // THE SAME QUESTION THE REAL GATE ASKS, through the same function. This
    // hand-rolled its own walk and ignored `registry_path` entirely, so the
    // advisory panel could report "subscriber" for a target the real gate would
    // let through — a preview disagreeing with the publish it previews.
    let subscribes_to_target = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        subscribes_to(&subs.subscriptions, registry_path, package_name)
    };

    let (link_status, expected_base) = if subscribes_to_target {
        ("subscriber".to_string(), String::new())
    } else {
        match link.as_ref() {
            None => ("notLinked".to_string(), String::new()),
            Some(l) if l.targets(registry_path, package_name) => {
                ("linked".to_string(), l.base_version.clone())
            }
            Some(_) => ("wrongTarget".to_string(), String::new()),
        }
    };

    let registry_writable = !registry_path.trim_start().to_lowercase().starts_with("http");

    let mut status = PushGateStatus {
        link_status,
        expected_base: expected_base.clone(),
        registry_latest: String::new(),
        latest_published_by: String::new(),
        base_stale: false,
        // No head yet (an application about to be created) is not a continuity
        // failure — there is nothing to be continuous WITH.
        key_continuity_ok: true,
        registry_writable,
        suggested_next: None,
        registry_error: String::new(),
    };

    match crate::calp_registry::open_workspace_scoped(registry_path) {
        Ok((registry, _scope)) => match registry.get_application_manifest(package_name) {
            Ok(manifest) => {
                if let Some(head) = calp::head_version(&manifest) {
                    status.registry_latest = head.to_string();
                    status.latest_published_by = manifest
                        .versions
                        .iter()
                        .find(|e| e.version == head.to_string())
                        .map(|e| e.published_by.clone())
                        .unwrap_or_default();
                    status.base_stale =
                        !expected_base.is_empty() && expected_base != head.to_string();
                    status.suggested_next = Some(SuggestedVersions {
                        major: SemVer::new(head.major + 1, 0, 0).to_string(),
                        minor: SemVer::new(head.major, head.minor + 1, 0).to_string(),
                        patch: SemVer::new(head.major, head.minor, head.patch + 1).to_string(),
                    });
                    status.key_continuity_ok = calp::publish::resolve_authorized_keys(
                        &registry,
                        package_name,
                        &head,
                    )
                    .map(|keys| {
                        keys.is_empty()
                            || keys.iter().any(|k| {
                                calp::signing::profile_holds_publisher_key(
                                    &calcula_profile_dir(),
                                    k,
                                )
                                .unwrap_or(false)
                            })
                    })
                    .unwrap_or(false);
                }
            }
            // No such application: a create, not an update. Not an error.
            Err(_) => {}
        },
        Err(e) => status.registry_error = e.to_string(),
    }

    Ok(status)
}

/// Materialize ONE application's distributed standalone module scripts + notebooks
/// into ScriptState (C8). Used by BOTH the initial pull and the version refresh so
/// upstream updates propagate identically. Distributed standalone scripts/notebooks
/// are upstream-owned and inert — they appear in the workbook's script/notebook list
/// but are NEVER auto-executed; they run only on explicit, sandboxed user action.
///
/// Provenance-driven semantics (parity with distributed object scripts):
/// - REMOVAL-ON-REFRESH: a module/notebook this application shipped before but no longer
///   ships is dropped (so a publisher's deletion reaches the subscriber).
/// - UPDATE: a same-id entry owned by THIS application is replaced (the corrected
///   version lands).
/// - PRESERVE-LOCAL: a same-id entry that is subscriber-authored (no source_package)
///   or owned by a DIFFERENT application is kept — an application never silently shadows it
///   (the incoming one is skipped + logged). To customize distributed content, copy
///   it to a NEW id. `modules`/`notebooks` are already stamped source_package =
///   package_name at pull. Notebooks arrive run-clean (exec metadata stripped at pull).
fn materialize_distributed_scripts(
    effect: &crate::document_effect::DocumentEffect,
    script_state: &crate::scripting::types::ScriptState,
    package_name: &str,
    modules: &[persistence::SavedScript],
    notebooks: &[persistence::SavedNotebook],
) -> Result<(Vec<(String, String)>, Vec<(String, String)>, bool), String> {
    use std::collections::HashSet;

    // THE ENFORCEMENT DOOR for the host's reserved id namespace. Every path that
    // materializes distributed modules/notebooks converges here, and this runs
    // before the first lock is taken, so a refusal writes nothing. The callers
    // gate again EARLIER, before their `DocumentEffect`, so a refused
    // subscribe/checkout/refresh also leaves the document CLEAN — two checks,
    // two jobs: theirs is about the dirty flag, this one is the invariant.
    refuse_reserved_distributed_script_ids(package_name, modules, notebooks)?;

    // (id, name) of the modules/notebooks ACTUALLY inserted — conflict-skipped
    // ones excluded, so the provenance ledger never attributes a preserved
    // local (or other-application) document to this application.
    let mut applied_modules: Vec<(String, String)> = Vec::new();
    let mut applied_notebooks: Vec<(String, String)> = Vec::new();
    let custom_functions_changed;

    {
        use crate::scripting::types::{ScriptScope, WorkbookScript};
        let mut scripts = script_state.workbook_scripts.write(effect).map_err(|e| e.to_string())?;
        let new_ids: HashSet<&str> = modules.iter().map(|m| m.id.as_str()).collect();
        // Removal-on-refresh: drop this application's prior modules it no longer
        // ships. The reserved Custom Functions record is exempt: it is
        // subscriber-owned merged data, reconciled per-function below.
        scripts.retain(|id, s| {
            id == CUSTOM_FUNCTIONS_LIB_ID
                || !(s.source_package.as_deref() == Some(package_name)
                    && !new_ids.contains(id.as_str()))
        });

        // Custom Functions library: NEVER goes through the same-id conflict
        // policy — the fixed record id collides BY DESIGN across every
        // workbook, so preserve-local would silently drop the publisher's
        // entire library whenever the subscriber authored even one function.
        // Merge per function instead (None = application no longer ships one, so
        // its previously-merged functions are stripped).
        let incoming_lib = modules
            .iter()
            .find(|m| m.id == CUSTOM_FUNCTIONS_LIB_ID)
            .map(|m| m.source.as_str());
        custom_functions_changed =
            merge_custom_function_library(&mut scripts, package_name, incoming_lib);

        for module in modules {
            if module.id == CUSTOM_FUNCTIONS_LIB_ID {
                continue; // handled by the per-function merge above
            }
            // Conflict = an existing same-id entry NOT owned by this application
            // (local, or a different application). Compute (and clone) up front so the
            // immutable borrow is released before the insert.
            let conflict: Option<Option<String>> = scripts.get(&module.id).and_then(|e| {
                if e.source_package.as_deref() == Some(package_name) { None }
                else { Some(e.source_package.clone()) }
            });
            if let Some(existing_owner) = conflict {
                crate::log_warn!(
                    "CALP",
                    "module '{}' from application '{}' not applied: id already used by {}",
                    module.id, package_name,
                    existing_owner.map(|p| format!("application '{}'", p))
                        .unwrap_or_else(|| "a local script".to_string()),
                );
                continue;
            }
            applied_modules.push((module.id.clone(), module.name.clone()));
            scripts.insert(
                module.id.clone(),
                WorkbookScript {
                    id: module.id.clone(),
                    name: module.name.clone(),
                    description: module.description.clone(),
                    source: module.source.clone(),
                    scope: match &module.scope {
                        persistence::SavedScriptScope::Workbook => ScriptScope::Workbook,
                        persistence::SavedScriptScope::Sheet { name } => {
                            ScriptScope::Sheet { name: name.clone() }
                        }
                    },
                    source_package: module.source_package.clone(),
                },
            );
        }
    }

    {
        use crate::scripting::types::{NotebookCell, NotebookDocument};
        let mut nbs = script_state.workbook_notebooks.write(effect).map_err(|e| e.to_string())?;
        let new_ids: HashSet<&str> = notebooks.iter().map(|n| n.id.as_str()).collect();
        nbs.retain(|id, n| {
            !(n.source_package.as_deref() == Some(package_name) && !new_ids.contains(id.as_str()))
        });
        for nb in notebooks {
            let conflict: Option<Option<String>> = nbs.get(&nb.id).and_then(|e| {
                if e.source_package.as_deref() == Some(package_name) { None }
                else { Some(e.source_package.clone()) }
            });
            if let Some(existing_owner) = conflict {
                crate::log_warn!(
                    "CALP",
                    "notebook '{}' from application '{}' not applied: id already used by {}",
                    nb.id, package_name,
                    existing_owner.map(|p| format!("application '{}'", p))
                        .unwrap_or_else(|| "a local notebook".to_string()),
                );
                continue;
            }
            applied_notebooks.push((nb.id.clone(), nb.name.clone()));
            nbs.insert(
                nb.id.clone(),
                NotebookDocument {
                    id: nb.id.clone(),
                    name: nb.name.clone(),
                    cells: nb
                        .cells
                        .iter()
                        .map(|c| NotebookCell {
                            id: c.id.clone(),
                            source: c.source.clone(),
                            last_output: c
                                .last_output
                                .iter()
                                .map(crate::persistence::saved_output_to_item)
                                .collect(),
                            last_error: c.last_error.clone(),
                            cells_modified: c.cells_modified,
                            duration_ms: c.duration_ms,
                            execution_index: c.execution_index,
                        })
                        .collect(),
                    source_package: nb.source_package.clone(),
                },
            );
        }
    }
    Ok((applied_modules, applied_notebooks, custom_functions_changed))
}

/// Reserved module-script id under which the Custom Functions (JS UDF) library
/// is persisted as JSON data (mirrors PERSIST_SCRIPT_ID in @api/customFunctions.ts).
const CUSTOM_FUNCTIONS_LIB_ID: &str = "__calcula_custom_functions__";

/// Refuse a published module or notebook that claims an id in the HOST's
/// reserved `__calcula_` namespace.
///
/// THE DEFECT THIS CLOSES. `materialize_distributed_scripts` inserted whatever
/// id an application shipped straight into the workbook's module map.
/// `list_scripts` HIDES reserved ids (they are internal data records, not user
/// code) and `delete_script` REFUSES them (deleting one would destroy the owning
/// feature's state) — so a publisher who named a module `__calcula_anything`
/// landed code in the subscriber's workbook that appears in NO listing and
/// CANNOT be removed. Invisible and undeletable is not a cosmetic pair; it is
/// the precise inverse of the Transparency pillar's "the user must always know
/// where code resides and what it can touch".
///
/// WHY REFUSE RATHER THAN RENAME. A rename would break the application's own
/// references to its module, and — worse — it would hide the attempt: the
/// subscriber would never learn that an application tried to write into the
/// host's namespace. A refusal is loud, names the id and the application, and is
/// fixable by the party that actually caused it.
///
/// WHY THE WHOLE OPERATION AND NOT JUST THAT ONE MODULE. The same reasoning as
/// `crate::media::enforce_distributed_control_budget`: skipping the offending id
/// and applying the rest is a half-applied application that nobody can reason
/// about, and "some of it landed" is exactly what a report consumer cannot see.
/// Every caller runs this BEFORE its `DocumentEffect`, so the refusal leaves the
/// workbook untouched and, unlike a mid-materialization failure, not even
/// marked modified.
///
/// ONE EXEMPTION, BY DESIGN: `__calcula_custom_functions__`. That id collides
/// across every workbook deliberately and has its own merge path
/// (`merge_custom_function_library`), which validates each incoming function
/// name, keeps the merged record SUBSCRIBER-owned, and never widens the
/// subscriber's declared capability ceiling. It is a shipped feature, not a
/// namespace grab. Notebooks get no exemption — nothing merges a notebook, and
/// the prefix belongs to the host on both maps regardless of which one happens
/// to hide and protect its ids today.
fn refuse_reserved_distributed_script_ids(
    package_name: &str,
    modules: &[persistence::SavedScript],
    notebooks: &[persistence::SavedNotebook],
) -> Result<(), String> {
    let mut claimed: Vec<&str> = modules
        .iter()
        .map(|m| m.id.as_str())
        .filter(|id| {
            crate::scripting::commands::is_reserved_script_id(id) && *id != CUSTOM_FUNCTIONS_LIB_ID
        })
        .chain(
            notebooks
                .iter()
                .map(|n| n.id.as_str())
                .filter(|id| crate::scripting::commands::is_reserved_script_id(id)),
        )
        .collect();
    if claimed.is_empty() {
        return Ok(());
    }
    // Deterministic and de-duplicated: the same application must produce the
    // same sentence every time it is refused, or two reports of the same
    // refusal cannot be compared.
    claimed.sort_unstable();
    claimed.dedup();
    let one = claimed.len() == 1;
    Err(format!(
        "CALP_RESERVED_SCRIPT_ID: The application '{}' ships {} whose id starts with '{}': \
         {}. That namespace is reserved for Calcula's own internal records — ids in it are \
         hidden from the Script Editor and cannot be deleted, so anything landing there \
         would sit in your workbook invisible and permanent. Nothing was imported. Ask the \
         publisher to rename {}; renaming {} here instead would break the application's own \
         references and hide the fact that it tried.",
        package_name,
        if one { "a script" } else { "scripts" },
        crate::scripting::commands::RESERVED_SCRIPT_PREFIX,
        summarize_ids(claimed.iter().copied()),
        if one { "it" } else { "them" },
        if one { "it" } else { "them" },
    ))
}

/// Merge an application's custom-function library into the subscriber's reserved
/// library record, PER FUNCTION:
/// - The merged record is ALWAYS subscriber-owned (source_package None), so
///   the whole-record removal-on-refresh never deletes local functions.
/// - Each application function is stamped `sourcePackage` + a `sourceDigest`
///   content hash inside the JSON. On refresh, an UNMODIFIED application function
///   is replaced by the incoming set (updates AND removals propagate), while a
///   function the subscriber has EDITED since the merge (digest mismatch) is
///   adopted as local — the subscriber's edit is never silently destroyed.
/// - A name collision with a local (or other-application) function keeps the
///   existing one (preserve-local, per function) and logs the skip.
/// - Incoming names are validated with the same rules as the authoring UI
///   (JS identifier) — one invalid name in an application must not poison the
///   shared library and break the subscriber's OWN functions at install.
/// - Library `capabilities` are NOT unioned: the merged record shares the
///   subscriber's script id and its live capability grants, so an application must
///   never widen that declared ceiling. An application function needing an
///   undeclared capability fails closed at the broker until the subscriber
///   adds the capability themselves (logged here for transparency).
///
/// `incoming_source` is None when the application ships no library, which strips
/// the application's previously-merged (unmodified) functions. Returns true when
/// the stored record changed (callers emit "custom-functions:refresh" so the
/// live UDF registry re-installs without a reopen).
fn merge_custom_function_library(
    scripts: &mut std::collections::HashMap<String, crate::scripting::types::WorkbookScript>,
    package_name: &str,
    incoming_source: Option<&str>,
) -> bool {
    use serde_json::{json, Value};

    let old_source = scripts.get(CUSTOM_FUNCTIONS_LIB_ID).map(|s| s.source.clone());
    if old_source.is_none() && incoming_source.is_none() {
        return false;
    }

    fn parse_lib(src: &str) -> (Vec<Value>, Vec<String>) {
        let v: Value = match serde_json::from_str(src) {
            Ok(v) => v,
            Err(_) => return (Vec::new(), Vec::new()),
        };
        let functions = v
            .get("functions")
            .and_then(|f| f.as_array())
            .cloned()
            .unwrap_or_default();
        let capabilities = v
            .get("capabilities")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        (functions, capabilities)
    }

    /// Same shape rule as the authoring UI's validateFunctionName
    /// (@api/customFunctions.ts IDENT_RE): a JS identifier after trim+uppercase.
    fn is_valid_function_name(name: &str) -> bool {
        let up = name.trim().to_uppercase();
        let mut chars = up.chars();
        match chars.next() {
            Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
    }

    /// Deterministic content digest of a function definition, EXCLUDING the
    /// provenance keys this merge adds. serde_json's default map is a BTreeMap
    /// (sorted keys), so to_string is stable.
    fn function_digest(f: &Value) -> String {
        let mut canon = f.clone();
        if let Some(obj) = canon.as_object_mut() {
            obj.remove("sourcePackage");
            obj.remove("sourceDigest");
        }
        let bytes = serde_json::to_string(&canon).unwrap_or_default();
        // FNV-1a 64 — tiny, dependency-free, stable across builds.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for b in bytes.as_bytes() {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{:016x}", hash)
    }

    let (existing_fns, caps) = old_source.as_deref().map(parse_lib).unwrap_or_default();
    // Partition this application's previous contribution: unmodified entries are
    // dropped (re-added from incoming below — updates/removals propagate);
    // subscriber-EDITED entries (digest mismatch) are adopted as local so the
    // edit survives, and the collision check then shields them from incoming.
    let mut merged: Vec<Value> = Vec::new();
    for mut f in existing_fns {
        let from_this_pkg =
            f.get("sourcePackage").and_then(|p| p.as_str()) == Some(package_name);
        if !from_this_pkg {
            merged.push(f);
            continue;
        }
        let stored_digest = f
            .get("sourceDigest")
            .and_then(|d| d.as_str())
            .map(str::to_string);
        let modified = stored_digest.as_deref() != Some(function_digest(&f).as_str());
        if modified {
            if let Some(obj) = f.as_object_mut() {
                obj.remove("sourcePackage");
                obj.remove("sourceDigest");
            }
            crate::log_warn!(
                "CALP",
                "custom function '{}' from application '{}' was edited locally: keeping the edited copy as a local function",
                f.get("name").and_then(|n| n.as_str()).unwrap_or("?"),
                package_name,
            );
            merged.push(f);
        }
        // Unmodified application function: dropped here, re-added from incoming.
    }

    if let Some(src) = incoming_source {
        let (incoming_fns, incoming_caps) = parse_lib(src);
        let mut taken: std::collections::HashSet<String> = merged
            .iter()
            .filter_map(|f| f.get("name").and_then(|n| n.as_str()))
            .map(|n| n.trim().to_uppercase())
            .collect();
        for mut f in incoming_fns {
            let Some(name) = f.get("name").and_then(|n| n.as_str()).map(str::to_string) else {
                continue;
            };
            if !is_valid_function_name(&name) {
                crate::log_warn!(
                    "CALP",
                    "custom function '{}' from application '{}' not applied: invalid function name",
                    name,
                    package_name,
                );
                continue;
            }
            let key = name.trim().to_uppercase();
            if taken.contains(&key) {
                crate::log_warn!(
                    "CALP",
                    "custom function '{}' from application '{}' not applied: the name is already defined in this workbook",
                    name,
                    package_name,
                );
                continue;
            }
            taken.insert(key);
            let digest = function_digest(&f);
            if let Some(obj) = f.as_object_mut() {
                obj.insert("sourcePackage".to_string(), json!(package_name));
                obj.insert("sourceDigest".to_string(), json!(digest));
            }
            merged.push(f);
        }
        // Capabilities are deliberately NOT merged (see fn docs) — only log
        // when the application declares ones the subscriber's library lacks.
        for c in incoming_caps {
            if !caps.contains(&c) {
                crate::log_warn!(
                    "CALP",
                    "application '{}' custom functions declare capability '{}' which this workbook's library does not; those functions will fail closed until the capability is added in the Custom Functions dialog",
                    package_name,
                    c,
                );
            }
        }
    }

    if merged.is_empty() && old_source.is_none() {
        return false;
    }

    let mut lib = json!({ "functions": merged });
    if !caps.is_empty() {
        lib["capabilities"] = json!(caps);
    }
    let new_source = lib.to_string();
    if old_source.as_deref() == Some(new_source.as_str()) {
        return false;
    }

    use crate::scripting::types::{ScriptScope, WorkbookScript};
    scripts
        .entry(CUSTOM_FUNCTIONS_LIB_ID.to_string())
        .and_modify(|s| {
            s.source = new_source.clone();
            s.source_package = None; // always subscriber-owned (heals old stamps)
        })
        .or_insert_with(|| WorkbookScript {
            id: CUSTOM_FUNCTIONS_LIB_ID.to_string(),
            name: "Custom Functions (data)".to_string(),
            description: Some("Definitions for user-authored formula functions.".to_string()),
            source: new_source,
            scope: ScriptScope::Workbook,
            source_package: None,
        });
    true
}

/// Grow an index-aligned per-sheet Vec store so `idx` is addressable.
fn ensure_slot<T: Clone>(v: &mut Vec<T>, idx: usize, default: T) {
    while v.len() <= idx {
        v.push(default.clone());
    }
}

/// Materialize pulled sheet presentation state (merged regions, freeze panes,
/// tab color, visibility, gridlines, page setup, notes, hyperlinks) into the
/// per-sheet AppState stores, and keep the index-aligned Vec stores aligned
/// for appended sheets. Before this, pulled applications carried all of it in
/// sheets/{id}/metadata.json and the Tauri materializer dropped it — the
/// subscriber lost merges/freeze panes/notes — AND the aligned Vec stores
/// stayed short, misaligning any sheet added after a pull.
///
/// Reset semantics per materialized sheet (the publisher owns a subscribed
/// sheet's presentation): used by first pull (fresh sheets, so reset ==
/// initialize), refresh (overwrite with the new version's state), and the
/// dev-mode preview loop. `sheets` pairs each source/application sheet id with its
/// carrier Sheet; ids resolve to local indices via `pkg_to_index`.
fn materialize_pulled_sheet_state(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    sheets: &[(SheetId, &persistence::Sheet)],
    pkg_to_index: &std::collections::HashMap<SheetId, usize>,
    active_sheet: usize,
) -> Result<(), String> {
    // Each store is locked, updated, and released independently (mirroring the
    // .cala load path) to keep lock scopes small and ordering trivial.
    let targets: Vec<(usize, &persistence::Sheet)> = sheets
        .iter()
        .filter_map(|(pkg_sid, sheet)| pkg_to_index.get(pkg_sid).map(|&idx| (idx, *sheet)))
        .collect();

    {
        let mut v = state.freeze_configs.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, crate::sheets::FreezeConfig::default());
            v[*idx] = crate::sheets::FreezeConfig {
                freeze_row: p.freeze_row,
                freeze_col: p.freeze_col,
            };
        }
    }
    {
        let mut v = state.split_configs.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, crate::sheets::SplitConfig::default());
            v[*idx] = crate::sheets::SplitConfig {
                split_row: p.split_row,
                split_col: p.split_col,
            };
        }
    }
    {
        let mut v = state.sheet_zooms.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, persistence::DEFAULT_SHEET_ZOOM_PERCENT);
            v[*idx] = p.zoom;
        }
    }
    {
        let mut v = state.scroll_areas.lock().map_err(|e| e.to_string())?;
        for (idx, _) in &targets {
            ensure_slot(&mut v, *idx, None);
        }
    }
    {
        let mut v = state.tab_colors.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, String::new());
            v[*idx] = p.tab_color.clone();
        }
    }
    {
        let mut v = state.sheet_visibility.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, "visible".to_string());
            v[*idx] = p.visibility.clone();
        }
    }
    {
        let mut v = state.show_gridlines.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, true);
            v[*idx] = p.show_gridlines;
        }
    }
    {
        // User-hidden rows/cols ride along with the rest of the sheet's
        // presentation state. The application carries them as their own authority
        // (PublishedSheetMetadata.user_hidden_*), so a subscriber can unhide by
        // hand what the publisher hid by hand.
        for (idx, p) in &targets {
            crate::commands::dimensions::set_user_hidden_for_sheet(
                state,
                effect,
                *idx,
                p.user_hidden_rows.clone(),
                p.user_hidden_cols.clone(),
            );
        }
    }
    {
        let mut all_merged = state.all_merged_regions.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut all_merged, *idx, std::collections::HashSet::new());
            let merges: std::collections::HashSet<crate::api_types::MergedRegion> = p
                .merged_regions
                .iter()
                .map(|mr| crate::api_types::MergedRegion {
                    start_row: mr.start_row,
                    start_col: mr.start_col,
                    end_row: mr.end_row,
                    end_col: mr.end_col,
                })
                .collect();
            // The active sheet's merges live in the mirror (source of truth
            // while active); a refreshed active sheet must sync it too.
            if *idx == active_sheet {
                let mut mirror = state.merged_regions.write(effect).map_err(|e| e.to_string())?;
                *mirror = merges.clone();
            }
            all_merged[*idx] = merges;
        }
    }
    {
        let mut page_setups = state.page_setups.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut page_setups, *idx, crate::api_types::PageSetup::default());
            page_setups[*idx] = match &p.page_setup {
                Some(ps) => crate::api_types::PageSetup {
                    paper_size: ps.paper_size.clone(),
                    orientation: ps.orientation.clone(),
                    margin_top: ps.margin_top,
                    margin_bottom: ps.margin_bottom,
                    margin_left: ps.margin_left,
                    margin_right: ps.margin_right,
                    margin_header: ps.margin_header,
                    margin_footer: ps.margin_footer,
                    header: ps.header.clone(),
                    footer: ps.footer.clone(),
                    print_area: ps.print_area.clone(),
                    print_titles_rows: ps.print_titles_rows.clone(),
                    manual_row_breaks: ps.manual_row_breaks.clone(),
                    print_gridlines: ps.print_gridlines,
                    center_horizontally: ps.center_horizontally,
                    center_vertically: ps.center_vertically,
                    scale: ps.scale,
                    fit_to_width: ps.fit_to_width,
                    fit_to_height: ps.fit_to_height,
                    page_order: ps.page_order.clone(),
                    first_page_number: ps.first_page_number,
                    ..Default::default()
                },
                None => crate::api_types::PageSetup::default(),
            };
        }
    }
    {
        let mut notes_storage = state.notes.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            if p.notes.is_empty() {
                notes_storage.remove(idx);
                continue;
            }
            let mut sheet_notes = std::collections::HashMap::new();
            for n in &p.notes {
                sheet_notes.insert(
                    (n.row, n.col),
                    crate::notes::Note {
                        id: uuid::Uuid::new_v4().to_string(),
                        row: n.row,
                        col: n.col,
                        sheet_index: *idx,
                        author_name: n.author.clone(),
                        content: n.text.clone(),
                        rich_content: n.rich_content.clone(),
                        width: if n.width > 0.0 { n.width } else { 200.0 },
                        height: if n.height > 0.0 { n.height } else { 100.0 },
                        visible: n.visible,
                        created_at: if n.created_at.is_empty() {
                            chrono::Utc::now().to_rfc3339()
                        } else {
                            n.created_at.clone()
                        },
                        modified_at: if n.modified_at.is_empty() {
                            None
                        } else {
                            Some(n.modified_at.clone())
                        },
                    },
                );
            }
            notes_storage.insert(*idx, sheet_notes);
        }
    }
    {
        let mut hyperlinks_storage = state.hyperlinks.write(effect).map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            if p.hyperlinks.is_empty() {
                hyperlinks_storage.remove(idx);
                continue;
            }
            let mut sheet_links = std::collections::HashMap::new();
            for h in &p.hyperlinks {
                sheet_links.insert(
                    (h.row, h.col),
                    crate::hyperlinks::Hyperlink {
                        row: h.row,
                        col: h.col,
                        sheet_index: *idx,
                        link_type: crate::hyperlinks::HyperlinkType::Url,
                        target: h.target.clone(),
                        internal_ref: None,
                        display_text: h.display_text.clone(),
                        tooltip: h.tooltip.clone(),
                    },
                );
            }
            hyperlinks_storage.insert(*idx, sheet_links);
        }
    }

    Ok(())
}

/// Materialize pulled tables at the sheet indices resolved by `map`
/// (ADDITIVE: id/name-collision skip so a subscriber's own table is never
/// clobbered). Appends a ledger entry per table actually added when a ledger
/// is supplied. Returns the number materialized. Shared by pull, refresh, and
/// the dev-mode preview loop.
fn materialize_pulled_tables(
    effect: &crate::document_effect::DocumentEffect,
    state: &AppState,
    saved_tables: &[persistence::SavedTable],
    map: &std::collections::HashMap<SheetId, usize>,
    mut ledger: Option<&mut Vec<calp::manifest::SubscribedObject>>,
) -> Result<usize, String> {
    if saved_tables.is_empty() {
        return Ok(0);
    }
    let mut materialized = 0usize;
    let mut tables = state.tables.write(&effect).map_err(|e| e.to_string())?;
    let mut table_names = state.table_names.write(&effect).map_err(|e| e.to_string())?;
    for saved in saved_tables {
        let Some(&idx) = map.get(&saved.sheet_id) else {
            continue; // the table's sheet wasn't pulled
        };
        let name_key = saved.name.to_uppercase();
        if table_names.contains_key(&name_key) {
            continue; // don't clobber a table the subscriber already has
        }
        if tables.values().any(|m| m.contains_key(&saved.id)) {
            continue;
        }
        let table = crate::persistence::saved_table_to_table_at(saved, idx);
        table_names.insert(name_key, (idx, table.id));
        if let Some(ledger) = ledger.as_deref_mut() {
            ledger.push(calp::manifest::SubscribedObject {
                kind: "table".to_string(),
                id: table.id.to_string(),
                name: table.name.clone(),
                extra: std::collections::HashMap::new(),
            });
        }
        tables.entry(idx).or_default().insert(table.id, table);
        materialized += 1;
    }
    Ok(materialized)
}

/// Does this workbook SUBSCRIBE to the application it is about to push to?
///
/// NAME **AND** WORKSPACE. A name alone is not an application: two teams may each
/// publish `sales` to their own share, and refusing a push to YOUR `sales`
/// because you subscribe to THEIRS is a gate refusing for a reason that is not
/// the reason the gate exists. The check used to compare the name only, and had
/// no test at all.
///
/// The dead `version_pin != "dev"` clause is gone with it. A dev subscription's
/// `package_name` is `dev:<source path>` (`calp::dev_mode`), which can never
/// equal a target application name, so the exemption never excluded anything —
/// and leaving it there would let it silently activate if dev subscriptions ever
/// gained real names.
pub(crate) fn subscribes_to(
    subscriptions: &[calp::manifest::Subscription],
    registry_path: &str,
    package_name: &str,
) -> bool {
    subscriptions.iter().any(|s| {
        s.package_name == package_name && calp::same_workspace(&s.registry_url, registry_path)
    })
}

/// The sheet ids the working copy's BASE version carried, or `None` when this
/// workbook is not a working copy of anything.
///
/// `Some(empty)` is meaningful and distinct from `None`: a library or dataset
/// application legitimately carries no sheets, and its default publish is zero
/// sheets, not every sheet in the author's workbook.
fn working_copy_base_sheets(
    state: &AppState,
) -> Result<Option<std::collections::HashSet<identity::SheetId>>, String> {
    let link = state.working_copy_link.read().map_err(|e| e.to_string())?;
    Ok(link
        .as_ref()
        .map(|l| l.base_sheets.iter().map(|s| s.sheet_id).collect()))
}

/// One sheet named in a publish, with where it came from.
#[derive(Debug, Clone)]
pub(crate) struct ProvenancedSheet {
    pub name: String,
    pub package_name: String,
}

/// What a publish will ship, and what it withheld because it belongs to somebody
/// else.
///
/// The reason travels WITH the selection rather than being recomputed by the
/// report, so the disclosure and the carrier can never disagree about which
/// sheets are leaving.
#[derive(Debug, Clone, Default)]
pub(crate) struct PublishSelection {
    /// Workbook indices that will be published.
    pub indices: Vec<usize>,
    /// Subscribed sheets the DEFAULT selection withheld. Empty when the author
    /// named sheets explicitly — then nothing was withheld.
    pub withheld_subscribed: Vec<ProvenancedSheet>,
    /// Subscribed sheets the author DELIBERATELY ticked. An informed act, and
    /// still a DISCLOSED one.
    pub included_subscribed: Vec<ProvenancedSheet>,
}

/// Normalize the author's sheet selection: empty means "every sheet you own".
/// Shared by calp_publish and calp_publish_preview so the dry-run can never
/// describe a different application than the one a publish with the same input
/// would write.
pub(crate) fn resolve_publish_sheet_indices(
    state: &AppState,
    kind: &str,
    requested: Vec<usize>,
) -> Result<PublishSelection, String> {
    let provenance = crate::sheets::SheetProvenance::snapshot(state)?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let explicit = !requested.is_empty();

    let mut selected: Vec<usize> = if explicit {
        requested
    } else if kind.eq_ignore_ascii_case(crate::library_commands::LIBRARY_KIND) {
        // A LIBRARY's payload is its standalone MODULE SCRIPTS, not its sheets.
        // Defaulting to "every sheet" would ship the author's whole workbook to a
        // shared workspace as a side effect of publishing a function library.
        //
        // This rule used to live in `calp_publish` and NOT in
        // `calp_publish_preview`, so a library preview described every sheet for
        // a publish that shipped none — the exact drift the doc comment above
        // claims is impossible. It lives here now so both callers inherit it.
        Vec::new()
    } else if let Some(base) = working_copy_base_sheets(state)? {
        // A WORKING COPY publishes the APPLICATION's sheets, not the workbook's.
        //
        // Checkout is additive — the application's sheets join the workbook you
        // already had open — so "every sheet" would sweep your own unrelated work
        // into somebody else's application on the next push. That is the same
        // leak the subscribed filter below closes, arriving from the other
        // direction, and the link already records exactly which sheets the base
        // version carried.
        //
        // A sheet you ADD to the application is published by ticking it: the
        // dialog marks non-base sheets "(new — not in v<base>)", so the tick is
        // informed rather than a default nobody chose.
        let visibility = state.sheet_visibility.read().map_err(|e| e.to_string())?;
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        (0..sheet_names.len())
            .filter(|&i| crate::sheets::is_user_sheet(&visibility, i))
            .filter(|&i| ids.get(i).map(|id| base.contains(id)).unwrap_or(false))
            .collect()
    } else {
        // "Every sheet" means every USER sheet: object-backed sheets are not
        // selectable anywhere (no tab, no picker), so an explicit-selection
        // publish never names them and the default must not either — they
        // join below, through their owner, exactly like an explicit selection.
        let visibility = state.sheet_visibility.read().map_err(|e| e.to_string())?;
        let count = sheet_names.len();
        (0..count)
            .filter(|&i| crate::sheets::is_user_sheet(&visibility, i))
            .filter(|&i| !provenance.is_subscribed(i))
            // A sheet that came from a subscribed application is its PUBLISHER's
            // content, not yours. Excluded from the DEFAULT only — the explicit
            // branch above is untouched, which is what keeps a deliberate tick
            // working. Without this, publishing application B from a workbook
            // subscribed to A shipped A's sheets inside B under your key.
            .collect()
    };

    let named = |i: usize| -> Option<ProvenancedSheet> {
        provenance.origin(i).map(|o| ProvenancedSheet {
            name: o.sheet_name.clone(),
            package_name: o.package_name.clone(),
        })
    };
    let _ = explicit;

    // FLOATING RANGES TRAVEL WITH THEIR HOST SHEET: a published sheet that
    // hosts one must carry its backing sheet, or the subscriber's pull shows
    // an object whose every cell is #REF!. Expansion happens HERE — the one
    // normalization both publish and preview share — so the dry-run report
    // can never describe a different application than the publish.
    let backing: Vec<usize> = {
        let rows = state.floating_ranges.read().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        let selected_ids: std::collections::HashSet<identity::SheetId> = selected
            .iter()
            .filter_map(|&i| sheet_ids.get(i).copied())
            .collect();
        rows.iter()
            .filter(|fr| selected_ids.contains(&fr.host_sheet_id))
            .filter_map(|fr| sheet_ids.iter().position(|id| *id == fr.backing_sheet_id))
            .collect()
    };
    for idx in backing {
        if !selected.contains(&idx) {
            selected.push(idx);
        }
    }

    // BOTH computed from the FINAL set, after the backing-sheet expansion — a
    // subscribed sheet that arrived through its host is disclosed as included,
    // not reported as withheld while it ships.
    //
    // WITHHELD is "subscribed and not selected", however the selection arrived.
    // Scoping it to the default-only branch would have been the obvious reading
    // of "excluded by default", and it would go quiet the moment the author
    // unticked any unrelated sheet — the dialog sends an explicit list as soon as
    // one checkbox moves. What the author needs to know is what is being left
    // behind, not which code path decided it.
    let included_subscribed: Vec<ProvenancedSheet> =
        selected.iter().copied().filter_map(named).collect();
    let withheld_subscribed: Vec<ProvenancedSheet> = (0..sheet_names.len())
        .filter(|&i| provenance.is_subscribed(i) && !selected.contains(&i))
        .filter_map(named)
        .collect();

    Ok(PublishSelection {
        indices: selected,
        withheld_subscribed,
        included_subscribed,
    })
}

/// The publish dialog's sheet list: every choosable sheet, its TRUE index, and
/// whether it belongs to somebody else.
///
/// Object-backed sheets are omitted for the same reason `build_sheet_list` omits
/// them — they are not selectable anywhere, and travel with their host.
pub(crate) fn publish_preview_sheet_list(
    state: &AppState,
    selection: &PublishSelection,
) -> Result<Vec<PublishPreviewSheet>, String> {
    let names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let visibility = state.sheet_visibility.read().map_err(|e| e.to_string())?.clone();
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    let provenance = crate::sheets::SheetProvenance::snapshot(state)?;

    Ok((0..names.len())
        .filter(|&i| crate::sheets::is_user_sheet(&visibility, i))
        .map(|i| PublishPreviewSheet {
            index: i,
            // `.get(i)`, never a zip: the filter above drops object-backed
            // sheets while `i` stays the TRUE state-vector index.
            sheet_id: sheet_ids.get(i).map(|s| s.to_string()).unwrap_or_default(),
            name: names[i].clone(),
            subscribed_to: provenance
                .origin(i)
                .map(|o| o.package_name.clone())
                .unwrap_or_default(),
            default_selected: selection.indices.contains(&i),
        })
        .collect())
}

/// The two provenance lines of the publish report.
///
/// Extracted as a pure function because `compute_publish_report` needs nine
/// `State<T>` handles to reach, and a report line nothing can test is a report
/// line that drifts from what actually ships.
///
/// Returns `(included, excluded)`. Both are `None` at zero count, inheriting the
/// report's own rule that an empty row is not a row.
pub(crate) fn subscribed_sheet_report_rows(
    selection: &PublishSelection,
) -> (Option<PublishReportItem>, Option<PublishReportItem>) {
    let apps = |rows: &[ProvenancedSheet]| -> String {
        let mut names: Vec<String> = rows.iter().map(|r| r.package_name.clone()).collect();
        names.sort();
        names.dedup();
        names.join(", ")
    };
    /// The sheets themselves, so the author can see WHICH tabs this is about
    /// without counting. Truncated past six — a disclosure nobody can read is a
    /// disclosure nobody acts on.
    fn sheets_of(rows: &[ProvenancedSheet]) -> String {
        let mut names: Vec<String> = rows.iter().map(|r| r.name.clone()).collect();
        names.sort();
        if names.len() > 6 {
            let extra = names.len() - 6;
            names.truncate(6);
            return format!("{} and {} more", names.join(", "), extra);
        }
        names.join(", ")
    }

    let included = if selection.included_subscribed.is_empty() {
        None
    } else {
        Some(PublishReportItem {
            category: "subscribedSheets".to_string(),
            count: selection.included_subscribed.len(),
            // DELIBERATELY overlaps the `sheets` count above it in the report:
            // these sheets ARE being published and are counted there. This line
            // says something the count cannot — whose content it is.
            detail: format!(
                "sheets you ticked that came from {} ({}) — you are republishing another \
                 publisher's content under your name",
                apps(&selection.included_subscribed),
                sheets_of(&selection.included_subscribed)
            ),
        })
    };

    let excluded = if selection.withheld_subscribed.is_empty() {
        None
    } else {
        Some(PublishReportItem {
            category: "subscribedSheets".to_string(),
            count: selection.withheld_subscribed.len(),
            detail: format!(
                "sheets that came from {} ({}) — they belong to their publisher, not to \
                 this application. Tick one in the sheet list to publish it deliberately",
                apps(&selection.withheld_subscribed),
                sheets_of(&selection.withheld_subscribed)
            ),
        })
    };

    (included, excluded)
}

/// Uppercased name-collision set for pulled pane controls: existing pane
/// controls + ribbon filters (GET.CONTROLVALUE names are unique across both
/// families) + NAMED on-grid controls. Without the on-grid family a pulled
/// pane control could silently shadow a subscriber's named button/checkbox —
/// pane controls win the GET.CONTROLVALUE precedence, so the subscriber's
/// formulas would switch source without any warning. On-grid names use the
/// SAME extraction rule as the snapshot map (`static_control_name`: static,
/// non-empty after trim; formula-typed names excluded).
fn pane_control_taken_names<'a>(
    pane_controls: impl Iterator<Item = &'a crate::pane_control::PaneControl>,
    ribbon_filters: impl Iterator<Item = &'a crate::ribbon_filter::RibbonFilter>,
    on_grid_controls: &crate::controls::ControlStorage,
) -> std::collections::HashSet<String> {
    pane_controls
        .map(|c| c.name.to_uppercase())
        .chain(ribbon_filters.map(|f| f.name.to_uppercase()))
        .chain(
            on_grid_controls
                .values()
                .filter_map(crate::control_values::static_control_name)
                .map(|n| n.to_uppercase()),
        )
        .collect()
}

/// Snapshot AppState.controls (on-grid control metadata) under its own short
/// lock, released before the pane/filter locks are taken — the lock-order
/// convention (pane_control/types.rs, control_values.rs) never nests these.
fn snapshot_on_grid_controls(state: &AppState) -> Result<crate::controls::ControlStorage, String> {
    Ok(state.controls.read().map_err(|e| e.to_string())?.clone())
}

/// Materialize pulled pane controls (Controls pane) into PaneControlState —
/// shared by calp_pull and calp_refresh_apply so first-pull and refresh
/// semantics can never drift. Workbook-scoped, ADDITIVE with don't-clobber
/// (the named-range / object-script convention): a control whose id already
/// exists, or whose name collides CASE-INSENSITIVELY with an existing pane
/// control, ribbon filter, or NAMED on-grid control (see
/// `pane_control_taken_names`), is skipped with a warning. Applied controls
/// re-base to the end of the subscriber's strip (max existing order + 1,
/// preserving application-relative order) — the same append semantics
/// create_pane_control uses. Configs carry no inline code by design (D6); a
/// custom control's script arrives separately as a consent-gated distributed
/// object script and stays inert until the subscriber consents.
///
/// `on_grid_controls` is a snapshot taken via `snapshot_on_grid_controls`
/// (its lock already released) — never a live guard, so no lock nests with
/// the pane/filter locks taken here.
///
/// Returns (id, name) for each control ACTUALLY inserted, so callers record
/// provenance-ledger entries only for what landed (a collision-skipped local
/// control is never attributed to the application).
fn materialize_pulled_pane_controls(
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    on_grid_controls: &crate::controls::ControlStorage,
    pulled: &[persistence::SavedPaneControl],
) -> Result<Vec<(String, String)>, String> {
    if pulled.is_empty() {
        return Ok(Vec::new());
    }
    // LOCK ORDER (pane_control/types.rs): PaneControlState.controls BEFORE
    // RibbonFilterState.filters; neither held while touching grids (we
    // don't touch grids here).
    let mut controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;
    let (mut taken_names, base_order) = {
        let filters = ribbon_filter_state.filters.read().map_err(|e| e.to_string())?;
        let names = pane_control_taken_names(controls.values(), filters.values(), on_grid_controls);
        let max_order = controls
            .values()
            .map(|c| c.order)
            .chain(filters.values().map(|f| f.order))
            .max();
        (names, max_order.map_or(0, |m| m.saturating_add(1)))
    };

    // Application order is already (order, id)-sorted at publish; re-sort
    // defensively so re-based positions are deterministic regardless.
    let mut incoming = pulled.to_vec();
    incoming.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

    let mut applied: Vec<(String, String)> = Vec::new();
    let mut next_order = base_order;
    for saved in &incoming {
        if controls.contains_key(&saved.id) {
            continue; // subscriber already has this control (id collision)
        }
        if taken_names.contains(&saved.name.to_uppercase()) {
            crate::log_warn!(
                "CALP",
                "Skipping pulled pane control \"{}\": name already in use",
                saved.name
            );
            continue;
        }
        // Same converter as .cala load: unknown types / bad configs are
        // skipped with a warning, never fail the pull.
        if let Some(mut control) = crate::persistence::saved_to_pane_control(saved) {
            control.order = next_order;
            next_order = next_order.saturating_add(1);
            taken_names.insert(control.name.to_uppercase());
            applied.push((control.id.to_string(), control.name.clone()));
            controls.insert(control.id, control);
        }
    }
    Ok(applied)
}

/// Instance ids ("pane-{controlId}", the CustomControlHost/ButtonControl
/// convention) of the incoming pane controls whose host did NOT land in the
/// strip after `materialize_pulled_pane_controls` ran for `incoming`. Strip
/// MEMBERSHIP is the criterion — it distinguishes the two skip reasons:
/// - name-collision skip (or converter drop): the control is ABSENT, so its
///   application-shipped "pane-{id}" object script would persist host-less
///   (inert, but violating delete-path hygiene) — reported for pruning;
/// - id-collision skip: the id is PRESENT (the subscriber's own control was
///   retained), so the script keeps a live host — NOT reported.
/// Every APPLIED control is present by construction, so "absent" is exactly
/// "in the incoming payload but neither applied nor retained".
///
/// Takes (and releases) the pane-controls lock; callers must not hold it.
fn orphaned_pane_script_instance_ids(
    pane_control_state: &crate::pane_control::PaneControlState,
    incoming: &[persistence::SavedPaneControl],
) -> Result<std::collections::HashSet<String>, String> {
    if incoming.is_empty() {
        return Ok(std::collections::HashSet::new());
    }
    let controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;
    Ok(incoming
        .iter()
        .filter(|saved| !controls.contains_key(&saved.id))
        .map(|saved| format!("pane-{}", saved.id))
        .collect())
}

/// Strip computed properties from DISTRIBUTED slicer payloads before
/// materialization (the on-grid controls' `sanitize_distributed_controls`
/// precedent). A slicer's computed properties are user-authored FORMULAS
/// evaluated with full grid context — carrying them live from an application would
/// let publisher-authored expressions evaluate in the subscriber's workbook
/// without the subscriber ever authoring them, outside the per-application,
/// consent-gated model that governs every other piece of distributed
/// executable logic. Packaged slicers therefore arrive with their visual and
/// selection state intact but NO computed properties; the subscriber can
/// author their own, and publisher-shipped interactivity flows through
/// consent-gated object scripts instead. (.cala load of the user's own
/// workbook is NOT sanitized — local formulas are the user's own code.)
fn sanitize_distributed_slicers(
    pulled: &[persistence::SavedSlicer],
) -> Vec<persistence::SavedSlicer> {
    pulled
        .iter()
        .map(|saved| {
            let mut cloned = saved.clone();
            cloned.computed_properties = Vec::new();
            cloned
        })
        .collect()
}

/// Materialize pulled slicers into SlicerState — shared by calp_pull and
/// calp_refresh_apply (Wave A). ADDITIVE with don't-clobber: a slicer whose
/// id already exists locally is skipped (the refresh path removes the
/// application's ledger-owned ids first, so v2 replaces v1 while subscriber-
/// authored slicers are never touched). `resolve` maps the APPLICATION sheet id
/// to the local sheet index; a slicer whose sheet wasn't pulled is dropped
/// (chart semantics). Conversion + computed-property restore go through the
/// same pub(crate) converters the .cala load path uses — but callers pass
/// DISTRIBUTED payloads through `sanitize_distributed_slicers` first, so
/// packaged computed properties (formulas) never restore.
///
/// Returns (id, name) for each slicer ACTUALLY inserted, so callers record
/// provenance-ledger entries only for what landed.
///
/// Computed properties go in through the SAME installer `.cala` load uses
/// (`slicer::computed::install_restored_computed_properties`), which restores
/// the properties and the reverse dependency index they are re-evaluated
/// through as one act. In practice the sanitizer above leaves nothing to
/// install; routing through the shared installer anyway means this path cannot
/// become the second copy of the "restored, listed in the dialog, and dead"
/// defect if that ever changes.
fn materialize_pulled_slicers(
    effect: &crate::document_effect::DocumentEffect,
    state: &AppState,
    slicer_state: &crate::slicer::SlicerState,
    pulled: &[persistence::SavedSlicer],
    resolve: impl Fn(SheetId) -> Option<usize>,
) -> Result<Vec<(String, String)>, String> {
    if pulled.is_empty() {
        return Ok(Vec::new());
    }
    // LOCK ORDER: grids before the slicer stores (see `restore_slicers`).
    let grids = state.grids.read().map_err(|e| e.to_string())?;
    let mut slicers = slicer_state.slicers.write(&effect).map_err(|e| e.to_string())?;
    let mut computed_props = slicer_state
        .computed_properties
        .write(effect)
        .map_err(|e| e.to_string())?;
    let mut deps = slicer_state
        .computed_prop_dependencies
        .lock()
        .map_err(|e| e.to_string())?;
    let mut rev_deps = slicer_state
        .computed_prop_dependents
        .lock()
        .map_err(|e| e.to_string())?;
    let mut applied: Vec<(String, String)> = Vec::new();
    for saved in pulled {
        let Some(sheet_index) = resolve(saved.sheet_id) else {
            continue; // sheet not pulled — drop, like charts
        };
        if slicers.contains_key(&saved.id) {
            continue; // subscriber already has this slicer (id collision)
        }
        let slicer = crate::persistence::saved_slicer_to_slicer_at(saved, sheet_index);
        let slicer_id = slicer.id;
        applied.push((slicer.id.to_string(), slicer.name.clone()));
        crate::slicer::computed::install_restored_computed_properties(
            slicer_id,
            crate::persistence::slicer_computed_props_from_saved(saved),
            sheet_index,
            &grids,
            &mut computed_props,
            &mut deps,
            &mut rev_deps,
        );
        slicers.insert(slicer.id, slicer);
    }
    Ok(applied)
}

/// Materialize pulled ribbon filters into RibbonFilterState — shared by
/// calp_pull and calp_refresh_apply (Wave A). Ribbon filters are BI-only:
/// a filter whose stable `data_source_id` matches no data source embedded in
/// the application would dangle (its connection can never materialize on the
/// subscriber), so it is SKIPPED with a warning. ADDITIVE with don't-clobber
/// (pane-control precedent): id collisions and case-insensitive name
/// collisions against pane controls / filters / NAMED on-grid controls (the
/// GET.CONTROLVALUE namespace) are skipped. Applied filters re-base to the
/// end of the subscriber's strip, preserving application-relative order. The
/// carried connection_id still points at the PUBLISHER's connection — the
/// data-source re-bind (remap_ribbon_filter_connections) runs after the
/// application connections materialize.
///
/// `on_grid_controls` is a snapshot (its lock already released). LOCK ORDER
/// (pane_control/types.rs): PaneControlState.controls BEFORE
/// RibbonFilterState.filters.
///
/// Returns (id, name) for each filter ACTUALLY inserted.
fn materialize_pulled_ribbon_filters(
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    effect: &crate::document_effect::DocumentEffect,
    on_grid_controls: &crate::controls::ControlStorage,
    pulled: &[persistence::SavedRibbonFilter],
    pulled_data_source_ids: &std::collections::HashSet<String>,
) -> Result<Vec<(String, String)>, String> {
    if pulled.is_empty() {
        return Ok(Vec::new());
    }
    let controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;
    let mut filters = ribbon_filter_state.filters.write(effect).map_err(|e| e.to_string())?;
    let mut taken_names =
        pane_control_taken_names(controls.values(), filters.values(), on_grid_controls);
    let base_order = controls
        .values()
        .map(|c| c.order)
        .chain(filters.values().map(|f| f.order))
        .max()
        .map_or(0, |m| m.saturating_add(1));
    drop(controls);

    // Application order is already (order, id)-sorted at publish; re-sort
    // defensively so re-based positions are deterministic regardless.
    let mut incoming = pulled.to_vec();
    incoming.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

    let mut applied: Vec<(String, String)> = Vec::new();
    let mut next_order = base_order;
    for saved in &incoming {
        // Effective application data-source id: the carried stable id, falling
        // back to the publisher's connection uuid — which IS the application
        // data-source id when the publisher authored on a local connection
        // (the bi_pivot_metadata precedent in collect_pivot_definitions).
        let effective_ds_id = saved
            .data_source_id
            .clone()
            .unwrap_or_else(|| saved.connection_id.to_string());
        if !pulled_data_source_ids.contains(&effective_ds_id) {
            crate::log_warn!(
                "CALP",
                "Skipping pulled ribbon filter \"{}\": its data source is not embedded in the application",
                saved.name
            );
            continue;
        }
        if filters.contains_key(&saved.id) {
            continue; // subscriber already has this filter (id collision)
        }
        if taken_names.contains(&saved.name.to_uppercase()) {
            crate::log_warn!(
                "CALP",
                "Skipping pulled ribbon filter \"{}\": name already in use",
                saved.name
            );
            continue;
        }
        let mut filter = crate::persistence::saved_to_ribbon_filter(saved);
        // Stamp the effective ds id so remap_ribbon_filter_connections (which
        // keys off data_source_id) re-binds this filter to the freshly
        // materialized application connection, and future saves keep the stable id.
        filter.data_source_id = Some(effective_ds_id);
        filter.order = next_order;
        next_order = next_order.saturating_add(1);
        taken_names.insert(filter.name.to_uppercase());
        applied.push((filter.id.to_string(), filter.name.clone()));
        filters.insert(filter.id, filter);
    }
    Ok(applied)
}

/// Re-bind slicers sourced from an application BI connection to the freshly
/// materialized connections (Wave A; mirrors remap_ribbon_filter_connections).
/// An application connection mints a NEW uuid on every pull, and a BI-sourced
/// slicer's `cache_source_id` / biConnection report connections carry the
/// PUBLISHER's connection uuid — which at publish time IS the stable application
/// data-source id, so a string match against the ds map re-binds it.
fn remap_slicer_bi_connections(
    effect: &crate::document_effect::DocumentEffect,
    slicer_state: &crate::slicer::SlicerState,
    ds_to_conn: &std::collections::HashMap<String, crate::bi::types::ConnectionId>,
) {
    if ds_to_conn.is_empty() {
        return;
    }
    let Ok(mut slicers) = slicer_state.slicers.write(effect) else {
        return;
    };
    for slicer in slicers.values_mut() {
        if matches!(slicer.source_type, crate::slicer::SlicerSourceType::BiConnection) {
            if let Some(conn_id) = ds_to_conn.get(&slicer.cache_source_id.to_string()) {
                slicer.cache_source_id = *conn_id;
            }
        }
        for source in slicer.connected_sources.iter_mut() {
            if matches!(source.source_type, crate::slicer::SlicerSourceType::BiConnection) {
                if let Some(conn_id) = ds_to_conn.get(&source.source_id.to_string()) {
                    source.source_id = *conn_id;
                }
            }
        }
    }
}

/// Apply a pulled document theme (Wave A). The theme is a workbook SINGLETON,
/// so pull follows a guarded rule instead of a provenance ledger: the
/// publisher's theme applies ONLY while the subscriber's theme is still the
/// default — a subscriber who customized their theme keeps it (logged, never
/// clobbered). Shared by calp_pull and calp_refresh_apply.
fn apply_pulled_theme(
    effect: &crate::document_effect::DocumentEffect,
    state: &AppState,
    pulled: Option<&engine::ThemeDefinition>,
) -> Result<(), String> {
    let Some(theme) = pulled else {
        return Ok(()); // pre-Wave-An application: no theme carried
    };
    let mut current = state.theme.write(effect).map_err(|e| e.to_string())?;
    if *current == engine::ThemeDefinition::default() {
        *current = theme.clone();
    } else if *current != *theme {
        crate::log_warn!(
            "CALP",
            "Application theme not applied: workbook has a custom theme"
        );
    }
    Ok(())
}

/// Merge pulled extension data (Wave A) ADDITIVELY: only keys the subscriber
/// does not already have are inserted (named-range precedent) — the publisher
/// can seed extension state but NEVER overwrite the subscriber's. Same rule on
/// pull and refresh. Shared by calp_pull and calp_refresh_apply.
///
/// Returns the keys ACTUALLY inserted (sorted for deterministic ledger
/// order), so callers record "extensionData" provenance-ledger entries for
/// exactly the state that came from the application — skipped subscriber-owned
/// keys are never attributed to it.
fn merge_pulled_extension_data(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    pulled: &std::collections::HashMap<String, serde_json::Value>,
) -> Result<Vec<String>, String> {
    if pulled.is_empty() {
        return Ok(Vec::new());
    }
    let mut data = state.extension_data.write(effect).map_err(|e| e.to_string())?;
    let mut inserted: Vec<String> = Vec::new();
    for (key, value) in pulled {
        // The grid-report slot is a first-party store, not extension state, and
        // reports are distributed through their own channel (`restore_report`,
        // which rebinds the BI connection and registers the protected region).
        // Letting the raw slot ride in here would seed the subscriber with the
        // PUBLISHER's connection ids and sheet indices and no regions at all.
        if key == crate::report::REPORTS_EXT_KEY {
            continue;
        }
        if !data.contains_key(key) {
            data.insert(key.clone(), value.clone());
            inserted.push(key.clone());
        }
    }
    inserted.sort();
    Ok(inserted)
}

// ============================================================================
// Trusted publishers: the machine-scoped transparency view
// ============================================================================

/// One pin, as shown to a human.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedPublisherPin {
    /// "calp" (an application/library/skin from a workspace) or "ext" (an installed
    /// add-in, which is pinned machine-globally and has no workspace).
    pub namespace: String,
    pub name: String,
    /// The workspace EXACTLY as the user configured it. Empty for `ext`. The
    /// normalized scope id is key material and is deliberately never exposed:
    /// a lowercased canonical path is not a string anyone typed.
    pub scope_label: String,
    pub publisher_key: String,
    /// RFC3339, or "" for a pin carried over from the pre-scoping store.
    pub pinned_at: String,
}

/// Every pin this machine holds for one (namespace, name), grouped so the ONE
/// question this view exists to answer is answerable at a glance: does any name
/// resolve to more than one publisher key?
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedPublisherName {
    pub namespace: String,
    pub name: String,
    pub pins: Vec<TrustedPublisherPin>,
    /// More than one DISTINCT publisher key holds this name. This is the only
    /// surface where an ACCEPTED cross-workspace name conflict stays visible
    /// after the dialog that accepted it is gone.
    pub has_key_conflict: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedPublisherReport {
    pub names: Vec<TrustedPublisherName>,
    pub total_pins: usize,
    pub conflict_count: usize,
    /// Non-empty when the pin store EXISTS and could not be read. Fail closed:
    /// "I cannot tell you what this machine trusts" must never render as "this
    /// machine trusts nothing".
    pub error: String,
}

/// What does this computer trust, and from where?
///
/// Read-only and passive: it opens no workspace, verifies nothing, and cannot
/// create or remove a pin. It exists because a pin is a durable machine-wide
/// decision and, until this view, there was nowhere to see the whole set.
#[tauri::command]
pub fn calp_list_trusted_publishers(
    window: tauri::Window,
) -> Result<TrustedPublisherReport, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let store = match calp::signing::load_pins(&calcula_profile_dir()) {
        Ok(s) => s,
        Err(e) => {
            return Ok(TrustedPublisherReport {
                names: Vec::new(),
                total_pins: 0,
                conflict_count: 0,
                error: e.to_string(),
            })
        }
    };

    let mut grouped: std::collections::BTreeMap<(String, String), Vec<TrustedPublisherPin>> =
        std::collections::BTreeMap::new();
    let mut total_pins = 0usize;
    for record in store.records() {
        total_pins += 1;
        grouped
            .entry((
                record.namespace.as_str().to_string(),
                record.name.clone(),
            ))
            .or_default()
            .push(TrustedPublisherPin {
                namespace: record.namespace.as_str().to_string(),
                name: record.name.clone(),
                scope_label: record.scope_label.clone(),
                publisher_key: record.publisher_key.clone(),
                pinned_at: record.pinned_at.clone(),
            });
    }

    let mut conflict_count = 0usize;
    let names: Vec<TrustedPublisherName> = grouped
        .into_iter()
        .map(|((namespace, name), pins)| {
            let distinct: std::collections::BTreeSet<&str> =
                pins.iter().map(|p| p.publisher_key.as_str()).collect();
            let has_key_conflict = distinct.len() > 1;
            if has_key_conflict {
                conflict_count += 1;
            }
            TrustedPublisherName {
                namespace,
                name,
                pins,
                has_key_conflict,
            }
        })
        .collect();

    Ok(TrustedPublisherReport {
        names,
        total_pins,
        conflict_count,
        error: String::new(),
    })
}

/// The ONE `TrustStatus` -> wire-string map lives in `calp_inspector`
/// (`trust_status_str`), and this file delegates to it.
///
/// A second exhaustive match saying the same thing is a second match that can
/// DISAGREE, and a trust state that renders as the wrong word is a security bug,
/// not a cosmetic one. One map also means the frontend presentation tests have
/// exactly one source of truth to parse.
fn calp_trust_status_str(trust: calp::integrity::TrustStatus) -> String {
    crate::calp_inspector::trust_status_str(trust)
}

/// THE pin policy for a pull, decided from the request alone.
///
/// Extracted so the decision is directly testable: it is the single place that
/// answers "may this pull CREATE a TOFU pin?", and getting it wrong means a
/// script silently deciding which Ed25519 key this machine trusts for an application
/// name forever after.
///
///   * `require_pinned` -> [`PinPolicy::RequirePinned`]. Set only by the scripted
///     gateway. Wins over everything: a script may install an application the user
///     already trusts, never mint the trust. Note it also outranks
///     `accept_name_conflict`, so a script cannot smuggle a conflict-accepting
///     pin through by setting both.
///   * `accept_name_conflict` -> [`PinPolicy::PinAcceptingNameConflict`]. The
///     user was shown the cross-workspace name conflict and accepted it.
///   * neither -> [`PinPolicy::PinOnFirstUse`]. The ordinary interactive
///     Subscribe: a human reviewed the publisher.
pub(crate) fn pull_pin_policy(params: &PullParams) -> calp::integrity::PinPolicy {
    if params.require_pinned {
        calp::integrity::PinPolicy::RequirePinned
    } else if params.accept_name_conflict {
        calp::integrity::PinPolicy::PinAcceptingNameConflict
    } else {
        calp::integrity::PinPolicy::PinOnFirstUse
    }
}

/// Pull (subscribe to) an application.
#[tauri::command]
pub fn calp_pull(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, BiState>,
    script_state: State<'_, crate::scripting::types::ScriptState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    params: PullParams,
    window: tauri::Window,
) -> Result<PullResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // ROLE GATE — the mirror of `CALP_CHECKOUT_IS_SUBSCRIBER`, and the other half
    // of the §2.3 rule "one role per application". Checkout refused a subscriber;
    // nothing refused the reverse, so a developer could subscribe to the very
    // application their workbook was the working copy of and end up with the
    // application's sheets present TWICE — once as theirs to push, once as
    // somebody's to refresh over — which is the confusion this whole invariant
    // exists to prevent, arriving by the one door that was left open.
    //
    // BEFORE the `DocumentEffect`, which dirties at construction: a refusal must
    // not leave the document modified.
    {
        let link = state.working_copy_link.read().map_err(|e| e.to_string())?;
        if let Some(existing) = link.as_ref() {
            if existing.targets(&params.registry_path, &params.package_name) {
                return Err(format!(
                    "CALP_PULL_IS_WORKING_COPY: This workbook is the WORKING COPY of '{}' \
                     (based on v{}) — its sheets are already here, and they are yours to \
                     push. Subscribing to it as well would add a second, read-only copy \
                     of the same content. To see what a subscriber sees, use a dev \
                     subscription in a new window instead.",
                    existing.package_name, existing.base_version
                ));
            }
        }
    }

    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;

    // WHAT THIS SUBSCRIPTION WILL FOLLOW. Three refusals, all of them BEFORE
    // the document is touched, and all of them about the same thing: a
    // subscriber must know which stream of versions they are joining.
    let has_pin = !params.version_pin.trim().is_empty();
    let target = match (&params.environment, has_pin) {
        (Some(env), true) => {
            return Err(format!(
                "CALP_PULL_TARGET_AMBIGUOUS: this subscribe names both an environment \
                 ('{}') and a version pin ('{}'). They are two different answers to \
                 'which version should this workbook follow', so pick one.",
                env,
                params.version_pin.trim()
            ));
        }
        (Some(env), false) => calp::manifest::SubscriptionTarget::Environment(env.clone()),
        (None, _) => {
            // NO ENVIRONMENT NAMED. Fine for an application that has none —
            // which is every application until a team sets a pipeline up. On one
            // that HAS environments it is the footgun the whole feature exists
            // to close: the line receives every push before anyone has tested
            // it, and a consumer who lands there finds out when a half-finished
            // report reaches them. Following the line stays possible, as a
            // choice somebody made.
            if !params.follow_line {
                let envs = calp::environments::environments(&registry, &params.package_name)
                    .unwrap_or_default();
                if !envs.is_empty() {
                    return Err(format!(
                        "CALP_PULL_ENVIRONMENT_REQUIRED: '{}' publishes through environments \
                         ({}). Pick one — usually '{}' — or choose to follow the development \
                         line deliberately, which receives every change before it has been \
                         tested.",
                        params.package_name,
                        envs.iter().map(|e| e.name.as_str()).collect::<Vec<_>>().join(", "),
                        envs.last().map(|e| e.name.as_str()).unwrap_or("prod"),
                    ));
                }
            }
            calp::manifest::SubscriptionTarget::Line(
                VersionPin::parse(&params.version_pin).map_err(|e| e.to_string())?,
            )
        }
    };

    // ONE ROLE PER APPLICATION, and one subscription per application.
    //
    // Two subscriptions to the same (workspace, application) — test and prod in
    // one workbook, say — collide in three places that key on the package name
    // alone: `PreviewedVersions`, `calp_reset_subscription`'s first-match
    // lookup, and the materializer's sheet-collision pass. Refused here rather
    // than half-working.
    {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        if let Some(existing) = subs.subscriptions.iter().find(|s| {
            s.package_name == params.package_name
                && calp::same_workspace(&s.registry_url, &params.registry_path)
        }) {
            return Err(format!(
                "CALP_PULL_ALREADY_SUBSCRIBED: this workbook already subscribes to '{}' \
                 from that workspace{}. To follow a different environment, change it in \
                 Manage Subscriptions rather than subscribing twice.",
                params.package_name,
                existing
                    .environment
                    .as_ref()
                    .map(|e| format!(" (environment '{e}')"))
                    .unwrap_or_default()
            ));
        }
    }

    let now = chrono::Utc::now().to_rfc3339();

    let request = calp::pull::PullRequest {
        package_name: params.package_name.clone(),
        target,
        now,
    };

    // COMMIT POINT. Subscribe is the one .calp flow in which the user has
    // deliberately chosen to trust this publisher for this application name, so it
    // is the one flow allowed to CREATE the TOFU pin. Every other .calp path --
    // inspect, workbook open, refresh, reset, writeback, GATHER -- is either
    // VerifyOnly or RequirePinned. If an application is not yet pinned on this
    // machine, subscribing here is how it becomes pinned.
    // A cross-workspace NAME CONFLICT is refused unless the user was shown it and
    // said yes to a second, differently-worded question. `PinOnFirstUse` errors
    // on a conflict; only the flag set by that confirmation reaches the accepting
    // policy. Both are commit points with a human behind them.
    //
    // TWO CALLERS, TWO POLICIES: see `pull_pin_policy`.
    let policy = pull_pin_policy(&params);
    let mut result = calp::pull::pull(
        &registry,
        &request,
        &scope,
        &calcula_profile_dir(),
        policy,
    )
    .map_err(|e| e.to_string())?;

    // A publisher may not write into the host's reserved `__calcula_` id
    // namespace. HERE, before the effect below dirties the document at
    // construction: a refused subscribe must leave a clean workbook clean.
    refuse_reserved_distributed_script_ids(
        &result.package_name,
        &result.module_scripts,
        &result.notebooks,
    )?;

    // ONE EFFECT, constructed after every refusal that precedes a write.
    //
    // It used to be the statement above `open_workspace_scoped`, so a subscribe
    // that failed on an unreachable workspace, an unparseable version pin, or
    // any of the pull gates (signature, TOFU, min_app_version, the checksum
    // walk) left a CLEAN workbook marked modified — arming the
    // close-without-saving prompt for a command that wrote nothing. `mutates`
    // dirties at construction, so placement is the whole of the rule.
    //
    // A pull materializes application content into THIS workbook: it changes
    // what a save writes, and (unlike open_file) nothing resets the flag
    // afterwards.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);

    // Materialize into the workbook through the shared materializer — the
    // same code the CHECKOUT path runs, so application fidelity cannot drift
    // between consuming an application and developing one.
    materialize_pull_result(
        &state,
        &effect,
        &pivot_state,
        &bi_state,
        &script_state,
        &ribbon_filter_state,
        &pane_control_state,
        &slicer_state,
        result,
        MaterializeMode::Subscribe,
        Some(&window),
    )
}

/// What a materialization IS — consuming an application, or opening it to develop.
///
/// The two paths share every line of the materializer below, which is the
/// point: the fidelity matrix's root cause was a hand-written per-type
/// materializer, and a second one written for checkout would drift from this
/// one on the first artifact type somebody added. What differs is recorded
/// here, in three places, rather than in a parallel copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MaterializeMode {
    /// A subscriber pulling an application to USE it. Records a Subscription with
    /// the provenance ledger, so refresh/override/reset have something to act
    /// on.
    Subscribe,
    /// A developer checking an application out to EDIT it. Records NO subscription:
    /// a working copy is not a subscriber of its own application (the two roles are
    /// exclusive — see docs/design/calp-workspace-collaboration.md §2.3), and a
    /// subscription here would make the workbook refuse its own push.
    Checkout,
}

/// Materialize a pulled application version into the open workbook.
///
/// Extracted verbatim from `calp_pull` so `calp_checkout` runs the identical
/// path. Every artifact type the application can carry lands here — sheets and
/// their presentation state, tables, charts, sparklines, named ranges, CF/DV,
/// comments/scenarios/outlines, cell behaviors, controls and their media, pane
/// controls, custom objects, module scripts, notebooks, slicers, ribbon
/// filters, pivot layouts, theme, extension data, BI data sources and pivots.
#[allow(clippy::too_many_arguments)]
pub(crate) fn materialize_pull_result(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    pivot_state: &crate::pivot::types::PivotState,
    bi_state: &BiState,
    script_state: &crate::scripting::types::ScriptState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    pane_control_state: &crate::pane_control::PaneControlState,
    slicer_state: &crate::slicer::SlicerState,
    mut result: calp::pull::PullResult,
    mode: MaterializeMode,
    // Needed for the one live-refresh emit below: an application that brings custom
    // functions must re-install the UDF registry now, or its formulas read
    // #NAME? until the workbook is reopened.
    //
    // OPTIONAL so this function is testable. A `tauri::Window` cannot be built
    // outside a running app, and requiring one made 700 lines of
    // materialization — every artifact type an application can carry — reachable
    // only from a live app. That is how the active-sheet mirror desync below
    // shipped. `None` means "no frontend to notify", which is exactly true in
    // a test.
    window: Option<&tauri::Window>,
) -> Result<PullResponse, String> {
    // S5 phase 2: capture the origin/trust outcome before `result` is consumed.
    let publisher_name = result.publisher_name.clone();
    // EXHAUSTIVE on purpose: a new TrustStatus must not reach the frontend
    // before someone decides how it is presented. `NotPinned` is unreachable
    // here (PinOnFirstUse pins instead of reporting it) but is still spelled
    // out rather than swept into a `_` arm.
    let trust_status = calp_trust_status_str(result.trust_status);
    let other_scope_pins =
        crate::calp_inspector::other_scope_pins_wire(&result.other_scope_pins);

    let sheets_pulled = result.sheets.len();

    // Resolve pulled-sheet name collisions against the subscriber's existing
    // sheets (Excel-style "Sheet1 (2)") BEFORE materialization, so the
    // workbook tabs, the provenance ledger, and the persisted subscription's
    // local_name all agree — subscribing to an application whose sheet shares a
    // name with an existing sheet must not produce two identically-named tabs.
    // The publisher-name -> resolved-name map is kept: pulled pivot
    // definitions anchor their output by SHEET NAME (destination_sheet), and
    // without remapping a renamed sheet's pivot would land on the subscriber's
    // same-named sheet instead.
    let sheet_rename_map: std::collections::HashMap<String, String> = {
        let original_names: Vec<String> =
            result.sheets.iter().map(|ps| ps.name.clone()).collect();
        let mut taken = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
        calp::pull::resolve_sheet_name_collisions(
            &mut result.sheets,
            &mut result.subscription.sheets,
            &mut taken,
            &std::collections::HashSet::new(),
        );
        original_names
            .into_iter()
            .zip(result.sheets.iter())
            .filter(|(orig, ps)| *orig != ps.name)
            .map(|(orig, ps)| (orig, ps.name.clone()))
            .collect()
    };

    // Materialize pulled sheets into the workbook.
    // Each pulled sheet has its own local StyleRegistry; we merge styles into
    // the shared registry and remap cell style_index values accordingly.
    //
    // Set inside the grid-lock scope below, consumed after it drops — the
    // mirror write takes its own lock. See the note at the assignment.
    let mut active_grid_after_materialize: Option<engine::grid::Grid> = None;
    let (chart_sheet_index, pkg_to_index, pulled_index_range) = {
        let mut grids = state.grids.write(&effect).map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.write(&effect).map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.write(&effect).map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.write(&effect).map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.write(&effect).map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.write(&effect).map_err(|e| e.to_string())?;

        // Workbook index where pulled sheets land — a chart (keyed by its local
        // sheet id) remaps to this for ChartEntry.sheet_index.
        let base_index = grids.len();
        let mut chart_index_map: std::collections::HashMap<_, usize> =
            std::collections::HashMap::new();
        // application sheet id -> local sheet index. Named ranges + CF/DV carry the
        // un-remapped APPLICATION sheet id (unlike charts/sparklines, which pull.rs
        // already remapped to the local sheet id), so they need this map.
        let mut pkg_to_index: std::collections::HashMap<_, usize> =
            std::collections::HashMap::new();

        for (i, pulled) in result.sheets.iter().enumerate() {
            let (mut grid, local_styles) = pulled.sheet.to_grid();

            // Remap local style indices (cells AND row/column tiers) to the
            // shared registry, preserving explicit-default duplicates.
            let remap = shared_styles.merge_remap(&local_styles);
            grid.remap_style_indices(&remap);

            grids.push(grid);
            sheet_names.push(pulled.name.clone());
            sheet_ids.push(pulled.sheet.id);
            all_cw.push(pulled.sheet.column_widths.clone());
            all_rh.push(pulled.sheet.row_heights.clone());
            // DYNAMIC-ARRAY OWNERSHIP for the pulled sheet (§2ab). The application
            // carries the same spill extents a `.cala` does -- both sides go
            // through `cells_to_sheet_data` / `sheet_data_to_cells` -- so the
            // subscriber's arrays are owned the moment they land, without any
            // recalculation, which is the whole point of persisting the extent
            // rather than recomputing it. Called under the grid locks, which is
            // the canonical order for the spill maps.
            crate::spill_restore::restore_spill_extents_for_sheet(
                state,
                base_index + i,
                &pulled.sheet,
            );
            chart_index_map.insert(pulled.sheet.id, base_index + i);
            pkg_to_index.insert(pulled.package_sheet_id, base_index + i);
        }

        // SYNC THE ACTIVE-SHEET MIRROR when a sheet we just created IS the
        // active one.
        //
        // `state.grid` is the authoritative copy of the active sheet, and
        // `run_calculation_pass` opens by doing `grids[active] = grid.clone()`
        // — a whole-Grid REPLACEMENT, not a value write (calculation.rs:1107).
        // Meanwhile `recalculate_sheet_values` only ever mirrors FORMULA cells
        // into it (it iterates `filter_map(|c| c.formula_string())`). So a
        // materialized sheet that lands on `active` with a stale mirror loses
        // every LITERAL cell on the next recalculation: the mirror fills with
        // formula results, and the copy-back deletes everything else, key and
        // all. That is exactly the reported symptom — publish a sheet of values
        // and formulas, open it, and only the formulas are there.
        //
        // CHECKOUT is where it bites hardest: the document reset blanks the
        // mirror and sets active_sheet = 0, and the application's first sheet lands
        // at index 0 — so the mirror is EMPTY while grids[0] holds the application.
        // `collect_active_sheet_cells` reads the mirror, so the command was
        // also returning an empty cell list to the frontend.
        //
        // CONDITIONAL, never unconditional: `grids[active]` may legitimately
        // lag behind the mirror (BUG-0016), so copying grids -> mirror for a
        // sheet we did NOT just create would discard the user's live edits on
        // it. Same guard, same reason, as the refresh path's
        // `active_was_refreshed`.
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        if active >= base_index && active < grids.len() {
            active_grid_after_materialize = grids.get(active).cloned();
        }

        // The true state-vector span the pulled sheets occupy. The landing
        // decision needs it, but cannot be made here — see below.
        (chart_index_map, pkg_to_index, base_index..grids.len())
    };
    if let Some(grid) = active_grid_after_materialize {
        *state.grid.write(effect).map_err(|e| e.to_string())? = grid;
    }

    // Provenance ledger: everything this pull actually materializes. Stored on
    // the Subscription (subscriptions.json) so the Application Explorer can show
    // "which objects are connected to this application" and refresh can replace
    // exactly the application-owned objects.
    let mut sub_objects: Vec<calp::manifest::SubscribedObject> = Vec::new();
    let sub_object = |kind: &str, id: String, name: String| calp::manifest::SubscribedObject {
        kind: kind.to_string(),
        id,
        name,
        extra: std::collections::HashMap::new(),
    };

    // Materialize pulled sheet presentation state (merges, freeze panes, tab
    // color, visibility, gridlines, page setup, notes, hyperlinks) and keep the
    // index-aligned per-sheet stores aligned for the appended sheets.
    {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        let pairs: Vec<(SheetId, &persistence::Sheet)> = result
            .sheets
            .iter()
            .map(|p| (p.package_sheet_id, &p.sheet))
            .collect();
        materialize_pulled_sheet_state(&state, &effect, &pairs, &pkg_to_index, active)?;
    }

    // WHICH SHEET THE USER SHOULD LAND ON — answered here, where the true
    // state-vector indices are known, rather than reconstructed by the caller
    // from a filtered list.
    //
    // `build_sheet_list` OMITS object-backed sheets (a floating range's backing
    // sheet) and says so in its own doc: "`index` stays the TRUE position in the
    // state vectors — consumers must match by `s.index`, never by list
    // position." The subscribe dialog was computing `sheets.length -
    // sheetsPulled`, which is list arithmetic: with any object-backed sheet
    // below the pulled ones it names the wrong sheet, the pulled sheet never
    // becomes active, its content never reaches the active-sheet mirror, and the
    // next recalculation copies the mirror back over it.
    //
    // AFTER `materialize_pulled_sheet_state`, AND THAT IS THE WHOLE POINT. This
    // sat 30 lines EARLIER, inside the grid-lock scope — before the only code
    // that extends `sheet_visibility` for the appended sheets. Every probed
    // index was past the end of that vector, `is_user_sheet` reads a missing
    // slot as `unwrap_or(true)`, and `find` therefore returned `base_index`
    // unconditionally. The filter the comment above describes could not skip
    // anything, object-backed or otherwise.
    //
    // LANDABLE, not merely user-owned: `activate_sheet` refuses an object sheet
    // AND a hidden one, and an application's first sheet may legitimately be
    // hidden (`PublishedSheetMetadata` carries visibility and the pull restores
    // it verbatim). Naming one meant the frontend's `setActiveSheet` came back
    // "Sheet 'Raw' is hidden and cannot be activated", which both call sites
    // swallow into a `console.warn` — the dialog closed, the tabs appeared, and
    // the user was left on their own sheet with nothing said.
    let first_pulled_user_sheet: Option<usize> = {
        let visibility = state.sheet_visibility.read().map_err(|e| e.to_string())?;
        pulled_index_range.clone().find(|&i| {
            crate::sheets::is_user_sheet(&visibility, i)
                && crate::sheets::sheet_is_visible(&visibility, i)
        })
    };

    // Materialize pulled tables. The application carries full table objects
    // (tables/{id}.json); before this they were read, counted, and then
    // dropped — the subscriber got the cells but lost the table entity (name,
    // structured references, header/filter behavior).
    let tables_materialized =
        materialize_pulled_tables(&effect, &state, &result.tables, &pkg_to_index, Some(&mut sub_objects))?;

    // Materialize pulled object scripts (forced to restricted mode by the calp layer)
    let scripts_pulled = result.object_scripts.len();
    if !result.object_scripts.is_empty() {
        let mut scripts = state.object_scripts.write(&effect).map_err(|e| e.to_string())?;
        for script in result.object_scripts {
            // Don't overwrite existing scripts with the same ID (subscriber may have modified)
            if !scripts.iter().any(|s| s.id == script.id) {
                sub_objects.push(sub_object(
                    "objectScript",
                    script.id.clone(),
                    script.name.clone(),
                ));
                scripts.push(script);
            }
        }
    }

    // Materialize pulled charts onto their (remapped) sheet index, so the
    // subscriber sees the report's charts in-app. Don't overwrite a chart the
    // subscriber already has by id.
    if !result.charts.is_empty() {
        let mut charts = state.charts.write(&effect).map_err(|e| e.to_string())?;
        for chart in result.charts {
            if let Some(&sheet_index) = chart_sheet_index.get(&chart.sheet_id) {
                if !charts.iter().any(|c| c.id == chart.id) {
                    sub_objects.push(sub_object("chart", chart.id.to_string(), String::new()));
                    charts.push(crate::api_types::ChartEntry {
                        id: chart.id,
                        sheet_index,
                        spec_json: chart.spec_json,
                    });
                }
            }
        }
    }

    // Materialize pulled sparklines onto their (remapped) sheet index (C2a).
    // Sparklines carry no id, so dedupe by (sheet_index, groups_json) to avoid
    // duplicating one the subscriber already has.
    if !result.sparklines.is_empty() {
        let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
        for sp in result.sparklines {
            if let Some(&sheet_index) = chart_sheet_index.get(&sp.sheet_id) {
                let already = sparklines
                    .iter()
                    .any(|e| e.sheet_index == sheet_index && e.groups_json == sp.groups_json);
                if !already {
                    sparklines.push(crate::api_types::SparklineEntry {
                        sheet_index,
                        groups_json: sp.groups_json,
                    });
                }
            }
        }
    }

    // Materialize pulled named ranges. Pull is ADDITIVE (unlike .cala load): the
    // subscriber's own names are kept; a pulled name is added only if absent.
    // Keyed by the UPPERCASED name (the case-insensitive lookup invariant);
    // PublishedNamedRange.sheet_id is the APPLICATION id, mapped to the local index.
    if !result.named_ranges.is_empty() {
        let mut names = state.named_ranges.write(&effect).map_err(|e| e.to_string())?;
        for nr in &result.named_ranges {
            let key = nr.name.to_uppercase();
            if names.contains_key(&key) {
                continue; // don't clobber a name the subscriber already defined
            }
            sub_objects.push(sub_object("namedRange", key.clone(), nr.name.clone()));
            names.insert(
                key,
                crate::named_ranges::NamedRange {
                    name: nr.name.clone(),
                    sheet_index: nr.sheet_id.and_then(|sid| pkg_to_index.get(&sid).copied()),
                    refers_to: nr.refers_to.clone(),
                    comment: None,
                    folder: None,
                },
            );
        }
    }

    // §2t ON THE DISTRIBUTION PATH. An application stores every formula as TEXT and
    // `to_grid()` above re-parsed it, and the lexer upper-cases every bare
    // identifier -- so a publisher's `=BudgetTotal*2` arrives in the
    // subscriber's workbook as `=BUDGETTOTAL*2`, exactly the defect §2t fixed
    // for `open_file` and the sheet operations. This is the same restamp those
    // paths run, over the name table this pull has just added to: the pulled
    // names AND the subscriber's own are both authorities for the spelling of
    // a formula on a pulled sheet. Costs nothing when no name is defined (the
    // restamp returns on the first `is_empty()`), and it is cosmetic by
    // construction -- every name lookup uppercases.
    crate::persistence::restamp_workbook_name_casing(&state, &effect);

    // Materialize pulled conditional formats onto the (remapped) local sheet index.
    // Pulled sheets are freshly appended, so each lands on an empty per-sheet Vec.
    // Advance next_cf_rule_id past any pulled CF id to avoid collisions.
    if !result.conditional_formats.is_empty() {
        let mut max_id: u64 = 0;
        {
            let mut store = state.conditional_formats.write(&effect).map_err(|e| e.to_string())?;
            for entry in &result.conditional_formats {
                if let Some(&idx) = pkg_to_index.get(&entry.sheet_id) {
                    if let Ok(defs) = serde_json::from_value::<
                        Vec<crate::conditional_formatting::ConditionalFormatDefinition>,
                    >(entry.rules.clone())
                    {
                        for d in &defs {
                            max_id = max_id.max(d.id);
                        }
                        store.entry(idx).or_default().extend(defs);
                    }
                }
            }
        }
        if let Ok(mut next_id) = state.next_cf_rule_id.lock() {
            if *next_id <= max_id {
                *next_id = max_id + 1;
            }
        }
    }

    // Materialize pulled data validations onto the (remapped) local sheet index.
    if !result.data_validations.is_empty() {
        let mut store = state.data_validations.write(&effect).map_err(|e| e.to_string())?;
        for entry in &result.data_validations {
            if let Some(&idx) = pkg_to_index.get(&entry.sheet_id) {
                if let Ok(ranges) = serde_json::from_value::<
                    Vec<crate::data_validation::ValidationRange>,
                >(entry.ranges.clone())
                {
                    store.entry(idx).or_default().extend(ranges);
                }
            }
        }
    }

    // Materialize pulled threaded comments (Wave B; present only when the
    // publisher opted in) onto the (remapped) local sheet index. Pulled sheets
    // are freshly appended, so each lands on an empty per-sheet map — plain
    // insert, CF/DV semantics. No ledger entries (sheet-scoped payloads, like
    // CF/DV). Re-stamp each thread's sheet_index with the LOCAL index.
    if !result.comments.is_empty() {
        let mut store = state.comments.write(&effect).map_err(|e| e.to_string())?;
        for entry in &result.comments {
            if let Some(&idx) = pkg_to_index.get(&entry.sheet_id) {
                if let Ok(threads) = serde_json::from_value::<Vec<crate::comments::Comment>>(
                    entry.comments.clone(),
                ) {
                    let sheet_map = store.entry(idx).or_default();
                    for mut c in threads {
                        c.sheet_index = idx;
                        sheet_map.insert((c.row, c.col), c);
                    }
                }
            }
        }
    }

    // Materialize pulled what-if scenarios (Wave B) — same shape as comments.
    if !result.scenarios.is_empty() {
        let mut store = state.scenarios.write(&effect).map_err(|e| e.to_string())?;
        for entry in &result.scenarios {
            if let Some(&idx) = pkg_to_index.get(&entry.sheet_id) {
                if let Ok(mut scenarios) = serde_json::from_value::<Vec<crate::api_types::Scenario>>(
                    entry.scenarios.clone(),
                ) {
                    for s in &mut scenarios {
                        s.sheet_index = idx;
                    }
                    store.entry(idx).or_default().extend(scenarios);
                }
            }
        }
    }

    // Materialize pulled outline groups (Wave B). One SheetOutline per sheet;
    // the freshly appended sheet has no existing outline, so plain insert.
    if !result.outlines.is_empty() {
        let mut store = state.outlines.write(&effect).map_err(|e| e.to_string())?;
        for entry in &result.outlines {
            if let Some(&idx) = pkg_to_index.get(&entry.sheet_id) {
                if let Ok(outline) = serde_json::from_value::<crate::grouping::SheetOutline>(
                    entry.outline.clone(),
                ) {
                    store.insert(idx, outline);
                }
            }
        }
    }

    // Materialize pulled CELL BEHAVIOR bindings (granular bricks phase 2),
    // remapping each application sheet id to the local index it landed on. Uses the
    // same materializer as the .cala load path, so a pulled binding and a loaded
    // one are the same object — and, like a loaded one, a binding naming a
    // script that is not present stays inert until that script arrives.
    //
    // Until this existed the application carried no bindings at all: a subscriber
    // pulled a report whose typed cells looked right and did nothing at all,
    // with no line in the publish transparency report to say so.
    if !result.cell_behaviors.is_empty() {
        let mut store = state.cell_behaviors.write(&effect).map_err(|e| e.to_string())?;
        let added = crate::cell_behaviors::materialize_saved_cell_behaviors(
            &result.cell_behaviors,
            &mut store,
            |sid| pkg_to_index.get(&sid).copied(),
        );
        log::info!("[calp] pulled {} cell-behavior binding(s)", added);
    }

    // On-grid name snapshot for the pane-control collision guard below —
    // taken BEFORE the application's own on-grid controls materialize, so the
    // guard sees only the SUBSCRIBER's pre-existing names. Taking it after
    // would let the application's own just-landed on-grid names enter
    // taken_names and shadow the application's own same-named pane controls.
    // (The snapshot's lock is released inside the helper before any other
    // control lock is taken — canonical order preserved.)
    let on_grid_snapshot = snapshot_on_grid_controls(&state)?;

    // Take the application's binary media BEFORE the controls that reference it, so
    // a materialized picture never points at bytes that are not there yet. Every
    // blob is re-validated (magic bytes, caps, and its key re-derived from its
    // own content): the signed manifest proves the publisher sent these bytes,
    // not that they are a picture this build will accept.
    if !result.media.is_empty() {
        let media = std::mem::take(&mut result.media);
        let (accepted, rejected) = crate::media::merge_pulled_media(&state, &effect, media)?;
        log::info!("[calp] pulled {} media blob(s), refused {}", accepted, rejected);
    }

    // Materialize pulled controls (buttons/checkboxes) onto the freshly-
    // appended sheets — SANITIZED: distributed onSelect wiring is inline
    // script source and must not execute outside the consent model, so
    // packaged buttons arrive visually intact but disarmed. Publisher-shipped
    // interactivity flows through the consent-gated object scripts above.
    if !result.controls.is_empty() {
        let local_sheet_ids: std::collections::HashMap<SheetId, (SheetId, String)> = result
            .sheets
            .iter()
            .map(|p| (p.package_sheet_id, (p.sheet.id, p.name.clone())))
            .collect();
        // Sanitize AND migrate: an application published before media artifacts
        // existed carries its images base64'd inside the signed controls.json,
        // and materialization writes straight into ControlStorage — so without
        // this the legacy pull is the one route left that puts unvalidated
        // binary into a document. Takes the media lock, so it must precede the
        // controls lock below.
        let sanitized = crate::media::admit_distributed_controls(&state, &effect, &result.controls)?;
        let mut controls = state.controls.write(&effect).map_err(|e| e.to_string())?;
        crate::controls::materialize_saved_controls(
            &sanitized,
            &mut controls,
            |sid| pkg_to_index.get(&sid).copied(),
        );
        for entry in &result.controls {
            if let Some((local_sid, sheet_name)) = local_sheet_ids.get(&entry.sheet_id) {
                sub_objects.push(sub_object(
                    "controlSheet",
                    local_sid.to_string(),
                    sheet_name.clone(),
                ));
            }
        }
    }

    // Materialize generic custom objects (distribution brick 4). Cell types
    // (the dogfood) are applied Rust-side, mirroring controls: reconstruct a
    // per-sheet SavedSheetCellTypes and materialize with the application->local
    // sheet remap. Unknown kinds fall through to the frontend response
    // (`custom_objects`) for third-party distributable-object providers. Every
    // custom object is recorded in the subscription ledger.
    let mut frontend_custom_objects: Vec<PulledCustomObjectDto> = Vec::new();
    {
        let cell_type_saved: Vec<persistence::SavedSheetCellTypes> = result
            .custom_objects
            .iter()
            .filter(|co| co.kind == "cellType")
            .filter_map(|co| {
                co.package_sheet_id.map(|sid| persistence::SavedSheetCellTypes {
                    sheet_id: sid,
                    cells: co.payload.clone(),
                })
            })
            .collect();
        if !cell_type_saved.is_empty() {
            let mut cell_types = state.cell_types.write(&effect).map_err(|e| e.to_string())?;
            crate::cell_types::materialize_saved_cell_types(
                &cell_type_saved,
                &mut cell_types,
                |sid| pkg_to_index.get(&sid).copied(),
            );
        }
        for co in &result.custom_objects {
            sub_objects.push(sub_object(&co.kind, co.id.clone(), co.name.clone()));
            // Non-built-in kinds go to the frontend for provider materialization.
            if co.kind != "cellType" {
                frontend_custom_objects.push(PulledCustomObjectDto {
                    kind: co.kind.clone(),
                    id: co.id.clone(),
                    name: co.name.clone(),
                    sheet_index: co
                        .package_sheet_id
                        .and_then(|sid| pkg_to_index.get(&sid).copied()),
                    payload: co.payload.clone(),
                });
            }
        }
    }

    // Materialize pulled pane controls (Controls pane) into PaneControlState —
    // shared with the refresh path (see materialize_pulled_pane_controls for
    // the collision/ordering semantics). Ledger entries come from the APPLIED
    // list so a collision-skipped control is never attributed to this application.
    // `on_grid_snapshot` predates the application's own on-grid materialization
    // above (see the comment at its binding).
    let applied_pane_controls = materialize_pulled_pane_controls(
        &pane_control_state,
        &ribbon_filter_state,
        &on_grid_snapshot,
        &result.pane_controls,
    )?;
    for (id, name) in &applied_pane_controls {
        sub_objects.push(sub_object("paneControl", id.clone(), name.clone()));
    }

    // Delete-path hygiene: a collision-skipped pane control must not leave
    // the application's own just-landed "pane-{id}" object script behind with no
    // host control. Prune EXACTLY those scripts — this application's Distributed
    // set only; local scripts, other applications' scripts, and pane scripts of
    // applied/retained (id-collision) controls are untouched. Ledger entries
    // for pruned scripts are dropped too: they never became subscriber state.
    {
        let orphaned = orphaned_pane_script_instance_ids(
            &pane_control_state,
            &result.pane_controls,
        )?;
        if !orphaned.is_empty() {
            let mut removed_ids: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            let mut scripts = state.object_scripts.write(&effect).map_err(|e| e.to_string())?;
            scripts.retain(|s| {
                let orphan = matches!(s.provenance, persistence::ScriptProvenance::Distributed)
                    && s.package_name.as_deref() == Some(result.package_name.as_str())
                    && s.instance_id.as_deref().is_some_and(|i| orphaned.contains(i));
                if orphan {
                    crate::log_warn!(
                        "CALP",
                        "Pruning distributed script '{}' from application '{}': its host pane control was collision-skipped",
                        s.name, result.package_name
                    );
                    removed_ids.insert(s.id.clone());
                }
                !orphan
            });
            drop(scripts);
            sub_objects.retain(|o| !(o.kind == "objectScript" && removed_ids.contains(&o.id)));
        }
    }

    // Materialize pulled standalone module scripts + notebooks (C8) into
    // ScriptState. Shared with the refresh path so updates propagate
    // identically. Ledger entries come from the APPLIED lists so a
    // conflict-skipped local document is never attributed to this application.
    let (applied_modules, applied_notebooks, custom_functions_changed) =
        materialize_distributed_scripts(
            &effect,
            &script_state,
            &result.package_name,
            &result.module_scripts,
            &result.notebooks,
        )?;
    if custom_functions_changed {
        // Re-install the live UDF registry NOW — without this, the pulled
        // report's custom-function formulas stay #NAME? until a reopen.
        if let Some(window) = window {
            let _ = tauri::Emitter::emit(window, "custom-functions:refresh", ());
        }
    }
    for (id, name) in &applied_modules {
        sub_objects.push(sub_object("moduleScript", id.clone(), name.clone()));
    }
    for (id, name) in &applied_notebooks {
        sub_objects.push(sub_object("notebook", id.clone(), name.clone()));
    }

    // Materialize pulled slicers (Wave A) onto their (remapped) local sheet —
    // shared with the refresh path. Slicers carry the APPLICATION sheet id (CF/DV
    // semantics); one whose sheet wasn't pulled is dropped, one whose id the
    // subscriber already has is skipped. Ledger entries come from the APPLIED
    // list. Slicers referencing pivots/tables keep working because pivot and
    // table ids are stable EntityIds preserved through the application;
    // BiConnection-sourced slicers are re-bound to the freshly materialized
    // application connections below (remap_slicer_bi_connections runs inside
    // load_embedded_data_sources, next to the ribbon-filter re-bind).
    // Same sanitization discipline as on-grid controls: distributed
    // computed-property formulas never materialize.
    let applied_slicers = materialize_pulled_slicers(
        &effect,
        &state,
        &slicer_state,
        &sanitize_distributed_slicers(&result.slicers),
        |sid| pkg_to_index.get(&sid).copied(),
    )?;
    for (id, name) in &applied_slicers {
        sub_objects.push(sub_object("slicer", id.clone(), name.clone()));
    }

    // Materialize pulled ribbon filters (Wave A) — workbook-scoped, BI-only.
    // Filters whose data source is not embedded in the application are skipped
    // (they could never re-bind on this machine); id/name collisions are
    // skipped like pane controls. Inserted BEFORE load_embedded_data_sources
    // runs below, so its remap_ribbon_filter_connections call re-binds the
    // carried publisher connection ids onto the fresh application connections.
    let pulled_ds_ids: std::collections::HashSet<String> = result
        .data_sources
        .iter()
        .map(|ds| ds.definition.id.clone())
        .collect();
    let applied_ribbon_filters = materialize_pulled_ribbon_filters(
        &pane_control_state,
        &ribbon_filter_state,
        &effect,
        &on_grid_snapshot,
        &result.ribbon_filters,
        &pulled_ds_ids,
    )?;
    for (id, name) in &applied_ribbon_filters {
        sub_objects.push(sub_object("ribbonFilter", id.clone(), name.clone()));
    }

    // Materialize pulled saved pivot layouts (Wave A) — workbook-scoped,
    // ADDITIVE with skip-if-id-present (a subscriber's same-id layout wins).
    {
        let mut layouts = state.pivot_layouts.write(&effect).map_err(|e| e.to_string())?;
        for layout in &result.pivot_layouts {
            if layouts.iter().any(|l| l.id == layout.id) {
                continue;
            }
            sub_objects.push(sub_object(
                "pivotLayout",
                layout.id.to_string(),
                layout.name.clone(),
            ));
            layouts.push(layout.clone());
        }
    }

    // Apply the publisher's document theme (Wave A) — singleton, guarded:
    // only while the subscriber's theme is still the default. No ledger entry.
    apply_pulled_theme(&effect, &state, result.theme.as_ref())?;

    // Merge pulled extension data (Wave A) — additive, never overwrites the
    // subscriber's keys. Each key ACTUALLY inserted gets an "extensionData"
    // ledger entry (id = name = the map key), so the Application Explorer shows
    // exactly which extension state came from the application.
    for key in merge_pulled_extension_data(&state, &effect, &result.extension_data)? {
        sub_objects.push(sub_object("extensionData", key.clone(), key));
    }

    for def in &result.pivot_definitions {
        sub_objects.push(sub_object("pivot", def.id.to_string(), String::new()));
    }
    for ds in &result.data_sources {
        sub_objects.push(sub_object(
            "dataSource",
            ds.definition.id.clone(),
            ds.definition.name.clone(),
        ));
    }

    // Store subscription — WITH the provenance ledger of what this pull
    // actually materialized. Must precede rebuild_writeback_index (it reads
    // the subscription list).
    //
    // A CHECKOUT records none. `pull()` builds a Subscription unconditionally
    // (it cannot know which caller it has), and taking it here would make the
    // working copy a subscriber of the very application it is about to push to —
    // which the push gates then refuse, correctly, for the identity reason in
    // §2.3. Dropping it is the mode's whole job.
    match mode {
        MaterializeMode::Subscribe => {
            let mut subscription = result.subscription.clone();
            subscription.objects = sub_objects;
            let mut subs = state.subscriptions.write(effect).map_err(|e| e.to_string())?;
            subs.subscriptions.push(subscription);
        }
        MaterializeMode::Checkout => {
            let _ = sub_objects;
        }
    }

    // Rebuild writeback index from updated subscriptions
    rebuild_writeback_index(state);

    // Auto-load embedded BI models from the pulled application.
    // This creates BI connections so that BI pivots have a live engine to query.
    let embedded_connection_ids = load_embedded_data_sources(
        &result.data_sources,
        &bi_state,
        &ribbon_filter_state,
        &slicer_state,
    );
    // Re-queue the writeback->BI dataset refresh: the hook fired by
    // rebuild_writeback_index above ran before these connections existed, so
    // engines created here would otherwise miss their writeback data until the
    // next mutation.
    crate::bi::writeback_source::invalidate_writeback_bi();

    // Restore pivot definitions from the application and render to grid.
    // The source_sheet_index in each definition is relative to the publisher's
    // workbook. We need to offset it by the number of sheets that existed
    // before the pull (since pulled sheets are appended).
    if !result.pivot_definitions.is_empty() {
        let sheet_offset = {
            let names = state.sheet_names.read().map_err(|e| e.to_string())?;
            names.len() - sheets_pulled
        };
        restore_pulled_pivots(
            &effect,
            &result.pivot_definitions,
            &result.bi_pivot_metadata,
            &state,
            &pivot_state,
            sheet_offset,
            &embedded_connection_ids,
            &sheet_rename_map,
        );
    }

    // Audit (B4)
    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)) {
            let (event, description) = match mode {
                MaterializeMode::Subscribe => (
                    calp::audit::AuditEvent::Subscribe,
                    format!(
                        "Subscribed to {} v{} ({} sheets, {} scripts)",
                        result.package_name, result.resolved_version, sheets_pulled, scripts_pulled
                    ),
                ),
                MaterializeMode::Checkout => (
                    calp::audit::AuditEvent::CheckedOut,
                    format!(
                        "Opened {} v{} for editing ({} sheets, {} scripts)",
                        result.package_name, result.resolved_version, sheets_pulled, scripts_pulled
                    ),
                ),
            };
            audit.record(event, &description, &user, &now);
        }
    }

    Ok(PullResponse {
        package_name: result.package_name,
        resolved_version: result.resolved_version.to_string(),
        sheets_pulled,
        // Tables actually MATERIALIZED into the workbook (collision-skipped
        // ones excluded) — the old count reported tables merely read from the
        // application, overstating what happened.
        tables_pulled: tables_materialized,
        scripts_pulled,
        publisher_name,
        trust_status,
        other_scope_pins,
        custom_objects: frontend_custom_objects,
        first_pulled_sheet_index: first_pulled_user_sheet,
    })
}

// ===========================================================================
// Checkout — open a published application as a WORKING COPY
// ===========================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutParams {
    pub registry_path: String,
    pub package_name: String,
    /// A concrete version, or absent for the workspace head (what `latest`
    /// resolves to, and what a developer means by "open the current one").
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResponse {
    pub package_name: String,
    pub version: String,
    pub sheets_materialized: usize,
    pub scripts_materialized: usize,
    pub publisher_name: String,
    /// The TOFU outcome REPORTED, never recorded: a checkout is `VerifyOnly`.
    pub trust_status: String,
    /// Cells of the freshly materialized workbook, in the same shape
    /// `open_file` returns, so the frontend refreshes through one code path.
    pub cells: Vec<crate::api_types::CellData>,
    pub custom_objects: Vec<PulledCustomObjectDto>,
    /// TRUE state-vector index of the application's first user sheet, so the
    /// caller can land the user on it. `None` for an application that brings no
    /// sheets (a dataset or a library).
    ///
    /// The index the BACKEND reported, never list arithmetic: the sheet list
    /// omits object-backed sheets, so `len - materialized` names the wrong one
    /// whenever a floating range is present.
    pub first_sheet_index: Option<usize>,
}

/// Open a published application version for editing.
///
/// ADDS the application's sheets to the open workbook, carrying the
/// application's own sheet ids so the next push continues its identity rather
/// than forking it. It used to REPLACE the document — which meant the price of
/// opening an application for editing was whatever you were working on.
///
/// A workbook holds at most one working-copy link, so the two ways that breaks
/// are refused up front: already a working copy of another application, and
/// already a subscriber to THIS one.
///
/// The materialization is `calp_pull`'s, verbatim (see `materialize_pull_result`),
/// minus the subscription: a working copy is not a subscriber of its own
/// application.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn calp_checkout(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, BiState>,
    script_state: State<'_, crate::scripting::types::ScriptState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    // Kept in the signature though the additive checkout no longer resets them:
    // removing a Tauri command parameter is a wire change, and these two are the
    // stores a future non-additive path would need again.
    _user_files_state: State<'_, crate::persistence::UserFilesState>,
    _timeline_slicer_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    params: CheckoutParams,
    window: tauri::Window,
) -> Result<CheckoutResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;

    let version = match params.version.as_deref().filter(|v| !v.trim().is_empty()) {
        Some(v) => Some(SemVer::parse(v).map_err(|e| e.to_string())?),
        None => None,
    };
    let now = chrono::Utc::now().to_rfc3339();

    // Read + verify BEFORE touching the open document. Every gate — signature,
    // TOFU (VerifyOnly), min_app_version, the full per-artifact checksum walk —
    // runs in here, so an application that fails any of them leaves the user's
    // current workbook exactly as it was.
    let result = calp::checkout::checkout(
        &registry,
        &params.package_name,
        version,
        &now,
        &scope,
        &calcula_profile_dir(),
    )
    .map_err(|e| e.to_string())?;

    let resolved_version = result.resolved_version.to_string();
    let kind_for_link = registry
        .get_version_manifest(&params.package_name, &resolved_version)
        .map(|m| m.kind)
        .unwrap_or_else(|_| "report".to_string());
    let base_sheets: Vec<calp::WorkingCopySheetRef> = result
        .sheets
        .iter()
        .map(|s| calp::WorkingCopySheetRef {
            sheet_id: s.package_sheet_id,
            name: s.name.clone(),
        })
        .collect();
    // Captured BEFORE `result` moves into the materializer.
    let base_script_ids: Vec<String> =
        result.module_scripts.iter().map(|s| s.id.clone()).collect();
    let base_notebook_ids: Vec<String> =
        result.notebooks.iter().map(|n| n.id.clone()).collect();
    let base_named_range_keys: Vec<String> = result
        .named_ranges
        .iter()
        .map(|nr| nr.name.to_uppercase())
        .collect();

    // ROLE GATES, before anything is written.
    //
    // Checkout ADDS the application's sheets to the open workbook rather than
    // replacing the document — losing the sheet you were working on to open an
    // application for editing is not a trade anyone asked for. But a workbook
    // holds at most ONE working-copy link, and the roles are exclusive PER
    // APPLICATION (docs/design/calp-workspace-collaboration.md §2.3), so the two
    // ways that breaks are refused here with the remedy named.
    {
        let link = state.working_copy_link.read().map_err(|e| e.to_string())?;
        if let Some(existing) = link.as_ref() {
            if existing.targets(&params.registry_path, &params.package_name) {
                return Err(format!(
                    "CALP_CHECKOUT_ALREADY_OPEN: This workbook is already a working copy of \
                     '{}' (based on v{}). Its sheets are the ones you are looking at.",
                    existing.package_name, existing.base_version
                ));
            }
            return Err(format!(
                "CALP_CHECKOUT_ALREADY_LINKED: This workbook is already a working copy of \
                 '{}', and a workbook can be a working copy of only one application — \
                 otherwise a push has no single answer to 'which application am I \
                 pushing?'. Open '{}' in a new window instead.",
                existing.package_name, params.package_name
            ));
        }
    }
    {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        if subscribes_to(
            &subs.subscriptions,
            &params.registry_path,
            &params.package_name,
        ) {
            return Err(format!(
                "CALP_CHECKOUT_IS_SUBSCRIBER: This workbook already SUBSCRIBES to '{}'. A \
                 workbook can hold one role per application, not both — a subscribed copy's \
                 sheets carry their own local identity, and editing them as the application \
                 itself is exactly the confusion that would produce. Remove the subscription \
                 first (Distribution > Manage Subscriptions), or open the application in a \
                 new window.",
                params.package_name
            ));
        }
    }

    // ...and neither role may write into the host's reserved `__calcula_` id
    // namespace. A working copy is where an author's next PUSH comes from, so a
    // reserved id admitted here would be republished to every subscriber.
    // Before the effect, for the same reason as the gates above.
    refuse_reserved_distributed_script_ids(
        &params.package_name,
        &result.module_scripts,
        &result.notebooks,
    )?;

    // ONE effect for the whole command. Unlike `new_file`/`open_file` — which
    // tear down under `deliberately_clean` because they END clean — a checkout
    // ends DIRTY: the application's sheets exist only in memory until the user
    // saves, and closing without saving must prompt.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);

    let materialized = materialize_pull_result(
        &state,
        &effect,
        &pivot_state,
        &bi_state,
        &script_state,
        &ribbon_filter_state,
        &pane_control_state,
        &slicer_state,
        result,
        MaterializeMode::Checkout,
        Some(&window),
    )?;

    // The workbook now IS this application version. Record it, so the push gates
    // have an answer to "which application, from which base".
    {
        let mut link = state.working_copy_link.write(&effect).map_err(|e| e.to_string())?;
        let mut fresh = calp::WorkingCopyLink::new(
            &params.registry_path,
            &params.package_name,
            &kind_for_link,
            &resolved_version,
            &now,
            base_sheets,
        );
        // WHICH SCRIPTS AND NOTEBOOKS ARE THE APPLICATION'S. Additive checkout
        // leaves the author's own beside them, and without this record a push
        // published every one — a private module with an API token included.
        fresh.record_content(base_script_ids, base_notebook_ids, base_named_range_keys);
        *link = Some(fresh);
    }

    // THE FILE PATH IS LEFT ALONE. It used to be cleared, because a checkout
    // replaced the document and the resulting working copy genuinely had no file
    // of its own. It is now additive: the application's sheets join the workbook
    // the user already has open, so clearing the path would turn their next
    // Ctrl+S into a Save As for a file they never closed.

    let cells = crate::persistence::collect_active_sheet_cells(&state)?;

    Ok(CheckoutResponse {
        package_name: materialized.package_name,
        version: materialized.resolved_version,
        sheets_materialized: materialized.sheets_pulled,
        scripts_materialized: materialized.scripts_pulled,
        publisher_name: materialized.publisher_name,
        trust_status: materialized.trust_status,
        cells,
        custom_objects: materialized.custom_objects,
        first_sheet_index: materialized.first_pulled_sheet_index,
    })
}

// ===========================================================================
// Holding a change back from a push
// ===========================================================================

/// One cell the author unticked in the push diff.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldBackCellRef {
    /// The diff row's sheet id. A working copy's sheet ids ARE the
    /// application's, so this is directly a local sheet id.
    pub sheet_id: String,
    pub row: u32,
    pub col: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldBackCellsParams {
    pub registry_path: String,
    pub package_name: String,
    /// The version to take the held-back cells' values FROM — the base this
    /// push is being made against.
    pub base_version: String,
    pub cells: Vec<HoldBackCellRef>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldBackCellsResponse {
    /// How many cells were actually written back. A cell already equal to its
    /// base value is still counted: the caller must undo exactly what it asked
    /// for, and a count that silently shrank would make that impossible to
    /// verify.
    pub cells_held_back: usize,
    /// TRUE when a write happened and therefore an undo entry exists. The
    /// caller MUST call `undo` exactly once when this is true, and must NOT
    /// when it is false — a bare `undo` with nothing to reverse would take back
    /// the author's own last edit.
    pub undo_recorded: bool,
    /// The id of the undo entry this write left on the stack, to be handed back
    /// to `undo` as `expectedSeq`.
    ///
    /// A BARE UNDO IS NOT SAFE HERE, and this is why the feature shipped
    /// disabled. The caller's window is: hold back → publish → un-revert, and
    /// the publish is a long, IO-heavy command that records nothing itself but
    /// during which an MCP tool or a sandboxed script CAN record an entry
    /// (`mcp/tools.rs:336`, `mcp/objects.rs:357`). A bare `undo` then takes back
    /// that entry and leaves the author's own changes rolled back — the exact
    /// inverse of what the caller asked for, silently.
    ///
    /// `None` when nothing was written, which is the same condition as
    /// `undo_recorded == false`; both are reported because a caller that keys
    /// its `finally` on the wrong one gets the dangerous behaviour, not a
    /// compile error.
    pub undo_seq: Option<u64>,
}

/// Put the BASE version's value back into the cells the author unticked, so the
/// push that follows publishes a workbook without those changes.
///
/// THIS IS HALF OF A PAIR. The caller's contract is:
///
/// ```text
///   holdBackCells(...)        // returns undoRecorded
///   try   { publish(...) }
///   finally { if (undoRecorded) undo() }
/// ```
///
/// and the `finally` is the whole safety property. It is deliberately NOT
/// folded into `calp_publish`: doing it there would mean restructuring that
/// command's 190-line critical region so an un-revert ran on each of its six
/// `?` sites, and the guard that pins its shape
/// (`distributionGateway.test.ts`, which slices the source between
/// `pub fn calp_publish(` and `let assembly = assemble_publish_workbook`) goes
/// BLIND rather than red if that region moves. A `try/finally` in one caller is
/// a stronger guarantee than six hand-written error paths, and leaves the most
/// consequential command in the distribution stack untouched.
///
/// WHY REVERT AT ALL, rather than substituting values as the artifact is
/// written. Nothing on the receiving side ever recalculates: neither
/// `materialize_pull_result` (pull AND checkout) nor `open_file` evaluates a
/// cell. A published artifact assembled with some cells rolled back and their
/// dependents left as-is would show numbers that were never true, on every
/// subscriber's screen, indefinitely — and INVISIBLY, because `cells_equal`
/// hides formula cells whose formula did not change, so the corrupted
/// dependents never appear as diff rows to untick. Reverting in the live
/// document means the publish serializes a real, recalculated workbook state.
///
/// It also means the recalculation is an ORDINARY one, so there is no class of
/// cell that has to be refused. (CUBE and UDF cells are PRESERVED rather than
/// re-derived on this path — the batch pipeline passes no prefetch and no
/// resolver — which is the right answer for them anyway: their values come from
/// a model or a script, not from the workbook cells being rolled back.)
///
/// SURVIVES A CRASH. The write goes through the ordinary script-grid pipeline,
/// so it lands in the undo stack and dirties the document. If the process dies
/// between this and the `undo`, the author's edits are recoverable with Ctrl+Z
/// and AutoRecover has them. That is the property `DocumentEffect::transient`
/// could not offer — its restore registry is in memory and its writes are not
/// undoable — which is why this is not a transient write.
///
/// The sibling is `calp_merge::overlay_their_cells`, which does the same thing
/// (read a published version's cells, overlay them into cloned grids, apply
/// through the script pipeline) from a different selection source. They are not
/// one function because the selection differs — a diff there, an explicit cell
/// list here — and folding them together would put a merge concept in the
/// publish path.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn calp_hold_back_cells(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    params: HoldBackCellsParams,
    window: tauri::Window,
) -> Result<HoldBackCellsResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    if params.cells.is_empty() {
        return Ok(HoldBackCellsResponse {
            cells_held_back: 0,
            undo_recorded: false,
            undo_seq: None,
        });
    }


    // The base side, through the same verification every content read uses.
    let (registry, base_version, _manifest) = crate::calp_inspector::open_verified_content(
        &params.registry_path,
        &params.package_name,
        &format!("={}", params.base_version),
        true,
    )?;

    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    let mut grids = state.grids.read().map_err(|e| e.to_string())?.clone();
    let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;

    // Group by sheet so each sheet's artifact is read once.
    let mut by_sheet: std::collections::HashMap<String, Vec<(u32, u32)>> =
        std::collections::HashMap::new();
    for c in &params.cells {
        by_sheet.entry(c.sheet_id.clone()).or_default().push((c.row, c.col));
    }

    let mut held = 0usize;
    for (sheet_id, positions) in &by_sheet {
        let Some(local_index) = sheet_ids.iter().position(|id| id.to_string() == *sheet_id) else {
            return Err(format!(
                "CALP_HOLDBACK_NO_SHEET: the sheet '{}' named by the selection is not in this \
                 workbook any more. Close the push dialog and reopen it so the list matches.",
                sheet_id
            ));
        };

        // A sheet the base version does not have cannot hold anything back: the
        // author is ADDING it, and the unit for that is the sheet checkbox.
        let data = registry
            .read_artifact(
                &params.package_name,
                &base_version,
                &format!("sheets/{}/data.json", sheet_id),
            )
            .map_err(|e| e.to_string())?;
        let base_cells = match data {
            Some(bytes) => {
                let sd: calcula_format::sheet_data::SheetData =
                    serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                calcula_format::sheet_data::sheet_data_to_cells(&sd)
            }
            None => std::collections::HashMap::new(),
        };

        let grid = grids
            .get_mut(local_index)
            .ok_or_else(|| "Sheet index out of range while holding cells back.".to_string())?;

        for pos in positions {
            match base_cells.get(pos) {
                // TYPED, never re-parsed from a display string: the base value
                // goes back as the cell it was. Round-tripping "30.0" through
                // the input parser would read as TEXT under a locale whose
                // decimal separator is a comma.
                Some(saved) => {
                    grid.cells.insert(*pos, saved.to_cell());
                }
                // The base had nothing here — the author ADDED this cell, and
                // holding that addition back means the cell is empty in the
                // published version.
                None => {
                    grid.cells.remove(pos);
                }
            }
            held += 1;
        }
    }

    // A HELD-BACK CELL MAY NOT FEED A CELL THE RECALCULATION CANNOT RE-DERIVE.
    //
    // The recalculation below is the whole point of doing this in the live
    // document: publish an artifact where a rolled-back input still has the
    // author's numbers hanging off it and every subscriber sees a pair that was
    // never simultaneously true — silently, because nothing on the receiving
    // side recalculates and the push diff hides formula cells whose formula did
    // not change.
    //
    // CUBE, GATHER and custom-function cells break that: their value comes from
    // a model, from the workspace's writeback submissions, or from the script
    // host, and none of those is available to this synchronous command. What
    // they do instead is worse than an error — on a non-active sheet
    // `preserved_cube_value` reads the cell's OLD value straight back out of the
    // grid and re-writes it, so the stale number is re-committed as though
    // freshly computed. (`docs/design/open-items.md` §2.aa called for this
    // refusal whichever route the feature took; the feature shipped without it.)
    //
    // Refused by NAME rather than resolved either way, the same shape
    // `CALP_RESET_SPILL_CELL` uses one command over: this is rare, and the wrong
    // answer corrupts a published artifact rather than a cell.
    {
        let seeds: Vec<crate::non_derivable::Node> = by_sheet
            .iter()
            .filter_map(|(sheet_id, positions)| {
                let idx = sheet_ids.iter().position(|id| id.to_string() == *sheet_id)?;
                Some(positions.iter().map(move |&(r, c)| (idx, r, c)))
            })
            .flatten()
            .collect();

        // The LIVE grids, not the rolled-back clone: the question is which cells
        // depend on the held-back ones, and that is a property of the workbook
        // the author is looking at.
        let live_grids = state.grids.read().map_err(|e| e.to_string())?;
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let tables = state.tables.read().map_err(|e| e.to_string())?;
        let table_names = state.table_names.read().map_err(|e| e.to_string())?;
        let named_ranges = state.named_ranges.read().map_err(|e| e.to_string())?;
        let offenders = crate::non_derivable::non_derivable_dependents(
            &live_grids,
            crate::name_resolution::NameTables {
                named_ranges: &named_ranges,
                tables: &tables,
                table_names: &table_names,
                sheet_names: &sheet_names,
                spill_ranges: &state.spill_ranges,
            },
            &seeds,
        );
        if !offenders.is_empty() {
            let named: Vec<String> = offenders
                .iter()
                .take(5)
                .map(|((s, r, c), why)| {
                    format!(
                        "{}!{} ({})",
                        sheet_names.get(*s).map(|n| n.as_str()).unwrap_or("?"),
                        calcula_format::cell_ref::to_a1(*r, *c),
                        why
                    )
                })
                .collect();
            let more = offenders.len().saturating_sub(named.len());
            return Err(format!(
                "CALP_HOLDBACK_NOT_DERIVABLE: {}{} depend(s) on a change you unticked, and \
                 this workbook cannot recompute {} without the model, the workspace or the \
                 script host. Publishing would ship that cell's CURRENT value beside the \
                 published version's input — two numbers that were never true together, and \
                 nothing on a subscriber's machine recalculates to correct it. Either tick \
                 those changes so they publish too, or push everything and hold nothing back.",
                named.join(", "),
                if more > 0 { format!(" and {} more", more) } else { String::new() },
                if offenders.len() == 1 { "it" } else { "them" },
            ));
        }
    }

    // OWN THE TRANSACTION, so the id is CLAIMED rather than observed.
    //
    // Opened HERE, after every refusal above — a transaction left open by an
    // early return bleeds into the next edit the user makes.
    //
    // `apply_script_modified_grids` reaches the undo stack by two different
    // routes — an outer transaction when an off-sheet sheet was touched, or
    // `update_cells_batch` recording its own when only the active sheet moved —
    // and neither returns the id. Reading the top of the stack afterwards would
    // answer for both, and would be a SECOND critical section: an MCP tool
    // thread, or one of the async pivot/report commands, that records an entry
    // between the write and the read makes THAT entry the answer. The caller
    // would then scope its un-revert to a stranger's write and reverse it
    // confidently — strictly worse than the bare undo this replaces.
    //
    // Opening the transaction here closes the window: both inner routes join it
    // (`update_cells_batch` already checked for an open transaction, and
    // `apply_script_modified_grids_core` now does too), and the commit below is
    // what stamps the id and hands it back. Nothing can be adopted, because
    // nothing is observed.
    //
    // The pipeline's recalculation passes now run while this transaction is
    // open, which changes nothing: `calculation.rs` never touches the undo
    // stack.
    {
        let mut undo = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo.begin_transaction(format!(
            "Hold back {} change(s) for the push to {}",
            held, params.package_name
        ));
    }

    // Through the SAME pipeline a script write and a merge use: dependency maps,
    // recalculation, dirty flag, events. The recalculation is the point — a
    // rolled-back input whose dependents still showed the author's numbers is
    // exactly the artifact this exists to avoid.
    //
    // NOT `?`. The transaction is open, and a `?` here would leave it that way.
    let applied = crate::scripting::commands::apply_script_modified_grids(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &grids,
        active_sheet,
        held as u32,
        "calpHoldBack",
        &format!("{}@{}", params.package_name, base_version),
    );

    // ALWAYS close it, on both paths, and take the id the push stamps. An empty
    // transaction — the write touched nothing — commits nothing and yields
    // `None`, which is the honest answer: there is no entry for a caller to
    // reverse.
    let undo_seq = {
        let mut undo = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo.commit_transaction()
    };
    // Propagated AFTER the commit, so a partial write is on the stack and
    // recoverable rather than stranded inside an open transaction.
    applied?;

    Ok(HoldBackCellsResponse {
        cells_held_back: held,
        // `apply_script_modified_grids` returns early without recording anything
        // when `cells_modified == 0`, which `held > 0` excludes. The caller keys
        // its `undo` on this, so it must describe what actually happened rather
        // than what was asked for — and it is now `undo_seq.is_some()` rather
        // than `held > 0`, so the two facts the caller needs cannot disagree.
        undo_recorded: undo_seq.is_some(),
        undo_seq,
    })
}

// ===========================================================================
// Working-copy status — what is this workbook a working copy of?
// ===========================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyVersionInfo {
    pub version: String,
    pub published_at: String,
    pub published_by: String,
    pub base_version: String,
    pub change_summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedVersions {
    pub major: String,
    pub minor: String,
    pub patch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyStatus {
    pub registry_url: String,
    pub package_name: String,
    pub kind: String,
    /// The version this working copy is based on.
    pub base_version: String,
    pub checked_out_at: String,
    pub last_pushed_version: String,
    pub last_pushed_at: String,
    /// Sheets the base version carried — the push dialog's default selection,
    /// available even with the workspace unreachable.
    pub base_sheets: Vec<WorkingCopySheetInfo>,
    /// Whether the workspace answered at all. Everything below is meaningful
    /// only when this is true.
    pub registry_reachable: bool,
    /// The workspace's current head version (empty when unreachable).
    pub head_version: String,
    /// True when the head has moved past this working copy's base — i.e. a push
    /// would be refused by the base-version gate.
    pub is_stale: bool,
    /// Full published history, newest last (as the application manifest stores it).
    pub versions: Vec<WorkingCopyVersionInfo>,
    /// Next version suggestions from the head.
    pub suggested_next: Option<SuggestedVersions>,
    /// Whether THIS machine's publisher key is the one that signed the head —
    /// i.e. whether the key-continuity gate will pass.
    pub holds_publisher_key: bool,
    /// Why the workspace could not be read, when it could not be. Empty on
    /// success. Reported rather than thrown: a working copy must still open and
    /// describe itself with the share offline.
    pub registry_error: String,
    /// The application's environments and where each points, so the push dialog
    /// can say "test is at v1.3.0, prod at v1.2.0" the moment a push lands.
    pub environments: Vec<EnvironmentSummary>,
    /// Whether this computer may promote — root key or an authorised delegate.
    /// The SAME question `holds_publisher_key` above answers for pushing,
    /// because they are the same question: promotion rights are push rights.
    pub you_may_promote: bool,
    /// The environment, if any, whose pointer equals this working copy's BASE
    /// while the line's head has moved past it.
    ///
    /// The hotfix warning's input. A developer editing the version prod runs is
    /// usually trying to fix prod — and a push from here lands at the head of
    /// the line, carrying every unreleased change between. The line is linear;
    /// there is no branch to put a patch on. Saying so at the push is the
    /// honest answer, and it is the only place the developer is still present.
    pub base_is_promoted: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopySheetInfo {
    pub sheet_id: String,
    pub name: String,
}

/// What application is this workbook a working copy of, and where does it stand
/// relative to the workspace?
///
/// Read-only, and deliberately failure-tolerant: an unreachable workspace
/// downgrades the answer to the link's own contents rather than erroring. A
/// developer on a train must still be able to see which application they are
/// editing.
#[tauri::command]
pub fn calp_working_copy_status(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Option<WorkingCopyStatus>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let link = {
        let guard = state.working_copy_link.read().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(l) => l.clone(),
            None => return Ok(None),
        }
    };

    let mut status = WorkingCopyStatus {
        registry_url: link.registry_url.clone(),
        package_name: link.package_name.clone(),
        kind: link.kind.clone(),
        base_version: link.base_version.clone(),
        checked_out_at: link.checked_out_at.clone(),
        last_pushed_version: link.last_pushed_version.clone(),
        last_pushed_at: link.last_pushed_at.clone(),
        base_sheets: link
            .base_sheets
            .iter()
            .map(|s| WorkingCopySheetInfo {
                sheet_id: s.sheet_id.to_string(),
                name: s.name.clone(),
            })
            .collect(),
        registry_reachable: false,
        head_version: String::new(),
        is_stale: false,
        versions: Vec::new(),
        suggested_next: None,
        holds_publisher_key: false,
        registry_error: String::new(),
        environments: Vec::new(),
        you_may_promote: false,
        base_is_promoted: None,
    };

    let manifest = match crate::calp_registry::open_workspace_scoped(&link.registry_url)
        .map_err(|e| e.to_string())
        .and_then(|(registry, _)| {
            registry
                .get_application_manifest(&link.package_name)
                .map_err(|e| e.to_string())
                .map(|m| (registry, m))
        }) {
        Ok((registry, manifest)) => {
            status.registry_reachable = true;
            // Key continuity, answered before the user reaches the push button
            // rather than as a refusal after they have written a summary.
            if let Some(head) = calp::head_version(&manifest) {
                status.holds_publisher_key = calp::publish::resolve_authorized_keys(
                    &registry,
                    &link.package_name,
                    &head,
                )
                .map(|keys| {
                    keys.is_empty()
                        || keys.iter().any(|k| {
                            calp::signing::profile_holds_publisher_key(&calcula_profile_dir(), k)
                                .unwrap_or(false)
                        })
                })
                .unwrap_or(false);
                // PROMOTION RIGHTS ARE PUSH RIGHTS: the same authorised set,
                // asked once. The one difference is that an EMPTY set means
                // "nobody has established continuity" — which push reads as
                // "nothing to enforce" and promotion reads as a refusal,
                // because a promotion record nobody can verify is worse than
                // no pipeline.
                status.you_may_promote = calp::publish::resolve_authorized_keys(
                    &registry,
                    &link.package_name,
                    &head,
                )
                .map(|keys| {
                    keys.iter().any(|k| {
                        calp::signing::profile_holds_publisher_key(&calcula_profile_dir(), k)
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            }
            // The LISTING, not the signed fold: this runs on every dialog open
            // and only feeds a sentence ("test is at v1.3.0"). The Environments
            // section reads the verified log.
            status.environments = manifest
                .environments
                .iter()
                .map(|e| EnvironmentSummary { name: e.name.clone(), version: e.version.clone() })
                .collect();
            Some(manifest)
        }
        Err(e) => {
            status.registry_error = e;
            None
        }
    };

    if let Some(manifest) = manifest {
        status.versions = manifest
            .versions
            .iter()
            .map(|v| WorkingCopyVersionInfo {
                version: v.version.clone(),
                published_at: v.published_at.clone(),
                published_by: v.published_by.clone(),
                base_version: v.base_version.clone(),
                change_summary: v.change_summary.clone(),
            })
            .collect();
        if let Some(head) = calp::head_version(&manifest) {
            status.head_version = head.to_string();
            // Stale means "the head is not where this copy started". A copy
            // that has already pushed is measured from what it pushed.
            let anchor = if link.last_pushed_version.is_empty() {
                &link.base_version
            } else {
                &link.last_pushed_version
            };
            status.is_stale = head.to_string() != *anchor;
            // THE HOTFIX SHAPE. This working copy is based on the version an
            // environment currently runs, and the line has moved on — so the
            // developer is almost certainly patching what is live. The line is
            // linear: there is no branch to put v1.2.1 on, and a push from here
            // lands at the head carrying everything in between. Naming the
            // environment is what lets the push dialog say so.
            if status.is_stale && !link.base_version.is_empty() {
                status.base_is_promoted = status
                    .environments
                    .iter()
                    .find(|e| e.version.as_deref() == Some(link.base_version.as_str()))
                    .map(|e| e.name.clone());
            }
            status.suggested_next = Some(SuggestedVersions {
                major: SemVer::new(head.major + 1, 0, 0).to_string(),
                minor: SemVer::new(head.major, head.minor + 1, 0).to_string(),
                patch: SemVer::new(head.major, head.minor, head.patch + 1).to_string(),
            });
        }
    }

    Ok(Some(status))
}

/// Browse applications in a local workspace.
#[tauri::command]
pub fn calp_browse_workspace(
    registry_path: String,
    window: tauri::Window,
) -> Result<Vec<ApplicationInfo>, String> {
    // Also callable from the Application Inspector window (its workspace picker).
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_APPLICATION_INSPECTOR,
    )?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;

    let names = registry.list_applications().map_err(|e| e.to_string())?;
    let mut packages = Vec::new();

    for name in names {
        let manifest = registry.get_application_manifest(&name).map_err(|e| e.to_string())?;
        let mut versions = Vec::new();

        for entry in &manifest.versions {
            let sheets = registry.get_version_manifest(&name, &entry.version)
                .map(|vm| vm.sheets.iter().map(|s| SheetInfo {
                    name: s.name.clone(),
                    description: s.description.clone(),
                }).collect())
                .unwrap_or_default();

            versions.push(VersionInfo {
                version: entry.version.clone(),
                published_at: entry.published_at.clone(),
                published_by: entry.published_by.clone(),
                sheets,
            });
        }

        packages.push(ApplicationInfo {
            name: manifest.name,
            description: manifest.description,
            kind: manifest.kind,
            author: manifest.author,
            versions,
            environments: manifest
                .environments
                .iter()
                .map(|e| EnvironmentSummary { name: e.name.clone(), version: e.version.clone() })
                .collect(),
        });
    }

    Ok(packages)
}

/// What an application version contains, surfaced BEFORE pulling so the user can
/// review (and explicitly accept) incoming scripts, data sources, and
/// writeback regions instead of having them materialized silently.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationInspection {
    pub package_name: String,
    pub resolved_version: String,
    pub sheets: Vec<SheetInfo>,
    pub scripts: Vec<InspectedScript>,
    /// Standalone module scripts bundled with the application (C8). Surfaced in the
    /// pre-pull review for transparency — they are inert (never auto-executed).
    pub module_scripts: Vec<InspectedModuleScript>,
    /// Standalone notebooks bundled with the application (C8). Surfaced in the
    /// pre-pull review for transparency — inert until the user runs them.
    pub notebooks: Vec<InspectedNotebook>,
    pub data_sources: Vec<InspectedDataSource>,
    pub writeback_region_count: usize,
    pub table_count: usize,
    pub named_range_count: usize,
    /// Per-object transparency for the pre-pull review: names of the tables
    /// and named ranges the application carries (counts alone hide what arrives).
    pub table_names: Vec<String>,
    pub named_range_names: Vec<String>,
    pub chart_count: usize,
    pub sparkline_count: usize,
    pub pivot_count: usize,
    /// Sheets carrying cell-anchored controls (buttons/checkboxes).
    pub control_sheet_count: usize,
    /// Pane controls (Controls pane widgets) the application carries —
    /// workbook-scoped, materialized into the subscriber's Controls pane.
    pub pane_control_count: usize,
    /// Their display names (per-object transparency, like table_names).
    pub pane_control_names: Vec<String>,
    /// Slicers on the published sheets (Wave A).
    pub slicer_count: usize,
    /// Ribbon filters the application carries (workbook-scoped, BI-only; Wave A).
    pub ribbon_filter_count: usize,
    /// Saved pivot layouts the application carries (Wave A).
    pub pivot_layout_count: usize,
    /// Whether the application carries a document theme (always true for applications
    /// published after Wave A; applied only if the subscriber's theme is
    /// still the default).
    pub has_document_theme: bool,
    /// Extension-data keys the application carries (Wave A; merged additively —
    /// keys the subscriber already has are never overwritten).
    pub extension_data_count: usize,
    /// Their key names (per-object transparency, like named_range_names), so
    /// subscribing to extension state is informed, not a blind count.
    pub extension_data_keys: Vec<String>,
    /// Sheets carrying threaded comments (Wave B). Non-zero only when the
    /// publisher explicitly opted in via "Include comments" at publish —
    /// surfaced pre-pull so subscribing to shared discussion is informed.
    pub comment_sheet_count: usize,
    /// S5 phase 2: the verified publisher's display name. Inspect is a pre-pull
    /// trust surface, so the manifest signature is checked here too.
    pub publisher_name: String,
    /// S5 phase 2: the verified publisher's Ed25519 public key (hex). Surfaced
    /// because inspect is PASSIVE — it deliberately does NOT pin — so the key is
    /// the only thing the reviewer can actually compare against what the
    /// publisher told them out of band. A name is not an identity.
    pub publisher_key: String,
    /// A `CalpTrustStatus` for THIS workspace. Inspect is PASSIVE, so first
    /// contact is `notPinned` — or `notPinnedNameConflict` when another workspace
    /// already holds this application name under a DIFFERENT key. If verification
    /// fails, inspect returns an Err instead.
    pub trust_status: String,
    /// Pins held for this same application name in OTHER workspaces. The Review step
    /// shows them, because Review must never say nothing and then have Subscribe
    /// fail on a conflict it never mentioned.
    pub other_scope_pins: Vec<crate::calp_inspector::OtherScopePinInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedScript {
    pub name: String,
    pub object_type: String,
    pub description: Option<String>,
    /// The capability ids the application's manifest declares this script needs
    /// (R19 ceiling). Surfaced BEFORE pulling so the user sees what the
    /// application's scripts want before accepting.
    pub requested_capabilities: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedModuleScript {
    /// Stable module-script id (`PublishedModuleScript::id`).
    ///
    /// Carried because the pre-pull review has to recognise the RESERVED
    /// `__calcula_custom_functions__` library — whose functions run on every
    /// recalculation of any cell that calls them — and a human-chosen display
    /// name is not a safe handle for that: a publisher can name any module
    /// "Custom Functions (data)", and the real library can be renamed. The id
    /// is assigned by Calcula, not by the publisher.
    pub id: String,
    pub name: String,
    /// "workbook" or a sheet name.
    pub scope: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedNotebook {
    pub name: String,
    pub cell_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedDataSource {
    pub name: String,
    pub connection_type: String,
    pub server: String,
    pub database: String,
}

/// Inspect an application version's contents without materializing anything.
#[tauri::command]
pub fn calp_inspect_application(
    registry_path: String,
    package_name: String,
    version_pin: String,
    environment: Option<String>,
    window: tauri::Window,
) -> Result<ApplicationInspection, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;

    // A SEPARATE PARAMETER, never a prefix inside the pin string.
    //
    // Encoding it as `env:prod` inside the pin would recreate exactly the shape
    // this work deleted: a magic prefix every parser has to special-case, and
    // eleven that did while nothing ever produced one. `VersionPin::parse` now
    // REFUSES such a prefix by name, so a frontend string cannot reintroduce it.
    let has_pin = !version_pin.trim().is_empty();
    let target = match (&environment, has_pin) {
        (Some(env), true) => {
            return Err(format!(
                "CALP_INSPECT_TARGET_AMBIGUOUS: this asks for both an environment ('{}') and                  a version pin ('{}'). Pick one.",
                env,
                version_pin.trim()
            ));
        }
        (Some(env), false) => calp::manifest::SubscriptionTarget::Environment(env.clone()),
        (None, _) => calp::manifest::SubscriptionTarget::Line(
            VersionPin::parse(&version_pin).map_err(|e| e.to_string())?,
        ),
    };
    let resolved = calp::environments::resolve_target(registry.as_ref(), &package_name, &target)
        .map_err(|e| e.to_string())?;
    let version = resolved.to_string();

    // S5 phase 2: read the manifest bytes ONCE, verify the Ed25519 signature +
    // TOFU pin over exactly those bytes, and parse the contents from them BEFORE
    // surfacing anything — inspect is a pre-pull trust surface, so an
    // unsigned/tampered/hijacked application must fail to inspect, not just to pull.
    // Transport-agnostic (reads manifest + .sig via the transport) so an HTTP
    // workspace is verified exactly like a local one — no local dir required, and
    // no split-view between the signed bytes and the surfaced inventory.
    //
    // PASSIVE -- VerifyOnly. This is the "Review" button in SubscribeDialog, the
    // step whose entire purpose is "nothing is materialized until the user
    // explicitly accepts", and it is additionally script-reachable through
    // `distribution_gateway::Action::InspectPackage`. Neither reviewing an
    // application nor a script asking about one is a decision to trust its
    // publisher, so first contact reports `notPinned` and writes nothing to the
    // pin store. The publisher name and key are still returned in full -- that
    // is what the user is being asked to judge.
    let calp::integrity::VerifiedManifest {
        trust,
        manifest,
        other_scope_pins,
    } = calp::integrity::verify_and_load_manifest_via(
        registry.as_ref(),
        &package_name,
        &version,
        &scope,
        &calcula_profile_dir(),
        calp::integrity::PinPolicy::VerifyOnly,
    )
    .map_err(|e| e.to_string())?;
    let trust_status = calp_trust_status_str(trust);
    let other_scope_pins = crate::calp_inspector::other_scope_pins_wire(&other_scope_pins);

    // Per-object detail read from the (integrity-checked) artifacts — computed
    // BEFORE the response literal because the literal moves package_name/version.
    let table_names: Vec<String> = {
        let mut names = Vec::new();
        for table_id in &manifest.tables {
            if let Ok(Some(bytes)) = registry.read_artifact(
                &package_name,
                &version,
                &format!("tables/{}.json", table_id),
            ) {
                if let Ok(table) = serde_json::from_slice::<persistence::SavedTable>(&bytes) {
                    names.push(table.name);
                }
            }
        }
        names
    };
    let chart_count = match registry.read_artifact(&package_name, &version, "charts.json") {
        Ok(Some(bytes)) => serde_json::from_slice::<Vec<persistence::SavedChart>>(&bytes)
            .map(|v| v.len())
            .unwrap_or(0),
        _ => 0,
    };
    let sparkline_count = match registry.read_artifact(&package_name, &version, "sparklines.json") {
        Ok(Some(bytes)) => serde_json::from_slice::<Vec<persistence::SavedSparkline>>(&bytes)
            .map(|v| v.len())
            .unwrap_or(0),
        _ => 0,
    };
    // Pivot artifacts are enumerated from the SIGNED manifest's checksum keys —
    // a transport dir-walk lists nothing once publish commits artifacts into
    // the content-addressed blob store.
    let pivot_count = manifest
        .artifact_checksums
        .keys()
        .filter(|p| {
            p.starts_with("pivot_definitions/")
                && p.ends_with(".json")
                && p.as_str() != "pivot_definitions/bi_metadata.json"
        })
        .count();
    let control_sheet_count =
        match registry.read_artifact(&package_name, &version, "controls.json") {
            Ok(Some(bytes)) => {
                serde_json::from_slice::<Vec<persistence::SavedSheetControls>>(&bytes)
                    .map(|v| v.len())
                    .unwrap_or(0)
            }
            _ => 0,
        };
    // Pane controls (workbook-scoped): count AND names, so the subscriber
    // reviews what will land in their Controls pane instead of accepting blind.
    let pane_control_names: Vec<String> =
        match registry.read_artifact(&package_name, &version, "pane_controls.json") {
            Ok(Some(bytes)) => serde_json::from_slice::<Vec<persistence::SavedPaneControl>>(&bytes)
                .map(|v| v.into_iter().map(|c| c.name).collect())
                .unwrap_or_default(),
            _ => Vec::new(),
        };
    // Wave A counts (slicers / ribbon filters / pivot layouts / theme /
    // extension data), read from their optional artifacts like charts.
    let slicer_count = match registry.read_artifact(&package_name, &version, "slicers.json") {
        Ok(Some(bytes)) => serde_json::from_slice::<Vec<persistence::SavedSlicer>>(&bytes)
            .map(|v| v.len())
            .unwrap_or(0),
        _ => 0,
    };
    let ribbon_filter_count =
        match registry.read_artifact(&package_name, &version, "ribbon_filters.json") {
            Ok(Some(bytes)) => {
                serde_json::from_slice::<Vec<persistence::SavedRibbonFilter>>(&bytes)
                    .map(|v| v.len())
                    .unwrap_or(0)
            }
            _ => 0,
        };
    let pivot_layout_count =
        match registry.read_artifact(&package_name, &version, "pivot_layouts.json") {
            Ok(Some(bytes)) => {
                serde_json::from_slice::<Vec<persistence::SavedPivotLayout>>(&bytes)
                    .map(|v| v.len())
                    .unwrap_or(0)
            }
            _ => 0,
        };
    let has_document_theme = matches!(
        registry.read_artifact(&package_name, &version, "theme.json"),
        Ok(Some(_))
    );
    // Extension data: surface the KEY NAMES, not just a count (the artifact
    // is written from a BTreeMap, so the keys come back in stable order).
    let extension_data_keys: Vec<String> =
        match registry.read_artifact(&package_name, &version, "extension_data.json") {
            Ok(Some(bytes)) => serde_json::from_slice::<
                std::collections::BTreeMap<String, serde_json::Value>,
            >(&bytes)
            .map(|m| m.into_keys().collect())
            .unwrap_or_default(),
            _ => Vec::new(),
        };
    // Comments (Wave B) travel only when the publisher opted in; count the
    // sheets carrying them so the pre-pull review can disclose the discussion.
    let comment_sheet_count =
        match registry.read_artifact(&package_name, &version, "comments.json") {
            Ok(Some(bytes)) => {
                serde_json::from_slice::<Vec<persistence::SavedSheetComments>>(&bytes)
                    .map(|v| v.len())
                    .unwrap_or(0)
            }
            _ => 0,
        };

    Ok(ApplicationInspection {
        package_name,
        resolved_version: version,
        publisher_name: manifest.publisher_name.clone(),
        publisher_key: manifest.publisher_key.clone(),
        trust_status,
        other_scope_pins,
        sheets: manifest.sheets.iter().map(|s| SheetInfo {
            name: s.name.clone(),
            description: s.description.clone(),
        }).collect(),
        scripts: manifest.object_scripts.iter().map(|s| InspectedScript {
            name: s.name.clone(),
            object_type: s.object_type.clone(),
            description: s.description.clone(),
            requested_capabilities: s.capabilities.clone(),
        }).collect(),
        module_scripts: manifest.module_scripts.iter().map(|m| InspectedModuleScript {
            id: m.id.clone(),
            name: m.name.clone(),
            scope: m.scope.clone(),
            description: m.description.clone(),
        }).collect(),
        notebooks: manifest.notebooks.iter().map(|n| InspectedNotebook {
            name: n.name.clone(),
            cell_count: n.cell_count,
        }).collect(),
        data_sources: manifest.data_sources.iter().map(|ds| InspectedDataSource {
            name: ds.name.clone(),
            connection_type: ds.connection_type.clone(),
            server: ds.server.clone(),
            database: ds.database.clone(),
        }).collect(),
        writeback_region_count: manifest
            .writeback_regions
            .as_ref()
            .map(|r| r.len())
            .unwrap_or(0),
        table_count: manifest.tables.len(),
        named_range_count: manifest.named_ranges.len(),
        table_names,
        named_range_names: manifest.named_ranges.iter().map(|nr| nr.name.clone()).collect(),
        chart_count,
        sparkline_count,
        pivot_count,
        control_sheet_count,
        pane_control_count: pane_control_names.len(),
        pane_control_names,
        slicer_count,
        ribbon_filter_count,
        pivot_layout_count,
        has_document_theme,
        extension_data_count: extension_data_keys.len(),
        extension_data_keys,
        comment_sheet_count,
    })
}

/// Get subscription metadata for the current workbook.
#[tauri::command]
pub fn calp_get_subscriptions(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<SubscriptionManifest, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    Ok(subs.clone())
}

/// Per-subscription answer to "does this machine trust this application's
/// publisher?" — the visible half of the Wave J fail-closed change.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionTrustInfo {
    pub package_name: String,
    pub registry_url: String,
    pub resolved_version: String,
    /// The environment this follows, or None for the development line.
    pub environment: Option<String>,
    /// Every environment the application now offers, in pipeline order.
    ///
    /// What lets the Subscriptions pane offer a switch, and what lets it tell a
    /// LINE subscription that a pipeline has appeared since it was made. Read
    /// here because this command already opens each workspace — a separate
    /// command would open them all a second time.
    pub available_environments: Vec<String>,
    /// "verified"  — signed by the key this machine pinned when the user subscribed.
    /// "firstUse"   — pinned by this very operation (never produced here; this
    ///                command is VerifyOnly. Present so the wire vocabulary is
    ///                the same everywhere).
    /// "notPinned"  — the signature is valid but nobody here ever agreed to
    ///                trust this publisher for this name. Writeback regions,
    ///                GATHER and model-writeback columns from this application are
    ///                INERT until the user subscribes.
    /// "unavailable"— the workspace or the manifest could not be read/verified;
    ///                `error` says why.
    pub trust_status: String,
    /// Publisher display name from the (verified) manifest; empty on error.
    pub publisher_name: String,
    /// Publisher Ed25519 public key (hex) from the manifest; empty on error.
    pub publisher_key: String,
    /// Whether this application declares writeback regions or model-writeback
    /// columns — i.e. whether "not pinned" actually costs the user something.
    pub declares_writeback: bool,
    /// Pins held for this same application name in OTHER workspaces. A different key
    /// pinned elsewhere is what turns `notPinned` into `notPinnedNameConflict`.
    pub other_scope_pins: Vec<crate::calp_inspector::OtherScopePinInfo>,
    /// Human-readable failure text when `trustStatus` is "unavailable".
    pub error: String,
}

/// Report, per subscription, whether this machine has ever agreed to trust the
/// application's publisher.
///
/// WHY THIS EXISTS. A `.cala` restores its subscription list on open WITHOUT
/// pulling. Before Wave J, workbook open (`rebuild_writeback_index`) and every
/// recalculation (`build_gather_data`) would create a TOFU pin for whatever
/// application/workspace pair the FILE named — so a workbook that arrived by email
/// could squat the identity of an application the recipient had never heard of.
/// Those paths are now `RequirePinned` and simply skip an unpinned application.
///
/// That is the correct fail-closed behaviour, but on its own it is invisible:
/// the writeback regions would just sit there inert. This command makes the
/// state legible, so the Subscriptions pane can say "subscribe to activate"
/// instead of the user staring at a report that silently does nothing.
///
/// PASSIVE — `PinPolicy::VerifyOnly`. Reporting on trust must never create it.
#[tauri::command]
/// READ-ONLY (census had this as mutates-document, "verify"): it reads the subscription
/// list and the TOFU pin files and reports; it writes no state, so it must not dirty.
pub fn calp_subscription_trust(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<SubscriptionTrustInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let profile_dir = calcula_profile_dir();
    let mut out = Vec::with_capacity(subs.subscriptions.len());

    for sub in &subs.subscriptions {
        // A dev subscription points at a local .cala file: no workspace
        // manifest to verify, and it is excluded from every other trust path
        // too. An ENVIRONMENT subscription is NOT exempt — it has a workspace
        // and a signed manifest like any other.
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }
        let registry_path = subscription_registry_path(sub).to_string();
        let mut info = SubscriptionTrustInfo {
            package_name: sub.package_name.clone(),
            registry_url: sub.registry_url.clone(),
            resolved_version: sub.resolved_version.clone(),
            environment: sub.environment.clone(),
            available_environments: Vec::new(),
            trust_status: "unavailable".to_string(),
            publisher_name: String::new(),
            publisher_key: String::new(),
            declares_writeback: false,
            other_scope_pins: Vec::new(),
            error: String::new(),
        };

        match crate::calp_registry::open_workspace_scoped(&registry_path) {
            Ok((registry, scope)) => {
            // What this application now OFFERS, so the pane can propose a switch
            // — and can tell a line-following subscription that a pipeline has
            // appeared since it was made. Best-effort: an unverifiable log must
            // not cost the trust answer beside it.
            info.available_environments =
                calp::environments::environments(registry.as_ref(), &sub.package_name)
                    .map(|envs| envs.into_iter().map(|e| e.name).collect())
                    .unwrap_or_default();
            match calp::integrity::verify_and_load_manifest_via(
                registry.as_ref(),
                &sub.package_name,
                &sub.resolved_version,
                &scope,
                &profile_dir,
                calp::integrity::PinPolicy::VerifyOnly,
            ) {
                Ok(verified) => {
                    let manifest = &verified.manifest;
                    info.trust_status = calp_trust_status_str(verified.trust);
                    info.other_scope_pins =
                        crate::calp_inspector::other_scope_pins_wire(&verified.other_scope_pins);
                    info.publisher_name = manifest.publisher_name.clone();
                    info.publisher_key = manifest.publisher_key.clone();
                    info.declares_writeback = manifest
                        .writeback_regions
                        .as_ref()
                        .map(|r| !r.is_empty())
                        .unwrap_or(false)
                        || manifest
                            .model_writebacks
                            .as_ref()
                            .map(|m| !m.is_empty())
                            .unwrap_or(false);
                }
                Err(e) => info.error = e.to_string(),
            }
            }
            Err(e) => info.error = e.to_string(),
        }

        out.push(info);
    }

    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationObjectInfo {
    pub kind: String,
    pub id: String,
    pub name: String,
    /// Whether the object still exists in the live workbook (a subscriber may
    /// have deleted it since the pull).
    pub present: bool,
    /// The sheet the object lives on, when resolvable.
    pub sheet_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSheetObjectInfo {
    pub local_name: String,
    pub local_sheet_index: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationObjectsResponse {
    pub package_name: String,
    pub resolved_version: String,
    pub registry_url: String,
    pub sheets: Vec<ApplicationSheetObjectInfo>,
    pub objects: Vec<ApplicationObjectInfo>,
}

/// Resolve one subscription's provenance ledger against the live workbook:
/// which sheets and objects are connected to this application, and whether each
/// still exists. Backs the Application Explorer pane.
#[tauri::command]
pub fn calp_get_application_objects(
    state: State<AppState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    bi_state: State<BiState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<crate::slicer::SlicerState>,
    package_name: String,
    window: tauri::Window,
) -> Result<ApplicationObjectsResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let Some(sub) = subs
        .subscriptions
        .iter()
        .find(|s| s.package_name == package_name)
    else {
        return Err(format!("No subscription named '{}'", package_name));
    };

    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;

    let sheets: Vec<ApplicationSheetObjectInfo> = sub
        .sheets
        .iter()
        .map(|s| {
            let idx = sheet_ids.iter().position(|id| *id == s.local_sheet_id);
            ApplicationSheetObjectInfo {
                local_name: idx
                    .and_then(|i| sheet_names.get(i).cloned())
                    .unwrap_or_else(|| s.local_name.clone()),
                local_sheet_index: idx,
            }
        })
        .collect();

    // Wave A presence snapshots, each under its own SHORT lock released
    // before the next is taken (and before the AppState/pane locks below) —
    // no cross-family lock nesting, so no ordering constraint is engaged.
    let slicer_sheets: std::collections::HashMap<String, usize> = slicer_state
        .slicers
        .read()
        .map_err(|e| e.to_string())?
        .values()
        .map(|s| (s.id.to_string(), s.sheet_index))
        .collect();
    let ribbon_filter_ids: std::collections::HashSet<String> = ribbon_filter_state
        .filters
        .read()
        .map_err(|e| e.to_string())?
        .keys()
        .map(|id| id.to_string())
        .collect();
    let pivot_layout_ids: std::collections::HashSet<String> = state
        .pivot_layouts
        .read()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|l| l.id.to_string())
        .collect();
    // extensionData ledger entries use the extension-data map key as their id;
    // "present" = the key still exists in the live workbook's extension state.
    let extension_data_keys: std::collections::HashSet<String> = state
        .extension_data
        .read()
        .map_err(|e| e.to_string())?
        .keys()
        .cloned()
        .collect();

    let tables = state.tables.read().map_err(|e| e.to_string())?;
    let charts = state.charts.read().map_err(|e| e.to_string())?;
    let named_ranges = state.named_ranges.read().map_err(|e| e.to_string())?;
    let object_scripts = state.object_scripts.read().map_err(|e| e.to_string())?;
    let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
    let workbook_scripts = script_state.workbook_scripts.read().map_err(|e| e.to_string())?;
    let workbook_notebooks = script_state
        .workbook_notebooks
        .read()
        .map_err(|e| e.to_string())?;
    let connections = bi_state.connections.lock().map_err(|e| e.to_string())?;
    // Pane-control lock: safe alongside the AppState locks above (the
    // pane_control/types.rs order constraint only forbids holding it while
    // acquiring the grid locks, which this command never touches).
    let pane_controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;

    let sheet_name_at =
        |idx: usize| -> String { sheet_names.get(idx).cloned().unwrap_or_default() };

    let objects: Vec<ApplicationObjectInfo> = sub
        .objects
        .iter()
        .map(|o| {
            let (present, sheet_name) = match o.kind.as_str() {
                "table" => tables
                    .iter()
                    .find(|(_, m)| m.keys().any(|id| id.to_string() == o.id))
                    .map(|(idx, _)| (true, sheet_name_at(*idx)))
                    .unwrap_or((false, String::new())),
                "chart" => charts
                    .iter()
                    .find(|c| c.id.to_string() == o.id)
                    .map(|c| (true, sheet_name_at(c.sheet_index)))
                    .unwrap_or((false, String::new())),
                "namedRange" => (named_ranges.contains_key(&o.id), String::new()),
                "objectScript" => (
                    object_scripts.iter().any(|s| s.id == o.id),
                    String::new(),
                ),
                "moduleScript" => (workbook_scripts.contains_key(&o.id), String::new()),
                "notebook" => (workbook_notebooks.contains_key(&o.id), String::new()),
                "pivot" => (
                    pivot_tables.keys().any(|k| k.to_string() == o.id),
                    String::new(),
                ),
                "dataSource" => (
                    connections
                        .values()
                        .any(|c| c.package_data_source_id.as_deref() == Some(o.id.as_str())),
                    String::new(),
                ),
                // Pane controls are workbook-scoped (no sheet), like pivots.
                "paneControl" => (
                    pane_controls.keys().any(|k| k.to_string() == o.id),
                    String::new(),
                ),
                // Wave A kinds: slicers resolve their sheet like charts;
                // ribbon filters + pivot layouts are workbook-scoped.
                "slicer" => slicer_sheets
                    .get(&o.id)
                    .map(|&idx| (true, sheet_name_at(idx)))
                    .unwrap_or((false, String::new())),
                "ribbonFilter" => (ribbon_filter_ids.contains(&o.id), String::new()),
                "pivotLayout" => (pivot_layout_ids.contains(&o.id), String::new()),
                "extensionData" => (extension_data_keys.contains(&o.id), String::new()),
                "controlSheet" => sheet_ids
                    .iter()
                    .position(|id| id.to_string() == o.id)
                    .map(|idx| (true, sheet_name_at(idx)))
                    .unwrap_or((false, String::new())),
                _ => (false, String::new()),
            };
            ApplicationObjectInfo {
                kind: o.kind.clone(),
                id: o.id.clone(),
                name: o.name.clone(),
                present,
                sheet_name,
            }
        })
        .collect();

    Ok(ApplicationObjectsResponse {
        package_name: sub.package_name.clone(),
        resolved_version: sub.resolved_version.clone(),
        registry_url: sub.registry_url.clone(),
        sheets,
        objects,
    })
}

/// Return the entire override layer for the current workbook.
#[tauri::command]
pub fn calp_get_overrides(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::OverrideLayer, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let layer = state.override_layer.read().map_err(|e| e.to_string())?;
    Ok(layer.clone())
}

/// Materialize an OverrideValue into a grid cell, preserving the cell's style.
/// Formula cells get their AST set with an Empty value — the caller is
/// responsible for triggering a recalculation pass afterwards.
///
/// `spellings` carries the workbook's THREE naming authorities, and it is not
/// optional: an override stores its formula as TEXT and re-parsing it here runs
/// the same lexer that upper-cases every bare identifier, so `=BudgetTotal*2`
/// landed in the grid as `=BUDGETTOTAL*2` (§2t on the overlay path),
/// `=SUM(Sales[Amount])` as `=SUM(SALES[AMOUNT])` (§2aj's casing half) and
/// `=Data!A1` as `=DATA!A1` (§2ai). The restamps are the same three entry and
/// `open_file` use, applied to the one AST this writes rather than to the whole
/// workbook.
fn write_override_value(
    grid: &mut engine::Grid,
    row: u32,
    col: u32,
    value: &calp::OverrideValue,
    spellings: &WorkbookSpellings<'_>,
) {
    let style_index = grid.get_cell(row, col).map(|c| c.style_index).unwrap_or(0);
    match value {
        calp::OverrideValue::Empty => {
            grid.clear_cell(row, col);
        }
        calp::OverrideValue::Value { display } => {
            let cell_value = if display.is_empty() {
                engine::CellValue::Empty
            } else if let Ok(n) = display.parse::<f64>() {
                engine::CellValue::Number(n)
            } else if display == "TRUE" {
                engine::CellValue::Boolean(true)
            } else if display == "FALSE" {
                engine::CellValue::Boolean(false)
            } else {
                engine::CellValue::Text(display.clone())
            };
            grid.set_cell(row, col, engine::Cell {
                ast: None,
                value: cell_value,
                style_index,
                rich_text: None,
            });
        }
        calp::OverrideValue::Formula { formula } => {
            match parser::parse(formula) {
                Ok(mut ast) => {
                    spellings.restamp(&mut ast);
                    grid.set_cell(row, col, engine::Cell {
                        ast: Some(Box::new(ast)),
                        value: engine::CellValue::Empty,
                        style_index,
                        rich_text: None,
                    });
                }
                Err(_) => {
                    // Version skew can make a stored formula unparseable
                    // here. Keep the text visible instead of silently
                    // blanking the cell (the override layer still holds it).
                    crate::log_warn!("CALP", "Override formula failed to parse at ({},{}): ={}", row, col, formula);
                    grid.set_cell(row, col, engine::Cell {
                        ast: None,
                        value: engine::CellValue::Text(format!("={}", formula)),
                        style_index,
                        rich_text: None,
                    });
                }
            }
        }
    }
}

/// The three authorities a re-parsed formula has to be re-spelled from, held
/// together so a caller cannot take two of them and forget the third.
///
/// Borrowed rather than cloned: the caller already holds the guards, and the
/// lock order they were taken in (named_ranges -> tables -> table_names ->
/// sheet_names -> grid -> grids) is the one `restamp_workbook_name_casing`
/// established.
struct WorkbookSpellings<'a> {
    named_ranges: &'a std::collections::HashMap<String, crate::named_ranges::NamedRange>,
    tables: &'a crate::tables::TableStorage,
    table_names: &'a crate::tables::TableNameRegistry,
    sheet_names: &'a [String],
}

impl WorkbookSpellings<'_> {
    fn restamp(&self, ast: &mut engine::Expression) {
        crate::name_resolution::restamp_name_casing(ast, self.named_ranges);
        crate::table_deps::restamp_table_casing(ast, self.tables, self.table_names);
        crate::sheet_names::restamp_sheet_casing(ast, self.sheet_names);
    }
}

/// Resolve a sheet id to its current workbook index.
fn sheet_index_for_id(state: &AppState, sheet_id: SheetId) -> Option<usize> {
    state.sheet_ids.read().ok()?.iter().position(|id| *id == sheet_id)
}

/// Write an OverrideValue into the workbook grids at the cell's current
/// position. Returns true if a cell was written.
fn apply_override_value_to_grid(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    sheet_id: SheetId,
    cell_id: CellId,
    fallback_position: (u32, u32),
    value: &calp::OverrideValue,
) -> bool {
    let position = state
        .id_registry
        .lock()
        .ok()
        .and_then(|reg| reg.cell_position(sheet_id, cell_id))
        .unwrap_or(fallback_position);

    let sheet_index = {
        let sheet_ids = match state.sheet_ids.read() {
            Ok(s) => s,
            Err(_) => return false,
        };
        match sheet_ids.iter().position(|id| *id == sheet_id) {
            Some(i) => i,
            None => return false,
        }
    };

    // NAMING AUTHORITIES BEFORE THE GRIDS, the lock order
    // `restamp_workbook_name_casing` already established.
    // CANONICAL LOCK ORDER: both grid locks FIRST, then everything else.
    // This function writes an override value into a sheet and then mirrors it
    // into the active grid, so it takes BOTH -- and it used to take them after
    // four name stores, which is the inverted order: the recalculation pass
    // holds the grid locks and then takes `named_ranges` / `tables` /
    // `table_names` / `sheet_names` on a background thread. The mirror is taken
    // unconditionally rather than inside the `active == sheet_index` branch,
    // which costs a slightly wider critical section and buys the one order.
    let mut active_grid = match state.grid.write(effect) {
        Ok(g) => g,
        Err(_) => return false,
    };
    let mut grids = match state.grids.write(effect) {
        Ok(g) => g,
        Err(_) => return false,
    };
    // `sheet_names` BEFORE the other three, because the pass takes it before
    // them too (BUG-0045): it holds `sheet_names` and then waits for `tables`,
    // so a caller holding `tables` and waiting for `sheet_names` hangs the app.
    let sheet_names = match state.sheet_names.read() {
        Ok(s) => s.clone(),
        Err(_) => return false,
    };
    let tables = match state.tables.read() {
        Ok(t) => t,
        Err(_) => return false,
    };
    let table_names = match state.table_names.read() {
        Ok(t) => t,
        Err(_) => return false,
    };
    let named_ranges = match state.named_ranges.read() {
        Ok(n) => n,
        Err(_) => return false,
    };
    let spellings = WorkbookSpellings {
        named_ranges: &named_ranges,
        tables: &tables,
        table_names: &table_names,
        sheet_names: &sheet_names,
    };

    // Both grid guards were acquired at the top -- see the lock-order note there.
    match grids.get_mut(sheet_index) {
        Some(grid) => {
            write_override_value(grid, position.0, position.1, value, &spellings)
        }
        None => return false,
    }

    // Keep the active-sheet mirror in sync.
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(usize::MAX);
    if active == sheet_index {
        write_override_value(&mut active_grid, position.0, position.1, value, &spellings);
    }
    drop(spellings);
    drop(sheet_names);
    drop(table_names);
    drop(tables);
    drop(named_ranges);
    // BOTH GRID GUARDS GO HERE, and this is a requirement rather than tidiness.
    // They are function-scoped because the canonical lock order needs them taken
    // before the four name stores above; the block below re-reads `grids`, and
    // `Persisted<T>` is a `std::sync::Mutex`, which is NOT re-entrant. Holding
    // them across it does not fail, it blocks the calling thread forever.
    drop(grids);
    drop(active_grid);

    // SPILL CLAIMS ON THE WRITTEN SHEET (§2y). An override lands a VALUE on a
    // cell chosen by id, which can be the ORIGIN of a dynamic array — and
    // `recalculate_sheet_values` (spill-aware since §3bm) only visits cells
    // that still hold a FORMULA, so an origin the override overwrote is never
    // reached and nothing else would notice the formula had gone. The claim is dropped; the cells
    // are left, because the override layer is authoritative about content (see
    // `release_spills_orphaned_by_grid`).
    if let Ok(grids) = state.grids.read() {
        if let Some(grid) = grids.get(sheet_index) {
            crate::commands::data::release_spills_orphaned_by_grid(state, sheet_index, grid);
        }
    }

    true
}

/// Revert a single override, restoring the upstream (baseline) value for
/// that cell in the grid.
#[tauri::command]
pub fn calp_revert_override(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    sheet_id: String,
    cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let cid = CellId::parse(&cell_id)
        .ok_or_else(|| format!("Invalid cell_id: {}", cell_id))?;

    // Hoisted out of the block below so the grid write that follows the block can
    // present the SAME decision. One `mutates`, one dirty transition.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let restore = {
        let mut layer = state.override_layer.write(&effect).map_err(|e| e.to_string())?;
        let restore = layer
            .get(sid, cid)
            .map(|ovr| (ovr.baseline.clone(), ovr.position));
        if restore.is_some() {
            layer.remove_override(sid, cid);
        }
        restore
    };

    match restore {
        Some((baseline, position)) => {
            apply_override_value_to_grid(&state, &effect, sid, cid, position, &baseline);
            // Re-evaluate the sheet so restored formulas (written Empty,
            // pending recalc) and dependents of the restored value display
            // correctly even when the sheet is not active — the frontend's
            // calculateNow only covers the active one.
            if let Some(idx) = sheet_index_for_id(&state, sid) {
                crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx, Some((&*pane_control_state, &*ribbon_filter_state)));
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Accept the upstream value for a conflicted cell: discards the override and
/// writes the new upstream value into the grid.
#[tauri::command]
pub fn calp_accept_upstream(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    sheet_id: String,
    cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let cid = CellId::parse(&cell_id)
        .ok_or_else(|| format!("Invalid cell_id: {}", cell_id))?;

    // Hoisted out of the block below so the grid write that follows it can present
    // the SAME decision. One `mutates`, one dirty transition.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let restore = {
        let mut layer = state.override_layer.write(&effect).map_err(|e| e.to_string())?;
        let restore = layer.get(sid, cid).map(|ovr| {
            // For a conflicted override the value to accept is the new
            // upstream; otherwise the baseline is the upstream value.
            let value = ovr.upstream_new.clone().unwrap_or_else(|| ovr.baseline.clone());
            (value, ovr.position)
        });
        if restore.is_some() {
            layer.accept_upstream(sid, cid);
        }
        restore
    };

    match restore {
        Some((upstream, position)) => {
            apply_override_value_to_grid(&state, &effect, sid, cid, position, &upstream);
            if let Some(idx) = sheet_index_for_id(&state, sid) {
                crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx, Some((&*pane_control_state, &*ribbon_filter_state)));
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Keep the consumer's override for a conflicted cell (rebases onto new upstream baseline).
#[tauri::command]
pub fn calp_keep_override(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    sheet_id: String,
    cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let cid = CellId::parse(&cell_id)
        .ok_or_else(|| format!("Invalid cell_id: {}", cell_id))?;
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut layer = state.override_layer.write(&effect).map_err(|e| e.to_string())?;
    Ok(layer.keep_override(sid, cid))
}

/// Export the current override layer as a portable OverridePatch for the given application.
#[tauri::command]
pub fn calp_export_overrides(
    state: State<AppState>,
    package_name: String,
    window: tauri::Window,
) -> Result<calp::OverridePatch, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let layer = state.override_layer.read().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    // Determine baseline version from subscription manifest (first match wins).
    let baseline_version = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        subs.subscriptions.iter()
            .find(|s| s.package_name == package_name)
            .map(|s| s.resolved_version.clone())
            .unwrap_or_else(|| "0.0.0".to_string())
    };
    let patch = calp::OverridePatch::from_layer(&layer, &package_name, &baseline_version, &now);
    Ok(patch)
}

/// Import (merge) an OverridePatch JSON string into the current override layer.
/// Returns the number of overrides imported.
#[tauri::command]
pub fn calp_import_overrides(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    patch_json: String,
    window: tauri::Window,
) -> Result<usize, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let mut patch: calp::OverridePatch =
        serde_json::from_str(&patch_json).map_err(|e| e.to_string())?;

    // Filter out overrides targeting writeback cells — overrides on writeback
    // cells are not allowed (writeback cells use the writeback layer instead).
    {
        let wb_index = state.writeback_index.lock().map_err(|e| e.to_string())?;
        if !wb_index.is_empty() {
            let before = patch.overrides.len();
            patch.overrides.retain(|ovr| {
                !wb_index.contains(ovr.sheet_id, ovr.position.0, ovr.position.1)
            });
            let skipped = before - patch.overrides.len();
            if skipped > 0 {
                crate::log_info!("CALP", "Skipped {} overrides targeting writeback cells", skipped);
            }
        }
    }

    let count = patch.overrides.len();
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut layer = state.override_layer.write(&effect).map_err(|e| e.to_string())?;
    patch.apply_to(&mut layer);
    Ok(count)
}

// ============================================================================
// Override capture — subscriber edits to subscribed sheets
// ============================================================================

/// Canonical string form of an engine cell value for override comparison.
/// Must stay in sync with `override_value_from_saved` so a captured baseline
/// compares meaningfully against upstream values from pulled payloads
/// (SavedCellValue::from_value uses the same conventions, incl. `{:?}` errors).
fn override_display(value: &engine::CellValue) -> String {
    match value {
        engine::CellValue::Empty => String::new(),
        engine::CellValue::Number(n) => n.to_string(),
        engine::CellValue::Text(s) => s.clone(),
        engine::CellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        // THE CANONICAL LITERAL, and it must stay in lockstep with what
        // `persistence::SavedCellValue::from_value` writes — see
        // `override_value_from_saved`, which compares the two forms directly.
        // This was `format!("{:?}", e)` (the Rust variant name) back when
        // persistence stored the same Debug string; persistence now stores the
        // literal, so leaving this as Debug would make every error-cell override
        // a permanent spurious conflict.
        engine::CellValue::Error(e) => e.as_literal().to_string(),
        other => format!("{:?}", other),
    }
}

/// Test-only view of [`override_display`], so the override layer's
/// "live spelling == persisted spelling" invariant can be pinned by a test
/// rather than by a comment.
#[cfg(test)]
pub(crate) fn override_display_for_test(value: &engine::CellValue) -> String {
    override_display(value)
}

/// Canonical OverrideValue for an engine cell (None = absent/cleared cell).
fn override_value_from_cell(cell: Option<&engine::Cell>) -> calp::OverrideValue {
    match cell {
        None => calp::OverrideValue::Empty,
        Some(c) => {
            if let Some(formula) = c.formula_string() {
                calp::OverrideValue::Formula { formula }
            } else if matches!(c.value, engine::CellValue::Empty) {
                calp::OverrideValue::Empty
            } else {
                calp::OverrideValue::Value { display: override_display(&c.value) }
            }
        }
    }
}

/// Canonical OverrideValue for a pulled payload cell (None = absent cell).
/// Mirror of `override_value_from_cell` for persistence::SavedCell.
///
/// THE BODY MOVED TO `core/calp/src/overrides.rs` and this is now a one-line
/// delegation. It lived here, in the app crate, where only the APPLY path could
/// reach it — so the refresh PREVIEW, which runs against workspace artifacts in
/// `core/calp`, could not compute the conflicts the apply was about to create.
/// It did not try: it reported every override on a changed sheet as a conflict.
/// One predicate in one crate is what lets the preview and the apply agree.
pub(crate) fn override_value_from_saved(cell: Option<&persistence::SavedCell>) -> calp::OverrideValue {
    calp::overrides::override_value_from_saved(cell)
}

/// Record consumer-side overrides for committed edits on a subscribed sheet.
/// Called by the cell write paths (update_cell, update_cells_batch, fill_range)
/// after the grid mutation succeeds; `edits` carries (row, col, pre, post)
/// cell states. Cheap no-op when the sheet isn't part of any subscription.
/// Writeback cells are excluded (they route to the draft layer instead).
pub(crate) fn record_subscription_override_edits(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    sheet_index: usize,
    edits: &[(u32, u32, Option<engine::Cell>, Option<engine::Cell>)],
) {
    if edits.is_empty() {
        return;
    }

    // Resolve the local sheet id for this index.
    let sheet_id = {
        let sheet_ids = match state.sheet_ids.read() {
            Ok(s) => s,
            Err(_) => return,
        };
        match sheet_ids.get(sheet_index) {
            Some(&sid) => sid,
            None => return,
        }
    };

    // Only sheets that belong to a subscription get overrides.
    {
        let subs = match state.subscriptions.read() {
            Ok(s) => s,
            Err(_) => return,
        };
        let subscribed = subs.subscriptions.iter()
            .any(|sub| sub.sheets.iter().any(|s| s.local_sheet_id == sheet_id));
        if !subscribed {
            return;
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let wb_index = state.writeback_index.lock().ok();
    // LOCK ORDER: override_layer BEFORE id_registry — calp_refresh_apply and
    // the workbook-load path acquire them in that order; inverting it here
    // would be an ABBA deadlock under concurrent commands.
    let mut layer = match state.override_layer.write(effect) {
        Ok(l) => l,
        Err(_) => return,
    };
    let mut id_reg = match state.id_registry.lock() {
        Ok(r) => r,
        Err(_) => return,
    };

    for (row, col, pre, post) in edits {
        if let Some(ref idx) = wb_index {
            if idx.contains(sheet_id, *row, *col) {
                continue;
            }
        }

        let pre_value = override_value_from_cell(pre.as_ref());
        let post_value = override_value_from_cell(post.as_ref());
        if pre_value == post_value {
            continue;
        }

        let cell_id = id_reg.cell_id_at(sheet_id, (*row, *col));

        let restored_baseline = layer
            .get(sheet_id, cell_id)
            .map(|existing| post_value == existing.baseline);
        match restored_baseline {
            Some(true) => {
                // Consumer restored the upstream value — the override is gone.
                layer.remove_override(sheet_id, cell_id);
            }
            Some(false) => {
                if let Some(existing) = layer.get_mut(sheet_id, cell_id) {
                    existing.current = post_value;
                    existing.position = (*row, *col);
                    existing.modified_at = now.clone();
                    // A new edit on a conflicted cell supersedes the conflict
                    // decision implicitly: keep the conflict flag so the user
                    // still resolves it in the Overrides pane.
                }
            }
            None => {
                // First edit of this cell: the pre-edit state IS the upstream
                // value (no override existed, so the cell was unmodified).
                layer.set_override(calp::CellOverride {
                    sheet_id,
                    cell_id,
                    position: (*row, *col),
                    baseline: pre_value,
                    current: post_value,
                    created_at: now.clone(),
                    modified_at: now.clone(),
                    author: String::new(),
                    conflict: false,
                    upstream_new: None,
                    extra: std::collections::HashMap::new(),
                });
            }
        }
    }
}

/// A subscription's workspace location, EXACTLY as the subscription stores it.
///
/// This deliberately does no `file://` stripping of its own. A publisher pin is
/// keyed by `(namespace, workspace scope, application)`, and the scope is derived by
/// `calp::workspace_id::workspace_scope` from the very string handed to
/// `open_workspace_scoped`. Stripping the scheme here first would hand it a
/// DIFFERENT string than the one `pull` scoped the pin with:
///
///   * `file:///C:/reg`      -> `/C:/reg`      -> scope `\c:\reg`  (not `c:\reg`)
///   * `file://server/share` -> `server/share` -> a path relative to the process cwd
///
/// The pin would then be written under one identity and read under another, and
/// every `RequirePinned` consumer (writeback, GATHER, model writeback, reset)
/// would report `PublisherNotPinned` and skip — a feature that silently stops
/// working, which is worse than the squat this key shape was introduced to fix.
/// `strip_file_scheme` is the ONE stripper, and it lives behind
/// `workspace_scope`; nothing here needs a second one.
fn subscription_registry_path(sub: &calp::manifest::Subscription) -> &str {
    &sub.registry_url
}

/// Group refreshable subscriptions by workspace path, preserving each
/// subscription's index into the workbook subscription list. Dev and
/// Dev subscriptions are skipped (they refresh through their own flow).
fn group_subscriptions_by_registry(
    subs: &[calp::manifest::Subscription],
) -> Vec<(String, Vec<usize>)> {
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, sub) in subs.iter().enumerate() {
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }
        let path = subscription_registry_path(sub).to_string();
        if let Some(group) = groups.iter_mut().find(|(p, _)| *p == path) {
            group.1.push(i);
        } else {
            groups.push((path, vec![i]));
        }
    }
    groups
}

/// Compute a preview of what a refresh would change, without applying anything.
/// Each subscription is resolved against its own stored workspace URL, so
/// workbooks subscribed to multiple workspaces refresh correctly.
#[tauri::command]
pub fn calp_refresh_preview(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::refresh::RefreshPreview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let layer = state.override_layer.read().map_err(|e| e.to_string())?;

    // WHERE EACH OVERRIDDEN CELL ACTUALLY SITS. The apply resolves this as
    // `id_registry.cell_position(sheet, cell).unwrap_or(ovr.position)`; the
    // preview must resolve it identically or it will read the wrong upstream
    // cell and report conflicts that do not exist. The id registry is app state
    // and `core/calp` cannot see it, so it is snapshotted here and handed over.
    //
    // SCOPED SO THE LOCK IS RELEASED before the workspace loop below: `id_registry`
    // is a bare `Mutex` on the grid write path, and the loop does workspace I/O
    // that can be a remote transport. Lock order subscriptions -> override_layer
    // -> id_registry, which is the order this function already takes them in.
    let override_positions: std::collections::HashMap<(SheetId, CellId), (u32, u32)> = {
        let id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
        layer
            .overrides
            .iter()
            .map(|o| {
                let pos = id_reg
                    .cell_position(o.sheet_id, o.cell_id)
                    .unwrap_or(o.position);
                ((o.sheet_id, o.cell_id), pos)
            })
            .collect()
    };

    // The LIVE tab names, so the resolver names the sheet the user is looking
    // at. `SubscribedSheet.local_name` is stamped at subscribe and never
    // restamped, and renaming a subscribed sheet is allowed.
    let local_sheet_names: std::collections::HashMap<SheetId, String> = {
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        ids.iter()
            .enumerate()
            .filter_map(|(i, id)| names.get(i).map(|n| (*id, n.clone())))
            .collect()
    };

    let mut merged = calp::refresh::RefreshPreview {
        subscription_previews: Vec::new(),
        total_cells_changed: 0,
        total_sheets_added: 0,
        total_sheets_removed: 0,
        total_overrides_conflicted: 0,
        total_overrides_auto_cleared: 0,
        // Starts true and is ANDed down: one workspace group whose count was
        // capped makes the whole figure a floor, and the dialog must say so.
        total_cells_changed_exact: true,
        // Same shape, higher stakes: one unreadable sheet makes the CONFLICT
        // LIST incomplete, and a resolver may not present a partial list as a
        // complete set of decisions. Apply refuses while this is false.
        conflicts_exact: true,
        // Merged across workspace groups like every other field. A line
        // subscription whose application grew a pipeline, and a subscription
        // whose environment no longer resolves, are facts about ONE row each.
        environment_notices: Vec::new(),
        unavailable: Vec::new(),
    };

    for (registry_path, indices) in group_subscriptions_by_registry(&subs.subscriptions) {
        let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
            .map_err(|e| format!("Workspace '{}': {}", registry_path, e))?;
        let group: Vec<_> = indices.iter()
            .map(|&i| subs.subscriptions[i].clone())
            .collect();
        let preview =
            calp::refresh::compute_preview(
                &registry,
                &group,
                &layer,
                &override_positions,
                &local_sheet_names,
            )
            .map_err(|e| format!("Workspace '{}': {}", registry_path, e))?;

        merged.subscription_previews.extend(preview.subscription_previews);
        merged.total_cells_changed += preview.total_cells_changed;
        merged.total_sheets_added += preview.total_sheets_added;
        merged.total_sheets_removed += preview.total_sheets_removed;
        merged.total_overrides_conflicted += preview.total_overrides_conflicted;
        merged.total_overrides_auto_cleared += preview.total_overrides_auto_cleared;
        merged.total_cells_changed_exact &= preview.total_cells_changed_exact;
        merged.conflicts_exact &= preview.conflicts_exact;
        merged.environment_notices.extend(preview.environment_notices);
        merged.unavailable.extend(preview.unavailable);
    }

    Ok(merged)
}

/// What to do with ONE conflicted cell when the refresh applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolutionChoice {
    /// Today's behaviour, and the default for any cell the caller does not name:
    /// the local value survives, rebased onto the new upstream baseline.
    KeepMine,
    /// Discard the local edit and take what the publisher now says. The grid
    /// already holds the pristine upstream content — the wholesale replacement
    /// ran before any of this — so dropping the override IS the whole write.
    TakeTheirs,
}

/// One resolved cell, keyed the way the override layer is keyed.
///
/// (sheetId, cellId), never (sheetIndex, row, col): positions move under a
/// refresh, and the layer is id-anchored precisely so an override survives a
/// structural shift.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellResolution {
    /// The LOCAL sheet id, as `calp_refresh_preview` reports it.
    pub sheet_id: SheetId,
    pub cell_id: CellId,
    pub choice: ResolutionChoice,
}

/// One row of what the preview showed, echoed back by the dialog.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewedSubscriptionVersion {
    pub registry_url: String,
    pub package_name: String,
    /// The version the preview said this refresh would install.
    pub new_version: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshApplyParams {
    /// Only the cells the user actually decided on. An omitted or empty list
    /// means every conflict keeps the local value and stays flagged — which is
    /// exactly what a refresh did before there was anything to decide.
    #[serde(default)]
    pub resolutions: Vec<CellResolution>,
    /// EXACTLY the refresh the preview described, echoed back so this command
    /// can refuse to be a different one.
    ///
    /// The dialog computes its preview once and is non-modal by design, and the
    /// two halves resolve the version pin independently. A subscriber who reads
    /// `base=100 / mine=999 / theirs=150` for A1 and thinks for two minutes
    /// while the publisher pushes a version where A1 is `7` used to get `7` —
    /// their 999 discarded for a value the dialog never displayed, under a
    /// confirm strip saying the decision is not undoable.
    ///
    /// `None` (an omitted key) means the caller showed the user nothing and the
    /// gate does not apply: the in-process script gateway calls
    /// `caps.packages.refresh()` with no preview at all, and there is no stale
    /// decision to protect there. An empty LIST is not the same thing — it says
    /// "the preview found no update", and a refresh that now has one is refused.
    #[serde(default)]
    pub previewed_versions: Option<Vec<PreviewedSubscriptionVersion>>,
}

/// Apply the refresh after the user has confirmed the preview.
/// Pulls new versions for all subscriptions that have updates and materializes
/// new/updated sheets into the workbook grids. Each subscription is pulled
/// from its own stored workspace URL.
#[tauri::command]
pub fn calp_refresh_apply(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    bi_state: State<BiState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    slicer_state: State<crate::slicer::SlicerState>,
    params: Option<RefreshApplyParams>,
    window: tauri::Window,
) -> Result<calp::refresh::RefreshResult, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // `Option`, so the in-process script gateway can pass `None` and an omitted
    // key still deserializes. No resolutions means keep every local value, which
    // is what this command did before it could be told otherwise.
    let (resolutions, previewed_versions) = params
        .map(|p| (p.resolutions, p.previewed_versions))
        .unwrap_or_default();
    let now = chrono::Utc::now().to_rfc3339();

    // NO SUBSCRIPTION MAY BE SILENTLY SKIPPED.
    //
    // The preview degrades one row per unresolvable subscription rather than
    // aborting the whole workbook's preview — an admin removing an environment
    // must not blank everybody else's. But an APPLY that quietly refreshed the
    // healthy ones and said nothing about the rest would report success for a
    // refresh that left a subscription stranded on a pointer that no longer
    // exists. The dialog blocks on the same list, so this is the second lock on
    // the same door: a script calling `refreshApply` directly hits it too.
    {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let mut stranded: Vec<String> = Vec::new();
        for sub in &subs.subscriptions {
            if calp::dev_mode::is_dev_subscription(sub) {
                continue;
            }
            let Some(env) = &sub.environment else { continue };
            let Ok((registry, _scope)) =
                crate::calp_registry::open_workspace_scoped(&sub.registry_url)
            else {
                continue; // Unreachable workspace is a different failure, reported below.
            };
            if calp::environments::resolve_environment(registry.as_ref(), &sub.package_name, env)
                .is_err()
            {
                stranded.push(format!("'{}' ({})", sub.package_name, env));
            }
        }
        if !stranded.is_empty() {
            return Err(format!(
                "CALP_REFRESH_ENVIRONMENT_UNAVAILABLE: {} follow(s) an environment that no \
                 longer resolves, so this refresh would leave it behind without saying so. \
                 Pick another environment for it in Manage Subscriptions, or follow the \
                 development line, and refresh again.",
                stranded.join(", ")
            ));
        }
    }

    // Pull new versions for all subscriptions that have updates.
    let payloads = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let mut all_payloads = Vec::new();
        for (registry_path, indices) in group_subscriptions_by_registry(&subs.subscriptions) {
            let (registry, scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
                .map_err(|e| format!("Workspace '{}': {}", registry_path, e))?;
            let group: Vec<_> = indices.iter()
                .map(|&i| subs.subscriptions[i].clone())
                .collect();
            // THIS WORKSPACE's slice of what the user was shown. The rows are
            // matched on (workspace, application) because the merged preview the
            // dialog receives puts every workspace's rows in one list, and two
            // teams may each publish `sales` to their own share.
            let shown = previewed_versions.as_ref().map(|rows| {
                calp::refresh::PreviewedVersions {
                    by_package: rows
                        .iter()
                        .filter(|r| {
                            calp::workspace_id::same_workspace(&r.registry_url, &registry_path)
                        })
                        .map(|r| (r.package_name.clone(), r.new_version.clone()))
                        .collect(),
                }
            });
            // ALREADY-TRUSTED: "Apply" in the Refresh dialog means "get the
            // newer version of something I subscribed to". It is NOT a first
            // trust decision, so it may not create a pin -- a subscription that
            // was never locally pulled (restored from a `.cala` that arrived by
            // email) fails here with PublisherNotPinned instead of having its
            // publisher silently pinned by an operation labelled "update".
            let group_payloads = calp::refresh::pull_all_updates(
                &registry,
                &group,
                &scope,
                &calcula_profile_dir(),
                calp::integrity::PinPolicy::RequirePinned,
                shown.as_ref(),
            )
            .map_err(|e| match e {
                // The stale-preview refusal already names the workspace's
                // application and both versions; prefixing it with the raw path
                // would bury the sentence the user has to read.
                calp::CalpError::RefreshMoved(m) => m,
                other => format!("Workspace '{}': {}", registry_path, other),
            })?;
            for mut payload in group_payloads {
                // pull_all_updates indexed into the group slice; remap back to
                // the workbook subscription index.
                payload.subscription_index = indices[payload.subscription_index];
                all_payloads.push(payload);
            }
        }
        all_payloads
    };

    // Resolve name collisions for NEW pulled sheets before materialization
    // (Excel-style "Name (2)"): already-tracked sheets replace in place under
    // their existing local name and are skipped; a single taken-list threads
    // across payloads so two subscriptions adding the same name also resolve.
    // (sheet_names is cloned and released before the subscriptions lock is
    // taken — no lock-order coupling with the materialization block below.)
    let mut payloads = payloads;
    {
        let mut taken = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        for payload in payloads.iter_mut() {
            let skip: std::collections::HashSet<SheetId> = subs
                .subscriptions
                .get(payload.subscription_index)
                .map(|sub| sub.sheets.iter().map(|s| s.package_sheet_id).collect())
                .unwrap_or_default();
            calp::pull::resolve_sheet_name_collisions(
                &mut payload.pull_result.sheets,
                &mut payload.pull_result.subscription.sheets,
                &mut taken,
                &skip,
            );
        }
    }

    // An UPDATE may not write into the host's reserved `__calcula_` id
    // namespace either — a publisher who could not claim one at subscribe must
    // not be able to claim one at v2, which is the version nobody re-reads.
    // Before the effect, so a refused refresh leaves the workbook clean.
    for payload in &payloads {
        refuse_reserved_distributed_script_ids(
            &payload.pull_result.package_name,
            &payload.pull_result.module_scripts,
            &payload.pull_result.notebooks,
        )?;
    }

    // NOTHING TO DO IS NOT A MUTATION. `DocumentEffect::mutates` dirties at
    // construction, and this command used to build it as its first statement —
    // so clicking "Refresh Subscriptions" on an up-to-date workbook armed the
    // close-without-saving prompt for a command that then wrote nothing. Moving
    // the construction alone would not have been enough: the reset-then-apply
    // blocks below consume `effect` unconditionally, so the early return is the
    // load-bearing half.
    //
    // It also skips the layer-wide `auto_clear_matching` sweep that `rebase`
    // ends in, the workbook-name restamp, the writeback-index rebuild and the
    // audit entry. All four are about applying an update; with no update to
    // apply, none of them has anything to say.
    if payloads.is_empty() {
        return Ok(calp::refresh::RefreshResult {
            subscriptions_refreshed: 0,
            sheets_added: 0,
            sheets_removed: 0,
            sheets_updated: 0,
            conflicts_created: 0,
            overrides_auto_cleared: 0,
            structural_conflicts: Vec::new(),
        });
    }

    // ONE effect, constructed after every refusal that precedes a write: the
    // workspace opened, the pulls verified against their pins, the collision
    // pass took and released its locks.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);

    // Materialize new/updated sheets into grids.
    let active_grid_after_materialize = {
        let mut grids = state.grids.write(&effect).map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.write(&effect).map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.write(&effect).map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.write(&effect).map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.write(&effect).map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.write(&effect).map_err(|e| e.to_string())?;
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;

        for payload in &payloads {
            // Revalidate: a concurrent detach/subscribe between lock windows
            // can shift indices; indexing blindly would panic and poison the
            // grid mutexes app-wide.
            let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                continue;
            };

            // Collect package_sheet_ids already tracked in this subscription so
            // we can distinguish new sheets from updated ones.
            let old_package_ids: Vec<_> = sub.sheets.iter()
                .map(|s| s.package_sheet_id)
                .collect();

            for pulled in &payload.pull_result.sheets {
                // DETACHED: the subscriber took this sheet. Upstream no longer
                // speaks for it, so a refresh must neither overwrite the copy
                // they now own nor append a second one beside it.
                if sub.detached_sheets.contains(&pulled.package_sheet_id) {
                    continue;
                }

                let (mut grid, local_styles) = pulled.sheet.to_grid();

                // Remap local style indices (cells AND row/column tiers) to the
                // shared registry, preserving explicit-default duplicates.
                let remap = shared_styles.merge_remap(&local_styles);
                grid.remap_style_indices(&remap);

                if old_package_ids.contains(&pulled.package_sheet_id) {
                    // Updated sheet — replace the existing grid in-place.
                    if let Some(pos) = sub.sheets.iter()
                        .position(|s| s.package_sheet_id == pulled.package_sheet_id)
                    {
                        // The local sheet index in the workbook equals the
                        // position of the subscribed sheet in the global sheet list.
                        // We track it via the local_sheet_id stored at subscription time.
                        let local_sid = sub.sheets[pos].local_sheet_id;
                        if let Some(grid_idx) = sheet_ids.iter().position(|id| *id == local_sid) {
                            grids[grid_idx] = grid;
                            all_cw[grid_idx] = pulled.sheet.column_widths.clone();
                            all_rh[grid_idx] = pulled.sheet.row_heights.clone();
                            // The whole grid at this index was just replaced, so
                            // every spill claim the OLD content made is void.
                            // `restore_spill_extents_for_sheet` sweeps the index
                            // before installing the incoming sheet's extents.
                            crate::spill_restore::restore_spill_extents_for_sheet(
                                state.inner(),
                                grid_idx,
                                &pulled.sheet,
                            );
                        }
                    }
                } else {
                    // New sheet — append to the workbook.
                    grids.push(grid);
                    sheet_names.push(pulled.name.clone());
                    sheet_ids.push(pulled.sheet.id);
                    all_cw.push(pulled.sheet.column_widths.clone());
                    all_rh.push(pulled.sheet.row_heights.clone());
                    crate::spill_restore::restore_spill_extents_for_sheet(
                        state.inner(),
                        grids.len() - 1,
                        &pulled.sheet,
                    );
                }
            }
        }

        // Snapshot the active sheet ONLY when it was actually refreshed.
        // state.grid is the authoritative mirror for the active sheet and
        // grids[active] can legitimately lag behind it (BUG-0016) — an
        // unconditional sync would regress unrefreshed active-sheet content.
        // (sheet_ids and subs are the guards already held by this block.)
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        let active_was_refreshed = sheet_ids.get(active).map_or(false, |active_sid| {
            payloads.iter().any(|payload| {
                let sub = match subs.subscriptions.get(payload.subscription_index) {
                    Some(s) => s,
                    None => return false,
                };
                payload.pull_result.sheets.iter().any(|pulled| {
                    sub.sheets.iter().any(|s| {
                        s.package_sheet_id == pulled.package_sheet_id
                            && s.local_sheet_id == *active_sid
                    })
                })
            })
        });
        if active_was_refreshed {
            grids.get(active).cloned()
        } else {
            None
        }
    };

    // Sync the active-sheet mirror: state.grid is the read path for the
    // active sheet, and calculate_now copies it back over grids[active] —
    // without this sync a refreshed active sheet reverts on the next recalc.
    if let Some(grid) = active_grid_after_materialize {
        *state.grid.write(&effect).map_err(|e| e.to_string())? = grid;
    }

    // Map each refreshed application sheet id -> its LOCAL sheet index, so named
    // ranges + CF/DV (which carry un-remapped APPLICATION sheet ids) materialize onto
    // the right sheet. Updated sheets resolve via the subscription's local_sheet_id
    // (still the pre-refresh mapping here); new sheets were just appended under
    // their own fresh local id (pulled.sheet.id). Runs AFTER sheet materialization
    // and BEFORE apply_refresh moves `payloads`.
    let cfdv_pkg_to_index: std::collections::HashMap<SheetId, usize> = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        let mut map = std::collections::HashMap::new();
        for payload in &payloads {
            let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                continue;
            };
            for pulled in &payload.pull_result.sheets {
                let local_sid = sub
                    .sheets
                    .iter()
                    .find(|s| s.package_sheet_id == pulled.package_sheet_id)
                    .map(|s| s.local_sheet_id)
                    .unwrap_or(pulled.sheet.id); // new sheet: its own fresh local id
                if let Some(idx) = sheet_ids.iter().position(|id| *id == local_sid) {
                    map.insert(pulled.package_sheet_id, idx);
                }
            }
        }
        map
    };

    // Materialize refreshed named ranges + CF/DV — the refresh analog of the
    // calp_pull materialization. Without this a refresh delivers v2 sheets/scripts
    // but leaves the subscriber stuck on v1's CF/DV/named ranges. Done before the
    // payloads move into apply_refresh; the post-refresh recalc resolves names.
    {
        // Named ranges: refresh applies the publisher's latest, so UPSERT by the
        // uppercased key (vs calp_pull's skip-if-present at first subscribe).
        // (Cannot distinguish a publisher-removed name from a subscriber's own
        // without provenance, so removals don't propagate — a known limit.)
        if payloads.iter().any(|p| !p.pull_result.named_ranges.is_empty()) {
            let mut names = state.named_ranges.write(&effect).map_err(|e| e.to_string())?;
            for payload in &payloads {
                for nr in &payload.pull_result.named_ranges {
                    names.insert(
                        nr.name.to_uppercase(),
                        crate::named_ranges::NamedRange {
                            name: nr.name.clone(),
                            sheet_index: nr.sheet_id.and_then(|sid| cfdv_pkg_to_index.get(&sid).copied()),
                            refers_to: nr.refers_to.clone(),
                            comment: None,
                            folder: None,
                        },
                    );
                }
            }
        }

        // §2t ON THE DISTRIBUTION PATH -- see the identical call in `calp_pull`. A
        // refreshed sheet's formulas were just rebuilt from the application's stored
        // TEXT, and the lexer upper-cases every bare identifier, so without this a
        // refresh re-spells every defined name on every refreshed sheet.
        crate::persistence::restamp_workbook_name_casing(&state, &effect);

        // CF/DV: RESET each refreshed sheet's per-sheet entry, then apply v2's, so
        // rules the publisher added/changed/removed in v2 all land (extend would
        // duplicate across refreshes since refreshed sheets keep their local id).
        let refreshed_indices: std::collections::HashSet<usize> =
            cfdv_pkg_to_index.values().copied().collect();

        let mut max_cf_id: u64 = 0;
        {
            let mut store = state.conditional_formats.write(&effect).map_err(|e| e.to_string())?;
            for idx in &refreshed_indices {
                store.remove(idx);
            }
            for payload in &payloads {
                for entry in &payload.pull_result.conditional_formats {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Ok(defs) = serde_json::from_value::<
                            Vec<crate::conditional_formatting::ConditionalFormatDefinition>,
                        >(entry.rules.clone())
                        {
                            for d in &defs {
                                max_cf_id = max_cf_id.max(d.id);
                            }
                            store.insert(idx, defs);
                        }
                    }
                }
            }
        }
        if let Ok(mut next_id) = state.next_cf_rule_id.lock() {
            if *next_id <= max_cf_id {
                *next_id = max_cf_id + 1;
            }
        }

        {
            let mut store = state.data_validations.write(&effect).map_err(|e| e.to_string())?;
            for idx in &refreshed_indices {
                store.remove(idx);
            }
            for payload in &payloads {
                for entry in &payload.pull_result.data_validations {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Ok(ranges) = serde_json::from_value::<
                            Vec<crate::data_validation::ValidationRange>,
                        >(entry.ranges.clone())
                        {
                            store.insert(idx, ranges);
                        }
                    }
                }
            }
        }

        // Comments / scenarios / outlines (Wave B): RESET each refreshed
        // sheet's entry, then apply v2's — CF/DV semantics, so threads/
        // scenarios/groups the publisher added, changed, or removed in v2 all
        // land (and a publisher who stopped opting comments in effectively
        // retracts them from subscribers on the next refresh).
        {
            let mut store = state.comments.write(&effect).map_err(|e| e.to_string())?;
            for idx in &refreshed_indices {
                store.remove(idx);
            }
            for payload in &payloads {
                for entry in &payload.pull_result.comments {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Ok(threads) = serde_json::from_value::<
                            Vec<crate::comments::Comment>,
                        >(entry.comments.clone())
                        {
                            let sheet_map = store.entry(idx).or_default();
                            for mut c in threads {
                                c.sheet_index = idx;
                                sheet_map.insert((c.row, c.col), c);
                            }
                        }
                    }
                }
            }
        }
        {
            let mut store = state.scenarios.write(&effect).map_err(|e| e.to_string())?;
            for idx in &refreshed_indices {
                store.remove(idx);
            }
            for payload in &payloads {
                for entry in &payload.pull_result.scenarios {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Ok(mut scenarios) = serde_json::from_value::<
                            Vec<crate::api_types::Scenario>,
                        >(entry.scenarios.clone())
                        {
                            for s in &mut scenarios {
                                s.sheet_index = idx;
                            }
                            store.entry(idx).or_default().extend(scenarios);
                        }
                    }
                }
            }
        }
        {
            let mut store = state.outlines.write(&effect).map_err(|e| e.to_string())?;
            for idx in &refreshed_indices {
                store.remove(idx);
            }
            for payload in &payloads {
                for entry in &payload.pull_result.outlines {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Ok(outline) = serde_json::from_value::<
                            crate::grouping::SheetOutline,
                        >(entry.outline.clone())
                        {
                            store.insert(idx, outline);
                        }
                    }
                }
            }
        }
        // Cell-behavior bindings: same RESET-then-apply semantics, so a binding
        // the publisher REMOVED in v2 stops firing for subscribers instead of
        // surviving for ever. Keyed by binding id, so the reset is by sheet.
        {
            let mut store = state
                .cell_behaviors
                .write(&effect)
                .map_err(|e| e.to_string())?;
            store.retain(|_, b| !refreshed_indices.contains(&b.sheet_index));
            for payload in &payloads {
                crate::cell_behaviors::materialize_saved_cell_behaviors(
                    &payload.pull_result.cell_behaviors,
                    &mut store,
                    |sid| cfdv_pkg_to_index.get(&sid).copied(),
                );
            }
        }
    }

    // Cell types (distribution brick 4): refresh analog of the calp_pull
    // materialization — RESET each refreshed sheet's assignments then apply the
    // new version's, mirroring CF/DV so publisher add/change/remove all land.
    {
        let refreshed_indices: std::collections::HashSet<usize> =
            cfdv_pkg_to_index.values().copied().collect();
        let mut cell_types = state.cell_types.write(&effect).map_err(|e| e.to_string())?;
        cell_types.retain(|(si, _, _), _| !refreshed_indices.contains(si));
        let saved: Vec<persistence::SavedSheetCellTypes> = payloads
            .iter()
            .flat_map(|p| p.pull_result.custom_objects.iter())
            .filter(|co| co.kind == "cellType")
            .filter_map(|co| {
                co.package_sheet_id.map(|sid| persistence::SavedSheetCellTypes {
                    sheet_id: sid,
                    cells: co.payload.clone(),
                })
            })
            .collect();
        crate::cell_types::materialize_saved_cell_types(
            &saved,
            &mut cell_types,
            |sid| cfdv_pkg_to_index.get(&sid).copied(),
        );
    }

    // Materialize refreshed sheet presentation state (merges, freeze panes,
    // tab color, visibility, gridlines, page setup, notes, hyperlinks) with
    // reset semantics — the publisher owns a subscribed sheet's presentation —
    // and keep the index-aligned per-sheet stores aligned for sheets this
    // refresh appended. The refresh analog of the calp_pull materialization.
    {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        for payload in &payloads {
            let pairs: Vec<(SheetId, &persistence::Sheet)> = payload
                .pull_result
                .sheets
                .iter()
                .map(|p| (p.package_sheet_id, &p.sheet))
                .collect();
            materialize_pulled_sheet_state(&state, &effect, &pairs, &cfdv_pkg_to_index, active)?;
        }
    }

    // Provenance-ledger updates accumulated per subscription while payloads
    // are still borrowable; merged into the subscriptions after apply_refresh.
    let mut refresh_ledgers: std::collections::HashMap<usize, Vec<calp::manifest::SubscribedObject>> =
        std::collections::HashMap::new();
    let ledger_entry = |kind: &str, id: String, name: String| calp::manifest::SubscribedObject {
        kind: kind.to_string(),
        id,
        name,
        extra: std::collections::HashMap::new(),
    };

    // Tables: replace this application's own tables (from the provenance ledger)
    // with the new version's set, so table changes actually land on refresh.
    // Subscriber-authored tables are not in the ledger and are never touched.
    {
        // Removal first (its own lock scope), then the shared additive
        // materializer re-adds the v2 set.
        {
            let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
            let mut tables = state.tables.write(&effect).map_err(|e| e.to_string())?;
            let mut table_names = state.table_names.write(&effect).map_err(|e| e.to_string())?;
            for payload in &payloads {
                let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                    continue;
                };
                let owned: std::collections::HashSet<String> = sub
                    .objects
                    .iter()
                    .filter(|o| o.kind == "table")
                    .map(|o| o.id.clone())
                    .collect();
                if !owned.is_empty() {
                    for sheet_tables in tables.values_mut() {
                        sheet_tables.retain(|id, t| {
                            let keep = !owned.contains(&id.to_string());
                            if !keep {
                                table_names.remove(&t.name.to_uppercase());
                            }
                            keep
                        });
                    }
                }
            }
        }
        for payload in &payloads {
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            materialize_pulled_tables(
                &effect,
                &state,
                &payload.pull_result.tables,
                &cfdv_pkg_to_index,
                Some(entries),
            )?;
        }
    }

    // Charts: same ledger-scoped replace, so v2 charts actually land on
    // refresh (previously a subscriber stayed on v1 charts forever). Chart
    // sheet ids in the payload are the FRESH local ids this pull minted; map
    // fresh id -> application id -> existing local index.
    {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let mut charts = state.charts.write(&effect).map_err(|e| e.to_string())?;
        for payload in &payloads {
            let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                continue;
            };
            let owned: std::collections::HashSet<String> = sub
                .objects
                .iter()
                .filter(|o| o.kind == "chart")
                .map(|o| o.id.clone())
                .collect();
            charts.retain(|c| !owned.contains(&c.id.to_string()));
            let fresh_to_pkg: std::collections::HashMap<SheetId, SheetId> = payload
                .pull_result
                .sheets
                .iter()
                .map(|p| (p.sheet.id, p.package_sheet_id))
                .collect();
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for chart in &payload.pull_result.charts {
                let Some(pkg_sid) = fresh_to_pkg.get(&chart.sheet_id) else {
                    continue;
                };
                let Some(&idx) = cfdv_pkg_to_index.get(pkg_sid) else {
                    continue;
                };
                if !charts.iter().any(|c| c.id == chart.id) {
                    entries.push(ledger_entry("chart", chart.id.to_string(), String::new()));
                    charts.push(crate::api_types::ChartEntry {
                        id: chart.id,
                        sheet_index: idx,
                        spec_json: chart.spec_json.clone(),
                    });
                }
            }
        }
    }

    // Sparklines + controls: RESET each refreshed sheet's entries then apply
    // v2's (CF/DV semantics — sparklines carry no id, and controls are
    // publisher-owned presentation on subscribed sheets). Yields the on-grid
    // snapshot for the pane-control collision guard below: cloned AFTER the
    // reset removed the applications' v1 on-grid controls but BEFORE the v2 set
    // lands, so the guard sees only the SUBSCRIBER's own on-grid names —
    // never the applications' own (v1 or just-landed v2) names, which would
    // shadow the applications' own same-named pane controls.
    let on_grid_snapshot = {
        let refreshed: std::collections::HashSet<usize> =
            cfdv_pkg_to_index.values().copied().collect();
        {
            let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
            sparklines.retain(|e| !refreshed.contains(&e.sheet_index));
            for payload in &payloads {
                let fresh_to_pkg: std::collections::HashMap<SheetId, SheetId> = payload
                    .pull_result
                    .sheets
                    .iter()
                    .map(|p| (p.sheet.id, p.package_sheet_id))
                    .collect();
                for sp in &payload.pull_result.sparklines {
                    let Some(pkg_sid) = fresh_to_pkg.get(&sp.sheet_id) else { continue };
                    let Some(&idx) = cfdv_pkg_to_index.get(pkg_sid) else { continue };
                    sparklines.push(crate::api_types::SparklineEntry {
                        sheet_index: idx,
                        groups_json: sp.groups_json.clone(),
                    });
                }
            }
        }
        {
            // Sheet locks BEFORE the controls lock: the sheet-structure
            // commands (delete/move/copy_sheet) take controls while holding
            // the sheet locks for their per-sheet HashMap-store remap, so
            // sheet-then-controls is the canonical order — taking controls
            // first here would be an AB/BA inversion against them.
            let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
            let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
            // Same order as first pull: media in before the controls that name
            // it. Additive — the save-time sweep, not this path, decides what a
            // refresh made unreachable.
            for payload in &payloads {
                if !payload.pull_result.media.is_empty() {
                    let (accepted, rejected) = crate::media::merge_pulled_media(
                        &state,
                        &effect,
                        payload.pull_result.media.clone(),
                    )?;
                    log::info!(
                        "[calp] refresh pulled {} media blob(s), refused {}",
                        accepted,
                        rejected
                    );
                }
            }
            // Sanitize + migrate legacy inline images for every payload BEFORE
            // the controls lock: admission takes the MEDIA lock, and
            // media-then-controls is the order this whole block already uses.
            let mut admitted_controls: Vec<Vec<persistence::SavedSheetControls>> =
                Vec::with_capacity(payloads.len());
            for payload in &payloads {
                admitted_controls.push(crate::media::admit_distributed_controls(
                    &state,
                    &effect,
                    &payload.pull_result.controls,
                )?);
            }
            let mut controls = state.controls.write(&effect).map_err(|e| e.to_string())?;
            controls.retain(|(sheet_idx, _, _), _| !refreshed.contains(sheet_idx));
            // Cloned under the ALREADY-HELD controls lock (calling
            // snapshot_on_grid_controls here would re-lock and deadlock);
            // released with this scope, before the pane/filter locks below.
            let snapshot = controls.clone();
            for (payload, sanitized) in payloads.iter().zip(admitted_controls.iter()) {
                // Same admission as first pull: distributed onSelect wiring
                // (inline script source) never materializes, and a legacy
                // application's inline base64 arrives as a media handle.
                crate::controls::materialize_saved_controls(
                    sanitized,
                    &mut controls,
                    |sid| cfdv_pkg_to_index.get(&sid).copied(),
                );
                let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
                for entry in &payload.pull_result.controls {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Some(local_sid) = sheet_ids.get(idx) {
                            entries.push(ledger_entry(
                                "controlSheet",
                                local_sid.to_string(),
                                sheet_names.get(idx).cloned().unwrap_or_default(),
                            ));
                        }
                    }
                }
            }
            snapshot
        }
    };

    // Pane controls: same ledger-scoped replace as tables/charts — remove the
    // application's own pane controls (from the provenance ledger; subscriber-
    // authored ones are never in it and are never touched), then re-add the
    // new version's set through the SAME collision-guarded materializer
    // calp_pull uses (a v2 control landing on a subscriber-taken name is
    // skipped, not clobbered). Without this a subscriber stayed on first-pull
    // pane controls forever. Fresh "paneControl" ledger entries come from the
    // APPLIED list; like every other kind here, refresh mutates backend state
    // directly and the document-modified flag stays frontend-owned
    // (mark_file_modified after the command returns).
    //
    // Yields application name -> "pane-{id}" instance ids of incoming pane
    // controls whose host did NOT land (collision-skipped, not retained):
    // the script swap below must not land those applications' host-less pane
    // scripts (delete-path hygiene).
    let orphaned_pane_instances: std::collections::HashMap<
        String,
        std::collections::HashSet<String>,
    > = {
        // Removal first (its own lock scope, subscriptions before pane
        // controls — the same order as the table/chart removal blocks), then
        // the shared additive materializer re-adds the v2 set.
        {
            let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
            let mut controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;
            for payload in &payloads {
                let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                    continue;
                };
                let owned: std::collections::HashSet<String> = sub
                    .objects
                    .iter()
                    .filter(|o| o.kind == "paneControl")
                    .map(|o| o.id.clone())
                    .collect();
                if !owned.is_empty() {
                    controls.retain(|id, _| !owned.contains(&id.to_string()));
                }
            }
        }
        // `on_grid_snapshot` was cloned above AFTER the refreshed sheets'
        // on-grid controls were reset but BEFORE v2's landed, so an application's
        // own on-grid names never block its own pane controls (they only
        // guard the subscriber's).
        let mut orphaned: std::collections::HashMap<
            String,
            std::collections::HashSet<String>,
        > = std::collections::HashMap::new();
        for payload in &payloads {
            let applied = materialize_pulled_pane_controls(
                &pane_control_state,
                &ribbon_filter_state,
                &on_grid_snapshot,
                &payload.pull_result.pane_controls,
            )?;
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for (id, name) in applied {
                entries.push(ledger_entry("paneControl", id, name));
            }
            let missing_hosts = orphaned_pane_script_instance_ids(
                &pane_control_state,
                &payload.pull_result.pane_controls,
            )?;
            if !missing_hosts.is_empty() {
                orphaned
                    .entry(payload.pull_result.package_name.clone())
                    .or_default()
                    .extend(missing_hosts);
            }
        }
        orphaned
    };

    // Slicers (Wave A): ledger-scoped REPLACE like charts — remove this
    // application's own slicers (from the provenance ledger; subscriber-authored
    // ones are never in it), then re-add the new version's set through the
    // SAME materializer calp_pull uses. Slicers carry APPLICATION sheet ids
    // (CF/DV semantics), so cfdv_pkg_to_index resolves the local sheet.
    // Computed properties of removed slicers are dropped with them.
    {
        {
            let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
            let mut slicers = slicer_state.slicers.write(&effect).map_err(|e| e.to_string())?;
            let mut computed_props = slicer_state
                .computed_properties
                .write(&effect)
                .map_err(|e| e.to_string())?;
            for payload in &payloads {
                let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                    continue;
                };
                let owned: std::collections::HashSet<String> = sub
                    .objects
                    .iter()
                    .filter(|o| o.kind == "slicer")
                    .map(|o| o.id.clone())
                    .collect();
                if !owned.is_empty() {
                    slicers.retain(|id, _| {
                        let keep = !owned.contains(&id.to_string());
                        if !keep {
                            computed_props.remove(id);
                        }
                        keep
                    });
                }
            }
        }
        for payload in &payloads {
            // Same sanitization as first pull: distributed computed-property
            // formulas never materialize.
            let applied = materialize_pulled_slicers(
                &effect,
                &state,
                &slicer_state,
                &sanitize_distributed_slicers(&payload.pull_result.slicers),
                |sid| cfdv_pkg_to_index.get(&sid).copied(),
            )?;
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for (id, name) in applied {
                entries.push(ledger_entry("slicer", id, name));
            }
        }
    }

    // Ribbon filters (Wave A): same ledger-scoped replace, through the SAME
    // guarded materializer calp_pull uses (data-source-unknown / id / name
    // collisions are skipped, never clobbered). The carried connection ids
    // still point at the publisher's connections here — the re-bind onto this
    // workbook's application connections runs after the data-source refresh below.
    {
        {
            let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
            let mut filters = ribbon_filter_state.filters.write(&effect).map_err(|e| e.to_string())?;
            for payload in &payloads {
                let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                    continue;
                };
                let owned: std::collections::HashSet<String> = sub
                    .objects
                    .iter()
                    .filter(|o| o.kind == "ribbonFilter")
                    .map(|o| o.id.clone())
                    .collect();
                if !owned.is_empty() {
                    filters.retain(|id, _| !owned.contains(&id.to_string()));
                }
            }
        }
        for payload in &payloads {
            let pulled_ds_ids: std::collections::HashSet<String> = payload
                .pull_result
                .data_sources
                .iter()
                .map(|ds| ds.definition.id.clone())
                .collect();
            let applied = materialize_pulled_ribbon_filters(
                &pane_control_state,
                &ribbon_filter_state,
                &effect,
                &on_grid_snapshot,
                &payload.pull_result.ribbon_filters,
                &pulled_ds_ids,
            )?;
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for (id, name) in applied {
                entries.push(ledger_entry("ribbonFilter", id, name));
            }
        }
    }

    // Saved pivot layouts (Wave A): ledger-scoped replace, then re-add v2
    // additively (a subscriber-authored same-id layout wins — locals are
    // never in the ledger and are never removed).
    {
        {
            let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
            let mut layouts = state.pivot_layouts.write(&effect).map_err(|e| e.to_string())?;
            for payload in &payloads {
                let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                    continue;
                };
                let owned: std::collections::HashSet<String> = sub
                    .objects
                    .iter()
                    .filter(|o| o.kind == "pivotLayout")
                    .map(|o| o.id.clone())
                    .collect();
                if !owned.is_empty() {
                    layouts.retain(|l| !owned.contains(&l.id.to_string()));
                }
            }
        }
        let mut layouts = state.pivot_layouts.write(&effect).map_err(|e| e.to_string())?;
        for payload in &payloads {
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for layout in &payload.pull_result.pivot_layouts {
                if layouts.iter().any(|l| l.id == layout.id) {
                    continue;
                }
                entries.push(ledger_entry(
                    "pivotLayout",
                    layout.id.to_string(),
                    layout.name.clone(),
                ));
                layouts.push(layout.clone());
            }
        }
    }

    // Document theme (Wave A): same guarded singleton rule as first pull —
    // the publisher's theme applies only while the subscriber's is still the
    // default. Extension data: same additive merge as first pull — the
    // publisher can never clobber subscriber extension state. Keys ACTUALLY
    // inserted (new in this version) get fresh "extensionData" ledger entries;
    // keys merged by an earlier pull carry over in the ledger merge below.
    for payload in &payloads {
        apply_pulled_theme(&effect, &state, payload.pull_result.theme.as_ref())?;
        let inserted =
            merge_pulled_extension_data(&state, &effect, &payload.pull_result.extension_data)?;
        if !inserted.is_empty() {
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for key in inserted {
                entries.push(ledger_entry("extensionData", key.clone(), key));
            }
        }
    }

    // Ledger entries for named ranges (upserted unconditionally above, so the
    // full v2 set is accurate). Script kinds (objectScript/moduleScript/
    // notebook) are recorded at their point of ACTUAL application below — the
    // swap/materialize conflict guards can skip entries, and a skipped local
    // script must never be attributed to the application.
    for payload in &payloads {
        let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
        for nr in &payload.pull_result.named_ranges {
            entries.push(ledger_entry("namedRange", nr.name.to_uppercase(), nr.name.clone()));
        }
    }

    // Re-materialize refreshed application data sources: swap each existing
    // application connection's engine onto the new version's model (and create
    // connections for data sources ADDED in this version). Without this, a
    // dataset (model-only) subscription refresh advanced the version while
    // silently serving the old model. Existing dataSource ledger entries
    // carry over in the merge below; only newly-added ones are appended.
    for payload in &payloads {
        let added = refresh_embedded_data_sources(
            &payload.pull_result.data_sources,
            &bi_state,
            &ribbon_filter_state,
            &slicer_state,
        );
        if !added.is_empty() {
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for (id, name) in added {
                entries.push(ledger_entry("dataSource", id, name));
            }
        }
    }

    // Re-bind the just-refreshed ribbon filters + BI-sourced slicers (Wave A)
    // onto THIS workbook's application connections. The v2 artifacts carry the
    // PUBLISHER's connection uuids (== the stable application data-source ids);
    // load_embedded_data_sources only remaps for data sources ADDED in this
    // version, so rebuild the full ds-id -> connection map from the existing
    // application connections and remap once more.
    {
        let ds_to_conn: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
            bi_state
                .connections
                .lock()
                .map_err(|e| e.to_string())?
                .iter()
                .filter_map(|(id, c)| c.package_data_source_id.clone().map(|ds| (ds, *id)))
                .collect();
        if !ds_to_conn.is_empty() {
            crate::ribbon_filter::remap_ribbon_filter_connections(
                &ribbon_filter_state,
                &effect,
                &ds_to_conn,
            );
            remap_slicer_bi_connections(&effect, &slicer_state, &ds_to_conn);
        }
    }

    // Capture the pre-refresh writeback declarations BEFORE the index is
    // rebuilt below, so removed/incompatible regions are actually detected.
    let old_decls = state.writeback_declarations.lock()
        .map(|d| d.clone()).unwrap_or_default();
    let old_model_decls = state.model_writeback_declarations.lock()
        .map(|d| d.clone()).unwrap_or_default();

    // Build the upstream-value map for the override rebase: for every
    // override on a refreshed sheet, the new upstream value at the override's
    // current local position. Application payloads are coordinate-keyed (no
    // per-cell ids yet), so matching is positional — correct when upstream
    // updates values in place; upstream row/column insertions are a known
    // limitation until applications carry cell-level ids.
    let (upstream_values, refreshed_sheet_ids) = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let layer = state.override_layer.read().map_err(|e| e.to_string())?;
        let id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;

        let mut values: std::collections::HashMap<(SheetId, CellId), calp::OverrideValue> =
            std::collections::HashMap::new();
        let mut sheets: std::collections::HashSet<SheetId> = std::collections::HashSet::new();
        for payload in &payloads {
            let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                continue;
            };
            for pulled in &payload.pull_result.sheets {
                let Some(sheet_sub) = sub.sheets.iter()
                    .find(|s| s.package_sheet_id == pulled.package_sheet_id)
                else { continue };
                let local_sid = sheet_sub.local_sheet_id;
                sheets.insert(local_sid);
                for ovr in layer.overrides_for_sheet(local_sid) {
                    let pos = id_reg
                        .cell_position(local_sid, ovr.cell_id)
                        .unwrap_or(ovr.position);
                    let upstream_cell = pulled.sheet.cells.get(&pos);
                    values.insert(
                        (local_sid, ovr.cell_id),
                        override_value_from_saved(upstream_cell),
                    );
                }
            }
        }
        (values, sheets)
    };

    // Collect each payload's refreshed script set before the payloads move
    // into apply_refresh below.
    let script_updates: Vec<(String, Vec<persistence::SavedObjectScript>)> = payloads
        .iter()
        .map(|p| (p.pull_result.package_name.clone(), p.pull_result.object_scripts.clone()))
        .collect();

    // C8: likewise collect the refreshed standalone module scripts + notebooks
    // before the move, so the refresh can materialize them (without this they are
    // pulled then silently dropped, leaving a subscriber stuck on the version
    // present at first subscribe). Kept PER APPLICATION so removal-on-refresh +
    // preserve-local can scope to the owning application.
    #[allow(clippy::type_complexity)]
    let module_notebook_updates: Vec<(String, Vec<persistence::SavedScript>, Vec<persistence::SavedNotebook>)> =
        payloads
            .iter()
            .map(|p| {
                (
                    p.pull_result.package_name.clone(),
                    p.pull_result.module_scripts.clone(),
                    p.pull_result.notebooks.clone(),
                )
            })
            .collect();

    // Apply refresh: update subscription metadata and rebase overrides.
    let mut subs = state.subscriptions.write(&effect).map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.write(&effect).map_err(|e| e.to_string())?;

    // apply_refresh indexes subscriptions by payload.subscription_index; if a
    // concurrent detach shrank the list since the payloads were built, bail
    // out instead of panicking inside the core crate.
    if payloads.iter().any(|p| p.subscription_index >= subs.subscriptions.len()) {
        return Err("Subscriptions changed while the refresh was running — please retry.".to_string());
    }

    let mut result = calp::refresh::apply_refresh(
        payloads,
        &mut subs.subscriptions,
        &mut layer,
        &upstream_values,
        &now,
    );


    // PER-CELL RESOLUTION, AND IT MUST SIT EXACTLY HERE.
    //
    // ABOVE `apply_refresh` there is nothing to resolve: `rebase` is what sets
    // `conflict` and `upstream_new`, so `keep_override` would find no upstream
    // value to rebase onto and return false.
    //
    // BELOW the `to_overlay` snapshot it is too late, and silently so. That
    // vector is a CLONE taken here and painted onto the grids 40-odd lines
    // further down; an override removed from the layer after the clone is still
    // in the clone. The user would pick "take theirs", watch the count say so,
    // and get their own value painted back over the publisher's.
    //
    // Uses the `layer` guard already held. `Persisted<T>` is a std::sync::Mutex
    // and is NOT reentrant — re-acquiring `state.override_layer` here would
    // block this thread forever, which is the rule `apply_override_value_to_grid`
    // documents for the same reason.
    let mut conflicts_resolved = 0usize;
    for r in &resolutions {
        // Was this actually a conflict? `accept_upstream` is `remove_override`,
        // which succeeds for ANY override present, including one `rebase`
        // deliberately left un-conflicted. Counting those would decrement a
        // figure they were never part of.
        let was_conflict = layer
            .get(r.sheet_id, r.cell_id)
            .map(|o| o.conflict)
            .unwrap_or(false);
        // A RESOLUTION RESOLVES A CONFLICT, and nothing else.
        //
        // `KeepMine` was already inert on a non-conflicted cell —
        // `keep_override` needs the `upstream_new` only `rebase` sets. `TakeTheirs`
        // was NOT: `accept_upstream` is `remove_override`, which succeeds for any
        // override present. So a decision about a cell this refresh never
        // reached still deleted the subscriber's record of it.
        //
        // The way to reach that is not exotic. If the new version DROPS the
        // sheet, its cells are absent from the payload, `rebase` skips every
        // override on it (`let Some(new_upstream) = ... else { continue }`) and
        // the re-overlay below skips it too — so the ledger entry vanished while
        // the grid, never re-materialized for that sheet, went on showing the
        // subscriber's own value. A local edit with nothing left to say it is
        // one: invisible in the Overrides pane, and republished as the
        // publisher's content by anyone who checks the workbook out.
        if !was_conflict {
            continue;
        }
        let acted = match r.choice {
            // No grid write: the wholesale replacement already put pristine
            // upstream content in this cell, so dropping the override is the
            // entire operation — the re-overlay below simply skips it now.
            ResolutionChoice::TakeTheirs => layer.accept_upstream(r.sheet_id, r.cell_id),
            ResolutionChoice::KeepMine => layer.keep_override(r.sheet_id, r.cell_id),
        };
        if acted && was_conflict {
            conflicts_resolved += 1;
        }
    }
    // `conflicts_created` was counted by `rebase`, before any of this. Every
    // conflict the user just settled is one the Overrides pane will not show,
    // so reporting it as outstanding would be a lie the dialog then prints.
    result.conflicts_created = result.conflicts_created.saturating_sub(conflicts_resolved);

    // Re-overlay surviving overrides onto the refreshed grids: the wholesale
    // grid replacement above wrote pristine upstream content, which would
    // otherwise silently discard the subscriber's local modifications.
    // Conflicted overrides keep showing the local value; the Overrides pane
    // is where the user resolves them.
    let to_overlay: Vec<calp::CellOverride> = layer.overrides.iter()
        .filter(|o| refreshed_sheet_ids.contains(&o.sheet_id))
        .cloned()
        .collect();

    // Merge the provenance-ledger updates into the refreshed subscriptions:
    // kinds this refresh re-materialized are replaced with the v2 set; kinds a
    // refresh does not touch (pivots, data sources) carry over from the pull.
    // paneControl deliberately does NOT carry over: every refreshed payload
    // re-materializes pane controls above (pull_all_updates always reads
    // pane_controls.json, empty set included, and every payload enters
    // refresh_ledgers via the tables block), so the fresh entries are the
    // full truth — carrying old ones would resurrect ledger rows for controls
    // the v2 removal just deleted. The Wave A kinds (slicer, ribbonFilter,
    // pivotLayout) follow the same rule: re-materialized for every payload
    // above, so their fresh entries are the full truth too. extensionData
    // carries over like pivots/dataSources: the merge is ADDITIVE-only (never
    // removed or replaced on refresh), so entries from earlier pulls stay
    // valid — fresh entries cover only keys newly inserted this refresh (a
    // same-key fresh entry can only mean the subscriber deleted the key and
    // this refresh re-seeded it, so it must not duplicate the carried row).
    // Subscriptions WITHOUT an update never get a payload, never enter
    // refresh_ledgers, and keep their ledger wholesale.
    for (sub_idx, new_entries) in refresh_ledgers {
        if let Some(sub) = subs.subscriptions.get_mut(sub_idx) {
            let mut objects: Vec<calp::manifest::SubscribedObject> = sub
                .objects
                .iter()
                .filter(|o| {
                    o.kind == "pivot" || o.kind == "dataSource" || o.kind == "extensionData"
                })
                .cloned()
                .collect();
            for entry in new_entries {
                if entry.kind == "extensionData"
                    && objects
                        .iter()
                        .any(|o| o.kind == "extensionData" && o.id == entry.id)
                {
                    continue;
                }
                objects.push(entry);
            }
            sub.objects = objects;
        }
    }

    // Rebuild writeback index from updated subscriptions
    drop(subs);
    drop(layer);

    for ovr in &to_overlay {
        apply_override_value_to_grid(&state, &effect, ovr.sheet_id, ovr.cell_id, ovr.position, &ovr.current);
    }

    // Swap in the refreshed applications' scripts: replace each application's
    // previous distributed scripts with the new version's set (already
    // stamped Distributed + restricted by the pull layer) and add new ones.
    // Without this the workbook keeps running v1 scripts against vN sheets
    // and the hash-keyed consent re-prompt can never trigger. Distributed
    // scripts are upstream-owned (read-only locally), so replacement is safe.
    // (application name, ledger entries) for scripts ACTUALLY applied by the swap
    // and the module/notebook materialization below — appended to each
    // subscription's ledger afterwards, so a conflict-skipped local script is
    // never attributed to an application.
    let mut applied_script_entries: Vec<(String, Vec<calp::manifest::SubscribedObject>)> =
        Vec::new();
    {
        let mut scripts = state.object_scripts.write(&effect).map_err(|e| e.to_string())?;
        for (package_name, new_scripts) in script_updates {
            scripts.retain(|s| {
                !(matches!(s.provenance, persistence::ScriptProvenance::Distributed)
                    && s.package_name.as_deref() == Some(package_name.as_str()))
            });
            let orphaned = orphaned_pane_instances.get(&package_name);
            let mut applied: Vec<calp::manifest::SubscribedObject> = Vec::new();
            for script in new_scripts {
                // Delete-path hygiene: a v2 "pane-{id}" script whose host
                // pane control was collision-skipped above never lands —
                // it would persist host-less (inert, but a distributed
                // script with nothing to attach to). Applied/retained
                // controls' scripts, and everything non-pane, pass through.
                if orphaned.is_some_and(|set| {
                    script.instance_id.as_deref().is_some_and(|i| set.contains(i))
                }) {
                    crate::log_warn!(
                        "CALP",
                        "Skipping distributed script '{}' from application '{}': its host pane control was collision-skipped",
                        script.name, package_name
                    );
                    continue;
                }
                // Never let an application script shadow an unrelated local
                // script that happens to share its id.
                if !scripts.iter().any(|s| s.id == script.id) {
                    applied.push(calp::manifest::SubscribedObject {
                        kind: "objectScript".to_string(),
                        id: script.id.clone(),
                        name: script.name.clone(),
                        extra: std::collections::HashMap::new(),
                    });
                    scripts.push(script);
                }
            }
            applied_script_entries.push((package_name, applied));
        }
    }

    // C8: materialize each refreshed application's standalone module scripts +
    // notebooks so upstream updates (incl. removals) actually land on refresh,
    // while preserving subscriber-local same-id documents.
    let mut any_custom_functions_changed = false;
    for (pkg, modules, notebooks) in &module_notebook_updates {
        let (applied_modules, applied_notebooks, cf_changed) =
            materialize_distributed_scripts(&effect, &script_state, pkg, modules, notebooks)?;
        any_custom_functions_changed |= cf_changed;
        let mut entries: Vec<calp::manifest::SubscribedObject> = Vec::new();
        for (id, name) in applied_modules {
            entries.push(calp::manifest::SubscribedObject {
                kind: "moduleScript".to_string(),
                id,
                name,
                extra: std::collections::HashMap::new(),
            });
        }
        for (id, name) in applied_notebooks {
            entries.push(calp::manifest::SubscribedObject {
                kind: "notebook".to_string(),
                id,
                name,
                extra: std::collections::HashMap::new(),
            });
        }
        applied_script_entries.push((pkg.clone(), entries));
    }
    if any_custom_functions_changed {
        // Re-install the live UDF registry NOW — without this, refreshed
        // custom-function formulas stay stale/#NAME? until a reopen.
        let _ = tauri::Emitter::emit(&window, "custom-functions:refresh", ());
    }

    // Complete the provenance ledger with the script kinds recorded above at
    // their point of actual application. (The earlier merge replaced all
    // non-pivot/dataSource entries, so appending here cannot duplicate.)
    {
        let mut subs = state.subscriptions.write(&effect).map_err(|e| e.to_string())?;
        for (pkg, entries) in applied_script_entries {
            if entries.is_empty() {
                continue;
            }
            if let Some(sub) = subs
                .subscriptions
                .iter_mut()
                .find(|s| s.package_name == pkg)
            {
                sub.objects.extend(entries);
            }
        }
    }

    rebuild_writeback_index(&state);

    // Handle writeback region changes: invalidate drafts for removed/incompatible regions
    {
        // Reload new declarations (rebuild_writeback_index just updated them);
        // old_decls was captured before the rebuild.
        let new_decls = state.writeback_declarations.lock()
            .map(|d| d.clone()).unwrap_or_default();

        if !old_decls.is_empty() || !new_decls.is_empty() {
            let compat = calp::writeback::check_region_compatibility(&old_decls, &new_decls);

            // Remove drafts for removed or incompatible regions
            let invalidated_ids: std::collections::HashSet<&str> = compat.removed.iter()
                .chain(compat.incompatible.iter().map(|(id, _)| id))
                .map(|s| s.as_str())
                .collect();

            if !invalidated_ids.is_empty() {
                let mut dropped = 0usize;
                if let Ok(mut wb_layer) = state.writeback_layer.write(&effect) {
                    let before = wb_layer.draft_count();
                    wb_layer.drafts.retain(|d| !invalidated_ids.contains(d.region_id.as_str()));
                    dropped = before - wb_layer.draft_count();
                    if dropped > 0 {
                        crate::log_info!("CALP", "Refresh invalidated {} writeback drafts for removed/incompatible regions", dropped);
                    }
                }
                // AUDIT: losing entered-but-unsubmitted work to an upstream
                // change is exactly the kind of thing a contributor must be
                // able to reconstruct afterwards. `WritebackInvalidated`
                // existed for this and was never recorded anywhere.
                record_writeback_invalidated(
                    &state,
                    &format!(
                        "Refresh dropped {} writeback draft(s): {} region(s) removed upstream, {} changed incompatibly ({})",
                        dropped,
                        compat.removed.len(),
                        compat.incompatible.len(),
                        summarize_ids(invalidated_ids.iter().copied()),
                    ),
                );
            }
        }
    }

    // Handle MODEL writeback COLUMN changes. There are no drafts to drop —
    // bi_writeback_set_value submits straight to the workspace — but a column
    // that vanished or narrowed stops counting submissions that previously
    // reached the model, and nothing told the user until now.
    {
        let new_model_decls = state.model_writeback_declarations.lock()
            .map(|d| d.clone()).unwrap_or_default();

        if !old_model_decls.is_empty() || !new_model_decls.is_empty() {
            let compat = calp::writeback::check_model_writeback_compatibility(
                &old_model_decls,
                &new_model_decls,
            );
            if compat.has_losses() {
                // Name the host table.column, not just the opaque id — the id
                // is a slug the user has never seen.
                let label = |id: &str| -> String {
                    old_model_decls
                        .iter()
                        .find(|d| d.id == id)
                        .map(|d| format!("{}.{}", d.table, d.column))
                        .unwrap_or_else(|| id.to_string())
                };
                let removed: Vec<String> = compat.removed.iter().map(|id| label(id)).collect();
                let changed: Vec<String> = compat
                    .incompatible
                    .iter()
                    .map(|(id, why)| format!("{} ({})", label(id), why))
                    .collect();

                crate::log_warn!(
                    "CALP",
                    "Refresh changed model writeback columns — collected values may stop counting. Removed: [{}]. Changed: [{}]",
                    removed.join(", "),
                    changed.join(", "),
                );
                record_writeback_invalidated(
                    &state,
                    &format!(
                        "Refresh changed {} model writeback column(s) — previously collected values may no longer reach the model. Removed: [{}]. Changed: [{}]",
                        compat.removed.len() + compat.incompatible.len(),
                        removed.join(", "),
                        changed.join(", "),
                    ),
                );
            }
        }
    }

    // The refreshed grids hold pristine upstream content plus overlays whose
    // formula cells are pending evaluation, and the dependency maps still
    // describe the PRE-refresh active sheet. Rebuild deps (active sheet only —
    // the maps are single-sheet) and re-evaluate every refreshed sheet, rather
    // than leaving the non-active ones for whenever the user next presses F9.
    {
        let refreshed_indices: Vec<usize> = {
            let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
            sheet_ids.iter().enumerate()
                .filter(|(_, sid)| refreshed_sheet_ids.contains(sid))
                .map(|(i, _)| i)
                .collect()
        };
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        if refreshed_indices.contains(&active) {
            crate::undo_commands::rebuild_all_dependencies(&state);
        }
        // GAP B, materialization half (§2z's one-shared-installer rule): a
        // pulled/refreshed application can carry floating ranges, whose backing
        // sheets are never active and therefore never lazily re-edge.
        crate::floating_range::register_object_sheet_edges(&state);
        for idx in refreshed_indices {
            crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx, Some((&*pane_control_state, &*ribbon_filter_state)));
        }
    }

    // ANNOUNCE THE SHEET COLLECTION. This command APPENDS sheets — `grids.push`
    // / `sheet_names.push` / `sheet_ids.push` above — and emitted nothing at all
    // in its whole body except `custom-functions:refresh`. `SheetTabs` reloads
    // its list on the `sheets` domain, so a refresh that added a sheet reported
    // "1 added" in the dialog while the tab bar showed nothing, until some
    // unrelated tab click happened to re-fire SHEET_CHANGED. Its two siblings
    // both get this right: SubscribeDialog and the reset handler each emit
    // SHEET_CHANGED; refresh was the only one that did not.
    //
    // AFTER the recalculation, never before: the event makes the frontend
    // re-read the sheet list and refetch the grid, and refetching mid-recalc
    // shows half-evaluated cells.
    crate::object_deps::announce_cascade(
        window_app_handle(&window),
        crate::object_deps::ObjectKind::Sheet,
    );

    // Audit (B4)
    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)) {
            audit.record(
                calp::audit::AuditEvent::Refresh,
                "Refreshed subscriptions from workspace",
                &user,
                &now,
            );
        }
    }

    Ok(result)
}

/// The display name of the current subscriber identity, for an audit `user`
/// field (best-effort; empty when no identity is established).
/// Record one distribution audit entry.
///
/// `pub(crate)` so `calp_environments` records through the same path rather
/// than re-deriving the `deliberately_clean(AuditTrail)` effect and the
/// subscriber identity for itself — a second copy of that pair is a second
/// place for the trail to stop being written.
pub(crate) fn record_audit_event(
    state: &AppState,
    event: calp::audit::AuditEvent,
    description: String,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let user = audit_user(state);
    if let Ok(mut audit) = state.audit_log.write(
        &crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::AuditTrail,
        ),
    ) {
        audit.record(event, &description, &user, &now);
    }
}

fn audit_user(state: &AppState) -> String {
    state
        .subscriber_identity
        .lock()
        .ok()
        .and_then(|id| id.as_ref().map(|i| i.display_name.clone()))
        .unwrap_or_default()
}

/// Join up to 8 ids into a readable list, with a "+N more" tail — audit
/// descriptions are read by humans and a 200-region application must not produce a
/// 200-id line.
///
/// Sorts first: callers pass a `HashSet` iterator, so without this the WHICH-8
/// and their order would vary run to run for the identical refresh, making two
/// audit trails of the same event impossible to compare.
fn summarize_ids<'a>(ids: impl Iterator<Item = &'a str>) -> String {
    let mut all: Vec<&str> = ids.collect();
    all.sort_unstable();
    let shown: Vec<&str> = all.iter().take(8).copied().collect();
    if all.len() > shown.len() {
        format!("{}, +{} more", shown.join(", "), all.len() - shown.len())
    } else {
        shown.join(", ")
    }
}

/// Record a [`calp::audit::AuditEvent::WritebackInvalidated`] entry.
///
/// Best-effort and non-fatal: a poisoned audit mutex must never fail a refresh
/// that has already applied. Note this still honors the audit log's `enabled`
/// flag (it is a distribution event, not an always-recorded script event), so
/// it is a record for workbooks that opted in — not a user-facing notice.
fn record_writeback_invalidated(state: &AppState, description: &str) {
    let user = audit_user(state);
    if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)) {
        audit.record(
            calp::audit::AuditEvent::WritebackInvalidated,
            description,
            &user,
            &chrono::Utc::now().to_rfc3339(),
        );
    }
}

/// Strip all subscriptions and overrides, converting the workbook to a
/// standalone (detached) document.
#[tauri::command]
pub fn calp_detach(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Strips EVERY subscription and override: a large, irreversible document change.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut subs = state.subscriptions.write(&effect).map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.write(&effect).map_err(|e| e.to_string())?;

    let detached_count = subs.subscriptions.len();
    calp::refresh::detach(&mut subs.subscriptions, &mut layer);

    // Clear the writeback index AND both declaration mirrors — no subscriptions
    // remain, so no declaration is in force. Leaving the mirrors populated would
    // let a later refresh diff stale-vs-empty and report every region as removed.
    drop(subs);
    drop(layer);
    if let Ok(mut idx) = state.writeback_index.lock() {
        *idx = calp::WritebackIndex::default();
    }
    if let Ok(mut decls) = state.writeback_declarations.lock() {
        decls.clear();
    }
    if let Ok(mut decls) = state.model_writeback_declarations.lock() {
        decls.clear();
    }
    invalidate_gather_cache(&state);

    // Audit (B4)
    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)) {
            audit.record(
                calp::audit::AuditEvent::Detach,
                &format!("Detached from {} subscription(s)", detached_count),
                &user,
                &now,
            );
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachSheetParams {
    /// Workbook index. An INDEX, not a name: this is invoked from the tab, and a
    /// subscriber may rename a subscribed sheet, so the name is not a stable key.
    pub sheet_index: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachSheetResponse {
    pub package_name: String,
    /// Override LEDGER entries dropped. The CELLS are untouched — see below.
    pub overrides_dropped: usize,
    /// True when this was the subscription's last remaining holding.
    pub subscription_removed: bool,
}

/// Where one sheet came from, for the surfaces that mark it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetProvenanceInfo {
    /// TRUE workbook index. Shifts on insert/delete/move, so a consumer that
    /// caches it must re-read when the sheet list changes.
    pub sheet_index: usize,
    /// The workbook's stable sheet uuid. Both keys come from ONE snapshot, so a
    /// consumer never has to join two round trips that can tear.
    pub sheet_id: String,
    /// The PUBLISHER's id for this sheet. On a subscriber this is a different
    /// uuid from `sheet_id` — pull mints fresh local ids — and it is the one
    /// every published artifact and every DIFF ROW is keyed by, so a caller
    /// lining local sheets up against published content needs this one. On a
    /// working copy the two coincide, because preserving the application's sheet
    /// identity is what checkout is for.
    pub package_sheet_id: String,
    /// The LIVE name, not the ledger's `local_name` — renaming is allowed.
    pub sheet_name: String,
    pub package_name: String,
    pub registry_url: String,
    pub resolved_version: String,
    /// The environment a SUBSCRIBED sheet follows, or None for the development
    /// line. Always None for a working-copy sheet: a working copy is of a
    /// VERSION on the line, never of an environment.
    pub environment: Option<String>,
    /// WHICH ROLE this sheet holds toward that application: `"subscribed"` (it
    /// came from somebody else's application and is refreshed from it) or
    /// `"workingCopy"` (it IS the application, and a push carries it).
    ///
    /// The two answers look identical on a tab and behave oppositely, which is
    /// the whole reason this is reported per sheet rather than per workbook.
    /// Before checkout was additive it did not need to be: a working copy was
    /// the WHOLE document, so the status-bar chip said it once and every tab
    /// inherited the answer. Now the application's sheets sit beside the
    /// author's own in one workbook, so the answer varies by tab again.
    pub role: String,
}

/// `SheetProvenanceInfo::role` for a sheet pulled from a subscribed application.
pub(crate) const SHEET_ROLE_SUBSCRIBED: &str = "subscribed";
/// `SheetProvenanceInfo::role` for a sheet this workbook is the working copy of.
pub(crate) const SHEET_ROLE_WORKING_COPY: &str = "workingCopy";

/// Which sheets came from a published application, and in which ROLE.
///
/// Read-only, so no `DocumentEffect`. ONE answer for the tab badge, the
/// context-menu predicate and the publish dialog — `calp_get_subscriptions`
/// returns the raw ledger with no workbook indices, and
/// `calp_get_application_objects` is per-application and pulls nine other stores.
///
/// TWO SOURCES, ONE LIST. Subscribed sheets come from the subscription ledger;
/// working-copy sheets come from the working-copy link's `base_sheets`, whose
/// ids ARE local ids because checkout preserves the application's sheet identity
/// (`SheetIdMode::PreserveApplication`) — that preservation is the whole point of
/// checkout. A sheet cannot hold both roles: the role gates in `calp_checkout`
/// refuse the overlap outright, and the subscription branch wins here anyway.
#[tauri::command]
pub fn calp_get_sheet_provenance(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<SheetProvenanceInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    sheet_provenance_rows(&state)
}

/// The body of [`calp_get_sheet_provenance`], without the `Window` its guard
/// needs — so the two-source join can be tested rather than only compiled.
pub(crate) fn sheet_provenance_rows(state: &AppState) -> Result<Vec<SheetProvenanceInfo>, String> {
    let provenance = crate::sheets::SheetProvenance::snapshot(state)?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    let link = state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    let base_sheets: std::collections::HashSet<identity::SheetId> = link
        .as_ref()
        .map(|l| l.base_sheets.iter().map(|s| s.sheet_id).collect())
        .unwrap_or_default();

    Ok((0..sheet_names.len())
        .filter_map(|i| {
            if let Some(o) = provenance.origin(i) {
                return Some(SheetProvenanceInfo {
                    sheet_index: i,
                    sheet_id: o.local_sheet_id.to_string(),
                    package_sheet_id: o.package_sheet_id.to_string(),
                    sheet_name: o.sheet_name.clone(),
                    package_name: o.package_name.clone(),
                    registry_url: o.registry_url.clone(),
                    resolved_version: o.resolved_version.clone(),
                    environment: o.environment.clone(),
                    role: SHEET_ROLE_SUBSCRIBED.to_string(),
                });
            }
            let sid = *sheet_ids.get(i)?;
            if !base_sheets.contains(&sid) {
                return None;
            }
            let l = link.as_ref()?;
            Some(SheetProvenanceInfo {
                sheet_index: i,
                sheet_id: sid.to_string(),
                // The SAME id: checkout preserves the application's sheet
                // identity, which is the whole point of a working copy.
                package_sheet_id: sid.to_string(),
                sheet_name: sheet_names.get(i).cloned().unwrap_or_default(),
                package_name: l.package_name.clone(),
                registry_url: l.registry_url.clone(),
                resolved_version: l.base_version.clone(),
                environment: None,
                role: SHEET_ROLE_WORKING_COPY.to_string(),
            })
        })
        .collect())
}

/// Detach ONE sheet from the application that provided it: keep the sheet, stop
/// tracking it.
///
/// `calp_detach` is the workbook-wide hammer — every subscription, every
/// override. This is the per-sheet form the distribution design has always
/// described ("save the sheet locally, detaching just that sheet from upstream")
/// and is the remedy the delete guard points at.
///
/// THE CELLS ARE NOT TOUCHED. The override layer is a LEDGER, not a shadow
/// store: an edit on a subscribed sheet already wrote through to the grid and
/// merely recorded baseline+current alongside. What detaching discards is the
/// ability to revert to upstream — which is what detaching MEANS.
#[tauri::command]
pub fn calp_detach_sheet(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    params: DetachSheetParams,
    window: tauri::Window,
) -> Result<DetachSheetResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    detach_sheet_inner(&state, &file_state, params.sheet_index)
}

pub(crate) fn detach_sheet_inner(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    sheet_index: usize,
) -> Result<DetachSheetResponse, String> {
    let (local_sid, sheet_name) = {
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let sid = *ids
            .get(sheet_index)
            .ok_or_else(|| format!("Sheet index {} is out of range.", sheet_index))?;
        (sid, names.get(sheet_index).cloned().unwrap_or_default())
    };

    // GATE AND MUTATION IN ONE CRITICAL SECTION. Tauri dispatches on a thread
    // pool, so a read-then-drop-then-write would be a TOCTOU window in which a
    // concurrent refresh could re-add the very sheet being detached.
    let pending = state.subscriptions.lock_pending().map_err(|e| e.to_string())?;

    let (sub_index, package_sheet_id, package_name) = {
        let subs = &*pending;
        let found = subs
            .subscriptions
            .iter()
            .enumerate()
            .find_map(|(i, sub)| {
                sub.sheets
                    .iter()
                    .find(|s| s.local_sheet_id == local_sid)
                    .map(|s| (i, s.package_sheet_id, sub.package_name.clone()))
            });
        found.ok_or_else(|| {
            format!(
                "Sheet '{}' did not come from a published application — there is nothing to detach.",
                sheet_name
            )
        })?
    };

    // Constructed AFTER the only gate that can refuse: `mutates` dirties the
    // document at construction, so building it earlier would dirty on a refusal.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut subs = pending.authorize(&effect);

    let subscription_removed = {
        let sub = &mut subs.subscriptions[sub_index];
        sub.sheets.retain(|s| s.local_sheet_id != local_sid);
        if !sub.detached_sheets.contains(&package_sheet_id) {
            sub.detached_sheets.push(package_sheet_id);
        }
        // Remove the whole row only when it owns NOTHING else. A library or
        // dataset subscription legitimately has zero sheets, so "no sheets ⇒
        // delete" would be wrong; "nothing left at all ⇒ delete" is not.
        sub.sheets.is_empty() && sub.objects.is_empty() && sub.data_source_configs.is_empty()
    };
    if subscription_removed {
        subs.subscriptions.remove(sub_index);
    }
    drop(subs);

    // Lock order subscriptions -> override_layer, matching `calp_detach`.
    let overrides_dropped = {
        let mut layer = state.override_layer.write(&effect).map_err(|e| e.to_string())?;
        let before = layer.overrides.len();
        layer.overrides.retain(|o| o.sheet_id != local_sid);
        before - layer.overrides.len()
    };

    // A REBUILD, not the hand-clear `calp_detach` does: something usually
    // survives here. It invalidates the gather cache itself, so one call covers
    // both.
    rebuild_writeback_index(state);

    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = audit_user(state);
        if let Ok(mut audit) = state.audit_log.write(
            &crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::AuditTrail,
            ),
        ) {
            audit.record(
                calp::audit::AuditEvent::Detach,
                &format!("Detached sheet '{}' from '{}'", sheet_name, package_name),
                &user,
                &now,
            );
        }
    }

    Ok(DetachSheetResponse {
        package_name,
        overrides_dropped,
        subscription_removed,
    })
}

// ============================================================================
// Phase 6: Author Workflow Commands
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSubscribeParams {
    /// Local .cala file path to subscribe to in dev mode.
    pub source_path: String,
    /// Sheet names to pull; empty means all sheets.
    pub sheet_names: Vec<String>,
}

/// Subscribe to a local .cala file in dev mode.
/// Materialize the sheets into the workbook exactly like `calp_pull`.
#[tauri::command]
pub fn calp_dev_subscribe(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    params: DevSubscribeParams,
    window: tauri::Window,
) -> Result<PullResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // A dev subscribe materializes application sheets, tables and controls into THIS
    // workbook and records the subscription -- all persisted, and nothing resets
    // the flag afterwards the way `open_file` does.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let source = std::path::Path::new(&params.source_path);
    let now = chrono::Utc::now().to_rfc3339();

    let result = calp::dev_mode::pull_dev(source, &params.sheet_names)
        .map_err(|e| e.to_string())?;

    let sheets_pulled = result.sheets.len();

    // Resolve the application name from the subscription that will be created.
    let package_name = format!("dev:{}", params.source_path);

    // Materialize pulled sheets into the workbook.
    let dev_map: std::collections::HashMap<SheetId, usize> = {
        let mut grids = state.grids.write(&effect).map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.write(&effect).map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.write(&effect).map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.write(&effect).map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.write(&effect).map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.write(&effect).map_err(|e| e.to_string())?;

        let mut map = std::collections::HashMap::new();
        for pulled in &result.sheets {
            let (mut grid, local_styles) = pulled.sheet.to_grid();

            // Remap local style indices (cells AND row/column tiers) to the
            // shared registry, preserving explicit-default duplicates.
            let remap = shared_styles.merge_remap(&local_styles);
            grid.remap_style_indices(&remap);

            map.insert(pulled.source_sheet_id, grids.len());
            grids.push(grid);
            sheet_names.push(pulled.name.clone());
            sheet_ids.push(pulled.sheet.id);
            all_cw.push(pulled.sheet.column_widths.clone());
            all_rh.push(pulled.sheet.row_heights.clone());
            // Dev preview = subscriber fidelity, spill ownership included.
            crate::spill_restore::restore_spill_extents_for_sheet(
                state.inner(),
                grids.len() - 1,
                &pulled.sheet,
            );
        }
        map
    };

    // §2t ON THE DISTRIBUTION PATH -- the same restamp `calp_pull` runs, for
    // the same reason: `to_grid()` above rebuilt every formula from stored TEXT
    // and the lexer upper-cases bare identifiers, so a dev preview would show
    // the author `=BUDGETTOTAL` where their workbook says `=BudgetTotal`. Dev
    // preview claims subscriber fidelity; this is part of that claim.
    crate::persistence::restamp_workbook_name_casing(&state, &effect);

    // Dev preview = subscriber fidelity: presentation state, tables and
    // controls materialize exactly like a real pull (controls sanitized the
    // same way), so the author's fast loop previews what subscribers get.
    {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        let pairs: Vec<(SheetId, &persistence::Sheet)> = result
            .sheets
            .iter()
            .map(|p| (p.source_sheet_id, &p.sheet))
            .collect();
        materialize_pulled_sheet_state(&state, &effect, &pairs, &dev_map, active)?;
    }
    let mut dev_objects: Vec<calp::manifest::SubscribedObject> = Vec::new();
    let tables_pulled =
        materialize_pulled_tables(&effect, &state, &result.tables, &dev_map, Some(&mut dev_objects))?;
    materialize_dev_controls(&state, &effect, &result, &dev_map, &mut dev_objects)?;

    // Store the dev subscription (with the provenance ledger, so the Application
    // Explorer works for dev subscriptions too).
    {
        let mut subscription = calp::dev_mode::make_dev_subscription(
            &params.source_path,
            &result,
            &now,
        );
        subscription.objects = dev_objects;
        let mut subs = state.subscriptions.write(&effect).map_err(|e| e.to_string())?;
        subs.subscriptions.push(subscription);
    }

    Ok(PullResponse {
        package_name,
        // Dev preview materializes into the CURRENT workbook and leaves the
        // user where they were; it has no activation step to inform.
        first_pulled_sheet_index: None,
        resolved_version: "dev".to_string(),
        sheets_pulled,
        tables_pulled,
        scripts_pulled: 0,
        // Dev subscriptions pull from the user's own local workbook folder
        // (not a signed workspace application), so there is no publisher to verify.
        publisher_name: String::new(),
        trust_status: "dev".to_string(),
        other_scope_pins: Vec::new(),
        custom_objects: Vec::new(),
    })
}

/// Materialize a dev pull's controls (sanitized like a real pull) and record
/// controlSheet ledger entries. Shared by dev subscribe + dev refresh.
fn materialize_dev_controls(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    result: &calp::dev_mode::DevPullResult,
    dev_map: &std::collections::HashMap<SheetId, usize>,
    ledger: &mut Vec<calp::manifest::SubscribedObject>,
) -> Result<(), String> {
    // Media BEFORE the controls that name it, exactly as a real pull does: a dev
    // source is a .cala on disk, so it carries whatever its author's document
    // holds — `media/{sha256}` entries for a current file, inline base64 for a
    // legacy one. Both arrive as handles.
    if !result.media.is_empty() {
        let (accepted, rejected) =
            crate::media::merge_pulled_media(state, effect, result.media.clone())?;
        log::info!(
            "[calp] dev pull carried {} media blob(s), refused {}",
            accepted,
            rejected
        );
    }
    if result.controls.is_empty() {
        return Ok(());
    }
    let sanitized = crate::media::admit_distributed_controls(state, effect, &result.controls)?;
    let mut controls = state.controls.write(effect).map_err(|e| e.to_string())?;
    crate::controls::materialize_saved_controls(&sanitized, &mut controls, |sid| {
        dev_map.get(&sid).copied()
    });
    drop(controls);
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
    for entry in &result.controls {
        if let Some(&idx) = dev_map.get(&entry.sheet_id) {
            if let Some(local_sid) = sheet_ids.get(idx) {
                ledger.push(calp::manifest::SubscribedObject {
                    kind: "controlSheet".to_string(),
                    id: local_sid.to_string(),
                    name: sheet_names.get(idx).cloned().unwrap_or_default(),
                    extra: std::collections::HashMap::new(),
                });
            }
        }
    }
    Ok(())
}

/// Re-pull from the dev source, refreshing HEAD sheets in the workbook.
#[tauri::command]
pub fn calp_dev_refresh(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    window: tauri::Window,
) -> Result<PullResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Re-materializes the dev source over this workbook: same reasoning as
    // `calp_dev_subscribe`.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // Find the dev subscription.
    let (source_path, sub_index) = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let idx = subs.subscriptions.iter().position(calp::dev_mode::is_dev_subscription)
            .ok_or_else(|| "No dev subscription found in current workbook".to_string())?;
        // A DEV subscription's `registry_url` is `file://<path-to-a-.cala-file>`
        // — not a workspace, one workbook on disk — so this is a genuine
        // filesystem path, not a pin scope. Use the crate's ONE stripper rather
        // than a local `strip_prefix`, which mishandles `file:///C:/...` and
        // `file://server/share`.
        let url = &subs.subscriptions[idx].registry_url;
        let path = calp::workspace_id::strip_file_scheme(url);
        (path, idx)
    };

    let now = chrono::Utc::now().to_rfc3339();
    let source = std::path::Path::new(&source_path);

    // Determine which sheet names were originally requested (empty = all).
    let sheet_names: Vec<String> = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        subs.subscriptions[sub_index].sheets.iter()
            .map(|s| s.local_name.clone())
            .collect()
    };

    let result = calp::dev_mode::pull_dev(source, &sheet_names)
        .map_err(|e| e.to_string())?;

    let sheets_pulled = result.sheets.len();
    let package_name = format!("dev:{}", source_path);

    // Replace sheets already tracked by this subscription; append any new ones.
    let dev_map: std::collections::HashMap<SheetId, usize> = {
        let mut grids = state.grids.write(&effect).map_err(|e| e.to_string())?;
        let mut sheet_names_state = state.sheet_names.write(&effect).map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.write(&effect).map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.write(&effect).map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.write(&effect).map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.write(&effect).map_err(|e| e.to_string())?;
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let sub = &subs.subscriptions[sub_index];

        let old_sheet_ids: Vec<_> = sub.sheets.iter()
            .map(|s| s.local_sheet_id)
            .collect();

        let mut map = std::collections::HashMap::new();
        for (i, pulled) in result.sheets.iter().enumerate() {
            let (mut grid, local_styles) = pulled.sheet.to_grid();

            // Remap local style indices (cells AND row/column tiers) to the
            // shared registry, preserving explicit-default duplicates.
            let remap = shared_styles.merge_remap(&local_styles);
            grid.remap_style_indices(&remap);

            if let Some(local_sid) = old_sheet_ids.get(i).copied() {
                // Replace the existing grid in-place.
                if let Some(grid_idx) = sheet_ids.iter().position(|id| *id == local_sid) {
                    grids[grid_idx] = grid;
                    all_cw[grid_idx] = pulled.sheet.column_widths.clone();
                    all_rh[grid_idx] = pulled.sheet.row_heights.clone();
                    map.insert(pulled.source_sheet_id, grid_idx);
                    crate::spill_restore::restore_spill_extents_for_sheet(
                        state.inner(),
                        grid_idx,
                        &pulled.sheet,
                    );
                }
            } else {
                // New sheet added since last pull — append.
                map.insert(pulled.source_sheet_id, grids.len());
                grids.push(grid);
                sheet_names_state.push(pulled.name.clone());
                sheet_ids.push(pulled.sheet.id);
                all_cw.push(pulled.sheet.column_widths.clone());
                all_rh.push(pulled.sheet.row_heights.clone());
                crate::spill_restore::restore_spill_extents_for_sheet(
                    state.inner(),
                    grids.len() - 1,
                    &pulled.sheet,
                );
            }
        }
        map
    };

    // §2t ON THE DISTRIBUTION PATH -- see `calp_pull`.
    crate::persistence::restamp_workbook_name_casing(&state, &effect);

    // Dev refresh mirrors the real refresh: presentation state resets to the
    // source's, this subscription's own tables are replaced with the new set,
    // and controls reset (sanitized) on the refreshed sheets.
    {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        let pairs: Vec<(SheetId, &persistence::Sheet)> = result
            .sheets
            .iter()
            .map(|p| (p.source_sheet_id, &p.sheet))
            .collect();
        materialize_pulled_sheet_state(&state, &effect, &pairs, &dev_map, active)?;
    }
    {
        // Remove this dev subscription's ledger-owned tables, then re-add v2.
        let owned: std::collections::HashSet<String> = {
            let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
            subs.subscriptions[sub_index]
                .objects
                .iter()
                .filter(|o| o.kind == "table")
                .map(|o| o.id.clone())
                .collect()
        };
        if !owned.is_empty() {
            let mut tables = state.tables.write(&effect).map_err(|e| e.to_string())?;
            let mut table_names = state.table_names.write(&effect).map_err(|e| e.to_string())?;
            for sheet_tables in tables.values_mut() {
                sheet_tables.retain(|id, t| {
                    let keep = !owned.contains(&id.to_string());
                    if !keep {
                        table_names.remove(&t.name.to_uppercase());
                    }
                    keep
                });
            }
        }
    }
    let mut dev_objects: Vec<calp::manifest::SubscribedObject> = Vec::new();
    let tables_pulled =
        materialize_pulled_tables(&effect, &state, &result.tables, &dev_map, Some(&mut dev_objects))?;
    {
        let refreshed: std::collections::HashSet<usize> = dev_map.values().copied().collect();
        let mut controls = state.controls.write(&effect).map_err(|e| e.to_string())?;
        controls.retain(|(sheet_idx, _, _), _| !refreshed.contains(sheet_idx));
    }
    materialize_dev_controls(&state, &effect, &result, &dev_map, &mut dev_objects)?;

    // Update the subscription timestamp + provenance ledger (a dev
    // subscription only ever owns tables + control sheets, so wholesale
    // replacement is accurate).
    {
        let mut subs = state.subscriptions.write(&effect).map_err(|e| e.to_string())?;
        subs.subscriptions[sub_index].resolved_at = now;
        subs.subscriptions[sub_index].objects = dev_objects;
    }

    Ok(PullResponse {
        package_name,
        // Dev preview materializes into the CURRENT workbook and leaves the
        // user where they were; it has no activation step to inform.
        first_pulled_sheet_index: None,
        resolved_version: "dev".to_string(),
        sheets_pulled,
        tables_pulled,
        scripts_pulled: 0,
        // Dev re-pull: local-folder source, no signed publisher to verify.
        publisher_name: String::new(),
        trust_status: "dev".to_string(),
        other_scope_pins: Vec::new(),
        custom_objects: Vec::new(),
    })
}

/// Rename a stable CellId (author-facing operation).
#[tauri::command]
pub fn calp_rename_cell_id(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    sheet_id: String,
    old_cell_id: String,
    new_cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let old = CellId::parse(&old_cell_id)
        .ok_or_else(|| format!("Invalid old_cell_id: {}", old_cell_id))?;
    let new = CellId::parse(&new_cell_id)
        .ok_or_else(|| format!("Invalid new_cell_id: {}", new_cell_id))?;
    let mut reg = state.id_registry.lock().map_err(|e| e.to_string())?;
    let renamed = reg.rename_cell(sid, old, new);
    // CONDITIONAL: the registry is persisted, but a rename that matched nothing is not
    // a document change.
    if renamed {
        let _effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    }
    Ok(renamed)
}

/// Merge two stable CellIds (author-facing operation).
#[tauri::command]
pub fn calp_merge_cell_ids(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    sheet_id: String,
    survivor_cell_id: String,
    absorbed_cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let survivor = CellId::parse(&survivor_cell_id)
        .ok_or_else(|| format!("Invalid survivor_cell_id: {}", survivor_cell_id))?;
    let absorbed = CellId::parse(&absorbed_cell_id)
        .ok_or_else(|| format!("Invalid absorbed_cell_id: {}", absorbed_cell_id))?;
    let mut reg = state.id_registry.lock().map_err(|e| e.to_string())?;
    let merged = reg.merge_cells(sid, survivor, absorbed);
    // CONDITIONAL: same rule as calp_rename_cell_id.
    if merged {
        let _effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    }
    Ok(merged)
}

// ============================================================================
// Phase 7: Audit Log Commands
// ============================================================================

/// Return the full audit log for the current workbook.
#[tauri::command]
pub fn calp_get_audit_log(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::audit::AuditLog, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let log = state.audit_log.read().map_err(|e| e.to_string())?;
    Ok(log.clone())
}

/// Enable or disable audit logging and set the maximum number of entries.
/// Pass `max_entries = 0` for unlimited.
#[tauri::command]
pub fn calp_set_audit_enabled(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    enabled: bool,
    max_entries: usize,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // `enabled` decides whether audit_log.json is written at all -- a user action ON the
    // trail, not an entry in it, so it dirties (contrast `CleanReason::AuditTrail`).
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut log = state.audit_log.write(&effect).map_err(|e| e.to_string())?;
    log.enabled = enabled;
    log.max_entries = max_entries;
    Ok(())
}

/// Discard all audit log entries.
#[tauri::command]
pub fn calp_clear_audit_log(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Discarding the persisted transparency trail: without this, close-without-saving
    // silently brings every cleared entry back.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut log = state.audit_log.write(&effect).map_err(|e| e.to_string())?;
    log.clear();
    Ok(())
}

// ============================================================================
// Phase 9: Writeback Readiness
// ============================================================================

/// Return the flat list of writeback regions for frontend guard evaluation.
#[tauri::command]
pub fn calp_get_writeback_regions(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<calp::WritebackRegionEntry>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let index = state.writeback_index.lock().map_err(|e| e.to_string())?;
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    let id_to_index: std::collections::HashMap<identity::SheetId, usize> = sheet_ids
        .iter()
        .enumerate()
        .map(|(i, &sid)| (sid, i))
        .collect();
    let mut entries = index.to_flat_list(&id_to_index);

    // Enrich each entry with its declaration's value type / required / deadline,
    // so the client commit guard can coerce typed input and the UI can show a
    // deadline countdown. The flat index carries no schema; the declarations do.
    if let Ok(decls) = state.writeback_declarations.lock() {
        for e in entries.iter_mut() {
            if let Some(decl) = decls.iter().find(|d| d.id == e.region_id) {
                if let Some(schema) = &decl.schema {
                    e.value_type = Some(match schema.value_type {
                        calp::writeback::ValueType::Number => "number",
                        calp::writeback::ValueType::Integer => "integer",
                        calp::writeback::ValueType::Text => "text",
                        calp::writeback::ValueType::Date => "date",
                        calp::writeback::ValueType::Boolean => "boolean",
                        calp::writeback::ValueType::Enum => "enum",
                    }.to_string());
                    e.required = Some(schema.required);
                    // Custom validator name rides the schema's forward-compat
                    // `extra` map (author writes `customValidator`), surfaced so
                    // the subscriber client can run it as an advisory check.
                    e.custom_validator = schema
                        .extra
                        .get("customValidator")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
                if let Some(calp::writeback::LifecyclePolicy::UntilDeadline { deadline: Some(dl) }) =
                    &decl.lifecycle
                {
                    e.deadline = Some(dl.clone());
                }
            }
        }
    }
    Ok(entries)
}

/// Why one subscription's writeback regions are NOT installed.
///
/// Without this, "no regions" and "regions unknown" were the same observable
/// state: an unreachable workspace, an unreadable pin store and an application that
/// genuinely declares no writeback all produced an empty index, so a subscriber
/// whose form protections were silently INACTIVE saw exactly what a subscriber
/// with no form sees.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackRebuildSkip {
    pub package_name: String,
    pub registry_url: String,
    /// One of: `unreachable`, `notPinned`, `publisherChanged`, `badManifest`,
    /// `appTooOld`, `deferred`, `unknown`.
    pub reason: String,
    /// The underlying error text, for the pane's tooltip / details line.
    pub detail: String,
}

/// Classify a manifest-load failure into a skip `reason` string.
///
/// Shared by both on-open workspace walks — [`WritebackRebuildSkip`] and
/// [`ApplicationConnectionRestoreSkip`] — because the question ("why could this
/// subscription's signed manifest not be loaded?") and the answer vocabulary
/// are the same one. One classifier means the Subscriptions pane cannot report
/// the same workspace failure two different ways.
fn calp_skip_reason(err: &calp::error::CalpError) -> &'static str {
    use calp::error::CalpError as E;
    match err {
        E::Io(_) | E::Workspace(_) | E::ApplicationNotFound(_) | E::VersionNotFound { .. } => {
            "unreachable"
        }
        E::PublisherNotPinned { .. } => "notPinned",
        E::PublisherKeyChanged { .. }
        | E::PublisherNameConflict { .. }
        | E::ManifestSignatureInvalid { .. }
        | E::MissingSignature { .. } => "publisherChanged",
        E::Json(_)
        | E::Format(_)
        | E::ChecksumMismatch { .. }
        | E::MissingArtifact { .. }
        | E::UnlistedArtifact { .. }
        | E::MissingChecksums { .. } => "badManifest",
        E::AppTooOld { .. } => "appTooOld",
        _ => "unknown",
    }
}

/// Monotonic id of the newest writeback-index rebuild REQUEST.
///
/// Exists because the deferred (HTTP) half of a rebuild finishes on a worker
/// thread, and by then the user may have opened a DIFFERENT workbook. Installing
/// a set of region declarations that belongs to a document which is no longer
/// open is the same class of defect as inheriting the previous workbook's
/// `subscriptions.json` (persistence.rs) — one workbook's distribution state
/// governing another's cells. Every rebuild request takes a ticket here; a
/// worker installs only if its ticket is still the newest.
static WRITEBACK_REBUILD_SEQ: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn next_writeback_rebuild_seq() -> u64 {
    WRITEBACK_REBUILD_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

/// Rebuild the writeback index from the version manifests of all active
/// subscriptions. Each subscription's manifest is read from its own stored
/// workspace URL. Called after pull and refresh — both of which need the new
/// declarations to have landed before they return (refresh diffs old against
/// new to invalidate drafts), so this walks EVERY workspace synchronously.
///
/// Workbook OPEN uses [`rebuild_writeback_index_deferring_http`] instead.
pub(crate) fn rebuild_writeback_index(state: &AppState) {
    let seq = next_writeback_rebuild_seq();
    rebuild_writeback_index_inner(state, true, seq);
}

/// What one pass of [`rebuild_writeback_index_inner`] did.
struct RebuildOutcome {
    /// Whether this pass actually installed its result. False means it was
    /// SUPERSEDED — a newer rebuild request claimed the index while this walk
    /// was in flight — and nothing was written.
    installed: bool,
    /// Whether at least one HTTP subscription was skipped for a later pass.
    deferred_http: bool,
}

/// The WORKBOOK-OPEN variant: local (`file://`) workspaces are walked inline,
/// HTTP workspaces are handed to a worker thread and installed when they land.
///
/// `open_file` called the synchronous rebuild directly, and each HTTP
/// subscription costs two blocking artifact reads with a 30-second timeout — so
/// opening a `.cala` that named an unreachable HTTP workspace hung the whole app
/// on the open, before a single cell was drawn, with no way to cancel. Local
/// workspaces stay inline because they cost microseconds and because the
/// writeback guards must be armed before the user can type.
pub(crate) fn rebuild_writeback_index_deferring_http(state: &AppState) {
    let seq = next_writeback_rebuild_seq();
    if !rebuild_writeback_index_inner(state, false, seq).deferred_http {
        return;
    }
    let Some(app) = crate::bi::writeback_source::app_handle() else {
        // No worker available (headless/unit-test): the HTTP half would be lost
        // entirely, so do it inline rather than silently disarming the guards.
        rebuild_writeback_index_inner(state, true, seq);
        return;
    };
    // A plain OS thread: the workspace transports use `reqwest::blocking`, which
    // must not park an async-runtime worker for the full timeout.
    std::thread::spawn(move || {
        use tauri::{Emitter, Manager};
        let state = app.state::<AppState>();
        if !rebuild_writeback_index_inner(&state, true, seq).installed {
            // Superseded: a newer rebuild (another workbook was opened, or a
            // pull/refresh ran) claimed the index while this walk was in
            // flight. Installing now would put THIS workbook's regions on THAT
            // workbook's cells. Nothing was written; say nothing.
            return;
        }
        // The index drives cell tints, the write guards and GATHER geometry.
        // "grid:refresh" is already bridged to the window event in
        // shell/bootstrap.ts; the second event is for the Subscriptions /
        // Writeback panes.
        let _ = app.emit("grid:refresh", ());
        let _ = app.emit("distribution:writeback-index-changed", ());
    });
}

/// The shared walk.
///
/// `include_http = false` skips HTTP workspaces and records them as `deferred`.
/// `seq` is the ticket taken by the rebuild REQUEST this pass belongs to: if a
/// newer request has been made by the time the walk finishes, this pass installs
/// NOTHING (see [`WRITEBACK_REBUILD_SEQ`]).
fn rebuild_writeback_index_inner(
    state: &AppState,
    include_http: bool,
    seq: u64,
) -> RebuildOutcome {
    // The index changes on pull/refresh/open/detach — the cached GATHER map
    // is built from the same declarations and must go with it.
    invalidate_gather_cache(state);

    // CLONED, not held: the walk below is workspace I/O (seconds, over HTTP), and
    // holding the subscriptions lock across it blocks every reader of the list.
    let subscriptions = match state.subscriptions.read() {
        Ok(s) => s.subscriptions.clone(),
        Err(_) => {
            return RebuildOutcome {
                installed: false,
                deferred_http: false,
            }
        }
    };

    let mut all_decls = Vec::new();
    let mut all_model_decls: Vec<calp::ModelWritebackDeclaration> = Vec::new();
    let mut skips: Vec<WritebackRebuildSkip> = Vec::new();
    let mut deferred_any = false;

    for sub in &subscriptions {
        // Skip dev subscriptions (no workspace, so no writeback tree)
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }
        let registry_path = subscription_registry_path(sub);
        if !include_http && crate::calp_registry::is_http_location(registry_path) {
            deferred_any = true;
            skips.push(WritebackRebuildSkip {
                package_name: sub.package_name.clone(),
                registry_url: registry_path.to_string(),
                reason: "deferred".to_string(),
                detail: "loading in the background".to_string(),
            });
            continue;
        }
        let (registry, scope) = match crate::calp_registry::open_workspace_scoped(registry_path) {
            Ok(r) => r,
            Err(e) => {
                crate::log_warn!(
                    "CALP",
                    "writeback rebuild: {} skipped ({}): {}",
                    sub.package_name,
                    calp_skip_reason(&e),
                    e
                );
                skips.push(WritebackRebuildSkip {
                    package_name: sub.package_name.clone(),
                    registry_url: registry_path.to_string(),
                    reason: calp_skip_reason(&e).to_string(),
                    detail: e.to_string(),
                });
                continue;
            }
        };
        // Trust-bearing read: these region declarations drive GATHER cell
        // geometry AND schema validation, and rebuild runs on plain workbook
        // OPEN (no pull() in the path), so an HTTP subscription would otherwise
        // re-install regions from an unsigned manifest a hostile server fully
        // controls (moving/expanding selectors to remap which cells GATHER
        // reads/writes). Verify the Ed25519 signature over the single trusted
        // manifest copy; on failure, skip (never install unsigned decls).
        //
        // REQUIRES AN EXISTING PIN. This was the highest-severity pin site in
        // the whole distribution stack: opening a `.cala` -- a file that arrives
        // by email -- walked the subscription list the FILE names and pinned a
        // publisher key for every (application, workspace) pair in it, with no user
        // gesture whatsoever. A crafted workbook naming `acme.finance` at an
        // attacker-controlled workspace squatted the pin before the victim had
        // ever heard of the real application, and the genuine publisher's first
        // release then read as `publisherChanged`. Now an unpinned subscription
        // is skipped -- its regions stay inert until the user subscribes here
        // themselves. `calp_subscription_trust` surfaces exactly that state to
        // the Subscriptions pane so it is visible rather than merely silent.
        match calp::integrity::load_pinned_manifest_via(
            registry.as_ref(), &sub.package_name, &sub.resolved_version, &scope, &calcula_profile_dir(),
        ) {
            Ok(ver_manifest) => {
                if let Some(ref wb_regions) = ver_manifest.writeback_regions {
                    all_decls.extend(wb_regions.iter().cloned());
                }
                // Same trust rule for MODEL writeback columns: only a
                // signature-verified manifest may declare one. Mirrored here so
                // refresh can diff the pre/post sets without re-walking every
                // subscription's workspace.
                if let Some(ref model_wbs) = ver_manifest.model_writebacks {
                    all_model_decls.extend(model_wbs.iter().cloned());
                }
            }
            // NOT silent. An unreachable workspace, an unreadable pin store and an
            // application that was never pinned all used to produce the same empty
            // index as an application with no writeback at all — so a subscriber
            // whose form protections were INACTIVE could not tell.
            Err(e) => {
                crate::log_warn!(
                    "CALP",
                    "writeback rebuild: {}@{} skipped ({}): {}",
                    sub.package_name,
                    sub.resolved_version,
                    calp_skip_reason(&e),
                    e
                );
                skips.push(WritebackRebuildSkip {
                    package_name: sub.package_name.clone(),
                    registry_url: registry_path.to_string(),
                    reason: calp_skip_reason(&e).to_string(),
                    detail: e.to_string(),
                });
            }
        }
    }

    // SUPERSESSION CHECK, immediately before the first write. A newer rebuild
    // request (another workbook was opened, or a pull/refresh ran) means this
    // walk describes a document that is no longer the one on screen — installing
    // it would put one workbook's writeback regions on another's cells.
    if WRITEBACK_REBUILD_SEQ.load(std::sync::atomic::Ordering::SeqCst) != seq {
        crate::log_warn!(
            "CALP",
            "writeback rebuild #{} superseded before install; nothing written",
            seq
        );
        return RebuildOutcome {
            installed: false,
            deferred_http: deferred_any,
        };
    }

    let new_index = match calp::WritebackIndex::from_declarations(&all_decls) {
        Ok(idx) => idx,
        Err(e) => {
            crate::log_warn!("CALP", "Failed to build writeback index: {}", e);
            calp::WritebackIndex::default()
        }
    };

    if let Ok(mut idx) = state.writeback_index.lock() {
        *idx = new_index;
    }

    // Also store the full declarations for schema validation
    if let Ok(mut decls) = state.writeback_declarations.lock() {
        *decls = all_decls;
    }
    if let Ok(mut decls) = state.model_writeback_declarations.lock() {
        *decls = all_model_decls;
    }
    if let Ok(mut s) = state.writeback_rebuild_skips.lock() {
        *s = skips;
    }

    RebuildOutcome {
        installed: true,
        deferred_http: deferred_any,
    }
}

/// Every subscription whose writeback regions could NOT be installed by the
/// last rebuild, and why. Empty means every subscription's regions are live.
///
/// The Subscriptions / Writeback panes need this to distinguish "this application
/// declares no writeback" from "this application's writeback regions are UNKNOWN, so
/// its protections are not in force".
#[tauri::command]
pub fn calp_get_writeback_rebuild_skips(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<WritebackRebuildSkip>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    state
        .writeback_rebuild_skips
        .lock()
        .map(|s| s.clone())
        .map_err(|e| e.to_string())
}

// ============================================================================
// Phase 12: Author UI — Writeback Region Designation
// ============================================================================

/// Resolve the stable SheetId for a workbook sheet index.
/// Used by the frontend to build region selectors for the active sheet
/// (e.g., when designating a writeback region from the current selection).
#[tauri::command]
pub fn calp_get_sheet_id(
    state: State<AppState>,
    sheet_index: usize,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    sheet_ids
        .get(sheet_index)
        .map(|id| id.to_string())
        .ok_or_else(|| format!("No sheet at index {}", sheet_index))
}

/// Get all draft writeback regions for the current workbook.
#[tauri::command]
pub fn calp_get_writeback_draft_regions(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<calp::WritebackRegionDeclaration>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let drafts = state.writeback_draft_regions.read().map_err(|e| e.to_string())?;
    Ok(drafts.clone())
}

// Draft writeback regions live in the .cala
// (`user_files/writeback_draft_regions.json`) and are written only by the save
// path, so a region designated on an otherwise-clean document was silently
// discarded at close. Now shared with the protection commands, which had the
// same gap — see `document_effect::DocumentEffect::mutates`.

/// Add a new draft writeback region.
#[tauri::command]
pub fn calp_add_writeback_region(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    region: calp::WritebackRegionDeclaration,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Validate the region
    let test_decls = vec![region.clone()];
    calp::WritebackIndex::from_declarations(&test_decls)
        .map_err(|e| format!("Invalid region: {}", e))?;

    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut drafts = state.writeback_draft_regions.write(&effect).map_err(|e| e.to_string())?;

    // Check for ID collision
    if drafts.iter().any(|r| r.id == region.id) {
        return Err(format!("Region with ID '{}' already exists", region.id));
    }

    // Check for overlap with existing draft regions
    let mut all = drafts.clone();
    all.push(region.clone());
    calp::WritebackIndex::from_declarations(&all)
        .map_err(|e| format!("Region overlaps with existing draft: {}", e))?;

    drafts.push(region);
    let _ = crate::document_effect::DocumentEffect::mutates(&file_state);
    Ok(())
}

/// Remove a draft writeback region by ID.
#[tauri::command]
pub fn calp_remove_writeback_region(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    region_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut drafts = state.writeback_draft_regions.write(&effect).map_err(|e| e.to_string())?;
    let len_before = drafts.len();
    drafts.retain(|r| r.id != region_id);
    let removed = drafts.len() < len_before;
    if removed {
        let _ = crate::document_effect::DocumentEffect::mutates(&file_state);
    }
    Ok(removed)
}

/// Update an existing draft writeback region (replace by ID).
///
/// The STORED selector always wins. Editing a region changes its policy/schema
/// fields only — the UI says so outright ("range can't be changed — remove &
/// re-designate to move it") and posts the region back verbatim, so the
/// incoming selector is an echo of whatever the client last read, not an
/// intent to move anything.
///
/// Honoring that echo would be a live data-integrity bug: structural edits
/// re-anchor draft selectors in the backend (see `shift_writeback_draft_regions`)
/// without the pane re-reading them, so a pane held open across an inserted
/// column would post a pre-shift rectangle and silently undo the re-anchoring —
/// re-pointing the collection surface at exactly the cells the shift avoided.
#[tauri::command]
pub fn calp_update_writeback_region(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    region: calp::WritebackRegionDeclaration,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut drafts = state.writeback_draft_regions.write(&effect).map_err(|e| e.to_string())?;

    let pos = drafts.iter().position(|r| r.id == region.id)
        .ok_or_else(|| format!("Region '{}' not found", region.id))?;

    let mut updated = region;
    updated.selector = drafts[pos].selector.clone();

    // Validate: build index with the updated region replacing the old one
    let mut test = drafts.clone();
    test[pos] = updated.clone();
    calp::WritebackIndex::from_declarations(&test)
        .map_err(|e| format!("Invalid update: {}", e))?;

    drafts[pos] = updated;
    let _ = crate::document_effect::DocumentEffect::mutates(&file_state);
    Ok(())
}

// ============================================================================
// Phase 14: Writeback Submission
// ============================================================================

/// Get the cached subscriber identity, loading/creating it on first use.
pub(crate) fn get_subscriber_identity(state: &AppState) -> Result<calp::SubmitterIdentity, String> {
    {
        let cached = state.subscriber_identity.lock().map_err(|e| e.to_string())?;
        if let Some(ref id) = *cached {
            return Ok(id.clone());
        }
    }
    let profile_dir = calcula_profile_dir();
    let id = calp::identity_provider::load_or_create(&profile_dir)?;
    let mut cached = state.subscriber_identity.lock().map_err(|e| e.to_string())?;
    *cached = Some(id.clone());
    Ok(id)
}

/// Resolve the subscription that declares the given writeback region.
/// Returns (package_name, resolved_version, registry_path). This is what
/// makes multi-subscription workbooks submit to the right application — the
/// region id is looked up in each subscription's version manifest.
/// Which subscription owns a writeback region, and everything a submission or
/// a read of one needs to be correct.
///
/// A STRUCT, not a tuple. It grew a fourth member — the environment — and three
/// `String`s followed by an `Option<String>` is exactly the shape where a
/// transposed argument compiles and is wrong forever after. The environment is
/// the one that decides whether a tester's number reaches a production total,
/// so it does not travel by position.
pub(crate) struct OwningSubscription {
    pub package_name: String,
    pub resolved_version: String,
    pub registry_path: String,
    /// The environment this subscription follows, `""` for the development
    /// line. This IS the submission's tag and the filter every reader applies.
    pub environment: String,
}

fn owning_subscription_for_region(
    state: &AppState,
    region_id: &str,
) -> Result<OwningSubscription, String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    for sub in &subs.subscriptions {
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }
        let registry_path = subscription_registry_path(sub).to_string();
        let Ok((registry, scope)) =
            crate::calp_registry::open_workspace_scoped(&registry_path)
        else {
            continue;
        };
        // Verify before believing a subscription's claim to own this region —
        // the authoritative submit re-validates too, but locating the target
        // workspace from an unsigned manifest would let a hostile workspace claim
        // regions it does not legitimately declare.
        //
        // ALREADY-TRUSTED: submitting to a region means acting on an application the
        // user subscribed to. `load_pinned_manifest_via` returns the manifest
        // ALONE -- under RequirePinned the only possible success is Verified, so
        // unlike the previous `let Ok((_, manifest))` there is no trust answer
        // being silently thrown away. An unpinned application owns no region here.
        let Ok(manifest) = calp::integrity::load_pinned_manifest_via(
            registry.as_ref(), &sub.package_name, &sub.resolved_version, &scope, &calcula_profile_dir(),
        )
        else {
            continue;
        };
        if let Some(ref regions) = manifest.writeback_regions {
            if regions.iter().any(|r| r.id == region_id) {
                return Ok(OwningSubscription {
                    package_name: sub.package_name.clone(),
                    resolved_version: sub.resolved_version.clone(),
                    registry_path,
                    environment: sub.environment.clone().unwrap_or_default(),
                });
            }
        }
    }
    Err(format!(
        "No subscription declares writeback region '{}'",
        region_id
    ))
}

/// Versions of an application strictly OLDER than `resolved_version` (semver
/// order). Used for lenient carry-forward — a subscriber pinned behind must
/// not see submissions made against newer versions.
pub(crate) fn older_package_versions(
    registry: &dyn calp::WorkspaceTransport,
    package_name: &str,
    resolved_version: &str,
) -> Vec<String> {
    let resolved = match calp::SemVer::parse(resolved_version) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    registry
        .get_application_manifest(package_name)
        .map(|m| {
            m.versions
                .iter()
                .map(|v| v.version.clone())
                .filter(|v| calp::SemVer::parse(v).map(|c| c < resolved).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default()
}

/// The versions a reader may carry submissions forward from, and the environment
/// tag it may accept.
///
/// FOR AN ENVIRONMENT, "older" IS NOT "lower semver". An environment's history
/// is whatever it has actually held, and a rollback makes the current pointer
/// LOWER than a version it ran last week. Under the plain semver rule the
/// subscriber's own submissions against that newer version stop counting the
/// moment their environment is rolled back — their numbers vanish from the
/// collection and re-appear if it is rolled forward again. So an environment
/// subscription carries forward over its own promotion history instead.
///
/// A LINE subscription keeps the semver rule, which is what it always had.
pub(crate) fn carry_forward_versions(
    registry: &dyn calp::WorkspaceTransport,
    package_name: &str,
    resolved_version: &str,
    environment: &str,
) -> Vec<String> {
    if environment.is_empty() {
        return older_package_versions(registry, package_name, resolved_version);
    }
    match calp::environments::versions_held_by(registry, package_name, environment) {
        Ok(held) => held
            .into_iter()
            .filter(|v| v != resolved_version)
            .collect::<Vec<_>>(),
        // A log that does not verify carries nothing forward rather than
        // falling back to the semver rule: the fallback would quietly mix in
        // versions this environment never ran, which is the defect the tag
        // exists to prevent.
        Err(_) => Vec::new(),
    }
}

/// Whether the workspace already holds a Submitted/Approved record for this
/// slot from the current subscriber, in the resolved version or any older
/// one. One-shot/locked lifecycle policies must consult this: the local
/// writeback layer is volatile (reset when the workbook is reopened without
/// saving), so it alone cannot enforce "submit once".
fn registry_has_own_submission(state: &AppState, region_id: &str, row: u32, col: u32) -> bool {
    let Ok(owner) = owning_subscription_for_region(state, region_id) else {
        return false;
    };
    let OwningSubscription { package_name, resolved_version, registry_path, environment } = owner;
    let Ok(own) = get_subscriber_identity(state) else {
        return false;
    };
    let Ok((registry, _scope)) =
        crate::calp_registry::open_workspace_scoped(&registry_path)
    else {
        return false;
    };
    let mut versions = vec![resolved_version.clone()];
    versions.extend(carry_forward_versions(
        &registry,
        &package_name,
        &resolved_version,
        &environment,
    ));
    versions.into_iter().any(|version| {
        registry
            .load_current_submissions_by(&package_name, &version, &own.id)
            // A one-shot region must not be re-armed by a promotion, nor
            // considered spent because the SAME person answered it in a
            // different environment. Both are the same filter.
            .map(|subs| calp::writeback::visible_in(subs, Some(&environment)))
            .map(|subs| {
                subs.iter().any(|s| {
                    s.region_id == region_id
                        && s.cell_row == row
                        && s.cell_col == col
                        && matches!(
                            s.state,
                            calp::writeback::SubmissionState::Submitted
                                | calp::writeback::SubmissionState::Approved
                        )
                })
            })
            .unwrap_or(false)
    })
}

/// Drop the cached GATHER map after anything that changes submission data.
/// The same events make the BI writeback dataset tables stale, so this also
/// queues their (async, fire-and-forget) re-provision — one hook covers every
/// mutation path: submit, clear, approve/reject, pull, refresh, open, detach.
///
/// DROPS rather than marks stale: an invalidation means the cached map is known
/// to be untrue (a region was detached, a submission was withdrawn), and serving
/// a value the user just deleted is worse than serving none. The rebuild is
/// queued here rather than performed inline — see `build_gather_data` for why
/// nothing on this path may block on workspace I/O.
pub(crate) fn invalidate_gather_cache(state: &AppState) {
    crate::bi::writeback_source::invalidate_writeback_bi();
    if let Ok(mut cache) = state.gather_cache.lock() {
        *cache = None;
    }
    queue_gather_refresh();
}

/// True when the given deadline (ISO 8601, or datetime-local "YYYY-MM-DDTHH:MM")
/// has passed relative to `now` (RFC 3339).
fn deadline_passed(deadline: &str, now: &str) -> bool {
    use chrono::{DateTime, NaiveDateTime, Utc};
    let now_parsed = DateTime::parse_from_rfc3339(now).map(|d| d.with_timezone(&Utc));
    let deadline_parsed = DateTime::parse_from_rfc3339(deadline)
        .map(|d| d.with_timezone(&Utc))
        .or_else(|_| {
            NaiveDateTime::parse_from_str(deadline, "%Y-%m-%dT%H:%M").map(|n| n.and_utc())
        });
    match (now_parsed, deadline_parsed) {
        (Ok(n), Ok(d)) => n >= d,
        // Unparseable deadline: fall back to lexicographic comparison, which
        // is correct for identically-formatted UTC timestamps.
        _ => now >= deadline,
    }
}

/// Enforce a region's lifecycle policy for a new draft/submission.
/// `already_submitted` says whether this submitter already has a submitted
/// value for the cell in question.
fn check_lifecycle_policy(
    decl: &calp::WritebackRegionDeclaration,
    already_submitted: bool,
    now: &str,
) -> Result<(), String> {
    use calp::writeback::LifecyclePolicy;
    match &decl.lifecycle {
        None | Some(LifecyclePolicy::Always) => Ok(()),
        Some(LifecyclePolicy::UntilDeadline { deadline }) => {
            if let Some(deadline) = deadline {
                if deadline_passed(deadline, now) {
                    return Err(format!(
                        "The submission deadline for this region has passed ({}).",
                        deadline
                    ));
                }
            }
            Ok(())
        }
        Some(LifecyclePolicy::Never) => {
            if already_submitted {
                Err("This region is one-shot: the value was already submitted and cannot be changed. Ask the publisher to reject it if you need to revise.".to_string())
            } else {
                Ok(())
            }
        }
        Some(LifecyclePolicy::RequiresUnlock) => {
            if already_submitted {
                Err("This value was submitted and is locked. Ask the publisher to unlock it (publisher unlock is not yet supported).".to_string())
            } else {
                Ok(())
            }
        }
    }
}

/// Save a writeback draft for a cell in a writeback region.
/// Auto-mints a CellId if the cell doesn't have one yet.
/// Enforces the region's schema and lifecycle policy; regions with the
/// `immediate` submission policy are auto-submitted to the workspace on save.
#[tauri::command]
pub fn calp_save_writeback_draft(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    region_id: String,
    sheet_id: String,
    row: u32,
    col: u32,
    value: calp::writeback::SubmissionValue,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;

    // Verify the cell is in a writeback region — and in the CLAIMED region:
    // schema/lifecycle enforcement below resolves the declaration from the
    // caller-supplied id, so a mismatched id would validate against the wrong
    // declaration (or none at all, silently skipping enforcement).
    {
        let wb_index = state.writeback_index.lock().map_err(|e| e.to_string())?;
        match wb_index.region_id_at(sid, row, col) {
            Some(actual) if actual == region_id => {}
            Some(actual) => {
                return Err(format!(
                    "Cell ({}, {}) belongs to writeback region '{}', not '{}'",
                    row, col, actual, region_id
                ));
            }
            None => {
                return Err(format!("Cell ({}, {}) is not in a writeback region", row, col));
            }
        }
    }

    let now = chrono::Utc::now().to_rfc3339();

    // Look up the region declaration once for schema + policy enforcement.
    let decl = {
        let decls = state.writeback_declarations.lock().map_err(|e| e.to_string())?;
        decls.iter().find(|d| d.id == region_id).cloned()
    };

    if let Some(ref decl) = decl {
        // Validate value against the region's schema (if one is defined)
        if let Some(ref schema) = decl.schema {
            schema.validate(&value).map_err(|msg| {
                format!("Schema validation failed: {}", msg)
            })?;
        }

        // Enforce the lifecycle policy (deadline / one-shot / locked)
        let already_submitted = {
            let wb_layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
            wb_layer.drafts.iter().any(|d| {
                d.region_id == region_id
                    && d.cell_row == row
                    && d.cell_col == col
                    && matches!(
                        d.state,
                        calp::writeback::SubmissionState::Submitted
                            | calp::writeback::SubmissionState::Approved
                    )
            })
        };
        // One-shot/locked policies must also consult the authoritative
        // workspace record — the local layer alone is defeated by reopening
        // the workbook without saving.
        let already_submitted = already_submitted
            || (matches!(
                decl.lifecycle,
                Some(calp::writeback::LifecyclePolicy::Never)
                    | Some(calp::writeback::LifecyclePolicy::RequiresUnlock)
            ) && registry_has_own_submission(&state, &region_id, row, col));
        check_lifecycle_policy(decl, already_submitted, &now)?;

        // FAST FEEDBACK for a publisher-shipped custom validator: run it on the
        // single value being typed so a rejection reaches the user in the cell
        // they are editing (the frontend keeps them in edit mode and shows this
        // message), not minutes later at submit. This is a CONVENIENCE run, and
        // deliberately NOT fail-closed: a validator that is missing, not yet
        // consented or broken must never make the workbook un-typable — it only
        // has to make it un-SUBMITTABLE, which `submit_region_internal` enforces
        // from the signature-verified manifest. Only an actual REJECTION by a
        // consented validator stops the draft here.
        if let Some(schema) = decl.schema.as_ref() {
            if let Ok(Some(validator)) =
                declared_validator(Some(schema), "", "", &region_id)
            {
                if let Ok(OwningSubscription { package_name, resolved_version, .. }) =
                    owning_subscription_for_region(&state, &region_id)
                {
                    if validator_consented(window_app_handle(&window), &package_name, &validator) {
                        if let Some(scalar) = validator_scalar(&value) {
                            let inputs = vec![ValidatorInput { row, col, value: scalar }];
                            let context = validator_context(
                                &region_id,
                                Some(schema),
                                &package_name,
                                &resolved_version,
                            );
                            if let Ok(verdicts) = run_validator_batch(&validator, &inputs, &context)
                            {
                                if let Some(Some(message)) = verdicts.into_iter().next() {
                                    return Err(format!(
                                        "Rejected by '{}' (from {} v{}): {}",
                                        validator.name, package_name, resolved_version, message
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Get or mint a CellId for this cell
    let cell_id = {
        let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
        id_reg.cell_id_at(sid, (row, col)).to_string()
    };

    // Get subscriber identity
    let submitter = get_subscriber_identity(&state)?;
    let submission_id = {
        let bytes = identity::generate_uuid_v7();
        format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
        )
    };

    let submission = calp::writeback::WritebackSubmission {
        id: submission_id,
        region_id: region_id.clone(),
        // A DRAFT IS UNTAGGED, and stays that way. The tag is decided by what
        // the subscription follows at the moment the submission actually
        // reaches the workspace, and `submit_region_internal` stamps it there:
        // drafts persist in the .cala, so a workbook can easily hold one made
        // before the user switched environments. Stamping here would freeze the
        // wrong answer, and would also cost a workspace open on every keystroke.
        environment: String::new(),
        model_key: None,
        cell_row: row,
        cell_col: col,
        cell_id: Some(cell_id),
        submitter,
        value,
        state: calp::writeback::SubmissionState::Draft,
        created_at: now.clone(),
        updated_at: now,
        submitted_at: None,
        review_reason: None,
        reviewed_by: None,
        extra: std::collections::HashMap::new(),
    };

    let auto_submit = matches!(
        decl.as_ref().and_then(|d| d.submission_policy.clone()),
        Some(calp::writeback::SubmissionPolicy::Immediate)
    );

    // Contributor data entry: the draft is persisted in user_files/writeback_drafts.json.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    {
        let mut wb_layer = state.writeback_layer.write(&effect).map_err(|e| e.to_string())?;
        wb_layer.set_draft(submission);
    }

    // `immediate` regions go straight to the workspace — saving IS submitting.
    if auto_submit {
        submit_region_internal(&state, &effect, &region_id, window_app_handle(&window))?;
    }

    Ok(())
}

/// Get the writeback layer (all drafts) for the current workbook.
#[tauri::command]
pub fn calp_get_writeback_layer(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::writeback::WritebackLayer, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
    Ok(layer.clone())
}

/// Reconcile the local writeback layer's submission STATES from the workspace —
/// the return leg of the writeback loop (P0). After a subscriber submits, the
/// publisher may approve or reject the value in the workspace; without this the
/// local layer (which drives the WritebackPane and the grid cell styling) would
/// stay "submitted" forever and a rejected contributor would never be told.
///
/// For each locally-submitted (non-Draft) entry, adopt the state of the
/// subscriber's OWN current workspace record for that (region, cell) slot —
/// newest across the resolved version and older ones (lenient carry-forward).
/// Unsent drafts (Draft state) are left untouched.
/// Reconcile local submission states from the workspace.
///
/// TAKES `&FileState`, NOT A READY-MADE `DocumentEffect`, ON PURPOSE. This runs on
/// every workbook load (the Distribution extension calls `calp_reconcile_writeback`
/// during bootstrap), and `DocumentEffect::mutates` dirties AT CONSTRUCTION. Building
/// the effect up front therefore marked EVERY opened workbook as unsaved before the
/// user touched anything — the close prompt fired on a document that had merely been
/// looked at, which is precisely the "prompt stops meaning anything" failure the
/// `Navigation` and `AuditTrail` clean arms exist to prevent. So the effect is
/// constructed only once we know the workspace actually disagrees with what we hold.
fn reconcile_writeback_layer_internal(
    state: &AppState,
    file_state: &crate::persistence::FileState,
) -> Result<(), String> {
    // Which regions have a submitted entry whose status we should re-check?
    let region_ids: Vec<String> = {
        let layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
        let mut set = std::collections::BTreeSet::new();
        for d in &layer.drafts {
            if !matches!(d.state, calp::writeback::SubmissionState::Draft) {
                set.insert(d.region_id.clone());
            }
        }
        set.into_iter().collect()
    };
    if region_ids.is_empty() {
        return Ok(());
    }

    let own = get_subscriber_identity(state)?;

    // Build (region, row, col) -> current workspace record for our OWN slots.
    let mut by_slot: std::collections::HashMap<
        (String, u32, u32),
        calp::writeback::WritebackSubmission,
    > = std::collections::HashMap::new();
    for region_id in &region_ids {
        let Ok(OwningSubscription { package_name, resolved_version, registry_path, environment }) =
            owning_subscription_for_region(state, region_id)
        else {
            continue;
        };
        let Ok((registry, _scope)) =
            crate::calp_registry::open_workspace_scoped(&registry_path)
        else {
            continue;
        };
        // Newest version first: resolved, then older versions sorted descending.
        let mut older = older_package_versions(&registry, &package_name, &resolved_version);
        older.sort_by(|a, b| match (calp::SemVer::parse(b), calp::SemVer::parse(a)) {
            (Ok(bv), Ok(av)) => bv.cmp(&av),
            _ => b.cmp(a),
        });
        let mut versions = vec![resolved_version.clone()];
        versions.extend(older);

        let mut seen: std::collections::HashSet<(String, u32, u32)> =
            std::collections::HashSet::new();
        for version in &versions {
            let Ok(subs) = registry
                .load_current_submissions_by(&package_name, version, &own.id)
                // Adopting a state recorded against a different environment
                // would tell a contributor their prod entry was approved when
                // what was approved was their test one.
                .map(|subs| calp::writeback::visible_in(subs, Some(&environment)))
            else {
                continue;
            };
            for s in subs {
                if &s.region_id != region_id {
                    continue;
                }
                let key = (s.region_id.clone(), s.cell_row, s.cell_col);
                // First-seen wins => newest version's record is authoritative.
                if seen.insert(key.clone()) {
                    by_slot.insert(key, s);
                }
            }
        }
    }

    // Would adopting the workspace actually CHANGE anything? Decided before any
    // effect exists, so a reconcile that finds nothing new leaves the document
    // exactly as clean as it was.
    let has_changes = {
        let layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
        layer.drafts.iter().any(|d| {
            if matches!(d.state, calp::writeback::SubmissionState::Draft) {
                return false;
            }
            match by_slot.get(&(d.region_id.clone(), d.cell_row, d.cell_col)) {
                Some(reg) => {
                    d.state != reg.state
                        || d.review_reason != reg.review_reason
                        || d.reviewed_by != reg.reviewed_by
                }
                None => false,
            }
        })
    };
    if !has_changes {
        return Ok(());
    }

    // Adopt the workspace state + review feedback onto local non-Draft entries.
    {
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut layer = state.writeback_layer.write(&effect).map_err(|e| e.to_string())?;
        for d in layer.drafts.iter_mut() {
            if matches!(d.state, calp::writeback::SubmissionState::Draft) {
                continue;
            }
            if let Some(reg) = by_slot.get(&(d.region_id.clone(), d.cell_row, d.cell_col)) {
                d.state = reg.state.clone();
                d.review_reason = reg.review_reason.clone();
                d.reviewed_by = reg.reviewed_by.clone();
            }
        }
    }
    Ok(())
}

/// Reconcile local submission states from the workspace (approved/rejected
/// read-back) and return the updated writeback layer. This is what the
/// subscriber's UI calls to learn the fate of what they submitted.
#[tauri::command]
pub fn calp_reconcile_writeback(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    window: tauri::Window,
) -> Result<calp::writeback::WritebackLayer, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Reconciling only dirties when the workspace actually moved a submission on --
    // see `reconcile_writeback_layer_internal`; this runs on every workbook load.
    reconcile_writeback_layer_internal(&state, &file_state)?;
    let layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
    Ok(layer.clone())
}

// ============================================================================
// Custom writeback validators — publisher-shipped CODE, run authoritatively
// ============================================================================
//
// WHY THE AUTHORITATIVE RUN IS HERE AND NOT IN THE FRONTEND WORKER
// ----------------------------------------------------------------
// A validator that runs only in the client is not a validator, it is a
// suggestion. The client IS the caller of `calp_submit_region` (and of the
// `distribution.writeback` script gateway that fronts it), so any verdict it
// hands the backend — "I ran the validator, it passed" — is self-asserted by
// the exact party the gate exists to constrain. A script holding
// `distribution.writeback` can call `submitRegion` directly and simply never
// run the check, or claim a pass it never got. There is no construction that
// makes a caller-supplied verdict trustworthy, so none is accepted.
//
// The authoritative run therefore happens HERE, on the submit path, with three
// properties no caller can influence:
//
//  1. SOURCE OF TRUTH. The validator body is read from the SAME Ed25519 + TOFU
//     verified version manifest that already supplies the region's ValueSchema
//     (the `decl` resolution in `submit_region_internal`). Never from the
//     .cala, never from the caller, never from the frontend. A tampered
//     workbook or a hostile script cannot swap the body, and a publisher who
//     edits it publishes a new signed version.
//
//  2. SANDBOX. It executes in the embedded QuickJS interpreter — the same
//     isolated Rust realm the notebook / one-off / MCP script surfaces use, and
//     the same runtime limits (heap, JS stack, wall clock) — over an EMPTY
//     cloned grid, with the `Calcula`, `model`, `display` and `console` globals
//     removed before the publisher's code is reached. A validator is a pure
//     `(value, ctx) => true | string`: no capabilities, no host state, no I/O.
//     There is nothing to grant, therefore nothing to escalate. This is not a
//     second sandbox; it is the existing one, entered with everything unbound.
//
//  3. FAIL CLOSED. A declared validator that has no body, is not consented,
//     throws, exceeds its time budget, or returns anything other than
//     true/null/undefined/string REJECTS the submission. It never silently
//     passes. It also never blocks more than the submit of the one region that
//     declares it: the workbook stays open, other regions still submit, drafts
//     are still saved and editable, and the error names the application, the
//     version and the validator so the user knows exactly what to chase.
//
// CONSENT. Publisher code that runs on a subscriber's machine goes through the
// same door as every other distributed script: the shared consent store in the
// workbook (`.calcula/script-consent.json`, written by @api/distributedConsent),
// keyed by application AND by SHA-256 of the exact source. Changing the body changes
// the hash and re-prompts; an un-consented validator fails closed at submit.
// Validators are keyed under `<application>::writeback-validators` so granting them
// neither clobbers nor inherits the object-script consent record for the same
// application (two independent writers, one file).
//
// The frontend mirror in @api/writebackValidators.ts mounts the SAME source in
// the hardened worker realm for as-you-type feedback. That run is advisory by
// definition and is not consulted here.

/// Schema `extra` key holding the validator's stable name.
const VALIDATOR_NAME_KEY: &str = "customValidator";
/// Schema `extra` key holding the validator's JS body (a function expression).
const VALIDATOR_SOURCE_KEY: &str = "customValidatorSource";
/// The workbook-embedded distributed-script consent store.
const SCRIPT_CONSENT_FILE: &str = ".calcula/script-consent.json";

/// Consent-store application key for an application's writeback validators.
/// MUST match `writebackValidatorConsentKey` in @api/writebackValidators.ts.
fn validator_consent_key(package_name: &str) -> String {
    format!("{}::writeback-validators", package_name)
}

/// Consent-store script id for one validator.
/// MUST match `writebackValidatorScriptId` in @api/writebackValidators.ts.
fn validator_script_id(name: &str) -> String {
    format!("writeback-validator:{}", name)
}

/// A publisher-declared validator resolved from a verified manifest.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DeclaredValidator {
    pub name: String,
    pub source: String,
    pub source_hash: String,
}

/// Resolve the validator a region declares, if any.
///
/// `Ok(None)` = the region declares no validator (the overwhelmingly common
/// case; nothing changes for it). `Ok(Some(_))` = a name AND a body are
/// present. `Err(_)` = the region declares a validator NAME with no usable
/// BODY — the "wishful metadata" case this whole gate exists to kill. That is a
/// hard failure on submit, not a skip: a publisher who says "validate this" and
/// a subscriber whose client silently ignores it is precisely the credibility
/// hole that makes distributed writeback no better than emailing a sheet.
pub(crate) fn declared_validator(
    schema: Option<&calp::writeback::ValueSchema>,
    package_name: &str,
    resolved_version: &str,
    region_id: &str,
) -> Result<Option<DeclaredValidator>, String> {
    let Some(schema) = schema else { return Ok(None) };
    let name = schema
        .extra
        .get(VALIDATOR_NAME_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let Some(name) = name else { return Ok(None) };
    let source = schema
        .extra
        .get(VALIDATOR_SOURCE_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let Some(source) = source else {
        return Err(format!(
            "Cannot submit to region '{}': {} v{} declares the custom validator \
             '{}' but ships no validator code for it, so the check the publisher \
             asked for cannot be performed. Ask the publisher to republish the \
             package with the validator body included.",
            region_id, package_name, resolved_version, name
        ));
    };
    Ok(Some(DeclaredValidator {
        name: name.to_string(),
        source: source.to_string(),
        source_hash: calp::integrity::sha256_hex(source.as_bytes()),
    }))
}

/// Whether a parsed consent file grants `script_id`/`source_hash` under
/// `package_key`. Pure (takes the parsed JSON) so it is unit-testable without a
/// workbook. An absent/malformed file grants nothing.
pub(crate) fn consent_granted_in(
    consent_file: &serde_json::Value,
    package_key: &str,
    script_id: &str,
    source_hash: &str,
) -> bool {
    let Some(consents) = consent_file.get("consents").and_then(|c| c.as_array()) else {
        return false;
    };
    consents.iter().any(|record| {
        record.get("packageName").and_then(|v| v.as_str()) == Some(package_key)
            && record
                .get("scripts")
                .and_then(|s| s.as_array())
                .map(|scripts| {
                    scripts.iter().any(|s| {
                        s.get("id").and_then(|v| v.as_str()) == Some(script_id)
                            && s.get("sourceHash").and_then(|v| v.as_str()) == Some(source_hash)
                    })
                })
                .unwrap_or(false)
    })
}

/// Whether a parsed consent file carries ANY approval under `package_key`.
///
/// The question a MOUNT can answer when the realm's source was COMPOSED by the
/// host — a generated import prelude plus merged bodies — and therefore hashes
/// to something no stored artifact has ever matched. Deliberately weaker than
/// {@link consent_granted_in}, and used only as the floor in
/// `distributed_mount_refusal` (app/src-tauri/src/scripting/commands.rs), never
/// as a substitute for it: where a mount CAN name its artifact, that gate goes
/// on to require `consent_granted_in` for it.
///
/// A record with an EMPTY script list is not an approval: it names an
/// application without approving any of its code.
pub(crate) fn consent_record_exists_in(
    consent_file: &serde_json::Value,
    package_key: &str,
) -> bool {
    let Some(consents) = consent_file.get("consents").and_then(|c| c.as_array()) else {
        return false;
    };
    consents.iter().any(|record| {
        record.get("packageName").and_then(|v| v.as_str()) == Some(package_key)
            && record
                .get("scripts")
                .and_then(|s| s.as_array())
                .map(|scripts| !scripts.is_empty())
                .unwrap_or(false)
    })
}

/// The AppHandle behind a command's Window, without pulling `tauri::Manager`
/// into this module's top-level import set. Needed because the validator gate
/// reads the workbook's consent store (a `UserFilesState`) from paths whose
/// only handle on the app is the window.
fn window_app_handle(window: &tauri::Window) -> &tauri::AppHandle {
    use tauri::Manager;
    Manager::app_handle(window)
}

/// Read the workbook's distributed-script consent store. `None` when the
/// workbook carries no consent file or it is not parseable JSON.
pub(crate) fn read_script_consent_file(app: &tauri::AppHandle) -> Option<serde_json::Value> {
    use tauri::Manager;
    let user_files = app.state::<crate::persistence::UserFilesState>();
    let files = user_files.files.lock().ok()?;
    let bytes = files.get(SCRIPT_CONSENT_FILE)?;
    serde_json::from_slice::<serde_json::Value>(bytes).ok()
}

/// Whether the user has consented to run this exact validator body for this
/// application. Fails closed on every uncertainty (no file, no record, hash drift).
fn validator_consented(
    app: &tauri::AppHandle,
    package_name: &str,
    validator: &DeclaredValidator,
) -> bool {
    let Some(file) = read_script_consent_file(app) else { return false };
    consent_granted_in(
        &file,
        &validator_consent_key(package_name),
        &validator_script_id(&validator.name),
        &validator.source_hash,
    )
}

/// One value handed to the validator, with the cell it came from.
#[derive(Debug, Clone)]
pub(crate) struct ValidatorInput {
    pub row: u32,
    pub col: u32,
    pub value: serde_json::Value,
}

/// Unwrap a SubmissionValue into the plain JSON scalar a validator sees.
/// `Empty` yields `None` — an empty cell is the `required` gate's business, not
/// the validator's, which keeps the Rust verdict aligned with the frontend
/// advisory run (which also skips blanks).
fn validator_scalar(value: &calp::writeback::SubmissionValue) -> Option<serde_json::Value> {
    use calp::writeback::SubmissionValue;
    match value {
        SubmissionValue::Number { value } => Some(serde_json::json!(value)),
        SubmissionValue::Text { value } => Some(serde_json::json!(value)),
        SubmissionValue::Boolean { value } => Some(serde_json::json!(value)),
        SubmissionValue::Empty => None,
    }
}

/// Wall-clock budget for one validator batch. Deliberately far below the
/// one-off script budget: a validator is a pure predicate over a handful of
/// scalars, and this runs synchronously inside the submit command, so a
/// runaway body must surface as a fast, clear failure rather than a hang.
const VALIDATOR_TIMEOUT_MS: u64 = 2_000;

/// Escape a JSON literal for safe embedding in JS source. `serde_json` already
/// produces a valid JS expression except for U+2028/U+2029, which are string
/// terminators in JS but legal raw inside a JSON string.
fn json_for_js(value: &serde_json::Value) -> String {
    value
        .to_string()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Run one validator over a batch of values in the embedded QuickJS realm.
///
/// Returns one entry per input, in order: `None` = accepted, `Some(message)` =
/// rejected with the publisher's message. `Err(_)` means the validator could
/// not be run to a verdict at all (bad source, thrown at load, timeout,
/// unreadable result) — the caller turns that into a refusal, never a pass.
pub(crate) fn run_validator_batch(
    validator: &DeclaredValidator,
    inputs: &[ValidatorInput],
    context: &serde_json::Value,
) -> Result<Vec<Option<String>>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }

    // A per-run nonce prefixes the verdict line. The result we read is the LAST
    // line carrying it, which is emitted after the publisher's code has already
    // returned — so even a body that prints a forged nonce line cannot displace
    // the real verdict. (Forgery is not the threat model here — the publisher's
    // own code faking a pass for the publisher's own region gains nothing — but
    // the batch protocol should not be ambiguous either.)
    let nonce = {
        let bytes = identity::generate_uuid_v7();
        let mut s = String::from("__calcula_wbv_");
        for b in bytes.iter() {
            s.push_str(&format!("{:02x}", b));
        }
        s.push_str("__");
        s
    };

    let values: Vec<serde_json::Value> = inputs
        .iter()
        .map(|i| serde_json::json!({ "row": i.row, "col": i.col, "value": i.value }))
        .collect();

    // The publisher's source is embedded as the initializer of `__fn`. Every
    // host global is dropped BEFORE it is evaluated, so the body opens onto a
    // bare ECMAScript realm.
    let harness = format!(
        r#"(function () {{
  var __emit = console.log;
  try {{ delete globalThis.Calcula; }} catch (e) {{}}
  try {{ delete globalThis.model; }} catch (e) {{}}
  try {{ delete globalThis.display; }} catch (e) {{}}
  try {{ delete globalThis.console; }} catch (e) {{}}
  // The RAW sinks the `model` / `display` facades call through. Deleting the
  // facade leaves these reachable by name, and "inert because this surface has
  // no ModelDataProvider" is a property of another file that could change
  // without anyone looking here. A validator is PUBLISHER-authored code running
  // on the RESPONDENT's machine, so the realm it opens onto is the entire basis
  // for consenting to it: delete the sinks, do not reason about them.
  try {{ delete globalThis.__calcula_model_query; }} catch (e) {{}}
  try {{ delete globalThis.__calcula_model_sql; }} catch (e) {{}}
  try {{ delete globalThis.__calcula_model_value; }} catch (e) {{}}
  try {{ delete globalThis.__calcula_model_kpi; }} catch (e) {{}}
  try {{ delete globalThis.__calcula_model_members; }} catch (e) {{}}
  try {{ delete globalThis.__calcula_model_info; }} catch (e) {{}}
  try {{ delete globalThis.__calcula_model_connections; }} catch (e) {{}}
  try {{ delete globalThis.__calcula_display_table; }} catch (e) {{}}
  var __report = function (payload) {{ __emit({nonce} + JSON.stringify(payload)); }};
  var __fn;
  try {{
    __fn = ({source});
  }} catch (e) {{
    __report({{ error: "validator source failed to load: " + String((e && e.message) || e) }});
    return;
  }}
  if (typeof __fn !== "function") {{
    __report({{ error: "validator source did not evaluate to a function" }});
    return;
  }}
  var __values = {values};
  var __ctx = {context};
  var __out = [];
  for (var i = 0; i < __values.length; i++) {{
    var item = __values[i];
    var ctx = {{
      regionId: __ctx.regionId,
      valueType: __ctx.valueType,
      packageName: __ctx.packageName,
      packageVersion: __ctx.packageVersion,
      row: item.row,
      col: item.col
    }};
    var r;
    try {{
      r = __fn(item.value, ctx);
    }} catch (e) {{
      __out.push({{ status: "threw", message: String((e && e.message) || e) }});
      continue;
    }}
    if (r === true || r === null || r === undefined) {{
      __out.push({{ status: "ok" }});
    }} else if (typeof r === "string") {{
      __out.push(r.trim() === "" ? {{ status: "ok" }} : {{ status: "rejected", message: r }});
    }} else if (r === false) {{
      __out.push({{ status: "rejected", message: "Value rejected by the validator." }});
    }} else {{
      __out.push({{ status: "invalid", message: "validator returned " + (typeof r) }});
    }}
  }}
  __report({{ results: __out }});
}})();
"#,
        nonce = json_for_js(&serde_json::Value::String(nonce.clone())),
        source = validator.source,
        values = json_for_js(&serde_json::Value::Array(values)),
        context = json_for_js(context),
    );

    let options = script_engine::ScriptRunOptions {
        limits: script_engine::ScriptLimits::with_timeout_ms(VALIDATOR_TIMEOUT_MS),
        ..Default::default()
    };
    // Empty grid / empty registry / no sheet names: the validator has no data
    // surface even if it somehow reached the (already-deleted) host globals.
    let (result, _grids) = script_engine::ScriptEngine::run_with_options(
        &harness,
        "writeback-validator.js",
        vec![engine::grid::Grid::new()],
        engine::style::StyleRegistry::new(),
        Vec::new(),
        0,
        options,
    );

    let output = match result {
        script_engine::ScriptResult::Success { output, .. } => output,
        script_engine::ScriptResult::Error { message, .. } => return Err(message),
    };

    let payload = output
        .iter()
        .rev()
        .find_map(|item| {
            let text = item.to_text();
            text.strip_prefix(nonce.as_str()).map(|json| json.to_string())
        })
        .ok_or_else(|| "the validator produced no verdict".to_string())?;

    let parsed: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("unreadable verdict ({})", e))?;
    if let Some(error) = parsed.get("error").and_then(|v| v.as_str()) {
        return Err(error.to_string());
    }
    let results = parsed
        .get("results")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "the validator produced no verdict".to_string())?;
    if results.len() != inputs.len() {
        return Err(format!(
            "the validator returned {} verdict(s) for {} value(s)",
            results.len(),
            inputs.len()
        ));
    }

    let mut verdicts = Vec::with_capacity(results.len());
    for entry in results {
        let status = entry.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let message = entry
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        match status {
            "ok" => verdicts.push(None),
            "rejected" => verdicts.push(Some(if message.is_empty() {
                "Value rejected by the validator.".to_string()
            } else {
                message
            })),
            // A validator that THREW or returned nonsense has not accepted the
            // value; it has failed to judge it. Reject with the reason rather
            // than pretend it passed.
            "threw" => verdicts.push(Some(format!("the validator threw: {}", message))),
            _ => verdicts.push(Some(format!(
                "the validator gave no usable verdict ({})",
                if message.is_empty() { status } else { &message }
            ))),
        }
    }
    Ok(verdicts)
}

/// The context object handed to a validator alongside each value.
fn validator_context(
    region_id: &str,
    schema: Option<&calp::writeback::ValueSchema>,
    package_name: &str,
    resolved_version: &str,
) -> serde_json::Value {
    let value_type = schema.map(|s| match s.value_type {
        calp::writeback::ValueType::Number => "number",
        calp::writeback::ValueType::Integer => "integer",
        calp::writeback::ValueType::Text => "text",
        calp::writeback::ValueType::Date => "date",
        calp::writeback::ValueType::Boolean => "boolean",
        calp::writeback::ValueType::Enum => "enum",
    });
    serde_json::json!({
        "regionId": region_id,
        "valueType": value_type,
        "packageName": package_name,
        "packageVersion": resolved_version,
    })
}

/// Enforce a region's publisher-shipped validator over a batch of values about
/// to be written to the workspace. Any refusal is returned as a user-facing
/// message naming the application, version and validator.
fn enforce_custom_validator(
    app: &tauri::AppHandle,
    decl: &calp::WritebackRegionDeclaration,
    region_id: &str,
    package_name: &str,
    resolved_version: &str,
    submissions: &[calp::writeback::WritebackSubmission],
) -> Result<(), String> {
    let Some(validator) = declared_validator(
        decl.schema.as_ref(),
        package_name,
        resolved_version,
        region_id,
    )?
    else {
        return Ok(());
    };

    if !validator_consented(app, package_name, &validator) {
        return Err(format!(
            "Cannot submit to region '{}': the custom validator '{}' shipped by \
             {} v{} has not been approved to run on this machine (or its code \
             changed since it was approved). Open the package's writeback pane, \
             review the validator code and approve it, then submit again.",
            region_id, validator.name, package_name, resolved_version
        ));
    }

    let inputs: Vec<ValidatorInput> = submissions
        .iter()
        .filter_map(|s| {
            validator_scalar(&s.value).map(|value| ValidatorInput {
                row: s.cell_row,
                col: s.cell_col,
                value,
            })
        })
        .collect();
    if inputs.is_empty() {
        return Ok(());
    }

    let context = validator_context(region_id, decl.schema.as_ref(), package_name, resolved_version);
    let verdicts = run_validator_batch(&validator, &inputs, &context).map_err(|e| {
        format!(
            "Cannot submit to region '{}': the custom validator '{}' shipped by \
             {} v{} could not be run to a verdict ({}). Nothing was submitted. \
             Ask the publisher to fix the validator.",
            region_id, validator.name, package_name, resolved_version, e
        )
    })?;

    for (input, verdict) in inputs.iter().zip(verdicts) {
        if let Some(message) = verdict {
            return Err(format!(
                "Cell ({}, {}) was rejected by '{}' (from {} v{}): {}",
                input.row + 1,
                input.col + 1,
                validator.name,
                package_name,
                resolved_version,
                message
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod writeback_validator_tests {
    //! The custom-validator gate. These cover the pure halves — declaration
    //! resolution, consent matching, and the sandboxed execution protocol —
    //! which together decide every accept/refuse the submit path makes.
    use super::*;
    use calp::writeback::{ValueSchema, ValueType};
    use std::collections::HashMap;

    fn schema_with(extra: &[(&str, &str)]) -> ValueSchema {
        let mut map: HashMap<String, serde_json::Value> = HashMap::new();
        for (k, v) in extra {
            map.insert((*k).to_string(), serde_json::json!(v));
        }
        ValueSchema {
            value_type: ValueType::Number,
            required: false,
            min: None,
            max: None,
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: map,
        }
    }

    fn ctx() -> serde_json::Value {
        validator_context("r1", None, "pkg", "1.0.0")
    }

    fn input(value: serde_json::Value) -> ValidatorInput {
        ValidatorInput { row: 0, col: 0, value }
    }

    fn validator(source: &str) -> DeclaredValidator {
        DeclaredValidator {
            name: "check".to_string(),
            source: source.to_string(),
            source_hash: calp::integrity::sha256_hex(source.as_bytes()),
        }
    }

    // ---- declaration resolution -------------------------------------------

    #[test]
    fn region_without_a_validator_declares_none() {
        assert_eq!(
            declared_validator(Some(&schema_with(&[])), "pkg", "1.0.0", "r1").unwrap(),
            None
        );
        assert_eq!(declared_validator(None, "pkg", "1.0.0", "r1").unwrap(), None);
    }

    #[test]
    fn name_plus_body_resolves_with_the_consent_hash() {
        let src = "(v) => true";
        let schema = schema_with(&[("customValidator", "check"), ("customValidatorSource", src)]);
        let v = declared_validator(Some(&schema), "pkg", "1.0.0", "r1")
            .unwrap()
            .expect("validator");
        assert_eq!(v.name, "check");
        assert_eq!(v.source, src);
        assert_eq!(v.source_hash, calp::integrity::sha256_hex(src.as_bytes()));
    }

    /// The whole point: a NAME with no BODY is the old wishful-metadata state.
    /// It must be a hard refusal, never a silent skip.
    #[test]
    fn name_without_a_body_is_a_hard_error_naming_the_package() {
        let schema = schema_with(&[("customValidator", "iban")]);
        let err = declared_validator(Some(&schema), "acme.budget", "2.1.0", "r1")
            .expect_err("must refuse");
        assert!(err.contains("acme.budget"), "{}", err);
        assert!(err.contains("2.1.0"), "{}", err);
        assert!(err.contains("iban"), "{}", err);
    }

    #[test]
    fn a_blank_body_counts_as_no_body() {
        let schema = schema_with(&[
            ("customValidator", "check"),
            ("customValidatorSource", "   \n  "),
        ]);
        assert!(declared_validator(Some(&schema), "pkg", "1.0.0", "r1").is_err());
    }

    // ---- consent ----------------------------------------------------------

    fn consent_file(package_key: &str, id: &str, hash: &str) -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "consents": [{
                "packageName": package_key,
                "scripts": [{ "id": id, "sourceHash": hash }],
                "grantedCapabilities": [],
                "grantedAt": "2026-07-31T00:00:00Z"
            }]
        })
    }

    #[test]
    fn consent_matches_on_package_key_script_id_and_hash() {
        let key = validator_consent_key("pkg");
        let id = validator_script_id("check");
        let file = consent_file(&key, &id, "abc123");
        assert!(consent_granted_in(&file, &key, &id, "abc123"));
        // Source drift -> no consent (the publisher swapped the code).
        assert!(!consent_granted_in(&file, &key, &id, "def456"));
        // Another validator in the same application is not covered.
        assert!(!consent_granted_in(&file, &key, &validator_script_id("other"), "abc123"));
        // The application's OBJECT-SCRIPT record must not grant validators.
        assert!(!consent_granted_in(&file, "pkg", &id, "abc123"));
    }

    #[test]
    fn a_missing_or_malformed_consent_file_grants_nothing() {
        assert!(!consent_granted_in(&serde_json::json!({}), "k", "i", "h"));
        assert!(!consent_granted_in(&serde_json::json!({ "consents": 7 }), "k", "i", "h"));
    }

    #[test]
    fn validator_consent_key_and_script_id_are_the_agreed_shapes() {
        // These strings are a cross-language contract with
        // @api/writebackValidators.ts — changing one without the other
        // silently un-consents every validator.
        assert_eq!(validator_consent_key("acme.budget"), "acme.budget::writeback-validators");
        assert_eq!(validator_script_id("iban"), "writeback-validator:iban");
    }

    // ---- sandboxed execution ----------------------------------------------

    #[test]
    fn a_passing_validator_returns_no_verdicts() {
        let v = validator("(value) => value > 0 ? true : 'must be positive'");
        let verdicts = run_validator_batch(&v, &[input(serde_json::json!(5))], &ctx()).unwrap();
        assert_eq!(verdicts, vec![None]);
    }

    #[test]
    fn a_failing_validator_returns_the_publishers_message() {
        let v = validator("(value) => value > 0 ? true : 'must be positive'");
        let verdicts = run_validator_batch(&v, &[input(serde_json::json!(-1))], &ctx()).unwrap();
        assert_eq!(verdicts, vec![Some("must be positive".to_string())]);
    }

    #[test]
    fn verdicts_come_back_one_per_value_in_order() {
        let v = validator("(value) => value % 2 === 0 ? true : 'odd'");
        let verdicts = run_validator_batch(
            &v,
            &[
                input(serde_json::json!(2)),
                input(serde_json::json!(3)),
                input(serde_json::json!(4)),
            ],
            &ctx(),
        )
        .unwrap();
        assert_eq!(verdicts, vec![None, Some("odd".to_string()), None]);
    }

    #[test]
    fn the_context_reaches_the_validator() {
        let v = validator(
            "(value, ctx) => ctx.regionId === 'r1' && ctx.packageName === 'pkg' ? true : 'bad ctx'",
        );
        let verdicts = run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx()).unwrap();
        assert_eq!(verdicts, vec![None]);
    }

    /// A validator that throws has NOT accepted the value — it failed to judge
    /// it. Fail closed with the reason.
    #[test]
    fn a_throwing_validator_rejects_rather_than_passes() {
        let v = validator("(value) => { throw new Error('boom'); }");
        let verdicts = run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx()).unwrap();
        let message = verdicts[0].as_ref().expect("must reject");
        assert!(message.contains("boom"), "{}", message);
    }

    #[test]
    fn a_validator_returning_junk_rejects() {
        let v = validator("(value) => ({ maybe: true })");
        let verdicts = run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx()).unwrap();
        assert!(verdicts[0].is_some());
    }

    #[test]
    fn returning_false_rejects_with_a_default_message() {
        let v = validator("(value) => false");
        let verdicts = run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx()).unwrap();
        assert_eq!(verdicts[0].as_deref(), Some("Value rejected by the validator."));
    }

    #[test]
    fn a_source_that_is_not_a_function_cannot_be_run_to_a_verdict() {
        let v = validator("42");
        let err = run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx()).unwrap_err();
        assert!(err.contains("function"), "{}", err);
    }

    #[test]
    fn a_syntactically_broken_validator_cannot_be_run_to_a_verdict() {
        let v = validator("(value) => {{{{");
        assert!(run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx()).is_err());
    }

    /// A runaway body must trip the wall-clock budget and surface as "cannot be
    /// run to a verdict" — not hang the submit command.
    #[test]
    fn a_runaway_validator_hits_the_time_budget() {
        let v = validator("(value) => { while (true) {} }");
        let started = std::time::Instant::now();
        let outcome = run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx());
        assert!(outcome.is_err(), "a runaway validator must not pass");
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
    }

    /// The publisher's code opens onto a bare realm: the host globals the
    /// notebook/one-off surfaces bind are gone before it runs, so a validator
    /// has no grid, no model and no I/O to reach for.
    #[test]
    fn host_globals_are_unbound_inside_the_validator_realm() {
        let v = validator(
            "(value) => (typeof Calcula === 'undefined' && typeof model === 'undefined' \
             && typeof display === 'undefined') ? true : 'globals reachable'",
        );
        let verdicts = run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx()).unwrap();
        assert_eq!(verdicts, vec![None]);
    }

    #[test]
    fn a_validator_that_prints_cannot_displace_the_real_verdict() {
        // console is unbound inside the body, so a print attempt throws — which
        // is itself a rejection, never a forged pass.
        let v = validator("(value) => { console.log('__calcula_wbv_x__{\"results\":[]}'); return true; }");
        let verdicts = run_validator_batch(&v, &[input(serde_json::json!(1))], &ctx()).unwrap();
        assert!(verdicts[0].is_some(), "a body that throws must reject");
    }

    #[test]
    fn text_and_boolean_values_arrive_unwrapped() {
        use calp::writeback::SubmissionValue;
        assert_eq!(
            validator_scalar(&SubmissionValue::Text { value: "SKU-1".into() }),
            Some(serde_json::json!("SKU-1"))
        );
        assert_eq!(
            validator_scalar(&SubmissionValue::Boolean { value: true }),
            Some(serde_json::json!(true))
        );
        // Blanks are the `required` gate's business, not the validator's.
        assert_eq!(validator_scalar(&SubmissionValue::Empty), None);
    }

    #[test]
    fn an_empty_batch_never_starts_a_runtime() {
        let v = validator("(value) => 'always rejects'");
        assert_eq!(run_validator_batch(&v, &[], &ctx()).unwrap(), Vec::new());
    }

    // ---- the anti-bypass invariant ----------------------------------------

    /// EVERY submit — a human clicking Submit (`calp_submit_region`,
    /// `calp_submit_all_regions`), an `immediate` region saving a draft, and a
    /// script calling the `distribution.writeback` gateway's `submitRegion`
    /// (which routes through `calp_submit_region`) — funnels through
    /// `submit_region_internal`, which runs `enforce_custom_validator`
    /// unconditionally. The only way to weaken that would be to let the caller
    /// hand in a verdict, so this pins the signature: it takes the app state,
    /// the region, and an app handle — and nothing that could say "already
    /// validated". Adding such a parameter breaks this coercion.
    #[test]
    fn the_submit_path_accepts_no_caller_supplied_verdict() {
        let _: fn(&AppState, &crate::document_effect::DocumentEffect, &str, &tauri::AppHandle) -> Result<usize, String> =
            submit_region_internal;
    }
}

/// Submit all drafts for a region to the workspace of the subscription that
/// actually declares the region.
///
/// Workspace writes happen FIRST; local drafts are only advanced to Submitted
/// after every write succeeded. Advancing first would permanently mark values
/// as submitted that the workspace never received (retry would be a no-op
/// because submit_region only advances Draft-state entries).
fn submit_region_internal(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    region_id: &str,
    app: &tauri::AppHandle,
) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();

    // Resolve the OWNING subscription for this region (not subscriptions[0]).
    let OwningSubscription { package_name, resolved_version, registry_path, environment } =
        owning_subscription_for_region(state, region_id)?;

    // Snapshot the drafts to submit, as they would look once submitted.
    let to_submit: Vec<calp::writeback::WritebackSubmission> = {
        let wb_layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
        wb_layer
            .drafts
            .iter()
            .filter(|d| {
                d.region_id == region_id
                    && matches!(d.state, calp::writeback::SubmissionState::Draft)
            })
            .map(|d| {
                let mut s = d.clone();
                s.state = calp::writeback::SubmissionState::Submitted;
                s.submitted_at = Some(now.clone());
                s.updated_at = now.clone();
                s
            })
            .collect()
    };

    if to_submit.is_empty() {
        return Ok(0);
    }

    // OWNERSHIP (P0): every submission we write must be authored by THIS
    // installation. Drafts are stamped with the installation identity on save,
    // but the writeback layer is persisted in the .cala — opening a crafted file
    // could seed a draft attributed to a victim, which would otherwise be written
    // into the victim's workspace slot. Refuse rather than impersonate.
    let own = get_subscriber_identity(state)?;
    if let Some(bad) = to_submit.iter().find(|s| s.submitter.id != own.id) {
        return Err(format!(
            "Refusing to submit: a draft is attributed to '{}', not this installation ('{}').",
            bad.submitter.id, own.id
        ));
    }

    // Write to workspace BEFORE mutating local state.
    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;

    // RE-VALIDATE on the authoritative submit path (P0). Schema + lifecycle
    // validation in calp_save_writeback_draft is UX-only and bypassable: a
    // scripted client calling calp_submit_region directly, or a tampered .cala
    // seeding the writeback layer, would otherwise land schema/lifecycle-
    // violating values in the shared workspace where GATHER aggregates them. The
    // declaration is resolved from the signature-VERIFIED version manifest
    // (Ed25519 + TOFU over the single trusted copy), not the in-memory layer, so
    // this trust gate stays sound even if the write side is ever made writable
    // over an HTTP transport. Validation runs over the whole batch BEFORE any
    // write, so a single bad value rejects the submit atomically (drafts stay
    // for correction).
    //
    // FAIL CLOSED: if that verified read does not yield this region's
    // declaration, we do NOT fall through and write anyway. `owning_
    // subscription_for_region` above already verified the same manifest and
    // found the region, so reaching this point without a declaration means the
    // manifest changed, failed its signature, or became unreadable between the
    // two reads — none of which is a reason to skip every schema, lifecycle and
    // completeness gate and still persist to the shared workspace.
    // ALREADY-TRUSTED (RequirePinned): you can only submit to an application you
    // subscribed to. The fail-closed `else` below already turns an absent
    // declaration into a refusal, so an unpinned publisher lands there too.
    let decl = calp::integrity::load_pinned_manifest_via(
        &*registry, &package_name, &resolved_version, &scope, &calcula_profile_dir(),
    )
    .ok()
    .and_then(|m| m.writeback_regions)
    .and_then(|regions| regions.into_iter().find(|r| r.id == region_id));
    let Some(decl) = decl.as_ref() else {
        return Err(format!(
            "Cannot submit to region '{}': its declaration could not be verified in {} v{}. \
             The package manifest may have changed or failed signature verification — \
             refresh the subscription and try again.",
            region_id, package_name, resolved_version
        ));
    };
    // COMPLETENESS (P1): a region the publisher marked `required` must have
    // every cell filled before submit — otherwise a contributor can submit a
    // partial mandatory region (2 of 5 line items) believing they're done.
    if decl.schema.as_ref().map(|s| s.required).unwrap_or(false) {
        let sel = &decl.selector;
        let layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
        let mut missing = Vec::new();
        for row in sel.row_start..=sel.row_end {
            for col in sel.col_start..=sel.col_end {
                let filled = layer.drafts.iter().any(|d| {
                    d.region_id == *region_id
                        && d.cell_row == row
                        && d.cell_col == col
                        && !matches!(d.value, calp::writeback::SubmissionValue::Empty)
                });
                if !filled {
                    missing.push(format!("({}, {})", row + 1, col + 1));
                }
            }
        }
        if !missing.is_empty() {
            let shown: Vec<String> = missing.iter().take(10).cloned().collect();
            let more = if missing.len() > 10 {
                format!(" (+{} more)", missing.len() - 10)
            } else {
                String::new()
            };
            return Err(format!(
                "This region is required — fill every cell before submitting. Missing {} cell(s): {}{}.",
                missing.len(),
                shown.join(", "),
                more
            ));
        }
    }
    for sub in &to_submit {
        if let Some(schema) = &decl.schema {
            schema.validate(&sub.value).map_err(|msg| {
                format!(
                    "Submission for cell ({}, {}) failed validation: {}",
                    sub.cell_row, sub.cell_col, msg
                )
            })?;
        }
        // Lifecycle (deadline / one-shot / locked). One-shot & locked
        // consult the authoritative workspace record; others ignore the flag.
        let already_submitted = matches!(
            decl.lifecycle,
            Some(calp::writeback::LifecyclePolicy::Never)
                | Some(calp::writeback::LifecyclePolicy::RequiresUnlock)
        ) && registry_has_own_submission(state, region_id, sub.cell_row, sub.cell_col);
        check_lifecycle_policy(decl, already_submitted, &now)?;
    }

    // PUBLISHER-SHIPPED CUSTOM VALIDATOR (see the section above). Runs over the
    // whole batch BEFORE any workspace write, from the same signature-verified
    // declaration as the schema, in the embedded QuickJS realm, and fails closed
    // — so a script calling this path directly (via the `distribution.writeback`
    // gateway or `calp_submit_region`) is judged by exactly the same code as a
    // human clicking Submit. There is no verdict parameter to forge.
    enforce_custom_validator(
        app,
        decl,
        region_id,
        &package_name,
        &resolved_version,
        &to_submit,
    )?;

    for sub in &to_submit {
        // THE STAMP, applied at the one point where a value leaves this machine.
        // Every reader filters on it; a submission that reached the workspace
        // untagged would be a development-line submission forever, because
        // nothing downstream can tell where it came from.
        let mut sub = sub.clone();
        sub.environment = environment.clone();
        registry.save_submission(&package_name, &resolved_version, &sub)
            .map_err(|e| e.to_string())?;
    }
    // (The Parquet rollup is regenerated PUBLISHER-side only — on review
    // actions and inbox loads — so subscriber machines never rewrite the
    // shared `_rollup.parquet` path; see refresh_rollup_if_publisher.)

    // All writes succeeded — advance the local drafts.
    {
        let mut wb_layer = state.writeback_layer.write(effect).map_err(|e| e.to_string())?;
        wb_layer.submit_region(region_id, &now);
    }
    invalidate_gather_cache(state);

    let count = to_submit.len();

    // Audit log
    {
        let mut audit = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)).map_err(|e| e.to_string())?;
        let user = state.subscriber_identity.lock()
            .ok()
            .and_then(|id| id.as_ref().map(|i| i.display_name.clone()))
            .unwrap_or_default();
        audit.record(
            calp::audit::AuditEvent::WritebackSubmitted,
            &format!("Submitted {} writeback values for region {}", count, region_id),
            &user,
            &now,
        );
    }

    Ok(count)
}

/// Submit all drafts for a region. The owning subscription's workspace is
/// resolved from the region id — no workspace path parameter needed.
#[tauri::command]
pub fn calp_submit_region(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    region_id: String,
    window: tauri::Window,
) -> Result<usize, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Submitting/reconciling advances the persisted writeback layer.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    submit_region_internal(&state, &effect, &region_id, window_app_handle(&window))
}

/// Submit the drafts of EVERY writeback region that has any — the "I'm done /
/// submit all" action, so a contributor doesn't leave whole regions as unsent
/// drafts believing they're done. Returns the total values submitted.
///
/// PARTIAL SUCCESS IS REPORTED AS SUCH. Each region commits durably and
/// independently (workspace write, then local drafts advance to Submitted), so
/// when region 3 of 5 fails validation, regions 1-2 are already sent. Bailing
/// with `?` reported that as a total failure — the contributor was told nothing
/// went through while their answers were in fact already in the publisher's
/// workspace, which is the one thing a data-collection UI must never get wrong.
/// The error text now names what DID send, so a retry is an informed choice.
#[tauri::command]
pub fn calp_submit_all_regions(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    window: tauri::Window,
) -> Result<usize, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let region_ids: Vec<String> = {
        let layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
        let mut set = std::collections::BTreeSet::new();
        for d in &layer.drafts {
            if matches!(d.state, calp::writeback::SubmissionState::Draft) {
                set.insert(d.region_id.clone());
            }
        }
        set.into_iter().collect()
    };
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut total = 0usize;
    let mut submitted_regions = 0usize;
    for region_id in region_ids {
        match submit_region_internal(&state, &effect, &region_id, window_app_handle(&window)) {
            Ok(n) => {
                total += n;
                if n > 0 {
                    submitted_regions += 1;
                }
            }
            Err(e) => {
                if total == 0 {
                    return Err(e);
                }
                return Err(format!(
                    "{}\n\nNote: {} value(s) across {} region(s) were already submitted \
                     successfully before this failure and do NOT need resending. \
                     Fix the problem above and submit again to send the rest.",
                    e, total, submitted_regions
                ));
            }
        }
    }
    Ok(total)
}

/// One value that would leave the machine on submit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundValue {
    pub cell_row: u32,
    pub cell_col: u32,
    pub value_display: String,
    pub value_kind: String,
}

/// A read-only preview of EXACTLY what `calp_submit_region` would send: the
/// destination application + workspace, the submitter identity it would be sent as,
/// and each draft value — so the user reviews what leaves the machine, to whom,
/// and as whom, BEFORE it leaves (transparency blind spot: outbound-data preview).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundSubmissionPreview {
    pub region_id: String,
    pub package_name: String,
    pub resolved_version: String,
    pub registry_path: String,
    pub submitter_id: String,
    pub submitter_name: String,
    pub values: Vec<OutboundValue>,
    /// The publisher-shipped custom validator that WILL judge this submission,
    /// when the region declares one. Absent when it declares none. This is the
    /// frontend's only source for the validator body: it feeds the consent
    /// prompt (review the code before approving it) and the advisory
    /// as-you-type run in the hardened worker realm. The body is read from the
    /// Ed25519-verified manifest here, so what the user reviews is what the
    /// backend will run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validator: Option<OutboundValidator>,
    /// Set when the region declares a validator NAME but the application ships no
    /// BODY for it. Submission will be refused; surfaced so the pane can say so
    /// before the user fills the region in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validator_error: Option<String>,
}

/// The custom validator a submission will be judged by.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundValidator {
    pub name: String,
    /// The exact JS function-expression source the backend will execute.
    pub source: String,
    /// SHA-256 of `source` — the consent key. Matches
    /// @api/distributedConsent's `sha256Hex(source)`.
    pub source_hash: String,
    /// Whether this exact body is already approved to run on this machine.
    /// False ⇒ submission fails closed until the user reviews and approves it.
    pub consented: bool,
}

/// Mirror `submit_region_internal`'s resolution + draft snapshot WITHOUT writing,
/// so the UI can show an outbound-data preview + confirm step before submitting.
#[tauri::command]
pub fn calp_preview_region_submission(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<OutboundSubmissionPreview, String> {
    use calp::writeback::{SubmissionState, SubmissionValue};
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // Same owning-subscription resolution the real submit uses (not subscriptions[0]).
    let OwningSubscription { package_name, resolved_version, registry_path, .. } =
        owning_subscription_for_region(&state, &region_id)?;
    // The identity the submission would be sent as.
    let identity = get_subscriber_identity(&state)?;

    // Exactly the drafts submit_region_internal would send: Draft state, this region.
    let values: Vec<OutboundValue> = {
        let wb_layer = state.writeback_layer.read().map_err(|e| e.to_string())?;
        wb_layer
            .drafts
            .iter()
            .filter(|d| {
                d.region_id == region_id && matches!(d.state, SubmissionState::Draft)
            })
            .map(|d| {
                let (value_display, value_kind) = match &d.value {
                    SubmissionValue::Number { value } => (value.to_string(), "number"),
                    SubmissionValue::Text { value } => (value.clone(), "text"),
                    SubmissionValue::Boolean { value } => {
                        ((if *value { "TRUE" } else { "FALSE" }).to_string(), "boolean")
                    }
                    SubmissionValue::Empty => (String::new(), "empty"),
                };
                OutboundValue {
                    cell_row: d.cell_row,
                    cell_col: d.cell_col,
                    value_display,
                    value_kind: value_kind.to_string(),
                }
            })
            .collect()
    };

    // The validator that WILL judge this submission, resolved from the SAME
    // signature-verified manifest the submit path reads it from — so the source
    // the user reviews in the consent prompt is byte-identical to the source the
    // backend executes. (The in-memory declarations cache is deliberately not
    // used here: it would let a stale/unsigned copy be what the user approves.)
    let (validator, validator_error) = {
        let decl = crate::calp_registry::open_workspace_scoped(&registry_path)
            .ok()
            .and_then(|(registry, scope)| {
                // ALREADY-TRUSTED (RequirePinned): the consent prompt for a
                // submit to a subscribed application. Same manifest and same gate
                // as the submit itself, so what the user approves is what runs.
                calp::integrity::load_pinned_manifest_via(
                    &*registry,
                    &package_name,
                    &resolved_version,
                    &scope,
                    &calcula_profile_dir(),
                )
                .ok()
            })
            .and_then(|m| m.writeback_regions)
            .and_then(|regions| regions.into_iter().find(|r| r.id == region_id));
        match decl
            .as_ref()
            .map(|d| declared_validator(d.schema.as_ref(), &package_name, &resolved_version, &region_id))
        {
            Some(Ok(Some(v))) => {
                let consented = validator_consented(window_app_handle(&window), &package_name, &v);
                (
                    Some(OutboundValidator {
                        name: v.name,
                        source: v.source,
                        source_hash: v.source_hash,
                        consented,
                    }),
                    None,
                )
            }
            Some(Err(message)) => (None, Some(message)),
            _ => (None, None),
        }
    };

    Ok(OutboundSubmissionPreview {
        region_id,
        package_name,
        resolved_version,
        registry_path,
        submitter_id: identity.id,
        submitter_name: identity.display_name,
        values,
        validator,
        validator_error,
    })
}

/// Render a published application version to a self-contained HTML string the
/// recipient can open WITHOUT Calcula (recipient reach). `mode` is "static" (a
/// stacked, print-ready report) or "viewer" (a multi-sheet tabbed viewer). The
/// frontend then saves the string as .html or opens it for print-to-PDF.
#[tauri::command]
pub fn calp_export_application_html(
    registry_path: String,
    package_name: String,
    version: String,
    mode: String,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // RAW location — `open_workspace_scoped` owns the `file://` handling (and the
    // pin scope derived from it). See `subscription_registry_path`.
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;
    let export_mode = match mode.as_str() {
        "viewer" => calp::HtmlExportMode::Viewer,
        _ => calp::HtmlExportMode::Static,
    };
    let opts = calp::HtmlExportOptions { mode: export_mode };
    calp::render_application_html(&registry, &package_name, &version, &opts).map_err(|e| e.to_string())
}

/// Authorize a PUBLISHER-only writeback action against an application version —
/// both the review actions (approve/reject) and the "see all submissions"
/// reads (dashboard load, CSV/Parquet export). Proof of publisher ownership is
/// possession of the Ed25519 signing key whose public key the SIGNED version
/// manifest asserts as `publisher_key`: the publisher's machine has
/// `publisher-key.json` in its profile dir (written by the first publish), a
/// subscriber does not, and a different publisher's key won't match. Returns a
/// user-facing error otherwise.
///
/// Reads need this as much as writes do. A region's contributors are shown a
/// [`calp::writeback::VisibilityPolicy`] — `own_only` promises that only the
/// publisher sees everyone's answers — and the cross-submitter loaders below
/// deliberately bypass the per-subscriber GATHER filtering because "a region's
/// owner manages all of it". Without this gate that bypass was available to
/// every subscriber holding the workbook, so the promise was not kept.
/// "They can read the shared workspace folder anyway" is not a defense: the
/// app must not be the tool that does it.
/// `pub(crate)` so the SCRIPT distribution gateway
/// (`scripting::distribution_gateway`) can run the SAME publisher gate before
/// dispatching a scripted publish — the alternative was a second ownership
/// check written from scratch, which is exactly the drift this function exists
/// to prevent.
pub(crate) fn require_publisher(
    registry: &dyn calp::WorkspaceTransport,
    package_name: &str,
    version: &str,
) -> Result<(), String> {
    let manifest = registry
        .get_version_manifest(package_name, version)
        .map_err(|e| e.to_string())?;
    let profile = calcula_profile_dir();

    // The publisher of record for THIS version — the ordinary case, and the
    // only one before co-publishing existed.
    if calp::signing::profile_holds_publisher_key(&profile, &manifest.publisher_key)
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }

    // A CO-PUBLISHER may review too. An application a team develops together is an
    // application the team collects data for together: routing every approval
    // through whoever happened to create the application would reinstate the
    // release-manager bottleneck one step to the left. Authorization is the
    // same root-signed list the push gate consults, so there is one answer to
    // "who is behind this application", not two.
    if let Some(root_key) =
        calp::publishers::root_key_of(registry, package_name).map_err(|e| e.to_string())?
    {
        if let Some(list) = calp::publishers::load_verified(registry, package_name, &root_key)
            .map_err(|e| e.to_string())?
        {
            for key in list.allowed_keys() {
                if calp::signing::profile_holds_publisher_key(&profile, &key)
                    .map_err(|e| e.to_string())?
                {
                    return Ok(());
                }
            }
        }
    }

    Err(format!(
        "Only the publisher of '{}' — or a co-publisher they authorized — can view \
         or manage its writeback submissions.",
        package_name
    ))
}

/// Resolve a grid writeback region's owning subscription and assert the caller
/// is that application's publisher. Shared by the dashboard load and both exports,
/// so all three enforce identically.
pub(crate) fn require_region_publisher(state: &AppState, region_id: &str) -> Result<(), String> {
    let OwningSubscription { package_name, resolved_version, registry_path, .. } =
        owning_subscription_for_region(state, region_id)?;
    let (registry, _scope) =
        crate::calp_registry::open_workspace_scoped(&registry_path).map_err(|e| e.to_string())?;
    require_publisher(&*registry, &package_name, &resolved_version)
}

/// The MODEL-writeback twin of `require_region_publisher`: resolve the
/// subscription that declares a writeback COLUMN and assert the caller holds
/// that application's Ed25519 signing key.
///
/// Used by the script gateway to fail publisher-only actions BEFORE dispatch
/// (so the denial is audited as a capability event, not just an error string).
/// `calp_list_model_submissions` / `calp_set_model_submission_state` re-check
/// the same gate internally — the boundary is enforced twice on purpose.
pub(crate) fn require_model_writeback_publisher(
    state: &AppState,
    writeback_id: &str,
) -> Result<(), String> {
    let (package_name, resolved_version, registry_path, _env, _) =
        owning_subscription_for_model_writeback(state, writeback_id)?;
    let (registry, _scope) =
        crate::calp_registry::open_workspace_scoped(&registry_path).map_err(|e| e.to_string())?;
    require_publisher(&*registry, &package_name, &resolved_version)
}

// ============================================================================
// Writeback claim lookups (shared with the script gateway and the grid write
// path — see `scripting::writeback_gateway`)
// ============================================================================

/// The stable `SheetId` of the workbook's ACTIVE sheet — the sheet
/// `update_cell` writes to. The script write path has no sheet parameter, so
/// any "is this cell claimed?" question asked on its behalf must be asked about
/// exactly this sheet.
pub(crate) fn active_sheet_id(state: &AppState) -> Result<identity::SheetId, String> {
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    sheet_ids
        .get(active)
        .copied()
        .ok_or_else(|| format!("No sheet at index {}", active))
}

/// The id of the PUBLISHED writeback region that claims (sheet, row, col), or
/// `None`. Reads the same in-memory index every writeback gate uses — which is
/// built only from signature-verified version manifests (see
/// `rebuild_writeback_index`), so a claim can never come from an unsigned
/// source.
pub(crate) fn writeback_region_at(
    state: &AppState,
    sheet_id: identity::SheetId,
    row: u32,
    col: u32,
) -> Option<String> {
    let index = state.writeback_index.lock().ok()?;
    index.region_id_at(sheet_id, row, col).map(|s| s.to_string())
}

/// The published declaration for a region id (schema + lifecycle governance),
/// mirrored from the verified manifest by `rebuild_writeback_index`.
pub(crate) fn writeback_declaration(
    state: &AppState,
    region_id: &str,
) -> Option<calp::WritebackRegionDeclaration> {
    let decls = state.writeback_declarations.lock().ok()?;
    decls.iter().find(|d| d.id == region_id).cloned()
}

/// Whether the local writeback layer already holds a draft/submission for this
/// exact slot. "A draft exists" is the proof that the value went through the
/// authoritative `calp_save_writeback_draft` gate (schema + lifecycle) rather
/// than straight into the grid.
pub(crate) fn writeback_slot_has_draft(
    state: &AppState,
    region_id: &str,
    row: u32,
    col: u32,
) -> bool {
    state
        .writeback_layer
        .read()
        .map(|layer| {
            layer
                .drafts
                .iter()
                .any(|d| d.region_id == region_id && d.cell_row == row && d.cell_col == col)
        })
        .unwrap_or(false)
}

/// AUTHORITATIVE GUARD for the single-cell grid write path: refuse a write into
/// a claimed writeback cell that has NO draft behind it.
///
/// The interactive editor's commit guard saves the draft FIRST and only then
/// lets the normal commit through (so the cell displays what was drafted) —
/// that path always passes here. What this closes is the silent-divergence
/// bypass: a script calling `api.setCellValue` used to reach `update_cell`
/// directly, writing a writeback cell with no draft, no schema check and no
/// validator, so the grid and the writeback layer disagreed until reconcile.
/// Scripts must instead go through `script_writeback` (action `cellGuard`),
/// which creates the validated draft and only then lets the grid write happen.
///
/// Returns `Ok(())` when the cell is unclaimed (the overwhelmingly common case:
/// one lock + an empty-index short-circuit).
///
/// WIRED at the top of `update_cell_impl` (app/src-tauri/src/commands/data.rs),
/// the ONLY body behind the `update_cell` command. `update_cells_batch` already
/// skips writeback cells (partial-success), `fill` has its own range guard,
/// `update_cell_on_sheets` (the group/off-sheet write) goes through
/// `ensure_writeback_draft_before_write_on_sheets` below, and the SCRIPT grid
/// install (`apply_script_modified_grids_core` in
/// app/src-tauri/src/scripting/commands.rs, which swaps whole non-active grids
/// into `AppState` and therefore passes through NONE of the above) goes through
/// `ensure_writeback_draft_before_grid_install` — so no grid write path can land
/// a value in a claimed cell without a validated draft behind it.
pub(crate) fn ensure_writeback_draft_before_write(
    state: &AppState,
    row: u32,
    col: u32,
) -> Result<(), String> {
    if writeback_index_is_empty(state)? {
        return Ok(());
    }
    let sheet_id = active_sheet_id(state)?;
    ensure_writeback_draft_on_sheet(state, sheet_id, row, col)
}

/// The OFF-SHEET twin, for `update_cell_on_sheets` (group edit / a script's
/// `updateCellOnSheets`). The active-sheet guard cannot cover it: that command
/// writes sheets the active-sheet lookup would never name, and the writeback
/// index is keyed by `SheetId`, so every targeted sheet must be asked about
/// individually. `sheet_indices` that do not resolve are left to the caller's
/// own bounds handling.
pub(crate) fn ensure_writeback_draft_before_write_on_sheets(
    state: &AppState,
    sheet_indices: &[usize],
    row: u32,
    col: u32,
) -> Result<(), String> {
    if writeback_index_is_empty(state)? {
        return Ok(());
    }
    let targets: Vec<identity::SheetId> = {
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        sheet_indices
            .iter()
            .filter_map(|i| sheet_ids.get(*i).copied())
            .collect()
    };
    for sid in targets {
        ensure_writeback_draft_on_sheet(state, sid, row, col)?;
    }
    Ok(())
}

/// The WHOLE-GRID-INSTALL twin, for the script apply path.
///
/// `apply_script_modified_grids_core` does not write cells one at a time: it
/// diffs the script's post-run grid against the live one and then INSTALLS the
/// whole `Grid` into `AppState.grids[idx]` for every non-active sheet. That
/// assignment consults nothing — not `update_cell_impl`'s single-cell guard, not
/// `update_cells_batch`'s writeback filter (which only ever covers the ACTIVE
/// sheet), not the range guards. So a QuickJS/MCP script calling
/// `setCellValue(row, col, value, sheetIndex)` against a background sheet used
/// to land a raw value in a published writeback cell with no draft, no schema
/// check and no validator behind it — the exact silent divergence the
/// single-cell guard exists to close.
///
/// Takes the planned writes as `(sheet_index, cells)` so the empty-index fast
/// path and the `sheet_ids` resolution are each paid once for the whole apply,
/// not once per cell. Called from the PLAN phase, BEFORE anything is mutated,
/// so a refusal is atomic.
pub(crate) fn ensure_writeback_draft_before_grid_install(
    state: &AppState,
    writes: &[(usize, Vec<(u32, u32)>)],
) -> Result<(), String> {
    if writeback_index_is_empty(state)? {
        return Ok(());
    }
    let sheet_ids: Vec<identity::SheetId> = {
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        ids.clone()
    };
    for (sheet_index, cells) in writes {
        let Some(&sid) = sheet_ids.get(*sheet_index) else {
            continue;
        };
        for &(row, col) in cells {
            ensure_writeback_draft_on_sheet(state, sid, row, col)?;
        }
    }
    Ok(())
}

/// Fast path shared by both guards: a workbook with no published writeback
/// region at all pays exactly one lock.
fn writeback_index_is_empty(state: &AppState) -> Result<bool, String> {
    let index = state.writeback_index.lock().map_err(|e| e.to_string())?;
    Ok(index.is_empty())
}

/// The actual claim test for one (sheet, row, col).
fn ensure_writeback_draft_on_sheet(
    state: &AppState,
    sheet_id: identity::SheetId,
    row: u32,
    col: u32,
) -> Result<(), String> {
    let Some(region_id) = writeback_region_at(state, sheet_id, row, col) else {
        return Ok(());
    };
    if writeback_slot_has_draft(state, &region_id, row, col) {
        return Ok(());
    }
    Err(format!(
        "Cell ({}, {}) belongs to writeback region '{}'. Values there are collected as \
         writeback drafts, not written straight to the grid — save a draft first \
         (scripts: the distribution.writeback capability, action 'cellGuard').",
        row, col, region_id
    ))
}

// ============================================================================
// RANGE-level writeback claim guard
//
// The single-cell guard above only sits on `update_cell_impl` /
// `update_cell_on_sheets`. A whole family of commands rewrites rectangles of
// the grid WITHOUT ever passing through them — sort, replace-all, clear,
// merge, and insert/delete of rows and columns. Every one of those could
// destroy, overwrite or displace the cells of a published writeback region:
// values a publisher declared and a respondent is answerable for. The
// interactive editor is fenced off from those cells by the frontend
// `grid.rangeGuards` registry, but the script host, the MCP tools and the AI
// never consult it, so the fence has to exist HERE, authoritatively.
//
// -------- POLICY: refuse the whole gesture. No partial mutation. -----------
//
// 1. WHO IS ACTING is already answered by the index being non-empty.
//    `rebuild_writeback_index` builds this index EXCLUSIVELY from the
//    signature-verified version manifests of the workbook's active
//    SUBSCRIPTIONS. A publisher authoring their own application is not subscribed
//    to it, so their workbook's index is empty and every guard below returns
//    on its first lock. A non-empty index therefore means "this is a
//    subscriber's copy of somebody else's published report", which is exactly
//    the case where restructuring the form is never legitimate. That is why no
//    `require_region_publisher` escape hatch is wired in here: it would cost a
//    workspace open plus an Ed25519 verification per gesture to re-answer a
//    question the empty-index fast path already answers for free.
//
// 2. WHY THE SINGLE-CELL "a draft already exists => allow" RULE DOES NOT APPLY.
//    That rule is sound for `update_cell` because the interactive commit guard
//    saves the draft FIRST and then mirrors that same value into the cell — the
//    draft IS the value being written, so grid and writeback layer agree. None
//    of the gestures guarded here is a value-entry gesture: a sort permutes
//    rows, so drafts keyed by (row, col) would end up describing different
//    cells; a merge deletes the non-master cells outright; a clear erases the
//    answer while the draft keeps asserting it; a shift moves the grid out from
//    under a rectangle that does not move. In all of those, an existing draft
//    makes the divergence WORSE, not safer. So drafts are deliberately not
//    consulted by these guards.
//
// 3. SHIFTS ARE DESTRUCTION BY DISPLACEMENT. Region geometry is positional
//    (`RegionSelector`'s row/col bounds) and is re-derived from the SIGNED
//    manifest on every open — it is never rewritten by grid edits, and it
//    cannot be: the manifest is signed. Insert a row above a claimed region and
//    the respondent's answers slide out from under the claim while unrelated
//    cells slide into it, permanently, with the drafts still pointing at the
//    old coordinates. The rule is therefore: refuse any insert/delete whose
//    SHIFT WINDOW touches a claimed region. The shift window of both
//    `insert_rows(at, n)` and `delete_rows(at, n)` is "every row from `at`
//    downwards, all columns" — one open-ended rectangle answers both. A
//    structural edit strictly below (or strictly right of) every claimed region
//    moves nothing that is claimed and is allowed through untouched.
//
// 4. FAILURE IS CLEAN. Every guard is called before the mutation takes its
//    locks and before it opens an undo transaction, so a refusal is a no-op:
//    never a half-applied sort, never a dangling transaction. The message names
//    the region id and its A1 rectangle so the caller can act on it.
//
// 5. COST. `writeback_index_is_empty` is one mutex plus a check over an empty
//    map — that is the entire price for a workbook with no subscriptions. When
//    the index IS populated, each gesture pays ONE `regions_overlapping` linear
//    scan over that sheet's handful of regions; nothing here is ever called per
//    cell inside a mutation loop. Region-id resolution and A1 formatting run
//    only on the refusal path.
// ============================================================================

/// RANGE guard, active sheet: refuse `action` if the rectangle overlaps any
/// published writeback region. Coordinates may arrive in any order.
///
/// Wired into `sort_range`, `clear_range`, `clear_range_with_options` (content
/// clears only), `clear_cell`, `replace_single`, `merge_cells`, `unmerge_cells`
/// and `fill_range`.
pub(crate) fn ensure_range_unclaimed(
    state: &AppState,
    action: &str,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<(), String> {
    if writeback_index_is_empty(state)? {
        return Ok(());
    }
    let sheet_id = active_sheet_id(state)?;
    let query = calp::writeback::PositionalRange {
        row_start: start_row.min(end_row),
        row_end: start_row.max(end_row),
        col_start: start_col.min(end_col),
        col_end: start_col.max(end_col),
    };
    ensure_range_unclaimed_on_sheet(state, sheet_id, &query, action)
}

/// The OFF-SHEET twin, for the group-edit commands (`clear_range_on_sheets`).
/// The active-sheet lookup cannot name those sheets and the index is keyed by
/// `SheetId`, so every targeted sheet is asked individually. Indices that do
/// not resolve are left to the caller's own bounds handling, exactly as in
/// `ensure_writeback_draft_before_write_on_sheets`.
pub(crate) fn ensure_range_unclaimed_on_sheets(
    state: &AppState,
    action: &str,
    sheet_indices: &[usize],
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<(), String> {
    if writeback_index_is_empty(state)? {
        return Ok(());
    }
    let query = calp::writeback::PositionalRange {
        row_start: start_row.min(end_row),
        row_end: start_row.max(end_row),
        col_start: start_col.min(end_col),
        col_end: start_col.max(end_col),
    };
    let targets: Vec<identity::SheetId> = {
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        sheet_indices
            .iter()
            .filter_map(|i| sheet_ids.get(*i).copied())
            .collect()
    };
    for sid in targets {
        ensure_range_unclaimed_on_sheet(state, sid, &query, action)?;
    }
    Ok(())
}

/// CELL-LIST guard, active sheet: for gestures whose footprint is a scattered
/// match list rather than a rectangle (`replace_all`). Checked against the
/// actual cells so a replace that happens to miss every claimed cell still
/// runs, instead of being refused by a bounding box it never touches.
///
/// Cost is one index lookup per candidate cell, on a list the caller is about
/// to iterate anyway — and zero for a workbook with no regions.
pub(crate) fn ensure_cells_unclaimed(
    state: &AppState,
    action: &str,
    cells: &[(u32, u32)],
) -> Result<(), String> {
    if writeback_index_is_empty(state)? {
        return Ok(());
    }
    let sheet_id = active_sheet_id(state)?;
    let index = state.writeback_index.lock().map_err(|e| e.to_string())?;
    for &(row, col) in cells {
        if let Some(region_id) = index.region_id_at(sheet_id, row, col) {
            return Err(claim_refusal_cell(action, region_id, row, col));
        }
    }
    Ok(())
}

/// CELL-LIST guard for a NAMED sheet (the off-sheet twin of
/// `ensure_cells_unclaimed`, for Wave 3's cross-sheet `replace_all`): checked
/// against the actual match list on the TARGET sheet, resolved by index the
/// same way `ensure_range_unclaimed_on_sheets` does.
pub(crate) fn ensure_cells_unclaimed_on_sheet(
    state: &AppState,
    action: &str,
    sheet_index: usize,
    cells: &[(u32, u32)],
) -> Result<(), String> {
    if writeback_index_is_empty(state)? {
        return Ok(());
    }
    let Some(sheet_id) = state
        .sheet_ids
        .read()
        .map_err(|e| e.to_string())?
        .get(sheet_index)
        .copied()
    else {
        return Ok(());
    };
    let index = state.writeback_index.lock().map_err(|e| e.to_string())?;
    for &(row, col) in cells {
        if let Some(region_id) = index.region_id_at(sheet_id, row, col) {
            return Err(claim_refusal_cell(action, region_id, row, col));
        }
    }
    Ok(())
}

/// SHIFT guard for `insert_rows` / `delete_rows`: refuse when the shift window
/// (every row from `first_row` downwards, across all columns) touches a claimed
/// region. See point 3 of the policy note above for why a shift that only moves
/// a region — without overwriting a single cell of it — is still destruction.
pub(crate) fn ensure_row_shift_unclaimed(
    state: &AppState,
    action: &str,
    first_row: u32,
) -> Result<(), String> {
    ensure_range_unclaimed(state, action, first_row, 0, u32::MAX, u32::MAX)
}

/// SHIFT guard for `insert_columns` / `delete_columns`, the column twin.
pub(crate) fn ensure_col_shift_unclaimed(
    state: &AppState,
    action: &str,
    first_col: u32,
) -> Result<(), String> {
    ensure_range_unclaimed(state, action, 0, first_col, u32::MAX, u32::MAX)
}

/// The single overlap test every range guard funnels through: ONE
/// `regions_overlapping` scan; the region id and its A1 rectangle are resolved
/// only when the answer is "refuse".
fn ensure_range_unclaimed_on_sheet(
    state: &AppState,
    sheet_id: identity::SheetId,
    query: &calp::writeback::PositionalRange,
    action: &str,
) -> Result<(), String> {
    let index = state.writeback_index.lock().map_err(|e| e.to_string())?;
    let hits = index.regions_overlapping(sheet_id, query);
    let Some(hit) = hits.first() else {
        return Ok(());
    };
    // A region's own top-left corner is always inside itself, so this resolves
    // the id of the rectangle we just matched. Refusal path only.
    let region_id = index
        .region_id_at(sheet_id, hit.row_start, hit.col_start)
        .unwrap_or("<unknown>");
    Err(claim_refusal_range(action, region_id, hit))
}

/// A1 text for a claimed rectangle, e.g. `C5:D8`.
fn range_a1(range: &calp::writeback::PositionalRange) -> String {
    format!(
        "{}{}:{}{}",
        crate::pivot::utils::col_index_to_letter(range.col_start),
        range.row_start + 1,
        crate::pivot::utils::col_index_to_letter(range.col_end),
        range.row_end + 1,
    )
}

/// The shared refusal text. Names WHAT was refused, WHICH region stands in the
/// way, WHERE that region is, and WHAT the caller can do instead — a caller
/// that only learns "denied" cannot fix anything.
fn claim_refusal(action: &str, region_id: &str, where_: &str) -> String {
    format!(
        "Can't {}: {} belongs to writeback region '{}', published by a package this \
         workbook subscribes to. Those cells collect responses — values go in one \
         draft at a time through the writeback form (scripts: the \
         distribution.writeback capability, action 'cellGuard'), and clearing, \
         merging, sorting or shifting them would orphan the answers already \
         recorded against the published region. Work outside {}, or detach the \
         subscription first to turn this into a plain workbook.",
        action, where_, region_id, where_
    )
}

fn claim_refusal_range(
    action: &str,
    region_id: &str,
    range: &calp::writeback::PositionalRange,
) -> String {
    claim_refusal(action, region_id, &range_a1(range))
}

fn claim_refusal_cell(action: &str, region_id: &str, row: u32, col: u32) -> String {
    claim_refusal(
        action,
        region_id,
        &format!(
            "{}{}",
            crate::pivot::utils::col_index_to_letter(col),
            row + 1
        ),
    )
}

#[cfg(test)]
mod writeback_claim_tests {
    //! The anti-bypass invariant for the single-cell grid write path: a claimed
    //! writeback cell may only be written once a draft exists behind it (which
    //! is what proves the value went through the schema/lifecycle gate). Before
    //! this, `api.setCellValue` from a script wrote such a cell directly — no
    //! draft, no schema check, no validator — and the grid silently diverged
    //! from the writeback layer until reconcile.
    use super::*;
    use calp::writeback::{
        RegionSelector, SubmissionState, SubmissionValue, ValueSchema, ValueType,
        WritebackRegionDeclaration, WritebackSubmission,
    };
    use std::collections::HashMap;

    /// An AppState with one published 2x2 writeback region ("r1") anchored at
    /// (0,0) on the active sheet.
    fn state_with_region() -> (crate::AppState, identity::SheetId) {
        let state = crate::create_app_state();
        let sheet_id = *state.sheet_ids.read().unwrap().first().unwrap();
        let decl = WritebackRegionDeclaration {
            id: "r1".to_string(),
            selector: RegionSelector {
                sheet_id,
                row_start: 0,
                row_end: 1,
                col_start: 0,
                col_end: 1,
            },
            mode: None,
            schema: Some(ValueSchema {
                value_type: ValueType::Integer,
                required: false,
                min: None,
                max: None,
                enum_values: Vec::new(),
                max_length: None,
                pattern: None,
                extra: HashMap::new(),
            }),
            visibility: None,
            submission_policy: None,
            version_binding: None,
            lifecycle: None,
            aggregation_hint: None,
            expected_respondents: Vec::new(),
            extra: HashMap::new(),
        };
        *state.writeback_index.lock().unwrap() =
            calp::WritebackIndex::from_declarations(std::slice::from_ref(&decl)).unwrap();
        *state.writeback_declarations.lock().unwrap() = vec![decl];
        (state, sheet_id)
    }

    fn draft_for(region_id: &str, row: u32, col: u32) -> WritebackSubmission {
        WritebackSubmission {
            environment: String::new(),
            id: "sub-1".to_string(),
            region_id: region_id.to_string(),
            model_key: None,
            cell_row: row,
            cell_col: col,
            cell_id: None,
            submitter: calp::SubmitterIdentity {
                display_name: "Tester".to_string(),
                id: "tester".to_string(),
                extra: HashMap::new(),
            },
            value: SubmissionValue::Number { value: 1.0 },
            state: SubmissionState::Draft,
            created_at: "2026-07-31T00:00:00Z".to_string(),
            updated_at: "2026-07-31T00:00:00Z".to_string(),
            submitted_at: None,
            review_reason: None,
            reviewed_by: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn region_lookup_answers_only_for_claimed_cells() {
        let (state, sheet_id) = state_with_region();
        assert_eq!(active_sheet_id(&state).unwrap(), sheet_id);
        assert_eq!(
            writeback_region_at(&state, sheet_id, 0, 0).as_deref(),
            Some("r1")
        );
        assert_eq!(
            writeback_region_at(&state, sheet_id, 1, 1).as_deref(),
            Some("r1")
        );
        assert_eq!(writeback_region_at(&state, sheet_id, 2, 0), None);
        assert_eq!(writeback_region_at(&state, sheet_id, 0, 2), None);
        // The declaration (schema governance) is reachable by region id.
        let decl = writeback_declaration(&state, "r1").expect("declaration");
        assert_eq!(decl.schema.unwrap().value_type, ValueType::Integer);
        assert!(writeback_declaration(&state, "nope").is_none());
    }

    #[test]
    fn unclaimed_cells_are_always_writable() {
        let (state, _) = state_with_region();
        assert!(ensure_writeback_draft_before_write(&state, 9, 9).is_ok());

        // ...and a workbook with no writeback regions at all short-circuits.
        let plain = crate::create_app_state();
        assert!(ensure_writeback_draft_before_write(&plain, 0, 0).is_ok());
    }

    #[test]
    fn claimed_cell_without_a_draft_is_refused() {
        let (state, _) = state_with_region();
        let err = ensure_writeback_draft_before_write(&state, 0, 0)
            .expect_err("a claimed cell with no draft must be refused");
        assert!(err.contains("writeback region 'r1'"), "got: {}", err);
        assert!(err.contains("cellGuard"), "the error must say how: {}", err);
    }

    #[test]
    fn publisher_gate_fails_closed_for_both_writeback_surfaces() {
        // Proof of publisher ownership is possession of the Ed25519 signing key
        // the SIGNED version manifest names (`profile_holds_publisher_key`,
        // covered cryptographically in core/calp/src/signing.rs). What must
        // hold HERE is that the gate fails CLOSED when ownership cannot be
        // established at all — no subscription, no workspace, no manifest —
        // instead of falling through to "allowed". A subscriber's script
        // reaching `listSubmissions` / `setSubmissionState` lands exactly here.
        let (state, _) = state_with_region();
        let err = require_region_publisher(&state, "r1")
            .expect_err("no owning subscription must not authorize a publisher action");
        assert!(err.contains("r1"), "got: {}", err);

        let err = require_model_writeback_publisher(&state, "some-column")
            .expect_err("no owning subscription must not authorize a publisher action");
        assert!(err.contains("some-column"), "got: {}", err);
    }

    #[test]
    fn claimed_cell_with_a_draft_is_allowed_through() {
        // The interactive editor's commit guard saves the draft and THEN lets
        // the normal commit run so the cell displays the value — that path must
        // keep working, or writeback becomes unusable by humans.
        let (state, _) = state_with_region();
        state
            .writeback_layer
            .write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()))
            .unwrap()
            .set_draft(draft_for("r1", 0, 0));

        assert!(writeback_slot_has_draft(&state, "r1", 0, 0));
        assert!(ensure_writeback_draft_before_write(&state, 0, 0).is_ok());

        // A DIFFERENT cell of the same region still needs its own draft — a
        // per-region check would have let a script write the rest of the form.
        assert!(!writeback_slot_has_draft(&state, "r1", 1, 1));
        assert!(ensure_writeback_draft_before_write(&state, 1, 1).is_err());
    }

    #[test]
    fn the_off_sheet_write_path_is_guarded_per_targeted_sheet() {
        // `update_cell_on_sheets` (group edit, and a script's
        // `updateCellOnSheets`) never consults the ACTIVE sheet, so the
        // active-sheet guard cannot cover it. Each targeted sheet is asked
        // about individually, by SheetId.
        let (state, _) = state_with_region();

        // Sheet 0 carries the region: a claimed cell with no draft is refused.
        let err = ensure_writeback_draft_before_write_on_sheets(&state, &[0], 0, 0)
            .expect_err("a claimed cell on a targeted sheet must be refused");
        assert!(err.contains("writeback region 'r1'"), "got: {}", err);

        // An unclaimed cell on that sheet is fine...
        assert!(ensure_writeback_draft_before_write_on_sheets(&state, &[0], 9, 9).is_ok());
        // ...as is a sheet index that resolves to nothing (the caller's own
        // bounds handling owns that case).
        assert!(ensure_writeback_draft_before_write_on_sheets(&state, &[97], 0, 0).is_ok());
        // ...and an empty target list.
        assert!(ensure_writeback_draft_before_write_on_sheets(&state, &[], 0, 0).is_ok());

        // Once a validated draft exists behind the cell, the write proceeds —
        // the human group-edit path must keep working.
        state
            .writeback_layer
            .write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()))
            .unwrap()
            .set_draft(draft_for("r1", 0, 0));
        assert!(ensure_writeback_draft_before_write_on_sheets(&state, &[0], 0, 0).is_ok());

        // A workbook with no writeback regions short-circuits before any
        // sheet-id resolution at all.
        let plain = crate::create_app_state();
        assert!(ensure_writeback_draft_before_write_on_sheets(&plain, &[0, 1], 0, 0).is_ok());
    }

    // ---------------------------------------------------------------------
    // RANGE-level guard (sort / replace-all / clear / merge / insert / delete)
    // ---------------------------------------------------------------------

    /// The region fixture claims rows 0..=1, columns 0..=1 — A1:B2.
    #[test]
    fn a_range_overlapping_a_claim_is_refused_and_the_error_is_actionable() {
        let (state, _) = state_with_region();
        let err = ensure_range_unclaimed(&state, "sort this range", 0, 0, 5, 5)
            .expect_err("a range overlapping a claim must be refused");
        assert!(err.contains("sort this range"), "names the gesture: {}", err);
        assert!(err.contains("writeback region 'r1'"), "names the region: {}", err);
        assert!(err.contains("A1:B2"), "names WHERE the region is: {}", err);
        assert!(err.contains("detach"), "says what the caller can do: {}", err);

        // Touching a single corner is enough.
        assert!(ensure_range_unclaimed(&state, "clear", 1, 1, 9, 9).is_err());
        // Coordinates in reverse order normalize, not slip through.
        assert!(ensure_range_unclaimed(&state, "clear", 9, 9, 1, 1).is_err());
    }

    #[test]
    fn a_range_that_misses_every_claim_is_untouched() {
        let (state, _) = state_with_region();
        assert!(ensure_range_unclaimed(&state, "sort", 2, 0, 100, 100).is_ok());
        assert!(ensure_range_unclaimed(&state, "sort", 0, 2, 100, 100).is_ok());
    }

    #[test]
    fn a_workbook_with_no_regions_takes_the_fast_path() {
        // The publisher's own authoring workbook, and every workbook that never
        // subscribed to anything: one lock, no sheet-id resolution, no scan.
        let plain = crate::create_app_state();
        assert!(ensure_range_unclaimed(&plain, "sort", 0, 0, 1000, 1000).is_ok());
        assert!(ensure_range_unclaimed_on_sheets(&plain, "clear", &[0, 1], 0, 0, 99, 99).is_ok());
        assert!(ensure_cells_unclaimed(&plain, "replace", &[(0, 0), (1, 1)]).is_ok());
        assert!(ensure_row_shift_unclaimed(&plain, "insert rows", 0).is_ok());
        assert!(ensure_col_shift_unclaimed(&plain, "insert columns", 0).is_ok());
    }

    #[test]
    fn a_row_shift_that_would_move_a_claim_is_refused_but_one_below_it_is_not() {
        // Region rows are 0..=1. Inserting/deleting at row 0 or 1 moves claimed
        // cells out from under a rectangle that is pinned by the SIGNED
        // manifest; at row 2 nothing claimed moves.
        let (state, _) = state_with_region();
        let err = ensure_row_shift_unclaimed(&state, "insert rows here", 0)
            .expect_err("a shift at the region's first row must be refused");
        assert!(err.contains("writeback region 'r1'"), "got: {}", err);
        assert!(ensure_row_shift_unclaimed(&state, "delete rows here", 1).is_err());
        assert!(ensure_row_shift_unclaimed(&state, "insert rows here", 2).is_ok());
        assert!(ensure_row_shift_unclaimed(&state, "insert rows here", 1000).is_ok());
    }

    #[test]
    fn a_column_shift_that_would_move_a_claim_is_refused_but_one_right_of_it_is_not() {
        let (state, _) = state_with_region();
        assert!(ensure_col_shift_unclaimed(&state, "insert columns here", 0).is_err());
        assert!(ensure_col_shift_unclaimed(&state, "delete columns here", 1).is_err());
        assert!(ensure_col_shift_unclaimed(&state, "insert columns here", 2).is_ok());
    }

    #[test]
    fn the_cell_list_guard_answers_on_the_actual_cells_not_a_bounding_box() {
        let (state, _) = state_with_region();
        // A match list that straddles the region but never lands in it runs.
        assert!(ensure_cells_unclaimed(&state, "replace all", &[(0, 5), (7, 0), (9, 9)]).is_ok());
        // One claimed match refuses the whole gesture, naming that cell.
        let err = ensure_cells_unclaimed(&state, "replace all", &[(9, 9), (1, 0)])
            .expect_err("a claimed match must refuse the gesture");
        assert!(err.contains("writeback region 'r1'"), "got: {}", err);
        assert!(err.contains("A2"), "names the offending cell: {}", err);
        assert!(ensure_cells_unclaimed(&state, "replace all", &[]).is_ok());
    }

    #[test]
    fn an_existing_draft_does_not_excuse_a_range_gesture() {
        // The single-cell guard lets a draft-backed write through because the
        // value being written IS the draft. A sort/clear/merge is not that: it
        // would leave the layer asserting an answer the grid no longer holds.
        let (state, _) = state_with_region();
        state
            .writeback_layer
            .write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()))
            .unwrap()
            .set_draft(draft_for("r1", 0, 0));
        assert!(ensure_writeback_draft_before_write(&state, 0, 0).is_ok());
        assert!(ensure_range_unclaimed(&state, "sort", 0, 0, 0, 0).is_err());
        assert!(ensure_cells_unclaimed(&state, "replace all", &[(0, 0)]).is_err());
    }

    #[test]
    fn the_off_sheet_range_guard_is_asked_per_targeted_sheet() {
        let (state, _) = state_with_region();
        let err = ensure_range_unclaimed_on_sheets(&state, "clear", &[0], 0, 0, 3, 3)
            .expect_err("a claimed range on a targeted sheet must be refused");
        assert!(err.contains("writeback region 'r1'"), "got: {}", err);

        assert!(ensure_range_unclaimed_on_sheets(&state, "clear", &[0], 5, 5, 9, 9).is_ok());
        // Unresolvable indices and empty target lists belong to the caller's
        // own bounds handling, matching the single-cell twin.
        assert!(ensure_range_unclaimed_on_sheets(&state, "clear", &[97], 0, 0, 3, 3).is_ok());
        assert!(ensure_range_unclaimed_on_sheets(&state, "clear", &[], 0, 0, 3, 3).is_ok());
    }
}

/// Resolve the subscription that declares a model writeback column, returning
/// (application, resolved version, workspace path, the SIGNED declaration). The
/// declaration always comes from the signature-verified manifest — it is the
/// governance every submit gate below re-validates against.
fn owning_subscription_for_model_writeback(
    state: &AppState,
    writeback_id: &str,
) -> Result<
    (String, String, String, String, calp::writeback::ModelWritebackDeclaration),
    String,
> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    for sub in &subs.subscriptions {
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }
        // RAW location, and RAW is also what is returned to the caller — which
        // opens it again. See `subscription_registry_path`.
        let registry_path = sub.registry_url.clone();
        let Ok((registry, scope)) = crate::calp_registry::open_workspace_scoped(&registry_path) else {
            continue;
        };
        // ALREADY-TRUSTED (RequirePinned), same reasoning as
        // `owning_subscription_for_region`: an unpinned application declares
        // nothing here rather than pinning itself on a cell edit.
        let Ok(manifest) = calp::integrity::load_pinned_manifest_via(
            registry.as_ref(),
            &sub.package_name,
            &sub.resolved_version,
            &scope,
            &calcula_profile_dir(),
        ) else {
            continue;
        };
        if let Some(decl) = manifest
            .model_writebacks
            .as_ref()
            .and_then(|d| d.iter().find(|d| d.id == writeback_id))
        {
            return Ok((
                sub.package_name.clone(),
                sub.resolved_version.clone(),
                registry_path,
                // The environment this submission belongs to. `""` = the
                // development line, and also every submission made before
                // environments existed.
                sub.environment.clone().unwrap_or_default(),
                decl.clone(),
            ));
        }
    }
    Err(format!(
        "No subscription declares writeback column '{}' — the application may need a re-pull",
        writeback_id
    ))
}

/// Submit one model writeback entry to the owning application's workspace
/// (SUBSCRIBED connections — bi_writeback_set_value routes here).
///
/// P0-parity gates, all against the SIGNED manifest's declaration (never the
/// local model, which a crafted .cala could have widened): the column must be
/// declared; the key arity must match; the value must pass the declared
/// schema; a masterData column only accepts its designated editors. The
/// record lands as `Submitted` — masterData projections count it only once
/// the publisher approves (`OnApproval`), History projections immediately.
pub(crate) fn submit_model_writeback(
    state: &AppState,
    wb: &bi_engine::WritebackColumn,
    key: Vec<String>,
    value: calp::writeback::SubmissionValue,
    identity: &calp::SubmitterIdentity,
) -> Result<(), String> {
    let (package_name, resolved_version, registry_path, environment, decl) =
        owning_subscription_for_model_writeback(state, wb.id())?;

    if key.len() != decl.key_columns.len() {
        return Err(format!(
            "'{}' expects {} key value(s) per its published declaration, got {}",
            decl.column,
            decl.key_columns.len(),
            key.len()
        ));
    }
    if let Some(schema) = &decl.schema {
        if !matches!(value, calp::writeback::SubmissionValue::Empty) {
            schema
                .validate(&value)
                .map_err(|msg| format!("'{}': {}", decl.column, msg))?;
        } else if schema.required {
            return Err(format!("'{}' requires a value (clearing is not allowed)", decl.column));
        }
    }
    if decl.kind == "masterData" && !decl.allowed_editors.is_empty() {
        let id = identity.id.to_lowercase();
        let name = identity.display_name.to_lowercase();
        let allowed = decl.allowed_editors.iter().any(|e| {
            let e = e.trim().to_lowercase();
            !e.is_empty() && (id == e || name == e || name.contains(&e) || e.contains(&name))
        });
        if !allowed {
            return Err(format!(
                "'{}' is a master data column — only its designated editors can change it",
                decl.column
            ));
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let submission = calp::writeback::WritebackSubmission {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7())
            .to_string()
            .to_lowercase(),
        region_id: wb.id().to_string(),
        cell_row: 0,
        cell_col: 0,
        cell_id: None,
        submitter: identity.clone(),
        value,
        state: calp::writeback::SubmissionState::Submitted,
        created_at: now.clone(),
        updated_at: now.clone(),
        submitted_at: Some(now.clone()),
        review_reason: None,
        reviewed_by: None,
        environment,
        model_key: Some(key),
        extra: Default::default(),
    };

    let (registry, _scope) =
        crate::calp_registry::open_workspace_scoped(&registry_path).map_err(|e| e.to_string())?;
    registry
        .save_submission(&package_name, &resolved_version, &submission)
        .map_err(|e| e.to_string())?;

    // Audit + refresh (the gather invalidation also queues the BI feeds).
    {
        let user = audit_user(state);
        if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)) {
            audit.record(
                calp::audit::AuditEvent::WritebackSubmitted,
                &format!(
                    "Submitted model writeback '{}' ({}.{}) to {} v{}",
                    wb.name(),
                    decl.table,
                    decl.column,
                    package_name,
                    resolved_version
                ),
                &user,
                &now,
            );
        }
    }
    invalidate_gather_cache(state);
    Ok(())
}

/// List a model writeback column's workspace submissions (publisher review).
/// PUBLISHER-GATED, matching `calp_set_model_submission_state`: this returns
/// every submitter's raw values and identity for the column.
#[tauri::command]
pub fn calp_list_model_submissions(
    state: State<AppState>,
    writeback_id: String,
    window: tauri::Window,
) -> Result<Vec<calp::writeback::WritebackSubmission>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (package_name, resolved_version, registry_path, _env, _) =
        owning_subscription_for_model_writeback(&state, &writeback_id)?;
    let (registry, _scope) =
        crate::calp_registry::open_workspace_scoped(&registry_path).map_err(|e| e.to_string())?;
    // AUTHORIZATION (parity with calp_set_model_submission_state): this returns
    // EVERY submitter's raw values and identity for the column. Publisher only.
    require_publisher(&*registry, &package_name, &resolved_version)?;
    let mut subs: Vec<calp::writeback::WritebackSubmission> = registry
        .load_current_submissions(&package_name, &resolved_version)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| s.region_id == writeback_id && s.model_key.is_some())
        .collect();
    subs.sort_by(|a, b| a.submitted_at.cmp(&b.submitted_at).then_with(|| a.id.cmp(&b.id)));
    // Publisher-side, best-effort rollup freshness: submissions arrive while
    // the publisher only reads, so the review-pane load keeps the parquet
    // current without any subscriber ever writing it.
    refresh_rollup_if_publisher(&registry, &package_name, &resolved_version);
    Ok(subs)
}

/// Approve or reject a MODEL writeback submission (publisher action, engine
/// v21 writeback columns). Same authorization as grid submissions: possession
/// of the application's signing key. The decision is an append-only ReviewEvent
/// under the version's `reviews/` subtree, targeting the submission by id —
/// the history record itself is immutable, and its state is derived at read
/// time by the fold.
#[tauri::command]
pub fn calp_set_model_submission_state(
    state: State<AppState>,
    writeback_id: String,
    submission_id: String,
    new_state: String,
    reason: Option<String>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let target_state = match new_state.as_str() {
        "approved" => calp::writeback::SubmissionState::Approved,
        "rejected" => calp::writeback::SubmissionState::Rejected,
        "submitted" => calp::writeback::SubmissionState::Submitted,
        _ => {
            return Err(format!(
                "Invalid submission state '{}'. Must be 'approved', 'rejected', or 'submitted'",
                new_state
            ))
        }
    };

    let (package_name, resolved_version, registry_path, _env, _) =
        owning_subscription_for_model_writeback(&state, &writeback_id)?;
    let (registry, _scope) =
        crate::calp_registry::open_workspace_scoped(&registry_path).map_err(|e| e.to_string())?;

    // AUTHORIZATION (P0 parity): approve/reject is publisher-only — without
    // this any subscriber could self-approve a masterData value.
    require_publisher(&registry, &package_name, &resolved_version)?;

    let submission = registry
        .load_current_submissions(&package_name, &resolved_version)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == submission_id && s.region_id == writeback_id && s.model_key.is_some())
        .ok_or_else(|| {
            format!(
                "No model submission '{}' found for writeback column '{}'",
                submission_id, writeback_id
            )
        })?;

    let now = chrono::Utc::now().to_rfc3339();
    let reviewer = get_subscriber_identity(&state).ok().map(|i| i.display_name);
    let review = calp::writeback::ReviewEvent {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7())
            .to_string()
            .to_lowercase(),
        target_submission_id: submission.id.clone(),
        region_id: writeback_id.clone(),
        submitter_id: submission.submitter.id.clone(),
        new_state: target_state,
        review_reason: reason
            .as_ref()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty()),
        reviewed_by: reviewer,
        reviewed_at: now.clone(),
        extra: Default::default(),
    };
    registry
        .save_review(&package_name, &resolved_version, &review)
        .map_err(|e| e.to_string())?;
    refresh_rollup_if_publisher(&registry, &package_name, &resolved_version);

    {
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)) {
            audit.record(
                calp::audit::AuditEvent::WritebackReviewed,
                &format!(
                    "Model writeback submission {} in {} v{} set to {}",
                    submission_id, package_name, resolved_version, new_state
                ),
                &user,
                &now,
            );
        }
    }
    invalidate_gather_cache(&state);
    Ok(())
}

/// Approve or reject a submitted writeback value (publisher action).
///
/// The decision is an append-only ReviewEvent under the version's `reviews/`
/// subtree, targeting the CURRENT submission event for the slot by id — the
/// submission file itself is never rewritten (publisher and submitter never
/// write the same path, which is what keeps shared/synced workspaces
/// conflict-free). If the submitter re-submits after the decision, the review
/// targets a superseded event and the slot folds back to Submitted ("approve
/// what you saw"). `on_approval` regions only aggregate Approved submissions
/// in GATHER.
#[tauri::command]
pub fn calp_set_submission_state(
    state: State<AppState>,
    region_id: String,
    submitter_id: String,
    cell_row: u32,
    cell_col: u32,
    new_state: String,
    reason: Option<String>,
    submission_id: Option<String>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let target_state = match new_state.as_str() {
        "approved" => calp::writeback::SubmissionState::Approved,
        "rejected" => calp::writeback::SubmissionState::Rejected,
        "submitted" => calp::writeback::SubmissionState::Submitted,
        _ => {
            return Err(format!(
                "Invalid submission state '{}'. Must be 'approved', 'rejected', or 'submitted'",
                new_state
            ))
        }
    };

    let OwningSubscription { package_name, resolved_version, registry_path, environment } =
        owning_subscription_for_region(&state, &region_id)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;

    // AUTHORIZATION (P0): approve/reject is publisher-only. Without this, any
    // subscriber could self-approve an out-of-policy value into an on_approval
    // aggregate, or reject a rival's so GATHER drops it.
    require_publisher(&registry, &package_name, &resolved_version)?;

    // Search the resolved version first, then older ones: lenient regions
    // carry submissions forward across version bumps, and those records live
    // in the version directory they were submitted against — the review event
    // must be appended in the version whose fold holds the record.
    let mut versions = vec![resolved_version.clone()];
    versions.extend(carry_forward_versions(
        &registry,
        &package_name,
        &resolved_version,
        &environment,
    ));

    let mut found: Option<(String, calp::writeback::WritebackSubmission)> = None;
    for version in &versions {
        let Ok(submissions) = registry
            .load_current_submissions_by(&package_name, version, &submitter_id)
            .map(|subs| calp::writeback::visible_in(subs, Some(&environment)))
        else {
            continue;
        };
        if let Some(s) = submissions.into_iter().find(|s| {
            s.region_id == region_id && s.cell_row == cell_row && s.cell_col == cell_col
        }) {
            found = Some((version.clone(), s));
            break;
        }
    }
    let (version, submission) = found.ok_or_else(|| {
        format!(
            "No submission found for region '{}' cell ({}, {}) by submitter '{}'",
            region_id, cell_row, cell_col, submitter_id
        )
    })?;

    // EXACT-TARGET REVIEW: when the dashboard passes the submission id it
    // displayed, refuse to review blind if a newer submission has arrived in
    // the meantime — the approve-vs-resubmit race made visible instead of
    // silently deciding on a value the publisher never saw.
    if let Some(expected) = submission_id.as_deref() {
        if expected != submission.id {
            return Err(
                "This submission was superseded by a newer one — refresh the dashboard and review the current value."
                    .to_string(),
            );
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let reviewer = get_subscriber_identity(&state).ok().map(|i| i.display_name);
    let review = calp::writeback::ReviewEvent {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7())
            .to_string()
            .to_lowercase(),
        target_submission_id: submission.id.clone(),
        region_id: region_id.clone(),
        submitter_id: submitter_id.clone(),
        new_state: target_state,
        // Attach the publisher's reason + identity so the contributor's
        // read-back can show WHY (not just a bare "rejected"). An empty
        // reason clears it.
        review_reason: reason
            .as_ref()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty()),
        reviewed_by: reviewer,
        reviewed_at: now.clone(),
        extra: Default::default(),
    };
    registry
        .save_review(&package_name, &version, &review)
        .map_err(|e| e.to_string())?;
    refresh_rollup_if_publisher(&registry, &package_name, &version);
    invalidate_gather_cache(&state);

    // Audit the publisher decision — the provenance of the return leg, so a
    // contributor who is told "rejected" can see who decided and when.
    {
        let mut audit = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::AuditTrail)).map_err(|e| e.to_string())?;
        let user = state
            .subscriber_identity
            .lock()
            .ok()
            .and_then(|id| id.as_ref().map(|i| i.display_name.clone()))
            .unwrap_or_default();
        audit.record(
            calp::audit::AuditEvent::WritebackReviewed,
            &format!(
                "{} {}'s submission for region {} cell ({}, {})",
                new_state, submitter_id, region_id, cell_row, cell_col
            ),
            &user,
            &now,
        );
    }
    Ok(())
}

/// A submission row for the publisher data-collection dashboard (D5).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionSubmissionInfo {
    /// The submission EVENT id the row shows — the dashboard passes it back
    /// on approve/reject so the decision targets exactly what was reviewed.
    pub submission_id: String,
    /// The stream this submission was made in; empty = the development line.
    pub environment: String,
    pub region_id: String,
    pub cell_row: u32,
    pub cell_col: u32,
    pub submitter_id: String,
    pub submitter_name: String,
    pub value_display: String,
    pub value_kind: String,
    pub state: String,
    pub submitted_at: Option<String>,
    pub updated_at: String,
    pub review_reason: Option<String>,
    pub reviewed_by: Option<String>,
}

/// Load EVERY submission for a writeback region across all submitters — the
/// publisher's "see all" view for the data-collection dashboard (D5). Unlike the
/// GATHER path, this is not filtered by per-subscriber visibility: a region's
/// owner manages all of it — which is why it is PUBLISHER-GATED. Without that
/// gate the visibility bypass was reachable by every subscriber holding the
/// workbook, breaking the `own_only` promise the contributor was shown.
/// Resolves the owning subscription (application + version + workspace) for the
/// region, then collects the current record per (submitter, cell) slot across
/// the resolved version and older ones (lenient carry-forward).
#[tauri::command]
pub fn calp_load_region_submissions(
    state: State<AppState>,
    region_id: String,
    // `environment`: look at a stream other than the one this workbook follows.
    // `None` is the publisher's own, and the pane names whichever it is showing.
    environment: Option<String>,
    window: tauri::Window,
) -> Result<Vec<RegionSubmissionInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // AUTHORIZATION: this is the cross-submitter "see all" view — publisher
    // only, matching approve/reject. Gate BEFORE reading anything.
    require_region_publisher(&state, &region_id)?;
    let infos = load_region_submission_infos(&state, &region_id, environment.as_deref())?;
    // Publisher-side, best-effort rollup freshness: submissions arrive while
    // the publisher only reads, so the inbox load keeps the parquet current
    // without any subscriber ever writing the shared `_rollup.parquet` path.
    if let Ok(OwningSubscription { package_name, resolved_version, registry_path, .. }) =
        owning_subscription_for_region(&state, &region_id)
    {
        if let Ok((registry, _scope)) = crate::calp_registry::open_workspace_scoped(&registry_path) {
            refresh_rollup_if_publisher(&registry, &package_name, &resolved_version);
        }
    }
    Ok(infos)
}

/// The current raw record per (submitter, cell) slot for a region, across the
/// resolved version and older ones (lenient carry-forward), sorted by submitter
/// then cell. Shared by the dashboard projection, the CSV export, and the
/// Parquet export so all three see exactly the same set.
/// `environment_override`: `None` means "this workbook's own stream", which is
/// the only correct answer for anything that feeds a value. The publisher
/// DASHBOARD passes `Some` so a publisher can look at what testers submitted
/// without switching their own subscription — a deliberate act with the answer
/// named on screen, never a silent mixing.
fn load_region_current_submissions(
    state: &AppState,
    region_id: &str,
    environment_override: Option<&str>,
) -> Result<Vec<calp::writeback::WritebackSubmission>, String> {
    let OwningSubscription { package_name, resolved_version, registry_path, environment } =
        owning_subscription_for_region(state, region_id)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;

    let mut versions = vec![resolved_version.clone()];
    versions.extend(carry_forward_versions(
        &registry,
        &package_name,
        &resolved_version,
        environment_override.unwrap_or(&environment),
    ));

    // Newest version first: keep the current record per (submitter, cell)
    // slot. Each version's load is already collapsed by the workspace fold, so
    // `or_insert` only arbitrates ACROSS versions.
    let mut by_slot: std::collections::HashMap<(String, u32, u32), calp::writeback::WritebackSubmission> =
        std::collections::HashMap::new();
    let reading = environment_override.unwrap_or(&environment);
    for version in &versions {
        if let Ok(subs) = registry.load_current_region_submissions(&package_name, version, region_id) {
            for s in calp::writeback::visible_in(subs, Some(reading)) {
                by_slot
                    .entry((s.submitter.id.clone(), s.cell_row, s.cell_col))
                    .or_insert(s);
            }
        }
    }

    let mut out: Vec<_> = by_slot.into_values().collect();
    out.sort_by(|a, b| {
        a.submitter
            .display_name
            .cmp(&b.submitter.display_name)
            .then(a.cell_row.cmp(&b.cell_row))
            .then(a.cell_col.cmp(&b.cell_col))
    });
    Ok(out)
}

/// The string label for a submission state.
pub(crate) fn submission_state_str(s: &calp::writeback::SubmissionState) -> &'static str {
    use calp::writeback::SubmissionState::*;
    match s {
        Draft => "draft",
        Submitted => "submitted",
        Approved => "approved",
        Rejected => "rejected",
    }
}

/// Shared loader behind `calp_load_region_submissions` and the CSV export: the
/// current record per (submitter, cell) slot, projected for the dashboard.
fn load_region_submission_infos(
    state: &AppState,
    region_id: &str,
    environment_override: Option<&str>,
) -> Result<Vec<RegionSubmissionInfo>, String> {
    use calp::writeback::SubmissionValue;
    let out: Vec<RegionSubmissionInfo> =
        load_region_current_submissions(state, region_id, environment_override)?
        .into_iter()
        .map(|s| {
            let (value_display, value_kind) = match &s.value {
                SubmissionValue::Number { value } => (value.to_string(), "number"),
                SubmissionValue::Text { value } => (value.clone(), "text"),
                SubmissionValue::Boolean { value } => {
                    ((if *value { "TRUE" } else { "FALSE" }).to_string(), "boolean")
                }
                SubmissionValue::Empty => (String::new(), "empty"),
            };
            RegionSubmissionInfo {
                submission_id: s.id,
                // WHICH STREAM THIS ROW CAME FROM. A dashboard showing "3
                // responses" without saying whose is how a publisher reads a
                // test count as a production one.
                environment: s.environment,
                region_id: s.region_id,
                cell_row: s.cell_row,
                cell_col: s.cell_col,
                submitter_id: s.submitter.id,
                submitter_name: s.submitter.display_name,
                value_display,
                value_kind: value_kind.to_string(),
                state: submission_state_str(&s.state).to_string(),
                submitted_at: s.submitted_at,
                updated_at: s.updated_at,
                review_reason: s.review_reason,
                reviewed_by: s.reviewed_by,
            }
        })
        .collect();
    Ok(out)
}

/// Quote a CSV field if it contains a comma, quote, or newline (RFC 4180).
fn csv_escape(s: &str) -> String {
    if s.contains(|c| c == ',' || c == '"' || c == '\n' || c == '\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Export every submission for a writeback region as CSV text — the publisher's
/// data-collection output, so collected values can be pivoted / reconciled /
/// archived instead of being trapped behind the dashboard list. The frontend
/// saves the returned string as a .csv file. PUBLISHER-GATED: this is the same
/// cross-submitter disclosure as the dashboard, in a form that leaves the app.
#[tauri::command]
pub fn calp_export_region_submissions_csv(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // AUTHORIZATION: an export is the same disclosure as the dashboard, in a
    // form that leaves the app. Publisher only.
    require_region_publisher(&state, &region_id)?;
    let rows = load_region_submission_infos(&state, &region_id, None)?;
    let mut out =
        String::from("submitter,submitterId,cell,value,type,state,submittedAt,updatedAt,reviewedBy,reviewReason\n");
    for r in &rows {
        let cell = format!("R{}C{}", r.cell_row + 1, r.cell_col + 1);
        let fields = [
            r.submitter_name.as_str(),
            r.submitter_id.as_str(),
            cell.as_str(),
            r.value_display.as_str(),
            r.value_kind.as_str(),
            r.state.as_str(),
            r.submitted_at.as_deref().unwrap_or(""),
            r.updated_at.as_str(),
            r.reviewed_by.as_deref().unwrap_or(""),
            r.review_reason.as_deref().unwrap_or(""),
        ];
        out.push_str(
            &fields
                .iter()
                .map(|f| csv_escape(f))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push('\n');
    }
    Ok(out)
}

/// A1 reference for a 0-based (row, col): e.g. (1, 1) -> "B2".
fn a1(row: u32, col: u32) -> String {
    let mut letters = String::new();
    let mut n = col as i64;
    loop {
        letters.insert(0, (b'A' + (n % 26) as u8) as char);
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    format!("{}{}", letters, row + 1)
}

/// Encode a set of writeback submissions as Parquet bytes with a TYPED, columnar
/// schema (separate `value_number`/`value_text`/`value_bool` columns + a
/// `value_kind` discriminator), so a database can read it directly — e.g.
/// `SELECT SUM(value_number) ... WHERE value_kind = 'number'` — without parsing
/// per-slot JSON or guessing types from a CSV.
fn encode_submissions_parquet(
    subs: &[calp::writeback::WritebackSubmission],
) -> Result<Vec<u8>, String> {
    use arrow::array::{ArrayRef, BooleanBuilder, Float64Builder, StringBuilder, UInt32Builder};
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use calp::writeback::SubmissionValue;
    use std::sync::Arc;

    let mut submission_id = StringBuilder::new();
    let mut environment = StringBuilder::new();
    let mut region_id = StringBuilder::new();
    let mut cell_row = UInt32Builder::new();
    let mut cell_col = UInt32Builder::new();
    let mut cell_ref = StringBuilder::new();
    let mut submitter_id = StringBuilder::new();
    let mut submitter_name = StringBuilder::new();
    let mut value_number = Float64Builder::new();
    let mut value_text = StringBuilder::new();
    let mut value_bool = BooleanBuilder::new();
    let mut value_kind = StringBuilder::new();
    let mut state = StringBuilder::new();
    let mut submitted_at = StringBuilder::new();
    let mut updated_at = StringBuilder::new();
    let mut reviewed_by = StringBuilder::new();
    let mut review_reason = StringBuilder::new();

    for s in subs {
        submission_id.append_value(&s.id);
        // A COLUMN, not a separate file per environment. The rollup's path is a
        // published contract a database points at; splitting it would break
        // every existing reader, while a column lets one `WHERE environment =
        // 'prod'` do what the split would have done — and makes a query that
        // FORGOT to filter visibly wrong rather than silently mixed.
        environment.append_value(&s.environment);
        region_id.append_value(&s.region_id);
        cell_row.append_value(s.cell_row);
        cell_col.append_value(s.cell_col);
        cell_ref.append_value(a1(s.cell_row, s.cell_col));
        submitter_id.append_value(&s.submitter.id);
        submitter_name.append_value(&s.submitter.display_name);
        match &s.value {
            SubmissionValue::Number { value } => {
                value_number.append_value(*value);
                value_text.append_null();
                value_bool.append_null();
                value_kind.append_value("number");
            }
            SubmissionValue::Text { value } => {
                value_number.append_null();
                value_text.append_value(value);
                value_bool.append_null();
                value_kind.append_value("text");
            }
            SubmissionValue::Boolean { value } => {
                value_number.append_null();
                value_text.append_null();
                value_bool.append_value(*value);
                value_kind.append_value("boolean");
            }
            SubmissionValue::Empty => {
                value_number.append_null();
                value_text.append_null();
                value_bool.append_null();
                value_kind.append_value("empty");
            }
        }
        state.append_value(submission_state_str(&s.state));
        submitted_at.append_option(s.submitted_at.as_deref());
        updated_at.append_value(&s.updated_at);
        reviewed_by.append_option(s.reviewed_by.as_deref());
        review_reason.append_option(s.review_reason.as_deref());
    }

    let schema = Arc::new(Schema::new(vec![
        Field::new("submission_id", DataType::Utf8, false),
        Field::new("environment", DataType::Utf8, false),
        Field::new("region_id", DataType::Utf8, false),
        Field::new("cell_row", DataType::UInt32, false),
        Field::new("cell_col", DataType::UInt32, false),
        Field::new("cell_ref", DataType::Utf8, false),
        Field::new("submitter_id", DataType::Utf8, false),
        Field::new("submitter_name", DataType::Utf8, false),
        Field::new("value_number", DataType::Float64, true),
        Field::new("value_text", DataType::Utf8, true),
        Field::new("value_bool", DataType::Boolean, true),
        Field::new("value_kind", DataType::Utf8, false),
        Field::new("state", DataType::Utf8, false),
        Field::new("submitted_at", DataType::Utf8, true),
        Field::new("updated_at", DataType::Utf8, false),
        Field::new("reviewed_by", DataType::Utf8, true),
        Field::new("review_reason", DataType::Utf8, true),
    ]));

    let columns: Vec<ArrayRef> = vec![
        Arc::new(submission_id.finish()),
        Arc::new(environment.finish()),
        Arc::new(region_id.finish()),
        Arc::new(cell_row.finish()),
        Arc::new(cell_col.finish()),
        Arc::new(cell_ref.finish()),
        Arc::new(submitter_id.finish()),
        Arc::new(submitter_name.finish()),
        Arc::new(value_number.finish()),
        Arc::new(value_text.finish()),
        Arc::new(value_bool.finish()),
        Arc::new(value_kind.finish()),
        Arc::new(state.finish()),
        Arc::new(submitted_at.finish()),
        Arc::new(updated_at.finish()),
        Arc::new(reviewed_by.finish()),
        Arc::new(review_reason.finish()),
    ];

    let batch = RecordBatch::try_new(schema.clone(), columns).map_err(|e| e.to_string())?;

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = parquet::arrow::ArrowWriter::try_new(&mut buf, schema, None)
            .map_err(|e| e.to_string())?;
        writer.write(&batch).map_err(|e| e.to_string())?;
        writer.close().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// Export every submission for a writeback region as Parquet bytes (typed,
/// columnar — directly readable by DuckDB / Snowflake / Spark / pandas /
/// Polars). The frontend saves the bytes as a `.parquet` file. PUBLISHER-GATED,
/// like the CSV export.
#[tauri::command]
pub fn calp_export_region_submissions_parquet(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<Vec<u8>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // AUTHORIZATION: same disclosure as the CSV export. Publisher only.
    require_region_publisher(&state, &region_id)?;
    let subs = load_region_current_submissions(&state, &region_id, None)?;
    encode_submissions_parquet(&subs)
}

/// Best-effort: (re)materialize the per-version Parquet rollup of the CURRENT
/// (folded) submissions at `{version}/submissions/_rollup.parquet`, so a
/// database can read the whole collection by pointing at the workspace folder —
/// no per-event JSON parsing, and no manual export. It lives UNDER
/// `submissions/` (a post-publish subtree excluded from the application integrity
/// walk) so it never trips pull, and it is a non-`.json` file so it is ignored
/// by submission loading. Failures are logged, not surfaced — the JSON events
/// remain the source of truth and the next refresh self-heals the rollup.
fn materialize_submissions_parquet(
    registry: &dyn calp::WorkspaceTransport,
    package: &str,
    version: &str,
) {
    let subs = match registry.load_current_submissions(package, version) {
        Ok(s) => s,
        Err(e) => {
            crate::log_warn!("CALP", "writeback rollup: load_current_submissions failed: {}", e);
            return;
        }
    };
    let bytes = match encode_submissions_parquet(&subs) {
        Ok(b) => b,
        Err(e) => {
            crate::log_warn!("CALP", "writeback rollup: parquet encode failed: {}", e);
            return;
        }
    };
    if let Err(e) = registry.write_artifact(package, version, "submissions/_rollup.parquet", &bytes) {
        crate::log_warn!("CALP", "writeback rollup: write failed: {}", e);
    }
}

/// Publisher-gated, best-effort rollup refresh. Only the PUBLISHER's machine
/// (holder of the application signing key) ever regenerates `_rollup.parquet`, so
/// exactly one machine owns that path — a sync client can never fork it into
/// "conflicted copies" the way multi-machine rewrites would. Called from
/// review actions and publisher inbox/review-pane loads, so the rollup also
/// picks up submissions (grid AND model/store-table) that arrived while the
/// publisher was only reading.
fn refresh_rollup_if_publisher(
    registry: &dyn calp::WorkspaceTransport,
    package: &str,
    version: &str,
) {
    if !rollup_enabled(registry, package) {
        return;
    }
    let is_publisher = registry
        .get_version_manifest(package, version)
        .ok()
        .and_then(|m| {
            calp::signing::profile_holds_publisher_key(&calcula_profile_dir(), &m.publisher_key)
                .ok()
        })
        .unwrap_or(false);
    if is_publisher {
        materialize_submissions_parquet(registry, package, version);
    }
}

/// Whether the publisher has opted this application into the auto-materialized
/// Parquet rollup. Stored in the (unsigned) application manifest's `extra` —
/// application-level, default OFF, flippable any time by the publisher. It gates
/// *whether* the rollup is regenerated, not a security boundary, so the unsigned
/// application manifest is the right home (no per-version, no signing churn).
fn rollup_enabled(registry: &dyn calp::WorkspaceTransport, package: &str) -> bool {
    registry
        .get_application_manifest(package)
        .ok()
        .and_then(|m| m.extra.get("writebackRollup").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

/// Read whether the Parquet rollup is enabled for the application owning a region.
#[tauri::command]
pub fn calp_get_writeback_rollup(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let OwningSubscription { package_name, registry_path, .. } =
        owning_subscription_for_region(&state, &region_id)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;
    Ok(rollup_enabled(&registry, &package_name))
}

/// Publisher-only: enable/disable the auto-materialized Parquet rollup for the
/// application owning a region. Enabling materializes it immediately so the file
/// appears at once (not just on the next submit/approve).
#[tauri::command]
pub fn calp_set_writeback_rollup(
    state: State<AppState>,
    region_id: String,
    enabled: bool,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let OwningSubscription { package_name, resolved_version, registry_path, .. } =
        owning_subscription_for_region(&state, &region_id)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;
    require_publisher(&registry, &package_name, &resolved_version)?;

    // The application-manifest read-modify-write is the ONE mutable-file update on
    // this path — guard it with the workspace's publish lock so a concurrent
    // publish can't lose the flag (or the flag lose a version-list update).
    // Submission/review event paths never take any lock, by design.
    let _manifest_guard = registry.lock().map_err(|e| e.to_string())?;
    let mut manifest = registry
        .get_application_manifest(&package_name)
        .map_err(|e| e.to_string())?;
    if enabled {
        manifest
            .extra
            .insert("writebackRollup".to_string(), serde_json::Value::Bool(true));
    } else {
        manifest.extra.remove("writebackRollup");
    }
    registry
        .write_application_manifest(&manifest)
        .map_err(|e| e.to_string())?;
    drop(_manifest_guard);

    if enabled {
        materialize_submissions_parquet(&registry, &package_name, &resolved_version);
    }
    Ok(())
}

/// Completion-tracking status for a writeback region: who the publisher expects
/// to respond, who has, and who is still missing.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionResponseStatus {
    /// The publisher's declared expected respondents (verbatim).
    pub expected: Vec<String>,
    /// Distinct submitter display names that have a non-empty submission.
    pub responded: Vec<String>,
    /// Expected identifiers with no matching submission yet.
    pub missing: Vec<String>,
}

/// Compute who has responded vs. who is still expected for a region — the
/// publisher's "7 of 12 submitted / chase the rest" view. Matches each declared
/// expected respondent case-insensitively against any submitter's display name
/// or id (with a substring fallback so "Alice" matches "Alice (North)").
/// PUBLISHER-GATED: `responded` names every contributor, so this is the same
/// cross-submitter disclosure as the inbox, merely aggregated.
#[tauri::command]
pub fn calp_region_response_status(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<RegionResponseStatus, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let OwningSubscription { package_name, resolved_version, registry_path, environment } =
        owning_subscription_for_region(&state, &region_id)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;
    // AUTHORIZATION: `responded` names every contributor across all submitters
    // — the same cross-submitter disclosure as the inbox, just aggregated.
    // Publisher only.
    require_publisher(&*registry, &package_name, &resolved_version)?;

    let expected: Vec<String> = registry
        .get_version_manifest(&package_name, &resolved_version)
        .ok()
        .and_then(|m| m.writeback_regions)
        .and_then(|regions| regions.into_iter().find(|r| r.id == region_id))
        .map(|d| d.expected_respondents)
        .unwrap_or_default();

    // Distinct submitters (id -> display name) with a non-empty submission,
    // across the resolved version and the ones this stream ran before it.
    let mut versions = vec![resolved_version.clone()];
    versions.extend(carry_forward_versions(
        &registry,
        &package_name,
        &resolved_version,
        &environment,
    ));
    let mut respondents: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for version in &versions {
        if let Ok(subs) = registry.load_current_region_submissions(&package_name, version, &region_id) {
            for s in calp::writeback::visible_in(subs, Some(&environment)) {
                if matches!(s.value, calp::writeback::SubmissionValue::Empty) {
                    continue;
                }
                respondents
                    .entry(s.submitter.id.clone())
                    .or_insert(s.submitter.display_name.clone());
            }
        }
    }

    Ok(compute_response_status(expected, &respondents))
}

/// Pure completion-tracking computation (extracted for unit testing): given the
/// declared expected respondents and `respondents` (id -> display name of
/// everyone with a non-empty submission), return who responded and who's
/// missing. An expected entry matches case-insensitively on a submitter's id or
/// display name, with a substring fallback either way ("Alice" ⇄ "Alice (North)").
fn compute_response_status(
    expected: Vec<String>,
    respondents: &std::collections::HashMap<String, String>,
) -> RegionResponseStatus {
    let mut responded: Vec<String> = respondents.values().cloned().collect();
    responded.sort();
    responded.dedup();

    let matched = |exp: &str| -> bool {
        let e = exp.trim().to_lowercase();
        if e.is_empty() {
            return true; // a blank expected entry isn't "missing"
        }
        respondents.iter().any(|(id, name)| {
            let n = name.to_lowercase();
            id.to_lowercase() == e || n == e || n.contains(&e) || e.contains(&n)
        })
    };
    let missing: Vec<String> = expected.iter().filter(|e| !matched(e)).cloned().collect();

    RegionResponseStatus { expected, responded, missing }
}

/// Apply a region's GATHER governance to its submissions: approval gating,
/// drop cleared cells, READ-SIDE schema + deadline integrity, then visibility
/// (own_only hides others; own_plus_aggregate keeps values but anonymizes other
/// submitters). Pure + unit-tested — this is the privacy AND integrity boundary
/// for what reaches an aggregate, so it must never silently change.
/// `pub(crate)`: also the mandatory filter for subscriber-audience writeback
/// dataset tables (bi::writeback_source) — one governance path, never two.
pub(crate) fn apply_gather_governance(
    mut submissions: Vec<calp::writeback::WritebackSubmission>,
    region: &calp::WritebackRegionDeclaration,
    own_identity: Option<&calp::SubmitterIdentity>,
) -> Vec<calp::writeback::WritebackSubmission> {
    // PRIVACY FAIL-CLOSED (C2b): "is this submission the reader's own?" must
    // treat a BLANK/whitespace reader id as NO identity. A corrupt or
    // hand-written subscriber-identity.json with "id":"" would otherwise make
    // own.id == "" match every anonymized record (OwnPlusAggregate itself clears
    // ids to "") — leaking other people's values under own_only. With a blank
    // reader id this returns false everywhere, so own_only reveals nothing and
    // own_plus_aggregate anonymizes EVERYONE (the safe direction). A real minted
    // identity always carries a non-blank UUID, so legitimate views are
    // unaffected. See also the load-time guard in calp::identity_provider.
    fn is_own(own: Option<&calp::SubmitterIdentity>, submission_id: &str) -> bool {
        match own {
            Some(o) if !o.id.trim().is_empty() => o.id == submission_id,
            _ => false,
        }
    }

    // Approval gating: rejected submissions never count; under
    // on_approval only Approved submissions join the aggregate.
    let require_approval = matches!(
        region.submission_policy,
        Some(calp::writeback::SubmissionPolicy::OnApproval)
    );
    submissions.retain(|s| match s.state {
        calp::writeback::SubmissionState::Rejected
        | calp::writeback::SubmissionState::Draft => false,
        calp::writeback::SubmissionState::Submitted => !require_approval,
        calp::writeback::SubmissionState::Approved => true,
    });

    // A cleared cell is "no submission", not a zero — counting it
    // would skew AVERAGE/COUNT/SUBMITTERS aggregates.
    submissions.retain(|s| !matches!(s.value, calp::writeback::SubmissionValue::Empty));

    // READ-SIDE SCHEMA INTEGRITY (P0): the publisher's ValueSchema is enforced
    // on the honest submit path, but the workspace is a shared directory — a
    // hand-written submission file can carry an out-of-range or wrong-type value.
    // Drop anything that fails the region's schema so it can never reach an
    // aggregate. (Honest submissions already passed this exact check at submit,
    // so no legitimate value is dropped.)
    if let Some(schema) = &region.schema {
        submissions.retain(|s| schema.validate(&s.value).is_ok());
    }

    // READ-SIDE DEADLINE INTEGRITY (P0): a region with a passed `until_deadline`
    // blocks new submits on the honest path, but a late or backdated file would
    // otherwise still aggregate. Drop any submission whose `submitted_at` is at
    // or after the deadline. Best-effort without a trusted clock: a record that
    // lacks `submitted_at` is kept (we can't prove it was late); the schema gate
    // above still applies to it.
    if let Some(calp::writeback::LifecyclePolicy::UntilDeadline { deadline: Some(dl) }) =
        &region.lifecycle
    {
        submissions.retain(|s| match &s.submitted_at {
            Some(ts) => !deadline_passed(dl, ts),
            None => true,
        });
    }

    // Deterministic ordering BEFORE any anonymization: read_dir / HashMap order
    // is not cross-machine stable, so GATHER and GATHER.SUBMITTERS (which read
    // this same order) would otherwise not be index-pairable across machines.
    submissions.sort_by(|a, b| {
        a.cell_row
            .cmp(&b.cell_row)
            .then(a.cell_col.cmp(&b.cell_col))
            .then(a.submitter.id.cmp(&b.submitter.id))
    });

    // Visibility enforcement. NOTE: the policy docs say "publisher
    // sees all", but without authenticated identities (roadmap D8)
    // every gatherer is a subscriber, so the policy applies to all.
    match region.visibility {
        Some(calp::writeback::VisibilityPolicy::OwnOnly) => {
            submissions.retain(|s| is_own(own_identity, &s.submitter.id));
        }
        Some(calp::writeback::VisibilityPolicy::OwnPlusAggregate) => {
            // Values flow (aggregates need them) but other submitters'
            // identities are anonymized — to a STABLE DISTINCT token ("Submitter
            // 2") rather than a single "(anonymous)", so a roster of N
            // contributors stays distinguishable in GATHER.SUBMITTERS. Tokens
            // are assigned in the (already-deterministic) sorted order.
            let mut token_for: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            let mut next: usize = 1;
            for s in submissions.iter() {
                if !is_own(own_identity, &s.submitter.id) && !token_for.contains_key(&s.submitter.id) {
                    token_for.insert(s.submitter.id.clone(), format!("Submitter {next}"));
                    next += 1;
                }
            }
            for s in submissions.iter_mut() {
                if !is_own(own_identity, &s.submitter.id) {
                    s.submitter.display_name = token_for
                        .get(&s.submitter.id)
                        .cloned()
                        .unwrap_or_else(|| "(anonymous)".to_string());
                    s.submitter.id = String::new();
                }
            }
        }
        _ => {}
    }

    submissions
}

/// Lenient version-binding carry-forward, extracted (behavior-preserving) from
/// `build_gather_data` so the writeback dataset builder (bi::writeback_source)
/// merges IDENTICALLY: submissions made against strictly OLDER versions of the
/// same region carry forward — but only when that version's region is compatible
/// with the current one. "Compatible" must mean exactly what
/// `check_region_compatibility` means, since that is what the refresh path uses
/// to decide whether to keep a subscriber's drafts:
///
/// * GEOMETRY — the old selector's cells must still address the same thing
///   (`preserves_cell_meaning_of`). Submissions are keyed by ABSOLUTE
///   `(cell_row, cell_col)`, so carrying them across a moved or shrunk region
///   drops them onto cells that now hold a different field. This gate is why
///   the check exists: without it a region that slid down two rows between
///   versions would silently re-file last quarter's answers against the wrong
///   rows, and the aggregate would look plausible.
/// * SCHEMA — both present → compare; either absent → compatible.
/// * Region absent in that version → nothing to carry.
///
/// Newest `updated_at` wins per (submitter, cell) slot. A `Strict` version
/// binding disables carry-forward entirely.
pub(crate) fn merge_lenient_submissions(
    mut submissions: Vec<calp::writeback::WritebackSubmission>,
    older: &[(
        Vec<calp::WritebackRegionDeclaration>,
        std::collections::HashMap<String, Vec<calp::writeback::WritebackSubmission>>,
    )],
    region: &calp::WritebackRegionDeclaration,
) -> Vec<calp::writeback::WritebackSubmission> {
    let lenient = !matches!(
        region.version_binding,
        Some(calp::writeback::VersionBinding::Strict)
    );
    if !lenient || older.is_empty() {
        return submissions;
    }

    let mut slots: std::collections::HashMap<(String, u32, u32), usize> = submissions
        .iter()
        .enumerate()
        .map(|(i, s)| ((s.submitter.id.clone(), s.cell_row, s.cell_col), i))
        .collect();
    for (old_regions, old_by_region) in older {
        let compatible = match old_regions.iter().find(|r| r.id == region.id) {
            None => false,
            Some(old_r) => {
                // Geometry first, exactly as check_region_compatibility orders it.
                region.selector.preserves_cell_meaning_of(&old_r.selector)
                    && match (&old_r.schema, &region.schema) {
                        (Some(old_s), Some(new_s)) => old_s.is_compatible_with(new_s),
                        _ => true,
                    }
            }
        };
        if !compatible {
            continue;
        }
        let Some(older_subs) = old_by_region.get(&region.id) else {
            continue;
        };
        for candidate in older_subs.iter().cloned() {
            let key = (
                candidate.submitter.id.clone(),
                candidate.cell_row,
                candidate.cell_col,
            );
            match slots.get(&key) {
                Some(&i) => {
                    if candidate.updated_at > submissions[i].updated_at {
                        submissions[i] = candidate;
                    }
                }
                None => {
                    submissions.push(candidate);
                    slots.insert(key, submissions.len() - 1);
                }
            }
        }
    }
    submissions
}

/// How long a freshly built GATHER map is served before a background refresh is
/// queued. A TTL (rather than pure event-invalidation) keeps OTHER subscribers'
/// new submissions appearing without an explicit action; local mutations queue a
/// refresh eagerly via `invalidate_gather_cache`.
const GATHER_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(2);

/// How long an HTTP workspace that failed is left alone before it is tried again.
/// Without this, an unreachable workspace pays a full connect timeout on EVERY
/// rebuild — 30s per artifact, every TTL window, forever.
const GATHER_REGISTRY_BACKOFF: std::time::Duration = std::time::Duration::from_secs(300);

/// Bumped on every invalidation; the worker loops until it has completed a build
/// that STARTED at the latest generation, so no invalidation is absorbed by a
/// build that snapshotted state before it. (Same shape as
/// `bi::writeback_source::invalidate_writeback_bi`.)
static GATHER_REFRESH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Whether a refresh worker is running (coalesces bursts into one trailing run).
static GATHER_REFRESH_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// HTTP workspace location -> the instant before which it must not be retried.
fn gather_registry_backoff(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>> {
    static BACKOFF: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
    > = std::sync::OnceLock::new();
    BACKOFF.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Whether this workspace is currently marked dead. LOCAL workspaces are never
/// backed off — a missing directory fails in microseconds, and skipping it would
/// hide a workspace the user just plugged back in.
fn registry_is_backed_off(location: &str) -> bool {
    if !crate::calp_registry::is_http_location(location) {
        return false;
    }
    let Ok(map) = gather_registry_backoff().lock() else {
        return false;
    };
    map.get(location)
        .map(|until| std::time::Instant::now() < *until)
        .unwrap_or(false)
}

/// Mark an HTTP workspace unreachable for `GATHER_REGISTRY_BACKOFF`.
fn mark_registry_unreachable(location: &str) {
    if !crate::calp_registry::is_http_location(location) {
        return;
    }
    if let Ok(mut map) = gather_registry_backoff().lock() {
        map.insert(
            location.to_string(),
            std::time::Instant::now() + GATHER_REGISTRY_BACKOFF,
        );
    }
}

/// Clear the backoff after a successful read.
fn clear_registry_backoff(location: &str) {
    if let Ok(mut map) = gather_registry_backoff().lock() {
        map.remove(location);
    }
}

/// Test-only reset so backoff state cannot leak between tests.
#[cfg(test)]
pub(crate) fn reset_gather_registry_backoff() {
    if let Ok(mut map) = gather_registry_backoff().lock() {
        map.clear();
    }
}

/// Order-independent digest of a GATHER map, used to decide whether a completed
/// background refresh actually CHANGED anything. In the steady state (nobody
/// submitted since the last build) the digest matches and no recalculation is
/// triggered at all.
fn gather_fingerprint(
    data: &std::collections::HashMap<String, engine::GatherRegionData>,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut per_region: Vec<u64> = data
        .iter()
        .map(|(region_id, region)| {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            region_id.hash(&mut h);
            let mut rows: Vec<String> = region
                .submissions
                .iter()
                .map(|s| {
                    format!(
                        "{}|{}|{}|{}|{:?}",
                        s.submitter_id, s.submitter_name, s.cell_row, s.cell_col, s.value
                    )
                })
                .collect();
            rows.sort();
            rows.hash(&mut h);
            h.finish()
        })
        .collect();
    per_region.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    per_region.hash(&mut h);
    h.finish()
}

/// The GATHER pre-fetch map for formula evaluation — NEVER BLOCKING.
///
/// This is called from eight places on the calculation path, including
/// `update_cell` (i.e. every keystroke that commits a cell) and every recalc
/// pass. It used to build the map INLINE: open every subscribed workspace, read
/// and Ed25519-verify a pinned version manifest per subscription (two artifact
/// reads plus a pin-store disk read each), then scan the whole submission tree.
/// For an HTTP-workspace subscriber that is `reqwest::blocking` with a 30-second
/// timeout per request — so a single keystroke could freeze the UI for half a
/// minute, and the 2-second TTL meant it froze again two seconds later.
///
/// Now it only ever reads the cache:
///
/// * cache present -> return it immediately, queueing a background refresh if it
///   is older than [`GATHER_CACHE_TTL`];
/// * cache absent (workbook just opened, or something invalidated it) -> return
///   an EMPTY map and queue the refresh. GATHER cells read empty for the
///   fraction of a second the fetch takes, then the worker recalculates the
///   workbook and repaints. Serving stale-but-wrong data would be worse: an
///   invalidation means the previous map is known to be untrue.
///
/// The blocking build itself is [`rebuild_gather_cache`], run on a worker
/// thread by [`queue_gather_refresh`]. With no Tauri app handle installed (unit
/// tests, headless use) there is no worker to run it on, so it falls back to
/// building inline — otherwise GATHER would silently never populate.
pub fn build_gather_data(state: &AppState) -> std::collections::HashMap<String, engine::GatherRegionData> {
    // Fast path: no writeback regions known to this workbook — no cache, no
    // worker, no workspace I/O. (Declarations are rebuilt at pull, refresh, and
    // workbook open.)
    if state
        .writeback_declarations
        .lock()
        .map(|d| d.is_empty())
        .unwrap_or(true)
    {
        return std::collections::HashMap::new();
    }

    let cached = match state.gather_cache.lock() {
        Ok(cache) => cache.clone(),
        Err(_) => None,
    };

    match cached {
        Some((stamp, data)) => {
            if stamp.elapsed() >= GATHER_CACHE_TTL {
                queue_gather_refresh();
            }
            data
        }
        None => {
            if crate::bi::writeback_source::app_handle().is_some() {
                queue_gather_refresh();
                std::collections::HashMap::new()
            } else {
                // No worker available (unit tests / no app handle yet): build
                // inline rather than returning permanently empty.
                rebuild_gather_cache(state)
            }
        }
    }
}

/// Run [`rebuild_gather_cache`] on a background OS thread, then recalculate and
/// repaint if the data actually changed.
///
/// A plain `std::thread`, deliberately: the workspace transports use
/// `reqwest::blocking`, which must not run on the async runtime's worker pool
/// (it would park a runtime thread for the full 30s timeout).
pub(crate) fn queue_gather_refresh() {
    use std::sync::atomic::Ordering;
    let Some(app) = crate::bi::writeback_source::app_handle() else {
        return;
    };
    GATHER_REFRESH_GEN.fetch_add(1, Ordering::SeqCst);
    if GATHER_REFRESH_ACTIVE.swap(true, Ordering::SeqCst) {
        return; // an active worker will observe the bumped generation
    }
    std::thread::spawn(move || {
        use tauri::{Emitter, Manager};
        loop {
            let seen = GATHER_REFRESH_GEN.load(Ordering::SeqCst);
            {
                let state = app.state::<AppState>();
                let before = state
                    .gather_cache
                    .lock()
                    .ok()
                    .and_then(|c| c.as_ref().map(|(_, d)| gather_fingerprint(d)));
                let fresh = rebuild_gather_cache(&state);
                let after = gather_fingerprint(&fresh);
                if before != Some(after) {
                    // The workbook's GATHER formulas now hold values built from
                    // data that has since changed. Re-evaluate every sheet (a
                    // GATHER formula can live on any of them) and repaint.
                    let user_files = app.state::<crate::persistence::UserFilesState>();
                    let pivot = app.state::<crate::pivot::types::PivotState>();
                    let pane = app.state::<crate::pane_control::PaneControlState>();
                    let ribbon = app.state::<crate::ribbon_filter::RibbonFilterState>();
                    let sheet_count = state.grids.read().map(|g| g.len()).unwrap_or(0);
                    for sheet_index in 0..sheet_count {
                        crate::calculation::recalculate_sheet_values(
                            &state,
                            &user_files,
                            &pivot,
                            sheet_index,
                            Some((&pane, &ribbon)),
                        );
                    }
                    let _ = app.emit("grid:refresh", ());
                }
            }
            if GATHER_REFRESH_GEN.load(Ordering::SeqCst) != seen {
                continue; // invalidated mid-run — go again
            }
            GATHER_REFRESH_ACTIVE.store(false, Ordering::SeqCst);
            // Close the check-then-clear race: a bump that landed between the
            // check above and the clear must not be lost.
            if GATHER_REFRESH_GEN.load(Ordering::SeqCst) == seen
                || GATHER_REFRESH_ACTIVE.swap(true, Ordering::SeqCst)
            {
                break;
            }
        }
    });
}

/// Build a GatherRegionData map from the current subscriptions for formula
/// evaluation, doing the actual workspace I/O. BLOCKING — run it on a worker
/// thread (see [`queue_gather_refresh`]), never on the edit path.
///
/// Stores the result in `state.gather_cache` before returning it.
pub(crate) fn rebuild_gather_cache(state: &AppState) -> std::collections::HashMap<String, engine::GatherRegionData> {
    let mut result = std::collections::HashMap::new();

    let subscriptions = match state.subscriptions.read() {
        // CLONED, not held: the whole build below is seconds of network I/O,
        // and holding the subscriptions lock across it would block every
        // command that only wants to read the list.
        Ok(s) => s.subscriptions.clone(),
        Err(_) => return result,
    };

    for sub in &subscriptions {
        // Skip dev subscriptions
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }

        // An HTTP workspace that just failed is not asked again for
        // GATHER_REGISTRY_BACKOFF. Every read below costs a full 30s connect
        // timeout when the host is down, and there are several per subscription.
        if registry_is_backed_off(&sub.registry_url) {
            continue;
        }

        // RAW location — see `subscription_registry_path`.
        let (registry, scope) = match crate::calp_registry::open_workspace_scoped(&sub.registry_url)
        {
            Ok(r) => r,
            Err(_) => {
                mark_registry_unreachable(&sub.registry_url);
                continue;
            }
        };

        // Load the version manifest to get writeback regions. GATHER
        // materializes the surviving submissions into workbook cells, and the
        // region declaration governs on_approval filtering, own_only/anonymize
        // visibility, and schema + deadline integrity — so it MUST come from the
        // signature-verified manifest, never a raw (split-viewable) HTTP GET.
        //
        // REQUIRES AN EXISTING PIN. This runs on EVERY RECALC (eight call sites
        // on the calculation path, behind only a 2s TTL cache). As a pinning
        // site it re-armed continuously: it would silently RE-CREATE a pin the
        // user had just deleted from trusted-publishers.json, on the very next
        // keystroke. GATHER for an unpinned application now yields nothing.
        let ver_manifest = match calp::integrity::load_pinned_manifest_via(
            registry.as_ref(), &sub.package_name, &sub.resolved_version, &scope, &calcula_profile_dir(),
        ) {
            Ok(m) => {
                // Reached the host and read a verified manifest — whatever the
                // backoff thought, this workspace is alive.
                clear_registry_backoff(&sub.registry_url);
                m
            }
            // Could be an unreadable network OR a legitimately unpinned application.
            // Backing off either way is correct: the unpinned case yields
            // nothing however often it is retried, so retrying it every two
            // seconds over HTTP buys the user only latency.
            Err(_) => {
                mark_registry_unreachable(&sub.registry_url);
                continue;
            }
        };

        let regions = match &ver_manifest.writeback_regions {
            Some(r) => r,
            None => continue,
        };

        // Load the resolved version's current (folded) submissions in ONE tree
        // scan and bucket by region — per-region loads would rescan everything
        // R times.
        let mut current_by_region: std::collections::HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
            std::collections::HashMap::new();
        // THE ONE THAT FEEDS FORMULAS. A GATHER on a prod report that silently
        // included a tester's number would be wrong in the least visible way
        // this system can be wrong: the cell shows a plausible total and
        // nothing anywhere says where it came from.
        let environment = sub.environment.clone().unwrap_or_default();
        match registry
            .load_current_submissions(&sub.package_name, &sub.resolved_version)
            .map(|all| calp::writeback::visible_in(all, Some(&environment)))
        {
            Ok(all) => {
                for s in all {
                    current_by_region.entry(s.region_id.clone()).or_default().push(s);
                }
            }
            Err(_) => {
                mark_registry_unreachable(&sub.registry_url);
                continue;
            }
        }

        // Strictly OLDER versions, each loaded once: their region
        // declarations (for the schema-compatibility gate) and their
        // submissions bucketed by region.
        let older: Vec<(Vec<calp::WritebackRegionDeclaration>, std::collections::HashMap<String, Vec<calp::writeback::WritebackSubmission>>)> =
            older_package_versions(&registry, &sub.package_name, &sub.resolved_version)
                .iter()
                .filter_map(|version| {
                    // Older versions' region schemas gate lenient carry-forward;
                    // verify them exactly as the current version.
                    let manifest = calp::integrity::load_pinned_manifest_via(
                        registry.as_ref(), &sub.package_name, version, &scope, &calcula_profile_dir(),
                    )
                    .ok()?;
                    let mut by_region: std::collections::HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
                        std::collections::HashMap::new();
                    for s in calp::writeback::visible_in(
                        registry.load_current_submissions(&sub.package_name, version).ok()?,
                        Some(&environment),
                    ) {
                        by_region.entry(s.region_id.clone()).or_default().push(s);
                    }
                    Some((manifest.writeback_regions.unwrap_or_default(), by_region))
                })
                .collect();

        // The reader's own identity, for visibility enforcement.
        let own_identity = get_subscriber_identity(state).ok();

        // Aggregate per region
        for region in regions {
            let submissions = current_by_region.remove(&region.id).unwrap_or_default();

            // Lenient version binding: submissions made against earlier
            // versions of the same region carry forward instead of being
            // silently dropped on every version bump.
            let submissions = merge_lenient_submissions(submissions, &older, region);

            let submissions = apply_gather_governance(submissions, region, own_identity.as_ref());

            let gather_subs: Vec<engine::GatherSubmission> = submissions.iter().filter_map(|s| {
                let value = match &s.value {
                    calp::writeback::SubmissionValue::Number { value } => engine::EvalResult::Number(*value),
                    calp::writeback::SubmissionValue::Text { value } => engine::EvalResult::Text(value.clone()),
                    calp::writeback::SubmissionValue::Boolean { value } => engine::EvalResult::Boolean(*value),
                    // Governance already drops Empty; never coerce it to 0.0
                    // (that would inject a phantom zero into SUM/AVERAGE/COUNT).
                    calp::writeback::SubmissionValue::Empty => return None,
                };
                Some(engine::GatherSubmission {
                    submitter_name: s.submitter.display_name.clone(),
                    submitter_id: s.submitter.id.clone(),
                    // Carry the cell (0-based absolute) so GATHER.AT and the
                    // cell-aware GATHER.FROM/COUNT/SUBMITTERS forms can scope a
                    // multi-cell region's submissions to one input cell.
                    cell_row: s.cell_row,
                    cell_col: s.cell_col,
                    value,
                })
            }).collect();

            // First subscription declaring a region wins, matching the
            // submit path (owning_subscription_for_region) — last-wins here
            // would read a different workspace than submits write to.
            result
                .entry(region.id.clone())
                .or_insert(engine::GatherRegionData { submissions: gather_subs });
        }
    }

    if let Ok(mut cache) = state.gather_cache.lock() {
        *cache = Some((std::time::Instant::now(), result.clone()));
    }

    result
}

#[cfg(test)]
mod gather_hot_path_tests {
    //! GATHER must never do workspace I/O on the edit path, and an unreachable
    //! workspace must not be re-dialed every two seconds.

    use super::*;

    fn declaring_state() -> AppState {
        let state = crate::create_app_state();
        // A non-empty declaration set is what takes `build_gather_data` past its
        // free fast path; the content does not matter here.
        state
            .writeback_declarations
            .lock()
            .unwrap()
            .push(calp::WritebackRegionDeclaration {
                id: "region-1".to_string(),
                selector: calp::writeback::RegionSelector {
                    sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
                    row_start: 0,
                    row_end: 0,
                    col_start: 0,
                    col_end: 0,
                },
                mode: None,
                schema: None,
                visibility: None,
                submission_policy: None,
                version_binding: None,
                lifecycle: None,
                aggregation_hint: None,
                expected_respondents: Vec::new(),
                extra: Default::default(),
            });
        state
    }

    fn one_region_map() -> std::collections::HashMap<String, engine::GatherRegionData> {
        let mut m = std::collections::HashMap::new();
        m.insert(
            "region-1".to_string(),
            engine::GatherRegionData {
                submissions: vec![engine::GatherSubmission {
                    submitter_name: "Ann".to_string(),
                    submitter_id: "ann".to_string(),
                    cell_row: 0,
                    cell_col: 0,
                    value: engine::EvalResult::Number(7.0),
                }],
            },
        );
        m
    }

    /// THE hot-path property: an EXPIRED cache is still served immediately.
    ///
    /// This used to fall through to a full rebuild — open every subscribed
    /// workspace, read and Ed25519-verify a pinned manifest, scan the submission
    /// tree — INSIDE `update_cell`. Over an HTTP workspace that is
    /// `reqwest::blocking` with a 30-second timeout, so one keystroke could
    /// freeze the UI, and the 2-second TTL meant it froze again two seconds
    /// later. The refresh is now queued to a worker instead.
    #[test]
    fn an_expired_cache_is_served_immediately_instead_of_rebuilding() {
        let state = declaring_state();
        let stale_stamp = std::time::Instant::now()
            - (GATHER_CACHE_TTL + std::time::Duration::from_secs(60));
        *state.gather_cache.lock().unwrap() = Some((stale_stamp, one_region_map()));

        let data = build_gather_data(&state);

        assert_eq!(
            data.len(),
            1,
            "the last-known-good map must be returned even though the TTL expired"
        );
        assert_eq!(data["region-1"].submissions.len(), 1);
    }

    /// A workbook with no writeback declarations pays nothing at all — no cache
    /// read, no worker, no I/O.
    #[test]
    fn a_workbook_with_no_writeback_regions_returns_empty_without_touching_the_cache() {
        let state = crate::create_app_state();
        *state.gather_cache.lock().unwrap() = Some((std::time::Instant::now(), one_region_map()));

        assert!(
            build_gather_data(&state).is_empty(),
            "the fast path must not even consult the cache"
        );
    }

    /// An invalidation DROPS the map rather than serving something known to be
    /// untrue (a withdrawn submission, a detached region).
    #[test]
    fn invalidation_drops_the_cache() {
        let state = declaring_state();
        *state.gather_cache.lock().unwrap() = Some((std::time::Instant::now(), one_region_map()));

        invalidate_gather_cache(&state);

        assert!(state.gather_cache.lock().unwrap().is_none());
    }

    // --- Per-workspace failure backoff --------------------------------------

    #[test]
    fn an_unreachable_http_registry_is_backed_off_and_local_ones_never_are() {
        reset_gather_registry_backoff();
        let http = "https://registry.example.com/reg";
        let local = "file:///C:/regs/main";

        assert!(!registry_is_backed_off(http), "clean slate");

        mark_registry_unreachable(http);
        assert!(
            registry_is_backed_off(http),
            "an unreachable HTTP workspace must not be re-dialed every TTL window"
        );

        mark_registry_unreachable(local);
        assert!(
            !registry_is_backed_off(local),
            "a LOCAL registry fails in microseconds; backing it off would hide a \
             drive the user just reconnected"
        );

        clear_registry_backoff(http);
        assert!(
            !registry_is_backed_off(http),
            "a successful read must clear the backoff"
        );
        reset_gather_registry_backoff();
    }

    /// The change detector that decides whether a completed background refresh
    /// has to recalculate the workbook.
    #[test]
    fn the_fingerprint_tracks_content_not_ordering() {
        let a = one_region_map();
        let b = one_region_map();
        assert_eq!(gather_fingerprint(&a), gather_fingerprint(&b));

        let mut changed = one_region_map();
        changed.get_mut("region-1").unwrap().submissions[0].value =
            engine::EvalResult::Number(8.0);
        assert_ne!(
            gather_fingerprint(&a),
            gather_fingerprint(&changed),
            "a changed submission VALUE must trigger the recalculation"
        );

        let empty: std::collections::HashMap<String, engine::GatherRegionData> =
            std::collections::HashMap::new();
        assert_ne!(gather_fingerprint(&a), gather_fingerprint(&empty));
    }
}

#[cfg(test)]
mod writeback_rebuild_tests {
    //! Workbook OPEN must not block on HTTP workspaces, and a subscription whose
    //! regions could not be installed must say so.

    use super::*;

    /// `WRITEBACK_REBUILD_SEQ` is a PROCESS-GLOBAL ticket counter (that is the
    /// point of it — it is what makes a superseded worker install nothing), so
    /// two of these tests running concurrently supersede each other and the
    /// failures look like logic bugs. Serialize them.
    fn seq_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn subscription(package: &str, registry: &str) -> calp::manifest::Subscription {
        calp::manifest::Subscription {
            package_name: package.to_string(),
            registry_url: registry.to_string(),
            version_pin: "1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            environment: None,
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: Default::default(),
        }
    }

    fn state_with(subs: Vec<calp::manifest::Subscription>) -> AppState {
        let state = crate::create_app_state();
        state.subscriptions.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap().subscriptions = subs;
        state
    }

    /// THE open-path property: an HTTP subscription is DEFERRED, not walked.
    ///
    /// `open_file` used to call the synchronous rebuild, and each HTTP
    /// subscription costs two blocking artifact reads with a 30-second timeout —
    /// so opening a `.cala` naming an unreachable server hung the whole open
    /// before a single cell was drawn.
    #[test]
    fn http_subscriptions_are_deferred_on_the_open_path() {
        let _seq = seq_guard();
        let state = state_with(vec![subscription(
            "acme.finance",
            "https://registry.example.com/reg",
        )]);

        let outcome = rebuild_writeback_index_inner(&state, false, next_writeback_rebuild_seq());

        assert!(
            outcome.deferred_http,
            "the caller must be told to schedule the worker"
        );
        assert!(outcome.installed, "the local half still installs");
        let skips = state.writeback_rebuild_skips.lock().unwrap();
        assert_eq!(skips.len(), 1);
        assert_eq!(skips[0].reason, "deferred");
        assert_eq!(skips[0].package_name, "acme.finance");
    }

    /// Local workspaces stay INLINE — the write guards must be armed before the
    /// user can type, and a local read costs microseconds.
    #[test]
    fn local_subscriptions_are_never_deferred() {
        let _seq = seq_guard();
        let dir = tempfile::TempDir::new().unwrap();
        let location = format!("file:///{}", dir.path().display().to_string().replace('\\', "/"));
        let state = state_with(vec![subscription("acme.local", &location)]);

        let outcome = rebuild_writeback_index_inner(&state, false, next_writeback_rebuild_seq());

        assert!(
            !outcome.deferred_http,
            "a local workspace must be walked inline"
        );
        let skips = state.writeback_rebuild_skips.lock().unwrap();
        assert!(
            skips.iter().all(|s| s.reason != "deferred"),
            "a local workspace must never be deferred: {:?}",
            skips
        );
    }

    /// A subscription whose regions could not be installed is RECORDED, so the
    /// Subscriptions pane can distinguish "declares no writeback" from
    /// "writeback regions unknown - its protections are not in force".
    #[test]
    fn an_unopenable_registry_is_recorded_with_a_reason() {
        let _seq = seq_guard();
        let state = state_with(vec![subscription(
            "acme.gone",
            "file:///C:/definitely/not/a/registry/xyzzy",
        )]);

        rebuild_writeback_index_inner(&state, true, next_writeback_rebuild_seq());

        let skips = state.writeback_rebuild_skips.lock().unwrap();
        assert_eq!(skips.len(), 1, "the skip must be visible, not silent");
        assert_eq!(skips[0].package_name, "acme.gone");
        assert_ne!(skips[0].reason, "deferred");
        assert!(!skips[0].detail.is_empty(), "the reason needs a detail line");
    }

    /// A clean rebuild leaves NO skips — an empty list is what "every
    /// subscription's regions are live" looks like.
    #[test]
    fn a_workbook_with_no_subscriptions_records_no_skips() {
        let _seq = seq_guard();
        let state = state_with(Vec::new());
        assert!(
            !rebuild_writeback_index_inner(&state, false, next_writeback_rebuild_seq())
                .deferred_http
        );
        assert!(state.writeback_rebuild_skips.lock().unwrap().is_empty());
    }

    /// A DEV subscription carries no writeback and is not reported as a failure.
    ///
    /// It used to test a second shape beside it: a subscription whose pin began
    /// . Eleven skip sites checked for that prefix and NOTHING in the
    /// product ever produced one — this fixture was its only author. An
    /// ENVIRONMENT subscription is the real thing that vocabulary was reaching
    /// for, and it is the opposite of exempt: it has a workspace, a signed
    /// manifest, a concrete resolved version, and therefore writeback, GATHER
    /// and trust like any other. Skipping it would have been the defect the
    /// prefix invited.
    #[test]
    fn dev_subscriptions_are_skipped_without_a_report() {
        let _seq = seq_guard();
        let mut dev = subscription("acme.dev", "https://registry.example.com/reg");
        dev.version_pin = "dev".to_string();
        let state = state_with(vec![dev]);

        let outcome = rebuild_writeback_index_inner(&state, false, next_writeback_rebuild_seq());

        assert!(!outcome.deferred_http);
        assert!(state.writeback_rebuild_skips.lock().unwrap().is_empty());
    }

    /// THE deferred-worker hazard: the HTTP half finishes on a worker thread,
    /// and by then the user may have opened a DIFFERENT workbook. A superseded
    /// pass must install NOTHING — otherwise it puts one document's writeback
    /// regions on another document's cells, which is the same class of defect as
    /// inheriting the previous workbook's `subscriptions.json`.
    #[test]
    fn a_superseded_rebuild_installs_nothing() {
        let _seq = seq_guard();
        let dir = tempfile::TempDir::new().unwrap();
        let location = format!("file:///{}", dir.path().display().to_string().replace('\\', "/"));
        let state = state_with(vec![subscription("acme.local", &location)]);

        // Workbook A's ticket...
        let stale_seq = next_writeback_rebuild_seq();
        // ...then workbook B is opened, taking a newer one.
        let _newer = next_writeback_rebuild_seq();

        // Prove the install is what gets skipped: seed a marker the pass would
        // overwrite if it installed.
        state
            .writeback_rebuild_skips
            .lock()
            .unwrap()
            .push(WritebackRebuildSkip {
                package_name: "workbook-b-marker".to_string(),
                registry_url: String::new(),
                reason: "unreachable".to_string(),
                detail: "belongs to the workbook that is actually open".to_string(),
            });

        let outcome = rebuild_writeback_index_inner(&state, true, stale_seq);

        assert!(
            !outcome.installed,
            "a rebuild whose ticket is no longer the newest must not install"
        );
        let skips = state.writeback_rebuild_skips.lock().unwrap();
        assert_eq!(
            skips.len(),
            1,
            "the open workbook's state must be left exactly as it was"
        );
        assert_eq!(skips[0].package_name, "workbook-b-marker");
    }

    #[test]
    fn skip_reasons_classify_the_failures_the_pane_has_to_tell_apart() {
        use calp::error::CalpError as E;
        assert_eq!(
            calp_skip_reason(&E::PublisherNotPinned {
                package: "p".into(),
                version: "1.0.0".into(),
                scope: "s".into(),
                got: "k".into(),
            }),
            "notPinned"
        );
        assert_eq!(
            calp_skip_reason(&E::PublisherKeyChanged {
                package: "p".into(),
                version: "1.0.0".into(),
                pinned: "a".into(),
                got: "b".into(),
            }),
            "publisherChanged"
        );
        assert_eq!(
            calp_skip_reason(&E::ApplicationNotFound("p".into())),
            "unreachable"
        );
        assert_eq!(
            calp_skip_reason(&E::MissingChecksums {
                package: "p".into(),
                version: "1.0.0".into(),
            }),
            "badManifest"
        );
        assert_eq!(
            calp_skip_reason(&E::AppTooOld {
                package: "p".into(),
                version: "1.0.0".into(),
                required: "2.0.0".into(),
                current: "1.0.0".into(),
            }),
            "appTooOld"
        );
    }
}

#[cfg(test)]
mod gather_governance_tests {
    //! Unit tests for `apply_gather_governance` — the writeback privacy/approval
    //! boundary extracted (behavior-preserving) out of `build_gather_data`. This
    //! is the GATHER governance safety net (roadmap D4 / D10): it must never
    //! silently change which submissions are visible or whether other
    //! submitters' identities leak.
    use super::apply_gather_governance;
    use std::collections::HashMap;

    use calp::writeback::{
        LifecyclePolicy, RegionSelector, SubmissionPolicy, SubmissionState, SubmissionValue,
        ValueSchema, ValueType, VisibilityPolicy, WritebackRegionDeclaration, WritebackSubmission,
    };
    use calp::SubmitterIdentity;

    fn make_identity(id: &str, name: &str) -> SubmitterIdentity {
        SubmitterIdentity {
            display_name: name.to_string(),
            id: id.to_string(),
            extra: HashMap::new(),
        }
    }

    /// Build a submission for the "r" region at cell (0,0) from one submitter
    /// with a given state and value. Only the fields the governance step reads
    /// (submitter, value, state) vary; the rest are stable filler.
    fn make_submission(
        submitter_id: &str,
        name: &str,
        state: SubmissionState,
        value: SubmissionValue,
    ) -> WritebackSubmission {
        WritebackSubmission {
            environment: String::new(),
            id: format!("sub-{submitter_id}"),
            model_key: None,
            region_id: "r".to_string(),
            cell_row: 0,
            cell_col: 0,
            cell_id: None,
            submitter: make_identity(submitter_id, name),
            value,
            state,
            created_at: "2026-06-15T00:00:00Z".to_string(),
            updated_at: "2026-06-15T00:00:00Z".to_string(),
            submitted_at: None,
            review_reason: None,
            reviewed_by: None,
            extra: HashMap::new(),
        }
    }

    /// Build a region declaration carrying only the two governance-relevant
    /// policies; the selector is a 1x1 placeholder (governance ignores it).
    fn make_region(
        visibility: Option<VisibilityPolicy>,
        policy: Option<SubmissionPolicy>,
    ) -> WritebackRegionDeclaration {
        let sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());
        WritebackRegionDeclaration {
            id: "r".to_string(),
            selector: RegionSelector {
                sheet_id,
                row_start: 0,
                row_end: 0,
                col_start: 0,
                col_end: 0,
            },
            mode: None,
            schema: None,
            visibility,
            submission_policy: policy,
            version_binding: None,
            lifecycle: None,
            aggregation_hint: None,
            expected_respondents: Vec::new(),
            extra: HashMap::new(),
        }
    }

    fn num(v: f64) -> SubmissionValue {
        SubmissionValue::Number { value: v }
    }

    // 1. OnApproval: a Submitted submission is EXCLUDED, an Approved one INCLUDED.
    #[test]
    fn on_approval_excludes_submitted_includes_approved() {
        let region = make_region(None, Some(SubmissionPolicy::OnApproval));
        let subs = vec![
            make_submission("alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("bob", "Bob", SubmissionState::Approved, num(20.0)),
        ];
        let out = apply_gather_governance(subs, &region, None);
        assert_eq!(out.len(), 1, "only the Approved submission survives on_approval");
        assert_eq!(out[0].submitter.id, "bob");
        assert!(matches!(out[0].value, SubmissionValue::Number { value } if value == 20.0));
    }

    // 2. Immediate / OnSubmit / None: a Submitted submission is INCLUDED.
    #[test]
    fn non_approval_policies_include_submitted() {
        for policy in [
            None,
            Some(SubmissionPolicy::Immediate),
            Some(SubmissionPolicy::OnSubmit),
        ] {
            let region = make_region(None, policy.clone());
            let subs = vec![make_submission(
                "alice",
                "Alice",
                SubmissionState::Submitted,
                num(10.0),
            )];
            let out = apply_gather_governance(subs, &region, None);
            assert_eq!(
                out.len(),
                1,
                "Submitted must be included under policy {policy:?}"
            );
        }
    }

    // 3. Rejected and Draft: always EXCLUDED regardless of policy.
    #[test]
    fn rejected_and_draft_always_excluded() {
        for policy in [
            None,
            Some(SubmissionPolicy::Immediate),
            Some(SubmissionPolicy::OnSubmit),
            Some(SubmissionPolicy::OnApproval),
        ] {
            let region = make_region(None, policy.clone());
            let subs = vec![
                make_submission("a", "A", SubmissionState::Rejected, num(1.0)),
                make_submission("b", "B", SubmissionState::Draft, num(2.0)),
            ];
            let out = apply_gather_governance(subs, &region, None);
            assert!(
                out.is_empty(),
                "Rejected + Draft must both be dropped under policy {policy:?}"
            );
        }
    }

    // 4. Empty value: EXCLUDED (a cleared cell is "no submission", not a zero).
    #[test]
    fn empty_value_excluded() {
        let region = make_region(None, None);
        let subs = vec![
            make_submission("a", "A", SubmissionState::Submitted, SubmissionValue::Empty),
            make_submission("b", "B", SubmissionState::Submitted, num(5.0)),
        ];
        let out = apply_gather_governance(subs, &region, None);
        assert_eq!(out.len(), 1, "the Empty submission is dropped");
        assert_eq!(out[0].submitter.id, "b");
    }

    // 5. OwnOnly: with own_identity = Alice, only Alice's submissions remain.
    #[test]
    fn own_only_keeps_only_own() {
        let region = make_region(Some(VisibilityPolicy::OwnOnly), None);
        let alice = make_identity("id-alice", "Alice");
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("id-bob", "Bob", SubmissionState::Submitted, num(20.0)),
        ];
        let out = apply_gather_governance(subs, &region, Some(&alice));
        assert_eq!(out.len(), 1, "only Alice's own submission remains");
        assert_eq!(out[0].submitter.id, "id-alice");
        assert_eq!(out[0].submitter.display_name, "Alice");
    }

    // 6. OwnPlusAggregate: Bob's value REMAINS but his identity is anonymized;
    //    Alice's own row is untouched (real id + name).
    #[test]
    fn own_plus_aggregate_anonymizes_others_keeps_values() {
        let region = make_region(Some(VisibilityPolicy::OwnPlusAggregate), None);
        let alice = make_identity("id-alice", "Alice");
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("id-bob", "Bob", SubmissionState::Submitted, num(20.0)),
        ];
        let out = apply_gather_governance(subs, &region, Some(&alice));
        assert_eq!(out.len(), 2, "both values flow into the aggregate");

        let own = out.iter().find(|s| s.submitter.id == "id-alice").expect("own row present");
        assert_eq!(own.submitter.display_name, "Alice", "own identity untouched");
        assert!(matches!(own.value, SubmissionValue::Number { value } if value == 10.0));

        let other = out
            .iter()
            .find(|s| matches!(s.value, SubmissionValue::Number { value } if value == 20.0))
            .expect("Bob's value preserved");
        assert_eq!(
            other.submitter.display_name, "Submitter 1",
            "Bob anonymized to a stable distinct token"
        );
        assert_eq!(other.submitter.id, "", "Bob's id cleared");
    }

    // 7. Transparent / None visibility: all submissions remain with real identities.
    #[test]
    fn transparent_and_none_keep_real_identities() {
        for visibility in [None, Some(VisibilityPolicy::Transparent)] {
            let region = make_region(visibility.clone(), None);
            let alice = make_identity("id-alice", "Alice");
            let subs = vec![
                make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
                make_submission("id-bob", "Bob", SubmissionState::Submitted, num(20.0)),
            ];
            let out = apply_gather_governance(subs, &region, Some(&alice));
            assert_eq!(out.len(), 2, "all submissions remain under {visibility:?}");
            let bob = out.iter().find(|s| s.submitter.id == "id-bob").expect("Bob present");
            assert_eq!(bob.submitter.display_name, "Bob", "Bob's real name kept under {visibility:?}");
        }
    }

    // 8. own_identity = None + OwnOnly: everything is dropped (no own to match) —
    //    documents the fail-closed behavior.
    #[test]
    fn own_only_with_no_identity_drops_everything() {
        let region = make_region(Some(VisibilityPolicy::OwnOnly), None);
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("id-bob", "Bob", SubmissionState::Submitted, num(20.0)),
        ];
        let out = apply_gather_governance(subs, &region, None);
        assert!(
            out.is_empty(),
            "without an own identity, own_only fails closed and reveals nothing"
        );
    }

    // 8b. (C2b) A BLANK own id must fail closed exactly like None: a corrupt
    //     subscriber-identity.json with "id":"" would otherwise match every
    //     anonymized/empty-id record and leak it under own_only.
    #[test]
    fn own_only_with_blank_id_fails_closed() {
        let region = make_region(Some(VisibilityPolicy::OwnOnly), None);
        let ghost = make_identity("", "Ghost"); // blank principal
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            // A planted record with an empty submitter id (what OwnPlusAggregate
            // itself produces) — must NOT be revealed to a blank reader.
            make_submission("", "(anonymized)", SubmissionState::Submitted, num(99.0)),
        ];
        let out = apply_gather_governance(subs, &region, Some(&ghost));
        assert!(
            out.is_empty(),
            "a blank reader id reveals nothing, even the empty-id record"
        );
    }

    // 8c. (C2b) OwnPlusAggregate with a blank own id anonymizes EVERYONE — even
    //     the empty-id records OwnPlusAggregate itself produces. We PLANT a
    //     submission with a blank id: under the OLD un-trimmed predicate
    //     own.id("") == submitter.id("") it would be claimed as "own" and keep
    //     its real name; the trim fix anonymizes it like everyone else. (This
    //     planted blank-id row is what makes the test turn RED on the pre-fix
    //     code — a whitespace-only own id alone would have passed on both.)
    #[test]
    fn own_plus_aggregate_with_blank_id_anonymizes_all() {
        let region = make_region(Some(VisibilityPolicy::OwnPlusAggregate), None);
        let ghost = make_identity("", "Ghost"); // blank principal
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("", "Planted", SubmissionState::Submitted, num(99.0)),
        ];
        let out = apply_gather_governance(subs, &region, Some(&ghost));
        assert_eq!(out.len(), 2, "values still flow for the aggregate");
        for s in &out {
            assert_eq!(s.submitter.id, "", "every id is cleared under a blank reader");
            assert!(
                s.submitter.display_name != "Alice" && s.submitter.display_name != "Planted",
                "no real submitter name survives for a blank reader (got {:?})",
                s.submitter.display_name
            );
        }
    }

    // --- Read-side integrity (P0): schema + deadline filtering ---

    fn make_region_with(
        schema: Option<ValueSchema>,
        lifecycle: Option<LifecyclePolicy>,
    ) -> WritebackRegionDeclaration {
        let mut r = make_region(None, None);
        r.schema = schema;
        r.lifecycle = lifecycle;
        r
    }

    fn number_schema(min: f64, max: f64) -> ValueSchema {
        ValueSchema {
            value_type: ValueType::Number,
            required: false,
            min: Some(min),
            max: Some(max),
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        }
    }

    fn make_submission_at(
        submitter_id: &str,
        state: SubmissionState,
        value: SubmissionValue,
        submitted_at: Option<&str>,
    ) -> WritebackSubmission {
        let mut s = make_submission(submitter_id, submitter_id, state, value);
        s.submitted_at = submitted_at.map(|t| t.to_string());
        s
    }

    // 9. A hand-written out-of-range or wrong-type value never reaches an
    //    aggregate — the read-side schema gate drops it.
    #[test]
    fn schema_drops_out_of_range_and_wrong_type_values() {
        let region = make_region_with(Some(number_schema(0.0, 100.0)), None);
        let subs = vec![
            make_submission("ok", "Ok", SubmissionState::Submitted, num(50.0)),
            make_submission("hi", "Hi", SubmissionState::Submitted, num(9999.0)),
            make_submission(
                "txt",
                "Txt",
                SubmissionState::Submitted,
                SubmissionValue::Text { value: "oops".to_string() },
            ),
        ];
        let out = apply_gather_governance(subs, &region, None);
        assert_eq!(out.len(), 1, "only the in-range numeric value survives");
        assert_eq!(out[0].submitter.id, "ok");
    }

    // 10. A submission made at/after an until_deadline cutoff is dropped at read
    //     time; one made before is kept; one lacking submitted_at is best-effort kept.
    #[test]
    fn deadline_drops_late_submissions() {
        let region = make_region_with(
            None,
            Some(LifecyclePolicy::UntilDeadline {
                deadline: Some("2026-06-15T12:00:00Z".to_string()),
            }),
        );
        let subs = vec![
            make_submission_at("early", SubmissionState::Submitted, num(1.0), Some("2026-06-15T09:00:00Z")),
            make_submission_at("late", SubmissionState::Submitted, num(2.0), Some("2026-06-15T15:00:00Z")),
            make_submission_at("untimed", SubmissionState::Submitted, num(3.0), None),
        ];
        let out = apply_gather_governance(subs, &region, None);
        let ids: Vec<String> = out.iter().map(|s| s.submitter.id.clone()).collect();
        assert!(ids.contains(&"early".to_string()), "before-deadline submission kept");
        assert!(!ids.contains(&"late".to_string()), "after-deadline submission dropped");
        assert!(ids.contains(&"untimed".to_string()), "no timestamp -> best-effort kept");
        assert_eq!(out.len(), 2);
    }

    // 11. Completion tracking: expected respondents are matched (case-insensitive,
    //     with a substring fallback either way) against who actually submitted;
    //     the rest are reported as missing; a blank expected entry is ignored.
    #[test]
    fn response_status_matches_and_lists_missing() {
        let mut respondents = HashMap::new();
        respondents.insert("id-north".to_string(), "Alice (North)".to_string());
        respondents.insert("id-south".to_string(), "Bob".to_string());
        let st = super::compute_response_status(
            vec![
                "Alice".into(),      // substring of "Alice (North)"
                "bob".into(),        // case-insensitive match of "Bob"
                "id-south".into(),   // match by id
                "Carol".into(),      // nobody -> missing
                "  ".into(),         // blank -> ignored
            ],
            &respondents,
        );
        assert_eq!(st.missing, vec!["Carol".to_string()]);
        assert_eq!(st.responded, vec!["Alice (North)".to_string(), "Bob".to_string()]);
    }
}

#[cfg(test)]
mod audit_summary_tests {
    //! `summarize_ids` bounds the audit description a refresh writes when it
    //! invalidates writeback regions — a 200-region application must not produce a
    //! 200-id line in the workbook's audit log.
    use super::summarize_ids;

    #[test]
    fn summarize_ids_empty() {
        assert_eq!(summarize_ids(std::iter::empty()), "");
    }

    #[test]
    fn summarize_ids_lists_all_when_short() {
        assert_eq!(summarize_ids(["a", "b", "c"].into_iter()), "a, b, c");
    }

    #[test]
    fn summarize_ids_truncates_with_remainder_count() {
        // Zero-padded so lexicographic order (what summarize_ids applies) and
        // numeric order agree, keeping the expectation readable.
        let ids: Vec<String> = (0..12).map(|i| format!("r{:02}", i)).collect();
        let out = summarize_ids(ids.iter().map(|s| s.as_str()));
        assert_eq!(out, "r00, r01, r02, r03, r04, r05, r06, r07, +4 more");
    }

    #[test]
    fn summarize_ids_exactly_at_cap_has_no_tail() {
        let ids: Vec<String> = (0..8).map(|i| format!("r{}", i)).collect();
        let out = summarize_ids(ids.iter().map(|s| s.as_str()));
        assert!(!out.contains("more"), "no tail expected at the cap: {}", out);
    }

    #[test]
    fn summarize_ids_is_order_independent() {
        // Callers pass HashSet iterators; the same set must always render the
        // same string (and pick the same 8) no matter the iteration order.
        let forward = summarize_ids(["c", "a", "b"].into_iter());
        let reverse = summarize_ids(["b", "c", "a"].into_iter());
        assert_eq!(forward, reverse);
        assert_eq!(forward, "a, b, c");

        let many: Vec<String> = (0..12).map(|i| format!("r{:02}", i)).collect();
        let asc = summarize_ids(many.iter().map(|s| s.as_str()));
        let desc = summarize_ids(many.iter().rev().map(|s| s.as_str()));
        assert_eq!(asc, desc);
        assert!(asc.starts_with("r00, r01"), "{}", asc);
    }
}

#[cfg(test)]
mod merge_lenient_tests {
    //! Parity tests for `merge_lenient_submissions` — the version carry-forward
    //! loop extracted (behavior-preserving) out of `build_gather_data` so the
    //! writeback dataset builder merges identically. These pin the extracted
    //! behavior: slot newest-wins, strict binding, schema gate, absent region.
    use super::merge_lenient_submissions;
    use std::collections::HashMap;

    use calp::writeback::{
        RegionSelector, SubmissionState, SubmissionValue, ValueSchema, ValueType, VersionBinding,
        WritebackRegionDeclaration, WritebackSubmission,
    };
    use calp::SubmitterIdentity;

    /// One stable sheet id for the whole module. The same region id across two
    /// application versions necessarily sits on the same sheet, so minting a fresh
    /// random id per fixture call would have made every "old version" look like
    /// it lived somewhere else — which the geometry gate (correctly) treats as
    /// incompatible.
    fn fixed_sheet() -> identity::SheetId {
        identity::SheetId::from_bytes([7u8; 16])
    }

    fn region(
        version_binding: Option<VersionBinding>,
        schema: Option<ValueSchema>,
    ) -> WritebackRegionDeclaration {
        region_at(version_binding, schema, 0, 0, 0, 0)
    }

    /// A region with an explicit selector, for the geometry-gate tests.
    fn region_at(
        version_binding: Option<VersionBinding>,
        schema: Option<ValueSchema>,
        row_start: u32,
        row_end: u32,
        col_start: u32,
        col_end: u32,
    ) -> WritebackRegionDeclaration {
        WritebackRegionDeclaration {
            id: "r".to_string(),
            selector: RegionSelector {
                sheet_id: fixed_sheet(),
                row_start,
                row_end,
                col_start,
                col_end,
            },
            mode: None,
            schema,
            visibility: None,
            submission_policy: None,
            version_binding,
            lifecycle: None,
            aggregation_hint: None,
            expected_respondents: Vec::new(),
            extra: HashMap::new(),
        }
    }

    fn schema_of(value_type: ValueType) -> ValueSchema {
        ValueSchema {
            value_type,
            required: false,
            min: None,
            max: None,
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        }
    }

    fn submission(submitter_id: &str, value: f64, updated_at: &str) -> WritebackSubmission {
        WritebackSubmission {
            environment: String::new(),
            id: format!("sub-{submitter_id}-{updated_at}"),
            model_key: None,
            region_id: "r".to_string(),
            cell_row: 0,
            cell_col: 0,
            cell_id: None,
            submitter: SubmitterIdentity {
                display_name: submitter_id.to_string(),
                id: submitter_id.to_string(),
                extra: HashMap::new(),
            },
            value: SubmissionValue::Number { value },
            state: SubmissionState::Submitted,
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
            submitted_at: Some(updated_at.to_string()),
            review_reason: None,
            reviewed_by: None,
            extra: HashMap::new(),
        }
    }

    fn older_with(
        region_decl: Option<WritebackRegionDeclaration>,
        subs: Vec<WritebackSubmission>,
    ) -> (
        Vec<WritebackRegionDeclaration>,
        HashMap<String, Vec<WritebackSubmission>>,
    ) {
        let mut by_region = HashMap::new();
        if !subs.is_empty() {
            by_region.insert("r".to_string(), subs);
        }
        (region_decl.into_iter().collect(), by_region)
    }

    // 1. Carry-forward fills a missing slot; an occupied slot keeps whichever
    //    record has the NEWEST updated_at (both directions).
    #[test]
    fn carry_forward_fills_slots_and_newest_wins() {
        let r = region(None, None);
        let current = vec![submission("alice", 10.0, "2026-06-20T10:00:00Z")];
        let older = vec![older_with(
            Some(region(None, None)),
            vec![
                submission("alice", 1.0, "2026-06-10T10:00:00Z"), // older -> current wins
                submission("bob", 2.0, "2026-06-11T10:00:00Z"),   // new slot -> carried
            ],
        )];
        let out = merge_lenient_submissions(current, &older, &r);
        assert_eq!(out.len(), 2);
        let alice = out.iter().find(|s| s.submitter.id == "alice").unwrap();
        assert_eq!(alice.value, SubmissionValue::Number { value: 10.0 });
        assert!(out.iter().any(|s| s.submitter.id == "bob"));

        // Reverse: the OLDER version holds the newer record for the same slot.
        let r2 = region(None, None);
        let current2 = vec![submission("alice", 10.0, "2026-06-05T10:00:00Z")];
        let older2 = vec![older_with(
            Some(region(None, None)),
            vec![submission("alice", 99.0, "2026-06-10T10:00:00Z")],
        )];
        let out2 = merge_lenient_submissions(current2, &older2, &r2);
        assert_eq!(out2.len(), 1);
        assert_eq!(out2[0].value, SubmissionValue::Number { value: 99.0 });
    }

    // 2. Strict version binding disables carry-forward entirely.
    #[test]
    fn strict_binding_carries_nothing() {
        let r = region(Some(VersionBinding::Strict), None);
        let older = vec![older_with(
            Some(region(None, None)),
            vec![submission("bob", 2.0, "2026-06-11T10:00:00Z")],
        )];
        let out = merge_lenient_submissions(Vec::new(), &older, &r);
        assert!(out.is_empty());
    }

    // 3. Schema gate: an older version with an INCOMPATIBLE schema is skipped;
    //    a compatible (identical) schema is carried; either side lacking a
    //    schema counts as compatible.
    #[test]
    fn schema_gate_controls_carry() {
        let r = region(None, Some(schema_of(ValueType::Number)));
        let incompatible = vec![older_with(
            Some(region(None, Some(schema_of(ValueType::Text)))),
            vec![submission("bob", 2.0, "2026-06-11T10:00:00Z")],
        )];
        assert!(merge_lenient_submissions(Vec::new(), &incompatible, &r).is_empty());

        let compatible = vec![older_with(
            Some(region(None, Some(schema_of(ValueType::Number)))),
            vec![submission("bob", 2.0, "2026-06-11T10:00:00Z")],
        )];
        assert_eq!(merge_lenient_submissions(Vec::new(), &compatible, &r).len(), 1);

        let schemaless_old = vec![older_with(
            Some(region(None, None)),
            vec![submission("bob", 2.0, "2026-06-11T10:00:00Z")],
        )];
        assert_eq!(
            merge_lenient_submissions(Vec::new(), &schemaless_old, &r).len(),
            1
        );
    }

    // 4. A version where the region did not exist yet carries nothing, even if
    //    stray submission files name the region id.
    #[test]
    fn region_absent_in_older_version_carries_nothing() {
        let r = region(None, None);
        let older = vec![older_with(
            None, // region not declared in that version
            vec![submission("bob", 2.0, "2026-06-11T10:00:00Z")],
        )];
        assert!(merge_lenient_submissions(Vec::new(), &older, &r).is_empty());
    }

    // 5. GEOMETRY GATE (parity with check_region_compatibility): submissions are
    //    keyed by ABSOLUTE cell coordinates, so a region that moved or shrank
    //    between versions must carry nothing — otherwise last version's answers
    //    are re-filed against cells that now hold a different field.
    #[test]
    fn moved_region_carries_nothing() {
        let current = region_at(None, None, 5, 9, 0, 3); // slid down 5 rows
        let older = vec![older_with(
            Some(region_at(None, None, 0, 4, 0, 3)),
            vec![submission("bob", 2.0, "2026-06-11T10:00:00Z")],
        )];
        assert!(
            merge_lenient_submissions(Vec::new(), &older, &current).is_empty(),
            "a moved region must not drag old answers onto the new cells"
        );
    }

    #[test]
    fn shrunk_region_carries_nothing() {
        let current = region_at(None, None, 0, 4, 0, 1); // lost columns
        let older = vec![older_with(
            Some(region_at(None, None, 0, 4, 0, 3)),
            vec![submission("bob", 2.0, "2026-06-11T10:00:00Z")],
        )];
        assert!(merge_lenient_submissions(Vec::new(), &older, &current).is_empty());
    }

    #[test]
    fn grown_region_with_same_origin_still_carries() {
        // The benign edit: the author extended the form. Every stored answer
        // still sits at the same cell meaning the same thing, so carry-forward
        // must keep working — this is what stops the gate being over-eager.
        let current = region_at(None, None, 0, 20, 0, 5);
        let older = vec![older_with(
            Some(region_at(None, None, 0, 4, 0, 3)),
            vec![submission("bob", 2.0, "2026-06-11T10:00:00Z")],
        )];
        assert_eq!(
            merge_lenient_submissions(Vec::new(), &older, &current).len(),
            1
        );
    }
}

#[cfg(test)]
mod writeback_export_tests {
    //! The Parquet export/rollup encoder (used by both the on-demand export and
    //! the auto-materialized `_rollup.parquet`).
    use super::{a1, encode_submissions_parquet};
    use calp::writeback::{SubmissionState, SubmissionValue, WritebackSubmission};
    use calp::SubmitterIdentity;
    use std::collections::HashMap;

    fn sub(row: u32, col: u32, value: SubmissionValue) -> WritebackSubmission {
        WritebackSubmission {
            environment: String::new(),
            id: format!("s-{row}-{col}"),
            model_key: None,
            region_id: "r1".to_string(),
            cell_row: row,
            cell_col: col,
            cell_id: None,
            submitter: SubmitterIdentity {
                display_name: "Alice".into(),
                id: "id-alice".into(),
                extra: HashMap::new(),
            },
            value,
            state: SubmissionState::Submitted,
            created_at: "2026-06-15T00:00:00Z".into(),
            updated_at: "2026-06-15T00:00:00Z".into(),
            submitted_at: Some("2026-06-15T00:00:00Z".into()),
            review_reason: None,
            reviewed_by: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn a1_reference_formatting() {
        assert_eq!(a1(0, 0), "A1");
        assert_eq!(a1(1, 1), "B2");
        assert_eq!(a1(0, 26), "AA1");
        assert_eq!(a1(4, 1), "B5");
    }

    #[test]
    fn parquet_encodes_mixed_types_to_a_valid_container() {
        let subs = vec![
            sub(1, 1, SubmissionValue::Number { value: 100.0 }),
            sub(2, 1, SubmissionValue::Text { value: "north".into() }),
            sub(3, 1, SubmissionValue::Boolean { value: true }),
            sub(4, 1, SubmissionValue::Empty),
        ];
        let bytes = encode_submissions_parquet(&subs).unwrap();
        // A well-formed Parquet file is framed by the "PAR1" magic at both ends;
        // ArrowWriter + RecordBatch::try_new also validate schema/column shape.
        assert!(bytes.len() > 8);
        assert_eq!(&bytes[0..4], b"PAR1", "parquet header magic");
        assert_eq!(&bytes[bytes.len() - 4..], b"PAR1", "parquet footer magic");
    }

    #[test]
    fn parquet_handles_empty_input() {
        let bytes = encode_submissions_parquet(&[]).unwrap();
        assert_eq!(&bytes[0..4], b"PAR1");
        assert_eq!(&bytes[bytes.len() - 4..], b"PAR1");
    }

    // Integration: the auto-materialize writes a real rollup into a real
    // workspace, it reads back as Parquet with one row per slot, and it is
    // invisible to the integrity walk (so it never trips pull) and to
    // submission loading.
    #[test]
    fn rollup_materializes_reads_back_and_is_integrity_excluded() {
        use calp::workspace::LocalWorkspace;
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

        // A throwaway workspace under the OS temp dir.
        let root = std::env::temp_dir().join(format!("calcula_wb_rollup_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let reg = LocalWorkspace::open(&root).unwrap();

        // Two submissions (two slots) — one numeric, one text — plus a
        // RESUBMISSION of the first slot (a third event file): the rollup must
        // hold the folded view, one row per current slot.
        reg.save_submission("pkg", "1.0.0", &sub(1, 1, SubmissionValue::Number { value: 100.0 })).unwrap();
        reg.save_submission("pkg", "1.0.0", &sub(2, 1, SubmissionValue::Text { value: "north".into() })).unwrap();
        let mut corrected = sub(1, 1, SubmissionValue::Number { value: 105.0 });
        corrected.id = "s-1-1-rev2".into();
        corrected.updated_at = "2026-06-15T01:00:00Z".into();
        reg.save_submission("pkg", "1.0.0", &corrected).unwrap();

        super::materialize_submissions_parquet(&reg, "pkg", "1.0.0");

        // The rollup exists under submissions/ and reads back as Parquet.
        let path = reg
            .version_dir("pkg", "1.0.0")
            .unwrap()
            .join("submissions")
            .join("_rollup.parquet");
        assert!(path.exists(), "rollup file written");
        let file = std::fs::File::open(&path).unwrap();
        let reader = ParquetRecordBatchReaderBuilder::try_new(file).unwrap().build().unwrap();
        let batches: Vec<_> = reader.map(|b| b.unwrap()).collect();
        // The event-id column travels into the rollup (traceability back to
        // the JSON event files).
        assert!(
            batches
                .iter()
                .any(|b| b.schema().fields().iter().any(|f| f.name() == "submission_id")),
            "submission_id column present"
        );
        let total: usize = batches.iter().map(|b| b.num_rows()).sum();
        assert_eq!(total, 2, "one row per current slot despite three event files");

        // Excluded from the integrity walk (never an "unlisted artifact" on pull)...
        let arts = reg.list_artifacts("pkg", "1.0.0").unwrap();
        assert!(!arts.iter().any(|a| a.contains("_rollup")), "rollup excluded from artifacts");
        // ...and ignored by submission loading: three raw events, two current.
        assert_eq!(reg.load_submission_events("pkg", "1.0.0").unwrap().len(), 3);
        assert_eq!(reg.load_current_submissions("pkg", "1.0.0").unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollup_toggle_defaults_off_and_flips_on() {
        use calp::manifest::ApplicationManifest;
        use calp::workspace::LocalWorkspace;

        let root = std::env::temp_dir().join(format!("calcula_wb_toggle_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let reg = LocalWorkspace::open(&root).unwrap();

        let mut pm = ApplicationManifest::new("pkg", "report", "auth", "2026-01-01T00:00:00Z");
        reg.write_application_manifest(&pm).unwrap();
        // Default OFF (opt-in).
        assert!(!super::rollup_enabled(&reg, "pkg"));

        // Publisher flips it on (what calp_set_writeback_rollup persists).
        pm.extra
            .insert("writebackRollup".to_string(), serde_json::Value::Bool(true));
        reg.write_application_manifest(&pm).unwrap();
        assert!(super::rollup_enabled(&reg, "pkg"));

        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Look up the CellId at a position without minting. Returns null if none exists.
#[tauri::command]
pub fn calp_get_cell_id(
    state: State<AppState>,
    sheet_id: String,
    row: u32,
    col: u32,
    window: tauri::Window,
) -> Result<Option<String>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let reg = state.id_registry.lock().map_err(|e| e.to_string())?;
    Ok(reg.lookup_cell_id(sid, (row, col)).map(|id| id.to_string()))
}

/// Get the current subscriber identity (creates one on first call).
#[tauri::command]
pub fn calp_get_subscriber_identity(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::SubmitterIdentity, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    get_subscriber_identity(&state)
}

/// Suggest the next version for an application given a bump type ("major", "minor", "patch").
#[tauri::command]
pub fn calp_next_version(
    registry_path: String,
    package_name: String,
    bump: String,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&registry_path)
        .map_err(|e| e.to_string())?;

    let manifest = registry.get_application_manifest(&package_name)
        .map_err(|e| e.to_string())?;

    // Parse all available versions and find the latest.
    let mut versions: Vec<SemVer> = manifest.versions.iter()
        .filter_map(|entry| SemVer::parse(&entry.version).ok())
        .collect();

    let next = if versions.is_empty() {
        // No published versions yet — start at 1.0.0.
        SemVer::new(1, 0, 0)
    } else {
        versions.sort();
        let latest = versions.last().unwrap();
        match bump.to_lowercase().as_str() {
            "major" => SemVer::new(latest.major + 1, 0, 0),
            "minor" => SemVer::new(latest.major, latest.minor + 1, 0),
            "patch" => SemVer::new(latest.major, latest.minor, latest.patch + 1),
            other => return Err(format!(
                "Invalid bump type '{}'. Expected 'major', 'minor', or 'patch'.", other
            )),
        }
    };

    Ok(next.to_string())
}

// ============================================================================
// Pivot Restoration for Pulled Applications
// ============================================================================

/// Connection spec info extracted from a model's connectionSpecs.
pub struct ConnectionSpecInfo {
    pub server: String,
    pub database: String,
    pub connector_type: String,
    pub preferred_auth: String,
}

/// Extract server, database, connector type, and preferred auth from a model's
/// connection metadata. Two shapes exist:
/// - legacy Studio-era `connectionSpecs` at the ModelBundle wrapper level;
/// - the engine's persisted sources catalog (v14+) at `model.sources` —
///   `{ id, kind, preferred_auth, connection: { host, port, database } }` —
///   which is what Model-Editor-authored models carry. Without this fallback a
///   subscribed application's connection lands with an empty database and any
///   live connect silently targets the user's default database (where the
///   model's schema does not exist).
pub fn extract_connection_spec_info(model_json: &serde_json::Value) -> ConnectionSpecInfo {
    let host_port_to_server = |host: &str, port: Option<u64>| -> String {
        match port {
            Some(p) if p != 5432 => format!("{}:{}", host, p),
            _ => host.to_string(),
        }
    };

    if let Some(specs) = model_json.get("connectionSpecs").and_then(|s| s.as_array()) {
        if let Some(spec) = specs.first() {
            let connector_type = spec.get("connectorType")
                .and_then(|v| v.as_str())
                .unwrap_or("PostgreSQL")
                .to_string();
            let preferred_auth = spec.get("preferred_auth")
                .and_then(|v| v.as_str())
                .unwrap_or("UsernamePassword")
                .to_string();
            if let Some(target) = spec.get("target") {
                let host = target.get("host").and_then(|v| v.as_str()).unwrap_or("");
                let port = target.get("port").and_then(|v| v.as_u64());
                let database = target.get("database").and_then(|v| v.as_str()).unwrap_or("").to_string();
                return ConnectionSpecInfo {
                    server: host_port_to_server(host, port),
                    database,
                    connector_type,
                    preferred_auth,
                };
            }
        }
    }

    // Persisted sources catalog (engine v14+): first database-kind source wins.
    let inner_model = model_json.get("model").unwrap_or(model_json);
    if let Some(sources) = inner_model.get("sources").and_then(|s| s.as_array()) {
        for src in sources {
            let kind = src.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let connector_type = match kind {
                "postgres" => "PostgreSQL",
                "sqlserver" => "SqlServer",
                _ => continue, // in-memory / file sources carry no server target
            };
            let preferred_auth = match src.get("preferred_auth").and_then(|v| v.as_str()) {
                Some(a) if a.eq_ignore_ascii_case("integrated") => "Integrated",
                _ => "UsernamePassword",
            };
            let Some(connection) = src.get("connection") else { continue };
            let host = connection.get("host").and_then(|v| v.as_str()).unwrap_or("");
            let port = connection.get("port").and_then(|v| v.as_u64());
            let database = connection.get("database").and_then(|v| v.as_str()).unwrap_or("").to_string();
            return ConnectionSpecInfo {
                server: host_port_to_server(host, port),
                database,
                connector_type: connector_type.to_string(),
                preferred_auth: preferred_auth.to_string(),
            };
        }
    }

    ConnectionSpecInfo {
        server: String::new(),
        database: String::new(),
        connector_type: String::new(),
        preferred_auth: String::new(),
    }
}

#[cfg(test)]
mod connection_spec_info_tests {
    use super::extract_connection_spec_info;

    #[test]
    fn reads_persisted_sources_catalog() {
        let json = serde_json::json!({
            "formatVersion": 23,
            "model": {
                "sources": [{
                    "id": "Adventureworks",
                    "kind": "postgres",
                    "preferred_auth": "username_password",
                    "connection": { "host": "localhost", "port": 5432, "database": "Adventureworks", "default_schema": "BI" }
                }]
            }
        });
        let info = extract_connection_spec_info(&json);
        assert_eq!(info.server, "localhost");
        assert_eq!(info.database, "Adventureworks");
        assert_eq!(info.connector_type, "PostgreSQL");
        assert_eq!(info.preferred_auth, "UsernamePassword");
    }

    #[test]
    fn non_default_port_lands_in_server() {
        let json = serde_json::json!({
            "sources": [{
                "kind": "postgres",
                "connection": { "host": "db.example.com", "port": 5544, "database": "sales" }
            }]
        });
        let info = extract_connection_spec_info(&json);
        assert_eq!(info.server, "db.example.com:5544");
        assert_eq!(info.database, "sales");
    }

    #[test]
    fn legacy_connection_specs_still_win() {
        let json = serde_json::json!({
            "connectionSpecs": [{
                "connectorType": "PostgreSQL",
                "preferred_auth": "Integrated",
                "target": { "host": "legacy", "port": 5432, "database": "olddb" }
            }],
            "model": { "sources": [{ "kind": "postgres", "connection": { "host": "new", "database": "newdb" } }] }
        });
        let info = extract_connection_spec_info(&json);
        assert_eq!(info.server, "legacy");
        assert_eq!(info.database, "olddb");
        assert_eq!(info.preferred_auth, "Integrated");
    }

    #[test]
    fn in_memory_sources_are_skipped() {
        let json = serde_json::json!({
            "model": {
                "sources": [
                    { "kind": "inmemory", "connection": {} },
                    { "kind": "postgres", "connection": { "host": "h", "database": "d" } }
                ]
            }
        });
        let info = extract_connection_spec_info(&json);
        assert_eq!(info.server, "h");
        assert_eq!(info.database, "d");
    }
}

/// Read + parse a pulled data source's embedded model (ModelBundle wrapper or
/// raw DataModel), format-version checked. Returns the RAW json (for
/// connectionSpecs) and the parsed model; logs and returns None on failure.
fn read_pulled_model(
    ds: &calp::pull::PulledDataSource,
) -> Option<(serde_json::Value, bi_engine::DataModel)> {
    let model_path = ds.model_path.to_string_lossy().to_string();
    let json_str = match std::fs::read_to_string(&ds.model_path) {
        Ok(s) => s,
        Err(e) => {
            crate::log_warn!("CALP", "Failed to read embedded model {}: {}", model_path, e);
            return None;
        }
    };
    let json_value: serde_json::Value = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        Err(e) => {
            crate::log_warn!("CALP", "Failed to parse embedded model JSON {}: {}", model_path, e);
            return None;
        }
    };
    let model_json =
        if json_value.get("model").is_some() && json_value.get("formatVersion").is_some() {
            json_value.get("model").unwrap().clone()
        } else {
            json_value.clone()
        };
    if let Err(e) = crate::bi::commands::check_model_format_version(&model_json) {
        crate::log_warn!("CALP", "Skipping data source {}: {}", ds.definition.id, e);
        return None;
    }
    let model: bi_engine::DataModel = match serde_json::from_value(model_json) {
        Ok(m) => m,
        Err(e) => {
            crate::log_warn!("CALP", "Failed to deserialize DataModel {}: {}", model_path, e);
            return None;
        }
    };
    Some((json_value, model))
}

/// Load embedded BI model data sources from a pulled application into BiState.
/// Returns a mapping from application data source ID to the created connection ID.
/// Also re-binds ribbon filters AND BI-sourced slicers (Wave A) saved against
/// a previous session's connection uuid to the freshly minted ones (via the
/// stable data_source_id / publisher connection uuid respectively).
fn load_embedded_data_sources(
    data_sources: &[calp::pull::PulledDataSource],
    bi_state: &BiState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
) -> std::collections::HashMap<String, crate::bi::types::ConnectionId> {
    use crate::bi::types::{Connection, ConnectionType};
    use crate::bi::engine_registry::ModelKey;

    let mut ds_to_conn: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
        std::collections::HashMap::new();

    for ds in data_sources {
        let model_path = ds.model_path.to_string_lossy().to_string();

        let Some((json_value, model)) = read_pulled_model(ds) else {
            continue;
        };

        // Extract connection info from connectionSpecs (ModelBundle wrapper level)
        let spec_info = extract_connection_spec_info(&json_value);
        crate::log_info!("CALP-DIAG", "load_embedded_data_sources: ds_id={}, spec_info: server='{}', database='{}', preferred_auth='{}', connector_type='{}'",
            ds.definition.id, spec_info.server, spec_info.database, spec_info.preferred_auth, spec_info.connector_type);

        // Keep the base model so calculated measures can be applied later.
        let base_model = model.clone();
        // Create the BI engine (no database connection yet)
        let mut engine = bi_engine::Engine::new(model);
        engine.set_auto_tier_config(bi_engine::AutoTierConfig {
            enabled: true,
            max_rows: 100_000,
            default_ttl_secs: 3600,
        });
        engine.set_query_cache_config(bi_engine::QueryCacheConfig {
            enabled: true,
            max_entries: 256,
            max_memory_bytes: 64 * 1024 * 1024,
            ttl_secs: 300,
        });

        // Restore materialized calculated-table snapshots carried in the
        // application: the subscriber may have no source access, so this is the
        // only data those derived tables get until a refresh succeeds.
        for (table, path) in &ds.calculated_table_snapshots {
            match read_ipc_batch(path) {
                Ok(batch) => {
                    if let Err(e) = engine.store_calculated_table_snapshot(table, batch) {
                        crate::log_warn!(
                            "CALP",
                            "calculated-table snapshot '{}' not restored: {}",
                            table,
                            e
                        );
                    }
                }
                Err(e) => crate::log_warn!(
                    "CALP",
                    "calculated-table snapshot '{}' unreadable: {}",
                    table,
                    e
                ),
            }
        }

        let model_key = ModelKey::from_model_path(&model_path);
        let (engine_arc, was_existing, _cache_dir) =
            bi_state.engine_registry.get_or_create(&model_key, engine);

        // A model-sharing engine already existed: our freshly built engine
        // (with the restored snapshots) was discarded — replay the snapshots
        // onto the shared instance. try_lock: this sync path must not block
        // an async runtime; a busy engine keeps its (equivalent) cached data.
        if was_existing && !ds.calculated_table_snapshots.is_empty() {
            if let Ok(mut shared) = engine_arc.try_lock() {
                for (table, path) in &ds.calculated_table_snapshots {
                    if let Ok(batch) = read_ipc_batch(path) {
                        if let Err(e) = shared.store_calculated_table_snapshot(table, batch) {
                            crate::log_warn!(
                                "CALP",
                                "calculated-table snapshot '{}' not restored on shared engine: {}",
                                table,
                                e
                            );
                        }
                    }
                }
            }
        }

        // Allocate a connection ID and register the connection
        let conn_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

        // Build bindings from the application definition
        let bindings: Vec<crate::bi::types::BiBindRequest> = ds.definition.bindings.iter().map(|b| {
            crate::bi::types::BiBindRequest {
                model_table: b.model_table.clone(),
                schema: b.schema.clone(),
                source_table: b.source_table.clone(),
                source_query: b.source_query.clone(),
            }
        }).collect();

        // Use server/database from model's connectionSpecs, falling back to application metadata
        let conn_server = if !spec_info.server.is_empty() { spec_info.server.clone() } else { ds.definition.server.clone() };
        let conn_database = if !spec_info.database.is_empty() { spec_info.database.clone() } else { ds.definition.database.clone() };
        let conn_preferred_auth = spec_info.preferred_auth.clone();

        // Derive the connection type from the model's connectionSpecs,
        // falling back to the application manifest. (Previously hardcoded to
        // PostgreSQL regardless of what the application declared.)
        let conn_type = if !spec_info.connector_type.is_empty() {
            ConnectionType::parse_or_default(&spec_info.connector_type)
        } else {
            ConnectionType::parse_or_default(&ds.definition.connection_type)
        };

        let connection = Connection {
            id: conn_id,
            name: ds.definition.name.clone(),
            description: format!("Embedded model from application ({})", ds.definition.id),
            connection_type: conn_type,
            connection_string: String::new(), // subscriber provides credentials via Connect
            server: conn_server.clone(),
            database: conn_database.clone(),
            preferred_auth: conn_preferred_auth.clone(),
            model_path: Some(model_path),
            engine: Some(engine_arc),
            model_key: Some(model_key),
            connector_index: None,
            bindings,
            last_refreshed: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            is_connected: false,
            active_queries: std::collections::HashMap::new(),
            package_data_source_id: Some(ds.definition.id.clone()),
            // Restore a saved "view as" RLS role for this application connection
            // (keyed by application data source id), if one was persisted.
            active_role: bi_state.pending_role_for(Some(&ds.definition.id), None),
            base_model: Some(base_model),
            calculated_measures: Vec::new(),
        };

        bi_state.connections.lock().unwrap().insert(conn_id, connection);
        ds_to_conn.insert(ds.definition.id.clone(), conn_id);

        crate::log_info!(
            "CALP-DIAG",
            "Created BI connection: conn_id={}, name='{}', ds_id='{}', server='{}', database='{}', preferred_auth='{}', conn_str='{}'",
            conn_id,
            ds.definition.name,
            ds.definition.id,
            conn_server,
            conn_database,
            conn_preferred_auth,
            "(empty — awaiting credentials)"
        );
    }

    // `load_embedded_data_sources` runs on the OPEN path (restoring application
    // connections from the file), so this re-bind must not dirty a freshly opened
    // workbook -- same reasoning as every other store rebuild in open_file.
    let load = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    crate::ribbon_filter::remap_ribbon_filter_connections(ribbon_filter_state, &load, &ds_to_conn);
    remap_slicer_bi_connections(&load, slicer_state, &ds_to_conn);

    ds_to_conn
}

/// Re-materialize refreshed application data sources onto their EXISTING
/// connections: swap the shared engine's model to the new version's and
/// update the connection's base_model (workbook calculated measures
/// re-applied on top). Without this, refreshing a dataset (model-only)
/// subscription advanced the version while silently serving the OLD model.
/// Data sources with no existing connection (added in the new version) are
/// freshly materialized; returns their (id, name) pairs for the ledger.
fn refresh_embedded_data_sources(
    data_sources: &[calp::pull::PulledDataSource],
    bi_state: &BiState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
) -> Vec<(String, String)> {
    let mut newly_created: Vec<(String, String)> = Vec::new();
    for ds in data_sources {
        let conn_id = {
            let conns = bi_state.connections.lock().unwrap();
            conns
                .iter()
                .find(|(_, c)| {
                    c.package_data_source_id.as_deref() == Some(ds.definition.id.as_str())
                })
                .map(|(id, _)| *id)
        };
        let Some(conn_id) = conn_id else {
            // Added in this version — materialize like a first pull.
            let created = load_embedded_data_sources(
                std::slice::from_ref(ds),
                bi_state,
                ribbon_filter_state,
                slicer_state,
            );
            if created.contains_key(&ds.definition.id) {
                newly_created.push((ds.definition.id.clone(), ds.definition.name.clone()));
            }
            continue;
        };
        let Some((_, model)) = read_pulled_model(ds) else {
            continue;
        };

        let mut conns = bi_state.connections.lock().unwrap();
        let Some(conn) = conns.get_mut(&conn_id) else {
            continue;
        };
        let combined = if conn.calculated_measures.is_empty() {
            model.clone()
        } else {
            match crate::bi::measures::build_combined_model(&model, &conn.calculated_measures) {
                Ok(m) => m,
                Err(e) => {
                    crate::log_warn!(
                        "CALP",
                        "refresh: measures no longer apply to updated model {} ({}); applying base",
                        ds.definition.id,
                        e
                    );
                    model.clone()
                }
            }
        };
        if let Some(engine_arc) = &conn.engine {
            match engine_arc.try_lock() {
                Ok(mut engine) => {
                    if let Err(e) = engine.set_model(combined) {
                        // Engine kept the old model — leave base_model alone
                        // too, so the connection never CLAIMS the new version.
                        crate::log_warn!(
                            "CALP",
                            "refresh: set_model failed for data source {}: {}",
                            ds.definition.id,
                            e
                        );
                        continue;
                    }
                    // Re-apply the version's materialized calculated-table
                    // snapshots: set_model only invalidates the QUERY cache,
                    // so without this a subscriber without source access kept
                    // serving the OLD version's derived-table data (and a
                    // newly-materialized table had no data at all).
                    for (table, path) in &ds.calculated_table_snapshots {
                        match read_ipc_batch(path) {
                            Ok(batch) => {
                                if let Err(e) =
                                    engine.store_calculated_table_snapshot(table, batch)
                                {
                                    crate::log_warn!(
                                        "CALP",
                                        "refresh: calculated-table snapshot '{}' not applied: {}",
                                        table,
                                        e
                                    );
                                }
                            }
                            Err(e) => crate::log_warn!(
                                "CALP",
                                "refresh: calculated-table snapshot '{}' unreadable: {}",
                                table,
                                e
                            ),
                        }
                    }
                }
                Err(_) => {
                    crate::log_warn!(
                        "CALP",
                        "refresh: engine busy for data source {} — model NOT updated (re-run Refresh)",
                        ds.definition.id
                    );
                    continue;
                }
            }
        }
        conn.base_model = Some(model);
        crate::log_info!(
            "CALP",
            "refresh: updated embedded model for data source {}",
            ds.definition.id
        );
    }
    newly_created
}

/// Why one subscription's APPLICATION BI connections were NOT re-materialized when
/// the workbook was opened.
///
/// Same purpose as [`WritebackRebuildSkip`]: without it, "this application has no
/// data sources" and "this application's model could not be verified on this
/// machine" are the same observable state — no connection — and a subscriber
/// staring at a pivot that says it has no model cannot tell which.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationConnectionRestoreSkip {
    pub package_name: String,
    pub registry_url: String,
    /// One of: `unreachable`, `notPinned`, `publisherChanged`, `badManifest`,
    /// `appTooOld`, `unsupportedTransport`, `unknown`. The first five come from
    /// [`calp_skip_reason`], shared with the writeback rebuild.
    pub reason: String,
    /// The underlying error text, for the pane's tooltip / details line.
    pub detail: String,
}

/// Re-materialize the BI connections a `.calp` pull created, when a subscribed
/// workbook is OPENED. Returns application-data-source-id -> live ConnectionId so
/// the caller can re-point saved BI pivots at them.
///
/// ## THE HOLE THIS CLOSES
///
/// `capture_local_bi_connections` deliberately skips application connections when
/// saving a `.cala`: an application's model belongs to the publisher and travels in
/// the `.calp`, and embedding a copy in every subscriber's workbook would mean
/// a subscriber's file could serve a model no publisher ever signed. That was
/// right, but nothing put those connections BACK. Measured on a saved
/// subscriber workbook: reopen -> `bi_get_connections` = 0 (the subscription
/// ledger itself restores fine); `calp_refresh_data` -> `sourcesRefreshed: 0`
/// and still 0 afterwards, because refresh only ever UPDATES a connection that
/// already exists. `calp_pull` and `refresh_embedded_data_sources` (reachable
/// only when a NEWER version exists) were the sole creators, so there was no
/// path from a reopened subscribed workbook back to a live model at all.
///
/// ## THE DESIGN
///
/// Re-materialize from the SUBSCRIPTION LEDGER (which application, which workspace,
/// which resolved version) plus the LOCAL APPLICATION CACHE (the workspace the pull
/// read), through `calp::pull::load_verified_data_sources` — which runs the
/// same three gates `pull` runs, in the same order, under
/// `PinPolicy::RequirePinned`. See its doc comment for the full chain.
///
/// The earlier decision that a PULL is the only thing that creates an application
/// connection was deliberate and is not weakened here: this cannot create a
/// connection for an application that was never pulled and pinned on this machine
/// (`RequirePinned` makes first contact a hard error), it cannot mint a pin, and
/// it cannot advance a version — it re-materializes exactly the version the
/// ledger says the subscriber already accepted.
///
/// ## WHAT HAPPENS WHEN IT CANNOT
///
/// * **Application missing / workspace gone / version deleted / offline** — the
///   manifest read fails, the subscription is SKIPPED, no connection is made.
///   The workbook opens with its cells (the last pull's data is in the `.cala`)
///   and its pivots report no connection, exactly as before this function
///   existed. Nothing stale is presented as live.
/// * **Signature no longer verifies / publisher key changed / an artifact was
///   tampered with** — `load_verified_data_sources` errors and the subscription
///   is SKIPPED. There is deliberately no fallback to the unverified bytes: a
///   subscriber that cannot prove which model it has gets no model.
/// * **HTTP workspace** — skipped WITHOUT any network I/O. Two reasons, both
///   decisive: `local_artifact_path` returns `None` for a non-local transport,
///   so an application connection has never materialized from an HTTP workspace even
///   on the pull path (nothing is lost here that a pull would have given); and
///   verifying artifacts over HTTP means downloading every artifact behind a
///   30-second-timeout blocking read, on the open, before a cell is drawn —
///   the precise hang `rebuild_writeback_index_deferring_http` was written to
///   avoid.
/// * **Dev subscriptions** — skipped silently, as in every other
///   workspace walk: a dev subscription's source is a local `.cala`, not a
///   signed workspace application, so there is no manifest to verify.
///
/// Every non-silent skip is recorded in `state.application_connection_restore_skips`
/// and surfaced by `calp_get_application_connection_skips`.
///
/// ADDITIVE, like `restore_local_bi_connections`: a data source that already has
/// a live connection is left alone, so this can never double-materialize.
pub(crate) fn restore_application_bi_connections(
    state: &AppState,
    bi_state: &BiState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
) -> std::collections::HashMap<String, crate::bi::types::ConnectionId> {
    // CLONED, not held: the walk below is workspace I/O and manifest hashing.
    let subscriptions = match state.subscriptions.read() {
        Ok(s) => s.subscriptions.clone(),
        Err(_) => return std::collections::HashMap::new(),
    };

    let mut ds_to_conn: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
        std::collections::HashMap::new();
    let mut skips: Vec<ApplicationConnectionRestoreSkip> = Vec::new();

    for sub in &subscriptions {
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }
        // RAW location — see `subscription_registry_path`.
        let registry_path = subscription_registry_path(sub);
        if crate::calp_registry::is_http_location(registry_path) {
            skips.push(ApplicationConnectionRestoreSkip {
                package_name: sub.package_name.clone(),
                registry_url: registry_path.to_string(),
                reason: "unsupportedTransport".to_string(),
                detail: "an HTTP registry exposes no local model artifact, so a package \
                         connection cannot be materialized from it (this is true of the pull \
                         path too)"
                    .to_string(),
            });
            continue;
        }
        let (registry, scope) = match crate::calp_registry::open_workspace_scoped(registry_path) {
            Ok(r) => r,
            Err(e) => {
                crate::log_warn!(
                    "CALP",
                    "application connections: {} skipped ({}): {}",
                    sub.package_name,
                    calp_skip_reason(&e),
                    e
                );
                skips.push(ApplicationConnectionRestoreSkip {
                    package_name: sub.package_name.clone(),
                    registry_url: registry_path.to_string(),
                    reason: calp_skip_reason(&e).to_string(),
                    detail: e.to_string(),
                });
                continue;
            }
        };

        let data_sources = match calp::pull::load_verified_data_sources(
            registry.as_ref(),
            &sub.package_name,
            &sub.resolved_version,
            &scope,
            &calcula_profile_dir(),
        ) {
            Ok(d) => d,
            Err(e) => {
                crate::log_warn!(
                    "CALP",
                    "application connections: {}@{} skipped ({}): {}",
                    sub.package_name,
                    sub.resolved_version,
                    calp_skip_reason(&e),
                    e
                );
                skips.push(ApplicationConnectionRestoreSkip {
                    package_name: sub.package_name.clone(),
                    registry_url: registry_path.to_string(),
                    reason: calp_skip_reason(&e).to_string(),
                    detail: e.to_string(),
                });
                continue;
            }
        };

        // Don't double-materialize: a data source that already owns a live
        // connection (another subscription in this workbook embeds the same
        // one, or this function ran twice) keeps it.
        let already: std::collections::HashSet<String> = match bi_state.connections.lock() {
            Ok(conns) => conns
                .values()
                .filter_map(|c| c.package_data_source_id.clone())
                .collect(),
            Err(_) => continue,
        };
        let wanted: Vec<calp::pull::PulledDataSource> = data_sources
            .into_iter()
            .filter(|ds| !already.contains(&ds.definition.id))
            .collect();
        if wanted.is_empty() {
            continue;
        }

        for (ds_id, conn_id) in load_embedded_data_sources(
            &wanted,
            bi_state,
            ribbon_filter_state,
            slicer_state,
        ) {
            ds_to_conn.insert(ds_id, conn_id);
        }
    }

    if let Ok(mut s) = state.application_connection_restore_skips.lock() {
        *s = skips;
    }

    if !ds_to_conn.is_empty() {
        crate::log_info!(
            "CALP",
            "restored {} application BI connection(s) on open",
            ds_to_conn.len()
        );
        // The engines were created after the open-path writeback rebuild, so
        // re-queue the writeback -> BI dataset feed, exactly as `calp_pull` does
        // after `load_embedded_data_sources`.
        crate::bi::writeback_source::invalidate_writeback_bi();
    }

    ds_to_conn
}

/// Every subscription whose APPLICATION BI connections could not be restored when
/// this workbook was opened, and why. Empty means every subscribed application's
/// model is live (or the application declares no data source).
#[tauri::command]
pub fn calp_get_application_connection_skips(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<ApplicationConnectionRestoreSkip>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    state
        .application_connection_restore_skips
        .lock()
        .map(|s| s.clone())
        .map_err(|e| e.to_string())
}

/// Restore pivot definitions from a pulled .calp application: deserialize, rebuild
/// cache from source grid data, calculate the view, and write output cells.
fn restore_pulled_pivots(
    effect: &crate::document_effect::DocumentEffect,
    pivot_defs: &[persistence::SavedPivotDefinition],
    bi_pivot_metadata: &[serde_json::Value],
    state: &AppState,
    pivot_state: &crate::pivot::types::PivotState,
    sheet_offset: usize,
    embedded_connection_ids: &std::collections::HashMap<String, crate::bi::types::ConnectionId>,
    sheet_rename_map: &std::collections::HashMap<String, String>,
) {
    use pivot_engine::{PivotCache, PivotDefinition};
    use crate::pivot::operations::{build_cache_from_grid, safe_calculate_pivot, write_pivot_to_grid, update_pivot_region};
    use crate::pivot::types::{BiPivotMetadata, SavedBiPivotMetadata};

    let mut pivot_tables = match pivot_state.pivot_tables.write(effect) {
        Ok(pt) => pt,
        Err(_) => return,
    };

    let mut grids = match state.grids.write(effect) {
        Ok(g) => g,
        Err(_) => return,
    };

    let sheet_names = match state.sheet_names.read() {
        Ok(sn) => sn,
        Err(_) => return,
    };

    let mut shared_styles = match state.style_registry.write(effect) {
        Ok(s) => s,
        Err(_) => return,
    };

    for saved in pivot_defs {
        let mut def: PivotDefinition = match serde_json::from_value(saved.definition.clone()) {
            Ok(d) => d,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to deserialize pivot definition {}: {}", saved.id, e);
                continue;
            }
        };

        let pivot_id = def.id;

        // The pivot anchors its output by sheet NAME. If collision resolution
        // renamed the pulled sheet ("Sheet1" -> "Sheet1 (2)"), rewrite the
        // stored anchor so the pivot lands on the application's own sheet — not on
        // the subscriber's same-named sheet (or sheet 0 via the fallback).
        if let Some(ref dest) = def.destination_sheet {
            if let Some(renamed) = sheet_rename_map.get(dest) {
                def.destination_sheet = Some(renamed.clone());
            }
        }
        // The SOURCE anchor is a sheet name too, and needs the same remap —
        // otherwise a pulled pivot reads the subscriber's same-named sheet.
        if let Some(ref src) = def.source_sheet {
            if let Some(renamed) = sheet_rename_map.get(src) {
                def.source_sheet = Some(renamed.clone());
            }
        }

        // For BI pivots, ensure the source display shows the model name, not a grid range
        if saved.source_type == "bi" && def.source_range_display.is_none() {
            def.source_range_display = Some("BI Model".to_string());
        }

        // Build cache — try grid data first (even for BI pivots, the application
        // includes a snapshot of the data), fall back to empty cache.
        let source_sheet_idx = saved.source_sheet_index.map(|i| i + sheet_offset);
        let (mut cache, _field_names) = if let Some(idx) = source_sheet_idx {
            if let Some(source_grid) = grids.get(idx) {
                match build_cache_from_grid(
                    source_grid,
                    def.source_start,
                    def.source_end,
                    def.source_has_headers,
                ) {
                    Ok(result) => result,
                    Err(e) => {
                        crate::log_warn!("CALP", "Failed to build cache for pivot {}: {}", pivot_id, e);
                        (PivotCache::new(pivot_id, 0), Vec::new())
                    }
                }
            } else {
                crate::log_warn!("CALP", "Source sheet {} not found for pivot {}", idx, pivot_id);
                (PivotCache::new(pivot_id, 0), Vec::new())
            }
        } else {
            // No source sheet — empty cache (BI pivot without snapshot data)
            (PivotCache::new(pivot_id, 0), Vec::new())
        };

        // Calculate the pivot view
        let view = safe_calculate_pivot(&def, &mut cache);

        // Find the destination sheet and write pivot output to grid
        let dest_sheet_name = def.destination_sheet.as_deref().unwrap_or("");
        // CASE-INSENSITIVE, and a miss is a SKIP rather than sheet 0.
        //
        // Both halves were wrong in the same direction. An exact match missed a
        // destination whose spelling had drifted from its tab — a case-only
        // rename is legal and updates no pivot definition — and the
        // `.unwrap_or(0)` then wrote the pivot's whole output over the
        // subscriber's FIRST SHEET, whatever that happened to be. The publish
        // side compares these names case-insensitively, so the two ends
        // disagreed about which pivots were even shippable.
        let Some(dest_sheet_idx) = sheet_names
            .iter()
            .position(|n| n.eq_ignore_ascii_case(dest_sheet_name))
        else {
            crate::log_warn!(
                "CALP",
                "pulled pivot {} names destination sheet '{}', which this workbook does not \
                 have — skipped rather than written over sheet 0",
                pivot_id,
                dest_sheet_name
            );
            continue;
        };

        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            let _merged = write_pivot_to_grid(
                dest_grid,
                None, // no active_grid dual-write needed
                &view,
                def.destination,
                &mut shared_styles,
            );
        }

        // Register the protected region so the frontend can discover this pivot
        update_pivot_region(state, pivot_id, dest_sheet_idx, def.destination, &view);

        // Store in PivotState
        pivot_tables.insert(pivot_id, (def, cache));
    }

    // Restore BI pivot metadata, resolving connection_id from embedded data sources
    if !bi_pivot_metadata.is_empty() {
        crate::log_info!("CALP-DIAG", "Restoring BI metadata: {} entries, embedded_connection_ids={:?}",
            bi_pivot_metadata.len(), embedded_connection_ids);

        if let Ok(mut bi_meta) = pivot_state.bi_metadata.write(effect) {
            for meta_json in bi_pivot_metadata {
                if let Ok(saved) = serde_json::from_value::<SavedBiPivotMetadata>(meta_json.clone()) {
                    // Route each pivot to ITS application data source. Applications
                    // published before data_source_id existed fall back to
                    // the first embedded connection (single-source applications
                    // are unaffected; multi-source ones should republish).
                    let conn_id = saved
                        .data_source_id
                        .as_deref()
                        .and_then(|id| embedded_connection_ids.get(id))
                        .copied()
                        .or_else(|| embedded_connection_ids.values().next().copied())
                        .unwrap_or_default();
                    crate::log_info!("CALP-DIAG", "  BI metadata: pivot_id={}, tables={}, measures={}, data_source_id={:?}, assigned connection_id={}",
                        saved.pivot_id, saved.model_tables.len(), saved.measures.len(), saved.data_source_id, conn_id);
                    bi_meta.insert(saved.pivot_id, BiPivotMetadata {
                        connection_id: conn_id,
                        // Keep the APPLICATION data source id so re-saves and
                        // re-publishes keep routing this pivot correctly.
                        data_source_id: saved.data_source_id.clone(),
                        model_tables: saved.model_tables,
                        measures: saved.measures,
                        hierarchies: saved.hierarchies,
                        calculation_groups: saved.calculation_groups,
                        data_as_of: saved.data_as_of,
                        last_query: None,
                        lookup_columns: saved.lookup_columns.into_iter().collect(),
                        drill_through: saved.drill_through,
                        perspectives: saved.perspectives,
                        selected_perspective: saved.selected_perspective,
                        cultures: saved.cultures,
                    });
                }
            }
        }
    }
}

// ============================================================================
// Capture BI Data Sources for Publishing
// ============================================================================

/// Extract active BI connections from BiState as publishable data sources.
/// Captures each connected source's model JSON, bindings, and server/database
/// (without credentials) so subscribers can refresh BI pivots against live
/// data. The deprecated query-region path (direct cell insertion) is gone —
/// BI data flows to subscribers through pivots (and CUBE formulas, planned).
fn capture_bi_data_sources(
    state: &AppState,
    bi_state: &BiState,
) -> Result<
    (
        Vec<calp::publish::PublishDataSource>,
        Vec<calp::writeback::ModelWritebackDeclaration>,
    ),
    String,
> {
    let connections = bi_state.connections.lock().map_err(|e| e.to_string())?;

    let mut data_sources = Vec::new();
    let mut model_writebacks: Vec<calp::writeback::ModelWritebackDeclaration> = Vec::new();

    for conn in connections.values() {
        // Get the engine and serialize the model. Connections without a
        // loaded engine have nothing to embed. Materialized calculated
        // tables also snapshot their cached data (Arrow IPC) so subscribers
        // without source access still see the derived tables.
        let (model_json, calculated_table_snapshots, wb_columns) = match &conn.engine {
            Some(engine_arc) => {
                match engine_arc.try_lock() {
                    Ok(engine) => {
                        let mut v = serde_json::to_value(engine.model())
                            .map_err(|e| format!("Failed to serialize model: {}", e))?;
                        // Ensure a feature-bearing model publishes stamped high
                        // enough (GVAR >= 13, materialized calculated tables
                        // >= 15) so a subscriber on an older engine fails
                        // closed cleanly.
                        crate::bi::commands::stamp_feature_format_version(engine.model(), &mut v);

                        let mut snapshots = Vec::new();
                        for gv in engine.model().global_variables() {
                            if gv.is_dynamic() {
                                continue;
                            }
                            let Some(batch) = engine.cache().get(gv.name()) else {
                                crate::log_warn!(
                                    "CALP",
                                    "calculated table '{}' has no materialized data to snapshot \
                                     (materialize or refresh before publishing to carry it)",
                                    gv.name()
                                );
                                continue;
                            };
                            match record_batch_to_ipc(batch) {
                                Ok(ipc_bytes) => snapshots.push(
                                    calp::publish::CalculatedTableSnapshot {
                                        table: gv.name().to_string(),
                                        ipc_bytes,
                                    },
                                ),
                                Err(e) => crate::log_warn!(
                                    "CALP",
                                    "calculated table '{}' snapshot failed: {}",
                                    gv.name(),
                                    e
                                ),
                            }
                        }
                        let wb_columns: Vec<bi_engine::WritebackColumn> =
                            engine.model().writeback_columns().to_vec();
                        (v, snapshots, wb_columns)
                    }
                    Err(_) => {
                        crate::log_warn!("CALP", "Engine busy for connection {}, skipping", conn.id);
                        continue;
                    }
                }
            }
            None => continue,
        };

        // The connection's own server/database fields are authoritative (they
        // survive URL-style connection strings and restored connections whose
        // connection_string is empty); the key=value parse is the fallback.
        let (parsed_server, parsed_database) = parse_pg_connection_info(&conn.connection_string);
        let server = if !conn.server.is_empty() { conn.server.clone() } else { parsed_server };
        let database = if !conn.database.is_empty() {
            conn.database.clone()
        } else {
            parsed_database
        };

        // The connection's EntityId (canonical UUID string) is the stable data source ID
        let ds_id = conn.id.to_string();

        // Convert bindings
        let bindings: Vec<calp::TableBinding> = conn.bindings.iter().map(|b| {
            calp::TableBinding {
                model_table: b.model_table.clone(),
                schema: b.schema.clone(),
                source_table: b.source_table.clone(),
                source_query: b.source_query.clone(),
            }
        }).collect();

        // Writeback columns (engine v21): declare each for governed
        // model-keyed submissions, and ship the publisher's collected history
        // as the subscribers' baseline (history-preserving distribution).
        let writeback_history_json = if wb_columns.is_empty() {
            None
        } else {
            for wb in &wb_columns {
                model_writebacks.push(model_writeback_declaration(wb, &ds_id));
            }
            let store = state.model_writeback.read().map_err(|e| e.to_string())?;
            let baseline: std::collections::HashMap<
                String,
                Vec<crate::bi::writeback::ModelWritebackEntry>,
            > = wb_columns
                .iter()
                .filter_map(|wb| {
                    store
                        .entries
                        .get(wb.id())
                        .filter(|v| !v.is_empty())
                        .map(|v| (wb.id().to_string(), v.clone()))
                })
                .collect();
            if baseline.is_empty() {
                None
            } else {
                Some(serde_json::to_value(&baseline).map_err(|e| e.to_string())?)
            }
        };

        data_sources.push(calp::publish::PublishDataSource {
            id: ds_id,
            name: conn.name.clone(),
            connection_type: conn.connection_type.as_str().to_string(),
            server,
            database,
            model_json,
            bindings,
            calculated_table_snapshots,
            writeback_history_json,
        });
    }

    Ok((data_sources, model_writebacks))
}

/// Map an engine writeback column to its .calp governance declaration.
/// MasterData columns force `OnApproval`; History columns default to
/// `OnSubmit` (a submission counts once explicitly submitted).
fn model_writeback_declaration(
    wb: &bi_engine::WritebackColumn,
    ds_id: &str,
) -> calp::writeback::ModelWritebackDeclaration {
    use calp::writeback::{SubmissionPolicy, ValueSchema, ValueType};
    let c = wb.constraints();
    let has_enum = c.map(|c| !c.enum_values.is_empty()).unwrap_or(false);
    let value_type = match wb.data_type() {
        bi_engine::DataType::Int64 | bi_engine::DataType::Int32 => ValueType::Integer,
        bi_engine::DataType::Boolean => ValueType::Boolean,
        bi_engine::DataType::String if has_enum => ValueType::Enum,
        bi_engine::DataType::String => ValueType::Text,
        _ => ValueType::Number,
    };
    let master = wb.kind() == bi_engine::WritebackColumnKind::MasterData;
    calp::writeback::ModelWritebackDeclaration {
        id: wb.id().to_string(),
        data_source_id: ds_id.to_string(),
        table: wb.table().to_string(),
        column: wb.name().to_string(),
        key_columns: wb.key_columns().to_vec(),
        kind: if master { "masterData" } else { "history" }.to_string(),
        schema: Some(ValueSchema {
            value_type,
            required: c.map(|c| c.required).unwrap_or(false),
            min: c.and_then(|c| c.min),
            max: c.and_then(|c| c.max),
            enum_values: c.map(|c| c.enum_values.clone()).unwrap_or_default(),
            max_length: c.and_then(|c| c.max_length),
            pattern: c.and_then(|c| c.pattern.clone()),
            extra: Default::default(),
        }),
        allowed_editors: wb.allowed_editors().to_vec(),
        submission_policy: Some(if master {
            SubmissionPolicy::OnApproval
        } else {
            SubmissionPolicy::OnSubmit
        }),
        extra: Default::default(),
    }
}

/// Serialize a RecordBatch as Arrow IPC stream bytes (the calculated-table
/// snapshot artifact format).
fn record_batch_to_ipc(batch: &arrow::record_batch::RecordBatch) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut writer =
        arrow::ipc::writer::StreamWriter::try_new(&mut buf, batch.schema().as_ref())
            .map_err(|e| e.to_string())?;
    writer.write(batch).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    drop(writer);
    Ok(buf)
}

/// Read an Arrow IPC stream file back into a single RecordBatch
/// (multiple batches are concatenated).
fn read_ipc_batch(path: &std::path::Path) -> Result<arrow::record_batch::RecordBatch, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let reader = arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(bytes), None)
        .map_err(|e| e.to_string())?;
    let schema = reader.schema();
    let batches: Vec<arrow::record_batch::RecordBatch> = reader
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if batches.is_empty() {
        return Ok(arrow::record_batch::RecordBatch::new_empty(schema));
    }
    arrow::compute::concat_batches(&schema, &batches).map_err(|e| e.to_string())
}

/// Parse server (host) and database (dbname) from a PostgreSQL connection string.
/// Strips credentials — only returns the non-sensitive parts.
pub fn parse_pg_connection_info(connection_string: &str) -> (String, String) {
    let mut server = String::new();
    let mut database = String::new();

    for part in connection_string.split_whitespace() {
        if let Some((key, value)) = part.split_once('=') {
            match key.to_lowercase().as_str() {
                "host" | "server" => server = value.to_string(),
                "dbname" | "database" => database = value.to_string(),
                "port" => {
                    if !server.is_empty() && !value.is_empty() && value != "5432" {
                        server = format!("{}:{}", server, value);
                    }
                }
                _ => {} // Skip user, password, sslmode, etc.
            }
        }
    }

    (server, database)
}

// ============================================================================
// Phase: Live Data Sources — Refresh & Connection Configuration
// ============================================================================

/// Response from a data refresh operation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRefreshResponse {
    pub sources_refreshed: usize,
    /// Data sources that could not auto-connect (need manual configuration).
    pub needs_configuration: Vec<DataSourceNeedsConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceNeedsConfig {
    pub data_source_id: String,
    pub name: String,
    pub server: String,
    pub database: String,
    pub connection_type: String,
}

/// Verify connectivity for all subscription data sources.
///
/// For each data source:
/// 1. Check subscriber's saved connection config
/// 2. If none, try building SSPI connection string and testing it
/// 3. If connection works: load model and bind tables (verifies the source)
/// 4. If connection fails: add to needs_configuration list
///
/// BI data reaches the grid through pivots (and CUBE formulas, planned) —
/// the deprecated query-region direct cell insertion path was removed.
#[tauri::command]
pub async fn calp_refresh_data(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    window: tauri::Window,
) -> Result<DataRefreshResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    use calp::data_refresh;

    let mut sources_refreshed = 0usize;
    let mut needs_config = Vec::new();

    // Collect data sources from all subscriptions
    let subscription_data: Vec<(
        calp::ApplicationDataSource,
        std::path::PathBuf,
        Option<String>, // saved connection string
    )> = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let mut result = Vec::new();

        for sub in &subs.subscriptions {
            // Skip dev subscriptions
            if calp::dev_mode::is_dev_subscription(sub) {
                continue;
            }

            // RAW location — see `subscription_registry_path`.
            let (registry, scope) =
                match crate::calp_registry::open_workspace_scoped(&sub.registry_url) {
                    Ok(r) => r,
                    Err(_) => continue,
                };

            // TRUST-BEARING READ. `ds.server` / `ds.database` from this manifest
            // decide WHERE this command opens a database connection and sends
            // the subscriber's credentials (a saved connection string, or their
            // Windows identity via SSPI). An unverified read meant anyone able
            // to write the workspace directory — a shared folder, a synced drive
            // — could repoint a subscribed application's data source at a host they
            // control and harvest the credentials on the next Refresh, with no
            // signature to break and nothing on screen to notice. Same gate the
            // writeback rebuild uses: verified against the publisher key this
            // machine pinned, or the subscription is skipped.
            let ver_manifest = match calp::integrity::load_pinned_manifest_via(
                registry.as_ref(),
                &sub.package_name,
                &sub.resolved_version,
                &scope,
                &calcula_profile_dir(),
            ) {
                Ok(m) => m,
                Err(e) => {
                    crate::log_warn!(
                        "CALP",
                        "data refresh: {}@{} skipped ({}): {}",
                        sub.package_name,
                        sub.resolved_version,
                        calp_skip_reason(&e),
                        e
                    );
                    continue;
                }
            };

            for ds in &ver_manifest.data_sources {
                // Resolve the model artifact THROUGH the transport, never by hand.
                // publish dedups artifacts into a content-addressed blob store and
                // deletes the per-version copy, so `ver_dir/models/{id}/model.json`
                // no longer exists after any publish — local_artifact_path does the
                // dir-first / blob-fallback resolution that keeps the lazy read
                // working. It also returns None for non-local transports (HTTP),
                // which we skip cleanly instead of reading a bogus "https:/…" path.
                let model_path = match registry.local_artifact_path(
                    &sub.package_name,
                    &sub.resolved_version,
                    &ds.model_path,
                ) {
                    Ok(Some(p)) => p,
                    Ok(None) => {
                        crate::log_warn!(
                            "CALP",
                            "Data source '{}' model refresh is unsupported for this workspace transport (no local artifact); skipping",
                            ds.id
                        );
                        continue;
                    }
                    Err(e) => {
                        crate::log_warn!(
                            "CALP",
                            "Failed to resolve model path for {}: {}",
                            ds.id, e
                        );
                        continue;
                    }
                };

                let saved_conn = sub.data_source_configs.iter()
                    .find(|c| c.data_source_id == ds.id)
                    .map(|c| c.connection_string.clone());

                result.push((ds.clone(), model_path, saved_conn));
            }
        }

        result
    };

    if subscription_data.is_empty() {
        return Ok(DataRefreshResponse {
            sources_refreshed: 0,
            needs_configuration: Vec::new(),
        });
    }

    for (ds, model_path, saved_conn) in &subscription_data {
        // Determine connection string
        let connection_string = if let Some(saved) = saved_conn {
            saved.clone()
        } else {
            // Try SSPI
            data_refresh::build_sspi_connection_string(&ds.server, &ds.database)
        };

        // Load model
        let model_json = match data_refresh::read_model_json(&model_path) {
            Ok(json) => json,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to read model for data source {}: {}", ds.id, e);
                continue;
            }
        };

        // Detect ModelBundle format. Parse failures skip THIS source — one
        // corrupt application must not abort verification of the others.
        let actual_model_json = if model_json.get("formatVersion").is_some() {
            match model_json.get("model") {
                Some(m) => m.clone(),
                None => {
                    crate::log_warn!("CALP", "ModelBundle missing 'model' field for {}", ds.id);
                    continue;
                }
            }
        } else {
            model_json
        };

        if let Err(e) = crate::bi::commands::check_model_format_version(&actual_model_json) {
            crate::log_warn!("CALP", "Skipping data source {}: {}", ds.id, e);
            continue;
        }
        let model: bi_engine::DataModel = match serde_json::from_value(actual_model_json) {
            Ok(m) => m,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to parse model for {}: {}", ds.id, e);
                continue;
            }
        };

        // Create a temporary engine for this refresh
        let mut engine = bi_engine::Engine::new(model);
        engine.set_auto_tier_config(bi_engine::AutoTierConfig {
            enabled: true,
            max_rows: 100_000,
            default_ttl_secs: 3600,
        });

        // Live connect supports PostgreSQL only — don't funnel other source
        // types into a credentials prompt that can never succeed.
        if crate::bi::types::ConnectionType::parse_or_default(&ds.connection_type)
            != crate::bi::types::ConnectionType::PostgreSQL
        {
            crate::log_warn!(
                "CALP",
                "Data source '{}' is type '{}' — live connect is not yet supported for it, skipping",
                ds.name, ds.connection_type
            );
            continue;
        }

        // Try to connect to the database. On failure, surface the source in
        // needs_configuration so the ConnectionDialog can prompt the user
        // (stale saved config and missing-SSPI cases both end up here).
        let (target, auth) = crate::bi::commands::parse_connection_string(&connection_string);
        let connector_idx = match engine.add_postgres(target, auth).await {
            Ok(idx) => idx,
            Err(_e) => {
                needs_config.push(DataSourceNeedsConfig {
                    data_source_id: ds.id.clone(),
                    name: ds.name.clone(),
                    server: ds.server.clone(),
                    database: ds.database.clone(),
                    connection_type: ds.connection_type.clone(),
                });
                continue;
            }
        };

        // Bind tables to verify the model is queryable against this source.
        for binding in &ds.bindings {
            let source_binding = bi_engine::SourceBinding::new(&binding.schema, &binding.source_table);
            engine.bind_table(&binding.model_table, connector_idx, source_binding);
        }

        // Propagate the verified connection string into the pulled BiState
        // connection pivots actually query — verifying against the throwaway
        // engine above alone would leave the real connection unconfigured
        // ("verified" toast, but pivot refresh still prompts for credentials).
        if let Ok(mut connections) = bi_state.connections.lock() {
            if let Some(conn) = connections
                .values_mut()
                .find(|c| c.package_data_source_id.as_deref() == Some(ds.id.as_str()))
            {
                if conn.connection_string != connection_string {
                    conn.connection_string = connection_string.clone();
                }
            }
        }

        sources_refreshed += 1;
    }

    Ok(DataRefreshResponse {
        sources_refreshed,
        needs_configuration: needs_config,
    })
}

/// Save a subscriber's connection configuration for a specific data source.
/// Called after the user enters credentials in the ConnectionDialog.
#[tauri::command]
pub fn calp_save_data_source_config(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    data_source_id: String,
    connection_string: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let now = chrono::Utc::now().to_rfc3339();
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut subs = state.subscriptions.write(&effect).map_err(|e| e.to_string())?;

    for sub in &mut subs.subscriptions {
        // Find any subscription that references this data source.
        // RAW location — see `subscription_registry_path`.
        let (registry, scope) =
            match crate::calp_registry::open_workspace_scoped(&sub.registry_url) {
                Ok(r) => r,
                Err(_) => continue,
            };

        // TRUST-BEARING READ, for the same reason `calp_refresh_data`'s is: the
        // data-source list this walks decides which application owns a data source
        // id, and its `server` / `database` are what the connection dialog shows
        // and what a refresh then connects to. Only a manifest signed by the
        // publisher key this machine pinned may answer.
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

        if ver_manifest.data_sources.iter().any(|ds| ds.id == data_source_id) {
            // Update or add the config
            if let Some(existing) = sub.data_source_configs.iter_mut()
                .find(|c| c.data_source_id == data_source_id)
            {
                existing.connection_string = connection_string.clone();
                existing.last_connected = Some(now.clone());
            } else {
                sub.data_source_configs.push(calp::SubscriberDataSourceConfig {
                    data_source_id: data_source_id.clone(),
                    connection_string: connection_string.clone(),
                    last_connected: Some(now.clone()),
                });
            }
            return Ok(());
        }
    }

    Err(format!("No subscription found with data source {}", data_source_id))
}

/// Get the list of data sources for the current workbook's subscriptions.
/// Returns data source metadata so the frontend can show connection status.
#[tauri::command]
pub fn calp_get_data_sources(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<DataSourceInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for sub in &subs.subscriptions {
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }

        // RAW location — see `subscription_registry_path`.
        let (registry, scope) =
            match crate::calp_registry::open_workspace_scoped(&sub.registry_url) {
                Ok(r) => r,
                Err(_) => continue,
            };

        // TRUST-BEARING READ, for the same reason `calp_refresh_data`'s is: the
        // data-source list this walks decides which application owns a data source
        // id, and its `server` / `database` are what the connection dialog shows
        // and what a refresh then connects to. Only a manifest signed by the
        // publisher key this machine pinned may answer.
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

        for ds in &ver_manifest.data_sources {
            let is_configured = sub.data_source_configs.iter()
                .any(|c| c.data_source_id == ds.id && !c.connection_string.is_empty());

            result.push(DataSourceInfo {
                id: ds.id.clone(),
                name: ds.name.clone(),
                connection_type: ds.connection_type.clone(),
                server: ds.server.clone(),
                database: ds.database.clone(),
                is_configured,
                package_name: sub.package_name.clone(),
            });
        }
    }

    Ok(result)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceInfo {
    pub id: String,
    pub name: String,
    pub connection_type: String,
    pub server: String,
    pub database: String,
    pub is_configured: bool,
    pub package_name: String,
}

// ============================================================================
// Reset Subscription to Published State
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetSubscriptionParams {
    pub registry_url: String,
    pub package_name: String,
    /// Cells to LEAVE ALONE — the rows the author unticked in the diff.
    ///
    /// AN EXCLUSION SET, NEVER AN INCLUSION SET, and that is the whole safety
    /// property: the diff list is a bounded SAMPLE (50 changed cells per sheet),
    /// so a changed cell may have no row for the author to tick. Absent means
    /// restored, which makes an empty list bit-identical to the whole-sheet
    /// reset this command has always done, and makes every cell the dialog could
    /// not show default to the behaviour the author already expects.
    #[serde(default)]
    pub excluded_cells: Vec<ResetCellRef>,
}

/// One cell the author chose to keep, named the way a diff row names it.
///
/// By the PUBLISHER's sheet id, because that is what a diff row carries and what
/// the published artifact is keyed by. The command already holds the
/// package→local mapping to resolve it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCellRef {
    pub package_sheet_id: SheetId,
    pub row: u32,
    pub col: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetSubscriptionResponse {
    pub sheets_reset: usize,
    pub overrides_cleared: usize,
    pub pivots_reset: usize,
    pub resolved_version: String,
}

/// Undo/redo snapshot for a subscription reset: the full prior content of every
/// affected sheet (cells, column widths, row heights, merges) plus the cleared
/// override entries. Restore swaps the state back wholesale and records the
/// then-current state as the symmetric inverse, so undo/redo ping-pongs exactly.
/// Cell-based (not re-materialize), so undo works offline.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct CalpResetSnapshot {
    pub sheets: Vec<CalpResetSheetSnapshot>,
    /// The local sheet ids the reset touched — the override swap is scoped to
    /// exactly these on both undo and redo.
    pub override_sheet_ids: Vec<SheetId>,
    /// The override entries that were cleared (restored on undo).
    pub overrides: Vec<calp::CellOverride>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct CalpResetSheetSnapshot {
    pub sheet_index: usize,
    /// Full sparse cell content to restore to (cells not listed are cleared).
    pub cells: Vec<(u32, u32, engine::Cell)>,
    pub column_widths: std::collections::HashMap<u32, f64>,
    pub row_heights: std::collections::HashMap<u32, f64>,
    pub merges: Vec<crate::api_types::MergedRegion>,
    /// The sheet's dynamic-array ownership: `(origin_row, origin_col, the cells
    /// that origin fills)`.
    ///
    /// NOT DERIVABLE FROM `cells`, which is the whole reason it is here. A
    /// spilled `2` and a typed `2` are the same bytes, so restoring the grid
    /// says nothing about who owned what. Undo of a reset put the subscriber's
    /// cells back while leaving the PUBLISHER's extents installed over them:
    /// the array's cells came back empty and refused every edit, naming a
    /// formula the workbook no longer contained, for the rest of the session.
    ///
    /// `#[serde(default)]` so a snapshot recorded before this field existed
    /// still deserializes — it restores no claims, which is exactly the old
    /// behaviour rather than a panic on an undo stack from earlier in the run.
    #[serde(default)]
    pub spills: crate::spill_restore::SheetSpillClaims,
}

/// Reset a subscription's sheets to the pristine published content of the
/// currently resolved version: re-pulls that exact version through the same
/// signature/integrity gates as subscribe, replaces the tracked sheets' cells,
/// column widths, row heights, and merges in place, and clears the override
/// layer for those sheets. Recorded as ONE undo transaction ("calp_reset"
/// custom restore), so Ctrl+Z brings every local change back.
#[tauri::command]
pub fn calp_reset_subscription(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    // For the recalculation at the end. A partial reset installs a MIXTURE of
    // the author's cells and the publisher's, so the formulas reading across
    // that boundary have to be re-evaluated before anybody looks at them.
    user_files_state: State<crate::persistence::UserFilesState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    params: ResetSubscriptionParams,
    window: tauri::Window,
) -> Result<ResetSubscriptionResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // Locate the subscription and copy what we need (lock released after).
    let (resolved_version, tracked): (String, Vec<(SheetId, SheetId)>) = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let sub = subs
            .subscriptions
            .iter()
            .find(|s| s.package_name == params.package_name && s.registry_url == params.registry_url)
            .ok_or_else(|| format!("Not subscribed to '{}'.", params.package_name))?;
        (
            sub.resolved_version.clone(),
            sub.sheets
                .iter()
                .map(|s| (s.package_sheet_id, s.local_sheet_id))
                .collect(),
        )
    };

    // Re-pull the EXACT resolved version (signature + TOFU + checksum gates run
    // again — reset must not materialize content weaker-verified than pull did).
    // The workspace as the SUBSCRIPTION recorded it: the scope derived from it is
    // the one the original subscribe pinned under, which is what RequirePinned
    // below is measured against.
    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&params.registry_url)
        .map_err(|e| e.to_string())?;
    let request = calp::pull::PullRequest {
        package_name: params.package_name.clone(),
        // The EXACT resolved version, never the subscription's own target: a
        // reset restores what this workbook currently has, and re-resolving an
        // environment could land somewhere else if it moved since.
        target: calp::manifest::SubscriptionTarget::Line(
            calp::VersionPin::parse(&format!("={}", resolved_version))
                .map_err(|e| e.to_string())?,
        ),
        now: chrono::Utc::now().to_rfc3339(),
    };
    // ALREADY-TRUSTED: "Reset to published" restores an application the user
    // subscribed to. Re-pulling the exact resolved version must not be a way to
    // acquire the pin the subscribe step never granted.
    let result = calp::pull::pull(
        &registry,
        &request,
        &scope,
        &calcula_profile_dir(),
        calp::integrity::PinPolicy::RequirePinned,
    )
    .map_err(|e| e.to_string())?;

    // Match pulled sheets to their local workbook indices via the ledger.
    let pkg_to_local: std::collections::HashMap<SheetId, SheetId> =
        tracked.iter().cloned().collect();
    let targets: Vec<(usize, SheetId, &calp::pull::PulledSheet)> = {
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        result
            .sheets
            .iter()
            .filter_map(|ps| {
                let local_sid = *pkg_to_local.get(&ps.package_sheet_id)?;
                let idx = sheet_ids.iter().position(|id| *id == local_sid)?;
                Some((idx, local_sid, ps))
            })
            .collect()
    };
    if targets.is_empty() {
        return Err("None of this application's sheets are present in the workbook.".to_string());
    }
    let local_sheet_ids: Vec<SheetId> = targets.iter().map(|(_, sid, _)| *sid).collect();

    // WHAT THE AUTHOR UNTICKED, translated into this workbook's own ids. A diff
    // row names the PUBLISHER's sheet; the grid is keyed by the local one.
    let excluded_by_sheet: std::collections::HashMap<SheetId, std::collections::HashSet<(u32, u32)>> = {
        let mut m: std::collections::HashMap<SheetId, std::collections::HashSet<(u32, u32)>> =
            std::collections::HashMap::new();
        for c in &params.excluded_cells {
            // A cell naming a sheet this reset does not cover is dropped rather
            // than refused: the dialog's list can outlive a detach, and an
            // exclusion for a sheet nobody is resetting changes nothing.
            if let Some(local) = pkg_to_local.get(&c.package_sheet_id) {
                m.entry(*local).or_default().insert((c.row, c.col));
            }
        }
        m
    };

    // A DYNAMIC ARRAY IS ONE THING, so it cannot be half-kept.
    //
    // Keeping the author's formula at a spill ORIGIN while the published
    // extents are installed over the sheet leaves the origin claiming a
    // rectangle the published version decided, computed from a formula the
    // published version does not have. Refused by name rather than silently
    // resolved either way: this is rare, and a wrong answer here corrupts a
    // whole block of cells rather than one.
    if !excluded_by_sheet.is_empty() {
        let mut offenders: Vec<String> = Vec::new();
        // The LIVE origins, by (sheet index, row, col). `spill_ranges` is the
        // authority for which origin owns which cells; `engine::Cell` carries no
        // spill of its own.
        let live_spills = state.spill_ranges.read().map_err(|e| e.to_string())?.clone();
        for (idx, local_sid, pulled) in &targets {
            let Some(kept) = excluded_by_sheet.get(local_sid) else { continue };
            for &(r, c) in kept {
                // ORIGIN *OR* OUTPUT. Checking only origins left the worse half
                // open: a kept cell INSIDE a published dynamic array is not an
                // origin, so it passed the guard — and then the reset installed
                // the published extents over it and the recalculation at the end
                // wrote the array's own value into it, erasing the value the
                // author had asked to keep. The dialog reported success.
                //
                // Every cell an array owns belongs to that array, so keeping one
                // of them is not a coherent request in either direction.
                let local_origin = live_spills.contains_key(&(*idx, r, c));
                let local_output = live_spills
                    .iter()
                    .any(|((s, _, _), cells)| *s == *idx && cells.contains(&(r, c)));
                let published_origin = pulled
                    .sheet
                    .cells
                    .get(&(r, c))
                    .is_some_and(|sc| sc.spill.is_some());
                let published_output = pulled.sheet.cells.iter().any(|((orow, ocol), sc)| {
                    sc.spill.is_some_and(|(er, ec)| {
                        r >= *orow && r <= er && c >= *ocol && c <= ec
                    })
                });
                if local_origin || local_output || published_origin || published_output {
                    offenders.push(format!(
                        "{}!{}",
                        pulled.name,
                        calcula_format::cell_ref::to_a1(r, c)
                    ));
                }
            }
        }
        if !offenders.is_empty() {
            return Err(format!(
                "CALP_RESET_SPILL_CELL: {} belongs to a dynamic array — as its origin or as \
                 one of the cells it fills — so it cannot be kept while the rest of the sheet \
                 is restored. An array's shape, its formula and its output are one thing. \
                 Either include it in the reset, or reset nothing on that sheet and edit it \
                 afterwards.",
                offenders.join(", ")
            ));
        }
    }

    // Snapshot the CURRENT state of every affected sheet + its overrides,
    // BEFORE anything is replaced — this is the undo payload. The ACTIVE
    // sheet's widths/heights live in the mirrors (set_active_sheet uses
    // take-semantics; its all_* slot is empty while active), so capture from
    // the mirrors for that sheet.
    let active_idx = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let snapshot = {
        let mut sheets = Vec::with_capacity(targets.len());
        {
            let grids = state.grids.read().map_err(|e| e.to_string())?;
            let mirror_cw = state.column_widths.read().map_err(|e| e.to_string())?;
            let mirror_rh = state.row_heights.read().map_err(|e| e.to_string())?;
            let all_cw = state.all_column_widths.read().map_err(|e| e.to_string())?;
            let all_rh = state.all_row_heights.read().map_err(|e| e.to_string())?;
            for (idx, _, _) in &targets {
                let Some(grid) = grids.get(*idx) else { continue };
                let (column_widths, row_heights) = if *idx == active_idx {
                    (mirror_cw.clone(), mirror_rh.clone())
                } else {
                    (
                        all_cw.get(*idx).cloned().unwrap_or_default(),
                        all_rh.get(*idx).cloned().unwrap_or_default(),
                    )
                };
                sheets.push(CalpResetSheetSnapshot {
                    sheet_index: *idx,
                    cells: grid
                        .cells
                        .iter()
                        .map(|(k, c)| (k.0, k.1, c.clone()))
                        .collect(),
                    column_widths,
                    row_heights,
                    merges: Vec::new(), // filled below (separate lock scope)
                    spills: Vec::new(), // filled below (spill maps are last in the lock order)
                });
            }
        }
        for sheet in sheets.iter_mut() {
            sheet.merges = crate::report::with_sheet_merges(&state, sheet.sheet_index, |m| {
                m.iter().cloned().collect()
            });
            // WHO OWNS WHICH CELLS, captured before the published extents
            // replace it. `restore_spill_extents_for_sheet` below installs the
            // application's claims over this sheet; without this the undo would
            // put the subscriber's cells back under the publisher's ownership.
            sheet.spills = crate::spill_restore::sheet_spill_claims(&state, sheet.sheet_index);
        }
        let overrides = {
            let layer = state.override_layer.read().map_err(|e| e.to_string())?;
            layer
                .overrides
                .iter()
                .filter(|o| local_sheet_ids.contains(&o.sheet_id))
                .cloned()
                .collect::<Vec<_>>()
        };
        CalpResetSnapshot {
            sheets,
            override_sheet_ids: local_sheet_ids.clone(),
            overrides,
        }
    };
    // COUNTED AFTER the retain, not from the pre-reset snapshot.
    //
    // This was `snapshot.overrides.len()` — every override on the reset sheets,
    // including the ones a PARTIAL reset deliberately KEPT. The dialog then told
    // the author it had cleared overrides that are still in the ledger and still
    // repaint on the next refresh. Set below, once the sweep has run.
    let overrides_before = snapshot.overrides.len();
    let mut overrides_cleared = 0usize;

    // The reset also restores the APPLICATION's pivot definitions — a subscriber
    // changing "the layout" usually means the pivot layout, and resetting only
    // the sheet cells would let the modified pivot immediately re-render its
    // changed layout over the pristine content. Map each published definition
    // to the LOCAL sheet name (the pull may have renamed sheets at subscribe
    // time), and only touch pivots that still exist in this workbook.
    let pkg_name_to_local: std::collections::HashMap<String, String> = {
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
        targets
            .iter()
            .filter_map(|(idx, _, ps)| {
                sheet_names
                    .get(*idx)
                    .map(|local| (ps.name.clone(), local.clone()))
            })
            .collect()
    };
    let published_pivots: Vec<(pivot_engine::PivotId, pivot_engine::PivotDefinition)> = {
        let pivot_tables = pivot_state
            .pivot_tables
            .read()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        result
            .pivot_definitions
            .iter()
            .filter_map(|saved| {
                let mut def: pivot_engine::PivotDefinition =
                    serde_json::from_value(saved.definition.clone()).ok()?;
                if !pivot_tables.contains_key(&def.id) {
                    return None;
                }
                if let Some(ref dest) = def.destination_sheet {
                    if let Some(local) = pkg_name_to_local.get(dest) {
                        def.destination_sheet = Some(local.clone());
                    }
                }
                if let Some(ref src) = def.source_sheet {
                    if let Some(local) = pkg_name_to_local.get(src) {
                        def.source_sheet = Some(local.clone());
                    }
                }
                Some((def.id, def))
            })
            .collect()
    };

    // Snapshot the CURRENT pivot definitions (for undo) before replacing them.
    // The payload is built by `undo_commands`, which owns its shape — a local
    // copy of the struct was a second source of truth for a format with exactly
    // one reader.
    let current_pivot_snapshots: Vec<Vec<u8>> = {
        let pivot_tables = pivot_state
            .pivot_tables
            .read()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        published_pivots
            .iter()
            .filter_map(|(pid, _)| {
                let (current_def, current_cache) = pivot_tables.get(pid)?;
                let dest_sheet_idx =
                    crate::pivot::operations::resolve_dest_sheet_index(&state, current_def);
                Some(crate::undo_commands::encode_pivot_definition_snapshot(
                    *pid,
                    current_def.clone(),
                    Vec::new(),
                    dest_sheet_idx,
                    // A reset REPLACES the published definitions, and a
                    // republished pivot can carry a different source: the cache
                    // travels so the undo cannot render the old definition
                    // against the reset's records.
                    Some(current_cache.clone()),
                ))
            })
            .collect()
    };

    // Record the undo transaction FIRST — if applying fails midway the user
    // can still Ctrl+Z back to the captured state. Changes apply in REVERSE on
    // undo, so recording [calp_reset, pivot_definition...] restores the pivot
    // definitions first and the sheet snapshot (which contains the pre-reset
    // rendering) last.
    {
        let data = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
        let description = format!("Reset '{}' to published state", params.package_name);
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo_stack.begin_transaction(&description);
        undo_stack.record_custom_restore("calp_reset".to_string(), data, &description);
        for pivot_snap in current_pivot_snapshots {
            undo_stack.record_custom_restore(
                crate::undo_commands::PIVOT_DEFINITION_RESTORE_KIND.to_string(),
                pivot_snap,
                &description,
            );
        }
        undo_stack.commit_transaction();
    }

    // Reset replaces the tracked sheets' cells, pivot definitions and override
    // layer with the published ones: a real document change relative to the LAST
    // SAVE, even though it is a "revert" in intent. Constructed HERE -- every
    // refusal is behind us and the undo transaction above is already committed,
    // so from this line the command cannot back out.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);

    // Apply: replace each tracked sheet's grid (style-remapped into the shared
    // workspace, exactly like pull/refresh), widths, heights, and merges.
    let mut active_affected = false;
    {
        let mut grids = state.grids.write(&effect).map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.write(&effect).map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.write(&effect).map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.write(&effect).map_err(|e| e.to_string())?;
        for (idx, local_sid, pulled) in &targets {
            let (mut grid, local_styles) = pulled.sheet.to_grid();
            // Remap local style indices (cells AND row/column tiers) to the
            // shared registry, preserving explicit-default duplicates.
            let remap = shared_styles.merge_remap(&local_styles);
            grid.remap_style_indices(&remap);

            // KEEP WHAT THE AUTHOR UNTICKED. Copied out of the live grid AFTER
            // the remap, so the kept cell brings its own style index — which is
            // already a shared-registry index and must not be remapped again.
            //
            // The style rides on the cell because that is where `engine::Cell`
            // carries it; the SHEET-level presentation (widths, heights, merges)
            // is still replaced wholesale below, which the dialog says out loud.
            if let Some(kept) = excluded_by_sheet.get(local_sid) {
                if let Some(live) = grids.get(*idx) {
                    for &(r, c) in kept {
                        match live.get_cell(r, c) {
                            Some(cell) => grid.set_cell(r, c, cell.clone()),
                            // The author kept a cell that is EMPTY locally. That
                            // is a real choice — they deleted it — so the
                            // published content must not come back into it.
                            None => grid.clear_cell(r, c),
                        }
                    }
                }
            }

            if *idx < grids.len() {
                grids[*idx] = grid;
                // Reset to application replaces the sheet's whole grid, so the
                // subscriber's own spill claims for it go with it and the
                // application's extents take their place.
                crate::spill_restore::restore_spill_extents_for_sheet(
                    state.inner(),
                    *idx,
                    &pulled.sheet,
                );
            }
            if *idx < all_cw.len() {
                all_cw[*idx] = pulled.sheet.column_widths.clone();
            }
            if *idx < all_rh.len() {
                all_rh[*idx] = pulled.sheet.row_heights.clone();
            }
        }
    }
    // Sync the active-sheet mirrors (grid, widths, heights) if the active
    // sheet was among the reset sheets — the mirrors are the live copies while
    // a sheet is active; its all_* slots are shadowed.
    //
    // DERIVED CACHE, not a second mutation: `state.grid` is a copy of
    // `grids[active_idx]`, which the block above already rewrote under the
    // command's own `mutates` token further down. Minting a second `mutates`
    // here would be harmless but dishonest — this write adds nothing to what a
    // save would contain that the authoritative one did not already add.
    let mirror_effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::DerivedCache,
    );
    if let Some((idx, _, pulled)) = targets.iter().find(|(idx, _, _)| *idx == active_idx) {
        {
            // ONE LOCK AT A TIME. This used to take `grid` while still holding
            // `grids`, which is the inverted order the recalculation pass
            // deadlocks against; cloning the source sheet out first means
            // neither guard is ever alive while the other is acquired, which is
            // the only arrangement that needs no ordering rule at all.
            let pulled_grid = {
                let grids = state.grids.read().map_err(|e| e.to_string())?;
                grids.get(*idx).cloned()
            };
            if let Some(grid) = pulled_grid {
                *state.grid.write(&mirror_effect).map_err(|e| e.to_string())? = grid;
            }
        }
        *state.column_widths.write(&mirror_effect).map_err(|e| e.to_string())? =
            pulled.sheet.column_widths.clone();
        *state.row_heights.write(&mirror_effect).map_err(|e| e.to_string())? =
            pulled.sheet.row_heights.clone();
        active_affected = true;
    }
    for (idx, _, pulled) in &targets {
        let merges: std::collections::HashSet<crate::api_types::MergedRegion> = pulled
            .sheet
            .merged_regions
            .iter()
            .map(|mr| crate::api_types::MergedRegion {
                start_row: mr.start_row,
                start_col: mr.start_col,
                end_row: mr.end_row,
                end_col: mr.end_col,
            })
            .collect();
        crate::report::with_sheet_merges_mut(&state, &effect, *idx, |m| {
            *m = merges.clone();
        });
    }

    // §2t ON THE DISTRIBUTION PATH -- see `calp_pull`. A reset rebuilds each
    // tracked sheet's formulas from the application's stored TEXT through the same
    // lexer, so without this a "reset to published state" also re-spells every
    // defined name on those sheets in capitals.
    crate::persistence::restamp_workbook_name_casing(&state, &effect);

    // Clear the override layer for the RESTORED cells — the pristine content IS
    // the state there now, and a stale override would re-assert the discarded
    // edit the next time a refresh re-overlays the layer onto the grid.
    //
    // PER CELL, not per sheet, once anything is unticked. An override on a cell
    // the author chose to KEEP is still true — the grid still holds their value
    // and the ledger still records what upstream had — so dropping it would
    // leave the workbook holding a local edit with nothing to say it is one:
    // invisible in the Overrides pane, and silently republished as the
    // publisher's own content on the next push from anyone who checks it out.
    //
    // The position comes from the id registry first, exactly as every other
    // consumer of an override resolves it; an override is id-anchored precisely
    // so it survives a structural shift, and its recorded `position` is only the
    // fallback for a cell whose id the registry has lost.
    {
        let positions: std::collections::HashMap<(SheetId, CellId), (u32, u32)> = {
            let layer = state.override_layer.read().map_err(|e| e.to_string())?;
            let id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
            layer
                .overrides
                .iter()
                .map(|o| {
                    let pos = id_reg
                        .cell_position(o.sheet_id, o.cell_id)
                        .unwrap_or(o.position);
                    ((o.sheet_id, o.cell_id), pos)
                })
                .collect()
        };
        let mut layer = state.override_layer.write(&effect).map_err(|e| e.to_string())?;
        layer.overrides.retain(|o| {
            if !local_sheet_ids.contains(&o.sheet_id) {
                return true;
            }
            let pos = positions
                .get(&(o.sheet_id, o.cell_id))
                .copied()
                .unwrap_or(o.position);
            excluded_by_sheet
                .get(&o.sheet_id)
                .is_some_and(|kept| kept.contains(&pos))
        });
        overrides_cleared = overrides_before.saturating_sub(
            layer
                .overrides
                .iter()
                .filter(|o| local_sheet_ids.contains(&o.sheet_id))
                .count(),
        );
    }

    // Restore the published pivot definitions with an EMPTY cache — the
    // post-reset pivot refresh (frontend) rebuilds grid-pivot caches from the
    // pristine source cells and re-queries BI pivots, then redraws.
    let pivots_reset = {
        let mut pivot_tables = pivot_state
            .pivot_tables
            .write(&effect)
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let mut n = 0usize;
        for (pid, def) in published_pivots {
            if let Some(entry) = pivot_tables.get_mut(&pid) {
                *entry = (def, pivot_engine::PivotCache::new(pid, 0));
                n += 1;
            }
        }
        n
    };

    if active_affected {
        crate::undo_commands::rebuild_all_dependencies(&state);
    }
    // GAP B, reset half — same reasoning as the pull/refresh path above.
    crate::floating_range::register_object_sheet_edges(&state);

    // RECALCULATE HERE, in the command, the way the refresh path does.
    //
    // A whole-sheet reset installed a coherent published sheet, so leaving the
    // evaluation to the frontend was survivable. A PARTIAL reset installs a
    // MIXTURE — the author's cell beside the publisher's — and a formula reading
    // across that boundary holds a number computed from neither state. The
    // frontend does call `calculateNow`, but inside a try/catch that logs and
    // continues, so a failure there leaves the user looking at values that never
    // coexisted, with nothing to say so.
    //
    // Nothing on the receiving side would ever repair it either: neither a pull,
    // nor a checkout, nor opening the file evaluates a cell.
    {
        let indices: Vec<usize> = targets.iter().map(|(idx, _, _)| *idx).collect();
        for idx in indices {
            crate::calculation::recalculate_sheet_values(
                &state,
                &user_files_state,
                &pivot_state,
                idx,
                Some((&*pane_control_state, &*ribbon_filter_state)),
            );
        }
    }

    crate::log_info!(
        "CALP",
        "Reset '{}' v{}: {} sheet(s), {} pivot(s), {} override(s) cleared",
        params.package_name,
        resolved_version,
        targets.len(),
        pivots_reset,
        overrides_cleared
    );

    Ok(ResetSubscriptionResponse {
        sheets_reset: targets.len(),
        overrides_cleared,
        pivots_reset,
        resolved_version,
    })
}

// ============================================================================
// BI Pivot Publish-Time Validation
// ============================================================================

/// Validate all BI pivot definitions in the workbook against the embedded BI models.
/// Returns an error with a human-readable summary if any field names are invalid.
fn validate_bi_pivot_definitions(
    workbook: &persistence::Workbook,
    data_sources: &[calp::publish::PublishDataSource],
) -> Result<(), String> {
    use pivot_engine::PivotDefinition;

    // Collect all table names, column names, measure names, and calculation
    // group names from data sources
    let mut all_tables: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut all_measures: Vec<String> = Vec::new();
    let mut all_calc_groups: std::collections::HashSet<String> = std::collections::HashSet::new();

    for ds in data_sources {
        // Navigate into ModelBundle wrapper if present
        let model_json = if ds.model_json.get("formatVersion").is_some() {
            ds.model_json.get("model").unwrap_or(&ds.model_json)
        } else {
            &ds.model_json
        };

        if let Some(tables) = model_json.get("tables").and_then(|t| t.as_array()) {
            for table in tables {
                let table_name = table.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let columns: Vec<String> = table.get("columns")
                    .and_then(|c| c.as_array())
                    .map(|cols| cols.iter()
                        .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                        .collect())
                    .unwrap_or_default();
                all_tables.insert(table_name.to_string(), columns);
            }
        }

        if let Some(measures) = model_json.get("measures").and_then(|m| m.as_array()) {
            for measure in measures {
                if let Some(name) = measure.get("name").and_then(|n| n.as_str()) {
                    all_measures.push(name.to_string());
                }
            }
        }

        if let Some(groups) = model_json.get("calculation_groups").and_then(|g| g.as_array()) {
            for group in groups {
                if let Some(name) = group.get("name").and_then(|n| n.as_str()) {
                    all_calc_groups.insert(name.to_string());
                }
            }
        }
    }

    // If no data sources with models, nothing to validate against
    if all_tables.is_empty() && all_measures.is_empty() {
        return Ok(());
    }

    let mut errors: Vec<String> = Vec::new();

    for pivot_def in &workbook.pivot_definitions {
        if pivot_def.source_type != "bi" {
            continue;
        }

        let def: PivotDefinition = serde_json::from_value(pivot_def.definition.clone())
            .map_err(|e| format!("Failed to parse pivot definition {}: {}", pivot_def.id, e))?;

        let id_str = pivot_def.id.to_string();
        let pivot_name = def.name.as_deref().unwrap_or(&id_str);

        // Validate row fields
        for field in &def.row_fields {
            validate_dimension_field(field.name.as_str(), "Row", pivot_name, &all_tables, &all_calc_groups, &mut errors);
        }

        // Validate column fields
        for field in &def.column_fields {
            validate_dimension_field(field.name.as_str(), "Column", pivot_name, &all_tables, &all_calc_groups, &mut errors);
        }

        // Validate filter fields
        for field in &def.filter_fields {
            validate_dimension_field(field.field.name.as_str(), "Filter", pivot_name, &all_tables, &all_calc_groups, &mut errors);
        }

        // Validate value fields — must match a BI measure name. Stored value
        // fields carry the DAX-style display wrapper "[Measure]" (see the
        // pivot editor's handleBiMeasureToggle and the bracket-stripping in
        // pivot::commands), so compare the bare name too.
        for field in &def.value_fields {
            let bare = field.name.trim_start_matches('[').trim_end_matches(']');
            if !all_measures.iter().any(|m| m == &field.name || m.as_str() == bare) {
                errors.push(format!(
                    "BI pivot \"{}\": Value field \"{}\" does not match any measure in the model. Available measures: {}",
                    pivot_name,
                    field.name,
                    if all_measures.is_empty() { "(none)".to_string() } else { all_measures.join(", ") },
                ));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Publish failed: BI pivot definitions have invalid fields:\n  - {}",
            errors.join("\n  - ")
        ))
    }
}

/// Validate a single dimension field (row, column, or filter) for a BI pivot.
/// Must be in "Table.Column" format with a valid table and column name —
/// except the recognized non-column placements: a calculation group placed as
/// a dimension (bare group name), the synthetic values-only "Total" row field,
/// and hierarchy fields ("Table.__hierarchy__.Name").
fn validate_dimension_field(
    name: &str,
    area: &str,
    pivot_name: &str,
    tables: &std::collections::HashMap<String, Vec<String>>,
    calc_groups: &std::collections::HashSet<String>,
    errors: &mut Vec<String>,
) {
    // A calculation group placed as a dimension is stored under its bare
    // group name (the backend maps it to the CALC_GROUP_TABLE pseudo-ref).
    if calc_groups.contains(name) {
        return;
    }

    // The synthetic values-only "Total" row field is an internal placeholder
    // (re-injected by update_bi_pivot_fields as needed), not a model column.
    if name == "Total" {
        return;
    }

    // Hierarchy placement: only the table part names a model object; the
    // hierarchy's levels resolve against the model at query time.
    if let Some((table_name, _hierarchy)) = name.split_once(".__hierarchy__.") {
        if !tables.contains_key(table_name) {
            let available = tables.keys().cloned().collect::<Vec<_>>().join(", ");
            errors.push(format!(
                "BI pivot \"{}\": {} field \"{}\" references table \"{}\" which does not exist in the model. Available tables: {}",
                pivot_name, area, name, table_name,
                if available.is_empty() { "(none)".to_string() } else { available },
            ));
        }
        return;
    }

    if !name.contains('.') {
        errors.push(format!(
            "BI pivot \"{}\": {} field \"{}\" is not in Table.Column format (expected e.g. \"dim_product.categoryname\")",
            pivot_name, area, name,
        ));
        return;
    }

    // Table names can contain dots — resolve against the model's table names.
    let (table_name, column_name) =
        crate::pivot::commands::split_bi_field_key(name, tables.keys().map(|k| k.as_str()));

    if let Some(columns) = tables.get(&table_name) {
        if !columns.iter().any(|c| *c == column_name) {
            errors.push(format!(
                "BI pivot \"{}\": {} field \"{}\" references column \"{}\" which does not exist in table \"{}\". Available columns: {}",
                pivot_name, area, name, column_name, table_name,
                if columns.is_empty() { "(none)".to_string() } else { columns.join(", ") },
            ));
        }
    } else {
        let available = tables.keys().cloned().collect::<Vec<_>>().join(", ");
        errors.push(format!(
            "BI pivot \"{}\": {} field \"{}\" references table \"{}\" which does not exist in the model. Available tables: {}",
            pivot_name, area, name, table_name,
            if available.is_empty() { "(none)".to_string() } else { available },
        ));
    }
}

#[cfg(test)]
mod bi_pivot_validation_tests {
    use super::validate_bi_pivot_definitions;
    use pivot_engine::{AggregationType, PivotDefinition, PivotField, ValueField};

    fn model_data_source() -> calp::publish::PublishDataSource {
        calp::publish::PublishDataSource {
            id: "ds1".to_string(),
            name: "Model".to_string(),
            connection_type: "file".to_string(),
            server: String::new(),
            database: String::new(),
            model_json: serde_json::json!({
                "tables": [
                    { "name": "dim_customer", "columns": [ { "name": "country" }, { "name": "city" } ] }
                ],
                "measures": [ { "name": "Revenue" }, { "name": "% Revenue of Total" } ],
                "calculation_groups": [ { "name": "Time Intelligence", "items": [] } ]
            }),
            bindings: Vec::new(),
            calculated_table_snapshots: Vec::new(),
            writeback_history_json: None,
        }
    }

    fn bi_def() -> PivotDefinition {
        PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0))
    }

    fn workbook_with_bi_pivot(def: &PivotDefinition) -> persistence::Workbook {
        let mut wb = persistence::Workbook::default();
        wb.pivot_definitions.push(persistence::SavedPivotDefinition {
            id: identity::EntityId::ZERO,
            source_type: "bi".to_string(),
            source_sheet_index: None,
            definition: serde_json::to_value(def).unwrap(),
        });
        wb
    }

    #[test]
    fn bracketed_measure_value_field_is_valid() {
        let mut def = bi_def();
        def.row_fields.push(PivotField::new(0, "dim_customer.country".to_string()));
        def.value_fields.push(ValueField::new(0, "[Revenue]".to_string(), AggregationType::Sum));
        let wb = workbook_with_bi_pivot(&def);
        let result = validate_bi_pivot_definitions(&wb, &[model_data_source()]);
        assert!(result.is_ok(), "unexpected error: {:?}", result);
    }

    #[test]
    fn unknown_measure_still_fails() {
        let mut def = bi_def();
        def.value_fields.push(ValueField::new(0, "[Profit]".to_string(), AggregationType::Sum));
        let wb = workbook_with_bi_pivot(&def);
        let err = validate_bi_pivot_definitions(&wb, &[model_data_source()]).unwrap_err();
        assert!(err.contains("does not match any measure"), "unexpected error: {err}");
    }

    #[test]
    fn calc_group_and_synthetic_total_row_fields_are_valid() {
        let mut def = bi_def();
        def.row_fields.push(PivotField::new(0, "Total".to_string()));
        def.row_fields.push(PivotField::new(0, "Time Intelligence".to_string()));
        def.value_fields.push(ValueField::new(0, "[% Revenue of Total]".to_string(), AggregationType::Sum));
        let wb = workbook_with_bi_pivot(&def);
        let result = validate_bi_pivot_definitions(&wb, &[model_data_source()]);
        assert!(result.is_ok(), "unexpected error: {:?}", result);
    }

    #[test]
    fn hierarchy_field_validates_table_part() {
        let mut def = bi_def();
        def.row_fields.push(PivotField::new(0, "dim_customer.__hierarchy__.Geo".to_string()));
        def.value_fields.push(ValueField::new(0, "[Revenue]".to_string(), AggregationType::Sum));
        let result = validate_bi_pivot_definitions(&workbook_with_bi_pivot(&def), &[model_data_source()]);
        assert!(result.is_ok(), "unexpected error: {:?}", result);

        let mut bad = bi_def();
        bad.row_fields.push(PivotField::new(0, "nope.__hierarchy__.Geo".to_string()));
        let err = validate_bi_pivot_definitions(&workbook_with_bi_pivot(&bad), &[model_data_source()])
            .unwrap_err();
        assert!(err.contains("does not exist"), "unexpected error: {err}");
    }

    #[test]
    fn stale_grid_style_field_still_fails() {
        let mut def = bi_def();
        def.row_fields.push(PivotField::new(0, "Category".to_string()));
        let err = validate_bi_pivot_definitions(&workbook_with_bi_pivot(&def), &[model_data_source()])
            .unwrap_err();
        assert!(err.contains("not in Table.Column format"), "unexpected error: {err}");
    }
}

#[cfg(test)]
mod c8_materialize_tests {
    use super::materialize_distributed_scripts;
    use crate::scripting::types::{ScriptScope, ScriptState, WorkbookScript};

    /// A pulled module, stamped with its source application (as pull does).
    fn mk_module(pkg: &str, id: &str, source: &str) -> persistence::SavedScript {
        persistence::SavedScript {
            id: id.to_string(),
            name: "M".to_string(),
            description: None,
            source: source.to_string(),
            scope: persistence::SavedScriptScope::Workbook,
            source_package: Some(pkg.to_string()),
        }
    }

    fn mk_notebook(pkg: &str, id: &str, src: &str) -> persistence::SavedNotebook {
        persistence::SavedNotebook {
            id: id.to_string(),
            name: "N".to_string(),
            cells: vec![persistence::SavedNotebookCell {
                id: "c1".to_string(),
                source: src.to_string(),
                last_output: Vec::new(),
                last_error: None,
                cells_modified: 0,
                duration_ms: 0,
                execution_index: None,
            }],
            source_package: Some(pkg.to_string()),
        }
    }

    #[test]
    fn materializes_modules_and_notebooks_into_script_state() {
        let st = ScriptState::new();
        materialize_distributed_scripts(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()), &st, "pkg", &[mk_module("pkg", "m1", "v1")], &[mk_notebook("pkg", "n1", "x")]).unwrap();
        let scripts = st.workbook_scripts.read().unwrap();
        assert_eq!(scripts.get("m1").unwrap().source, "v1");
        assert_eq!(scripts.get("m1").unwrap().source_package.as_deref(), Some("pkg"));
        assert_eq!(st.workbook_notebooks.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap().get("n1").unwrap().cells[0].source, "x");
    }

    #[test]
    fn same_package_refresh_replaces_the_prior_version() {
        let st = ScriptState::new();
        materialize_distributed_scripts(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()), &st, "pkg", &[mk_module("pkg", "m1", "v1")], &[mk_notebook("pkg", "n1", "old")]).unwrap();
        materialize_distributed_scripts(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()), &st, "pkg", &[mk_module("pkg", "m1", "v2-updated")], &[mk_notebook("pkg", "n1", "new")]).unwrap();
        let scripts = st.workbook_scripts.read().unwrap();
        assert_eq!(scripts.len(), 1, "same id replaces, not duplicates");
        assert_eq!(scripts.get("m1").unwrap().source, "v2-updated");
        assert_eq!(st.workbook_notebooks.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap().get("n1").unwrap().cells[0].source, "new");
    }

    #[test]
    fn removal_on_refresh_drops_a_module_the_package_no_longer_ships() {
        let st = ScriptState::new();
        materialize_distributed_scripts(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()), &st, "pkg", &[mk_module("pkg", "m1", "a"), mk_module("pkg", "m2", "b")], &[]).unwrap();
        // The next version ships only m1 -> m2 must be removed.
        materialize_distributed_scripts(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()), &st, "pkg", &[mk_module("pkg", "m1", "a2")], &[]).unwrap();
        let scripts = st.workbook_scripts.read().unwrap();
        assert_eq!(scripts.len(), 1);
        assert!(scripts.contains_key("m1"));
        assert!(!scripts.contains_key("m2"), "removed-upstream module must be dropped on refresh");
    }

    #[test]
    fn preserves_a_subscriber_local_same_id_module() {
        let st = ScriptState::new();
        // A genuinely local (subscriber-authored) module with id "m1".
        st.workbook_scripts.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap().insert(
            "m1".to_string(),
            WorkbookScript {
                id: "m1".to_string(),
                name: "Local".to_string(),
                description: None,
                source: "my local edit".to_string(),
                scope: ScriptScope::Workbook,
                source_package: None,
            },
        );
        // An application ships its own "m1" -> the local one is preserved, application skipped.
        materialize_distributed_scripts(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()), &st, "pkg", &[mk_module("pkg", "m1", "upstream")], &[]).unwrap();
        let scripts = st.workbook_scripts.read().unwrap();
        assert_eq!(scripts.get("m1").unwrap().source, "my local edit");
        assert_eq!(scripts.get("m1").unwrap().source_package, None);
    }

    #[test]
    fn does_not_let_one_package_shadow_anothers_same_id() {
        let st = ScriptState::new();
        materialize_distributed_scripts(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()), &st, "pkg-a", &[mk_module("pkg-a", "m1", "from-a")], &[]).unwrap();
        // A second application reuses the id -> the first application keeps ownership.
        materialize_distributed_scripts(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default()), &st, "pkg-b", &[mk_module("pkg-b", "m1", "from-b")], &[]).unwrap();
        let scripts = st.workbook_scripts.read().unwrap();
        assert_eq!(scripts.get("m1").unwrap().source, "from-a");
        assert_eq!(scripts.get("m1").unwrap().source_package.as_deref(), Some("pkg-a"));
    }

    // -----------------------------------------------------------------------
    // The host's reserved `__calcula_` id namespace is not the publisher's
    // -----------------------------------------------------------------------

    fn effect() -> crate::document_effect::DocumentEffect {
        crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())
    }

    /// THE DEFECT, restated. A module id starting with `__calcula_` is HIDDEN by
    /// `list_scripts` and REFUSED by `delete_script`, so a published module that
    /// claimed one landed in the subscriber's workbook invisible AND undeletable
    /// — code sitting in the user's document that the user cannot see or remove,
    /// which is the exact inverse of the Transparency pillar.
    #[test]
    fn a_published_module_cannot_claim_the_hosts_reserved_id_namespace() {
        let st = ScriptState::new();
        let res = materialize_distributed_scripts(
            &effect(),
            &st,
            "pkg",
            &[mk_module("pkg", "__calcula_stowaway", "hidden();")],
            &[],
        );
        assert!(
            res.is_err(),
            "a module claiming the reserved namespace must be REFUSED; it was applied and \
             the workbook now holds {:?}",
            st.workbook_scripts.read().unwrap().keys().collect::<Vec<_>>()
        );
        let err = res.unwrap_err();

        assert!(err.contains("__calcula_stowaway"), "must name the id: {err}");
        assert!(err.contains("__calcula_"), "must name the reserved prefix: {err}");
        assert!(err.contains("'pkg'"), "must name the application: {err}");
        // The refusal is loud about not renaming — a rename would break the
        // application's own references AND hide that it tried.
        assert!(err.contains("rename"), "must say why it is not renamed: {err}");

        // NOTHING landed. The gate runs before the first lock is taken, so a
        // refusal is not a partial materialization.
        assert!(
            st.workbook_scripts.read().unwrap().is_empty(),
            "a refused pull must write no module at all"
        );
    }

    /// Same rule on the notebook map. Nothing merges a notebook, and the prefix
    /// belongs to the host on both maps regardless of which one hides its ids.
    #[test]
    fn a_published_notebook_cannot_claim_it_either() {
        let st = ScriptState::new();
        let res = materialize_distributed_scripts(
            &effect(),
            &st,
            "pkg",
            &[],
            &[mk_notebook("pkg", "__calcula_notes", "x")],
        );
        assert!(
            res.is_err(),
            "a notebook claiming the reserved namespace must be REFUSED; it was applied and \
             the workbook now holds {:?}",
            st.workbook_notebooks.read().unwrap().keys().collect::<Vec<_>>()
        );
        let err = res.unwrap_err();
        assert!(err.contains("__calcula_notes"), "must name the id: {err}");
        assert!(
            st.workbook_notebooks.read().unwrap().is_empty(),
            "a refused pull must write no notebook at all"
        );
    }

    /// A refusal takes the WHOLE application with it, rather than skipping the
    /// one id and applying the rest: a half-applied application is a state the
    /// subscriber cannot see, and this publisher is doing something pointed.
    #[test]
    fn one_reserved_id_refuses_the_whole_application() {
        let st = ScriptState::new();
        let res = materialize_distributed_scripts(
            &effect(),
            &st,
            "pkg",
            &[
                mk_module("pkg", "ordinary", "fine();"),
                mk_module("pkg", "__calcula_stowaway", "hidden();"),
            ],
            &[],
        );
        assert!(
            res.is_err(),
            "one reserved id must refuse the whole application; the workbook now holds {:?}",
            st.workbook_scripts.read().unwrap().keys().collect::<Vec<_>>()
        );
        let err = res.unwrap_err();
        assert!(err.contains("Nothing was imported"), "{err}");
        assert!(
            st.workbook_scripts.read().unwrap().get("ordinary").is_none(),
            "the innocent module from the same application must not land either"
        );
    }

    /// THE ONE EXEMPTION, and it must keep working. `__calcula_custom_functions__`
    /// collides across every workbook by design and has its own per-function
    /// merge (validated names, subscriber-owned record, no capability widening).
    /// Refusing it would break a shipped feature — publishing a custom-function
    /// library — for every application that carries one.
    #[test]
    fn the_custom_functions_library_is_still_admitted() {
        let st = ScriptState::new();
        let lib = r#"{"functions":[{"name":"DOUBLEIT","body":"return x*2;"}]}"#;
        let (_, _, changed) = materialize_distributed_scripts(
            &effect(),
            &st,
            "pkg",
            &[mk_module("pkg", "__calcula_custom_functions__", lib)],
            &[],
        )
        .expect("the custom-functions library has a merge path and must not be refused");
        assert!(changed, "the merged library record changed");
        let scripts = st.workbook_scripts.read().unwrap();
        let merged = scripts
            .get("__calcula_custom_functions__")
            .expect("the library record is merged in");
        assert!(merged.source.contains("DOUBLEIT"), "{}", merged.source);
        assert_eq!(
            merged.source_package, None,
            "the merged record stays subscriber-owned"
        );
    }

    /// An ordinary id is untouched by the gate — the refusal is about one
    /// namespace, not about distributed modules in general.
    #[test]
    fn an_ordinary_id_is_unaffected_by_the_reserved_namespace_gate() {
        let st = ScriptState::new();
        materialize_distributed_scripts(
            &effect(),
            &st,
            "pkg",
            // Deliberately close to the prefix without being in it — the check
            // is a prefix test, not a substring test.
            &[mk_module("pkg", "calcula_helper", "ok();")],
            &[],
        )
        .expect("an ordinary id must still materialize");
        assert!(st.workbook_scripts.read().unwrap().contains_key("calcula_helper"));
    }
}

#[cfg(test)]
mod pane_control_pull_tests {
    //! Unit tests for the shared pull/refresh pane-control materializer —
    //! above all the taken-names collision guard, which must also cover NAMED
    //! on-grid controls: a pulled pane control shadows them in the
    //! GET.CONTROLVALUE precedence (pane > filter > on-grid), so collisions
    //! are SKIPPED (never renamed, never clobbered), matching the existing
    //! pane/filter collision policy.
    use super::{
        materialize_pulled_pane_controls, orphaned_pane_script_instance_ids,
        pane_control_taken_names,
    };
    use crate::controls::{ControlMetadata, ControlPropertyValue, ControlStorage};
    use crate::pane_control::{PaneControl, PaneControlConfig, PaneControlState, PaneControlType};
    use crate::ribbon_filter::RibbonFilterState;
    use std::collections::HashMap;

    /// An on-grid control whose "name" property has the given type/value.
    fn on_grid(name_type: &str, name: &str) -> ControlMetadata {
        let mut properties = HashMap::new();
        properties.insert(
            "name".to_string(),
            ControlPropertyValue {
                value_type: name_type.to_string(),
                value: name.to_string(),
            },
        );
        ControlMetadata {
            control_type: "button".to_string(),
            properties,
        }
    }

    /// A pulled (application) checkbox pane control.
    fn saved(name: &str, order: u32) -> persistence::SavedPaneControl {
        persistence::SavedPaneControl {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            control_type: "checkbox".to_string(),
            config: serde_json::json!({ "type": "checkbox", "label": name }),
            value: serde_json::Value::Null,
            order,
        }
    }

    /// A subscriber-local pane control already in the strip.
    fn existing_pane(name: &str, order: u32) -> PaneControl {
        PaneControl {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            control_type: PaneControlType::Checkbox,
            config: PaneControlConfig::Checkbox {
                label: name.to_string(),
            },
            value: None,
            order,
        }
    }

    #[test]
    fn taken_names_include_static_named_on_grid_controls_only() {
        // The static_control_name rule: static + non-empty after trim counts;
        // formula-typed and blank names never block a pull.
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 1, 1), on_grid("static", "  Threshold "));
        storage.insert((0, 2, 1), on_grid("formula", "=A1"));
        storage.insert((0, 3, 1), on_grid("static", "   "));
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        let names = pane_control_taken_names(
            pane.controls.lock().unwrap().values(),
            filters.filters.read().unwrap().values(),
            &storage,
        );
        assert_eq!(
            names,
            std::collections::HashSet::from(["THRESHOLD".to_string()])
        );
    }

    #[test]
    fn pulled_pane_control_cannot_shadow_a_named_on_grid_control() {
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 0, 0), on_grid("static", "Threshold"));

        // Case-insensitive: "THRESHOLD" collides with on-grid "Threshold"
        // and is skipped; "Rate" lands and is reported as applied.
        let pulled = vec![saved("THRESHOLD", 0), saved("Rate", 1)];
        let applied =
            materialize_pulled_pane_controls(&pane, &filters, &storage, &pulled).unwrap();
        assert_eq!(applied.len(), 1, "applied: {:?}", applied);
        assert_eq!(applied[0].1, "Rate");
        let controls = pane.controls.lock().unwrap();
        assert_eq!(controls.len(), 1);
        assert!(controls.values().all(|c| c.name == "Rate"));
    }

    #[test]
    fn applied_controls_rebase_after_existing_strip_and_skip_id_collisions() {
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        let existing = existing_pane("Local", 7);
        let existing_id = existing.id;
        pane.controls.lock().unwrap().insert(existing_id, existing);

        // A same-id pull is skipped (never clobbers the subscriber's control);
        // the fresh one appends after the strip's max order.
        let mut same_id = saved("Local2", 0);
        same_id.id = existing_id;
        let pulled = vec![same_id, saved("Fresh", 5)];
        let applied =
            materialize_pulled_pane_controls(&pane, &filters, &HashMap::new(), &pulled).unwrap();
        assert_eq!(applied.len(), 1, "applied: {:?}", applied);
        assert_eq!(applied[0].1, "Fresh");
        let controls = pane.controls.lock().unwrap();
        assert_eq!(controls.len(), 2);
        let fresh = controls.values().find(|c| c.name == "Fresh").unwrap();
        assert_eq!(fresh.order, 8, "re-based to max existing order + 1");
        assert_eq!(
            controls.get(&existing_id).unwrap().name,
            "Local",
            "id collision never clobbers the subscriber's control"
        );
    }

    #[test]
    fn package_own_on_grid_names_never_shadow_its_pane_controls() {
        // The calp_pull/refresh ordering contract: the on-grid snapshot handed
        // to the materializer is taken BEFORE the application's own on-grid
        // controls land. An application shipping BOTH an on-grid button and a pane
        // control named "Threshold" must still get its pane control applied —
        // the guard protects the SUBSCRIBER's pre-existing names, not the
        // application against itself.
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        // Subscriber's pre-pull on-grid state: one named control of their own.
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 0, 0), on_grid("static", "LocalName"));
        let snapshot = storage.clone(); // what calp_pull snapshots pre-materialization
        // The application's own on-grid control materializes (same name as its
        // pane control) — AFTER the snapshot, so it must not enter taken_names.
        storage.insert((3, 1, 1), on_grid("static", "Threshold"));

        let pulled = vec![saved("Threshold", 0), saved("LocalName", 1)];
        let applied =
            materialize_pulled_pane_controls(&pane, &filters, &snapshot, &pulled).unwrap();
        assert_eq!(applied.len(), 1, "applied: {:?}", applied);
        assert_eq!(
            applied[0].1, "Threshold",
            "the application's own on-grid name must not block its own pane control"
        );
        // The subscriber's name still guards: "LocalName" was skipped.
        assert!(pane.controls.lock().unwrap().values().all(|c| c.name == "Threshold"));
    }

    #[test]
    fn orphaned_pane_script_instances_cover_skipped_but_not_retained_controls() {
        // Name-collision skip -> host absent -> "pane-{id}" reported orphaned.
        // Id-collision skip -> the subscriber's control is retained under that
        // id -> its script keeps a live host -> NOT reported. Applied -> not
        // reported.
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        let existing = existing_pane("Local", 0);
        let existing_id = existing.id;
        pane.controls.lock().unwrap().insert(existing_id, existing);
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 0, 0), on_grid("static", "Taken"));

        let name_skipped = saved("Taken", 0); // on-grid name collision -> absent
        let mut id_skipped = saved("Local2", 1); // id collision -> retained
        id_skipped.id = existing_id;
        let applied_ok = saved("Fresh", 2); // lands
        let name_skipped_id = name_skipped.id;
        let pulled = vec![name_skipped, id_skipped, applied_ok];

        let applied =
            materialize_pulled_pane_controls(&pane, &filters, &storage, &pulled).unwrap();
        assert_eq!(applied.len(), 1, "applied: {:?}", applied);

        let orphaned = orphaned_pane_script_instance_ids(&pane, &pulled).unwrap();
        assert_eq!(
            orphaned,
            std::collections::HashSet::from([format!("pane-{}", name_skipped_id)]),
            "only the name-collision-skipped control's instance id is orphaned"
        );
    }
}

#[cfg(test)]
mod tofu_pin_policy_guard_tests {
    //! SOURCE-LEVEL DRIFT GUARD for the TOFU pin policy (Wave J).
    //!
    //! The type system already stops a caller from FORGETTING the policy —
    //! `calp::integrity::verify_and_load_manifest_via` takes a required
    //! `PinPolicy` with no `Default` and no `Option`, so an omission does not
    //! compile. What the type system cannot express is WHICH policy is correct
    //! for a given surface. That is a judgement about what the USER just did,
    //! and it is the judgement that was wrong three waves in a row:
    //!   * Wave H — extension scanning pinned on every app launch.
    //!   * Wave I — library resolution pinned on preview.
    //!   * Wave J — .calp inspection, workbook OPEN, writeback submit and every
    //!     GATHER recalculation all pinned.
    //!
    //! So these tests pin down the ANSWER, not just the shape: which files may
    //! create a `.calp` pin, and the fact that the passive and already-trusted
    //! paths use the non-pinning entry points. A new caller that starts pinning
    //! shows up here as a failing test with the reason attached.

    /// This guard module's own body mentions every string it forbids (in the
    /// assertion messages), so it must never be scanned by its own rules.
    fn scan(src: &str) -> String {
        let body = src
            .split("mod tofu_pin_policy_guard_tests")
            .next()
            .expect("split yields at least one part");
        // Drop comment lines: a doc comment EXPLAINING a policy is not a USE of
        // it, and counting explanations would punish documenting the rule.
        body.lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("///") && !t.starts_with("//!")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The ONLY .calp surfaces in the app crate that may create a TOFU pin.
    ///
    /// Both are commit points with a human behind them:
    ///   * `calp_commands::calp_pull`      — Subscribe, after the user reviewed
    ///     the application and its publisher key in the Subscribe dialog.
    ///   * `library_commands::library_resolve(confirm: true)` — Install, after
    ///     the user approved the resolved closure.
    ///
    /// `extension_install.rs` and `managed_policy.rs` pin too, but through
    /// `calp::signing::pin_publisher` directly rather than through the manifest
    /// verifier, and both are already-audited commit points (a confirmed add-in
    /// install; an administrator's `%PROGRAMDATA%` policy). They are covered by
    /// `the_raw_pin_write_has_exactly_two_production_callers` below.
    #[test]
    fn only_subscribe_and_install_may_create_a_calp_pin() {
        let files: [(&str, &str, usize); 6] = [
            // calp_pull, and nothing else: the two arms that choose between
            // `PinOnFirstUse` and its conflict-accepting sibling.
            ("calp_commands.rs", include_str!("calp_commands.rs"), 2),
            ("calp_inspector.rs", include_str!("calp_inspector.rs"), 0),
            // library_resolve's `confirm` mapping (1), the per-request
            // conflict-acceptance upgrade in `resolve_libraries` (3) and the
            // install-expectations gate next to it (2), plus the three arms of
            // `verify_library_manifest` that act on the policy (the conflict
            // refusal and the pair that pins).
            ("library_commands.rs", include_str!("library_commands.rs"), 8),
            ("managed_policy.rs", include_str!("managed_policy.rs"), 0),
            ("bi/writeback.rs", include_str!("bi/writeback.rs"), 0),
            ("bi/writeback_source.rs", include_str!("bi/writeback_source.rs"), 0),
        ];

        for (name, src, expected) in files {
            // Production only: a test may legitimately exercise the pinning
            // path, and `library_commands.rs` has many that do.
            let prod = scan(src.split("#[cfg(test)]").next().unwrap());
            // BOTH pinning policies are counted. `PinAcceptingNameConflict` is
            // `PinOnFirstUse` plus a second, differently-worded confirmation
            // that the user saw a cross-workspace name conflict — it is the same
            // KIND of statement (the user decided to trust a publisher), so it
            // belongs to the same budget. Counting only one of them would let a
            // new pinning call site hide behind the other.
            let pins = prod.matches("PinPolicy::PinOnFirstUse").count()
                + prod.matches("PinPolicy::PinAcceptingNameConflict").count();
            assert_eq!(
                pins, expected,
                "{name} contains {pins} pinning-policy use(s) in production code, expected \
                 {expected}. Creating a TOFU pin is a statement that the USER decided to trust a \
                 publisher. If you are adding one it must be a commit point with a human behind \
                 it — and this list must say so."
            );
        }
    }

    /// The passive `.calp` surfaces must stay passive, and the already-trusted
    /// ones must stay fail-closed.
    #[test]
    fn passive_and_already_trusted_calp_surfaces_use_the_non_pinning_entry_points() {
        let inspector = scan(include_str!("calp_inspector.rs"));
        assert!(
            inspector.contains("PinPolicy::VerifyOnly"),
            "the Package Inspector must verify WITHOUT pinning: PackageInspectorApp loads the \
             overview automatically on browse/drop, so pointing the inspector at a folder would \
             otherwise write a pin nobody asked for (the Wave-H scan bug, again)"
        );
        assert!(
            !inspector.contains("PinPolicy::PinOnFirstUse")
                && !inspector.contains("PinPolicy::RequirePinned"),
            "every Package Inspector command is VerifyOnly — it must neither create trust nor \
             refuse to display an untrusted package (displaying it is the whole point)"
        );

        let cmds = scan(include_str!("calp_commands.rs"));
        // The already-trusted sites go through `load_pinned_manifest_via`,
        // which returns the manifest ALONE. That is deliberate: these sites
        // used to bind the trust answer as `_` and carry on, which is how a
        // fail-open hole hides. A site that cannot obtain a status cannot
        // ignore one.
        let pinned_reads = cmds.matches("load_pinned_manifest_via(").count();
        assert!(
            pinned_reads >= 7,
            "expected the writeback / GATHER / model-writeback sites to use \
             calp::integrity::load_pinned_manifest_via; found {pinned_reads}"
        );
        // ...and none of them may go back to binding a discarded trust status.
        // The verifier now returns a STRUCT (`VerifiedManifest`), which kills the
        // positional forms below by construction — they are kept so a future
        // editor who reintroduces a tuple return trips this immediately.
        for discarded in [
            "Ok((_, ver_manifest)) = calp::integrity::",
            "Ok((_, manifest)) = calp::integrity::",
            "Ok((_, m)) => m,",
            ".map(|(_, m)| m)",
            ".and_then(|(_, m)|",
            "VerifiedManifest { trust: _,",
            "verified.trust;",
        ] {
            assert!(
                !cmds.contains(discarded),
                "found a discarded trust answer in calp_commands.rs (`{discarded}`). Use \
                 load_pinned_manifest_via (already-trusted) or handle every TrustStatus."
            );
        }
        // Subscribe / inspect are the only two policy-taking verifier calls
        // left in this file; everything else is a pinned read.
        let verifier_calls = cmds.matches("verify_and_load_manifest_via(").count();
        assert_eq!(
            verifier_calls, 2,
            "calp_commands.rs should call the policy-taking verifier exactly twice \
             (calp_inspect_application = VerifyOnly, calp_subscription_trust = VerifyOnly); \
             calp_pull goes through calp::pull::pull. Found {verifier_calls}."
        );

        for (name, src) in [
            ("bi/writeback.rs", include_str!("bi/writeback.rs")),
            ("bi/writeback_source.rs", include_str!("bi/writeback_source.rs")),
        ] {
            let prod = scan(src);
            assert!(
                prod.contains("load_pinned_manifest_via("),
                "{name} feeds the model engine from subscribed packages: it must require an \
                 existing pin rather than create one"
            );
            assert!(
                !prod.contains("verify_and_load_manifest_via("),
                "{name} must not call the policy-taking verifier directly — \
                 load_pinned_manifest_via is the already-trusted entry point"
            );
        }
    }

    /// A `.calp` pin is filed under a WORKSPACE SCOPE, and the scope has to come
    /// from the same string the workspace was opened with. `open_workspace_scoped`
    /// is what makes those inseparable, so nothing in the app crate may open a
    /// workspace any other way.
    #[test]
    fn every_registry_is_opened_together_with_its_pin_scope() {
        for (name, src) in [
            ("calp_commands.rs", include_str!("calp_commands.rs")),
            ("calp_inspector.rs", include_str!("calp_inspector.rs")),
            ("library_commands.rs", include_str!("library_commands.rs")),
            ("managed_policy.rs", include_str!("managed_policy.rs")),
            ("bi/writeback.rs", include_str!("bi/writeback.rs")),
            ("bi/writeback_source.rs", include_str!("bi/writeback_source.rs")),
            ("scripting/distribution_gateway.rs", include_str!("scripting/distribution_gateway.rs")),
        ] {
            let prod = scan(src.split("#[cfg(test)]").next().unwrap());
            assert!(
                !prod.contains("calp_registry::open_registry("),
                "{name} opens a registry without deriving its pin scope. Use \
                 calp_registry::open_workspace_scoped: a pin written under a scope derived from \
                 one string and read under a scope derived from another is a pin that silently \
                 never matches."
            );
        }
    }

    /// THE SCOPE MUST BE DERIVED FROM THE STRING THE USER CONFIGURED — including
    /// its `file://` prefix.
    ///
    /// `open_workspace_scoped` makes the transport and the pin scope arrive
    /// together, but that only helps if it is handed the SAME string `pull`
    /// scoped the pin with. Ten call sites in this crate ran their own
    /// `strip_prefix("file://")` on a subscription's `registry_url` first, which
    /// is not the crate's stripper and does not agree with it:
    ///
    ///   * `file:///C:/reg`      -> `/C:/reg`      -> scope `\c:\reg`, not `c:\reg`
    ///   * `file://server/share` -> `server/share` -> a cwd-relative path
    ///
    /// The pin was then written under one identity and looked up under another,
    /// so `RequirePinned` answered `PublisherNotPinned` and writeback, GATHER
    /// and model writeback silently went inert for those subscriptions — a pin
    /// that is never consulted is not a pin. `calp::workspace_id::strip_file_scheme`
    /// is the one stripper, and `workspace_scope` already calls it; no caller
    /// needs a second one.
    #[test]
    fn nothing_pre_strips_the_file_scheme_before_deriving_a_scope() {
        for (name, src) in [
            ("calp_commands.rs", include_str!("calp_commands.rs")),
            ("calp_inspector.rs", include_str!("calp_inspector.rs")),
            ("calp_registry.rs", include_str!("calp_registry.rs")),
            ("library_commands.rs", include_str!("library_commands.rs")),
            ("managed_policy.rs", include_str!("managed_policy.rs")),
            ("bi/writeback.rs", include_str!("bi/writeback.rs")),
            ("bi/writeback_source.rs", include_str!("bi/writeback_source.rs")),
            (
                "scripting/distribution_gateway.rs",
                include_str!("scripting/distribution_gateway.rs"),
            ),
        ] {
            let prod = scan(src.split("#[cfg(test)]").next().unwrap());
            assert!(
                !prod.contains(r#"strip_prefix("file://")"#),
                "{name} strips the file:// scheme itself. Pass the location through unchanged \
                 (open_workspace_scoped derives the scope from it), or use \
                 calp::workspace_id::strip_file_scheme when a real filesystem path is genuinely \
                 needed. A hand-rolled strip disagrees with the one the pin was scoped by, and \
                 the mismatch is silent: the package simply stops being trusted."
            );
        }
    }

    /// `calp::signing::pin_publisher` is the raw pin write. Only the two
    /// already-audited direct commit points may call it.
    #[test]
    fn the_raw_pin_write_has_exactly_two_production_callers() {
        let sanctioned: [(&str, &str, usize); 2] = [
            // The user confirmed "Install add-in" (Wave H reference impl).
            ("extension_install.rs", include_str!("extension_install.rs"), 1),
            // An administrator authored %PROGRAMDATA%\Calcula\policy.json.
            ("managed_policy.rs", include_str!("managed_policy.rs"), 1),
        ];
        for (name, src, expected) in sanctioned {
            let prod = scan(src.split("#[cfg(test)]").next().unwrap());
            assert_eq!(
                prod.matches("pin_publisher(").count(),
                expected,
                "{name} must contain exactly {expected} pin_publisher call(s)"
            );
        }

        // Everything else in the .calp trust stack goes through the verifier,
        // whose policy parameter is the thing that cannot be forgotten.
        // (library_commands.rs is excluded: it defers an INSTALL's pins to a
        // batch commit so a partly-failed install leaves no pins behind, and
        // its own tests cover that.)
        for (name, src) in [
            ("calp_commands.rs", include_str!("calp_commands.rs")),
            ("calp_inspector.rs", include_str!("calp_inspector.rs")),
            ("bi/writeback.rs", include_str!("bi/writeback.rs")),
            ("bi/writeback_source.rs", include_str!("bi/writeback_source.rs")),
        ] {
            let prod = scan(src.split("#[cfg(test)]").next().unwrap());
            assert!(
                !prod.contains("pin_publisher("),
                "{name} must not write the pin store directly — go through \
                 calp::integrity::verify_and_load_manifest_via with an explicit PinPolicy"
            );
        }
    }
}

/// EVERY field of `persistence::Workbook`, and what a `.calp` publish does with it.
///
/// THE SAME PRODUCER THE XLSX LOSS REPORT NEEDED, for the other distribution
/// path — and it was needed for the same reason. `compute_publish_report` is a
/// hand-maintained list of what an application carries and what it leaves behind, and
/// it had drifted exactly the way the xlsx one had: `cell_behaviors` was neither
/// carried nor mentioned (a published report's typed cells arrived inert), and
/// `workbook_protection`, `bi_connection_roles` and the two workbook-wide grid
/// defaults were dropped with no line anywhere saying so.
///
/// That matters more here than for `.xlsx`. An `.xlsx` save loses things on the
/// author's own machine, where they can see it. A `.calp` is by construction sent
/// to somebody else, so a silent drop is discovered — if ever — by a subscriber
/// who has no way to tell whether the report is incomplete or simply says that.
/// Transparency is one of the three requirements every feature is held to, and a
/// fidelity report that omits a category is not transparent, it is confident.
///
/// The field names come out of `core/persistence/src/lib.rs` at TEST TIME
/// (`the_publish_report_covers_every_workbook_field`), so a new `Workbook` field
/// cannot be added without deciding whether an application carries it.
///
/// `CARRIED` = the publish writes it into the application. `EXCLUDED` = dropped, and
/// `compute_publish_report` tells the author. `SILENT` = dropped without a line,
/// WITH the reason it does not need one.
#[cfg(test)]
pub(crate) const CALP_PUBLISH_COVERAGE: &[(&str, &str)] = &[
    ("sheets", "CARRIED: sheets/{id}/{data,styles,cell_styles,layout,metadata}.json"),
    ("tables", "CARRIED: tables/{id}.json, filtered to published sheets"),
    ("slicers", "CARRIED: slicers.json, filtered to published sheets"),
    (
        "timeline_slicers",
        "CARRIED: timeline_slicers.json. The timeline's EFFECT already travels as the 
         pivot's hidden_items/slicer_filters, so excluding the control while carrying 
         its filter would hand a subscriber a pivot pinned to the publisher's last 
         date range with no way to change it.",
    ),
    ("theme", "CARRIED: theme.json (applied only while the subscriber's theme is still default)"),
    ("scripts", "CARRIED: modules/{id}.json — inert until the subscriber runs them"),
    ("notebooks", "CARRIED: notebooks/{id}.json — execution output stripped"),
    ("charts", "CARRIED: charts.json, sheet ids remapped on pull"),
    ("sparklines", "CARRIED: sparklines.json, sheet ids remapped on pull"),
    ("floating_ranges", "EXCLUDED: 'floatingRanges' — the OBJECT rows do not distribute yet (v1 scope cut); the backing cell-store sheets DO travel (resolve_publish_sheet_indices auto-includes them with their host), so subscriber formulas referencing Float1!A1 stay live and the loss is the floating object's chrome, which compute_publish_report says"),
    ("named_ranges", "CARRIED: in the signed version manifest"),
    ("ribbon_filters", "CARRIED: ribbon_filters.json (workbook-scoped)"),
    ("pane_controls", "CARRIED: pane_controls.json (workbook-scoped)"),
    ("pivot_layouts", "CARRIED: pivot_layouts.json (workbook-scoped)"),
    ("pivot_definitions", "CARRIED: pivot_definitions/{id}.json; output cells are excluded and recomputed by the subscriber"),
    ("bi_pivot_metadata", "CARRIED: pivot_definitions/bi_metadata.json"),
    ("object_scripts", "CARRIED: object_scripts/{id}.json, consent-gated on the subscriber"),
    ("media", "CARRIED: media/{sha256} artifacts, only what published sheets reference"),
    ("extension_data", "CARRIED: extension_data.json, merged additively on pull"),
    ("conditional_formats", "CARRIED: conditional_formats.json, filtered to published sheets"),
    ("data_validations", "CARRIED: data_validations.json, filtered to published sheets"),
    ("controls", "CARRIED: controls.json, filtered to published sheets and sanitized"),
    ("cell_types", "CARRIED: as custom_objects of kind 'cellType'"),
    ("cell_behaviors", "CARRIED: cell_behaviors.json, filtered to published sheets"),
    ("scenarios", "CARRIED: scenarios.json, filtered to published sheets"),
    ("outlines", "CARRIED: outlines.json, filtered to published sheets"),
    ("comments", "CARRIED when the publisher opts in (include_comments); otherwise EXCLUDED and reported as 'comments'"),
    ("user_files", "EXCLUDED: reported 'workbookFiles' — subscriber-local by policy"),
    ("properties", "EXCLUDED: reported 'documentProperties'"),
    ("sheet_protections", "EXCLUDED: reported 'protection'"),
    ("workbook_protection", "EXCLUDED: reported 'workbookProtection'"),
    ("default_row_height", "EXCLUDED: reported 'gridDefaults'"),
    ("default_column_width", "EXCLUDED: reported 'gridDefaults'"),
    ("bi_connection_roles", "EXCLUDED: reported 'biRoleSelections'"),
    (
        "bi_connections",
        "SILENT: a package embeds each data source as its OWN model under \
         models/{id}/, and the subscriber's connection is built from that. The \
         publisher's local connection record is machine-specific (file paths, \
         bindings) and would be wrong on any other machine, so there is nothing \
         a subscriber loses by not receiving it.",
    ),
    (
        "bi_connection_caches",
        "SILENT: the offline data a subscriber needs travels as the package's \
         own model plus its calculated-table Arrow snapshots. The author's local \
         cache directory is a rebuildable mirror of the same query results, keyed \
         by connection ids that do not exist on the subscriber's machine.",
    ),
    (
        "active_sheet",
        "SILENT: which tab was selected is a view preference, and a package's \
         sheets are APPENDED to the subscriber's workbook — there is no sense in \
         which the publisher's tab index names a sheet on the other side.",
    ),
    (
        "pending_recalc",
        "SILENT: publish REFUSES outright when this is non-empty \
         (calp_publish's first gate), so a package can never carry one. Shipping \
         half-calculated cells would send a subscriber numbers that look \
         authoritative and are stale, with no indicator anywhere.",
    ),
    (
        "format_version",
        "SILENT: the INBOUND .cala stamp of the file this workbook was read \
         from. A package carries its own version identity (min_app_version in \
         the signed manifest) and this number has no meaning inside one.",
    ),
];
