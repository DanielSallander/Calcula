//! What a step may know about the OTHER tables in its model.
//!
//! A pipeline is single-table almost everywhere, and deliberately so. The one
//! exception — [`LookupColumn`](crate::transform::TransformStep::LookupColumn)
//! — needs two different things about the target table at two different times,
//! and keeping them apart is what preserves the property the whole feature
//! rests on:
//!
//! * **Deriving a schema** needs the target's DECLARED COLUMNS and nothing
//!   else. No rows are read, so `derive_pipeline_schema` stays an offline
//!   function a host can call on every keystroke and a reviewer can trust
//!   without a connection.
//! * **Evaluating** additionally needs the target's ROWS, which only the
//!   `engine` facade can supply — `engine-core` does no I/O, so the batches are
//!   handed in.
//!
//! Hence one trait for the first ([`TableSchemas`]) and one struct for the
//! second ([`StepInputs`]), where the struct *implements* the trait so
//! evaluation answers both questions from one value.

use std::collections::BTreeMap;

use arrow::record_batch::RecordBatch;

use crate::model::Column;

/// The declared columns of the other tables a pipeline may look into.
///
/// Declared, not derived: `validate_table_transformations` already forces
/// every table's declared columns to equal what its own pipeline derives, so
/// the declaration IS the post-pipeline shape — and reading it needs no
/// recursion into another table's steps.
pub trait TableSchemas {
    /// The declared columns of `table`, or `None` when the model has no such
    /// table. Matched case-insensitively, like every other table lookup.
    fn columns_of(&self, table: &str) -> Option<&[Column]>;
}

/// A model with no other tables — every step that does not look up.
///
/// Lets a single-table caller (a unit test, a host deriving a schema for a
/// table it has in hand) pass something honest without inventing a catalog.
/// A lookup step validated against this is refused with "unknown table", which
/// is the truth for a caller that supplied no tables.
pub struct NoOtherTables;

impl TableSchemas for NoOtherTables {
    fn columns_of(&self, _table: &str) -> Option<&[Column]> {
        None
    }
}

impl<T: TableSchemas + ?Sized> TableSchemas for &T {
    fn columns_of(&self, table: &str) -> Option<&[Column]> {
        (**self).columns_of(table)
    }
}

/// The other tables' data AND declared columns, for evaluating a pipeline.
///
/// Carries `Vec<Column>` beside each batch deliberately. `apply_steps`
/// re-derives every step's schema as it goes and re-parses every expression,
/// so evaluation asks the same schema questions validation does — and
/// answering them from the Arrow schema instead would mean reconstructing
/// model types from a batch that `optimize_batch` may have dictionary-encoded
/// or narrowed. The declared columns are already known; passing them is
/// cheaper and cannot disagree.
///
/// A `RecordBatch` clone is `Arc`-cheap, so building one of these per refresh
/// copies pointers, not rows.
#[derive(Debug, Clone, Default)]
pub struct StepInputs {
    tables: BTreeMap<String, (RecordBatch, Vec<Column>)>,
}

impl StepInputs {
    /// No other tables — the ordinary single-table pipeline.
    pub fn none() -> Self {
        Self::default()
    }

    /// Record one table's rows and declared columns.
    pub fn with_table(
        mut self,
        name: impl Into<String>,
        batch: RecordBatch,
        columns: Vec<Column>,
    ) -> Self {
        self.tables
            .insert(name.into().to_lowercase(), (batch, columns));
        self
    }

    /// The rows of `table`, if it was supplied.
    pub fn batch_of(&self, table: &str) -> Option<&RecordBatch> {
        self.tables.get(&table.to_lowercase()).map(|(b, _)| b)
    }

    /// Whether any table was supplied.
    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }
}

impl TableSchemas for StepInputs {
    fn columns_of(&self, table: &str) -> Option<&[Column]> {
        self.tables
            .get(&table.to_lowercase())
            .map(|(_, columns)| columns.as_slice())
    }
}

/// The declared columns of a slice of model tables.
///
/// The shape both model validation and the host's schema derivation want: they
/// hold the whole table list already.
pub struct ModelTableSchemas<'a> {
    tables: &'a [crate::model::Table],
}

impl<'a> ModelTableSchemas<'a> {
    /// Read schemas out of these tables.
    pub fn new(tables: &'a [crate::model::Table]) -> Self {
        Self { tables }
    }
}

impl TableSchemas for ModelTableSchemas<'_> {
    fn columns_of(&self, table: &str) -> Option<&[Column]> {
        self.tables
            .iter()
            .find(|t| t.name().eq_ignore_ascii_case(table))
            .map(|t| t.columns())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DataType;

    fn columns() -> Vec<Column> {
        vec![Column::new("id", DataType::Int64)]
    }

    #[test]
    fn no_other_tables_answers_nothing() {
        assert!(NoOtherTables.columns_of("Anything").is_none());
    }

    #[test]
    fn step_inputs_match_table_names_case_insensitively() {
        // Model table names are matched case-insensitively everywhere else; a
        // lookup written `table=customers` against a `Customers` table must
        // find its rows, not silently miss them.
        let batch = RecordBatch::new_empty(std::sync::Arc::new(arrow::datatypes::Schema::empty()));
        let inputs = StepInputs::none().with_table("Customers", batch, columns());
        assert!(inputs.columns_of("customers").is_some());
        assert!(inputs.columns_of("CUSTOMERS").is_some());
        assert!(inputs.batch_of("cUsToMeRs").is_some());
        assert!(inputs.columns_of("Orders").is_none());
    }

    #[test]
    fn model_table_schemas_reads_declared_columns() {
        let table = crate::model::Table::new("Customers", columns()).unwrap();
        let tables = vec![table];
        let schemas = ModelTableSchemas::new(&tables);
        assert_eq!(schemas.columns_of("customers").unwrap().len(), 1);
        assert!(schemas.columns_of("Missing").is_none());
    }
}
