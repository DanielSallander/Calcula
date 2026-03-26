//! FILENAME: core/calcula-format/src/package/merger.rs
//! Merges a parsed `.calp` package into an existing Workbook.
//!
//! Handles:
//! - Appending sheets (with name conflict resolution)
//! - Merging tables (with ID reassignment)
//! - Merging user files
//! - Style deduplication and index remapping
//! - Data binding via formula reference rewriting

use super::manifest::{PackageContentType, PackageProvenance, ProvenanceEntry};
use crate::error::FormatError;
use persistence::{SavedCell, Sheet, Workbook};
use std::collections::HashMap;

/// How to handle name collisions during merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictStrategy {
    /// Rename the imported object (append " (2)", " (3)", etc.)
    Rename,
    /// Replace the existing object with the imported one.
    Replace,
    /// Skip the imported object entirely.
    Skip,
}

/// Options controlling the merge behavior.
#[derive(Debug, Clone)]
pub struct MergeOptions {
    /// How to handle sheet name collisions.
    pub sheet_conflict: ConflictStrategy,
    /// How to handle table name collisions.
    pub table_conflict: ConflictStrategy,
    /// Data source bindings: maps package data source IDs to local targets.
    pub bindings: Vec<DataBinding>,
    /// Base ID for generating new table IDs (should be max existing + 1).
    pub next_table_id: u64,
}

/// Maps a package data source to a local target.
#[derive(Debug, Clone)]
pub struct DataBinding {
    /// The data source ID from the package manifest.
    pub source_id: String,
    /// The internal reference used in the package (e.g. "SalesTable").
    pub internal_ref: String,
    /// What to replace it with locally.
    pub target: BindingTarget,
}

/// What a data source binds to locally.
#[derive(Debug, Clone)]
pub enum BindingTarget {
    /// Bind to a named table.
    Table { table_name: String },
    /// Bind to a cell range.
    Range {
        sheet_name: String,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    },
}

/// Result of a merge operation.
#[derive(Debug, Clone)]
pub struct MergeResult {
    /// Names of imported sheets (post-rename if applicable).
    pub imported_sheets: Vec<String>,
    /// Names of imported tables (post-rename if applicable).
    pub imported_tables: Vec<String>,
    /// Paths of imported user files.
    pub imported_files: Vec<String>,
    /// Provenance record for this import.
    pub provenance: PackageProvenance,
}

/// Merge a package workbook into a target workbook.
pub fn merge_package(
    target: &mut Workbook,
    source: &Workbook,
    package_id: &str,
    package_version: &str,
    options: &MergeOptions,
) -> Result<MergeResult, FormatError> {
    let mut result = MergeResult {
        imported_sheets: Vec::new(),
        imported_tables: Vec::new(),
        imported_files: Vec::new(),
        provenance: PackageProvenance {
            package_id: package_id.to_string(),
            package_version: package_version.to_string(),
            imported_at: now_iso8601(),
            entries: Vec::new(),
        },
    };

    // Build style remap table (dedup source styles against target styles)
    let style_remap = if let Some(target_sheet) = target.sheets.first() {
        if let Some(source_sheet) = source.sheets.first() {
            build_style_remap(&source_sheet.styles, &target_sheet.styles)
        } else {
            HashMap::new()
        }
    } else {
        HashMap::new()
    };

    // Collect existing sheet names for conflict detection
    let existing_sheet_names: Vec<String> = target.sheets.iter().map(|s| s.name.clone()).collect();

    // Merge sheets
    for source_sheet in &source.sheets {
        let original_name = source_sheet.name.clone();
        let final_name = resolve_name_conflict(&original_name, &existing_sheet_names, &options.sheet_conflict);

        if final_name.is_none() {
            // Skip strategy — don't import this sheet
            continue;
        }
        let final_name = final_name.unwrap();

        // Clone the sheet with remapped styles and rewritten formulas
        let mut new_sheet = clone_sheet_with_remap(source_sheet, &style_remap, &options.bindings);
        new_sheet.name = final_name.clone();

        // Use target's style registry
        if let Some(target_sheet) = target.sheets.first() {
            new_sheet.styles = target_sheet.styles.clone();
        }

        target.sheets.push(new_sheet);
        result.imported_sheets.push(final_name.clone());
        result.provenance.entries.push(ProvenanceEntry {
            content_type: PackageContentType::Sheet,
            package_name: original_name,
            local_name: final_name,
        });
    }

    // Collect existing table names for conflict detection
    let existing_table_names: Vec<String> = target.tables.iter().map(|t| t.name.clone()).collect();

    // Merge tables
    let mut next_id = options.next_table_id;
    for source_table in &source.tables {
        let original_name = source_table.name.clone();
        let final_name = resolve_name_conflict(&original_name, &existing_table_names, &options.table_conflict);

        if final_name.is_none() {
            continue;
        }
        let final_name = final_name.unwrap();

        let mut new_table = source_table.clone();
        new_table.id = next_id;
        next_id += 1;
        new_table.name = final_name.clone();

        // Adjust sheet_index: source sheet 0 maps to target's newly added sheets
        let sheet_offset = target.sheets.len() - source.sheets.len();
        new_table.sheet_index = source_table.sheet_index + sheet_offset;

        target.tables.push(new_table);
        result.imported_tables.push(final_name.clone());
        result.provenance.entries.push(ProvenanceEntry {
            content_type: PackageContentType::Table,
            package_name: original_name,
            local_name: final_name,
        });
    }

    // Merge user files (simple: overwrite on collision)
    for (path, content) in &source.user_files {
        target.user_files.insert(path.clone(), content.clone());
        result.imported_files.push(path.clone());
        result.provenance.entries.push(ProvenanceEntry {
            content_type: PackageContentType::File,
            package_name: path.clone(),
            local_name: path.clone(),
        });
    }

    Ok(result)
}

/// Build a mapping from source style indices to target style indices.
/// If a source style already exists in target (by value), reuse the existing index.
/// Otherwise, the source style would need to be appended (for now, map to 0 as fallback).
fn build_style_remap(
    source_styles: &[engine::style::CellStyle],
    target_styles: &[engine::style::CellStyle],
) -> HashMap<usize, usize> {
    let mut remap = HashMap::new();

    for (src_idx, src_style) in source_styles.iter().enumerate() {
        // Look for an exact match in target styles
        let found = target_styles
            .iter()
            .position(|t| styles_equal(src_style, t));

        match found {
            Some(target_idx) => {
                remap.insert(src_idx, target_idx);
            }
            None => {
                // Style not found in target — map to default (0) for now.
                // A full implementation would append the style to the target registry
                // and map to the new index.
                remap.insert(src_idx, 0);
            }
        }
    }

    remap
}

/// Compare two styles for value equality.
fn styles_equal(a: &engine::style::CellStyle, b: &engine::style::CellStyle) -> bool {
    a == b
}

/// Clone a sheet with remapped style indices and rewritten formula references.
fn clone_sheet_with_remap(
    source: &Sheet,
    style_remap: &HashMap<usize, usize>,
    bindings: &[DataBinding],
) -> Sheet {
    let mut new_cells = HashMap::new();

    for ((row, col), cell) in &source.cells {
        let new_style = style_remap
            .get(&cell.style_index)
            .copied()
            .unwrap_or(cell.style_index);

        let new_formula = cell.formula.as_ref().map(|f| rewrite_formula(f, bindings));

        new_cells.insert(
            (*row, *col),
            SavedCell {
                value: cell.value.clone(),
                formula: new_formula,
                style_index: new_style,
            },
        );
    }

    Sheet {
        name: source.name.clone(),
        cells: new_cells,
        column_widths: source.column_widths.clone(),
        row_heights: source.row_heights.clone(),
        styles: source.styles.clone(),
    }
}

/// Rewrite formula references based on data bindings.
/// Replaces table name references: e.g. "SalesTable[Revenue]" -> "MyLocalTable[Revenue]"
fn rewrite_formula(formula: &str, bindings: &[DataBinding]) -> String {
    let mut result = formula.to_string();

    for binding in bindings {
        let old_ref = &binding.internal_ref;
        let new_ref = match &binding.target {
            BindingTarget::Table { table_name } => table_name.clone(),
            BindingTarget::Range {
                sheet_name,
                start_row,
                start_col,
                end_row,
                end_col,
            } => {
                // Convert range binding to A1 notation
                let start = cell_to_a1(*start_row, *start_col);
                let end = cell_to_a1(*end_row, *end_col);
                format!("{}!{}:{}", sheet_name, start, end)
            }
        };

        // Replace table references: TableName[Column] -> NewName[Column]
        // Also replace bare table references: TableName -> NewName
        result = result.replace(old_ref, &new_ref);
    }

    result
}

/// Convert (row, col) to A1 notation.
fn cell_to_a1(row: u32, col: u32) -> String {
    let col_str = col_to_letters(col);
    format!("{}{}", col_str, row + 1)
}

/// Convert a 0-based column index to Excel-style letters (0=A, 25=Z, 26=AA, etc.)
fn col_to_letters(col: u32) -> String {
    let mut result = String::new();
    let mut c = col;
    loop {
        result.insert(0, (b'A' + (c % 26) as u8) as char);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    result
}

/// Resolve a name conflict using the given strategy.
/// Returns None if the strategy is Skip and a conflict exists.
/// Returns Some(name) — either the original or a renamed version.
fn resolve_name_conflict(
    name: &str,
    existing: &[String],
    strategy: &ConflictStrategy,
) -> Option<String> {
    let name_upper = name.to_uppercase();
    let has_conflict = existing.iter().any(|n| n.to_uppercase() == name_upper);

    if !has_conflict {
        return Some(name.to_string());
    }

    match strategy {
        ConflictStrategy::Rename => {
            // Find next available name: "Name (2)", "Name (3)", etc.
            for i in 2..1000 {
                let candidate = format!("{} ({})", name, i);
                let candidate_upper = candidate.to_uppercase();
                if !existing.iter().any(|n| n.to_uppercase() == candidate_upper) {
                    return Some(candidate);
                }
            }
            // Fallback (extremely unlikely)
            Some(format!("{} (copy)", name))
        }
        ConflictStrategy::Replace => Some(name.to_string()),
        ConflictStrategy::Skip => None,
    }
}

/// Get current time as ISO 8601 string.
fn now_iso8601() -> String {
    // Simple implementation without chrono dependency
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Rough UTC conversion (good enough for provenance timestamps)
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Calculate year/month/day from days since epoch (1970-01-01)
    let (year, month, day) = days_to_date(days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_date(days: u64) -> (u64, u64, u64) {
    // Simplified civil date calculation
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use persistence::{SavedCellValue, Sheet};

    fn make_target_workbook() -> Workbook {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Existing".to_string()),
                formula: None,
                style_index: 0,
            },
        );
        Workbook {
            sheets: vec![Sheet {
                name: "Sheet1".to_string(),
                cells,
                column_widths: HashMap::new(),
                row_heights: HashMap::new(),
                styles: vec![engine::style::CellStyle::new()],
            }],
            active_sheet: 0,
            tables: vec![],
            slicers: vec![],
            user_files: HashMap::new(),
        }
    }

    fn make_source_workbook() -> Workbook {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Dashboard".to_string()),
                formula: None,
                style_index: 0,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(100.0),
                formula: Some("=SalesTable[Revenue]".to_string()),
                style_index: 0,
            },
        );
        Workbook {
            sheets: vec![Sheet {
                name: "Dashboard".to_string(),
                cells,
                column_widths: HashMap::new(),
                row_heights: HashMap::new(),
                styles: vec![engine::style::CellStyle::new()],
            }],
            active_sheet: 0,
            tables: vec![],
            slicers: vec![],
            user_files: HashMap::new(),
        }
    }

    #[test]
    fn test_merge_no_conflicts() {
        let mut target = make_target_workbook();
        let source = make_source_workbook();

        let options = MergeOptions {
            sheet_conflict: ConflictStrategy::Rename,
            table_conflict: ConflictStrategy::Rename,
            bindings: vec![],
            next_table_id: 1,
        };

        let result = merge_package(&mut target, &source, "com.test", "1.0.0", &options).unwrap();

        assert_eq!(target.sheets.len(), 2);
        assert_eq!(target.sheets[0].name, "Sheet1");
        assert_eq!(target.sheets[1].name, "Dashboard");
        assert_eq!(result.imported_sheets, vec!["Dashboard"]);
        assert_eq!(result.provenance.package_id, "com.test");
    }

    #[test]
    fn test_merge_sheet_name_conflict_rename() {
        let mut target = make_target_workbook();
        // Create source with same name as target sheet
        let mut source = make_source_workbook();
        source.sheets[0].name = "Sheet1".to_string();

        let options = MergeOptions {
            sheet_conflict: ConflictStrategy::Rename,
            table_conflict: ConflictStrategy::Rename,
            bindings: vec![],
            next_table_id: 1,
        };

        let result = merge_package(&mut target, &source, "com.test", "1.0.0", &options).unwrap();

        assert_eq!(target.sheets.len(), 2);
        assert_eq!(target.sheets[0].name, "Sheet1");
        assert_eq!(target.sheets[1].name, "Sheet1 (2)");
        assert_eq!(result.imported_sheets, vec!["Sheet1 (2)"]);
    }

    #[test]
    fn test_merge_sheet_name_conflict_skip() {
        let mut target = make_target_workbook();
        let mut source = make_source_workbook();
        source.sheets[0].name = "Sheet1".to_string();

        let options = MergeOptions {
            sheet_conflict: ConflictStrategy::Skip,
            table_conflict: ConflictStrategy::Skip,
            bindings: vec![],
            next_table_id: 1,
        };

        let result = merge_package(&mut target, &source, "com.test", "1.0.0", &options).unwrap();

        assert_eq!(target.sheets.len(), 1); // Source sheet was skipped
        assert!(result.imported_sheets.is_empty());
    }

    #[test]
    fn test_merge_with_data_binding() {
        let mut target = make_target_workbook();
        let source = make_source_workbook();

        let options = MergeOptions {
            sheet_conflict: ConflictStrategy::Rename,
            table_conflict: ConflictStrategy::Rename,
            bindings: vec![DataBinding {
                source_id: "sales_data".to_string(),
                internal_ref: "SalesTable".to_string(),
                target: BindingTarget::Table {
                    table_name: "MyLocalSales".to_string(),
                },
            }],
            next_table_id: 1,
        };

        let result = merge_package(&mut target, &source, "com.test", "1.0.0", &options).unwrap();

        // Check that the formula was rewritten
        let dashboard = &target.sheets[1];
        let cell = &dashboard.cells[&(1, 0)];
        assert_eq!(
            cell.formula.as_deref(),
            Some("=MyLocalSales[Revenue]")
        );
    }

    #[test]
    fn test_merge_with_user_files() {
        let mut target = make_target_workbook();
        let mut source = make_source_workbook();
        source.user_files.insert(
            "docs/README.md".to_string(),
            b"# Dashboard Docs".to_vec(),
        );

        let options = MergeOptions {
            sheet_conflict: ConflictStrategy::Rename,
            table_conflict: ConflictStrategy::Rename,
            bindings: vec![],
            next_table_id: 1,
        };

        let result = merge_package(&mut target, &source, "com.test", "1.0.0", &options).unwrap();

        assert_eq!(result.imported_files, vec!["docs/README.md"]);
        assert!(target.user_files.contains_key("docs/README.md"));
    }

    #[test]
    fn test_col_to_letters() {
        assert_eq!(col_to_letters(0), "A");
        assert_eq!(col_to_letters(25), "Z");
        assert_eq!(col_to_letters(26), "AA");
        assert_eq!(col_to_letters(27), "AB");
        assert_eq!(col_to_letters(701), "ZZ");
    }

    #[test]
    fn test_rewrite_formula() {
        let bindings = vec![DataBinding {
            source_id: "src".to_string(),
            internal_ref: "OldTable".to_string(),
            target: BindingTarget::Table {
                table_name: "NewTable".to_string(),
            },
        }];

        assert_eq!(
            rewrite_formula("=OldTable[Revenue]", &bindings),
            "=NewTable[Revenue]"
        );
        assert_eq!(
            rewrite_formula("=SUM(OldTable[A],OldTable[B])", &bindings),
            "=SUM(NewTable[A],NewTable[B])"
        );
        // No match — unchanged
        assert_eq!(
            rewrite_formula("=SUM(A1:B10)", &bindings),
            "=SUM(A1:B10)"
        );
    }

    #[test]
    fn test_resolve_name_conflict() {
        let existing = vec!["Sheet1".to_string(), "Dashboard".to_string()];

        // No conflict
        assert_eq!(
            resolve_name_conflict("NewSheet", &existing, &ConflictStrategy::Rename),
            Some("NewSheet".to_string())
        );

        // Conflict with rename
        assert_eq!(
            resolve_name_conflict("Sheet1", &existing, &ConflictStrategy::Rename),
            Some("Sheet1 (2)".to_string())
        );

        // Conflict with skip
        assert_eq!(
            resolve_name_conflict("Sheet1", &existing, &ConflictStrategy::Skip),
            None
        );

        // Conflict with replace (keeps original name)
        assert_eq!(
            resolve_name_conflict("Sheet1", &existing, &ConflictStrategy::Replace),
            Some("Sheet1".to_string())
        );
    }
}
