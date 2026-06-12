//! Data model schema: a collection of tables, relationships, and measures.

use serde::{Deserialize, Serialize};

use crate::compute::expression::Expression;
use crate::compute::measure::{Measure, MeasureGroup};
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
pub const MODEL_FORMAT_VERSION: u32 = 1;

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
        if let Some(dlr) = &self.default_lookup_resolution {
            builder = builder.default_lookup_resolution(dlr.clone());
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

/// Characters rejected in model identifiers.
///
/// These can break out of quoted SQL identifiers (`"`, `[`, `]`, `'`, `;`)
/// or escape file/path contexts (`\`, `/`). Names with inner spaces, single
/// dots, unicode letters, or parentheses remain legal — BI models
/// legitimately use names like "Sales Amount".
const FORBIDDEN_IDENTIFIER_CHARS: [char; 7] = ['"', '[', ']', '\'', ';', '\\', '/'];

/// Validate a model identifier (table, column, calculated-column, or
/// measure name) before it can reach SQL generation or file naming.
///
/// Rejects names that are empty/whitespace-only, have leading or trailing
/// whitespace, contain control characters, contain any of
/// [`FORBIDDEN_IDENTIFIER_CHARS`], or contain the path-traversal sequence
/// `..`.
///
/// Also used by `Expression::validate()` for table references embedded in
/// expression trees, which are rendered as raw (unquoted) SQL qualifiers.
pub(crate) fn validate_identifier(name: &str, kind: &str) -> EngineResult<()> {
    let invalid = |reason: String| EngineError::InvalidIdentifier {
        name: name.to_string(),
        reason,
    };
    if name.trim().is_empty() {
        return Err(invalid(format!(
            "{kind} name must not be empty or whitespace-only"
        )));
    }
    if name != name.trim() {
        return Err(invalid(format!(
            "{kind} name must not have leading or trailing whitespace"
        )));
    }
    if name.contains("..") {
        return Err(invalid(format!(
            "{kind} name must not contain the sequence '..'"
        )));
    }
    for c in name.chars() {
        if c < '\u{20}' || c == '\u{7f}' {
            return Err(invalid(format!(
                "{kind} name must not contain control characters"
            )));
        }
        if FORBIDDEN_IDENTIFIER_CHARS.contains(&c) {
            return Err(invalid(format!("{kind} name must not contain '{c}'")));
        }
    }
    Ok(())
}

/// Reserved placeholder identifier for the model-level default lookup
/// resolution expression
/// ([`DataModelBuilder::default_lookup_resolution`]).
///
/// In the default expression, the bare identifier `__column`
/// (case-insensitive) stands for the lookup column the expression is being
/// applied to. It is rewritten to the actual column at query time via
/// [`apply_lookup_placeholder`].
pub const LOOKUP_COLUMN_PLACEHOLDER: &str = "__column";

/// Rewrite the [`LOOKUP_COLUMN_PLACEHOLDER`] in a parsed model-level default
/// lookup resolution expression to a reference to `column_name`.
///
/// The placeholder must appear as a bare identifier — a table-qualified
/// `dim[__column]` cannot be rewritten and is rejected. An expression that
/// does not reference the placeholder at all is also rejected: it would
/// silently resolve the same hard-coded column for every lookup it is
/// applied to.
pub fn apply_lookup_placeholder(
    expression: &Expression,
    column_name: &str,
) -> EngineResult<Expression> {
    // Collect the exact spellings used for the placeholder: the comparison
    // is case-insensitive, but substitution matches names exactly.
    let spellings: Vec<String> = expression
        .column_references()
        .iter()
        .filter(|r| r.eq_ignore_ascii_case(LOOKUP_COLUMN_PLACEHOLDER))
        .map(|r| (*r).to_string())
        .collect();
    if spellings.is_empty() {
        return Err(EngineError::InvalidLookup {
            table: "(model)".to_string(),
            column: "default_lookup_resolution".to_string(),
            reason: format!(
                "expression must reference the lookup column via the \
                 '{LOOKUP_COLUMN_PLACEHOLDER}' placeholder, \
                 e.g. \"MAX({LOOKUP_COLUMN_PLACEHOLDER})\""
            ),
        });
    }

    let env: std::collections::HashMap<String, Expression> = spellings
        .into_iter()
        .map(|s| (s, Expression::ColumnRef(column_name.to_string())))
        .collect();
    let rewritten = expression.substitute_vars(&env);

    // A table-qualified placeholder (`dim[__column]`) is not substituted by
    // `substitute_vars` — reject it instead of silently rendering a
    // reference to a non-existent "__column" column.
    if rewritten
        .column_references()
        .iter()
        .any(|r| r.eq_ignore_ascii_case(LOOKUP_COLUMN_PLACEHOLDER))
    {
        return Err(EngineError::InvalidLookup {
            table: "(model)".to_string(),
            column: "default_lookup_resolution".to_string(),
            reason: format!(
                "the '{LOOKUP_COLUMN_PLACEHOLDER}' placeholder must be a bare \
                 identifier (not table-qualified)"
            ),
        });
    }
    Ok(rewritten)
}

/// Builder for constructing a [`DataModel`] incrementally.
pub struct DataModelBuilder {
    tables: Vec<Table>,
    relationships: Vec<Relationship>,
    measures: Vec<Measure>,
    calculated_columns: Vec<CalculatedColumn>,
    measure_groups: Vec<MeasureGroup>,
    contexts: Vec<ContextDefinition>,
    table_variables: Vec<TableVariable>,
    global_variables: Vec<GlobalVariable>,
    hierarchies: Vec<Hierarchy>,
    default_lookup_resolution: Option<String>,
}

impl DataModelBuilder {
    /// Add a table to the model.
    pub fn add_table(mut self, table: Table) -> Self {
        self.tables.push(table);
        self
    }

    /// Add a relationship to the model.
    pub fn add_relationship(mut self, relationship: Relationship) -> Self {
        self.relationships.push(relationship);
        self
    }

    /// Add a measure to the model.
    pub fn add_measure(mut self, measure: Measure) -> Self {
        self.measures.push(measure);
        self
    }

    /// Add a calculated column to the model.
    pub fn add_calculated_column(mut self, calculated_column: CalculatedColumn) -> Self {
        self.calculated_columns.push(calculated_column);
        self
    }

    /// Add a measure group to the model.
    pub fn add_measure_group(mut self, group: MeasureGroup) -> Self {
        self.measure_groups.push(group);
        self
    }

    /// Add a context definition to the model.
    pub fn add_context(mut self, context: ContextDefinition) -> Self {
        self.contexts.push(context);
        self
    }

    /// Add a table variable to the model.
    pub fn add_table_variable(mut self, variable: TableVariable) -> Self {
        self.table_variables.push(variable);
        self
    }

    /// Add a global variable to the model.
    pub fn add_global_variable(mut self, variable: GlobalVariable) -> Self {
        self.global_variables.push(variable);
        self
    }

    /// Add a hierarchy to the model.
    pub fn add_hierarchy(mut self, hierarchy: Hierarchy) -> Self {
        self.hierarchies.push(hierarchy);
        self
    }

    /// Set the model-level default lookup resolution expression.
    ///
    /// This expression is used for lookup columns that don't have a
    /// per-column `lookup_resolution` set. It must reference the lookup
    /// column via the reserved bare identifier
    /// [`__column`](LOOKUP_COLUMN_PLACEHOLDER) (case-insensitive), which is
    /// rewritten to the actual column at query time — e.g.
    /// `"MAX(__column)"` or `"SELECTEDVALUE(__column, \"*\")"`. Expressions
    /// without the placeholder are rejected at build time, since they would
    /// resolve the same hard-coded column for every lookup.
    ///
    /// If not specified, the built-in fallback applies: for `String`
    /// columns, SELECTEDVALUE-style semantics
    /// (`CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE '#' END`);
    /// for all other column types, `MIN(col)`.
    pub fn default_lookup_resolution(mut self, expr: impl Into<String>) -> Self {
        self.default_lookup_resolution = Some(expr.into());
        self
    }

    /// Build the data model.
    ///
    /// Validates that:
    /// - Table names are unique
    /// - Relationship names are unique
    /// - All referenced tables and columns exist
    /// - Join column types are compatible
    pub fn build(self) -> EngineResult<DataModel> {
        // 0. Identifier validation. Table, column, calculated-column, and
        // measure names are later interpolated into quoted SQL identifiers
        // (and table names into cache file names), so characters that can
        // break out of those contexts are rejected up front. Table-variable,
        // context, global-variable, and hierarchy names are intentionally
        // not validated here: they are pure lookup keys that resolve to
        // (already validated) tables and columns before any SQL is built.
        for table in &self.tables {
            validate_identifier(table.name(), "table")?;
            for col in table.columns() {
                validate_identifier(col.name(), "column")?;
            }
        }
        for cc in &self.calculated_columns {
            validate_identifier(cc.name(), "calculated column")?;
        }
        for measure in &self.measures {
            validate_identifier(measure.name(), "measure")?;
        }

        // 0b. Expression AST validation. Measures, calculated columns, and
        // global variables can be deserialized straight from model JSON,
        // bypassing the parser's allow-lists (most critically the date/time
        // interval keywords that the SQL renderers splice in raw). Validate
        // every expression tree — and the filter predicates embedded in
        // context definitions and table variables — before any SQL can be
        // generated from them.
        for measure in &self.measures {
            measure.expression().validate()?;
        }
        for cc in &self.calculated_columns {
            cc.expression().validate()?;
        }
        for gv in &self.global_variables {
            gv.expression().validate()?;
        }
        for ctx in &self.contexts {
            use crate::model::context::ContextOp;
            for op in ctx.operations() {
                match op {
                    ContextOp::Keep(filters) => {
                        for f in filters {
                            f.validate()?;
                        }
                    }
                    ContextOp::KeepIn(predicates) => {
                        for p in predicates {
                            p.validate()?;
                        }
                    }
                    // These operations carry only lookup keys (table /
                    // column / context / relationship names) that are
                    // resolved against the model, never rendered raw.
                    ContextOp::Clear(_)
                    | ContextOp::ClearInner(_)
                    | ContextOp::ClearOuter(_)
                    | ContextOp::Reset
                    | ContextOp::ResetInner
                    | ContextOp::ResetOuter
                    | ContextOp::Inherit(_)
                    | ContextOp::UseRelationship(_) => {}
                }
            }
        }
        for var in &self.table_variables {
            for f in var.filters() {
                f.validate()?;
            }
        }

        // 1. Table name uniqueness.
        let mut seen_tables = std::collections::HashSet::new();
        for table in &self.tables {
            if !seen_tables.insert(table.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate table '{}'",
                    table.name()
                )));
            }
        }

        // 1b. Validate sort_by_column references within each table.
        for table in &self.tables {
            for col in table.columns() {
                if let Some(sort_col) = col.sort_by_column() {
                    // Sort-by column must not reference itself.
                    if sort_col == col.name() {
                        return Err(EngineError::InvalidSortByColumn {
                            table: table.name().to_string(),
                            column: col.name().to_string(),
                            reason: "column cannot sort by itself".to_string(),
                        });
                    }
                    // Sort-by column must exist in the same table.
                    let target =
                        table
                            .column(sort_col)
                            .map_err(|_| EngineError::InvalidSortByColumn {
                                table: table.name().to_string(),
                                column: col.name().to_string(),
                                reason: format!(
                                    "sort_by_column '{}' not found in table '{}'",
                                    sort_col,
                                    table.name()
                                ),
                            })?;
                    // Circular: A sorts by B, B sorts by A.
                    if let Some(target_sort) = target.sort_by_column() {
                        if target_sort == col.name() {
                            return Err(EngineError::InvalidSortByColumn {
                                table: table.name().to_string(),
                                column: col.name().to_string(),
                                reason: format!(
                                    "circular sort_by_column: '{}' and '{}' sort by each other",
                                    col.name(),
                                    sort_col
                                ),
                            });
                        }
                    }
                }
            }
        }

        // 1c. Lookup resolution expressions must parse, and the model-level
        // default must be column-generic (reference the `__column`
        // placeholder). Catching this at build time keeps bad expressions in
        // shared model files from failing only at query time.
        if let Some(default_expr) = &self.default_lookup_resolution {
            let parsed =
                crate::compute::parser::parse_measure_expression(default_expr).map_err(|e| {
                    EngineError::InvalidLookup {
                        table: "(model)".to_string(),
                        column: "default_lookup_resolution".to_string(),
                        reason: format!("expression does not parse: {e}"),
                    }
                })?;
            // Probe the placeholder rewrite with a dummy column name; this
            // rejects defaults that omit the placeholder or qualify it.
            apply_lookup_placeholder(&parsed, "__probe")?;
        }
        for table in &self.tables {
            for col in table.columns() {
                if let Some(expr_text) = col.lookup_resolution() {
                    crate::compute::parser::parse_measure_expression(expr_text).map_err(|e| {
                        EngineError::InvalidLookup {
                            table: table.name().to_string(),
                            column: col.name().to_string(),
                            reason: format!("lookup_resolution does not parse: {e}"),
                        }
                    })?;
                }
            }
        }

        // 2. Relationship name uniqueness.
        let mut seen_rels = std::collections::HashSet::new();
        for rel in &self.relationships {
            if !seen_rels.insert(rel.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate relationship '{}'",
                    rel.name()
                )));
            }
        }

        // 3. Validate each relationship.
        for rel in &self.relationships {
            let from_table = self
                .tables
                .iter()
                .find(|t| t.name() == rel.from_table())
                .ok_or_else(|| EngineError::InvalidRelationship {
                    relationship: rel.name().to_string(),
                    reason: format!("from_table '{}' not found", rel.from_table()),
                })?;

            let to_table = self
                .tables
                .iter()
                .find(|t| t.name() == rel.to_table())
                .ok_or_else(|| EngineError::InvalidRelationship {
                    relationship: rel.name().to_string(),
                    reason: format!("to_table '{}' not found", rel.to_table()),
                })?;

            if rel.conditions().is_empty() {
                return Err(EngineError::InvalidRelationship {
                    relationship: rel.name().to_string(),
                    reason: "conditions must not be empty".to_string(),
                });
            }

            for condition in rel.conditions() {
                let from_col = from_table.column(condition.from_column()).map_err(|_| {
                    EngineError::InvalidRelationship {
                        relationship: rel.name().to_string(),
                        reason: format!(
                            "column '{}' not found in table '{}'",
                            condition.from_column(),
                            rel.from_table()
                        ),
                    }
                })?;

                let to_col = to_table.column(condition.to_column()).map_err(|_| {
                    EngineError::InvalidRelationship {
                        relationship: rel.name().to_string(),
                        reason: format!(
                            "column '{}' not found in table '{}'",
                            condition.to_column(),
                            rel.to_table()
                        ),
                    }
                })?;

                if from_col.data_type() != to_col.data_type() {
                    return Err(EngineError::InvalidRelationship {
                        relationship: rel.name().to_string(),
                        reason: format!(
                            "type mismatch: {}.{} is {:?}, {}.{} is {:?}",
                            rel.from_table(),
                            condition.from_column(),
                            from_col.data_type(),
                            rel.to_table(),
                            condition.to_column(),
                            to_col.data_type(),
                        ),
                    });
                }
            }
        }

        // 3b. At most one active relationship per table pair.
        {
            let mut active_pairs = std::collections::HashSet::new();
            for rel in &self.relationships {
                if rel.is_active() {
                    let pair = if rel.from_table() < rel.to_table() {
                        (rel.from_table().to_string(), rel.to_table().to_string())
                    } else {
                        (rel.to_table().to_string(), rel.from_table().to_string())
                    };
                    if !active_pairs.insert(pair) {
                        return Err(EngineError::InvalidRelationship {
                            relationship: rel.name().to_string(),
                            reason: format!(
                                "multiple active relationships between '{}' and '{}'",
                                rel.from_table(),
                                rel.to_table()
                            ),
                        });
                    }
                }
            }
        }

        // 4. Validate measure groups (before measures, so groups exist for reference).
        let mut seen_groups = std::collections::HashSet::new();
        for group in &self.measure_groups {
            if !seen_groups.insert(group.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate measure group '{}'",
                    group.name()
                )));
            }
        }

        // 5. Validate measures.
        let mut seen_measures = std::collections::HashSet::new();
        for measure in &self.measures {
            if !seen_measures.insert(measure.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate measure '{}'",
                    measure.name()
                )));
            }

            // Skip table/column validation for measures containing MeasureRef —
            // their table is inferred after expansion (validated in step 10).
            if crate::compute::expression::has_measure_ref(measure.expression()) {
                // If measure references a group, that group must exist.
                if let Some(group_name) = measure.group() {
                    if !seen_groups.contains(group_name) {
                        return Err(EngineError::MeasureGroupNotFound(group_name.to_string()));
                    }
                }
                continue;
            }

            // Table must exist.
            let table = self
                .tables
                .iter()
                .find(|t| t.name() == measure.table())
                .ok_or_else(|| EngineError::TableNotFound(measure.table().to_string()))?;

            // All referenced columns must exist in the table (physical or calculated).
            let calc_col_names: Vec<&str> = self
                .calculated_columns
                .iter()
                .filter(|cc| cc.table() == measure.table())
                .map(|cc| cc.name())
                .collect();

            for col_ref in measure.column_references() {
                if table.column(col_ref).is_err() && !calc_col_names.contains(&col_ref) {
                    return Err(EngineError::ExpressionColumnNotFound {
                        table: measure.table().to_string(),
                        column: col_ref.to_string(),
                    });
                }
            }

            // If measure references a group, that group must exist.
            if let Some(group_name) = measure.group() {
                if !seen_groups.contains(group_name) {
                    return Err(EngineError::MeasureGroupNotFound(group_name.to_string()));
                }
            }
        }

        // 6. Validate calculated columns.
        let mut seen_calc_cols = std::collections::HashSet::new();
        for cc in &self.calculated_columns {
            // Name uniqueness among calculated columns.
            if !seen_calc_cols.insert(cc.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate calculated column '{}'",
                    cc.name()
                )));
            }

            // Table must exist.
            let table = self
                .tables
                .iter()
                .find(|t| t.name() == cc.table())
                .ok_or_else(|| EngineError::InvalidCalculatedColumn {
                    name: cc.name().to_string(),
                    reason: format!("table '{}' not found", cc.table()),
                })?;

            // Must not contain aggregate nodes.
            if cc.expression().has_aggregate() {
                return Err(EngineError::InvalidCalculatedColumn {
                    name: cc.name().to_string(),
                    reason: "calculated columns must not contain aggregate expressions".into(),
                });
            }

            // Must not contain context manipulation nodes.
            if cc.expression().has_context_ops() {
                return Err(EngineError::InvalidCalculatedColumn {
                    name: cc.name().to_string(),
                    reason: "calculated columns must not contain context operations (keep/clear/reset/traverse/using/block)".into(),
                });
            }

            // All referenced columns must exist in the table.
            for col_ref in cc.expression().column_references() {
                if table.column(col_ref).is_err() {
                    return Err(EngineError::ExpressionColumnNotFound {
                        table: cc.table().to_string(),
                        column: col_ref.to_string(),
                    });
                }
            }

            // Name must not collide with a physical column.
            if table.column(cc.name()).is_ok() {
                return Err(EngineError::InvalidCalculatedColumn {
                    name: cc.name().to_string(),
                    reason: format!(
                        "name conflicts with physical column '{}' in table '{}'",
                        cc.name(),
                        cc.table()
                    ),
                });
            }
        }

        // 7. Validate context definitions.
        let mut seen_contexts = std::collections::HashSet::new();
        for ctx in &self.contexts {
            if !seen_contexts.insert(ctx.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate context '{}'",
                    ctx.name()
                )));
            }
            // No collision with table names.
            if seen_tables.contains(ctx.name()) {
                return Err(EngineError::InvalidContext {
                    name: ctx.name().to_string(),
                    reason: format!("name conflicts with table '{}'", ctx.name()),
                });
            }
        }
        // Check Inherit references and detect cycles.
        for ctx in &self.contexts {
            let mut visited = std::collections::HashSet::new();
            visited.insert(ctx.name().to_string());
            for op in ctx.operations() {
                if let crate::model::context::ContextOp::Inherit(ref parent) = op {
                    if !seen_contexts.contains(parent.as_str()) {
                        return Err(EngineError::InvalidContext {
                            name: ctx.name().to_string(),
                            reason: format!("inherits unknown context '{parent}'"),
                        });
                    }
                    if !visited.insert(parent.clone()) {
                        return Err(EngineError::InvalidContext {
                            name: ctx.name().to_string(),
                            reason: format!("circular inheritance involving '{parent}'"),
                        });
                    }
                }
            }
        }

        // 8. Validate table variables.
        let mut seen_vars = std::collections::HashSet::new();
        for var in &self.table_variables {
            // Unique variable names.
            if !seen_vars.insert(var.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate table variable '{}'",
                    var.name()
                )));
            }

            // No collision with table names.
            if seen_tables.contains(var.name()) {
                return Err(EngineError::InvalidTableVariable {
                    name: var.name().to_string(),
                    reason: format!("name conflicts with table '{}'", var.name()),
                });
            }

            // No collision with context names.
            if seen_contexts.contains(var.name()) {
                return Err(EngineError::InvalidTableVariable {
                    name: var.name().to_string(),
                    reason: format!("name conflicts with context '{}'", var.name()),
                });
            }

            // Source must be an existing table or another table variable.
            let source_is_table = self.tables.iter().any(|t| t.name() == var.source());
            let source_is_var = self
                .table_variables
                .iter()
                .any(|v| v.name() != var.name() && v.name() == var.source());
            if !source_is_table && !source_is_var {
                return Err(EngineError::InvalidTableVariable {
                    name: var.name().to_string(),
                    reason: format!(
                        "source '{}' is not a known table or table variable",
                        var.source()
                    ),
                });
            }

            // Find the base table by walking the variable chain.
            let base_table_name = {
                let mut current = var.source().to_string();
                let mut visited = std::collections::HashSet::new();
                visited.insert(var.name().to_string());
                loop {
                    if !visited.insert(current.clone()) {
                        return Err(EngineError::InvalidTableVariable {
                            name: var.name().to_string(),
                            reason: format!("circular reference involving '{current}'"),
                        });
                    }
                    if let Some(parent_var) = self
                        .table_variables
                        .iter()
                        .find(|v| v.name() == current.as_str())
                    {
                        current = parent_var.source().to_string();
                    } else {
                        break current;
                    }
                }
            };

            // Validate filter columns exist in the base table.
            if let Some(base_table) = self.tables.iter().find(|t| t.name() == base_table_name) {
                for filter in var.filters() {
                    if base_table.column(&filter.column).is_err() {
                        return Err(EngineError::InvalidTableVariable {
                            name: var.name().to_string(),
                            reason: format!(
                                "filter column '{}' not found in base table '{}'",
                                filter.column, base_table_name
                            ),
                        });
                    }
                }
            }
        }

        // 9. Validate global variables.
        let mut seen_globals = std::collections::HashSet::new();
        for gv in &self.global_variables {
            // Unique names.
            if !seen_globals.insert(gv.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate global variable '{}'",
                    gv.name()
                )));
            }

            // No collision with table names.
            if seen_tables.contains(gv.name()) {
                return Err(EngineError::InvalidGlobalVariable {
                    name: gv.name().to_string(),
                    reason: format!("name conflicts with table '{}'", gv.name()),
                });
            }

            // No collision with context names.
            if seen_contexts.contains(gv.name()) {
                return Err(EngineError::InvalidGlobalVariable {
                    name: gv.name().to_string(),
                    reason: format!("name conflicts with context '{}'", gv.name()),
                });
            }

            // No collision with table variable names.
            if seen_vars.contains(gv.name()) {
                return Err(EngineError::InvalidGlobalVariable {
                    name: gv.name().to_string(),
                    reason: format!("name conflicts with table variable '{}'", gv.name()),
                });
            }

            // Referenced table must exist.
            if !seen_tables.contains(gv.table()) {
                return Err(EngineError::InvalidGlobalVariable {
                    name: gv.name().to_string(),
                    reason: format!("table '{}' not found", gv.table()),
                });
            }
        }

        // 10. Validate hierarchies.
        let mut seen_hierarchies = std::collections::HashSet::new();
        for hierarchy in &self.hierarchies {
            // Unique hierarchy names.
            if !seen_hierarchies.insert(hierarchy.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate hierarchy '{}'",
                    hierarchy.name()
                )));
            }

            // No collision with table names.
            if seen_tables.contains(hierarchy.name()) {
                return Err(EngineError::InvalidHierarchy {
                    name: hierarchy.name().to_string(),
                    reason: format!("name conflicts with table '{}'", hierarchy.name()),
                });
            }

            // No collision with context names.
            if seen_contexts.contains(hierarchy.name()) {
                return Err(EngineError::InvalidHierarchy {
                    name: hierarchy.name().to_string(),
                    reason: format!("name conflicts with context '{}'", hierarchy.name()),
                });
            }

            // No collision with table variable names.
            if seen_vars.contains(hierarchy.name()) {
                return Err(EngineError::InvalidHierarchy {
                    name: hierarchy.name().to_string(),
                    reason: format!("name conflicts with table variable '{}'", hierarchy.name()),
                });
            }

            // No collision with global variable names.
            if seen_globals.contains(hierarchy.name()) {
                return Err(EngineError::InvalidHierarchy {
                    name: hierarchy.name().to_string(),
                    reason: format!("name conflicts with global variable '{}'", hierarchy.name()),
                });
            }

            // Table must exist.
            let table = self
                .tables
                .iter()
                .find(|t| t.name() == hierarchy.table())
                .ok_or_else(|| EngineError::InvalidHierarchy {
                    name: hierarchy.name().to_string(),
                    reason: format!("table '{}' not found", hierarchy.table()),
                })?;

            // At least 2 levels.
            if hierarchy.levels().len() < 2 {
                return Err(EngineError::InvalidHierarchy {
                    name: hierarchy.name().to_string(),
                    reason: format!(
                        "hierarchy must have at least 2 levels, found {}",
                        hierarchy.levels().len()
                    ),
                });
            }

            // All level columns must exist, no duplicates.
            let mut seen_level_columns = std::collections::HashSet::new();
            for level in hierarchy.levels() {
                if table.column(level.column()).is_err() {
                    return Err(EngineError::InvalidHierarchy {
                        name: hierarchy.name().to_string(),
                        reason: format!(
                            "level column '{}' not found in table '{}'",
                            level.column(),
                            hierarchy.table()
                        ),
                    });
                }
                if !seen_level_columns.insert(level.column()) {
                    return Err(EngineError::InvalidHierarchy {
                        name: hierarchy.name().to_string(),
                        reason: format!("duplicate level column '{}'", level.column()),
                    });
                }
            }

            // Stopper values are only valid on optional levels.
            for level in hierarchy.levels() {
                if level.stopper_value().is_some() && !level.is_optional() {
                    return Err(EngineError::InvalidHierarchy {
                        name: hierarchy.name().to_string(),
                        reason: format!(
                            "level '{}' has a stopper_value but is not optional",
                            level.column()
                        ),
                    });
                }
            }

            // First and last levels must not be optional.
            if hierarchy.levels().first().unwrap().is_optional() {
                return Err(EngineError::InvalidHierarchy {
                    name: hierarchy.name().to_string(),
                    reason: "first level cannot be optional".to_string(),
                });
            }
            if hierarchy.levels().last().unwrap().is_optional() {
                return Err(EngineError::InvalidHierarchy {
                    name: hierarchy.name().to_string(),
                    reason: "last level cannot be optional".to_string(),
                });
            }
        }

        let model = DataModel {
            // Freshly built models always carry the current format version
            // (deserialized legacy models keep their stored value; note
            // that `DataModel::validate()` only borrows the rebuilt model
            // for validation and never copies this field back, so
            // validating a legacy model does not alter its version).
            format_version: MODEL_FORMAT_VERSION,
            tables: self.tables,
            relationships: self.relationships,
            measures: self.measures,
            calculated_columns: self.calculated_columns,
            measure_groups: self.measure_groups,
            contexts: self.contexts,
            table_variables: self.table_variables,
            global_variables: self.global_variables,
            hierarchies: self.hierarchies,
            default_lookup_resolution: self.default_lookup_resolution,
        };

        // 10. Validate measure references are acyclic and target existing measures.
        for measure in model.measures() {
            if crate::compute::expression::has_measure_ref(measure.expression()) {
                crate::compute::expression::expand_measure_refs(measure.expression(), &model)?;
            }
        }

        Ok(model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::column::Column;
    use crate::types::DataType;

    fn sales_table() -> Table {
        Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("store_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap()
    }

    fn products_table() -> Table {
        Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
                Column::new("category", DataType::String),
            ],
        )
        .unwrap()
    }

    fn stores_table() -> Table {
        Table::new(
            "Stores",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("city", DataType::String),
            ],
        )
        .unwrap()
    }

    fn sales_products_relationship() -> Relationship {
        Relationship::many_to_one("Sales_Products", "Sales", "product_id", "Products", "id")
    }

    fn sales_stores_relationship() -> Relationship {
        Relationship::many_to_one("Sales_Stores", "Sales", "store_id", "Stores", "id")
    }

    // --- Existing tests ---

    #[test]
    fn build_model_with_two_tables() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .build()
            .unwrap();

        assert_eq!(model.tables().len(), 2);
        assert!(model.table("Sales").is_ok());
        assert!(model.table("Products").is_ok());
        assert!(model.table("Missing").is_err());
    }

    #[test]
    fn duplicate_table_names_rejected() {
        let t1 = Table::new("T", vec![Column::new("a", DataType::Int32)]).unwrap();
        let t2 = Table::new("T", vec![Column::new("b", DataType::Int32)]).unwrap();

        let result = DataModel::builder().add_table(t1).add_table(t2).build();
        assert!(result.is_err());
    }

    // --- Relationship tests ---

    #[test]
    fn build_model_with_relationship() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(sales_products_relationship())
            .build()
            .unwrap();

        assert_eq!(model.relationships().len(), 1);
        assert_eq!(model.relationships()[0].name(), "Sales_Products");
    }

    #[test]
    fn rejects_relationship_to_missing_from_table() {
        let rel = Relationship::many_to_one("Bad", "NonExistent", "id", "Products", "id");
        let result = DataModel::builder()
            .add_table(products_table())
            .add_relationship(rel)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("from_table"));
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn rejects_relationship_to_missing_to_table() {
        let rel = Relationship::many_to_one("Bad", "Sales", "product_id", "NonExistent", "id");
        let result = DataModel::builder()
            .add_table(sales_table())
            .add_relationship(rel)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("to_table"));
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn rejects_relationship_with_missing_from_column() {
        let rel = Relationship::many_to_one("Bad", "Sales", "nonexistent_col", "Products", "id");
        let result = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(rel)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("nonexistent_col"));
    }

    #[test]
    fn rejects_relationship_with_missing_to_column() {
        let rel =
            Relationship::many_to_one("Bad", "Sales", "product_id", "Products", "nonexistent");
        let result = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(rel)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("nonexistent"));
    }

    #[test]
    fn rejects_relationship_with_type_mismatch() {
        // Sales.product_id is Int64, but Products.name is String
        let rel = Relationship::many_to_one("Bad", "Sales", "product_id", "Products", "name");
        let result = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(rel)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("type mismatch"));
    }

    #[test]
    fn rejects_duplicate_relationship_names() {
        let rel1 = sales_products_relationship();
        let rel2 = Relationship::many_to_one("Sales_Products", "Sales", "store_id", "Stores", "id");

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_table(stores_table())
            .add_relationship(rel1)
            .add_relationship(rel2)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Duplicate"));
        assert!(err.contains("Sales_Products"));
    }

    #[test]
    fn lookup_relationship_by_name() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(sales_products_relationship())
            .build()
            .unwrap();

        let rel = model.relationship("Sales_Products").unwrap();
        assert_eq!(rel.from_table(), "Sales");
        assert_eq!(rel.to_table(), "Products");
    }

    #[test]
    fn relationship_not_found() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .build()
            .unwrap();

        assert!(model.relationship("Missing").is_err());
    }

    #[test]
    fn find_relationship_between_tables() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(sales_products_relationship())
            .build()
            .unwrap();

        // Forward direction.
        let rel = model.find_relationship("Sales", "Products").unwrap();
        assert_eq!(rel.name(), "Sales_Products");

        // Reverse direction.
        let rel = model.find_relationship("Products", "Sales").unwrap();
        assert_eq!(rel.name(), "Sales_Products");

        // No relationship.
        assert!(model.find_relationship("Sales", "Stores").is_err());
    }

    #[test]
    fn relationships_for_table() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_table(stores_table())
            .add_relationship(sales_products_relationship())
            .add_relationship(sales_stores_relationship())
            .build()
            .unwrap();

        let sales_rels = model.relationships_for_table("Sales");
        assert_eq!(sales_rels.len(), 2);

        let products_rels = model.relationships_for_table("Products");
        assert_eq!(products_rels.len(), 1);

        let stores_rels = model.relationships_for_table("Stores");
        assert_eq!(stores_rels.len(), 1);
    }

    #[test]
    fn star_schema_with_multiple_dimensions() {
        let dates = Table::new(
            "Dates",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("year", DataType::Int32),
            ],
        )
        .unwrap();

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("store_id", DataType::Int64),
                Column::new("date_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(sales)
            .add_table(products_table())
            .add_table(stores_table())
            .add_table(dates)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Stores",
                "Sales",
                "store_id",
                "Stores",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .build()
            .unwrap();

        assert_eq!(model.tables().len(), 4);
        assert_eq!(model.relationships().len(), 3);
        assert_eq!(model.relationships_for_table("Sales").len(), 3);
    }

    // --- Active/inactive relationship tests ---

    #[test]
    fn find_relationship_skips_inactive() {
        let active = Relationship::many_to_one("Active", "Sales", "product_id", "Products", "id");
        let inactive = Relationship::many_to_one("Inactive", "Sales", "store_id", "Stores", "id")
            .with_active(false);

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_table(stores_table())
            .add_relationship(active)
            .add_relationship(inactive)
            .build()
            .unwrap();

        // Active relationship is found.
        assert!(model.find_relationship("Sales", "Products").is_ok());
        // Inactive relationship is NOT found via find_relationship.
        assert!(model.find_relationship("Sales", "Stores").is_err());
        // But IS found via find_any_relationship.
        assert!(model.find_any_relationship("Sales", "Stores").is_ok());
    }

    #[test]
    fn find_relationship_prefers_active_when_multiple_exist() {
        let active =
            Relationship::many_to_one("Sales_Dates_Order", "Sales", "product_id", "Products", "id");
        let inactive =
            Relationship::many_to_one("Sales_Dates_Ship", "Sales", "store_id", "Products", "id")
                .with_active(false);

        // Need a Products table with both id columns for the join
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
                Column::new("category", DataType::String),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products)
            .add_relationship(active)
            .add_relationship(inactive)
            .build()
            .unwrap();

        let rel = model.find_relationship("Sales", "Products").unwrap();
        assert_eq!(rel.name(), "Sales_Dates_Order");
    }

    #[test]
    fn rejects_multiple_active_relationships_between_same_tables() {
        let rel1 =
            Relationship::many_to_one("Sales_Prod_1", "Sales", "product_id", "Products", "id");
        let rel2 = Relationship::many_to_one("Sales_Prod_2", "Sales", "store_id", "Products", "id");

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(rel1)
            .add_relationship(rel2)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("multiple active"));
    }

    #[test]
    fn allows_multiple_inactive_relationships_between_same_tables() {
        let active =
            Relationship::many_to_one("Sales_Prod_Active", "Sales", "product_id", "Products", "id");
        let inactive1 =
            Relationship::many_to_one("Sales_Prod_Alt1", "Sales", "store_id", "Products", "id")
                .with_active(false);
        let inactive2 =
            Relationship::many_to_one("Sales_Prod_Alt2", "Sales", "id", "Products", "id")
                .with_active(false);

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(active)
            .add_relationship(inactive1)
            .add_relationship(inactive2)
            .build()
            .unwrap();

        assert_eq!(model.relationships().len(), 3);
    }

    #[test]
    fn allows_zero_active_relationships_between_tables() {
        // Both inactive — valid (no default path, must always use USERELATIONSHIP)
        let inactive1 =
            Relationship::many_to_one("Sales_Prod_1", "Sales", "product_id", "Products", "id")
                .with_active(false);
        let inactive2 =
            Relationship::many_to_one("Sales_Prod_2", "Sales", "store_id", "Products", "id")
                .with_active(false);

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(inactive1)
            .add_relationship(inactive2)
            .build()
            .unwrap();

        // find_relationship should fail (no active)
        assert!(model.find_relationship("Sales", "Products").is_err());
        // but find_any_relationship should succeed
        assert!(model.find_any_relationship("Sales", "Products").is_ok());
    }

    #[test]
    fn relationship_by_name_finds_inactive() {
        let inactive =
            Relationship::many_to_one("Sales_Prod_Ship", "Sales", "product_id", "Products", "id")
                .with_active(false);

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(inactive)
            .build()
            .unwrap();

        // Lookup by name always works regardless of active status.
        let rel = model.relationship("Sales_Prod_Ship").unwrap();
        assert!(!rel.is_active());
    }

    #[test]
    fn serde_backward_compat_no_active_field_in_model() {
        // JSON model without "active" field in relationships should deserialize as active.
        let json = r#"{
            "tables": [],
            "relationships": [{
                "name": "R",
                "from_table": "Sales",
                "to_table": "Products",
                "conditions": [{"from_column": "pid", "to_column": "id", "operator": "Equal"}],
                "cardinality": "ManyToOne",
                "propagation": "Auto"
            }],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        let model: DataModel = serde_json::from_str(json).unwrap();
        assert!(model.relationships()[0].is_active());
    }

    // --- Calculated column tests ---

    #[test]
    fn calculated_column_added_to_model() {
        use crate::compute::expression as expr;

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(CalculatedColumn::new(
                "double_amount",
                "Sales",
                expr::col("amount").multiply(expr::lit(2.0)),
                DataType::Float64,
            ))
            .build()
            .unwrap();

        assert_eq!(model.calculated_columns().len(), 1);
        assert_eq!(model.calculated_columns_for_table("Sales").len(), 1);
        assert!(model.calculated_columns_for_table("Products").is_empty());
    }

    #[test]
    fn rejects_calculated_column_on_missing_table() {
        use crate::compute::expression as expr;

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(CalculatedColumn::new(
                "x",
                "NonExistent",
                expr::col("a"),
                DataType::Float64,
            ))
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn rejects_calculated_column_referencing_missing_column() {
        use crate::compute::expression as expr;

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(CalculatedColumn::new(
                "bad",
                "Sales",
                expr::col("nonexistent"),
                DataType::Float64,
            ))
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("nonexistent"));
    }

    #[test]
    fn rejects_calculated_column_with_aggregate() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::expression as expr;

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(CalculatedColumn::new(
                "total",
                "Sales",
                expr::agg(AggregateOp::Sum, expr::col("amount")),
                DataType::Float64,
            ))
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("aggregate"));
    }

    #[test]
    fn rejects_calculated_column_name_conflicts_with_physical_column() {
        use crate::compute::expression as expr;

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(CalculatedColumn::new(
                "amount", // conflicts with physical column
                "Sales",
                expr::col("id"),
                DataType::Float64,
            ))
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts"));
    }

    #[test]
    fn rejects_calculated_column_with_context_ops() {
        use crate::compute::expression as expr;

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(CalculatedColumn::new(
                "filtered",
                "Sales",
                expr::keep(expr::col("amount"), vec![]),
                DataType::Float64,
            ))
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("context operations"));
    }

    #[test]
    fn rejects_duplicate_context_names() {
        use crate::model::context::{ContextDefinition, ContextOp};

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_context(ContextDefinition::new("ctx", vec![ContextOp::Reset]))
            .add_context(ContextDefinition::new("ctx", vec![ContextOp::Reset]))
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Duplicate"));
        assert!(err.contains("ctx"));
    }

    #[test]
    fn rejects_context_inheriting_unknown() {
        use crate::model::context::{ContextDefinition, ContextOp};

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_context(ContextDefinition::new(
                "child",
                vec![ContextOp::Inherit("nonexistent".into())],
            ))
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("nonexistent"));
    }

    // --- Table variable tests ---

    #[test]
    fn table_variable_added_to_model() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate};

        let var = TableVariable::new(
            "premium",
            "Products",
            vec![FilterPredicate::new(
                "Products",
                "category",
                ComparisonOp::Equal,
                "Premium",
            )],
        );

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_table_variable(var)
            .build()
            .unwrap();

        assert_eq!(model.table_variables().len(), 1);
        assert!(model.table_variable("premium").is_ok());
        assert!(model.table_variable("missing").is_err());
    }

    #[test]
    fn rejects_duplicate_table_variable_names() {
        let v1 = TableVariable::new("v", "Products", vec![]);
        let v2 = TableVariable::new("v", "Products", vec![]);

        let result = DataModel::builder()
            .add_table(products_table())
            .add_table_variable(v1)
            .add_table_variable(v2)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Duplicate"));
    }

    #[test]
    fn rejects_table_variable_name_collision_with_table() {
        let var = TableVariable::new("Products", "Products", vec![]);

        let result = DataModel::builder()
            .add_table(products_table())
            .add_table_variable(var)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with table"));
    }

    #[test]
    fn rejects_table_variable_with_missing_source() {
        let var = TableVariable::new("v", "NonExistent", vec![]);

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_table_variable(var)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn rejects_table_variable_with_invalid_filter_column() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate};

        let var = TableVariable::new(
            "v",
            "Products",
            vec![FilterPredicate::new(
                "Products",
                "nonexistent",
                ComparisonOp::Equal,
                "x",
            )],
        );

        let result = DataModel::builder()
            .add_table(products_table())
            .add_table_variable(var)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("nonexistent"));
    }

    #[test]
    fn rejects_circular_table_variable_references() {
        let v1 = TableVariable::new("a", "b", vec![]);
        let v2 = TableVariable::new("b", "a", vec![]);

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_table_variable(v1)
            .add_table_variable(v2)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("circular"));
    }

    #[test]
    fn composed_table_variable_valid() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate};

        let v1 = TableVariable::new(
            "premium",
            "Products",
            vec![FilterPredicate::new(
                "Products",
                "category",
                ComparisonOp::Equal,
                "Premium",
            )],
        );
        let v2 = TableVariable::new(
            "expensive_premium",
            "premium",
            vec![FilterPredicate::new(
                "Products",
                "name",
                ComparisonOp::NotEqual,
                "",
            )],
        );

        let model = DataModel::builder()
            .add_table(products_table())
            .add_table_variable(v1)
            .add_table_variable(v2)
            .build()
            .unwrap();

        assert_eq!(model.table_variables().len(), 2);
    }

    #[test]
    fn serde_backward_compat_no_table_variables() {
        // JSON without table_variables field should deserialize with empty vec.
        let json = r#"{
            "tables": [],
            "relationships": [],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        let model: DataModel = serde_json::from_str(json).unwrap();
        assert!(model.table_variables().is_empty());
    }

    // --- Serialization tests ---

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

    // --- Context name collision tests ---

    #[test]
    fn rejects_context_name_collision_with_table() {
        use crate::model::context::{ContextDefinition, ContextOp};

        let ctx = ContextDefinition::new("Sales", vec![ContextOp::Reset]);

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_context(ctx)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with table"));
    }

    #[test]
    fn rejects_table_variable_name_collision_with_context() {
        use crate::model::context::{ContextDefinition, ContextOp};

        let ctx = ContextDefinition::new("my_ctx", vec![ContextOp::Reset]);
        let var = TableVariable::new("my_ctx", "Products", vec![]);

        let result = DataModel::builder()
            .add_table(products_table())
            .add_context(ctx)
            .add_table_variable(var)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with context"));
    }

    #[test]
    fn accepts_context_with_unique_name() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate};
        use crate::model::context::{ContextDefinition, ContextOp};

        let ctx = ContextDefinition::new(
            "ctx_us",
            vec![ContextOp::Keep(vec![FilterPredicate::new(
                "Sales",
                "region",
                ComparisonOp::Equal,
                "US",
            )])],
        );

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_context(ctx)
            .build()
            .unwrap();

        assert_eq!(model.contexts().len(), 1);
    }

    #[test]
    fn validate_catches_invalid_deserialized_model() {
        // Build a valid model, serialize it, tamper with JSON, deserialize.
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(sales_products_relationship())
            .build()
            .unwrap();

        let mut json: serde_json::Value = serde_json::to_value(&model).unwrap();
        // Remove the Products table so the relationship becomes invalid.
        let tables = json["tables"].as_array_mut().unwrap();
        tables.retain(|t| t["name"] != "Products");

        let tampered: DataModel = serde_json::from_value(json).unwrap();
        assert!(tampered.validate().is_err());
    }

    // --- Expression AST validation (step 0b) tests ---

    /// JSON for a measure whose expression carries a DATE_TRUNC interval.
    /// Hand-constructed (not produced by the parser) to emulate a hostile
    /// or tampered model file.
    fn date_trunc_measure_json(interval: &str) -> String {
        format!(
            r#"{{
                "name": "FirstOfMonth",
                "expression": {{
                    "Aggregate": {{
                        "operation": "Max",
                        "operand": {{
                            "DateTimeFunc": {{
                                "function": "DateTrunc",
                                "args": [
                                    {{"QualifiedColumnRef": {{"table_or_var": "Sales", "column": "amount"}}}},
                                    {{"LiteralString": "{interval}"}}
                                ]
                            }}
                        }}
                    }}
                }}
            }}"#
        )
    }

    #[test]
    fn build_rejects_deserialized_measure_with_hostile_interval() {
        // The custom Measure Deserialize accepts any Expression tree —
        // the parser's interval allow-list is bypassed entirely.
        let measure: Measure =
            serde_json::from_str(&date_trunc_measure_json("MONTH'); DROP TABLE x; --")).unwrap();

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_measure(measure)
            .build();

        let err = result.unwrap_err().to_string();
        assert!(err.contains("invalid interval"), "got: {err}");
    }

    #[test]
    fn build_accepts_deserialized_measure_with_benign_interval() {
        let measure: Measure = serde_json::from_str(&date_trunc_measure_json("MONTH")).unwrap();

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(measure)
            .build()
            .unwrap();
        assert_eq!(model.measures().len(), 1);
    }

    #[test]
    fn validate_rejects_full_model_json_with_hostile_interval() {
        // Round-trip a valid model through JSON, splice in a hostile
        // measure, and confirm DataModel::validate() (which delegates to
        // build()) rejects it.
        let model = DataModel::builder()
            .add_table(sales_table())
            .build()
            .unwrap();

        let mut json: serde_json::Value = serde_json::to_value(&model).unwrap();
        let hostile: serde_json::Value =
            serde_json::from_str(&date_trunc_measure_json("MONTH'); DROP TABLE x; --")).unwrap();
        json["measures"].as_array_mut().unwrap().push(hostile);

        let tampered: DataModel = serde_json::from_value(json).unwrap();
        let err = tampered.validate().unwrap_err().to_string();
        assert!(err.contains("invalid interval"), "got: {err}");
    }

    #[test]
    fn build_rejects_context_filter_with_hostile_table() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate};
        use crate::model::context::ContextOp;

        let ctx = ContextDefinition::new(
            "ctx_evil",
            vec![ContextOp::Keep(vec![FilterPredicate::new(
                "dim\" ON 1=1; --",
                "year",
                ComparisonOp::Equal,
                "2014",
            )])],
        );

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_context(ctx)
            .build();
        assert!(result.is_err());
    }

    #[test]
    fn build_rejects_table_variable_filter_with_hostile_table() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate};

        let tv = TableVariable::new(
            "evil_var",
            "Sales",
            vec![FilterPredicate::new(
                "Sales'; DROP TABLE x; --",
                "region",
                ComparisonOp::Equal,
                "US",
            )],
        );

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_table_variable(tv)
            .build();
        assert!(result.is_err());
    }

    // --- Lookup resolution validation (step 1c) tests ---

    #[test]
    fn build_rejects_model_default_lookup_without_placeholder() {
        let result = DataModel::builder()
            .add_table(sales_table())
            .default_lookup_resolution("MAX(category_name)")
            .build();

        let err = result.unwrap_err().to_string();
        assert!(err.contains("__column"), "got: {err}");
    }

    #[test]
    fn build_rejects_unparseable_model_default_lookup() {
        let result = DataModel::builder()
            .add_table(sales_table())
            .default_lookup_resolution("MAX(")
            .build();

        let err = result.unwrap_err().to_string();
        assert!(err.contains("does not parse"), "got: {err}");
    }

    #[test]
    fn build_accepts_model_default_lookup_with_placeholder() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .default_lookup_resolution("MAX(__column)")
            .build()
            .unwrap();
        assert_eq!(model.default_lookup_resolution(), Some("MAX(__column)"));
    }

    #[test]
    fn build_rejects_unparseable_column_lookup_resolution() {
        let table = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String).with_lookup_resolution("MIN(name"),
            ],
        )
        .unwrap();

        let result = DataModel::builder().add_table(table).build();
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("lookup_resolution does not parse"),
            "got: {err}"
        );
    }

    #[test]
    fn apply_lookup_placeholder_rewrites_case_insensitively() {
        let parsed = crate::compute::parser::parse_measure_expression("MAX(__COLUMN)").unwrap();
        let rewritten = apply_lookup_placeholder(&parsed, "category_name").unwrap();
        assert_eq!(rewritten.column_references(), vec!["category_name"]);
    }

    // --- Global variable tests ---

    #[test]
    fn global_variable_added_to_model() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::expression as expr;
        use crate::model::global_variable::GlobalVariable;

        let gv = GlobalVariable::new(
            "total_revenue",
            "Sales",
            expr::agg(AggregateOp::Sum, expr::col("amount")),
        );

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_global_variable(gv)
            .build()
            .unwrap();

        assert_eq!(model.global_variables().len(), 1);
        assert!(model.global_variable("total_revenue").is_ok());
        assert!(model.global_variable("missing").is_err());
    }

    #[test]
    fn rejects_duplicate_global_variable_names() {
        use crate::compute::expression as expr;
        use crate::model::global_variable::GlobalVariable;

        let g1 = GlobalVariable::new("gv", "Sales", expr::col("amount"));
        let g2 = GlobalVariable::new("gv", "Sales", expr::col("id"));

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_global_variable(g1)
            .add_global_variable(g2)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Duplicate"));
        assert!(err.contains("gv"));
    }

    #[test]
    fn rejects_global_variable_name_collision_with_table() {
        use crate::compute::expression as expr;
        use crate::model::global_variable::GlobalVariable;

        let gv = GlobalVariable::new("Sales", "Sales", expr::col("amount"));

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_global_variable(gv)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with table"));
    }

    #[test]
    fn rejects_global_variable_name_collision_with_context() {
        use crate::compute::expression as expr;
        use crate::model::context::{ContextDefinition, ContextOp};
        use crate::model::global_variable::GlobalVariable;

        let ctx = ContextDefinition::new("my_ctx", vec![ContextOp::Reset]);
        let gv = GlobalVariable::new("my_ctx", "Sales", expr::col("amount"));

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_context(ctx)
            .add_global_variable(gv)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with context"));
    }

    #[test]
    fn rejects_global_variable_with_missing_table() {
        use crate::compute::expression as expr;
        use crate::model::global_variable::GlobalVariable;

        let gv = GlobalVariable::new("gv", "NonExistent", expr::col("x"));

        let result = DataModel::builder()
            .add_table(sales_table())
            .add_global_variable(gv)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn serde_backward_compat_no_global_variables() {
        // JSON without global_variables field should deserialize with empty vec.
        let json = r#"{
            "tables": [],
            "relationships": [],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        let model: DataModel = serde_json::from_str(json).unwrap();
        assert!(model.global_variables().is_empty());
    }

    #[test]
    fn global_variable_json_roundtrip() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::expression as expr;
        use crate::model::global_variable::GlobalVariable;

        let gv = GlobalVariable::new(
            "total_revenue",
            "Sales",
            expr::agg(AggregateOp::Sum, expr::col("amount")),
        );

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_global_variable(gv)
            .build()
            .unwrap();

        let json = serde_json::to_string_pretty(&model).unwrap();
        let restored: DataModel = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.global_variables().len(), 1);
        assert_eq!(restored.global_variables()[0].name(), "total_revenue");
        assert!(restored.validate().is_ok());
    }

    // --- Hierarchy tests ---

    fn dim_geography_table() -> Table {
        Table::new(
            "dim_geography",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("country", DataType::String),
                Column::new("state", DataType::String),
                Column::new("city", DataType::String),
            ],
        )
        .unwrap()
    }

    fn geography_hierarchy() -> Hierarchy {
        use crate::model::hierarchy::HierarchyLevel;
        Hierarchy::new(
            "Geography",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("state"),
                HierarchyLevel::new("city"),
            ],
        )
    }

    #[test]
    fn hierarchy_added_to_model() {
        let model = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(geography_hierarchy())
            .build()
            .unwrap();

        assert_eq!(model.hierarchies().len(), 1);
        assert!(model.hierarchy("Geography").is_ok());
        assert!(model.hierarchy("Missing").is_err());
    }

    #[test]
    fn hierarchies_for_table() {
        use crate::model::hierarchy::HierarchyLevel;

        let h2 = Hierarchy::new(
            "Region",
            "dim_geography",
            vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
        );

        let model = DataModel::builder()
            .add_table(dim_geography_table())
            .add_table(sales_table())
            .add_hierarchy(geography_hierarchy())
            .add_hierarchy(h2)
            .build()
            .unwrap();

        assert_eq!(model.hierarchies_for_table("dim_geography").len(), 2);
        assert!(model.hierarchies_for_table("Sales").is_empty());
    }

    #[test]
    fn rejects_duplicate_hierarchy_names() {
        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(geography_hierarchy())
            .add_hierarchy(geography_hierarchy())
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Duplicate"));
        assert!(err.contains("Geography"));
    }

    #[test]
    fn rejects_hierarchy_name_collision_with_table() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new(
            "Sales",
            "dim_geography",
            vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_table(sales_table())
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with table"));
    }

    #[test]
    fn rejects_hierarchy_name_collision_with_context() {
        use crate::model::context::{ContextDefinition, ContextOp};
        use crate::model::hierarchy::HierarchyLevel;

        let ctx = ContextDefinition::new("my_ctx", vec![ContextOp::Reset]);
        let h = Hierarchy::new(
            "my_ctx",
            "dim_geography",
            vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_context(ctx)
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with context"));
    }

    #[test]
    fn rejects_hierarchy_name_collision_with_table_variable() {
        use crate::model::hierarchy::HierarchyLevel;

        let var = TableVariable::new("my_var", "dim_geography", vec![]);
        let h = Hierarchy::new(
            "my_var",
            "dim_geography",
            vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_table_variable(var)
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with table variable"));
    }

    #[test]
    fn rejects_hierarchy_name_collision_with_global_variable() {
        use crate::compute::expression as expr;
        use crate::model::global_variable::GlobalVariable;
        use crate::model::hierarchy::HierarchyLevel;

        let gv = GlobalVariable::new("my_gv", "dim_geography", expr::col("country"));
        let h = Hierarchy::new(
            "my_gv",
            "dim_geography",
            vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_global_variable(gv)
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("conflicts with global variable"));
    }

    #[test]
    fn rejects_hierarchy_on_missing_table() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new(
            "H",
            "NonExistent",
            vec![HierarchyLevel::new("a"), HierarchyLevel::new("b")],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn rejects_hierarchy_with_missing_column() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new(
            "H",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("nonexistent"),
            ],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("nonexistent"));
    }

    #[test]
    fn rejects_hierarchy_with_fewer_than_two_levels() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new("H", "dim_geography", vec![HierarchyLevel::new("country")]);

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("at least 2 levels"));
    }

    #[test]
    fn rejects_hierarchy_with_duplicate_columns() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new(
            "H",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("country"),
            ],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("duplicate level column"));
    }

    #[test]
    fn rejects_hierarchy_with_optional_first_level() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new(
            "H",
            "dim_geography",
            vec![
                HierarchyLevel::new("country").with_optional(true),
                HierarchyLevel::new("state"),
            ],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("first level cannot be optional"));
    }

    #[test]
    fn rejects_hierarchy_with_optional_last_level() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new(
            "H",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("city").with_optional(true),
            ],
        );

        let result = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("last level cannot be optional"));
    }

    #[test]
    fn accepts_hierarchy_with_optional_middle_level() {
        use crate::model::hierarchy::{HierarchyLevel, RaggedBehavior};

        let h = Hierarchy::new(
            "Geography",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("state").with_optional(true),
                HierarchyLevel::new("city"),
            ],
        )
        .with_ragged_behavior(RaggedBehavior::RepeatParent);

        let model = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build()
            .unwrap();

        assert_eq!(model.hierarchies().len(), 1);
        assert!(model.hierarchies()[0].levels()[1].is_optional());
    }

    #[test]
    fn hierarchy_ragged_behavior_survives_build() {
        use crate::model::hierarchy::{HierarchyLevel, RaggedBehavior};

        let h = Hierarchy::new(
            "H",
            "dim_geography",
            vec![HierarchyLevel::new("country"), HierarchyLevel::new("city")],
        )
        .with_ragged_behavior(RaggedBehavior::HideMembers);

        let model = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build()
            .unwrap();

        assert_eq!(
            model.hierarchy("H").unwrap().ragged_behavior(),
            RaggedBehavior::HideMembers
        );
    }

    #[test]
    fn accepts_hierarchy_with_stopper_value_on_optional_level() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new(
            "Geography",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("state")
                    .with_optional(true)
                    .with_stopper_value("#"),
                HierarchyLevel::new("city"),
            ],
        );

        let model = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build()
            .unwrap();

        assert_eq!(
            model.hierarchies()[0].levels()[1].stopper_value(),
            Some("#")
        );
    }

    #[test]
    fn rejects_hierarchy_with_stopper_value_on_required_level() {
        use crate::model::hierarchy::HierarchyLevel;

        let h = Hierarchy::new(
            "Geography",
            "dim_geography",
            vec![
                HierarchyLevel::new("country").with_stopper_value("#"),
                HierarchyLevel::new("state"),
                HierarchyLevel::new("city"),
            ],
        );

        let err = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build()
            .unwrap_err();

        assert!(
            err.to_string().contains("stopper_value") && err.to_string().contains("not optional"),
            "unexpected error: {err}"
        );
    }

    // --- Sort-by column tests ---

    #[test]
    fn sort_by_column_accepted() {
        let table = Table::new(
            "dim_date",
            vec![
                Column::new("month_number", DataType::Int32),
                Column::new("month_name", DataType::String).with_sort_by("month_number"),
            ],
        )
        .unwrap();

        let model = DataModel::builder().add_table(table).build().unwrap();

        let col = model
            .table("dim_date")
            .unwrap()
            .column("month_name")
            .unwrap();
        assert_eq!(col.sort_by_column(), Some("month_number"));
    }

    #[test]
    fn sort_by_column_missing_target_rejected() {
        let table = Table::new(
            "dim_date",
            vec![Column::new("month_name", DataType::String).with_sort_by("nonexistent")],
        )
        .unwrap();

        let result = DataModel::builder().add_table(table).build();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("nonexistent"));
        assert!(err.contains("not found"));
    }

    #[test]
    fn sort_by_column_self_reference_rejected() {
        let table = Table::new(
            "dim_date",
            vec![Column::new("month_name", DataType::String).with_sort_by("month_name")],
        )
        .unwrap();

        let result = DataModel::builder().add_table(table).build();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("sort by itself"));
    }

    #[test]
    fn sort_by_column_circular_rejected() {
        let table = Table::new(
            "dim_date",
            vec![
                Column::new("a", DataType::String).with_sort_by("b"),
                Column::new("b", DataType::String).with_sort_by("a"),
            ],
        )
        .unwrap();

        let result = DataModel::builder().add_table(table).build();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("circular"));
    }

    #[test]
    fn sort_column_for_returns_sort_column() {
        let table = Table::new(
            "dim_date",
            vec![
                Column::new("month_number", DataType::Int32),
                Column::new("month_name", DataType::String).with_sort_by("month_number"),
            ],
        )
        .unwrap();

        let model = DataModel::builder().add_table(table).build().unwrap();

        // Column with sort_by returns the sort column.
        assert_eq!(
            model.sort_column_for("dim_date", "month_name").unwrap(),
            "month_number"
        );
        // Column without sort_by returns itself.
        assert_eq!(
            model.sort_column_for("dim_date", "month_number").unwrap(),
            "month_number"
        );
    }

    #[test]
    fn sort_by_column_serde_roundtrip() {
        let table = Table::new(
            "dim_date",
            vec![
                Column::new("month_number", DataType::Int32),
                Column::new("month_name", DataType::String).with_sort_by("month_number"),
            ],
        )
        .unwrap();

        let model = DataModel::builder().add_table(table).build().unwrap();
        let json = serde_json::to_string_pretty(&model).unwrap();
        assert!(json.contains("sort_by_column"));
        assert!(json.contains("month_number"));

        let restored: DataModel = serde_json::from_str(&json).unwrap();
        let col = restored
            .table("dim_date")
            .unwrap()
            .column("month_name")
            .unwrap();
        assert_eq!(col.sort_by_column(), Some("month_number"));
        assert!(restored.validate().is_ok());
    }

    #[test]
    fn sort_by_column_omitted_from_json_when_none() {
        let table = Table::new("t", vec![Column::new("a", DataType::Int32)]).unwrap();

        let model = DataModel::builder().add_table(table).build().unwrap();
        let json = serde_json::to_string(&model).unwrap();
        assert!(!json.contains("sort_by_column"));
    }

    #[test]
    fn serde_backward_compat_no_hierarchies() {
        let json = r#"{
            "tables": [],
            "relationships": [],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        let model: DataModel = serde_json::from_str(json).unwrap();
        assert!(model.hierarchies().is_empty());
    }

    #[test]
    fn hierarchy_json_roundtrip() {
        use crate::model::hierarchy::{HierarchyLevel, RaggedBehavior};

        let h = Hierarchy::new(
            "Geography",
            "dim_geography",
            vec![
                HierarchyLevel::new("country"),
                HierarchyLevel::new("state")
                    .with_display_name("State/Province")
                    .with_optional(true),
                HierarchyLevel::new("city"),
            ],
        )
        .with_ragged_behavior(RaggedBehavior::RepeatParent);

        let model = DataModel::builder()
            .add_table(dim_geography_table())
            .add_hierarchy(h)
            .build()
            .unwrap();

        let json = serde_json::to_string_pretty(&model).unwrap();
        let restored: DataModel = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.hierarchies().len(), 1);
        let rh = &restored.hierarchies()[0];
        assert_eq!(rh.name(), "Geography");
        assert_eq!(rh.table(), "dim_geography");
        assert_eq!(rh.levels().len(), 3);
        assert_eq!(rh.levels()[1].display_name(), Some("State/Province"));
        assert!(rh.levels()[1].is_optional());
        assert_eq!(rh.ragged_behavior(), RaggedBehavior::RepeatParent);
        assert!(restored.validate().is_ok());
    }

    // --- Identifier validation tests ---

    #[test]
    fn build_rejects_table_name_with_double_quote() {
        let table = Table::new("evil\"t", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "evil\"t"
        ));
    }

    #[test]
    fn build_rejects_column_name_with_bracket() {
        let table = Table::new("t", vec![Column::new("c]x", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "c]x"
        ));
    }

    #[test]
    fn build_rejects_table_name_with_traversal_sequence() {
        let table = Table::new("..\\x", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(result, Err(EngineError::InvalidIdentifier { .. })));
    }

    #[test]
    fn build_rejects_empty_and_whitespace_table_names() {
        for bad in ["", "   ", " Sales", "Sales ", "\tSales"] {
            let table = Table::new(bad, vec![Column::new("a", DataType::Int32)]).unwrap();
            let result = DataModel::builder().add_table(table).build();
            assert!(
                matches!(result, Err(EngineError::InvalidIdentifier { .. })),
                "expected rejection of table name {bad:?}"
            );
        }
    }

    #[test]
    fn build_rejects_table_name_with_control_character() {
        let table = Table::new("Sa\x07les", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(result, Err(EngineError::InvalidIdentifier { .. })));
    }

    #[test]
    fn build_rejects_measure_name_with_quote() {
        // Measure names are interpolated into SQL as quoted aliases
        // (`... AS "name"`), so they must obey the same rules.
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(crate::compute::measure::sum_measure(
                "Rev\"enue",
                "Sales",
                "amount",
            ))
            .build();
        assert!(matches!(
            model,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "Rev\"enue"
        ));
    }

    #[test]
    fn build_rejects_calculated_column_name_with_semicolon() {
        let cc = CalculatedColumn::new(
            "margin;drop",
            "Sales",
            crate::compute::expression::Expression::ColumnRef("amount".to_string()),
            DataType::Float64,
        );
        let result = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(cc)
            .build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "margin;drop"
        ));
    }

    #[test]
    fn build_accepts_legitimate_bi_names() {
        // Spaces, single dots, unicode letters, parentheses, and hyphens are
        // all legal in BI model names.
        let table = Table::new(
            "Sales Amount",
            vec![
                Column::new("Unit Price (USD)", DataType::Float64),
                Column::new("Försäljning", DataType::Float64),
                Column::new("v1.2 metric", DataType::Float64),
                Column::new("net-amount", DataType::Float64),
            ],
        )
        .unwrap();
        let result = DataModel::builder()
            .add_table(table)
            .add_table(Table::new("fact_sales", vec![Column::new("id", DataType::Int64)]).unwrap())
            .build();
        assert!(result.is_ok());
    }

    // --- Format version tests ---

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
