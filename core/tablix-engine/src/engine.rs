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
    AggregateAccumulator, CacheRecord, CacheValue, OrderedFloat,
    PivotCache, ValueId, VALUE_ID_EMPTY, parse_cache_value_as_date,
};
use pivot_engine::definition::{
    AggregationType, DateGroupLevel, FieldGrouping, FieldIndex,
    ManualGroup, PivotField, SortOrder, SubtotalLocation,
};
use pivot_engine::engine::{
    format_date_level_name, date_to_cache_value, record_value_at,
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

    /// Row group field indices (updated after grouping transforms).
    row_field_indices: Vec<FieldIndex>,

    /// Column group field indices (updated after grouping transforms).
    col_field_indices: Vec<FieldIndex>,

    /// Effective row fields after grouping transforms.
    effective_row_fields: Vec<PivotField>,

    /// Effective column fields after grouping transforms.
    effective_col_fields: Vec<PivotField>,
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
            effective_row_fields: Vec::new(),
            effective_col_fields: Vec::new(),
        }
    }

    /// Executes the full calculation and returns the rendered view.
    pub fn calculate(&mut self) -> TablixView {
        // Step 1: Apply filters
        self.apply_filters();

        // Step 1.5: Apply grouping transforms (creates virtual fields)
        self.apply_grouping_transforms();

        // Step 2: Build row axis tree (using effective fields)
        let row_fields = self.effective_row_fields.clone();
        let col_fields = self.effective_col_fields.clone();
        let row_tree = self.build_axis_tree(&row_fields);

        // Step 3: Build column axis tree
        let col_tree = self.build_axis_tree(&col_fields);

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
    // GROUPING TRANSFORMS
    // ========================================================================

    /// Applies grouping transforms (date, number binning, manual) to row and column fields.
    /// Creates virtual fields in the cache and builds effective field lists.
    fn apply_grouping_transforms(&mut self) {
        self.cache.clear_virtual_fields();

        let row_fields = self.definition.row_groups.clone();
        let col_fields = self.definition.column_groups.clone();

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

    /// Applies date grouping: creates virtual fields for each date level.
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

        // First pass: collect parsed dates from all records
        let record_count = self.cache.records.len();
        let mut parsed_dates: Vec<Option<pivot_engine::cache::ParsedDate>> = Vec::with_capacity(record_count);

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
                _ => {}
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

        // Add label_map entries for Year/Week/Day values
        for &(level, vf_idx, _) in &vf_info {
            match level {
                DateGroupLevel::Year | DateGroupLevel::Week | DateGroupLevel::Day => {
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
                _ => {}
            }
        }

        // Create effective PivotField entries for each date level
        for &(level, _, effective_index) in &vf_info {
            let name = format_date_level_name(&field.name, level);
            let mut vf_field = PivotField::new(effective_index, name);
            vf_field.sort_order = field.sort_order;
            vf_field.show_subtotals = field.show_subtotals;
            vf_field.collapsed = false;
            vf_field.collapsed_items = Vec::new();
            vf_field.show_all_items = field.show_all_items;
            effective.push(vf_field);
        }
    }

    /// Applies number binning: creates a virtual field with bin labels.
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

        // Pre-intern overflow bin labels
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

        let base_field_count = self.cache.fields.len();
        for (record_idx, record) in self.cache.records.iter().enumerate() {
            if !self.cache.filter_mask[record_idx] {
                continue;
            }

            for (level, field) in fields.iter().enumerate() {
                let value_id = record_value_at(
                    record,
                    record_idx,
                    field.source_index,
                    base_field_count,
                    &self.cache.virtual_records,
                );
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
        let field_cache = match self.cache.get_field(field.source_index) {
            Some(fc) => fc,
            None => return Vec::new(),
        };

        // If show_all_items, use ALL unique values from field cache (Cartesian product)
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

        let mut sorted_ids: Vec<ValueId> = values_at_level.keys().copied().collect();
        self.sort_value_ids_fc(&mut sorted_ids, field_cache, &field.sort_order);

        let mut nodes = Vec::with_capacity(sorted_ids.len());

        for value_id in sorted_ids {
            let label = self.get_value_label_fc(field_cache, value_id);
            let mut node = AxisNode::new(value_id, field.source_index, label, level);
            node.is_collapsed = field.collapsed || field.collapsed_items.contains(&node.label);
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

        let base_field_count = self.cache.fields.len();
        'records: for (record_idx, record) in self.cache.records.iter().enumerate() {
            if !self.cache.filter_mask[record_idx] {
                continue;
            }

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

    fn sort_value_ids_fc(
        &self,
        ids: &mut Vec<ValueId>,
        field_cache: &pivot_engine::cache::FieldCache,
        sort_order: &SortOrder,
    ) {
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
        let field_cache = match self.cache.get_field(field_index) {
            Some(fc) => fc,
            None => return "(unknown)".to_string(),
        };
        self.get_value_label_fc(field_cache, value_id)
    }

    /// Gets the display label for a value from a specific field cache.
    /// Checks label_map first (used by date/number grouping for friendly names).
    fn get_value_label_fc(
        &self,
        field_cache: &pivot_engine::cache::FieldCache,
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
        let fields = &self.effective_row_fields;
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

            let subtotal_location = self.definition.layout.subtotal_location;
            let wants_subtotal = node.show_subtotal && has_children
                && !matches!(subtotal_location, SubtotalLocation::Off);

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

            // SubtotalLocation::AtTop: insert subtotal BEFORE children
            if wants_subtotal && matches!(subtotal_location, SubtotalLocation::AtTop) {
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

            // SubtotalLocation::AtBottom: insert subtotal AFTER children
            if wants_subtotal && matches!(subtotal_location, SubtotalLocation::AtBottom) {
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
        let base_field_count = self.cache.fields.len();

        for (record_idx, record) in self.cache.records.iter().enumerate() {
            if !self.cache.filter_mask[record_idx] {
                continue;
            }

            let mut matches = true;
            for (level, &gv) in group_values.iter().enumerate() {
                if gv == VALUE_ID_EMPTY {
                    continue; // Wildcard - matches all
                }
                if level < fields.len() {
                    let field_idx = fields[level].source_index;
                    let record_value = record_value_at(
                        record,
                        record_idx,
                        field_idx,
                        base_field_count,
                        &self.cache.virtual_records,
                    );
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
        let fields = &self.effective_col_fields;

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

            let subtotal_location = self.definition.layout.subtotal_location;
            let wants_subtotal = node.show_subtotal && has_children
                && !matches!(subtotal_location, SubtotalLocation::Off);

            items.push(FlatColItem {
                group_values,
                label: node.label.clone(),
                depth,
                is_subtotal: false,
                is_grand_total: false,
                has_children,
                parent_index,
            });

            // SubtotalLocation::AtTop: insert subtotal BEFORE children
            if wants_subtotal && matches!(subtotal_location, SubtotalLocation::AtTop) {
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

            // SubtotalLocation::AtBottom: insert subtotal AFTER children
            if wants_subtotal && matches!(subtotal_location, SubtotalLocation::AtBottom) {
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
                if self.effective_row_fields.is_empty() { 0 } else { 1 }
            }
            GroupLayout::Block => {
                // Each row group gets its own column
                self.effective_row_fields.len().max(if self.effective_row_fields.is_empty() { 0 } else { 1 })
            }
        }
    }

    fn calculate_col_header_rows(&self) -> usize {
        if self.effective_col_fields.is_empty() {
            1 // Just one row for data field names
        } else {
            let base = self.effective_col_fields.len();
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
                if i < self.effective_row_fields.len() {
                    let name = match self.definition.layout.group_layout {
                        GroupLayout::Block => self.effective_row_fields[i].name.clone(),
                        GroupLayout::Stepped => {
                            if i == 0 {
                                self.effective_row_fields
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
                    if header_row < self.effective_col_fields.len() {
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
        let row_fields = &self.effective_row_fields;
        let col_fields = &self.effective_col_fields;

        let mut acc = AggregateAccumulator::new();

        for (record_idx, record) in self.cache.records.iter().enumerate() {
            if !self.cache.filter_mask[record_idx] {
                continue;
            }

            if !self.record_matches_group(record, record_idx, row_values, row_fields)
                || !self.record_matches_group(record, record_idx, col_values, col_fields)
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
        let row_fields = &self.effective_row_fields;
        let col_fields = &self.effective_col_fields;

        self.cache.records.iter().enumerate()
            .filter(|(record_idx, record)| {
                self.cache.filter_mask[*record_idx]
                    && self.record_matches_group(record, *record_idx, row_values, row_fields)
                    && self.record_matches_group(record, *record_idx, col_values, col_fields)
            })
            .count()
    }

    /// Checks if a record matches a group's values (supports virtual fields).
    fn record_matches_group(
        &self,
        record: &CacheRecord,
        record_idx: usize,
        group_values: &[ValueId],
        fields: &[PivotField],
    ) -> bool {
        let base_field_count = self.cache.fields.len();
        for (level, &gv) in group_values.iter().enumerate() {
            if gv == VALUE_ID_EMPTY {
                continue; // Wildcard
            }
            if level < fields.len() {
                let field_idx = fields[level].source_index;
                let record_value = record_value_at(
                    record,
                    record_idx,
                    field_idx,
                    base_field_count,
                    &self.cache.virtual_records,
                );
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
