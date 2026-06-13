//! Model file I/O: JSON save/load with the format-version gate and
//! measure re-parse on load.

use std::path::Path;

use crate::{DataModel, Engine, EngineError, EngineResult};

impl Engine {
    /// Save the data model to a JSON file.
    ///
    /// The written file always carries the current
    /// [`MODEL_FORMAT_VERSION`](engine_core::model::schema::MODEL_FORMAT_VERSION) —
    /// saving a model that was loaded from a legacy (version `0`) file
    /// upgrades the file to the current format. Saving cannot destroy
    /// content from a *newer* format version: [`Engine::load_model`]
    /// refuses such files up front, so they never reach a save.
    pub fn save_model(&self, path: &Path) -> EngineResult<()> {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let mut value = serde_json::to_value(&self.model)
            .map_err(|e| EngineError::InvalidData(format!("JSON serialization failed: {e}")))?;
        // Normalize the version on the serialized output (legacy 0 → current).
        if let Some(map) = value.as_object_mut() {
            map.insert(
                "format_version".to_string(),
                serde_json::Value::from(MODEL_FORMAT_VERSION),
            );
        }
        let json = serde_json::to_string_pretty(&value)
            .map_err(|e| EngineError::InvalidData(format!("JSON serialization failed: {e}")))?;
        std::fs::write(path, json)
            .map_err(|e| EngineError::InvalidData(format!("failed to write file: {e}")))?;
        Ok(())
    }

    /// Load a data model from a JSON file.
    ///
    /// Loading proceeds in three stages:
    ///
    /// 1. **Version gate.** The file is parsed into a generic JSON value
    ///    and its `format_version` field (missing → `0`, the legacy
    ///    unversioned format) is checked against
    ///    [`MODEL_FORMAT_VERSION`](engine_core::model::schema::MODEL_FORMAT_VERSION)
    ///    *before* any structural deserialization. Files written by a
    ///    newer engine fail with [`EngineError::ModelFormatTooNew`]
    ///    instead of a cryptic serde error on an unknown field or enum
    ///    variant — and because the load refuses them outright, this
    ///    engine can never silently drop their unknown content and then
    ///    destroy it via [`Engine::save_model`].
    /// 2. **Deserialization and measure re-parse.** The model is
    ///    deserialized from the already-parsed value, then every measure
    ///    carrying source text is re-parsed through the current parser
    ///    ([`DataModel::reparse_measures_from_source`]). The source text
    ///    is the authoritative definition, so re-parsing re-applies the
    ///    current parser's grammar and validation; a measure whose source
    ///    no longer parses keeps its stored expression tree (which still
    ///    passes model validation) rather than failing the load.
    /// 3. **Validation.** The resulting model is validated as usual.
    pub fn load_model(path: &Path) -> EngineResult<DataModel> {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let json = std::fs::read_to_string(path)
            .map_err(|e| EngineError::InvalidData(format!("failed to read file: {e}")))?;
        let value: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| EngineError::InvalidData(format!("JSON parse failed: {e}")))?;

        // Version gate: refuse newer files before attempting to
        // deserialize structures this engine does not know about.
        let found = value
            .get("format_version")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if found > u64::from(MODEL_FORMAT_VERSION) {
            return Err(EngineError::ModelFormatTooNew {
                // Saturate values beyond u32 — the message stays accurate
                // ("newer than supported") without risking a panic.
                found: u32::try_from(found).unwrap_or(u32::MAX),
                supported: MODEL_FORMAT_VERSION,
            });
        }

        let mut model: DataModel = serde_json::from_value(value)
            .map_err(|e| EngineError::InvalidData(format!("JSON parse failed: {e}")))?;
        model.reparse_measures_from_source();
        model.validate()?;
        Ok(model)
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        sum_measure, AggregateOp, Column, DataModel, DataType, Engine, EngineError, Measure, Table,
    };

    #[test]
    fn save_and_load_model_roundtrip() {
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();

        let engine = Engine::new(model);

        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_model.json");
        engine.save_model(&path).unwrap();

        let loaded = Engine::load_model(&path).unwrap();
        assert_eq!(loaded.tables().len(), 1);
        assert_eq!(loaded.measures().len(), 1);
        assert_eq!(loaded.measures()[0].name(), "Revenue");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_and_load_model_preserves_presentation_metadata() {
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("id", DataType::Int64).hidden(),
                        Column::new("amount", DataType::Float64)
                            .with_display_name("Amount")
                            .with_description("Sale amount in USD")
                            .with_default_aggregation(AggregateOp::Sum),
                    ],
                )
                .unwrap()
                .with_display_name("Sales Facts")
                .with_description("One row per order line"),
            )
            .add_measure(
                sum_measure("Revenue", "Sales", "amount")
                    .with_format_string("#,##0.00")
                    .with_description("Total sales amount")
                    .hidden(),
            )
            .build()
            .unwrap();

        let engine = Engine::new(model);
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_presentation_metadata.json");
        engine.save_model(&path).unwrap();

        let loaded = Engine::load_model(&path).unwrap();

        let table = loaded.table("Sales").unwrap();
        assert_eq!(table.display_name(), Some("Sales Facts"));
        assert_eq!(table.description(), Some("One row per order line"));
        assert!(!table.is_hidden());

        let id = table.column("id").unwrap();
        assert!(id.is_hidden());
        assert_eq!(id.display_name(), None);

        let amount = table.column("amount").unwrap();
        assert_eq!(amount.display_name(), Some("Amount"));
        assert_eq!(amount.description(), Some("Sale amount in USD"));
        assert_eq!(amount.default_aggregation(), Some(AggregateOp::Sum));
        assert!(!amount.is_hidden());

        let measure = loaded.measure("Revenue").unwrap();
        assert_eq!(measure.format_string(), Some("#,##0.00"));
        assert_eq!(measure.description(), Some("Total sales amount"));
        assert!(measure.is_hidden());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_model_validates() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_invalid.json");

        // Write invalid JSON (relationship to missing table).
        let json = r#"{
            "tables": [],
            "relationships": [{
                "name": "Bad",
                "from_table": "Missing",
                "from_column": "id",
                "to_table": "Also_Missing",
                "to_column": "id",
                "cardinality": "ManyToOne"
            }],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        std::fs::write(&path, json).unwrap();

        let result = Engine::load_model(&path);
        assert!(result.is_err());

        let _ = std::fs::remove_file(&path);
    }

    // -- Model format version tests --

    #[test]
    fn load_model_rejects_newer_format_version_before_deserialization() {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_too_new.json");

        // The measure expression uses an enum variant unknown to this
        // engine — full deserialization would fail with a serde error, so
        // getting ModelFormatTooNew proves the version gate fires first.
        let json = r#"{
            "format_version": 999,
            "tables": [],
            "relationships": [],
            "measures": [{
                "name": "Future",
                "expression": {"SomeFutureFunction": {"arg": 1}}
            }],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        std::fs::write(&path, json).unwrap();

        let err = Engine::load_model(&path).unwrap_err();
        match err {
            EngineError::ModelFormatTooNew { found, supported } => {
                assert_eq!(found, 999);
                assert_eq!(supported, MODEL_FORMAT_VERSION);
            }
            other => panic!("expected ModelFormatTooNew, got: {other:?}"),
        }

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_model_writes_current_format_version() {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let model = DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
            .build()
            .unwrap();
        let engine = Engine::new(model);

        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_version_written.json");
        engine.save_model(&path).unwrap();

        let json = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value.get("format_version").and_then(|v| v.as_u64()),
            Some(u64::from(MODEL_FORMAT_VERSION))
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_model_without_version_loads_and_saves_upgraded() {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let dir = std::env::temp_dir();
        let legacy_path = dir.join("calcula_engine_test_legacy_model.json");
        let upgraded_path = dir.join("calcula_engine_test_upgraded_model.json");

        // Legacy file: no format_version field at all.
        let json = r#"{
            "tables": [],
            "relationships": [],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        std::fs::write(&legacy_path, json).unwrap();

        let loaded = Engine::load_model(&legacy_path).unwrap();
        assert_eq!(loaded.format_version(), 0);

        // Saving upgrades the file to the current format version.
        let engine = Engine::new(loaded);
        engine.save_model(&upgraded_path).unwrap();

        let saved = std::fs::read_to_string(&upgraded_path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(
            value.get("format_version").and_then(|v| v.as_u64()),
            Some(u64::from(MODEL_FORMAT_VERSION))
        );

        // The upgraded file loads back with the current version.
        let reloaded = Engine::load_model(&upgraded_path).unwrap();
        assert_eq!(reloaded.format_version(), MODEL_FORMAT_VERSION);

        let _ = std::fs::remove_file(&legacy_path);
        let _ = std::fs::remove_file(&upgraded_path);
    }

    // -- Measure source re-parse-on-load tests --

    fn sales_model_with_measure(measure: Measure) -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(measure)
            .build()
            .unwrap()
    }

    #[test]
    fn load_model_reparses_measure_from_source_text() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_reparse_source.json");

        // The stored AST is SUM(Sales[amount]) but the source text says
        // COUNT(Sales[id]) — after load, the source must win.
        let model = sales_model_with_measure(
            sum_measure("M", "Sales", "amount").with_source("COUNT(Sales[id])"),
        );
        Engine::new(model).save_model(&path).unwrap();

        let loaded = Engine::load_model(&path).unwrap();
        let m = loaded.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Count));
        assert_eq!(m.simple_column(), Some("id"));
        assert_eq!(m.source(), Some("COUNT(Sales[id])"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_model_keeps_stored_ast_when_source_is_invalid() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_invalid_source.json");

        let model = sales_model_with_measure(
            sum_measure("M", "Sales", "amount").with_source("THIS IS NOT ((( VALID"),
        );
        Engine::new(model).save_model(&path).unwrap();

        // The load must succeed and keep the stored AST.
        let loaded = Engine::load_model(&path).unwrap();
        let m = loaded.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Sum));
        assert_eq!(m.simple_column(), Some("amount"));
        // Source text is preserved so the host can display and fix it.
        assert_eq!(m.source(), Some("THIS IS NOT ((( VALID"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_model_leaves_measure_without_source_untouched() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_no_source.json");

        let model = sales_model_with_measure(sum_measure("M", "Sales", "amount"));
        Engine::new(model).save_model(&path).unwrap();

        let loaded = Engine::load_model(&path).unwrap();
        let m = loaded.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Sum));
        assert_eq!(m.simple_column(), Some("amount"));
        assert_eq!(m.source(), None);

        let _ = std::fs::remove_file(&path);
    }

    // -- Script function inertness (HARD RULE 1) --

    /// Loading a model whose script body is an infinite loop must NOT execute
    /// (or even compile-then-run) the script — deserialization is inert.
    /// If load ever ran the body, this test would hang forever instead of
    /// returning instantly.
    #[test]
    fn load_model_with_infinite_loop_script_is_inert_and_instant() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_inert_script.json");

        // A model JSON carrying a script whose body loops forever. The file
        // is written by hand so we control its exact contents.
        let json = r#"{
            "format_version": 4,
            "tables": [
                { "name": "Sales", "columns": [
                    { "name": "cost", "data_type": "Float64", "nullable": true }
                ] }
            ],
            "relationships": [],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": [],
            "script_functions": [
                {
                    "name": "spin",
                    "params": [ { "name": "x", "ty": "Float" } ],
                    "return_type": "Float",
                    "body": "loop {}"
                }
            ]
        }"#;
        std::fs::write(&path, json).unwrap();

        // This returns immediately. Validation parse-compiles `loop {}`
        // (cheap; compilation is not execution), so the load succeeds without
        // ever running the loop.
        let loaded = Engine::load_model(&path).unwrap();
        assert_eq!(loaded.script_functions().len(), 1);
        assert_eq!(loaded.script_function("spin").unwrap().body(), "loop {}");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_and_load_round_trips_script_functions() {
        use crate::{ScriptFunction, ScriptType};

        let model = DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("cost", DataType::Float64)]).unwrap())
            .add_script_function(
                ScriptFunction::builder("markup")
                    .param("cost", ScriptType::Float)
                    .returns(ScriptType::Float)
                    .body("cost * 1.2")
                    .build(),
            )
            .build()
            .unwrap();

        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_script_roundtrip.json");
        Engine::new(model).save_model(&path).unwrap();

        let loaded = Engine::load_model(&path).unwrap();
        assert_eq!(loaded.script_functions().len(), 1);
        let f = loaded.script_function("markup").unwrap();
        assert_eq!(f.body(), "cost * 1.2");
        assert_eq!(f.return_type(), ScriptType::Float);

        let _ = std::fs::remove_file(&path);
    }
}
