//! FILENAME: app/src-tauri/src/bi/engine_registry.rs
//! PURPOSE: Shared Engine registry with reference counting and disk cache support.
//!          Multiple connections using the same model share one Engine instance.
//!          Engines are keyed by canonical model path and persist their cache
//!          to %LOCALAPPDATA%\Calcula\cache\{model_hash}\.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as TokioMutex;

// ---------------------------------------------------------------------------
// ModelKey — stable identifier for a unique model/engine instance
// ---------------------------------------------------------------------------

/// Identifies a model by its normalized file path.
/// Used as the key in the shared engine registry.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct ModelKey(String);

impl ModelKey {
    /// Create a ModelKey from a model file path.
    /// Normalizes slashes and case for consistent matching on Windows.
    pub fn from_model_path(path: &str) -> Self {
        let normalized = path.replace('\\', "/").to_lowercase();
        ModelKey(normalized)
    }

    /// Returns a filesystem-safe directory name for disk cache (hex hash).
    pub fn cache_dir_name(&self) -> String {
        let mut hasher = DefaultHasher::new();
        self.0.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }
}

impl std::fmt::Display for ModelKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

// ---------------------------------------------------------------------------
// SharedEngine — Arc-wrapped engine with reference count
// ---------------------------------------------------------------------------

struct SharedEngine {
    engine: Arc<TokioMutex<bi_engine::Engine>>,
    ref_count: usize,
    cache_dir: PathBuf,
}

// ---------------------------------------------------------------------------
// EngineRegistry — application-level shared engine map
// ---------------------------------------------------------------------------

/// Application-level registry of shared Engine instances.
/// Multiple BI connections using the same model share one Engine.
/// Thread-safe: the inner map is behind a std::sync::Mutex (brief locks only).
pub struct EngineRegistry {
    engines: StdMutex<HashMap<ModelKey, SharedEngine>>,
}

impl EngineRegistry {
    pub fn new() -> Self {
        Self {
            engines: StdMutex::new(HashMap::new()),
        }
    }

    /// Returns the base cache directory: %LOCALAPPDATA%\Calcula\cache\
    fn base_cache_dir() -> PathBuf {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(local_app_data).join("Calcula").join("cache")
    }

    /// Returns the cache directory for a specific model key.
    pub fn cache_dir_for(key: &ModelKey) -> PathBuf {
        Self::base_cache_dir().join(key.cache_dir_name())
    }

    /// Check if an engine already exists for this model key.
    pub fn has_engine(&self, key: &ModelKey) -> bool {
        let engines = self.engines.lock().unwrap();
        engines.contains_key(key)
    }

    /// Get or create a shared engine for a model key.
    /// If the engine already exists, increments the reference count and returns it.
    /// If not, creates a new engine, loads disk cache, and returns it.
    /// Returns (engine_arc, was_existing, cache_dir).
    pub fn get_or_create(
        &self,
        key: &ModelKey,
        engine: bi_engine::Engine,
    ) -> (Arc<TokioMutex<bi_engine::Engine>>, bool, PathBuf) {
        let mut engines = self.engines.lock().unwrap();
        let cache_dir = Self::cache_dir_for(key);

        if let Some(shared) = engines.get_mut(key) {
            shared.ref_count += 1;
            let arc = shared.engine.clone();
            log::info!(
                "[BI] EngineRegistry: reusing engine for {} (ref_count={})",
                key, shared.ref_count
            );
            (arc, true, cache_dir)
        } else {
            let arc = Arc::new(TokioMutex::new(engine));
            engines.insert(key.clone(), SharedEngine {
                engine: arc.clone(),
                ref_count: 1,
                cache_dir: cache_dir.clone(),
            });
            log::info!(
                "[BI] EngineRegistry: created new engine for {} (ref_count=1)",
                key
            );
            (arc, false, cache_dir)
        }
    }

    /// Get an existing shared engine by key (does NOT increment ref count).
    pub fn get(&self, key: &ModelKey) -> Option<Arc<TokioMutex<bi_engine::Engine>>> {
        let engines = self.engines.lock().unwrap();
        engines.get(key).map(|s| s.engine.clone())
    }

    /// Release a reference to a shared engine.
    /// If the ref count drops to zero, saves cache to disk and removes the engine.
    /// Returns true if the engine was removed (last reference).
    pub fn release(&self, key: &ModelKey) -> bool {
        let mut engines = self.engines.lock().unwrap();
        let should_remove = if let Some(shared) = engines.get_mut(key) {
            shared.ref_count = shared.ref_count.saturating_sub(1);
            log::info!(
                "[BI] EngineRegistry: released engine for {} (ref_count={})",
                key, shared.ref_count
            );
            shared.ref_count == 0
        } else {
            false
        };

        if should_remove {
            if let Some(shared) = engines.remove(key) {
                // Save cache to disk synchronously before dropping.
                // We use try_lock since this is called during cleanup.
                if let Ok(engine) = shared.engine.try_lock() {
                    Self::save_cache_sync(&engine, &shared.cache_dir);
                }
                log::info!("[BI] EngineRegistry: removed engine for {}", key);
            }
            true
        } else {
            false
        }
    }

    /// Load disk cache into an engine. Non-fatal on failure.
    pub fn load_cache(engine: &mut bi_engine::Engine, cache_dir: &PathBuf) -> Vec<String> {
        if !cache_dir.exists() {
            log::info!("[BI] No disk cache at {}", cache_dir.display());
            return vec![];
        }
        match engine.load_cache_from_disk(cache_dir) {
            Ok(tables) => {
                log::info!(
                    "[BI] Loaded disk cache: {} tables from {}",
                    tables.len(),
                    cache_dir.display()
                );
                tables
            }
            Err(e) => {
                log::warn!(
                    "[BI] Failed to load disk cache from {}: {} (will re-fetch from source)",
                    cache_dir.display(),
                    e
                );
                vec![]
            }
        }
    }

    /// Save cache to disk for a single engine. Non-fatal on failure.
    pub fn save_cache_sync(engine: &bi_engine::Engine, cache_dir: &PathBuf) {
        // Ensure directory exists
        if let Err(e) = std::fs::create_dir_all(cache_dir) {
            log::warn!(
                "[BI] Failed to create cache dir {}: {}",
                cache_dir.display(),
                e
            );
            return;
        }
        match engine.save_cache_to_disk(cache_dir) {
            Ok(()) => {
                log::info!("[BI] Saved disk cache to {}", cache_dir.display());
            }
            Err(e) => {
                log::warn!(
                    "[BI] Failed to save disk cache to {}: {}",
                    cache_dir.display(),
                    e
                );
            }
        }
    }

    /// Save all engine caches to disk (called on app shutdown).
    /// Returns the number of engines whose caches were saved.
    pub fn save_all_caches(&self) -> usize {
        let engines = self.engines.lock().unwrap();
        let mut saved = 0;
        for (key, shared) in engines.iter() {
            if let Ok(engine) = shared.engine.try_lock() {
                Self::save_cache_sync(&engine, &shared.cache_dir);
                saved += 1;
            } else {
                log::warn!(
                    "[BI] Could not lock engine for {} during shutdown save",
                    key
                );
            }
        }
        saved
    }
}
