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
use crate::model::calculation_group::CalculationGroup;
use crate::model::context::ContextDefinition;
use crate::model::context_column::ContextColumn;
use crate::model::global_variable::GlobalVariable;
use crate::model::hierarchy::Hierarchy;
use crate::model::kpi::Kpi;
use crate::model::relationship::Relationship;
use crate::model::security_role::SecurityRole;
use crate::model::source::PersistedSource;
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
/// - `5` — row-level security: the model gained `security_roles`, a list of
///   author-defined [`SecurityRole`](crate::model::SecurityRole)s, each with
///   per-table row filters that restrict which rows an activated role may
///   see. This is authored, behavior-bearing content — and, unlike most,
///   it is a **security control**: an older engine that silently dropped it
///   on a load→save round-trip would turn a restricted model into an
///   unrestricted one, leaking data. The [`ModelFormatTooNew`] load gate
///   therefore refuses v5 files on a pre-v5 engine rather than letting them
///   round-trip without the roles.
/// - `6` — incremental refresh: tables gained an optional
///   `incremental_refresh` policy
///   ([`IncrementalRefresh`](crate::model::IncrementalRefresh)) carrying a
///   `refresh_filter` that identifies the volatile rows to re-fetch on a
///   stale-table refresh. This is authored, behavior-bearing content: an
///   older engine that silently dropped it on a load→save round-trip would
///   turn an incremental table back into a **full**-refresh table (re-pulling
///   the whole table from source on every refresh) without the author's
///   knowledge — a silent correctness/performance regression rather than a
///   safe default. The [`ModelFormatTooNew`] load gate therefore refuses v6
///   files on a pre-v6 engine rather than letting them round-trip without the
///   policy.
/// - `7` — calculation groups: the model gained `calculation_groups`, a list
///   of author-defined [`CalculationGroup`](crate::model::CalculationGroup)s
///   (reusable measure templates whose items transform an applied measure),
///   and the persisted expression tree gained the
///   [`SelectedMeasure`](crate::compute::expression::Expression::SelectedMeasure)
///   variant (the `SELECTEDMEASURE()` placeholder). Both are authored content
///   an older engine would silently drop — or, for the new expression variant,
///   fail to deserialize — on a load→save round-trip, so the
///   [`ModelFormatTooNew`] load gate refuses v7 files on a pre-v7 engine.
///
/// - `8` — the expression tree gained the
///   [`DatesInPeriod`](crate::compute::expression::Expression::DatesInPeriod)
///   variant (the `DATESINPERIOD` trailing-window time-intelligence function),
///   which an older engine would fail to deserialize, so the
///   [`ModelFormatTooNew`] gate refuses v8 files on a pre-v8 engine.
///
/// - `10` — the model gained [`kpis`](DataModel::kpis), a list of author-defined
///   KPI definitions (each a base measure, a target, and status bands). This is
///   authored, behavior-bearing metadata that a pre-v10 engine would silently
///   drop on a load→save round-trip, so the [`ModelFormatTooNew`] gate refuses
///   v10 files on a pre-v10 engine.
///
/// - `11` — a [security role](crate::model::SecurityRole)'s
///   [`FilterPredicate`](crate::compute::expression::FilterPredicate) gained a
///   `dynamic` field for **dynamic** row-level security (`USERNAME()` /
///   `CUSTOMDATA()`). A pre-v11 engine would ignore the unknown field and treat
///   the predicate as a static comparison against its placeholder value — a
///   silent RLS mis-restriction — so the [`ModelFormatTooNew`] gate must refuse
///   v11 files on a pre-v11 engine.
///
/// - `12` — the model gained [`context_columns`](DataModel::context_columns),
///   a list of author-defined context-driven calculated columns. Each is a
///   groupable column whose row-level expression may reference a scalar measure
///   that is resolved per query from the filter context (e.g. an as-of payment
///   flag). This is authored, behavior-bearing content a pre-v12 engine would
///   silently drop on a load→save round-trip — and a query grouping by such a
///   column would fail outright — so the [`ModelFormatTooNew`] gate refuses v12
///   files on a pre-v12 engine.
/// - `13` — the `Block` expression (VAR/RETURN) gained
///   `query_scoped_bindings`, the serialized form of query-scoped (`GVAR`)
///   variables — scalars evaluated once per query filter context, ignoring the
///   group-by axis. A pre-v13 engine that ignored the field would silently drop
///   the `GVAR` bindings and leave their references dangling (a wrong number),
///   so the [`ModelFormatTooNew`] gate refuses v13 files on a pre-v13 engine.
/// - `14` — persisted multi-source bindings: the model gained
///   [`sources`](DataModel::sources), a secret-free catalog of
///   [`PersistedSource`](crate::model::PersistedSource) descriptors (each an id,
///   kind, connection target, and preferred-auth *hint* — never a credential),
///   and tables gained an optional
///   [`source_binding`](crate::model::Table::source_binding)
///   ([`TableSourceBinding`](crate::model::TableSourceBinding): source id +
///   schema + table). Together these let a multi-source model be reopened and
///   auto-reconnected (`Engine::wire_sources`) instead of the host re-wiring
///   every table by hand. This is authored, behavior-bearing content a pre-v14
///   engine would silently drop on a load→save round-trip (losing the model's
///   data-source wiring), so the [`ModelFormatTooNew`] gate refuses v14 files on
///   a pre-v14 engine. This bump also finalizes the presentation-only model
///   metadata fields (`model_name`/`model_version`/`model_author`/
///   `model_description`) added earlier in anticipation of v14.
///
/// [`ModelFormatTooNew`]: crate::error::EngineError::ModelFormatTooNew
pub const MODEL_FORMAT_VERSION: u32 = 14;

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
    /// Author-defined security roles for row-level security. Each role names
    /// per-table row filters; a host activates one role on the engine and
    /// every query is then restricted to the rows that role permits. Empty by
    /// default and skipped on serialization when empty (back-compat with
    /// pre-v5 model files). See [`SecurityRole`] for the full semantics.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    security_roles: Vec<SecurityRole>,
    /// Author-defined calculation groups: reusable measure templates whose
    /// items transform an applied measure (via the `SELECTEDMEASURE()`
    /// placeholder). Applied per-query — the synthetic measures they produce
    /// are ephemeral and never persisted. Empty by default and skipped on
    /// serialization when empty (back-compat with pre-v7 model files). See
    /// [`CalculationGroup`] for the full semantics.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    calculation_groups: Vec<CalculationGroup>,
    /// Author-defined KPI definitions (a base measure, a target, and status
    /// bands). Presentation metadata: surfaced in result-column metadata for the
    /// base measure so a host can render its status indicator. Empty by default
    /// and skipped on serialization when empty (back-compat with pre-v10 model
    /// files). See [`Kpi`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    kpis: Vec<Kpi>,
    /// Author-defined context-driven calculated columns: groupable columns
    /// whose row-level value is computed per query from a scalar measure
    /// resolved against the query's filter context. Empty by default and
    /// skipped on serialization when empty (back-compat with pre-v12 model
    /// files). See [`ContextColumn`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    context_columns: Vec<ContextColumn>,
    /// Persisted data-source catalog: secret-free [`PersistedSource`]
    /// descriptors that let a multi-source model be reopened and reconnected
    /// (`Engine::wire_sources`) without the host re-wiring every table. Each
    /// table's [`Table::source_binding`] references an entry here by id. Empty
    /// by default and skipped on serialization when empty (back-compat with
    /// pre-v14 model files). No secrets are stored. See [`PersistedSource`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sources: Vec<PersistedSource>,
    /// Optional descriptive metadata (name/version/author/description) for the
    /// model. Presentation only — no query effect. Set post-build via
    /// [`DataModel::with_model_metadata`]; `None` by default and skipped on
    /// serialization when absent (back-compat with models written before v14).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_description: Option<String>,
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
            security_roles: Vec::new(),
            calculation_groups: Vec::new(),
            kpis: Vec::new(),
            context_columns: Vec::new(),
            sources: Vec::new(),
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

    /// Returns the persisted data-source catalog.
    ///
    /// Each entry is a secret-free [`PersistedSource`] descriptor. A host
    /// reconnects them via `Engine::wire_sources`; a table binds to one by id
    /// through its [`Table::source_binding`]. Empty for single-source or
    /// runtime-wired models.
    pub fn sources(&self) -> &[PersistedSource] {
        &self.sources
    }

    /// Look up a persisted data source by its id.
    pub fn source(&self, id: &str) -> Option<&PersistedSource> {
        self.sources.iter().find(|s| s.id == id)
    }

    /// Append a persisted data source to the catalog, rejecting a duplicate id.
    ///
    /// Used by the engine facade's composite-model helpers when a host
    /// registers a source that should be persisted with the model. Prefer
    /// [`DataModelBuilder::add_source`] at build time.
    pub fn push_source(&mut self, source: PersistedSource) -> EngineResult<()> {
        if self.sources.iter().any(|s| s.id == source.id) {
            return Err(EngineError::DuplicateName(format!(
                "Duplicate data source id '{}'",
                source.id
            )));
        }
        self.sources.push(source);
        Ok(())
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

    /// Returns the names of the measures that **directly reference** `name`
    /// (the reverse dependency edge), deduplicated and sorted.
    ///
    /// This is the "who depends on me?" query a host (Calcula Studio) needs for
    /// safe-rename/refactor, impact analysis before deleting a measure, and the
    /// lineage panel. It is the inverse of [`Measure::referenced_measures`]: `B`
    /// is in `measure_dependents("A")` iff `A` is in
    /// `model.measure("B").referenced_measures()`. Only **direct** dependents
    /// are returned; walk transitively for the full impact set. An unknown
    /// `name` simply yields an empty list (no measure references it).
    ///
    /// [`Measure::referenced_measures`]: crate::compute::measure::Measure::referenced_measures
    pub fn measure_dependents(&self, name: &str) -> Vec<&str> {
        let mut dependents: Vec<&str> = self
            .measures
            .iter()
            .filter(|m| m.referenced_measures().contains(&name))
            .map(|m| m.name())
            .collect();
        dependents.sort_unstable();
        dependents.dedup();
        dependents
    }

    /// Validate a **candidate** measure against this model without a full
    /// rebuild — the primitive a designer (Calcula Studio) needs for editor-time
    /// validation on every keystroke/save.
    ///
    /// Much cheaper than [`DataModelBuilder::build`]: it checks only the
    /// candidate, not every existing measure, relationship, and table. The
    /// candidate may be new or replace an existing measure of the same name (so
    /// editing is supported). It catches:
    ///
    /// - **expression validity** — the same per-expression checks `build()`
    ///   runs ([`Expression::validate`]): SQL-safety allow-lists and the GVAR
    ///   (query-scoped variable) rules, including top-level placement and the
    ///   GVAR-name vs model global-variable collision
    ///   ([`EngineError::InvalidExpression`]);
    /// - **circular / unknown measure references** (`[OtherMeasure]`), including
    ///   a self-reference and a reference that would close a cycle with existing
    ///   measures ([`EngineError::InvalidData`] / [`EngineError::MeasureNotFound`]);
    /// - **unknown qualified columns** (`Table[Column]`): the referenced table
    ///   must exist and own the column ([`EngineError::ColumnNotFound`] /
    ///   [`EngineError::TableNotFound`]).
    ///
    /// It does **not** check relationship reachability, bare (unqualified)
    /// column references, or UDF registration (the engine facade's
    /// `validate_measure_text` adds the UDF check, which needs the registered
    /// set). `build` and query planning remain the full authority.
    ///
    /// [`Expression::validate`]: crate::compute::expression::Expression::validate
    ///
    /// [`DataModelBuilder::build`]: crate::model::DataModelBuilder::build
    pub fn validate_candidate_measure(&self, candidate: &Measure) -> EngineResult<()> {
        use crate::compute::expression::expand_measure_refs;

        // Expression-level validation — the same checks `build()` runs per
        // measure: SQL-safety allow-lists, and the GVAR (query-scoped variable)
        // rules (scalar-only binding, no VAR/forward references, duplicate
        // names, top-level placement). Without this, a host calling
        // `validate_measure_text` would accept a measure that a subsequent
        // model build rejects.
        candidate.expression().validate()?;
        candidate.expression().validate_query_scoped_top_level()?;

        // A GVAR name must not collide with a model global variable (both are
        // referenced as bare identifiers — the precedence would be ambiguous).
        // Mirrors the same check in `DataModelBuilder::build`.
        for gvar in candidate.expression().root_query_scoped_names() {
            if self
                .global_variables
                .iter()
                .any(|gv| gv.name().eq_ignore_ascii_case(gvar))
            {
                return Err(EngineError::InvalidExpression(format!(
                    "query-scoped variable (GVAR) '{gvar}' in measure '{}' collides with a \
                     model global variable of the same name; rename one of them",
                    candidate.name()
                )));
            }
        }

        // A temporary view in which the candidate's name resolves to its (new)
        // definition, so self/forward references and any newly-introduced cycle
        // with existing measures are detected.
        let mut temp = self.clone();
        match temp
            .measures
            .iter_mut()
            .find(|m| m.name() == candidate.name())
        {
            Some(slot) => *slot = candidate.clone(),
            None => temp.measures.push(candidate.clone()),
        }

        // Measure references: cycle detection + unknown-target resolution.
        expand_measure_refs(candidate.expression(), &temp)?;

        // Qualified `Table[Column]` references must resolve. A qualifier that is
        // not a model table is a VAR/QUERY/context binding name (validated
        // elsewhere) and is skipped here.
        for (table, column) in candidate.expression().qualified_column_references() {
            if let Ok(t) = temp.table(table) {
                t.column(column)?;
            }
        }
        Ok(())
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

    /// Returns all security roles defined in the model.
    pub fn security_roles(&self) -> &[SecurityRole] {
        &self.security_roles
    }

    /// Look up a security role by name (exact match).
    ///
    /// Returns [`EngineError::SecurityRoleNotFound`] when no role with that
    /// name exists — callers must treat this as a hard error rather than
    /// proceeding without RLS.
    pub fn security_role(&self, name: &str) -> EngineResult<&SecurityRole> {
        self.security_roles
            .iter()
            .find(|r| r.name() == name)
            .ok_or_else(|| EngineError::SecurityRoleNotFound(name.to_string()))
    }

    /// Returns all calculation groups defined in the model.
    pub fn calculation_groups(&self) -> &[CalculationGroup] {
        &self.calculation_groups
    }

    /// Look up a calculation group by name (exact match).
    ///
    /// Returns [`EngineError::CalculationGroupNotFound`] when no group with
    /// that name exists.
    pub fn calculation_group(&self, name: &str) -> EngineResult<&CalculationGroup> {
        self.calculation_groups
            .iter()
            .find(|g| g.name() == name)
            .ok_or_else(|| EngineError::CalculationGroupNotFound(name.to_string()))
    }

    /// Returns all KPI definitions in the model.
    pub fn kpis(&self) -> &[Kpi] {
        &self.kpis
    }

    /// Look up a KPI by name (exact match), or `None` when absent.
    pub fn kpi(&self, name: &str) -> Option<&Kpi> {
        self.kpis.iter().find(|k| k.name() == name)
    }

    /// Returns a clone of this model with `extra` measures appended.
    ///
    /// This is the cheap overlay used to plan and execute a calculation-group
    /// application: the synthetic measures produced by
    /// [`expand_calculation_group`](crate::model::calculation_group::expand_calculation_group)
    /// are derived from already-validated parts (an existing measure's
    /// expression substituted into a build-time-validated calculation item),
    /// so they need no full re-validation — only a name-collision check
    /// against the existing measures. The overlay is per-query and ephemeral;
    /// the synthetic measures are never written back to the persistent model.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::DuplicateName`] when an `extra` measure's name
    /// collides with an existing model measure (or with another `extra`).
    pub fn with_overlay_measures(&self, extra: Vec<Measure>) -> EngineResult<DataModel> {
        let mut model = self.clone();
        let mut seen: std::collections::HashSet<String> = model
            .measures
            .iter()
            .map(|m| m.name().to_string())
            .collect();
        for measure in &extra {
            if !seen.insert(measure.name().to_string()) {
                return Err(EngineError::DuplicateName(format!(
                    "overlay measure '{}' collides with an existing measure",
                    measure.name()
                )));
            }
        }
        model.measures.extend(extra);
        Ok(model)
    }

    /// Returns a copy of the model with its measure list REPLACED — the model
    /// editing primitive (add/update/delete measures are all list edits on the
    /// host side). Performs no validation itself: callers are expected to run
    /// [`DataModel::validate`] on the result before installing it on an engine,
    /// so they can surface rich errors (duplicate names, dangling references,
    /// circular measure refs) in their own UI.
    pub fn with_measures(&self, measures: Vec<Measure>) -> DataModel {
        let mut model = self.clone();
        model.measures = measures;
        model
    }

    /// Replace the measure whose name matches `measure` (case-insensitively)
    /// **in place**, returning `true` when a measure was replaced and `false`
    /// when no measure of that name exists (the model is then unchanged).
    ///
    /// The in-place sibling of [`DataModel::with_measures`] for callers that
    /// own the model and update one measure at a time (e.g. the engine
    /// facade's per-query `GVAR` resolution overlay) — avoiding a full model
    /// clone per update. Same caller-validates contract as `with_measures`:
    /// no validation is performed here.
    pub fn replace_measure(&mut self, measure: Measure) -> bool {
        match self
            .measures
            .iter_mut()
            .find(|m| m.name().eq_ignore_ascii_case(measure.name()))
        {
            Some(slot) => {
                *slot = measure;
                true
            }
            None => false,
        }
    }

    /// Returns a copy of the model with its measure-group (display-folder) list
    /// REPLACED (caller-validates contract, see [`DataModel::with_measures`]).
    /// A measure's `group` must name one of these, so hosts assigning a measure
    /// to a new folder should declare the group here too — see
    /// [`DataModel::ensure_measure_groups`].
    pub fn with_measure_groups(&self, measure_groups: Vec<MeasureGroup>) -> DataModel {
        let mut model = self.clone();
        model.measure_groups = measure_groups;
        model
    }

    /// Declare (in place) a [`MeasureGroup`] for every group name referenced by
    /// a measure that is not already declared, so the model validates after a
    /// measure is filed into a new folder. Names are matched case-sensitively
    /// and existing groups (and their descriptions) are preserved. Returns the
    /// number of groups added.
    pub fn ensure_measure_groups(&mut self) -> usize {
        let declared: std::collections::HashSet<String> = self
            .measure_groups
            .iter()
            .map(|g| g.name().to_string())
            .collect();
        let mut to_add: Vec<String> = Vec::new();
        for m in &self.measures {
            if let Some(name) = m.group() {
                if !declared.contains(name) && !to_add.iter().any(|n| n == name) {
                    to_add.push(name.to_string());
                }
            }
        }
        let added = to_add.len();
        for name in to_add {
            self.measure_groups.push(MeasureGroup::new(name));
        }
        added
    }

    /// Returns a copy of the model with its table list REPLACED (model
    /// editing primitive; same caller-validates contract as
    /// [`DataModel::with_measures`]).
    pub fn with_tables(&self, tables: Vec<Table>) -> DataModel {
        let mut model = self.clone();
        model.tables = tables;
        model
    }

    /// Returns a copy of the model with its persisted data-source catalog
    /// REPLACED (caller-validates contract, see [`DataModel::with_measures`]).
    /// Used by the host to edit/remove a source; pair with [`Table::set_source_binding`]
    /// on the affected tables (removing a source should clear the bindings that
    /// name it).
    pub fn with_sources(&self, sources: Vec<PersistedSource>) -> DataModel {
        let mut model = self.clone();
        model.sources = sources;
        model
    }

    /// Returns a copy of the model with its relationship list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_relationships(&self, relationships: Vec<Relationship>) -> DataModel {
        let mut model = self.clone();
        model.relationships = relationships;
        model
    }

    /// Returns a copy of the model with its calculated-column list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_calculated_columns(&self, columns: Vec<CalculatedColumn>) -> DataModel {
        let mut model = self.clone();
        model.calculated_columns = columns;
        model
    }

    /// Returns a copy of the model with its hierarchy list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_hierarchies(&self, hierarchies: Vec<Hierarchy>) -> DataModel {
        let mut model = self.clone();
        model.hierarchies = hierarchies;
        model
    }

    /// Returns a copy of the model with its KPI list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_kpis(&self, kpis: Vec<Kpi>) -> DataModel {
        let mut model = self.clone();
        model.kpis = kpis;
        model
    }

    /// Returns a copy of the model with its security-role list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_security_roles(&self, roles: Vec<SecurityRole>) -> DataModel {
        let mut model = self.clone();
        model.security_roles = roles;
        model
    }

    /// Returns a copy of the model with its calculation-group list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_calculation_groups(&self, groups: Vec<CalculationGroup>) -> DataModel {
        let mut model = self.clone();
        model.calculation_groups = groups;
        model
    }

    /// Returns a copy of the model with its context list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_contexts(&self, contexts: Vec<ContextDefinition>) -> DataModel {
        let mut model = self.clone();
        model.contexts = contexts;
        model
    }

    /// Returns a copy of the model with its context-column list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_context_columns(&self, context_columns: Vec<ContextColumn>) -> DataModel {
        let mut model = self.clone();
        model.context_columns = context_columns;
        model
    }

    /// Returns a copy of the model with its table-variable list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_table_variables(&self, table_variables: Vec<TableVariable>) -> DataModel {
        let mut model = self.clone();
        model.table_variables = table_variables;
        model
    }

    /// Returns a copy of the model with its global-variable list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_global_variables(&self, global_variables: Vec<GlobalVariable>) -> DataModel {
        let mut model = self.clone();
        model.global_variables = global_variables;
        model
    }

    /// Returns a copy of the model with its script-function list REPLACED
    /// (caller-validates contract, see [`DataModel::with_measures`]).
    pub fn with_script_functions(&self, script_functions: Vec<ScriptFunction>) -> DataModel {
        let mut model = self.clone();
        model.script_functions = script_functions;
        model
    }

    /// Returns a copy of the model with the marked date-table name REPLACED
    /// (`None` clears the marking). No validation itself — callers run
    /// [`DataModel::validate`] on the result (see [`DataModel::with_measures`]).
    pub fn with_date_table(&self, date_table: Option<String>) -> DataModel {
        let mut model = self.clone();
        model.date_table = date_table;
        model
    }

    /// Returns a copy of the model with the model-level default lookup
    /// resolution expression REPLACED (`None` clears it; falls back to the
    /// built-in `MIN(col)`). Caller-validates contract (see
    /// [`DataModel::with_measures`]).
    pub fn with_default_lookup_resolution(&self, expr: Option<String>) -> DataModel {
        let mut model = self.clone();
        model.default_lookup_resolution = expr;
        model
    }

    /// Optional descriptive model name (presentation only).
    pub fn model_name(&self) -> Option<&str> {
        self.model_name.as_deref()
    }

    /// Optional model version string (presentation only).
    pub fn model_version(&self) -> Option<&str> {
        self.model_version.as_deref()
    }

    /// Optional model author (presentation only).
    pub fn model_author(&self) -> Option<&str> {
        self.model_author.as_deref()
    }

    /// Optional model description (presentation only).
    pub fn model_description(&self) -> Option<&str> {
        self.model_description.as_deref()
    }

    /// Returns a copy of the model with its descriptive metadata REPLACED (each
    /// field independently; `None` clears it). Presentation only — no
    /// validation needed.
    pub fn with_model_metadata(
        &self,
        name: Option<String>,
        version: Option<String>,
        author: Option<String>,
        description: Option<String>,
    ) -> DataModel {
        let mut model = self.clone();
        model.model_name = name;
        model.model_version = version;
        model.model_author = author;
        model.model_description = description;
        model
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

    /// Returns all context-driven calculated columns in the model.
    pub fn context_columns(&self) -> &[ContextColumn] {
        &self.context_columns
    }

    /// Returns the context-driven calculated column with the given name, if any.
    ///
    /// Matched case-insensitively (exact match preferred), consistent with the
    /// engine's table/column identifier resolution.
    pub fn context_column(&self, name: &str) -> Option<&ContextColumn> {
        self.context_columns
            .iter()
            .find(|c| c.name() == name)
            .or_else(|| {
                self.context_columns
                    .iter()
                    .find(|c| c.name().eq_ignore_ascii_case(name))
            })
    }

    /// Returns context-driven calculated columns defined on a specific table
    /// (matched case-insensitively).
    pub fn context_columns_for_table(&self, table_name: &str) -> Vec<&ContextColumn> {
        self.context_columns
            .iter()
            .filter(|cc| cc.table().eq_ignore_ascii_case(table_name))
            .collect()
    }

    /// Inline references to other context-driven calculated columns on `host`
    /// into `expr`, returning a self-contained row-level expression in which
    /// only measure references and physical columns remain.
    ///
    /// A reference (a bare column, or a `host`-qualified column, whose name is
    /// another context column on `host`) is resolved by recursively inlining
    /// the referenced column's own expression first, so a chain `C → B → A`
    /// flattens in one pass. `visiting` carries the resolution stack (seed it
    /// with the starting column's lowercased name) so a cycle — direct or
    /// indirect — is detected and returns an error rather than recursing
    /// forever. When `expr` references no context column it is returned
    /// unchanged (a no-op for the common, independent case).
    ///
    /// The candidate references are taken from `column_references()`, which is a
    /// slight over-approximation: a *cross-table* qualified column that happens
    /// to share a name with a host context column is treated as a candidate for
    /// recursion (though [`substitute_context_column_refs`](crate::compute::expression::Expression::substitute_context_column_refs)
    /// will not actually replace it). This is harmless except in the contrived
    /// case where that shared name also closes a dependency cycle, which would
    /// be reported as a (fail-closed) circular reference. Avoid naming a context
    /// column identically to a cross-table column you reference.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::InvalidData`](crate::error::EngineError::InvalidData)
    /// on a circular reference.
    pub fn inline_context_column_refs(
        &self,
        host: &str,
        expr: &crate::compute::expression::Expression,
        visiting: &mut Vec<String>,
    ) -> EngineResult<crate::compute::expression::Expression> {
        use crate::compute::expression::Expression;
        let host_ctx: std::collections::HashSet<String> = self
            .context_columns_for_table(host)
            .iter()
            .map(|c| c.name().to_lowercase())
            .collect();
        if host_ctx.is_empty() {
            return Ok(expr.clone());
        }
        let mut env: std::collections::HashMap<String, Expression> =
            std::collections::HashMap::new();
        for name in expr.column_references() {
            let name_lc = name.to_lowercase();
            if !host_ctx.contains(&name_lc) || env.contains_key(&name_lc) {
                continue;
            }
            if visiting.iter().any(|v| v == &name_lc) {
                return Err(EngineError::InvalidData(format!(
                    "circular reference among context-driven calculated columns (via '{name}'); \
                     a context column must not reference itself directly or indirectly"
                )));
            }
            let referenced = self.context_column(name).ok_or_else(|| {
                EngineError::InvalidData(format!(
                    "context-column reference '{name}' could not be resolved"
                ))
            })?;
            visiting.push(name_lc.clone());
            let inlined =
                self.inline_context_column_refs(host, referenced.expression(), visiting)?;
            visiting.pop();
            env.insert(name_lc, inlined);
        }
        if env.is_empty() {
            return Ok(expr.clone());
        }
        Ok(expr.substitute_context_column_refs(host, &env))
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
        for role in &self.security_roles {
            builder = builder.add_security_role(role.clone());
        }
        for cg in &self.calculation_groups {
            builder = builder.add_calculation_group(cg.clone());
        }
        for cc in &self.context_columns {
            builder = builder.add_context_column(cc.clone());
        }
        for source in &self.sources {
            builder = builder.add_source(source.clone());
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
        // Reparsing recomputes each measure's cached home table from its own
        // expression; give measure-only measures theirs from what they reference.
        self.resolve_measure_home_tables();
    }

    /// Give measures that reference ONLY other measures (e.g. `[Total Sales] +
    /// 1000`, `[Profit] / [Revenue]`) a home table, by expanding their measure
    /// references against the model and re-inferring the fact table.
    ///
    /// [`infer_fact_table`](crate::compute::expression::infer_fact_table) alone
    /// cannot see through a [`MeasureRef`](crate::compute::expression::Expression::MeasureRef)
    /// — it has no model — so such a measure's cached home table would otherwise
    /// be empty and fail model validation (`TableNotFound("")`). This associates
    /// it with the home table of the measures it builds on. Idempotent; a measure
    /// whose references are circular or themselves tableless is left unresolved.
    pub fn resolve_measure_home_tables(&mut self) {
        use crate::compute::expression::{expand_measure_refs, infer_fact_table};
        let resolved: Vec<(usize, String)> = self
            .measures
            .iter()
            .enumerate()
            .filter(|(_, m)| m.table().trim().is_empty())
            .filter_map(|(i, m)| {
                expand_measure_refs(m.expression(), self)
                    .ok()
                    .and_then(|e| infer_fact_table(&e))
                    .map(|t| (i, t))
            })
            .collect();
        for (i, table) in resolved {
            self.measures[i].set_home_table(table);
        }
    }

    /// Propagate a measure rename into its dependents: rewrite every measure's
    /// `[old]` reference as `[new]`, leaving qualified column references
    /// (`Table[old]`) untouched. Call this after renaming a measure so an
    /// expression like `[Revenue] + 1000` follows `Revenue` -> `Total Sales`
    /// instead of dangling. Home tables are preserved (a rename never moves a
    /// measure). Returns the number of dependent measures that changed.
    pub fn rewrite_measure_references(&mut self, old: &str, new: &str) -> usize {
        if old == new {
            return 0;
        }
        let mut changed = 0;
        for m in &mut self.measures {
            if m.rename_measure_reference(old, new) {
                changed += 1;
            }
        }
        changed
    }

    /// Find the active relationship between two tables (searches both directions).
    ///
    /// Returns the first **active** relationship where one table is on the "from"
    /// side and the other is on the "to" side. Inactive relationships (used via
    /// `USERELATIONSHIP`) are skipped.
    pub fn find_relationship(&self, table_a: &str, table_b: &str) -> EngineResult<&Relationship> {
        // Table names are matched case-insensitively, consistent with the rest
        // of the engine's identifier resolution (and with build-time validation
        // of cross-table references). Existing callers pass canonical model
        // names, so this only widens matching for differently-cased inputs.
        self.relationships
            .iter()
            .find(|r| {
                r.is_active()
                    && ((r.from_table().eq_ignore_ascii_case(table_a)
                        && r.to_table().eq_ignore_ascii_case(table_b))
                        || (r.from_table().eq_ignore_ascii_case(table_b)
                            && r.to_table().eq_ignore_ascii_case(table_a)))
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
                (r.from_table().eq_ignore_ascii_case(table_a)
                    && r.to_table().eq_ignore_ascii_case(table_b))
                    || (r.from_table().eq_ignore_ascii_case(table_b)
                        && r.to_table().eq_ignore_ascii_case(table_a))
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
    fn find_relationship_matches_table_names_case_insensitively() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(sales_products_relationship())
            .build()
            .unwrap();
        // Canonical case, lowercase, and uppercase all resolve the same
        // relationship — consistent with build-time cross-table validation.
        assert!(model.find_relationship("Sales", "Products").is_ok());
        assert!(model.find_relationship("sales", "products").is_ok());
        assert!(model.find_relationship("SALES", "PRODUCTS").is_ok());
        assert!(model.find_relationship("products", "sales").is_ok());
        assert!(model.find_any_relationship("sales", "PRODUCTS").is_ok());
    }

    #[test]
    fn measure_dependents_returns_direct_reverse_edges() {
        use crate::compute::expression::Expression;
        use crate::compute::measure::{sum_measure, Measure};

        // Revenue, Cost (base); Profit = [Revenue] - [Cost]; Margin = [Profit].
        let profit = Measure::new(
            "Profit",
            Expression::MeasureRef("Revenue".into())
                .subtract(Expression::MeasureRef("Cost".into())),
        );
        let margin = Measure::new("Margin", Expression::MeasureRef("Profit".into()));

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .add_measure(sum_measure("Cost", "Sales", "amount"))
            .add_measure(profit)
            .add_measure(margin)
            .build()
            .unwrap();

        // Forward edge.
        assert_eq!(
            model.measure("Profit").unwrap().referenced_measures(),
            vec!["Cost", "Revenue"]
        );
        // Reverse edges (direct dependents only).
        assert_eq!(model.measure_dependents("Revenue"), vec!["Profit"]);
        assert_eq!(model.measure_dependents("Cost"), vec!["Profit"]);
        assert_eq!(model.measure_dependents("Profit"), vec!["Margin"]);
        assert!(model.measure_dependents("Margin").is_empty());
        assert!(model.measure_dependents("Nonexistent").is_empty());
    }

    #[test]
    fn validate_candidate_measure_accepts_valid_and_rejects_bad() {
        use crate::compute::expression::Expression;
        use crate::compute::measure::{sum_measure, Measure};
        use crate::compute::parser::parse_measure_expression;

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();

        // Valid: references an existing measure and a real qualified column.
        let good = Measure::new("Double", parse_measure_expression("[Revenue] * 2").unwrap());
        assert!(model.validate_candidate_measure(&good).is_ok());
        let good2 = Measure::new(
            "More",
            parse_measure_expression("SUM(Sales[amount])").unwrap(),
        );
        assert!(model.validate_candidate_measure(&good2).is_ok());

        // Unknown referenced measure.
        let bad_ref = Measure::new("X", Expression::MeasureRef("Ghost".into()));
        assert!(model.validate_candidate_measure(&bad_ref).is_err());

        // Unknown qualified column on a real table.
        let bad_col = Measure::new("Y", parse_measure_expression("SUM(Sales[nope])").unwrap());
        assert!(model.validate_candidate_measure(&bad_col).is_err());

        // Self-reference closes a cycle.
        let cyclic = Measure::new("Loop", Expression::MeasureRef("Loop".into()));
        assert!(model.validate_candidate_measure(&cyclic).is_err());
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

    // --- Entity list replacement (model editing primitives) ---

    #[test]
    fn with_entity_lists_replace_and_validate_catches_dangling_refs() {
        use crate::model::relationship::{Cardinality, Relationship};

        let model = DataModel::builder()
            .add_table(sales_table())
            .build()
            .unwrap();

        // A relationship to a non-existent table passes the (validation-free)
        // list replacement but fails the caller's validate() contract.
        let edited = model.with_relationships(vec![Relationship::new(
            "sales_to_nowhere",
            "Sales",
            "id",
            "Nowhere",
            "id",
            Cardinality::ManyToOne,
        )]);
        assert!(edited.validate().is_err());
        assert!(model.relationships().is_empty(), "original untouched");

        // Replacing tables with an empty list orphans nothing here and
        // validates clean.
        let empty = model.with_tables(Vec::new());
        empty.validate().unwrap();
        assert!(empty.tables().is_empty());
    }

    // --- Measure list replacement (model editing primitive) ---

    #[test]
    fn with_measures_replaces_the_list_without_touching_the_original() {
        use crate::compute::measure::{count_measure, sum_measure};

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();

        let edited = model.with_measures(vec![
            count_measure("Orders", "Sales", "id").with_source("COUNT(Sales[id])")
        ]);
        edited.validate().unwrap();
        assert_eq!(edited.measures().len(), 1);
        assert_eq!(edited.measures()[0].name(), "Orders");
        assert_eq!(edited.measures()[0].source(), Some("COUNT(Sales[id])"));
        // The original is untouched (copy-on-edit).
        assert_eq!(model.measures().len(), 1);
        assert_eq!(model.measures()[0].name(), "Revenue");
    }

    #[test]
    fn ensure_measure_groups_declares_referenced_folders_so_validate_passes() {
        use crate::compute::measure::sum_measure;

        // A measure filed into folder "Sales" whose group is NOT declared fails
        // validation with MeasureGroupNotFound...
        let grouped = sum_measure("Revenue", "Sales", "amount")
            .with_source("SUM(Sales[amount])")
            .with_group("Sales");
        let model = DataModel::builder()
            .add_table(sales_table())
            .build()
            .unwrap();
        let mut edited = model.with_measures(vec![grouped]);
        assert!(edited.validate().is_err());

        // ...until the group is declared, which ensure_measure_groups does.
        assert_eq!(edited.ensure_measure_groups(), 1);
        assert_eq!(edited.measure_groups().len(), 1);
        assert_eq!(edited.measure_groups()[0].name(), "Sales");
        edited.validate().unwrap();

        // Idempotent: a second call adds nothing.
        assert_eq!(edited.ensure_measure_groups(), 0);
    }

    #[test]
    fn constant_blank_measure_validates_without_a_home_table() {
        use crate::compute::parser::parse_measure_expression;

        // An empty formula is a BLANK() placeholder: no columns, no home table.
        let blank =
            Measure::new("Placeholder", parse_measure_expression("").unwrap()).with_source("");
        let model = DataModel::builder()
            .add_table(sales_table())
            .build()
            .unwrap();
        let edited = model.with_measures(vec![blank]);
        assert_eq!(edited.measures()[0].table(), "");
        edited.validate().unwrap();
    }

    #[test]
    fn with_measures_result_fails_validate_on_dangling_measure_ref() {
        use crate::compute::measure::sum_measure;
        use crate::compute::measure::Measure;
        use crate::compute::parser::parse_measure_expression;

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .add_measure(Measure::new(
                "Boosted",
                parse_measure_expression("[Revenue] + SUM(Sales[amount])").unwrap(),
            ))
            .build()
            .unwrap();

        // Deleting Revenue leaves Boosted's [Revenue] reference dangling —
        // validate() (the caller's contract) must reject the edited model.
        let edited = model.with_measures(
            model
                .measures()
                .iter()
                .filter(|m| m.name() != "Revenue")
                .cloned()
                .collect(),
        );
        assert!(edited.validate().is_err());
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
