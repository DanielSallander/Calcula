//! In-memory cache for pre-loaded table data.
//!
//! Holds Arrow `RecordBatch` data for tables configured with
//! [`StorageMode::InMemory`](crate::model::StorageMode::InMemory).
//! The cache is I/O-free — data loading is performed by the host
//! application or the `Engine` facade; this module only stores and
//! serves the cached batches.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use arrow::record_batch::RecordBatch;

use crate::error::{EngineError, EngineResult};

/// Default memory budget: 256 MB.
const DEFAULT_MEMORY_BUDGET: usize = 256 * 1024 * 1024;

/// A single cached table entry.
#[derive(Debug)]
struct CacheEntry {
    /// The cached data as a single Arrow `RecordBatch`.
    batch: RecordBatch,
    /// When this entry was last refreshed.
    last_refreshed: Instant,
    /// Size in bytes of the Arrow data.
    size_bytes: usize,
}

/// In-memory cache holding Arrow `RecordBatch` data for `InMemory`-mode tables.
///
/// The cache tracks total memory usage and enforces a configurable budget.
/// Data is stored per table as a single `RecordBatch`.
///
/// # Examples
///
/// ```
/// use engine_core::store::InMemoryCache;
///
/// let mut cache = InMemoryCache::with_budget(1024 * 1024); // 1 MB
/// assert_eq!(cache.budget_bytes(), 1024 * 1024);
/// assert_eq!(cache.total_bytes(), 0);
/// ```
#[derive(Debug)]
pub struct InMemoryCache {
    entries: HashMap<String, CacheEntry>,
    /// Total bytes currently used across all cached tables.
    total_bytes: usize,
    /// Maximum bytes allowed.
    budget_bytes: usize,
}

impl InMemoryCache {
    /// Create a new cache with the default memory budget (256 MB).
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            total_bytes: 0,
            budget_bytes: DEFAULT_MEMORY_BUDGET,
        }
    }

    /// Create a new cache with a custom memory budget in bytes.
    pub fn with_budget(budget_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            total_bytes: 0,
            budget_bytes,
        }
    }

    /// Store (or replace) cached data for a table.
    ///
    /// Returns an error if the new data would exceed the memory budget.
    pub fn store(&mut self, table_name: &str, batch: RecordBatch) -> EngineResult<()> {
        let new_size = batch_memory_size(&batch);
        let old_size = self.entries.get(table_name).map_or(0, |e| e.size_bytes);
        let projected_total = self.total_bytes - old_size + new_size;

        if projected_total > self.budget_bytes {
            return Err(EngineError::MemoryBudgetExceeded {
                needed: new_size,
                available: self
                    .budget_bytes
                    .saturating_sub(self.total_bytes - old_size),
                budget: self.budget_bytes,
            });
        }

        self.total_bytes = projected_total;
        self.entries.insert(
            table_name.to_string(),
            CacheEntry {
                batch,
                last_refreshed: Instant::now(),
                size_bytes: new_size,
            },
        );
        Ok(())
    }

    /// Get cached data for a table, if present.
    pub fn get(&self, table_name: &str) -> Option<&RecordBatch> {
        self.entries.get(table_name).map(|e| &e.batch)
    }

    /// Returns when the table was last refreshed, if cached.
    pub fn last_refreshed(&self, table_name: &str) -> Option<Instant> {
        self.entries.get(table_name).map(|e| e.last_refreshed)
    }

    /// Returns `true` if the table is not cached or its cache is older
    /// than `max_age`.
    pub fn is_stale(&self, table_name: &str, max_age: Duration) -> bool {
        match self.entries.get(table_name) {
            Some(entry) => entry.last_refreshed.elapsed() > max_age,
            None => true,
        }
    }

    /// Remove a table from the cache, reclaiming its memory.
    pub fn evict(&mut self, table_name: &str) {
        if let Some(entry) = self.entries.remove(table_name) {
            self.total_bytes -= entry.size_bytes;
        }
    }

    /// Total memory used by all cached tables in bytes.
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    /// Configured memory budget in bytes.
    pub fn budget_bytes(&self) -> usize {
        self.budget_bytes
    }

    /// Returns `true` if the given table has cached data.
    pub fn contains(&self, table_name: &str) -> bool {
        self.entries.contains_key(table_name)
    }

    /// Returns the number of cached tables.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns `true` if no tables are cached.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Default for InMemoryCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute the memory size of a `RecordBatch` in bytes.
fn batch_memory_size(batch: &RecordBatch) -> usize {
    batch
        .columns()
        .iter()
        .map(|c| c.get_array_memory_size())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::Int32Array;
    use arrow::datatypes::{DataType as ArrowDataType, Field, Schema};
    use std::sync::Arc;

    fn make_test_batch(num_rows: usize) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "id",
            ArrowDataType::Int32,
            false,
        )]));
        let values: Vec<i32> = (0..num_rows as i32).collect();
        let array = Arc::new(Int32Array::from(values));
        RecordBatch::try_new(schema, vec![array]).unwrap()
    }

    #[test]
    fn store_and_retrieve() {
        let mut cache = InMemoryCache::new();
        let batch = make_test_batch(100);
        cache.store("products", batch.clone()).unwrap();

        assert!(cache.contains("products"));
        assert_eq!(cache.len(), 1);
        assert!(!cache.is_empty());

        let cached = cache.get("products").unwrap();
        assert_eq!(cached.num_rows(), 100);
    }

    #[test]
    fn store_replaces_existing() {
        let mut cache = InMemoryCache::new();
        cache.store("products", make_test_batch(100)).unwrap();
        let size_after_first = cache.total_bytes();

        cache.store("products", make_test_batch(200)).unwrap();
        assert_eq!(cache.len(), 1);
        // Size should have changed (200 rows > 100 rows).
        assert!(cache.total_bytes() > size_after_first);
    }

    #[test]
    fn budget_exceeded() {
        // Tiny budget that can't hold even a small batch.
        let mut cache = InMemoryCache::with_budget(1);
        let result = cache.store("products", make_test_batch(100));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, EngineError::MemoryBudgetExceeded { .. }),
            "Expected MemoryBudgetExceeded, got: {err:?}"
        );
    }

    #[test]
    fn evict_reclaims_memory() {
        let mut cache = InMemoryCache::new();
        cache.store("products", make_test_batch(100)).unwrap();
        assert!(cache.total_bytes() > 0);

        cache.evict("products");
        assert_eq!(cache.total_bytes(), 0);
        assert!(cache.is_empty());
        assert!(cache.get("products").is_none());
    }

    #[test]
    fn staleness_check() {
        let mut cache = InMemoryCache::new();

        // Not cached → stale.
        assert!(cache.is_stale("products", Duration::from_secs(60)));

        cache.store("products", make_test_batch(10)).unwrap();

        // Just cached → not stale with a generous max_age.
        assert!(!cache.is_stale("products", Duration::from_secs(60)));

        // Just cached → stale with zero max_age.
        assert!(cache.is_stale("products", Duration::ZERO));
    }

    #[test]
    fn last_refreshed_returns_instant() {
        let mut cache = InMemoryCache::new();
        assert!(cache.last_refreshed("products").is_none());

        cache.store("products", make_test_batch(10)).unwrap();
        let refreshed = cache.last_refreshed("products").unwrap();
        assert!(refreshed.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn budget_allows_replacement_within_limit() {
        let batch_small = make_test_batch(10);
        let _small_size = batch_memory_size(&batch_small);
        let batch_large = make_test_batch(20);
        let large_size = batch_memory_size(&batch_large);

        // Budget fits the large batch but not both.
        let mut cache = InMemoryCache::with_budget(large_size + 1);
        cache.store("products", batch_small).unwrap();

        // Replace with larger batch — old one is reclaimed first.
        cache.store("products", batch_large).unwrap();
        assert_eq!(cache.total_bytes(), large_size);
    }

    #[test]
    fn default_budget_is_256mb() {
        let cache = InMemoryCache::new();
        assert_eq!(cache.budget_bytes(), 256 * 1024 * 1024);
    }
}
