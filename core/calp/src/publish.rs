//! FILENAME: core/calp/src/publish.rs
//! PURPOSE: Publish a workbook's selected sheets as a .calp application version.
//! CONTEXT: The author selects sheets to publish, specifies a version, and
//! the content is written to the workspace as an immutable version directory.

use std::path::Path;

use identity::{EntityId, SheetId};
use persistence::{SavedCell, SavedTable, SavedObjectScript, SavedScript, SavedNotebook, SavedChart, SavedSparkline, Workbook};

use crate::error::CalpError;
use crate::manifest::*;
use crate::signing::PublisherKeypair;
use crate::transport::WorkspaceTransport;
use crate::version::SemVer;

/// A data source to embed in the published application.
pub struct PublishDataSource {
    pub id: String,
    pub name: String,
    pub connection_type: String,
    pub server: String,
    pub database: String,
    /// The BI DataModel as JSON (will be written to models/{id}/model.json).
    pub model_json: serde_json::Value,
    pub bindings: Vec<TableBinding>,
    /// Materialized calculated-table snapshots (Arrow IPC stream bytes),
    /// written to models/{id}/calculated_tables/{index}.arrow so subscribers
    /// without source access still see the derived tables' data.
    pub calculated_table_snapshots: Vec<CalculatedTableSnapshot>,
    /// The publisher's collected writeback-column history (opaque JSON,
    /// host-defined entry shape), written to
    /// models/{id}/writeback_history.json when present — so a model's
    /// writeback columns don't arrive empty at subscribers (history-preserving
    /// distribution baseline).
    pub writeback_history_json: Option<serde_json::Value>,
}

/// One materialized calculated table's data snapshot to embed.
pub struct CalculatedTableSnapshot {
    /// The derived model table's name.
    pub table: String,
    /// The table's data as Arrow IPC stream bytes.
    pub ipc_bytes: Vec<u8>,
}

/// A rectangular region of cells to exclude from published sheet data.
/// Used to strip pivot output cells (which are recalculated by subscribers).
pub struct ExcludedRegion {
    /// The sheet ID this exclusion applies to.
    pub sheet_id: identity::SheetId,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// What a publish is: the creation of a NEW application, or a push of the next
/// version of one that already exists.
///
/// There is deliberately no `Default` and no `Option` wrapper (the same reason
/// [`crate::integrity::PinPolicy`] has none): a caller that has not thought
/// about which of the two this is does not compile. That single property is
/// what makes it impossible to create an application by mis-typing the name of an
/// existing one, and it doubles as the optimistic-concurrency token — an
/// `Update` names the version the author actually worked from, and the gate
/// refuses if the workspace has moved on since.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushMode {
    /// First publish under this name. Refused if the application already exists.
    CreateNew,
    /// Next version of an existing application. Refused unless the workspace's head
    /// version is still `expected_base`.
    Update { expected_base: SemVer },
}

/// The workspace's head version for an application: the HIGHEST published version,
/// which is what a `latest` pin resolves to and therefore what a checkout hands
/// the author.
///
/// Deliberately not `ApplicationManifest::latest_version()`, which returns the LAST
/// list entry. The two agree for every application published through the push gates
/// (the monotonic-version gate keeps them agreeing), but they can disagree in an
/// application written before those gates existed — and when they disagree, the one
/// the author is actually looking at is the one `latest` resolves to.
pub fn head_version(manifest: &ApplicationManifest) -> Option<SemVer> {
    manifest.parsed_versions().into_iter().max()
}

/// The keys allowed to publish the next version of `package`.
///
/// Two sources, in order:
///
/// 1. **The application's co-publisher list**, if it has one — a `publishers.json`
///    at the application root, signed by the ROOT key (whoever published version 1,
///    an anchor nothing can move because version 1 is immutable). Its entries
///    are delegates the owner deliberately added.
/// 2. **Otherwise the head version's signer**, so an application with no list stays
///    with the identity that has been publishing it.
///
/// A list that exists but cannot be verified is an ERROR, never a fallback to
/// (2): "no delegates" and "delegates I could not read" must not behave the
/// same, or deleting the list becomes a way to remove people from it.
///
/// An empty result means "no continuity to enforce" — an application whose head
/// version predates signing, or one with no versions at all.
pub fn resolve_authorized_keys(
    registry: &dyn WorkspaceTransport,
    package: &str,
    head: &SemVer,
) -> Result<Vec<String>, CalpError> {
    if let Some(root_key) = crate::publishers::root_key_of(registry, package)? {
        if let Some(list) = crate::publishers::load_verified(registry, package, &root_key)? {
            return Ok(list.allowed_keys());
        }
    }
    let head_manifest = registry.get_version_manifest(package, &head.to_string())?;
    if head_manifest.publisher_key.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![head_manifest.publisher_key])
}

/// TEST ONLY: derive the push mode from what the workspace already holds —
/// `CreateNew` for an application's first version, `Update` against its current head
/// otherwise.
///
/// Deliberately `#[cfg(test)]` and crate-private. A production caller must take
/// the base version from the WORKING COPY's workspace link, which is the whole
/// point of the base-version gate: asking the workspace what the head is and
/// then declaring that as your base makes the gate a tautology and reinstates
/// the lost-update it exists to prevent.
#[cfg(test)]
pub(crate) fn test_mode_for(registry: &dyn WorkspaceTransport, package: &str) -> PushMode {
    match registry
        .get_application_manifest(package)
        .ok()
        .and_then(|m| head_version(&m))
    {
        Some(head) => PushMode::Update { expected_base: head },
        None => PushMode::CreateNew,
    }
}

/// Request to publish selected sheets from a workbook.
pub struct PublishRequest<'a> {
    pub workbook: &'a Workbook,
    pub package_name: String,
    pub version: SemVer,
    pub kind: String,
    /// Whether this creates the application or pushes the next version of it.
    /// See [`PushMode`] — this is the gate that makes accidental application
    /// creation and lost-update overwrites structurally impossible.
    pub mode: PushMode,
    /// What changed in this version, in the author's own words. Required (non
    /// -blank) for [`PushMode::Update`]; optional when creating an application.
    /// Lands in the SIGNED version manifest, so history cannot be rewritten by
    /// editing a file on the share.
    pub change_summary: String,
    /// Which sheets to publish (by index into workbook.sheets).
    pub sheet_indices: Vec<usize>,
    pub now: String,
    pub published_by: String,
    /// Writeback region declarations to include in the manifest.
    pub writeback_regions: Option<Vec<crate::writeback::WritebackRegionDeclaration>>,
    /// Model writeback COLUMN declarations to include in the manifest (engine
    /// v21 writeback columns, distributed). Governance for model-keyed
    /// submissions — see [`crate::writeback::ModelWritebackDeclaration`].
    pub model_writebacks: Option<Vec<crate::writeback::ModelWritebackDeclaration>>,
    /// Object scripts to include in the application.
    /// If None, all workbook object scripts are published.
    pub object_scripts: Option<Vec<SavedObjectScript>>,
    /// Standalone module scripts to include in the application (C8).
    /// If None, all workbook module scripts (`workbook.scripts`) are published;
    /// Some means exactly these. Distributed inert — never auto-executed.
    pub module_scripts: Option<Vec<SavedScript>>,
    /// Standalone notebooks to include in the application (C8).
    /// If None, all workbook notebooks (`workbook.notebooks`) are published;
    /// Some means exactly these. Execution metadata is stripped at write time.
    pub notebooks: Option<Vec<SavedNotebook>>,
    /// Data source definitions to embed in the application for live data.
    pub data_sources: Vec<PublishDataSource>,
    /// Cell regions to exclude from published sheet data (e.g., pivot output).
    /// These regions are recalculated by subscribers from the source definition.
    pub excluded_regions: Vec<ExcludedRegion>,
    /// Generic custom objects to carry in the application (distribution brick 4) —
    /// the open channel for object families beyond the built-in set. Each is
    /// written as an opaque-JSON artifact under `custom_objects/{kind}/{id}.json`
    /// and listed in the manifest. Built-in producers (cell types) and
    /// third-party providers both feed this.
    pub custom_objects: Vec<PublishCustomObject>,
    /// Whether to carry threaded comments (Wave B). PRIVACY POLICY: comments
    /// are internal discussion, so they ship ONLY when the author explicitly
    /// opts in — false means comments.json is never written, even when the
    /// workbook carrier holds comments on published sheets. Scenarios and
    /// outlines have no such gate (they are workbook content, not discussion).
    pub include_comments: bool,
    /// Minimum app version written into the version manifest VERBATIM (empty =
    /// no gate). The pull-time compatibility gate
    /// (`compat::check_min_app_version`) refuses the application on older apps
    /// with an honest "update the app" error. Hosts stamp their own version
    /// here when the application carries artifacts an older app would silently
    /// drop — see [`carries_wave_content`].
    pub min_app_version: String,
}

/// A custom object to publish (distribution brick 4). `payload` is opaque
/// app-owned JSON the publisher's producer supplies; the .calp layer only
/// stores + checksums it and records the manifest entry.
pub struct PublishCustomObject {
    pub kind: String,
    pub id: String,
    pub name: String,
    /// For per-sheet objects: the application sheet id (remapped on pull). None =
    /// workbook-scoped.
    pub sheet_id: Option<SheetId>,
    pub payload: serde_json::Value,
}

/// Result of a publish operation.
#[derive(Debug)]
pub struct PublishResult {
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
    /// Charts on the published sheets.
    pub charts_published: usize,
    /// Sparkline sheet-entries on the published sheets.
    pub sparklines_published: usize,
    /// Pivot definitions carried by the application.
    pub pivots_published: usize,
    /// Sheets that carried conditional-formatting rules.
    pub conditional_format_sheets: usize,
    /// Sheets that carried data-validation ranges.
    pub data_validation_sheets: usize,
    /// Sheets that carried cell-anchored controls (buttons/checkboxes).
    pub control_sheets_published: usize,
    /// Sheets that carried threaded comments (Wave B). Always 0 unless the
    /// publish request opted in via `include_comments`.
    pub comment_sheets_published: usize,
    /// Sheets that carried what-if scenarios (Wave B).
    pub scenario_sheets_published: usize,
    /// Sheets that carried row/column outline groups (Wave B).
    pub outline_sheets_published: usize,
    /// Cell-behavior bindings on the published sheets (granular bricks phase 2).
    pub cell_behaviors_published: usize,
    /// Pane controls (Controls pane) carried by the application (workbook-scoped).
    pub pane_controls_published: usize,
    /// Slicers on the published sheets (Wave A).
    pub slicers_published: usize,
    /// Timeline slicers on the published sheets whose pivot the application
    /// also carries (`timeline_slicers.json`).
    pub timeline_slicers_published: usize,
    /// Floating ranges whose host AND backing sheet are both published
    /// (`floating_ranges.json`).
    pub floating_ranges_published: usize,
    /// Ribbon filters carried by the application (workbook-scoped, Wave A).
    pub ribbon_filters_published: usize,
    /// Saved pivot layouts carried by the application (workbook-scoped, Wave A).
    pub pivot_layouts_published: usize,
    /// Extension-data keys carried by the application (workbook-scoped, Wave A).
    pub extension_data_published: usize,
    /// Embedded BI data-source models.
    pub data_sources_published: usize,
    /// Writeback region declarations in the manifest.
    pub writeback_regions_published: usize,
    /// Publish-time disclosure warnings (fidelity-matrix approach): conditions
    /// that do NOT change the artifact but will degrade for subscribers —
    /// e.g. a dropdown pane control whose CellRange item source references a
    /// sheet outside the published selection (the pulled dropdown dangles).
    pub warnings: Vec<String>,
}

/// The sheet-name prefix of an A1-style range reference:
/// `"Data!A1:A10"` -> `Some("Data")`, `"'My Sheet'!A1"` -> `Some("My Sheet")`
/// (quoted names unescape the doubled-quote convention), `"A1:A10"` -> `None`
/// (no prefix — the reference is active-sheet-relative).
///
/// Shared with `chart_refs`, so a chart's A1 string source and a dropdown's
/// cell range are split by ONE parser.
pub(crate) fn reference_sheet_name(reference: &str) -> Option<String> {
    let reference = reference.trim();
    if let Some(rest) = reference.strip_prefix('\'') {
        // Quoted sheet name: scan to the closing quote ('' escapes a quote),
        // which must be immediately followed by '!'.
        let mut name = String::new();
        let mut chars = rest.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\'' {
                name.push(c);
            } else if chars.peek() == Some(&'\'') {
                chars.next();
                name.push('\'');
            } else {
                return match chars.next() {
                    Some('!') => Some(name),
                    _ => None, // malformed quote-then-no-'!' — treat as prefix-less
                };
            }
        }
        None // unterminated quote — treat as prefix-less
    } else {
        reference.find('!').map(|i| reference[..i].to_string())
    }
}

/// Disclosure-only dropdown-reference check (fidelity-matrix approach): a
/// dropdown pane control whose items come from a CellRange ships its
/// reference VERBATIM — the artifact is never rewritten. When the referenced
/// sheet is not in the published selection the pulled dropdown dangles (no
/// items) on the subscriber, and a prefix-less reference resolves against
/// whichever sheet is active there. Both surface as warnings so the author
/// learns at publish time instead of the subscriber at pull time.
///
/// Factored out of `publish` so callers (e.g. the app's publish PREVIEW) can
/// compute the SAME warnings without writing any artifact. Controls are
/// visited in the published artifact's (order, id) ordering, so warning order
/// matches a real publish. Out-of-range sheet indices are ignored here
/// (`publish` validates them separately; the preview path is tolerant).
pub fn dropdown_reference_warnings(workbook: &Workbook, sheet_indices: &[usize]) -> Vec<String> {
    let published_sheet_names: std::collections::HashSet<&str> = sheet_indices
        .iter()
        .filter_map(|&idx| workbook.sheets.get(idx).map(|s| s.name.as_str()))
        .collect();
    let mut controls: Vec<&persistence::SavedPaneControl> =
        workbook.pane_controls.iter().collect();
    controls.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

    let mut warnings: Vec<String> = Vec::new();
    for control in controls {
        if control.control_type != "dropdown" {
            continue;
        }
        // Config is an opaque app-owned payload here; probe only the
        // documented dropdown CellRange shape and stay silent otherwise.
        let source = control.config.get("source");
        let is_cell_range =
            source.and_then(|s| s.get("type")).and_then(|t| t.as_str()) == Some("cellRange");
        if !is_cell_range {
            continue;
        }
        let Some(reference) = source
            .and_then(|s| s.get("reference"))
            .and_then(|r| r.as_str())
        else {
            continue;
        };
        match reference_sheet_name(reference) {
            Some(sheet_name) if published_sheet_names.contains(sheet_name.as_str()) => {}
            Some(sheet_name) => warnings.push(format!(
                "Dropdown pane control \"{}\" reads its items from \"{}\", but sheet \"{}\" is not in the published selection — the dropdown will arrive with no items.",
                control.name, reference, sheet_name
            )),
            None => warnings.push(format!(
                "Dropdown pane control \"{}\" reads its items from \"{}\" without a sheet prefix — on the subscriber it resolves against whichever sheet is active and may not find the intended data.",
                control.name, reference
            )),
        }
    }
    warnings
}

/// The sheet ids a publish of `sheet_indices` carries. Out-of-range indices are
/// ignored (the preview path is tolerant; `publish` validates separately).
fn published_sheet_id_set(
    workbook: &Workbook,
    sheet_indices: &[usize],
) -> std::collections::HashSet<SheetId> {
    sheet_indices
        .iter()
        .filter_map(|&idx| workbook.sheets.get(idx).map(|s| s.id))
        .collect()
}

/// The workbook sheet with this stable id.
fn sheet_by_id(workbook: &Workbook, id: SheetId) -> Option<&persistence::Sheet> {
    workbook.sheets.iter().find(|s| s.id == id)
}

/// The workbook sheet with this name, case-insensitively (the lexer uppercases
/// bare identifiers, so `Data` and `data` are one sheet to a formula).
fn sheet_by_name<'a>(workbook: &'a Workbook, name: &str) -> Option<&'a persistence::Sheet> {
    workbook
        .sheets
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case(name))
}

/// A chart's name for a warning: the ChartDefinition envelope's `name`, else
/// its id.
fn chart_display_name(chart: &SavedChart) -> String {
    serde_json::from_str::<serde_json::Value>(&chart.spec_json)
        .ok()
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| chart.id.to_string())
}

/// The named range a prefix-less chart source names, preferring one scoped to
/// the chart's own sheet, then a workbook-scoped one, then any.
fn chart_named_range<'a>(
    workbook: &'a Workbook,
    name: &str,
    host: SheetId,
) -> Option<&'a persistence::SavedNamedRange> {
    let matching: Vec<&'a persistence::SavedNamedRange> = workbook
        .named_ranges
        .iter()
        .filter(|nr| nr.name.eq_ignore_ascii_case(name))
        .collect();
    matching
        .iter()
        .find(|nr| nr.sheet_id == Some(host))
        .or_else(|| matching.iter().find(|nr| nr.sheet_id.is_none()))
        .or_else(|| matching.first())
        .copied()
}

/// Disclosure-only chart-source check, the chart twin of
/// [`dropdown_reference_warnings`]. A chart on a published sheet ships its spec
/// with its data sources as they are; when a source names a sheet OUTSIDE the
/// published selection, the subscriber's chart has nothing to read. Each such
/// source warns once per chart, naming the chart, the sheet it sits on and the
/// source sheet:
///
/// - a DataRangeRef by stable id or by index, and a sheet-qualified A1 string by
///   name, resolve against this workbook's sheets;
/// - a prefix-less string that names a named range follows that name to its
///   sheet;
/// - any other prefix-less string warns that it resolves against whichever
///   sheet is active on the subscriber.
///
/// A source naming a sheet this workbook does not have at all by stable id is
/// already broken for the author and is not repeated here. A source that names
/// NO sheet by position (an index-only ref past the last sheet, or one stamped
/// with [`crate::chart_refs::UNRESOLVABLE_SHEET_ID`] because of that) IS
/// reported: it is the one shape a subscriber could otherwise bind to a sheet
/// of its own.
///
/// A PIVOT source warns when the pivot is not among the carrier's
/// `pivot_definitions` -- which, on the pruned publish carrier, is exactly a
/// pivot that will not travel.
///
/// Computes from the carrier alone, so the app's publish PREVIEW derives the
/// same warnings without writing anything.
pub fn chart_source_warnings(workbook: &Workbook, sheet_indices: &[usize]) -> Vec<String> {
    chart_source_warnings_with(workbook, sheet_indices, &[])
}

/// A pivot table a publish leaves behind because a sheet it needs -- its
/// destination, or the grid sheet it reads -- is not in the selection.
///
/// The host prunes such pivots from the carrier BEFORE core sees it, so core
/// cannot tell "left behind" from "never existed". The host hands this list
/// back in so the warnings can name the sheet that kept the pivot home instead
/// of guessing at a reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnpublishedPivot {
    pub id: EntityId,
    /// The pivot's display name (its `name`, else its id).
    pub name: String,
    /// The sheet that is not in the selection (the destination sheet when that
    /// is missing, otherwise the grid source sheet), by its tab name.
    pub missing_sheet: String,
}

/// [`chart_source_warnings`], naming the missing sheet of every pivot in
/// `unpublished` that a published chart reads. With an empty list the two are
/// identical.
pub fn chart_source_warnings_with(
    workbook: &Workbook,
    sheet_indices: &[usize],
    unpublished: &[UnpublishedPivot],
) -> Vec<String> {
    use crate::chart_refs::{chart_spec_sources, ChartSource, ChartSourceSheet, UNRESOLVABLE_SHEET_ID};

    let published = published_sheet_id_set(workbook, sheet_indices);
    let mut warnings: Vec<String> = Vec::new();
    for chart in workbook.charts.iter().filter(|c| published.contains(&c.sheet_id)) {
        let chart_name = chart_display_name(chart);
        let host_name = sheet_by_id(workbook, chart.sheet_id)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        let mut reported: Vec<SheetId> = Vec::new();
        let mut reported_pivots: Vec<String> = Vec::new();
        let mut reported_no_sheet = false;
        let no_sheet_warning = || {
            format!(
                "Chart \"{}\" on sheet \"{}\" reads a data range by sheet POSITION, and no sheet of this workbook is at that position — the chart's source names no sheet and will arrive broken. Choose a new data range for it (Select Data) before publishing.",
                chart_name, host_name
            )
        };
        for source in chart_spec_sources(&chart.spec_json) {
            // (the sheet the source reads, how the source names it)
            let (target, how) = match &source {
                ChartSource::Sheet(ChartSourceSheet::Id(id)) if *id == UNRESOLVABLE_SHEET_ID => {
                    if !reported_no_sheet {
                        reported_no_sheet = true;
                        warnings.push(no_sheet_warning());
                    }
                    continue;
                }
                ChartSource::Sheet(ChartSourceSheet::Id(id)) => {
                    (sheet_by_id(workbook, *id), String::new())
                }
                ChartSource::Sheet(ChartSourceSheet::Index(i)) => match workbook.sheets.get(*i) {
                    Some(sheet) => (Some(sheet), String::new()),
                    None => {
                        if !reported_no_sheet {
                            reported_no_sheet = true;
                            warnings.push(no_sheet_warning());
                        }
                        continue;
                    }
                },
                ChartSource::Pivot(raw) => {
                    let id = EntityId::parse(raw);
                    let carried = id.is_some_and(|id| {
                        workbook.pivot_definitions.iter().any(|p| p.id == id)
                    });
                    if carried || reported_pivots.contains(raw) {
                        continue;
                    }
                    reported_pivots.push(raw.clone());
                    match id.and_then(|id| unpublished.iter().find(|u| u.id == id)) {
                        Some(left) => warnings.push(format!(
                            "Chart \"{}\" on sheet \"{}\" reads pivot table \"{}\", which is not in this application because sheet \"{}\" is not in the published selection — the chart will arrive with no data. Publish \"{}\" too.",
                            chart_name, host_name, left.name, left.missing_sheet, left.missing_sheet
                        )),
                        None => warnings.push(format!(
                            "Chart \"{}\" on sheet \"{}\" reads a pivot table ({}) that is not in this application — the chart will arrive with no data. Publish the pivot table's sheet and the sheet it reads too.",
                            chart_name, host_name, raw
                        )),
                    }
                    continue;
                }
                ChartSource::Sheet(ChartSourceSheet::Name(name)) => (
                    sheet_by_name(workbook, name),
                    " by name".to_string(),
                ),
                ChartSource::Unqualified(text) => {
                    match chart_named_range(workbook, text, chart.sheet_id) {
                        Some(nr) => {
                            let refers = nr.refers_to.trim().trim_start_matches('=');
                            let target = match reference_sheet_name(refers) {
                                Some(sheet_name) if !sheet_name.is_empty() => {
                                    sheet_by_name(workbook, &sheet_name)
                                }
                                _ => nr.sheet_id.and_then(|id| sheet_by_id(workbook, id)),
                            };
                            (target, format!(" through the named range \"{}\"", nr.name))
                        }
                        None => {
                            warnings.push(format!(
                                "Chart \"{}\" on sheet \"{}\" reads its data from \"{}\" without a sheet prefix — on the subscriber it resolves against whichever sheet is active and may not find the intended data.",
                                chart_name, host_name, text
                            ));
                            continue;
                        }
                    }
                }
            };
            let Some(target) = target else { continue };
            if published.contains(&target.id) || reported.contains(&target.id) {
                continue;
            }
            reported.push(target.id);
            warnings.push(format!(
                "Chart \"{}\" on sheet \"{}\" reads its data{} from sheet \"{}\", which is not in the published selection — the chart will arrive showing that its source sheet no longer exists. Publish \"{}\" too, or point the chart at a published sheet.",
                chart_name, host_name, how, target.name, target.name
            ));
        }
    }
    warnings
}

/// The sheet a pivot definition materializes on: its `destination_sheet`, by
/// name (the same case-insensitive lookup the pull-side materializer uses, which
/// SKIPS a pivot whose destination sheet did not arrive).
fn pivot_destination_sheet<'a>(
    workbook: &'a Workbook,
    pivot: &persistence::SavedPivotDefinition,
) -> Option<&'a persistence::Sheet> {
    let name = pivot
        .definition
        .get("destination_sheet")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?;
    sheet_by_name(workbook, name)
}

/// A pivot's name for a warning: the definition's `name`, else its id.
fn pivot_display_name(pivot: &persistence::SavedPivotDefinition) -> String {
    pivot
        .definition
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| pivot.id.to_string())
}

/// Disclosure-only source check for the floating FILTER objects (slicers and
/// timeline slicers), the twin of [`chart_source_warnings`]. A slicer or
/// timeline on a published sheet travels, but the table or pivot it filters
/// travels only with ITS sheet: a table ships only from a published sheet, and a
/// pivot materializes on the subscriber only when its destination sheet arrived.
/// When that sheet is not in the published selection the object arrives drawn
/// and connected to nothing. Covers each object's own source and its report
/// connections, once per source.
///
/// A timeline whose pivot is not among the workbook's pivot definitions is not
/// published at all (`timeline_slicers.json` carries only timelines whose
/// source travels), and says so.
pub fn object_source_warnings(workbook: &Workbook, sheet_indices: &[usize]) -> Vec<String> {
    object_source_warnings_with(workbook, sheet_indices, &[])
}

/// [`object_source_warnings`] over a carrier whose pivots were PRUNED to the
/// selection: `unpublished` lists the pivots the host left behind and the sheet
/// that kept each one home.
///
/// Without it a pruned pivot is indistinguishable from one the workbook never
/// had, which silenced every slicer warning about a pivot source (the pivot was
/// not found, so the slicer was skipped) and gave the timeline a false reason
/// ("a pivot table this workbook no longer has" -- it has it; its sheet was
/// just not ticked). A pivot in `unpublished` is reported by name with its
/// missing sheet; one in neither list is treated as before. With an empty list
/// the two functions are identical.
pub fn object_source_warnings_with(
    workbook: &Workbook,
    sheet_indices: &[usize],
    unpublished: &[UnpublishedPivot],
) -> Vec<String> {
    let published = published_sheet_id_set(workbook, sheet_indices);
    let host_name = |id: SheetId| {
        sheet_by_id(workbook, id)
            .map(|s| s.name.clone())
            .unwrap_or_default()
    };
    let pivot_by_id = |id: EntityId| workbook.pivot_definitions.iter().find(|p| p.id == id);
    let left_behind = |id: EntityId| unpublished.iter().find(|u| u.id == id);
    let mut warnings: Vec<String> = Vec::new();

    // Slicers, in the artifact's (id) order.
    let mut slicers: Vec<&persistence::SavedSlicer> = workbook
        .slicers
        .iter()
        .filter(|s| published.contains(&s.sheet_id))
        .collect();
    slicers.sort_by(|a, b| a.id.cmp(&b.id));
    for slicer in slicers {
        let mut sources: Vec<(&persistence::SavedSlicerSourceType, EntityId)> =
            vec![(&slicer.source_type, slicer.cache_source_id)];
        for connection in &slicer.connected_sources {
            if !sources.iter().any(|(_, id)| *id == connection.source_id) {
                sources.push((&connection.source_type, connection.source_id));
            }
        }
        for (source_type, source_id) in sources {
            let (what, target) = match source_type {
                persistence::SavedSlicerSourceType::Table => {
                    match workbook.tables.iter().find(|t| t.id == source_id) {
                        Some(table) => (
                            format!("table \"{}\"", table.name),
                            sheet_by_id(workbook, table.sheet_id),
                        ),
                        None => continue,
                    }
                }
                persistence::SavedSlicerSourceType::Pivot => match pivot_by_id(source_id) {
                    Some(pivot) => (
                        format!("pivot table \"{}\"", pivot_display_name(pivot)),
                        pivot_destination_sheet(workbook, pivot),
                    ),
                    None => {
                        if let Some(left) = left_behind(source_id) {
                            warnings.push(format!(
                                "Slicer \"{}\" on sheet \"{}\" filters pivot table \"{}\", which is not in this application because sheet \"{}\" is not in the published selection — the slicer will arrive connected to nothing. Publish \"{}\" too.",
                                slicer.name,
                                host_name(slicer.sheet_id),
                                left.name,
                                left.missing_sheet,
                                left.missing_sheet
                            ));
                        }
                        continue;
                    }
                },
                // A BI slicer reads the application's embedded model, not a sheet.
                persistence::SavedSlicerSourceType::BiConnection => continue,
            };
            let Some(target) = target else { continue };
            if published.contains(&target.id) {
                continue;
            }
            warnings.push(format!(
                "Slicer \"{}\" on sheet \"{}\" filters {} on sheet \"{}\", which is not in the published selection — the slicer will arrive connected to nothing. Publish \"{}\" too.",
                slicer.name,
                host_name(slicer.sheet_id),
                what,
                target.name,
                target.name
            ));
        }
    }

    // Timeline slicers, in the artifact's (id) order.
    let mut timelines: Vec<&persistence::SavedTimelineSlicer> = workbook
        .timeline_slicers
        .iter()
        .filter(|t| published.contains(&t.sheet_id))
        .collect();
    timelines.sort_by(|a, b| a.id.cmp(&b.id));
    for timeline in timelines {
        let Some(own) = pivot_by_id(timeline.source_id) else {
            match left_behind(timeline.source_id) {
                Some(left) => warnings.push(format!(
                    "Timeline \"{}\" on sheet \"{}\" filters pivot table \"{}\", which is not in this application because sheet \"{}\" is not in the published selection, so the timeline is left out of the published application. Publish \"{}\" too.",
                    timeline.name,
                    host_name(timeline.sheet_id),
                    left.name,
                    left.missing_sheet,
                    left.missing_sheet
                )),
                None => warnings.push(format!(
                    "Timeline \"{}\" on sheet \"{}\" filters a pivot table this workbook no longer has, so the timeline is left out of the published application.",
                    timeline.name,
                    host_name(timeline.sheet_id)
                )),
            }
            continue;
        };
        let mut pivots: Vec<&persistence::SavedPivotDefinition> = vec![own];
        let mut reported_left: Vec<EntityId> = Vec::new();
        for id in &timeline.connected_pivot_ids {
            if let Some(p) = pivot_by_id(*id) {
                if !pivots.iter().any(|q| q.id == p.id) {
                    pivots.push(p);
                }
            } else if let Some(left) = left_behind(*id) {
                if reported_left.contains(id) {
                    continue;
                }
                reported_left.push(*id);
                warnings.push(format!(
                    "Timeline \"{}\" on sheet \"{}\" also filters pivot table \"{}\", which is not in this application because sheet \"{}\" is not in the published selection — that connection will arrive filtering nothing. Publish \"{}\" too.",
                    timeline.name,
                    host_name(timeline.sheet_id),
                    left.name,
                    left.missing_sheet,
                    left.missing_sheet
                ));
            }
        }
        for pivot in pivots {
            let Some(target) = pivot_destination_sheet(workbook, pivot) else { continue };
            if published.contains(&target.id) {
                continue;
            }
            warnings.push(format!(
                "Timeline \"{}\" on sheet \"{}\" filters pivot table \"{}\" on sheet \"{}\", which is not in the published selection — the timeline will arrive connected to nothing. Publish \"{}\" too.",
                timeline.name,
                host_name(timeline.sheet_id),
                pivot_display_name(pivot),
                target.name,
                target.name
            ));
        }
    }
    warnings
}

/// Bijective base-26 A1 column+row label from 0-based `col`/`row`
/// (`(0,0) -> "A1"`, `(26,0) -> "AA1"`).
fn a1_ref(col: u64, row: u64) -> String {
    let mut n = col + 1;
    let mut letters = String::new();
    while n > 0 {
        let rem = ((n - 1) % 26) as u8;
        letters.insert(0, (b'A' + rem) as char);
        n = (n - 1) / 26;
    }
    format!("{}{}", letters, row + 1)
}

/// Publish-time reference guard for macro-LINKED buttons (loud-failure slice).
///
/// A button that links a recorded macro carries a `macroRef` control property =
/// the macro's MODULE-script id. That macro travels by default (all workbook
/// module scripts publish unless the request narrows the set). But a publisher
/// who NARROWED `module_scripts` could drop a macro a button still links —
/// shipping a dead button whose click, on the subscriber, reports the macro
/// missing. The subscriber is warned loudly at click; this warns the PUBLISHER
/// loudly at publish, so the gap is caught before it ships: for every published
/// control carrying a `macroRef` whose id is not in the published module set,
/// emit a warning naming the button (sheet + A1) and the missing macro.
///
/// `published_module_ids` is the id set the publish actually carries. Factored
/// out (like `dropdown_reference_warnings`) so the app's publish PREVIEW derives
/// the same warnings without writing an artifact. Controls on unpublished sheets
/// are ignored; warnings are emitted in (sheet-selection, row, col) order for a
/// stable read.
pub fn macro_reference_warnings(
    workbook: &Workbook,
    sheet_indices: &[usize],
    published_module_ids: &std::collections::HashSet<String>,
) -> Vec<String> {
    // Published sheet id -> display name. Built in the selection's order so the
    // warning stream reads predictably.
    let mut published: Vec<(SheetId, &str)> = Vec::new();
    for &idx in sheet_indices {
        if let Some(s) = workbook.sheets.get(idx) {
            published.push((s.id, s.name.as_str()));
        }
    }

    let mut warnings: Vec<String> = Vec::new();
    for (sheet_id, sheet_name) in &published {
        let Some(sheet_controls) = workbook
            .controls
            .iter()
            .find(|c| &c.sheet_id == sheet_id)
        else {
            continue;
        };
        let Some(entries) = sheet_controls.controls.as_array() else {
            continue;
        };
        // Gather then sort so the per-sheet order is (row, col), independent of
        // the artifact's own entry ordering.
        let mut refs: Vec<(u64, u64, String)> = Vec::new();
        for entry in entries {
            let macro_id = entry
                .get("properties")
                .and_then(|p| p.get("macroRef"))
                .and_then(|m| m.get("value"))
                .and_then(|v| v.as_str());
            let Some(macro_id) = macro_id else { continue };
            if macro_id.is_empty() || published_module_ids.contains(macro_id) {
                continue;
            }
            let row = entry.get("row").and_then(|r| r.as_u64()).unwrap_or(0);
            let col = entry.get("col").and_then(|c| c.as_u64()).unwrap_or(0);
            refs.push((row, col, macro_id.to_string()));
        }
        refs.sort();
        for (row, col, macro_id) in refs {
            warnings.push(format!(
                "Button at {}!{} links the recorded macro \"{}\", but that macro is not in the published module set — subscribers will get a dead button (clicking it reports the macro is missing). Include the macro's module script, or remove the button before publishing.",
                sheet_name,
                a1_ref(col, row),
                macro_id
            ));
        }
    }
    warnings
}

/// Whether the request carries any Wave A/B artifact the publish would
/// actually write: slicers / timeline slicers / floating ranges / opted-in
/// comments / scenarios / outlines on the published sheets, a canvas sheet,
/// ribbon filters / saved pivot layouts / extension data
/// (workbook-scoped), or a non-default document theme. Apps that predate
/// these artifacts pull such an application "successfully" while silently dropping
/// them — so the publishing host stamps `PublishRequest::min_app_version`
/// with its OWN version exactly when this returns true, letting the pull-time
/// compatibility gate refuse honestly instead. Cell-only applications return
/// false and stay pullable by older apps.
pub fn carries_wave_content(request: &PublishRequest) -> bool {
    let wb = request.workbook;
    let published_sheet_ids: Vec<SheetId> = request
        .sheet_indices
        .iter()
        .filter_map(|&idx| wb.sheets.get(idx).map(|s| s.id))
        .collect();
    wb.slicers
        .iter()
        .any(|s| published_sheet_ids.contains(&s.sheet_id))
        || !wb.ribbon_filters.is_empty()
        || !wb.pivot_layouts.is_empty()
        || !wb.extension_data.is_empty()
        || (request.include_comments
            && wb
                .comments
                .iter()
                .any(|c| published_sheet_ids.contains(&c.sheet_id)))
        || wb
            .scenarios
            .iter()
            .any(|s| published_sheet_ids.contains(&s.sheet_id))
        || wb
            .outlines
            .iter()
            .any(|o| published_sheet_ids.contains(&o.sheet_id))
        // A cell-behavior binding. It fails this function's test the same way a
        // spill extent does: an older app pulls "successfully" and the typed
        // cells arrive inert, with nothing anywhere saying the behaviour was
        // dropped. Refusing the pull is the honest failure.
        || wb
            .cell_behaviors
            .iter()
            .any(|b| published_sheet_ids.contains(&b.sheet_id))
        || wb.theme != engine::theme::ThemeDefinition::default()
        // A DYNAMIC-ARRAY SPILL EXTENT on a published sheet. It fails this
        // function's test in its sharpest form: an older app pulls the application
        // "successfully", writes the spilled cells as ordinary literals, and
        // silently drops the record of which origin owns them -- so the
        // subscriber gets an array that LOOKS right, is protected by nothing,
        // and collapses to an error the first time anything re-evaluates its
        // origin (register 2ab). Refusing the pull is the honest failure.
        //
        // Cell-only applications with no array still return false here and stay
        // pullable by older apps, which is the point of the whole function.
        || request.sheet_indices.iter().any(|&idx| {
            wb.sheets
                .get(idx)
                .is_some_and(|s| s.cells.values().any(|c| c.spill.is_some()))
        })
        // A CANVAS sheet. An older app ignores the unknown `kind` in
        // metadata.json and materializes the canvas as an ordinary, editable
        // worksheet with its objects floating over an empty grid -- a document
        // that looks like something it is not, with no error anywhere.
        // Refusing the pull is the honest failure.
        || request
            .sheet_indices
            .iter()
            .any(|&idx| wb.sheets.get(idx).is_some_and(|s| s.kind.is_canvas()))
        // A FLOATING RANGE the publish WRITES. An older app ignores
        // `floating_ranges.json` and keeps the backing sheet as an orphaned
        // hidden "object" sheet: the grid the author placed on the page is
        // simply gone, with nothing anywhere saying so. Asked through the
        // writer's own predicate: a row whose backing sheet stays home is not
        // written, and stamping for it refused a cells-only application.
        || wb
            .floating_ranges
            .iter()
            .any(|fr| floating_range_travels(fr, |id| published_sheet_ids.contains(id)))
        // A TIMELINE SLICER the publish WRITES. Same failure: an older app
        // drops `timeline_slicers.json` and the report arrives with its date
        // filter missing and the pivot it drove showing every period. A
        // timeline whose pivot does not travel is not written, so it does not
        // stamp either.
        || wb
            .timeline_slicers
            .iter()
            .any(|t| timeline_slicer_travels(t, wb, |id| published_sheet_ids.contains(id)))
}

/// Whether a floating range travels with a publish: its host AND its backing
/// sheet are both published -- without the host it has nowhere to draw, without
/// the backing sheet nothing to show.
///
/// ONE rule for every place that asks: the `floating_ranges.json` writer, the
/// minimum-app-version stamp ([`carries_wave_content`]) and the host's
/// transparency report. They were three copies, and the stamp's copy checked
/// only the host, so it declared a minimum version for a row the writer
/// dropped.
pub fn floating_range_travels(
    fr: &persistence::SavedFloatingRange,
    is_published: impl Fn(&SheetId) -> bool,
) -> bool {
    is_published(&fr.host_sheet_id) && is_published(&fr.backing_sheet_id)
}

/// Whether a timeline slicer travels with a publish: it sits on a published
/// sheet AND the pivot it filters is in the carrier (`workbook.pivot_definitions`,
/// already pruned to the selection by the host). A timeline bound to a pivot the
/// application does not carry would arrive drawn and filtering nothing, so it
/// stays home and [`object_source_warnings`] says so.
///
/// Shared by the `timeline_slicers.json` writer, [`carries_wave_content`] and
/// the host's transparency report, for the reason [`floating_range_travels`]
/// gives.
pub fn timeline_slicer_travels(
    timeline: &persistence::SavedTimelineSlicer,
    workbook: &Workbook,
    is_published: impl Fn(&SheetId) -> bool,
) -> bool {
    is_published(&timeline.sheet_id)
        && workbook
            .pivot_definitions
            .iter()
            .any(|p| p.id == timeline.source_id)
}

/// Publish selected sheets from a workbook to a local workspace.
///
/// `profile_dir` is the per-user profile directory holding the publisher's
/// Ed25519 keypair (`publisher-key.json`, created on first publish). The
/// version manifest carries the publisher's public key, and its raw on-disk
/// bytes are signed into a detached `version-manifest.sig` (S5 phase 2).
pub fn publish(
    registry: &dyn WorkspaceTransport,
    request: &PublishRequest,
    profile_dir: &Path,
) -> Result<PublishResult, CalpError> {
    let version_str = request.version.to_string();

    // Load (or create on first publish) the publisher's signing identity.
    // Generated with the OS CSPRNG inside PublisherKeypair::load_or_create.
    let keypair = PublisherKeypair::load_or_create(profile_dir)?;

    for &idx in &request.sheet_indices {
        if idx >= request.workbook.sheets.len() {
            return Err(CalpError::SheetNotFound(format!("index {}", idx)));
        }
    }

    let published_sheet_ids: Vec<_> = request.sheet_indices.iter()
        .map(|&idx| request.workbook.sheets[idx].id)
        .collect();

    // Build version manifest
    let sheets: Vec<PublishedSheet> = request.sheet_indices.iter().map(|&idx| {
        let sheet = &request.workbook.sheets[idx];
        PublishedSheet {
            sheet_id: sheet.id,
            name: sheet.name.clone(),
            description: String::new(),
            // "canvas" for a canvas; empty (and so absent from the signed
            // manifest bytes) for a worksheet.
            kind: if sheet.kind.is_canvas() {
                sheet.kind.wire_name().to_string()
            } else {
                String::new()
            },
            extra: std::collections::HashMap::new(),
        }
    }).collect();

    // NO TWO SHEETS MAY SHARE A NAME IN ONE VERSION.
    //
    // Nothing checked this. A workbook cannot hold a duplicate —
    // `ensure_sheet_name_is_free` refuses it — but a published VERSION could,
    // because `VersionManifest.sheets` is a plain `Vec` keyed by nothing, and
    // `sheet_indices` is never deduped at any layer, so even the SAME index
    // twice signed and published cleanly.
    //
    // What it costs a subscriber is not cosmetic. Cross-sheet references inside
    // a package are stored as raw TEXT and resolved by a FIRST-MATCH
    // case-insensitive name lookup, so once `resolve_sheet_name_collisions`
    // renames one of the two on pull, the package's own `=Sheet1!A1` binds to
    // whichever sheet won the name — with no `#REF!` and no warning.
    //
    // CASE-INSENSITIVE, matching every other sheet-name comparison in the
    // product: the lexer uppercases bare identifiers, so `Data` and `data` are
    // one name to a formula and must be one name here.
    //
    // Here rather than in the Tauri command so EVERY publish route is covered,
    // the scripted gateway included — it has no dialog to warn through.
    {
        let mut seen: std::collections::HashMap<String, &PublishedSheet> =
            std::collections::HashMap::new();
        for s in &sheets {
            let key = s.name.to_ascii_lowercase();
            if let Some(first) = seen.get(&key) {
                let detail = if first.sheet_id == s.sheet_id {
                    "The same sheet was named twice in the selection.".to_string()
                } else {
                    format!(
                        "One is the sheet the application already publishes under that name; \
                         the other is a sheet you are adding. Rename yours before publishing \
                         it — a subscriber resolves cross-sheet formulas by NAME, so two \
                         sheets called '{}' would silently bind each other's references.",
                        s.name
                    )
                };
                return Err(CalpError::DuplicateSheetName { name: s.name.clone(), detail });
            }
            seen.insert(key, s);
        }
    }

    let named_ranges: Vec<PublishedNamedRange> = request.workbook.named_ranges.iter()
        .filter(|nr| match nr.sheet_id {
            None => true,
            Some(sid) => published_sheet_ids.contains(&sid),
        })
        .map(|nr| PublishedNamedRange {
            name: nr.name.clone(),
            refers_to: nr.refers_to.clone(),
            sheet_id: nr.sheet_id,
            extra: std::collections::HashMap::new(),
        })
        .collect();

    let published_tables: Vec<&SavedTable> = request.workbook.tables.iter()
        .filter(|t| published_sheet_ids.contains(&t.sheet_id))
        .collect();
    let table_ids: Vec<EntityId> = published_tables.iter().map(|t| t.id).collect();

    // Collect object scripts to publish
    let scripts_to_publish: Vec<&SavedObjectScript> = match &request.object_scripts {
        Some(scripts) => scripts.iter().collect(),
        None => request.workbook.object_scripts.iter().collect(),
    };

    let published_scripts: Vec<PublishedObjectScript> = scripts_to_publish.iter().map(|s| {
        PublishedObjectScript {
            id: s.id.clone(),
            name: s.name.clone(),
            object_type: format!("{:?}", s.object_type).to_lowercase(),
            instance_id: s.instance_id.clone(),
            description: s.description.clone(),
            // R19: the publisher's declared ceiling for this script, lifted
            // from its source pragmas. This is what the application's scripts may
            // use; the subscriber's pull sets each script's ceiling from this.
            capabilities: persistence::parse_declared_capabilities(&s.source),
        }
    }).collect();

    // Collect standalone module scripts to publish (C8). Override-or-all,
    // mirroring object_scripts. These are inert, transparent data.
    let modules_to_publish: Vec<&SavedScript> = match &request.module_scripts {
        Some(scripts) => scripts.iter().collect(),
        None => request.workbook.scripts.iter().collect(),
    };

    let published_modules: Vec<PublishedModuleScript> = modules_to_publish.iter().map(|s| {
        PublishedModuleScript {
            id: s.id.clone(),
            name: s.name.clone(),
            // Discriminated so a sheet literally named "workbook" can't be
            // confused with workbook-global scope in the pre-pull review surface.
            // (The authoritative scope still round-trips via the artifact's
            // tagged ScriptScopeDef; this manifest string is display-only.)
            scope: match &s.scope {
                persistence::SavedScriptScope::Workbook => "workbook".to_string(),
                persistence::SavedScriptScope::Sheet { name } => format!("sheet:{}", name),
            },
            description: s.description.clone(),
        }
    }).collect();

    // Collect standalone notebooks to publish (C8). Override-or-all.
    let notebooks_to_publish: Vec<&SavedNotebook> = match &request.notebooks {
        Some(notebooks) => notebooks.iter().collect(),
        None => request.workbook.notebooks.iter().collect(),
    };

    let published_notebooks: Vec<PublishedNotebook> = notebooks_to_publish.iter().map(|n| {
        PublishedNotebook {
            id: n.id.clone(),
            name: n.name.clone(),
            cell_count: n.cells.len(),
            description: None,
        }
    }).collect();

    // Generic custom objects (brick 4): index-based artifact paths avoid any
    // path-injection from extension-supplied kind/id while keeping ids unique.
    let published_custom_objects: Vec<PublishedCustomObject> = request
        .custom_objects
        .iter()
        .enumerate()
        .map(|(i, co)| PublishedCustomObject {
            kind: co.kind.clone(),
            id: co.id.clone(),
            name: co.name.clone(),
            sheet_id: co.sheet_id,
            payload_path: format!("custom_objects/{i}.json"),
            extra: std::collections::HashMap::new(),
        })
        .collect();

    let mut version_manifest = VersionManifest {
        format_version: 1,
        package_name: request.package_name.clone(),
        version: version_str.clone(),
        kind: request.kind.clone(),
        published_at: request.now.clone(),
        published_by: request.published_by.clone(),
        // S5 phase 2: the asserted signer. publisher_key is what the
        // subscriber verifies against; publisher_name is display-only.
        publisher_key: keypair.public_key_hex(),
        publisher_name: keypair.display_name(),
        // The host-supplied minimum, verbatim (empty = no minimum). The app
        // stamps its own version when the application carries Wave A/B artifacts
        // an older app would silently drop (carries_wave_content); cell-only
        // applications stay pullable by older apps.
        min_app_version: request.min_app_version.clone(),
        // Push lineage, inside the signature. `base_version` is the head this
        // push was authored against; empty when the application is being created.
        base_version: match &request.mode {
            PushMode::CreateNew => String::new(),
            PushMode::Update { expected_base } => expected_base.to_string(),
        },
        change_summary: request.change_summary.trim().to_string(),
        sheets,
        named_ranges: named_ranges.clone(),
        tables: table_ids,
        locked_sheets: Vec::new(),
        locked_cells: Vec::new(),
        writeback_regions: request.writeback_regions.clone(),
        model_writebacks: request.model_writebacks.clone(),
        object_scripts: published_scripts,
        module_scripts: published_modules,
        notebooks: published_notebooks,
        data_sources: request.data_sources.iter().map(|ds| ApplicationDataSource {
            id: ds.id.clone(),
            name: ds.name.clone(),
            connection_type: ds.connection_type.clone(),
            server: ds.server.clone(),
            database: ds.database.clone(),
            model_path: format!("models/{}/model.json", ds.id),
            bindings: ds.bindings.clone(),
            calculated_table_snapshots: ds
                .calculated_table_snapshots
                .iter()
                .enumerate()
                .map(|(i, snap)| crate::manifest::CalculatedTableSnapshotRef {
                    table: snap.table.clone(),
                    path: format!("models/{}/calculated_tables/{}.arrow", ds.id, i),
                })
                .collect(),
            extra: std::collections::HashMap::new(),
        }).collect(),
        custom_objects: published_custom_objects,
        // Filled in below, after all artifacts are on disk in final form.
        artifact_checksums: std::collections::BTreeMap::new(),
        extra: std::collections::HashMap::new(),
    };

    let pkg = request.package_name.as_str();
    let ver = version_str.as_str();

    // ----------------------------------------------------------------------
    // The workspace-write phase, start to finish, under ONE lock.
    //
    // Every gate below reads a workspace fact and then acts on it, so the read
    // and the write it authorizes have to be in one critical section: a check
    // outside the lock is a TOCTOU window on a share two developers publish to.
    // The lock previously covered only the final version-list append, which
    // left both the "does this version already exist" check and the artifact
    // writes racing. Holding it across the whole phase also means two publishes
    // of the same version can never interleave artifact bytes under one signed
    // checksum map.
    //
    // Cost: publishes to DIFFERENT applications in one workspace serialize too. For
    // the share-with-a-few-developers case this design targets that is the
    // right trade, and a waiter that gives up gets `WorkspaceBusy` — an honest,
    // retryable answer rather than a corrupted half-publish.
    // ----------------------------------------------------------------------
    let _lock = registry.lock()?;

    // Gate 1 — mode. Which of the two things is this?
    let existing_manifest = registry.get_application_manifest(pkg).ok();
    match (&request.mode, &existing_manifest) {
        (PushMode::CreateNew, Some(_)) => {
            return Err(CalpError::ApplicationAlreadyExists(pkg.to_string()));
        }
        (PushMode::Update { .. }, None) => {
            return Err(CalpError::ApplicationNotFound(pkg.to_string()));
        }
        _ => {}
    }

    if let (PushMode::Update { expected_base }, Some(pkg_manifest)) =
        (&request.mode, &existing_manifest)
    {
        if let Some(head) = head_version(pkg_manifest) {
            // Gate 2 — base version. Somebody else pushed since this working
            // copy was checked out, so publishing now would produce a version
            // that silently does not contain their work.
            if head != *expected_base {
                let published_by = pkg_manifest
                    .versions
                    .iter()
                    .find(|e| e.version == head.to_string())
                    .map(|e| e.published_by.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "another publisher".to_string());
                return Err(CalpError::BaseVersionStale {
                    package: pkg.to_string(),
                    expected_base: expected_base.to_string(),
                    actual_latest: head.to_string(),
                    latest_published_by: published_by,
                });
            }

            // Gate 3 — monotonic version. Keeps "the last entry" and "the
            // highest version" the same fact, which gate 2 relies on.
            if request.version <= head {
                let mut suggested = head.clone();
                suggested.patch += 1;
                return Err(CalpError::VersionNotGreater {
                    package: pkg.to_string(),
                    version: version_str.clone(),
                    latest: head.to_string(),
                    suggested: suggested.to_string(),
                });
            }

            // Gate 4 — change summary. A version history nobody can read is
            // not a version history.
            if request.change_summary.trim().is_empty() {
                return Err(CalpError::MissingChangeSummary { package: pkg.to_string() });
            }

            // Gate 5 — publisher key continuity. Pushing with a different key
            // does not fail here today; it fails at every SUBSCRIBER's next
            // refresh, as a trust-pin change that looks exactly like an application
            // hijack. Refusing at the source is the only place the person who
            // can still do something about it is present.
            let authorized = resolve_authorized_keys(registry, pkg, &head)?;
            let mine = keypair.public_key_hex();
            if !authorized.is_empty() && !authorized.iter().any(|k| k == &mine) {
                let head_manifest = registry.get_version_manifest(pkg, &head.to_string())?;
                let holder_name = if head_manifest.publisher_name.is_empty() {
                    "another publisher".to_string()
                } else {
                    head_manifest.publisher_name.clone()
                };
                let holder_key: String =
                    head_manifest.publisher_key.chars().take(12).collect();
                return Err(CalpError::NotThePublisher {
                    package: pkg.to_string(),
                    holder_name,
                    holder_key,
                });
            }
        }
    }

    // Gate 6 — immutability. Still a distinct check from the monotonic gate: a
    // CreateNew into a half-written application directory reaches here too.
    if registry.version_exists(pkg, ver) {
        return Err(CalpError::VersionAlreadyPublished {
            package: request.package_name.clone(),
            version: version_str,
        });
    }

    // The version manifest is written LAST (it is the integrity root and the
    // publish commit point — version_exists() keys off it). If the version
    // already has artifacts without a manifest, that is debris from a crashed
    // earlier publish: clear it so stale files can't end up unlisted in the
    // checksum map. Through the transport, never the filesystem directly.
    registry.clear_version(pkg, ver)?;

    // Write generic custom-object payloads (brick 4). Opaque JSON; the .calp
    // layer stores + checksums but never interprets them.
    for (i, co) in request.custom_objects.iter().enumerate() {
        registry.write_artifact(
            pkg,
            ver,
            &format!("custom_objects/{i}.json"),
            serde_json::to_string_pretty(&co.payload)?.as_bytes(),
        )?;
    }

    // Write sheet data (cells, styles, layout as JSON)
    for &idx in &request.sheet_indices {
        let sheet = &request.workbook.sheets[idx];
        // Version-relative artifact prefix for this sheet (forward slashes — the
        // manifest checksum-key convention). sheet.id is a path-safe UUID v7.
        let sheet_prefix = format!("sheets/{}", sheet.id);

        // Filter out cells in excluded regions (e.g., pivot output areas).
        // These cells are recalculated by subscribers from the pivot definition.
        let exclusions: Vec<&ExcludedRegion> = request.excluded_regions.iter()
            .filter(|r| r.sheet_id == sheet.id)
            .collect();

        let cells = if exclusions.is_empty() {
            std::borrow::Cow::Borrowed(&sheet.cells)
        } else {
            let filtered: std::collections::HashMap<(u32, u32), SavedCell> = sheet.cells.iter()
                .filter(|(&(row, col), _)| {
                    !exclusions.iter().any(|r|
                        row >= r.start_row && row <= r.end_row &&
                        col >= r.start_col && col <= r.end_col
                    )
                })
                .map(|(&k, v)| (k, v.clone()))
                .collect();
            std::borrow::Cow::Owned(filtered)
        };

        // Cell data
        let cell_data = calcula_format::sheet_data::cells_to_sheet_data(&cells);
        registry.write_artifact(
            pkg, ver,
            &format!("{sheet_prefix}/data.json"),
            serde_json::to_string_pretty(&cell_data)?.as_bytes(),
        )?;

        // Styles registry (the sheet's Vec<CellStyle>, indexed by style_index).
        registry.write_artifact(
            pkg, ver,
            &format!("{sheet_prefix}/styles.json"),
            serde_json::to_string_pretty(&sheet.styles)?.as_bytes(),
        )?;

        // Per-cell style assignments (A1 -> style index). data.json does NOT
        // carry style_index (it is always 0 there), so without this companion
        // map the workspace above could never be re-associated with cells and
        // all per-cell formatting would be lost on the consuming side (subscriber
        // refresh, HTML export). Only written when there are non-default styles,
        // mirroring named_ranges.json. Uses the (possibly region-filtered) cells.
        let cell_styles = calcula_format::sheet_styles::cells_to_sheet_styles(&cells);
        if !cell_styles.cells.is_empty() {
            registry.write_artifact(
                pkg, ver,
                &format!("{sheet_prefix}/cell_styles.json"),
                serde_json::to_string_pretty(&cell_styles)?.as_bytes(),
            )?;
        }

        // Layout: column widths + row heights, plus the row/column default-style
        // tiers. The tiers must travel with the application — a whole-column format
        // is stored ONCE there rather than as a style on every cell, so omitting
        // them would silently drop that formatting for the subscriber while
        // per-cell styles came through fine.
        let layout = calcula_format::sheet_layout::SheetLayout::from_dimensions_and_styles(
            &sheet.column_widths,
            &sheet.row_heights,
            &sheet.row_styles,
            &sheet.column_styles,
        );
        registry.write_artifact(
            pkg, ver,
            &format!("{sheet_prefix}/layout.json"),
            serde_json::to_string_pretty(&layout)?.as_bytes(),
        )?;

        // Presentation metadata (D9): merged regions, freeze panes, hidden
        // rows/cols, tab color, visibility, notes, hyperlinks, page setup,
        // gridlines. Written before the manifest, so the integrity walk
        // checksums it and pull restores it instead of dropping it.
        let metadata = crate::manifest::PublishedSheetMetadata::from_sheet(sheet);
        registry.write_artifact(
            pkg, ver,
            &format!("{sheet_prefix}/metadata.json"),
            serde_json::to_string_pretty(&metadata)?.as_bytes(),
        )?;
    }

    // Write tables
    for table in &published_tables {
        registry.write_artifact(
            pkg, ver,
            &format!("tables/{}.json", table.id),
            serde_json::to_string_pretty(table)?.as_bytes(),
        )?;
    }

    // Write named ranges
    if !named_ranges.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "named_ranges.json",
            serde_json::to_string_pretty(&named_ranges)?.as_bytes(),
        )?;
    }

    // Write charts on the published sheets, carried so subscribers see them
    // in-app (pull remaps each chart's sheet id to the new local sheet).
    //
    // Every coordinate data source leaves STAMPED with its sheet's stable id.
    // A ref carrying only the publisher's `sheetIndex` (an MCP/script chart the
    // frontend store never re-saved) would otherwise be stamped on the
    // subscriber with whatever sheet sits at that index THERE -- and read the
    // wrong sheet in silence. Here rather than only in the host's assembly so
    // every publish route gets it; a spec with nothing to stamp keeps its bytes.
    let workbook_sheet_ids: Vec<SheetId> =
        request.workbook.sheets.iter().map(|s| s.id).collect();
    let published_charts: Vec<SavedChart> = request
        .workbook
        .charts
        .iter()
        .filter(|c| published_sheet_ids.contains(&c.sheet_id))
        .map(|c| {
            let mut chart = c.clone();
            if let Some(stamped) =
                crate::chart_refs::stamp_chart_spec_sheet_ids(&c.spec_json, &workbook_sheet_ids)
            {
                chart.spec_json = stamped;
            }
            chart
        })
        .collect();
    if !published_charts.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "charts.json",
            serde_json::to_string_pretty(&published_charts)?.as_bytes(),
        )?;
    }

    // Write sparklines on the published sheets (C2a) — same shape as charts:
    // sheet-keyed, opaque groups_json with only in-sheet coords, so pull remaps
    // each entry's sheet id to the new local sheet. Written before the manifest
    // so the integrity walk checksums it and the signature seals it.
    let published_sparklines: Vec<&SavedSparkline> = request
        .workbook
        .sparklines
        .iter()
        .filter(|s| published_sheet_ids.contains(&s.sheet_id))
        .collect();
    if !published_sparklines.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "sparklines.json",
            serde_json::to_string_pretty(&published_sparklines)?.as_bytes(),
        )?;
    }

    // Write conditional formatting + data validation on the published sheets.
    // The Workbook carrier (build_workbook_snapshot) already holds them per-sheet,
    // keyed by SheetId with opaque app payloads; filter to published sheets and
    // write as artifacts (pull remaps each entry's sheet id to the local sheet).
    let published_conditional_formats: Vec<_> = request
        .workbook
        .conditional_formats
        .iter()
        .filter(|c| published_sheet_ids.contains(&c.sheet_id))
        .collect();
    if !published_conditional_formats.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "conditional_formats.json",
            serde_json::to_string_pretty(&published_conditional_formats)?.as_bytes(),
        )?;
    }
    let published_data_validations: Vec<_> = request
        .workbook
        .data_validations
        .iter()
        .filter(|d| published_sheet_ids.contains(&d.sheet_id))
        .collect();
    if !published_data_validations.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "data_validations.json",
            serde_json::to_string_pretty(&published_data_validations)?.as_bytes(),
        )?;
    }

    // Write cell-anchored controls (buttons/checkboxes — onSelect wiring,
    // formula-driven properties) on the published sheets. Same per-sheet
    // opaque-payload shape as CF/DV; pull remaps each entry's sheet id to the
    // local sheet. The scripts a control references travel separately as
    // object_scripts (consent-gated); this carries the HOST so a shipped
    // script no longer arrives orphaned.
    let published_controls: Vec<_> = request
        .workbook
        .controls
        .iter()
        .filter(|c| published_sheet_ids.contains(&c.sheet_id))
        .collect();
    if !published_controls.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "controls.json",
            serde_json::to_string_pretty(&published_controls)?.as_bytes(),
        )?;
    }

    // Write embedded binary media as ITS OWN artifacts, one file per blob at
    // media/{sha256} — never inlined into controls.json.
    //
    // THIS IS WHAT MAKES THE BLOB STORE WORK. `commit_artifacts_as_blobs` keys
    // the content-addressed store on each ARTIFACT's SHA-256, and a media
    // artifact's content IS the image, so its blob key is literally the media
    // hash. Publish version 1.0.1 with one caption changed and the logo is not
    // re-stored: the same blob is already there. Inline the base64 in
    // controls.json instead and the blob key is the SHA of the WHOLE controls
    // file, so a one-character caption edit mints a fresh multi-megabyte blob
    // every release — which is exactly what shipped.
    //
    // Only media the PUBLISHED sheets actually reference travels. A subscriber
    // must not receive the picture from a sheet the publisher chose to withhold.
    // The artifact walk in `integrity::compute_artifact_checksums` recurses into
    // every directory except `submissions/` and `reviews/`, so these are hashed
    // and LISTED automatically — which they must be, since that same walk
    // rejects any unlisted on-disk artifact (`UnlistedArtifact`).
    {
        let mut referenced: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for entry in &published_controls {
            calcula_format::media::visit_media_refs(&entry.controls, &mut |hash| {
                referenced.insert(hash.to_string());
            });
        }
        for hash in &referenced {
            if let Some(bytes) = request.workbook.media.get(hash) {
                registry.write_artifact(pkg, ver, &format!("media/{}", hash), bytes)?;
            }
        }
    }

    // Write threaded comments on the published sheets (Wave B) — same
    // per-sheet opaque-payload shape as CF/DV — but ONLY when the publish
    // request opted in. Comments are internal discussion, not report content:
    // shipping them by default would be a privacy hazard, so absent the
    // explicit opt-in the artifact is never written (and the publish report
    // discloses that they stayed private).
    let published_comments: Vec<_> = if request.include_comments {
        request
            .workbook
            .comments
            .iter()
            .filter(|c| published_sheet_ids.contains(&c.sheet_id))
            .collect()
    } else {
        Vec::new()
    };
    if !published_comments.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "comments.json",
            serde_json::to_string_pretty(&published_comments)?.as_bytes(),
        )?;
    }

    // Write what-if scenarios on the published sheets (Wave B) — per-sheet
    // opaque payloads, CF/DV shape. Always published: scenarios are workbook
    // content the subscriber needs for the report's what-if analysis.
    let published_scenarios: Vec<_> = request
        .workbook
        .scenarios
        .iter()
        .filter(|s| published_sheet_ids.contains(&s.sheet_id))
        .collect();
    if !published_scenarios.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "scenarios.json",
            serde_json::to_string_pretty(&published_scenarios)?.as_bytes(),
        )?;
    }

    // Write row/column outline groups on the published sheets (Wave B) —
    // per-sheet opaque payloads, CF/DV shape. Collapsed groups' hidden
    // rows/cols already ride in the sheet data; this carries the STRUCTURE
    // so subscribers can expand/collapse.
    let published_outlines: Vec<_> = request
        .workbook
        .outlines
        .iter()
        .filter(|o| published_sheet_ids.contains(&o.sheet_id))
        .collect();
    if !published_outlines.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "outlines.json",
            serde_json::to_string_pretty(&published_outlines)?.as_bytes(),
        )?;
    }

    // Write CELL BEHAVIOR bindings on the published sheets — per-sheet opaque
    // payloads, the same shape as CF/DV/outlines.
    //
    // These were the one piece of granular-brick content that never travelled.
    // A cell TYPE ships (as a `cellType` custom object) and its BEHAVIOR — the
    // binding that says which script runs for a range — did not, so a published
    // report arrived with typed cells that looked right and did nothing. The
    // scripts themselves already ship consent-gated as object scripts; a binding
    // is inert metadata naming one of them, so it carries no reach a subscriber
    // has not already been asked about.
    let published_cell_behaviors: Vec<_> = request
        .workbook
        .cell_behaviors
        .iter()
        .filter(|b| published_sheet_ids.contains(&b.sheet_id))
        .collect();
    if !published_cell_behaviors.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "cell_behaviors.json",
            serde_json::to_string_pretty(&published_cell_behaviors)?.as_bytes(),
        )?;
    }

    // Write pane controls (Controls pane) — WORKBOOK-scoped like pivot
    // definitions, not filtered per sheet: the pane strip belongs to the
    // workbook, so a report application carries all of it. Sorted by (order, id)
    // for deterministic artifact bytes across publishes (stable checksums +
    // blob dedup), matching collect_pane_controls_for_save's .cala ordering.
    //
    // No sanitization needed (D6, deliberate contrast with on-grid controls'
    // stripped onSelect): pane-control configs contain NO inline code by
    // design. A custom control's script is a normal object script
    // (instanceId "pane-{controlId}") and a pane button's click behavior is an
    // objectType "button" object script — both ship separately via
    // object_scripts/ above, where pull forces Restricted/Distributed and the
    // subscriber's consent gate governs mounting.
    let published_pane_controls = {
        let mut controls = request.workbook.pane_controls.clone();
        controls.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        controls
    };
    if !published_pane_controls.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "pane_controls.json",
            serde_json::to_string_pretty(&published_pane_controls)?.as_bytes(),
        )?;
    }

    // Write slicers on the published sheets (Wave A) — sheet-anchored like
    // charts: filtered to the published selection and keyed by the APPLICATION
    // sheet id (the pull side remaps to the local sheet and drops slicers
    // whose sheet wasn't pulled). Sorted by id for deterministic artifact
    // bytes across publishes (the live store is a HashMap).
    let published_slicers = {
        let mut slicers: Vec<persistence::SavedSlicer> = request
            .workbook
            .slicers
            .iter()
            .filter(|s| published_sheet_ids.contains(&s.sheet_id))
            .cloned()
            .collect();
        slicers.sort_by(|a, b| a.id.cmp(&b.id));
        slicers
    };
    if !published_slicers.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "slicers.json",
            serde_json::to_string_pretty(&published_slicers)?.as_bytes(),
        )?;
    }

    // Write TIMELINE slicers on the published sheets -- the slicer shape
    // (sheet-anchored, APPLICATION sheet ids, sorted by id for stable bytes),
    // filtered once more: a timeline travels only when the pivot it filters
    // travels too, the publish twin of the save path's pruning. A timeline
    // bound to a pivot the application does not carry would arrive drawn and
    // filtering nothing; `object_source_warnings` tells the publisher instead.
    // The rule is `timeline_slicer_travels`, shared with the version stamp.
    let published_timeline_slicers = {
        let mut timelines: Vec<persistence::SavedTimelineSlicer> = request
            .workbook
            .timeline_slicers
            .iter()
            .filter(|t| {
                timeline_slicer_travels(t, request.workbook, |id| published_sheet_ids.contains(id))
            })
            .cloned()
            .collect();
        timelines.sort_by(|a, b| a.id.cmp(&b.id));
        timelines
    };
    if !published_timeline_slicers.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "timeline_slicers.json",
            serde_json::to_string_pretty(&published_timeline_slicers)?.as_bytes(),
        )?;
    }

    // Write FLOATING RANGE object rows. A floating range is two things: an
    // ordinary sheet holding its cells (visibility "object", published like any
    // other sheet) and this row binding the stable ids to geometry and the
    // visible window. Before this artifact the backing sheet travelled and the
    // row did not, so the subscriber got an orphaned hidden sheet and no grid
    // on the page.
    //
    // A row travels only when BOTH its host and its backing sheet are
    // published: without the host it has nowhere to draw, without the backing
    // sheet it has nothing to show. Ids stay APPLICATION ids (the host remaps
    // them, like slicers). Sorted by id, and the row's width/height maps
    // serialize in key order, so identical content is identical bytes.
    let published_floating_ranges = {
        let mut rows: Vec<persistence::SavedFloatingRange> = request
            .workbook
            .floating_ranges
            .iter()
            .filter(|fr| floating_range_travels(fr, |id| published_sheet_ids.contains(id)))
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        rows
    };
    if !published_floating_ranges.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "floating_ranges.json",
            serde_json::to_string_pretty(&published_floating_ranges)?.as_bytes(),
        )?;
    }

    // Write ribbon filters (Wave A) — WORKBOOK-scoped like pane controls, so
    // all of them travel. They are BI-only by design: each carries its stable
    // application data-source id, and pull re-binds connection ids to the freshly
    // materialized application connections (filters whose data source is not
    // embedded in the application are skipped at pull, never clobbered). Sorted by
    // (order, id) for deterministic bytes, matching pane_controls.
    let published_ribbon_filters = {
        let mut filters = request.workbook.ribbon_filters.clone();
        filters.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        filters
    };
    if !published_ribbon_filters.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "ribbon_filters.json",
            serde_json::to_string_pretty(&published_ribbon_filters)?.as_bytes(),
        )?;
    }

    // Write saved pivot layouts (Wave A) — workbook-scoped; the carrier Vec's
    // stable order is preserved (already deterministic).
    if !request.workbook.pivot_layouts.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "pivot_layouts.json",
            serde_json::to_string_pretty(&request.workbook.pivot_layouts)?.as_bytes(),
        )?;
    }

    // Write the document theme (Wave A) — a workbook SINGLETON, always
    // written. The pull side applies it only while the subscriber's theme is
    // still the default (subscriber customization always wins).
    registry.write_artifact(
        pkg, ver,
        "theme.json",
        serde_json::to_string_pretty(&request.workbook.theme)?.as_bytes(),
    )?;

    // Write extension data (Wave A) — the whole per-extension state map,
    // serialized through a BTreeMap so artifact bytes are key-order
    // deterministic. Pull merges ADDITIVELY: only keys the subscriber does
    // not already have are inserted (never overwritten).
    if !request.workbook.extension_data.is_empty() {
        let ordered: std::collections::BTreeMap<&String, &serde_json::Value> =
            request.workbook.extension_data.iter().collect();
        registry.write_artifact(
            pkg, ver,
            "extension_data.json",
            serde_json::to_string_pretty(&ordered)?.as_bytes(),
        )?;
    }

    // Disclosure-only dropdown-reference check — shared with the app's
    // publish preview via `dropdown_reference_warnings` (which re-derives the
    // artifact's (order, id) ordering, so the warnings match the
    // published_pane_controls written above).
    let mut warnings = dropdown_reference_warnings(request.workbook, &request.sheet_indices);
    // The same disclosure for the objects whose DATA lives on another sheet:
    // a chart's sources, and the table/pivot a slicer or timeline filters.
    warnings.extend(chart_source_warnings(request.workbook, &request.sheet_indices));
    warnings.extend(object_source_warnings(request.workbook, &request.sheet_indices));

    // Loud-failure guard for macro-linked buttons: warn the publisher when a
    // button links a recorded macro that this publish's (possibly narrowed)
    // module set does not carry. The published module ids are exactly the ones
    // written above (override set, or all workbook modules by default).
    let published_module_ids: std::collections::HashSet<String> =
        modules_to_publish.iter().map(|s| s.id.clone()).collect();
    warnings.extend(macro_reference_warnings(
        request.workbook,
        &request.sheet_indices,
        &published_module_ids,
    ));

    // Write object scripts
    if !scripts_to_publish.is_empty() {
        for script in &scripts_to_publish {
            let mut def = calcula_format::features::object_scripts::ObjectScriptDef::from(*script);
            // Applications ship provenance-clean: the subscriber stamps
            // provenance at pull time. This also covers re-publishing a
            // workbook that itself contains pulled (distributed) scripts.
            def.provenance = Default::default();
            def.package_name = None;
            registry.write_artifact(
                pkg, ver,
                &format!("object_scripts/{}.json", script.id),
                serde_json::to_string_pretty(&def)?.as_bytes(),
            )?;
        }
    }

    // Write standalone module scripts (C8) as modules/{id}.json using the
    // calcula-format ScriptDef (camelCase). Module scripts are inert,
    // transparent data — distributed as-is, no provenance/access-level/
    // capability stamping. Written BEFORE the manifest so the integrity walk
    // checksums them and the Ed25519 signature seals them.
    if !modules_to_publish.is_empty() {
        for script in &modules_to_publish {
            let mut def = calcula_format::features::scripts::ScriptDef::from(*script);
            // Clear any distribution provenance: the SUBSCRIBER stamps this with
            // the new application name on pull. A publisher who in turn subscribed to
            // some upstream application must not leak that upstream attribution.
            def.source_package = None;
            registry.write_artifact(
                pkg, ver,
                &format!("modules/{}.json", script.id),
                serde_json::to_string_pretty(&def)?.as_bytes(),
            )?;
        }
    }

    // Write standalone notebooks (C8) as notebooks/{id}.json using the
    // calcula-format NotebookDef (camelCase). Execution metadata is STRIPPED:
    // last_output/last_error/cells_modified/duration_ms/execution_index are
    // zeroed so cached output can never leak in a published application — only
    // cell id + source ship. Written BEFORE the manifest so they are covered
    // by the integrity checksums and the Ed25519 signature.
    if !notebooks_to_publish.is_empty() {
        for notebook in &notebooks_to_publish {
            let mut def = calcula_format::features::notebooks::NotebookDef::from(*notebook);
            // Clear provenance (subscriber re-stamps on pull) + strip exec metadata.
            def.source_package = None;
            for cell in &mut def.cells {
                cell.last_output = Vec::new();
                cell.last_error = None;
                cell.cells_modified = 0;
                cell.duration_ms = 0;
                cell.execution_index = None;
            }
            registry.write_artifact(
                pkg, ver,
                &format!("notebooks/{}.json", notebook.id),
                serde_json::to_string_pretty(&def)?.as_bytes(),
            )?;
        }
    }

    // Write pivot definitions
    if !request.workbook.pivot_definitions.is_empty() {
        for pivot_def in &request.workbook.pivot_definitions {
            registry.write_artifact(
                pkg, ver,
                &format!("pivot_definitions/{}.json", pivot_def.id),
                serde_json::to_string_pretty(pivot_def)?.as_bytes(),
            )?;
        }
    }

    // Write BI pivot metadata (needed for BI-connected pivots)
    if !request.workbook.bi_pivot_metadata.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "pivot_definitions/bi_metadata.json",
            serde_json::to_string_pretty(&request.workbook.bi_pivot_metadata)?.as_bytes(),
        )?;
    }

    // Write embedded data source models + materialized calculated-table
    // snapshots (Arrow IPC bytes; checksummed like every other artifact).
    for ds in &request.data_sources {
        registry.write_artifact(
            pkg, ver,
            &format!("models/{}/model.json", ds.id),
            serde_json::to_string_pretty(&ds.model_json)?.as_bytes(),
        )?;
        // Writeback-column baseline: the publisher's collected history, so
        // the columns don't arrive empty at subscribers.
        if let Some(history) = &ds.writeback_history_json {
            registry.write_artifact(
                pkg, ver,
                &format!("models/{}/writeback_history.json", ds.id),
                serde_json::to_string_pretty(history)?.as_bytes(),
            )?;
        }
        for (i, snap) in ds.calculated_table_snapshots.iter().enumerate() {
            registry.write_artifact(
                pkg, ver,
                &format!("models/{}/calculated_tables/{}.arrow", ds.id, i),
                &snap.ipc_bytes,
            )?;
        }
    }

    // All artifacts are on disk in final form: compute SHA-256 checksums over
    // the actual bytes via the transport, then write the version manifest LAST.
    // The manifest is the integrity root — it cannot contain its own hash, so it
    // covers all OTHER artifacts and is itself the commit point of the publish.
    version_manifest.artifact_checksums =
        crate::integrity::compute_artifact_checksums_via(registry, pkg, ver)?;
    // Org-scale dedup: move the just-written artifacts into the content-addressed
    // blob store (identical bytes across versions are stored once). The checksum
    // map computed above is unchanged, so the signed manifest — and integrity —
    // are unaffected; only WHERE the bytes live changes.
    registry.commit_artifacts_as_blobs(pkg, ver, &version_manifest.artifact_checksums)?;
    registry.write_version_manifest(pkg, ver, &version_manifest)?;

    // S5 phase 2: seal the integrity root. Sign the RAW bytes of
    // version-manifest.json AS WRITTEN (read it back via the transport —
    // re-serializing the in-memory manifest may not be byte-identical to what
    // write_version_manifest produced). The detached signature lands in the
    // sibling version-manifest.sig, completing the publish.
    let manifest_bytes = registry
        .read_artifact(pkg, ver, crate::integrity::VERSION_MANIFEST_FILE)?
        .ok_or_else(|| CalpError::Workspace(format!(
            "version manifest missing immediately after write for {pkg}@{ver}"
        )))?;
    let signature_hex = keypair.sign(&manifest_bytes);
    registry.write_artifact(
        pkg, ver,
        crate::integrity::VERSION_MANIFEST_SIG_FILE,
        signature_hex.as_bytes(),
    )?;

    // Append to the version list. Still under the `_lock` acquired before the
    // gates — do NOT re-acquire it here: WorkspaceLock is a lockfile, not a
    // reentrant mutex, so a second acquire would block against this publish's
    // own live lock until it timed out with WorkspaceBusy.
    {
        let mut pkg_manifest = registry.get_application_manifest(&request.package_name)
            .unwrap_or_else(|_| ApplicationManifest::new(
                &request.package_name, &request.kind, &request.published_by, &request.now,
            ));

        pkg_manifest.versions.push(VersionEntry {
            version: version_str.clone(),
            published_at: request.now.clone(),
            published_by: request.published_by.clone(),
            base_version: version_manifest.base_version.clone(),
            change_summary: version_manifest.change_summary.clone(),
            publisher_key: keypair.public_key_hex(),
            extra: std::collections::HashMap::new(),
        });
        registry.write_application_manifest(&pkg_manifest)?;
    }
    drop(_lock);

    Ok(PublishResult {
        package_name: request.package_name.clone(),
        version: version_str,
        sheets_published: request.sheet_indices.len(),
        tables_published: published_tables.len(),
        named_ranges_published: named_ranges.len(),
        scripts_published: scripts_to_publish.len(),
        modules_published: modules_to_publish.len(),
        notebooks_published: notebooks_to_publish.len(),
        charts_published: published_charts.len(),
        sparklines_published: published_sparklines.len(),
        pivots_published: request.workbook.pivot_definitions.len(),
        conditional_format_sheets: published_conditional_formats.len(),
        data_validation_sheets: published_data_validations.len(),
        control_sheets_published: published_controls.len(),
        comment_sheets_published: published_comments.len(),
        scenario_sheets_published: published_scenarios.len(),
        outline_sheets_published: published_outlines.len(),
        cell_behaviors_published: published_cell_behaviors.len(),
        pane_controls_published: published_pane_controls.len(),
        slicers_published: published_slicers.len(),
        timeline_slicers_published: published_timeline_slicers.len(),
        floating_ranges_published: published_floating_ranges.len(),
        ribbon_filters_published: published_ribbon_filters.len(),
        pivot_layouts_published: request.workbook.pivot_layouts.len(),
        extension_data_published: request.workbook.extension_data.len(),
        data_sources_published: request.data_sources.len(),
        writeback_regions_published: request
            .writeback_regions
            .as_ref()
            .map_or(0, |w| w.len()),
        warnings,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    use persistence::Sheet;
    use engine::cell::Cell;
    use crate::workspace::LocalWorkspace;

    fn make_test_workbook() -> Workbook {
        let mut sheet1 = Sheet::new("Dashboard".to_string());
        let cell = Cell::new_number(42.0);
        sheet1.cells.insert((0, 0), persistence::SavedCell::from_cell(&cell));

        let mut sheet2 = Sheet::new("Data".to_string());
        let cell2 = Cell::new_text("hello".to_string());
        sheet2.cells.insert((0, 0), persistence::SavedCell::from_cell(&cell2));

        let mut wb = Workbook::default();
        wb.sheets = vec![sheet1, sheet2];
        wb
    }

    /// A dropdown pane control with the given item `source` payload.
    fn dropdown_pane_control(name: &str, source: serde_json::Value) -> persistence::SavedPaneControl {
        persistence::SavedPaneControl {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            control_type: "dropdown".to_string(),
            config: serde_json::json!({ "type": "dropdown", "source": source, "placeholder": null }),
            value: serde_json::Value::Null,
            order: 0,
        }
    }

    /// Every regular file under `root`, recursively, as raw bytes.
    ///
    /// A field-by-field check would only ever prove what somebody remembered to
    /// look at. Bytes prove the absence.
    fn every_file_under(root: &Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(bytes) = fs::read(&path) {
                    out.push((path, bytes));
                }
            }
        }
        out
    }

    #[test]
    fn user_files_never_reach_a_published_package() {
        // THE PRIVACY TEETH, and there is no equivalent for ANY `user_files`
        // section today: `rg user_files core/calp/src/` returns no hits
        // outside a doc comment in audit.rs and this test. The firewall that
        // keeps a subscriber
        // from receiving the publisher's audit log, schedule and — since
        // 2026-08-26 — the prompts the publisher typed to an AI has rested on
        // "the calp crate never reads Workbook::user_files", which is a property
        // nothing measured.
        //
        // `script_authoring.json` is the section that makes it matter most: a
        // prompt is the publisher's own words about their own data. Anyone who
        // publishes a sales report should not thereby email their subscribers
        // the sentence "flag the customers who are behind on payments".
        //
        // Byte-level over the whole application, not a field check, and it
        // retroactively pins the same firewall for scheduled_jobs.json and
        // audit_log.json.
        const SECRET: &str = "customers who are behind on payments";

        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        wb.user_files.insert(
            "script_authoring.json".to_string(),
            format!(
                r#"{{"schemaVersion":1,"runs":{{"obj-1":[{{"runId":"r1","instruction":"{}"}}]}}}}"#,
                SECRET
            )
            .into_bytes(),
        );
        wb.user_files.insert(
            "scheduled_jobs.json".to_string(),
            format!(r#"{{"schemaVersion":1,"jobs":[],"note":"{}"}}"#, SECRET).into_bytes(),
        );
        wb.user_files.insert(
            "audit_log.json".to_string(),
            format!(r#"{{"enabled":true,"entries":[],"note":"{}"}}"#, SECRET).into_bytes(),
        );

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "privacy".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: String::new(),
            sheet_indices: vec![0, 1],
            now: "2026-08-26T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish(&reg, &request, prof.path()).unwrap();

        let files = every_file_under(dir.path());
        assert!(
            !files.is_empty(),
            "the walk found no artifacts at all, so it proves nothing"
        );
        let needle = SECRET.as_bytes();
        for (path, bytes) in &files {
            assert!(
                !bytes
                    .windows(needle.len())
                    .any(|w| w == needle),
                "the publisher's own words reached the package, in {}",
                path.display()
            );
            assert!(
                !bytes.windows(21).any(|w| w == b"script_authoring.json"),
                "the section NAME reached the package, in {}",
                path.display()
            );
        }
    }

    #[test]
    fn reference_sheet_name_parses_prefixes() {
        assert_eq!(reference_sheet_name("Data!A1:A10"), Some("Data".to_string()));
        assert_eq!(reference_sheet_name("  Data!A1  "), Some("Data".to_string()));
        assert_eq!(reference_sheet_name("'My Sheet'!A1"), Some("My Sheet".to_string()));
        assert_eq!(reference_sheet_name("'It''s'!A1:B2"), Some("It's".to_string()));
        assert_eq!(reference_sheet_name("A1:A10"), None);
        assert_eq!(reference_sheet_name("'Unterminated"), None);
        assert_eq!(reference_sheet_name("'Quoted'NoBang"), None);
    }

    #[test]
    fn publish_warns_on_dangling_dropdown_cell_range_references() {
        // Disclosure-only (fidelity matrix): dropdown CellRange references
        // ship verbatim; a reference to a sheet OUTSIDE the published
        // selection (or with no sheet prefix at all) must surface a publish
        // warning while leaving the artifact byte-identical semantics-wise.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = make_test_workbook(); // sheets: "Dashboard", "Data"
        wb.pane_controls = vec![
            // In-selection reference: silent.
            dropdown_pane_control(
                "Region",
                serde_json::json!({ "type": "cellRange", "reference": "Dashboard!A1:A5" }),
            ),
            // References the UNPUBLISHED "Data" sheet: warned.
            dropdown_pane_control(
                "Product",
                serde_json::json!({ "type": "cellRange", "reference": "Data!A1:A10" }),
            ),
            // Quoted form of the same unpublished sheet: warned (unquoted name).
            dropdown_pane_control(
                "Quarter",
                serde_json::json!({ "type": "cellRange", "reference": "'Data'!B1:B4" }),
            ),
            // No sheet prefix (active-sheet-relative): flagged too.
            dropdown_pane_control(
                "Channel",
                serde_json::json!({ "type": "cellRange", "reference": "A1:A3" }),
            ),
            // Static dropdowns never warn.
            dropdown_pane_control(
                "Mode",
                serde_json::json!({ "type": "static", "items": ["a", "b"] }),
            ),
        ];

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "dangle".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: String::new(),
            sheet_indices: vec![0], // only "Dashboard" ships
            now: "2026-07-03T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let result = publish(&reg, &request, prof.path()).unwrap();

        assert_eq!(result.pane_controls_published, 5);
        assert_eq!(result.warnings.len(), 3, "warnings: {:?}", result.warnings);
        let warned = result.warnings.join("\n");
        assert!(warned.contains("\"Product\"") && warned.contains("Data!A1:A10"), "{warned}");
        assert!(warned.contains("\"Quarter\"") && warned.contains("sheet \"Data\""), "{warned}");
        assert!(
            warned.contains("\"Channel\"") && warned.contains("without a sheet prefix"),
            "{warned}"
        );
        assert!(!warned.contains("\"Region\""), "{warned}");
        assert!(!warned.contains("\"Mode\""), "{warned}");

        // No behavior change to the artifact: the reference ships verbatim.
        let bytes = reg
            .read_artifact("dangle", "1.0.0", "pane_controls.json")
            .unwrap()
            .expect("pane_controls.json");
        let saved: Vec<persistence::SavedPaneControl> = serde_json::from_slice(&bytes).unwrap();
        assert!(saved
            .iter()
            .any(|c| c.config["source"]["reference"] == "Data!A1:A10"));
    }

    #[test]
    fn publish_with_covered_dropdown_references_emits_no_warnings() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        wb.pane_controls = vec![dropdown_pane_control(
            "Region",
            serde_json::json!({ "type": "cellRange", "reference": "Data!A1:A5" }),
        )];

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "covered".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: String::new(),
            sheet_indices: vec![0, 1], // both sheets ship — "Data" is covered
            now: "2026-07-03T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let result = publish(&reg, &request, prof.path()).unwrap();
        assert!(result.warnings.is_empty(), "warnings: {:?}", result.warnings);
    }

    #[test]
    fn dropdown_reference_warnings_computes_without_publishing() {
        // The preview contract: the SAME warnings a publish would emit,
        // computed from the carrier alone — no workspace, no artifact writes.
        let mut wb = make_test_workbook(); // sheets: "Dashboard", "Data"
        wb.pane_controls = vec![
            dropdown_pane_control(
                "Region",
                serde_json::json!({ "type": "cellRange", "reference": "Dashboard!A1:A5" }),
            ),
            dropdown_pane_control(
                "Product",
                serde_json::json!({ "type": "cellRange", "reference": "Data!A1:A10" }),
            ),
            dropdown_pane_control(
                "Channel",
                serde_json::json!({ "type": "cellRange", "reference": "A1:A3" }),
            ),
        ];

        let warnings = dropdown_reference_warnings(&wb, &[0]); // only "Dashboard"
        assert_eq!(warnings.len(), 2, "warnings: {:?}", warnings);
        let joined = warnings.join("\n");
        assert!(joined.contains("\"Product\"") && joined.contains("sheet \"Data\""), "{joined}");
        assert!(joined.contains("\"Channel\"") && joined.contains("without a sheet prefix"), "{joined}");
        assert!(!joined.contains("\"Region\""), "{joined}");

        // Covering selection: the sheet-scoped warning clears; the
        // prefix-less "Channel" one is selection-independent and remains.
        let covered = dropdown_reference_warnings(&wb, &[0, 1]);
        assert_eq!(covered.len(), 1, "warnings: {:?}", covered);
        assert!(covered[0].contains("\"Channel\""), "{covered:?}");
        // Out-of-range indices are tolerated (the preview path never
        // validates them; publish does separately).
        assert_eq!(dropdown_reference_warnings(&wb, &[0, 99]).len(), 2);
    }

    /// One on-grid control payload entry carrying a `macroRef` link.
    fn macro_button(row: u32, col: u32, macro_id: &str) -> serde_json::Value {
        serde_json::json!({
            "row": row,
            "col": col,
            "controlType": "button",
            "properties": {
                "text": { "valueType": "static", "value": "Run" },
                "macroRef": { "valueType": "static", "value": macro_id },
            },
        })
    }

    #[test]
    fn macro_reference_warnings_flag_a_button_whose_macro_is_excluded() {
        let mut wb = make_test_workbook(); // sheets: "Dashboard"(0), "Data"(1)
        let dashboard_id = wb.sheets[0].id;
        wb.controls = vec![persistence::SavedSheetControls {
            sheet_id: dashboard_id,
            controls: serde_json::json!([
                macro_button(0, 0, "macro-present"),
                macro_button(2, 27, "macro-missing"), // AB3
            ]),
        }];

        // Only "macro-present" ships. The button linking "macro-missing" must
        // be flagged — loudly, by anchor and macro id.
        let mut published: std::collections::HashSet<String> = std::collections::HashSet::new();
        published.insert("macro-present".to_string());

        let warnings = macro_reference_warnings(&wb, &[0], &published);
        assert_eq!(warnings.len(), 1, "warnings: {:?}", warnings);
        assert!(warnings[0].contains("macro-missing"), "{}", warnings[0]);
        assert!(warnings[0].contains("Dashboard!AB3"), "{}", warnings[0]);
        // The present one is never warned about.
        assert!(!warnings[0].contains("macro-present"), "{}", warnings[0]);
    }

    #[test]
    fn macro_reference_warnings_are_silent_when_all_linked_macros_ship() {
        let mut wb = make_test_workbook();
        let dashboard_id = wb.sheets[0].id;
        wb.controls = vec![persistence::SavedSheetControls {
            sheet_id: dashboard_id,
            controls: serde_json::json!([macro_button(0, 0, "macro-a")]),
        }];
        let published: std::collections::HashSet<String> =
            ["macro-a".to_string()].into_iter().collect();
        assert!(macro_reference_warnings(&wb, &[0], &published).is_empty());

        // A control on a sheet OUTSIDE the published selection is ignored, even
        // when its macro is absent (that button isn't shipping either).
        let empty: std::collections::HashSet<String> = std::collections::HashSet::new();
        assert!(macro_reference_warnings(&wb, &[1], &empty).is_empty());
    }

    #[test]
    fn publish_creates_package() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "test-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: String::new(),
            sheet_indices: vec![0, 1],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };

        let result = publish(&reg, &request, prof.path()).unwrap();
        assert_eq!(result.sheets_published, 2);
        assert_eq!(result.version, "1.0.0");

        // Verify application manifest was created
        let pkg = reg.get_application_manifest("test-pkg").unwrap();
        assert_eq!(pkg.versions.len(), 1);
        assert_eq!(pkg.versions[0].version, "1.0.0");

        // Verify version manifest
        let ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        assert_eq!(ver.sheets.len(), 2);
        assert_eq!(ver.sheets[0].name, "Dashboard");
        assert_eq!(ver.sheets[1].name, "Data");

        // S5 phase 2: the manifest carries the publisher's public key and a
        // detached signature file sits next to it.
        assert_eq!(ver.publisher_key.len(), 64, "publisher_key should be 32-byte hex");
        assert!(!ver.publisher_name.is_empty());
        let ver_dir = reg.version_dir("test-pkg", "1.0.0").unwrap();
        let sig_path = ver_dir.join(crate::integrity::VERSION_MANIFEST_SIG_FILE);
        assert!(sig_path.exists(), "version-manifest.sig must be written");
        // The signature verifies over the RAW on-disk manifest bytes.
        let manifest_bytes = fs::read(ver_dir.join(crate::integrity::VERSION_MANIFEST_FILE)).unwrap();
        let sig_hex = fs::read_to_string(&sig_path).unwrap();
        crate::signing::verify_signature(
            &ver.publisher_key, &manifest_bytes, sig_hex.trim(), "test-pkg", "1.0.0",
        ).unwrap();

        // Sheet artifacts are deduplicated into the content-addressed blob store
        // (not stored per-version), and remain retrievable via read_artifact.
        let sid = &wb.sheets[0].id;
        for name in ["data.json", "styles.json", "layout.json"] {
            let key = format!("sheets/{sid}/{name}");
            assert!(
                reg.read_artifact("test-pkg", "1.0.0", &key).unwrap().is_some(),
                "artifact {key} must be retrievable"
            );
        }
        // The per-version copy was moved out by dedup.
        let sheet_dir = reg.sheet_dir("test-pkg", "1.0.0", sid).unwrap();
        assert!(!sheet_dir.join("data.json").exists());
    }

    #[test]
    fn publish_selected_sheets_only() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "partial".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: String::new(),
            sheet_indices: vec![0], // Only Dashboard
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };

        let result = publish(&reg, &request, prof.path()).unwrap();
        assert_eq!(result.sheets_published, 1);

        let ver = reg.get_version_manifest("partial", "1.0.0").unwrap();
        assert_eq!(ver.sheets.len(), 1);
        assert_eq!(ver.sheets[0].name, "Dashboard");
    }

    #[test]
    fn publish_records_artifact_checksums() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "checked".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: String::new(),
            sheet_indices: vec![0, 1],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish(&reg, &request, prof.path()).unwrap();

        let ver = reg.get_version_manifest("checked", "1.0.0").unwrap();

        // 2 sheets x (data.json + styles.json + layout.json + metadata.json)
        // + the always-written theme.json singleton (Wave A).
        assert_eq!(ver.artifact_checksums.len(), 9);
        assert!(ver.artifact_checksums.contains_key("theme.json"));
        // The manifest is the integrity root: never lists itself.
        assert!(!ver.artifact_checksums.contains_key("version-manifest.json"));
        // The detached signature is likewise not a listed artifact.
        assert!(!ver.artifact_checksums.contains_key("version-manifest.sig"));

        // Keys are version-dir-relative with forward slashes; digests are
        // lowercase hex SHA-256 of the final on-disk bytes.
        let data_key = format!("sheets/{}/data.json", wb.sheets[0].id);
        let digest = ver.artifact_checksums.get(&data_key)
            .expect("data.json must be listed in artifact checksums");
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));

        let bytes = reg
            .read_artifact("checked", "1.0.0", &data_key)
            .unwrap()
            .expect("data.json must be retrievable from the blob store");
        assert_eq!(digest, &crate::integrity::sha256_hex(&bytes));
    }

    /// Count blob files in the workspace's content-addressed store.
    fn count_blobs(root: &std::path::Path) -> usize {
        let blobs = root.join(".blobs");
        let mut n = 0;
        if let Ok(shards) = fs::read_dir(&blobs) {
            for shard in shards.flatten() {
                if let Ok(files) = fs::read_dir(shard.path()) {
                    n += files
                        .flatten()
                        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                        .count();
                }
            }
        }
        n
    }

    #[test]
    fn publish_dedups_identical_artifacts_across_versions() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        // Publish two versions of the SAME workbook — the artifact bytes are
        // identical across versions (only the manifest differs).
        for v in [SemVer::new(1, 0, 0), SemVer::new(1, 0, 1)] {
            let first = v == SemVer::new(1, 0, 0);
            let request = PublishRequest {
            model_writebacks: None,
                workbook: &wb,
                package_name: "dedup".to_string(),
                version: v,
                kind: "report".to_string(),
                mode: if first {
                    PushMode::CreateNew
                } else {
                    PushMode::Update { expected_base: SemVer::new(1, 0, 0) }
                },
                change_summary: "republish, same content".to_string(),
                sheet_indices: vec![0, 1],
                now: "2026-05-18T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish(&reg, &request, prof.path()).unwrap();
        }

        let v1 = reg.get_version_manifest("dedup", "1.0.0").unwrap();
        let v2 = reg.get_version_manifest("dedup", "1.0.1").unwrap();
        let total_refs = v1.artifact_checksums.len() + v2.artifact_checksums.len();
        assert!(total_refs > 0);

        let mut unique: std::collections::HashSet<&String> = std::collections::HashSet::new();
        unique.extend(v1.artifact_checksums.values());
        unique.extend(v2.artifact_checksums.values());

        let blob_count = count_blobs(dir.path());
        // Dedup: identical bytes across versions are stored once, so fewer blobs
        // than total artifact references, exactly one blob per unique content.
        assert!(
            blob_count < total_refs,
            "expected dedup: {blob_count} blobs < {total_refs} refs"
        );
        assert_eq!(blob_count, unique.len(), "one blob per unique content hash");

        // Both versions still pull intact from the shared blob store.
        for ver in ["1.0.0", "1.0.1"] {
            let req = crate::pull::PullRequest {
                package_name: "dedup".to_string(),
                target: crate::manifest::SubscriptionTarget::Line(crate::version::VersionPin::Exact(
                    if ver == "1.0.0" { SemVer::new(1, 0, 0) } else { SemVer::new(1, 0, 1) },
                )),
                now: "2026-05-18T01:00:00Z".to_string(),
            };
            let scope =
                crate::workspace_id::workspace_scope(&dir.path().to_string_lossy()).unwrap();
            let result = crate::pull::pull(&reg, &req, &scope, prof.path(), crate::integrity::PinPolicy::PinOnFirstUse).unwrap();
            assert_eq!(result.sheets.len(), 2);
        }
    }

    #[test]
    fn publish_duplicate_version_fails() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "dup".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: String::new(),
            sheet_indices: vec![0],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };

        publish(&reg, &request, prof.path()).unwrap();

        // Publishing the same request again is a CreateNew into a name that now
        // exists — refused before it can touch a byte of the published version.
        let result = publish(&reg, &request, prof.path());
        assert!(
            matches!(result, Err(CalpError::ApplicationAlreadyExists(ref p)) if p == "dup"),
            "expected ApplicationAlreadyExists, got {result:?}"
        );

        // And the honest way to try the same thing — pushing v1.0.0 as an
        // update whose base is v1.0.0 — is refused by the monotonic gate, which
        // is what keeps a published version immutable.
        let mut update = request;
        update.mode = PushMode::Update { expected_base: SemVer::new(1, 0, 0) };
        update.change_summary = "second try".to_string();
        let result = publish(&reg, &update, prof.path());
        assert!(
            matches!(result, Err(CalpError::VersionNotGreater { ref suggested, .. }) if suggested == "1.0.1"),
            "expected VersionNotGreater suggesting 1.0.1, got {result:?}"
        );
    }

    #[test]
    fn publish_multiple_versions() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let mut previous: Option<SemVer> = None;
        for (major, minor) in [(1, 0), (1, 1), (2, 0)] {
            let request = PublishRequest {
            model_writebacks: None,
                workbook: &wb,
                package_name: "multi".to_string(),
                version: SemVer::new(major, minor, 0),
                kind: "report".to_string(),
                mode: match &previous {
                    None => PushMode::CreateNew,
                    Some(base) => PushMode::Update { expected_base: base.clone() },
                },
                change_summary: "next version".to_string(),
                sheet_indices: vec![0],
                now: "2026-05-18T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish(&reg, &request, prof.path()).unwrap();
            previous = Some(SemVer::new(major, minor, 0));
        }

        let pkg = reg.get_application_manifest("multi").unwrap();
        assert_eq!(pkg.versions.len(), 3);

        let versions = reg.list_versions("multi").unwrap();
        assert_eq!(versions, vec![
            SemVer::new(1, 0, 0),
            SemVer::new(1, 1, 0),
            SemVer::new(2, 0, 0),
        ]);
    }
    // ======================================================================
    // No two sheets in one version may share a name
    // ======================================================================
    //
    // Asked by the owner: "what will happen if I try to publish a new sheet
    // with the same name as a sheet that is already published in the workspace?
    // It should get rejected right?" It was not. `publish()` bounds-checked each
    // index and copied `sheet.name` straight into the manifest — no set, no
    // dedup, no comparison against the base version it already had in hand.
    //
    // What it costs a subscriber is not cosmetic. `VersionManifest.sheets` is a
    // plain Vec keyed by nothing, so both names ship; `resolve_sheet_name_collisions`
    // then renames one on pull; and because cross-sheet references inside a
    // package are stored as raw TEXT and resolved by a FIRST-MATCH
    // case-insensitive name lookup, the package's own `=Sheet1!A1` binds to
    // whichever sheet won the name — with no #REF! and no warning.

    /// Two DIFFERENT sheets sharing a name are refused, and the message says
    /// which one to rename.
    ///
    /// SABOTAGE: delete the duplicate-name block from `publish()`.
    #[test]
    fn two_sheets_with_one_name_are_refused() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![
            persistence::Sheet::new("Sales".to_string()),
            persistence::Sheet::new("Sales".to_string()),
        ];

        let err = publish_two_sheets(&reg, &wb, prof.path(), vec![0, 1]).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Sales"), "the message must name the sheet: {msg}");
        assert!(
            msg.to_lowercase().contains("rename"),
            "the message must name the remedy: {msg}"
        );
    }

    /// CASE-INSENSITIVE, because the lexer uppercases bare identifiers and every
    /// other sheet-name comparison in the product is `eq_ignore_ascii_case`.
    /// `Data` and `data` are one name to a formula, so they must be one name
    /// here.
    ///
    /// SABOTAGE: compare `s.name` directly instead of its lowercase form.
    #[test]
    fn names_differing_only_in_case_are_the_same_name() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![
            persistence::Sheet::new("Data".to_string()),
            persistence::Sheet::new("data".to_string()),
        ];

        assert!(publish_two_sheets(&reg, &wb, prof.path(), vec![0, 1]).is_err());
    }

    /// THE SAME INDEX TWICE. `sheet_indices` is never deduped at any layer —
    /// not the frontend Set, not the params, not `resolve_publish_sheet_indices`,
    /// not the scripted gateway — so a repeated index produced two manifest
    /// entries sharing BOTH name and sheet_id, and signed cleanly.
    ///
    /// Its message differs from the collision one because the remedy differs:
    /// there is nothing to rename, the selection is simply wrong.
    #[test]
    fn the_same_sheet_named_twice_is_refused_in_its_own_words() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![persistence::Sheet::new("Only".to_string())];

        let err = publish_two_sheets(&reg, &wb, prof.path(), vec![0, 0]).unwrap_err();
        assert!(
            err.to_string().contains("named twice"),
            "a repeated index is a selection mistake, not a naming one: {err}"
        );
    }

    /// THE POSITIVE CONTROL. Distinct names still publish — the refusal must not
    /// have become "no two sheets".
    #[test]
    fn distinct_names_still_publish() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![
            persistence::Sheet::new("Sales".to_string()),
            persistence::Sheet::new("Costs".to_string()),
        ];

        assert!(publish_two_sheets(&reg, &wb, prof.path(), vec![0, 1]).is_ok());
    }

    fn publish_two_sheets(
        reg: &LocalWorkspace,
        wb: &persistence::Workbook,
        prof: &std::path::Path,
        sheet_indices: Vec<usize>,
    ) -> Result<crate::publish::PublishResult, CalpError> {
        let request = PublishRequest {
            model_writebacks: None,
            workbook: wb,
            package_name: "dupes".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: crate::publish::test_mode_for(reg, "dupes"),
            change_summary: "test".to_string(),
            sheet_indices,
            now: "2026-01-01T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish(reg, &request, prof)
    }

    // ======================================================================
    // Canvas objects through publish (M5): floating ranges, timelines, the
    // sources of charts / slicers / timelines, and the manifest's sheet kind
    // ======================================================================

    fn object_request<'a>(
        wb: &'a Workbook,
        package: &str,
        sheet_indices: Vec<usize>,
    ) -> PublishRequest<'a> {
        PublishRequest {
            model_writebacks: None,
            workbook: wb,
            package_name: package.to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: String::new(),
            sheet_indices,
            now: "2026-09-25T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        }
    }

    fn new_entity() -> EntityId {
        EntityId::from_bytes(identity::generate_uuid_v7())
    }

    fn floating_range(host: SheetId, backing: SheetId) -> persistence::SavedFloatingRange {
        persistence::SavedFloatingRange {
            id: new_entity(),
            backing_sheet_id: backing,
            host_sheet_id: host,
            x: 40.0,
            y: 60.0,
            rotation: 0.0,
            pin_to_grid: false,
            row_count: 5,
            col_count: 3,
            col_widths: [(2u32, 90.0), (0, 120.0), (1, 75.5)].into_iter().collect(),
            row_heights: [(4u32, 30.0)].into_iter().collect(),
            show_title: true,
            show_column_headers: false,
            show_row_headers: true,
        }
    }

    fn pivot_on(destination_sheet: &str, name: &str) -> persistence::SavedPivotDefinition {
        persistence::SavedPivotDefinition {
            id: new_entity(),
            source_type: "grid".to_string(),
            source_sheet_index: Some(1),
            definition: serde_json::json!({ "name": name, "destination_sheet": destination_sheet }),
        }
    }

    fn timeline(name: &str, sheet_id: SheetId, pivot: EntityId) -> persistence::SavedTimelineSlicer {
        persistence::SavedTimelineSlicer {
            id: new_entity(),
            name: name.to_string(),
            header_text: None,
            sheet_id,
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 120.0,
            source_type: persistence::SavedTimelineSourceType::Pivot,
            source_id: pivot,
            field_name: "OrderDate".to_string(),
            level: persistence::SavedTimelineLevel::Quarters,
            selection_start: Some("2026-01-01".to_string()),
            selection_end: None,
            show_header: true,
            show_level_selector: true,
            show_scrollbar: false,
            style_preset: "TimelineStyleLight1".to_string(),
            connected_pivot_ids: Vec::new(),
        }
    }

    fn slicer(
        name: &str,
        sheet_id: SheetId,
        source_type: persistence::SavedSlicerSourceType,
        source: EntityId,
    ) -> persistence::SavedSlicer {
        persistence::SavedSlicer {
            id: new_entity(),
            name: name.to_string(),
            header_text: None,
            sheet_id,
            x: 0.0,
            y: 0.0,
            width: 180.0,
            height: 220.0,
            source_type,
            cache_source_id: source,
            field_name: "Region".to_string(),
            selected_items: None,
            show_header: true,
            columns: 1,
            style_preset: "SlicerStyleLight1".to_string(),
            selection_mode: persistence::SavedSlicerSelectionMode::default(),
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: persistence::SavedSlicerArrangement::default(),
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 2.0,
            computed_properties: Vec::new(),
            connected_sources: Vec::new(),
            filter_level: 1,
        }
    }

    fn table_on(name: &str, sheet_id: SheetId) -> SavedTable {
        SavedTable {
            id: new_entity(),
            name: name.to_string(),
            sheet_id,
            start_row: 0,
            start_col: 0,
            end_row: 9,
            end_col: 2,
            columns: Vec::new(),
            style_options: persistence::SavedTableStyleOptions {
                banded_rows: true,
                banded_columns: false,
                header_row: true,
                total_row: false,
                first_column: false,
                last_column: false,
                show_filter_button: true,
            },
            style_name: "TableStyleMedium2".to_string(),
        }
    }

    /// A chart whose `spec_json` is the ChartDefinition ENVELOPE, as the
    /// frontend store writes it.
    fn chart_with(sheet_id: SheetId, name: &str, spec: serde_json::Value) -> SavedChart {
        SavedChart {
            id: new_entity(),
            sheet_id,
            spec_json: serde_json::json!({ "chartId": 1, "name": name, "sheetIndex": 0, "spec": spec })
                .to_string(),
        }
    }

    fn range_ref(sheet_index: usize, sheet_id: Option<SheetId>) -> serde_json::Value {
        let mut r = serde_json::json!({
            "sheetIndex": sheet_index, "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 1
        });
        if let Some(id) = sheet_id {
            r["sheetId"] = serde_json::Value::String(id.to_string());
        }
        r
    }

    #[test]
    fn chart_source_warnings_computes_without_publishing() {
        // The preview contract, chart edition: the SAME warnings a publish would
        // emit, from the carrier alone.
        let mut wb = make_test_workbook(); // "Dashboard"(0), "Data"(1)
        let dash = wb.sheets[0].id;
        let data = wb.sheets[1].id;
        wb.named_ranges = vec![
            persistence::SavedNamedRange {
                name: "SalesData".to_string(),
                refers_to: "=Data!$A$1:$B$5".to_string(),
                sheet_id: None,
                comment: None,
                folder: None,
            },
            persistence::SavedNamedRange {
                name: "Local".to_string(),
                refers_to: "=Dashboard!$A$1".to_string(),
                sheet_id: None,
                comment: None,
                folder: None,
            },
        ];
        wb.charts = vec![
            // By stable id AND (in a layer) by index, both on "Data": ONE warning.
            chart_with(
                dash,
                "ById",
                serde_json::json!({
                    "data": range_ref(1, Some(data)),
                    "layers": [ { "data": range_ref(1, None) } ]
                }),
            ),
            chart_with(dash, "ByIndex", serde_json::json!({ "data": range_ref(1, None) })),
            chart_with(
                dash,
                "ByName",
                serde_json::json!({ "transform": [ { "type": "lookup", "from": "'Data'!A1:B9" } ] }),
            ),
            chart_with(dash, "ByNamedRange", serde_json::json!({ "data": "SalesData" })),
            chart_with(dash, "Unqualified", serde_json::json!({ "data": "A1:B3" })),
            // Reads only the published sheet (by id, and via a name): silent.
            chart_with(
                dash,
                "OnPublished",
                serde_json::json!({
                    "data": range_ref(0, Some(dash)),
                    "layers": [ { "data": "Local" } ]
                }),
            ),
            // A chart that does not ship is never warned about.
            chart_with(data, "OnUnpublished", serde_json::json!({ "data": "Nowhere!A1" })),
            // A sheet this workbook does not have is the author's problem already.
            chart_with(dash, "GhostSheet", serde_json::json!({ "data": "Ghost!A1:A2" })),
        ];

        let warnings = chart_source_warnings(&wb, &[0]);
        assert_eq!(warnings.len(), 5, "warnings: {warnings:#?}");
        let joined = warnings.join("\n");
        assert_eq!(
            warnings.iter().filter(|w| w.contains("\"ById\"")).count(),
            1,
            "one chart, one missing sheet, one warning: {joined}"
        );
        for chart in ["ById", "ByIndex", "ByName", "ByNamedRange"] {
            let line = warnings
                .iter()
                .find(|w| w.contains(&format!("\"{chart}\"")))
                .unwrap_or_else(|| panic!("{chart} must warn: {joined}"));
            assert!(line.contains("on sheet \"Dashboard\""), "{line}");
            assert!(line.contains("from sheet \"Data\""), "{line}");
            assert!(line.contains("source sheet no longer exists"), "{line}");
        }
        assert!(joined.contains("by name"), "{joined}");
        assert!(joined.contains("named range \"SalesData\""), "{joined}");
        assert!(
            joined.contains("\"Unqualified\"") && joined.contains("without a sheet prefix"),
            "{joined}"
        );
        for silent in ["OnPublished", "OnUnpublished", "GhostSheet"] {
            assert!(!joined.contains(&format!("\"{silent}\"")), "{silent}: {joined}");
        }

        // Covering selection: only the selection-independent prefix-less one stays.
        let covered = chart_source_warnings(&wb, &[0, 1]);
        assert_eq!(covered.len(), 1, "{covered:#?}");
        assert!(covered[0].contains("\"Unqualified\""), "{covered:?}");
        // Out-of-range indices are tolerated, as in the dropdown twin.
        assert_eq!(chart_source_warnings(&wb, &[0, 99]).len(), 5);
    }

    #[test]
    fn publish_warns_about_chart_sources_and_stamps_index_only_refs() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        let dash = wb.sheets[0].id;
        let data = wb.sheets[1].id;
        let indexed = chart_with(dash, "Indexed", serde_json::json!({ "data": range_ref(1, None) }));
        let plain = SavedChart {
            id: new_entity(),
            sheet_id: dash,
            spec_json: "{\"kind\":\"bar\"}".to_string(),
        };
        wb.charts = vec![indexed.clone(), plain.clone()];

        let result = publish(&reg, &object_request(&wb, "stamped", vec![0]), prof.path()).unwrap();
        assert_eq!(result.charts_published, 2);
        assert_eq!(result.warnings.len(), 1, "{:#?}", result.warnings);
        assert!(result.warnings[0].contains("\"Indexed\""), "{:?}", result.warnings);

        let bytes = reg.read_artifact("stamped", "1.0.0", "charts.json").unwrap().unwrap();
        let shipped: Vec<SavedChart> = serde_json::from_slice(&bytes).unwrap();
        let shipped_indexed = shipped.iter().find(|c| c.id == indexed.id).unwrap();
        let v: serde_json::Value = serde_json::from_str(&shipped_indexed.spec_json).unwrap();
        assert_eq!(
            v["spec"]["data"]["sheetId"],
            data.to_string(),
            "an index-only ref must leave the publisher stamped with its sheet's id"
        );
        assert_eq!(v["spec"]["data"]["sheetIndex"], 1);
        let shipped_plain = shipped.iter().find(|c| c.id == plain.id).unwrap();
        assert_eq!(shipped_plain.spec_json, plain.spec_json, "nothing to stamp keeps its bytes");
    }

    #[test]
    fn object_source_warnings_computes_without_publishing() {
        let mut wb = make_test_workbook(); // "Dashboard"(0), "Data"(1)
        let dash = wb.sheets[0].id;
        let data = wb.sheets[1].id;
        let orders = table_on("Orders", data);
        let revenue = pivot_on("Data", "Revenue by Month");
        let local = pivot_on("dashboard", "Local Pivot"); // case differs on purpose
        wb.tables = vec![orders.clone()];
        wb.pivot_definitions = vec![revenue.clone(), local.clone()];

        let mut connected = slicer(
            "Connected",
            dash,
            persistence::SavedSlicerSourceType::Pivot,
            local.id,
        );
        connected.connected_sources = vec![persistence::SavedSlicerConnection {
            source_type: persistence::SavedSlicerSourceType::Pivot,
            source_id: revenue.id,
        }];
        wb.slicers = vec![
            slicer("ByTable", dash, persistence::SavedSlicerSourceType::Table, orders.id),
            slicer("ByPivot", dash, persistence::SavedSlicerSourceType::Pivot, revenue.id),
            slicer("Local", dash, persistence::SavedSlicerSourceType::Pivot, local.id),
            slicer("Bi", dash, persistence::SavedSlicerSourceType::BiConnection, new_entity()),
            slicer("OffSheet", data, persistence::SavedSlicerSourceType::Table, orders.id),
            connected,
        ];
        wb.timeline_slicers = vec![
            timeline("Dates", dash, revenue.id),
            timeline("LocalDates", dash, local.id),
            timeline("Orphan", dash, new_entity()),
            timeline("OffSheetDates", data, revenue.id),
        ];

        let warnings = object_source_warnings(&wb, &[0]);
        let joined = warnings.join("\n");
        assert_eq!(warnings.len(), 5, "warnings: {warnings:#?}");
        let line = |name: &str| {
            warnings
                .iter()
                .find(|w| w.contains(&format!("\"{name}\"")))
                .unwrap_or_else(|| panic!("{name} must warn: {joined}"))
                .clone()
        };
        let by_table = line("ByTable");
        assert!(by_table.contains("table \"Orders\"") && by_table.contains("sheet \"Data\""), "{by_table}");
        assert!(by_table.contains("connected to nothing"), "{by_table}");
        assert!(line("ByPivot").contains("pivot table \"Revenue by Month\""), "{joined}");
        assert!(line("Connected").contains("\"Revenue by Month\""), "a report connection counts too: {joined}");
        let dates = line("Dates");
        assert!(dates.starts_with("Timeline") && dates.contains("sheet \"Data\""), "{dates}");
        assert!(line("Orphan").contains("left out of the published application"), "{joined}");
        for silent in ["\"Local\"", "\"Bi\"", "\"OffSheet\"", "\"LocalDates\"", "\"OffSheetDates\""] {
            assert!(!joined.contains(silent), "{silent}: {joined}");
        }

        // Covering selection: only the timeline whose pivot is gone remains.
        let covered = object_source_warnings(&wb, &[0, 1]);
        assert_eq!(covered.len(), 1, "{covered:#?}");
        assert!(covered[0].contains("\"Orphan\""), "{covered:?}");
    }

    /// The host PRUNES a pivot whose sheet or source sheet is not published
    /// before core sees the carrier, so core alone cannot tell "left behind"
    /// from "never existed": the slicer that filters it went silent and the
    /// timeline blamed a pivot "this workbook no longer has". Given the host's
    /// list, each line names the pivot and the sheet that kept it home.
    ///
    /// SABOTAGE: drop the `left_behind` branch from the slicer arm -- the
    /// slicer goes silent again and the count assertion fails.
    #[test]
    fn object_warnings_name_the_sheet_that_kept_a_pruned_pivot_home() {
        let mut wb = make_test_workbook(); // "Dashboard"(0), "Data"(1)
        let dash = wb.sheets[0].id;
        let carried = pivot_on("Dashboard", "Carried");
        let pruned = new_entity();
        let second_pruned = new_entity();
        wb.pivot_definitions = vec![carried.clone()]; // `pruned` was taken out by the host
        wb.slicers = vec![slicer(
            "ByPrunedPivot",
            dash,
            persistence::SavedSlicerSourceType::Pivot,
            pruned,
        )];
        let mut mixed = timeline("Mixed", dash, carried.id);
        mixed.connected_pivot_ids = vec![carried.id, second_pruned, second_pruned];
        wb.timeline_slicers = vec![timeline("Dates", dash, pruned), mixed];
        let unpublished = vec![
            UnpublishedPivot {
                id: pruned,
                name: "Revenue".to_string(),
                missing_sheet: "Sales Data".to_string(),
            },
            UnpublishedPivot {
                id: second_pruned,
                name: "Costs".to_string(),
                missing_sheet: "Ledger".to_string(),
            },
        ];

        // Blind (what core alone can say): the slicer is silent, the timeline
        // blames a pivot the workbook "no longer has".
        let blind = object_source_warnings(&wb, &[0]);
        assert_eq!(blind.len(), 1, "{blind:#?}");
        assert!(blind[0].contains("no longer has"), "{blind:?}");

        let named = object_source_warnings_with(&wb, &[0], &unpublished);
        let joined = named.join("\n");
        assert_eq!(named.len(), 3, "{named:#?}");
        let slicer_line = named.iter().find(|w| w.contains("\"ByPrunedPivot\"")).expect(&joined);
        assert!(
            slicer_line.contains("pivot table \"Revenue\"")
                && slicer_line.contains("sheet \"Sales Data\" is not in the published selection")
                && slicer_line.contains("connected to nothing"),
            "{slicer_line}"
        );
        let dates = named.iter().find(|w| w.contains("\"Dates\"")).expect(&joined);
        assert!(!dates.contains("no longer has"), "the false reason is gone: {dates}");
        assert!(
            dates.contains("\"Revenue\"") && dates.contains("\"Sales Data\"") && dates.contains("left out"),
            "{dates}"
        );
        let mixed_line = named.iter().find(|w| w.contains("\"Mixed\"")).expect(&joined);
        assert!(
            mixed_line.contains("\"Costs\"") && mixed_line.contains("\"Ledger\""),
            "a pruned CONNECTED pivot is named once: {mixed_line}"
        );

        // An empty list IS the blind function.
        assert_eq!(object_source_warnings_with(&wb, &[0], &[]), blind);
    }

    /// A PIVOT chart travels only if its pivot does. On the pruned carrier a
    /// pivot that is not among `pivot_definitions` will not travel, and the
    /// chart would arrive with no data -- said once per chart, by name when the
    /// host says which sheet kept the pivot home.
    ///
    /// SABOTAGE: make the `ChartSource::Pivot` arm `continue` without a
    /// warning -- the "Stranded" assertion fails.
    #[test]
    fn a_pivot_chart_whose_pivot_does_not_travel_warns() {
        let mut wb = make_test_workbook();
        let dash = wb.sheets[0].id;
        let carried = pivot_on("Dashboard", "Carried");
        let pruned = new_entity();
        wb.pivot_definitions = vec![carried.clone()];
        let pivot_source = |id: EntityId| serde_json::json!({ "type": "pivot", "pivotId": id.to_string() });
        wb.charts = vec![
            chart_with(dash, "Travels", serde_json::json!({ "data": pivot_source(carried.id) })),
            chart_with(
                dash,
                "Stranded",
                serde_json::json!({
                    "data": pivot_source(pruned),
                    "layers": [ { "data": pivot_source(pruned) } ]
                }),
            ),
        ];

        let blind = chart_source_warnings(&wb, &[0]);
        assert_eq!(blind.len(), 1, "{blind:#?}");
        assert!(blind[0].contains("\"Stranded\"") && blind[0].contains("no data"), "{blind:?}");

        let named = chart_source_warnings_with(
            &wb,
            &[0],
            &[UnpublishedPivot {
                id: pruned,
                name: "Revenue".to_string(),
                missing_sheet: "Data".to_string(),
            }],
        );
        assert_eq!(named.len(), 1, "{named:#?}");
        assert!(
            named[0].contains("pivot table \"Revenue\"")
                && named[0].contains("sheet \"Data\" is not in the published selection"),
            "{named:?}"
        );
    }

    /// An index-only ref past the last sheet names NO sheet. It used to ship
    /// unstamped and silent, and the subscriber's load migration bound it to
    /// whatever sheet of theirs sat at that position. It now leaves stamped
    /// with an id no sheet answers, and the author is told the chart will
    /// arrive broken -- both before stamping (`Index`) and after (the id).
    ///
    /// SABOTAGE: restore `(workbook.sheets.get(*i), String::new())` for the
    /// `Index` arm -- the unstamped chart goes silent.
    #[test]
    fn a_chart_source_naming_no_sheet_by_position_warns_and_ships_unresolvable() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let mut wb = make_test_workbook(); // two sheets
        let dash = wb.sheets[0].id;
        let lost = chart_with(dash, "Lost", serde_json::json!({ "data": range_ref(7, None) }));
        let already = chart_with(
            dash,
            "AlreadyStamped",
            serde_json::json!({
                "data": range_ref(7, Some(crate::chart_refs::UNRESOLVABLE_SHEET_ID)),
                "layers": [ { "data": range_ref(9, None) } ]
            }),
        );
        wb.charts = vec![lost.clone(), already];

        let warnings = chart_source_warnings(&wb, &[0, 1]);
        assert_eq!(warnings.len(), 2, "one line per chart: {warnings:#?}");
        for w in &warnings {
            assert!(w.contains("names no sheet") && w.contains("arrive broken"), "{w}");
        }

        let result = publish(&reg, &object_request(&wb, "lost", vec![0, 1]), prof.path()).unwrap();
        assert_eq!(result.warnings.len(), 2, "{:#?}", result.warnings);
        let bytes = reg.read_artifact("lost", "1.0.0", "charts.json").unwrap().unwrap();
        let shipped: Vec<SavedChart> = serde_json::from_slice(&bytes).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&shipped.iter().find(|c| c.id == lost.id).unwrap().spec_json).unwrap();
        assert_eq!(
            v["spec"]["data"]["sheetId"],
            crate::chart_refs::UNRESOLVABLE_SHEET_ID.to_string(),
            "never id-less: the subscriber must not stamp it from ITS sheet 7"
        );
    }

    #[test]
    fn publish_writes_floating_ranges_and_timelines_for_published_sheets_only() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let mut wb = make_test_workbook(); // "Dashboard"(0), "Data"(1)
        let mut float1 = persistence::Sheet::new("Float1".to_string());
        float1.visibility = "object".to_string();
        let mut float2 = persistence::Sheet::new("Float2".to_string());
        float2.visibility = "object".to_string();
        wb.sheets.push(float1); // 2
        wb.sheets.push(float2); // 3
        let dash = wb.sheets[0].id;
        let data = wb.sheets[1].id;
        let f1 = wb.sheets[2].id;
        let f2 = wb.sheets[3].id;

        let carried = floating_range(dash, f1);
        wb.floating_ranges = vec![
            floating_range(dash, f2), // backing sheet not published: stays home
            carried.clone(),
            floating_range(data, f1), // host not published: stays home
        ];
        let pivot = pivot_on("Dashboard", "P");
        wb.pivot_definitions = vec![pivot.clone()];
        let kept = timeline("Carried", dash, pivot.id);
        wb.timeline_slicers = vec![
            timeline("NoPivot", dash, new_entity()),
            kept.clone(),
            timeline("OffSheet", data, pivot.id),
        ];

        let result =
            publish(&reg, &object_request(&wb, "objects", vec![0, 2]), prof.path()).unwrap();
        assert_eq!(result.floating_ranges_published, 1);
        assert_eq!(result.timeline_slicers_published, 1);
        assert!(
            result.warnings.iter().any(|w| w.contains("\"NoPivot\"")),
            "a timeline left out of the publish must say so: {:#?}",
            result.warnings
        );

        let ver = reg.get_version_manifest("objects", "1.0.0").unwrap();
        assert!(ver.artifact_checksums.contains_key("floating_ranges.json"));
        assert!(ver.artifact_checksums.contains_key("timeline_slicers.json"));

        let fr_bytes = reg.read_artifact("objects", "1.0.0", "floating_ranges.json").unwrap().unwrap();
        let rows: Vec<persistence::SavedFloatingRange> = serde_json::from_slice(&fr_bytes).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, carried.id);
        assert_eq!(rows[0].host_sheet_id, dash, "application ids, unremapped");
        assert_eq!(rows[0].backing_sheet_id, f1);
        assert_eq!(rows[0].col_widths, carried.col_widths);
        assert!(!rows[0].show_column_headers);
        // The width map serializes in KEY order, whatever the HashMap's order.
        let text = String::from_utf8(fr_bytes).unwrap();
        let at = |needle: &str| text.find(needle).unwrap_or_else(|| panic!("{needle} in {text}"));
        assert!(at("\"0\": 120.0") < at("\"1\": 75.5") && at("\"1\": 75.5") < at("\"2\": 90.0"), "{text}");

        let tl_bytes = reg.read_artifact("objects", "1.0.0", "timeline_slicers.json").unwrap().unwrap();
        let timelines: Vec<persistence::SavedTimelineSlicer> = serde_json::from_slice(&tl_bytes).unwrap();
        assert_eq!(timelines.len(), 1);
        assert_eq!(timelines[0].id, kept.id);
        assert_eq!(timelines[0].source_id, pivot.id);
        assert_eq!(timelines[0].level, persistence::SavedTimelineLevel::Quarters);
    }

    #[test]
    fn a_workbook_without_canvas_objects_writes_neither_artifact() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = make_test_workbook();
        let result = publish(&reg, &object_request(&wb, "plain", vec![0, 1]), prof.path()).unwrap();
        assert_eq!(result.floating_ranges_published, 0);
        assert_eq!(result.timeline_slicers_published, 0);
        assert!(reg.read_artifact("plain", "1.0.0", "floating_ranges.json").unwrap().is_none());
        assert!(reg.read_artifact("plain", "1.0.0", "timeline_slicers.json").unwrap().is_none());
    }

    #[test]
    fn floating_ranges_and_timelines_on_published_sheets_are_wave_content() {
        let mut wb = make_test_workbook();
        let dash = wb.sheets[0].id;
        let data = wb.sheets[1].id;
        assert!(!carries_wave_content(&object_request(&wb, "w", vec![0, 1])), "precondition");

        wb.floating_ranges = vec![floating_range(dash, data)];
        assert!(
            carries_wave_content(&object_request(&wb, "w", vec![0, 1])),
            "a floating range hosted on a published sheet needs a minimum app version"
        );
        assert!(
            !carries_wave_content(&object_request(&wb, "w", vec![1])),
            "one hosted on a sheet this publish leaves home does not"
        );
        assert!(
            !carries_wave_content(&object_request(&wb, "w", vec![0])),
            "nor one whose BACKING sheet stays home: the writer does not write that row, \
             so it must not stamp a minimum version for it either"
        );

        // A timeline stamps only when the writer WRITES it: on a published sheet
        // AND filtering a pivot the carrier holds.
        let mut wb2 = make_test_workbook();
        let dash2 = wb2.sheets[0].id;
        let pivot = pivot_on("Dashboard", "P");
        wb2.timeline_slicers = vec![timeline("Dates", dash2, pivot.id)];
        assert!(
            !carries_wave_content(&object_request(&wb2, "w", vec![0])),
            "a timeline whose pivot does not travel is not written, so it is not wave content"
        );
        wb2.pivot_definitions = vec![pivot];
        assert!(carries_wave_content(&object_request(&wb2, "w", vec![0])));
        assert!(!carries_wave_content(&object_request(&wb2, "w", vec![1])));
    }

    /// ONE rule decides whether a floating range or a timeline travels, and the
    /// writer, the version stamp and (host-side) the report all ask it. The
    /// stamp's own copy checked the host only / the sheet only, and stamped a
    /// minimum version for rows the writer dropped.
    #[test]
    fn the_writer_and_the_stamp_agree_on_what_travels() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let mut wb = make_test_workbook(); // "Dashboard"(0), "Data"(1)
        let mut float = persistence::Sheet::new("Float".to_string());
        float.visibility = "object".to_string();
        wb.sheets.push(float); // 2
        let (dash, backing) = (wb.sheets[0].id, wb.sheets[2].id);
        wb.floating_ranges = vec![floating_range(dash, backing)];
        wb.timeline_slicers = vec![timeline("NoPivot", dash, new_entity())];

        for (package, indices) in [("half", vec![0usize]), ("whole", vec![0, 2])] {
            let request = object_request(&wb, package, indices);
            let stamps = carries_wave_content(&request);
            let result = publish(&reg, &request, prof.path()).unwrap();
            let writes = result.floating_ranges_published + result.timeline_slicers_published > 0;
            assert_eq!(stamps, writes, "{package}: the stamp must follow what the writer wrote");
        }
    }

    #[test]
    fn the_manifest_names_a_canvas_and_says_nothing_for_a_worksheet() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let mut wb = make_test_workbook();
        wb.sheets[0].kind = persistence::SheetKind::new_canvas();

        publish(&reg, &object_request(&wb, "kinds", vec![0, 1]), prof.path()).unwrap();

        let ver = reg.get_version_manifest("kinds", "1.0.0").unwrap();
        assert_eq!(ver.sheets[0].kind, "canvas");
        assert_eq!(ver.sheets[1].kind, "");
        // The signed BYTES: a worksheet entry carries no `kind` key at all, so a
        // worksheet-only manifest is byte-identical to one from before the field.
        let raw = reg
            .read_artifact("kinds", "1.0.0", crate::integrity::VERSION_MANIFEST_FILE)
            .unwrap()
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(v["sheets"][0]["kind"], "canvas");
        assert!(v["sheets"][1].get("kind").is_none(), "{}", v["sheets"][1]);
        assert!(ver.sheets[0].extra.is_empty(), "kind must not spill into `extra`");
    }
}
