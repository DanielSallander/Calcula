//! FILENAME: core/calp/src/diff.rs
//! PURPOSE: What changed between two versions of an application — or between a
//! working copy and the version it was authored against.
//! CONTEXT: The workspace has always kept every version, but nothing could say
//! what distinguished them. The refresh preview was the closest thing, and it
//! reported `cells_changed: 0` unconditionally with a comment saying a real
//! diff would be expensive — so the confirmation dialog asked the user to
//! approve a number nobody had computed.
//!
//! # How it works, in three layers
//!
//! **L1 — the checksum map.** Every version manifest carries a signed
//! `rel_path -> sha256` map covering every artifact. Set-differencing two of
//! them gives added / removed / possibly-changed paths for free, with nothing
//! read and nothing parsed. For two published versions those maps are already
//! signed, so L1 costs two manifest reads.
//!
//! **L2 — resolve paths to named objects.** A path is routed by shape to a
//! domain (a chart, a script, a sheet's styles, a model) and the changed
//! artifacts are parsed and compared SEMANTICALLY. That second comparison is
//! not redundant: an L1 difference is a CANDIDATE, never a finding. Two
//! publishes of identical content used to produce different bytes for
//! `metadata.json` (see `tests/artifact_determinism.rs`), and a diff that
//! trusted hashes alone would have reported changes nobody made. Determinism is
//! now enforced, and this layer is the belt to that braces: an entry survives
//! only if the parsed forms actually differ.
//!
//! **L3 — cells.** For a changed `sheets/{id}/data.json`, walk the union of the
//! two sparse maps and classify each cell as added, removed or modified, noting
//! separately how many of those were FORMULA changes. Counts are exact whenever
//! the artifact was parsed at all; only the reported sample is capped.
//!
//! # What this module does NOT do
//!
//! It does not verify anything. Signature, TOFU and checksum verification are
//! the CALLER's job, exactly as with the inspector — the app layer runs the
//! same `open_verified` choke point for both sides before diffing them. A
//! missing artifact here is an error rather than a skip, because the caller has
//! already vouched for the set.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::error::CalpError;
use crate::manifest::VersionManifest;
use crate::transport::WorkspaceTransport;

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

/// One side of a comparison: a published version, or an in-memory artifact set.
///
/// The in-memory arm is what lets the push dialog show "what your push changes"
/// without publishing anything: the app runs the REAL publish pipeline against
/// an in-memory transport and hands the result here, so the preview can never
/// describe an application different from the one a push would write.
pub enum DiffSide<'a> {
    Published {
        transport: &'a dyn WorkspaceTransport,
        package: &'a str,
        version: &'a str,
        manifest: &'a VersionManifest,
    },
    InMemory {
        manifest: &'a VersionManifest,
        /// `rel_path -> bytes`.
        artifacts: &'a BTreeMap<String, Vec<u8>>,
    },
    /// A published version whose every READ is checked against its signed
    /// checksum map (the `SignedBase` posture, `held_button_code.rs` in the app).
    ///
    /// For a caller that verified the manifest's SIGNATURE but did not walk
    /// every artifact up front -- the promotion's code summary reads a handful
    /// of code artifacts out of an application that may hold megabytes of
    /// sheets, so it checks what it reads instead of hashing what it does not.
    ///
    /// A path the signed map does not list reads as ABSENT (`Ok(None)`): it is
    /// not part of the version, and bytes a loose file on the share might serve
    /// for it are never returned. A listed path that cannot be read, or whose
    /// bytes do not hash to the signed value, is an ERROR -- never a skip.
    PublishedChecked {
        transport: &'a dyn WorkspaceTransport,
        package: &'a str,
        version: &'a str,
        manifest: &'a VersionManifest,
    },
}

impl<'a> DiffSide<'a> {
    pub fn manifest(&self) -> &VersionManifest {
        match self {
            DiffSide::Published { manifest, .. } => manifest,
            DiffSide::InMemory { manifest, .. } => manifest,
            DiffSide::PublishedChecked { manifest, .. } => manifest,
        }
    }

    /// The signed checksum map for a published side; a computed one in memory.
    pub(crate) fn checksums(&self) -> BTreeMap<String, String> {
        match self {
            DiffSide::Published { manifest, .. } => manifest.artifact_checksums.clone(),
            DiffSide::InMemory { artifacts, .. } => artifacts
                .iter()
                .map(|(rel, bytes)| (rel.clone(), crate::integrity::sha256_hex(bytes)))
                .collect(),
            DiffSide::PublishedChecked { manifest, .. } => manifest.artifact_checksums.clone(),
        }
    }

    pub(crate) fn read(&self, rel: &str) -> Result<Option<Vec<u8>>, CalpError> {
        match self {
            DiffSide::Published { transport, package, version, .. } => {
                transport.read_artifact(package, version, rel)
            }
            DiffSide::InMemory { artifacts, .. } => Ok(artifacts.get(rel).cloned()),
            DiffSide::PublishedChecked { transport, package, version, manifest } => {
                let Some(expected) = manifest.artifact_checksums.get(rel) else {
                    return Ok(None);
                };
                let bytes = transport.read_artifact(package, version, rel)?.ok_or_else(|| {
                    CalpError::MissingArtifact {
                        package: (*package).to_string(),
                        version: (*version).to_string(),
                        file: rel.to_string(),
                    }
                })?;
                if crate::integrity::sha256_hex(&bytes) != *expected {
                    return Err(CalpError::ChecksumMismatch {
                        package: (*package).to_string(),
                        version: (*version).to_string(),
                        file: rel.to_string(),
                    });
                }
                Ok(Some(bytes))
            }
        }
    }

    pub(crate) fn label(&self) -> String {
        match self {
            DiffSide::Published { version, .. } => (*version).to_string(),
            DiffSide::InMemory { .. } => "working copy".to_string(),
            DiffSide::PublishedChecked { version, .. } => (*version).to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// Budgets, so a diff of a large application stays a bounded operation.
///
/// Every limit has a matching `*_truncated` / `counts_exact` flag in the
/// output. Silently reporting a truncated result as a complete one is how a
/// diff becomes a lie, and this whole module exists because a diff was lying.
#[derive(Debug, Clone)]
pub struct DiffOptions {
    /// Cells reported per sheet in the summary. Counts stay exact.
    pub sample_cells_per_sheet: usize,
    /// Cap on a `before`/`after` source or expression string.
    pub max_source_bytes: usize,
    /// Per-side cap on a sheet data artifact worth parsing.
    pub max_sheet_data_bytes: usize,
    /// Cap on how many changed sheet data artifacts are parsed at all.
    pub max_parsed_sheet_artifacts: usize,
    /// Map a working copy's LOCAL sheet ids onto the application's ids.
    ///
    /// Needed when the working copy came from a `pull` (which mints fresh local
    /// ids) rather than a `checkout` (which preserves them): without it every
    /// sheet reads as removed-and-added rather than modified.
    pub sheet_id_map: HashMap<String, String>,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            sample_cells_per_sheet: 50,
            max_source_bytes: 64 * 1024,
            max_sheet_data_bytes: 8 * 1024 * 1024,
            max_parsed_sheet_artifacts: 64,
            sheet_id_map: HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDiff {
    pub package_name: String,
    pub from_version: String,
    pub to_version: String,
    pub artifacts: ArtifactDiffSummary,
    pub sheets: Vec<SheetDiffSummary>,
    pub objects: Vec<ObjectChange>,
    pub manifest_changes: Vec<ManifestFieldChange>,
    pub totals: DiffTotals,
}

/// The raw artifact-level picture (L1, confirmed by L2).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDiffSummary {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    /// Paths whose hash differs AND whose parsed content differs.
    pub changed: Vec<String>,
    /// Paths whose hash differed but whose content did not — kept as a count
    /// rather than dropped, because a nonzero value means serialization has
    /// become order-dependent again.
    pub spurious_hash_changes: usize,
    pub unchanged_count: usize,
}

/// One changed thing, named the way a person would name it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectChange {
    /// A closed-ish vocabulary: "chart", "table", "objectScript", "moduleScript",
    /// "notebook", "namedRange", "modelMeasure", "modelTable", "control",
    /// "paneControl", "slicer", "timelineSlicer", "floatingRange",
    /// "ribbonFilter", "pivot", "pivotLayout", "customObject", "media",
    /// "conditionalFormat", "dataValidation", "comment", "scenario", "outline",
    /// "cellBehavior", "sparkline", "theme", "extensionData", "writebackRegion",
    /// "modelWriteback", or "artifact" for anything a future version adds that
    /// this build does not recognise.
    pub domain: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_name: Option<String>,
    /// "added" | "removed" | "modified"
    pub change: String,
    /// A one-line human summary.
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default)]
    pub before_truncated: bool,
    #[serde(default)]
    pub after_truncated: bool,
    /// Capabilities a script gained. An expansion is the one script change a
    /// consumer must be shown, so it is a field rather than prose in `detail`.
    /// Read from the two versions' SIGNED manifests (an object script's
    /// `PublishedObjectScript.capabilities`, the ceiling a subscriber's pull
    /// applies), never from the artifact (BUG-0274).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_capabilities: Vec<String>,
    /// Capabilities a script no longer has, from the same source.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetDiffSummary {
    /// The APPLICATION sheet id (after any working-copy remap).
    pub sheet_id: String,
    pub name: String,
    /// "added" | "removed" | "modified" | "renamed"
    pub change: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
    pub cells_added: usize,
    pub cells_removed: usize,
    pub cells_modified: usize,
    /// The subset of the above where the FORMULA differs, not just the value.
    pub formula_changes: usize,
    /// False when a budget stopped the artifact being parsed — the counts above
    /// are then floors, not totals.
    pub counts_exact: bool,
    pub style_changed_cells: usize,
    pub styles_table_changed: bool,
    pub layout_changed: bool,
    pub metadata_changed: bool,
    pub sample: Vec<CellDiff>,
    pub sample_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDiff {
    pub a1: String,
    pub row: u32,
    pub col: u32,
    /// "added" | "removed" | "modified"
    pub change: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<CellSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<CellSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellSnapshot {
    pub display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    pub cell_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFieldChange {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffTotals {
    pub objects_added: usize,
    pub objects_removed: usize,
    pub objects_modified: usize,
    pub sheets_changed: usize,
    pub cells_changed: usize,
    /// False when any sheet's counts were capped.
    pub cells_changed_exact: bool,
}

/// The drill-down payload: every changed cell of one sheet, up to a cap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetCellDiff {
    pub sheet_id: String,
    pub name: String,
    pub changes: Vec<CellDiff>,
    pub total_changes: usize,
    pub truncated: bool,
    pub cells_added: usize,
    pub cells_removed: usize,
    pub cells_modified: usize,
    pub formula_changes: usize,
}

/// Counts only — the fast path shared with the refresh preview.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CellChangeCounts {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
    pub formula_changes: usize,
}

impl CellChangeCounts {
    pub fn total(&self) -> usize {
        self.added + self.removed + self.modified
    }
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

/// Compare two sides of an application.
pub fn diff_sides(
    from: &DiffSide,
    to: &DiffSide,
    opts: &DiffOptions,
) -> Result<VersionDiff, CalpError> {
    let from_sums = from.checksums();
    let to_sums = remap_sheet_paths(&to.checksums(), &opts.sheet_id_map);

    // ---- L1: set-difference the two maps -------------------------------
    let mut artifacts = ArtifactDiffSummary::default();
    let mut candidates: Vec<String> = Vec::new();
    for (rel, hash) in &from_sums {
        match to_sums.get(rel) {
            None => artifacts.removed.push(rel.clone()),
            Some(other) if other == hash => artifacts.unchanged_count += 1,
            Some(_) => candidates.push(rel.clone()),
        }
    }
    for rel in to_sums.keys() {
        if !from_sums.contains_key(rel) {
            artifacts.added.push(rel.clone());
        }
    }

    // ---- L2/L3: resolve to objects and cells ----------------------------
    let mut ctx = DiffContext {
        from,
        to,
        opts,
        sheet_id_map: &opts.sheet_id_map,
        reverse_sheet_ids: opts
            .sheet_id_map
            .iter()
            .map(|(local, package)| (package.clone(), local.clone()))
            .collect(),
        sheets: BTreeMap::new(),
        objects: Vec::new(),
        parsed_sheet_artifacts: 0,
        spurious: 0,
    };

    for rel in &artifacts.added {
        ctx.classify(rel, Presence::Added)?;
    }
    for rel in &artifacts.removed {
        ctx.classify(rel, Presence::Removed)?;
    }
    let mut confirmed_changed = Vec::new();
    for rel in &candidates {
        if ctx.classify(rel, Presence::Changed)? {
            confirmed_changed.push(rel.clone());
        }
    }
    artifacts.changed = confirmed_changed;
    artifacts.spurious_hash_changes = ctx.spurious;

    let mut sheets: Vec<SheetDiffSummary> = ctx.sheets.into_values().collect();
    let mut objects = ctx.objects;

    // Sheet names and add/remove come from the manifests, which know about
    // sheets an artifact diff cannot see — a sheet whose content is byte-equal
    // but whose NAME changed has no changed artifact at all.
    apply_manifest_sheet_facts(from, to, &opts.sheet_id_map, &mut sheets);

    // Manifest-level facts that are not artifacts: writeback declarations,
    // publisher identity, the compat floor, and an object script's ceiling
    // when its artifact did not change.
    let manifest_changes = diff_manifest_fields(from.manifest(), to.manifest());
    diff_writeback_declarations(from.manifest(), to.manifest(), &mut objects);
    diff_object_script_ceilings(from.manifest(), to.manifest(), &mut objects);

    sheets.sort_by(|a, b| a.name.cmp(&b.name).then(a.sheet_id.cmp(&b.sheet_id)));
    objects.sort_by(|a, b| {
        a.domain
            .cmp(&b.domain)
            .then(a.name.cmp(&b.name))
            .then(a.id.cmp(&b.id))
    });

    let totals = DiffTotals {
        objects_added: objects.iter().filter(|o| o.change == "added").count(),
        objects_removed: objects.iter().filter(|o| o.change == "removed").count(),
        objects_modified: objects.iter().filter(|o| o.change == "modified").count(),
        sheets_changed: sheets.iter().filter(|s| s.change != "unchanged").count(),
        cells_changed: sheets
            .iter()
            .map(|s| s.cells_added + s.cells_removed + s.cells_modified)
            .sum(),
        cells_changed_exact: sheets.iter().all(|s| s.counts_exact),
    };

    Ok(VersionDiff {
        package_name: to.manifest().package_name.clone(),
        from_version: from.label(),
        to_version: to.label(),
        artifacts,
        sheets,
        objects,
        manifest_changes,
        totals,
    })
}

/// Every changed cell of ONE sheet, up to `max_cells`.
pub fn diff_sheet_cells(
    from: &DiffSide,
    to: &DiffSide,
    sheet_id: &str,
    max_cells: usize,
    sheet_id_map: &HashMap<String, String>,
) -> Result<SheetCellDiff, CalpError> {
    let rel = format!("sheets/{sheet_id}/data.json");
    // The `to` side may hold this sheet under a different (local) id.
    let to_rel = sheet_id_map
        .iter()
        .find(|(_, package_id)| package_id.as_str() == sheet_id)
        .map(|(local, _)| format!("sheets/{local}/data.json"))
        .unwrap_or_else(|| rel.clone());

    let before = read_sheet_data(from, &rel)?;
    let after = read_sheet_data(to, &to_rel)?;

    let name = to
        .manifest()
        .sheets
        .iter()
        .chain(from.manifest().sheets.iter())
        .find(|s| s.sheet_id.to_string() == sheet_id)
        .map(|s| s.name.clone())
        .unwrap_or_default();

    let (counts, all) = walk_cells(before.as_ref(), after.as_ref(), usize::MAX);
    let truncated = all.len() > max_cells;
    let changes: Vec<CellDiff> = all.into_iter().take(max_cells).collect();

    Ok(SheetCellDiff {
        sheet_id: sheet_id.to_string(),
        name,
        total_changes: counts.total(),
        truncated,
        changes,
        cells_added: counts.added,
        cells_removed: counts.removed,
        cells_modified: counts.modified,
        formula_changes: counts.formula_changes,
    })
}

/// An empty sheet, for the one-sided comparisons below.
static EMPTY_SHEET_DATA: std::sync::LazyLock<calcula_format::sheet_data::SheetData> =
    std::sync::LazyLock::new(|| calcula_format::sheet_data::SheetData {
        cells: BTreeMap::new(),
    });

/// How many cells differ AT ALL — derived values included.
///
/// The counterpart to [`count_sheet_data_changes`], which answers "what did
/// somebody AUTHOR" and therefore hides a formula cell whose formula did not
/// change, and array output under an unchanged extent. Two different questions,
/// and both are asked:
///
/// * A PUSH diff wants the authored answer. A recalculated `=C2*2` beside the
///   number you edited is that edit's consequence, not a second decision.
/// * A REFRESH preview wants this one. Nothing on the receiving side
///   recalculates — neither pull, nor checkout, nor opening the file evaluates a
///   cell — so a subscriber sees every changed cached value land on their
///   screen. Telling them "1 cell changed" before 501 of them move is not a
///   coarser truth, it is a different number from the one that happens.
/// * The determinism counter wants it too: zero here is what "same content,
///   different bytes" actually means.
pub fn count_all_cell_differences(
    before: &calcula_format::sheet_data::SheetData,
    after: &calcula_format::sheet_data::SheetData,
) -> usize {
    let mut n = 0usize;
    for (a1, b) in &before.cells {
        match after.cells.get(a1) {
            None => n += 1,
            Some(a) => {
                // The pre-2026-09-01 comparison, kept whole: every field.
                if !(a.t == b.t && a.v == b.v && a.f == b.f && a.e == b.e && a.sp == b.sp && a.rt == b.rt)
                {
                    n += 1;
                }
            }
        }
    }
    for a1 in after.cells.keys() {
        if !before.cells.contains_key(a1) {
            n += 1;
        }
    }
    n
}

/// Count cell changes between two parsed sheet payloads. Allocates nothing per
/// change, so the refresh preview can afford to call it.
pub fn count_sheet_data_changes(
    before: &calcula_format::sheet_data::SheetData,
    after: &calcula_format::sheet_data::SheetData,
) -> CellChangeCounts {
    let mut counts = CellChangeCounts::default();
    // The same spill skip `walk_cells` applies. These two must agree: they are
    // the counted and the itemised view of one question, and the refresh preview
    // reads the first while the diff dialog reads the second.
    let spilled = unchanged_spill_cells(before, after);
    let derived = |a1: &str| {
        calcula_format::cell_ref::from_a1(a1).is_some_and(|rc| spilled.contains(&rc))
    };
    for (a1, b) in &before.cells {
        if derived(a1) {
            continue;
        }
        match after.cells.get(a1) {
            None => counts.removed += 1,
            Some(a) => {
                if !cells_equal(b, a) {
                    counts.modified += 1;
                    if !same_formula(&b.f, &a.f) {
                        counts.formula_changes += 1;
                    }
                }
            }
        }
    }
    for a1 in after.cells.keys() {
        if !before.cells.contains_key(a1) && !derived(a1) {
            counts.added += 1;
        }
    }
    counts
}

// ---------------------------------------------------------------------------
// L2 — the path classifier
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Presence {
    Added,
    Removed,
    Changed,
}

impl Presence {
    fn as_str(self) -> &'static str {
        match self {
            Presence::Added => "added",
            Presence::Removed => "removed",
            Presence::Changed => "modified",
        }
    }
}

struct DiffContext<'a, 'b> {
    from: &'a DiffSide<'b>,
    to: &'a DiffSide<'b>,
    opts: &'a DiffOptions,
    /// local sheet id -> application sheet id.
    sheet_id_map: &'a HashMap<String, String>,
    /// application sheet id -> local sheet id. The inverse, because paths are
    /// COMPARED in application space but must be READ from the `to` side in its own
    /// space — a working copy that came from a pull stores its sheets under the
    /// local ids the pull minted.
    reverse_sheet_ids: HashMap<String, String>,
    sheets: BTreeMap<String, SheetDiffSummary>,
    objects: Vec<ObjectChange>,
    parsed_sheet_artifacts: usize,
    spurious: usize,
}

impl DiffContext<'_, '_> {
    /// A path in application space, translated to how the `to` side stores it.
    fn to_path(&self, rel: &str) -> String {
        if self.reverse_sheet_ids.is_empty() {
            return rel.to_string();
        }
        rel.strip_prefix("sheets/")
            .and_then(|rest| rest.split_once('/'))
            .and_then(|(id, file)| {
                self.reverse_sheet_ids
                    .get(id)
                    .map(|local| format!("sheets/{local}/{file}"))
            })
            .unwrap_or_else(|| rel.to_string())
    }
}

impl DiffContext<'_, '_> {
    /// Route one artifact path to its domain. Returns whether the change was
    /// CONFIRMED (an L1 candidate whose content really differs).
    fn classify(&mut self, rel: &str, presence: Presence) -> Result<bool, CalpError> {
        // Sheets: `sheets/{id}/{data,styles,cell_styles,layout,metadata}.json`
        if let Some(rest) = rel.strip_prefix("sheets/") {
            if let Some((sheet_id, file)) = rest.split_once('/') {
                return self.classify_sheet_part(rel, sheet_id, file, presence);
            }
        }

        // Media never enters the payload as bytes — an application can carry
        // megabytes of images, and a diff that inlined them would be unusable
        // and would leak content into a summary meant to be skimmed.
        if let Some(hash) = rel.strip_prefix("media/") {
            let size = self.size_of(rel, presence)?;
            self.objects.push(ObjectChange {
                domain: "media".to_string(),
                id: hash.to_string(),
                name: format!("{}…", &hash[..hash.len().min(12)]),
                sheet_name: None,
                change: presence.as_str().to_string(),
                detail: match size {
                    Some(n) => format!("{n} bytes"),
                    None => String::new(),
                },
                artifact_path: Some(rel.to_string()),
                before: None,
                after: None,
                before_truncated: false,
                after_truncated: false,
                added_capabilities: Vec::new(),
                removed_capabilities: Vec::new(),
            });
            return Ok(true);
        }

        // Per-object directories. Both the grouped legacy layout and the
        // per-object layout are routed, so the decomposed format can land
        // without this classifier changing shape.
        const PER_OBJECT_DIRS: &[(&str, &str)] = &[
            ("object_scripts/", "objectScript"),
            ("modules/", "moduleScript"),
            ("notebooks/", "notebook"),
            ("tables/", "table"),
            ("pivot_definitions/", "pivot"),
            ("custom_objects/", "customObject"),
            ("charts/", "chart"),
            ("slicers/", "slicer"),
            ("timeline_slicers/", "timelineSlicer"),
            ("floating_ranges/", "floatingRange"),
            ("ribbon_filters/", "ribbonFilter"),
            ("pivot_layouts/", "pivotLayout"),
            ("controls/", "control"),
            ("pane_controls/", "paneControl"),
            ("conditional_formats/", "conditionalFormat"),
            ("data_validations/", "dataValidation"),
            ("comments/", "comment"),
            ("scenarios/", "scenario"),
            ("outlines/", "outline"),
            ("cell_behaviors/", "cellBehavior"),
            ("sparklines/", "sparkline"),
            ("extension_data/", "extensionData"),
        ];
        for (prefix, domain) in PER_OBJECT_DIRS {
            if let Some(rest) = rel.strip_prefix(prefix) {
                let id = rest.trim_end_matches(".json").to_string();
                return self.push_json_object(rel, domain, &id, presence);
            }
        }

        if rel.starts_with("models/") {
            return self.classify_model_part(rel, presence);
        }

        // Grouped, whole-domain artifacts (the layout before decomposition).
        const GROUPED: &[(&str, &str)] = &[
            ("charts.json", "chart"),
            ("slicers.json", "slicer"),
            ("timeline_slicers.json", "timelineSlicer"),
            ("floating_ranges.json", "floatingRange"),
            ("ribbon_filters.json", "ribbonFilter"),
            ("pivot_layouts.json", "pivotLayout"),
            ("controls.json", "control"),
            ("pane_controls.json", "paneControl"),
            ("sparklines.json", "sparkline"),
            ("conditional_formats.json", "conditionalFormat"),
            ("data_validations.json", "dataValidation"),
            ("comments.json", "comment"),
            ("scenarios.json", "scenario"),
            ("outlines.json", "outline"),
            ("cell_behaviors.json", "cellBehavior"),
            ("named_ranges.json", "namedRange"),
            ("extension_data.json", "extensionData"),
            ("theme.json", "theme"),
        ];
        for (path, domain) in GROUPED {
            if rel == *path {
                return self.push_grouped(rel, domain, presence);
            }
        }

        // Anything this build does not recognise. Reported rather than dropped:
        // a diff that silently omits an application's newest artifact type is a diff
        // that says "nothing changed" about the thing that did.
        self.push_json_object(rel, "artifact", rel, presence)
    }

    fn classify_sheet_part(
        &mut self,
        rel: &str,
        sheet_id: &str,
        file: &str,
        presence: Presence,
    ) -> Result<bool, CalpError> {
        let package_id = self
            .sheet_id_map
            .get(sheet_id)
            .cloned()
            .unwrap_or_else(|| sheet_id.to_string());

        // Everything that READS is done before the sheet entry is borrowed
        // mutably — the reads need `&self`, and holding the entry across them
        // would be two borrows of the same value.
        enum Outcome {
            Cells(CellChangeCounts, Vec<CellDiff>),
            CountsInexact,
            Presentation(&'static str),
            Spurious,
            Nothing,
        }

        let outcome = match file {
            "data.json" => {
                // L3, budgeted: past the cap the sheet is still reported as
                // changed, but its counts are declared inexact rather than
                // guessed at.
                if self.parsed_sheet_artifacts >= self.opts.max_parsed_sheet_artifacts {
                    Outcome::CountsInexact
                } else {
                    let from_rel = format!("sheets/{package_id}/data.json");
                    let before = read_sheet_data_capped(self.from, &from_rel, self.opts)?;
                    let after = read_sheet_data_capped(self.to, &self.to_path(rel), self.opts)?;
                    // EITHER SIDE MISSING IS INEXACT, not just both.
                    //
                    // `read_sheet_data_capped` returns None for three different
                    // reasons — absent, over the byte cap, unparseable — and the
                    // guard only fired when BOTH sides failed. A one-sided
                    // failure fell through to `walk_cells`, which substitutes an
                    // EMPTY sheet for the missing side: a 9 MB base sheet past
                    // the 8 MiB cap, diffed against a small working copy,
                    // reported "20 cells added, 0 removed" with countsExact
                    // TRUE. The author was shown an addition and published a
                    // deletion of ~100,000 cells.
                    //
                    // Scoped to `Presence::Changed`, because a genuinely added
                    // or removed sheet legitimately has one side and must keep
                    // its real counts.
                    let one_sided_failure = presence == Presence::Changed
                        && before.is_none() != after.is_none();
                    if (before.is_none() && after.is_none() && presence == Presence::Changed)
                        || one_sided_failure
                    {
                        Outcome::CountsInexact
                    } else {
                        self.parsed_sheet_artifacts += 1;
                        let (counts, sample) = walk_cells(
                            before.as_ref(),
                            after.as_ref(),
                            self.opts.sample_cells_per_sheet,
                        );
                        if counts.total() == 0 && presence == Presence::Changed {
                            // THREE FACTS, NOT TWO. Zero AUTHORED changes no
                            // longer means "identical content": `cells_equal`
                            // deliberately hides formula cells whose formula did
                            // not change, and `unchanged_spill_cells` hides
                            // array output. A sheet of nothing but formulas over
                            // an edited input therefore walks to zero while its
                            // bytes really did change.
                            //
                            // Calling that `Spurious` was wrong twice over: the
                            // sheet vanished from the diff entirely (no summary,
                            // so no row, so no per-cell tick), AND it was
                            // counted into the packaging-determinism figure the
                            // UI renders as "hashed differently but contain the
                            // same thing — that is a packaging bug, not a change
                            // you made". The author was told to go and fix a
                            // serialization defect that did not exist.
                            //
                            // So: re-read WITHOUT the derived-value rules. Zero
                            // there too means the bytes really do carry the same
                            // content, which is the determinism regression the
                            // counter exists for. Non-zero means the sheet
                            // changed in derived values only — a real change,
                            // reported with zero authored cells.
                            let raw = count_all_cell_differences(
                                before.as_ref().unwrap_or(&EMPTY_SHEET_DATA),
                                after.as_ref().unwrap_or(&EMPTY_SHEET_DATA),
                            );
                            if raw == 0 {
                                Outcome::Spurious
                            } else {
                                Outcome::Cells(counts, sample)
                            }
                        } else {
                            Outcome::Cells(counts, sample)
                        }
                    }
                }
            }
            "cell_styles.json" | "styles.json" | "layout.json" | "metadata.json" => {
                let from_rel = format!("sheets/{package_id}/{file}");
                if self.json_differs(&from_rel, &self.to_path(rel), presence)? {
                    Outcome::Presentation(match file {
                        "cell_styles.json" => "cell_styles",
                        "styles.json" => "styles",
                        "layout.json" => "layout",
                        _ => "metadata",
                    })
                } else {
                    Outcome::Spurious
                }
            }
            _ => Outcome::Nothing,
        };

        if matches!(outcome, Outcome::Spurious) {
            // Same content, different bytes — not a change, and worth counting
            // because a nonzero total means determinism has regressed.
            self.spurious += 1;
            return Ok(false);
        }
        if matches!(outcome, Outcome::Nothing) {
            return Ok(true);
        }

        let name = self.sheet_name(&package_id);
        let entry = self
            .sheets
            .entry(package_id.clone())
            .or_insert_with(|| SheetDiffSummary {
                sheet_id: package_id.clone(),
                name,
                change: "modified".to_string(),
                renamed_from: None,
                cells_added: 0,
                cells_removed: 0,
                cells_modified: 0,
                formula_changes: 0,
                counts_exact: true,
                style_changed_cells: 0,
                styles_table_changed: false,
                layout_changed: false,
                metadata_changed: false,
                sample: Vec::new(),
                sample_truncated: false,
            });

        match outcome {
            Outcome::Cells(counts, sample) => {
                entry.cells_added = counts.added;
                entry.cells_removed = counts.removed;
                entry.cells_modified = counts.modified;
                entry.formula_changes = counts.formula_changes;
                entry.sample_truncated = counts.total() > sample.len();
                entry.sample = sample;
            }
            Outcome::CountsInexact => entry.counts_exact = false,
            Outcome::Presentation("cell_styles") => {
                entry.style_changed_cells = entry.style_changed_cells.max(1)
            }
            Outcome::Presentation("styles") => entry.styles_table_changed = true,
            Outcome::Presentation("layout") => entry.layout_changed = true,
            Outcome::Presentation(_) => entry.metadata_changed = true,
            Outcome::Spurious | Outcome::Nothing => unreachable!("handled above"),
        }
        Ok(true)
    }

    fn classify_model_part(&mut self, rel: &str, presence: Presence) -> Result<bool, CalpError> {
        // models/{ds}/model.json is the interesting one: measures and tables
        // are the things a person changed. The rest (Arrow snapshots, writeback
        // history) is reported coarsely — they are derived data.
        if rel.ends_with("/model.json") {
            let before = self.parse_json(self.from, rel)?;
            let after = self.parse_json(self.to, &self.to_path(rel))?;
            if before == after && presence == Presence::Changed {
                self.spurious += 1;
                return Ok(false);
            }
            let ds = rel
                .strip_prefix("models/")
                .and_then(|r| r.split('/').next())
                .unwrap_or("")
                .to_string();
            diff_model(&ds, before.as_ref(), after.as_ref(), &mut self.objects, self.opts);
            return Ok(true);
        }
        self.push_json_object(rel, "artifact", rel, presence)
    }

    /// A JSON artifact compared as a whole, reported as one object entry.
    fn push_json_object(
        &mut self,
        rel: &str,
        domain: &str,
        id: &str,
        presence: Presence,
    ) -> Result<bool, CalpError> {
        let before = self.parse_json(self.from, rel)?;
        let after = self.parse_json(self.to, &self.to_path(rel))?;
        let same = match (&before, &after) {
            (Some(b), Some(a)) => same_object(domain, b, a),
            (b, a) => b == a,
        };
        if presence == Presence::Changed && same {
            self.spurious += 1;
            return Ok(false);
        }

        let ceilings = self.ceilings(domain, id);
        let (name, detail, before_src, after_src, caps_added, caps_removed) =
            describe_object(domain, id, before.as_ref(), after.as_ref(), &ceilings, self.opts);

        self.objects.push(ObjectChange {
            domain: domain.to_string(),
            id: id.to_string(),
            name,
            sheet_name: None,
            change: presence.as_str().to_string(),
            detail,
            artifact_path: Some(rel.to_string()),
            before: before_src.as_ref().map(|(s, _)| s.clone()),
            after: after_src.as_ref().map(|(s, _)| s.clone()),
            before_truncated: before_src.map(|(_, t)| t).unwrap_or(false),
            after_truncated: after_src.map(|(_, t)| t).unwrap_or(false),
            added_capabilities: caps_added,
            removed_capabilities: caps_removed,
        });
        Ok(true)
    }

    /// A grouped artifact holding a LIST of objects: compare element-wise by id
    /// so the report names the chart that changed rather than the file.
    fn push_grouped(
        &mut self,
        rel: &str,
        domain: &str,
        presence: Presence,
    ) -> Result<bool, CalpError> {
        let before = self.parse_json(self.from, rel)?;
        let after = self.parse_json(self.to, &self.to_path(rel))?;
        if presence == Presence::Changed && before == after {
            self.spurious += 1;
            return Ok(false);
        }

        let before_items = keyed_domain_items(domain, before.as_ref());
        let after_items = keyed_domain_items(domain, after.as_ref());
        if before_items.is_none() && after_items.is_none() {
            // Not a keyed list (theme, extension_data) — one entry for the whole.
            return self.push_json_object(rel, domain, domain, presence);
        }
        let before_items = before_items.unwrap_or_default();
        let after_items = after_items.unwrap_or_default();

        let keys: BTreeSet<&String> = before_items.keys().chain(after_items.keys()).collect();
        for key in keys {
            let b = before_items.get(key);
            let a = after_items.get(key);
            let change = match (b, a) {
                (None, Some(_)) => Presence::Added,
                (Some(_), None) => Presence::Removed,
                (Some(x), Some(y)) if !same_object(domain, x, y) => Presence::Changed,
                _ => continue,
            };
            let ceilings = self.ceilings(domain, key);
            let (name, detail, before_src, after_src, caps_added, caps_removed) =
                describe_object(domain, key, b.copied(), a.copied(), &ceilings, self.opts);
            self.objects.push(ObjectChange {
                domain: domain.to_string(),
                id: key.clone(),
                name,
                sheet_name: None,
                change: change.as_str().to_string(),
                detail,
                artifact_path: Some(rel.to_string()),
                before: before_src.as_ref().map(|(s, _)| s.clone()),
                after: after_src.as_ref().map(|(s, _)| s.clone()),
                before_truncated: before_src.map(|(_, t)| t).unwrap_or(false),
                after_truncated: after_src.map(|(_, t)| t).unwrap_or(false),
                added_capabilities: caps_added,
                removed_capabilities: caps_removed,
            });
        }
        Ok(true)
    }

    fn json_differs(
        &mut self,
        from_rel: &str,
        to_rel: &str,
        presence: Presence,
    ) -> Result<bool, CalpError> {
        if presence != Presence::Changed {
            return Ok(true);
        }
        let before = self.parse_json(self.from, from_rel)?;
        let after = self.parse_json(self.to, to_rel)?;
        Ok(before != after)
    }

    fn parse_json(
        &self,
        side: &DiffSide,
        rel: &str,
    ) -> Result<Option<serde_json::Value>, CalpError> {
        match side.read(rel)? {
            Some(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
            None => Ok(None),
        }
    }

    fn size_of(&self, rel: &str, presence: Presence) -> Result<Option<usize>, CalpError> {
        match presence {
            Presence::Removed => Ok(self.from.read(rel)?.map(|b| b.len())),
            _ => Ok(self.to.read(&self.to_path(rel))?.map(|b| b.len())),
        }
    }

    fn sheet_name(&self, package_sheet_id: &str) -> String {
        self.to
            .manifest()
            .sheets
            .iter()
            .chain(self.from.manifest().sheets.iter())
            .find(|s| s.sheet_id.to_string() == package_sheet_id)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| package_sheet_id.to_string())
    }

    /// One object's capability ceiling on each side: for an object script, the
    /// SIGNED manifest's declaration a subscriber's pull applies -- never the
    /// artifact's own claim (BUG-0274). Nothing else carries a ceiling.
    fn ceilings(&self, domain: &str, id: &str) -> Ceilings {
        Ceilings::of(domain, id, self.from.manifest(), self.to.manifest())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Rewrite `sheets/{local}/…` paths to `sheets/{package}/…` so a working copy
/// whose sheets were minted by a pull lines up with the application it came from.
fn remap_sheet_paths(
    sums: &BTreeMap<String, String>,
    map: &HashMap<String, String>,
) -> BTreeMap<String, String> {
    if map.is_empty() {
        return sums.clone();
    }
    sums.iter()
        .map(|(rel, hash)| {
            let mapped = rel
                .strip_prefix("sheets/")
                .and_then(|rest| rest.split_once('/'))
                .and_then(|(id, file)| map.get(id).map(|pkg| format!("sheets/{pkg}/{file}")))
                .unwrap_or_else(|| rel.clone());
            (mapped, hash.clone())
        })
        .collect()
}

/// Sheets added, removed or renamed — facts that live in the manifest, not in
/// any artifact.
fn apply_manifest_sheet_facts(
    from: &DiffSide,
    to: &DiffSide,
    sheet_id_map: &HashMap<String, String>,
    sheets: &mut Vec<SheetDiffSummary>,
) {
    let before: BTreeMap<String, String> = from
        .manifest()
        .sheets
        .iter()
        .map(|s| (s.sheet_id.to_string(), s.name.clone()))
        .collect();
    let after: BTreeMap<String, String> = to
        .manifest()
        .sheets
        .iter()
        .map(|s| {
            let id = s.sheet_id.to_string();
            (sheet_id_map.get(&id).cloned().unwrap_or(id), s.name.clone())
        })
        .collect();

    for (id, name) in &after {
        match before.get(id) {
            None => upsert_sheet(sheets, id, name, "added", None),
            Some(old) if old != name => {
                upsert_sheet(sheets, id, name, "renamed", Some(old.clone()))
            }
            Some(_) => {}
        }
    }
    for (id, name) in &before {
        if !after.contains_key(id) {
            upsert_sheet(sheets, id, name, "removed", None);
        }
    }
}

fn upsert_sheet(
    sheets: &mut Vec<SheetDiffSummary>,
    id: &str,
    name: &str,
    change: &str,
    renamed_from: Option<String>,
) {
    if let Some(existing) = sheets.iter_mut().find(|s| s.sheet_id == id) {
        // A sheet that is BOTH renamed and edited is reported as renamed; the
        // cell counts alongside still say what else happened to it.
        existing.name = name.to_string();
        if change != "modified" {
            existing.change = change.to_string();
        }
        if renamed_from.is_some() {
            existing.renamed_from = renamed_from;
        }
        return;
    }
    sheets.push(SheetDiffSummary {
        sheet_id: id.to_string(),
        name: name.to_string(),
        change: change.to_string(),
        renamed_from,
        cells_added: 0,
        cells_removed: 0,
        cells_modified: 0,
        formula_changes: 0,
        counts_exact: true,
        style_changed_cells: 0,
        styles_table_changed: false,
        layout_changed: false,
        metadata_changed: false,
        sample: Vec::new(),
        sample_truncated: false,
    });
}

/// Manifest fields worth reporting on their own.
fn diff_manifest_fields(before: &VersionManifest, after: &VersionManifest) -> Vec<ManifestFieldChange> {
    let mut out = Vec::new();
    let mut push = |field: &str, b: &str, a: &str| {
        if b != a {
            out.push(ManifestFieldChange {
                field: field.to_string(),
                before: b.to_string(),
                after: a.to_string(),
            });
        }
    };
    push("kind", &before.kind, &after.kind);
    push("minAppVersion", &before.min_app_version, &after.min_app_version);
    push("publishedBy", &before.published_by, &after.published_by);
    // Loud: under one TOFU pin this should be impossible, and a subscriber
    // whose pin no longer matches is exactly the "application hijack" signal.
    push("publisherKey", &before.publisher_key, &after.publisher_key);
    out
}

/// Writeback declarations are governance, not content: a narrowed schema or a
/// removed region silently stops counting somebody's submissions.
fn diff_writeback_declarations(
    before: &VersionManifest,
    after: &VersionManifest,
    objects: &mut Vec<ObjectChange>,
) {
    let b = before.writeback_regions.clone().unwrap_or_default();
    let a = after.writeback_regions.clone().unwrap_or_default();
    let b_ids: BTreeSet<&String> = b.iter().map(|r| &r.id).collect();
    let a_ids: BTreeSet<&String> = a.iter().map(|r| &r.id).collect();
    for id in b_ids.difference(&a_ids) {
        objects.push(simple_object("writebackRegion", id, "removed", "no longer collected"));
    }
    for id in a_ids.difference(&b_ids) {
        objects.push(simple_object("writebackRegion", id, "added", "now collected"));
    }

    // Model writeback COLUMNS get the compatibility check rather than a plain
    // set difference: a column that is still there but whose schema narrowed
    // silently stops counting submissions that used to be valid, which is a
    // change worth reporting even though nothing was added or removed.
    let bm = before.model_writebacks.clone().unwrap_or_default();
    let am = after.model_writebacks.clone().unwrap_or_default();
    let compat = crate::writeback::check_model_writeback_compatibility(&bm, &am);
    for id in &compat.added {
        objects.push(simple_object("modelWriteback", id, "added", "now collected"));
    }
    for id in &compat.removed {
        objects.push(simple_object(
            "modelWriteback",
            id,
            "removed",
            "its collected submissions stop reaching the model",
        ));
    }
    for (id, reason) in &compat.incompatible {
        objects.push(simple_object("modelWriteback", id, "modified", reason));
    }
}

/// An object script whose signed ceiling moved while its artifact did not.
///
/// Every other ceiling change rides on its artifact's row (`push_json_object`
/// reads both manifests for it). This catches the one that has no row to ride
/// on: a byte-identical script whose manifest grants more, or less -- a
/// hand-signed version, or a pragma id this build has started to recognise. The
/// subscriber's pull applies the manifest, so the subscriber receives the
/// change, and a diff that said nothing would hide the one script change a
/// consumer must be shown.
fn diff_object_script_ceilings(
    before: &VersionManifest,
    after: &VersionManifest,
    objects: &mut Vec<ObjectChange>,
) {
    let listed_before: BTreeSet<&str> = before.object_scripts.iter().map(|s| s.id.as_str()).collect();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for script in &after.object_scripts {
        let id = script.id.as_str();
        if !listed_before.contains(id) || !seen.insert(id) {
            continue;
        }
        if objects.iter().any(|o| o.domain == "objectScript" && o.id == id) {
            continue;
        }
        let ceilings = Ceilings::of("objectScript", id, before, after);
        let (added, removed) = ceilings.changes();
        if added.is_empty() && removed.is_empty() {
            continue;
        }
        let mut row = simple_object(
            "objectScript",
            id,
            "modified",
            &format!("capabilities changed; {}", capability_clause(&added, &removed)),
        );
        row.name = script.name.clone();
        row.added_capabilities = added;
        row.removed_capabilities = removed;
        objects.push(row);
    }
}

fn simple_object(domain: &str, id: &str, change: &str, detail: &str) -> ObjectChange {
    ObjectChange {
        domain: domain.to_string(),
        id: id.to_string(),
        name: id.to_string(),
        sheet_name: None,
        change: change.to_string(),
        detail: detail.to_string(),
        artifact_path: None,
        before: None,
        after: None,
        before_truncated: false,
        after_truncated: false,
        added_capabilities: Vec::new(),
        removed_capabilities: Vec::new(),
    }
}

/// A JSON array of objects, keyed by whichever id-ish field it carries -- by
/// its NAME for a defined name (see below).
///
/// A DEFINED NAME IS KEYED BY ITS NAME (and its scope). The generic order
/// tries `sheetId` before `name`, which is right for a per-sheet container
/// (one item per sheet) and wrong for defined names: every name scoped to one
/// sheet got that sheet's id as its key, the map kept only the LAST of them,
/// and a change to any other name scoped to the same sheet was never reported
/// -- nor seen by the merge analysis.
fn keyed_domain_items<'a>(
    domain: &str,
    value: Option<&'a serde_json::Value>,
) -> Option<BTreeMap<String, &'a serde_json::Value>> {
    let arr = value?.as_array()?;
    let mut out = BTreeMap::new();
    for (i, item) in arr.iter().enumerate() {
        let named_range_key = (domain == "namedRange")
            .then(|| item.get("name").and_then(|v| v.as_str()))
            .flatten()
            .map(|name| match item.get("sheetId").and_then(|v| v.as_str()) {
                Some(scope) => format!("{scope}/{name}"),
                None => name.to_string(),
            });
        let key = named_range_key
            .or_else(|| {
                item.get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("sheetId").and_then(|v| v.as_str()))
                    .or_else(|| item.get("sheet_id").and_then(|v| v.as_str()))
                    .or_else(|| item.get("name").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
            })
            // A keyless element still has to be comparable to SOMETHING, and
            // its position is the only handle available. Order-sensitive by
            // construction — which is why the keyed fields are tried first.
            .unwrap_or_else(|| format!("#{i}"));
        out.insert(key, item);
    }
    Some(out)
}

/// Name, one-line detail, and (where it exists) the source text a reader wants
/// to see, for one object of a given domain.
type ObjectDescription = (
    String,
    String,
    Option<(String, bool)>,
    Option<(String, bool)>,
    Vec<String>,
    Vec<String>,
);

/// One object's capability ceiling on each side of a comparison.
#[derive(Debug, Default)]
struct Ceilings {
    before: BTreeSet<String>,
    after: BTreeSet<String>,
}

impl Ceilings {
    /// For an object script, each side's SIGNED manifest declaration -- the
    /// ceiling a subscriber's pull applies (`VersionManifest::object_script_ceiling`,
    /// shared with the promotion's code summary). Empty for every other domain:
    /// no other artifact carries a ceiling.
    fn of(domain: &str, id: &str, before: &VersionManifest, after: &VersionManifest) -> Self {
        match domain {
            "objectScript" => Ceilings {
                before: before.object_script_ceiling(id).into_iter().collect(),
                after: after.object_script_ceiling(id).into_iter().collect(),
            },
            _ => Ceilings::default(),
        }
    }

    /// (gained, lost), each sorted.
    fn changes(&self) -> (Vec<String>, Vec<String>) {
        (
            self.after.difference(&self.before).cloned().collect(),
            self.before.difference(&self.after).cloned().collect(),
        )
    }
}

/// "gains a, b; loses c" -- empty when nothing moved.
fn capability_clause(added: &[String], removed: &[String]) -> String {
    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push(format!("gains {}", added.join(", ")));
    }
    if !removed.is_empty() {
        parts.push(format!("loses {}", removed.join(", ")));
    }
    parts.join("; ")
}

fn describe_object(
    domain: &str,
    id: &str,
    before: Option<&serde_json::Value>,
    after: Option<&serde_json::Value>,
    ceilings: &Ceilings,
    opts: &DiffOptions,
) -> ObjectDescription {
    let latest = after.or(before);
    let name = latest
        .and_then(|v| {
            v.get("name")
                .or_else(|| v.get("title"))
                .and_then(|n| n.as_str())
        })
        .map(|s| s.to_string())
        .unwrap_or_else(|| id.to_string());

    // Source-bearing domains show their code, because "the script changed" is
    // not a thing anyone can act on.
    let source_field = match domain {
        "objectScript" | "moduleScript" => Some("source"),
        _ => None,
    };
    let (mut before_src, mut after_src) = match source_field {
        Some(field) => (
            before
                .and_then(|v| v.get(field))
                .and_then(|v| v.as_str())
                .map(|s| truncate(s, opts.max_source_bytes)),
            after
                .and_then(|v| v.get(field))
                .and_then(|v| v.as_str())
                .map(|s| truncate(s, opts.max_source_bytes)),
        ),
        None => (None, None),
    };

    // A BUTTON'S CODE IS SHOWN, like a script's (BUG-0257). `controls.json`
    // holds one entry per SHEET, so a changed button used to read as a
    // sheet-level "control modified" with an empty detail -- and code that
    // somebody else wrote, about to be re-signed under the pusher's key, was
    // invisible in the push preview. Compared per (row, col), so the detail
    // names the button and before/after carry its code.
    //
    // ...AND A BUTTON CELL'S ACTION (BUG-0260). A `calcula.button` cell carries
    // its action in its cell-type params, which publish as an opaque
    // `customObject` payload -- so a re-pointed action read as a bare
    // "modified" with no detail, and the push preview could not show what the
    // button would run. Recognised by the payload's SHAPE (the artifact path is
    // an index, and the kind lives in the manifest), compared per (row, col).
    let button_code = match domain {
        "control" => Some(describe_button_code(before, after, opts)),
        "customObject" if holds_button_cells(before) || holds_button_cells(after) => {
            Some(describe_code_by_cell(
                cell_button_actions_by_cell(before),
                cell_button_actions_by_cell(after),
                "button action",
                opts,
            ))
        }
        _ => None,
    };
    if let Some((_, b, a)) = &button_code {
        before_src = b.clone();
        after_src = a.clone();
    }

    let (added_capabilities, removed_capabilities) = ceilings.changes();

    let detail = match domain {
        "notebook" => {
            let b = cell_count(before);
            let a = cell_count(after);
            if b == a {
                format!("{a} cell(s), sources changed")
            } else {
                format!("cells {b} -> {a}")
            }
        }
        "namedRange" => {
            let b = field_str(before, "refersTo");
            let a = field_str(after, "refersTo");
            if b != a && !(b.is_empty() && a.is_empty()) {
                format!("{b} -> {a}")
            } else {
                String::new()
            }
        }
        "objectScript" | "moduleScript" => {
            let capabilities = capability_clause(&added_capabilities, &removed_capabilities);
            if capabilities.is_empty() {
                "source changed".to_string()
            } else {
                format!("source changed; {capabilities}")
            }
        }
        "control" | "customObject" => button_code.map(|(detail, _, _)| detail).unwrap_or_default(),
        _ => String::new(),
    };

    (name, detail, before_src, after_src, added_capabilities, removed_capabilities)
}

/// The slots of a control whose value is CODE: the host's
/// `EXECUTABLE_CONTROL_PROPERTIES` (app/src-tauri/src/controls.rs), which a host
/// test pins against this list through the diff's own output.
const BUTTON_CODE_SLOTS: &[&str] = &["onSelect", "macroRef"];

/// Every piece of button code in one sheet's control entry, by (row, col):
/// slot -> its text as a reader should see it.
fn button_code_by_cell(
    v: Option<&serde_json::Value>,
) -> BTreeMap<(u64, u64), BTreeMap<&'static str, String>> {
    let mut out: BTreeMap<(u64, u64), BTreeMap<&'static str, String>> = BTreeMap::new();
    let Some(entries) = v.and_then(|v| v.get("controls")).and_then(|c| c.as_array()) else {
        return out;
    };
    for entry in entries {
        let row = entry.get("row").and_then(|r| r.as_u64()).unwrap_or(0);
        let col = entry.get("col").and_then(|c| c.as_u64()).unwrap_or(0);
        let Some(props) = entry.get("properties").and_then(|p| p.as_object()) else { continue };
        for slot in BUTTON_CODE_SLOTS {
            let Some(p) = props.get(*slot) else { continue };
            let Some(text) = p.get("value").and_then(|v| v.as_str()) else { continue };
            if text.is_empty() {
                continue;
            }
            let value_type = p.get("valueType").and_then(|t| t.as_str()).unwrap_or("static");
            let shown = match (*slot, value_type) {
                ("macroRef", _) => format!("runs macro {text}"),
                (_, "static") => text.to_string(),
                (_, other) => format!("({other}) {text}"),
            };
            out.entry((row, col)).or_default().insert(*slot, shown);
        }
    }
    out
}

/// A1 for a 0-based (row, col).
pub(crate) fn a1_of(row: u64, col: u64) -> String {
    let mut letters = String::new();
    let mut c = col as i64;
    loop {
        letters.insert(0, (b'A' + (c % 26) as u8) as char);
        c = c / 26 - 1;
        if c < 0 {
            break;
        }
    }
    format!("{letters}{}", row + 1)
}

/// The detail line and the before/after code texts for the buttons whose code
/// differs between two versions of one sheet's controls. An empty detail and
/// no texts when no button's code changed (a caption edit stays a plain
/// "control modified").
fn describe_button_code(
    before: Option<&serde_json::Value>,
    after: Option<&serde_json::Value>,
    opts: &DiffOptions,
) -> (String, Option<(String, bool)>, Option<(String, bool)>) {
    describe_code_by_cell(button_code_by_cell(before), button_code_by_cell(after), "button code", opts)
}

/// The button cell type's id: the host's `button_cells::BUTTON_CELL_TYPE_ID`.
const BUTTON_CELL_TYPE_ID: &str = "calcula.button";

/// Is this custom-object payload a sheet's cell-type assignments holding at
/// least one button cell?
fn holds_button_cells(v: Option<&serde_json::Value>) -> bool {
    v.and_then(|v| v.as_array()).is_some_and(|entries| {
        entries
            .iter()
            .any(|e| e.get("typeId").and_then(|t| t.as_str()) == Some(BUTTON_CELL_TYPE_ID))
    })
}

/// Every button cell's action in one cell-type payload, by (row, col), as a
/// reader should see it: what it runs, then the action exactly (canonical JSON,
/// keys sorted -- the bytes the host hashes and acknowledges).
fn cell_button_actions_by_cell(
    v: Option<&serde_json::Value>,
) -> BTreeMap<(u64, u64), BTreeMap<&'static str, String>> {
    let mut out: BTreeMap<(u64, u64), BTreeMap<&'static str, String>> = BTreeMap::new();
    let Some(entries) = v.and_then(|v| v.as_array()) else { return out };
    for entry in entries {
        if entry.get("typeId").and_then(|t| t.as_str()) != Some(BUTTON_CELL_TYPE_ID) {
            continue;
        }
        let Some(action) = entry.get("params").and_then(|p| p.get("action")) else { continue };
        if action.is_null() {
            continue;
        }
        let row = entry.get("row").and_then(|r| r.as_u64()).unwrap_or(0);
        let col = entry.get("col").and_then(|c| c.as_u64()).unwrap_or(0);
        let text = |key: &str| action.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let what = match action.get("kind").and_then(|k| k.as_str()) {
            Some("script") => {
                let function = text("functionName");
                if function.is_empty() {
                    format!("runs macro {}", text("scriptId"))
                } else {
                    format!("runs macro {}, then calls {function}()", text("scriptId"))
                }
            }
            Some("command") => format!("runs command {}", text("commandId")),
            _ => "an action of an unknown kind".to_string(),
        };
        let exact = serde_json::to_string(action).unwrap_or_default();
        out.entry((row, col)).or_default().insert("action", format!("{what}\n{exact}"));
    }
    out
}

/// The detail line and the before/after texts for the cells whose code differs
/// between two versions: `noun` added/changed/removed at A1, B2, ...
fn describe_code_by_cell(
    b: BTreeMap<(u64, u64), BTreeMap<&'static str, String>>,
    a: BTreeMap<(u64, u64), BTreeMap<&'static str, String>>,
    noun: &str,
    opts: &DiffOptions,
) -> (String, Option<(String, bool)>, Option<(String, bool)>) {
    let cells: BTreeSet<&(u64, u64)> = b.keys().chain(a.keys()).collect();
    let (mut added, mut changed, mut removed) = (Vec::new(), Vec::new(), Vec::new());
    let (mut before_text, mut after_text) = (String::new(), String::new());
    let render = |out: &mut String, at: &str, code: &BTreeMap<&'static str, String>| {
        for (slot, text) in code {
            out.push_str(&format!("// {at} {slot}\n{text}\n"));
        }
    };
    for cell in cells {
        let (bc, ac) = (b.get(cell), a.get(cell));
        if bc == ac {
            continue;
        }
        let at = a1_of(cell.0, cell.1);
        match (bc, ac) {
            (None, Some(_)) => added.push(at.clone()),
            (Some(_), None) => removed.push(at.clone()),
            _ => changed.push(at.clone()),
        }
        if let Some(code) = bc {
            render(&mut before_text, &at, code);
        }
        if let Some(code) = ac {
            render(&mut after_text, &at, code);
        }
    }
    let mut parts = Vec::new();
    for (verb, cells) in [("added", &added), ("changed", &changed), ("removed", &removed)] {
        if !cells.is_empty() {
            parts.push(format!("{noun} {verb} at {}", cells.join(", ")));
        }
    }
    let text = |t: String| (!t.is_empty()).then(|| truncate(&t, opts.max_source_bytes));
    (parts.join("; "), text(before_text), text(after_text))
}

fn cell_count(v: Option<&serde_json::Value>) -> usize {
    v.and_then(|v| v.get("cells"))
        .and_then(|c| c.as_array())
        .map(|a| a.len())
        .unwrap_or(0)
}

fn field_str(v: Option<&serde_json::Value>, field: &str) -> String {
    v.and_then(|v| v.get(field))
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Model measures and tables, by name.
///
/// The engine serializes snake_case with no `rename_all`, and a measure's
/// display text lives under `source` (`expression` is the parsed AST) — the
/// same two facts the Application Inspector had to learn. Both spellings are tried
/// so this keeps working either way.
fn diff_model(
    ds: &str,
    before: Option<&serde_json::Value>,
    after: Option<&serde_json::Value>,
    objects: &mut Vec<ObjectChange>,
    opts: &DiffOptions,
) {
    let by_name = |v: Option<&serde_json::Value>, key: &str| -> BTreeMap<String, serde_json::Value> {
        v.and_then(|v| v.get(key))
            .and_then(|m| m.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|item| {
                        item.get("name")
                            .and_then(|n| n.as_str())
                            .map(|n| (n.to_string(), item.clone()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };

    for (key, domain) in [("measures", "modelMeasure"), ("tables", "modelTable")] {
        let b = by_name(before, key);
        let a = by_name(after, key);
        let names: BTreeSet<&String> = b.keys().chain(a.keys()).collect();
        for name in names {
            let (bv, av) = (b.get(name), a.get(name));
            let change = match (bv, av) {
                (None, Some(_)) => "added",
                (Some(_), None) => "removed",
                (Some(x), Some(y)) if x != y => "modified",
                _ => continue,
            };
            let expr = |v: Option<&serde_json::Value>| -> Option<(String, bool)> {
                v.and_then(|v| v.get("source").or_else(|| v.get("expression")))
                    .and_then(|s| s.as_str())
                    .map(|s| truncate(s, opts.max_source_bytes))
            };
            objects.push(ObjectChange {
                domain: domain.to_string(),
                id: format!("{ds}:{name}"),
                name: name.clone(),
                sheet_name: None,
                change: change.to_string(),
                detail: if domain == "modelMeasure" {
                    "expression changed".to_string()
                } else {
                    String::new()
                },
                artifact_path: Some(format!("models/{ds}/model.json")),
                before: expr(bv).map(|(s, _)| s),
                after: expr(av).map(|(s, _)| s),
                before_truncated: expr(bv).map(|(_, t)| t).unwrap_or(false),
                after_truncated: expr(av).map(|(_, t)| t).unwrap_or(false),
                added_capabilities: Vec::new(),
                removed_capabilities: Vec::new(),
            });
        }
    }
}

pub(crate) fn truncate(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    // Never split a UTF-8 character: walk back to a boundary.
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

fn read_sheet_data(
    side: &DiffSide,
    rel: &str,
) -> Result<Option<calcula_format::sheet_data::SheetData>, CalpError> {
    match side.read(rel)? {
        Some(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        None => Ok(None),
    }
}

fn read_sheet_data_capped(
    side: &DiffSide,
    rel: &str,
    opts: &DiffOptions,
) -> Result<Option<calcula_format::sheet_data::SheetData>, CalpError> {
    match side.read(rel)? {
        Some(bytes) if bytes.len() <= opts.max_sheet_data_bytes => {
            Ok(serde_json::from_slice(&bytes).ok())
        }
        _ => Ok(None),
    }
}

/// Walk the union of two sparse cell maps.
/// The one cell walker. `pub(crate)` so the refresh preview can emit the same
/// per-cell rows the version diff renders, instead of a second walker that
/// agrees with this one only until the next `CellEntry` field is added.
pub(crate) fn walk_cells(
    before: Option<&calcula_format::sheet_data::SheetData>,
    after: Option<&calcula_format::sheet_data::SheetData>,
    sample_cap: usize,
) -> (CellChangeCounts, Vec<CellDiff>) {
    let empty = calcula_format::sheet_data::SheetData { cells: BTreeMap::new() };
    let before = before.unwrap_or(&empty);
    let after = after.unwrap_or(&empty);

    let mut counts = CellChangeCounts::default();
    let mut sample: Vec<CellDiff> = Vec::new();
    let spilled = unchanged_spill_cells(before, after);
    let keys: BTreeSet<&String> = before.cells.keys().chain(after.cells.keys()).collect();
    // Sorted by (row, col) rather than by A1 string, so "A10" does not sort
    // before "A2" in a table a person reads.
    let mut ordered: Vec<(&String, (u32, u32))> = keys
        .into_iter()
        .filter_map(|a1| parse_a1(a1).map(|rc| (a1, rc)))
        .collect();
    ordered.sort_by_key(|(_, rc)| *rc);

    for (a1, (row, col)) in ordered {
        // Inside a dynamic array whose origin did not change: derived output,
        // not an edit. See `unchanged_spill_cells`.
        if spilled.contains(&(row, col)) {
            continue;
        }
        let b = before.cells.get(a1);
        let a = after.cells.get(a1);
        let change = match (b, a) {
            (None, Some(_)) => {
                counts.added += 1;
                "added"
            }
            (Some(_), None) => {
                counts.removed += 1;
                "removed"
            }
            (Some(x), Some(y)) if !cells_equal(x, y) => {
                counts.modified += 1;
                if !same_formula(&x.f, &y.f) {
                    counts.formula_changes += 1;
                }
                "modified"
            }
            _ => continue,
        };
        if sample.len() < sample_cap {
            sample.push(CellDiff {
                a1: a1.clone(),
                row,
                col,
                change: change.to_string(),
                before: b.map(snapshot),
                after: a.map(snapshot),
            });
        }
    }
    (counts, sample)
}

/// Are these two cells the same AUTHORED cell?
///
/// A CACHED RESULT IS NOT AN EDIT. For a cell that carries a formula, `v`, `t`,
/// `e` and `sp` are all *derived* — the last computed value, its type, its error
/// state, and how far the array spilled. A formula cell whose formula did not
/// change holds nothing anybody typed, and whatever moved in it is fully
/// explained by the precedent that DID change, which has a row of its own.
///
/// NOT because the receiver recalculates — it does not, and the first version of
/// this comment said otherwise. `materialize_pull_result` (pull and checkout)
/// evaluates no cell, and `open_file` rebuilds dependency EDGES without
/// evaluating. A published cached value is displayed verbatim, indefinitely.
/// That makes this a rule about what the diff REPORTS, never a licence to
/// publish a value computed from inputs that did not ship: see
/// `calp_publish`'s refusal to publish a workbook with a cancelled
/// recalculation, which exists for exactly that reason.
///
/// Reported from live testing: change one hard-coded number, push, and the diff
/// claimed TWO cells changed — the number, and the `=C2*2` beside it whose
/// formula was identical on both sides. The second row was the first row's
/// consequence, listed as if it were a second decision. On a real sheet one
/// edited input produces a column of them, and the count that gates the push
/// dialog inflates with noise that is already fully explained by the rows above
/// it.
///
/// So: same non-empty formula on both sides ⇒ compare only what a person can
/// author on a formula cell, which is the rich-text runs. Everything else is the
/// engine's answer to a question neither side changed.
///
/// A cell that GAINS or LOSES a formula still differs, because `f` differs. A
/// literal cell is compared in full, because for a literal `v` IS the authored
/// content.
///
/// "The same formula" is [`crate::sheet_renames::same_formula_text`], not byte
/// equality: a checkout's collision rename and the push's undo of it bring an
/// untouched `DATA!A1*2` home as `Data!A1*2`, and that re-spelling is not an
/// edit (BUG-0151). Byte-wise, every reference to a collision-renamed sheet
/// was listed as changed in the push preview, shipped as a change, and
/// collided with a teammate's edit of the same cell in the merge analysis.
fn cells_equal(
    a: &calcula_format::sheet_data::CellEntry,
    b: &calcula_format::sheet_data::CellEntry,
) -> bool {
    if let (Some(fa), Some(fb)) = (&a.f, &b.f) {
        if crate::sheet_renames::same_formula_text(fa, fb) {
            return a.rt == b.rt;
        }
    }
    a.t == b.t && a.v == b.v && a.f == b.f && a.e == b.e && a.sp == b.sp && a.rt == b.rt
}

/// Two optional formula texts: both absent, or the same formula however it is
/// spelled ([`crate::sheet_renames::same_formula_text`]).
fn same_formula(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => crate::sheet_renames::same_formula_text(x, y),
        (None, None) => true,
        _ => false,
    }
}

/// Are these two versions of one object the SAME object?
///
/// JSON equality, except for the two fields a rename round trip re-spells
/// without anybody editing them (BUG-0151): a chart's `specJson` STRING (the
/// round trip re-serializes it with its keys sorted, and re-spells its string
/// sources' sheet prefixes -- `chart_refs::comparable_chart_spec`) and a defined
/// name's `refersTo` formula (`sheet_renames::same_formula_text`).
fn same_object(domain: &str, a: &serde_json::Value, b: &serde_json::Value) -> bool {
    if a == b {
        return true;
    }
    // The RULE payloads (conditional formats, validations, controls, pane
    // controls) are renamed at checkout and back at push too (wave-B B4):
    // compared with every formula slot in its spelling-blind form.
    if let (Some(x), Some(y)) = (
        crate::sheet_renames::comparable_rule_payload(domain, a),
        crate::sheet_renames::comparable_rule_payload(domain, b),
    ) {
        return x == y;
    }
    let field = match domain {
        "chart" => "specJson",
        "namedRange" => "refersTo",
        _ => return false,
    };
    let (Some(ao), Some(bo)) = (a.as_object(), b.as_object()) else {
        return false;
    };
    // Every OTHER field byte-equal, and the same set of fields.
    if ao.len() != bo.len() || ao.iter().any(|(k, v)| k != field && bo.get(k) != Some(v)) {
        return false;
    }
    let (Some(x), Some(y)) = (
        ao.get(field).and_then(|v| v.as_str()),
        bo.get(field).and_then(|v| v.as_str()),
    ) else {
        return false;
    };
    match domain {
        "chart" => match (
            crate::chart_refs::comparable_chart_spec(x),
            crate::chart_refs::comparable_chart_spec(y),
        ) {
            (Some(cx), Some(cy)) => cx == cy,
            _ => x == y,
        },
        _ => crate::sheet_renames::same_formula_text(x, y),
    }
}

/// Cells that are the OUTPUT of a dynamic array whose origin did not change.
///
/// The sibling of the formula rule in [`cells_equal`], for the one case that
/// rule cannot see. A spilled cell is written as a plain value-only entry — no
/// `f` — so it is indistinguishable from a literal when looked at alone, and
/// `cells_equal` compares it in full. But it is every bit as derived: the origin
/// carries the formula and an `sp` extent naming the rectangle its result
/// occupies, and everything inside that rectangle is the engine's answer.
///
/// Without this, editing one input to `=SEQUENCE(n)` or a spilling `FILTER`
/// reports the whole spilled block as changed — the same "one edit, a column of
/// consequences" noise the formula rule removes, arriving by the one door it
/// does not cover.
///
/// STRICT ON PURPOSE. A cell is skipped only when the origin exists on BOTH
/// sides with the same formula AND the same extent. A spill that moved, grew,
/// shrank or changed formula fails all three, so its cells are compared
/// normally — and a literal that has replaced a spilled cell shows up, because
/// then the origin's extent no longer covers it or the origin itself changed.
fn unchanged_spill_cells(
    before: &calcula_format::sheet_data::SheetData,
    after: &calcula_format::sheet_data::SheetData,
) -> BTreeSet<(u32, u32)> {
    let mut covered = BTreeSet::new();
    for (a1, b) in &before.cells {
        let (Some(sp), Some(_)) = (b.sp.as_ref(), b.f.as_ref()) else { continue };
        let Some(a) = after.cells.get(a1) else { continue };
        if !same_formula(&a.f, &b.f) || a.sp.as_ref() != Some(sp) {
            continue;
        }
        let Some((r0, c0, r1, c1)) = calcula_format::cell_ref::range_from_a1(sp) else { continue };

        // BOUNDED, because `sp` is publisher-controlled text.
        //
        // `range_from_a1` applies no ceiling — it checks only that end >= start
        // — and the integrity walk hashes a `data.json` without sanity-checking
        // what is inside it. A single origin carrying `sp: "A1:XFD1048576"` is
        // 17 billion iterations, one BTreeSet insert each, inside a function
        // every diff surface and the refresh preview call. That is a hang
        // triggered by opening a package.
        //
        // Even a LEGITIMATE whole-column dynamic array costs ~1M inserts per
        // sheet per diff, and the refresh preview walks up to 16 sheets per
        // subscription. So the cap is not only about hostile input.
        //
        // Past the cap the extent is simply not skipped: its cells compare as
        // ordinary cells, which is the pre-2026-09-01 behaviour — noisier, never
        // wrong. Failing OPEN is right here because the skip is a noise
        // reduction, not a correctness guarantee.
        const MAX_SPILL_CELLS: u64 = 100_000;
        let area = (r1 as u64 - r0 as u64 + 1).saturating_mul(c1 as u64 - c0 as u64 + 1);
        if area > MAX_SPILL_CELLS {
            continue;
        }

        for r in r0..=r1 {
            for c in c0..=c1 {
                // The ORIGIN itself is not skipped here: it carries the formula,
                // so `cells_equal`'s formula rule already settles it, and
                // skipping it would hide a rich-text change on it.
                if (r, c) != (r0, c0) {
                    covered.insert((r, c));
                }
            }
        }
    }
    covered
}

fn snapshot(c: &calcula_format::sheet_data::CellEntry) -> CellSnapshot {
    CellSnapshot {
        display: match (&c.t[..], &c.v) {
            ("s", serde_json::Value::String(s)) => s.clone(),
            ("e", _) => c.e.clone().unwrap_or_else(|| "#ERROR".to_string()),
            (_, serde_json::Value::Null) => String::new(),
            (_, v) => v.to_string(),
        },
        formula: c.f.clone(),
        cell_type: c.t.clone(),
    }
}

/// "B7" -> (row 6, col 1). Zero-based, matching the grid everywhere else.
fn parse_a1(a1: &str) -> Option<(u32, u32)> {
    let mut col = 0u32;
    let mut chars = a1.chars().peekable();
    let mut any_letter = false;
    while let Some(c) = chars.peek() {
        if c.is_ascii_alphabetic() {
            col = col * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
            any_letter = true;
            chars.next();
        } else {
            break;
        }
    }
    if !any_letter {
        return None;
    }
    let rest: String = chars.collect();
    let row: u32 = rest.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col - 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wave-B B4: a checkout's collision rename now reaches rule payloads, and
    /// the push's undo of it re-renders the formulas it touches. That is
    /// spelling, not an edit -- exactly as for cells, charts and names.
    #[test]
    fn a_re_spelled_rule_formula_is_the_same_rule_and_an_edit_is_not() {
        use serde_json::json;
        let cf = |formula: &str, value1: &str| {
            json!({ "sheetId": "s", "rules": [
                { "id": 1, "rule": { "type": "expression", "formula": formula } },
                { "id": 2, "rule": { "type": "cellValue", "operator": "equal", "value1": value1 } }
            ] })
        };
        let typed = cf("=a1>data!$b$1", "abc");
        assert!(
            same_object("conditionalFormat", &typed, &cf("=A1>Data!$B$1", "abc")),
            "a re-spelled CF formula read as a changed rule"
        );
        assert!(!same_object("conditionalFormat", &typed, &cf("=A1>Data!$B$2", "abc")), "a real edit is a change");
        assert!(!same_object("conditionalFormat", &typed, &cf("=a1>data!$b$1", "ABC")), "a LITERAL bound is data");
        // An always-formula slot typed WITHOUT `=` is renamed at checkout and
        // back at push exactly like one with it (the CF evaluator parses
        // either), so its re-spelling is spelling too -- the review's demo: an
        // untouched `A1 > data!$B$1` came back `A1>Data!$B$1` and shipped as an edit.
        assert!(
            same_object("conditionalFormat", &cf("A1 > data!$B$1", "abc"), &cf("A1>Data!$B$1", "abc")),
            "an `=`-less CF formula's re-spelling read as a changed rule"
        );
        assert!(!same_object("conditionalFormat", &cf("A1 > data!$B$1", "abc"), &cf("A1>Data!$B$2", "abc")), "a real edit is a change");
        assert!(!same_object("conditionalFormat", &cf("=A1", "data!a1"), &cf("=A1", "Data!A1")), "an `=`-less bound is a literal");
        let bar = |min: &str| json!({ "sheetId": "s", "rules": [ { "id": 3, "rule": { "type": "dataBar", "minFormula": min } } ] });
        assert!(same_object("conditionalFormat", &bar("data!c1"), &bar("Data!C1")), "an `=`-less data-bar bound");

        let dv = |formula: &str| json!({ "sheetId": "s", "ranges": [ { "validation": { "rule": { "custom": { "formula": formula } } } } ] });
        assert!(same_object("dataValidation", &dv("=countif(data!a:a,a1)=1"), &dv("=COUNTIF(Data!A:A,A1)=1")));
        let ctl = |value: &str| json!({ "sheetId": "s", "controls": [ { "row": 0, "col": 0, "properties": { "text": { "valueType": "formula", "value": value } } } ] });
        assert!(same_object("control", &ctl("=data!a1"), &ctl("='Data'!A1")));
        let pane = |reference: &str| json!({ "id": "p", "config": { "type": "dropdown", "source": { "type": "cellRange", "reference": reference } } });
        assert!(same_object("paneControl", &pane("data!a1:a5"), &pane("'Data'!A1:A5")));
        assert!(!same_object("paneControl", &pane("Data!A1:A5"), &pane("Data!A1:A6")));
    }

    /// BUG-0257: the push preview named a changed button only as "control
    /// modified", with no code. A button's code is now compared per (row, col)
    /// and shown before/after, like a script's.
    ///
    /// SABOTAGE: drop the `"control"` arm of `describe_object`'s detail match
    /// (or its before/after assignment) -- the detail and texts go empty.
    #[test]
    fn a_changed_buttons_code_is_named_and_shown_before_and_after() {
        let sheet = |b4: &str, c2_macro: Option<&str>, caption: &str| {
            let mut controls = vec![serde_json::json!({
                "row": 3, "col": 1, "controlType": "button",
                "properties": {
                    "onSelect": { "valueType": "static", "value": b4 },
                    "text": { "valueType": "static", "value": caption }
                }
            })];
            if let Some(m) = c2_macro {
                controls.push(serde_json::json!({
                    "row": 1, "col": 2, "controlType": "button",
                    "properties": { "macroRef": { "valueType": "static", "value": m } }
                }));
            }
            serde_json::json!({ "sheetId": "s", "controls": controls })
        };
        let opts = DiffOptions::default();

        let before = sheet("Report();", None, "Go");
        let after = sheet("Evil();", Some("macro-x"), "Go");
        let (_, detail, b, a, _, _) = describe_object("control", "s", Some(&before), Some(&after), &Ceilings::default(), &opts);
        assert!(detail.contains("button code changed at B4"), "{detail}");
        assert!(detail.contains("button code added at C2"), "{detail}");
        let (b, a) = (b.expect("before code shown").0, a.expect("after code shown").0);
        assert!(b.contains("Report();") && !b.contains("Evil();"), "{b}");
        assert!(a.contains("Evil();") && a.contains("runs macro macro-x"), "{a}");

        // A caption edit is not a code change: no code shown, no code detail.
        let (_, detail, b, a, _, _) =
            describe_object("control", "s", Some(&sheet("Report();", None, "Go")), Some(&sheet("Report();", None, "Run")), &Ceilings::default(), &opts);
        assert!(detail.is_empty(), "{detail}");
        assert!(b.is_none() && a.is_none());

        // The empty slot every recipe button carries is not code.
        let (_, detail, _, _, _, _) =
            describe_object("control", "s", Some(&sheet("", None, "Go")), Some(&sheet("", None, "Go2")), &Ceilings::default(), &opts);
        assert!(detail.is_empty(), "{detail}");
    }

    /// A BUTTON CELL'S ACTION is shown too (BUG-0260 review): a re-pointed
    /// action names the cell and shows what it ran before and what it runs
    /// after, exactly -- it used to read as a bare "modified" on an opaque
    /// custom object. A label edit is not an action change.
    ///
    /// SABOTAGE: drop the `"customObject"` arm of `button_code` in
    /// `describe_object`.
    #[test]
    fn a_changed_button_cells_action_is_named_and_shown_before_and_after() {
        let cells = |c3: serde_json::Value, d4_label: &str| {
            serde_json::json!([
                { "row": 2, "col": 2, "typeId": "calcula.button", "params": { "label": "Go", "action": c3 } },
                { "row": 3, "col": 3, "typeId": "calcula.button", "params": { "label": d4_label } },
                { "row": 5, "col": 0, "typeId": "calcula.checkbox", "params": {} }
            ])
        };
        let opts = DiffOptions::default();
        let report = serde_json::json!({ "kind": "script", "scriptId": "macro-report" });
        let exfil = serde_json::json!({ "kind": "script", "scriptId": "macro-report", "functionName": "Exfiltrate" });

        let (_, detail, b, a, _, _) =
            describe_object("customObject", "0", Some(&cells(report.clone(), "x")), Some(&cells(exfil, "x")), &Ceilings::default(), &opts);
        assert_eq!(detail, "button action changed at C3");
        let (b, a) = (b.expect("before shown").0, a.expect("after shown").0);
        assert!(b.contains("runs macro macro-report") && !b.contains("Exfiltrate"), "{b}");
        assert!(a.contains("then calls Exfiltrate()"), "{a}");
        assert!(a.contains(r#""functionName":"Exfiltrate""#), "the exact action is shown: {a}");

        // Added and removed, and a command is named as one.
        let (_, detail, _, a, _, _) = describe_object(
            "customObject",
            "0",
            Some(&cells(serde_json::Value::Null, "x")),
            Some(&cells(serde_json::json!({ "kind": "command", "commandId": "format.bold" }), "x")),
            &Ceilings::default(),
            &opts,
        );
        assert_eq!(detail, "button action added at C3");
        assert!(a.unwrap().0.contains("runs command format.bold"));

        // A label edit changes no action: no detail, no code.
        let (_, detail, b, a, _, _) =
            describe_object("customObject", "0", Some(&cells(report.clone(), "x")), Some(&cells(report, "y")), &Ceilings::default(), &opts);
        assert!(detail.is_empty(), "{detail}");
        assert!(b.is_none() && a.is_none());

        // Another extension's custom object is left alone.
        let (_, detail, b, _, _, _) = describe_object(
            "customObject",
            "1",
            Some(&serde_json::json!({ "anything": 1 })),
            Some(&serde_json::json!({ "anything": 2 })),
            &Ceilings::default(),
            &opts,
        );
        assert!(detail.is_empty() && b.is_none());
    }

    #[test]
    fn a1_parses_to_zero_based_row_and_column() {
        assert_eq!(parse_a1("A1"), Some((0, 0)));
        assert_eq!(parse_a1("B7"), Some((6, 1)));
        assert_eq!(parse_a1("AA1"), Some((0, 26)));
        assert_eq!(parse_a1("1"), None);
        assert_eq!(parse_a1("A0"), None);
    }

    #[test]
    fn truncation_never_splits_a_character() {
        // A cap that lands inside a multi-byte character must step back rather
        // than producing invalid UTF-8 (or panicking on a slice).
        let s = "aä".repeat(40);
        let (out, truncated) = truncate(&s, 5);
        assert!(truncated);
        assert!(s.starts_with(&out));
    }

    #[test]
    fn a_short_string_is_not_marked_truncated() {
        let (out, truncated) = truncate("hello", 64);
        assert_eq!(out, "hello");
        assert!(!truncated);
    }

    fn cell(t: &str, v: serde_json::Value, f: Option<&str>) -> calcula_format::sheet_data::CellEntry {
        calcula_format::sheet_data::CellEntry {
            v,
            t: t.to_string(),
            f: f.map(|s| s.to_string()),
            e: None,
            rt: None,
            sp: None,
        }
    }

    fn sheet(cells: &[(&str, calcula_format::sheet_data::CellEntry)]) -> calcula_format::sheet_data::SheetData {
        calcula_format::sheet_data::SheetData {
            cells: cells.iter().map(|(a1, c)| (a1.to_string(), c.clone())).collect(),
        }
    }

    #[test]
    fn counts_classify_added_removed_modified_and_formula_changes() {
        let before = sheet(&[
            ("A1", cell("n", serde_json::json!(1.0), None)),
            ("A2", cell("n", serde_json::json!(2.0), Some("B1*2"))),
            ("A3", cell("s", serde_json::json!("gone"), None)),
        ]);
        let after = sheet(&[
            ("A1", cell("n", serde_json::json!(9.0), None)),      // value changed
            ("A2", cell("n", serde_json::json!(2.0), Some("B1*3"))), // formula changed
            ("A4", cell("s", serde_json::json!("new"), None)),    // added
        ]);
        let counts = count_sheet_data_changes(&before, &after);
        assert_eq!(counts.added, 1);
        assert_eq!(counts.removed, 1);
        assert_eq!(counts.modified, 2);
        assert_eq!(
            counts.formula_changes, 1,
            "a changed VALUE is not a changed formula; only A2 rewrote its formula"
        );
        assert_eq!(counts.total(), 4);
    }

    #[test]
    fn an_unchanged_sheet_counts_nothing() {
        let s = sheet(&[("A1", cell("n", serde_json::json!(1.0), None))]);
        assert_eq!(count_sheet_data_changes(&s, &s), CellChangeCounts::default());
    }

    #[test]
    fn the_sample_is_ordered_by_row_then_column_not_by_a1_string() {
        let before = sheet(&[]);
        let after = sheet(&[
            ("A10", cell("n", serde_json::json!(1.0), None)),
            ("A2", cell("n", serde_json::json!(1.0), None)),
            ("B2", cell("n", serde_json::json!(1.0), None)),
        ]);
        let (_, sample) = walk_cells(Some(&before), Some(&after), 10);
        let order: Vec<&str> = sample.iter().map(|c| c.a1.as_str()).collect();
        assert_eq!(
            order,
            vec!["A2", "B2", "A10"],
            "a person reading the table expects row 2 before row 10"
        );
    }

    #[test]
    fn the_sample_caps_while_the_counts_stay_exact() {
        let before = sheet(&[]);
        let cells: Vec<(String, calcula_format::sheet_data::CellEntry)> = (1..=100)
            .map(|r| (format!("A{r}"), cell("n", serde_json::json!(r as f64), None)))
            .collect();
        let after = calcula_format::sheet_data::SheetData {
            cells: cells.into_iter().collect(),
        };
        let (counts, sample) = walk_cells(Some(&before), Some(&after), 10);
        assert_eq!(counts.added, 100, "the COUNT is exact");
        assert_eq!(sample.len(), 10, "only the SAMPLE is capped");
    }

    #[test]
    fn keyed_items_prefers_a_stable_id_over_position() {
        let arr = serde_json::json!([
            { "id": "chart-b", "name": "B" },
            { "id": "chart-a", "name": "A" },
        ]);
        let items = keyed_domain_items("", Some(&arr)).expect("an array is keyable");
        assert!(items.contains_key("chart-a") && items.contains_key("chart-b"));
        // Reordering the array must not read as two changes.
        let reordered = serde_json::json!([
            { "id": "chart-a", "name": "A" },
            { "id": "chart-b", "name": "B" },
        ]);
        let items2 = keyed_domain_items("", Some(&reordered)).expect("keyable");
        assert_eq!(items.len(), items2.len());
        for (k, v) in &items {
            assert_eq!(items2.get(k), Some(v), "{k} must compare equal after a reorder");
        }
    }
    // ======================================================================
    // A cached result is not an edit
    // ======================================================================
    //
    // Reported from live testing: change one hard-coded number in a checked-out
    // application, push, and the diff claimed TWO cells changed — the number,
    // and the `=C2*2` beside it whose formula was identical on both sides. The
    // second row was the first row's consequence, listed as a second decision.
    //
    // A subscriber and a co-developer both recalculate on load, so for a cell
    // that carries a formula the value, type, error state and spill extent are
    // all the engine's answer, not anybody's edit.

    fn cell_sp(
        t: &str,
        v: serde_json::Value,
        f: Option<&str>,
        sp: Option<&str>,
    ) -> calcula_format::sheet_data::CellEntry {
        calcula_format::sheet_data::CellEntry {
            v,
            t: t.to_string(),
            f: f.map(|s| s.to_string()),
            e: None,
            rt: None,
            sp: sp.map(|s| s.to_string()),
        }
    }

    /// THE REPORTED DEFECT, reduced to its two cells.
    ///
    /// SABOTAGE: delete the `a.f.is_some() && a.f == b.f` branch from
    /// `cells_equal`. The count goes back to 2 and D2 reappears in the sample.
    #[test]
    fn a_recalculated_formula_cell_is_not_a_change() {
        let before = sheet(&[
            ("C2", cell("n", serde_json::json!(20.0), None)),
            ("D2", cell("n", serde_json::json!(40.0), Some("C2*2"))),
        ]);
        let after = sheet(&[
            // The edit.
            ("C2", cell("n", serde_json::json!(30.0), None)),
            // Its consequence: same formula, new cached value.
            ("D2", cell("n", serde_json::json!(60.0), Some("C2*2"))),
        ]);

        let counts = count_sheet_data_changes(&before, &after);
        assert_eq!(counts.modified, 1, "only the cell somebody typed in");
        assert_eq!(counts.total(), 1);

        let (walked, sample) = walk_cells(Some(&before), Some(&after), 10);
        assert_eq!(walked, counts, "the counted and the itemised view must agree");
        assert_eq!(sample.len(), 1);
        assert_eq!(sample[0].a1, "C2");
    }

    /// The positive control. A rewritten formula is an edit, and the diff must
    /// still say so — otherwise the rule above has simply gone blind.
    #[test]
    fn a_rewritten_formula_is_still_a_change() {
        let before = sheet(&[("D2", cell("n", serde_json::json!(40.0), Some("C2*2")))]);
        let after = sheet(&[("D2", cell("n", serde_json::json!(40.0), Some("C2*4")))]);
        let counts = count_sheet_data_changes(&before, &after);
        assert_eq!(counts.modified, 1);
        assert_eq!(counts.formula_changes, 1);
    }

    /// A LITERAL's value IS its authored content, and must keep comparing in
    /// full. The rule is scoped to cells that carry a formula.
    ///
    /// SABOTAGE: drop the `a.f.is_some()` term, so two literals with equal
    /// (None) formulas compare only their rich text — every typed number becomes
    /// invisible.
    #[test]
    fn a_literal_value_change_is_still_a_change() {
        let before = sheet(&[("A1", cell("n", serde_json::json!(1.0), None))]);
        let after = sheet(&[("A1", cell("n", serde_json::json!(2.0), None))]);
        assert_eq!(count_sheet_data_changes(&before, &after).modified, 1);
    }

    /// Replacing a formula with a hard-coded number is one of the most
    /// consequential edits there is, and `f` differing is what catches it.
    #[test]
    fn losing_or_gaining_a_formula_is_a_change() {
        let formula = sheet(&[("A1", cell("n", serde_json::json!(4.0), Some("B1*2")))]);
        let literal = sheet(&[("A1", cell("n", serde_json::json!(4.0), None))]);
        assert_eq!(
            count_sheet_data_changes(&formula, &literal).modified,
            1,
            "a formula replaced by its own current value is still an edit"
        );
        assert_eq!(count_sheet_data_changes(&literal, &formula).modified, 1);
    }

    /// Rich text is authored even on a formula cell, so it survives the rule.
    ///
    /// SABOTAGE: `return true` in the formula branch instead of comparing `rt`.
    #[test]
    fn rich_text_on_an_unchanged_formula_is_a_change() {
        let plain = cell("s", serde_json::json!("x"), Some("A1"));
        let mut styled = plain.clone();
        // Deserialized rather than constructed: `RichTextRun` lives in `engine`
        // and is re-exported into the entry, so this test does not need to name
        // the type or track its fields.
        styled.rt = Some(
            serde_json::from_value(serde_json::json!([{ "text": "x", "bold": true }])).unwrap(),
        );
        assert_eq!(
            count_sheet_data_changes(&sheet(&[("B1", plain)]), &sheet(&[("B1", styled)])).modified,
            1
        );
    }

    /// An ERROR appearing in a formula cell is derived too — the formula did not
    /// change, its input did, and that input is reported on its own row.
    #[test]
    fn a_formula_cell_that_started_erroring_is_not_itself_a_change() {
        let before = sheet(&[
            ("A1", cell("n", serde_json::json!(2.0), None)),
            ("B1", cell("n", serde_json::json!(5.0), Some("10/A1"))),
        ]);
        let mut errored = cell("e", serde_json::json!(null), Some("10/A1"));
        errored.e = Some("#DIV/0!".to_string());
        let after = sheet(&[
            ("A1", cell("n", serde_json::json!(0.0), None)),
            ("B1", errored),
        ]);
        let counts = count_sheet_data_changes(&before, &after);
        assert_eq!(counts.modified, 1, "the input, not the error it caused");
    }

    // ----------------------------------------------------------------------
    // The spill sibling
    // ----------------------------------------------------------------------

    /// A spilled cell carries no formula, so it is indistinguishable from a
    /// literal on its own — but everything inside an unchanged origin's extent
    /// is that origin's output. Without this, editing one input to a spilling
    /// formula reports the whole block.
    ///
    /// SABOTAGE: make `unchanged_spill_cells` return an empty set.
    #[test]
    fn the_output_of_an_unchanged_spill_is_not_a_change() {
        let before = sheet(&[
            ("A1", cell("n", serde_json::json!(3.0), None)),
            ("C1", cell_sp("n", serde_json::json!(1.0), Some("SEQUENCE(A1)"), Some("C1:C3"))),
            ("C2", cell("n", serde_json::json!(2.0), None)),
            ("C3", cell("n", serde_json::json!(3.0), None)),
        ]);
        let after = sheet(&[
            ("A1", cell("n", serde_json::json!(3.0), None)),
            ("C1", cell_sp("n", serde_json::json!(10.0), Some("SEQUENCE(A1)"), Some("C1:C3"))),
            ("C2", cell("n", serde_json::json!(20.0), None)),
            ("C3", cell("n", serde_json::json!(30.0), None)),
        ]);
        let counts = count_sheet_data_changes(&before, &after);
        assert_eq!(counts.total(), 0, "the origin's formula and extent both held");

        let (walked, sample) = walk_cells(Some(&before), Some(&after), 10);
        assert_eq!(walked, counts, "the two views must agree about spills too");
        assert!(sample.is_empty());
    }

    /// A spill whose extent moved is compared normally. The skip is scoped to an
    /// origin whose formula AND extent both held.
    ///
    /// THE SHRINK DIRECTION, and the reason is that this test had NO TEETH in
    /// the grow direction. It first read: extent `C1:C2` -> `C1:C3`, asserting
    /// `counts.total() > 0`. Under the named sabotage (compare only the formula,
    /// not `sp`) the skip set is built from the BEFORE extent, which covers `C2`
    /// only — `C3` is absent from `before.cells`, so it is counted as `added`,
    /// the total is 1, and the assertion passed. The session's own adversarial
    /// review applied that exact sabotage and the test stayed green.
    ///
    /// Shrinking is where the defect actually bites: the origin keeps its
    /// formula, `sp` goes `C1:C3` -> `C1:C2`, and the author types a literal
    /// into the freed `C3`. Under the sabotage `C3` is still inside the
    /// before-extent, so an AUTHORED value is skipped and the diff says nothing
    /// changed.
    ///
    /// And it asserts on the IDENTITY of the reported cell, not on a count — a
    /// count is what let the grow version pass for the wrong reason.
    ///
    /// SABOTAGE: in `unchanged_spill_cells`, compare only `a.f != b.f` and drop
    /// the `a.sp.as_ref() != Some(sp)` term.
    #[test]
    fn a_literal_typed_into_a_shrunken_spill_is_a_change() {
        let before = sheet(&[
            ("C1", cell_sp("n", serde_json::json!(1.0), Some("SEQUENCE(A1)"), Some("C1:C3"))),
            ("C2", cell("n", serde_json::json!(2.0), None)),
            ("C3", cell("n", serde_json::json!(3.0), None)),
        ]);
        let after = sheet(&[
            ("C1", cell_sp("n", serde_json::json!(1.0), Some("SEQUENCE(A1)"), Some("C1:C2"))),
            ("C2", cell("n", serde_json::json!(2.0), None)),
            // The array no longer reaches C3; this is something a person typed.
            ("C3", cell("s", serde_json::json!("typed"), None)),
        ]);

        let (_, sample) = walk_cells(Some(&before), Some(&after), 10);
        assert!(
            sample.iter().any(|c| c.a1 == "C3"),
            "an authored value in a cell the array released must be reported, \
             not skipped as spill output: {:?}",
            sample.iter().map(|c| &c.a1).collect::<Vec<_>>()
        );
    }

    /// A spill that GREW: its new cells are authored output of a CHANGED extent,
    /// so they are compared normally too. Kept as the sibling direction, with an
    /// identity assertion rather than the count that made it toothless.
    #[test]
    fn a_grown_spill_reports_the_cells_it_now_covers() {
        let before = sheet(&[
            ("C1", cell_sp("n", serde_json::json!(1.0), Some("SEQUENCE(A1)"), Some("C1:C2"))),
            ("C2", cell("n", serde_json::json!(2.0), None)),
        ]);
        let after = sheet(&[
            ("C1", cell_sp("n", serde_json::json!(1.0), Some("SEQUENCE(A1)"), Some("C1:C3"))),
            ("C2", cell("n", serde_json::json!(2.0), None)),
            ("C3", cell("n", serde_json::json!(3.0), None)),
        ]);
        let (_, sample) = walk_cells(Some(&before), Some(&after), 10);
        assert!(sample.iter().any(|c| c.a1 == "C3"));
    }

    /// A publisher-controlled `sp` may not be an unbounded loop.
    ///
    /// `range_from_a1` applies no ceiling and the integrity walk does not
    /// sanity-check artifact contents, so `sp: "A1:XFD1048576"` was 17 billion
    /// BTreeSet inserts inside a function every diff surface calls. Past the cap
    /// the extent is not skipped — noisier, never wrong.
    ///
    /// SABOTAGE: delete the MAX_SPILL_CELLS guard. This test then hangs rather
    /// than failing, which is itself the point.
    #[test]
    fn an_absurd_spill_extent_is_not_walked() {
        let before = sheet(&[(
            "A1",
            cell_sp("n", serde_json::json!(1.0), Some("SEQUENCE(1)"), Some("A1:XFD1048576")),
        )]);
        let mut after_cells = before.clone();
        after_cells
            .cells
            .insert("B2".to_string(), cell("s", serde_json::json!("typed"), None));

        let counts = count_sheet_data_changes(&before, &after_cells);
        assert_eq!(
            counts.added, 1,
            "past the cap the extent is simply not skipped, so B2 is an ordinary added cell"
        );
    }

}
