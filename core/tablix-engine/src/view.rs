//! FILENAME: core/tablix-engine/src/view.rs
//! Tablix View - Renderable output for the frontend.
//!
//! This module transforms the cache data into a 2D grid structure
//! that the frontend can render. It extends the pivot view concept
//! with support for detail rows and complex cell spanning.

use serde::{Deserialize, Serialize};
use pivot_engine::cache::ValueId;
use crate::definition::TablixId;

// ============================================================================
// CELL TYPES AND METADATA
// ============================================================================

/// The type of a cell in the tablix view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TablixCellType {
    /// Empty corner cell (top-left area).
    Corner,
    /// Row group header label.
    RowGroupHeader,
    /// Column group header label.
    ColumnGroupHeader,
    /// Aggregated data cell (like pivot).
    AggregatedData,
    /// Detail data cell (raw row value).
    DetailData,
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
    /// Filter field label (left side of filter row).
    FilterLabel,
    /// Filter dropdown button (right side of filter row).
    FilterDropdown,
}

/// Display value for a tablix cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TablixCellValue {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(String),
}

impl TablixCellValue {
    pub fn text(s: impl Into<String>) -> Self {
        TablixCellValue::Text(s.into())
    }
}

impl From<f64> for TablixCellValue {
    fn from(value: f64) -> Self {
        TablixCellValue::Number(value)
    }
}

/// Background style hints for rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TablixBackgroundStyle {
    Normal,
    Header,
    Subtotal,
    Total,
    GrandTotal,
    Alternate,
    FilterRow,
    DetailRow,
    DetailRowAlternate,
}

impl Default for TablixBackgroundStyle {
    fn default() -> Self {
        TablixBackgroundStyle::Normal
    }
}

// ============================================================================
// VIEW CELL
// ============================================================================

/// A single cell in the tablix view.
/// Contains both the value and rendering metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablixViewCell {
    /// The display value.
    pub value: TablixCellValue,

    /// The type of this cell.
    pub cell_type: TablixCellType,

    /// Indentation level (for stepped layout row group headers).
    pub indent_level: u8,

    /// Whether this cell's group is collapsed.
    pub is_collapsed: bool,

    /// Whether this cell can be expanded/collapsed.
    pub is_expandable: bool,

    /// Number format string for display.
    pub number_format: Option<String>,

    /// Row span (for group headers spanning across detail rows).
    pub row_span: u16,

    /// Column span (for column group headers spanning across data columns).
    pub col_span: u16,

    /// Whether this cell should be visually emphasized (e.g., totals).
    pub is_bold: bool,

    /// Background style hint.
    pub background_style: TablixBackgroundStyle,

    /// Link back to source data: (field_index, value_id) pairs.
    /// Used for drill-down and group identification.
    pub group_path: Vec<(usize, ValueId)>,

    /// Pre-formatted display string.
    pub formatted_value: String,

    /// For filter dropdown cells: the field index being filtered.
    pub filter_field_index: Option<usize>,

    /// Whether this cell is part of a spanned region (not the master cell).
    /// If true, this cell should not be rendered (the master cell covers it).
    pub is_spanned: bool,
}

impl TablixViewCell {
    /// Creates a new aggregated data cell.
    pub fn aggregated_data(value: f64) -> Self {
        TablixViewCell {
            value: TablixCellValue::Number(value),
            formatted_value: format!("{}", value),
            cell_type: TablixCellType::AggregatedData,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: TablixBackgroundStyle::Normal,
            group_path: Vec::new(),
            filter_field_index: None,
            is_spanned: false,
        }
    }

    /// Creates a new detail data cell.
    pub fn detail_data(value: TablixCellValue, formatted: String) -> Self {
        TablixViewCell {
            value,
            formatted_value: formatted,
            cell_type: TablixCellType::DetailData,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: TablixBackgroundStyle::DetailRow,
            group_path: Vec::new(),
            filter_field_index: None,
            is_spanned: false,
        }
    }

    /// Creates a row group header cell.
    pub fn row_group_header(label: String, indent: u8) -> Self {
        TablixViewCell {
            value: TablixCellValue::Text(label.clone()),
            formatted_value: label,
            cell_type: TablixCellType::RowGroupHeader,
            indent_level: indent,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: TablixBackgroundStyle::Header,
            group_path: Vec::new(),
            filter_field_index: None,
            is_spanned: false,
        }
    }

    /// Creates a column group header cell.
    pub fn column_group_header(label: String) -> Self {
        TablixViewCell {
            value: TablixCellValue::Text(label.clone()),
            formatted_value: label,
            cell_type: TablixCellType::ColumnGroupHeader,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: true,
            background_style: TablixBackgroundStyle::Header,
            group_path: Vec::new(),
            filter_field_index: None,
            is_spanned: false,
        }
    }

    /// Creates a corner cell.
    pub fn corner() -> Self {
        TablixViewCell {
            value: TablixCellValue::Empty,
            formatted_value: String::new(),
            cell_type: TablixCellType::Corner,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: TablixBackgroundStyle::Header,
            group_path: Vec::new(),
            filter_field_index: None,
            is_spanned: false,
        }
    }

    /// Creates a blank cell.
    pub fn blank() -> Self {
        TablixViewCell {
            value: TablixCellValue::Empty,
            formatted_value: String::new(),
            cell_type: TablixCellType::Blank,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: TablixBackgroundStyle::Normal,
            group_path: Vec::new(),
            filter_field_index: None,
            is_spanned: false,
        }
    }

    /// Creates a spanned (hidden) cell.
    pub fn spanned() -> Self {
        let mut cell = Self::blank();
        cell.is_spanned = true;
        cell
    }

    /// Creates a filter label cell.
    pub fn filter_label(field_name: String, field_index: usize) -> Self {
        TablixViewCell {
            value: TablixCellValue::Text(field_name.clone()),
            formatted_value: field_name,
            cell_type: TablixCellType::FilterLabel,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: TablixBackgroundStyle::Header,
            group_path: Vec::new(),
            filter_field_index: Some(field_index),
            is_spanned: false,
        }
    }

    /// Creates a filter dropdown cell.
    pub fn filter_dropdown(display_value: String, field_index: usize) -> Self {
        TablixViewCell {
            value: TablixCellValue::Text(display_value.clone()),
            formatted_value: display_value,
            cell_type: TablixCellType::FilterDropdown,
            indent_level: 0,
            is_collapsed: false,
            is_expandable: false,
            number_format: None,
            row_span: 1,
            col_span: 1,
            is_bold: false,
            background_style: TablixBackgroundStyle::Normal,
            group_path: Vec::new(),
            filter_field_index: Some(field_index),
            is_spanned: false,
        }
    }

    /// Sets expandable state.
    pub fn with_expandable(mut self, expandable: bool, collapsed: bool) -> Self {
        self.is_expandable = expandable;
        self.is_collapsed = collapsed;
        self
    }

    /// Sets row span.
    pub fn with_row_span(mut self, span: u16) -> Self {
        self.row_span = span;
        self
    }

    /// Sets column span.
    pub fn with_col_span(mut self, span: u16) -> Self {
        self.col_span = span;
        self
    }

    /// Sets cell as a total.
    pub fn as_total(mut self) -> Self {
        self.is_bold = true;
        self.background_style = TablixBackgroundStyle::Total;
        self
    }

    /// Sets the group path for identification.
    pub fn with_group_path(mut self, path: Vec<(usize, ValueId)>) -> Self {
        self.group_path = path;
        self
    }
}

// ============================================================================
// ROW AND COLUMN DESCRIPTORS
// ============================================================================

/// The type of row in the tablix view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TablixRowType {
    /// Column header row.
    ColumnHeader,
    /// Row group header (may span multiple detail rows).
    GroupHeader,
    /// Detail data row (one per source record).
    Detail,
    /// Subtotal row.
    Subtotal,
    /// Grand total row.
    GrandTotal,
    /// Filter row.
    FilterRow,
}

/// Describes a row in the tablix view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablixRowDescriptor {
    /// Index of this row in the view.
    pub view_row: usize,

    /// The type of row.
    pub row_type: TablixRowType,

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

    /// For detail rows: the source row index.
    pub source_row: Option<u32>,
}

/// The type of column in the tablix view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TablixColumnType {
    /// Row group label column(s) - left side.
    RowGroupLabel,
    /// Data column (aggregated or detail).
    Data,
    /// Subtotal column.
    Subtotal,
    /// Grand total column.
    GrandTotal,
}

/// Describes a column in the tablix view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablixColumnDescriptor {
    /// Index of this column in the view.
    pub view_col: usize,

    /// The type of column.
    pub col_type: TablixColumnType,

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

// ============================================================================
// FILTER ROW METADATA
// ============================================================================

/// Metadata for a filter field displayed in the tablix view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablixFilterRowInfo {
    /// The source field index being filtered.
    pub field_index: usize,

    /// The display name of the field.
    pub field_name: String,

    /// Currently selected/visible values.
    pub selected_values: Vec<String>,

    /// All unique values available for this field.
    pub unique_values: Vec<String>,

    /// Display string for the dropdown.
    pub display_value: String,

    /// The view row index where this filter is rendered.
    pub view_row: usize,
}

// ============================================================================
// MAIN VIEW STRUCT
// ============================================================================

/// The complete rendered view of a tablix.
/// This is what gets sent to the frontend for display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablixView {
    /// The tablix ID this view represents.
    pub tablix_id: TablixId,

    /// The flattened 2D grid of cells.
    /// Indexed as cells[row][col].
    pub cells: Vec<Vec<TablixViewCell>>,

    /// Metadata for each row.
    pub rows: Vec<TablixRowDescriptor>,

    /// Metadata for each column.
    pub columns: Vec<TablixColumnDescriptor>,

    /// Total number of rows in the view.
    pub row_count: usize,

    /// Total number of columns in the view.
    pub col_count: usize,

    /// Number of row group label columns (left frozen area).
    pub row_group_col_count: usize,

    /// Number of column header rows (top frozen area).
    pub column_header_row_count: usize,

    /// Number of filter rows at the top.
    pub filter_row_count: usize,

    /// Metadata for filter rows (for frontend interaction).
    pub filter_rows: Vec<TablixFilterRowInfo>,

    /// Version for cache coherency with frontend.
    pub version: u64,
}

impl TablixView {
    /// Creates a new empty view.
    pub fn new(tablix_id: TablixId) -> Self {
        TablixView {
            tablix_id,
            cells: Vec::new(),
            rows: Vec::new(),
            columns: Vec::new(),
            row_count: 0,
            col_count: 0,
            row_group_col_count: 0,
            column_header_row_count: 0,
            filter_row_count: 0,
            filter_rows: Vec::new(),
            version: 0,
        }
    }

    /// Gets a cell at the specified position.
    pub fn get_cell(&self, row: usize, col: usize) -> Option<&TablixViewCell> {
        self.cells.get(row).and_then(|r| r.get(col))
    }

    /// Gets a mutable cell at the specified position.
    pub fn get_cell_mut(&mut self, row: usize, col: usize) -> Option<&mut TablixViewCell> {
        self.cells.get_mut(row).and_then(|r| r.get_mut(col))
    }

    /// Adds a row to the view.
    pub fn add_row(&mut self, cells: Vec<TablixViewCell>, descriptor: TablixRowDescriptor) {
        self.cells.push(cells);
        self.rows.push(descriptor);
        self.row_count = self.cells.len();
        if self.col_count == 0 && !self.cells.is_empty() {
            self.col_count = self.cells[0].len();
        }
    }

    /// Sets the column descriptors.
    pub fn set_columns(&mut self, columns: Vec<TablixColumnDescriptor>) {
        self.col_count = columns.len();
        self.columns = columns;
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

    /// Toggles the collapsed state of a group row and updates child visibility.
    pub fn toggle_collapse(&mut self, row_index: usize) -> bool {
        if row_index >= self.rows.len() {
            return false;
        }

        // Find the expandable cell
        let mut found_expandable = false;
        let mut new_collapsed = false;
        let mut target_col = 0;

        for col in 0..self.row_group_col_count {
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

        let children = self.rows[row_index].children_indices.clone();

        if let Some(cell) = self.get_cell_mut(row_index, target_col) {
            cell.is_collapsed = new_collapsed;
        }

        let new_visible = !new_collapsed;
        self.update_children_visibility(&children, new_visible);

        true
    }

    /// Recursively updates visibility of child rows.
    fn update_children_visibility(&mut self, children: &[usize], visible: bool) {
        for &child_idx in children {
            if child_idx < self.rows.len() {
                self.rows[child_idx].visible = visible;

                let grandchildren = self.rows[child_idx].children_indices.clone();
                if visible {
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
                    self.update_children_visibility(&grandchildren, false);
                }
            }
        }
    }
}
