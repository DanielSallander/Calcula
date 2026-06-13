//! Data model schema: a collection of tables, relationships, and measures.

mod builder;
mod validation;

pub use builder::DataModelBuilder;
pub use validation::{apply_lookup_placeholder, LOOKUP_COLUMN_PLACEHOLDER};
pub(crate) use validation::{
    validate_identifier, validate_metadata_text, MAX_METADATA_DESCRIPTION_CHARS,
    MAX_METADATA_NAME_CHARS,
};

#[cfg(test)]
mod builder_tests;
#[cfg(test)]
mod builder_validation_tests;
#[cfg(test)]
mod hierarchy_tests;
#[cfg(test)]
mod metadata_tests;
#[cfg(test)]
mod test_fixtures;

use serde::{Deserialize, Serialize};

use crate::compute::measure::{Measure, MeasureGroup};
use crate::compute::script::ScriptFunction;
use crate::error::{EngineError, EngineResult};
use crate::model::calculated_column::CalculatedColumn;
use crate::model::context::ContextDefinition;
use crate::model::global_variable::GlobalVariable;
use crate::model::hierarchy::Hierarchy;
use crate::model::relationship::Relationship;
use crate::model::table::Table;
use crate::model::table_variable::TableVariable;

/// Current version of the model-file (JSON) format written by this engine.
///
/// **Versioning policy:** bump this constant whenever the serialized model
/// gains content that older engines must not silently drop or destroy —
/// for example a new semantically meaningful struct field, or a new enum
/// variant in a persisted expression tree. Loaders compare a file's
/// `format_version` against this value and refuse files that are newer
/// ([`EngineError::ModelFormatTooNew`]) instead of partially deserializing
/// them; save paths always write the current version. Purely additive
/// metadata that older engines may safely ignore does not require a bump.
///
/// Version history:
/// - `0` — legacy files without a `format_version` field.
/// - `1` — `format_version` introduced; measures may carry `source` text.
/// - `2` — presentation metadata: measures gained `format_string`,
///   `description`, and `is_hidden`; columns gained `display_name`,
///   `description`, `is_hidden`, and `default_aggregation`; tables gained
///   `display_name`, `description`, and `is_hidden`. These fields are
///   authored content — an older engine's load→save round-trip would
///   silently drop them, hence the bump.
/// - `3` — time-intelligence metadata: columns gained `date_role`, the
///   model gained `date_table`, and the persisted expression tree gained
///   the `ToDate` / `PeriodShift` variants (written for measures using
///   `YTD`/`QTD`/`MTD`/`PRIORYEAR`/`PRIORPERIOD`). All of these are
///   authored content an older engine would drop (or fail to parse, for
///   the new expression variants) on a load→save round-trip, hence the
///   bump.
/// - `4` — sandboxed script functions: the model gained `script_functions`,
///   a list of author-defined [`ScriptFunction`]s (Rhai bodies) compiled to
///   scalar UDFs and callable from measures. This is authored, behavior-
///   bearing content an older engine would silently drop on a load→save
///   round-trip — and dropping it would turn every measure that calls the
///   script into an "unknown function" error — hence the bump.
pub const MODEL_FORMAT_VERSION: u32 = 4;

/// A data model consisting of tables and relationships between them.
///
/// Supports star and snowflake schema patterns where fact tables connect
/// to dimension tables via foreign-key relationships.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataModel {
    /// On-disk format version. Legacy files without the field load as `0`;
    /// models built via [`DataModelBuilder`] carry [`MODEL_FORMAT_VERSION`].
    #[serde(default)]
    format_version: u32,
    tables: Vec<Table>,
    relationships: Vec<Relationship>,
    measures: Vec<Measure>,
    calculated_columns: Vec<CalculatedColumn>,
    measure_groups: Vec<MeasureGroup>,
    #[serde(default)]
    contexts: Vec<ContextDefinition>,
    #[serde(default)]
    table_variables: Vec<TableVariable>,
    #[serde(default)]
    global_variables: Vec<GlobalVariable>,
    #[serde(default)]
    hierarchies: Vec<Hierarchy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_lookup_resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    date_table: Option<String>,
    /// Author-defined sandboxed script functions (Rhai), compiled to scalar
    /// UDFs and callable from measures. Empty by default and skipped on
    /// serialization when empty (back-compat with pre-v4 model files).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    script_functions: Vec<ScriptFunction>,
}

impl DataModel {
    /// Create a builder for constructing a `DataModel`.
    pub fn builder() -> DataModelBuilder {
        DataModelBuilder {
            tables: Vec::new(),
            relationships: Vec::new(),
            measures: Vec::new(),
            calculated_columns: Vec::new(),
            measure_groups: Vec::new(),
            contexts: Vec::new(),
            table_variables: Vec::new(),
            global_variables: Vec::new(),
            hierarchies: Vec::new(),
            default_lookup_resolution: None,
            date_table: None,
            script_functions: Vec::new(),
        }
    }

    /// Returns the model-file format version this model was built or
    /// loaded with.
    ///
    /// Models constructed via [`DataModel::builder`] carry the current
    /// [`MODEL_FORMAT_VERSION`]; models deserialized from legacy files
    /// (no `format_version` field) report `0`.
    pub fn format_version(&self) -> u32 {
        self.format_version
    }

    /// Returns all tables in the model.
    pub fn tables(&self) -> &[Table] {
        &self.tables
    }

    /// Look up a table by name.
    pub fn table(&self, name: &str) -> EngineResult<&Table> {
        self.tables
            .iter()
            .find(|t| t.name() == name)
            .ok_or_else(|| EngineError::TableNotFound(name.to_string()))
    }

    /// Returns all relationships in the model.
    pub fn relationships(&self) -> &[Relationship] {
        &self.relationships
    }

    /// Look up a relationship by name.
    pub fn relationship(&self, name: &str) -> EngineResult<&Relationship> {
        self.relationships
            .iter()
            .find(|r| r.name() == name)
            .ok_or_else(|| EngineError::RelationshipNotFound(name.to_string()))
    }

    /// Returns all measures in the model.
    pub fn measures(&self) -> &[Measure] {
        &self.measures
    }

    /// Look up a measure by name.
    pub fn measure(&self, name: &str) -> EngineResult<&Measure> {
        self.measures
            .iter()
            .find(|m| m.name() == name)
            .ok_or_else(|| EngineError::MeasureNotFound(name.to_string()))
    }

    /// Returns all calculated columns in the model.
    pub fn calculated_columns(&self) -> &[CalculatedColumn] {
        &self.calculated_columns
    }

    /// Returns all measure groups in the model.
    pub fn measure_groups(&self) -> &[MeasureGroup] {
        &self.measure_groups
    }

    /// Returns all context definitions in the model.
    pub fn contexts(&self) -> &[ContextDefinition] {
        &self.contexts
    }

    /// Look up a context definition by name.
    pub fn context(&self, name: &str) -> EngineResult<&ContextDefinition> {
        self.contexts
            .iter()
            .find(|c| c.name() == name)
            .ok_or_else(|| EngineError::ContextNotFound(name.to_string()))
    }

    /// Returns all table variables in the model.
    pub fn table_variables(&self) -> &[TableVariable] {
        &self.table_variables
    }

    /// Look up a table variable by name.
    pub fn table_variable(&self, name: &str) -> EngineResult<&TableVariable> {
        self.table_variables
            .iter()
            .find(|tv| tv.name() == name)
            .ok_or_else(|| EngineError::TableVariableNotFound(name.to_string()))
    }

    /// Returns all global variables in the model.
    pub fn global_variables(&self) -> &[GlobalVariable] {
        &self.global_variables
    }

    /// Look up a global variable by name.
    pub fn global_variable(&self, name: &str) -> EngineResult<&GlobalVariable> {
        self.global_variables
            .iter()
            .find(|gv| gv.name() == name)
            .ok_or_else(|| EngineError::GlobalVariableNotFound(name.to_string()))
    }

    /// Returns all hierarchies in the model.
    pub fn hierarchies(&self) -> &[Hierarchy] {
        &self.hierarchies
    }

    /// Look up a hierarchy by name.
    pub fn hierarchy(&self, name: &str) -> EngineResult<&Hierarchy> {
        self.hierarchies
            .iter()
            .find(|h| h.name() == name)
            .ok_or_else(|| EngineError::HierarchyNotFound(name.to_string()))
    }

    /// Returns all script functions defined in the model.
    pub fn script_functions(&self) -> &[ScriptFunction] {
        &self.script_functions
    }

    /// Look up a script function by name (exact match).
    pub fn script_function(&self, name: &str) -> EngineResult<&ScriptFunction> {
        self.script_functions
            .iter()
            .find(|f| f.name() == name)
            .ok_or_else(|| EngineError::ScriptError {
                function: name.to_string(),
                position: None,
                message: "script function not found in model".to_string(),
            })
    }

    /// Returns all hierarchies that belong to a specific table.
    pub fn hierarchies_for_table(&self, table_name: &str) -> Vec<&Hierarchy> {
        self.hierarchies
            .iter()
            .filter(|h| h.table() == table_name)
            .collect()
    }

    /// Returns the effective sort column name for a column in a table.
    ///
    /// If the column has a `sort_by_column` set, returns that column name.
    /// Otherwise returns the column's own name (natural sort).
    pub fn sort_column_for<'a>(
        &'a self,
        table_name: &str,
        column_name: &'a str,
    ) -> EngineResult<&'a str> {
        let table = self.table(table_name)?;
        table.sort_column_for(column_name)
    }

    /// Returns the model-level default lookup resolution expression, if set.
    ///
    /// When a column has no per-column `lookup_resolution`, this expression is
    /// used instead of the built-in `MIN(col)` fallback.
    pub fn default_lookup_resolution(&self) -> Option<&str> {
        self.default_lookup_resolution.as_deref()
    }

    /// Returns the name of the table marked as the model's date table, if any.
    ///
    /// The date table (marked via
    /// [`DataModelBuilder::mark_date_table`]) is the calendar dimension whose
    /// [`DateRole`](crate::model::DateRole)-tagged columns power
    /// time-intelligence functions (`YTD`, `QTD`, `MTD`, `PRIORYEAR`,
    /// `PRIORPERIOD`).
    pub fn date_table(&self) -> Option<&str> {
        self.date_table.as_deref()
    }

    /// Returns all measures that belong to a specific group.
    pub fn measures_in_group(&self, group_name: &str) -> Vec<&Measure> {
        self.measures
            .iter()
            .filter(|m| m.group() == Some(group_name))
            .collect()
    }

    /// Returns calculated columns for a specific table.
    pub fn calculated_columns_for_table(&self, table_name: &str) -> Vec<&CalculatedColumn> {
        self.calculated_columns
            .iter()
            .filter(|cc| cc.table() == table_name)
            .collect()
    }

    /// Returns all relationships where the given table appears on either side.
    pub fn relationships_for_table(&self, table_name: &str) -> Vec<&Relationship> {
        self.relationships
            .iter()
            .filter(|r| r.from_table() == table_name || r.to_table() == table_name)
            .collect()
    }

    /// Validate the data model after deserialization.
    ///
    /// The builder performs validation automatically during `build()`, but
    /// when deserializing a `DataModel` directly (e.g., from JSON), call
    /// this method to ensure all invariants hold.
    pub fn validate(&self) -> EngineResult<()> {
        let mut builder = DataModel::builder();
        for t in &self.tables {
            builder = builder.add_table(t.clone());
        }
        for r in &self.relationships {
            builder = builder.add_relationship(r.clone());
        }
        for mg in &self.measure_groups {
            builder = builder.add_measure_group(mg.clone());
        }
        for m in &self.measures {
            builder = builder.add_measure(m.clone());
        }
        for cc in &self.calculated_columns {
            builder = builder.add_calculated_column(cc.clone());
        }
        for ctx in &self.contexts {
            builder = builder.add_context(ctx.clone());
        }
        for tv in &self.table_variables {
            builder = builder.add_table_variable(tv.clone());
        }
        for gv in &self.global_variables {
            builder = builder.add_global_variable(gv.clone());
        }
        for h in &self.hierarchies {
            builder = builder.add_hierarchy(h.clone());
        }
        for sf in &self.script_functions {
            builder = builder.add_script_function(sf.clone());
        }
        if let Some(dlr) = &self.default_lookup_resolution {
            builder = builder.default_lookup_resolution(dlr.clone());
        }
        if let Some(dt) = &self.date_table {
            builder = builder.mark_date_table(dt.clone());
        }
        builder.build()?;
        Ok(())
    }

    /// Re-parse every measure that carries source text, replacing its
    /// stored expression tree with the freshly parsed one.
    ///
    /// A measure's source text (see [`Measure::source`]) is the
    /// authoritative, human-readable definition; the serialized expression
    /// AST acts as a cache of the last successful parse. Calling this
    /// after deserializing a model re-applies the *current* parser's
    /// grammar and validation to each measure. If a measure's source no
    /// longer parses (e.g. it uses syntax from a newer engine), the
    /// stored AST is kept unchanged so the model still loads — the
    /// measure simply behaves as it last parsed. Measures without source
    /// text (built programmatically from expression values) are left
    /// untouched.
    ///
    /// This lives on `DataModel` rather than as a public expression
    /// setter on [`Measure`]: the swap must recompute the measure's
    /// cached fact table, and a general-purpose public setter would let
    /// hosts desynchronize a measure's source text from its AST.
    pub fn reparse_measures_from_source(&mut self) {
        for measure in &mut self.measures {
            let Some(text) = measure.source() else {
                continue;
            };
            let reparsed = crate::compute::parser::parse_measure_expression(text);
            if let Ok(expression) = reparsed {
                measure.set_expression(expression);
            }
        }
    }

    /// Find the active relationship between two tables (searches both directions).
    ///
    /// Returns the first **active** relationship where one table is on the "from"
    /// side and the other is on the "to" side. Inactive relationships (used via
    /// `USERELATIONSHIP`) are skipped.
    pub fn find_relationship(&self, table_a: &str, table_b: &str) -> EngineResult<&Relationship> {
        self.relationships
            .iter()
            .find(|r| {
                r.is_active()
                    && ((r.from_table() == table_a && r.to_table() == table_b)
                        || (r.from_table() == table_b && r.to_table() == table_a))
            })
            .ok_or_else(|| {
                EngineError::RelationshipNotFound(format!(
                    "No active relationship between '{table_a}' and '{table_b}'"
                ))
            })
    }

    /// Find any relationship between two tables (active or inactive).
    ///
    /// Unlike [`find_relationship`](Self::find_relationship), this does not
    /// filter by active status. Used internally for validation.
    pub fn find_any_relationship(
        &self,
        table_a: &str,
        table_b: &str,
    ) -> EngineResult<&Relationship> {
        self.relationships
            .iter()
            .find(|r| {
                (r.from_table() == table_a && r.to_table() == table_b)
                    || (r.from_table() == table_b && r.to_table() == table_a)
            })
            .ok_or_else(|| {
                EngineError::RelationshipNotFound(format!(
                    "No relationship between '{table_a}' and '{table_b}'"
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::{products_table, sales_products_relationship, sales_table};
    use super::*;

    #[test]
    fn datamodel_json_roundtrip() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(sales_products_relationship())
            .build()
            .unwrap();

        let json = serde_json::to_string_pretty(&model).unwrap();
        let deserialized: DataModel = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.tables().len(), 2);
        assert_eq!(deserialized.relationships().len(), 1);
        assert_eq!(deserialized.table("Sales").unwrap().columns().len(), 4);
        assert!(deserialized.validate().is_ok());
    }

    #[test]
    fn datamodel_json_roundtrip_with_measures() {
        use crate::compute::measure::sum_measure;

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();

        let json = serde_json::to_string(&model).unwrap();
        let deserialized: DataModel = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.measures().len(), 1);
        assert_eq!(deserialized.measures()[0].name(), "Revenue");
        assert!(deserialized.validate().is_ok());
    }

    #[test]
    fn built_model_has_current_format_version() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .build()
            .unwrap();
        assert_eq!(model.format_version(), MODEL_FORMAT_VERSION);
    }

    #[test]
    fn legacy_json_without_format_version_deserializes_as_zero_and_validates() {
        let json = r#"{
            "tables": [],
            "relationships": [],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        let model: DataModel = serde_json::from_str(json).unwrap();
        assert_eq!(model.format_version(), 0);
        model.validate().unwrap();
        // Validation rebuilds via the builder but must not alter the
        // original model's stored version.
        assert_eq!(model.format_version(), 0);
    }

    // --- Measure re-parse tests ---

    #[test]
    fn reparse_measures_from_source_replaces_expression_when_source_parses() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::sum_measure;

        // Stored AST is SUM(amount); the source text says COUNT(id).
        let mut model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("M", "Sales", "amount").with_source("COUNT(Sales[id])"))
            .build()
            .unwrap();

        model.reparse_measures_from_source();

        let m = model.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Count));
        assert_eq!(m.simple_column(), Some("id"));
        assert_eq!(m.table(), "Sales");
    }

    #[test]
    fn reparse_measures_from_source_keeps_ast_when_source_is_invalid() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::sum_measure;

        let mut model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("M", "Sales", "amount").with_source("NOT ((( PARSEABLE"))
            .build()
            .unwrap();

        model.reparse_measures_from_source();

        let m = model.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Sum));
        assert_eq!(m.simple_column(), Some("amount"));
        // Source is preserved for the host to display and fix.
        assert_eq!(m.source(), Some("NOT ((( PARSEABLE"));
    }

    #[test]
    fn reparse_measures_from_source_leaves_sourceless_measures_untouched() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::sum_measure;

        let mut model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("M", "Sales", "amount"))
            .build()
            .unwrap();

        model.reparse_measures_from_source();

        let m = model.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Sum));
        assert_eq!(m.source(), None);
    }
}
