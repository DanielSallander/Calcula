//! FILENAME: core/engine/src/pivot/view.rs
//! Pivot View - Renderable output for the frontend.
//!
//! This module transforms the cache data into a 2D grid structure
//! that the frontend can render. It includes metadata for:
//! - Tree hierarchy (expand/collapse)
//! - Row/column headers with nesting levels
//! - Cell types (data, subtotal, grand total)
//! - Visual formatting hints

use serde::{Deserialize, Serialize};
use crate::pivot::definition::PivotId;
use crate::pivot::cache::{CacheValue, ValueId};

// ============================================================================
// CELL TYPES AND METADATA
// ============================================================================

/// The type of a cell in the pivot view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PivotCellType {
    /// Empty corner cell (top-left area).
    Corner,
    /// Row header label.
    RowHeader,
    /// Column header label.
    ColumnHeader,
    /// Data cell (aggregated value).
    Data,
    /// Row subtotal.
    RowSubtotal,
    /// Column subtotal.
    ColumnSubtotal,
    /// Grand total row.
    GrandTotalRow,
    /// Grand total column.
    GrandTotalColumn,
    /// Grand total (intersection of row and column grand totals).
    GrandTotal,
    /// Blank cell (for layout purposes).
    Blank,
}

/// Display value for a pivot cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PivotCellValue {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(String),
}

impl From<&CacheValue> for PivotCellValue {
    fn from(value: &CacheValue) -> Self {
        match value {
            CacheValue::Empty => PivotCellValue::Empty,
            CacheValue::Number(n) => PivotCellValue::Number(n.0),
            CacheValue::Text(s) => PivotCellValue::Text(s.clone()),
            CacheValue::Boolean(b) => PivotCellValue::Boolean(*b),
            CacheValue::Error(e) => PivotCellValue::Error(e.clone()),
        }
    }
}

impl From<f64> for PivotCellValue {
    fn from(value: f64) -> Self {
        PivotCellValue::Number(value)
    }
}

impl PivotCellValue {
    pub fn text(s: impl Into<String>) -> Self {
        PivotCellValue::Text(s.into())
    }
}

// ============================================================================
// VIEW CELL
// ============================================================================

/// A single cell in the pivot table view.
/// Contains both the value and rendering metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotViewCell {
    /// The display value.
    pub value: PivotCellValue,
    
    /// The type of this cell.
    pub cell_type: PivotCellType,
    
    /// Indentation level (for compact layout row headers).
    pub indent_level: u8,
    
    /// Whether this cell's group is collapsed.
    pub is_collapsed: bool,
    
    /// Whether this cell can be expanded/collapsed.
    pub is_expandable: bool,
    
    /// Number format string for display.
    pub number_format: Option<String>,
    
    /// Row span (for merged cells in tabular layout).
    pub row_span: u16,
    
    /// Column span (for merged cells).
    pub col_span: u16,
    
    /// Whether this cell should be visually emphasized (e.g., totals).
    pub is_bold: bool,
    
    /// Background style hint.
    pub background_style: BackgroundStyle,
    
    /// Link back to source data: (field_index, value_id) pairs.
    /// Used for drill-down functionality.
    pub group_path: Vec<(usize, ValueId)>,
    
    /// Pre-formatted display string.
    pub formatted_value: String,
    
}

impl PivotViewCell {
    /// Creates a new data cell.
    pub fn data(value: f64) -> Self {
        PivotViewCell {
            value: PivotCellValue::Number(value),
            formatted_value: format!("{}", value),
            cell_type: PivotCellType::Data,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: BackgroundStyle::Normal,
            group_path: Vec::new(),
        }
    }
    
    /// Creates a row header cell.
    pub fn row_header(label: String, indent: u8) -> Self {
        PivotViewCell {
            value: PivotCellValue::Text(label.clone()),
            formatted_value: label,
            cell_type: PivotCellType::RowHeader,
            indent_level: indent,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: BackgroundStyle::Header,
            group_path: Vec::new(),
        }
    }
    
    /// Creates a column header cell.
    pub fn column_header(label: String) -> Self {
        PivotViewCell {
            value: PivotCellValue::Text(label.clone()),
            formatted_value: label,
            cell_type: PivotCellType::ColumnHeader,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: true,
            background_style: BackgroundStyle::Header,
            group_path: Vec::new(),
        }
    }
    
    /// Creates a corner cell.
    pub fn corner() -> Self {
        PivotViewCell {
            value: PivotCellValue::Empty,
            formatted_value: String::new(),
            cell_type: PivotCellType::Corner,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: BackgroundStyle::Header,
            group_path: Vec::new(),
        }
    }
    
    /// Creates a blank cell.
    pub fn blank() -> Self {
        PivotViewCell {
            value: PivotCellValue::Empty,
            formatted_value: String::new(),
            cell_type: PivotCellType::Blank,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: BackgroundStyle::Normal,
            group_path: Vec::new(),
        }
    }
    
    /// Sets expandable state.
    pub fn with_expandable(mut self, expandable: bool, collapsed: bool) -> Self {
        self.is_expandable = expandable;
        self.is_collapsed = collapsed;
        self
    }
    
    /// Sets cell as a total.
    pub fn as_total(mut self) -> Self {
        self.is_bold = true;
        self.background_style = BackgroundStyle::Total;
        self
    }
    
    /// Sets the group path for drill-down.
    pub fn with_group_path(mut self, path: Vec<(usize, ValueId)>) -> Self {
        self.group_path = path;
        self
    }
}

/// Background style hints for rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackgroundStyle {
    Normal,
    Header,
    Subtotal,
    Total,
    GrandTotal,
    Alternate, // For zebra striping
}

impl Default for BackgroundStyle {
    fn default() -> Self {
        BackgroundStyle::Normal
    }
}

// ============================================================================
// ROW AND COLUMN DESCRIPTORS
// ============================================================================

/// Describes a row in the pivot view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotRowDescriptor {
    /// Index of this row in the view.
    pub view_row: usize,
    
    /// The type of row.
    pub row_type: PivotRowType,
    
    /// Nesting depth (0 = outermost).
    pub depth: u8,
    
    /// Whether this row is visible (not hidden by collapse).
    pub visible: bool,
    
    /// Index of the parent row (if any).
    pub parent_index: Option<usize>,
    
    /// Indices of child rows.
    pub children_indices: Vec<usize>,
    
    /// The group key values that define this row.
    pub group_values: Vec<ValueId>,
}

/// Types of rows in the pivot view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PivotRowType {
    /// Regular data row.
    Data,
    /// Subtotal row.
    Subtotal,
    /// Grand total row.
    GrandTotal,
    /// Column header row.
    ColumnHeader,
}

/// Describes a column in the pivot view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotColumnDescriptor {
    /// Index of this column in the view.
    pub view_col: usize,
    
    /// The type of column.
    pub col_type: PivotColumnType,
    
    /// Nesting depth (0 = outermost).
    pub depth: u8,
    
    /// Width hint in characters (for auto-sizing).
    pub width_hint: u16,
    
    /// Index of the parent column (if any).
    pub parent_index: Option<usize>,
    
    /// Indices of child columns.
    pub children_indices: Vec<usize>,
    
    /// The group key values that define this column.
    pub group_values: Vec<ValueId>,
}

/// Types of columns in the pivot view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PivotColumnType {
    /// Row label column(s) - left side.
    RowLabel,
    /// Data column.
    Data,
    /// Subtotal column.
    Subtotal,
    /// Grand total column.
    GrandTotal,
}

// ============================================================================
// MAIN VIEW STRUCT
// ============================================================================

/// The complete rendered view of a pivot table.
/// This is what gets sent to the frontend for display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotView {
    /// The pivot table ID this view represents.
    pub pivot_id: PivotId,
    
    /// The flattened 2D grid of cells.
    /// Indexed as cells[row][col].
    pub cells: Vec<Vec<PivotViewCell>>,
    
    /// Metadata for each row.
    pub rows: Vec<PivotRowDescriptor>,
    
    /// Metadata for each column.
    pub columns: Vec<PivotColumnDescriptor>,
    
    /// Total number of rows in the view.
    pub row_count: usize,
    
    /// Total number of columns in the view.
    pub col_count: usize,
    
    /// Number of row label columns (left frozen area).
    pub row_label_col_count: usize,
    
    /// Number of column header rows (top frozen area).
    pub column_header_row_count: usize,
    
    /// Indicates if the view is a partial/windowed view.
    pub is_windowed: bool,
    
    /// For windowed views: the full row count.
    pub total_row_count: Option<usize>,
    
    /// For windowed views: the starting row index.
    pub window_start_row: Option<usize>,
    
    /// Version for cache coherency with frontend.
    pub version: u64,
}

impl PivotView {
    /// Creates a new empty view.
    pub fn new(pivot_id: PivotId) -> Self {
        PivotView {
            pivot_id,
            cells: Vec::new(),
            rows: Vec::new(),
            columns: Vec::new(),
            row_count: 0,
            col_count: 0,
            row_label_col_count: 0,
            column_header_row_count: 0,
            is_windowed: false,
            total_row_count: None,
            window_start_row: None,
            version: 0,
        }
    }
    
    /// Gets a cell at the specified position.
    pub fn get_cell(&self, row: usize, col: usize) -> Option<&PivotViewCell> {
        self.cells.get(row).and_then(|r| r.get(col))
    }
    
    /// Gets a mutable cell at the specified position.
    pub fn get_cell_mut(&mut self, row: usize, col: usize) -> Option<&mut PivotViewCell> {
        self.cells.get_mut(row).and_then(|r| r.get_mut(col))
    }
    
    /// Adds a row to the view.
    pub fn add_row(&mut self, cells: Vec<PivotViewCell>, descriptor: PivotRowDescriptor) {
        self.cells.push(cells);
        self.rows.push(descriptor);
        self.row_count = self.cells.len();
        if self.col_count == 0 && !self.cells.is_empty() {
            self.col_count = self.cells[0].len();
        }
    }
    
    /// Sets the column descriptors.
    pub fn set_columns(&mut self, columns: Vec<PivotColumnDescriptor>) {
        self.col_count = columns.len();
        self.columns = columns;
    }
    
    /// Toggles the collapsed state of a row.
    pub fn toggle_collapse(&mut self, row_index: usize) -> bool {
        if row_index >= self.rows.len() {
            return false;
        }
        
        // First, find the expandable cell and get needed data without mutable borrow
        let mut found_expandable = false;
        let mut new_collapsed = false;
        let mut target_col = 0;
        
        for col in 0..self.row_label_col_count {
            if let Some(cell) = self.get_cell(row_index, col) {
                if cell.is_expandable {
                    found_expandable = true;
                    new_collapsed = !cell.is_collapsed;
                    target_col = col;
                    break;
                }
            }
        }
        
        if !found_expandable {
            return false;
        }
        
        // Get children indices before mutable borrow
        let children = self.rows[row_index].children_indices.clone();
        
        // Now do the mutable updates
        if let Some(cell) = self.get_cell_mut(row_index, target_col) {
            cell.is_collapsed = new_collapsed;
        }
        
        // Update visibility of child rows
        let new_visible = !new_collapsed;
        self.update_children_visibility(&children, new_visible);
        
        true
    }
    
    /// Recursively updates visibility of child rows.
    fn update_children_visibility(&mut self, children: &[usize], visible: bool) {
        for &child_idx in children {
            if child_idx < self.rows.len() {
                self.rows[child_idx].visible = visible;
                
                // If making visible, respect the child's own collapsed state
                let grandchildren = self.rows[child_idx].children_indices.clone();
                if visible {
                    // Check if this child is collapsed
                    let child_collapsed = self.cells
                        .get(child_idx)
                        .and_then(|row| {
                            row.iter()
                                .find(|c| c.is_expandable)
                                .map(|c| c.is_collapsed)
                        })
                        .unwrap_or(false);
                    
                    if !child_collapsed {
                        self.update_children_visibility(&grandchildren, true);
                    }
                } else {
                    // If hiding, hide all descendants
                    self.update_children_visibility(&grandchildren, false);
                }
            }
        }
    }
    
    /// Returns visible row indices (for rendering).
    pub fn visible_rows(&self) -> Vec<usize> {
        self.rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.visible)
            .map(|(i, _)| i)
            .collect()
    }
    
    /// Creates a windowed subset of the view for large datasets.
    pub fn window(&self, start_row: usize, row_count: usize) -> PivotView {
        let visible: Vec<usize> = self.visible_rows();
        let end_row = (start_row + row_count).min(visible.len());
        
        let windowed_indices: Vec<usize> = visible[start_row..end_row].to_vec();
        
        let mut windowed = PivotView::new(self.pivot_id);
        windowed.is_windowed = true;
        windowed.total_row_count = Some(visible.len());
        windowed.window_start_row = Some(start_row);
        windowed.columns = self.columns.clone();
        windowed.col_count = self.col_count;
        windowed.row_label_col_count = self.row_label_col_count;
        windowed.column_header_row_count = self.column_header_row_count;
        windowed.version = self.version;
        
        for &idx in &windowed_indices {
            if idx < self.cells.len() {
                windowed.cells.push(self.cells[idx].clone());
                let mut row_desc = self.rows[idx].clone();
                row_desc.view_row = windowed.cells.len() - 1;
                windowed.rows.push(row_desc);
            }
        }
        
        windowed.row_count = windowed.cells.len();
        windowed
    }
}

// ============================================================================
// DRILL-DOWN RESULT
// ============================================================================

/// Result of a drill-down operation (showing detail records).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrillDownResult {
    /// The pivot ID this drill-down came from.
    pub pivot_id: PivotId,
    
    /// The group path that was drilled into.
    pub group_path: Vec<(usize, ValueId)>,
    
    /// Column headers from the source data.
    pub headers: Vec<String>,
    
    /// The detail records (source row indices).
    pub source_rows: Vec<u32>,
    
    /// Total count of matching records.
    pub total_count: usize,
    
    /// Whether this is a partial result (for large datasets).
    pub is_truncated: bool,
    
    /// Maximum records that were fetched.
    pub max_records: usize,
}

impl DrillDownResult {
    pub fn new(pivot_id: PivotId, group_path: Vec<(usize, ValueId)>) -> Self {
        DrillDownResult {
            pivot_id,
            group_path,
            headers: Vec::new(),
            source_rows: Vec::new(),
            total_count: 0,
            is_truncated: false,
            max_records: 1000, // Default limit
        }
    }
}