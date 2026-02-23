//! FILENAME: app/src-tauri/src/tablix/operations.rs
//! Core operations for tablix - converts between engine types and API types.

use crate::tablix::types::*;
use pivot_engine::definition::{AggregationType, PivotField, PivotFilter, SortOrder};
use pivot_engine::cache::CacheValue;
use tablix_engine::{
    TablixDefinition, TablixLayout, GroupLayout,
    TablixDataField, DataFieldMode,
    TablixView, TablixViewCell, TablixCellValue, TablixCellType,
    TablixBackgroundStyle, TablixRowType, TablixColumnType,
};

/// Converts a TablixView into a TablixViewResponse for the frontend.
pub fn view_to_response(view: &TablixView) -> TablixViewResponse {
    let rows: Vec<TablixRowData> = view.rows.iter().enumerate().map(|(i, row_desc)| {
        let cells: Vec<TablixCellData> = if i < view.cells.len() {
            view.cells[i].iter().map(cell_to_data).collect()
        } else {
            Vec::new()
        };

        TablixRowData {
            view_row: row_desc.view_row,
            row_type: row_type_to_string(&row_desc.row_type),
            depth: row_desc.depth,
            visible: row_desc.visible,
            source_row: row_desc.source_row,
            cells,
        }
    }).collect();

    let columns: Vec<TablixColumnData> = view.columns.iter().map(|col| {
        TablixColumnData {
            view_col: col.view_col,
            col_type: col_type_to_string(&col.col_type),
            depth: col.depth,
            width_hint: col.width_hint,
        }
    }).collect();

    let filter_rows: Vec<TablixFilterRowData> = view.filter_rows.iter().map(|fr| {
        TablixFilterRowData {
            field_index: fr.field_index,
            field_name: fr.field_name.clone(),
            selected_values: fr.selected_values.clone(),
            unique_values: fr.unique_values.clone(),
            display_value: fr.display_value.clone(),
            view_row: fr.view_row,
        }
    }).collect();

    TablixViewResponse {
        tablix_id: view.tablix_id,
        version: view.version,
        row_count: view.row_count,
        col_count: view.col_count,
        row_group_col_count: view.row_group_col_count,
        column_header_row_count: view.column_header_row_count,
        filter_row_count: view.filter_row_count,
        filter_rows,
        rows,
        columns,
    }
}

fn cell_to_data(cell: &TablixViewCell) -> TablixCellData {
    TablixCellData {
        cell_type: cell_type_to_string(&cell.cell_type),
        value: cell_value_to_data(&cell.value),
        formatted_value: cell.formatted_value.clone(),
        indent_level: cell.indent_level,
        is_bold: cell.is_bold,
        is_expandable: cell.is_expandable,
        is_collapsed: cell.is_collapsed,
        is_spanned: cell.is_spanned,
        row_span: cell.row_span,
        col_span: cell.col_span,
        background_style: bg_style_to_string(&cell.background_style),
        number_format: cell.number_format.clone(),
        filter_field_index: cell.filter_field_index,
    }
}

fn cell_value_to_data(value: &TablixCellValue) -> TablixCellValueData {
    match value {
        TablixCellValue::Empty => TablixCellValueData::Empty,
        TablixCellValue::Number(n) => TablixCellValueData::Number(*n),
        TablixCellValue::Text(s) => TablixCellValueData::Text(s.clone()),
        TablixCellValue::Boolean(b) => TablixCellValueData::Boolean(*b),
        TablixCellValue::Error(e) => TablixCellValueData::Error(e.clone()),
    }
}

fn cell_type_to_string(ct: &TablixCellType) -> String {
    match ct {
        TablixCellType::Corner => "corner".into(),
        TablixCellType::RowGroupHeader => "rowGroupHeader".into(),
        TablixCellType::ColumnGroupHeader => "columnGroupHeader".into(),
        TablixCellType::AggregatedData => "aggregatedData".into(),
        TablixCellType::DetailData => "detailData".into(),
        TablixCellType::RowSubtotal => "rowSubtotal".into(),
        TablixCellType::ColumnSubtotal => "columnSubtotal".into(),
        TablixCellType::GrandTotalRow => "grandTotalRow".into(),
        TablixCellType::GrandTotalColumn => "grandTotalColumn".into(),
        TablixCellType::GrandTotal => "grandTotal".into(),
        TablixCellType::Blank => "blank".into(),
        TablixCellType::FilterLabel => "filterLabel".into(),
        TablixCellType::FilterDropdown => "filterDropdown".into(),
    }
}

fn bg_style_to_string(style: &TablixBackgroundStyle) -> String {
    match style {
        TablixBackgroundStyle::Normal => "normal".into(),
        TablixBackgroundStyle::Header => "header".into(),
        TablixBackgroundStyle::Subtotal => "subtotal".into(),
        TablixBackgroundStyle::Total => "total".into(),
        TablixBackgroundStyle::GrandTotal => "grandTotal".into(),
        TablixBackgroundStyle::Alternate => "alternate".into(),
        TablixBackgroundStyle::FilterRow => "filterRow".into(),
        TablixBackgroundStyle::DetailRow => "detailRow".into(),
        TablixBackgroundStyle::DetailRowAlternate => "detailRowAlternate".into(),
    }
}

fn row_type_to_string(rt: &TablixRowType) -> String {
    match rt {
        TablixRowType::ColumnHeader => "columnHeader".into(),
        TablixRowType::GroupHeader => "groupHeader".into(),
        TablixRowType::Detail => "detail".into(),
        TablixRowType::Subtotal => "subtotal".into(),
        TablixRowType::GrandTotal => "grandTotal".into(),
        TablixRowType::FilterRow => "filterRow".into(),
    }
}

fn col_type_to_string(ct: &TablixColumnType) -> String {
    match ct {
        TablixColumnType::RowGroupLabel => "rowGroupLabel".into(),
        TablixColumnType::Data => "data".into(),
        TablixColumnType::Subtotal => "subtotal".into(),
        TablixColumnType::GrandTotal => "grandTotal".into(),
    }
}

/// Parse field configs from the API into engine PivotField types.
pub fn parse_field_config(config: &TablixFieldConfig) -> PivotField {
    let sort_order = match config.sort_order.as_deref() {
        Some("desc") => SortOrder::Descending,
        Some("manual") => SortOrder::Manual,
        Some("source") => SortOrder::DataSourceOrder,
        _ => SortOrder::Ascending,
    };

    PivotField {
        source_index: config.source_index,
        name: config.name.clone(),
        sort_order,
        show_subtotals: config.show_subtotals.unwrap_or(true),
        collapsed: config.collapsed.unwrap_or(false),
        hidden_items: config.hidden_items.clone().unwrap_or_default(),
    }
}

/// Parse data field config from the API into engine TablixDataField.
pub fn parse_data_field_config(config: &TablixDataFieldConfig) -> TablixDataField {
    let mode = match config.mode.as_str() {
        "detail" => DataFieldMode::Detail,
        _ => {
            let agg = parse_aggregation(config.aggregation.as_deref());
            DataFieldMode::Aggregated(agg)
        }
    };

    TablixDataField {
        source_index: config.source_index,
        name: config.name.clone(),
        mode,
        number_format: config.number_format.clone(),
    }
}

/// Parse aggregation string into the engine enum.
pub fn parse_aggregation(agg: Option<&str>) -> AggregationType {
    match agg {
        Some("count") => AggregationType::Count,
        Some("average") => AggregationType::Average,
        Some("min") => AggregationType::Min,
        Some("max") => AggregationType::Max,
        Some("countnumbers") => AggregationType::CountNumbers,
        Some("stddev") => AggregationType::StdDev,
        Some("stddevp") => AggregationType::StdDevP,
        Some("var") => AggregationType::Var,
        Some("varp") => AggregationType::VarP,
        Some("product") => AggregationType::Product,
        _ => AggregationType::Sum,
    }
}

/// Parse layout config from API into engine TablixLayout.
pub fn parse_layout_config(config: &TablixLayoutConfig, existing: &TablixLayout) -> TablixLayout {
    TablixLayout {
        show_row_grand_totals: config.show_row_grand_totals.unwrap_or(existing.show_row_grand_totals),
        show_column_grand_totals: config.show_column_grand_totals.unwrap_or(existing.show_column_grand_totals),
        group_layout: match config.group_layout.as_deref() {
            Some("stepped") => GroupLayout::Stepped,
            Some("block") => GroupLayout::Block,
            _ => existing.group_layout,
        },
        repeat_group_labels: config.repeat_group_labels.unwrap_or(existing.repeat_group_labels),
        show_empty_groups: config.show_empty_groups.unwrap_or(existing.show_empty_groups),
    }
}

/// Check if a source value looks numeric.
pub fn is_numeric_value(cache_value: &CacheValue) -> bool {
    matches!(cache_value, CacheValue::Number(_))
}
