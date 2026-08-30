//! FILENAME: core/calp/src/diff.rs
//! PURPOSE: What changed between two versions of a package — or between a
//! working copy and the version it was authored against.
//! CONTEXT: The registry has always kept every version, but nothing could say
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
use crate::transport::RegistryTransport;

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

/// One side of a comparison: a published version, or an in-memory artifact set.
///
/// The in-memory arm is what lets the push dialog show "what your push changes"
/// without publishing anything: the app runs the REAL publish pipeline against
/// an in-memory transport and hands the result here, so the preview can never
/// describe a package different from the one a push would write.
pub enum DiffSide<'a> {
    Published {
        transport: &'a dyn RegistryTransport,
        package: &'a str,
        version: &'a str,
        manifest: &'a VersionManifest,
    },
    InMemory {
        manifest: &'a VersionManifest,
        /// `rel_path -> bytes`.
        artifacts: &'a BTreeMap<String, Vec<u8>>,
    },
}

impl<'a> DiffSide<'a> {
    pub fn manifest(&self) -> &VersionManifest {
        match self {
            DiffSide::Published { manifest, .. } => manifest,
            DiffSide::InMemory { manifest, .. } => manifest,
        }
    }

    /// The signed checksum map for a published side; a computed one in memory.
    fn checksums(&self) -> BTreeMap<String, String> {
        match self {
            DiffSide::Published { manifest, .. } => manifest.artifact_checksums.clone(),
            DiffSide::InMemory { artifacts, .. } => artifacts
                .iter()
                .map(|(rel, bytes)| (rel.clone(), crate::integrity::sha256_hex(bytes)))
                .collect(),
        }
    }

    fn read(&self, rel: &str) -> Result<Option<Vec<u8>>, CalpError> {
        match self {
            DiffSide::Published { transport, package, version, .. } => {
                transport.read_artifact(package, version, rel)
            }
            DiffSide::InMemory { artifacts, .. } => Ok(artifacts.get(rel).cloned()),
        }
    }

    fn label(&self) -> String {
        match self {
            DiffSide::Published { version, .. } => (*version).to_string(),
            DiffSide::InMemory { .. } => "working copy".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// Budgets, so a diff of a large package stays a bounded operation.
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
    /// Map a working copy's LOCAL sheet ids onto the package's ids.
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
    /// "paneControl", "slicer", "ribbonFilter", "pivot", "pivotLayout",
    /// "customObject", "media", "conditionalFormat", "dataValidation",
    /// "comment", "scenario", "outline", "cellBehavior", "theme",
    /// "extensionData", "writebackRegion", "modelWriteback", or "artifact" for
    /// anything a future version adds that this build does not recognise.
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetDiffSummary {
    /// The PACKAGE sheet id (after any working-copy remap).
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

/// Compare two sides of a package.
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
    // publisher identity, the compat floor.
    let manifest_changes = diff_manifest_fields(from.manifest(), to.manifest());
    diff_writeback_declarations(from.manifest(), to.manifest(), &mut objects);

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

/// Count cell changes between two parsed sheet payloads. Allocates nothing per
/// change, so the refresh preview can afford to call it.
pub fn count_sheet_data_changes(
    before: &calcula_format::sheet_data::SheetData,
    after: &calcula_format::sheet_data::SheetData,
) -> CellChangeCounts {
    let mut counts = CellChangeCounts::default();
    for (a1, b) in &before.cells {
        match after.cells.get(a1) {
            None => counts.removed += 1,
            Some(a) => {
                if !cells_equal(b, a) {
                    counts.modified += 1;
                    if b.f != a.f {
                        counts.formula_changes += 1;
                    }
                }
            }
        }
    }
    for a1 in after.cells.keys() {
        if !before.cells.contains_key(a1) {
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
    /// local sheet id -> package sheet id.
    sheet_id_map: &'a HashMap<String, String>,
    /// package sheet id -> local sheet id. The inverse, because paths are
    /// COMPARED in package space but must be READ from the `to` side in its own
    /// space — a working copy that came from a pull stores its sheets under the
    /// local ids the pull minted.
    reverse_sheet_ids: HashMap<String, String>,
    sheets: BTreeMap<String, SheetDiffSummary>,
    objects: Vec<ObjectChange>,
    parsed_sheet_artifacts: usize,
    spurious: usize,
}

impl DiffContext<'_, '_> {
    /// A path in package space, translated to how the `to` side stores it.
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

        // Media never enters the payload as bytes — a package can carry
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
        // a diff that silently omits a package's newest artifact type is a diff
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
                    if before.is_none() && after.is_none() && presence == Presence::Changed {
                        Outcome::CountsInexact
                    } else {
                        self.parsed_sheet_artifacts += 1;
                        let (counts, sample) = walk_cells(
                            before.as_ref(),
                            after.as_ref(),
                            self.opts.sample_cells_per_sheet,
                        );
                        if counts.total() == 0 && presence == Presence::Changed {
                            Outcome::Spurious
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
        if presence == Presence::Changed && before == after {
            self.spurious += 1;
            return Ok(false);
        }

        let (name, detail, before_src, after_src, caps_added, caps_removed) =
            describe_object(domain, id, before.as_ref(), after.as_ref(), self.opts);

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

        let before_items = keyed_items(before.as_ref());
        let after_items = keyed_items(after.as_ref());
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
                (Some(x), Some(y)) if x != y => Presence::Changed,
                _ => continue,
            };
            let (name, detail, before_src, after_src, caps_added, caps_removed) =
                describe_object(domain, key, b.copied(), a.copied(), self.opts);
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Rewrite `sheets/{local}/…` paths to `sheets/{package}/…` so a working copy
/// whose sheets were minted by a pull lines up with the package it came from.
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
    // whose pin no longer matches is exactly the "package hijack" signal.
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

/// A JSON array of objects, keyed by whichever id-ish field it carries.
fn keyed_items(value: Option<&serde_json::Value>) -> Option<BTreeMap<String, &serde_json::Value>> {
    let arr = value?.as_array()?;
    let mut out = BTreeMap::new();
    for (i, item) in arr.iter().enumerate() {
        let key = item
            .get("id")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("sheetId").and_then(|v| v.as_str()))
            .or_else(|| item.get("sheet_id").and_then(|v| v.as_str()))
            .or_else(|| item.get("name").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
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

fn describe_object(
    domain: &str,
    id: &str,
    before: Option<&serde_json::Value>,
    after: Option<&serde_json::Value>,
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
    let (before_src, after_src) = match source_field {
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

    let before_caps = capability_set(before);
    let after_caps = capability_set(after);
    let added_capabilities: Vec<String> =
        after_caps.difference(&before_caps).cloned().collect();
    let removed_capabilities: Vec<String> =
        before_caps.difference(&after_caps).cloned().collect();

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
            if !added_capabilities.is_empty() {
                format!("source changed; gains {}", added_capabilities.join(", "))
            } else {
                "source changed".to_string()
            }
        }
        _ => String::new(),
    };

    (name, detail, before_src, after_src, added_capabilities, removed_capabilities)
}

fn capability_set(v: Option<&serde_json::Value>) -> BTreeSet<String> {
    v.and_then(|v| v.get("capabilities"))
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
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
/// same two facts the Package Inspector had to learn. Both spellings are tried
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

fn truncate(s: &str, max: usize) -> (String, bool) {
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
fn walk_cells(
    before: Option<&calcula_format::sheet_data::SheetData>,
    after: Option<&calcula_format::sheet_data::SheetData>,
    sample_cap: usize,
) -> (CellChangeCounts, Vec<CellDiff>) {
    let empty = calcula_format::sheet_data::SheetData { cells: BTreeMap::new() };
    let before = before.unwrap_or(&empty);
    let after = after.unwrap_or(&empty);

    let mut counts = CellChangeCounts::default();
    let mut sample: Vec<CellDiff> = Vec::new();
    let keys: BTreeSet<&String> = before.cells.keys().chain(after.cells.keys()).collect();
    // Sorted by (row, col) rather than by A1 string, so "A10" does not sort
    // before "A2" in a table a person reads.
    let mut ordered: Vec<(&String, (u32, u32))> = keys
        .into_iter()
        .filter_map(|a1| parse_a1(a1).map(|rc| (a1, rc)))
        .collect();
    ordered.sort_by_key(|(_, rc)| *rc);

    for (a1, (row, col)) in ordered {
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
                if x.f != y.f {
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

fn cells_equal(
    a: &calcula_format::sheet_data::CellEntry,
    b: &calcula_format::sheet_data::CellEntry,
) -> bool {
    a.t == b.t && a.v == b.v && a.f == b.f && a.e == b.e && a.sp == b.sp && a.rt == b.rt
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
        let items = keyed_items(Some(&arr)).expect("an array is keyable");
        assert!(items.contains_key("chart-a") && items.contains_key("chart-b"));
        // Reordering the array must not read as two changes.
        let reordered = serde_json::json!([
            { "id": "chart-a", "name": "A" },
            { "id": "chart-b", "name": "B" },
        ]);
        let items2 = keyed_items(Some(&reordered)).expect("keyable");
        assert_eq!(items.len(), items2.len());
        for (k, v) in &items {
            assert_eq!(items2.get(k), Some(v), "{k} must compare equal after a reorder");
        }
    }
}
