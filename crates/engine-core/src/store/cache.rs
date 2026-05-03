//! In-memory cache for pre-loaded table data.
//!
//! Holds Arrow `RecordBatch` data for tables configured with
//! [`StorageMode::InMemory`](crate::model::StorageMode::InMemory).
//! The cache is I/O-free — data loading is performed by the host
//! application or the `Engine` facade; this module only stores and
//! serves the cached batches.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use arrow::array::Array;
use arrow::record_batch::RecordBatch;

use crate::error::{EngineError, EngineResult};
use crate::model::table::RefreshStrategy;

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
    /// Last-seen result of a `SourceQuery` poll, stored as a string.
    /// Used to detect changes: if the next poll returns a different value,
    /// the table should be refreshed.
    fingerprint: Option<String>,
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
        // Preserve existing fingerprint when replacing.
        let fingerprint = self
            .entries
            .get(table_name)
            .and_then(|e| e.fingerprint.clone());
        self.entries.insert(
            table_name.to_string(),
            CacheEntry {
                batch,
                last_refreshed: Instant::now(),
                size_bytes: new_size,
                fingerprint,
            },
        );
        Ok(())
    }

    /// Store (or replace) cached data with a specific age.
    ///
    /// Like [`store`](Self::store), but sets the `last_refreshed` timestamp to
    /// `age` in the past. This is used when restoring cached data from disk
    /// so that TTL-based staleness checks remain accurate.
    pub fn store_with_age(
        &mut self,
        table_name: &str,
        batch: RecordBatch,
        age: Duration,
    ) -> EngineResult<()> {
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
        let last_refreshed = Instant::now() - age;
        // Preserve existing fingerprint when replacing.
        let fingerprint = self
            .entries
            .get(table_name)
            .and_then(|e| e.fingerprint.clone());
        self.entries.insert(
            table_name.to_string(),
            CacheEntry {
                batch,
                last_refreshed,
                size_bytes: new_size,
                fingerprint,
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

    /// Returns the names of all cached tables.
    pub fn table_names(&self) -> Vec<&str> {
        self.entries.keys().map(|k| k.as_str()).collect()
    }

    /// Returns how long ago the table was last refreshed, if cached.
    pub fn age(&self, table_name: &str) -> Option<Duration> {
        self.entries
            .get(table_name)
            .map(|e| e.last_refreshed.elapsed())
    }

    /// Returns the stored fingerprint for a table, if any.
    ///
    /// The fingerprint is the last-seen result of a [`SourceQuery`] poll.
    pub fn fingerprint(&self, table_name: &str) -> Option<&str> {
        self.entries
            .get(table_name)
            .and_then(|e| e.fingerprint.as_deref())
    }

    /// Set (or update) the fingerprint for a cached table.
    ///
    /// Does nothing if the table is not cached.
    pub fn set_fingerprint(&mut self, table_name: &str, fingerprint: String) {
        if let Some(entry) = self.entries.get_mut(table_name) {
            entry.fingerprint = Some(fingerprint);
        }
    }

    /// Evaluate a set of refresh strategies and return `true` if the table
    /// should be refreshed.
    ///
    /// Returns `true` if the table is not yet cached, or if **any** of the
    /// strategies signals staleness. If `strategies` is empty, returns `false`
    /// for cached tables (manual refresh only).
    pub fn should_refresh(&self, table_name: &str, strategies: &[RefreshStrategy]) -> bool {
        let entry = match self.entries.get(table_name) {
            Some(e) => e,
            None => return true, // Not cached → always refresh.
        };

        strategies.iter().any(|s| evaluate_strategy(s, entry))
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

/// Evaluate a single refresh strategy against a cache entry.
///
/// `SourceQuery` strategies are skipped (they require I/O and are handled
/// by the `Engine` layer).
fn evaluate_strategy(strategy: &RefreshStrategy, entry: &CacheEntry) -> bool {
    match strategy {
        RefreshStrategy::Interval { secs } => {
            entry.last_refreshed.elapsed() > Duration::from_secs(*secs)
        }
        RefreshStrategy::ContainsCurrentDate { column } => {
            !batch_contains_today(&entry.batch, column)
        }
        RefreshStrategy::DailyAfter { hour, minute } => {
            is_past_daily_threshold(entry, *hour, *minute)
        }
        RefreshStrategy::SourceQuery { .. } => false, // Evaluated by Engine.
    }
}

/// Check whether a `Date32` column in the batch contains today's date.
///
/// Returns `false` if the column is not found, is not a Date32 column,
/// or does not contain today's date value.
fn batch_contains_today(batch: &RecordBatch, column_name: &str) -> bool {
    use arrow::array::Date32Array;
    use arrow::datatypes::DataType as ArrowDataType;

    let col_idx = match batch.schema().index_of(column_name) {
        Ok(idx) => idx,
        Err(_) => return false,
    };

    let schema = batch.schema();
    let field = schema.field(col_idx);
    if *field.data_type() != ArrowDataType::Date32 {
        return false;
    }

    let array = match batch.column(col_idx).as_any().downcast_ref::<Date32Array>() {
        Some(a) => a,
        None => return false,
    };

    let today = today_as_days_since_epoch();
    (0..array.len()).any(|i| !array.is_null(i) && array.value(i) == today)
}

/// Get today's date as days since the Unix epoch (1970-01-01).
fn today_as_days_since_epoch() -> i32 {
    use std::time::SystemTime;

    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    (secs / 86400) as i32
}

/// Check whether the cache entry was last refreshed before today's occurrence
/// of the specified wall-clock time.
///
/// For example, if `hour=6, minute=0` and it is currently 08:00, returns
/// `true` if the entry was last refreshed before 06:00 today. If it is
/// currently 05:00, the threshold is yesterday's 06:00.
fn is_past_daily_threshold(entry: &CacheEntry, hour: u8, minute: u8) -> bool {
    use std::time::SystemTime;

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Current day's midnight in UTC.
    let today_midnight = (now / 86400) * 86400;
    let threshold_today = today_midnight + (hour as u64) * 3600 + (minute as u64) * 60;

    // The most recent threshold: today's if we've passed it, yesterday's if not.
    let threshold = if now >= threshold_today {
        threshold_today
    } else {
        threshold_today.saturating_sub(86400)
    };

    // Convert entry's last_refreshed (Instant) to an approximate epoch.
    // Instant is monotonic but we can approximate by comparing with now.
    let age_secs = entry.last_refreshed.elapsed().as_secs();
    let refreshed_epoch = now.saturating_sub(age_secs);

    refreshed_epoch < threshold
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

    #[test]
    fn store_with_age_sets_past_timestamp() {
        let mut cache = InMemoryCache::new();
        let age = Duration::from_secs(120);
        cache
            .store_with_age("products", make_test_batch(10), age)
            .unwrap();

        // The entry should report as ~120s old.
        let entry_age = cache.age("products").unwrap();
        assert!(entry_age >= Duration::from_secs(119));

        // Should be stale with a 60s max_age.
        assert!(cache.is_stale("products", Duration::from_secs(60)));
        // Should not be stale with a 300s max_age.
        assert!(!cache.is_stale("products", Duration::from_secs(300)));
    }

    #[test]
    fn store_with_age_respects_budget() {
        let mut cache = InMemoryCache::with_budget(1);
        let result = cache.store_with_age("products", make_test_batch(100), Duration::ZERO);
        assert!(matches!(
            result.unwrap_err(),
            EngineError::MemoryBudgetExceeded { .. }
        ));
    }

    #[test]
    fn table_names_returns_cached_tables() {
        let mut cache = InMemoryCache::new();
        cache.store("alpha", make_test_batch(5)).unwrap();
        cache.store("beta", make_test_batch(5)).unwrap();

        let mut names = cache.table_names();
        names.sort();
        assert_eq!(names, vec!["alpha", "beta"]);
    }

    #[test]
    fn age_returns_none_for_uncached() {
        let cache = InMemoryCache::new();
        assert!(cache.age("missing").is_none());
    }

    #[test]
    fn age_returns_elapsed_duration() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();
        let age = cache.age("t").unwrap();
        assert!(age < Duration::from_secs(1));
    }

    #[test]
    fn should_refresh_uncached_returns_true() {
        let cache = InMemoryCache::new();
        assert!(cache.should_refresh("missing", &[]));
    }

    #[test]
    fn should_refresh_no_strategies_returns_false() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();
        // No strategies → manual refresh only → not stale.
        assert!(!cache.should_refresh("t", &[]));
    }

    #[test]
    fn should_refresh_interval_fresh() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();
        let strategies = vec![RefreshStrategy::Interval { secs: 300 }];
        assert!(!cache.should_refresh("t", &strategies));
    }

    #[test]
    fn should_refresh_interval_stale() {
        let mut cache = InMemoryCache::new();
        cache
            .store_with_age("t", make_test_batch(5), Duration::from_secs(600))
            .unwrap();
        let strategies = vec![RefreshStrategy::Interval { secs: 300 }];
        assert!(cache.should_refresh("t", &strategies));
    }

    #[test]
    fn should_refresh_contains_date_with_today() {
        use arrow::array::Date32Array;
        use arrow::datatypes::DataType as ArrowDataType;

        let today = super::today_as_days_since_epoch();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "date",
            ArrowDataType::Date32,
            false,
        )]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(Date32Array::from(vec![
                today - 1,
                today,
                today + 1,
            ]))],
        )
        .unwrap();

        let mut cache = InMemoryCache::new();
        cache.store("t", batch).unwrap();

        let strategies = vec![RefreshStrategy::ContainsCurrentDate {
            column: "date".to_string(),
        }];
        // Contains today → no refresh needed.
        assert!(!cache.should_refresh("t", &strategies));
    }

    #[test]
    fn should_refresh_contains_date_without_today() {
        use arrow::array::Date32Array;
        use arrow::datatypes::DataType as ArrowDataType;

        let today = super::today_as_days_since_epoch();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "date",
            ArrowDataType::Date32,
            false,
        )]));
        // Only yesterday — today is missing.
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(Date32Array::from(vec![today - 2, today - 1]))],
        )
        .unwrap();

        let mut cache = InMemoryCache::new();
        cache.store("t", batch).unwrap();

        let strategies = vec![RefreshStrategy::ContainsCurrentDate {
            column: "date".to_string(),
        }];
        // Does not contain today → needs refresh.
        assert!(cache.should_refresh("t", &strategies));
    }

    #[test]
    fn should_refresh_contains_date_wrong_column() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();

        let strategies = vec![RefreshStrategy::ContainsCurrentDate {
            column: "nonexistent".to_string(),
        }];
        // Column not found → can't confirm today → needs refresh.
        assert!(cache.should_refresh("t", &strategies));
    }

    #[test]
    fn should_refresh_any_strategy_triggers() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();

        let strategies = vec![
            // Interval is fine (just cached).
            RefreshStrategy::Interval { secs: 300 },
            // But date column doesn't exist → triggers refresh.
            RefreshStrategy::ContainsCurrentDate {
                column: "date".to_string(),
            },
        ];
        // ANY strategy signals → refresh.
        assert!(cache.should_refresh("t", &strategies));
    }

    #[test]
    fn source_query_skipped_in_local_evaluation() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();

        // SourceQuery alone should NOT trigger refresh locally.
        let strategies = vec![RefreshStrategy::SourceQuery {
            sql: "SELECT 1".to_string(),
            source_table: None,
        }];
        assert!(!cache.should_refresh("t", &strategies));
    }

    #[test]
    fn fingerprint_default_is_none() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();
        assert!(cache.fingerprint("t").is_none());
    }

    #[test]
    fn set_and_get_fingerprint() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();

        cache.set_fingerprint("t", "2026-04-30T12:00:00".to_string());
        assert_eq!(cache.fingerprint("t"), Some("2026-04-30T12:00:00"));
    }

    #[test]
    fn fingerprint_preserved_on_store_replace() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();
        cache.set_fingerprint("t", "v1".to_string());

        // Replace data — fingerprint should be preserved.
        cache.store("t", make_test_batch(10)).unwrap();
        assert_eq!(cache.fingerprint("t"), Some("v1"));
    }

    #[test]
    fn fingerprint_preserved_on_store_with_age() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();
        cache.set_fingerprint("t", "v1".to_string());

        // Replace with age — fingerprint should be preserved.
        cache
            .store_with_age("t", make_test_batch(10), Duration::from_secs(60))
            .unwrap();
        assert_eq!(cache.fingerprint("t"), Some("v1"));
    }

    #[test]
    fn fingerprint_none_for_uncached() {
        let cache = InMemoryCache::new();
        assert!(cache.fingerprint("missing").is_none());
    }

    #[test]
    fn set_fingerprint_noop_for_uncached() {
        let mut cache = InMemoryCache::new();
        cache.set_fingerprint("missing", "value".to_string());
        // Should not panic or create an entry.
        assert!(!cache.contains("missing"));
    }
}
