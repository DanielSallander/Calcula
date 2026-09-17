//! FILENAME: app/src-tauri/src/insights/series_strategy.rs
// PURPOSE: The strategy on the CHART path -- a design-query chart knows its
//          connection and which measure each series plots, so a fact about a
//          series can carry the measure's declared direction and be gated by
//          its declared materiality, exactly as the model route's facts are.
// CONTEXT: docs/design/insight-overlays.md gap 1: `insights_for_series` ran
//          the plain analyser, so a Cost chart's peak was "a peak", never "the
//          worst month", and a cue drawn from it could only ever be neutral.
//          IO-1 closes that. This is NOT a second planner: `resolve` is the
//          strategy layer's own resolver, `series_provenance` is `model.rs`'s
//          own attribute list, and `clears_materiality` is the same gate the
//          model route runs. The only new code is the lookup from a series
//          NAME to a measure and the policy closure `analyze_with_policy`
//          calls once per fact.
//
//          THE POLICY RUNS BEFORE RANKING. A fact withheld here never reaches
//          `markdown` or `facts_json`, and the budget fills with the next fact
//          instead of carrying a hole. A withheld fact is not "dropped" -- that
//          word means ranked below the cut -- so the count is reported in the
//          notes under its own name.
//
//          THREE THINGS THE POLICY DOES, and each is the model route's rule:
//          (1) `Change` on a bound series must clear the measure's materiality
//              or it is withheld -- a movement the business called noise
//              produces NO fact, not a quiet one.
//          (2) a kind the measure's strategy entry suppresses is withheld.
//          (3) every surviving single-subject fact about a bound series carries
//              the measure's direction provenance, INCLUDING the "withheld"
//              case, so a colour is only ever justified by a named source.
//          Facts about two subjects (a correlation, a crossing) belong to no
//          one measure and are left exactly as the analyser produced them.

use serde::{Deserialize, Serialize};

use insights::types::{AppliedAttr, FactKind, Insight};

use crate::bi::types::{BiState, ConnectionId};

use super::model::{clears_materiality, series_provenance};
use super::strategy::facts::facts_with_authored_kinds;
use super::strategy::{resolve, ResolvedMeasure, ScopePoint, SuppressibleFactKind};

// ---------------------------------------------------------------------------
// The request half (mirrors the seam's TypeScript, camelCase over the wire)
// ---------------------------------------------------------------------------

/// One plotted series and the measure it plots.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMeasureBinding {
    pub series: String,
    pub measure: String,
}

/// Which connection's strategy applies, and to which series.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStrategyContext {
    pub connection_id: ConnectionId,
    pub measures: Vec<SeriesMeasureBinding>,
}

// ---------------------------------------------------------------------------
// Resolution: series name -> the strategy's answer for its measure
// ---------------------------------------------------------------------------

/// A series and everything the strategy says about the measure behind it.
#[derive(Debug, Clone)]
pub struct SeriesBinding {
    pub series: String,
    pub resolved: ResolvedMeasure,
}

/// Resolve every binding against the connection's model and strategy document.
///
/// Read-only: it takes the connections lock, clones the base model out, and
/// never touches the engine -- no query is needed to know which way is good.
/// A connection with no model is an error the caller reports; a measure the
/// model does not declare still resolves (to an empty strategy), because a
/// chart may plot a workbook-local calculated measure the document never
/// mentions, and refusing the whole request for it would take the direction
/// away from every other series too.
pub fn bindings_for(
    bi_state: &BiState,
    context: &SeriesStrategyContext,
    notes: &mut Vec<String>,
) -> Result<Vec<SeriesBinding>, String> {
    let base = {
        let connections = bi_state
            .connections
            .lock()
            .map_err(|e| format!("connections lock poisoned: {e}"))?;
        let conn = connections
            .get(&context.connection_id)
            .ok_or("Connection not found")?;
        conn.base_model
            .clone()
            .ok_or("This connection has no model loaded")?
    };
    let doc = super::model_commands::strategy_doc(&base, notes);
    let (facts, _authored) = facts_with_authored_kinds(&base, &doc);
    let point = ScopePoint::default();
    Ok(context
        .measures
        .iter()
        .map(|b| SeriesBinding {
            series: b.series.clone(),
            resolved: resolve(&facts, &doc, &b.measure, &point),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/// The strategy's name for a core fact kind, for the kinds it can suppress.
fn suppressible(kind: &FactKind) -> Option<SuppressibleFactKind> {
    match kind {
        FactKind::Trend { .. } => Some(SuppressibleFactKind::Trend),
        FactKind::Change { .. } => Some(SuppressibleFactKind::Change),
        FactKind::ChangePoint { .. } => Some(SuppressibleFactKind::ChangePoint),
        FactKind::Seasonality { .. } => Some(SuppressibleFactKind::Seasonality),
        _ => None,
    }
}

/// The binding a single-subject fact is about, if any. A fact about two
/// subjects belongs to neither measure.
fn binding_of<'a>(kind: &FactKind, bindings: &'a [SeriesBinding]) -> Option<&'a SeriesBinding> {
    let (subjects, _) = kind.fingerprint();
    if subjects.len() != 1 {
        return None;
    }
    let name = subjects[0].label();
    bindings.iter().find(|b| b.series == name)
}

/// What the policy did to one fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Not about a bound series: untouched.
    Unbound,
    /// About a bound series and told, with provenance attached.
    Told,
    /// A `Change` that did not clear the measure's materiality.
    ImmaterialChange,
    /// A kind the measure's strategy entry suppresses.
    Suppressed,
}

impl Verdict {
    pub fn keeps(self) -> bool {
        matches!(self, Verdict::Unbound | Verdict::Told)
    }
}

/// Judge one fact. Pure; `insight.provenance` is filled when the fact is told.
pub fn judge(insight: &mut Insight, bindings: &[SeriesBinding]) -> Verdict {
    let Some(binding) = binding_of(&insight.kind, bindings) else {
        return Verdict::Unbound;
    };
    let resolved = &binding.resolved;

    if let FactKind::Change { first, last, .. } = &insight.kind {
        let materiality = resolved.materiality.as_ref().map(|m| &m.value);
        if !clears_materiality(materiality, *first, *last - *first) {
            return Verdict::ImmaterialChange;
        }
    }
    if suppressible(&insight.kind).is_some_and(|k| resolved.suppressed_kinds.contains(&k)) {
        return Verdict::Suppressed;
    }

    let provenance: Vec<AppliedAttr> = series_provenance(resolved);
    insight.provenance = provenance;
    Verdict::Told
}

/// How many facts each refusal withheld, for the notes.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Withheld {
    pub immaterial_changes: usize,
    pub suppressed: usize,
}

impl Withheld {
    pub fn record(&mut self, verdict: Verdict) {
        match verdict {
            Verdict::ImmaterialChange => self.immaterial_changes += 1,
            Verdict::Suppressed => self.suppressed += 1,
            Verdict::Unbound | Verdict::Told => {}
        }
    }

    /// The sentences a reader is owed about what was not said. Empty when
    /// nothing was withheld, so an ordinary chart gets no extra note.
    pub fn notes(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.immaterial_changes > 0 {
            out.push(format!(
                "{} change{} fell below the materiality the strategy declares for the measure and \
                 {} not reported.",
                self.immaterial_changes,
                if self.immaterial_changes == 1 { "" } else { "s" },
                if self.immaterial_changes == 1 { "was" } else { "were" },
            ));
        }
        if self.suppressed > 0 {
            out.push(format!(
                "{} fact{} of a kind the strategy suppresses for the measure {} not reported.",
                self.suppressed,
                if self.suppressed == 1 { "" } else { "s" },
                if self.suppressed == 1 { "was" } else { "were" },
            ));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::strategy::{Applied, AttrSource, Direction, Materiality, Suppression};
    use crate::insights::strategy::Attribute;
    use insights::types::{Direction as CoreDirection, Subject};

    fn binding(series: &str, resolved: ResolvedMeasure) -> SeriesBinding {
        SeriesBinding {
            series: series.to_string(),
            resolved,
        }
    }

    fn lower_is_better(measure: &str) -> ResolvedMeasure {
        ResolvedMeasure {
            measure: measure.to_string(),
            direction: Some(Applied::new(Direction::LowerIsBetter, AttrSource::Strategy)),
            ..ResolvedMeasure::default()
        }
    }

    fn extremes(series: &str) -> Insight {
        Insight::new(
            FactKind::Extremes {
                subject: Subject::column(series, "", insights::types::RangeRef::new("", 0, 1, 0, 1)),
                best_label: "Mar".into(),
                best_index: 2,
                best: 300.0,
                worst_label: "Jan".into(),
                worst_index: 0,
                worst: 100.0,
            },
            0.5,
        )
    }

    fn change(series: &str, first: f64, last: f64) -> Insight {
        Insight::new(
            FactKind::Change {
                subject: Subject::measure(series),
                first_label: "Jan".into(),
                last_label: "Dec".into(),
                first,
                last,
                pct: (last - first) / first,
            },
            0.5,
        )
    }

    #[test]
    fn a_fact_about_a_bound_series_carries_the_measures_direction() {
        let bindings = vec![binding("Cost", lower_is_better("Total Cost"))];
        let mut fact = extremes("Cost");
        assert_eq!(judge(&mut fact, &bindings), Verdict::Told);
        assert_eq!(fact.provenance.len(), 1);
        assert_eq!(fact.provenance[0].attr, "direction");
        assert_eq!(fact.provenance[0].value, "lowerIsBetter");
        assert_eq!(fact.provenance[0].source, insights::types::AttrSource::Strategy);
    }

    #[test]
    fn a_fact_about_an_unbound_series_is_untouched() {
        let bindings = vec![binding("Cost", lower_is_better("Total Cost"))];
        let mut fact = extremes("Sales");
        assert_eq!(judge(&mut fact, &bindings), Verdict::Unbound);
        assert!(fact.provenance.is_empty(), "no measure, no provenance");
    }

    #[test]
    fn a_withheld_direction_is_carried_as_withheld_never_as_a_guess() {
        let mut resolved = lower_is_better("Margin");
        resolved.suppressions.push(Suppression {
            attribute: Attribute::Direction,
            rule: "r-mixed".into(),
            reason: "covers only some members".into(),
        });
        let bindings = vec![binding("Margin", resolved)];
        let mut fact = extremes("Margin");
        assert_eq!(judge(&mut fact, &bindings), Verdict::Told);
        assert_eq!(fact.provenance[0].attr, "direction");
        assert!(fact.provenance[0].value.starts_with("withheld: "), "{}", fact.provenance[0].value);
        assert_eq!(fact.provenance[0].source, insights::types::AttrSource::Rule("r-mixed".into()));
    }

    #[test]
    fn a_change_below_the_declared_materiality_is_withheld_and_one_above_it_is_told() {
        let mut resolved = lower_is_better("Total Cost");
        resolved.materiality = Some(Applied::new(Materiality::Relative { value: 0.05 }, AttrSource::Strategy));
        let bindings = vec![binding("Cost", resolved)];

        let mut small = change("Cost", 100.0, 102.0);
        assert_eq!(judge(&mut small, &bindings), Verdict::ImmaterialChange);

        let mut large = change("Cost", 100.0, 120.0);
        assert_eq!(judge(&mut large, &bindings), Verdict::Told);
        let attrs: Vec<&str> = large.provenance.iter().map(|a| a.attr.as_str()).collect();
        assert_eq!(attrs, vec!["direction", "materiality"]);
        assert_eq!(large.provenance[1].value, "relative 0.05");

        // No materiality declared: any real movement is told (the model
        // route's rule, `clears_materiality`).
        let none = vec![binding("Cost", lower_is_better("Total Cost"))];
        let mut tiny = change("Cost", 100.0, 100.001);
        assert_eq!(judge(&mut tiny, &none), Verdict::Told);
    }

    #[test]
    fn a_suppressed_kind_is_withheld_and_other_kinds_on_the_same_series_are_not() {
        let mut resolved = lower_is_better("Total Cost");
        resolved.suppressed_kinds.insert(SuppressibleFactKind::Trend);
        let bindings = vec![binding("Cost", resolved)];

        let mut trend = Insight::new(
            FactKind::Trend {
                subject: Subject::measure("Cost"),
                slope_per_step: 2.0,
                r2: 0.9,
                pct_change: 0.4,
                first: 10.0,
                last: 40.0,
                n: 12,
                direction: CoreDirection::Rising,
            },
            0.7,
        );
        assert_eq!(judge(&mut trend, &bindings), Verdict::Suppressed);
        let mut ext = extremes("Cost");
        assert_eq!(judge(&mut ext, &bindings), Verdict::Told);
    }

    #[test]
    fn a_two_subject_fact_belongs_to_no_measure() {
        let bindings = vec![binding("Cost", lower_is_better("Total Cost"))];
        let mut crossing = Insight::new(
            FactKind::Crossover {
                a: Subject::measure("Cost"),
                b: Subject::measure("Sales"),
                at_label: "Mar".into(),
                at_index: 2,
            },
            0.5,
        );
        assert_eq!(judge(&mut crossing, &bindings), Verdict::Unbound);
        assert!(crossing.provenance.is_empty());
    }

    #[test]
    fn the_withheld_counts_become_notes_only_when_something_was_withheld() {
        let mut w = Withheld::default();
        assert!(w.notes().is_empty());
        w.record(Verdict::Told);
        w.record(Verdict::Unbound);
        assert!(w.notes().is_empty());
        w.record(Verdict::ImmaterialChange);
        w.record(Verdict::Suppressed);
        w.record(Verdict::Suppressed);
        let notes = w.notes();
        assert_eq!(notes.len(), 2);
        assert!(notes[0].starts_with("1 change fell below the materiality"), "{}", notes[0]);
        assert!(notes[1].starts_with("2 facts of a kind the strategy suppresses"), "{}", notes[1]);
    }

    #[test]
    fn the_context_deserializes_from_the_seams_camel_case() {
        // A connection id is a UUID (`ConnectionId = identity::EntityId`); a
        // free-text id is refused at the boundary, which is its own guard.
        let raw = r#"{"connectionId":"6f1c2a3e-9b8d-4c5e-8a7f-0123456789ab","measures":[{"series":"Cost","measure":"Total Cost"}]}"#;
        assert!(
            serde_json::from_str::<SeriesStrategyContext>(r#"{"connectionId":"conn-1","measures":[]}"#).is_err(),
            "a non-UUID connection id must be refused, not stored"
        );
        let ctx: SeriesStrategyContext = serde_json::from_str(raw).expect("camelCase on the wire");
        assert_eq!(ctx.measures.len(), 1);
        assert_eq!(ctx.measures[0].series, "Cost");
        assert_eq!(ctx.measures[0].measure, "Total Cost");
        // And back out with the same spelling -- the field-name pin.
        let json = serde_json::to_value(&ctx).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["connectionId", "measures"]);
    }
}
