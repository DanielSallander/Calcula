//! FILENAME: core/calcula-format/src/publish/writer.rs
//! Writes published sheets to a user-chosen publication directory.

use crate::error::FormatError;
use crate::sheet_data::cells_to_sheet_data;
use crate::sheet_layout::SheetLayout;
use crate::sheet_styles::{cells_to_sheet_styles, serialize_style_registry};

use super::manifest::{PublishManifest, PublishedScript, PublishedSheet};
use persistence::Workbook;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// A script to be published alongside a sheet.
#[derive(Debug, Clone)]
pub struct ScriptToPublish {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub source: String,
    /// The sheet name this script is scoped to.
    pub sheet_name: String,
}

/// Request to publish selected sheets from a workbook.
#[derive(Debug, Clone)]
pub struct PublishRequest {
    /// Which sheets to publish (by index).
    pub sheet_indices: Vec<usize>,
    /// Optional per-sheet descriptions (parallel with sheet_indices).
    pub descriptions: Vec<String>,
    /// Author identifier.
    pub author: String,
    /// ISO 8601 timestamp of this publish action.
    pub now: String,
    /// Scripts scoped to the published sheets.
    pub scripts: Vec<ScriptToPublish>,
}

/// Result of a publish operation.
#[derive(Debug, Clone)]
pub struct PublishResult {
    /// The updated manifest after publishing.
    pub manifest: PublishManifest,
    /// Number of sheets that were created or updated.
    pub sheets_published: usize,
}

/// Publish selected sheets from a workbook to a publication directory.
///
/// The publication directory is a flat folder containing `publish-manifest.json`
/// and a `sheets/` subdirectory with one folder per published sheet.
///
/// If a sheet has already been published (matched by stable ID), its version
/// is bumped and content is overwritten. New sheets get version 1.
pub fn publish_sheets(
    workbook: &Workbook,
    request: &PublishRequest,
    pub_dir: &Path,
) -> Result<PublishResult, FormatError> {
    // Ensure the publication directory and sheets subdirectory exist
    std::fs::create_dir_all(pub_dir.join("sheets"))?;

    // Load existing manifest or create a new one
    let manifest_path = pub_dir.join("publish-manifest.json");
    let mut manifest = if manifest_path.exists() {
        let content = std::fs::read_to_string(&manifest_path)?;
        serde_json::from_str::<PublishManifest>(&content)?
    } else {
        PublishManifest::new(
            request.author.clone(),
            request.now.clone(),
        )
    };

    // Update manifest-level timestamp and author
    manifest.published_at = request.now.clone();
    manifest.published_by = request.author.clone();

    let mut sheets_published = 0;

    for (i, &sheet_idx) in request.sheet_indices.iter().enumerate() {
        let sheet = workbook.sheets.get(sheet_idx).ok_or_else(|| {
            FormatError::InvalidFormat(format!("Sheet index {} out of range", sheet_idx))
        })?;

        let description = request
            .descriptions
            .get(i)
            .cloned()
            .unwrap_or_default();

        // Generate a stable ID from the sheet name (lowercase, hyphens)
        let stable_id = generate_stable_id(&sheet.name);

        // Serialize sheet data
        let sheet_data = cells_to_sheet_data(&sheet.cells);
        let data_json = serde_json::to_string_pretty(&sheet_data)?;

        // Compute checksum of the data
        let checksum = compute_checksum(data_json.as_bytes());

        // Serialize styles
        let sheet_styles = cells_to_sheet_styles(&sheet.cells);
        let styles_json = serde_json::to_string_pretty(&sheet_styles)?;

        // Serialize layout
        let layout = SheetLayout::from_dimensions(&sheet.column_widths, &sheet.row_heights);
        let layout_json = serde_json::to_string_pretty(&layout)?;

        // Serialize style registry
        let registry_json = serialize_style_registry(&sheet.styles)?;

        // Determine the folder name
        let folder = if let Some(existing) = manifest.find_sheet(&stable_id) {
            existing.folder.clone()
        } else {
            let idx = manifest.sheets.len();
            format!("{}_{}", idx, sanitize_folder_name(&sheet.name))
        };

        // Write files to the publication directory
        let sheet_dir = pub_dir.join("sheets").join(&folder);
        std::fs::create_dir_all(&sheet_dir)?;

        std::fs::write(sheet_dir.join("data.json"), data_json.as_bytes())?;
        std::fs::write(sheet_dir.join("styles.json"), styles_json.as_bytes())?;
        std::fs::write(sheet_dir.join("layout.json"), layout_json.as_bytes())?;
        std::fs::write(
            pub_dir.join("styles").join(format!("{}_registry.json", folder)),
            registry_json.as_bytes(),
        )?;

        // Collect script IDs scoped to this sheet
        let script_ids: Vec<String> = request
            .scripts
            .iter()
            .filter(|s| s.sheet_name == sheet.name)
            .map(|s| s.id.clone())
            .collect();

        // Update or insert the manifest entry
        if let Some(entry) = manifest.find_sheet_mut(&stable_id) {
            entry.name = sheet.name.clone();
            entry.description = description;
            entry.published_at = request.now.clone();
            entry.version += 1;
            entry.checksum = checksum;
            entry.script_ids = script_ids;
        } else {
            manifest.sheets.push(PublishedSheet {
                id: stable_id,
                name: sheet.name.clone(),
                folder,
                description,
                published_at: request.now.clone(),
                version: 1,
                checksum,
                script_ids,
            });
        }

        sheets_published += 1;
    }

    // Write scripts scoped to published sheets
    if !request.scripts.is_empty() {
        std::fs::create_dir_all(pub_dir.join("scripts"))?;

        // Replace all published scripts with the current set
        manifest.scripts.clear();

        for script in &request.scripts {
            let published_script = PublishedScript {
                id: script.id.clone(),
                name: script.name.clone(),
                description: script.description.clone(),
                source: script.source.clone(),
                sheet_name: script.sheet_name.clone(),
            };

            // Write individual script file
            let script_json = serde_json::to_string_pretty(&published_script)?;
            std::fs::write(
                pub_dir.join("scripts").join(format!("script_{}.json", script.id)),
                script_json.as_bytes(),
            )?;

            manifest.scripts.push(published_script);
        }
    }

    // Ensure styles directory exists for registry files
    std::fs::create_dir_all(pub_dir.join("styles"))?;

    // Write the updated manifest
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    std::fs::write(&manifest_path, manifest_json.as_bytes())?;

    Ok(PublishResult {
        manifest,
        sheets_published,
    })
}

/// Remove a published sheet from the publication directory.
pub fn unpublish_sheet(pub_dir: &Path, sheet_id: &str) -> Result<(), FormatError> {
    let manifest_path = pub_dir.join("publish-manifest.json");
    if !manifest_path.exists() {
        return Err(FormatError::MissingEntry(
            "publish-manifest.json not found".to_string(),
        ));
    }

    let content = std::fs::read_to_string(&manifest_path)?;
    let mut manifest: PublishManifest = serde_json::from_str(&content)?;

    let idx = manifest
        .sheets
        .iter()
        .position(|s| s.id == sheet_id)
        .ok_or_else(|| {
            FormatError::MissingEntry(format!("Published sheet '{}' not found", sheet_id))
        })?;

    let removed = manifest.sheets.remove(idx);

    // Remove the sheet's directory
    let sheet_dir = pub_dir.join("sheets").join(&removed.folder);
    if sheet_dir.exists() {
        std::fs::remove_dir_all(&sheet_dir)?;
    }

    // Remove the sheet's style registry
    let registry_path = pub_dir
        .join("styles")
        .join(format!("{}_registry.json", removed.folder));
    if registry_path.exists() {
        std::fs::remove_file(&registry_path)?;
    }

    // Write updated manifest
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    std::fs::write(&manifest_path, manifest_json.as_bytes())?;

    Ok(())
}

/// Compute a deterministic hash of data for change detection.
/// Uses SipHash (via DefaultHasher) which is sufficient for detecting
/// content changes. Not cryptographic, but we only need change detection.
pub fn compute_checksum(data: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    let hash = hasher.finish();
    format!("hash:{:016x}", hash)
}

/// Generate a stable ID from a sheet name.
/// Converts to lowercase, replaces non-alphanumeric chars with hyphens,
/// collapses multiple hyphens, and trims leading/trailing hyphens.
fn generate_stable_id(name: &str) -> String {
    let id: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();

    // Collapse multiple hyphens and trim
    let mut result = String::new();
    let mut prev_hyphen = true; // Start true to trim leading hyphens
    for c in id.chars() {
        if c == '-' {
            if !prev_hyphen {
                result.push(c);
            }
            prev_hyphen = true;
        } else {
            result.push(c);
            prev_hyphen = false;
        }
    }

    // Trim trailing hyphen
    if result.ends_with('-') {
        result.pop();
    }

    if result.is_empty() {
        "unnamed-sheet".to_string()
    } else {
        result
    }
}

/// Sanitize a sheet name for use as a folder name.
fn sanitize_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::theme::ThemeDefinition;
    use persistence::{SavedCell, SavedCellValue, Sheet};
    use std::collections::HashMap;

    fn make_test_workbook() -> Workbook {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Revenue".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(5000.0),
                formula: Some("=B2*10".to_string()),
                style_index: 0,
                rich_text: None,
            },
        );

        Workbook {
            sheets: vec![
                Sheet {
                    name: "Sales Dashboard".to_string(),
                    cells,
                    column_widths: HashMap::new(),
                    row_heights: HashMap::new(),
                    styles: vec![engine::style::CellStyle::new()],
                },
                Sheet {
                    name: "Regional".to_string(),
                    cells: HashMap::new(),
                    column_widths: HashMap::new(),
                    row_heights: HashMap::new(),
                    styles: vec![engine::style::CellStyle::new()],
                },
            ],
            active_sheet: 0,
            tables: vec![],
            slicers: vec![],
            user_files: HashMap::new(),
            theme: ThemeDefinition::default(),
            scripts: Vec::new(),
            notebooks: Vec::new(),
            default_row_height: 24.0,
            default_column_width: 100.0,
            properties: persistence::WorkbookProperties::default(),
            charts: Vec::new(),
        }
    }

    #[test]
    fn test_publish_creates_directory_structure() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let pub_dir = dir.path().join("sales.calp-pub");

        let request = PublishRequest {
            sheet_indices: vec![0],
            descriptions: vec!["Monthly revenue".to_string()],
            author: "jane.doe".to_string(),
            now: "2026-04-09T12:00:00Z".to_string(),
            scripts: vec![],
        };

        let result = publish_sheets(&workbook, &request, &pub_dir).unwrap();

        assert_eq!(result.sheets_published, 1);
        assert_eq!(result.manifest.sheets.len(), 1);
        assert_eq!(result.manifest.sheets[0].version, 1);

        // Verify files exist
        assert!(pub_dir.join("publish-manifest.json").exists());
        let sheet_folder = &result.manifest.sheets[0].folder;
        assert!(pub_dir.join("sheets").join(sheet_folder).join("data.json").exists());
        assert!(pub_dir.join("sheets").join(sheet_folder).join("styles.json").exists());
        assert!(pub_dir.join("sheets").join(sheet_folder).join("layout.json").exists());
    }

    #[test]
    fn test_republish_bumps_version() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let pub_dir = dir.path().join("sales.calp-pub");

        let request = PublishRequest {
            sheet_indices: vec![0],
            descriptions: vec![],
            author: "jane.doe".to_string(),
            now: "2026-04-09T12:00:00Z".to_string(),
            scripts: vec![],
        };

        // Publish once
        let result1 = publish_sheets(&workbook, &request, &pub_dir).unwrap();
        assert_eq!(result1.manifest.sheets[0].version, 1);

        // Publish again
        let result2 = publish_sheets(&workbook, &request, &pub_dir).unwrap();
        assert_eq!(result2.manifest.sheets[0].version, 2);
        assert_eq!(result2.manifest.sheets.len(), 1); // Still just one sheet
    }

    #[test]
    fn test_publish_multiple_sheets() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let pub_dir = dir.path().join("sales.calp-pub");

        let request = PublishRequest {
            sheet_indices: vec![0, 1],
            descriptions: vec!["Dashboard".to_string(), "By region".to_string()],
            author: "jane.doe".to_string(),
            now: "2026-04-09T12:00:00Z".to_string(),
            scripts: vec![],
        };

        let result = publish_sheets(&workbook, &request, &pub_dir).unwrap();
        assert_eq!(result.sheets_published, 2);
        assert_eq!(result.manifest.sheets.len(), 2);
    }

    #[test]
    fn test_unpublish_sheet() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let pub_dir = dir.path().join("sales.calp-pub");

        let request = PublishRequest {
            sheet_indices: vec![0, 1],
            descriptions: vec![],
            author: "jane.doe".to_string(),
            now: "2026-04-09T12:00:00Z".to_string(),
            scripts: vec![],
        };

        let result = publish_sheets(&workbook, &request, &pub_dir).unwrap();
        let sheet_id = result.manifest.sheets[0].id.clone();
        let folder = result.manifest.sheets[0].folder.clone();

        // Unpublish the first sheet
        unpublish_sheet(&pub_dir, &sheet_id).unwrap();

        // Verify the sheet's directory was removed
        assert!(!pub_dir.join("sheets").join(&folder).exists());

        // Verify manifest was updated
        let manifest_content = std::fs::read_to_string(pub_dir.join("publish-manifest.json")).unwrap();
        let manifest: PublishManifest = serde_json::from_str(&manifest_content).unwrap();
        assert_eq!(manifest.sheets.len(), 1);
        assert_ne!(manifest.sheets[0].id, sheet_id);
    }

    #[test]
    fn test_generate_stable_id() {
        assert_eq!(generate_stable_id("Sales Dashboard"), "sales-dashboard");
        assert_eq!(generate_stable_id("Q1/Q2 Report"), "q1-q2-report");
        assert_eq!(generate_stable_id("  spaces  "), "spaces");
        assert_eq!(generate_stable_id(""), "unnamed-sheet");
    }

    #[test]
    fn test_checksum_deterministic() {
        let data = b"hello world";
        let c1 = compute_checksum(data);
        let c2 = compute_checksum(data);
        assert_eq!(c1, c2);
        assert!(c1.starts_with("hash:"));
    }
}
