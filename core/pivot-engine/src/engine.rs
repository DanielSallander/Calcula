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

use rustc_hash::{FxHashMap, FxHashSet};
use std::time::Instant;
use crate::cache::{
    CacheValue, GroupKey, OrderedFloat, PivotCache, ValueId, VALUE_ID_EMPTY,
    parse_cache_value_as_date,
};
use crate::definition::{
    AggregationType, DateGroupLevel, FieldGrouping, FieldIndex, ManualGroup,
    PivotDefinition, PivotField, ReportLayout, ShowValuesAs, SlicerFilter,
    SubtotalLocation, ValueField, ValuesPosition,
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
#[allow(dead_code)]
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
    #[allow(dead_code)]
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

    /// Attribute (lookup) field labels to display alongside this item.
    /// Populated during flattening for items at the depth that owns each attribute.
    /// One entry per attribute field, in definition order.
    attribute_labels: Vec<String>,
}

// ============================================================================
// PIVOT CALCULATOR
// ============================================================================

/// Describes an attribute field and its relationship to a parent GROUP field.
#[derive(Debug, Clone)]
struct AttributeFieldInfo {
    /// The attribute field definition.
    field: PivotField,
    /// Index of the parent GROUP field in the group-only field list.
    parent_group_index: usize,
    /// Resolution map: parent GROUP value_id -> attribute label string.
    /// Built by scanning the cache once before flattening.
    resolution: FxHashMap<ValueId, String>,
}

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

    /// Effective row fields after grouping transforms (GROUP fields only).
    /// Date grouping expands one field into multiple (Year, Quarter, Month).
    /// Manual grouping inserts a parent group field before the original.
    effective_row_fields: Vec<PivotField>,

    /// Effective column fields after grouping transforms (GROUP fields only).
    effective_col_fields: Vec<PivotField>,

    /// Attribute fields for rows (resolved post-tree-build).
    row_attribute_fields: Vec<AttributeFieldInfo>,

    /// Attribute fields for columns.
    col_attribute_fields: Vec<AttributeFieldInfo>,

    /// Pre-computed grand totals for each value field (for show_values_as).
    grand_totals: Vec<f64>,

    /// Reusable buffer for building group keys in compute_aggregate.
    /// Avoids allocating a new Vec per cell (590K+ calls).
    agg_key_buf: Vec<ValueId>,
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
            row_attribute_fields: Vec::new(),
            col_attribute_fields: Vec::new(),
            grand_totals: Vec::new(),
            agg_key_buf: Vec::new(),
        }
    }

    /// Executes the full calculation and returns the rendered view.
    pub fn calculate(&mut self) -> PivotView {
        let t_total = Instant::now();

        // Step 1: Apply filters from definition to cache
        let t0 = Instant::now();
        self.apply_filters();
        let _filters_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // Step 1.5: Apply grouping transforms (creates virtual fields in cache).
        // This also separates attribute fields from GROUP fields.
        let t0 = Instant::now();
        self.apply_grouping_transforms();
        let _grouping_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // Step 2: Build axis trees (using effective GROUP fields only — attributes excluded)
        let t0 = Instant::now();
        let row_fields = self.effective_row_fields.clone();
        let col_fields = self.effective_col_fields.clone();
        let row_tree = self.build_axis_tree(&row_fields);
        let col_tree = self.build_axis_tree(&col_fields);
        let _tree_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // Step 3: Flatten trees into ordered lists
        let t0 = Instant::now();
        self.row_items = self.flatten_axis_tree(&row_tree, true);
        self.col_items = self.flatten_axis_tree(&col_tree, false);
        let _flatten_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // Step 3.5: Resolve attribute labels for each flat item
        let t0 = Instant::now();
        self.resolve_attribute_labels();
        let _attr_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // Step 4: Handle multiple value fields positioning
        let t0 = Instant::now();
        self.apply_values_position();
        let _values_pos_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // Step 4.5: Pre-compute grand totals for show_values_as
        let t0 = Instant::now();
        self.precompute_grand_totals();
        let _grand_totals_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // Step 5: Generate the view
        let t0 = Instant::now();
        let view = self.generate_view();
        let _view_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let _total_ms = t_total.elapsed().as_secs_f64() * 1000.0;

        // Uncomment for detailed per-step performance analysis:
        // eprintln!(
        //     "[PERF][pivot-engine] calculate: total={:.1}ms | filters={:.1} grouping={:.1} tree={:.1} flatten={:.1} attr={:.1} values_pos={:.1} grand_totals={:.1} view={:.1} | row_items={} col_items={} records={}",
        //     _total_ms, _filters_ms, _grouping_ms, _tree_ms, _flatten_ms, _attr_ms,
        //     _values_pos_ms, _grand_totals_ms, _view_ms,
        //     self.row_items.len(), self.col_items.len(), self.cache.records.len()
        // );

        view
    }

    /// Pre-computes grand totals for each value field (used by show_values_as).
    /// Builds resolution maps for attribute fields by scanning cache records,
    /// then populates `attribute_labels` on each FlatAxisItem.
    fn resolve_attribute_labels(&mut self) {
        // Build resolution maps for row attributes
        self.build_attribute_resolution_maps(true);
        self.build_attribute_resolution_maps(false);

        // Apply to row items
        let row_attrs = self.row_attribute_fields.clone();
        let row_group_fields = self.effective_row_fields.clone();
        for item in &mut self.row_items {
            item.attribute_labels = Self::resolve_labels_for_item(
                item,
                &row_attrs,
                &row_group_fields,
                &self.cache,
            );
        }

        // Apply to col items
        let col_attrs = self.col_attribute_fields.clone();
        let col_group_fields = self.effective_col_fields.clone();
        for item in &mut self.col_items {
            item.attribute_labels = Self::resolve_labels_for_item(
                item,
                &col_attrs,
                &col_group_fields,
                &self.cache,
            );
        }
    }

    /// Scans cache records to build parent_value_id -> attribute_label maps.
    fn build_attribute_resolution_maps(&mut self, is_row: bool) {
        // Clone what we need to avoid borrow conflicts
        let mut attrs = if is_row {
            self.row_attribute_fields.clone()
        } else {
            self.col_attribute_fields.clone()
        };
        let group_fields = if is_row {
            self.effective_row_fields.clone()
        } else {
            self.effective_col_fields.clone()
        };

        if attrs.is_empty() {
            return;
        }

        let base_field_count = self.cache.fields.len();

        for (record_idx, record) in self.cache.records.iter().enumerate() {
            for attr in attrs.iter_mut() {
                // Get the parent GROUP field's value_id for this record
                let parent_field = &group_fields[attr.parent_group_index];
                let parent_vid = record_value_at(
                    record,
                    record_idx,
                    parent_field.source_index,
                    base_field_count,
                    &self.cache.virtual_records,
                );

                // Skip if we already resolved this parent value
                if attr.resolution.contains_key(&parent_vid) {
                    continue;
                }

                // Get the attribute field's value for this record
                let attr_vid = record_value_at(
                    record,
                    record_idx,
                    attr.field.source_index,
                    base_field_count,
                    &self.cache.virtual_records,
                );

                // Resolve label using the same method as tree node labels
                if let Some(field_cache) = self.cache.get_field(attr.field.source_index) {
                    let label = self.get_value_label(field_cache, attr_vid);
                    attr.resolution.insert(parent_vid, label);
                }
            }
        }

        // Write back
        if is_row {
            self.row_attribute_fields = attrs;
        } else {
            self.col_attribute_fields = attrs;
        }
    }

    /// Resolves attribute labels for a single FlatAxisItem.
    fn resolve_labels_for_item(
        item: &FlatAxisItem,
        attrs: &[AttributeFieldInfo],
        _group_fields: &[PivotField],
        _cache: &PivotCache,
    ) -> Vec<String> {
        if attrs.is_empty() {
            return Vec::new();
        }

        attrs.iter().map(|attr| {
            if item.is_grand_total {
                return String::new();
            }
            // Get the parent GROUP field's value_id from this item's group_values
            let parent_vid = item
                .group_values
                .get(attr.parent_group_index)
                .copied()
                .unwrap_or(VALUE_ID_EMPTY);

            if parent_vid == VALUE_ID_EMPTY {
                return String::new();
            }

            // Look up the resolved label
            attr.resolution
                .get(&parent_vid)
                .cloned()
                .unwrap_or_default()
        }).collect()
    }

    fn precompute_grand_totals(&mut self) {
        // Ensure aggregates are computed once (triggers lazy computation).
        self.ensure_aggregates_computed();

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
                let row_total = self.compute_aggregate(row_values, &[], vf_idx, aggregation);
                if row_total != 0.0 { value / row_total } else { 0.0 }
            }
            ShowValuesAs::PercentOfColumnTotal => {
                let col_total = self.compute_aggregate(&[], col_values, vf_idx, aggregation);
                if col_total != 0.0 { value / col_total } else { 0.0 }
            }
            ShowValuesAs::PercentOfParentRow => {
                if row_values.len() > 1 {
                    let parent_row = &row_values[..row_values.len() - 1];
                    let parent_total = self.compute_aggregate(parent_row, col_values, vf_idx, aggregation);
                    if parent_total != 0.0 { value / parent_total } else { 0.0 }
                } else {
                    let gt = self.compute_aggregate(&[], col_values, vf_idx, aggregation);
                    if gt != 0.0 { value / gt } else { 0.0 }
                }
            }
            ShowValuesAs::PercentOfParentColumn => {
                if col_values.len() > 1 {
                    let parent_col = &col_values[..col_values.len() - 1];
                    let parent_total = self.compute_aggregate(row_values, parent_col, vf_idx, aggregation);
                    if parent_total != 0.0 { value / parent_total } else { 0.0 }
                } else {
                    let gt = self.compute_aggregate(row_values, &[], vf_idx, aggregation);
                    if gt != 0.0 { value / gt } else { 0.0 }
                }
            }
            ShowValuesAs::Index => {
                let gt = self.grand_totals.get(vf_idx).copied().unwrap_or(0.0);
                let row_total = self.compute_aggregate(row_values, &[], vf_idx, aggregation);
                let col_total = self.compute_aggregate(&[], col_values, vf_idx, aggregation);
                let denominator = row_total * col_total;
                if denominator != 0.0 { (value * gt) / denominator } else { 0.0 }
            }
            ShowValuesAs::Difference | ShowValuesAs::PercentDifference => {
                self.compute_difference(value, row_values, col_values, vf_idx, aggregation,
                    matches!(show_as, ShowValuesAs::PercentDifference))
            }
            ShowValuesAs::RunningTotal | ShowValuesAs::PercentOfRunningTotal => {
                self.compute_running_total(value, row_values, col_values, vf_idx, aggregation,
                    matches!(show_as, ShowValuesAs::PercentOfRunningTotal))
            }
            ShowValuesAs::RankAscending | ShowValuesAs::RankDescending => {
                self.compute_rank(value, row_values, col_values, vf_idx, aggregation,
                    matches!(show_as, ShowValuesAs::RankDescending))
            }
        }
    }

    /// Finds the base field position and ordered items for a value field's base_field_index.
    /// Returns (is_row_field, position_in_axis, ordered_item_value_ids).
    fn resolve_base_field(
        &self,
        vf_idx: usize,
    ) -> Option<(bool, usize, Vec<ValueId>)> {
        let vf = &self.definition.value_fields[vf_idx];
        let base_fi = vf.base_field_index?;

        // Check row fields first
        for (pos, rf) in self.effective_row_fields.iter().enumerate() {
            if rf.source_index == base_fi {
                let items = self.get_ordered_items_for_field(base_fi);
                return Some((true, pos, items));
            }
        }
        // Check column fields
        for (pos, cf) in self.effective_col_fields.iter().enumerate() {
            if cf.source_index == base_fi {
                let items = self.get_ordered_items_for_field(base_fi);
                return Some((false, pos, items));
            }
        }
        None
    }

    /// Returns the ordered list of ValueIds for a field (sorted ascending).
    fn get_ordered_items_for_field(&self, field_index: FieldIndex) -> Vec<ValueId> {
        if let Some(fc) = self.cache.get_field(field_index) {
            // Use the field cache's sorted order
            let mut fc_clone = fc.clone();
            fc_clone.sorted_ids().to_vec()
        } else {
            Vec::new()
        }
    }

    /// Finds the ValueId for a named base_item within a field.
    /// Special values: "(previous)" and "(next)" return None (handled by caller).
    fn resolve_base_item_id(
        &self,
        field_index: FieldIndex,
        base_item: &str,
    ) -> Option<ValueId> {
        if base_item == "(previous)" || base_item == "(next)" {
            return None; // Sentinel - caller handles positional logic
        }
        let fc = self.cache.get_field(field_index)?;
        // Search by label
        for vid in 0..fc.unique_count() as ValueId {
            let label = self.get_value_label(fc, vid);
            if label == base_item {
                return Some(vid);
            }
        }
        None
    }

    /// Computes Difference or PercentDifference from base item.
    fn compute_difference(
        &mut self,
        value: f64,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
        is_percent: bool,
    ) -> f64 {
        let resolved = self.resolve_base_field(vf_idx);
        let (is_row, pos, ordered_items) = match resolved {
            Some(v) => v,
            None => return value,
        };

        let vf = &self.definition.value_fields[vf_idx];
        let base_item_str = match &vf.base_item {
            Some(s) => s.clone(),
            None => return value,
        };

        // Current item's ValueId at the base field position
        let current_vid = if is_row {
            row_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        } else {
            col_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        };

        // Determine the target ValueId
        let base_fi = self.definition.value_fields[vf_idx].base_field_index.unwrap();
        let target_vid = if base_item_str == "(previous)" || base_item_str == "(next)" {
            // Find current position in ordered items
            let current_pos = ordered_items.iter().position(|&v| v == current_vid);
            match current_pos {
                Some(cp) => {
                    if base_item_str == "(previous)" {
                        if cp == 0 { return f64::NAN; }
                        ordered_items[cp - 1]
                    } else {
                        // "(next)"
                        if cp + 1 >= ordered_items.len() { return f64::NAN; }
                        ordered_items[cp + 1]
                    }
                }
                None => return f64::NAN,
            }
        } else {
            match self.resolve_base_item_id(base_fi, &base_item_str) {
                Some(vid) => vid,
                None => return f64::NAN,
            }
        };

        // Build modified row/col values with the target item substituted
        let base_value = if is_row {
            let mut modified = row_values.to_vec();
            if pos < modified.len() {
                modified[pos] = target_vid;
            }
            self.compute_aggregate(&modified, col_values, vf_idx, aggregation)
        } else {
            let mut modified = col_values.to_vec();
            if pos < modified.len() {
                modified[pos] = target_vid;
            }
            self.compute_aggregate(row_values, &modified, vf_idx, aggregation)
        };

        if is_percent {
            if base_value != 0.0 { (value - base_value) / base_value } else { f64::NAN }
        } else {
            value - base_value
        }
    }

    /// Computes RunningTotal or PercentOfRunningTotal along the base field.
    fn compute_running_total(
        &mut self,
        _value: f64,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
        is_percent: bool,
    ) -> f64 {
        let resolved = self.resolve_base_field(vf_idx);
        let (is_row, pos, ordered_items) = match resolved {
            Some(v) => v,
            None => return _value,
        };

        // Current item's ValueId
        let current_vid = if is_row {
            row_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        } else {
            col_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        };

        // Sum all values from the first item through the current item
        let mut running = 0.0;
        for &vid in &ordered_items {
            let item_value = if is_row {
                let mut modified = row_values.to_vec();
                if pos < modified.len() {
                    modified[pos] = vid;
                }
                self.compute_aggregate(&modified, col_values, vf_idx, aggregation)
            } else {
                let mut modified = col_values.to_vec();
                if pos < modified.len() {
                    modified[pos] = vid;
                }
                self.compute_aggregate(row_values, &modified, vf_idx, aggregation)
            };
            running += item_value;
            if vid == current_vid {
                break;
            }
        }

        if is_percent {
            let gt = self.grand_totals.get(vf_idx).copied().unwrap_or(0.0);
            if gt != 0.0 { running / gt } else { 0.0 }
        } else {
            running
        }
    }

    /// Computes Rank (ascending or descending) among sibling items.
    fn compute_rank(
        &mut self,
        value: f64,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
        descending: bool,
    ) -> f64 {
        let resolved = self.resolve_base_field(vf_idx);
        let (is_row, pos, ordered_items) = match resolved {
            Some(v) => v,
            None => return value,
        };

        // Collect all sibling values (varying only the base field position)
        let mut sibling_values: Vec<f64> = Vec::with_capacity(ordered_items.len());
        for &vid in &ordered_items {
            let item_value = if is_row {
                let mut modified = row_values.to_vec();
                if pos < modified.len() {
                    modified[pos] = vid;
                }
                self.compute_aggregate(&modified, col_values, vf_idx, aggregation)
            } else {
                let mut modified = col_values.to_vec();
                if pos < modified.len() {
                    modified[pos] = vid;
                }
                self.compute_aggregate(row_values, &modified, vf_idx, aggregation)
            };
            sibling_values.push(item_value);
        }

        // Count how many items rank above the current value
        let rank = if descending {
            // Rank 1 = largest value
            sibling_values.iter().filter(|&&v| v > value).count() + 1
        } else {
            // Rank 1 = smallest value
            sibling_values.iter().filter(|&&v| v < value).count() + 1
        };

        rank as f64
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

        // Collect hidden items from slicer filters (external, no UI)
        for sf in &self.definition.slicer_filters {
            if !sf.hidden_items.is_empty() {
                let hidden_ids = self.resolve_slicer_hidden_items(sf);
                if !hidden_ids.is_empty() {
                    hidden_items.push((sf.source_index, hidden_ids));
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

    /// Resolves slicer filter hidden items to ValueIds.
    fn resolve_slicer_hidden_items(&self, sf: &SlicerFilter) -> Vec<ValueId> {
        let mut ids = Vec::new();

        if let Some(field_cache) = self.cache.fields.get(sf.source_index) {
            for hidden_str in &sf.hidden_items {
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
    /// Populates `effective_row_fields` and `effective_col_fields` with GROUP fields only,
    /// and separates attribute fields into `row_attribute_fields` / `col_attribute_fields`.
    fn apply_grouping_transforms(&mut self) {
        self.cache.clear_virtual_fields();

        let row_fields = self.definition.row_fields.clone();
        let col_fields = self.definition.column_fields.clone();

        let all_row_fields = self.transform_field_list_for_grouping(&row_fields);
        let all_col_fields = self.transform_field_list_for_grouping(&col_fields);

        // Separate GROUP fields from attribute fields.
        // Attribute fields are stored with a reference to their parent GROUP field
        // (the immediately preceding non-attribute field).
        self.effective_row_fields = Vec::new();
        self.row_attribute_fields = Vec::new();
        Self::split_group_and_attributes(
            &all_row_fields,
            &mut self.effective_row_fields,
            &mut self.row_attribute_fields,
        );

        self.effective_col_fields = Vec::new();
        self.col_attribute_fields = Vec::new();
        Self::split_group_and_attributes(
            &all_col_fields,
            &mut self.effective_col_fields,
            &mut self.col_attribute_fields,
        );

        // Update field indices to match effective GROUP fields only
        self.row_field_indices = self.effective_row_fields.iter().map(|f| f.source_index).collect();
        self.col_field_indices = self.effective_col_fields.iter().map(|f| f.source_index).collect();
    }

    /// Splits a field list into GROUP fields and attribute fields.
    /// Each attribute field records the index of its parent GROUP field.
    fn split_group_and_attributes(
        all_fields: &[PivotField],
        group_fields: &mut Vec<PivotField>,
        attribute_fields: &mut Vec<AttributeFieldInfo>,
    ) {
        let mut last_group_index: Option<usize> = None;

        for field in all_fields {
            if field.is_attribute {
                // Attribute field: associate with the preceding GROUP field
                let parent_idx = last_group_index.unwrap_or(0);
                attribute_fields.push(AttributeFieldInfo {
                    field: field.clone(),
                    parent_group_index: parent_idx,
                    resolution: FxHashMap::default(),
                });
            } else {
                // GROUP field
                last_group_index = Some(group_fields.len());
                group_fields.push(field.clone());
            }
        }
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
        let mut member_to_group: FxHashMap<String, String> = FxHashMap::default();
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

        // Single-pass: collect unique values per level AND build children index.
        // children_index[level] maps parent_path_key -> set of child ValueIds.
        // For level 0, the parent key is empty (0 values).
        // For level 1, the parent key is (level0_value_id,).
        // For level N, the parent key is (level0_vid, level1_vid, ..., levelN-1_vid).
        let num_levels = fields.len();
        let mut unique_per_level: Vec<FxHashSet<ValueId>> =
            vec![FxHashSet::default(); num_levels];
        // children_index[level] maps the parent path (as Vec<ValueId>) to the set
        // of unique child values at that level.
        let mut children_index: Vec<FxHashMap<Vec<ValueId>, FxHashSet<ValueId>>> =
            vec![FxHashMap::default(); num_levels];

        let base_field_count = self.cache.fields.len();
        // Reusable path buffer — avoids allocating a new Vec per record
        let mut path = Vec::with_capacity(num_levels);
        for (record_idx, record) in self.cache.records.iter().enumerate() {
            if !self.cache.filter_mask[record_idx] {
                continue;
            }

            path.clear();
            for (level, field) in fields.iter().enumerate() {
                let value_id = record_value_at(
                    record,
                    record_idx,
                    field.source_index,
                    base_field_count,
                    &self.cache.virtual_records,
                );

                unique_per_level[level].insert(value_id);

                // Register this value as a child of its parent path.
                // Only clone the path when inserting a new parent key.
                let children_at_level = &mut children_index[level];
                if let Some(children) = children_at_level.get_mut(&path) {
                    children.insert(value_id);
                } else {
                    let mut children = FxHashSet::default();
                    children.insert(value_id);
                    children_at_level.insert(path.clone(), children);
                }

                path.push(value_id);
            }
        }

        // Build tree recursively using the pre-computed index
        self.build_tree_level_indexed(fields, 0, &unique_per_level, &children_index, &[])
    }

    /// Recursively builds one level of the axis tree using a pre-computed children index.
    fn build_tree_level_indexed(
        &self,
        fields: &[PivotField],
        level: usize,
        unique_values: &[FxHashSet<ValueId>],
        children_index: &[FxHashMap<Vec<ValueId>, FxHashSet<ValueId>>],
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
        let all_values_set: FxHashSet<ValueId>;
        let values_at_level = if field.show_all_items {
            all_values_set = (0..field_cache.unique_count() as ValueId).collect();
            &all_values_set
        } else if level == 0 {
            // Level 0: use the unique values from the single-pass scan
            match unique_values.get(level) {
                Some(v) => v,
                None => return Vec::new(),
            }
        } else {
            // Child levels: use the pre-computed children index
            let parent_key = parent_path.to_vec();
            match children_index[level].get(&parent_key) {
                Some(v) => v,
                None => return Vec::new(),
            }
        };

        // Sort the values based on field's sort order
        let mut sorted_ids: Vec<ValueId> = values_at_level.iter().copied().collect();
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

            // Per-item collapse: when field.collapsed is true, ALL items are
            // collapsed EXCEPT those listed in collapsed_items (exception list).
            // When field.collapsed is false, only items listed in
            // collapsed_items are collapsed.
            let in_items = field.collapsed_items.contains(&path_key)
                || field.collapsed_items.contains(&label);
            node.is_collapsed = if field.collapsed {
                !in_items // field collapsed: items in list are the EXCEPTIONS (expanded)
            } else {
                in_items // field expanded: items in list are collapsed
            };
            node.show_subtotal = field.show_subtotals && level < fields.len() - 1;

            // Build children if not at leaf level
            if level < fields.len() - 1 {
                let mut child_path = parent_path.to_vec();
                child_path.push(value_id);

                node.children = self.build_tree_level_indexed(
                    fields,
                    level + 1,
                    unique_values,
                    children_index,
                    &child_path,
                );
            }

            nodes.push(node);
        }

        nodes
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
                attribute_labels: Vec::new(),
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
                    attribute_labels: Vec::new(),
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
                        attribute_labels: Vec::new(),
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
                    attribute_labels: Vec::new(),
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
    /// Attribute fields get their own columns in all layouts.
    fn calculate_row_label_columns(&self) -> usize {
        let attr_count = self.row_attribute_fields.len();
        match self.definition.layout.report_layout {
            ReportLayout::Compact => {
                // One compact column for GROUP fields + one column per attribute field
                let group_cols = if self.effective_row_fields.is_empty() { 0 } else { 1 };
                (group_cols + attr_count).max(1)
            }
            ReportLayout::Outline | ReportLayout::Tabular => {
                // Each GROUP field + each attribute field gets its own column
                (self.effective_row_fields.len() + attr_count).max(1)
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
            let attr_count = self.row_attribute_fields.len();
            let group_col_count = match self.definition.layout.report_layout {
                ReportLayout::Compact => {
                    if self.effective_row_fields.is_empty() { 0 } else { 1 }
                }
                ReportLayout::Outline | ReportLayout::Tabular => {
                    self.effective_row_fields.len()
                }
            };

            for col in 0..row_label_cols {
                let is_attr_col = col >= group_col_count;

                if is_last_header {
                    if is_attr_col {
                        // Attribute column header — show attribute field name
                        let attr_idx = col - group_col_count;
                        let label = self.row_attribute_fields
                            .get(attr_idx)
                            .map(|a| a.field.name.clone())
                            .unwrap_or_default();
                        cells.push(PivotViewCell::column_header(label));
                    } else {
                        // GROUP column header
                        let label = match self.definition.layout.report_layout {
                            ReportLayout::Compact => {
                                // Combine all row GROUP field names
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
                        // Use RowLabelHeader for the last GROUP corner cell if no attrs,
                        // or for the compact column (it gets the dropdown arrow)
                        let is_last_group_col = match self.definition.layout.report_layout {
                            ReportLayout::Compact => true,
                            ReportLayout::Outline | ReportLayout::Tabular => {
                                col == group_col_count.saturating_sub(1) && attr_count == 0
                            }
                        };
                        if is_last_group_col && !self.effective_row_fields.is_empty() && attr_count == 0 {
                            cells.push(PivotViewCell::row_label_header(label));
                        } else {
                            cells.push(PivotViewCell::column_header(label));
                        }
                    }
                } else if has_col_fields && col == 0 {
                    // Non-last header rows: show column field name label in corner cell.
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
                    // Add calculated field headers
                    for cf in &self.definition.calculated_fields {
                        if is_last_header {
                            cells.push(PivotViewCell::column_header(cf.name.clone()));
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

        // Take items out of self to avoid borrow conflicts (zero-cost swap, no clone).
        // They are restored after the loop.
        let row_items = std::mem::take(&mut self.row_items);
        let col_items = std::mem::take(&mut self.col_items);
        let value_fields = self.definition.value_fields.clone();
        let values_position = self.definition.layout.values_position;
        let report_layout = self.definition.layout.report_layout;
        let repeat_row_labels = self.definition.layout.repeat_row_labels;
        let base_row_offset = view.row_count;

        for (row_idx, item) in row_items.iter().enumerate() {
            let view_row = view.row_count;
            let mut cells = Vec::new();

            // Generate row label cells
            let attr_count = self.row_attribute_fields.len();
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
                        cell.background_style = BackgroundStyle::GrandTotal;
                        cell.cell_type = PivotCellType::GrandTotalRow;
                    }

                    cells.push(cell);

                    // Attribute columns: one cell per attribute field (after the compact column)
                    for ai in 0..attr_count {
                        let label = item.attribute_labels
                            .get(ai)
                            .cloned()
                            .unwrap_or_default();
                        let mut attr_cell = PivotViewCell::row_header(label, 0);
                        if item.is_subtotal {
                            attr_cell = attr_cell.as_total();
                        } else if item.is_grand_total {
                            attr_cell = attr_cell.as_total();
                            attr_cell.background_style = BackgroundStyle::GrandTotal;
                        }
                        cells.push(attr_cell);
                    }
                }
                ReportLayout::Outline | ReportLayout::Tabular => {
                    // Pre-build group_path for this row item
                    let mut row_gp = Vec::new();
                    for (i, &val) in item.group_values.iter().enumerate() {
                        if val != VALUE_ID_EMPTY && i < item.field_indices.len() {
                            row_gp.push((item.field_indices[i], val));
                        }
                    }

                    // GROUP field columns
                    let group_col_count = self.effective_row_fields.len().max(if attr_count > 0 { 0 } else { 1 });
                    for col in 0..group_col_count {
                        if col == item.depth {
                            let mut cell = PivotViewCell::row_header(
                                item.label.clone(),
                                0, // No indent in tabular
                            );
                            cell.is_expandable = item.has_children;
                            cell.is_collapsed = item.is_collapsed;
                            cell.group_path = row_gp.clone();

                            if item.is_subtotal {
                                cell = cell.as_total();
                            } else if item.is_grand_total {
                                cell = cell.as_total();
                                cell.background_style = BackgroundStyle::GrandTotal;
                            }

                            cells.push(cell);
                        } else if col < item.depth
                            && repeat_row_labels
                            && matches!(report_layout, ReportLayout::Outline | ReportLayout::Tabular) {
                            // Repeat parent labels in outline/tabular layout
                            let parent_label = self.get_parent_label_at_depth(&row_items, row_idx, col);
                            let mut cell = PivotViewCell::row_header(parent_label, 0);
                            cell.group_path = row_gp.clone();
                            cells.push(cell);
                        } else {
                            cells.push(PivotViewCell::blank());
                        }
                    }

                    // Attribute columns: one cell per attribute field
                    for ai in 0..attr_count {
                        let label = item.attribute_labels
                            .get(ai)
                            .cloned()
                            .unwrap_or_default();
                        let mut attr_cell = PivotViewCell::row_header(label, 0);
                        if item.is_subtotal {
                            attr_cell = attr_cell.as_total();
                        } else if item.is_grand_total {
                            attr_cell = attr_cell.as_total();
                            attr_cell.background_style = BackgroundStyle::GrandTotal;
                        }
                        cells.push(attr_cell);
                    }
                }
            }

            // Generate data cells (using pre-cloned col_items/value_fields)
            self.generate_data_cells_for_row(&mut cells, item, &col_items, &value_fields, values_position);

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

        // Restore items back into self
        self.row_items = row_items;
        self.col_items = col_items;
    }

    /// Gets parent label at a specific depth for tabular layout.
    fn get_parent_label_at_depth(&self, row_items: &[FlatAxisItem], current_idx: usize, depth: usize) -> String {
        // Walk up the parent chain to find label at depth
        let mut idx = current_idx;
        loop {
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
            attribute_labels: Vec::new(),
        };

        let col_items = std::mem::take(&mut self.col_items);
        let value_fields = self.definition.value_fields.clone();
        let values_position = self.definition.layout.values_position;
        self.generate_data_cells_for_row(&mut cells, &grand_total_item, &col_items, &value_fields, values_position);
        
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

        // Restore col_items
        self.col_items = col_items;
    }

    /// Generates data cells for a row by iterating through columns.
    /// Accepts col_items/value_fields by reference to avoid cloning per-row.
    fn generate_data_cells_for_row(
        &mut self,
        cells: &mut Vec<PivotViewCell>,
        row_item: &FlatAxisItem,
        col_items: &[FlatAxisItem],
        value_fields: &[ValueField],
        values_position: ValuesPosition,
    ) {
        
        // Handle case with no value fields - generate blank cells
        if value_fields.is_empty() {
            if col_items.is_empty() {
                // No columns and no values - add one blank cell
                cells.push(PivotViewCell::blank());
            } else {
                // Generate blank cells for each column
                for _ in col_items {
                    cells.push(PivotViewCell::blank());
                }
            }
            return;
        }
        
        // Prepare the row portion of the key buffer once for all columns
        self.prepare_row_key(&row_item.group_values);

        if col_items.is_empty() {
            // No column fields - one cell per value field
            for (vf_idx, vf) in value_fields.iter().enumerate() {
                let aggregate = self.lookup_aggregate_col(
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
                cell.value_field_index = Some(vf_idx);

                // Override number format for percentage-based show_values_as
                if matches!(vf.show_values_as,
                    ShowValuesAs::PercentOfGrandTotal | ShowValuesAs::PercentOfRowTotal |
                    ShowValuesAs::PercentOfColumnTotal | ShowValuesAs::PercentOfParentRow |
                    ShowValuesAs::PercentOfParentColumn | ShowValuesAs::PercentDifference |
                    ShowValuesAs::PercentOfRunningTotal
                ) {
                    cell.number_format = Some("0.00%".to_string());
                }

                if row_item.is_subtotal {
                    cell.cell_type = PivotCellType::RowSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                    cell.is_bold = true;
                } else if row_item.is_grand_total {
                    cell.cell_type = PivotCellType::GrandTotal;
                    cell.background_style = BackgroundStyle::GrandTotal;
                    cell.is_bold = true;
                } else if row_item.has_children {
                    // Parent group rows (expandable) get bold data values (like Excel)
                    cell.is_bold = true;
                }

                cells.push(cell);
            }
        } else {
            // Generate cell for each column item
            for col_item in col_items {
                // Determine which value field this column represents
                let (vf_idx, col_group_values) = extract_value_field_from_column(
                    col_item,
                    value_fields.len(),
                    values_position,
                );

                // Safety check: ensure vf_idx is valid
                let vf_idx = vf_idx.min(value_fields.len().saturating_sub(1));

                let vf = &value_fields[vf_idx];

                // Use batched lookup: row key already prepared, only overwrites col portion
                let aggregate = self.lookup_aggregate_col(
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
                cell.value_field_index = Some(vf_idx);

                // Override number format for percentage-based show_values_as
                if matches!(vf.show_values_as,
                    ShowValuesAs::PercentOfGrandTotal | ShowValuesAs::PercentOfRowTotal |
                    ShowValuesAs::PercentOfColumnTotal | ShowValuesAs::PercentOfParentRow |
                    ShowValuesAs::PercentOfParentColumn | ShowValuesAs::PercentDifference |
                    ShowValuesAs::PercentOfRunningTotal
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
                    cell.background_style = BackgroundStyle::GrandTotal;
                    cell.is_bold = true;
                } else if col_item.is_grand_total {
                    cell.cell_type = PivotCellType::GrandTotalColumn;
                    cell.background_style = BackgroundStyle::Normal;
                    cell.is_bold = true;
                } else if is_row_total && is_col_total {
                    cell.cell_type = PivotCellType::RowSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                    cell.is_bold = true;
                } else if is_row_total {
                    cell.cell_type = PivotCellType::RowSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                    cell.is_bold = true;
                } else if is_col_total {
                    cell.cell_type = PivotCellType::ColumnSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                    cell.is_bold = true;
                } else if row_item.has_children {
                    // Parent group rows (expandable) get bold data values (like Excel)
                    cell.is_bold = true;
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

        // Generate calculated field cells
        if !self.definition.calculated_fields.is_empty() {
            self.generate_calculated_field_cells(cells, row_item, col_items, value_fields, values_position);
        }
    }

    /// Generates cells for calculated fields by evaluating their formulas
    /// against the aggregated values of regular value fields.
    fn generate_calculated_field_cells(
        &mut self,
        cells: &mut Vec<PivotViewCell>,
        row_item: &FlatAxisItem,
        col_items: &[FlatAxisItem],
        value_fields: &[ValueField],
        _values_position: ValuesPosition,
    ) {
        use std::collections::HashMap;

        let calc_fields = self.definition.calculated_fields.clone();

        if col_items.is_empty() {
            // No column fields - one cell per calculated field
            // Build value map from all regular value fields at this row
            let mut field_values: HashMap<String, f64> = HashMap::new();
            for (vf_idx, vf) in value_fields.iter().enumerate() {
                let aggregate = self.lookup_aggregate_col(&[], vf_idx, vf.aggregation);
                // Use the source field name (without "Sum of" prefix) as the lookup key
                if let Some(fc) = self.cache.get_field(vf.source_index) {
                    field_values.insert(fc.name.clone(), aggregate);
                }
                // Also insert by display name
                field_values.insert(vf.name.clone(), aggregate);
            }

            for cf in &calc_fields {
                let result = crate::calculated::eval_calc_formula(&cf.formula, &field_values)
                    .unwrap_or(f64::NAN);

                let mut cell = PivotViewCell::data(result);
                cell.number_format = cf.number_format.clone();

                if row_item.is_subtotal {
                    cell.cell_type = PivotCellType::RowSubtotal;
                    cell.background_style = BackgroundStyle::Subtotal;
                    cell.is_bold = true;
                } else if row_item.is_grand_total {
                    cell.cell_type = PivotCellType::GrandTotal;
                    cell.background_style = BackgroundStyle::GrandTotal;
                    cell.is_bold = true;
                }

                cells.push(cell);
            }
        } else {
            // With column fields - one calculated field cell per column item
            for col_item in col_items {
                let col_group_values = &col_item.group_values;

                // Build value map from all regular value fields at this intersection
                let mut field_values: HashMap<String, f64> = HashMap::new();
                for (vf_idx, vf) in value_fields.iter().enumerate() {
                    let aggregate = self.lookup_aggregate_col(col_group_values, vf_idx, vf.aggregation);
                    if let Some(fc) = self.cache.get_field(vf.source_index) {
                        field_values.insert(fc.name.clone(), aggregate);
                    }
                    field_values.insert(vf.name.clone(), aggregate);
                }

                for cf in &calc_fields {
                    let result = crate::calculated::eval_calc_formula(&cf.formula, &field_values)
                        .unwrap_or(f64::NAN);

                    let mut cell = PivotViewCell::data(result);
                    cell.number_format = cf.number_format.clone();

                    let is_row_total = row_item.is_subtotal || row_item.is_grand_total;
                    let is_col_total = col_item.is_subtotal || col_item.is_grand_total;

                    if row_item.is_grand_total && col_item.is_grand_total {
                        cell.cell_type = PivotCellType::GrandTotal;
                        cell.background_style = BackgroundStyle::GrandTotal;
                        cell.is_bold = true;
                    } else if row_item.is_grand_total {
                        cell.cell_type = PivotCellType::GrandTotalRow;
                        cell.background_style = BackgroundStyle::GrandTotal;
                        cell.is_bold = true;
                    } else if col_item.is_grand_total {
                        cell.cell_type = PivotCellType::GrandTotalColumn;
                        cell.background_style = BackgroundStyle::Normal;
                        cell.is_bold = true;
                    } else if is_row_total || is_col_total {
                        cell.cell_type = PivotCellType::RowSubtotal;
                        cell.background_style = BackgroundStyle::Subtotal;
                        cell.is_bold = true;
                    }

                    cells.push(cell);
                }
            }
        }
    }

    /// Ensures aggregates are computed before lookups.
    fn ensure_aggregates_computed(&mut self) {
        let ri = self.row_field_indices.clone();
        let ci = self.col_field_indices.clone();
        let vi = self.value_field_indices.clone();
        let key = GroupKey::grand_total(ri.len() + ci.len());
        self.cache.get_aggregate(&key, &ri, &ci, &vi);
    }

    /// Computes the aggregate value for a row/column intersection.
    /// Uses the split row/column structure: row key for HashMap lookup,
    /// column key for flat array indexing.
    fn compute_aggregate(
        &mut self,
        row_values: &[ValueId],
        col_values: &[ValueId],
        value_field_idx: usize,
        aggregation: AggregationType,
    ) -> f64 {
        // Build padded row key in buffer
        let row_len = self.row_field_indices.len();
        self.agg_key_buf.clear();
        self.agg_key_buf.resize(row_len, VALUE_ID_EMPTY);
        let copy_len = row_values.len().min(row_len);
        self.agg_key_buf[..copy_len].copy_from_slice(&row_values[..copy_len]);

        // Row HashMap lookup + column flat array index
        if let Some(slot) = self.cache.get_row_slot(&self.agg_key_buf) {
            let acc_idx = self.cache.col_layout().acc_index(col_values, value_field_idx);
            if let Some(acc) = slot.get(acc_idx) {
                return acc.compute(aggregation);
            }
        }

        0.0
    }

    /// Prepares the row key buffer for batched column lookups.
    /// Call once per row, then use `lookup_aggregate_col` for each column.
    fn prepare_row_key(&mut self, row_values: &[ValueId]) {
        let row_len = self.row_field_indices.len();
        self.agg_key_buf.clear();
        self.agg_key_buf.resize(row_len, VALUE_ID_EMPTY);
        let copy_len = row_values.len().min(row_len);
        self.agg_key_buf[..copy_len].copy_from_slice(&row_values[..copy_len]);
    }

    /// Looks up an aggregate using the pre-prepared row key and column values.
    /// Uses flat array indexing for the column dimension — no hashing needed.
    fn lookup_aggregate_col(
        &mut self,
        col_values: &[ValueId],
        value_field_idx: usize,
        aggregation: AggregationType,
    ) -> f64 {
        if let Some(slot) = self.cache.get_row_slot(&self.agg_key_buf) {
            let acc_idx = self.cache.col_layout().acc_index(col_values, value_field_idx);
            if let Some(acc) = slot.get(acc_idx) {
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
                attribute_labels: Vec::new(),
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