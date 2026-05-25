//! LRU query-result cache with TTL-based expiry.
//!
//! Caches `Vec<RecordBatch>` results keyed by a hash of the query request
//! and model fingerprint. When the same query is re-executed within the TTL,
//! the cached result is returned without touching any data source.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use arrow::array::Array;
use arrow::record_batch::RecordBatch;

use engine_connectors::traits::FilterCondition;
use engine_query::request::{ColumnRef, LookupColumn, QueryRequest};

/// Configuration for the query-result cache.
#[derive(Debug, Clone)]
pub struct QueryCacheConfig {
    /// Enable or disable query caching. Default: `false`.
    pub enabled: bool,
    /// Maximum number of cached query results. Default: 256.
    pub max_entries: usize,
    /// Maximum total memory (bytes) for cached results. Default: 64 MB.
    pub max_memory_bytes: usize,
    /// Time-to-live in seconds for cached entries. Default: 300 (5 min).
    pub ttl_secs: u64,
}

impl Default for QueryCacheConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_entries: 256,
            max_memory_bytes: 64 * 1024 * 1024,
            ttl_secs: 300,
        }
    }
}

/// Cache statistics for monitoring.
#[derive(Debug, Clone, Default)]
pub struct QueryCacheStats {
    /// Number of cache hits (query served from cache).
    pub hits: u64,
    /// Number of cache misses (query executed against source).
    pub misses: u64,
    /// Current number of cached entries.
    pub entries: usize,
    /// Current memory usage in bytes.
    pub memory_bytes: usize,
    /// Number of entries evicted due to LRU policy.
    pub evictions: u64,
}

impl QueryCacheStats {
    /// Hit ratio as a fraction (0.0–1.0). Returns 0.0 if no lookups yet.
    pub fn hit_ratio(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 {
            0.0
        } else {
            self.hits as f64 / total as f64
        }
    }
}

/// A single cached query result.
struct CacheEntry {
    batches: Vec<RecordBatch>,
    created: Instant,
    last_accessed: Instant,
    size_bytes: usize,
}

/// LRU query-result cache.
pub(crate) struct QueryCache {
    entries: HashMap<u64, CacheEntry>,
    config: QueryCacheConfig,
    total_bytes: usize,
    stats: QueryCacheStats,
    /// Monotonically increasing model version. Bumped on `set_model()` or
    /// data refresh. All entries are invalidated when this changes.
    model_version: u64,
}

impl QueryCache {
    pub fn new(config: QueryCacheConfig) -> Self {
        Self {
            entries: HashMap::new(),
            config,
            total_bytes: 0,
            stats: QueryCacheStats::default(),
            model_version: 0,
        }
    }

    /// Look up a cached result by query hash.
    ///
    /// Returns `None` if not found, expired, or cache is disabled.
    pub fn get(&mut self, key: u64) -> Option<Vec<RecordBatch>> {
        if !self.config.enabled {
            self.stats.misses += 1;
            return None;
        }

        let ttl = Duration::from_secs(self.config.ttl_secs);

        if let Some(entry) = self.entries.get_mut(&key) {
            if entry.created.elapsed() <= ttl {
                entry.last_accessed = Instant::now();
                self.stats.hits += 1;
                return Some(entry.batches.clone());
            }
            // Expired — remove it.
            let size = entry.size_bytes;
            self.entries.remove(&key);
            self.total_bytes -= size;
        }

        self.stats.misses += 1;
        None
    }

    /// Store a query result in the cache.
    ///
    /// Evicts LRU entries if the cache exceeds its entry count or memory limit.
    pub fn put(&mut self, key: u64, batches: Vec<RecordBatch>) {
        if !self.config.enabled {
            return;
        }

        let size = batch_list_size(&batches);

        // Don't cache results larger than the entire memory budget.
        if size > self.config.max_memory_bytes {
            return;
        }

        // Remove existing entry with the same key (update).
        if let Some(old) = self.entries.remove(&key) {
            self.total_bytes -= old.size_bytes;
        }

        // Evict until we have room.
        while self.entries.len() >= self.config.max_entries
            || self.total_bytes + size > self.config.max_memory_bytes
        {
            if !self.evict_lru() {
                break; // Cache is empty, nothing to evict.
            }
        }

        let now = Instant::now();
        self.entries.insert(
            key,
            CacheEntry {
                batches,
                created: now,
                last_accessed: now,
                size_bytes: size,
            },
        );
        self.total_bytes += size;
        self.stats.entries = self.entries.len();
        self.stats.memory_bytes = self.total_bytes;
    }

    /// Invalidate all cached entries (e.g., on model change or data refresh).
    pub fn invalidate_all(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
        self.model_version += 1;
        self.stats.entries = 0;
        self.stats.memory_bytes = 0;
    }

    /// Returns the current model version (for including in cache keys).
    pub fn model_version(&self) -> u64 {
        self.model_version
    }

    /// Returns cache statistics.
    pub fn stats(&self) -> QueryCacheStats {
        let mut s = self.stats.clone();
        s.entries = self.entries.len();
        s.memory_bytes = self.total_bytes;
        s
    }

    /// Update the configuration. Invalidates the cache if settings change
    /// in a way that could cause inconsistency.
    pub fn set_config(&mut self, config: QueryCacheConfig) {
        self.config = config;
        // Trim if new limits are smaller.
        self.trim();
    }

    /// Returns the current configuration.
    pub fn config(&self) -> &QueryCacheConfig {
        &self.config
    }

    /// Evict the least-recently-accessed entry. Returns `false` if empty.
    fn evict_lru(&mut self) -> bool {
        let lru_key = self
            .entries
            .iter()
            .min_by_key(|(_, e)| e.last_accessed)
            .map(|(&k, _)| k);

        if let Some(key) = lru_key {
            if let Some(entry) = self.entries.remove(&key) {
                self.total_bytes -= entry.size_bytes;
                self.stats.evictions += 1;
            }
            true
        } else {
            false
        }
    }

    /// Trim the cache to fit current limits.
    fn trim(&mut self) {
        while self.entries.len() > self.config.max_entries
            || self.total_bytes > self.config.max_memory_bytes
        {
            if !self.evict_lru() {
                break;
            }
        }
    }
}

/// Compute total memory size of a list of RecordBatches.
fn batch_list_size(batches: &[RecordBatch]) -> usize {
    batches
        .iter()
        .flat_map(|b| b.columns().iter())
        .map(|c| c.get_array_memory_size())
        .sum()
}

// --- Query hashing ---

/// Compute a deterministic cache key for a query request + model version.
///
/// The key incorporates all fields that affect query results: measures,
/// group_by, filters, lookups, and the model version (which changes on
/// model edits and data refreshes).
pub(crate) fn query_cache_key(request: &QueryRequest, model_version: u64) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();

    model_version.hash(&mut hasher);

    // Measures (order matters).
    request.measures.len().hash(&mut hasher);
    for m in &request.measures {
        m.hash(&mut hasher);
    }

    // Group by (order matters).
    request.group_by.len().hash(&mut hasher);
    for col in &request.group_by {
        hash_column_ref(col, &mut hasher);
    }

    // Filters (order matters — same filters in different order = same query,
    // but we accept this as a minor inefficiency for simplicity).
    request.filters.len().hash(&mut hasher);
    for f in &request.filters {
        hash_filter_condition(f, &mut hasher);
    }

    // Lookups (order matters).
    request.lookups.len().hash(&mut hasher);
    for l in &request.lookups {
        hash_lookup_column(l, &mut hasher);
    }

    hasher.finish()
}

fn hash_column_ref(col: &ColumnRef, hasher: &mut impl Hasher) {
    col.table.hash(hasher);
    col.column.hash(hasher);
}

fn hash_filter_condition(f: &FilterCondition, hasher: &mut impl Hasher) {
    f.column.hash(hasher);
    f.operator.as_sql().hash(hasher);
    f.value.hash(hasher);
}

fn hash_lookup_column(l: &LookupColumn, hasher: &mut impl Hasher) {
    l.table.hash(hasher);
    l.column.hash(hasher);
    l.key_column.hash(hasher);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config() -> QueryCacheConfig {
        QueryCacheConfig {
            enabled: true,
            max_entries: 4,
            max_memory_bytes: 1024 * 1024,
            ttl_secs: 60,
        }
    }

    fn make_batches(num_rows: usize) -> Vec<RecordBatch> {
        use arrow::array::Int32Array;
        use arrow::datatypes::{DataType, Field, Schema};
        use std::sync::Arc;

        let schema = Arc::new(Schema::new(vec![Field::new("x", DataType::Int32, false)]));
        let values: Vec<i32> = (0..num_rows as i32).collect();
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(Int32Array::from(values))]).unwrap();
        vec![batch]
    }

    fn make_request(measures: &[&str]) -> QueryRequest {
        QueryRequest {
            measures: measures.iter().map(|s| s.to_string()).collect(),
            group_by: Vec::new(),
            filters: Vec::new(),
            lookups: Vec::new(),
        }
    }

    #[test]
    fn put_and_get() {
        let mut cache = QueryCache::new(make_config());
        let key = 42;
        let batches = make_batches(10);

        cache.put(key, batches.clone());
        let result = cache.get(key);
        assert!(result.is_some());
        assert_eq!(result.unwrap()[0].num_rows(), 10);
    }

    #[test]
    fn get_miss_returns_none() {
        let mut cache = QueryCache::new(make_config());
        assert!(cache.get(999).is_none());
    }

    #[test]
    fn disabled_cache_always_misses() {
        let mut config = make_config();
        config.enabled = false;
        let mut cache = QueryCache::new(config);

        cache.put(1, make_batches(5));
        assert!(cache.get(1).is_none());
    }

    #[test]
    fn ttl_expiry() {
        let mut config = make_config();
        config.ttl_secs = 0; // Expire immediately.
        let mut cache = QueryCache::new(config);

        cache.put(1, make_batches(5));
        // Entry is expired (ttl=0).
        assert!(cache.get(1).is_none());
        // Should have been removed.
        assert_eq!(cache.entries.len(), 0);
    }

    #[test]
    fn lru_eviction_by_entry_count() {
        let mut cache = QueryCache::new(make_config()); // max_entries: 4

        for i in 0..4 {
            cache.put(i, make_batches(1));
        }
        assert_eq!(cache.entries.len(), 4);

        // Access key 0 to make it recently used.
        let _ = cache.get(0);

        // Insert a 5th — should evict the LRU (key 1, since 0 was just accessed).
        cache.put(100, make_batches(1));
        assert_eq!(cache.entries.len(), 4);
        assert!(cache.get(0).is_some()); // 0 was accessed, still there.
        assert!(cache.get(100).is_some()); // Newly inserted.
        assert_eq!(cache.stats().evictions, 1);
    }

    #[test]
    fn invalidate_all_clears_cache() {
        let mut cache = QueryCache::new(make_config());
        cache.put(1, make_batches(10));
        cache.put(2, make_batches(10));
        assert_eq!(cache.entries.len(), 2);

        let v1 = cache.model_version();
        cache.invalidate_all();
        assert_eq!(cache.entries.len(), 0);
        assert_eq!(cache.total_bytes, 0);
        assert_eq!(cache.model_version(), v1 + 1);
    }

    #[test]
    fn stats_tracking() {
        let mut cache = QueryCache::new(make_config());

        cache.put(1, make_batches(10));
        let _ = cache.get(1); // Hit.
        let _ = cache.get(2); // Miss.
        let _ = cache.get(1); // Hit.

        let stats = cache.stats();
        assert_eq!(stats.hits, 2);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.entries, 1);
        assert!(stats.memory_bytes > 0);
        assert!((stats.hit_ratio() - 0.6667).abs() < 0.01);
    }

    #[test]
    fn update_replaces_existing_entry() {
        let mut cache = QueryCache::new(make_config());

        cache.put(1, make_batches(10));
        let size_before = cache.total_bytes;

        cache.put(1, make_batches(20));
        // Should have one entry, not two.
        assert_eq!(cache.entries.len(), 1);
        // Size should reflect the new entry.
        assert_ne!(cache.total_bytes, size_before);
    }

    #[test]
    fn memory_budget_eviction() {
        let mut config = make_config();
        config.max_entries = 1000; // Don't limit by count.
        config.max_memory_bytes = 200; // Tiny budget.
        let mut cache = QueryCache::new(config);

        // Insert a batch that fits.
        cache.put(1, make_batches(1));

        // Insert more until budget is exceeded — should evict.
        for i in 2..20 {
            cache.put(i, make_batches(1));
        }
        assert!(cache.total_bytes <= 200);
    }

    #[test]
    fn oversized_entry_not_cached() {
        let mut config = make_config();
        config.max_memory_bytes = 10; // Tiny budget.
        let mut cache = QueryCache::new(config);

        cache.put(1, make_batches(1000)); // Way too large.
        assert_eq!(cache.entries.len(), 0);
    }

    // --- Hash tests ---

    #[test]
    fn same_request_same_hash() {
        let r1 = make_request(&["Revenue", "Profit"]);
        let r2 = make_request(&["Revenue", "Profit"]);
        assert_eq!(query_cache_key(&r1, 0), query_cache_key(&r2, 0));
    }

    #[test]
    fn different_measures_different_hash() {
        let r1 = make_request(&["Revenue"]);
        let r2 = make_request(&["Profit"]);
        assert_ne!(query_cache_key(&r1, 0), query_cache_key(&r2, 0));
    }

    #[test]
    fn measure_order_matters() {
        let r1 = make_request(&["Revenue", "Profit"]);
        let r2 = make_request(&["Profit", "Revenue"]);
        assert_ne!(query_cache_key(&r1, 0), query_cache_key(&r2, 0));
    }

    #[test]
    fn different_model_version_different_hash() {
        let r = make_request(&["Revenue"]);
        assert_ne!(query_cache_key(&r, 0), query_cache_key(&r, 1));
    }

    #[test]
    fn group_by_affects_hash() {
        let mut r1 = make_request(&["Revenue"]);
        let mut r2 = make_request(&["Revenue"]);
        r1.group_by
            .push(ColumnRef::new("products", "category"));
        // r2 has no group_by.
        assert_ne!(query_cache_key(&r1, 0), query_cache_key(&r2, 0));
    }

    #[test]
    fn filters_affect_hash() {
        let mut r1 = make_request(&["Revenue"]);
        let mut r2 = make_request(&["Revenue"]);
        r1.filters.push(FilterCondition {
            column: "region".to_string(),
            operator: engine_connectors::traits::FilterOperator::Equal,
            value: "US".to_string(),
        });
        assert_ne!(query_cache_key(&r1, 0), query_cache_key(&r2, 0));
    }

    #[test]
    fn default_config_values() {
        let config = QueryCacheConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.max_entries, 256);
        assert_eq!(config.max_memory_bytes, 64 * 1024 * 1024);
        assert_eq!(config.ttl_secs, 300);
    }
}
