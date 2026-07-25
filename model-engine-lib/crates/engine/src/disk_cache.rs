//! Disk persistence for the in-memory cache: Arrow IPC files plus a
//! `metadata.json` carrying ages, schema hashes, and fingerprints, with
//! sanitized file naming and path-containment checks.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};

use crate::{Engine, EngineError, EngineResult, InMemoryCache, RefreshStrategy};

// ---------------------------------------------------------------------------
// Disk-cache metadata
// ---------------------------------------------------------------------------

/// Schema of the disk-cache `metadata.json` written by
/// [`Engine::save_cache_to_disk`].
///
/// `saved_at_unix_ms` records the wall-clock save time so that downtime
/// between save and load counts toward each entry's age (otherwise week-old
/// data would look minutes old after a restart and defeat every TTL
/// strategy). Files written before this field existed deserialize with
/// `None` and are treated as saved at load time — i.e. the previous
/// behavior, which is the only sound interpretation available for them.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheMetadata {
    /// Wall-clock save time in milliseconds since the Unix epoch.
    #[serde(default)]
    saved_at_unix_ms: Option<u64>,
    /// Per-table cache metadata, keyed by table name.
    #[serde(default)]
    tables: BTreeMap<String, TableCacheMetadata>,
}

/// Per-table entry in the disk-cache `metadata.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TableCacheMetadata {
    /// Age of the cached data at save time, in milliseconds. `u64::MAX`
    /// marks an entry that was already maximally stale when saved.
    #[serde(default)]
    age_ms: u64,
    /// Schema hash of the table at save time (see `Table::schema_hash`).
    #[serde(default)]
    schema_hash: String,
    /// Number of rows in the saved batch (diagnostic only).
    #[serde(default)]
    row_count: u64,
    /// Legacy single-slot `SourceQuery` fingerprint written by older engine
    /// versions. Read for backward compatibility, never written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    /// Per-strategy `SourceQuery` fingerprints, keyed by the decimal string
    /// form of [`InMemoryCache::source_query_key`].
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    fingerprints: BTreeMap<String, String>,
    /// Name of the Arrow IPC file inside the cache directory, derived via
    /// [`cache_file_name`] at save time. Stored so that load uses the exact
    /// mapping instead of re-deriving it. Metadata written by older engine
    /// versions lacks this field (empty string); load then falls back to the
    /// legacy `{table_name}.arrow` name, subject to the same containment
    /// check as every other path.
    #[serde(default)]
    file: String,
}

/// Current wall-clock time as milliseconds since the Unix epoch.
///
/// Returns 0 if the system clock reports a time before the epoch (the
/// resulting age inflation only makes caches *more* eager to refresh).
fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(duration_to_millis_clamped)
        .unwrap_or(0)
}

/// Convert a [`Duration`] to whole milliseconds, clamping to `u64::MAX`
/// instead of truncating on overflow.
fn duration_to_millis_clamped(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// FNV-1a 64-bit hash.
///
/// Implemented locally (instead of `std::hash::DefaultHasher`) because the
/// resulting hex digest is embedded in cache file names that persist on
/// disk across engine upgrades, and `DefaultHasher`'s algorithm is
/// explicitly not guaranteed to be stable across Rust releases.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET_BASIS;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Maximum length of the sanitized (human-readable) part of a cache file name.
const CACHE_FILE_NAME_MAX_SANITIZED_CHARS: usize = 64;

/// Derive a filesystem-safe Arrow IPC file name for a cached table.
///
/// The name is `{sanitized}_{hash8}.arrow`, where `sanitized` is the table
/// name with every character outside `[A-Za-z0-9_-]` replaced by `_`
/// (truncated to [`CACHE_FILE_NAME_MAX_SANITIZED_CHARS`] characters) and
/// `hash8` is the first 8 hex characters of an FNV-1a hash of the full
/// original name. The hash keeps distinct table names distinct even when
/// they sanitize to the same string (e.g. `Sales/2024` vs `Sales 2024`),
/// and the sanitization guarantees the result is a single, portable path
/// component — a hostile table name like `..\..\evil` cannot escape the
/// cache directory.
pub(crate) fn cache_file_name(table_name: &str) -> String {
    let sanitized: String = table_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(CACHE_FILE_NAME_MAX_SANITIZED_CHARS)
        .collect();
    let hash_hex = format!("{:016x}", fnv1a_64(table_name.as_bytes()));
    format!("{sanitized}_{}.arrow", &hash_hex[..8])
}

/// Join `file_name` onto the cache directory, verifying it cannot escape.
///
/// `file_name` must be a single normal path component (no separators, no
/// `..`/root/drive components — on Windows an absolute `Path::join` argument
/// *replaces* the base path entirely). As a belt-and-braces check, the
/// joined path's parent must canonicalize to the canonicalized cache
/// directory itself; the directory is canonicalized rather than the file so
/// that not-yet-written files are handled.
pub(crate) fn safe_cache_path(dir: &Path, file_name: &str) -> EngineResult<PathBuf> {
    use std::path::Component;

    let escape_err = || {
        EngineError::InvalidData(format!(
            "cache file name '{file_name}' would escape the cache directory"
        ))
    };

    let mut components = Path::new(file_name).components();
    let single_normal = matches!(components.next(), Some(Component::Normal(_)));
    if !single_normal || components.next().is_some() {
        return Err(escape_err());
    }

    let joined = dir.join(file_name);
    let canonical_dir = dir.canonicalize().map_err(|e| {
        EngineError::InvalidData(format!(
            "failed to canonicalize cache directory '{}': {e}",
            dir.display()
        ))
    })?;
    let canonical_parent = joined
        .parent()
        .ok_or_else(escape_err)?
        .canonicalize()
        .map_err(|_| escape_err())?;
    if canonical_parent != canonical_dir {
        return Err(escape_err());
    }

    Ok(joined)
}

impl Engine {
    /// Save all cached in-memory table data to disk.
    ///
    /// Writes each cached table as an Arrow IPC file plus a `metadata.json`
    /// containing `last_refreshed` ages, schema hashes, per-strategy
    /// `SourceQuery` fingerprints, and the wall-clock save time
    /// (`saved_at_unix_ms`). The save time lets
    /// [`load_cache_from_disk`](Self::load_cache_from_disk) count downtime
    /// between save and load toward each entry's age, keeping TTL-based
    /// staleness checks accurate across restarts.
    ///
    /// The `dir` must already exist; the method creates files inside it.
    pub fn save_cache_to_disk(&self, dir: &Path) -> EngineResult<()> {
        use arrow::ipc::writer::{FileWriter, IpcWriteOptions};
        use arrow::ipc::CompressionType;

        let mut tables_meta: BTreeMap<String, TableCacheMetadata> = BTreeMap::new();

        // Use Zstd compression for disk cache files.
        let write_options = IpcWriteOptions::default()
            .try_with_compression(Some(CompressionType::ZSTD))
            .map_err(|e| EngineError::InvalidData(format!("IPC compression init failed: {e}")))?;

        for table_name in self.cache.table_names() {
            // Only persist tables that are in the model and marked InMemory.
            let table = match self.model.table(table_name) {
                Ok(t) if t.is_in_memory() => t,
                _ => continue,
            };

            let batch = match self.cache.get(table_name) {
                Some(b) => b,
                None => continue,
            };

            // Write Zstd-compressed Arrow IPC file. The file name is a
            // sanitized derivative of the table name (see `cache_file_name`)
            // and is verified to stay inside the cache directory.
            let file_name = cache_file_name(table_name);
            let file_path = safe_cache_path(dir, &file_name)?;
            let file = std::fs::File::create(&file_path).map_err(|e| {
                EngineError::InvalidData(format!(
                    "failed to create cache file '{}': {e}",
                    file_path.display()
                ))
            })?;
            let mut writer =
                FileWriter::try_new_with_options(file, &batch.schema(), write_options.clone())
                    .map_err(|e| {
                        EngineError::InvalidData(format!("Arrow IPC writer init failed: {e}"))
                    })?;
            writer
                .write(batch)
                .map_err(|e| EngineError::InvalidData(format!("Arrow IPC write failed: {e}")))?;
            writer
                .finish()
                .map_err(|e| EngineError::InvalidData(format!("Arrow IPC finish failed: {e}")))?;

            // Record metadata: age in milliseconds, schema hash, and the
            // per-strategy SourceQuery fingerprints.
            let age_ms = if self.cache.is_force_stale(table_name) {
                // The entry was already maximally stale — keep it stale
                // across restarts instead of resetting its age.
                u64::MAX
            } else {
                self.cache
                    .age(table_name)
                    .map(duration_to_millis_clamped)
                    .unwrap_or(0)
            };
            let fingerprints: BTreeMap<String, String> = self
                .cache
                .fingerprints(table_name)
                .map(|m| m.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
                .unwrap_or_default();

            tables_meta.insert(
                table_name.to_string(),
                TableCacheMetadata {
                    age_ms,
                    schema_hash: table.schema_hash(),
                    row_count: batch.num_rows() as u64,
                    fingerprint: None,
                    fingerprints,
                    file: file_name,
                },
            );
        }

        // Write metadata.json with the wall-clock save time.
        let meta = CacheMetadata {
            saved_at_unix_ms: Some(now_unix_ms()),
            tables: tables_meta,
        };
        let meta_path = dir.join("metadata.json");
        let meta_json = serde_json::to_string_pretty(&meta)
            .map_err(|e| EngineError::InvalidData(format!("metadata serialization failed: {e}")))?;
        std::fs::write(&meta_path, meta_json).map_err(|e| {
            EngineError::InvalidData(format!(
                "failed to write metadata '{}': {e}",
                meta_path.display()
            ))
        })?;

        Ok(())
    }

    /// Restore cached in-memory table data from disk.
    ///
    /// Reads Arrow IPC files and `metadata.json` previously written by
    /// [`save_cache_to_disk`](Self::save_cache_to_disk). For each table:
    ///
    /// - If the table is no longer in the model or not `InMemory`, it is skipped.
    /// - If the schema hash differs from the current model, the file is skipped
    ///   (the table will be re-fetched on next refresh).
    /// - Otherwise the data is loaded into the cache with an effective age of
    ///   `saved age + downtime since save` (wall clock), so that TTL-based
    ///   staleness checks remain accurate across restarts. Metadata files
    ///   written by older engine versions lack the save timestamp and are
    ///   treated as saved at load time (their previous behavior). Negative
    ///   clock skew is clamped to zero downtime.
    ///
    /// Loading at least one table invalidates the query-result cache, like
    /// every other cache mutation.
    ///
    /// Returns the names of tables that were successfully loaded.
    pub fn load_cache_from_disk(&mut self, dir: &Path) -> EngineResult<Vec<String>> {
        use arrow::ipc::reader::FileReader;

        let meta_path = dir.join("metadata.json");
        if !meta_path.exists() {
            return Ok(Vec::new());
        }

        let meta_json = std::fs::read_to_string(&meta_path).map_err(|e| {
            EngineError::InvalidData(format!(
                "failed to read metadata '{}': {e}",
                meta_path.display()
            ))
        })?;
        let meta: CacheMetadata = serde_json::from_str(&meta_json)
            .map_err(|e| EngineError::InvalidData(format!("metadata parse failed: {e}")))?;

        // Wall-clock downtime between save and load, counted toward each
        // entry's age. Pre-`saved_at_unix_ms` files: zero downtime (see doc).
        let downtime_ms = match meta.saved_at_unix_ms {
            Some(saved_at) => now_unix_ms().saturating_sub(saved_at),
            None => 0,
        };

        let mut loaded = Vec::new();

        for (table_name, entry_meta) in &meta.tables {
            // Check the table still exists in the model and is InMemory.
            let table = match self.model.table(table_name) {
                Ok(t) if t.is_in_memory() => t,
                _ => continue,
            };

            // Validate schema hash.
            if entry_meta.schema_hash != table.schema_hash() {
                continue; // Schema changed — skip, will be re-fetched.
            }

            // Resolve the cache file path. New metadata carries the
            // sanitized file name chosen at save time; legacy metadata
            // (no `file` field) falls back to the historical
            // `{table_name}.arrow`. In both cases the name must stay inside
            // the cache directory — metadata files and table names cross a
            // trust boundary, so an entry that would escape (path
            // separators, `..`, absolute paths) is skipped like any other
            // unusable entry.
            let file_name = if entry_meta.file.is_empty() {
                format!("{table_name}.arrow")
            } else {
                entry_meta.file.clone()
            };
            let file_path = match safe_cache_path(dir, &file_name) {
                Ok(path) => path,
                Err(_) => continue,
            };
            if !file_path.exists() {
                continue;
            }

            let file = std::fs::File::open(&file_path).map_err(|e| {
                EngineError::InvalidData(format!(
                    "failed to open cache file '{}': {e}",
                    file_path.display()
                ))
            })?;
            let reader = FileReader::try_new(file, None).map_err(|e| {
                EngineError::InvalidData(format!(
                    "Arrow IPC read failed for '{}': {e}",
                    file_path.display()
                ))
            })?;

            let schema = reader.schema();
            let batches: Vec<RecordBatch> = reader
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| {
                    EngineError::InvalidData(format!(
                        "Arrow IPC batch read failed for '{table_name}': {e}"
                    ))
                })?;

            let batch = if batches.is_empty() {
                RecordBatch::new_empty(schema)
            } else {
                arrow::compute::concat_batches(&schema, &batches)?
            };

            // Restore with the effective age: saved age plus downtime.
            // Hostile/corrupted huge ages are handled by `store_with_age`
            // (the entry is stored maximally stale instead of panicking).
            let effective_age_ms = entry_meta.age_ms.saturating_add(downtime_ms);
            let age = std::time::Duration::from_millis(effective_age_ms);

            self.cache.store_with_age(table_name, batch, age)?;

            // Restore per-strategy fingerprints.
            for (key_str, fingerprint) in &entry_meta.fingerprints {
                if let Ok(key) = key_str.parse::<u64>() {
                    self.cache
                        .set_fingerprint(table_name, key, fingerprint.clone());
                }
            }

            // Legacy single-slot fingerprint (older metadata files): attribute
            // it to the table's first SourceQuery strategy, the only possible
            // owner in the old one-slot format.
            if let Some(fingerprint) = &entry_meta.fingerprint {
                if let Some(RefreshStrategy::SourceQuery { sql, .. }) =
                    table.io_refresh_strategies().first().copied()
                {
                    let key = InMemoryCache::source_query_key(sql);
                    if self.cache.fingerprint(table_name, key).is_none() {
                        self.cache
                            .set_fingerprint(table_name, key, fingerprint.clone());
                    }
                }
            }

            loaded.push(table_name.clone());
        }

        if !loaded.is_empty() {
            // Loaded data replaces cache contents — invalidate query results,
            // matching every other cache mutation (refresh/auto-tier).
            self.query_cache.lock().invalidate_all();
        }

        Ok(loaded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_metadata_roundtrip_with_saved_at() {
        let mut tables = BTreeMap::new();
        tables.insert(
            "t".to_string(),
            TableCacheMetadata {
                age_ms: 1234,
                schema_hash: "abc".to_string(),
                row_count: 10,
                fingerprint: None,
                fingerprints: BTreeMap::from([("42".to_string(), "fp".to_string())]),
                file: "t_00000000.arrow".to_string(),
            },
        );
        let meta = CacheMetadata {
            saved_at_unix_ms: Some(1_760_000_000_000),
            tables,
        };

        let json = serde_json::to_string(&meta).unwrap();
        let parsed: CacheMetadata = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.saved_at_unix_ms, Some(1_760_000_000_000));
        let t = &parsed.tables["t"];
        assert_eq!(t.age_ms, 1234);
        assert_eq!(t.schema_hash, "abc");
        assert_eq!(t.row_count, 10);
        assert_eq!(t.fingerprints["42"], "fp");
        assert!(t.fingerprint.is_none());
        assert_eq!(t.file, "t_00000000.arrow");
    }

    #[test]
    fn cache_metadata_parses_legacy_format() {
        // Written by an older engine version: no saved_at_unix_ms, a single
        // fingerprint slot (possibly null), no fingerprints map.
        let json = r#"{
            "tables": {
                "Products": {
                    "age_ms": 500,
                    "schema_hash": "h",
                    "row_count": 3,
                    "fingerprint": "v1"
                },
                "Customers": {
                    "age_ms": 9,
                    "schema_hash": "h2",
                    "row_count": 1,
                    "fingerprint": null
                }
            }
        }"#;
        let parsed: CacheMetadata = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.saved_at_unix_ms, None);
        assert_eq!(parsed.tables["Products"].fingerprint.as_deref(), Some("v1"));
        assert!(parsed.tables["Products"].fingerprints.is_empty());
        assert!(parsed.tables["Customers"].fingerprint.is_none());
        // Legacy entries have no `file` field — empty string after parsing,
        // which triggers the `{name}.arrow` fallback on load.
        assert!(parsed.tables["Products"].file.is_empty());
    }
}
