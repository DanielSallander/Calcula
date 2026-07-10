//! Calculation groups — reusable measure templates (calculation items).
//!
//! A [`CalculationGroup`] is a set of named [`CalculationItem`]s, each a
//! measure *template* that transforms whichever measure it is applied to. The
//! template references the applied measure through the
//! [`SELECTEDMEASURE()`](crate::compute::expression::Expression::SelectedMeasure)
//! placeholder.
//!
//! The classic use is time intelligence: one group `"Time"` with items
//! `Current = SELECTEDMEASURE()`, `YTD = YTD(SELECTEDMEASURE())`,
//! `PY = PRIORYEAR(SELECTEDMEASURE())`. Applying it to `[Revenue, Cost]` with
//! items `[Current, YTD, PY]` produces `Revenue`/`Cost` each as
//! `Current`/`YTD`/`PY` — `M + N` definitions instead of `M * N` measures.
//!
//! Application is a **pure** rewrite: for each requested measure `M` and each
//! selected item `I`, a synthetic measure is produced whose expression is
//! `I.expression.substitute_selected_measure(&M.expression)` (see
//! [`expand_calculation_group`]). The synthetic measures are ordinary measures
//! and feed the normal multi-measure result machinery.

use serde::{Deserialize, Serialize};

use crate::compute::expression::{child_expressions, Expression};
use crate::compute::measure::Measure;
use crate::compute::parser::parse_measure_expression;
use crate::error::{EngineError, EngineResult};
use crate::model::schema::DataModel;

/// A single calculation item: a named measure template.
///
/// The item's expression is a transform of
/// [`SELECTEDMEASURE()`](crate::compute::expression::Expression::SelectedMeasure)
/// — for example `YTD(SELECTEDMEASURE())` or
/// `DIVIDE(SELECTEDMEASURE() - PRIORYEAR(SELECTEDMEASURE()), PRIORYEAR(SELECTEDMEASURE()))`.
/// When the group is applied, every `SELECTEDMEASURE()` node is replaced with
/// the target measure's expression tree.
///
/// Like [`Measure`], an item carries its original source text when built from
/// text: the source is the authoritative, human-readable definition, and the
/// stored expression AST is a cache of the last successful parse so the item
/// round-trips and can be re-parsed by the current grammar.
#[derive(Debug, Clone, Serialize)]
pub struct CalculationItem {
    name: String,
    expression: Expression,
    /// Original expression source text, when the item was created from text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

impl<'de> Deserialize<'de> for CalculationItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Fields {
            name: String,
            expression: Expression,
            #[serde(default)]
            source: Option<String>,
        }
        let f = Fields::deserialize(deserializer)?;
        Ok(CalculationItem {
            name: f.name,
            expression: f.expression,
            source: f.source,
        })
    }
}

impl CalculationItem {
    /// Create a calculation item from an already-built expression.
    ///
    /// The expression should be a transform of `SELECTEDMEASURE()`; build-time
    /// validation ([`Expression::validate_calc_item`](crate::compute::expression::Expression::validate_calc_item))
    /// permits the placeholder but otherwise enforces the same rules as a
    /// regular measure expression. Items built this way carry no source text.
    pub fn new(name: impl Into<String>, expression: Expression) -> Self {
        Self {
            name: name.into(),
            expression,
            source: None,
        }
    }

    /// Create a calculation item by parsing its source text.
    ///
    /// The text is parsed via
    /// [`parse_measure_expression`](crate::compute::parser::parse_measure_expression)
    /// and may use `SELECTEDMEASURE()`. The original text is retained as the
    /// item's authoritative source (so it round-trips and can be re-parsed).
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::ParseError`] when the text does not parse.
    pub fn from_text(name: impl Into<String>, text: impl Into<String>) -> EngineResult<Self> {
        let text = text.into();
        let expression = parse_measure_expression(&text)?;
        Ok(Self {
            name: name.into(),
            expression,
            source: Some(text),
        })
    }

    /// Attach (or replace) the original expression source text.
    pub fn with_source(mut self, text: impl Into<String>) -> Self {
        self.source = Some(text.into());
        self
    }

    /// Returns the item name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the item's expression template.
    pub fn expression(&self) -> &Expression {
        &self.expression
    }

    /// Returns the original expression source text, if the item was created
    /// from text.
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }
}

/// A named group of [`CalculationItem`]s.
///
/// See the [module documentation](self) for the semantics. A group must have
/// at least one item, and item names must be unique within the group
/// (enforced by [`DataModelBuilder::build`](crate::model::DataModelBuilder)).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalculationGroup {
    name: String,
    items: Vec<CalculationItem>,
}

impl CalculationGroup {
    /// Create a calculation group from a name and its items.
    pub fn new(name: impl Into<String>, items: Vec<CalculationItem>) -> Self {
        Self {
            name: name.into(),
            items,
        }
    }

    /// Append an item to the group (builder-style).
    #[must_use]
    pub fn with_item(mut self, item: CalculationItem) -> Self {
        self.items.push(item);
        self
    }

    /// Returns the group name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the group's items, in declaration order.
    pub fn items(&self) -> &[CalculationItem] {
        &self.items
    }

    /// Look up an item by name (exact match).
    pub fn item(&self, name: &str) -> Option<&CalculationItem> {
        self.items.iter().find(|i| i.name() == name)
    }
}

/// Collect the names of every `MeasureRef` node in `expr` (deduplicated).
///
/// Used by model-build validation of calculation items: any concrete measure
/// a calc item references (distinct from the `SELECTEDMEASURE()` placeholder)
/// must resolve to a model measure.
pub(crate) fn measure_ref_names(expr: &Expression) -> Vec<String> {
    let mut names = Vec::new();
    collect_measure_ref_names(expr, &mut names);
    names.sort_unstable();
    names.dedup();
    names
}

fn collect_measure_ref_names(expr: &Expression, names: &mut Vec<String>) {
    // Reuse the qualified-column walker shape: recurse via the public
    // column_references-free path. We only need MeasureRef leaves, so walk a
    // cloned tree is overkill — instead recurse explicitly over the few node
    // kinds calc items realistically use, falling back to the generic
    // sub-expression-free leaves. To stay robust against future variants we
    // recurse through `substitute_selected_measure`'s structure indirectly:
    // serialize-free traversal isn't available, so match the common cases.
    match expr {
        Expression::MeasureRef(name) => names.push(name.clone()),
        _ => {
            for child in child_expressions(expr) {
                collect_measure_ref_names(child, names);
            }
        }
    }
}

/// Collect every qualified column reference `(table, column)` in `expr`.
///
/// Bare [`Expression::ColumnRef`]s carry no table and are intentionally
/// skipped here (they are resolved against the applied measure's fact table at
/// substitution/query time); only [`Expression::QualifiedColumnRef`]s, which
/// name a concrete table, are returned.
pub(crate) fn qualified_column_refs(expr: &Expression) -> Vec<(String, String)> {
    let mut refs = Vec::new();
    collect_qualified_column_refs(expr, &mut refs);
    refs
}

fn collect_qualified_column_refs(expr: &Expression, refs: &mut Vec<(String, String)>) {
    match expr {
        Expression::QualifiedColumnRef {
            table_or_var,
            column,
        } => refs.push((table_or_var.clone(), column.clone())),
        _ => {
            for child in child_expressions(expr) {
                collect_qualified_column_refs(child, refs);
            }
        }
    }
}

/// Format the synthetic result-column / measure name for measure `measure`
/// transformed by item `item`: `"{measure} [{item}]"`.
///
/// This is the documented naming contract for calculation-group results — see
/// [`expand_calculation_group`] (and `CalculationGroupApplication` in the
/// engine-query crate, which carries the same ordering/naming contract).
pub fn synthetic_measure_name(measure: &str, item: &str) -> String {
    format!("{measure} [{item}]")
}

/// Expand a calculation-group application into synthetic measures.
///
/// Given the `model`, the request's `measures` (the measure names to
/// transform, in order), the `group` name, and the selected `items` (in
/// order; an **empty** slice means *all* items in the group), this produces an
/// ordered list of synthetic [`Measure`]s — one per `(measure, item)` pair,
/// **measures-outer / items-inner** — plus the matching ordered list of
/// synthetic names.
///
/// For requested measure `M` (in `measures` order) and selected item `I` (in
/// item order), the synthetic measure's expression is
/// `I.expression.substitute_selected_measure(&M.expression)` and its name is
/// [`synthetic_measure_name`]`(M, I)` = `"M [I]"`.
///
/// # Errors
///
/// - [`EngineError::CalculationGroupNotFound`] when `group` is not in the model.
/// - [`EngineError::InvalidData`] when a selected item is not in the group,
///   when a requested measure does not exist, or when a synthetic name would
///   collide with a measure already in the model.
pub fn expand_calculation_group(
    model: &DataModel,
    measures: &[String],
    group: &str,
    items: &[String],
) -> EngineResult<(Vec<Measure>, Vec<String>)> {
    let group = model.calculation_group(group)?;

    // Resolve the selected items in the requested order. An empty selection
    // means all items, in declaration order.
    let selected: Vec<&CalculationItem> = if items.is_empty() {
        group.items().iter().collect()
    } else {
        let mut resolved = Vec::with_capacity(items.len());
        for item_name in items {
            let item = group.item(item_name).ok_or_else(|| {
                EngineError::InvalidData(format!(
                    "calculation item '{item_name}' not found in group '{}'",
                    group.name()
                ))
            })?;
            resolved.push(item);
        }
        resolved
    };

    let mut synthetic = Vec::with_capacity(measures.len() * selected.len());
    let mut names = Vec::with_capacity(measures.len() * selected.len());

    // Measures-outer, items-inner.
    for measure_name in measures {
        let measure = model.measure(measure_name)?;
        for item in &selected {
            let expression = item
                .expression()
                .substitute_selected_measure(measure.expression());
            let name = synthetic_measure_name(measure_name, item.name());
            // A synthetic name must not collide with an existing model
            // measure — that would shadow it ambiguously in the overlay.
            if model.measure(&name).is_ok() {
                return Err(EngineError::InvalidData(format!(
                    "calculation-group synthetic measure name '{name}' collides with \
                     an existing model measure"
                )));
            }
            synthetic.push(Measure::new(name.clone(), expression));
            names.push(name);
        }
    }

    Ok((synthetic, names))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::expression::{self as expr};
    use crate::model::column::Column;
    use crate::model::table::Table;
    use crate::types::DataType;

    fn sales_model() -> DataModel {
        let table = Table::new(
            "Sales",
            vec![
                Column::new("amount", DataType::Float64),
                Column::new("cost", DataType::Float64),
            ],
        )
        .unwrap();
        DataModel::builder()
            .add_table(table)
            .add_measure(Measure::new(
                "Revenue",
                expr::agg(AggregateOp::Sum, expr::qualified_col("Sales", "amount")),
            ))
            .add_measure(Measure::new(
                "Cost",
                expr::agg(AggregateOp::Sum, expr::qualified_col("Sales", "cost")),
            ))
            .add_calculation_group(CalculationGroup::new(
                "Time",
                vec![
                    CalculationItem::from_text("Current", "SELECTEDMEASURE()").unwrap(),
                    CalculationItem::from_text("Doubled", "SELECTEDMEASURE() * 2").unwrap(),
                ],
            ))
            .build()
            .unwrap()
    }

    #[test]
    fn calc_item_from_text_round_trips_and_reparses() {
        let item = CalculationItem::from_text("YoY", "SELECTEDMEASURE() * 2").unwrap();
        assert_eq!(item.name(), "YoY");
        assert_eq!(item.source(), Some("SELECTEDMEASURE() * 2"));

        let json = serde_json::to_string(&item).unwrap();
        let restored: CalculationItem = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.name(), "YoY");
        assert_eq!(restored.source(), Some("SELECTEDMEASURE() * 2"));
        // The expression survives the round-trip.
        assert!(matches!(restored.expression(), Expression::BinaryOp { .. }));
    }

    #[test]
    fn calc_group_serde_round_trip() {
        let group = CalculationGroup::new(
            "Time",
            vec![CalculationItem::from_text("Current", "SELECTEDMEASURE()").unwrap()],
        );
        let json = serde_json::to_string(&group).unwrap();
        let restored: CalculationGroup = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.name(), "Time");
        assert_eq!(restored.items().len(), 1);
        assert_eq!(restored.item("Current").unwrap().name(), "Current");
    }

    #[test]
    fn expand_produces_measures_outer_items_inner() {
        let model = sales_model();
        let (synthetic, names) = expand_calculation_group(
            &model,
            &["Revenue".to_string(), "Cost".to_string()],
            "Time",
            &["Current".to_string(), "Doubled".to_string()],
        )
        .unwrap();

        // 2 measures x 2 items = 4 synthetic measures, measures-outer.
        assert_eq!(
            names,
            vec![
                "Revenue [Current]",
                "Revenue [Doubled]",
                "Cost [Current]",
                "Cost [Doubled]",
            ]
        );
        assert_eq!(synthetic.len(), 4);

        // Revenue [Current] = SUM(Sales[amount]); Revenue [Doubled] = (... * 2).
        assert_eq!(
            synthetic[0].expression().to_sql_string().unwrap(),
            "SUM(\"amount\")"
        );
        assert_eq!(
            synthetic[1].expression().to_sql_string().unwrap(),
            "(SUM(\"amount\") * 2)"
        );
        assert_eq!(
            synthetic[2].expression().to_sql_string().unwrap(),
            "SUM(\"cost\")"
        );
        assert_eq!(
            synthetic[3].expression().to_sql_string().unwrap(),
            "(SUM(\"cost\") * 2)"
        );
    }

    #[test]
    fn expand_empty_items_means_all() {
        let model = sales_model();
        let (_, names) =
            expand_calculation_group(&model, &["Revenue".to_string()], "Time", &[]).unwrap();
        assert_eq!(names, vec!["Revenue [Current]", "Revenue [Doubled]"]);
    }

    #[test]
    fn expand_unknown_group_errors() {
        let model = sales_model();
        let err =
            expand_calculation_group(&model, &["Revenue".to_string()], "Nope", &[]).unwrap_err();
        assert!(matches!(err, EngineError::CalculationGroupNotFound(_)));
    }

    #[test]
    fn expand_unknown_item_errors() {
        let model = sales_model();
        let err = expand_calculation_group(
            &model,
            &["Revenue".to_string()],
            "Time",
            &["Nope".to_string()],
        )
        .unwrap_err();
        assert!(matches!(err, EngineError::InvalidData(_)));
    }

    #[test]
    fn expand_unknown_measure_errors() {
        let model = sales_model();
        let err = expand_calculation_group(&model, &["Nope".to_string()], "Time", &[]).unwrap_err();
        assert!(matches!(err, EngineError::MeasureNotFound(_)));
    }
}
