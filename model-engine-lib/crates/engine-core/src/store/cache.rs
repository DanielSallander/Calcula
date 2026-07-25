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
    /// When `true`, the entry is treated as stale by every staleness check
    /// regardless of `last_refreshed`. Set when an entry is restored with an
    /// age too large to represent as an `Instant` offset (e.g. a corrupted
    /// or hostile `age_ms` in a disk-cache metadata file). Cleared by the
    /// next successful [`InMemoryCache::store`].
    force_stale: bool,
    /// Last-seen results of `SourceQuery` polls, keyed per strategy by
    /// [`InMemoryCache::source_query_key`]. Used to detect changes: if the
    /// next poll of a strategy returns a different value than the one stored
    /// under its key, the table should be refreshed. Keying per strategy
    /// prevents multiple `SourceQuery` strategies on one table from
    /// overwriting each other's last-seen values (refresh ping-pong).
    fingerprints: HashMap<u64, String>,
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
        self.store_inner(table_name, batch, Instant::now(), false)
    }

    /// Store (or replace) cached data with a specific age.
    ///
    /// Like [`store`](Self::store), but sets the `last_refreshed` timestamp to
    /// `age` in the past. This is used when restoring cached data from disk
    /// so that TTL-based staleness checks remain accurate.
    ///
    /// If `age` is too large to represent as an `Instant` offset (the value
    /// may come from an untrusted metadata file), the entry is stored anyway
    /// and marked **maximally stale**: every staleness check
    /// ([`is_stale`](Self::is_stale), [`should_refresh`](Self::should_refresh))
    /// reports it as needing a refresh until the next [`store`](Self::store).
    pub fn store_with_age(
        &mut self,
        table_name: &str,
        batch: RecordBatch,
        age: Duration,
    ) -> EngineResult<()> {
        match Instant::now().checked_sub(age) {
            Some(last_refreshed) => self.store_inner(table_name, batch, last_refreshed, false),
            // Age exceeds the platform's monotonic epoch — treat the entry
            // as maximally stale instead of panicking.
            None => self.store_inner(table_name, batch, Instant::now(), true),
        }
    }

    /// Shared implementation of [`store`](Self::store) and
    /// [`store_with_age`](Self::store_with_age): budget check, fingerprint
    /// preservation, and entry insertion.
    fn store_inner(
        &mut self,
        table_name: &str,
        batch: RecordBatch,
        last_refreshed: Instant,
        force_stale: bool,
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
        // Preserve existing fingerprints when replacing.
        let fingerprints = self
            .entries
            .get(table_name)
            .map(|e| e.fingerprints.clone())
            .unwrap_or_default();
        self.entries.insert(
            table_name.to_string(),
            CacheEntry {
                batch,
                last_refreshed,
                size_bytes: new_size,
                force_stale,
                fingerprints,
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

    /// Returns `true` if the table is not cached, its cache is older than
    /// `max_age`, or it was restored in a maximally-stale state (see
    /// [`store_with_age`](Self::store_with_age)).
    pub fn is_stale(&self, table_name: &str, max_age: Duration) -> bool {
        match self.entries.get(table_name) {
            Some(entry) => entry.force_stale || entry.last_refreshed.elapsed() > max_age,
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

    /// Compute the fingerprint key for a `SourceQuery` strategy's SQL text.
    ///
    /// Fingerprints are stored per strategy so that multiple `SourceQuery`
    /// strategies on one table do not overwrite each other's last-seen
    /// values (which would cause perpetual refresh ping-pong).
    ///
    /// The key is a hash of the SQL text computed with the standard
    /// library's `DefaultHasher` seeded with its default (fixed) keys, so it
    /// is deterministic within a build. **Stability caveat:** the algorithm
    /// is not formally guaranteed to stay identical across Rust releases. If
    /// it ever changes, persisted keys stop matching and the affected tables
    /// are simply refreshed once more on the next poll — a safe degradation.
    pub fn source_query_key(sql: &str) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        sql.hash(&mut hasher);
        hasher.finish()
    }

    /// Returns the stored fingerprint for the given table and strategy key,
    /// if any.
    ///
    /// The fingerprint is the last-seen result of a [`SourceQuery`] poll for
    /// the strategy identified by `strategy_key` (see
    /// [`source_query_key`](Self::source_query_key)).
    pub fn fingerprint(&self, table_name: &str, strategy_key: u64) -> Option<&str> {
        self.entries
            .get(table_name)
            .and_then(|e| e.fingerprints.get(&strategy_key))
            .map(|s| s.as_str())
    }

    /// Returns all stored fingerprints for a cached table, keyed by strategy
    /// key. Returns `None` if the table is not cached.
    pub fn fingerprints(&self, table_name: &str) -> Option<&HashMap<u64, String>> {
        self.entries.get(table_name).map(|e| &e.fingerprints)
    }

    /// Set (or update) the fingerprint for a cached table under the given
    /// strategy key (see [`source_query_key`](Self::source_query_key)).
    ///
    /// Does nothing if the table is not cached.
    pub fn set_fingerprint(&mut self, table_name: &str, strategy_key: u64, fingerprint: String) {
        if let Some(entry) = self.entries.get_mut(table_name) {
            entry.fingerprints.insert(strategy_key, fingerprint);
        }
    }

    /// Returns `true` if the table was restored in a maximally-stale state
    /// (see [`store_with_age`](Self::store_with_age)). Returns `false` for
    /// uncached tables.
    pub fn is_force_stale(&self, table_name: &str) -> bool {
        self.entries.get(table_name).is_some_and(|e| e.force_stale)
    }

    /// Evaluate a set of refresh strategies and return `true` if the table
    /// should be refreshed.
    ///
    /// Returns `true` if the table is not yet cached, if the entry was
    /// restored in a maximally-stale state (see
    /// [`store_with_age`](Self::store_with_age)), or if **any** of the
    /// strategies signals staleness. If `strategies` is empty, returns `false`
    /// for cached tables (manual refresh only) unless the entry is
    /// maximally stale.
    pub fn should_refresh(&self, table_name: &str, strategies: &[RefreshStrategy]) -> bool {
        let entry = match self.entries.get(table_name) {
            Some(e) => e,
            None => return true, // Not cached → always refresh.
        };

        if entry.force_stale {
            return true;
        }

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
            !batch_contains_date(&entry.batch, column, local_today_as_days_since_epoch())
        }
        RefreshStrategy::DailyAfter { hour, minute } => is_past_daily_threshold_at(
            entry.last_refreshed.elapsed(),
            chrono::Local::now(),
            *hour,
            *minute,
        ),
        RefreshStrategy::SourceQuery { .. } => false, // Evaluated by Engine.
    }
}

/// Check whether a `Date32` column in the batch contains the given date
/// (expressed as days since the Unix epoch).
///
/// Returns `false` if the column is not found, is not a Date32 column,
/// or does not contain the date value.
fn batch_contains_date(batch: &RecordBatch, column_name: &str, date_days: i32) -> bool {
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

    (0..array.len()).any(|i| !array.is_null(i) && array.value(i) == date_days)
}

/// Get today's date **in local time** as days since the Unix epoch
/// (1970-01-01). `Date32` values are calendar dates, so "today" must be
/// evaluated in the local calendar, not the UTC one.
fn local_today_as_days_since_epoch() -> i32 {
    // `NaiveDate::default()` is 1970-01-01, the Unix epoch.
    let epoch = chrono::NaiveDate::default();
    let days = chrono::Local::now()
        .date_naive()
        .signed_duration_since(epoch)
        .num_days();
    // Date32 range is i32; clamp instead of truncating for far-future clocks.
    days.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// Check whether an entry refreshed `age` ago was last refreshed before the
/// most recent occurrence of the `hour:minute` wall-clock threshold, where
/// "now" and the threshold are evaluated in the timezone of `now`.
///
/// This is the pure core of [`RefreshStrategy::DailyAfter`] evaluation: the
/// production caller passes `chrono::Local::now()` (the strategy is
/// documented as local time); tests inject a fixed-offset `now`.
///
/// For example, with `hour=6, minute=0` and `now` at 08:00, returns `true`
/// if the entry was last refreshed before 06:00 today. With `now` at 05:00,
/// the threshold is yesterday's 06:00.
///
/// Out-of-range `hour`/`minute` (from unvalidated model files) are clamped
/// to 23:59. DST-ambiguous threshold times resolve to their earliest
/// mapping; if a threshold falls in a DST gap, yesterday's occurrence is
/// used (conservatively triggering a refresh at most once).
fn is_past_daily_threshold_at<Tz: chrono::TimeZone>(
    age: Duration,
    now: chrono::DateTime<Tz>,
    hour: u8,
    minute: u8,
) -> bool {
    use chrono::{Duration as ChronoDuration, NaiveTime};

    // Hour/minute may come from an unvalidated model file — clamp
    // defensively. `RefreshStrategy::validate()` reports such values.
    let threshold_time =
        match NaiveTime::from_hms_opt(u32::from(hour.min(23)), u32::from(minute.min(59)), 0) {
            Some(t) => t,
            // Unreachable after clamping, but never panic in library code.
            None => return false,
        };

    let tz = now.timezone();
    let today = now.date_naive();

    // Today's occurrence of the threshold in the target timezone.
    let today_threshold = tz
        .from_local_datetime(&today.and_time(threshold_time))
        .earliest();

    // The most recent threshold at or before `now`: today's if already
    // passed, otherwise yesterday's.
    let threshold = match today_threshold {
        Some(t) if now >= t => Some(t),
        _ => today.pred_opt().and_then(|y| {
            tz.from_local_datetime(&y.and_time(threshold_time))
                .earliest()
        }),
    };
    let threshold = match threshold {
        Some(t) => t,
        None => return false, // No resolvable threshold — don't force refresh.
    };

    // When the entry was refreshed. Ages too large to represent are far
    // older than any daily threshold → stale.
    let age = match ChronoDuration::from_std(age) {
        Ok(d) => d,
        Err(_) => return true,
    };
    match now.checked_sub_signed(age) {
        Some(refreshed_at) => refreshed_at < threshold,
        None => true,
    }
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

        let today = super::local_today_as_days_since_epoch();
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

        let today = super::local_today_as_days_since_epoch();
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
        let key = InMemoryCache::source_query_key("SELECT 1");
        assert!(cache.fingerprint("t", key).is_none());
        assert!(cache.fingerprints("t").unwrap().is_empty());
    }

    #[test]
    fn set_and_get_fingerprint() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();

        let key = InMemoryCache::source_query_key("SELECT MAX(loaded_at) FROM log");
        cache.set_fingerprint("t", key, "2026-04-30T12:00:00".to_string());
        assert_eq!(cache.fingerprint("t", key), Some("2026-04-30T12:00:00"));
    }

    #[test]
    fn fingerprint_preserved_on_store_replace() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();
        let key = InMemoryCache::source_query_key("SELECT 1");
        cache.set_fingerprint("t", key, "v1".to_string());

        // Replace data — fingerprint should be preserved.
        cache.store("t", make_test_batch(10)).unwrap();
        assert_eq!(cache.fingerprint("t", key), Some("v1"));
    }

    #[test]
    fn fingerprint_preserved_on_store_with_age() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();
        let key = InMemoryCache::source_query_key("SELECT 1");
        cache.set_fingerprint("t", key, "v1".to_string());

        // Replace with age — fingerprint should be preserved.
        cache
            .store_with_age("t", make_test_batch(10), Duration::from_secs(60))
            .unwrap();
        assert_eq!(cache.fingerprint("t", key), Some("v1"));
    }

    #[test]
    fn fingerprint_none_for_uncached() {
        let cache = InMemoryCache::new();
        let key = InMemoryCache::source_query_key("SELECT 1");
        assert!(cache.fingerprint("missing", key).is_none());
        assert!(cache.fingerprints("missing").is_none());
    }

    #[test]
    fn set_fingerprint_noop_for_uncached() {
        let mut cache = InMemoryCache::new();
        let key = InMemoryCache::source_query_key("SELECT 1");
        cache.set_fingerprint("missing", key, "value".to_string());
        // Should not panic or create an entry.
        assert!(!cache.contains("missing"));
    }

    #[test]
    fn source_query_key_is_deterministic_and_distinct() {
        assert_eq!(
            InMemoryCache::source_query_key("SELECT 1"),
            InMemoryCache::source_query_key("SELECT 1")
        );
        assert_ne!(
            InMemoryCache::source_query_key("SELECT 1"),
            InMemoryCache::source_query_key("SELECT 2")
        );
    }

    #[test]
    fn per_strategy_fingerprints_are_independent() {
        let mut cache = InMemoryCache::new();
        cache.store("t", make_test_batch(5)).unwrap();

        let key_a = InMemoryCache::source_query_key("SELECT MAX(a) FROM log");
        let key_b = InMemoryCache::source_query_key("SELECT MAX(b) FROM log");
        assert_ne!(key_a, key_b);

        cache.set_fingerprint("t", key_a, "fp-a".to_string());
        cache.set_fingerprint("t", key_b, "fp-b".to_string());

        // Each strategy sees its own last value — no ping-pong overwrites.
        assert_eq!(cache.fingerprint("t", key_a), Some("fp-a"));
        assert_eq!(cache.fingerprint("t", key_b), Some("fp-b"));

        // Updating one key leaves the other untouched.
        cache.set_fingerprint("t", key_a, "fp-a2".to_string());
        assert_eq!(cache.fingerprint("t", key_a), Some("fp-a2"));
        assert_eq!(cache.fingerprint("t", key_b), Some("fp-b"));
        assert_eq!(cache.fingerprints("t").unwrap().len(), 2);
    }

    #[test]
    fn store_with_age_huge_age_does_not_panic_and_is_stale() {
        let mut cache = InMemoryCache::new();
        // u64::MAX milliseconds vastly exceeds the monotonic epoch — the old
        // implementation panicked here.
        cache
            .store_with_age("t", make_test_batch(5), Duration::from_millis(u64::MAX))
            .unwrap();

        assert!(cache.is_force_stale("t"));
        // Stale regardless of how generous the max_age is.
        assert!(cache.is_stale("t", Duration::from_secs(u64::MAX / 2)));
        // Stale even with no strategies (would normally mean manual-only).
        assert!(cache.should_refresh("t", &[]));
        let strategies = vec![RefreshStrategy::Interval { secs: u64::MAX / 2 }];
        assert!(cache.should_refresh("t", &strategies));

        // A normal store (i.e. a successful refresh) clears the flag.
        cache.store("t", make_test_batch(5)).unwrap();
        assert!(!cache.is_force_stale("t"));
        assert!(!cache.is_stale("t", Duration::from_secs(60)));
        assert!(!cache.should_refresh("t", &[]));
    }

    // -- DailyAfter local-time evaluation (pure function, injected `now`) --

    fn local_time(hour: u32, minute: u32) -> chrono::DateTime<chrono::FixedOffset> {
        use chrono::TimeZone;
        chrono::FixedOffset::east_opt(2 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 6, 12, hour, minute, 0)
            .unwrap()
    }

    #[test]
    fn daily_after_fresh_when_refreshed_after_todays_threshold() {
        // Now 08:00 local, threshold 06:00, refreshed 07:00 → no refresh.
        assert!(!is_past_daily_threshold_at(
            Duration::from_secs(3600),
            local_time(8, 0),
            6,
            0
        ));
    }

    #[test]
    fn daily_after_stale_when_refreshed_before_todays_threshold() {
        // Now 08:00 local, threshold 06:00, refreshed 05:00 → refresh.
        assert!(is_past_daily_threshold_at(
            Duration::from_secs(3 * 3600),
            local_time(8, 0),
            6,
            0
        ));
    }

    #[test]
    fn daily_after_uses_yesterdays_threshold_before_todays() {
        // Now 05:00 (before 06:00) → threshold is yesterday's 06:00.
        // Refreshed 04:30 today (after yesterday 06:00) → no refresh.
        assert!(!is_past_daily_threshold_at(
            Duration::from_secs(30 * 60),
            local_time(5, 0),
            6,
            0
        ));
        // Refreshed 25h ago (04:00 yesterday, before yesterday's 06:00) → refresh.
        assert!(is_past_daily_threshold_at(
            Duration::from_secs(25 * 3600),
            local_time(5, 0),
            6,
            0
        ));
    }

    #[test]
    fn daily_after_clamps_out_of_range_hour_minute() {
        // hour 200 / minute 200 clamp to 23:59 — must not panic.
        // Now 23:59, refreshed 10 minutes ago (23:49, before 23:59) → refresh.
        assert!(is_past_daily_threshold_at(
            Duration::from_secs(600),
            local_time(23, 59),
            200,
            200
        ));
    }

    #[test]
    fn daily_after_huge_age_is_stale_without_panic() {
        assert!(is_past_daily_threshold_at(
            Duration::from_millis(u64::MAX),
            local_time(12, 0),
            6,
            0
        ));
    }
}
