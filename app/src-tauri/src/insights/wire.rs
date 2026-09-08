//! FILENAME: app/src-tauri/src/insights/wire.rs
// PURPOSE: The shape the Insights seam actually speaks, and the one mapper from
//          the `insights` crate's bundle into it.
// CONTEXT: `app/src/api/insightsService.ts` is the contract. Its `InsightBundle`
//          is NOT the core crate's `InsightBundle`, and the difference is
//          deliberate rather than accidental drift:
//
//            - the seam's `source` is "range" | "model", which the core crate
//              cannot know: it is told a `Dataset` and has no idea whether the
//              caller reached it through cells or through measures;
//            - the seam's `kind` is a STRING, because the frontend groups and
//              icons by kind and must not be recompiled when a fact variant is
//              added;
//            - the seam's `evidence` is a click target -- a sheet INDEX plus a
//              rectangle, or a query -- while the core crate carries a sheet
//              NAME, which is what an A1 string needs and what a selection call
//              cannot use;
//            - `evidenceA1`, `localeId` and `engineVersion` are not on the seam
//              at all, because nothing on the pane reads them.
//
//          So there is a mapper, and it lives here, once. Two hand-written
//          conversions at two call sites is how the model path and the range
//          path start disagreeing about what a fact looks like.
//
//          EVIDENCE COMES FROM THE FACT'S OWN SUBJECTS. A `Subject::Column`
//          knows where it lives and becomes a range; a `Subject::Measure` has
//          only a name and becomes a query. A fact with no subjects at all
//          (shape, duplicate rows, blank rows, a category breakdown) gets an
//          EMPTY evidence list. That is the whole point: an invented rectangle
//          would select the wrong cells the first time somebody clicked it, and
//          a wrong click target is worse than no click target.

use serde::{Deserialize, Serialize};

use insights::types::{AppliedAttr, AttrSource, InsightBundle, Subject};

/// Which half of the feature produced a bundle.
///
/// The caller decides this, not the analysis: the same `Dataset` can be built
/// from cells or from a model query, and only the code that built it knows
/// which.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BundleSource {
    Range,
    Model,
}

/// Whether a piece of evidence is a rectangle of cells or a model query.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceKind {
    Range,
    Query,
}

/// Where a fact's evidence lives, so clicking it can select something.
///
/// Every positional field is optional and SKIPPED when absent rather than sent
/// as `null`: the TypeScript declares `sheetIndex?: number`, and a `null` there
/// would satisfy no reader that tests `evidence.sheetIndex !== undefined`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEvidence {
    pub kind: EvidenceKind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_row: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_col: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_row: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_col: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measures: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_by: Option<Vec<String>>,
}

/// One attribute that influenced a fact, and where it came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireProvenance {
    pub attribute: String,
    pub value: String,
    /// "base" | "inferred" | "kpi:<name>" | "strategy" | "rule:<id>".
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireInsight {
    pub id: String,
    pub kind: String,
    pub score: f64,
    pub text: String,
    pub evidence: Vec<WireEvidence>,
    /// Empty on the range path, populated on the model path. That difference is
    /// what lets the pane answer "why does it think a rise here is bad?" with a
    /// named source instead of a shrug -- and an empty list on a raw-grid fact
    /// is the honest answer, not a missing feature.
    pub provenance: Vec<WireProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireBundle {
    pub source: BundleSource,
    pub insights: Vec<WireInsight>,
    pub dropped: usize,
    pub markdown: String,
    pub facts_json: String,
    pub notes: Vec<String>,
}

/// Render an `AttrSource` the way the seam's comment says it is spelled.
///
/// The two parameterised variants carry their name INSIDE the string rather
/// than in a sibling field, because the seam declares one `source: string` and
/// the pane prints it verbatim.
pub fn attr_source_id(source: &AttrSource) -> String {
    match source {
        AttrSource::Base => "base".to_string(),
        AttrSource::Inferred => "inferred".to_string(),
        AttrSource::Kpi(name) => format!("kpi:{}", name),
        AttrSource::Strategy => "strategy".to_string(),
        AttrSource::Rule(id) => format!("rule:{}", id),
    }
}

fn provenance(attrs: &[AppliedAttr]) -> Vec<WireProvenance> {
    attrs
        .iter()
        .map(|a| WireProvenance {
            attribute: a.attr.clone(),
            value: a.value.clone(),
            source: attr_source_id(&a.source),
        })
        .collect()
}

/// One subject becomes one piece of evidence.
///
/// A measure becomes a QUERY carrying its own name in `measures`, which is
/// enough for the pane to open it as a real pivot. `groupBy` stays absent:
/// this crate's facts are about a measure over its own series, and inventing a
/// grouping the fact was never computed with would open a pivot showing
/// different numbers from the sentence beside it.
///
/// A column whose sheet name is EMPTY came from no grid -- a chart's plotted
/// series, a table lifted out of a query -- so it is DESCRIBED rather than
/// located. Emitting its placeholder rectangle would hand the pane a click
/// target that selects A1 of whatever sheet happens to be in front.
fn evidence_for(subject: &Subject, sheet_names: &[String]) -> WireEvidence {
    let described = |label: String, measures: Option<Vec<String>>| WireEvidence {
        kind: EvidenceKind::Query,
        label,
        sheet_index: None,
        start_row: None,
        start_col: None,
        end_row: None,
        end_col: None,
        measures,
        group_by: None,
    };

    match subject {
        Subject::Measure { name } => described(name.clone(), Some(vec![name.clone()])),
        Subject::Column { name, sheet, .. } if sheet.is_empty() => described(name.clone(), None),
        Subject::Column { sheet, range, .. } => WireEvidence {
            kind: EvidenceKind::Range,
            label: range.to_a1(),
            // A name that resolves to no open sheet yields no index rather than
            // index 0: selecting the wrong sheet is a worse answer than
            // selecting nothing.
            sheet_index: sheet_names.iter().position(|n| n == sheet),
            start_row: Some(range.start_row),
            start_col: Some(range.start_col),
            end_row: Some(range.end_row),
            end_col: Some(range.end_col),
            measures: None,
            group_by: None,
        },
    }
}

/// Map a core bundle onto the seam, with no sheet names to resolve against.
///
/// The right call for a bundle that came from no sheet at all -- a chart's
/// plotted series, a model query -- where every subject is described rather
/// than located. Anything analysed against an open workbook must call
/// `from_core_with_sheets` instead, or a click on the evidence can select
/// nothing.
pub fn from_core(bundle: InsightBundle, source: BundleSource) -> WireBundle {
    from_core_with_sheets(bundle, source, &[])
}

/// Map a core bundle onto the seam, resolving each range's sheet NAME to the
/// workbook's sheet INDEX.
pub fn from_core_with_sheets(
    bundle: InsightBundle,
    source: BundleSource,
    sheet_names: &[String],
) -> WireBundle {
    let insights = bundle
        .insights
        .into_iter()
        .map(|insight| {
            let kind_key = insight.kind.kind_key().to_string();
            let (subjects, _) = insight.kind.fingerprint();
            let evidence: Vec<WireEvidence> = subjects
                .into_iter()
                .map(|s| evidence_for(s, sheet_names))
                .collect();
            let prov = provenance(&insight.provenance);
            WireInsight {
                id: insight.id,
                kind: kind_key,
                score: insight.score,
                text: insight.text,
                evidence,
                provenance: prov,
            }
        })
        .collect();

    WireBundle {
        source,
        insights,
        dropped: bundle.dropped,
        markdown: bundle.markdown,
        facts_json: bundle.facts_json,
        notes: bundle.notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use insights::types::{Direction, FactKind, Insight, RangeRef, SourceRef};
    use serde_json::Value;

    fn keys(value: &Value) -> Vec<String> {
        let mut k: Vec<String> = value
            .as_object()
            .expect("expected a JSON object")
            .keys()
            .cloned()
            .collect();
        k.sort();
        k
    }

    fn bundle_with(insights: Vec<Insight>) -> InsightBundle {
        InsightBundle {
            source: SourceRef::default(),
            insights,
            dropped: 3,
            markdown: "## Insights".to_string(),
            facts_json: "{}".to_string(),
            locale_id: "en-US".to_string(),
            engine_version: 1,
            notes: vec!["a note".to_string()],
        }
    }

    fn trend_about(subject: Subject) -> Insight {
        let mut insight = Insight::new(
            FactKind::Trend {
                subject,
                slope_per_step: 2.0,
                r2: 0.9,
                pct_change: 0.4,
                first: 10.0,
                last: 40.0,
                n: 12,
                direction: Direction::Rising,
            },
            0.7,
        );
        insight.text = "Revenue is rising.".to_string();
        insight
    }

    #[test]
    fn the_wire_bundle_serializes_with_exactly_the_field_names_the_seam_declares() {
        // THE ONLY TEST THAT CATCHES A RENAME. Asserting on the struct would
        // pass with `facts_json` on the wire; the frontend reads `factsJson`.
        let mut insight = trend_about(Subject::column(
            "Revenue",
            "Sheet1",
            RangeRef::new("Sheet1", 1, 1, 25, 1),
        ));
        insight.provenance = vec![AppliedAttr {
            attr: "direction".to_string(),
            value: "higherIsBetter".to_string(),
            source: AttrSource::Kpi("Net revenue".to_string()),
        }];
        let wire = from_core_with_sheets(
            bundle_with(vec![insight]),
            BundleSource::Range,
            &["Sheet1".to_string()],
        );

        let json: Value = serde_json::to_value(&wire).expect("serializes");
        assert_eq!(
            keys(&json),
            vec![
                "dropped".to_string(),
                "factsJson".to_string(),
                "insights".to_string(),
                "markdown".to_string(),
                "notes".to_string(),
                "source".to_string(),
            ]
        );
        assert_eq!(json["source"], Value::String("range".to_string()));

        let insight_json = &json["insights"][0];
        assert_eq!(
            keys(insight_json),
            vec![
                "evidence".to_string(),
                "id".to_string(),
                "kind".to_string(),
                "provenance".to_string(),
                "score".to_string(),
                "text".to_string(),
            ]
        );
        assert_eq!(insight_json["kind"], Value::String("trend".to_string()));

        let evidence = &insight_json["evidence"][0];
        assert_eq!(
            keys(evidence),
            vec![
                "endCol".to_string(),
                "endRow".to_string(),
                "kind".to_string(),
                "label".to_string(),
                "sheetIndex".to_string(),
                "startCol".to_string(),
                "startRow".to_string(),
            ]
        );
        assert_eq!(evidence["kind"], Value::String("range".to_string()));
        assert_eq!(evidence["sheetIndex"], Value::from(0));
        assert_eq!(evidence["startRow"], Value::from(1));
        assert_eq!(evidence["endRow"], Value::from(25));
        assert_eq!(evidence["label"], Value::String("Sheet1!B2:B26".to_string()));

        let prov = &insight_json["provenance"][0];
        assert_eq!(
            keys(prov),
            vec![
                "attribute".to_string(),
                "source".to_string(),
                "value".to_string()
            ]
        );
        assert_eq!(prov["source"], Value::String("kpi:Net revenue".to_string()));
    }

    #[test]
    fn a_measure_becomes_a_query_and_never_a_fabricated_rectangle() {
        let wire = from_core_with_sheets(
            bundle_with(vec![trend_about(Subject::measure("Net revenue"))]),
            BundleSource::Model,
            &["Sheet1".to_string()],
        );
        let json: Value = serde_json::to_value(&wire).expect("serializes");
        assert_eq!(json["source"], Value::String("model".to_string()));

        let evidence = &json["insights"][0]["evidence"][0];
        assert_eq!(evidence["kind"], Value::String("query".to_string()));
        assert_eq!(evidence["measures"][0], Value::String("Net revenue".to_string()));
        // No coordinates at all: a measure lives in no rectangle, and emitting
        // one would select cells that have nothing to do with the finding.
        assert_eq!(
            keys(evidence),
            vec!["kind".to_string(), "label".to_string(), "measures".to_string()]
        );
    }

    #[test]
    fn a_fact_with_no_subjects_gets_an_empty_evidence_list() {
        let mut shape = Insight::new(
            FactKind::Shape {
                rows: 24,
                cols: 3,
                has_header: true,
            },
            0.9,
        );
        shape.text = "24 rows by 3 columns.".to_string();
        let wire = from_core(bundle_with(vec![shape]), BundleSource::Range);
        assert!(
            wire.insights[0].evidence.is_empty(),
            "a shape fact points at no column, so it must point at nothing"
        );
        assert!(wire.insights[0].provenance.is_empty());
    }

    #[test]
    fn an_unknown_sheet_name_yields_no_index_rather_than_sheet_zero() {
        let wire = from_core_with_sheets(
            bundle_with(vec![trend_about(Subject::column(
                "Revenue",
                "Archived",
                RangeRef::new("Archived", 1, 0, 9, 0),
            ))]),
            BundleSource::Range,
            &["Sheet1".to_string(), "Sheet2".to_string()],
        );
        assert_eq!(wire.insights[0].evidence[0].sheet_index, None);
        let json: Value = serde_json::to_value(&wire).expect("serializes");
        assert!(
            json["insights"][0]["evidence"][0].get("sheetIndex").is_none(),
            "an unresolvable sheet must be ABSENT, not null and not 0"
        );
    }

    #[test]
    fn a_column_that_names_no_sheet_is_described_rather_than_located() {
        // A chart's plotted series. Its placeholder rectangle must not reach
        // the pane as a click target that would select A1 of the front sheet.
        let wire = from_core(
            bundle_with(vec![trend_about(Subject::column(
                "Revenue",
                "",
                RangeRef::new("", 0, 1, 0, 1),
            ))]),
            BundleSource::Range,
        );
        let json: Value = serde_json::to_value(&wire).expect("serializes");
        let evidence = &json["insights"][0]["evidence"][0];
        assert_eq!(evidence["kind"], Value::String("query".to_string()));
        assert_eq!(evidence["label"], Value::String("Revenue".to_string()));
        assert_eq!(
            keys(evidence),
            vec!["kind".to_string(), "label".to_string()],
            "no coordinates, and no measures either -- a chart series is not a measure"
        );
    }

    #[test]
    fn every_attr_source_spells_itself_the_way_the_seam_documents() {
        assert_eq!(attr_source_id(&AttrSource::Base), "base");
        assert_eq!(attr_source_id(&AttrSource::Inferred), "inferred");
        assert_eq!(attr_source_id(&AttrSource::Strategy), "strategy");
        assert_eq!(attr_source_id(&AttrSource::Kpi("Churn".into())), "kpi:Churn");
        assert_eq!(attr_source_id(&AttrSource::Rule("r-12".into())), "rule:r-12");
    }

    #[test]
    fn a_correlation_carries_evidence_for_both_of_its_columns() {
        let mut insight = Insight::new(
            FactKind::Correlation {
                a: Subject::column("Spend", "Sheet1", RangeRef::new("Sheet1", 1, 0, 20, 0)),
                b: Subject::column("Sales", "Sheet1", RangeRef::new("Sheet1", 1, 1, 20, 1)),
                r: 0.94,
                n: 20,
            },
            0.6,
        );
        insight.text = "Spend and Sales move together.".to_string();
        let wire = from_core_with_sheets(
            bundle_with(vec![insight]),
            BundleSource::Range,
            &["Sheet1".to_string()],
        );
        let labels: Vec<String> = wire.insights[0]
            .evidence
            .iter()
            .map(|e| e.label.clone())
            .collect();
        assert_eq!(labels, vec!["Sheet1!A2:A21", "Sheet1!B2:B21"]);
    }
}
