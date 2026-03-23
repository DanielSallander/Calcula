//! FILENAME: app/src-tauri/src/distribution.rs
//! Tauri commands for the Report Distribution system.
//! Handles parsing, exporting, and browsing `.calp` package files.

use serde::{Deserialize, Serialize};
use tauri::State;
use std::io::Write;

use calcula_format::package::manifest::{
    PackageManifest, PackageContent, PackageContentType,
    DataSourceDeclaration, DataSourceType, DataSourceColumn, ColumnType,
};
use calcula_format::package::parser::{parse_package, parse_package_metadata};
use calcula_format::package::exporter::{export_package, build_contents_list, ExportRequest};
use calcula_format::package::merger::{
    merge_package as do_merge, BindingTarget, ConflictStrategy, DataBinding, MergeOptions,
};

use crate::AppState;
use crate::persistence::UserFilesState;

// ─── API types for frontend ────────────────────────────────────────────────────

/// Package info returned to the frontend (mirrors PackageManifest with camelCase).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfoJson {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub tags: Vec<String>,
    pub contents: Vec<PackageContentJson>,
    pub data_sources: Vec<DataSourceJson>,
    pub required_extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageContentJson {
    #[serde(rename = "type")]
    pub content_type: String,
    pub path: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceJson {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub source_type: String,
    pub columns: Vec<DataSourceColumnJson>,
    pub internal_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceColumnJson {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub required: bool,
}

/// Request from frontend to export a package.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPackageRequest {
    pub output_path: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub tags: Vec<String>,
    pub sheet_indices: Vec<usize>,
    pub table_ids: Vec<u64>,
    pub file_paths: Vec<String>,
    pub data_sources: Vec<DataSourceJson>,
}

/// Request from frontend to list packages in a directory.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePackagesRequest {
    pub directory: String,
}

// ─── Conversion helpers ────────────────────────────────────────────────────────

fn manifest_to_json(m: &PackageManifest) -> PackageInfoJson {
    PackageInfoJson {
        id: m.id.clone(),
        name: m.name.clone(),
        version: m.version.clone(),
        description: m.description.clone(),
        author: m.author.clone(),
        tags: m.tags.clone(),
        contents: m.contents.iter().map(content_to_json).collect(),
        data_sources: m.data_sources.iter().map(datasource_to_json).collect(),
        required_extensions: m.required_extensions.clone(),
    }
}

fn content_to_json(c: &PackageContent) -> PackageContentJson {
    let type_str = match c.content_type {
        PackageContentType::Sheet => "sheet",
        PackageContentType::Table => "table",
        PackageContentType::Chart => "chart",
        PackageContentType::Pivot => "pivot",
        PackageContentType::File => "file",
    };
    PackageContentJson {
        content_type: type_str.to_string(),
        path: c.path.clone(),
        name: c.name.clone(),
        description: c.description.clone(),
    }
}

fn datasource_to_json(d: &DataSourceDeclaration) -> DataSourceJson {
    let type_str = match d.source_type {
        DataSourceType::Range => "range",
        DataSourceType::Table => "table",
        DataSourceType::BiConnection => "bi-connection",
    };
    DataSourceJson {
        id: d.id.clone(),
        name: d.name.clone(),
        description: d.description.clone(),
        source_type: type_str.to_string(),
        columns: d.columns.iter().map(|col| DataSourceColumnJson {
            name: col.name.clone(),
            column_type: match col.column_type {
                ColumnType::Text => "text",
                ColumnType::Number => "number",
                ColumnType::Date => "date",
                ColumnType::Boolean => "boolean",
            }.to_string(),
            required: col.required,
        }).collect(),
        internal_ref: d.internal_ref.clone(),
    }
}

fn json_to_datasources(sources: &[DataSourceJson]) -> Vec<DataSourceDeclaration> {
    sources.iter().map(|s| {
        DataSourceDeclaration {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            source_type: match s.source_type.as_str() {
                "table" => DataSourceType::Table,
                "bi-connection" => DataSourceType::BiConnection,
                _ => DataSourceType::Range,
            },
            columns: s.columns.iter().map(|c| DataSourceColumn {
                name: c.name.clone(),
                column_type: match c.column_type.as_str() {
                    "number" => ColumnType::Number,
                    "date" => ColumnType::Date,
                    "boolean" => ColumnType::Boolean,
                    _ => ColumnType::Text,
                },
                required: c.required,
            }).collect(),
            internal_ref: s.internal_ref.clone(),
        }
    }).collect()
}

// ─── Tauri commands ────────────────────────────────────────────────────────────

/// Parse a `.calp` file and return its metadata (for preview/browse).
#[tauri::command]
pub fn parse_package_info(path: String) -> Result<PackageInfoJson, String> {
    let pkg_path = std::path::Path::new(&path);
    let manifest = parse_package_metadata(pkg_path).map_err(|e| e.to_string())?;
    Ok(manifest_to_json(&manifest))
}

/// Browse a directory for `.calp` files and return their metadata.
#[tauri::command]
pub fn browse_packages(request: BrowsePackagesRequest) -> Result<Vec<PackageInfoJson>, String> {
    let dir = std::path::Path::new(&request.directory);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", request.directory));
    }

    let mut packages = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("calp") {
            match parse_package_metadata(&path) {
                Ok(manifest) => packages.push(manifest_to_json(&manifest)),
                Err(e) => {
                    // Skip invalid packages but log the error
                    eprintln!("[distribution] Skipping invalid package {:?}: {}", path, e);
                }
            }
        }
    }

    Ok(packages)
}

/// Export selected objects from the current workbook as a `.calp` package.
#[tauri::command]
pub fn export_as_package(
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    request: ExportPackageRequest,
) -> Result<String, String> {
    let workbook = crate::persistence::build_workbook_for_save(&state, &user_files_state)
        .map_err(|e| e.to_string())?;

    let contents = build_contents_list(
        &workbook,
        &request.sheet_indices,
        &request.table_ids,
        &request.file_paths,
    );

    let package = PackageManifest {
        id: request.id,
        name: request.name,
        version: request.version,
        description: request.description,
        author: request.author,
        tags: request.tags,
        contents,
        data_sources: json_to_datasources(&request.data_sources),
        min_calc_version: None,
        required_extensions: vec![],
    };

    let export_req = ExportRequest {
        package,
        sheet_indices: request.sheet_indices,
        table_ids: request.table_ids,
        file_paths: request.file_paths,
    };

    let output = std::path::Path::new(&request.output_path);
    export_package(&workbook, &export_req, output).map_err(|e| e.to_string())?;

    Ok(request.output_path)
}

// ─── Merge (import) types and command ──────────────────────────────────────────

/// Request from frontend to import a package into the current workbook.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPackageRequest {
    /// Path to the `.calp` file.
    pub path: String,
    /// How to handle sheet name collisions: "rename", "replace", or "skip".
    pub sheet_conflict: String,
    /// How to handle table name collisions: "rename", "replace", or "skip".
    pub table_conflict: String,
    /// Data source bindings.
    pub bindings: Vec<ImportBindingJson>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBindingJson {
    pub source_id: String,
    pub internal_ref: String,
    pub target_type: String, // "table" or "range"
    pub table_name: Option<String>,
    pub sheet_name: Option<String>,
    pub start_row: Option<u32>,
    pub start_col: Option<u32>,
    pub end_row: Option<u32>,
    pub end_col: Option<u32>,
}

/// Result returned to frontend after import.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResultJson {
    pub imported_sheets: Vec<String>,
    pub imported_tables: Vec<String>,
    pub imported_files: Vec<String>,
}

fn parse_conflict_strategy(s: &str) -> ConflictStrategy {
    match s {
        "replace" => ConflictStrategy::Replace,
        "skip" => ConflictStrategy::Skip,
        _ => ConflictStrategy::Rename,
    }
}

fn json_to_bindings(bindings: &[ImportBindingJson]) -> Vec<DataBinding> {
    bindings
        .iter()
        .map(|b| DataBinding {
            source_id: b.source_id.clone(),
            internal_ref: b.internal_ref.clone(),
            target: if b.target_type == "table" {
                BindingTarget::Table {
                    table_name: b.table_name.clone().unwrap_or_default(),
                }
            } else {
                BindingTarget::Range {
                    sheet_name: b.sheet_name.clone().unwrap_or_default(),
                    start_row: b.start_row.unwrap_or(0),
                    start_col: b.start_col.unwrap_or(0),
                    end_row: b.end_row.unwrap_or(0),
                    end_col: b.end_col.unwrap_or(0),
                }
            },
        })
        .collect()
}

/// Import a `.calp` package into the current workbook.
#[tauri::command]
pub fn import_package(
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    request: ImportPackageRequest,
) -> Result<ImportResultJson, String> {
    // Parse the package
    let pkg_path = std::path::Path::new(&request.path);
    let parsed = parse_package(pkg_path).map_err(|e| e.to_string())?;

    // Build merge options
    let next_table_id = {
        let next_id = state.next_table_id.lock().map_err(|e| e.to_string())?;
        *next_id
    };

    let options = MergeOptions {
        sheet_conflict: parse_conflict_strategy(&request.sheet_conflict),
        table_conflict: parse_conflict_strategy(&request.table_conflict),
        bindings: json_to_bindings(&request.bindings),
        next_table_id,
    };

    // Build current workbook, merge, then apply changes back to state
    let mut workbook = crate::persistence::build_workbook_for_save(&state, &user_files_state)
        .map_err(|e| e.to_string())?;

    let merge_result = do_merge(
        &mut workbook,
        &parsed.workbook,
        &parsed.package.id,
        &parsed.package.version,
        &options,
    )
    .map_err(|e| e.to_string())?;

    // Apply merged sheets back to AppState
    {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;

        // The merged workbook has new sheets appended. Add them to grids/names.
        let original_count = sheet_names.len();
        for sheet in workbook.sheets.iter().skip(original_count) {
            let (grid, _styles) = sheet.to_grid();
            grids.push(grid);
            sheet_names.push(sheet.name.clone());
            all_cw.push(sheet.column_widths.clone());
            all_rh.push(sheet.row_heights.clone());
        }
    }

    // Update user files
    {
        let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;
        for (path, content) in &workbook.user_files {
            if !files.contains_key(path) {
                files.insert(path.clone(), content.clone());
            }
        }
    }

    // Update next_table_id
    if !merge_result.imported_tables.is_empty() {
        let mut next_id = state.next_table_id.lock().map_err(|e| e.to_string())?;
        *next_id = options.next_table_id + merge_result.imported_tables.len() as u64;
    }

    Ok(ImportResultJson {
        imported_sheets: merge_result.imported_sheets,
        imported_tables: merge_result.imported_tables,
        imported_files: merge_result.imported_files,
    })
}

// ─── HTTP registry support ──────────────────────────────────────────────────

/// Request to download a .calp package from an HTTP registry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPackageRequest {
    /// Full URL to the .calp file (e.g. http://localhost:8080/packages/com.acme.dashboard/1.0.0/download)
    pub url: String,
    /// Package ID — used to generate the temp filename.
    pub package_id: String,
    /// Package version — used to generate the temp filename.
    pub version: String,
}

/// Download a `.calp` file from a registry URL and return the local temp path.
#[tauri::command]
pub async fn download_package(request: DownloadPackageRequest) -> Result<String, String> {
    let response = reqwest::get(&request.url)
        .await
        .map_err(|e| format!("Failed to download package: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Registry returned HTTP {}: {}",
            response.status().as_u16(),
            response.status().canonical_reason().unwrap_or("Unknown error")
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    // Write to a temp file
    let filename = format!(
        "{}-{}.calp",
        request.package_id.replace('.', "-"),
        request.version
    );
    let temp_dir = std::env::temp_dir().join("calcula-packages");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;

    let dest_path = temp_dir.join(&filename);
    let mut file = std::fs::File::create(&dest_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write package file: {}", e))?;

    Ok(dest_path.to_string_lossy().to_string())
}

/// Request to publish (upload) a .calp package to an HTTP registry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPackageRequest {
    /// Path to the local .calp file to upload.
    pub file_path: String,
    /// Registry base URL (e.g. http://localhost:8080).
    pub registry_url: String,
    /// Optional auth token for authenticated registries.
    pub auth_token: Option<String>,
}

/// Publish response from the registry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResultJson {
    pub package_id: String,
    pub version: String,
    pub message: String,
}

/// Upload a `.calp` file to a registry's POST /publish endpoint.
#[tauri::command]
pub async fn publish_package(request: PublishPackageRequest) -> Result<PublishResultJson, String> {
    let file_path = std::path::Path::new(&request.file_path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", request.file_path));
    }

    // Read the file into memory
    let file_bytes = std::fs::read(file_path)
        .map_err(|e| format!("Failed to read package file: {}", e))?;

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("package.calp")
        .to_string();

    // Build multipart form
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("application/octet-stream")
        .map_err(|e| format!("Failed to build upload part: {}", e))?;

    let form = reqwest::multipart::Form::new().part("file", part);

    let registry_url = request.registry_url.trim_end_matches('/');
    let url = format!("{}/publish", registry_url);

    let client = reqwest::Client::new();
    let mut req = client.post(&url).multipart(form);

    if let Some(token) = &request.auth_token {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("Failed to upload package: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Registry returned HTTP {}: {}",
            status.as_u16(),
            if body.is_empty() {
                status.canonical_reason().unwrap_or("Unknown error").to_string()
            } else {
                body
            }
        ));
    }

    // Parse response — registry returns { id, version, message }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse registry response: {}", e))?;

    Ok(PublishResultJson {
        package_id: body["id"].as_str().unwrap_or("").to_string(),
        version: body["version"].as_str().unwrap_or("").to_string(),
        message: body["message"]
            .as_str()
            .unwrap_or("Package published successfully")
            .to_string(),
    })
}
