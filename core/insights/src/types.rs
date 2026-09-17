//! FILENAME: core/insights/src/types.rs
// PURPOSE: The vocabulary of an analysis -- what was looked at, what was found,
// and what the finding is made of.
// CONTEXT: `FactKind` is the load-bearing type in this crate. Every variant
// carries its NUMBERS and never a sentence, because the narrator is one
// consumer of a fact and a later model-driven narrator is another. Three
// exhaustive `match`es hang off it (`kind_key`, `fingerprint`, and the English
// templates in `narrate::en`), which is deliberate: adding a variant must fail
// to compile until someone has decided what it is called, how it is identified,
// and how it is said.

use engine::coord::index_to_col;
use engine::{Cell, CellValue, Grid};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Where a fact came from
// ---------------------------------------------------------------------------

/// A rectangular block of a sheet, in 0-based engine coordinates.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeRef {
    pub sheet: String,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

impl RangeRef {
    pub fn new(sheet: &str, start_row: u32, start_col: u32, end_row: u32, end_col: u32) -> Self {
        Self {
            sheet: sheet.to_string(),
            start_row: start_row.min(end_row),
            start_col: start_col.min(end_col),
            end_row: start_row.max(end_row),
            end_col: start_col.max(end_col),
        }
    }

    pub fn cell(sheet: &str, row: u32, col: u32) -> Self {
        Self::new(sheet, row, col, row, col)
    }

    pub fn rows(&self) -> u32 {
        self.end_row - self.start_row + 1
    }

    pub fn cols(&self) -> u32 {
        self.end_col - self.start_col + 1
    }

    /// `Sheet1!A1:A10`. The sheet half is quoted by the same rule the formula
    /// language uses, so an A1 string handed back to the user can be pasted
    /// into a cell without editing.
    pub fn to_a1(&self) -> String {
        let start = format!("{}{}", index_to_col(self.start_col), self.start_row + 1);
        let end = format!("{}{}", index_to_col(self.end_col), self.end_row + 1);
        let body = if start == end { start } else { format!("{}:{}", start, end) };
        if self.sheet.is_empty() {
            body
        } else {
            format!("{}!{}", quote_sheet_name(&self.sheet), body)
        }
    }
}

/// Quote a sheet name for A1 use. A name that is not a plain identifier goes in
/// single quotes with embedded quotes doubled -- the same escape the parser
/// accepts, so the round trip is not lossy.
pub fn quote_sheet_name(name: &str) -> String {
    let plain = !name.is_empty()
        && !name.chars().next().is_some_and(|c| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if plain {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

/// What the analysis was pointed at.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    /// Human label for the whole source, e.g. `Sales!A1:D25` or a model name.
    pub label: String,
    pub sheet: String,
    pub range: Option<RangeRef>,
}

// ---------------------------------------------------------------------------
// What a series is about
// ---------------------------------------------------------------------------

/// What a series is ABOUT. A grid column knows where it lives; a model measure
/// has only a name, and pinning a fake range on it would put a wrong A1 string
/// in front of the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Subject {
    Measure {
        name: String,
    },
    Column {
        name: String,
        sheet: String,
        range: RangeRef,
    },
}

impl Subject {
    pub fn measure(name: &str) -> Self {
        Subject::Measure { name: name.to_string() }
    }

    pub fn column(name: &str, sheet: &str, range: RangeRef) -> Self {
        Subject::Column {
            name: name.to_string(),
            sheet: sheet.to_string(),
            range,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Subject::Measure { name } => name,
            Subject::Column { name, .. } => name,
        }
    }

    /// Stable identity fragment used to build insight ids. A measure and a
    /// column of the same name are different subjects and must not collapse
    /// into one id, or one of the two facts is silently deduplicated away.
    pub fn key(&self) -> String {
        match self {
            Subject::Measure { name } => format!("m/{}", name),
            Subject::Column { name, sheet, range } => {
                format!("c/{}/{}/{}", sheet, name, range.to_a1())
            }
        }
    }

    pub fn evidence(&self) -> Vec<RangeRef> {
        match self {
            Subject::Measure { .. } => Vec::new(),
            Subject::Column { range, .. } => vec![range.clone()],
        }
    }
}

// ---------------------------------------------------------------------------
// Small vocabularies used inside facts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Rising,
    Falling,
    Flat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutlierMethod {
    /// Tukey fences at 1.5 x IQR.
    Iqr,
    /// Tukey fences at 3.0 x IQR ("far out").
    IqrExtreme,
    /// Distance from the mean in sample standard deviations.
    ZScore,
}

impl OutlierMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            OutlierMethod::Iqr => "interquartile",
            OutlierMethod::IqrExtreme => "far-out interquartile",
            OutlierMethod::ZScore => "3-sigma",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlierPoint {
    /// Position in the series AS SUPPLIED (0-based), counting the rows whose
    /// value was missing -- not a sheet row, and not the gap-free analysed
    /// position. See `timeseries::Series`.
    pub index: usize,
    pub label: String,
    pub value: f64,
    /// Distance from the mean in sample standard deviations. Reported for both
    /// methods so a reader can compare points found by different fences.
    pub z: f64,
}

// ---------------------------------------------------------------------------
// Provenance (filled by the model-aware layer, empty for a pure-grid bundle)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "camelCase")]
pub enum AttrSource {
    /// Present in the data itself.
    Base,
    /// Derived by this crate from the data.
    Inferred,
    /// Carried in from a named KPI definition.
    Kpi(String),
    /// Chosen by the analysis strategy rather than found in the data.
    Strategy,
    /// Applied by a named authoring rule.
    Rule(String),
}

/// One attribute the model-aware layer applied to an insight, and where it came
/// from. A pure-grid bundle leaves `Insight::provenance` empty rather than
/// inventing sources -- an empty list is honest, a fabricated `Base` is not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedAttr {
    pub attr: String,
    pub value: String,
    pub source: AttrSource,
}

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

/// One finding, as NUMBERS. No variant carries a narrated sentence: the English
/// templates, a Swedish translation and a future model-written paragraph are
/// all consumers of the same numbers, and a fact that carried its own prose
/// would make one of those the source of truth for the others.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "fact", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FactKind {
    Shape {
        rows: u32,
        cols: u32,
        has_header: bool,
    },
    ColumnSummary {
        subject: Subject,
        n: usize,
        min: f64,
        max: f64,
        mean: f64,
        median: f64,
        stdev: f64,
    },
    TextSummary {
        subject: Subject,
        distinct: usize,
        top: Vec<(String, u32)>,
    },
    BooleanShare {
        subject: Subject,
        true_share: f64,
        n: usize,
    },
    Trend {
        subject: Subject,
        slope_per_step: f64,
        r2: f64,
        pct_change: f64,
        first: f64,
        last: f64,
        n: usize,
        direction: Direction,
    },
    Change {
        subject: Subject,
        first_label: String,
        last_label: String,
        first: f64,
        last: f64,
        pct: f64,
    },
    /// Every `*_index` below is a position in the series AS SUPPLIED (gaps
    /// counted), the same convention as `OutlierPoint::index`. The label is
    /// what the sentence says; the index is what a mark is placed at, and a
    /// consumer checks that the label at the index is the label in the fact.
    Extremes {
        subject: Subject,
        best_label: String,
        best_index: usize,
        best: f64,
        worst_label: String,
        worst_index: usize,
        worst: f64,
    },
    SmoothedPeak {
        subject: Subject,
        window: usize,
        peak_label: String,
        peak_index: usize,
        peak: f64,
        trough_label: String,
        trough_index: usize,
        trough: f64,
    },
    Seasonality {
        subject: Subject,
        lag: usize,
        acf: f64,
    },
    ChangePoint {
        subject: Subject,
        at_label: String,
        /// Position in the series as supplied, gaps counted.
        at_index: usize,
        before_mean: f64,
        after_mean: f64,
        shift_sd: f64,
    },
    Outliers {
        subject: Subject,
        method: OutlierMethod,
        low_fence: f64,
        high_fence: f64,
        points: Vec<OutlierPoint>,
        total: usize,
    },
    Correlation {
        a: Subject,
        b: Subject,
        r: f64,
        n: usize,
    },
    Dominance {
        category: String,
        value: String,
        top_category: String,
        /// The supplied row holding `top_category`, when it occurs in EXACTLY
        /// one row. A category that appears in several rows was summed across
        /// them and has no single row to point at, so this is `None` rather
        /// than the first of them.
        top_index: Option<usize>,
        top_share: f64,
        categories: usize,
    },
    Pareto {
        category: String,
        value: String,
        top_k: usize,
        categories: usize,
        share: f64,
    },
    Duplicates {
        rows: usize,
        example_row: u32,
    },
    BlankRows {
        rows: usize,
    },
    Errors {
        count: usize,
        subject: Subject,
        example: String,
    },
    MixedTypes {
        subject: Subject,
        number_share: f64,
        text_share: f64,
    },
    Crossover {
        a: Subject,
        b: Subject,
        at_label: String,
        at_index: usize,
    },
    Leader {
        subject: Subject,
        share: f64,
        others: usize,
    },
}

/// Every value `FactKind::kind_key` can return. Hand-maintained, and asserted
/// against a fixture that instantiates every variant -- see
/// `narrate::en::tests::every_fact_kind_has_a_fixture`.
pub const ALL_KIND_KEYS: &[&str] = &[
    "shape",
    "columnSummary",
    "textSummary",
    "booleanShare",
    "trend",
    "change",
    "extremes",
    "smoothedPeak",
    "seasonality",
    "changePoint",
    "outliers",
    "correlation",
    "dominance",
    "pareto",
    "duplicates",
    "blankRows",
    "errors",
    "mixedTypes",
    "crossover",
    "leader",
];

impl FactKind {
    /// The kind bucket used by the per-kind cap in `rank`. Exhaustive on
    /// purpose: a new variant with no key would silently share another kind's
    /// budget.
    pub fn kind_key(&self) -> &'static str {
        match self {
            FactKind::Shape { .. } => "shape",
            FactKind::ColumnSummary { .. } => "columnSummary",
            FactKind::TextSummary { .. } => "textSummary",
            FactKind::BooleanShare { .. } => "booleanShare",
            FactKind::Trend { .. } => "trend",
            FactKind::Change { .. } => "change",
            FactKind::Extremes { .. } => "extremes",
            FactKind::SmoothedPeak { .. } => "smoothedPeak",
            FactKind::Seasonality { .. } => "seasonality",
            FactKind::ChangePoint { .. } => "changePoint",
            FactKind::Outliers { .. } => "outliers",
            FactKind::Correlation { .. } => "correlation",
            FactKind::Dominance { .. } => "dominance",
            FactKind::Pareto { .. } => "pareto",
            FactKind::Duplicates { .. } => "duplicates",
            FactKind::BlankRows { .. } => "blankRows",
            FactKind::Errors { .. } => "errors",
            FactKind::MixedTypes { .. } => "mixedTypes",
            FactKind::Crossover { .. } => "crossover",
            FactKind::Leader { .. } => "leader",
        }
    }

    /// The subjects this fact is about, plus whatever else distinguishes two
    /// facts of the same kind about the same subjects (a series can carry two
    /// change points, a pair can cross twice).
    pub fn fingerprint(&self) -> (Vec<&Subject>, String) {
        match self {
            FactKind::Shape { .. } => (Vec::new(), String::new()),
            FactKind::ColumnSummary { subject, .. } => (vec![subject], String::new()),
            FactKind::TextSummary { subject, .. } => (vec![subject], String::new()),
            FactKind::BooleanShare { subject, .. } => (vec![subject], String::new()),
            FactKind::Trend { subject, .. } => (vec![subject], String::new()),
            FactKind::Change { subject, .. } => (vec![subject], String::new()),
            FactKind::Extremes { subject, .. } => (vec![subject], String::new()),
            FactKind::SmoothedPeak { subject, window, .. } => (vec![subject], window.to_string()),
            FactKind::Seasonality { subject, lag, .. } => (vec![subject], lag.to_string()),
            FactKind::ChangePoint { subject, at_index, .. } => (vec![subject], at_index.to_string()),
            FactKind::Outliers { subject, method, .. } => {
                (vec![subject], method.as_str().to_string())
            }
            FactKind::Correlation { a, b, .. } => (vec![a, b], String::new()),
            FactKind::Dominance { category, value, .. } => {
                (Vec::new(), format!("{}|{}", category, value))
            }
            FactKind::Pareto { category, value, .. } => {
                (Vec::new(), format!("{}|{}", category, value))
            }
            FactKind::Duplicates { .. } => (Vec::new(), String::new()),
            FactKind::BlankRows { .. } => (Vec::new(), String::new()),
            FactKind::Errors { subject, .. } => (vec![subject], String::new()),
            FactKind::MixedTypes { subject, .. } => (vec![subject], String::new()),
            FactKind::Crossover { a, b, at_index, .. } => (vec![a, b], at_index.to_string()),
            FactKind::Leader { subject, .. } => (vec![subject], String::new()),
        }
    }

    /// Deterministic identity. Two runs over the same data produce the same id
    /// for the same finding, which is what lets `rank` dedupe and sort without
    /// consulting anything outside the fact.
    pub fn id(&self) -> String {
        let (subjects, extra) = self.fingerprint();
        let keys: Vec<String> = subjects.iter().map(|s| s.key()).collect();
        format!("{}:{}:{}", self.kind_key(), keys.join("+"), extra)
    }

    pub fn evidence(&self) -> Vec<RangeRef> {
        let (subjects, _) = self.fingerprint();
        subjects.iter().flat_map(|s| s.evidence()).collect()
    }
}

// ---------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub id: String,
    pub kind: FactKind,
    pub score: f64,
    pub evidence: Vec<RangeRef>,
    pub evidence_a1: Vec<String>,
    pub text: String,
    pub provenance: Vec<AppliedAttr>,
}

impl Insight {
    /// Build an un-narrated insight. `text` is filled in after ranking, so the
    /// narrator is only asked for sentences that survive the budget.
    pub fn new(kind: FactKind, score: f64) -> Self {
        let id = kind.id();
        let evidence = kind.evidence();
        let evidence_a1 = evidence.iter().map(RangeRef::to_a1).collect();
        Insight {
            id,
            kind,
            score,
            evidence,
            evidence_a1,
            text: String::new(),
            provenance: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightBundle {
    pub source: SourceRef,
    pub insights: Vec<Insight>,
    /// How many findings the budget threw away. Reported rather than hidden:
    /// "12 of 31" is a different statement from "12".
    pub dropped: usize,
    pub markdown: String,
    /// The surviving facts as pure JSON numbers, with NO narrated text, so a
    /// later model-driven narrator can write its own prose from the same
    /// evidence instead of paraphrasing ours.
    pub facts_json: String,
    pub locale_id: String,
    pub engine_version: u32,
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

/// One analysed cell, reduced to the four things the statistics care about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Datum {
    Blank,
    Number(f64),
    Text(String),
    Bool(bool),
    /// The error LITERAL as the user sees it (`#DIV/0!`), not a code.
    Error(String),
}

impl Datum {
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Datum::Number(n) if n.is_finite() => Some(*n),
            // A boolean participates in arithmetic in this product exactly as
            // it does in Excel, and a TRUE/FALSE column that never converted
            // would report "0 numeric values" on data that is plainly numeric.
            Datum::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    pub fn is_blank(&self) -> bool {
        matches!(self, Datum::Blank)
    }

    /// Canonical string used for duplicate detection and category grouping.
    pub fn key(&self) -> String {
        match self {
            Datum::Blank => String::new(),
            // `{:?}` on f64 round-trips exactly, so 1.0 and 1.0000000000000002
            // are different keys. `{}` would collapse them and under-report.
            Datum::Number(n) => format!("n:{:?}", n),
            Datum::Text(s) => format!("t:{}", s),
            Datum::Bool(b) => format!("b:{}", b),
            Datum::Error(e) => format!("e:{}", e),
        }
    }

    pub fn display(&self) -> String {
        match self {
            Datum::Blank => String::new(),
            Datum::Number(n) => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{:.0}", n)
                } else {
                    format!("{}", n)
                }
            }
            Datum::Text(s) => s.clone(),
            Datum::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Datum::Error(e) => e.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnRole {
    Numeric,
    Text,
    Boolean,
    Empty,
    Mixed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub name: String,
    pub sheet: String,
    pub range: RangeRef,
    pub cells: Vec<Datum>,
}

impl Column {
    pub fn subject(&self) -> Subject {
        Subject::column(&self.name, &self.sheet, self.range.clone())
    }

    pub fn numbers(&self) -> Vec<f64> {
        self.cells.iter().filter_map(Datum::as_number).collect()
    }

    /// Row-aligned numbers with `f64::NAN` where the row is not numeric. Used
    /// for pairwise-complete correlation, where dropping holes per column would
    /// silently pair row 4 of one column with row 7 of another.
    pub fn aligned_numbers(&self) -> Vec<f64> {
        self.cells
            .iter()
            .map(|d| d.as_number().unwrap_or(f64::NAN))
            .collect()
    }

    pub fn counts(&self) -> ColumnCounts {
        let mut c = ColumnCounts::default();
        for d in &self.cells {
            match d {
                Datum::Blank => c.blank += 1,
                Datum::Number(_) => c.number += 1,
                Datum::Text(_) => c.text += 1,
                Datum::Bool(_) => c.boolean += 1,
                Datum::Error(_) => c.error += 1,
            }
        }
        c
    }

    pub fn role(&self) -> ColumnRole {
        let c = self.counts();
        let populated = c.number + c.text + c.boolean + c.error;
        if populated == 0 {
            return ColumnRole::Empty;
        }
        if c.boolean > 0 && c.number == 0 && c.text == 0 {
            return ColumnRole::Boolean;
        }
        if c.number > 0 && c.text == 0 {
            return ColumnRole::Numeric;
        }
        if c.text > 0 && c.number == 0 && c.boolean == 0 {
            return ColumnRole::Text;
        }
        ColumnRole::Mixed
    }

    pub fn first_error(&self) -> Option<&str> {
        self.cells.iter().find_map(|d| match d {
            Datum::Error(e) => Some(e.as_str()),
            _ => None,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ColumnCounts {
    pub blank: usize,
    pub number: usize,
    pub text: usize,
    pub boolean: usize,
    pub error: usize,
}

/// Whether the first row of a grid range holds column names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderMode {
    Auto,
    Yes,
    No,
}

/// A columnar table, already lifted out of wherever it lived. Everything in
/// this crate analyses one of these; nothing in this crate opens a file, talks
/// to Tauri, or reads a clock.
#[derive(Debug, Clone, PartialEq)]
pub struct Dataset {
    pub source: SourceRef,
    pub has_header: bool,
    /// Sheet row of each data row (0-based), so hygiene facts can point at a
    /// real row rather than an offset into the analysis.
    pub row_origins: Vec<u32>,
    pub columns: Vec<Column>,
}

impl Dataset {
    pub fn row_count(&self) -> usize {
        self.columns.iter().map(|c| c.cells.len()).max().unwrap_or(0)
    }

    /// The label to attach to each row of a series. The first text column wins,
    /// which is what makes "Revenue peaks in March" possible; failing that the
    /// 1-based row position is used, which is at least honest.
    pub fn labels(&self) -> Vec<String> {
        let rows = self.row_count();
        if let Some(col) = self
            .columns
            .iter()
            .find(|c| matches!(c.role(), ColumnRole::Text))
        {
            let mut out: Vec<String> = col.cells.iter().map(Datum::display).collect();
            out.resize(rows, String::new());
            for (i, label) in out.iter_mut().enumerate() {
                if label.is_empty() {
                    *label = (i + 1).to_string();
                }
            }
            return out;
        }
        (1..=rows).map(|i| i.to_string()).collect()
    }

    /// Lift a rectangle of a grid into a dataset. Blank cells stay blank rather
    /// than becoming zeros -- a gap in a series is not a value of zero, and
    /// treating it as one is how a trend gets invented out of missing data.
    pub fn from_grid(
        grid: &Grid,
        sheet: &str,
        range: &RangeRef,
        header: HeaderMode,
    ) -> Dataset {
        let read = |row: u32, col: u32| -> Datum {
            match grid.get_cell(row, col) {
                Some(cell) => datum_from_cell(cell),
                None => Datum::Blank,
            }
        };

        let has_header = match header {
            HeaderMode::Yes => true,
            HeaderMode::No => false,
            HeaderMode::Auto => detect_header(grid, range),
        };

        let first_data_row = if has_header {
            range.start_row.saturating_add(1)
        } else {
            range.start_row
        };

        let mut columns = Vec::new();
        for col in range.start_col..=range.end_col {
            let name = if has_header {
                let raw = read(range.start_row, col).display();
                if raw.trim().is_empty() {
                    index_to_col(col)
                } else {
                    raw
                }
            } else {
                index_to_col(col)
            };
            let mut cells = Vec::new();
            if first_data_row <= range.end_row {
                for row in first_data_row..=range.end_row {
                    cells.push(read(row, col));
                }
            }
            columns.push(Column {
                name,
                sheet: sheet.to_string(),
                range: RangeRef::new(sheet, first_data_row, col, range.end_row.max(first_data_row), col),
                cells,
            });
        }

        let row_origins: Vec<u32> = if first_data_row <= range.end_row {
            (first_data_row..=range.end_row).collect()
        } else {
            Vec::new()
        };

        Dataset {
            source: SourceRef {
                label: range.to_a1(),
                sheet: sheet.to_string(),
                range: Some(range.clone()),
            },
            has_header,
            row_origins,
            columns,
        }
    }
}

pub fn datum_from_cell(cell: &Cell) -> Datum {
    match &cell.value {
        CellValue::Empty => Datum::Blank,
        CellValue::Number(n) => Datum::Number(*n),
        CellValue::Text(s) => {
            if s.is_empty() {
                Datum::Blank
            } else {
                Datum::Text(s.clone())
            }
        }
        CellValue::Boolean(b) => Datum::Bool(*b),
        CellValue::Error(e) => Datum::Error(e.as_literal().to_string()),
        // A list or dict in a cell is not a scalar this analysis can reason
        // about; its display form is kept so it still counts as populated.
        other => Datum::Text(
            Cell {
                value: other.clone(),
                ..Cell::new()
            }
            .display_value(),
        ),
    }
}

/// A first row is a header when it is all text and the row under it is not.
/// Text under text proves nothing (a label column looks identical), which is
/// why the rule needs a second row that differs in TYPE.
fn detect_header(grid: &Grid, range: &RangeRef) -> bool {
    if range.end_row <= range.start_row {
        return false;
    }
    let mut header_texts = 0usize;
    let mut body_non_text = 0usize;
    for col in range.start_col..=range.end_col {
        let head = grid
            .get_cell(range.start_row, col)
            .map(datum_from_cell)
            .unwrap_or(Datum::Blank);
        let body = grid
            .get_cell(range.start_row + 1, col)
            .map(datum_from_cell)
            .unwrap_or(Datum::Blank);
        match head {
            Datum::Text(_) => header_texts += 1,
            Datum::Blank => {}
            _ => return false,
        }
        if !matches!(body, Datum::Text(_) | Datum::Blank) {
            body_non_text += 1;
        }
    }
    header_texts > 0 && body_non_text > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::Cell;

    fn text(s: &str) -> Cell {
        let mut c = Cell::new();
        c.value = CellValue::Text(s.to_string());
        c
    }

    fn number(n: f64) -> Cell {
        let mut c = Cell::new();
        c.value = CellValue::Number(n);
        c
    }

    #[test]
    fn an_a1_string_quotes_a_sheet_name_that_needs_it() {
        let plain = RangeRef::new("Sales", 0, 0, 9, 0);
        assert_eq!(plain.to_a1(), "Sales!A1:A10");
        let spaced = RangeRef::new("Q1 Sales", 0, 0, 9, 0);
        assert_eq!(spaced.to_a1(), "'Q1 Sales'!A1:A10");
        let apostrophe = RangeRef::new("Dan's", 1, 2, 1, 2);
        assert_eq!(apostrophe.to_a1(), "'Dan''s'!C2");
    }

    #[test]
    fn a_measure_and_a_column_of_the_same_name_are_different_subjects() {
        let m = Subject::measure("Revenue");
        let c = Subject::column("Revenue", "Sheet1", RangeRef::new("Sheet1", 1, 0, 9, 0));
        assert_ne!(m.key(), c.key());
        assert_eq!(m.label(), c.label());
    }

    #[test]
    fn a_header_row_is_detected_only_when_the_row_below_it_is_not_text() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, text("Month"));
        grid.set_cell(0, 1, text("Revenue"));
        grid.set_cell(1, 0, text("Jan"));
        grid.set_cell(1, 1, number(100.0));
        let range = RangeRef::new("S", 0, 0, 1, 1);
        assert!(detect_header(&grid, &range));

        let mut all_text = Grid::new();
        all_text.set_cell(0, 0, text("Month"));
        all_text.set_cell(1, 0, text("Jan"));
        assert!(!detect_header(&all_text, &RangeRef::new("S", 0, 0, 1, 0)));
    }

    #[test]
    fn a_blank_cell_never_becomes_a_zero() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, text("V"));
        grid.set_cell(1, 0, number(10.0));
        grid.set_cell(3, 0, number(30.0));
        let ds = Dataset::from_grid(&grid, "S", &RangeRef::new("S", 0, 0, 3, 0), HeaderMode::Auto);
        assert!(ds.has_header);
        assert_eq!(ds.columns[0].name, "V");
        assert_eq!(ds.columns[0].cells.len(), 3);
        assert_eq!(ds.columns[0].cells[1], Datum::Blank);
        assert_eq!(ds.columns[0].numbers(), vec![10.0, 30.0]);
        let aligned = ds.columns[0].aligned_numbers();
        assert!(aligned[1].is_nan(), "a hole must stay a hole, not become 0.0");
    }

    #[test]
    fn a_fact_id_is_stable_and_distinguishes_two_change_points_on_one_series() {
        let subject = Subject::measure("Revenue");
        let a = FactKind::ChangePoint {
            subject: subject.clone(),
            at_label: "Mar".into(),
            at_index: 3,
            before_mean: 1.0,
            after_mean: 2.0,
            shift_sd: 4.0,
        };
        let b = FactKind::ChangePoint {
            subject,
            at_label: "Sep".into(),
            at_index: 9,
            before_mean: 1.0,
            after_mean: 2.0,
            shift_sd: 4.0,
        };
        assert_eq!(a.id(), a.clone().id());
        assert_ne!(a.id(), b.id());
        assert_eq!(a.kind_key(), "changePoint");
    }

    #[test]
    fn evidence_follows_the_subjects_a_fact_names() {
        let range = RangeRef::new("Sheet1", 1, 0, 9, 0);
        let fact = FactKind::Trend {
            subject: Subject::column("Revenue", "Sheet1", range.clone()),
            slope_per_step: 1.0,
            r2: 1.0,
            pct_change: 0.5,
            first: 1.0,
            last: 10.0,
            n: 10,
            direction: Direction::Rising,
        };
        assert_eq!(fact.evidence(), vec![range]);
        // A measure has no cells, so it must contribute no A1 evidence rather
        // than a plausible-looking wrong range.
        let measure_fact = FactKind::Trend {
            subject: Subject::measure("Revenue"),
            slope_per_step: 1.0,
            r2: 1.0,
            pct_change: 0.5,
            first: 1.0,
            last: 10.0,
            n: 10,
            direction: Direction::Rising,
        };
        assert!(measure_fact.evidence().is_empty());
    }

    #[test]
    fn a_boolean_column_counts_as_numeric_for_arithmetic() {
        let col = Column {
            name: "Paid".into(),
            sheet: "S".into(),
            range: RangeRef::new("S", 0, 0, 2, 0),
            cells: vec![Datum::Bool(true), Datum::Bool(false), Datum::Bool(true)],
        };
        assert_eq!(col.role(), ColumnRole::Boolean);
        assert_eq!(col.numbers(), vec![1.0, 0.0, 1.0]);
    }
}
