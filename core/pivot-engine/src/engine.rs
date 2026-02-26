//! FILENAME: core/pivot-engine/src/engine.rs
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
use crate::cache::{
    CacheValue, GroupKey, OrderedFloat, PivotCache, ValueId, VALUE_ID_EMPTY,
    parse_cache_value_as_date,
};
use crate::definition::{
    AggregationType, DateGroupLevel, FieldGrouping, FieldIndex, ManualGroup,
    PivotDefinition, PivotField, ReportLayout, ShowValuesAs, SubtotalLocation,
    ValuesPosition,
};
use crate::view::{
    BackgroundStyle, FilterRowInfo, HeaderFieldSummary, PivotCellType,
    PivotColumnDescriptor, PivotColumnType, PivotRowDescriptor, PivotRowType,
    PivotView, PivotViewCell,
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

    /// Row field indices for aggregate lookups (updated after grouping transforms).
    row_field_indices: Vec<FieldIndex>,

    /// Column field indices for aggregate lookups (updated after grouping transforms).
    col_field_indices: Vec<FieldIndex>,

    /// Value field indices for aggregate lookups.
    value_field_indices: Vec<FieldIndex>,

    /// Effective row fields after grouping transforms.
    /// Date grouping expands one field into multiple (Year, Quarter, Month).
    /// Manual grouping inserts a parent group field before the original.
    effective_row_fields: Vec<PivotField>,

    /// Effective column fields after grouping transforms.
    effective_col_fields: Vec<PivotField>,

    /// Pre-computed grand totals for each value field (for show_values_as).
    grand_totals: Vec<f64>,
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
            effective_row_fields: Vec::new(),
            effective_col_fields: Vec::new(),
            grand_totals: Vec::new(),
        }
    }
    
    /// Executes the full calculation and returns the rendered view.
    pub fn calculate(&mut self) -> PivotView {
        // Step 1: Apply filters from definition to cache
        self.apply_filters();

        // Step 1.5: Apply grouping transforms (creates virtual fields in cache)
        self.apply_grouping_transforms();

        // Step 2: Build axis trees (using effective fields with virtual field indices)
        let row_fields = self.effective_row_fields.clone();
        let col_fields = self.effective_col_fields.clone();
        let row_tree = self.build_axis_tree(&row_fields);
        let col_tree = self.build_axis_tree(&col_fields);

        // Step 3: Flatten trees into ordered lists
        self.row_items = self.flatten_axis_tree(&row_tree, true);
        self.col_items = self.flatten_axis_tree(&col_tree, false);

        // Step 4: Handle multiple value fields positioning
        self.apply_values_position();

        // Step 4.5: Pre-compute grand totals for show_values_as
        self.precompute_grand_totals();

        // Step 5: Generate the view
        self.generate_view()
    }

    /// Pre-computes grand totals for each value field (used by show_values_as).
    fn precompute_grand_totals(&mut self) {
        self.grand_totals = self.definition.value_fields.iter().enumerate().map(|(vf_idx, vf)| {
            self.compute_aggregate(&[], &[], vf_idx, vf.aggregation)
        }).collect();
    }

    /// Applies the show_values_as transformation to a raw aggregate value.
    fn transform_show_values_as(
        &mut self,
        value: f64,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
        show_as: ShowValuesAs,
    ) -> f64 {
        match show_as {
            ShowValuesAs::Normal => value,
            ShowValuesAs::PercentOfGrandTotal => {
                let gt = self.grand_totals.get(vf_idx).copied().unwrap_or(0.0);
                if gt != 0.0 { value / gt } else { 0.0 }
            }
            ShowValuesAs::PercentOfRowTotal => {
                // Row total = aggregate for this row across all columns
                let row_total = self.compute_aggregate(row_values, &[], vf_idx, aggregation);
                if row_total != 0.0 { value / row_total } else { 0.0 }
            }
            ShowValuesAs::PercentOfColumnTotal => {
                // Column total = aggregate for this column across all rows
                let col_total = self.compute_aggregate(&[], col_values, vf_idx, aggregation);
                if col_total != 0.0 { value / col_total } else { 0.0 }
            }
            ShowValuesAs::PercentOfParentRow => {
                // Parent row total: remove the deepest row grouping level
                if row_values.len() > 1 {
                    let parent_row = &row_values[..row_values.len() - 1];
                    let parent_total = self.compute_aggregate(parent_row, col_values, vf_idx, aggregation);
                    if parent_total != 0.0 { value / parent_total } else { 0.0 }
                } else {
                    // No parent - use grand total across columns
                    let gt = self.compute_aggregate(&[], col_values, vf_idx, aggregation);
                    if gt != 0.0 { value / gt } else { 0.0 }
                }
            }
            ShowValuesAs::PercentOfParentColumn => {
                // Parent column total: remove the deepest column grouping level
                if col_values.len() > 1 {
                    let parent_col = &col_values[..col_values.len() - 1];
                    let parent_total = self.compute_aggregate(row_values, parent_col, vf_idx, aggregation);
                    if parent_total != 0.0 { value / parent_total } else { 0.0 }
                } else {
                    // No parent - use grand total across rows
                    let gt = self.compute_aggregate(row_values, &[], vf_idx, aggregation);
                    if gt != 0.0 { value / gt } else { 0.0 }
                }
            }
            ShowValuesAs::Index => {
                // Index = (cell * grand_total) / (row_total * col_total)
                let gt = self.grand_totals.get(vf_idx).copied().unwrap_or(0.0);
                let row_total = self.compute_aggregate(row_values, &[], vf_idx, aggregation);
                let col_total = self.compute_aggregate(&[], col_values, vf_idx, aggregation);
                let denominator = row_total * col_total;
                if denominator != 0.0 { (value * gt) / denominator } else { 0.0 }
            }
            // Difference and RunningTotal require base field/item context
            // which we don't have yet - return value unchanged for now
            ShowValuesAs::Difference | ShowValuesAs::PercentDifference | ShowValuesAs::RunningTotal => value,
        }
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

    // ========================================================================
    // GROUPING TRANSFORMS
    // ========================================================================

    /// Applies grouping transforms to row and column fields, creating virtual fields in the cache.
    /// Populates `effective_row_fields` and `effective_col_fields` with the transformed field lists,
    /// and updates `row_field_indices` / `col_field_indices` to match.
    fn apply_grouping_transforms(&mut self) {
        self.cache.clear_virtual_fields();

        let row_fields = self.definition.row_fields.clone();
        let col_fields = self.definition.column_fields.clone();

        self.effective_row_fields = self.transform_field_list_for_grouping(&row_fields);
        self.effective_col_fields = self.transform_field_list_for_grouping(&col_fields);

        // Update field indices to match effective fields
        self.row_field_indices = self.effective_row_fields.iter().map(|f| f.source_index).collect();
        self.col_field_indices = self.effective_col_fields.iter().map(|f| f.source_index).collect();
    }

    /// Transforms a list of fields, expanding any that have grouping configuration.
    fn transform_field_list_for_grouping(&mut self, fields: &[PivotField]) -> Vec<PivotField> {
        let mut effective = Vec::new();

        for field in fields {
            match &field.grouping {
                FieldGrouping::None => {
                    effective.push(field.clone());
                }
                FieldGrouping::DateGrouping { levels } => {
                    let levels = levels.clone();
                    self.apply_date_grouping_transform(field, &levels, &mut effective);
                }
                FieldGrouping::NumberBinning { start, end, interval } => {
                    let (s, e, i) = (*start, *end, *interval);
                    self.apply_number_binning_transform(field, s, e, i, &mut effective);
                }
                FieldGrouping::ManualGrouping { groups, ungrouped_name } => {
                    let groups = groups.clone();
                    let ungrouped = ungrouped_name.clone();
                    self.apply_manual_grouping_transform(field, &groups, &ungrouped, &mut effective);
                }
            }
        }

        effective
    }

    /// Applies date grouping: creates virtual fields for each date level (Year, Quarter, Month, etc.).
    /// Replaces the original field with one or more virtual fields in the effective list.
    fn apply_date_grouping_transform(
        &mut self,
        field: &PivotField,
        levels: &[DateGroupLevel],
        effective: &mut Vec<PivotField>,
    ) {
        if levels.is_empty() {
            effective.push(field.clone());
            return;
        }

        let base_field_count = self.cache.fields.len();

        // Create virtual fields for each date level
        let mut vf_info: Vec<(DateGroupLevel, usize, usize)> = Vec::new();
        for &level in levels {
            let name = format_date_level_name(&field.name, level);
            let vf_idx = self.cache.add_virtual_field(name);
            let effective_index = base_field_count + vf_idx;
            vf_info.push((level, vf_idx, effective_index));
        }

        // First pass: collect parsed dates from all records (avoids borrow conflict)
        let record_count = self.cache.records.len();
        let mut parsed_dates: Vec<Option<crate::cache::ParsedDate>> = Vec::with_capacity(record_count);

        for record in &self.cache.records {
            let value_id = record.values
                .get(field.source_index)
                .copied()
                .unwrap_or(VALUE_ID_EMPTY);
            let parsed = if let Some(field_cache) = self.cache.fields.get(field.source_index) {
                if let Some(cache_value) = field_cache.get_value(value_id) {
                    parse_cache_value_as_date(cache_value)
                } else {
                    None
                }
            } else {
                None
            };
            parsed_dates.push(parsed);
        }

        // Pre-intern month and quarter labels in order so they get sorted IDs
        for &(level, vf_idx, _) in &vf_info {
            match level {
                DateGroupLevel::Month => {
                    let month_names = [
                        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
                    ];
                    for (i, name) in month_names.iter().enumerate() {
                        let month_num = (i + 1) as f64;
                        let vid = self.cache.virtual_fields[vf_idx]
                            .intern(CacheValue::Number(OrderedFloat(month_num)));
                        self.cache.virtual_fields[vf_idx]
                            .label_map.insert(vid, name.to_string());
                    }
                }
                DateGroupLevel::Quarter => {
                    for q in 1..=4u32 {
                        let vid = self.cache.virtual_fields[vf_idx]
                            .intern(CacheValue::Number(OrderedFloat(q as f64)));
                        self.cache.virtual_fields[vf_idx]
                            .label_map.insert(vid, format!("Q{}", q));
                    }
                }
                _ => {} // Year, Week, Day use number values that display/sort naturally
            }
        }

        // Second pass: populate virtual field values for each record
        for (record_idx, parsed) in parsed_dates.iter().enumerate() {
            for &(level, vf_idx, _) in &vf_info {
                let cache_value = if let Some(date) = parsed {
                    date_to_cache_value(date, level)
                } else {
                    CacheValue::Empty
                };
                self.cache.set_virtual_record_value(vf_idx, record_idx, cache_value);
            }
        }

        // Add label_map entries for Year/Week/Day values that were interned during record processing
        for &(level, vf_idx, _) in &vf_info {
            match level {
                DateGroupLevel::Year | DateGroupLevel::Week | DateGroupLevel::Day => {
                    // For these levels, values are Number types. Build label_map from interned values.
                    let field_cache = &self.cache.virtual_fields[vf_idx];
                    let count = field_cache.unique_count();
                    let mut labels = Vec::new();
                    for id in 0..count as ValueId {
                        if let Some(CacheValue::Number(n)) = field_cache.get_value(id) {
                            let label = match level {
                                DateGroupLevel::Year => format!("{}", n.as_f64() as i64),
                                DateGroupLevel::Week => format!("W{:02}", n.as_f64() as u32),
                                DateGroupLevel::Day => format!("{}", n.as_f64() as u32),
                                _ => unreachable!(),
                            };
                            labels.push((id, label));
                        }
                    }
                    for (id, label) in labels {
                        self.cache.virtual_fields[vf_idx].label_map.insert(id, label);
                    }
                }
                _ => {} // Month and Quarter already handled in pre-intern
            }
        }

        // Create effective PivotField entries for each date level
        for &(level, _, effective_index) in &vf_info {
            let name = format_date_level_name(&field.name, level);
            let mut vf_field = PivotField::new(effective_index, name);
            vf_field.sort_order = field.sort_order;
            vf_field.show_subtotals = field.show_subtotals;
            // Individual item collapse state doesn't transfer to virtual fields
            vf_field.collapsed = false;
            vf_field.collapsed_items = Vec::new();
            vf_field.show_all_items = field.show_all_items;
            effective.push(vf_field);
        }
    }

    /// Applies number binning: creates a virtual field with bin labels.
    /// Replaces the original field in the effective list.
    fn apply_number_binning_transform(
        &mut self,
        field: &PivotField,
        start: f64,
        end: f64,
        interval: f64,
        effective: &mut Vec<PivotField>,
    ) {
        if interval <= 0.0 || start >= end {
            effective.push(field.clone());
            return;
        }

        let base_field_count = self.cache.fields.len();
        let name = field.name.clone();
        let vf_idx = self.cache.add_virtual_field(name.clone());
        let effective_index = base_field_count + vf_idx;

        // Pre-compute bin labels and pre-intern them in order
        let bin_count = ((end - start) / interval).ceil() as usize;
        for bin_idx in 0..bin_count {
            let bin_start = start + (bin_idx as f64) * interval;
            let bin_end = (bin_start + interval).min(end);
            let label = if bin_start.fract() == 0.0 && bin_end.fract() == 0.0 {
                if bin_end - bin_start == 1.0 {
                    format!("{}", bin_start as i64)
                } else {
                    format!("{}-{}", bin_start as i64, (bin_end - 1.0) as i64)
                }
            } else {
                format!("{:.2}-{:.2}", bin_start, bin_end)
            };
            let vid = self.cache.virtual_fields[vf_idx]
                .intern(CacheValue::Number(OrderedFloat(bin_idx as f64)));
            self.cache.virtual_fields[vf_idx].label_map.insert(vid, label);
        }

        // Also pre-intern overflow bin labels
        let under_vid = self.cache.virtual_fields[vf_idx]
            .intern(CacheValue::Number(OrderedFloat(-1.0)));
        self.cache.virtual_fields[vf_idx]
            .label_map.insert(under_vid, format!("<{}", start));
        let over_vid = self.cache.virtual_fields[vf_idx]
            .intern(CacheValue::Number(OrderedFloat(bin_count as f64)));
        self.cache.virtual_fields[vf_idx]
            .label_map.insert(over_vid, format!(">{}", end));

        // Collect numeric values from records
        let record_count = self.cache.records.len();
        let mut record_values: Vec<Option<f64>> = Vec::with_capacity(record_count);

        for record in &self.cache.records {
            let value_id = record.values
                .get(field.source_index)
                .copied()
                .unwrap_or(VALUE_ID_EMPTY);
            let numeric = if let Some(field_cache) = self.cache.fields.get(field.source_index) {
                match field_cache.get_value(value_id) {
                    Some(CacheValue::Number(n)) => Some(n.as_f64()),
                    _ => None,
                }
            } else {
                None
            };
            record_values.push(numeric);
        }

        // Populate virtual field with bin values
        for (record_idx, numeric) in record_values.iter().enumerate() {
            let cache_value = if let Some(val) = numeric {
                if *val < start {
                    CacheValue::Number(OrderedFloat(-1.0))
                } else if *val >= end {
                    CacheValue::Number(OrderedFloat(bin_count as f64))
                } else {
                    let bin_idx = ((val - start) / interval).floor() as usize;
                    let bin_idx = bin_idx.min(bin_count - 1);
                    CacheValue::Number(OrderedFloat(bin_idx as f64))
                }
            } else {
                CacheValue::Empty
            };
            self.cache.set_virtual_record_value(vf_idx, record_idx, cache_value);
        }

        // Create effective PivotField
        let mut vf_field = PivotField::new(effective_index, name);
        vf_field.sort_order = field.sort_order;
        vf_field.show_subtotals = field.show_subtotals;
        vf_field.collapsed = false;
        vf_field.collapsed_items = Vec::new();
        vf_field.show_all_items = field.show_all_items;
        effective.push(vf_field);
    }

    /// Applies manual grouping: creates a virtual parent field with group names.
    /// Inserts the group field BEFORE the original field in the effective list (creating hierarchy).
    fn apply_manual_grouping_transform(
        &mut self,
        field: &PivotField,
        groups: &[ManualGroup],
        ungrouped_name: &str,
        effective: &mut Vec<PivotField>,
    ) {
        if groups.is_empty() {
            effective.push(field.clone());
            return;
        }

        let base_field_count = self.cache.fields.len();
        let name = format!("{} (Group)", field.name);
        let vf_idx = self.cache.add_virtual_field(name.clone());
        let effective_index = base_field_count + vf_idx;

        // Build a map from member label to group name
        let mut member_to_group: HashMap<String, String> = HashMap::new();
        for group in groups {
            for member in &group.members {
                member_to_group.insert(member.clone(), group.name.clone());
            }
        }

        // First pass: collect labels for each record
        let record_count = self.cache.records.len();
        let mut record_labels: Vec<String> = Vec::with_capacity(record_count);

        for record in &self.cache.records {
            let value_id = record.values
                .get(field.source_index)
                .copied()
                .unwrap_or(VALUE_ID_EMPTY);
            let label = if let Some(field_cache) = self.cache.fields.get(field.source_index) {
                match field_cache.get_value(value_id) {
                    Some(CacheValue::Text(s)) => s.clone(),
                    Some(CacheValue::Number(n)) => format!("{}", n.as_f64()),
                    Some(CacheValue::Boolean(b)) => {
                        if *b { "TRUE" } else { "FALSE" }.to_string()
                    }
                    _ => String::new(),
                }
            } else {
                String::new()
            };
            record_labels.push(label);
        }

        // Second pass: assign group names to virtual field
        for (record_idx, label) in record_labels.iter().enumerate() {
            let group_name = member_to_group
                .get(label)
                .cloned()
                .unwrap_or_else(|| ungrouped_name.to_string());
            self.cache.set_virtual_record_value(
                vf_idx,
                record_idx,
                CacheValue::Text(group_name),
            );
        }

        // Add the virtual group field BEFORE the original field (creates hierarchy)
        let mut group_field = PivotField::new(effective_index, name);
        group_field.sort_order = field.sort_order;
        group_field.show_subtotals = true;
        effective.push(group_field);

        // Keep the original field as the detail level under the group
        effective.push(field.clone());
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
    /// Supports both source fields and virtual fields (from grouping transforms).
    fn collect_unique_values_in_data(
        &self,
        fields: &[PivotField],
    ) -> Vec<HashMap<ValueId, bool>> {
        let mut unique_per_level: Vec<HashMap<ValueId, bool>> =
            vec![HashMap::new(); fields.len()];

        // Also track valid combinations for hierarchical filtering
        let mut valid_combos: HashMap<Vec<ValueId>, bool> = HashMap::new();

        let base_field_count = self.cache.fields.len();
        for (record_idx, record) in self.cache.records.iter().enumerate() {
            if !self.cache.filter_mask[record_idx] {
                continue;
            }

            let mut combo = Vec::with_capacity(fields.len());

            for (level, field) in fields.iter().enumerate() {
                let value_id = record_value_at(
                    record,
                    record_idx,
                    field.source_index,
                    base_field_count,
                    &self.cache.virtual_records,
                );

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
        let field_cache = match self.cache.get_field(field.source_index) {
            Some(fc) => fc,
            None => return Vec::new(),
        };
        
        // Get unique values at this level.
        // If show_all_items is true, use ALL unique values from the field cache
        // (Cartesian product), not just those present in the filtered data.
        let all_values_map: HashMap<ValueId, bool>;
        let values_at_level = if field.show_all_items {
            all_values_map = (0..field_cache.unique_count() as ValueId)
                .map(|id| (id, true))
                .collect();
            &all_values_map
        } else {
            match unique_values.get(level) {
                Some(v) => v,
                None => return Vec::new(),
            }
        };
        
        // Sort the values based on field's sort order
        let mut sorted_ids: Vec<ValueId> = values_at_level.keys().copied().collect();
        self.sort_value_ids(&mut sorted_ids, field_cache, &field.sort_order);
        
        let mut nodes = Vec::with_capacity(sorted_ids.len());
        
        for value_id in sorted_ids {
            // Get display label
            let label = self.get_value_label(field_cache, value_id);

            let mut node = AxisNode::new(value_id, field.source_index, label.clone(), level);

            // Build the path-based key for this item (e.g. "0:3/1:5" for
            // field0-value3 / field1-value5). This allows path-specific collapse
            // so that toggling "Female under Gothenburg" doesn't affect "Female
            // under Stockholm".
            let path_key = {
                let mut parts: Vec<String> = parent_path
                    .iter()
                    .enumerate()
                    .map(|(i, &vid)| format!("{}:{}", fields[i].source_index, vid))
                    .collect();
                parts.push(format!("{}:{}", field.source_index, value_id));
                parts.join("/")
            };

            // Per-item collapse: field-level collapses ALL, or check individual
            // item by path key or legacy label match.
            node.is_collapsed = field.collapsed
                || field.collapsed_items.contains(&path_key)
                || field.collapsed_items.contains(&label);
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
    /// Supports both source fields and virtual fields (from grouping transforms).
    fn filter_unique_for_parent(
        &self,
        fields: &[PivotField],
        start_level: usize,
        parent_path: &[ValueId],
    ) -> Vec<HashMap<ValueId, bool>> {
        let mut unique_per_level: Vec<HashMap<ValueId, bool>> =
            vec![HashMap::new(); fields.len()];

        let base_field_count = self.cache.fields.len();
        'records: for (record_idx, record) in self.cache.records.iter().enumerate() {
            if !self.cache.filter_mask[record_idx] {
                continue;
            }

            // Check if record matches parent path
            for (level, &parent_value) in parent_path.iter().enumerate() {
                if level >= fields.len() {
                    break;
                }
                let field_idx = fields[level].source_index;
                let record_value = record_value_at(
                    record,
                    record_idx,
                    field_idx,
                    base_field_count,
                    &self.cache.virtual_records,
                );

                if record_value != parent_value {
                    continue 'records;
                }
            }

            // Record matches - collect unique values from start_level onwards
            for level in start_level..fields.len() {
                let field_idx = fields[level].source_index;
                let value_id = record_value_at(
                    record,
                    record_idx,
                    field_idx,
                    base_field_count,
                    &self.cache.virtual_records,
                );

                unique_per_level[level].insert(value_id, true);
            }
        }

        unique_per_level
    }
    
    /// Sorts value IDs based on sort order.
    fn sort_value_ids(
        &self,
        ids: &mut Vec<ValueId>,
        field_cache: &crate::cache::FieldCache,
        sort_order: &crate::definition::SortOrder,
    ) {
        use crate::definition::SortOrder;
        
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
        field_cache: &crate::cache::FieldCache,
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
    /// Checks label_map first (used by date/number grouping for friendly names).
    fn get_value_label(
        &self,
        field_cache: &crate::cache::FieldCache,
        value_id: ValueId,
    ) -> String {
        if value_id == VALUE_ID_EMPTY {
            return "(blank)".to_string();
        }

        // Check for custom label override (used by date grouping, number binning)
        if let Some(label) = field_cache.label_map.get(&value_id) {
            return label.clone();
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
            &self.effective_row_fields
        } else {
            &self.effective_col_fields
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
        is_row: bool,
    ) {
        let subtotal_location = self.definition.layout.subtotal_location;

        for node in nodes {
            // Build group values up to this level
            let mut group_values = parent_values.to_vec();
            group_values.push(node.value_id);

            // Pad with VALUE_ID_EMPTY for remaining levels (for subtotals)
            let total_levels = fields.len();
            while group_values.len() < total_levels {
                group_values.push(VALUE_ID_EMPTY);
            }

            let has_children = !node.children.is_empty();
            // In compact layout, parent rows already show subtotal values in
            // their data cells (same group_values), so the separate subtotal
            // row is redundant.  Only generate it in Outline/Tabular layouts.
            let layout_wants_subtotal = !matches!(
                self.definition.layout.report_layout,
                ReportLayout::Compact
            );
            // For columns, the parent item already acts as the subtotal column
            // (same group_values → same aggregate), so don't generate a
            // redundant separate subtotal column.
            let wants_subtotal = node.show_subtotal && has_children
                && !matches!(subtotal_location, SubtotalLocation::Off)
                && layout_wants_subtotal
                && is_row;

            let child_parent_values: Vec<ValueId> = parent_values
                .iter()
                .chain(std::iter::once(&node.value_id))
                .copied()
                .collect();

            // For columns: place children BEFORE the parent item so that
            // the total/parent column appears at the end of its group
            // (matching Excel's default behaviour).
            if !is_row && has_children && !node.is_collapsed {
                // Record where children start so we can fix up parent_index
                let child_start = items.len();

                // Recurse into children first (they get a placeholder parent_index)
                self.flatten_nodes(
                    &node.children,
                    items,
                    &child_parent_values,
                    depth + 1,
                    i32::MIN, // placeholder – fixed up below
                    fields,
                    is_row,
                );

                // Now push the parent item (total column) after its children
                let my_index = items.len() as i32;
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

                // Fix up direct children's parent_index from placeholder to actual
                for i in child_start..(my_index as usize) {
                    if items[i].parent_index == i32::MIN {
                        items[i].parent_index = my_index;
                    }
                }
            } else {
                // Rows, or columns without expanded children: original order
                let my_index = items.len() as i32;

                // Build the subtotal item lazily (used for both AtTop and AtBottom)
                let build_subtotal = || {
                    let mut subtotal_values = parent_values.to_vec();
                    subtotal_values.push(node.value_id);
                    while subtotal_values.len() < total_levels {
                        subtotal_values.push(VALUE_ID_EMPTY);
                    }
                    FlatAxisItem {
                        group_values: subtotal_values,
                        label: format!("{} Total", node.label),
                        depth,
                        is_subtotal: true,
                        is_grand_total: false,
                        has_children: false,
                        is_collapsed: false,
                        parent_index: my_index,
                        field_indices: fields.iter().map(|f| f.source_index).collect(),
                    }
                };

                // SubtotalLocation::AtTop: insert subtotal BEFORE children
                if wants_subtotal && matches!(subtotal_location, SubtotalLocation::AtTop) {
                    items.push(build_subtotal());
                }

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
                    self.flatten_nodes(
                        &node.children,
                        items,
                        &child_parent_values,
                        depth + 1,
                        my_index,
                        fields,
                        is_row,
                    );
                }

                // SubtotalLocation::AtBottom (default): insert subtotal AFTER children
                if wants_subtotal && matches!(subtotal_location, SubtotalLocation::AtBottom) {
                    items.push(build_subtotal());
                }
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

        // Populate row/column field summaries for header filter dropdowns
        view.row_field_summaries = self.effective_row_fields.iter().map(|f| {
            HeaderFieldSummary {
                field_index: f.source_index,
                field_name: f.name.clone(),
                has_active_filter: !f.hidden_items.is_empty(),
            }
        }).collect();

        view.column_field_summaries = self.effective_col_fields.iter().map(|f| {
            HeaderFieldSummary {
                field_index: f.source_index,
                field_name: f.name.clone(),
                has_active_filter: !f.hidden_items.is_empty(),
            }
        }).collect();

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
    /// Uses effective fields (which may differ from definition when grouping is active).
    fn calculate_row_label_columns(&self) -> usize {
        match self.definition.layout.report_layout {
            ReportLayout::Compact => {
                // All row fields in one column
                1.max(if self.effective_row_fields.is_empty() { 0 } else { 1 })
            }
            ReportLayout::Outline | ReportLayout::Tabular => {
                // Each row field gets its own column
                self.effective_row_fields.len().max(1)
            }
        }
    }

    /// Calculates how many rows are needed for column headers.
    /// Uses effective fields (which may differ from definition when grouping is active).
    fn calculate_column_header_rows(&self) -> usize {
        if self.effective_col_fields.is_empty() {
            // Just one row for value field names
            1
        } else {
            // One row per column field level, plus one for values if multiple
            let base = self.effective_col_fields.len();
            if self.definition.value_fields.len() > 1
                && matches!(self.definition.layout.values_position, ValuesPosition::Columns) {
                base + 1
            } else {
                base.max(1)
            }
            // No extra "+1" row: field name labels are shown stacked in the
            // corner cells of each value header row (like Excel).
        }
    }
    
    /// Walks up the parent chain to find the ancestor at `target_depth`.
    fn find_ancestor_at_depth(
        col_items: &[FlatAxisItem],
        idx: usize,
        target_depth: usize,
    ) -> Option<usize> {
        let item = &col_items[idx];
        if item.depth == target_depth {
            return Some(idx);
        }
        if item.depth < target_depth || item.parent_index < 0 {
            return None;
        }
        Self::find_ancestor_at_depth(col_items, item.parent_index as usize, target_depth)
    }

    /// Builds the group_path vector from a FlatAxisItem's group_values.
    fn build_group_path(item: &FlatAxisItem) -> Vec<(usize, ValueId)> {
        let mut gp = Vec::new();
        for (i, &val) in item.group_values.iter().enumerate() {
            if val != VALUE_ID_EMPTY && i < item.field_indices.len() {
                gp.push((item.field_indices[i], val));
            }
        }
        gp
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
        let has_col_fields = !self.effective_col_fields.is_empty();

        for header_row in 0..col_header_rows {
            let mut cells = Vec::new();
            let is_last_header = header_row == col_header_rows - 1;

            // The depth index into column values (each header row maps to one level)
            let value_depth = header_row;

            // Corner cells (row label column headers)
            for col in 0..row_label_cols {
                if is_last_header {
                    // Last header row - show row field names with filter dropdown
                    let label = match self.definition.layout.report_layout {
                        ReportLayout::Compact => {
                            // Combine all row field names
                            self.effective_row_fields
                                .iter()
                                .map(|f| f.name.as_str())
                                .collect::<Vec<_>>()
                                .join(" / ")
                        }
                        ReportLayout::Outline | ReportLayout::Tabular => {
                            self.effective_row_fields
                                .get(col)
                                .map(|f| f.name.clone())
                                .unwrap_or_default()
                        }
                    };
                    // Use RowLabelHeader for the last corner cell (it gets the dropdown arrow)
                    let is_last_corner = match self.definition.layout.report_layout {
                        ReportLayout::Compact => true, // Only one corner cell in compact
                        ReportLayout::Outline | ReportLayout::Tabular => {
                            col == row_label_cols - 1
                        }
                    };
                    if is_last_corner && !self.effective_row_fields.is_empty() {
                        cells.push(PivotViewCell::row_label_header(label));
                    } else {
                        cells.push(PivotViewCell::column_header(label));
                    }
                } else if has_col_fields && col == 0 {
                    // Non-last header rows: show column field name label in corner cell.
                    // Only the FIRST header row gets the dropdown arrow (ColumnLabelHeader).
                    // Subsequent rows use plain ColumnHeader (same styling, no dropdown).
                    let field_label = self.effective_col_fields
                        .get(value_depth)
                        .map(|f| f.name.clone())
                        .unwrap_or_default();
                    if header_row == 0 {
                        cells.push(PivotViewCell::column_label_header(field_label));
                    } else {
                        cells.push(PivotViewCell::column_header(field_label));
                    }
                } else {
                    cells.push(PivotViewCell::corner());
                }
            }

            // Column header cells
            if self.col_items.is_empty() {
                // No column fields - show value field names (or blank if no values)
                if self.definition.value_fields.is_empty() {
                    // No value fields - add blank header
                    if is_last_header {
                        cells.push(PivotViewCell::column_header(String::new()));
                    } else {
                        cells.push(PivotViewCell::corner());
                    }
                } else {
                    for vf in &self.definition.value_fields {
                        if is_last_header {
                            cells.push(PivotViewCell::column_header(vf.name.clone()));
                        } else {
                            cells.push(PivotViewCell::corner());
                        }
                    }
                }
            } else {
                // Show column field values at appropriate level.
                // Because total/parent columns are placed AFTER their children,
                // parent labels must appear at the first child's column position.
                // Exception: collapsed parents have no visible children, so their
                // label + expand icon stays at their own column position.
                let col_items_snap = self.col_items.clone();
                let mut current_group: Option<usize> = None;

                for (col_idx, item) in self.col_items.iter().enumerate() {
                    let cell = if item.depth == value_depth {
                        if item.has_children && !item.is_collapsed {
                            // EXPANDED total column (children visible) – show
                            // subtotal label at its own depth level row.
                            current_group = Some(col_idx);
                            let label = format!("{} Total", item.label);
                            let mut ch = PivotViewCell::column_header(label);
                            ch.group_path = Self::build_group_path(item);
                            ch
                        } else {
                            // Leaf, grand total, or COLLAPSED parent – show
                            // label at own position (with expand icon if collapsed)
                            current_group = None;
                            let mut ch = PivotViewCell::column_header(item.label.clone());
                            ch.group_path = Self::build_group_path(item);
                            ch.is_expandable = item.has_children;
                            ch.is_collapsed = item.is_collapsed;
                            ch.indent_level = item.depth as u8;
                            ch
                        }
                    } else if item.depth > value_depth {
                        // Item is deeper than this header row. Check whether
                        // it is the first column of a new group at value_depth.
                        let ancestor = Self::find_ancestor_at_depth(
                            &col_items_snap, col_idx, value_depth,
                        );
                        if let Some(anc_idx) = ancestor {
                            if current_group != Some(anc_idx) {
                                // First column of a new group – show ancestor label
                                current_group = Some(anc_idx);
                                let anc = &col_items_snap[anc_idx];
                                let mut ch = PivotViewCell::column_header(
                                    anc.label.clone(),
                                );
                                ch.group_path = Self::build_group_path(anc);
                                ch.is_expandable = anc.has_children;
                                ch.is_collapsed = anc.is_collapsed;
                                ch.indent_level = anc.depth as u8;
                                ch
                            } else {
                                PivotViewCell::corner()
                            }
                        } else {
                            PivotViewCell::corner()
                        }
                    } else {
                        // item.depth < value_depth – shallower column.
                        // Label was already shown at the correct depth row;
                        // fill remaining header rows with header-styled empty cells.
                        PivotViewCell::column_header(String::new())
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

                    // Set group_path so context menu handlers can identify the field
                    let mut gp = Vec::new();
                    for (i, &val) in item.group_values.iter().enumerate() {
                        if val != VALUE_ID_EMPTY && i < item.field_indices.len() {
                            gp.push((item.field_indices[i], val));
                        }
                    }
                    cell.group_path = gp;

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
                    // Pre-build group_path for this row item
                    let mut row_gp = Vec::new();
                    for (i, &val) in item.group_values.iter().enumerate() {
                        if val != VALUE_ID_EMPTY && i < item.field_indices.len() {
                            row_gp.push((item.field_indices[i], val));
                        }
                    }

                    for col in 0..row_label_cols {
                        if col == item.depth {
                            let mut cell = PivotViewCell::row_header(
                                item.label.clone(),
                                0, // No indent in tabular
                            );
                            cell.is_expandable = item.has_children;
                            cell.is_collapsed = item.is_collapsed;
                            cell.group_path = row_gp.clone();

                            if item.is_subtotal || item.is_grand_total {
                                cell = cell.as_total();
                            }

                            cells.push(cell);
                        } else if col < item.depth
                            && repeat_row_labels
                            && matches!(report_layout, ReportLayout::Tabular) {
                            // Repeat parent labels in tabular layout
                            let parent_label = self.get_parent_label_at_depth(&row_items, row_idx, col);
                            let mut cell = PivotViewCell::row_header(parent_label, 0);
                            cell.group_path = row_gp.clone();
                            cells.push(cell);
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

                // Apply show_values_as transformation
                let display_value = self.transform_show_values_as(
                    aggregate,
                    &row_item.group_values,
                    &[],
                    vf_idx,
                    vf.aggregation,
                    vf.show_values_as,
                );

                let mut cell = PivotViewCell::data(display_value);
                cell.number_format = vf.number_format.clone();

                // Override number format for percentage-based show_values_as
                if matches!(vf.show_values_as,
                    ShowValuesAs::PercentOfGrandTotal | ShowValuesAs::PercentOfRowTotal |
                    ShowValuesAs::PercentOfColumnTotal | ShowValuesAs::PercentOfParentRow |
                    ShowValuesAs::PercentOfParentColumn
                ) {
                    cell.number_format = Some("0.00%".to_string());
                }

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

                // Apply show_values_as transformation
                let display_value = self.transform_show_values_as(
                    aggregate,
                    &row_item.group_values,
                    &col_group_values,
                    vf_idx,
                    vf.aggregation,
                    vf.show_values_as,
                );

                let mut cell = PivotViewCell::data(display_value);
                cell.number_format = vf.number_format.clone();

                // Override number format for percentage-based show_values_as
                if matches!(vf.show_values_as,
                    ShowValuesAs::PercentOfGrandTotal | ShowValuesAs::PercentOfRowTotal |
                    ShowValuesAs::PercentOfColumnTotal | ShowValuesAs::PercentOfParentRow |
                    ShowValuesAs::PercentOfParentColumn
                ) {
                    cell.number_format = Some("0.00%".to_string());
                }
                
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
// GROUPING TRANSFORM HELPERS
// ============================================================================

/// Formats the display name for a date grouping level.
pub fn format_date_level_name(field_name: &str, level: DateGroupLevel) -> String {
    match level {
        DateGroupLevel::Year => format!("{} (Year)", field_name),
        DateGroupLevel::Quarter => format!("{} (Quarter)", field_name),
        DateGroupLevel::Month => format!("{} (Month)", field_name),
        DateGroupLevel::Week => format!("{} (Week)", field_name),
        DateGroupLevel::Day => format!("{} (Day)", field_name),
    }
}

/// Converts a parsed date to a CacheValue for a specific date level.
/// Uses Number values for correct sorting (Month 1 < 2 < ... < 12).
pub fn date_to_cache_value(date: &crate::cache::ParsedDate, level: DateGroupLevel) -> CacheValue {
    match level {
        DateGroupLevel::Year => CacheValue::Number(OrderedFloat(date.year as f64)),
        DateGroupLevel::Quarter => CacheValue::Number(OrderedFloat(date.quarter() as f64)),
        DateGroupLevel::Month => CacheValue::Number(OrderedFloat(date.month as f64)),
        DateGroupLevel::Week => CacheValue::Number(OrderedFloat(date.week() as f64)),
        DateGroupLevel::Day => CacheValue::Number(OrderedFloat(date.day as f64)),
    }
}

/// Gets the ValueId for a record at an effective field index.
/// Supports both source fields (in record.values) and virtual fields (in virtual_records).
pub fn record_value_at(
    record: &crate::cache::CacheRecord,
    record_idx: usize,
    field_source_index: usize,
    base_field_count: usize,
    virtual_records: &[Vec<ValueId>],
) -> ValueId {
    if field_source_index < base_field_count {
        record.values.get(field_source_index).copied().unwrap_or(VALUE_ID_EMPTY)
    } else {
        let vi = field_source_index - base_field_count;
        virtual_records.get(vi)
            .and_then(|vr| vr.get(record_idx))
            .copied()
            .unwrap_or(VALUE_ID_EMPTY)
    }
}

// ============================================================================
// HELPER FUNCTIONS (outside impl to avoid borrow issues)
// ============================================================================

/// Expands axis items to include value field dimension.
fn expand_axis_for_values(
    items: &mut Vec<FlatAxisItem>,
    value_fields: &[crate::definition::ValueField],
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
) -> crate::view::DrillDownResult {
    let mut result = crate::view::DrillDownResult::new(
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
    use engine::CellValue;
    use crate::definition::{PivotField, ValueField, AggregationType};
    
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
    fn test_per_item_collapse() {
        let mut cache = create_test_cache();
        let mut definition = create_test_definition();

        // Add Product as a second row field under Region
        definition.row_fields.push(PivotField::new(1, "Product".to_string()));
        definition.column_fields.clear();

        // Collapse only "North" (per-item), keep "South" expanded
        definition.row_fields[0].collapsed_items.push("North".to_string());

        let view = calculate_pivot(&definition, &mut cache);

        // "North" should be present but collapsed (no children visible)
        // "South" should be expanded with children
        let mut found_north = false;
        let mut found_south_child = false;

        for row in &view.rows {
            if row.row_type == PivotRowType::Data {
                for cell in &view.cells[row.view_row] {
                    if let crate::view::PivotCellValue::Text(ref t) = cell.value {
                        if t == "North" && cell.is_expandable {
                            found_north = true;
                            assert!(cell.is_collapsed, "North should be collapsed");
                        }
                        // South's children (Apples/Oranges at depth 1)
                        if (t == "Apples" || t == "Oranges") && cell.indent_level > 0 {
                            found_south_child = true;
                        }
                    }
                }
            }
        }

        assert!(found_north, "Should find North in the view");
        assert!(found_south_child, "South's children should be visible");
    }

    #[test]
    fn test_show_all_items() {
        let mut cache = PivotCache::new(1, 3);
        cache.set_field_name(0, "Region".to_string());
        cache.set_field_name(1, "Product".to_string());
        cache.set_field_name(2, "Sales".to_string());

        // Only add data for North/Apples, not North/Oranges
        cache.add_record(0, &[
            CellValue::Text("North".to_string()),
            CellValue::Text("Apples".to_string()),
            CellValue::Number(100.0),
        ]);
        cache.add_record(1, &[
            CellValue::Text("South".to_string()),
            CellValue::Text("Oranges".to_string()),
            CellValue::Number(200.0),
        ]);

        let mut definition = PivotDefinition::new(1, (0, 0), (2, 2));
        let mut region_field = PivotField::new(0, "Region".to_string());
        let mut product_field = PivotField::new(1, "Product".to_string());
        product_field.show_all_items = true; // Show items with no data

        definition.row_fields.push(region_field);
        definition.row_fields.push(product_field);
        definition.value_fields.push(ValueField::new(2, "Sum of Sales".to_string(), AggregationType::Sum));

        let view = calculate_pivot(&definition, &mut cache);

        // With show_all_items, both "Apples" and "Oranges" should appear under both regions
        assert!(view.row_count > 4, "Should have more rows due to Cartesian product");
    }

    #[test]
    fn test_filter_rows_generation() {
        use crate::definition::{PivotFilter, FilterCondition, FilterValue};
        
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