//! KPI (Key Performance Indicator) definitions — author-defined status markup
//! over a base measure.
//!
//! A [`Kpi`] binds a base measure to a [`KpiTarget`] (a constant goal or another
//! measure) and a set of [`StatusBand`]s over the base÷target ratio. It is
//! **presentation metadata**: the engine carries and validates it, and surfaces
//! it in a query's result-column metadata (see `ResultColumn::kpi_name`) for the
//! base measure. The host renders the status indicator (icon / colour) from the
//! base value, the target, and the bands; the engine does not itself compute the
//! status (v1).

use serde::{Deserialize, Serialize};

/// A KPI's target: a fixed goal value or another measure supplying the goal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum KpiTarget {
    /// A fixed numeric goal.
    Constant(f64),
    /// Another measure (by name) supplying the goal per result row.
    Measure(String),
}

/// A status level for a KPI band.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KpiStatus {
    /// Below target — bad.
    OffTrack,
    /// Approaching target — warning.
    AtRisk,
    /// At or above target — good.
    OnTrack,
}

/// One band of a KPI's status scale: a base÷target ratio at or above
/// `threshold` (and below the next band's `threshold`) maps to `status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusBand {
    /// Lower bound of this band on the base÷target ratio (e.g. `0.9`).
    pub threshold: f64,
    /// The status when the ratio falls in this band.
    pub status: KpiStatus,
}

impl StatusBand {
    /// A band mapping ratios `>= threshold` (up to the next band) to `status`.
    pub fn new(threshold: f64, status: KpiStatus) -> Self {
        Self { threshold, status }
    }
}

/// A KPI: author-defined status markup over a base measure. See the
/// [module docs](self).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Kpi {
    name: String,
    base_measure: String,
    target: KpiTarget,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    status_bands: Vec<StatusBand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

impl Kpi {
    /// A KPI named `name` over `base_measure`, compared against `target`.
    pub fn new(
        name: impl Into<String>,
        base_measure: impl Into<String>,
        target: KpiTarget,
    ) -> Self {
        Self {
            name: name.into(),
            base_measure: base_measure.into(),
            target,
            status_bands: Vec::new(),
            description: None,
        }
    }

    /// Add a status band. Bands should be added in **ascending** `threshold`
    /// order; build-time validation enforces this.
    pub fn with_status_band(mut self, band: StatusBand) -> Self {
        self.status_bands.push(band);
        self
    }

    /// Set the KPI's description.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The KPI's unique name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The base measure this KPI is computed over.
    pub fn base_measure(&self) -> &str {
        &self.base_measure
    }

    /// The KPI's target (a constant goal or another measure).
    pub fn target(&self) -> &KpiTarget {
        &self.target
    }

    /// The KPI's status bands (ascending by `threshold`).
    pub fn status_bands(&self) -> &[StatusBand] {
        &self.status_bands
    }

    /// The KPI's optional description.
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::measure::sum_measure;
    use crate::error::EngineError;
    use crate::model::{Column, DataModel, Table};
    use crate::types::DataType;

    /// A model with `Sales(amount)` and a `Revenue` measure, plus the given KPIs.
    fn model_with_kpis(kpis: Vec<Kpi>) -> crate::error::EngineResult<DataModel> {
        let mut b = DataModel::builder()
            .add_table(
                Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap(),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .add_measure(sum_measure("Cost", "Sales", "amount"));
        for k in kpis {
            b = b.add_kpi(k);
        }
        b.build()
    }

    #[test]
    fn valid_kpi_is_accepted_and_accessible() {
        let kpi = Kpi::new("Revenue KPI", "Revenue", KpiTarget::Constant(1000.0))
            .with_status_band(StatusBand::new(0.0, KpiStatus::OffTrack))
            .with_status_band(StatusBand::new(0.9, KpiStatus::AtRisk))
            .with_status_band(StatusBand::new(1.0, KpiStatus::OnTrack))
            .with_description("Revenue against the annual goal");
        let model = model_with_kpis(vec![kpi]).unwrap();
        assert_eq!(model.kpis().len(), 1);
        let k = model.kpi("Revenue KPI").unwrap();
        assert_eq!(k.base_measure(), "Revenue");
        assert_eq!(k.status_bands().len(), 3);
        assert!(model.kpi("missing").is_none());
    }

    #[test]
    fn measure_target_is_accepted() {
        let kpi = Kpi::new("Margin", "Revenue", KpiTarget::Measure("Cost".into()));
        assert!(model_with_kpis(vec![kpi]).is_ok());
    }

    #[test]
    fn duplicate_kpi_name_fails() {
        let a = Kpi::new("K", "Revenue", KpiTarget::Constant(1.0));
        let b = Kpi::new("K", "Cost", KpiTarget::Constant(1.0));
        let err = model_with_kpis(vec![a, b]).unwrap_err();
        assert!(matches!(err, EngineError::DuplicateName(_)), "got: {err:?}");
    }

    #[test]
    fn unknown_base_measure_fails() {
        let kpi = Kpi::new("K", "Nope", KpiTarget::Constant(1.0));
        let err = model_with_kpis(vec![kpi]).unwrap_err();
        assert!(matches!(err, EngineError::MeasureNotFound(_)), "got: {err:?}");
    }

    #[test]
    fn unknown_target_measure_fails() {
        let kpi = Kpi::new("K", "Revenue", KpiTarget::Measure("Nope".into()));
        let err = model_with_kpis(vec![kpi]).unwrap_err();
        assert!(matches!(err, EngineError::MeasureNotFound(_)), "got: {err:?}");
    }

    #[test]
    fn non_ascending_bands_fail() {
        let kpi = Kpi::new("K", "Revenue", KpiTarget::Constant(1.0))
            .with_status_band(StatusBand::new(1.0, KpiStatus::OnTrack))
            .with_status_band(StatusBand::new(0.5, KpiStatus::AtRisk));
        let err = model_with_kpis(vec![kpi]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidMetadata { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn serde_round_trips_and_legacy_loads_without_kpis() {
        // Round-trip a model carrying a KPI.
        let model = model_with_kpis(vec![Kpi::new(
            "K",
            "Revenue",
            KpiTarget::Constant(100.0),
        )
        .with_status_band(StatusBand::new(0.9, KpiStatus::OnTrack))])
        .unwrap();
        let json = serde_json::to_string(&model).unwrap();
        let back: DataModel = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kpis().len(), 1);
        assert_eq!(back.kpi("K").unwrap().target(), &KpiTarget::Constant(100.0));

        // A pre-v10 model file with no `kpis` field loads with an empty list.
        let legacy = serde_json::json!({
            "tables": [], "relationships": [], "measures": [],
            "calculated_columns": [], "measure_groups": []
        });
        let loaded: DataModel = serde_json::from_value(legacy).unwrap();
        assert!(loaded.kpis().is_empty());
    }
}
