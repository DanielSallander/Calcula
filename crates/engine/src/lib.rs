//! # Calcula Engine
//!
//! Unified API for the Calcula analytical engine library.
//!
//! This crate re-exports key types from `engine-core`, `engine-connectors`,
//! and `engine-query`, and provides a high-level [`Engine`] struct that
//! coordinates data model management, source registration, and query
//! execution.
//!
//! # Example
//!
//! ```rust,no_run
//! use engine::*;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let model = DataModel::builder()
//!     .add_table(Table::new("Sales", vec![
//!         Column::new("id", DataType::Int64),
//!         Column::new("amount", DataType::Float64),
//!     ])?)
//!     .add_measure(sum_measure("Revenue", "Sales", "amount"))
//!     .build()?;
//!
//! let mut engine = Engine::new(model);
//! let pg_idx = engine
//!     .add_postgres(PostgresConfig::new("postgresql://user:pass@localhost/db"))
//!     .await?;
//! engine.bind_table("Sales", pg_idx, SourceBinding::new("public", "sales"));
//!
//! let results = engine.query(QueryRequest {
//!     measures: vec!["Revenue".into()],
//!     group_by: vec![],
//!     filters: vec![],
//!     lookups: vec![],
//! }).await?;
//! # Ok(())
//! # }
//! ```

use std::path::Path;
use std::time::Instant;

use arrow::record_batch::RecordBatch;

// --- Re-exports from engine-core ---

pub use engine_core::compute::aggregate::AggregateOp;
pub use engine_core::compute::context::{
    ContextResolver, EvaluationContext, FilterSource, ResolvedFilter, ResolvedInFilter,
};
pub use engine_core::compute::expression::{
    self, expand_global_variables, infer_fact_table, ArithmeticOp, ComparisonOp, Expression,
    FilterPredicate, InPredicate, RelationshipPath,
};
pub use engine_core::compute::measure::{
    average_measure, count_measure, distinct_count_measure, expression_measure, sum_measure,
    Measure, MeasureGroup,
};
pub use engine_core::compute::measure_engine::MeasureEngine;
pub use engine_core::compute::parser::{
    parse_context, parse_global, parse_measure, parse_measure_expression, parse_table_variable,
};
pub use engine_core::compute::plan::{
    ExecutionPlan, PlanDuration, PlanNode, PlanOperation, PlanProperty, PlanValue,
};
pub use engine_core::error::{EngineError, EngineResult};
pub use engine_core::model::{
    CalculatedColumn, Cardinality, ClearTarget, Column, ContextDefinition, ContextOp, DataModel,
    DataModelBuilder, FilterPropagation, GlobalVariable, JoinCondition, JoinOperator, Relationship,
    Table, TableVariable,
};
pub use engine_core::store::{ColumnStore, TableData};
pub use engine_core::types::{DataType, TableColumn, Value};

// --- Re-exports from engine-connectors ---

pub use engine_connectors::postgres::{PostgresConfig, PostgresConnector};
pub use engine_connectors::sqlserver::{SqlServerConfig, SqlServerConnector};
pub use engine_connectors::traits::{
    AggregateExpr, AggregateFunction, Connector, FetchRequest, FilterCondition, FilterOperator,
    SourceTable,
};
pub use engine_connectors::{ConnectorError, ConnectorResult};

// --- Re-exports from engine-query ---

pub use engine_query::error::{QueryError, QueryResult};
pub use engine_query::registry::{AnyConnector, SourceBinding, SourceRegistry};
pub use engine_query::request::{ColumnRef, LookupColumn, QueryRequest};
pub use engine_query::{LookupSpec, PushdownPlanner, QueryExecutor, QueryPlan};

// ---------------------------------------------------------------------------

/// High-level engine facade coordinating model, sources, and queries.
///
/// The `Engine` owns a [`DataModel`] and a [`SourceRegistry`], providing
/// a single entry point for the host application.
pub struct Engine {
    model: DataModel,
    registry: SourceRegistry,
}

impl Engine {
    /// Create a new engine with the given data model.
    pub fn new(model: DataModel) -> Self {
        Self {
            model,
            registry: SourceRegistry::new(),
        }
    }

    /// Register a PostgreSQL data source and return its connector index.
    pub async fn add_postgres(&mut self, config: PostgresConfig) -> ConnectorResult<usize> {
        let connector = PostgresConnector::connect(config).await?;
        let idx = self
            .registry
            .add_connector(AnyConnector::Postgres(connector));
        Ok(idx)
    }

    /// Register a SQL Server data source and return its connector index.
    pub async fn add_sqlserver(&mut self, config: SqlServerConfig) -> ConnectorResult<usize> {
        let connector = SqlServerConnector::connect(config).await?;
        let idx = self
            .registry
            .add_connector(AnyConnector::SqlServer(connector));
        Ok(idx)
    }

    /// Bind a model table name to a registered connector and source location.
    pub fn bind_table(
        &mut self,
        model_table: impl Into<String>,
        connector_index: usize,
        binding: SourceBinding,
    ) {
        self.registry.bind(model_table, connector_index, binding);
    }

    /// Execute a query against the model using registered data sources.
    ///
    /// The query planner decides what to push down and what to compute locally.
    pub async fn query(&self, request: QueryRequest) -> QueryResult<Vec<RecordBatch>> {
        let plan = PushdownPlanner::plan(&request, &self.model, &self.registry)?;
        QueryExecutor::execute(&plan, &self.model, &self.registry).await
    }

    /// Execute a query and return results with an execution plan.
    ///
    /// Like [`Engine::query`], but also returns an [`ExecutionPlan`] describing
    /// each phase of execution with timing and decision metadata.
    pub async fn query_explained(
        &self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, ExecutionPlan)> {
        let start = Instant::now();

        let (query_plan, pushdown_node) =
            PushdownPlanner::plan_explained(&request, &self.model, &self.registry)?;
        let (batches, exec_node) =
            QueryExecutor::execute_explained(&query_plan, &self.model, &self.registry).await?;

        let total_duration = start.elapsed();

        // Build summary.
        let measures_str = request.measures.join(", ");
        let summary = if request.group_by.is_empty() {
            format!("Query: [{measures_str}]")
        } else {
            let dims: Vec<String> = request
                .group_by
                .iter()
                .map(|c| format!("{}.{}", c.table, c.column))
                .collect();
            format!("Query: [{measures_str}] grouped by [{}]", dims.join(", "))
        };

        let root = PlanNode::new(PlanOperation::Planning, "Query Execution")
            .with_duration(total_duration)
            .with_child(pushdown_node)
            .with_child(exec_node);

        let plan = ExecutionPlan {
            summary,
            total_duration: total_duration.into(),
            root,
        };

        Ok((batches, plan))
    }

    /// Replace the data model, keeping the source registry intact.
    ///
    /// Existing table bindings remain valid as long as the new model contains
    /// the same table names.
    pub fn set_model(&mut self, model: DataModel) {
        self.model = model;
    }

    /// Returns a reference to the data model.
    pub fn model(&self) -> &DataModel {
        &self.model
    }

    /// Returns a reference to the source registry.
    pub fn registry(&self) -> &SourceRegistry {
        &self.registry
    }

    /// Returns a mutable reference to the source registry.
    pub fn registry_mut(&mut self) -> &mut SourceRegistry {
        &mut self.registry
    }

    /// Save the data model to a JSON file.
    pub fn save_model(&self, path: &Path) -> EngineResult<()> {
        let json = serde_json::to_string_pretty(&self.model)
            .map_err(|e| EngineError::InvalidData(format!("JSON serialization failed: {e}")))?;
        std::fs::write(path, json)
            .map_err(|e| EngineError::InvalidData(format!("failed to write file: {e}")))?;
        Ok(())
    }

    /// Load a data model from a JSON file.
    ///
    /// Validates the model after loading. Returns an error if the file
    /// cannot be read, the JSON is invalid, or the model fails validation.
    pub fn load_model(path: &Path) -> EngineResult<DataModel> {
        let json = std::fs::read_to_string(path)
            .map_err(|e| EngineError::InvalidData(format!("failed to read file: {e}")))?;
        let model: DataModel = serde_json::from_str(&json)
            .map_err(|e| EngineError::InvalidData(format!("JSON parse failed: {e}")))?;
        model.validate()?;
        Ok(model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_new_creates_empty_registry() {
        let model = DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
            .build()
            .unwrap();

        let engine = Engine::new(model);
        assert_eq!(engine.model().tables().len(), 1);
        assert!(!engine.registry().has_table("Sales"));
    }

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
}
