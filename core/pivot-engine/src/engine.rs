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
    member_id, CacheValue, GroupKey, OrderedFloat, PivotCache, ValueId, VALUE_ID_BLANK,
    VALUE_ID_EMPTY, parse_cache_value_as_date,
};
use crate::definition::{
    AggregationType, DateGroupLevel, FieldGrouping, FieldIndex, HierarchyConfig,
    ManualGroup, PivotDefinition, PivotField, RaggedBehavior, ReportLayout,
    ShowValuesAs, SlicerFilter, SubtotalLocation, ValueColumnRef, ValueField,
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
/// `pub(crate)` so that `calculated.rs` can reference it in `VisualCalcContext`.
#[derive(Debug, Clone)]
pub(crate) struct FlatAxisItem {
    /// The group key values up to and including this level.
    pub(crate) group_values: Vec<ValueId>,

    /// Display label.
    pub(crate) label: String,

    /// Depth/indent level.
    pub(crate) depth: usize,

    /// Whether this is a subtotal row/column.
    pub(crate) is_subtotal: bool,

    /// Whether this is the grand total.
    pub(crate) is_grand_total: bool,

    /// Whether this item has children (for expand/collapse).
    pub(crate) has_children: bool,

    /// Whether this item is collapsed.
    pub(crate) is_collapsed: bool,

    /// Parent index in the flat list (-1 for root).
    pub(crate) parent_index: i32,

    /// Field indices involved in this grouping.
    pub(crate) field_indices: Vec<FieldIndex>,

    /// Attribute (lookup) field labels to display alongside this item.
    /// Populated during flattening for items at the depth that owns each attribute.
    /// One entry per attribute field, in definition order.
    pub(crate) attribute_labels: Vec<String>,

    /// The value field this item STANDS FOR when the value fields are a level
    /// of this axis (`expand_axis_for_values`: several values on rows or on
    /// columns); `None` for every other item. Read by the data cells of a
    /// values-on-rows pivot: each value row shows its OWN value field, not
    /// every one of them (e2e fixall-pivot R4, 2026-09-29).
    pub(crate) value_field: Option<usize>,
}

/// Pre-computed row-axis data for visual calculations, built once per view
/// and shared by every calculated cell.
struct VisualRowData {
    /// Row-total value maps, one per row item (used when no column fields exist).
    row_values_totals: Vec<std::collections::HashMap<String, f64>>,
    /// Per-column row value maps: [col_idx][row_idx] -> map. Populated when
    /// column fields exist so ROWS-axis window functions read the CURRENT
    /// column's values instead of row totals.
    row_values_by_col: Vec<Vec<std::collections::HashMap<String, f64>>>,
    /// Row field names by depth (reset/ISATLEVEL/LOOKUP resolution).
    field_names_by_depth: Vec<String>,
    /// Grand-total value map — computed even when the grand-total row is hidden.
    grand_total_values: std::collections::HashMap<String, f64>,
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

    /// Every member id of each base field, blank member included, in
    /// ascending order (see [`Self::get_ordered_items_for_field`]): the walk
    /// for a cell whose siblings the axis does not list, and the answer to
    /// "does this field have a blank member". Built once per field per
    /// calculation: it is read for EVERY such cell, and the blank member
    /// costs a scan of the records to find.
    base_field_items: FxHashMap<FieldIndex, Vec<ValueId>>,

    /// The items Show Values As walks, IN THE ORDER THE AXIS SHOWS THEM: per
    /// row level, each parent path (the member ids of the levels above)
    /// mapped to its children as built -- sorted by the field's own order,
    /// hidden items gone. See [`Self::resolve_base_field`].
    row_sibling_order: Vec<FxHashMap<Vec<ValueId>, Vec<ValueId>>>,

    /// [`Self::row_sibling_order`] for the column levels.
    col_sibling_order: Vec<FxHashMap<Vec<ValueId>, Vec<ValueId>>>,
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
            base_field_items: FxHashMap::default(),
            row_sibling_order: Vec::new(),
            col_sibling_order: Vec::new(),
        }
    }

    /// Executes the full calculation and returns the rendered view.
    pub fn calculate(&mut self) -> PivotView {
        let t_total = Instant::now();
        // Built over THIS calculation's records and virtual fields.
        self.base_field_items.clear();

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
        let mut row_tree = self.build_axis_tree(&row_fields);
        let mut col_tree = self.build_axis_tree(&col_fields);

        // Apply ragged hierarchy behaviors to the trees
        for hc in &self.definition.hierarchy_configs {
            if hc.is_row {
                apply_ragged_behavior(&mut row_tree, hc, 0);
            } else {
                apply_ragged_behavior(&mut col_tree, hc, 0);
            }
        }
        // What Show Values As walks: the items as the axis shows them.
        self.row_sibling_order = sibling_order_of(&row_tree, row_fields.len());
        self.col_sibling_order = sibling_order_of(&col_tree, col_fields.len());
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
                // The parent GROUP field's MEMBER id for this record -- the
                // id the axis items carry (a blank parent is VALUE_ID_BLANK)
                let parent_field = &group_fields[attr.parent_group_index];
                let parent_vid = record_member_at(
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

    /// Finds where a value field's base field sits and the items to walk for
    /// the cell at `row_values` x `col_values`.
    /// Returns (is_row_field, position_in_axis, ordered_item_value_ids).
    ///
    /// THE ITEMS ARE THE CELL'S SIBLINGS AS THE AXIS SHOWS THEM (wave E, Y2):
    /// the base field's items under the cell's own parent path, in the
    /// field's sort order -- descending, by another field, manual -- with
    /// hidden items gone. Running Total, (previous) / (next) and Rank are
    /// about the rows (or columns) on screen. The walk was every item of the
    /// field in ASCENDING order whatever the sort, so a Z-A Region read West
    /// 65, East 45, (blank) 35 where Excel reads 20, 30, 65, and a hidden
    /// item was ranked and stepped onto.
    ///
    /// A cell whose parent path the axis does not list (a subtotal or grand
    /// total cell of a base field below it, where the path holds the "all
    /// values" padding) walks every item of the field
    /// ([`Self::get_ordered_items_for_field`]); its own item is the padding,
    /// which matches none of them, so the order does not matter there.
    fn resolve_base_field(
        &mut self,
        vf_idx: usize,
        row_values: &[ValueId],
        col_values: &[ValueId],
    ) -> Option<(bool, usize, Vec<ValueId>)> {
        let vf = &self.definition.value_fields[vf_idx];
        let base_fi = vf.base_field_index?;

        // Row fields first, then column fields.
        let (is_row, pos) = match self.effective_row_fields.iter().position(|rf| rf.source_index == base_fi) {
            Some(pos) => (true, pos),
            None => (false, self.effective_col_fields.iter().position(|cf| cf.source_index == base_fi)?),
        };
        let (orders, values) = if is_row {
            (&self.row_sibling_order, row_values)
        } else {
            (&self.col_sibling_order, col_values)
        };
        let shown: Option<Vec<ValueId>> =
            values.get(..pos).and_then(|parent| orders.get(pos)?.get(parent)).cloned();
        let items = match shown {
            Some(items) => items,
            None => self.get_ordered_items_for_field(base_fi),
        };
        Some((is_row, pos, items))
    }

    /// Every MEMBER id of a field in ascending order: the walk for a cell
    /// whose siblings the axis does not list (see [`Self::resolve_base_field`],
    /// which walks the items as SHOWN wherever it can), and what
    /// [`Self::resolve_base_item_id`] asks "does this field have a blank
    /// member" of.
    ///
    /// THE BLANK MEMBER IS ONE OF THEM (wave D, X1). Blanks are never
    /// interned, so the field's sorted values never name the blank member
    /// (`VALUE_ID_BLANK` in a group key): its running total never met its own
    /// row and summed every OTHER item, rank left it out of the siblings, and
    /// (previous) / (next) found no position for it -- nor for the item next
    /// to it. When any record of the field is blank it is listed FIRST, where
    /// the ascending axis shows it (`compare_values` sorts `CacheValue::Empty`
    /// before every value).
    fn get_ordered_items_for_field(&mut self, field_index: FieldIndex) -> Vec<ValueId> {
        if let Some(items) = self.base_field_items.get(&field_index) {
            return items.clone();
        }
        let items = match self.cache.get_field(field_index) {
            Some(fc) => {
                // Use the field cache's sorted order
                let mut fc_clone = fc.clone();
                let sorted = fc_clone.sorted_ids();
                let has_blank = (0..self.cache.records.len())
                    .any(|ri| self.cache.get_record_value_id(ri, field_index) == VALUE_ID_EMPTY);
                let mut items = Vec::with_capacity(sorted.len() + usize::from(has_blank));
                if has_blank {
                    items.push(VALUE_ID_BLANK);
                }
                items.extend_from_slice(sorted);
                items
            }
            None => Vec::new(),
        };
        self.base_field_items.insert(field_index, items.clone());
        items
    }

    /// Finds the ValueId for a named base_item within a field.
    /// Special values: "(previous)" and "(next)" return None (handled by caller).
    /// "(blank)" (any case) names the blank member when the field has one.
    fn resolve_base_item_id(
        &mut self,
        field_index: FieldIndex,
        base_item: &str,
    ) -> Option<ValueId> {
        if base_item == "(previous)" || base_item == "(next)" {
            return None; // Sentinel - caller handles positional logic
        }
        if crate::cache::is_blank_item_label(base_item)
            && self.get_ordered_items_for_field(field_index).first() == Some(&VALUE_ID_BLANK)
        {
            return Some(VALUE_ID_BLANK);
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
        let resolved = self.resolve_base_field(vf_idx, row_values, col_values);
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
        let resolved = self.resolve_base_field(vf_idx, row_values, col_values);
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
        let resolved = self.resolve_base_field(vf_idx, row_values, col_values);
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
    
    /// Converts a CacheValue to its display string for comparison with hidden_items.
    fn cache_value_display(value: &CacheValue) -> String {
        match value {
            CacheValue::Text(s) => s.clone(),
            CacheValue::Number(n) => {
                let f = n.as_f64();
                if f.fract() == 0.0 {
                    format!("{}", f as i64)
                } else {
                    format!("{}", f)
                }
            }
            CacheValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
            CacheValue::Error(e) => format!("#{}", e),
            CacheValue::Empty => String::new(),
        }
    }

    /// Resolves string hidden items to ValueIds by comparing display strings.
    ///
    /// The blank item's label ("(blank)", any case) resolves to
    /// `VALUE_ID_EMPTY`: blanks are never interned, so the scan over the
    /// interned values below could never find them, and hiding "(blank)" --
    /// or an inclusion `Region = ("East")` inverted into "hide every other
    /// item" -- kept every blank record (BUG-0197).
    fn resolve_hidden_ids(field_cache: &crate::cache::FieldCache, hidden_items: &[String]) -> Vec<ValueId> {
        let mut ids = Vec::new();
        for hidden_str in hidden_items {
            if crate::cache::is_blank_item_label(hidden_str) && !ids.contains(&VALUE_ID_EMPTY) {
                ids.push(VALUE_ID_EMPTY);
            }
            for id in 0..field_cache.unique_count() as ValueId {
                if let Some(value) = field_cache.get_value(id) {
                    if Self::cache_value_display(value) == *hidden_str {
                        ids.push(id);
                        break;
                    }
                }
            }
        }
        ids
    }

    /// Resolves string hidden items to ValueIds.
    fn resolve_hidden_items(&self, field: &PivotField) -> Vec<ValueId> {
        if let Some(field_cache) = self.cache.fields.get(field.source_index) {
            Self::resolve_hidden_ids(field_cache, &field.hidden_items)
        } else {
            Vec::new()
        }
    }

    /// Resolves slicer filter hidden items to ValueIds.
    fn resolve_slicer_hidden_items(&self, sf: &SlicerFilter) -> Vec<ValueId> {
        if let Some(field_cache) = self.cache.fields.get(sf.source_index) {
            Self::resolve_hidden_ids(field_cache, &sf.hidden_items)
        } else {
            Vec::new()
        }
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
                // The MEMBER id: a blank value is the blank member
                // (VALUE_ID_BLANK), never the subtotal padding.
                let value_id = record_member_at(
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

        // "Show items with no data" lists every member of the field, the
        // blank member included when ANY record of the field is blank (the
        // interned values alone never name it). Scanned only for such fields.
        let blank_in_field: Vec<bool> = fields
            .iter()
            .map(|f| {
                f.show_all_items
                    && (0..self.cache.records.len())
                        .any(|ri| self.cache.get_record_value_id(ri, f.source_index) == VALUE_ID_EMPTY)
            })
            .collect();

        // DATA-SOURCE ORDER (wave F, Z2): for every level shown in Manual or
        // DataSourceOrder, the record index at which the SOURCE first shows
        // each item. Scanned over EVERY record, the filtered-out ones too, so
        // the order is the source's and hiding a year never reorders the
        // regions; ONE order per field, which the items under every parent
        // follow (Excel keeps one item order per field). The level's
        // FxHashSet order used to stand in for it.
        let source_order: Vec<Option<FxHashMap<ValueId, usize>>> = fields
            .iter()
            .map(|field| {
                use crate::definition::SortOrder;
                if !matches!(field.sort_order, SortOrder::Manual | SortOrder::DataSourceOrder) {
                    return None;
                }
                let mut first_shown: FxHashMap<ValueId, usize> = FxHashMap::default();
                for (record_idx, record) in self.cache.records.iter().enumerate() {
                    let member = record_member_at(
                        record,
                        record_idx,
                        field.source_index,
                        base_field_count,
                        &self.cache.virtual_records,
                    );
                    first_shown.entry(member).or_insert(record_idx);
                }
                Some(first_shown)
            })
            .collect();

        // Build tree recursively using the pre-computed index
        self.build_tree_level_indexed(
            fields,
            0,
            &unique_per_level,
            &children_index,
            &blank_in_field,
            &source_order,
            &[],
        )
    }

    /// Recursively builds one level of the axis tree using a pre-computed children index.
    fn build_tree_level_indexed(
        &self,
        fields: &[PivotField],
        level: usize,
        unique_values: &[FxHashSet<ValueId>],
        children_index: &[FxHashMap<Vec<ValueId>, FxHashSet<ValueId>>],
        blank_in_field: &[bool],
        source_order: &[Option<FxHashMap<ValueId, usize>>],
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
            all_values_set = (0..field_cache.unique_count() as ValueId)
                .chain(blank_in_field.get(level).copied().unwrap_or(false).then_some(VALUE_ID_BLANK))
                .collect();
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

        // Sort the values based on field's sort order.
        // If this field has a sort_by_field_index, build a mapping from this field's
        // ValueIds to the sort-by field's ValueIds so we can sort by proxy values
        // (e.g., sort month_name items by month_number values).
        let mut sorted_ids: Vec<ValueId> = values_at_level.iter().copied().collect();
        let sort_by_map = field.sort_by_field_index.and_then(|sort_fi| {
            // Verify the sort-by field exists in the cache
            let _ = self.cache.get_field(sort_fi)?;
            let base_field_count = self.cache.fields.len();
            let mut mapping: FxHashMap<ValueId, ValueId> = FxHashMap::default();
            for (rec_idx, record) in self.cache.records.iter().enumerate() {
                if !self.cache.filter_mask[rec_idx] {
                    continue;
                }
                // Keyed by MEMBER id, the id the level's sorted values carry.
                let display_vid = record_member_at(
                    record, rec_idx, field.source_index,
                    base_field_count, &self.cache.virtual_records,
                );
                // Only store the first mapping (1:1 relationship expected; MIN semantics)
                mapping.entry(display_vid).or_insert_with(|| {
                    record_value_at(
                        record, rec_idx, sort_fi,
                        base_field_count, &self.cache.virtual_records,
                    )
                });
            }
            Some((sort_fi, mapping))
        });
        self.sort_value_ids(
            &mut sorted_ids,
            field_cache,
            &field.sort_order,
            &sort_by_map,
            source_order.get(level).and_then(Option::as_ref),
        );

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
                    blank_in_field,
                    source_order,
                    &child_path,
                );
            }

            nodes.push(node);
        }

        nodes
    }

    /// Sorts value IDs based on sort order.
    /// When `sort_by_map` is provided (sort-by-column), items are compared using
    /// the mapped sort-by field's values instead of the display field's own values.
    /// `source_order` is the record index at which the source first shows each
    /// item (built by `build_axis_tree` for a Manual / DataSourceOrder level).
    fn sort_value_ids(
        &self,
        ids: &mut Vec<ValueId>,
        field_cache: &crate::cache::FieldCache,
        sort_order: &crate::definition::SortOrder,
        sort_by_map: &Option<(FieldIndex, FxHashMap<ValueId, ValueId>)>,
        source_order: Option<&FxHashMap<ValueId, usize>>,
    ) {
        use crate::definition::SortOrder;

        match sort_order {
            SortOrder::Ascending => {
                if let Some((sort_fi, mapping)) = sort_by_map {
                    if let Some(sort_fc) = self.cache.get_field(*sort_fi) {
                        ids.sort_by(|&a, &b| {
                            let sa = mapping.get(&a).copied().unwrap_or(a);
                            let sb = mapping.get(&b).copied().unwrap_or(b);
                            self.compare_values(sort_fc, sa, sb)
                        });
                    } else {
                        ids.sort_by(|&a, &b| self.compare_values(field_cache, a, b));
                    }
                } else {
                    ids.sort_by(|&a, &b| self.compare_values(field_cache, a, b));
                }
            }
            SortOrder::Descending => {
                if let Some((sort_fi, mapping)) = sort_by_map {
                    if let Some(sort_fc) = self.cache.get_field(*sort_fi) {
                        ids.sort_by(|&a, &b| {
                            let sa = mapping.get(&a).copied().unwrap_or(a);
                            let sb = mapping.get(&b).copied().unwrap_or(b);
                            self.compare_values(sort_fc, sb, sa)
                        });
                    } else {
                        ids.sort_by(|&a, &b| self.compare_values(field_cache, b, a));
                    }
                } else {
                    ids.sort_by(|&a, &b| self.compare_values(field_cache, b, a));
                }
            }
            SortOrder::Manual | SortOrder::DataSourceOrder => {
                // The order the SOURCE first shows each item (wave F, Z2),
                // never the order a hash set yields them. MANUAL is the same
                // order: a definition stores no manual item order, so the
                // source's is the one there is. Both override sort-by-column.
                // An item no record shows (show items with no data: a
                // calculation group's declared items, pre-interned in
                // declaration order) follows, in the cache's own order -- its
                // ValueId, which is also the tiebreak that keeps this total.
                ids.sort_unstable_by_key(|&id| {
                    (source_order.and_then(|first| first.get(&id)).copied().unwrap_or(usize::MAX), id)
                });
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
                    
                    (CacheValue::Text(ta), CacheValue::Text(tb)) => crate::cache::compare_text_excel(ta, tb),
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
        if value_id == VALUE_ID_EMPTY || value_id == VALUE_ID_BLANK {
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
                value_field: None,
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
                    value_field: None,
                });

                // Fix up direct children's parent_index from placeholder to actual
                for i in child_start..(my_index as usize) {
                    if items[i].parent_index == i32::MIN {
                        items[i].parent_index = my_index;
                    }
                }
            } else {
                // Rows, or columns without expanded children: original order.
                // With an AtTop subtotal the subtotal row is pushed BEFORE the
                // main item, so the main item lands one slot later — compute
                // its index up front so both the subtotal's parent_index and
                // the children's parent_index point at the main item.
                let at_top = wants_subtotal && matches!(subtotal_location, SubtotalLocation::AtTop);
                let my_index = items.len() as i32 + if at_top { 1 } else { 0 };

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
                        value_field: None,
                    }
                };

                // SubtotalLocation::AtTop: insert subtotal BEFORE the main item
                if at_top {
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
                    value_field: None,
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
    
    /// Several value fields are a level of the ROW axis: every value row stands
    /// for ONE value field (its `FlatAxisItem::value_field`), and with no
    /// column field the view has ONE value column, not one per value field.
    fn values_on_rows(&self) -> bool {
        self.definition.value_fields.len() > 1
            && matches!(self.definition.layout.values_position, ValuesPosition::Rows)
    }

    /// The unified value-column order of a view with NO column field: every
    /// value field and calculated field, in order -- or, with the values on
    /// rows, ONE column for "the row's own value" (the first value slot)
    /// followed by the calculated fields.
    fn value_columns_without_col_fields(&self) -> Vec<ValueColumnRef> {
        let order = self.definition.effective_value_column_order();
        if !self.values_on_rows() {
            return order;
        }
        let mut out = Vec::with_capacity(order.len());
        let mut value_slot_taken = false;
        for col_ref in order {
            match col_ref {
                ValueColumnRef::Value(i) => {
                    if !value_slot_taken {
                        value_slot_taken = true;
                        out.push(ValueColumnRef::Value(i));
                    }
                }
                other => out.push(other),
            }
        }
        out
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

    /// Builds the group_path vector from a FlatAxisItem's group_values. Only
    /// the "all values" padding is left out: a blank MEMBER is
    /// `VALUE_ID_BLANK`, so it is named like any other member (every other
    /// group-path builder in this file follows the same rule).
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
        let col_order = self.value_columns_without_col_fields();
        let total_value_cols = col_order.len();

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
        // Use effective_col_fields to check for real column fields (not just grand total col_item)
        if self.effective_col_fields.is_empty() {
            // No column fields - one column per entry in the unified order
            if total_value_cols == 0 {
                // No value or calculated fields - add a single blank data column
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
                for (i, col_ref) in col_order.iter().enumerate() {
                    let col_idx = row_label_cols + i;
                    let group_values = match col_ref {
                        // Values on rows: the one value column is every
                        // value field's (the row says which).
                        ValueColumnRef::Value(_) if self.values_on_rows() => Vec::new(),
                        ValueColumnRef::Value(vi) => vec![*vi as ValueId],
                        ValueColumnRef::Calculated(_) => Vec::new(),
                    };
                    descriptors.push(PivotColumnDescriptor {
                        view_col: col_idx,
                        col_type: PivotColumnType::Data,
                        depth: 0,
                        width_hint: 100,
                        parent_index: None,
                        children_indices: Vec::new(),
                        group_values,
                    });
                }
            }
        } else {
            // Generate from column items (column fields present)
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
            // Calculated field columns: one per (column item × calc field),
            // appended after the col_item columns to match the data cells.
            let calc_count = self.definition.calculated_fields.len();
            let calc_start = self.col_items.len();
            for (i, item) in self.col_items.iter().enumerate() {
                for c in 0..calc_count {
                    let col_idx = row_label_cols + calc_start + i * calc_count + c;
                    descriptors.push(PivotColumnDescriptor {
                        view_col: col_idx,
                        col_type: PivotColumnType::Data,
                        depth: item.depth as u8,
                        width_hint: 100,
                        parent_index: None,
                        children_indices: Vec::new(),
                        group_values: item.group_values.clone(),
                    });
                }
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
            // Use effective_col_fields to check for real column fields (not just a grand total col_item)
            if self.effective_col_fields.is_empty() {
                // No column fields - show value field names (or blank if no values)
                // Generate headers using the unified value column order
                let col_order = self.value_columns_without_col_fields();
                if col_order.is_empty() {
                    // No value or calculated fields - add blank header
                    if is_last_header {
                        cells.push(PivotViewCell::column_header(String::new()));
                    } else {
                        cells.push(PivotViewCell::corner());
                    }
                } else {
                    for col_ref in &col_order {
                        let name = match col_ref {
                            // Values on rows: the row labels name the
                            // values; the one value column needs no name.
                            ValueColumnRef::Value(_) if self.values_on_rows() => String::new(),
                            ValueColumnRef::Value(i) => {
                                let vf = &self.definition.value_fields[*i];
                                vf.custom_name.clone().unwrap_or_else(|| vf.name.clone())
                            }
                            ValueColumnRef::Calculated(i) => self.definition.calculated_fields[*i].name.clone(),
                        };
                        if is_last_header {
                            cells.push(PivotViewCell::column_header(name));
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
                            // Format the dimension value with the field's number
                            // format (e.g. a numeric/date column on the axis).
                            ch.number_format = self
                                .effective_col_fields
                                .get(value_depth)
                                .and_then(|f| f.number_format.clone());
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
                        } else if value_depth < item.group_values.len()
                            && value_depth < item.field_indices.len()
                        {
                            // No ancestor item exists (value-field expansion removed
                            // the parent). Reconstruct the column field label from
                            // the item's group_values at this depth.
                            let gv = item.group_values[value_depth];
                            let fi = item.field_indices[value_depth];
                            // Use a synthetic "ancestor index" based on the group
                            // value to detect group boundaries.
                            let synth_key = usize::MAX - (gv as usize);
                            if current_group != Some(synth_key) {
                                current_group = Some(synth_key);
                                let label = if let Some(fc) = self.cache.fields.get(fi) {
                                    self.get_value_label(fc, gv)
                                } else {
                                    format!("{}", gv)
                                };
                                PivotViewCell::column_header(label)
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
                // Add calculated field headers after the col_item columns:
                // one per (column item × calc field), matching the calculated
                // data cells emitted per column intersection.
                for item in &col_items_snap {
                    for cf in &self.definition.calculated_fields {
                        if is_last_header {
                            let label = if item.is_grand_total {
                                format!("{} (Total)", cf.name)
                            } else {
                                format!("{} ({})", cf.name, item.label)
                            };
                            cells.push(PivotViewCell::column_header(label));
                        } else {
                            cells.push(PivotViewCell::corner());
                        }
                    }
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
        let calc_fields = self.definition.calculated_fields.clone();
        let values_position = self.definition.layout.values_position;
        let report_layout = self.definition.layout.report_layout;
        let repeat_row_labels = self.definition.layout.repeat_row_labels;
        let base_row_offset = view.row_count;

        // Detect if any calculated field uses visual calc functions.
        // If so, pre-compute value maps for ALL rows to enable cross-row lookups.
        let needs_visual_ctx = calc_fields.iter().any(|cf| {
            crate::calculated::parse_calc_formula(&cf.formula)
                .map(|expr| crate::calculated::uses_visual_calc_functions(&expr))
                .unwrap_or(false)
        });

        let visual_data: Option<VisualRowData> = if needs_visual_ctx {
            Some(self.build_visual_row_data(&row_items, &col_items, &value_fields))
        } else {
            None
        };

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
                    } else {
                        // Format the dimension value with the field's number format.
                        cell.number_format = self
                            .effective_row_fields
                            .get(item.depth)
                            .and_then(|f| f.number_format.clone());
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
                            } else {
                                cell.number_format = self
                                    .effective_row_fields
                                    .get(item.depth)
                                    .and_then(|f| f.number_format.clone());
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
            let vctx = visual_data.as_ref().map(|vd| (&row_items[..], vd));
            self.generate_data_cells_for_row(&mut cells, item, row_idx, &col_items, &value_fields, values_position, vctx);

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
    
    /// Builds the shared per-view data that visual calculation functions need:
    /// value maps for every row (as row totals AND per column intersection when
    /// column fields exist), axis field names, and the grand-total value map
    /// (computed even when the grand-total row is hidden).
    fn build_visual_row_data(
        &mut self,
        row_items: &[FlatAxisItem],
        col_items: &[FlatAxisItem],
        value_fields: &[ValueField],
    ) -> VisualRowData {
        use std::collections::HashMap;

        let build_map = |calc: &mut Self, col_values: &[ValueId]| -> HashMap<String, f64> {
            let mut fv = HashMap::new();
            for (vf_idx, vf) in value_fields.iter().enumerate() {
                let aggregate = calc.lookup_aggregate_col(col_values, vf_idx, vf.aggregation);
                if let Some(fc) = calc.cache.get_field(vf.source_index) {
                    fv.insert(fc.name.clone(), aggregate);
                }
                fv.insert(vf.name.clone(), aggregate);
            }
            fv
        };

        let row_values_totals: Vec<HashMap<String, f64>> = row_items.iter().map(|item| {
            self.prepare_row_key(&item.group_values);
            build_map(self, &[])
        }).collect();

        // Per-column row maps so ROWS-axis window functions see the current
        // column's values. Only needed when real column fields exist.
        let row_values_by_col: Vec<Vec<HashMap<String, f64>>> = if self.effective_col_fields.is_empty() {
            Vec::new()
        } else {
            col_items.iter().map(|ci| {
                row_items.iter().map(|item| {
                    self.prepare_row_key(&item.group_values);
                    build_map(self, &ci.group_values)
                }).collect()
            }).collect()
        };

        self.prepare_row_key(&[]);
        let grand_total_values = build_map(self, &[]);

        VisualRowData {
            row_values_totals,
            row_values_by_col,
            field_names_by_depth: self.effective_row_fields.iter().map(|f| f.name.clone()).collect(),
            grand_total_values,
        }
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
            value_field: None,
        };

        let col_items = std::mem::take(&mut self.col_items);
        let value_fields = self.definition.value_fields.clone();
        let values_position = self.definition.layout.values_position;

        // Even with no row fields, visual-calc formulas need a valid (single
        // grand-total row) context — an empty row_items slice would make the
        // evaluators index out of bounds.
        let needs_visual_ctx = self.definition.calculated_fields.iter().any(|cf| {
            crate::calculated::parse_calc_formula(&cf.formula)
                .map(|expr| crate::calculated::uses_visual_calc_functions(&expr))
                .unwrap_or(false)
        });
        let single_items = vec![grand_total_item.clone()];
        let visual_data: Option<VisualRowData> = if needs_visual_ctx {
            Some(self.build_visual_row_data(&single_items, &col_items, &value_fields))
        } else {
            None
        };
        let vctx = visual_data.as_ref().map(|vd| (&single_items[..], vd));
        self.generate_data_cells_for_row(&mut cells, &grand_total_item, 0, &col_items, &value_fields, values_position, vctx);

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
        row_idx: usize,
        col_items: &[FlatAxisItem],
        value_fields: &[ValueField],
        values_position: ValuesPosition,
        visual_ctx_data: Option<(&[FlatAxisItem], &VisualRowData)>,
    ) {
        
        // Handle case with no value fields - generate blank cells
        // (but not if we have calculated fields — those need the unified order path)
        if value_fields.is_empty() && self.definition.calculated_fields.is_empty() {
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

        // Use effective_col_fields to determine if there are real column fields.
        // col_items may contain a grand total item even without real column fields.
        let has_real_col_fields = !self.effective_col_fields.is_empty();
        if !has_real_col_fields {
            // No column fields — emit cells in the unified value column order.
            // Pre-compute value field aggregates for calculated field evaluation.
            use std::collections::HashMap;
            let mut field_values: HashMap<String, f64> = HashMap::new();
            let mut vf_aggregates: Vec<f64> = Vec::with_capacity(value_fields.len());
            for (vf_idx, vf) in value_fields.iter().enumerate() {
                let aggregate = self.lookup_aggregate_col(&[], vf_idx, vf.aggregation);
                vf_aggregates.push(aggregate);
                if let Some(fc) = self.cache.get_field(vf.source_index) {
                    field_values.insert(fc.name.clone(), aggregate);
                }
                field_values.insert(vf.name.clone(), aggregate);
            }

            let values_on_rows = self.values_on_rows();
            let col_order = self.value_columns_without_col_fields();
            for col_ref in col_order.iter() {
                match col_ref {
                    ValueColumnRef::Value(vf_idx) => {
                        // Values on rows: the ONE value column shows the
                        // row's own value field; a row that stands for none
                        // (a total row of the value level) shows nothing.
                        let vf_idx = if values_on_rows {
                            match row_item.value_field {
                                Some(own) => own,
                                None => {
                                    cells.push(PivotViewCell::blank());
                                    continue;
                                }
                            }
                        } else {
                            *vf_idx
                        };
                        if vf_idx >= value_fields.len() { continue; }
                        let vf = &value_fields[vf_idx];
                        let aggregate = vf_aggregates[vf_idx];

                        let display_value = self.transform_show_values_as(
                            aggregate, &row_item.group_values, &[],
                            vf_idx, vf.aggregation, vf.show_values_as,
                        );

                        let mut cell = PivotViewCell::data(display_value);
                        cell.number_format = vf.number_format.clone();
                        cell.value_field_index = Some(vf_idx);
                        // The row's identity. Every consumer of a value cell
                        // reads it: GETPIVOTDATA's field/item form matches on
                        // it (an empty path matched nothing, so every
                        // `=GETPIVOTDATA("Sum of Sales";E1;"Region";"North")`
                        // on a pivot without column fields answered #REF!,
                        // BUG-0146), the point-mode pick builds its pairs from
                        // it (an empty path wrote the GRAND-TOTAL form for
                        // every cell), and a drill-through sends it (an empty
                        // path drilled the whole dataset). The column-field
                        // branch below and the calculated cells always set it.
                        cell.group_path = Self::build_group_path(row_item);

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
                            cell.is_bold = true;
                        }

                        cells.push(cell);
                    }
                    ValueColumnRef::Calculated(cf_idx) => {
                        let cf_idx = *cf_idx;
                        if cf_idx >= self.definition.calculated_fields.len() { continue; }
                        let cf = &self.definition.calculated_fields[cf_idx];

                        let result = if let Some((ri, vd)) = visual_ctx_data {
                            let ctx = crate::calculated::VisualCalcContext {
                                current_row_idx: row_idx,
                                row_items: ri,
                                row_values: &vd.row_values_totals,
                                field_names_by_depth: &vd.field_names_by_depth,
                                grand_total_values: Some(&vd.grand_total_values),
                                col_ctx: None,
                            };
                            crate::calculated::eval_calc_formula_with_ctx(&cf.formula, &field_values, &ctx)
                                .unwrap_or_else(crate::calculated::CalcValue::Error)
                        } else {
                            crate::calculated::eval_calc_formula(&cf.formula, &field_values)
                                .unwrap_or_else(crate::calculated::CalcValue::Error)
                        };

                        // Make this calc field's value visible to calc fields
                        // that come later in the column order (same-row refs).
                        if let crate::calculated::CalcValue::Number(n) = &result {
                            field_values.insert(cf.name.clone(), *n);
                        }

                        // A number format only makes sense for numeric results; text /
                        // boolean / error results carry their own display.
                        let is_numeric = matches!(result, crate::calculated::CalcValue::Number(_));
                        let mut cell = PivotViewCell::data_value(result.into());
                        if is_numeric {
                            cell.number_format = cf.number_format.clone();
                        }
                        // Row context for drill-through (empty group_path would
                        // drill the whole dataset).
                        cell.group_path = Self::build_group_path(row_item);

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
                }
            }
        } else if value_fields.is_empty() {
            // Column fields + calculated fields but no value fields: blank
            // value cells (indexing value_fields[0] would panic); the
            // calculated cells are appended below.
            for _ in col_items {
                cells.push(PivotViewCell::blank());
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

                // Values on rows: the ROW names the value field (the column
                // cannot -- `extract_value_field_from_column` answers 0 when
                // the values are not on columns, and every value row used to
                // show the first value field's numbers).
                let vf_idx = match (values_position, row_item.value_field) {
                    (ValuesPosition::Rows, Some(own)) if value_fields.len() > 1 => own,
                    _ => vf_idx,
                };
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

        // Generate calculated field cells (only for real column fields case — the
        // no-column-fields case handles them inline via the unified value_column_order)
        if has_real_col_fields && !self.definition.calculated_fields.is_empty() {
            self.generate_calculated_field_cells(cells, row_item, row_idx, col_items, value_fields, values_position, visual_ctx_data);
        }
    }

    /// Generates cells for calculated fields by evaluating their formulas
    /// against the aggregated values of regular value fields.
    ///
    /// With column fields present this emits one cell per (column item ×
    /// calculated field), evaluated at that column intersection; the column
    /// descriptors and header rows emit matching columns so data rows and
    /// headers stay aligned.
    fn generate_calculated_field_cells(
        &mut self,
        cells: &mut Vec<PivotViewCell>,
        row_item: &FlatAxisItem,
        row_idx: usize,
        col_items: &[FlatAxisItem],
        value_fields: &[ValueField],
        _values_position: ValuesPosition,
        row_visual_ctx: Option<(&[FlatAxisItem], &VisualRowData)>,
    ) {
        use std::collections::HashMap;

        let calc_fields = self.definition.calculated_fields.clone();

        // Check if any calc fields use visual calc functions (for column axis support)
        let needs_col_ctx = calc_fields.iter().any(|cf| {
            crate::calculated::parse_calc_formula(&cf.formula)
                .map(|expr| crate::calculated::uses_visual_calc_functions(&expr))
                .unwrap_or(false)
        });

        if col_items.is_empty() {
            // No column items - one cell per calculated field
            let mut field_values: HashMap<String, f64> = HashMap::new();
            for (vf_idx, vf) in value_fields.iter().enumerate() {
                let aggregate = self.lookup_aggregate_col(&[], vf_idx, vf.aggregation);
                if let Some(fc) = self.cache.get_field(vf.source_index) {
                    field_values.insert(fc.name.clone(), aggregate);
                }
                field_values.insert(vf.name.clone(), aggregate);
            }

            for cf in &calc_fields {
                let result = if let Some((ri, vd)) = row_visual_ctx {
                    let ctx = crate::calculated::VisualCalcContext {
                        current_row_idx: row_idx,
                        row_items: ri,
                        row_values: &vd.row_values_totals,
                        field_names_by_depth: &vd.field_names_by_depth,
                        grand_total_values: Some(&vd.grand_total_values),
                        col_ctx: None,
                    };
                    crate::calculated::eval_calc_formula_with_ctx(&cf.formula, &field_values, &ctx)
                        .unwrap_or_else(crate::calculated::CalcValue::Error)
                } else {
                    crate::calculated::eval_calc_formula(&cf.formula, &field_values)
                        .unwrap_or_else(crate::calculated::CalcValue::Error)
                };

                // Same-row visibility for calc fields defined later.
                if let crate::calculated::CalcValue::Number(n) = &result {
                    field_values.insert(cf.name.clone(), *n);
                }

                let is_numeric = matches!(result, crate::calculated::CalcValue::Number(_));
                let mut cell = PivotViewCell::data_value(result.into());
                if is_numeric {
                    cell.number_format = cf.number_format.clone();
                }
                cell.group_path = Self::build_group_path(row_item);

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
            // With column fields - one calculated field cell per column item.
            // Pre-compute column values for column-axis window functions.
            let all_col_values: Vec<HashMap<String, f64>> = if needs_col_ctx {
                col_items.iter().map(|ci| {
                    let mut fv = HashMap::new();
                    for (vf_idx, vf) in value_fields.iter().enumerate() {
                        let agg = self.lookup_aggregate_col(&ci.group_values, vf_idx, vf.aggregation);
                        if let Some(fc) = self.cache.get_field(vf.source_index) {
                            fv.insert(fc.name.clone(), agg);
                        }
                        fv.insert(vf.name.clone(), agg);
                    }
                    fv
                }).collect()
            } else {
                Vec::new()
            };
            let col_field_names: Vec<String> = self.effective_col_fields.iter()
                .map(|f| f.name.clone())
                .collect();

            for (col_idx, col_item) in col_items.iter().enumerate() {
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
                    let result = if needs_col_ctx || row_visual_ctx.is_some() {
                        let col_ctx = if needs_col_ctx {
                            Some(crate::calculated::ColumnAxisContext {
                                current_col_idx: col_idx,
                                col_items,
                                col_values: &all_col_values,
                                field_names_by_depth: &col_field_names,
                            })
                        } else {
                            None
                        };
                        // ROWS-axis functions must see the CURRENT column's row
                        // values, not row totals — per-column maps when available.
                        let empty_ri: &[FlatAxisItem] = &[];
                        let empty_rv: &[std::collections::HashMap<String, f64>] = &[];
                        let empty_fnd: &[String] = &[];
                        let (ri, rv, fnd, gt) = match row_visual_ctx {
                            Some((ri, vd)) => (
                                ri,
                                vd.row_values_by_col
                                    .get(col_idx)
                                    .map(|v| &v[..])
                                    .unwrap_or(&vd.row_values_totals[..]),
                                &vd.field_names_by_depth[..],
                                Some(&vd.grand_total_values),
                            ),
                            None => (empty_ri, empty_rv, empty_fnd, None),
                        };
                        let ctx = crate::calculated::VisualCalcContext {
                            current_row_idx: row_idx,
                            row_items: ri,
                            row_values: rv,
                            field_names_by_depth: fnd,
                            grand_total_values: gt,
                            col_ctx,
                        };
                        crate::calculated::eval_calc_formula_with_ctx(&cf.formula, &field_values, &ctx)
                            .unwrap_or_else(crate::calculated::CalcValue::Error)
                    } else {
                        crate::calculated::eval_calc_formula(&cf.formula, &field_values)
                            .unwrap_or_else(crate::calculated::CalcValue::Error)
                    };

                    // Same-row visibility for calc fields defined later.
                    if let crate::calculated::CalcValue::Number(n) = &result {
                        field_values.insert(cf.name.clone(), *n);
                    }

                    let is_numeric = matches!(result, crate::calculated::CalcValue::Number(_));
                    let mut cell = PivotViewCell::data_value(result.into());
                    if is_numeric {
                        cell.number_format = cf.number_format.clone();
                    }

                    // Row + column context for drill-through.
                    let mut group_path = Self::build_group_path(row_item);
                    for (i, &val) in col_item.group_values.iter().enumerate() {
                        if val != VALUE_ID_EMPTY && i < col_item.field_indices.len() {
                            group_path.push((col_item.field_indices[i], val));
                        }
                    }
                    cell.group_path = group_path;

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
pub(crate) fn format_date_level_name(field_name: &str, level: DateGroupLevel) -> String {
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
pub(crate) fn date_to_cache_value(date: &crate::cache::ParsedDate, level: DateGroupLevel) -> CacheValue {
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
pub(crate) fn record_value_at(
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

/// [`record_value_at`] as a MEMBER id -- the id an axis item and a group key
/// carry (a blank value is `VALUE_ID_BLANK`; see `crate::cache::member_id`).
/// `record_value_at` itself keeps the record's own spelling: its callers
/// (lookup-attribute labels, sort-by-column values) read RECORD values.
fn record_member_at(
    record: &crate::cache::CacheRecord,
    record_idx: usize,
    field_source_index: usize,
    base_field_count: usize,
    virtual_records: &[Vec<ValueId>],
) -> ValueId {
    member_id(record_value_at(record, record_idx, field_source_index, base_field_count, virtual_records))
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
            let display = vf.custom_name.clone().unwrap_or_else(|| vf.name.clone());
            items.push(FlatAxisItem {
                group_values: vec![i as ValueId], // Use value field index as pseudo-ID
                label: display,
                depth: 0,
                is_subtotal: false,
                is_grand_total: false,
                has_children: false,
                is_collapsed: false,
                parent_index: -1,
                // NO field: the Values level is not an item of any source
                // column, exactly as the pushed pseudo-id below is never
                // matched to one (it sits past `field_indices`). Naming the
                // value field's source column here turned the value-field
                // INDEX into an "item" of that column in every group path
                // built from this item -- a drill-through listed the one
                // record whose value was that id, and the point-mode
                // GETPIVOTDATA pick wrote `"Sales";"150"`.
                field_indices: Vec::new(),
                attribute_labels: Vec::new(),
                value_field: Some(i),
            });
        }
        return;
    }

    // For each existing item, create copies for each value field.
    // Leaf items get a synthetic parent inserted so that column headers
    // can display the column field value (e.g. "USA") above the measure
    // names (e.g. "TotalSales").
    let original_items = std::mem::take(items);

    for item in original_items {
        if item.is_grand_total || item.is_subtotal {
            // For totals, add value field variants
            for (i, vf) in value_fields.iter().enumerate() {
                let display = vf.custom_name.clone().unwrap_or_else(|| vf.name.clone());
                let mut new_item = item.clone();
                new_item.group_values.push(i as ValueId);
                new_item.value_field = Some(i);
                new_item.label = if item.is_grand_total {
                    format!("Grand Total - {}", display)
                } else {
                    format!("{} - {}", item.label, display)
                };
                items.push(new_item);
            }
        } else if !item.has_children || item.is_collapsed {
            // Leaf items or collapsed items get value field children
            for (i, vf) in value_fields.iter().enumerate() {
                let display = vf.custom_name.clone().unwrap_or_else(|| vf.name.clone());
                let mut new_item = item.clone();
                new_item.group_values.push(i as ValueId);
                new_item.value_field = Some(i);
                new_item.label = display;
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
///
/// `group_path` holds MEMBER ids, as the view's cells carry them: a blank
/// member is `VALUE_ID_BLANK` and matches the records whose value is blank. A
/// grouped (virtual) field -- a date level, a number bin, a manual group --
/// is read from the virtual records; `record.values` has no entry for it.
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
    for (record_idx, record) in cache.filtered_records_indexed() {
        // Check if record matches all group path filters
        let matches = group_path.iter().all(|(field_idx, value_id)| {
            member_id(cache.get_record_value_id(record_idx, *field_idx)) == *value_id
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

// ============================================================================
// RAGGED HIERARCHY SUPPORT
// ============================================================================

/// Determines if a label represents a blank/null value in the hierarchy.
fn is_blank_label(label: &str) -> bool {
    label == "(blank)" || label.is_empty()
}

/// Per tree level, every parent path (the member ids of the levels above,
/// as the flattened items carry them in `group_values`) mapped to its
/// children's member ids IN THE ORDER THE AXIS SHOWS THEM -- the siblings
/// Show Values As walks (`PivotCalculator::resolve_base_field`). Built from
/// the finished tree, so every sort order (including the ones that keep the
/// order the tree was built in) and every hidden item is already applied.
fn sibling_order_of(tree: &[AxisNode], levels: usize) -> Vec<FxHashMap<Vec<ValueId>, Vec<ValueId>>> {
    fn walk(
        nodes: &[AxisNode],
        level: usize,
        path: &mut Vec<ValueId>,
        orders: &mut [FxHashMap<Vec<ValueId>, Vec<ValueId>>],
    ) {
        if nodes.is_empty() || level >= orders.len() {
            return;
        }
        orders[level].insert(path.clone(), nodes.iter().map(|n| n.value_id).collect());
        for node in nodes {
            path.push(node.value_id);
            walk(&node.children, level + 1, path, orders);
            path.pop();
        }
    }
    let mut orders = vec![FxHashMap::default(); levels];
    let mut path = Vec::with_capacity(levels);
    walk(tree, 0, &mut path, &mut orders);
    orders
}

/// Applies ragged hierarchy behavior to a tree of axis nodes.
/// `current_depth` is the depth in the overall tree (0 = root level).
/// The function navigates to the hierarchy's field range and applies the behavior there.
fn apply_ragged_behavior(
    nodes: &mut Vec<AxisNode>,
    config: &HierarchyConfig,
    current_depth: usize,
) {
    if current_depth < config.field_start {
        // Not yet at the hierarchy's start — recurse deeper
        for node in nodes.iter_mut() {
            if !node.children.is_empty() {
                apply_ragged_behavior(&mut node.children, config, current_depth + 1);
            }
        }
        return;
    }

    let hierarchy_level = current_depth - config.field_start;
    if hierarchy_level >= config.field_count {
        return; // Past the end of this hierarchy
    }

    match config.ragged_behavior {
        RaggedBehavior::ShowBlanks => {
            // Default: no transformation needed. Blanks appear as "(blank)".
            for node in nodes.iter_mut() {
                if !node.children.is_empty() {
                    apply_ragged_behavior(&mut node.children, config, current_depth + 1);
                }
            }
        }
        RaggedBehavior::ShowAsLeaf => {
            // Nodes whose children at the next level are ALL blank become leaves.
            // Mixed parents (some non-blank children) keep the non-blank children
            // and show blank children's grandchildren as direct leaves.
            for node in nodes.iter_mut() {
                if !node.children.is_empty() {
                    let has_non_blank = node.children.iter().any(|c| !is_blank_label(&c.label));
                    if !has_non_blank {
                        // All children are blank — make this a leaf
                        node.children.clear();
                    } else {
                        // Mixed: keep non-blank children; for blank children,
                        // promote their grandchildren as direct leaf children.
                        let mut new_children = Vec::new();
                        for child in node.children.drain(..) {
                            if is_blank_label(&child.label) {
                                // Promote grandchildren (cities with null state)
                                for mut gc in child.children {
                                    gc.depth = child.depth;
                                    // Grandchildren promoted to this level are leaves
                                    gc.children.clear();
                                    new_children.push(gc);
                                }
                            } else {
                                new_children.push(child);
                            }
                        }
                        node.children = new_children;
                        apply_ragged_behavior(&mut node.children, config, current_depth + 1);
                    }
                }
            }
        }
        RaggedBehavior::HideMembers => {
            // Skip blank intermediate nodes: promote their children up.
            // Recurse first so deeper levels are clean.
            for node in nodes.iter_mut() {
                if !node.children.is_empty() {
                    apply_ragged_behavior(&mut node.children, config, current_depth + 1);
                }
            }
            // Promote: blank nodes → replaced by their children at this depth
            let mut new_nodes = Vec::with_capacity(nodes.len());
            for node in nodes.drain(..) {
                if is_blank_label(&node.label) && !node.children.is_empty() {
                    for mut child in node.children {
                        child.depth = node.depth;
                        new_nodes.push(child);
                    }
                } else if is_blank_label(&node.label) && node.children.is_empty() {
                    // Blank leaf with no children: skip entirely
                    continue;
                } else {
                    new_nodes.push(node);
                }
            }
            *nodes = new_nodes;
        }
        RaggedBehavior::RepeatParent => {
            // Fill blank children's labels with the parent node's label.
            for node in nodes.iter_mut() {
                if !node.children.is_empty() {
                    for child in node.children.iter_mut() {
                        if is_blank_label(&child.label) {
                            child.label = node.label.clone();
                        }
                    }
                    apply_ragged_behavior(&mut node.children, config, current_depth + 1);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::CellValue;
    use crate::definition::{PivotField, ValueField, AggregationType, PivotId};

    fn test_pivot_id() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    }

    fn create_test_cache() -> PivotCache {
        let mut cache = PivotCache::new(test_pivot_id(), 3);
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
        let mut def = PivotDefinition::new(test_pivot_id(), (0, 0), (4, 2));
        
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
        let mut cache = PivotCache::new(test_pivot_id(), 3);
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

        let mut definition = PivotDefinition::new(test_pivot_id(), (0, 0), (2, 2));
        let region_field = PivotField::new(0, "Region".to_string());
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
        // filter_row_count includes the spacing row after the filter fields
        assert_eq!(view.filter_row_count, 2);
        assert_eq!(view.filter_rows.len(), 1);
        assert_eq!(view.filter_rows[0].field_name, "Region");
    }

    /// Every data/header row in a view must have exactly view.col_count cells —
    /// misalignment paints cells outside the table frame.
    fn assert_view_aligned(view: &PivotView) {
        for (i, row_cells) in view.cells.iter().enumerate() {
            assert_eq!(
                row_cells.len(),
                view.col_count,
                "row {} has {} cells but view.col_count is {}",
                i,
                row_cells.len(),
                view.col_count
            );
        }
    }

    #[test]
    fn test_calc_columns_stay_aligned_with_column_fields() {
        use crate::definition::CalculatedField;

        let mut cache = create_test_cache();
        let mut definition = create_test_definition(); // Region rows, Product cols
        definition.calculated_fields.push(CalculatedField {
            name: "Dbl".to_string(),
            formula: "'Sum of Sales' * 2".to_string(),
            number_format: None,
        });

        let view = calculate_pivot(&definition, &mut cache);
        assert_view_aligned(&view);
    }

    #[test]
    fn test_rows_axis_window_uses_current_column_not_row_totals() {
        use crate::definition::CalculatedField;
        use crate::view::PivotCellValue;

        // ROWS: Region (North, South), COLUMNS: Product, values per intersection:
        // North/Apples=100, North/Oranges=150, South/Apples=200, South/Oranges=250.
        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        definition.calculated_fields.push(CalculatedField {
            name: "Prev".to_string(),
            formula: "PREVIOUS('Sum of Sales')".to_string(),
            number_format: None,
        });

        let view = calculate_pivot(&definition, &mut cache);
        assert_view_aligned(&view);

        // The South row's Prev cell for the Apples column must be North/Apples
        // (100), not North's row total (250).
        let mut south_prev_values: Vec<f64> = Vec::new();
        for (row_cells, desc) in view.cells.iter().zip(view.rows.iter()) {
            if desc.row_type != PivotRowType::Data { continue; }
            let is_south = row_cells.iter().any(|c| {
                matches!(&c.value, crate::view::PivotCellValue::Text(t) if t == "South")
            });
            if !is_south { continue; }
            for cell in row_cells {
                if let PivotCellValue::Number(n) = cell.value {
                    south_prev_values.push(n);
                }
            }
        }
        assert!(
            south_prev_values.contains(&100.0),
            "South row should contain Prev(Apples)=100 (per-column context); cells: {:?}",
            south_prev_values
        );
        assert!(
            !south_prev_values.contains(&250.0) || south_prev_values.contains(&100.0),
            "Prev must not be computed from row totals"
        );
    }

    #[test]
    fn test_attop_subtotals_keep_hierarchy_intact() {
        use crate::definition::{SubtotalLocation, ReportLayout};

        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        definition.column_fields.clear();
        definition.row_fields.push(PivotField::new(1, "Product".to_string()));
        definition.layout.report_layout = ReportLayout::Outline;
        definition.layout.subtotal_location = SubtotalLocation::AtTop;

        let mut calc = PivotCalculator::new(&definition, &mut cache);
        let _view = calc.calculate();

        for (i, item) in calc.row_items.iter().enumerate() {
            if item.parent_index < 0 { continue; }
            let parent = &calc.row_items[item.parent_index as usize];
            assert!(
                !parent.is_subtotal,
                "item {} ('{}') must not have a subtotal row as its parent",
                i,
                item.label
            );
            assert!(
                item.is_subtotal || parent.has_children,
                "item {} ('{}') should point at a real group row",
                i,
                item.label
            );
        }
    }

    #[test]
    fn test_no_row_fields_with_visual_calc_does_not_panic() {
        use crate::definition::CalculatedField;

        let mut cache = create_test_cache();
        let mut definition = create_test_definition(); // keeps Product columns
        definition.row_fields.clear();
        definition.calculated_fields.push(CalculatedField {
            name: "Run".to_string(),
            formula: "RUNNINGSUM('Sum of Sales') + PARENT('Sum of Sales') + ISATLEVEL(Product)".to_string(),
            number_format: None,
        });

        // This used to index an empty row_items slice and panic.
        let view = calculate_pivot(&definition, &mut cache);
        assert!(view.row_count > 0);
        assert_view_aligned(&view);
    }

    #[test]
    fn test_calc_fields_with_columns_but_no_value_fields() {
        use crate::definition::CalculatedField;

        let mut cache = create_test_cache();
        let mut definition = create_test_definition(); // Region rows, Product cols
        definition.value_fields.clear();
        definition.calculated_fields.push(CalculatedField {
            name: "Const".to_string(),
            formula: "1 + 1".to_string(),
            number_format: None,
        });

        // Used to index value_fields[0] on an empty vec and panic.
        let view = calculate_pivot(&definition, &mut cache);
        assert!(view.row_count > 0);
        assert_view_aligned(&view);
    }

    #[test]
    fn test_calc_field_can_reference_earlier_calc_field() {
        use crate::definition::CalculatedField;
        use crate::view::PivotCellValue;

        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        definition.column_fields.clear();
        definition.calculated_fields.push(CalculatedField {
            name: "Dbl".to_string(),
            formula: "'Sum of Sales' * 2".to_string(),
            number_format: None,
        });
        definition.calculated_fields.push(CalculatedField {
            name: "DblPlus".to_string(),
            formula: "Dbl + 1".to_string(),
            number_format: None,
        });

        let view = calculate_pivot(&definition, &mut cache);
        // North aggregates to 250 -> Dbl 500 -> DblPlus 501.
        let found = view.cells.iter().flatten().any(|c| {
            matches!(c.value, PivotCellValue::Number(n) if n == 501.0)
        });
        assert!(found, "a calc field referencing an earlier calc field should evaluate");
    }

    #[test]
    fn test_grandtotal_calc_survives_hidden_grand_total_row() {
        use crate::definition::CalculatedField;
        use crate::view::PivotCellValue;

        let mut cache = create_test_cache();
        let mut definition = create_test_definition();
        definition.column_fields.clear();
        definition.layout.show_row_grand_totals = false;
        definition.calculated_fields.push(CalculatedField {
            name: "Pct".to_string(),
            formula: "'Sum of Sales' / GRANDTOTAL('Sum of Sales')".to_string(),
            number_format: None,
        });

        let view = calculate_pivot(&definition, &mut cache);
        // North 250/700, South 450/700 — must be numbers, not NaN.
        let mut pcts: Vec<f64> = view.cells.iter().flatten().filter_map(|c| {
            if let PivotCellValue::Number(n) = c.value {
                if n > 0.0 && n < 1.0 { Some(n) } else { None }
            } else {
                None
            }
        }).collect();
        pcts.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!(
            pcts.iter().any(|p| (p - 250.0 / 700.0).abs() < 1e-9),
            "percent-of-total must work with grand totals hidden; got {:?}",
            pcts
        );
    }

    #[test]
    fn test_calculated_field_text_result() {
        use crate::definition::CalculatedField;
        use crate::view::PivotCellValue;

        // Row-only pivot (Region), a Sum of Sales value, and a text-returning CALC.
        // North aggregates to 250 (-> "Low"), South to 450 and the grand total to 700
        // (-> "High"). This proves an IF that yields text reaches the pivot cell as
        // PivotCellValue::Text end-to-end (not a number/NaN).
        let mut cache = create_test_cache();
        let mut definition = PivotDefinition::new(test_pivot_id(), (0, 0), (4, 2));
        definition.row_fields.push(PivotField::new(0, "Region".to_string()));
        definition.value_fields.push(ValueField::new(2, "Sum of Sales".to_string(), AggregationType::Sum));
        definition.calculated_fields.push(CalculatedField {
            name: "Band".to_string(),
            formula: "IF('Sum of Sales' > 300, \"High\", \"Low\")".to_string(),
            number_format: Some("#,##0".to_string()),
        });

        let view = calculate_pivot(&definition, &mut cache);

        let mut found_high = false;
        let mut found_low = false;
        for row_cells in &view.cells {
            for cell in row_cells {
                if let PivotCellValue::Text(ref s) = cell.value {
                    if s == "High" { found_high = true; }
                    if s == "Low" { found_low = true; }
                }
            }
        }
        assert!(found_high, "an aggregate > 300 should produce a 'High' text cell");
        assert!(found_low, "an aggregate <= 300 should produce a 'Low' text cell");
    }

    /// BUG-0146: a value cell of a pivot WITHOUT column fields must carry its
    /// row's group path -- the field/item form of GETPIVOTDATA, the point-mode
    /// GETPIVOTDATA pick and the drill-through all identify a cell by it. A
    /// parent (subtotal) row names only its own level, and the grand total
    /// names nothing.
    #[test]
    fn value_cells_without_column_fields_carry_the_rows_group_path() {
        let mut cache = create_test_cache();
        let mut definition = PivotDefinition::new(test_pivot_id(), (0, 0), (4, 2));
        definition.row_fields.push(PivotField::new(0, "Region".to_string()));
        definition.row_fields.push(PivotField::new(1, "Product".to_string()));
        definition.value_fields.push(ValueField::new(2, "Sum of Sales".to_string(), AggregationType::Sum));

        let view = calculate_pivot(&definition, &mut cache);

        let label = |field: usize, id: ValueId| cache.get_value_label(field, id).unwrap_or_default();
        let mut paths: Vec<(Vec<(usize, String)>, f64)> = Vec::new();
        for row_cells in &view.cells {
            for cell in row_cells {
                if cell.value_field_index != Some(0) {
                    continue;
                }
                if let crate::view::PivotCellValue::Number(n) = cell.value {
                    let path = cell.group_path.iter().map(|&(f, id)| (f, label(f, id))).collect();
                    paths.push((path, n));
                }
            }
        }
        let find = |want: &[(usize, &str)]| -> Option<f64> {
            paths.iter().find_map(|(p, n)| {
                let same = p.len() == want.len()
                    && p.iter().zip(want.iter()).all(|((f, l), (wf, wl))| f == wf && l == wl);
                if same { Some(*n) } else { None }
            })
        };
        assert_eq!(find(&[(0, "North"), (1, "Apples")]), Some(100.0), "a leaf cell names both levels: {paths:?}");
        assert_eq!(find(&[(0, "South"), (1, "Oranges")]), Some(250.0), "a leaf cell names both levels: {paths:?}");
        assert_eq!(find(&[(0, "North")]), Some(250.0), "a parent row names only its own level: {paths:?}");
        assert_eq!(find(&[]), Some(700.0), "the grand total names nothing: {paths:?}");
    }

    /// Values on ROWS with no row field: every value cell stands for the whole
    /// dataset, so its group path names nothing and a drill-through lists
    /// every record. The Values pseudo-items were built with the value
    /// field's SOURCE column as their field and the value-field index as their
    /// item id, so each cell (and each value label) carried a bogus
    /// `(Sales, 0)` / `(Sales, 1)` pair: a drill-through listed the one
    /// record whose Sales was that "item", and the point-mode GETPIVOTDATA
    /// pick wrote `"Sales";"150"`.
    #[test]
    fn values_on_rows_without_row_fields_name_no_item() {
        for (row_gt, col_gt) in [(true, true), (false, true), (true, false), (false, false)] {
            let mut cache = create_test_cache();
            let mut definition = PivotDefinition::new(test_pivot_id(), (0, 0), (4, 2));
            definition.value_fields.push(ValueField::new(2, "Sum of Sales".to_string(), AggregationType::Sum));
            definition.value_fields.push(ValueField::new(2, "Count of Sales".to_string(), AggregationType::Count));
            definition.layout.values_position = ValuesPosition::Rows;
            definition.layout.show_row_grand_totals = row_gt;
            definition.layout.show_column_grand_totals = col_gt;

            let view = calculate_pivot(&definition, &mut cache);

            let mut value_cells = 0;
            for row_cells in &view.cells {
                for cell in row_cells {
                    let is_value_label = cell.cell_type == crate::view::PivotCellType::RowHeader
                        && (cell.formatted_value == "Sum of Sales" || cell.formatted_value == "Count of Sales");
                    if is_value_label {
                        assert!(
                            cell.group_path.is_empty(),
                            "row_gt={row_gt} col_gt={col_gt}: the value label '{}' names an item: {:?}",
                            cell.formatted_value,
                            cell.group_path
                        );
                    }
                    if cell.value_field_index.is_none() {
                        continue;
                    }
                    value_cells += 1;
                    assert!(
                        cell.group_path.is_empty(),
                        "row_gt={row_gt} col_gt={col_gt}: a whole-dataset value cell names an item: {:?}",
                        cell.group_path
                    );
                    let drilled = drill_down(&definition, &cache, &cell.group_path, 100);
                    assert_eq!(
                        drilled.source_rows.len(),
                        4,
                        "row_gt={row_gt} col_gt={col_gt}: the drill-through of a whole-dataset cell listed a subset"
                    );
                }
            }
            assert!(value_cells >= 2, "row_gt={row_gt} col_gt={col_gt}: fixture: one cell per value field");
        }
    }

    /// "(blank)" is how the view labels a blank item, and hiding it hides the
    /// records whose value is blank. Blanks are never interned (they are
    /// `VALUE_ID_EMPTY`), so resolving the hidden labels against the interned
    /// values alone could never find them: `Region = ("East")`, inverted into
    /// "hide every other item", kept the blank-Region rows (BUG-0197).
    #[test]
    fn hiding_the_blank_item_hides_the_records_whose_value_is_blank() {
        use crate::definition::{FilterCondition, PivotFilter};
        let build = || {
            let mut cache = PivotCache::new(test_pivot_id(), 3);
            cache.set_field_name(0, "Region".to_string());
            cache.set_field_name(1, "Year".to_string());
            cache.set_field_name(2, "Revenue".to_string());
            let rows: [(Option<&str>, f64, f64); 4] = [
                (Some("East"), 2023.0, 10.0),
                (Some("West"), 2023.0, 20.0),
                (None, 2024.0, 30.0),
                (Some("East"), 2024.0, 40.0),
            ];
            for (i, (region, year, revenue)) in rows.iter().enumerate() {
                let region = match region {
                    Some(s) => CellValue::Text(s.to_string()),
                    None => CellValue::Empty,
                };
                cache.add_record(i as u32, &[region, CellValue::Number(*year), CellValue::Number(*revenue)]);
            }
            cache
        };
        let grand_total = |hidden: &[&str]| -> Option<f64> {
            let mut cache = build();
            let mut definition = PivotDefinition::new(test_pivot_id(), (0, 0), (4, 2));
            definition.row_fields.push(PivotField::new(1, "Year".to_string()));
            let mut region = PivotField::new(0, "Region".to_string());
            region.hidden_items = hidden.iter().map(|s| s.to_string()).collect();
            definition.filter_fields.push(PivotFilter { field: region, condition: FilterCondition::ValueList(Vec::new()) });
            definition.value_fields.push(ValueField::new(2, "Revenue".to_string(), AggregationType::Sum));
            let view = calculate_pivot(&definition, &mut cache);
            view.cells.iter().flatten().find(|c| c.cell_type == crate::view::PivotCellType::GrandTotal).and_then(|c| {
                match c.value {
                    crate::view::PivotCellValue::Number(n) => Some(n),
                    _ => None,
                }
            })
        };

        assert_eq!(grand_total(&[]), Some(100.0), "fixture: every record");
        assert_eq!(grand_total(&["West"]), Some(80.0), "fixture: an interned item hides");
        assert_eq!(grand_total(&["West", "(blank)"]), Some(50.0), "hiding (blank) kept the blank-Region record");
        assert_eq!(grand_total(&["(Blank)"]), Some(70.0), "the host spells it (Blank); the label ignores case");
    }
    /// The value cells of every row whose label names a value field, as
    /// (label, [(value field index, number)]) in view order.
    fn value_rows(view: &crate::view::PivotView) -> Vec<(String, Vec<(usize, f64)>)> {
        let mut out = Vec::new();
        for row in &view.cells {
            let label = row.iter().find(|c| c.cell_type == crate::view::PivotCellType::RowHeader).map(|c| c.formatted_value.clone()).unwrap_or_default();
            let cells: Vec<(usize, f64)> = row
                .iter()
                .filter_map(|c| match (c.value_field_index, &c.value) {
                    (Some(i), crate::view::PivotCellValue::Number(n)) => Some((i, *n)),
                    _ => None,
                })
                .collect();
            if !cells.is_empty() {
                out.push((label, cells));
            }
        }
        out
    }

    /// Excel sorts pivot items IGNORING CASE: "YoY" before "YTD" (the byte order
    /// put every capital first). Wave F review finding, 2026-09-29.
    #[test]
    fn row_items_sort_ignoring_case() {
        let mut cache = PivotCache::new(test_pivot_id(), 2);
        cache.set_field_name(0, "Name".to_string());
        cache.set_field_name(1, "Sales".to_string());
        for (i, name) in ["YTD", "YoY", "apple", "Banana"].iter().enumerate() {
            cache.add_record(i as u32, &[CellValue::Text(name.to_string()), CellValue::Number(1.0)]);
        }
        let mut definition = PivotDefinition::new(test_pivot_id(), (0, 0), (4, 1));
        definition.row_fields.push(PivotField::new(0, "Name".to_string()));
        definition.value_fields.push(ValueField::new(1, "Sum of Sales".to_string(), AggregationType::Sum));
        let view = calculate_pivot(&definition, &mut cache);
        let labels: Vec<String> = view
            .cells
            .iter()
            .filter_map(|row| row.first())
            .filter(|c| c.cell_type == crate::view::PivotCellType::RowHeader)
            .map(|c| c.formatted_value.clone())
            .filter(|l| ["YTD", "YoY", "apple", "Banana"].contains(&l.as_str()))
            .collect();
        assert_eq!(labels, vec!["apple", "Banana", "YoY", "YTD"]);
    }

    /// Found live 2026-09-29 (e2e fixall-pivot R4): values on ROWS with no row
    /// or column field showed a 2x2 block -- both value rows carried BOTH
    /// values, the header named both fields -- where Excel shows one column.
    #[test]
    fn values_on_rows_without_fields_show_one_value_per_row() {
        let mut cache = create_test_cache();
        let mut definition = PivotDefinition::new(test_pivot_id(), (0, 0), (4, 2));
        definition.value_fields.push(ValueField::new(2, "Sum of Sales".to_string(), AggregationType::Sum));
        definition.value_fields.push(ValueField::new(2, "Count of Sales".to_string(), AggregationType::Count));
        definition.layout.values_position = ValuesPosition::Rows;
        definition.layout.show_row_grand_totals = false;
        let view = calculate_pivot(&definition, &mut cache);
        let rows = value_rows(&view);
        assert_eq!(
            rows,
            vec![
                ("Sum of Sales".to_string(), vec![(0, 700.0)]),
                ("Count of Sales".to_string(), vec![(1, 4.0)]),
            ],
            "each value row shows ONLY its own value"
        );
        assert_eq!(view.col_count, 2, "one label column and ONE value column");
    }

    /// Values on ROWS with a column field: the Count row counts. Every value
    /// row read value field 0 (`extract_value_field_from_column` answers 0
    /// whenever values are not on columns), so the Count row repeated the Sums.
    #[test]
    fn values_on_rows_with_a_column_field_show_each_rows_own_value() {
        let mut cache = create_test_cache();
        let mut definition = PivotDefinition::new(test_pivot_id(), (0, 0), (4, 2));
        definition.column_fields.push(PivotField::new(1, "Product".to_string()));
        definition.value_fields.push(ValueField::new(2, "Sum of Sales".to_string(), AggregationType::Sum));
        definition.value_fields.push(ValueField::new(2, "Count of Sales".to_string(), AggregationType::Count));
        definition.layout.values_position = ValuesPosition::Rows;
        let view = calculate_pivot(&definition, &mut cache);
        let rows: Vec<Vec<(usize, f64)>> = value_rows(&view).into_iter().map(|(_, cells)| cells).collect();
        assert_eq!(
            rows,
            vec![
                vec![(0, 300.0), (0, 400.0), (0, 700.0)],
                vec![(1, 2.0), (1, 2.0), (1, 4.0)],
            ],
            "each value row shows its OWN value field across the columns (the Count row repeated the Sums)"
        );
    }

}

/// A BLANK member (a record whose value is empty) is a member like any other:
/// its row / column reads ITS records, and every total counts them once.
///
/// Records store a blank as `VALUE_ID_EMPTY`, and group keys used the same id
/// as their "all values" padding, so a blank member's key WAS the key of the
/// total one level up: a (blank) row showed the grand total, and a rolled-up
/// total counted the blank records twice (once as their own member, once as
/// the total they collided with). Every pivot with a blank on rows or columns,
/// grid pivots included.
#[cfg(test)]
mod blank_member_tests {
    use super::*;
    use engine::CellValue;
    use crate::definition::{AggregationType, PivotField, PivotId, ValueField};
    use crate::view::{PivotCellValue, PivotRowType};

    fn pid() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7])
    }

    fn text(v: Option<&str>) -> CellValue {
        match v {
            Some(s) => CellValue::Text(s.to_string()),
            None => CellValue::Empty,
        }
    }

    /// Fields: 0 Region, 1 Product, 2 Year, 3 Amount.
    fn cache_of(rows: &[(Option<&str>, Option<&str>, &str, f64)]) -> PivotCache {
        let mut cache = PivotCache::new(pid(), 4);
        for (i, name) in ["Region", "Product", "Year", "Amount"].iter().enumerate() {
            cache.set_field_name(i, name.to_string());
        }
        for (i, (region, product, year, amount)) in rows.iter().enumerate() {
            cache.add_record(
                i as u32,
                &[text(*region), text(*product), CellValue::Text(year.to_string()), CellValue::Number(*amount)],
            );
        }
        cache
    }

    fn sum_def(rows: &[(usize, &str)], cols: &[(usize, &str)], hidden: &[(usize, &[&str])]) -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        let field = |(i, n): &(usize, &str)| {
            let mut f = PivotField::new(*i, n.to_string());
            if let Some((_, h)) = hidden.iter().find(|(hi, _)| hi == i) {
                f.hidden_items = h.iter().map(|s| s.to_string()).collect();
            }
            f
        };
        def.row_fields = rows.iter().map(field).collect();
        def.column_fields = cols.iter().map(field).collect();
        def.value_fields = vec![ValueField::new(3, "Sum of Amount".to_string(), AggregationType::Sum)];
        def
    }

    /// Every body row as (indented label, its numbers), in view order.
    fn body(view: &PivotView) -> Vec<(String, Vec<f64>)> {
        let lc = view.row_label_col_count;
        view.rows
            .iter()
            .zip(view.cells.iter())
            .filter(|(d, _)| matches!(d.row_type, PivotRowType::Data | PivotRowType::Subtotal | PivotRowType::GrandTotal))
            .map(|(_, cells)| {
                let head = &cells[0];
                let label = format!("{}{}", "  ".repeat(head.indent_level as usize), head.formatted_value);
                let numbers = cells[lc..]
                    .iter()
                    .filter_map(|c| match c.value {
                        PivotCellValue::Number(n) => Some(n),
                        _ => None,
                    })
                    .collect();
                (label, numbers)
            })
            .collect()
    }

    fn owned(rows: &[(&str, &[f64])]) -> Vec<(String, Vec<f64>)> {
        rows.iter().map(|(l, n)| (l.to_string(), n.to_vec())).collect()
    }

    fn east_blank_west() -> PivotCache {
        cache_of(&[
            (Some("East"), None, "Y1", 10.0),
            (None, None, "Y1", 30.0),
            (Some("West"), None, "Y2", 20.0),
            (None, None, "Y2", 5.0),
        ])
    }

    #[test]
    fn a_blank_member_on_rows_reads_its_own_records_and_the_total_counts_them_once() {
        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(0, "Region")], &[], &[]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[("(blank)", &[35.0]), ("East", &[10.0]), ("West", &[20.0]), ("Grand Total", &[65.0])]),
        );

        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(0, "Region")], &[], &[(0, &["West"])]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[("(blank)", &[35.0]), ("East", &[10.0]), ("Grand Total", &[45.0])]),
            "with West hidden",
        );
    }

    #[test]
    fn a_blank_member_on_rows_crossed_with_columns_reads_its_own_cells() {
        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(0, "Region")], &[(2, "Year")], &[]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[
                ("(blank)", &[30.0, 5.0, 35.0]),
                ("East", &[10.0, 0.0, 10.0]),
                ("West", &[0.0, 20.0, 20.0]),
                ("Grand Total", &[40.0, 25.0, 65.0]),
            ]),
        );

        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(0, "Region")], &[(2, "Year")], &[(0, &["East"])]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[("(blank)", &[30.0, 5.0, 35.0]), ("West", &[0.0, 20.0, 20.0]), ("Grand Total", &[30.0, 25.0, 55.0])]),
            "with East hidden",
        );
    }

    #[test]
    fn a_blank_member_on_columns_reads_its_own_column_and_the_row_totals_count_it_once() {
        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(2, "Year")], &[(0, "Region")], &[]), &mut cache);
        // Columns: (blank), East, West, Grand Total.
        assert_eq!(
            body(&view),
            owned(&[
                ("Y1", &[30.0, 10.0, 0.0, 40.0]),
                ("Y2", &[5.0, 0.0, 20.0, 25.0]),
                ("Grand Total", &[35.0, 10.0, 20.0, 65.0]),
            ]),
        );

        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(2, "Year")], &[(0, "Region")], &[(0, &["West"])]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[("Y1", &[30.0, 10.0, 40.0]), ("Y2", &[5.0, 0.0, 5.0]), ("Grand Total", &[35.0, 10.0, 45.0])]),
            "with West hidden",
        );
    }

    /// Two levels, a blank at BOTH: (blank)/(blank) was the grand-total key,
    /// East/(blank) was East's subtotal key, and (blank)/Apples read
    /// "every region's Apples".
    fn two_levels() -> PivotCache {
        cache_of(&[
            (Some("East"), Some("Apples"), "Y1", 1.0),
            (Some("East"), None, "Y1", 2.0),
            (None, Some("Apples"), "Y1", 4.0),
            (None, None, "Y1", 8.0),
            (Some("West"), Some("Pears"), "Y1", 16.0),
        ])
    }

    #[test]
    fn a_blank_member_at_either_row_level_keeps_its_subtotal_and_the_grand_total_apart() {
        let mut cache = two_levels();
        let view = calculate_pivot(&sum_def(&[(0, "Region"), (1, "Product")], &[], &[]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[
                ("(blank)", &[12.0]),
                ("  (blank)", &[8.0]),
                ("  Apples", &[4.0]),
                ("East", &[3.0]),
                ("  (blank)", &[2.0]),
                ("  Apples", &[1.0]),
                ("West", &[16.0]),
                ("  Pears", &[16.0]),
                ("Grand Total", &[31.0]),
            ]),
        );

        // Hide the blank PRODUCT: every (blank) product row goes, the blank
        // REGION stays with only its Apples.
        let mut cache = two_levels();
        let view = calculate_pivot(&sum_def(&[(0, "Region"), (1, "Product")], &[], &[(1, &["(blank)"])]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[
                ("(blank)", &[4.0]),
                ("  Apples", &[4.0]),
                ("East", &[1.0]),
                ("  Apples", &[1.0]),
                ("West", &[16.0]),
                ("  Pears", &[16.0]),
                ("Grand Total", &[21.0]),
            ]),
            "with the blank product hidden",
        );
    }

    #[test]
    fn a_blank_member_at_either_column_level_keeps_its_own_slot() {
        let mut cache = two_levels();
        let view = calculate_pivot(&sum_def(&[(2, "Year")], &[(0, "Region"), (1, "Product")], &[]), &mut cache);
        // Columns (children before their parent's total column):
        // (blank)/(blank), (blank)/Apples, (blank) Total, East/(blank),
        // East/Apples, East Total, West/Pears, West Total, Grand Total.
        let expected: &[f64] = &[8.0, 4.0, 12.0, 2.0, 1.0, 3.0, 16.0, 16.0, 31.0];
        assert_eq!(body(&view), owned(&[("Y1", expected), ("Grand Total", expected)]));
    }

    /// Show Values As reads other cells by key, so it read the grand total in
    /// place of the (blank) member too.
    #[test]
    fn percent_of_grand_total_of_a_blank_member_is_its_share() {
        let mut cache = east_blank_west();
        let mut def = sum_def(&[(0, "Region")], &[], &[]);
        def.value_fields[0].show_values_as = crate::definition::ShowValuesAs::PercentOfGrandTotal;
        let view = calculate_pivot(&def, &mut cache);
        let blank = body(&view).into_iter().find(|(l, _)| l == "(blank)").expect("a (blank) row");
        assert!((blank.1[0] - 35.0 / 65.0).abs() < 1e-12, "(blank) share: {:?}", blank.1);
    }

    /// The (blank) member's cells NAME it in their group path, so a
    /// drill-through lists exactly its records (an unnamed blank level drilled
    /// the level above: the whole dataset for a one-field pivot).
    #[test]
    fn a_blank_members_cell_drills_to_its_own_records() {
        let mut cache = east_blank_west();
        let def = sum_def(&[(0, "Region")], &[(2, "Year")], &[]);
        let view = calculate_pivot(&def, &mut cache);
        let body_rows: Vec<&Vec<crate::view::PivotViewCell>> = view
            .rows
            .iter()
            .zip(view.cells.iter())
            .filter(|(d, _)| d.row_type == PivotRowType::Data)
            .map(|(_, c)| c)
            .collect();
        let blank_row = body_rows.iter().find(|c| c[0].formatted_value == "(blank)").expect("a (blank) row");
        let lc = view.row_label_col_count;
        // (blank) x Y1 -> record 1; (blank) x Grand Total -> records 1 and 3.
        let y1 = &blank_row[lc];
        let total = &blank_row[lc + 2];
        let mut rows = drill_down(&def, &cache, &y1.group_path, 100).source_rows;
        rows.sort();
        assert_eq!(rows, vec![1], "the (blank) x Y1 cell drilled {:?}", y1.group_path);
        let mut rows = drill_down(&def, &cache, &total.group_path, 100).source_rows;
        rows.sort();
        assert_eq!(rows, vec![1, 3], "the (blank) row's total drilled {:?}", total.group_path);
        let mut rows = drill_down(&def, &cache, &blank_row[0].group_path, 100).source_rows;
        rows.sort();
        assert_eq!(rows, vec![1, 3], "the (blank) row header drilled {:?}", blank_row[0].group_path);
        // The label of the blank's id is the blank's label, as the header shows.
        let &(field, id) = blank_row[0].group_path.last().expect("the header names its member");
        assert_eq!(field, 0);
        assert_ne!(id, VALUE_ID_EMPTY, "the header names its member by the padding id");
        assert_eq!(cache.get_value_label(0, id).as_deref(), Some(""), "the raw label of the blank member");
    }

    /// A GROUPED field (here a number binning) lives in the virtual records,
    /// not in `record.values`: the drill read only the latter, so a bin's
    /// cell drilled nothing -- and, with the blank member named, the (blank)
    /// bin would have drilled EVERY record (a missing value reads as blank).
    #[test]
    fn a_grouped_fields_cells_drill_to_their_own_records_blank_bin_included() {
        let mut cache = PivotCache::new(pid(), 2);
        cache.set_field_name(0, "Score".to_string());
        cache.set_field_name(1, "Amount".to_string());
        let rows: [(Option<f64>, f64); 4] = [(Some(5.0), 10.0), (Some(15.0), 20.0), (None, 40.0), (Some(7.0), 1.0)];
        for (i, (score, amount)) in rows.iter().enumerate() {
            let score = score.map(CellValue::Number).unwrap_or(CellValue::Empty);
            cache.add_record(i as u32, &[score, CellValue::Number(*amount)]);
        }
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        let mut score = PivotField::new(0, "Score".to_string());
        score.grouping = crate::definition::FieldGrouping::NumberBinning { start: 0.0, end: 20.0, interval: 10.0 };
        def.row_fields = vec![score];
        def.value_fields = vec![ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum)];
        let view = calculate_pivot(&def, &mut cache);
        assert_eq!(
            body(&view),
            owned(&[("(blank)", &[40.0]), ("0-9", &[11.0]), ("10-19", &[20.0]), ("Grand Total", &[71.0])]),
        );
        let lc = view.row_label_col_count;
        let drilled = |label: &str| -> Vec<u32> {
            let row = view.cells.iter().find(|c| c[0].formatted_value == label).expect(label);
            let mut rows = drill_down(&def, &cache, &row[lc].group_path, 100).source_rows;
            rows.sort();
            rows
        };
        assert_eq!(drilled("0-9"), vec![0, 3], "a bin drills its own records");
        assert_eq!(drilled("(blank)"), vec![2], "the (blank) bin drills only the blank record");
    }

    /// "Show items with no data" lists every item of the field -- the blank
    /// member too when the field has one. It listed only the interned values,
    /// so the (blank) row vanished while the grand total still counted it.
    #[test]
    fn show_items_with_no_data_keeps_the_blank_member() {
        let mut cache = east_blank_west();
        let mut def = sum_def(&[(0, "Region")], &[], &[]);
        def.row_fields[0].show_all_items = true;
        let view = calculate_pivot(&def, &mut cache);
        assert_eq!(
            body(&view),
            owned(&[("(blank)", &[35.0]), ("East", &[10.0]), ("West", &[20.0]), ("Grand Total", &[65.0])]),
        );

        // Under a parent that has no blank records the (blank) child shows
        // with no data, like every other item without data there.
        let mut cache = two_levels();
        let mut def = sum_def(&[(0, "Region"), (1, "Product")], &[], &[]);
        def.row_fields[1].show_all_items = true;
        let view = calculate_pivot(&def, &mut cache);
        let west: Vec<(String, Vec<f64>)> =
            body(&view).into_iter().skip_while(|(l, _)| l != "West").take(4).collect();
        assert_eq!(
            west,
            owned(&[("West", &[16.0]), ("  (blank)", &[0.0]), ("  Apples", &[0.0]), ("  Pears", &[16.0])]),
        );
    }

    /// Region = (blank) 35 (30 + 5), East 10, West 20, shown as `show_as`
    /// along Region: each ITEM row's single number, in view order.
    fn shown_along_region(show_as: crate::definition::ShowValuesAs, base_item: Option<&str>) -> Vec<(String, f64)> {
        let mut cache = east_blank_west();
        let mut def = sum_def(&[(0, "Region")], &[], &[]);
        def.value_fields[0].show_values_as = show_as;
        def.value_fields[0].base_field_index = Some(0);
        def.value_fields[0].base_item = base_item.map(str::to_string);
        let view = calculate_pivot(&def, &mut cache);
        view.rows
            .iter()
            .zip(view.cells.iter())
            .filter(|(d, _)| d.row_type == PivotRowType::Data)
            .map(|(_, cells)| {
                let n = match cells[view.row_label_col_count].value {
                    PivotCellValue::Number(n) => n,
                    _ => f64::NAN,
                };
                (cells[0].formatted_value.clone(), n)
            })
            .collect()
    }

    /// Show Values As walks the base field's items -- the interned values
    /// only, so the (blank) member was never among them: its running total
    /// never met its own row (it summed every OTHER item and left out its
    /// own 35) and no row reached the column total.
    #[test]
    fn running_total_along_a_field_with_a_blank_member_counts_the_blank_in_its_place() {
        use crate::definition::ShowValuesAs;
        let rows = shown_along_region(ShowValuesAs::RunningTotal, None);
        assert_eq!(
            rows,
            vec![("(blank)".to_string(), 35.0), ("East".to_string(), 45.0), ("West".to_string(), 65.0)],
        );
        let pct = shown_along_region(ShowValuesAs::PercentOfRunningTotal, None);
        let last = pct.last().expect("a last item").1;
        assert!((last - 1.0).abs() < 1e-12, "the last item's % running total is 100%: {pct:?}");
    }

    /// Rank ranks against the siblings: without the blank member, (blank) 35
    /// and West 20 tied at 1.
    #[test]
    fn rank_along_a_field_with_a_blank_member_ranks_against_the_blank_too() {
        use crate::definition::ShowValuesAs;
        let rank = |rows: &[(String, f64)], label: &str| rows.iter().find(|(l, _)| l == label).expect(label).1;
        let desc = shown_along_region(ShowValuesAs::RankDescending, None);
        assert_eq!((rank(&desc, "(blank)"), rank(&desc, "West"), rank(&desc, "East")), (1.0, 2.0, 3.0), "{desc:?}");
        let asc = shown_along_region(ShowValuesAs::RankAscending, None);
        assert_eq!((rank(&asc, "East"), rank(&asc, "West"), rank(&asc, "(blank)")), (1.0, 2.0, 3.0), "{asc:?}");
    }

    /// Difference from (previous) / (next) walks the same list: the blank
    /// row found no position (NaN), and East -- the item after it -- found
    /// none before it. A named "(blank)" base item resolved to nothing.
    #[test]
    fn difference_along_a_field_with_a_blank_member_steps_through_the_blank() {
        use crate::definition::ShowValuesAs;
        let prev = shown_along_region(ShowValuesAs::Difference, Some("(previous)"));
        assert_eq!(prev.iter().map(|(l, _)| l.as_str()).collect::<Vec<_>>(), vec!["(blank)", "East", "West"]);
        assert!(prev[0].1.is_nan(), "the first item has no previous: {prev:?}");
        assert_eq!((prev[1].1, prev[2].1), (10.0 - 35.0, 20.0 - 10.0), "{prev:?}");

        let next = shown_along_region(ShowValuesAs::Difference, Some("(next)"));
        assert_eq!((next[0].1, next[1].1), (35.0 - 10.0, 10.0 - 20.0), "{next:?}");
        assert!(next[2].1.is_nan(), "the last item has no next: {next:?}");

        let from_blank = shown_along_region(ShowValuesAs::Difference, Some("(blank)"));
        assert_eq!(
            from_blank,
            vec![("(blank)".to_string(), 0.0), ("East".to_string(), 10.0 - 35.0), ("West".to_string(), 20.0 - 35.0)],
        );
    }

    /// A field with NO blank records has no blank member to walk: the lists
    /// are exactly the interned values, and a "(blank)" base item names
    /// nothing (NaN), as any item the field does not have.
    #[test]
    fn a_field_without_blank_records_walks_no_blank_member() {
        use crate::definition::ShowValuesAs;
        let run = |show_as: ShowValuesAs, base_item: Option<&str>| {
            let mut cache = cache_of(&[(Some("East"), None, "Y1", 10.0), (Some("West"), None, "Y2", 20.0)]);
            let mut def = sum_def(&[(0, "Region")], &[], &[]);
            def.value_fields[0].show_values_as = show_as;
            def.value_fields[0].base_field_index = Some(0);
            def.value_fields[0].base_item = base_item.map(str::to_string);
            let view = calculate_pivot(&def, &mut cache);
            view.rows
                .iter()
                .zip(view.cells.iter())
                .filter(|(d, _)| d.row_type == PivotRowType::Data)
                .map(|(_, c)| match c[view.row_label_col_count].value {
                    PivotCellValue::Number(n) => n,
                    _ => f64::NAN,
                })
                .collect::<Vec<f64>>()
        };
        assert_eq!(run(ShowValuesAs::RunningTotal, None), vec![10.0, 30.0]);
        assert!(run(ShowValuesAs::Difference, Some("(previous)"))[0].is_nan(), "East is first");
        assert!(run(ShowValuesAs::Difference, Some("(blank)")).iter().all(|n| n.is_nan()), "no (blank) item");
    }

    // ------------------------------------------------------------------
    // Show Values As walks the base field's items IN THE ORDER THE AXIS
    // SHOWS THEM (wave E, Y2). The walk was the field's items in ASCENDING
    // order whatever the field's sort -- descending, sort-by-field, manual --
    // so a Z-A Region with Running Total In Region read West 65, East 45,
    // (blank) 35 where Excel reads 20, 30, 65, and (previous) / (next)
    // stepped to the alphabetical neighbour instead of the row above or
    // below. It also listed items the axis does not show (a hidden item),
    // which Rank counted and (previous) stepped onto.
    // ------------------------------------------------------------------

    fn calc(def: &PivotDefinition, mut cache: PivotCache) -> PivotView {
        calculate_pivot(def, &mut cache)
    }

    /// `def` with its (only) value field shown as `show_as` along `base`.
    fn along(
        mut def: PivotDefinition,
        show_as: crate::definition::ShowValuesAs,
        base: usize,
        base_item: Option<&str>,
    ) -> PivotDefinition {
        def.value_fields[0].show_values_as = show_as;
        def.value_fields[0].base_field_index = Some(base);
        def.value_fields[0].base_item = base_item.map(str::to_string);
        def
    }

    /// Every Data row as (indented label, its FIRST number -- NaN when the
    /// cell holds none), in view order.
    fn data_rows(view: &PivotView) -> Vec<(String, f64)> {
        view.rows
            .iter()
            .zip(view.cells.iter())
            .filter(|(d, _)| d.row_type == PivotRowType::Data)
            .map(|(_, cells)| {
                let head = &cells[0];
                let n = match cells[view.row_label_col_count].value {
                    PivotCellValue::Number(n) => n,
                    _ => f64::NAN,
                };
                (format!("{}{}", "  ".repeat(head.indent_level as usize), head.formatted_value), n)
            })
            .collect()
    }

    fn labels(rows: &[(String, f64)]) -> Vec<&str> {
        rows.iter().map(|(l, _)| l.as_str()).collect()
    }

    /// Region sorted Z-A, Running Total In Region: West 20, East 20+10,
    /// (blank) 30+35 -- the order the rows show. The walk was ascending:
    /// West 65, East 45, (blank) 35.
    #[test]
    fn running_total_follows_a_descending_sort() {
        use crate::definition::{ShowValuesAs, SortOrder};
        let mut def = sum_def(&[(0, "Region")], &[], &[]);
        def.row_fields[0].sort_order = SortOrder::Descending;
        let rows = data_rows(&calc(&along(def.clone(), ShowValuesAs::RunningTotal, 0, None), east_blank_west()));
        assert_eq!(
            rows,
            vec![("West".to_string(), 20.0), ("East".to_string(), 30.0), ("(blank)".to_string(), 65.0)],
        );
        let pct = data_rows(&calc(&along(def, ShowValuesAs::PercentOfRunningTotal, 0, None), east_blank_west()));
        assert!((pct[0].1 - 20.0 / 65.0).abs() < 1e-12, "the FIRST row shown starts the % running total: {pct:?}");
        assert!((pct[2].1 - 1.0).abs() < 1e-12, "the LAST row shown reaches 100%: {pct:?}");
    }

    /// Difference From (previous) / (next) is the row above / below as
    /// shown. Z-A: West has no previous, East's previous is West, (blank)'s
    /// is East.
    #[test]
    fn difference_from_previous_and_next_follows_a_descending_sort() {
        use crate::definition::{ShowValuesAs, SortOrder};
        let mut def = sum_def(&[(0, "Region")], &[], &[]);
        def.row_fields[0].sort_order = SortOrder::Descending;

        let prev = data_rows(&calc(&along(def.clone(), ShowValuesAs::Difference, 0, Some("(previous)")), east_blank_west()));
        assert_eq!(labels(&prev), vec!["West", "East", "(blank)"]);
        assert!(prev[0].1.is_nan(), "the first row shown has no previous: {prev:?}");
        assert_eq!((prev[1].1, prev[2].1), (10.0 - 20.0, 35.0 - 10.0), "{prev:?}");

        let next = data_rows(&calc(&along(def, ShowValuesAs::Difference, 0, Some("(next)")), east_blank_west()));
        assert_eq!((next[0].1, next[1].1), (20.0 - 10.0, 10.0 - 35.0), "{next:?}");
        assert!(next[2].1.is_nan(), "the last row shown has no next: {next:?}");
    }

    /// Sort-by-field: Region ordered by Year (Y1 West, Y2 North, Y3 East).
    /// The running total walks West, North, East -- not the alphabet.
    #[test]
    fn running_total_follows_a_sort_by_field() {
        use crate::definition::ShowValuesAs;
        let by_year = || {
            cache_of(&[
                (Some("East"), None, "Y3", 10.0),
                (Some("West"), None, "Y1", 20.0),
                (Some("North"), None, "Y2", 5.0),
            ])
        };
        let mut def = sum_def(&[(0, "Region")], &[], &[]);
        def.row_fields[0].sort_by_field_index = Some(2);
        let rows = data_rows(&calc(&along(def, ShowValuesAs::RunningTotal, 0, None), by_year()));
        assert_eq!(
            rows,
            vec![("West".to_string(), 20.0), ("North".to_string(), 25.0), ("East".to_string(), 35.0)],
        );
    }

    /// Whatever the order -- ascending, descending, manual, data source
    /// order, or by another field in either direction -- the running total
    /// of the rows AS SHOWN is the running sum of their plain values, the
    /// (previous) difference is each row minus the one above, and the rank
    /// is the rank among the rows shown. Eight items entered out of the
    /// alphabet's order, so a manual / data-source-order axis (the entry
    /// order, Z2) is not accidentally alphabetical.
    #[test]
    fn show_values_as_follows_the_displayed_order_for_every_sort() {
        use crate::definition::{ShowValuesAs, SortOrder};
        let eight = || {
            cache_of(&[
                (Some("Delta"), None, "k5", 4.0),
                (Some("Alpha"), None, "k8", 7.0),
                (Some("Hotel"), None, "k2", 1.0),
                (Some("Bravo"), None, "k7", 30.0),
                (Some("Golf"), None, "k1", 11.0),
                (Some("Charlie"), None, "k6", 2.0),
                (Some("Foxtrot"), None, "k3", 19.0),
                (Some("Echo"), None, "k4", 5.0),
            ])
        };
        let orders = [SortOrder::Ascending, SortOrder::Descending, SortOrder::Manual, SortOrder::DataSourceOrder];
        for order in orders {
            for sort_by in [None, Some(2)] {
                let mut def = sum_def(&[(0, "Region")], &[], &[]);
                def.row_fields[0].sort_order = order.clone();
                def.row_fields[0].sort_by_field_index = sort_by;
                let case = format!("{order:?} sort_by={sort_by:?}");

                let plain = data_rows(&calc(&def, eight()));
                let shown: Vec<&str> = labels(&plain);
                let mut sum = 0.0;
                let running: Vec<f64> = plain.iter().map(|(_, v)| { sum += v; sum }).collect();

                let rt = data_rows(&calc(&along(def.clone(), ShowValuesAs::RunningTotal, 0, None), eight()));
                assert_eq!(labels(&rt), shown, "{case}: the rows moved");
                assert_eq!(rt.iter().map(|(_, v)| *v).collect::<Vec<_>>(), running, "{case}: running total");

                let prev = data_rows(&calc(&along(def.clone(), ShowValuesAs::Difference, 0, Some("(previous)")), eight()));
                assert!(prev[0].1.is_nan(), "{case}: the first row shown has no previous: {prev:?}");
                for i in 1..plain.len() {
                    assert_eq!(prev[i].1, plain[i].1 - plain[i - 1].1, "{case}: (previous) of {}", plain[i].0);
                }

                let rank = data_rows(&calc(&along(def, ShowValuesAs::RankDescending, 0, None), eight()));
                for (label, v) in &plain {
                    let expected = plain.iter().filter(|(_, o)| o > v).count() as f64 + 1.0;
                    let got = rank.iter().find(|(l, _)| l == label).expect("the row").1;
                    assert_eq!(got, expected, "{case}: rank of {label}");
                }
            }
        }
    }

    /// Two row levels, the INNER field sorted Z-A and the base: each
    /// region's products are walked as they show under it. Then the OUTER
    /// field Z-A as the base with the inner one below it.
    #[test]
    fn running_total_along_either_level_of_two_follows_the_rows_as_shown() {
        use crate::definition::{ShowValuesAs, SortOrder};
        let mut def = sum_def(&[(0, "Region"), (1, "Product")], &[], &[]);
        def.row_fields[1].sort_order = SortOrder::Descending;
        let view = calc(&along(def, ShowValuesAs::RunningTotal, 1, None), two_levels());
        let leaves: Vec<(String, f64)> = data_rows(&view).into_iter().filter(|(l, _)| l.starts_with("  ")).collect();
        assert_eq!(
            leaves,
            vec![
                ("  Apples".to_string(), 4.0),
                ("  (blank)".to_string(), 12.0),
                ("  Apples".to_string(), 1.0),
                ("  (blank)".to_string(), 3.0),
                ("  Pears".to_string(), 16.0),
            ],
            "Running Total In Product, products Z-A under each region",
        );

        let mut def = sum_def(&[(0, "Region"), (1, "Product")], &[], &[]);
        def.row_fields[0].sort_order = SortOrder::Descending;
        let view = calc(&along(def, ShowValuesAs::RunningTotal, 0, None), two_levels());
        assert_eq!(
            body(&view),
            owned(&[
                ("West", &[16.0]),
                ("  Pears", &[16.0]),
                ("East", &[19.0]),
                ("  (blank)", &[2.0]),
                ("  Apples", &[1.0]),
                ("(blank)", &[31.0]),
                ("  (blank)", &[10.0]),
                ("  Apples", &[5.0]),
                ("Grand Total", &[31.0]),
            ]),
            "Running Total In Region, regions Z-A: each product accumulates West, East, (blank)",
        );
    }

    /// The base field on COLUMNS, sorted Z-A: each row accumulates across
    /// its columns as they show (West, East, (blank)).
    #[test]
    fn running_total_along_a_column_field_follows_the_columns_as_shown() {
        use crate::definition::{ShowValuesAs, SortOrder};
        let mut def = sum_def(&[(2, "Year")], &[(0, "Region")], &[]);
        def.column_fields[0].sort_order = SortOrder::Descending;
        let view = calc(&along(def, ShowValuesAs::RunningTotal, 0, None), east_blank_west());
        // Columns: West, East, (blank), Grand Total.
        assert_eq!(
            body(&view),
            owned(&[
                ("Y1", &[0.0, 10.0, 40.0, 40.0]),
                ("Y2", &[20.0, 20.0, 25.0, 25.0]),
                ("Grand Total", &[20.0, 30.0, 65.0, 65.0]),
            ]),
        );
    }

    /// A hidden item is not shown, so it is nobody's sibling: Rank ranks the
    /// rows shown, and (previous) is the row shown above. The walk listed
    /// the hidden item with a value of nothing, which ranked below every
    /// positive row and was the "previous" of the row after it.
    #[test]
    fn a_hidden_item_is_not_walked() {
        use crate::definition::ShowValuesAs;
        let three = || {
            cache_of(&[
                (Some("East"), None, "Y1", 10.0),
                (Some("North"), None, "Y1", 5.0),
                (Some("West"), None, "Y1", 20.0),
            ])
        };
        let def = sum_def(&[(0, "Region")], &[], &[(0, &["North"])]);
        let asc = data_rows(&calc(&along(def.clone(), ShowValuesAs::RankAscending, 0, None), three()));
        assert_eq!(asc, vec![("East".to_string(), 1.0), ("West".to_string(), 2.0)], "rank among the rows shown");

        let prev = data_rows(&calc(&along(def, ShowValuesAs::Difference, 0, Some("(previous)")), three()));
        assert!(prev[0].1.is_nan(), "{prev:?}");
        assert_eq!(prev[1], ("West".to_string(), 20.0 - 10.0), "West's previous is East, the row above it");
    }

    // ------------------------------------------------------------------
    // DATA-SOURCE ORDER is the order the source first shows each item
    // (wave F, Z2). The Manual / DataSourceOrder arm of `sort_value_ids`
    // kept whatever order the level's FxHashSet iterated in: eight regions
    // entered Delta, Alpha, Hotel, Bravo, Golf, Charlie, Foxtrot, Echo showed
    // as Delta, Echo, Bravo, Foxtrot, Hotel, Charlie, Alpha, Golf. The host
    // relies on this order for a calculation group's items in declaration
    // order (pivot/commands.rs, `make_calc_group_field`).
    // ------------------------------------------------------------------

    const ENTERED: [&str; 8] = ["Delta", "Alpha", "Hotel", "Bravo", "Golf", "Charlie", "Foxtrot", "Echo"];
    const ENTERED_AMOUNTS: [f64; 8] = [4.0, 7.0, 1.0, 30.0, 11.0, 2.0, 19.0, 5.0];

    /// The eight regions in the order they were entered, one record each.
    fn entered_eight() -> PivotCache {
        let rows: Vec<(Option<&str>, Option<&str>, &str, f64)> =
            ENTERED.iter().zip(ENTERED_AMOUNTS).map(|(r, a)| (Some(*r), None, "Y1", a)).collect();
        cache_of(&rows)
    }

    #[test]
    fn data_source_order_and_manual_list_the_items_as_the_source_first_shows_them() {
        use crate::definition::SortOrder;
        for order in [SortOrder::DataSourceOrder, SortOrder::Manual] {
            // On rows.
            let mut def = sum_def(&[(0, "Region")], &[], &[]);
            def.row_fields[0].sort_order = order;
            let rows = data_rows(&calc(&def, entered_eight()));
            assert_eq!(labels(&rows), ENTERED.to_vec(), "{order:?} on rows");

            // On columns: the grand-total row reads the columns in their order.
            let mut def = sum_def(&[(1, "Product")], &[(0, "Region")], &[]);
            def.column_fields[0].sort_order = order;
            let view = calc(&def, entered_eight());
            let total = body(&view).into_iter().find(|(l, _)| l == "Grand Total").expect("the grand-total row").1;
            let mut expected = ENTERED_AMOUNTS.to_vec();
            expected.push(ENTERED_AMOUNTS.iter().sum());
            assert_eq!(total, expected, "{order:?} on columns");
        }
    }

    /// The blank member takes ITS place in the source too: entered second, it
    /// shows second -- not first as A-Z puts it, not wherever a hash lands it.
    #[test]
    fn data_source_order_puts_the_blank_member_where_the_source_first_shows_it() {
        use crate::definition::SortOrder;
        let cache = || {
            cache_of(&[
                (Some("Delta"), None, "Y1", 1.0),
                (None, None, "Y1", 2.0),
                (Some("Alpha"), None, "Y1", 4.0),
                (Some("Delta"), None, "Y1", 8.0),
            ])
        };
        let mut def = sum_def(&[(0, "Region")], &[], &[]);
        def.row_fields[0].sort_order = SortOrder::DataSourceOrder;
        assert_eq!(
            data_rows(&calc(&def, cache())),
            vec![("Delta".to_string(), 9.0), ("(blank)".to_string(), 2.0), ("Alpha".to_string(), 4.0)],
        );
    }

    /// A field has ONE item order, as Excel keeps one per field: under every
    /// parent its items follow it -- the source's first showing of each item
    /// anywhere -- so East lists Pears before Apples because the SOURCE shows
    /// Pears first (under West), and Kiwis last.
    #[test]
    fn an_inner_fields_items_follow_the_fields_one_source_order_under_every_parent() {
        use crate::definition::SortOrder;
        let cache = cache_of(&[
            (Some("West"), Some("Pears"), "Y1", 1.0),
            (Some("East"), Some("Apples"), "Y1", 2.0),
            (Some("West"), Some("Apples"), "Y1", 4.0),
            (Some("East"), Some("Kiwis"), "Y1", 8.0),
            (Some("East"), Some("Pears"), "Y1", 16.0),
        ]);
        let mut def = sum_def(&[(0, "Region"), (1, "Product")], &[], &[]);
        def.row_fields[0].sort_order = SortOrder::DataSourceOrder;
        def.row_fields[1].sort_order = SortOrder::DataSourceOrder;
        let shown: Vec<String> = body(&calc(&def, cache)).into_iter().map(|(l, _)| l).collect();
        assert_eq!(
            shown,
            vec!["West", "  Pears", "  Apples", "East", "  Pears", "  Apples", "  Kiwis", "Grand Total"],
        );
    }

    /// The order is the SOURCE's, not the filtered rows': Bravo's first record
    /// is filtered out (its year is hidden), and Bravo still shows before
    /// Alpha -- so hiding and showing a year never reorders the regions.
    #[test]
    fn data_source_order_does_not_move_when_a_filter_hides_an_items_first_record() {
        use crate::definition::SortOrder;
        let cache = || {
            cache_of(&[
                (Some("Bravo"), None, "Y2", 1.0),
                (Some("Alpha"), None, "Y1", 2.0),
                (Some("Bravo"), None, "Y1", 4.0),
            ])
        };
        for hidden in [&[][..], &["Y2"][..]] {
            let mut def = sum_def(&[(0, "Region")], &[(2, "Year")], &[(2, hidden)]);
            def.row_fields[0].sort_order = SortOrder::DataSourceOrder;
            assert_eq!(labels(&data_rows(&calc(&def, cache()))), vec!["Bravo", "Alpha"], "hidden years {hidden:?}");
        }
    }

    /// Items the cache knows that no record shows ("show items with no data":
    /// a calculation group's declared items, pre-interned in declaration
    /// order) follow the ones the source shows, in the cache's own order.
    #[test]
    fn items_no_record_shows_follow_in_the_caches_own_order() {
        use crate::definition::SortOrder;
        let mut cache = PivotCache::new(pid(), 4);
        for (i, name) in ["Region", "Product", "Year", "Amount"].iter().enumerate() {
            cache.set_field_name(i, name.to_string());
        }
        for item in ["Q1", "Q2", "Q3", "Q4"] {
            cache.get_field_mut(0).expect("the Region field").intern(CacheValue::Text(item.to_string()));
        }
        for (i, item) in ["Q3", "Q1", "Q3"].iter().enumerate() {
            cache.add_record(
                i as u32,
                &[text(Some(*item)), text(None), CellValue::Text("Y1".to_string()), CellValue::Number(1.0)],
            );
        }
        let mut def = sum_def(&[(0, "Region")], &[], &[]);
        def.row_fields[0].sort_order = SortOrder::DataSourceOrder;
        def.row_fields[0].show_all_items = true;
        assert_eq!(labels(&data_rows(&calc(&def, cache))), vec!["Q3", "Q1", "Q2", "Q4"]);
    }
}
