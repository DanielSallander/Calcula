//! FILENAME: core/calp/src/manifest.rs
//! PURPOSE: .calp manifest types — application-level and version-level.

use std::collections::{BTreeMap, HashMap};

use identity::{EntityId, SheetId};
use serde::{Deserialize, Serialize};
use crate::error::CalpError;
use crate::version::SemVer;

/// Application-level manifest (calp-manifest.json).
/// Lives at the root of an application directory. Lists all published versions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationManifest {
    pub format_version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Application kind: "report", "template", or "dataset".
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
    pub created: String,
    pub versions: Vec<VersionEntry>,
    /// The ordered promotion pipeline and each environment's current pointer.
    ///
    /// A LISTING CONVENIENCE, exactly like `VersionEntry.base_version` below:
    /// it renders a browse list from one manifest read, and an HTTP workspace
    /// can serve it without the application-artifact route. The AUTHORITY is
    /// the signed `promotions.json`, which `environments::resolve_environment`
    /// folds; nothing resolves through this field. It is written second, after
    /// the log, so a crash leaves a stale listing over a correct authority.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environments: Vec<crate::environments::Environment>,
    /// Sequence of the last promotion record. The optimistic-concurrency token
    /// a pipeline edit carries, so two admins cannot lose each other's change.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub promotion_sequence: u64,
    /// Forward-compatibility: preserves unknown fields from future format versions.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

fn is_zero(n: &u64) -> bool { *n == 0 }

fn default_kind() -> String { "report".to_string() }

/// An entry in the application manifest's version list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub version: String,
    pub published_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub published_by: String,
    /// The version this push was based on (empty for the first version of an
    /// application). A listing convenience so the version-history UI renders
    /// lineage from ONE application-manifest read; the authority is the same field
    /// inside the SIGNED version manifest, which this copies.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base_version: String,
    /// The push message — what changed and why. Copied from the signed version
    /// manifest for the same reason as `base_version`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub change_summary: String,
    /// Ed25519 public key of whoever signed this version, lowercase hex.
    /// `published_by` beside it is a display name and is not verified; this is.
    /// Listing convenience only — the signed version manifest is the authority.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub publisher_key: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

impl ApplicationManifest {
    pub fn new(name: &str, kind: &str, author: &str, now: &str) -> Self {
        Self {
            format_version: 1,
            name: name.to_string(),
            description: String::new(),
            kind: kind.to_string(),
            author: author.to_string(),
            created: now.to_string(),
            versions: Vec::new(),
            environments: Vec::new(),
            promotion_sequence: 0,
            extra: HashMap::new(),
        }
    }

    /// Get all version strings parsed as SemVer.
    pub fn parsed_versions(&self) -> Vec<SemVer> {
        self.versions.iter()
            .filter_map(|e| SemVer::parse(&e.version).ok())
            .collect()
    }

    /// Get the latest version entry (last in the list).
    pub fn latest_version(&self) -> Option<&VersionEntry> {
        self.versions.last()
    }
}

/// Version-level manifest (version-manifest.json).
/// Describes the content of a specific published version.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionManifest {
    pub format_version: u32,
    pub package_name: String,
    pub version: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub published_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub published_by: String,
    /// Ed25519 public (verifying) key of the publisher, lowercase hex of the
    /// 32-byte key (S5 phase 2). The subscriber learns the ASSERTED signer
    /// from this. Old manifests without it still parse (serde default), but
    /// signature verification on pull REQUIRES it — an empty value is rejected
    /// as MissingSignature. Detached signature lives in `version-manifest.sig`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub publisher_key: String,
    /// Human-readable publisher display name (typically the OS username),
    /// surfaced to the subscriber alongside the trust decision. Display only —
    /// never used for verification (only `publisher_key` is).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub publisher_name: String,
    /// Minimum host app version (semver) required to open this version. Empty =
    /// no minimum (older applications / publishers who don't opt in). Checked at
    /// pull (compat.rs): an older Calcula is refused with an "update the app"
    /// error instead of a silent/partial failure. Covered by the manifest's
    /// Ed25519 signature.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub min_app_version: String,
    /// The version this push was based on — the workspace head the author's
    /// working copy was checked out from (or last merged with). Empty for the
    /// first version of an application, and for publishes made outside the workspace
    /// flow. Inside the Ed25519 signature, so lineage cannot be rewritten by
    /// editing a file on the share.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base_version: String,
    /// What changed in this version, in the author's own words. Required for a
    /// push to an existing application (see `PushMode::Update`); optional when
    /// an application is first created. Signed, like `base_version`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub change_summary: String,
    pub sheets: Vec<PublishedSheet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub named_ranges: Vec<PublishedNamedRange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tables: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locked_sheets: Vec<SheetId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locked_cells: Vec<LockedCell>,
    /// Writeback region declarations. Present when the publisher designates
    /// regions as subscriber-fillable. v1.0 parses and round-trips these but
    /// does not interpret the semantic sub-fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writeback_regions: Option<Vec<crate::writeback::WritebackRegionDeclaration>>,
    /// Model writeback COLUMN declarations (engine v21 writeback columns,
    /// distributed): submissions keyed by host-row key values instead of grid
    /// coordinates. Absent for applications without writeback columns; pre-feature
    /// apps ignore it (they only consult `writeback_regions`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_writebacks: Option<Vec<crate::writeback::ModelWritebackDeclaration>>,
    /// Object scripts bundled with the application. Scripts travel with the application
    /// and are loaded on the subscriber side. Subscribers cannot edit these
    /// scripts but can add their own script layers on top.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_scripts: Vec<PublishedObjectScript>,
    /// Standalone module scripts bundled with the application (C8). Unlike object
    /// scripts these are inert, transparent data: materialized into the
    /// subscriber's workbook on pull but NEVER auto-executed — they run only on
    /// explicit user action in the sandboxed Rust QuickJS interpreter. No
    /// provenance/access-level/capability fields: they are distributed as-is and
    /// covered by the same Ed25519 signing + SHA-256 integrity as every other
    /// artifact.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub module_scripts: Vec<PublishedModuleScript>,
    /// Standalone notebooks bundled with the application (C8). Inert, transparent
    /// data like module_scripts. Notebook execution metadata (outputs, errors,
    /// timings, execution indices) is STRIPPED at publish time — only cell
    /// id + source ship — so cached output can never leak in an application.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notebooks: Vec<PublishedNotebook>,
    /// Data source definitions for live data. Each data source embeds a BI
    /// model and table bindings; subscribers refresh against the original
    /// database through pivots (and CUBE formulas, planned).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_sources: Vec<ApplicationDataSource>,
    /// Generic custom objects (distribution brick 4): the OPEN channel for
    /// object families beyond the built-in set. Each entry names a `kind`
    /// (registered by an extension, or a built-in like "cellType"), a stable
    /// id, and a version-relative `payload_path` whose artifact is opaque
    /// app-owned JSON. Optional + forward-compatible: an older reader that does
    /// not know a kind ignores it; the payload is still integrity-checked like
    /// every other artifact. This is how a third party's own object definitions
    /// (e.g. a custom pivot's config) travel in an application.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_objects: Vec<PublishedCustomObject>,
    /// SHA-256 checksums (lowercase hex) of every artifact in the version
    /// directory, keyed by version-dir-relative path with forward slashes
    /// (e.g. "sheets/{sheet_id}/data.json"). The version manifest itself is
    /// NOT listed — it is the integrity root and is written last on publish.
    /// Subscriber-written content ("submissions/") is excluded: it is a
    /// separate trust domain and arrives after publish.
    /// BTreeMap keeps serialization deterministic.
    /// Verified on every pull (and therefore on refresh, which shares the
    /// pull machinery). An empty map means the application predates integrity
    /// checksums and is rejected on pull — republish to fix.
    /// Phase 2 (S5) adds an Ed25519 signature over the raw manifest bytes
    /// to make this root tamper-proof — see integrity.rs.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub artifact_checksums: BTreeMap<String, String>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A generic custom object bundled with a .calp application (distribution brick 4).
/// The manifest entry; the payload lives at `payload_path` as opaque JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedCustomObject {
    /// The object kind (extension-registered, or a built-in like "cellType").
    pub kind: String,
    /// Stable object id (idempotent across versions).
    pub id: String,
    /// Human-readable name (shown in the application explorer / subscriber ledger).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// For per-sheet objects: the APPLICATION sheet id (remapped to a local sheet on
    /// pull, like controls/CF/DV). None for workbook-scoped objects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_id: Option<SheetId>,
    /// Version-relative artifact path (forward slashes), e.g.
    /// "custom_objects/cellType/{id}.json".
    pub payload_path: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// An object script bundled with a .calp application.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedObjectScript {
    /// Script ID (stable across versions).
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Object type: "workbook", "sheet", "cell", "slicer", etc.
    pub object_type: String,
    /// For component objects: the instance ID. None for primitive objects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// Script description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The capability ids this script declares it needs (R19 ceiling). Lifted
    /// from the script source `// @capability <id>` pragmas at publish time.
    /// This is the publisher's authoritative declaration of what the application's
    /// scripts may use; the subscriber sets each pulled script's ceiling from
    /// THIS list, never from the (tamperable) source. Recognized ids:
    /// persistence::KNOWN_CAPABILITY_IDS.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

/// A standalone module script bundled with a .calp application (C8).
/// Module scripts are inert, transparent data — the manifest entry exists so
/// the subscriber can list/review them BEFORE pulling and locate the on-disk
/// artifact (`modules/{id}.json`). No provenance/access-level/capability
/// fields: module scripts run only on explicit user action, sandboxed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedModuleScript {
    /// Script ID (stable across versions). Names the `modules/{id}.json` file.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Scope: "workbook" or a sheet name. Lifted from the script's scope so the
    /// pre-pull review can show where the script attaches.
    pub scope: String,
    /// Script description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A standalone notebook bundled with a .calp application (C8).
/// Inert, transparent data. The manifest entry locates the on-disk artifact
/// (`notebooks/{id}.json`) and lets the subscriber review the notebook BEFORE
/// pulling. Execution metadata is stripped from the artifact at publish time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedNotebook {
    /// Notebook ID (stable across versions). Names the `notebooks/{id}.json` file.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Number of cells in the notebook (surfaced in the pre-pull review).
    pub cell_count: usize,
    /// Notebook description, if any. Notebooks have no description field today,
    /// so this is reserved for forward compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A sheet entry in the version manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSheet {
    pub sheet_id: SheetId,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Per-sheet presentation metadata carried in an application (D9 — content fidelity).
/// Written as `sheets/{sheet_id}/metadata.json` at publish and restored at pull.
/// Without this a subscriber's sheets lost their merged headers, freeze panes,
/// notes, hyperlinks, hidden rows/cols, tab color and print setup. Mirrors the
/// `persistence::Sheet` metadata fields; an older application without this file
/// falls back to the (correct) per-field defaults at pull.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSheetMetadata {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merged_regions: Vec<persistence::SavedMergedRegion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze_row: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze_col: Option<u32>,
    /// EFFECTIVE hidden rows (filter + outline + user), what the HTML report
    /// exporter skips.
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub hidden_rows: std::collections::BTreeSet<u32>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub hidden_cols: std::collections::BTreeSet<u32>,
    /// Rows/columns the user hid BY HAND, carried separately so a subscriber
    /// can unhide them by hand too (the effective set above is rebuilt from
    /// filter+outline and would lose them on the first save).
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub user_hidden_rows: std::collections::BTreeSet<u32>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub user_hidden_cols: std::collections::BTreeSet<u32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tab_color: String,
    #[serde(default = "default_visibility")]
    pub visibility: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<persistence::SavedNote>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hyperlinks: Vec<persistence::SavedHyperlink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_setup: Option<persistence::SavedPageSetup>,
    #[serde(default = "default_true")]
    pub show_gridlines: bool,
    /// Per-sheet zoom as a REAL PERCENT (100 = 100%). Carried so a published
    /// report opens at the zoom its author designed it for.
    #[serde(default = "default_zoom", skip_serializing_if = "is_default_zoom")]
    pub zoom: f64,
    /// Split-bar row/column (see the .cala `SheetMetadata`; a split is not a
    /// freeze).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_row: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_col: Option<u32>,
    /// Per-sheet DISPLAY FLAGS, carried so a published report opens in the display
    /// mode its author designed it for (a formulas-visible review sheet stays that
    /// way; a zeros-hidden summary does not sprout zeros for the subscriber).
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub display_zeros: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub show_formulas: bool,
    #[serde(default = "default_view_mode", skip_serializing_if = "is_default_view_mode")]
    pub view_mode: String,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub display_headings: bool,
}

fn default_view_mode() -> String {
    persistence::DEFAULT_SHEET_VIEW_MODE.to_string()
}
fn is_default_view_mode(v: &str) -> bool {
    v == persistence::DEFAULT_SHEET_VIEW_MODE
}
fn is_true(v: &bool) -> bool {
    *v
}
fn is_false(v: &bool) -> bool {
    !*v
}

fn default_zoom() -> f64 {
    persistence::DEFAULT_SHEET_ZOOM_PERCENT
}
fn is_default_zoom(v: &f64) -> bool {
    (*v - persistence::DEFAULT_SHEET_ZOOM_PERCENT).abs() < 1e-9
}

fn default_visibility() -> String {
    "visible".to_string()
}
fn default_true() -> bool {
    true
}

impl Default for PublishedSheetMetadata {
    fn default() -> Self {
        Self {
            merged_regions: Vec::new(),
            freeze_row: None,
            freeze_col: None,
            hidden_rows: std::collections::BTreeSet::new(),
            hidden_cols: std::collections::BTreeSet::new(),
            user_hidden_rows: std::collections::BTreeSet::new(),
            user_hidden_cols: std::collections::BTreeSet::new(),
            tab_color: String::new(),
            visibility: "visible".to_string(),
            notes: Vec::new(),
            hyperlinks: Vec::new(),
            page_setup: None,
            show_gridlines: true,
            zoom: persistence::DEFAULT_SHEET_ZOOM_PERCENT,
            split_row: None,
            split_col: None,
            display_zeros: true,
            show_formulas: false,
            view_mode: default_view_mode(),
            display_headings: true,
        }
    }
}

impl PublishedSheetMetadata {
    /// Build from a workbook sheet at publish time.
    pub fn from_sheet(sheet: &persistence::Sheet) -> Self {
        Self {
            merged_regions: sheet.merged_regions.clone(),
            freeze_row: sheet.freeze_row,
            freeze_col: sheet.freeze_col,
            hidden_rows: sheet.hidden_rows.iter().copied().collect(),
            hidden_cols: sheet.hidden_cols.iter().copied().collect(),
            user_hidden_rows: sheet.user_hidden_rows.iter().copied().collect(),
            user_hidden_cols: sheet.user_hidden_cols.iter().copied().collect(),
            tab_color: sheet.tab_color.clone(),
            visibility: sheet.visibility.clone(),
            notes: sheet.notes.clone(),
            hyperlinks: sheet.hyperlinks.clone(),
            page_setup: sheet.page_setup.clone(),
            show_gridlines: sheet.show_gridlines,
            zoom: sheet.zoom,
            split_row: sheet.split_row,
            split_col: sheet.split_col,
            display_zeros: sheet.display_zeros,
            show_formulas: sheet.show_formulas,
            view_mode: sheet.view_mode.clone(),
            display_headings: sheet.display_headings,
        }
    }

    /// Total count of presentation features carried (for the disclosure surface).
    pub fn feature_count(&self) -> usize {
        self.merged_regions.len()
            + self.notes.len()
            + self.hyperlinks.len()
            + self.hidden_rows.len()
            + self.hidden_cols.len()
            + usize::from(self.freeze_row.is_some() || self.freeze_col.is_some())
            + usize::from(!self.tab_color.is_empty())
            + usize::from(self.page_setup.is_some())
    }
}

/// A named range included in the published application.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedNamedRange {
    pub name: String,
    pub refers_to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_id: Option<SheetId>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

// ===========================================================================
// Data Source types (live .calp applications)
// ===========================================================================

/// A data source definition embedded in a .calp application version.
/// Embeds a BI model and table bindings; data reaches subscribers through
/// pivots (and CUBE formulas, planned).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataSource {
    /// Stable UUID for this data source within the application.
    pub id: String,
    /// Human-readable name (e.g., "Sales Database").
    pub name: String,
    /// Connection type: "PostgreSQL", "SqlServer".
    pub connection_type: String,
    /// Server host (or host:port). No credentials.
    pub server: String,
    /// Database name.
    pub database: String,
    /// Relative path to embedded DataModel JSON: "models/{id}/model.json".
    pub model_path: String,
    /// Table bindings: logical model tables -> physical database tables.
    pub bindings: Vec<TableBinding>,
    /// Materialized calculated-table snapshots carried in the application (Arrow
    /// IPC stream artifacts under "models/{id}/calculated_tables/"), so a
    /// subscriber without source access still sees the derived tables' data.
    /// Empty for models without materialized calculated tables (and for
    /// applications published before the feature existed).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calculated_table_snapshots: Vec<CalculatedTableSnapshotRef>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// One materialized calculated table's snapshot artifact in an application.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedTableSnapshotRef {
    /// The derived model table's name.
    pub table: String,
    /// Relative artifact path (Arrow IPC stream bytes).
    pub path: String,
}

/// Maps a logical model table to a physical database table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableBinding {
    /// Logical table name in the BI model.
    pub model_table: String,
    /// Database schema (e.g., "public", "dbo").
    pub schema: String,
    /// Physical table name in the database.
    pub source_table: String,
    /// When set, the table's rows come from this SQL SELECT (a wrapped subquery)
    /// rather than `schema.source_table`. Defaulted so older applications load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_query: Option<String>,
}

/// Subscriber-local connection configuration for a data source.
/// Stored in the .cala file (never in the shared workspace).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriberDataSourceConfig {
    /// Which data source this config applies to.
    pub data_source_id: String,
    /// The subscriber's full connection string (may include credentials).
    pub connection_string: String,
    /// When the subscriber last successfully connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected: Option<String>,
}

/// A cell marked as locked-no-override.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedCell {
    pub sheet_id: SheetId,
    pub cell_id: identity::CellId,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Subscription metadata stored in a .cala file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionManifest {
    pub format_version: u32,
    pub subscriptions: Vec<Subscription>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

impl Default for SubscriptionManifest {
    fn default() -> Self {
        Self {
            format_version: 1,
            subscriptions: Vec::new(),
            extra: HashMap::new(),
        }
    }
}

/// A single subscription entry within a .cala workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub package_name: String,
    pub registry_url: String,
    pub version_pin: String,
    pub resolved_version: String,
    pub resolved_at: String,
    pub sheets: Vec<SubscribedSheet>,
    /// Which ENVIRONMENT this subscription follows.
    ///
    /// `None` follows the development line through `version_pin`, as every
    /// subscription did before environments existed. `Some(name)` resolves
    /// through the application's verified promotion log, and `version_pin` is
    /// then EMPTY — see [`Subscription::target`].
    ///
    /// An `Option` rather than a string whose emptiness carries meaning, because
    /// the field this replaces was exactly that and nothing ever read it: a
    /// `channel: String` documented as "dev/test/staging/prod", written as `""`
    /// or `"dev"`, with no reader anywhere. An `Option` makes "follows the line"
    /// a state every `match` must handle, and it cannot collide with the
    /// `version_pin == "dev"` sentinel the local preview uses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// Subscriber-local connection configurations for data sources.
    /// Stored in the .cala file, never in the shared workspace.
    /// Contains the subscriber's connection strings (may include credentials).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_source_configs: Vec<SubscriberDataSourceConfig>,
    /// Provenance ledger: every object this subscription materialized into the
    /// local workbook (tables, charts, pivots, named ranges, scripts, data
    /// sources, control sheets). Written at pull, updated at refresh. This is
    /// what lets the UI show "which objects are connected to this application" and
    /// lets refresh replace exactly the application-owned objects without touching
    /// subscriber-authored ones.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<SubscribedObject>,
    /// APPLICATION sheet ids the subscriber has deliberately DETACHED — made
    /// their own, and no longer refreshed.
    ///
    /// A tombstone, because dropping the `SubscribedSheet` entry alone is not
    /// enough: the subscription still covers the application, so the next refresh
    /// would see the sheet as newly added and re-materialize it beside the
    /// detached copy as `Sheet1 (2)`. Detach has to mean detached.
    ///
    /// No `.cala` format bump: an older reader that drops this re-adds a sheet on
    /// refresh, which is visible annoyance rather than a misreading — and
    /// `extra`'s flatten preserves it verbatim across a save anyway.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub detached_sheets: Vec<SheetId>,
    /// Sheets the UPSTREAM version dropped while this workbook kept them.
    ///
    /// A SEPARATE LIST FROM `detached_sheets`, and the separation is the whole
    /// point. Both used to share one reason-less list, so a sheet the publisher
    /// removed became indistinguishable from one the user deliberately took —
    /// and the retain that keeps a detached sheet out of the ledger then kept
    /// this one out FOREVER. After a rollback across a sheet-adding version, the
    /// roll-forward left the tab on screen with stale numbers, no badge, no
    /// delete guard, and, worst, no publish exclusion, so the publisher's own
    /// sheet could be republished inside the subscriber's application as theirs.
    ///
    /// The local identity travels with it, so a version that brings the sheet
    /// back is re-adopted IN PLACE rather than materialized as a second copy —
    /// which is what the tombstone was for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub upstream_removed_sheets: Vec<UpstreamRemovedSheet>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// What a subscription follows: a pin on the development line, or an
/// environment's pointer.
///
/// A TYPE rather than two fields the caller reads separately, for the reason
/// `PushMode` is one: a caller that has not decided which of the two this is
/// does not compile, and no caller can hand a resolver both claims at once.
#[derive(Debug, Clone, PartialEq)]
pub enum SubscriptionTarget {
    Line(crate::version::VersionPin),
    Environment(String),
}

impl Subscription {
    /// THE one interpretation of (`version_pin`, `environment`).
    ///
    /// Nothing else in the codebase parses a pin off a subscription — a rule
    /// worth stating because the shape it replaces was twelve call sites each
    /// remembering to special-case a `channel:` prefix that nothing produced.
    /// A resolver that forgot the environment branch would read an environment
    /// subscription's EMPTY pin and fail loudly (`InvalidVersion`), which is why
    /// the pin is empty rather than a mirror of the resolved version: a mirror
    /// would make the same omission report "up to date" forever.
    pub fn target(&self) -> Result<SubscriptionTarget, CalpError> {
        match &self.environment {
            Some(env) => Ok(SubscriptionTarget::Environment(env.clone())),
            None => Ok(SubscriptionTarget::Line(crate::version::VersionPin::parse(
                &self.version_pin,
            )?)),
        }
    }

    /// The pin string to store for a target. An environment subscription stores
    /// none — see [`Subscription::target`].
    pub fn pin_for(target: &SubscriptionTarget) -> String {
        match target {
            SubscriptionTarget::Line(pin) => pin.to_string(),
            SubscriptionTarget::Environment(_) => String::new(),
        }
    }

    /// The environment to store for a target.
    pub fn environment_for(target: &SubscriptionTarget) -> Option<String> {
        match target {
            SubscriptionTarget::Line(_) => None,
            SubscriptionTarget::Environment(name) => Some(name.clone()),
        }
    }
}

/// One object a subscription materialized into the local workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedObject {
    /// Object kind: "table" | "chart" | "pivot" | "namedRange" | "objectScript"
    /// | "moduleScript" | "notebook" | "dataSource" | "controlSheet".
    pub kind: String,
    /// The object's stable id — EntityId/script id/data-source id as a string;
    /// for named ranges the UPPERCASED name key; for control sheets the local
    /// SheetId string.
    pub id: String,
    /// Display name at materialization time (may drift if renamed locally).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Mapping from an application sheet to its local representation in the
/// consumer's workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedSheet {
    /// The sheet's ID in the application.
    pub package_sheet_id: SheetId,
    /// The sheet's ID in the local workbook.
    pub local_sheet_id: SheetId,
    /// The sheet's name in the local workbook (may differ from application name).
    pub local_name: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A sheet the publisher REMOVED while the subscriber kept it on screen.
///
/// Carries the local identity so a later version that brings the sheet back is
/// re-adopted in place. Without that, the returning sheet arrives as an addition
/// and materializes a second copy beside the one already rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamRemovedSheet {
    pub package_sheet_id: SheetId,
    pub local_sheet_id: SheetId,
    pub local_name: String,
    /// The version this sheet stopped being published in — display only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub removed_at_version: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

impl SubscriptionManifest {
    /// The subscription that materialized `local_sheet_id`, and its ledger entry.
    ///
    /// THE one answer to "did this sheet come from an application?". It lives
    /// next to `SubscribedSheet` because a reader that drifts from the record is
    /// how the two ids get confused: refresh matches on `package_sheet_id`,
    /// everything local matches on `local_sheet_id`, and only the second is a key
    /// into THIS workbook. Matching on the wrong one finds nothing at best, and
    /// the wrong sheet after a remap at worst.
    pub fn subscribed_sheet(
        &self,
        local_sheet_id: SheetId,
    ) -> Option<(&Subscription, &SubscribedSheet)> {
        self.subscriptions.iter().find_map(|sub| {
            sub.sheets
                .iter()
                .find(|s| s.local_sheet_id == local_sheet_id)
                .map(|s| (sub, s))
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_manifest_without_writeback_loads() {
        // A manifest with no writeback_regions field — must load normally.
        let json = serde_json::json!({
            "formatVersion": 1,
            "packageName": "test",
            "version": "1.0.0",
            "kind": "report",
            "publishedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
        });
        let vm: VersionManifest = serde_json::from_value(json).unwrap();
        assert!(vm.writeback_regions.is_none());
        assert!(vm.extra.is_empty());
    }

    #[test]
    fn version_manifest_with_writeback_roundtrips() {
        let sid = SheetId::from_bytes(identity::generate_uuid_v7());
        let json = serde_json::json!({
            "formatVersion": 1,
            "packageName": "test",
            "version": "1.0.0",
            "kind": "report",
            "publishedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
            "writebackRegions": [
                {
                    "id": "region-1",
                    "selector": {
                        "sheetId": sid.to_string(),
                        "rowStart": 0,
                        "rowEnd": 10,
                        "colStart": 0,
                        "colEnd": 5
                    },
                    "mode": "per_subscriber",
                    "schema": {"valueType": "number"}
                }
            ]
        });

        let vm: VersionManifest = serde_json::from_value(json).unwrap();
        assert!(vm.writeback_regions.is_some());
        let regions = vm.writeback_regions.as_ref().unwrap();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].id, "region-1");

        // Round-trip
        let re_json = serde_json::to_value(&vm).unwrap();
        let vm2: VersionManifest = serde_json::from_value(re_json).unwrap();
        let regions2 = vm2.writeback_regions.unwrap();
        assert_eq!(regions2[0].mode, Some(crate::writeback::WritebackMode::PerSubscriber));
    }

    #[test]
    fn artifact_checksums_roundtrip_camel_case() {
        let json = serde_json::json!({
            "formatVersion": 1,
            "packageName": "test",
            "version": "1.0.0",
            "kind": "report",
            "publishedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
            "artifactChecksums": {
                "sheets/abc/data.json": "aa".repeat(32),
            }
        });
        let vm: VersionManifest = serde_json::from_value(json).unwrap();
        assert_eq!(vm.artifact_checksums.len(), 1);
        assert_eq!(vm.artifact_checksums["sheets/abc/data.json"], "aa".repeat(32));
        // The field must bind to the struct, not fall into the flatten-extra map.
        assert!(vm.extra.is_empty());

        let re_json = serde_json::to_value(&vm).unwrap();
        assert_eq!(re_json["artifactChecksums"]["sheets/abc/data.json"], "aa".repeat(32));
    }

    #[test]
    fn version_manifest_without_checksums_deserializes_to_empty_map() {
        // Pre-checksum manifest: loads (so it can be inspected/reported), but
        // pull rejects it via integrity::verify_version_artifacts.
        let json = serde_json::json!({
            "formatVersion": 1,
            "packageName": "test",
            "version": "1.0.0",
            "kind": "report",
            "publishedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
        });
        let vm: VersionManifest = serde_json::from_value(json).unwrap();
        assert!(vm.artifact_checksums.is_empty());
    }

    #[test]
    fn flatten_extras_preserve_unknown_fields() {
        // Simulate a future format with extra fields on VersionManifest
        let json = serde_json::json!({
            "formatVersion": 1,
            "packageName": "test",
            "version": "1.0.0",
            "kind": "report",
            "publishedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
            "futureField": "some-value",
            "anotherFuture": 42
        });
        let vm: VersionManifest = serde_json::from_value(json).unwrap();
        assert_eq!(vm.extra.get("futureField").unwrap(), "some-value");

        // Round-trip preserves
        let re_json = serde_json::to_value(&vm).unwrap();
        assert_eq!(re_json["futureField"], "some-value");
        assert_eq!(re_json["anotherFuture"], 42);
    }

    #[test]
    fn subscription_extras_roundtrip() {
        let json = serde_json::json!({
            "packageName": "pkg",
            "registryUrl": "file:///reg",
            "versionPin": "^1.0",
            "resolvedVersion": "1.0.0",
            "resolvedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
            "newV11Field": {"nested": true}
        });
        let sub: Subscription = serde_json::from_value(json).unwrap();
        assert!(sub.extra.contains_key("newV11Field"));

        let re_json = serde_json::to_value(&sub).unwrap();
        assert_eq!(re_json["newV11Field"]["nested"], true);
    }

    #[test]
    fn cell_override_extras_roundtrip() {
        let json = serde_json::json!({
            "sheetId": SheetId::from_bytes(identity::generate_uuid_v7()).to_string(),
            "cellId": identity::CellId::from_bytes(identity::generate_uuid_v7()).to_string(),
            "position": [0, 0],
            "baseline": {"type": "value", "display": "100"},
            "current": {"type": "value", "display": "200"},
            "createdAt": "2026-01-01T00:00:00Z",
            "modifiedAt": "2026-01-01T00:00:00Z",
            "futureWritebackRef": "wb-region-1"
        });
        let ovr: crate::overrides::CellOverride = serde_json::from_value(json).unwrap();
        assert!(ovr.extra.contains_key("futureWritebackRef"));

        let re_json = serde_json::to_value(&ovr).unwrap();
        assert_eq!(re_json["futureWritebackRef"], "wb-region-1");
    }
}
