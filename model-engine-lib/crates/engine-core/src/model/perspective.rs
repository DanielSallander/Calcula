//! Named perspectives: presentation-layer subsets of the model.
//!
//! A [`Perspective`] names the tables, columns, and measures a host should
//! SHOW when the perspective is selected — everything unlisted is hidden
//! from field lists. Purely presentational (Power BI / Analysis Services
//! semantics): a perspective is **not** a security boundary — objects outside
//! it remain fully queryable. Use [`SecurityRole`](super::SecurityRole)
//! object-level denials for access control.

use serde::{Deserialize, Serialize};

use crate::error::EngineResult;
use crate::model::schema::validate_identifier;

/// A named presentation subset of the model: the tables, columns, and
/// measures to show when the perspective is selected.
///
/// # Example
///
/// ```
/// use engine_core::model::Perspective;
///
/// let sales = Perspective::new("Sales view")
///     .with_tables(vec!["Sales".to_string()])
///     .with_columns(vec!["Geography[region]".to_string()])
///     .with_measures(vec!["Revenue".to_string()]);
/// assert_eq!(sales.name(), "Sales view");
/// assert_eq!(sales.tables(), ["Sales".to_string()]);
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Perspective {
    /// The perspective's unique name (shown in host perspective pickers).
    name: String,
    /// Tables shown in full (all their columns) in this perspective.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tables: Vec<String>,
    /// Individually shown columns, as qualified `Table[column]` refs —
    /// for tables not listed wholesale in [`tables`](Self::tables).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    columns: Vec<String>,
    /// Measures shown in this perspective.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    measures: Vec<String>,
    /// Human-readable description shown by host applications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

impl Perspective {
    /// Create a new, empty perspective (shows nothing until populated).
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            tables: Vec::new(),
            columns: Vec::new(),
            measures: Vec::new(),
            description: None,
        }
    }

    /// Replace the tables shown in full by this perspective.
    pub fn with_tables(mut self, tables: Vec<String>) -> Self {
        self.tables = tables;
        self
    }

    /// Replace the individually shown qualified `Table[column]` refs.
    pub fn with_columns(mut self, columns: Vec<String>) -> Self {
        self.columns = columns;
        self
    }

    /// Replace the measures shown by this perspective.
    pub fn with_measures(mut self, measures: Vec<String>) -> Self {
        self.measures = measures;
        self
    }

    /// Set the human-readable description.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The perspective's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Tables shown in full.
    pub fn tables(&self) -> &[String] {
        &self.tables
    }

    /// Individually shown qualified `Table[column]` refs.
    pub fn columns(&self) -> &[String] {
        &self.columns
    }

    /// Measures shown.
    pub fn measures(&self) -> &[String] {
        &self.measures
    }

    /// The description, if any.
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    /// Validate the perspective's own shape (name legality). Resolution of
    /// the referenced objects against the model happens in
    /// [`DataModelBuilder::build`](crate::model::DataModelBuilder).
    pub fn validate(&self) -> EngineResult<()> {
        validate_identifier(&self.name, "perspective")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_style_construction() {
        let p = Perspective::new("Exec")
            .with_tables(vec!["Sales".into()])
            .with_columns(vec!["Geography[region]".into()])
            .with_measures(vec!["Revenue".into()])
            .with_description("Executive view");
        assert_eq!(p.name(), "Exec");
        assert_eq!(p.tables().len(), 1);
        assert_eq!(p.columns().len(), 1);
        assert_eq!(p.measures().len(), 1);
        assert_eq!(p.description(), Some("Executive view"));
    }

    #[test]
    fn serde_round_trip() {
        let p = Perspective::new("Exec").with_measures(vec!["Revenue".into()]);
        let json = serde_json::to_string(&p).unwrap();
        let back: Perspective = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn validate_rejects_bad_name() {
        assert!(Perspective::new("bad\"name").validate().is_err());
    }
}
