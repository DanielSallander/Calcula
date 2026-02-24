//! FILENAME: core/tablix-engine/src/definition.rs
//! Tablix Definition - The serializable configuration.
//!
//! This module contains all the types needed to DESCRIBE a tablix.
//! These structures are designed to be:
//! - Serializable (for saving/loading workbooks)
//! - Sent over the Tauri bridge
//! - Immutable snapshots of user intent
//!
//! Reuses PivotField, PivotFilter, AggregationType, and FieldIndex from pivot-engine.

use serde::{Deserialize, Serialize};
use engine::CellCoord;
use pivot_engine::{AggregationType, FieldIndex, PivotField, PivotFilter};
use pivot_engine::definition::SubtotalLocation;

/// Unique identifier for a tablix within a workbook.
pub type TablixId = u32;

// ============================================================================
// DATA FIELD MODE
// ============================================================================

/// How a data field is rendered: aggregated (like pivot) or detail (raw rows).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DataFieldMode {
    /// Aggregated value using the specified function (SUM, COUNT, etc.).
    Aggregated(AggregationType),
    /// Raw detail rows - each source record is displayed individually.
    Detail,
}

impl Default for DataFieldMode {
    fn default() -> Self {
        DataFieldMode::Aggregated(AggregationType::Sum)
    }
}

// ============================================================================
// DATA FIELD
// ============================================================================

/// A field in the Tablix Values/Details zone.
/// Unlike Pivot's ValueField, this can operate in either aggregated or detail mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablixDataField {
    /// Index of the source column (0-based from source range).
    pub source_index: FieldIndex,

    /// Display name (e.g., "Sum of Sales" or "Sales").
    pub name: String,

    /// Whether this field shows aggregated data or raw detail rows.
    pub mode: DataFieldMode,

    /// Number format string (e.g., "#,##0.00", "0%").
    pub number_format: Option<String>,
}

impl TablixDataField {
    pub fn new_aggregated(
        source_index: FieldIndex,
        name: String,
        aggregation: AggregationType,
    ) -> Self {
        TablixDataField {
            source_index,
            name,
            mode: DataFieldMode::Aggregated(aggregation),
            number_format: None,
        }
    }

    pub fn new_detail(source_index: FieldIndex, name: String) -> Self {
        TablixDataField {
            source_index,
            name,
            mode: DataFieldMode::Detail,
            number_format: None,
        }
    }

    /// Returns true if this field operates in detail mode.
    pub fn is_detail(&self) -> bool {
        matches!(self.mode, DataFieldMode::Detail)
    }

    /// Returns the aggregation type, or None if in detail mode.
    pub fn aggregation(&self) -> Option<AggregationType> {
        match &self.mode {
            DataFieldMode::Aggregated(agg) => Some(*agg),
            DataFieldMode::Detail => None,
        }
    }
}

// ============================================================================
// LAYOUT OPTIONS
// ============================================================================

/// How group headers are arranged on the grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GroupLayout {
    /// Stepped: groups nested in the same column with indentation.
    Stepped,
    /// Block: each group level gets its own column.
    Block,
}

impl Default for GroupLayout {
    fn default() -> Self {
        GroupLayout::Block
    }
}

/// Controls how the tablix is displayed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablixLayout {
    /// Show row grand totals.
    pub show_row_grand_totals: bool,

    /// Show column grand totals.
    pub show_column_grand_totals: bool,

    /// How row groups are arranged: stepped (same column) or block (separate columns).
    pub group_layout: GroupLayout,

    /// Repeat row group labels for each detail row.
    pub repeat_group_labels: bool,

    /// Show groups even when they contain no data.
    pub show_empty_groups: bool,

    /// Where subtotals are placed relative to their group items.
    #[serde(default)]
    pub subtotal_location: SubtotalLocation,
}

impl Default for TablixLayout {
    fn default() -> Self {
        TablixLayout {
            show_row_grand_totals: true,
            show_column_grand_totals: false,
            group_layout: GroupLayout::Block,
            repeat_group_labels: false,
            show_empty_groups: false,
            subtotal_location: SubtotalLocation::AtBottom,
        }
    }
}

// ============================================================================
// MAIN DEFINITION STRUCT
// ============================================================================

/// The complete, serializable definition of a tablix.
/// This is the "source of truth" that gets saved with the workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablixDefinition {
    /// Unique identifier for this tablix.
    pub id: TablixId,

    /// User-friendly name for this tablix.
    #[serde(default)]
    pub name: Option<String>,

    /// The source data range (top-left corner).
    pub source_start: CellCoord,

    /// The source data range (bottom-right corner).
    pub source_end: CellCoord,

    /// Whether the first row of source data contains headers.
    pub source_has_headers: bool,

    /// Fields placed in the Row Groups area (ordered from outer to inner).
    pub row_groups: Vec<PivotField>,

    /// Fields placed in the Column Groups area (ordered from outer to inner).
    pub column_groups: Vec<PivotField>,

    /// Fields placed in the Values/Details area.
    pub data_fields: Vec<TablixDataField>,

    /// Fields placed in the Filter area (page filters).
    pub filter_fields: Vec<PivotFilter>,

    /// Layout and display options.
    pub layout: TablixLayout,

    /// Where the tablix output starts in the destination sheet.
    pub destination: CellCoord,

    /// Destination sheet name (if different from source).
    pub destination_sheet: Option<String>,

    /// Version for cache invalidation.
    pub version: u64,
}

impl TablixDefinition {
    /// Creates a new tablix definition with minimal configuration.
    pub fn new(id: TablixId, source_start: CellCoord, source_end: CellCoord) -> Self {
        TablixDefinition {
            id,
            name: None,
            source_start,
            source_end,
            source_has_headers: true,
            row_groups: Vec::new(),
            column_groups: Vec::new(),
            data_fields: Vec::new(),
            filter_fields: Vec::new(),
            layout: TablixLayout::default(),
            destination: (0, 0),
            destination_sheet: None,
            version: 0,
        }
    }

    /// Increments the version (for cache invalidation).
    pub fn bump_version(&mut self) {
        self.version += 1;
    }

    /// Returns true if any data field is in detail mode.
    pub fn has_detail_fields(&self) -> bool {
        self.data_fields.iter().any(|f| f.is_detail())
    }

    /// Returns true if all data fields are aggregated (no detail fields).
    pub fn is_fully_aggregated(&self) -> bool {
        !self.has_detail_fields()
    }

    /// Returns the number of source rows (excluding header if applicable).
    pub fn source_row_count(&self) -> u32 {
        let total = self.source_end.0 - self.source_start.0 + 1;
        if self.source_has_headers && total > 0 {
            total - 1
        } else {
            total
        }
    }

    /// Returns the number of source columns.
    pub fn source_col_count(&self) -> u32 {
        self.source_end.1 - self.source_start.1 + 1
    }
}
