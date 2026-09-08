//! FILENAME: core/insights/src/lib.rs
// PURPOSE: "Analyze this data" as a pure function: a table in, a ranked and
// narrated bundle of findings out.
// CONTEXT: Nothing in this crate touches Tauri, the filesystem, the network or
// a clock. That is what makes the output testable and reproducible -- the same
// table produces byte-identical text on every machine, which is the only basis
// on which a narrated summary can be cached, diffed, or shipped inside a signed
// `.calp` report.
//
// The pipeline is: extract facts -> score -> dedupe -> cap -> narrate. Facts are
// numbers and carry no prose; the narrator runs LAST and only over the findings
// that survived the budget, so `facts_json` and the sentences can never disagree
// about what was found.

pub mod hygiene;
pub mod narrate;
pub mod outliers;
pub mod rank;
pub mod relations;
pub mod stats;
pub mod thresholds;
pub mod timeseries;
pub mod types;

use serde::Serialize;

use engine::Grid;

use crate::narrate::Locale;
use crate::relations::AlignedColumn;
use crate::thresholds::*;
use crate::timeseries::Series;
use crate::types::{
    ColumnRole, Dataset, FactKind, HeaderMode, Insight, InsightBundle, RangeRef, SourceRef, Subject,
};

pub use crate::narrate::narrator_for;
pub use crate::types::{
    AppliedAttr, AttrSource, Column, Datum, Direction, OutlierMethod, OutlierPoint,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalyzeOptions {
    pub locale: Locale,
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        AnalyzeOptions { locale: Locale::En }
    }
}

impl AnalyzeOptions {
    pub fn for_locale_id(id: &str) -> Self {
        AnalyzeOptions {
            locale: Locale::from_locale_id(id),
        }
    }
}

/// Analyse a rectangle of a grid.
pub fn analyze_grid(
    grid: &Grid,
    sheet: &str,
    range: &RangeRef,
    header: HeaderMode,
    options: &AnalyzeOptions,
) -> InsightBundle {
    let dataset = Dataset::from_grid(grid, sheet, range, header);
    analyze(&dataset, options)
}

/// Analyse an already-extracted table.
pub fn analyze(dataset: &Dataset, options: &AnalyzeOptions) -> InsightBundle {
    let narrator = narrate::narrator_for(options.locale);
    let mut notes: Vec<String> = Vec::new();
    let facts = collect_facts(dataset, &mut notes);

    let insights: Vec<Insight> = facts
        .into_iter()
        .map(|kind| {
            let score = rank::score(&kind);
            Insight::new(kind, score)
        })
        .collect();

    let ranked = rank::rank(insights);
    let mut kept = ranked.kept;
    for insight in kept.iter_mut() {
        insight.text = narrator.narrate(&insight.kind);
    }

    let facts_json = build_facts_json(dataset, &kept, options.locale);
    let markdown = build_markdown(dataset, &kept, ranked.dropped);

    InsightBundle {
        source: dataset.source.clone(),
        insights: kept,
        dropped: ranked.dropped,
        markdown,
        facts_json,
        locale_id: options.locale.locale_id().to_string(),
        engine_version: INSIGHTS_ENGINE_VERSION,
        notes,
    }
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

fn collect_facts(dataset: &Dataset, notes: &mut Vec<String>) -> Vec<FactKind> {
    let mut facts: Vec<FactKind> = Vec::new();
    let rows = dataset.row_count();
    let cols = dataset.columns.len();
    if rows == 0 || cols == 0 {
        notes.push("The range holds no data rows.".to_string());
        return facts;
    }

    facts.push(FactKind::Shape {
        rows: rows as u32,
        cols: cols as u32,
        has_header: dataset.has_header,
    });

    let labels = dataset.labels();
    let mut aligned: Vec<AlignedColumn> = Vec::new();
    let mut totals: Vec<(Subject, f64)> = Vec::new();

    for column in &dataset.columns {
        // Data quality first, and for EVERY column regardless of its role: a
        // column too messy to analyse is exactly the one whose errors matter.
        if let Some(fact) = hygiene::error_fact(column) {
            facts.push(fact);
        }
        if let Some(fact) = hygiene::mixed_types_fact(column) {
            facts.push(fact);
        }

        match column.role() {
            ColumnRole::Empty => {
                notes.push(format!("{} holds no values.", column.name));
            }
            ColumnRole::Text => {
                facts.push(text_summary(column));
            }
            ColumnRole::Boolean => {
                let numbers = column.numbers();
                if !numbers.is_empty() {
                    facts.push(FactKind::BooleanShare {
                        subject: column.subject(),
                        true_share: stats::sum(&numbers) / numbers.len() as f64,
                        n: numbers.len(),
                    });
                }
                // A 0/1 column has a slope and an autocorrelation, and both are
                // meaningless. It stays out of the series analysis entirely.
            }
            ColumnRole::Numeric | ColumnRole::Mixed => {
                let numbers = column.numbers();
                if numbers.is_empty() {
                    notes.push(format!("{} holds no numeric values.", column.name));
                    continue;
                }
                facts.extend(numeric_column_facts(column, &labels, &numbers));
                aligned.push(AlignedColumn {
                    subject: column.subject(),
                    values: column.aligned_numbers(),
                });
                totals.push((column.subject(), stats::sum(&numbers)));
            }
        }
    }

    facts.extend(relations::correlation_facts(&aligned));
    facts.extend(crossovers(&aligned, &labels));
    if let Some(fact) = relations::leader_fact(&totals) {
        facts.push(fact);
    }
    facts.extend(composition_facts(dataset));

    if let Some(fact) = hygiene::duplicate_fact(dataset) {
        facts.push(fact);
    }
    if let Some(fact) = hygiene::blank_rows_fact(dataset) {
        facts.push(fact);
    }

    facts
}

fn text_summary(column: &types::Column) -> FactKind {
    let values: Vec<String> = column
        .cells
        .iter()
        .filter(|d| !d.is_blank())
        .map(|d| d.display())
        .collect();
    // Counted through the same sorted-totals helper the composition facts use,
    // so the "top" list can never depend on hash order.
    let counted: Vec<(String, f64)> = values.iter().map(|v| (v.clone(), 1.0)).collect();
    let totals = relations::category_totals(&counted);
    let top: Vec<(String, u32)> = totals
        .iter()
        .take(TEXT_SUMMARY_TOP_VALUES)
        .map(|(name, n)| (name.clone(), *n as u32))
        .collect();
    FactKind::TextSummary {
        subject: column.subject(),
        distinct: totals.len(),
        top,
    }
}

fn numeric_column_facts(
    column: &types::Column,
    labels: &[String],
    numbers: &[f64],
) -> Vec<FactKind> {
    let mut facts = Vec::new();
    let subject = column.subject();

    if let Some((min, max)) = stats::min_max(numbers) {
        facts.push(FactKind::ColumnSummary {
            subject: subject.clone(),
            n: numbers.len(),
            min,
            max,
            mean: stats::mean(numbers).unwrap_or(0.0),
            median: stats::median(numbers).unwrap_or(0.0),
            // A single value has no sample standard deviation; zero is the
            // honest rendering of "no spread measured on one point".
            stdev: stats::stdev_sample(numbers).unwrap_or(0.0),
        });
    }

    let series = Series::new(subject, labels, &column.aligned_numbers());

    let trend = timeseries::trend_fact(&series);
    // A line and a step are competing explanations of the same picture, and the
    // fit decides which one is printed. Binary segmentation splits a pure ramp
    // happily -- the two halves of a straight line do have well-separated means
    // -- so a near-perfect fit suppresses the split. The bar is NOT "a trend was
    // found": a clean 15-then-15 step fits a line at R-squared of about 0.75,
    // and suppressing on that would describe a jump as a gentle slope and lose
    // where it happened.
    let line_explains_it = matches!(
        &trend,
        Some(FactKind::Trend { r2, .. }) if *r2 >= CHANGEPOINT_SUPPRESSED_ABOVE_R2
    );
    facts.extend(trend);
    facts.extend(timeseries::change_fact(&series));
    facts.extend(timeseries::extremes_fact(&series));
    facts.extend(timeseries::smoothed_peak_fact(&series));
    facts.extend(timeseries::seasonality_fact(&series));

    if !line_explains_it {
        facts.extend(timeseries::change_point_facts(&series));
    }

    facts.extend(outliers::outlier_fact(&series));
    facts
}

fn crossovers(aligned: &[AlignedColumn], labels: &[String]) -> Vec<FactKind> {
    let limit = aligned.len().min(CROSSOVER_MAX_COLUMNS);
    let mut out = Vec::new();
    for i in 0..limit {
        for j in (i + 1)..limit {
            out.extend(timeseries::crossover_facts(
                &aligned[i].subject,
                &aligned[j].subject,
                labels,
                &aligned[i].values,
                &aligned[j].values,
            ));
            if out.len() >= CROSSOVER_MAX_REPORTED {
                out.truncate(CROSSOVER_MAX_REPORTED);
                return out;
            }
        }
    }
    out
}

/// Dominance and Pareto need a category column and a value column. The FIRST
/// text column and the FIRST numeric column are used, which is the pairing a
/// reader assumes when they look at a two-column breakdown.
fn composition_facts(dataset: &Dataset) -> Vec<FactKind> {
    let Some(category) = dataset
        .columns
        .iter()
        .find(|c| matches!(c.role(), ColumnRole::Text))
    else {
        return Vec::new();
    };
    let Some(value) = dataset
        .columns
        .iter()
        .find(|c| matches!(c.role(), ColumnRole::Numeric))
    else {
        return Vec::new();
    };

    let rows: Vec<(String, f64)> = (0..dataset.row_count())
        .filter_map(|r| {
            let name = category.cells.get(r)?.display();
            if name.is_empty() {
                return None;
            }
            let v = value.cells.get(r)?.as_number()?;
            Some((name, v))
        })
        .collect();
    if rows.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    out.extend(relations::dominance_fact(&category.name, &value.name, &rows));
    out.extend(relations::pareto_fact(&category.name, &value.name, &rows));
    out
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FactRecord<'a> {
    id: &'a str,
    score: f64,
    evidence_a1: &'a [String],
    kind: &'a FactKind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FactsDocument<'a> {
    engine_version: u32,
    locale_id: &'a str,
    source: &'a SourceRef,
    facts: Vec<FactRecord<'a>>,
}

/// The surviving facts as numbers. `Insight::text` is deliberately NOT included:
/// a later model-driven narrator must write from the evidence rather than
/// paraphrase our sentences, and the surest way to guarantee that is to make
/// our sentences unavailable to it.
fn build_facts_json(dataset: &Dataset, insights: &[Insight], locale: Locale) -> String {
    let document = FactsDocument {
        engine_version: INSIGHTS_ENGINE_VERSION,
        locale_id: locale.locale_id(),
        source: &dataset.source,
        facts: insights
            .iter()
            .map(|i| FactRecord {
                id: &i.id,
                score: i.score,
                evidence_a1: &i.evidence_a1,
                kind: &i.kind,
            })
            .collect(),
    };
    // A serialisation failure here is not recoverable and must not be silent:
    // an empty string would look like "nothing was found".
    serde_json::to_string_pretty(&document)
        .unwrap_or_else(|e| format!("{{\"error\":\"facts could not be serialised: {}\"}}", e))
}

fn build_markdown(dataset: &Dataset, insights: &[Insight], dropped: usize) -> String {
    let mut out = String::new();
    let label = if dataset.source.label.is_empty() {
        "the selected data".to_string()
    } else {
        dataset.source.label.clone()
    };
    out.push_str(&format!("## Insights for {}\n\n", label));
    if insights.is_empty() {
        out.push_str("Nothing stood out in this data.\n");
        return out;
    }
    for insight in insights {
        out.push_str("- ");
        out.push_str(&insight.text);
        if !insight.evidence_a1.is_empty() {
            out.push_str(&format!(" ({})", insight.evidence_a1.join(", ")));
        }
        out.push('\n');
    }
    if dropped > 0 {
        out.push_str(&format!(
            "\n_{} further {} not shown._\n",
            dropped,
            if dropped == 1 { "finding was" } else { "findings were" }
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Column, Datum};

    fn column(name: &str, index: u32, cells: Vec<Datum>) -> Column {
        let rows = cells.len().max(1) as u32;
        Column {
            name: name.to_string(),
            sheet: "Sheet1".to_string(),
            range: RangeRef::new("Sheet1", 1, index, rows, index),
            cells,
        }
    }

    fn numbers(values: &[f64]) -> Vec<Datum> {
        values.iter().map(|v| Datum::Number(*v)).collect()
    }

    fn dataset(columns: Vec<Column>) -> Dataset {
        let rows = columns.iter().map(|c| c.cells.len()).max().unwrap_or(0);
        Dataset {
            source: SourceRef {
                label: "Sheet1!A1:D30".to_string(),
                sheet: "Sheet1".to_string(),
                range: Some(RangeRef::new("Sheet1", 0, 0, rows as u32, 3)),
            },
            has_header: true,
            row_origins: (1..=rows as u32).collect(),
            columns,
        }
    }

    fn kinds(bundle: &InsightBundle) -> Vec<&str> {
        bundle.insights.iter().map(|i| i.kind.kind_key()).collect()
    }

    fn facts_about<'a>(bundle: &'a InsightBundle, subject: &str) -> Vec<&'a FactKind> {
        bundle
            .insights
            .iter()
            .map(|i| &i.kind)
            .filter(|k| {
                let (subjects, _) = k.fingerprint();
                subjects.iter().any(|s| s.label() == subject)
            })
            .collect()
    }

    #[test]
    fn a_constant_column_gets_no_trend_outlier_or_correlation_and_a_rising_one_does() {
        let flat: Vec<f64> = vec![50.0; 24];
        let rising: Vec<f64> = (0..24).map(|i| 10.0 + 4.0 * i as f64).collect();
        let bundle = analyze(
            &dataset(vec![
                column("Flat", 0, numbers(&flat)),
                column("Rising", 1, numbers(&rising)),
            ]),
            &AnalyzeOptions::default(),
        );

        for fact in facts_about(&bundle, "Flat") {
            let key = fact.kind_key();
            assert!(
                key != "trend" && key != "outliers" && key != "correlation",
                "a constant column must not produce {key}: {fact:?}"
            );
        }

        // Positive control in the same bundle: without this the test would pass
        // on a build where the whole analysis silently produced nothing.
        let rising_kinds: Vec<&str> = facts_about(&bundle, "Rising")
            .iter()
            .map(|f| f.kind_key())
            .collect();
        assert!(
            rising_kinds.contains(&"trend"),
            "positive control failed, got {rising_kinds:?}"
        );
    }

    #[test]
    fn two_correlated_columns_are_reported_once_and_the_text_says_association() {
        let a: Vec<f64> = (0..20).map(|i| 100.0 + 3.0 * i as f64).collect();
        let b: Vec<f64> = (0..20).map(|i| 40.0 + 1.5 * i as f64).collect();
        let bundle = analyze(
            &dataset(vec![
                column("Spend", 0, numbers(&a)),
                column("Sales", 1, numbers(&b)),
            ]),
            &AnalyzeOptions::default(),
        );

        let correlations: Vec<&Insight> = bundle
            .insights
            .iter()
            .filter(|i| i.kind.kind_key() == "correlation")
            .collect();
        assert_eq!(correlations.len(), 1, "an unordered pair must appear once");
        assert!(
            correlations[0].text.contains("association"),
            "{}",
            correlations[0].text
        );
        assert!(
            !correlations[0].text.to_lowercase().contains("cause"),
            "{}",
            correlations[0].text
        );
    }

    #[test]
    fn analyze_does_not_report_a_level_shift_for_a_plain_ramp() {
        // The companion to `a_ramp_also_splits_which_is_why_the_pipeline_prefers_its_trend`
        // in `timeseries`: segmentation DOES find a split in a ramp, and the
        // suppression here is what keeps it out of the bundle.
        let ramp: Vec<f64> = (0..30).map(|i| 100.0 + 2.0 * i as f64).collect();
        let bundle = analyze(
            &dataset(vec![column("Ramp", 0, numbers(&ramp))]),
            &AnalyzeOptions::default(),
        );
        assert!(kinds(&bundle).contains(&"trend"));
        assert!(
            !kinds(&bundle).contains(&"changePoint"),
            "a straight line must not also be described as a step: {:?}",
            kinds(&bundle)
        );
    }

    #[test]
    fn a_stepped_column_reports_its_level_shift() {
        let mut stepped: Vec<f64> = Vec::new();
        for i in 0..15 {
            stepped.push(100.0 + (i % 3) as f64);
        }
        for i in 0..15 {
            stepped.push(140.0 + (i % 3) as f64);
        }
        let bundle = analyze(
            &dataset(vec![column("Stepped", 0, numbers(&stepped))]),
            &AnalyzeOptions::default(),
        );
        let change_points: Vec<&FactKind> = bundle
            .insights
            .iter()
            .map(|i| &i.kind)
            .filter(|k| k.kind_key() == "changePoint")
            .collect();
        assert_eq!(change_points.len(), 1, "{:?}", kinds(&bundle));
        match change_points[0] {
            FactKind::ChangePoint { at_index, .. } => {
                assert!(at_index.abs_diff(15) <= 1, "located at {at_index}");
            }
            other => panic!("expected a change point, got {other:?}"),
        }
    }

    #[test]
    fn the_bundle_is_capped_and_kind_diverse() {
        let mut columns = Vec::new();
        for k in 0..6u32 {
            let values: Vec<f64> = (0..24)
                .map(|i| 10.0 * (k as f64 + 1.0) + (i as f64) * (k as f64 + 1.0))
                .collect();
            columns.push(column(&format!("M{k}"), k, numbers(&values)));
        }
        let bundle = analyze(&dataset(columns), &AnalyzeOptions::default());

        assert_eq!(bundle.insights.len(), MAX_INSIGHTS);
        assert!(bundle.dropped > 0, "nothing was dropped, so nothing was capped");

        let mut per_kind: std::collections::BTreeMap<&str, usize> =
            std::collections::BTreeMap::new();
        for key in kinds(&bundle) {
            *per_kind.entry(key).or_insert(0) += 1;
        }
        for (key, n) in &per_kind {
            assert!(*n <= MAX_PER_KIND, "{key} took {n} slots");
        }
        assert!(
            per_kind.len() >= 4,
            "the output must stay diverse, saw {per_kind:?}"
        );
    }

    #[test]
    fn two_runs_over_the_same_data_are_byte_identical() {
        let a: Vec<f64> = (0..30)
            .map(|i| 100.0 + 5.0 * i as f64 + [0.0, 3.0, -3.0][i % 3])
            .collect();
        let b: Vec<f64> = (0..30).map(|i| 500.0 - 4.0 * i as f64).collect();
        let labels: Vec<Datum> = (0..30)
            .map(|i| Datum::Text(format!("W{:02}", i + 1)))
            .collect();
        let ds = dataset(vec![
            column("Week", 0, labels),
            column("Revenue", 1, numbers(&a)),
            column("Cost", 2, numbers(&b)),
        ]);

        let first = analyze(&ds, &AnalyzeOptions::default());
        for _ in 0..5 {
            let again = analyze(&ds, &AnalyzeOptions::default());
            assert_eq!(first.markdown, again.markdown);
            assert_eq!(first.facts_json, again.facts_json);
            assert_eq!(first.dropped, again.dropped);
            assert_eq!(
                first.insights.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
                again.insights.iter().map(|i| i.id.clone()).collect::<Vec<_>>()
            );
        }
        assert!(!first.markdown.is_empty());
    }

    #[test]
    fn a_swedish_bundle_renders_a_comma_decimal() {
        let values: Vec<f64> = (0..20).map(|i| 100.0 + 2.5 * i as f64).collect();
        let ds = dataset(vec![column("Intakt", 0, numbers(&values))]);
        let sv = analyze(&ds, &AnalyzeOptions::for_locale_id("sv-SE"));
        let en = analyze(&ds, &AnalyzeOptions::default());

        assert_eq!(sv.locale_id, "sv-SE");
        assert!(
            sv.markdown.contains(','),
            "no decimal comma anywhere in:\n{}",
            sv.markdown
        );
        // The same bundle in en-US must differ ONLY in its numbers, which is
        // what proves the comma came from the formatter and not from a template
        // that happens to contain a comma.
        assert_ne!(sv.markdown, en.markdown);
        assert_eq!(
            sv.insights.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
            en.insights.iter().map(|i| i.id.clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn facts_json_carries_the_numbers_and_none_of_the_narration() {
        let values: Vec<f64> = (0..20).map(|i| 100.0 + 2.5 * i as f64).collect();
        let bundle = analyze(
            &dataset(vec![column("Revenue", 0, numbers(&values))]),
            &AnalyzeOptions::default(),
        );
        assert!(bundle.facts_json.contains("\"slopePerStep\""));
        assert!(bundle.facts_json.contains("\"engineVersion\""));
        for insight in &bundle.insights {
            assert!(!insight.text.is_empty());
            assert!(
                !bundle.facts_json.contains(&insight.text),
                "narrated text leaked into facts_json: {}",
                insight.text
            );
        }
        // Every number must have survived serialisation as a NUMBER. A clamp
        // that let an infinity through would show up here as `null`.
        assert!(
            !bundle.facts_json.contains("null"),
            "a non-finite number reached facts_json:\n{}",
            bundle.facts_json
        );
    }

    #[test]
    fn an_error_column_outranks_the_statistics_drawn_from_it() {
        let mut cells = numbers(&(0..20).map(|i| 10.0 + 3.0 * i as f64).collect::<Vec<f64>>());
        cells[4] = Datum::Error("#DIV/0!".to_string());
        cells[9] = Datum::Error("#DIV/0!".to_string());
        let bundle = analyze(
            &dataset(vec![column("Margin", 0, cells)]),
            &AnalyzeOptions::default(),
        );
        assert_eq!(
            bundle.insights[0].kind.kind_key(),
            "shape",
            "orientation leads"
        );
        assert_eq!(
            bundle.insights[1].kind.kind_key(),
            "errors",
            "a broken cell must be said before anything computed from it: {:?}",
            kinds(&bundle)
        );
    }

    #[test]
    fn an_empty_range_produces_a_bundle_that_says_so_rather_than_failing() {
        let ds = Dataset {
            source: SourceRef::default(),
            has_header: false,
            row_origins: Vec::new(),
            columns: Vec::new(),
        };
        let bundle = analyze(&ds, &AnalyzeOptions::default());
        assert!(bundle.insights.is_empty());
        assert_eq!(bundle.dropped, 0);
        assert!(bundle.markdown.contains("Nothing stood out"));
        assert_eq!(bundle.notes.len(), 1);
    }

    #[test]
    fn analyzing_a_grid_finds_the_header_and_points_the_evidence_at_real_cells() {
        use engine::{Cell, CellValue};

        let mut grid = Grid::new();
        let mut header = Cell::new();
        header.value = CellValue::Text("Revenue".to_string());
        grid.set_cell(0, 0, header);
        for i in 0..20u32 {
            let mut c = Cell::new();
            c.value = CellValue::Number(100.0 + 4.0 * i as f64);
            grid.set_cell(i + 1, 0, c);
        }

        let bundle = analyze_grid(
            &grid,
            "Sheet1",
            &RangeRef::new("Sheet1", 0, 0, 20, 0),
            HeaderMode::Auto,
            &AnalyzeOptions::default(),
        );

        assert!(kinds(&bundle).contains(&"trend"));
        let trend = bundle
            .insights
            .iter()
            .find(|i| i.kind.kind_key() == "trend")
            .unwrap();
        assert_eq!(trend.evidence_a1, vec!["Sheet1!A2:A21".to_string()]);
        assert!(bundle.markdown.contains("Sheet1!A2:A21"));
    }

    #[test]
    fn a_category_breakdown_reports_its_dominant_member() {
        let mut names = Vec::new();
        let mut values = Vec::new();
        for (name, value) in [
            ("North", 700.0),
            ("South", 120.0),
            ("East", 100.0),
            ("West", 80.0),
        ] {
            names.push(Datum::Text(name.to_string()));
            values.push(Datum::Number(value));
        }
        let bundle = analyze(
            &dataset(vec![
                column("Region", 0, names),
                column("Revenue", 1, values),
            ]),
            &AnalyzeOptions::default(),
        );
        let dominance = bundle
            .insights
            .iter()
            .find(|i| i.kind.kind_key() == "dominance")
            .expect("70% of the total is dominance");
        assert!(dominance.text.contains("North"), "{}", dominance.text);
    }
}
