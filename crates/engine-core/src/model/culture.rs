//! Cultures: per-locale metadata translations for model objects.
//!
//! A [`Culture`] carries display-name and description overrides for tables,
//! columns, and measures under one locale (BCP-47 id, e.g. `sv-SE`). Hosts
//! pick a locale and swap the DISPLAY text in field lists and editors; the
//! underlying object names stay stable — queries, expressions, and
//! relationships always use the real names. Purely presentational (Power BI
//! "cultures" / metadata translations).

use serde::{Deserialize, Serialize};

use crate::error::EngineResult;
use crate::model::schema::validate_identifier;

/// One object's translated metadata within a [`Culture`].
///
/// `object` names the target: a table name for table translations, a
/// qualified `Table[column]` ref for column translations, or a measure name
/// for measure translations (the list it sits in decides the kind).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameTranslation {
    /// The translated object: table name, `Table[column]` ref, or measure
    /// name depending on the owning list.
    pub object: String,
    /// Translated display name (`None` = keep the untranslated display).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Translated description (`None` = keep the untranslated description).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A named culture: per-locale display-name/description overrides for the
/// model's tables, columns, and measures.
///
/// # Example
///
/// ```
/// use engine_core::model::{Culture, NameTranslation};
///
/// let sv = Culture::new("sv-SE")
///     .with_table_translations(vec![NameTranslation {
///         object: "Sales".to_string(),
///         display_name: Some("Försäljning".to_string()),
///         description: None,
///     }]);
/// assert_eq!(sv.locale(), "sv-SE");
/// assert_eq!(sv.table_display("Sales"), Some("Försäljning"));
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Culture {
    /// The culture's locale id (BCP-47, e.g. `sv-SE`) — the key a host
    /// selects.
    locale: String,
    /// Table translations (`object` = table name).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tables: Vec<NameTranslation>,
    /// Column translations (`object` = qualified `Table[column]`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    columns: Vec<NameTranslation>,
    /// Measure translations (`object` = measure name).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    measures: Vec<NameTranslation>,
}

impl Culture {
    /// Create an empty culture for a locale.
    pub fn new(locale: impl Into<String>) -> Self {
        Self {
            locale: locale.into(),
            tables: Vec::new(),
            columns: Vec::new(),
            measures: Vec::new(),
        }
    }

    /// Replace the table translations (`object` = table name).
    pub fn with_table_translations(mut self, translations: Vec<NameTranslation>) -> Self {
        self.tables = translations;
        self
    }

    /// Replace the column translations (`object` = qualified `Table[column]`).
    pub fn with_column_translations(mut self, translations: Vec<NameTranslation>) -> Self {
        self.columns = translations;
        self
    }

    /// Replace the measure translations (`object` = measure name).
    pub fn with_measure_translations(mut self, translations: Vec<NameTranslation>) -> Self {
        self.measures = translations;
        self
    }

    /// The culture's locale id.
    pub fn locale(&self) -> &str {
        &self.locale
    }

    /// Table translations.
    pub fn tables(&self) -> &[NameTranslation] {
        &self.tables
    }

    /// Column translations.
    pub fn columns(&self) -> &[NameTranslation] {
        &self.columns
    }

    /// Measure translations.
    pub fn measures(&self) -> &[NameTranslation] {
        &self.measures
    }

    /// The translated display name for a table (case-insensitive lookup).
    pub fn table_display(&self, table: &str) -> Option<&str> {
        self.tables
            .iter()
            .find(|t| t.object.eq_ignore_ascii_case(table))
            .and_then(|t| t.display_name.as_deref())
    }

    /// The translated display name for a column, looked up by table + column
    /// (matches the stored `Table[column]` refs case-insensitively).
    pub fn column_display(&self, table: &str, column: &str) -> Option<&str> {
        let wanted = format!("{table}[{column}]");
        self.columns
            .iter()
            .find(|c| c.object.eq_ignore_ascii_case(&wanted))
            .and_then(|c| c.display_name.as_deref())
    }

    /// The translated display name for a measure (case-insensitive lookup).
    pub fn measure_display(&self, measure: &str) -> Option<&str> {
        self.measures
            .iter()
            .find(|m| m.object.eq_ignore_ascii_case(measure))
            .and_then(|m| m.display_name.as_deref())
    }

    /// Validate the culture's own shape (a legal, non-empty locale id).
    /// Resolution of translated objects against the model happens in
    /// [`DataModelBuilder::build`](crate::model::DataModelBuilder).
    pub fn validate(&self) -> EngineResult<()> {
        validate_identifier(&self.locale, "culture locale")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(object: &str, display: &str) -> NameTranslation {
        NameTranslation {
            object: object.to_string(),
            display_name: Some(display.to_string()),
            description: None,
        }
    }

    #[test]
    fn lookups_are_case_insensitive() {
        let c = Culture::new("sv-SE")
            .with_table_translations(vec![tr("Sales", "Försäljning")])
            .with_column_translations(vec![tr("Sales[amount]", "Belopp")])
            .with_measure_translations(vec![tr("Revenue", "Intäkter")]);
        assert_eq!(c.table_display("sales"), Some("Försäljning"));
        assert_eq!(c.column_display("SALES", "AMOUNT"), Some("Belopp"));
        assert_eq!(c.measure_display("revenue"), Some("Intäkter"));
        assert_eq!(c.table_display("Other"), None);
    }

    #[test]
    fn serde_round_trip() {
        let c = Culture::new("de-DE").with_measure_translations(vec![tr("Revenue", "Umsatz")]);
        let json = serde_json::to_string(&c).unwrap();
        let back: Culture = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn validate_rejects_bad_locale() {
        assert!(Culture::new("bad\"locale").validate().is_err());
        assert!(Culture::new("sv-SE").validate().is_ok());
    }
}
