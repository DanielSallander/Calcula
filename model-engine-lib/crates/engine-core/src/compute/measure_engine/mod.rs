//! MeasureEngine: evaluates measures against in-memory data.
//!
//! The engine takes a `DataModel` and `ColumnStore` and computes measure
//! results as scalar values or grouped `RecordBatch` results. It handles
//! single-table and cross-table (star-schema) evaluations, materializing
//! calculated columns as needed.
//!
//! The implementation is split across submodules:
//! - [`scalar`](self): scalar (ungrouped) evaluation entry points
//! - `grouped`: grouped evaluation, including the pre-aggregate path for
//!   unsafe (many-to-many / non-equi) dimensions
//! - `boundary`: compound-expression boundary decomposition
//! - `query_blocks`: two-stage QUERY-in-VAR evaluation
//! - `sql`: shared SQL assembly helpers

mod boundary;
mod grouped;
mod query_blocks;
mod scalar;
mod sql;

#[cfg(test)]
mod query_block_tests;
#[cfg(test)]
mod test_fixtures;

use std::sync::Arc;

use datafusion::prelude::SessionContext;

use crate::compute::aggregate::AggregateResult;
use crate::compute::udf::{session_context_with_udfs, UdfRegistry};
use crate::error::EngineResult;
use crate::model::schema::DataModel;
use crate::store::ColumnStore;

/// Evaluates measures against in-memory data in a `ColumnStore`.
///
/// The `MeasureEngine` is the primary API for computing measure results
/// against locally stored data. It resolves measures from the `DataModel`,
/// materializes calculated columns when needed, and uses DataFusion for
/// computation.
pub struct MeasureEngine<'a> {
    model: &'a DataModel,
    store: &'a ColumnStore,
    /// Host-registered UDFs, registered into every DataFusion session this
    /// engine creates. Empty by default ([`MeasureEngine::new`]).
    udfs: Arc<UdfRegistry>,
}

impl<'a> MeasureEngine<'a> {
    /// Create a new MeasureEngine with no host-registered UDFs.
    pub fn new(model: &'a DataModel, store: &'a ColumnStore) -> Self {
        Self {
            model,
            store,
            udfs: Arc::new(UdfRegistry::new()),
        }
    }

    /// Create a MeasureEngine with host-registered UDFs.
    ///
    /// Measure expressions containing
    /// [`Expression::Call`](crate::compute::expression::Expression::Call)
    /// nodes resolve against `udfs` during evaluation.
    pub fn with_udfs(model: &'a DataModel, store: &'a ColumnStore, udfs: Arc<UdfRegistry>) -> Self {
        Self { model, store, udfs }
    }

    /// Create a DataFusion session with this engine's UDFs registered.
    ///
    /// Every evaluation path creates its session through this helper so UDF
    /// calls resolve uniformly.
    pub(crate) fn session_context(&self) -> SessionContext {
        session_context_with_udfs(&self.udfs)
    }

    /// The host-registered UDF registry this engine evaluates against.
    pub(crate) fn udfs(&self) -> &UdfRegistry {
        &self.udfs
    }

    /// Evaluate a single measure by name, returning a scalar result.
    pub async fn evaluate(&self, measure_name: &str) -> EngineResult<AggregateResult> {
        self.evaluate_with_outer_filters(measure_name, &[]).await
    }

    /// Evaluate multiple measures at once, returning scalar results.
    pub async fn evaluate_many(
        &self,
        measure_names: &[&str],
    ) -> EngineResult<Vec<AggregateResult>> {
        let mut results = Vec::with_capacity(measure_names.len());
        for name in measure_names {
            results.push(self.evaluate(name).await?);
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::{populated_store, single_table_model};
    use super::MeasureEngine;
    use crate::compute::measure::sum_measure;
    use crate::model::column::Column;
    use crate::model::schema::DataModel;
    use crate::model::table::Table;
    use crate::store::ColumnStore;
    use crate::types::DataType;

    #[tokio::test]
    async fn evaluate_many_measures() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let results = engine
            .evaluate_many(&["TotalAmount", "OrderCount"])
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].as_f64(), Some(100.0));
    }

    #[tokio::test]
    async fn evaluate_nonexistent_measure_errors() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("NonExistent").await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[tokio::test]
    async fn evaluate_table_not_in_store_errors() {
        let model = DataModel::builder()
            .add_table(Table::new("Missing", vec![Column::new("x", DataType::Float64)]).unwrap())
            .add_measure(sum_measure("Total", "Missing", "x"))
            .build()
            .unwrap();

        let store = ColumnStore::new(); // empty
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("Total").await;
        assert!(result.is_err());
    }
}
