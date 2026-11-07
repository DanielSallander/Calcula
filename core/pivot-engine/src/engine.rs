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
use engine::MemberSource;
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
    BackgroundStyle, FilterRowInfo, HeaderFieldSummary, PivotCellType, PivotCellValue,
    PivotColumnDescriptor, PivotColumnType, PivotRowDescriptor, PivotRowType,
    PivotView, PivotViewCell,
};

/// What a value sort orders one item by (see `aggregate_or_blank`).
#[derive(Debug, Clone, Copy, PartialEq)]
enum ValueSortKey {
    Blank,
    Number(f64),
    Error,
}

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
        // Sort by value (BUG-0459): a field's items re-ordered within each
        // parent by a data field's value along one line of the other axis.
        self.apply_value_sorts(&mut row_tree, &row_fields, &col_fields, true);
        self.apply_value_sorts(&mut col_tree, &col_fields, &row_fields, false);

        // Apply ragged hierarchy behaviors to the trees
        for hc in &self.definition.hierarchy_configs {
            if hc.is_row {
                apply_ragged_behavior(&mut row_tree, hc, 0);
            } else {
                apply_ragged_behavior(&mut col_tree, hc, 0);
            }
        }
        // A row total's error is its items' as SHOWN (BUG-0760 follow-up).
        self.rederive_row_total_errors(&row_tree);
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
        // Show Values As reads each grand total, with its error, where it
        // needs it (`aggregate_at`).
        self.ensure_aggregates_computed();
    }

    /// Applies the show_values_as transformation to a cell's own aggregate
    /// (`own`: its number, or the error it shows).
    ///
    /// A SOURCE ERROR IN A BASE (piv5, the piv4 verifier's finding 3) is what
    /// Excel shows it as [LIVE, Excel 16, piv5 p1/p2: Region East 10, Mid
    /// #DIV/0!, North 5, South 20; Year x Region with Y1/West #DIV/0!;
    /// Cat > Item with A/a2 #N/A]:
    /// - % of Grand / Row / Column Total and Index: the error, wherever the
    ///   total divided by holds one -- every cell under % of Grand Total, the
    ///   Y1 row under % of Row, the West column under % of Column. Calcula
    ///   divided by a total that left the error out (East 28,57%).
    /// - % of Parent Row / Column Total: EMPTY when the cell or its parent
    ///   holds an error.
    /// - Running Total In: the error from the first erroring item on; % Running
    ///   Total In divides by the base field's total under the cell's parent,
    ///   so an error anywhere in it is the error in every cell.
    /// - Difference From: the error when the cell or its base item holds one;
    ///   % Difference From: EMPTY when the base item holds one, else the
    ///   cell's own error.
    /// - Rank: an erroring item is EMPTY and is not ranked (East 2, North 1,
    ///   South 3 with Mid left out).
    /// And without any error [LIVE, piv5 p3]: under Difference, % Difference,
    /// Running Total, % Running Total and Rank a TOTAL of the base field (the
    /// grand total, a subtotal of a level above it) is EMPTY, and so is the
    /// base item's own cell under (% ) Difference From; % Running Total In is
    /// of the base field's total under the cell's parent (a2 100,00% under A),
    /// never of the grand total; and % of Parent Row Total reads a subtotal
    /// row's parent, not the subtotal itself (B 76,92% of 52, where its padded
    /// path read 100%).
    /// And over a ZERO or EMPTY base [LIVE, piv6 p1-p3]: % of Grand / Row /
    /// Column Total and Index are #DIV/0! over a zero total (Calcula showed
    /// 0); % of Parent is EMPTY over a zero parent; % Running Total In is
    /// #DIV/0! over a zero total unless every item is 0, then EMPTY; %
    /// Difference From is #NULL! in a cell no record reaches, EMPTY over a
    /// base with none, #DIV/0! over a base of 0; Rank leaves an empty cell
    /// EMPTY and unranked and numbers ties 1, 2, 2, 3. Running Total In and
    /// Difference From read an empty cell as 0, as Excel does.
    fn transform_show_values_as(
        &mut self,
        own: Result<f64, &'static str>,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
        show_as: ShowValuesAs,
    ) -> ShownValue {
        // A ratio of the cell over a total: the cell's error, else the
        // total's, else #DIV/0! over a zero total -- an empty cell too
        // (Excel [LIVE, piv6 p1 H_PCTROW]: Y5 = East 0 shows #DIV/0! in its
        // empty West cell; K_PCTGT East 5, West -5 is #DIV/0! everywhere) --
        // else the quotient.
        let ratio = |own: Result<f64, &'static str>, base: Result<f64, &'static str>| match (own, base) {
            (Err(code), _) | (_, Err(code)) => ShownValue::Error(code),
            (Ok(_), Ok(b)) if b == 0.0 => ShownValue::Error("DIV/0!"),
            (Ok(v), Ok(b)) => ShownValue::Number(v / b),
        };
        // A ratio of the cell over its parent: EMPTY over any error and over
        // a zero parent (Excel [LIVE, piv6 p1 P_PCTPROW]: C/c1 West 3 under a
        // C Total West of 0 is EMPTY, never #DIV/0!).
        let parent_ratio = |own: Result<f64, &'static str>, base: Result<f64, &'static str>| match (own, base) {
            (Ok(v), Ok(b)) if b != 0.0 => ShownValue::Number(v / b),
            _ => ShownValue::Empty,
        };
        match show_as {
            ShowValuesAs::Normal => ShownValue::of(own),
            ShowValuesAs::PercentOfGrandTotal => {
                let gt = self.aggregate_at(&[], &[], vf_idx, aggregation);
                ratio(own, gt)
            }
            ShowValuesAs::PercentOfRowTotal => {
                let row_total = self.aggregate_at(row_values, &[], vf_idx, aggregation);
                ratio(own, row_total)
            }
            ShowValuesAs::PercentOfColumnTotal => {
                let col_total = self.aggregate_at(&[], col_values, vf_idx, aggregation);
                ratio(own, col_total)
            }
            ShowValuesAs::PercentOfParentRow => {
                let depth = shown_depth(row_values);
                let parent = &row_values[..depth.saturating_sub(1)];
                let parent_total = self.aggregate_at(parent, col_values, vf_idx, aggregation);
                parent_ratio(own, parent_total)
            }
            ShowValuesAs::PercentOfParentColumn => {
                let depth = shown_depth(col_values);
                let parent = &col_values[..depth.saturating_sub(1)];
                let parent_total = self.aggregate_at(row_values, parent, vf_idx, aggregation);
                parent_ratio(own, parent_total)
            }
            ShowValuesAs::Index => {
                let gt = self.aggregate_at(&[], &[], vf_idx, aggregation);
                let row_total = self.aggregate_at(row_values, &[], vf_idx, aggregation);
                let col_total = self.aggregate_at(&[], col_values, vf_idx, aggregation);
                match (own, gt, row_total, col_total) {
                    (Err(code), _, _, _) | (_, Err(code), _, _) | (_, _, Err(code), _) | (_, _, _, Err(code)) => {
                        ShownValue::Error(code)
                    }
                    // A zero row or column total is #DIV/0! (Excel [LIVE,
                    // piv6 p1 H_INDEX, p3 I_INDEX]); a zero grand total over
                    // non-zero totals is 0.
                    (Ok(value), Ok(gt), Ok(row_total), Ok(col_total)) => {
                        let denominator = row_total * col_total;
                        if denominator != 0.0 {
                            ShownValue::Number((value * gt) / denominator)
                        } else {
                            ShownValue::Error("DIV/0!")
                        }
                    }
                }
            }
            ShowValuesAs::Difference | ShowValuesAs::PercentDifference => {
                self.compute_difference(own, row_values, col_values, vf_idx, aggregation,
                    matches!(show_as, ShowValuesAs::PercentDifference))
            }
            ShowValuesAs::RunningTotal | ShowValuesAs::PercentOfRunningTotal => {
                self.compute_running_total(own, row_values, col_values, vf_idx, aggregation,
                    matches!(show_as, ShowValuesAs::PercentOfRunningTotal))
            }
            ShowValuesAs::RankAscending | ShowValuesAs::RankDescending => {
                self.compute_rank(own, row_values, col_values, vf_idx, aggregation,
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
    /// The blank member -- its key "" or its header text "(blank)" in any
    /// case (`is_blank_member_key`, ruling Q8) -- names the blank member when
    /// the field has one; otherwise "" falls through to an empty-text item.
    fn resolve_base_item_id(
        &mut self,
        field_index: FieldIndex,
        base_item: &str,
    ) -> Option<ValueId> {
        if base_item == "(previous)" || base_item == "(next)" {
            return None; // Sentinel - caller handles positional logic
        }
        if crate::cache::is_blank_member_key(base_item)
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

    /// Computes Difference or PercentDifference from base item (see
    /// [`Self::transform_show_values_as`] for what Excel shows over an error,
    /// a total and the base item itself).
    fn compute_difference(
        &mut self,
        own: Result<f64, &'static str>,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
        is_percent: bool,
    ) -> ShownValue {
        let resolved = self.resolve_base_field(vf_idx, row_values, col_values);
        let (is_row, pos, ordered_items) = match resolved {
            Some(v) => v,
            None => return ShownValue::of(own),
        };

        let vf = &self.definition.value_fields[vf_idx];
        let base_item_str = match &vf.base_item {
            Some(s) => s.clone(),
            None => return ShownValue::of(own),
        };

        // Current item's ValueId at the base field position
        let current_vid = if is_row {
            row_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        } else {
            col_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        };
        // A total of the base field (the grand total, a subtotal above it)
        // stands for no item: Excel shows it EMPTY [LIVE, piv5 p3].
        if !ordered_items.contains(&current_vid) {
            return ShownValue::Empty;
        }

        // Determine the target ValueId
        let base_fi = self.definition.value_fields[vf_idx].base_field_index.unwrap();
        let target_vid = if base_item_str == "(previous)" || base_item_str == "(next)" {
            // Find current position in ordered items
            let current_pos = ordered_items.iter().position(|&v| v == current_vid);
            match current_pos {
                Some(cp) => {
                    if base_item_str == "(previous)" {
                        if cp == 0 { return ShownValue::Empty; }
                        ordered_items[cp - 1]
                    } else {
                        // "(next)"
                        if cp + 1 >= ordered_items.len() { return ShownValue::Empty; }
                        ordered_items[cp + 1]
                    }
                }
                None => return ShownValue::Empty,
            }
        } else {
            match self.resolve_base_item_id(base_fi, &base_item_str) {
                Some(vid) => vid,
                None => return ShownValue::Empty,
            }
        };
        // The base item's own cell: EMPTY [LIVE, piv5 p3 A_DIFF_EAST].
        if target_vid == current_vid {
            return ShownValue::Empty;
        }

        // Build modified row/col values with the target item substituted
        let base_value = if is_row {
            let mut modified = row_values.to_vec();
            if pos < modified.len() {
                modified[pos] = target_vid;
            }
            self.aggregate_at(&modified, col_values, vf_idx, aggregation)
        } else {
            let mut modified = col_values.to_vec();
            if pos < modified.len() {
                modified[pos] = target_vid;
            }
            self.aggregate_at(row_values, &modified, vf_idx, aggregation)
        };

        if is_percent {
            // Excel [LIVE, piv6 p1 H_PDIFF_*, p2 R_PDIFF_*]: a cell no record
            // reaches is #NULL! whatever its base holds (an error, nothing, 0
            // or a number); a base with an error or with no records is EMPTY;
            // a base of 0 is #DIV/0!. Plain Difference From reads the empty
            // cell and the empty base as 0 (H_DIFF_Y2).
            let (cell_rows, cell_cols) = (row_values.to_vec(), col_values.to_vec());
            if !self.has_records_at(&cell_rows, &cell_cols, vf_idx) {
                return ShownValue::Error("NULL!");
            }
            let base_has_records = if is_row {
                let mut modified = cell_rows;
                if pos < modified.len() {
                    modified[pos] = target_vid;
                }
                self.has_records_at(&modified, &cell_cols, vf_idx)
            } else {
                let mut modified = cell_cols;
                if pos < modified.len() {
                    modified[pos] = target_vid;
                }
                self.has_records_at(&cell_rows, &modified, vf_idx)
            };
            match (own, base_value) {
                (_, Err(_)) => ShownValue::Empty,
                (Err(code), _) => ShownValue::Error(code),
                (Ok(_), Ok(_)) if !base_has_records => ShownValue::Empty,
                (Ok(_), Ok(base)) if base == 0.0 => ShownValue::Error("DIV/0!"),
                (Ok(value), Ok(base)) => ShownValue::Number((value - base) / base),
            }
        } else {
            match (own, base_value) {
                (Err(code), _) | (_, Err(code)) => ShownValue::Error(code),
                (Ok(value), Ok(base)) => ShownValue::Number(value - base),
            }
        }
    }

    /// Computes RunningTotal or PercentOfRunningTotal along the base field.
    fn compute_running_total(
        &mut self,
        own: Result<f64, &'static str>,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
        is_percent: bool,
    ) -> ShownValue {
        let resolved = self.resolve_base_field(vf_idx, row_values, col_values);
        let (is_row, pos, ordered_items) = match resolved {
            Some(v) => v,
            None => return ShownValue::of(own),
        };

        // Current item's ValueId
        let current_vid = if is_row {
            row_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        } else {
            col_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        };
        // A total of the base field is EMPTY -- under % Running Total In it
        // shows the error it holds [LIVE, piv5 p1 A_PCTRUN; p3].
        if !ordered_items.contains(&current_vid) {
            return match (is_percent, own) {
                (true, Err(code)) => ShownValue::Error(code),
                _ => ShownValue::Empty,
            };
        }

        // Sum the values from the first item through the current one (the
        // first error met is the answer from there on), and -- for the
        // percentage -- on through the last: the base field's total under
        // the cell's parent.
        let add = |acc: Result<f64, &'static str>, v: Result<f64, &'static str>| match (acc, v) {
            (Err(code), _) | (_, Err(code)) => Err(code),
            (Ok(a), Ok(b)) => Ok(a + b),
        };
        let mut total: Result<f64, &'static str> = Ok(0.0);
        let mut running: Option<Result<f64, &'static str>> = None;
        // Whether some item reads a non-zero number: % Running Total In over
        // a zero total is #DIV/0! then, and EMPTY when every item is 0 or
        // empty (Excel [LIVE, piv6 p1 K_PRUN East 5, Mid 0, West -5: #DIV/0!
        // in all three; H_PRUN_REG Y4 East 0, West 0: EMPTY; P_PRUN_ITEM]).
        let mut any_nonzero = false;
        for &vid in &ordered_items {
            let item_value = if is_row {
                let mut modified = row_values.to_vec();
                if pos < modified.len() {
                    modified[pos] = vid;
                }
                self.aggregate_at(&modified, col_values, vf_idx, aggregation)
            } else {
                let mut modified = col_values.to_vec();
                if pos < modified.len() {
                    modified[pos] = vid;
                }
                self.aggregate_at(row_values, &modified, vf_idx, aggregation)
            };
            any_nonzero |= matches!(item_value, Ok(v) if v != 0.0);
            total = add(total, item_value);
            if vid == current_vid {
                running = Some(total);
                if !is_percent {
                    break;
                }
            }
        }
        let running = running.unwrap_or(total);

        if is_percent {
            match (running, total) {
                (Err(code), _) | (_, Err(code)) => ShownValue::Error(code),
                (Ok(r), Ok(t)) if t != 0.0 => ShownValue::Number(r / t),
                (Ok(_), Ok(_)) if any_nonzero => ShownValue::Error("DIV/0!"),
                (Ok(_), Ok(_)) => ShownValue::Empty,
            }
        } else {
            ShownValue::of(running)
        }
    }

    /// Computes Rank (ascending or descending) among sibling items. An item
    /// that holds an error or that no record reaches is EMPTY and is not
    /// ranked; a total of the base field is EMPTY [LIVE, piv5 p1 A_RANKASC,
    /// p3; piv6 p1]; ties share a rank with no gap after them.
    fn compute_rank(
        &mut self,
        own: Result<f64, &'static str>,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
        descending: bool,
    ) -> ShownValue {
        let resolved = self.resolve_base_field(vf_idx, row_values, col_values);
        let (is_row, pos, ordered_items) = match resolved {
            Some(v) => v,
            None => return ShownValue::of(own),
        };
        let current_vid = if is_row {
            row_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        } else {
            col_values.get(pos).copied().unwrap_or(VALUE_ID_EMPTY)
        };
        if !ordered_items.contains(&current_vid) {
            return ShownValue::Empty;
        }
        let value = match own {
            Ok(v) => v,
            Err(_) => return ShownValue::Empty,
        };
        // A cell no record reaches is EMPTY and is not ranked (Excel [LIVE,
        // verify-piv5 v1 E_RANKASC_YEAR: Y2/East stays empty; piv6 p1
        // H_RANKASC_YEAR]) -- it is not a 0.
        if !self.has_records_at(row_values, col_values, vf_idx) {
            return ShownValue::Empty;
        }

        // Collect all sibling values (varying only the base field position);
        // an erroring sibling and an empty one are not ranked.
        let mut sibling_values: Vec<f64> = Vec::with_capacity(ordered_items.len());
        for &vid in &ordered_items {
            let (rows, cols) = if is_row {
                let mut modified = row_values.to_vec();
                if pos < modified.len() {
                    modified[pos] = vid;
                }
                (modified, col_values.to_vec())
            } else {
                let mut modified = col_values.to_vec();
                if pos < modified.len() {
                    modified[pos] = vid;
                }
                (row_values.to_vec(), modified)
            };
            let item_value = self.aggregate_at(&rows, &cols, vf_idx, aggregation);
            if let Ok(v) = item_value {
                if self.has_records_at(&rows, &cols, vf_idx) {
                    sibling_values.push(v);
                }
            }
        }

        // Ties share a rank and the next value takes the next number (Excel
        // [LIVE, verify-piv5 v1 G_RANKASC]: South 5, East 10, North 10, West
        // 20 rank 1, 2, 2, 3 -- never 1, 2, 2, 4): one plus the number of
        // DISTINCT sibling values that rank above the current one.
        let mut above: Vec<f64> = sibling_values
            .into_iter()
            .filter(|&v| if descending { v > value } else { v < value })
            .collect();
        above.sort_by(|a, b| a.total_cmp(b));
        above.dedup();
        let rank = above.len() + 1;

        ShownValue::Number(rank as f64)
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
    /// The BLANK MEMBER -- its key "" or its header text "(blank)" in any
    /// case (`is_blank_member_key`) -- resolves to `VALUE_ID_EMPTY`: blanks
    /// are never interned, so the scan over the interned values below could
    /// never find them, and hiding "(blank)" -- or an inclusion
    /// `Region = ("East")` inverted into "hide every other item" -- kept every
    /// blank record (BUG-0197). It also resolves to every EMPTY-TEXT item:
    /// a NULL and an empty string are ONE member (ruling Q8, Power BI's
    /// "(Blank)"), listed once under the key "", so hiding it hides both.
    fn resolve_hidden_ids(field_cache: &crate::cache::FieldCache, hidden_items: &[String]) -> Vec<ValueId> {
        let mut ids = Vec::new();
        for hidden_str in hidden_items {
            if crate::cache::is_blank_member_key(hidden_str) {
                if !ids.contains(&VALUE_ID_EMPTY) {
                    ids.push(VALUE_ID_EMPTY);
                }
                for id in 0..field_cache.unique_count() as ValueId {
                    if matches!(field_cache.get_value(id), Some(CacheValue::Text(s)) if s.is_empty())
                        && !ids.contains(&id)
                    {
                        ids.push(id);
                    }
                }
                if hidden_str.is_empty() {
                    continue;
                }
            }
            // By its display spelling, or by its member KEY (the spelling
            // every member list hands out -- they differ for a decimal,
            // "5.5" vs "5.50", `MemberKind::Decimal`).
            for id in 0..field_cache.unique_count() as ValueId {
                if let Some(value) = field_cache.get_value(id) {
                    if Self::cache_value_display(value) == *hidden_str || field_cache.member_key(id) == *hidden_str {
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
            let vf_idx = self.cache.add_virtual_field(name, field.source_index);
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
                        self.cache.virtual_fields[vf_idx]
                            .label_source_map.insert(vid, MemberSource::Month { month: (i + 1) as u32 });
                    }
                }
                DateGroupLevel::Quarter => {
                    for q in 1..=4u32 {
                        let vid = self.cache.virtual_fields[vf_idx]
                            .intern(CacheValue::Number(OrderedFloat(q as f64)));
                        self.cache.virtual_fields[vf_idx]
                            .label_map.insert(vid, format!("Q{}", q));
                        self.cache.virtual_fields[vf_idx]
                            .label_source_map.insert(vid, MemberSource::Quarter { quarter: q });
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
                            // The KEY stays the invariant text it always was;
                            // the SOURCE says how to write it for a locale:
                            // Year / Day as General numbers, Week as its own
                            // key ("W01" is not a number).
                            let (label, source) = match level {
                                DateGroupLevel::Year => {
                                    let year = n.as_f64() as i64;
                                    (format!("{}", year), MemberSource::Number { value: year as f64 })
                                }
                                DateGroupLevel::Week => (format!("W{:02}", n.as_f64() as u32), MemberSource::Text),
                                DateGroupLevel::Day => {
                                    let day = n.as_f64() as u32;
                                    (format!("{}", day), MemberSource::Number { value: day as f64 })
                                }
                                _ => unreachable!(),
                            };
                            labels.push((id, label, source));
                        }
                    }
                    for (id, label, source) in labels {
                        self.cache.virtual_fields[vf_idx].label_map.insert(id, label);
                        self.cache.virtual_fields[vf_idx].label_source_map.insert(id, source);
                    }
                }
                _ => {} // Month and Quarter already handled in pre-intern
            }
        }

        // Create effective PivotField entries for each date level. The
        // FINEST level is this field, with its own sort; every level above
        // it is a field of its own with its own sort (`level_sorts`), as
        // Excel keeps Years, Quarters and Date apart (verify-pivotfix).
        let finest = vf_info.len().saturating_sub(1);
        for (pos, &(level, vf_idx, effective_index)) in vf_info.iter().enumerate() {
            let name = format_date_level_name(&field.name, level);
            let mut vf_field = PivotField::new(effective_index, name);
            if pos == finest {
                vf_field.sort_order = field.sort_order;
                vf_field.value_sort = field.value_sort.clone();
                vf_field.manual_item_order = field.manual_item_order.clone();
            } else {
                let own = field.level_sort(level.level_key());
                self.cache.set_virtual_level(vf_idx, level.level_key());
                vf_field.sort_order = own.sort_order;
                vf_field.value_sort = own.value_sort;
                vf_field.manual_item_order = own.manual_item_order;
            }
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
        let vf_idx = self.cache.add_virtual_field(name.clone(), field.source_index);
        let effective_index = base_field_count + vf_idx;

        // Pre-compute bin labels and pre-intern them in order
        let bin_count = ((end - start) / interval).ceil() as usize;
        for bin_idx in 0..bin_count {
            let bin_start = start + (bin_idx as f64) * interval;
            let bin_end = (bin_start + interval).min(end);
            // KEY unchanged; the SOURCE carries the typed bin so its label
            // is written with the app locale's separators. A single-width
            // integer bin is one number; `end` is the bin's EXCLUSIVE end.
            let (label, source) = if bin_start.fract() == 0.0 && bin_end.fract() == 0.0 {
                if bin_end - bin_start == 1.0 {
                    (
                        format!("{}", bin_start as i64),
                        MemberSource::Number { value: (bin_start as i64) as f64 },
                    )
                } else {
                    (
                        format!("{}-{}", bin_start as i64, (bin_end - 1.0) as i64),
                        MemberSource::NumberBin { start: bin_start, end: bin_end, integer: true },
                    )
                }
            } else {
                (
                    format!("{:.2}-{:.2}", bin_start, bin_end),
                    MemberSource::NumberBin { start: bin_start, end: bin_end, integer: false },
                )
            };
            let vid = self.cache.virtual_fields[vf_idx]
                .intern(CacheValue::Number(OrderedFloat(bin_idx as f64)));
            self.cache.virtual_fields[vf_idx].label_map.insert(vid, label);
            self.cache.virtual_fields[vf_idx].label_source_map.insert(vid, source);
        }

        // Also pre-intern overflow bin labels
        let under_vid = self.cache.virtual_fields[vf_idx]
            .intern(CacheValue::Number(OrderedFloat(-1.0)));
        self.cache.virtual_fields[vf_idx]
            .label_map.insert(under_vid, format!("<{}", start));
        self.cache.virtual_fields[vf_idx]
            .label_source_map.insert(under_vid, MemberSource::BinBelow { start });
        let over_vid = self.cache.virtual_fields[vf_idx]
            .intern(CacheValue::Number(OrderedFloat(bin_count as f64)));
        self.cache.virtual_fields[vf_idx]
            .label_map.insert(over_vid, format!(">{}", end));
        self.cache.virtual_fields[vf_idx]
            .label_source_map.insert(over_vid, MemberSource::BinAbove { end });

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
        vf_field.value_sort = field.value_sort.clone();
        vf_field.manual_item_order = field.manual_item_order.clone();
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
        let vf_idx = self.cache.add_virtual_field(name.clone(), field.source_index);
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
        // The group field is a field of its own, with its own sort: sorting
        // it leaves the detail field's order alone [LIVE, verify-pivotfix
        // probe3 A_ORDERS]. It used to copy the detail field's.
        let mut group_field = PivotField::new(effective_index, name);
        let own = field.level_sort(crate::definition::MANUAL_GROUP_LEVEL);
        self.cache.set_virtual_level(vf_idx, crate::definition::MANUAL_GROUP_LEVEL);
        group_field.sort_order = own.sort_order;
        group_field.value_sort = own.value_sort;
        group_field.manual_item_order = own.manual_item_order;
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
                // MANUAL with a stored order (BUG-0733): the listed items in
                // the list's order, then every other item in source order.
                if field.sort_order == SortOrder::Manual && !field.manual_item_order.is_empty() {
                    let listed = field.manual_item_order.len();
                    for rank in first_shown.values_mut() {
                        *rank = rank.saturating_add(listed);
                    }
                    for (position, key) in field.manual_item_order.iter().enumerate() {
                        if let Some(id) = self.member_id_of_key(field.source_index, key) {
                            first_shown.insert(id, position);
                        }
                    }
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
        // A field sorted by VALUE is first put in ASCENDING label order in
        // either direction: `apply_value_sorts` then re-orders it, breaking
        // ties by that order (`value_sort_level`).
        let label_order = match field.sort_order {
            crate::definition::SortOrder::Descending if self.value_sort_field_index(field).is_some() => {
                crate::definition::SortOrder::Ascending
            }
            order => order,
        };
        self.sort_value_ids(
            &mut sorted_ids,
            field_cache,
            &label_order,
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
                // never the order a hash set yields them. MANUAL is its
                // stored item order (`PivotField::manual_item_order`, folded
                // into `source_order` by build_axis_tree), the source's for
                // every item it does not list. Both override sort-by-column.
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
    
    // ========================================================================
    // SORT BY VALUE (BUG-0459)
    // ========================================================================

    /// The value field (index into `definition.value_fields`) a field sorts
    /// by when its VALUE sort is in force: it has a `value_sort`, is sorted
    /// Ascending or Descending (Manual / DataSourceOrder ignore it), and some
    /// value field carries the sort's name. `None`: the field sorts by label.
    fn value_sort_field_index(&self, field: &PivotField) -> Option<usize> {
        use crate::definition::SortOrder;
        let vs = field.value_sort.as_ref()?;
        if !matches!(field.sort_order, SortOrder::Ascending | SortOrder::Descending) {
            return None;
        }
        self.definition.value_fields.iter().position(|v| v.name == vs.value_field)
    }

    /// The member id a scope KEY names on the field at `effective_index`:
    /// the blank member for the key "" (`BLANK_MEMBER_KEY`), else the item
    /// whose `member_key` is the key. `None`: no item carries it.
    fn member_id_of_key(&self, effective_index: FieldIndex, key: &str) -> Option<ValueId> {
        if key == crate::cache::BLANK_MEMBER_KEY {
            return Some(VALUE_ID_BLANK);
        }
        let fc = self.cache.get_field(effective_index)?;
        (0..fc.unique_count() as ValueId).find(|&id| fc.member_key(id) == key)
    }

    /// Re-orders the items of every level of `tree` whose field sorts by
    /// VALUE (`PivotField::value_sort`): within each parent, by the data
    /// field's aggregate at that item along the sort's line of the OTHER
    /// axis (`other_fields`; an empty scope is that axis's grand total).
    ///
    /// Excel's rules [LIVE Excel 16, `PivotField.AutoSort` with and without a
    /// PivotLine]: siblings are sorted, parents are not moved by a child
    /// level's sort; an item with NO data on the line is the smallest (first
    /// ascending, last descending); equal values are ordered by label, as
    /// `value_sort_level` spells out. The value read is the
    /// cell's own aggregate -- for a data-model pivot the engine's, since
    /// its totals overrides are already in the accumulators.
    fn apply_value_sorts(
        &mut self,
        tree: &mut Vec<AxisNode>,
        fields: &[PivotField],
        other_fields: &[PivotField],
        is_row: bool,
    ) {
        use crate::definition::SortOrder;
        // Per level: (value field, descending, the line's member ids).
        let plans: Vec<Option<(usize, bool, Vec<ValueId>)>> = fields
            .iter()
            .map(|field| {
                let vf_idx = self.value_sort_field_index(field)?;
                let vs = field.value_sort.as_ref()?;
                let descending = field.sort_order == SortOrder::Descending;
                // A line deeper than the other axis, or a key no item carries
                // any more: there is no such line, every item reads blank, and
                // the ascending label order stands.
                if vs.scope.len() > other_fields.len() {
                    return None;
                }
                let mut line = Vec::with_capacity(vs.scope.len());
                for (key, other) in vs.scope.iter().zip(other_fields) {
                    line.push(self.member_id_of_key(other.source_index, key)?);
                }
                Some((vf_idx, descending, line))
            })
            .collect();
        if plans.iter().all(Option::is_none) {
            return;
        }
        self.ensure_aggregates_computed();
        let mut path: Vec<ValueId> = Vec::new();
        self.value_sort_level(tree, 0, &plans, &mut path, is_row);
    }

    /// Gives every row subtotal and the grand total the errors of its items
    /// in DISPLAY order (`PivotCache::rederive_total_errors`), deepest level
    /// first, once the row items are in their final order. A no-op unless the
    /// aggregation saw a source error. Without row fields the grand total
    /// keeps its records' first error in source order, as Excel's does
    /// [LIVE, piv4 probe5 F_NOROWS]. The COLUMN axis's totals keep
    /// source order (not probed).
    fn rederive_row_total_errors(&mut self, tree: &[AxisNode]) {
        if tree.is_empty() {
            return;
        }
        self.ensure_aggregates_computed();
        if !self.cache.source_errors_seen() {
            return;
        }
        let row_len = self.row_field_indices.len();
        let mut path: Vec<ValueId> = Vec::new();
        self.rederive_row_total_errors_level(tree, &mut path, row_len);
    }

    fn rederive_row_total_errors_level(&mut self, nodes: &[AxisNode], path: &mut Vec<ValueId>, row_len: usize) {
        for node in nodes {
            if !node.children.is_empty() {
                path.push(node.value_id);
                self.rederive_row_total_errors_level(&node.children, path, row_len);
                path.pop();
            }
        }
        let pad = |p: &[ValueId]| {
            let mut key = vec![VALUE_ID_EMPTY; row_len];
            let n = p.len().min(row_len);
            key[..n].copy_from_slice(&p[..n]);
            key
        };
        let parent = pad(path);
        let children: Vec<Vec<ValueId>> = nodes
            .iter()
            .map(|node| {
                path.push(node.value_id);
                let key = pad(path);
                path.pop();
                key
            })
            .collect();
        self.cache.rederive_total_errors(&parent, &children);
    }

    /// One level of [`Self::apply_value_sorts`]: sorts `nodes` (the children
    /// of the item at `path`) when level `level` sorts by value, then recurses.
    fn value_sort_level(
        &self,
        nodes: &mut Vec<AxisNode>,
        level: usize,
        plans: &[Option<(usize, bool, Vec<ValueId>)>],
        path: &mut Vec<ValueId>,
        is_row: bool,
    ) {
        if let Some(Some((vf_idx, descending, line))) = plans.get(level) {
            let aggregation = self.definition.value_fields[*vf_idx].aggregation;
            let keys: Vec<ValueSortKey> = nodes
                .iter()
                .map(|node| {
                    path.push(node.value_id);
                    let value = if is_row {
                        self.aggregate_or_blank(path, line, *vf_idx, aggregation)
                    } else {
                        self.aggregate_or_blank(line, path, *vf_idx, aggregation)
                    };
                    path.pop();
                    value
                })
                .collect();
            let mut order: Vec<usize> = (0..nodes.len()).collect();
            // Equal values: the nodes were built in ASCENDING label order, so
            // the index is the label order. Excel [LIVE] keeps it ascending
            // for the direction that is "natural" to the line and reverses it
            // for the other: along a COLUMN line ascending ties read A..Z and
            // descending is the exact reverse (Z..A); along the GRAND TOTAL
            // descending ties read A..Z and ascending is the exact reverse.
            //
            // An item whose value is an ERROR (BUG-0760 follow-up) goes LAST in
            // both directions, and the error items follow the sort's own
            // direction by label (Excel [LIVE, piv4 probe4], by the grand
            // total: descending East 17, North 3, West, South; ascending
            // North 3, East 17, South, West).
            let ties_descending = if line.is_empty() { !*descending } else { *descending };
            order.sort_by(|&a, &b| {
                use std::cmp::Ordering;
                match (keys[a], keys[b]) {
                    (ValueSortKey::Error, ValueSortKey::Error) => {
                        return if *descending { b.cmp(&a) } else { a.cmp(&b) };
                    }
                    (ValueSortKey::Error, _) => return Ordering::Greater,
                    (_, ValueSortKey::Error) => return Ordering::Less,
                    _ => {}
                }
                let by_value = match (keys[a], keys[b]) {
                    (ValueSortKey::Blank, ValueSortKey::Blank) => Ordering::Equal,
                    (ValueSortKey::Blank, _) => Ordering::Less,
                    (_, ValueSortKey::Blank) => Ordering::Greater,
                    (ValueSortKey::Number(x), ValueSortKey::Number(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
                    _ => Ordering::Equal,
                };
                let by_value = if *descending { by_value.reverse() } else { by_value };
                by_value.then_with(|| if ties_descending { b.cmp(&a) } else { a.cmp(&b) })
            });
            let mut taken: Vec<Option<AxisNode>> = std::mem::take(nodes).into_iter().map(Some).collect();
            *nodes = order.into_iter().filter_map(|i| taken[i].take()).collect();
        }
        if level + 1 < plans.len() {
            for node in nodes.iter_mut() {
                path.push(node.value_id);
                self.value_sort_level(&mut node.children, level + 1, plans, path, is_row);
                path.pop();
            }
        }
    }

    /// The aggregate of value field `vf_idx` at a (row path, column path)
    /// intersection -- each a prefix of member ids, a shorter one reading the
    /// subtotal -- as a value-sort key: `Blank` when no record reaches it
    /// (Excel's empty cell), `Error` when the cell shows an error.
    fn aggregate_or_blank(
        &self,
        row_values: &[ValueId],
        col_values: &[ValueId],
        vf_idx: usize,
        aggregation: AggregationType,
    ) -> ValueSortKey {
        let row_len = self.row_field_indices.len();
        let mut key = vec![VALUE_ID_EMPTY; row_len];
        let n = row_values.len().min(row_len);
        key[..n].copy_from_slice(&row_values[..n]);
        let Some(acc) = self
            .cache
            .get_row_slot(&key)
            .and_then(|slot| slot.get(self.cache.col_layout().acc_index(col_values, vf_idx)))
        else {
            return ValueSortKey::Blank;
        };
        if acc.count == 0 {
            ValueSortKey::Blank
        } else if acc.error_code(aggregation).is_some() {
            ValueSortKey::Error
        } else {
            ValueSortKey::Number(acc.compute(aggregation))
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
    
    /// The HEADER TEXT of a member: its key ([`crate::cache::FieldCache::member_key`],
    /// the one spelling the engine and the host share), except that the
    /// blank member's header still reads [`crate::cache::BLANK_ITEM_LABEL`]
    /// ("(blank)") where its KEY is "" (ruling Q8). Every header, GETPIVOTDATA
    /// and `group_path` name is therefore byte-identical to before the key
    /// function moved. The name resolvers (hidden items, base items) read the
    /// blank by either spelling -- its header text "(blank)" or its Q8 key ""
    /// (`crate::cache::is_blank_member_key`, P2 S4) -- and a hidden blank
    /// hides the empty-TEXT items too: a NULL and an empty string are ONE
    /// member (ruling Q8).
    fn get_value_label(
        &self,
        field_cache: &crate::cache::FieldCache,
        value_id: ValueId,
    ) -> String {
        if value_id == VALUE_ID_EMPTY
            || value_id == VALUE_ID_BLANK
            || (!field_cache.label_map.contains_key(&value_id)
                && matches!(field_cache.get_value(value_id), Some(CacheValue::Empty)))
        {
            return crate::cache::BLANK_ITEM_LABEL.to_string();
        }
        field_cache.member_key(value_id)
    }

    /// The [`MemberSource`] of the member a header cell for `item` shows at
    /// `depth`, or `None` when that cell does not show one member of an axis
    /// field: the grand total, an item's own subtotal / value-field row, a
    /// level past the item's fields, or any text that is not the member's own
    /// header text (`"East Total"`, `"Sum of Sales"`, a calculated item) --
    /// the guard compares the shown `label` with the member's header text, so
    /// a source is never attached to a cell that names something else.
    fn member_source_at(&self, item: &FlatAxisItem, depth: usize, label: &str) -> Option<MemberSource> {
        if item.is_grand_total {
            return None;
        }
        if depth == item.depth && (item.is_subtotal || item.value_field.is_some()) {
            return None;
        }
        let id = *item.group_values.get(depth)?;
        if id == VALUE_ID_EMPTY {
            return None;
        }
        let fi = *item.field_indices.get(depth)?;
        let fc = self.cache.get_field(fi)?;
        if self.get_value_label(fc, id) != label {
            return None;
        }
        Some(fc.member_source(id))
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
                sort_order: f.sort_order,
                value_sort_field: self.value_sort_field_index(f).map(|i| self.definition.value_fields[i].name.clone()),
            }
        }).collect();

        view.column_field_summaries = self.effective_col_fields.iter().map(|f| {
            HeaderFieldSummary {
                field_index: f.source_index,
                field_name: f.name.clone(),
                has_active_filter: !f.hidden_items.is_empty(),
                sort_order: f.sort_order,
                value_sort_field: self.value_sort_field_index(f).map(|i| self.definition.value_fields[i].name.clone()),
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

            // Collect unique values for this filter field (KEYS, with the
            // source each one's label is written from)
            let (unique_values, member_sources) = self.collect_unique_members_for_field(field_index);

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
                member_sources: member_sources.clone(),
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
            // One selected item: the dropdown SHOWS that member, so it
            // carries the member's source (its label is localised by the
            // host); "(All)", "(None)" and "(N items)" carry none.
            // (The same test that chose `display_value` above.)
            let shows_one_item = !(hidden_items.is_empty() || selected_values.len() == unique_values.len())
                && selected_values.len() == 1;
            if shows_one_item {
                dropdown_cell.member_source = unique_values
                    .iter()
                    .position(|v| *v == selected_values[0])
                    .and_then(|i| member_sources.get(i).cloned());
            }
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
    
    /// Collects all unique values for a field as KEY strings (the header
    /// text), each with the [`MemberSource`] its label is written from.
    fn collect_unique_members_for_field(&self, field_index: FieldIndex) -> (Vec<String>, Vec<MemberSource>) {
        let mut values = Vec::new();
        let mut sources = Vec::new();

        if let Some(field_cache) = self.cache.fields.get(field_index) {
            for id in 0..field_cache.unique_count() as ValueId {
                values.push(self.get_value_label(field_cache, id));
                sources.push(field_cache.member_source(id));
            }
        }

        (values, sources)
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
                            ch.member_source = self.member_source_at(item, item.depth, &item.label);
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
                                ch.member_source = self.member_source_at(anc, anc.depth, &anc.label);
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
                                let (label, source) = if let Some(fc) = self.cache.fields.get(fi) {
                                    (self.get_value_label(fc, gv), Some(fc.member_source(gv)))
                                } else {
                                    (format!("{}", gv), None)
                                };
                                PivotViewCell::column_header(label).with_member_source(source)
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
                    cell.member_source = self.member_source_at(item, item.depth, &item.label);
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
                            cell.member_source = self.member_source_at(item, item.depth, &item.label);
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
                            let source = self.member_source_at(item, col, &parent_label);
                            let mut cell = PivotViewCell::row_header(parent_label, 0).with_member_source(source);
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
            let mut vf_errors: Vec<Option<&'static str>> = Vec::with_capacity(value_fields.len());
            // A cell no record reaches is EMPTY, as Excel shows it -- never a
            // 0 -- and so is one a mask overlay answered BLANK. Under Show
            // Values As it shows the computed value (Excel [LIVE, piv4
            // probe6]: Running Total In 0, % of Row 0,00% in such a cell).
            let mut vf_empty: Vec<bool> = Vec::with_capacity(value_fields.len());
            for (vf_idx, vf) in value_fields.iter().enumerate() {
                let aggregate = self.lookup_aggregate_col(&[], vf_idx, vf.aggregation);
                vf_aggregates.push(aggregate);
                vf_errors.push(self.lookup_aggregate_error_col(&[], vf_idx, vf.aggregation));
                vf_empty.push(
                    vf.show_values_as == ShowValuesAs::Normal
                        && self.lookup_accumulator_col(&[], vf_idx).is_none_or(|a| a.count == 0),
                );
                if let Some(fc) = self.cache.get_field(vf.source_index) {
                    field_values.insert(fc.name.clone(), aggregate);
                }
                field_values.insert(vf.name.clone(), aggregate);
            }
            let calc_errors = self.lookup_calc_errors_col(&[], value_fields);

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

                        let mut cell = PivotViewCell::data(aggregate);
                        if vf.show_values_as == ShowValuesAs::Normal {
                            if let Some(code) = vf_errors[vf_idx] {
                                cell.value = PivotCellValue::Error(code.to_string());
                            } else if vf_empty[vf_idx] {
                                cell.value = PivotCellValue::Empty;
                            }
                        } else {
                            // Show Values As decides what an error in the
                            // cell or in its base shows (see the transform).
                            let own = match vf_errors[vf_idx] {
                                Some(code) => Err(code),
                                None => Ok(aggregate),
                            };
                            cell.value = self
                                .transform_show_values_as(
                                    own, &row_item.group_values, &[],
                                    vf_idx, vf.aggregation, vf.show_values_as,
                                )
                                .into_cell_value();
                        }
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

                        let result = if let Some(err) = calc_field_source_error(&cf.formula, &calc_errors) {
                            err
                        } else if let Some((ri, vd)) = visual_ctx_data {
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
                        cell.calculated_field_index = Some(cf_idx);
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

                // Batched lookup: only the column portion changes per cell.
                // The row key is prepared AGAIN for each cell, because the
                // previous cell's Show Values As (% of Column Total, % of
                // Parent ...) reads other rows through `compute_aggregate`,
                // which rewrites the same key buffer.
                self.prepare_row_key(&row_item.group_values);
                let aggregate = self.lookup_aggregate_col(
                    &col_group_values,
                    vf_idx,
                    vf.aggregation,
                );
                let source_error = self.lookup_aggregate_error_col(&col_group_values, vf_idx, vf.aggregation);
                // A cell no record reaches is EMPTY, as Excel shows it (an
                // intersection with no data, an item shown with no data),
                // never a 0 -- under Show Values As the computed value stands
                // (Excel [LIVE, piv4 probe6]: Running Total In reads 0 and %
                // of Row 0,00% there).
                let no_records = vf.show_values_as == ShowValuesAs::Normal
                    && self.lookup_accumulator_col(&col_group_values, vf_idx).is_none_or(|a| a.count == 0);

                let mut cell = PivotViewCell::data(aggregate);
                if vf.show_values_as == ShowValuesAs::Normal {
                    if let Some(code) = source_error {
                        cell.value = PivotCellValue::Error(code.to_string());
                    } else if no_records {
                        cell.value = PivotCellValue::Empty;
                    }
                } else {
                    // Apply show_values_as transformation: it decides what
                    // an error in the cell or in its base shows.
                    let own = match source_error {
                        Some(code) => Err(code),
                        None => Ok(aggregate),
                    };
                    cell.value = self
                        .transform_show_values_as(
                            own,
                            &row_item.group_values,
                            &col_group_values,
                            vf_idx,
                            vf.aggregation,
                            vf.show_values_as,
                        )
                        .into_cell_value();
                }
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
        // The data cells before these may have rewritten the key buffer
        // (Show Values As reads other rows through `compute_aggregate`).
        self.prepare_row_key(&row_item.group_values);

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
            let calc_errors = self.lookup_calc_errors_col(&[], value_fields);

            for (cf_idx, cf) in calc_fields.iter().enumerate() {
                let result = if let Some(err) = calc_field_source_error(&cf.formula, &calc_errors) {
                    err
                } else if let Some((ri, vd)) = row_visual_ctx {
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
                cell.calculated_field_index = Some(cf_idx);
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
                let calc_errors = self.lookup_calc_errors_col(col_group_values, value_fields);

                for (cf_idx, cf) in calc_fields.iter().enumerate() {
                    let result = if let Some(err) = calc_field_source_error(&cf.formula, &calc_errors) {
                        err
                    } else if needs_col_ctx || row_visual_ctx.is_some() {
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
                    cell.calculated_field_index = Some(cf_idx);
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

    /// [`Self::compute_aggregate`] with the error the cell there shows
    /// (`AggregateAccumulator::error_code`): what a Show Values As
    /// calculation reads of a total or a sibling. No accumulator reads 0.
    fn aggregate_at(
        &mut self,
        row_values: &[ValueId],
        col_values: &[ValueId],
        value_field_idx: usize,
        aggregation: AggregationType,
    ) -> Result<f64, &'static str> {
        let value = self.compute_aggregate(row_values, col_values, value_field_idx, aggregation);
        // `compute_aggregate` left the padded row key in the buffer.
        match self.lookup_aggregate_error_col(col_values, value_field_idx, aggregation) {
            Some(code) => Err(code),
            None => Ok(value),
        }
    }

    /// Whether any record reaches the value cell at `row_values` x
    /// `col_values` (an accumulator with a count): what tells an EMPTY cell
    /// from one that sums to 0 for the Show Values As kinds that treat them
    /// differently (Rank, % Difference From). Leaves the padded row key in
    /// the buffer, as [`Self::aggregate_at`] does.
    fn has_records_at(
        &mut self,
        row_values: &[ValueId],
        col_values: &[ValueId],
        value_field_idx: usize,
    ) -> bool {
        self.prepare_row_key(row_values);
        self.lookup_accumulator_col(col_values, value_field_idx).is_some_and(|a| a.count > 0)
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

    /// The accumulator [`Self::lookup_aggregate_col`] reads, if any.
    fn lookup_accumulator_col(
        &self,
        col_values: &[ValueId],
        value_field_idx: usize,
    ) -> Option<&crate::cache::AggregateAccumulator> {
        let slot = self.cache.get_row_slot(&self.agg_key_buf)?;
        slot.get(self.cache.col_layout().acc_index(col_values, value_field_idx))
    }

    /// The error the value cell at (prepared row key, `col_values`) shows
    /// instead of [`Self::lookup_aggregate_col`]'s number, as a bare code
    /// (BUG-0760 follow-up: a source error, or Average / StdDev / Var of too
    /// few numbers -- see `AggregateAccumulator::error_code`).
    fn lookup_aggregate_error_col(
        &self,
        col_values: &[ValueId],
        value_field_idx: usize,
        aggregation: AggregationType,
    ) -> Option<&'static str> {
        self.lookup_accumulator_col(col_values, value_field_idx)?.error_code(aggregation)
    }

    /// The errors a calculated field reads at (prepared row key,
    /// `col_values`), by the names `field_values` holds: a value field's own
    /// name reads the error its cell shows, its SOURCE field's name the last
    /// source error (Excel [LIVE, piv4 probe5]: a calculated field over a
    /// group holding #DIV/0! then #N/A answers #N/A).
    fn lookup_calc_errors_col(
        &self,
        col_values: &[ValueId],
        value_fields: &[ValueField],
    ) -> std::collections::HashMap<String, &'static str> {
        let mut errors = std::collections::HashMap::new();
        for (vf_idx, vf) in value_fields.iter().enumerate() {
            let Some(acc) = self.lookup_accumulator_col(col_values, vf_idx) else { continue };
            if let Some(code) = acc.error_code(vf.aggregation) {
                errors.insert(vf.name.clone(), code);
            }
            if let (Some(last), Some(fc)) = (acc.last_error, self.cache.get_field(vf.source_index)) {
                errors.insert(fc.name.clone(), crate::cache::accumulator_error_code(last));
            }
        }
        errors
    }
}

/// What a value cell under Show Values As shows
/// ([`PivotCalculator::transform_show_values_as`]).
#[derive(Debug, Clone, Copy, PartialEq)]
enum ShownValue {
    Number(f64),
    Error(&'static str),
    Empty,
}

impl ShownValue {
    /// An aggregate shown as it is: its number or its error.
    fn of(value: Result<f64, &'static str>) -> Self {
        match value {
            Ok(n) => ShownValue::Number(n),
            Err(code) => ShownValue::Error(code),
        }
    }

    fn into_cell_value(self) -> PivotCellValue {
        match self {
            ShownValue::Number(n) if n.is_nan() => PivotCellValue::Empty,
            // `+ 0.0` turns the -0 of 0 / -3 into 0: Excel has no negative
            // zero (piv6 p1 P_PCTPCOL c2 East 0,00%).
            ShownValue::Number(n) => PivotCellValue::Number(n + 0.0),
            ShownValue::Error(code) => PivotCellValue::Error(code.to_string()),
            ShownValue::Empty => PivotCellValue::Empty,
        }
    }
}

/// How many levels of an axis path name an item: a subtotal's or the grand
/// total's path is padded with `VALUE_ID_EMPTY` ("all values") below it.
fn shown_depth(values: &[ValueId]) -> usize {
    values.iter().position(|&v| v == VALUE_ID_EMPTY).unwrap_or(values.len())
}

/// The error a calculated field answers when a field its formula names reads
/// an error at this cell (`errors`, from `lookup_calc_errors_col`): the first
/// such reference's, in formula order. `None`: evaluate the formula.
fn calc_field_source_error(
    formula: &str,
    errors: &std::collections::HashMap<String, &'static str>,
) -> Option<crate::calculated::CalcValue> {
    if errors.is_empty() {
        return None;
    }
    let refs = crate::calculated::extract_references(formula).ok()?;
    refs.iter()
        .find_map(|r| {
            errors
                .get(r)
                .or_else(|| errors.iter().find(|(k, _)| k.eq_ignore_ascii_case(r)).map(|(_, v)| v))
        })
        .map(|code| crate::calculated::CalcValue::Error((*code).to_string()))
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

/// Applies `definition`'s hidden items to `cache.filter_mask` exactly as the
/// first step of [`calculate_pivot`] does, and nothing else: afterwards
/// `cache.filter_mask` is the mask a calculation of `definition` aggregates
/// over. The host plans a filtered state's [`crate::cache::MaskOverlay`] from
/// it (BUG-0108) without laying a whole view out.
pub fn apply_definition_filters(definition: &PivotDefinition, cache: &mut PivotCache) {
    PivotCalculator::new(definition, cache).apply_filters();
}

/// The value ids a field's `hidden_items` list names, resolved EXACTLY as the
/// engine resolves them when it applies the filter (`resolve_hidden_ids`): an
/// item matches a member by its DISPLAY spelling ("5.5") OR by its member KEY
/// ("5.50", `FieldCache::member_key`), and the blank member -- its key "" or
/// the header text "(blank)" in any case -- resolves to `VALUE_ID_EMPTY` plus
/// every empty-text item (one member, ruling Q8). An item that names nothing
/// contributes nothing, so a caller resolving items ONE AT A TIME can tell a
/// carried filter from one it must report as lost.
///
/// The host's drill-through (`drill_through.rs`, `pivotContext`) needs this to
/// turn a pivot's standing filters into member KEYS: `hidden_items` is
/// "the string representation of hidden values" (`PivotField`), which is the
/// display spelling for a filter the user ticked and the key for one a slicer
/// wrote, and an engine IN-list matches keys only.
pub fn hidden_member_ids(field_cache: &crate::cache::FieldCache, hidden_items: &[String]) -> Vec<ValueId> {
    PivotCalculator::resolve_hidden_ids(field_cache, hidden_items)
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

    /// `hidden_member_ids` is the engine's OWN resolution, exposed: display
    /// spelling and member key both name a member, the blank's two spellings
    /// name `VALUE_ID_EMPTY` and the empty-text item, and an item that names
    /// nothing contributes nothing (so a per-item caller can report it lost).
    #[test]
    fn hidden_member_ids_resolve_as_the_engine_filter_does() {
        let mut cache = PivotCache::new(test_pivot_id(), 2);
        cache.set_field_name(0, "Price".to_string());
        cache.set_field_name(1, "Region".to_string());
        cache.add_record(0, &[CellValue::Number(5.5), CellValue::Text("East".to_string())]);
        cache.add_record(1, &[CellValue::Number(10.0), CellValue::Text(String::new())]);
        cache.add_record(2, &[CellValue::Empty, CellValue::Text("West".to_string())]);
        // A Decimal column: the KEY keeps the scale ("5.50"), the DISPLAY does
        // not ("5.5") -- the exact divergence a ticked filter and a slicer-
        // written one differ by.
        cache.fields[0].member_kind = crate::cache::MemberKind::Decimal { scale: 2 };
        let price = &cache.fields[0];
        let region = &cache.fields[1];
        let five_five = price.find_id(&CacheValue::Number(OrderedFloat(5.5))).expect("5.5 interned");
        let ten = price.find_id(&CacheValue::Number(OrderedFloat(10.0))).expect("10 interned");
        let empty_text = region.find_id(&CacheValue::Text(String::new())).expect("'' interned");

        assert_eq!(price.member_key(five_five), "5.50");
        // By display spelling, and by key: the same member.
        assert_eq!(hidden_member_ids(price, &["5.5".to_string()]), vec![five_five]);
        assert_eq!(hidden_member_ids(price, &["5.50".to_string()]), vec![five_five]);
        assert_eq!(hidden_member_ids(price, &["10".to_string()]), vec![ten]);
        // The blank member under either spelling: the record blank AND the
        // empty-text item (ruling Q8).
        let blank = hidden_member_ids(region, &["".to_string()]);
        assert_eq!(blank, vec![VALUE_ID_EMPTY, empty_text]);
        let blank_label = hidden_member_ids(region, &["(Blank)".to_string()]);
        assert_eq!(blank_label, vec![VALUE_ID_EMPTY, empty_text]);
        // An item that names nothing resolves to nothing.
        assert!(hidden_member_ids(region, &["Nowhere".to_string()]).is_empty());
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
        // An intersection with no data is an EMPTY cell (Excel [LIVE, piv4
        // probe6]), which `body` does not list; it read 0 (pinned here as 0
        // until wave 4).
        assert_eq!(
            body(&view),
            owned(&[
                ("(blank)", &[30.0, 5.0, 35.0]),
                ("East", &[10.0, 10.0]),
                ("West", &[20.0, 20.0]),
                ("Grand Total", &[40.0, 25.0, 65.0]),
            ]),
        );

        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(0, "Region")], &[(2, "Year")], &[(0, &["East"])]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[("(blank)", &[30.0, 5.0, 35.0]), ("West", &[20.0, 20.0]), ("Grand Total", &[30.0, 25.0, 55.0])]),
            "with East hidden",
        );
    }

    #[test]
    fn a_blank_member_on_columns_reads_its_own_column_and_the_row_totals_count_it_once() {
        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(2, "Year")], &[(0, "Region")], &[]), &mut cache);
        // Columns: (blank), East, West, Grand Total. An intersection with no
        // data is EMPTY (Excel [LIVE, piv4 probe6]) and not listed; it read 0.
        assert_eq!(
            body(&view),
            owned(&[
                ("Y1", &[30.0, 10.0, 40.0]),
                ("Y2", &[5.0, 20.0, 25.0]),
                ("Grand Total", &[35.0, 10.0, 20.0, 65.0]),
            ]),
        );

        let mut cache = east_blank_west();
        let view = calculate_pivot(&sum_def(&[(2, "Year")], &[(0, "Region")], &[(0, &["West"])]), &mut cache);
        assert_eq!(
            body(&view),
            owned(&[("Y1", &[30.0, 10.0, 40.0]), ("Y2", &[5.0, 5.0]), ("Grand Total", &[35.0, 10.0, 45.0])]),
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
            // An item shown with no data has an EMPTY value cell (Excel
            // [LIVE, piv4 probe6 P_NODATA]); it read 0 until wave 4.
            owned(&[("West", &[16.0]), ("  (blank)", &[]), ("  Apples", &[]), ("  Pears", &[16.0])]),
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

        // The base item's own cell is EMPTY (read here as NaN), as Excel
        // shows it [LIVE, piv5 p3 A_DIFF_EAST]; it read 0 until piv5.
        let from_blank = shown_along_region(ShowValuesAs::Difference, Some("(blank)"));
        assert!(from_blank[0].1.is_nan(), "{from_blank:?}");
        assert_eq!(
            from_blank[1..].to_vec(),
            vec![("East".to_string(), 10.0 - 35.0), ("West".to_string(), 20.0 - 35.0)],
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
                // A total of the base field is EMPTY under Running Total In
                // [LIVE, piv5 p3 A_RUN]; it showed the running total of all.
                ("Grand Total", &[]),
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
        // Columns: West, East, (blank), Grand Total -- the Grand Total
        // column, a total of the base field, is EMPTY [LIVE, piv5 p3
        // B_RUN_YEAR's Grand Total row]; it repeated the last running total.
        assert_eq!(
            body(&view),
            owned(&[
                ("Y1", &[0.0, 10.0, 40.0]),
                ("Y2", &[20.0, 20.0, 25.0]),
                ("Grand Total", &[20.0, 30.0, 65.0]),
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

/// P2 S2 (app locale everywhere): every header and filter-item cell that
/// shows ONE member of an axis field carries that member's
/// `engine::MemberSource`, so the host writes its LABEL for the app locale at
/// response time while the cell's `value` keeps the invariant KEY text. The
/// keys themselves are byte-identical to before (`FieldCache::member_key` is
/// the moved body of the engine's old private label function), except the
/// blank member's KEY, which is "" by ruling Q8 while its header still reads
/// "(blank)".
#[cfg(test)]
mod member_source_tests {
    use super::*;
    use crate::cache::{FieldCache, MemberKind, BLANK_ITEM_LABEL, BLANK_MEMBER_KEY};
    use crate::definition::{AggregationType, FilterCondition, PivotField, PivotFilter, PivotId, ValueField};
    use crate::view::{PivotCellValue, PivotViewCell};
    use engine::{CellError, CellValue, LocaleSettings};

    fn pid() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9])
    }

    /// The engine's member label spelling BEFORE the key function moved,
    /// copied verbatim from the old private `PivotEngine::get_value_label` --
    /// the reference every key and header text is pinned against.
    fn legacy_label(fc: &FieldCache, value_id: ValueId) -> String {
        if value_id == VALUE_ID_EMPTY || value_id == VALUE_ID_BLANK {
            return "(blank)".to_string();
        }
        if let Some(label) = fc.label_map.get(&value_id) {
            return label.clone();
        }
        match fc.get_value(value_id) {
            Some(CacheValue::Empty) => "(blank)".to_string(),
            Some(CacheValue::Number(n)) => format!("{}", n.as_f64()),
            Some(CacheValue::Text(s)) => s.clone(),
            Some(CacheValue::Boolean(b)) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Some(CacheValue::Error(e)) => format!("#{}", e),
            None => "(unknown)".to_string(),
        }
    }

    /// A one-field-on-rows pivot (field 0) summing field 1.
    fn rows_pivot(field: PivotField) -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![field];
        def.value_fields = vec![ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum)];
        def
    }

    /// A two-field cache: field 0 holds `values`, field 1 an amount of 1.
    fn cache_of(values: &[CellValue]) -> PivotCache {
        let mut cache = PivotCache::new(pid(), 2);
        cache.set_field_name(0, "Key".to_string());
        cache.set_field_name(1, "Amount".to_string());
        for (i, v) in values.iter().enumerate() {
            cache.add_record(i as u32, &[v.clone(), CellValue::Number(1.0)]);
        }
        cache
    }

    fn date(y: i32, m: i32, d: i32) -> CellValue {
        CellValue::Number(engine::date_serial::date_to_serial(y, m, d))
    }

    fn text_of(cell: &PivotViewCell) -> String {
        match &cell.value {
            PivotCellValue::Text(s) => s.clone(),
            other => format!("{other:?}"),
        }
    }

    /// Every RowHeader cell that names a member, as (value text, source).
    fn member_headers(view: &PivotView) -> Vec<(String, MemberSource)> {
        view.cells
            .iter()
            .flatten()
            .filter(|c| c.cell_type == PivotCellType::RowHeader)
            .filter_map(|c| c.member_source.clone().map(|s| (text_of(c), s)))
            .collect()
    }

    #[test]
    fn a_month_grouped_pivots_headers_carry_month_sources_and_keep_their_keys() {
        let values: Vec<CellValue> = (1..=12).map(|m| date(2024, m, 15)).collect();
        let mut cache = cache_of(&values);
        let mut field = PivotField::new(0, "Date".to_string());
        field.grouping = FieldGrouping::DateGrouping { levels: vec![DateGroupLevel::Month] };
        let view = calculate_pivot(&rows_pivot(field), &mut cache);
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        let expected: Vec<(String, MemberSource)> = months
            .iter()
            .enumerate()
            .map(|(i, m)| (m.to_string(), MemberSource::Month { month: i as u32 + 1 }))
            .collect();
        assert_eq!(member_headers(&view), expected);
        // The formatted value is still the invariant key.
        for cell in view.cells.iter().flatten().filter(|c| c.member_source.is_some()) {
            assert_eq!(cell.formatted_value, text_of(cell), "formatted_value drifted from the key");
        }
        // The grand total names no member.
        let gt = view.cells.iter().flatten().find(|c| c.formatted_value == "Grand Total").expect("a grand total");
        assert_eq!(gt.member_source, None, "the grand total header carries a member source");
    }

    #[test]
    fn a_quarter_grouped_pivots_headers_carry_quarter_sources() {
        let values = vec![date(2024, 2, 1), date(2024, 5, 1), date(2024, 8, 1), date(2024, 11, 1)];
        let mut cache = cache_of(&values);
        let mut field = PivotField::new(0, "Date".to_string());
        field.grouping = FieldGrouping::DateGrouping { levels: vec![DateGroupLevel::Quarter] };
        let view = calculate_pivot(&rows_pivot(field), &mut cache);
        let expected: Vec<(String, MemberSource)> =
            (1..=4u32).map(|q| (format!("Q{q}"), MemberSource::Quarter { quarter: q })).collect();
        assert_eq!(member_headers(&view), expected);
    }

    #[test]
    fn year_week_and_day_headers_carry_number_text_and_number_sources() {
        let values = vec![date(2013, 1, 3), date(2014, 1, 3)];
        let mut cache = cache_of(&values);
        let mut field = PivotField::new(0, "Date".to_string());
        field.grouping = FieldGrouping::DateGrouping {
            levels: vec![DateGroupLevel::Year, DateGroupLevel::Week, DateGroupLevel::Day],
        };
        let view = calculate_pivot(&rows_pivot(field), &mut cache);
        let headers = member_headers(&view);
        assert!(
            headers.contains(&("2013".to_string(), MemberSource::Number { value: 2013.0 })),
            "a Year header lost its Number source: {headers:?}"
        );
        assert!(
            headers.contains(&("W01".to_string(), MemberSource::Text)),
            "a Week header is not Text with key W01: {headers:?}"
        );
        assert!(
            headers.contains(&("3".to_string(), MemberSource::Number { value: 3.0 })),
            "a Day header lost its Number source: {headers:?}"
        );
    }

    #[test]
    fn a_numeric_row_fields_header_carries_a_number_source() {
        let mut cache = cache_of(&[CellValue::Number(2013.0), CellValue::Number(1234.5)]);
        let view = calculate_pivot(&rows_pivot(PivotField::new(0, "Year".to_string())), &mut cache);
        assert_eq!(
            member_headers(&view),
            vec![
                ("1234.5".to_string(), MemberSource::Number { value: 1234.5 }),
                ("2013".to_string(), MemberSource::Number { value: 2013.0 }),
            ]
        );
    }

    #[test]
    fn bin_fields_carry_bin_number_and_overflow_sources() {
        // Multi-width integer bins [0,10) [10,20), plus both overflow bins.
        let values = vec![
            CellValue::Number(-3.0),
            CellValue::Number(5.0),
            CellValue::Number(15.0),
            CellValue::Number(25.0),
        ];
        let mut cache = cache_of(&values);
        let mut field = PivotField::new(0, "Score".to_string());
        field.grouping = FieldGrouping::NumberBinning { start: 0.0, end: 20.0, interval: 10.0 };
        let view = calculate_pivot(&rows_pivot(field), &mut cache);
        let headers = member_headers(&view);
        for want in [
            ("<0".to_string(), MemberSource::BinBelow { start: 0.0 }),
            ("0-9".to_string(), MemberSource::NumberBin { start: 0.0, end: 10.0, integer: true }),
            ("10-19".to_string(), MemberSource::NumberBin { start: 10.0, end: 20.0, integer: true }),
            (">20".to_string(), MemberSource::BinAbove { end: 20.0 }),
        ] {
            assert!(headers.contains(&want), "missing {want:?} in {headers:?}");
        }

        // Single-width integer bins are ONE number each.
        let mut cache = cache_of(&[CellValue::Number(0.0), CellValue::Number(1.0), CellValue::Number(2.0)]);
        let mut field = PivotField::new(0, "Score".to_string());
        field.grouping = FieldGrouping::NumberBinning { start: 0.0, end: 3.0, interval: 1.0 };
        let view = calculate_pivot(&rows_pivot(field), &mut cache);
        assert_eq!(
            member_headers(&view),
            vec![
                ("0".to_string(), MemberSource::Number { value: 0.0 }),
                ("1".to_string(), MemberSource::Number { value: 1.0 }),
                ("2".to_string(), MemberSource::Number { value: 2.0 }),
            ]
        );

        // Fractional bins keep their two-decimal key and a non-integer source.
        let mut cache = cache_of(&[CellValue::Number(0.25), CellValue::Number(0.75)]);
        let mut field = PivotField::new(0, "Score".to_string());
        field.grouping = FieldGrouping::NumberBinning { start: 0.0, end: 1.0, interval: 0.5 };
        let view = calculate_pivot(&rows_pivot(field), &mut cache);
        let headers = member_headers(&view);
        let first = (
            "0.00-0.50".to_string(),
            MemberSource::NumberBin { start: 0.0, end: 0.5, integer: false },
        );
        assert!(headers.contains(&first), "fractional bin: {headers:?}");
        // The label written from it follows the locale; the key does not.
        let de = LocaleSettings::from_locale_id("de-DE");
        assert_eq!(engine::member_label(&first.0, &first.1, &de), "0,00-0,50");
    }

    /// `member_key` equals the old label function for every value of a
    /// fixture holding every kind of value -- except the blank, whose KEY is
    /// "" (ruling Q8) while the header still reads "(blank)".
    #[test]
    fn member_key_equals_the_pre_change_label_for_every_value() {
        let values = vec![
            CellValue::Text("East".to_string()),
            CellValue::Number(1234.5),
            CellValue::Number(-0.000123),
            CellValue::Number(1e21),
            CellValue::Boolean(true),
            CellValue::Boolean(false),
            CellValue::Error(CellError::NA),
            CellValue::Text(String::new()),
            CellValue::Empty,
        ];
        let mut cache = cache_of(&values);
        let mut fc = cache.get_field(0).expect("field 0").clone();
        // A host-written label_map entry, as grouping keys are.
        let east = fc.find_id(&CacheValue::Text("East".to_string())).expect("East interned");
        fc.label_map.insert(east, "EAST-GROUP".to_string());
        for id in 0..fc.unique_count() as ValueId {
            assert_eq!(fc.member_key(id), legacy_label(&fc, id), "key of id {id} drifted");
        }
        assert_eq!(fc.member_key(VALUE_ID_EMPTY), BLANK_MEMBER_KEY);
        assert_eq!(fc.member_key(VALUE_ID_BLANK), BLANK_MEMBER_KEY);
        assert_eq!(fc.member_source(VALUE_ID_BLANK), MemberSource::Blank);
        assert_eq!(fc.member_source(east), MemberSource::Text, "a host label_map entry is shown as written");

        // The view's header TEXT is byte-identical to the old label for
        // every member, the blank included ("(blank)").
        let view = calculate_pivot(&rows_pivot(PivotField::new(0, "Key".to_string())), &mut cache);
        let fc = cache.get_field(0).expect("field 0");
        let mut seen_blank = false;
        for cell in view.cells.iter().flatten().filter(|c| c.member_source.is_some()) {
            let &(field, id) = cell.group_path.last().expect("a member header names its item");
            assert_eq!(field, 0);
            assert_eq!(text_of(cell), legacy_label(fc, id), "header text of id {id} drifted");
            assert_eq!(cell.formatted_value, legacy_label(fc, id));
            if text_of(cell) == BLANK_ITEM_LABEL {
                seen_blank = true;
                assert_eq!(cell.member_source, Some(MemberSource::Blank));
                assert_eq!(fc.member_key(id), BLANK_MEMBER_KEY, "the blank's KEY is not \"\" (Q8)");
            }
        }
        assert!(seen_blank, "the fixture shows no (blank) header");
        let sources: Vec<MemberSource> =
            view.cells.iter().flatten().filter_map(|c| c.member_source.clone()).collect();
        assert!(sources.contains(&MemberSource::Boolean { value: true }), "{sources:?}");
        assert!(sources.contains(&MemberSource::Error), "{sources:?}");
        assert!(sources.contains(&MemberSource::Number { value: 1234.5 }), "{sources:?}");
    }

    #[test]
    fn iso_keys_read_as_dates_only_where_the_field_declares_them() {
        let mut fc = FieldCache::new(0, "When".to_string());
        let day = fc.intern(CacheValue::Text("2024-01-15".to_string()));
        let stamp = fc.intern(CacheValue::Text("2024-01-15 13:04:05".to_string()));
        let code = fc.intern(CacheValue::Text("2024-13-45".to_string()));
        assert_eq!(fc.member_source(day), MemberSource::Text, "a Plain field guessed a date from text");
        fc.member_kind = MemberKind::IsoDate;
        assert_eq!(fc.member_source(day), MemberSource::Date { serial: 45306.0 });
        assert!(matches!(fc.member_source(stamp), MemberSource::DateTime { .. }));
        assert_eq!(fc.member_source(code), MemberSource::Text, "an impossible date became a date");
        assert_eq!(fc.member_key(day), "2024-01-15", "the key changed with the kind");
    }

    #[test]
    fn subtotal_and_field_name_headers_carry_no_source() {
        let mut cache = PivotCache::new(pid(), 3);
        cache.set_field_name(0, "Region".to_string());
        cache.set_field_name(1, "Product".to_string());
        cache.set_field_name(2, "Amount".to_string());
        for (i, (r, p)) in [("East", "Apples"), ("East", "Pears"), ("West", "Apples")].iter().enumerate() {
            cache.add_record(
                i as u32,
                &[CellValue::Text(r.to_string()), CellValue::Text(p.to_string()), CellValue::Number(1.0)],
            );
        }
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Region".to_string()), PivotField::new(1, "Product".to_string())];
        def.value_fields = vec![ValueField::new(2, "Sum of Amount".to_string(), AggregationType::Sum)];
        def.layout.report_layout = ReportLayout::Tabular;
        let view = calculate_pivot(&def, &mut cache);
        let mut checked = 0;
        for cell in view.cells.iter().flatten() {
            let t = text_of(cell);
            if t.ends_with(" Total") || t == "Sum of Amount" || t == "Region" || t == "Product" {
                checked += 1;
                assert_eq!(cell.member_source, None, "{t:?} carries a member source");
            }
        }
        assert!(checked >= 3, "the fixture shows no subtotal / field-name headers ({checked})");
        let east: Vec<&PivotViewCell> = view
            .cells
            .iter()
            .flatten()
            .filter(|c| text_of(c) == "East" && c.cell_type == PivotCellType::RowHeader)
            .collect();
        assert!(!east.is_empty());
        assert!(east.iter().all(|c| c.member_source == Some(MemberSource::Text)), "{east:?}");
    }

    #[test]
    fn column_headers_carry_sources_at_every_level() {
        let mut cache = PivotCache::new(pid(), 3);
        cache.set_field_name(0, "Region".to_string());
        cache.set_field_name(1, "Year".to_string());
        cache.set_field_name(2, "Amount".to_string());
        for (i, (r, y)) in [("East", 2013.0), ("East", 2014.0), ("West", 2013.0)].iter().enumerate() {
            cache.add_record(i as u32, &[CellValue::Text(r.to_string()), CellValue::Number(*y), CellValue::Number(1.0)]);
        }
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.column_fields = vec![PivotField::new(0, "Region".to_string()), PivotField::new(1, "Year".to_string())];
        def.value_fields = vec![ValueField::new(2, "Sum of Amount".to_string(), AggregationType::Sum)];
        let view = calculate_pivot(&def, &mut cache);
        let col_headers: Vec<(String, Option<MemberSource>)> = view
            .cells
            .iter()
            .flatten()
            .filter(|c| c.cell_type == PivotCellType::ColumnHeader && !text_of(c).is_empty())
            .map(|c| (text_of(c), c.member_source.clone()))
            .collect();
        assert!(col_headers.contains(&("East".to_string(), Some(MemberSource::Text))), "{col_headers:?}");
        assert!(col_headers.contains(&("2014".to_string(), Some(MemberSource::Number { value: 2014.0 }))), "{col_headers:?}");
        for (t, s) in &col_headers {
            if t.ends_with(" Total") || t == "Grand Total" {
                assert_eq!(*s, None, "{t:?} carries a member source");
            }
        }
    }

    #[test]
    fn filter_rows_carry_one_source_per_item_and_a_single_selection_names_it() {
        let mut cache = cache_of(&[CellValue::Number(10.0), CellValue::Number(20.0), CellValue::Text("x".to_string())]);
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        let mut filter = PivotField::new(0, "Key".to_string());
        filter.hidden_items = vec!["20".to_string(), "x".to_string()];
        def.filter_fields = vec![PivotFilter { field: filter, condition: FilterCondition::ValueList(Vec::new()) }];
        def.value_fields = vec![ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum)];
        let view = calculate_pivot(&def, &mut cache);
        let info = &view.filter_rows[0];
        assert_eq!(info.unique_values.len(), 3);
        assert_eq!(info.unique_values.len(), info.member_sources.len(), "sources are not parallel to the items");
        let fc = cache.get_field(0).expect("field 0");
        for (key, source) in info.unique_values.iter().zip(&info.member_sources) {
            let value = match key.parse::<f64>() {
                Ok(n) => CacheValue::Number(OrderedFloat(n)),
                Err(_) => CacheValue::Text(key.clone()),
            };
            let id = fc.find_id(&value).expect("a listed key is interned");
            assert_eq!(*source, fc.member_source(id), "item {key}");
        }
        let dropdown = view
            .cells
            .iter()
            .flatten()
            .find(|c| c.cell_type == PivotCellType::FilterDropdown)
            .expect("a filter dropdown");
        assert_eq!(dropdown.formatted_value, "10");
        assert_eq!(dropdown.member_source, Some(MemberSource::Number { value: 10.0 }));

        // "(All)" names no member.
        let mut cache = cache_of(&[CellValue::Number(10.0), CellValue::Number(20.0)]);
        let mut def2 = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def2.filter_fields = vec![PivotFilter {
            field: PivotField::new(0, "Key".to_string()),
            condition: FilterCondition::ValueList(Vec::new()),
        }];
        def2.value_fields = vec![ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum)];
        let view = calculate_pivot(&def2, &mut cache);
        let dropdown = view
            .cells
            .iter()
            .flatten()
            .find(|c| c.cell_type == PivotCellType::FilterDropdown)
            .expect("a filter dropdown");
        assert_eq!(dropdown.formatted_value, "(All)");
        assert_eq!(dropdown.member_source, None);
    }

    #[test]
    fn the_unique_member_siblings_keep_their_own_keys_and_add_sources() {
        let cache = cache_of(&[CellValue::Number(2013.0), CellValue::Text("a".to_string()), CellValue::Empty]);
        let plain = cache.get_unique_values_for_filter(0);
        let members = cache.get_unique_members_for_filter(0);
        assert_eq!(plain.len(), members.len());
        for ((id, key), (mid, mkey, _)) in plain.iter().zip(&members) {
            assert_eq!((id, key), (mid, mkey), "the sibling changed a key spelling");
        }
        assert!(members.iter().any(|(_, k, s)| k == "2013" && *s == MemberSource::Number { value: 2013.0 }));
        let in_data = cache.get_unique_members_for_filter_in_data(0);
        assert!(
            in_data.iter().any(|(id, key, s)| *id == VALUE_ID_EMPTY && key == "(blank)" && *s == MemberSource::Blank),
            "{in_data:?}"
        );
        assert_eq!(cache.get_value_label(0, VALUE_ID_EMPTY).as_deref(), Some(""), "the raw label of the blank changed");
        assert_eq!(cache.get_value_member_source(0, VALUE_ID_EMPTY), Some(MemberSource::Blank));
        assert_eq!(cache.get_value_member_source(99, 0), None);
    }

    /// The new fields are serde-default: an undo snapshot written before
    /// them still loads.
    #[test]
    fn snapshots_without_the_new_fields_deserialise() {
        let mut fc = FieldCache::new(0, "Key".to_string());
        fc.intern(CacheValue::Number(OrderedFloat(1.0)));
        let mut json = serde_json::to_value(&fc).expect("serialise");
        let obj = json.as_object_mut().expect("an object");
        assert!(obj.remove("member_kind").is_some(), "the field is not serialised as member_kind");
        assert!(obj.remove("label_source_map").is_some());
        let back: FieldCache = serde_json::from_value(json).expect("an old FieldCache snapshot no longer loads");
        assert_eq!(back.member_kind, MemberKind::Plain);
        assert!(back.label_source_map.is_empty());

        let cell = PivotViewCell::row_header("x".to_string(), 0);
        let json = serde_json::to_value(&cell).expect("serialise");
        assert!(json.get("member_source").is_none(), "a None source is written to the wire");
        let _: PivotViewCell = serde_json::from_value(json).expect("a cell without member_source loads");

        // A source round-trips with its camelCase kind tag.
        let cell = cell.with_member_source(Some(MemberSource::Month { month: 3 }));
        let json = serde_json::to_value(&cell).expect("serialise");
        assert_eq!(json["member_source"]["kind"], "month");
        let back: PivotViewCell = serde_json::from_value(json).expect("deserialise");
        assert_eq!(back.member_source, Some(MemberSource::Month { month: 3 }));

        // A filter row without member_sources loads as "no sources".
        let info = crate::view::FilterRowInfo {
            field_index: 0,
            field_name: "Key".to_string(),
            selected_values: vec![],
            unique_values: vec!["1".to_string()],
            member_sources: vec![MemberSource::Number { value: 1.0 }],
            display_value: "(All)".to_string(),
            view_row: 0,
        };
        let mut json = serde_json::to_value(&info).expect("serialise");
        json.as_object_mut().expect("an object").remove("member_sources");
        let back: crate::view::FilterRowInfo = serde_json::from_value(json).expect("an old filter row loads");
        assert!(back.member_sources.is_empty());
    }

    /// A BI Decimal field keys its members with the column's scale (MemberKind::Decimal),
    /// the spelling the model's value list hands out ("5.50"), and a hidden
    /// item names a member by that KEY as well as by its display ("5.5").
    /// A hidden BLANK ("" or "(blank)") hides the NULL records AND the
    /// empty-text items: ONE member under ruling Q8.
    #[test]
    fn decimal_keys_keep_their_scale_and_hidden_items_resolve_by_key_and_fold_the_blank() {
        let mut cache = cache_of(&[
            CellValue::Number(5.5),
            CellValue::Number(10.0),
            CellValue::Empty,
            CellValue::Text(String::new()),
        ]);
        cache.fields[0].member_kind = MemberKind::Decimal { scale: 2 };
        let fc = &cache.fields[0];
        let five = (0..fc.unique_count() as ValueId).find(|&id| matches!(fc.get_value(id), Some(CacheValue::Number(n)) if n.as_f64() == 5.5)).unwrap();
        assert_eq!(fc.member_key(five), "5.50");
        assert_eq!(fc.member_source(five), MemberSource::Number { value: 5.5 }, "the label is still a number");
        for name in ["5.50", "5.5"] {
            assert_eq!(PivotCalculator::resolve_hidden_ids(fc, &[name.to_string()]), vec![five], "{name}");
        }
        let empty_text = (0..fc.unique_count() as ValueId).find(|&id| matches!(fc.get_value(id), Some(CacheValue::Text(s)) if s.is_empty())).unwrap();
        for blank in [BLANK_MEMBER_KEY, BLANK_ITEM_LABEL, "(Blank)"] {
            let mut ids = PivotCalculator::resolve_hidden_ids(fc, &[blank.to_string()]);
            ids.sort();
            let mut want = vec![VALUE_ID_EMPTY, empty_text];
            want.sort();
            assert_eq!(ids, want, "{blank:?} hides the NULLs and the empty text");
        }
    }
}

/// Sort by value (BUG-0459), pinned against live Excel 16 over the probe
/// table below (`PivotField.AutoSort(order, "Sum of Amount", PivotLine)`).
#[cfg(test)]
mod value_sort_tests {
    use super::*;
    use engine::CellValue;
    use crate::definition::{AggregationType, PivotField, PivotId, SortOrder, ValueField, ValueSort};
    use crate::view::PivotRowType;

    fn pid() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9])
    }

    /// Fields: 0 Region, 1 Product, 2 Year, 3 Amount -- the [LIVE] probe's
    /// table. East: A 10/50, B 30/5, C 20/20 (2023/2024). West: A 5, B 40,
    /// D 30, E 30 (2023) and C 70 (2024 only).
    fn probe_cache() -> PivotCache {
        let rows: &[(&str, &str, &str, f64)] = &[
            ("East", "A", "2023", 10.0),
            ("East", "A", "2024", 50.0),
            ("East", "B", "2023", 30.0),
            ("East", "B", "2024", 5.0),
            ("East", "C", "2023", 20.0),
            ("East", "C", "2024", 20.0),
            ("West", "A", "2023", 5.0),
            ("West", "B", "2023", 40.0),
            ("West", "C", "2024", 70.0),
            ("West", "D", "2023", 30.0),
            ("West", "E", "2023", 30.0),
        ];
        let mut cache = PivotCache::new(pid(), 4);
        for (i, name) in ["Region", "Product", "Year", "Amount"].iter().enumerate() {
            cache.set_field_name(i, name.to_string());
        }
        for (i, (region, product, year, amount)) in rows.iter().enumerate() {
            cache.add_record(
                i as u32,
                &[
                    CellValue::Text(region.to_string()),
                    CellValue::Text(product.to_string()),
                    CellValue::Text(year.to_string()),
                    CellValue::Number(*amount),
                ],
            );
        }
        cache
    }

    /// Region > Product on rows, Year on columns, Sum of Amount.
    fn probe_def() -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Region".into()), PivotField::new(1, "Product".into())];
        def.column_fields = vec![PivotField::new(2, "Year".into())];
        def.value_fields = vec![ValueField::new(3, "Sum of Amount".into(), AggregationType::Sum)];
        def
    }

    fn by_value(scope: &[&str]) -> Option<ValueSort> {
        Some(ValueSort {
            value_field: "Sum of Amount".into(),
            scope: scope.iter().map(|s| s.to_string()).collect(),
        })
    }

    fn sort_product(def: &mut PivotDefinition, order: SortOrder, scope: &[&str]) {
        def.row_fields[1].sort_order = order;
        def.row_fields[1].value_sort = by_value(scope);
    }

    /// The row labels in view order (Data and Subtotal rows), "|"-joined.
    fn row_labels(def: &PivotDefinition) -> String {
        let mut cache = probe_cache();
        let view = calculate_pivot(def, &mut cache);
        view.rows
            .iter()
            .zip(view.cells.iter())
            .filter(|(d, _)| matches!(d.row_type, PivotRowType::Data | PivotRowType::Subtotal))
            .map(|(_, cells)| cells[0].formatted_value.clone())
            .collect::<Vec<_>>()
            .join("|")
    }

    #[test]
    fn label_order_is_unchanged_without_a_value_sort() {
        assert_eq!(row_labels(&probe_def()), "East|A|B|C|West|A|B|C|D|E");
    }

    #[test]
    fn descending_by_the_grand_total_sorts_each_regions_products() {
        // [LIVE] P1 / G1: East A 60, C 40, B 35; West C 70, B 40, D 30, E 30, A 5.
        let mut def = probe_def();
        sort_product(&mut def, SortOrder::Descending, &[]);
        assert_eq!(row_labels(&def), "East|A|C|B|West|C|B|D|E|A");
    }

    #[test]
    fn ascending_by_the_grand_total_reverses_ties() {
        // [LIVE] G2: West A 5, E 30, D 30, B 40, C 70 (the exact reverse of G1).
        let mut def = probe_def();
        sort_product(&mut def, SortOrder::Ascending, &[]);
        assert_eq!(row_labels(&def), "East|B|C|A|West|A|E|D|B|C");
    }

    #[test]
    fn descending_along_a_column_line_puts_no_data_last() {
        // [LIVE] L1, the 2023 column: West B 40, E 30, D 30, A 5, C (no 2023 data).
        let mut def = probe_def();
        sort_product(&mut def, SortOrder::Descending, &["2023"]);
        assert_eq!(row_labels(&def), "East|B|C|A|West|B|E|D|A|C");
    }

    #[test]
    fn ascending_along_a_column_line_puts_no_data_first() {
        // [LIVE] L2: West C (no data), A 5, D 30, E 30, B 40.
        let mut def = probe_def();
        sort_product(&mut def, SortOrder::Ascending, &["2023"]);
        assert_eq!(row_labels(&def), "East|A|C|B|West|C|A|D|E|B");
    }

    #[test]
    fn an_outer_field_sorts_by_its_subtotals() {
        // Region descending by the grand total -- West 145, East 135 -- and
        // [LIVE] L3, ascending along 2023 -- East 60, West 105.
        let mut def = probe_def();
        def.row_fields[0].sort_order = SortOrder::Descending;
        def.row_fields[0].value_sort = by_value(&[]);
        assert_eq!(row_labels(&def), "West|A|B|C|D|E|East|A|B|C");
        def.row_fields[0].sort_order = SortOrder::Ascending;
        def.row_fields[0].value_sort = by_value(&["2023"]);
        assert_eq!(row_labels(&def), "East|A|B|C|West|A|B|C|D|E");
    }

    #[test]
    fn a_column_field_sorts_by_a_rows_values() {
        // [LIVE] P7: Year descending along East's row -- 2024 (75), 2023 (60).
        let mut def = probe_def();
        def.column_fields[0].sort_order = SortOrder::Descending;
        def.column_fields[0].value_sort = by_value(&["East"]);
        let mut cache = probe_cache();
        let view = calculate_pivot(&def, &mut cache);
        let years: Vec<String> = view
            .cells
            .iter()
            .flat_map(|row| row.iter())
            .map(|c| c.formatted_value.clone())
            .filter(|s| s == "2023" || s == "2024")
            .collect();
        assert_eq!(years, vec!["2024".to_string(), "2023".to_string()]);
        // Ascending along the same row: 2023 (60), 2024 (75).
        def.column_fields[0].sort_order = SortOrder::Ascending;
        let mut cache = probe_cache();
        let view = calculate_pivot(&def, &mut cache);
        let years: Vec<String> = view
            .cells
            .iter()
            .flat_map(|row| row.iter())
            .map(|c| c.formatted_value.clone())
            .filter(|s| s == "2023" || s == "2024")
            .collect();
        assert_eq!(years, vec!["2023".to_string(), "2024".to_string()]);
    }

    #[test]
    fn an_unknown_value_field_or_manual_order_leaves_the_label_sort() {
        let mut def = probe_def();
        sort_product(&mut def, SortOrder::Descending, &[]);
        def.row_fields[1].value_sort.as_mut().unwrap().value_field = "No Such Field".into();
        // The field's own label direction stands.
        assert_eq!(row_labels(&def), "East|C|B|A|West|E|D|C|B|A");
        let mut def = probe_def();
        sort_product(&mut def, SortOrder::DataSourceOrder, &[]);
        assert_eq!(row_labels(&def), "East|A|B|C|West|A|B|C|D|E");
    }

    #[test]
    fn a_value_sort_round_trips_and_an_absent_one_reads_none() {
        let mut def = probe_def();
        sort_product(&mut def, SortOrder::Descending, &["2023"]);
        let json = serde_json::to_string(&def.row_fields[1]).unwrap();
        let back: PivotField = serde_json::from_str(&json).unwrap();
        assert_eq!(back.value_sort, def.row_fields[1].value_sort);
        let plain = serde_json::to_string(&def.row_fields[0]).unwrap();
        assert!(!plain.contains("value_sort"), "an absent value sort is not written: {plain}");
        let read: PivotField = serde_json::from_str(&plain).unwrap();
        assert_eq!(read.value_sort, None);
    }
}

/// BUG-0760 follow-up: what a pivot's summaries show over a source holding
/// errors and text, against Excel [LIVE, piv4 probe4 / probe5].
#[cfg(test)]
mod source_error_tests {
    use super::*;
    use engine::{CellError, CellValue};
    use crate::definition::{AggregationType, CalculatedField, PivotField, PivotId, SortOrder, ValueField, ValueSort};
    use crate::view::{PivotCellValue, PivotRowType};

    fn pid() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7])
    }

    fn cache_of(names: &[&str], rows: &[Vec<CellValue>]) -> PivotCache {
        let mut cache = PivotCache::new(pid(), names.len());
        for (i, name) in names.iter().enumerate() {
            cache.set_field_name(i, name.to_string());
        }
        for (i, row) in rows.iter().enumerate() {
            cache.add_record(i as u32, row);
        }
        cache
    }

    fn t(s: &str) -> CellValue {
        CellValue::Text(s.to_string())
    }

    fn n(v: f64) -> CellValue {
        CellValue::Number(v)
    }

    fn e(err: CellError) -> CellValue {
        CellValue::Error(err)
    }

    /// probe4's table: Region, Amount, Name.
    fn probe4_cache() -> PivotCache {
        cache_of(
            &["Region", "Amount", "Name"],
            &[
                vec![t("East"), n(10.0), t("x")],
                vec![t("West"), e(CellError::Div0), e(CellError::Div0)],
                vec![t("West"), n(4.0), t("y")],
                vec![t("South"), e(CellError::NA), t("z")],
                vec![t("South"), e(CellError::Div0), t("w")],
                vec![t("East"), n(7.0), t("v")],
                vec![t("North"), t("text"), t("u")],
                vec![t("North"), n(3.0), t("t")],
            ],
        )
    }

    fn show(v: &PivotCellValue, formatted: &str) -> String {
        match v {
            PivotCellValue::Number(x) => {
                let r = (x * 10000.0).round() / 10000.0;
                format!("{r}")
            }
            PivotCellValue::Error(code) => format!("#{}", code.trim_start_matches('#')),
            PivotCellValue::Text(s) => s.clone(),
            PivotCellValue::Boolean(b) => b.to_string(),
            PivotCellValue::Empty => formatted.to_string(),
        }
    }

    /// The Data / Subtotal / GrandTotal rows as "label,v1,v2..." joined by " ; ".
    fn body(def: &PivotDefinition, cache: &mut PivotCache) -> String {
        let view = calculate_pivot(def, cache);
        view.rows
            .iter()
            .zip(view.cells.iter())
            .filter(|(d, _)| matches!(d.row_type, PivotRowType::Data | PivotRowType::Subtotal | PivotRowType::GrandTotal))
            .map(|(_, cells)| {
                cells.iter().map(|c| show(&c.value, &c.formatted_value)).collect::<Vec<_>>().join(",")
            })
            .collect::<Vec<_>>()
            .join(" ; ")
    }

    fn by_region(aggregation: AggregationType) -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Region".into())];
        def.value_fields = vec![
            ValueField::new(1, "Of Amount".into(), aggregation),
            ValueField::new(2, "Of Name".into(), aggregation),
        ];
        def
    }

    /// Excel [LIVE, piv4 probe4], every summary over Amount (numbers, a text,
    /// #DIV/0!, #N/A) and Name (text and one #DIV/0!). A source error is the
    /// result of every summary but Count and Count Numbers; Count counts text
    /// and errors; Average of no numbers and StdDev / Var of fewer than two
    /// are #DIV/0!; the grand total takes the first error of its items as
    /// shown (South #N/A before West #DIV/0!, though the West error comes
    /// first in the source).
    ///
    /// SABOTAGE (piv4-sabE): the value buffer drops every non-number again.
    #[test]
    fn every_summary_over_a_source_error_or_text_answers_as_excel_does() {
        let cases: &[(AggregationType, &str)] = &[
            (AggregationType::Sum, "East,17,0 ; North,3,0 ; South,#N/A,0 ; West,#DIV/0!,#DIV/0! ; Grand Total,#N/A,#DIV/0!"),
            (AggregationType::Count, "East,2,2 ; North,2,2 ; South,2,2 ; West,2,2 ; Grand Total,8,8"),
            (AggregationType::Average, "East,8.5,#DIV/0! ; North,3,#DIV/0! ; South,#N/A,#DIV/0! ; West,#DIV/0!,#DIV/0! ; Grand Total,#N/A,#DIV/0!"),
            (AggregationType::Max, "East,10,0 ; North,3,0 ; South,#N/A,0 ; West,#DIV/0!,#DIV/0! ; Grand Total,#N/A,#DIV/0!"),
            (AggregationType::Min, "East,7,0 ; North,3,0 ; South,#N/A,0 ; West,#DIV/0!,#DIV/0! ; Grand Total,#N/A,#DIV/0!"),
            (AggregationType::Product, "East,70,0 ; North,3,0 ; South,#N/A,0 ; West,#DIV/0!,#DIV/0! ; Grand Total,#N/A,#DIV/0!"),
            (AggregationType::CountNumbers, "East,2,0 ; North,1,0 ; South,0,0 ; West,1,0 ; Grand Total,4,0"),
            (AggregationType::StdDev, "East,2.1213,#DIV/0! ; North,#DIV/0!,#DIV/0! ; South,#N/A,#DIV/0! ; West,#DIV/0!,#DIV/0! ; Grand Total,#N/A,#DIV/0!"),
            (AggregationType::Var, "East,4.5,#DIV/0! ; North,#DIV/0!,#DIV/0! ; South,#N/A,#DIV/0! ; West,#DIV/0!,#DIV/0! ; Grand Total,#N/A,#DIV/0!"),
        ];
        for (aggregation, want) in cases {
            let mut cache = probe4_cache();
            let got = body(&by_region(*aggregation), &mut cache);
            assert_eq!(&got, want, "{aggregation:?}");
        }
    }

    /// probe5's table: which error a cell shows when it holds two.
    fn probe5_cache() -> PivotCache {
        cache_of(
            &["Region", "Amount"],
            &[
                vec![t("Mm"), e(CellError::Div0)],
                vec![t("Zz"), e(CellError::NA)],
                vec![t("Mm"), e(CellError::NA)],
                vec![t("Aa"), e(CellError::Num)],
                vec![t("Kk"), n(5.0)],
                vec![t("Pp"), e(CellError::NA)],
                vec![t("Pp"), e(CellError::Div0)],
            ],
        )
    }

    fn probe5_def(order: SortOrder) -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        let mut region = PivotField::new(0, "Region".into());
        region.sort_order = order;
        def.row_fields = vec![region];
        def.value_fields = vec![ValueField::new(1, "Sum of Amount".into(), AggregationType::Sum)];
        def.calculated_fields.push(CalculatedField {
            name: "Dbl".to_string(),
            formula: "Amount*2".to_string(),
            number_format: None,
        });
        def
    }

    /// Excel [LIVE, piv4 probe5]: an item's cell shows the FIRST error of its
    /// records in source order, a calculated field over it the LAST, and the
    /// grand total combines its items as they are SHOWN -- #NUM! / #N/A
    /// ascending, #N/A / #NUM! descending. Without row fields the grand total
    /// is the first error in source order.
    ///
    /// SABOTAGE (piv4-sabR): `rederive_row_total_errors` returns at once.
    #[test]
    fn a_cell_holding_two_errors_shows_the_one_excel_shows() {
        let mut cache = probe5_cache();
        assert_eq!(
            body(&probe5_def(SortOrder::Ascending), &mut cache),
            "Aa,#NUM!,#NUM! ; Kk,5,10 ; Mm,#DIV/0!,#N/A ; Pp,#N/A,#DIV/0! ; Zz,#N/A,#N/A ; Grand Total,#NUM!,#N/A"
        );
        let mut cache = probe5_cache();
        assert_eq!(
            body(&probe5_def(SortOrder::Descending), &mut cache),
            "Zz,#N/A,#N/A ; Pp,#N/A,#DIV/0! ; Mm,#DIV/0!,#N/A ; Kk,5,10 ; Aa,#NUM!,#NUM! ; Grand Total,#N/A,#NUM!"
        );
        let mut def = probe5_def(SortOrder::Ascending);
        def.row_fields.clear();
        def.calculated_fields.clear();
        let mut cache = probe5_cache();
        let view = calculate_pivot(&def, &mut cache);
        let values: Vec<String> = view
            .cells
            .iter()
            .flat_map(|r| r.iter())
            .filter(|c| c.value_field_index.is_some())
            .map(|c| show(&c.value, &c.formatted_value))
            .collect();
        assert_eq!(values, vec!["#DIV/0!".to_string()]);
    }

    /// Excel [LIVE, piv4 probe4]: sorted by value, an item showing an error
    /// goes LAST in both directions, the error items following the sort's
    /// own direction by label.
    ///
    /// SABOTAGE: `aggregate_or_blank` answers the number even for an error.
    #[test]
    fn a_value_sort_puts_error_items_last_in_both_directions() {
        let labels = |order: SortOrder| {
            let mut def = by_region(AggregationType::Sum);
            def.row_fields[0].sort_order = order;
            def.row_fields[0].value_sort = Some(ValueSort { value_field: "Of Amount".into(), scope: Vec::new() });
            let mut cache = probe4_cache();
            let view = calculate_pivot(&def, &mut cache);
            view.rows
                .iter()
                .zip(view.cells.iter())
                .filter(|(d, _)| matches!(d.row_type, PivotRowType::Data))
                .map(|(_, cells)| cells[0].formatted_value.clone())
                .collect::<Vec<_>>()
                .join("|")
        };
        assert_eq!(labels(SortOrder::Descending), "East|North|West|South");
        assert_eq!(labels(SortOrder::Ascending), "North|East|South|West");
    }

    /// An intersection no record reaches is an EMPTY cell, as Excel shows it
    /// (no "For empty cells show" text set), never a 0: West has no 2024.
    ///
    /// SABOTAGE (piv4-sabZ): the column branch drops its `no_records` test.
    #[test]
    fn an_intersection_no_record_reaches_is_an_empty_cell() {
        let mut cache = cache_of(
            &["Region", "Year", "Amount"],
            &[
                vec![t("East"), t("2023"), n(1.0)],
                vec![t("East"), t("2024"), n(2.0)],
                vec![t("West"), t("2023"), n(3.0)],
            ],
        );
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Region".into())];
        def.column_fields = vec![PivotField::new(1, "Year".into())];
        def.value_fields = vec![ValueField::new(2, "Sum of Amount".into(), AggregationType::Sum)];
        let view = calculate_pivot(&def, &mut cache);
        let west: Vec<String> = view
            .rows
            .iter()
            .zip(view.cells.iter())
            .find(|(d, cells)| matches!(d.row_type, PivotRowType::Data) && cells[0].formatted_value == "West")
            .map(|(_, cells)| {
                cells
                    .iter()
                    .filter(|c| c.value_field_index.is_some())
                    .map(|c| match &c.value {
                        PivotCellValue::Empty => "EMPTY".to_string(),
                        other => show(other, ""),
                    })
                    .collect()
            })
            .expect("the West row");
        assert_eq!(west, vec!["3".to_string(), "EMPTY".to_string(), "3".to_string()]);
    }

    /// % of Column Total with a column field: every cell of a row reads ITS
    /// row. The previous cell's Show Values As rewrote the shared row key, so
    /// the East 2024 cell read the grand-total row (145 / 145 = 100%).
    ///
    /// SABOTAGE (piv4-sabK): drop the per-cell `prepare_row_key` in the
    /// column branch.
    #[test]
    fn percent_of_column_total_reads_each_cells_own_row() {
        let mut cache = cache_of(
            &["Region", "Year", "Amount"],
            &[
                vec![t("East"), t("2023"), n(60.0)],
                vec![t("East"), t("2024"), n(75.0)],
                vec![t("West"), t("2023"), n(105.0)],
                vec![t("West"), t("2024"), n(70.0)],
            ],
        );
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Region".into())];
        def.column_fields = vec![PivotField::new(1, "Year".into())];
        let mut vf = ValueField::new(2, "Sum of Amount".into(), AggregationType::Sum);
        vf.show_values_as = ShowValuesAs::PercentOfColumnTotal;
        def.value_fields = vec![vf];
        let got = body(&def, &mut cache);
        assert_eq!(got, "East,0.3636,0.5172,0.4355 ; West,0.6364,0.4828,0.5645 ; Grand Total,1,1,1");
    }
}

/// Grouped fields keep their own sorts, and a field keeps a manual item order
/// (BUG-0733), against Excel [LIVE, verify-pivotfix probe3; piv4 probe5].
#[cfg(test)]
mod level_sort_tests {
    use super::*;
    use engine::CellValue;
    use crate::definition::{
        AggregationType, DateGroupLevel, FieldGrouping, ManualGroup, PivotField, PivotId, SortOrder, ValueField,
        ValueSort, MANUAL_GROUP_LEVEL,
    };
    use crate::view::PivotRowType;

    fn pid() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6])
    }

    fn cache_of(rows: &[(CellValue, f64)]) -> PivotCache {
        let mut cache = PivotCache::new(pid(), 2);
        cache.set_field_name(0, "Region".into());
        cache.set_field_name(1, "Amount".into());
        for (i, (label, amount)) in rows.iter().enumerate() {
            cache.add_record(i as u32, &[label.clone(), CellValue::Number(*amount)]);
        }
        cache
    }

    fn labels(def: &PivotDefinition, cache: &mut PivotCache) -> String {
        let view = calculate_pivot(def, cache);
        view.rows
            .iter()
            .zip(view.cells.iter())
            .filter(|(d, _)| matches!(d.row_type, PivotRowType::Data | PivotRowType::Subtotal))
            .map(|(_, cells)| cells.iter().map(|c| c.formatted_value.clone()).find(|s| !s.is_empty()).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("|")
    }

    fn regions() -> PivotCache {
        cache_of(&[
            (CellValue::Text("A".into()), 110.0),
            (CellValue::Text("B".into()), 100.0),
            (CellValue::Text("C".into()), 31.0),
            (CellValue::Text("D".into()), 10.0),
        ])
    }

    fn grouped_def() -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        let mut region = PivotField::new(0, "Region".into());
        region.grouping = FieldGrouping::ManualGrouping {
            groups: vec![
                ManualGroup { name: "Group1".into(), members: vec!["A".into(), "B".into()] },
                ManualGroup { name: "Group2".into(), members: vec!["C".into(), "D".into()] },
            ],
            ungrouped_name: "Other".into(),
        };
        def.row_fields = vec![region];
        def.value_fields = vec![ValueField::new(1, "Sum of Amount".into(), AggregationType::Sum)];
        def
    }

    /// Excel [LIVE, verify-pivotfix probe3 A_ORDERS]: sorting the group
    /// field by value leaves the field it was grouped from in its own
    /// (ascending label) order, and the other way round.
    ///
    /// SABOTAGE (piv4-sabG): the group field copies the detail field's sort
    /// again.
    #[test]
    fn a_manual_group_parent_and_its_detail_field_sort_apart() {
        let mut def = grouped_def();
        let level = def.row_fields[0].level_sort_mut(MANUAL_GROUP_LEVEL);
        level.sort_order = SortOrder::Ascending;
        level.value_sort = Some(ValueSort { value_field: "Sum of Amount".into(), scope: Vec::new() });
        assert_eq!(labels(&def, &mut regions()), "Group2|C|D|Group1|A|B");
        // The detail field sorted descending by label: the groups keep their
        // own (value) order.
        def.row_fields[0].sort_order = SortOrder::Descending;
        assert_eq!(labels(&def, &mut regions()), "Group2|D|C|Group1|B|A");
    }

    /// The level above the finest date level is a field of its own: Years
    /// sorted descending leaves the months ascending, and the field's own
    /// (finest-level) descending sort leaves the years ascending.
    ///
    /// SABOTAGE: the date levels copy the origin field's sort again.
    #[test]
    fn a_date_level_and_the_finest_level_sort_apart() {
        // 2023-01-15, 2023-03-15, 2024-01-15, 2024-03-15 as serials.
        let mut cache_rows = Vec::new();
        for serial in [44941.0, 45000.0, 45306.0, 45366.0] {
            cache_rows.push((CellValue::Number(serial), 1.0));
        }
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        let mut date = PivotField::new(0, "Date".into());
        date.grouping = FieldGrouping::DateGrouping { levels: vec![DateGroupLevel::Year, DateGroupLevel::Month] };
        def.row_fields = vec![date];
        def.value_fields = vec![ValueField::new(1, "Sum of Amount".into(), AggregationType::Sum)];
        let plain = labels(&def, &mut cache_of(&cache_rows));
        let parts: Vec<&str> = plain.split('|').collect();
        assert_eq!(parts.len(), 6, "{plain}");
        let (y1, m1, m2, y2) = (parts[0], parts[1], parts[2], parts[3]);
        def.row_fields[0].level_sort_mut(DateGroupLevel::Year.level_key()).sort_order = SortOrder::Descending;
        assert_eq!(labels(&def, &mut cache_of(&cache_rows)), [y2, m1, m2, y1, m1, m2].join("|"), "plain: {plain}");
        def.row_fields[0].level_sorts.clear();
        def.row_fields[0].sort_order = SortOrder::Descending;
        assert_eq!(labels(&def, &mut cache_of(&cache_rows)), [y1, m2, m1, y2, m2, m1].join("|"), "plain: {plain}");
    }

    /// Excel [LIVE, piv4 probe5]: a manual order shows its items in the
    /// stored order, and an item it does not name (a refresh brought it)
    /// follows in source order.
    ///
    /// SABOTAGE (piv4-sabM): the manual list is never folded into the order.
    #[test]
    fn a_manual_item_order_is_kept_and_new_items_follow_it() {
        let mut cache = cache_of(&[
            (CellValue::Text("East".into()), 1.0),
            (CellValue::Text("West".into()), 2.0),
            (CellValue::Text("North".into()), 3.0),
            (CellValue::Text("South".into()), 4.0),
        ]);
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        let mut region = PivotField::new(0, "Region".into());
        region.sort_order = SortOrder::Manual;
        region.manual_item_order = vec!["West".into(), "South".into()];
        def.row_fields = vec![region];
        def.value_fields = vec![ValueField::new(1, "Sum of Amount".into(), AggregationType::Sum)];
        assert_eq!(labels(&def, &mut cache), "West|South|East|North");
        // Any other order ignores the list.
        def.row_fields[0].sort_order = SortOrder::Ascending;
        let mut cache2 = cache_of(&[
            (CellValue::Text("East".into()), 1.0),
            (CellValue::Text("West".into()), 2.0),
        ]);
        assert_eq!(labels(&def, &mut cache2), "East|West");
        // Round trip: both new fields survive serde, and absent ones read empty.
        let json = serde_json::to_string(&def.row_fields[0]).unwrap();
        let back: PivotField = serde_json::from_str(&json).unwrap();
        assert_eq!(back.manual_item_order, def.row_fields[0].manual_item_order);
        let plain = serde_json::to_string(&PivotField::new(0, "R".into())).unwrap();
        assert!(!plain.contains("manual_item_order") && !plain.contains("level_sorts"), "{plain}");
    }
}

#[cfg(test)]
mod show_values_as_error_tests {
    use super::*;
    use engine::{CellError, CellValue};
    use crate::definition::{AggregationType, PivotField, PivotId, ShowValuesAs, ValueField};
    use crate::view::{PivotCellValue, PivotRowType};

    fn pid() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9])
    }

    fn cache_of(names: &[&str], rows: &[Vec<CellValue>]) -> PivotCache {
        let mut cache = PivotCache::new(pid(), names.len());
        for (i, name) in names.iter().enumerate() {
            cache.set_field_name(i, name.to_string());
        }
        for (i, row) in rows.iter().enumerate() {
            cache.add_record(i as u32, row);
        }
        cache
    }

    fn t(s: &str) -> CellValue {
        CellValue::Text(s.to_string())
    }

    fn n(v: f64) -> CellValue {
        CellValue::Number(v)
    }

    /// Each Data / Subtotal / GrandTotal row's VALUE cells (no label),
    /// joined: a number to 4 places, an error as `#CODE`, an empty cell `_`.
    fn body(def: &PivotDefinition, cache: &mut PivotCache) -> String {
        let view = calculate_pivot(def, cache);
        view.rows
            .iter()
            .zip(view.cells.iter())
            .filter(|(d, _)| matches!(d.row_type, PivotRowType::Data | PivotRowType::Subtotal | PivotRowType::GrandTotal))
            .map(|(_, cells)| {
                cells
                    .iter()
                    .filter(|c| c.value_field_index.is_some())
                    .map(|c| match &c.value {
                        PivotCellValue::Number(x) if x.is_nan() => "_".to_string(),
                        PivotCellValue::Number(x) => format!("{}", (x * 10000.0).round() / 10000.0),
                        PivotCellValue::Error(code) => format!("#{}", code.trim_start_matches('#')),
                        PivotCellValue::Empty => "_".to_string(),
                        other => format!("{other:?}"),
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect::<Vec<_>>()
            .join(" ; ")
    }

    /// probe A: Region East 10, North 5, Mid #DIV/0!, South 20 (shown East,
    /// Mid, North, South).
    fn cache_a() -> PivotCache {
        cache_of(
            &["Region", "Amount"],
            &[
                vec![t("East"), n(10.0)],
                vec![t("North"), n(5.0)],
                vec![t("Mid"), CellValue::Error(CellError::Div0)],
                vec![t("South"), n(20.0)],
            ],
        )
    }

    fn def_a(show: ShowValuesAs, base_item: Option<&str>) -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Region".into())];
        let mut vf = ValueField::new(1, "Sum of Amount".into(), AggregationType::Sum);
        vf.show_values_as = show;
        vf.base_field_index = Some(0);
        vf.base_item = base_item.map(str::to_string);
        def.value_fields = vec![vf];
        def
    }

    /// probe B: Year rows x Region columns; Y1/West #DIV/0!.
    fn cache_b() -> PivotCache {
        cache_of(
            &["Year", "Region", "Amount"],
            &[
                vec![t("Y1"), t("East"), n(10.0)],
                vec![t("Y1"), t("West"), CellValue::Error(CellError::Div0)],
                vec![t("Y2"), t("East"), n(30.0)],
                vec![t("Y2"), t("West"), n(20.0)],
            ],
        )
    }

    fn def_b(show: ShowValuesAs, base: Option<usize>) -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Year".into())];
        def.column_fields = vec![PivotField::new(1, "Region".into())];
        let mut vf = ValueField::new(2, "Sum of Amount".into(), AggregationType::Sum);
        vf.show_values_as = show;
        vf.base_field_index = base;
        def.value_fields = vec![vf];
        def
    }

    /// probe C: Cat > Item rows; A/a2 #N/A.
    fn cache_c() -> PivotCache {
        cache_of(
            &["Cat", "Item", "Amount"],
            &[
                vec![t("A"), t("a1"), n(10.0)],
                vec![t("A"), t("a2"), CellValue::Error(CellError::NA)],
                vec![t("B"), t("b1"), n(30.0)],
                vec![t("B"), t("b2"), n(10.0)],
            ],
        )
    }

    fn def_c(show: ShowValuesAs, base: Option<usize>) -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Cat".into()), PivotField::new(1, "Item".into())];
        let mut vf = ValueField::new(2, "Sum of Amount".into(), AggregationType::Sum);
        vf.show_values_as = show;
        vf.base_field_index = base;
        def.value_fields = vec![vf];
        def
    }

    fn cache_a_clean() -> PivotCache {
        cache_of(
            &["Region", "Amount"],
            &[
                vec![t("East"), n(10.0)],
                vec![t("North"), n(5.0)],
                vec![t("Mid"), n(8.0)],
                vec![t("South"), n(20.0)],
            ],
        )
    }

    fn cache_b_clean() -> PivotCache {
        cache_of(
            &["Year", "Region", "Amount"],
            &[
                vec![t("Y1"), t("East"), n(10.0)],
                vec![t("Y1"), t("West"), n(6.0)],
                vec![t("Y2"), t("East"), n(30.0)],
                vec![t("Y2"), t("West"), n(20.0)],
            ],
        )
    }

    fn cache_c_clean() -> PivotCache {
        cache_of(
            &["Cat", "Item", "Amount"],
            &[
                vec![t("A"), t("a1"), n(10.0)],
                vec![t("A"), t("a2"), n(2.0)],
                vec![t("B"), t("b1"), n(30.0)],
                vec![t("B"), t("b2"), n(10.0)],
            ],
        )
    }

    fn check(failures: &mut Vec<String>, label: &str, got: String, want: &str) {
        if got != want {
            failures.push(format!("{label}: got  {got}\n{:width$}  want {want}", "", width = label.len()));
        }
    }

    /// Excel [LIVE, piv5 p1/p2]: Show Values As over a source error. The
    /// error in a total divided by is the error in every cell under % of
    /// Grand / Row / Column Total and Index; % of Parent is EMPTY over one;
    /// a running total is the error from the erroring item on and % Running
    /// Total is the error everywhere; Difference From shows the error of the
    /// cell or its base item, % Difference From is EMPTY over an erroring base;
    /// Rank leaves an erroring item EMPTY and unranked. Cells are listed
    /// value-cells-only per row (rows: East, Mid, North, South, Grand Total;
    /// Y1, Y2, Grand Total x East, West, Grand Total; A, a1, a2, B, b1, b2,
    /// Grand Total), `_` an empty cell. Calcula divided by totals that left
    /// the error out (East 28,57% of 35) and ranked the error item as 0.
    ///
    /// SABOTAGE (piv5-sabS): `aggregate_at` never reports an error.
    #[test]
    fn show_values_as_over_a_source_error_answers_as_excel_does() {
        use ShowValuesAs::*;
        let d = "#DIV/0!";
        let mut failures = Vec::new();
        let all = |cells: usize| vec![d; cells].join(" ; ");
        for (label, show, bi, want) in [
            ("A_SUM", Normal, None, "10 ; #DIV/0! ; 5 ; 20 ; #DIV/0!".to_string()),
            ("A_PCTGT", PercentOfGrandTotal, None, all(5)),
            ("A_PCTCOL", PercentOfColumnTotal, None, all(5)),
            ("A_PCTROW", PercentOfRowTotal, None, "1 ; #DIV/0! ; 1 ; 1 ; #DIV/0!".to_string()),
            ("A_INDEX", Index, None, all(5)),
            ("A_RUN", RunningTotal, None, "10 ; #DIV/0! ; #DIV/0! ; #DIV/0! ; _".to_string()),
            ("A_PCTRUN", PercentOfRunningTotal, None, all(5)),
            ("A_DIFF_EAST", Difference, Some("East"), "_ ; #DIV/0! ; -5 ; 10 ; _".to_string()),
            ("A_DIFF_MID", Difference, Some("Mid"), "#DIV/0! ; _ ; #DIV/0! ; #DIV/0! ; _".to_string()),
            ("A_DIFF_PREV", Difference, Some("(previous)"), "_ ; #DIV/0! ; #DIV/0! ; 15 ; _".to_string()),
            ("A_DIFF_NEXT", Difference, Some("(next)"), "#DIV/0! ; #DIV/0! ; -15 ; _ ; _".to_string()),
            ("A_PDIFF_PREV", PercentDifference, Some("(previous)"), "_ ; #DIV/0! ; _ ; 3 ; _".to_string()),
            ("A_PDIFF_MID", PercentDifference, Some("Mid"), "_ ; _ ; _ ; _ ; _".to_string()),
            ("A_PDIFF_EAST", PercentDifference, Some("East"), "_ ; #DIV/0! ; -0.5 ; 1 ; _".to_string()),
            ("A_PDIFF_NEXT", PercentDifference, Some("(next)"), "_ ; #DIV/0! ; -0.75 ; _ ; _".to_string()),
            ("A_RANKASC", RankAscending, None, "2 ; _ ; 1 ; 3 ; _".to_string()),
            ("A_RANKDESC", RankDescending, None, "2 ; _ ; 3 ; 1 ; _".to_string()),
            ("A_PCTPARENTROW", PercentOfParentRow, None, "_ ; _ ; _ ; _ ; _".to_string()),
        ] {
            check(&mut failures, label, body(&def_a(show, bi), &mut cache_a()), &want);
        }
        let all9 = vec!["#DIV/0!,#DIV/0!,#DIV/0!"; 3].join(" ; ");
        for (label, show, base, want) in [
            ("B_SUM", Normal, None, "10,#DIV/0!,#DIV/0! ; 30,20,50 ; 40,#DIV/0!,#DIV/0!".to_string()),
            ("B_PCTGT", PercentOfGrandTotal, None, all9.clone()),
            ("B_PCTROW", PercentOfRowTotal, None, "#DIV/0!,#DIV/0!,#DIV/0! ; 0.6,0.4,1 ; #DIV/0!,#DIV/0!,#DIV/0!".to_string()),
            ("B_PCTCOL", PercentOfColumnTotal, None, "0.25,#DIV/0!,#DIV/0! ; 0.75,#DIV/0!,#DIV/0! ; 1,#DIV/0!,#DIV/0!".to_string()),
            ("B_INDEX", Index, None, all9.clone()),
            ("B_RUN_YEAR", RunningTotal, Some(0), "10,#DIV/0!,#DIV/0! ; 40,#DIV/0!,#DIV/0! ; _,_,_".to_string()),
            ("B_RANKASC_YEAR", RankAscending, Some(0), "1,_,_ ; 2,1,1 ; _,_,_".to_string()),
            ("B_PCTPARENTROW", PercentOfParentRow, None, "0.25,_,_ ; 0.75,_,_ ; 1,_,_".to_string()),
            ("B_PCTPARENTCOL", PercentOfParentColumn, None, "_,_,_ ; 0.6,0.4,1 ; _,_,_".to_string()),
        ] {
            check(&mut failures, label, body(&def_b(show, base), &mut cache_b()), &want);
        }
        let na = "#N/A ; #N/A ; #N/A ; #N/A ; #N/A ; #N/A ; #N/A";
        for (label, show, base, want) in [
            ("C_SUM", Normal, None, "#N/A ; 10 ; #N/A ; 40 ; 30 ; 10 ; #N/A"),
            ("C_PCTPARENTROW", PercentOfParentRow, None, "_ ; _ ; _ ; _ ; 0.75 ; 0.25 ; _"),
            ("C_PCTGT", PercentOfGrandTotal, None, na),
            ("C_RANKDESC_ITEM", RankDescending, Some(1), "_ ; 1 ; _ ; _ ; 1 ; 2 ; _"),
            ("C_RUN_ITEM", RunningTotal, Some(1), "_ ; 10 ; #N/A ; _ ; 30 ; 40 ; _"),
        ] {
            check(&mut failures, label, body(&def_c(show, base), &mut cache_c()), want);
        }
        assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    }

    /// Excel [LIVE, piv5 p3], the same pivots without an error: a TOTAL of
    /// the base field (the grand total; a subtotal of a level above an Item
    /// base) is EMPTY under Running Total, % Running Total, Difference, %
    /// Difference and Rank, and so is the base item's own cell; % Running
    /// Total In is of the base field's total under the cell's parent (a2
    /// 100,00% under A, not 12 of 52); % of Parent Row Total reads a parent
    /// row's own parent (B 76,92%, not 100%). Calcula showed the grand total
    /// a running total, a rank of 1 and a difference, and East 0 under
    /// Difference From East.
    ///
    /// SABOTAGE (piv5-sabS covers the error test; piv5-sabT): a total of the
    /// base field is ranked again.
    #[test]
    fn show_values_as_totals_and_base_items_answer_as_excel_does() {
        use ShowValuesAs::*;
        let mut failures = Vec::new();
        for (label, show, bi, want) in [
            ("A_RUN", RunningTotal, None, "10 ; 18 ; 23 ; 43 ; _"),
            ("A_PCTRUN", PercentOfRunningTotal, None, "0.2326 ; 0.4186 ; 0.5349 ; 1 ; _"),
            ("A_DIFF_EAST", Difference, Some("East"), "_ ; -2 ; -5 ; 10 ; _"),
            ("A_DIFF_MID", Difference, Some("Mid"), "2 ; _ ; -3 ; 12 ; _"),
            ("A_PDIFF_PREV", PercentDifference, Some("(previous)"), "_ ; -0.2 ; -0.375 ; 3 ; _"),
            ("A_RANKASC", RankAscending, None, "3 ; 2 ; 1 ; 4 ; _"),
            ("A_RANKDESC", RankDescending, None, "2 ; 3 ; 4 ; 1 ; _"),
            ("A_PCTPARENTROW", PercentOfParentRow, None, "0.2326 ; 0.186 ; 0.1163 ; 0.4651 ; 1"),
            ("A_PCTGT", PercentOfGrandTotal, None, "0.2326 ; 0.186 ; 0.1163 ; 0.4651 ; 1"),
        ] {
            check(&mut failures, label, body(&def_a(show, bi), &mut cache_a_clean()), want);
        }
        for (label, show, base, want) in [
            ("B_RUN_YEAR", RunningTotal, Some(0), "10,6,16 ; 40,26,66 ; _,_,_"),
            ("B_RANKASC_YEAR", RankAscending, Some(0), "1,1,1 ; 2,2,2 ; _,_,_"),
            ("B_PCTPARENTROW", PercentOfParentRow, None, "0.25,0.2308,0.2424 ; 0.75,0.7692,0.7576 ; 1,1,1"),
            ("B_PCTPARENTCOL", PercentOfParentColumn, None, "0.625,0.375,1 ; 0.6,0.4,1 ; 0.6061,0.3939,1"),
            ("B_INDEX", Index, None, "1.0313,0.9519,1 ; 0.99,1.0154,1 ; 1,1,1"),
        ] {
            check(&mut failures, label, body(&def_b(show, base), &mut cache_b_clean()), want);
        }
        for (label, show, base, want) in [
            ("C_PCTPARENTROW", PercentOfParentRow, None, "0.2308 ; 0.8333 ; 0.1667 ; 0.7692 ; 0.75 ; 0.25 ; 1"),
            ("C_RANKDESC_ITEM", RankDescending, Some(1), "_ ; 1 ; 2 ; _ ; 1 ; 2 ; _"),
            ("C_RUN_ITEM", RunningTotal, Some(1), "_ ; 10 ; 12 ; _ ; 30 ; 40 ; _"),
            ("C_RUN_CAT", RunningTotal, Some(0), "12 ; 10 ; 2 ; 52 ; 30 ; 10 ; _"),
            ("C_PCTRUN_ITEM", PercentOfRunningTotal, Some(1), "_ ; 0.8333 ; 1 ; _ ; 0.75 ; 1 ; _"),
            ("C_DIFF_ITEM_PREV", Difference, Some(1), "_ ; _ ; -8 ; _ ; _ ; -20 ; _"),
        ] {
            let mut def = def_c(show, base);
            if label == "C_DIFF_ITEM_PREV" {
                def.value_fields[0].base_item = Some("(previous)".into());
            }
            check(&mut failures, label, body(&def, &mut cache_c_clean()), want);
        }
        assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    }

    /// piv6 p1 H: Year rows x Region columns (East, West, Z) with empty
    /// intersections (Y2/East, Y2/Z, Y4/Z, Y5/West, Y5/Z, Y6/Z), an all-zero
    /// column (Z) and rows whose total is 0 (Y4 0+0, Y5 0, Y6 4-4).
    fn cache_h() -> PivotCache {
        let rec = |y: &str, r: &str, v: f64| vec![t(y), t(r), n(v)];
        cache_of(
            &["Year", "Region", "Amount"],
            &[
                rec("Y1", "East", 10.0), rec("Y1", "West", 6.0), rec("Y1", "Z", 0.0),
                rec("Y2", "West", 20.0),
                rec("Y3", "East", 5.0), rec("Y3", "West", 8.0), rec("Y3", "Z", 0.0),
                rec("Y4", "East", 0.0), rec("Y4", "West", 0.0),
                rec("Y5", "East", 0.0),
                rec("Y6", "East", 4.0), rec("Y6", "West", -4.0),
            ],
        )
    }

    /// piv6 p1 P: Cat > Item rows x Region columns; C's items are 0 + 0 in
    /// East and 3 - 3 in West, so both of C's parent totals are 0.
    fn cache_p() -> PivotCache {
        let rec = |c: &str, i: &str, r: &str, v: f64| vec![t(c), t(i), t(r), n(v)];
        cache_of(
            &["Cat", "Item", "Region", "Amount"],
            &[
                rec("A", "a1", "East", 10.0), rec("A", "a2", "East", 5.0), rec("A", "a1", "West", 2.0),
                rec("C", "c1", "East", 0.0), rec("C", "c2", "East", 0.0),
                rec("C", "c1", "West", 3.0), rec("C", "c2", "West", -3.0),
                rec("D", "d1", "West", 7.0),
            ],
        )
    }

    fn def_p(show: ShowValuesAs, base: Option<usize>, base_item: Option<&str>) -> PivotDefinition {
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(0, "Cat".into()), PivotField::new(1, "Item".into())];
        def.column_fields = vec![PivotField::new(2, "Region".into())];
        let mut vf = ValueField::new(3, "Sum of Amount".into(), AggregationType::Sum);
        vf.show_values_as = show;
        vf.base_field_index = base;
        vf.base_item = base_item.map(str::to_string);
        def.value_fields = vec![vf];
        def
    }

    /// Excel [LIVE, piv6 p1, scratch piv6/p1.ps1 -> p1.out; verify-piv5
    /// v1 G]: Show Values As over a ZERO or EMPTY base. % of Grand / Row /
    /// Column Total and Index are #DIV/0! over a zero total, an empty cell
    /// too (Calcula showed 0); % of Parent Row / Column Total is EMPTY over a
    /// zero parent; % Running Total In over a zero total is #DIV/0! unless
    /// every item is 0 (then EMPTY); % Difference From is #NULL! in a cell
    /// no record reaches, EMPTY over a base with none and #DIV/0! over a base
    /// of 0 (Calcula showed -100% and EMPTY); Rank leaves an empty cell EMPTY
    /// and unranked (Calcula ranked it as 0) and numbers ties 1, 2, 2, 3
    /// (Calcula 1, 2, 2, 4). Rows here list value cells per row, `_` empty.
    ///
    /// SABOTAGE (each failed this test at the labels named): piv6-s1 a zero
    /// total reads 0 again (H_PCTROW, H_PCTCOL, K_*, P_PCTROW); piv6-s2 ties
    /// leave gaps (H_RANKASC_YEAR, G_*); piv6-s3 an empty cell is not #NULL!
    /// (H_PDIFF_PREV, H_PDIFF_REG_EAST, P_PDIFF_PREV_ITEM); piv6-s4 % Running
    /// Total over a zero total is EMPTY (H_PRUN_REG, K_PRUN, P_PRUN_ITEM);
    /// piv6-s5 an empty cell is ranked (H_RANK*, P_RANKASC_ITEM).
    #[test]
    fn show_values_as_over_a_zero_or_empty_base_answers_as_excel_does() {
        use ShowValuesAs::*;
        let d = "#DIV/0!,#DIV/0!,#DIV/0!,#DIV/0!";
        let e = "_,_,_,_";
        let mut failures = Vec::new();
        let h = |show, base: Option<usize>, bi: Option<&str>| {
            let mut def = def_b(show, base);
            def.value_fields[0].base_item = bi.map(str::to_string);
            body(&def, &mut cache_h())
        };
        let cases: Vec<(&str, String, String)> = vec![
            ("H_PCTGT", h(PercentOfGrandTotal, None, None),
                "0.2041,0.1224,0,0.3265 ; 0,0.4082,0,0.4082 ; 0.102,0.1633,0,0.2653 ; 0,0,0,0 ; 0,0,0,0 ; 0.0816,-0.0816,0,0 ; 0.3878,0.6122,0,1".into()),
            ("H_PCTROW", h(PercentOfRowTotal, None, None),
                format!("0.625,0.375,0,1 ; 0,1,0,1 ; 0.3846,0.6154,0,1 ; {d} ; {d} ; {d} ; 0.3878,0.6122,0,1")),
            ("H_PCTCOL", h(PercentOfColumnTotal, None, None),
                "0.5263,0.2,#DIV/0!,0.3265 ; 0,0.6667,#DIV/0!,0.4082 ; 0.2632,0.2667,#DIV/0!,0.2653 ; 0,0,#DIV/0!,0 ; 0,0,#DIV/0!,0 ; 0.2105,-0.1333,#DIV/0!,0 ; 1,1,#DIV/0!,1".into()),
            ("H_PCTPROW", h(PercentOfParentRow, None, None),
                "0.5263,0.2,_,0.3265 ; 0,0.6667,_,0.4082 ; 0.2632,0.2667,_,0.2653 ; 0,0,_,0 ; 0,0,_,0 ; 0.2105,-0.1333,_,0 ; 1,1,_,1".into()),
            ("H_PCTPCOL", h(PercentOfParentColumn, None, None),
                format!("0.625,0.375,0,1 ; 0,1,0,1 ; 0.3846,0.6154,0,1 ; {e} ; {e} ; {e} ; 0.3878,0.6122,0,1")),
            ("H_INDEX", h(Index, None, None),
                format!("1.6118,0.6125,#DIV/0!,1 ; 0,1.6333,#DIV/0!,1 ; 0.9919,1.0051,#DIV/0!,1 ; {d} ; {d} ; {d} ; 1,1,#DIV/0!,1")),
            ("H_DIFF_Y2", h(Difference, Some(0), Some("Y2")),
                format!("10,-14,0,-4 ; {e} ; 5,-12,0,-7 ; 0,-20,0,-20 ; 0,-20,0,-20 ; 4,-24,0,-20 ; {e}")),
            ("H_PDIFF_PREV", h(PercentDifference, Some(0), Some("(previous)")),
                format!("{e} ; #NULL!,2.3333,#NULL!,0.25 ; _,-0.6,_,-0.35 ; -1,-1,#NULL!,-1 ; #DIV/0!,#NULL!,#NULL!,#DIV/0! ; #DIV/0!,_,#NULL!,#DIV/0! ; {e}")),
            ("H_PDIFF_Y2", h(PercentDifference, Some(0), Some("Y2")),
                format!("_,-0.7,_,-0.2 ; {e} ; _,-0.6,_,-0.35 ; _,-1,#NULL!,-1 ; _,#NULL!,#NULL!,-1 ; _,-1.2,#NULL!,-1 ; {e}")),
            ("H_PDIFF_Y5", h(PercentDifference, Some(0), Some("Y5")),
                format!("#DIV/0!,_,_,#DIV/0! ; #NULL!,_,#NULL!,#DIV/0! ; #DIV/0!,_,_,#DIV/0! ; #DIV/0!,_,#NULL!,#DIV/0! ; {e} ; #DIV/0!,_,#NULL!,#DIV/0! ; {e}")),
            ("H_PDIFF_REG_EAST", h(PercentDifference, Some(1), Some("East")),
                "_,-0.4,-1,_ ; _,_,#NULL!,_ ; _,0.6,-1,_ ; _,#DIV/0!,#NULL!,_ ; _,#NULL!,#NULL!,_ ; _,-2,#NULL!,_ ; _,0.5789,-1,_".into()),
            ("H_RUN_YEAR", h(RunningTotal, Some(0), None),
                format!("10,6,0,16 ; 10,26,0,36 ; 15,34,0,49 ; 15,34,0,49 ; 15,34,0,49 ; 19,30,0,49 ; {e}")),
            ("H_PRUN_YEAR", h(PercentOfRunningTotal, Some(0), None),
                format!("0.5263,0.2,_,0.3265 ; 0.5263,0.8667,_,0.7347 ; 0.7895,1.1333,_,1 ; 0.7895,1.1333,_,1 ; 0.7895,1.1333,_,1 ; 1,1,_,1 ; {e}")),
            ("H_PRUN_REG", h(PercentOfRunningTotal, Some(1), None),
                format!("0.625,1,1,_ ; 0,1,1,_ ; 0.3846,1,1,_ ; {e} ; {e} ; #DIV/0!,#DIV/0!,#DIV/0!,_ ; 0.3878,1,1,_")),
            ("H_RANKASC_YEAR", h(RankAscending, Some(0), None),
                format!("4,3,1,3 ; _,5,_,4 ; 3,4,1,2 ; 1,2,_,1 ; 1,_,_,1 ; 2,1,_,1 ; {e}")),
            ("H_RANKDESC_YEAR", h(RankDescending, Some(0), None),
                format!("1,3,1,2 ; _,1,_,1 ; 2,2,1,3 ; 4,4,_,4 ; 4,_,_,4 ; 3,5,_,4 ; {e}")),
            ("H_RANKASC_REG", h(RankAscending, Some(1), None),
                "3,2,1,_ ; _,1,_,_ ; 2,3,1,_ ; 1,1,_,_ ; 1,_,_,_ ; 2,1,_,_ ; 2,3,1,_".into()),
        ];
        for (label, got, want) in cases {
            check(&mut failures, label, got, &want);
        }

        // K: East 5, Mid 0, West -5 -- a grand total of 0.
        let k = || cache_of(&["Region", "Amount"], &[vec![t("East"), n(5.0)], vec![t("West"), n(-5.0)], vec![t("Mid"), n(0.0)]]);
        for (label, show, want) in [
            ("K_PCTGT", PercentOfGrandTotal, "#DIV/0! ; #DIV/0! ; #DIV/0! ; #DIV/0!"),
            ("K_PCTCOL", PercentOfColumnTotal, "#DIV/0! ; #DIV/0! ; #DIV/0! ; #DIV/0!"),
            ("K_PCTROW", PercentOfRowTotal, "1 ; #DIV/0! ; 1 ; #DIV/0!"),
            ("K_PCTPROW", PercentOfParentRow, "_ ; _ ; _ ; _"),
            ("K_INDEX", Index, "#DIV/0! ; #DIV/0! ; #DIV/0! ; #DIV/0!"),
            ("K_PRUN", PercentOfRunningTotal, "#DIV/0! ; #DIV/0! ; #DIV/0! ; _"),
            ("K_RUN", RunningTotal, "5 ; 5 ; 0 ; _"),
        ] {
            check(&mut failures, label, body(&def_a(show, None), &mut k()), want);
        }

        // G (verify-piv5 v1): East 10, North 10, South 5, West 20 -- a tie.
        let g = || cache_of(
            &["Region", "Amount"],
            &[vec![t("East"), n(10.0)], vec![t("North"), n(10.0)], vec![t("South"), n(5.0)], vec![t("West"), n(20.0)]],
        );
        check(&mut failures, "G_RANKASC", body(&def_a(RankAscending, None), &mut g()), "2 ; 2 ; 1 ; 3 ; _");
        check(&mut failures, "G_RANKDESC", body(&def_a(RankDescending, None), &mut g()), "2 ; 2 ; 3 ; 1 ; _");

        // P: rows A, a1, a2, C, c1, c2, D, d1, Grand Total (subtotals on
        // top) x East, West, Grand Total.
        let x = "_,_,_";
        for (label, show, base, bi, want) in [
            ("P_PCTPROW", PercentOfParentRow, None, None,
                format!("1,0.2222,0.7083 ; 0.6667,1,0.7059 ; 0.3333,0,0.2941 ; 0,0,0 ; {x} ; {x} ; 0,0.7778,0.2917 ; _,1,1 ; 1,1,1")),
            ("P_PCTPCOL", PercentOfParentColumn, None, None,
                format!("0.8824,0.1176,1 ; 0.8333,0.1667,1 ; 1,0,1 ; {x} ; 0,1,1 ; 0,1,1 ; 0,1,1 ; 0,1,1 ; 0.625,0.375,1")),
            ("P_PCTROW", PercentOfRowTotal, None, None,
                "0.8824,0.1176,1 ; 0.8333,0.1667,1 ; 1,0,1 ; #DIV/0!,#DIV/0!,#DIV/0! ; 0,1,1 ; 0,1,1 ; 0,1,1 ; 0,1,1 ; 0.625,0.375,1".to_string()),
            ("P_RANKASC_ITEM", RankAscending, Some(1), None,
                format!("{x} ; 2,1,2 ; 1,_,1 ; {x} ; 1,2,2 ; 1,1,1 ; {x} ; _,1,1 ; {x}")),
            ("P_PRUN_ITEM", PercentOfRunningTotal, Some(1), None,
                format!("{x} ; 0.6667,1,0.7059 ; 1,1,1 ; {x} ; _,#DIV/0!,#DIV/0! ; _,#DIV/0!,#DIV/0! ; {x} ; _,1,1 ; {x}")),
            ("P_PDIFF_PREV_ITEM", PercentDifference, Some(1), Some("(previous)"),
                format!("{x} ; {x} ; -0.5,#NULL!,-0.5833 ; {x} ; {x} ; #DIV/0!,-2,-2 ; {x} ; {x} ; {x}")),
        ] {
            check(&mut failures, label, body(&def_p(show, base, bi), &mut cache_p()), &want);
        }
        assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    }
}
