//! Writeback columns — host-fed, per-key input columns on model tables.
//!
//! A writeback column lets END USERS type values into a model table's rows
//! (e.g. a `Forecast` column on `dim_customer`, keyed by `ID`): the model
//! designer declares the column, its key columns, and how collected values
//! project into the displayed value. The engine owns the DEFINITION and the
//! query semantics; the HOST owns the collected submissions (drafts, approval,
//! transport) and feeds data in via `Engine::set_writeback_data`.
//!
//! Every writeback column desugars at model build time to existing machinery
//! (see `reconcile_writeback_tables` in `schema`):
//!
//! - a hidden **history table** `__wb_{id}_hist` — the append-only submission
//!   history (key columns + value + submitter + timestamp + state), queryable
//!   like any table (reports over the full history of a row) and the input to
//!   the `Expression` projection;
//! - a hidden **current table** `__wb_{id}` — at most one row per key, the
//!   projected display value;
//! - a generated cross-table calculated column
//!   `LOOKUPVALUE(__wb_{id}[value], __wb_{id}[k], host[k], ...)` (marked
//!   `generated_by`) — so the user-facing column rides the ordinary
//!   deduplicated-LEFT-JOIN materialization path, and measures/aggregation
//!   over it need no new query code.
//!
//! Both synthesized tables are [`Table::is_writeback_store`]: never fetched
//! from a connector, skipped by staleness refresh (an uncached store is seeded
//! EMPTY so queries always work), and replaced only by host feeds.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::Expression;
use crate::error::{EngineError, EngineResult};
use crate::model::calculated_column::CalculatedColumn;
use crate::model::column::Column;
use crate::model::schema::validate_identifier;
use crate::types::DataType;

/// Governance flavor of a writeback column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WritebackColumnKind {
    /// Collect-style column: anyone with access writes; every submission is
    /// an immutable, timestamped history record; any projection policy.
    #[default]
    History,
    /// Master-data column: one shared, approval-gated value per row; only the
    /// designated `allowed_editors` may write. The projection is always the
    /// latest APPROVED value (the host enforces approval + the editor gate on
    /// its submit path; the engine records the intent).
    MasterData,
}

/// How the collected history projects into the column's displayed value.
/// The HOST computes the projection (it owns submission states) and feeds the
/// result into the current table; `Blank`/`Latest` are fixed policies, and
/// `Expression` carries a designer-written aggregation expression evaluated
/// per key over the history table's columns.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WritebackProjection {
    /// The column renders empty after every reload; collected history is
    /// retained (publisher review, reports) but never re-fed.
    Blank,
    /// Latest applicable value per key (approved-only when approval is
    /// required; otherwise latest submitted).
    #[default]
    Latest,
    /// Designer-written aggregation expression over the history table,
    /// evaluated per key (host runs it through the ordinary query pipeline).
    /// The text is authored content; the host validates it parses before
    /// accepting the definition.
    Expression(String),
}

/// Engine-neutral value constraints for a writeback column — what the host's
/// input UI and submit gates enforce. A deliberate mirror of the distribution
/// layer's value schema, kept engine-owned so `engine-core` stays transport-
/// agnostic.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct WritebackConstraints {
    /// A value must be present (no blank submissions).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    /// Minimum bound for numeric values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// Maximum bound for numeric values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Allowed values (enum-style input).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<String>,
    /// Maximum text length in characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    /// Regex pattern for text validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

/// Reserved column names of the synthesized store tables. A key column with
/// one of these names would collide with the store schema.
pub const WRITEBACK_RESERVED_COLUMNS: [&str; 5] = [
    "value",
    "submitter_id",
    "submitter_name",
    "submitted_at",
    "state",
];

/// A designer-declared writeback column on a model table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WritebackColumn {
    /// Stable identity: lowercase `[a-z0-9-]` (a UUID in practice). Survives
    /// renames; names the synthesized store tables and doubles as the host's
    /// submission-region key, so its charset must stay path-safe.
    id: String,
    /// User-facing column name on the host table.
    name: String,
    /// The host table this column belongs to.
    table: String,
    /// The value type users enter.
    data_type: DataType,
    /// Host-table columns identifying a row (the submission key). v1: each
    /// must be an `Int64` or `String` physical column on the host table.
    key_columns: Vec<String>,
    /// Governance flavor.
    #[serde(default, skip_serializing_if = "is_default_kind")]
    kind: WritebackColumnKind,
    /// Display projection policy.
    #[serde(default, skip_serializing_if = "is_default_projection")]
    projection: WritebackProjection,
    /// Value constraints enforced by the host's input/submit paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    constraints: Option<WritebackConstraints>,
    /// MasterData: identities (names/ids, host-interpreted) allowed to write.
    /// Empty means "no restriction" (History) or "publisher only" (MasterData,
    /// host-enforced).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    allowed_editors: Vec<String>,
    /// Expose the history table in field lists (unhidden, friendly display
    /// name) so reports can show the full submission history of a row.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    expose_history: bool,
    /// Presentation metadata for the user-facing column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format_string: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_aggregation: Option<AggregateOp>,
}

fn is_default_kind(k: &WritebackColumnKind) -> bool {
    *k == WritebackColumnKind::History
}
fn is_default_projection(p: &WritebackProjection) -> bool {
    *p == WritebackProjection::Latest
}

impl WritebackColumn {
    /// Create a writeback column definition. `id` must be lowercase
    /// `[a-z0-9-]` (validated at model build).
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        table: impl Into<String>,
        data_type: DataType,
        key_columns: Vec<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            table: table.into(),
            data_type,
            key_columns,
            kind: WritebackColumnKind::default(),
            projection: WritebackProjection::default(),
            constraints: None,
            allowed_editors: Vec::new(),
            expose_history: false,
            display_name: None,
            description: None,
            format_string: None,
            default_aggregation: None,
        }
    }

    /// Set the governance kind.
    pub fn with_kind(mut self, kind: WritebackColumnKind) -> Self {
        self.kind = kind;
        self
    }

    /// Set the display projection policy.
    pub fn with_projection(mut self, projection: WritebackProjection) -> Self {
        self.projection = projection;
        self
    }

    /// Set the value constraints.
    pub fn with_constraints(mut self, constraints: WritebackConstraints) -> Self {
        self.constraints = Some(constraints);
        self
    }

    /// Set the allowed editors (MasterData).
    pub fn with_allowed_editors(mut self, editors: Vec<String>) -> Self {
        self.allowed_editors = editors;
        self
    }

    /// Expose the history table in field lists.
    pub fn with_expose_history(mut self, expose: bool) -> Self {
        self.expose_history = expose;
        self
    }

    /// Set the presentation display name.
    pub fn with_display_name(mut self, display_name: impl Into<String>) -> Self {
        self.display_name = Some(display_name.into());
        self
    }

    /// Set the presentation description.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Set the presentation format string.
    pub fn with_format_string(mut self, format_string: impl Into<String>) -> Self {
        self.format_string = Some(format_string.into());
        self
    }

    /// Set the default aggregation hint.
    pub fn with_default_aggregation(mut self, op: AggregateOp) -> Self {
        self.default_aggregation = Some(op);
        self
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn table(&self) -> &str {
        &self.table
    }
    pub fn data_type(&self) -> &DataType {
        &self.data_type
    }
    pub fn key_columns(&self) -> &[String] {
        &self.key_columns
    }
    pub fn kind(&self) -> WritebackColumnKind {
        self.kind
    }
    pub fn projection(&self) -> &WritebackProjection {
        &self.projection
    }
    pub fn constraints(&self) -> Option<&WritebackConstraints> {
        self.constraints.as_ref()
    }
    pub fn allowed_editors(&self) -> &[String] {
        &self.allowed_editors
    }
    pub fn expose_history(&self) -> bool {
        self.expose_history
    }
    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
    pub fn format_string(&self) -> Option<&str> {
        self.format_string.as_deref()
    }
    pub fn default_aggregation(&self) -> Option<AggregateOp> {
        self.default_aggregation
    }

    /// The id compacted for use inside table names: hyphens stripped, so the
    /// synthesized names stay single parser tokens (an Expression projection
    /// is REWRITTEN to reference them textually and then parsed — a hyphen
    /// would tokenize as subtraction). UUID ids make post-strip collisions
    /// negligible; the duplicate-id gate at build catches any real clash.
    fn table_id(&self) -> String {
        self.id.chars().filter(|c| *c != '-').collect()
    }

    /// Name of the synthesized history (append-only submissions) table.
    pub fn history_table_name(&self) -> String {
        format!("__wb_{}_hist", self.table_id())
    }

    /// Name of the synthesized current (one row per key) table the generated
    /// column looks up against.
    pub fn current_table_name(&self) -> String {
        format!("__wb_{}", self.table_id())
    }

    /// Validate the definition's own shape (identifiers, id charset, keys
    /// present, projection expression non-empty). Resolution against the
    /// model (host table exists, key columns exist with supported types)
    /// happens during synthesis at model build.
    pub fn validate(&self) -> EngineResult<()> {
        let invalid = |reason: String| EngineError::InvalidData(reason);
        if self.id.is_empty()
            || !self
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(invalid(format!(
                "writeback column '{}': id '{}' must be non-empty lowercase [a-z0-9-] \
                 (it names the synthesized store tables and the host's submission region)",
                self.name, self.id
            )));
        }
        validate_identifier(&self.name, "writeback column")?;
        validate_identifier(&self.table, "writeback column host table")?;
        if self.key_columns.is_empty() {
            return Err(invalid(format!(
                "writeback column '{}': at least one key column is required to identify \
                 a host-table row",
                self.name
            )));
        }
        for key in &self.key_columns {
            validate_identifier(key, "writeback key column")?;
            if WRITEBACK_RESERVED_COLUMNS
                .iter()
                .any(|r| key.eq_ignore_ascii_case(r))
            {
                return Err(invalid(format!(
                    "writeback column '{}': key column '{}' collides with a reserved \
                     store column ({})",
                    self.name,
                    key,
                    WRITEBACK_RESERVED_COLUMNS.join(", ")
                )));
            }
        }
        if let WritebackProjection::Expression(expr) = &self.projection {
            if expr.trim().is_empty() {
                return Err(invalid(format!(
                    "writeback column '{}': the Expression projection needs a non-empty \
                     expression",
                    self.name
                )));
            }
        }
        Ok(())
    }

    /// Columns of the synthesized history table: the key columns (types
    /// copied from the host) + value + submitter/timestamp/state.
    pub(crate) fn history_columns(&self, key_types: &[(String, DataType)]) -> Vec<Column> {
        let mut cols: Vec<Column> = key_types
            .iter()
            .map(|(name, dt)| Column::new(name.clone(), dt.clone()))
            .collect();
        cols.push(Column::new("value", self.data_type.clone()));
        cols.push(Column::new("submitter_id", DataType::String));
        cols.push(Column::new("submitter_name", DataType::String));
        cols.push(Column::new("submitted_at", DataType::String));
        cols.push(Column::new("state", DataType::String));
        cols
    }

    /// Columns of the synthesized current table: key columns + value.
    pub(crate) fn current_columns(&self, key_types: &[(String, DataType)]) -> Vec<Column> {
        let mut cols: Vec<Column> = key_types
            .iter()
            .map(|(name, dt)| Column::new(name.clone(), dt.clone()))
            .collect();
        cols.push(Column::new("value", self.data_type.clone()));
        cols
    }

    /// The generated user-facing calculated column:
    /// `LOOKUPVALUE(__wb_{id}[value], __wb_{id}[k], host-row k, ...)`,
    /// marked `generated_by` so editors treat it as machinery.
    pub(crate) fn generated_column(&self) -> CalculatedColumn {
        let expression = Expression::LookupValue {
            table: self.current_table_name(),
            result_column: "value".to_string(),
            search: self
                .key_columns
                .iter()
                .map(|k| (k.clone(), Expression::ColumnRef(k.clone())))
                .collect(),
        };
        CalculatedColumn::new(&self.name, &self.table, expression, self.data_type.clone())
            .with_generated_by(&self.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wb() -> WritebackColumn {
        WritebackColumn::new(
            "0198c1c2-abcd-7000-8000-0123456789ab",
            "Forecast",
            "dim_customer",
            DataType::Float64,
            vec!["ID".to_string()],
        )
    }

    #[test]
    fn serde_round_trip_defaults_skipped() {
        let w = wb();
        let json = serde_json::to_string(&w).unwrap();
        // Default kind/projection/expose flags are omitted on the wire.
        assert!(!json.contains("kind"));
        assert!(!json.contains("projection"));
        assert!(!json.contains("expose_history"));
        let back: WritebackColumn = serde_json::from_str(&json).unwrap();
        assert_eq!(w, back);
    }

    #[test]
    fn serde_round_trip_full() {
        let w = wb()
            .with_kind(WritebackColumnKind::MasterData)
            .with_projection(WritebackProjection::Expression("MAX(value)".into()))
            .with_constraints(WritebackConstraints {
                required: true,
                min: Some(0.0),
                max: Some(100.0),
                ..Default::default()
            })
            .with_allowed_editors(vec!["Alice".into()])
            .with_expose_history(true)
            .with_display_name("Forecast (input)")
            .with_default_aggregation(AggregateOp::Sum);
        let json = serde_json::to_string(&w).unwrap();
        let back: WritebackColumn = serde_json::from_str(&json).unwrap();
        assert_eq!(w, back);
    }

    #[test]
    fn validate_gates_id_keys_and_expression() {
        assert!(wb().validate().is_ok());

        let mut bad_id = wb();
        bad_id.id = "Not A Safe Id!".to_string();
        assert!(bad_id.validate().is_err());

        let mut no_keys = wb();
        no_keys.key_columns.clear();
        assert!(no_keys.validate().is_err());

        let mut reserved = wb();
        reserved.key_columns = vec!["Value".to_string()];
        assert!(reserved.validate().is_err());

        let empty_expr = wb().with_projection(WritebackProjection::Expression("  ".into()));
        assert!(empty_expr.validate().is_err());
    }

    #[test]
    fn synthesized_names_and_columns() {
        let w = wb();
        // Hyphens are stripped so the names stay single parser tokens.
        assert_eq!(
            w.history_table_name(),
            "__wb_0198c1c2abcd700080000123456789ab_hist"
        );
        assert_eq!(
            w.current_table_name(),
            "__wb_0198c1c2abcd700080000123456789ab"
        );

        let keys = vec![("ID".to_string(), DataType::Int64)];
        let hist: Vec<String> = w
            .history_columns(&keys)
            .iter()
            .map(|c| c.name().to_string())
            .collect();
        assert_eq!(
            hist,
            vec![
                "ID",
                "value",
                "submitter_id",
                "submitter_name",
                "submitted_at",
                "state"
            ]
        );
        let cur: Vec<String> = w
            .current_columns(&keys)
            .iter()
            .map(|c| c.name().to_string())
            .collect();
        assert_eq!(cur, vec!["ID", "value"]);

        let gen = w.generated_column();
        assert_eq!(gen.name(), "Forecast");
        assert_eq!(gen.table(), "dim_customer");
        assert_eq!(gen.generated_by(), Some(w.id()));
        assert!(gen.is_cross_table());
    }
}
