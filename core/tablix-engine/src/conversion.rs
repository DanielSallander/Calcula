//! FILENAME: core/tablix-engine/src/conversion.rs
//! Pivot <-> Tablix conversion logic.
//!
//! Handles the bidirectional state mapping when users switch between
//! Pivot Table and Tablix component types.

use serde::{Deserialize, Serialize};
use pivot_engine::definition::{
    AggregationType, PivotDefinition, PivotField, ValueField,
};
use crate::definition::{DataFieldMode, TablixDataField, TablixDefinition, TablixLayout, GroupLayout};

/// Information about a detail field that was migrated during Tablix -> Pivot conversion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigratedDetailField {
    /// The field name that was migrated.
    pub name: String,
    /// The source index of the field.
    pub source_index: usize,
}

/// Converts a PivotDefinition into a TablixDefinition.
///
/// Field mapping (non-destructive):
/// - Pivot Rows -> Tablix Row Groups
/// - Pivot Columns -> Tablix Column Groups
/// - Pivot Values -> Tablix Data Fields (Aggregated, preserving aggregation type)
/// - Pivot Filters -> Tablix Filters
pub fn pivot_to_tablix(pivot: &PivotDefinition) -> TablixDefinition {
    let data_fields: Vec<TablixDataField> = pivot
        .value_fields
        .iter()
        .map(|vf| TablixDataField {
            source_index: vf.source_index,
            name: vf.name.clone(),
            mode: DataFieldMode::Aggregated(vf.aggregation),
            number_format: vf.number_format.clone(),
        })
        .collect();

    // Map layout settings
    let layout = TablixLayout {
        show_row_grand_totals: pivot.layout.show_row_grand_totals,
        show_column_grand_totals: pivot.layout.show_column_grand_totals,
        group_layout: match pivot.layout.report_layout {
            pivot_engine::definition::ReportLayout::Compact => GroupLayout::Stepped,
            pivot_engine::definition::ReportLayout::Outline
            | pivot_engine::definition::ReportLayout::Tabular => GroupLayout::Block,
        },
        repeat_group_labels: pivot.layout.repeat_row_labels,
        show_empty_groups: pivot.layout.show_empty_rows,
    };

    TablixDefinition {
        id: pivot.id,
        name: pivot.name.clone(),
        source_start: pivot.source_start,
        source_end: pivot.source_end,
        source_has_headers: pivot.source_has_headers,
        row_groups: pivot.row_fields.clone(),
        column_groups: pivot.column_fields.clone(),
        data_fields,
        filter_fields: pivot.filter_fields.clone(),
        layout,
        destination: pivot.destination,
        destination_sheet: pivot.destination_sheet.clone(),
        version: pivot.version + 1,
    }
}

/// Converts a TablixDefinition into a PivotDefinition.
///
/// Field mapping:
/// - Tablix Row Groups -> Pivot Rows
/// - Tablix Column Groups -> Pivot Columns
/// - Tablix Filters -> Pivot Filters
/// - Tablix Data Fields (Aggregated) -> Pivot Values
/// - Tablix Data Fields (Detail) -> Migrated to Pivot Rows (appended at bottom)
///
/// Returns the PivotDefinition and a list of migrated detail fields.
pub fn tablix_to_pivot(tablix: &TablixDefinition) -> (PivotDefinition, Vec<MigratedDetailField>) {
    let mut row_fields = tablix.row_groups.clone();
    let mut value_fields = Vec::new();
    let mut migrated = Vec::new();

    for df in &tablix.data_fields {
        match &df.mode {
            DataFieldMode::Aggregated(agg) => {
                value_fields.push(ValueField::new(
                    df.source_index,
                    df.name.clone(),
                    *agg,
                ));
            }
            DataFieldMode::Detail => {
                // Detail fields cannot exist in Pivot Values zone.
                // Migrate them to the bottom of the Rows zone as the innermost group,
                // so users can expand to see raw items.
                row_fields.push(PivotField::new(df.source_index, df.name.clone()));
                migrated.push(MigratedDetailField {
                    name: df.name.clone(),
                    source_index: df.source_index,
                });
            }
        }
    }

    // Map layout
    let report_layout = match tablix.layout.group_layout {
        GroupLayout::Stepped => pivot_engine::definition::ReportLayout::Compact,
        GroupLayout::Block => pivot_engine::definition::ReportLayout::Tabular,
    };

    let mut pivot = PivotDefinition::new(
        tablix.id,
        tablix.source_start,
        tablix.source_end,
    );
    pivot.name = tablix.name.clone();
    pivot.source_has_headers = tablix.source_has_headers;
    pivot.row_fields = row_fields;
    pivot.column_fields = tablix.column_groups.clone();
    pivot.value_fields = value_fields;
    pivot.filter_fields = tablix.filter_fields.clone();
    pivot.layout.show_row_grand_totals = tablix.layout.show_row_grand_totals;
    pivot.layout.show_column_grand_totals = tablix.layout.show_column_grand_totals;
    pivot.layout.report_layout = report_layout;
    pivot.layout.repeat_row_labels = tablix.layout.repeat_group_labels;
    pivot.layout.show_empty_rows = tablix.layout.show_empty_groups;
    pivot.destination = tablix.destination;
    pivot.destination_sheet = tablix.destination_sheet.clone();
    pivot.version = tablix.version + 1;

    (pivot, migrated)
}
