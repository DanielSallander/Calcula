//! Builder for constructing a validated [`DataModel`].

use crate::compute::expression::Expression;
use crate::compute::measure::{Measure, MeasureGroup};
use crate::compute::script::{ScriptFunction, ScriptSandboxConfig};
use crate::error::{EngineError, EngineResult};
use crate::model::calculated_column::CalculatedColumn;
use crate::model::calculation_group::CalculationGroup;
use crate::model::context::ContextDefinition;
use crate::model::context_column::ContextColumn;
use crate::model::global_variable::GlobalVariable;
use crate::model::hierarchy::Hierarchy;
use crate::model::kpi::{Kpi, KpiTarget};
use crate::model::relationship::Relationship;
use crate::model::security_role::SecurityRole;
use crate::model::source::PersistedSource;
use crate::model::table::Table;
use crate::model::table_variable::TableVariable;

use super::{
    apply_lookup_placeholder, validate_identifier, validate_metadata_text, DataModel,
    MAX_METADATA_DESCRIPTION_CHARS, MAX_METADATA_NAME_CHARS, MODEL_FORMAT_VERSION,
};

/// Builder for constructing a [`DataModel`] incrementally.
pub struct DataModelBuilder {
    pub(super) tables: Vec<Table>,
    pub(super) relationships: Vec<Relationship>,
    pub(super) measures: Vec<Measure>,
    pub(super) calculated_columns: Vec<CalculatedColumn>,
    pub(super) measure_groups: Vec<MeasureGroup>,
    pub(super) contexts: Vec<ContextDefinition>,
    pub(super) table_variables: Vec<TableVariable>,
    pub(super) global_variables: Vec<GlobalVariable>,
    pub(super) hierarchies: Vec<Hierarchy>,
    pub(super) default_lookup_resolution: Option<String>,
    pub(super) date_table: Option<String>,
    pub(super) script_functions: Vec<ScriptFunction>,
    pub(super) security_roles: Vec<SecurityRole>,
    pub(super) calculation_groups: Vec<CalculationGroup>,
    pub(super) kpis: Vec<Kpi>,
    pub(super) context_columns: Vec<ContextColumn>,
    pub(super) sources: Vec<PersistedSource>,
}

impl DataModelBuilder {
    /// Add a table to the model.
    pub fn add_table(mut self, table: Table) -> Self {
        self.tables.push(table);
        self
    }

    /// Add a persisted data source to the model's catalog.
    ///
    /// Records a secret-free [`PersistedSource`] descriptor (id, kind,
    /// connection target, preferred-auth hint) so a multi-source model can be
    /// reopened and reconnected without the host re-wiring every table. A
    /// table binds to a source by id via [`Table::with_source_binding`].
    /// Validated at [`build`](Self::build): source ids must be unique and every
    /// [`TableSourceBinding`](crate::model::TableSourceBinding) must reference a
    /// declared source.
    pub fn add_source(mut self, source: PersistedSource) -> Self {
        self.sources.push(source);
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

    /// Add a context-driven calculated column to the model.
    ///
    /// See [`ContextColumn`]. Validated at [`build`](Self::build): the
    /// expression must be row-level apart from its measure references (no
    /// aggregates or context operations outside a `MeasureRef`), all referenced
    /// measures and columns must exist, and the name must not collide with a
    /// physical, calculated, or other context column.
    pub fn add_context_column(mut self, context_column: ContextColumn) -> Self {
        self.context_columns.push(context_column);
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

    /// Add a sandboxed script function to the model.
    ///
    /// The function becomes callable from measures by name
    /// (`SUM(markup(t[cost], t[rate]))`). At `build()` time the engine
    /// validates the function's signature, checks its name does not collide
    /// with a built-in function or another script, and **parse-compiles** the
    /// body under a default sandbox to surface syntax errors early
    /// (compilation is not execution, so this is safe at build time). The
    /// body is actually *executed* only during a query, on the host's
    /// configured [`ScriptSandboxConfig`](crate::compute::script::ScriptSandboxConfig).
    ///
    /// ```
    /// use engine_core::compute::script::{ScriptFunction, ScriptType};
    /// use engine_core::model::{Column, DataModel, Table};
    /// use engine_core::types::DataType;
    ///
    /// let markup = ScriptFunction::builder("markup")
    ///     .param("cost", ScriptType::Float)
    ///     .param("rate", ScriptType::Float)
    ///     .returns(ScriptType::Float)
    ///     .body("cost * rate")
    ///     .build();
    ///
    /// let model = DataModel::builder()
    ///     .add_table(Table::new("Sales", vec![
    ///         Column::new("cost", DataType::Float64),
    ///         Column::new("rate", DataType::Float64),
    ///     ]).unwrap())
    ///     .add_script_function(markup)
    ///     .build()
    ///     .unwrap();
    /// assert_eq!(model.script_functions().len(), 1);
    /// ```
    pub fn add_script_function(mut self, function: ScriptFunction) -> Self {
        self.script_functions.push(function);
        self
    }

    /// Add a security role to the model.
    ///
    /// The role names per-table row filters; a host activates it on the
    /// engine via
    /// [`Engine::set_active_role`](crate) after authenticating the user, and
    /// every query is then restricted to the rows the role permits. At
    /// `build()` time the engine validates that the role name is unique and a
    /// legal identifier, and that each filter references a table and column
    /// that exist in the model.
    ///
    /// ```
    /// use engine_core::compute::expression::ComparisonOp;
    /// use engine_core::model::{Column, DataModel, SecurityRole, Table};
    /// use engine_core::types::DataType;
    ///
    /// let model = DataModel::builder()
    ///     .add_table(Table::new("Geography", vec![
    ///         Column::new("id", DataType::Int64),
    ///         Column::new("region", DataType::String),
    ///     ]).unwrap())
    ///     .add_security_role(
    ///         SecurityRole::new("WestOnly")
    ///             .with_filter("Geography", "region", ComparisonOp::Equal, "West"),
    ///     )
    ///     .build()
    ///     .unwrap();
    /// assert_eq!(model.security_roles().len(), 1);
    /// ```
    pub fn add_security_role(mut self, role: SecurityRole) -> Self {
        self.security_roles.push(role);
        self
    }

    /// Add a calculation group to the model.
    ///
    /// A calculation group is a set of named calculation items — reusable
    /// measure templates whose expressions transform an applied measure via
    /// the `SELECTEDMEASURE()` placeholder. At `build()` time the engine
    /// validates that group names are unique, item names are unique within a
    /// group, each group has at least one item, and each item's expression
    /// validates (with `SELECTEDMEASURE()` permitted) and references only
    /// columns and measures the model defines.
    ///
    /// ```
    /// use engine_core::model::{CalculationGroup, CalculationItem, Column, DataModel, Table};
    /// use engine_core::compute::measure::sum_measure;
    /// use engine_core::types::DataType;
    ///
    /// let model = DataModel::builder()
    ///     .add_table(Table::new("Sales", vec![
    ///         Column::new("amount", DataType::Float64),
    ///     ]).unwrap())
    ///     .add_measure(sum_measure("Revenue", "Sales", "amount"))
    ///     .add_calculation_group(CalculationGroup::new("Time", vec![
    ///         CalculationItem::from_text("Current", "SELECTEDMEASURE()").unwrap(),
    ///         CalculationItem::from_text("Doubled", "SELECTEDMEASURE() * 2").unwrap(),
    ///     ]))
    ///     .build()
    ///     .unwrap();
    /// assert_eq!(model.calculation_groups().len(), 1);
    /// ```
    pub fn add_calculation_group(mut self, group: CalculationGroup) -> Self {
        self.calculation_groups.push(group);
        self
    }

    /// Add a [`Kpi`] definition (status markup over a base measure).
    ///
    /// Validated at [`build`](Self::build): the name must be unique, the base
    /// measure and any `MeasureRef` target must exist, status-band thresholds
    /// must be ascending, and the description (if any) must be within limits.
    pub fn add_kpi(mut self, kpi: Kpi) -> Self {
        self.kpis.push(kpi);
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

    /// Mark a table as the model's date table.
    ///
    /// The date table is the calendar dimension whose
    /// [`DateRole`](crate::model::DateRole)-tagged columns
    /// ([`Column::with_date_role`](crate::model::Column::with_date_role))
    /// power time-intelligence functions (`YTD`, `QTD`, `MTD`, `PRIORYEAR`,
    /// `PRIORPERIOD`). Build-time validation checks that the table exists,
    /// that each date role appears on at most one of its columns, and that
    /// role data types are sensible: `DateKey` requires `Date` or
    /// `Timestamp`; `Year`/`Quarter`/`Month`/`Week`/`Day` accept integer or
    /// string columns (lenient — quarters are often stored as `"Q1"`-style
    /// strings).
    pub fn mark_date_table(mut self, table_name: impl Into<String>) -> Self {
        self.date_table = Some(table_name.into());
        self
    }

    /// Build the data model.
    ///
    /// Validates that:
    /// - Table names are unique
    /// - Relationship names are unique
    /// - All referenced tables and columns exist
    /// - Join column types are compatible
    pub fn build(mut self) -> EngineResult<DataModel> {
        // 0-ct. Synthesize the derived tables of materialized calculated
        // tables (idempotent reconcile: previously synthesized tables are
        // dropped and re-inferred, so build/validate replays converge). Runs
        // FIRST so the derived tables participate in every check below —
        // identifier validation, duplicate detection, relationships,
        // hierarchies, RLS — exactly like hand-authored tables.
        self.tables =
            super::reconcile_calculated_tables(std::mem::take(&mut self.tables), &self.global_variables)?;

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

        // 0-source. Persisted data-source catalog integrity. Source ids must be
        // unique (they are the key a table's `source_binding` resolves against
        // and the key the facade registers connectors under), and every table
        // binding must reference a declared source — a dangling `source_id`
        // would leave the table unwireable at load, so reject it at build.
        let mut seen_source_ids = std::collections::HashSet::new();
        for source in &self.sources {
            if !seen_source_ids.insert(source.id.as_str()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate data source id '{}'",
                    source.id
                )));
            }
        }
        for table in &self.tables {
            if let Some(binding) = table.source_binding() {
                if !seen_source_ids.contains(binding.source_id.as_str()) {
                    return Err(EngineError::InvalidData(format!(
                        "Table '{}' binds to data source '{}', which is not declared in the \
                         model's source catalog",
                        table.name(),
                        binding.source_id
                    )));
                }
            }
        }

        // 0a. Presentation metadata validation. Display names, descriptions,
        // and format strings are host-interpreted hints the engine never
        // parses, so validation is deliberately minimal: length caps (model
        // files are shared, so metadata must not become an unbounded
        // payload channel) and non-empty display names (an empty-but-
        // present display name would render as a blank field-list entry).
        for table in &self.tables {
            let entity = format!("table '{}'", table.name());
            if let Some(display_name) = table.display_name() {
                validate_metadata_text(
                    &entity,
                    "display_name",
                    display_name,
                    MAX_METADATA_NAME_CHARS,
                    true,
                )?;
            }
            if let Some(description) = table.description() {
                validate_metadata_text(
                    &entity,
                    "description",
                    description,
                    MAX_METADATA_DESCRIPTION_CHARS,
                    false,
                )?;
            }
            for col in table.columns() {
                let entity = format!("column '{}.{}'", table.name(), col.name());
                if let Some(display_name) = col.display_name() {
                    validate_metadata_text(
                        &entity,
                        "display_name",
                        display_name,
                        MAX_METADATA_NAME_CHARS,
                        true,
                    )?;
                }
                if let Some(description) = col.description() {
                    validate_metadata_text(
                        &entity,
                        "description",
                        description,
                        MAX_METADATA_DESCRIPTION_CHARS,
                        false,
                    )?;
                }
            }
        }
        for measure in &self.measures {
            let entity = format!("measure '{}'", measure.name());
            if let Some(format_string) = measure.format_string() {
                validate_metadata_text(
                    &entity,
                    "format_string",
                    format_string,
                    MAX_METADATA_NAME_CHARS,
                    false,
                )?;
            }
            if let Some(description) = measure.description() {
                validate_metadata_text(
                    &entity,
                    "description",
                    description,
                    MAX_METADATA_DESCRIPTION_CHARS,
                    false,
                )?;
            }
        }

        // 0b. Expression AST validation. Measures, calculated columns, and
        // global variables can be deserialized straight from model JSON,
        // bypassing the parser's allow-lists (most critically the date/time
        // interval keywords that the SQL renderers splice in raw). Validate
        // every expression tree — and the filter predicates embedded in
        // context definitions and table variables — before any SQL can be
        // generated from them.
        // Query-scoped (GVAR) variables are only legal at the top level of a
        // measure; a GVAR name must not collide with a model-level
        // `GlobalVariable` (both are referenced as bare identifiers, so the
        // precedence would be ambiguous — see `expand_scalar_globals`).
        let global_variable_names: std::collections::HashSet<String> = self
            .global_variables
            .iter()
            .map(|gv| gv.name().to_ascii_lowercase())
            .collect();
        for measure in &self.measures {
            measure.expression().validate()?;
            measure.expression().validate_query_scoped_top_level()?;
            // LOOKUPVALUE is a row-context tool resolved during
            // calculated-column materialization; a measure has no host row.
            if measure.expression().has_lookup_value() {
                return Err(EngineError::InvalidExpression(format!(
                    "measure '{}' uses LOOKUPVALUE, which is only supported in calculated \
                     columns (v1)",
                    measure.name()
                )));
            }
            // A dynamic format string must parse to a plain scalar expression
            // (evaluated once per query under the outer filter context) —
            // fail at build, not at first render.
            if let Some(fmt_src) = measure.format_string_expression() {
                let fmt_expr = crate::compute::parser::parse_measure_expression(fmt_src)
                    .map_err(|e| {
                        EngineError::InvalidExpression(format!(
                            "measure '{}': dynamic format string does not parse: {e}",
                            measure.name()
                        ))
                    })?;
                if fmt_expr.has_query_scoped_bindings()
                    || fmt_expr.has_lookup_value()
                    || matches!(fmt_expr, Expression::Query { .. })
                {
                    return Err(EngineError::InvalidExpression(format!(
                        "measure '{}': dynamic format string must be a plain scalar \
                         expression (no GVAR, QUERY, or LOOKUPVALUE)",
                        measure.name()
                    )));
                }
                fmt_expr.validate()?;
            }
            for gvar in measure.expression().root_query_scoped_names() {
                if global_variable_names.contains(&gvar.to_ascii_lowercase()) {
                    return Err(EngineError::InvalidExpression(format!(
                        "query-scoped variable (GVAR) '{gvar}' in measure '{}' collides with a \
                         calculated table of the same name; rename one of them",
                        measure.name()
                    )));
                }
            }
        }
        // GVAR is a query-path measure feature; it cannot be resolved for
        // row-level calculated columns or for model-level global variables, so
        // reject it there outright.
        for cc in &self.calculated_columns {
            cc.expression().validate()?;
            if cc.expression().has_query_scoped_bindings() {
                return Err(EngineError::InvalidExpression(format!(
                    "calculated column '{}' uses a query-scoped (GVAR) variable, which is only \
                     supported in measures",
                    cc.name()
                )));
            }
        }
        for gv in &self.global_variables {
            // Generated calendars carry an empty placeholder expression; the
            // spec itself is validated by schema inference during table
            // reconcile. Only the mode needs a gate here.
            if gv.calendar().is_some() {
                if gv.is_dynamic() {
                    return Err(EngineError::InvalidGlobalVariable {
                        name: gv.name().to_string(),
                        reason: "a CALENDAR calculated table must be materialized \
                                 (Dynamic = no); a generated date table has no per-query \
                                 filter-context meaning"
                            .to_string(),
                    });
                }
                continue;
            }
            match gv.expression() {
                // Aggregate-less QUERY (the DISTINCT form): executable only
                // as a materialized table — measure validation rejects it, so
                // it must not pass through `validate()` here.
                Expression::Query {
                    aggregates,
                    group_by,
                } if aggregates.is_empty() => {
                    if gv.is_dynamic() {
                        return Err(EngineError::InvalidGlobalVariable {
                            name: gv.name().to_string(),
                            reason: "QUERY(DISTINCT ...) requires a materialized calculated \
                                     table (Dynamic = no)"
                                .to_string(),
                        });
                    }
                    for (table, _column) in group_by {
                        validate_identifier(table, "group-by table")?;
                    }
                }
                _ => {
                    gv.expression().validate()?;
                    if gv.expression().has_query_scoped_bindings() {
                        return Err(EngineError::InvalidExpression(format!(
                            "calculated table '{}' uses a query-scoped (GVAR) variable, which \
                             is only supported in measures",
                            gv.name()
                        )));
                    }
                }
            }
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

            // A measure that references no columns is a constant (e.g. `BLANK()`,
            // `42`) — a valid placeholder with no home table, so skip the
            // table/column checks (validate its group and move on).
            if measure.column_references().is_empty() {
                if let Some(group_name) = measure.group() {
                    if !seen_groups.contains(group_name) {
                        return Err(EngineError::MeasureGroupNotFound(group_name.to_string()));
                    }
                }
                continue;
            }

            // A measure may aggregate over a DYNAMIC calculated table
            // (e.g. `SUM(ct[alias])`): the reference expands into a VAR
            // binding at evaluation, so the inferred "table" is not a model
            // table. Like MeasureRef-bearing measures above, deep validation
            // happens after expansion at query time — only the group is
            // checked here. (A MATERIALIZED calculated table needs no skip:
            // its derived table is a real model table.)
            if self
                .global_variables
                .iter()
                .any(|gv| gv.name() == measure.table() && gv.is_query() && gv.is_dynamic())
            {
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

            // Cross-table row references (RELATED-style): the referenced
            // table/column must exist, and the host must be the many (or
            // one-to-one) side of an active, equality-only relationship so
            // the LEFT JOIN at materialization cannot multiply host rows.
            // Mirrors the context-column contract (step 6a). Referenced
            // columns must be PHYSICAL (not calculated) — cross-table
            // calc-on-calc ordering is out of the v1 contract.
            let mut cross_table_cols: std::collections::HashSet<&str> =
                std::collections::HashSet::new();
            for (ref_table, col) in cc.expression().qualified_column_references() {
                if ref_table.eq_ignore_ascii_case(cc.table()) {
                    continue; // host-table reference, checked below
                }
                let other = self
                    .tables
                    .iter()
                    .find(|t| t.name().eq_ignore_ascii_case(ref_table))
                    .ok_or_else(|| EngineError::InvalidCalculatedColumn {
                        name: cc.name().to_string(),
                        reason: format!("references unknown table '{ref_table}'"),
                    })?;
                if other.column(col).is_err() {
                    return Err(EngineError::ExpressionColumnNotFound {
                        table: ref_table.to_string(),
                        column: col.to_string(),
                    });
                }
                let safe = self.relationships.iter().any(|r| {
                    let pair = (r.from_table().eq_ignore_ascii_case(cc.table())
                        && r.to_table().eq_ignore_ascii_case(ref_table))
                        || (r.from_table().eq_ignore_ascii_case(ref_table)
                            && r.to_table().eq_ignore_ascii_case(cc.table()));
                    pair && r.lookup_safe_from(cc.table())
                });
                if !safe {
                    return Err(EngineError::InvalidCalculatedColumn {
                        name: cc.name().to_string(),
                        reason: format!(
                            "references column '{ref_table}[{col}]' across a relationship that \
                             is not a fan-out-safe single hop from its host table '{}'. A \
                             calculated column may reference a related table only over an \
                             active, equality-only relationship on which the host is the many \
                             (or one-to-one) side (e.g. RELATED(dim[column]) from the fact)",
                            cc.table()
                        ),
                    });
                }
                cross_table_cols.insert(col);
            }

            // LOOKUPVALUE targets: table and columns must exist physically.
            for (lv_table, lv_result, lv_search) in cc.expression().lookup_values() {
                let other = self
                    .tables
                    .iter()
                    .find(|t| t.name().eq_ignore_ascii_case(lv_table))
                    .ok_or_else(|| EngineError::InvalidCalculatedColumn {
                        name: cc.name().to_string(),
                        reason: format!("LOOKUPVALUE references unknown table '{lv_table}'"),
                    })?;
                for col in std::iter::once(lv_result).chain(lv_search.iter().copied()) {
                    if other.column(col).is_err() {
                        return Err(EngineError::ExpressionColumnNotFound {
                            table: lv_table.to_string(),
                            column: col.to_string(),
                        });
                    }
                    cross_table_cols.insert(col);
                }
            }

            // All bare referenced columns must exist in the host table.
            // `column_references()` also yields the column part of qualified
            // and LOOKUPVALUE references — tolerated via `cross_table_cols`.
            for col_ref in cc.expression().column_references() {
                if cross_table_cols.contains(col_ref) {
                    continue;
                }
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

        // 6a. Validate context-driven calculated columns. Like calculated
        // columns, but the expression may reference a scalar measure (a
        // `MeasureRef`) that is resolved per query and substituted as a literal.
        // The column must therefore be row-level *apart from* its measure
        // references: substituting every reference with a placeholder must leave
        // an expression with no aggregates and no context operations (a bare
        // aggregate like `SUM([m])` is rejected because substitution does not
        // enter the `Aggregate` node). All referenced measures and columns must
        // exist, and the name must not collide with a physical, calculated, or
        // other context column.
        // Context-column names per host table (lowercased), so a reference from
        // one context column to another on the same table is recognized as a
        // dependency (inlined at query time) rather than rejected as an unknown
        // column. A cyclic reference is caught at query time, where the
        // resolver fails closed.
        let context_cols_by_host: std::collections::HashMap<
            String,
            std::collections::HashSet<String>,
        > = {
            let mut m: std::collections::HashMap<String, std::collections::HashSet<String>> =
                std::collections::HashMap::new();
            for c in &self.context_columns {
                m.entry(c.table().to_lowercase())
                    .or_default()
                    .insert(c.name().to_lowercase());
            }
            m
        };
        let mut seen_context_cols = std::collections::HashSet::new();
        for cc in &self.context_columns {
            let host_ctx_cols = context_cols_by_host.get(&cc.table().to_lowercase());
            let is_host_ctx_col =
                |name: &str| host_ctx_cols.is_some_and(|s| s.contains(&name.to_lowercase()));
            // Name uniqueness among context columns.
            if !seen_context_cols.insert(cc.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate context column '{}'",
                    cc.name()
                )));
            }
            // No collision with a calculated column.
            if seen_calc_cols.contains(cc.name()) {
                return Err(EngineError::InvalidContextColumn {
                    name: cc.name().to_string(),
                    reason: format!("name conflicts with calculated column '{}'", cc.name()),
                });
            }

            // Table must exist.
            let table = self
                .tables
                .iter()
                .find(|t| t.name() == cc.table())
                .ok_or_else(|| EngineError::InvalidContextColumn {
                    name: cc.name().to_string(),
                    reason: format!("table '{}' not found", cc.table()),
                })?;

            // Name must not collide with a physical column.
            if table.column(cc.name()).is_ok() {
                return Err(EngineError::InvalidContextColumn {
                    name: cc.name().to_string(),
                    reason: format!(
                        "name conflicts with physical column '{}' in table '{}'",
                        cc.name(),
                        cc.table()
                    ),
                });
            }

            // Every referenced measure must exist.
            for measure_name in cc.expression().measure_references() {
                if !self.measures.iter().any(|m| m.name() == measure_name) {
                    return Err(EngineError::InvalidContextColumn {
                        name: cc.name().to_string(),
                        reason: format!("references unknown measure '[{measure_name}]'"),
                    });
                }
            }

            // Row-level check: replace every measure reference with a
            // placeholder, then require no aggregates and no context ops in the
            // remainder. This permits `[m]` inside the column while rejecting a
            // bare aggregate or a context operation.
            let placeholders: std::collections::HashMap<String, Expression> = cc
                .expression()
                .measure_references()
                .into_iter()
                .map(|n| (n.to_string(), Expression::Blank))
                .collect();
            let row_level = cc.expression().substitute_measure_refs(&placeholders);
            if row_level.has_aggregate() {
                return Err(EngineError::InvalidContextColumn {
                    name: cc.name().to_string(),
                    reason: "the expression must be row-level — an aggregate is only allowed \
                             inside a referenced measure, not directly in the column"
                        .into(),
                });
            }
            if row_level.has_context_ops() {
                return Err(EngineError::InvalidContextColumn {
                    name: cc.name().to_string(),
                    reason: "the expression must not contain context operations \
                             (keep/clear/reset/traverse/using/block)"
                        .into(),
                });
            }
            if row_level.has_window() {
                return Err(EngineError::InvalidContextColumn {
                    name: cc.name().to_string(),
                    reason: "the expression must not contain window or running-total \
                             functions"
                        .into(),
                });
            }

            // Qualified column references resolve to either the host table or a
            // related table. A cross-table reference is allowed only across a
            // fan-out-safe single-hop relationship (the host is the many / 1:1
            // side), so the LEFT JOIN that renders it at query time can never
            // multiply the fact's rows and inflate the aggregate. Their column
            // names are remembered so the bare-name loop below tolerates them
            // (column_references() includes the column part of qualified refs).
            let mut cross_table_cols: std::collections::HashSet<&str> =
                std::collections::HashSet::new();
            for (ref_table, col) in cc.expression().qualified_column_references() {
                if ref_table.eq_ignore_ascii_case(cc.table()) {
                    // A reference to another context column on the host is a
                    // dependency, inlined at query time — not a physical column.
                    if is_host_ctx_col(col) {
                        cross_table_cols.insert(col);
                        continue;
                    }
                    if table.column(col).is_err() {
                        return Err(EngineError::ExpressionColumnNotFound {
                            table: cc.table().to_string(),
                            column: col.to_string(),
                        });
                    }
                    continue;
                }
                // Cross-table reference. The named table and column must exist.
                let other = self
                    .tables
                    .iter()
                    .find(|t| t.name().eq_ignore_ascii_case(ref_table))
                    .ok_or_else(|| EngineError::InvalidContextColumn {
                        name: cc.name().to_string(),
                        reason: format!("references unknown table '{ref_table}'"),
                    })?;
                if other.column(col).is_err() {
                    return Err(EngineError::ExpressionColumnNotFound {
                        table: ref_table.to_string(),
                        column: col.to_string(),
                    });
                }
                // There must be an active, equality-only relationship between
                // the host and the referenced table on which the host is the
                // many / one-to-one side (so the referenced value is a function
                // of the host row). `find_relationship` at query time returns
                // this same active relationship.
                let safe = self.relationships.iter().any(|r| {
                    let pair = (r.from_table().eq_ignore_ascii_case(cc.table())
                        && r.to_table().eq_ignore_ascii_case(ref_table))
                        || (r.from_table().eq_ignore_ascii_case(ref_table)
                            && r.to_table().eq_ignore_ascii_case(cc.table()));
                    pair && r.lookup_safe_from(cc.table())
                });
                if !safe {
                    return Err(EngineError::InvalidContextColumn {
                        name: cc.name().to_string(),
                        reason: format!(
                            "references column '{ref_table}[{col}]' across a relationship that is \
                             not a fan-out-safe single hop from its host table '{}'. A context \
                             column may reference a related table only over an active, \
                             equality-only relationship on which the host is the many (or \
                             one-to-one) side, so the join cannot multiply the fact's rows",
                            cc.table()
                        ),
                    });
                }
                cross_table_cols.insert(col);
            }
            // Every bare (unqualified) referenced column must exist on the host
            // table. column_references() also yields qualified columns' names,
            // so a name belonging to a validated cross-table reference is
            // tolerated here.
            for col_ref in cc.expression().column_references() {
                if table.column(col_ref).is_err()
                    && !cross_table_cols.contains(col_ref)
                    && !is_host_ctx_col(col_ref)
                {
                    return Err(EngineError::ExpressionColumnNotFound {
                        table: cc.table().to_string(),
                        column: col_ref.to_string(),
                    });
                }
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

        // 9. Validate calculated tables (model global variables).
        let mut seen_globals = std::collections::HashSet::new();
        for gv in &self.global_variables {
            // Must be a table-producing QUERY expression. (Scalar globals
            // were removed 2026-07-11 — a reusable scalar is a hidden
            // measure; see Calcula's docs/design/calculated-tables.md.)
            if !gv.is_query() {
                return Err(EngineError::InvalidGlobalVariable {
                    name: gv.name().to_string(),
                    reason: "a calculated table must be a table-producing QUERY(...) \
                             expression; for a reusable scalar, define a (hidden) measure \
                             instead"
                        .to_string(),
                });
            }

            // Unique names.
            if !seen_globals.insert(gv.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate calculated table '{}'",
                    gv.name()
                )));
            }

            // No collision with table names — except a materialized calculated
            // table's OWN derived table, which is synthesized under the same
            // name by design (see `reconcile_calculated_tables`).
            let collides_with_real_table = self
                .tables
                .iter()
                .any(|t| t.name() == gv.name() && !t.is_calculated());
            if collides_with_real_table {
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

            // Referenced table must exist. (A generated calendar reads from
            // no table — its `table` field is empty by construction.)
            if gv.calendar().is_none() && !seen_tables.contains(gv.table()) {
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
                    reason: format!(
                        "name conflicts with calculated table '{}'",
                        hierarchy.name()
                    ),
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

        // 11. Validate script functions. Script bodies travel inside shared
        // model files (a trust boundary), so each is checked here at build
        // time:
        // - the signature (name follows the call-identifier rule; parameter
        //   names are valid, unique Rhai identifiers);
        // - the name does not collide with a built-in function name — the
        //   parser dispatches built-ins before ever emitting a `Call`, so a
        //   script named e.g. `SUM` would be dead and silently ignored;
        // - the name does not duplicate another script function;
        // - the body *parse-compiles* under a default sandbox. This catches
        //   syntax errors early; it is parse-only (NOT execution), so it is
        //   safe at build time — actual execution uses the host's configured
        //   sandbox at query time.
        {
            let mut seen_scripts = std::collections::HashSet::new();
            // A default sandbox is used solely to parse bodies. Limits here
            // are irrelevant (no script runs); execution always uses the
            // host's configured ScriptSandboxConfig.
            let parse_sandbox = ScriptSandboxConfig::default();
            for function in &self.script_functions {
                function.validate_signature()?;

                if crate::compute::parser::is_builtin_function_name(function.name()) {
                    return Err(EngineError::ScriptError {
                        function: function.name().to_string(),
                        position: None,
                        message: format!(
                            "name collides with the built-in function '{}'; the parser \
                             dispatches built-ins before script calls, so this script \
                             could never be called",
                            function.name()
                        ),
                    });
                }

                if !seen_scripts.insert(function.name()) {
                    return Err(EngineError::DuplicateName(format!(
                        "Duplicate script function '{}'",
                        function.name()
                    )));
                }

                // Parse-only compile (surfaces syntax errors as ScriptError).
                crate::compute::script::compile_script_function(function, &parse_sandbox)?;
            }
        }

        // 11b. Validate the date table. Only the marked table is checked:
        // date roles on unmarked tables are inert metadata until the table
        // is marked, at which point this step runs against it.
        if let Some(date_table_name) = &self.date_table {
            use crate::model::column::DateRole;
            use crate::types::DataType;

            let table = self
                .tables
                .iter()
                .find(|t| t.name() == date_table_name.as_str())
                .ok_or_else(|| EngineError::InvalidDateTable {
                    table: date_table_name.clone(),
                    reason: "table not found in model".to_string(),
                })?;

            let mut seen_roles: std::collections::HashMap<DateRole, &str> =
                std::collections::HashMap::new();
            for col in table.columns() {
                let Some(role) = col.date_role() else {
                    continue;
                };
                if let Some(previous) = seen_roles.insert(role, col.name()) {
                    return Err(EngineError::InvalidDateTable {
                        table: date_table_name.clone(),
                        reason: format!(
                            "date role {role} is assigned to multiple columns \
                             ('{previous}' and '{}'); each role may appear on at \
                             most one column",
                            col.name()
                        ),
                    });
                }
                match role {
                    // The date key is the real calendar column.
                    DateRole::DateKey => {
                        if !matches!(col.data_type(), DataType::Date | DataType::Timestamp) {
                            return Err(EngineError::InvalidDateTable {
                                table: date_table_name.clone(),
                                reason: format!(
                                    "column '{}' with role DateKey must be Date or \
                                     Timestamp, got {:?}",
                                    col.name(),
                                    col.data_type()
                                ),
                            });
                        }
                    }
                    // Part columns are lenient: integers are the common case,
                    // strings are accepted for labels like "Q1" / "2024-03".
                    DateRole::Year
                    | DateRole::Quarter
                    | DateRole::Month
                    | DateRole::Week
                    | DateRole::Day => {
                        if !matches!(
                            col.data_type(),
                            DataType::Int32 | DataType::Int64 | DataType::String
                        ) {
                            return Err(EngineError::InvalidDateTable {
                                table: date_table_name.clone(),
                                reason: format!(
                                    "column '{}' with role {role} must be an integer \
                                     or string type, got {:?}",
                                    col.name(),
                                    col.data_type()
                                ),
                            });
                        }
                    }
                }
            }
        }

        // 12. Validate security roles. Roles travel inside shared model files
        // (a trust boundary) AND are a security control, so each is checked
        // here at build time:
        // - the role name is a unique, legal identifier (it is surfaced in
        //   errors and folded into the query-cache key);
        // - each filter predicate validates for safe SQL rendering and
        //   references a table and column that exist in the model — a role
        //   that pointed at a phantom column would silently restrict nothing.
        {
            let mut seen_roles = std::collections::HashSet::new();
            for role in &self.security_roles {
                validate_identifier(role.name(), "security role")?;
                if !seen_roles.insert(role.name()) {
                    return Err(EngineError::DuplicateName(format!(
                        "Duplicate security role '{}'",
                        role.name()
                    )));
                }
                for filter in role.table_filters() {
                    // Safe SQL rendering of the predicate's raw table qualifier.
                    filter.validate()?;
                    // The referenced table must exist...
                    let table = self
                        .tables
                        .iter()
                        .find(|t| t.name() == filter.table)
                        .ok_or_else(|| {
                            EngineError::InvalidData(format!(
                                "security role '{}' filters unknown table '{}'",
                                role.name(),
                                filter.table
                            ))
                        })?;
                    // ...and the referenced column must exist on it.
                    if table.column(&filter.column).is_err() {
                        return Err(EngineError::InvalidData(format!(
                            "security role '{}' filters unknown column '{}' on table '{}'",
                            role.name(),
                            filter.column,
                            filter.table
                        )));
                    }
                }
            }
        }

        // 13. Validate incremental-refresh policies. The `refresh_filter`
        // travels inside shared model files (a trust boundary) and is later
        // (a) pushed to the source as WHERE conditions and (b) rendered into
        // DataFusion SQL for cache retention, so a bad filter must be caught
        // here rather than at refresh time. For each table with a policy:
        // - the table must be `InMemory` (incremental refresh is meaningless
        //   for DirectQuery — there is no cache to retain);
        // - the `refresh_filter` must parse and be an AND-combination of
        //   simple comparisons `column <op> rhs`, where every column exists on
        //   THIS table (no cross-table refs), `<op>` is a comparison, and
        //   every `rhs` is a constant-foldable scalar (a literal or a date
        //   expression over TODAY/NOW/DATE/DATEADD/DATETRUNC).
        // v1 limitation: OR / NOT / arbitrary boolean predicates and a
        // raw-SQL escape hatch are future work (see `compute::incremental`).
        for table in &self.tables {
            let Some(incremental) = table.incremental_refresh() else {
                continue;
            };
            if !table.is_in_memory() {
                return Err(EngineError::InvalidData(format!(
                    "table '{}' has an incremental_refresh policy but is not InMemory; \
                     incremental refresh is only meaningful for in-memory tables",
                    table.name()
                )));
            }
            let column_names: Vec<&str> = table.columns().iter().map(|c| c.name()).collect();
            crate::compute::incremental::validate_refresh_filter(
                table.name(),
                incremental.refresh_filter(),
                &column_names,
            )?;
        }

        // 14. Validate calculation groups. Each group is a set of measure
        // templates ("calculation items"); their item expressions are
        // author-written and travel inside shared model files, so they are
        // checked at build time:
        // - group names are unique;
        // - a group has at least one item (an empty group can transform
        //   nothing);
        // - item names are unique within their group (the synthetic result
        //   column for a (measure, item) pair is named "measure [item]", so
        //   duplicate item names would collide);
        // - each item expression validates for safe SQL rendering with
        //   SELECTEDMEASURE() permitted (`validate_calc_item`);
        // - each item references only measures the model defines (any
        //   MeasureRef must resolve) and only columns that exist somewhere in
        //   the model (a typo'd column would otherwise surface only after a
        //   group is applied at query time).
        {
            let mut seen_groups = std::collections::HashSet::new();
            for group in &self.calculation_groups {
                if !seen_groups.insert(group.name()) {
                    return Err(EngineError::DuplicateName(format!(
                        "Duplicate calculation group '{}'",
                        group.name()
                    )));
                }
                if group.items().is_empty() {
                    return Err(EngineError::InvalidData(format!(
                        "calculation group '{}' has no items; a group must define at \
                         least one calculation item",
                        group.name()
                    )));
                }
                let mut seen_items = std::collections::HashSet::new();
                for item in group.items() {
                    if !seen_items.insert(item.name()) {
                        return Err(EngineError::DuplicateName(format!(
                            "duplicate calculation item '{}' in group '{}'",
                            item.name(),
                            group.name()
                        )));
                    }
                    // SELECTEDMEASURE() is allowed in a calc item; everything
                    // else is enforced as for a regular measure expression.
                    item.expression().validate_calc_item()?;
                    // GVAR (query-scoped variables) is rejected outright:
                    // applying a group always activates the calc-group path,
                    // which fails closed on GVARs at query time — so an item
                    // declaring one could never be evaluated. Rejecting at
                    // build keeps unusable definitions out of the model (same
                    // policy as calculated columns and global variables).
                    if item.expression().has_query_scoped_bindings() {
                        return Err(EngineError::InvalidExpression(format!(
                            "calculation item '{}' in group '{}' uses a query-scoped (GVAR) \
                             variable, which is not supported in calculation items",
                            item.name(),
                            group.name()
                        )));
                    }
                    // Any MeasureRef inside the item must resolve.
                    for measure_name in
                        crate::model::calculation_group::measure_ref_names(item.expression())
                    {
                        if self.measures.iter().all(|m| m.name() != measure_name) {
                            return Err(EngineError::InvalidData(format!(
                                "calculation item '{}' in group '{}' references unknown \
                                 measure '{measure_name}'",
                                item.name(),
                                group.name()
                            )));
                        }
                    }
                    // Any qualified column reference must point at a real
                    // table+column (bare column refs carry no table, so they
                    // are left to substitution/query-time resolution).
                    for (table_name, column_name) in
                        crate::model::calculation_group::qualified_column_refs(item.expression())
                    {
                        let column_ok = self
                            .tables
                            .iter()
                            .find(|t| t.name() == table_name)
                            .is_some_and(|t| t.column(&column_name).is_ok());
                        if !column_ok {
                            return Err(EngineError::InvalidData(format!(
                                "calculation item '{}' in group '{}' references unknown \
                                 column '{table_name}[{column_name}]'",
                                item.name(),
                                group.name()
                            )));
                        }
                    }
                }
            }
        }

        // 15. Validate KPI definitions (author-defined status markup). KPIs are
        // presentation metadata, but they reference measures and travel inside
        // shared model files, so they are checked at build time:
        // - KPI names are unique;
        // - the base measure exists;
        // - a `MeasureRef` target measure exists;
        // - status-band thresholds are strictly ascending (so a host can map a
        //   ratio to exactly one band by the last threshold it meets or exceeds);
        // - any description is within the metadata length limit.
        {
            let mut seen_kpis = std::collections::HashSet::new();
            for kpi in &self.kpis {
                if !seen_kpis.insert(kpi.name()) {
                    return Err(EngineError::DuplicateName(format!(
                        "Duplicate KPI '{}'",
                        kpi.name()
                    )));
                }
                if self.measures.iter().all(|m| m.name() != kpi.base_measure()) {
                    return Err(EngineError::MeasureNotFound(format!(
                        "KPI '{}' references unknown base measure '{}'",
                        kpi.name(),
                        kpi.base_measure()
                    )));
                }
                if let KpiTarget::Measure(target) = kpi.target() {
                    if self.measures.iter().all(|m| m.name() != target) {
                        return Err(EngineError::MeasureNotFound(format!(
                            "KPI '{}' target references unknown measure '{target}'",
                            kpi.name()
                        )));
                    }
                }
                let mut prev: Option<f64> = None;
                for band in kpi.status_bands() {
                    if prev.is_some_and(|p| band.threshold <= p) {
                        return Err(EngineError::InvalidMetadata {
                            entity: format!("KPI '{}'", kpi.name()),
                            field: "status_bands".to_string(),
                            reason: "status-band thresholds must be strictly ascending".to_string(),
                        });
                    }
                    prev = Some(band.threshold);
                }
                if let Some(description) = kpi.description() {
                    validate_metadata_text(
                        &format!("KPI '{}'", kpi.name()),
                        "description",
                        description,
                        MAX_METADATA_DESCRIPTION_CHARS,
                        false,
                    )?;
                }
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
            date_table: self.date_table,
            script_functions: self.script_functions,
            security_roles: self.security_roles,
            calculation_groups: self.calculation_groups,
            kpis: self.kpis,
            context_columns: self.context_columns,
            sources: self.sources,
            // Descriptive metadata is set post-build (with_model_metadata); a
            // freshly built model carries none.
            model_name: None,
            model_version: None,
            model_author: None,
            model_description: None,
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
