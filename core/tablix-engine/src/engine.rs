//! FILENAME: core/tablix-engine/src/engine.rs
//! Tablix Engine - The calculation core that transforms data into a renderable view.
//!
//! This module takes a TablixDefinition (configuration) and PivotCache (data)
//! and produces a TablixView (2D grid ready for rendering).
//!
//! Key differences from the Pivot engine:
//! - Supports detail rows (raw source data at leaf nodes)
//! - Computes row_span for group headers spanning detail rows
//! - Computes col_span for column group headers spanning data columns
//! - Data fields can be independently aggregated or detail mode

use std::collections::HashMap;
use pivot_engine::cache::{
    AggregateAccumulator, CacheRecord, CacheValue,
    PivotCache, ValueId, VALUE_ID_EMPTY,
};
use pivot_engine::definition::{
    AggregationType, FieldIndex, PivotField, SortOrder,
};
use crate::definition::{DataFieldMode, GroupLayout, TablixDefinition};
use crate::view::{
    TablixBackgroundStyle, TablixCellValue,
    TablixColumnDescriptor, TablixColumnType, TablixFilterRowInfo,
    TablixRowDescriptor, TablixRowType, TablixView, TablixViewCell,
};

// ============================================================================
// AXIS TREE STRUCTURES (mirrors pivot engine pattern)
// ============================================================================

/// A node in the axis tree (row or column hierarchy).
#[derive(Debug, Clone)]
struct AxisNode {
    value_id: ValueId,
    field_index: FieldIndex,
    label: String,
    depth: usize,
    children: Vec<AxisNode>,
    is_collapsed: bool,
    show_subtotal: bool,
}

impl AxisNode {
    fn new(value_id: ValueId, field_index: FieldIndex, label: String, depth: usize) -> Self {
        AxisNode {
            value_id,
            field_index,
            label,
            depth,
            children: Vec::new(),
            is_collapsed: false,
            show_subtotal: true,
        }
    }
}

/// A flattened row group item for the row axis.
#[derive(Debug, Clone)]
struct FlatRowItem {
    /// Group values up to this level.
    group_values: Vec<ValueId>,
    /// Display label.
    label: String,
    /// Depth/indent level.
    depth: usize,
    /// Whether this is a subtotal row.
    is_subtotal: bool,
    /// Whether this is the grand total.
    is_grand_total: bool,
    /// Whether this item has children.
    has_children: bool,
    /// Whether this item is collapsed.
    is_collapsed: bool,
    /// Matching source row indices (for detail rendering at leaf nodes).
    detail_rows: Vec<u32>,
}

/// A flattened column group item.
#[derive(Debug, Clone)]
struct FlatColItem {
    group_values: Vec<ValueId>,
    label: String,
    depth: usize,
    is_subtotal: bool,
    is_grand_total: bool,
    has_children: bool,
    parent_index: i32,
}

// ============================================================================
// TABLIX CALCULATOR
// ============================================================================

/// The main calculation engine for tablix.
pub struct TablixCalculator<'a> {
    definition: &'a TablixDefinition,
    cache: &'a mut PivotCache,

    /// Flattened row axis items (with detail row indices).
    row_items: Vec<FlatRowItem>,

    /// Flattened column axis items.
    col_items: Vec<FlatColItem>,

    /// Row group field indices.
    row_field_indices: Vec<FieldIndex>,

    /// Column group field indices.
    col_field_indices: Vec<FieldIndex>,
}

impl<'a> TablixCalculator<'a> {
    pub fn new(definition: &'a TablixDefinition, cache: &'a mut PivotCache) -> Self {
        let row_field_indices: Vec<FieldIndex> = definition
            .row_groups
            .iter()
            .map(|f| f.source_index)
            .collect();

        let col_field_indices: Vec<FieldIndex> = definition
            .column_groups
            .iter()
            .map(|f| f.source_index)
            .collect();

        TablixCalculator {
            definition,
            cache,
            row_items: Vec::new(),
            col_items: Vec::new(),
            row_field_indices,
            col_field_indices,
        }
    }

    /// Executes the full calculation and returns the rendered view.
    pub fn calculate(&mut self) -> TablixView {
        // Step 1: Apply filters
        self.apply_filters();

        // Step 2: Build row axis tree
        let row_tree = self.build_axis_tree(&self.definition.row_groups.clone());

        // Step 3: Build column axis tree
        let col_tree = self.build_axis_tree(&self.definition.column_groups.clone());

        // Step 4: Flatten row tree with detail row collection
        self.row_items = self.flatten_row_tree(&row_tree);

        // Step 5: Flatten column tree
        self.col_items = self.flatten_col_tree(&col_tree);

        // Step 6: Generate the view
        self.generate_view()
    }

    // ========================================================================
    // FILTERING
    // ========================================================================

    fn apply_filters(&mut self) {
        let mut hidden_items: Vec<(FieldIndex, Vec<ValueId>)> = Vec::new();

        for field in &self.definition.row_groups {
            if !field.hidden_items.is_empty() {
                let hidden_ids = self.resolve_hidden_items(field);
                if !hidden_ids.is_empty() {
                    hidden_items.push((field.source_index, hidden_ids));
                }
            }
        }

        for field in &self.definition.column_groups {
            if !field.hidden_items.is_empty() {
                let hidden_ids = self.resolve_hidden_items(field);
                if !hidden_ids.is_empty() {
                    hidden_items.push((field.source_index, hidden_ids));
                }
            }
        }

        for filter in &self.definition.filter_fields {
            if !filter.field.hidden_items.is_empty() {
                let hidden_ids = self.resolve_hidden_items(&filter.field);
                if !hidden_ids.is_empty() {
                    hidden_items.push((filter.field.source_index, hidden_ids));
                }
            }
        }

        self.cache.apply_filters(&hidden_items);
    }

    fn resolve_hidden_items(&self, field: &PivotField) -> Vec<ValueId> {
        let mut ids = Vec::new();
        if let Some(field_cache) = self.cache.fields.get(field.source_index) {
            for hidden_str in &field.hidden_items {
                for id in 0..field_cache.unique_count() as ValueId {
                    if let Some(CacheValue::Text(s)) = field_cache.get_value(id) {
                        if s == hidden_str {
                            ids.push(id);
                            break;
                        }
                    }
                }
            }
        }
        ids
    }

    // ========================================================================
    // AXIS TREE BUILDING (reuses pivot patterns)
    // ========================================================================

    fn build_axis_tree(&mut self, fields: &[PivotField]) -> Vec<AxisNode> {
        if fields.is_empty() {
            return Vec::new();
        }
        let unique_values = self.collect_unique_values(fields);
        self.build_tree_level(fields, 0, &unique_values, &[])
    }

    fn collect_unique_values(
        &self,
        fields: &[PivotField],
    ) -> Vec<HashMap<ValueId, bool>> {
        let mut unique_per_level: Vec<HashMap<ValueId, bool>> =
            vec![HashMap::new(); fields.len()];

        for record in self.cache.filtered_records() {
            for (level, field) in fields.iter().enumerate() {
                let value_id = record.values
                    .get(field.source_index)
                    .copied()
                    .unwrap_or(VALUE_ID_EMPTY);
                unique_per_level[level].insert(value_id, true);
            }
        }

        unique_per_level
    }

    fn build_tree_level(
        &self,
        fields: &[PivotField],
        level: usize,
        unique_values: &[HashMap<ValueId, bool>],
        parent_path: &[ValueId],
    ) -> Vec<AxisNode> {
        if level >= fields.len() {
            return Vec::new();
        }

        let field = &fields[level];
        let field_cache = match self.cache.fields.get(field.source_index) {
            Some(fc) => fc,
            None => return Vec::new(),
        };

        let values_at_level = match unique_values.get(level) {
            Some(v) => v,
            None => return Vec::new(),
        };

        let mut sorted_ids: Vec<ValueId> = values_at_level.keys().copied().collect();
        self.sort_value_ids(&mut sorted_ids, field.source_index, &field.sort_order);

        let mut nodes = Vec::with_capacity(sorted_ids.len());

        for value_id in sorted_ids {
            let label = self.get_value_label(field.source_index, value_id);
            let mut node = AxisNode::new(value_id, field.source_index, label, level);
            node.is_collapsed = field.collapsed;
            node.show_subtotal = field.show_subtotals && level < fields.len() - 1;

            if level < fields.len() - 1 {
                let mut child_path = parent_path.to_vec();
                child_path.push(value_id);
                let child_unique = self.filter_unique_for_parent(fields, level + 1, &child_path);
                node.children = self.build_tree_level(fields, level + 1, &child_unique, &child_path);
            }

            nodes.push(node);
        }

        nodes
    }

    fn filter_unique_for_parent(
        &self,
        fields: &[PivotField],
        start_level: usize,
        parent_path: &[ValueId],
    ) -> Vec<HashMap<ValueId, bool>> {
        let mut unique_per_level: Vec<HashMap<ValueId, bool>> =
            vec![HashMap::new(); fields.len()];

        'records: for record in self.cache.filtered_records() {
            for (level, &parent_value) in parent_path.iter().enumerate() {
                if level >= fields.len() {
                    break;
                }
                let field_idx = fields[level].source_index;
                let record_value = record.values
                    .get(field_idx)
                    .copied()
                    .unwrap_or(VALUE_ID_EMPTY);
                if record_value != parent_value {
                    continue 'records;
                }
            }

            for level in start_level..fields.len() {
                let field_idx = fields[level].source_index;
                let value_id = record.values
                    .get(field_idx)
                    .copied()
                    .unwrap_or(VALUE_ID_EMPTY);
                unique_per_level[level].insert(value_id, true);
            }
        }

        unique_per_level
    }

    fn sort_value_ids(&self, ids: &mut Vec<ValueId>, field_index: FieldIndex, sort_order: &SortOrder) {
        let field_cache = match self.cache.fields.get(field_index) {
            Some(fc) => fc,
            None => return,
        };

        match sort_order {
            SortOrder::Ascending => {
                ids.sort_by(|&a, &b| self.compare_values(field_cache, a, b));
            }
            SortOrder::Descending => {
                ids.sort_by(|&a, &b| self.compare_values(field_cache, b, a));
            }
            SortOrder::Manual | SortOrder::DataSourceOrder => {}
        }
    }

    fn compare_values(
        &self,
        field_cache: &pivot_engine::cache::FieldCache,
        a: ValueId,
        b: ValueId,
    ) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        let va = field_cache.get_value(a);
        let vb = field_cache.get_value(b);
        match (va, vb) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            (Some(va), Some(vb)) => match (va, vb) {
                (CacheValue::Empty, CacheValue::Empty) => Ordering::Equal,
                (CacheValue::Empty, _) => Ordering::Less,
                (_, CacheValue::Empty) => Ordering::Greater,
                (CacheValue::Number(na), CacheValue::Number(nb)) => {
                    na.as_f64().partial_cmp(&nb.as_f64()).unwrap_or(Ordering::Equal)
                }
                (CacheValue::Number(_), _) => Ordering::Less,
                (_, CacheValue::Number(_)) => Ordering::Greater,
                (CacheValue::Text(ta), CacheValue::Text(tb)) => ta.cmp(tb),
                (CacheValue::Text(_), _) => Ordering::Less,
                (_, CacheValue::Text(_)) => Ordering::Greater,
                (CacheValue::Boolean(ba), CacheValue::Boolean(bb)) => ba.cmp(bb),
                (CacheValue::Boolean(_), _) => Ordering::Less,
                (_, CacheValue::Boolean(_)) => Ordering::Greater,
                (CacheValue::Error(ea), CacheValue::Error(eb)) => ea.cmp(eb),
            },
        }
    }

    fn get_value_label(&self, field_index: FieldIndex, value_id: ValueId) -> String {
        if value_id == VALUE_ID_EMPTY {
            return "(blank)".to_string();
        }
        let field_cache = match self.cache.fields.get(field_index) {
            Some(fc) => fc,
            None => return "(unknown)".to_string(),
        };
        match field_cache.get_value(value_id) {
            Some(CacheValue::Empty) => "(blank)".to_string(),
            Some(CacheValue::Number(n)) => format!("{}", n.as_f64()),
            Some(CacheValue::Text(s)) => s.clone(),
            Some(CacheValue::Boolean(b)) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Some(CacheValue::Error(e)) => format!("#{}", e),
            None => "(unknown)".to_string(),
        }
    }

    fn cache_value_to_tablix(cv: &CacheValue) -> (TablixCellValue, String) {
        match cv {
            CacheValue::Empty => (TablixCellValue::Empty, String::new()),
            CacheValue::Number(n) => {
                let v = n.as_f64();
                (TablixCellValue::Number(v), format!("{}", v))
            }
            CacheValue::Text(s) => (TablixCellValue::Text(s.clone()), s.clone()),
            CacheValue::Boolean(b) => {
                let s = if *b { "TRUE" } else { "FALSE" };
                (TablixCellValue::Boolean(*b), s.to_string())
            }
            CacheValue::Error(e) => (TablixCellValue::Error(e.clone()), format!("#{}", e)),
        }
    }

    // ========================================================================
    // ROW TREE FLATTENING (with detail row collection)
    // ========================================================================

    /// Flattens the row axis tree, collecting matching source rows at each leaf node.
    fn flatten_row_tree(&self, tree: &[AxisNode]) -> Vec<FlatRowItem> {
        let mut items = Vec::new();
        let fields = &self.definition.row_groups;
        let has_detail = self.definition.has_detail_fields();

        self.flatten_row_nodes(tree, &mut items, &[], 0, fields, has_detail);

        // Add grand total if configured
        if self.definition.layout.show_row_grand_totals {
            let field_count = fields.len();
            items.push(FlatRowItem {
                group_values: vec![VALUE_ID_EMPTY; field_count],
                label: "Grand Total".to_string(),
                depth: 0,
                is_subtotal: false,
                is_grand_total: true,
                has_children: false,
                is_collapsed: false,
                detail_rows: Vec::new(),
            });
        }

        items
    }

    fn flatten_row_nodes(
        &self,
        nodes: &[AxisNode],
        items: &mut Vec<FlatRowItem>,
        parent_values: &[ValueId],
        depth: usize,
        fields: &[PivotField],
        has_detail: bool,
    ) {
        let total_levels = fields.len();

        for node in nodes {
            let mut group_values = parent_values.to_vec();
            group_values.push(node.value_id);

            let has_children = !node.children.is_empty();
            let is_leaf = depth == total_levels - 1 || !has_children;

            // Collect detail rows for leaf nodes (when any field is in detail mode)
            let detail_rows = if is_leaf && has_detail {
                self.collect_detail_rows_for_group(&group_values, fields)
            } else {
                Vec::new()
            };

            // Pad group values
            let mut padded_values = group_values.clone();
            while padded_values.len() < total_levels {
                padded_values.push(VALUE_ID_EMPTY);
            }

            items.push(FlatRowItem {
                group_values: padded_values,
                label: node.label.clone(),
                depth,
                is_subtotal: false,
                is_grand_total: false,
                has_children,
                is_collapsed: node.is_collapsed,
                detail_rows,
            });

            // Recurse into children
            if has_children && !node.is_collapsed {
                let child_parent: Vec<ValueId> = parent_values
                    .iter()
                    .chain(std::iter::once(&node.value_id))
                    .copied()
                    .collect();

                self.flatten_row_nodes(
                    &node.children,
                    items,
                    &child_parent,
                    depth + 1,
                    fields,
                    has_detail,
                );
            }

            // Subtotal after children
            if node.show_subtotal && has_children {
                let mut subtotal_values = parent_values.to_vec();
                subtotal_values.push(node.value_id);
                while subtotal_values.len() < total_levels {
                    subtotal_values.push(VALUE_ID_EMPTY);
                }

                items.push(FlatRowItem {
                    group_values: subtotal_values,
                    label: format!("{} Total", node.label),
                    depth,
                    is_subtotal: true,
                    is_grand_total: false,
                    has_children: false,
                    is_collapsed: false,
                    detail_rows: Vec::new(),
                });
            }
        }
    }

    /// Collects source row indices that match the given group values.
    fn collect_detail_rows_for_group(
        &self,
        group_values: &[ValueId],
        fields: &[PivotField],
    ) -> Vec<u32> {
        let mut rows = Vec::new();

        for record in self.cache.filtered_records() {
            let mut matches = true;
            for (level, &gv) in group_values.iter().enumerate() {
                if gv == VALUE_ID_EMPTY {
                    continue; // Wildcard - matches all
                }
                if level < fields.len() {
                    let field_idx = fields[level].source_index;
                    let record_value = record.values
                        .get(field_idx)
                        .copied()
                        .unwrap_or(VALUE_ID_EMPTY);
                    if record_value != gv {
                        matches = false;
                        break;
                    }
                }
            }
            if matches {
                rows.push(record.source_row);
            }
        }

        rows
    }

    // ========================================================================
    // COLUMN TREE FLATTENING
    // ========================================================================

    fn flatten_col_tree(&self, tree: &[AxisNode]) -> Vec<FlatColItem> {
        let mut items = Vec::new();
        let fields = &self.definition.column_groups;

        self.flatten_col_nodes(tree, &mut items, &[], 0, fields, -1);

        if self.definition.layout.show_column_grand_totals {
            let field_count = fields.len();
            items.push(FlatColItem {
                group_values: vec![VALUE_ID_EMPTY; field_count],
                label: "Grand Total".to_string(),
                depth: 0,
                is_subtotal: false,
                is_grand_total: true,
                has_children: false,
                parent_index: -1,
            });
        }

        items
    }

    fn flatten_col_nodes(
        &self,
        nodes: &[AxisNode],
        items: &mut Vec<FlatColItem>,
        parent_values: &[ValueId],
        depth: usize,
        fields: &[PivotField],
        parent_index: i32,
    ) {
        let total_levels = fields.len();

        for node in nodes {
            let my_index = items.len() as i32;
            let mut group_values = parent_values.to_vec();
            group_values.push(node.value_id);
            while group_values.len() < total_levels {
                group_values.push(VALUE_ID_EMPTY);
            }

            let has_children = !node.children.is_empty();

            items.push(FlatColItem {
                group_values,
                label: node.label.clone(),
                depth,
                is_subtotal: false,
                is_grand_total: false,
                has_children,
                parent_index,
            });

            if has_children {
                let child_parent: Vec<ValueId> = parent_values
                    .iter()
                    .chain(std::iter::once(&node.value_id))
                    .copied()
                    .collect();

                self.flatten_col_nodes(
                    &node.children,
                    items,
                    &child_parent,
                    depth + 1,
                    fields,
                    my_index,
                );
            }

            if node.show_subtotal && has_children {
                let mut subtotal_values = parent_values.to_vec();
                subtotal_values.push(node.value_id);
                while subtotal_values.len() < total_levels {
                    subtotal_values.push(VALUE_ID_EMPTY);
                }

                items.push(FlatColItem {
                    group_values: subtotal_values,
                    label: format!("{} Total", node.label),
                    depth,
                    is_subtotal: true,
                    is_grand_total: false,
                    has_children: false,
                    parent_index: my_index,
                });
            }
        }
    }

    // ========================================================================
    // VIEW GENERATION
    // ========================================================================

    fn generate_view(&mut self) -> TablixView {
        let mut view = TablixView::new(self.definition.id);
        view.version = self.definition.version;

        let row_group_cols = self.calculate_row_group_columns();
        let col_header_rows = self.calculate_col_header_rows();

        view.row_group_col_count = row_group_cols;
        view.column_header_row_count = col_header_rows;

        // Generate column descriptors
        let col_descriptors = self.generate_column_descriptors(row_group_cols);
        view.set_columns(col_descriptors);

        // Generate filter rows
        let filter_row_count = self.generate_filter_rows(&mut view, row_group_cols);
        view.filter_row_count = filter_row_count;

        // Generate column header rows
        self.generate_column_headers(&mut view, row_group_cols, col_header_rows);

        // Generate data rows (including detail rows and group header spanning)
        self.generate_data_rows(&mut view, row_group_cols);

        view.column_header_row_count = col_header_rows + filter_row_count;

        view
    }

    fn calculate_row_group_columns(&self) -> usize {
        match self.definition.layout.group_layout {
            GroupLayout::Stepped => {
                // All row groups in one column with indentation
                if self.definition.row_groups.is_empty() { 0 } else { 1 }
            }
            GroupLayout::Block => {
                // Each row group gets its own column
                self.definition.row_groups.len().max(if self.definition.row_groups.is_empty() { 0 } else { 1 })
            }
        }
    }

    fn calculate_col_header_rows(&self) -> usize {
        if self.definition.column_groups.is_empty() {
            1 // Just one row for data field names
        } else {
            let base = self.definition.column_groups.len();
            if self.definition.data_fields.len() > 1 {
                base + 1
            } else {
                base.max(1)
            }
        }
    }

    fn calculate_data_columns(&self) -> usize {
        if self.col_items.is_empty() {
            // No column groups: one column per data field
            self.definition.data_fields.len().max(1)
        } else {
            // Column groups times data fields
            let data_field_count = self.definition.data_fields.len().max(1);
            self.col_items.len() * data_field_count
        }
    }

    fn generate_column_descriptors(&self, row_group_cols: usize) -> Vec<TablixColumnDescriptor> {
        let mut descriptors = Vec::new();

        // Row group label columns
        for i in 0..row_group_cols {
            descriptors.push(TablixColumnDescriptor {
                view_col: i,
                col_type: TablixColumnType::RowGroupLabel,
                depth: 0,
                width_hint: 120,
                parent_index: None,
                children_indices: Vec::new(),
                group_values: Vec::new(),
            });
        }

        // Data columns
        if self.col_items.is_empty() {
            for (i, df) in self.definition.data_fields.iter().enumerate() {
                let col_idx = row_group_cols + i;
                descriptors.push(TablixColumnDescriptor {
                    view_col: col_idx,
                    col_type: TablixColumnType::Data,
                    depth: 0,
                    width_hint: 100,
                    parent_index: None,
                    children_indices: Vec::new(),
                    group_values: vec![i as ValueId],
                });
            }
            if self.definition.data_fields.is_empty() {
                descriptors.push(TablixColumnDescriptor {
                    view_col: row_group_cols,
                    col_type: TablixColumnType::Data,
                    depth: 0,
                    width_hint: 100,
                    parent_index: None,
                    children_indices: Vec::new(),
                    group_values: Vec::new(),
                });
            }
        } else {
            let data_field_count = self.definition.data_fields.len().max(1);
            for (i, item) in self.col_items.iter().enumerate() {
                for df_idx in 0..data_field_count {
                    let col_idx = row_group_cols + i * data_field_count + df_idx;
                    let col_type = if item.is_grand_total {
                        TablixColumnType::GrandTotal
                    } else if item.is_subtotal {
                        TablixColumnType::Subtotal
                    } else {
                        TablixColumnType::Data
                    };

                    descriptors.push(TablixColumnDescriptor {
                        view_col: col_idx,
                        col_type,
                        depth: item.depth as u8,
                        width_hint: 100,
                        parent_index: if item.parent_index >= 0 {
                            Some((row_group_cols as i32 + item.parent_index) as usize)
                        } else {
                            None
                        },
                        children_indices: Vec::new(),
                        group_values: item.group_values.clone(),
                    });
                }
            }
        }

        descriptors
    }

    fn generate_filter_rows(&mut self, view: &mut TablixView, row_group_cols: usize) -> usize {
        let filter_fields = &self.definition.filter_fields;
        if filter_fields.is_empty() {
            return 0;
        }

        let total_cols = view.col_count.max(row_group_cols + 1);

        for (filter_idx, filter) in filter_fields.iter().enumerate() {
            let field_index = filter.field.source_index;
            let field_name = filter.field.name.clone();

            let unique_values = self.collect_unique_values_for_field(field_index);
            let hidden_items = &filter.field.hidden_items;
            let selected_values: Vec<String> = unique_values
                .iter()
                .filter(|v| !hidden_items.contains(v))
                .cloned()
                .collect();

            let display_value = if hidden_items.is_empty()
                || selected_values.len() == unique_values.len()
            {
                "(All)".to_string()
            } else if selected_values.len() == 1 {
                selected_values[0].clone()
            } else if selected_values.is_empty() {
                "(None)".to_string()
            } else {
                format!("({} items)", selected_values.len())
            };

            view.filter_rows.push(TablixFilterRowInfo {
                field_index,
                field_name: field_name.clone(),
                selected_values: selected_values.clone(),
                unique_values: unique_values.clone(),
                display_value: display_value.clone(),
                view_row: filter_idx,
            });

            let mut cells = Vec::with_capacity(total_cols);
            let mut label_cell = TablixViewCell::filter_label(
                format!("{}:", field_name),
                field_index,
            );
            label_cell.background_style = TablixBackgroundStyle::FilterRow;
            cells.push(label_cell);

            let mut dropdown_cell = TablixViewCell::filter_dropdown(display_value, field_index);
            dropdown_cell.background_style = TablixBackgroundStyle::FilterRow;
            if row_group_cols > 1 {
                dropdown_cell.col_span = (row_group_cols - 1) as u16;
            }
            cells.push(dropdown_cell);

            while cells.len() < total_cols {
                let mut blank = TablixViewCell::blank();
                blank.background_style = TablixBackgroundStyle::FilterRow;
                cells.push(blank);
            }

            let descriptor = TablixRowDescriptor {
                view_row: filter_idx,
                row_type: TablixRowType::FilterRow,
                depth: 0,
                visible: true,
                parent_index: None,
                children_indices: Vec::new(),
                group_values: Vec::new(),
                source_row: None,
            };

            view.add_row(cells, descriptor);
        }

        // Spacing row
        let spacing_idx = filter_fields.len();
        let mut spacing_cells = Vec::with_capacity(total_cols);
        for _ in 0..total_cols {
            spacing_cells.push(TablixViewCell::blank());
        }
        view.add_row(spacing_cells, TablixRowDescriptor {
            view_row: spacing_idx,
            row_type: TablixRowType::FilterRow,
            depth: 0,
            visible: true,
            parent_index: None,
            children_indices: Vec::new(),
            group_values: Vec::new(),
            source_row: None,
        });

        filter_fields.len() + 1
    }

    fn collect_unique_values_for_field(&self, field_index: FieldIndex) -> Vec<String> {
        let mut values = Vec::new();
        if let Some(field_cache) = self.cache.fields.get(field_index) {
            for id in 0..field_cache.unique_count() as ValueId {
                let label = self.get_value_label(field_index, id);
                values.push(label);
            }
        }
        values
    }

    fn generate_column_headers(
        &mut self,
        view: &mut TablixView,
        row_group_cols: usize,
        col_header_rows: usize,
    ) {
        let total_cols = view.col_count;

        if self.col_items.is_empty() {
            // Single header row with data field names
            let mut cells = Vec::with_capacity(total_cols);

            // Corner cells for row group columns
            for i in 0..row_group_cols {
                if i < self.definition.row_groups.len() {
                    let name = match self.definition.layout.group_layout {
                        GroupLayout::Block => self.definition.row_groups[i].name.clone(),
                        GroupLayout::Stepped => {
                            if i == 0 {
                                self.definition.row_groups
                                    .iter()
                                    .map(|f| f.name.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" / ")
                            } else {
                                String::new()
                            }
                        }
                    };
                    cells.push(TablixViewCell::corner().with_col_span(1));
                    if !name.is_empty() {
                        let last = cells.last_mut().unwrap();
                        last.value = TablixCellValue::Text(name.clone());
                        last.formatted_value = name;
                        last.is_bold = true;
                    }
                } else {
                    cells.push(TablixViewCell::corner());
                }
            }

            // Data field name headers
            for df in &self.definition.data_fields {
                cells.push(TablixViewCell::column_group_header(df.name.clone()));
            }
            if self.definition.data_fields.is_empty() {
                cells.push(TablixViewCell::corner());
            }

            while cells.len() < total_cols {
                cells.push(TablixViewCell::blank());
            }

            view.add_row(cells, TablixRowDescriptor {
                view_row: view.row_count,
                row_type: TablixRowType::ColumnHeader,
                depth: 0,
                visible: true,
                parent_index: None,
                children_indices: Vec::new(),
                group_values: Vec::new(),
                source_row: None,
            });
        } else {
            // Multi-level column headers
            let data_field_count = self.definition.data_fields.len().max(1);

            for header_row in 0..col_header_rows {
                let mut cells = Vec::with_capacity(total_cols);

                // Corner cells
                for _ in 0..row_group_cols {
                    cells.push(TablixViewCell::corner());
                }

                // Column group headers at this level
                for (ci, col_item) in self.col_items.iter().enumerate() {
                    if header_row < self.definition.column_groups.len() {
                        if col_item.depth as usize == header_row {
                            let mut cell = TablixViewCell::column_group_header(col_item.label.clone());
                            // Span across data fields
                            if data_field_count > 1 {
                                cell.col_span = data_field_count as u16;
                            }
                            cells.push(cell);
                            // Add spanned cells for additional data field columns
                            for _ in 1..data_field_count {
                                cells.push(TablixViewCell::spanned());
                            }
                        } else if col_item.depth as usize > header_row {
                            // Blank cells - parent handles spanning
                            for _ in 0..data_field_count {
                                cells.push(TablixViewCell::spanned());
                            }
                        } else {
                            for _ in 0..data_field_count {
                                cells.push(TablixViewCell::blank());
                            }
                        }
                    } else {
                        // Data field name row (when multiple data fields)
                        for (df_idx, df) in self.definition.data_fields.iter().enumerate() {
                            cells.push(TablixViewCell::column_group_header(df.name.clone()));
                        }
                        if self.definition.data_fields.is_empty() {
                            cells.push(TablixViewCell::blank());
                        }
                    }
                }

                while cells.len() < total_cols {
                    cells.push(TablixViewCell::blank());
                }

                view.add_row(cells, TablixRowDescriptor {
                    view_row: view.row_count,
                    row_type: TablixRowType::ColumnHeader,
                    depth: header_row as u8,
                    visible: true,
                    parent_index: None,
                    children_indices: Vec::new(),
                    group_values: Vec::new(),
                    source_row: None,
                });
            }
        }
    }

    fn generate_data_rows(&mut self, view: &mut TablixView, row_group_cols: usize) {
        let total_cols = view.col_count;
        let has_detail = self.definition.has_detail_fields();
        let data_field_count = self.definition.data_fields.len().max(1);

        // Clone row_items to avoid borrow issues
        let row_items = self.row_items.clone();

        for (ri, row_item) in row_items.iter().enumerate() {
            if row_item.is_grand_total || row_item.is_subtotal {
                // Generate aggregated total row
                let cells = self.generate_total_row(
                    row_item,
                    row_group_cols,
                    total_cols,
                    data_field_count,
                );

                let row_type = if row_item.is_grand_total {
                    TablixRowType::GrandTotal
                } else {
                    TablixRowType::Subtotal
                };

                view.add_row(cells, TablixRowDescriptor {
                    view_row: view.row_count,
                    row_type,
                    depth: row_item.depth as u8,
                    visible: true,
                    parent_index: None,
                    children_indices: Vec::new(),
                    group_values: row_item.group_values.clone(),
                    source_row: None,
                });
            } else if has_detail && !row_item.detail_rows.is_empty() {
                // Generate group header + detail rows with spanning
                let detail_count = row_item.detail_rows.len();
                let group_row_idx = view.row_count;
                let mut child_indices = Vec::new();

                // First row: group header with row_span + first detail row data
                let first_detail_source_row = row_item.detail_rows[0];
                let mut first_row_cells = self.generate_group_header_cells(
                    row_item,
                    row_group_cols,
                    detail_count as u16,
                );

                // Add data columns for first detail row
                self.append_detail_data_cells(
                    &mut first_row_cells,
                    first_detail_source_row,
                    total_cols,
                    data_field_count,
                    false,
                );

                view.add_row(first_row_cells, TablixRowDescriptor {
                    view_row: view.row_count,
                    row_type: TablixRowType::GroupHeader,
                    depth: row_item.depth as u8,
                    visible: true,
                    parent_index: None,
                    children_indices: Vec::new(),
                    group_values: row_item.group_values.clone(),
                    source_row: Some(first_detail_source_row),
                });

                // Remaining detail rows (spanned group header cells)
                for (di, &source_row) in row_item.detail_rows.iter().enumerate().skip(1) {
                    let mut cells = Vec::with_capacity(total_cols);

                    // Spanned group header cells
                    for _ in 0..row_group_cols {
                        cells.push(TablixViewCell::spanned());
                    }

                    // Detail data cells
                    let is_alternate = di % 2 == 1;
                    self.append_detail_data_cells(
                        &mut cells,
                        source_row,
                        total_cols,
                        data_field_count,
                        is_alternate,
                    );

                    let detail_row_idx = view.row_count;
                    child_indices.push(detail_row_idx);

                    view.add_row(cells, TablixRowDescriptor {
                        view_row: view.row_count,
                        row_type: TablixRowType::Detail,
                        depth: (row_item.depth + 1) as u8,
                        visible: true,
                        parent_index: Some(group_row_idx),
                        children_indices: Vec::new(),
                        group_values: row_item.group_values.clone(),
                        source_row: Some(source_row),
                    });
                }

                // Update parent's children indices
                if !child_indices.is_empty() {
                    view.rows[group_row_idx].children_indices = child_indices;
                }
            } else {
                // No detail fields or no matching rows - generate aggregated row
                let cells = self.generate_aggregated_row(
                    row_item,
                    row_group_cols,
                    total_cols,
                    data_field_count,
                );

                view.add_row(cells, TablixRowDescriptor {
                    view_row: view.row_count,
                    row_type: if row_item.has_children {
                        TablixRowType::GroupHeader
                    } else {
                        TablixRowType::Detail
                    },
                    depth: row_item.depth as u8,
                    visible: true,
                    parent_index: None,
                    children_indices: Vec::new(),
                    group_values: row_item.group_values.clone(),
                    source_row: None,
                });
            }
        }
    }

    /// Generates group header cells for the row group columns.
    fn generate_group_header_cells(
        &self,
        row_item: &FlatRowItem,
        row_group_cols: usize,
        row_span: u16,
    ) -> Vec<TablixViewCell> {
        let mut cells = Vec::with_capacity(row_group_cols);

        match self.definition.layout.group_layout {
            GroupLayout::Stepped => {
                let mut cell = TablixViewCell::row_group_header(
                    row_item.label.clone(),
                    row_item.depth as u8,
                );
                if row_span > 1 {
                    cell.row_span = row_span;
                }
                if row_item.has_children {
                    cell = cell.with_expandable(true, row_item.is_collapsed);
                }
                cell = cell.with_group_path(
                    row_item.group_values.iter().enumerate()
                        .filter(|(_, &v)| v != VALUE_ID_EMPTY)
                        .map(|(i, &v)| (i, v))
                        .collect()
                );
                cells.push(cell);
            }
            GroupLayout::Block => {
                for col in 0..row_group_cols {
                    if col == row_item.depth {
                        let mut cell = TablixViewCell::row_group_header(
                            row_item.label.clone(),
                            0,
                        );
                        if row_span > 1 {
                            cell.row_span = row_span;
                        }
                        if row_item.has_children {
                            cell = cell.with_expandable(true, row_item.is_collapsed);
                        }
                        cell = cell.with_group_path(
                            row_item.group_values.iter().enumerate()
                                .filter(|(_, &v)| v != VALUE_ID_EMPTY)
                                .map(|(i, &v)| (i, v))
                                .collect()
                        );
                        cells.push(cell);
                    } else {
                        let mut blank = TablixViewCell::blank();
                        if row_span > 1 {
                            blank.row_span = row_span;
                        }
                        cells.push(blank);
                    }
                }
            }
        }

        cells
    }

    /// Appends detail data cells for a specific source row.
    fn append_detail_data_cells(
        &self,
        cells: &mut Vec<TablixViewCell>,
        source_row: u32,
        total_cols: usize,
        data_field_count: usize,
        is_alternate: bool,
    ) {
        let record = self.cache.records.iter().find(|r| r.source_row == source_row);

        if self.col_items.is_empty() {
            // No column groups - one cell per data field
            for df in &self.definition.data_fields {
                match &df.mode {
                    DataFieldMode::Detail => {
                        let cell = if let Some(rec) = record {
                            let value_id = rec.values
                                .get(df.source_index)
                                .copied()
                                .unwrap_or(VALUE_ID_EMPTY);

                            if value_id == VALUE_ID_EMPTY {
                                TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                            } else if let Some(field_cache) = self.cache.fields.get(df.source_index) {
                                if let Some(cv) = field_cache.get_value(value_id) {
                                    let (val, formatted) = Self::cache_value_to_tablix(cv);
                                    let mut c = TablixViewCell::detail_data(val, formatted);
                                    if is_alternate {
                                        c.background_style = TablixBackgroundStyle::DetailRowAlternate;
                                    }
                                    c
                                } else {
                                    TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                                }
                            } else {
                                TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                            }
                        } else {
                            TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                        };
                        cells.push(cell);
                    }
                    DataFieldMode::Aggregated(_) => {
                        // For aggregated fields in a detail row context,
                        // show the raw value (it will be the same as the source value)
                        let cell = if let Some(rec) = record {
                            let value_id = rec.values
                                .get(df.source_index)
                                .copied()
                                .unwrap_or(VALUE_ID_EMPTY);

                            if value_id == VALUE_ID_EMPTY {
                                TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                            } else if let Some(field_cache) = self.cache.fields.get(df.source_index) {
                                if let Some(cv) = field_cache.get_value(value_id) {
                                    let (val, formatted) = Self::cache_value_to_tablix(cv);
                                    let mut c = TablixViewCell::detail_data(val, formatted);
                                    if is_alternate {
                                        c.background_style = TablixBackgroundStyle::DetailRowAlternate;
                                    }
                                    c
                                } else {
                                    TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                                }
                            } else {
                                TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                            }
                        } else {
                            TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                        };
                        cells.push(cell);
                    }
                }
            }
        } else {
            // With column groups - detail cell for each column group x data field
            for col_item in &self.col_items {
                for df in &self.definition.data_fields {
                    let cell = if let Some(rec) = record {
                        let value_id = rec.values
                            .get(df.source_index)
                            .copied()
                            .unwrap_or(VALUE_ID_EMPTY);

                        if value_id == VALUE_ID_EMPTY {
                            TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                        } else if let Some(field_cache) = self.cache.fields.get(df.source_index) {
                            if let Some(cv) = field_cache.get_value(value_id) {
                                let (val, formatted) = Self::cache_value_to_tablix(cv);
                                let mut c = TablixViewCell::detail_data(val, formatted);
                                if is_alternate {
                                    c.background_style = TablixBackgroundStyle::DetailRowAlternate;
                                }
                                c
                            } else {
                                TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                            }
                        } else {
                            TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                        }
                    } else {
                        TablixViewCell::detail_data(TablixCellValue::Empty, String::new())
                    };
                    cells.push(cell);
                }
            }
        }

        // Pad to total_cols
        while cells.len() < total_cols {
            cells.push(TablixViewCell::blank());
        }
    }

    /// Generates an aggregated data row (no detail expansion).
    fn generate_aggregated_row(
        &self,
        row_item: &FlatRowItem,
        row_group_cols: usize,
        total_cols: usize,
        data_field_count: usize,
    ) -> Vec<TablixViewCell> {
        let mut cells = self.generate_group_header_cells(row_item, row_group_cols, 1);

        // Generate aggregated data cells
        self.append_aggregated_data_cells(
            &mut cells,
            &row_item.group_values,
            total_cols,
            data_field_count,
        );

        cells
    }

    /// Generates a total/subtotal row.
    fn generate_total_row(
        &self,
        row_item: &FlatRowItem,
        row_group_cols: usize,
        total_cols: usize,
        data_field_count: usize,
    ) -> Vec<TablixViewCell> {
        let mut cells = Vec::with_capacity(total_cols);

        // Total label spanning all row group columns
        match self.definition.layout.group_layout {
            GroupLayout::Stepped => {
                let mut cell = TablixViewCell::row_group_header(row_item.label.clone(), 0)
                    .as_total();
                cells.push(cell);
            }
            GroupLayout::Block => {
                for col in 0..row_group_cols {
                    if col == 0 {
                        let cell = TablixViewCell::row_group_header(row_item.label.clone(), 0)
                            .as_total()
                            .with_col_span(row_group_cols as u16);
                        cells.push(cell);
                    } else {
                        cells.push(TablixViewCell::spanned());
                    }
                }
            }
        }

        // Aggregated data cells for totals
        self.append_aggregated_data_cells(
            &mut cells,
            &row_item.group_values,
            total_cols,
            data_field_count,
        );

        cells
    }

    /// Appends aggregated data cells using the cache.
    fn append_aggregated_data_cells(
        &self,
        cells: &mut Vec<TablixViewCell>,
        row_group_values: &[ValueId],
        total_cols: usize,
        data_field_count: usize,
    ) {
        if self.col_items.is_empty() {
            // No column groups
            for df in &self.definition.data_fields {
                match &df.mode {
                    DataFieldMode::Aggregated(agg) => {
                        let value = self.compute_aggregate(
                            row_group_values,
                            &[],
                            df.source_index,
                            *agg,
                        );
                        let mut cell = TablixViewCell::aggregated_data(value);
                        cell.number_format = df.number_format.clone();
                        cell.formatted_value = format!("{}", value);
                        cells.push(cell);
                    }
                    DataFieldMode::Detail => {
                        // In an aggregated row context with a detail field,
                        // show count of matching records
                        let count = self.count_matching_records(row_group_values, &[]);
                        let mut cell = TablixViewCell::aggregated_data(count as f64);
                        cell.formatted_value = format!("{} records", count);
                        cells.push(cell);
                    }
                }
            }
        } else {
            for col_item in &self.col_items {
                for df in &self.definition.data_fields {
                    match &df.mode {
                        DataFieldMode::Aggregated(agg) => {
                            let value = self.compute_aggregate(
                                row_group_values,
                                &col_item.group_values,
                                df.source_index,
                                *agg,
                            );
                            let mut cell = TablixViewCell::aggregated_data(value);
                            cell.number_format = df.number_format.clone();
                            cell.formatted_value = format!("{}", value);
                            cells.push(cell);
                        }
                        DataFieldMode::Detail => {
                            let count = self.count_matching_records(
                                row_group_values,
                                &col_item.group_values,
                            );
                            let mut cell = TablixViewCell::aggregated_data(count as f64);
                            cell.formatted_value = format!("{} records", count);
                            cells.push(cell);
                        }
                    }
                }
            }
        }

        while cells.len() < total_cols {
            cells.push(TablixViewCell::blank());
        }
    }

    /// Computes an aggregate for a specific row/column group combination.
    fn compute_aggregate(
        &self,
        row_values: &[ValueId],
        col_values: &[ValueId],
        value_field_index: FieldIndex,
        aggregation: AggregationType,
    ) -> f64 {
        let row_fields = &self.definition.row_groups;
        let col_fields = &self.definition.column_groups;

        let mut acc = AggregateAccumulator::new();

        for record in self.cache.filtered_records() {
            if !self.record_matches_group(record, row_values, row_fields)
                || !self.record_matches_group(record, col_values, col_fields)
            {
                continue;
            }

            let value_id = record.values
                .get(value_field_index)
                .copied()
                .unwrap_or(VALUE_ID_EMPTY);

            if value_id == VALUE_ID_EMPTY {
                acc.add_non_number();
                continue;
            }

            if let Some(field_cache) = self.cache.fields.get(value_field_index) {
                if let Some(cv) = field_cache.get_value(value_id) {
                    match cv {
                        CacheValue::Number(n) => acc.add_number(n.as_f64()),
                        _ => acc.add_non_number(),
                    }
                }
            }
        }

        acc.compute(aggregation)
    }

    /// Counts matching records for a row/column group combination.
    fn count_matching_records(
        &self,
        row_values: &[ValueId],
        col_values: &[ValueId],
    ) -> usize {
        let row_fields = &self.definition.row_groups;
        let col_fields = &self.definition.column_groups;

        self.cache.filtered_records()
            .filter(|record| {
                self.record_matches_group(record, row_values, row_fields)
                    && self.record_matches_group(record, col_values, col_fields)
            })
            .count()
    }

    /// Checks if a record matches a group's values.
    fn record_matches_group(
        &self,
        record: &CacheRecord,
        group_values: &[ValueId],
        fields: &[PivotField],
    ) -> bool {
        for (level, &gv) in group_values.iter().enumerate() {
            if gv == VALUE_ID_EMPTY {
                continue; // Wildcard
            }
            if level < fields.len() {
                let field_idx = fields[level].source_index;
                let record_value = record.values
                    .get(field_idx)
                    .copied()
                    .unwrap_or(VALUE_ID_EMPTY);
                if record_value != gv {
                    return false;
                }
            }
        }
        true
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/// Calculates a tablix view from a definition and cache.
pub fn calculate_tablix(
    definition: &TablixDefinition,
    cache: &mut PivotCache,
) -> TablixView {
    let mut calculator = TablixCalculator::new(definition, cache);
    calculator.calculate()
}
