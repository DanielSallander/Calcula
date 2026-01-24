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

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::cell::CellValue;
use crate::pivot::definition::{AggregationType, FieldIndex, PivotId};

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
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GroupKey {
    /// ValueIds for each field in the grouping (row fields then column fields).
    /// A VALUE_ID_EMPTY indicates "all values" (for subtotals/grand totals).
    pub values: Vec<ValueId>,
}

impl GroupKey {
    pub fn new(values: Vec<ValueId>) -> Self {
        GroupKey { values }
    }
    
    /// Creates a key for the grand total (all fields are "all values").
    pub fn grand_total(field_count: usize) -> Self {
        GroupKey {
            values: vec![VALUE_ID_EMPTY; field_count],
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

/// The main pivot cache structure.
/// Designed for 1M+ row performance with O(1) lookups after initial build.
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
    
    /// Pre-computed aggregates keyed by GroupKey.
    /// The Vec contains one accumulator per value field.
    aggregates: HashMap<GroupKey, Vec<AggregateAccumulator>>,
    
    /// Whether aggregates need recomputation.
    aggregates_dirty: bool,
    
    /// Bitmap of which records pass the current filters.
    /// Length = records.len(), true = included.
    pub filter_mask: Vec<bool>,
    
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
            aggregates: HashMap::new(),
            aggregates_dirty: true,
            filter_mask: Vec::new(),
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
    
    /// Returns an iterator over filtered records.
    pub fn filtered_records(&self) -> impl Iterator<Item = &CacheRecord> {
        self.records
            .iter()
            .zip(self.filter_mask.iter())
            .filter_map(|(record, &included)| if included { Some(record) } else { None })
    }
    
    /// Gets or computes the aggregate for a group key.
    pub fn get_aggregate(
        &mut self,
        group_key: &GroupKey,
        row_field_indices: &[FieldIndex],
        col_field_indices: &[FieldIndex],
        value_field_indices: &[FieldIndex],
    ) -> Option<&Vec<AggregateAccumulator>> {
        // Check if we need to recompute
        if self.aggregates_dirty || !self.aggregates.contains_key(group_key) {
            self.compute_aggregates(row_field_indices, col_field_indices, value_field_indices);
        }
        
        self.aggregates.get(group_key)
    }
    
    /// Computes all aggregates for the current field configuration.
    fn compute_aggregates(
        &mut self,
        row_field_indices: &[FieldIndex],
        col_field_indices: &[FieldIndex],
        value_field_indices: &[FieldIndex],
    ) {
        self.aggregates.clear();
        
        let all_group_fields: Vec<FieldIndex> = row_field_indices
            .iter()
            .chain(col_field_indices.iter())
            .copied()
            .collect();
        
        let value_count = value_field_indices.len();
        
        // First pass: collect all the data we need from records
        // This avoids borrowing self mutably while iterating
        let mut updates: Vec<(GroupKey, usize, Option<f64>)> = Vec::new();
        
        for (i, record) in self.records.iter().enumerate() {
            if !self.filter_mask[i] {
                continue;
            }
            
            // Build the full group key
            let group_values: Vec<ValueId> = all_group_fields
                .iter()
                .map(|&fi| record.values.get(fi).copied().unwrap_or(VALUE_ID_EMPTY))
                .collect();
            
            // Collect value field data
            let mut value_data: Vec<Option<f64>> = Vec::with_capacity(value_field_indices.len());
            for &field_idx in value_field_indices {
                let value_id = record.values.get(field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                let numeric_value = if let Some(field_cache) = self.fields.get(field_idx) {
                    if let Some(cache_value) = field_cache.get_value(value_id) {
                        match cache_value {
                            CacheValue::Number(n) => Some(n.0),
                            CacheValue::Empty => None,
                            _ => None, // Non-numeric treated as non-number
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                value_data.push(numeric_value);
            }
            
            // Generate all keys we need to update
            let full_key = GroupKey::new(group_values.clone());
            
            // Store updates for full key
            for (acc_idx, &numeric_value) in value_data.iter().enumerate() {
                updates.push((full_key.clone(), acc_idx, numeric_value));
            }
            
            // Store updates for subtotals at each level
            for level in 0..all_group_fields.len() {
                let subtotal_key = full_key.subtotal_at_level(level);
                for (acc_idx, &numeric_value) in value_data.iter().enumerate() {
                    updates.push((subtotal_key.clone(), acc_idx, numeric_value));
                }
            }
            
            // Store updates for grand total
            let grand_total_key = GroupKey::grand_total(all_group_fields.len());
            for (acc_idx, &numeric_value) in value_data.iter().enumerate() {
                updates.push((grand_total_key.clone(), acc_idx, numeric_value));
            }
        }
        
        // Second pass: apply all updates
        for (key, acc_idx, numeric_value) in updates {
            let accumulators = self.aggregates
                .entry(key)
                .or_insert_with(|| vec![AggregateAccumulator::new(); value_count]);
            
            if let Some(n) = numeric_value {
                accumulators[acc_idx].add_number(n);
            }
            // Note: we skip add_non_number for None values to match original behavior
        }
        
        self.stats.aggregate_groups = self.aggregates.len();
        self.aggregates_dirty = false;
    }
    
    /// Updates aggregates for a single group key.
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
}