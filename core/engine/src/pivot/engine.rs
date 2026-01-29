//! FILENAME: core/engine/src/pivot/engine.rs
//! Pivot Engine - The calculation core that transforms data into a renderable view.
//!
//! This module takes a PivotDefinition (configuration) and PivotCache (data)
//! and produces a PivotView (2D grid ready for rendering).
//!
//! Algorithm:
//! 1. Build axis trees from row/column field configurations
//! 2. Flatten trees into ordered lists with hierarchy metadata
//! 3. Cross-tabulate: for each (row, column) intersection, compute aggregates
//! 4. Generate the final PivotView with proper cell types and formatting
//! 5. Add filter rows at the top if filter fields are configured

use std::collections::HashMap;
use crate::pivot::cache::{CacheValue, GroupKey, PivotCache, ValueId, VALUE_ID_EMPTY};
use crate::pivot::definition::{
    AggregationType, FieldIndex, PivotDefinition, PivotField,
    ReportLayout, ValuesPosition,
};
use crate::pivot::view::{
    BackgroundStyle, FilterRowInfo, PivotCellType, PivotColumnDescriptor,
    PivotColumnType, PivotRowDescriptor, PivotRowType, PivotView, PivotViewCell,
};

// ============================================================================
// AXIS TREE STRUCTURES
// ============================================================================

/// A node in the axis tree (row or column hierarchy).
/// Each node represents a unique value at a specific field level.
#[derive(Debug, Clone)]
struct AxisNode {
    /// The interned value ID from the cache.
    value_id: ValueId,
    
    /// The field index this node belongs to.
    field_index: FieldIndex,
    
    /// Display label for this node.
    label: String,
    
    /// Depth in the tree (0 = root level).
    depth: usize,
    
    /// Child nodes (next level of grouping).
    children: Vec<AxisNode>,
    
    /// Whether this node is collapsed (children hidden).
    is_collapsed: bool,
    
    /// Whether to show subtotal for this node.
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
    
    /// Creates a "Total" node for grand totals or subtotals.
    fn total(label: String, depth: usize) -> Self {
        AxisNode {
            value_id: VALUE_ID_EMPTY,
            field_index: 0,
            label,
            depth,
            children: Vec::new(),
            is_collapsed: false,
            show_subtotal: false,
        }
    }
}

/// A flattened representation of an axis node for rendering.
#[derive(Debug, Clone)]
struct FlatAxisItem {
    /// The group key values up to and including this level.
    group_values: Vec<ValueId>,
    
    /// Display label.
    label: String,
    
    /// Depth/indent level.
    depth: usize,
    
    /// Whether this is a subtotal row/column.
    is_subtotal: bool,
    
    /// Whether this is the grand total.
    is_grand_total: bool,
    
    /// Whether this item has children (for expand/collapse).
    has_children: bool,
    
    /// Whether this item is collapsed.
    is_collapsed: bool,
    
    /// Parent index in the flat list (-1 for root).
    parent_index: i32,
    
    /// Field indices involved in this grouping.
    field_indices: Vec<FieldIndex>,
}

// ============================================================================
// PIVOT CALCULATOR
// ============================================================================

/// The main calculation engine for pivot tables.
pub struct PivotCalculator<'a> {
    definition: &'a PivotDefinition,
    cache: &'a mut PivotCache,
    
    /// Flattened row axis items.
    row_items: Vec<FlatAxisItem>,
    
    /// Flattened column axis items.
    col_items: Vec<FlatAxisItem>,
    
    /// Row field indices for aggregate lookups.
    row_field_indices: Vec<FieldIndex>,
    
    /// Column field indices for aggregate lookups.
    col_field_indices: Vec<FieldIndex>,
    
    /// Value field indices for aggregate lookups.
    value_field_indices: Vec<FieldIndex>,
}

impl<'a> PivotCalculator<'a> {
    /// Creates a new calculator instance.
    pub fn new(definition: &'a PivotDefinition, cache: &'a mut PivotCache) -> Self {
        let row_field_indices: Vec<FieldIndex> = definition
            .row_fields
            .iter()
            .map(|f| f.source_index)
            .collect();
        
        let col_field_indices: Vec<FieldIndex> = definition
            .column_fields
            .iter()
            .map(|f| f.source_index)
            .collect();
        
        let value_field_indices: Vec<FieldIndex> = definition
            .value_fields
            .iter()
            .map(|f| f.source_index)
            .collect();
        
        PivotCalculator {
            definition,
            cache,
            row_items: Vec::new(),
            col_items: Vec::new(),
            row_field_indices,
            col_field_indices,
            value_field_indices,
        }
    }
    
    /// Executes the full calculation and returns the rendered view.
    pub fn calculate(&mut self) -> PivotView {
        // Step 1: Apply filters from definition to cache
        self.apply_filters();
        
        // Step 2: Build axis trees
        let row_tree = self.build_axis_tree(&self.definition.row_fields.clone());
        let col_tree = self.build_axis_tree(&self.definition.column_fields.clone());
        
        // Step 3: Flatten trees into ordered lists
        self.row_items = self.flatten_axis_tree(&row_tree, true);
        self.col_items = self.flatten_axis_tree(&col_tree, false);
        
        // Step 4: Handle multiple value fields positioning
        self.apply_values_position();
        
        // Step 5: Generate the view
        self.generate_view()
    }
    
    /// Applies definition filters to the cache.
    fn apply_filters(&mut self) {
        let mut hidden_items: Vec<(FieldIndex, Vec<ValueId>)> = Vec::new();
        
        // Collect hidden items from row fields
        for field in &self.definition.row_fields {
            if !field.hidden_items.is_empty() {
                let hidden_ids = self.resolve_hidden_items(field);
                if !hidden_ids.is_empty() {
                    hidden_items.push((field.source_index, hidden_ids));
                }
            }
        }
        
        // Collect hidden items from column fields
        for field in &self.definition.column_fields {
            if !field.hidden_items.is_empty() {
                let hidden_ids = self.resolve_hidden_items(field);
                if !hidden_ids.is_empty() {
                    hidden_items.push((field.source_index, hidden_ids));
                }
            }
        }
        
        // Collect hidden items from filter fields
        for filter in &self.definition.filter_fields {
            if !filter.field.hidden_items.is_empty() {
                let hidden_ids = self.resolve_hidden_items(&filter.field);
                if !hidden_ids.is_empty() {
                    hidden_items.push((filter.field.source_index, hidden_ids));
                }
            }
        }
        
        // Apply to cache
        self.cache.apply_filters(&hidden_items);
    }
    
    /// Resolves string hidden items to ValueIds.
    fn resolve_hidden_items(&self, field: &PivotField) -> Vec<ValueId> {
        let mut ids = Vec::new();
        
        if let Some(field_cache) = self.cache.fields.get(field.source_index) {
            for hidden_str in &field.hidden_items {
                // Search for matching value in the field cache
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
    
    /// Builds the axis tree for row or column fields.
    fn build_axis_tree(&mut self, fields: &[PivotField]) -> Vec<AxisNode> {
        if fields.is_empty() {
            return Vec::new();
        }
        
        // Get unique values that actually exist in filtered data
        let unique_values = self.collect_unique_values_in_data(fields);
        
        // Build tree recursively
        self.build_tree_level(fields, 0, &unique_values, &[])
    }
    
    /// Collects unique value combinations that exist in the filtered data.
    fn collect_unique_values_in_data(
        &self,
        fields: &[PivotField],
    ) -> Vec<HashMap<ValueId, bool>> {
        let mut unique_per_level: Vec<HashMap<ValueId, bool>> = 
            vec![HashMap::new(); fields.len()];
        
        // Also track valid combinations for hierarchical filtering
        let mut valid_combos: HashMap<Vec<ValueId>, bool> = HashMap::new();
        
        for record in self.cache.filtered_records() {
            let mut combo = Vec::with_capacity(fields.len());
            
            for (level, field) in fields.iter().enumerate() {
                let value_id = record.values
                    .get(field.source_index)
                    .copied()
                    .unwrap_or(VALUE_ID_EMPTY);
                
                unique_per_level[level].insert(value_id, true);
                combo.push(value_id);
            }
            
            // Track full combination
            valid_combos.insert(combo, true);
        }
        
        unique_per_level
    }
    
    /// Recursively builds one level of the axis tree.
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
        
        // Get unique values at this level
        let values_at_level = match unique_values.get(level) {
            Some(v) => v,
            None => return Vec::new(),
        };
        
        // Sort the values based on field's sort order
        let mut sorted_ids: Vec<ValueId> = values_at_level.keys().copied().collect();
        self.sort_value_ids(&mut sorted_ids, field_cache, &field.sort_order);
        
        let mut nodes = Vec::with_capacity(sorted_ids.len());
        
        for value_id in sorted_ids {
            // Get display label
            let label = self.get_value_label(field_cache, value_id);
            
            let mut node = AxisNode::new(value_id, field.source_index, label, level);
            node.is_collapsed = field.collapsed;
            node.show_subtotal = field.show_subtotals && level < fields.len() - 1;
            
            // Build children if not at leaf level
            if level < fields.len() - 1 {
                let mut child_path = parent_path.to_vec();
                child_path.push(value_id);
                
                // Filter unique values for children based on this parent
                let child_unique = self.filter_unique_for_parent(
                    fields,
                    level + 1,
                    &child_path,
                );
                
                node.children = self.build_tree_level(
                    fields,
                    level + 1,
                    &child_unique,
                    &child_path,
                );
            }
            
            nodes.push(node);
        }
        
        nodes
    }
    
    /// Filters unique values that exist under a specific parent path.
    fn filter_unique_for_parent(
        &self,
        fields: &[PivotField],
        start_level: usize,
        parent_path: &[ValueId],
    ) -> Vec<HashMap<ValueId, bool>> {
        let mut unique_per_level: Vec<HashMap<ValueId, bool>> = 
            vec![HashMap::new(); fields.len()];
        
        'records: for record in self.cache.filtered_records() {
            // Check if record matches parent path
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
            
            // Record matches - collect unique values from start_level onwards
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
    
    /// Sorts value IDs based on sort order.
    fn sort_value_ids(
        &self,
        ids: &mut Vec<ValueId>,
        field_cache: &crate::pivot::cache::FieldCache,
        sort_order: &crate::pivot::definition::SortOrder,
    ) {
        use crate::pivot::definition::SortOrder;
        
        match sort_order {
            SortOrder::Ascending => {
                ids.sort_by(|&a, &b| {
                    self.compare_values(field_cache, a, b)
                });
            }
            SortOrder::Descending => {
                ids.sort_by(|&a, &b| {
                    self.compare_values(field_cache, b, a)
                });
            }
            SortOrder::Manual | SortOrder::DataSourceOrder => {
                // Keep original order (order of first appearance)
            }
        }
    }
    
    /// Compares two cache values for sorting.
    fn compare_values(
        &self,
        field_cache: &crate::pivot::cache::FieldCache,
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
            (Some(va), Some(vb)) => {
                match (va, vb) {
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
                }
            }
        }
    }
    
    /// Gets the display label for a value.
    fn get_value_label(
        &self,
        field_cache: &crate::pivot::cache::FieldCache,
        value_id: ValueId,
    ) -> String {
        if value_id == VALUE_ID_EMPTY {
            return "(blank)".to_string();
        }
        
        match field_cache.get_value(value_id) {
            Some(CacheValue::Empty) => "(blank)".to_string(),
            Some(CacheValue::Number(n)) => format!("{}", n.as_f64()),
            Some(CacheValue::Text(s)) => s.clone(),
            Some(CacheValue::Boolean(b)) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Some(CacheValue::Error(e)) => format!("#{}", e),
            None => "(unknown)".to_string(),
        }
    }
    
    /// Flattens the axis tree into an ordered list with hierarchy info.
    fn flatten_axis_tree(&self, tree: &[AxisNode], is_row: bool) -> Vec<FlatAxisItem> {
        let mut items = Vec::new();
        let fields = if is_row {
            &self.definition.row_fields
        } else {
            &self.definition.column_fields
        };
        
        // Flatten with DFS
        self.flatten_nodes(
            tree,
            &mut items,
            &[],
            0,
            -1,
            fields,
            is_row,
        );
        
        // Add grand total if configured
        let show_grand_total = if is_row {
            self.definition.layout.show_row_grand_totals
        } else {
            self.definition.layout.show_column_grand_totals
        };
        
        if show_grand_total {
            let field_count = fields.len();
            items.push(FlatAxisItem {
                group_values: vec![VALUE_ID_EMPTY; field_count],
                label: "Grand Total".to_string(),
                depth: 0,
                is_subtotal: false,
                is_grand_total: true,
                has_children: false,
                is_collapsed: false,
                parent_index: -1,
                field_indices: fields.iter().map(|f| f.source_index).collect(),
            });
        }
        
        items
    }
    
    /// Recursively flattens nodes with DFS traversal.
    fn flatten_nodes(
        &self,
        nodes: &[AxisNode],
        items: &mut Vec<FlatAxisItem>,
        parent_values: &[ValueId],
        depth: usize,
        parent_index: i32,
        fields: &[PivotField],
        _is_row: bool,
    ) {
        for node in nodes {
            let my_index = items.len() as i32;
            
            // Build group values up to this level
            let mut group_values = parent_values.to_vec();
            group_values.push(node.value_id);
            
            // Pad with VALUE_ID_EMPTY for remaining levels (for subtotals)
            let total_levels = fields.len();
            while group_values.len() < total_levels {
                group_values.push(VALUE_ID_EMPTY);
            }
            
            let has_children = !node.children.is_empty();
            
            // Add the main item
            items.push(FlatAxisItem {
                group_values: group_values.clone(),
                label: node.label.clone(),
                depth,
                is_subtotal: false,
                is_grand_total: false,
                has_children,
                is_collapsed: node.is_collapsed,
                parent_index,
                field_indices: fields.iter().map(|f| f.source_index).collect(),
            });
            
            // Recurse into children if not collapsed
            if has_children && !node.is_collapsed {
                let child_parent_values: Vec<ValueId> = parent_values
                    .iter()
                    .chain(std::iter::once(&node.value_id))
                    .copied()
                    .collect();
                
                self.flatten_nodes(
                    &node.children,
                    items,
                    &child_parent_values,
                    depth + 1,
                    my_index,
                    fields,
                    _is_row,
                );
            }
            
            // Add subtotal after children if configured
            if node.show_subtotal && has_children {
                let mut subtotal_values = parent_values.to_vec();
                subtotal_values.push(node.value_id);
                // Mark remaining levels as "all" for subtotal
                while subtotal_values.len() < total_levels {
                    subtotal_values.push(VALUE_ID_EMPTY);
                }
                
                items.push(FlatAxisItem {
                    group_values: subtotal_values,
                    label: format!("{} Total", node.label),
                    depth,
                    is_subtotal: true,
                    is_grand_total: false,
                    has_children: false,
                    is_collapsed: false,
                    parent_index: my_index,
                    field_indices: fields.iter().map(|f| f.source_index).collect(),
                });
            }
        }
    }
    
    /// Handles ValuesPosition (multiple value fields as rows or columns).
    fn apply_values_position(&mut self) {
        let value_count = self.definition.value_fields.len();
        
        if value_count <= 1 {
            return; // No need to add extra axis items for single value field
        }
        
        let value_fields = self.definition.value_fields.clone();
        
        match self.definition.layout.values_position {
            ValuesPosition::Columns => {
                // Value fields become innermost columns
                expand_axis_for_values(&mut self.col_items, &value_fields);
            }
            ValuesPosition::Rows => {
                // Value fields become innermost rows
                expand_axis_for_values(&mut self.row_items, &value_fields);
            }
        }
    }
    
    /// Generates the final PivotView.
    fn generate_view(&mut self) -> PivotView {
        let mut view = PivotView::new(self.definition.id);
        view.version = self.definition.version;
        
        // Determine layout dimensions
        let row_label_cols = self.calculate_row_label_columns();
        let col_header_rows = self.calculate_column_header_rows();
        
        view.row_label_col_count = row_label_cols;
        view.column_header_row_count = col_header_rows;
        
        // Generate column descriptors
        let col_descriptors = self.generate_column_descriptors(row_label_cols);
        view.set_columns(col_descriptors);
        
        // Generate filter rows first (at the top)
        let filter_row_count = self.generate_filter_rows(&mut view, row_label_cols);
        view.filter_row_count = filter_row_count;
        
        // Generate column header rows
        self.generate_column_headers(&mut view, row_label_cols, col_header_rows);
        
        // Generate data rows
        self.generate_data_rows(&mut view, row_label_cols);
        
        // Update column_header_row_count to include filter rows
        view.column_header_row_count = col_header_rows + filter_row_count;
        
        view
    }
    
    /// Generates filter rows at the top of the pivot view.
    /// Returns the number of filter rows generated (including spacing row).
    fn generate_filter_rows(&mut self, view: &mut PivotView, row_label_cols: usize) -> usize {
        let filter_fields = &self.definition.filter_fields;

        if filter_fields.is_empty() {
            return 0;
        }

        let total_cols = view.col_count.max(row_label_cols + 1);

        for (filter_idx, filter) in filter_fields.iter().enumerate() {
            let field_index = filter.field.source_index;
            let field_name = filter.field.name.clone();

            // Collect unique values for this filter field
            let unique_values = self.collect_unique_values_for_field(field_index);

            // Determine which values are selected (not hidden)
            let hidden_items = &filter.field.hidden_items;
            let selected_values: Vec<String> = unique_values
                .iter()
                .filter(|v| !hidden_items.contains(v))
                .cloned()
                .collect();

            // Generate display value for the dropdown
            let display_value = if hidden_items.is_empty() || selected_values.len() == unique_values.len() {
                "(All)".to_string()
            } else if selected_values.len() == 1 {
                selected_values[0].clone()
            } else if selected_values.is_empty() {
                "(None)".to_string()
            } else {
                format!("({} items)", selected_values.len())
            };

            // Create filter row info
            let filter_info = FilterRowInfo {
                field_index,
                field_name: field_name.clone(),
                selected_values: selected_values.clone(),
                unique_values: unique_values.clone(),
                display_value: display_value.clone(),
                view_row: filter_idx,
            };
            view.filter_rows.push(filter_info);

            // Build the row cells
            let mut cells = Vec::with_capacity(total_cols);

            // First cell: filter label
            let mut label_cell = PivotViewCell::filter_label(
                format!("{}:", field_name),
                field_index,
            );
            label_cell.background_style = BackgroundStyle::FilterRow;
            cells.push(label_cell);

            // Second cell: filter dropdown (spans remaining row label columns if any)
            let mut dropdown_cell = PivotViewCell::filter_dropdown(display_value, field_index);
            dropdown_cell.background_style = BackgroundStyle::FilterRow;
            if row_label_cols > 1 {
                dropdown_cell.col_span = (row_label_cols - 1) as u16;
            }
            cells.push(dropdown_cell);

            // Fill remaining columns with blank cells
            for _ in 2..total_cols {
                let mut blank = PivotViewCell::blank();
                blank.background_style = BackgroundStyle::FilterRow;
                cells.push(blank);
            }

            // Ensure we have exactly total_cols cells
            while cells.len() < total_cols {
                let mut blank = PivotViewCell::blank();
                blank.background_style = BackgroundStyle::FilterRow;
                cells.push(blank);
            }

            let descriptor = PivotRowDescriptor {
                view_row: filter_idx,
                row_type: PivotRowType::FilterRow,
                depth: 0,
                visible: true,
                parent_index: None,
                children_indices: Vec::new(),
                group_values: Vec::new(),
            };

            view.add_row(cells, descriptor);
        }

        // Add a spacing row after filters to separate from column headers
        let spacing_row_idx = filter_fields.len();
        let mut spacing_cells = Vec::with_capacity(total_cols);
        for _ in 0..total_cols {
            spacing_cells.push(PivotViewCell::blank());
        }

        let spacing_descriptor = PivotRowDescriptor {
            view_row: spacing_row_idx,
            row_type: PivotRowType::FilterRow, // Treat as part of filter area
            depth: 0,
            visible: true,
            parent_index: None,
            children_indices: Vec::new(),
            group_values: Vec::new(),
        };

        view.add_row(spacing_cells, spacing_descriptor);

        // Return filter count + 1 for the spacing row
        filter_fields.len() + 1
    }
    
    /// Collects all unique values for a field as display strings.
    fn collect_unique_values_for_field(&self, field_index: FieldIndex) -> Vec<String> {
        let mut values = Vec::new();
        
        if let Some(field_cache) = self.cache.fields.get(field_index) {
            for id in 0..field_cache.unique_count() as ValueId {
                let label = self.get_value_label(field_cache, id);
                values.push(label);
            }
        }
        
        values
    }
    
    /// Calculates how many columns are needed for row labels.
    fn calculate_row_label_columns(&self) -> usize {
        match self.definition.layout.report_layout {
            ReportLayout::Compact => {
                // All row fields in one column
                1.max(if self.definition.row_fields.is_empty() { 0 } else { 1 })
            }
            ReportLayout::Outline | ReportLayout::Tabular => {
                // Each row field gets its own column
                self.definition.row_fields.len().max(1)
            }
        }
    }
    
    /// Calculates how many rows are needed for column headers.
    fn calculate_column_header_rows(&self) -> usize {
        if self.definition.column_fields.is_empty() {
            // Just one row for value field names
            1
        } else {
            // One row per column field level, plus one for values if multiple
            let base = self.definition.column_fields.len();
            if self.definition.value_fields.len() > 1 
                && matches!(self.definition.layout.values_position, ValuesPosition::Columns) {
                base + 1
            } else {
                base.max(1)
            }
        }
    }
    
    /// Generates column descriptors.
    fn generate_column_descriptors(&self, row_label_cols: usize) -> Vec<PivotColumnDescriptor> {
        let mut descriptors = Vec::new();
        
        // Row label columns
        for i in 0..row_label_cols {
            descriptors.push(PivotColumnDescriptor {
                view_col: i,
                col_type: PivotColumnType::RowLabel,
                depth: 0,
                width_hint: 120,
                parent_index: None,
                children_indices: Vec::new(),
                group_values: Vec::new(),
            });
        }
        
        // Data columns
        if self.col_items.is_empty() {
            // No column fields - one column per value field (or one blank column if no values)
            if self.definition.value_fields.is_empty() {
                // No value fields - add a single blank data column
                descriptors.push(PivotColumnDescriptor {
                    view_col: row_label_cols,
                    col_type: PivotColumnType::Data,
                    depth: 0,
                    width_hint: 100,
                    parent_index: None,
                    children_indices: Vec::new(),
                    group_values: Vec::new(),
                });
            } else {
                for (i, _vf) in self.definition.value_fields.iter().enumerate() {
                    let col_idx = row_label_cols + i;
                    descriptors.push(PivotColumnDescriptor {
                        view_col: col_idx,
                        col_type: PivotColumnType::Data,
                        depth: 0,
                        width_hint: 100,
                        parent_index: None,
                        children_indices: Vec::new(),
                        group_values: vec![i as ValueId],
                    });
                }
            }
        } else {
            // Generate from column items
            for (i, item) in self.col_items.iter().enumerate() {
                let col_idx = row_label_cols + i;
                let col_type = if item.is_grand_total {
                    PivotColumnType::GrandTotal
                } else if item.is_subtotal {
                    PivotColumnType::Subtotal
                } else {
                    PivotColumnType::Data
                };
                
                descriptors.push(PivotColumnDescriptor {
                    view_col: col_idx,
                    col_type,
                    depth: item.depth as u8,
                    width_hint: 100,
                    parent_index: if item.parent_index >= 0 {
                        Some((row_label_cols as i32 + item.parent_index) as usize)
                    } else {
                        None
                    },
                    children_indices: Vec::new(),
                    group_values: item.group_values.clone(),
                });
            }
        }
        
        descriptors
    }
    
    /// Generates column header rows.
    fn generate_column_headers(
        &mut self,
        view: &mut PivotView,
        row_label_cols: usize,
        col_header_rows: usize,
    ) {
        let filter_row_offset = view.filter_row_count;
        
        for header_row in 0..col_header_rows {
            let mut cells = Vec::new();
            
            // Corner cells (row label column headers)
            for col in 0..row_label_cols {
                if header_row == col_header_rows - 1 {
                    // Last header row - show row field names
                    let label = match self.definition.layout.report_layout {
                        ReportLayout::Compact => {
                            // Combine all row field names
                            self.definition.row_fields
                                .iter()
                                .map(|f| f.name.as_str())
                                .collect::<Vec<_>>()
                                .join(" / ")
                        }
                        ReportLayout::Outline | ReportLayout::Tabular => {
                            self.definition.row_fields
                                .get(col)
                                .map(|f| f.name.clone())
                                .unwrap_or_default()
                        }
                    };
                    cells.push(PivotViewCell::column_header(label));
                } else {
                    cells.push(PivotViewCell::corner());
                }
            }
            
            // Column header cells
            if self.col_items.is_empty() {
                // No column fields - show value field names (or blank if no values)
                if self.definition.value_fields.is_empty() {
                    // No value fields - add blank header
                    if header_row == col_header_rows - 1 {
                        cells.push(PivotViewCell::column_header(String::new()));
                    } else {
                        cells.push(PivotViewCell::corner());
                    }
                } else {
                    for vf in &self.definition.value_fields {
                        if header_row == col_header_rows - 1 {
                            cells.push(PivotViewCell::column_header(vf.name.clone()));
                        } else {
                            cells.push(PivotViewCell::corner());
                        }
                    }
                }
            } else {
                // Show column field values at appropriate level
                for item in &self.col_items {
                    let cell = if item.depth == header_row {
                        PivotViewCell::column_header(item.label.clone())
                    } else if item.depth > header_row {
                        // Parent level - might need spanning
                        PivotViewCell::corner()
                    } else {
                        PivotViewCell::blank()
                    };
                    cells.push(cell);
                }
            }
            
            let descriptor = PivotRowDescriptor {
                view_row: filter_row_offset + header_row,
                row_type: PivotRowType::ColumnHeader,
                depth: 0,
                visible: true,
                parent_index: None,
                children_indices: Vec::new(),
                group_values: Vec::new(),
            };
            
            view.add_row(cells, descriptor);
        }
    }
    
    /// Generates data rows from row items.
    fn generate_data_rows(&mut self, view: &mut PivotView, row_label_cols: usize) {
        if self.row_items.is_empty() {
            // No row fields - generate single data row (grand total only)
            self.generate_single_data_row(view, row_label_cols);
            return;
        }
        
        // Clone what we need to avoid borrow conflicts
        let row_items = self.row_items.clone();
        let report_layout = self.definition.layout.report_layout;
        let repeat_row_labels = self.definition.layout.repeat_row_labels;
        let base_row_offset = view.row_count;
        
        for (row_idx, item) in row_items.iter().enumerate() {
            let view_row = view.row_count;
            let mut cells = Vec::new();
            
            // Generate row label cells
            match report_layout {
                ReportLayout::Compact => {
                    let mut cell = PivotViewCell::row_header(
                        item.label.clone(),
                        item.depth as u8,
                    );
                    cell.is_expandable = item.has_children;
                    cell.is_collapsed = item.is_collapsed;
                    
                    if item.is_subtotal {
                        cell = cell.as_total();
                        cell.cell_type = PivotCellType::RowSubtotal;
                    } else if item.is_grand_total {
                        cell = cell.as_total();
                        cell.cell_type = PivotCellType::GrandTotalRow;
                    }
                    
                    cells.push(cell);
                }
                ReportLayout::Outline | ReportLayout::Tabular => {
                    for col in 0..row_label_cols {
                        if col == item.depth {
                            let mut cell = PivotViewCell::row_header(
                                item.label.clone(),
                                0, // No indent in tabular
                            );
                            cell.is_expandable = item.has_children;
                            cell.is_collapsed = item.is_collapsed;
                            
                            if item.is_subtotal || item.is_grand_total {
                                cell = cell.as_total();
                            }
                            
                            cells.push(cell);
                        } else if col < item.depth 
                            && repeat_row_labels
                            && matches!(report_layout, ReportLayout::Tabular) {
                            // Repeat parent labels in tabular layout
                            let parent_label = self.get_parent_label_at_depth(&row_items, row_idx, col);
                            cells.push(PivotViewCell::row_header(parent_label, 0));
                        } else {
                            cells.push(PivotViewCell::blank());
                        }
                    }
                }
            }
            
            // Generate data cells
            self.generate_data_cells_for_row(&mut cells, item);
            
            // Create row descriptor
            let row_type = if item.is_grand_total {
                PivotRowType::GrandTotal
            } else if item.is_subtotal {
                PivotRowType::Subtotal
            } else {
                PivotRowType::Data
            };
            
            let descriptor = PivotRowDescriptor {
                view_row,
                row_type,
                depth: item.depth as u8,
                visible: true,
                parent_index: if item.parent_index >= 0 {
                    Some((base_row_offset as i32 + item.parent_index) as usize)
                } else {
                    None
                },
                children_indices: Vec::new(),
                group_values: item.group_values.clone(),
            };
            
            view.add_row(cells, descriptor);
        }
    }
    
    /// Gets parent label at a specific depth for tabular layout.
    fn get_parent_label_at_depth(&self, row_items: &[FlatAxisItem], current_idx: usize, depth: usize) -> String {
        // Walk up the parent chain to find label at depth
        let mut idx = current_idx;
        while idx > 0 {
            let item = &row_items[idx];
            if item.depth == depth {
                return item.label.clone();
            }
            if item.parent_index >= 0 && (item.parent_index as usize) < idx {
                idx = item.parent_index as usize;
            } else {
                break;
            }
        }
        String::new()
    }
    
    /// Generates a single data row when there are no row fields.
    fn generate_single_data_row(&mut self, view: &mut PivotView, row_label_cols: usize) {
        let mut cells = Vec::new();
        
        // Row label (just "Total" or empty)
        for _ in 0..row_label_cols {
            let mut cell = PivotViewCell::row_header("Total".to_string(), 0);
            cell = cell.as_total();
            cells.push(cell);
        }
        
        // Create a grand total row item
        let grand_total_item = FlatAxisItem {
            group_values: vec![VALUE_ID_EMPTY; self.row_field_indices.len().max(1)],
            label: "Total".to_string(),
            depth: 0,
            is_subtotal: false,
            is_grand_total: true,
            has_children: false,
            is_collapsed: false,
            parent_index: -1,
            field_indices: self.row_field_indices.clone(),
        };
        
        self.generate_data_cells_for_row(&mut cells, &grand_total_item);
        
        let descriptor = PivotRowDescriptor {
            view_row: view.row_count,
            row_type: PivotRowType::GrandTotal,
            depth: 0,
            visible: true,
            parent_index: None,
            children_indices: Vec::new(),
            group_values: grand_total_item.group_values,
        };
        
        view.add_row(cells, descriptor);
    }
    
    /// Generates data cells for a row by iterating through columns.
    fn generate_data_cells_for_row(&mut self, cells: &mut Vec<PivotViewCell>, row_item: &FlatAxisItem) {
        // Clone col_items to avoid borrow conflicts
        let col_items = self.col_items.clone();
        let value_fields = self.definition.value_fields.clone();
        let values_position = self.definition.layout.values_position;
        
        // Handle case with no value fields - generate blank cells
        if value_fields.is_empty() {
            if col_items.is_empty() {
                // No columns and no values - add one blank cell
                cells.push(PivotViewCell::blank());
            } else {
                // Generate blank cells for each column
                for _ in &col_items {
                    cells.push(PivotViewCell::blank());
                }
            }
            return;
        }
        
        if col_items.is_empty() {
            // No column fields - one cell per value field
            for (vf_idx, vf) in value_fields.iter().enumerate() {
                let aggregate = self.compute_aggregate(
                    &row_item.group_values,
                    &[], // No column grouping
                    vf_idx,
                    vf.aggregation,
                );
                
                let mut cell = PivotViewCell::data(aggregate);
                cell.number_format = vf.number_format.clone();
                
                if row_item.is_subtotal {
                    cell.cell_type = PivotCellType::RowSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                } else if row_item.is_grand_total {
                    cell.cell_type = PivotCellType::GrandTotal;
                    cell.background_style = BackgroundStyle::GrandTotal;
                    cell.is_bold = true;
                }
                
                cells.push(cell);
            }
        } else {
            // Generate cell for each column item
            for col_item in &col_items {
                // Determine which value field this column represents
                let (vf_idx, col_group_values) = extract_value_field_from_column(
                    col_item,
                    value_fields.len(),
                    values_position,
                );
                
                // Safety check: ensure vf_idx is valid
                let vf_idx = vf_idx.min(value_fields.len().saturating_sub(1));
                
                let vf = &value_fields[vf_idx];
                
                let aggregate = self.compute_aggregate(
                    &row_item.group_values,
                    &col_group_values,
                    vf_idx,
                    vf.aggregation,
                );
                
                let mut cell = PivotViewCell::data(aggregate);
                cell.number_format = vf.number_format.clone();
                
                // Determine cell type and styling
                let is_row_total = row_item.is_subtotal || row_item.is_grand_total;
                let is_col_total = col_item.is_subtotal || col_item.is_grand_total;
                
                if row_item.is_grand_total && col_item.is_grand_total {
                    cell.cell_type = PivotCellType::GrandTotal;
                    cell.background_style = BackgroundStyle::GrandTotal;
                    cell.is_bold = true;
                } else if row_item.is_grand_total {
                    cell.cell_type = PivotCellType::GrandTotalRow;
                    cell.background_style = BackgroundStyle::Total;
                    cell.is_bold = true;
                } else if col_item.is_grand_total {
                    cell.cell_type = PivotCellType::GrandTotalColumn;
                    cell.background_style = BackgroundStyle::Total;
                    cell.is_bold = true;
                } else if is_row_total && is_col_total {
                    cell.cell_type = PivotCellType::RowSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                    cell.is_bold = true;
                } else if is_row_total {
                    cell.cell_type = PivotCellType::RowSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                } else if is_col_total {
                    cell.cell_type = PivotCellType::ColumnSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                }
                
                // Set group path for drill-down
                let mut group_path = Vec::new();
                for (i, &val) in row_item.group_values.iter().enumerate() {
                    if val != VALUE_ID_EMPTY && i < row_item.field_indices.len() {
                        group_path.push((row_item.field_indices[i], val));
                    }
                }
                for (i, &val) in col_group_values.iter().enumerate() {
                    if val != VALUE_ID_EMPTY && i < col_item.field_indices.len() {
                        group_path.push((col_item.field_indices[i], val));
                    }
                }
                cell.group_path = group_path;
                
                cells.push(cell);
            }
        }
    }
    
    /// Computes the aggregate value for a row/column intersection.
    fn compute_aggregate(
        &mut self,
        row_values: &[ValueId],
        col_values: &[ValueId],
        value_field_idx: usize,
        aggregation: AggregationType,
    ) -> f64 {
        // Build the full group key
        let mut key_values = row_values.to_vec();
        key_values.extend_from_slice(col_values);
        
        // Pad to expected length
        let expected_len = self.row_field_indices.len() + self.col_field_indices.len();
        while key_values.len() < expected_len {
            key_values.push(VALUE_ID_EMPTY);
        }
        
        // Truncate if too long (can happen with value field dimension)
        if key_values.len() > expected_len {
            key_values.truncate(expected_len);
        }
        
        let group_key = GroupKey::new(key_values);
        
        // Query cache for pre-computed aggregate
        if let Some(accumulators) = self.cache.get_aggregate(
            &group_key,
            &self.row_field_indices,
            &self.col_field_indices,
            &self.value_field_indices,
        ) {
            if let Some(acc) = accumulators.get(value_field_idx) {
                return acc.compute(aggregation);
            }
        }
        
        0.0
    }
}

// ============================================================================
// HELPER FUNCTIONS (outside impl to avoid borrow issues)
// ============================================================================

/// Expands axis items to include value field dimension.
fn expand_axis_for_values(
    items: &mut Vec<FlatAxisItem>,
    value_fields: &[crate::pivot::definition::ValueField],
) {
    // Early return if no value fields
    if value_fields.is_empty() {
        return;
    }
    
    if items.is_empty() {
        // No axis items - create items just for value fields
        for (i, vf) in value_fields.iter().enumerate() {
            items.push(FlatAxisItem {
                group_values: vec![i as ValueId], // Use value field index as pseudo-ID
                label: vf.name.clone(),
                depth: 0,
                is_subtotal: false,
                is_grand_total: false,
                has_children: false,
                is_collapsed: false,
                parent_index: -1,
                field_indices: vec![vf.source_index],
            });
        }
        return;
    }
    
    // For each existing item, create copies for each value field
    let original_items = std::mem::take(items);
    
    for item in original_items {
        if item.is_grand_total || item.is_subtotal {
            // For totals, add value field variants
            for (i, vf) in value_fields.iter().enumerate() {
                let mut new_item = item.clone();
                new_item.group_values.push(i as ValueId);
                new_item.label = if item.is_grand_total {
                    format!("Grand Total - {}", vf.name)
                } else {
                    format!("{} - {}", item.label, vf.name)
                };
                items.push(new_item);
            }
        } else if !item.has_children || item.is_collapsed {
            // Leaf items or collapsed items get value field children
            for (i, vf) in value_fields.iter().enumerate() {
                let mut new_item = item.clone();
                new_item.group_values.push(i as ValueId);
                new_item.label = vf.name.clone();
                new_item.depth += 1;
                new_item.has_children = false;
                items.push(new_item);
            }
        } else {
            // Non-leaf items - keep as is
            items.push(item);
        }
    }
}

/// Extracts value field index and column grouping from a column item.
fn extract_value_field_from_column(
    col_item: &FlatAxisItem,
    value_count: usize,
    values_position: ValuesPosition,
) -> (usize, Vec<ValueId>) {
    // Handle empty value fields case
    if value_count == 0 {
        return (0, col_item.group_values.clone());
    }
    
    if value_count == 1 {
        // Single value field - use index 0
        return (0, col_item.group_values.clone());
    }
    
    if matches!(values_position, ValuesPosition::Columns) {
        // Last element of group_values is the value field index
        if let Some(&last) = col_item.group_values.last() {
            let vf_idx = (last as usize).min(value_count - 1);
            let col_groups = col_item.group_values[..col_item.group_values.len() - 1].to_vec();
            return (vf_idx, col_groups);
        }
    }
    
    (0, col_item.group_values.clone())
}

// ============================================================================
// PUBLIC API
// ============================================================================

/// Calculates a pivot table view from definition and cache.
/// This is the main entry point for the calculation engine.
pub fn calculate_pivot(
    definition: &PivotDefinition,
    cache: &mut PivotCache,
) -> PivotView {
    let mut calculator = PivotCalculator::new(definition, cache);
    calculator.calculate()
}

/// Performs a drill-down operation to get source records for a cell.
pub fn drill_down(
    definition: &PivotDefinition,
    cache: &PivotCache,
    group_path: &[(usize, ValueId)],
    max_records: usize,
) -> crate::pivot::view::DrillDownResult {
    let mut result = crate::pivot::view::DrillDownResult::new(
        definition.id,
        group_path.to_vec(),
    );
    result.max_records = max_records;
    
    // Set headers from source fields
    result.headers = cache.fields
        .iter()
        .map(|f| f.name.clone())
        .collect();
    
    // Find matching records
    let mut count = 0;
    for record in cache.filtered_records() {
        // Check if record matches all group path filters
        let matches = group_path.iter().all(|(field_idx, value_id)| {
            record.values.get(*field_idx)
                .copied()
                .unwrap_or(VALUE_ID_EMPTY) == *value_id
        });
        
        if matches {
            count += 1;
            if result.source_rows.len() < max_records {
                result.source_rows.push(record.source_row);
            }
        }
    }
    
    result.total_count = count;
    result.is_truncated = count > max_records;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::CellValue;
    use crate::pivot::definition::{PivotField, ValueField, AggregationType};
    
    fn create_test_cache() -> PivotCache {
        let mut cache = PivotCache::new(1, 3);
        cache.set_field_name(0, "Region".to_string());
        cache.set_field_name(1, "Product".to_string());
        cache.set_field_name(2, "Sales".to_string());
        
        // Add test data
        cache.add_record(0, &[
            CellValue::Text("North".to_string()),
            CellValue::Text("Apples".to_string()),
            CellValue::Number(100.0),
        ]);
        cache.add_record(1, &[
            CellValue::Text("North".to_string()),
            CellValue::Text("Oranges".to_string()),
            CellValue::Number(150.0),
        ]);
        cache.add_record(2, &[
            CellValue::Text("South".to_string()),
            CellValue::Text("Apples".to_string()),
            CellValue::Number(200.0),
        ]);
        cache.add_record(3, &[
            CellValue::Text("South".to_string()),
            CellValue::Text("Oranges".to_string()),
            CellValue::Number(250.0),
        ]);
        
        cache
    }
    
    fn create_test_definition() -> PivotDefinition {
        let mut def = PivotDefinition::new(1, (0, 0), (4, 2));
        
        def.row_fields.push(PivotField::new(0, "Region".to_string()));
        def.column_fields.push(PivotField::new(1, "Product".to_string()));
        def.value_fields.push(ValueField::new(2, "Sum of Sales".to_string(), AggregationType::Sum));
        
        def
    }
    
    #[test]
    fn test_basic_pivot_calculation() {
        let mut cache = create_test_cache();
        let definition = create_test_definition();
        
        let view = calculate_pivot(&definition, &mut cache);
        
        // Should have header rows + 2 regions + grand total
        assert!(view.row_count > 0);
        assert!(view.col_count > 0);
    }
    
    #[test]
    fn test_no_row_fields() {
        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        definition.row_fields.clear();
        
        let view = calculate_pivot(&definition, &mut cache);
        
        // Should still produce a view with grand total
        assert!(view.row_count > 0);
    }
    
    #[test]
    fn test_no_column_fields() {
        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        definition.column_fields.clear();
        
        let view = calculate_pivot(&definition, &mut cache);
        
        // Should produce rows with single value column
        assert!(view.row_count > 0);
        assert!(view.col_count >= 2); // Row label + value
    }
    
    #[test]
    fn test_no_value_fields() {
        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        definition.value_fields.clear();
        
        let view = calculate_pivot(&definition, &mut cache);
        
        // Should produce a view without panicking
        assert!(view.row_count > 0);
        assert!(view.col_count >= 1);
    }
    
    #[test]
    fn test_no_value_fields_with_columns() {
        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        definition.value_fields.clear();
        // Keep column_fields
        
        let view = calculate_pivot(&definition, &mut cache);
        
        // Should produce a view without panicking
        assert!(view.row_count > 0);
    }
    
    #[test]
    fn test_filter_rows_generation() {
        use crate::pivot::definition::{PivotFilter, FilterCondition, FilterValue};
        
        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        
        // Add a filter field
        definition.filter_fields.push(PivotFilter {
            field: PivotField::new(0, "Region".to_string()),
            condition: FilterCondition::ValueList(vec![
                FilterValue::Text("North".to_string()),
            ]),
        });
        
        let view = calculate_pivot(&definition, &mut cache);
        
        // Should have filter rows
        assert_eq!(view.filter_row_count, 1);
        assert_eq!(view.filter_rows.len(), 1);
        assert_eq!(view.filter_rows[0].field_name, "Region");
    }
}