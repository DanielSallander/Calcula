//! Disk-cache persistence tests: save/load roundtrips, age preservation,
//! fingerprint migration, and cache file-name sanitization / path
//! containment.

use std::path::Path;
use std::sync::Arc;

use arrow::array::Int64Array;
use arrow::datatypes::{DataType as ArrowDataType, Field, Schema as ArrowSchema};
use arrow::record_batch::RecordBatch;

use crate::disk_cache::{cache_file_name, safe_cache_path};
use crate::test_fixtures::{
    make_cache_dir, make_inmemory_model, make_source_query_model, make_test_batch,
};
use crate::{Column, DataModel, DataType, Engine, InMemoryCache, StorageMode, Table};

#[test]
fn save_and_load_cache_roundtrip() {
    let dir = make_cache_dir("roundtrip");
    let model = make_inmemory_model();

    // Save.
    let mut engine = Engine::new(model.clone());
    engine.cache.store("Products", make_test_batch()).unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Verify files exist (table files use the sanitized-name scheme).
    assert!(dir.join(cache_file_name("Products")).exists());
    assert!(dir.join("metadata.json").exists());

    // Load into a fresh engine.
    let mut engine2 = Engine::new(model);
    let loaded = engine2.load_cache_from_disk(&dir).unwrap();
    assert_eq!(loaded, vec!["Products"]);

    let cached = engine2.cache().get("Products").unwrap();
    assert_eq!(cached.num_rows(), 3);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_preserves_age() {
    let dir = make_cache_dir("age");
    let model = make_inmemory_model();

    // Store with a known age.
    let mut engine = Engine::new(model.clone());
    engine
        .cache
        .store_with_age(
            "Products",
            make_test_batch(),
            std::time::Duration::from_secs(200),
        )
        .unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Load and check the age is preserved (approximately).
    let mut engine2 = Engine::new(model);
    engine2.load_cache_from_disk(&dir).unwrap();

    let age = engine2.cache().age("Products").unwrap();
    // Should be ~200s (allow small margin for test execution time).
    assert!(age >= std::time::Duration::from_secs(199));

    // With 300s TTL and 200s age, should not be stale yet.
    assert!(!engine2.needs_refresh("Products", std::time::Duration::from_secs(300)));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_skips_schema_mismatch() {
    let dir = make_cache_dir("schema_mismatch");

    // Save with original schema.
    let model_v1 = make_inmemory_model();
    let mut engine = Engine::new(model_v1);
    engine.cache.store("Products", make_test_batch()).unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Create model v2 with a different column.
    let model_v2 = DataModel::builder()
        .add_table(
            Table::new(
                "Products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("cost", DataType::Float64), // was "price"
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .build()
        .unwrap();

    let mut engine2 = Engine::new(model_v2);
    let loaded = engine2.load_cache_from_disk(&dir).unwrap();
    // Should skip — schema hash mismatch.
    assert!(loaded.is_empty());
    assert!(engine2.cache().get("Products").is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_skips_direct_query_tables() {
    let dir = make_cache_dir("direct_query");

    // Save with InMemory mode.
    let model_im = make_inmemory_model();
    let mut engine = Engine::new(model_im);
    engine.cache.store("Products", make_test_batch()).unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Load with DirectQuery mode (table is no longer InMemory).
    let model_dq = DataModel::builder()
        .add_table(
            Table::new(
                "Products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("price", DataType::Float64),
                ],
            )
            .unwrap(), // default: DirectQuery
        )
        .build()
        .unwrap();

    let mut engine2 = Engine::new(model_dq);
    let loaded = engine2.load_cache_from_disk(&dir).unwrap();
    assert!(loaded.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_returns_empty_for_missing_dir() {
    let model = make_inmemory_model();
    let mut engine = Engine::new(model);
    let loaded = engine
        .load_cache_from_disk(Path::new("/nonexistent/path"))
        .unwrap();
    assert!(loaded.is_empty());
}

#[test]
fn save_cache_only_persists_inmemory_tables() {
    let dir = make_cache_dir("only_inmemory");

    let model = DataModel::builder()
        .add_table(
            Table::new("InMem", vec![Column::new("id", DataType::Int64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(Table::new("Direct", vec![Column::new("id", DataType::Int64)]).unwrap())
        .build()
        .unwrap();

    let mut engine = Engine::new(model);

    let schema = Arc::new(ArrowSchema::new(vec![Field::new(
        "id",
        ArrowDataType::Int64,
        true,
    )]));
    let batch = RecordBatch::try_new(schema, vec![Arc::new(Int64Array::from(vec![1]))]).unwrap();
    engine.cache.store("InMem", batch.clone()).unwrap();
    engine.cache.store("Direct", batch).unwrap();

    engine.save_cache_to_disk(&dir).unwrap();

    // Only InMem should have an arrow file.
    assert!(dir.join(cache_file_name("InMem")).exists());
    assert!(!dir.join(cache_file_name("Direct")).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_counts_downtime_toward_age() {
    let dir = make_cache_dir("downtime");
    let model = make_inmemory_model(); // 300s refresh interval.

    let mut engine = Engine::new(model.clone());
    engine.cache.store("Products", make_test_batch()).unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Rewind saved_at_unix_ms by 400s to simulate downtime between
    // save and load.
    let meta_path = dir.join("metadata.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
    let saved_at = value["saved_at_unix_ms"].as_u64().unwrap();
    value["saved_at_unix_ms"] = serde_json::json!(saved_at - 400_000);
    std::fs::write(&meta_path, serde_json::to_string(&value).unwrap()).unwrap();

    let mut engine2 = Engine::new(model);
    engine2.load_cache_from_disk(&dir).unwrap();

    // Effective age includes the downtime → past the 300s TTL.
    let age = engine2.cache().age("Products").unwrap();
    assert!(age >= std::time::Duration::from_secs(399));
    assert!(engine2.needs_refresh("Products", std::time::Duration::from_secs(300)));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn save_load_roundtrip_per_strategy_fingerprints() {
    let dir = make_cache_dir("fingerprints");
    let sql = "SELECT MAX(loaded_at) FROM etl_log";
    let model = make_source_query_model(sql);

    let mut engine = Engine::new(model.clone());
    engine.cache.store("Products", make_test_batch()).unwrap();
    let key = InMemoryCache::source_query_key(sql);
    engine
        .cache
        .set_fingerprint("Products", key, "fp-1".to_string());
    engine.save_cache_to_disk(&dir).unwrap();

    let mut engine2 = Engine::new(model);
    engine2.load_cache_from_disk(&dir).unwrap();
    assert_eq!(engine2.cache().fingerprint("Products", key), Some("fp-1"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_migrates_legacy_fingerprint() {
    let dir = make_cache_dir("legacy_fingerprint");
    let sql = "SELECT MAX(loaded_at) FROM etl_log";
    let model = make_source_query_model(sql);

    let mut engine = Engine::new(model.clone());
    engine.cache.store("Products", make_test_batch()).unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Rewrite the metadata into the legacy single-slot shape.
    let meta_path = dir.join("metadata.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
    let entry = value["tables"]["Products"].as_object_mut().unwrap();
    entry.remove("fingerprints");
    entry.insert("fingerprint".to_string(), serde_json::json!("legacy-fp"));
    std::fs::write(&meta_path, serde_json::to_string(&value).unwrap()).unwrap();

    let mut engine2 = Engine::new(model);
    engine2.load_cache_from_disk(&dir).unwrap();

    // The legacy value is attributed to the first SourceQuery strategy.
    let key = InMemoryCache::source_query_key(sql);
    assert_eq!(
        engine2.cache().fingerprint("Products", key),
        Some("legacy-fp")
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cache_file_name_sanitizes_traversal_names() {
    // A hostile table name collapses to a single safe path component.
    // The expected digest is hardcoded: FNV-1a output is embedded in
    // file names that persist on disk, so it must stay stable across
    // engine versions.
    let name = cache_file_name("..\\..\\evil");
    assert_eq!(name, "______evil_2c8e3842.arrow");
    assert!(!name.contains('\\'));
    assert!(!name.contains('/'));
    assert!(!name.contains(".."));
}

#[test]
fn cache_file_name_distinguishes_names_with_same_sanitization() {
    // "Sales/2024" and "Sales 2024" both sanitize to "Sales_2024", but
    // the hash of the full original name keeps the files distinct.
    let a = cache_file_name("Sales/2024");
    let b = cache_file_name("Sales 2024");
    assert!(a.starts_with("Sales_2024_"));
    assert!(b.starts_with("Sales_2024_"));
    assert_ne!(a, b);
}

#[test]
fn cache_file_name_truncates_long_names() {
    let long = "a".repeat(100);
    let name = cache_file_name(&long);
    // 64 sanitized chars + '_' + 8 hex chars + ".arrow".
    assert_eq!(name, format!("{}_2885d0ac.arrow", "a".repeat(64)));
    assert_eq!(name.len(), 64 + 1 + 8 + 6);
}

#[test]
fn safe_cache_path_rejects_traversal_and_absolute_names() {
    let dir = make_cache_dir("safe_path");

    assert!(safe_cache_path(&dir, "ok.arrow").is_ok());

    // Multi-component, parent-relative, and rooted names are rejected
    // on every platform.
    for bad in ["../evil.arrow", "sub/evil.arrow", "..", "/abs/evil.arrow"] {
        assert!(
            safe_cache_path(&dir, bad).is_err(),
            "expected rejection of {bad:?}"
        );
    }

    // Windows-specific separators and drive prefixes. On Windows an
    // absolute argument to Path::join *replaces* the base path, so
    // these are exactly the dangerous inputs.
    #[cfg(windows)]
    for bad in ["..\\evil.arrow", "C:\\evil.arrow", "sub\\evil.arrow"] {
        assert!(
            safe_cache_path(&dir, bad).is_err(),
            "expected rejection of {bad:?}"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn save_load_roundtrip_with_spaces_and_unicode_table_name() {
    let dir = make_cache_dir("unicode_name");
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Försäljning Data",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("price", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .build()
        .unwrap();

    let mut engine = Engine::new(model.clone());
    engine
        .cache
        .store("Försäljning Data", make_test_batch())
        .unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // The on-disk file uses the sanitized scheme and is recorded in the
    // metadata so load does not have to re-derive it.
    assert!(dir.join(cache_file_name("Försäljning Data")).exists());

    let mut engine2 = Engine::new(model);
    let loaded = engine2.load_cache_from_disk(&dir).unwrap();
    assert_eq!(loaded, vec!["Försäljning Data".to_string()]);
    let cached = engine2.cache().get("Försäljning Data").unwrap();
    assert_eq!(cached.num_rows(), 3);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_legacy_metadata_falls_back_to_name_arrow() {
    let dir = make_cache_dir("legacy_file_name");
    let model = make_inmemory_model();

    let mut engine = Engine::new(model.clone());
    engine.cache.store("Products", make_test_batch()).unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Simulate a cache dir written by an older engine version: the table
    // file sits at the legacy `{name}.arrow` and the metadata entry has
    // no `file` field.
    std::fs::rename(
        dir.join(cache_file_name("Products")),
        dir.join("Products.arrow"),
    )
    .unwrap();
    let meta_path = dir.join("metadata.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
    value["tables"]["Products"]
        .as_object_mut()
        .unwrap()
        .remove("file");
    std::fs::write(&meta_path, serde_json::to_string(&value).unwrap()).unwrap();

    let mut engine2 = Engine::new(model);
    let loaded = engine2.load_cache_from_disk(&dir).unwrap();
    assert_eq!(loaded, vec!["Products"]);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_skips_metadata_with_escaping_file_entry() {
    let dir = make_cache_dir("hostile_file_field");
    let model = make_inmemory_model();

    let mut engine = Engine::new(model.clone());
    engine.cache.store("Products", make_test_batch()).unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Plant a real, loadable cache file one level above the cache dir
    // and point the metadata `file` entry at it via traversal. If the
    // containment check were missing, the load would succeed.
    let escaped = dir.parent().unwrap().join("escaped_cache_target.arrow");
    std::fs::copy(dir.join(cache_file_name("Products")), &escaped).unwrap();
    let meta_path = dir.join("metadata.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
    value["tables"]["Products"]["file"] = serde_json::json!("../escaped_cache_target.arrow");
    std::fs::write(&meta_path, serde_json::to_string(&value).unwrap()).unwrap();
    // Remove the legitimate file so only the traversal target remains.
    std::fs::remove_file(dir.join(cache_file_name("Products"))).unwrap();

    let mut engine2 = Engine::new(model);
    let loaded = engine2.load_cache_from_disk(&dir).unwrap();
    assert!(loaded.is_empty());
    assert!(engine2.cache().get("Products").is_none());

    let _ = std::fs::remove_file(&escaped);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_skips_legacy_entry_with_traversal_table_name() {
    // A legacy metadata entry (no `file` field) whose table name
    // contains `..` must not escape the cache directory via the
    // `{name}.arrow` fallback. The model builder rejects such names
    // (fix S4), so construct the hostile model through serde, which a
    // hostile model file could do.
    let base = make_cache_dir("legacy_traversal");
    let cache_dir = base.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();

    let clean_model = DataModel::builder()
        .add_table(
            Table::new(
                "EvilX",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("price", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .build()
        .unwrap();
    let hostile_json = serde_json::to_string(&clean_model)
        .unwrap()
        .replace("EvilX", r"..\\evil");
    let hostile_model: DataModel = serde_json::from_str(&hostile_json).unwrap();
    let hostile_name = r"..\evil";
    let schema_hash = hostile_model.table(hostile_name).unwrap().schema_hash();

    // Plant a real, loadable Arrow file at the traversal target
    // (`cache/..\evil.arrow` resolves to `base/evil.arrow` on Windows).
    {
        let batch = make_test_batch();
        let file = std::fs::File::create(base.join("evil.arrow")).unwrap();
        let mut writer = arrow::ipc::writer::FileWriter::try_new(file, &batch.schema()).unwrap();
        writer.write(&batch).unwrap();
        writer.finish().unwrap();
    }

    // Legacy-shaped metadata: no `file` field, matching schema hash.
    let meta_json = serde_json::json!({
        "tables": {
            hostile_name: {
                "age_ms": 0,
                "schema_hash": schema_hash,
                "row_count": 3
            }
        }
    });
    std::fs::write(
        cache_dir.join("metadata.json"),
        serde_json::to_string(&meta_json).unwrap(),
    )
    .unwrap();

    let mut engine = Engine::new(hostile_model);
    let loaded = engine.load_cache_from_disk(&cache_dir).unwrap();
    assert!(loaded.is_empty());
    assert!(engine.cache().get(hostile_name).is_none());

    let _ = std::fs::remove_dir_all(&base);
}

// ---------------------------------------------------------------------------
// Cross-table lookups: a restored cache must not outlive its target's shape
// ---------------------------------------------------------------------------

/// A two-table model: `Orders` looks up `Customers`, whose column list is
/// whatever `customer_columns` says. Varying that is how the tests reshape
/// the target without touching the dependent.
fn lookup_model(customer_columns: Vec<Column>) -> DataModel {
    use crate::{
        PersistedAuthKind, PersistedConnection, PersistedSource, SourceKind, TableSourceBinding,
        TransformStep,
    };

    let customers = Table::new("Customers", customer_columns)
        .unwrap()
        .with_storage_mode(StorageMode::InMemory)
        .with_source_binding(TableSourceBinding::new("src", "public", "customers"));

    let steps = vec![TransformStep::LookupColumn {
        table: "Customers".into(),
        keys: vec![engine_core::transform::LookupKey::new("id", "customer_id")],
        takes: vec![engine_core::transform::LookupTake::new("customer_name")],
    }];
    let source_columns = vec![Column::new("id", DataType::Int64)];
    let derived = crate::derive_pipeline_schema(
        "Orders",
        &source_columns,
        &steps,
        &engine_core::transform::ModelTableSchemas::new(std::slice::from_ref(&customers)),
    )
    .unwrap();

    DataModel::builder()
        .add_source(PersistedSource::new(
            "src",
            SourceKind::InMemory,
            PersistedConnection::default(),
            PersistedAuthKind::Integrated,
        ))
        .add_table(
            Table::new("Orders", derived)
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_source_binding(
                    TableSourceBinding::new("src", "public", "orders")
                        .with_source_columns(source_columns)
                        .with_transformations(steps),
                ),
        )
        .add_table(customers)
        .build()
        .unwrap()
}

fn narrow_customers() -> Vec<Column> {
    vec![
        Column::new("customer_id", DataType::Int64),
        Column::new("customer_name", DataType::String),
    ]
}

fn wide_customers() -> Vec<Column> {
    vec![
        Column::new("customer_id", DataType::Int64),
        Column::new("customer_name", DataType::String),
        Column::new("segment", DataType::String),
    ]
}

/// A single-column Int64 batch, enough to occupy a cache slot.
fn one_column_batch(name: &str) -> RecordBatch {
    let schema = Arc::new(ArrowSchema::new(vec![Field::new(
        name,
        ArrowDataType::Int64,
        true,
    )]));
    RecordBatch::try_new(schema, vec![Arc::new(Int64Array::from(vec![1, 2, 3]))]).unwrap()
}

#[test]
fn a_restored_dependent_is_rejected_when_its_target_was_reshaped() {
    // `Orders`' own columns and pipeline are byte-identical across the two
    // models, so its `schema_hash` matches and a schema-hash-only check would
    // happily restore rows carrying a `customer_name` joined out of a
    // `Customers` that has since gained a column. The dependency fold is what
    // catches it.
    let dir = make_cache_dir("lookup_target_reshaped");

    let mut engine = Engine::new(lookup_model(narrow_customers()));
    engine
        .cache
        .store("Orders", one_column_batch("id"))
        .unwrap();
    engine
        .cache
        .store("Customers", one_column_batch("customer_id"))
        .unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    // Reopen against a model whose TARGET changed shape.
    let mut reopened = Engine::new(lookup_model(wide_customers()));
    let loaded = reopened.load_cache_from_disk(&dir).unwrap();

    assert!(
        !loaded.iter().any(|t| t == "Customers"),
        "the reshaped table itself is rejected by its own hash: {loaded:?}"
    );
    assert!(
        !loaded.iter().any(|t| t == "Orders"),
        "and so must the table whose rows were JOINED from it: {loaded:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_restored_dependent_is_kept_when_nothing_changed() {
    // The non-vacuity control: the rejection above must come from the
    // reshape, not from having a lookup at all. Without this, making
    // `cache_identity` return a random string every call would "pass".
    let dir = make_cache_dir("lookup_unchanged");

    let mut engine = Engine::new(lookup_model(narrow_customers()));
    engine
        .cache
        .store("Orders", one_column_batch("id"))
        .unwrap();
    engine
        .cache
        .store("Customers", one_column_batch("customer_id"))
        .unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    let mut reopened = Engine::new(lookup_model(narrow_customers()));
    let mut loaded = reopened.load_cache_from_disk(&dir).unwrap();
    loaded.sort();
    assert_eq!(loaded, vec!["Customers".to_string(), "Orders".to_string()]);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_consistently_restored_pair_is_not_immediately_stale() {
    // Both tables came out of ONE save, so the restored `Orders` really was
    // computed from the restored `Customers`. If the engine forgot that, the
    // next `refresh_stale` would refetch the whole chain and the disk cache
    // would be worthless for exactly the tables that cost most to rebuild.
    let dir = make_cache_dir("lookup_restored_pair");

    let mut engine = Engine::new(lookup_model(narrow_customers()));
    engine
        .cache
        .store("Orders", one_column_batch("id"))
        .unwrap();
    engine
        .cache
        .store("Customers", one_column_batch("customer_id"))
        .unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    let mut reopened = Engine::new(lookup_model(narrow_customers()));
    reopened.load_cache_from_disk(&dir).unwrap();
    assert!(
        !reopened.lookup_targets_moved("Orders"),
        "a consistently restored pair must not read as stale"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_dependent_restored_without_its_target_goes_stale_as_soon_as_the_target_arrives() {
    // The inverse. `Customers` was never cached, so only `Orders` is on disk;
    // its restored rows were joined against rows that are NOT coming back.
    // The moment the target is fetched, the dependent must read as stale.
    let dir = make_cache_dir("lookup_restored_alone");

    let mut engine = Engine::new(lookup_model(narrow_customers()));
    engine
        .cache
        .store("Orders", one_column_batch("id"))
        .unwrap();
    engine.save_cache_to_disk(&dir).unwrap();

    let mut reopened = Engine::new(lookup_model(narrow_customers()));
    assert_eq!(reopened.load_cache_from_disk(&dir).unwrap(), vec!["Orders"]);
    assert!(
        !reopened.lookup_targets_moved("Orders"),
        "with no target cached at all there is nothing to disagree with yet"
    );

    reopened
        .cache
        .store("Customers", one_column_batch("customer_id"))
        .unwrap();
    assert!(
        reopened.lookup_targets_moved("Orders"),
        "now the target has rows the restored Orders never saw"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
