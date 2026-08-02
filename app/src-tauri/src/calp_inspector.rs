// FILENAME: app/src-tauri/src/calp_inspector.rs
// PURPOSE: Read-only deep inspection of a published .calp package version for
//          the standalone Package Inspector window. Everything is surfaced
//          from the registry WITHOUT subscribing or materializing anything.
// SECURITY: Every command verifies the Ed25519 manifest signature + TOFU pin
//          first (same gate as calp_inspect_package), and the content-surfacing
//          commands additionally run the FULL per-artifact SHA-256 walk before
//          reading anything — a tampered package fails to inspect, not just to
//          pull (a loose file dropped into a shared registry folder shadows the
//          committed blob on read, so manifest-signature-only would display
//          attacker bytes under a "verified" banner). Artifacts are
//          enumerated/read ONLY via the signed manifest's artifact_checksums
//          keys (a directory walk shows nothing once publish commits artifacts
//          into the content-addressed blob store, and the key check blocks
//          traversal). The two audit commands (calp_inspector_artifact /
//          calp_inspector_verify_artifacts) skip the up-front walk on purpose:
//          they hash and REPORT per artifact instead of failing.
//          Post-publish submissions/ and reviews/ are a separate, UNSIGNED
//          trust domain: response activity — values AND aggregates — is
//          publisher-gated (possession of the signing key), matching
//          calp_load_region_submissions / calp_region_response_status.

use std::collections::{BTreeMap, HashMap};

use calp::integrity::{sha256_hex, verify_and_load_manifest_via, PinPolicy, TrustStatus};
use calp::manifest::VersionManifest;
use calp::transport::RegistryTransport;
use calp::version::VersionPin;
use calp::writeback::{SubmissionState, SubmissionValue};
use calcula_format::cell_ref;
use calcula_format::features::notebooks::NotebookDef;
use calcula_format::features::object_scripts::ObjectScriptDef;
use calcula_format::features::scripts::ScriptDef;
use calcula_format::sheet_data::SheetData;
use calcula_format::sheet_layout::SheetLayout;
use calcula_format::sheet_styles::SheetStyles;
use serde::Serialize;

use crate::calp_commands::calcula_profile_dir;
use crate::security::window_guard;

// ============================================================================
// Shared helpers
// ============================================================================

/// Open the registry, resolve the pin, and verify the manifest signature +
/// TOFU pin. The single trust choke point for every inspector command.
///
/// `check_artifacts` additionally runs the full per-artifact SHA-256 walk
/// (the same gate pull applies) so content-surfacing commands never display
/// bytes the signature does not cover. The artifact-audit commands pass
/// `false` — they hash and report per artifact instead of failing outright.
///
/// PASSIVE — `PinPolicy::VerifyOnly`. Inspection is the surface that exists so
/// the user can decide WHETHER to trust a publisher; it must not make that
/// decision for them. `PackageInspectorApp.tsx` fires the overview
/// automatically on browse/drop/cross-window handover, so merely POINTING the
/// inspector at a folder used to write a TOFU pin — the direct analogue of the
/// Wave-H "scanning pinned on every launch" bug. First contact now reports
/// `TrustStatus::NotPinned` and the pin store is untouched; the key and its
/// fingerprint are still displayed in full, which is the whole point.
fn open_verified(
    registry_path: &str,
    package_name: &str,
    version_pin: &str,
    check_artifacts: bool,
) -> Result<(Box<dyn RegistryTransport>, String, TrustStatus, VersionManifest), String> {
    let registry =
        crate::calp_registry::open_registry(registry_path).map_err(|e| e.to_string())?;
    let pin = VersionPin::parse(version_pin).map_err(|e| e.to_string())?;
    let resolved = registry
        .resolve_version(package_name, &pin)
        .map_err(|e| e.to_string())?;
    let version = resolved.to_string();
    let (trust, manifest) = verify_and_load_manifest_via(
        registry.as_ref(),
        package_name,
        &version,
        &calcula_profile_dir(),
        PinPolicy::VerifyOnly,
    )
    .map_err(|e| e.to_string())?;
    if check_artifacts {
        calp::integrity::verify_version_artifacts_via(
            registry.as_ref(),
            package_name,
            &version,
            &manifest,
        )
        .map_err(|e| {
            format!(
                "Package integrity check failed — the contents do not match the publisher's \
                 signature, so they will not be displayed: {}",
                e
            )
        })?;
    }
    Ok((registry, version, trust, manifest))
}

/// `open_verified` for the SECTION commands (sheet / scripts / model /
/// writeback / raw artifact), which render already-authenticated CONTENT and
/// have no trust badge of their own — the Overview tab owns the trust
/// presentation for the whole window.
///
/// It drops the `TrustStatus` here, once, with a reason, instead of five call
/// sites each binding `_trust` and leaving a reader to wonder whether an answer
/// was ignored by accident. Dropping it is safe precisely because
/// `open_verified` is `VerifyOnly`: no trust decision was made, so there is no
/// decision to fail open on. What these commands DO enforce is unchanged and
/// non-negotiable — a valid signature, and (for the content commands) the full
/// per-artifact SHA-256 walk.
fn open_verified_content(
    registry_path: &str,
    package_name: &str,
    version_pin: &str,
    check_artifacts: bool,
) -> Result<(Box<dyn RegistryTransport>, String, VersionManifest), String> {
    let (registry, version, _trust, manifest) =
        open_verified(registry_path, package_name, version_pin, check_artifacts)?;
    Ok((registry, version, manifest))
}

/// Wire string for `TrustStatus`. EXHAUSTIVE on purpose (no `_` arm): a new
/// trust state must not reach the frontend until someone has decided how it is
/// presented.
fn trust_status_str(trust: TrustStatus) -> String {
    match trust {
        TrustStatus::FirstUse => "firstUse",
        TrustStatus::Verified => "verified",
        TrustStatus::NotPinned => "notPinned",
    }
    .to_string()
}

/// Read + parse an optional JSON artifact; None when absent or unparseable
/// (the raw artifact view still shows unparseable bytes verbatim).
fn read_json<T: serde::de::DeserializeOwned>(
    registry: &dyn RegistryTransport,
    package: &str,
    version: &str,
    rel_path: &str,
) -> Option<T> {
    match registry.read_artifact(package, version, rel_path) {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).ok(),
        _ => None,
    }
}

/// Defensive field access on opaque JSON: try several key spellings so both
/// camelCase and snake_case payloads resolve (persistence structs differ).
fn jget<'a>(v: &'a serde_json::Value, keys: &[&str]) -> Option<&'a serde_json::Value> {
    keys.iter().find_map(|k| v.get(k))
}

fn jstr(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
    jget(v, keys).and_then(|x| x.as_str()).map(str::to_string)
}

fn jarr<'a>(v: &'a serde_json::Value, keys: &[&str]) -> Option<&'a Vec<serde_json::Value>> {
    jget(v, keys).and_then(|x| x.as_array())
}

fn jarr_len(v: &serde_json::Value, keys: &[&str]) -> usize {
    jarr(v, keys).map(Vec::len).unwrap_or(0)
}

/// Human display string for a sparse-cell value (type codes per SheetData).
fn cell_display(entry: &calcula_format::sheet_data::CellEntry) -> String {
    match entry.t.as_str() {
        "s" => entry.v.as_str().unwrap_or_default().to_string(),
        "n" => match entry.v.as_f64() {
            Some(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", n as i64),
            Some(n) => format!("{}", n),
            None => String::new(),
        },
        "b" => match entry.v.as_bool() {
            Some(true) => "TRUE".to_string(),
            Some(false) => "FALSE".to_string(),
            None => String::new(),
        },
        "e" => entry.e.clone().unwrap_or_else(|| "#ERROR".to_string()),
        "l" | "d" => serde_json::to_string(&entry.v).unwrap_or_default(),
        _ => String::new(),
    }
}

fn submission_value_display(value: &SubmissionValue) -> (String, String) {
    match value {
        SubmissionValue::Number { value } => (format!("{}", value), "number".to_string()),
        SubmissionValue::Text { value } => (value.clone(), "text".to_string()),
        SubmissionValue::Boolean { value } => (value.to_string(), "boolean".to_string()),
        SubmissionValue::Empty => (String::new(), "empty".to_string()),
    }
}

// ============================================================================
// Location resolution (browse ergonomics)
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRegistryLocation {
    /// The registry ROOT to browse (walked up from whatever was picked).
    pub registry_path: String,
    /// Set when the picked folder was a package (or version) directory.
    pub package_name: Option<String>,
    /// Set when the picked folder was a specific version directory.
    pub version: Option<String>,
}

/// Users naturally browse INTO the thing they want to inspect —
/// `C:\reg\sales-report\1.0.0` — but a registry location is the ROOT folder
/// (`C:\reg`), so a raw browse finds nothing. Recognize a package directory
/// (contains calp-manifest.json) or a version directory (its parent does) and
/// walk up to the root, remembering what was picked so the UI can pre-select
/// it. Purely local probing; anything unrecognized passes through unchanged.
#[tauri::command]
pub fn calp_inspector_resolve_location(
    path: String,
    window: tauri::Window,
) -> Result<ResolvedRegistryLocation, String> {
    window_guard::require_label(&window, window_guard::MAIN_AND_PACKAGE_INSPECTOR)?;

    // HTTP registries have no local directory structure to probe.
    if crate::calp_registry::is_http_location(&path) {
        return Ok(ResolvedRegistryLocation {
            registry_path: path,
            package_name: None,
            version: None,
        });
    }

    let raw = path.strip_prefix("file://").unwrap_or(&path).to_string();
    let picked = std::path::PathBuf::from(&raw);

    // The package name comes from the manifest (authoritative), not the
    // directory name.
    let manifest_name = |dir: &std::path::Path| -> Option<String> {
        let bytes = std::fs::read(dir.join("calp-manifest.json")).ok()?;
        serde_json::from_slice::<calp::manifest::PackageManifest>(&bytes)
            .ok()
            .map(|m| m.name)
    };

    // Picked the PACKAGE directory: registry is its parent.
    if let Some(name) = manifest_name(&picked) {
        if let Some(registry) = picked.parent() {
            return Ok(ResolvedRegistryLocation {
                registry_path: registry.display().to_string(),
                package_name: Some(name),
                version: None,
            });
        }
    }

    // Picked a VERSION directory: its parent is the package directory.
    if let Some(pkg_dir) = picked.parent() {
        if let Some(name) = manifest_name(pkg_dir) {
            if let Some(registry) = pkg_dir.parent() {
                let version = picked
                    .join(calp::integrity::VERSION_MANIFEST_FILE)
                    .is_file()
                    .then(|| picked.file_name().map(|s| s.to_string_lossy().to_string()))
                    .flatten();
                return Ok(ResolvedRegistryLocation {
                    registry_path: registry.display().to_string(),
                    package_name: Some(name),
                    version,
                });
            }
        }
    }

    Ok(ResolvedRegistryLocation {
        registry_path: raw,
        package_name: None,
        version: None,
    })
}

// ============================================================================
// Overview
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorVersionEntry {
    pub version: String,
    pub published_at: String,
    pub published_by: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorPackageInfo {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub author: String,
    pub created: String,
    pub versions: Vec<InspectorVersionEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorManifestInfo {
    pub format_version: u32,
    pub kind: String,
    pub published_at: String,
    pub published_by: String,
    pub publisher_name: String,
    /// Lowercase hex Ed25519 public key (empty = unsigned; such packages
    /// fail verification before this DTO is ever built).
    pub publisher_key: String,
    pub min_app_version: String,
    /// "firstUse" | "verified" (TOFU outcome for this inspection).
    pub trust_status: String,
    /// Whether THIS machine holds the signing key (publisher-side view).
    pub is_publisher: bool,
    pub artifact_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSheetSummary {
    pub sheet_id: String,
    pub name: String,
    pub description: String,
    pub cell_count: usize,
    pub formula_count: usize,
    pub merged_count: usize,
    pub note_count: usize,
    pub hyperlink_count: usize,
    pub hidden_row_count: usize,
    pub hidden_col_count: usize,
    pub has_freeze: bool,
    pub tab_color: String,
    pub visibility: String,
    pub has_page_setup: bool,
    pub show_gridlines: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorTableInfo {
    pub id: String,
    pub name: String,
    pub sheet_name: String,
    /// A1-style range, e.g. "A1:D20".
    pub range: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorNamedRangeInfo {
    pub name: String,
    pub refers_to: String,
    /// None = workbook-scoped.
    pub sheet_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorChartInfo {
    pub id: String,
    pub sheet_name: String,
    pub title: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorPivotInfo {
    pub id: String,
    pub source_type: String,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSlicerInfo {
    pub name: String,
    pub sheet_name: String,
    pub field_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorPaneControlInfo {
    pub id: String,
    pub name: String,
    pub control_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorRibbonFilterInfo {
    pub name: String,
    pub field_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorPivotLayoutInfo {
    pub name: String,
    pub source_type: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorCustomObjectInfo {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub sheet_name: Option<String>,
    pub payload_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorObjectScriptInfo {
    pub id: String,
    pub name: String,
    pub object_type: String,
    pub instance_id: Option<String>,
    pub description: Option<String>,
    /// The R19 declared-capability ceiling from the SIGNED manifest.
    pub capabilities: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorModuleScriptInfo {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorNotebookInfo {
    pub id: String,
    pub name: String,
    pub cell_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorBindingInfo {
    pub model_table: String,
    pub schema: String,
    pub source_table: String,
    pub has_query: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSnapshotRef {
    pub table: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorDataSourceInfo {
    pub id: String,
    pub name: String,
    pub connection_type: String,
    pub server: String,
    pub database: String,
    pub model_path: String,
    pub bindings: Vec<InspectorBindingInfo>,
    pub calculated_table_snapshots: Vec<InspectorSnapshotRef>,
    pub has_writeback_history: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorArtifactEntry {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorOverview {
    pub package: InspectorPackageInfo,
    pub resolved_version: String,
    pub manifest: InspectorManifestInfo,
    pub sheets: Vec<InspectorSheetSummary>,
    pub tables: Vec<InspectorTableInfo>,
    pub named_ranges: Vec<InspectorNamedRangeInfo>,
    pub charts: Vec<InspectorChartInfo>,
    pub sparkline_sheets: Vec<String>,
    pub pivots: Vec<InspectorPivotInfo>,
    pub slicers: Vec<InspectorSlicerInfo>,
    pub pane_controls: Vec<InspectorPaneControlInfo>,
    pub ribbon_filters: Vec<InspectorRibbonFilterInfo>,
    pub pivot_layouts: Vec<InspectorPivotLayoutInfo>,
    pub conditional_format_sheets: Vec<String>,
    pub data_validation_sheets: Vec<String>,
    pub control_sheets: Vec<String>,
    pub comment_sheets: Vec<String>,
    pub scenario_sheets: Vec<String>,
    pub outline_sheets: Vec<String>,
    pub has_theme: bool,
    pub theme_name: Option<String>,
    pub extension_data_keys: Vec<String>,
    pub custom_objects: Vec<InspectorCustomObjectInfo>,
    pub object_scripts: Vec<InspectorObjectScriptInfo>,
    /// Excludes the reserved Custom Functions library module (censused via
    /// `custom_function_count` instead).
    pub module_scripts: Vec<InspectorModuleScriptInfo>,
    pub notebooks: Vec<InspectorNotebookInfo>,
    /// Functions in the reserved Custom Functions library, 0 when absent.
    pub custom_function_count: usize,
    pub data_sources: Vec<InspectorDataSourceInfo>,
    pub writeback_region_count: usize,
    pub model_writeback_count: usize,
    pub locked_sheet_count: usize,
    pub locked_cell_count: usize,
    pub artifacts: Vec<InspectorArtifactEntry>,
}

/// Cheap cell/formula counting: parses the sparse map's shape without
/// materializing cell values (overview must not pay full SheetData cost).
#[derive(serde::Deserialize)]
struct CellProbe {
    #[serde(default)]
    f: Option<serde::de::IgnoredAny>,
}

#[derive(serde::Deserialize)]
struct SheetDataProbe {
    #[serde(default)]
    cells: BTreeMap<String, CellProbe>,
}

/// Resolve a package sheet id (as JSON string) to its display name.
fn sheet_name_for(names: &HashMap<String, String>, sheet_id: &str) -> String {
    names
        .get(sheet_id)
        .cloned()
        .unwrap_or_else(|| sheet_id.to_string())
}

/// Per-sheet artifact rows ("which sheets carry feature X"), resolved to names.
fn sheet_feature_list(
    registry: &dyn RegistryTransport,
    package: &str,
    version: &str,
    rel_path: &str,
    names: &HashMap<String, String>,
) -> Vec<String> {
    read_json::<Vec<serde_json::Value>>(registry, package, version, rel_path)
        .unwrap_or_default()
        .iter()
        .filter_map(|v| jstr(v, &["sheetId", "sheet_id"]))
        .map(|sid| sheet_name_for(names, &sid))
        .collect()
}

/// Full deep overview of a package version — the Package Inspector's landing
/// payload. Read-only; verifies signature + TOFU like calp_inspect_package.
#[tauri::command]
pub fn calp_inspector_overview(
    registry_path: String,
    package_name: String,
    version_pin: String,
    window: tauri::Window,
) -> Result<InspectorOverview, String> {
    window_guard::require_label(&window, window_guard::MAIN_AND_PACKAGE_INSPECTOR)?;
    let (registry, version, trust, manifest) =
        open_verified(&registry_path, &package_name, &version_pin, true)?;
    let reg = registry.as_ref();
    let profile_dir = calcula_profile_dir();

    let pkg_manifest = reg
        .get_package_manifest(&package_name)
        .map_err(|e| e.to_string())?;

    let sheet_names: HashMap<String, String> = manifest
        .sheets
        .iter()
        .map(|s| (s.sheet_id.to_string(), s.name.clone()))
        .collect();

    // Per-sheet summaries: cell/formula counts from data.json plus the
    // presentation metadata disclosure (merges, notes, hyperlinks, ...).
    let sheets: Vec<InspectorSheetSummary> = manifest
        .sheets
        .iter()
        .map(|s| {
            let sid = s.sheet_id.to_string();
            let data: Option<SheetDataProbe> =
                read_json(reg, &package_name, &version, &format!("sheets/{}/data.json", sid));
            let (cell_count, formula_count) = data
                .as_ref()
                .map(|d| {
                    (
                        d.cells.len(),
                        d.cells.values().filter(|c| c.f.is_some()).count(),
                    )
                })
                .unwrap_or((0, 0));
            let meta: calp::manifest::PublishedSheetMetadata = read_json(
                reg,
                &package_name,
                &version,
                &format!("sheets/{}/metadata.json", sid),
            )
            .unwrap_or_default();
            InspectorSheetSummary {
                sheet_id: sid,
                name: s.name.clone(),
                description: s.description.clone(),
                cell_count,
                formula_count,
                merged_count: meta.merged_regions.len(),
                note_count: meta.notes.len(),
                hyperlink_count: meta.hyperlinks.len(),
                hidden_row_count: meta.hidden_rows.len(),
                hidden_col_count: meta.hidden_cols.len(),
                has_freeze: meta.freeze_row.is_some() || meta.freeze_col.is_some(),
                tab_color: meta.tab_color.clone(),
                visibility: meta.visibility.clone(),
                has_page_setup: meta.page_setup.is_some(),
                show_gridlines: meta.show_gridlines,
            }
        })
        .collect();

    // Tables: opaque-JSON parsed defensively (persistence field casing varies).
    let tables: Vec<InspectorTableInfo> = manifest
        .tables
        .iter()
        .filter_map(|table_id| {
            let v: serde_json::Value = read_json(
                reg,
                &package_name,
                &version,
                &format!("tables/{}.json", table_id),
            )?;
            let sheet_id = jstr(&v, &["sheetId", "sheet_id"]).unwrap_or_default();
            let range = match (
                jget(&v, &["startRow", "start_row"]).and_then(|x| x.as_u64()),
                jget(&v, &["startCol", "start_col"]).and_then(|x| x.as_u64()),
                jget(&v, &["endRow", "end_row"]).and_then(|x| x.as_u64()),
                jget(&v, &["endCol", "end_col"]).and_then(|x| x.as_u64()),
            ) {
                (Some(r1), Some(c1), Some(r2), Some(c2)) => format!(
                    "{}:{}",
                    cell_ref::to_a1(r1 as u32, c1 as u32),
                    cell_ref::to_a1(r2 as u32, c2 as u32)
                ),
                _ => String::new(),
            };
            Some(InspectorTableInfo {
                id: table_id.to_string(),
                name: jstr(&v, &["name"]).unwrap_or_default(),
                sheet_name: sheet_name_for(&sheet_names, &sheet_id),
                range,
                columns: jarr(&v, &["columns"])
                    .map(|cols| {
                        cols.iter()
                            .filter_map(|c| jstr(c, &["name"]))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect();

    let named_ranges: Vec<InspectorNamedRangeInfo> = manifest
        .named_ranges
        .iter()
        .map(|nr| InspectorNamedRangeInfo {
            name: nr.name.clone(),
            refers_to: nr.refers_to.clone(),
            sheet_name: nr
                .sheet_id
                .as_ref()
                .map(|sid| sheet_name_for(&sheet_names, &sid.to_string())),
        })
        .collect();

    let charts: Vec<InspectorChartInfo> =
        read_json::<Vec<serde_json::Value>>(reg, &package_name, &version, "charts.json")
            .unwrap_or_default()
            .iter()
            .map(|v| {
                let title = jstr(v, &["specJson", "spec_json"])
                    .and_then(|spec| serde_json::from_str::<serde_json::Value>(&spec).ok())
                    .and_then(|spec| {
                        spec.get("title")
                            .and_then(|t| {
                                t.as_str()
                                    .map(str::to_string)
                                    .or_else(|| jstr(t, &["text"]))
                            })
                            .filter(|t| !t.is_empty())
                    });
                InspectorChartInfo {
                    id: jstr(v, &["id"]).unwrap_or_default(),
                    sheet_name: sheet_name_for(
                        &sheet_names,
                        &jstr(v, &["sheetId", "sheet_id"]).unwrap_or_default(),
                    ),
                    title,
                }
            })
            .collect();

    let sparkline_sheets =
        sheet_feature_list(reg, &package_name, &version, "sparklines.json", &sheet_names);

    // Pivot artifacts are enumerated from the SIGNED manifest's checksum keys
    // (a transport dir-walk lists nothing once artifacts live in the blob store).
    let pivots: Vec<InspectorPivotInfo> = manifest
        .artifact_checksums
        .keys()
        .filter(|p| {
            p.starts_with("pivot_definitions/")
                && p.ends_with(".json")
                && p.as_str() != "pivot_definitions/bi_metadata.json"
        })
        .filter_map(|path| {
            let v: serde_json::Value = read_json(reg, &package_name, &version, path)?;
            Some(InspectorPivotInfo {
                id: jstr(&v, &["id"]).unwrap_or_else(|| path.clone()),
                source_type: jstr(&v, &["sourceType", "source_type"]).unwrap_or_default(),
                name: jget(&v, &["definition"]).and_then(|d| jstr(d, &["name"])),
            })
        })
        .collect();

    let slicers: Vec<InspectorSlicerInfo> =
        read_json::<Vec<serde_json::Value>>(reg, &package_name, &version, "slicers.json")
            .unwrap_or_default()
            .iter()
            .map(|v| InspectorSlicerInfo {
                name: jstr(v, &["name"]).unwrap_or_default(),
                sheet_name: sheet_name_for(
                    &sheet_names,
                    &jstr(v, &["sheetId", "sheet_id"]).unwrap_or_default(),
                ),
                field_name: jstr(v, &["fieldName", "field_name"]).unwrap_or_default(),
            })
            .collect();

    let pane_controls: Vec<InspectorPaneControlInfo> =
        read_json::<Vec<serde_json::Value>>(reg, &package_name, &version, "pane_controls.json")
            .unwrap_or_default()
            .iter()
            .map(|v| InspectorPaneControlInfo {
                id: jstr(v, &["id"]).unwrap_or_default(),
                name: jstr(v, &["name"]).unwrap_or_default(),
                control_type: jstr(v, &["controlType", "control_type"]).unwrap_or_default(),
            })
            .collect();

    let ribbon_filters: Vec<InspectorRibbonFilterInfo> =
        read_json::<Vec<serde_json::Value>>(reg, &package_name, &version, "ribbon_filters.json")
            .unwrap_or_default()
            .iter()
            .map(|v| InspectorRibbonFilterInfo {
                name: jstr(v, &["name"]).unwrap_or_default(),
                field_name: jstr(v, &["fieldName", "field_name"]).unwrap_or_default(),
            })
            .collect();

    let pivot_layouts: Vec<InspectorPivotLayoutInfo> =
        read_json::<Vec<serde_json::Value>>(reg, &package_name, &version, "pivot_layouts.json")
            .unwrap_or_default()
            .iter()
            .map(|v| InspectorPivotLayoutInfo {
                name: jstr(v, &["name"]).unwrap_or_default(),
                source_type: jstr(v, &["sourceType", "source_type"]).unwrap_or_default(),
                description: jstr(v, &["description"]),
            })
            .collect();

    let theme: Option<serde_json::Value> = read_json(reg, &package_name, &version, "theme.json");
    let theme_name = theme.as_ref().and_then(|t| jstr(t, &["name"]));

    let extension_data_keys: Vec<String> = read_json::<BTreeMap<String, serde_json::Value>>(
        reg,
        &package_name,
        &version,
        "extension_data.json",
    )
    .map(|m| m.into_keys().collect())
    .unwrap_or_default();

    let custom_objects: Vec<InspectorCustomObjectInfo> = manifest
        .custom_objects
        .iter()
        .map(|c| InspectorCustomObjectInfo {
            kind: c.kind.clone(),
            id: c.id.clone(),
            name: c.name.clone(),
            sheet_name: c
                .sheet_id
                .as_ref()
                .map(|sid| sheet_name_for(&sheet_names, &sid.to_string())),
            payload_path: c.payload_path.clone(),
        })
        .collect();

    let data_sources: Vec<InspectorDataSourceInfo> = manifest
        .data_sources
        .iter()
        .map(|ds| InspectorDataSourceInfo {
            id: ds.id.clone(),
            name: ds.name.clone(),
            connection_type: ds.connection_type.clone(),
            server: ds.server.clone(),
            database: ds.database.clone(),
            model_path: ds.model_path.clone(),
            bindings: ds
                .bindings
                .iter()
                .map(|b| InspectorBindingInfo {
                    model_table: b.model_table.clone(),
                    schema: b.schema.clone(),
                    source_table: b.source_table.clone(),
                    has_query: b.source_query.is_some(),
                })
                .collect(),
            calculated_table_snapshots: ds
                .calculated_table_snapshots
                .iter()
                .map(|s| InspectorSnapshotRef {
                    table: s.table.clone(),
                    path: s.path.clone(),
                })
                .collect(),
            has_writeback_history: manifest
                .artifact_checksums
                .contains_key(&format!("models/{}/writeback_history.json", ds.id)),
        })
        .collect();

    let is_publisher =
        calp::signing::profile_holds_publisher_key(&profile_dir, &manifest.publisher_key)
            .unwrap_or(false);

    Ok(InspectorOverview {
        package: InspectorPackageInfo {
            name: pkg_manifest.name,
            description: pkg_manifest.description,
            kind: pkg_manifest.kind,
            author: pkg_manifest.author,
            created: pkg_manifest.created,
            versions: pkg_manifest
                .versions
                .iter()
                .map(|v| InspectorVersionEntry {
                    version: v.version.clone(),
                    published_at: v.published_at.clone(),
                    published_by: v.published_by.clone(),
                })
                .collect(),
        },
        resolved_version: version.clone(),
        manifest: InspectorManifestInfo {
            format_version: manifest.format_version,
            kind: manifest.kind.clone(),
            published_at: manifest.published_at.clone(),
            published_by: manifest.published_by.clone(),
            publisher_name: manifest.publisher_name.clone(),
            publisher_key: manifest.publisher_key.clone(),
            min_app_version: manifest.min_app_version.clone(),
            trust_status: trust_status_str(trust),
            is_publisher,
            artifact_count: manifest.artifact_checksums.len(),
        },
        sheets,
        tables,
        named_ranges,
        charts,
        sparkline_sheets,
        pivots,
        slicers,
        pane_controls,
        ribbon_filters,
        pivot_layouts,
        conditional_format_sheets: sheet_feature_list(
            reg,
            &package_name,
            &version,
            "conditional_formats.json",
            &sheet_names,
        ),
        data_validation_sheets: sheet_feature_list(
            reg,
            &package_name,
            &version,
            "data_validations.json",
            &sheet_names,
        ),
        control_sheets: sheet_feature_list(
            reg,
            &package_name,
            &version,
            "controls.json",
            &sheet_names,
        ),
        comment_sheets: sheet_feature_list(
            reg,
            &package_name,
            &version,
            "comments.json",
            &sheet_names,
        ),
        scenario_sheets: sheet_feature_list(
            reg,
            &package_name,
            &version,
            "scenarios.json",
            &sheet_names,
        ),
        outline_sheets: sheet_feature_list(
            reg,
            &package_name,
            &version,
            "outlines.json",
            &sheet_names,
        ),
        has_theme: theme.is_some(),
        theme_name,
        extension_data_keys,
        custom_objects,
        object_scripts: manifest
            .object_scripts
            .iter()
            .map(|s| InspectorObjectScriptInfo {
                id: s.id.clone(),
                name: s.name.clone(),
                object_type: s.object_type.clone(),
                instance_id: s.instance_id.clone(),
                description: s.description.clone(),
                capabilities: s.capabilities.clone(),
            })
            .collect(),
        module_scripts: manifest
            .module_scripts
            .iter()
            .filter(|m| m.id != CUSTOM_FUNCTIONS_MODULE_ID)
            .map(|m| InspectorModuleScriptInfo {
                id: m.id.clone(),
                name: m.name.clone(),
                scope: m.scope.clone(),
                description: m.description.clone(),
            })
            .collect(),
        custom_function_count: manifest
            .module_scripts
            .iter()
            .find(|m| m.id == CUSTOM_FUNCTIONS_MODULE_ID)
            .and_then(|m| {
                let def: ScriptDef =
                    read_json(reg, &package_name, &version, &format!("modules/{}.json", m.id))?;
                let lib: serde_json::Value = serde_json::from_str(&def.source).ok()?;
                Some(jarr_len(&lib, &["functions"]))
            })
            .unwrap_or(0),
        notebooks: manifest
            .notebooks
            .iter()
            .map(|n| InspectorNotebookInfo {
                id: n.id.clone(),
                name: n.name.clone(),
                cell_count: n.cell_count,
            })
            .collect(),
        data_sources,
        writeback_region_count: manifest
            .writeback_regions
            .as_ref()
            .map(Vec::len)
            .unwrap_or(0),
        model_writeback_count: manifest
            .model_writebacks
            .as_ref()
            .map(Vec::len)
            .unwrap_or(0),
        locked_sheet_count: manifest.locked_sheets.len(),
        locked_cell_count: manifest.locked_cells.len(),
        artifacts: manifest
            .artifact_checksums
            .iter()
            .map(|(path, sha)| InspectorArtifactEntry {
                path: path.clone(),
                sha256: sha.clone(),
            })
            .collect(),
    })
}

// ============================================================================
// Sheet detail (cell data + layout + metadata)
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorCell {
    pub a1: String,
    pub row: u32,
    pub col: u32,
    /// Type code: "s" string, "n" number, "b" boolean, "e" error, "l" list,
    /// "d" dict, "x" empty (style/rich-text-only cell).
    pub cell_type: String,
    pub display: String,
    /// Formula WITHOUT the leading '='.
    pub formula: Option<String>,
    pub style_index: Option<usize>,
    pub has_rich_text: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorUsedRange {
    pub min_row: u32,
    pub max_row: u32,
    pub min_col: u32,
    pub max_col: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSheetMetadata {
    pub merged_regions: Vec<persistence::SavedMergedRegion>,
    pub freeze_row: Option<u32>,
    pub freeze_col: Option<u32>,
    pub hidden_row_count: usize,
    pub hidden_col_count: usize,
    pub tab_color: String,
    pub visibility: String,
    pub note_count: usize,
    pub hyperlink_count: usize,
    pub has_page_setup: bool,
    pub show_gridlines: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSheetDetail {
    pub sheet_id: String,
    pub name: String,
    /// Cells sorted by (row, col), capped at max_cells.
    pub cells: Vec<InspectorCell>,
    pub total_cell_count: usize,
    pub formula_count: usize,
    pub truncated: bool,
    pub used_range: Option<InspectorUsedRange>,
    /// Column index (stringified) -> width px; only non-default entries.
    pub column_widths: BTreeMap<u32, f64>,
    pub row_heights: BTreeMap<u32, f64>,
    pub style_count: usize,
    pub styled_cell_count: usize,
    pub metadata: InspectorSheetMetadata,
}

/// Full cell-level view of one published sheet.
#[tauri::command]
pub fn calp_inspector_sheet(
    registry_path: String,
    package_name: String,
    version_pin: String,
    sheet_id: String,
    max_cells: Option<usize>,
    window: tauri::Window,
) -> Result<InspectorSheetDetail, String> {
    window_guard::require_label(&window, window_guard::MAIN_AND_PACKAGE_INSPECTOR)?;
    let (registry, version, manifest) =
        open_verified_content(&registry_path, &package_name, &version_pin, true)?;
    let reg = registry.as_ref();

    let sheet = manifest
        .sheets
        .iter()
        .find(|s| s.sheet_id.to_string() == sheet_id)
        .ok_or_else(|| format!("Sheet '{}' is not in this package version.", sheet_id))?;

    let data: SheetData = read_json(
        reg,
        &package_name,
        &version,
        &format!("sheets/{}/data.json", sheet_id),
    )
    .unwrap_or(SheetData {
        cells: BTreeMap::new(),
    });
    let cell_styles: Option<SheetStyles> = read_json(
        reg,
        &package_name,
        &version,
        &format!("sheets/{}/cell_styles.json", sheet_id),
    );
    let layout: Option<SheetLayout> = read_json(
        reg,
        &package_name,
        &version,
        &format!("sheets/{}/layout.json", sheet_id),
    );
    let style_count = read_json::<Vec<serde_json::Value>>(
        reg,
        &package_name,
        &version,
        &format!("sheets/{}/styles.json", sheet_id),
    )
    .map(|v| v.len())
    .unwrap_or(0);
    let meta: calp::manifest::PublishedSheetMetadata = read_json(
        reg,
        &package_name,
        &version,
        &format!("sheets/{}/metadata.json", sheet_id),
    )
    .unwrap_or_default();

    let style_map = cell_styles.map(|s| s.cells).unwrap_or_default();

    // Parse + sort by (row, col); the BTreeMap's A1 order is lexicographic
    // ("A10" < "A2"), which is useless for display.
    let mut parsed: Vec<(u32, u32, &String, &calcula_format::sheet_data::CellEntry)> = data
        .cells
        .iter()
        .filter_map(|(a1, entry)| {
            cell_ref::from_a1(a1).map(|(row, col)| (row, col, a1, entry))
        })
        .collect();
    parsed.sort_by_key(|(row, col, _, _)| (*row, *col));

    let used_range = if parsed.is_empty() {
        None
    } else {
        Some(InspectorUsedRange {
            min_row: parsed.iter().map(|p| p.0).min().unwrap_or(0),
            max_row: parsed.iter().map(|p| p.0).max().unwrap_or(0),
            min_col: parsed.iter().map(|p| p.1).min().unwrap_or(0),
            max_col: parsed.iter().map(|p| p.1).max().unwrap_or(0),
        })
    };

    let total_cell_count = parsed.len();
    let formula_count = parsed.iter().filter(|(_, _, _, e)| e.f.is_some()).count();
    let cap = max_cells.unwrap_or(20_000);
    let truncated = total_cell_count > cap;

    let cells: Vec<InspectorCell> = parsed
        .into_iter()
        .take(cap)
        .map(|(row, col, a1, entry)| InspectorCell {
            a1: a1.clone(),
            row,
            col,
            cell_type: entry.t.clone(),
            display: cell_display(entry),
            formula: entry.f.clone(),
            style_index: style_map.get(a1).copied(),
            has_rich_text: entry.rt.is_some(),
        })
        .collect();

    Ok(InspectorSheetDetail {
        sheet_id,
        name: sheet.name.clone(),
        cells,
        total_cell_count,
        formula_count,
        truncated,
        used_range,
        column_widths: layout
            .as_ref()
            .map(|l| l.column_widths.clone())
            .unwrap_or_default(),
        row_heights: layout
            .as_ref()
            .map(|l| l.row_heights.clone())
            .unwrap_or_default(),
        style_count,
        styled_cell_count: style_map.len(),
        metadata: InspectorSheetMetadata {
            merged_regions: meta.merged_regions,
            freeze_row: meta.freeze_row,
            freeze_col: meta.freeze_col,
            hidden_row_count: meta.hidden_rows.len(),
            hidden_col_count: meta.hidden_cols.len(),
            tab_color: meta.tab_color,
            visibility: meta.visibility,
            note_count: meta.notes.len(),
            hyperlink_count: meta.hyperlinks.len(),
            has_page_setup: meta.page_setup.is_some(),
            show_gridlines: meta.show_gridlines,
        },
    })
}

// ============================================================================
// Scripts (full source — the transparency surface)
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorObjectScriptDetail {
    pub id: String,
    pub name: String,
    pub object_type: String,
    pub instance_id: Option<String>,
    pub description: Option<String>,
    /// The SIGNED manifest's declared-capability ceiling (authoritative —
    /// the subscriber's runtime ceiling comes from this, never the source).
    pub capabilities: Vec<String>,
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorModuleScriptDetail {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub description: Option<String>,
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorNotebookCell {
    pub id: String,
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorNotebookDetail {
    pub id: String,
    pub name: String,
    /// Cell sources only — execution outputs are stripped at publish, and any
    /// residual output in a hand-crafted package is deliberately NOT surfaced.
    pub cells: Vec<InspectorNotebookCell>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorCustomFunctions {
    /// Function names from the reserved __calcula_custom_functions__ library.
    pub function_names: Vec<String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorScripts {
    pub object_scripts: Vec<InspectorObjectScriptDetail>,
    pub module_scripts: Vec<InspectorModuleScriptDetail>,
    pub notebooks: Vec<InspectorNotebookDetail>,
    pub custom_functions: Option<InspectorCustomFunctions>,
}

/// The reserved module-script id carrying the Custom Functions library.
const CUSTOM_FUNCTIONS_MODULE_ID: &str = "__calcula_custom_functions__";

/// Every line of code a package carries, with full source.
#[tauri::command]
pub fn calp_inspector_scripts(
    registry_path: String,
    package_name: String,
    version_pin: String,
    window: tauri::Window,
) -> Result<InspectorScripts, String> {
    window_guard::require_label(&window, window_guard::MAIN_AND_PACKAGE_INSPECTOR)?;
    let (registry, version, manifest) =
        open_verified_content(&registry_path, &package_name, &version_pin, true)?;
    let reg = registry.as_ref();

    let object_scripts: Vec<InspectorObjectScriptDetail> = manifest
        .object_scripts
        .iter()
        .map(|entry| {
            let def: Option<ObjectScriptDef> = read_json(
                reg,
                &package_name,
                &version,
                &format!("object_scripts/{}.json", entry.id),
            );
            InspectorObjectScriptDetail {
                id: entry.id.clone(),
                name: entry.name.clone(),
                object_type: entry.object_type.clone(),
                instance_id: entry.instance_id.clone(),
                description: entry.description.clone(),
                capabilities: entry.capabilities.clone(),
                source: def.map(|d| d.source).unwrap_or_default(),
            }
        })
        .collect();

    let mut custom_functions: Option<InspectorCustomFunctions> = None;
    let mut module_scripts: Vec<InspectorModuleScriptDetail> = Vec::new();
    for entry in &manifest.module_scripts {
        let def: Option<ScriptDef> = read_json(
            reg,
            &package_name,
            &version,
            &format!("modules/{}.json", entry.id),
        );
        let source = def.map(|d| d.source).unwrap_or_default();
        if entry.id == CUSTOM_FUNCTIONS_MODULE_ID {
            // The Custom Functions library rides as a reserved module whose
            // source is a JSON document { functions: [...], capabilities: [...] }.
            // It gets its own card — do NOT also list it as an ordinary module
            // script (its "source" would render as a raw JSON blob).
            if let Ok(lib) = serde_json::from_str::<serde_json::Value>(&source) {
                custom_functions = Some(InspectorCustomFunctions {
                    function_names: jarr(&lib, &["functions"])
                        .map(|fns| fns.iter().filter_map(|f| jstr(f, &["name"])).collect())
                        .unwrap_or_default(),
                    capabilities: jarr(&lib, &["capabilities"])
                        .map(|caps| {
                            caps.iter()
                                .filter_map(|c| c.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                });
            }
            continue;
        }
        module_scripts.push(InspectorModuleScriptDetail {
            id: entry.id.clone(),
            name: entry.name.clone(),
            scope: entry.scope.clone(),
            description: entry.description.clone(),
            source,
        });
    }

    let notebooks: Vec<InspectorNotebookDetail> = manifest
        .notebooks
        .iter()
        .map(|entry| {
            let def: Option<NotebookDef> = read_json(
                reg,
                &package_name,
                &version,
                &format!("notebooks/{}.json", entry.id),
            );
            InspectorNotebookDetail {
                id: entry.id.clone(),
                name: entry.name.clone(),
                cells: def
                    .map(|d| {
                        d.cells
                            .into_iter()
                            .map(|c| InspectorNotebookCell {
                                id: c.id,
                                source: c.source,
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect();

    Ok(InspectorScripts {
        object_scripts,
        module_scripts,
        notebooks,
        custom_functions,
    })
}

// ============================================================================
// Embedded BI model summary
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorModelColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorModelTable {
    pub name: String,
    pub columns: Vec<InspectorModelColumn>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorModelMeasure {
    pub name: String,
    /// Measure group, when the model organizes measures into groups.
    pub group: Option<String>,
    pub expression: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorModelRelationship {
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSnapshotDetail {
    pub table: String,
    pub path: String,
    pub size_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorModel {
    pub data_source_id: String,
    pub name: String,
    pub model_format_version: Option<u64>,
    pub tables: Vec<InspectorModelTable>,
    pub measures: Vec<InspectorModelMeasure>,
    pub relationships: Vec<InspectorModelRelationship>,
    pub calculated_column_count: usize,
    pub hierarchy_count: usize,
    pub calculation_group_count: usize,
    pub kpi_count: usize,
    pub security_role_count: usize,
    pub global_variable_count: usize,
    pub script_function_count: usize,
    pub context_count: usize,
    pub date_table: Option<String>,
    pub calculated_table_snapshots: Vec<InspectorSnapshotDetail>,
    pub has_writeback_history: bool,
}

/// Summary of one embedded BI model (schema only — packages never carry
/// credentials). Field access is defensive because the engine's model JSON is
/// snake_case while a ModelBundle wrapper is camelCase.
#[tauri::command]
pub fn calp_inspector_model(
    registry_path: String,
    package_name: String,
    version_pin: String,
    data_source_id: String,
    window: tauri::Window,
) -> Result<InspectorModel, String> {
    window_guard::require_label(&window, window_guard::MAIN_AND_PACKAGE_INSPECTOR)?;
    let (registry, version, manifest) =
        open_verified_content(&registry_path, &package_name, &version_pin, true)?;
    let reg = registry.as_ref();

    let ds = manifest
        .data_sources
        .iter()
        .find(|d| d.id == data_source_id)
        .ok_or_else(|| format!("Data source '{}' is not in this package.", data_source_id))?;

    let raw: serde_json::Value = read_json(reg, &package_name, &version, &ds.model_path)
        .ok_or_else(|| format!("Model artifact '{}' is missing or unreadable.", ds.model_path))?;
    // Unwrap a ModelBundle wrapper ({ formatVersion, model }) if present.
    let model = if raw.get("model").is_some() && raw.get("formatVersion").is_some() {
        raw.get("model").cloned().unwrap_or(raw)
    } else {
        raw
    };

    let tables: Vec<InspectorModelTable> = jarr(&model, &["tables"])
        .map(|ts| {
            ts.iter()
                .map(|t| InspectorModelTable {
                    name: jstr(t, &["name"]).unwrap_or_default(),
                    columns: jarr(t, &["columns"])
                        .map(|cols| {
                            cols.iter()
                                .map(|c| InspectorModelColumn {
                                    name: jstr(c, &["name"]).unwrap_or_default(),
                                    data_type: jget(c, &["dataType", "data_type"])
                                        .map(|dt| match dt.as_str() {
                                            Some(s) => s.to_string(),
                                            None => dt.to_string(),
                                        })
                                        .unwrap_or_default(),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    // Engine Measure: the human-readable text is under "source"; "expression"
    // is the serialized AST (an object). Fall back to a compact AST dump so a
    // builder-constructed measure without source text is not shown blank.
    let measures: Vec<InspectorModelMeasure> = jarr(&model, &["measures"])
        .map(|ms| {
            ms.iter()
                .map(|m| InspectorModelMeasure {
                    name: jstr(m, &["name"]).unwrap_or_default(),
                    group: jstr(m, &["group"]),
                    expression: jstr(m, &["source"])
                        .or_else(|| jget(m, &["expression"]).map(|v| v.to_string()))
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    // Engine Relationship: the join columns live INSIDE the conditions array
    // (JoinCondition { from_column, to_column, operator }), not at top level.
    // Multi-condition (range/non-equi) joins list all columns comma-joined.
    let relationships: Vec<InspectorModelRelationship> = jarr(&model, &["relationships"])
        .map(|rs| {
            rs.iter()
                .map(|r| {
                    let conds = jarr(r, &["conditions"]);
                    let cols = |keys: &[&str]| -> String {
                        conds
                            .map(|cs| {
                                cs.iter()
                                    .filter_map(|c| jstr(c, keys))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            })
                            .unwrap_or_default()
                    };
                    InspectorModelRelationship {
                        from_table: jstr(r, &["from_table", "fromTable"]).unwrap_or_default(),
                        from_column: cols(&["from_column", "fromColumn"]),
                        to_table: jstr(r, &["to_table", "toTable"]).unwrap_or_default(),
                        to_column: cols(&["to_column", "toColumn"]),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let snapshots: Vec<InspectorSnapshotDetail> = ds
        .calculated_table_snapshots
        .iter()
        .map(|s| InspectorSnapshotDetail {
            table: s.table.clone(),
            path: s.path.clone(),
            size_bytes: reg
                .read_artifact(&package_name, &version, &s.path)
                .ok()
                .flatten()
                .map(|b| b.len())
                .unwrap_or(0),
        })
        .collect();

    Ok(InspectorModel {
        data_source_id: ds.id.clone(),
        name: ds.name.clone(),
        model_format_version: jget(&model, &["format_version", "formatVersion"])
            .and_then(|v| v.as_u64()),
        tables,
        measures,
        relationships,
        calculated_column_count: jarr_len(&model, &["calculated_columns", "calculatedColumns"]),
        hierarchy_count: jarr_len(&model, &["hierarchies"]),
        calculation_group_count: jarr_len(&model, &["calculation_groups", "calculationGroups"]),
        kpi_count: jarr_len(&model, &["kpis"]),
        security_role_count: jarr_len(&model, &["security_roles", "securityRoles"]),
        global_variable_count: jarr_len(&model, &["global_variables", "globalVariables"]),
        script_function_count: jarr_len(&model, &["script_functions", "scriptFunctions"]),
        context_count: jarr_len(&model, &["contexts"]),
        date_table: jstr(&model, &["date_table", "dateTable"]),
        calculated_table_snapshots: snapshots,
        has_writeback_history: manifest
            .artifact_checksums
            .contains_key(&format!("models/{}/writeback_history.json", ds.id)),
    })
}

// ============================================================================
// Writeback (declarations + post-publish responses)
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorWritebackRegion {
    pub id: String,
    pub sheet_name: String,
    pub range: String,
    pub mode: Option<String>,
    pub value_type: Option<String>,
    pub visibility: Option<String>,
    pub submission_policy: Option<String>,
    pub version_binding: Option<String>,
    pub lifecycle: Option<String>,
    pub aggregation_hint: Option<String>,
    pub expected_respondents: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorModelWriteback {
    pub id: String,
    pub data_source_id: String,
    pub table: String,
    pub column: String,
    pub key_columns: Vec<String>,
    pub kind: String,
    pub value_type: Option<String>,
    pub allowed_editors: Vec<String>,
    pub submission_policy: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorRegionStats {
    pub region_id: String,
    pub submission_count: usize,
    pub submitter_count: usize,
    pub approved: usize,
    pub rejected: usize,
    pub pending: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSubmissionDetail {
    pub region_id: String,
    pub submitter_name: String,
    pub cell_row: u32,
    pub cell_col: u32,
    pub model_key: Option<Vec<String>>,
    pub value_display: String,
    pub value_kind: String,
    pub state: String,
    pub updated_at: String,
    /// Publisher's approve/reject feedback, when a decision exists.
    pub review_reason: Option<String>,
    pub reviewed_by: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorWriteback {
    pub regions: Vec<InspectorWritebackRegion>,
    pub model_writebacks: Vec<InspectorModelWriteback>,
    /// Response activity — stats, counts, values, and rollup presence — is
    /// PUBLISHER-ONLY (possession of the signing key). Even aggregated
    /// cross-submitter counts would bypass a region's VisibilityPolicy
    /// (own_only promises subscribers see nothing of each other), matching
    /// the calp_region_response_status / calp_load_region_submissions gates.
    /// Non-publishers get empty stats and zero counts.
    pub region_stats: Vec<InspectorRegionStats>,
    pub total_submissions: usize,
    pub review_event_count: usize,
    pub is_publisher: bool,
    /// Value-level detail — publisher-only like the stats.
    pub submissions: Vec<InspectorSubmissionDetail>,
    /// Whether the derived Parquet rollup exists at
    /// submissions/_rollup.parquet (publisher-only; unsigned trust domain).
    pub rollup_present: bool,
    pub rollup_size_bytes: Option<usize>,
}

fn enum_str<T: Serialize>(v: &Option<T>) -> Option<String> {
    v.as_ref().and_then(|x| {
        let j = serde_json::to_value(x).ok()?;
        match j {
            serde_json::Value::String(s) => Some(s),
            // Struct-like enum variants (e.g. LifecyclePolicy::UntilDeadline)
            // serialize as objects; surface their tag.
            serde_json::Value::Object(map) => map
                .get("policy")
                .and_then(|p| p.as_str().map(str::to_string))
                .or_else(|| map.keys().next().cloned()),
            other => Some(other.to_string()),
        }
    })
}

fn submission_state_str(state: &SubmissionState) -> String {
    match state {
        SubmissionState::Draft => "draft",
        SubmissionState::Submitted => "submitted",
        SubmissionState::Approved => "approved",
        SubmissionState::Rejected => "rejected",
    }
    .to_string()
}

/// Writeback declarations + folded post-publish response activity.
#[tauri::command]
pub fn calp_inspector_writeback(
    registry_path: String,
    package_name: String,
    version_pin: String,
    window: tauri::Window,
) -> Result<InspectorWriteback, String> {
    window_guard::require_label(&window, window_guard::MAIN_AND_PACKAGE_INSPECTOR)?;
    let (registry, version, manifest) =
        open_verified_content(&registry_path, &package_name, &version_pin, true)?;
    let reg = registry.as_ref();
    let profile_dir = calcula_profile_dir();

    let sheet_names: HashMap<String, String> = manifest
        .sheets
        .iter()
        .map(|s| (s.sheet_id.to_string(), s.name.clone()))
        .collect();

    let regions: Vec<InspectorWritebackRegion> = manifest
        .writeback_regions
        .clone()
        .unwrap_or_default()
        .iter()
        .map(|r| InspectorWritebackRegion {
            id: r.id.clone(),
            sheet_name: sheet_name_for(&sheet_names, &r.selector.sheet_id.to_string()),
            range: format!(
                "{}:{}",
                cell_ref::to_a1(r.selector.row_start, r.selector.col_start),
                cell_ref::to_a1(r.selector.row_end, r.selector.col_end)
            ),
            mode: enum_str(&r.mode),
            value_type: r
                .schema
                .as_ref()
                .and_then(|s| enum_str(&Some(s.value_type.clone()))),
            visibility: enum_str(&r.visibility),
            submission_policy: enum_str(&r.submission_policy),
            version_binding: enum_str(&r.version_binding),
            lifecycle: enum_str(&r.lifecycle),
            aggregation_hint: r.aggregation_hint.clone(),
            expected_respondents: r.expected_respondents.clone(),
        })
        .collect();

    let model_writebacks: Vec<InspectorModelWriteback> = manifest
        .model_writebacks
        .clone()
        .unwrap_or_default()
        .iter()
        .map(|m| InspectorModelWriteback {
            id: m.id.clone(),
            data_source_id: m.data_source_id.clone(),
            table: m.table.clone(),
            column: m.column.clone(),
            key_columns: m.key_columns.clone(),
            kind: m.kind.clone(),
            value_type: m
                .schema
                .as_ref()
                .and_then(|s| enum_str(&Some(s.value_type.clone()))),
            allowed_editors: m.allowed_editors.clone(),
            submission_policy: enum_str(&m.submission_policy),
        })
        .collect();

    // Post-publish response activity is PUBLISHER-ONLY, values AND aggregates:
    // a region's VisibilityPolicy (e.g. own_only) promises subscribers see
    // nothing of each other, and even counts leak review outcomes when the
    // respondents are known — the same reasoning that publisher-gates
    // calp_region_response_status. Non-publishers get empty activity.
    let is_publisher =
        calp::signing::profile_holds_publisher_key(&profile_dir, &manifest.publisher_key)
            .unwrap_or(false);

    // Folded current state (separate, UNSIGNED trust domain). Failures degrade
    // to "no activity" — a missing submissions tree is normal for a package
    // nobody has responded to.
    let submissions = if is_publisher {
        reg.load_current_submissions(&package_name, &version)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let review_event_count = if is_publisher {
        reg.load_review_events(&package_name, &version)
            .map(|r| r.len())
            .unwrap_or(0)
    } else {
        0
    };

    let mut per_region: BTreeMap<String, (usize, std::collections::HashSet<String>, usize, usize, usize)> =
        BTreeMap::new();
    for s in &submissions {
        let entry = per_region.entry(s.region_id.clone()).or_default();
        entry.0 += 1;
        entry.1.insert(s.submitter.id.clone());
        match s.state {
            SubmissionState::Approved => entry.2 += 1,
            SubmissionState::Rejected => entry.3 += 1,
            _ => entry.4 += 1,
        }
    }
    let region_stats: Vec<InspectorRegionStats> = per_region
        .into_iter()
        .map(
            |(region_id, (count, submitters, approved, rejected, pending))| InspectorRegionStats {
                region_id,
                submission_count: count,
                submitter_count: submitters.len(),
                approved,
                rejected,
                pending,
            },
        )
        .collect();

    let submission_details: Vec<InspectorSubmissionDetail> = submissions
        .iter()
        .map(|s| {
            let (value_display, value_kind) = submission_value_display(&s.value);
            InspectorSubmissionDetail {
                region_id: s.region_id.clone(),
                submitter_name: s.submitter.display_name.clone(),
                cell_row: s.cell_row,
                cell_col: s.cell_col,
                model_key: s.model_key.clone(),
                value_display,
                value_kind,
                state: submission_state_str(&s.state),
                updated_at: s.updated_at.clone(),
                review_reason: s.review_reason.clone(),
                reviewed_by: s.reviewed_by.clone(),
            }
        })
        .collect();

    // The derived Parquet rollup (publisher-refreshed, lives under the
    // unsigned submissions/ subtree so no other surface lists it).
    let rollup_size_bytes = if is_publisher {
        reg.read_artifact(&package_name, &version, "submissions/_rollup.parquet")
            .ok()
            .flatten()
            .map(|b| b.len())
    } else {
        None
    };

    Ok(InspectorWriteback {
        regions,
        model_writebacks,
        region_stats,
        total_submissions: submissions.len(),
        review_event_count,
        is_publisher,
        submissions: submission_details,
        rollup_present: rollup_size_bytes.is_some(),
        rollup_size_bytes,
    })
}

// ============================================================================
// Raw artifact view + integrity verification
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorArtifact {
    pub path: String,
    pub size_bytes: usize,
    pub sha256: String,
    pub expected_sha256: String,
    /// Whether the read bytes hash to the signed manifest's checksum.
    pub verified: bool,
    /// "json" | "text" | "binary".
    pub content_kind: String,
    /// Pretty-printed JSON or raw text; None for binary artifacts. Capped.
    pub text: Option<String>,
    pub truncated: bool,
}

const MAX_ARTIFACT_TEXT: usize = 2_000_000;

/// Truncate to at most `max` bytes WITHOUT splitting a UTF-8 character —
/// String::truncate panics mid-char, and pretty-printed JSON emits non-ASCII
/// (å/ä/ö, emoji) as raw UTF-8, so a fixed byte cut can land inside one.
fn truncate_at_char_boundary(t: &mut String, max: usize) {
    if t.len() > max {
        let mut end = max;
        while !t.is_char_boundary(end) {
            end -= 1;
        }
        t.truncate(end);
    }
}

/// Raw view of ONE artifact. Only paths listed in the signed manifest's
/// checksum map are readable (blocks traversal and unsigned content).
#[tauri::command]
pub fn calp_inspector_artifact(
    registry_path: String,
    package_name: String,
    version_pin: String,
    artifact_path: String,
    window: tauri::Window,
) -> Result<InspectorArtifact, String> {
    window_guard::require_label(&window, window_guard::MAIN_AND_PACKAGE_INSPECTOR)?;
    // No up-front artifact walk: this command hashes the requested artifact
    // itself and REPORTS a mismatch (verified: false) instead of failing —
    // it is the audit surface for exactly that case.
    let (registry, version, manifest) =
        open_verified_content(&registry_path, &package_name, &version_pin, false)?;

    let expected = manifest
        .artifact_checksums
        .get(&artifact_path)
        .cloned()
        .ok_or_else(|| {
            format!(
                "'{}' is not an artifact of this package version (only signed artifacts are readable).",
                artifact_path
            )
        })?;

    let bytes = registry
        .read_artifact(&package_name, &version, &artifact_path)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Artifact '{}' is missing from the registry.", artifact_path))?;

    let actual = sha256_hex(&bytes);
    let verified = actual == expected;

    let (content_kind, text, truncated) =
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(v) => {
                let pretty = serde_json::to_string_pretty(&v).unwrap_or_default();
                let truncated = pretty.len() > MAX_ARTIFACT_TEXT;
                let mut t = pretty;
                truncate_at_char_boundary(&mut t, MAX_ARTIFACT_TEXT);
                ("json".to_string(), Some(t), truncated)
            }
            Err(_) => match String::from_utf8(bytes.clone()) {
                Ok(s) => {
                    let truncated = s.len() > MAX_ARTIFACT_TEXT;
                    let mut t = s;
                    truncate_at_char_boundary(&mut t, MAX_ARTIFACT_TEXT);
                    ("text".to_string(), Some(t), truncated)
                }
                Err(_) => ("binary".to_string(), None, false),
            },
        };

    Ok(InspectorArtifact {
        path: artifact_path,
        size_bytes: bytes.len(),
        sha256: actual,
        expected_sha256: expected,
        verified,
        content_kind,
        text,
        truncated,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorArtifactVerification {
    pub path: String,
    /// "ok" | "mismatch" | "missing".
    pub status: String,
    pub size_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorVerifyReport {
    pub signature_ok: bool,
    pub trust_status: String,
    pub publisher_name: String,
    pub artifacts: Vec<InspectorArtifactVerification>,
    /// Files present under the version that the signed manifest does NOT list
    /// (excluding the post-publish submissions/reviews trust domain).
    pub unlisted: Vec<String>,
    pub all_ok: bool,
}

/// Full integrity audit: hash every signed artifact and report per-artifact
/// status instead of failing on the first problem (unlike pull's gate).
#[tauri::command]
pub fn calp_inspector_verify_artifacts(
    registry_path: String,
    package_name: String,
    version_pin: String,
    window: tauri::Window,
) -> Result<InspectorVerifyReport, String> {
    window_guard::require_label(&window, window_guard::MAIN_AND_PACKAGE_INSPECTOR)?;
    // Reaching this point means the SIGNATURE verified (open_verified errors
    // otherwise, and the UI surfaces that error as the report). The artifact
    // walk is deliberately NOT run up-front here — this command's whole job
    // is the per-artifact report below.
    let (registry, version, trust, manifest) =
        open_verified(&registry_path, &package_name, &version_pin, false)?;
    let reg = registry.as_ref();

    let mut artifacts = Vec::new();
    let mut all_ok = true;
    for (path, expected) in &manifest.artifact_checksums {
        let (status, size) = match reg.read_artifact(&package_name, &version, path) {
            Ok(Some(bytes)) => {
                if sha256_hex(&bytes) == *expected {
                    ("ok", bytes.len())
                } else {
                    ("mismatch", bytes.len())
                }
            }
            _ => ("missing", 0),
        };
        if status != "ok" {
            all_ok = false;
        }
        artifacts.push(InspectorArtifactVerification {
            path: path.clone(),
            status: status.to_string(),
            size_bytes: size,
        });
    }

    // Loose files the manifest does not list. After blob commit the version
    // dir holds nothing loose, so this is usually empty for local registries.
    let unlisted: Vec<String> = reg
        .list_artifacts(&package_name, &version)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !manifest.artifact_checksums.contains_key(p))
        .collect();
    if !unlisted.is_empty() {
        all_ok = false;
    }

    Ok(InspectorVerifyReport {
        signature_ok: true,
        trust_status: trust_status_str(trust),
        publisher_name: manifest.publisher_name.clone(),
        artifacts,
        unlisted,
        all_ok,
    })
}
