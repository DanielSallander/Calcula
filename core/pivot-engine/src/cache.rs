//! FILENAME: core/pivot-engine/src/cache.rs
//! Pivot Cache - High-performance internal representation.
//!
//! The cache is designed for:
//! - Fast initial build from source data (O(n) where n = rows)
//! - Instant re-grouping when fields are rearranged (no re-scan)
//! - Memory-efficient storage via value interning
//! - Incremental updates when source data changes
//!
//! Architecture:
//! - Each unique value is stored once and referenced by index
//! - Row data is stored as vectors of indices into the unique value stores
//! - Aggregates are pre-computed and keyed by group combinations

use std::collections::{HashMap, HashSet};
use rustc_hash::{FxHashMap, FxHashSet};
use smallvec::SmallVec;
use serde::{Deserialize, Serialize};
use engine::CellValue;
use crate::definition::{AggregationType, FieldIndex, PivotId};

/// Inline capacity for GroupKey — covers the typical 2-6 field case
/// without heap allocation.
pub type GroupKeyVec = SmallVec<[ValueId; 6]>;

// ============================================================================
// VALUE INTERNING
// ============================================================================

/// A reference to an interned value within a field's unique value store.
/// Using u32 to save memory (supports up to 4B unique values per field).
pub type ValueId = u32;

/// Represents a "null" or missing value in the cache.
pub const VALUE_ID_EMPTY: ValueId = u32::MAX;

/// A normalized, hashable representation of a cell value.
/// Used as keys in the unique value store.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CacheValue {
    Empty,
    Number(OrderedFloat),
    Text(String),
    Boolean(bool),
    Error(String),
}

impl From<&CellValue> for CacheValue {
    fn from(value: &CellValue) -> Self {
        match value {
            CellValue::Empty => CacheValue::Empty,
            CellValue::Number(n) => CacheValue::Number(OrderedFloat(*n)),
            CellValue::Text(s) => CacheValue::Text(s.clone()),
            CellValue::Boolean(b) => CacheValue::Boolean(*b),
            CellValue::Error(e) => CacheValue::Error(format!("{:?}", e)),
            CellValue::List(items) => CacheValue::Text(format!("[List({})]", items.len())),
            CellValue::Dict(entries) => CacheValue::Text(format!("[Dict({})]", entries.len())),
        }
    }
}

/// Wrapper around f64 that implements Eq and Hash for use as HashMap keys.
/// NaN values are treated as equal to each other.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct OrderedFloat(pub f64);

impl PartialEq for OrderedFloat {
    fn eq(&self, other: &Self) -> bool {
        if self.0.is_nan() && other.0.is_nan() {
            true
        } else {
            self.0 == other.0
        }
    }
}

impl Eq for OrderedFloat {}

impl std::hash::Hash for OrderedFloat {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        if self.0.is_nan() {
            // All NaN values hash to the same thing
            u64::MAX.hash(state);
        } else {
            self.0.to_bits().hash(state);
        }
    }
}

impl OrderedFloat {
    pub fn as_f64(&self) -> f64 {
        self.0
    }
}

// ============================================================================
// FIELD CACHE
// ============================================================================

/// Cache for a single field (column) from the source data.
/// Stores unique values and provides O(1) lookup by ValueId.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldCache {
    /// The source column index this cache represents.
    pub source_index: FieldIndex,

    /// Display name (from header row).
    pub name: String,

    /// Map from value to its unique ID (for deduplication during build).
    value_to_id: HashMap<CacheValue, ValueId>,

    /// Ordered list of unique values (indexed by ValueId).
    /// This allows O(1) lookup from ID to value.
    id_to_value: Vec<CacheValue>,

    /// Pre-sorted order of ValueIds (ascending by value).
    /// Used for fast sorted iteration.
    sorted_ids_asc: Vec<ValueId>,

    /// Whether the sorted indices need rebuilding.
    sort_dirty: bool,

    /// Optional display label overrides for values (used by date/number grouping).
    /// When present, get_value_label uses this map instead of the raw CacheValue display.
    #[serde(default)]
    pub label_map: HashMap<ValueId, String>,
}

impl FieldCache {
    pub fn new(source_index: FieldIndex, name: String) -> Self {
        FieldCache {
            source_index,
            name,
            value_to_id: HashMap::new(),
            id_to_value: Vec::new(),
            sorted_ids_asc: Vec::new(),
            sort_dirty: true,
            label_map: HashMap::new(),
        }
    }
    
    /// Interns a value and returns its ValueId.
    /// If the value already exists, returns the existing ID.
    pub fn intern(&mut self, value: CacheValue) -> ValueId {
        if let CacheValue::Empty = value {
            return VALUE_ID_EMPTY;
        }
        
        if let Some(&id) = self.value_to_id.get(&value) {
            return id;
        }
        
        let id = self.id_to_value.len() as ValueId;
        self.id_to_value.push(value.clone());
        self.value_to_id.insert(value, id);
        self.sort_dirty = true;
        id
    }
    
    /// Gets the value for a given ID.
    pub fn get_value(&self, id: ValueId) -> Option<&CacheValue> {
        if id == VALUE_ID_EMPTY {
            return Some(&CacheValue::Empty);
        }
        self.id_to_value.get(id as usize)
    }
    
    /// Returns the number of unique values (excluding empty).
    pub fn unique_count(&self) -> usize {
        self.id_to_value.len()
    }
    
    /// Returns all unique ValueIds in sorted order.
    pub fn sorted_ids(&mut self) -> &[ValueId] {
        if self.sort_dirty {
            self.rebuild_sort_order();
        }
        &self.sorted_ids_asc
    }
    
    /// Rebuilds the sorted order of unique values.
    fn rebuild_sort_order(&mut self) {
        self.sorted_ids_asc = (0..self.id_to_value.len() as ValueId).collect();
        self.sorted_ids_asc.sort_by(|&a, &b| {
            let va = &self.id_to_value[a as usize];
            let vb = &self.id_to_value[b as usize];
            Self::compare_cache_values(va, vb)
        });
        self.sort_dirty = false;
    }
    
    /// Comparison function for sorting CacheValues.
    fn compare_cache_values(a: &CacheValue, b: &CacheValue) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        match (a, b) {
            (CacheValue::Empty, CacheValue::Empty) => Ordering::Equal,
            (CacheValue::Empty, _) => Ordering::Less,
            (_, CacheValue::Empty) => Ordering::Greater,
            
            (CacheValue::Number(na), CacheValue::Number(nb)) => {
                na.0.partial_cmp(&nb.0).unwrap_or(Ordering::Equal)
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

// ============================================================================
// ROW RECORD
// ============================================================================

/// A single row from the source data, stored as interned value IDs.
/// This is extremely memory-efficient for large datasets with repeated values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheRecord {
    /// The original row index in the source data (0-based, excluding header).
    pub source_row: u32,
    
    /// ValueIds for each field, indexed by FieldIndex.
    pub values: Vec<ValueId>,
}

// ============================================================================
// GROUP KEY
// ============================================================================

/// A key representing a unique combination of row/column field values.
/// Used to look up pre-computed aggregates.
///
/// Implements `Borrow<[ValueId]>` so that HashMap lookups can use a
/// `&[ValueId]` slice without allocating a new Vec.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GroupKey {
    /// ValueIds for each field in the grouping (row fields then column fields).
    /// A VALUE_ID_EMPTY indicates "all values" (for subtotals/grand totals).
    /// Uses SmallVec to avoid heap allocation for the typical 2-6 field case.
    pub values: GroupKeyVec,
}

impl std::borrow::Borrow<[ValueId]> for GroupKey {
    fn borrow(&self) -> &[ValueId] {
        &self.values
    }
}

impl GroupKey {
    pub fn new(values: Vec<ValueId>) -> Self {
        GroupKey { values: SmallVec::from_vec(values) }
    }

    pub fn from_slice(slice: &[ValueId]) -> Self {
        GroupKey { values: SmallVec::from_slice(slice) }
    }

    /// Creates a key for the grand total (all fields are "all values").
    pub fn grand_total(field_count: usize) -> Self {
        GroupKey {
            values: smallvec::smallvec![VALUE_ID_EMPTY; field_count],
        }
    }

    /// Creates a subtotal key by setting fields after `level` to "all values".
    pub fn subtotal_at_level(&self, level: usize) -> Self {
        let mut values = self.values.clone();
        for i in (level + 1)..values.len() {
            values[i] = VALUE_ID_EMPTY;
        }
        GroupKey { values }
    }
}

// ============================================================================
// AGGREGATE ACCUMULATOR
// ============================================================================

/// Accumulator for computing aggregates incrementally.
/// Stores intermediate state needed for all aggregation types.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AggregateAccumulator {
    pub sum: f64,
    pub count: u64,
    pub count_numbers: u64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub product: f64,
    /// For variance/stddev: sum of squared differences from mean.
    /// Using Welford's algorithm for numerical stability.
    pub m2: f64,
    pub mean: f64,
    pub has_product: bool,
}

impl AggregateAccumulator {
    pub fn new() -> Self {
        AggregateAccumulator {
            sum: 0.0,
            count: 0,
            count_numbers: 0,
            min: None,
            max: None,
            product: 1.0,
            m2: 0.0,
            mean: 0.0,
            has_product: false,
        }
    }
    
    /// Adds a numeric value to the accumulator.
    pub fn add_number(&mut self, value: f64) {
        // Count
        self.count += 1;
        self.count_numbers += 1;
        
        // Sum
        self.sum += value;
        
        // Min/Max
        self.min = Some(self.min.map_or(value, |m| m.min(value)));
        self.max = Some(self.max.map_or(value, |m| m.max(value)));
        
        // Product
        if !self.has_product {
            self.has_product = true;
            self.product = value;
        } else {
            self.product *= value;
        }
        
        // Welford's algorithm for variance
        let delta = value - self.mean;
        self.mean += delta / (self.count_numbers as f64);
        let delta2 = value - self.mean;
        self.m2 += delta * delta2;
    }
    
    /// Adds a non-numeric value (only increments count).
    pub fn add_non_number(&mut self) {
        self.count += 1;
    }

    /// Computes the final aggregate value.
    pub fn compute(&self, aggregation: AggregationType) -> f64 {
        match aggregation {
            AggregationType::Sum => self.sum,
            AggregationType::Count => self.count as f64,
            AggregationType::CountNumbers => self.count_numbers as f64,
            AggregationType::Average => {
                if self.count_numbers > 0 {
                    self.sum / (self.count_numbers as f64)
                } else {
                    0.0
                }
            }
            AggregationType::Min => self.min.unwrap_or(0.0),
            AggregationType::Max => self.max.unwrap_or(0.0),
            AggregationType::Product => {
                if self.has_product {
                    self.product
                } else {
                    0.0
                }
            }
            AggregationType::Var => {
                if self.count_numbers > 1 {
                    self.m2 / ((self.count_numbers - 1) as f64)
                } else {
                    0.0
                }
            }
            AggregationType::VarP => {
                if self.count_numbers > 0 {
                    self.m2 / (self.count_numbers as f64)
                } else {
                    0.0
                }
            }
            AggregationType::StdDev => {
                if self.count_numbers > 1 {
                    (self.m2 / ((self.count_numbers - 1) as f64)).sqrt()
                } else {
                    0.0
                }
            }
            AggregationType::StdDevP => {
                if self.count_numbers > 0 {
                    (self.m2 / (self.count_numbers as f64)).sqrt()
                } else {
                    0.0
                }
            }
        }
    }
    
    /// Merges another accumulator into this one (for parallel computation).
    pub fn merge(&mut self, other: &AggregateAccumulator) {
        if other.count == 0 {
            return;
        }
        
        let combined_count = self.count_numbers + other.count_numbers;
        
        // Parallel Welford merge
        if combined_count > 0 && self.count_numbers > 0 && other.count_numbers > 0 {
            let delta = other.mean - self.mean;
            let new_mean = self.mean + delta * (other.count_numbers as f64) / (combined_count as f64);
            self.m2 = self.m2 + other.m2 + 
                delta * delta * (self.count_numbers as f64) * (other.count_numbers as f64) / (combined_count as f64);
            self.mean = new_mean;
        } else if other.count_numbers > 0 {
            self.mean = other.mean;
            self.m2 = other.m2;
        }
        
        self.sum += other.sum;
        self.count += other.count;
        self.count_numbers = combined_count;
        
        if let Some(other_min) = other.min {
            self.min = Some(self.min.map_or(other_min, |m| m.min(other_min)));
        }
        if let Some(other_max) = other.max {
            self.max = Some(self.max.map_or(other_max, |m| m.max(other_max)));
        }
        
        if other.has_product {
            if self.has_product {
                self.product *= other.product;
            } else {
                self.product = other.product;
                self.has_product = true;
            }
        }
    }
}

// ============================================================================
// PRE-COMPUTED AGGREGATES
// ============================================================================

/// Pre-computed aggregate values for a specific group and value field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputedAggregate {
    /// The computed result for each aggregation type.
    /// Key is the value field index, value is the accumulator.
    pub accumulators: Vec<AggregateAccumulator>,
}

// ============================================================================
// MAIN CACHE STRUCT
// ============================================================================

/// Layout information for flattening column combinations into array indices.
/// Enables O(1) column lookups by replacing HashMap with arithmetic indexing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ColumnLayout {
    /// Cardinality of each column field (number of unique values).
    /// The extra +1 slot (for VALUE_ID_EMPTY subtotals) is accounted for in strides.
    cardinalities: Vec<usize>,
    /// Strides for index computation. stride[i] = product of (card[j]+1) for j > i.
    strides: Vec<usize>,
    /// Total number of column combinations = product of (card[i]+1).
    pub total_combinations: usize,
    /// Number of value fields.
    pub value_count: usize,
}

impl ColumnLayout {
    /// Builds a ColumnLayout from column field cardinalities and value count.
    fn new(col_cardinalities: &[usize], value_count: usize) -> Self {
        let col_count = col_cardinalities.len();
        if col_count == 0 {
            return ColumnLayout {
                cardinalities: Vec::new(),
                strides: Vec::new(),
                total_combinations: 1, // single "no-column" slot
                value_count,
            };
        }

        let mut strides = vec![1usize; col_count];
        // strides[last] = 1, strides[i] = product of (card[j]+1) for j > i
        for i in (0..col_count - 1).rev() {
            strides[i] = strides[i + 1] * (col_cardinalities[i + 1] + 1);
        }
        let total = strides[0] * (col_cardinalities[0] + 1);

        ColumnLayout {
            cardinalities: col_cardinalities.to_vec(),
            strides,
            total_combinations: total,
            value_count,
        }
    }

    /// Computes the flat column index for a column key slice.
    /// VALUE_ID_EMPTY maps to the subtotal slot (= cardinality[i]).
    #[inline(always)]
    pub fn col_index(&self, col_key: &[ValueId]) -> usize {
        let mut idx = 0;
        for (i, &vid) in col_key.iter().enumerate() {
            if i >= self.cardinalities.len() {
                break;
            }
            let mapped = if vid == VALUE_ID_EMPTY {
                self.cardinalities[i]
            } else {
                (vid as usize).min(self.cardinalities[i]) // defensive clamp
            };
            idx += mapped * self.strides[i];
        }
        // Handle col_key shorter than cardinalities (remaining = subtotal slots)
        for i in col_key.len()..self.cardinalities.len() {
            idx += self.cardinalities[i] * self.strides[i];
        }
        idx
    }

    /// Returns the flat index into the accumulator array for a specific
    /// column combination and value field.
    #[inline(always)]
    pub fn acc_index(&self, col_key: &[ValueId], value_field_idx: usize) -> usize {
        self.col_index(col_key) * self.value_count + value_field_idx
    }

    /// Total number of accumulators per row slot.
    #[inline(always)]
    pub fn slot_len(&self) -> usize {
        self.total_combinations * self.value_count
    }
}

/// The main pivot cache structure.
/// Designed for 1M+ row performance with O(1) lookups after initial build.
///
/// Aggregates use a two-level structure: row keys in a HashMap, column
/// combinations as flat arrays. This reduces HashMap entries by a factor
/// of `column_combinations` and replaces column hashing with arithmetic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotCache {
    /// The pivot table ID this cache belongs to.
    pub pivot_id: PivotId,

    /// Version from the definition (for invalidation checking).
    pub definition_version: u64,

    /// Cache for each source field (column).
    pub fields: Vec<FieldCache>,

    /// All source records, stored as interned value IDs.
    pub records: Vec<CacheRecord>,

    /// Pre-computed aggregates keyed by ROW-only GroupKey.
    /// Each entry is a flat array of accumulators:
    ///   slot[col_index * value_count + value_field_idx]
    /// where col_index is computed via ColumnLayout.
    aggregates: FxHashMap<GroupKey, Vec<AggregateAccumulator>>,

    /// Column layout for computing flat column indices.
    col_layout: ColumnLayout,

    /// Whether aggregates need recomputation.
    aggregates_dirty: bool,

    /// Bitmap of which records pass the current filters.
    /// Length = records.len(), true = included.
    pub filter_mask: Vec<bool>,

    /// Virtual fields created by grouping transforms (date grouping, number binning, manual grouping).
    /// Indexed starting at fields.len(), so virtual field i is at index fields.len() + i.
    /// Each virtual field maps source record indices to transformed ValueIds.
    pub virtual_fields: Vec<FieldCache>,

    /// Mapping from source record index to virtual field ValueIds.
    /// virtual_records[virtual_field_index][record_index] = ValueId
    pub virtual_records: Vec<Vec<ValueId>>,

    /// Statistics for optimization decisions.
    pub stats: CacheStats,
}

/// Statistics about the cache for optimization.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CacheStats {
    pub total_records: usize,
    pub filtered_records: usize,
    pub unique_value_count: usize,
    pub aggregate_groups: usize,
    pub build_time_ms: u64,
}

impl PivotCache {
    /// Creates a new empty cache.
    pub fn new(pivot_id: PivotId, field_count: usize) -> Self {
        PivotCache {
            pivot_id,
            definition_version: 0,
            fields: (0..field_count)
                .map(|i| FieldCache::new(i, format!("Field{}", i)))
                .collect(),
            records: Vec::new(),
            aggregates: FxHashMap::default(),
            col_layout: ColumnLayout::default(),
            aggregates_dirty: true,
            filter_mask: Vec::new(),
            virtual_fields: Vec::new(),
            virtual_records: Vec::new(),
            stats: CacheStats::default(),
        }
    }
    
    /// Reserves capacity for expected record count (performance optimization).
    pub fn reserve(&mut self, record_count: usize) {
        self.records.reserve(record_count);
        self.filter_mask.reserve(record_count);
    }
    
    /// Adds a record to the cache.
    /// Values should be in field order.
    pub fn add_record(&mut self, source_row: u32, values: &[CellValue]) {
        let mut interned_values = Vec::with_capacity(self.fields.len());
        
        for (i, value) in values.iter().enumerate() {
            if i < self.fields.len() {
                let cache_value = CacheValue::from(value);
                let value_id = self.fields[i].intern(cache_value);
                interned_values.push(value_id);
            }
        }
        
        // Pad with empty if needed
        while interned_values.len() < self.fields.len() {
            interned_values.push(VALUE_ID_EMPTY);
        }
        
        self.records.push(CacheRecord {
            source_row,
            values: interned_values,
        });
        self.filter_mask.push(true); // Default: include all
        self.aggregates_dirty = true;
    }
    
    /// Sets the field name (from header row).
    pub fn set_field_name(&mut self, field_index: FieldIndex, name: String) {
        if field_index < self.fields.len() {
            self.fields[field_index].name = name;
        }
    }
    
    /// Applies filters and updates the filter mask.
    pub fn apply_filters(&mut self, hidden_items: &[(FieldIndex, Vec<ValueId>)]) {
        // Reset filter mask
        for mask in self.filter_mask.iter_mut() {
            *mask = true;
        }

        // Apply each field's hidden items
        for (field_idx, hidden) in hidden_items {
            if *field_idx >= self.fields.len() {
                continue;
            }

            for (i, record) in self.records.iter().enumerate() {
                if !self.filter_mask[i] {
                    continue; // Already filtered out
                }

                let value_id = record.values.get(*field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                if hidden.contains(&value_id) {
                    self.filter_mask[i] = false;
                }
            }
        }

        // Update stats
        self.stats.filtered_records = self.filter_mask.iter().filter(|&&x| x).count();
        self.aggregates_dirty = true;
    }

    /// Pre-filters records based on Page Filter selections.
    /// This acts as a "pre-filter" on the dataset before aggregation happens.
    /// Only records matching ALL page filter selections are included.
    ///
    /// # Arguments
    /// * `page_filters` - A map from field index to the set of allowed ValueIds.
    ///   If a field is in the map, only records with values in the HashSet are included.
    ///   If the HashSet is empty, all values for that field are excluded.
    pub fn pre_filter_records(&mut self, page_filters: &HashMap<FieldIndex, HashSet<ValueId>>) {
        // Reset filter mask
        for mask in self.filter_mask.iter_mut() {
            *mask = true;
        }

        // Skip if no page filters
        if page_filters.is_empty() {
            self.stats.filtered_records = self.records.len();
            self.aggregates_dirty = true;
            return;
        }

        // Apply page filters - record must match ALL filter criteria
        for (i, record) in self.records.iter().enumerate() {
            if !self.filter_mask[i] {
                continue; // Already filtered out
            }

            // Check each page filter
            for (field_idx, allowed_values) in page_filters {
                if *field_idx >= self.fields.len() {
                    continue;
                }

                let value_id = record.values.get(*field_idx).copied().unwrap_or(VALUE_ID_EMPTY);

                // If the value is not in the allowed set, exclude this record
                if !allowed_values.contains(&value_id) {
                    self.filter_mask[i] = false;
                    break; // No need to check other filters
                }
            }
        }

        // Update stats
        self.stats.filtered_records = self.filter_mask.iter().filter(|&&x| x).count();
        self.aggregates_dirty = true;
    }

    /// Applies both page filters and hidden item filters in sequence.
    /// Page filters are applied first (inclusion filter), then hidden items (exclusion filter).
    ///
    /// # Arguments
    /// * `page_filters` - Map of field index to allowed ValueIds (inclusion filter)
    /// * `hidden_items` - List of (field_index, hidden_value_ids) tuples (exclusion filter)
    pub fn apply_combined_filters(
        &mut self,
        page_filters: &HashMap<FieldIndex, HashSet<ValueId>>,
        hidden_items: &[(FieldIndex, Vec<ValueId>)],
    ) {
        // Reset filter mask
        for mask in self.filter_mask.iter_mut() {
            *mask = true;
        }

        // First pass: apply page filters (inclusion filter)
        if !page_filters.is_empty() {
            for (i, record) in self.records.iter().enumerate() {
                for (field_idx, allowed_values) in page_filters {
                    if *field_idx >= self.fields.len() {
                        continue;
                    }

                    let value_id = record.values.get(*field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                    if !allowed_values.contains(&value_id) {
                        self.filter_mask[i] = false;
                        break;
                    }
                }
            }
        }

        // Second pass: apply hidden items filter (exclusion filter)
        for (field_idx, hidden) in hidden_items {
            if *field_idx >= self.fields.len() {
                continue;
            }

            for (i, record) in self.records.iter().enumerate() {
                if !self.filter_mask[i] {
                    continue; // Already filtered out
                }

                let value_id = record.values.get(*field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                if hidden.contains(&value_id) {
                    self.filter_mask[i] = false;
                }
            }
        }

        // Update stats
        self.stats.filtered_records = self.filter_mask.iter().filter(|&&x| x).count();
        self.aggregates_dirty = true;
    }

    /// Returns all unique values for a specific filter field.
    /// Used for populating the dropdown list in Page Filters.
    ///
    /// # Arguments
    /// * `field_index` - The index of the field to get unique values for
    ///
    /// # Returns
    /// A vector of (ValueId, String) pairs where the string is the display label
    pub fn get_unique_values_for_filter(&self, field_index: FieldIndex) -> Vec<(ValueId, String)> {
        let mut result = Vec::new();

        if let Some(field_cache) = self.fields.get(field_index) {
            for id in 0..field_cache.unique_count() as ValueId {
                if let Some(value) = field_cache.get_value(id) {
                    let label = match value {
                        CacheValue::Empty => "(blank)".to_string(),
                        CacheValue::Number(n) => format!("{}", n.as_f64()),
                        CacheValue::Text(s) => s.clone(),
                        CacheValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
                        CacheValue::Error(e) => format!("#{}", e),
                    };
                    result.push((id, label));
                }
            }
        }

        result
    }

    /// Returns unique values for a filter field that exist in the current filtered dataset.
    /// This is useful when cascading filters (showing only values that exist after other filters).
    ///
    /// # Arguments
    /// * `field_index` - The index of the field to get unique values for
    ///
    /// # Returns
    /// A vector of (ValueId, String) pairs for values that exist in filtered records
    pub fn get_unique_values_for_filter_in_data(&self, field_index: FieldIndex) -> Vec<(ValueId, String)> {
        let mut seen_ids: FxHashSet<ValueId> = FxHashSet::default();

        // Collect unique value IDs from filtered records
        for (i, record) in self.records.iter().enumerate() {
            if !self.filter_mask[i] {
                continue;
            }

            if let Some(&value_id) = record.values.get(field_index) {
                seen_ids.insert(value_id);
            }
        }

        // Convert to (ValueId, label) pairs
        let mut result = Vec::with_capacity(seen_ids.len());

        if let Some(field_cache) = self.fields.get(field_index) {
            for id in seen_ids {
                let label = if id == VALUE_ID_EMPTY {
                    "(blank)".to_string()
                } else if let Some(value) = field_cache.get_value(id) {
                    match value {
                        CacheValue::Empty => "(blank)".to_string(),
                        CacheValue::Number(n) => format!("{}", n.as_f64()),
                        CacheValue::Text(s) => s.clone(),
                        CacheValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
                        CacheValue::Error(e) => format!("#{}", e),
                    }
                } else {
                    "(unknown)".to_string()
                };
                result.push((id, label));
            }
        }

        // Sort by label for consistent ordering
        result.sort_by(|a, b| a.1.cmp(&b.1));

        result
    }
    
    /// Returns an iterator over filtered records.
    pub fn filtered_records(&self) -> impl Iterator<Item = &CacheRecord> {
        self.records
            .iter()
            .zip(self.filter_mask.iter())
            .filter_map(|(record, &included)| if included { Some(record) } else { None })
    }

    /// Returns an iterator over filtered records with their indices.
    pub fn filtered_records_indexed(&self) -> impl Iterator<Item = (usize, &CacheRecord)> {
        self.records
            .iter()
            .enumerate()
            .zip(self.filter_mask.iter())
            .filter_map(|((idx, record), &included)| {
                if included { Some((idx, record)) } else { None }
            })
    }
    
    /// Gets or computes the aggregate for a combined row+col group key.
    /// Triggers lazy computation if aggregates are dirty.
    pub fn get_aggregate(
        &mut self,
        group_key: &GroupKey,
        row_field_indices: &[FieldIndex],
        col_field_indices: &[FieldIndex],
        value_field_indices: &[FieldIndex],
    ) -> Option<&Vec<AggregateAccumulator>> {
        if self.aggregates_dirty {
            self.compute_aggregates(row_field_indices, col_field_indices, value_field_indices);
        }

        // Split the combined key into row portion — the HashMap key
        let row_count = row_field_indices.len();
        let row_key = &group_key.values[..row_count.min(group_key.values.len())];
        self.aggregates.get(row_key)
    }

    /// Returns the row slot (flat array of all column × value accumulators)
    /// for the given row key. Use with `col_layout()` for column indexing.
    pub fn get_row_slot(&self, row_key: &[ValueId]) -> Option<&Vec<AggregateAccumulator>> {
        self.aggregates.get(row_key)
    }

    /// Returns the column layout for computing flat column indices.
    pub fn col_layout(&self) -> &ColumnLayout {
        &self.col_layout
    }
    
    /// Computes all aggregates using a two-level row/column split.
    ///
    /// Row keys stay in a HashMap (high cardinality). Column combinations
    /// are stored as a flat array per row entry, indexed by arithmetic.
    /// This reduces HashMap entries by `column_combinations` and replaces
    /// column hashing with O(1) array indexing.
    fn compute_aggregates(
        &mut self,
        row_field_indices: &[FieldIndex],
        col_field_indices: &[FieldIndex],
        value_field_indices: &[FieldIndex],
    ) {
        self.aggregates.clear();

        let value_count = value_field_indices.len();
        let row_count = row_field_indices.len();
        let col_count = col_field_indices.len();
        let base_field_count = self.fields.len();

        // Build column layout from field cardinalities
        let col_cardinalities: Vec<usize> = col_field_indices.iter().map(|&fi| {
            self.get_field(fi).map(|fc| fc.unique_count()).unwrap_or(1).max(1)
        }).collect();
        self.col_layout = ColumnLayout::new(&col_cardinalities, value_count);
        let slot_len = self.col_layout.slot_len();

        // Estimate row-only capacity
        let estimated_row_unique = {
            let mut est: usize = 1;
            for &fi in row_field_indices.iter() {
                let card = self.get_field(fi)
                    .map(|fc| fc.unique_count())
                    .unwrap_or(1)
                    .max(1);
                est = est.saturating_mul(card);
            }
            est.min(self.records.len()).min(500_000)
        };
        let row_subtotal_combos = row_count + 1;
        self.aggregates.reserve(estimated_row_unique * row_subtotal_combos);

        // Reusable buffers
        let mut row_buf = vec![VALUE_ID_EMPTY; row_count];
        let mut col_buf = vec![VALUE_ID_EMPTY; col_count];
        let mut value_buf: Vec<Option<f64>> = vec![None; value_count];
        let mut row_key_buf = vec![VALUE_ID_EMPTY; row_count];

        // Helper: accumulate values into a row slot at a given column index
        #[inline(always)]
        fn accumulate_at(
            aggregates: &mut FxHashMap<GroupKey, Vec<AggregateAccumulator>>,
            row_key: &[ValueId],
            col_index: usize,
            value_buf: &[Option<f64>],
            value_count: usize,
            slot_len: usize,
        ) {
            let base = col_index * value_count;
            if let Some(slot) = aggregates.get_mut(row_key) {
                for (vi, &numeric_value) in value_buf.iter().enumerate() {
                    if let Some(n) = numeric_value {
                        slot[base + vi].add_number(n);
                    }
                }
            } else {
                let mut slot = vec![AggregateAccumulator::new(); slot_len];
                for (vi, &numeric_value) in value_buf.iter().enumerate() {
                    if let Some(n) = numeric_value {
                        slot[base + vi].add_number(n);
                    }
                }
                aggregates.insert(GroupKey::from_slice(row_key), slot);
            }
        }

        // Pre-compute column strides for subtotal index calculation
        let col_layout = &self.col_layout;
        let col_cards = &col_cardinalities;

        for (i, record) in self.records.iter().enumerate() {
            if !self.filter_mask[i] {
                continue;
            }

            // Fill row values buffer
            for (slot, &fi) in row_buf.iter_mut().zip(row_field_indices.iter()) {
                *slot = if fi < base_field_count {
                    record.values.get(fi).copied().unwrap_or(VALUE_ID_EMPTY)
                } else {
                    let vi = fi - base_field_count;
                    self.virtual_records.get(vi)
                        .and_then(|vr| vr.get(i))
                        .copied()
                        .unwrap_or(VALUE_ID_EMPTY)
                };
            }

            // Fill column values buffer
            for (slot, &fi) in col_buf.iter_mut().zip(col_field_indices.iter()) {
                *slot = if fi < base_field_count {
                    record.values.get(fi).copied().unwrap_or(VALUE_ID_EMPTY)
                } else {
                    let vi = fi - base_field_count;
                    self.virtual_records.get(vi)
                        .and_then(|vr| vr.get(i))
                        .copied()
                        .unwrap_or(VALUE_ID_EMPTY)
                };
            }

            // Fill value data buffer
            for (slot, &field_idx) in value_buf.iter_mut().zip(value_field_indices.iter()) {
                let value_id = record.values.get(field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                *slot = self.fields.get(field_idx).and_then(|fc| {
                    fc.get_value(value_id).and_then(|cv| match cv {
                        CacheValue::Number(n) => Some(n.0),
                        _ => None,
                    })
                });
            }

            // For each row subtotal level × each column subtotal level:
            // - Row subtotals: set trailing row positions to VALUE_ID_EMPTY (HashMap key)
            // - Column subtotals: compute flat index with VALUE_ID_EMPTY in trailing positions
            for row_level in 0..=row_count {
                // Build row subtotal key
                row_key_buf[..row_level.min(row_count)].copy_from_slice(&row_buf[..row_level.min(row_count)]);
                for j in row_level..row_count {
                    row_key_buf[j] = VALUE_ID_EMPTY;
                }

                for col_level in 0..=col_count {
                    // Compute column index with subtotal (trailing EMPTY)
                    let col_idx = if col_level == col_count {
                        // Full column key
                        col_layout.col_index(&col_buf)
                    } else {
                        // Column subtotal: first col_level values are real, rest are EMPTY
                        let mut idx = 0;
                        for ci in 0..col_count {
                            let mapped = if ci < col_level {
                                (col_buf[ci] as usize).min(col_cards[ci])
                            } else {
                                col_cards[ci] // EMPTY = subtotal slot
                            };
                            idx += mapped * col_layout.strides[ci];
                        }
                        idx
                    };

                    accumulate_at(
                        &mut self.aggregates,
                        &row_key_buf,
                        col_idx,
                        &value_buf,
                        value_count,
                        slot_len,
                    );
                }
            }
        }

        self.stats.aggregate_groups = self.aggregates.len();
        self.aggregates_dirty = false;
    }
    
    /// Updates aggregates for a single group key.
    #[allow(dead_code)]
    fn update_aggregates_for_key(
        &mut self,
        key: &GroupKey,
        record: &CacheRecord,
        value_field_indices: &[FieldIndex],
        value_count: usize,
    ) {
        let accumulators = self.aggregates
            .entry(key.clone())
            .or_insert_with(|| vec![AggregateAccumulator::new(); value_count]);
        
        for (acc_idx, &field_idx) in value_field_indices.iter().enumerate() {
            let value_id = record.values.get(field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
            
            if let Some(cache_value) = self.fields.get(field_idx).and_then(|f| f.get_value(value_id)) {
                match cache_value {
                    CacheValue::Number(n) => accumulators[acc_idx].add_number(n.0),
                    CacheValue::Empty => {} // Don't count empty
                    _ => accumulators[acc_idx].add_non_number(),
                }
            }
        }
    }
    
    /// Marks aggregates as needing recomputation.
    pub fn invalidate_aggregates(&mut self) {
        self.aggregates_dirty = true;
    }
    
    /// Returns the record count.
    pub fn record_count(&self) -> usize {
        self.records.len()
    }
    
    /// Returns the filtered record count.
    pub fn filtered_count(&self) -> usize {
        self.stats.filtered_records
    }
    
    /// Returns the number of fields (columns) in the cache.
    pub fn field_count(&self) -> usize {
        self.fields.len()
    }

    /// Returns the name of a field by index.
    pub fn field_name(&self, field_index: usize) -> Option<String> {
        self.fields.get(field_index).map(|f| f.name.clone())
    }

    /// Returns a display label for a value in a field.
    /// Uses label_map overrides (for date/number grouping) if available,
    /// otherwise formats the raw CacheValue.
    pub fn get_value_label(&self, field_index: usize, value_id: ValueId) -> Option<String> {
        let field = self.get_field(field_index)?;
        // Check label_map first (for grouped fields)
        if let Some(label) = field.label_map.get(&value_id) {
            return Some(label.clone());
        }
        // Fall back to raw value display
        let value = field.get_value(value_id)?;
        Some(match value {
            CacheValue::Empty => String::new(),
            CacheValue::Number(n) => format!("{}", n.0),
            CacheValue::Text(s) => s.clone(),
            CacheValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
            CacheValue::Error(e) => e.clone(),
        })
    }

}

impl PivotCache {
    /// Checks if a field contains primarily numeric values.
    /// Returns true if more than 50% of non-empty values are numbers.
    pub fn is_numeric_field(&self, field_index: usize) -> bool {
        if let Some(field) = self.fields.get(field_index) {
            let mut numeric_count = 0;
            let mut total_count = 0;

            for id in 0..field.unique_count() as ValueId {
                if let Some(value) = field.get_value(id) {
                    match value {
                        CacheValue::Empty => continue,
                        CacheValue::Number(_) => {
                            numeric_count += 1;
                            total_count += 1;
                        }
                        _ => total_count += 1,
                    }
                }
            }

            if total_count == 0 {
                return false;
            }

            (numeric_count as f64 / total_count as f64) > 0.5
        } else {
            false
        }
    }

    /// Clears all virtual fields and records (called before re-building grouping transforms).
    pub fn clear_virtual_fields(&mut self) {
        self.virtual_fields.clear();
        self.virtual_records.clear();
    }

    /// Adds a virtual field and returns its "virtual index" (0-based within virtual_fields).
    /// The effective field index for lookups is `self.fields.len() + virtual_index`.
    pub fn add_virtual_field(&mut self, name: String) -> usize {
        let vf_index = self.virtual_fields.len();
        let source_index = self.fields.len() + vf_index;
        self.virtual_fields.push(FieldCache::new(source_index, name));
        // Pre-allocate record mapping for this virtual field
        self.virtual_records.push(vec![VALUE_ID_EMPTY; self.records.len()]);
        vf_index
    }

    /// Sets the virtual field value for a specific record.
    pub fn set_virtual_record_value(&mut self, vf_index: usize, record_index: usize, value: CacheValue) {
        if vf_index < self.virtual_fields.len() && record_index < self.records.len() {
            let value_id = self.virtual_fields[vf_index].intern(value);
            self.virtual_records[vf_index][record_index] = value_id;
        }
    }

    /// Gets a field by effective index (source fields first, then virtual fields).
    pub fn get_field(&self, effective_index: usize) -> Option<&FieldCache> {
        if effective_index < self.fields.len() {
            self.fields.get(effective_index)
        } else {
            let vi = effective_index - self.fields.len();
            self.virtual_fields.get(vi)
        }
    }

    /// Gets a field by effective index (mutable).
    pub fn get_field_mut(&mut self, effective_index: usize) -> Option<&mut FieldCache> {
        let base_len = self.fields.len();
        if effective_index < base_len {
            self.fields.get_mut(effective_index)
        } else {
            let vi = effective_index - base_len;
            self.virtual_fields.get_mut(vi)
        }
    }

    /// Gets the ValueId for a record at an effective field index (source or virtual).
    pub fn get_record_value_id(&self, record_index: usize, effective_field_index: usize) -> ValueId {
        if effective_field_index < self.fields.len() {
            self.records.get(record_index)
                .and_then(|r| r.values.get(effective_field_index))
                .copied()
                .unwrap_or(VALUE_ID_EMPTY)
        } else {
            let vi = effective_field_index - self.fields.len();
            self.virtual_records.get(vi)
                .and_then(|vr| vr.get(record_index))
                .copied()
                .unwrap_or(VALUE_ID_EMPTY)
        }
    }
}

// ============================================================================
// DATE PARSING HELPERS
// ============================================================================

/// Parsed date components for date grouping.
#[derive(Debug, Clone, Copy)]
pub struct ParsedDate {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl ParsedDate {
    /// Returns the quarter (1-4) based on the month.
    pub fn quarter(&self) -> u32 {
        (self.month - 1) / 3 + 1
    }

    /// Returns the ISO week number (approximate, 1-53).
    pub fn week(&self) -> u32 {
        // Simple day-of-year based ISO week approximation
        let doy = self.day_of_year();
        ((doy + 6) / 7).min(53).max(1)
    }

    /// Returns the approximate day of year (1-366).
    fn day_of_year(&self) -> u32 {
        let days_before_month = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        let m = (self.month as usize).min(12).max(1) - 1;
        let mut doy = days_before_month[m] + self.day;
        // Leap year adjustment for months after February
        if self.month > 2 && is_leap_year(self.year) {
            doy += 1;
        }
        doy
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Attempts to parse a CacheValue as a date.
/// Supports:
/// - Number: Excel serial date (days since 1899-12-30)
/// - Text: ISO 8601 "YYYY-MM-DD", "YYYY/MM/DD", "MM/DD/YYYY", "DD.MM.YYYY"
pub fn parse_cache_value_as_date(value: &CacheValue) -> Option<ParsedDate> {
    match value {
        CacheValue::Number(n) => excel_serial_to_date(n.as_f64()),
        CacheValue::Text(s) => parse_date_string(s),
        _ => None,
    }
}

/// Converts an Excel serial date number to (year, month, day).
/// Excel serial date: 1 = 1900-01-01, but we handle the Lotus 1-2-3 bug
/// where 1900 is incorrectly treated as a leap year.
fn excel_serial_to_date(serial: f64) -> Option<ParsedDate> {
    let serial = serial.floor() as i64;
    if serial < 1 || serial > 2958465 {
        return None; // Out of range
    }

    // Adjust for Excel's Lotus 1-2-3 leap year bug (Feb 29, 1900 doesn't exist)
    let adjusted = if serial > 60 { serial - 1 } else { serial };

    // Convert from days-since-1900-01-01 to days-since-0001-01-01
    // 1900-01-01 is day 693596 in the proleptic Gregorian calendar
    let days = adjusted + 693595;

    // Use the algorithm to convert from days to y/m/d
    let l = days + 68569;
    let n = (4 * l) / 146097;
    let l = l - (146097 * n + 3) / 4;
    let i = (4000 * (l + 1)) / 1461001;
    let l = l - (1461 * i) / 4 + 31;
    let j = (80 * l) / 2447;
    let d = l - (2447 * j) / 80;
    let l = j / 11;
    let m = j + 2 - 12 * l;
    let y = 100 * (n - 49) + i + l;

    Some(ParsedDate {
        year: y as i32,
        month: m as u32,
        day: d as u32,
    })
}

/// Parses a date string in common formats.
fn parse_date_string(s: &str) -> Option<ParsedDate> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    // Try ISO 8601: YYYY-MM-DD or YYYY/MM/DD
    if s.len() >= 10 {
        let sep = s.as_bytes()[4];
        if sep == b'-' || sep == b'/' {
            let parts: Vec<&str> = if sep == b'-' { s.split('-').collect() } else { s.split('/').collect() };
            if parts.len() >= 3 {
                if let (Ok(y), Ok(m), Ok(d)) = (
                    parts[0].parse::<i32>(),
                    parts[1].parse::<u32>(),
                    parts[2].get(..2).unwrap_or(parts[2]).parse::<u32>(),
                ) {
                    if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
                        return Some(ParsedDate { year: y, month: m, day: d });
                    }
                }
            }
        }
    }

    // Try MM/DD/YYYY
    if let Some(result) = try_parse_mdy(s, '/') {
        return Some(result);
    }

    // Try DD.MM.YYYY
    if let Some(result) = try_parse_dmy(s, '.') {
        return Some(result);
    }

    None
}

fn try_parse_mdy(s: &str, sep: char) -> Option<ParsedDate> {
    let parts: Vec<&str> = s.split(sep).collect();
    if parts.len() >= 3 {
        if let (Ok(m), Ok(d), Ok(y)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<i32>(),
        ) {
            if m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 {
                return Some(ParsedDate { year: y, month: m, day: d });
            }
        }
    }
    None
}

fn try_parse_dmy(s: &str, sep: char) -> Option<ParsedDate> {
    let parts: Vec<&str> = s.split(sep).collect();
    if parts.len() >= 3 {
        if let (Ok(d), Ok(m), Ok(y)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<i32>(),
        ) {
            if m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 {
                return Some(ParsedDate { year: y, month: m, day: d });
            }
        }
    }
    None
}